// Runs Pi's own CLI (`pi install`, `pi remove`, `pi update`) from the server.
//
// The CLI is Pi's bundled entry, resolved from the package next to the RPC
// entry, so `pi` need not be on PATH. It runs on the runtime `resolvePiRuntime`
// picks, without a shell, with stdin closed (a package command that finds a
// terminal may ask a question nobody can answer), a bounded copy of its output
// and a timeout that ends the whole process group (npm and git are Pi's children).

import { spawn } from 'node:child_process';
import path from 'node:path';

import { buildPiChildEnv, resolvePiRpcEntry, resolvePiRuntime } from './launch.js';
import { maskCredentials } from './packages-sources.js';

const MAX_OUTPUT_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const DRAIN_MS = 300;
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** Pi's CLI bundle: `cli.js` sits beside the `rpc-entry.js` the package exports. */
export const resolvePiCliEntry = () => path.join(path.dirname(resolvePiRpcEntry()), 'cli.js');

/**
 * Text that came from a child process or a URL, made safe to show or log:
 * colour codes out, credentials in URLs and npm auth settings masked.
 */
export const sanitizeOutput = (text) => maskCredentials(String(text ?? '').replace(ANSI, ''))
  .replace(/(_authToken|_auth|_password)\s*=\s*\S+/gi, '$1=***')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');

const tailOf = (text) => (text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text);

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.baseEnv]  The environment Pi inherits.
 * @param {typeof resolvePiRuntime} [options.resolveRuntime]
 * @param {() => string} [options.resolveEntry]
 * @param {typeof spawn} [options.spawnImpl]
 * @returns {(args: string[], options: { cwd: string, env?: Record<string, string|undefined>, timeoutMs?: number }) => Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean }>}
 *   Resolves with the outcome of a process that ran; rejects only when it could not start.
 */
export const createPiCliRunner = ({
  baseEnv = process.env,
  resolveRuntime = resolvePiRuntime,
  resolveEntry = resolvePiCliEntry,
  spawnImpl = spawn,
} = {}) => (args, { cwd, env = {}, timeoutMs = 180_000 }) => new Promise((resolve, reject) => {
  const runtime = resolveRuntime();
  const detached = process.platform !== 'win32';
  const child = spawnImpl(runtime.command, [resolveEntry(), ...args], {
    cwd,
    env: buildPiChildEnv(baseEnv, { ...runtime.env, NO_COLOR: '1', FORCE_COLOR: undefined, ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let killTimer = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = tailOf(stdout + chunk); });
  child.stderr.on('data', (chunk) => { stderr = tailOf(stderr + chunk); });

  const signalTree = (signal) => {
    try {
      if (detached && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    signalTree('SIGTERM');
    killTimer = setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS);
  }, timeoutMs);

  let settled = false;
  let drainTimer = null;
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(drainTimer);
    // After a timeout the group kill stays armed for anything that ignored SIGTERM.
    if (!timedOut) clearTimeout(killTimer);
    child.stdout.destroy();
    child.stderr.destroy();
    resolve({ code, signal, stdout: sanitizeOutput(stdout), stderr: sanitizeOutput(stderr), timedOut });
  };

  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    reject(error);
  });
  // The process is done when it exits. Its pipes normally close at once; one a
  // leftover child (an install script's daemon) still holds must not keep the
  // call, and the settings queue behind it, waiting.
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    drainTimer = setTimeout(() => finish(code, signal), DRAIN_MS);
  });
  child.once('close', finish);
});
