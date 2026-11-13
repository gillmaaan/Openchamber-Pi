import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../launch.js';
import { createPiRpcClient } from '../rpc-client.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { startMockOpenAi } from '../test-support/mock-openai.js';
import { createMcpStatusCache, createMcpStore, fromPiServerEntry, toPiServerEntry } from './mcp.js';

const TINY_MCP_SERVER = fileURLToPath(new URL('./test-support/tiny-mcp-server.mjs', import.meta.url));

describe('toPiServerEntry / fromPiServerEntry', () => {
  it('maps a local server: command[] <-> {command, args}, environment <-> env', () => {
    const entry = toPiServerEntry({ type: 'local', command: ['node', 'server.js', '--flag'], environment: { KEY: 'value' } }, null, { forceExposure: true });
    expect(entry).toEqual({ type: 'stdio', command: 'node', args: ['server.js', '--flag'], env: { KEY: 'value' }, exposure: 'direct' });
    const back = fromPiServerEntry('tiny', entry, { scope: 'user', path: '/x/mcp.json' });
    expect(back).toMatchObject({ name: 'tiny', type: 'local', command: ['node', 'server.js', '--flag'], environment: { KEY: 'value' }, disabled: false, scope: 'user' });
  });

  it('maps a remote server: oauth snake_case <-> camelCase, timeout phases <-> seconds', () => {
    const entry = toPiServerEntry({
      type: 'remote', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' },
      oauth: { client_id: 'abc', callback_port: 9999, redirect_uri: 'http://127.0.0.1:9999/callback' },
      timeout: { execution: 30_000 }, disabled: true,
    }, null, {});
    expect(entry).toMatchObject({
      type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' },
      oauth: { clientId: 'abc', callbackPort: 9999, callbackUrl: 'http://127.0.0.1:9999/callback' },
      timeout: 30, enabled: false,
    });
    const back = fromPiServerEntry('remote', entry, { scope: 'user', path: '/x/mcp.json' });
    expect(back).toMatchObject({
      type: 'remote', url: 'https://example.com/mcp', disabled: true,
      oauth: { client_id: 'abc', callback_port: 9999, redirect_uri: 'http://127.0.0.1:9999/callback' },
      timeout: { execution: 30_000 },
    });
  });

  it('passes oauth: false straight through in both directions', () => {
    const entry = toPiServerEntry({ type: 'remote', url: 'https://x', oauth: false }, null, {});
    expect(entry.oauth).toBe(false);
    expect(fromPiServerEntry('x', entry, {}).oauth).toBe(false);
  });

  it('preserves an unknown key already on disk across an update', () => {
    const existing = { type: 'stdio', command: 'node', args: ['s.js'], description: 'hand-written note' };
    const entry = toPiServerEntry({ type: 'local', command: ['node', 's.js'], disabled: true }, existing, {});
    expect(entry.description).toBe('hand-written note');
    expect(entry.enabled).toBe(false);
  });
});

