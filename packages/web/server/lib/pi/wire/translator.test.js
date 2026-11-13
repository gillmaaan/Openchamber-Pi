import { describe, expect, it } from 'vitest';

import { assistantMessageId, compactionMessageIdAfter, idleMessageIdAfter, userMessageId } from './mapping.js';
import { loadWireSchemas } from './test-support/opencode-schema.js';
import { FIXTURE_NAMES, loadFixture, replayFixture } from './test-support/replay.js';
import { createEventTranslator } from './translator.js';

const T0 = 1_794_000_000_000;
const USAGE = { input: 100, output: 20, cacheRead: 100, cacheWrite: 0, reasoning: 8, totalTokens: 228, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// ---- Pi event builders ---------------------------------------------------------

const userMessage = (timestamp, text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
const assistantMessage = (timestamp, content, extra = {}) => ({
  role: 'assistant', content, api: 'openai-completions', provider: 'mock', model: 'mock-model', usage: USAGE, stopReason: 'stop', timestamp, thinkingLevel: 'low', ...extra,
});
const start = (message) => ({ type: 'message_start', message: { ...message, usage: NO_USAGE, stopReason: message.stopReason === 'error' ? 'error' : 'pending' } });
const end = (message) => ({ type: 'message_end', message });
const update = (assistantMessageEvent) => ({ type: 'message_update', usage: USAGE, assistantMessageEvent });
const toolResultMessage = (timestamp, toolCallId, text, extra = {}) => end({
  role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text }], isError: false, timestamp, ...extra,
});

/** A translator with a clock the test steps, and everything it emits so far. */
const harness = (options = {}) => {
  let clock = T0;
  const translator = createEventTranslator({ sessionId: 'ses_t', cwd: '/work/project', now: () => clock, getThinkingLevel: () => 'low', ...options });
  const emitted = [];
  const feed = (...piEvents) => {
    const wire = [];
    for (const piEvent of piEvents) {
      clock += 10;
      wire.push(...translator.onPiEvent(piEvent));
    }
    emitted.push(...wire);
    return wire;
  };
  return { translator, feed, emitted, tick: (ms) => { clock += ms; } };
};
const typesOf = (events) => events.map((event) => event.type);

/** A whole one-step text answer. */
const answer = (timestamp, text = 'hello') => {
  const message = assistantMessage(timestamp, [{ type: 'text', text }]);
  return [
    start({ ...message, content: [] }),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: text }),
    update({ type: 'text_end', contentIndex: 0, content: text }),
    end(message),
    { type: 'turn_end', message, toolResults: [] },
  ];
};

describe('a plain turn', () => {
  it('emits the events of a one-step answer in the reference order', () => {
    const { translator, feed } = harness();
    const enqueued = translator.enqueueInbox({ inboxID: 'msg_ui', text: 'hi' });
    const events = feed(
      { type: 'agent_start' },
      { type: 'turn_start' },
      start(userMessage(T0 + 5, 'hi')),
      end(userMessage(T0 + 5, 'hi')),
      ...answer(T0 + 20),
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled', aborted: false },
    );
    expect(typesOf(enqueued)).toEqual(['session.inbox.enqueued']);
    expect(enqueued[0]).toEqual({
      type: 'session.inbox.enqueued',
      data: { sessionID: 'ses_t', inboxID: 'msg_ui', item: { type: 'user', payload: { text: 'hi' }, delivery: 'steer' } },
      durable: true,
    });
    expect(typesOf(events)).toEqual([
      'session.execution.started',
      'session.inbox.delivered',
      'session.step.started',
      'session.text.started',
      'session.text.delta',
      'session.text.ended',
      'session.step.streamed',
      'session.step.ended',
      'session.usage.updated',
      'session.execution.succeeded',
    ]);
    const id = assistantMessageId(T0 + 20);
    expect(events[1].data).toEqual({ sessionID: 'ses_t', inboxID: 'msg_ui' });
    expect(events[2].data).toEqual({
      sessionID: 'ses_t', assistantMessageID: id, agent: 'build', model: { id: 'mock-model', providerID: 'mock', variant: 'low' }, started: T0 + 20,
    });
    expect(events[3].data).toEqual({ sessionID: 'ses_t', assistantMessageID: id, ordinal: 0 });
    expect(events[4].data).toEqual({ sessionID: 'ses_t', assistantMessageID: id, ordinal: 0, delta: 'hello' });
    expect(events[5].data).toEqual({ sessionID: 'ses_t', assistantMessageID: id, ordinal: 0, text: 'hello' });
    expect(events[7].data).toEqual({
      sessionID: 'ses_t',
      assistantMessageID: id,
      finish: 'stop',
      rawFinish: 'stop',
      tokens: { input: 100, output: 12, reasoning: 8, cache: { read: 100, write: 0 } },
      cost: 0.5,
      files: [],
    });
    expect(events[8].data).toEqual({ sessionID: 'ses_t', cost: 0.5, tokens: { input: 100, output: 12, reasoning: 8, cache: { read: 100, write: 0 } } });
    expect(events[9].data).toEqual({ sessionID: 'ses_t' });
  });

  it('marks the events OpenCode persists as durable and leaves deltas, progress and usage ephemeral', () => {
    const { feed } = harness();
    const events = feed({ type: 'agent_start' }, start(userMessage(T0 + 5, 'hi')), ...answer(T0 + 20), { type: 'agent_settled', aborted: false });
    const byType = Object.fromEntries(events.map((event) => [event.type, event.durable === true]));
    expect(byType).toMatchObject({
      'session.execution.started': true,
      'session.inbox.enqueued': true,
      'session.inbox.delivered': true,
      'session.step.started': true,
      'session.text.started': true,
      'session.text.delta': false,
      'session.text.ended': true,
      'session.step.ended': true,
      'session.usage.updated': false,
      'session.execution.succeeded': true,
    });
  });

  it('puts the idle message of the run on the terminal event, anchored on the last message', () => {
    const { feed } = harness();
    const events = feed({ type: 'agent_start' }, start(userMessage(T0 + 5, 'hi')), ...answer(T0 + 20), { type: 'agent_settled', aborted: false });
    const terminal = events.at(-1);
    expect(terminal.type).toBe('session.execution.succeeded');
    expect(terminal.idleMessage).toEqual({ id: idleMessageIdAfter(T0 + 20), time: { created: expect.any(Number) }, type: 'idle', outcome: 'succeeded' });
    expect(Object.keys(terminal.data)).toEqual(['sessionID']);
  });

  it('starts the execution once for several agent runs of one cycle and skips Pi\'s system message', () => {
    const { feed } = harness();
    const events = feed(
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'system', content: '' } },
      { type: 'message_end', message: { role: 'system', content: '' } },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_start' },
    );
    expect(typesOf(events)).toEqual(['session.execution.started']);
  });

  it('never emits tool input deltas or events for nested calls and unknown records', () => {
    const { feed } = harness();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'x' } };
    const events = feed(
      { type: 'agent_start' },
      start(assistantMessage(T0 + 20, [], { stopReason: 'toolUse' })),
      update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }),
      update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command":' }),
      update({ type: 'toolcall_delta', contentIndex: 0, delta: '"x"}' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }),
      { type: 'tool_execution_start', toolCallId: 'c1/1', toolName: 'read', args: {}, parentToolCallId: 'c1' },
      { type: 'tool_execution_end', toolCallId: 'c1/1', toolName: 'read', result: { content: [] }, isError: false, parentToolCallId: 'c1' },
      { type: 'queue_update', steering: [], followUp: [] },
      { type: 'entry_appended', entry: {} },
      { type: 'extension_ui_request', id: 'x' },
      { type: 'something_new' },
    );
    expect(typesOf(events)).toEqual(['session.execution.started', 'session.step.started', 'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called']);
    expect(events[3].data.text).toBe('{"command":"x"}');
  });
});

