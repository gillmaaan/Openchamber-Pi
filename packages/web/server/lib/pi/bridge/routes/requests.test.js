// The permission and form routes, the way the UI and the permission auto-accept
// runtime call them: statuses, envelopes and tags from the wire spec (3.5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startGateBridge } from '../../test-support/gate-bridge.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const ASK_SHELL = [{ action: 'shell', resource: '*', effect: 'ask' }];

const start = async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-requests-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-requests-other-')));
  cleanups.push(() => fs.rmSync(project, { recursive: true, force: true }), () => fs.rmSync(other, { recursive: true, force: true }));
  const sessions = {
    ses_a: { directory: project, agentRules: [], sessionRules: ASK_SHELL },
    ses_b: { directory: other, agentRules: [], sessionRules: ASK_SHELL },
  };
  const bridge = await startGateBridge({ sessions, defaultDirectory: project });
  cleanups.push(() => bridge.close());
  const ask = (sessionID, command, toolCallId = 'call_1') => bridge.permissions.request({ sessionID, toolCallId, tool: 'bash', input: { command } });
  const askForm = (sessionID, questions, toolCallId = 'call_2') => bridge.forms.ask({
    sessionID,
    toolCallId,
    questions: questions ?? [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }] }],
  });
  return { bridge, project, other, ask, askForm };
};

describe('permission routes', () => {
  it('lists pending requests of a location, of a session, and one by id', async () => {
    const { bridge, project, other, ask } = await start();
    void ask('ses_a', 'echo hi');
    void ask('ses_b', 'ls', 'call_2');
    await flush();
    const [first] = bridge.permissions.listPending({ sessionID: 'ses_a' });

    const byLocation = await bridge.api('GET', '/api/permission/request');
    expect(byLocation.status).toBe(200);
    expect(byLocation.body).toEqual({ location: { directory: project }, data: [first] });
    const otherLocation = await bridge.api('GET', '/api/permission/request', undefined, other);
    expect(otherLocation.body.location).toEqual({ directory: other });
    expect(otherLocation.body.data.map((request) => request.sessionID)).toEqual(['ses_b']);

    expect(await bridge.api('GET', '/api/session/ses_a/permission')).toEqual({ status: 200, body: { data: [first] } });
    expect(await bridge.api('GET', `/api/session/ses_a/permission/${first.id}`)).toEqual({ status: 200, body: { data: first } });
  });

  it('answers an unknown location with LocationNotFoundError and an unknown session with SessionNotFoundError', async () => {
    const { bridge } = await start();
    const missing = await bridge.api('GET', '/api/permission/request', undefined, '/definitely/not/here');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ _tag: 'LocationNotFoundError', location: { directory: '/definitely/not/here' } });
    expect(await bridge.api('GET', '/api/session/ses_missing/permission')).toMatchObject({ status: 404, body: { _tag: 'SessionNotFoundError', sessionID: 'ses_missing' } });
  });

  it('replies with 204, then 404 PermissionNotFoundError for the same request and for a wrong id', async () => {
    const { bridge, ask } = await start();
    const answer = ask('ses_a', 'echo hi');
    await flush();
    const { id } = bridge.permissions.listPending()[0];

    expect(await bridge.api('POST', `/api/session/ses_a/permission/${id}/reply`, { decision: 'once' })).toEqual({ status: 204, body: null });
    expect(await answer).toEqual({ allowed: true });

    const again = await bridge.api('POST', `/api/session/ses_a/permission/${id}/reply`, { decision: 'once' });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ _tag: 'PermissionNotFoundError', requestID: id, message: `Permission request not found: ${id}` });
    expect((await bridge.api('GET', `/api/session/ses_a/permission/${id}`)).status).toBe(404);
    expect((await bridge.api('GET', '/api/session/ses_a/permission/per_nonexistent0000000000000000')).body._tag).toBe('PermissionNotFoundError');
  });

  it('refuses a reply that names no decision, and keeps the request', async () => {
    const { bridge, ask } = await start();
    void ask('ses_a', 'echo hi');
    await flush();
    const { id } = bridge.permissions.listPending()[0];
    for (const body of [{}, { decision: 'maybe' }, { reply: 'once' }, { decision: 'reject', message: 7 }]) {
      const response = await bridge.api('POST', `/api/session/ses_a/permission/${id}/reply`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body._tag).toBe('InvalidRequestError');
    }
    expect(bridge.permissions.listPending()).toHaveLength(1);
  });

  it('serves, updates and deletes the rules a reply of always saved', async () => {
    const { bridge, ask } = await start();
    void ask('ses_a', 'echo hi');
    await flush();
    const { id } = bridge.permissions.listPending()[0];
    await bridge.api('POST', `/api/session/ses_a/permission/${id}/reply`, { decision: 'always' });

    const listed = await bridge.api('GET', '/api/permission/saved');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([{ id: expect.stringMatching(/^psv_/), projectID: expect.stringMatching(/^[0-9a-f]{40}$/), action: 'shell', resource: 'echo *', time: { created: expect.any(Number), updated: expect.any(Number) } }]);
    const [saved] = listed.body.data;

    const patched = await bridge.api('PATCH', `/api/permission/saved/${saved.id}`, { resource: 'echo hi*' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ id: saved.id, action: 'shell', resource: 'echo hi*' });
    expect(patched.body.data.time.created).toBe(saved.time.created);

    expect((await bridge.api('PATCH', `/api/permission/saved/${saved.id}`, { resource: '' })).status).toBe(400);
    expect(await bridge.api('PATCH', '/api/permission/saved/psv_missing', { resource: 'x' })).toMatchObject({ status: 404, body: { _tag: 'PermissionNotFoundError' } });

    expect(await bridge.api('DELETE', `/api/permission/saved/${saved.id}`)).toEqual({ status: 204, body: null });
    expect(await bridge.api('DELETE', `/api/permission/saved/${saved.id}`)).toEqual({ status: 204, body: null });
    expect((await bridge.api('GET', '/api/permission/saved')).body).toEqual({ data: [] });
  });

  it('answers 409 when an update would duplicate another saved rule', async () => {
    const { bridge } = await start();
    const one = await bridge.store.add({ projectID: 'p', action: 'shell', resource: 'a *' });
    const two = await bridge.store.add({ projectID: 'p', action: 'shell', resource: 'b *' });
    const clash = await bridge.api('PATCH', `/api/permission/saved/${two.id}`, { resource: 'a *' });
    expect(clash.status).toBe(409);
    expect(clash.body._tag).toBe('ConflictError');
    expect(one.id).not.toBe(two.id);
  });
});

