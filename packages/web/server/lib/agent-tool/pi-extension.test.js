import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WORKFLOW_ANSWER_TOOL } from '../openchamber-control/actions.js';
import { RENDER_PAGE_CLOSED_IN_CHAT_NOTE } from '../openchamber-control/render-page.js';
import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../pi/launch.js';
import { createPiRpcClient } from '../pi/rpc-client.js';
import { startMockOpenAi } from '../pi/test-support/mock-openai.js';
import { createPiFixture } from '../pi/test-support/pi-fixture.js';
import { createPiManagedToolsExtensionSource } from './pi-extension.js';
import { createAgentToolRuntime } from './runtime.js';

const FLAGS = ['includeControl', 'includeSchedule', 'includeWeb', 'includeMemory', 'includeKnowledge', 'includeNotify', 'includeRender', 'includeImage', 'includeSecret', 'includeUsage', 'includeWorkflow'];
const flagsOf = (...on) => Object.fromEntries(FLAGS.map((flag) => [flag, on.includes(flag)]));
const ALL_ON = flagsOf(...FLAGS);

const DIRECT_TOOLS = ['openchamber', 'openchamber_schedule', 'openchamber_web', 'openchamber_memory', 'openchamber_knowledge', 'openchamber_notify', 'openchamber_render', 'openchamber_secret', 'openchamber_image', 'openchamber_usage', 'openchamber_workflow', WORKFLOW_ANSWER_TOOL];

const temporaryDirectories = [];
const makeTempDir = (prefix) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  temporaryDirectories.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const waitFor = async (predicate, { timeoutMs = 15_000, message = 'condition not met' } = {}) => {
  const startedAt = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Writes the generated extension to a file and returns its path. */
const writeExtension = (directory, options, name = 'openchamber-managed-tools.js') => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, createPiManagedToolsExtensionSource(options));
  return file;
};

let importCounter = 0;
/** Loads a generated extension against a fake `pi` and returns what it registered. */
const loadExtension = async (options, { activeTools = ['read', 'bash'] } = {}) => {
  const directory = makeTempDir('oc-pi-ext-unit-');
  const file = writeExtension(directory, options, 'extension.mjs');
  const module = await import(`${pathToFileURL(file).href}?load=${importCounter += 1}`);
  const tools = {};
  const handlers = {};
  const state = { active: [...activeTools] };
  module.default({
    registerTool: (tool) => { tools[tool.name] = tool; },
    on: (event, handler) => { handlers[event] = handler; },
    getActiveTools: () => [...state.active],
    setActiveTools: (names) => { state.active = [...names]; },
  });
  return { tools, handlers, state, source: fs.readFileSync(file, 'utf8') };
};

/** Loads the OpenCode plugin the same options produce, for comparison. */
const loadOpenCodePlugin = async (options, context = {}) => {
  const dataDir = makeTempDir('oc-pi-ext-plugin-');
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises,
    path,
    instanceDir: dataDir,
    getActivePort: () => 3901,
    executeAction: async () => ({}),
  });
  const directory = await runtime.materializePlugin(options);
  const module = await import(`${pathToFileURL(path.join(directory, 'index.js')).href}?plugin=${importCounter += 1}`);
  const tools = {};
  const namespaces = {};
  await module.default.setup({
    ...context,
    tool: {
      transform: (edit) => edit({
        add: (tool) => { tools[tool.name] = tool; },
        remove: () => {},
        namespace: (namespace) => { namespaces[namespace.name] = namespace.description; },
      }),
    },
    session: { hook: async () => {} },
  });
  return { tools, namespaces };
};