describe('content blocks', () => {
  it('numbers text and reasoning blocks per kind in content order', () => {
    const { feed } = harness();
    const events = feed(
      { type: 'agent_start' },
      start(assistantMessage(T0 + 20, [])),
      update({ type: 'thinking_start', contentIndex: 0 }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'a' }),
      update({ type: 'thinking_end', contentIndex: 0, content: 'a' }),
      update({ type: 'text_start', contentIndex: 1 }),
      update({ type: 'text_end', contentIndex: 1, content: 'one' }),
      update({ type: 'thinking_start', contentIndex: 2 }),
      update({ type: 'thinking_end', contentIndex: 2, content: 'b' }),
      update({ type: 'text_start', contentIndex: 3 }),
      update({ type: 'text_end', contentIndex: 3, content: 'two' }),
    );
    const blocks = events.filter((event) => /\.(started|ended)$/.test(event.type) && !event.type.includes('execution') && !event.type.includes('step'))
      .map((event) => `${event.type}:${event.data.ordinal}`);
    expect(blocks).toEqual([
      'session.reasoning.started:0', 'session.reasoning.ended:0',
      'session.text.started:0', 'session.text.ended:0',
      'session.reasoning.started:1', 'session.reasoning.ended:1',
      'session.text.started:1', 'session.text.ended:1',
    ]);
  });

  it('settles blocks the stream left open and announces blocks it never streamed from Pi\'s final message', () => {
    const { feed } = harness();
    const final = assistantMessage(T0 + 20, [
      { type: 'text', text: 'streamed then cut' },
      { type: 'thinking', thinking: 'never streamed' },
      { type: 'toolCall', id: 'c9', name: 'read', arguments: { path: 'a' } },
    ], { stopReason: 'toolUse' });
    const events = feed(
      { type: 'agent_start' },
      start({ ...final, content: [] }),
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: 'streamed then cut' }),
      end(final),
    );
    expect(typesOf(events.slice(2))).toEqual([
      'session.text.started', 'session.text.delta',
      'session.text.ended', 'session.reasoning.started', 'session.reasoning.ended',
      'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called',
      'session.step.streamed',
    ]);
    expect(events.find((event) => event.type === 'session.reasoning.ended').data).toMatchObject({ ordinal: 0, text: 'never streamed' });
  });

  it('adds up the shell output as the call runs and reports a non-zero exit as a finished call', () => {
    const { feed } = harness();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'exit 3', timeout: 2 } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const events = feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
      { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash', args: call.arguments, partialResult: { content: [{ type: 'text', text: 'out\n' }] } },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'out\n\n\nCommand exited with code 3' }] }, isError: true },
      toolResultMessage(T0 + 90, 'c1', 'out\n\n\nCommand exited with code 3', { isError: true }),
      { type: 'turn_end', message, toolResults: [] },
    );
    const called = events.find((event) => event.type === 'session.tool.called');
    expect(called.data).toMatchObject({ id: 'c1', input: { command: 'exit 3', timeout: 2000 }, executed: false });
    const progress = events.find((event) => event.type === 'session.tool.progress');
    expect(progress).toMatchObject({ data: { id: 'c1', metadata: { output: 'out\n' } } });
    expect(progress.durable).toBeUndefined();
    const success = events.find((event) => event.type === 'session.tool.success');
    expect(success.data).toMatchObject({
      id: 'c1',
      content: [{ type: 'text', text: 'out' }, { type: 'text', text: 'Exited with code 3' }].map((item, index) => (index === 0 ? { type: 'text', text: 'out\n' } : item)),
      metadata: { status: 'completed', truncated: false, exit: 3 },
    });
    expect(typesOf(events).filter((type) => type === 'session.tool.success' || type === 'session.tool.failed')).toHaveLength(1);
    expect(events.at(-2).type).toBe('session.step.ended');
    expect(events.at(-2).data.finish).toBe('tool-calls');
  });

  it('settles parallel tool calls in the order they finish, once each', () => {
    const { feed } = harness();
    const calls = [
      { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a' } },
      { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'x' } },
    ];
    const message = assistantMessage(T0 + 20, calls, { stopReason: 'toolUse' });
    const events = feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'a' } },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'x' } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: { content: [{ type: 'text', text: 'bee' }] }, isError: false },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', result: { content: [{ type: 'text', text: 'ay' }] }, isError: true },
      toolResultMessage(T0 + 70, 'a', 'ay', { toolName: 'read', isError: true }),
      toolResultMessage(T0 + 70, 'b', 'bee'),
      { type: 'turn_end', message, toolResults: [] },
    );
    const settled = events.filter((event) => event.type === 'session.tool.success' || event.type === 'session.tool.failed').map((event) => `${event.type}:${event.data.id}`);
    expect(settled).toEqual(['session.tool.success:b', 'session.tool.failed:a']);
    expect(events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'tool.execution', message: 'ay' });
  });

  it('settles a tool result that only the toolResult message reports', () => {
    const { feed } = harness();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'x' } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const events = feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      end(message),
      toolResultMessage(T0 + 70, 'c1', 'late'),
      { type: 'turn_end', message, toolResults: [] },
    );
    expect(events.filter((event) => event.type === 'session.tool.success')).toHaveLength(1);
  });
});

