import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerDiagnosticJournal } from '../diagnostics/server-journal.js';
import { injectedEnvKeys } from '../injected-env.js';

const { recordStartupPerformanceMock } = vi.hoisted(() => ({ recordStartupPerformanceMock: vi.fn() }));

vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalFetch = globalThis.fetch;
const services = [];
const tempRoots = [];

beforeEach(() => {
  for (const method of ['log', 'warn', 'error']) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
  await Promise.all(services.splice(0).map((service) => service.closeAll()));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const tempRoot = async (prefix) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withProcessEnv = async (values, run) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const assign = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(values);
  try {
    return await run();
  } finally {
    assign(previous);
  }
};

/**
 * Stands in for the agent service the lifecycle starts through
 * `createServerProcess`: a real HTTP listener on loopback that answers the
 * routes the lifecycle reads, and whose `close()` stops it.
 *
 * `failures` makes the first starts reject. `handlers` maps a path to
 * `() => ({ status?, body? })` and can be replaced per test.
 */
const fakeAgentService = ({
  pid = null,
  stderrTail = '',
  failures = 0,
  startError = new Error('listener unavailable'),
} = {}) => {
  const requests = [];
  const started = [];
  const live = new Map();
  const handlers = {
    '/api/info': () => ({ body: { version: '2.2.6', pid: 1, urls: [], paths: { tmp: '/tmp' } } }),
    '/api/agent': () => ({ body: { location: {}, data: [{ id: 'build' }] } }),
    '/api/location': () => ({ body: { directory: '/' } }),
  };
  let failuresLeft = failures;

  const stop = (server) => new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });

  const createServerProcess = vi.fn(async () => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw startError;
    }
    const server = http.createServer((request, response) => {
      const route = String(request.url).split('?')[0];
      requests.push({ method: request.method, path: route, headers: request.headers });
      const handler = request.method === 'GET' ? handlers[route] : undefined;
      const { status = 200, body = {} } = handler ? handler() : { status: 404 };
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    let closing = null;
    const instance = {
      url: `http://127.0.0.1:${server.address().port}`,
      pid,
      exitCode: null,
      signalCode: null,
      stderrTail,
      close: vi.fn(() => {
        closing ??= stop(server);
        live.delete(instance);
        return closing;
      }),
    };
    live.set(instance, server);
    started.push(instance);
    return instance;
  });

  const service = {
    createServerProcess,
    requests,
    started,
    handlers,
    live,
    /** The service dies without being asked to: its listener goes away and it reports an exit. */
    crash: async (instance, { exitCode = 1, stderrTail: tail } = {}) => {
      await stop(live.get(instance));
      instance.exitCode = exitCode;
      if (tail !== undefined) instance.stderrTail = tail;
    },
    closeAll: () => Promise.all([...live.values()].map(stop)),
  };
  services.push(service);
  return service;
};

const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}, serviceOptions = {}) => {
  const service = fakeAgentService(serviceOptions);
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    ...stateOverrides,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_EFFECTIVE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ...envOverrides,
    },
    syncToHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:${state.openCodePort}${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
    })),
    createServerProcess: service.createServerProcess,
    ...overrides,
  });
  runtime.testState = state;
  runtime.service = service;
  return runtime;
};

/** An agent service that answered earlier and now reports an unhealthy `/api/info`. */
const stubProcess = (overrides = {}) => ({
  pid: null,
  exitCode: null,
  signalCode: null,
  close: vi.fn(async () => {}),
  ...overrides,
});

const unhealthyFetch = (status = 503) => {
  globalThis.fetch = vi.fn(async () => ({ ok: false, status, json: async () => null }));
};

/**
 * Runs `promise` to completion while fake timers are on: the start retry waits
 * on a timer, and real I/O (the fake service listening) may finish between
 * clock steps.
 */
const settle = async (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(750);
  return promise;
};

const bootstrapped = async (overrides = {}) => {
  const runtime = createRuntime(overrides);
  await runtime.bootstrapOpenCodeAtStartup();
  // The warm-up pass runs detached from the bootstrap.
  await sleep(0);
  return runtime;
};

