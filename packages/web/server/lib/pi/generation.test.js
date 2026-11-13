import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBridgeHttpServer } from './bridge/http.js';
import { createGenerateRoutes } from './bridge/routes/generate.js';
import { createPiGeneration } from './generation.js';
import { startMockOpenAi } from './test-support/mock-openai.js';
import { createPiFixture } from './test-support/pi-fixture.js';

const PASSWORD = 'gen-pw';
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

describe('generation through Pi\'s provider layer', () => {
  let mock;
  let fixture;
  let bridge;
  let base;

  const serve = async (generation) => {
    bridge = createBridgeHttpServer({ password: PASSWORD, routes: createGenerateRoutes({ generation }) });
    const address = await bridge.listen();
    base = `http://127.0.0.1:${address.port}`;
  };
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await bridge?.close();
    await mock.close();
    fixture.dispose();
  });

  it('answers a text prompt with the model\'s text, using the given model', async () => {
    await serve(createPiGeneration({ getAgentDir: () => fixture.agentDir }));
    const response = await post('/api/experimental/generate/text', { prompt: 'Name this chat', model: { providerID: 'mock', id: 'mock-model' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { text: '## Goal\nMock summary' } });
    expect(mock.requests.at(-1).messages.at(-1)).toMatchObject({ role: 'user', content: 'Name this chat' });
  });

  it('falls back to Pi\'s default model when the request names none, and serves the legacy path', async () => {
    const response = await post('/api/experimental/generate', { prompt: 'hello' });
    expect(response.status).toBe(200);
    expect((await response.json()).data.text).toContain('Mock summary');
  });

  it('answers a model Pi does not have with the tagged 404 the small-model helper retries on', async () => {
    const missing = await post('/api/experimental/generate/text', { prompt: 'x', model: { providerID: 'mock', id: 'nope' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ _tag: 'ModelNotFoundError', providerID: 'mock', modelID: 'nope' });

    const unknown = await post('/api/experimental/generate/text', { prompt: 'x', model: { providerID: 'ghost', id: 'm' } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ _tag: 'ProviderNotFoundError', providerID: 'ghost' });
  });

  it('reports a provider that fails as a 502 ProviderRequestError with a reason', async () => {
    const response = await post('/api/experimental/generate/text', { prompt: 'ERR500 please', model: { providerID: 'mock', id: 'mock-model' } });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ _tag: 'ProviderRequestError', providerID: 'mock', reason: 'provider' });
  });

  it('validates the request before touching a provider', async () => {
    const noPrompt = await post('/api/experimental/generate/text', {});
    expect(noPrompt.status).toBe(400);
    expect(await noPrompt.json()).toMatchObject({ _tag: 'InvalidRequestError', kind: 'Payload' });
    expect((await post('/api/experimental/generate/text', { prompt: 'x', model: { id: 'm' } })).status).toBe(400);
    expect((await post('/api/experimental/generate/image', { prompt: 'x' })).status).toBe(400);
    expect((await post('/api/experimental/generate/image', { prompt: 'x', model: { providerID: 'p', id: 'm' }, n: 99 })).status).toBe(400);
  });

  describe('images, with a stand-in runtime', () => {
    const png = 'iVBORw0KGgo=';
    const stubSdk = (behavior) => async () => ({
      ModelRuntime: {
        create: async () => ({
          getProvider: (id) => (id === 'pics' ? { id } : undefined),
          getModel: (provider, id) => (provider === 'mock' && id === 'chat' ? { provider, id } : undefined),
          getModelOfType: (type, provider, id) => (type === 'image' && provider === 'pics' && id === 'paint' ? { provider, id, type } : undefined),
          generateImages: behavior,
        }),
      },
    });

    it('turns Pi\'s image blocks into the wire\'s images and passes references and options through', async () => {
      const calls = [];
      await bridge.close();
      await serve(createPiGeneration({ getAgentDir: () => fixture.agentDir, loadSdk: stubSdk(async (model, context, options) => {
        calls.push({ model, context, options });
        return { stopReason: 'stop', output: [{ type: 'text', text: 'caption' }, { type: 'image', data: png, mimeType: 'image/png' }], usage: { input: 3, output: 1 } };
      }) }));

      const response = await post('/api/experimental/generate/image', {
        model: { providerID: 'pics', id: 'paint' }, prompt: 'a red square', n: 2, aspect: '1:1', resolution: '2K', images: [{ data: 'AAAA', mime: 'image/jpeg', name: 'ref.jpg' }],
      });
      expect(response.status).toBe(200);
      const { data } = await response.json();
      expect(data.images).toEqual([{ data: png, mime: 'image/png', type: 'image' }, { data: png, mime: 'image/png', type: 'image' }]);
      expect(data.usage).toEqual({ input: 3, output: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[0].context.input).toEqual([{ type: 'text', text: 'a red square' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
      expect(calls[0].options.metadata).toEqual({ aspect: '1:1', resolution: '2K' });
    });

    it('answers 422 for a chat model asked for images and 404 for an unknown one', async () => {
      const chat = await post('/api/experimental/generate/image', { model: { providerID: 'mock', id: 'chat' }, prompt: 'x' }).catch(() => null);
      // `mock` is not a provider of this stand-in runtime: it is unknown there.
      expect(chat.status).toBe(404);
      await bridge.close();
      await serve(createPiGeneration({ getAgentDir: () => fixture.agentDir, loadSdk: async () => ({ ModelRuntime: { create: async () => ({
        getProvider: () => ({}),
        getModel: () => ({ provider: 'pics', id: 'chatty' }),
        getModelOfType: () => undefined,
      }) } }) }));
      const unsupported = await post('/api/experimental/generate/image', { model: { providerID: 'pics', id: 'chatty' }, prompt: 'x' });
      expect(unsupported.status).toBe(422);
      expect(await unsupported.json()).toMatchObject({ _tag: 'UnsupportedModelError', capability: 'generate images' });
    });

    it('reports a failed generation as a ProviderRequestError', async () => {
      await bridge.close();
      await serve(createPiGeneration({ getAgentDir: () => fixture.agentDir, loadSdk: stubSdk(async () => ({ stopReason: 'error', errorMessage: '401 invalid api key', output: [] })) }));
      const response = await post('/api/experimental/generate/image', { model: { providerID: 'pics', id: 'paint' }, prompt: 'x' });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ _tag: 'ProviderRequestError', providerID: 'pics', reason: 'authentication' });
    });
  });
});