describe('form routes', () => {
  it('lists pending forms of a location and of a session, and reads one with its state', async () => {
    const { bridge, project, other, askForm } = await start();
    void askForm('ses_a');
    void askForm('ses_b', undefined, 'call_3');
    await flush();
    const [form] = bridge.forms.listPending({ sessionID: 'ses_a' });

    expect(await bridge.api('GET', '/api/form')).toEqual({ status: 200, body: { location: { directory: project }, data: [form] } });
    expect((await bridge.api('GET', '/api/form', undefined, other)).body.data.map((entry) => entry.sessionID)).toEqual(['ses_b']);
    expect(await bridge.api('GET', '/api/session/ses_a/form')).toEqual({ status: 200, body: { data: [form] } });
    expect(await bridge.api('GET', `/api/session/ses_a/form/${form.id}`)).toEqual({ status: 200, body: { data: { ...form, state: { status: 'pending' } } } });
    expect(await bridge.api('GET', '/api/session/ses_missing/form')).toMatchObject({ status: 404, body: { _tag: 'SessionNotFoundError' } });
    expect(await bridge.api('GET', '/api/session/ses_a/form/frm_unknown')).toMatchObject({ status: 404, body: { _tag: 'FormNotFoundError', id: 'frm_unknown' } });
  });

  it('refuses a wrong answer with 400, takes a right one with 204, and answers a second with 409', async () => {
    const { bridge, askForm } = await start();
    const outcome = askForm('ses_a');
    await flush();
    const { id } = bridge.forms.listPending()[0];
    const route = `/api/session/ses_a/form/${id}`;

    const invalid = await bridge.api('POST', `${route}/reply`, { answer: { q0: 12345 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ _tag: 'FormInvalidAnswerError', id, message: 'Expected string for form field: q0' });
    expect((await bridge.api('POST', `${route}/reply`, { answer: 'Red' })).status).toBe(400);
    expect((await bridge.api('POST', `${route}/reply`, {})).body._tag).toBe('InvalidRequestError');

    expect(await bridge.api('POST', `${route}/reply`, { answer: { q0: 'Purple' } })).toEqual({ status: 204, body: null });
    expect((await outcome).text).toContain('"Which color?"="Purple"');
    const again = await bridge.api('POST', `${route}/reply`, { answer: { q0: 'Blue' } });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ _tag: 'FormAlreadySettledError', id, message: `Form already settled: ${id}` });
    expect((await bridge.api('GET', route)).body.data.state).toEqual({ status: 'answered', answer: { q0: 'Purple' } });
  });

  it('cancels with 204, optionally with a message, and answers a second cancel with 409', async () => {
    const { bridge, askForm } = await start();
    const outcome = askForm('ses_a');
    await flush();
    const { id } = bridge.forms.listPending()[0];
    expect(await bridge.api('DELETE', `/api/session/ses_a/form/${id}?message=${encodeURIComponent('Not now')}`)).toEqual({ status: 204, body: null });
    expect(await outcome).toEqual({ status: 'dismissed', message: 'Not now' });
    expect((await bridge.api('DELETE', `/api/session/ses_a/form/${id}`)).status).toBe(409);
    expect((await bridge.api('GET', `/api/session/ses_a/form/${id}`)).body.data.state).toEqual({ status: 'cancelled', message: 'Not now' });
    expect(bridge.eventTypes()).toEqual(['form.created', 'form.cancelled']);
  });
});
