// Records real Pi event streams and session files into `*.json` fixtures that
// the wire tests replay. Run it by hand when Pi changes:
//
//   cd packages/web && node server/lib/pi/wire/fixtures/record.mjs [scenario...]
//
// Each scenario starts an isolated Pi (own agent dir, own HOME) against a mock
// OpenAI-compatible server, drives it over RPC, waits for `agent_settled` and
// stores every stdout event plus every entry of the session file. Nothing here
// reads the developer's real ~/.pi. The tests never start Pi: they read the
// JSON this script wrote.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../../launch.js';
import { createPiRpcClient } from '../../rpc-client.js';
import { readSessionEntries } from '../../session-files.js';
import { createPiFixture } from '../../test-support/pi-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The mock model. The last user message picks the behavior:
//   STEPS:[[{"name":"read","args":{...}}, ...], [...]]   one assistant step per
//        inner array (parallel tool calls), then a final text step
//   PLAIN / REASON / SLOW / SUMMARY / FLAKY / HTTP500 / HTTP429 / HTTP400 / RESET
//   anything else: reasoning, text, then a `bash echo hi` call, then a final text
// ---------------------------------------------------------------------------

const startMock = async () => {
  const attempts = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-2' }] }));
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* not JSON */ }
      const messages = payload.messages ?? [];
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
      const lastUser = messages[lastUserIndex]?.content ?? '';
      const userText = typeof lastUser === 'string' ? lastUser : lastUser.map((part) => part?.text ?? '').join('\n');
      const round = messages.slice(lastUserIndex + 1).filter((message) => message.role === 'assistant').length;
      const count = (attempts.get(userText) ?? 0) + 1;
      attempts.set(userText, count);

      const fail = (status, message, type, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify({ error: { message, type } }));
      };
      if (userText.includes('HTTP500')) return fail(500, 'mock upstream exploded', 'server_error');
      if (userText.includes('HTTP429')) return fail(429, 'mock rate limit', 'rate_limit_error', { 'retry-after': '1' });
      if (userText.includes('HTTP400')) return fail(400, 'mock bad request', 'invalid_request_error');
      if (userText.includes('FLAKY') && count === 1) return fail(500, 'mock flaky failure', 'server_error');
      if (userText.includes('RESET')) { res.destroy(); return; }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const base = { id: 'mock-1', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
      const choice = (delta, finish = null) => send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
      const usage = (prompt, completion, extra = {}) => send({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra } });
      const done = () => res.end('data: [DONE]\n\n');
      const finalText = (text, cached = 0) => {
        choice({ role: 'assistant', content: `${text.slice(0, 6)}` });
        choice({ content: text.slice(6) });
        choice({}, 'stop');
        usage(200, 12, cached ? { prompt_tokens_details: { cached_tokens: cached } } : {});
        done();
      };

      if (!payload.tools || payload.tools.length === 0 || userText.includes('SUMMARY')) {
        choice({ role: 'assistant', content: '## Goal\nMock summary' });
        choice({}, 'stop');
        usage(50, 5);
        return done();
      }
      const stepsMatch = /STEPS:(\[.*\])/s.exec(userText);
      if (stepsMatch) {
        const steps = JSON.parse(stepsMatch[1]);
        if (round >= steps.length) return finalText('All steps done', 100);
        choice({ role: 'assistant', content: `Step ${round + 1}. ` });
        steps[round].forEach((call, index) => {
          choice({ tool_calls: [{ index, id: `call_${round}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] });
          const text = JSON.stringify(call.args);
          choice({ tool_calls: [{ index, function: { arguments: text.slice(0, 8) } }] });
          choice({ tool_calls: [{ index, function: { arguments: text.slice(8) } }] });
        });
        choice({}, 'tool_calls');
        usage(100 + round * 10, 20);
        return done();
      }
      if (userText.includes('SLOW')) {
        choice({ role: 'assistant', content: 'slow ' });
        for (let i = 0; i < 200 && !res.destroyed; i += 1) {
          await sleep(50);
          choice({ content: 'tick ' });
        }
        return done();
      }
      if (userText.includes('PLAIN') || userText.includes('FLAKY')) {
        choice({ role: 'assistant', content: 'plain ' });
        choice({ content: 'answer' });
        choice({}, 'stop');
        usage(80, 6);
        return done();
      }
      if (userText.includes('REASON')) {
        choice({ role: 'assistant', reasoning_content: 'Let me think. ' });
        choice({ reasoning_content: 'The answer is simple.' });
        choice({ content: 'Here is ' });
        choice({ content: 'the answer.' });
        choice({}, 'stop');
        usage(90, 14, { completion_tokens_details: { reasoning_tokens: 6 } });
        return done();
      }
      if (round >= 1) return finalText('Done: tool said hi', 100);
      choice({ role: 'assistant', reasoning_content: 'Let me think. ' });
      choice({ reasoning_content: 'Use the tool.' });
      choice({ content: 'Running it. ' });
      choice({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":' } }] });
      choice({ tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] });
      choice({}, 'tool_calls');
      usage(100, 20, { completion_tokens_details: { reasoning_tokens: 8 } });
      done();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
};

// ---------------------------------------------------------------------------
// Driving Pi
// ---------------------------------------------------------------------------

const startPi = ({ fixture, sessionId, events }) => {
  const runtime = resolvePiRuntime();
  return createPiRpcClient({
    command: runtime.command,
    args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId, sessionDir: fixture.sessionsDir })],
    cwd: fixture.project,
    env: { ...fixture.env, ...runtime.env },
    onEvent: (event) => events.push(event),
  });
};

const waitFor = async (events, predicate, { from = 0, timeoutMs = 20_000 } = {}) => {
  const startedAt = Date.now();
  for (;;) {
    const index = events.findIndex((event, at) => at >= from && predicate(event));
    if (index !== -1) return index;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`event not seen: ${events.slice(from).map((event) => event.type).join(',')}`);
    await sleep(15);
  }
};
const settled = (events, from = 0) => waitFor(events, (event) => event.type === 'agent_settled', { from });

// System messages hold the whole prompt and tool declarations; no wire output
// depends on them, so the fixtures keep a stub.
const trimSystem = (value) => {
  if (Array.isArray(value)) return value.map(trimSystem);
  if (value && typeof value === 'object') {
    if (value.role === 'system') return { role: 'system', content: '', sections: { preamble: 'trimmed' }, ...(value.timestamp ? { timestamp: value.timestamp } : {}) };
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimSystem(entry)]));
  }
  return value;
};

const SCENARIOS = {
  plain: {
    description: 'A plain text answer.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'PLAIN please' });
      await settled(events);
    },
  },
  reasoning: {
    description: 'Reasoning, then a text answer.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'REASON please' });
      await settled(events);
    },
  },
  'reasoning-bash': {
    description: 'Reasoning, text, a bash call and a final answer (the mock default).',
    async run({ client, events }) {
      await client.request('prompt', { message: 'hello go' });
      await settled(events);
    },
  },
  'tool-steps': {
    description: 'Four tool steps: parallel read + bash, a failing read + ls, edit + write + a failing bash, then grep + find + an unknown tool; then the final text.',
    settings: { defaultTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    async run({ client, events, fixture }) {
      fs.writeFileSync(path.join(fixture.project, 'notes.txt'), 'line one\nline two\n');
      const steps = [
        [{ name: 'read', args: { path: 'notes.txt' } }, { name: 'bash', args: { command: 'echo one' } }],
        [{ name: 'read', args: { path: 'missing.txt' } }, { name: 'ls', args: { path: '.' } }],
        [
          { name: 'edit', args: { path: 'notes.txt', edits: [{ oldText: 'line one', newText: 'line ONE' }, { oldText: 'line two', newText: 'line TWO' }] } },
          { name: 'write', args: { path: 'out.txt', content: 'hello\nworld\n' } },
          { name: 'bash', args: { command: 'echo out; echo err 1>&2; exit 3' } },
        ],
        [{ name: 'grep', args: { pattern: 'LINE', ignoreCase: true } }, { name: 'find', args: { pattern: '*.txt' } }, { name: 'nope_tool', args: { x: 1 } }],
      ];
      await client.request('prompt', { message: `STEPS:${JSON.stringify(steps)}` });
      await settled(events);
    },
  },
  abort: {
    description: 'A user abort while the model streams.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'SLOW go' });
      const at = await waitFor(events, (event) => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta');
      await sleep(250);
      await client.request('abort');
      await settled(events, at);
    },
  },
  'error-retry': {
    description: 'The provider drops the connection on every attempt (one retry configured).',
    async run({ client, events }) {
      await client.request('prompt', { message: 'RESET please' });
      await settled(events);
    },
  },
  'error-flaky': {
    description: 'The provider answers HTTP 500 once, the retry succeeds.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'FLAKY please' });
      await settled(events);
    },
  },
  'error-http500': {
    description: 'HTTP 500 on every attempt.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'HTTP500 please' });
      await settled(events);
    },
  },
  'error-http429': {
    description: 'HTTP 429 with retry-after on every attempt.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'HTTP429 please' });
      await settled(events);
    },
  },
  'error-http400': {
    description: 'HTTP 400 on every attempt.',
    async run({ client, events }) {
      await client.request('prompt', { message: 'HTTP400 please' });
      await settled(events);
    },
  },
  steer: {
    description: 'A steer prompt while the first turn runs a tool.',
    async run({ client, events }) {
      const steps = [[{ name: 'bash', args: { command: 'sleep 1; echo slept' } }]];
      await client.request('prompt', { message: `STEPS:${JSON.stringify(steps)}` });
      const at = await waitFor(events, (event) => event.type === 'tool_execution_start');
      await client.request('prompt', { message: 'PLAIN steer message', streamingBehavior: 'steer' });
      await settled(events, at);
    },
  },
  compaction: {
    description: 'Two turns, then a manual compaction, then one more turn.',
    settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 5 } },
    async run({ client, events }) {
      await client.request('prompt', { message: 'PLAIN first' });
      await settled(events);
      const mark = events.length;
      await client.request('prompt', { message: 'hello go' });
      await settled(events, mark);
      const compactAt = events.length;
      await client.request('compact', {});
      await waitFor(events, (event) => event.type === 'compaction_end', { from: compactAt });
      const afterAt = events.length;
      await client.request('prompt', { message: 'PLAIN after compaction' });
      await settled(events, afterAt);
    },
  },
  'tool-truncated': {
    description: 'Output that Pi truncates (bash, read) and a bash timeout.',
    settings: { defaultTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    async run({ client, events, fixture }) {
      fs.writeFileSync(path.join(fixture.project, 'big.txt'), `${Array.from({ length: 2100 }, () => 'r').join('\n')}\n`);
      const steps = [
        [{ name: 'bash', args: { command: 'yes r | head -n 2100' } }, { name: 'read', args: { path: 'big.txt' } }],
        [{ name: 'bash', args: { command: 'sleep 5', timeout: 1 } }],
      ];
      await client.request('prompt', { message: `STEPS:${JSON.stringify(steps)}` });
      await settled(events);
    },
  },
  'tool-abort': {
    description: 'A user abort while a bash command runs.',
    async run({ client, events }) {
      const steps = [[{ name: 'bash', args: { command: 'sleep 30' } }]];
      await client.request('prompt', { message: `STEPS:${JSON.stringify(steps)}` });
      const at = await waitFor(events, (event) => event.type === 'tool_execution_start');
      await sleep(300);
      await client.request('abort');
      await settled(events, at);
    },
  },
  'user-bash-and-switches': {
    description: 'A thinking level change, a model change, a user bash command, an image prompt and a normal answer.',
    prepare(fixture) {
      const models = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, 'models.json'), 'utf8'));
      models.providers.mock.models.push({ id: 'mock-model-2', name: 'Mock Model 2', reasoning: true, input: ['text', 'image'], contextWindow: 32000, maxTokens: 4096 });
      fs.writeFileSync(path.join(fixture.agentDir, 'models.json'), JSON.stringify(models));
    },
    async run({ client, events }) {
      await client.request('set_thinking_level', { level: 'high' });
      await client.request('set_model', { provider: 'mock', modelId: 'mock-model-2' });
      await client.request('bash', { command: 'echo from-user-shell; exit 2' });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await client.request('prompt', { message: 'PLAIN with an image', images: [{ type: 'image', data: png, mimeType: 'image/png' }] });
      await settled(events);
    },
  },
};

const runScenario = async (name, scenario, mock) => {
  const fixture = createPiFixture({ mockPort: mock.port, extraSettings: scenario.settings });
  scenario.prepare?.(fixture);
  const events = [];
  const sessionId = `ses_fixture_${name.replaceAll('-', '_')}`;
  const client = startPi({ fixture, sessionId, events });
  try {
    const state = await client.request('get_state');
    await scenario.run({ client, events, fixture });
    await sleep(300);
    const entries = await readSessionEntries(state.sessionFile);
    const header = JSON.parse(fs.readFileSync(state.sessionFile, 'utf8').split('\n')[0]);
    const text = JSON.stringify(trimSystem({
      name,
      description: scenario.description,
      cwd: fixture.project,
      header,
      events,
      entries,
    }));
    const sanitized = text
      .replaceAll(fixture.root, '/work')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:0');
    const target = path.join(here, `${name}.json`);
    fs.writeFileSync(target, `${JSON.stringify(JSON.parse(sanitized), null, 1)}\n`);
    console.log(`${name}: ${events.length} events, ${entries.length} entries -> ${path.relative(process.cwd(), target)}`);
  } finally {
    await client.close();
    fixture.dispose();
  }
};

const wanted = process.argv.slice(2);
const mock = await startMock();
try {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    await runScenario(name, scenario, mock);
  }
} finally {
  await mock.close();
}