describe('starting the agent service', () => {
  it('starts it on the configured hostname and port and keeps the password out of its environment', async () => {
    const ensureLocalOpenCodeServerPassword = vi.fn(async () => 'managed-secret-pw');
    await withProcessEnv({ OPENCODE_PASSWORD: undefined, OPENCODE_SERVER_PASSWORD: undefined }, async () => {
      const runtime = createRuntime(
        { ensureLocalOpenCodeServerPassword },
        {},
        { ENV_CONFIGURED_OPENCODE_PORT: 45678, ENV_CONFIGURED_OPENCODE_HOSTNAME: '0.0.0.0' },
      );
      const server = await runtime.startOpenCode();
      const { createServerProcess } = runtime.service;

      expect(ensureLocalOpenCodeServerPassword).toHaveBeenCalledWith({ rotateManaged: true });
      expect(createServerProcess).toHaveBeenCalledTimes(1);
      expect(createServerProcess).toHaveBeenCalledWith({
        hostname: '0.0.0.0',
        port: 45678,
        password: 'managed-secret-pw',
        env: expect.any(Object),
        cwd: '/tmp/project',
      });
      const { env } = createServerProcess.mock.calls[0][0];
      expect(env).not.toHaveProperty('OPENCODE_PASSWORD');
      expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
      expect(Object.values(env)).not.toContain('managed-secret-pw');
      expect(injectedEnvKeys(env).has('OPENCODE_PASSWORD')).toBe(false);
      expect(injectedEnvKeys(env).has('OPENCODE_SERVER_PASSWORD')).toBe(false);

      // The port the service answers on is the one the lifecycle publishes.
      expect(runtime.testState.openCodeProcess).toBe(server);
      expect(runtime.testState.openCodePort).toBe(Number(new URL(server.url).port));
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(runtime.testState.lastOpenCodeError).toBeNull();
    });
  });

  it('allocates a free port when none is configured', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();

    const { port } = runtime.service.createServerProcess.mock.calls[0][0];
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it('closes the running service on restart and starts a new one with its own launch environment', async () => {
    const app = {};
    const setupProxy = vi.fn();
    const runtime = createRuntime({ setupProxy }, { expressApp: app });
    const first = await runtime.startOpenCode();
    const { createServerProcess } = runtime.service;

    // Credential reads take variable keys from the environment the current service got.
    expect(runtime.getManagedOpenCodeProcessEnv()).toBe(createServerProcess.mock.calls[0][0].env);

    await runtime.restartOpenCode();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(runtime.service.live.has(first)).toBe(false);
    expect(createServerProcess).toHaveBeenCalledTimes(2);
    expect(runtime.testState.openCodeProcess).toBe(runtime.service.started[1]);
    expect(runtime.testState.openCodePort).toBe(Number(new URL(runtime.service.started[1].url).port));
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(runtime.testState.isRestartingOpenCode).toBe(false);
    expect(runtime.getManagedOpenCodeProcessEnv()).toBe(createServerProcess.mock.calls[1][0].env);
    expect(runtime.getManagedOpenCodeProcessEnv()).toMatchObject({ SHELL_ONLY: 'yes' });
    expect(setupProxy).toHaveBeenCalledWith(app);
  });

  it('journals start and restart as fixed actions only', async () => {
    const journal = createServerDiagnosticJournal();
    const runtime = createRuntime(
      { diagnosticJournal: journal },
      {},
      {},
      { stderrTail: 'plugin failed: token=secret-123 /private/file' },
    );
    await runtime.startOpenCode();
    await runtime.restartOpenCode();

    expect(journal.snapshot().events.map(({ action, detail }) => [action, detail])).toEqual([
      ['managed ready', 'attempt=1'],
      ['managed restart started', undefined],
      ['managed ready', 'attempt=1'],
      ['managed restart ready', undefined],
    ]);
    expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private/);
  });

  describe('when it does not start', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const env = { ENV_CONFIGURED_OPENCODE_PORT: 45678 };

    it('retries a failed start once', async () => {
      const runtime = createRuntime({}, {}, env, { failures: 1 });

      const server = await settle(runtime.startOpenCode());

      expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(2);
      expect(runtime.testState.openCodeProcess).toBe(server);
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(runtime.testState.lastOpenCodeError).toBeNull();
    });

    it('gives up after the second failure and reports it', async () => {
      const runtime = createRuntime({}, {}, env, { failures: Infinity });

      await expect(settle(runtime.startOpenCode())).rejects.toThrow('listener unavailable');

      expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(2);
      expect(runtime.testState.openCodeProcess).toBeNull();
      expect(runtime.testState.openCodePort).toBeNull();
      expect(runtime.testState.lastOpenCodeError).toBe('listener unavailable');
    });

    it.each([
      {
        name: 'the readiness check throws',
        waitForReady: async () => { throw new Error('fixture health failure'); },
        message: 'fixture health failure',
      },
      {
        name: 'the service never becomes ready',
        waitForReady: async () => false,
        message: 'Server started but health check failed (timeout)',
      },
    ])('closes a service that started but is not usable when $name', async ({ waitForReady, message }) => {
      const runtime = createRuntime({ waitForReady: vi.fn(waitForReady) }, {}, env);

      await expect(settle(runtime.startOpenCode())).rejects.toThrow(message);

      // Both attempts started a service, and none is left running.
      expect(runtime.service.started).toHaveLength(2);
      for (const instance of runtime.service.started) expect(instance.close).toHaveBeenCalledTimes(1);
      expect(runtime.service.live.size).toBe(0);
      expect(runtime.testState.openCodeProcess).toBeNull();
      expect(runtime.testState.openCodePort).toBeNull();
      expect(runtime.testState.lastOpenCodeError).toBe(message);
    });

    it('closes the service and does not retry when shutdown begins during startup', async () => {
      const runtime = createRuntime({
        waitForReady: vi.fn(async () => {
          runtime.testState.isShuttingDown = true;
          return true;
        }),
      }, {}, env);

      await expect(runtime.startOpenCode()).rejects.toThrow('startup cancelled during shutdown');

      expect(runtime.service.started).toHaveLength(1);
      expect(runtime.service.started[0].close).toHaveBeenCalledTimes(1);
      expect(runtime.testState.openCodeProcess).toBeNull();
    });
  });
});

