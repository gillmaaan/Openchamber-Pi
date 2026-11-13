import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../launch.js';
import { createPiRpcClient } from '../rpc-client.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { startMockOpenAi } from '../test-support/mock-openai.js';
import { agentLaunchOptions, createAgentStore, formatModelRef, parseModelRef } from './agents.js';

describe('parseModelRef / formatModelRef', () => {
  it('splits and joins provider/id#variant', () => {
    expect(parseModelRef('anthropic/claude#high')).toEqual({ providerID: 'anthropic', id: 'claude', variant: 'high' });
    expect(parseModelRef('anthropic/claude')).toEqual({ providerID: 'anthropic', id: 'claude' });
    expect(parseModelRef('not-a-model')).toBeNull();
    expect(formatModelRef({ providerID: 'anthropic', id: 'claude', variant: 'high' })).toBe('anthropic/claude#high');
    expect(formatModelRef({ providerID: 'anthropic', id: 'claude' })).toBe('anthropic/claude');
  });
});

describe('agentLaunchOptions', () => {
  it('turns a model and tools into CLI args, and folds thinking into --thinking', () => {
    expect(agentLaunchOptions({ model: 'mock/m1#high', tools: ['read', 'grep'] })).toEqual({
      model: 'mock/m1:high',
      extraArgs: ['--tools', 'read,grep'],
    });
  });

  it('keeps a bare --thinking when the model carries no variant', () => {
    expect(agentLaunchOptions({ model: 'mock/m1', thinking: 'high' })).toEqual({
      model: 'mock/m1',
      extraArgs: ['--thinking', 'high'],
    });
  });

  it('appends the system prompt last', () => {
    expect(agentLaunchOptions({ system: 'Be terse.' }).extraArgs).toEqual(['--append-system-prompt', 'Be terse.']);
  });

  it('excludes the tools a profile lists and the tools its permissions deny outright', () => {
    const permissions = [
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'openchamber_web', resource: '*', effect: 'deny' },
      { action: 'edit', resource: 'src/*', effect: 'deny' },
    ];
    expect(agentLaunchOptions({ excludeTools: ['mcp__radius__*', 'bash'], permissions }).extraArgs).toEqual([
      '--exclude-tools',
      'mcp__radius__*,bash,powershell,openchamber_web',
    ]);
  });

  it('keeps a tool in the list while a narrower rule still lets some calls through', () => {
    const permissions = [
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'ls *', effect: 'allow' },
    ];
    expect(agentLaunchOptions({ permissions }).extraArgs).toEqual([]);
  });

  it('adds no exclusion for rules alone that only ask or allow', () => {
    expect(agentLaunchOptions({ permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }).extraArgs).toEqual([]);
  });

  it('is a no-op for an empty profile', () => {
    expect(agentLaunchOptions({})).toEqual({ extraArgs: [] });
  });
});

