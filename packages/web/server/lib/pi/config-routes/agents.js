// Host-owned agent profiles: Pi has no agent concept of its own, so
// OpenChamber keeps one markdown file per agent, global under
// `<agentDir>/openchamber/agents/*.md` and per trusted project under
// `<directory>/.pi/agents/*.md`, and merges them into the bridge's `/api/agent`
// through `bridge/routes/catalog.js`'s `agentStore` dependency.
//
// Frontmatter overlaps the vocabulary `examples/extensions/subagent/agents/*.md`
// and `@tintinweb/pi-subagents` already use (`name`, `description`, `model`,
// `thinking`, `tools`, `color`), so a file written here reads sensibly to those
// tools too; `mode`, `hidden`, `permissions` and the editor's `steps`,
// `temperature`, `top_p` are OpenChamber's own keys and are ignored by anything
// that only reads the shared vocabulary. `exclude_tools` is a list of Pi tool
// names or patterns kept out of the model's tool list (`--exclude-tools`); the
// editor does not write it, a person can, and an editor save keeps it. The body
// is the system prompt.
// Sampling parameters are stored so the editor round-trips them; Pi applies no
// per-agent temperature or step limit (see ../DOCUMENTATION.md).
//
// `agentLaunchOptions` is the pure function that turns one profile into what a
// Pi child needs to start as that agent; the coordinator calls it from
// `bridge/index.js`'s `buildLaunch`, the same place `plan` is special-cased.

import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../shared/guards.js';
import { buildAppliedResponse } from '../../opencode/config-mutation-response.js';
import { deniedToolNames } from '../bridge/permission-rules.js';
import { createBuiltinAgents } from '../bridge/routes/builtin-agents.js';
import {
  isSafeEntityName,
  projectDirFor,
  projectIsTrusted,
  readMarkdown,
  writeMarkdown,
} from './paths.js';

const AGENT_SCOPE = { USER: 'user', PROJECT: 'project' };
const MODES = new Set(['primary', 'subagent', 'all']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const GLOBAL_AGENTS_SUBDIR = path.join('openchamber', 'agents');

const isFile = (file) => {
  try {
    if (!fs.statSync(file).isFile()) throw new Error(`Agent path is not a file: ${file}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

/** `provider/id#variant` <-> `{providerID, id, variant?}`, mirroring `config-v2.js`'s split/join. */
export const parseModelRef = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const providerID = trimmed.slice(0, slash);
  const hash = trimmed.indexOf('#', slash + 1);
  const id = trimmed.slice(slash + 1, hash === -1 ? undefined : hash);
  const variant = hash === -1 ? undefined : trimmed.slice(hash + 1);
  if (!id) return null;
  return variant ? { providerID, id, variant } : { providerID, id };
};

export const formatModelRef = (ref) => {
  if (!isRecord(ref) || typeof ref.providerID !== 'string' || typeof ref.id !== 'string' || !ref.providerID || !ref.id) return null;
  return ref.variant ? `${ref.providerID}/${ref.id}#${ref.variant}` : `${ref.providerID}/${ref.id}`;
};

const toCsv = (value) => {
  const entries = typeof value === 'string' ? value.split(',') : value;
  return Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean) : null;
};

const normalizePermissions = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule) => isRecord(rule) && typeof rule.action === 'string' && typeof rule.resource === 'string' && ['allow', 'deny', 'ask'].includes(rule.effect))
    .map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }));
};

const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The sampling parameters the editor edits, as OpenCode keeps them (`request.body`). */
const requestOf = (temperature, topP) => {
  const body = {
    ...(finiteNumber(temperature) !== undefined ? { temperature } : {}),
    ...(finiteNumber(topP) !== undefined ? { top_p: topP } : {}),
  };
  return Object.keys(body).length ? { body } : undefined;
};

/**
 * Frontmatter + body -> the canonical profile the routes and `agentLaunchOptions`
 * work with. `id` is always the file's own name (the stem OpenChamber uses to
 * address the agent), never the frontmatter `name`: letting the frontmatter
 * retarget the id would let one file answer for two different route params.
 */
