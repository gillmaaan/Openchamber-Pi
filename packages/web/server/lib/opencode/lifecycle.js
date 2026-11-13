import { readOpenCodeInfo } from './compatibility.js';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import net from 'node:net';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv } from '../inherited-env.js';
import { assignInjectedEnv } from '../injected-env.js';
import { applyProviderEnvAliases } from './provider-env-aliases.js';
import { overlayEnvironment } from '../environment/variables.js';
import { recordStartupPerformance } from './startup-performance.js';
import { hasChildProcessExited } from './managed-process-stop.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEALTH_CHECK_TIMEOUT_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000);
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0);
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
const BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const OPENCODE_HEALTH_PATH = '/api/info';
const OPENCODE_REQUIRED_MAJOR_VERSION = 2;

/**
 * OpenChamber talks to OpenCode 2.x only. v1 serves its routes without the
 * `/api` prefix, publishes a different event vocabulary and has no `plugins`
 * config key, so an older binary fails in a hundred small ways instead of one
 * clear one.
 *
 * The version comes from the health payload rather than from `opencode
 * --version`: it costs no extra process, and it also covers an external
 * OpenCode the user started themselves. `/api/info` only exists in 2.x (2.0.8
 * removed the older `/api/health`), so a 404 there is the same answer by
 * another route. A 200 is the readiness signal; the payload has no `healthy`
 * field, only `{ version, pid, urls, paths }`.
 */
const OPENCODE_VERSION_REQUIREMENT_DETAIL =
  `OpenChamber requires OpenCode ${OPENCODE_REQUIRED_MAJOR_VERSION}.x`;

const classifyOpenCodeVersion = (version) => {
  if (typeof version !== 'string') return { ok: true };
  const match = version.match(/v?(\d+)\./);
  if (!match) return { ok: true };
  if (Number(match[1]) >= OPENCODE_REQUIRED_MAJOR_VERSION) return { ok: true };
  return {
    ok: false,
    detail: `${OPENCODE_VERSION_REQUIREMENT_DETAIL}, found ${version.trim()}. Update OpenCode and start OpenChamber again.`,
  };
};
// Only the directory the user will open anyway. On OpenCode 2 the first
// directory-scoped read boots that location's whole MCP fleet, so warming
// other projects "just in case" started processes nobody asked for (#4018).
const WARMUP_DIRECTORY_LIMIT = 1;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;
const MANAGED_STDERR_TAIL_MAX_BYTES = 32 * 1024;
const HEALTH_FAILURE_DETAIL_MAX_LENGTH = 256;

const getBoundedTextTail = (value, maxBytes) => {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.byteLength <= maxBytes) return buffer.toString();
  return buffer.subarray(buffer.byteLength - maxBytes).toString();
};

