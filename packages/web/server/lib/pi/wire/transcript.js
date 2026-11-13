// Stored Pi session -> the message list `GET /api/session/:id/message` serves.
//
// Input is the active branch of a session file (`activeBranch(entries)` from
// ../session-files.js), output the wire messages oldest first (wire spec
// section 6). Every rule that also applies to the live stream comes from
// mapping.js, so a message reads the same whether the UI saw it arrive or loaded
// it afterwards.

import {
  ZERO_TOKENS,
  addTokens,
  assistantMessageId,
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
  noticeMessageId,
  shellMessageId,
  shellProcessId,
  tokensFromUsage,
  userMessageId,
  userPayloadFromContent,
  wireToolName,
} from './mapping.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const entryMs = (entry) => {
  const ms = Date.parse(entry?.timestamp ?? '');
  return Number.isFinite(ms) ? ms : 0;
};
const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const zeroTokens = () => ({ ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } });

const TOOL_INTERRUPTED = Object.freeze({ type: 'aborted', message: 'Tool execution interrupted' });

/** `customType` of the entry that records a session move, so it reads back as a `location-switched` message. */
export const LOCATION_SWITCHED_ENTRY = 'openchamber.location-switched';

/** The wire tool item for a Pi toolCall block and the toolResult that answers it, if any. */
const toolItem = ({ block, result, message, cwd, streamedAt, interrupted }) => {
  const created = message.timestamp;
  const input = mapToolInput({ toolName: block.name, args: block.arguments, cwd });
  const base = { type: 'tool', id: block.id, name: wireToolName(block.name), executed: false };
  if (result) {
    const completed = finiteNumber(result.timestamp) || streamedAt;
    const ran = Math.min(completed, Math.max(created, completed - finiteNumber(result.durationMs)));
    const mapped = mapToolResult({
      toolName: block.name,
      args: block.arguments,
      cwd,
      content: result.content,
      details: result.details,
      isError: result.isError,
    });
    const state = mapped.status === 'completed'
      ? { status: 'completed', input, content: mapped.content, ...(mapped.metadata ? { metadata: mapped.metadata } : {}) }
      : { status: 'error', input, error: mapped.error, ...(mapped.metadata ? { metadata: mapped.metadata } : {}) };
    return { ...base, state, time: { created, ran, completed } };
  }
  if (interrupted) {
    return { ...base, state: { status: 'error', input, error: { ...TOOL_INTERRUPTED } }, time: { created, ran: streamedAt, completed: streamedAt } };
  }
  return { ...base, state: { status: 'running', input, metadata: {} }, time: { created, ran: streamedAt } };
};

/** When the step is over: the response ended and every tool result is in. */
const completionMs = (message, results) => {
  let end = finiteNumber(message.timestamp) + finiteNumber(message.durationMs);
  for (const block of message.content ?? []) {
    if (block?.type === 'toolCall') end = Math.max(end, finiteNumber(results.get(block.id)?.timestamp));
  }
  return end;
};

const outcomeOfRun = (assistant) => {
  // A run that ends on a tool step or without any answer was cut off.
  if (!assistant || assistant.stopReason === 'toolUse' || assistant.stopReason === 'aborted') return { outcome: 'interrupted' };
  if (assistant.stopReason === 'error') {
    const error = errorOfAssistantMessage(assistant);
    return error?.type === 'aborted' ? { outcome: 'interrupted' } : { outcome: 'failed', error };
  }
  return { outcome: 'succeeded' };
};

/**
 * @param {object} options
 * @param {object[]} options.entries  The active branch, root first.
 * @param {string} options.cwd        The session directory; file paths in edit results are relative to it.
 * @param {string} [options.agent]    Name shown on every assistant message (Pi has no agents).
 * @param {Record<string,string>|Map<number|string,string>} [options.clientIds]
 *   User and shell message timestamp -> the id the UI minted for it.
 * @param {boolean} [options.running] A turn is running: the last run gets no idle message and a tool
 *   call without a result is still `running` instead of interrupted.
 * @param {string} [options.idSalt] Makes this session's derived message ids differ from another session
 *   that holds the same entries (a fork); see `messageId` in mapping.js.
 * @param {Map<string, { start?: string, end?: string, files?: string[] }>} [options.snapshots]
 *   Assistant message id -> the work tree snapshots around its step, served as `snapshot`.
 * @param {Map<string, number>} [options.cuts] Filled with, for every message, the index in `entries` where
 *   cutting the branch leaves that message and all later ones out (what a fork `before` or a revert needs).
 * @returns {object[]} Wire messages sorted by id.
 */
