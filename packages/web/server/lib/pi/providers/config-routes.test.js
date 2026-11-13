import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness } from './test-harness.js';

// The OpenChamber provider routes over real files in an isolated Pi agent
// directory: what lands in models.json and settings.json, what survives an
// edit, and what is refused. API keys are fake.

let h;
afterEach(async () => {
  delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  await h?.dispose();
  h = null;
});

const put = (route, body) => request(h.app).put(route).send(body);
const get = (route) => request(h.app).get(route);

const customConfig = (overrides = {}) => ({
  package: 'aisdk:@ai-sdk/openai-compatible',
  name: 'Custom Mock',
  settings: { baseURL: `http://127.0.0.1:${h.mock.port}/v1` },
  headers: { 'X-Team': 'blue' },
  models: {
    'mock-model': {
      modelID: 'mock-model',
      name: 'Mock Model',
      limit: { context: 32000, output: 4096 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }],
    },
  },
  ...overrides,
});
const save = (providerID = 'custom-mock', config = customConfig(), extra = {}) => put('/api/provider', { providerID, config, scope: 'user', hasCredential: true, ...extra });

describe('PUT /api/provider', () => {
  it('writes the custom provider into models.json in Pi\'s spelling and keeps the user\'s other providers and keys', async () => {
    h = await createHarness();
    const original = h.readJson('models.json');
    original.$schema = 'https://pi.dev/schemas/models.schema.json';
    original.$comment = 'mine';
    fs.writeFileSync(h.file('models.json'), JSON.stringify(original));

    const response = await save();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, providerId: 'custom-mock', path: h.file('models.json') });

    const written = h.readJson('models.json');
    expect(written.$schema).toBe('https://pi.dev/schemas/models.schema.json');
    expect(written.$comment).toBe('mine');
    expect(written.providers.mock).toEqual(original.providers.mock);
    expect(written.providers['custom-mock']).toEqual({
      name: 'Custom Mock',
      baseUrl: `http://127.0.0.1:${h.mock.port}/v1`,
      api: 'openai-completions',
      headers: { 'X-Team': 'blue' },
      models: [{
        id: 'mock-model',
        name: 'Mock Model',
        contextWindow: 32000,
        maxTokens: 4096,
        input: ['text', 'image'],
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high' },
      }],
    });
    // No key is written for a form that stores its key through the login.
    expect(written.providers['custom-mock'].apiKey).toBeUndefined();
    expect(h.types()).toEqual(['integration.updated', 'provider.updated', 'model.updated']);
  });

  it('creates models.json with the schema line when there is none, readable by the owner only', async () => {
    h = await createHarness();
    fs.rmSync(h.file('models.json'));
    expect((await save()).status).toBe(200);
    const written = h.readJson('models.json');
    expect(written.$schema).toBe('https://pi.dev/schemas/models.schema.json');
    expect(Object.keys(written.providers)).toEqual(['custom-mock']);
    if (process.platform !== 'win32') expect(fs.statSync(h.file('models.json')).mode & 0o077).toBe(0);
  });

  it('lists the provider and its models in /api/model and /api/provider once a key is stored', async () => {
    h = await createHarness();
    await save();
    // Declared, but no key yet: Pi does not offer its models.
    expect(await h.modelIds()).toEqual(['mock/mock-model']);
    expect((await h.json('POST', '/api/integration/custom-mock/connect/key', { key: 'fake-custom-key' })).status).toBe(204);
    expect(await h.modelIds()).toEqual(['custom-mock/mock-model', 'mock/mock-model']);
    const model = (await h.json('GET', '/api/model')).body.data.find((entry) => entry.providerID === 'custom-mock');
    expect(model).toMatchObject({ name: 'Mock Model', limit: { context: 32000, output: 4096 }, capabilities: { input: ['text', 'image'] } });
    expect(model.variants.map((variant) => variant.id)).toEqual(['off', 'low', 'high']);
    const provider = (await h.json('GET', '/api/provider')).body.data.find((entry) => entry.id === 'custom-mock');
    expect(provider).toMatchObject({ activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${h.mock.port}/v1` } });
  });

  it('is read back by the edit form in the form\'s own spelling', async () => {
    h = await createHarness();
    await save('custom-mock', customConfig({ env: ['MOCK_KEY'] }), { hasCredential: false });
    const source = await get('/api/provider/custom-mock/source');
    expect(source.status).toBe(200);
    expect(source.body).toEqual({
      providerId: 'custom-mock',
      sources: {
        auth: { exists: false },
        user: { exists: true, path: h.file('models.json') },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
      },
      config: {
        name: 'Custom Mock',
        package: 'aisdk:@ai-sdk/openai-compatible',
        env: ['MOCK_KEY'],
        settings: { baseURL: `http://127.0.0.1:${h.mock.port}/v1` },
        headers: { 'X-Team': 'blue' },
        models: {
          'mock-model': {
            modelID: 'mock-model',
            name: 'Mock Model',
            limit: { context: 32000, output: 4096 },
            capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
            variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }],
          },
        },
      },
    });
    expect(h.readJson('models.json').providers['custom-mock'].apiKey).toBe('$MOCK_KEY');

    const missing = await get('/api/provider/nobody/source');
    expect(missing.body).toMatchObject({ sources: { user: { exists: false } }, config: null });
  });

  it('keeps what the form does not manage when the provider is edited, and drops what the form removes', async () => {
    h = await createHarness();
    await save();
    const edited = h.readJson('models.json');
    const entry = edited.providers['custom-mock'];
    entry.compat = { supportsDeveloperRole: true };
    entry.authHeader = true;
    entry.modelOverrides = { x: { name: 'Y' } };
    entry.models[0].cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    entry.models[0].samplingParams = { temperature: 0.2 };
    fs.writeFileSync(h.file('models.json'), JSON.stringify(edited));

    // A model that sends no `variants` keeps the levels it has; headers the form omits are removed.
    const config = customConfig({ name: 'Renamed' });
    delete config.headers;
    config.models['second-model'] = { modelID: 'second-model', name: 'Second' };
    delete config.models['mock-model'].variants;
    expect((await save('custom-mock', config)).status).toBe(200);

    const after = h.readJson('models.json').providers['custom-mock'];
    expect(after).toMatchObject({ name: 'Renamed', compat: { supportsDeveloperRole: true }, authHeader: true, modelOverrides: { x: { name: 'Y' } } });
    expect(after.headers).toBeUndefined();
    expect(after.models.map((model) => model.id)).toEqual(['mock-model', 'second-model']);
    expect(after.models[0]).toMatchObject({
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      samplingParams: { temperature: 0.2 },
      contextWindow: 32000,
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high' },
    });

    // An empty list takes the levels away.
    config.models['mock-model'].variants = [];
    expect((await save('custom-mock', config)).status).toBe(200);
    const cleared = h.readJson('models.json').providers['custom-mock'].models[0];
    expect(cleared).toMatchObject({ reasoning: false, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    expect(cleared.thinkingLevelMap).toBeUndefined();
  });

  it('keeps a key the user wrote into the file and replaces only a $ENV reference the form owns', async () => {
    h = await createHarness();
    await save();
    const withLiteral = h.readJson('models.json');
    withLiteral.providers['custom-mock'].apiKey = 'literal-fake-key';
    fs.writeFileSync(h.file('models.json'), JSON.stringify(withLiteral));
    // No env in the form and no stored credential: the key in the file satisfies the form.
    expect((await save('custom-mock', customConfig(), { hasCredential: false })).status).toBe(200);
    expect(h.readJson('models.json').providers['custom-mock'].apiKey).toBe('literal-fake-key');
    // Choosing an environment variable replaces it; clearing the variable later removes the reference again.
    expect((await save('custom-mock', customConfig({ env: ['MOCK_KEY'] }))).status).toBe(200);
    expect(h.readJson('models.json').providers['custom-mock'].apiKey).toBe('$MOCK_KEY');
    expect((await save('custom-mock', customConfig())).status).toBe(200);
    expect(h.readJson('models.json').providers['custom-mock'].apiKey).toBeUndefined();
  });

  it('maps the Anthropic and Google protocols and refuses a protocol Pi has no API for', async () => {
    h = await createHarness();
    await save('anthropic-compatible', customConfig({ package: 'aisdk:@ai-sdk/anthropic' }));
    await save('google-compatible', customConfig({ package: '@ai-sdk/google' }));
    const providers = h.readJson('models.json').providers;
    expect(providers['anthropic-compatible'].api).toBe('anthropic-messages');
    expect(providers['google-compatible'].api).toBe('google-generative-ai');
    expect((await get('/api/provider/anthropic-compatible/source')).body.config.package).toBe('aisdk:@ai-sdk/anthropic');
    expect((await get('/api/provider/google-compatible/source')).body.config.package).toBe('aisdk:@ai-sdk/google');

    const refused = await save('bad', customConfig({ package: 'aisdk:@ai-sdk/mistral' }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/openai-compatible/);
  });

  it('refuses input Pi cannot use, naming the reason, and leaves the file as it was', async () => {
    h = await createHarness();
    const before = h.readText('models.json');
    const cases = [
      [{ providerID: 'Bad Id', config: customConfig() }, /Provider ID/],
      [{ providerID: 'p', config: customConfig({ name: ' ' }) }, /name is required/],
      [{ providerID: 'p', config: customConfig({ settings: { baseURL: '' } }) }, /Base URL is required/],
      [{ providerID: 'p', config: customConfig({ settings: { baseURL: 'ftp://x' } }) }, /http/],
      [{ providerID: 'p', config: customConfig({ models: {} }) }, /At least one model/],
      [{ providerID: 'p', config: customConfig({ models: { m: { name: 'M', limit: { context: -1 } } } }) }, /context limit/],
      [{ providerID: 'p', config: customConfig({ models: { m: { name: 'M', type: 'image' } } }) }, /type "image"/],
      [{ providerID: 'p', config: customConfig({ models: { m: { name: 'M', variants: [{ id: 'turbo' }] } } }) }, /"turbo" is not a thinking level/],
      [{ providerID: 'p', config: customConfig({ headers: { 'X-A': ' ' } }) }, /Header "X-A"/],
      [{ providerID: 'p', config: customConfig({ env: ['bad name'] }) }, /Environment variable name/],
      [{ providerID: 'p', config: customConfig(), hasCredential: false }, /API key or \{env:VAR\}/],
      [{ providerID: '', config: customConfig() }, /Provider ID is required/],
      [{ providerID: 'p' }, /Provider config is required/],
      [{ providerID: 'p', config: customConfig(), scope: 'bogus' }, /Invalid scope/],
    ];
    for (const [body, pattern] of cases) {
      const response = await put('/api/provider', { scope: 'user', hasCredential: true, ...body });
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(response.body.error).toMatch(pattern);
    }
    expect(h.readText('models.json')).toBe(before);
    expect(h.events).toEqual([]);
  });

  it('says plainly that Pi has no project or custom layer', async () => {
    h = await createHarness();
    const response = await put('/api/provider', { providerID: 'p', config: customConfig(), scope: 'project', hasCredential: true });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(h.file('models.json'));
  });
});

describe('a models.json or settings.json that cannot be parsed', () => {
  it('is never overwritten: writes are refused with the reason and the bytes stay', async () => {
    h = await createHarness();
    const broken = '{ "providers": { "mine": { "name": "keep me", ';
    fs.writeFileSync(h.file('models.json'), broken);

    const save409 = await save();
    expect(save409.status).toBe(409);
    expect(save409.body.code).toBe('config_file_unusable');
    expect(save409.body.error).toContain(h.file('models.json'));
    expect(save409.body.error).toMatch(/parse/i);
    expect((await request(h.app).delete('/api/provider/mock/auth').query({ scope: 'user' })).status).toBe(409);
    expect((await get('/api/provider/mock/source')).status).toBe(409);
    expect(h.readText('models.json')).toBe(broken);
    expect(h.events).toEqual([]);

    // A top level that is not an object is refused the same way.
    fs.writeFileSync(h.file('models.json'), '[]');
    expect((await save()).status).toBe(409);
    fs.writeFileSync(h.file('models.json'), '{"providers": []}');
    expect((await save()).status).toBe(409);
    expect(h.readText('models.json')).toBe('{"providers": []}');

    const settings = '{ "defaultProvider": "mock", ';
    fs.writeFileSync(h.file('settings.json'), settings);
    const rejected = await put('/api/pi/model-settings', { defaultThinkingLevel: 'high' });
    expect(rejected.status).toBe(409);
    expect(h.readText('settings.json')).toBe(settings);
    expect((await get('/api/pi/model-settings')).status).toBe(409);
  });
});

describe('providers switched off in Settings', () => {
  it('hides the provider and its models from the lists until it is switched on again', async () => {
    h = await createHarness();
    expect((await get('/api/provider/disabled')).body).toEqual({ providers: [] });
    expect(await h.modelIds()).toEqual(['mock/mock-model']);

    const off = await put('/api/provider/mock/disabled', { disabled: true });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ providers: ['mock'], success: true });
    expect((await get('/api/provider/disabled')).body).toEqual({ providers: ['mock'] });
    expect(await h.modelIds()).toEqual([]);
    expect((await h.json('GET', '/api/provider')).body.data).toEqual([]);
    expect((await h.json('GET', '/api/integration')).body.data.some((entry) => entry.id === 'mock')).toBe(false);
    expect(h.types()).toEqual(['integration.updated', 'provider.updated', 'model.updated']);
    // Pi's own files are not touched by a switch the app keeps.
    expect(h.readJson('models.json').providers.mock).toBeDefined();

    const on = await put('/api/provider/mock/disabled', { disabled: false });
    expect(on.body.providers).toEqual([]);
    expect(await h.modelIds()).toEqual(['mock/mock-model']);
  });

  it('switches a provider back on when its custom entry is saved, as OpenCode did', async () => {
    h = await createHarness();
    await put('/api/provider/custom-mock/disabled', { disabled: true });
    await save();
    expect((await get('/api/provider/disabled')).body.providers).toEqual([]);
  });

  it('refuses a change it cannot keep when the file that holds the switches is broken, and lists none', async () => {
    h = await createHarness();
    const file = path.join(h.fixture.root, 'state', 'disabled-providers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const response = await put('/api/provider/mock/disabled', { disabled: true });
    expect(response).toMatchObject({ status: 409, body: { code: 'config_file_unusable' } });
    expect(response.body.error).toContain('disabled-providers.json');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    expect((await get('/api/provider/disabled')).body).toEqual({ providers: [] });
    // Saving a provider is not undone by it.
    expect((await save()).status).toBe(200);
  });

  it('refuses a body or an id it cannot use', async () => {
    h = await createHarness();
    expect((await put('/api/provider/mock/disabled', { disabled: 'yes' })).status).toBe(400);
    const bad = await put('/api/provider/Bad%20Id/disabled', { disabled: true });
    expect(bad).toMatchObject({ status: 400, body: { error: 'Invalid provider ID' } });
  });
});

