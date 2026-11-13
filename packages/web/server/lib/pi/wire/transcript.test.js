import { describe, expect, it } from 'vitest';

import { activeBranch } from '../session-files.js';
import {
  assistantMessageId,
  compactionMessageIdAfter,
  idleMessageIdAfter,
  userMessageId,
} from './mapping.js';
import { loadWireSchemas } from './test-support/opencode-schema.js';
import { FIXTURE_NAMES, loadFixture } from './test-support/replay.js';
import { appendInflight, entriesToWireMessages, usageTotalsFromEntries } from './transcript.js';

const CWD = '/work/project';
const T0 = 1_794_000_000_000;

const usage = (input, output, extra = {}) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...extra,
});

/** A branch of entries; each argument is `{type, ...fields}` and gets an id, a parent and an ISO timestamp. */
const branch = (...parts) => parts.map((part, index) => ({
  id: `e${String(index).padStart(3, '0')}`,
  parentId: index === 0 ? null : `e${String(index - 1).padStart(3, '0')}`,
  timestamp: new Date(part.at ?? T0 + index).toISOString(),
  ...part,
}));

const user = (timestamp, text = 'hello') => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }], timestamp } });
const assistant = (timestamp, content, extra = {}) => ({
  type: 'message',
  message: {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'mock',
    model: 'mock-model',
    usage: usage(10, 5),
    stopReason: 'stop',
    timestamp,
    durationMs: 20,
    thinkingLevel: 'low',
    ...extra,
  },
});
const toolResult = (timestamp, toolCallId, text, extra = {}) => ({
  type: 'message',
  message: { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text }], isError: false, durationMs: 5, timestamp, ...extra },
});

const messages = (entries, options = {}) => entriesToWireMessages({ entries: activeBranch(entries), cwd: CWD, ...options });
const types = (list) => list.map((message) => message.type);

