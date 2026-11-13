// Pi's models and providers in the shape the OpenCode 2.2.6 catalog routes
// serve (`Model.Info`, `Provider.Info`), as the UI reads them: the pickers use
// `id`, `modelID`, `providerID`, `name`, `capabilities`, `variants`, `cost`,
// `limit`, `enabled` and `status`; the provider form reads `package` and
// `settings.baseURL`; `providerAuth.ts` takes a non-empty `settings.apiKey` as
// "a key sits in the config".

/**
 * Pi's `api` names the wire protocol of a model. The UI infers a custom
 * provider's protocol from `package` (`custom-provider-form.ts`
 * `NATIVE_CUSTOM_PROVIDER_PACKAGES`), so the three protocols OpenCode also has
 * use OpenCode's package names. The rest get the nearest OpenCode name; a
 * protocol with none keeps Pi's name behind a `pi:` prefix.
 */
const PACKAGE_BY_API = {
  'openai-completions': '@opencode/ai/providers/openai-compatible',
  'openai-responses': '@opencode/ai/providers/openai',
  'openai-codex-responses': '@opencode/ai/providers/openai',
  'azure-openai-responses': '@opencode/ai/providers/azure',
  'anthropic-messages': '@opencode/ai/providers/anthropic',
  'google-generative-ai': '@opencode/ai/providers/google',
  'google-vertex': '@opencode/ai/providers/google-vertex',
  'bedrock-converse-stream': '@opencode/ai/providers/amazon-bedrock',
  'mistral-conversations': '@opencode/ai/providers/mistral',
  'openrouter-images': '@opencode/ai/providers/openrouter',
};

export const packageForApi = (api) => {
  if (!api) return '';
  return PACKAGE_BY_API[api] ?? `pi:${api}`;
};

const finite = (value) => (Number.isFinite(value) ? value : 0);
const wholeNumber = (value) => Math.max(0, Math.trunc(finite(value)));

const rates = (cost) => ({
  input: finite(cost.input),
  output: finite(cost.output),
  cache: { read: finite(cost.cacheRead), write: finite(cost.cacheWrite) },
});

/**
 * Pi prices per million tokens, like OpenCode, with optional tiers that start
 * above an input size. A model with no price at all (a local server in
 * `models.json` leaves them at 0) serves `[]`, which is what OpenCode serves
 * for a model it has no price for: the UI then shows no price instead of a
 * claim that the model is free.
 */
export const toCostEntries = (cost) => {
  if (!cost) return [];
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const priced = [cost, ...tiers].some((entry) => finite(entry.input) > 0 || finite(entry.output) > 0
    || finite(entry.cacheRead) > 0 || finite(entry.cacheWrite) > 0);
  if (!priced) return [];
  return [
    rates(cost),
    ...tiers.map((tier) => ({ tier: { type: 'context', size: wholeNumber(tier.inputTokensAbove) }, ...rates(tier) })),
  ];
};

/**
 * A reasoning model offers each thinking level Pi supports for it, `off`
 * included: OpenCode lists `none` for the models that can switch reasoning off,
 * and without `off` the picker could never turn thinking off. Pi already
 * leaves `off` out for a model that cannot run without thinking. The picker's
 * "Default" sends no level, which Pi resolves from its own settings. The level
 * ids are Pi's, so a variant maps one to one onto `set_thinking_level`.
 */
export const toVariants = (model) => (model.reasoning
  ? model.thinkingLevels.map((id) => ({ id, settings: { reasoningEffort: id } }))
  : []);

/** @param {object} model  One entry of `catalog.models()`. */
export const toModelInfo = (model) => {
  const image = model.type === 'image';
  return {
    id: model.id,
    modelID: model.id,
    providerID: model.provider,
    ...(image ? { type: 'image' } : {}),
    name: model.name,
    package: packageForApi(model.api),
    ...(model.baseUrl ? { settings: { baseURL: model.baseUrl } } : {}),
    capabilities: { tools: !image, input: [...model.input], output: [...model.output] },
    variants: image ? [] : toVariants(model),
    time: { released: 0 },
    cost: toCostEntries(model.cost),
    status: 'active',
    enabled: true,
    limit: { context: wholeNumber(model.contextWindow), output: wholeNumber(model.maxTokens) },
  };
};

/**
 * What `models.json` says about a provider's key, as a value that can leave the
 * machine: an environment reference keeps its name (`{env:NAME}`, the form the
 * provider editor uses), any other key, a literal or a `!command`, becomes a
 * mask. OpenCode serves the literal key here. The UI only asks whether the
 * string is non-empty, and the key itself has a route of its own
 * (`/api/credential`) for the callers that need it.
 */
export const apiKeyMarker = (apiKey) => {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
  const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(apiKey.trim());
  if (reference) return `{env:${reference[1] ?? reference[2]}}`;
  return '********';
};

/**
 * @param {{ id: string, name: string, api: string | null, baseUrl: string | null }} provider
 * @param {{ declared: boolean, apiKey: string | null }} options
 *   `declared`: the provider is written in `models.json`, which OpenCode calls
 *   `enabled` (a config entry); the others are `auto`. `apiKey`: the marker above.
 */
export const toProviderInfo = (provider, { declared, apiKey }) => {
  const settings = {
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  return {
    id: provider.id,
    name: provider.name,
    activation: declared ? 'enabled' : 'auto',
    package: packageForApi(provider.api),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
};

/**
 * Pi's own default: `defaultProvider` and `defaultModel` of `settings.json`
 * (project settings win over global ones), when that model is usable, else the
 * first usable model. Null without any.
 */
export const pickDefaultModel = (available, settings) => {
  const wanted = available.find((model) => model.provider === settings.defaultProvider && model.id === settings.defaultModel);
  return wanted ?? available[0] ?? null;
};
