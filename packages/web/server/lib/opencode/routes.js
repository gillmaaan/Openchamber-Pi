import { readOpenCodeInfo, isSupportedOpenCodeVersion } from './compatibility.js';
import { createSharedHealthProbe, parseHealthWaitMs, waitForOpenCodeHealth } from './health-wait.js';
import express from 'express';
import { resolveNpmRegistryRequest } from './npm-registry-config.js';
import fs from 'fs';
import path from 'path';
import {
  buildAppliedResponse,
} from './config-mutation-response.js';
import { getClaudeCliAuthStatus } from './claude-cli-auth.js';
import { OPENCODE_CONFIG_DIR, readConfigLayers } from './shared.js';
import { settingsSurfaceOf } from './settings-files.js';
import { compactionUpdateSchema, parseWebSearchSelection, readSectionEntry, toProviderEntity } from './config-v2.js';
import { getWebSearchSource, setCompactionSettings, setWarmingEnabled, setWebSearchSelection } from './websearch-config.js';
import {
  CREDENTIAL_LIST_ERROR,
  ENTERPRISE_MODE_ERROR,
  isCredentialListRequest,
  isEnterpriseMode,
  isProviderConnectRequest,
} from '../enterprise-mode.js';
import { vcsInitRefusal, vcsInitRefusalBody } from '../git/repository-root.js';