describe('entriesToWireMessages', () => {
  it('turns a plain exchange into a user message, an assistant message and the idle message of the run', () => {
    const list = messages(branch(
      user(T0 + 10, 'hi there'),
      assistant(T0 + 20, [{ type: 'text', text: 'hello' }]),
    ));
    expect(types(list)).toEqual(['user', 'assistant', 'idle']);
    expect(list[0]).toEqual({ id: userMessageId(T0 + 10), time: { created: T0 + 10 }, type: 'user', text: 'hi there' });
    expect(list[1]).toEqual({
      id: assistantMessageId(T0 + 20),
      time: { created: T0 + 20, streamed: T0 + 40, completed: T0 + 40 },
      type: 'assistant',
      agent: 'build',
      model: { id: 'mock-model', providerID: 'mock', variant: 'low' },
      content: [{ type: 'text', text: 'hello' }],
      finish: 'stop',
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(list[2]).toEqual({ id: idleMessageIdAfter(T0 + 20), time: { created: T0 + 40 }, type: 'idle', outcome: 'succeeded' });
  });

  it('keeps reasoning, text and tool calls in the order the model produced them and folds tool results in', () => {
    const list = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [
        { type: 'thinking', thinking: 'Let me think.' },
        { type: 'text', text: 'Running it. ' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hi', timeout: 3 } },
      ], { stopReason: 'toolUse', usage: usage(100, 20, { reasoning: 8 }) }),
      toolResult(T0 + 50, 'call_1', 'hi\n'),
      assistant(T0 + 60, [{ type: 'text', text: 'Done' }]),
    ));
    expect(types(list)).toEqual(['user', 'assistant', 'assistant', 'idle']);
    const [, first] = list;
    expect(first.finish).toBe('tool-calls');
    expect(first.tokens).toEqual({ input: 100, output: 12, reasoning: 8, cache: { read: 0, write: 0 } });
    expect(first.content.map((item) => item.type)).toEqual(['reasoning', 'text', 'tool']);
    expect(first.content[0]).toMatchObject({ text: 'Let me think.', time: { created: T0 + 20, completed: T0 + 40 } });
    expect(first.content[2]).toEqual({
      type: 'tool',
      id: 'call_1',
      name: 'shell',
      executed: false,
      state: {
        status: 'completed',
        input: { command: 'echo hi', timeout: 3000 },
        content: [{ type: 'text', text: 'hi\n' }],
        metadata: { status: 'completed', truncated: false, exit: 0 },
      },
      time: { created: T0 + 20, ran: T0 + 45, completed: T0 + 50 },
    });
    expect(first.time.completed).toBe(T0 + 50);
  });

  it('shows a tool call that failed as an error state and one that exited non-zero as completed', () => {
    const list = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [
        { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'gone.txt' } },
        { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'exit 3' } },
      ], { stopReason: 'toolUse' }),
      toolResult(T0 + 30, 'a', "ENOENT: no such file or directory, access '/work/project/gone.txt'", { toolName: 'read', isError: true }),
      toolResult(T0 + 31, 'b', '\n\nCommand exited with code 3', { isError: true }),
      assistant(T0 + 40, [{ type: 'text', text: 'ok' }]),
    ));
    const [a, b] = list[1].content;
    expect(a.state).toEqual({ status: 'error', input: { path: 'gone.txt' }, error: { type: 'tool.execution', message: "ENOENT: no such file or directory, access '/work/project/gone.txt'" } });
    expect(b.state).toMatchObject({ status: 'completed', metadata: { exit: 3 } });
  });

  it('matches a tool result to the step that called it even when providers reuse call ids', () => {
    const call = { type: 'toolCall', id: 'call_0', name: 'bash', arguments: { command: 'echo' } };
    const list = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [call], { stopReason: 'toolUse' }),
      toolResult(T0 + 30, 'call_0', 'first'),
      assistant(T0 + 40, [call], { stopReason: 'toolUse' }),
      toolResult(T0 + 50, 'call_0', 'second'),
      assistant(T0 + 60, [{ type: 'text', text: 'done' }]),
    ));
    const outputs = list.filter((message) => message.type === 'assistant').flatMap((message) => message.content).filter((item) => item.type === 'tool').map((item) => item.state.content[0].text);
    expect(outputs).toEqual(['first', 'second']);
  });

  it('shows a blocked call and a question by how they ended, from the stored results', () => {
    const calls = [
      { type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'rm x' } },
      { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'rm y' } },
      { type: 'toolCall', id: 'c', name: 'question', arguments: { questions: [] } },
      { type: 'toolCall', id: 'd', name: 'question', arguments: { questions: [] } },
    ];
    const list = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, calls, { stopReason: 'toolUse' }),
      toolResult(T0 + 30, 'a', 'The user rejected this tool call.', { isError: true }),
      toolResult(T0 + 31, 'b', 'The user has specified a rule which prevents you from using this specific tool call (shell: rm *).', { isError: true }),
      toolResult(T0 + 32, 'c', 'User has answered your questions: "Q"="A".', { toolName: 'question', details: { answers: [['A']], truncated: false } }),
      toolResult(T0 + 33, 'd', 'The user dismissed this question', { toolName: 'question', isError: true, details: { dismissed: true } }),
      assistant(T0 + 60, [{ type: 'text', text: 'ok' }]),
    ));
    const [a, b, c, d] = list[1].content;
    expect(a.state.error).toMatchObject({ type: 'permission.rejected' });
    expect(b.state.error).toMatchObject({ type: 'tool.execution' });
    expect(b.state.error.message).toMatch(/^The user has specified a rule/);
    expect(c.state).toMatchObject({ status: 'completed', metadata: { answers: [['A']], truncated: false } });
    expect(d.state.error).toEqual({ type: 'aborted', message: 'The user dismissed this question' });
  });

  it('does not show a retried failed attempt and gives its retry the first attempt\'s id', () => {
    const failed = (timestamp) => assistant(timestamp, [], { stopReason: 'error', errorMessage: 'Connection error.', usage: usage(0, 0) });
    const list = messages(branch(
      user(T0 + 10),
      failed(T0 + 20),
      { type: 'context_edit', targetId: 'e001', replacement: null },
      assistant(T0 + 90, [{ type: 'text', text: 'recovered' }]),
    ));
    expect(types(list)).toEqual(['user', 'assistant', 'idle']);
    expect(list[1].id).toBe(assistantMessageId(T0 + 20));
    expect(list[1].time.created).toBe(T0 + 20);
    expect(list[1].finish).toBe('stop');
    expect(list[2].id).toBe(idleMessageIdAfter(T0 + 20));
  });

  it('keeps a failed attempt that streamed something, and the last failure of a retry chain', () => {
    const partial = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [{ type: 'text', text: 'partial' }], { stopReason: 'error', errorMessage: '500: {"message":"boom"}' }),
      { type: 'context_edit', targetId: 'e001', replacement: null },
      assistant(T0 + 90, [{ type: 'text', text: 'again' }]),
    ));
    expect(types(partial)).toEqual(['user', 'assistant', 'assistant', 'idle']);
    expect(partial[1]).toMatchObject({ finish: 'error', error: { type: 'provider.internal', status: 500, message: 'boom' } });

    const failed = (timestamp) => assistant(timestamp, [], { stopReason: 'error', errorMessage: 'Connection error.' });
    const exhausted = messages(branch(
      user(T0 + 10),
      failed(T0 + 20),
      { type: 'context_edit', targetId: 'e001', replacement: null },
      failed(T0 + 90),
    ));
    expect(types(exhausted)).toEqual(['user', 'assistant', 'idle']);
    expect(exhausted[1]).toMatchObject({ id: assistantMessageId(T0 + 20), finish: 'error', error: { type: 'provider.transport' } });
    expect(exhausted[2]).toMatchObject({ outcome: 'failed', error: { type: 'provider.transport' } });
  });

  it('ends a run with the outcome of its last answer', () => {
    const run = (last, extra) => messages(branch(user(T0 + 10), assistant(T0 + 20, [{ type: 'text', text: 'x' }], { stopReason: last, ...extra })));
    expect(run('stop').at(-1).outcome).toBe('succeeded');
    expect(run('length').at(-1).outcome).toBe('succeeded');
    expect(run('aborted', { errorMessage: 'Request was aborted' }).at(-1)).toMatchObject({ outcome: 'interrupted' });
    expect(run('error', { errorMessage: 'This operation was aborted' }).at(-1)).toMatchObject({ outcome: 'interrupted' });
    expect(run('error', { errorMessage: '429: {"message":"slow down"}' }).at(-1)).toMatchObject({ outcome: 'failed', error: { type: 'provider.rate-limit', status: 429 } });
    // A run cut off after a tool step (the process died) never finished.
    expect(messages(branch(user(T0 + 10), assistant(T0 + 20, [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }], { stopReason: 'toolUse' }))).at(-1).outcome).toBe('interrupted');
    expect(messages(branch(user(T0 + 10))).at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' });
  });

  it('interrupts a tool call that never ran, unless a turn is running', () => {
    const entries = branch(
      user(T0 + 10),
      assistant(T0 + 20, [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'sleep 9' } }], { stopReason: 'toolUse' }),
    );
    const stopped = messages(entries);
    expect(stopped[1].content[0].state).toEqual({ status: 'error', input: { command: 'sleep 9' }, error: { type: 'aborted', message: 'Tool execution interrupted' } });
    const running = messages(entries, { running: true });
    expect(running[1].content[0].state).toEqual({ status: 'running', input: { command: 'sleep 9' }, metadata: {} });
    // A turn that is running has no idle message yet.
    expect(types(running)).toEqual(['user', 'assistant']);
    const aborted = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }], { stopReason: 'aborted' }),
    ), { running: true });
    expect(aborted[1].content[0].state.status).toBe('error');
  });

  it('keeps steered input inside the run and closes the run before the next prompt', () => {
    const list = messages(branch(
      user(T0 + 10, 'first'),
      assistant(T0 + 20, [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'x' } }], { stopReason: 'toolUse' }),
      toolResult(T0 + 80, 'c', 'ok'),
      user(T0 + 40, 'steer'),
      assistant(T0 + 90, [{ type: 'text', text: 'answer' }]),
      user(T0 + 200, 'second'),
      assistant(T0 + 210, [{ type: 'text', text: 'again' }]),
    ));
    expect(types(list)).toEqual(['user', 'assistant', 'user', 'assistant', 'idle', 'user', 'assistant', 'idle']);
    expect(list.map((message) => message.text).filter(Boolean)).toEqual(['first', 'steer', 'second']);
  });

  it('keeps the id the UI minted for a user message', () => {
    // The UI mints the id a moment before Pi stamps the message.
    const minted = userMessageId(T0 + 5);
    const list = messages(branch(user(T0 + 10), assistant(T0 + 20, [{ type: 'text', text: 'x' }])), { clientIds: { [T0 + 10]: minted } });
    expect(list.find((message) => message.type === 'user').id).toBe(minted);
    expect(list.map((message) => message.type)).toEqual(['user', 'assistant', 'idle']);
  });

  it('turns image blocks into inline files', () => {
    const list = messages(branch({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }], timestamp: T0 + 10 },
    }));
    expect(list[0]).toMatchObject({ type: 'user', text: 'look', files: [{ data: 'QUJD', mime: 'image/png', source: { type: 'inline' } }] });
  });

  it('shows a compaction between the runs it separates and names the first message it kept', () => {
    const list = messages(branch(
      user(T0 + 10),
      assistant(T0 + 20, [{ type: 'text', text: 'a' }]),
      user(T0 + 100, 'second'),
      assistant(T0 + 110, [{ type: 'text', text: 'b' }]),
      { type: 'compaction', summary: '## Goal\nx', firstKeptEntryId: 'e002', tokensBefore: 500, usage: usage(50, 10), at: T0 + 150 },
      user(T0 + 200, 'third'),
    ));
    expect(types(list)).toEqual(['user', 'assistant', 'idle', 'user', 'assistant', 'idle', 'compaction', 'user', 'idle']);
    const compaction = list.find((message) => message.type === 'compaction');
    expect(compaction).toEqual({
      id: compactionMessageIdAfter(T0 + 110),
      time: { created: T0 + 150 },
      type: 'compaction',
      status: 'completed',
      reason: 'manual',
      summary: '## Goal\nx',
      model: { id: 'mock-model', providerID: 'mock', variant: 'low' },
      cost: 0,
      tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      metadata: { keepID: userMessageId(T0 + 100) },
    });
  });

  it('shows a model switch only when the model really changes', () => {
    const list = messages(branch(
      { type: 'model_change', provider: 'mock', modelId: 'a' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      { type: 'model_change', provider: 'mock', modelId: 'a' },
      { type: 'model_change', provider: 'other', modelId: 'b', at: T0 + 500 },
      user(T0 + 600),
    ));
    const switched = list.filter((message) => message.type === 'model-switched');
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({
      time: { created: T0 + 500 },
      model: { id: 'b', providerID: 'other', variant: 'high' },
      previous: { id: 'a', providerID: 'mock', variant: 'high' },
    });
  });

  it('shows user shell commands, displayed custom messages and branch summaries', () => {
    const list = messages(branch(
      { type: 'message', message: { role: 'bashExecution', command: 'echo hi; exit 2', output: 'hi\n', exitCode: 2, cancelled: false, truncated: false, timestamp: T0 + 10 } },
      { type: 'message', message: { role: 'bashExecution', command: 'sleep 9', output: '', cancelled: true, truncated: false, timestamp: T0 + 20 } },
      { type: 'custom_message', customType: 'note', content: 'remember this', display: true, at: T0 + 30 },
      { type: 'custom_message', customType: 'hidden', content: 'not shown', display: false, at: T0 + 31 },
      { type: 'branch_summary', fromId: 'x', summary: 'what the other branch did', at: T0 + 40 },
    ));
    expect(types(list)).toEqual(['shell', 'shell', 'synthetic', 'synthetic']);
    expect(list[0]).toMatchObject({ command: 'echo hi; exit 2', status: 'exited', exit: 2, output: { output: 'hi\n', cursor: 3, size: 3, truncated: false } });
    expect(list[0].shellID).toMatch(/^sh_/);
    expect(list[1]).toMatchObject({ status: 'killed' });
    expect(list[1].exit).toBeUndefined();
    expect(list[2]).toMatchObject({ text: 'remember this', description: 'note' });
    expect(list[3]).toMatchObject({ text: 'what the other branch did', description: 'Branch summary' });
  });

  it('shows nothing for Pi\'s internal system message and bookkeeping entries', () => {
    const list = messages(branch(
      { type: 'message', message: { role: 'system', content: '', sections: { preamble: 'x' } } },
      { type: 'thinking_level_change', thinkingLevel: 'low' },
      { type: 'usage', kind: 'cache', usage: usage(1, 1) },
      { type: 'custom', customType: 'ext', data: {} },
      { type: 'label', targetId: 'e000', label: 'bookmark' },
      { type: 'session_info', name: 'A name' },
      { type: 'context_edit', targetId: 'e000', replacement: null },
    ));
    expect(list).toEqual([]);
  });

  it('sorts by id and tolerates an empty branch', () => {
    expect(entriesToWireMessages({ entries: [], cwd: CWD })).toEqual([]);
    const list = messages(branch(user(T0 + 10), assistant(T0 + 10, [{ type: 'text', text: 'same millisecond' }])));
    expect(list.map((message) => message.type)).toEqual(['user', 'assistant', 'idle']);
    expect([...list.map((message) => message.id)].sort()).toEqual(list.map((message) => message.id));
  });
});

