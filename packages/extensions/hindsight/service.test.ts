import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHindsightAPI, createService, readConnection } from './service.ts';
import { parseEntry } from './model.ts';
import { messagesFor } from './messages.ts';

const homes: string[] = [];
const servers: ReturnType<typeof createService>[] = [];
const home = async (config?: unknown) => {
  const dir = await fs.mkdtemp(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'hindsight-test-'));
  homes.push(dir);
  if (config !== undefined) { await fs.mkdir(path.join(dir, '.hindsight')); await fs.writeFile(path.join(dir, '.hindsight/coding-agent.json'), JSON.stringify(config)); }
  return dir;
};
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of homes.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const url = (p: string) => new URL(p, 'http://localhost');
const config = { apiUrl: 'https://memory.example.test/hindsight-api', apiToken: 'test-private-token' };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

// External response shapes come from Hindsight's published OpenAPI contract.
describe('Hindsight connection and bounded API', () => {
  test('reads the connected home, applies Pi overrides, and rereads rotated tokens', async () => {
    const dir = await home({ ...config, harnesses: { pi: { apiToken: 'pi-token' } } });
    expect(await readConnection(dir)).toEqual({ url: config.apiUrl, token: 'pi-token' });
    await fs.writeFile(path.join(dir, '.hindsight/coding-agent.json'), JSON.stringify({ ...config, apiToken: 'rotated' }));
    expect((await readConnection(dir)).token).toBe('rotated');
  });
  test('distinguishes missing config and refuses insecure, credential-bearing, and malformed URLs', async () => {
    await expect(readConnection(await home())).rejects.toMatchObject({ code: 'configMissing' });
    for (const apiUrl of ['http://public.example.test', 'https://user:secret@example.test', 'https://example.test?token=bad', 'file:///etc/passwd']) {
      await expect(readConnection(await home({ ...config, apiUrl }))).rejects.toMatchObject({ code: 'configInvalid' });
    }
    expect((await readConnection(await home({ apiUrl: 'http://localhost:8888' }))).token).toBe('');
  });
  test('preserves URL prefixes, encodes bank IDs and only returns selected fields', async () => {
    let called = '';
    const api = createHindsightAPI({ home: await home(config), fetcher: async (input, init) => {
      called = String(input);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-private-token');
      expect(init?.redirect).toBe('error');
      return response({ items: [{ id: 'm1', text: '<script>unsafe</script>', fact_type: 'world', metadata: { secret: 'not-for-frame' } }], total: 1, offset: 0 });
    } });
    const value = await api('GET', url('/banks/pi%3A%3Abank/memories?q=test&offset=50'));
    expect(called).toBe('https://memory.example.test/hindsight-api/v1/default/banks/pi%3A%3Abank/memories/list?limit=50&offset=50&q=test&state=valid');
    expect(JSON.stringify(value)).not.toContain('not-for-frame');
    expect(JSON.stringify(value)).toContain('<script>unsafe</script>');
  });
  test('upstream failures and malformed success never look like empty lists or leak response bodies', async () => {
    for (const [reply, code] of [[new Response('test-private-token', { status: 401 }), 'unauthorized'], [new Response('private error', { status: 500 }), 'upstream'], [response({ items: [] }), 'invalidResponse']] as const) {
      const api = createHindsightAPI({ home: await home(config), fetcher: async () => reply });
      await expect(api('GET', url('/banks'))).rejects.toMatchObject({ code });
    }
    const api = createHindsightAPI({ home: await home(config), fetcher: async () => { throw new Error('private transport detail'); } });
    await expect(api('GET', url('/banks'))).rejects.toMatchObject({ code: 'unavailable' });
  });
  test('does not expose arbitrary upstream paths or config keys', async () => {
    let calls = 0;
    const api = createHindsightAPI({ home: await home(config), fetcher: async () => { calls++; return response({}); } });
    for (const p of ['/admin', '/banks/b/config', '/banks/b/memories/m/arbitrary', '/banks/b/pages/p']) {
      await expect(api('DELETE', url(p))).rejects.toMatchObject({ code: 'invalidRequest' });
    }
    await expect(api('PATCH', url('/banks/b/settings'), { apiToken: 'other', reflect_mission: '', retain_mission: '' })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toBe(0);
  });
  test('edits, archives and restores facts, deletes only documents, and preserves unrelated bank config', async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const api = createHindsightAPI({ home: await home(config), fetcher: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return response({ success: true, config: { reflect_mission: 'new', retain_mission: 'retain', private_config: 'hidden' } });
    } });
    await api('PATCH', url('/banks/b/memories/m'), { text: 'corrected', context: 'source' });
    await api('PATCH', url('/banks/b/memories/m'), { state: 'invalidated' });
    await api('PATCH', url('/banks/b/memories/m'), { state: 'valid' });
    await api('DELETE', url('/banks/b/documents/gitlog%3Aproject'));
    expect(await api('PATCH', url('/banks/b/settings'), { reflect_mission: 'new', retain_mission: 'retain' })).toEqual({ reflect_mission: 'new', retain_mission: 'retain' });
    expect(requests.map((r) => r.method)).toEqual(['PATCH', 'PATCH', 'PATCH', 'DELETE', 'PATCH']);
    expect(requests[4].body).toEqual({ updates: { reflect_mission: 'new', retain_mission: 'retain' } });
    expect(requests[3].url).toEndWith('/banks/b/documents/gitlog%3Aproject');
  });
  test('caps responses without forwarding an incomplete document', async () => {
    const api = createHindsightAPI({ home: await home(config), fetcher: async () => new Response('x'.repeat(4_000_001)) });
    await expect(api('GET', url('/banks/b/documents/doc'))).rejects.toMatchObject({ code: 'tooLarge' });
  });
  test('accepts metadata-only document lists and read-only observations', () => {
    expect(parseEntry('documents', { id: 'doc' }).text).toBe('');
    expect(parseEntry('memories', { id: 'observation', text: 'derived', type: 'observation' }).type).toBe('observation');
  });
});

test('the actual HTTP service authenticates health and actions and sanitizes exceptions', async () => {
  const server = createService({ token: 'loopback-test', api: async () => { throw new Error('private secret'); } });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  const base = `http://127.0.0.1:${address.port}`;
  expect((await fetch(base + '/health')).status).toBe(401);
  const headers = { Authorization: 'Bearer loopback-test' };
  expect((await fetch(base + '/health', { headers })).status).toBe(200);
  const failed = await fetch(base + '/banks', { headers });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ code: 'unavailable' });
});

test('all host locales have complete translated extension messages', () => {
  const en = messagesFor('en');
  for (const locale of ['de', 'es', 'fr', 'nl', 'pl', 'pt-BR', 'uk', 'tr', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he']) {
    const messages = messagesFor(locale);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    expect(messages).not.toBe(en);
    expect(messages.configMissing).not.toBe(en.configMissing);
  }
  expect(messagesFor('de').bank).toBe('Memory-Bank');
});
