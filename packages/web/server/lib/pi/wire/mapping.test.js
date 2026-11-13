import { describe, expect, it } from 'vitest';

import { ascendingIdTime } from './ids.js';
import {
  addUsage,
  assistantMessageId,
  classifyProviderError,
  compactionMessageIdAfter,
  costFromUsage,
  DENIED_TOOL_TEXT_PREFIX,
  finishFromStopReason,
  hasUsage,
  idleMessageIdAfter,
  mapToolInput,
  mapToolResult,
  modelRef,
  noticeMessageId,
  REJECTED_TOOL_TEXT,
  shellMessageId,
  thinkingLevelFromVariant,
  tokensFromUsage,
  userMessageId,
  userPayloadFromContent,
  variantFromThinkingLevel,
  wireToolName,
} from './mapping.js';
import { FIXTURE_NAMES, loadFixture } from './test-support/replay.js';

const CWD = '/work/project';

describe('tool names', () => {
  it('renames the tools the UI knows under other names and keeps the rest', () => {
    expect(['bash', 'find', 'ls', 'read', 'edit', 'write', 'grep', 'codemode', 'openchamber_render', 'mcp__srv__tool'].map(wireToolName))
      .toEqual(['shell', 'glob', 'read', 'read', 'edit', 'write', 'grep', 'execute', 'openchamber_render', 'mcp__srv__tool']);
  });
});

describe('mapToolInput', () => {
  it('turns the shell timeout from seconds into the milliseconds the row shows', () => {
    expect(mapToolInput({ toolName: 'bash', args: { command: 'sleep 1', timeout: 2 }, cwd: CWD })).toEqual({ command: 'sleep 1', timeout: 2000 });
  });

  it('maps an edit onto the legacy fields from its first edit and keeps the edits', () => {
    const edits = [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }];
    expect(mapToolInput({ toolName: 'edit', args: { path: 'x.txt', edits }, cwd: CWD }))
      .toEqual({ path: 'x.txt', edits, oldString: 'a', newString: 'b' });
  });

  it('maps grep options onto the wire names and keeps the originals', () => {
    expect(mapToolInput({ toolName: 'grep', args: { pattern: 'p', glob: '*.js', ignoreCase: true }, cwd: CWD }))
      .toEqual({ pattern: 'p', glob: '*.js', ignoreCase: true, include: '*.js', caseSensitive: false });
    expect(mapToolInput({ toolName: 'grep', args: { pattern: 'p' }, cwd: CWD })).toEqual({ pattern: 'p' });
  });

  it('reads a directory with `ls`, defaulting to the session directory', () => {
    expect(mapToolInput({ toolName: 'ls', args: {}, cwd: CWD })).toEqual({ path: CWD });
    expect(mapToolInput({ toolName: 'ls', args: { path: 'src', limit: 10 }, cwd: CWD })).toEqual({ path: 'src', limit: 10 });
  });

  it('passes other tools through and survives missing arguments', () => {
    expect(mapToolInput({ toolName: 'read', args: { path: 'a', offset: 3 }, cwd: CWD })).toEqual({ path: 'a', offset: 3 });
    expect(mapToolInput({ toolName: 'custom', args: undefined, cwd: CWD })).toEqual({});
  });
});

describe('mapToolResult for subagent', () => {
  it('carries the child session into the metadata so the row can open it', () => {
    const result = mapToolResult({ toolName: 'subagent', content: [{ type: 'text', text: '<subagent sessionID="ses_c" state="completed">\nanswer\n</subagent>' }], details: { sessionID: 'ses_c', status: 'completed' } });
    expect(result).toMatchObject({ status: 'completed', metadata: { sessionID: 'ses_c', status: 'completed', truncated: false } });
  });

  it('leaves the metadata alone when the call never started a child', () => {
    const result = mapToolResult({ toolName: 'subagent', content: [{ type: 'text', text: 'x' }], details: {} });
    expect(result.metadata).toBeUndefined();
  });
});