const toProfile = (id, frontmatter, body, builtin = {}) => {
  const fm = isRecord(frontmatter) ? frontmatter : {};
  const request = requestOf(fm.temperature, fm.top_p);
  return {
    id,
    name: typeof fm.display_name === 'string' && fm.display_name ? fm.display_name : (typeof fm.name === 'string' && fm.name ? fm.name : (builtin.name ?? id)),
    description: typeof fm.description === 'string' ? fm.description : builtin.description,
    mode: MODES.has(fm.mode) ? fm.mode : (builtin.mode ?? 'subagent'),
    model: typeof fm.model === 'string' ? fm.model : undefined,
    thinking: THINKING_LEVELS.has(fm.thinking) ? fm.thinking : undefined,
    tools: toCsv(fm.tools),
    excludeTools: toCsv(fm.exclude_tools) ?? undefined,
    color: typeof fm.color === 'string' && COLOR_PATTERN.test(fm.color) ? fm.color : undefined,
    hidden: typeof fm.hidden === 'boolean' ? fm.hidden : (builtin.hidden ?? false),
    disabled: fm.disabled === true,
    ...(finiteNumber(fm.steps) !== undefined ? { steps: fm.steps } : {}),
    ...(request ? { request } : {}),
    permissions: fm.permissions === undefined ? (builtin.permissions ?? []) : normalizePermissions(fm.permissions),
    system: body ?? '',
  };
};

const fromProfile = (profile) => {
  const frontmatter = {
    name: profile.id,
    display_name: profile.name !== profile.id ? profile.name : undefined,
    description: profile.description,
    mode: profile.mode,
    model: profile.model,
    thinking: profile.thinking,
    tools: profile.tools ?? undefined,
    exclude_tools: profile.excludeTools?.length ? profile.excludeTools : undefined,
    color: profile.color,
    hidden: profile.hidden,
    disabled: profile.disabled ? true : undefined,
    steps: finiteNumber(profile.steps),
    temperature: finiteNumber(profile.request?.body?.temperature),
    top_p: finiteNumber(profile.request?.body?.top_p),
    permissions: profile.permissions,
  };
  return { frontmatter, body: profile.system ?? '' };
};

/** `AgentInfo` as `/api/agent` (through `bridge/routes/catalog.js`) serves it. */
const toAgentInfo = (profile) => ({
  id: profile.id,
  name: profile.name,
  mode: profile.mode,
  hidden: profile.hidden,
  ...(profile.disabled ? { disabled: true } : {}),
  ...(profile.description ? { description: profile.description } : {}),
  ...(profile.model ? (() => {
    const ref = parseModelRef(profile.model);
    return ref ? { model: ref } : {};
  })() : {}),
  ...(profile.system ? { system: profile.system } : {}),
  ...(profile.color ? { color: profile.color } : {}),
  ...(finiteNumber(profile.steps) !== undefined ? { steps: profile.steps } : {}),
  request: { settings: {}, headers: {}, body: { ...(profile.request?.body ?? {}) } },
  permissions: profile.permissions,
});

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir
 * @param {(directory: string) => boolean | Promise<boolean>} [options.isProjectTrusted]
 */
