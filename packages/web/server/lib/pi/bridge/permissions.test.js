import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermissionManager, createSavedPermissionStore, DEFAULT_REJECT_MESSAGE } from './permissions.js';

const temporary = [];
const makeDir = () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-permissions-'));
  temporary.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const DIRECTORY = '/work/project';
const SHELL_ASKS = [{ action: 'shell', resource: '*', effect: 'ask' }];

const setup = ({ contexts, sources = () => ({ messageID: 'msg_1' }), storeOptions = {}, sourceWaitMs } = {}) => {
  const emitted = [];
  const hub = { emit: (event) => { emitted.push(event); return event; } };
  const store = createSavedPermissionStore({ filePath: path.join(makeDir(), 'saved.json'), ...storeOptions });
  const state = { ses_a: { directory: DIRECTORY, agentRules: [], sessionRules: SHELL_ASKS }, ...contexts };
  const permissions = createPermissionManager({
    hub,
    getContext: (sessionID) => state[sessionID] ?? null,
    resolveSource: (sessionID, toolCallId) => sources(sessionID, toolCallId),
    store,
    resolveProjectID: (directory) => `project:${directory}`,
    ...(sourceWaitMs === undefined ? {} : { sourceWaitMs }),
  });
  return { permissions, store, emitted, state };
};