describe('mapToolResult', () => {
  const text = (value) => [{ type: 'text', text: value }];

  it('completes a shell command and reads the exit code from the text Pi appends', () => {
    const result = mapToolResult({ toolName: 'bash', content: text('out\nerr\n\n\nCommand exited with code 3'), isError: true });
    expect(result).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'out\nerr\n' }, { type: 'text', text: 'Exited with code 3' }],
      metadata: { status: 'completed', truncated: false, exit: 3 },
    });
  });

  it('completes a clean shell command and says so when there is no output', () => {
    expect(mapToolResult({ toolName: 'bash', content: text('hi\n'), isError: false }).metadata).toEqual({ status: 'completed', truncated: false, exit: 0 });
    expect(mapToolResult({ toolName: 'bash', content: [], isError: false }).content).toEqual([{ type: 'text', text: '(no output)' }]);
    expect(mapToolResult({ toolName: 'bash', content: text('\n\nCommand exited with code 1'), isError: true }).content)
      .toEqual([{ type: 'text', text: '(no output)' }, { type: 'text', text: 'Exited with code 1' }]);
  });

  it('marks truncated shell output and keeps where Pi saved the rest', () => {
    const result = mapToolResult({
      toolName: 'bash',
      content: text('tail'),
      details: { truncation: { truncated: true, truncatedBy: 'lines' }, fullOutputPath: '/tmp/pi-bash-1.log' },
      isError: false,
    });
    expect(result.metadata).toMatchObject({ truncated: true, outputPath: '/tmp/pi-bash-1.log' });
    // The live event also carries structuredContent; the stored message has only details.
    expect(mapToolResult({ toolName: 'bash', content: text('x'), structuredContent: { truncated: true }, isError: false }).metadata.truncated).toBe(true);
  });

  it('fails a shell command that did not run to its end', () => {
    expect(mapToolResult({ toolName: 'bash', content: text('Command timed out after 1 seconds'), isError: true }))
      .toEqual({ status: 'error', error: { type: 'tool.execution', message: 'Command timed out after 1 seconds' } });
    expect(mapToolResult({ toolName: 'bash', content: text('Command aborted'), isError: true }))
      .toEqual({ status: 'error', error: { type: 'aborted', message: 'Tool execution interrupted' } });
  });

  it('builds the diff list of an edit from Pi\'s patch and counts its lines', () => {
    const patch = '--- notes.txt\n+++ notes.txt\n@@ -1,3 +1,3 @@\n-line one\n+line ONE\n line two\n--- a removed line that starts with dashes\n+++ an added one\n';
    const result = mapToolResult({
      toolName: 'edit',
      args: { path: '/work/project/notes.txt' },
      cwd: CWD,
      content: text('Successfully replaced 1 block(s) in notes.txt.'),
      details: { diff: '-1 line one\n+1 line ONE', patch },
      isError: false,
    });
    expect(result.metadata.files).toEqual([{
      file: 'notes.txt',
      patch: `Index: notes.txt\n${'='.repeat(67)}\n${patch}`,
      status: 'modified',
      additions: 2,
      deletions: 2,
    }]);
    expect(result.metadata.truncated).toBe(false);
  });

  it('keeps an edit outside the session directory by its path', () => {
    const result = mapToolResult({ toolName: 'edit', args: { path: '/etc/hosts' }, cwd: CWD, content: text('ok'), details: { patch: '@@ -1 +1 @@\n-a\n+b\n' }, isError: false });
    expect(result.metadata.files[0].file).toBe('/etc/hosts');
  });

  it('fails an edit that Pi refused', () => {
    const result = mapToolResult({ toolName: 'edit', args: { path: 'a' }, cwd: CWD, content: text('Could not find the exact text in a.'), details: {}, isError: true });
    expect(result).toEqual({ status: 'error', error: { type: 'tool.execution', message: 'Could not find the exact text in a.' } });
  });

  it('maps read, grep, find and ls results with their truncation', () => {
    expect(mapToolResult({ toolName: 'read', content: text('a'), isError: false }).metadata).toEqual({ truncated: false });
    expect(mapToolResult({ toolName: 'read', content: text('a'), details: { truncation: { truncated: true } }, isError: false }).metadata.truncated).toBe(true);
    expect(mapToolResult({ toolName: 'grep', content: text('a'), details: { matchLimitReached: 100 }, isError: false }).metadata.truncated).toBe(true);
    expect(mapToolResult({ toolName: 'find', content: text('a'), details: { resultLimitReached: 1000 }, isError: false }).metadata.truncated).toBe(true);
    expect(mapToolResult({ toolName: 'ls', content: text('a'), details: { entryLimitReached: 500 }, isError: false }).metadata.truncated).toBe(true);
    expect(mapToolResult({ toolName: 'write', content: text('Successfully wrote to out.txt'), isError: false }).metadata).toEqual({ truncated: false });
  });

  it('turns images into file items and an empty result into "(no output)"', () => {
    const image = mapToolResult({ toolName: 'read', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false });
    expect(image.content).toEqual([{ type: 'file', uri: 'data:image/png;base64,AAAA', mime: 'image/png' }]);
    expect(mapToolResult({ toolName: 'custom', content: [], isError: false }).content).toEqual([{ type: 'text', text: '(no output)' }]);
  });

  it('passes the OpenChamber managed tool details through as metadata', () => {
    const openchamber = { schemaVersion: 1, action: 'page', ok: true };
    expect(mapToolResult({ toolName: 'openchamber_render', content: text('{}'), details: { openchamber }, isError: false }).metadata).toEqual({ openchamber });
    const failed = mapToolResult({ toolName: 'openchamber_render', content: text('nope'), details: { openchamber }, isError: true });
    expect(failed).toMatchObject({ status: 'error', metadata: { openchamber } });
  });

  it('fails a call the gate blocked as rejected or denied, from what the gate recorded or from its wording', () => {
    const rejected = mapToolResult({ toolName: 'bash', content: text('no thanks'), isError: true, blocked: { kind: 'rejected', message: 'no thanks' } });
    expect(rejected).toEqual({ status: 'error', error: { type: 'permission.rejected', message: 'no thanks' } });
    const denied = mapToolResult({ toolName: 'bash', content: text('rule'), isError: true, blocked: { kind: 'denied', message: 'rule' } });
    expect(denied).toEqual({ status: 'error', error: { type: 'tool.execution', message: 'rule' } });
    // Stored: only the text is left.
    expect(mapToolResult({ toolName: 'bash', content: text(REJECTED_TOOL_TEXT), isError: true }).error).toEqual({ type: 'permission.rejected', message: REJECTED_TOOL_TEXT });
    const rule = `${DENIED_TOOL_TEXT_PREFIX} which prevents you from using this specific tool call (shell: rm *).`;
    expect(mapToolResult({ toolName: 'bash', content: text(rule), isError: true }).error).toEqual({ type: 'tool.execution', message: rule });
    // A message the user wrote cannot be told apart afterwards.
    expect(mapToolResult({ toolName: 'bash', content: text('please use git instead'), isError: true }).error.type).toBe('tool.execution');
    // The hook's answer only applies to a call that failed.
    expect(mapToolResult({ toolName: 'bash', content: text('ok'), isError: false, blocked: { kind: 'rejected', message: 'x' } }).status).toBe('completed');
  });

  it('maps the question tool by how it ended', () => {
    const answered = mapToolResult({ toolName: 'question', content: text('User has answered your questions: "Q"="A".'), details: { answers: [['A']], truncated: false }, isError: false });
    expect(answered).toEqual({ status: 'completed', content: text('User has answered your questions: "Q"="A".'), metadata: { answers: [['A']], truncated: false } });
    expect(mapToolResult({ toolName: 'question', content: text('The user dismissed this question'), details: { dismissed: true }, isError: true }))
      .toEqual({ status: 'error', error: { type: 'aborted', message: 'The user dismissed this question' } });
    expect(mapToolResult({ toolName: 'question', content: text('x'), details: { interrupted: true }, isError: true }))
      .toEqual({ status: 'error', error: { type: 'aborted', message: 'Tool execution interrupted' } });
    // Without details a question fails like any other tool.
    expect(mapToolResult({ toolName: 'question', content: text('boom'), isError: true }).error).toEqual({ type: 'tool.execution', message: 'boom' });
  });

  it('fails a tool that was not found with its own message', () => {
    expect(mapToolResult({ toolName: 'nope_tool', content: text('Tool nope_tool not found'), details: {}, isError: true }))
      .toEqual({ status: 'error', error: { type: 'tool.execution', message: 'Tool nope_tool not found' } });
  });
});