describe('appendInflight', () => {
  it('adds the in-flight message and replaces the stored copy of the same message', () => {
    const stored = messages(branch(user(T0 + 10), assistant(T0 + 20, [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }], { stopReason: 'toolUse' })), { running: true });
    const inflight = { ...stored[1], content: [{ type: 'text', text: 'live' }] };
    const merged = appendInflight(stored, inflight);
    expect(merged).toHaveLength(2);
    expect(merged[1].content).toEqual([{ type: 'text', text: 'live' }]);
    expect(appendInflight(stored, null)).toBe(stored);
    const later = { ...inflight, id: assistantMessageId(T0 + 99) };
    expect(appendInflight(stored, later).map((message) => message.id)).toEqual([stored[0].id, stored[1].id, later.id]);
  });
});

describe('usageTotalsFromEntries', () => {
  it('sums assistant, tool, compaction and usage entries', () => {
    const totals = usageTotalsFromEntries(branch(
      assistant(T0 + 1, [], { usage: usage(100, 20, { reasoning: 8, cost: { total: 0.5 } }) }),
      toolResult(T0 + 2, 'c', 'x', { usage: usage(5, 5, { cost: { total: 0.25 } }) }),
      { type: 'compaction', summary: 's', firstKeptEntryId: 'e000', tokensBefore: 1, usage: usage(10, 2) },
      { type: 'usage', kind: 'cache', provider: 'p', model: 'm', usage: usage(1, 1) },
    ));
    expect(totals).toEqual({ cost: 0.75, tokens: { input: 116, output: 12 + 5 + 2 + 1, reasoning: 8, cache: { read: 0, write: 0 } } });
  });
});