describe('launch environment', () => {
  const launchEnv = async (overrides, stateOverrides, envOverrides) => {
    const runtime = createRuntime(overrides, stateOverrides, envOverrides);
    await runtime.startOpenCode();
    return { runtime, env: runtime.service.createServerProcess.mock.calls[0][0].env };
  };

  it('uses the managed PATH and the shell environment snapshot', async () => {
    const { env } = await launchEnv();

    expect(env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(env.SHELL_ONLY).toBe('yes');
  });

  it('removes AppImage launcher entries', async () => {
    await withProcessEnv({
      APPDIR: '/tmp/.mount_OpenChAbC123',
      LD_LIBRARY_PATH: '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:',
    }, async () => {
      const { env } = await launchEnv();

      expect(env.LD_LIBRARY_PATH).toBe('/opt/x');
    });
  });

  it('strips AppImage ARGV0', async () => {
    await withProcessEnv({ ARGV0: '/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage' }, async () => {
      const { env } = await launchEnv({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
          PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
          ARGV0: '/leaked/from/shell/snapshot.AppImage',
          SHELL_ONLY: 'yes',
        })),
      });

      expect(env).not.toHaveProperty('ARGV0');
      expect(env.SHELL_ONLY).toBe('yes');
      expect(env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    });
  });

  it('passes the user variables under the variables OpenChamber owns', async () => {
    const getUserEnvironment = vi.fn(() => ({
      DATABASE_URL: 'postgres://db',
      PATH: '/opt/tools/bin',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'user-token',
    }));
    const getManagedOpenCodeEnv = vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral' }));

    const { runtime, env } = await launchEnv({ getUserEnvironment, getManagedOpenCodeEnv });

    expect(env.DATABASE_URL).toBe('postgres://db');
    expect(env.PATH).toBe('/opt/tools/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(runtime.getManagedOpenCodeProcessEnv().DATABASE_URL).toBe('postgres://db');
    // The replaced value is recorded as OpenChamber's; the user's are not.
    const injected = injectedEnvKeys(env);
    expect(injected.has('OPENCHAMBER_AGENT_TOOL_TOKEN')).toBe(true);
    expect(injected.has('DATABASE_URL')).toBe(false);
    expect(injected.has('PATH')).toBe(false);
  });

  it('adds managed OpenChamber tool environment without letting it replace the PATH', async () => {
    const getManagedOpenCodeEnv = vi.fn(async () => ({
      OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///tool.js"]}',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      PATH: '/untrusted/path',
    }));

    const { env } = await launchEnv({ getManagedOpenCodeEnv });

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
  });

  it('mirrors Google credential env aliases', async () => {
    await withProcessEnv({
      GEMINI_API_KEY: 'AIza-from-gemini',
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    }, async () => {
      const { env } = await launchEnv();

      expect(env.GEMINI_API_KEY).toBe('AIza-from-gemini');
      expect(env.GOOGLE_API_KEY).toBe('AIza-from-gemini');
      expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-from-gemini');
    });
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    const { env } = await launchEnv({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });

    expect(env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    await withProcessEnv({ PATH: '/usr/bin:/bin' }, async () => {
      const { env } = await launchEnv({
        buildManagedOpenCodePath: undefined,
        buildAugmentedPath: undefined,
      });

      expect(env.PATH).toBe('/usr/bin:/bin');
    });
  });
});

describe('bootstrap and the default directory', () => {
  const locationRequests = (runtime) => runtime.service.requests.filter(({ path: route }) => route === '/api/location');

  it('records one authoritative ready terminal event', async () => {
    const runtime = createRuntime();

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.ready', {
      totalDurationMs: expect.any(Number),
      outcome: 'ready',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.error',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    // The readiness check reads the service it just started.
    expect(runtime.service.requests.map(({ path: route }) => route)).toContain('/api/info');
  });

  it('schedules no retry after a successful start', async () => {
    const runtime = createRuntime();

    await runtime.bootstrapOpenCodeAtStartup();

    expect(runtime.scheduleBootstrapRetry(vi.fn())).toBe(false);
  });

  it('warms only the last-used directory after a successful bootstrap', async () => {
    const root = await tempRoot('oc-warm-');
    const lastUsed = path.join(root, 'worktree-a');
    const otherProject = path.join(root, 'project-b');
    await fs.mkdir(lastUsed);
    await fs.mkdir(otherProject);
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [lastUsed, otherProject]) });

    await vi.waitFor(() => expect(locationRequests(runtime)).toHaveLength(1));
    await sleep(25);

    // Each warmed directory boots its whole MCP fleet on OpenCode 2 (#4018).
    // v2 reads the directory from the header, and only location routes start
    // one: `/api/session` is a global list.
    expect(locationRequests(runtime).map(({ headers }) => headers['x-opencode-directory'])).toEqual([
      encodeURIComponent(lastUsed),
    ]);
    // Server-side reads without a directory of their own go to the warmed one.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(lastUsed);
  });

  it('answers null once the warmed default directory is no longer usable', async () => {
    const root = await tempRoot('oc-stale-');
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [stale]) });
    // While the directory is usable, it scopes default reads.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The project directory is removed while the server keeps running. The
    // cached default must not keep being handed to OpenCode: a stale path
    // makes every directory-scoped read answer 500 (the bug behind the quota
    // endpoints' "UnexpectedStatus: 500").
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();

    // A path that now points at a regular file is not a directory either.
    await fs.writeFile(stale, 'x');
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
  });

  it('scopes default reads to the chats root while no project directory is usable', async () => {
    const root = await tempRoot('oc-no-project-');
    const chats = path.join(root, 'chats');
    const project = path.join(root, 'project');
    await fs.mkdir(chats);
    await fs.mkdir(project);
    let warmup = [];
    const runtime = await bootstrapped({
      getWarmupDirectories: vi.fn(async () => warmup),
      noProjectDirectory: chats,
    });
    // No project: a read without a directory would start OpenCode over the
    // whole home, its working directory.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(chats);
    expect(locationRequests(runtime)).toEqual([]);

    // A project opened later takes over once the warmup source names it.
    warmup = [project];
    await runtime.bootstrapOpenCodeAtStartup();
    await sleep(0);
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(project);
  });

  // The UI stops a chat's location once the user leaves it. A read that went
  // to the chat used last at startup would start it again, every quota poll.
  it('scopes reads without a directory to the directory the user works in now', async () => {
    const root = await tempRoot('oc-current-');
    const leftChat = path.join(root, 'left-chat');
    const current = path.join(root, 'current');
    await fs.mkdir(leftChat);
    await fs.mkdir(current);
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [leftChat]) });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(leftChat);

    runtime.noteCurrentDirectory(current);
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);

    // A directory that is not there is never sent.
    runtime.noteCurrentDirectory(path.join(root, 'missing'));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);
  });

  it('advances to a currently-valid warmup directory when the cached default goes stale', async () => {
    const root = await tempRoot('oc-replace-');
    const stale = path.join(root, 'gone');
    const surviving = path.join(root, 'still-here');
    await fs.mkdir(stale);
    await fs.mkdir(surviving);
    // The warm pass offered both; only the first was cached as the default.
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [stale, surviving]) });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // Removing the first still leaves a valid directory: default reads keep
    // their location scope rather than dropping it entirely.
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(surviving);
  });

  it('re-resolves the settings-backed default when the cached one is stale', async () => {
    const root = await tempRoot('oc-refresh-');
    const stale = path.join(root, 'old-project');
    const navigated = path.join(root, 'new-project');
    await fs.mkdir(stale);
    await fs.mkdir(navigated);
    let current = stale;
    // Mirrors the real dep: the warmup source answers the settings'
    // lastDirectory, which moves as the user navigates.
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [current]) });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The user navigated to another project while the old one vanished.
    await fs.rm(stale, { recursive: true, force: true });
    current = navigated;
    // First read drops the stale default and kicks the refresh; the next read
    // sees the re-resolved, currently-valid directory and scopes to it.
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    await sleep(0);
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(navigated);
  });

  // Windows chmod only toggles the read-only attribute, and root ignores the
  // permission bits, so neither can take read/execute away from a directory.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats a directory without read/execute permission as unusable', async () => {
    const root = await tempRoot('oc-perm-');
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked);
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [locked]) });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(locked);

    // OpenCode answers 500 FileSystem.realPath for a directory it cannot read
    // or traverse, same as for a missing one, so it must not be sent.
    await fs.chmod(locked, 0o000);
    try {
      expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it('does not scope the restart agent check to a directory that went stale', async () => {
    const root = await tempRoot('oc-agent-');
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    const runtime = await bootstrapped({ getWarmupDirectories: vi.fn(async () => [stale]) });
    const agentChecks = () => runtime.service.requests.filter(({ path: route }) => route === '/api/agent');

    await runtime.waitForAgentPresence('build', 500, 50);
    expect(agentChecks().map(({ headers }) => headers['x-opencode-directory'])).toEqual([encodeURIComponent(stale)]);

    await fs.rm(stale, { recursive: true, force: true });
    await runtime.waitForAgentPresence('build', 500, 50);
    expect(agentChecks()).toHaveLength(2);
    expect(agentChecks()[1].headers).not.toHaveProperty('x-opencode-directory');
  });
});

