// SKILL.md CRUD, supporting files, and catalog scan/install, backed by Pi's
// own skill folders: `.pi/skills`, `.agents/skills` (walked from the project
// up to the repository root), `<agentDir>/skills`, `~/.agents/skills`. The
// listing a client sees is `bridge/routes/pi-resources.js`'s own scanner
// (`createResourceScanner().skills`), the same function `/api/skill` already
// serves from, so `/api/config/skills` and `/api/skill` can never disagree
// about what Pi will actually load; this module adds the sources/CRUD layer
// the Settings page needs on top of that one scan.
//
// `resolveSkill` is for `bridge/prompting.js`: a skill named on `POST .../prompt`
// becomes `<skill_content name="...">` wrapped text, the OpenCode tag name
// with the SKILL.md body (wire spec 6.1, golden 34) in place of OpenCode's own
// base-directory and file-listing sections, which nothing here needs: Pi's
// model already gets a `<location>` for the file from the system prompt's
// `<available_skills>` block, so this module does not repeat it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { asNonEmptyString } from '../../shared/guards.js';
import { buildAppliedResponse } from '../../opencode/config-mutation-response.js';
import {
  deleteSkillSupportingFile,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
} from '../../opencode/shared.js';
import { getCuratedSkillsSources } from '../../skills-catalog/curated-sources.js';
import { fetchGitHubRepoMetas } from '../../skills-catalog/github-meta.js';
import { getCacheKey, scanWithCache } from '../../skills-catalog/cache.js';
import { installSkillsFromRepository } from '../../skills-catalog/install.js';
import { appendInstalledSources, isInstalledFromSource, readInstalledSources, removeInstalledSources } from '../../skills-catalog/installed-sources.js';
import { parseSkillRepoSource } from '../../skills-catalog/source.js';
import { scanSkillsRepository } from '../../skills-catalog/scan.js';
import { ancestorAgentsSkillDirs, createResourceScanner } from '../bridge/routes/pi-resources.js';
import { isFile, projectIsTrusted, readMarkdown, writeMarkdown } from './paths.js';

const SKILL_SCOPE = { USER: 'user', PROJECT: 'project' };
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const DISABLE_MODEL_INVOCATION_KEY = 'disable-model-invocation';
const PROJECT_SKILLS_DIR_NAME = '.pi';

const isValidSkillName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 64 && SKILL_NAME_PATTERN.test(name);

const isUnder = (candidate, root) => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

/**
 * `pi-resources.js`'s scanner answers the wire shape (`{id, name, description,
 * path, content}`, no scope or source: Pi's own `loadSkillsFromDir` does not
 * carry it past the call that asked for one root). The Settings page needs
 * "where does this live", so it is recovered here from the skill's own
 * directory against the four roots the scanner itself read from, the same
 * way the retired `opencode/skill-routes.js` inferred it for OpenCode's
 * skills. A path matching none of them (found through a `skills` setting or
 * a package, which this store does not create into) is reported as the
 * nearest fallback, `{scope: 'user', source: 'pi'}`, so the entry still shows
 * rather than vanishing.
 */
const inferLocation = (skillPath, directory, getAgentDir, getHomeDir) => {
  const dir = path.dirname(skillPath);
  if (isUnder(dir, path.join(getAgentDir(), 'skills'))) return { scope: SKILL_SCOPE.USER, source: 'pi' };
  if (isUnder(dir, path.join(getHomeDir(), '.agents', 'skills'))) return { scope: SKILL_SCOPE.USER, source: 'agents' };
  if (directory) {
    if (isUnder(dir, path.join(directory, PROJECT_SKILLS_DIR_NAME, 'skills'))) return { scope: SKILL_SCOPE.PROJECT, source: 'pi' };
    if (ancestorAgentsSkillDirs(directory).some((root) => isUnder(dir, root))) return { scope: SKILL_SCOPE.PROJECT, source: 'agents' };
  }
  return { scope: SKILL_SCOPE.USER, source: 'pi' };
};

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir
 * @param {(directory: string) => boolean | Promise<boolean>} [options.isProjectTrusted]
 * @param {() => string} [options.getHomeDir]
 * @param {() => Promise<typeof import('@earendil-works/pi-coding-agent')>} [options.loadSdk]
 * @param {(message: string) => void} [options.log]
 */