describe('usage and finish', () => {
  const usage = { input: 100, output: 20, cacheRead: 100, cacheWrite: 5, reasoning: 8, totalTokens: 225, cost: { total: 0.25 } };

  it('moves reasoning out of output, as the reference server counts', () => {
    expect(tokensFromUsage(usage)).toEqual({ input: 100, output: 12, reasoning: 8, cache: { read: 100, write: 5 } });
    expect(costFromUsage(usage)).toBe(0.25);
  });

  it('never goes negative or non-finite', () => {
    expect(tokensFromUsage({ output: 2, reasoning: 5 }).output).toBe(0);
    expect(tokensFromUsage(undefined)).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(costFromUsage({ cost: { total: Number.NaN } })).toBe(0);
  });

  it('recognises usage the provider reported', () => {
    expect(hasUsage(usage)).toBe(true);
    expect(hasUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } })).toBe(false);
    expect(hasUsage(undefined)).toBe(false);
  });

  it('adds usage onto absolute totals', () => {
    const first = addUsage({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, usage);
    const second = addUsage(first, usage);
    expect(second).toEqual({ cost: 0.5, tokens: { input: 200, output: 24, reasoning: 16, cache: { read: 200, write: 10 } } });
  });

  it('maps stop reasons to finish', () => {
    expect(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred', 'other'].map(finishFromStopReason))
      .toEqual(['stop', 'length', 'tool-calls', 'error', 'error', 'unknown', 'unknown']);
  });
});

