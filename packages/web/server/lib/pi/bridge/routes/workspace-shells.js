// User shell commands (`POST /api/session/:id/shell`), the list of running
// commands (`GET /api/shell`, `/api/shell/:id`, `/api/shell/:id/output`,
// `DELETE /api/shell/:id`) and the job list (`GET /api/experimental/job`).
//
// How a command runs: through Pi's own RPC `bash` command on the session's live
// child (`host.request(session, 'bash', ...)`). Pi runs it in the session's
// folder with its shell settings and `user_bash` extension handlers, records it
// in the session file as a `bashExecution` entry (which `wire/transcript.js`
// already maps to the stored `shell` message) and hands it to the model with the
// next prompt, so the agent learns about the command the way OpenCode's
// synthetic note does, with no second copy to send. What the bridge adds is
// OpenCode's live side: the ids and events, a captured output file served by
// byte cursor, the running list and stopping.
//
// What Pi's `bash` cannot give, and what that costs (also in WORKSPACE-NOTES.md):
// - no pid: `ShellInfo.pid` is left out (it is optional);
// - `abort_bash` stops every user command of the session, so stopping one of
//   several that run side by side in one session stops them all;
// - while the agent streams, and for a session that has no assistant message
//   yet, Pi writes the `bashExecution` entry later (after the turn, or with the
//   first assistant message); the stored message appears then;
// - the live output is what Pi streams (`bash_execution_update`): ANSI codes
//   stripped, as in the stored message.
//
// Each command gets an RPC id of its own (`shell:<shellID>`), which
// `bash_execution_update` repeats, so side by side commands keep their output
// apart.

import fs from 'node:fs';
import path from 'node:path';

import { ascendingId } from '../../wire/ids.js';
import { conflict, invalidRequest, locationNotFound, serviceUnavailable, WireError } from '../errors.js';
import { json, noContent } from '../http.js';

const DEFAULT_PAGE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const BIND_WINDOW_MS = 5000;
const BIND_ATTEMPTS = 3;
const MAX_WAITING_BINDS = 20;
const TAIL_READ_BYTES = 8 * 1024 * 1024;
const STOP_WAIT_MS = 10_000;

const JOB_KINDS = ['shell', 'subagent', 'image'];
const JOB_STATUSES = ['running', 'completed', 'error', 'cancelled'];

const queryError = (message, field) => invalidRequest(`${message}\n  at ["${field}"]`, { kind: 'Query' });

/** Cuts a buffer back to its last complete UTF-8 character. */
export const trimIncompleteUtf8 = (buffer) => {
  let end = buffer.length;
  // A sequence of up to four bytes: look back for a lead byte that is not complete.
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (needed > back) end = buffer.length - back;
    break;
  }
  return buffer.subarray(0, end);
};