/** An HTTP stub that plays `/api/openchamber/agent-tool`. */
const startToolStub = async () => {
  const calls = [];
  let respond = (call) => ({ schemaVersion: 1, ok: true, action: call.input.action, data: { stub: true } });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const call = { authorization: req.headers.authorization, method: req.method, url: req.url, ...JSON.parse(body), aborted: false };
      calls.push(call);
      res.on('close', () => { if (!res.writableFinished) call.aborted = true; });
      const answer = await respond(call);
      if (call.aborted) return;
      res.setHeader('content-type', 'application/json');
      res.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`,
    respondWith: (handler) => { respond = handler; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
};

const withEnv = (values) => {
  const saved = {};
  const apply = () => {
    for (const [name, value] of Object.entries(values)) {
      saved[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  return { apply, restore };
};

describe('the generated Pi extension', () => {
  it('registers every tool direct, and the answer tool inactive', async () => {
    const { tools } = await loadExtension(ALL_ON);
    expect(Object.keys(tools)).toEqual(['openchamber', 'openchamber_schedule', 'openchamber_web', 'openchamber_memory', 'openchamber_knowledge', 'openchamber_notify', 'openchamber_render', 'openchamber_secret', 'openchamber_image', 'openchamber_usage', 'openchamber_workflow', WORKFLOW_ANSWER_TOOL]);
    for (const name of DIRECT_TOOLS) expect(tools[name].exposure, name).toBe('direct');
    expect(Object.values(tools).filter((tool) => tool.namespace)).toEqual([]);
    // Only the session of a workflow agent declares the answer tool.
    expect(tools[WORKFLOW_ANSWER_TOOL].defaultActive).toBe(false);
    expect(Object.values(tools).filter((tool) => tool.defaultActive === false)).toHaveLength(1);
  });

  it.each([
    ['all tools', ALL_ON],
    ['no tool', flagsOf()],
    ...FLAGS.map((flag) => [flag, flagsOf(flag)]),
  ])('declares what the OpenCode plugin declares: %s', async (_label, options) => {
    const pi = await loadExtension(options);
    const hasTools = FLAGS.some((flag) => options[flag]);
    if (!hasTools) {
      expect(pi.tools).toEqual({});
      expect(pi.handlers).toEqual({});
      return;
    }
    const plugin = await loadOpenCodePlugin(options);
    expect(Object.keys(pi.tools)).toEqual(Object.keys(plugin.tools));
    for (const [name, tool] of Object.entries(plugin.tools)) {
      const registered = pi.tools[name];
      expect(registered.description, name).toBe(tool.description);
      expect(registered.parameters, name).toEqual(tool.input);
      expect(registered.exposure, name).toBe(tool.options.codemode ? 'codemode' : 'direct');
      expect(registered.namespace?.description, name).toBe(plugin.namespaces[name]);
      expect(registered.namespace === undefined || registered.namespace.name === name, name).toBe(true);
    }
    expect(Object.keys(plugin.namespaces).sort()).toEqual(Object.values(pi.tools).filter((tool) => tool.namespace).map((tool) => tool.name).sort());
  });

  it('resolves a bare action inside the tool that was called, like the server does', async () => {
    const { tools } = await loadExtension(ALL_ON);
    const prepare = (name, action) => tools[name].prepareArguments({ action, parameters: { limit: 1 } });
    expect(prepare('openchamber_memory', 'read')).toEqual({ action: 'memory.read', parameters: { limit: 1 } });
    expect(prepare('openchamber_memory', ' memory.read ')).toEqual({ action: 'memory.read', parameters: { limit: 1 } });
    expect(prepare('openchamber_schedule', 'delete').action).toBe('schedule.delete');
    expect(prepare('openchamber_secret', 'forget').action).toBe('secret.forget');
    // Not a name of this tool, so it stays and Pi's schema check refuses it.
    expect(prepare('openchamber_memory', 'frobnicate').action).toBe('frobnicate');
    expect(prepare('openchamber_memory', 'schedule.delete').action).toBe('schedule.delete');
    // A tool with one action has no schema check on it to get past.
    expect(tools.openchamber_notify.prepareArguments).toBeUndefined();
  });

  it('wires the prompt handler only for tools that wait, and no codemode activation while no tool is behind it', async () => {
    const waiting = await loadExtension(flagsOf('includeRender'));
    expect(Object.keys(waiting.handlers)).toEqual(['input']);
    expect((await loadExtension(flagsOf('includeSecret'))).handlers.input).toBeTypeOf('function');
    expect(Object.keys((await loadExtension(flagsOf('includeNotify', 'includeImage', 'includeWorkflow'))).handlers)).toEqual([]);
    expect(Object.keys((await loadExtension(ALL_ON)).handlers)).toEqual(['input']);
  });

  it.each(['ses_a', '60ce5684-479d-4c53-835b-0da044ade175'])('ends the waits of the prompted session %s and no other', async (piSessionID) => {
    const pi = await loadExtension(flagsOf('includeRender'));
    const stub = await startToolStub();
    const env = withEnv({ OPENCHAMBER_AGENT_TOOL_URL: stub.url, OPENCHAMBER_AGENT_TOOL_TOKEN: 'tok' });
    env.apply();
    const ctxOf = (id) => ({ sessionManager: { getSessionId: () => id } });
    const ask = (id, awaitAnswer) => pi.tools.openchamber_render.execute('call', { action: 'render.page', parameters: { html: '<p/>', awaitAnswer } }, undefined, undefined, ctxOf(id));
    const calls = [];
    try {
      stub.respondWith(() => new Promise(() => {}));
      calls.push(ask(piSessionID, true), ask(piSessionID, false));
      await waitFor(() => stub.calls.length === 2);
      const wireID = piSessionID.startsWith('ses') ? piSessionID : `ses_${piSessionID}`;
      expect(stub.calls.map((call) => call.sessionID)).toEqual([wireID, wireID]);
      await pi.handlers.input({ text: 'hello' }, ctxOf('ses_b'));
      const result = await Promise.race([calls[0], new Promise((resolve) => setTimeout(resolve, 100, 'still waiting'))]);
      expect(result).toBe('still waiting');
      expect(await pi.handlers.input({ text: 'hello' }, ctxOf(piSessionID))).toEqual({ action: 'continue' });
      const closed = await calls[0];
      expect(JSON.parse(closed.content[0].text)).toEqual({ schemaVersion: 1, ok: true, action: 'render.page', data: { answer: { answered: false, reason: 'chat' }, note: RENDER_PAGE_CLOSED_IN_CHAT_NOTE } });
      expect(closed.details.openchamber).toEqual({ schemaVersion: 1, action: 'render.page', description: expect.any(String), ok: true, answer: { answered: false, reason: 'chat' } });
      // A call that only shows a page is not ended by a prompt.
      expect(stub.calls[1].aborted).toBe(false);
    } finally {
      env.restore();
      await stub.close();
      // The page that only shows was still open; closing the stub ends it.
      await Promise.all(calls);
    }
  });

  it('adds the callback host to NO_PROXY once, with the brackets of an IPv6 address removed', async () => {
    const env = withEnv({ OPENCHAMBER_AGENT_TOOL_URL: 'http://[::1]:3901/api/openchamber/agent-tool', NO_PROXY: 'example.com', no_proxy: undefined });
    env.apply();
    try {
      await loadExtension(flagsOf('includeNotify'));
      await loadExtension(flagsOf('includeNotify'));
      expect(process.env.NO_PROXY).toBe('example.com,::1');
      expect(process.env.no_proxy).toBe('::1');
    } finally {
      env.restore();
    }
  });

  describe('against a stub of the callback', () => {
    let stub;
    let env;
    beforeEach(async () => {
      stub = await startToolStub();
      env = withEnv({ OPENCHAMBER_AGENT_TOOL_URL: stub.url, OPENCHAMBER_AGENT_TOOL_TOKEN: 'tok' });
      env.apply();
    });
    afterEach(async () => {
      env.restore();
      delete globalThis.__openchamberPiPermission;
      await stub.close();
    });

    const piContext = { sessionManager: { getSessionId: () => 'ses_1' } };
    const runOnPi = async (pi, name, input) => pi.tools[name].execute('call_1', input, undefined, undefined, piContext);
    const runOnPlugin = async (plugin, name, input) => plugin.tools[name].execute(input, { sessionID: 'ses_1', id: 'call_1', progress: async () => {} });

    // Each row is what a model sent; Pi and OpenCode must hand the server the
    // same input, and answer the call the same way.
    const NORMALIZATION_CASES = [
      ['inputs beside the action', 'openchamber_web', { action: 'browser.open', url: 'https://example.test', submit: 'true' }],
      ['parameters winning over inputs beside the action', 'openchamber', { action: 'session.list', limit: 5, parameters: { limit: 7 } }],
      ['string booleans, and only those spellings', 'openchamber', { action: 'session.create', parameters: { goal: 'true', returnResult: 'false', all: 'yes', limit: 'true' } }],
      ['a link sent as a JSON string', 'openchamber', { action: 'session.link', parameters: { link: '{"url":"https://example.test/1","title":"One","kind":"issue"}' } }],
      ['a link that is not an object', 'openchamber', { action: 'session.link', parameters: { link: '["a"]' } }],
      ['a title that looks like JSON', 'openchamber', { action: 'session.create', parameters: { title: '{"a":1}', prompt: '[1]' } }],
      ['dependsOn sent as a JSON string', 'openchamber_knowledge', { action: 'knowledge.save', kind: 'todo', dependsOn: '["a","b"]' }],
      ['dependsOn that is not an array', 'openchamber_knowledge', { action: 'knowledge.save', kind: 'todo', dependsOn: '{"a":1}' }],
      ['a single-action call stuffed into the action', 'openchamber_notify', { action: '{"action":"notify.send","title":"Done","parameters":{"body":"All of it"}}', title: 'Kept' }],
      ['a single-action call with no action', 'openchamber_render', { html: '<p>Hi</p>', title: 'Page', awaitAnswer: 'false' }],
      ['the bare run of the secret tool', 'openchamber_secret', { action: 'run', parameters: { program: 'echo', args: ['hi'], reason: 'Test', inputs: [{ env: 'TOKEN', label: 'Token' }] } }],
      ['a schema-less workflow answer', WORKFLOW_ANSWER_TOOL, { action: 'workflow.answer', parameters: { answer: { value: 3 } } }],
    ];

    it.each(NORMALIZATION_CASES)('sends the server what OpenCode sends: %s', async (_label, name, input) => {
      const permissions = [];
      globalThis.__openchamberPiPermission = async (request) => { permissions.push(request); };
      const pi = await loadExtension(ALL_ON);
      const plugin = await loadOpenCodePlugin(ALL_ON, { permission: { assert: async (request) => { permissions.push(request); } } });

      const piResult = await runOnPi(pi, name, structuredClone(input));
      const pluginResult = await runOnPlugin(plugin, name, structuredClone(input));

      expect(stub.calls).toHaveLength(2);
      const [fromPi, fromPlugin] = stub.calls;
      expect(fromPi.input).toEqual(fromPlugin.input);
      expect(fromPi).toMatchObject({ authorization: 'Bearer tok', method: 'POST', sessionID: 'ses_1', callID: 'call_1', tool: name });
      expect(fromPlugin).toMatchObject({ sessionID: 'ses_1', callID: 'call_1', tool: name });
      expect(piResult.content[0].text).toBe(pluginResult.content);
      expect(piResult.details.openchamber).toEqual(pluginResult.metadata.openchamber);
      expect(piResult.isError).toBe(false);
      if (name === 'openchamber_secret') {
        // Both asked the user about the same command line.
        expect(permissions[0].resources).toEqual(permissions[1].resources);
        expect(permissions[0].save).toEqual(permissions[1].save);
      }
    });

    it('announces the call before and after it, with the shape of the result\'s details', async () => {
      const pi = await loadExtension(ALL_ON);
      const updates = [];
      const result = await pi.tools.openchamber_notify.execute('call_1', { action: 'notify.send', parameters: { title: 'Hi' } }, undefined, (update) => updates.push(update), piContext);
      expect(updates).toEqual([
        { content: [], details: { openchamber: { schemaVersion: 1, action: 'notify.send', description: 'Notify the user' } } },
        { content: [], details: { openchamber: { schemaVersion: 1, action: 'notify.send', description: 'Notify the user', ok: true } } },
      ]);
      expect(result.details).toEqual(updates[1].details);
    });

    it('returns an envelope that says ok: false as a normal result', async () => {
      const envelope = { schemaVersion: 1, ok: false, action: 'notify.send', error: { message: 'Title required', kind: 'usage' } };
      stub.respondWith(() => envelope);
      const pi = await loadExtension(ALL_ON);
      const result = await runOnPi(pi, 'openchamber_notify', { action: 'notify.send', parameters: {} });
      expect(JSON.parse(result.content[0].text)).toEqual(envelope);
      expect(result).toMatchObject({ isError: false, details: { openchamber: { ok: false } } });
    });

    it('turns a refused connection, a bad response and a missing connection into ok: false envelopes', async () => {
      const pi = await loadExtension(ALL_ON);
      const call = () => runOnPi(pi, 'openchamber_notify', { action: 'notify.send', parameters: { title: 'Hi' } });
      const envelopeOf = (result) => JSON.parse(result.content[0].text);

      stub.respondWith(() => '<html>proxy error</html>');
      const invalid = await call();
      expect(envelopeOf(invalid)).toMatchObject({ ok: false, action: 'notify.send', error: { message: 'OpenChamber returned an invalid response', kind: 'runtime', status: 200 } });
      expect(invalid.details.openchamber.ok).toBe(false);

      await stub.close();
      const refused = await call();
      expect(envelopeOf(refused)).toMatchObject({ ok: false, error: { kind: 'runtime' } });
      expect(refused).toMatchObject({ isError: false, details: { openchamber: { ok: false } } });

      delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      expect(envelopeOf(await call())).toMatchObject({ ok: false, error: { message: 'OpenChamber managed tool connection is unavailable' } });
      stub = await startToolStub();
    });

    it('does not call out for a call that cannot name its session', async () => {
      const pi = await loadExtension(ALL_ON);
      const result = await pi.tools.openchamber_notify.execute('call_1', { action: 'notify.send', parameters: {} }, undefined, undefined, {});
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: { kind: 'runtime' } });
      expect(stub.calls).toHaveLength(0);
    });

    describe('secret.run', () => {
      const run = { action: 'secret.run', parameters: { program: 'echo', args: ['hi'], inputs: [{ env: 'TOKEN', label: 'Token' }] } };

      it('is refused without a permission gate, and asks nothing of the server', async () => {
        const pi = await loadExtension(ALL_ON);
        const result = await runOnPi(pi, 'openchamber_secret', run);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, action: 'secret.run', error: { kind: 'runtime', message: expect.stringContaining('secret.request') } });
        expect(stub.calls).toHaveLength(0);
      });

      it('asks the gate for the command line, and lets a rejection end the call', async () => {
        const requests = [];
        let refuse = false;
        globalThis.__openchamberPiPermission = async (request) => {
          requests.push(request);
          if (refuse) throw new Error('The user rejected permission');
        };
        const pi = await loadExtension(ALL_ON);
        await runOnPi(pi, 'openchamber_secret', { ...run, parameters: { ...run.parameters, args: ['deploy', 'my worker'] } });
        expect(requests).toEqual([{ sessionID: 'ses_1', toolCallId: 'call_1', tool: 'openchamber_secret', action: 'shell', resources: ["echo deploy 'my worker'"], save: ['echo *'], signal: undefined }]);
        expect(stub.calls).toHaveLength(1);

        refuse = true;
        await expect(runOnPi(pi, 'openchamber_secret', run)).rejects.toThrow('rejected');
        expect(stub.calls).toHaveLength(1);
      });

      it('asks nothing for a malformed command, and nothing for the other secret actions', async () => {
        const requests = [];
        globalThis.__openchamberPiPermission = async (request) => { requests.push(request); };
        const pi = await loadExtension(ALL_ON);
        const malformed = await runOnPi(pi, 'openchamber_secret', { ...run, parameters: { ...run.parameters, args: 'deploy' } });
        expect(JSON.parse(malformed.content[0].text)).toMatchObject({ ok: false, error: { kind: 'usage' } });
        await runOnPi(pi, 'openchamber_secret', { action: 'secret.forget', parameters: {} });
        await runOnPi(pi, 'openchamber_secret', { action: 'secret.request', parameters: { label: 'Key', reason: 'Why' } });
        expect(requests).toEqual([]);
      });
    });
  });
});

describe('the generated Pi extension against the server route', () => {
  it('reaches the control service with the Pi session, and the service resolves its directory', async () => {
    const executed = [];
    const resolvedFor = [];
    const runtime = createAgentToolRuntime({
      crypto,
      fsPromises,
      path,
      instanceDir: makeTempDir('oc-pi-ext-server-'),
      getActivePort: () => 3901,
      executeAction: async (action, input, directory, options) => {
        executed.push({ action, input, directory, options });
        return { sessions: [] };
      },
      resolveSessionDirectory: async (sessionId) => { resolvedFor.push(sessionId); return '/repo'; },
    });
    const { OPENCHAMBER_AGENT_TOOL_TOKEN: token } = runtime.createChildEnv();
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const env = withEnv({ OPENCHAMBER_AGENT_TOOL_URL: `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`, OPENCHAMBER_AGENT_TOOL_TOKEN: token });
    env.apply();
    try {
      const pi = await loadExtension(ALL_ON);
      globalThis.__openchamberPiPermission = async () => {};
      const ctx = { sessionManager: { getSessionId: () => 'ses_pi' } };
      const listed = await pi.tools.openchamber.execute('call_a', { action: 'session.list', limit: 3, parameters: { busy: 'true' } }, undefined, undefined, ctx);
      expect(JSON.parse(listed.content[0].text)).toEqual({ schemaVersion: 1, ok: true, action: 'session.list', data: { sessions: [] } });
      expect(executed[0]).toMatchObject({ action: 'session.list', input: { action: 'session.list', limit: 3, busy: true }, directory: '/repo', options: { contextSessionId: 'ses_pi', contextCallId: 'call_a' } });
      expect(resolvedFor).toEqual(['ses_pi']);

      await pi.tools.openchamber_secret.execute('call_b', { action: 'run', parameters: { program: 'echo', inputs: [{ env: 'TOKEN', label: 'Token' }] } }, undefined, undefined, ctx);
      expect(executed[1]).toMatchObject({ action: 'secret.run', options: { secretRunAuthorized: true, contextSessionId: 'ses_pi' } });

      // The route refuses a call without the child's token, which the tool reports as its failure.
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'not-the-token';
      const refused = await pi.tools.openchamber.execute('call_c', { action: 'session.list', parameters: {} }, undefined, undefined, ctx);
      expect(JSON.parse(refused.content[0].text)).toMatchObject({ ok: false, error: { message: 'OpenChamber returned an invalid response', status: 401 } });
    } finally {
      env.restore();
      delete globalThis.__openchamberPiPermission;
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    }
  });
});

describe('the generated Pi extension in a real Pi', () => {
  const TOKEN = 'test-bearer-token';
  let mock;
  let fixture;
  let stub;
  const clients = [];

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  beforeEach(async () => {
    stub = await startToolStub();
    mock.requests.length = 0;
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => { client.kill('SIGKILL'); await client.exited; }));
    await stub.close();
  });

  const toolMessage = (name, args) => `TOOL:${name}:${JSON.stringify(args)}`;
  let sessionCounter = 0;

  const startPi = ({ options = ALL_ON, extensions = [], extraArgs = [], env = {}, piFixture = fixture, endpoint = stub.url } = {}) => {
    sessionCounter += 1;
    const sessionId = `ses_managed_${sessionCounter}`;
    const extension = writeExtension(makeTempDir('oc-pi-ext-real-'), options);
    const events = [];
    const uiRequests = [];
    const stderr = [];
    const runtime = resolvePiRuntime();
    const client = createPiRpcClient({
      command: runtime.command,
      args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId, extensions: [extension, ...extensions] }), ...extraArgs],
      cwd: piFixture.project,
      env: { ...piFixture.env, ...runtime.env, OPENCHAMBER_AGENT_TOOL_URL: endpoint, OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN, ...env },
      onEvent: (event) => events.push(event),
      onUiRequest: (request) => uiRequests.push(request),
      onStderr: (chunk) => stderr.push(chunk),
    });
    clients.push(client);
    const toolEnd = (toolName) => events.find((event) => event.type === 'tool_execution_end' && event.toolName === toolName);
    const settled = () => events.find((event) => event.type === 'agent_settled');
    return { client, events, sessionId, stderr, uiRequests, toolEnd, settled };
  };

  const ok = (call, data = { stub: true }) => ({ schemaVersion: 1, ok: true, action: call.input.action, data });

  it('delivers a direct tool call to the callback and the envelope back as the tool result', async () => {
    const pi = startPi();
    stub.respondWith((call) => ok(call, { page: 'drawn' }));
    await pi.client.request('prompt', { message: toolMessage('openchamber_render', { action: 'render.page', parameters: { html: '<p>Hi</p>', title: 'Greeting' } }) });
    await waitFor(() => pi.settled(), { message: 'turn did not settle' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      method: 'POST',
      input: { action: 'render.page', html: '<p>Hi</p>', title: 'Greeting' },
      sessionID: pi.sessionId,
      callID: 'call_directive',
      tool: 'openchamber_render',
    });

    const end = pi.toolEnd('openchamber_render');
    const envelope = { schemaVersion: 1, ok: true, action: 'render.page', data: { page: 'drawn' } };
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.result.content[0].text)).toEqual(envelope);
    expect(end.result.details.openchamber).toMatchObject({ schemaVersion: 1, action: 'render.page', ok: true, description: expect.any(String) });
    expect(end.result.details.openchamber.answer).toBeUndefined();

    // Progress went out before the call and again once it finished.
    const updates = pi.events.filter((event) => event.type === 'tool_execution_update' && event.toolName === 'openchamber_render');
    expect(updates.map((event) => event.partialResult.details.openchamber.ok)).toEqual([undefined, true]);

    // The model reads the same envelope.
    const toolMessageSeen = mock.requests.at(-1).messages.find((message) => message.role === 'tool');
    expect(JSON.parse(toolMessageSeen.content)).toEqual(envelope);
  });

  it('declares every tool under its own name, the answer tool aside, and no codemode of its own', async () => {
    const pi = startPi();
    await pi.client.request('prompt', { message: 'PLAIN please' });
    await waitFor(() => pi.settled());
    const declared = mock.requests[0].toolNames;
    expect(declared).toEqual(expect.arrayContaining(['read', 'bash', ...DIRECT_TOOLS.filter((name) => name !== WORKFLOW_ANSWER_TOOL)]));
    expect(declared).not.toContain(WORKFLOW_ANSWER_TOOL);
    expect(declared).not.toContain('codemode');
  });

  it('keeps the callback pointed at the right session after a new session', async () => {
    const pi = startPi();
    await pi.client.request('prompt', { message: 'PLAIN first' });
    await waitFor(() => pi.settled());
    const first = (await pi.client.request('get_state')).sessionId;
    expect(first).toBe(pi.sessionId);

    await pi.client.request('new_session');
    const second = (await pi.client.request('get_state')).sessionId;
    expect(second).not.toBe(first);
    pi.events.length = 0;
    await pi.client.request('prompt', { message: toolMessage('openchamber_notify', { action: 'notify.send', parameters: { title: 'Hi' } }) });
    await waitFor(() => pi.settled());
    expect(stub.calls.map((call) => call.sessionID)).toEqual([`ses_${second}`]);
  });

  it('declares the workflow answer tool for a session that names it', async () => {
    const pi = startPi({ extraArgs: ['--tools', `+${WORKFLOW_ANSWER_TOOL}`] });
    await pi.client.request('prompt', { message: 'PLAIN please' });
    await waitFor(() => pi.settled());
    expect(mock.requests[0].toolNames).toContain(WORKFLOW_ANSWER_TOOL);
  });

  it('runs notify as a direct call, with a normalized input and the call id of the chat', async () => {
    const pi = startPi();
    stub.respondWith((call) => ok(call, { notified: true }));
    await pi.client.request('prompt', { message: toolMessage('openchamber_notify', { action: 'notify.send', title: 'Done', showWhenFocused: 'true' }) });
    await waitFor(() => pi.settled());

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      input: { action: 'notify.send', title: 'Done', showWhenFocused: true },
      sessionID: pi.sessionId,
      callID: 'call_directive',
      tool: 'openchamber_notify',
    });
    const end = pi.toolEnd('openchamber_notify');
    expect(end.result.content.map((block) => block.text).join('\n')).toContain('"notified":true');
    expect(end.result.details.openchamber).toMatchObject({ ok: true, action: 'notify.send' });
  });

  it('resolves a bare action before Pi checks it, and still refuses an unknown one', async () => {
    const pi = startPi();
    await pi.client.request('prompt', { message: toolMessage('openchamber_secret', { action: ' request ', parameters: { label: 'Key', reason: 'Why' } }) });
    await waitFor(() => pi.settled());
    expect(stub.calls.map((call) => call.input.action)).toEqual(['secret.request']);
    expect(pi.toolEnd('openchamber_secret').result.details.openchamber).toMatchObject({ action: 'secret.request', ok: true });

    const memory = startPi();
    await memory.client.request('prompt', { message: toolMessage('openchamber_memory', { action: 'read' }) });
    await waitFor(() => memory.settled());
    expect(stub.calls.map((call) => call.input.action)).toEqual(['secret.request', 'memory.read']);

    const unknown = startPi();
    await unknown.client.request('prompt', { message: toolMessage('openchamber_memory', { action: 'frobnicate' }) });
    await waitFor(() => unknown.settled());
    expect(stub.calls).toHaveLength(2);
    const refused = unknown.toolEnd('openchamber_memory');
    expect(refused.isError).toBe(true);
    expect(refused.result.content.map((block) => block.text).join('\n')).toContain('Validation failed for tool "openchamber_memory"');
  });

  it('turns an ok: false envelope into a result and an unreachable callback into a failure envelope, not a crash', async () => {
    const failing = startPi();
    stub.respondWith((call) => ({ schemaVersion: 1, ok: false, action: call.input.action, error: { message: 'Title required', kind: 'usage' } }));
    await failing.client.request('prompt', { message: toolMessage('openchamber_image', { action: 'image.generate', parameters: { prompt: 'a cat' } }) });
    await waitFor(() => failing.settled());
    const refusedEnd = failing.toolEnd('openchamber_image');
    expect(refusedEnd.isError).toBe(false);
    expect(JSON.parse(refusedEnd.result.content[0].text)).toMatchObject({ ok: false, error: { message: 'Title required' } });
    expect(refusedEnd.result.details.openchamber.ok).toBe(false);

    const deadPort = await new Promise((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
    const unreachable = startPi({ endpoint: `http://127.0.0.1:${deadPort}/api/openchamber/agent-tool` });
    await unreachable.client.request('prompt', { message: toolMessage('openchamber_image', { action: 'image.generate', parameters: { prompt: 'a cat' } }) });
    await waitFor(() => unreachable.settled());
    const unreachableEnd = unreachable.toolEnd('openchamber_image');
    expect(unreachableEnd.isError).toBe(false);
    expect(JSON.parse(unreachableEnd.result.content[0].text)).toMatchObject({ ok: false, action: 'image.generate', error: { kind: 'runtime' } });
    expect(unreachableEnd.result.details.openchamber.ok).toBe(false);
    // The model still got its answer and the turn finished.
    expect(unreachable.settled().aborted).not.toBe(true);
    expect(mock.requests.at(-1).messages.at(-1).role).toBe('tool');
    expect((await unreachable.client.request('get_state')).isStreaming).toBe(false);
  });

  it('cancels the held callback request when the turn is aborted', async () => {
    const pi = startPi();
    stub.respondWith(() => new Promise(() => {}));
    await pi.client.request('prompt', { message: toolMessage('openchamber_render', { action: 'render.page', parameters: { html: '<p>Pick</p>', awaitAnswer: true } }) });
    await waitFor(() => stub.calls.length === 1, { message: 'the call never reached the stub' });
    expect(stub.calls[0].aborted).toBe(false);

    await pi.client.request('abort');
    await waitFor(() => stub.calls[0].aborted, { message: 'the request was not cancelled' });
    expect((await waitFor(() => pi.settled())).aborted).toBe(true);
  });

  it.each([
    ['a prompt sent as a steer', (client) => client.request('prompt', { message: 'PLAIN next', streamingBehavior: 'steer' })],
    ['a steer', (client) => client.request('steer', { message: 'PLAIN next' })],
    ['a follow-up', (client) => client.request('follow_up', { message: 'PLAIN next' })],
  ])('ends a page that waits for an answer when the user sends %s', async (_label, send) => {
    const pi = startPi();
    stub.respondWith(() => new Promise(() => {}));
    await pi.client.request('prompt', { message: toolMessage('openchamber_render', { action: 'render.page', parameters: { html: '<p>Pick</p>', awaitAnswer: true } }) });
    await waitFor(() => stub.calls.length === 1);

    await send(pi.client);
    await waitFor(() => stub.calls[0].aborted, { message: 'the wait was not ended' });
    await waitFor(() => pi.settled());

    const end = pi.toolEnd('openchamber_render');
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.result.content[0].text)).toEqual({ schemaVersion: 1, ok: true, action: 'render.page', data: { answer: { answered: false, reason: 'chat' }, note: RENDER_PAGE_CLOSED_IN_CHAT_NOTE } });
    expect(end.result.details.openchamber).toMatchObject({ ok: true, answer: { answered: false, reason: 'chat' } });
    // The agent reads the message next.
    const lastUser = mock.requests.at(-1).messages.filter((message) => message.role === 'user').at(-1);
    expect(JSON.stringify(lastUser.content)).toContain('PLAIN next');
  });

  it('does not end a page that only shows when the user writes in the chat', async () => {
    const pi = startPi();
    let release;
    stub.respondWith(async (call) => { await new Promise((resolve) => { release = resolve; }); return ok(call); });
    await pi.client.request('prompt', { message: toolMessage('openchamber_render', { action: 'render.page', parameters: { html: '<p>Chart</p>' } }) });
    await waitFor(() => stub.calls.length === 1);
    await pi.client.request('steer', { message: 'PLAIN next' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stub.calls[0].aborted).toBe(false);
    release();
    await waitFor(() => pi.settled());
    expect(JSON.parse(pi.toolEnd('openchamber_render').result.content[0].text)).toMatchObject({ ok: true, data: { stub: true } });
  });

  describe('secret.run', () => {
    // A second extension of the same Pi process installs the gate, the way the
    // OpenChamber bridge will, and records what it was asked.
    const writeGate = (logFile) => {
      const file = path.join(makeTempDir('oc-pi-gate-'), 'gate.js');
      fs.writeFileSync(file, `import fs from "node:fs"
export default () => {
  globalThis.__openchamberPiPermission = async (request) => {
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ ...request, signal: request.signal instanceof AbortSignal ? "AbortSignal" : null }) + "\\n")
    if (request.resources[0].includes("forbidden")) throw new Error("The user rejected permission")
  }
}
`);
      return file;
    };
    const secretRun = (program) => toolMessage('openchamber_secret', { action: 'secret.run', parameters: { program, args: ['deploy'], reason: 'Deploy', inputs: [{ env: 'TOKEN', label: 'Token' }] } });

    it('is refused when nothing installed a permission gate', async () => {
      const pi = startPi();
      await pi.client.request('prompt', { message: secretRun('wrangler') });
      await waitFor(() => pi.settled());
      const end = pi.toolEnd('openchamber_secret');
      expect(JSON.parse(end.result.content[0].text)).toMatchObject({ ok: false, action: 'secret.run', error: { kind: 'runtime' } });
      expect(stub.calls).toHaveLength(0);
    });

    it('asks the gate first, reaches the callback once it agrees, and ends as a failure when it refuses', async () => {
      const logFile = path.join(makeTempDir('oc-pi-gate-log-'), 'requests.jsonl');
      const gate = writeGate(logFile);
      const allowed = startPi({ extensions: [gate] });
      stub.respondWith((call) => ok(call, { answer: { status: 'ran', outcome: 'exited', exitCode: 0 } }));
      await allowed.client.request('prompt', { message: secretRun('wrangler') });
      await waitFor(() => allowed.settled());
      expect(JSON.parse(fs.readFileSync(logFile, 'utf8').trim())).toEqual({
        sessionID: allowed.sessionId, toolCallId: 'call_directive', tool: 'openchamber_secret', action: 'shell', resources: ['wrangler deploy'], save: ['wrangler *'], signal: 'AbortSignal',
      });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]).toMatchObject({ input: { action: 'secret.run', program: 'wrangler' }, tool: 'openchamber_secret' });
      expect(allowed.toolEnd('openchamber_secret').result.details.openchamber).toMatchObject({ ok: true, answer: { status: 'ran' } });

      const refused = startPi({ extensions: [gate] });
      await refused.client.request('prompt', { message: secretRun('forbidden') });
      await waitFor(() => refused.settled());
      const end = refused.toolEnd('openchamber_secret');
      expect(end.isError).toBe(true);
      expect(end.result.content[0].text).toContain('The user rejected permission');
      expect(stub.calls).toHaveLength(1);
    });
  });

  describe('a call that waits longer than Pi\'s idle timeout', () => {
    let slowFixture;
    beforeAll(() => {
      slowFixture = createPiFixture({ mockPort: mock.port, extraSettings: { httpIdleTimeoutMs: 1000 } });
    });
    afterAll(() => slowFixture.dispose());

    it('is why the callback does not use fetch: Pi\'s own fetch gives up on a held request', async () => {
      const probe = path.join(makeTempDir('oc-pi-fetch-probe-'), 'fetch-probe.js');
      fs.writeFileSync(probe, `export default (pi) => {
  pi.registerTool({
    name: "fetch_probe",
    label: "Fetch probe",
    description: "Holds a request with fetch",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute() {
      try {
        const response = await fetch(process.env.OPENCHAMBER_AGENT_TOOL_URL, { method: "POST", body: "{}" })
        return { content: [{ type: "text", text: "answered " + response.status }], details: {} }
      } catch (error) {
        return { content: [{ type: "text", text: "failed " + (error.cause?.code ?? error.message) }], details: {} }
      }
    },
  })
}
`);
      stub.respondWith(async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); return '{}'; });
      const pi = startPi({ piFixture: slowFixture, options: flagsOf(), extensions: [probe] });
      await pi.client.request('prompt', { message: toolMessage('fetch_probe', {}) });
      await waitFor(() => pi.settled(), { timeoutMs: 20_000 });
      expect(pi.toolEnd('fetch_probe').result.content[0].text).toBe('failed UND_ERR_HEADERS_TIMEOUT');
    }, 40_000);

    it('keeps waiting for the user\'s answer', async () => {
      const pi = startPi({ piFixture: slowFixture });
      stub.respondWith(async (call) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return ok(call, { answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } });
      });
      await pi.client.request('prompt', { message: toolMessage('openchamber_render', { action: 'render.page', parameters: { html: '<p>Pick</p>', awaitAnswer: true } }) });
      await waitFor(() => pi.settled(), { timeoutMs: 20_000 });
      const end = pi.toolEnd('openchamber_render');
      expect(end.result.details.openchamber).toMatchObject({ ok: true, answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } });
    }, 40_000);
  });
});
