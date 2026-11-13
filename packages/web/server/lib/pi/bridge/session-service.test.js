import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFileIndex } from '../session-files.js';
import { createSessionMetaStore } from '../session-meta-store.js';
import { createSessionRecords } from './session-records.js';
import { createSessionService, WIRE_VERSION } from './session-service.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const toWireUsage = (usage) => ({ tokens: { input: usage.input, output: usage.output, reasoning: usage.reasoning, cache: { read: usage.cacheRead, write: usage.cacheWrite } }, cost: usage.cost });

const setup = () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-service-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(project, { recursive: true });
  const fileIndex = createSessionFileIndex({ sessionsDir, ttlMs: 0 });
  const metaStore = createSessionMetaStore({ filePath: path.join(root, 'meta.json') });
  const records = createSessionRecords({ fileIndex, metaStore, toWireUsage });
  const events = [];
  const closed = [];
  let clock = 10_000;
  const service = createSessionService({
    records,
    metaStore,
    fileIndex,
    host: { close: async (id) => { closed.push(id); } },
    hub: { emit: (event) => { events.push(event); return event; } },
    getDefaultDirectory: () => project,
    now: () => (clock += 10),
    random: () => 0,
  });
  const writeSessionFile = (id, cwd = project) => {
    const dir = path.join(sessionsDir, '--x--');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-11-01T10-00-00-000Z_${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-01T10:00:00.000Z', cwd })}\n${JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'user', content: 'hello' } })}\n`);
    fileIndex.invalidate();
    return file;
  };
  return { root, project, service, events, closed, metaStore, writeSessionFile, fileIndex };
};

const types = (events) => events.map((event) => event.type);