/** Skips continuation bytes at the start of a buffer cut in the middle of a character. */
const dropLeadingContinuation = (buffer) => {
  let start = 0;
  while (start < Math.min(3, buffer.length) && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
};

const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The text OpenCode hands the agent when a user command ends (and the UI reads for the command's end). */
const completionText = ({ id, state, command, output, exit, status }) => {
  const suffix = status === 'killed' ? '\nCancelled\n' : status === 'timeout' ? '\nTimed out\n' : exit !== undefined && exit !== 0 ? `\nExited with code ${exit}\n` : '';
  return `The following shell command was executed by the user:\n<shell id="${id}" state="${state}" command="${escapeAttribute(command)}">\n${output === '' ? '(no output)' : output}\n${suffix}</shell>`;
};

/**
 * The timestamp Pi gave the `bashExecution` entry of a finished command: the
 * entry with this command whose time is nearest to when the command ended.
 * Reads the tail of the session file; null when the entry is not there (yet).
 */
export const findBashTimestamp = async (file, { command, endedAt }) => {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift();
    let best = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"bashExecution"')) continue;
      let entry;
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      const message = entry?.type === 'message' ? entry.message : null;
      if (message?.role !== 'bashExecution' || message.command !== command || !Number.isFinite(message.timestamp)) continue;
      const distance = Math.abs(message.timestamp - endedAt);
      if (distance <= BIND_WINDOW_MS && (best === null || distance < best.distance)) best = { distance, timestamp: message.timestamp };
    }
    return best?.timestamp ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
};

/**
 * @param {object} options
 * @param {ReturnType<import('../../live-session-host.js').createLiveSessionHost>} options.host
 * @param {(type: string, data: object, directory: string, options?: { id?: string }) => void} options.emit
 * @param {string} options.tmpDir
 * @param {(sessionID: string) => Promise<object>} options.requireSession
 * @param {(record: object) => Promise<object>} [options.getLaunch]  The start options of a new Pi process; needed to run a command in a session that has none live.
 * @param {{ get: (sessionID: string) => Promise<{ path: string }|null> }} [options.fileIndex]
 * @param {(sessionID: string, timestamp: number, messageID: string) => unknown} [options.bindClientId]
 * @param {() => Array<object>|Promise<Array<object>>} [options.listJobs]  Jobs that are not shell commands (subagents, images).
 * @param {number} [options.timeoutMs]  A command still running after this long is stopped (`timeout`); 0 means never.
 * @param {number} [options.maxRunning]
 * @param {number} [options.maxOutputBytes]
 * @param {number} [options.keepaliveMs]
 * @param {number} [options.retainMs]
 * @param {number} [options.retainCount]
 * @param {string} [options.shellPath]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.report]
 */
export const createShells = ({
  host,
  emit,
  tmpDir,
  requireSession,
  getLaunch,
  fileIndex,
  bindClientId,
  listJobs,
  timeoutMs = 0,
  maxRunning = 32,
  maxOutputBytes = 8 * 1024 * 1024,
  keepaliveMs = 30_000,
  retainMs = 30 * 60_000,
  retainCount = 100,
  shellPath = '/bin/bash',
  now = () => Date.now(),
  report = () => {},
}) => {
  /** shellID -> record */
  const shells = new Map();
  /** RPC id -> running record, for `bash_execution_update` */
  const byRpc = new Map();
  /** client message id -> record, so a repeated request starts nothing */
  const byMessage = new Map();
  /** sessionID -> { count, timer } */
  const keepalives = new Map();
  /** sessionID -> bindings waiting for Pi to write the entry */
  const waitingBinds = new Map();
  let outputDir = null;
  let closed = false;

  const ensureOutputDir = () => {
    outputDir ??= fs.mkdtempSync(path.join(tmpDir, 'openchamber-shell-'));
    return outputDir;
  };

  const realpathOf = (directory) => {
    try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
  };

  const sameLocation = (record, directory) => record.directory === directory || record.realDirectory === realpathOf(directory);

  const snapshot = (record) => ({
    ...record.info,
    metadata: { ...record.info.metadata },
    time: { ...record.info.time },
  });

  // ---- output capture -----------------------------------------------------

  const append = (record, delta) => {
    if (record.fd === null || typeof delta !== 'string' || delta === '') return;
    let bytes = Buffer.from(delta, 'utf8');
    const room = maxOutputBytes - record.size;
    if (bytes.length > room) {
      record.dropped = true;
      bytes = trimIncompleteUtf8(bytes.subarray(0, Math.max(0, room)));
    }
    if (bytes.length === 0) return;
    fs.writeSync(record.fd, bytes);
    record.size += bytes.length;
  };

  const closeFile = (record) => {
    if (record.fd === null) return;
    try { fs.closeSync(record.fd); } catch { /* closed */ }
    record.fd = null;
  };

  const readPage = async (record, cursor, limit) => {
    const start = Math.min(cursor, record.size);
    const length = Math.min(limit, MAX_PAGE_BYTES, record.size - start);
    if (length <= 0) return { output: '', cursor: start, size: record.size, truncated: record.dropped };
    const buffer = Buffer.alloc(length);
    const handle = await fs.promises.open(record.info.file, 'r');
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
    const whole = start + length >= record.size ? buffer : trimIncompleteUtf8(buffer);
    const lead = start > 0 ? dropLeadingContinuation(whole) : whole;
    return { output: lead.toString('utf8'), cursor: start + whole.length, size: record.size, truncated: record.dropped };
  };

  const readTail = async (record) => {
    const start = Math.max(0, record.size - TAIL_BYTES);
    return (await readPage(record, start, TAIL_BYTES)).output;
  };

  // ---- keeping the process alive while a command is quiet ------------------

  // The host closes a process that saw no event for a while, and a quiet
  // command sends none.
  const holdSession = (record) => {
    let hold = keepalives.get(record.sessionID);
    if (!hold) {
      hold = { count: 0, timer: null };
      hold.timer = setInterval(() => {
        // `host.request` would start a process of its own when there is none; only a live one is touched.
        if (host.get(record.sessionID)) void host.request(record.session, 'get_state', {}, { timeoutMs: 15_000 }).catch(() => {});
      }, keepaliveMs);
      hold.timer.unref?.();
      keepalives.set(record.sessionID, hold);
    }
    hold.count += 1;
  };

  const releaseSession = (record) => {
    const hold = keepalives.get(record.sessionID);
    if (!hold) return;
    hold.count -= 1;
    if (hold.count > 0) return;
    clearInterval(hold.timer);
    keepalives.delete(record.sessionID);
  };

  // ---- binding the UI's message id to Pi's entry ---------------------------

  const tryBind = async (binding) => {
    const timestamp = await findBashTimestamp(binding.file, binding);
    if (timestamp === null) return false;
    await bindClientId(binding.sessionID, timestamp, binding.messageID);
    return true;
  };

  const bindMessage = async (record, endedAt) => {
    const file = host.get(record.sessionID)?.state?.sessionFile;
    if (!bindClientId || !file) return;
    const binding = { sessionID: record.sessionID, messageID: record.messageID, command: record.info.command, endedAt, file, attempts: 0 };
    try {
      if (await tryBind(binding)) return;
    } catch (error) {
      report(`shell: could not bind message ${record.messageID}: ${error?.message ?? error}`);
      return;
    }
    // Pi writes the entry after the turn that was running, or with the first assistant message.
    const list = waitingBinds.get(record.sessionID) ?? [];
    list.push(binding);
    // A session that never settles a turn must not collect them without end.
    waitingBinds.set(record.sessionID, list.slice(-MAX_WAITING_BINDS));
  };

  const stopListening = host.on('event', ({ sessionId, event }) => {
    if (event?.type === 'bash_execution_update') {
      const record = byRpc.get(event.id);
      if (record) {
        try { append(record, event.delta); } catch (error) { report(`shell: could not capture output of ${record.info.id}: ${error?.message ?? error}`); }
      }
      return;
    }
    if (event?.type !== 'agent_settled') return;
    const waiting = waitingBinds.get(sessionId);
    if (!waiting) return;
    waitingBinds.delete(sessionId);
    void (async () => {
      const remaining = [];
      for (const binding of waiting) {
        binding.attempts += 1;
        let bound = false;
        try { bound = await tryBind(binding); } catch (error) { report(`shell: could not bind message ${binding.messageID}: ${error?.message ?? error}`); bound = true; }
        if (!bound && binding.attempts < BIND_ATTEMPTS) remaining.push(binding);
      }
      if (remaining.length > 0) waitingBinds.set(sessionId, [...(waitingBinds.get(sessionId) ?? []), ...remaining]);
    })();
  });

  // ---- finished commands are kept for a while ------------------------------

  const discard = (record) => {
    shells.delete(record.info.id);
    byMessage.delete(record.messageID);
    closeFile(record);
    fs.rmSync(record.info.file, { force: true });
  };

  const prune = () => {
    const finished = [...shells.values()].filter((record) => record.finished).sort((a, b) => a.info.time.completed - b.info.time.completed);
    const cutoff = now() - retainMs;
    let excess = finished.length - retainCount;
    for (const record of finished) {
      if (record.info.time.completed < cutoff || excess > 0) {
        discard(record);
        excess -= 1;
      }
    }
  };

  // ---- one command ----------------------------------------------------------

  const stateOf = (status) => (status === 'exited' ? 'completed' : status === 'killed' ? 'cancelled' : 'error');

  const finish = async (record, result, failure) => {
    clearTimeout(record.timer);
    byRpc.delete(record.rpcId);
    releaseSession(record);

    const completed = now();
    const status = record.timedOut ? 'timeout' : failure || result?.cancelled ? 'killed' : 'exited';
    const exit = Number.isFinite(result?.exitCode) ? result.exitCode : undefined;
    // Pi's own record of the output is what the stored message will say, so it is what the event says too.
    const text = typeof result?.output === 'string' ? result.output : await readTail(record).catch(() => '');
    closeFile(record);
    record.info.status = status;
    if (exit !== undefined) record.info.exit = exit;
    record.info.time.completed = completed;
    record.finished = true;
    if (failure) report(`shell ${record.info.id} ended without a result from Pi: ${failure?.message ?? failure}`);

    if (!closed) {
      const directory = record.directory;
      const truncated = result?.truncated === true;
      emit('shell.exited', { id: record.info.id, ...(exit !== undefined ? { exit } : {}), status }, directory);
      emit('session.shell.ended', {
        sessionID: record.sessionID,
        shell: snapshot(record),
        output: { output: text, cursor: text.length, size: text.length, truncated },
      }, directory);
      // The note the UI reads for the command's end (a reply block's "run" continues the agent from it).
      const inboxID = ascendingId('msg');
      const metadata = { source: 'shell', shellID: record.info.id, state: stateOf(status), truncated, ...(exit !== undefined ? { exit } : {}), ...(status === 'timeout' ? { timeout: true } : {}) };
      emit('session.inbox.enqueued', {
        sessionID: record.sessionID,
        inboxID,
        item: { type: 'synthetic', payload: { text: completionText({ id: record.info.id, state: stateOf(status), command: record.info.command, output: text, exit, status }), metadata }, delivery: 'steer' },
      }, directory);
      emit('session.inbox.delivered', { sessionID: record.sessionID, inboxID }, directory);
    }
    record.resolveDone();
    prune();
    // Best effort and off the response: the answer to the request does not wait for the session file.
    if (!closed) void bindMessage(record, completed).catch((error) => report(`shell: could not bind message ${record.messageID}: ${error?.message ?? error}`));
  };

  /** Stop a command: Pi's `abort_bash` ends the session's user commands. */
  const stop = async (record) => {
    if (!host.get(record.sessionID)) return;
    await host.request(record.session, 'abort_bash', {}, { timeoutMs: STOP_WAIT_MS }).catch((error) => {
      report(`shell ${record.info.id} could not be stopped: ${error?.message ?? error}`);
    });
  };

  const startChild = async (record, session) => {
    if (host.get(record.id)) return undefined;
    if (!getLaunch) throw serviceUnavailable('The agent process of this session cannot be started to run a command', 'pi');
    const launch = await getLaunch(record);
    try {
      await host.ensure({ ...session, launch });
    } catch (error) {
      const message = error?.message ?? String(error);
      if (/ENOENT/.test(message)) throw locationNotFound(session.cwd);
      throw serviceUnavailable(`The agent process could not start: ${message}`, 'pi');
    }
    return launch;
  };

  /**
   * Runs `command` for a session and resolves when it has ended. Events carry
   * the rest; a failure to start answers with a tagged error and no events.
   */
  const run = async (sessionRecord, { command, messageID }) => {
    if (byMessage.has(messageID)) return;
    if ([...shells.values()].filter((record) => !record.finished).length >= maxRunning) throw conflict('Too many shell commands are running');
    const directory = sessionRecord.location.directory;
    if (!fs.existsSync(directory)) throw locationNotFound(directory);

    const file = await fileIndex?.get(sessionRecord.id);
    const session = { id: sessionRecord.id, cwd: directory, ...(file ? { file: file.path } : {}) };
    const launch = await startChild(sessionRecord, session);

    const id = ascendingId('sh');
    const outputFile = path.join(ensureOutputDir(), `${id}.out`);
    const started = now();
    const record = {
      info: {
        id,
        status: 'running',
        command,
        cwd: directory,
        shell: shellPath,
        file: outputFile,
        metadata: { sessionID: sessionRecord.id, background: true },
        time: { started },
      },
      sessionID: sessionRecord.id,
      session,
      directory,
      realDirectory: realpathOf(directory),
      messageID,
      rpcId: `shell:${id}`,
      fd: fs.openSync(outputFile, 'w', 0o600),
      size: 0,
      dropped: false,
      timedOut: false,
      finished: false,
      timer: null,
      resolveDone: () => {},
    };
    record.done = new Promise((resolve) => { record.resolveDone = resolve; });
    shells.set(id, record);
    byRpc.set(record.rpcId, record);
    byMessage.set(messageID, record);
    holdSession(record);

    emit('shell.created', { info: snapshot(record) }, directory);
    // The UI names the shell's message after this event's id (`evt_X` is `msg_X`).
    emit('session.shell.started', { sessionID: sessionRecord.id, shell: snapshot(record) }, directory, { id: `evt_${messageID.slice(4)}` });

    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        record.timedOut = true;
        void stop(record);
      }, timeoutMs);
      record.timer.unref?.();
    }

    let result = null;
    let failure = null;
    try {
      // A process that stopped since it was started is started again with the same launch, never without one.
      if (!host.get(sessionRecord.id) && !launch) throw new Error('The agent process stopped');
      result = await host.request(host.get(sessionRecord.id) ? session : { ...session, launch }, 'bash', { command }, { timeoutMs: 0, id: record.rpcId });
    } catch (error) {
      failure = error;
    }
    await finish(record, result, failure);
  };

  /** Removes a command from the list and the store; a running one is stopped first. */
  const remove = async (record) => {
    if (!record.finished) {
      await stop(record);
      await Promise.race([record.done, new Promise((resolve) => { setTimeout(resolve, STOP_WAIT_MS).unref?.(); })]);
    }
    if (!shells.has(record.info.id)) return;
    discard(record);
    if (!closed) emit('shell.deleted', { id: record.info.id }, record.directory);
  };

  const close = () => {
    closed = true;
    stopListening();
    for (const hold of keepalives.values()) clearInterval(hold.timer);
    keepalives.clear();
    for (const record of shells.values()) {
      clearTimeout(record.timer);
      closeFile(record);
    }
    shells.clear();
    byRpc.clear();
    byMessage.clear();
    if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  };

  // ---- jobs ------------------------------------------------------------------

  const jobStatus = (status) => (status === 'running' ? 'running' : status === 'exited' ? 'completed' : status === 'killed' ? 'cancelled' : 'error');

  const shellJobs = () => [...shells.values()].map((record) => ({
    kind: 'shell',
    id: record.info.id,
    sessionID: record.sessionID,
    status: jobStatus(record.info.status),
    title: record.info.command,
    time: { ...record.info.time },
    shellID: record.info.id,
    command: record.info.command,
  }));

  const allJobs = async () => [...shellJobs(), ...((await listJobs?.()) ?? [])].sort((a, b) => a.time.started - b.time.started);

  return {
    run,
    remove,
    close,
    allJobs,
    prune,
    get: (id) => shells.get(id),
    running: (directory) => [...shells.values()].filter((record) => !record.finished && sameLocation(record, directory)),
    readPage,
    sameLocation,
    snapshot,
  };
};

