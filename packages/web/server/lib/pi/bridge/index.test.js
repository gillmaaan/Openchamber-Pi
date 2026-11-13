import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerConfigEntityRoutes } from '../../opencode/config-entity-routes.js';
import { createAgentStore } from '../config-routes/agents.js';

import { startMockOpenAi } from '../test-support/mock-openai.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { createManagedPiRuntime } from '../managed-runtime.js';
import { createPiBridge } from './index.js';

const PASSWORD = 'bridge-pw';
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

describe('the Pi bridge, end to end with a real Pi', () => {
  let mock;
  let fixture;
  let bridge;
  let events;
  let stream;

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  afterEach(async () => {
    stream?.abort();
    await bridge?.close();
    bridge = null;
  });

  const start = async ({ managed, generateTitleText, agentStore } = {}) => {
    fs.mkdirSync(path.join(fixture.root, 'data'), { recursive: true });
    bridge = await createPiBridge({
      managed,
      agentStore,
      // Without one, the mock model would answer the title request too.
      generateTitleText: generateTitleText ?? (async () => ''),
      password: PASSWORD,
      dataDir: path.join(fixture.root, 'data'),
      agentDir: fixture.agentDir,
      getBaseEnv: () => fixture.env,
      getDefaultDirectory: () => fixture.project,
      isTrusted: async () => true,
      log: () => {},
    });
    events = [];
    stream = new AbortController();
    const response = await fetch(`${bridge.url}/api/event`, { headers: { authorization: auth }, signal: stream.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
          }
        }
      } catch { /* the test ended */ }
    })();
    await waitFor(() => events.some((event) => event.type === 'server.connected'));
  };

  const call = (method, route, body, headers = {}) => fetch(`${bridge.url}${route}`, {
    method,
    headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const waitFor = async (predicate, timeoutMs = 20_000) => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`condition not met; events: ${events.map((event) => event.type).join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  const types = () => events.map((event) => event.type);
  const settled = (sessionID) => events.some((event) => event.data?.sessionID === sessionID && /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type));

  const newSession = async (id) => {
    const response = await call('POST', '/api/session', { id, model: { providerID: 'mock', id: 'mock-model' }, location: { directory: fixture.project } });
    expect(response.status).toBe(200);
    // The creation event travels over the stream after the response; let it land.
    await waitFor(() => events.some((event) => event.type === 'session.created' && event.data.sessionID === id));
    events.length = 0;
    return (await response.json()).data;
  };

  it('answers /api/info the way the web server\'s compatibility gate reads it', async () => {
    await start();
    const info = await (await call('GET', '/api/info')).json();
    expect(info.version).toBe('2.2.6');
    expect(info.agent.name).toBe('pi');
  });

  it('runs a plain turn: announces it in wire order, serves the messages and updates the record', async () => {
    await start();
    await newSession('ses_e2e_plain');

    const prompt = await call('POST', '/api/session/ses_e2e_plain/prompt', { id: 'msg_1c3308d78001UiMintedAAAAAA', text: 'PLAIN hello there' });
    expect(prompt.status).toBe(200);
    const inbox = (await prompt.json()).data;
    expect(inbox).toMatchObject({ id: 'msg_1c3308d78001UiMintedAAAAAA', sessionID: 'ses_e2e_plain', type: 'user', payload: { text: 'PLAIN hello there' }, delivery: 'steer' });
    expect((await call('GET', '/api/session/active').then((r) => r.json())).data).toEqual({ ses_e2e_plain: { type: 'running' } });

    await waitFor(() => settled('ses_e2e_plain'));
    const mine = events.filter((event) => event.data?.sessionID === 'ses_e2e_plain').map((event) => event.type);
    expect(mine.slice(0, 4)).toEqual(['session.inbox.enqueued', 'session.execution.started', 'session.inbox.delivered', 'session.step.started']);
    expect(mine.at(-1)).toBe('session.execution.succeeded');
    expect(mine).toEqual(expect.arrayContaining(['session.text.started', 'session.text.delta', 'session.text.ended', 'session.step.ended', 'session.usage.updated']));
    expect(events.some((event) => 'idleMessage' in event || 'idleMessage' in event.data)).toBe(false);

    const page = await (await call('GET', '/api/session/ses_e2e_plain/message?limit=100')).json();
    expect(page.data.map((message) => message.type)).toEqual(['idle', 'assistant', 'user']);
    expect(page.data[2]).toMatchObject({ id: 'msg_1c3308d78001UiMintedAAAAAA', text: 'PLAIN hello there', type: 'user' });
    expect(page.data[1]).toMatchObject({ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'plain answer' }], model: { id: 'mock-model', providerID: 'mock' } });
    expect(page.data[0]).toMatchObject({ type: 'idle', outcome: 'succeeded' });
    expect(typeof page.cursor.next).toBe('string');

    const session = (await (await call('GET', '/api/session/ses_e2e_plain')).json()).data;
    expect(session).toMatchObject({ id: 'ses_e2e_plain', outcome: 'succeeded', title: 'PLAIN hello there', location: { directory: fixture.project } });
    expect(session.tokens.input + session.tokens.cache.read).toBeGreaterThan(0);
    expect(session.time.busy).toBeGreaterThan(0);
    expect(session.time.idle).toBeGreaterThanOrEqual(session.time.busy);
    expect((await call('GET', '/api/session/active').then((r) => r.json())).data).toEqual({});
  });

  it('expands commands before held context and text attachments are combined', async () => {
    const promptsDir = path.join(fixture.agentDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'context-proof.md'), 'PLAIN Expanded $ARGUMENTS');
    try {
      await start();
      await newSession('ses_e2e_command_context');
      expect((await call('POST', '/api/session/ses_e2e_command_context/synthetic', { text: 'HELD-CONTEXT-MARKER', resume: false })).status).toBe(200);
      expect((await call('POST', '/api/session/ses_e2e_command_context/command', {
        name: 'context-proof',
        text: '"Ada Lovelace"',
        files: [{ uri: `data:text/plain;base64,${Buffer.from('ATTACHMENT-MARKER').toString('base64')}`, name: 'proof.txt', mime: 'text/plain' }],
      })).status).toBe(204);
      await waitFor(() => settled('ses_e2e_command_context'));
      const page = (await (await call('GET', '/api/session/ses_e2e_command_context/message?limit=20&order=asc')).json()).data;
      const user = page.find((message) => message.type === 'user');
      expect(user.text).toBe('HELD-CONTEXT-MARKER\n\n<attachment name="proof.txt" type="text/plain">\nATTACHMENT-MARKER\n</attachment>\n\nPLAIN Expanded Ada Lovelace');
    } finally {
      fs.rmSync(path.join(promptsDir, 'context-proof.md'), { force: true });
    }
  });

  it('sends an expanded body that starts with a slash as literal text, not as another command', async () => {
    const promptsDir = path.join(fixture.agentDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'context-proof.md'), 'PLAIN Expanded $ARGUMENTS');
    fs.writeFileSync(path.join(promptsDir, 'wrap-proof.md'), '/context-proof $ARGUMENTS');
    try {
      await start();
      await newSession('ses_e2e_command_literal');
      expect((await call('POST', '/api/session/ses_e2e_command_literal/command', { name: 'wrap-proof', text: 'Ada' })).status).toBe(204);
      await waitFor(() => settled('ses_e2e_command_literal'));
      const page = (await (await call('GET', '/api/session/ses_e2e_command_literal/message?limit=20&order=asc')).json()).data;
      expect(page.find((message) => message.type === 'user').text.trim()).toBe('/context-proof Ada');
    } finally {
      fs.rmSync(path.join(promptsDir, 'context-proof.md'), { force: true });
      fs.rmSync(path.join(promptsDir, 'wrap-proof.md'), { force: true });
    }
  });

  it('refuses an unknown command without starting a Pi child or accepting an inbox item', async () => {
    await start();
    await newSession('ses_e2e_command_missing');
    const response = await call('POST', '/api/session/ses_e2e_command_missing/command', { name: 'missing-proof-command', text: 'Ada' });
    expect(response.status).toBe(404);
    expect((await response.json())._tag).toBe('CommandNotFoundError');
    expect(bridge.host.get('ses_e2e_command_missing')).toBeNull();
    expect(events.some((event) => event.data?.sessionID === 'ses_e2e_command_missing' && event.type === 'session.inbox.enqueued')).toBe(false);
  });

  it('applies a command\'s agent and model to the session, durably, before running its turn', async () => {
    const agentsDir = path.join(fixture.agentDir, 'openchamber', 'agents');
    const promptsDir = path.join(fixture.agentDir, 'prompts');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'command-agent.md'), '---\nname: command-agent\nmode: all\nmodel: mock/mock-model#high\n---\nCOMMAND-AGENT-MARKER');
    fs.writeFileSync(path.join(promptsDir, 'inline-proof.md'), '---\nagent: command-agent\n---\nPLAIN inline $ARGUMENTS');
    try {
      await start();
      await newSession('ses_e2e_command_inline');
      expect((await call('POST', '/api/session/ses_e2e_command_inline/command', { name: 'inline-proof', text: 'Ada' })).status).toBe(204);
      await waitFor(() => settled('ses_e2e_command_inline'));

      const session = (await (await call('GET', '/api/session/ses_e2e_command_inline')).json()).data;
      expect(session).toMatchObject({ agent: 'command-agent', model: { providerID: 'mock', id: 'mock-model', variant: 'high' } });
      expect(events.filter((event) => event.data?.sessionID === 'ses_e2e_command_inline').map((event) => event.type))
        .toEqual(expect.arrayContaining(['session.agent.selected', 'session.model.selected']));
      const request = mock.requests.findLast((entry) => JSON.stringify(entry.messages).includes('PLAIN inline Ada'));
      expect(JSON.stringify(request.messages.filter((message) => message.role === 'system' || message.role === 'developer'))).toContain('COMMAND-AGENT-MARKER');
    } finally {
      fs.rmSync(path.join(agentsDir, 'command-agent.md'), { force: true });
      fs.rmSync(path.join(promptsDir, 'inline-proof.md'), { force: true });
    }
  });

  it('runs a subagent command in a child session and reports to the idle parent', async () => {
    const promptsDir = path.join(fixture.agentDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'delegate-proof.md'), '---\ndescription: Child lifecycle probe\nsubagent: true\nagent: general\n---\nPLAIN child $ARGUMENTS');
    try {
      await start();
      await newSession('ses_e2e_command_child');
      expect((await call('POST', '/api/session/ses_e2e_command_child/command', { name: 'delegate-proof', text: 'Grace' })).status).toBe(204);
      await waitFor(() => events.some((event) => event.type === 'session.created' && event.data.parentID === 'ses_e2e_command_child'));
      const childID = events.find((event) => event.type === 'session.created' && event.data.parentID === 'ses_e2e_command_child').data.sessionID;
      await waitFor(() => settled(childID), 30_000);

      const child = (await (await call('GET', `/api/session/${childID}`)).json()).data;
      expect(child).toMatchObject({ parentID: 'ses_e2e_command_child', agent: 'general', title: 'Child lifecycle probe' });
      const childMessages = (await (await call('GET', `/api/session/${childID}/message?limit=20&order=asc`)).json()).data;
      expect(childMessages.find((message) => message.type === 'user').text).toBe('PLAIN child Grace');

      await waitFor(() => settled('ses_e2e_command_child'), 30_000);
      const parent = (await (await call('GET', '/api/session/ses_e2e_command_child')).json()).data;
      expect(parent.agent).toBeUndefined();
      expect(events.some((event) => event.type === 'session.agent.selected' && event.data.sessionID === 'ses_e2e_command_child')).toBe(false);
      const parentMessages = (await (await call('GET', '/api/session/ses_e2e_command_child/message?limit=20&order=asc')).json()).data;
      const report = parentMessages.find((message) => message.type === 'user');
      expect(report.text).toContain('<subagent sessionID=');
      expect(report.text).toContain('plain answer');
      expect(parentMessages.some((message) => message.type === 'user' && message.text === 'PLAIN child Grace')).toBe(false);

      const jobList = (await (await call('GET', `/api/experimental/job?sessionID=ses_e2e_command_child&status=completed`)).json()).data;
      expect(jobList).toContainEqual(expect.objectContaining({
        kind: 'subagent', id: childID, sessionID: 'ses_e2e_command_child', childSessionID: childID, agent: 'general', status: 'completed',
      }));
    } finally {
      fs.rmSync(path.join(promptsDir, 'delegate-proof.md'), { force: true });
    }
  });

  it('lists a remote OAuth MCP server as an integration the MCP page can sign in', async () => {
    fs.writeFileSync(path.join(fixture.agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://mcp.example.com', oauth: {} },
        plain: { type: 'http', url: 'https://plain.example.com' },
        noAuth: { type: 'http', url: 'https://no-auth.example.com', oauth: false },
      },
    }));
    try {
      await start();
      const integrations = (await (await call('GET', '/api/integration')).json()).data;
      const docs = integrations.find((integration) => integration.name === 'docs');
      expect(docs).toMatchObject({ id: expect.stringMatching(/^mcp_[0-9a-f]{16}$/), metadata: { source: 'mcp' }, methods: [{ id: 'oauth', type: 'oauth' }] });
      expect(integrations.some((integration) => integration.name === 'noAuth')).toBe(false);
      expect((await (await call('GET', `/api/integration/${docs.id}`)).json()).data.name).toBe('docs');
    } finally {
      fs.rmSync(path.join(fixture.agentDir, 'mcp.json'), { force: true });
    }
  });

  it('attaches a mentioned skill\'s text to the prompt and refuses a name no folder holds', async () => {
    const skillDir = path.join(fixture.agentDir, 'skills', 'proof-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: proof-skill\ndescription: Proof skill\n---\nSKILL-BODY-MARKER');
    try {
      await start();
      await newSession('ses_e2e_skill');
      expect((await call('POST', '/api/session/ses_e2e_skill/prompt', {
        text: 'PLAIN use the skill',
        skills: [{ id: 'proof-skill' }],
      })).status).toBe(200);
      await waitFor(() => settled('ses_e2e_skill'));
      const page = (await (await call('GET', '/api/session/ses_e2e_skill/message?limit=20&order=asc')).json()).data;
      expect(page.find((message) => message.type === 'user').text).toBe('<skill_content name="proof-skill">\nSKILL-BODY-MARKER\n</skill_content>\n\nPLAIN use the skill');

      const missing = await call('POST', '/api/session/ses_e2e_skill/prompt', { text: 'PLAIN again', skills: [{ id: 'no-such-skill' }] });
      expect(missing.status).toBe(400);
      expect((await missing.json()).message).toBe('Skill not found: no-such-skill');
    } finally {
      fs.rmSync(path.join(fixture.agentDir, 'skills', 'proof-skill'), { recursive: true, force: true });
    }
  });

  it('runs a tool turn and serves the call as a completed shell tool', async () => {
    await start();
    await newSession('ses_e2e_tool');
    await call('POST', '/api/session/ses_e2e_tool/prompt', { text: 'PWD please' });
    await waitFor(() => settled('ses_e2e_tool'));

    const mine = events.filter((event) => event.data?.sessionID === 'ses_e2e_tool').map((event) => event.type);
    expect(mine).toEqual(expect.arrayContaining(['session.reasoning.started', 'session.tool.input.started', 'session.tool.called', 'session.tool.success']));
    expect(mine.indexOf('session.tool.called')).toBeLessThan(mine.indexOf('session.tool.success'));

    const page = await (await call('GET', '/api/session/ses_e2e_tool/message?limit=100&order=asc')).json();
    const assistants = page.data.filter((message) => message.type === 'assistant');
    expect(assistants).toHaveLength(2);
    const tool = assistants[0].content.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ name: 'shell', state: { status: 'completed', input: { command: 'pwd' } } });
    expect(tool.state.content[0].text).toContain(fixture.project);
    expect(assistants[0].finish).toBe('tool-calls');
    expect(assistants[1].finish).toBe('stop');
  });

  it('lists and applies a stored agent, enforces its permissions, and replaces its idle child on agent switch', async () => {
    const agentsDir = path.join(fixture.agentDir, 'openchamber', 'agents');
    const agentStore = createAgentStore({ getAgentDir: () => fixture.agentDir, isProjectTrusted: async () => true });
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      piAgentStore: agentStore,
      resolveProjectDirectory: async () => ({ directory: fixture.project }),
      resolveOptionalProjectDirectory: async () => ({ directory: fixture.project }),
      onPiAgentsChanged: () => bridge.invalidateIdle(),
    });
    try {
      await start({ agentStore });
      await request(app).post('/api/config/agents/restricted').send({
        scope: 'user',
        mode: 'all',
        tools: ['read', 'bash'],
        permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*', effect: 'deny' }],
        system: 'RESTRICTED-AGENT-MARKER',
      }).expect(200);
      const config = (await request(app).get('/api/config/agents/restricted/config').expect(200)).body;
      expect(config.config.tools).toEqual(['read', 'bash']);
      const agents = (await (await call('GET', '/api/agent')).json()).data;
      expect(agents).toContainEqual(expect.objectContaining({ id: 'restricted', mode: 'all' }));
      await newSession('ses_e2e_profile');
      expect((await call('POST', '/api/session/ses_e2e_profile/agent', { agent: 'restricted' })).status).toBe(204);
      await call('POST', '/api/session/ses_e2e_profile/prompt', { text: 'PWD restricted' });
      await waitFor(() => settled('ses_e2e_profile'));
      const modelRequest = mock.requests.findLast((entry) => entry.messages.at(-1)?.role === 'user' && JSON.stringify(entry.messages.at(-1).content).includes('PWD restricted'));
      expect(JSON.stringify(modelRequest.messages.filter((message) => message.role === 'system' || message.role === 'developer'))).toContain('RESTRICTED-AGENT-MARKER');
      expect(modelRequest.toolNames).toContain('read');
      expect(modelRequest.toolNames).not.toContain('edit');
      // The agent denies the shell outright, so the model is not offered it;
      // the mock model calls it anyway and Pi refuses the unknown tool.
      expect(modelRequest.toolNames).not.toContain('bash');
      const page = await (await call('GET', '/api/session/ses_e2e_profile/message?limit=100&order=asc')).json();
      const tool = page.data.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool');
      expect(tool.state.status).toBe('error');
      expect(tool.state.error.message).toContain('Tool bash not found');
      const pid = bridge.host.get('ses_e2e_profile').pid;
      events.length = 0;
      await call('POST', '/api/session/ses_e2e_profile/agent', { agent: 'build' });
      await call('POST', '/api/session/ses_e2e_profile/prompt', { text: 'PLAIN switched agent' });
      await waitFor(() => settled('ses_e2e_profile'));
      expect(bridge.host.get('ses_e2e_profile').pid).not.toBe(pid);
      const next = mock.requests.at(-1);
      expect(JSON.stringify(next.messages.filter((message) => message.role === 'system' || message.role === 'developer'))).not.toContain('RESTRICTED-AGENT-MARKER');
      expect(next.toolNames).toContain('edit');
      await request(app).patch('/api/config/agents/restricted').send({ disabled: true }).expect(200);
      expect((await (await call('GET', '/api/agent')).json()).data.some((agent) => agent.id === 'restricted')).toBe(false);
      const disabled = (await request(app).get('/api/config/disabled-agents').expect(200)).body.agents;
      expect(disabled).toContainEqual(expect.objectContaining({ name: 'restricted', scope: 'user' }));
      expect((await call('POST', '/api/session/ses_e2e_profile/agent', { agent: 'restricted' })).status).toBe(400);
      expect((await call('GET', '/api/session/ses_e2e_profile').then((response) => response.json())).data.agent).toBe('build');
      await request(app).delete('/api/config/agents/restricted').send({ scope: 'user' }).expect(200);
      expect(fs.existsSync(path.join(agentsDir, 'restricted.md'))).toBe(false);
    } finally {
      fs.rmSync(path.join(agentsDir, 'restricted.md'), { force: true });
    }
  });

  it('keeps a running profile unchanged and applies edited settings at the next idle turn', async () => {
    const agentStore = createAgentStore({ getAgentDir: () => fixture.agentDir, isProjectTrusted: async () => true });
    const created = await agentStore.create('editable', {
      mode: 'all',
      tools: ['read', 'bash'],
      system: 'ORIGINAL-PROFILE-MARKER',
      permissions: [{ action: 'shell', resource: 'rm *', effect: 'deny' }],
    }, null, 'user');
    try {
      await start({ agentStore });
      const id = 'ses_e2e_profile_edit';
      await newSession(id);
      await call('POST', `/api/session/${id}/agent`, { agent: 'editable' });
      expect((await call('POST', `/api/session/${id}/prompt`, { text: 'HOLD profile edit' })).status).toBe(200);
      await waitFor(() => types().includes('session.text.delta'));
      const original = bridge.host.get(id);
      expect(original.busy).toBe(true);
      await agentStore.update('editable', {
        tools: ['read', 'bash', 'edit'],
        system: 'UPDATED-PROFILE-MARKER',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      }, null);
      await bridge.invalidateIdle();
      expect(bridge.host.get(id)).toMatchObject({
        pid: original.pid,
        busy: true,
        stale: true,
        agentRules: [{ action: 'shell', resource: 'rm *', effect: 'deny' }],
      });
      mock.releaseHeld();
      await waitFor(() => settled(id));
      events.length = 0;
      expect((await call('POST', `/api/session/${id}/prompt`, { text: 'PWD edited profile' })).status).toBe(200);
      await waitFor(() => settled(id));
      expect(bridge.host.get(id)).toMatchObject({ stale: false, agentRules: [{ action: '*', resource: '*', effect: 'allow' }] });
      expect(bridge.host.get(id).pid).not.toBe(original.pid);
      const next = mock.requests.findLast((entry) => entry.messages.at(-1)?.role === 'user' && JSON.stringify(entry.messages.at(-1).content).includes('PWD edited profile'));
      const system = JSON.stringify(next.messages.filter((message) => message.role === 'system' || message.role === 'developer'));
      expect(system).toContain('UPDATED-PROFILE-MARKER');
      expect(system).not.toContain('ORIGINAL-PROFILE-MARKER');
      expect(next.toolNames).toContain('edit');
      const page = await (await call('GET', `/api/session/${id}/message?limit=100&order=asc`)).json();
      const tool = page.data.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool');
      expect(tool.state.status).toBe('completed');
      expect(tool.state.content[0].text).toContain(fixture.project);
    } finally {
      fs.rmSync(created.path, { force: true });
    }
  }, 30_000);

  it('interrupts a streaming turn and settles it as interrupted', async () => {
    await start();
    await newSession('ses_e2e_abort');
    await call('POST', '/api/session/ses_e2e_abort/prompt', { text: 'SLOW go' });
    await waitFor(() => types().includes('session.text.delta'));

    const response = await call('POST', '/api/session/ses_e2e_abort/interrupt', {});
    expect(await response.json()).toEqual({ interrupted: true });
    await waitFor(() => settled('ses_e2e_abort'));

    expect(types()).toContain('session.execution.interrupted');
    const session = (await (await call('GET', '/api/session/ses_e2e_abort')).json()).data;
    expect(session.outcome).toBe('interrupted');
    const page = await (await call('GET', '/api/session/ses_e2e_abort/message?limit=100')).json();
    expect(page.data[0]).toMatchObject({ type: 'idle', outcome: 'interrupted' });
    expect(await (await call('POST', '/api/session/ses_e2e_abort/interrupt', {})).json()).toEqual({ interrupted: false });
  });

  it('reports what fills the context of a session, before its first turn and while one streams, without adding to the conversation', async () => {
    fs.writeFileSync(path.join(fixture.project, 'AGENTS.md'), 'Project rule: be terse.\n');
    await start();
    await newSession('ses_e2e_context');

    const idle = await call('GET', '/api/session/ses_e2e_context/context-composition');
    expect(idle.status).toBe(200);
    const composition = (await idle.json()).data;
    const category = (id) => composition.categories.find((entry) => entry.id === id);
    expect(category('system').items.map((item) => item.id)).toContain('rules');
    expect(category('instructions').items.map((item) => item.label).join()).toContain('AGENTS.md');
    expect(category('builtinTools').items.map((item) => item.label)).toContain('bash');
    expect(category('customTools').items.map((item) => item.label)).toContain('question');
    expect(composition.totalTokens).toBeGreaterThan(500);
    // A read is not a turn: the session has no message and is not busy.
    expect((await (await call('GET', '/api/session/ses_e2e_context/message?limit=100')).json()).data).toEqual([]);
    expect(bridge.host.get('ses_e2e_context').busy).toBe(false);

    await call('POST', '/api/session/ses_e2e_context/prompt', { text: 'HOLD context while streaming' });
    await waitFor(() => types().includes('session.text.delta'));
    const streaming = await call('GET', '/api/session/ses_e2e_context/context-composition');
    expect(streaming.status).toBe(200);
    expect((await streaming.json()).data.totalTokens).toBe(composition.totalTokens);
    expect(bridge.host.get('ses_e2e_context').busy).toBe(true);
    mock.releaseHeld();
    await waitFor(() => settled('ses_e2e_context'));
    const messages = (await (await call('GET', '/api/session/ses_e2e_context/message?limit=100')).json()).data;
    expect(JSON.stringify(messages)).not.toContain('openchamber-context');
  }, 30_000);

  it('refuses a prompt for a model without a key, gives the reason and leaves nothing running', async () => {
    await start();
    await call('POST', '/api/session', { id: 'ses_e2e_nokey', model: { providerID: 'anthropic', id: 'claude-fable-5' }, location: { directory: fixture.project } });
    const response = await call('POST', '/api/session/ses_e2e_nokey/prompt', { text: 'hi' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('InvalidRequestError');
    expect(body.message).toMatch(/model|key|provider/i);
    expect((await call('GET', '/api/session/active').then((r) => r.json())).data).toEqual({});
    expect((await call('GET', '/api/session/ses_e2e_nokey/inbox').then((r) => r.json())).data).toEqual([]);
  });

  it('starts a child with the gate and the managed tools loaded once each', async () => {
    const managed = createManagedPiRuntime({
      fsPromises: fs.promises,
      path,
      instanceDir: path.join(fixture.root, 'instance'),
      readSettings: async () => ({}),
      gateSourcePath: new URL('../extension/gui-gate.js', import.meta.url).pathname,
    });
    await managed.refresh();
    await start({ managed });
    await newSession('ses_e2e_managed');
    await call('POST', '/api/session/ses_e2e_managed/prompt', { text: 'PLAIN with managed tools' });
    await waitFor(() => settled('ses_e2e_managed'));

    expect(types()).toContain('session.execution.succeeded');
    const toolNames = mock.requests.at(-1).toolNames;
    expect(toolNames).toEqual(expect.arrayContaining(['question', 'subagent']));
    expect(toolNames.filter((name) => name === 'question')).toHaveLength(1);
    // The managed tools of the default Settings: render and secret are direct, the rest sit behind Pi's codemode tool.
    expect(toolNames).toEqual(expect.arrayContaining(['codemode', 'openchamber_render', 'openchamber_secret']));
    expect(toolNames).not.toContain('openchamber_memory');
    expect(toolNames).not.toContain('openchamber_image');
  });

  it('puts instruction entries into the system prompt and announces a change once', async () => {
    await start();
    await newSession('ses_e2e_notes');
    const key = 'openchamber.response-style';
    expect((await call('PUT', `/api/experimental/session/ses_e2e_notes/instructions/entries/${key}`, { value: 'Answer in one short sentence.' })).status).toBe(204);
    expect(await (await call('GET', '/api/experimental/session/ses_e2e_notes/instructions/entries')).json()).toEqual({ data: [{ key, value: 'Answer in one short sentence.' }] });

    await call('POST', '/api/session/ses_e2e_notes/prompt', { text: 'PLAIN first' });
    await waitFor(() => settled('ses_e2e_notes'));
    const systemOf = (request) => JSON.stringify(request.messages.filter((message) => message.role === 'system' || message.role === 'developer'));
    expect(systemOf(mock.requests.at(-1))).toContain('Answer in one short sentence.');
    expect(types()).not.toContain('session.instructions.updated');

    events.length = 0;
    await call('PUT', `/api/experimental/session/ses_e2e_notes/instructions/entries/${key}`, { value: 'Answer in two sentences.' });
    await call('POST', '/api/session/ses_e2e_notes/prompt', { text: 'PLAIN second' });
    await waitFor(() => settled('ses_e2e_notes'));
    expect(systemOf(mock.requests.at(-1))).toContain('Answer in two sentences.');
    const update = events.find((event) => event.type === 'session.instructions.updated');
    expect(update.data).toMatchObject({ sessionID: 'ses_e2e_notes', delta: { [`api/${key}`]: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(update.data.text).toContain('Answer in two sentences.');
    expect(update.location).toEqual({ directory: fixture.project });

    expect((await call('DELETE', `/api/experimental/session/ses_e2e_notes/instructions/entries/${key}`)).status).toBe(204);
    events.length = 0;
    await call('POST', '/api/session/ses_e2e_notes/prompt', { text: 'PLAIN third' });
    await waitFor(() => settled('ses_e2e_notes'));
    expect(systemOf(mock.requests.at(-1))).not.toContain('Answer in two sentences.');
    expect(events.find((event) => event.type === 'session.instructions.updated').data.delta).toEqual({ [`api/${key}`]: 'removed' });
  });

  it('refuses a key with odd characters and an oversized value, and 404s an unknown session', async () => {
    await start();
    await newSession('ses_e2e_notes2');
    expect((await call('PUT', '/api/experimental/session/ses_e2e_notes2/instructions/entries/bad%20key', { value: 'x' })).status).toBe(400);
    const tooLarge = await call('PUT', '/api/experimental/session/ses_e2e_notes2/instructions/entries/big', { value: 'x'.repeat(100_001) });
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json())._tag).toBe('ValueTooLargeError');
    expect((await call('GET', '/api/experimental/session/ses_nope/instructions/entries')).status).toBe(404);
  });

  it('answers wait only once the turn has ended', async () => {
    await start();
    await newSession('ses_e2e_wait');
    expect((await call('POST', '/api/experimental/session/ses_e2e_wait/wait', {})).status).toBe(204);

    await call('POST', '/api/session/ses_e2e_wait/prompt', { text: 'SLOW wait for it' });
    await waitFor(() => types().includes('session.text.delta'));
    let answered = false;
    const waiting = call('POST', '/api/experimental/session/ses_e2e_wait/wait', {}).then((response) => { answered = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(false);

    await call('POST', '/api/session/ses_e2e_wait/interrupt', {});
    expect((await waiting).status).toBe(204);
    expect((await call('POST', '/api/experimental/session/ses_nope/wait', {})).status).toBe(404);
  });

  it('names a session after its first prompt and leaves later prompts and set titles alone', async () => {
    const asked = [];
    await start({ generateTitleText: async (request) => { asked.push(request); return '"Login timeout."'; } });
    await newSession('ses_e2e_title');
    await call('POST', '/api/session/ses_e2e_title/prompt', { text: 'PLAIN the login times out' });
    await waitFor(() => events.some((event) => event.type === 'session.renamed' && event.data.sessionID === 'ses_e2e_title'));
    await waitFor(() => settled('ses_e2e_title'));
    expect(events.find((event) => event.type === 'session.renamed').data.title).toBe('Login timeout');
    expect((await (await call('GET', '/api/session/ses_e2e_title')).json()).data.title).toBe('Login timeout');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ directory: fixture.project, model: { providerID: 'mock', id: 'mock-model' } });

    await call('POST', '/api/session/ses_e2e_title/prompt', { text: 'PLAIN and a second thing' });
    await waitFor(() => events.filter((event) => event.type === 'session.execution.succeeded').length === 2);
    expect(asked).toHaveLength(1);

    await newSession('ses_e2e_titled');
    await call('PATCH', '/api/session/ses_e2e_titled', { title: 'My own' });
    await call('POST', '/api/session/ses_e2e_titled/prompt', { text: 'PLAIN named already' });
    await waitFor(() => settled('ses_e2e_titled'));
    expect(asked).toHaveLength(1);
  });

  it('runs a subagent call as a child session and returns its reply to the parent', async () => {
    await start();
    await newSession('ses_e2e_parent');
    const call1 = `TOOL:subagent:${JSON.stringify({ description: 'Look around', prompt: 'PLAIN list the files' })}`;
    await call('POST', '/api/session/ses_e2e_parent/prompt', { text: call1 });
    await waitFor(() => settled('ses_e2e_parent'), 30_000);

    const children = (await (await call('GET', '/api/session?parentID=ses_e2e_parent&limit=10')).json()).data;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ parentID: 'ses_e2e_parent', agent: 'general', title: 'Look around', outcome: 'succeeded' });
    const childMessages = (await (await call('GET', `/api/session/${children[0].id}/message?limit=20&order=asc`)).json()).data;
    expect(childMessages.find((message) => message.type === 'user').text).toBe('PLAIN list the files');
    expect(childMessages.find((message) => message.type === 'assistant').content[0].text).toBe('plain answer');

    const parentMessages = (await (await call('GET', '/api/session/ses_e2e_parent/message?limit=20&order=asc')).json()).data;
    const tool = parentMessages.filter((message) => message.type === 'assistant')[0].content.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ name: 'subagent', state: { status: 'completed', metadata: { sessionID: children[0].id, status: 'completed' } } });
    expect(tool.state.content[0].text).toBe(`<subagent sessionID="${children[0].id}" state="completed">\nplain answer\n</subagent>`);

    const progress = events.find((event) => event.type === 'session.tool.progress' && event.data.metadata?.sessionID === children[0].id);
    expect(progress.data.metadata).toEqual({ sessionID: children[0].id, status: 'running' });
  });

  it('stops the subagent when the parent turn is interrupted', async () => {
    await start();
    await newSession('ses_e2e_parent2');
    await call('POST', '/api/session/ses_e2e_parent2/prompt', { text: `TOOL:subagent:${JSON.stringify({ description: 'Slow work', prompt: 'SLOW keep going' })}` });
    await waitFor(() => events.some((event) => event.type === 'session.created' && event.data.parentID === 'ses_e2e_parent2'), 30_000);
    const childId = events.find((event) => event.type === 'session.created' && event.data.parentID === 'ses_e2e_parent2').data.sessionID;
    await waitFor(() => events.some((event) => event.data?.sessionID === childId && event.type === 'session.text.delta'), 30_000);

    await call('POST', '/api/session/ses_e2e_parent2/interrupt', {});
    await waitFor(() => settled('ses_e2e_parent2') && settled(childId), 30_000);
    expect((await (await call('GET', `/api/session/${childId}`)).json()).data.outcome).toBe('interrupted');
  });

  it('refuses a subagent call that names an agent that does not exist', async () => {
    await start();
    await newSession('ses_e2e_parent3');
    await call('POST', '/api/session/ses_e2e_parent3/prompt', { text: `TOOL:subagent:${JSON.stringify({ agent: 'nope', description: 'x', prompt: 'PLAIN hi' })}` });
    await waitFor(() => settled('ses_e2e_parent3'), 30_000);
    const messages = (await (await call('GET', '/api/session/ses_e2e_parent3/message?limit=20&order=asc')).json()).data;
    const tool = messages.filter((message) => message.type === 'assistant')[0].content.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('error');
    expect(tool.state.error.message).toContain('Unknown agent "nope". Use one of: general, explore');
    expect((await (await call('GET', '/api/session?parentID=ses_e2e_parent3&limit=10')).json()).data).toEqual([]);
  });

  it('lists the session after it has a file, and sees a session the Pi CLI wrote', async () => {
    await start();
    await newSession('ses_e2e_list');
    await call('POST', '/api/session/ses_e2e_list/prompt', { text: 'PLAIN list me' });
    await waitFor(() => settled('ses_e2e_list'));
    const list = await (await call('GET', '/api/session?limit=100')).json();
    expect(list.data.map((session) => session.id)).toContain('ses_e2e_list');
    expect(list.data.find((session) => session.id === 'ses_e2e_list').title).toBe('PLAIN list me');
  });

  it('resumes a Pi CLI UUID session with instructions, tool permissions and questions under its wire id', async () => {
    const piID = '60ce5684-479d-4c53-835b-0da044ade175';
    const sessionID = `ses_${piID}`;
    const directory = path.join(fixture.sessionsDir, '--cli-resume--');
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(directory, `2026-11-10T00-00-00-000Z_${piID}.jsonl`), [
      { type: 'session', version: 3, id: piID, timestamp, cwd: fixture.project },
      { type: 'model_change', id: 'model001', parentId: null, timestamp, provider: 'mock', modelId: 'mock-model' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await start();
    expect((await call('PUT', `/api/experimental/session/${sessionID}/instructions/entries/resume`, { value: 'Keep the resumed session context.' })).status).toBe(204);
    expect((await call('POST', `/api/session/${sessionID}/prompt`, { text: 'PWD after CLI resume' })).status).toBe(200);
    await waitFor(() => settled(sessionID));
    const page = (await (await call('GET', `/api/session/${sessionID}/message?limit=100&order=asc`)).json()).data;
    const tool = page.find((message) => message.type === 'assistant').content.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('completed');
    expect(tool.state.content[0].text).toContain(fixture.project);
    expect(JSON.stringify(mock.requests.at(-1).messages)).toContain('Keep the resumed session context.');

    events.length = 0;
    const questions = [{ question: 'Continue?', header: 'Resume', options: [{ label: 'Yes', description: 'continue' }] }];
    await call('POST', `/api/session/${sessionID}/prompt`, { text: `TOOL:question:${JSON.stringify({ questions })}` });
    await waitFor(() => events.some((event) => event.type === 'form.created' && event.data.form.sessionID === sessionID));
    const form = events.find((event) => event.type === 'form.created' && event.data.form.sessionID === sessionID).data.form;
    expect((await call('POST', `/api/session/${sessionID}/form/${form.id}/reply`, { answer: { q0: 'Yes' } })).status).toBe(204);
    await waitFor(() => settled(sessionID));
  });

  it('keeps the same conversation after the bridge restarts', async () => {
    await start();
    await newSession('ses_e2e_restart');
    await call('POST', '/api/session/ses_e2e_restart/prompt', { id: 'msg_1c3308d78002UiMintedBBBBBB', text: 'PLAIN remember me' });
    await waitFor(() => settled('ses_e2e_restart'));
    stream.abort();
    await bridge.close();

    await start();
    const page = await (await call('GET', '/api/session/ses_e2e_restart/message?limit=100&order=asc')).json();
    expect(page.data.map((message) => message.type)).toEqual(['user', 'assistant', 'idle']);
    expect(page.data[0].id).toBe('msg_1c3308d78002UiMintedBBBBBB');
    await call('POST', '/api/session/ses_e2e_restart/prompt', { text: 'PLAIN and again' });
    await waitFor(() => settled('ses_e2e_restart'));
    const second = await (await call('GET', '/api/session/ses_e2e_restart/message?limit=100&order=asc')).json();
    expect(second.data.filter((message) => message.type === 'user')).toHaveLength(2);
  });
});
