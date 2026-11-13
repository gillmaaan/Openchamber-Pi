// The read-only catalog routes of the OpenCode 2.2.6 dialect, answered from Pi:
// server and location facts, models, providers, agents, commands, skills, MCP
// servers, integrations, plugins, config and credentials. Envelopes follow the
// wire spec (1.3): `{ location, data }` for what is scoped to a folder, a bare
// body for info, location, project, config and config/shell, `{ data }` for the
// global lists (saved permissions, credentials).
//
// What each route is made of, and what is a gap, is in NOTES.md.
//
// `deps`:
// - `catalog`: `createPiCatalog(...)` (`providers()`, `models({availableOnly, types})`, `configError()`).
// - `getDefaultDirectory()`: the folder a request without a directory answers for.
// - `getAgentDir()`: Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
// - `listKnownDirectories()`: the folders the bridge's sessions ran in, as
//   `string[]` or `{ directory, time?: { created, updated, active } }[]`.
// - `getServerInfo()`: `{ pid, hostname?, urls: string[], tmp }`.
// - `agentStore?`: `{ list(directory) => AgentInfo[] | Promise<AgentInfo[]> }`, the
//   OpenChamber-owned agent profiles merged over the built-in ones. Without it
//   only the built-ins are served. A profile with the id of a built-in replaces it.
// - `getMcpStatus?`: `(directory) => Promise<Map<string, {status, error?}>>`, live connection
//   state from `pi mcp list --json` (config-routes/mcp.js's `createMcpStatusProvider`,
//   cached there). Without it every enabled server is `pending` and every disabled one
//   `disabled`, as before; a name the status map does not carry keeps that static answer.
// - `runGit?`: `(args, { cwd }) => Promise<string>`, git for `vcs`; default `execFile git`, 3 s.
// - `isProjectTrusted?`: `(directory) => boolean | Promise<boolean>`. Pi gates `.pi/*` and
//   `.agents/skills` of a project on trust and the bridge does not decide it. When this
//   answers false, project settings, prompts, skills and MCP config are not read.
//   Default: every project is readable.
// - `getHomeDir?`: the home folder (`~/.agents/skills`, `~` in settings); default `os.homedir()`.
// - `getPlanDirectory?`: where the plan agent may write; default `<agentDir>/plans`.
// - `loadSdk?`: `() => import('@earendil-works/pi-coding-agent')`.
// - `log?`: `(message) => void` for problems that are not the request's fault (a corrupt
//   file, a skipped entry); default `console.warn`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentNotFound, invalidRequest, serviceUnavailable } from '../errors.js';
import { json } from '../http.js';
import { resolveLocation } from '../location.js';
import { buildConfigEntries } from './config-documents.js';
import { createBuiltinAgents } from './builtin-agents.js';
import { createGitInfo, runGitCommand } from './git-info.js';
import { mergePlugins, toCredentialEntries, toIntegrationInfo, toPluginInfos } from './integrations.js';
import { invalidServerNames, mergeMcpServers, serversOf, toMcpServers } from './mcp-servers.js';
import { apiKeyMarker, pickDefaultModel, toModelInfo, toProviderInfo } from './model-info.js';
import { agentPaths, createReporter, projectPaths, readJsonObject } from './pi-files.js';
import { createResourceScanner } from './pi-resources.js';
import { buildProjectList } from './project-list.js';

/** The OpenCode version this bridge speaks. The web server's compatibility gate wants 2.x, at least 2.2.4. */
export const WIRE_VERSION = '2.2.6';

const SERVED_MODEL_TYPES = new Set(['chat', 'image']);

