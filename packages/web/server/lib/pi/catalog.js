// What Pi offers a GUI to choose from: providers, their models, and which of
// them have credentials. Backed by Pi's own `ModelRuntime`, which reads the same
// `auth.json` and `models.json` the `pi` CLI uses, so a key added in either
// place shows up in both.
//
// The SDK costs about 380 ms and 90 MB to load, so it is imported on first use.
// A running Pi child never sees edits to `models.json`; `reload()` rebuilds this
// side, and the next child or `new_session` picks the edit up.

import path from 'node:path';

const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The thinking levels a model accepts: Pi's own rule (`getSupportedThinkingLevels`
 * in pi-ai, which the SDK does not re-export). A level mapped to null is
 * unsupported; `xhigh` and `max` exist only when the model maps them.
 */
export const supportedThinkingLevels = (model) => {
  if (!model?.reasoning) return ['off'];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
};

const toModel = (model) => ({
  provider: model.provider,
  id: model.id,
  name: model.name ?? model.id,
  api: model.api,
  reasoning: Boolean(model.reasoning),
  input: Array.isArray(model.input) ? [...model.input] : ['text'],
  cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: model.contextWindow ?? 0,
  maxTokens: model.maxTokens ?? 0,
  thinkingLevels: supportedThinkingLevels(model),
  type: model.type ?? 'chat',
  /** What the model produces; image models answer `['image']`, chat models carry no field. */
  output: Array.isArray(model.output) ? [...model.output] : ['text'],
  baseUrl: model.baseUrl ?? null,
});

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir  Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), read when the runtime is built.
 * @param {() => Promise<typeof import('@earendil-works/pi-coding-agent')>} [options.loadSdk]
 * @param {() => Iterable<string>} [options.getHiddenProviders]  Providers the user turned off in Settings. `providers()` and `models()` leave them out; `providers({ includeHidden: true })` and `model()` still see them.
 */
export const createPiCatalog = ({
  getAgentDir,
  loadSdk = () => import('@earendil-works/pi-coding-agent'),
  getHiddenProviders = () => [],
}) => {
  let runtimePromise = null;

  const buildRuntime = async () => {
    const sdk = await loadSdk();
    const agentDir = getAgentDir();
    return sdk.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      modelsStorePath: path.join(agentDir, 'models-store.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
  };

  const runtime = () => {
    runtimePromise ??= buildRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
    return runtimePromise;
  };

  /**
   * Providers with whether each has a credential, and which kinds of login it
   * offers. `source` is how Pi found the credential (`stored`, `models_json_key`,
   * `environment`, `runtime`); for `environment`, `sourceLabel` names the
   * variable. A key that comes from the environment shows up only after an
   * availability pass, which `getAvailable()` below runs first.
   */
  const providers = async ({ includeHidden = false } = {}) => {
    const rt = await runtime();
    await rt.getAvailable();
    const credentials = new Map((await rt.listCredentials()).map((info) => [info.providerId, info]));
    const hidden = includeHidden ? new Set() : new Set(getHiddenProviders());
    return rt.getProviders().filter((provider) => !hidden.has(provider.id)).map((provider) => {
      const status = rt.getProviderAuthStatus(provider.id);
      const firstModel = rt.getModels(provider.id)[0];
      return {
        id: provider.id,
        name: provider.name ?? provider.id,
        configured: Boolean(status?.configured),
        source: status?.source ?? null,
        sourceLabel: status?.label ?? null,
        credentialType: credentials.get(provider.id)?.type ?? null,
        auth: {
          apiKey: Boolean(provider.auth?.apiKey),
          oauth: Boolean(provider.auth?.oauth),
          oauthName: provider.auth?.oauth?.name ?? null,
          oauthLoginLabel: provider.auth?.oauth?.loginLabel ?? null,
        },
        modelCount: rt.getModels(provider.id).length,
        api: firstModel?.api ?? null,
        baseUrl: provider.baseUrl ?? null,
      };
    });
  };

  /**
   * Models, either the whole catalog or only those whose provider has working
   * auth. Without `types` only chat models are listed (what a session can run
   * on). `types` (`'chat'`, `'image'`) selects among Pi's other model kinds;
   * classifier models are never listed.
   *
   * @param {{ availableOnly?: boolean, types?: string[] }} [options]
   */
  const models = async ({ availableOnly = false, types } = {}) => {
    const rt = await runtime();
    const hidden = new Set(getHiddenProviders());
    const shown = (list) => list.filter((model) => !hidden.has(model.provider));
    if (types) {
      const wanted = new Set(types);
      const list = availableOnly ? await rt.getAllAvailable() : rt.getAllModels();
      return shown(list).filter((model) => wanted.has(model.type ?? 'chat')).map(toModel);
    }
    const list = availableOnly ? await rt.getAvailable() : rt.getModels();
    return shown(list).map(toModel);
  };

  /** What Pi reports about its own configuration: for now the `models.json` parse error, when there is one. */
  const configError = async () => (await runtime()).getError() ?? null;

  const model = async (providerId, modelId) => {
    const rt = await runtime();
    const found = rt.getModel(providerId, modelId);
    return found ? toModel(found) : null;
  };

  /** Store an API key in Pi's `auth.json`. */
  const setApiKey = async (providerId, key) => {
    const rt = await runtime();
    await rt.login(providerId, 'api_key', {
      prompt: async () => key,
      notify: () => {},
    });
  };

  /** Remove a provider's stored credential. */
  const removeCredential = async (providerId) => {
    const rt = await runtime();
    await rt.logout(providerId);
  };

  /** Rebuild after `models.json` or `auth.json` was edited outside the runtime. */
  const reload = () => {
    runtimePromise = null;
  };

  /** Pi's `ModelRuntime` itself, for the login flows and the tests that register a provider on it. */
  const getRuntime = () => runtime();

  /** What `auth.json` holds, without secrets: `{ providerId, type }` per stored credential. */
  const listCredentials = async () => [...(await (await runtime()).listCredentials())];

  /**
   * Runs one of Pi's login flows (`api_key` or `oauth`) and stores the result in
   * `auth.json` under Pi's file lock. `interaction` is Pi's `AuthInteraction`.
   */
  const login = async (providerId, type, interaction) => {
    const rt = await runtime();
    return rt.login(providerId, type, interaction);
  };

  return { providers, models, model, configError, setApiKey, removeCredential, reload, getRuntime, listCredentials, login };
};
