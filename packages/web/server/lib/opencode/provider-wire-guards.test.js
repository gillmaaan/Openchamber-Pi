import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// The guards stand in front of the proxied wire routes; the provider config
// routes of the Pi runtime enforce enterprise mode themselves (lib/pi/providers).
const createApp = () => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    resolveProjectDirectory: vi.fn(async () => ({ directory: '/projects/app' })),
  });
  return app;
};

describe('provider writes in enterprise mode', () => {
  const writes = (agent) => [
    agent.post('/api/integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration/anthropic/connect/oauth').send({ methodID: 'claude-pro' }),
    agent.post('/api/integration/anthropic/connect/oauth/att_1/complete').send({ code: 'x' }),
    agent.post('/api/integration/github-copilot/connect/command').send({ methodID: 'cli' }),
    agent.post('/api/experimental/integration/wellknown').send({ url: 'https://example.test' }),
    // OpenCode routes these to the key handler too.
    agent.post('/API/integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api//integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration/openai/%63onnect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration\\openai\\connect\\key').send({ key: 'sk-test' }),
    agent.post('/api/experimental/integration/wellknown;x').send({ url: 'https://example.test' }),
    agent.post('/api/credential').send({ integrationID: 'openai', value: { type: 'key', key: 'sk-test' } }),
    agent.post('/API//credential').send({ integrationID: 'openai', value: { type: 'key', key: 'sk-test' } }),
  ];

  it('refuses connecting a provider or adding a key', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const agent = request(createApp());
      for (const response of await Promise.all(writes(agent))) {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('enterprise_mode');
      }
      // Removing an account only narrows access and still reaches the agent service.
      expect((await agent.delete('/api/credential/cred_1')).status).toBe(404);
      expect((await agent.post('/api/credential/cred_1/activate')).status).toBe(404);
      // Signing in to a remote MCP server reaches a tool server, not a model provider.
      const mcpSignIn = [
        agent.post('/api/integration/mcp_0123456789abcdef/connect/oauth').send({ methodID: 'mcp_0123456789abcdef' }),
        agent.post('/api/integration/mcp_0123456789abcdef/connect/oauth/att_1/complete').send({ code: 'x' }),
      ];
      for (const response of await Promise.all(mcpSignIn)) {
        expect(response.status).toBe(404);
      }
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('passes the writes on to the proxy otherwise', async () => {
    const connect = await request(createApp()).post('/api/integration/openai/connect/key').send({ key: 'sk-test' });
    // No proxy in this app: falling through reads as Express's 404.
    expect(connect.status).toBe(404);
  });
});

describe('the stored credential list', () => {
  const reads = (agent) => [
    agent.get('/api/credential'),
    agent.get('/API//credential/'),
    agent.get('/api/%63redential'),
    agent.head('/api/credential'),
  ];

  it('never reaches a client, with or without enterprise mode', async () => {
    const agent = request(createApp());
    for (const response of await Promise.all(reads(agent))) {
      expect(response.status).toBe(403);
    }
    expect((await agent.get('/api/credential')).body.code).toBe('credential_list_refused');

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      for (const response of await Promise.all(reads(agent))) {
        expect(response.status).toBe(403);
      }
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('does not refuse renaming an account', async () => {
    // No proxy in this app: falling through reads as Express's 404.
    expect((await request(createApp()).patch('/api/credential/cred_1').send({ label: 'work' })).status).toBe(404);
  });
});
