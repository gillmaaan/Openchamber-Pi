// Pi Coding Agent -> OpenCode 2.2.6 wire format: the small pure rules that the
// live translator (translator.js) and the stored-transcript reader
// (transcript.js) share. Everything that must come out the same whether a
// message is seen live or read back from the session file lives here, so the two
// cannot drift.

import { createHash } from 'node:crypto';
import path from 'node:path';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

// The UI renders by these lowercase names (`normalizeToolName`). Pi's `find`
// lists files like OpenCode's `glob`, `ls` reads a directory like `read` does,
// and Pi's `codemode` is the Code Mode tool the UI knows as `execute`
// (`input.code` is the script in both). Extension and MCP tools keep their name.
const WIRE_TOOL_NAMES = new Map([
  ['bash', 'shell'],
  ['powershell', 'shell'],
  ['find', 'glob'],
  ['ls', 'read'],
  ['codemode', 'execute'],
]);

export const wireToolName = (piName) => WIRE_TOOL_NAMES.get(piName) ?? piName;

// ---------------------------------------------------------------------------
// Tool input
// ---------------------------------------------------------------------------

/** `p` as the UI shows a file: relative to the session directory when it is inside it. */
const relativeToCwd = (p, cwd) => {
  if (typeof p !== 'string' || p === '' || !cwd) return p;
  const absolute = path.resolve(cwd, p);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return p;
  return relative.split(path.sep).join('/');
};

/**
 * Pi's arguments for a tool call, in the shape the wire `input` has for the
 * same tool. Pi's own keys stay next to the wire ones wherever the UI could
 * read either (`edits`, `glob`, `ignoreCase`).
 */
export const mapToolInput = ({ toolName, args, cwd }) => {
  const input = isRecord(args) ? { ...args } : {};
  switch (toolName) {
    case 'bash':
    case 'powershell': {
      // Pi counts seconds, the shell row shows milliseconds.
      if (typeof input.timeout === 'number') input.timeout = Math.round(input.timeout * 1000);
      return input;
    }
    case 'ls':
      return { ...input, path: typeof input.path === 'string' && input.path ? input.path : (cwd ?? '.') };
    case 'grep': {
      if (typeof input.glob === 'string') input.include = input.glob;
      if (typeof input.ignoreCase === 'boolean') input.caseSensitive = !input.ignoreCase;
      return input;
    }
    case 'edit': {
      const first = Array.isArray(input.edits) ? input.edits.find(isRecord) : undefined;
      if (first) {
        input.oldString = first.oldText;
        input.newString = first.newText;
      }
      return input;
    }
    default:
      return input;
  }
};

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

const NO_OUTPUT = '(no output)';
/** What the permission gate tells the model when the user rejects a call without writing a message. */
export const REJECTED_TOOL_TEXT = 'The user rejected this tool call.';
/** Start of what the gate tells the model when a rule forbids a call. */
export const DENIED_TOOL_TEXT_PREFIX = 'The user has specified a rule';
const DISMISSED_QUESTION = 'The user dismissed this question';
const SHELL_EXIT_MARKER = /(?:^|\n\n)Command exited with code (-?\d+)\s*$/;
const ABORTED_TOOL_TEXT = /^(?:Command|Operation|Request) (?:was )?aborted\b|^This operation was aborted/i;

/** Pi content items as wire tool content: text stays, images become file items. */
const toolContent = (content) => {
  const items = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      items.push({ type: 'text', text: item.text });
    } else if (item.type === 'image' && typeof item.data === 'string') {
      const mime = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream';
      items.push({ type: 'file', uri: `data:${mime};base64,${item.data}`, mime });
    }
  }
  return items;
};

const textOfItems = (items) => items.filter((item) => item.type === 'text').map((item) => item.text).join('\n');

const countPatch = (patch) => {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      additions += 1;
    } else if (inHunk && line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
};

/**
 * Pi's edit patch with the header OpenCode's diffs carry (`Index:` and a rule),
 * which the UI's diff parser handles either way; the header keeps the stored
 * shape identical to what the reference server produced.
 */
const withIndexHeader = (file, patch) => (patch.startsWith('Index:')
  ? patch
  : `Index: ${file}\n${'='.repeat(67)}\n${patch}`);

// grep, find and ls report a reached limit as a number (the limit) or true.
const limitReached = (value) => value !== undefined && value !== null && value !== false;