describe('createAgentStore', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  const makeStore = (extra = {}) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-agents-'));
    dirs.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const store = createAgentStore({ getAgentDir: () => agentDir, ...extra });
    return { store, agentDir, project };
  };

  it('creates a global agent and lists it in AgentInfo shape', async () => {
    const { store } = makeStore();
    const created = await store.create('reviewer', { description: 'Reviews diffs', model: 'anthropic/claude#high', mode: 'subagent', system: 'You review code.' }, null, 'user');
    expect(created.scope).toBe('user');
    expect(fs.existsSync(created.path)).toBe(true);

    const list = await store.list(null);
    const reviewer = list.find((agent) => agent.id === 'reviewer');
    expect(reviewer).toMatchObject({
      id: 'reviewer',
      name: 'reviewer',
      mode: 'subagent',
      hidden: false,
      description: 'Reviews diffs',
      model: { providerID: 'anthropic', id: 'claude', variant: 'high' },
      system: 'You review code.',
    });
  });

  it('round-trips steps and the sampling parameters the editor edits under request.body', async () => {
    const { store } = makeStore();
    await store.create('sampled', {
      mode: 'all',
      steps: 12,
      request: { body: { temperature: 0.2, top_p: 0.9 } },
    }, null, 'user');
    expect((await store.get('sampled', null)).profile).toMatchObject({ steps: 12, request: { body: { temperature: 0.2, top_p: 0.9 } } });

    await store.update('sampled', { steps: 7, request: { body: { temperature: 0.5 } } }, null);
    expect((await store.get('sampled', null)).profile).toMatchObject({ steps: 7, request: { body: { temperature: 0.5 } } });

    await store.update('sampled', { steps: null, request: null }, null);
    const cleared = (await store.get('sampled', null)).profile;
    expect(cleared).not.toHaveProperty('steps');
    expect(cleared).not.toHaveProperty('request');

    const listed = (await store.list(null)).find((agent) => agent.id === 'sampled');
    expect(listed.request).toEqual({ settings: {}, headers: {}, body: {} });
  });

  it('round-trips the tool allowlist and keeps it after unrelated updates', async () => {
    const { store } = makeStore();
    await store.create('reader', { tools: ['read', 'grep'], system: 'Read only.' }, null, 'user');
    expect((await store.get('reader', null)).profile.tools).toEqual(['read', 'grep']);
    await store.update('reader', { description: 'Updated' }, null);
    expect((await store.get('reader', null)).profile.tools).toEqual(['read', 'grep']);
    await store.update('reader', { tools: [] }, null);
    expect((await store.get('reader', null)).profile.tools).toEqual([]);
  });

  it('keeps a hand-written exclude_tools through an editor save that does not mention it', async () => {
    const { store } = makeStore();
    const created = await store.create('guarded', { exclude_tools: 'mcp__radius__*, bash', system: 'x' }, null, 'user');
    expect((await store.get('guarded', null)).profile.excludeTools).toEqual(['mcp__radius__*', 'bash']);
    await store.update('guarded', { description: 'Updated', permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] }, null);
    expect((await store.get('guarded', null)).profile.excludeTools).toEqual(['mcp__radius__*', 'bash']);
    expect(fs.readFileSync(created.path, 'utf8')).toContain('exclude_tools');
  });

  it('does not turn a broken agent directory into an empty successful list', async () => {
    const { store, agentDir } = makeStore();
    fs.mkdirSync(path.join(agentDir, 'openchamber'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'openchamber', 'agents'), 'not a directory');
    await expect(store.list(null)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('refuses a project write to an untrusted folder', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => false });
    await expect(store.create('x', { description: 'd' }, project, 'project')).rejects.toThrow(/not a trusted project/);
  });

  it('accepts a project write once the folder is trusted', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => true });
    const created = await store.create('x', { description: 'd' }, project, 'project');
    expect(created.scope).toBe('project');
  });

  it('create() refuses a name that already exists at the other scope, matching the host agent.js precedent', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => true });
    await store.create('dup', { description: 'global' }, null, 'user');
    await expect(store.create('dup', { description: 'project' }, project, 'project')).rejects.toThrow(/already exists/);
  });

  it('a hand-placed project file overrides a global one of the same id in list(), without going through create()', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => true });
    await store.create('dup', { description: 'global' }, null, 'user');
    fs.mkdirSync(path.join(project, '.pi', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(project, '.pi', 'agents', 'dup.md'), '---\ndescription: project\n---\n\nProject body');
    const list = await store.list(project);
    expect(list.filter((a) => a.id === 'dup')).toHaveLength(1);
    expect(list.find((a) => a.id === 'dup').description).toBe('project');
    // Without the project directory, only the global copy is visible.
    expect((await store.list(null)).find((a) => a.id === 'dup').description).toBe('global');
  });

  it('edits and re-enables a built-in without losing its mode or permission defaults', async () => {
    const { store } = makeStore();
    await store.update('build', { disabled: true, system: 'Custom build prompt.' }, null);
    const found = await store.get('build', null);
    expect(found.profile).toMatchObject({ mode: 'primary', disabled: true, system: 'Custom build prompt.' });
    expect(found.profile.permissions).toContainEqual({ action: 'read', resource: '*.env', effect: 'ask' });
    expect(await store.listDisabled(null)).toContainEqual(expect.objectContaining({ name: 'build' }));
    await store.update('build', { disabled: false }, null);
    expect(await store.listDisabled(null)).toEqual([]);
  });

  it('lists nested names created through the same editor', async () => {
    const { store } = makeStore();
    await store.create('team/reviewer', { tools: ['read'] }, null, 'user');
    expect(await store.list(null)).toContainEqual(expect.objectContaining({ id: 'team/reviewer' }));
  });

  it('updates fields and clears one with null', async () => {
    const { store } = makeStore();
    await store.create('u', { description: 'first', color: '#112233' }, null, 'user');
    await store.update('u', { description: 'second', color: null }, null);
    const config = (await store.list(null)).find((a) => a.id === 'u');
    expect(config.description).toBe('second');
    expect(config.color).toBeUndefined();
  });

  it('rejects an id containing ":"', async () => {
    const { store } = makeStore();
    await expect(store.create('bad:name', { description: 'd' }, null, 'user')).rejects.toThrow(/cannot contain ":"/);
  });

  it('deletes an agent by scope', async () => {
    const { store } = makeStore();
    const created = await store.create('gone', { description: 'd' }, null, 'user');
    await store.remove('gone', null, 'user');
    expect(fs.existsSync(created.path)).toBe(false);
  });
});

