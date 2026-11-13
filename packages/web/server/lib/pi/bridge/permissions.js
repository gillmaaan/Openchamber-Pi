// Permission requests for the Pi bridge. Pi has no permission system: the
// gate extension (`../extension/gui-gate.js`) calls back into the bridge before
// every tool call, and this manager answers from rules or asks the user.
//
// `createPermissionManager({ hub, getContext, resolveSource, store })`
//   hub            The event hub; `permission.asked|replied` go out through it.
//   getContext     `(sessionID) => { directory, agentRules?, sessionRules? } | null`.
//                  `null` is an unknown session. The rulesets are read on every
//                  call, so a session's `permissions` patched mid-turn apply to
//                  the next tool call.
//   resolveSource  `(sessionID, toolCallId) => { messageID } | undefined`, or a
//                  promise of it. The assistant message that holds the tool
//                  call. The translator knows it once it has seen the call
//                  start, so the answer may wait for that (the wire order is
//                  `tool.called`, then `permission.asked`), for at most
//                  `sourceWaitMs` (2 s). Without a `messageID`, after a
//                  failure or the wait, the request goes out without `source`.
//   store          Saved rules: `list({ projectID })`, `add`, `update`, `remove`.
//                  `createSavedPermissionStore` is the JSON-file one.
//
// `request({ sessionID, toolCallId, parentToolCallId?, tool, input, signal,
//            action?, resources?, save?, metadata? })`
//   resolves `{ allowed: true }` or `{ allowed: false, message }`.
//   Rules come first: the agent's, then the session's, last match wins, no
//   match asks; a saved `always` rule turns an `ask` into `allow` but never
//   overrides a `deny` (see `permission-rules.js`). A call the rules allow or
//   deny is answered at once. For an `ask` the manager emits `permission.asked`
//   and waits for `reply`. When `signal` aborts first the request is dropped
//   without `permission.replied`, as OpenCode does on interrupt. `action`,
//   `resources` and `save` override the mapping from `tool`/`input` for a
//   caller that already knows what it asks (`secret.run`).
//
// `reply(sessionID, requestID, { decision: 'once' | 'always' | 'reject', message? })`
//   `always` saves the request's `save` patterns for the project first, so a
//   store that cannot write leaves the request pending and the reply fails.
//   A request that is not pending (answered, dropped) is a
//   `PermissionNotFoundError`, which is what a second reply gets.
//
// `listPending({ directory?, sessionID? })`, `get(sessionID, requestID)`,
// `takeBlocked(sessionID, toolCallId)`: the reason a call was refused, once. A
// blocked call is only an error result in Pi's stream; this is how the
// translator tells `permission.rejected` from any other failure.

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../../opencode/atomic-write.js';
import { ascendingId } from '../wire/ids.js';
import { conflict, permissionNotFound, sessionNotFound } from './errors.js';
import { decide, describeToolCall } from './permission-rules.js';
import { resolveProject } from './project.js';
import { lookupSource, SOURCE_WAIT_MS } from './request-source.js';

export const DEFAULT_REJECT_MESSAGE = 'The user rejected this tool call.';
const INTERRUPTED_MESSAGE = 'The tool call was interrupted.';
const MAX_REMEMBERED_BLOCKS = 200;
const STORE_VERSION = 1;

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Saved `always` rules: one JSON file, writes serialized and atomic. A file that
 * cannot be read is kept aside and replaced by an empty store, so a bad byte
 * costs the saved rules and never the bridge.
 *
 * @param {object} options
 * @param {string} options.filePath
 * @param {(filePath: string, content: string) => void} [options.writeFile]
 * @param {() => number} [options.now]
 */
export const createSavedPermissionStore = ({ filePath, writeFile = writeFileAtomic, now = () => Date.now() }) => {
  let rules = null;
  let queue = Promise.resolve();

  const load = () => {
    if (rules) return rules;
    rules = [];
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return rules;
      throw error;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* quarantined below */ }
    const valid = isPlainRecord(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.rules);
    if (!valid) {
      try { fs.renameSync(filePath, `${filePath}.corrupt-${now()}`); } catch { /* nothing left to keep */ }
      return rules;
    }
    rules = parsed.rules.filter((rule) => isPlainRecord(rule) && ['id', 'projectID', 'action', 'resource'].every((key) => typeof rule[key] === 'string'));
    return rules;
  };

  const persist = (next) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFile(filePath, `${JSON.stringify({ version: STORE_VERSION, rules: next })}\n`);
    rules = next;
  };

  /** Run a change after every earlier one, so concurrent writes do not lose each other. */
  const serialize = (change) => {
    const run = queue.then(change);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const sameRule = (a, b) => a.projectID === b.projectID && a.action === b.action && a.resource === b.resource;

  const list = ({ projectID } = {}) => load().filter((rule) => projectID === undefined || rule.projectID === projectID).map((rule) => structuredClone(rule));

  /** The saved rule for this project, action and resource; an existing one is returned as it is. */
  const add = ({ projectID, action, resource }) => serialize(() => {
    const current = load();
    const existing = current.find((rule) => sameRule(rule, { projectID, action, resource }));
    if (existing) return structuredClone(existing);
    const time = now();
    const rule = { id: ascendingId('psv'), projectID, action, resource, time: { created: time, updated: time } };
    persist([...current, rule]);
    return structuredClone(rule);
  });

  /** The changed rule, `null` for an unknown id; a change that equals another rule is a `ConflictError`. */
  const update = (id, fields) => serialize(() => {
    const current = load();
    const rule = current.find((entry) => entry.id === id);
    if (!rule) return null;
    const changed = { ...rule, ...fields, time: { ...rule.time, updated: now() } };
    if (current.some((entry) => entry.id !== id && sameRule(entry, changed))) throw conflict(`Saved permission already exists: ${changed.action} ${changed.resource}`, id);
    persist(current.map((entry) => (entry.id === id ? changed : entry)));
    return structuredClone(changed);
  });

  const remove = (id) => serialize(() => {
    const current = load();
    if (!current.some((rule) => rule.id === id)) return false;
    persist(current.filter((rule) => rule.id !== id));
    return true;
  });

  return { list, add, update, remove };
};

