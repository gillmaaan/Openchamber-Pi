import { describe, expect, it } from 'vitest';

import { buildProviderEntry, envNameOf, toStoredConfig } from './custom-provider.js';

const form = (overrides = {}) => ({
  package: 'aisdk:@ai-sdk/openai-compatible',
  name: 'Local',
  settings: { baseURL: 'http://127.0.0.1:8000/v1' },
  models: { 'm-1': { modelID: 'm-1', name: 'M one', limit: { context: 8000, output: 1000 } } },
  ...overrides,
});
const build = (config, existing, options = { hasStoredAuth: true }) => buildProviderEntry('local', config, existing, options);

describe('envNameOf', () => {
  it('reads the variable of a $NAME or ${NAME} key and nothing else', () => {
    expect(envNameOf('$MY_KEY')).toBe('MY_KEY');
    expect(envNameOf(' ${MY_KEY} ')).toBe('MY_KEY');
    for (const literal of ['sk-123', '!op read key', '$$ESCAPED', '$', '$1X', '', undefined, 5]) expect(envNameOf(literal)).toBeNull();
  });
});

describe('the form\'s provider config and Pi\'s models.json entry', () => {
  it('survives a round trip: what the page reads back saves to the same entry', () => {
    const first = build(form({
      env: ['LOCAL_KEY'],
      headers: { 'X-A': '1' },
      models: {
        'm-1': {
          modelID: 'm-1',
          name: 'M one',
          limit: { context: 8000, output: 1000 },
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'xhigh', settings: { reasoningEffort: 'max' } }],
        },
      },
    }), undefined, { hasStoredAuth: false });
    expect(first.ok).toBe(true);
    const stored = toStoredConfig(first.entry);
    expect(stored.models['m-1'].variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'xhigh', settings: { reasoningEffort: 'max' } },
    ]);
    const second = build(stored, first.entry, { hasStoredAuth: false });
    expect(second).toEqual(first);
  });

  it('writes a level\'s provider value into the thinking-level map and marks the levels it does not list unsupported', () => {
    const { entry } = build(form({ models: { m: { name: 'M', variants: [{ id: 'high', settings: { reasoningEffort: 'xhigh-ish' } }] } } }));
    expect(entry.models[0]).toMatchObject({ id: 'm', reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'xhigh-ish' } });
  });

  it('takes only text and image input and says nothing for the rest', () => {
    const { entry } = build(form({ models: { m: { name: 'M', capabilities: { tools: false, input: ['text', 'audio', 'pdf'], output: ['text', 'image'] } } } }));
    expect(entry.models[0].input).toEqual(['text']);
    const image = build(form({ models: { m: { name: 'M', capabilities: { input: ['image', 'image'] } } } }));
    expect(image.entry.models[0].input).toEqual(['image']);
  });

  it('shows a Pi-native entry to the form: no tools flag of its own, text output, levels from the map', () => {
    const stored = toStoredConfig({
      name: 'Native',
      baseUrl: 'https://llm.example/v1',
      api: 'openai-responses',
      apiKey: 'literal-fake',
      headers: { 'X-B': '2', 'X-N': 3 },
      models: [
        { id: 'a', name: 'A', reasoning: true, contextWindow: 1000, maxTokens: 100, input: ['text', 'image'], thinkingLevelMap: { off: null, low: 'l', xhigh: 'x' } },
        { id: 'b' },
        { name: 'no id' },
      ],
    });
    expect(stored).toEqual({
      name: 'Native',
      package: 'aisdk:@ai-sdk/openai',
      settings: { baseURL: 'https://llm.example/v1' },
      headers: { 'X-B': '2' },
      models: {
        a: {
          modelID: 'a',
          name: 'A',
          limit: { context: 1000, output: 100 },
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          variants: [
            { id: 'minimal', settings: { reasoningEffort: 'minimal' } },
            { id: 'low', settings: { reasoningEffort: 'l' } },
            { id: 'medium', settings: { reasoningEffort: 'medium' } },
            { id: 'high', settings: { reasoningEffort: 'high' } },
            { id: 'xhigh', settings: { reasoningEffort: 'x' } },
          ],
        },
        b: { modelID: 'b', name: 'b', capabilities: { tools: true, input: ['text'], output: ['text'] } },
      },
    });
    // A literal key is not shown; only a $ENV reference is.
    expect(stored.env).toBeUndefined();
  });

  it('keeps the protocol of a provider the form cannot name, and the model fields it does not manage', () => {
    const existing = { name: 'Old', baseUrl: 'https://old.example', api: 'azure-openai-responses', compat: { x: 1 }, models: [{ id: 'm-1', name: 'Old', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] };
    const { entry } = build(form(), existing);
    expect(entry.api).toBe('azure-openai-responses');
    expect(entry.compat).toEqual({ x: 1 });
    expect(entry.models[0]).toMatchObject({ id: 'm-1', name: 'M one', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 });
  });

  it('refuses a duplicate-free but empty model id and a model that is not an object', () => {
    expect(build(form({ models: { ' ': { name: 'x' } } }))).toEqual({ ok: false, error: 'Model id is required' });
    expect(build(form({ models: { m: 'text' } }))).toMatchObject({ ok: false, error: expect.stringContaining('must be an object') });
    expect(build(form({ models: { m: { name: '' } } }))).toMatchObject({ ok: false, error: expect.stringContaining('requires a name') });
  });
});
