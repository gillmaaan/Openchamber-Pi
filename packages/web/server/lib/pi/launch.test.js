import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildPiChildEnv, buildPiRpcArgs, piRuntimeProblem, readableEntryPath, readPiVersion, resolvePiRpcEntry, resolvePiRuntime } from './launch.js';
import { createPiRpcClient } from './rpc-client.js';
import { startMockOpenAi } from './test-support/mock-openai.js';
import { createPiFixture } from './test-support/pi-fixture.js';

describe('resolvePiRuntime', () => {
  it('runs Electron as plain Node', () => {
    const runtime = resolvePiRuntime({ versions: { electron: '41.0.0' }, execPath: '/App/Electron', env: {} });
    expect(runtime).toEqual({ command: '/App/Electron', env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('keeps the current executable on Node', () => {
    expect(resolvePiRuntime({ versions: { node: '24.0.0' }, execPath: '/usr/bin/node', env: {} }))
      .toEqual({ command: '/usr/bin/node', env: {} });
  });

  it('prefers a Node on PATH over Bun', () => {
    const runtime = resolvePiRuntime({ versions: { bun: '1.4.4' }, execPath: '/bun', env: { PATH: `${process.execPath.replace(/\/node$/, '')}` } });
    expect(runtime.command).toBe(process.execPath);
  });

  it('falls back to Bun when no Node is on PATH', () => {
    expect(resolvePiRuntime({ versions: { bun: '1.4.4' }, execPath: '/bun', env: { PATH: '/nonexistent' } }).command).toBe('/bun');
  });
});

describe('readableEntryPath', () => {
  let root;

  beforeAll(() => { root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-asar-')); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('points a spawned process at the unpacked copy inside a packaged app', () => {
    const asarEntry = path.join(root, 'app.asar', 'node_modules', 'pi', 'rpc-entry.js');
    const unpackedEntry = path.join(root, 'app.asar.unpacked', 'node_modules', 'pi', 'rpc-entry.js');
    fs.mkdirSync(path.dirname(unpackedEntry), { recursive: true });
    fs.writeFileSync(unpackedEntry, '');
    expect(readableEntryPath(asarEntry)).toBe(unpackedEntry);
  });

  it('leaves an unpacked or ordinary path alone', () => {
    const ordinary = path.join(root, 'project', 'rpc-entry.js');
    expect(readableEntryPath(ordinary)).toBe(ordinary);
    const missing = path.join(root, 'app.asar', 'absent.js');
    expect(readableEntryPath(missing)).toBe(missing);
  });
});

describe('buildPiChildEnv', () => {
  it('drops the previous agent\'s variables and keeps the user\'s', () => {
    const env = buildPiChildEnv(
      { PATH: '/x', OPENCODE_PASSWORD: 'secret', OPENCODE_CONFIG: '/c', ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--inspect' },
      { PI_CODING_AGENT_DIR: '/agent' },
    );
    expect(env).toEqual({ PATH: '/x', ANTHROPIC_API_KEY: 'k', PI_CODING_AGENT_DIR: '/agent' });
  });

  it('lets the caller remove a variable by passing undefined', () => {
    expect(buildPiChildEnv({ A: '1', B: '2' }, { A: undefined })).toEqual({ B: '2' });
  });
});

describe('buildPiRpcArgs', () => {
  it('resumes a session file and refuses project resources unless the caller approves', () => {
    expect(buildPiRpcArgs({ sessionFile: '/s/a.jsonl', extensions: ['/e/bridge.js'] }))
      .toEqual(['--offline', '--no-approve', '--session', '/s/a.jsonl', '-e', '/e/bridge.js']);
  });

  it('trusts the project only when told to', () => {
    expect(buildPiRpcArgs({ sessionId: 'ses_abc', approveProject: true })).toEqual(['--offline', '--approve', '--session-id', 'ses_abc']);
    expect(buildPiRpcArgs({ sessionId: 'ses_abc' })).toEqual(['--offline', '--no-approve', '--session-id', 'ses_abc']);
  });

  it('appends extra arguments last, after the extensions', () => {
    expect(buildPiRpcArgs({ sessionId: 'ses_abc', extensions: ['/e.js'], model: 'mock/m:low', extraArgs: ['--tools', 'read,grep'] }))
      .toEqual(['--offline', '--no-approve', '--session-id', 'ses_abc', '--model', 'mock/m:low', '-e', '/e.js', '--tools', 'read,grep']);
  });
});

describe('piRuntimeProblem', () => {
  const runtime = { command: '/usr/bin/node', env: {} };
  const answering = (stdout, status = 0) => () => ({ stdout, status });

  it.each(['v22.19.0\n', 'v22.20.0\n', 'v24.21.0\n', 'v23.0.1\n'])('accepts Node %j', (version) => {
    expect(piRuntimeProblem({ runtime, spawnSyncImpl: answering(version) })).toBeNull();
  });

  it.each(['v22.18.9\n', 'v20.11.0\n', 'v18.20.4\n'])('names the version of a Node that is too old: %j', (version) => {
    expect(piRuntimeProblem({ runtime, spawnSyncImpl: answering(version) })).toMatch(/needs Node 22\.19\.0 or newer, but \/usr\/bin\/node is Node/);
  });

  it('leaves Bun and Electron alone and reports a runtime that does not start', () => {
    expect(piRuntimeProblem({ runtime: { command: '/bun', env: {} }, spawnSyncImpl: answering('1.4.4\n') })).toBeNull();
    expect(piRuntimeProblem({ runtime: { command: '/App/Electron', env: { ELECTRON_RUN_AS_NODE: '1' } }, spawnSyncImpl: () => { throw new Error('not called'); } })).toBeNull();
    expect(piRuntimeProblem({ runtime, spawnSyncImpl: answering('', 127) })).toMatch(/cannot be started/);
    expect(piRuntimeProblem({ runtime, spawnSyncImpl: () => ({ error: new Error('ENOENT'), status: null }) })).toMatch(/cannot be started/);
  });

  it('accepts the Node this test runs on', () => {
    expect(piRuntimeProblem()).toBeNull();
  });
});

describe('readPiVersion', () => {
  it('reads the version of the installed Pi package', () => {
    expect(readPiVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('answers null for an entry outside any Pi package', () => {
    expect(readPiVersion({ entry: '/nonexistent/dist/entry.js' })).toBeNull();
  });
});

describe('a real Pi child', () => {
  let mock;
  let fixture;
  const clients = [];

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => { client.kill('SIGKILL'); await client.exited; }));
  });

  const startPi = (args = {}) => {
    const events = [];
    const runtime = resolvePiRuntime();
    const client = createPiRpcClient({
      command: runtime.command,
      args: [resolvePiRpcEntry(), ...buildPiRpcArgs(args)],
      cwd: fixture.project,
      env: { ...fixture.env, ...runtime.env },
      onEvent: (event) => events.push(event),
    });
    clients.push(client);
    return { client, events };
  };

  const waitForEvent = async (events, predicate, timeoutMs = 15_000) => {
    const startedAt = Date.now();
    for (;;) {
      const match = events.find(predicate);
      if (match) return match;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`event not seen: ${events.map((event) => event.type).join(',')}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('reports the configured model and runs a plain turn to agent_settled', async () => {
    const { client, events } = startPi({ sessionId: 'ses_plainturn' });

    const state = await client.request('get_state');
    expect(state.model).toMatchObject({ provider: 'mock', id: 'mock-model' });

    await client.request('prompt', { message: 'PLAIN please' });
    await waitForEvent(events, (event) => event.type === 'agent_settled');

    const assistant = events.filter((event) => event.type === 'message_end' && event.message.role === 'assistant').at(-1).message;
    expect(assistant.content.find((block) => block.type === 'text').text).toBe('plain answer');
    expect(assistant.stopReason).toBe('stop');
    expect(assistant.usage.input).toBeGreaterThan(0);
  });

  it('runs a bash tool call in the project directory', async () => {
    const { client, events } = startPi({ sessionId: 'ses_toolturn' });

    await client.request('prompt', { message: 'PWD please' });
    await waitForEvent(events, (event) => event.type === 'agent_settled');

    const toolEnd = events.find((event) => event.type === 'tool_execution_end');
    expect(toolEnd.toolName).toBe('bash');
    expect(toolEnd.isError).toBe(false);
    expect(toolEnd.result.content[0].text).toContain(fixture.project);
  });

  it('aborts a streaming turn and settles as aborted', async () => {
    const { client, events } = startPi({ sessionId: 'ses_abortturn' });

    await client.request('prompt', { message: 'SLOW please' });
    await waitForEvent(events, (event) => event.type === 'message_update');
    await client.request('abort');

    const settled = await waitForEvent(events, (event) => event.type === 'agent_settled');
    expect(settled.aborted).toBe(true);
  });

  it('closes cleanly when stdin ends', async () => {
    const { client } = startPi({ sessionId: 'ses_closeturn' });
    await client.request('get_state');
    const info = await client.close();
    expect(info.code).toBe(0);
  });
});
