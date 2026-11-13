// Provider, key and login management on Pi, behind one object. The bridge routes
// (`bridge-routes.js`, the OpenCode wire dialect the Providers page reads) and
// the OpenChamber Express routes (`config-routes.js`) are thin faces over it, so
// the rules live once: what counts as connected, what a write may do, what
// enterprise mode refuses, and what the UI is told afterwards.
//
// Files it touches, all in Pi's agent directory except the last:
// - `auth.json`: only through Pi's `ModelRuntime.login` and `logout`, which hold
//   Pi's file lock and keep the running runtime in step. Read, never written,
//   for the one question "does this credential hold a key".
// - `models.json`: custom providers (`custom-provider.js`, `models-file.js`).
// - `settings.json`: the model keys (`model-settings.js`).
// - OpenChamber's own `provider-state.js` files: switched-off providers and the
//   names of stored logins.

import { WireError, invalidRequest } from '../bridge/errors.js';
import { readJsonObject, agentPaths } from '../bridge/routes/pi-files.js';
import { credentialIdFor, OAUTH_METHOD_ID } from '../bridge/routes/integrations.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode as defaultIsEnterpriseMode } from '../../enterprise-mode.js';
import { buildProviderEntry, envNameOf, PROVIDER_ID_PATTERN, toStoredConfig } from './custom-provider.js';
import { JsonDocumentError } from './json-document.js';
import { formOfRoute, interactionForRoute, planApiKeyLogin } from './login-plan.js';
import { createModelSettings } from './model-settings.js';
import { createModelsFile } from './models-file.js';
import { createOAuthFlows, oauthFormFor } from './oauth-flows.js';

/** The id prefix of an `external` method: the route of the provider's key login that stores no key. */
export const EXTERNAL_METHOD_PREFIX = 'external:';
const CREDENTIAL_PREFIX = 'cred_';

const integrationNotFound = (integrationID) => new WireError(404, 'IntegrationNotFoundError', `Integration not found: ${integrationID}`, { integrationID });
const methodNotFound = (integrationID, methodID) => new WireError(404, 'IntegrationMethodNotFoundError', `Method not found: ${methodID}`, { integrationID, methodID });
const enterpriseRefusal = () => new WireError(403, 'ForbiddenError', ENTERPRISE_MODE_ERROR, { code: 'enterprise_mode' });
const unavailable = (message) => new WireError(503, 'ServiceUnavailableError', message, { service: 'pi' });

/** A file that cannot be used is a conflict the person has to resolve, never an empty answer. */
const fileProblem = (error) => (error instanceof JsonDocumentError
  ? new WireError(409, 'ConflictError', error.message, { code: 'config_file_unusable' })
  : error);

/**
 * @param {object} options
 * @param {ReturnType<import('../catalog.js').createPiCatalog>} options.catalog  Built with `getHiddenProviders: state.disabledProviders`.
 * @param {ReturnType<import('./provider-state.js').createProviderState>} options.state
 * @param {{ emit: (event: object) => unknown }} options.hub
 * @param {() => string} options.getAgentDir
 * @param {() => string} [options.getDefaultDirectory]  The location the announcements carry.
 * @param {() => boolean} [options.isEnterpriseMode]
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.flowOptions]  Timings of the OAuth attempts (tests).
 */