export const createAgentStore = ({ getAgentDir, isProjectTrusted = async () => true }) => {
  const globalDir = () => path.join(getAgentDir(), GLOBAL_AGENTS_SUBDIR);
  const builtins = new Map(createBuiltinAgents({ planDirectory: path.join(getAgentDir(), 'plans') }).map((agent) => [agent.id, agent]));

  /** Nested ids match the editor's `group/name` paths. Only a missing directory is empty. */
  const filesIn = (dir, prefix = '') => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries.flatMap((entry) => {
      if (entry.isDirectory()) return filesIn(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.md')) return [];
      const id = `${prefix}${entry.name.slice(0, -3)}`;
      return isSafeEntityName(id) ? [{ id, file: path.join(dir, entry.name) }] : [];
    });
  };

  /** `{ directory, scope, exists, path }` for one id: project file first, else the global one. */
  const locate = async (id, directory) => {
    if (!isSafeEntityName(id)) throw new Error(`Invalid agent name: ${id}`);
    if (directory && await projectIsTrusted(isProjectTrusted, directory)) {
      const projectPath = path.join(projectDirFor(directory, 'agents'), `${id}.md`);
      if (isFile(projectPath)) return { scope: AGENT_SCOPE.PROJECT, path: projectPath, exists: true };
    }
    const globalPath = path.join(globalDir(), `${id}.md`);
    return { scope: AGENT_SCOPE.USER, path: globalPath, exists: isFile(globalPath) };
  };

  const readOne = (file, id) => {
    const { frontmatter, body } = readMarkdown(file);
    return toProfile(id, frontmatter, body, builtins.get(id));
  };

  /** Every profile visible for `directory`: project files first, then global, first id wins. */
  const list = async (directory) => {
    const seen = new Map();
    const projectDir = projectDirFor(directory ?? '', 'agents');
    if (directory && await projectIsTrusted(isProjectTrusted, directory)) {
      for (const { id, file } of filesIn(projectDir)) {
        seen.set(id, readOne(file, id));
      }
    }
    for (const { id, file } of filesIn(globalDir())) {
      if (seen.has(id)) continue;
      seen.set(id, readOne(file, id));
    }
    return [...seen.values()].map(toAgentInfo);
  };

  const get = async (id, directory) => {
    const location = await locate(id, directory);
    if (!location.exists) return null;
    return { ...location, profile: readOne(location.path, id) };
  };

  const create = async (id, fields, directory, requestedScope) => {
    if (!isSafeEntityName(id)) throw new Error(`Invalid agent name: ${id}`);
    if (id.includes(':')) throw new Error('An agent id cannot contain ":" (reserved for plugin-scoped names)');
    const existing = await locate(id, directory);
    if (existing.exists) throw new Error(`Agent "${id}" already exists`);
    const wantsProject = requestedScope === AGENT_SCOPE.PROJECT;
    if (wantsProject && !directory) throw new Error('Project scope requires a directory');
    const trusted = wantsProject && directory ? await projectIsTrusted(isProjectTrusted, directory) : false;
    if (wantsProject && !trusted) throw new Error(`"${directory}" is not a trusted project, so an agent written there would be ignored`);
    const scope = wantsProject ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
    const filePath = wantsProject ? path.join(projectDirFor(directory, 'agents'), `${id}.md`) : path.join(globalDir(), `${id}.md`);
    const profile = toProfile(id, fields, typeof fields?.system === 'string' ? fields.system : (builtins.get(id)?.system ?? ''), builtins.get(id));
    // The editor sends the entity shape (`steps`, `request.body`), not the
    // flat frontmatter keys the profile reads.
    if (finiteNumber(fields?.steps) !== undefined) profile.steps = fields.steps;
    const request = requestOf(fields?.request?.body?.temperature, fields?.request?.body?.top_p);
    if (request) profile.request = request;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const { frontmatter, body } = fromProfile(profile);
    writeMarkdown(filePath, frontmatter, body);
    return { scope, path: filePath };
  };

  const update = async (id, updates, directory) => {
    const found = await get(id, directory);
    if (!found) {
      if (builtins.has(id)) return create(id, updates, directory, AGENT_SCOPE.USER);
      throw new Error(`Agent "${id}" not found`);
    }
    const next = { ...found.profile };
    for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
      if (value === undefined) continue;
      if (value === null) {
        if (field === 'description') next.description = undefined;
        else if (field === 'model') next.model = undefined;
        else if (field === 'thinking') next.thinking = undefined;
        else if (field === 'tools') next.tools = null;
        else if (field === 'color') next.color = undefined;
        else if (field === 'permissions') next.permissions = [];
        else if (field === 'system') next.system = '';
        else if (field === 'steps') next.steps = undefined;
        else if (field === 'request') next.request = undefined;
        continue;
      }
      if (field === 'permissions') { next.permissions = normalizePermissions(value); continue; }
      if (field === 'tools') { next.tools = toCsv(value); continue; }
      if (field === 'steps') { next.steps = finiteNumber(value); continue; }
      if (field === 'request') { next.request = requestOf(value?.body?.temperature, value?.body?.top_p); continue; }
      next[field] = value;
    }
    const { frontmatter, body } = fromProfile(next);
    writeMarkdown(found.path, frontmatter, body);
    return { scope: found.scope, path: found.path };
  };

  const remove = async (id, directory, scope) => {
    if (!isSafeEntityName(id)) throw new Error(`Invalid agent name: ${id}`);
    if (scope === AGENT_SCOPE.PROJECT) {
      if (!directory) throw new Error('Project scope requires a directory');
      if (!await projectIsTrusted(isProjectTrusted, directory)) throw new Error('Project is not trusted');
      const filePath = path.join(projectDirFor(directory, 'agents'), `${id}.md`);
      if (!isFile(filePath)) throw new Error(`Agent "${id}" not found in the project`);
      fs.unlinkSync(filePath);
      return;
    }
    if (scope === AGENT_SCOPE.USER) {
      const filePath = path.join(globalDir(), `${id}.md`);
      if (!isFile(filePath)) throw new Error(`Agent "${id}" not found`);
      fs.unlinkSync(filePath);
      return;
    }
    const found = await get(id, directory);
    if (!found) throw new Error(`Agent "${id}" not found`);
    fs.unlinkSync(found.path);
  };

  const listDisabled = async (directory) => Promise.all((await list(directory)).filter((agent) => agent.disabled).map(async (agent) => {
    const found = await get(agent.id, directory);
    return { name: agent.id, scope: found.scope, path: found.path, ...(agent.description ? { description: agent.description } : {}) };
  }));

  return { list, listDisabled, get, create, update, remove, locate };
};