describe('user input', () => {
  const run = (...userTexts) => {
    const { translator, feed } = harness();
    return { translator, feed, userTexts };
  };

  it('delivers pending items first in, first out and matches by text', () => {
    const { translator, feed } = run();
    translator.enqueueInbox({ inboxID: 'msg_one', text: 'first' });
    translator.enqueueInbox({ inboxID: 'msg_two', text: 'second' });
    const delivered = feed(
      { type: 'agent_start' },
      start(userMessage(T0 + 5, 'second')),
      start(userMessage(T0 + 6, 'first')),
    ).filter((event) => event.type === 'session.inbox.delivered').map((event) => event.data.inboxID);
    expect(delivered).toEqual(['msg_two', 'msg_one']);
    expect(translator.pendingInbox()).toEqual([]);
  });

  it('falls back to the oldest pending item when Pi changed the text, such as an expanded skill command', () => {
    const { translator, feed } = run();
    translator.enqueueInbox({ inboxID: 'msg_skill', text: '/skill:review src' });
    const events = feed({ type: 'agent_start' }, start(userMessage(T0 + 5, '<skill name="review">...</skill>\n\nsrc')));
    expect(events.filter((event) => event.type === 'session.inbox.delivered').map((event) => event.data.inboxID)).toEqual(['msg_skill']);
    expect(events.some((event) => event.type === 'session.inbox.enqueued')).toBe(false);
  });

  it('reports which UI id belongs to which Pi message so the coordinator can persist the pairing', () => {
    const bindings = [];
    const { translator, feed } = harness({ onClientId: (binding) => bindings.push(binding) });
    translator.enqueueInbox({ inboxID: 'msg_ui', text: 'hi' });
    feed({ type: 'agent_start' }, start(userMessage(T0 + 5, 'hi')));
    expect(bindings).toEqual([{ timestamp: T0 + 5, id: 'msg_ui' }]);
  });

  it('paints and delivers a message nobody enqueued, such as one typed in the Pi CLI', () => {
    const bindings = [];
    const { feed } = harness({ onClientId: (binding) => bindings.push(binding) });
    const events = feed({ type: 'agent_start' }, start({ role: 'user', content: [{ type: 'text', text: 'from the CLI' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }], timestamp: T0 + 5 }));
    const id = userMessageId(T0 + 5);
    expect(events.slice(1)).toEqual([
      {
        type: 'session.inbox.enqueued',
        data: {
          sessionID: 'ses_t',
          inboxID: id,
          item: { type: 'user', payload: { text: 'from the CLI', files: [{ data: 'QUJD', mime: 'image/png', source: { type: 'inline' } }] }, delivery: 'steer' },
        },
        durable: true,
      },
      { type: 'session.inbox.delivered', data: { sessionID: 'ses_t', inboxID: id }, durable: true },
    ]);
    expect(bindings).toEqual([]);
  });

  it('delivers steered input after the step it interrupted, before the next step', () => {
    const { translator, feed } = harness();
    translator.enqueueInbox({ inboxID: 'msg_a', text: 'run it' });
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 1' } };
    const first = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const steering = feed(
      { type: 'agent_start' },
      start(userMessage(T0 + 5, 'run it')),
      start({ ...first, content: [] }),
      end(first),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
    );
    expect(steering.length).toBeGreaterThan(0);
    const enqueued = translator.enqueueInbox({ inboxID: 'msg_b', text: 'actually, stop', delivery: 'steer' });
    expect(enqueued[0].data.item.delivery).toBe('steer');
    const rest = feed(
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
      { type: 'turn_end', message: first, toolResults: [] },
      { type: 'turn_start' },
      start(userMessage(T0 + 40, 'actually, stop')),
      ...answer(T0 + 200, 'ok, stopping'),
    );
    expect(typesOf(rest)).toEqual([
      'session.tool.success', 'session.step.ended', 'session.usage.updated',
      'session.inbox.delivered',
      'session.step.started', 'session.text.started', 'session.text.delta', 'session.text.ended', 'session.step.streamed', 'session.step.ended', 'session.usage.updated',
    ]);
    expect(rest[3].data.inboxID).toBe('msg_b');
  });

  it('cancels a pending item and delivers a synthetic one on request', () => {
    const { translator } = harness();
    translator.enqueueInbox({ inboxID: 'msg_x', text: 'never mind' });
    translator.enqueueInbox({ inboxID: 'msg_ctx', type: 'synthetic', text: 'context', description: 'Selection' });
    expect(translator.pendingInbox().map((item) => item.inboxID)).toEqual(['msg_x', 'msg_ctx']);
    expect(translator.cancelInbox('msg_x')).toEqual([{ type: 'session.inbox.cancelled', data: { sessionID: 'ses_t', inboxID: 'msg_x' }, durable: true }]);
    expect(translator.cancelInbox('msg_x')).toEqual([]);
    expect(translator.deliverInbox('msg_ctx')).toEqual([{ type: 'session.inbox.delivered', data: { sessionID: 'ses_t', inboxID: 'msg_ctx' }, durable: true }]);
    expect(translator.pendingInbox()).toEqual([]);
  });
});

describe('stopping', () => {
  it('ends an aborted response with step.failed(aborted) and interrupts the run with reason "user"', () => {
    const { feed } = harness();
    const message = assistantMessage(T0 + 20, [{ type: 'text', text: 'partial' }], { stopReason: 'aborted', errorMessage: 'Request was aborted', usage: NO_USAGE });
    const events = feed(
      { type: 'agent_start' },
      start(assistantMessage(T0 + 20, [], { usage: NO_USAGE })),
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: 'partial' }),
      update({ type: 'text_end', contentIndex: 0, content: 'partial' }),
      end(message),
      { type: 'turn_end', message, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled', aborted: true },
    );
    expect(typesOf(events).slice(-3)).toEqual(['session.step.streamed', 'session.step.failed', 'session.execution.interrupted']);
    const failed = events.find((event) => event.type === 'session.step.failed');
    expect(failed.data).toEqual({ sessionID: 'ses_t', assistantMessageID: assistantMessageId(T0 + 20), error: { type: 'aborted', message: 'Step interrupted' } });
    expect(events.some((event) => event.type === 'session.usage.updated')).toBe(false);
    const interrupted = events.at(-1);
    expect(interrupted.data).toEqual({ sessionID: 'ses_t', reason: 'user' });
    expect(interrupted.idleMessage).toMatchObject({ type: 'idle', outcome: 'interrupted' });
    expect(events.some((event) => event.data?.reason === 'shutdown')).toBe(false);
  });

  it('fails the tool calls an abort cut off', () => {
    const { feed } = harness();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 30' } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const events = feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }], details: {} }, isError: true },
      toolResultMessage(T0 + 60, 'c1', 'Command aborted', { isError: true }),
      { type: 'turn_end', message, toolResults: [] },
      ...(() => {
        const aborted = assistantMessage(T0 + 70, [], { stopReason: 'error', errorMessage: 'This operation was aborted', usage: NO_USAGE });
        return [start(aborted), end(aborted), { type: 'turn_end', message: aborted, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: false }];
      })(),
      { type: 'agent_settled', aborted: true },
    );
    expect(events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'aborted', message: 'Tool execution interrupted' });
    expect(events.filter((event) => event.type === 'session.step.failed')).toHaveLength(1);
    expect(events.at(-1).type).toBe('session.execution.interrupted');
  });

  it('closes a step the stream ended inside of', () => {
    const { feed } = harness();
    const events = feed(
      { type: 'agent_start' },
      start(assistantMessage(T0 + 20, [], { usage: NO_USAGE })),
      update({ type: 'text_start', contentIndex: 0 }),
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled', aborted: true },
    );
    expect(typesOf(events).slice(-3)).toEqual(['session.step.failed', 'session.usage.updated', 'session.execution.interrupted']);
    // The step carries the usage Pi had reported while the response streamed.
    expect(events.find((event) => event.type === 'session.step.failed').data).toMatchObject({ tokens: { input: 100, output: 12, reasoning: 8 } });
  });
});

