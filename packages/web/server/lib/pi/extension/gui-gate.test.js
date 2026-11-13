// The gate extension in a real `pi --mode rpc` child, against the real bridge
// transport, managers and routes (test-support/gate-bridge.js) and a mock model.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../launch.js';
import { createPiRpcClient } from '../rpc-client.js';
import { BUILD_AGENT_RULES, startGateBridge } from '../test-support/gate-bridge.js';
import { createPiFixture } from '../test-support/pi-fixture.js';

const GATE = fileURLToPath(new URL('./gui-gate.js', import.meta.url));

const temporary = [];
afterAll(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const waitFor = async (predicate, { timeoutMs = 20_000, message = 'condition not met' } = {}) => {
  const startedAt = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * An OpenAI-compatible model that calls the tools named in the last user message
 * (`TOOLS:[{"name":"bash","arguments":{...}}, ...]`, all in one assistant message)
 * and answers `Done: tool said hi` once their results are in.
 */
const startToolMock = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      const payload = JSON.parse(body || '{}');
      requests.push({ toolNames: (payload.tools ?? []).map((tool) => tool.function?.name), messages: payload.messages ?? [] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const base = { id: 'mock-1', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
      const choice = (delta, finish = null) => send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
      const messages = payload.messages ?? [];
      const lastUser = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const text = typeof lastUser === 'string' ? lastUser : lastUser.map((part) => part?.text ?? '').join('\n');
      const directive = /TOOLS:(\[.*\])/s.exec(text);
      if (messages.at(-1)?.role !== 'tool' && directive) {
        choice({ role: 'assistant', content: 'Calling the tools. ' });
        JSON.parse(directive[1]).forEach((call, index) => {
          choice({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
        });
        choice({}, 'tool_calls');
      } else {
        choice({ role: 'assistant', content: 'Done: ' });
        choice({ content: 'tool said hi' });
        choice({}, 'stop');
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
};

const directive = (...calls) => `TOOLS:${JSON.stringify(calls.map(([name, args]) => ({ name, arguments: args })))}`;
const bashRuns = (file, text = 'echo ran') => ['bash', { command: `${text} > ${file}` }];
const QUESTIONS = [
  { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
  { question: 'Which sizes?', header: 'Sizes', multiple: true, options: [{ label: 'S', description: 'small' }, { label: 'L', description: 'large' }] },
];

describe('the gate extension in a real Pi', () => {
  let mock;
  let fixture;
  let bridge;
  const clients = [];
  let counter = 0;

  beforeAll(async () => {
    mock = await startToolMock();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => { client.kill('SIGKILL'); await client.exited; }));
    await bridge?.close();
    bridge = undefined;
    mock.requests.length = 0;
  });

  /**
   * One bridge and one Pi child serving one session. `rules` are the session's
   * own permission rules; the agent is the default build agent.
   */
  const start = async ({ sessionRules = [], agentRules = BUILD_AGENT_RULES, env = {}, extensions = [], extraArgs = [], token } = {}) => {
    counter += 1;
    const sessionId = `ses_gate_${counter}`;
    const sessions = { [sessionId]: { directory: fixture.project, agentRules, sessionRules } };
    bridge = await startGateBridge({ sessions, defaultDirectory: fixture.project });
    const events = [];
    const stderr = [];
    const runtime = resolvePiRuntime();
    const client = createPiRpcClient({
      command: runtime.command,
      args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId, extensions: [GATE, ...extensions] }), ...extraArgs],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        ...runtime.env,
        OPENCHAMBER_PI_BRIDGE_URL: bridge.url,
        OPENCHAMBER_PI_BRIDGE_TOKEN: token ?? bridge.tokens.issue(sessionId),
        ...env,
      },
      onEvent: (event) => events.push(event),
      onStderr: (chunk) => stderr.push(chunk),
    });
    clients.push(client);
    const toolEnds = (toolName) => events.filter((event) => event.type === 'tool_execution_end' && event.toolName === toolName);
    return {
      client,
      sessionId,
      sessions,
      events,
      stderr,
      toolEnds,
      toolEnd: (toolName) => toolEnds(toolName)[0],
      prompt: (message) => client.request('prompt', { message }),
      settled: () => events.find((event) => event.type === 'agent_settled'),
      asked: () => bridge.events.filter((event) => event.type === 'permission.asked').map((event) => event.data),
      pending: () => bridge.permissions.listPending(),
      reply: (request, body) => bridge.api('POST', `/api/session/${request.sessionID}/permission/${request.id}/reply`, body),
      text: (end) => end.result.content.map((block) => block.text).join('\n'),
    };
  };
  const marker = (name) => path.join(fixture.project, name);
  const SHELL_ASKS = [{ action: 'shell', resource: '*', effect: 'ask' }];

  it('asks before a shell call, runs it once the user allows it, and emits the events in order', async () => {
    const pi = await start({ sessionRules: SHELL_ASKS });
    await pi.prompt(directive(bashRuns('once.txt')));
    const [request] = await waitFor(() => (pi.asked().length === 1 ? pi.asked() : null), { message: 'no permission.asked' });

    expect(request).toEqual({
      id: expect.stringMatching(/^per_/),
      sessionID: pi.sessionId,
      action: 'shell',
      resources: ['echo ran > once.txt'],
      save: ['echo *'],
      source: { type: 'tool', messageID: 'msg_for_call_0', id: 'call_0' },
    });
    expect(bridge.events[0].location).toEqual({ directory: fixture.project });
    expect(fs.existsSync(marker('once.txt'))).toBe(false);
    expect(pi.pending()).toEqual([request]);
    expect((await bridge.api('GET', `/api/session/${pi.sessionId}/permission/${request.id}`)).body.data).toEqual(request);

    expect((await pi.reply(request, { decision: 'once' })).status).toBe(204);
    await waitFor(() => pi.settled());
    expect(fs.readFileSync(marker('once.txt'), 'utf8')).toBe('ran\n');
    expect(pi.toolEnd('bash').isError).toBe(false);
    expect(bridge.eventTypes()).toEqual(['permission.asked', 'permission.replied']);
    expect(bridge.events[1].data).toEqual({ sessionID: pi.sessionId, requestID: request.id, reply: 'once' });
    expect(pi.pending()).toEqual([]);
    expect(pi.settled().aborted).not.toBe(true);
    // The model got the tool result and finished the turn.
    expect(mock.requests.at(-1).messages.at(-1).role).toBe('tool');
    expect((await pi.reply(request, { decision: 'once' })).status).toBe(404);
  });

  it('fails the tool with the user\'s message when the request is rejected, and with the standard one otherwise', async () => {
    const pi = await start({ sessionRules: SHELL_ASKS });
    await pi.prompt(directive(bashRuns('rejected.txt')));
    const [request] = await waitFor(() => (pi.asked().length === 1 ? pi.asked() : null));
    await pi.reply(request, { decision: 'reject', message: 'Run the build script instead.' });
    await waitFor(() => pi.settled());

    const end = pi.toolEnd('bash');
    expect(end.isError).toBe(true);
    expect(pi.text(end)).toBe('Run the build script instead.');
    expect(fs.existsSync(marker('rejected.txt'))).toBe(false);
    expect(bridge.permissions.takeBlocked(pi.sessionId, 'call_0')).toEqual({ kind: 'rejected', message: 'Run the build script instead.' });
    // The model saw the failure and the turn went on.
    expect(JSON.stringify(mock.requests.at(-1).messages.at(-1))).toContain('Run the build script instead.');
    expect(pi.settled().aborted).not.toBe(true);

    await pi.prompt(directive(bashRuns('rejected-again.txt')));
    const [second] = await waitFor(() => (pi.asked().length === 2 ? pi.asked().slice(1) : null));
    await pi.reply(second, { decision: 'reject' });
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
    expect(pi.text(pi.toolEnds('bash')[1])).toBe('The user rejected this tool call.');
  });

  it('saves a rule on always, does not ask the same program again, and asks once the rule is deleted', async () => {
    const pi = await start({ sessionRules: SHELL_ASKS });
    await pi.prompt(directive(bashRuns('always-1.txt')));
    const [request] = await waitFor(() => (pi.asked().length === 1 ? pi.asked() : null));
    await pi.reply(request, { decision: 'always' });
    await waitFor(() => pi.settled());

    const saved = (await bridge.api('GET', '/api/permission/saved')).body.data;
    expect(saved).toEqual([expect.objectContaining({ id: expect.stringMatching(/^psv_/), action: 'shell', resource: 'echo *' })]);

    await pi.prompt(directive(bashRuns('always-2.txt', 'echo again')));
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
    expect(fs.readFileSync(marker('always-2.txt'), 'utf8')).toBe('again\n');
    expect(pi.asked()).toHaveLength(1);

    // A command the saved pattern does not cover still asks.
    await pi.prompt(directive(['bash', { command: 'ls > ls.txt' }]));
    await waitFor(() => pi.asked().length === 2);
    await pi.reply(pi.asked()[1], { decision: 'once' });
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 3);

    const patched = await bridge.api('PATCH', `/api/permission/saved/${saved[0].id}`, { resource: 'echo ran*' });
    expect(patched.body.data).toMatchObject({ resource: 'echo ran*' });
    await pi.prompt(directive(bashRuns('always-3.txt', 'echo again')));
    await waitFor(() => pi.asked().length === 3);
    await pi.reply(pi.asked()[2], { decision: 'once' });
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 4);

    expect((await bridge.api('DELETE', `/api/permission/saved/${saved[0].id}`)).status).toBe(204);
    await pi.prompt(directive(bashRuns('always-4.txt')));
    await waitFor(() => pi.asked().length === 4);
    await pi.reply(pi.asked()[3], { decision: 'reject' });
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 5);
    expect(fs.existsSync(marker('always-4.txt'))).toBe(false);
  });

  it('asks for a .env file, not for .env.example, under the default agent, and reads nothing before the answer', async () => {
    fs.writeFileSync(marker('.env'), 'SECRET=1\n');
    fs.writeFileSync(marker('.env.example'), 'SECRET=\n');
    const pi = await start();
    await pi.prompt(directive(['read', { path: '.env.example' }]));
    await waitFor(() => pi.settled());
    expect(pi.asked()).toEqual([]);
    expect(pi.text(pi.toolEnd('read'))).toContain('SECRET=');

    await pi.prompt(directive(['read', { path: '.env' }]));
    const [request] = await waitFor(() => (pi.asked().length === 1 ? pi.asked() : null));
    expect(request).toMatchObject({ action: 'read', resources: [marker('.env')], save: [marker('.env')], source: { id: 'call_0' } });
    expect(pi.toolEnds('read')).toHaveLength(1);
    await pi.reply(request, { decision: 'once' });
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
    expect(pi.text(pi.toolEnds('read')[1])).toContain('SECRET=1');
  });

  it('names the other built-in tools by the action OpenCode uses, on the absolute path', async () => {
    const pi = await start({ agentRules: [{ action: '*', resource: '*', effect: 'ask' }], extraArgs: ['--tools', '+grep,+find,+ls'] });
    const run = async (message, expected) => {
      const before = pi.asked().length;
      await pi.prompt(message);
      const request = await waitFor(() => (pi.asked().length === before + 1 ? pi.asked()[before] : null));
      expect(request).toMatchObject(expected);
      await pi.reply(request, { decision: 'once' });
      await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === before + 1);
    };
    await run(directive(['write', { path: 'out/new.txt', content: 'x' }]), { action: 'edit', resources: [marker('out/new.txt')] });
    await run(directive(['edit', { path: 'out/new.txt', edits: [{ oldText: 'x', newText: 'y' }] }]), { action: 'edit', resources: [marker('out/new.txt')] });
    await run(directive(['grep', { pattern: 'y', path: 'out' }]), { action: 'grep', resources: [marker('out')] });
    await run(directive(['find', { pattern: '*.txt' }]), { action: 'glob', resources: [fixture.project] });
    await run(directive(['ls', { path: 'out' }]), { action: 'read', resources: [marker('out')] });
    expect(fs.readFileSync(marker('out/new.txt'), 'utf8')).toBe('y');
  });

  it('blocks a call a deny rule names without asking, and says why', async () => {
    const pi = await start({ sessionRules: [{ action: 'shell', resource: 'rm *', effect: 'deny' }] });
    await pi.prompt(directive(['bash', { command: 'rm -rf precious && echo x' }]));
    await waitFor(() => pi.settled());
    expect(pi.asked()).toEqual([]);
    expect(bridge.events).toEqual([]);
    const end = pi.toolEnd('bash');
    expect(end.isError).toBe(true);
    expect(pi.text(end)).toContain('prevents you from using this specific tool call');
    expect(bridge.permissions.takeBlocked(pi.sessionId, 'call_0')).toMatchObject({ kind: 'denied' });
    // Another command in the same session is not affected.
    await pi.prompt(directive(bashRuns('fine.txt')));
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
    expect(fs.existsSync(marker('fine.txt'))).toBe(true);
  });

  it('ends cleanly when the turn is aborted with a request pending: no hang, nothing left pending, no permission.replied', async () => {
    const pi = await start({ sessionRules: SHELL_ASKS });
    await pi.prompt(directive(bashRuns('aborted.txt')));
    await waitFor(() => pi.asked().length === 1);

    const startedAt = Date.now();
    await pi.client.request('abort');
    await waitFor(() => pi.settled());
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(pi.settled().aborted).toBe(true);
    expect(fs.existsSync(marker('aborted.txt'))).toBe(false);
    await waitFor(() => pi.pending().length === 0, { message: 'the request stayed pending' });
    expect(bridge.eventTypes()).toEqual(['permission.asked']);
    expect((await bridge.api('GET', '/api/permission/request')).body.data).toEqual([]);
    expect(pi.toolEnd('bash').isError).toBe(true);

    // The same child takes the next prompt.
    pi.sessions[pi.sessionId].sessionRules = [];
    await pi.prompt(directive(bashRuns('after-abort.txt')));
    await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
    expect(fs.existsSync(marker('after-abort.txt'))).toBe(true);
  });

  it('gives each of several tool calls in one assistant message its own request', async () => {
    const pi = await start({ sessionRules: SHELL_ASKS });
    await pi.prompt(directive(bashRuns('p1.txt', 'echo one'), bashRuns('p2.txt', 'echo two'), bashRuns('p3.txt', 'echo three')));
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      const request = await waitFor(() => pi.pending().find((entry) => !seen.includes(entry.id)));
      seen.push(request.id);
      await pi.reply(request, { decision: 'once' });
    }
    await waitFor(() => pi.settled());
    const asked = pi.asked();
    expect(new Set(asked.map((request) => request.id)).size).toBe(3);
    expect(asked.map((request) => request.source.id).sort()).toEqual(['call_0', 'call_1', 'call_2']);
    expect(asked.map((request) => request.resources[0]).sort()).toEqual(['echo one > p1.txt', 'echo three > p3.txt', 'echo two > p2.txt']);
    for (const name of ['p1.txt', 'p2.txt', 'p3.txt']) expect(fs.existsSync(marker(name)), name).toBe(true);
    expect(bridge.eventTypes().filter((type) => type === 'permission.replied')).toHaveLength(3);
  });

  describe('when the bridge cannot answer', () => {
    const blockedWith = async (pi, expected) => {
      await pi.prompt(directive(bashRuns('closed.txt')));
      await waitFor(() => pi.settled());
      const end = pi.toolEnd('bash');
      expect(end.isError).toBe(true);
      expect(pi.text(end)).toContain(expected);
      expect(fs.existsSync(marker('closed.txt'))).toBe(false);
      expect(pi.settled().aborted).not.toBe(true);
    };
    const deadUrl = async () => {
      const port = await new Promise((resolve) => {
        const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
      });
      return `http://127.0.0.1:${port}`;
    };

    it('blocks the call when nothing listens at the bridge address', async () => {
      await blockedWith(await start({ env: { OPENCHAMBER_PI_BRIDGE_URL: await deadUrl() } }), 'could not reach its permission service');
    });

    it('blocks the call with a wrong token, and the bridge hears nothing', async () => {
      const pi = await start({ token: 'not-the-token' });
      await blockedWith(pi, 'answered 401');
      expect(bridge.events).toEqual([]);
    });

    it('blocks the call without a bridge address or a token', async () => {
      await blockedWith(await start({ env: { OPENCHAMBER_PI_BRIDGE_URL: '' } }), 'the bridge address or token is missing');
      await bridge.close();
      await blockedWith(await start({ env: { OPENCHAMBER_PI_BRIDGE_TOKEN: '' } }), 'the bridge address or token is missing');
    });

    it('blocks the call when the bridge does not know the session', async () => {
      const pi = await start();
      delete pi.sessions[pi.sessionId];
      await blockedWith(pi, 'answered 404');
    });

    it('blocks even a call the rules would allow', async () => {
      await blockedWith(await start({ agentRules: [{ action: '*', resource: '*', effect: 'allow' }], env: { OPENCHAMBER_PI_BRIDGE_URL: await deadUrl() } }), 'could not reach');
    });

    it('blocks the call when the bridge goes away while the request is held, and the turn can still be aborted', async () => {
      const pi = await start({ sessionRules: SHELL_ASKS });
      await pi.prompt(directive(bashRuns('closed.txt')));
      await waitFor(() => pi.asked().length === 1);
      await bridge.close();
      await waitFor(() => pi.settled(), { message: 'the turn never ended after the bridge went away' });
      expect(pi.toolEnd('bash').isError).toBe(true);
      expect(fs.existsSync(marker('closed.txt'))).toBe(false);
    });
  });

  describe('the question tool', () => {
    it('is declared with the OpenCode input schema, directly', async () => {
      const pi = await start();
      await pi.prompt('hello');
      await waitFor(() => pi.settled());
      const declared = mock.requests[0].toolNames;
      expect(declared).toContain('question');
    });

    it('shows a form, takes the answer and returns the text OpenCode returns', async () => {
      const pi = await start();
      await pi.prompt(directive(['question', { questions: QUESTIONS }]));
      const [form] = await waitFor(() => (bridge.forms.listPending().length === 1 ? bridge.forms.listPending() : null), { message: 'no form' });

      expect(bridge.events[0]).toMatchObject({ type: 'form.created', location: { directory: fixture.project } });
      expect(form).toEqual({
        id: expect.stringMatching(/^frm_/),
        sessionID: pi.sessionId,
        title: 'Questions',
        metadata: { kind: 'question', tool: { messageID: 'msg_for_call_0', id: 'call_0' } },
        fields: [
          { key: 'q0', title: 'Color', description: 'Which color?', type: 'string', options: [{ value: 'Red', label: 'Red', description: 'warm' }, { value: 'Blue', label: 'Blue', description: 'cool' }], custom: true },
          { key: 'q1', title: 'Sizes', description: 'Which sizes?', type: 'multiselect', options: [{ value: 'S', label: 'S', description: 'small' }, { value: 'L', label: 'L', description: 'large' }], custom: true },
        ],
      });
      expect(pi.toolEnds('question')).toEqual([]);

      const invalid = await bridge.api('POST', `/api/session/${pi.sessionId}/form/${form.id}/reply`, { answer: { q0: 12345 } });
      expect(invalid.status).toBe(400);
      expect(pi.toolEnds('question')).toEqual([]);

      expect((await bridge.api('POST', `/api/session/${pi.sessionId}/form/${form.id}/reply`, { answer: { q0: 'Purple', q1: ['S', 'L'] } })).status).toBe(204);
      await waitFor(() => pi.settled());
      const end = pi.toolEnd('question');
      expect(end.isError).toBe(false);
      expect(pi.text(end)).toBe('User has answered your questions: "Which color?"="Purple", "Which sizes?"="S, L". You can now continue with the user\'s answers in mind.');
      expect(end.result.details).toEqual({ answers: [['Purple'], ['S', 'L']], truncated: false });
      expect(bridge.eventTypes()).toEqual(['form.created', 'form.replied']);
      expect(bridge.events[1].data).toEqual({ id: form.id, sessionID: pi.sessionId, answer: { q0: 'Purple', q1: ['S', 'L'] } });
      expect(JSON.stringify(mock.requests.at(-1).messages.at(-1))).toContain('User has answered your questions');
      expect(pi.settled().aborted).not.toBe(true);
      expect((await bridge.api('POST', `/api/session/${pi.sessionId}/form/${form.id}/reply`, { answer: { q0: 'Blue' } })).status).toBe(409);
    });

    it('fails the tool with the dismissal text when the user cancels, and the turn goes on', async () => {
      const pi = await start();
      await pi.prompt(directive(['question', { questions: QUESTIONS.slice(0, 1) }]));
      const [form] = await waitFor(() => (bridge.forms.listPending().length === 1 ? bridge.forms.listPending() : null));
      expect((await bridge.api('DELETE', `/api/session/${pi.sessionId}/form/${form.id}`)).status).toBe(204);
      await waitFor(() => pi.settled());

      const end = pi.toolEnd('question');
      expect(end.isError).toBe(true);
      expect(pi.text(end)).toBe('The user dismissed this question');
      expect(end.result.details).toEqual({ dismissed: true });
      expect(bridge.eventTypes()).toEqual(['form.created', 'form.cancelled']);
      // Pi hands the model the failure and takes its next step: no interrupted turn, nothing stuck busy.
      expect(mock.requests.at(-1).messages.at(-1).role).toBe('tool');
      expect(pi.settled().aborted).not.toBe(true);
      expect((await pi.client.request('get_state')).isStreaming).toBe(false);
    });

    it('ends cleanly when the turn is aborted while the question is open, and removes the card', async () => {
      const pi = await start();
      await pi.prompt(directive(['question', { questions: QUESTIONS.slice(0, 1) }]));
      await waitFor(() => bridge.forms.listPending().length === 1);
      await pi.client.request('abort');
      await waitFor(() => pi.settled());
      expect(pi.settled().aborted).toBe(true);
      await waitFor(() => bridge.forms.listPending().length === 0);
      expect(bridge.eventTypes()).toEqual(['form.created', 'form.cancelled']);
    });

    it('fails with a reason, and does not stay open, when the bridge refuses the questions', async () => {
      const pi = await start();
      await pi.prompt(directive(['question', { questions: [{ question: 'Q?', header: 'Q', options: [{ label: '', description: 'no label' }] }] }]));
      await waitFor(() => pi.settled());
      const end = pi.toolEnd('question');
      expect(end.isError).toBe(true);
      expect(pi.text(end)).toBe('OpenChamber could not show this question (it answered 400).');
      expect(bridge.forms.listPending()).toEqual([]);
    });

    it('is blocked by the gate, like any tool, when the bridge cannot be reached', async () => {
      const pi = await start({ env: { OPENCHAMBER_PI_BRIDGE_TOKEN: '' } });
      await pi.prompt(directive(['question', { questions: QUESTIONS.slice(0, 1) }]));
      await waitFor(() => pi.settled());
      expect(pi.toolEnd('question').isError).toBe(true);
      expect(pi.text(pi.toolEnd('question'))).toContain('permission service');
    });
  });

  describe('for a script and a sibling extension of the same process', () => {
    const writeExtension = (source) => {
      const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-gate-ext-'));
      temporary.push(directory);
      const file = path.join(directory, 'extension.js');
      fs.writeFileSync(file, source);
      return file;
    };

    it('asks about each call a codemode script makes, under the call the chat shows', async () => {
      const activate = writeExtension('export default (pi) => { pi.on("session_start", () => { const active = pi.getActiveTools(); if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]); }); };');
      const pi = await start({ sessionRules: SHELL_ASKS, extensions: [activate] });
      const code = 'const result = await tools.bash({ command: "echo nested > nested.txt" });\nreturn "script finished";';
      await pi.prompt(directive(['codemode', { code }]));
      const request = await waitFor(() => pi.asked()[0], { message: 'the nested call was not asked about' });
      expect(request).toMatchObject({ action: 'shell', resources: ['echo nested > nested.txt'], source: { id: 'call_0' } });
      expect(fs.existsSync(marker('nested.txt'))).toBe(false);
      await pi.reply(request, { decision: 'reject', message: 'Not from a script.' });
      await waitFor(() => pi.settled());
      expect(fs.existsSync(marker('nested.txt'))).toBe(false);
      expect(pi.text(pi.toolEnd('codemode'))).toContain('Not from a script.');
    });

    it('serves the hook the managed tools ask, and lets a refusal end the call as a throw', async () => {
      const probe = writeExtension(`export default (pi) => {
  pi.registerTool({
    name: "gate_probe",
    label: "Probe",
    description: "Asks the permission hook the way secret.run does",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    exposure: "direct",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await globalThis.__openchamberPiPermission({
        sessionID: ctx.sessionManager.getSessionId(), toolCallId, tool: "gate_probe",
        action: "shell", resources: ["wrangler deploy"], save: ["wrangler *"], signal,
      });
      return { content: [{ type: "text", text: "passed the gate" }], details: {} };
    },
  });
};`);
      const pi = await start({ sessionRules: SHELL_ASKS, extensions: [probe] });
      await pi.prompt(directive(['gate_probe', {}]));
      const [first] = await waitFor(() => (pi.asked().length === 1 ? pi.asked() : null));
      expect(first).toMatchObject({ action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'], source: { id: 'call_0' } });
      await pi.reply(first, { decision: 'once' });
      await waitFor(() => pi.settled());
      expect(pi.text(pi.toolEnd('gate_probe'))).toBe('passed the gate');

      await pi.prompt(directive(['gate_probe', {}]));
      const second = await waitFor(() => (pi.asked().length === 2 ? pi.asked()[1] : null));
      await pi.reply(second, { decision: 'reject', message: 'No deploys today.' });
      await waitFor(() => pi.events.filter((event) => event.type === 'agent_settled').length === 2);
      const end = pi.toolEnds('gate_probe')[1];
      expect(end.isError).toBe(true);
      expect(pi.text(end)).toContain('No deploys today.');
    });
  });
});

