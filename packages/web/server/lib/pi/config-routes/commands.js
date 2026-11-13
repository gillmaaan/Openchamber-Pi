// Prompt templates: commands live under `<agentDir>/prompts` or a trusted
// `<directory>/.pi/prompts`. `/api/config/commands*` owns CRUD and built-in
// materialization. `bridge/routes/pi-resources.js` lists them, including the
// editor's nested names; `bridge/commands.js` expands arguments before context
// and attachments are combined.
//
// `description` and `argument-hint` are Pi's own frontmatter keys. OpenCode's
// `model`, `agent` and `subagent` are retained for the editor, but Pi does not
// apply them itself. Execution parity belongs to bridge/prompting.js; see
// ../DOCUMENTATION.md for the remaining command boundaries.

import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../shared/guards.js';
import { buildAppliedResponse } from '../../opencode/config-mutation-response.js';
import {
  isFile,
  isSafeEntityName,
  projectDirFor,
  projectIsTrusted,
  readMarkdown,
  writeMarkdown,
} from './paths.js';

const COMMAND_SCOPE = { USER: 'user', PROJECT: 'project' };

/** `init` and `review` are materialized as real templates (see `ensureBuiltinCommands`); `goal` stays server-side. */
const BUILTIN_COMMAND_NAMES = new Set(['init', 'review', 'goal']);

const INIT_TEMPLATE = [
  'Create or update `AGENTS.md` for this repository.',
  '',
  'The goal is a compact instruction file that helps future agent sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.',
  '',
  'User-provided focus or constraints (honor these): $ARGUMENTS',
  '',
  '## How to investigate',
  '',
  'Read the highest-value sources first: `README*`, root manifests, workspace config, lockfiles; build, test, lint, formatter, typecheck and codegen config; CI workflows and pre-commit or task-runner config; existing instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`). Prefer executable sources of truth over prose; where docs conflict with config or scripts, trust the executable source.',
  '',
  '## What to extract',
  '',
  'Exact developer commands, especially non-obvious ones; how to run a single test, a single package, or a focused check; required command order when it matters; monorepo boundaries and the real entrypoints; framework quirks worth a line; testing quirks (fixtures, required services, flaky suites); constraints from existing instruction files worth preserving.',
  '',
  '## Writing rules',
  '',
  'Include only high-signal, repo-specific guidance. Exclude generic advice, long tutorials, obvious conventions, and anything you could not verify. When in doubt, omit. Prefer short sections and bullets.',
  '',
  'If `AGENTS.md` already exists, improve it in place: keep verified guidance, drop fluff or stale claims, and reconcile it with the current codebase.',
].join('\n');

const REVIEW_TEMPLATE = [
  'Review changes: $ARGUMENTS',
  '',
  'With no argument, review the uncommitted changes (`git diff` and `git diff --staged`). An argument that looks like a commit, branch, or PR number reviews that instead.',
  '',
  'Read every changed file enough to judge it, not just the diff hunks. Report:',
  '',
  '- correctness bugs the change introduces, with file and line',
  '- a regression this change causes, distinct from a pre-existing issue in the same file',
  '- anything the diff claims to do that it does not actually do',
  '',
  'Be specific and cite file paths and line numbers. Do not restate the diff; say what is wrong with it, or say it looks correct.',
].join('\n');

const BUILTIN_TEMPLATES = { init: INIT_TEMPLATE, review: REVIEW_TEMPLATE };

/**
 * Writes `init.md` and `review.md` into the global prompts directory, once:
 * a file already there (ours from an earlier boot, or the user's own) is left
 * untouched, so an edit survives every later start. Best-effort: a failed
 * write is logged and does not stop route registration.
 */
export const ensureBuiltinCommands = ({ getAgentDir, log = (message) => console.warn(`[pi-config] ${message}`) }) => {
  const dir = path.join(getAgentDir(), 'prompts');
  for (const [name, template] of Object.entries(BUILTIN_TEMPLATES)) {
    const file = path.join(dir, `${name}.md`);
    if (isFile(file)) continue;
    try {
      writeMarkdown(file, { description: name === 'init' ? 'guided AGENTS.md setup' : 'review changes [commit|branch|pr], defaults to uncommitted' }, template);
    } catch (error) {
      log(`could not write the built-in "${name}" command: ${error?.message ?? error}`);
    }
  }
};

/**
 * `GET /api/config/commands/:name`'s `isBuiltIn`: true when `name` is one of
 * the three names and no file (project or global) overrides it, matching
 * `bridge/routes/catalog.js`'s "a template named like a built-in replaces it".
 */
const locate = async (name, directory, getAgentDir, isProjectTrusted) => {
  if (directory && await projectIsTrusted(isProjectTrusted, directory)) {
    const projectPath = path.join(projectDirFor(directory, 'prompts'), `${name}.md`);
    if (isFile(projectPath)) return { scope: COMMAND_SCOPE.PROJECT, path: projectPath, exists: true };
  }
  const globalPath = path.join(getAgentDir(), 'prompts', `${name}.md`);
  return { scope: COMMAND_SCOPE.USER, path: globalPath, exists: isFile(globalPath) };
};

const toConfig = (frontmatter, body) => {
  const fm = isRecord(frontmatter) ? frontmatter : {};
  return {
    template: body ?? '',
    ...(typeof fm.description === 'string' ? { description: fm.description } : {}),
    ...(typeof fm['argument-hint'] === 'string' ? { argumentHint: fm['argument-hint'] } : {}),
    ...(typeof fm.model === 'string' ? { model: fm.model } : {}),
    ...(typeof fm.agent === 'string' ? { agent: fm.agent } : {}),
    ...(typeof fm.subagent === 'boolean' ? { subagent: fm.subagent } : {}),
  };
};