describe('bootstrap retry', () => {
  const env = { ENV_CONFIGURED_OPENCODE_PORT: 45678 };

  // A bootstrap whose every start fails; `failures` limits how many starts do.
  const failedBootstrap = async ({ stateOverrides = {}, serviceOptions = {}, overrides = {} } = {}) => {
    const runtime = createRuntime(overrides, stateOverrides, env, { failures: Infinity, ...serviceOptions });
    await settle(runtime.bootstrapOpenCodeAtStartup());
    return runtime;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records an authoritative error terminal event when bootstrap fails', async () => {
    const journal = createServerDiagnosticJournal();
    const runtime = await failedBootstrap({ overrides: { diagnosticJournal: journal } });

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.error', {
      totalDurationMs: expect.any(Number),
      outcome: 'error',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.ready',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
    expect(runtime.testState.lastOpenCodeError).toBe('listener unavailable');
    expect(runtime.testState.openCodeProcess).toBeNull();
    expect(journal.snapshot().events.map(({ action }) => action)).toContain('bootstrap failed');
  });

  it('keeps retrying a failed managed start at growing intervals', async () => {
    const runtime = await failedBootstrap();
    // Each run fails again without redoing the start; the schedule is what counts.
    const bootstrap = vi.fn(async () => {
      runtime.scheduleBootstrapRetry(bootstrap);
    });

    expect(runtime.scheduleBootstrapRetry(bootstrap)).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(bootstrap).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 60_000);
    expect(bootstrap).toHaveBeenCalledTimes(5);
  });

  it('makes a restart asked for during a retry wait for it and then really restart', async () => {
    const retryRun = Promise.withResolvers();
    // The bootstrap's two starts fail; the restart's start succeeds.
    const runtime = await failedBootstrap({ serviceOptions: { failures: 2 } });
    runtime.scheduleBootstrapRetry(() => retryRun.promise, vi.fn());
    await vi.advanceTimersByTimeAsync(5_000);

    const restart = runtime.restartOpenCode();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(2);

    retryRun.resolve();
    await restart;
    expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(3);
    expect(runtime.testState.openCodeProcess).toBe(runtime.service.started[0]);
  });

  it('waits for a restart in flight before retrying', async () => {
    const runtime = await failedBootstrap();
    const bootstrap = vi.fn(async () => {});
    runtime.scheduleBootstrapRetry(bootstrap, vi.fn());

    const restart = Promise.withResolvers();
    runtime.testState.currentRestartPromise = restart.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bootstrap).not.toHaveBeenCalled();

    runtime.testState.currentRestartPromise = null;
    restart.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when a restart has started the service before the retry fires', async () => {
    const runtime = await failedBootstrap();
    const bootstrap = vi.fn(async () => {});
    const onAlreadyRunning = vi.fn();
    runtime.scheduleBootstrapRetry(bootstrap, onAlreadyRunning);

    runtime.testState.openCodeProcess = { close: vi.fn() };
    await vi.advanceTimersByTimeAsync(5_000);

    expect(bootstrap).not.toHaveBeenCalled();
    expect(onAlreadyRunning).toHaveBeenCalledTimes(1);
  });

  it('keeps the last error readable while a retry runs', async () => {
    let errorSeenAtFirstStart;
    const startFailure = new Error('listener unavailable');
    const runtime = createRuntime({
      createServerProcess: vi.fn(async () => {
        errorSeenAtFirstStart ??= runtime.testState.lastOpenCodeError;
        throw startFailure;
      }),
    }, { lastOpenCodeError: 'earlier failure' }, env);

    await settle(runtime.bootstrapOpenCodeAtStartup());

    expect(errorSeenAtFirstStart).toBe('earlier failure');
    expect(runtime.testState.lastOpenCodeError).toBe(startFailure.message);
  });

  it('does not retry during a shutdown', async () => {
    const shuttingDown = await failedBootstrap({ stateOverrides: { isShuttingDown: true } });
    expect(shuttingDown.scheduleBootstrapRetry(vi.fn())).toBe(false);

    const runtime = await failedBootstrap();
    const bootstrap = vi.fn(async () => {});
    expect(runtime.scheduleBootstrapRetry(bootstrap)).toBe(true);
    runtime.testState.isShuttingDown = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe('health monitoring', () => {
  it('does not count rapid transport-triggered checks as independent health failures', async () => {
    const stub = stubProcess();
    let now = 1;
    unhealthyFetch();
    const runtime = createRuntime({ now: () => now }, {
      openCodePort: 45678,
      openCodeProcess: stub,
      isOpenCodeReady: true,
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(stub.close).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);

    now += 15_000;
    await runtime.triggerHealthCheck();

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('(2/20)'));
  });

  it.each([
    {
      name: 'timeout',
      expectedClass: 'timeout',
      fetchResult: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
    {
      name: 'connection refusal',
      expectedClass: 'connection_refused',
      fetchResult: () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:45678');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    },
    {
      name: 'invalid JSON',
      expectedClass: 'invalid_response',
      fetchResult: () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
  ])('classifies and stores a counted $name health failure', async ({ expectedClass, fetchResult }) => {
    globalThis.fetch = vi.fn(fetchResult);
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: stubProcess({ pid: process.pid }),
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: expectedClass,
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`class=${expectedClass}`));
  });

  it('counts a failed probe against a service that is still running instead of restarting it', async () => {
    const stub = stubProcess();
    unhealthyFetch();
    const runtime = createRuntime({}, { openCodePort: 45678, openCodeProcess: stub, isOpenCodeReady: true });

    await runtime.triggerHealthCheck();

    expect(stub.close).not.toHaveBeenCalled();
    expect(runtime.service.createServerProcess).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('(1/20)'));
  });

  describe('restart triggers', () => {
    // A failed check every 15 s, the interval a failure is counted at.
    const failChecks = async (runtime, clock, count) => {
      for (let index = 0; index < count; index += 1) {
        clock.now += 15_000;
        await runtime.triggerHealthCheck();
      }
    };

    it('restarts a service that exited without waiting for the failure interval', async () => {
      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      await runtime.service.crash(server, { exitCode: 1 });

      await runtime.triggerHealthCheck();

      expect(server.close).toHaveBeenCalledTimes(1);
      expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(2);
      expect(runtime.testState.openCodeProcess).toBe(runtime.service.started[1]);
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(runtime.testState.lastOpenCodeRestartDiagnostics.reason).toBe('immediate-process-exited');
    });

    it('calls onOpenCodeRestarted after a successful managed restart', async () => {
      const onOpenCodeRestarted = vi.fn();
      const runtime = createRuntime({ onOpenCodeRestarted });
      const server = await runtime.startOpenCode();
      await runtime.service.crash(server);

      await runtime.triggerHealthCheck();

      expect(server.close).toHaveBeenCalledTimes(1);
      expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(2);
      // The restart completed on a (possibly new) port: the event-stream
      // upstreams must rebind so the UI keeps receiving events (#2638).
      expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
    });

    it('restarts once the failure threshold is reached', async () => {
      const stub = stubProcess();
      const clock = { now: 1 };
      unhealthyFetch();
      const runtime = createRuntime({ now: () => clock.now }, {
        openCodePort: 45678,
        openCodeProcess: stub,
        isOpenCodeReady: true,
      });

      await failChecks(runtime, clock, 19);
      expect(stub.close).not.toHaveBeenCalled();

      await failChecks(runtime, clock, 1);
      expect(stub.close).toHaveBeenCalledTimes(1);
      expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(1);
      expect(runtime.testState.lastOpenCodeRestartDiagnostics).toMatchObject({
        reason: 'immediate-health-failure',
        healthFailure: { class: 'invalid_response', source: 'immediate' },
      });
    });

    it('holds a restart back while sessions are busy until the grace period has passed', async () => {
      const stub = stubProcess();
      const clock = { now: 1 };
      unhealthyFetch();
      const runtime = createRuntime({ now: () => clock.now, getActiveSessionCount: () => 2 }, {
        openCodePort: 45678,
        openCodeProcess: stub,
        isOpenCodeReady: true,
      });

      await failChecks(runtime, clock, 20);
      expect(stub.close).not.toHaveBeenCalled();

      clock.now += 120_000;
      await runtime.triggerHealthCheck();

      expect(stub.close).toHaveBeenCalledTimes(1);
      expect(runtime.testState.lastOpenCodeRestartDiagnostics).toMatchObject({
        reason: 'immediate-stale-busy-health-failure',
        busySessionCount: 2,
      });
    });
  });

  describe('restart diagnostics', () => {
    const restartAfterCrash = async (stderrTail) => {
      const runtime = createRuntime({}, {}, {}, { pid: 12345 });
      const server = await runtime.startOpenCode();
      await runtime.service.crash(server, { exitCode: 7, stderrTail });
      await runtime.triggerHealthCheck();
      return runtime;
    };

    it('retains the exited service and its bounded, redacted stderr across the restart', async () => {
      const runtime = await restartAfterCrash(
        `${'x'.repeat(40 * 1024)}\ntoken=runtime-secret\nruntime worker failed after startup\n`,
      );

      const diagnostics = runtime.testState.lastOpenCodeRestartDiagnostics;
      expect(diagnostics).toEqual({
        reason: 'immediate-process-exited',
        healthFailure: null,
        process: {
          pid: 12345,
          exitCode: 7,
          signalCode: null,
          stderrTail: expect.stringContaining('runtime worker failed after startup'),
          alive: false,
        },
        busySessionCount: 0,
        at: expect.any(String),
      });
      expect(Buffer.byteLength(diagnostics.process.stderrTail)).toBeLessThanOrEqual(32 * 1024);
      expect(diagnostics.process.stderrTail).not.toContain('runtime-secret');
      expect(runtime.testState.lastManagedOpenCodeProcess).toEqual({
        pid: 12345,
        exitCode: 7,
        signalCode: null,
        stderrTail: diagnostics.process.stderrTail,
      });
    });

    it('redacts Authorization scheme credentials from the stderr diagnostics', async () => {
      const runtime = await restartAfterCrash(
        'request rejected: Authorization: Basic dXNlcjpwYXNz\n'
        + 'authorization: basic bG93ZXI6Y2FzZQ==\n'
        + 'Authorization: Bearer fake-bearer-token-value\n'
        + 'falling back to basic health monitor\n'
        + 'runtime worker failed after startup\n',
      );

      const { stderrTail } = runtime.testState.lastOpenCodeRestartDiagnostics.process;
      expect(stderrTail).not.toContain('dXNlcjpwYXNz');
      expect(stderrTail).not.toContain('bG93ZXI6Y2FzZQ');
      expect(stderrTail).not.toContain('fake-bearer-token-value');
      expect(stderrTail).toContain('falling back to basic health monitor');
      expect(stderrTail).toContain('runtime worker failed after startup');
    });
  });

  describe('a restart that fails', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not call onOpenCodeRestarted and reports the failure', async () => {
      const onOpenCodeRestarted = vi.fn();
      const stub = stubProcess({ exitCode: 1 });
      const runtime = createRuntime(
        { onOpenCodeRestarted },
        { openCodePort: 45678, openCodeProcess: stub },
        { ENV_CONFIGURED_OPENCODE_PORT: 45678 },
        { failures: Infinity },
      );

      // triggerHealthCheck logs instead of rethrowing; call restartOpenCode
      // directly to observe the failure result.
      await expect(settle(runtime.restartOpenCode())).rejects.toThrow('listener unavailable');

      expect(stub.close).toHaveBeenCalledTimes(1);
      expect(onOpenCodeRestarted).not.toHaveBeenCalled();
      expect(runtime.testState.lastOpenCodeError).toBe('listener unavailable');
      expect(runtime.testState.openCodePort).toBeNull();
      expect(runtime.testState.openCodeProcess).toBeNull();
      expect(runtime.testState.currentRestartPromise).toBeNull();
      expect(runtime.testState.isRestartingOpenCode).toBe(false);
    });
  });
});

