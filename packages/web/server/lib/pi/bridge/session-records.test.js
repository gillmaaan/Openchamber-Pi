import { describe, expect, it } from 'vitest';

import { decodeCursor } from './cursor.js';
import { createSessionRecords } from './session-records.js';

const file = (id, overrides = {}) => ({
  id,
  cwd: '/work/a',
  createdAt: 1000,
  updatedAt: 2000,
  name: undefined,
  firstUserText: '',
  usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 1, cost: 0.1 },
  model: { provider: 'mock', modelId: 'm1' },
  thinkingLevel: 'high',
  ...overrides,
});

const toWireUsage = (usage) => ({ tokens: { input: usage.input, output: usage.output - usage.reasoning, reasoning: usage.reasoning, cache: { read: usage.cacheRead, write: usage.cacheWrite } }, cost: usage.cost });

const makeRecords = ({ files = [], meta = {}, drafts = [] } = {}) => createSessionRecords({
  fileIndex: { list: async () => files, get: async (id) => files.find((f) => f.id === id) ?? null },
  metaStore: { get: (id) => meta[id] ?? null, drafts: () => drafts },
  toWireUsage,
  projectOf: (directory) => ({ id: `project-of-${directory}`, root: directory, subpath: directory.endsWith('/sub') ? 'sub' : undefined }),
});

const q = (params) => new URLSearchParams(params);