const truncationOf = (details, structured) => (
  details?.truncation?.truncated === true
  || limitReached(details?.matchLimitReached)
  || limitReached(details?.resultLimitReached)
  || limitReached(details?.entryLimitReached)
  || (isRecord(structured) && structured.truncated === true)
);

const failure = (type, message) => ({ status: 'error', error: { type, message } });

/**
 * A finished Pi tool call as the wire result.
 *
 * `structuredContent` exists only on the live `tool_execution_end` event and
 * the stored `toolResult` has no copy of it, so nothing here may depend on it
 * for a value the stored view also needs: the shell exit code comes from the
 * `Command exited with code N` line Pi appends to the text.
 *
 * A call the permission gate blocked is only an error result whose text is the
 * reason. `blocked` is what the gate recorded for it (live); without it the
 * text decides, which recognizes the two reasons the gate words itself
 * (`REJECTED_TOOL_TEXT` and `DENIED_TOOL_TEXT_PREFIX`). A rejection the user
 * wrote their own message for cannot be told from any other error afterwards.
 *
 * @param {object} input
 * @param {{ kind: 'rejected'|'denied', message: string }} [input.blocked]
 * @returns {{ status: 'completed', content: object[], metadata?: object }
 *   | { status: 'error', error: { type: string, message: string }, metadata?: object }}
 */
export const mapToolResult = ({ toolName, args, cwd, content, details, isError, structuredContent, blocked }) => {
  const items = toolContent(content);
  const text = textOfItems(items);
  const metadata = {};
  if (isRecord(details?.openchamber)) metadata.openchamber = details.openchamber;
  const failed = (type, message) => ({ ...failure(type, message), ...(Object.keys(metadata).length ? { metadata } : {}) });

  if (blocked && isError === true) {
    return failed(blocked.kind === 'rejected' ? 'permission.rejected' : 'tool.execution', String(blocked.message ?? text));
  }

  if (toolName === 'question') {
    // The managed question tool reports how it ended in `details`.
    if (details?.dismissed === true) return failed('aborted', DISMISSED_QUESTION);
    if (details?.interrupted === true) return failed('aborted', 'Tool execution interrupted');
    if (isError !== true && Array.isArray(details?.answers)) {
      return {
        status: 'completed',
        content: items.length > 0 ? items : [{ type: 'text', text: NO_OUTPUT }],
        metadata: { ...metadata, answers: details.answers, truncated: false },
      };
    }
  }

  if (isError === true) {
    if ((toolName === 'bash' || toolName === 'powershell') && SHELL_EXIT_MARKER.test(text)) {
      // A shell command that exits non-zero ran to its end: the UI shows it as
      // a finished call with the exit code, like the reference server does.
      return shellResult({ items, details, structuredContent, metadata });
    }
    const reason = text.trim();
    if (reason === REJECTED_TOOL_TEXT) return failed('permission.rejected', reason);
    if (reason.startsWith(DENIED_TOOL_TEXT_PREFIX)) return failed('tool.execution', reason);
    if (ABORTED_TOOL_TEXT.test(reason)) return failed('aborted', 'Tool execution interrupted');
    return failed('tool.execution', reason || 'The tool failed.');
  }

  switch (toolName) {
    case 'bash':
    case 'powershell':
      return shellResult({ items, details, structuredContent, metadata });
    case 'edit': {
      const patch = typeof details?.patch === 'string' && details.patch ? details.patch : undefined;
      if (patch) {
        const file = relativeToCwd(isRecord(args) ? args.path : undefined, cwd) ?? 'file';
        metadata.files = [{ file, patch: withIndexHeader(file, patch), status: 'modified', ...countPatch(patch) }];
      }
      metadata.truncated = false;
      break;
    }
    case 'read':
    case 'ls':
    case 'grep':
    case 'find':
      metadata.truncated = truncationOf(details, structuredContent);
      if (typeof details?.fullOutputPath === 'string') metadata.outputPath = details.fullOutputPath;
      break;
    case 'write':
      metadata.truncated = false;
      break;
    case 'subagent':
      // The child session the call started, so the row can open it.
      if (typeof details?.sessionID === 'string') {
        metadata.sessionID = details.sessionID;
        metadata.status = typeof details.status === 'string' ? details.status : 'completed';
        metadata.truncated = false;
      }
      break;
    default:
      break;
  }
  return {
    status: 'completed',
    content: items.length > 0 ? items : [{ type: 'text', text: NO_OUTPUT }],
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
};

const shellResult = ({ items, details, structuredContent, metadata }) => {
  let exit = 0;
  const output = items.map((item) => ({ ...item }));
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (output[index].type !== 'text') continue;
    const match = SHELL_EXIT_MARKER.exec(output[index].text);
    if (match) {
      exit = Number(match[1]);
      output[index].text = output[index].text.slice(0, match.index);
      if (output[index].text === '') output.splice(index, 1);
    }
    break;
  }
  const hasText = output.some((item) => item.type === 'text' && item.text !== '');
  const content = hasText || output.some((item) => item.type === 'file') ? output : [{ type: 'text', text: NO_OUTPUT }];
  if (exit !== 0) content.push({ type: 'text', text: `Exited with code ${exit}` });
  const shellMetadata = { status: 'completed', truncated: truncationOf(details, structuredContent), exit, ...metadata };
  if (typeof details?.fullOutputPath === 'string') shellMetadata.outputPath = details.fullOutputPath;
  return { status: 'completed', content, metadata: shellMetadata };
};

