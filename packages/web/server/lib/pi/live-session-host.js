// The Pi child processes behind running sessions.
//
// Pi has no server: one `pi --mode rpc` process serves one session at a time.
// This host keeps a process for each session that is running a turn, waiting on
// a dialog, or was used a moment ago, starts it from the session file on
// demand, and closes it after it has been idle. Idle sessions are read from
// their files and cost nothing.
//
// Events leave through an EventEmitter: 'event' ({sessionId, event}),
// 'status' ({sessionId, busy}), 'ui-request' ({sessionId, request}),
// 'ui-settled' ({sessionId, id}), 'exit' ({sessionId, code, signal, wasBusy}).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { buildPiChildEnv, buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from './launch.js';
import { createPiRpcClient, PiRpcError } from './rpc-client.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_LIVE = 12;
const REAP_INTERVAL_MS = 30_000;

/**
 * Builds the factory that starts a Pi child for a session. Everything that
 * depends on the moment a process starts (the callback token, whether the
 * folder is trusted, the agent's tool selection) comes from `getLaunch`, which
 * runs once per started process.
 *
 * @param {object} options
 * @param {() => Record<string,string|undefined>} options.getBaseEnv  The environment the child inherits.
 * @param {(session: object) => {
 *   env?: Record<string,string|undefined>, extensions?: string[], approveProject?: boolean,
 *   model?: string, sessionDir?: string, extraArgs?: string[],
 * }} [options.getLaunch]  Defaults to `session.launch`, which the caller computes before `ensure`.
 */
export const createPiClientFactory = ({ getBaseEnv, getLaunch = (session) => session.launch }) => ({ session, handlers }) => {
  const runtime = resolvePiRuntime();
  const launch = getLaunch(session) ?? {};
  const resumable = session.file && fs.existsSync(session.file);
  return createPiRpcClient({
    command: runtime.command,
    args: [
      resolvePiRpcEntry(),
      ...buildPiRpcArgs({
        sessionFile: resumable ? session.file : undefined,
        sessionId: resumable ? undefined : session.id,
        extensions: launch.extensions ?? [],
        approveProject: launch.approveProject ?? false,
        model: launch.model,
        sessionDir: launch.sessionDir,
        extraArgs: launch.extraArgs ?? [],
      }),
    ],
    cwd: session.cwd,
    env: { ...buildPiChildEnv(getBaseEnv(), launch.env), ...runtime.env },
    ...handlers,
  });
};

/**
 * @param {object} options
 * @param {(args: { session: object, handlers: object }) => ReturnType<typeof createPiRpcClient>} options.createClient
 */