describe('session records', () => {
  it('builds a record from a Pi file and its sidecar entry', async () => {
    const records = makeRecords({
      files: [file('ses_a', { firstUserText: 'Fix the login\nmore' })],
      meta: { ses_a: { agent: 'build', archivedAt: 5000, viewedAt: 3000, idleAt: 3000, busyAt: 2500, outcome: 'succeeded', updatedAt: 4000, metadata: { x: 1 } } },
    });
    expect(await records.get('ses_a')).toEqual({
      id: 'ses_a',
      projectID: 'project-of-/work/a',
      agent: 'build',
      model: { id: 'm1', providerID: 'mock', variant: 'high' },
      cost: 0.1,
      tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
      outcome: 'succeeded',
      time: { created: 1000, updated: 4000, busy: 2500, idle: 3000, viewed: 3000, archived: 5000 },
      title: 'Fix the login',
      location: { directory: '/work/a' },
      metadata: { x: 1 },
    });
  });

  it('prefers a renamed title, then the Pi name, then the first prompt', async () => {
    const records = makeRecords({
      files: [file('ses_a', { name: 'Pi name', firstUserText: 'prompt' }), file('ses_b', { firstUserText: 'prompt' })],
      meta: { ses_a: { title: 'Renamed' } },
    });
    expect((await records.get('ses_a')).title).toBe('Renamed');
    expect((await records.get('ses_b')).title).toBe('prompt');
    const named = makeRecords({ files: [file('ses_c', { name: 'Pi name', firstUserText: 'prompt' })] });
    expect((await named.get('ses_c')).title).toBe('Pi name');
  });

  it('shows a model switched through the API ahead of the one in the file, with variant default when none was given', async () => {
    const records = makeRecords({ files: [file('ses_a')], meta: { ses_a: { model: { providerID: 'other', id: 'm9' } } } });
    expect((await records.get('ses_a')).model).toEqual({ id: 'm9', providerID: 'other', variant: 'default' });
  });

  it('serves a draft that has no Pi file yet, without a title or model', async () => {
    const records = makeRecords({ drafts: [{ id: 'ses_draft', directory: '/work/new', createdAt: 9000 }] });
    expect(await records.get('ses_draft')).toEqual({
      id: 'ses_draft',
      projectID: 'project-of-/work/new',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 9000, updated: 9000 },
      location: { directory: '/work/new' },
    });
  });

  it('lets the file win over a draft with the same id and returns null for an unknown id', async () => {
    const records = makeRecords({ files: [file('ses_a')], drafts: [{ id: 'ses_a', directory: '/elsewhere', createdAt: 1 }] });
    expect((await records.get('ses_a')).location.directory).toBe('/work/a');
    expect(await records.get('ses_none')).toBeNull();
  });

  it('adds subpath only when the folder is below the project root', async () => {
    const records = makeRecords({ files: [file('ses_a', { cwd: '/repo/sub' })] });
    expect((await records.get('ses_a')).subpath).toBe('sub');
  });

  describe('list', () => {
    const files = [
      file('ses_1', { updatedAt: 1000, cwd: '/work/a', firstUserText: 'alpha task' }),
      file('ses_2', { updatedAt: 3000, cwd: '/work/b', name: 'Second' }),
      file('ses_3', { updatedAt: 2000, cwd: '/work/a' }),
    ];

    it('sorts by last change, newest first, and marks the page ends', async () => {
      const result = await makeRecords({ files }).list(q({}));
      expect(result.data.map((r) => r.id)).toEqual(['ses_2', 'ses_3', 'ses_1']);
      expect(result.cursor.next).toBeTruthy();
      expect(result.cursor.previous).toBeTruthy();
    });

    it('sorts oldest first with order=asc', async () => {
      const result = await makeRecords({ files }).list(q({ order: 'asc' }));
      expect(result.data.map((r) => r.id)).toEqual(['ses_1', 'ses_3', 'ses_2']);
    });

    it('answers an empty list with both cursor keys null', async () => {
      expect((await makeRecords().list(q({}))).cursor).toEqual({ previous: null, next: null });
    });

    it('pages with a cursor that carries the filters', async () => {
      const records = makeRecords({ files });
      const first = await records.list(q({ limit: '1', directory: '/work/a' }));
      expect(first.data.map((r) => r.id)).toEqual(['ses_3']);
      expect(decodeCursor(first.cursor.next).filters).toEqual({ directory: '/work/a' });

      const second = await records.list(q({ limit: '1', cursor: first.cursor.next }));
      expect(second.data.map((r) => r.id)).toEqual(['ses_1']);
      const third = await records.list(q({ limit: '1', cursor: second.cursor.next }));
      expect(third.data).toEqual([]);
      expect(third.cursor).toEqual({ previous: null, next: null });

      const back = await records.list(q({ limit: '5', cursor: second.cursor.previous }));
      expect(back.data.map((r) => r.id)).toEqual(['ses_3']);
    });

    it('filters by archived, parent, directory and search', async () => {
      const records = makeRecords({
        files,
        meta: { ses_1: { archivedAt: 5 }, ses_3: { parentID: 'ses_2' } },
      });
      const ids = async (params) => (await records.list(q(params))).data.map((r) => r.id);
      expect(await ids({ archived: 'true' })).toEqual(['ses_1']);
      expect(await ids({ archived: 'false' })).toEqual(['ses_2', 'ses_3']);
      expect(await ids({ parentID: 'null' })).toEqual(['ses_2', 'ses_1']);
      expect(await ids({ parentID: 'ses_2' })).toEqual(['ses_3']);
      expect(await ids({ directory: '/work/b' })).toEqual(['ses_2']);
      expect(await ids({ search: 'ALPHA' })).toEqual(['ses_1']);
      expect(await ids({ search: 'second' })).toEqual(['ses_2']);
    });

    it('rejects a limit of zero and an unknown order as query errors, and a bad cursor', async () => {
      const records = makeRecords({ files });
      await expect(records.list(q({ limit: '0' }))).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError', extra: { kind: 'Query' } });
      await expect(records.list(q({ order: 'sideways' }))).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError' });
      await expect(records.list(q({ cursor: 'garbage' }))).rejects.toMatchObject({ status: 400, tag: 'InvalidCursorError' });
    });

    it('includes drafts', async () => {
      const records = makeRecords({ files, drafts: [{ id: 'ses_d', directory: '/work/a', createdAt: 9999 }] });
      expect((await records.list(q({}))).data[0].id).toBe('ses_d');
    });
  });
});