export const entriesToWireMessages = ({ entries, cwd, agent = 'build', clientIds, running = false, idSalt, snapshots, cuts }) => {
  const branch = Array.isArray(entries) ? entries : [];
  // A tool result belongs to the assistant message before it; call ids are not
  // unique across a session (providers reuse `call_0`), so they are only
  // matched among the results of one message.
  const resultsOf = new Map();
  const ownerOfResult = new Map();
  const retriedEntries = new Set();
  let lastAssistantEntryId = null;
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      lastAssistantEntryId = entry.id;
      resultsOf.set(entry.id, new Map());
    } else if (entry.type === 'message' && entry.message?.role === 'toolResult' && lastAssistantEntryId) {
      resultsOf.get(lastAssistantEntryId).set(entry.message.toolCallId, entry.message);
      ownerOfResult.set(entry.id, lastAssistantEntryId);
    }
    // Pi hides a failed attempt it retried from the model with a context edit
    // whose replacement is null.
    if (entry.type === 'context_edit' && entry.replacement === null) retriedEntries.add(entry.targetId);
  }

  const out = [];
  const wireIdByEntryId = new Map();
  const compactions = [];

  let model;
  let thinkingLevel;
  let lastModelRef;
  let carry = null;
  // The run in progress: its last user or assistant message (the anchor of the
  // idle message that ends it) and the last assistant message (its outcome).
  let run = null;
  let anchorTimestamp = null;
  let currentIndex = 0;

  const closeRun = () => {
    if (!run) return;
    const { outcome, error } = outcomeOfRun(run.assistant);
    const id = idleMessageIdAfter(run.anchor, idSalt);
    out.push({
      id,
      time: { created: run.endMs },
      type: 'idle',
      outcome,
      ...(error ? { error } : {}),
    });
    // The idle message ends the run: it is left out by a cut after the run's last entry.
    cuts?.set(id, run.lastIndex + 1);
    run = null;
  };

  const handleUser = (entry, message) => {
    const timestamp = message.timestamp;
    // A user message after a finished answer starts the next run; after a tool
    // step it is steering that the same run delivers at its next step.
    if (run?.assistant && run.assistant.stopReason !== 'toolUse') closeRun();
    const id = userMessageId(timestamp, clientIds, idSalt);
    const { text, files } = userPayloadFromContent(message.content);
    out.push({
      id,
      time: { created: timestamp },
      type: 'user',
      text,
      ...(files.length > 0 ? { files } : {}),
    });
    wireIdByEntryId.set(entry.id, id);
    anchorTimestamp = timestamp;
    run = run
      ? { ...run, anchor: timestamp, endMs: Math.max(run.endMs, timestamp), lastIndex: currentIndex }
      : { anchor: timestamp, endMs: timestamp, assistant: null, lastIndex: currentIndex };
  };

  const handleAssistant = (entry, message) => {
    const timestamp = message.timestamp;
    const content = Array.isArray(message.content) ? message.content : [];
    // A failed attempt Pi retried with nothing streamed is the same step as its
    // retry: the reference server reuses the assistant message for it, so the
    // first attempt's id and start carry over and the failed record is not shown.
    if (retriedEntries.has(entry.id) && message.stopReason === 'error' && content.length === 0) {
      carry ??= { timestamp };
      return;
    }
    const startedAt = carry?.timestamp ?? timestamp;
    carry = null;
    const id = assistantMessageId(startedAt, idSalt);
    wireIdByEntryId.set(entry.id, id);
    const streamedAt = timestamp + finiteNumber(message.durationMs);
    const results = resultsOf.get(entry.id) ?? new Map();
    const completedAt = completionMs(message, results);
    const stoppedEarly = message.stopReason === 'error' || message.stopReason === 'aborted';
    const interrupted = stoppedEarly || !(running && entry.id === lastAssistantEntryId);

    const items = [];
    for (const block of content) {
      const kind = contentKind(block);
      if (kind === 'text') {
        items.push({ type: 'text', text: String(block.text ?? '') });
      } else if (kind === 'reasoning') {
        items.push({ type: 'reasoning', text: String(block.thinking ?? ''), time: { created: timestamp, completed: streamedAt } });
      } else if (kind === 'tool') {
        items.push(toolItem({ block, result: results.get(block.id), message, cwd, streamedAt, interrupted }));
      }
    }

    const ref = modelRef({ provider: message.provider, model: message.model, thinkingLevel: message.thinkingLevel ?? thinkingLevel });
    lastModelRef = ref;
    const error = errorOfAssistantMessage(message);
    const snapshot = snapshots?.get(id);
    out.push({
      id,
      time: { created: startedAt, streamed: streamedAt, completed: completedAt },
      type: 'assistant',
      agent,
      model: ref,
      content: items,
      ...(snapshot ? { snapshot } : {}),
      finish: finishFromStopReason(message.stopReason),
      ...(message.rawStopReason ? { rawFinish: message.rawStopReason } : {}),
      ...(hasUsage(message.usage) ? { cost: costFromUsage(message.usage), tokens: tokensFromUsage(message.usage) } : {}),
      ...(error ? { error } : {}),
    });
    anchorTimestamp = startedAt;
    run = { anchor: startedAt, endMs: completedAt, assistant: message, lastIndex: currentIndex };
  };

  const handleMessage = (entry) => {
    const message = entry.message;
    if (!isRecord(message)) return;
    switch (message.role) {
      case 'user':
        handleUser(entry, message);
        break;
      case 'assistant':
        handleAssistant(entry, message);
        break;
      case 'bashExecution': {
        const created = message.timestamp;
        const output = String(message.output ?? '');
        out.push({
          id: shellMessageId(created, clientIds, idSalt),
          time: { created, completed: created },
          type: 'shell',
          shellID: shellProcessId(created, idSalt),
          command: String(message.command ?? ''),
          status: message.cancelled ? 'killed' : 'exited',
          ...(Number.isFinite(message.exitCode) ? { exit: message.exitCode } : {}),
          output: { output, cursor: output.length, size: output.length, truncated: message.truncated === true },
        });
        break;
      }
      case 'custom':
      case 'branchSummary': {
        if (message.role === 'custom' && message.display !== true) break;
        const created = finiteNumber(message.timestamp);
        const isBranch = message.role === 'branchSummary';
        out.push({
          id: noticeMessageId(message.role, created, entry.id, idSalt),
          time: { created },
          type: 'synthetic',
          text: String(isBranch ? message.summary : userPayloadFromContent(message.content).text),
          description: isBranch ? 'Branch summary' : String(message.customType ?? 'custom'),
        });
        break;
      }
      case 'compactionSummary': {
        const created = finiteNumber(message.timestamp);
        out.push({
          id: compactionMessageIdAfter(anchorTimestamp ?? created, idSalt),
          time: { created },
          type: 'compaction',
          status: 'completed',
          reason: 'manual',
          summary: String(message.summary ?? ''),
          cost: 0,
          tokens: zeroTokens(),
        });
        break;
      }
      default:
        // system (Pi's prompt and tool declarations) and toolResult (folded
        // into the assistant message that called the tool).
        break;
    }
  };

  for (const [index, entry] of branch.entries()) {
    currentIndex = index;
    const firstNew = out.length;
    switch (entry.type) {
      case 'model_change': {
        const next = { provider: entry.provider, modelId: entry.modelId };
        // The first model_change of a file is the session's starting model, not a switch.
        if (model && (model.provider !== next.provider || model.modelId !== next.modelId)) {
          const created = entryMs(entry);
          out.push({
            id: noticeMessageId('model', created, entry.id, idSalt),
            time: { created },
            type: 'model-switched',
            model: modelRef({ provider: next.provider, model: next.modelId, thinkingLevel }),
            previous: modelRef({ provider: model.provider, model: model.modelId, thinkingLevel }),
          });
        }
        model = next;
        break;
      }
      case 'thinking_level_change':
        thinkingLevel = entry.thinkingLevel;
        break;
      case 'compaction': {
        const created = entryMs(entry);
        const message = {
          id: compactionMessageIdAfter(anchorTimestamp ?? created, idSalt),
          time: { created },
          type: 'compaction',
          status: 'completed',
          reason: 'manual',
          summary: String(entry.summary ?? ''),
          ...(lastModelRef ? { model: lastModelRef } : {}),
          cost: costFromUsage(entry.usage),
          tokens: entry.usage ? tokensFromUsage(entry.usage) : zeroTokens(),
        };
        out.push(message);
        compactions.push({ message, firstKeptEntryId: entry.firstKeptEntryId });
        break;
      }
      case 'branch_summary':
      case 'custom_message': {
        if (entry.type === 'custom_message' && entry.display !== true) break;
        const created = entryMs(entry);
        const isBranch = entry.type === 'branch_summary';
        out.push({
          id: noticeMessageId(entry.type, created, entry.id, idSalt),
          time: { created },
          type: 'synthetic',
          text: String(isBranch ? entry.summary : userPayloadFromContent(entry.content).text),
          description: isBranch ? 'Branch summary' : String(entry.customType ?? 'custom'),
          metadata: { pi: isBranch ? { kind: 'branchSummary', fromId: entry.fromId } : { kind: 'custom', customType: entry.customType } },
        });
        break;
      }
      case 'message':
        handleMessage(entry);
        break;
      case 'custom': {
        // The bridge writes this when a session is moved to another folder. The
        // wire id is the one the live `session.moved` event gave the notice.
        const data = entry.customType === LOCATION_SWITCHED_ENTRY && isRecord(entry.data) ? entry.data : null;
        if (!data || typeof data.messageId !== 'string' || !isRecord(data.location)) break;
        out.push({
          id: data.messageId,
          time: { created: finiteNumber(data.created) },
          type: 'location-switched',
          location: data.location,
          ...(data.projectID ? { projectID: data.projectID } : {}),
          ...(data.subpath !== undefined ? { subpath: data.subpath } : {}),
          ...(isRecord(data.previous) ? { previous: data.previous } : {}),
        });
        break;
      }
      default:
        // usage, label, context_edit, session_info and other extensions' custom entries: not part of the transcript.
        break;
    }
    if (cuts) {
      for (const message of out.slice(firstNew)) {
        if (!cuts.has(message.id)) cuts.set(message.id, index);
      }
    }
  }
  if (!running) closeRun();

  // `metadata.keepID`: the first message the compaction kept, by its wire id.
  for (const { message, firstKeptEntryId } of compactions) {
    const keepID = wireIdByEntryId.get(firstKeptEntryId) ?? wireIdByEntryId.get(ownerOfResult.get(firstKeptEntryId));
    if (keepID) message.metadata = { keepID };
  }

  return out.sort(compareIds);
};

/**
 * Puts the translator's in-flight assistant message into a stored page: the
 * file only gets an assistant message when it ends, and while its tools run the
 * file's copy is older than the live one, so a message with the same id is
 * replaced.
 */
export const appendInflight = (messages, inflight) => {
  if (!inflight) return messages;
  return [...messages.filter((message) => message.id !== inflight.id), inflight].sort(compareIds);
};

/**
 * Usage of a whole session as Pi's `get_session_stats` counts it: assistant
 * messages, tool-reported usage, compaction and branch-summary calls and
 * `usage` entries. Pass the entries to count (the whole file or the branch).
 */
export const usageTotalsFromEntries = (entries) => {
  let tokens = zeroTokens();
  let cost = 0;
  const add = (usage) => {
    if (!isRecord(usage)) return;
    tokens = addTokens(tokens, tokensFromUsage(usage));
    cost += costFromUsage(usage);
  };
  for (const entry of entries ?? []) {
    if (entry.type === 'message') {
      if (entry.message?.role === 'assistant' || entry.message?.role === 'toolResult') add(entry.message.usage);
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary' || entry.type === 'usage') {
      add(entry.usage);
    }
  }
  return { cost, tokens };
};
