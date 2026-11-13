// Pi packages and extension files, as the Settings Plugins page manages them.
//
// What OpenCode called a plugin entry is a package in `settings.json`
// `packages`, what it called a plugin file is a file in an `extensions/`
// folder. Installing, removing and updating go through Pi's own CLI exactly as
// a user would run it; this module adds what the CLI does not do (the enabled
// switch, filters, a registry search, the project trust check, a listing that
// never fails on a broken settings file). See PLUGINS-NOTES.md.

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { resolveNpmRegistryRequest } from '../opencode/npm-registry-config.js';
import { createPiCliRunner, sanitizeOutput } from './packages-cli.js';
import {
  RESOURCE_KEYS,
  createSettingsWriter,
  entrySource,
  filtersOf,
  isDisabledEntry,
  isEnabledByOverrides,
  packageEntries,
  readSettingsFile,
  withEnabled,
  withExtensionsEnabled,
  withFilters,
  withoutExtensionOverrides,
} from './packages-settings.js';
import {
  codedError,
  compareVersions,
  installedPathFor,
  isExactVersion,
  normalizePackageSource,
  parseConfiguredSource,
  resolveLocalSource,
  sourceIdentity,
} from './packages-sources.js';

export { codedError } from './packages-sources.js';

const EXTENSION_FILE_NAME = /^[a-z0-9][a-z0-9-_.]*\.(?:js|ts)$/;
const MAX_EXTENSION_BYTES = 1024 * 1024;
const REGISTRY_CACHE_TTL_MS = 3_600_000;
const REGISTRY_TIMEOUT_MS = 5_000;
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const SEARCH_KEYWORD = 'pi-package';
const INSTALL_TIMEOUT_MS = 180_000;
const REMOVE_TIMEOUT_MS = 60_000;

/** The managed OpenChamber tools and the Settings flag that switches each one. */
export const MANAGED_TOOLS = [
  { flag: 'includeControl', setting: 'agentControlToolEnabled', tools: ['openchamber'] },
  { flag: 'includeSchedule', setting: 'agentScheduleToolEnabled', tools: ['openchamber_schedule'] },
  { flag: 'includeWeb', setting: 'agentWebToolEnabled', tools: ['openchamber_web'] },
  { flag: 'includeMemory', setting: 'agentMemoryToolEnabled', tools: ['openchamber_memory'] },
  { flag: 'includeKnowledge', setting: 'agentKnowledgeToolEnabled', tools: ['openchamber_knowledge'] },
  { flag: 'includeNotify', setting: 'agentNotifyToolEnabled', tools: ['openchamber_notify'] },
  { flag: 'includeRender', setting: 'agentRenderToolEnabled', tools: ['openchamber_render'] },
  { flag: 'includeImage', setting: 'agentImageToolEnabled', tools: ['openchamber_image'] },
  { flag: 'includeSecret', setting: 'agentSecretToolEnabled', tools: ['openchamber_secret'] },
  { flag: 'includeUsage', setting: 'agentUsageToolEnabled', tools: ['openchamber_usage'] },
  { flag: 'includeWorkflow', setting: 'agentWorkflowToolEnabled', tools: ['openchamber_workflow', 'openchamber_workflow_answer'] },
];

/**
 * The extensions OpenChamber hands every Pi process itself, as read-only rows.
 * They are not in settings.json and cannot be removed here; each tool's switch
 * is the Settings flag named in `setting`.
 *
 * @param {Record<string, boolean>} flags  `managedToolFlags(settings)`
 */
export const describeManagedExtensions = (flags) => [
  {
    id: 'openchamber.managed-tools',
    name: 'OpenChamber agent tools',
    kind: 'managed',
    readOnly: true,
    enabled: MANAGED_TOOLS.some((tool) => flags[tool.flag] === true),
    tools: MANAGED_TOOLS.map((tool) => ({ flag: tool.flag, setting: tool.setting, names: tool.tools, enabled: flags[tool.flag] === true })),
  },
  {
    id: 'openchamber.gate',
    name: 'OpenChamber permission gate',
    kind: 'managed',
    readOnly: true,
    enabled: true,
    tools: [],
  },
];

const encodeId = (prefix, value) => Buffer.from(`${prefix}:${value}`).toString('base64url');