const BUILTIN_COMMANDS = [
  { name: 'init', description: 'guided AGENTS.md setup' },
  { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
  { name: 'goal', description: 'keep working until an objective is met [pause|resume|clear]' },
];

/** Shells OpenCode marks as not usable for the agent's shell tool (not POSIX compatible). */
const UNACCEPTABLE_SHELLS = new Set(['fish', 'nu', 'nushell']);

/** The version of the installed Pi, read from its package.json (the package does not export it). */
export const readPiVersion = () => {
  try {
    let current = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
    for (; ; current = path.dirname(current)) {
      const candidate = path.join(current, 'package.json');
      if (fs.existsSync(candidate)) {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (manifest.name === '@earendil-works/pi-coding-agent') return String(manifest.version);
      }
      if (path.dirname(current) === current) return null;
    }
  } catch {
    return null;
  }
};

const listShells = () => {
  let paths = [];
  try {
    paths = fs.readFileSync('/etc/shells', 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/'));
  } catch {
    if (process.env.SHELL) paths = [process.env.SHELL];
  }
  return [...new Set(paths)]
    .filter((shell) => fs.existsSync(shell))
    .map((shell) => {
      const name = path.basename(shell);
      return { path: shell, name, acceptable: !UNACCEPTABLE_SHELLS.has(name) };
    });
};

const normalizeAgent = (agent) => ({
  ...agent,
  name: agent.name ?? agent.id,
  mode: agent.mode ?? 'primary',
  hidden: agent.hidden ?? false,
  request: agent.request ?? { settings: {}, headers: {}, body: {} },
  permissions: agent.permissions ?? [],
});

/** @param {object} deps  See the header. */
export const createCatalogRoutes = (deps) => {
  const {
    catalog,
    getDefaultDirectory,
    getAgentDir,
    listKnownDirectories,
    getServerInfo,
    agentStore,
    getMcpStatus,
    isProjectTrusted = () => true,
    getHomeDir = () => os.homedir(),
    getPlanDirectory = () => path.join(getAgentDir(), 'plans'),
    loadSdk = () => import('@earendil-works/pi-coding-agent'),
    log = (message) => console.warn(`[pi-bridge] ${message}`),
  } = deps;

  const report = createReporter(log);
  const git = createGitInfo({
    runGit: deps.runGit ?? runGitCommand,
    report: (message) => report(`git:${message}`, message),
  });
  const resources = createResourceScanner({ loadSdk, getHomeDir, report });
  let piVersion;
  let piVersionRead = false;

  /**
   * Resolves the request's folder (404 when it is gone). `readsProject()` says
   * whether the folder's own `.pi` and `.agents` may be read; it is asked only
   * by the routes that read them, and at most once per request.
   */
  const locate = (ctx) => {
    const location = resolveLocation(ctx, { getDefaultDirectory });
    let trusted = null;
    return { ...location, readsProject: () => (trusted ??= Promise.resolve(isProjectTrusted(location.directory))) };
  };

  const located = (read) => async (ctx) => {
    const location = locate(ctx);
    return json({ location: { directory: location.directory }, data: await read(location, ctx) });
  };

  /** A JSON file read for a route: a problem is logged (once) and the file counts as absent. */
  const readJson = async (file) => {
    const { value, error } = await readJsonObject(file);
    report(`file:${file}`, error);
    return value;
  };

  const readSettings = async (location) => {
    const global = await readJson(agentPaths(getAgentDir()).settings);
    const project = await location.readsProject() ? await readJson(projectPaths(location.directory).settings) : null;
    return { global, project, merged: { ...global, ...project } };
  };

  /** Pi's catalog calls: a failure to read Pi's models or credentials is a 503, never an empty list. */
  const fromPi = async (read) => {
    try {
      const value = await read();
      report('models.json', await catalog.configError());
      return value;
    } catch (error) {
      throw serviceUnavailable(`Pi's model catalog is unavailable: ${error?.message ?? error}`, 'pi');
    }
  };

  const availableModels = (types) => fromPi(() => catalog.models({ availableOnly: true, ...(types ? { types } : {}) }));

  const modelsJsonProviders = async () => {
    const modelsJson = await readJson(agentPaths(getAgentDir()).models);
    return modelsJson && modelsJson.providers !== null && typeof modelsJson.providers === 'object' ? modelsJson.providers : {};
  };

  const agentsOf = async (directory) => {
    const agents = new Map(createBuiltinAgents({ planDirectory: getPlanDirectory() }).map((agent) => [agent.id, agent]));
    if (agentStore) {
      let profiles;
      try {
        profiles = await agentStore.list(directory);
      } catch (error) {
        throw serviceUnavailable(`The agent profiles are unavailable: ${error?.message ?? error}`, 'agents');
      }
      for (const profile of profiles) {
        if (typeof profile?.id !== 'string' || profile.id === '') continue;
        if (profile.disabled) agents.delete(profile.id);
        else agents.set(profile.id, normalizeAgent(profile));
      }
    }
    return [...agents.values()];
  };

  const mcpServersOf = async (location) => {
    const globalServers = serversOf(await readJson(agentPaths(getAgentDir()).mcp));
    const projectServers = await location.readsProject() ? serversOf(await readJson(projectPaths(location.directory).mcp)) : {};
    const merged = mergeMcpServers(globalServers, projectServers, (message) => report(`mcp:${message}`, message));
    for (const name of invalidServerNames(merged)) {
      const message = `MCP server "${name}" is skipped: Pi accepts letters, digits, "_" and "-" in a server name`;
      report(`mcp:${name}`, message);
    }
    const servers = toMcpServers(merged);
    if (!getMcpStatus) return servers;
    // A disabled server's status is never live (nothing connects to it);
    // every other one gets the real state when the status read succeeds.
    const live = await getMcpStatus(location.directory).catch(() => null);
    if (!live) return servers;
    return servers.map((server) => (server.status.status === 'disabled' ? server : { ...server, status: live.get(server.name) ?? server.status }));
  };

  const pluginsOf = async (location) => {
    const { global, project } = await readSettings(location);
    const homeDir = getHomeDir();
    return mergePlugins([
      ...(project ? [toPluginInfos(project, { baseDir: projectPaths(location.directory).config, homeDir })] : []),
      toPluginInfos(global, { baseDir: getAgentDir(), homeDir }),
    ]);
  };

  const readCredentials = async () => {
    const { value, error } = await readJsonObject(agentPaths(getAgentDir()).auth);
    // An unreadable auth.json is not "no keys": the caller (the quota readers and
    // voice keys) must see a failure, as it does when OpenCode cannot be asked.
    if (error) throw serviceUnavailable(error, 'pi');
    const { entries, skipped } = toCredentialEntries(value ?? {});
    if (skipped.length > 0) {
      const message = `auth.json entries not listed (a !command key, or not a key or login): ${skipped.join(', ')}`;
      report('auth.json', message);
    } else {
      report('auth.json', null);
    }
    return entries;
  };

  return [
    {
      method: 'GET',
      path: '/api/info',
      handler: () => {
        const info = getServerInfo();
        if (!piVersionRead) {
          piVersion = readPiVersion();
          piVersionRead = true;
        }
        return json({
          version: WIRE_VERSION,
          pid: info.pid,
          ...(info.hostname ? { hostname: info.hostname } : {}),
          urls: info.urls,
          paths: { tmp: info.tmp },
          capabilities: { persistentPty: false },
          // Not part of the OpenCode wire: which agent answers behind it.
          agent: { name: 'pi', version: piVersion },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/location',
      handler: (ctx) => {
        const { directory, project } = locate(ctx);
        return json({ directory, project: { id: project.id, directory: project.root, canonical: project.checkout ?? project.root } });
      },
    },
    { method: 'GET', path: '/api/project', handler: () => json(buildProjectList(listKnownDirectories())) },
    {
      method: 'GET',
      path: '/api/vcs',
      handler: located(({ directory, project }) => git.info(directory, project.vcs === 'git')),
    },
    {
      method: 'GET',
      path: '/api/vcs/branch',
      handler: located(({ directory, project }, ctx) => {
        const limitText = ctx.query.get('limit');
        let limit = null;
        if (limitText !== null) {
          limit = Number(limitText);
          if (!Number.isInteger(limit) || limit < 1) throw invalidRequest('limit must be a positive integer', { kind: 'Query', field: 'limit' });
        }
        return git.branches(directory, project.vcs === 'git', { search: ctx.query.get('search'), limit });
      }),
    },
    {
      method: 'GET',
      path: '/api/config',
      handler: async (ctx) => {
        const location = locate(ctx);
        const readsProject = await location.readsProject();
        const agentDir = getAgentDir();
        const global = agentPaths(agentDir);
        const project = projectPaths(location.directory);
        const read = async (file) => {
          const value = await readJson(file);
          return value ? { path: file, value } : null;
        };
        const projectConfigDir = readsProject && fs.existsSync(project.config) ? project.config : null;
        return json(buildConfigEntries({
          models: await read(global.models),
          settings: await read(global.settings),
          projectSettings: readsProject ? await read(project.settings) : null,
          agentDir,
          projectConfigDir,
        }));
      },
    },
    { method: 'GET', path: '/api/config/shell', handler: () => json(listShells()) },
    {
      method: 'GET',
      path: '/api/model',
      handler: located(async (_location, ctx) => {
        const requested = ctx.query.getAll('types');
        if (requested.length === 0) return (await availableModels()).map(toModelInfo);
        // A type is matched exactly: the comma form (`types=chat,image`) names no type and matches nothing.
        const served = requested.filter((type) => SERVED_MODEL_TYPES.has(type));
        if (served.length === 0) return [];
        return (await availableModels(served)).map(toModelInfo);
      }),
    },
    {
      method: 'GET',
      path: '/api/model/default',
      handler: located(async (location) => {
        const { merged } = await readSettings(location);
        const model = pickDefaultModel(await availableModels(), merged);
        return model ? toModelInfo(model) : null;
      }),
    },
    {
      method: 'GET',
      path: '/api/provider',
      handler: located(async () => {
        const [providers, declared] = await Promise.all([fromPi(() => catalog.providers()), modelsJsonProviders()]);
        return providers
          .filter((provider) => provider.configured)
          .map((provider) => toProviderInfo(provider, {
            declared: provider.id in declared,
            apiKey: apiKeyMarker(declared[provider.id]?.apiKey),
          }));
      }),
    },
    { method: 'GET', path: '/api/agent', handler: located((location) => agentsOf(location.directory)) },
    {
      method: 'GET',
      path: '/api/agent/:agentID',
      handler: located(async (location, ctx) => {
        const agent = (await agentsOf(location.directory)).find((candidate) => candidate.id === ctx.params.agentID);
        if (!agent) throw agentNotFound(ctx.params.agentID);
        return agent;
      }),
    },
    {
      method: 'GET',
      path: '/api/command',
      handler: located(async (location) => {
        const templates = await resources.prompts({ agentDir: getAgentDir(), directory: location.directory, includeProject: await location.readsProject() });
        // A prompt template named like a built-in replaces it: it is what the user typed `/name` for in Pi.
        const commands = new Map(BUILTIN_COMMANDS.map((command) => [command.name, command]));
        for (const template of templates) {
          commands.set(template.name, { name: template.name, ...(template.description ? { description: template.description } : {}) });
        }
        return [...commands.values()];
      }),
    },
    {
      method: 'GET',
      path: '/api/skill',
      handler: located(async (location) => resources.skills({ agentDir: getAgentDir(), directory: location.directory, includeProject: await location.readsProject() })),
    },
    { method: 'GET', path: '/api/mcp', handler: located(mcpServersOf) },
    // The coordinator owns shell processes; until it lists them none are running.
    { method: 'GET', path: '/api/shell', handler: located(() => []) },
    {
      method: 'GET',
      path: '/api/integration',
      handler: located(async () => (await fromPi(() => catalog.providers())).map(toIntegrationInfo)),
    },
    { method: 'GET', path: '/api/plugin', handler: located(pluginsOf) },
    // Saved ("always allow") permissions live with the permission flow, which has none yet.
    { method: 'GET', path: '/api/permission/saved', handler: () => json({ data: [] }) },
    { method: 'GET', path: '/api/credential', handler: async () => json({ data: await readCredentials() }, 200, { 'cache-control': 'no-store' }) },
  ];
};
