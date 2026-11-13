// The live side of a session: Pi's events in, the OpenCode wire out.
//
// One translator per session turns Pi's RPC events into wire events, and this
// runtime publishes them, keeps the sidecar's run state in step (busy, idle,
// outcome), closes what a dead process left open, and serves the message pages
// the UI reads (stored transcript plus the step still streaming).
//
// Wiring, in the order a prompt travels, lives in `prompting.js`.

import fs from 'node:fs';

import { activeBranch } from '../session-files.js';
import { appendInflight, entriesToWireMessages, usageTotalsFromEntries } from '../wire/transcript.js';
import { createEventTranslator } from '../wire/translator.js';
import { decodeCursor, pageCursor } from './cursor.js';
import { invalidCursor, invalidRequest, messageNotFound } from './errors.js';
import { paginate } from './paginate.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const ENTRY_CACHE_SIZE = 8;
const MESSAGE_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'assistant', 'compaction', 'idle']);
const TERMINAL_OUTCOME = {
  'session.execution.succeeded': 'succeeded',
  'session.execution.failed': 'failed',
  'session.execution.interrupted': 'interrupted',
};

const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const lastConversationTimestamp = (branch) => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const message = branch[index].type === 'message' ? branch[index].message : null;
    if (message && (message.role === 'user' || message.role === 'assistant') && typeof message.timestamp === 'number') return message.timestamp;
  }
  return undefined;
};

/** One generic Pi dialog (`select`, `confirm`, `input`, `editor`) as a question of the form manager. */
const questionFromDialog = (request) => {
  if (request.method === 'select') {
    return { question: request.title, header: request.title.slice(0, 30), options: request.options.map((label) => ({ label: String(label), description: '' })) };
  }
  if (request.method === 'confirm') {
    return { question: request.message ? `${request.title}\n${request.message}` : request.title, header: request.title.slice(0, 30), options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] };
  }
  return { question: request.title, header: request.title.slice(0, 30), options: [] };
};

/** What Pi expects back for a dialog, from the answer the user gave. */
const dialogReply = (request, answer) => {
  if (request.method === 'confirm') return { confirmed: answer === 'Yes' };
  return { value: answer };
};

/**
 * @param {object} deps
 * @param {ReturnType<import('../live-session-host.js').createLiveSessionHost>} deps.host
 * @param {ReturnType<import('./session-service.js').createSessionService>} deps.service
 * @param {ReturnType<import('../session-files.js').createSessionFileIndex>} deps.fileIndex
 * @param {ReturnType<import('../session-meta-store.js').createSessionMetaStore>} deps.metaStore
 * @param {ReturnType<import('./permissions.js').createPermissionManager>} deps.permissions
 * @param {ReturnType<import('./forms.js').createFormManager>} deps.forms
 * @param {{ revoke: (sessionID: string) => void }} deps.tokens
 * @param {(sessionID: string) => Promise<object[]>} deps.readEntries
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 * @param {{
 *   onWireEvent?: (sessionID: string, wire: { type: string, data: object }) => void,
 *   snapshotsOf?: (sessionID: string) => Promise<Map<string, object>>,
 * }} [deps.hooks]  What the session operations (`session-ops.js`) listen to: every wire event after it was published,
 *   and the work tree snapshots to serve on assistant messages. Both are called late, so they may be set after creation.
 */
