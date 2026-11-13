import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPiCatalog, supportedThinkingLevels } from './catalog.js';
import { createLiveSessionHost, createPiClientFactory } from './live-session-host.js';
import { startMockOpenAi } from './test-support/mock-openai.js';
import { createPiFixture } from './test-support/pi-fixture.js';

describe('supportedThinkingLevels', () => {
  it('offers only off to a model that cannot reason', () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(['off']);
  });
  it('offers the base levels to a reasoning model and xhigh or max only when mapped', () => {
    expect(supportedThinkingLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'x', max: 'm' } }))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('drops a level the model maps to null', () => {
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } }))
      .toEqual(['low', 'medium', 'high']);
  });
});

describe('catalog on an isolated Pi installation', () => {
  let mock;
  let fixture;
  let host;

  beforeAll(async () => {
    mock = await startMockOpenAi();
    fixture = createPiFixture({ mockPort: mock.port });
  });
  afterAll(async () => {
    await mock.close();
    fixture.dispose();
  });
  afterEach(async () => {
    await host?.shutdown();
    host = null;
  });

  const makeCatalog = () => createPiCatalog({ getAgentDir: () => fixture.agentDir });

  it('lists the custom provider as configured and the built-in ones as not', async () => {
    const providers = await makeCatalog().providers();

    const mockProvider = providers.find((provider) => provider.id === 'mock');
    expect(mockProvider).toMatchObject({ name: 'Mock', configured: true, modelCount: 1, auth: { apiKey: true, oauth: false } });
    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic).toMatchObject({ configured: false, credentialType: null, auth: { apiKey: true, oauth: true } });
    expect(anthropic.auth.oauthName).toContain('Anthropic');
    expect(providers.length).toBeGreaterThan(30);
  });

  it('lists only usable models when asked', async () => {
    const catalog = makeCatalog();
    const usable = await catalog.models({ availableOnly: true });
    expect(usable.map((model) => `${model.provider}/${model.id}`)).toEqual(['mock/mock-model']);
    expect(usable[0]).toMatchObject({ reasoning: true, input: ['text'], contextWindow: 32000, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] });
    expect((await catalog.models()).length).toBeGreaterThan(100);
  });

  it('stores an API key in auth.json and removes it again', async () => {
    const catalog = makeCatalog();
    await catalog.setApiKey('openai', 'sk-test-123');

    const stored = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, 'auth.json'), 'utf8'));
    expect(stored.openai).toMatchObject({ type: 'api_key', key: 'sk-test-123' });
    expect((await catalog.providers()).find((provider) => provider.id === 'openai')).toMatchObject({ configured: true, credentialType: 'api_key' });
    expect((await catalog.models({ availableOnly: true })).some((model) => model.provider === 'openai')).toBe(true);

    await catalog.removeCredential('openai');
    expect((await catalog.providers()).find((provider) => provider.id === 'openai').configured).toBe(false);
  });

  it('sees a models.json edit only after reload', async () => {
    const catalog = makeCatalog();
    expect((await catalog.models({ availableOnly: true })).length).toBe(1);

    const file = path.join(fixture.agentDir, 'models.json');
    const original = fs.readFileSync(file, 'utf8');
    const edited = JSON.parse(original);
    edited.providers.mock.models.push({ id: 'second', name: 'Second', input: ['text'] });
    fs.writeFileSync(file, JSON.stringify(edited));
    try {
      expect((await catalog.models({ availableOnly: true })).length).toBe(1);
      catalog.reload();
      expect((await catalog.models({ availableOnly: true })).map((model) => model.id).sort()).toEqual(['mock-model', 'second']);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('agrees with what a running Pi reports for the same model', async () => {
    host = createLiveSessionHost({ createClient: createPiClientFactory({ getBaseEnv: () => fixture.env }) });
    const session = { id: 'ses_catalog_parity', cwd: fixture.project };

    const { levels } = await host.request(session, 'get_available_thinking_levels');
    const { models } = await host.request(session, 'get_available_models');
    const model = await makeCatalog().model('mock', 'mock-model');

    expect(model.thinkingLevels).toEqual(levels);
    expect(models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(['mock/mock-model']);
  });
});