const fromConfig = (config) => ({
  frontmatter: {
    description: config.description,
    'argument-hint': config.argumentHint,
    model: config.model,
    agent: config.agent,
    subagent: config.subagent,
  },
  body: typeof config.template === 'string' ? config.template : '',
});

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir
 * @param {(directory: string) => boolean | Promise<boolean>} [options.isProjectTrusted]
 */
export const createCommandStore = ({ getAgentDir, isProjectTrusted = async () => true }) => {
  const find = (name, directory) => {
    if (!isSafeEntityName(name)) throw new Error(`Invalid command name: ${name}`);
    return locate(name, directory, getAgentDir, isProjectTrusted);
  };

  const getSources = async (name, directory) => {
    const location = await find(name, directory);
    if (!location.exists) {
      return { md: { exists: false, path: null, scope: null, legacy: false, fields: [] }, isBuiltIn: BUILTIN_COMMAND_NAMES.has(name) };
    }
    const { frontmatter, body } = readMarkdown(location.path);
    return {
      md: { exists: true, path: location.path, scope: location.scope, legacy: false, fields: Object.keys(toConfig(frontmatter, body)) },
      isBuiltIn: false,
    };
  };

  const getConfig = async (name, directory) => {
    const location = await find(name, directory);
    if (!location.exists) return { source: 'none', scope: null, path: null, legacy: false, config: {} };
    const { frontmatter, body } = readMarkdown(location.path);
    return { source: 'md', scope: location.scope, path: location.path, legacy: false, config: toConfig(frontmatter, body) };
  };

  const create = async (name, config, directory, requestedScope) => {
    if (!isSafeEntityName(name)) throw new Error(`Invalid command name: ${name}`);
    const existing = await find(name, directory);
    if (existing.exists) throw new Error(`Command "${name}" already exists`);
    const wantsProject = requestedScope === COMMAND_SCOPE.PROJECT;
    if (wantsProject && !directory) throw new Error('Project scope requires a directory');
    const trusted = wantsProject && directory ? await projectIsTrusted(isProjectTrusted, directory) : false;
    if (wantsProject && !trusted) throw new Error(`"${directory}" is not a trusted project, so a command written there would be ignored`);
    const filePath = wantsProject ? path.join(projectDirFor(directory, 'prompts'), `${name}.md`) : path.join(getAgentDir(), 'prompts', `${name}.md`);
    const { frontmatter, body } = fromConfig(config ?? {});
    writeMarkdown(filePath, frontmatter, body);
    return { scope: wantsProject ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER, path: filePath };
  };

  const update = async (name, updates, directory) => {
    const location = await find(name, directory);
    if (!location.exists) throw new Error(`Command "${name}" not found`);
    const { frontmatter, body } = readMarkdown(location.path);
    const current = toConfig(frontmatter, body);
    const next = { ...current };
    for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
      if (value === undefined) continue;
      if (value === null) { delete next[field]; continue; }
      next[field] = value;
    }
    const written = fromConfig(next);
    writeMarkdown(location.path, written.frontmatter, written.body);
    return { scope: location.scope, path: location.path };
  };

  const remove = async (name, directory) => {
    const location = await find(name, directory);
    if (!location.exists) throw new Error(`Command "${name}" not found`);
    fs.unlinkSync(location.path);
  };

  return { getSources, getConfig, create, update, remove };
};

/** @param {import('express').Express} app */
export const registerCommandConfigRoutes = (app, { store, resolveProjectDirectory, resolveOptionalProjectDirectory, onChanged }) => {
  app.use('/api/config/commands/:name', (req, res, next) => (
    isSafeEntityName(req.params.name) ? next() : res.status(400).json({ error: 'Invalid name' })
  ));

  app.get('/api/config/commands/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const sources = await store.getSources(req.params.name, directory);
      res.json({ name: req.params.name, sources, scope: sources.md.scope, isBuiltIn: sources.isBuiltIn });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.get('/api/config/commands/:name/config', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      res.json(await store.getConfig(req.params.name, directory));
    } catch (error) {
      console.error('Failed to get command config:', error);
      res.status(500).json({ error: 'Failed to get command configuration' });
    }
  });

  app.post('/api/config/commands/:name', async (req, res) => {
    try {
      const { scope, ...config } = req.body ?? {};
      const { directory, error } = scope === COMMAND_SCOPE.PROJECT
        ? await resolveProjectDirectory(req)
        : await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      if (!directory && scope === COMMAND_SCOPE.PROJECT) return res.status(400).json({ error: 'Project scope requires a directory' });
      const created = await store.create(req.params.name, config, directory, scope);
      await onChanged?.();
      res.json(buildAppliedResponse(`Command ${req.params.name} created successfully.`, created));
    } catch (error) {
      console.error('Failed to create command:', error);
      res.status(500).json({ error: error.message || 'Failed to create command' });
    }
  });

  app.patch('/api/config/commands/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const updated = await store.update(req.params.name, req.body, directory);
      await onChanged?.();
      res.json(buildAppliedResponse(`Command ${req.params.name} updated successfully.`, updated));
    } catch (error) {
      console.error('Failed to update command:', error);
      res.status(500).json({ error: error.message || 'Failed to update command' });
    }
  });

  app.delete('/api/config/commands/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      await store.remove(req.params.name, directory);
      await onChanged?.();
      res.json(buildAppliedResponse(`Command ${req.params.name} deleted successfully.`));
    } catch (error) {
      console.error('Failed to delete command:', error);
      res.status(500).json({ error: error.message || 'Failed to delete command' });
    }
  });
};