export const createChatRuntime = ({
  host,
  service,
  fileIndex,
  metaStore,
  permissions,
  forms,
  tokens,
  readEntries,
  now = () => Date.now(),
  log = () => {},
  hooks = {},
}) => {
  /** sessionID -> { translator, branch } */
  const translators = new Map();
  /** sessionID -> thinking level Pi reported last */
  const thinkingLevels = new Map();
  /** sessionID -> Promise: events of one session are handled one after another. */
  const chains = new Map();
  /** Pi dialog request id -> abort controller of the form that stands for it. */
  const dialogs = new Map();
  const entryCache = new Map();

  const loadEntries = async (sessionID) => {
    const file = await fileIndex.get(sessionID);
    if (!file) return [];
    const stat = await fs.promises.stat(file.path).catch(() => null);
    if (!stat) return [];
    const cached = entryCache.get(sessionID);
    if (cached && cached.path === file.path && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.entries;
    const entries = await readEntries(file.path);
    entryCache.set(sessionID, { path: file.path, size: stat.size, mtimeMs: stat.mtimeMs, entries });
    if (entryCache.size > ENTRY_CACHE_SIZE) entryCache.delete(entryCache.keys().next().value);
    return entries;
  };

  const persistClientId = async (sessionID, timestamp, messageID) => {
    const current = metaStore.get(sessionID)?.clientIds ?? {};
    await metaStore.patch(sessionID, { clientIds: { ...current, [timestamp]: messageID } });
  };

  /** The translator of a session, seeded from its file the first time. */
  const translatorFor = async (record) => {
    const existing = translators.get(record.id);
    if (existing) return existing.translator;

    const entries = await loadEntries(record.id);
    const branch = activeBranch(entries);
    const translator = createEventTranslator({
      sessionId: record.id,
      cwd: record.location.directory,
      getAgent: () => metaStore.get(record.id)?.agent ?? 'build',
      totals: usageTotalsFromEntries(entries),
      getThinkingLevel: () => thinkingLevels.get(record.id) ?? host.get(record.id)?.state?.thinkingLevel,
      clientIds: metaStore.get(record.id)?.clientIds ?? {},
      idSalt: metaStore.get(record.id)?.idSalt,
      lastMessageTimestamp: lastConversationTimestamp(branch),
      now,
      onClientId: ({ timestamp, id }) => { void persistClientId(record.id, timestamp, id); },
      classifyToolEnd: (toolCallId) => permissions.takeBlocked(record.id, toolCallId),
    });
    translators.set(record.id, { translator, directory: record.location.directory });
    return translator;
  };

  /** Publish translator output. `idleMessage` is not part of the wire frame. */
  const publish = (sessionID, wireEvents) => {
    const directory = translators.get(sessionID)?.directory;
    for (const wire of wireEvents) {
      const { type, data, idleMessage } = wire;
      service.emit(type, data, directory);
      try { hooks.onWireEvent?.(sessionID, wire); } catch (error) { log(`wire event hook failed: ${error?.message ?? error}`); }
      const outcome = TERMINAL_OUTCOME[type];
      if (type === 'session.execution.started') {
        service.markRunning(sessionID);
        void metaStore.patch(sessionID, { busyAt: now() });
      } else if (outcome) {
        service.markSettled(sessionID);
        const idleAt = idleMessage?.time?.created ?? now();
        void metaStore.patch(sessionID, { idleAt, outcome, updatedAt: idleAt, draft: null });
        fileIndex.invalidate();
      }
    }
  };

  const enqueueForSession = (sessionID, work) => {
    const next = (chains.get(sessionID) ?? Promise.resolve()).then(work).catch((error) => {
      log(`chat event for ${sessionID} failed: ${error?.message ?? error}`);
    });
    chains.set(sessionID, next);
    next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID); });
    return next;
  };

  const onPiEvent = (sessionID, event) => enqueueForSession(sessionID, () => {
    if (event.type === 'thinking_level_changed') thinkingLevels.set(sessionID, event.level);
    const entry = translators.get(sessionID);
    if (!entry) return;
    publish(sessionID, entry.translator.onPiEvent(event));
  });

  const onProcessExit = ({ sessionId, code, signal }) => enqueueForSession(sessionId, () => {
    tokens.revoke(sessionId);
    thinkingLevels.delete(sessionId);
    const entry = translators.get(sessionId);
    if (entry) publish(sessionId, entry.translator.onProcessExit({ code, signal }));
  });

  /** A dialog from some other extension: shown as a form, answered back to Pi. */
  const onDialogRequest = ({ sessionId, request }) => {
    if (!['select', 'confirm', 'input', 'editor'].includes(request.method)) return;
    const controller = new AbortController();
    dialogs.set(request.id, controller);
    void (async () => {
      let reply = { cancelled: true };
      try {
        const outcome = await forms.ask({ sessionID: sessionId, questions: [questionFromDialog(request)], signal: controller.signal });
        const answer = outcome.status === 'answered' ? outcome.answers?.[0]?.[0] : undefined;
        if (answer !== undefined) reply = dialogReply(request, answer);
      } catch (error) {
        log(`dialog ${request.id} failed: ${error?.message ?? error}`);
      }
      dialogs.delete(request.id);
      await host.respondUi(sessionId, request.id, reply).catch(() => {});
    })();
  };

  /** Pi's dialog was settled elsewhere (abort, exit): close the form that stood for it. */
  const onDialogSettled = ({ id }) => {
    dialogs.get(id)?.abort();
    dialogs.delete(id);
  };

  const start = () => {
    const stops = [
      host.on('event', ({ sessionId, event }) => { void onPiEvent(sessionId, event); }),
      host.on('exit', (info) => { void onProcessExit(info); }),
      host.on('ui-request', onDialogRequest),
      host.on('ui-settled', onDialogSettled),
      host.on('stderr', ({ sessionId, chunk }) => log(`pi ${sessionId}: ${String(chunk).trimEnd().slice(0, 500)}`)),
    ];
    return () => stops.forEach((stop) => stop());
  };

  // ---- reading messages ---------------------------------------------------

  /** Every message of a session, oldest first, with the step still streaming. */
  const wireMessages = async (record) => {
    const entries = await loadEntries(record.id);
    const entry = translators.get(record.id);
    const running = entry ? entry.translator.execution.active : false;
    const messages = entriesToWireMessages({
      entries: activeBranch(entries),
      cwd: record.location.directory,
      agent: record.agent ?? 'build',
      clientIds: metaStore.get(record.id)?.clientIds ?? {},
      idSalt: metaStore.get(record.id)?.idSalt,
      snapshots: await hooks.snapshotsOf?.(record.id),
      running,
    });
    const inflight = running ? entry.translator.inflightAssistantMessage() : null;
    const all = inflight ? appendInflight(messages, inflight) : messages;
    return all.sort((a, b) => compareIds(a.id, b.id));
  };

  const readLimit = (query) => {
    const text = query.get('limit');
    if (text === null) return DEFAULT_PAGE_SIZE;
    const limit = Number(text);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw invalidRequest(`Expected a value between 1 and ${MAX_PAGE_SIZE}\n  at ["limit"]`, { kind: 'Query' });
    }
    return limit;
  };

  /** One page of messages: newest first by default, a cursor continues a page. */
  const messages = async (sessionID, query) => {
    const record = await service.requireRecord(sessionID);
    const limit = readLimit(query);
    const cursorText = query.get('cursor');
    if (cursorText && query.get('order')) throw invalidCursor('Cursor cannot be combined with order');
    const decoded = cursorText ? decodeCursor(cursorText) : null;
    const order = decoded?.order ?? query.get('order') ?? 'desc';
    if (order !== 'asc' && order !== 'desc') throw invalidRequest('Expected "asc" | "desc"\n  at ["order"]', { kind: 'Query' });
    const type = query.get('type');
    if (type && !MESSAGE_TYPES.has(type)) throw invalidRequest(`Expected one of ${[...MESSAGE_TYPES].join(' | ')}\n  at ["type"]`, { kind: 'Query' });

    const sign = order === 'asc' ? 1 : -1;
    const sorted = (await wireMessages(record))
      .filter((message) => !type || message.type === type)
      .sort((a, b) => sign * compareIds(a.id, b.id));
    const page = paginate(sorted, {
      limit,
      cursor: decoded?.id ? { direction: decoded.direction, anchor: decoded } : null,
      compareToAnchor: (message, anchor) => sign * compareIds(message.id, anchor.id),
    });
    return { data: page, cursor: pageCursor(page, (message, direction) => ({ id: message.id, order, direction })) };
  };

  const message = async (sessionID, messageID) => {
    const record = await service.requireRecord(sessionID);
    const found = (await wireMessages(record)).find((candidate) => candidate.id === messageID);
    if (!found) throw messageNotFound(sessionID, messageID);
    return found;
  };

  /** The messages after the last compaction (the compaction first), or all of them. */
  const context = async (sessionID) => {
    const record = await service.requireRecord(sessionID);
    const all = await wireMessages(record);
    const lastCompaction = all.map((candidate) => candidate.type).lastIndexOf('compaction');
    return lastCompaction === -1 ? all : all.slice(lastCompaction);
  };

  /** The assistant message that holds a tool call, once the call has been announced; the permission and form managers ask for it. */
  const sourceOfCall = async (sessionID, toolCallId) => {
    const entry = translators.get(sessionID);
    if (!entry || !toolCallId) return undefined;
    const messageID = await entry.translator.whenCallNumbered(toolCallId, 2000);
    return messageID ? { messageID } : undefined;
  };

  const forget = (sessionID) => {
    translators.delete(sessionID);
    thinkingLevels.delete(sessionID);
    entryCache.delete(sessionID);
  };

  /**
   * The session's file or folder changed under an idle session (a move, a revert
   * commit): rebuild the translator from the file, keeping the inbox items it
   * still waits on (context admitted without waking the agent).
   */
  const reseed = async (record) => {
    const old = translators.get(record.id);
    translators.delete(record.id);
    entryCache.delete(record.id);
    if (!old) return;
    const fresh = await translatorFor(record);
    for (const item of old.translator.pendingInbox()) fresh.enqueueInbox({ inboxID: item.inboxID, type: item.type, text: item.text });
  };

  return {
    start,
    translatorFor,
    publish,
    messages,
    message,
    context,
    sourceOfCall,
    /** Remember the id the UI minted for a stored message (a shell command's message), so a reload keeps it. */
    bindClientId: persistClientId,
    forget,
    reseed,
  };
};