const bash = (command, extra = {}) => ({ sessionID: 'ses_a', toolCallId: 'call_1', tool: 'bash', input: { command }, ...extra });
const types = (emitted) => emitted.map((event) => event.type);
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('asking', () => {
  it('answers from the rules without a card when they allow', async () => {
    const { permissions, emitted } = setup({ contexts: { ses_a: { directory: DIRECTORY, agentRules: [{ action: '*', resource: '*', effect: 'allow' }], sessionRules: [] } } });
    expect(await permissions.request(bash('echo hi'))).toEqual({ allowed: true });
    expect(emitted).toEqual([]);
  });

  it('refuses a denied call at once, with a message the model can read, and remembers why', async () => {
    const { permissions, emitted } = setup({ contexts: { ses_a: { directory: DIRECTORY, agentRules: [], sessionRules: [{ action: 'shell', resource: 'rm *', effect: 'deny' }] } } });
    const result = await permissions.request(bash('rm -rf x', { toolCallId: 'call_9' }));
    expect(result).toEqual({ allowed: false, message: expect.stringContaining('prevents you from using this specific tool call (shell: rm -rf x)') });
    expect(emitted).toEqual([]);
    expect(permissions.takeBlocked('ses_a', 'call_9')).toEqual({ kind: 'denied', message: result.message });
    expect(permissions.takeBlocked('ses_a', 'call_9')).toBeUndefined();
  });

  it('emits permission.asked with the fields OpenCode sends and waits', async () => {
    const { permissions, emitted } = setup();
    let settled = false;
    const answer = permissions.request(bash('echo hi')).then((result) => { settled = true; return result; });
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'permission.asked',
      location: { directory: DIRECTORY },
      data: {
        id: expect.stringMatching(/^per_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
        sessionID: 'ses_a',
        action: 'shell',
        resources: ['echo hi'],
        save: ['echo *'],
        source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
      },
    });
    expect(settled).toBe(false);
    expect(permissions.listPending()).toEqual([emitted[0].data]);
    expect(permissions.get('ses_a', emitted[0].data.id)).toEqual(emitted[0].data);
    expect(permissions.get('ses_other', emitted[0].data.id)).toBeNull();

    await permissions.reply('ses_a', emitted[0].data.id, { decision: 'once' });
    expect(await answer).toEqual({ allowed: true });
  });

  it('puts a nested call under the call the chat shows, and waits for a source the translator has to find first', async () => {
    const lookups = [];
    const { permissions, emitted } = setup({ sources: async (sessionID, toolCallId) => { lookups.push(toolCallId); await flush(); return { messageID: 'msg_parent' }; } });
    void permissions.request(bash('echo hi', { toolCallId: 'call_parent/1', parentToolCallId: 'call_parent' }));
    expect(emitted).toEqual([]);
    await flush();
    await flush();
    expect(lookups).toEqual(['call_parent']);
    expect(emitted[0].data.source).toEqual({ type: 'tool', messageID: 'msg_parent', id: 'call_parent' });
  });

  it('goes out without a source when the lookup fails or takes longer than it may', async () => {
    const failing = setup({ sources: () => { throw new Error('translator is down'); } });
    void failing.permissions.request(bash('echo hi'));
    await flush();
    expect(failing.emitted[0].data).not.toHaveProperty('source');

    const hanging = setup({ sources: () => new Promise(() => {}), sourceWaitMs: 30 });
    void hanging.permissions.request(bash('echo hi'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hanging.emitted).toHaveLength(1);
    expect(hanging.emitted[0].data).not.toHaveProperty('source');
  });

  it('goes out without a source when none is known', async () => {
    const { permissions, emitted } = setup({ sources: () => undefined });
    void permissions.request(bash('echo hi'));
    await flush();
    expect(emitted[0].data).not.toHaveProperty('source');
  });

  it('asks for a file tool on the absolute path and offers that path to save', async () => {
    const { permissions, emitted } = setup({ contexts: { ses_a: { directory: DIRECTORY, agentRules: [{ action: 'read', resource: '*.env', effect: 'ask' }], sessionRules: [] } } });
    void permissions.request({ sessionID: 'ses_a', toolCallId: 'call_1', tool: 'read', input: { path: '.env' } });
    await flush();
    expect(emitted[0].data).toMatchObject({ action: 'read', resources: [`${DIRECTORY}/.env`], save: [`${DIRECTORY}/.env`] });
  });

  it('asks about what the caller names when it names the action itself', async () => {
    const { permissions, emitted } = setup();
    void permissions.request({ sessionID: 'ses_a', toolCallId: 'call_1', tool: 'openchamber_secret', input: {}, action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'] });
    await flush();
    expect(emitted[0].data).toMatchObject({ action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'] });
  });

  it('fails for a session it does not know', async () => {
    const { permissions } = setup();
    await expect(permissions.request(bash('ls', { sessionID: 'ses_missing' }))).rejects.toMatchObject({ status: 404, tag: 'SessionNotFoundError' });
  });

  it('reads the rules again on every call', async () => {
    const { permissions, emitted, state } = setup();
    void permissions.request(bash('ls'));
    await flush();
    expect(emitted).toHaveLength(1);
    state.ses_a.sessionRules = [];
    state.ses_a.agentRules = [{ action: '*', resource: '*', effect: 'allow' }];
    expect(await permissions.request(bash('ls'))).toEqual({ allowed: true });
  });
});

describe('replying', () => {
  const ask = async (setupResult, command = 'echo hi', extra = {}) => {
    const answer = setupResult.permissions.request(bash(command, extra));
    await flush();
    return { answer, request: setupResult.emitted.find((event) => event.type === 'permission.asked' && event.data.resources[0] === command).data };
  };

  it('allows once, emits permission.replied after the card and asks again next time', async () => {
    const context = setup();
    const { answer, request } = await ask(context);
    await context.permissions.reply('ses_a', request.id, { decision: 'once' });
    expect(await answer).toEqual({ allowed: true });
    expect(types(context.emitted)).toEqual(['permission.asked', 'permission.replied']);
    expect(context.emitted[1]).toEqual({ type: 'permission.replied', location: { directory: DIRECTORY }, data: { sessionID: 'ses_a', requestID: request.id, reply: 'once' } });
    expect(context.permissions.listPending()).toEqual([]);

    void context.permissions.request(bash('echo hi', { toolCallId: 'call_2' }));
    await flush();
    expect(types(context.emitted)).toEqual(['permission.asked', 'permission.replied', 'permission.asked']);
  });

  it('answers a second reply with PermissionNotFoundError', async () => {
    const context = setup();
    const { request } = await ask(context);
    await context.permissions.reply('ses_a', request.id, { decision: 'once' });
    await expect(context.permissions.reply('ses_a', request.id, { decision: 'once' })).rejects.toMatchObject({ status: 404, tag: 'PermissionNotFoundError', extra: { requestID: request.id } });
    await expect(context.permissions.reply('ses_b', 'per_unknown', { decision: 'once' })).rejects.toMatchObject({ tag: 'PermissionNotFoundError' });
    expect(types(context.emitted)).toEqual(['permission.asked', 'permission.replied']);
  });

  it('does not take a reply from another session', async () => {
    const context = setup();
    const { request } = await ask(context);
    await expect(context.permissions.reply('ses_b', request.id, { decision: 'once' })).rejects.toMatchObject({ tag: 'PermissionNotFoundError' });
    expect(context.permissions.listPending()).toHaveLength(1);
  });

  it('rejects with the user\'s message, or the standard one', async () => {
    const context = setup();
    const first = await ask(context, 'echo one', { toolCallId: 'call_1' });
    await context.permissions.reply('ses_a', first.request.id, { decision: 'reject', message: 'Use the build script instead.' });
    expect(await first.answer).toEqual({ allowed: false, message: 'Use the build script instead.' });
    expect(context.permissions.takeBlocked('ses_a', 'call_1')).toEqual({ kind: 'rejected', message: 'Use the build script instead.' });

    const second = await ask(context, 'echo two', { toolCallId: 'call_2' });
    await context.permissions.reply('ses_a', second.request.id, { decision: 'reject' });
    expect(await second.answer).toEqual({ allowed: false, message: 'The user rejected this tool call.' });
    expect(DEFAULT_REJECT_MESSAGE).toBe('The user rejected this tool call.');
    expect(context.emitted.filter((event) => event.type === 'permission.replied').map((event) => event.data.reply)).toEqual(['reject', 'reject']);
  });

  it('saves the patterns on always, and does not ask the same command again, in this or another session of the project', async () => {
    const context = setup({ contexts: { ses_b: { directory: DIRECTORY, agentRules: [], sessionRules: SHELL_ASKS } } });
    const { answer, request } = await ask(context, 'echo hi');
    await context.permissions.reply('ses_a', request.id, { decision: 'always' });
    expect(await answer).toEqual({ allowed: true });
    expect(context.store.list()).toEqual([{ id: expect.stringMatching(/^psv_/), projectID: `project:${DIRECTORY}`, action: 'shell', resource: 'echo *', time: { created: expect.any(Number), updated: expect.any(Number) } }]);
    expect(context.emitted.at(-1).data.reply).toBe('always');

    expect(await context.permissions.request(bash('echo another thing', { toolCallId: 'call_2' }))).toEqual({ allowed: true });
    expect(await context.permissions.request(bash('echo hi', { sessionID: 'ses_b', toolCallId: 'call_3' }))).toEqual({ allowed: true });
    expect(types(context.emitted)).toEqual(['permission.asked', 'permission.replied']);

    void context.permissions.request(bash('ls', { toolCallId: 'call_4' }));
    await flush();
    expect(types(context.emitted).at(-1)).toBe('permission.asked');
  });

  it('keeps a saved rule inside its project', async () => {
    const context = setup({ contexts: { ses_other: { directory: '/work/other', agentRules: [], sessionRules: SHELL_ASKS } } });
    const { request } = await ask(context, 'echo hi');
    await context.permissions.reply('ses_a', request.id, { decision: 'always' });
    void context.permissions.request(bash('echo hi', { sessionID: 'ses_other' }));
    await flush();
    expect(types(context.emitted)).toEqual(['permission.asked', 'permission.replied', 'permission.asked']);
  });

  it('never lets a saved rule override a deny that came later', async () => {
    const context = setup();
    const { request } = await ask(context, 'echo hi');
    await context.permissions.reply('ses_a', request.id, { decision: 'always' });
    context.state.ses_a.sessionRules = [...SHELL_ASKS, { action: 'shell', resource: 'echo *', effect: 'deny' }];
    expect(await context.permissions.request(bash('echo hi', { toolCallId: 'call_2' }))).toMatchObject({ allowed: false });
  });

  it('leaves the request pending when the saved rule cannot be written, and the reply fails', async () => {
    let failing = true;
    const context = setup({ storeOptions: { writeFile: (file, content) => { if (failing) throw new Error('disk full'); fs.writeFileSync(file, content); } } });
    const { answer, request } = await ask(context);
    await expect(context.permissions.reply('ses_a', request.id, { decision: 'always' })).rejects.toThrow('disk full');
    expect(context.permissions.listPending()).toHaveLength(1);
    expect(types(context.emitted)).toEqual(['permission.asked']);
    expect(context.store.list()).toEqual([]);

    failing = false;
    await context.permissions.reply('ses_a', request.id, { decision: 'always' });
    expect(await answer).toEqual({ allowed: true });
    expect(context.store.list()).toHaveLength(1);
  });

  it('allows once and saves nothing for always when the request offers no pattern', async () => {
    const context = setup();
    const { answer, request } = await ask(context, 'sudo rm x');
    expect(request).not.toHaveProperty('save');
    await context.permissions.reply('ses_a', request.id, { decision: 'always' });
    expect(await answer).toEqual({ allowed: true });
    expect(context.store.list()).toEqual([]);
  });
});

describe('interrupting', () => {
  it('drops a pending request when the call is aborted, without permission.replied', async () => {
    const context = setup();
    const controller = new AbortController();
    const answer = context.permissions.request(bash('echo hi', { signal: controller.signal }));
    await flush();
    expect(context.permissions.listPending()).toHaveLength(1);

    controller.abort();
    expect(await answer).toMatchObject({ allowed: false });
    expect(context.permissions.listPending()).toEqual([]);
    expect(types(context.emitted)).toEqual(['permission.asked']);
    await expect(context.permissions.reply('ses_a', context.emitted[0].data.id, { decision: 'once' })).rejects.toMatchObject({ tag: 'PermissionNotFoundError' });
  });

  it('asks nothing for a call that is already aborted, or aborts while the source is being found', async () => {
    const context = setup({ sources: () => new Promise((resolve) => setTimeout(resolve, 20, { messageID: 'msg_1' })) });
    const done = new AbortController();
    done.abort();
    expect(await context.permissions.request(bash('echo hi', { signal: done.signal }))).toMatchObject({ allowed: false });

    const late = new AbortController();
    const answer = context.permissions.request(bash('echo hi', { signal: late.signal }));
    late.abort();
    expect(await answer).toMatchObject({ allowed: false });
    expect(context.emitted).toEqual([]);
  });

  it('gives each of several simultaneous requests its own id, and drops only the aborted one', async () => {
    const context = setup();
    const first = new AbortController();
    const one = context.permissions.request(bash('echo one', { toolCallId: 'call_1', signal: first.signal }));
    const two = context.permissions.request(bash('echo two', { toolCallId: 'call_2' }));
    await flush();
    const [a, b] = context.emitted.map((event) => event.data);
    expect(a.id).not.toBe(b.id);
    first.abort();
    await one;
    expect(context.permissions.listPending().map((request) => request.id)).toEqual([b.id]);
    await context.permissions.reply('ses_a', b.id, { decision: 'once' });
    expect(await two).toEqual({ allowed: true });
  });
});

describe('listing', () => {
  it('filters pending requests by directory and session', async () => {
    const context = setup({ contexts: { ses_b: { directory: '/work/other', agentRules: [], sessionRules: SHELL_ASKS } } });
    void context.permissions.request(bash('ls'));
    void context.permissions.request(bash('ls', { sessionID: 'ses_b', toolCallId: 'call_2' }));
    await flush();
    expect(context.permissions.listPending()).toHaveLength(2);
    expect(context.permissions.listPending({ directory: '/work/other' }).map((request) => request.sessionID)).toEqual(['ses_b']);
    expect(context.permissions.listPending({ sessionID: 'ses_a' })).toHaveLength(1);
    expect(context.permissions.listPending({ directory: '/nowhere' })).toEqual([]);
  });
});

describe('the saved rule store', () => {
  const open = (filePath, options = {}) => createSavedPermissionStore({ filePath, ...options });

  it('adds without duplicates, lists per project, updates, removes, and survives a restart', async () => {
    const filePath = path.join(makeDir(), 'nested', 'saved.json');
    let clock = 1_000;
    const store = open(filePath, { now: () => (clock += 10) });
    const one = await store.add({ projectID: 'p1', action: 'shell', resource: 'echo *' });
    const again = await store.add({ projectID: 'p1', action: 'shell', resource: 'echo *' });
    const two = await store.add({ projectID: 'p2', action: 'shell', resource: 'ls *' });
    expect(again).toEqual(one);
    expect(store.list().map((rule) => rule.id)).toEqual([one.id, two.id]);
    expect(store.list({ projectID: 'p2' })).toEqual([two]);

    const changed = await store.update(one.id, { resource: 'echo hi*' });
    expect(changed).toMatchObject({ id: one.id, resource: 'echo hi*', time: { created: one.time.created, updated: expect.any(Number) } });
    expect(changed.time.updated).toBeGreaterThan(one.time.updated);
    expect(await store.update('psv_missing', { resource: 'x' })).toBeNull();
    await expect(store.update(two.id, { projectID: 'p1', action: 'shell', resource: 'echo hi*' })).rejects.toMatchObject({ status: 409, tag: 'ConflictError' });

    expect(open(filePath).list()).toEqual([changed, two]);
    expect(await store.remove(one.id)).toBe(true);
    expect(await store.remove(one.id)).toBe(false);
    expect(open(filePath).list()).toEqual([two]);
  });

  it('keeps a file it cannot read aside and starts empty', async () => {
    const directory = makeDir();
    const filePath = path.join(directory, 'saved.json');
    fs.writeFileSync(filePath, '{ not json');
    const store = open(filePath, { now: () => 42 });
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(`${filePath}.corrupt-42`)).toBe(true);
    await store.add({ projectID: 'p', action: 'shell', resource: 'x' });
    expect(open(filePath).list()).toHaveLength(1);
  });

  it('leaves its memory and file as they were when a write fails', async () => {
    const filePath = path.join(makeDir(), 'saved.json');
    let failing = false;
    const store = open(filePath, { writeFile: (file, content) => { if (failing) throw new Error('disk full'); fs.writeFileSync(file, content); } });
    const kept = await store.add({ projectID: 'p', action: 'shell', resource: 'a *' });
    failing = true;
    await expect(store.add({ projectID: 'p', action: 'shell', resource: 'b *' })).rejects.toThrow('disk full');
    await expect(store.remove(kept.id)).rejects.toThrow('disk full');
    expect(store.list()).toEqual([kept]);
    failing = false;
    expect(open(filePath).list()).toEqual([kept]);
    expect((await store.add({ projectID: 'p', action: 'shell', resource: 'b *' })).resource).toBe('b *');
  });
});
