// A custom provider between the two spellings: the form's (OpenCode's v2 config
// entry, which `PUT /api/provider` receives and `/api/provider/:id/source`
// answers) and Pi's (a `models.json` provider entry).
//
//   form                                      Pi
//   package aisdk:@ai-sdk/openai-compatible   api openai-completions
//           aisdk:@ai-sdk/openai                  openai-responses
//           aisdk:@ai-sdk/anthropic               anthropic-messages
//           aisdk:@ai-sdk/google                  google-generative-ai
//   settings.baseURL                          baseUrl
//   env: [NAME]                               apiKey: "$NAME"
//   headers                                   headers
//   models.<id> { modelID, name }             models[] { id, name }
//     limit { context, output }                 contextWindow, maxTokens
//     capabilities.input (text, image)          input
//     variants [{ id, settings }]               reasoning + thinkingLevelMap
//
// What Pi has no field for is refused or dropped, never kept under a name Pi
// would not read: model types other than chat and thinking levels that are not
// Pi's are refused; the tools flag, audio, video and pdf input and image output
// are dropped (Pi gives every model tools and takes only text and images).
// Whatever else the entry holds (`compat`, `authHeader`, `modelOverrides`, a
// model's `cost` or `samplingParams`) stays as the user wrote it.

import { supportedThinkingLevels } from '../catalog.js';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REFERENCE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const AISDK_PREFIX = 'aisdk:';

const API_BY_NPM = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai',
};
const NPM_BY_API = Object.fromEntries(Object.entries(API_BY_NPM).map(([npm, api]) => [api, npm]));
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** The levels a model that lists some of them must still map to `null` to turn the others off. */
const BASE_LEVELS = ['minimal', 'low', 'medium', 'high'];
const MODEL_CAPABILITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

const fail = (error) => ({ ok: false, error });

/** The env variable a Pi `apiKey` names (`$NAME` or `${NAME}`), or null for a literal or `!command`. */
export const envNameOf = (apiKey) => {
  if (typeof apiKey !== 'string') return null;
  const match = ENV_REFERENCE.exec(apiKey.trim());
  return match ? (match[1] ?? match[2]) : null;
};

/** The thinking levels a model lists, as the form shows them: Pi's own rule, `off` only when the file maps it. */
const variantsOf = (model) => {
  if (!model.reasoning) return [];
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return supportedThinkingLevels({ reasoning: true, thinkingLevelMap: map })
    .filter((level) => level !== 'off' || typeof map.off === 'string')
    .map((id) => ({ id, settings: { reasoningEffort: typeof map[id] === 'string' ? map[id] : id } }));
};

const effortOf = (variant) => {
  const settings = isRecord(variant.settings) ? variant.settings : {};
  return [settings.reasoningEffort, settings.effort].find((value) => typeof value === 'string' && value !== '') ?? variant.id;
};

/** Pi's `thinkingLevelMap` for the levels a model lists: the listed ones map, the rest of the base levels are off. */
const thinkingLevelMapOf = (variants) => {
  const listed = new Map(variants.map((variant) => [variant.id, effortOf(variant)]));
  const map = {};
  for (const level of THINKING_LEVELS) {
    if (listed.has(level)) map[level] = listed.get(level);
    else if (BASE_LEVELS.includes(level)) map[level] = null;
  }
  return map;
};

const buildModel = (modelId, value, existing) => {
  if (!isRecord(value)) return fail(`Model "${modelId}" must be an object`);
  const name = text(value.name);
  if (!name) return fail(`Model "${modelId}" requires a name`);
  if (value.type !== undefined && value.type !== 'chat') {
    return fail(`Model "${modelId}" has type "${String(value.type)}", which models.json cannot declare: Pi lists only chat models from it`);
  }
  const model = { ...(isRecord(existing) ? existing : {}), id: modelId, name };

  if (isRecord(value.limit)) {
    const { context, output } = value.limit;
    if (context !== undefined && (!Number.isSafeInteger(context) || context <= 0)) return fail(`Model "${modelId}" context limit must be a positive integer`);
    if (output !== undefined && (!Number.isSafeInteger(output) || output <= 0)) return fail(`Model "${modelId}" output limit must be a positive integer`);
    if (context !== undefined) model.contextWindow = context;
    if (output !== undefined) model.maxTokens = output;
  }

  if (isRecord(value.capabilities)) {
    const { input, output, tools } = value.capabilities;
    if (input !== undefined && (!Array.isArray(input) || input.some((entry) => !MODEL_CAPABILITIES.has(entry)))) return fail(`Model "${modelId}" input capabilities are invalid`);
    if (output !== undefined && (!Array.isArray(output) || output.some((entry) => !MODEL_CAPABILITIES.has(entry)))) return fail(`Model "${modelId}" output capabilities are invalid`);
    if (tools !== undefined && typeof tools !== 'boolean') return fail(`Model "${modelId}" tools capability must be a boolean`);
    if (input !== undefined) {
      const accepted = input.filter((entry) => entry === 'text' || entry === 'image');
      model.input = accepted.length > 0 ? [...new Set(accepted)] : ['text'];
    }
  }

  // Present means the caller owns the levels; an empty list removes them.
  if (Array.isArray(value.variants)) {
    const variants = value.variants.filter((variant) => isRecord(variant) && text(variant.id)).map((variant) => ({ ...variant, id: text(variant.id) }));
    const unknown = variants.find((variant) => !THINKING_LEVELS.includes(variant.id));
    if (unknown) return fail(`Model "${modelId}": "${unknown.id}" is not a thinking level Pi knows (${THINKING_LEVELS.join(', ')})`);
    if (variants.length === 0) {
      model.reasoning = false;
      delete model.thinkingLevelMap;
    } else {
      model.reasoning = true;
      model.thinkingLevelMap = thinkingLevelMapOf(variants);
    }
  }
  return { ok: true, model };
};