const requireShellID = (id) => {
  if (typeof id !== 'string' || !id.startsWith('sh_')) throw invalidRequest('Expected a string starting with "sh_"\n  at ["id"]', { kind: 'Params' });
  return id;
};

const shellNotFound = (id) => new WireError(404, 'ShellNotFoundError', `Shell command not found: ${id}`, { id });

export const requireSessionID = (id) => {
  if (typeof id !== 'string' || !id.startsWith('ses')) throw invalidRequest('Expected a string starting with "ses"\n  at ["sessionID"]', { kind: 'Params' });
  return id;
};

const parseCursor = (text) => {
  if (text === null) return 0;
  const value = Number(text);
  if (!Number.isInteger(value)) throw queryError('Expected an integer', 'cursor');
  if (value < 0) throw queryError('Expected a value greater than or equal to 0', 'cursor');
  return value;
};

const parseLimit = (text) => {
  if (text === null) return DEFAULT_PAGE_BYTES;
  const value = Number(text);
  if (!Number.isInteger(value)) throw queryError('Expected an integer', 'limit');
  if (value < 1) throw queryError('Expected a value greater than 0', 'limit');
  return value;
};

/**
 * @param {object} deps
 * @param {(ctx: object) => { directory: string }} deps.locate
 * @param {(sessionID: string) => Promise<object>} deps.requireSession
 * @param {ReturnType<typeof createShells>} deps.shells
 */
