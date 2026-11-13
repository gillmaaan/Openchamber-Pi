# Pi to OpenCode wire format: notes

Three pure modules turn Pi 1.5.0 (`pi --mode rpc`) into the OpenCode 2.2.6 dialect the UI speaks. They hold no I/O. The one timer is the injectable one behind `whenCallNumbered`.

| File | What it does |
| --- | --- |
| `mapping.js` | The rules both other modules share: tool names, tool input and result, usage, finish, error classes, message ids, model and variant. |
| `transcript.js` | `entriesToWireMessages({ entries, cwd, agent, clientIds, running })` turns the active branch of a session file into the page `GET /api/session/:id/message` serves. `appendInflight` and `usageTotalsFromEntries` go with it. |
| `translator.js` | `createEventTranslator(options)` turns live Pi events into wire events for one session. |
| `fixtures/*.json`, `fixtures/record.mjs` | Real Pi 1.5.0 event streams and session files, and the script that records them. |
| `test-support/replay.js`, `test-support/opencode-schema.js` | Replays a fixture the way the coordinator drives the translator; decoders from `@opencode/schema`. |

## Translator API

`onPiEvent(event)` returns `{ type, data, durable?, ...extra }[]`. The hub adds `id`, `created` and `location`. `durable: true` marks what OpenCode persists; the flag matches the schema's own `durability` for every type the translator emits (a test checks it).

Two events carry a sibling field that is not part of the wire: the execution terminals (`session.execution.succeeded|failed|interrupted`) have `idleMessage`, the wire message the UI will read on its next page for that run. The hub must drop it from the frame. A compaction that ran by itself has none (see Runs and idle messages).

Other members:

