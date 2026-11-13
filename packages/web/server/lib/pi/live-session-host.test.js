import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createLiveSessionHost, createPiClientFactory } from './live-session-host.js';
import { startMockOpenAi } from './test-support/mock-openai.js';
import { createPiFixture } from './test-support/pi-fixture.js';

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

describe('live session host with a real Pi', () => {
  let mock;
  let fixture;
  let host;

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  afterEach(async () => {
    await host?.shutdown();
  });

  const makeHost = (options = {}) => {
    host = createLiveSessionHost({
      createClient: createPiClientFactory({ getBaseEnv: () => fixture.env }),
      ...options,
    });
    return host;
  };
  const sessionOf = (id) => ({ id, cwd: fixture.project });

  it('starts a process on first use, streams a turn and goes idle', async () => {
    makeHost();
    const events = [];
    const statuses = [];
    host.on('event', ({ event }) => events.push(event));
    host.on('status', ({ busy }) => statuses.push(busy));

    const result = await host.prompt(sessionOf('ses_host_turn'), { message: 'PLAIN go' });
    expect(result.disposition).toBe('started');
    await waitFor(() => events.some((event) => event.type === 'agent_settled'));

    expect(statuses).toEqual([true, false]);
    expect(host.get('ses_host_turn')).toMatchObject({ busy: false, cwd: fixture.project, state: { model: { id: 'mock-model' } } });
  });

  it('aborts a running turn', async () => {
    makeHost();
    const events = [];
    host.on('event', ({ event }) => events.push(event));

    await host.prompt(sessionOf('ses_host_abort'), { message: 'SLOW go' });
    await waitFor(() => events.some((event) => event.type === 'message_update'));
    expect(await host.abort('ses_host_abort')).toBe(true);

    await waitFor(() => events.some((event) => event.type === 'agent_settled'));
    expect(events.find((event) => event.type === 'agent_settled').aborted).toBe(true);
    expect(host.get('ses_host_abort').busy).toBe(false);
  });

  it('answers open dialogs before abort so abort cannot hang on them', async () => {
    makeHost({
      createClient: createPiClientFactory({
        getBaseEnv: () => fixture.env,
        getLaunch: () => ({ extensions: [new URL('./test-support/dialog-extension.js', import.meta.url).pathname] }),
      }),
    });
    const sessionId = 'ses_host_dialog';
    const uiRequests = [];
    const settled = [];
    const events = [];
    host.on('ui-request', ({ request }) => uiRequests.push(request));
    host.on('ui-settled', ({ id }) => settled.push(id));
    host.on('event', ({ event }) => events.push(event));

    await host.prompt(sessionOf(sessionId), { message: 'PWD go' });
    await waitFor(() => uiRequests.length === 1);
    expect(uiRequests[0]).toMatchObject({ method: 'confirm', title: 'Allow bash?' });
    expect(host.get(sessionId).pendingUi).toHaveLength(1);

    const startedAt = Date.now();
    await host.abort(sessionId);
    await waitFor(() => events.some((event) => event.type === 'agent_settled'));

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(settled).toEqual([uiRequests[0].id]);
    expect(host.get(sessionId).pendingUi).toEqual([]);
  });

  it('delivers a reply to an open dialog and lets the tool run', async () => {
    makeHost({
      createClient: createPiClientFactory({
        getBaseEnv: () => fixture.env,
        getLaunch: () => ({ extensions: [new URL('./test-support/dialog-extension.js', import.meta.url).pathname] }),
      }),
    });
    const sessionId = 'ses_host_reply';
    const uiRequests = [];
    const events = [];
    host.on('ui-request', ({ request }) => uiRequests.push(request));
    host.on('event', ({ event }) => events.push(event));

    await host.prompt(sessionOf(sessionId), { message: 'PWD go' });
    await waitFor(() => uiRequests.length === 1);
    expect(await host.respondUi(sessionId, uiRequests[0].id, { confirmed: true })).toBe(true);
    await waitFor(() => events.some((event) => event.type === 'agent_settled'));

    const toolEnd = events.find((event) => event.type === 'tool_execution_end');
    expect(toolEnd.isError).toBe(false);
    expect(await host.respondUi(sessionId, uiRequests[0].id, { confirmed: true })).toBe(false);
  });

  it('keeps a process for a recently used session and reaps it after the idle time', async () => {
    let clock = 1_000_000;
    makeHost({ idleMs: 60_000, now: () => clock, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
    const exits = [];
    host.on('exit', (info) => exits.push(info));

    await host.ensure(sessionOf('ses_host_idle'));
    clock += 30_000;
    await host.reapIdle();
    expect(host.get('ses_host_idle')).not.toBeNull();

    clock += 31_000;
    await host.reapIdle();
    await waitFor(() => exits.length === 1);
    expect(host.get('ses_host_idle')).toBeNull();
    expect(exits[0]).toMatchObject({ sessionId: 'ses_host_idle', wasBusy: false, expected: true });
  });

  it('never reaps a session that is running a turn', async () => {
    let clock = 1_000_000;
    makeHost({ idleMs: 1000, now: () => clock, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
    const events = [];
    host.on('event', ({ event }) => events.push(event));

    await host.prompt(sessionOf('ses_host_busy'), { message: 'SLOW busy' });
    await waitFor(() => events.some((event) => event.type === 'message_update'));
    clock += 3_600_000;
    await host.reapIdle();

    expect(host.get('ses_host_busy')).not.toBeNull();
    await host.abort('ses_host_busy');
  });

  it('reports the end of a process that died mid-turn', async () => {
    makeHost();
    const exits = [];
    host.on('exit', (info) => exits.push(info));
    const events = [];
    host.on('event', ({ event }) => events.push(event));

    await host.prompt(sessionOf('ses_host_crash'), { message: 'SLOW crash' });
    await waitFor(() => events.some((event) => event.type === 'message_update'));
    process.kill(host.get('ses_host_crash').pid, 'SIGKILL');

    await waitFor(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ sessionId: 'ses_host_crash', wasBusy: true, expected: false });
    expect(host.get('ses_host_crash')).toBeNull();
  });

  it('shares one process between concurrent callers for the same session', async () => {
    makeHost();
    const [a, b] = await Promise.all([host.ensure(sessionOf('ses_host_shared')), host.ensure(sessionOf('ses_host_shared'))]);
    expect(a).toBe(b);
    expect(host.list()).toHaveLength(1);
  });
});

// A fake client lets the pool rules be checked without starting processes.
const fakeClient = ({ onClose } = {}) => {
  const emitter = new EventEmitter();
  let exitHandler = () => {};
  return {
    pid: 1,
    request: async (type) => (type === 'get_state' ? { model: null } : {}),
    respondUi: async () => {},
    kill: () => exitHandler({ code: null, signal: 'SIGKILL' }),
    close: async () => { onClose?.(); exitHandler({ code: 0, signal: null }); },
    setExitHandler: (handler) => { exitHandler = handler; },
    emitter,
  };
};

describe('live session host pool', () => {
  it('evicts the least recently used idle session over capacity and spares busy ones', async () => {
    let clock = 0;
    const closed = [];
    const host = createLiveSessionHost({
      maxLive: 2,
      idleMs: 0,
      now: () => clock,
      createClient: ({ session, handlers }) => {
        const client = fakeClient({ onClose: () => closed.push(session.id) });
        client.setExitHandler(handlers.onExit);
        return client;
      },
    });
    const session = (id) => ({ id, cwd: '/p' });

    await host.ensure(session('a')); clock += 1;
    await host.ensure(session('b')); clock += 1;
    await host.ensure(session('c'));
    await waitFor(() => closed.length === 1);

    expect(closed).toEqual(['a']);
    expect(host.list().map((entry) => entry.sessionId).sort()).toEqual(['b', 'c']);
    await host.shutdown();
  });

  it('refuses new work after shutdown', async () => {
    const host = createLiveSessionHost({ createClient: ({ handlers }) => { const c = fakeClient(); c.setExitHandler(handlers.onExit); return c; } });
    await host.shutdown();
    await expect(host.ensure({ id: 'x', cwd: '/p' })).rejects.toMatchObject({ code: 'shutting_down' });
  });
});
