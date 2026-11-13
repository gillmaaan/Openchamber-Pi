// Contract tests of the shell commands, the running list and the job list.
// Commands run on a real Pi child (`pi --mode rpc`, isolated agent directory
// and HOME) through `createLiveSessionHost`, with real processes, so what is
// proven is what Pi's RPC `bash` does: its output events, its abort, its
// result. The paths that need a Pi that misbehaves (keepalive, binding the
// message id to Pi's entry) use a fake host.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sessionNotFound } from '../errors.js';
import { createEventHub } from '../hub.js';
import { createBridgeHttpServer, STREAMED } from '../http.js';
import { createLiveSessionHost, createPiClientFactory } from '../../live-session-host.js';
import { startMockOpenAi } from '../../test-support/mock-openai.js';
import { createPiFixture } from '../../test-support/pi-fixture.js';
import { loadWorkspaceSchemas } from './test-support/workspace-schema.js';
import { createWorkspace } from './workspace.js';
import { findBashTimestamp, trimIncompleteUtf8 } from './workspace-shells.js';

const PASSWORD = 'correct horse';
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await sleep(20);
  }
};

let sequence = 0;
const mint = (prefix) => {
  sequence += 1;
  return `${prefix}_test${String(sequence).padStart(8, '0')}${'x'.repeat(13)}`;
};

const stops = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

/**
 * A bridge with the workspace routes over `host`. `sessions` maps an id to its
 * directory (`null` for a session that does not exist).
 */