describe('DELETE /api/provider/:providerId/auth', () => {
  it('logs out by default, removes the models.json entry for user and all, and does nothing for the layers Pi lacks', async () => {
    h = await createHarness();
    await save();
    await h.json('POST', '/api/integration/custom-mock/connect/key', { key: 'fake-custom-key' });

    const logout = await request(h.app).delete('/api/provider/custom-mock/auth');
    expect(logout.body).toMatchObject({ success: true, removed: true });
    expect(h.readAuth()).toEqual({});
    expect(h.readJson('models.json').providers['custom-mock']).toBeDefined();
    expect((await request(h.app).delete('/api/provider/custom-mock/auth')).body).toMatchObject({ removed: false, message: 'Provider was not connected' });

    expect((await request(h.app).delete('/api/provider/custom-mock/auth').query({ scope: 'project' })).body.removed).toBe(false);
    const removed = await request(h.app).delete('/api/provider/custom-mock/auth').query({ scope: 'all' });
    expect(removed.body).toMatchObject({ success: true, removed: true });
    expect(Object.keys(h.readJson('models.json').providers)).toEqual(['mock']);
    expect((await request(h.app).delete('/api/provider/custom-mock/auth').query({ scope: 'bogus' })).status).toBe(400);
  });
});

describe('POST /api/provider/discover-models', () => {
  const probe = (body) => request(h.app).post('/api/provider/discover-models').send({ enrich: false, ...body });

  it('lists the models of an endpoint the form names', async () => {
    h = await createHarness();
    const form = await probe({ baseURL: `http://127.0.0.1:${h.mock.port}/v1`, apiKey: 'fake-form-key' });
    expect(form.status).toBe(200);
    expect(form.body.models.map((model) => model.id)).toEqual(['mock-model']);

    const unreachable = await probe({ baseURL: 'http://127.0.0.1:9/v1' });
    expect(unreachable.status).toBeGreaterThanOrEqual(400);
    expect(unreachable.body.code).toBeTypeOf('string');
    expect((await probe({})).status).toBe(400);
  });

  it('falls back on the key a saved provider already has, and never runs a command to find one', async () => {
    h = await createHarness();
    const base = `http://127.0.0.1:${h.mock.port}/v1`;
    // A key literally in models.json, and a stored login that takes precedence over it.
    expect(await h.providers.discoveryDefaults('mock')).toEqual({ storedApiKey: 'test-key', storedBaseURL: base });
    await h.json('POST', '/api/integration/mock/connect/key', { key: 'fake-stored-key' });
    expect(await h.providers.discoveryDefaults('mock')).toEqual({ storedApiKey: 'fake-stored-key', storedBaseURL: base });

    await save('env-provider', customConfig({ env: ['MOCK_KEY'] }));
    expect(await h.providers.discoveryDefaults('env-provider')).toMatchObject({ storedApiKey: '{env:MOCK_KEY}' });
    const edited = h.readJson('models.json');
    edited.providers['env-provider'].apiKey = '!echo should-never-run';
    fs.writeFileSync(h.file('models.json'), JSON.stringify(edited));
    expect(await h.providers.discoveryDefaults('env-provider')).toMatchObject({ storedApiKey: null });
    expect(await h.providers.discoveryDefaults('nobody')).toEqual({ storedApiKey: null, storedBaseURL: undefined });
  });

  it('hands the route\'s probe the saved provider\'s key and base URL', async () => {
    h = await createHarness();
    const express = (await import('express')).default;
    const { registerProviderConfigRoutes } = await import('./config-routes.js');
    const calls = [];
    const app = express();
    app.use(express.json());
    registerProviderConfigRoutes(app, {
      getProviders: () => h.providers,
      discoverProviderModels: async (body, options) => { calls.push({ body, options }); return { models: [], enrichment: { requested: false, available: false } }; },
    });
    const base = `http://127.0.0.1:${h.mock.port}/v1`;
    expect((await request(app).post('/api/provider/discover-models').send({ providerID: 'mock', baseURL: base })).status).toBe(200);
    expect(calls[0].options).toEqual({ storedApiKey: 'test-key', storedBaseURL: base });
    // No provider id (a new provider in the form) has nothing stored.
    await request(app).post('/api/provider/discover-models').send({ baseURL: base });
    expect(calls[1].options).toEqual({ storedApiKey: null, storedBaseURL: undefined });
  });
});

