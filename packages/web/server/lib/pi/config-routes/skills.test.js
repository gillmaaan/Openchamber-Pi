import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../launch.js';
import { createPiRpcClient } from '../rpc-client.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { startMockOpenAi } from '../test-support/mock-openai.js';
import { createSkillResolver, createSkillStore } from './skills.js';

describe('createSkillStore', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  const makeStore = (extra = {}) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-skills-'));
    dirs.push(root);
    const agentDir = path.join(root, 'agent');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const store = createSkillStore({ getAgentDir: () => agentDir, getHomeDir: () => home, ...extra });
    return { store, agentDir, home, project };
  };

  it('creates a global skill and lists it with its scope and source inferred from its path', async () => {
    const { store } = makeStore();
    const created = await store.create('demo-skill', { description: 'A demo skill', instructions: 'Do the demo thing.' }, null, 'user');
    expect(created.scope).toBe('user');
    expect(fs.existsSync(created.path)).toBe(true);

    const list = await store.list(null);
    const skill = list.find((entry) => entry.id === 'demo-skill');
    expect(skill).toMatchObject({ name: 'demo-skill', description: 'A demo skill', scope: 'user', source: 'pi' });
    expect(skill.content).toContain('Do the demo thing.');
  });

  it('requires a description', async () => {
    const { store } = makeStore();
    await expect(store.create('no-desc', { instructions: 'x' }, null, 'user')).rejects.toThrow(/description is required/);
  });

  it('rejects an invalid name', async () => {
    const { store } = makeStore();
    await expect(store.create('Not Valid', { description: 'd' }, null, 'user')).rejects.toThrow(/Invalid skill name/);
  });

  it('writes a user/agents skill under ~/.agents/skills', async () => {
    const { store, home } = makeStore();
    const created = await store.create('agents-skill', { description: 'd', source: 'agents' }, null, 'user');
    expect(created.path).toBe(path.join(home, '.agents', 'skills', 'agents-skill', 'SKILL.md'));
    const skill = (await store.list(null)).find((entry) => entry.id === 'agents-skill');
    expect(skill.source).toBe('agents');
  });

  it('a project skill needs a trusted project', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => false });
    await expect(store.create('x', { description: 'd' }, project, 'project')).rejects.toThrow(/not a trusted project/);
    // Untrusted also means it is never listed, even if written by hand.
    fs.mkdirSync(path.join(project, '.pi', 'skills', 'manual'), { recursive: true });
    fs.writeFileSync(path.join(project, '.pi', 'skills', 'manual', 'SKILL.md'), '---\nname: manual\ndescription: d\n---\n\nBody');
    expect((await store.list(project)).find((entry) => entry.id === 'manual')).toBeUndefined();
  });

  it('creates a project skill once trusted, and infers project scope', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => true });
    const created = await store.create('proj-skill', { description: 'd' }, project, 'project');
    expect(created.scope).toBe('project');
    const skill = (await store.list(project)).find((entry) => entry.id === 'proj-skill');
    expect(skill).toMatchObject({ scope: 'project', source: 'pi' });
  });

  it('updates instructions and supporting files, and renames in place', async () => {
    const { store } = makeStore();
    await store.create('rename-me', { description: 'd', instructions: 'v1' }, null, 'user');
    await store.update('rename-me', { instructions: 'v2', supportingFiles: [{ path: 'notes.txt', content: 'hello' }] }, null);
    let skill = (await store.list(null)).find((entry) => entry.id === 'rename-me');
    expect(skill.content).toBe('v2');
    expect(fs.readFileSync(path.join(path.dirname(skill.path), 'notes.txt'), 'utf8')).toBe('hello');

    await store.rename('rename-me', 'renamed', null);
    skill = (await store.list(null)).find((entry) => entry.id === 'renamed');
    expect(skill).toBeDefined();
    expect((await store.list(null)).find((entry) => entry.id === 'rename-me')).toBeUndefined();
  });

  it('deletes a skill directory', async () => {
    const { store } = makeStore();
    const created = await store.create('bye', { description: 'd' }, null, 'user');
    await store.remove('bye', null, null);
    expect(fs.existsSync(path.dirname(created.path))).toBe(false);
  });
});

describe('createSkillResolver', () => {
  it('wraps the SKILL.md body in <skill_content name="...">, matching wire spec 6.1', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-resolve-'));
    try {
      const agentDir = path.join(root, 'agent');
      const store = createSkillStore({ getAgentDir: () => agentDir, getHomeDir: () => path.join(root, 'home') });
      await store.create('wrapped', { description: 'd', instructions: 'The body.' }, null, 'user');
      const resolveSkill = createSkillResolver(store);
      const resolved = await resolveSkill('wrapped', null);
      expect(resolved).toEqual({ id: 'wrapped', name: 'wrapped', text: '<skill_content name="wrapped">\nThe body.\n</skill_content>' });
      expect(await resolveSkill('missing', null)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a skill created through the store shows up in /api/skill and its text is attached to a real prompt', () => {
  it('reaches the model wrapped in <skill_content>, same as wire spec 6.1', async () => {
    const mock = await startMockOpenAi();
    const fixture = createPiFixture({ mockPort: mock.port });
    try {
      const store = createSkillStore({ getAgentDir: () => fixture.agentDir, getHomeDir: () => fixture.home });
      await store.create('live-skill', { description: 'A live skill', instructions: 'SKILLBODY-MARKER' }, null, 'user');

      // The same bridge-owned scanner `/api/skill` uses also finds it, so the
      // two routes can never disagree about what Pi will load.
      const listed = (await store.list(fixture.project)).find((entry) => entry.id === 'live-skill');
      expect(listed).toBeDefined();

      const runtime = resolvePiRuntime();
      const events = [];
      const client = createPiRpcClient({
        command: runtime.command,
        args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_skill_test', approveProject: true })],
        cwd: fixture.project,
        env: { ...fixture.env, ...runtime.env },
        onEvent: (event) => events.push(event),
      });
      try {
        const resolveSkill = createSkillResolver(store);
        const resolved = await resolveSkill('live-skill', fixture.project);
        await client.request('prompt', { message: `${resolved.text}\n\nPLAIN use the skill` });
        const startedAt = Date.now();
        while (!events.some((event) => event.type === 'agent_end') && Date.now() - startedAt < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const sentContent = mock.requests.at(-1).messages.filter((message) => message.role === 'user').at(-1).content;
        const text = typeof sentContent === 'string' ? sentContent : sentContent.map((part) => part?.text ?? '').join('\n');
        expect(text).toContain('<skill_content name="live-skill">');
        expect(text).toContain('SKILLBODY-MARKER');
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