- `enqueueInbox({ inboxID, type?, text, files, agents, skills, metadata, description, delivery })` returns the `session.inbox.enqueued` event. `type` is `user` (default), `synthetic` or `compaction`. `cancelInbox(id)` returns `session.inbox.cancelled`. `deliverInbox(id)` returns `session.inbox.delivered` for an item that reaches the model without a Pi user message of its own. `pendingInbox()` lists what is waiting.
- `inflightAssistantMessage()` is the half-built assistant message of the open step, or null. `appendInflight(messages, inflight)` puts it into a stored page.
- `execution` is `{ active, owner: 'agent'|'compaction'|null }`. `totals()` is the absolute session usage. `retry` is the waiting retry or null. `lastMessageTimestamp` is what idle and compaction ids anchor on.
- `assistantMessageIdForCall(id)` and `whenCallNumbered(id, timeoutMs)` answer which assistant message holds a tool call. The promise resolves after the call's `session.tool.called` event was returned from `onPiEvent`, so a caller that publishes the returned events synchronously keeps the order tool.called, permission.asked. A call a codemode script made (Pi events with `parentToolCallId`, or an id of the form `<parent>/<n>`) maps to the script's call. It resolves to undefined after the timeout or when the process exits.
- `onProcessExit({ code, signal })` closes what a dead child left open (see below).
- Options: `sessionId`, `cwd`, `getAgent`, `totals`, `getThinkingLevel` (pass it: Pi puts `thinkingLevel` on a message only when it ends, so a step's variant at `step.started` comes from here), `now`, `clientIds`, `onClientId({ timestamp, id })`, `lastMessageTimestamp`, `classifyToolEnd(toolCallId, event)`, `setTimeoutImpl`, `clearTimeoutImpl`.

## Decisions

### Ids

`message.timestamp` is the same number in `message_start`, `message_end` and the persisted entry for user, assistant and toolResult messages. Checked on every message of 15 recorded sessions (`mapping.test.js`). Events and entries carry no message ids, so this timestamp is the join key.

A message id is `msg_` + 12 hex digits of `(timestampMs * 4096 + slot)` masked to 48 bits + 14 base62 characters taken from `sha256("<role>:<timestamp>")`. The slot orders messages that share a millisecond: user 1, assistant 2, notices (model switch, shell, custom message) 3, idle `0xffe`, compaction `0xfff`. This happens: in the compaction fixture a user message and the assistant message answering it carry the same millisecond.

The timestamp of a steered or queued user message is the moment Pi accepted it, which is earlier than the tool result that precedes it in the file. Sorting by id still puts it between the assistant message that was running and the next one, because it is always later than the start of the message that was running.

`clientIds` maps a user (or shell) message timestamp to the id the UI minted. The translator reports each pairing through `onClientId` when a pending inbox item meets its Pi user message; the coordinator persists the map and passes it back to `entriesToWireMessages`. Without an entry the id is derived. A UI id sorts by the UI's clock, as it does with OpenCode.

A request that failed before any output and is retried keeps one assistant message id: the first attempt's. The reference server does the same (spec 4.4 rule 7).

### Tools

`bash`/`powershell` become `shell`, `find` becomes `glob`, `ls` becomes `read` (input `path` defaults to the session directory), `codemode` becomes `execute` (`input.code` is the script in both). `read`, `edit`, `write`, `grep`, the managed `question` tool, MCP and other extension tools keep their name.

Input: shell `timeout` goes from seconds to the milliseconds the row shows. `edit` gets `oldString`/`newString` from its first edit next to Pi's `edits`. `grep` gets `include` from `glob` and `caseSensitive` from `ignoreCase`, both originals stay.

Result:

- Shell. Pi marks a non-zero exit as an error result with the text `...\n\nCommand exited with code N`. That becomes `tool.success` with the output, an extra `Exited with code N` text item and `metadata {status:'completed', truncated, exit}`, as the reference server reports it. The exit code comes from the text because the stored `toolResult` has no `structuredContent`. A timeout (`Command timed out after N seconds`) is a failure; `Command aborted` is `aborted`.
- Edit. `metadata.files` is built from `details.patch` with an `Index:` header, additions and deletions counted from the hunks, `file` relative to the session directory. Write has no `details` in Pi, so it gets `metadata {truncated:false}` and no `files`; the UI previews a write from its input.
- Truncation: `details.truncation.truncated` or a reached grep, find or ls limit. `details.fullOutputPath` becomes `metadata.outputPath`.
- An image result becomes a `file` content item with a data URI. An empty result reads `(no output)`.
- `details.openchamber` becomes `metadata.openchamber` unchanged.
- Blocked calls. The gate's block is only an error result in Pi's stream. `classifyToolEnd(toolCallId, event)` is asked once per call that ends with `isError`, for top-level and for nested calls (so the recorded block of a nested call is taken). `rejected` becomes `error.type: 'permission.rejected'`, `denied` becomes `tool.execution`. For a stored session the text decides: exactly `The user rejected this tool call.` is `permission.rejected`, text starting with `The user has specified a rule` is `tool.execution`. A rejection the user wrote their own message for reads as `tool.execution` after a reload, because nothing in the file marks it.
- `question`. `details {answers, truncated:false}` goes into `metadata` of the success. `{dismissed:true}` fails as `aborted` with `The user dismissed this question`. `{interrupted:true}` fails as `aborted` with `Tool execution interrupted`. Stored results use the same `details`.
- Nested calls of a codemode script (`parentToolCallId`) produce no events and no transcript entries, so an `execute` row shows its script and result only.
- A shell running in a live step sends `session.tool.progress` with `metadata {output}` (the running row shows it). The final event replaces it. A failed call that streamed output sends `metadata {}` so the live state and the stored one agree.

### Usage, finish, errors

Pi's `output` includes `reasoning`; the wire's does not. `tokens = {input, output - reasoning, reasoning, cache:{read, write}}`. Pi's `input` already excludes cached tokens, as the wire's does. Cost is `usage.cost.total`. A step with no usage reports no tokens and no usage update. `session.usage.updated` carries absolute totals: the translator adds to `totals` and the coordinator seeds it (`usageTotalsFromEntries` gives the total of a file).

`stopReason` maps to `finish`: stop `stop`, length `length`, toolUse `tool-calls`, error and aborted `error`, deferred `unknown`.

`session.step.failed` has no `finish`. The schema allows only `content-filter` there and the UI defaults to `error`.

Pi reports a failure only as `errorMessage` text. `classifyProviderError` reads it:

| Text | Type |
| --- | --- |
| `stopReason: aborted`, "Request was aborted", "This operation was aborted" | `aborted`, "Step interrupted" |
| status 429 or 529, or wording like rate limit, overloaded, quota, capacity | `provider.rate-limit` |
| other 5xx | `provider.internal` |
| 408, or wording like Connection error, ECONNRESET, fetch failed, terminated, timeout | `provider.transport` |
| other 4xx, or context overflow wording | `provider.invalid-request` |
| anything else | `provider.unknown` |

The status is the leading `NNN:` (OpenAI, Anthropic and Google SDK errors), a "status 502" phrase, or a code inside a JSON body. `message` is the provider's own message when the body is JSON; `response.body` keeps the text after the code. `retryAfterMs` is read from "retry-after" or "try again in" wording. Pi does not pass response headers on, so it is usually absent. Only the mock's error strings were recorded.

Abort during a tool arrives as an assistant message with `stopReason: error` and "This operation was aborted", with `agent_settled.aborted: true`. Both count as an interruption.

### Steps

`step.started` at the assistant `message_start`; text, reasoning and tool events from `message_update`; `step.streamed` at `message_end`; `step.ended` or `step.failed` plus `usage.updated` at `turn_end`, after every tool result is in. This is the order of the reference server (spec 4.4 rules 2, 3, 5). Pi's `message_end` is authoritative: blocks the stream left open end with their final text, and blocks it never streamed are announced then. The snapshot in `message_start` is ignored (it repeats the first block the deltas also carry).

`tool.input.ended` and `tool.called` come together at `toolcall_end`. `session.tool.input.delta` is never emitted. A streaming call shows `input: ""` in a page until its arguments are complete, as the reference server does.

Text and reasoning ordinals count per kind in content order, in events and in the stored content.

### Retries

An assistant message that failed with nothing streamed is held at `turn_end`. At `agent_end`, `willRetry: true` keeps it; the reference server's flow follows: `session.retry.scheduled {attempt: n + 1, at: now + delayMs}` at `auto_retry_start`, then `step.started` with the same `assistantMessageID` for the next attempt. A failure that will not be retried (`willRetry: false`) emits `step.failed` then. A failed attempt that streamed something closes at once with `step.failed`, and its retry is a new message.

The stored view mirrors it: an empty failed assistant entry that a `context_edit {replacement: null}` hides is not shown, and the entry that follows takes its id and `time.created`. The last failure of a chain stays as one failed message.

### Runs and idle messages

The UI creates no idle message from events; only pages carry them. `execution.started` comes at the first `agent_start` of a cycle, the terminal at `agent_settled`: `interrupted` (reason `user`, never `shutdown`) when `aborted` is set or the last assistant message was aborted, `failed` when it ended in a non-abort error, else `succeeded`. `idleMessage` on the terminal carries `idleMessageIdAfter(timestamp of the last user or assistant message)`.

Pi writes no run boundary into the file, so the stored view infers one. A run ends after an assistant message whose `stopReason` is not `toolUse`, when the next message is a user message or the branch ends. A user message after a tool step is steering and stays in the run. Consequences:

- A follow-up queued while the agent runs gets an idle message before it in a stored page, which the live stream did not announce.
- A run that ends in a tool step or without an answer (the process died) reads as `interrupted`. The live `onProcessExit` reports `failed`, so a reload changes that idle outcome.
- `running: true` leaves the last run open: no idle message, and a tool call without a result stays `running`. Without the flag such a call reads as `error`.

### Inbox

`enqueueInbox` is called when the coordinator accepts a prompt. A Pi user message takes the first pending user item with equal text, else the oldest pending user item (Pi expands `/skill:` commands, so the text can differ), else nothing is pending and the translator emits an `enqueued` and `delivered` pair with a derived id (a message typed in the Pi CLI). `delivered` is emitted at the user `message_start`.

### Compaction

`compaction_start` and `compaction_end` become `session.compaction.started`, `session.usage.updated`, `session.compaction.ended` or `.failed`. A manual compaction has no `agent_start`, so it opens and closes its own execution. An automatic one inside a cycle leaves the cycle's execution alone.

The record's id is the pending `compaction` inbox item's id when the coordinator queued one, else `compactionMessageIdAfter(lastMessageTimestamp)`. A stored compaction entry derives the same id from the timestamp of the last user or assistant message before it. So a coordinator that wants live and stored ids to match answers `POST /compact` with `compactionMessageIdAfter(translator.lastMessageTimestamp)`. Pi streams no summary, so there are no `compaction.delta` events. The entry does not record whether the compaction was manual, so a stored one reads `reason: manual`. `metadata.keepID` is the wire id of the message `firstKeptEntryId` points at.

A compaction-only execution has no idle record in a stored page, because it would anchor on the previous run's idle id. It has no `idleMessage` either.

### Process exit

`onProcessExit({ code, signal })` returns nothing when nothing runs. Otherwise: a held failed attempt fails; an open step ends its text and reasoning blocks with what streamed, fails its unfinished tool calls as `aborted`, then `step.failed` with `{type: 'provider.transport', message: 'The agent process stopped unexpectedly (signal SIGKILL).'}` (or `(code 137)`), with the usage Pi reported so far and a `usage.updated` when there is some; a running compaction fails; then `session.execution.failed` with the same error and its `idleMessage` (outcome `failed`). Afterwards the translator is idle. Inbox items nobody delivered stay pending: cancel or resend them. A synthetic `agent_settled {aborted: true}` closes an open step the same way, with the `aborted` error instead of the transport one.

The partial step is a live-only record when the response had not reached the file: Pi writes a message when it ends, so after a reload that step is gone. A step whose response was complete (the call is waiting on a tool) is in the file; there the live message says `finish: error` with the transport error and the stored one keeps Pi's `tool-calls`.

## Verified

Against recorded Pi 1.5.0 sessions (scenarios in `fixtures/record.mjs`: plain, reasoning, reasoning plus bash, four tool steps with parallel calls and failures, truncation and timeout, abort while streaming, abort during a tool, connection reset, HTTP 500, 429, 400, a flaky request that recovers, a steer prompt, manual compaction, model and thinking changes with a user shell command and an image prompt):

- Every wire message from a stored session decodes with `SessionMessage.Info` from `@opencode/schema`; every translator event decodes with its definition's `data` schema and has the schema's durability; idle messages and every in-flight message decode.
- `ui-consistency.test.js` folds the translator's events through the UI's own `translateWireEvent` and `applyDirectoryEvent`, projects the stored messages through the UI's `projectMessage`, and compares messages, parts, tool states, usage and finish. They are equal for all 15 sessions, including ids, ordering and the retry that reuses a message. Run outcome, session totals, idle ids and the compaction record agree too.
- The same file compares a page read at every moment of every session (the file as far as Pi had written it plus `inflightAssistantMessage()`) with what the live events had built at that moment: part ids, ended text, tool states in `pending`, `running`, `completed` and `error`.
- A stream cut off mid-text, mid-tool and during parallel tools, closed by `onProcessExit`, leaves the UI idle with a failed outcome and no open message or part.
- The event order obeys spec 4.4 on every session: execution frames the run, every step opens and closes, tool calls go started, called, settled, deltas add up to the ended text.

`wire/test-support` loads `effect` from the directory `@opencode/schema` resolves it in, because `effect` is not a dependency of the web workspace.

## Not verified

- Provider error strings other than the mock's (real Anthropic, OpenAI, Google, Bedrock). The classifier is a heuristic over the formats named above.
- `retryAfterMs` from a real 429 (Pi hides the header).
- Image results from `read`, redacted thinking blocks, extension tools and codemode (hand-made events only), `custom_message` and branch summaries from a real session (hand-made entries), `powershell`, Windows paths.
- The gate, `classifyToolEnd` and the `question` tool against a real Pi run. The tests feed hand-made events with the shapes `PERMISSIONS-NOTES.md` describes.
- A real automatic compaction (`threshold` or `overflow`); only the manual one was recorded.
- Pi versions other than 1.5.0. `fixtures/record.mjs` regenerates the fixtures; the tests then show what changed.

## Questions for the coordinator

1. Ids that the UI derives from the event id. The UI names the message of `session.synthetic`, `session.model.selected`, `session.agent.selected`, `session.shell.started`, `session.skill.activated` and `session.instructions.updated` after the hub's event id (`evt_X` becomes `msg_X`). A stored page derives them from Pi's data (`noticeMessageId`, `shellMessageId`). They differ unless the hub mints the event id from the stored id, which keeps ids ascending only if the stored time prefix is near the event time. Which route?
2. Variants. The variant is Pi's thinking level, `default` when missing, and `off` stays `off`. `/api/model` has to list the levels (including `off` for models that reason) as variants, or the pickers will not show the one a message used.
3. `delivery`. Pi's `steer` and `followUp` map to `steer` and `queue`; the translator only reports delivery order. After an abort, items still pending stay in `pendingInbox()`; cancel or keep them.
4. Retry display. A retried empty failure is one message with `retry` set, as OpenCode shows it. If the UI should show each attempt, turn off the hold in `closeStep`.
5. `running`. The coordinator has to pass `running: true` to `entriesToWireMessages` while a turn runs (`translator.execution.active`) and `appendInflight` the translator's message.
6. Seeding. Pass `totals: usageTotalsFromEntries(entries)`, `clientIds` and `lastMessageTimestamp` (the last user or assistant timestamp in the file) when a translator starts for an existing session, and `getThinkingLevel` from Pi's state.
7. Title and name events (`session_info_changed`, session name) and `queue_update` are not translated.
8. Hub: drop `idleMessage` from the frame; use `idleMessage` to answer the next page without rereading the file if wanted.
9. The `entriesToWireMessages` signature in the brief had `sessionTotals`; messages carry no session totals, so it is not a parameter. Totals come from `usageTotalsFromEntries`.

## Re-recording

```
cd packages/web && node server/lib/pi/wire/fixtures/record.mjs [scenario...]
```

Each scenario starts an isolated Pi against a mock OpenAI server (its own agent directory and HOME), drives it over RPC and stores every stdout event and every session entry. System messages are reduced to a stub and the temp directory becomes `/work`. The tests read only the JSON.