describe('the model keys of settings.json', () => {
  it('reads the defaults Pi starts with and writes patches without touching other keys', async () => {
    h = await createHarness();
    expect((await get('/api/pi/model-settings')).body).toEqual({
      defaultProvider: 'mock',
      defaultModel: 'mock-model',
      defaultThinkingLevel: 'low',
      enabledModels: null,
      modelThinkingLevels: {},
    });

    const patched = await put('/api/pi/model-settings', {
      defaultModel: { provider: 'mock', model: 'other' },
      defaultThinkingLevel: 'high',
      enabledModels: ['mock/*', 'openai/gpt-*'],
      modelThinkingLevels: { 'mock/other': 'medium' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ defaultModel: 'other', defaultThinkingLevel: 'high', enabledModels: ['mock/*', 'openai/gpt-*'], modelThinkingLevels: { 'mock/other': 'medium' } });
    const file = h.readJson('settings.json');
    expect(file).toMatchObject({ defaultProvider: 'mock', defaultModel: 'other', defaultThinkingLevel: 'high', retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 } });

    const cleared = await put('/api/pi/model-settings', { enabledModels: null, defaultThinkingLevel: null, modelThinkingLevels: { 'mock/other': null } });
    expect(cleared.status).toBe(200);
    const after = h.readJson('settings.json');
    expect(after.enabledModels).toBeUndefined();
    expect(after.defaultThinkingLevel).toBeUndefined();
    expect(after.modelThinkingLevels).toBeUndefined();
    expect(after.retry).toEqual({ enabled: true, maxRetries: 1, baseDelayMs: 50 });
    expect(h.types().filter((type) => type === 'model.updated')).toHaveLength(2);
  });

  it('refuses a value Pi would not accept before writing anything', async () => {
    h = await createHarness();
    const before = h.readText('settings.json');
    for (const patch of [
      { defaultThinkingLevel: 'turbo' },
      { defaultModel: { provider: 'mock' } },
      { enabledModels: 'mock/*' },
      { enabledModels: [''] },
      { modelThinkingLevels: { 'mock/x': 'nope' } },
      { modelThinkingLevels: [] },
    ]) {
      const response = await put('/api/pi/model-settings', patch);
      expect(response.status, JSON.stringify(patch)).toBe(400);
    }
    expect((await put('/api/pi/model-settings', [])).status).toBe(400);
    expect(h.readText('settings.json')).toBe(before);
  });
});

