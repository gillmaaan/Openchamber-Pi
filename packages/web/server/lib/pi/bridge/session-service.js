// What the Pi bridge does with sessions.
//
// A session's truth is split: the transcript lives in Pi's file, everything
// OpenChamber adds (archived, viewed, metadata, the chosen agent and model, run
// state) lives in the sidecar store, and a running turn lives in a Pi child
// process. This service is the only place that joins them, and the only place
// that turns a change into the wire events the UI listens for.

import fs from 'node:fs';
import path from 'node:path';

import { descendingId } from '../wire/ids.js';
import { invalidRequest, sessionNotFound } from './errors.js';

export const WIRE_VERSION = '2.2.6';

// Events OpenCode sends without a `location` (wire spec 4.1). The UI finds the
// folder of such an event through the session registry; a wrong one would
// misroute it, so these stay without one.
const LOCATIONLESS_EVENTS = new Set([
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.usage.updated',
  'session.deleted',
  'session.archived',
  'session.unarchived',
  'session.viewed',
  'session.renamed',
  'session.metadata.updated',
  'session.model.selected',
  'session.agent.selected',
  'session.permissions',
  'session.forked',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.revert.committed',
]);

const SLUG_WORDS = [
  ['neon', 'swift', 'quiet', 'amber', 'brisk', 'mellow', 'lucky', 'bright', 'calm', 'eager'],
  ['cabin', 'knight', 'harbor', 'meadow', 'comet', 'falcon', 'lantern', 'orchid', 'canyon', 'tiger'],
];

const makeSlug = (random = Math.random) => SLUG_WORDS.map((words) => words[Math.floor(random() * words.length)]).join('-');

const requireSessionId = (id, field = 'id') => {
  if (typeof id !== 'string' || !id.startsWith('ses')) {
    throw invalidRequest(`Expected a string starting with "ses"\n  at ["${field}"]`, { kind: 'Payload' });
  }
};

const isModelRef = (value) => value && typeof value === 'object' && typeof value.providerID === 'string' && typeof value.id === 'string';

/**
 * @param {object} deps
 * @param {ReturnType<import('./session-records.js').createSessionRecords>} deps.records
 * @param {ReturnType<import('../session-meta-store.js').createSessionMetaStore>} deps.metaStore
 * @param {ReturnType<import('../session-files.js').createSessionFileIndex>} deps.fileIndex
 * @param {ReturnType<import('../live-session-host.js').createLiveSessionHost>} deps.host
 * @param {ReturnType<import('./hub.js').createEventHub>} deps.hub
 * @param {() => string} deps.getDefaultDirectory
 * @param {() => number} [deps.now]
 * @param {(agent: string, directory: string) => Promise<unknown>} [deps.validateAgent]  Refuses unknown or disabled profiles before persisting selection.
 * @param {(sessionID: string) => void} [deps.onRemoved]  Called once a session is gone, to drop what is cached for it.
 */