describe('restart with a task while stopped', () => {
  const runningRuntime = (order, overrides = {}) => {
    const runtime = createRuntime(overrides, {
      openCodePort: 45678,
      openCodeProcess: stubProcess({ close: vi.fn(async () => { order.push('close'); }) }),
    });
    const start = runtime.service.createServerProcess.getMockImplementation();
    runtime.service.createServerProcess.mockImplementation(async (options) => {
      order.push('start');
      return start(options);
    });
    return runtime;
  };

  it('runs the task between stopping and starting the service', async () => {
    const order = [];
    const runtime = runningRuntime(order);

    await runtime.restartOpenCode('opencode-upgrade', { whileStopped: async () => { order.push('task'); } });

    expect(order).toEqual(['close', 'task', 'start']);
  });

  it('starts the service again when the task fails, then reports the failure', async () => {
    const order = [];
    const runtime = runningRuntime(order);

    await expect(runtime.restartOpenCode('opencode-upgrade', {
      whileStopped: async () => { throw new Error('upgrade failed'); },
    })).rejects.toThrow('upgrade failed');

    expect(order).toEqual(['close', 'start']);
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(runtime.testState.lastOpenCodeError).toBeNull();
    expect(runtime.testState.openCodeProcess).toBe(runtime.service.started[0]);
  });
});

