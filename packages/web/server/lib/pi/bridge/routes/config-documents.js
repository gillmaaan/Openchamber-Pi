// `GET /api/config`: Pi's configuration as OpenCode-shaped documents.
//
// The UI folds every `document` entry into one effective config
// (`mergeConfigDocuments`, later entries win). Two things in it come from Pi:
//
// - `model`, the default model, from `settings.json` (`defaultProvider`,
//   `defaultModel`). `variant` is added only when the file names a
//   `defaultThinkingLevel`; Pi's built-in `medium` is not a choice the user made.
// - `providers`, the custom and overridden providers of `models.json`, in the
//   shape the UI's Providers page reads: `name`, `package`, `env` or
//   `settings.baseURL`, and `models` keyed by id with `name`, `capabilities`
//   and `limit`.
//
// Keys, headers and commands of `models.json` are not copied: `apiKey` becomes
// `env` when it names an environment variable and is left out otherwise, and
// `headers` can carry tokens, so they stay in the file.
//
// Entries come lowest priority first. As in OpenCode's own answer, documents
// precede directory entries: `models.json`, global `settings.json`, project
// `.pi/settings.json`, then the folders they live in.

import { supportedThinkingLevels } from '../../catalog.js';
import { packageForApi, toCostEntries } from './model-info.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

const envReference = (apiKey) => {
  if (typeof apiKey !== 'string') return null;
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(apiKey.trim());
  return match ? (match[1] ?? match[2]) : null;
};

const modelConfig = (model) => {
  const reasoning = model.reasoning === true;
  const levels = supportedThinkingLevels({ reasoning, thinkingLevelMap: model.thinkingLevelMap }).filter((level) => level !== 'off');
  const cost = toCostEntries(model.cost);
  return {
    name: typeof model.name === 'string' ? model.name : model.id,
    capabilities: {
      tools: true,
      input: Array.isArray(model.input) ? model.input : ['text'],
      output: ['text'],
      ...(reasoning ? { reasoning: { supported: true, effort: levels } } : {}),
    },
    limit: {
      context: Number.isInteger(model.contextWindow) ? model.contextWindow : DEFAULT_CONTEXT_WINDOW,
      output: Number.isInteger(model.maxTokens) ? model.maxTokens : DEFAULT_MAX_TOKENS,
    },
    ...(cost.length > 0 ? { cost: cost.length === 1 ? cost[0] : cost } : {}),
  };
};

const providerConfig = (provider) => {
  const env = envReference(provider.apiKey);
  const models = Array.isArray(provider.models)
    ? Object.fromEntries(provider.models
      .filter((model) => isObject(model) && typeof model.id === 'string' && model.id !== '')
      .map((model) => [model.id, modelConfig(model)]))
    : {};
  return {
    ...(typeof provider.name === 'string' ? { name: provider.name } : {}),
    ...(typeof provider.api === 'string' ? { package: packageForApi(provider.api) } : {}),
    ...(env ? { env: [env] } : {}),
    ...(typeof provider.baseUrl === 'string' ? { settings: { baseURL: provider.baseUrl } } : {}),
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };
};

/** @param {Record<string, unknown>} modelsJson  The parsed `models.json`. */
export const modelsDocumentInfo = (modelsJson) => {
  const declared = isObject(modelsJson.providers) ? modelsJson.providers : {};
  const providers = Object.fromEntries(Object.entries(declared)
    .filter(([, provider]) => isObject(provider))
    .map(([id, provider]) => [id, providerConfig(provider)]));
  return Object.keys(providers).length > 0 ? { providers } : {};
};

/** @param {Record<string, unknown>} settings  The parsed `settings.json`. */
export const settingsDocumentInfo = (settings) => {
  const { defaultProvider, defaultModel, defaultThinkingLevel } = settings;
  if (typeof defaultProvider !== 'string' || typeof defaultModel !== 'string' || !defaultProvider || !defaultModel) return {};
  return {
    model: {
      providerID: defaultProvider,
      model: defaultModel,
      ...(typeof defaultThinkingLevel === 'string' && defaultThinkingLevel ? { variant: defaultThinkingLevel } : {}),
    },
  };
};

/**
 * @param {object} sources
 * @param {{ path: string, value: Record<string, unknown> } | null} sources.models
 * @param {{ path: string, value: Record<string, unknown> } | null} sources.settings
 * @param {{ path: string, value: Record<string, unknown> } | null} sources.projectSettings
 * @param {string} sources.agentDir
 * @param {string | null} sources.projectConfigDir  `<directory>/.pi` when it exists and may be read.
 */
export const buildConfigEntries = ({ models, settings, projectSettings, agentDir, projectConfigDir }) => [
  ...(models ? [{ type: 'document', path: models.path, info: modelsDocumentInfo(models.value) }] : []),
  ...(settings ? [{ type: 'document', path: settings.path, info: settingsDocumentInfo(settings.value) }] : []),
  ...(projectSettings ? [{ type: 'document', path: projectSettings.path, info: settingsDocumentInfo(projectSettings.value) }] : []),
  { type: 'directory', path: agentDir },
  ...(projectConfigDir ? [{ type: 'directory', path: projectConfigDir }] : []),
];