const sanitizeDiagnosticText = (value) => String(value ?? '')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
  // Unquoted `Authorization: <scheme> <credential>` values must be handled
  // before the generic key/value rule below: that rule stops at whitespace, so
  // it would redact only the scheme word and leave the credential intact.
  // Scoped to authorization-style keys so ordinary prose using "basic" or
  // "token" is not mangled.
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}authorization[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*(?:"|')?(?:basic|bearer|token)\s+)[^\s,;"']+/gim,
    '$1$2[redacted]',
  )
  .replace(/([?&][^=&#\s]*(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[^=&#\s]*=)[^&#\s]+/gi, '$1[redacted]')
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gim,
    '$1$2[redacted]',
  );

const getHealthFailureDetail = (error) => {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'Unknown error');
  return sanitizeDiagnosticText(`${name}: ${message}`).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH);
};

const classifyHealthProbeError = (error) => {
  const name = String(error?.name || '');
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  const normalizedMessage = message.toLowerCase();

  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || normalizedMessage.includes('the operation was aborted')
    || normalizedMessage.includes('abortsignal.timeout')
  ) {
    return { class: 'timeout', detail: getHealthFailureDetail(error) };
  }
  if (code === 'ECONNREFUSED' || normalizedMessage.includes('econnrefused')) {
    return { class: 'connection_refused', detail: getHealthFailureDetail(error) };
  }
  if (
    code === 'ECONNRESET'
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('socket hang up')
  ) {
    return { class: 'connection_reset', detail: getHealthFailureDetail(error) };
  }
  return { class: 'error', detail: getHealthFailureDetail(error) };
};

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    ensureLocalOpenCodeServerPassword,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOpenCodeEnv = async () => ({}),
    // Variables from Settings and `opencode service set env` (lib/environment).
    getUserEnvironment = () => ({}),
    getActiveSessionCount = () => 0,
    getWarmupDirectories = async () => [],
    // Scopes server-side reads while no project directory is usable (the
    // managed chats root). Without it they name no directory, and OpenCode
    // starts a location over its own working directory, the whole home.
    noProjectDirectory = null,
    onOpenCodeRestarted = null,
    managedStartupTimeoutMs = 30_000,
    now = Date.now,
    // Re-reads what a running agent loaded at start (settings, models, extensions) after a config change.
    refreshAgentConfig = async () => {},
    // Starts what answers on the managed port: `({ hostname, port, password, env, cwd }) => Promise<{ url, close }>`.
    createServerProcess,
    diagnosticJournal = serverDiagnosticJournal,
  } = deps;

  // The environment the managed OpenCode was launched with. Keys OpenCode
  // takes from environment variables are never stored in it, so this is the
  // only place their values can be read back (see auth.js).
  let managedProcessEnv = null;

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const snapshotManagedOpenCodeProcess = (child = state.openCodeProcess) => {
    if (!child) return null;
    const snapshot = {
      pid: child.pid || null,
      exitCode: child.exitCode ?? null,
      signalCode: child.signalCode ?? null,
      stderrTail: getBoundedTextTail(
        sanitizeDiagnosticText(child.stderrTail ?? ''),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      ),
    };
    state.lastManagedOpenCodeProcess = snapshot;
    return snapshot;
  };

  const captureRestartDiagnostics = (reason) => {
    const processSnapshot = snapshotManagedOpenCodeProcess();
    const diagnostics = {
      reason: sanitizeDiagnosticText(String(reason || 'managed-restart')).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH),
      healthFailure: state.lastOpenCodeHealthFailure ? { ...state.lastOpenCodeHealthFailure } : null,
      process: processSnapshot
        ? { ...processSnapshot, alive: isManagedOpenCodeProcessAlive() }
        : null,
      busySessionCount: getActiveSessionCount(),
      at: new Date(now()).toISOString(),
    };
    state.lastOpenCodeRestartDiagnostics = diagnostics;
    console.warn('[lifecycle] managed OpenCode restart diagnostics', diagnostics);
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const probeOpenCodeHealthDetailed = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return {
        healthy: false,
        failure: {
          class: 'error',
          detail: 'Managed OpenCode process or port is unavailable',
        },
      };
    }

    try {
      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: response.status === 404
              ? `${OPENCODE_VERSION_REQUIREMENT_DETAIL}: this server has no /api/info, which every 2.x server serves.`
              : `Info endpoint returned HTTP ${response.status ?? 'unknown'}`,
          },
        };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Info endpoint returned invalid JSON',
          },
        };
      }
      const version = classifyOpenCodeVersion(body?.version);
      if (!version.ok) {
        return {
          healthy: false,
          failure: { class: 'invalid_response', detail: version.detail },
        };
      }
      return { healthy: true, failure: null };
    } catch (error) {
      return {
        healthy: false,
        failure: classifyHealthProbeError(error),
      };
    }
  };

  const isOpenCodeProcessHealthy = async () => (await probeOpenCodeHealthDetailed()).healthy;

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  let lastBootstrapError = null;
  let bootstrapRetryCount = 0;
  let bootstrapRetryRun = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async (attempt) => {
    const attemptStartedAt = performance.now();
    let phaseStartedAt = attemptStartedAt;
    recordStartupPerformance('opencode.attempt.start', { attempt });
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    let envPath = process.env.PATH;
    if (typeof buildManagedOpenCodePath === 'function') {
      envPath = buildManagedOpenCodePath();
    } else if (typeof buildAugmentedPath === 'function') {
      envPath = buildAugmentedPath();
    }
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    const managedOpenCodeEnv = await getManagedOpenCodeEnv();
    recordStartupPerformance('opencode.environment.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();

    // The user's variables go over the inherited environment (a PATH entry
    // in front of the managed PATH) and under everything OpenChamber itself
    // sets for OpenCode.
    const inheritedEnv = overlayEnvironment({ ...shellEnv, ...process.env, PATH: envPath }, getUserEnvironment());

    // What OpenChamber sets is recorded as injected, so a shell the agent
    // opens can tell it from the user's own variables. The bridge's password is
    // not in it: no agent process, and none of its shell commands, gets it.
    const processEnv = stripAppImageLauncherEnv(stripAppImageArgv0Leak(applyProviderEnvAliases(assignInjectedEnv(
      { ...inheritedEnv },
      {
        ...managedOpenCodeEnv,
        PATH: inheritedEnv.PATH,
      },
    ))));
    managedProcessEnv = processEnv;

    let serverInstance;
    try {
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      serverInstance = await createServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        password: openCodePassword,
        env: processEnv,
        cwd: state.openCodeWorkingDirectory,
      });
      // In-process: no pid to signal, nothing a port kill may stop.
      state.openCodeProcess = serverInstance;
      syncToHmrState();

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }
      recordStartupPerformance('opencode.process.ready', {
        attempt,
        durationMs: performance.now() - phaseStartedAt,
        totalDurationMs: performance.now() - attemptStartedAt,
      });
      phaseStartedAt = performance.now();

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      const ready = await waitForReady(serverInstance.url, 10000);
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      if (ready) {
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        diagnosticJournal.record('managed ready', { attempt });
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        recordStartupPerformance('opencode.health.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
          outcome: 'ready',
        });

        return serverInstance;
      }

      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      diagnosticJournal.record('managed startup failed', { attempt });
      await serverInstance?.close();
      if (serverInstance && state.openCodeProcess === serverInstance) state.openCodeProcess = null;
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      syncToHmrState();
      recordStartupPerformance('opencode.attempt.error', {
        attempt,
        totalDurationMs: performance.now() - attemptStartedAt,
        outcome: 'error',
      });
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce(attempt);
      } catch (error) {
        lastError = error;
        if (state.isShuttingDown) {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  // `whileStopped` runs after the managed process has exited and before the
  // new one starts. Its failure is reported after the restart, so the server
  // comes back either way.
  const restartOpenCode = async (reason = 'managed-restart', { whileStopped } = {}) => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      if (!whileStopped) {
        await state.currentRestartPromise;
        return;
      }
      // A restart already in flight never ran this task; restart once more for it.
      await state.currentRestartPromise.catch(() => {});
      if (state.isShuttingDown) return;
    }
    // A startup retry in flight may have read the state this restart is for,
    // and two starts at once would orphan a process: wait, then really restart.
    while (bootstrapRetryRun) await bootstrapRetryRun;
    if (state.isShuttingDown) return;

    let whileStoppedError = null;
    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      diagnosticJournal.record('managed restart started');
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      captureRestartDiagnostics(reason);

      if (state.openCodeProcess) {
        console.log('Stopping existing OpenCode process...');
        try {
          await state.openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        state.openCodeProcess = null;
        syncToHmrState();
      }

      if (whileStopped) {
        try {
          await whileStopped();
        } catch (error) {
          whileStoppedError = error;
        }
      }

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode();
      diagnosticJournal.record('managed restart ready');
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }

      // The restart lands on a new port. Upstream event readers pinned to the
      // old one would keep the UI silent forever, so rebind them to the
      // current port. Best effort: a failure here must not fail the restart
      // itself.
      try {
        onOpenCodeRestarted?.();
      } catch (error) {
        console.warn('Failed to rebind event stream after OpenCode restart:', error?.message ?? error);
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      diagnosticJournal.record('managed restart failed');
      console.error(`Failed to restart OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      if (!env.ENV_EFFECTIVE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
    if (whileStoppedError) throw whileStoppedError;
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
          lastError = new Error(`OpenCode info endpoint responded with status ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        const info = await readOpenCodeInfo(response);
        if (!info) throw new Error('The agent service did not identify itself.');
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
        const scopedDirectory = getValidatedDefaultDirectory();
        if (scopedDirectory) headers['x-opencode-directory'] = encodeURIComponent(scopedDirectory);
        const response = await fetch(buildOpenCodeUrl('/api/agent'), { method: 'GET', headers });

        if (response.ok) {
          // OpenCode 2.x answers `/api/*` with `{ location, data }`.
          const body = await response.json();
          const agents = Array.isArray(body) ? body : body?.data;
          if (Array.isArray(agents) && agents.some((agent) => agent?.id === agentName)) {
            return;
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  /**
   * A change to what an agent reads at start (settings, models, extensions).
   * Running turns are left alone: the idle processes stop and the next prompt
   * starts one that has the change. Answers `{ reloaded: true, external: false }`.
   */
  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing the agent after ${reason}`);
    try {
      await refreshAgentConfig(reason || 'config-change');
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
      if (agentName) await waitForAgentPresence(agentName);
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh the agent after ${reason}:`, error.message);
      throw error;
    }

    return { reloaded: true, external: false };
  };

  const bootstrapOpenCodeAtStartup = async () => {
    const bootstrapStartedAt = performance.now();
    let bootstrapError = null;
    recordStartupPerformance('opencode.bootstrap.start');
    try {
      if (env.ENV_EFFECTIVE_PORT) {
        console.log(`Using the agent service port from the environment: ${env.ENV_EFFECTIVE_PORT}`);
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      // The last error stays readable until a start succeeds or fails anew:
      // the UI shows it while a retry runs.
      state.openCodeProcess = await startOpenCode();
      syncToHmrState();
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        bootstrapError = error;
        state.isOpenCodeReady = false;
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      bootstrapError = error;
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
    lastBootstrapError = bootstrapError;
    diagnosticJournal.record(bootstrapError ? 'bootstrap failed' : 'bootstrap ready');
    recordStartupPerformance(
      bootstrapError ? 'opencode.bootstrap.error' : 'opencode.bootstrap.ready',
      {
        totalDurationMs: performance.now() - bootstrapStartedAt,
        outcome: bootstrapError ? 'error' : 'ready',
      },
    );
    if (!bootstrapError) {
      bootstrapRetryCount = 0;
      void warmOpenCodeDirectories();
    }
  };

  const runBootstrapRetry = async (bootstrap, onAlreadyRunning) => {
    while (state.currentRestartPromise) await state.currentRestartPromise.catch(() => {});
    if (state.isShuttingDown) return;
    // A restart got there first. Starting again would orphan its process.
    if (state.openCodeProcess) {
      lastBootstrapError = null;
      onAlreadyRunning();
      return;
    }
    bootstrapRetryRun = bootstrap()
      .catch((error) => console.error(`OpenCode startup retry failed: ${error?.message ?? error}`))
      .finally(() => {
        bootstrapRetryRun = null;
      });
  };

  /**
   * Runs `bootstrap` again later when the last bootstrap left no managed
   * OpenCode. Nothing else would start one: the health monitor only watches a
   * running process. `onAlreadyRunning` replaces that run when a restart has
   * started OpenCode by then. Answers whether a retry is scheduled.
   */
  const scheduleBootstrapRetry = (bootstrap, onAlreadyRunning) => {
    if (
      !lastBootstrapError
      || state.openCodeProcess
      || state.isShuttingDown
    ) {
      return false;
    }
    const delayMs = BOOTSTRAP_RETRY_DELAYS_MS[Math.min(bootstrapRetryCount, BOOTSTRAP_RETRY_DELAYS_MS.length - 1)];
    bootstrapRetryCount += 1;
    console.log(`Retrying OpenCode startup in ${delayMs / 1000}s...`);
    setTimeout(() => void runBootstrapRetry(bootstrap, onAlreadyRunning), delayMs).unref?.();
    return true;
  };

  // The directory server-side reads use when they have none of their own: the
  // one warmed at startup, which OpenCode is running anyway. v2 answers a
  // location read without a directory for its own working directory (the
  // user's home for a managed OpenCode) and starts it, MCP servers included.
  //
  // It is a cache of the directory warmed at startup, but that directory can
  // stop being usable while the server keeps running: the user deletes or
  // moves the project, the path is replaced by a regular file, or its
  // permissions change. Handing that stale path to OpenCode makes every
  // directory-scoped read answer `500 FileSystem.realPath ... ENOENT`, which
  // is an avoidable failure of reads that are not about the directory at all
  // (the integration list behind quota credentials, the small model's model
  // list). The getter therefore revalidates on each read and, when the cached
  // path is no longer usable, advances to another directory the warm pass
  // validated and re-reads the settings-backed warmup source so the
  // currently-valid `lastDirectory` replaces the stale one. Only a usable
  // directory is ever sent; a valid directory still scopes the read, which
  // keeps OpenCode from booting its working directory + MCP fleet.
  let defaultOpenCodeDirectory = null;
  // The directories the last warm pass (or a later refresh) found usable,
  // kept so a stale default can fall back synchronously without another
  // settings read.
  let warmedOpenCodeDirectories = [];
  let defaultDirectoryRefresh = null;
  let defaultDirectoryRefreshAt = 0;
  // A stale default is normal once and persistent when the user has no usable
  // directory at all; the cooldown keeps that state from turning every read
  // (small-model generations can be frequent) into a settings read.
  const DEFAULT_DIRECTORY_REFRESH_COOLDOWN_MS = 5000;

  const isUsableDirectory = (directory) => {
    if (!directory) return false;
    try {
      // `stat`/`access` reject a non-path value on their own, so the caller
      // only needs to rule out an empty hint; a throw lands in the catch.
      if (!statSync(directory).isDirectory()) return false;
      // A directory whose read/execute bit is gone is not a directory scoped
      // reads can use; OpenCode answers `500 FileSystem.realPath` for it just
      // like the missing-path case, so treat it the same.
      accessSync(directory, fsConstants.R_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const usableDirectories = (directories) => (
    Array.isArray(directories) ? directories.filter((directory) => isUsableDirectory(directory)) : []
  );

  // The first directory that is usable *right now*, revalidating each
  // candidate because the warmed list was validated only at warm time.
  const selectUsableDirectory = (directories) => usableDirectories(directories)[0] || null;

  // Re-reads the settings-backed warmup source when the cached default is no
  // longer usable, so a directory valid now (`lastDirectory` after a move, a
  // surviving project) replaces the stale one. Coalesced: concurrent reads
  // trigger at most one refresh.
  const refreshDefaultDirectories = () => {
    if (defaultDirectoryRefresh) return defaultDirectoryRefresh;
    defaultDirectoryRefresh = (async () => {
      try {
        const directories = await getWarmupDirectories();
        warmedOpenCodeDirectories = usableDirectories(directories);
        const usable = selectUsableDirectory(warmedOpenCodeDirectories);
        if (usable) defaultOpenCodeDirectory = usable;
      } catch {
        // Best-effort: the caller falls back to the no-project directory or
        // OpenCode's working directory for this read, and the refresh can
        // succeed next time.
      } finally {
        defaultDirectoryRefresh = null;
      }
    })();
    return defaultDirectoryRefresh;
  };

  // The warmed directory only while it is still usable; otherwise another
  // usable directory (from this or a refreshed pass), else the no-project
  // directory, else null so the caller sends no directory and OpenCode uses
  // its own working directory.
  const getValidatedDefaultDirectory = () => {
    if (isUsableDirectory(defaultOpenCodeDirectory)) return defaultOpenCodeDirectory;
    const alternate = selectUsableDirectory(warmedOpenCodeDirectories);
    if (alternate) {
      defaultOpenCodeDirectory = alternate;
      return alternate;
    }
    const checkedAt = now();
    if (!defaultDirectoryRefresh && checkedAt - defaultDirectoryRefreshAt >= DEFAULT_DIRECTORY_REFRESH_COOLDOWN_MS) {
      defaultDirectoryRefreshAt = checkedAt;
      void refreshDefaultDirectories();
    }
    return isUsableDirectory(noProjectDirectory) ? noProjectDirectory : null;
  };

  // OpenCode initializes each project directory lazily on its first
  // directory-scoped request, and that initialization takes seconds on large
  // session stores. Without warming, the user's first session open pays it
  // interactively (the chat waits on the message fetch until the directory
  // finishes initializing). Warm the last-used directory right after
  // readiness so the work overlaps UI startup instead. Sequential and
  // best-effort: a failed or slow directory never blocks the others for long,
  // and a restart invalidates the pass via the port/readiness guard.
  const warmOpenCodeDirectories = async () => {
    let directories = [];
    try {
      directories = await getWarmupDirectories();
    } catch {
      return;
    }
    if (!Array.isArray(directories) || directories.length === 0) return;
    warmedOpenCodeDirectories = usableDirectories(directories);
    defaultOpenCodeDirectory = warmedOpenCodeDirectories[0] || null;

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (typeof directory !== 'string' || !directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        // Warming a directory is the point, not the answer: any read that goes
        // through v2's location middleware makes OpenCode initialise it.
        // `/api/location` is the cheapest; `/api/session` is a global list and
        // warms nothing. v2 takes the directory from this header, not from a
        // `?directory=` query.
        const url = buildOpenCodeUrl('/api/location', '');
        await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-opencode-directory': encodeURIComponent(directory),
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });
      } catch {
        // Best-effort — the directory stays lazy and the UI's own request warms it.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * Forces restart if sessions stay "busy" and the server stays unhealthy
   * for over 2 minutes (staleness guard against stuck session state).
   */
  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let lastCountedHealthFailureAt = 0;
  let healthProbePromise = null;
  let healthCheckCyclePromise = null;
  let lastHealthProbeResult = null;
  let healthFailureCountIntervalMs = 15_000;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
    lastCountedHealthFailureAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const checkedAt = now();
    if (lastHealthProbeResult && checkedAt - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = probeOpenCodeHealthDetailed()
      .then((result) => {
        lastHealthProbeResult = { at: now(), ...result };
        return lastHealthProbeResult;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: false };
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return { skip: true, staleBusy: false };
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: true };
    }

    return { skip: true, staleBusy: false };
  };

  const runHealthCheckCycle = async (source) => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthResult = await probeOpenCodeHealth();
      if (!healthResult.healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode(`${source}-process-exited`);
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        const healthFailure = healthResult.failure || {
          class: 'error',
          detail: 'Health check failed without diagnostic detail',
        };
        state.lastOpenCodeHealthFailure = {
          class: healthFailure.class,
          detail: healthFailure.detail,
          at: new Date(checkedAt).toISOString(),
          source,
        };
        diagnosticJournal.record('health failed', { failureClass: healthFailure.class });
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES}) class=${healthFailure.class}`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        const busyDecision = shouldSkipRestartForBusySessions();
        if (busyDecision.skip) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode(
          busyDecision.staleBusy
            ? `${source}-stale-busy-health-failure`
            : `${source}-health-failure`,
        );
      } else {
        if (consecutiveHealthFailures) diagnosticJournal.record('health recovered');
        resetHealthFailureState();
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;
    healthFailureCountIntervalMs = effectiveIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, effectiveIntervalMs);
  };

  return {
    /** The managed OpenCode's launch environment; null for an external OpenCode or before the first launch. */
    getManagedOpenCodeProcessEnv: () => managedProcessEnv,
    /** The directory to scope a server-side OpenCode read that has none, or null once none is usable. */
    getDefaultOpenCodeDirectory: () => getValidatedDefaultDirectory(),
    /**
     * The UI saved the directory it now works in. That directory is running
     * already, so reads without a directory of their own go there: the one
     * used last at startup may be a chat the user has left, and the UI stops
     * a left chat's OpenCode location, which such a read would start again.
     */
    noteCurrentDirectory: (directory) => {
      if (!isUsableDirectory(directory)) return;
      defaultOpenCodeDirectory = directory;
      warmedOpenCodeDirectories = [directory, ...warmedOpenCodeDirectories.filter((entry) => entry !== directory)];
    },
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    scheduleBootstrapRetry,
    startHealthMonitoring,
    triggerHealthCheck,
  };
};