describe('a Pi process that died mid-turn', () => {
  it('is closed by a synthetic agent_settled: tools fail, the step fails, the run is interrupted', () => {
    const { feed, translator } = harness();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 9' } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
    );
    expect(translator.execution.active).toBe(true);
    const events = feed({ type: 'agent_settled', aborted: true });
    expect(typesOf(events)).toEqual(['session.tool.failed', 'session.step.failed', 'session.usage.updated', 'session.execution.interrupted']);
    expect(events[0].data.error.type).toBe('aborted');
    expect(translator.execution.active).toBe(false);
    expect(translator.inflightAssistantMessage()).toBeNull();
  });
});

describe('calls the permission gate blocked, and the question tool', () => {
  const run = (toolName, args, endEvent, options = {}) => {
    const call = { type: 'toolCall', id: 'c1', name: toolName, arguments: args };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const { feed, translator } = harness(options);
    const events = feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName, args },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName, ...endEvent },
      { type: 'turn_end', message, toolResults: [] },
    );
    return { events, translator };
  };
  const errorResult = (text, details) => ({ result: { content: [{ type: 'text', text }], ...(details ? { details } : {}) }, isError: true });

  it('asks the hook once per failed call and turns a rejection into permission.rejected', () => {
    const asked = [];
    const { events } = run('bash', { command: 'rm -rf x' }, errorResult('no thanks'), {
      classifyToolEnd: (toolCallId, event) => { asked.push([toolCallId, event.type]); return { kind: 'rejected', message: 'no thanks' }; },
    });
    expect(asked).toEqual([['c1', 'tool_execution_end']]);
    expect(events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'permission.rejected', message: 'no thanks' });
  });

  it('turns a denial by rule into a tool.execution error', () => {
    const reason = 'The user has specified a rule which prevents you from using this specific tool call (shell: rm *).';
    const { events } = run('bash', { command: 'rm x' }, errorResult(reason), { classifyToolEnd: () => ({ kind: 'denied', message: reason }) });
    expect(events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'tool.execution', message: reason });
  });

  it('does not ask for a call that succeeded and keeps an ordinary error ordinary', () => {
    const asked = [];
    const classifyToolEnd = (toolCallId) => { asked.push(toolCallId); return undefined; };
    run('bash', { command: 'echo' }, { result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }, { classifyToolEnd });
    expect(asked).toEqual([]);
    const { events } = run('read', { path: 'x' }, errorResult('ENOENT'), { classifyToolEnd });
    expect(asked).toEqual(['c1']);
    expect(events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'tool.execution', message: 'ENOENT' });
  });

  it('survives a hook that throws and consumes the block of a nested call it does not show', () => {
    const { events } = run('bash', { command: 'x' }, errorResult('boom'), { classifyToolEnd: () => { throw new Error('hook broke'); } });
    expect(events.find((event) => event.type === 'session.tool.failed').data.error.message).toBe('boom');

    const asked = [];
    const { feed } = harness({ classifyToolEnd: (toolCallId) => { asked.push(toolCallId); return { kind: 'rejected', message: 'x' }; } });
    const call = { type: 'toolCall', id: 'c1', name: 'codemode', arguments: { code: 'tools.bash()' } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const nested = feed(
      { type: 'agent_start' }, start({ ...message, content: [] }), end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'codemode', args: call.arguments },
      { type: 'tool_execution_start', toolCallId: 'c1/1', toolName: 'bash', args: {}, parentToolCallId: 'c1' },
      { type: 'tool_execution_end', toolCallId: 'c1/1', toolName: 'bash', result: { content: [{ type: 'text', text: 'x' }] }, isError: true, parentToolCallId: 'c1' },
    );
    expect(asked).toEqual(['c1/1']);
    expect(nested.some((event) => event.type === 'session.tool.failed')).toBe(false);
  });

  it('puts the answers of the question tool in the metadata of its success', () => {
    const details = { answers: [['Yes']], truncated: false };
    const { events } = run('question', { questions: [{ question: 'Ok?', header: 'Ok', options: [] }] }, {
      result: { content: [{ type: 'text', text: 'User has answered your questions: "Ok?"="Yes".' }], details }, isError: false,
    });
    const success = events.find((event) => event.type === 'session.tool.success');
    expect(success.data).toMatchObject({ id: 'c1', metadata: { answers: [['Yes']], truncated: false } });
    expect(events.find((event) => event.type === 'session.tool.input.started').data.name).toBe('question');
  });

  it('fails a dismissed question as aborted and an interrupted one as an abort', () => {
    const dismissed = run('question', {}, errorResult('The user dismissed this question', { dismissed: true }));
    expect(dismissed.events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'aborted', message: 'The user dismissed this question' });
    const interrupted = run('question', {}, errorResult('interrupted', { interrupted: true }));
    expect(interrupted.events.find((event) => event.type === 'session.tool.failed').data.error).toEqual({ type: 'aborted', message: 'Tool execution interrupted' });
  });
});

describe('looking up the message of a tool call', () => {
  const fakeTimers = () => {
    const timers = [];
    return {
      timers,
      setTimeoutImpl: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
      clearTimeoutImpl: (timer) => { if (timer) timer.cleared = true; },
    };
  };
  const callMessage = () => {
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'x' } };
    return { call, message: assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' }) };
  };

  it('knows the message once the call started streaming and numbers it when tool.called was returned', async () => {
    const { feed, translator } = harness(fakeTimers());
    const { call, message } = callMessage();
    expect(translator.assistantMessageIdForCall('c1')).toBeUndefined();
    feed({ type: 'agent_start' }, start({ ...message, content: [] }), update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }));
    expect(translator.assistantMessageIdForCall('c1')).toBe(assistantMessageId(T0 + 20));

    const order = [];
    const waiting = translator.whenCallNumbered('c1', 2000).then((id) => { order.push(['numbered', id]); return id; });
    await Promise.resolve();
    expect(order).toEqual([]);

    const events = feed(update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }));
    order.push(['returned', events.map((event) => event.type)]);
    expect(await waiting).toBe(assistantMessageId(T0 + 20));
    // The waiter continues only after onPiEvent handed its events back.
    expect(order.map(([kind]) => kind)).toEqual(['returned', 'numbered']);
    expect(order[0][1]).toEqual(['session.tool.input.ended', 'session.tool.called']);
    await expect(translator.whenCallNumbered('c1', 2000)).resolves.toBe(assistantMessageId(T0 + 20));
  });

  it('gives up after the timeout and clears the timer when the call is numbered first', async () => {
    const timers = fakeTimers();
    const { translator, feed } = harness(timers);
    const lost = translator.whenCallNumbered('nope', 1500);
    expect(timers.timers[0].ms).toBe(1500);
    timers.timers[0].fn();
    await expect(lost).resolves.toBeUndefined();

    const { call, message } = callMessage();
    const waiting = translator.whenCallNumbered('c1', 2000);
    feed({ type: 'agent_start' }, start({ ...message, content: [] }), update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }), update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }));
    await waiting;
    expect(timers.timers[1].cleared).toBe(true);
  });

  it('maps a call a codemode script made to the script\'s call and its message', async () => {
    const { feed, translator } = harness(fakeTimers());
    const call = { type: 'toolCall', id: 'cm1', name: 'codemode', arguments: { code: 'x' } };
    const message = assistantMessage(T0 + 20, [call], { stopReason: 'toolUse' });
    const waiting = translator.whenCallNumbered('cm1/1', 2000);
    feed(
      { type: 'agent_start' }, start({ ...message, content: [] }), update({ type: 'toolcall_start', contentIndex: 0, id: 'cm1', toolName: 'codemode' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }), end(message),
      { type: 'tool_execution_start', toolCallId: 'cm1', toolName: 'codemode', args: call.arguments },
    );
    expect(await waiting).toBe(assistantMessageId(T0 + 20));
    expect(translator.assistantMessageIdForCall('cm1/1')).toBe(assistantMessageId(T0 + 20));
    feed({ type: 'tool_execution_start', toolCallId: 'odd-id', toolName: 'read', args: {}, parentToolCallId: 'cm1' });
    expect(translator.assistantMessageIdForCall('odd-id')).toBe(assistantMessageId(T0 + 20));
  });

  it('remembers the message of a call after its step ended', () => {
    const { feed, translator } = harness(fakeTimers());
    const { call, message } = callMessage();
    feed(
      { type: 'agent_start' }, start({ ...message, content: [] }), update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: call }), end(message),
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'x' }] }, isError: false },
      { type: 'turn_end', message, toolResults: [] },
    );
    expect(translator.assistantMessageIdForCall('c1')).toBe(assistantMessageId(T0 + 20));
  });
});