export const createSessionService = ({
  records,
  metaStore,
  fileIndex,
  host,
  hub,
  getDefaultDirectory,
  now = () => Date.now(),
  mintSessionId = () => descendingId('ses'),
  random = Math.random,
  onRemoved = () => {},
  validateAgent = async () => {},
}) => {
  /** Sessions with a turn running or about to run: from prompt accepted to the terminal event. */
  const running = new Set();

  const emit = (type, data, directory) => hub.emit({
    type,
    data,
    ...(directory && !LOCATIONLESS_EVENTS.has(type) ? { location: { directory } } : {}),
  });

  const requireRecord = async (id) => {
    const record = await records.get(id);
    if (!record) throw sessionNotFound(id);
    return record;
  };

  const touch = (fields) => ({ ...fields, updatedAt: now() });

  /**
   * Create a session. A client-minted id that exists answers the original
   * record with no new event: that is how a retry after a lost response stays
   * harmless.
   */
  const create = async (body, requestDirectory) => {
    const id = body.id ?? mintSessionId();
    requireSessionId(id);
    const existing = await records.get(id);
    if (existing) return existing;

    if (body.model !== undefined && !isModelRef(body.model)) throw invalidRequest('Expected a model reference\n  at ["model"]', { kind: 'Payload' });
    const directory = path.resolve(body.location?.directory ?? requestDirectory ?? getDefaultDirectory());
    const createdAt = now();
    await validateAgent(body.agent ?? 'build', directory);

    await metaStore.patch(id, {
      draft: { directory, createdAt },
      ...(body.title ? { title: body.title } : {}),
      ...(body.agent ? { agent: body.agent } : {}),
      ...(body.model ? { model: { providerID: body.model.providerID, id: body.model.id, ...(body.model.variant ? { variant: body.model.variant } : {}) } } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      ...(body.permissions ? { permissions: body.permissions } : {}),
      ...(body.parentID ? { parentID: body.parentID } : {}),
    });
    const record = await requireRecord(id);
    emit('session.created', {
      sessionID: id,
      slug: makeSlug(random),
      version: WIRE_VERSION,
      projectID: record.projectID,
      location: record.location,
      subpath: record.subpath ?? '',
      ...(record.parentID ? { parentID: record.parentID } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(record.agent ? { agent: record.agent } : {}),
      ...(body.model ? { model: { id: body.model.id, providerID: body.model.providerID, ...(body.model.variant ? { variant: body.model.variant } : {}) } } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      ...(record.permissions ? { permissions: record.permissions } : {}),
    }, record.location.directory);
    return record;
  };

  const update = async (id, body) => {
    const record = await requireRecord(id);
    const directory = record.location.directory;
    const changes = {};
    let touched = false;

    if (typeof body.title === 'string' && body.title.trim() && body.title.trim() !== record.title) {
      const title = body.title.trim();
      changes.title = title;
      touched = true;
      emit('session.renamed', { sessionID: id, title }, directory);
    }
    if (body.metadata !== undefined) {
      changes.metadata = body.metadata;
      touched = true;
      emit('session.metadata.updated', { sessionID: id, metadata: body.metadata }, directory);
    }
    if (body.permissions !== undefined) {
      changes.permissions = body.permissions;
      touched = true;
      emit('session.permissions', { sessionID: id, permissions: body.permissions }, directory);
    }
    if (body.archived === true && !record.time.archived) {
      changes.archivedAt = now();
      touched = true;
      emit('session.archived', { sessionID: id }, directory);
    } else if (body.archived === false && record.time.archived) {
      changes.archivedAt = null;
      touched = true;
      emit('session.unarchived', { sessionID: id }, directory);
    }
    if (touched) await metaStore.patch(id, touch(changes));
  };

  /** Remove a session and the sessions that name it as parent. */
  const remove = async (id) => {
    const record = await requireRecord(id);
    const children = (await records.list(new URLSearchParams({ parentID: id, limit: '1000' }))).data;
    for (const child of children) await remove(child.id);

    running.delete(id);
    await host.close(id);
    const file = await fileIndex.get(id);
    if (file) {
      await fs.promises.rm(file.path, { force: true });
      fileIndex.invalidate();
    }
    await metaStore.remove(id);
    onRemoved(id);
    emit('session.deleted', { sessionID: id }, record.location.directory);
  };

  /** Record how far the viewer has seen: the idle watermark, never later than the session's own idle. */
  const view = async (id, body) => {
    const record = await requireRecord(id);
    const idle = record.time.idle;
    if (!idle || typeof body.idle !== 'number') return;
    const viewed = Math.min(body.idle, idle);
    await metaStore.patch(id, { viewedAt: viewed });
    emit('session.viewed', { sessionID: id, idle: viewed }, record.location.directory);
  };

  const sameModel = (a, b) => a && b && a.providerID === b.providerID && a.id === b.id && (a.variant ?? 'default') === (b.variant ?? 'default');

  const switchModel = async (id, body) => {
    const record = await requireRecord(id);
    if (!isModelRef(body.model)) throw invalidRequest('Expected a model reference\n  at ["model"]', { kind: 'Payload' });
    if (body.model.variant === null) throw invalidRequest('Expected a string\n  at ["model"]["variant"]', { kind: 'Payload' });
    const next = { providerID: body.model.providerID, id: body.model.id, ...(body.model.variant ? { variant: body.model.variant } : {}) };
    if (sameModel(record.model, next)) return;
    await metaStore.patch(id, touch({ model: next }));
    emit('session.model.selected', {
      sessionID: id,
      model: next.variant ? next : { providerID: next.providerID, id: next.id },
      ...(record.model ? { previous: record.model } : {}),
    }, record.location.directory);
  };

  const switchAgent = async (id, body) => {
    const record = await requireRecord(id);
    if (typeof body.agent !== 'string' || !body.agent) throw invalidRequest('Expected a string\n  at ["agent"]', { kind: 'Payload' });
    await validateAgent(body.agent, record.location.directory);
    if (record.agent === body.agent) return;
    await metaStore.patch(id, touch({ agent: body.agent }));
    emit('session.agent.selected', {
      sessionID: id,
      agent: body.agent,
      ...(record.agent ? { previous: record.agent } : {}),
    }, record.location.directory);
  };

  /** Sessions with a run in progress, as `{ <sessionID>: { type: 'running' } }`. */
  const active = () => Object.fromEntries([...running].map((id) => [id, { type: 'running' }]));

  /** Stop the running turn. False when nothing was running, which is a no-op with no events. */
  const interrupt = async (id) => {
    await requireRecord(id);
    if (!running.has(id)) return false;
    return host.abort(id);
  };

  /** sessionID -> callbacks waiting for the session to go idle. */
  const idleWaiters = new Map();

  const markRunning = (id) => { running.add(id); };
  const markSettled = (id) => {
    running.delete(id);
    for (const resolve of idleWaiters.get(id) ?? []) resolve();
    idleWaiters.delete(id);
  };

  /** Resolve when the session is idle; at once when it already is. An aborted signal stops the wait. */
  const waitForIdle = async (id, signal) => {
    await requireRecord(id);
    if (!running.has(id)) return;
    await new Promise((resolve, reject) => {
      const waiters = idleWaiters.get(id) ?? new Set();
      const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { waiters.delete(done); reject(signal.reason ?? new Error('aborted')); };
      waiters.add(done);
      idleWaiters.set(id, waiters);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  return {
    create,
    update,
    remove,
    view,
    switchModel,
    switchAgent,
    interrupt,
    active,
    markRunning,
    markSettled,
    waitForIdle,
    emit,
    requireRecord,
    get: (id) => records.get(id),
    list: (query) => records.list(query),
  };
};
