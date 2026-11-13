import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiBridge } from '../bridge/index.js';
import { createHarness, PASSWORD } from './test-harness.js';

// The path a user takes: add a custom endpoint in Settings (the form's two
// calls, the config write and then the key), then chat on it. The provider is
// written by these routes into models.json and auth.json; the chat runs in the
// real Pi bridge over the same agent directory, against the mock OpenAI server.

const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

let h;
let bridge;
afterEach(async () => {
  await bridge?.close();
  bridge = null;
  await h?.dispose();
  h = null;
});

const waitFor = async (predicate, timeoutMs = 30_000) => {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('a custom endpoint added through the provider routes', () => {
  it('is listed by the bridge and answers a real prompt on its own model', async () => {
    h = await createHarness();
    const form = await request(h.app).put('/api/provider').send({
      providerID: 'custom-mock',
      scope: 'user',
      hasCredential: true,
      config: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'Custom Mock',
        settings: { baseURL: `http://127.0.0.1:${h.mock.port}/v1` },
        models: { 'custom-model': { modelID: 'custom-model', name: 'Custom Model', limit: { context: 32000, output: 4096 } } },
      },
    });
    expect(form.status).toBe(200);
    // The page stores the key right after the config write.
    expect((await h.json('POST', '/api/integration/custom-mock/connect/key', { key: 'fake-custom-key' })).status).toBe(204);

    fs.mkdirSync(path.join(h.fixture.root, 'data'), { recursive: true });
    bridge = await createPiBridge({
      password: PASSWORD,
      dataDir: path.join(h.fixture.root, 'data'),
      agentDir: h.fixture.agentDir,
      getBaseEnv: () => h.fixture.env,
      getDefaultDirectory: () => h.fixture.project,
      isTrusted: async () => true,
      log: () => {},
    });
    const call = (method, route, body) => fetch(`${bridge.url}${route}`, {
      method,
      headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const models = (await (await call('GET', '/api/model')).json()).data.map((model) => `${model.providerID}/${model.id}`);
    expect(models).toContain('custom-mock/custom-model');

    const created = await call('POST', '/api/session', { id: 'ses_custom_provider', model: { providerID: 'custom-mock', id: 'custom-model' }, location: { directory: h.fixture.project } });
    expect(created.status).toBe(200);
    const requestsBefore = h.mock.requests.length;
    const prompt = await call('POST', '/api/session/ses_custom_provider/prompt', { text: 'PLAIN hello custom endpoint' });
    expect(prompt.status).toBe(200);

    const assistant = await waitFor(async () => {
      const page = await (await call('GET', '/api/session/ses_custom_provider/message?limit=100&order=asc')).json();
      return page.data.find((message) => message.type === 'assistant' && message.finish === 'stop');
    });
    expect(assistant.content[0]).toMatchObject({ type: 'text', text: 'plain answer' });
    expect(assistant.model).toMatchObject({ providerID: 'custom-mock', id: 'custom-model' });
    expect(h.mock.requests.length).toBeGreaterThan(requestsBefore);
  }, 90_000);

  it('stops being offered when its key is removed', async () => {
    h = await createHarness();
    await request(h.app).put('/api/provider').send({
      providerID: 'custom-mock',
      scope: 'user',
      hasCredential: true,
      config: {
        name: 'Custom Mock',
        settings: { baseURL: `http://127.0.0.1:${h.mock.port}/v1` },
        models: { 'custom-model': { modelID: 'custom-model', name: 'Custom Model' } },
      },
    });
    await h.json('POST', '/api/integration/custom-mock/connect/key', { key: 'fake-custom-key' });
    expect(await h.modelIds()).toContain('custom-mock/custom-model');
    await h.json('DELETE', '/api/credential/cred_custom-mock');
    expect(await h.modelIds()).toEqual(['mock/mock-model']);
    // The endpoint stays declared, so the form can still edit it and a new key brings it back.
    expect(h.readJson('models.json').providers['custom-mock']).toBeDefined();
  });
});
