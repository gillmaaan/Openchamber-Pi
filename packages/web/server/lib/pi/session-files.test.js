import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from './launch.js';
import { createPiRpcClient } from './rpc-client.js';
import {
  activeBranch,
  createSessionFileIndex,
  readSessionEntries,
  readSessionHeader,
  sessionDirFor,
  sessionIdFromFileName,
  wireSessionId,
} from './session-files.js';
import { startMockOpenAi } from './test-support/mock-openai.js';
import { createPiFixture } from './test-support/pi-fixture.js';

const line = (value) => `${JSON.stringify(value)}\n`;
const header = (overrides = {}) => ({ type: 'session', version: 3, id: 'sid', timestamp: '2026-11-01T10:00:00.000Z', cwd: '/work/a', ...overrides });
const message = (id, parentId, role, content, timestamp = '2026-11-01T10:00:01.000Z') => ({ type: 'message', id, parentId, timestamp, message: { role, content } });

describe('session files', () => {
  let mock;
  let fixture;

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });

  const writeSession = (name, lines) => {
    const dir = path.join(fixture.sessionsDir, '--synthetic--');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join(''));
    return file;
  };

  it('lists a session a real Pi wrote, with its cwd, name and first prompt', async () => {
    const runtime = resolvePiRuntime();
    const events = [];
    const client = createPiRpcClient({
      command: runtime.command,
      args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_listed' })],
      cwd: fixture.project,
      env: { ...fixture.env, ...runtime.env },
      onEvent: (event) => events.push(event),
    });
    await client.request('prompt', { message: 'PLAIN hello' });
    while (!events.some((event) => event.type === 'agent_settled')) await new Promise((resolve) => setTimeout(resolve, 20));
    await client.request('set_session_name', { name: 'My chat' });
    await client.close();

    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir });
    const session = await index.get('ses_listed');

    expect(session).toMatchObject({ id: 'ses_listed', cwd: fixture.project, name: 'My chat', firstUserText: 'PLAIN hello' });
    expect(session.messageCount).toBeGreaterThanOrEqual(2);
    expect(session.updatedAt).toBeGreaterThanOrEqual(session.createdAt);

    const entries = await readSessionEntries(session.path);
    const branch = activeBranch(entries);
    const roles = branch.filter((entry) => entry.type === 'message').map((entry) => entry.message.role);
    expect(roles.at(-1)).toBe('assistant');
    expect(roles).toContain('user');
  });

  it('skips a half-written last line', async () => {
    const file = writeSession('2026-11-01T10-00-00-000Z_partial.jsonl', [
      line(header({ id: 'partial' })),
      line(message('a1', null, 'user', 'hi')),
      '{"type":"message","id":"a2","parentId":"a1","timest',
    ]);
    const entries = await readSessionEntries(file);
    expect(entries.map((entry) => entry.id)).toEqual(['a1']);
  });

  it('reports an unsupported format version instead of reading it', async () => {
    const file = writeSession('2026-11-01T10-00-00-000Z_future.jsonl', [line(header({ id: 'future', version: 4 }))]);
    expect(await readSessionHeader(file)).toEqual({ ok: false, reason: 'unsupported_version' });
    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir });
    expect(await index.get('ses_future')).toBeNull();
  });

  it('ignores an empty file and a file without a session header', async () => {
    const empty = writeSession('2026-11-01T10-00-00-000Z_empty.jsonl', ['']);
    const bogus = writeSession('2026-11-01T10-00-00-000Z_bogus.jsonl', [line({ hello: 'world' })]);
    expect(await readSessionHeader(empty)).toEqual({ ok: false, reason: 'empty' });
    expect(await readSessionHeader(bogus)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('uses the last session_info as the name and the last timestamp as updatedAt', async () => {
    writeSession('2026-11-01T10-00-00-000Z_renamed.jsonl', [
      line(header({ id: 'renamed' })),
      line(message('r1', null, 'user', [{ type: 'text', text: 'first' }, { type: 'text', text: 'part' }], '2026-11-01T10:00:01.000Z')),
      line({ type: 'session_info', id: 'r2', parentId: 'r1', timestamp: '2026-11-01T10:05:00.000Z', name: 'Old' }),
      line({ type: 'session_info', id: 'r3', parentId: 'r2', timestamp: '2026-11-01T10:06:00.000Z', name: '  New  ' }),
    ]);
    const session = await createSessionFileIndex({ sessionsDir: fixture.sessionsDir }).get('ses_renamed');
    expect(session.name).toBe('New');
    expect(session.firstUserText).toBe('first\npart');
    expect(session.updatedAt).toBe(Date.parse('2026-11-01T10:06:00.000Z'));
  });

  it('follows parentId from the last entry to the root, so an abandoned branch is left out', () => {
    const entries = [
      message('root', null, 'user', 'q'),
      message('abandoned', 'root', 'assistant', 'old answer'),
      message('kept', 'root', 'assistant', 'new answer'),
    ];
    expect(activeBranch(entries).map((entry) => entry.id)).toEqual(['root', 'kept']);
  });

  it('sums the usage of assistant messages and reports the last model and thinking level', async () => {
    const assistant = (id, parentId, usage) => ({
      type: 'message', id, parentId, timestamp: '2026-11-01T10:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { total: 0.5 }, ...usage } },
    });
    writeSession('2026-11-01T10-00-00-000Z_usage.jsonl', [
      line(header({ id: 'usage' })),
      line({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-11-01T10:00:00.500Z', provider: 'a', modelId: 'one' }),
      line({ type: 'model_change', id: 'm2', parentId: 'm1', timestamp: '2026-11-01T10:00:00.600Z', provider: 'b', modelId: 'two' }),
      line({ type: 'thinking_level_change', id: 't1', parentId: 'm2', timestamp: '2026-11-01T10:00:00.700Z', thinkingLevel: 'high' }),
      line(message('u1', 't1', 'user', 'hi')),
      line(assistant('a1', 'u1', {})),
      line(assistant('a2', 'a1', { input: 20, cost: { total: 0.25 } })),
    ]);
    const session = await createSessionFileIndex({ sessionsDir: fixture.sessionsDir }).get('ses_usage');
    expect(session.model).toEqual({ provider: 'b', modelId: 'two' });
    expect(session.thinkingLevel).toBe('high');
    expect(session.usage).toEqual({ input: 30, output: 10, cacheRead: 4, cacheWrite: 2, reasoning: 6, cost: 0.75 });
  });

  it('counts usage a real Pi recorded for a turn', async () => {
    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir });
    const session = await index.get('ses_listed');
    expect(session.usage.input + session.usage.cacheRead).toBeGreaterThan(0);
    expect(session.usage.output).toBeGreaterThan(0);
    expect(session.model).toEqual({ provider: 'mock', modelId: 'mock-model' });
  });

  it('names the session folder the way Pi does, so a pinned --session-dir is the default place', async () => {
    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir });
    const listed = await index.get('ses_listed');
    expect(path.dirname(listed.path)).toBe(sessionDirFor(fixture.sessionsDir, fixture.project));
  });

  it('turns every separator of the path into a dash', () => {
    expect(sessionDirFor('/s', '/nonexistent/a b/c:d')).toBe('/s/--nonexistent-a b-c-d--');
  });

  it('shows a session the pi CLI made under a ses_ id and keeps its own id as piId', async () => {
    const uuid = '01a19e4b-be78-7079-aa76-095fc4309ab9';
    writeSession(`2026-11-01T10-00-00-000Z_${uuid}.jsonl`, [line(header({ id: uuid })), line(message('c1', null, 'user', 'from the cli'))]);
    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir });
    const session = await index.get(`ses_${uuid}`);
    expect(session).toMatchObject({ id: `ses_${uuid}`, piId: uuid, firstUserText: 'from the cli' });
    expect(await index.get(uuid)).toBeNull();
    expect(wireSessionId('ses_e3cd06fd2ffeGYpyl4kUQ27KUp')).toBe('ses_e3cd06fd2ffeGYpyl4kUQ27KUp');
  });

  it('reads the session id from the file name', () => {
    expect(sessionIdFromFileName('2026-11-02T22-05-26-520Z_01a19e4b-be78.jsonl')).toBe('01a19e4b-be78');
    expect(sessionIdFromFileName('notes.txt')).toBeNull();
  });

  it('shares one scan between concurrent list calls and re-reads a changed file', async () => {
    const file = writeSession('2026-11-01T10-00-00-000Z_changing.jsonl', [line(header({ id: 'changing' })), line(message('c1', null, 'user', 'one'))]);
    const index = createSessionFileIndex({ sessionsDir: fixture.sessionsDir, ttlMs: 0 });
    const [a, b] = await Promise.all([index.list(), index.list()]);
    expect(a.find((s) => s.id === 'ses_changing').messageCount).toBe(1);
    expect(b.find((s) => s.id === 'ses_changing').messageCount).toBe(1);

    fs.appendFileSync(file, line(message('c2', 'c1', 'assistant', 'two')));
    const after = await index.get('ses_changing');
    expect(after.messageCount).toBe(2);
  });
});
