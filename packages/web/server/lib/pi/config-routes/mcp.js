// MCP server CRUD, backed by Pi's own `<agentDir>/mcp.json` and
// `<directory>/.pi/mcp.json` (pi-contract 6.2), plus live connection status
// from `pi mcp list --json`, cached because it connects every enabled server.
//
// The UI's `useMcpConfigStore.ts` already builds an OpenCode v2-shaped body
// (`McpServerConfig` in that file): `command: string[]`, `environment`,
// snake_case `oauth`, and a three-phase `timeout`. Pi's shape differs in
// exactly the fields OpenCode v2 added or renamed, so every write translates
// between the two; `toPiServerEntry`/`fromPiServerEntry` are the pure,
// tested halves of that translation. Unknown keys in the file (anything this
// module does not model) survive a write: `update` merges onto the raw JSON
// object already on disk instead of replacing it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRecord } from '../../shared/guards.js';
import { buildAppliedResponse } from '../../opencode/config-mutation-response.js';
import { agentPaths, projectPaths, readJsonObject } from '../bridge/routes/pi-files.js';
import { createPiCliRunner } from '../packages-cli.js';
import { isSafeEntityName, projectIsTrusted } from './paths.js';
import { writeFileAtomic } from '../../opencode/atomic-write.js';

const SCOPE = { USER: 'user', PROJECT: 'project' };
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const STATUS_CACHE_TTL_MS = 30_000;
// Tools of a server the UI adds must reach the model directly, matching
// OpenCode's own always-declared MCP tools; Pi's default (`codemode`) hides
// them behind scripts (pi-contract 6.2/6.3). Only a server this store creates
// gets this forced; an edit that does not touch `exposure` leaves whatever is
// already on disk, including a value set by hand.
const DEFAULT_NEW_SERVER_EXPOSURE = 'direct';

const isObject = (value) => isRecord(value);

/** `string[]` (OpenCode v2 `command`, element 0 the executable) <-> Pi's `{command, args}`. */
const toPiCommand = (command) => {
  const list = Array.isArray(command) ? command.filter((entry) => typeof entry === 'string' && entry) : [];
  return { command: list[0], args: list.length > 1 ? list.slice(1) : undefined };
};
const fromPiCommand = (command, args) => [command, ...(Array.isArray(args) ? args : [])].filter(Boolean);

const OAUTH_TO_PI = { client_id: 'clientId', client_secret: 'clientSecret', scope: 'scope', callback_port: 'callbackPort', redirect_uri: 'callbackUrl', auth_server_metadata_url: 'authServerMetadataUrl' };
const OAUTH_FROM_PI = { clientId: 'client_id', clientSecret: 'client_secret', scope: 'scope', callbackPort: 'callback_port', callbackUrl: 'redirect_uri', authServerMetadataUrl: 'auth_server_metadata_url' };

