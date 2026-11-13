// MCP OAuth sign-in as the OpenCode dialect expects it: a remote server with
// OAuth is an integration with one `oauth` method, and the sign-in is the
// attempt flow `/api/integration/:id/connect/oauth` plus its status, complete
// and cancel routes.
//
// Pi has no attempt API: `pi mcp login <name>` opens the system browser, waits
// for its own loopback listener and stores the credential before it exits. So
// an attempt is one such process. Its first URL line becomes the attempt's
// `url`, its exit decides `complete` or `failed`, and a cancel kills the
// process. `paste: true` is advertised because the CLI's listener is on this
// machine, so a browser elsewhere cannot come back to it; the attempt still
// finishes through the CLI's own listener or not at all.

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { buildPiChildEnv, resolvePiRuntime } from '../launch.js';
import { resolvePiCliEntry, sanitizeOutput } from '../packages-cli.js';
import { WireError } from './errors.js';

const ATTEMPT_TTL_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 305_000;
const URL_LINE = /in your browser:\s*(\S+)/;
const OUTPUT_LIMIT = 8_000;

const integrationIdFor = (entry) => `mcp_${createHash('sha256').update(`${entry.name}\n${entry.url ?? ''}`).digest('hex').slice(0, 16)}`;

/** One remote MCP server with OAuth as OpenCode's integration entry. */
export const mcpIntegrationOf = (entry) => ({
  id: integrationIdFor(entry),
  name: entry.name,
  methods: [{ id: 'oauth', type: 'oauth', label: `Sign in with ${entry.name}` }],
  connections: [],
  metadata: { source: 'mcp' },
});

/**
 * Starts `pi mcp login`; the real one runs Pi's bundled CLI, and a test passes
 * its own. `onLine` receives each output line as it arrives.
 *
 * @param {{ spawnImpl?: typeof spawn, baseEnv?: () => Record<string, string|undefined> }} [options]
 * @returns {(serverName: string, directory: string|null, onLine: (line: string) => void) => { kill: () => void, result: Promise<{ code: number|null, stdout: string, stderr: string }> }}
 */
export const createPiLoginRunner = ({ spawnImpl = spawn, baseEnv = () => process.env } = {}) => (serverName, directory, onLine) => {
  const runtime = resolvePiRuntime();
  const child = spawnImpl(runtime.command, [resolvePiCliEntry(), 'mcp', 'login', serverName], {
    cwd: directory || undefined,
    env: buildPiChildEnv(baseEnv(), { ...runtime.env, NO_COLOR: '1', FORCE_COLOR: undefined }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  const read = (stream, append) => {
    let buffered = '';
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      append(chunk);
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        onLine(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
      }
    });
  };
  read(child.stdout, (chunk) => { stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); });
  read(child.stderr, (chunk) => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });

  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* already gone */ }
  };

  const result = new Promise((resolve) => {
    const timer = setTimeout(kill, LOGIN_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: sanitizeOutput(String(error?.message ?? error)) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { kill, result };
};

/**
 * @param {object} deps
 * @param {(directory: string|null) => Promise<object[]>} deps.listServers  The MCP servers of a folder, as `config-routes/mcp.js` lists them.
 * @param {ReturnType<typeof createPiLoginRunner>} deps.runLogin
 * @param {() => number} [deps.now]
 */
export const createMcpOAuth = ({ listServers, runLogin, now = () => Date.now() }) => {
  /** attemptID -> attempt */
  const attempts = new Map();

  const entriesOf = async (directory) => (await listServers(directory)).filter((entry) => entry.type === 'remote' && entry.oauth !== false);

  const integrations = async (directory) => (await entriesOf(directory)).map(mcpIntegrationOf);

  const integration = async (integrationID, directory) => {
    const found = (await entriesOf(directory)).find((entry) => integrationIdFor(entry) === integrationID);
    return found ? mcpIntegrationOf(found) : null;
  };

  const owns = (integrationID) => typeof integrationID === 'string' && integrationID.startsWith('mcp_');

  /** A login that cannot start is an answer, not a crash; a missing server is the caller's 404. */
  const statusOf = (attempt) => {
    if (attempt.state === 'pending' && now() > attempt.expires) {
      attempt.state = 'failed';
      attempt.message = 'The sign-in expired.';
      attempt.cancel?.();
    }
    return {
      attemptID: attempt.id,
      status: attempt.state,
      ...(attempt.message ? { message: attempt.message } : {}),
    };
  };

  const start = async ({ integrationID, directory }) => {
    const entry = (await entriesOf(directory)).find((candidate) => integrationIdFor(candidate) === integrationID);
    if (!entry) throw new WireError(404, 'IntegrationNotFoundError', `Integration not found: ${integrationID}`, { integrationID });
    const id = `att_${randomBytes(8).toString('hex')}`;
    const created = now();
    const attempt = {
      id,
      integrationID,
      serverName: entry.name,
      state: 'pending',
      url: '',
      instructions: `Finish signing in to ${entry.name} in your browser.`,
      created,
      expires: created + ATTEMPT_TTL_MS,
      cancel: null,
    };
    attempts.set(id, attempt);
    let login;
    try {
      login = runLogin(entry.name, directory, (line) => {
        const url = URL_LINE.exec(line)?.[1];
        if (url && !attempt.url) attempt.url = url;
      });
    } catch (error) {
      attempt.state = 'failed';
      attempt.message = sanitizeOutput(String(error?.message ?? error));
      return attemptOf(attempt);
    }
    attempt.cancel = login.kill;
    void login.result.then(({ code, stdout, stderr }) => {
      if (attempt.state !== 'pending') return;
      attempt.state = code === 0 ? 'complete' : 'failed';
      if (code !== 0) attempt.message = sanitizeOutput((stderr || stdout || 'The sign-in failed.').trim().split('\n').at(-1) ?? 'The sign-in failed.');
    });
    return attemptOf(attempt);
  };

  const attemptOf = (attempt) => ({
    attemptID: attempt.id,
    mode: 'auto',
    url: attempt.url,
    instructions: attempt.instructions,
    paste: true,
    time: { created: attempt.created, expires: attempt.expires },
  });

  const requireAttempt = (attemptID) => {
    const attempt = attempts.get(attemptID);
    if (!attempt) throw new WireError(404, 'OAuthAttemptNotFoundError', `OAuth attempt not found: ${attemptID}`, { attemptID });
    return attempt;
  };

  /** `paste` attempts take no code here: Pi's own listener receives the redirect. */
  const complete = (integrationID, attemptID) => {
    const attempt = requireAttempt(attemptID);
    if (attempt.integrationID !== integrationID) throw new WireError(404, 'OAuthAttemptNotFoundError', `OAuth attempt not found: ${attemptID}`, { attemptID });
  };

  const cancel = (integrationID, attemptID) => {
    const attempt = attempts.get(attemptID);
    if (!attempt || attempt.integrationID !== integrationID) return;
    attempt.cancel?.();
    attempt.cancel = null;
    attempt.state = 'failed';
    attempt.message = 'The sign-in was cancelled.';
  };

  const status = (integrationID, attemptID) => {
    const attempt = requireAttempt(attemptID);
    if (attempt.integrationID !== integrationID) throw new WireError(404, 'OAuthAttemptNotFoundError', `OAuth attempt not found: ${attemptID}`, { attemptID });
    return statusOf(attempt);
  };

  /** Sessions and the bridge going away stop every login that still runs. */
  const close = () => {
    for (const attempt of attempts.values()) attempt.cancel?.();
    attempts.clear();
  };

  return { integrations, integration, owns, start, status, complete, cancel, close };
};