// ---------------------------------------------------------------------------
// Usage, cost, finish
// ---------------------------------------------------------------------------

export const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: Object.freeze({ read: 0, write: 0 }) });

/**
 * Pi counts `output` including `reasoning`; the wire's `output` excludes it
 * (reference server: `output = completion_tokens - reasoning_tokens`). Pi's
 * `input` already excludes cached tokens, as the wire's does.
 */
export const tokensFromUsage = (usage) => {
  const reasoning = finiteNumber(usage?.reasoning);
  return {
    input: finiteNumber(usage?.input),
    output: Math.max(0, finiteNumber(usage?.output) - reasoning),
    reasoning,
    cache: { read: finiteNumber(usage?.cacheRead), write: finiteNumber(usage?.cacheWrite) },
  };
};

export const costFromUsage = (usage) => finiteNumber(usage?.cost?.total);

/** Whether the provider reported usage; a failed step without it carries no tokens or cost. */
export const hasUsage = (usage) => isRecord(usage)
  && (finiteNumber(usage.totalTokens) > 0 || finiteNumber(usage.input) > 0 || finiteNumber(usage.output) > 0
    || finiteNumber(usage.cacheRead) > 0 || finiteNumber(usage.cacheWrite) > 0);

export const addTokens = (a, b) => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
});

/** The session totals after one more model call. Totals are always absolute. */
export const addUsage = (totals, usage) => ({
  cost: totals.cost + costFromUsage(usage),
  tokens: addTokens(totals.tokens, tokensFromUsage(usage)),
});

const FINISH_BY_STOP_REASON = {
  stop: 'stop',
  length: 'length',
  toolUse: 'tool-calls',
  error: 'error',
  aborted: 'error',
  deferred: 'unknown',
};

/** Wire `finish` for a Pi `stopReason`. */
export const finishFromStopReason = (stopReason) => FINISH_BY_STOP_REASON[stopReason] ?? 'unknown';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ABORTED_ERROR = Object.freeze({ type: 'aborted', message: 'Step interrupted' });
// Pi's own wording for a user abort: "Request was aborted" (while the response
// streams, stopReason "aborted") and "This operation was aborted" (a Node
// AbortError, stopReason "error" when the abort lands during a tool).
const ABORT_MESSAGE = /^(?:request was aborted|this operation was aborted|operation aborted|aborted)\b/i;
const STATUS_PREFIX = /^(\d{3})\b\s*[:\-]?\s*/;
const STATUS_IN_TEXT = /\b(?:status(?:\s*code)?|http)[\s:=]+(\d{3})\b/i;
const TRANSPORT = /connection error|connection (?:lost|closed|reset|refused)|econn(?:reset|refused|aborted)|enotfound|eai_again|etimedout|epipe|socket hang up|fetch failed|network (?:error|is unreachable)|terminated|other side closed|timed? ?out|timeout|stream (?:ended|closed) unexpectedly/i;
const RATE_LIMIT = /rate[ _-]?limit|too many requests|overloaded|resource[ _]exhausted|quota|capacity/i;
const CONTEXT_OVERFLOW = /context (?:length|window)|maximum context|prompt is too long|too many tokens|exceeds? the (?:model'?s )?context/i;

const retryAfterMsOf = (text) => {
  const after = /retry[- ]after\D{0,6}(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds|m|min|minutes)?/i.exec(text)
    ?? /try again in\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds|m|min|minutes)\b/i.exec(text)
    ?? /retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*(s|ms)\b/i.exec(text);
  if (!after) return undefined;
  const value = Number(after[1]);
  const unit = (after[2] ?? 's').toLowerCase();
  const factor = unit.startsWith('ms') || unit.startsWith('milli') ? 1 : unit.startsWith('m') ? 60_000 : 1000;
  return Math.round(value * factor);
};