describe('session service', () => {
  describe('create', () => {
    it('creates a draft session, keeps the client id and announces it with its location', async () => {
      const { service, events, project } = setup();
      const record = await service.create({ id: 'ses_client1', title: 'Probe', agent: 'build', model: { providerID: 'mock', id: 'm1' }, metadata: { a: 1 } });

      expect(record).toMatchObject({ id: 'ses_client1', title: 'Probe', agent: 'build', metadata: { a: 1 }, location: { directory: project }, model: { id: 'm1', providerID: 'mock', variant: 'default' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'session.created',
        location: { directory: project },
        data: { sessionID: 'ses_client1', version: WIRE_VERSION, title: 'Probe', agent: 'build', model: { id: 'm1', providerID: 'mock' }, subpath: '', slug: 'neon-cabin' },
      });
    });

    it('mints a session id when none is given and uses the request directory', async () => {
      const { service, root } = setup();
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      const record = await service.create({}, other);
      expect(record.id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(record.location.directory).toBe(other);
    });

    it('answers a repeated id with the original record and no second event', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_dup', title: 'First' });
      const again = await service.create({ id: 'ses_dup', title: 'Second' });
      expect(again.title).toBe('First');
      expect(types(events)).toEqual(['session.created']);
    });

    it('rejects an id that does not start with ses and a malformed model', async () => {
      const { service } = setup();
      await expect(service.create({ id: 'abc_1' })).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError', message: 'Expected a string starting with "ses"\n  at ["id"]' });
      await expect(service.create({ model: { providerID: 'x' } })).rejects.toMatchObject({ status: 400 });
    });

    it('accepts a folder that does not exist, as OpenCode does', async () => {
      const { service, project } = setup();
      const missing = path.join(project, 'missing');
      const record = await service.create({ location: { directory: missing } });
      expect(record.location.directory).toBe(missing);
    });
  });

  describe('update', () => {
    it('renames, replaces metadata and archives, announcing each once', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_a' });
      events.length = 0;

      await service.update('ses_a', { title: '  New name  ', metadata: { k: [1, null] }, archived: true });
      expect(events.map((event) => [event.type, event.location !== undefined])).toEqual([
        ['session.renamed', false],
        ['session.metadata.updated', false],
        ['session.archived', false],
      ]);
      const record = await service.get('ses_a');
      expect(record).toMatchObject({ title: 'New name', metadata: { k: [1, null] } });
      expect(record.time.archived).toBeGreaterThan(0);

      events.length = 0;
      await service.update('ses_a', { title: 'New name', archived: true });
      expect(events).toEqual([]);

      await service.update('ses_a', { archived: false });
      expect(types(events)).toEqual(['session.unarchived']);
      expect((await service.get('ses_a')).time.archived).toBeUndefined();
    });

    it('treats an empty body as a no-op and an unknown session as a tagged 404', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_a' });
      events.length = 0;
      await service.update('ses_a', {});
      expect(events).toEqual([]);
      await expect(service.update('ses_missing', { title: 'x' })).rejects.toMatchObject({ status: 404, tag: 'SessionNotFoundError' });
    });

    it('moves time.updated forward on a change', async () => {
      const { service } = setup();
      await service.create({ id: 'ses_a' });
      const before = (await service.get('ses_a')).time.updated;
      await service.update('ses_a', { title: 'x' });
      expect((await service.get('ses_a')).time.updated).toBeGreaterThan(before);
    });
  });

  describe('remove', () => {
    it('stops the process, deletes the Pi file and the sidecar entry, and announces it', async () => {
      const { service, events, closed, writeSessionFile } = setup();
      const file = writeSessionFile('ses_file');
      await service.update('ses_file', { title: 'Has file' });
      events.length = 0;

      await service.remove('ses_file');

      expect(fs.existsSync(file)).toBe(false);
      expect(closed).toEqual(['ses_file']);
      expect(events.map((e) => e.type)).toEqual(['session.deleted']);
      await expect(service.get('ses_file')).resolves.toBeNull();
      await expect(service.remove('ses_file')).rejects.toMatchObject({ status: 404 });
    });

    it('removes the sessions that name it as parent', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_parent' });
      await service.create({ id: 'ses_child', parentID: 'ses_parent' });
      events.length = 0;
      await service.remove('ses_parent');
      expect(events.map((e) => e.data.sessionID)).toEqual(['ses_child', 'ses_parent']);
    });
  });

  describe('view', () => {
    it('stamps the idle watermark the viewer saw, never later than the session\'s own idle', async () => {
      const { service, events, metaStore } = setup();
      await service.create({ id: 'ses_a' });
      await metaStore.patch('ses_a', { idleAt: 500 });
      events.length = 0;

      await service.view('ses_a', { idle: 9_999 });
      expect(events[0]).toMatchObject({ type: 'session.viewed', data: { sessionID: 'ses_a', idle: 500 } });
      expect((await service.get('ses_a')).time.viewed).toBe(500);
    });

    it('does nothing for a session that has never finished a run', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_a' });
      events.length = 0;
      await service.view('ses_a', { idle: 1 });
      expect(events).toEqual([]);
      expect((await service.get('ses_a')).time.viewed).toBeUndefined();
    });
  });

  describe('switching model and agent', () => {
    it('announces a model switch with the previous model and sends nothing when it does not change', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_a', model: { providerID: 'mock', id: 'm1' } });
      events.length = 0;

      await service.switchModel('ses_a', { model: { providerID: 'mock', id: 'm2', variant: 'high' } });
      expect(events[0]).toMatchObject({
        type: 'session.model.selected',
        data: { sessionID: 'ses_a', model: { providerID: 'mock', id: 'm2', variant: 'high' }, previous: { id: 'm1', providerID: 'mock', variant: 'default' } },
      });
      expect(events[0].location).toBeUndefined();

      events.length = 0;
      await service.switchModel('ses_a', { model: { providerID: 'mock', id: 'm2', variant: 'high' } });
      expect(events).toEqual([]);
      expect((await service.get('ses_a')).model).toEqual({ id: 'm2', providerID: 'mock', variant: 'high' });
    });

    it('rejects a null variant, as OpenCode does', async () => {
      const { service } = setup();
      await service.create({ id: 'ses_a' });
      await expect(service.switchModel('ses_a', { model: { providerID: 'mock', id: 'm1', variant: null } })).rejects.toMatchObject({ status: 400 });
    });

    it('announces an agent switch once with the previous agent', async () => {
      const { service, events } = setup();
      await service.create({ id: 'ses_a', agent: 'build' });
      events.length = 0;
      await service.switchAgent('ses_a', { agent: 'plan' });
      await service.switchAgent('ses_a', { agent: 'plan' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'session.agent.selected', data: { sessionID: 'ses_a', agent: 'plan', previous: 'build' } });
    });
  });

  it('reports running sessions in the shape the UI checks', () => {
    const { service } = setup();
    expect(service.active()).toEqual({});
    service.markRunning('ses_a');
    expect(service.active()).toEqual({ ses_a: { type: 'running' } });
    service.markSettled('ses_a');
    expect(service.active()).toEqual({});
  });
});
