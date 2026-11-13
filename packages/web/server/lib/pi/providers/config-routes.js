// The OpenChamber routes the Providers page and the custom-provider form call,
// moved from OpenCode's config files to Pi's. Same URLs and response shapes as
// `opencode/routes.js` had; what they edit is `models.json`, `settings.json`
// and OpenChamber's own provider files (`service.js` says which).
//
//   GET    /api/provider/disabled                  { providers }
//   PUT    /api/provider/:providerId/disabled      { disabled } -> { providers, success, message }
//   GET    /api/provider/:providerId/source        { providerId, sources, config }
//   PUT    /api/provider                           { providerID, config, scope?, hasCredential? } -> { success, message, providerId, path, config }
//   POST   /api/provider/discover-models           the form's model probe, enterprise mode refuses
//   DELETE /api/provider/:providerId/auth          ?scope=auth (default) logs out; user|all removes the models.json entry
//   GET    /api/pi/model-settings                  the model keys of Pi's settings.json
//   PUT    /api/pi/model-settings                  { defaultModel?, defaultThinkingLevel?, enabledModels?, modelThinkingLevels? }
//
// A refusal or failure answers `{ error, code? }` like the routes it replaces:
// 400 for input Pi would not accept, 403 `enterprise_mode`, 409 when
// `models.json` or `settings.json` cannot be parsed (nothing is written then),
// 503 while the bridge is down.
//
// `deps`: `getProviders()` (the bridge's provider service, or null while it is
// down) and `discoverProviderModels` (`opencode/model-discovery.js`).

import { WireError } from '../bridge/errors.js';
import { discoverProviderModels as defaultDiscoverProviderModels } from '../../opencode/model-discovery.js';

const applied = (message) => ({ success: true, message });

/** @param {import('express').Express} app */
export const registerProviderConfigRoutes = (app, { getProviders, discoverProviderModels = defaultDiscoverProviderModels, log = (message) => console.warn(`[pi-providers] ${message}`) }) => {
  const respondError = (res, error, fallback) => {
    if (error instanceof WireError) {
      return res.status(error.status).json({ error: error.message, ...(typeof error.extra?.code === 'string' ? { code: error.extra.code } : {}) });
    }
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) log(`${fallback}: ${error?.message ?? error}`);
    return res.status(status).json({ error: status >= 500 ? fallback : error.message });
  };

  /** A handler that gets the provider service, or answers 503 while the bridge is down. */
  const route = (fallback, handle) => async (req, res) => {
    const providers = getProviders();
    if (!providers) return res.status(503).json({ error: 'The Pi bridge is not running' });
    try {
      return await handle(providers, req, res);
    } catch (error) {
      return respondError(res, error, fallback);
    }
  };

  app.get('/api/provider/disabled', route('Failed to read disabled providers', (providers, _req, res) => res.json({ providers: providers.disabledProviders() })));

  app.put('/api/provider/:providerId/disabled', route('Failed to update disabled providers', (providers, req, res) => {
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false' });
    return res.json({ providers: providers.setProviderDisabled(req.params.providerId, req.body.disabled), ...applied('Provider updated.') });
  }));

  app.get('/api/provider/:providerId/source', route('Failed to get provider sources', async (providers, req, res) => res.json(await providers.sourceOf(req.params.providerId))));

  app.put('/api/provider', route('Failed to save provider config', async (providers, req, res) => {
    providers.assertCanAdd();
    const body = req.body ?? {};
    const providerId = typeof body.providerID === 'string' ? body.providerID.trim() : (typeof body.providerId === 'string' ? body.providerId.trim() : '');
    if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) return res.status(400).json({ error: 'Provider config is required' });
    const scope = typeof body.scope === 'string' ? body.scope : 'user';
    if (scope !== 'user' && scope !== 'project' && scope !== 'custom') return res.status(400).json({ error: 'Invalid scope' });
    const saved = await providers.saveProvider({ providerId, config: body.config, scope, hasCredential: body.hasCredential === true });
    return res.json({ ...applied(`Provider ${providerId} saved.`), providerId: saved.providerId, path: saved.path, config: saved.config });
  }));

  app.post('/api/provider/discover-models', route('Failed to discover provider models', async (providers, req, res) => {
    providers.assertCanAdd();
    const providerId = typeof req.body?.providerID === 'string' ? req.body.providerID.trim() : '';
    // A stored key that cannot be read leaves discovery to the key in the form.
    let defaults = { storedApiKey: null, storedBaseURL: undefined };
    if (providerId) {
      try {
        defaults = await providers.discoveryDefaults(providerId);
      } catch {
        defaults = { storedApiKey: null, storedBaseURL: undefined };
      }
    }
    try {
      return res.json(await discoverProviderModels(req.body, defaults));
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Failed to discover provider models',
        code: typeof error?.code === 'string' ? error.code : 'discovery_failed',
      });
    }
  }));

  app.delete('/api/provider/:providerId/auth', route('Failed to disconnect provider', async (providers, req, res) => {
    const { providerId } = req.params;
    if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
    const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
    let removed;
    if (scope === 'auth') removed = await providers.removeProviderCredential(providerId);
    else if (scope === 'user' || scope === 'project' || scope === 'custom') removed = providers.removeProviderConfig(providerId, scope);
    else if (scope === 'all') removed = providers.removeProviderConfig(providerId, 'user');
    else return res.status(400).json({ error: 'Invalid scope' });
    if (removed) return res.json({ success: true, removed, ...applied('Provider disconnected successfully.') });
    return res.json({ success: true, removed, requiresReload: false, message: 'Provider was not connected' });
  }));

  app.get('/api/pi/model-settings', route('Failed to read the model settings', (providers, _req, res) => res.json(providers.readModelSettings())));

  app.put('/api/pi/model-settings', route('Failed to save the model settings', (providers, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Expected a JSON object' });
    const { defaultModel, defaultThinkingLevel, enabledModels, modelThinkingLevels } = body;
    return res.json({ ...providers.updateModelSettings({ defaultModel, defaultThinkingLevel, enabledModels, modelThinkingLevels }), ...applied('Model settings saved.') });
  }));
};