describe('readiness probing', () => {
  it('fails without a port', async () => {
    const runtime = createRuntime();

    await expect(runtime.waitForOpenCodeReady(100, 20)).rejects.toThrow('OpenCode port is not available');
  });

  it('marks the service ready once /api/info identifies it', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    Object.assign(runtime.testState, { isOpenCodeReady: false, lastOpenCodeError: 'earlier failure' });

    await runtime.waitForOpenCodeReady(500, 20);

    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(runtime.testState.lastOpenCodeError).toBeNull();
  });

  it('keeps probing until the service answers', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    let answers = 0;
    const answer = runtime.service.handlers['/api/info'];
    runtime.service.handlers['/api/info'] = () => (++answers < 3 ? { status: 503 } : answer());

    await runtime.waitForOpenCodeReady(2_000, 20);

    expect(answers).toBe(3);
    expect(runtime.testState.isOpenCodeReady).toBe(true);
  });

  it.each([
    { name: 'an error status', answer: () => ({ status: 503 }), message: 'OpenCode info endpoint responded with status 503' },
    { name: 'a payload without a version', answer: () => ({ body: {} }), message: 'The agent service did not identify itself.' },
  ])('rejects with the last error when the service answers with $name', async ({ answer, message }) => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    runtime.service.handlers['/api/info'] = answer;

    await expect(runtime.waitForOpenCodeReady(150, 30)).rejects.toThrow(message);

    expect(runtime.testState.lastOpenCodeError).toBe(message);
  });
});