// Version reads use the same short deadline as the health probe of `/api/info`.
const OPENCODE_INFO_TIMEOUT_MS = 3_000;

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    upgradeOpenCodeCli,
    getOpenCodeCompatibility,
    installOpenCodeV2,
    formatSettingsResponse,
    readSettingsFromDiskMigrated,
    persistSettings,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    upsertProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = dependencies;

  let authLibrary = null;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const parseVersionForComparison = (value) => {
    const normalized = String(value || '').replace(/^v/, '').split('+')[0];
    const prereleaseIndex = normalized.indexOf('-');
    const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { parts, prerelease: prereleaseIndex >= 0 };
  };

  const compareVersions = (left, right) => {
    const a = parseVersionForComparison(left);
    const b = parseVersionForComparison(right);
    const length = Math.max(a.parts.length, b.parts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff !== 0) return diff;
    }
    if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
    return 0;
  };

  // OpenCode 2.x publishes as `@opencode/cli` on npm and has no GitHub
  // release assets, so the registry is the one source of "latest".
  const fetchLatestOpenCodeVersion = async () => {
    const request = resolveNpmRegistryRequest('@opencode/cli', 'latest');
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode npm registry responded with ${response.status}`);
    }
    const payload = await response.json();
    const version = typeof payload?.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
    if (!version) throw new Error('Failed to resolve latest OpenCode version');
    return version;
  };

  app.get('/api/config/settings', async (req, res) => {
    try {
      // The surface kind resolves the per-surface profile keys; absent means base.
      const settings = await readSettingsFromDiskMigrated({ surface: settingsSurfaceOf(req) });
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  app.get('/api/opencode/compatibility', async (_req, res) => {
    try { res.json(await getOpenCodeCompatibility()); }
    catch { res.status(503).json({ error: 'Could not check OpenCode compatibility.' }); }
  });

  let installInFlight = null;
  app.post('/api/opencode/install-v2', async (_req, res) => {
    try {
      if (!installInFlight) {
        installInFlight = (async () => {
          const compatibility = await getOpenCodeCompatibility();
          if (!compatibility.canInstall) return false;
          await installOpenCodeV2();
          return true;
        })().finally(() => { installInFlight = null; });
      }
      const installed = await installInFlight;
      if (!installed) return res.status(409).json({ success: false, error: 'Automatic OpenCode v2 installation is unavailable for this runtime.' });
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ success: false, error: 'OpenCode v2 installation or restart failed. Retry or use the installation guide.' });
    }
  });

  let upgradeInFlight = null;
  app.post('/api/opencode/upgrade', async (_req, res) => {
    const capability = getOpenCodeUpgradeCapability();
    if (!capability.supported) {
      const bundled = capability.reason === 'bundled';
      const pinned = capability.reason === 'policy';
      return res.status(409).json({
        success: false,
        code: bundled ? 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER' : 'OPENCODE_UPGRADE_UNSUPPORTED',
        error: bundled
          ? 'OpenCode is bundled with OpenChamber Desktop and updates with the app.'
          : pinned
            ? 'Your administrator manages this OpenCode installation.'
            : 'This OpenCode runtime cannot be upgraded by OpenChamber.',
      });
    }
    try {
      // Multiple tabs share one installation. Clear both success and failure so
      // a later explicit attempt can run again.
      if (!upgradeInFlight) {
        upgradeInFlight = upgradeOpenCodeCli().finally(() => { upgradeInFlight = null; });
      }
      await upgradeInFlight;
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // The agent is bundled with OpenChamber and updates with it: this reports the
  // version that runs and never asks a registry for a newer one.
  app.get('/api/opencode/upgrade-status', async (_req, res) => {
    try {
      const capability = getOpenCodeUpgradeCapability();
      const { version } = await getOpenCodeCompatibility();
      return res.json({ available: false, currentVersion: version, latestVersion: version, upgrade: capability });
    } catch (error) {
      return res.status(500).json({
        available: null,
        error: error instanceof Error ? error.message : 'Failed to read the agent version',
      });
    }
  });

  // OpenCode 2.0.8 removed `GET /api/health`; `GET /api/info` replaces it and a
  // 200 from it is the readiness signal (there is no `healthy` field any more).
  // OpenChamber's own `{ healthy }` response shape stays as its clients know it.
  const probeOpenCodeHealth = async () => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(OPENCODE_INFO_TIMEOUT_MS),
      });
      const info = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return {
          healthy: false,
          status: healthResponse.status,
          body: { healthy: false, error: info?.error || healthResponse.statusText || 'OpenCode health check failed' },
        };
      }
      const parsed = await readOpenCodeInfo(Response.json(info));
      const healthy = parsed !== null && isSupportedOpenCodeVersion(parsed.version);
      // OpenCode answered: an unsupported version stays unsupported however long a client waits.
      return { healthy, final: true, status: 200, body: { healthy } };
    } catch (error) {
      return {
        healthy: false,
        status: 503,
        body: { healthy: false, error: error instanceof Error ? error.message : 'OpenCode health check failed' },
      };
    }
  };

  // Concurrent waiters (several windows, tabs or devices starting together)
  // share one probe per interval.
  const sharedOpenCodeHealthProbe = createSharedHealthProbe({ probe: probeOpenCodeHealth });

  // `?wait=<ms>` holds an unhealthy answer until OpenCode is ready or the wait
  // runs out (capped), so a starting client learns of readiness at once.
  app.get('/api/opencode/health', async (req, res) => {
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const result = await waitForOpenCodeHealth({
      probe: sharedOpenCodeHealthProbe,
      waitMs: parseHealthWaitMs(req.query?.wait),
      isAborted: () => clientGone,
    });
    if (clientGone) return;
    return res.status(result.status).json(result.body);
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const { version } = await getOpenCodeCompatibility();
      return res.json({ version });
    } catch (error) {
      return res.status(500).json({
        version: null,
        error: error instanceof Error ? error.message : 'Failed to read the agent version',
      });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const updated = await persistSettings(req.body ?? {}, { surface: settingsSurfaceOf(req) });
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // Enterprise mode: model providers come from the OpenCode config the
  // administrator controls, so nothing in the app may connect a new one or
  // add a key. These OpenCode routes otherwise reach it through the generic
  // proxy; removing or switching an existing account stays allowed, it only
  // narrows access. The real lock is OpenCode's `provider.use` policy.
  const refuseInEnterpriseMode = (_req, res, next) => (
    isEnterpriseMode() ? res.status(403).json({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' }) : next()
  );
  app.use((req, res, next) => (
    isProviderConnectRequest(req.method, req.path) ? refuseInEnterpriseMode(req, res, next) : next()
  ));

  // Every stored key, secrets included (OpenCode 2.0.20): this server reads it
  // for itself through `auth.js`, and no client gets it through the proxy.
  app.use((req, res, next) => (
    isCredentialListRequest(req.method, req.path)
      ? res.status(403).json({ error: CREDENTIAL_LIST_ERROR, code: 'credential_list_refused' })
      : next()
  ));

  // `git init` in home or at a disk root makes a repository Git surfaces then
  // ignore; refuse it here so no client can create one through the proxy.
  app.use((req, res, next) => {
    const refusal = vcsInitRefusal(req.method, req.originalUrl, req.headers);
    return refusal ? res.status(400).json(vcsInitRefusalBody(refusal)) : next();
  });

  // The web search choice (`websearch` in OpenCode config). OpenCode watches
  // the file and announces `config.updated`, so nothing restarts.
  // Whether a project config decides `websearch` for the directory, so
  // Settings can say so instead of letting a write snap back.
  app.get('/api/config/websearch', async (req, res) => {
    try {
      const resolved = await resolveProjectDirectory(req);
      return res.json(getWebSearchSource(resolved.directory || null));
    } catch (error) {
      console.error('Failed to read the web search config source:', error);
      return res.status(500).json({ error: error.message || 'Failed to read the web search config source' });
    }
  });

  app.put('/api/config/websearch', (req, res) => {
    const selection = parseWebSearchSelection(req.body?.selection);
    if (selection === undefined) {
      return res.status(400).json({ error: 'selection must be false, null, "random" or a provider id' });
    }
    try {
      const result = setWebSearchSelection(selection);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save the web search choice:', error);
      return res.status(500).json({ error: error.message || 'Failed to save the web search choice' });
    }
  });

  // Session warming (`warming` in OpenCode config), written like the web
  // search choice above. Settings reads the effective value from OpenCode.
  app.put('/api/config/warming', (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      const result = setWarmingEnabled(enabled);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save session warming:', error);
      return res.status(500).json({ error: error.message || 'Failed to save session warming' });
    }
  });

  // Compaction settings (`compaction` and `experimental.background_compaction`
  // in OpenCode config), written the same way. Settings reads them from OpenCode.
  app.put('/api/config/compaction', (req, res) => {
    const parsed = compactionUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'buffer must be a token count, a share such as "20%" or null, keepTokens a token count or null, auto and background booleans' });
    }
    try {
      const result = setCompactionSettings(parsed.data);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save compaction settings:', error);
      return res.status(500).json({ error: error.message || 'Failed to save compaction settings' });
    }
  });

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        await fs.promises.access(AGENTS_MD_PATH);
      } catch {
        return res.json({ content: '', exists: false, path: AGENTS_MD_PATH });
      }
      const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
      return res.json({ content, exists: true, path: AGENTS_MD_PATH });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      // `expectedContent` is what the editor loaded (null: no file). A file
      // changed on disk since then is not overwritten with the stale copy.
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedContent')) {
        const expected = req.body.expectedContent;
        let current = null;
        try {
          current = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== expected) {
          return res.status(409).json({
            error: 'AGENTS.md changed on disk since it was loaded',
            code: 'AGENTS_MD_CONFLICT',
          });
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      return res.json(buildAppliedResponse(
        'AGENTS.md saved.',
      ));
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
