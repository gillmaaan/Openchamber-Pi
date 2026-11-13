// The routes the Settings Plugins page calls, backed by Pi packages.
//
// The URLs and the shape of every entry and file are the ones the page already
// reads (`/api/config/plugins/...`, see `packages/ui/src/stores/usePluginsStore.ts`).
// What an OpenCode plugin entry was, a Pi package now is; what a plugin file
// was, an extension file now is. PLUGINS-NOTES.md says how each field is filled
// where OpenCode had something Pi does not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { managedToolFlags } from '../managed-runtime.js';
import { describeManagedExtensions } from '../packages.js';
import { RESOURCE_KEYS } from '../packages-settings.js';
import { codedError, isExactVersion, parseConfiguredSource, resolveLocalSource } from '../packages-sources.js';

const STATUS_BY_CODE = {
  INVALID_SCOPE: 400,
  INVALID_SPEC: 400,
  UNLOADABLE_SPEC: 400,
  INVALID_FILENAME: 400,
  INVALID_DIRECTORY: 400,
  INVALID_STATE: 400,
  INVALID_OPTIONS: 400,
  IDENTITY_CHANGED: 400,
  PROJECT_NOT_TRUSTED: 403,
  NOT_FOUND: 404,
  ENTRY_EXISTS: 409,
  FILE_EXISTS: 409,
  SETTINGS_INVALID: 409,
  PACKAGE_DISABLED: 409,
  NOT_SWITCHABLE: 409,
  SETTINGS_LOCKED: 503,
  PI_UNAVAILABLE: 503,
  REGISTRY_UNAVAILABLE: 502,
  INSTALL_FAILED: 502,
  REMOVE_FAILED: 502,
  UPDATE_FAILED: 502,
  INSTALL_NOT_RECORDED: 502,
  CONTRIBUTIONS_UNAVAILABLE: 502,
  PI_TIMEOUT: 504,
};

const MAX_REGISTRY_SPECS = 100;

const appliedResponse = (message, details) => ({ success: true, message, ...details });

const PARSED_KIND = { npm: 'npm', git: 'git', local: 'path', unknown: 'path' };

/** The `plugin:` resource name the page keys its switch on. Pi has no policy engine behind it. */
const policyResourceOf = (pkg) => {
  if (pkg.kind === 'npm') return `plugin:${pkg.name}`;
  if (pkg.kind === 'local') return `plugin:${pkg.resolvedPath ?? pkg.installedPath ?? pkg.source}`;
  return `plugin:${pkg.source}`;
};

const switchStateOf = (item) => {
  if (item.notLoadedReason === 'project-not-trusted' || item.switchable === false) return 'unavailable';
  return item.enabled ? 'on' : 'off';
};

/** A configured package, in the shape of the page's `PluginEntry`. */
const toEntry = (pkg) => ({
  id: pkg.id,
  spec: pkg.source,
  ...(pkg.filters ? { options: pkg.filters } : {}),
  scope: pkg.scope,
  kind: 'config',
  parsedKind: PARSED_KIND[pkg.kind],
  sourcePath: pkg.settingsPath,
  policyResource: policyResourceOf(pkg),
  switchState: switchStateOf(pkg),
  ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
  // Beyond the page's type: what Pi knows about the package.
  name: pkg.name,
  version: pkg.version,
  installed: pkg.installed,
  installedPath: pkg.installedPath,
  enabled: pkg.enabled,
  switchable: pkg.switchable,
  loaded: pkg.loaded,
  notLoadedReason: pkg.notLoadedReason,
});

/** An extension file or folder, in the shape of the page's `PluginFile`. */
const toFile = (item) => ({
  id: item.id,
  fileName: item.name,
  scope: item.scope,
  kind: item.kind === 'file' ? 'file' : 'package',
  absolutePath: item.absolutePath,
  resolvedPath: item.resolvedPath,
  policyResource: `plugin:${item.absolutePath}`,
  switchState: switchStateOf(item),
  enabled: item.enabled,
  loaded: item.loaded,
  notLoadedReason: item.notLoadedReason,
});