const start = async ({ host, directory, sessions = {}, hub, ...deps }) => {
  const events = [];
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-shells-tmp-'));
  const workspace = createWorkspace({
    getDefaultDirectory: () => directory,
    requireSession: async (id) => {
      const known = sessions[id];
      if (!known) throw sessionNotFound(id);
      return { id, location: { directory: known.directory ?? known }, parentID: known.parentID };
    },
    emit: (type, data, location, options) => {
      events.push({ type, data, directory: location, options });
      hub?.emit({ type, data, ...(location ? { location: { directory: location } } : {}), ...(options?.id ? { id: options.id } : {}) });
    },
    host,
    tmpDir,
    log: () => {},
    ...deps,
  });
  const routes = [...workspace.routes];
  if (hub) routes.push({ method: 'GET', path: '/api/event', handler: ({ res }) => { hub.subscribe(res, {}); return STREAMED; } });
  const server = createBridgeHttpServer({ password: PASSWORD, routes });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  stops.push(async () => {
    workspace.close();
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = async (method, route, { dir = directory, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: AUTHORIZATION,
        ...(dir ? { 'x-opencode-directory': encodeURIComponent(dir) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  /** POST a shell command; the promise settles when the command has ended. */
  const shell = (sessionID, command, id = mint('msg')) => ({ id, answer: call('POST', `/api/session/${sessionID}/shell`, { body: { id, command } }) });
  const types = () => events.map((event) => event.type);
  const of = (type) => events.filter((event) => event.type === type);
  return { call, shell, events, types, of, base, tmpDir, workspace };
};

describe('shell commands on a real Pi', () => {
  let mock;
  let fixture;
  let host;
  let launches;
  let schemas;

  beforeAll(async () => {
    schemas = await loadWorkspaceSchemas();
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
    host = createLiveSessionHost({ createClient: createPiClientFactory({ getBaseEnv: () => fixture.env }) });
    launches = [];
  });
  afterAll(async () => {
    await host.shutdown();
    await mock.close();
    fixture.dispose();
  });

  const bridge = (options = {}) => start({
    host,
    directory: fixture.project,
    sessions: { ses_main: fixture.project, ses_other: fixture.project, ses_third: fixture.project },
    getLaunch: async (record) => { launches.push(record.id); return {}; },
    ...options,
  });

  it('runs a command, announces it in order and keeps its output readable by cursor', async () => {
    const ctx = await bridge();
    const { id: messageID, answer } = ctx.shell('ses_main', 'echo hello; echo err 1>&2; exit 3');
    const posted = await answer;
    expect(posted.status).toBe(204);
    expect(posted.text).toBe('');

    expect(ctx.types()).toEqual([
      'shell.created',
      'session.shell.started',
      'shell.exited',
      'session.shell.ended',
      'session.inbox.enqueued',
      'session.inbox.delivered',
    ]);
    const [created] = ctx.of('shell.created');
    const [started] = ctx.of('session.shell.started');
    const shellID = created.data.info.id;
    expect(shellID).toMatch(/^sh_/);
    expect(created.directory).toBe(fixture.project);
    expect(created.data.info).toMatchObject({
      id: shellID,
      status: 'running',
      command: 'echo hello; echo err 1>&2; exit 3',
      cwd: fixture.project,
      metadata: { sessionID: 'ses_main', background: true },
    });
    expect(Object.keys(created.data.info).sort()).toEqual(['command', 'cwd', 'file', 'id', 'metadata', 'shell', 'status', 'time']);
    expect(() => schemas.shellInfo(created.data.info)).not.toThrow();
    expect(typeof created.data.info.time.started).toBe('number');
    // The UI names the shell's message after this event: `evt_X` is `msg_X`.
    expect(started.options).toEqual({ id: `evt_${messageID.slice(4)}` });
    expect(started.data).toEqual({ sessionID: 'ses_main', shell: created.data.info });

    expect(ctx.of('shell.exited')[0].data).toEqual({ id: shellID, exit: 3, status: 'exited' });
    const [ended] = ctx.of('session.shell.ended');
    expect(ended.data.sessionID).toBe('ses_main');
    expect(ended.data.shell).toMatchObject({ id: shellID, status: 'exited', exit: 3 });
    expect(ended.data.shell.time.completed).toBeGreaterThanOrEqual(ended.data.shell.time.started);
    expect(ended.data.output).toEqual({ output: 'hello\nerr\n', cursor: 10, size: 10, truncated: false });
    expect(() => schemas.shellInfo(ended.data.shell)).not.toThrow();
    expect(() => schemas.shellOutput(ended.data.output)).not.toThrow();

    const [note] = ctx.of('session.inbox.enqueued');
    expect(note.data.item.type).toBe('synthetic');
    expect(note.data.item.payload.metadata).toEqual({ source: 'shell', shellID, state: 'completed', truncated: false, exit: 3 });
    expect(note.data.item.payload.text).toBe(`The following shell command was executed by the user:\n<shell id="${shellID}" state="completed" command="echo hello; echo err 1&gt;&amp;2; exit 3">\nhello\nerr\n\n\nExited with code 3\n</shell>`);
    expect(ctx.of('session.inbox.delivered')[0].data).toEqual({ sessionID: 'ses_main', inboxID: note.data.inboxID });

    // It is no longer running, but stays readable.
    expect((await ctx.call('GET', '/api/shell')).body).toEqual({ location: { directory: fixture.project }, data: [] });
    const info = await ctx.call('GET', `/api/shell/${shellID}`);
    expect(info.body.data).toMatchObject({ id: shellID, status: 'exited', exit: 3, command: 'echo hello; echo err 1>&2; exit 3' });
    const page = (query) => ctx.call('GET', `/api/shell/${shellID}/output${query}`);
    expect((await page('')).body).toEqual({ location: { directory: fixture.project }, data: { output: 'hello\nerr\n', cursor: 10, size: 10, truncated: false } });
    expect((await page('?cursor=3&limit=4')).body.data).toEqual({ output: 'lo\ne', cursor: 7, size: 10, truncated: false });
    const whole = (await page('')).body.data;
    expect(() => schemas.shellOutput(whole)).not.toThrow();
    expect(() => schemas.shellInfo(info.body.data)).not.toThrow();
    expect((await page('?cursor=9007199254740991')).body.data).toEqual({ output: '', cursor: 10, size: 10, truncated: false });
    expect((await page('?limit=0')).status).toBe(400);
    expect((await page('?cursor=-1')).body.message).toBe('Expected a value greater than or equal to 0\n  at ["cursor"]');
    expect((await page('?cursor=x')).body.message).toBe('Expected an integer\n  at ["cursor"]');
    expect(fs.readFileSync(created.data.info.file, 'utf8')).toBe('hello\nerr\n');
    expect((await ctx.call('GET', '/api/shell/sh_nope/output')).body).toEqual({ _tag: 'ShellNotFoundError', message: 'Shell command not found: sh_nope', id: 'sh_nope' });
    expect((await ctx.call('GET', '/api/shell/nope')).body.message).toBe('Expected a string starting with "sh_"\n  at ["id"]');

    const jobs = await ctx.call('GET', '/api/experimental/job?status=completed', { dir: null });
    expect(() => schemas.jobs(jobs.body.data)).not.toThrow();
    expect(jobs.body.data).toEqual([{ kind: 'shell', id: shellID, sessionID: 'ses_main', status: 'completed', title: 'echo hello; echo err 1>&2; exit 3', time: ended.data.shell.time, shellID, command: 'echo hello; echo err 1>&2; exit 3' }]);
  });

  it('lists a running command with its output so far, scopes it to its folder, and answers the job list for the session and its children', async () => {
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-shells-other-'));
    const ctx = await bridge({
      sessions: {
        ses_main: fixture.project,
        ses_child: { directory: fixture.project, parentID: 'ses_main' },
        ses_stranger: fixture.project,
      },
    });
    const { answer } = ctx.shell('ses_main', 'echo first; sleep 1.5; echo second');
    await waitFor(() => ctx.of('shell.created').length === 1);
    const shellID = ctx.of('shell.created')[0].data.info.id;
    await waitFor(async () => (await ctx.call('GET', `/api/shell/${shellID}/output`)).body.data.output.includes('first'));

    const listed = await ctx.call('GET', '/api/shell');
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ id: shellID, status: 'running', metadata: { sessionID: 'ses_main' } });
    expect(() => schemas.shellInfos(listed.body.data)).not.toThrow();
    expect((await ctx.call('GET', `/api/shell/${shellID}`)).body.data.status).toBe('running');
    expect((await ctx.call('GET', `/api/shell/${shellID}/output`)).body.data).toMatchObject({ output: 'first\n', cursor: 6, size: 6 });

    const running = await ctx.call('GET', '/api/experimental/job?sessionID=ses_main&descendants=true&status=running', { dir: null });
    expect(running.body.data).toEqual([expect.objectContaining({ kind: 'shell', id: shellID, sessionID: 'ses_main', status: 'running', shellID })]);
    expect(() => schemas.jobs(running.body.data)).not.toThrow();
    expect(Object.keys(running.body.data[0]).sort()).toEqual(['command', 'id', 'kind', 'sessionID', 'shellID', 'status', 'time', 'title']);
    // A parent sees the jobs of its children only with `descendants`.
    const child = await ctx.call('GET', '/api/experimental/job?sessionID=ses_child&descendants=true', { dir: null });
    expect(child.body.data).toEqual([]);
    const strangerJobs = await ctx.call('GET', '/api/experimental/job?sessionID=ses_stranger&descendants=true&status=running', { dir: null });
    expect(strangerJobs.body.data).toEqual([]);
    expect((await ctx.call('GET', '/api/experimental/job?kind=image&status=running', { dir: null })).body.data).toEqual([]);
    expect((await ctx.call('GET', '/api/experimental/job?kind=subagent', { dir: null })).body.data).toEqual([]);
    expect((await ctx.call('GET', '/api/experimental/job?sessionID=ses_nope', { dir: null })).body._tag).toBe('SessionNotFoundError');
    expect((await ctx.call('GET', '/api/experimental/job?sessionID=abc', { dir: null })).status).toBe(400);
    expect((await ctx.call('GET', '/api/experimental/job?status=bogus', { dir: null })).body.message).toBe('Expected Job.Status\n  at ["status"]');
    expect((await ctx.call('GET', '/api/experimental/job?kind=bogus', { dir: null })).body.message).toBe('Expected Job.Kind\n  at ["kind"]');
    expect((await ctx.call('GET', '/api/experimental/job?descendants=maybe', { dir: null })).status).toBe(400);

    // Another folder sees nothing of it and cannot stop it.
    expect((await ctx.call('GET', '/api/shell', { dir: other })).body).toEqual({ location: { directory: other }, data: [] });
    expect((await ctx.call('GET', `/api/shell/${shellID}`, { dir: other })).status).toBe(404);
    expect((await ctx.call('GET', `/api/shell/${shellID}/output`, { dir: other })).status).toBe(404);
    expect((await ctx.call('DELETE', `/api/shell/${shellID}`, { dir: other })).status).toBe(204);
    expect((await ctx.call('GET', '/api/shell')).body.data).toHaveLength(1);

    expect((await answer).status).toBe(204);
    expect((await ctx.call('GET', '/api/shell')).body.data).toEqual([]);
    expect((await ctx.call('GET', `/api/shell/${shellID}/output`)).body.data.output).toBe('first\nsecond\n');
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('stops a running command on DELETE, tells the agent it was cancelled, and leaves the process usable', async () => {
    const ctx = await bridge();
    const { id: messageID, answer } = ctx.shell('ses_main', 'echo going; sleep 30; echo never');
    await waitFor(() => ctx.of('shell.created').length === 1);
    const shellID = ctx.of('shell.created')[0].data.info.id;
    await waitFor(async () => (await ctx.call('GET', `/api/shell/${shellID}/output`)).body.data.output === 'going\n');

    const startedAt = Date.now();
    expect((await ctx.call('DELETE', `/api/shell/${shellID}`)).status).toBe(204);
    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect((await answer).status).toBe(204);

    expect(ctx.types()).toEqual([
      'shell.created',
      'session.shell.started',
      'shell.exited',
      'session.shell.ended',
      'session.inbox.enqueued',
      'session.inbox.delivered',
      'shell.deleted',
    ]);
    expect(ctx.of('shell.exited')[0].data).toEqual({ id: shellID, status: 'killed' });
    expect(ctx.of('session.shell.ended')[0].data.shell).toMatchObject({ status: 'killed' });
    expect(ctx.of('session.shell.ended')[0].data.shell.exit).toBeUndefined();
    expect(ctx.of('session.shell.ended')[0].data.output.output).toBe('going\n');
    const note = ctx.of('session.inbox.enqueued')[0].data.item.payload;
    expect(note.metadata).toEqual({ source: 'shell', shellID, state: 'cancelled', truncated: false });
    expect(note.text).toContain('\nCancelled\n</shell>');
    expect(ctx.of('shell.deleted')[0].data).toEqual({ id: shellID });
    expect(messageID).toBeTruthy();

    expect((await ctx.call('GET', `/api/shell/${shellID}`)).status).toBe(404);
    expect((await ctx.call('DELETE', `/api/shell/${shellID}`)).status).toBe(204);
    expect((await ctx.call('DELETE', '/api/shell/sh_unknown')).status).toBe(204);

    const again = await ctx.shell('ses_main', 'echo alive').answer;
    expect(again.status).toBe(204);
    expect(ctx.of('session.shell.ended').at(-1).data.output.output).toBe('alive\n');
  });

  it('runs commands side by side with their output apart, in one session and across sessions', async () => {
    const ctx = await bridge();
    const a = ctx.shell('ses_main', 'echo A1; sleep 2.5; echo A2');
    await waitFor(() => ctx.of('shell.created').length === 1);
    const b = ctx.shell('ses_main', 'echo B1; sleep 1.5; echo B2');
    const c = ctx.shell('ses_other', 'echo C1; sleep 1; echo C2');
    await waitFor(() => ctx.of('shell.created').length === 3);
    expect((await ctx.call('GET', '/api/shell')).body.data).toHaveLength(3);
    await Promise.all([a.answer, b.answer, c.answer]);

    const outputs = Object.fromEntries(ctx.of('session.shell.ended').map((event) => [event.data.shell.command, event.data.output.output]));
    expect(outputs).toEqual({
      'echo A1; sleep 2.5; echo A2': 'A1\nA2\n',
      'echo B1; sleep 1.5; echo B2': 'B1\nB2\n',
      'echo C1; sleep 1; echo C2': 'C1\nC2\n',
    });
    // B started after A and ended before it: they overlapped.
    const order = ctx.events.filter((event) => event.type === 'shell.exited' || event.type === 'shell.created').map((event) => `${event.type}:${event.data.info?.command ?? event.data.id}`);
    const createdB = order.findIndex((entry) => entry === 'shell.created:echo B1; sleep 1.5; echo B2');
    const exitedA = order.findIndex((entry) => entry.startsWith('shell.exited:') && entry.includes(ctx.of('shell.created')[0].data.info.id));
    expect(createdB).toBeLessThan(exitedA);
    const files = ctx.of('shell.created').map((event) => event.data.info.file);
    expect(new Set(files).size).toBe(3);
    const stored = Object.fromEntries(ctx.of('shell.created').map((event) => [event.data.info.command, fs.readFileSync(event.data.info.file, 'utf8')]));
    expect(stored['echo A1; sleep 2.5; echo A2']).toBe('A1\nA2\n');
    expect(stored['echo B1; sleep 1.5; echo B2']).toBe('B1\nB2\n');
  });

  it('stops a command that runs past the timeout and keeps the process usable', async () => {
    const ctx = await bridge({ shellOptions: { timeoutMs: 700 } });
    const startedAt = Date.now();
    const answer = await ctx.shell('ses_main', 'echo before; sleep 30').answer;
    expect(answer.status).toBe(204);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(ctx.of('shell.exited')[0].data).toEqual({ id: ctx.of('shell.created')[0].data.info.id, status: 'timeout' });
    expect(ctx.of('session.shell.ended')[0].data.output.output).toBe('before\n');
    expect(ctx.of('session.inbox.enqueued')[0].data.item.payload.metadata).toMatchObject({ state: 'error', timeout: true });
    expect(ctx.of('session.inbox.enqueued')[0].data.item.payload.text).toContain('\nTimed out\n</shell>');
    expect((await ctx.call('GET', '/api/experimental/job?status=error', { dir: null })).body.data).toHaveLength(1);

    expect((await ctx.shell('ses_main', 'echo fine').answer).status).toBe(204);
    expect(ctx.of('shell.exited').at(-1).data.status).toBe('exited');
  });

  it('bounds what it keeps of a noisy command', async () => {
    const ctx = await bridge({ shellOptions: { maxOutputBytes: 1000 } });
    expect((await ctx.shell('ses_main', 'i=0; while [ $i -lt 300 ]; do echo "line number $i of a noisy command"; i=$((i+1)); done').answer).status).toBe(204);
    const shellID = ctx.of('shell.created')[0].data.info.id;
    const page = (await ctx.call('GET', `/api/shell/${shellID}/output?limit=100000`)).body.data;
    expect(page.size).toBe(1000);
    expect(page.truncated).toBe(true);
    expect(page.output.startsWith('line number 0 of a noisy command\n')).toBe(true);
    expect(fs.statSync(ctx.of('shell.created')[0].data.info.file).size).toBe(1000);
    expect(ctx.of('session.shell.ended')[0].data.output.output.length).toBeGreaterThan(0);
  });

  it('pages multi-byte output on character boundaries', async () => {
    const ctx = await bridge();
    const text = 'héllo wörld ✓✓✓ 日本語 😀😀\n';
    await ctx.shell('ses_main', `printf '${text.repeat(3)}'`).answer;
    const shellID = ctx.of('shell.created')[0].data.info.id;
    let cursor = 0;
    let joined = '';
    for (let pages = 0; pages < 200; pages += 1) {
      const { output, cursor: next, size } = (await ctx.call('GET', `/api/shell/${shellID}/output?cursor=${cursor}&limit=7`)).body.data;
      joined += output;
      expect(output).not.toContain('�');
      if (next >= size) break;
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(joined).toBe(text.repeat(3));
  });

  it('ends a command whose process dies and starts a gated process for the next one', async () => {
    const ctx = await bridge();
    const { answer } = ctx.shell('ses_third', 'echo up; sleep 30');
    await waitFor(() => ctx.of('shell.created').length === 1);
    await waitFor(async () => (await ctx.call('GET', `/api/shell/${ctx.of('shell.created')[0].data.info.id}/output`)).body.data.output === 'up\n');
    const pid = host.get('ses_third').pid;
    process.kill(pid, 'SIGKILL');
    expect((await answer).status).toBe(204);

    expect(ctx.of('shell.exited')[0].data.status).toBe('killed');
    expect(ctx.of('shell.exited')[0].data.exit).toBeUndefined();
    expect(ctx.of('session.shell.ended')[0].data.output.output).toBe('up\n');
    expect((await ctx.call('GET', '/api/shell')).body.data).toEqual([]);

    const before = launches.filter((id) => id === 'ses_third').length;
    expect((await ctx.shell('ses_third', 'echo again').answer).status).toBe(204);
    expect(launches.filter((id) => id === 'ses_third').length).toBe(before + 1);
    expect(ctx.of('session.shell.ended').at(-1).data.output.output).toBe('again\n');
  });

  it('refuses past the cap on running commands', async () => {
    const ctx = await bridge({ shellOptions: { maxRunning: 1 } });
    const first = ctx.shell('ses_main', 'sleep 1');
    await waitFor(() => ctx.of('shell.created').length === 1);
    const second = await ctx.shell('ses_other', 'echo no').answer;
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ _tag: 'ConflictError', message: 'Too many shell commands are running' });
    expect(ctx.of('shell.created')).toHaveLength(1);
    await first.answer;
    expect((await ctx.shell('ses_other', 'echo yes').answer).status).toBe(204);
  });

  it('answers a repeated message id without running the command again', async () => {
    const ctx = await bridge();
    const id = mint('msg');
    const first = ctx.shell('ses_main', 'sleep 1; echo once', id);
    await waitFor(() => ctx.of('shell.created').length === 1);
    const startedAt = Date.now();
    const repeated = await ctx.shell('ses_main', 'sleep 1; echo once', id).answer;
    expect(repeated.status).toBe(204);
    expect(Date.now() - startedAt).toBeLessThan(800);
    await first.answer;
    expect(ctx.of('shell.created')).toHaveLength(1);
  });

  it('keeps the newest finished commands only', async () => {
    const ctx = await bridge({ shellOptions: { retainCount: 1 } });
    await ctx.shell('ses_main', 'echo one').answer;
    await ctx.shell('ses_main', 'echo two').answer;
    const [first, second] = ctx.of('shell.created').map((event) => event.data.info);
    expect((await ctx.call('GET', `/api/shell/${first.id}`)).status).toBe(404);
    expect(fs.existsSync(first.file)).toBe(false);
    expect((await ctx.call('GET', `/api/shell/${second.id}`)).status).toBe(200);
  });

  it('rejects a bad request with a tagged error and no event', async () => {
    const ctx = await bridge();
    const post = (session, body) => ctx.call('POST', `/api/session/${session}/shell`, { body });
    expect((await post('ses_main', {})).body).toEqual({ _tag: 'InvalidRequestError', message: 'Missing key\n  at ["command"]', kind: 'Payload' });
    expect((await post('ses_main', { command: 5 })).body.message).toBe('Expected string\n  at ["command"]');
    expect((await post('ses_main', { command: 'true', id: 'nope' })).body.message).toBe('Expected a string starting with "msg_"\n  at ["id"]');
    expect((await post('ses_main', [])).body.message).toBe('Expected object');
    const unknown = await post('ses_gone', { command: 'true' });
    expect(unknown.status).toBe(404);
    expect(unknown.body._tag).toBe('SessionNotFoundError');
    expect((await post('abc', { command: 'true' })).body.message).toBe('Expected a string starting with "ses"\n  at ["sessionID"]');

    const missingFolder = path.join(fixture.root, 'gone-folder');
    const lost = await start({ host, directory: fixture.project, sessions: { ses_lost: missingFolder }, getLaunch: async () => ({}) });
    const answer = await lost.call('POST', '/api/session/ses_lost/shell', { body: { command: 'true' } });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ _tag: 'LocationNotFoundError', location: { directory: missingFolder } });
    expect(ctx.events).toEqual([]);
    expect(lost.events).toEqual([]);
  });

  it('refuses a command for a session with no live process when the bridge cannot start one the gated way', async () => {
    const ctx = await bridge({ getLaunch: undefined, sessions: { ses_cold: fixture.project } });
    const answer = await ctx.shell('ses_cold', 'echo no').answer;
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ _tag: 'ServiceUnavailableError', service: 'pi' });
    expect(ctx.events).toEqual([]);
    expect(host.get('ses_cold')).toBeNull();
  });

  it('gives the message of session.shell.started the id the UI minted, on the real event stream', async () => {
    const hub = createEventHub();
    const ctx = await bridge({ hub });
    const frames = [];
    const controller = new AbortController();
    const stream = fetch(`${ctx.base}/api/event`, { headers: { authorization: AUTHORIZATION }, signal: controller.signal }).then(async (response) => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
          const raw = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (raw.startsWith('data: ')) frames.push(JSON.parse(raw.slice(6)));
        }
      }
    }).catch(() => {});
    await waitFor(() => frames.some((frame) => frame.type === 'server.connected'));
    const { id } = ctx.shell('ses_main', 'echo streamed');
    await waitFor(() => frames.some((frame) => frame.type === 'session.inbox.delivered'));
    controller.abort();
    await stream;
    hub.close();

    const started = frames.find((frame) => frame.type === 'session.shell.started');
    expect(started.id).toBe(`evt_${id.slice(4)}`);
    expect(started.location).toEqual({ directory: fixture.project });
    expect(frames.filter((frame) => frame.type !== 'server.connected').map((frame) => frame.type)).toEqual([
      'shell.created', 'session.shell.started', 'shell.exited', 'session.shell.ended', 'session.inbox.enqueued', 'session.inbox.delivered',
    ]);
  });
});

