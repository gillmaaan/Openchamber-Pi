import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from '../launch.js';
import { createPiRpcClient } from '../rpc-client.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { startMockOpenAi } from '../test-support/mock-openai.js';
import {
  createCommandStore,
  ensureBuiltinCommands,
  registerCommandConfigRoutes,
} from './commands.js';

describe('createCommandStore', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  const makeStore = (extra = {}) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-commands-'));
    dirs.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const store = createCommandStore({ getAgentDir: () => agentDir, ...extra });
    return { store, agentDir, project };
  };

  it('creates, reads and updates a global prompt template', async () => {
    const { store, agentDir } = makeStore();
    const created = await store.create('greet', { template: 'Hi $1', description: 'Says hi' }, null, 'user');
    expect(created.scope).toBe('user');
    expect(fs.readFileSync(path.join(agentDir, 'prompts', 'greet.md'), 'utf8')).toContain('Hi $1');

    const config = await store.getConfig('greet', null);
    expect(config).toMatchObject({ source: 'md', scope: 'user', config: { template: 'Hi $1', description: 'Says hi' } });

    await store.update('greet', { description: 'Updated', model: 'anthropic/claude' }, null);
    const updated = await store.getConfig('greet', null);
    expect(updated.config.description).toBe('Updated');
    // `model` has no Pi equivalent; it is kept as plain frontmatter for the UI to show.
    expect(updated.config.model).toBe('anthropic/claude');
  });

  it('a project template needs a trusted project', async () => {
    const { store, project } = makeStore({ isProjectTrusted: async () => false });
    await expect(store.create('x', { template: 't' }, project, 'project')).rejects.toThrow(/not a trusted project/);
  });

  it('deletes a template', async () => {
    const { store } = makeStore();
    const created = await store.create('gone', { template: 't' }, null, 'user');
    await store.remove('gone', null);
    expect(fs.existsSync(created.path)).toBe(false);
    await expect(store.remove('gone', null)).rejects.toThrow(/not found/);
  });
});

