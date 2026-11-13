import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMcpStore } from '../pi/config-routes/mcp.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';

const createApp = () => {
  const calls = [];
  const record = (action) => (name) => {
    calls.push({ action, name });
    return {};
  };
  const app = express();
  app.use(express.json());
  registerConfigEntityRoutes(app, {
    resolveProjectDirectory: async () => ({ directory: '/work/project' }),
    resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
    piAgentStore: {
      create: record('createAgent'),
      remove: record('deleteAgent'),
    },
    piCommandStore: {
      create: record('createCommand'),
      remove: record('deleteCommand'),
    },
  });
  return { app, calls };
};

describe('MCP saves from a remote origin', () => {
  const createMcpApp = () => {
    const saved = [];
    const app = express();
    app.use(express.json());
    const record = (name, config) => {
      saved.push({ name, config });
      return {};
    };
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: '/work/project' }),
      resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
      // The Pi store translates OpenCode's shape to Pi's on write; the route
      // must hand it the body untouched.
      piMcpStore: { create: record, update: record },
      piAgentDir: () => '/home/user/.pi/agent',
    });
    return { app, saved };
  };

  it.each([
    ['nothing', undefined],
    ['oauth off', false],
    ['an empty block', {}],
    ['a custom redirect with an explicit port', { redirect_uri: 'https://proxy.example.com:8443/cb' }],
    ['a custom origin on the callback path', {
      redirect_uri: 'https://proxy.example.com/api/mcp/oauth/docs/callback',
      callback_port: 19876,
    }],
  ])('stores %s as sent; sign-in prepares the redirect', async (_label, oauth) => {
    const { app, saved } = createMcpApp();
    const body = { type: 'remote', url: 'https://mcp.example.com', oauth };

    await request(app)
      .post('/api/config/mcp/docs')
      .set('Host', 'chamber.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send(body)
      .expect(200);
    await request(app)
      .patch('/api/config/mcp/docs')
      .set('Host', 'chamber.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send(body)
      .expect(200);

    expect(saved.map((entry) => entry.config.oauth)).toEqual([oauth, oauth]);
  });
});

describe('MCP routes write Pi\'s mcp.json', () => {
  it('creates, lists, updates and deletes a server in the agent folder', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-mcp-routes-'));
    try {
      const agentDir = path.join(root, 'agent');
      const app = express();
      app.use(express.json());
      registerConfigEntityRoutes(app, {
        resolveProjectDirectory: async () => ({ directory: '/work/project' }),
        resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
        piMcpStore: createMcpStore({ getAgentDir: () => agentDir, isProjectTrusted: async () => true }),
        piAgentDir: () => agentDir,
      });

      await request(app).post('/api/config/mcp/docs').send({ type: 'remote', url: 'https://mcp.example.com', oauth: { redirect_uri: 'https://chamber.example.com/cb' } }).expect(200);
      const file = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
      expect(file.mcpServers.docs).toMatchObject({ type: 'http', url: 'https://mcp.example.com', oauth: { callbackUrl: 'https://chamber.example.com/cb' }, exposure: 'direct' });

      const list = (await request(app).get('/api/config/mcp').expect(200)).body;
      expect(list).toEqual([expect.objectContaining({ name: 'docs', type: 'remote', url: 'https://mcp.example.com', scope: 'user' })]);

      await request(app).patch('/api/config/mcp/docs').send({ disabled: true }).expect(200);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers.docs.enabled).toBe(false);

      await request(app).delete('/api/config/mcp/docs').expect(200);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('snippet routes beside Pi configuration', () => {
  it('preserves listing, preview and CRUD without consuming expand as a name', async () => {
    const calls = [];
    const record = (action, result) => (...args) => { calls.push({ action, args }); return result; };
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
      listSnippets: record('list', [{ name: 'greeting' }]),
      getSnippet: record('get', { name: 'greeting' }),
      previewSnippet: record('preview', 'previewed'),
      createSnippet: record('create', { name: 'greeting' }),
      updateSnippet: record('update', { name: 'greeting' }),
      deleteSnippet: record('delete'),
    });
    expect((await request(app).get('/api/config/snippets').expect(200)).body).toEqual([{ name: 'greeting' }]);
    expect((await request(app).get('/api/config/snippets/greeting').expect(200)).body).toEqual({ name: 'greeting' });
    expect((await request(app).post('/api/config/snippets/expand').send({ content: 'hello' }).expect(200)).body).toEqual({ text: 'previewed' });
    await request(app).post('/api/config/snippets/greeting').send({ content: 'hello', scope: 'project' }).expect(200);
    await request(app).patch('/api/config/snippets/greeting').send({ content: 'updated' }).expect(200);
    await request(app).delete('/api/config/snippets/greeting').expect(200);
    expect(calls).toEqual([
      { action: 'list', args: ['/work/project'] },
      { action: 'get', args: ['greeting', '/work/project'] },
      { action: 'preview', args: ['hello', '/work/project'] },
      { action: 'create', args: ['greeting', { content: 'hello', scope: 'project' }, '/work/project', 'project'] },
      { action: 'update', args: ['greeting', { content: 'updated' }, '/work/project'] },
      { action: 'delete', args: ['greeting', '/work/project'] },
    ]);
  });
});

describe('config entity names', () => {
  it.each([
    ['post', '/api/config/agents/..%2F..%2Fescape'],
    ['delete', '/api/config/agents/%2Ftmp%2Fescape'],
    ['post', '/api/config/commands/group%2F..%2F..%2Fescape'],
    ['delete', '/api/config/commands/..%5Cescape'],
  ])('refuses %s %s before it reaches the filesystem', async (method, url) => {
    const { app, calls } = createApp();
    const response = await request(app)[method](url).send({});
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts plain and nested names', async () => {
    const { app, calls } = createApp();
    expect((await request(app).post('/api/config/agents/reviewer').send({})).status).toBe(200);
    expect((await request(app).post('/api/config/commands/git%2Fcommit').send({})).status).toBe(200);
    expect(calls).toEqual([
      { action: 'createAgent', name: 'reviewer' },
      { action: 'createCommand', name: 'git/commit' },
    ]);
  });
});