/** A host that does what the tests say: one RPC `bash` that ends when told to. */
const createFakeHost = ({ sessionFile } = {}) => {
  const emitter = new EventEmitter();
  const live = new Map();
  const requests = [];
  const waiting = [];
  return {
    requests,
    on: (name, listener) => { emitter.on(name, listener); return () => emitter.off(name, listener); },
    get: (id) => live.get(id) ?? null,
    ensure: async (session) => { live.set(session.id, { sessionId: session.id, cwd: session.cwd, state: { sessionFile }, pid: 1 }); },
    request: async (session, type, fields, options) => {
      requests.push({ type, fields, options });
      if (type === 'bash') return new Promise((resolve) => waiting.push(resolve));
      return {};
    },
    emitEvent: (sessionId, event) => emitter.emit('event', { sessionId, event }),
    finishBash: (result) => waiting.shift()(result),
    drop: (id) => live.delete(id),
  };
};

describe('shell commands with a fake host', () => {
  const directory = fs.realpathSync(os.tmpdir());
  const bridge = (host, options = {}) => start({ host, directory, sessions: { ses_fake: directory }, getLaunch: async () => ({}), ...options });

  it('keeps the process busy while a command is quiet, and only a live one', async () => {
    const host = createFakeHost();
    const ctx = await bridge(host, { shellOptions: { keepaliveMs: 25 } });
    const { answer } = ctx.shell('ses_fake', 'sleep 100');
    await waitFor(() => host.requests.filter((request) => request.type === 'get_state').length >= 2);
    host.drop('ses_fake');
    const seen = host.requests.length;
    await sleep(120);
    expect(host.requests.length).toBe(seen);
    host.finishBash({ output: '', exitCode: 0, cancelled: false, truncated: false });
    await answer;
    await sleep(100);
    expect(host.requests.length).toBe(seen);
  });

  it('gives each command its own RPC id and takes output only from its own updates', async () => {
    const host = createFakeHost();
    const ctx = await bridge(host);
    const { answer } = ctx.shell('ses_fake', 'echo mine');
    await waitFor(() => host.requests.some((request) => request.type === 'bash'));
    const bash = host.requests.find((request) => request.type === 'bash');
    expect(bash.options).toEqual({ timeoutMs: 0, id: expect.stringMatching(/^shell:sh_/) });
    expect(bash.fields).toEqual({ command: 'echo mine' });
    host.emitEvent('ses_fake', { type: 'bash_execution_update', id: 'shell:sh_other', delta: 'not mine\n' });
    host.emitEvent('ses_fake', { type: 'bash_execution_update', id: bash.options.id, delta: 'mine\n' });
    const shellID = ctx.of('shell.created')[0].data.info.id;
    expect((await ctx.call('GET', `/api/shell/${shellID}/output`)).body.data.output).toBe('mine\n');
    host.finishBash({ output: 'mine\n', exitCode: 0, cancelled: false, truncated: true });
    await answer;
    expect(ctx.of('session.shell.ended')[0].data.output).toEqual({ output: 'mine\n', cursor: 5, size: 5, truncated: true });
    expect(ctx.of('session.inbox.enqueued')[0].data.item.payload.metadata.truncated).toBe(true);
  });

  it('answers a command that ended with no output as "(no output)"', async () => {
    const host = createFakeHost();
    const ctx = await bridge(host);
    const { answer } = ctx.shell('ses_fake', 'true');
    await waitFor(() => host.requests.some((request) => request.type === 'bash'));
    host.finishBash({ output: '', exitCode: 0, cancelled: false, truncated: false });
    await answer;
    expect(ctx.of('session.inbox.enqueued')[0].data.item.payload.text).toContain('>\n(no output)\n</shell>');
  });

  describe('binding the UI message id to the entry Pi stores', () => {
    const entryFor = (command, timestamp) => `${JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: 'bashExecution', command, output: 'x', exitCode: 0, cancelled: false, truncated: false, timestamp } })}\n`;

    it('binds at once when Pi has written the entry', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bind-'));
      const file = path.join(dir, 'session.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'ses_fake' })}\n`);
      const host = createFakeHost({ sessionFile: file });
      const bound = [];
      const ctx = await bridge(host, { bindClientId: (...args) => { bound.push(args); } });
      const { id, answer } = ctx.shell('ses_fake', 'echo bound');
      await waitFor(() => host.requests.some((request) => request.type === 'bash'));
      const now = Date.now();
      fs.appendFileSync(file, entryFor('echo other', now + 1) + entryFor('echo bound', now));
      host.finishBash({ output: 'bound\n', exitCode: 0, cancelled: false, truncated: false });
      await answer;
      await waitFor(() => bound.length === 1);
      expect(bound).toEqual([['ses_fake', now, id]]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('binds when the turn that was running settles and Pi flushes the entry', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bind-'));
      const file = path.join(dir, 'session.jsonl');
      const host = createFakeHost({ sessionFile: file });
      const bound = [];
      const ctx = await bridge(host, { bindClientId: (...args) => { bound.push(args); } });
      const { id, answer } = ctx.shell('ses_fake', 'echo later');
      await waitFor(() => host.requests.some((request) => request.type === 'bash'));
      host.finishBash({ output: 'later\n', exitCode: 0, cancelled: false, truncated: false });
      await answer;
      await sleep(50);
      expect(bound).toEqual([]);

      host.emitEvent('ses_fake', { type: 'agent_settled', aborted: false });
      await sleep(50);
      expect(bound).toEqual([]);
      fs.writeFileSync(file, entryFor('echo later', Date.now()));
      host.emitEvent('ses_fake', { type: 'agent_settled', aborted: false });
      await waitFor(() => bound.length === 1);
      expect(bound[0][0]).toBe('ses_fake');
      expect(bound[0][2]).toBe(id);
      host.emitEvent('ses_fake', { type: 'agent_settled', aborted: false });
      await sleep(50);
      expect(bound).toHaveLength(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds the entry nearest to when the command ended, and none for another command or a far time', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bind-'));
      const file = path.join(dir, 'session.jsonl');
      fs.writeFileSync(file, `not json\n${entryFor('ls', 1000)}${entryFor('ls', 9000)}${entryFor('pwd', 9001)}`);
      expect(await findBashTimestamp(file, { command: 'ls', endedAt: 9100 })).toBe(9000);
      expect(await findBashTimestamp(file, { command: 'ls', endedAt: 1200 })).toBe(1000);
      expect(await findBashTimestamp(file, { command: 'ls', endedAt: 20000 })).toBeNull();
      expect(await findBashTimestamp(file, { command: 'whoami', endedAt: 9000 })).toBeNull();
      expect(await findBashTimestamp(path.join(dir, 'missing.jsonl'), { command: 'ls', endedAt: 9000 })).toBeNull();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('cuts a buffer back to its last complete character', () => {
    const text = Buffer.from('a✓😀', 'utf8');
    expect(trimIncompleteUtf8(text).toString()).toBe('a✓😀');
    expect(trimIncompleteUtf8(text.subarray(0, text.length - 1)).toString()).toBe('a✓');
    expect(trimIncompleteUtf8(text.subarray(0, text.length - 3)).toString()).toBe('a✓');
    expect(trimIncompleteUtf8(text.subarray(0, 3)).toString()).toBe('a');
    expect(trimIncompleteUtf8(Buffer.from('plain')).toString()).toBe('plain');
    expect(trimIncompleteUtf8(Buffer.alloc(0)).length).toBe(0);
  });

  it('includes the jobs the bridge is told about, such as subagents, in the list', async () => {
    const subagent = { kind: 'subagent', id: 'ses_child', sessionID: 'ses_fake', status: 'running', title: 'explore', time: { started: 1 }, childSessionID: 'ses_child', agent: 'explore', description: 'explore' };
    const ctx = await bridge(createFakeHost(), { listJobs: () => [subagent] });
    expect((await ctx.call('GET', '/api/experimental/job?status=running&sessionID=ses_fake', { dir: null })).body.data).toEqual([subagent]);
    expect((await ctx.call('GET', '/api/experimental/job?kind=shell', { dir: null })).body.data).toEqual([]);
  });
});