describe('onProcessExit', () => {
  const crashed = (...piEvents) => {
    const { feed, translator } = harness();
    feed({ type: 'agent_start' }, ...piEvents);
    return { translator, exit: (info) => translator.onProcessExit(info) };
  };

  it('returns nothing when nothing was running', () => {
    const { translator } = harness();
    expect(translator.onProcessExit({ code: 0, signal: null })).toEqual([]);
    translator.onPiEvent({ type: 'agent_start' });
    translator.onPiEvent({ type: 'agent_settled', aborted: false });
    expect(translator.onProcessExit({ code: 0, signal: null })).toEqual([]);
  });

  it('fails the open step and the run with a transport error, closing text and tools', () => {
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 9' } };
    const message = assistantMessage(T0 + 20, [{ type: 'text', text: 'Running. ' }, call], { stopReason: 'toolUse' });
    const { translator, exit } = crashed(
      start(userMessage(T0 + 5, 'go')),
      start({ ...message, content: [] }),
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: 'Running. ' }),
      update({ type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'bash' }),
      update({ type: 'toolcall_end', contentIndex: 1, toolCall: call }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
    );
    const events = exit({ code: null, signal: 'SIGKILL' });
    const error = { type: 'provider.transport', message: 'The agent process stopped unexpectedly (signal SIGKILL).' };
    expect(typesOf(events)).toEqual(['session.tool.failed', 'session.step.failed', 'session.usage.updated', 'session.execution.failed']);
    expect(events[0].data.error).toEqual({ type: 'aborted', message: 'Tool execution interrupted' });
    expect(events[1].data).toMatchObject({ assistantMessageID: assistantMessageId(T0 + 20), error });
    expect(events[3].data).toEqual({ sessionID: 'ses_t', error });
    expect(events[3].idleMessage).toMatchObject({ type: 'idle', outcome: 'failed', error });
    expect(translator.execution).toEqual({ active: false, owner: null });
    expect(translator.inflightAssistantMessage()).toBeNull();
    // Ready for a new run, and a second exit has nothing left to close.
    expect(translator.onProcessExit({ code: 1 })).toEqual([]);
    expect(translator.onPiEvent({ type: 'agent_start' }).map((event) => event.type)).toEqual(['session.execution.started']);
  });

  it('names the exit code when there is no signal, and ends a retry that was waiting', () => {
    const bad = assistantMessage(T0 + 20, [], { stopReason: 'error', errorMessage: 'Connection error.', usage: NO_USAGE });
    const { exit } = crashed(
      start(bad), end(bad), { type: 'turn_end', message: bad, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Connection error.' },
    );
    const events = exit({ code: 137, signal: null });
    expect(typesOf(events)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[1].data.error.message).toBe('The agent process stopped unexpectedly (code 137).');
  });

  it('fails a held request that was waiting for its retry before it ends the run', () => {
    const bad = assistantMessage(T0 + 20, [], { stopReason: 'error', errorMessage: 'Connection error.', usage: NO_USAGE });
    const { exit } = crashed(start(bad), end(bad), { type: 'turn_end', message: bad, toolResults: [] });
    const events = exit({ code: 1 });
    expect(typesOf(events)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[0].data.error).toEqual({ type: 'provider.transport', message: 'Connection error.' });
  });

  it('fails a compaction that was running', () => {
    const { translator } = harness();
    translator.onPiEvent({ type: 'compaction_start', reason: 'manual' });
    const events = translator.onProcessExit({ code: null, signal: 'SIGTERM' });
    expect(typesOf(events)).toEqual(['session.compaction.failed', 'session.execution.failed']);
    expect(events[0].data).toMatchObject({ reason: 'manual', error: { type: 'compaction.failed' } });
    expect(events[1].idleMessage).toBeUndefined();
  });

  it('lets lookups waiting for a call give up', async () => {
    const { translator } = harness({ setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
    translator.onPiEvent({ type: 'agent_start' });
    const waiting = translator.whenCallNumbered('c1', 60_000);
    translator.onProcessExit({ code: 1 });
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('failures and retries', () => {
  const failed = (timestamp, errorMessage, content = []) => assistantMessage(timestamp, content, { stopReason: 'error', errorMessage, usage: NO_USAGE });

  it('shows an empty failed request as one step that its retry reuses', () => {
    const { feed } = harness();
    const first = failed(T0 + 20, '500: {"message":"flaky"}');
    const events = feed(
      { type: 'agent_start' },
      start(first),
      end(first),
      { type: 'turn_end', message: first, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: first.errorMessage },
      { type: 'agent_start' },
      { type: 'turn_start' },
      ...answer(T0 + 2100, 'recovered'),
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'auto_retry_end', success: true, attempt: 1 },
      { type: 'agent_settled', aborted: false },
    );
    expect(typesOf(events)).toEqual([
      'session.execution.started',
      'session.step.started',
      'session.retry.scheduled',
      'session.step.started',
      'session.text.started', 'session.text.delta', 'session.text.ended', 'session.step.streamed',
      'session.step.ended', 'session.usage.updated',
      'session.execution.succeeded',
    ]);
    const id = assistantMessageId(T0 + 20);
    expect(events[1].data.assistantMessageID).toBe(id);
    expect(events[2].data).toEqual({
      sessionID: 'ses_t',
      assistantMessageID: id,
      attempt: 2,
      at: expect.any(Number),
      error: { type: 'provider.internal', message: 'flaky', status: 500, response: { body: '{"message":"flaky"}' } },
    });
    expect(events[3].data.assistantMessageID).toBe(id);
    expect(events[8].data.assistantMessageID).toBe(id);
  });

  it('schedules the retry at now plus Pi\'s delay and counts attempts from 2', () => {
    const { feed, translator } = harness();
    const first = failed(T0 + 20, 'Connection error.');
    const events = feed(
      { type: 'agent_start' }, start(first), end(first), { type: 'turn_end', message: first, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: true },
    );
    expect(events.at(-1).type).toBe('session.step.started');
    const retry = feed({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'Connection error.' })[0];
    expect(retry.data.attempt).toBe(3);
    expect(retry.data.at).toBe(T0 + 60 + 4000);
    expect(translator.retry).toMatchObject({ attempt: 3, assistantMessageID: assistantMessageId(T0 + 20) });
    feed({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'Connection error.' });
    expect(translator.retry).toBeNull();
  });

  it('fails the step and the run when the last retry fails', () => {
    const { feed } = harness();
    const one = failed(T0 + 20, 'Connection error.');
    const two = failed(T0 + 90, 'Connection error.');
    const events = feed(
      { type: 'agent_start' },
      start(one), end(one), { type: 'turn_end', message: one, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 50, errorMessage: one.errorMessage },
      { type: 'agent_start' }, start(two), end(two), { type: 'turn_end', message: two, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: false },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Connection error.' },
      { type: 'agent_settled', aborted: false },
    );
    expect(typesOf(events)).toEqual([
      'session.execution.started', 'session.step.started', 'session.retry.scheduled', 'session.step.started', 'session.step.failed', 'session.execution.failed',
    ]);
    const id = assistantMessageId(T0 + 20);
    expect(events[4].data).toEqual({ sessionID: 'ses_t', assistantMessageID: id, error: { type: 'provider.transport', message: 'Connection error.' } });
    expect(events[5].data).toEqual({ sessionID: 'ses_t', error: { type: 'provider.transport', message: 'Connection error.' } });
    expect(events[5].idleMessage).toMatchObject({ outcome: 'failed', error: { type: 'provider.transport' } });
  });

  it('fails at once when Pi does not retry', () => {
    const { feed } = harness();
    const bad = failed(T0 + 20, '400: {"message":"bad request"}');
    const events = feed(
      { type: 'agent_start' }, start(bad), end(bad), { type: 'turn_end', message: bad, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: false }, { type: 'agent_settled', aborted: false },
    );
    expect(typesOf(events)).toEqual(['session.execution.started', 'session.step.started', 'session.step.failed', 'session.execution.failed']);
    expect(events[2].data.error).toMatchObject({ type: 'provider.invalid-request', status: 400, message: 'bad request' });
  });

  it('closes a failed step that streamed something and gives its retry a new message', () => {
    const { feed } = harness();
    const partial = failed(T0 + 20, 'Connection error.', [{ type: 'text', text: 'partial ' }]);
    const events = feed(
      { type: 'agent_start' },
      start({ ...partial, content: [] }),
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_end', contentIndex: 0, content: 'partial ' }),
      end(partial),
      { type: 'turn_end', message: partial, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: partial.errorMessage },
      { type: 'agent_start' },
      ...answer(T0 + 200),
    );
    const names = typesOf(events);
    expect(names.indexOf('session.step.failed')).toBeLessThan(names.indexOf('session.retry.scheduled'));
    const [failedStep] = events.filter((event) => event.type === 'session.step.failed');
    const [, secondStart] = events.filter((event) => event.type === 'session.step.started');
    expect(failedStep.data.assistantMessageID).toBe(assistantMessageId(T0 + 20));
    expect(secondStart.data.assistantMessageID).toBe(assistantMessageId(T0 + 200));
  });

  it('puts a failure that used tokens on the step and the totals', () => {
    const { feed, translator } = harness();
    const bad = failed(T0 + 20, 'Request was aborted', [{ type: 'text', text: 'x' }]);
    bad.stopReason = 'aborted';
    bad.usage = USAGE;
    const events = feed({ type: 'agent_start' }, start({ ...bad, content: [] }), end(bad), { type: 'turn_end', message: bad, toolResults: [] });
    const step = events.find((event) => event.type === 'session.step.failed');
    expect(step.data).toMatchObject({ tokens: { input: 100, output: 12, reasoning: 8 }, cost: 0.5 });
    expect(events.at(-1).type).toBe('session.usage.updated');
    expect(translator.totals().cost).toBe(0.5);
  });

  it('flushes a held failure when the retry is cancelled', () => {
    const { feed } = harness();
    const bad = failed(T0 + 20, 'Connection error.');
    const events = feed(
      { type: 'agent_start' }, start(bad), end(bad), { type: 'turn_end', message: bad, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: bad.errorMessage },
      { type: 'agent_settled', aborted: true },
    );
    expect(typesOf(events).slice(-3)).toEqual(['session.retry.scheduled', 'session.step.failed', 'session.execution.interrupted']);
  });
});

describe('compaction', () => {
  const result = { summary: '## Goal\nx', firstKeptEntryId: 'abc', tokensBefore: 100, usage: { ...USAGE, reasoning: 0, output: 10, totalTokens: 210 } };

  it('runs a manual compaction as its own execution with the id the coordinator queued', () => {
    const { translator, feed } = harness();
    translator.enqueueInbox({ inboxID: 'msg_compact', type: 'compaction' });
    const events = feed(
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false },
    );
    expect(typesOf(events)).toEqual([
      'session.execution.started',
      'session.inbox.delivered',
      'session.compaction.started',
      'session.usage.updated',
      'session.compaction.ended',
      'session.execution.succeeded',
    ]);
    expect(events[2].data).toEqual({ sessionID: 'ses_t', reason: 'manual', inputID: 'msg_compact' });
    expect(events[4].data).toMatchObject({ reason: 'manual', text: '## Goal\nx', tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0.5 });
    expect(events[5].idleMessage).toBeUndefined();
    expect(translator.execution).toEqual({ active: false, owner: null });
  });

  it('derives the id of an automatic compaction from the last message and leaves the cycle open', () => {
    const { feed, translator } = harness();
    const events = feed(
      { type: 'agent_start' },
      start(userMessage(T0 + 5, 'hi')),
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', result, aborted: false, willRetry: false },
    );
    const started = events.find((event) => event.type === 'session.compaction.started');
    expect(started.data).toEqual({ sessionID: 'ses_t', reason: 'auto', inputID: compactionMessageIdAfter(T0 + 5) });
    expect(events.some((event) => event.type === 'session.execution.succeeded')).toBe(false);
    expect(translator.execution).toEqual({ active: true, owner: 'agent' });
  });

  it('reports a compaction that failed or was cancelled', () => {
    const { feed } = harness();
    const events = feed(
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false, errorMessage: 'Compaction cancelled' },
    );
    expect(typesOf(events).slice(2)).toEqual(['session.compaction.failed', 'session.execution.interrupted']);
    expect(events[2].data).toMatchObject({ reason: 'manual', error: { type: 'compaction.failed', message: 'Compaction cancelled' }, cost: 0 });
  });
});

describe('totals, model and in-flight message', () => {
  it('adds each step to the totals it was given and reports them absolute', () => {
    const { feed, translator } = harness({ totals: { cost: 1, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
    const events = feed({ type: 'agent_start' }, ...answer(T0 + 20), ...answer(T0 + 200), { type: 'agent_settled', aborted: false });
    const totals = events.filter((event) => event.type === 'session.usage.updated').map((event) => event.data);
    expect(totals[0]).toMatchObject({ cost: 1.5, tokens: { input: 110, output: 22, reasoning: 8, cache: { read: 100, write: 0 } } });
    expect(totals[1]).toMatchObject({ cost: 2, tokens: { input: 210, output: 34, reasoning: 16, cache: { read: 200, write: 0 } } });
    expect(translator.totals()).toEqual({ cost: 2, tokens: totals[1].tokens });
  });

  it('names the thinking level as the variant and the configured agent', () => {
    const { feed, translator } = harness({ getAgent: () => 'plan', getThinkingLevel: () => 'high' });
    expect(feed({ type: 'agent_start' }, start(assistantMessage(T0 + 20, [], { thinkingLevel: undefined })))[1].data).toMatchObject({ agent: 'plan', model: { variant: 'high' } });
    feed({ type: 'thinking_level_changed', level: 'minimal' });
    translator.setThinkingLevel('minimal');
    expect(feed(start(assistantMessage(T0 + 30, [], { thinkingLevel: undefined })))[0].data.model.variant).toBe('minimal');
  });

  it('serves the half-built assistant message as a page read during streaming shows it', () => {
    const { feed, translator } = harness();
    expect(translator.inflightAssistantMessage()).toBeNull();
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } };
    const message = assistantMessage(T0 + 20, [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Running. ' }, call], { stopReason: 'toolUse' });
    feed(
      { type: 'agent_start' },
      start({ ...message, content: [] }),
      update({ type: 'thinking_start', contentIndex: 0 }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' }),
      update({ type: 'text_start', contentIndex: 1 }),
      update({ type: 'text_delta', contentIndex: 1, delta: 'Running. ' }),
      update({ type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'bash' }),
      update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"command":' }),
    );
    const streaming = translator.inflightAssistantMessage();
    expect(streaming.id).toBe(assistantMessageId(T0 + 20));
    expect(streaming).toMatchObject({ type: 'assistant', agent: 'build', model: { id: 'mock-model', providerID: 'mock', variant: 'low' } });
    expect(streaming.time.completed).toBeUndefined();
    expect(streaming.content).toEqual([
      { type: 'reasoning', text: '', time: { created: expect.any(Number) } },
      { type: 'text', text: '' },
      { type: 'tool', id: 'c1', name: 'shell', state: { status: 'streaming', input: '' }, time: { created: expect.any(Number) } },
    ]);

    feed(
      update({ type: 'thinking_end', contentIndex: 0, content: 'hm' }),
      update({ type: 'text_end', contentIndex: 1, content: 'Running. ' }),
      update({ type: 'toolcall_end', contentIndex: 2, toolCall: call }),
      end(message),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: call.arguments },
    );
    const running = translator.inflightAssistantMessage();
    expect(running.time.streamed).toBeDefined();
    expect(running.content[0]).toMatchObject({ type: 'reasoning', text: 'hm' });
    expect(running.content[1]).toEqual({ type: 'text', text: 'Running. ' });
    expect(running.content[2]).toMatchObject({
      type: 'tool', id: 'c1', name: 'shell', executed: false, state: { status: 'running', input: { command: 'echo hi' }, metadata: {} }, time: { created: expect.any(Number), ran: expect.any(Number) },
    });

    feed(
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false },
    );
    expect(translator.inflightAssistantMessage().content[2].state).toMatchObject({ status: 'completed', content: [{ type: 'text', text: 'hi\n' }] });

    feed({ type: 'turn_end', message, toolResults: [] });
    expect(translator.inflightAssistantMessage()).toBeNull();
  });

  it('serves a held failure with its retry while the next attempt waits', () => {
    const { feed, translator } = harness();
    const bad = assistantMessage(T0 + 20, [], { stopReason: 'error', errorMessage: 'Connection error.', usage: NO_USAGE });
    feed({ type: 'agent_start' }, start(bad), end(bad), { type: 'turn_end', message: bad, toolResults: [] }, { type: 'agent_end', messages: [], willRetry: true });
    expect(translator.inflightAssistantMessage().retry).toBeUndefined();
    feed({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Connection error.' });
    expect(translator.inflightAssistantMessage()).toMatchObject({
      id: assistantMessageId(T0 + 20),
      content: [],
      retry: { attempt: 2, at: expect.any(Number), error: { type: 'provider.transport' } },
    });
  });

  it('reports whether an execution is open', () => {
    const { feed, translator } = harness();
    expect(translator.execution).toEqual({ active: false, owner: null });
    feed({ type: 'agent_start' });
    expect(translator.execution).toEqual({ active: true, owner: 'agent' });
    feed({ type: 'agent_settled', aborted: false });
    expect(translator.execution).toEqual({ active: false, owner: null });
  });
});

describe('recorded Pi 1.5.0 sessions', () => {
  it.each(FIXTURE_NAMES)('%s: every event is a wire event with matching durability and data', async (name) => {
    const { checkEvent, decodeMessage } = await loadWireSchemas();
    const { wireEvents } = replayFixture(loadFixture(name));
    expect(wireEvents.length).toBeGreaterThan(0);
    for (const event of wireEvents) {
      expect(() => checkEvent(event), `${event.type} ${JSON.stringify(event.data).slice(0, 200)}`).not.toThrow();
      if (event.idleMessage) expect(() => decodeMessage(event.idleMessage)).not.toThrow();
    }
  });

  it.each(FIXTURE_NAMES)('%s: the stream obeys the ordering rules of wire spec 4.4', (name) => {
    const { wireEvents } = replayFixture(loadFixture(name));
    const names = typesOf(wireEvents);
    expect(names.slice(0, 2)).toEqual(['session.inbox.enqueued', 'session.execution.started']);
    expect(names).not.toContain('session.tool.input.delta');

    let open = null;
    let executions = 0;
    const steps = new Set();
    const closed = new Set();
    const toolStates = new Map();
    for (const { type, data } of wireEvents) {
      if (type === 'session.execution.started') {
        expect(executions % 2).toBe(0);
        executions += 1;
      }
      if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) {
        expect(executions % 2).toBe(1);
        executions += 1;
        expect(open, 'the run ended with a step still open').toBeNull();
      }
      if (type === 'session.step.started') {
        open = data.assistantMessageID;
        steps.add(open);
        closed.delete(open);
      }
      if (type === 'session.step.ended' || type === 'session.step.failed') {
        expect(data.assistantMessageID).toBe(open);
        open = null;
        closed.add(data.assistantMessageID);
      }
      if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type) || type.startsWith('session.tool.')) expect(data.assistantMessageID).toBe(open);
      if (type === 'session.tool.input.started') toolStates.set(data.id, 'started');
      if (type === 'session.tool.called') {
        expect(toolStates.get(data.id)).toBe('started');
        toolStates.set(data.id, 'called');
      }
      if (type === 'session.tool.success' || type === 'session.tool.failed') {
        expect(toolStates.get(data.id)).toBe('called');
        toolStates.set(data.id, 'settled');
      }
    }
    expect(executions % 2).toBe(0);
    expect([...closed].sort()).toEqual([...steps].sort());
    expect([...toolStates.values()].every((state) => state === 'settled')).toBe(true);
  });

  it.each(FIXTURE_NAMES)('%s: text and reasoning deltas add up to what the block ends with', (name) => {
    const { wireEvents } = replayFixture(loadFixture(name));
    const streamed = new Map();
    for (const { type, data } of wireEvents) {
      const kind = /^session\.(text|reasoning)\./.exec(type)?.[1];
      if (!kind) continue;
      const key = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      if (type.endsWith('.delta')) streamed.set(key, (streamed.get(key) ?? '') + data.delta);
      if (type.endsWith('.ended') && streamed.has(key)) expect(data.text).toBe(streamed.get(key));
    }
  });

  it('plain: one step, usage and a succeeded run', () => {
    const { wireEvents } = replayFixture(loadFixture('plain'));
    expect(typesOf(wireEvents).filter((type) => !type.endsWith('.delta'))).toEqual([
      'session.inbox.enqueued', 'session.execution.started', 'session.inbox.delivered',
      'session.step.started', 'session.text.started', 'session.text.ended', 'session.step.streamed', 'session.step.ended',
      'session.usage.updated', 'session.execution.succeeded',
    ]);
    expect(wireEvents.find((event) => event.type === 'session.text.ended').data.text).toBe('plain answer');
    expect(wireEvents.find((event) => event.type === 'session.step.ended').data.tokens).toEqual({ input: 80, output: 6, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  it('reasoning-bash: reasoning, text and a shell call, then the final answer', () => {
    const { wireEvents } = replayFixture(loadFixture('reasoning-bash'));
    const names = typesOf(wireEvents).filter((type) => !type.endsWith('.delta') && !type.endsWith('.progress'));
    expect(names).toEqual([
      'session.inbox.enqueued', 'session.execution.started', 'session.inbox.delivered',
      'session.step.started', 'session.reasoning.started', 'session.text.started', 'session.tool.input.started',
      'session.reasoning.ended', 'session.text.ended', 'session.tool.input.ended', 'session.tool.called', 'session.step.streamed',
      'session.tool.success', 'session.step.ended', 'session.usage.updated',
      'session.step.started', 'session.text.started', 'session.text.ended', 'session.step.streamed', 'session.step.ended', 'session.usage.updated',
      'session.execution.succeeded',
    ]);
    const started = wireEvents.find((event) => event.type === 'session.tool.input.started');
    expect(started.data).toMatchObject({ id: 'call_1', name: 'shell' });
    const usageEvents = wireEvents.filter((event) => event.type === 'session.usage.updated').map((event) => event.data.tokens);
    expect(usageEvents[0]).toEqual({ input: 100, output: 12, reasoning: 8, cache: { read: 0, write: 0 } });
    expect(usageEvents[1]).toEqual({ input: 200, output: 24, reasoning: 8, cache: { read: 100, write: 0 } });
  });

  it('abort: the response ends with a failed step and the run is interrupted by the user', () => {
    const { wireEvents } = replayFixture(loadFixture('abort'));
    const tail = wireEvents.slice(-3);
    expect(typesOf(tail)).toEqual(['session.step.streamed', 'session.step.failed', 'session.execution.interrupted']);
    expect(tail[1].data.error).toEqual({ type: 'aborted', message: 'Step interrupted' });
    expect(tail[2].data.reason).toBe('user');
  });

  it('error-flaky: the failed request and its retry are one assistant message', () => {
    const { wireEvents } = replayFixture(loadFixture('error-flaky'));
    const ids = new Set(wireEvents.filter((event) => event.type === 'session.step.started').map((event) => event.data.assistantMessageID));
    expect(ids.size).toBe(1);
    expect(typesOf(wireEvents)).toContain('session.retry.scheduled');
    expect(typesOf(wireEvents).at(-1)).toBe('session.execution.succeeded');
  });

  it.each([
    ['error-retry', 'provider.transport', undefined],
    ['error-http500', 'provider.internal', 500],
    ['error-http429', 'provider.rate-limit', 429],
    ['error-http400', 'provider.invalid-request', 400],
  ])('%s: the run fails with %s', (name, type, status) => {
    const { wireEvents } = replayFixture(loadFixture(name));
    const last = wireEvents.at(-1);
    expect(last.type).toBe('session.execution.failed');
    expect(last.data.error).toMatchObject({ type, ...(status ? { status } : {}) });
    expect(wireEvents.filter((event) => event.type === 'session.step.failed')).toHaveLength(1);
    expect(last.idleMessage).toMatchObject({ outcome: 'failed', error: { type } });
  });

  it('steer: the steered message is delivered between the steps of one run', () => {
    const { wireEvents, enqueued } = replayFixture(loadFixture('steer'));
    expect(enqueued).toHaveLength(2);
    const names = typesOf(wireEvents).filter((type) => !type.endsWith('.delta') && !type.endsWith('.progress'));
    const delivered = names.map((type, index) => (type === 'session.inbox.delivered' ? index : -1)).filter((index) => index >= 0);
    expect(delivered).toHaveLength(2);
    expect(names.slice(delivered[1] - 2, delivered[1] + 2)).toEqual(['session.step.ended', 'session.usage.updated', 'session.inbox.delivered', 'session.step.started']);
    expect(names.filter((type) => type === 'session.execution.started')).toHaveLength(1);
    expect(names.at(-1)).toBe('session.execution.succeeded');
  });

  it('compaction: the manual compaction is its own execution with the id the transcript derives', () => {
    const fixture = loadFixture('compaction');
    const { wireEvents } = replayFixture(fixture);
    const started = wireEvents.find((event) => event.type === 'session.compaction.started');
    const lastAssistant = fixture.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').at(-2).message;
    expect(started.data.inputID).toBe(compactionMessageIdAfter(lastAssistant.timestamp));
    const names = typesOf(wireEvents);
    const at = names.indexOf('session.compaction.started');
    expect(names.slice(at - 3, at + 1)).toEqual(['session.inbox.enqueued', 'session.execution.started', 'session.inbox.delivered', 'session.compaction.started']);
    expect(names.slice(at + 1, at + 4)).toEqual(['session.usage.updated', 'session.compaction.ended', 'session.execution.succeeded']);
  });
});