describe('the gate extension as a module', () => {
  it('has no import but Node\'s own', () => {
    const imports = [...fs.readFileSync(GATE, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:http']);
  });

  it('registers a gate, the question and subagent tools, the instruction hook and the hook for the managed tools', async () => {
    const module = await import(GATE);
    const registered = { tools: [], commands: [], handlers: {} };
    delete globalThis.__openchamberPiPermission;
    module.default({ registerTool: (tool) => registered.tools.push(tool), registerCommand: (name, command) => { registered.commands.push([name, command]); }, on: (event, handler) => { registered.handlers[event] = handler; } });
    expect(registered.tools.map((tool) => [tool.name, tool.exposure])).toEqual([['question', 'direct'], ['subagent', 'direct']]);
    expect(registered.commands.map(([name]) => name)).toEqual(['openchamber-context']);
    expect(Object.keys(registered.handlers)).toEqual(['session_start', 'tool_call', 'before_agent_start']);
    expect(globalThis.__openchamberPiPermission).toBeTypeOf('function');
    delete globalThis.__openchamberPiPermission;
  });

  it('resets restored built-ins to the configured defaults without dropping active extensions', async () => {
    const module = await import(GATE);
    const handlers = {};
    let active = ['read', 'bash', 'question', 'codemode'];
    module.default({
      registerTool: () => {}, registerCommand: () => {},
      on: (event, handler) => { handlers[event] = handler; },
      getActiveTools: () => active,
      getAllTools: () => ['read', 'bash', 'edit', 'write', 'grep', 'question', 'codemode', 'mcp__docs__get'].map((name) => ({ name })),
      setActiveTools: (names) => { active = names; },
    });
    const previous = process.env.OPENCHAMBER_PI_DEFAULT_TOOLS;
    try {
      process.env.OPENCHAMBER_PI_DEFAULT_TOOLS = JSON.stringify(['read', 'edit', 'mcp__docs__*']);
      handlers.session_start();
      expect(active).toEqual(['question', 'codemode', 'read', 'edit', 'mcp__docs__get']);
      process.env.OPENCHAMBER_PI_DEFAULT_TOOLS = '[]';
      handlers.session_start();
      expect(active).toEqual(['question', 'codemode', 'mcp__docs__get']);
      process.env.OPENCHAMBER_PI_DEFAULT_TOOLS = '{}';
      expect(() => handlers.session_start()).toThrow('Invalid OpenChamber default tool selection');
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_PI_DEFAULT_TOOLS;
      else process.env.OPENCHAMBER_PI_DEFAULT_TOOLS = previous;
      delete globalThis.__openchamberPiPermission;
    }
  });

  it('blocks when the call cannot name its session', async () => {
    const module = await import(GATE);
    const handlers = {};
    module.default({ registerTool: () => {}, registerCommand: () => {}, on: (event, handler) => { handlers[event] = handler; } });
    delete globalThis.__openchamberPiPermission;
    const result = await handlers.tool_call({ toolCallId: 'c', toolName: 'bash', input: {} }, { sessionManager: {} });
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining('which session') });
  });
});
