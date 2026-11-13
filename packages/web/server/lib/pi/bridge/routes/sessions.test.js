import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFileIndex } from '../../session-files.js';
import { createSessionMetaStore } from '../../session-meta-store.js';
import { createEventHub } from '../hub.js';
import { createBridgeHttpServer } from '../http.js';
import { createSessionRecords } from '../session-records.js';
import { createSessionService } from '../session-service.js';
import { createSessionRoutes } from './sessions.js';

const PASSWORD = 'pw';
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const toWireUsage = (usage) => ({ tokens: { input: usage.input, output: usage.output, reasoning: usage.reasoning, cache: { read: usage.cacheRead, write: usage.cacheWrite } }, cost: usage.cost });

const start = async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-routes-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const fileIndex = createSessionFileIndex({ sessionsDir: path.join(root, 'sessions'), ttlMs: 0 });
  const metaStore = createSessionMetaStore({ filePath: path.join(root, 'meta.json') });
  const records = createSessionRecords({ fileIndex, metaStore, toWireUsage });
  const hub = createEventHub({ heartbeatMs: 0 });
  const service = createSessionService({
    records, metaStore, fileIndex, hub,
    host: { close: async () => {} },
    getDefaultDirectory: () => project,
  });
  const bridge = createBridgeHttpServer({ password: PASSWORD, routes: createSessionRoutes({ service, hub }) });
  const address = await bridge.listen();
  cleanups.push(() => { hub.close(); return bridge.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  const call = (method, route, body, headers = {}) => fetch(`${base}${route}`, {
    method,
    headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { call, project, service, base };
};

describe('session routes', () => {
  it('creates, reads, renames, archives and deletes with the statuses OpenCode uses', async () => {
    const { call, project } = await start();

    const created = await call('POST', '/api/session', { id: 'ses_one', title: 'One', agent: 'build', model: { providerID: 'mock', id: 'm1' }, location: { directory: project } });
    expect(created.status).toBe(200);
    expect((await created.json()).data).toMatchObject({ id: 'ses_one', title: 'One', agent: 'build', location: { directory: project } });

    expect((await (await call('GET', '/api/session/ses_one')).json()).data.id).toBe('ses_one');
    expect((await call('PATCH', '/api/session/ses_one', { title: 'Renamed' })).status).toBe(204);
    expect((await (await call('GET', '/api/session/ses_one')).json()).data.title).toBe('Renamed');
    expect((await call('PATCH', '/api/session/ses_one', { archived: true })).status).toBe(204);
    expect((await call('PATCH', '/api/session/ses_one', {})).status).toBe(204);

    expect((await call('DELETE', '/api/session/ses_one')).status).toBe(204);
    const gone = await call('GET', '/api/session/ses_one');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ _tag: 'SessionNotFoundError', sessionID: 'ses_one' });
    expect((await call('DELETE', '/api/session/ses_one')).status).toBe(404);
  });

  it('lists with a cursor envelope and pages', async () => {
    const { call } = await start();
    await call('POST', '/api/session', { id: 'ses_a' });
    await call('POST', '/api/session', { id: 'ses_b' });

    const first = await (await call('GET', '/api/session?limit=1')).json();
    expect(first.data).toHaveLength(1);
    expect(typeof first.cursor.next).toBe('string');
    const second = await (await call('GET', `/api/session?limit=1&cursor=${first.cursor.next}`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);

    const bad = await call('GET', '/api/session?cursor=garbage');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ _tag: 'InvalidCursorError', message: 'Invalid cursor' });
  });

  it('answers 400 with the field named for a session id without the ses prefix', async () => {
    const { call } = await start();
    const response = await call('POST', '/api/session', { id: 'abc_123' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ _tag: 'InvalidRequestError', message: 'Expected a string starting with "ses"\n  at ["id"]', kind: 'Payload' });
  });

  it('serves /session/active before the id route and reports running sessions', async () => {
    const { call, service } = await start();
    expect(await (await call('GET', '/api/session/active')).json()).toEqual({ data: {} });
    service.markRunning('ses_x');
    expect(await (await call('GET', '/api/session/active')).json()).toEqual({ data: { ses_x: { type: 'running' } } });
  });

  it('switches model and agent and answers 204', async () => {
    const { call } = await start();
    await call('POST', '/api/session', { id: 'ses_a' });
    expect((await call('POST', '/api/session/ses_a/model', { model: { providerID: 'mock', id: 'm2' } })).status).toBe(204);
    expect((await call('POST', '/api/session/ses_a/agent', { agent: 'plan' })).status).toBe(204);
    const session = (await (await call('GET', '/api/session/ses_a')).json()).data;
    expect(session).toMatchObject({ agent: 'plan', model: { id: 'm2', providerID: 'mock', variant: 'default' } });
    expect((await call('POST', '/api/session/ses_none/agent', { agent: 'plan' })).status).toBe(404);
  });

  it('streams session events to a subscriber that connected before them', async () => {
    const { call, base } = await start();
    const response = await fetch(`${base}/api/event`, { headers: { authorization: auth } });
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('heartbeat');
    await call('POST', '/api/session', { id: 'ses_live', title: 'Live' });
    await readUntil('"sessionID":"ses_live"');
    await reader.cancel();

    expect(text).toContain('"type":"server.connected"');
    expect(text).toContain('"type":"session.created"');
  });
});