describe('enterprise mode', () => {
  it('refuses to add a provider or probe an endpoint, writing nothing, and still lets providers be removed', async () => {
    h = await createHarness();
    await save();
    h.events.length = 0;
    const before = h.readText('models.json');

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const refusedSave = await save('another', customConfig());
    expect(refusedSave).toMatchObject({ status: 403, body: { code: 'enterprise_mode' } });
    expect(refusedSave.body.error).toMatch(/enterprise mode/i);
    // Refused before the body is read: an invalid body gets the same answer.
    expect((await put('/api/provider', {})).status).toBe(403);
    const probe = await request(h.app).post('/api/provider/discover-models').send({ baseURL: `http://127.0.0.1:${h.mock.port}/v1` });
    expect(probe).toMatchObject({ status: 403, body: { code: 'enterprise_mode' } });
    expect(h.readText('models.json')).toBe(before);
    expect(h.events).toEqual([]);

    // Removing and switching off only narrow access.
    expect((await put('/api/provider/custom-mock/disabled', { disabled: true })).status).toBe(200);
    expect((await request(h.app).delete('/api/provider/custom-mock/auth').query({ scope: 'user' })).body.removed).toBe(true);

    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    expect((await save('another', customConfig())).status).toBe(200);
  });
});

describe('while the bridge is down', () => {
  it('answers 503 on every route', async () => {
    h = await createHarness();
    h.setBridgeDown(true);
    for (const response of [
      await get('/api/provider/disabled'),
      await put('/api/provider/mock/disabled', { disabled: true }),
      await get('/api/provider/mock/source'),
      await save(),
      await request(h.app).post('/api/provider/discover-models').send({}),
      await request(h.app).delete('/api/provider/mock/auth'),
      await get('/api/pi/model-settings'),
      await put('/api/pi/model-settings', {}),
    ]) {
      expect(response.status).toBe(503);
    }
  });
});

