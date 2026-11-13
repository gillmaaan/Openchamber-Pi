// A bridge for the gate tests: the real event hub, permission and form
// managers, API routes and callback routes on one loopback listener, with
// the session lookups the coordinator will supply replaced by a table.
//
// The transport (`bridge/http.js`) checks Basic auth on every request, and a
// Pi child calls back with a bearer token. A route with `bypassBasicAuth` is
// served by `callbackFront` below, which does for those routes what the
// transport is meant to do once it honors the flag; everything else goes to the
// real transport.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createFormManager } from '../bridge/forms.js';
import { sessionNotFound, WireError } from '../bridge/errors.js';
import { createEventHub } from '../bridge/hub.js';
import { createBridgeHttpServer } from '../bridge/http.js';
import { createPermissionManager, createSavedPermissionStore } from '../bridge/permissions.js';
import { createFormRoutes } from '../bridge/routes/forms.js';
import { createPermissionRoutes } from '../bridge/routes/permissions.js';
import { createChildTokens, createPiCallbackRoutes } from '../bridge/routes/pi-callback.js';

export const PASSWORD = 'gate-test-password';
const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

/** The default agent of OpenCode 2.2.6, as golden 02 serves it. */
export const BUILD_AGENT_RULES = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
  { action: 'question', resource: '*', effect: 'allow' },
  { action: 'browser', resource: '*', effect: 'deny' },
  { action: 'skill', resource: 'browser', effect: 'deny' },
];

const callbackFront = (callbackRoutes, bridgeServer) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://bridge.local');
  const route = callbackRoutes.find((candidate) => candidate.bypassBasicAuth && candidate.method === req.method && candidate.path === url.pathname);
  if (!route) {
    bridgeServer.emit('request', req, res);
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      const result = await route.handler({ req, res, params: {}, query: url.searchParams, directory: null, body: async () => (text.trim() === '' ? {} : JSON.parse(text)) });
      send(result.status, result.body);
    } catch (error) {
      if (error instanceof WireError) send(error.status, error.toBody());
      else send(500, { _tag: 'UnknownError', message: String(error?.message ?? error) });
    }
  });
});

/**
 * @param {object} options
 * @param {Record<string, { directory: string, agentRules?: Array, sessionRules?: Array }>} options.sessions  Mutable: a test changes rules by editing it.
 * @param {string} options.defaultDirectory
 */
export const startGateBridge = async ({ sessions, defaultDirectory }) => {
  const storeDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-gate-bridge-'));
  const hub = createEventHub({ heartbeatMs: 0 });
  /** Every event the managers published, in order. */
  const events = [];
  const recordingHub = { emit: (event) => { const sent = hub.emit(event); events.push(sent); return sent; } };
  /** Every source lookup the managers made. */
  const lookups = [];
  const resolveSource = (sessionID, toolCallId) => {
    lookups.push({ sessionID, toolCallId });
    return { messageID: `msg_for_${toolCallId.replace(/\W/g, '_')}` };
  };
  const getContext = (sessionID) => sessions[sessionID] ?? null;

  const store = createSavedPermissionStore({ filePath: path.join(storeDirectory, 'permissions.json') });
  const permissions = createPermissionManager({ hub: recordingHub, getContext, resolveSource, store });
  const forms = createFormManager({ hub: recordingHub, getContext, resolveSource });
  const tokens = createChildTokens();

  const requireSession = (sessionID) => {
    if (!sessions[sessionID]) throw sessionNotFound(sessionID);
  };
  const apiRoutes = [
    ...createPermissionRoutes({ permissions, store, getDefaultDirectory: () => defaultDirectory, requireSession }),
    ...createFormRoutes({ forms, getDefaultDirectory: () => defaultDirectory, requireSession }),
  ];
  const callbackRoutes = createPiCallbackRoutes({ tokens, permissions, forms });
  const bridge = createBridgeHttpServer({ password: PASSWORD, routes: apiRoutes });
  const front = callbackFront(callbackRoutes, bridge.server);
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${front.address().port}`;

  /** A request the way the UI makes it: Basic auth and the project folder. */
  const api = async (method, route, body, directory = defaultDirectory) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        authorization: BASIC,
        'x-opencode-directory': encodeURIComponent(directory),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    url,
    hub,
    events,
    lookups,
    store,
    permissions,
    forms,
    tokens,
    api,
    eventTypes: () => events.map((event) => event.type),
    close: async () => {
      hub.close();
      await new Promise((resolve) => { front.closeAllConnections?.(); front.close(resolve); });
      fs.rmSync(storeDirectory, { recursive: true, force: true });
    },
  };
};
