import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandStore, ensureBuiltinCommands } from '../config-routes/commands.js';
import { createCommandResolver, resolveCommandRun } from './commands.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-command-resolution-'));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(project);
  let trusted = true;
  const store = createCommandStore({ getAgentDir: () => agentDir, isProjectTrusted: async () => trusted });
  return { agentDir, project, store, resolve: createCommandResolver(store), setTrusted: (value) => { trusted = value; } };
};

describe('command resolution', () => {
  it('uses native Pi quoting, positional, default and non-recursive argument substitution', async () => {
    const { store, resolve } = setup();
    await store.create('arguments', { template: '$1|$2|${3:-fallback}|${@:2}|$ARGUMENTS' }, null, 'user');
    expect((await resolve('arguments', '"Ada Lovelace" \'$1\'', null)).text).toBe('Ada Lovelace|$1|fallback|$1|Ada Lovelace $1');
  });

  it('resolves nested names and reads project trust afresh for every invocation', async () => {
    const { store, resolve, project, setTrusted } = setup();
    await store.create('group/proof', { template: 'Global $ARGUMENTS' }, null, 'user');
    const local = path.join(project, '.pi', 'prompts', 'group');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'proof.md'), 'Project $ARGUMENTS');
    expect((await resolve('group/proof', 'Ada', project)).text).toBe('Project Ada');
    setTrusted(false);
    expect((await resolve('group/proof', 'Grace', project)).text).toBe('Global Grace');
  });

  it('rejects missing and unsafe names rather than passing a slash command to the model', async () => {
    const { resolve } = setup();
    await expect(resolve('missing', '', null)).rejects.toMatchObject({ status: 404, tag: 'CommandNotFoundError' });
    for (const name of ['../outside', '/absolute', 'group/../outside', 'group\\outside']) {
      await expect(resolve(name, '', null)).rejects.toThrow('Invalid command name');
    }
  });

  it('materializes usable built-ins without replacing an edited template', async () => {
    const { store, resolve, agentDir } = setup();
    ensureBuiltinCommands({ getAgentDir: () => agentDir });
    expect((await resolve('init', 'focus on tests', null)).text).toContain('focus on tests');
    expect((await resolve('review', 'HEAD', null)).text).toContain('Review changes: HEAD');
    await store.update('review', { template: 'My review $ARGUMENTS' }, null);
    ensureBuiltinCommands({ getAgentDir: () => agentDir });
    expect((await resolve('review', 'changes', null)).text).toBe('My review changes');
  });
});

describe('command execution metadata', () => {
  const profiles = {
    build: { id: 'build', mode: 'primary' },
    parent: { id: 'parent', mode: 'primary', model: 'mock/parent-model' },
    worker: { id: 'worker', mode: 'subagent', model: 'mock/agent-model#high' },
    plain: { id: 'plain', mode: 'all', thinking: 'low' },
  };
  const known = new Set(['session-model', 'parent-model', 'agent-model', 'command-model']);
  const findModel = async (providerID, id) => (providerID === 'mock' && known.has(id) ? { thinkingLevels: ['default', 'low', 'high'] } : null);
  const record = { id: 'ses_command_meta', agent: 'parent' };
  const sessionModel = { providerID: 'mock', id: 'session-model', variant: 'low' };
  const run = (config, extra = {}) => resolveCommandRun({
    config,
    record,
    sessionModel,
    agentProfile: async (id) => {
      if (!profiles[id]) throw Object.assign(new Error(`Unknown agent: ${id}`), { status: 400 });
      return profiles[id];
    },
    findModel,
    ...extra,
  });

  it('keeps the session selection for a command that names neither agent nor model', async () => {
    expect(await run({})).toMatchObject({ agent: 'parent', model: null, child: false });
  });

  it('switches to a command model, or to a named agent and its pinned model, durably', async () => {
    expect(await run({ model: 'mock/command-model' })).toMatchObject({ agent: 'parent', model: { providerID: 'mock', id: 'command-model' }, child: false });
    expect(await run({ agent: 'parent' })).toMatchObject({ agent: 'parent', model: { providerID: 'mock', id: 'parent-model' } });
    expect(await run({ agent: 'parent', model: 'mock/command-model#low' })).toMatchObject({ model: { id: 'command-model', variant: 'low' } });
  });

  it('keeps the explicit session model for an agent that pins none', async () => {
    expect(await run({ agent: 'plain' })).toMatchObject({ agent: 'plain', model: null });
  });

  it('runs a subagent-mode agent, or subagent:true, in a child and lets subagent:false override it', async () => {
    expect(await run({ agent: 'worker' })).toMatchObject({ child: true, agent: 'worker', model: { id: 'agent-model', variant: 'high' } });
    expect(await run({ agent: 'worker', subagent: false })).toMatchObject({ child: false, agent: 'worker' });
    expect(await run({ agent: 'build', subagent: true })).toMatchObject({ child: true, model: { id: 'session-model', variant: 'low' } });
    expect(await run({ subagent: true })).toMatchObject({ child: true, agent: 'parent', model: { id: 'parent-model' } });
  });

  it('refuses a model Pi does not offer or a level it does not support, before any selection changes', async () => {
    await expect(run({ model: 'mock/missing-model' })).rejects.toMatchObject({ status: 404, tag: 'ModelNotFoundError' });
    await expect(run({ model: 'mock/command-model#xhigh' })).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError' });
    await expect(run({ model: 'not-a-model-ref' })).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError' });
  });
});
