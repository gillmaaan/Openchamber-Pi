// A client for one `pi --mode rpc` child process.
//
// Pi speaks JSONL over stdio: one JSON object per LF-terminated line, commands
// in on stdin, responses and events out on stdout. This file owns the framing
// and the request/response bookkeeping, nothing about sessions or OpenCode.
//
// Pi's own `RpcClient` is not used: it hard-codes `node`, sleeps 100 ms after
// spawn, mirrors the child's stderr into ours, and cannot answer an
// `extension_ui_request`.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 1_000;

export class PiRpcError extends Error {
  constructor(message, { command = null, code = 'rpc_error', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PiRpcError';
    this.command = command;
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.command  Executable to spawn.
 * @param {string[]} options.args
 * @param {string} options.cwd      The project directory; Pi has no `--cwd` flag.
 * @param {Record<string,string|undefined>} options.env  The child's whole environment.
 * @param {(event: object) => void} [options.onEvent]
 * @param {(request: object) => void} [options.onUiRequest]  `extension_ui_request` records.
 * @param {(chunk: string) => void} [options.onStderr]
 * @param {(info: { code: number|null, signal: string|null }) => void} [options.onExit]
 * @param {number} [options.requestTimeoutMs]
 * @param {typeof spawn} [options.spawnImpl]
 */
export const createPiRpcClient = ({
  command,
  args,
  cwd,
  env,
  onEvent = () => {},
  onUiRequest = () => {},
  onStderr = () => {},
  onExit = () => {},
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnImpl = spawn,
}) => {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  let nextId = 1;
  let exitInfo = null;
  let stdoutBuffer = '';
  const stdoutDecoder = new StringDecoder('utf8');

  // A stalled write end must not crash the server: the exit handler reports it.
  child.stdin?.on('error', () => {});

  const exited = new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      exitInfo = { code, signal };
      const message = `Pi exited before answering (${signal ? `signal ${signal}` : `code ${code}`}).`;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new PiRpcError(message, { command: entry.command, code: 'process_exited' }));
      }
      pending.clear();
      try { onExit(exitInfo); } catch { /* an exit listener must not throw into the stream */ }
      resolve(exitInfo);
    };
    child.once('exit', finish);
    child.once('error', (cause) => {
      if (exitInfo) return;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new PiRpcError(`Pi could not start: ${cause.message}`, { command: entry.command, code: 'spawn_failed', cause }));
      }
      pending.clear();
      finish(null, null);
    });
  });

  const handleLine = (line) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      // stdout is protocol-only; anything else is noise worth a diagnostic.
      onStderr(`[pi stdout] ${text.slice(0, 500)}\n`);
      return;
    }
    if (record === null || typeof record !== 'object') return;

    if (record.type === 'response') {
      const entry = typeof record.id === 'string' ? pending.get(record.id) : undefined;
      if (!entry) return;
      pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success === false) {
        entry.reject(new PiRpcError(String(record.error ?? 'Pi rejected the command.'), { command: entry.command, code: 'command_failed' }));
      } else {
        entry.resolve(record.data);
      }
      return;
    }

    if (record.type === 'extension_ui_request') {
      onUiRequest(record);
      return;
    }
    onEvent(record);
  };

  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    // Split on LF only. `readline` also splits on U+2028/U+2029, which are
    // legal inside a JSON string.
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      handleLine(line);
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk) => onStderr(chunk.toString()));

  const write = (record) => new Promise((resolve, reject) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || exitInfo) {
      reject(new PiRpcError('Pi is not running.', { code: 'process_exited' }));
      return;
    }
    stdin.write(`${JSON.stringify(record)}\n`, (error) => (error ? reject(error) : resolve()));
  });

  /** Send a command and resolve with the response's `data`. */
  // `id` lets a caller name its request, so the events that carry the id
  // (`bash_execution_update`) can be told apart when commands run side by side.
  const request = (type, fields = {}, { timeoutMs = requestTimeoutMs, id: requestedId } = {}) => {
    const id = requestedId ?? `r${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new PiRpcError(`Pi did not answer ${type} within ${timeoutMs} ms.`, { command: type, code: 'timeout' }));
        }, timeoutMs)
        : null;
      pending.set(id, { resolve, reject, timer, command: type });
      write({ ...fields, id, type }).catch((error) => {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof PiRpcError ? error : new PiRpcError(error.message, { command: type, code: 'write_failed', cause: error }));
      });
    });
  };

  /** Answer an `extension_ui_request`. Pi sends no response record for this. */
  const respondUi = (id, payload) => write({ ...payload, type: 'extension_ui_response', id });

  const kill = (signal = 'SIGKILL') => {
    if (exitInfo) return;
    try { child.kill(signal); } catch { /* already gone */ }
  };

  /** Close stdin so Pi disposes its runtime, then escalate to SIGTERM and SIGKILL. */
  const close = async ({ graceMs = DEFAULT_CLOSE_GRACE_MS } = {}) => {
    if (exitInfo) return exitInfo;
    try { child.stdin?.end(); } catch { /* ignore */ }
    const winner = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs, null))]);
    if (winner) return winner;
    kill('SIGTERM');
    const afterTerm = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS, null))]);
    if (afterTerm) return afterTerm;
    kill('SIGKILL');
    return exited;
  };

  return {
    pid: child.pid ?? null,
    request,
    respondUi,
    close,
    kill,
    exited,
    get isRunning() { return !exitInfo; },
  };
};