describe('recorded Pi 1.5.0 sessions', () => {
  it.each(FIXTURE_NAMES)('%s: every stored message is one the wire schema accepts, in id order', async (name) => {
    const { decodeMessage } = await loadWireSchemas();
    const fixture = loadFixture(name);
    const list = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd });
    expect(list.length).toBeGreaterThan(0);
    for (const message of list) expect(() => decodeMessage(message), JSON.stringify(message).slice(0, 300)).not.toThrow();
    expect([...list.map((message) => message.id)].sort()).toEqual(list.map((message) => message.id));
    expect(new Set(list.map((message) => message.id)).size).toBe(list.length);
  });

  it('reads the tool steps session: tool states, diffs, exit codes and failures', () => {
    const fixture = loadFixture('tool-steps');
    const list = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd });
    const tools = Object.fromEntries(list.filter((message) => message.type === 'assistant').flatMap((message) => message.content).filter((item) => item.type === 'tool').map((item) => [item.id, item]));
    expect(tools.call_0_0).toMatchObject({ name: 'read', state: { status: 'completed', content: [{ text: 'line one\nline two\n' }] } });
    expect(tools.call_1_0.state).toMatchObject({ status: 'error', error: { type: 'tool.execution' } });
    expect(tools.call_1_1).toMatchObject({ name: 'read', state: { status: 'completed', input: { path: '.' } } });
    expect(tools.call_2_0.state.metadata.files).toEqual([expect.objectContaining({ file: 'notes.txt', status: 'modified', additions: 2, deletions: 2 })]);
    expect(tools.call_2_1.state).toMatchObject({ status: 'completed', metadata: { truncated: false } });
    expect(tools.call_2_2.state).toMatchObject({
      status: 'completed',
      content: [{ text: 'out\nerr\n' }, { text: 'Exited with code 3' }],
      metadata: { status: 'completed', exit: 3 },
    });
    expect(tools.call_3_0).toMatchObject({ name: 'grep', state: { status: 'completed', input: { ignoreCase: true, caseSensitive: false } } });
    expect(tools.call_3_1).toMatchObject({ name: 'glob' });
    expect(tools.call_3_2.state).toMatchObject({ status: 'error', error: { message: 'Tool nope_tool not found' } });
  });

  it('reads truncation, timeouts and an abort during a tool', () => {
    const truncated = loadFixture('tool-truncated');
    const tools = Object.fromEntries(entriesToWireMessages({ entries: activeBranch(truncated.entries), cwd: truncated.cwd })
      .filter((message) => message.type === 'assistant').flatMap((message) => message.content).filter((item) => item.type === 'tool').map((item) => [item.id, item]));
    expect(tools.call_0_0.state.metadata).toMatchObject({ truncated: true, exit: 0 });
    expect(tools.call_0_1.state.metadata.truncated).toBe(true);
    expect(tools.call_1_0.state).toMatchObject({ status: 'error', error: { type: 'tool.execution', message: 'Command timed out after 1 seconds' } });

    const aborted = loadFixture('tool-abort');
    const list = entriesToWireMessages({ entries: activeBranch(aborted.entries), cwd: aborted.cwd });
    expect(list.find((message) => message.type === 'assistant' && message.content.some((item) => item.type === 'tool')).content.at(-1).state)
      .toMatchObject({ status: 'error', error: { type: 'aborted' } });
    expect(list.at(-2)).toMatchObject({ type: 'assistant', finish: 'error', error: { type: 'aborted' } });
    expect(list.at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' });
  });

  it('reads the compaction session as the context the UI shows', () => {
    const fixture = loadFixture('compaction');
    const list = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd });
    expect(types(list)).toEqual(['user', 'assistant', 'idle', 'user', 'assistant', 'assistant', 'idle', 'compaction', 'user', 'assistant', 'idle']);
    expect(list.find((message) => message.type === 'compaction')).toMatchObject({
      status: 'completed',
      summary: expect.stringContaining('Mock summary'),
      tokens: { input: 100, output: 10 },
    });
    // Pi kept everything from the last answer of the second run on.
    expect(list.find((message) => message.type === 'compaction').metadata.keepID).toBe(list.filter((message) => message.type === 'assistant')[2].id);
  });

  it('reads the switches session: model change, shell command, image prompt', () => {
    const fixture = loadFixture('user-bash-and-switches');
    const list = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd });
    expect(types(list)).toEqual(['model-switched', 'shell', 'user', 'assistant', 'idle']);
    expect(list[0]).toMatchObject({ model: { id: 'mock-model-2', providerID: 'mock' }, previous: { id: 'mock-model', providerID: 'mock' } });
    expect(list[1]).toMatchObject({ command: 'echo from-user-shell; exit 2', exit: 2, status: 'exited' });
    expect(list[2].files).toHaveLength(1);
    expect(list[3].model).toMatchObject({ id: 'mock-model-2' });
  });

  it('puts the first attempt\'s id on a retried request and shows the last failure', () => {
    const fixture = loadFixture('error-retry');
    const entries = activeBranch(fixture.entries);
    const list = entriesToWireMessages({ entries, cwd: fixture.cwd });
    const firstAttempt = entries.find((entry) => entry.type === 'message' && entry.message.role === 'assistant').message;
    expect(types(list)).toEqual(['user', 'assistant', 'idle']);
    expect(list[1]).toMatchObject({ id: assistantMessageId(firstAttempt.timestamp), finish: 'error', error: { type: 'provider.transport' }, content: [] });
    expect(list[2]).toMatchObject({ outcome: 'failed', error: { type: 'provider.transport' } });
  });
});