export const createShellRoutes = ({ locate, requireSession, shells }) => {
  /** The command of a request, when it belongs to the request's location. */
  const findInLocation = (ctx) => {
    const { directory } = locate(ctx);
    const id = requireShellID(ctx.params.id);
    shells.prune();
    const record = shells.get(id);
    return { directory, id, record: record && shells.sameLocation(record, directory) ? record : null };
  };

  /** Whether `sessionID` is `ancestorID` or one of its descendants. */
  const createLineage = () => {
    const parents = new Map();
    return async (sessionID, ancestorID) => {
      let current = sessionID;
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (current === ancestorID) return true;
        if (!parents.has(current)) {
          try { parents.set(current, (await requireSession(current)).parentID ?? null); } catch { parents.set(current, null); }
        }
        current = parents.get(current);
      }
      return false;
    };
  };

  return [
    {
      method: 'GET',
      path: '/api/shell',
      handler: (ctx) => {
        const { directory } = locate(ctx);
        shells.prune();
        return json({ location: { directory }, data: shells.running(directory).map((record) => shells.snapshot(record)) });
      },
    },
    {
      method: 'GET',
      path: '/api/shell/:id',
      handler: (ctx) => {
        const { directory, id, record } = findInLocation(ctx);
        if (!record) throw shellNotFound(id);
        return json({ location: { directory }, data: shells.snapshot(record) });
      },
    },
    {
      method: 'GET',
      path: '/api/shell/:id/output',
      handler: async (ctx) => {
        const cursor = parseCursor(ctx.query.get('cursor'));
        const limit = parseLimit(ctx.query.get('limit'));
        const { directory, id, record } = findInLocation(ctx);
        if (!record) throw shellNotFound(id);
        try {
          return json({ location: { directory }, data: await shells.readPage(record, cursor, limit) });
        } catch (error) {
          // Removed while the page was read.
          if (error?.code === 'ENOENT') throw shellNotFound(id);
          throw error;
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/shell/:id',
      handler: async (ctx) => {
        const { record } = findInLocation(ctx);
        if (record) await shells.remove(record);
        return noContent();
      },
    },
    {
      method: 'POST',
      path: '/api/session/:sessionID/shell',
      handler: async (ctx) => {
        const sessionID = requireSessionID(ctx.params.sessionID);
        const body = await ctx.body();
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('Expected object', { kind: 'Payload' });
        if (!('command' in body)) throw invalidRequest('Missing key\n  at ["command"]', { kind: 'Payload' });
        if (typeof body.command !== 'string') throw invalidRequest('Expected string\n  at ["command"]', { kind: 'Payload' });
        if (body.id !== undefined && (typeof body.id !== 'string' || !body.id.startsWith('msg_'))) {
          throw invalidRequest('Expected a string starting with "msg_"\n  at ["id"]', { kind: 'Payload' });
        }
        const record = await requireSession(sessionID);
        // OpenCode answers when the command has ended; the events carry the rest.
        await shells.run(record, { command: body.command, messageID: body.id ?? ascendingId('msg') });
        return noContent();
      },
    },
    {
      method: 'GET',
      path: '/api/experimental/job',
      handler: async (ctx) => {
        const sessionID = ctx.query.get('sessionID');
        if (sessionID !== null && !sessionID.startsWith('ses')) throw queryError('Expected a string starting with "ses"', 'sessionID');
        const kind = ctx.query.get('kind');
        if (kind !== null && !JOB_KINDS.includes(kind)) throw queryError('Expected Job.Kind', 'kind');
        const status = ctx.query.get('status');
        if (status !== null && !JOB_STATUSES.includes(status)) throw queryError('Expected Job.Status', 'status');
        const descendantsText = ctx.query.get('descendants');
        if (descendantsText !== null && descendantsText !== 'true' && descendantsText !== 'false') throw queryError('Expected a boolean', 'descendants');
        if (sessionID !== null) await requireSession(sessionID);

        shells.prune();
        const isInside = createLineage();
        const data = [];
        for (const job of await shells.allJobs()) {
          if (kind !== null && job.kind !== kind) continue;
          if (status !== null && job.status !== status) continue;
          if (sessionID !== null && job.sessionID !== sessionID && !(descendantsText === 'true' && await isInside(job.sessionID, sessionID))) continue;
          data.push(job);
        }
        return json({ data });
      },
    },
  ];
};