describe('registerCommandConfigRoutes', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const mutations = [
    ['post', 'create'],
    ['patch', 'update'],
    ['delete', 'remove'],
  ];

  const makeRoute = (method, overrides = {}) => {
    const handlers = new Map();
    const app = { use() {} };
    for (const verb of ['get', 'post', 'patch', 'delete']) {
      app[verb] = (route, handler) => handlers.set(`${verb} ${route}`, handler);
    }
    const dependencies = {
      store: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      resolveProjectDirectory: async () => ({ directory: '/work/project' }),
      resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
      onChanged: vi.fn(),
      ...overrides,
    };
    registerCommandConfigRoutes(app, dependencies);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const invoke = (body = { template: 'Hi $1', scope: 'project' }) => handlers.get(`${method} /api/config/commands/:name`)(
      { params: { name: 'greet' }, body },
      response,
    );
    return { ...dependencies, response, invoke };
  };

  it.each(mutations)('%s waits for the mutation and invalidation before success', async (method, operation) => {
    const events = [];
    const store = {
      [operation]: vi.fn(async () => {
        await Promise.resolve();
        events.push('stored');
        return { scope: 'project', path: '/work/project/.pi/prompts/greet.md' };
      }),
    };
    const onChanged = vi.fn(async () => {
      events.push('invalidating');
      await Promise.resolve();
      events.push('invalidated');
    });
    const { response, invoke } = makeRoute(method, { store, onChanged });
    response.json.mockImplementation(() => { events.push('responded'); return response; });

    await invoke();

    expect(events).toEqual(['stored', 'invalidating', 'invalidated', 'responded']);
    expect(store[operation]).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each(mutations)('%s skips invalidation when the store mutation fails', async (method, operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = { [operation]: vi.fn().mockRejectedValue(new Error('Write failed')) };
    const { onChanged, response, invoke } = makeRoute(method, { store });

    await invoke();

    expect(store[operation]).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ error: 'Write failed' });
  });

  it.each(mutations)('%s reports invalidation failure after the mutation', async (method, operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = { [operation]: vi.fn().mockResolvedValue({ scope: 'project' }) };
    const onChanged = vi.fn().mockRejectedValue(new Error('Invalidation failed'));
    const { response, invoke } = makeRoute(method, { store, onChanged });

    await invoke();

    expect(store[operation]).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ error: 'Invalidation failed' });
  });

  it.each(['patch', 'delete'])('%s refuses a directory error before any store call', async (method) => {
    const { store, onChanged, response, invoke } = makeRoute(method, {
      resolveOptionalProjectDirectory: async () => ({ directory: null, error: 'Invalid directory' }),
    });

    await invoke();

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ error: 'Invalid directory' });
    for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each(['user', undefined, 'project'])('post refuses an invalid directory for scope %s', async (scope) => {
    const failedResolver = async () => ({ directory: null, error: 'Invalid directory' });
    const { store, onChanged, response, invoke } = makeRoute('post', {
      resolveProjectDirectory: failedResolver,
      resolveOptionalProjectDirectory: failedResolver,
    });

    await invoke({ template: 'Hi $1', ...(scope ? { scope } : {}) });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ error: 'Invalid directory' });
    expect(store.create).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each(['user', undefined])('post allows an omitted directory for global scope %s', async (scope) => {
    const resolveProjectDirectory = vi.fn(async () => ({ directory: null, error: 'No active project' }));
    const { store, onChanged, response, invoke } = makeRoute('post', {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory: async () => ({ directory: null, error: null }),
    });

    await invoke({ template: 'Hi $1', ...(scope ? { scope } : {}) });

    expect(resolveProjectDirectory).not.toHaveBeenCalled();
    expect(store.create).toHaveBeenCalledExactlyOnceWith('greet', { template: 'Hi $1' }, null, scope);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('post requires a directory for project scope even when the resolver returns no error', async () => {
    const missingDirectory = async () => ({ directory: null, error: null });
    const { store, onChanged, response, invoke } = makeRoute('post', {
      resolveProjectDirectory: missingDirectory,
      resolveOptionalProjectDirectory: missingDirectory,
    });

    await invoke();

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ error: 'Project scope requires a directory' });
    expect(store.create).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each(mutations)('%s still succeeds without an invalidation callback', async (method) => {
    const { response, invoke } = makeRoute(method, { onChanged: undefined });

    await invoke();

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe('ensureBuiltinCommands', () => {
  it('writes init and review once, and never overwrites an existing file', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-builtins-'));
    try {
      const agentDir = path.join(root, 'agent');
      ensureBuiltinCommands({ getAgentDir: () => agentDir });
      const initPath = path.join(agentDir, 'prompts', 'init.md');
      const reviewPath = path.join(agentDir, 'prompts', 'review.md');
      expect(fs.existsSync(initPath)).toBe(true);
      expect(fs.existsSync(reviewPath)).toBe(true);
      expect(fs.readFileSync(initPath, 'utf8')).toContain('AGENTS.md');

      fs.writeFileSync(initPath, '---\ndescription: mine\n---\n\nMy own init.');
      ensureBuiltinCommands({ getAgentDir: () => agentDir });
      expect(fs.readFileSync(initPath, 'utf8')).toContain('My own init.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a prompt template run as a command through a real Pi child', () => {
  it('expands $1/$@/$ARGUMENTS before the model ever sees it', async () => {
    const mock = await startMockOpenAi();
    const fixture = createPiFixture({ mockPort: mock.port });
    try {
      fs.mkdirSync(path.join(fixture.agentDir, 'prompts'), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.agentDir, 'prompts', 'greet.md'),
        '---\ndescription: Greets someone\n---\n\nSay hi to $1 (all: $@) [PLAIN]\n',
      );
      const runtime = resolvePiRuntime();
      const events = [];
      const client = createPiRpcClient({
        command: runtime.command,
        args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: 'ses_cmd_test', approveProject: true })],
        cwd: fixture.project,
        env: { ...fixture.env, ...runtime.env },
        onEvent: (event) => events.push(event),
      });
      try {
        await client.request('prompt', { message: '/greet Ada "the engineer"' });
        const startedAt = Date.now();
        while (!events.some((event) => event.type === 'agent_end') && Date.now() - startedAt < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const sentText = mock.requests.at(-1).messages.filter((message) => message.role === 'user').at(-1).content;
        const text = typeof sentText === 'string' ? sentText : JSON.stringify(sentText);
        expect(text).toContain('Say hi to Ada');
        expect(text).toContain('Ada the engineer');
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