/**
 * Pure: one agent profile -> what a new Pi child needs to run as that agent.
 * The coordinator calls this from `bridge/index.js`'s `buildLaunch`, the same
 * place `plan`'s system-prompt append already lives, and merges its `extraArgs`
 * after plan's (a built-in agent is not a stored profile, so the two never
 * both apply to one launch).
 *
 * - `model` becomes the `--model provider/id[:thinking]` string `launch.js`
 *   passes straight to `buildPiRpcArgs`.
 * - `tools` becomes `--tools <csv>`, Pi's own allowlist grammar (plain names
 *   replace the default set; `+name`/`-name` modify it). Absent `tools` keeps
 *   Pi's defaults.
 * - `excludeTools` (frontmatter `exclude_tools`) and every tool the agent's
 *   `permissions` deny outright (`deniedToolNames`) become `--exclude-tools
 *   <csv>`, which keeps them out of the model's tool list.
 * - `system` becomes `--append-system-prompt <text>`, verified to still reach
 *   the model when the system prompt is otherwise replaced, so an agent's own
 *   voice survives next to `SYSTEM.md` or another `--system-prompt`.
 *
 * `permissions` still decide every call: OpenChamber's own gate reads them per
 * request from the profile the coordinator's `getContext` looks up (see
 * CONFIG-NOTES.md, "Gap: agent permissions are not yet looked up"); the
 * exclusion above only stops offering a tool the gate would always refuse.
 * `mode` is not here.
 *
 * @param {{ model?: string, thinking?: string, tools?: string[]|null, excludeTools?: string[], permissions?: Array, system?: string }} profile
 * @param {{ planDirectory?: string }} [_context]  Unused for now; kept so a
 *   future per-agent write scope can take it without changing the signature.
 */