export const createProviderService = ({
  catalog,
  state,
  hub,
  getAgentDir,
  getDefaultDirectory = () => null,
  isEnterpriseMode = defaultIsEnterpriseMode,
  log = (message) => console.warn(`[pi-providers] ${message}`),
  flowOptions = {},
}) => {
  const models = createModelsFile({ getAgentDir });
  const modelSettings = createModelSettings({ getAgentDir });
  const authFile = () => agentPaths(getAgentDir()).auth;

  // --- what the UI is told ---------------------------------------------------

  const announce = ({ credentials = false } = {}) => {
    let directory = null;
    try { directory = getDefaultDirectory(); } catch { /* an announcement does not need a folder */ }
    const location = directory ? { directory } : undefined;
    if (credentials) hub.emit({ type: 'credential.updated', data: {}, ...(location ? { location } : {}) });
    for (const type of ['integration.updated', 'provider.updated', 'model.updated']) {
      hub.emit({ type, data: {}, ...(location ? { location } : {}) });
    }
  };

  // --- enterprise mode -------------------------------------------------------

  /** Adding a provider, a key or a login is refused in enterprise mode, here where the write happens. */
  const assertCanAdd = () => {
    if (isEnterpriseMode()) throw enterpriseRefusal();
  };

  // --- reading Pi ------------------------------------------------------------

  const fromPi = async (read, what = "Pi's model catalog is unavailable") => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof WireError) throw error;
      throw unavailable(`${what}: ${error?.message ?? error}`);
    }
  };

  const declaredProviders = () => {
    try {
      return models.readProviders();
    } catch {
      return {};
    }
  };

  /**
   * Reads `auth.json`. Pi writes it in place under its own lock, so a read that lands
   * in the middle of another login's write can see half a file: a read that fails is
   * repeated briefly, and only a file that stays unreadable is reported.
   */
  const readAuthFile = async () => {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25));
      last = await readJsonObject(authFile());
      if (!last.error) break;
    }
    // An unreadable auth.json is not "no keys".
    if (last.error) throw unavailable(last.error);
    return last.value ?? {};
  };

  /** Whether each stored credential holds a key; a credential without one (an AWS profile) is an `external` connection. */
  const credentialsWithKeys = async () => {
    return new Map(Object.entries(await readAuthFile()).map(([providerId, credential]) => [
      providerId,
      Boolean(credential && typeof credential === 'object' && typeof credential.key === 'string' && credential.key !== ''),
    ]));
  };

  const loginPlans = new WeakMap();
  /** Which prompts the provider's API-key login asks (`login-plan.js`), found once per login function. */
  const planOf = (live) => {
    const login = live?.auth?.apiKey?.login;
    if (typeof login !== 'function') return Promise.resolve({ keyRoute: null, externalRoutes: [] });
    let plan = loginPlans.get(login);
    if (!plan) {
      plan = planApiKeyLogin(login.bind(live.auth.apiKey));
      loginPlans.set(login, plan);
    }
    return plan;
  };

  const envHints = new WeakMap();
  /**
   * The variables a built-in provider reads its key from, learned by asking its
   * own resolver which ones it looks up (it finds none set). A provider written
   * in `models.json` names its variable in `apiKey` instead, and its resolver is
   * never run: it may execute a command.
   */
  const envNamesOf = async (live, declared) => {
    if (declared) return envNameOf(declared.apiKey) ? [envNameOf(declared.apiKey)] : [];
    const resolver = live?.auth?.apiKey;
    if (!resolver?.resolve) return [];
    if (!envHints.has(live)) {
      envHints.set(live, (async () => {
        const names = new Set();
        try {
          await resolver.resolve({
            ctx: { env: async (name) => { names.add(name); return undefined; }, fileExists: async () => false },
            credential: undefined,
            signal: AbortSignal.timeout(500),
          });
        } catch { /* a resolver that needs more than the environment tells nothing */ }
        return [...names];
      })());
    }
    return envHints.get(live);
  };

  const toIntegration = async (rt, provider, { declared, keyed, labels }) => {
    const live = rt.getProvider(provider.id);
    const plan = await planOf(live);
    const envNames = await envNamesOf(live, declared[provider.id]);
    const methods = [];
    if (plan.keyRoute) {
      const form = formOfRoute(plan.keyRoute);
      methods.push({ type: 'key', ...(form.length > 0 ? { form } : {}) });
    }
    if (envNames.length > 0) methods.push({ type: 'env', names: envNames });
    if (provider.auth.oauth) {
      const form = oauthFormFor(provider.id);
      methods.push({
        id: OAUTH_METHOD_ID,
        type: 'oauth',
        label: provider.auth.oauthLoginLabel ?? `Sign in with ${provider.auth.oauthName ?? provider.name}`,
        ...(form.length > 0 ? { form } : {}),
      });
    }
    for (const route of plan.externalRoutes) {
      const form = formOfRoute(route);
      methods.push({ id: `${EXTERNAL_METHOD_PREFIX}${route.id}`, type: 'external', label: route.label, ...(form.length > 0 ? { form } : {}) });
    }

    const connections = [];
    if (provider.credentialType) {
      connections.push({
        type: 'credential',
        id: credentialIdFor(provider.id),
        label: labels[provider.id] ?? 'default',
        method: provider.credentialType === 'oauth' ? 'oauth' : (keyed.get(provider.id) === false ? 'external' : 'key'),
      });
    }
    if (provider.source === 'environment' && provider.sourceLabel) connections.push({ type: 'env', name: provider.sourceLabel });
    return { id: provider.id, name: provider.name, methods, connections };
  };

  /** Every provider Pi lists that the user has not switched off, with how it connects and what is connected. */
  const integrations = () => fromPi(async () => {
    const [rt, visible, keyed] = await Promise.all([catalog.getRuntime(), catalog.providers(), credentialsWithKeys()]);
    const context = { declared: declaredProviders(), keyed, labels: state.labels() };
    return Promise.all(visible.map((provider) => toIntegration(rt, provider, context)));
  });

  const requireIntegration = async (integrationID) => {
    const found = (await integrations()).find((integration) => integration.id === integrationID);
    if (!found) throw integrationNotFound(integrationID);
    return found;
  };

  // --- connecting ------------------------------------------------------------

  const runKeyLogin = async (providerId, route, input) => {
    try {
      await fromPi(() => catalog.login(providerId, 'api_key', interactionForRoute(route, input)), 'Pi could not store the credential');
    } catch (error) {
      // A provider's own login may put what it was given into its message.
      if (error instanceof WireError && error.status === 503 && typeof input.key === 'string' && input.key !== '') {
        throw unavailable(error.message.split(input.key).join('[redacted]'));
      }
      throw error;
    }
  };

  /**
   * Keeps the name of a login. It runs after Pi stored or removed the credential,
   * so a file of ours that cannot be written is logged and never fails the request.
   */
  const rememberLabel = (providerId, label) => {
    try {
      state.setLabel(providerId, label);
    } catch (error) {
      log(`could not keep the name of the ${providerId} login: ${error?.message ?? error}`);
    }
  };
  const remember = (providerId, label) => {
    if (typeof label === 'string') rememberLabel(providerId, label.trim());
  };

  /** Stores an API key through the provider's own login, with the extra answers its form asked for. */
  const connectKey = async ({ integrationID, key, answer, label }) => {
    assertCanAdd();
    if (typeof key !== 'string' || key.trim() === '') throw invalidRequest('key is required', { kind: 'Payload', field: 'key' });
    await requireIntegration(integrationID);
    const live = (await catalog.getRuntime()).getProvider(integrationID);
    const { keyRoute } = await planOf(live);
    if (!keyRoute) throw methodNotFound(integrationID, 'key');
    await runKeyLogin(integrationID, keyRoute, { key: key.trim(), answer });
    remember(integrationID, label);
    announce({ credentials: true });
  };

  /** Connects a credential that holds no key (an AWS profile, Google Application Default Credentials). */
  const connectExternal = async ({ integrationID, methodID, answer, label }) => {
    assertCanAdd();
    await requireIntegration(integrationID);
    const live = (await catalog.getRuntime()).getProvider(integrationID);
    const { externalRoutes } = await planOf(live);
    const route = typeof methodID === 'string' && methodID.startsWith(EXTERNAL_METHOD_PREFIX)
      ? externalRoutes.find((candidate) => candidate.id === methodID.slice(EXTERNAL_METHOD_PREFIX.length))
      : undefined;
    if (!route) throw methodNotFound(integrationID, String(methodID));
    await runKeyLogin(integrationID, route, { answer });
    remember(integrationID, label);
    announce({ credentials: true });
  };

  const flows = createOAuthFlows({
    login: (providerId, interaction) => catalog.login(providerId, 'oauth', interaction),
    onSettled: (attempt) => {
      remember(attempt.providerId, attempt.label);
      announce({ credentials: true });
    },
    log,
    ...flowOptions,
  });

  const startOAuth = async ({ integrationID, methodID, answer, label }) => {
    assertCanAdd();
    const integration = await requireIntegration(integrationID);
    if (methodID !== OAUTH_METHOD_ID || !integration.methods.some((method) => method.type === 'oauth')) throw methodNotFound(integrationID, String(methodID));
    return flows.start({ providerId: integrationID, answer: answer ?? {}, label });
  };
  const oauthStatus = (integrationID, attemptID) => flows.status(integrationID, attemptID);
  const completeOAuth = async (integrationID, attemptID, code) => {
    assertCanAdd();
    await flows.complete(integrationID, attemptID, code);
  };
  const cancelOAuth = (integrationID, attemptID) => flows.cancel(integrationID, attemptID);

  // --- stored credentials ----------------------------------------------------

  const providerOfCredential = (credentialID) => (typeof credentialID === 'string' && credentialID.startsWith(CREDENTIAL_PREFIX)
    ? credentialID.slice(CREDENTIAL_PREFIX.length)
    : null);

  const storedProviders = async () => new Set((await fromPi(() => catalog.listCredentials())).map((entry) => entry.providerId));

  const requireCredential = async (credentialID) => {
    const providerId = providerOfCredential(credentialID);
    if (!providerId || !(await storedProviders()).has(providerId)) throw invalidRequest(`Credential not found: ${credentialID}`, { kind: 'Payload', field: 'credentialID' });
    return providerId;
  };

  /** Pi keeps one credential per provider, so the one that exists is already the active one. */
  const activateCredential = async (credentialID) => {
    await requireCredential(credentialID);
  };

  const renameCredential = async (credentialID, label) => {
    const providerId = await requireCredential(credentialID);
    if (typeof label !== 'string') throw invalidRequest('label is required', { kind: 'Payload', field: 'label' });
    try {
      state.setLabel(providerId, label.trim());
    } catch (error) {
      throw fileProblem(error);
    }
    announce({ credentials: true });
  };

  /** Logs out. Removing what is not there is not an error: the page asked for it to be gone. */
  const removeCredential = async (credentialID) => {
    const providerId = providerOfCredential(credentialID);
    if (!providerId) throw invalidRequest(`Credential not found: ${credentialID}`, { kind: 'Payload', field: 'credentialID' });
    if (!(await storedProviders()).has(providerId)) return;
    await fromPi(() => catalog.removeCredential(providerId), 'Pi could not remove the credential');
    rememberLabel(providerId, '');
    announce({ credentials: true });
  };

  /** Logout by provider, for the route that names a provider and no credential. */
  const removeProviderCredential = async (providerId) => {
    if (!(await storedProviders()).has(providerId)) return false;
    await removeCredential(credentialIdFor(providerId));
    return true;
  };

  // --- custom providers in models.json ---------------------------------------

  const readEntry = (providerId) => {
    try {
      const entry = models.readProviders()[providerId];
      return entry && typeof entry === 'object' ? entry : null;
    } catch (error) {
      throw fileProblem(error);
    }
  };

  /** What the edit form loads: where the provider is declared, and its entry in the form's spelling. */
  const sourceOf = async (providerId) => {
    const entry = readEntry(providerId);
    return {
      providerId,
      sources: {
        auth: { exists: (await storedProviders()).has(providerId) },
        user: { exists: entry !== null, path: models.filePath() },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
      },
      config: entry ? toStoredConfig(entry) : null,
    };
  };

  /** Pi has one `models.json`, so the form's project and custom layers do not exist. */
  const assertUserScope = (scope) => {
    if (scope !== 'user') throw invalidRequest(`Pi keeps custom providers in one file, ${models.filePath()}. The "${scope}" scope does not exist.`, { kind: 'Payload', field: 'scope' });
  };

  const saveProvider = async ({ providerId, config, scope = 'user', hasCredential = false }) => {
    assertCanAdd();
    assertUserScope(scope);
    const hasStoredAuth = hasCredential === true || (await storedProviders()).has(providerId);
    let written;
    try {
      written = models.updateProvider(providerId, (existing) => {
        const built = buildProviderEntry(providerId, config, existing, { hasStoredAuth });
        if (!built.ok) throw invalidRequest(built.error, { kind: 'Payload' });
        return built.entry;
      });
    } catch (error) {
      throw fileProblem(error);
    }
    // models.json is written; a switch-off file that cannot be changed does not undo that.
    try {
      if (state.disabledProviders().includes(providerId)) state.setDisabled(providerId, false);
    } catch (error) {
      log(`could not switch ${providerId} back on: ${error?.message ?? error}`);
    }
    catalog.reload();
    announce();
    return { providerId, path: written.file, config: toStoredConfig(written.result) };
  };

  /** Removes the provider's entry from `models.json`; true when there was one. */
  const removeProviderConfig = (providerId, scope = 'user') => {
    if (scope === 'project' || scope === 'custom') return false;
    let removed;
    try {
      removed = models.removeProvider(providerId).result;
    } catch (error) {
      throw fileProblem(error);
    }
    if (removed) {
      catalog.reload();
      announce();
    }
    return removed;
  };

  /** What model discovery falls back on for a provider that already exists: its stored key and base URL. */
  const discoveryDefaults = async (providerId) => {
    const entry = readEntry(providerId);
    const stored = (await readAuthFile())[providerId];
    let storedApiKey = stored?.type === 'api_key' && typeof stored.key === 'string' && stored.key !== '' && !stored.key.startsWith('!') ? stored.key : null;
    if (!storedApiKey && typeof entry?.apiKey === 'string' && entry.apiKey !== '') {
      const envName = envNameOf(entry.apiKey);
      // A command in `models.json` is never run for a probe.
      if (envName) storedApiKey = `{env:${envName}}`;
      else if (!entry.apiKey.startsWith('!')) storedApiKey = entry.apiKey;
    }
    return { storedApiKey, storedBaseURL: typeof entry?.baseUrl === 'string' ? entry.baseUrl : undefined };
  };

  // --- switched-off providers ------------------------------------------------

  const disabledProviders = () => state.disabledProviders();

  const setProviderDisabled = (providerId, disabled) => {
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) throw invalidRequest('Invalid provider ID', { kind: 'Payload', field: 'providerId' });
    let next;
    try {
      next = state.setDisabled(providerId, disabled);
    } catch (error) {
      throw fileProblem(error);
    }
    announce();
    return next;
  };

  // --- model keys of settings.json -------------------------------------------

  const readModelSettings = () => {
    try {
      return modelSettings.read();
    } catch (error) {
      throw fileProblem(error);
    }
  };

  const updateModelSettings = (patch) => {
    try {
      const next = modelSettings.update(patch);
      announce();
      return next;
    } catch (error) {
      if (error?.statusCode === 400) throw invalidRequest(error.message, { kind: 'Payload' });
      throw fileProblem(error);
    }
  };

  return {
    integrations,
    integration: requireIntegration,
    connectKey,
    connectExternal,
    startOAuth,
    oauthStatus,
    completeOAuth,
    cancelOAuth,
    activateCredential,
    renameCredential,
    removeCredential,
    removeProviderCredential,
    sourceOf,
    saveProvider,
    removeProviderConfig,
    discoveryDefaults,
    disabledProviders,
    setProviderDisabled,
    readModelSettings,
    updateModelSettings,
    assertCanAdd,
    close: () => flows.close(),
  };
};