export const createSkillStore = ({
  getAgentDir,
  isProjectTrusted = async () => true,
  getHomeDir = () => os.homedir(),
  loadSdk = () => import('@earendil-works/pi-coding-agent'),
  onChanged = () => {},
  log = (message) => console.warn(`[pi-config] ${message}`),
}) => {
  const report = (key, message) => { if (message) log(message); };
  const scanner = createResourceScanner({ loadSdk, getHomeDir, report });

  /** Run one write at a time: a check against the disk must not go stale before its own write lands. */
  let queue = Promise.resolve();
  const serialized = (run) => {
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };

  // `pi-resources.js`'s scanner takes `includeProject` as a plain flag and
  // does not itself gate it on trust (catalog.js's caller does that); every
  // read here must decide it the same way, so a read of a directory nobody
  // trusted never lists that directory's `.pi/skills` or `.agents/skills`.
  const scan = async (directory) => {
    const found = await scanner.skills({
      agentDir: getAgentDir(),
      directory: directory || '',
      includeProject: Boolean(directory) && await projectIsTrusted(isProjectTrusted, directory),
    });
    return found.map((skill) => ({ ...skill, ...inferLocation(skill.path, directory, getAgentDir, getHomeDir) }));
  };

  const list = async (directory) => scan(directory);

  const find = async (id, directory) => (await scan(directory)).find((skill) => skill.id === id) ?? null;

  const targetDirFor = (scope, source, directory) => {
    if (scope === SKILL_SCOPE.USER) {
      return source === 'agents' ? path.join(getHomeDir(), '.agents', 'skills') : path.join(getAgentDir(), 'skills');
    }
    return source === 'agents' ? path.join(directory, '.agents', 'skills') : path.join(directory, PROJECT_SKILLS_DIR_NAME, 'skills');
  };

  const create = (id, config, directory, scope) => serialized(async () => {
    if (!isValidSkillName(id)) throw new Error(`Invalid skill name "${id}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
    const existing = await find(id, directory);
    if (existing) throw new Error(`Skill ${id} already exists at ${existing.path}`);
    const wantsProject = scope === SKILL_SCOPE.PROJECT;
    if (wantsProject && !directory) throw new Error('Project scope requires a directory');
    const trusted = wantsProject && directory ? await projectIsTrusted(isProjectTrusted, directory) : false;
    if (wantsProject && !trusted) throw new Error(`"${directory}" is not a trusted project, so a skill written there would be ignored`);
    const source = config?.source === 'agents' ? 'agents' : 'pi';
    const targetDir = path.join(targetDirFor(wantsProject ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER, source, directory), id);
    const { instructions, scope: _scope, source: _source, supportingFiles, disableModelInvocation, ...frontmatter } = config ?? {};
    void _scope; void _source;
    frontmatter.name = id;
    if (!frontmatter.description) throw new Error('Skill description is required');
    if (disableModelInvocation === true) frontmatter[DISABLE_MODEL_INVOCATION_KEY] = true;
    if (isFile(path.join(targetDir, 'SKILL.md'))) throw new Error(`Skill ${id} already exists at ${targetDir}`);
    writeMarkdown(path.join(targetDir, 'SKILL.md'), frontmatter, instructions ?? '');
    if (Array.isArray(supportingFiles)) {
      for (const file of supportingFiles) {
        if (file?.path && file.content !== undefined) writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
    onChanged({ directory: wantsProject ? directory : null });
    return { scope: wantsProject ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER, path: path.join(targetDir, 'SKILL.md') };
  });

  const update = (id, updates, directory) => serialized(async () => {
    const found = await find(id, directory);
    if (!found) throw new Error(`Skill "${id}" not found`);
    const dir = path.dirname(found.path);
    const current = readMarkdown(found.path);
    const nextFrontmatter = { ...current.frontmatter };
    let nextBody = current.body;
    for (const [field, value] of Object.entries(updates ?? {})) {
      if (['scope', 'source', 'targetPath', 'renameTo'].includes(field)) continue;
      if (field === 'instructions') { nextBody = typeof value === 'string' ? value : ''; continue; }
      if (field === 'supportingFiles') {
        if (Array.isArray(value)) {
          for (const file of value) {
            if (file?.delete && file.path) deleteSkillSupportingFile(dir, file.path);
            else if (file?.path && file.content !== undefined) writeSkillSupportingFile(dir, file.path, file.content);
          }
        }
        continue;
      }
      if (field === 'disableModelInvocation') {
        if (value === true) nextFrontmatter[DISABLE_MODEL_INVOCATION_KEY] = true;
        else delete nextFrontmatter[DISABLE_MODEL_INVOCATION_KEY];
        continue;
      }
      nextFrontmatter[field] = value;
    }
    writeMarkdown(found.path, nextFrontmatter, nextBody);
    onChanged({ directory: found.scope === SKILL_SCOPE.PROJECT ? directory : null });
    return { scope: found.scope, path: found.path };
  });

  const rename = (oldId, newId, directory) => serialized(async () => {
    if (!isValidSkillName(newId)) throw new Error(`Invalid skill name "${newId}".`);
    if (oldId === newId) return;
    const found = await find(oldId, directory);
    if (!found) throw new Error(`Skill "${oldId}" not found or cannot be renamed`);
    const conflict = await find(newId, directory);
    if (conflict) throw new Error(`Skill ${newId} already exists at ${conflict.path}`);
    const oldDir = path.dirname(found.path);
    const newDir = path.join(path.dirname(oldDir), newId);
    if (fs.existsSync(newDir)) throw new Error(`Skill directory already exists at ${newDir}`);
    fs.renameSync(oldDir, newDir);
    try {
      const { frontmatter, body } = readMarkdown(path.join(newDir, 'SKILL.md'));
      writeMarkdown(path.join(newDir, 'SKILL.md'), { ...frontmatter, name: newId }, body);
    } catch (error) {
      try { fs.renameSync(newDir, oldDir); } catch { /* best-effort rollback */ }
      throw error;
    }
    onChanged({ directory: found.scope === SKILL_SCOPE.PROJECT ? directory : null });
  });

  const remove = (id, directory, location) => serialized(async () => {
    if (location) {
      const dir = path.join(targetDirFor(location.scope, location.source, directory), id);
      if (!fs.existsSync(dir)) throw new Error(`Skill "${id}" not found`);
      fs.rmSync(dir, { recursive: true, force: true });
      onChanged({ directory: location.scope === SKILL_SCOPE.PROJECT ? directory : null });
      return;
    }
    const found = await find(id, directory);
    if (!found) throw new Error(`Skill "${id}" not found`);
    fs.rmSync(path.dirname(found.path), { recursive: true, force: true });
    onChanged({ directory: found.scope === SKILL_SCOPE.PROJECT ? directory : null });
  });

  return { list, find, create, update, rename, remove };
};

/**
 * For `bridge/prompting.js`: `{id, name, text}` for a skill attached to a
 * prompt, or `null` when `id` names no skill reachable from `directory`.
 */
export const createSkillResolver = (store) => async (id, directory) => {
  const skill = await store.find(id, directory);
  if (!skill) return null;
  const text = `<skill_content name="${skill.name}">\n${skill.content ?? ''}\n</skill_content>`;
  return { id: skill.id, name: skill.name, text };
};

const isPathInside = (candidate, parent) => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
};

/** Whether `skillPath`'s directory sits under a folder this store writes to, so the page offers rename. */
const isManagedPath = (skillPath, directory, getAgentDir, getHomeDir) => {
  if (!skillPath) return false;
  const dir = path.dirname(path.resolve(skillPath));
  const roots = [
    path.join(getAgentDir(), 'skills'),
    path.join(getHomeDir(), '.agents', 'skills'),
    ...(directory ? [path.join(directory, PROJECT_SKILLS_DIR_NAME, 'skills'), ...ancestorAgentsSkillDirs(directory)] : []),
  ];
  return roots.some((root) => isPathInside(dir, root));
};

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {ReturnType<typeof createSkillStore>} deps.store
 * @param {() => string} deps.getAgentDir
 * @param {() => string} [deps.getHomeDir]
 * @param {(req) => Promise<{directory?: string|null, error?: string}>} deps.resolveOptionalProjectDirectory
 * @param {(req) => Promise<{directory?: string|null, error?: string}>} deps.resolveProjectDirectory
 * @param {() => Promise<object>} [deps.readSettings]  For `skillCatalogs` (custom catalog sources).
 * @param {(value) => Array} [deps.sanitizeSkillCatalogs]
 * @param {() => Array<{id, name}>} [deps.getProfiles]
 * @param {(id) => object|null} [deps.getProfile]
 * @param {(resolved) => Promise<object>} [deps.resolveSourceControlAccount]
 * @param {(input) => string} [deps.createHttpsCredentialReference]
 * @param {object} [deps.credentialResolver]
 */
export const registerSkillConfigRoutes = (app, deps) => {
  const {
    store,
    getAgentDir,
    getHomeDir = () => os.homedir(),
    resolveOptionalProjectDirectory,
    resolveProjectDirectory,
    readSettings = async () => null,
    sanitizeSkillCatalogs = (value) => (Array.isArray(value) ? value : []),
    getProfiles = () => [],
    getProfile = () => null,
    resolveSourceControlAccount,
    createHttpsCredentialReference,
    credentialResolver,
    onChanged = () => {},
  } = deps;

  const resolveCatalogGitIdentity = async (identityId, source) => {
    if (!identityId || identityId === 'global') return { ok: true, identity: null };
    const profile = getProfile(identityId);
    if (!profile) return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
    const transport = profile.transport ?? 'system';
    if (transport === 'system') return { ok: true, identity: null };
    if (transport === 'anonymous') return { ok: true, identity: { anonymous: true, transport } };
    const parsed = parseSkillRepoSource(source);
    if (!parsed.ok) return { ok: true, identity: null };
    if (transport === 'ssh') {
      return { ok: true, identity: { transport, credentialId: profile.sshCredentialId, endpoint: parsed.cloneUrlSsh } };
    }
    if (transport === 'account' && profile.account && resolveSourceControlAccount && createHttpsCredentialReference) {
      const account = await resolveSourceControlAccount(profile.account);
      if (account?.credentialId !== profile.account.accountId || account.status !== 'valid' || !Number.isSafeInteger(account.credentialRevision) || account.credentialRevision < 1) {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }
      let credentialId;
      try {
        credentialId = createHttpsCredentialReference({
          provider: profile.account.provider,
          instance: profile.account.instance,
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
        });
      } catch {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }
      return { ok: true, identity: { transport: 'https', credentialId, endpoint: parsed.cloneUrlHttps } };
    }
    return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
  };

  const listGitIdentitiesForResponse = () => {
    try { return getProfiles().map((p) => ({ id: p.id, name: p.name })); } catch { return []; }
  };

  const resolveSkillsDirectory = async (req) => {
    const optional = await resolveOptionalProjectDirectory(req);
    if (optional.error || optional.directory) return optional;
    try {
      const fallback = await resolveProjectDirectory(req);
      if (fallback.directory) return { directory: fallback.directory, error: null };
    } catch { /* listing user-scoped skills without a project is valid */ }
    return { directory: null, error: null };
  };

  const sourcesOf = async (directory) => {
    const curated = getCuratedSkillsSources();
    const settings = await readSettings();
    const custom = sanitizeSkillCatalogs(settings?.skillCatalogs).map((entry) => ({
      id: entry.id, label: entry.label, description: entry.source, source: entry.source,
      defaultSubpath: entry.subpath, gitIdentityId: entry.gitIdentityId,
    }));
    void directory;
    return [...curated, ...custom];
  };

  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const skills = await store.list(directory);
      const enriched = skills.map((skill) => ({
        ...skill,
        sources: { md: { exists: true, path: skill.path, dir: path.dirname(skill.path), fields: ['description', 'instructions'], name: skill.name, description: skill.description ?? '', instructions: skill.content ?? '', disableModelInvocation: skill.autoinvoke === false } },
        renamable: isManagedPath(skill.path, directory, getAgentDir, getHomeDir),
      }));
      res.json({ skills: enriched, externalSkills: { claudeDisabled: true, allDisabled: false } });
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const sources = await sourcesOf(null);
      const githubRepos = sources.map((src) => parseSkillRepoSource(src.source)).filter((parsed) => parsed.ok && parsed.host === 'github.com').map((parsed) => parsed.normalizedRepo);
      const repoMetas = await fetchGitHubRepoMetas(githubRepos);
      const sourcesForUi = sources.map(({ gitIdentityId, excludedSkills, ...rest }) => {
        void gitIdentityId; void excludedSkills;
        const parsed = parseSkillRepoSource(rest.source);
        const meta = parsed.ok && parsed.host === 'github.com' ? (repoMetas[parsed.normalizedRepo] || {}) : {};
        return { ...rest, stars: typeof meta.stars === 'number' ? meta.stars : null, repoUpdatedAt: typeof meta.repoUpdatedAt === 'string' ? meta.repoUpdatedAt : null };
      });
      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const sources = await sourcesOf(directory);
      const src = sources.find((entry) => entry.id === sourceId);
      if (!src) return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });

      const installedByName = new Map((await store.list(directory)).map((skill) => [skill.name, skill]));
      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({ normalizedRepo: parsed.normalizedRepo, ref: parsed.ref, subpath: effectiveSubpath || '', identityId: src.gitIdentityId || '' });
      const resolvedIdentity = await resolveCatalogGitIdentity(src.gitIdentityId, src.source);
      if (!resolvedIdentity.ok) return res.status(401).json({ ok: false, error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() } });

      const scanResult = await scanWithCache(cacheKey, () => scanSkillsRepository({
        source: src.source, subpath: src.defaultSubpath, defaultSubpath: src.defaultSubpath, identity: resolvedIdentity.identity, credentialResolver,
      }), { refresh });

      if (!scanResult.ok) {
        if (scanResult.error?.kind === 'authRequired') return res.status(401).json({ ok: false, error: { ...scanResult.error, identities: listGitIdentitiesForResponse() } });
        return res.status(500).json({ ok: false, error: scanResult.error });
      }

      const excludedSkills = new Set(src.excludedSkills || []);
      const provenanceByName = readInstalledSources();
      const items = (scanResult.items || []).filter((item) => !excludedSkills.has(item.skillName)).map((item) => {
        const installed = installedByName.get(item.skillName);
        const isInstalled = Boolean(installed) && isInstalledFromSource(provenanceByName, item.skillName, src.id, item.skillDir);
        return { sourceId: src.id, ...item, gitIdentityId: src.gitIdentityId, installed: isInstalled ? { isInstalled: true, scope: installed.scope, source: installed.source } : { isInstalled: false } };
      });
      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog source' } });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) return res.status(401).json({ ok: false, error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() } });
      const result = await scanSkillsRepository({ source, subpath, identity: resolvedIdentity.identity, credentialResolver });
      if (!result.ok) {
        if (result.error?.kind === 'authRequired') return res.status(401).json({ ok: false, error: { ...result.error, identities: listGitIdentitiesForResponse() } });
        return res.status(400).json({ ok: false, error: result.error });
      }
      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const { source, subpath, sourceId, gitIdentityId, scope, targetSource, selections, conflictPolicy, conflictDecisions } = req.body || {};
      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' } });
        workingDirectory = resolved.directory;
      }
      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) return res.status(401).json({ ok: false, error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() } });

      const result = await installSkillsFromRepository({
        source, subpath, identity: resolvedIdentity.identity, credentialResolver, scope, targetSource, workingDirectory,
        userSkillDir: path.join(getAgentDir(), 'skills'), selections, conflictPolicy, conflictDecisions,
        projectSkillsDirName: PROJECT_SKILLS_DIR_NAME,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') return res.status(409).json({ ok: false, error: result.error });
        if (result.error?.kind === 'authRequired') return res.status(401).json({ ok: false, error: { ...result.error, identities: listGitIdentitiesForResponse() } });
        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const installedAny = installed.length > 0;
      if (installedAny) onChanged({ directory: scope === 'project' ? workingDirectory : null });
      const provenanceSourceId = asNonEmptyString(sourceId);
      if (installedAny && provenanceSourceId) {
        try {
          appendInstalledSources(installed.map((entry) => ({ skillName: entry.skillName, skillDir: entry.skillDir, scope: entry.scope, source: entry.source, sourceId: provenanceSourceId, sourceRef: source })));
        } catch (error) {
          console.error('Failed to record skill install provenance:', error);
        }
      }

      res.json({ ok: true, installed, skipped: result.skipped || [], ...(installedAny ? buildAppliedResponse('Skills installed successfully.') : { requiresReload: false, message: 'No skills were installed' }) });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to install skills' } });
    }
  });

  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const skill = await store.find(req.params.name, directory);
      res.json({
        name: req.params.name,
        sources: { md: { exists: Boolean(skill), path: skill?.path ?? null, dir: skill ? path.dirname(skill.path) : null, scope: skill?.scope ?? null, source: skill?.source ?? null, fields: skill ? ['description', 'instructions'] : [], name: skill?.name ?? req.params.name, description: skill?.description ?? '', instructions: skill?.content ?? '', disableModelInvocation: skill?.autoinvoke === false, supportingFiles: skill ? await listSkillSupportingFiles(path.dirname(skill.path)) : [] } },
        scope: skill?.scope ?? null,
        source: skill?.source ?? null,
        exists: Boolean(skill),
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const filePath = decodeURIComponent(req.params.filePath);
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const skill = await store.find(req.params.name, directory);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const content = readSkillSupportingFile(path.dirname(skill.path), filePath);
      if (content === null) return res.status(404).json({ error: 'File not found' });
      res.json({ path: filePath, content });
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return res.status(403).json({ error: 'Access to file denied' });
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const filePath = decodeURIComponent(req.params.filePath);
      const { content } = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const skill = await store.find(req.params.name, directory);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      writeSkillSupportingFile(path.dirname(skill.path), filePath, content || '');
      onChanged({ directory: skill.scope === SKILL_SCOPE.PROJECT ? directory : null });
      res.json({ success: true, message: `File ${filePath} saved successfully` });
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return res.status(403).json({ error: 'Access to file denied' });
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const filePath = decodeURIComponent(req.params.filePath);
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const skill = await store.find(req.params.name, directory);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      deleteSkillSupportingFile(path.dirname(skill.path), filePath);
      onChanged({ directory: skill.scope === SKILL_SCOPE.PROJECT ? directory : null });
      res.json({ success: true, message: `File ${filePath} deleted successfully` });
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return res.status(403).json({ error: 'Access to file denied' });
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const { scope, source, ...config } = req.body;
      const { directory, error } = scope === SKILL_SCOPE.PROJECT ? await resolveProjectDirectory(req) : await resolveSkillsDirectory(req);
      if (error || (scope === SKILL_SCOPE.PROJECT && !directory)) return res.status(400).json({ error: error || 'Project skill creation requires a directory' });
      await store.create(req.params.name, { ...config, source }, directory, scope);
      res.json(buildAppliedResponse(`Skill ${req.params.name} created successfully.`));
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      if (typeof req.body?.renameTo === 'string') {
        const newName = req.body.renameTo.trim();
        await store.rename(req.params.name, newName, directory);
        return res.json({ ...buildAppliedResponse(`Skill renamed to ${newName} successfully.`), name: newName });
      }
      await store.update(req.params.name, req.body, directory);
      res.json(buildAppliedResponse(`Skill ${req.params.name} updated successfully.`));
    } catch (error) {
      console.error('Failed to update skill:', error);
      res.status(500).json({ error: error.message || 'Failed to update skill' });
    }
  });

  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) return res.status(400).json({ error });
      const scope = asNonEmptyString(req.query.scope);
      const source = asNonEmptyString(req.query.source);
      let location;
      if (scope || source) {
        if (!['user', 'project'].includes(scope) || !['pi', 'agents'].includes(source)) {
          return res.status(400).json({ error: 'scope must be user or project and source pi or agents' });
        }
        location = { scope, source };
      }
      await store.remove(req.params.name, directory, location);
      try { removeInstalledSources(req.params.name); } catch (error) { console.error('Failed to forget skill install provenance:', error); }
      res.json(buildAppliedResponse(`Skill ${req.params.name} deleted successfully.`));
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill' });
    }
  });
};