export const createLiveSessionHost = ({
  createClient,
  idleMs = DEFAULT_IDLE_MS,
  maxLive = DEFAULT_MAX_LIVE,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) => {
  const emitter = new EventEmitter();
  const live = new Map();
  let reaper = null;
  let shuttingDown = false;
  let configurationRevision = 0;

  const emit = (name, payload) => {
    try { emitter.emit(name, payload); } catch { /* a listener must not break the stream */ }
  };

  const startReaper = () => {
    if (reaper || idleMs <= 0) return;
    reaper = setIntervalImpl(() => { void reapIdle(); }, Math.min(REAP_INTERVAL_MS, Math.max(1000, idleMs / 2)));
    reaper.unref?.();
  };

  const closeEntry = async (entry) => {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      await cancelOpenDialogs(entry);
      await entry.client.close();
    })();
    return entry.closing;
  };

  const cancelOpenDialogs = async (entry) => {
    const ids = [...entry.pendingUi.keys()];
    entry.pendingUi.clear();
    await Promise.all(ids.map((id) => entry.client.respondUi(id, { cancelled: true }).catch(() => {})));
    for (const id of ids) emit('ui-settled', { sessionId: entry.session.id, id });
  };

  const isEvictable = (entry) => !entry.busy && entry.pendingUi.size === 0 && !entry.starting;

  const reapIdle = async () => {
    const cutoff = now() - idleMs;
    const idle = [...live.values()].filter((entry) => isEvictable(entry) && entry.lastActivity <= cutoff);
    await Promise.all(idle.map((entry) => closeEntry(entry)));
  };

  const enforceCapacity = async (keep) => {
    if (live.size <= maxLive) return;
    const candidates = [...live.values()]
      .filter((entry) => entry !== keep && isEvictable(entry))
      .sort((a, b) => a.lastActivity - b.lastActivity);
    let over = live.size - maxLive;
    for (const entry of candidates) {
      if (over <= 0) break;
      over -= 1;
      void closeEntry(entry);
    }
  };

  const setBusy = (entry, busy) => {
    if (entry.busy === busy) return;
    entry.busy = busy;
    emit('status', { sessionId: entry.session.id, busy });
  };

  const handlersFor = (entry) => ({
    onEvent: (event) => {
      entry.lastActivity = now();
      if (event.type === 'agent_start') setBusy(entry, true);
      emit('event', { sessionId: entry.session.id, event });
      if (event.type === 'agent_settled') setBusy(entry, false);
    },
    onUiRequest: (request) => {
      entry.lastActivity = now();
      const expectsReply = ['select', 'confirm', 'input', 'editor'].includes(request.method);
      if (expectsReply) entry.pendingUi.set(request.id, request);
      emit('ui-request', { sessionId: entry.session.id, request });
    },
    onStderr: (chunk) => emit('stderr', { sessionId: entry.session.id, chunk }),
    onExit: ({ code, signal }) => {
      const wasBusy = entry.busy;
      if (live.get(entry.session.id) === entry) live.delete(entry.session.id);
      const hadDialogs = [...entry.pendingUi.keys()];
      entry.pendingUi.clear();
      for (const id of hadDialogs) emit('ui-settled', { sessionId: entry.session.id, id });
      entry.busy = false;
      emit('exit', { sessionId: entry.session.id, code, signal, wasBusy, expected: entry.closing !== null || shuttingDown });
    },
  });

  /**
   * The live entry for a session, started if there is none.
   * @param {{ id: string, cwd: string, file?: string, env?: object }} session
   */
  const ensure = async (session) => {
    if (shuttingDown) throw new PiRpcError('The Pi host is shutting down.', { code: 'shutting_down' });
    const existing = live.get(session.id);
    if (existing) {
      existing.lastActivity = now();
      await existing.ready;
      return existing;
    }
    const entry = {
      session,
      configurationRevision,
      client: null,
      ready: null,
      busy: false,
      starting: true,
      closing: null,
      pendingUi: new Map(),
      lastActivity: now(),
      state: null,
    };
    entry.client = createClient({ session, handlers: handlersFor(entry) });
    live.set(session.id, entry);
    entry.ready = entry.client.request('get_state').then((state) => {
      entry.state = state;
      entry.starting = false;
    }, (error) => {
      entry.starting = false;
      if (live.get(session.id) === entry) live.delete(session.id);
      entry.client.kill();
      throw error;
    });
    startReaper();
    await entry.ready;
    void enforceCapacity(entry);
    return entry;
  };

  /** Send any Pi RPC command to a session, starting its process when needed. */
  const request = async (session, type, fields, options) => {
    const entry = await ensure(session);
    entry.lastActivity = now();
    return entry.client.request(type, fields, options);
  };

  /**
   * Send a prompt. Pi rejects a plain prompt while it streams, so a caller that
   * knows the session is busy passes `streamingBehavior`.
   */
  const prompt = async (session, { message, images, streamingBehavior }) => {
    const entry = await ensure(session);
    entry.lastActivity = now();
    const fields = { message };
    if (images?.length) fields.images = images;
    if (streamingBehavior) fields.streamingBehavior = streamingBehavior;
    const data = await entry.client.request('prompt', fields);
    if (data?.disposition === 'started') setBusy(entry, true);
    return data;
  };

  /**
   * Abort the running turn. Open dialogs are answered first: Pi's `abort` waits
   * for every extension dialog without a timeout, so a card nobody answers
   * would otherwise hang it.
   */
  const abort = async (sessionId) => {
    const entry = live.get(sessionId);
    if (!entry) return false;
    await cancelOpenDialogs(entry);
    await entry.client.request('abort', {}, { timeoutMs: 30_000 });
    return true;
  };

  const respondUi = async (sessionId, id, payload) => {
    const entry = live.get(sessionId);
    if (!entry?.pendingUi.has(id)) return false;
    entry.pendingUi.delete(id);
    await entry.client.respondUi(id, payload);
    emit('ui-settled', { sessionId, id });
    return true;
  };

  const snapshotOf = (entry) => ({
    sessionId: entry.session.id,
    cwd: entry.session.cwd,
    agent: entry.session.agent,
    agentRules: entry.session.launch?.agentRules,
    stale: entry.configurationRevision !== configurationRevision,
    busy: entry.busy,
    pendingUi: [...entry.pendingUi.values()],
    state: entry.state,
    pid: entry.client.pid,
  });

  const get = (sessionId) => {
    const entry = live.get(sessionId);
    return entry ? snapshotOf(entry) : null;
  };

  const list = () => [...live.values()].map(snapshotOf);

  const close = async (sessionId) => {
    const entry = live.get(sessionId);
    if (entry) await closeEntry(entry);
  };

  /** Retire the current setup without interrupting turns. Busy children are replaced before their next idle prompt. */
  const closeIdle = async () => {
    configurationRevision += 1;
    await Promise.all([...live.values()].filter(isEvictable).map((entry) => closeEntry(entry)));
  };

  const shutdown = async () => {
    shuttingDown = true;
    if (reaper) clearIntervalImpl(reaper);
    reaper = null;
    await Promise.all([...live.values()].map((entry) => closeEntry(entry)));
  };

  return {
    on: (name, listener) => { emitter.on(name, listener); return () => emitter.off(name, listener); },
    ensure,
    request,
    prompt,
    abort,
    respondUi,
    get,
    list,
    close,
    closeIdle,
    shutdown,
    reapIdle,
  };
};