/**
 * @param {object} deps  See the header.
 */
export const createPermissionManager = ({
  hub,
  getContext,
  resolveSource = () => undefined,
  store,
  resolveProjectID = (directory) => resolveProject(directory).id,
  sourceWaitMs = SOURCE_WAIT_MS,
}) => {
  /** requestID -> { request, directory, settle(result) } */
  const pending = new Map();
  const blocked = new Map();

  const callKey = (sessionID, toolCallId) => `${sessionID}\u0000${toolCallId}`;

  const rememberBlock = (sessionID, toolCallId, block) => {
    blocked.set(callKey(sessionID, toolCallId), block);
    if (blocked.size > MAX_REMEMBERED_BLOCKS) blocked.delete(blocked.keys().next().value);
  };

  const takeBlocked = (sessionID, toolCallId) => {
    const key = callKey(sessionID, toolCallId);
    const block = blocked.get(key);
    blocked.delete(key);
    return block;
  };

  const refuse = (sessionID, toolCallId, kind, message) => {
    rememberBlock(sessionID, toolCallId, { kind, message });
    return { allowed: false, message };
  };

  const request = async ({ sessionID, toolCallId, parentToolCallId, tool, input = {}, signal, action, resources, save, metadata }) => {
    const context = getContext(sessionID);
    if (!context) throw sessionNotFound(sessionID);
    if (signal?.aborted) return { allowed: false, message: INTERRUPTED_MESSAGE };

    const described = action === undefined
      ? describeToolCall({ tool, input, directory: context.directory })
      : { action, resources, checks: resources.map((value) => ({ value })), save, metadata };
    const verdict = decide({
      action: described.action,
      checks: described.checks,
      agentRules: context.agentRules,
      sessionRules: context.sessionRules,
      saved: store.list({ projectID: resolveProjectID(context.directory) }),
    });
    if (verdict.effect === 'allow') return { allowed: true };
    if (verdict.effect === 'deny') {
      return refuse(sessionID, toolCallId, 'denied', `The user has specified a rule which prevents you from using this specific tool call (${described.action}: ${verdict.resource}).`);
    }

    // The call the chat shows is the top-level one; a codemode script's nested calls hang under it.
    const visibleCallId = parentToolCallId ?? toolCallId;
    const source = await lookupSource(resolveSource, sessionID, visibleCallId, sourceWaitMs);
    if (signal?.aborted) return { allowed: false, message: INTERRUPTED_MESSAGE };

    const id = ascendingId('per');
    const wire = {
      id,
      sessionID,
      action: described.action,
      resources: described.resources,
      ...(described.save?.length ? { save: described.save } : {}),
      ...(described.metadata ? { metadata: described.metadata } : {}),
      ...(source?.messageID ? { source: { type: 'tool', messageID: source.messageID, id: visibleCallId } } : {}),
    };
    return new Promise((resolve) => {
      const onAbort = () => {
        // Dropped, not answered: OpenCode sends no `permission.replied` here.
        if (pending.delete(id)) resolve({ allowed: false, message: INTERRUPTED_MESSAGE });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        request: wire,
        directory: context.directory,
        toolCallId,
        settle: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
      });
      hub.emit({ type: 'permission.asked', data: wire, location: { directory: context.directory } });
    });
  };

  const reply = async (sessionID, requestID, { decision, message }) => {
    const entry = pending.get(requestID);
    if (!entry || entry.request.sessionID !== sessionID) throw permissionNotFound(requestID);
    if (decision === 'always') {
      const projectID = resolveProjectID(entry.directory);
      for (const resource of entry.request.save ?? []) await store.add({ projectID, action: entry.request.action, resource });
      // A second reply or an abort may have taken the request while the rules were written.
      if (pending.get(requestID) !== entry) throw permissionNotFound(requestID);
    }
    pending.delete(requestID);
    hub.emit({
      type: 'permission.replied',
      data: { sessionID, requestID, reply: decision },
      location: { directory: entry.directory },
    });
    if (decision === 'reject') {
      entry.settle(refuse(sessionID, entry.toolCallId, 'rejected', message || DEFAULT_REJECT_MESSAGE));
    } else {
      entry.settle({ allowed: true });
    }
  };

  const listPending = ({ directory, sessionID } = {}) => [...pending.values()]
    .filter((entry) => (directory === undefined || entry.directory === directory) && (sessionID === undefined || entry.request.sessionID === sessionID))
    .map((entry) => structuredClone(entry.request));

  const get = (sessionID, requestID) => {
    const entry = pending.get(requestID);
    return entry && entry.request.sessionID === sessionID ? structuredClone(entry.request) : null;
  };

  return { request, reply, listPending, get, takeBlocked };
};