export const agentLaunchOptions = (profile, _context = {}) => {
  const extraArgs = [];
  let model;
  if (profile?.model) {
    const ref = parseModelRef(profile.model);
    if (ref) model = ref.variant ? `${ref.providerID}/${ref.id}:${ref.variant}` : `${ref.providerID}/${ref.id}`;
  }
  // A variant suffix on `model` already names the thinking level; a separate
  // `--thinking` would just repeat it (or disagree, if the two differ).
  if (profile?.thinking && !parseModelRef(profile.model)?.variant) {
    extraArgs.push('--thinking', profile.thinking);
  }
  if (Array.isArray(profile?.tools)) {
    if (profile.tools.length > 0) extraArgs.push('--tools', profile.tools.join(','));
    else extraArgs.push('--no-tools');
  }
  // What the agent may not use is not offered to the model either: a denied
  // tool in the list still costs its description on every request, and the
  // model would only learn it is refused by trying it.
  const excluded = [...new Set([...(profile?.excludeTools ?? []), ...deniedToolNames(profile?.permissions)])];
  if (excluded.length > 0) extraArgs.push('--exclude-tools', excluded.join(','));
  if (typeof profile?.system === 'string' && profile.system.trim()) {
    extraArgs.push('--append-system-prompt', profile.system);
  }
  return { ...(model ? { model } : {}), extraArgs };
};

/** @param {import('express').Express} app */
export const registerAgentConfigRoutes = (app, { store, resolveProjectDirectory, resolveOptionalProjectDirectory, onChanged }) => {
  app.use('/api/config/agents/:name', (req, res, next) => (
    isSafeEntityName(req.params.name) ? next() : res.status(400).json({ error: 'Invalid name' })
  ));

  app.get('/api/config/disabled-agents', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      res.json({ agents: await store.listDisabled(directory) });
    } catch {
      res.status(500).json({ error: 'Failed to list disabled agents' });
    }
  });

  app.get('/api/config/agents/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const found = await store.get(req.params.name, directory);
      res.json({
        name: req.params.name,
        scope: found?.scope ?? null,
        isBuiltIn: !found,
        sources: {
          md: { exists: Boolean(found), path: found?.path ?? null, scope: found?.scope ?? null, legacy: false, fields: found ? Object.keys(found.profile) : [] },
          json: { exists: false, path: null, scope: null, legacy: false, fields: [] },
        },
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name/config', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const found = await store.get(req.params.name, directory);
      const { id, ...config } = found?.profile ?? {};
      void id;
      res.json({ source: found ? 'md' : 'none', scope: found?.scope ?? null, path: found?.path ?? null, legacy: false, config: found ? config : {} });
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.get('/api/config/agents/:name/permissions', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const found = await store.get(req.params.name, directory);
      const agentRules = found?.profile.permissions ?? [];
      res.json({
        global: [],
        agent: agentRules,
        effective: agentRules.map((rule) => ({ ...rule, source: 'agent' })),
        source: found ? 'md' : 'none',
        path: found?.path ?? null,
      });
    } catch (error) {
      console.error('Failed to get agent permissions:', error);
      res.status(500).json({ error: 'Failed to get agent permissions' });
    }
  });

  app.post('/api/config/agents/:name', async (req, res) => {
    try {
      const { scope, ...config } = req.body ?? {};
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory && scope === AGENT_SCOPE.PROJECT) return res.status(400).json({ error });
      const created = await store.create(req.params.name, config, directory, scope);
      await onChanged?.();
      res.json(buildAppliedResponse(`Agent ${req.params.name} created successfully.`, created));
    } catch (error) {
      console.error('Failed to create agent:', error);
      res.status(500).json({ error: error.message || 'Failed to create agent' });
    }
  });

  app.patch('/api/config/agents/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const updated = await store.update(req.params.name, req.body, directory);
      await onChanged?.();
      res.json(buildAppliedResponse(`Agent ${req.params.name} updated successfully.`, updated));
    } catch (error) {
      console.error('Failed to update agent:', error);
      res.status(500).json({ error: error.message || 'Failed to update agent' });
    }
  });

  app.delete('/api/config/agents/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      await store.remove(req.params.name, directory, req.body?.scope);
      await onChanged?.();
      res.json(buildAppliedResponse(`Agent ${req.params.name} deleted successfully.`));
    } catch (error) {
      console.error('Failed to delete agent:', error);
      res.status(500).json({ error: error.message || 'Failed to delete agent' });
    }
  });
};
