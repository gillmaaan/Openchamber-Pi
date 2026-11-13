// Live Pi events -> OpenCode 2.2.6 wire events for one session.
//
// `onPiEvent` takes what a `pi --mode rpc` child printed and returns the events
// the reference server would have published (wire spec 4.3 and 4.4), without the
// envelope: the hub adds `id`, `created` and `location`. `durable: true` marks
// the events OpenCode persists. One translator serves one session for the life
// of its process; it keeps the open step, the pending inbox items and the
// session's absolute usage totals.
//
// Ordering the UI depends on:
//   inbox.enqueued (the coordinator's call) -> execution.started (first
//   agent_start of a cycle) -> inbox.delivered (the user message_start) ->
//   per assistant message: step.started, text/reasoning/tool events,
//   step.streamed (message_end), then step.ended or step.failed and
//   usage.updated at turn_end, once every tool result is in -> and at
//   agent_settled execution.succeeded | failed | interrupted(reason "user").
//
// A failed attempt Pi retries with nothing streamed is held at turn_end and
// decided at agent_end, because the reference server shows such an attempt as
// one assistant message with `retry` set that the retry reuses.
//
// Hooks for the coordinator: `onProcessExit` closes whatever the dead child left
// open; `assistantMessageIdForCall` and `whenCallNumbered` tell the permission
// and form managers which message holds a call, after `tool.called` is out;
// `classifyToolEnd` lets the permission gate say why a call ended as an error.

import {
  ZERO_TOKENS,
  addUsage,
  assistantMessageId,
  classifyProviderError,
  compactionMessageIdAfter,
  contentKind,
  costFromUsage,
  errorOfAssistantMessage,
  finishFromStopReason,
  hasUsage,
  idleMessageIdAfter,
  mapToolInput,
  mapToolResult,
  modelRef,
  tokensFromUsage,
  userMessageId,
  userPayloadFromContent,
  wireToolName,
} from './mapping.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
const cloneTotals = (totals) => ({
  cost: totals?.cost ?? 0,
  tokens: {
    input: totals?.tokens?.input ?? 0,
    output: totals?.tokens?.output ?? 0,
    reasoning: totals?.tokens?.reasoning ?? 0,
    cache: { read: totals?.tokens?.cache?.read ?? 0, write: totals?.tokens?.cache?.write ?? 0 },
  },
});

const TOOL_INTERRUPTED = Object.freeze({ type: 'aborted', message: 'Tool execution interrupted' });
const SHELL_TOOLS = new Set(['bash', 'powershell']);

const textOfContent = (content) => (Array.isArray(content)
  ? content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('')
  : '');

/**
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.cwd
 * @param {() => string} [options.getAgent]  Name of the agent shown on new steps.
 * @param {{cost:number,tokens:object}} [options.totals]  The session's totals so far; the translator adds to them.
 * @param {() => string|undefined} [options.getThinkingLevel]  Pi's current level, for a step's variant (Pi puts the level on a message only when it ends).
 * @param {() => number} [options.now]
 * @param {Record<string,string>|Map<number|string,string>} [options.clientIds]  User message timestamp -> UI id.
 * @param {(binding: {timestamp: number, id: string}) => void} [options.onClientId]  Called when a pending inbox item meets its Pi user message.
 * @param {string} [options.idSalt]  Per-session salt of derived message ids (a fork's); must match `entriesToWireMessages`.
 * @param {number} [options.lastMessageTimestamp]  Timestamp of the session's last user or assistant message (anchors idle and compaction ids).
 * @param {(toolCallId: string, event: object) => ({ kind: 'rejected'|'denied', message: string }|undefined)} [options.classifyToolEnd]
 *   Asked for every tool call that ends with `isError`, once: what the permission gate recorded for a call it blocked.
 *   `rejected` fails the call as `permission.rejected`, `denied` as `tool.execution`.
 * @param {typeof setTimeout} [options.setTimeoutImpl]  The one timer in this module, for `whenCallNumbered`.
 * @param {typeof clearTimeout} [options.clearTimeoutImpl]
 */
