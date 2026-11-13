import { afterEach, describe, expect, it } from 'vitest';
import { createPiRpcClient, PiRpcError } from './rpc-client.js';

// Node stands in for `pi --mode rpc`: it answers commands by id, emits events,
// and ends on stdin EOF the way Pi does.
const FAKE_PI = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    const cmd = JSON.parse(line);
    if (cmd.type === 'ping') {
      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
      process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'ping', success: true, data: { pong: cmd.value, text: 'a\\u2028b' } }) + '\\n');
    } else if (cmd.type === 'fail') {
      process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'fail', success: false, error: 'nope' }) + '\\n');
    } else if (cmd.type === 'ask') {
      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: 't' }) + '\\n');
    } else if (cmd.type === 'extension_ui_response') {
      process.stdout.write(JSON.stringify({ type: 'agent_end', answered: cmd.confirmed }) + '\\n');
    } else if (cmd.type === 'die') {
      process.exit(3);
    } else if (cmd.type === 'split') {
      const out = JSON.stringify({ id: cmd.id, type: 'response', command: 'split', success: true, data: 'ok' }) + '\\n';
      process.stdout.write(out.slice(0, 10));
      setTimeout(() => process.stdout.write(out.slice(10)), 20);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => {});
`;

const HUNG_PI = `process.stdin.on('data', () => {}); process.stdin.on('end', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;

const clients = [];
const start = (script, handlers = {}) => {
  const client = createPiRpcClient({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    ...handlers,
  });
  clients.push(client);
  return client;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => {
    client.kill('SIGKILL');
    return client.exited;
  }));
});

describe('createPiRpcClient', () => {
  it('resolves a request with the response data and routes other records to onEvent', async () => {
    const events = [];
    const client = start(FAKE_PI, { onEvent: (event) => events.push(event) });

    const data = await client.request('ping', { value: 7 });

    expect(data.pong).toBe(7);
    expect(events).toEqual([{ type: 'agent_start' }]);
  });

  it('keeps U+2028 inside a JSON string instead of splitting the line', async () => {
    const client = start(FAKE_PI);
    const data = await client.request('ping', { value: 1 });
    expect(data.text).toBe('a b');
  });

  it('reassembles a response that arrives in two chunks', async () => {
    const client = start(FAKE_PI);
    await expect(client.request('split')).resolves.toBe('ok');
  });

  it('rejects with the command and Pi\'s message when Pi reports failure', async () => {
    const client = start(FAKE_PI);
    const error = await client.request('fail').catch((e) => e);
    expect(error).toBeInstanceOf(PiRpcError);
    expect(error).toMatchObject({ command: 'fail', code: 'command_failed', message: 'nope' });
  });

  it('delivers extension_ui_request to onUiRequest and sends the reply back', async () => {
    const requests = [];
    const events = [];
    const client = start(FAKE_PI, {
      onUiRequest: (request) => requests.push(request),
      onEvent: (event) => events.push(event),
    });

    client.request('ask').catch(() => {});
    await waitFor(() => requests.length === 1);
    await client.respondUi('ui1', { confirmed: true });
    await waitFor(() => events.some((event) => event.type === 'agent_end'));

    expect(requests[0]).toMatchObject({ id: 'ui1', method: 'confirm' });
    expect(events.find((event) => event.type === 'agent_end').answered).toBe(true);
  });

  it('rejects pending requests when the process dies', async () => {
    const client = start(FAKE_PI);
    const pendingRequest = client.request('die');
    await expect(pendingRequest).rejects.toMatchObject({ code: 'process_exited' });
    await expect(client.request('ping')).rejects.toMatchObject({ code: 'process_exited' });
  });

  it('times out a request Pi never answers', async () => {
    const client = start(FAKE_PI);
    await expect(client.request('ask', {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout', command: 'ask' });
  });

  it('closes by ending stdin when Pi honors EOF', async () => {
    const client = start(FAKE_PI);
    await client.request('ping', { value: 1 });
    const info = await client.close({ graceMs: 2000 });
    expect(info).toEqual({ code: 0, signal: null });
  });

  it('escalates to SIGKILL when Pi ignores EOF and SIGTERM', async () => {
    const client = start(HUNG_PI);
    const info = await client.close({ graceMs: 50 });
    expect(info.signal).toBe('SIGKILL');
  });

  it('reports a spawn failure as a rejected request, not a crash', async () => {
    const client = createPiRpcClient({ command: '/nonexistent/pi-binary', args: [], cwd: process.cwd(), env: {} });
    clients.push(client);
    await expect(client.request('get_state')).rejects.toBeInstanceOf(PiRpcError);
  });
});

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