describe('createMcpStore', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  const makeStore = (extra = {}) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-mcp-'));
    dirs.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const store = createMcpStore({ getAgentDir: () => agentDir, ...extra });
    return { store, agentDir, project };
  };

  it('creates a global stdio server with exposure forced to direct', async () => {
    const { store, agentDir } = makeStore();
    await store.create('tiny', { type: 'local', command: ['node', TINY_MCP_SERVER] }, null, 'user');
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.tiny).toMatchObject({ type: 'stdio', command: 'node', exposure: 'direct' });
    const listed = (await store.list(null)).find((server) => server.name === 'tiny');
    expect(listed).toMatchObject({ name: 'tiny', type: 'local', scope: 'user' });
  });

  it('rejects a duplicate and an invalid name', async () => {
    const { store } = makeStore();
    await store.create('dup', { type: 'remote', url: 'https://x' }, null, 'user');
    await expect(store.create('dup', { type: 'remote', url: 'https://y' }, null, 'user')).rejects.toThrow(/already exists/);
    await expect(store.create('bad name!', { type: 'remote', url: 'https://x' }, null, 'user')).rejects.toThrow(/letters, digits/);
  });

  it('a project server needs a trusted project', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => false });
    await expect(store.create('srv', { type: 'remote', url: 'https://project' }, project, 'project')).rejects.toThrow(/not a trusted project/);
  });

  it('create() refuses a name that already exists at the other scope, matching the host mcp.js precedent', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => true });
    await store.create('srv', { type: 'remote', url: 'https://global' }, null, 'user');
    await expect(store.create('srv', { type: 'remote', url: 'https://project' }, project, 'project')).rejects.toThrow(/already exists/);
  });

  it('a hand-placed project entry overrides the global one of the same name in list(), without going through create()', async () => {
    const { store, agentDir, project } = makeStore({ isProjectTrusted: async () => true });
    await store.create('srv', { type: 'remote', url: 'https://global' }, null, 'user');
    void agentDir;
    fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { srv: { type: 'http', url: 'https://project' } } }));
    const list = await store.list(project);
    expect(list.filter((server) => server.name === 'srv')).toHaveLength(1);
    expect(list.find((server) => server.name === 'srv').url).toBe('https://project');
    expect((await store.list(null)).find((server) => server.name === 'srv').url).toBe('https://global');
  });

  it('update() edits in place and delete() removes the entry', async () => {
    const { store } = makeStore();
    await store.create('edit-me', { type: 'remote', url: 'https://a' }, null, 'user');
    await store.update('edit-me', { url: 'https://b', disabled: true }, null);
    let found = await store.get('edit-me', null);
    expect(found).toMatchObject({ url: 'https://b', disabled: true });

    await store.remove('edit-me', null);
    expect(await store.get('edit-me', null)).toBeNull();
  });

  it('a corrupt mcp.json is never silently overwritten', async () => {
    const { store, agentDir } = makeStore();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{ not json');
    await expect(store.create('x', { type: 'remote', url: 'https://x' }, null, 'user')).rejects.toThrow(/cannot be read/);
    expect(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).toBe('{ not json');
  });

  it('onChanged fires on create, update, delete and setEnabled', async () => {
    const changes = [];
    const { store } = makeStore({ onChanged: (change) => changes.push(change) });
    await store.create('watched', { type: 'remote', url: 'https://x' }, null, 'user');
    await store.update('watched', { disabled: true }, null);
    await store.setEnabled('watched', false, null);
    await store.remove('watched', null);
    expect(changes).toHaveLength(4);
  });
});

describe('createMcpStatusCache against a real Pi CLI and a tiny stdio MCP server', () => {
  it('lists a connected server with exposure:direct, caches the result, and invalidates on force', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-mcp-status-'));
    try {
      const mock = await startMockOpenAi();
      const fixture = createPiFixture({ mockPort: mock.port });
      try {
        fs.writeFileSync(path.join(fixture.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { tiny: { type: 'stdio', command: 'node', args: [TINY_MCP_SERVER], exposure: 'direct' } } }));
        let calls = 0;
        const cache = createMcpStatusCache({
          runPi: async (args, options) => { calls += 1; const { createPiCliRunner } = await import('../packages-cli.js'); return createPiCliRunner()(args, options); },
          getBaseEnv: () => fixture.env,
          ttlMs: 60_000,
        });
        const first = await cache.get(fixture.project);
        expect(first.get('tiny')).toEqual({ status: 'connected' });
        expect(calls).toBe(1);
        await cache.get(fixture.project);
        expect(calls).toBe(1); // cached
        cache.invalidate(fixture.project);
        await cache.get(fixture.project, { force: true });
        expect(calls).toBe(2);
      } finally {
        await mock.close();
        fixture.dispose();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('an MCP server with exposure:direct reaches the model as a declared tool', () => {
  it('mcp__tiny__echo is in the model request\'s tool list', async () => {
    const mock = await startMockOpenAi();
    const fixture = createPiFixture({ mockPort: mock.port });
    try {
      fs.writeFileSync(path.join(fixture.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { tiny: { type: 'stdio', command: 'node', args: [TINY_MCP_SERVER], exposure: 'direct' } } }));
      const runtime = resolvePiRuntime();
      const events = [];
      const client = createPiRpcClient({
        command: runtime.command,
        args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_mcp_test', approveProject: true })],
        cwd: fixture.project,
        env: { ...fixture.env, ...runtime.env },
        onEvent: (event) => events.push(event),
      });
      try {
        await client.request('prompt', { message: 'PLAIN hello' });
        const startedAt = Date.now();
        while (!events.some((event) => event.type === 'agent_end') && Date.now() - startedAt < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(mock.requests.at(-1).toolNames).toContain('mcp__tiny__echo');
      } finally {
        client.kill('SIGKILL');
        await client.exited;
      }
    } finally {
      await mock.close();
      fixture.dispose();
    }
  }, 30_000);
});