describe('writes that arrive together', () => {
  it('lose none of them: every provider is in models.json, the user\'s keys survive and no temporary file is left', async () => {
    h = await createHarness();
    const original = h.readJson('models.json');
    original.$comment = 'mine';
    fs.writeFileSync(h.file('models.json'), JSON.stringify(original));

    const ids = Array.from({ length: 14 }, (_, index) => `provider-${index}`);
    const responses = await Promise.all([
      ...ids.map((id) => save(id, customConfig({ name: id }))),
      // The same provider written repeatedly: the last write wins as a whole, never a mix.
      ...Array.from({ length: 6 }, (_, index) => save('shared', customConfig({ name: `shared-${index}` }))),
      ...ids.slice(0, 5).map((id) => put(`/api/provider/${id}/disabled`, { disabled: true })),
      ...Array.from({ length: 4 }, (_, index) => put('/api/pi/model-settings', { modelThinkingLevels: { [`mock/m${index}`]: 'low' } })),
    ]);
    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 200));

    const written = h.readJson('models.json');
    expect(Object.keys(written.providers).sort()).toEqual(['mock', 'shared', ...ids].sort());
    expect(written.$comment).toBe('mine');
    expect(written.providers.mock).toEqual(original.providers.mock);
    for (const id of ids) expect(written.providers[id].name).toBe(id);
    expect(written.providers.shared.name).toMatch(/^shared-\d$/);
    expect(written.providers.shared.models).toHaveLength(1);

    expect(new Set((await get('/api/provider/disabled')).body.providers)).toEqual(new Set(ids.slice(0, 5)));
    expect(Object.keys(h.readJson('settings.json').modelThinkingLevels).sort()).toEqual(['mock/m0', 'mock/m1', 'mock/m2', 'mock/m3']);
    expect(fs.readdirSync(h.fixture.agentDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