describe('agent presence', () => {
  it.each([
    { shape: 'the { data } envelope', body: { location: {}, data: [{ id: 'plan' }, { id: 'build' }] } },
    { shape: 'a bare list', body: [{ id: 'build' }] },
  ])('resolves when the agent is in $shape', async ({ body }) => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    runtime.service.handlers['/api/agent'] = () => ({ body });

    await expect(runtime.waitForAgentPresence('build', 500, 20)).resolves.toBeUndefined();
  });

  it('polls until the agent appears', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    let answers = 0;
    runtime.service.handlers['/api/agent'] = () => ({ body: { data: ++answers < 3 ? [] : [{ id: 'build' }] } });

    await runtime.waitForAgentPresence('build', 2_000, 20);

    expect(answers).toBe(3);
  });

  it('rejects when the agent never appears', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();

    await expect(runtime.waitForAgentPresence('ghost', 150, 30)).rejects.toThrow(
      'Agent "ghost" not available after OpenCode restart',
    );
  });

  it('fails without a port', async () => {
    const runtime = createRuntime();

    await expect(runtime.waitForAgentPresence('build', 100, 20)).rejects.toThrow('OpenCode port is not available');
  });
});

describe('refreshing the agent after a config change', () => {
  it('asks the service to re-read its config once, waits for readiness and never restarts it', async () => {
    const order = [];
    const refreshAgentConfig = vi.fn(async () => { order.push('refresh'); });
    const runtime = createRuntime({ refreshAgentConfig });
    const server = await runtime.startOpenCode();
    const answerInfo = runtime.service.handlers['/api/info'];
    runtime.service.handlers['/api/info'] = () => {
      order.push('info');
      return answerInfo();
    };
    Object.assign(runtime.testState, { isOpenCodeReady: false, openCodeNotReadySince: 123 });

    const result = await runtime.refreshOpenCodeAfterConfigChange('settings-changed');

    expect(result).toEqual({ reloaded: true, external: false });
    expect(refreshAgentConfig).toHaveBeenCalledTimes(1);
    expect(refreshAgentConfig).toHaveBeenCalledWith('settings-changed');
    expect(order).toEqual(['refresh', 'info']);
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(runtime.testState.openCodeNotReadySince).toBe(0);
    // The service keeps running: nothing was stopped or started again.
    expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(1);
    expect(server.close).not.toHaveBeenCalled();
    expect(runtime.testState.openCodeProcess).toBe(server);
    expect(runtime.testState.lastOpenCodeRestartDiagnostics).toBeNull();
  });

  it('names a config-change reason when the caller gives none', async () => {
    const refreshAgentConfig = vi.fn(async () => {});
    const runtime = createRuntime({ refreshAgentConfig });
    await runtime.startOpenCode();

    await runtime.refreshOpenCodeAfterConfigChange(undefined);

    expect(refreshAgentConfig).toHaveBeenCalledWith('config-change');
  });

  it('waits for the named agent to be listed', async () => {
    const runtime = createRuntime();
    await runtime.startOpenCode();
    runtime.service.requests.length = 0;

    await runtime.refreshOpenCodeAfterConfigChange('agents-changed', { agentName: 'build' });

    expect(runtime.service.requests.map(({ path: route }) => route)).toEqual(['/api/info', '/api/agent']);
  });

  it('surfaces a failing refresh, marks the service not ready and probes nothing', async () => {
    const failure = new Error('could not re-read the config');
    const runtime = createRuntime({ refreshAgentConfig: vi.fn(async () => { throw failure; }) });
    const server = await runtime.startOpenCode();
    runtime.service.requests.length = 0;

    await expect(runtime.refreshOpenCodeAfterConfigChange('settings-changed')).rejects.toBe(failure);

    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(runtime.testState.openCodeNotReadySince).toBeGreaterThan(0);
    expect(runtime.service.requests).toEqual([]);
    expect(runtime.service.createServerProcess).toHaveBeenCalledTimes(1);
    expect(server.close).not.toHaveBeenCalled();
  });
});