export const createEventTranslator = ({
  sessionId,
  cwd,
  getAgent = () => 'build',
  totals: initialTotals,
  getThinkingLevel,
  now = () => Date.now(),
  clientIds,
  onClientId,
  idSalt,
  lastMessageTimestamp,
  classifyToolEnd,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) => {
  let totals = cloneTotals(initialTotals);
  const pending = [];
  let executionOpen = false;
  let compactionOwnsExecution = false;
  let step = null;
  let held = null;
  let carry = null;
  let retry = null;
  let lastFailed = null;
  let lastAssistant = null;
  let lastTimestamp = lastMessageTimestamp ?? null;
  let thinkingLevel = getThinkingLevel?.();
  let lastModel;
  let compaction = null;
  // Which assistant message holds a tool call, for the permission and form
  // managers; bounded so a long session does not keep every call id.
  const callOwners = new Map();
  const numberedCalls = new Set();
  const nestedParents = new Map();
  const numberWaiters = new Map();
  const MAX_TRACKED_CALLS = 1000;

  const event = (type, data, { durable = false, ...extra } = {}) => ({
    type,
    data: { sessionID: sessionId, ...data },
    ...(durable ? { durable: true } : {}),
    ...extra,
  });

  // ---- inbox ---------------------------------------------------------------

  const enqueueInbox = ({ inboxID, type = 'user', text, files, agents, skills, metadata, description, delivery = 'steer' }) => {
    let payload = {};
    if (type === 'user') payload = compact({ text: text ?? '', files, agents, skills, metadata });
    else if (type === 'synthetic') payload = compact({ text: text ?? '', description, metadata });
    pending.push({ inboxID, type, text: type === 'user' ? (text ?? '') : undefined });
    return [event('session.inbox.enqueued', { inboxID, item: { type, payload, delivery } }, { durable: true })];
  };

  const takePending = (predicate) => {
    const index = pending.findIndex(predicate);
    return index === -1 ? null : pending.splice(index, 1)[0];
  };

  const cancelInbox = (inboxID) => (takePending((item) => item.inboxID === inboxID)
    ? [event('session.inbox.cancelled', { inboxID }, { durable: true })]
    : []);

  /** For items that reach the model without a Pi user message of their own (synthetic context folded into a prompt). */
  const deliverInbox = (inboxID) => (takePending((item) => item.inboxID === inboxID)
    ? [event('session.inbox.delivered', { inboxID }, { durable: true })]
    : []);

  // ---- execution ----------------------------------------------------------

  const startExecution = () => {
    if (executionOpen) return [];
    executionOpen = true;
    return [event('session.execution.started', {}, { durable: true })];
  };

  const idleMessage = (outcome, error) => ({
    id: idleMessageIdAfter(lastTimestamp ?? now(), idSalt),
    time: { created: now() },
    type: 'idle',
    outcome,
    ...(error ? { error } : {}),
  });

  /** Ends the execution; the idle message the UI will read on its next page is on the event as `idleMessage`. */
  const endExecution = ({ aborted = false, failure } = {}) => {
    if (!executionOpen) return [];
    const ownedByCompaction = compactionOwnsExecution;
    executionOpen = false;
    compactionOwnsExecution = false;
    let outcome = 'succeeded';
    let error;
    if (failure) {
      outcome = 'failed';
      error = failure;
    } else if (aborted || lastAssistant?.stopReason === 'aborted') {
      outcome = 'interrupted';
    } else if (lastAssistant?.stopReason === 'error') {
      error = errorOfAssistantMessage(lastAssistant);
      outcome = error?.type === 'aborted' ? 'interrupted' : 'failed';
      if (outcome === 'interrupted') error = undefined;
    }
    lastAssistant = null;
    // A compaction that ran by itself leaves no idle record in the stored
    // transcript (it would sort on the previous run's idle id), so it has none here either.
    const extra = ownedByCompaction ? {} : { idleMessage: idleMessage(outcome, error) };
    if (outcome === 'interrupted') return [event('session.execution.interrupted', { reason: 'user' }, { durable: true, ...extra })];
    if (outcome === 'failed') return [event('session.execution.failed', { error }, { durable: true, ...extra })];
    return [event('session.execution.succeeded', {}, { durable: true, ...extra })];
  };

  // ---- steps ----------------------------------------------------------------

  const stepEvent = (type, data, options) => event(type, { assistantMessageID: step.id, ...data }, options);

  const createStep = ({ id, startedAt, message }) => ({
    id,
    startedAt,
    createdAt: now(),
    model: modelRef({ provider: message.provider, model: message.model, thinkingLevel: message.thinkingLevel ?? thinkingLevel }),
    agent: getAgent(),
    blocks: new Map(),
    counts: { text: 0, reasoning: 0 },
    streamedAt: undefined,
    final: undefined,
  });

  const onAssistantStart = (message) => {
    const startedAt = carry?.timestamp ?? message.timestamp;
    const id = carry?.id ?? assistantMessageId(message.timestamp, idSalt);
    carry = null;
    held = null;
    retry = null;
    lastTimestamp = startedAt;
    step = createStep({ id, startedAt, message });
    lastModel = step.model;
    return [stepEvent('session.step.started', { agent: step.agent, model: step.model, started: message.timestamp }, { durable: true })];
  };

  const trackCall = (toolCallId, messageId) => {
    callOwners.set(toolCallId, messageId);
    if (callOwners.size > MAX_TRACKED_CALLS) callOwners.delete(callOwners.keys().next().value);
  };

  const markNumbered = (toolCallId) => {
    numberedCalls.add(toolCallId);
    if (numberedCalls.size > MAX_TRACKED_CALLS) numberedCalls.delete(numberedCalls.values().next().value);
  };

  /** The call a lookup means: a call a codemode script made is the script's own call. */
  const rootCall = (toolCallId) => {
    let id = toolCallId;
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = nestedParents.get(id) ?? (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined);
      if (!parent || parent === id) break;
      id = parent;
    }
    return id;
  };

  const assistantMessageIdForCall = (toolCallId) => callOwners.get(rootCall(String(toolCallId)));

  const isNumbered = (toolCallId) => numberedCalls.has(rootCall(String(toolCallId)));

  const settleWaiters = () => {
    for (const [toolCallId, waiters] of numberWaiters) {
      if (!isNumbered(toolCallId)) continue;
      numberWaiters.delete(toolCallId);
      const id = assistantMessageIdForCall(toolCallId);
      for (const done of waiters) done(id);
    }
  };

  /**
   * Resolves with the id of the assistant message that holds the call once its
   * `session.tool.called` event has been returned from `onPiEvent` (so the
   * caller publishes tool.called before anything it sends about the call), or
   * with undefined after `timeoutMs` or when the process exits.
   */
  const whenCallNumbered = (toolCallId, timeoutMs = 2000) => {
    const id = String(toolCallId);
    if (isNumbered(id)) return Promise.resolve(assistantMessageIdForCall(id));
    return new Promise((resolve) => {
      let timer;
      const done = (value) => {
        clearTimeoutImpl(timer);
        resolve(value);
      };
      timer = setTimeoutImpl(() => {
        const waiters = numberWaiters.get(id);
        if (waiters) {
          waiters.delete(done);
          if (waiters.size === 0) numberWaiters.delete(id);
        }
        resolve(undefined);
      }, timeoutMs);
      timer?.unref?.();
      if (!numberWaiters.has(id)) numberWaiters.set(id, new Set());
      numberWaiters.get(id).add(done);
    });
  };

  const startBlock = (index, kind, extra = {}) => {
    const block = { index, kind, createdAt: now(), text: '', ended: false, ...extra };
    if (kind !== 'tool') block.ordinal = step.counts[kind]++;
    step.blocks.set(index, block);
    if (kind === 'tool') trackCall(block.id, step.id);
    if (kind === 'text') return [block, [stepEvent('session.text.started', { ordinal: block.ordinal }, { durable: true })]];
    if (kind === 'reasoning') return [block, [stepEvent('session.reasoning.started', { ordinal: block.ordinal }, { durable: true })]];
    return [block, [stepEvent('session.tool.input.started', { id: block.id, name: wireToolName(block.piName) }, { durable: true })]];
  };

  const endTextLike = (block, text) => {
    if (block.ended) return [];
    block.ended = true;
    block.endedAt = now();
    block.text = text;
    const type = block.kind === 'text' ? 'session.text.ended' : 'session.reasoning.ended';
    return [stepEvent(type, { ordinal: block.ordinal, text }, { durable: true })];
  };

  /** The tool call's arguments are complete: input.ended then called, as the reference server sends them. */
  const callTool = (block, args) => {
    if (block.called) return [];
    block.called = true;
    markNumbered(block.id);
    block.args = isRecord(args) ? args : {};
    block.input = mapToolInput({ toolName: block.piName, args: block.args, cwd });
    const raw = block.raw !== '' ? block.raw : JSON.stringify(block.args);
    return [
      stepEvent('session.tool.input.ended', { id: block.id, text: raw }, { durable: true }),
      stepEvent('session.tool.called', { id: block.id, input: block.input, executed: false }, { durable: true }),
    ];
  };

  const findTool = (toolCallId) => {
    if (!step) return undefined;
    for (const block of step.blocks.values()) if (block.kind === 'tool' && block.id === toolCallId) return block;
    return undefined;
  };

  const ensureTool = (toolCallId, piName, args) => {
    const known = findTool(toolCallId);
    if (known) return [known, callTool(known, args)];
    // A tool the stream never announced (the translator joined late): announce it now.
    const index = Math.max(-1, ...step.blocks.keys()) + 1;
    const [block, started] = startBlock(index, 'tool', { id: toolCallId, piName, raw: '', called: false });
    return [block, [...started, ...callTool(block, args)]];
  };

  /** What the permission gate recorded for this call, asked once and only for errors. A broken hook must not stop the stream. */
  const blockedBy = (toolCallId, origin, isError) => {
    if (isError !== true || !classifyToolEnd) return undefined;
    try {
      return classifyToolEnd(toolCallId, origin) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const resolveTool = (block, { content, details, isError, structuredContent }, origin) => {
    if (block.resolved) return [];
    block.resolved = true;
    block.completedAt = now();
    const blocked = blockedBy(block.id, origin, isError);
    const mapped = mapToolResult({ toolName: block.piName, args: block.args, cwd, content, details, isError, structuredContent, blocked });
    block.result = mapped;
    if (mapped.status === 'completed') {
      return [stepEvent('session.tool.success', compact({ id: block.id, content: mapped.content, metadata: mapped.metadata, executed: false }), { durable: true })];
    }
    return [stepEvent('session.tool.failed', failedData(block, mapped.error, mapped.metadata), { durable: true })];
  };

  // A failed call keeps the metadata it ran with unless the event replaces it
  // (the reducer falls back to the last progress). The stored result has no
  // partial output, so a call that streamed some says so with empty metadata.
  const failedData = (block, error, metadata) => compact({
    id: block.id,
    error,
    metadata: metadata ?? (block.metadata ? {} : undefined),
    executed: false,
  });

  const interruptTool = (block) => {
    if (block.resolved) return [];
    block.resolved = true;
    block.completedAt = now();
    block.result = { status: 'error', error: { ...TOOL_INTERRUPTED } };
    return [stepEvent('session.tool.failed', failedData(block, { ...TOOL_INTERRUPTED }, undefined), { durable: true })];
  };

  const onMessageUpdate = (update) => {
    if (!step || !isRecord(update)) return [];
    const { type, contentIndex: index } = update;
    switch (type) {
      case 'text_start':
      case 'thinking_start': {
        if (step.blocks.has(index)) return [];
        return startBlock(index, type === 'text_start' ? 'text' : 'reasoning')[1];
      }
      case 'text_delta':
      case 'thinking_delta': {
        const kind = type === 'text_delta' ? 'text' : 'reasoning';
        const events = [];
        let block = step.blocks.get(index);
        if (!block) {
          const [created, started] = startBlock(index, kind);
          block = created;
          events.push(...started);
        }
        block.text += update.delta;
        events.push(stepEvent(kind === 'text' ? 'session.text.delta' : 'session.reasoning.delta', { ordinal: block.ordinal, delta: update.delta }));
        return events;
      }
      case 'text_end':
      case 'thinking_end': {
        const kind = type === 'text_end' ? 'text' : 'reasoning';
        const events = [];
        let block = step.blocks.get(index);
        if (!block) {
          const [created, started] = startBlock(index, kind);
          block = created;
          events.push(...started);
        }
        events.push(...endTextLike(block, typeof update.content === 'string' ? update.content : block.text));
        return events;
      }
      case 'toolcall_start': {
        if (step.blocks.has(index)) return [];
        return startBlock(index, 'tool', { id: update.id, piName: update.toolName, raw: '', called: false })[1];
      }
      case 'toolcall_delta': {
        const block = step.blocks.get(index);
        if (block?.kind === 'tool') block.raw += update.delta ?? '';
        return [];
      }
      case 'toolcall_end': {
        const call = update.toolCall;
        if (!isRecord(call)) return [];
        const events = [];
        let block = step.blocks.get(index);
        if (!block) {
          const [created, started] = startBlock(index, 'tool', { id: call.id, piName: call.name, raw: '', called: false });
          block = created;
          events.push(...started);
        }
        events.push(...callTool(block, call.arguments));
        return events;
      }
      default:
        return [];
    }
  };

  const onAssistantEnd = (message) => {
    if (!step) return [];
    const events = [];
    const content = Array.isArray(message.content) ? message.content : [];
    // Pi's final message is authoritative: it settles blocks the stream left
    // open (an aborted response) and announces blocks it never streamed.
    content.forEach((block, index) => {
      const kind = contentKind(block);
      if (!kind) return;
      let entry = step.blocks.get(index);
      if (!entry) {
        const [created, started] = startBlock(index, kind, kind === 'tool' ? { id: block.id, piName: block.name, raw: '', called: false } : {});
        entry = created;
        events.push(...started);
      }
      if (kind === 'tool') events.push(...callTool(entry, block.arguments));
      else events.push(...endTextLike(entry, String(kind === 'text' ? block.text ?? '' : block.thinking ?? '')));
    });
    for (const entry of step.blocks.values()) {
      if (entry.kind !== 'tool') events.push(...endTextLike(entry, entry.text));
    }
    step.final = message;
    step.streamedAt = now();
    thinkingLevel = message.thinkingLevel ?? thinkingLevel;
    step.model = modelRef({ provider: message.provider, model: message.model, thinkingLevel: message.thinkingLevel ?? thinkingLevel });
    lastModel = step.model;
    lastAssistant = message;
    // A request that failed before any output has no response body that ended.
    if (!(message.stopReason === 'error' && content.length === 0)) events.push(stepEvent('session.step.streamed', {}, { durable: true }));
    return events;
  };

  const usageEvents = (usage) => {
    totals = addUsage(totals, usage);
    return [event('session.usage.updated', { cost: totals.cost, tokens: totals.tokens })];
  };

  const failStep = ({ id, error, usage, rawFinish }) => {
    // `finish` stays off: the schema allows only "content-filter" there and the UI defaults to "error".
    const data = { assistantMessageID: id, error };
    if (rawFinish) data.rawFinish = rawFinish;
    if (hasUsage(usage)) {
      data.tokens = tokensFromUsage(usage);
      data.cost = costFromUsage(usage);
    }
    return [event('session.step.failed', data, { durable: true }), ...(hasUsage(usage) ? usageEvents(usage) : [])];
  };

  /**
   * turn_end: the response and every tool result are in; the step ends or fails.
   * A step that is still open when the run ends (`cut`: agent_end or agent_settled
   * without its turn_end, as when the process died) fails as interrupted.
   */
  const closeStep = (fallbackMessage, { cut = false, error: cutError } = {}) => {
    if (!step) return [];
    const current = step;
    const message = current.final ?? fallbackMessage;
    const events = [];
    // A step cut off mid-response keeps what streamed: its open blocks end with their text.
    for (const block of current.blocks.values()) if (block.kind !== 'tool') events.push(...endTextLike(block, block.text));
    for (const block of current.blocks.values()) if (block.kind === 'tool') events.push(...interruptTool(block));
    step = null;
    if (cut) {
      const error = cutError ?? { type: 'aborted', message: 'Step interrupted' };
      return [...events, ...failStep({ id: current.id, error, usage: message?.usage ?? current.lastUsage })];
    }
    if (!message) return events;
    const error = errorOfAssistantMessage(message);
    if (error) {
      const failure = { id: current.id, error, usage: message.usage, rawFinish: message.rawStopReason };
      lastFailed = { id: current.id, error };
      // Nothing streamed: Pi may retry this very request, and the answer comes at agent_end.
      if ((message.content?.length ?? 0) === 0) {
        held = { step: current, failure };
        return events;
      }
      return [...events, ...failStep(failure)];
    }
    const stepEnded = {
      assistantMessageID: current.id,
      finish: finishFromStopReason(message.stopReason),
      rawFinish: message.rawStopReason ?? message.stopReason,
      tokens: tokensFromUsage(message.usage),
      cost: costFromUsage(message.usage),
      files: [],
    };
    return [...events, event('session.step.ended', stepEnded, { durable: true }), ...usageEvents(message.usage)];
  };

  const flushHeld = () => {
    if (!held) return [];
    const { failure } = held;
    held = null;
    return failStep(failure);
  };

  // ---- Pi events ----------------------------------------------------------

  const onUserStart = (message) => {
    const { timestamp } = message;
    const { text, files } = userPayloadFromContent(message.content);
    lastTimestamp = timestamp;
    const item = takePending((entry) => entry.type === 'user' && entry.text === text) ?? takePending((entry) => entry.type === 'user');
    if (item) {
      onClientId?.({ timestamp, id: item.inboxID });
      return [event('session.inbox.delivered', { inboxID: item.inboxID }, { durable: true })];
    }
    // A message nobody here enqueued (typed in the Pi CLI, sent by an extension).
    const inboxID = userMessageId(timestamp, clientIds, idSalt);
    return [
      event('session.inbox.enqueued', { inboxID, item: { type: 'user', payload: compact({ text, files: files.length > 0 ? files : undefined }), delivery: 'steer' } }, { durable: true }),
      event('session.inbox.delivered', { inboxID }, { durable: true }),
    ];
  };

  const onCompactionStart = (piEvent) => {
    const events = [];
    if (!executionOpen) {
      events.push(...startExecution());
      compactionOwnsExecution = true;
    }
    const queued = takePending((item) => item.type === 'compaction');
    const inputID = queued?.inboxID ?? compactionMessageIdAfter(lastTimestamp ?? now(), idSalt);
    if (queued) events.push(event('session.inbox.delivered', { inboxID: queued.inboxID }, { durable: true }));
    compaction = { inputID, reason: piEvent.reason === 'manual' ? 'manual' : 'auto' };
    events.push(event('session.compaction.started', { reason: compaction.reason, inputID }, { durable: true }));
    return events;
  };

  const onCompactionEnd = (piEvent) => {
    const events = [];
    const started = compaction ?? { inputID: compactionMessageIdAfter(lastTimestamp ?? now(), idSalt), reason: piEvent.reason === 'manual' ? 'manual' : 'auto' };
    compaction = null;
    const result = piEvent.result;
    const failed = piEvent.aborted === true || typeof piEvent.errorMessage === 'string' || !isRecord(result);
    if (!failed) {
      events.push(...usageEvents(result.usage));
      events.push(event('session.compaction.ended', compact({
        reason: started.reason,
        model: lastModel,
        text: String(result.summary ?? ''),
        tokens: tokensFromUsage(result.usage),
        cost: costFromUsage(result.usage),
      }), { durable: true }));
    } else {
      const usage = result?.usage;
      events.push(event('session.compaction.failed', compact({
        reason: started.reason,
        inputID: started.inputID,
        error: { type: 'compaction.failed', message: typeof piEvent.errorMessage === 'string' && piEvent.errorMessage ? piEvent.errorMessage : 'Compaction was cancelled' },
        cost: hasUsage(usage) ? costFromUsage(usage) : 0,
        tokens: hasUsage(usage) ? tokensFromUsage(usage) : { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
      }), { durable: true }));
    }
    // A compaction that ran on its own (the `compact` command) has no agent_settled
    // to end its execution; one inside a cycle or about to retry leaves that to the cycle.
    if (compactionOwnsExecution && piEvent.willRetry !== true) events.push(...endExecution({ aborted: piEvent.aborted === true }));
    return events;
  };

  const handlePiEvent = (piEvent) => {
    if (!isRecord(piEvent)) return [];
    switch (piEvent.type) {
      case 'agent_start':
        return startExecution();
      case 'message_start': {
        const message = piEvent.message;
        if (message?.role === 'user') return onUserStart(message);
        if (message?.role === 'assistant') return onAssistantStart(message);
        return [];
      }
      case 'message_update':
        // Pi's running usage of the response, for a step that is cut off before its message ends.
        if (step && isRecord(piEvent.usage)) step.lastUsage = piEvent.usage;
        return onMessageUpdate(piEvent.assistantMessageEvent);
      case 'message_end': {
        const message = piEvent.message;
        if (message?.role === 'assistant') return onAssistantEnd(message);
        if (message?.role === 'toolResult') {
          const block = findTool(message.toolCallId);
          return block ? resolveTool(block, message, message) : [];
        }
        return [];
      }
      case 'tool_execution_start': {
        if (piEvent.parentToolCallId) {
          // A call a codemode script made: the chat shows the script's call, so lookups map to it.
          nestedParents.set(piEvent.toolCallId, piEvent.parentToolCallId);
          return [];
        }
        if (!step) return [];
        const [block, events] = ensureTool(piEvent.toolCallId, piEvent.toolName, piEvent.args);
        block.ranAt = now();
        return events;
      }
      case 'tool_execution_update': {
        if (piEvent.parentToolCallId || !step) return [];
        if (piEvent.toolName === 'subagent') {
          // The child session exists as soon as the call starts it: the row can open it while it runs.
          const childSessionID = piEvent.partialResult?.details?.sessionID;
          const block = findTool(piEvent.toolCallId);
          if (!block || typeof childSessionID !== 'string') return [];
          block.metadata = { sessionID: childSessionID, status: 'running' };
          return [stepEvent('session.tool.progress', { id: block.id, metadata: block.metadata })];
        }
        if (!SHELL_TOOLS.has(piEvent.toolName)) return [];
        const block = findTool(piEvent.toolCallId);
        if (!block) return [];
        // The running shell row shows `metadata.output` until the call ends.
        block.metadata = { output: textOfContent(piEvent.partialResult?.content) };
        return [stepEvent('session.tool.progress', { id: block.id, metadata: block.metadata })];
      }
      case 'tool_execution_end': {
        if (piEvent.parentToolCallId) {
          // Not shown, but the gate recorded a block for it that nobody else will take.
          blockedBy(piEvent.toolCallId, piEvent, piEvent.isError);
          nestedParents.delete(piEvent.toolCallId);
          return [];
        }
        if (!step) return [];
        const [block, events] = ensureTool(piEvent.toolCallId, piEvent.toolName, piEvent.args);
        const result = piEvent.result ?? {};
        return [...events, ...resolveTool(block, {
          content: result.content,
          details: result.details,
          isError: piEvent.isError,
          structuredContent: result.structuredContent,
        }, piEvent)];
      }
      case 'turn_end':
        return closeStep(piEvent.message);
      case 'agent_end': {
        const events = closeStep(undefined, { cut: true });
        if (held) {
          if (piEvent.willRetry === true) carry = { id: held.step.id, timestamp: held.step.startedAt };
          else events.push(...flushHeld());
        }
        return events;
      }
      case 'auto_retry_start': {
        if (!lastFailed) return [];
        retry = {
          assistantMessageID: lastFailed.id,
          attempt: Number(piEvent.attempt) + 1,
          at: now() + Math.max(0, Number(piEvent.delayMs) || 0),
          error: classifyProviderError(piEvent.errorMessage),
        };
        return [event('session.retry.scheduled', { ...retry }, { durable: true })];
      }
      case 'auto_retry_end':
        retry = null;
        return [];
      case 'agent_settled': {
        const events = [...closeStep(undefined, { cut: true }), ...flushHeld()];
        carry = null;
        retry = null;
        lastFailed = null;
        return [...events, ...endExecution({ aborted: piEvent.aborted === true })];
      }
      case 'thinking_level_changed':
        thinkingLevel = piEvent.level;
        return [];
      case 'compaction_start':
        return onCompactionStart(piEvent);
      case 'compaction_end':
        return onCompactionEnd(piEvent);
      default:
        // queue_update, entry_appended, session_info_changed, extension_ui_request
        // and the rest carry nothing the wire models here.
        return [];
    }
  };

  const onPiEvent = (piEvent) => {
    const events = handlePiEvent(piEvent);
    // Callers waiting for a call to be numbered continue after this returns, once the events are theirs to publish.
    settleWaiters();
    return events;
  };

  // ---- the process behind the translator died -----------------------------------

  /**
   * The Pi child exited. An open step fails, a compaction in progress fails, and
   * the execution fails with the same error, so no client waits on a run that
   * will never finish. Returns nothing when nothing was running. Afterwards the
   * translator is idle; inbox items nobody delivered stay pending for the caller
   * to cancel or resend.
   */
  const onProcessExit = ({ code = null, signal = null } = {}) => {
    const error = {
      type: 'provider.transport',
      message: `The agent process stopped unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}).`,
    };
    const events = [...flushHeld(), ...closeStep(undefined, { cut: true, error })];
    if (compaction) {
      const failed = compaction;
      compaction = null;
      events.push(event('session.compaction.failed', {
        reason: failed.reason,
        inputID: failed.inputID,
        error: { type: 'compaction.failed', message: error.message },
        cost: 0,
        tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
      }, { durable: true }));
    }
    events.push(...endExecution({ failure: error }));
    carry = null;
    retry = null;
    lastFailed = null;
    lastAssistant = null;
    for (const waiters of numberWaiters.values()) for (const done of waiters) done(undefined);
    numberWaiters.clear();
    return events;
  };

  // ---- the page a read during streaming serves -------------------------------

  const inflightTool = (block, stepView) => {
    const base = { type: 'tool', id: block.id, name: wireToolName(block.piName) };
    // The reference server never shows partial arguments: a streaming call's input stays empty until they are complete.
    if (!block.called) return { ...base, state: { status: 'streaming', input: '' }, time: { created: block.createdAt } };
    const common = { ...base, executed: false };
    const time = { created: block.createdAt, ran: block.ranAt ?? stepView.streamedAt ?? block.createdAt };
    if (block.resolved && block.result?.status === 'completed') {
      return { ...common, state: compact({ status: 'completed', input: block.input, content: block.result.content, metadata: block.result.metadata }), time: { ...time, completed: block.completedAt } };
    }
    if (block.resolved) {
      return { ...common, state: compact({ status: 'error', input: block.input, error: block.result.error, metadata: block.result.metadata }), time: { ...time, completed: block.completedAt } };
    }
    return { ...common, state: { status: 'running', input: block.input, metadata: block.metadata ?? {} }, time };
  };

  const inflightAssistantMessage = () => {
    const view = step ?? held?.step;
    if (!view) return null;
    const content = [];
    for (const block of [...view.blocks.values()].sort((a, b) => a.index - b.index)) {
      if (block.kind === 'text') content.push({ type: 'text', text: block.ended ? block.text : '' });
      else if (block.kind === 'reasoning') content.push({ type: 'reasoning', text: block.ended ? block.text : '', time: compact({ created: block.createdAt, completed: block.endedAt }) });
      else content.push(inflightTool(block, view));
    }
    return {
      id: view.id,
      time: compact({ created: view.startedAt, streamed: view.streamedAt }),
      type: 'assistant',
      agent: view.agent,
      model: view.model,
      content,
      ...(held && !step && retry ? { retry: { attempt: retry.attempt, at: retry.at, error: retry.error } } : {}),
    };
  };

  return {
    onPiEvent,
    onProcessExit,
    assistantMessageIdForCall,
    whenCallNumbered,
    enqueueInbox,
    cancelInbox,
    deliverInbox,
    inflightAssistantMessage,
    /** Whether an execution is open, and what opened it. */
    get execution() {
      return { active: executionOpen, owner: !executionOpen ? null : compactionOwnsExecution ? 'compaction' : 'agent' };
    },
    /** The retry waiting for its next attempt, or null. */
    get retry() {
      return retry ? { ...retry } : null;
    },
    /** Inbox items accepted and not yet delivered, oldest first. */
    pendingInbox: () => pending.map((item) => ({ ...item })),
    /** Timestamp of the last user or assistant message seen; ids of idle and compaction records anchor on it. */
    get lastMessageTimestamp() {
      return lastTimestamp;
    },
    /** The session's absolute usage totals. */
    totals: () => cloneTotals(totals),
    setThinkingLevel: (level) => { thinkingLevel = level; },
  };
};
