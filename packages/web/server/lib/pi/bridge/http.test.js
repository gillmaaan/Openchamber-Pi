import { afterEach, describe, expect, it } from 'vitest';

import { invalidRequest, sessionNotFound } from './errors.js';
import { createEventHub } from './hub.js';
import { createBridgeHttpServer, json, noContent, STREAMED } from './http.js';

const PASSWORD = 'correct horse';
const auth = (password = PASSWORD) => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const open = [];
const start = async (routes, options = {}) => {
  const bridge = createBridgeHttpServer({ password: PASSWORD, routes, ...options });
  const address = await bridge.listen();
  open.push(bridge);
  return { base: `http://127.0.0.1:${address.port}`, bridge };
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((bridge) => bridge.close()));
});

describe('bridge http transport', () => {
  it('answers 401 with a tagged JSON body without or with a wrong password', async () => {
    const { base } = await start([{ method: 'GET', path: '/api/info', handler: () => json({ ok: true }) }]);

    for (const headers of [{}, { authorization: auth('wrong') }, { authorization: 'Bearer x' }]) {
      const response = await fetch(`${base}/api/info`, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ _tag: 'UnauthorizedError', message: 'Authentication required' });
    }
    expect((await fetch(`${base}/api/info`, { headers: { authorization: auth() } })).status).toBe(200);
  });

  it('lets a route that checks its own credential skip Basic auth, and keeps 401 before 404 for the rest', async () => {
    const { base } = await start([
      { method: 'POST', path: '/_pi/permission', bypassBasicAuth: true, handler: (ctx) => json({ bearer: ctx.req.headers.authorization ?? null }) },
      { method: 'GET', path: '/api/info', handler: () => json({}) },
    ]);
    const own = await fetch(`${base}/_pi/permission`, { method: 'POST', headers: { authorization: 'Bearer child-token' } });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ bearer: 'Bearer child-token' });

    expect((await fetch(`${base}/api/info`)).status).toBe(401);
    expect((await fetch(`${base}/_pi/unknown`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/_pi/unknown`, { method: 'POST', headers: { authorization: auth() } })).status).toBe(404);
  });

  it('answers an unknown route with a bare 404', async () => {
    const { base } = await start([]);
    const response = await fetch(`${base}/api/nope`, { headers: { authorization: auth() } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('sends a 204 with no body and no content type', async () => {
    const { base } = await start([{ method: 'POST', path: '/api/x', handler: () => noContent() }]);
    const response = await fetch(`${base}/api/x`, { method: 'POST', headers: { authorization: auth() } });
    expect(response.status).toBe(204);
    expect(response.headers.get('content-type')).toBeNull();
  });

  it('maps a thrown wire error to its status and tagged body', async () => {
    const { base } = await start([{ method: 'GET', path: '/api/session/:sessionID', handler: ({ params }) => { throw sessionNotFound(params.sessionID); } }]);
    const response = await fetch(`${base}/api/session/ses_x`, { headers: { authorization: auth() } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ _tag: 'SessionNotFoundError', sessionID: 'ses_x', message: 'Session not found: ses_x' });
  });

  it('sends the headers a handler adds to a JSON answer', async () => {
    const { base } = await start([{ method: 'GET', path: '/api/secret', handler: () => json({ ok: true }, 200, { 'cache-control': 'no-store' }) }]);
    const response = await fetch(`${base}/api/secret`, { headers: { authorization: auth() } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('hides an unexpected error behind a 500 with a reference and reports it', async () => {
    const reported = [];
    const { base } = await start(
      [{ method: 'GET', path: '/api/boom', handler: () => { throw new Error('secret detail'); } }],
      { onError: (error, ref) => reported.push({ message: error.message, ref }) },
    );
    const response = await fetch(`${base}/api/boom`, { headers: { authorization: auth() } });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ _tag: 'UnknownError', message: 'Internal error' });
    expect(JSON.stringify(body)).not.toContain('secret detail');
    expect(reported).toEqual([{ message: 'secret detail', ref: body.ref }]);
  });

  it('reads params, repeated query values and a JSON body', async () => {
    let seen;
    const { base } = await start([{
      method: 'POST',
      path: '/api/session/:sessionID/prompt',
      handler: async (ctx) => {
        seen = { params: ctx.params, types: ctx.query.getAll('types'), body: await ctx.body() };
        return json({ ok: true });
      },
    }]);
    await fetch(`${base}/api/session/ses_a%20b/prompt?types=chat&types=image`, {
      method: 'POST',
      headers: { authorization: auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(seen).toEqual({ params: { sessionID: 'ses_a b' }, types: ['chat', 'image'], body: { text: 'hi' } });
  });

  it('answers 400 for a body that is not JSON', async () => {
    const { base } = await start([{ method: 'POST', path: '/api/x', handler: async (ctx) => { await ctx.body(); return noContent(); } }]);
    const response = await fetch(`${base}/api/x`, { method: 'POST', headers: { authorization: auth() }, body: '{nope' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ _tag: 'InvalidRequestError', message: 'Expected a valid JSON body', kind: 'Payload' });
  });

  it('treats an empty body as an empty object', async () => {
    let body;
    const { base } = await start([{ method: 'POST', path: '/api/x', handler: async (ctx) => { body = await ctx.body(); return noContent(); } }]);
    await fetch(`${base}/api/x`, { method: 'POST', headers: { authorization: auth() } });
    expect(body).toEqual({});
  });

  it('takes the directory from the percent-encoded header or from location[directory]', async () => {
    const directories = [];
    const { base } = await start([{ method: 'GET', path: '/api/location', handler: (ctx) => { directories.push(ctx.directory); return json({}); } }]);
    await fetch(`${base}/api/location`, { headers: { authorization: auth(), 'x-opencode-directory': encodeURIComponent('/work/my proj') } });
    await fetch(`${base}/api/location?location%5Bdirectory%5D=${encodeURIComponent('/other')}`, { headers: { authorization: auth() } });
    await fetch(`${base}/api/location?directory=${encodeURIComponent('/ignored')}`, { headers: { authorization: auth() } });
    expect(directories).toEqual(['/work/my proj', '/other', null]);
  });

  it('lets a handler raise a validation error from its own code', async () => {
    const { base } = await start([{ method: 'GET', path: '/api/x', handler: () => { throw invalidRequest('bad', { kind: 'Query' }); } }]);
    const response = await fetch(`${base}/api/x`, { headers: { authorization: auth() } });
    expect(await response.json()).toEqual({ _tag: 'InvalidRequestError', message: 'bad', kind: 'Query' });
  });
});

describe('event stream through the hub', () => {
  const readFrames = async (response, count) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while ((text.match(/\n\n/g) ?? []).length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return text;
  };

  it('opens with server.connected and a heartbeat, then carries only later events', async () => {
    let mint = 0;
    const hub = createEventHub({ mintId: () => `evt_${String(++mint).padStart(3, '0')}`, now: () => 42, heartbeatMs: 0 });
    const { base } = await start([{ method: 'GET', path: '/api/event', handler: ({ res, query }) => { hub.subscribe(res, { types: query.getAll('types') }); return STREAMED; } }]);

    hub.emit({ type: 'session.created', data: { sessionID: 'before' } });
    const response = await fetch(`${base}/api/event`, { headers: { authorization: auth() } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    setTimeout(() => hub.emit({ type: 'session.renamed', data: { sessionID: 'ses_1', title: 'T' }, location: { directory: '/p' } }), 20);

    const text = await readFrames(response, 3);
    const frames = text.split('\n\n').filter(Boolean);
    expect(frames[0]).toBe('data: {"id":"evt_002","type":"server.connected","data":{}}');
    expect(frames[1]).toBe(': heartbeat');
    expect(JSON.parse(frames[2].slice(6))).toEqual({ id: 'evt_003', created: 42, type: 'session.renamed', location: { directory: '/p' }, data: { sessionID: 'ses_1', title: 'T' } });
  });

  it('keeps only the requested types plus server.connected', async () => {
    const hub = createEventHub({ heartbeatMs: 0 });
    const { base } = await start([{ method: 'GET', path: '/api/event', handler: ({ res, query }) => { hub.subscribe(res, { types: query.getAll('types') }); return STREAMED; } }]);
    const response = await fetch(`${base}/api/event?types=session.renamed`, { headers: { authorization: auth() } });
    setTimeout(() => {
      hub.emit({ type: 'session.created', data: {} });
      hub.emit({ type: 'session.renamed', data: { title: 'kept' } });
    }, 20);
    const text = await readFrames(response, 3);
    expect(text).toContain('server.connected');
    expect(text).toContain('"title":"kept"');
    expect(text).not.toContain('session.created');
  });

  it('beats a heartbeat into every open stream and stops when the last closes', async () => {
    const ticks = [];
    let handler;
    const hub = createEventHub({
      heartbeatMs: 15_000,
      setIntervalImpl: (fn) => { handler = fn; ticks.push('start'); return { unref() {} }; },
      clearIntervalImpl: () => ticks.push('stop'),
    });
    const { base } = await start([{ method: 'GET', path: '/api/event', handler: ({ res }) => { hub.subscribe(res); return STREAMED; } }]);
    const response = await fetch(`${base}/api/event`, { headers: { authorization: auth() } });
    setTimeout(() => handler(), 20);
    const text = await readFrames(response, 3);
    expect(text.match(/: heartbeat/g)).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.size).toBe(0);
    expect(ticks).toEqual(['start', 'stop']);
  });
});