describe('classifyProviderError', () => {
  // The first four strings are what Pi 1.5.0 reported for the recorded failures (wire/fixtures/error-*.json).
  it.each([
    ['Connection error.', undefined, { type: 'provider.transport', message: 'Connection error.' }],
    ['500: {"message":"mock upstream exploded","type":"server_error"}', undefined, {
      type: 'provider.internal', message: 'mock upstream exploded', status: 500, response: { body: '{"message":"mock upstream exploded","type":"server_error"}' },
    }],
    ['429: {"message":"mock rate limit","type":"rate_limit_error"}', undefined, {
      type: 'provider.rate-limit', message: 'mock rate limit', status: 429, response: { body: '{"message":"mock rate limit","type":"rate_limit_error"}' },
    }],
    ['400: {"message":"mock bad request","type":"invalid_request_error"}', undefined, {
      type: 'provider.invalid-request', message: 'mock bad request', status: 400, response: { body: '{"message":"mock bad request","type":"invalid_request_error"}' },
    }],
    ['Request was aborted', 'aborted', { type: 'aborted', message: 'Step interrupted' }],
    ['This operation was aborted', 'error', { type: 'aborted', message: 'Step interrupted' }],
  ])('%s', (message, stopReason, expected) => {
    expect(classifyProviderError(message, { stopReason })).toEqual(expected);
  });

  it('treats overload and quota wording as rate limiting, with or without a status', () => {
    expect(classifyProviderError('529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toMatchObject({ type: 'provider.rate-limit', status: 529, message: 'Overloaded' });
    expect(classifyProviderError('Provider returned error: quota exceeded for this key').type).toBe('provider.rate-limit');
    expect(classifyProviderError('rate limit reached, try again in 20s')).toMatchObject({ type: 'provider.rate-limit', retryAfterMs: 20_000 });
    expect(classifyProviderError('429 Too Many Requests, retry-after: 2')).toMatchObject({ retryAfterMs: 2000 });
  });

  it('separates server errors, client errors and connection failures', () => {
    expect(classifyProviderError('503 Service Unavailable').type).toBe('provider.internal');
    expect(classifyProviderError('401 {"error":{"message":"bad key"}}')).toMatchObject({ type: 'provider.invalid-request', status: 401, message: 'bad key' });
    expect(classifyProviderError('408 Request Timeout').type).toBe('provider.transport');
    expect(classifyProviderError('read ECONNRESET').type).toBe('provider.transport');
    expect(classifyProviderError('fetch failed').type).toBe('provider.transport');
    expect(classifyProviderError('This model\'s maximum context length is 8192 tokens').type).toBe('provider.invalid-request');
  });

  it('finds a status Pi reports in the middle of the text or inside the body', () => {
    expect(classifyProviderError('Request failed with status code 502')).toMatchObject({ type: 'provider.internal', status: 502 });
    expect(classifyProviderError('upstream: {"error":{"code":500,"message":"internal"}}')).toMatchObject({ type: 'provider.internal', status: 500, message: 'internal' });
  });

  it('falls back to unknown and to a generic message', () => {
    expect(classifyProviderError('something odd')).toEqual({ type: 'provider.unknown', message: 'something odd' });
    expect(classifyProviderError(undefined)).toEqual({ type: 'provider.unknown', message: 'The model request failed.' });
  });
});

describe('message ids', () => {
  it('has the wire layout: 12 hex time digits and 14 base62 characters', () => {
    expect(assistantMessageId(1_794_291_410_526)).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(userMessageId(1_794_291_410_526)).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('is deterministic and different for different roles and times', () => {
    expect(assistantMessageId(1000)).toBe(assistantMessageId(1000));
    expect(assistantMessageId(1000)).not.toBe(userMessageId(1000));
    expect(assistantMessageId(1000)).not.toBe(assistantMessageId(1001));
  });

  it('puts the millisecond in the time digits, like an id minted by the server', () => {
    const ts = 1_794_291_410_526;
    expect(ascendingIdTime(assistantMessageId(ts))).toBe(ts % 2 ** 36);
  });

  it('orders a user message, its answer and the idle message even inside one millisecond', () => {
    const ts = 1_794_291_520_867;
    const next = ts + 1;
    const ordered = [userMessageId(ts), assistantMessageId(ts), idleMessageIdAfter(ts), compactionMessageIdAfter(ts), userMessageId(next)];
    expect([...ordered].sort()).toEqual(ordered);
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it('keeps the id the UI minted when the coordinator knows it', () => {
    const minted = 'msg_1c41bd563001AbCdEfGhIjKlMn';
    expect(userMessageId(5000, { 5000: minted })).toBe(minted);
    expect(userMessageId(5000, new Map([[5000, minted]]))).toBe(minted);
    expect(userMessageId(5000, new Map([['5000', minted]]))).toBe(minted);
    expect(userMessageId(5000, { 5000: 'not-a-message-id' })).toBe(userMessageId(5000));
    expect(shellMessageId(7, { 7: minted })).toBe(minted);
  });

  it('derives notice ids from the entry that produced them', () => {
    expect(noticeMessageId('model', 5000, 'a1b2c3d4')).toBe(noticeMessageId('model', 5000, 'a1b2c3d4'));
    expect(noticeMessageId('model', 5000, 'a1b2c3d4')).not.toBe(noticeMessageId('model', 5000, 'ffffffff'));
  });
});

describe('model and variant', () => {
  it('uses the thinking level as the variant, one to one', () => {
    expect(modelRef({ provider: 'anthropic', model: 'claude-x', thinkingLevel: 'high' })).toEqual({ id: 'claude-x', providerID: 'anthropic', variant: 'high' });
    expect(modelRef({ provider: 'mock', model: 'm' })).toEqual({ id: 'm', providerID: 'mock', variant: 'default' });
    expect(variantFromThinkingLevel('off')).toBe('off');
    expect(thinkingLevelFromVariant('default')).toBeUndefined();
    expect(thinkingLevelFromVariant('low')).toBe('low');
  });
});

describe('userPayloadFromContent', () => {
  it('joins text blocks and turns image blocks into inline files', () => {
    expect(userPayloadFromContent('plain')).toEqual({ text: 'plain', files: [] });
    expect(userPayloadFromContent([{ type: 'text', text: 'a' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: 'b' }]))
      .toEqual({ text: 'a\nb', files: [{ data: 'QUJD', mime: 'image/png', source: { type: 'inline' } }] });
  });
});

describe('recorded Pi 1.5.0 sessions', () => {
  it.each(FIXTURE_NAMES)('%s: a message has the same timestamp in message_start, message_end and the session file', (name) => {
    const fixture = loadFixture(name);
    const stored = new Set(fixture.entries.filter((entry) => entry.type === 'message').map((entry) => `${entry.message.role}:${entry.message.timestamp}`));
    const seen = fixture.events.filter((event) => event.type === 'message_start' && event.message.role !== 'system').map((event) => event.message);
    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      expect(stored.has(`${message.role}:${message.timestamp}`), `${message.role} ${message.timestamp}`).toBe(true);
      const ended = fixture.events.find((event) => event.type === 'message_end' && event.message.role === message.role && event.message.timestamp === message.timestamp);
      expect(ended, `message_end for ${message.role} ${message.timestamp}`).toBeDefined();
    }
  });
});