const decodeId = (id) => {
  const decoded = typeof id === 'string' ? Buffer.from(id, 'base64url').toString('utf8') : '';
  const first = decoded.indexOf(':');
  const second = decoded.indexOf(':', first + 1);
  if (first < 1 || second < 0) throw codedError('Invalid plugin id', 'INVALID_SPEC');
  return { prefix: decoded.slice(0, first), scope: decoded.slice(first + 1, second), value: decoded.slice(second + 1) };
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultFetchRegistry = async (url, { headers = {}, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: response.ok ? await response.json() : null };
};

/**
 * Whether Pi would load the resources of a project folder, decided the way
 * `pi install -l` decides without a terminal: the closest saved decision in
 * `<agent dir>/trust.json`, else a folder with nothing to protect, else the
 * `defaultProjectTrust` setting. An unreadable trust store means not trusted.
 */
export const createPiTrustReader = ({
  getAgentDir,
  fs = fsPromises,
  loadSdk = () => import('@earendil-works/pi-coding-agent'),
}) => async (directory) => {
  const agentDir = getAgentDir();
  const sdk = await loadSdk();
  let saved;
  try {
    saved = new sdk.ProjectTrustStore(agentDir).get(directory);
  } catch {
    return false;
  }
  if (saved !== null) return saved === true;
  if (!sdk.hasTrustRequiringProjectResources(directory)) return true;
  const settings = await readSettingsFile(fs, path.join(agentDir, 'settings.json'));
  return settings.data.defaultProjectTrust === 'always';
};

/** A dist-tag name (`next`, `beta`), as opposed to a semver range (`^1`, `1.x`, `*`). */
const isDistTag = (version) => /^[A-Za-z][\w.-]*$/.test(version) && !/^[xX]$/.test(version);

// Search results are written by package publishers: only http(s) addresses are passed on as links.
const webLink = (value) => {
  const link = typeof value === 'string' ? value.replace(/^git\+/, '').replace(/\.git$/, '') : '';
  return /^https?:\/\//i.test(link) ? link : null;
};

const stringsOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir  Pi's agent directory (`PI_CODING_AGENT_DIR`).
 * @param {ReturnType<import('./packages-cli.js').createPiCliRunner>} [options.runPi]  `(args, { cwd, env, timeoutMs })`
 * @param {typeof fsPromises} [options.fs]
 * @param {(url: string, options: { headers?: Record<string,string>, timeoutMs?: number }) => Promise<{ status: number, body: unknown }>} [options.fetchRegistry]
 *   Every registry request goes through this, so a test never reaches the network.
 * @param {(name: string) => { url: string, headers: Record<string,string> }} [options.resolveRegistryRequest]
 * @param {(directory: string) => boolean | Promise<boolean>} [options.isTrusted]  Whether project-scope resources of a folder may be loaded or changed.
 * @param {() => Promise<typeof import('@earendil-works/pi-coding-agent')>} [options.loadSdk]
 */
export const createPiPackages = ({
  getAgentDir,
  runPi = createPiCliRunner(),
  fs = fsPromises,
  fetchRegistry = defaultFetchRegistry,
  resolveRegistryRequest = resolveNpmRegistryRequest,
  isTrusted = createPiTrustReader({ getAgentDir, fs }),
  loadSdk = () => import('@earendil-works/pi-coding-agent'),
  homedir = os.homedir(),
}) => {
  const writer = createSettingsWriter({ fs });
  const registryCache = new Map();

  // Scope ----------------------------------------------------------------

  const isDirectory = async (target) => fs.stat(target).then((stat) => stat.isDirectory(), () => false);
  const exists = async (target) => fs.stat(target).then(() => true, () => false);

  const requireDirectory = async (directory) => {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await isDirectory(directory))) {
      throw codedError('Project scope needs an existing absolute project folder', 'INVALID_DIRECTORY');
    }
    return path.resolve(directory);
  };

  /** Where a scope keeps its settings file, and the folder Pi runs in for it. */
  const scopeContext = async (scope, directory = null) => {
    if (scope !== 'user' && scope !== 'project') throw codedError('Package scope must be user or project', 'INVALID_SCOPE');
    const agentDir = path.resolve(getAgentDir());
    if (scope === 'user') {
      // A user-scope change needs no project; the folder only resolves a relative local path.
      return { scope, agentDir, baseDir: agentDir, settingsPath: path.join(agentDir, 'settings.json'), cwd: agentDir, directory: typeof directory === 'string' && path.isAbsolute(directory) ? path.resolve(directory) : null };
    }
    const project = await requireDirectory(directory);
    const baseDir = path.join(project, '.pi');
    return { scope, agentDir, baseDir, settingsPath: path.join(baseDir, 'settings.json'), cwd: project, directory: project };
  };

  // A failed trust check is an untrusted project: the check guards code that runs.
  const trustedFolder = async (directory) => {
    try {
      return (await isTrusted(directory)) === true;
    } catch {
      return false;
    }
  };

  const assertTrusted = async (ctx) => {
    if (ctx.scope === 'project' && !(await trustedFolder(ctx.directory))) {
      throw codedError(
        `${ctx.directory} is not a trusted project. Pi loads packages and extensions from a project's .pi folder only after the project is trusted, and OpenChamber does not add code to one it does not trust. Trust the project first.`,
        'PROJECT_NOT_TRUSTED',
      );
    }
  };

  // Reading packages -------------------------------------------------------

  const readManifest = async (dir) => {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const describePackage = async (ctx, entry, trusted) => {
    const source = entrySource(entry);
    if (source === null) return null;
    const parsed = parseConfiguredSource(source);
    const installedPath = installedPathFor(source, ctx.baseDir, homedir);
    const stat = installedPath === null ? null : await fs.stat(installedPath).catch(() => null);
    const installed = stat !== null;
    const manifest = installed && stat.isDirectory() ? await readManifest(installedPath) : null;
    // Pi loads a package that is one extension file whatever its filters say, so it has no off state.
    const switchable = !(parsed.kind === 'local' && stat?.isFile());
    const enabled = !switchable || !isDisabledEntry(entry);
    const filters = enabled && switchable ? filtersOf(entry) : null;
    let notLoadedReason = null;
    if (ctx.scope === 'project' && !trusted) notLoadedReason = 'project-not-trusted';
    else if (!installed) notLoadedReason = 'not-installed';
    else if (!enabled) notLoadedReason = 'disabled';
    const name = parsed.kind === 'npm' ? parsed.name
      : parsed.kind === 'git' ? parsed.repoName
        : typeof manifest?.name === 'string' ? manifest.name : path.basename(installedPath ?? source);
    return {
      id: encodeId('config', `${ctx.scope}:${source}`),
      source,
      scope: ctx.scope,
      kind: parsed.kind,
      name,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      requested: parsed.kind === 'npm' ? parsed.version : parsed.kind === 'git' ? parsed.ref : null,
      installed,
      installedPath: installed ? installedPath : null,
      resolvedPath: parsed.kind === 'local' ? await fs.realpath(installedPath).catch(() => installedPath) : null,
      settingsPath: ctx.settingsPath,
      enabled,
      switchable,
      filters,
      loaded: notLoadedReason === null,
      notLoadedReason,
    };
  };

  const resolveEntryPaths = async (dir) => {
    const manifest = await readManifest(dir);
    const declared = stringsOf(manifest?.pi?.extensions).map((entry) => path.resolve(dir, entry));
    const existing = [];
    for (const candidate of declared) if (await exists(candidate)) existing.push(candidate);
    if (existing.length > 0) return existing;
    for (const index of ['index.ts', 'index.js']) {
      if (await exists(path.join(dir, index))) return [path.join(dir, index)];
    }
    return null;
  };

  const describeExtensions = async (ctx, settingsData, trusted) => {
    const dir = path.join(ctx.baseDir, 'extensions');
    const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const patterns = stringsOf(settingsData.extensions);
    const items = [];
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
      const absolutePath = path.join(dir, dirent.name);
      const stat = dirent.isSymbolicLink() ? await fs.stat(absolutePath).catch(() => null) : dirent;
      if (!stat) continue;
      let kind = null;
      let entryPaths = null;
      if (stat.isFile() && /\.(?:ts|js)$/.test(dirent.name)) {
        kind = 'file';
        entryPaths = [absolutePath];
      } else if (stat.isDirectory()) {
        kind = 'directory';
        entryPaths = await resolveEntryPaths(absolutePath);
      }
      if (!entryPaths) continue;
      const enabled = entryPaths.every((entryPath) => isEnabledByOverrides(entryPath, patterns, ctx.baseDir));
      const notLoadedReason = ctx.scope === 'project' && !trusted ? 'project-not-trusted' : enabled ? null : 'disabled';
      items.push({
        id: encodeId(kind === 'file' ? 'file' : 'package', `${ctx.scope}:${dirent.name}`),
        name: dirent.name,
        scope: ctx.scope,
        kind,
        absolutePath,
        resolvedPath: await fs.realpath(absolutePath).catch(() => absolutePath),
        entryPaths,
        settingsPath: ctx.settingsPath,
        enabled,
        loaded: notLoadedReason === null,
        notLoadedReason,
      });
    }
    return items;
  };

  /**
   * Every package and extension file Pi would read for a folder: user scope
   * always, project scope when a folder is given. A settings file that cannot
   * be parsed is reported in `settingsErrors` and contributes no packages; it
   * never fails the listing. A project that is not trusted is listed with
   * `loaded: false` so nothing looks active that Pi would skip.
   *
   * @param {{ directory?: string|null }} [options]
   */
  const list = async ({ directory = null } = {}) => {
    const contexts = [await scopeContext('user', directory)];
    let projectTrusted = null;
    if (directory) {
      contexts.push(await scopeContext('project', directory));
      projectTrusted = await trustedFolder(contexts[1].directory);
    }
    const packages = [];
    const extensions = [];
    const settingsErrors = [];
    for (const ctx of contexts) {
      const trusted = ctx.scope === 'user' ? true : projectTrusted;
      const settings = await readSettingsFile(fs, ctx.settingsPath);
      if (settings.error) settingsErrors.push({ scope: ctx.scope, path: ctx.settingsPath, message: settings.error });
      const described = await Promise.all(packageEntries(settings.data).map((entry) => describePackage(ctx, entry, trusted)));
      packages.push(...described.filter(Boolean));
      extensions.push(...await describeExtensions(ctx, settings.data, trusted));
    }
    return { packages, extensions, projectTrusted, settingsErrors };
  };

  /** One configured package, found by id in the settings file its scope names. */
  const locate = async (id, directory) => {
    const { prefix, scope, value: source } = decodeId(id);
    if (prefix !== 'config') throw codedError('Plugin entry not found', 'NOT_FOUND');
    const ctx = await scopeContext(scope, directory);
    const settings = await readSettingsFile(fs, ctx.settingsPath);
    if (settings.error) {
      throw codedError(`${ctx.settingsPath} cannot be read (${settings.error}). Fix the file first`, 'SETTINGS_INVALID');
    }
    const entry = packageEntries(settings.data).find((candidate) => entrySource(candidate) === source);
    if (entry === undefined) throw codedError('Plugin entry not found', 'NOT_FOUND');
    return { ctx, source, entry };
  };

  const describeById = async (ctx, source) => {
    const settings = await readSettingsFile(fs, ctx.settingsPath);
    const entry = packageEntries(settings.data).find((candidate) => entrySource(candidate) === source);
    return entry === undefined ? null : describePackage(ctx, entry, true);
  };

  // Running Pi -----------------------------------------------------------------

  // npm explains its failures on `npm error` lines (`code E404`, `404 Not Found - GET ...`);
  // Pi's own last line only repeats the command that failed.
  const headlineOf = (lines, code) => {
    const npm = lines
      .filter((line) => line.startsWith('npm error '))
      .map((line) => line.slice('npm error '.length))
      .filter((line) => /^(?:code |\d{3} |FetchError|network)/.test(line))
      .slice(0, 2);
    if (npm.length > 0) return npm.join('; ');
    return [...lines].reverse().find((line) => /^Error:/.test(line))?.replace(/^Error:\s*/, '') ?? lines.at(-1) ?? `exit code ${code}`;
  };

  const failure = (verb, source, result) => {
    const stderr = sanitizeOutput(result.stderr);
    const stdout = sanitizeOutput(result.stdout);
    if (/Project is not trusted/i.test(`${stderr}\n${stdout}`)) {
      return codedError(
        'Pi refused to change this project\'s package settings because the project is not trusted.',
        'PROJECT_NOT_TRUSTED',
      );
    }
    const all = (stderr || stdout).split('\n').map((line) => line.trim()).filter(Boolean);
    const lines = all.slice(-12);
    return codedError(
      `Pi could not ${verb} ${sanitizeOutput(source)}: ${headlineOf(all, result.code).slice(0, 400)}`,
      verb === 'install' ? 'INSTALL_FAILED' : verb === 'remove' ? 'REMOVE_FAILED' : 'UPDATE_FAILED',
      { detail: lines.join('\n').slice(-1500) },
    );
  };

  const runPackageCommand = async (ctx, verb, args, source, timeoutMs) => {
    let result;
    try {
      await fs.mkdir(ctx.cwd, { recursive: true });
      // A project-scope command only runs for a folder `isTrusted` approved; Pi's own
      // trust store is not told, so the approval is passed for this one command.
      const command = ctx.scope === 'project' ? [verb, ...args, '--approve'] : [verb, ...args];
      result = await runPi(command, { cwd: ctx.cwd, env: { PI_CODING_AGENT_DIR: ctx.agentDir }, timeoutMs });
    } catch (error) {
      throw codedError(`Pi could not be started: ${sanitizeOutput(error?.message ?? error)}`, 'PI_UNAVAILABLE');
    }
    if (result.timedOut) {
      throw codedError(`Pi did not finish ${verb === 'install' ? 'installing' : verb === 'remove' ? 'removing' : 'updating'} ${sanitizeOutput(source)} within ${Math.round(timeoutMs / 1000)} seconds and was stopped`, 'PI_TIMEOUT');
    }
    if (result.code !== 0) throw failure(verb, source, result);
    return result;
  };

  const notSwitchable = () => codedError(
    'A package that is a single extension file cannot be switched off or filtered: Pi loads it whatever its filters say. Remove it instead.',
    'NOT_SWITCHABLE',
  );

  // What `pi remove` and `pi update` are given: Pi reads a relative local path
  // against its working directory, not against the settings file, so a local
  // package is always named by its absolute path.
  const commandSource = (ctx, source) => {
    const parsed = parseConfiguredSource(source);
    return parsed.kind === 'local' ? resolveLocalSource(parsed.path, ctx.baseDir, homedir) : source;
  };

  const requireValidSettings = async (ctx) => {
    const settings = await readSettingsFile(fs, ctx.settingsPath);
    if (settings.error) {
      throw codedError(
        `${ctx.settingsPath} cannot be read (${settings.error}). Fix the file first: Pi would install the package and silently not record it`,
        'SETTINGS_INVALID',
      );
    }
    return settings.data;
  };

  const findIndexByIdentity = (ctx, data, identity) => packageEntries(data).findIndex((entry) => {
    const source = entrySource(entry);
    return source !== null && sourceIdentity(source, ctx.baseDir, homedir) === identity;
  });

  // Changing packages ----------------------------------------------------------

  /**
   * Install a package into a scope with `pi install` and optionally narrow what
   * it loads. Pi writes the settings entry only after the install succeeded, so
   * a failed install leaves settings.json as it was.
   *
   * @param {{ source: string, scope?: 'user'|'project', directory?: string|null, filters?: Record<string, string[]>|null }} input
   */
  const add = async ({ source: input, scope = 'user', directory = null, filters = null }) => {
    const ctx = await scopeContext(scope, directory);
    await assertTrusted(ctx);
    const { source, kind } = normalizePackageSource(input, { cwd: ctx.directory, homedir });
    if (kind === 'local' && !(await exists(source))) throw codedError(`${source} does not exist`, 'INVALID_SPEC');
    const identity = sourceIdentity(source, ctx.baseDir, homedir);

    return writer.queue(ctx.settingsPath, async () => {
      const before = await requireValidSettings(ctx);
      if (findIndexByIdentity(ctx, before, identity) !== -1) {
        throw codedError(`Package "${source}" is already installed in this scope`, 'ENTRY_EXISTS');
      }
      await runPackageCommand(ctx, 'install', ctx.scope === 'project' ? [source, '-l'] : [source], source, INSTALL_TIMEOUT_MS);

      const after = await requireValidSettings(ctx);
      const index = findIndexByIdentity(ctx, after, identity);
      if (index === -1) {
        throw codedError(`Pi reported success but did not record ${source} in ${ctx.settingsPath}`, 'INSTALL_NOT_RECORDED');
      }
      const recorded = entrySource(packageEntries(after)[index]);
      if (filters && Object.keys(filters).length > 0) {
        await writer.write(ctx.settingsPath, (data) => {
          const position = findIndexByIdentity(ctx, data, identity);
          if (position === -1) return false;
          data.packages[position] = withFilters(data.packages[position], filters);
          return true;
        }).catch((error) => {
          throw codedError(`${source} was installed, but its filters were not saved: ${error.message}`, error.code ?? 'SETTINGS_INVALID');
        });
      }
      return describeById(ctx, recorded);
    });
  };

  /** Remove a package with `pi remove`. An entry Pi cannot place (a source of a shape it does not know) is dropped from settings.json directly. */
  const remove = async ({ id, directory = null }) => {
    const { ctx, source } = await locate(id, directory);
    await assertTrusted(ctx);
    const identity = sourceIdentity(source, ctx.baseDir, homedir);
    return writer.queue(ctx.settingsPath, async () => {
      await requireValidSettings(ctx);
      if (parseConfiguredSource(source).kind === 'unknown') {
        await writer.write(ctx.settingsPath, (data) => {
          const index = packageEntries(data).findIndex((entry) => entrySource(entry) === source);
          if (index === -1) return false;
          data.packages.splice(index, 1);
          return true;
        });
      } else {
        await runPackageCommand(ctx, 'remove', ctx.scope === 'project' ? [commandSource(ctx, source), '-l'] : [commandSource(ctx, source)], source, REMOVE_TIMEOUT_MS);
      }
      const after = await requireValidSettings(ctx);
      if (findIndexByIdentity(ctx, after, identity) !== -1) {
        throw codedError(`Pi reported success but ${source} is still in ${ctx.settingsPath}`, 'REMOVE_FAILED');
      }
      return { id, source, scope: ctx.scope, settingsPath: ctx.settingsPath };
    });
  };

  /** Reinstall a package at the newest release its source allows, with `pi update <source>`. */
  const update = async ({ id, directory = null }) => {
    const { ctx, source } = await locate(id, directory);
    await assertTrusted(ctx);
    return writer.queue(ctx.settingsPath, async () => {
      await requireValidSettings(ctx);
      const before = await describeById(ctx, source);
      await runPackageCommand(ctx, 'update', [commandSource(ctx, source)], source, INSTALL_TIMEOUT_MS)
        .catch((error) => {
          if (ctx.scope === 'project' && /No matching package/i.test(error?.detail ?? '')) {
            throw codedError('Pi updates a project package only when the project is trusted.', 'PROJECT_NOT_TRUSTED');
          }
          throw error;
        });
      const after = await describeById(ctx, source);
      return {
        id,
        source,
        scope: ctx.scope,
        before: before?.version ?? null,
        after: after?.version ?? null,
        updated: before?.version !== after?.version,
      };
    });
  };

  /**
   * Update packages named by the source string in their settings entry, as the
   * runtime inventory reports them. Stops at the first failure.
   */
  const updateTargets = async ({ targets, directory = null }) => {
    const { packages } = await list({ directory });
    const results = [];
    for (const target of targets) {
      const match = packages.find((candidate) => candidate.source === target);
      if (!match) throw codedError(`No installed package matches ${target}`, 'NOT_FOUND');
      results.push(await update({ id: match.id, directory }));
    }
    return results;
  };

  /** Switch a package on or off by rewriting its settings entry; no process runs. */
  const setEnabled = async ({ id, enabled, directory = null }) => {
    if (enabled !== true && enabled !== false) throw codedError('enabled must be a boolean', 'INVALID_STATE');
    const { ctx, source } = await locate(id, directory);
    await assertTrusted(ctx);
    if (!enabled && (await describeById(ctx, source))?.switchable === false) throw notSwitchable();
    const { changed } = await writer.update(ctx.settingsPath, (data) => {
      const index = packageEntries(data).findIndex((entry) => entrySource(entry) === source);
      if (index === -1) throw codedError('Plugin entry not found', 'NOT_FOUND');
      const next = withEnabled(data.packages[index], enabled);
      if (next === data.packages[index]) return false;
      data.packages[index] = next;
      return true;
    });
    return { id, source, scope: ctx.scope, enabled, changed };
  };

  /**
   * Change the source of an entry to another spelling of the same package (a
   * new version of an npm package, another ref of a repository) and/or replace
   * its resource filters. Another package is a different entry: remove the old
   * one and add the new one.
   */
  const updateEntry = async ({ id, spec, filters, directory = null }) => {
    const { ctx, source } = await locate(id, directory);
    await assertTrusted(ctx);
    let nextSource = source;
    // The page sends the spec it shows on every save, and shows the string settings.json holds.
    if (spec !== undefined && spec !== source) {
      const normalized = normalizePackageSource(spec, { cwd: ctx.baseDir, homedir });
      const identity = sourceIdentity(normalized.source, ctx.baseDir, homedir);
      if (identity !== sourceIdentity(source, ctx.baseDir, homedir)) {
        throw codedError('A Pi package keeps its identity: remove this one and add the other', 'IDENTITY_CHANGED');
      }
      if (normalized.kind !== 'local' && normalized.source !== source) {
        await writer.queue(ctx.settingsPath, async () => {
          await requireValidSettings(ctx);
          await runPackageCommand(ctx, 'install', ctx.scope === 'project' ? [normalized.source, '-l'] : [normalized.source], normalized.source, INSTALL_TIMEOUT_MS);
        });
        nextSource = normalized.source;
      }
    }
    if (filters !== undefined) {
      if (Object.keys(filters).length > 0 && (await describeById(ctx, nextSource))?.switchable === false) throw notSwitchable();
      await writer.update(ctx.settingsPath, (data) => {
        const index = packageEntries(data).findIndex((entry) => entrySource(entry) === nextSource);
        if (index === -1) throw codedError('Plugin entry not found', 'NOT_FOUND');
        const entry = data.packages[index];
        if (isDisabledEntry(entry)) {
          if (Object.keys(filters).length > 0) throw codedError('This package is switched off. Switch it on to change its filters', 'PACKAGE_DISABLED');
          return false;
        }
        const next = withFilters(entry, filters);
        if (JSON.stringify(next) === JSON.stringify(entry)) return false;
        data.packages[index] = next;
        return true;
      });
    }
    return describeById(ctx, nextSource);
  };

  // The registry -----------------------------------------------------------------

  /**
   * Published versions of one npm package, from the user's configured registry
   * (`.npmrc`, scoped registries and auth included). Cached for an hour; a
   * failure is returned as `{ ok: false }`, never as an empty package.
   */
  const registryInfo = async (name, { forceRefresh = false } = {}) => {
    const cached = registryCache.get(name);
    if (cached && !forceRefresh && Date.now() - cached.at < REGISTRY_CACHE_TTL_MS) return cached.result;
    let result;
    try {
      const request = resolveRegistryRequest(name);
      const { status, body } = await fetchRegistry(request.url, {
        headers: { accept: 'application/json', 'user-agent': 'openchamber-server', ...request.headers },
        timeoutMs: REGISTRY_TIMEOUT_MS,
      });
      if (status === 404) result = { ok: false, status: 404, error: 'Package not found' };
      else if (status !== 200) result = { ok: false, status, error: `Registry returned ${status}` };
      else {
        const tags = isRecord(body?.['dist-tags']) ? body['dist-tags'] : {};
        result = {
          ok: true,
          latest: typeof tags.latest === 'string' ? tags.latest : null,
          distTags: Object.fromEntries(Object.entries(tags).filter((tag) => typeof tag[1] === 'string')),
          versions: isRecord(body?.versions) ? Object.keys(body.versions) : [],
        };
      }
    } catch (error) {
      result = { ok: false, status: 'network', error: sanitizeOutput(error?.message ?? error) };
    }
    if (result.ok || result.status === 404) registryCache.set(name, { at: Date.now(), result });
    return result;
  };

  /**
   * Compare the installed version of every npm package with the newest one.
   * Only a package that `pi update` can move is `outdated`: an exact pin is
   * reported with its latest version and `pinned: true`. A package whose
   * registry answer failed is `checked: false` with the reason, never "up to date".
   * `sources` limits the check to the entries with those source strings.
   */
  const check = async ({ directory = null, sources = null } = {}) => {
    const { packages } = await list({ directory });
    const candidates = packages.filter((entry) => entry.notLoadedReason !== 'project-not-trusted' && (!sources || sources.includes(entry.source)));
    return Promise.all(candidates.map(async (entry) => {
      const base = { id: entry.id, source: entry.source, scope: entry.scope, kind: entry.kind, name: entry.name, installedVersion: entry.version, latestVersion: null, outdated: false, pinned: false, rangeLimited: false, checked: false };
      if (entry.kind !== 'npm') return entry.kind === 'git' ? { ...base, reason: 'Git packages are not checked for updates here' } : base;
      const info = await registryInfo(entry.name, { forceRefresh: true });
      if (!info.ok) return { ...base, error: info.status === 'network' ? info.error : `Registry returned ${info.status}` };
      // `pi update` follows `latest` for a bare name, the named dist-tag for `@next`, and the newest
      // release inside the range for `@^1.0.0`. A range needs semver ranges to evaluate, so it is
      // reported with the latest release but never flagged.
      const pinned = isExactVersion(entry.requested);
      const rangeLimited = Boolean(entry.requested) && !pinned && !isDistTag(entry.requested);
      const followed = entry.requested && !pinned && !rangeLimited ? info.distTags[entry.requested] ?? null : info.latest;
      if (followed === null && !rangeLimited) return { ...base, error: `The registry has no "${entry.requested}" tag for ${entry.name}` };
      const newer = entry.version !== null && followed !== null ? compareVersions(followed, entry.version) : null;
      return {
        ...base,
        latestVersion: rangeLimited ? info.latest : followed,
        pinned,
        rangeLimited,
        checked: true,
        outdated: !pinned && !rangeLimited && newer !== null && newer > 0,
      };
    }));
  };

  /**
   * The npm registry search for packages tagged `pi-package`. An empty query
   * lists the most popular ones.
   *
   * @param {{ query?: string, from?: number, size?: number }} [options]
   */
  const searchRegistry = async ({ query = '', from = 0, size = 20 } = {}) => {
    const terms = String(query).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const params = [
      `text=${encodeURIComponent(terms ? `keywords:${SEARCH_KEYWORD} ${terms}` : `keywords:${SEARCH_KEYWORD}`)}`,
      `size=${Math.min(Math.max(Math.trunc(Number(size)) || 20, 1), 50)}`,
      `from=${Math.max(Math.trunc(Number(from)) || 0, 0)}`,
    ];
    if (!terms) params.push('popularity=1.0', 'quality=0.0', 'maintenance=0.0');
    let response;
    try {
      response = await fetchRegistry(`${SEARCH_URL}?${params.join('&')}`, { headers: { accept: 'application/json', 'user-agent': 'openchamber-server' }, timeoutMs: REGISTRY_TIMEOUT_MS });
    } catch (error) {
      throw codedError(`The npm registry could not be reached: ${sanitizeOutput(error?.message ?? error)}`, 'REGISTRY_UNAVAILABLE');
    }
    if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.objects)) {
      throw codedError(`The npm registry search answered with status ${response.status}`, 'REGISTRY_UNAVAILABLE');
    }
    const results = response.body.objects.flatMap((item) => {
      const pkg = item?.package;
      if (!isRecord(pkg) || typeof pkg.name !== 'string') return [];
      return [{
        name: pkg.name,
        source: `npm:${pkg.name}`,
        version: typeof pkg.version === 'string' ? pkg.version : null,
        description: typeof pkg.description === 'string' ? pkg.description : '',
        keywords: stringsOf(pkg.keywords),
        date: typeof pkg.date === 'string' ? pkg.date : null,
        publisher: typeof pkg.publisher?.username === 'string' ? pkg.publisher.username : null,
        links: { npm: webLink(pkg.links?.npm), homepage: webLink(pkg.links?.homepage), repository: webLink(pkg.links?.repository) },
        weeklyDownloads: Number.isFinite(item.downloads?.weekly) ? item.downloads.weekly : null,
        monthlyDownloads: Number.isFinite(item.downloads?.monthly) ? item.downloads.monthly : null,
        flaggedInsecure: item.flags?.insecure === 1,
      }];
    });
    return { results, total: Number.isFinite(response.body.total) ? response.body.total : results.length };
  };

  // What a package contributes -------------------------------------------------

  const frontmatter = async (file) => {
    try {
      const head = (await fs.readFile(file, 'utf8')).slice(0, 4096);
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
      const parsed = match ? parseYaml(match[1]) : null;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const describeResource = async (type, resource, packageRoot) => {
    const file = resource.path;
    const relativePath = packageRoot ? path.relative(packageRoot, file).split(path.sep).join('/') : file;
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    const base = { path: file, relativePath, enabled: resource.enabled !== false };
    if (type === 'extensions') {
      return { ...base, name: /^index$/.test(stem) ? path.basename(path.dirname(file)) : stem };
    }
    const meta = type === 'themes' ? {} : await frontmatter(file);
    const name = type === 'skills'
      ? (typeof meta.name === 'string' ? meta.name : path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : stem)
      : stem;
    return { ...base, name, ...(typeof meta.description === 'string' ? { description: meta.description } : {}) };
  };

  /**
   * The extensions, skills, prompt templates and themes an installed package
   * loads, as Pi resolves them (its own `package.json` `pi` manifest or the
   * conventional folders, narrowed by this entry's filters). Resources a filter
   * switches off are listed with `enabled: false`. Nothing is installed or run.
   */
  const contributions = async ({ id, directory = null }) => {
    const { ctx, source } = await locate(id, directory);
    await assertTrusted(ctx);
    const described = await describeById(ctx, source);
    const empty = { extensions: [], skills: [], prompts: [], themes: [] };
    if (!described?.installed) return { id, source, installed: false, root: null, ...empty };
    let resolved;
    try {
      const sdk = await loadSdk();
      const settingsManager = sdk.SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.scope === 'project' });
      resolved = await new sdk.DefaultPackageManager({ cwd: ctx.cwd, agentDir: ctx.agentDir, settingsManager }).resolve(async () => 'skip');
    } catch (error) {
      throw codedError(`Could not read what ${source} contributes: ${sanitizeOutput(error?.message ?? error)}`, 'CONTRIBUTIONS_UNAVAILABLE');
    }
    const out = { id, source, installed: true, root: described.installedPath };
    for (const type of RESOURCE_KEYS) {
      const own = (resolved[type] ?? []).filter((resource) => (
        resource.metadata?.origin === 'package' && resource.metadata.source === source && resource.metadata.scope === ctx.scope
      ));
      out[type] = await Promise.all(own.map((resource) => describeResource(type, resource, described.installedPath)));
    }
    return out;
  };

  // Extension files ----------------------------------------------------------------

  const extensionTarget = (prefixes, id) => {
    const decoded = decodeId(id);
    if (!prefixes.includes(decoded.prefix)) throw codedError('Plugin file not found', 'NOT_FOUND');
    return decoded;
  };

  const validateFileName = (fileName) => {
    if (typeof fileName !== 'string' || !fileName) throw codedError('Plugin file name is required', 'INVALID_FILENAME');
    if (!EXTENSION_FILE_NAME.test(fileName)) {
      throw codedError('Extension file name must be lowercase, match [a-z0-9][a-z0-9-_.]* and end in .js or .ts (Pi does not load .mjs or .cjs files from an extensions folder)', 'INVALID_FILENAME');
    }
    return fileName;
  };

  const extensionFilePath = (ctx, fileName) => path.join(ctx.baseDir, 'extensions', validateFileName(fileName));

  // A file somebody else put in the folder may have a name this page would not create (capitals, say).
  // It stays readable and editable as long as the name cannot leave the folder.
  const existingFilePath = (ctx, fileName) => {
    if (typeof fileName !== 'string' || !/^[^/\\\0.][^/\\\0]*\.(?:js|ts)$/.test(fileName)) {
      throw codedError('Plugin file name is invalid', 'INVALID_FILENAME');
    }
    return path.join(ctx.baseDir, 'extensions', fileName);
  };

  const readExtensionFile = async ({ id, directory = null }) => {
    const { scope, value: fileName } = extensionTarget(['file'], id);
    const ctx = await scopeContext(scope, directory);
    try {
      return { fileName, scope, content: await fs.readFile(existingFilePath(ctx, fileName), 'utf8') };
    } catch (error) {
      if (error?.code === 'ENOENT') throw codedError(`Plugin file "${fileName}" not found`, 'NOT_FOUND');
      throw error;
    }
  };

  const createExtensionFile = async ({ fileName, content, scope = 'user', directory = null }) => {
    const ctx = await scopeContext(scope, directory);
    const target = extensionFilePath(ctx, fileName);
    await assertTrusted(ctx);
    const text = content ?? '';
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_EXTENSION_BYTES) {
      throw codedError('Extension content must be text of at most 1 MB', 'INVALID_SPEC');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code === 'EEXIST') throw codedError(`Plugin file "${fileName}" already exists`, 'FILE_EXISTS');
      throw error;
    }
    return { id: encodeId('file', `${ctx.scope}:${fileName}`), fileName, scope: ctx.scope, absolutePath: target };
  };

  const updateExtensionFile = async ({ id, content, directory = null }) => {
    const { scope, value: fileName } = extensionTarget(['file'], id);
    const ctx = await scopeContext(scope, directory);
    const target = existingFilePath(ctx, fileName);
    await assertTrusted(ctx);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_EXTENSION_BYTES) {
      throw codedError('Extension content must be text of at most 1 MB', 'INVALID_SPEC');
    }
    if (!(await exists(target))) throw codedError(`Plugin file "${fileName}" not found`, 'NOT_FOUND');
    await fs.writeFile(target, content, 'utf8');
    return { id, fileName, scope: ctx.scope, absolutePath: target };
  };

  const deleteExtensionFile = async ({ id, directory = null }) => {
    const { scope, value: fileName } = extensionTarget(['file'], id);
    const ctx = await scopeContext(scope, directory);
    const target = existingFilePath(ctx, fileName);
    await assertTrusted(ctx);
    try {
      await fs.unlink(target);
    } catch (error) {
      if (error?.code === 'ENOENT') throw codedError(`Plugin file "${fileName}" not found`, 'NOT_FOUND');
      throw error;
    }
    // A leftover `-extensions/<name>` entry would keep a new file of that name off.
    let warning = null;
    await writer.update(ctx.settingsPath, (data) => {
      const patterns = stringsOf(data.extensions);
      const kept = withoutExtensionOverrides(patterns, [target], ctx.baseDir);
      if (kept.length === patterns.length) return false;
      data.extensions = kept;
      return true;
    }).catch((error) => {
      warning = `The file was deleted, but ${ctx.settingsPath} could not be updated (${error.message}). An entry for ${fileName} in its "extensions" list may keep a new file of that name switched off.`;
    });
    return { id, fileName, scope: ctx.scope, ...(warning ? { warning } : {}) };
  };

  /** Switch an extension file or folder with the override entries `pi config` writes. */
  const setExtensionEnabled = async ({ id, enabled, directory = null }) => {
    if (enabled !== true && enabled !== false) throw codedError('enabled must be a boolean', 'INVALID_STATE');
    const { prefix, scope, value: name } = extensionTarget(['file', 'package'], id);
    const ctx = await scopeContext(scope, directory);
    await assertTrusted(ctx);
    const settings = await readSettingsFile(fs, ctx.settingsPath);
    const items = await describeExtensions(ctx, settings.data, true);
    const item = items.find((candidate) => candidate.name === name && (prefix === 'file') === (candidate.kind === 'file'));
    if (!item) throw codedError(`Plugin file "${name}" not found`, 'NOT_FOUND');
    const { changed } = await writer.update(ctx.settingsPath, (data) => {
      const patterns = stringsOf(data.extensions);
      const next = withExtensionsEnabled(patterns, item.entryPaths, ctx.baseDir, enabled);
      if (JSON.stringify(next) === JSON.stringify(patterns)) return false;
      data.extensions = next;
      return true;
    });
    return { id, name, scope: ctx.scope, enabled, changed };
  };

  return {
    list,
    add,
    remove,
    update,
    updateTargets,
    updateEntry,
    setEnabled,
    check,
    contributions,
    searchRegistry,
    registryInfo,
    readExtensionFile,
    createExtensionFile,
    updateExtensionFile,
    deleteExtensionFile,
    setExtensionEnabled,
    encodeId,
    decodeId,
    /** The folder a settings-relative local source resolves to, for callers that show it. */
    resolveLocal: (source, baseDir) => resolveLocalSource(source, baseDir, homedir),
  };
};