/** OpenCode v2's snake_case OAuth config <-> Pi's camelCase one; `clientName`/`clientRegistration` are Pi-only and untouched by either direction. */
const toPiOAuth = (oauth, existingPiOAuth) => {
  if (oauth === false) return false;
  if (!isObject(oauth)) return undefined;
  const next = isObject(existingPiOAuth) ? { ...existingPiOAuth } : {};
  for (const [fromKey, toKey] of Object.entries(OAUTH_TO_PI)) {
    if (oauth[fromKey] !== undefined) next[toKey] = oauth[fromKey];
  }
  return next;
};
const fromPiOAuth = (oauth) => {
  if (oauth === false) return false;
  if (!isObject(oauth)) return undefined;
  const next = {};
  for (const [fromKey, toKey] of Object.entries(OAUTH_FROM_PI)) {
    if (oauth[fromKey] !== undefined) next[toKey] = oauth[fromKey];
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

/**
 * OpenCode v2's three-phase millisecond `timeout` <-> Pi's single second
 * count. Pi has no `startup`/`catalog` split, so only `execution` (the one
 * closest to "how long may a call run") round-trips; the others are accepted
 * on write and dropped, matching the UI's own note that `startup` is
 * meaningless for a server OpenChamber does not spawn differently here.
 */
const toPiTimeoutSeconds = (timeout) => {
  if (timeout === null) return null;
  if (!isObject(timeout)) return undefined;
  const ms = typeof timeout.execution === 'number' ? timeout.execution : (typeof timeout.catalog === 'number' ? timeout.catalog : undefined);
  return typeof ms === 'number' && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : undefined;
};
const fromPiTimeoutSeconds = (seconds) => (typeof seconds === 'number' && seconds > 0 ? { execution: seconds * 1000 } : undefined);

/**
 * The UI's `buildMcpBody()` output -> a Pi `mcpServers.<name>` entry, merged
 * onto whatever was already there so unknown keys survive. `forceExposure`
 * is set only for a brand-new entry.
 */
export const toPiServerEntry = (body, existing, { forceExposure } = {}) => {
  const next = isObject(existing) ? { ...existing } : {};
  // The UI's own `buildMcpBody()` always includes `type` (the form's type
  // radio is a required field), but this store's `update()` is a partial
  // merge like every other entity here, so a caller that omits `type` still
  // gets its `url`/`command` edit applied against whatever type is already
  // on disk, instead of the whole write silently doing nothing.
  const effectiveType = body.type ?? (isObject(existing) ? (existing.type === 'http' || typeof existing.url === 'string' ? 'remote' : 'local') : undefined);
  if (effectiveType === 'local') {
    next.type = 'stdio';
    delete next.url; delete next.headers; delete next.oauth;
    const { command, args } = toPiCommand(body.command ?? fromPiCommand(next.command, next.args));
    if (command) next.command = command;
    if (args !== undefined && args.length > 0) next.args = args; else delete next.args;
    if (body.environment !== undefined) {
      const env = Object.keys(body.environment ?? {}).length > 0 ? body.environment : undefined;
      if (env) next.env = env; else delete next.env;
    }
  } else if (effectiveType === 'remote') {
    next.type = 'http';
    delete next.command; delete next.args; delete next.env; delete next.cwd;
    if (typeof body.url === 'string') next.url = body.url;
    if (body.headers !== undefined) {
      const headers = Object.keys(body.headers ?? {}).length > 0 ? body.headers : undefined;
      if (headers) next.headers = headers; else delete next.headers;
    }
    if (body.oauth !== undefined) {
      const oauth = toPiOAuth(body.oauth, next.oauth);
      if (oauth === undefined) delete next.oauth; else next.oauth = oauth;
    }
  }
  if (body.disabled !== undefined) next.enabled = !body.disabled;
  if (body.timeout !== undefined) {
    const seconds = toPiTimeoutSeconds(body.timeout);
    if (seconds === null || seconds === undefined) delete next.timeout; else next.timeout = seconds;
  }
  if (forceExposure) next.exposure = DEFAULT_NEW_SERVER_EXPOSURE;
  // `codemode` (OpenCode v2's per-server boolean) has no Pi equivalent: Pi's
  // `exposure` is a four-way choice, not a toggle, and the UI offers no
  // exposure control of its own. Left unset rather than guessed.
  return next;
};

/** A Pi `mcpServers.<name>` entry -> the shape `McpServerWithScope` expects. */
export const fromPiServerEntry = (name, entry, { scope, path: filePath, legacy = false } = {}) => {
  const isRemote = entry.type === 'http' || typeof entry.url === 'string';
  const base = {
    name,
    disabled: entry.enabled === false,
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    ...(fromPiTimeoutSeconds(entry.timeout) ? { timeout: fromPiTimeoutSeconds(entry.timeout) } : {}),
    scope, path: filePath, legacy,
  };
  if (isRemote) {
    return { ...base, type: 'remote', url: entry.url ?? '', ...(entry.headers ? { headers: entry.headers } : {}), ...(fromPiOAuth(entry.oauth) !== undefined ? { oauth: fromPiOAuth(entry.oauth) } : {}) };
  }
  return { ...base, type: 'local', command: fromPiCommand(entry.command, entry.args), ...(entry.env ? { environment: entry.env } : {}) };
};

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir
 * @param {(directory: string) => boolean | Promise<boolean>} [options.isProjectTrusted]
 * @param {(flags: {directory: string|null}) => void} [options.onChanged]  Invalidates the status cache.
 */
export const createMcpStore = ({ getAgentDir, isProjectTrusted = async () => true, onChanged = () => {} }) => {
  const readFile = async (filePath) => (await readJsonObject(filePath)).value ?? {};

  /** `{ path, scope, config, raw }` for the file that defines `name` for `directory`, project first. */
  const locate = async (name, directory) => {
    if (directory && await projectIsTrusted(isProjectTrusted, directory)) {
      const projectFile = projectPaths(directory).mcp;
      const projectConfig = await readFile(projectFile);
      if (isObject(projectConfig.mcpServers?.[name])) return { path: projectFile, scope: SCOPE.PROJECT, config: projectConfig, raw: projectConfig.mcpServers[name] };
    }
    const globalFile = agentPaths(getAgentDir()).mcp;
    const globalConfig = await readFile(globalFile);
    if (isObject(globalConfig.mcpServers?.[name])) return { path: globalFile, scope: SCOPE.USER, config: globalConfig, raw: globalConfig.mcpServers[name] };
    return null;
  };

  const list = async (directory) => {
    const names = new Map();
    const globalFile = agentPaths(getAgentDir()).mcp;
    const globalConfig = await readFile(globalFile);
    for (const [name, entry] of Object.entries(isObject(globalConfig.mcpServers) ? globalConfig.mcpServers : {})) {
      if (isObject(entry)) names.set(name, { path: globalFile, scope: SCOPE.USER, entry });
    }
    if (directory && await projectIsTrusted(isProjectTrusted, directory)) {
      const projectFile = projectPaths(directory).mcp;
      const projectConfig = await readFile(projectFile);
      for (const [name, entry] of Object.entries(isObject(projectConfig.mcpServers) ? projectConfig.mcpServers : {})) {
        if (isObject(entry)) names.set(name, { path: projectFile, scope: SCOPE.PROJECT, entry });
      }
    }
    return [...names.entries()].map(([name, { path: filePath, scope, entry }]) => fromPiServerEntry(name, entry, { scope, path: filePath }));
  };

  const get = async (name, directory) => {
    const found = await locate(name, directory);
    return found ? fromPiServerEntry(name, found.raw, { scope: found.scope, path: found.path }) : null;
  };

  const writeEntry = async (filePath, mutate) => {
    // Unlike `readFile` (used for listing, where a corrupt file is logged
    // and treated as absent, matching the bridge's own catalog reads), a
    // write never treats "cannot parse" as "empty": that would silently
    // drop everything else in the file the moment one server is edited.
    const { value, error } = await readJsonObject(filePath);
    if (error) throw new Error(`${filePath} cannot be read (${error}). Fix the file first: OpenChamber does not overwrite config it cannot parse`);
    const config = isObject(value) ? value : {};
    const next = { ...config, mcpServers: { ...(isObject(config.mcpServers) ? config.mcpServers : {}) } };
    mutate(next.mcpServers);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  };

  const create = async (name, body, directory, scope) => {
    if (!SERVER_NAME.test(name)) throw new Error('MCP server names may only use letters, digits, "_" and "-"');
    if (await locate(name, directory)) throw new Error(`MCP server "${name}" already exists`);
    const wantsProject = scope === SCOPE.PROJECT;
    if (wantsProject && !directory) throw new Error('Project scope requires a directory');
    if (wantsProject && !await projectIsTrusted(isProjectTrusted, directory)) {
      throw new Error(`"${directory}" is not a trusted project, so an MCP server written there would be ignored`);
    }
    const filePath = wantsProject ? projectPaths(directory).mcp : agentPaths(getAgentDir()).mcp;
    const entry = toPiServerEntry(body ?? {}, null, { forceExposure: true });
    await writeEntry(filePath, (servers) => { servers[name] = entry; });
    onChanged({ directory: wantsProject ? directory : null });
    return { path: filePath };
  };

  const update = async (name, body, directory) => {
    const found = await locate(name, directory);
    if (!found) throw new Error(`MCP server "${name}" not found`);
    const entry = toPiServerEntry(body ?? {}, found.raw, {});
    await writeEntry(found.path, (servers) => { servers[name] = entry; });
    onChanged({ directory: found.scope === SCOPE.PROJECT ? directory : null });
    return { path: found.path };
  };

  const remove = async (name, directory) => {
    const found = await locate(name, directory);
    if (!found) throw new Error(`MCP server "${name}" not found`);
    await writeEntry(found.path, (servers) => { delete servers[name]; });
    onChanged({ directory: found.scope === SCOPE.PROJECT ? directory : null });
  };

  /** Enable or disable without touching anything else, for the connect/disconnect routes. */
  const setEnabled = async (name, enabled, directory) => {
    const found = await locate(name, directory);
    if (!found) throw new Error(`MCP server "${name}" not found`);
    await writeEntry(found.path, (servers) => { servers[name] = { ...servers[name], enabled }; });
    onChanged({ directory: found.scope === SCOPE.PROJECT ? directory : null });
  };

  return { list, get, create, update, remove, setEnabled };
};

const STATUS_BY_PI_STATE = { connected: 'connected', disabled: 'disabled', failed: 'failed', 'needs-auth': 'needs_auth' };

/** One `pi mcp list --json` report entry -> the wire's `McpServer.status`. */
const toWireStatus = (report) => {
  const status = STATUS_BY_PI_STATE[report.state] ?? 'failed';
  return status === 'failed' || status === 'needs_auth' ? { status, error: report.error ?? 'Unknown error' } : { status };
};

/**
 * Caches `pi mcp list --json` (it connects every enabled server) for 30 s per
 * directory, and invalidates on any edit through `createMcpStore`'s
 * `onChanged`. `emitEvent` fires `mcp.status.changed` for a server whose
 * status actually moved since the last read, matching wire spec 4.3.
 *
 * @param {object} options
 * @param {ReturnType<typeof createPiCliRunner>} [options.runPi]
 * @param {() => Record<string,string|undefined>} options.getBaseEnv
 * @param {(event: {type: string, data: object, location?: {directory: string}}) => void} [options.emitEvent]
 */
export const createMcpStatusCache = ({ runPi = createPiCliRunner(), getBaseEnv = () => process.env, ttlMs = STATUS_CACHE_TTL_MS, emitEvent = () => {} } = {}) => {
  const entries = new Map();

  const runList = async (directory) => {
    const result = await runPi(['mcp', 'list', '--json'], { cwd: directory || os.homedir(), env: getBaseEnv(), timeoutMs: 60_000 });
    try {
      const parsed = JSON.parse(result.stdout);
      return new Map((parsed.servers ?? []).map((report) => [report.name, toWireStatus(report)]));
    } catch {
      return new Map();
    }
  };

  const get = async (directory, { force = false } = {}) => {
    const key = directory || '';
    const cached = entries.get(key);
    if (!force && cached && Date.now() - cached.at < ttlMs) return cached.statuses;
    const statuses = await runList(directory);
    if (cached) {
      for (const [name, status] of statuses) {
        if (JSON.stringify(cached.statuses.get(name)) !== JSON.stringify(status)) {
          emitEvent({ type: 'mcp.status.changed', data: { server: name }, ...(directory ? { location: { directory } } : {}) });
        }
      }
    }
    entries.set(key, { statuses, at: Date.now() });
    return statuses;
  };

  const invalidate = (directory) => entries.delete(directory || '');

  return { get, invalidate };
};

/**
 * `GET /api/mcp`'s status overlay for `bridge/routes/catalog.js`'s
 * `agentStore`-style plug point: `(directory) => Promise<Map<string,{status}>>`.
 */
export const createMcpStatusProvider = (cache) => (directory) => cache.get(directory).catch(() => new Map());

/** @param {import('express').Express} app */
export const registerMcpConfigRoutes = (app, { store, statusCache, resolveOptionalProjectDirectory, agentDir, runPi = createPiCliRunner() }) => {
  app.use('/api/config/mcp/:name', (req, res, next) => (
    isSafeEntityName(req.params.name) ? next() : res.status(400).json({ error: 'Invalid name' })
  ));

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      res.json(await store.list(directory));
    } catch (error) {
      console.error('[config/mcp] list failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list MCP configs' });
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const config = await store.get(req.params.name, directory);
      if (!config) return res.status(404).json({ error: `MCP server "${req.params.name}" not found` });
      res.json(config);
    } catch (error) {
      console.error('[config/mcp] get failed:', error);
      res.status(500).json({ error: error.message || 'Failed to get MCP config' });
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const { scope, ...body } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const result = await store.create(req.params.name, body, directory, scope);
      res.json(buildAppliedResponse(`MCP server "${req.params.name}" created.`, result));
    } catch (error) {
      console.error('[config/mcp] create failed:', error);
      res.status(500).json({ error: error.message || 'Failed to create MCP server' });
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const result = await store.update(req.params.name, req.body, directory);
      res.json(buildAppliedResponse(`MCP server "${req.params.name}" updated.`, result));
    } catch (error) {
      console.error('[config/mcp] update failed:', error);
      const status = error?.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: error.message || 'Failed to update MCP server' });
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      await store.remove(req.params.name, directory);
      res.json(buildAppliedResponse(`MCP server "${req.params.name}" deleted.`));
    } catch (error) {
      console.error('[config/mcp] delete failed:', error);
      const status = error?.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: error.message || 'Failed to delete MCP server' });
    }
  });

  const setEnabledAndRefresh = async (req, res, enabled) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      await store.setEnabled(req.params.name, enabled, directory);
      if (statusCache) { statusCache.invalidate(directory); await statusCache.get(directory, { force: true }).catch(() => {}); }
      res.status(204).end();
    } catch (error) {
      console.error(`[config/mcp] ${enabled ? 'connect' : 'disconnect'} failed:`, error);
      const status = error?.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  };
  app.post('/api/experimental/mcp/:name/connect', (req, res) => setEnabledAndRefresh(req, res, true));
  app.post('/api/experimental/mcp/:name/disconnect', (req, res) => setEnabledAndRefresh(req, res, false));

  /**
   * Same-machine OAuth sign-in: runs `pi mcp login <name>`, which opens the
   * browser and blocks until Pi's own loopback listener receives the
   * redirect or the timeout elapses. A browser that cannot reach this
   * machine (a phone over the relay, Pi on another machine) is not handled
   * here; see CONFIG-NOTES.md ("MCP OAuth: what `pi mcp login` does not
   * cover").
   */
  app.post('/api/config/mcp/:name/login', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const result = await runPi(['mcp', 'login', req.params.name], { cwd: directory || agentDir(), timeoutMs: 305_000 });
      if (statusCache) { statusCache.invalidate(directory); void statusCache.get(directory, { force: true }).catch(() => {}); }
      const authorizationUrl = /in your browser:\s*(\S+)/.exec(result.stdout)?.[1] ?? null;
      if (result.code === 0) return res.json({ success: true, message: result.stdout.trim().split('\n').pop() ?? 'Signed in.' });
      res.status(502).json({ error: (result.stderr || result.stdout || 'Sign-in failed').trim(), authorizationUrl });
    } catch (error) {
      console.error('[config/mcp] login failed:', error);
      res.status(500).json({ error: error.message || 'Failed to start MCP sign-in' });
    }
  });
};
