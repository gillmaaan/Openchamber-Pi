// The callback a Pi child makes into the bridge: the bearer token check, the
// body check, and what happens to a held request when the child hangs up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PASSWORD, startGateBridge } from '../../test-support/gate-bridge.js';
import { createChildTokens } from './pi-callback.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const ASK_SHELL = [{ action: 'shell', resource: '*', effect: 'ask' }];

const start = async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-callback-')));
  cleanups.push(() => fs.rmSync(project, { recursive: true, force: true }));
  const sessions = { ses_a: { directory: project, agentRules: [], sessionRules: ASK_SHELL }, ses_b: { directory: project, agentRules: [], sessionRules: ASK_SHELL } };
  const bridge = await startGateBridge({ sessions, defaultDirectory: project });
  cleanups.push(() => bridge.close());
  const token = bridge.tokens.issue('ses_a');
  const post = (route, body, headers = { authorization: `Bearer ${token}` }, signal) => fetch(`${bridge.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const permission = (extra = {}) => ({ sessionID: 'ses_a', toolCallId: 'call_1', tool: 'bash', input: { command: 'echo hi' }, ...extra });
  return { bridge, token, post, permission, sessions };
};

describe('child tokens', () => {
  it('names the session of a token, until it is revoked', () => {
    const tokens = createChildTokens();
    const one = tokens.issue('ses_a');
    const two = tokens.issue('ses_a');
    const other = tokens.issue('ses_b');
    expect(new Set([one, two, other]).size).toBe(3);
    expect(one.length).toBeGreaterThanOrEqual(40);
    expect(tokens.verify(one)).toBe('ses_a');
    expect(tokens.verify(other)).toBe('ses_b');
    expect(tokens.verify('nope')).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    tokens.revoke('ses_a');
    expect(tokens.verify(one)).toBeNull();
    expect(tokens.verify(two)).toBeNull();
    expect(tokens.verify(other)).toBe('ses_b');
  });
});

describe('the callback routes', () => {
  it.each(['/_pi/permission', '/_pi/form'])('answer 401 to %s without the child\'s token', async (route) => {
    const { bridge, post, permission } = await start();
    const basic = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer ' }, { authorization: 'wrong' }, { authorization: basic }]) {
      const response = await post(route, permission(), headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await response.json()).toEqual({ _tag: 'UnauthorizedError', message: 'Authentication required' });
    }
    expect(bridge.permissions.listPending()).toEqual([]);
    expect(bridge.events).toEqual([]);
  });

  it('answer 401 once the child\'s token is revoked', async () => {
    const { bridge, post, permission, token } = await start();
    bridge.tokens.revoke('ses_a');
    expect((await post('/_pi/permission', permission(), { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('are not reachable with the Basic password of /api, and /api is not reachable with a token', async () => {
    const { bridge, token } = await start();
    const response = await fetch(`${bridge.url}/api/permission/saved`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
  });

  it('answer 403 for a session the token does not belong to', async () => {
    const { bridge, post, permission } = await start();
    const response = await post('/_pi/permission', permission({ sessionID: 'ses_b' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ _tag: 'ForbiddenError' });
    expect(bridge.events).toEqual([]);
  });

  it('answer 400 for a body that does not name its call', async () => {
    const { post, permission } = await start();
    for (const body of [{}, permission({ toolCallId: '' }), permission({ tool: undefined }), { ...permission(), action: 'shell', resources: [] }, { ...permission(), action: 'shell', resources: [1] }]) {
      const response = await post('/_pi/permission', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json())._tag).toBe('InvalidRequestError');
    }
    expect((await post('/_pi/form', { sessionID: 'ses_a', toolCallId: 'call_1', questions: [] })).status).toBe(400);
  });

  it('answer 404 for a session the bridge no longer knows', async () => {
    const { bridge, post, permission } = await start();
    const token = bridge.tokens.issue('ses_gone');
    const response = await post('/_pi/permission', permission({ sessionID: 'ses_gone' }), { authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
    expect((await response.json())._tag).toBe('SessionNotFoundError');
  });

  it('answer a call the rules allow at once, and one they deny with the reason', async () => {
    const { bridge, post, permission, sessions } = await start();
    sessions.ses_a.agentRules = [{ action: '*', resource: '*', effect: 'allow' }];
    sessions.ses_a.sessionRules = [{ action: 'shell', resource: 'rm *', effect: 'deny' }];

    const allowed = await post('/_pi/permission', permission());
    expect(await allowed.json()).toEqual({ allowed: true });
    const denied = await post('/_pi/permission', permission({ toolCallId: 'call_2', input: { command: 'rm -rf x' } }));
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ allowed: false, message: expect.stringContaining('prevents you from using this specific tool call') });
    expect(bridge.events).toEqual([]);
  });

  it('hold a request until the user replies through /api', async () => {
    const { bridge, post, permission } = await start();
    const response = post('/_pi/permission', permission());
    await flush();
    const [request] = bridge.permissions.listPending();
    expect(request).toMatchObject({ sessionID: 'ses_a', action: 'shell', resources: ['echo hi'], save: ['echo *'], source: { type: 'tool', id: 'call_1' } });

    await bridge.api('POST', `/api/session/ses_a/permission/${request.id}/reply`, { decision: 'reject', message: 'No thanks' });
    expect(await (await response).json()).toEqual({ allowed: false, message: 'No thanks' });
    expect(bridge.eventTypes()).toEqual(['permission.asked', 'permission.replied']);
  });

  it('drop a held request when the child hangs up, with no permission.replied', async () => {
    const { bridge, post, permission } = await start();
    const hangUp = new AbortController();
    const held = post('/_pi/permission', permission(), undefined, hangUp.signal).catch((error) => error.name);
    await flush();
    expect(bridge.permissions.listPending()).toHaveLength(1);

    hangUp.abort();
    expect(await held).toBe('AbortError');
    await flush();
    expect(bridge.permissions.listPending()).toEqual([]);
    expect(bridge.eventTypes()).toEqual(['permission.asked']);
  });

  it('carry a secret.run style request that names its own action and resources', async () => {
    const { bridge, post, permission } = await start();
    const answer = post('/_pi/permission', { ...permission({ tool: 'openchamber_secret', input: {} }), action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'] });
    await flush();
    expect(bridge.permissions.listPending()[0]).toMatchObject({ action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'] });
    await bridge.api('POST', `/api/session/ses_a/permission/${bridge.permissions.listPending()[0].id}/reply`, { decision: 'once' });
    expect(await (await answer).json()).toEqual({ allowed: true });
  });

  it('hold a question until it is answered, and say so when it was dismissed', async () => {
    const { bridge, post } = await start();
    const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }] }];
    const answered = post('/_pi/form', { sessionID: 'ses_a', toolCallId: 'call_2', questions });
    await flush();
    const [form] = bridge.forms.listPending();
    expect(form.metadata).toEqual({ kind: 'question', tool: { messageID: expect.any(String), id: 'call_2' } });
    await bridge.api('POST', `/api/session/ses_a/form/${form.id}/reply`, { answer: { q0: 'Red' } });
    expect(await (await answered).json()).toMatchObject({ status: 'answered', answers: [['Red']], text: expect.stringContaining('"Which color?"="Red"') });

    const dismissed = post('/_pi/form', { sessionID: 'ses_a', toolCallId: 'call_3', questions });
    await flush();
    await bridge.api('DELETE', `/api/session/ses_a/form/${bridge.forms.listPending()[0].id}`);
    expect(await (await dismissed).json()).toEqual({ status: 'dismissed', message: 'The user dismissed this question' });
  });

  it('drop a held question when the child hangs up and tell clients to remove the card', async () => {
    const { bridge, post } = await start();
    const hangUp = new AbortController();
    const held = post('/_pi/form', { sessionID: 'ses_a', toolCallId: 'call_2', questions: [{ question: 'Q?', header: 'Q', options: [] }] }, undefined, hangUp.signal).catch((error) => error.name);
    await flush();
    expect(bridge.forms.listPending()).toHaveLength(1);
    hangUp.abort();
    await held;
    await flush();
    expect(bridge.forms.listPending()).toEqual([]);
    expect(bridge.eventTypes()).toEqual(['form.created', 'form.cancelled']);
  });
});