describe('an agent profile applied to a real Pi child', () => {
  it('reaches the model with the allowlisted tools and the system prompt appended', async () => {
    const mock = await startMockOpenAi();
    const fixture = createPiFixture({ mockPort: mock.port });
    try {
      const launch = agentLaunchOptions({ tools: ['read', 'grep'], system: 'REVIEWER-MARKER' });
      const runtime = resolvePiRuntime();
      const events = [];
      const client = createPiRpcClient({
        command: runtime.command,
        args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_agent_test', approveProject: true, model: launch.model, extraArgs: launch.extraArgs })],
        cwd: fixture.project,
        env: { ...fixture.env, ...runtime.env },
        onEvent: (event) => events.push(event),
      });
      try {
        await client.request('prompt', { message: 'PLAIN hello' });
        const startedAt = Date.now();
        while (!events.some((event) => event.type === 'agent_end') && Date.now() - startedAt < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const last = mock.requests.at(-1);
        expect(last.toolNames.sort()).toEqual(['grep', 'read']);
        const systemMessage = last.messages.find((message) => message.role === 'system' || message.role === 'developer');
        expect(JSON.stringify(systemMessage)).toContain('REVIEWER-MARKER');
      } finally {
        client.kill('SIGKILL');
        await client.exited;
      }
    } finally {
      await mock.close();
      fixture.dispose();
    }
  }, 30_000);

  it('does not offer the model a tool the agent denies, an excluded name that matches nothing included', async () => {
    const mock = await startMockOpenAi();
    const fixture = createPiFixture({ mockPort: mock.port });
    try {
      const launch = agentLaunchOptions({
        excludeTools: ['not_a_tool'],
        permissions: [{ action: 'shell', resource: '*', effect: 'deny' }, { action: 'edit', resource: 'src/*', effect: 'deny' }],
      });
      const runtime = resolvePiRuntime();
      const events = [];
      const client = createPiRpcClient({
        command: runtime.command,
        args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_exclude_test', approveProject: true, extraArgs: launch.extraArgs })],
        cwd: fixture.project,
        env: { ...fixture.env, ...runtime.env },
        onEvent: (event) => events.push(event),
      });
      try {
        await client.request('prompt', { message: 'PLAIN hello' });
        const startedAt = Date.now();
        while (!events.some((event) => event.type === 'agent_end') && Date.now() - startedAt < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(mock.requests.at(-1).toolNames.sort()).toEqual(['edit', 'read', 'write']);
      } finally {
        client.kill('SIGKILL');
        await client.exited;
      }
    } finally {
      await mock.close();
      fixture.dispose();
    }
  }, 30_000);
});