/** The options field of an entry is the package's resource filters. */
const filtersFromOptions = (options) => {
  if (options === undefined || options === null) return undefined;
  const invalid = () => codedError(
    `Package options are resource filters: ${RESOURCE_KEYS.join(', ')}, each a list of paths or patterns (for example { "skills": [] } loads no skills)`,
    'INVALID_OPTIONS',
  );
  if (typeof options !== 'object' || Array.isArray(options)) throw invalid();
  const filters = {};
  for (const [key, value] of Object.entries(options)) {
    if (!RESOURCE_KEYS.includes(key) || !Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw invalid();
    filters[key] = value;
  }
  return filters;
};

/**
 * @param {object} deps
 * @param {ReturnType<import('../packages.js').createPiPackages>} deps.packages
 * @param {(req: import('express').Request) => Promise<{ directory?: string|null, error?: string }>} deps.resolveOptionalProjectDirectory
 * @param {() => Promise<object|null>} [deps.readSettings]  OpenChamber's settings, for the managed tool switches.
 * @param {(change: { directory: string|null, scope: string, what: 'package'|'extension' }) => void} [deps.onChanged]
 *   Called after a change that reaches Pi: running processes keep what they loaded, the next one picks it up.
 * @param {Pick<Console, 'error'>} [deps.logger]
 * @param {import('express').Express} [deps.app]  When given, the routes are registered at once.
 */
export const createPluginConfigRoutes = ({
  packages,
  resolveOptionalProjectDirectory,
  readSettings = async () => null,
  onChanged = () => {},
  logger = console,
  app = null,
}) => {
  const resolveDirectory = async (req, res) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) {
      res.status(400).json({ error });
      return null;
    }
    return directory || null;
  };

  const fail = (res, error, fallback, context) => {
    const status = STATUS_BY_CODE[error?.code] ?? (error?.code === 'ENOENT' ? 404 : error?.code === 'EEXIST' ? 409 : null);
    if (status) {
      return res.status(status).json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    }
    logger.error(context, error);
    return res.status(500).json({ error: fallback });
  };

  const changed = (directory, scope, what) => {
    try {
      onChanged({ directory, scope, what });
    } catch (error) {
      logger.error('[API] A plugin change listener failed:', error);
    }
  };

  /** A handler that resolves the directory first and turns a failure into the page's error body. */
  const route = (fallback, context, handler) => async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (res.headersSent) return undefined;
      return await handler(req, res, directory);
    } catch (error) {
      return fail(res, error, fallback, context);
    }
  };

  const registryResults = async (specs, directory, forceRefresh) => {
    const { packages: configured } = await packages.list({ directory });
    const baseDirOf = (spec) => {
      const match = configured.find((entry) => entry.source === spec);
      return match ? path.dirname(match.settingsPath) : directory ?? os.homedir();
    };
    const results = [];
    const lookups = new Map();
    for (const spec of specs) {
      const parsed = parseConfiguredSource(spec);
      if (parsed.kind === 'npm' && !lookups.has(parsed.name)) lookups.set(parsed.name, packages.registryInfo(parsed.name, { forceRefresh }));
    }
    for (const spec of specs) {
      const parsed = parseConfiguredSource(spec);
      if (parsed.kind === 'unknown') {
        results.push({ kind: 'npm-malformed', spec, error: 'Spec syntax is malformed' });
      } else if (parsed.kind === 'git') {
        results.push({ kind: 'git-ok', spec });
      } else if (parsed.kind === 'local') {
        const absolutePath = resolveLocalSource(parsed.path, baseDirOf(spec));
        try {
          fs.statSync(absolutePath);
        } catch {
          results.push({ kind: 'path-missing', spec, absolutePath });
          continue;
        }
        try {
          fs.accessSync(absolutePath, fs.constants.R_OK);
          results.push({ kind: 'path-ok', spec, absolutePath });
        } catch {
          results.push({ kind: 'path-unreadable', spec, absolutePath });
        }
      } else {
        const info = await lookups.get(parsed.name);
        if (!info.ok) {
          results.push(info.status === 404
            ? { kind: 'npm-missing-package', spec, name: parsed.name, error: info.error }
            : { kind: 'npm-network', spec, error: info.status === 'network' ? info.error : `Registry returned ${info.status}` });
        } else if (isExactVersion(parsed.version) && !info.versions.includes(parsed.version)) {
          results.push({ kind: 'npm-missing-version', spec, name: parsed.name, currentVersion: parsed.version, latestVersion: info.latest, versions: info.versions });
        } else {
          results.push({
            kind: 'npm-ok',
            spec,
            name: parsed.name,
            currentVersion: parsed.version,
            latestVersion: info.latest,
            versions: info.versions,
            hasUpdate: isExactVersion(parsed.version) && parsed.version !== info.latest,
          });
        }
      }
    }
    return results;
  };

  const register = (target) => {
    target.get('/api/config/plugins', route('Failed to list plugins', '[API:GET /api/config/plugins] Failed:', async (_req, res, directory) => {
      const listing = await packages.list({ directory });
      res.json({
        entries: listing.packages.map(toEntry),
        files: listing.extensions.map(toFile),
        // Not Pi packages: what OpenChamber loads into every Pi process. Read-only; each tool is switched by its Settings flag.
        managed: describeManagedExtensions(managedToolFlags(await Promise.resolve(readSettings()).catch(() => null))),
        projectTrusted: listing.projectTrusted,
        settingsErrors: listing.settingsErrors,
      });
    }));

    target.get('/api/config/plugins/registry', route('Failed to query npm registry', '[API:GET /api/config/plugins/registry]', async (req, res, directory) => {
      const raw = (req.query.specs || '').toString();
      const specs = Array.from(new Set(raw
        ? raw.split(',').map((spec) => {
          try {
            return decodeURIComponent(spec);
          } catch {
            return spec;
          }
        }).filter((spec) => spec.length > 0)
        : []));
      if (specs.length > MAX_REGISTRY_SPECS) return res.status(400).json({ error: 'too many specs' });
      return res.json({ results: await registryResults(specs, directory, req.query.refresh === 'true') });
    }));

    target.get('/api/config/plugins/search', route('Failed to search the npm registry', '[API:GET /api/config/plugins/search]', async (req, res, directory) => {
      const result = await packages.searchRegistry({ query: (req.query.q || '').toString(), from: req.query.from, size: req.query.size });
      // Which results are already configured, by scope, so the page can show "Installed".
      const configured = await packages.list({ directory }).then((listing) => listing.packages, () => []);
      res.json({
        total: result.total,
        results: result.results.map((item) => ({
          ...item,
          installed: configured
            .filter((entry) => entry.kind === 'npm' && entry.name === item.name)
            .map((entry) => ({ id: entry.id, scope: entry.scope, enabled: entry.enabled })),
        })),
      });
    }));

    target.get('/api/config/plugins/entry/:id/contributions', route('Failed to read what the package contributes', '[API:GET /api/config/plugins/entry/:id/contributions] Failed:', async (req, res, directory) => {
      res.json(await packages.contributions({ id: req.params.id, directory }));
    }));

    target.get('/api/config/plugins/entry/:id', route('Failed to get plugin entry', '[API:GET /api/config/plugins/entry/:id] Failed:', async (req, res, directory) => {
      const entry = (await packages.list({ directory })).packages.find((candidate) => candidate.id === req.params.id);
      if (!entry) return res.status(404).json({ error: 'Plugin entry not found' });
      return res.json(toEntry(entry));
    }));

    target.post('/api/config/plugins/entry', route('Failed to create plugin entry', '[API:POST /api/config/plugins/entry] Failed:', async (req, res, directory) => {
      const filters = filtersFromOptions(req.body?.options);
      const entry = await packages.add({ source: req.body?.spec, scope: req.body?.scope || 'user', directory, filters });
      changed(directory, entry.scope, 'package');
      res.json(appliedResponse('Package installed. Running sessions pick it up when they restart.', { path: entry.settingsPath, scope: entry.scope, id: entry.id }));
    }));

    target.patch('/api/config/plugins/entry/:id', route('Failed to update plugin entry', '[API:PATCH /api/config/plugins/entry/:id] Failed:', async (req, res, directory) => {
      const entry = await packages.updateEntry({
        id: req.params.id,
        spec: req.body?.spec,
        filters: filtersFromOptions(req.body?.options),
        directory,
      });
      changed(directory, entry.scope, 'package');
      res.json(appliedResponse('Package updated.', { path: entry.settingsPath, scope: entry.scope, id: entry.id }));
    }));

    target.delete('/api/config/plugins/entry/:id', route('Failed to delete plugin entry', '[API:DELETE /api/config/plugins/entry/:id] Failed:', async (req, res, directory) => {
      const removed = await packages.remove({ id: req.params.id, directory });
      changed(directory, removed.scope, 'package');
      res.json(appliedResponse('Package removed.', { path: removed.settingsPath, scope: removed.scope }));
    }));

    target.put('/api/config/plugins/entry/:id/enabled', route('Failed to change plugin state', '[API:PUT /api/config/plugins/entry/:id/enabled] Failed:', async (req, res, directory) => {
      const enabled = req.body?.enabled;
      if (enabled !== true && enabled !== false) return res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_STATE' });
      const result = await packages.setEnabled({ id: req.params.id, enabled, directory });
      changed(directory, result.scope, 'package');
      return res.json({ ...appliedResponse(`Plugin ${enabled ? 'enabled' : 'disabled'}.`), enabled });
    }));

    target.put('/api/config/plugins/file/:id/enabled', route('Failed to change plugin state', '[API:PUT /api/config/plugins/file/:id/enabled] Failed:', async (req, res, directory) => {
      const enabled = req.body?.enabled;
      if (enabled !== true && enabled !== false) return res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_STATE' });
      const result = await packages.setExtensionEnabled({ id: req.params.id, enabled, directory });
      changed(directory, result.scope, 'extension');
      return res.json({ ...appliedResponse(`Plugin ${enabled ? 'enabled' : 'disabled'}.`), enabled });
    }));

    target.get('/api/config/plugins/file/:id', route('Failed to read plugin file', '[API:GET /api/config/plugins/file/:id] Failed:', async (req, res, directory) => {
      res.json(await packages.readExtensionFile({ id: req.params.id, directory }));
    }));

    target.post('/api/config/plugins/file', route('Failed to create plugin file', '[API:POST /api/config/plugins/file] Failed:', async (req, res, directory) => {
      const file = await packages.createExtensionFile({ fileName: req.body?.fileName, content: req.body?.content, scope: req.body?.scope || 'user', directory });
      changed(directory, file.scope, 'extension');
      res.json(appliedResponse('Extension file created. Running sessions pick it up when they restart.', { path: file.absolutePath, scope: file.scope, id: file.id }));
    }));

    target.put('/api/config/plugins/file/:id', route('Failed to update plugin file', '[API:PUT /api/config/plugins/file/:id] Failed:', async (req, res, directory) => {
      const file = await packages.updateExtensionFile({ id: req.params.id, content: req.body?.content, directory });
      changed(directory, file.scope, 'extension');
      res.json(appliedResponse('Extension file updated.', { path: file.absolutePath, scope: file.scope }));
    }));

    target.delete('/api/config/plugins/file/:id', route('Failed to delete plugin file', '[API:DELETE /api/config/plugins/file/:id] Failed:', async (req, res, directory) => {
      const file = await packages.deleteExtensionFile({ id: req.params.id, directory });
      changed(directory, file.scope, 'extension');
      res.json(appliedResponse('Extension file deleted.', { scope: file.scope, ...(file.warning ? { warning: file.warning } : {}) }));
    }));
  };

  if (app) register(app);
  return { register };
};