/**
 * Validates the form's provider config and merges it into the existing
 * `models.json` entry, or builds a new one. The form owns the model list, the
 * headers and the `$ENV` key; everything else of an existing entry is kept.
 *
 * @param {string} providerId
 * @param {unknown} config  The body of `PUT /api/provider`.
 * @param {unknown} existing  The entry now in `models.json`, if any.
 * @param {{ hasStoredAuth?: boolean }} [options]  A credential is stored in `auth.json` or the form vouches for one.
 * @returns {{ ok: true, entry: Record<string, unknown> } | { ok: false, error: string }}
 */
export const buildProviderEntry = (providerId, config, existing, { hasStoredAuth = false } = {}) => {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) return fail('Provider ID must match /^[a-z0-9][a-z0-9-_]*$/');
  if (!isRecord(config)) return fail('Provider config must be an object');
  const name = text(config.name);
  if (!name) return fail('Provider name is required');

  const spec = text(config.package ?? config.npm) || `${AISDK_PREFIX}@ai-sdk/openai-compatible`;
  const npm = spec.startsWith(AISDK_PREFIX) ? spec.slice(AISDK_PREFIX.length) : spec;
  const api = API_BY_NPM[npm];
  if (!api) return fail('Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, @ai-sdk/anthropic or @ai-sdk/google');

  const settings = isRecord(config.settings) ? config.settings : (isRecord(config.options) ? config.options : null);
  if (!settings) return fail('Provider settings are required');
  const baseUrl = text(settings.baseURL);
  if (!baseUrl) return fail('Base URL is required');
  if (!BASE_URL_PATTERN.test(baseUrl)) return fail('Base URL must start with http:// or https://');

  const incoming = isRecord(config.models) ? config.models : null;
  if (!incoming || Object.keys(incoming).length === 0) return fail('At least one model is required');

  const previous = isRecord(existing) ? existing : {};
  const previousModels = new Map((Array.isArray(previous.models) ? previous.models : []).filter((model) => isRecord(model) && typeof model.id === 'string').map((model) => [model.id, model]));
  const models = [];
  for (const [rawId, value] of Object.entries(incoming)) {
    const modelId = rawId.trim();
    if (!modelId) return fail('Model id is required');
    const built = buildModel(modelId, value, previousModels.get(modelId));
    if (!built.ok) return built;
    models.push(built.model);
  }

  const envNames = (Array.isArray(config.env) ? config.env : []).map(text).filter(Boolean);
  const badName = envNames.find((envName) => !ENV_NAME_PATTERN.test(envName));
  if (badName) return fail(`Environment variable name "${badName}" is invalid`);
  // A key the user wrote into the file (a literal or a !command) is theirs; the form only owns `$ENV` references.
  const keptKey = typeof previous.apiKey === 'string' && previous.apiKey !== '' && envNameOf(previous.apiKey) === null;
  if (envNames.length === 0 && !hasStoredAuth && !keptKey) return fail('API key or {env:VAR} credentials are required');

  let headers;
  const headerSource = isRecord(config.headers) ? config.headers : settings.headers;
  if (isRecord(headerSource)) {
    headers = {};
    for (const [headerKey, headerValue] of Object.entries(headerSource)) {
      if (typeof headerKey !== 'string' || !headerKey.trim()) continue;
      if (typeof headerValue !== 'string' || !headerValue.trim()) return fail(`Header "${headerKey}" requires a non-empty value`);
      headers[headerKey.trim()] = headerValue.trim();
    }
    if (Object.keys(headers).length === 0) headers = undefined;
  }

  const entry = { ...previous, name, baseUrl, models };
  // A protocol the form cannot name (a built-in provider's own `api`, or none) stays as it is.
  if (!('api' in previous) || previous.api in NPM_BY_API) entry.api = api;
  if (envNames.length > 0) entry.apiKey = `$${envNames[0]}`;
  else if (envNameOf(previous.apiKey) !== null) delete entry.apiKey;
  if (headers) entry.headers = headers;
  else delete entry.headers;
  return { ok: true, entry };
};

/** A `models.json` provider entry in the form's config spelling, for `/api/provider/:id/source` and the save response. */
export const toStoredConfig = (entry) => {
  const stored = {};
  if (typeof entry.name === 'string' && entry.name) stored.name = entry.name;
  const npm = NPM_BY_API[entry.api];
  if (npm) stored.package = `${AISDK_PREFIX}${npm}`;
  const envName = envNameOf(entry.apiKey);
  if (envName) stored.env = [envName];
  if (typeof entry.baseUrl === 'string' && entry.baseUrl) stored.settings = { baseURL: entry.baseUrl };
  if (isRecord(entry.headers)) {
    const headers = Object.fromEntries(Object.entries(entry.headers).filter(([, value]) => typeof value === 'string'));
    if (Object.keys(headers).length > 0) stored.headers = headers;
  }
  const models = (Array.isArray(entry.models) ? entry.models : []).filter((model) => isRecord(model) && typeof model.id === 'string' && model.id !== '');
  if (models.length > 0) {
    stored.models = Object.fromEntries(models.map((model) => {
      const limit = {
        ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { context: model.contextWindow } : {}),
        ...(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? { output: model.maxTokens } : {}),
      };
      const variants = variantsOf(model);
      return [model.id, {
        modelID: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
        ...(Object.keys(limit).length > 0 ? { limit } : {}),
        capabilities: { tools: true, input: Array.isArray(model.input) && model.input.length > 0 ? [...model.input] : ['text'], output: ['text'] },
        ...(variants.length > 0 ? { variants } : {}),
      }];
    }));
  }
  return stored;
};