const parseJsonObject = (text) => {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  try {
    const value = JSON.parse(text.slice(start));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A Pi provider failure as the wire's structured error.
 *
 * Pi reports a failure only as `errorMessage` text, which carries an HTTP
 * status as a leading `NNN: <body>` for the OpenAI/Anthropic/Google SDK errors
 * and plain wording for connection errors ("Connection error."), so the type is
 * classified from the text:
 *
 * - user abort wording or `stopReason: "aborted"`: `aborted`, "Step interrupted"
 * - status 429 or wording like rate limit, overloaded, quota: `provider.rate-limit`
 * - other 5xx: `provider.internal`
 * - 408 and connection wording (ECONNRESET, fetch failed, timeout, ...): `provider.transport`
 * - other 4xx and context overflow wording: `provider.invalid-request`
 * - anything else: `provider.unknown`
 *
 * `status` is the leading code when present. `response.body` keeps the text
 * after it, and `message` is the provider's own message when that body is JSON.
 * `retryAfterMs` is read from "retry-after" or "try again in" wording; Pi does
 * not pass response headers on, so it is usually absent.
 */
export const classifyProviderError = (errorMessage, { stopReason } = {}) => {
  const raw = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  if (stopReason === 'aborted' || ABORT_MESSAGE.test(raw)) return { ...ABORTED_ERROR };

  let status;
  let body;
  const prefixed = STATUS_PREFIX.exec(raw);
  if (prefixed) {
    status = Number(prefixed[1]);
    body = raw.slice(prefixed[0].length);
  } else {
    const inText = STATUS_IN_TEXT.exec(raw);
    if (inText) status = Number(inText[1]);
  }
  const json = parseJsonObject(body ?? raw);
  const providerMessage = (isRecord(json?.error) ? json.error.message : undefined) ?? json?.message;
  if (status === undefined && isRecord(json)) {
    const embedded = Number(isRecord(json.error) ? json.error.status ?? json.error.code : json.status ?? json.code);
    if (Number.isInteger(embedded) && embedded >= 100 && embedded < 600) status = embedded;
  }

  let type = 'provider.unknown';
  if (status === 429 || status === 529 || RATE_LIMIT.test(raw)) type = 'provider.rate-limit';
  else if (status !== undefined && status >= 500) type = 'provider.internal';
  else if (status === 408 || (status === undefined && TRANSPORT.test(raw))) type = 'provider.transport';
  else if ((status !== undefined && status >= 400) || CONTEXT_OVERFLOW.test(raw)) type = 'provider.invalid-request';

  const error = { type, message: typeof providerMessage === 'string' && providerMessage ? providerMessage : (raw || 'The model request failed.') };
  if (status !== undefined) error.status = status;
  if (body) error.response = { body };
  const retryAfterMs = retryAfterMsOf(raw);
  if (retryAfterMs !== undefined && type === 'provider.rate-limit') error.retryAfterMs = retryAfterMs;
  return error;
};

/** The wire error of a finished Pi assistant message, or undefined when it did not fail. */
export const errorOfAssistantMessage = (message) => {
  if (message?.stopReason !== 'error' && message?.stopReason !== 'aborted') return undefined;
  return classifyProviderError(message.errorMessage, { stopReason: message.stopReason });
};

// ---------------------------------------------------------------------------
// Ids
//
// A message id is `msg_` + 12 hex of `timestampMs * 4096 + slot` + 14 base62
// characters hashed from what identifies the message. Both halves come only
// from data that is identical in the live stream and in the stored file:
// verified with Pi 1.5.0 (wire/fixtures/*), `message.timestamp` is the same in
// `message_start`, `message_end` and the persisted entry for user, assistant and
// toolResult messages. The slot breaks ties inside one millisecond and puts the
// messages in conversation order (a user message and the assistant message
// answering it can share a millisecond; the idle message of a run sorts after
// everything of that millisecond and before anything of the next).
// ---------------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TIME_MASK = (1n << 48n) - 1n;

export const MESSAGE_SLOT = Object.freeze({
  user: 0x001,
  assistant: 0x002,
  notice: 0x003,
  idle: 0xffe,
  compaction: 0xfff,
});

const hashBase62 = (seed, length = 14) => {
  let value = BigInt(`0x${createHash('sha256').update(seed).digest('hex')}`);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += BASE62[Number(value % 62n)];
    value /= 62n;
  }
  return result;
};

// A session with an `idSalt` (a fork, whose history is a copy of another
// session's) gets its own hash half: the UI keeps message parts in one map per
// folder, keyed by message id, so two sessions that share ids would overwrite
// each other's parts. The time half is unchanged, so order stays chronological.
const messageId = (timestamp, slot, seed, salt) => {
  const ms = BigInt(Math.max(0, Math.floor(finiteNumber(timestamp))));
  const sortable = (ms * 0x1000n + BigInt(slot)) & TIME_MASK;
  return `msg_${sortable.toString(16).padStart(12, '0')}${hashBase62(salt ? `${salt}\u0000${seed}` : seed)}`;
};

const lookupClientId = (clientIds, timestamp) => {
  if (!clientIds) return undefined;
  const found = clientIds instanceof Map
    ? (clientIds.get(timestamp) ?? clientIds.get(String(timestamp)))
    : clientIds[timestamp];
  return typeof found === 'string' && found.startsWith('msg_') ? found : undefined;
};

/**
 * Id of a Pi user message. `clientIds` maps the message timestamp to the id the
 * UI minted for it, so the stored transcript keeps the id the UI painted;
 * the coordinator persists that map (the translator reports each binding).
 */
export const userMessageId = (timestamp, clientIds, salt) => lookupClientId(clientIds, timestamp)
  ?? messageId(timestamp, MESSAGE_SLOT.user, `user:${timestamp}`, salt);

export const assistantMessageId = (timestamp, salt) => messageId(timestamp, MESSAGE_SLOT.assistant, `assistant:${timestamp}`, salt);

/** Shell (`bashExecution`) messages are client-minted too, so they honor `clientIds` the same way. */
export const shellMessageId = (timestamp, clientIds, salt) => lookupClientId(clientIds, timestamp)
  ?? messageId(timestamp, MESSAGE_SLOT.notice, `shell:${timestamp}`, salt);

/** The id of the shell process a `bashExecution` message stands for. */
export const shellProcessId = (timestamp, salt) => `sh_${messageId(timestamp, MESSAGE_SLOT.notice, `process:${timestamp}`, salt).slice(4)}`;

/** Ids of the notices a Pi entry stands for (model switch, custom message, branch summary). */
export const noticeMessageId = (kind, timestamp, key = timestamp, salt) => messageId(timestamp, MESSAGE_SLOT.notice, `${kind}:${key}`, salt);

/** The idle message of the run whose last message has `timestamp`: after it, before the next message. */
export const idleMessageIdAfter = (timestamp, salt) => messageId(timestamp, MESSAGE_SLOT.idle, `idle:${timestamp}`, salt);

/** The compaction record that follows the message with `timestamp` (and its idle message). */
export const compactionMessageIdAfter = (timestamp, salt) => messageId(timestamp, MESSAGE_SLOT.compaction, `compaction:${timestamp}`, salt);

// ---------------------------------------------------------------------------
// Model and variant
// ---------------------------------------------------------------------------

/**
 * Pi's thinking level is the wire variant, one to one. A missing level is the
 * wire's `default`; `off` stays `off`, so the model list the bridge serves has
 * to name the same levels as variants.
 */
export const variantFromThinkingLevel = (level) => (typeof level === 'string' && level ? level : 'default');
export const thinkingLevelFromVariant = (variant) => (variant === 'default' || !variant ? undefined : variant);

/** `{id, providerID, variant}` of what produced a Pi assistant message (or was selected). */
export const modelRef = ({ provider, model, thinkingLevel }) => ({
  id: String(model ?? 'unknown'),
  providerID: String(provider ?? 'unknown'),
  variant: variantFromThinkingLevel(thinkingLevel),
});

// ---------------------------------------------------------------------------
// User messages
// ---------------------------------------------------------------------------

/** Text and attachments of a Pi user message (string content, or text and image blocks). */
export const userPayloadFromContent = (content) => {
  if (typeof content === 'string') return { text: content, files: [] };
  const texts = [];
  const files = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string') {
      files.push({ data: block.data, mime: typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream', source: { type: 'inline' } });
    }
  }
  return { text: texts.join('\n'), files };
};

/** The wire content item for each Pi assistant content block, in order; null for blocks the UI has no row for. */
export const contentKind = (block) => {
  if (block?.type === 'text') return 'text';
  if (block?.type === 'thinking') return 'reasoning';
  if (block?.type === 'toolCall') return 'tool';
  return null;
};
