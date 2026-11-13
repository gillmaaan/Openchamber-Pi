// Compaction, web search, and the global `AGENTS.md`.
//
// Compaction writes `~/.pi/agent/settings.json`'s `compaction.{enabled,
// reserveTokens,keepRecentTokens}` (settings.md, compaction.md); a project
// can set the same keys in its own `.pi/settings.json` and nothing here
// looks for that override, matching the OpenCode-era compaction section's
// own rule of saying so once rather than searching for one.
//
// Web search has no Pi equivalent at all: Pi has no built-in web search tool,
// so the choice is OpenChamber's own, kept in a small file beside the other
// Pi bridge state, with whether the recommended `pi-web-access` package is
// installed read from an injected check (the packages agent owns installs).
//
// AGENTS.md is the same single global file the existing Behavior page reads
// and writes today (`opencode/routes.js`'s `/api/behavior/agents-md`): no
// project-level editor exists to port, and Pi still reads a project's own
// `AGENTS.md` by itself (pi-contract 6.4) without OpenChamber's help.

import fs from 'node:fs';
import path from 'node:path';

import { buildAppliedResponse } from '../../opencode/config-mutation-response.js';
import { writeFileAtomic } from '../../opencode/atomic-write.js';
import { agentPaths, readJsonObject } from '../bridge/routes/pi-files.js';

const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const writeSettingsFile = async (filePath, mutate) => {
  const { value, error } = await readJsonObject(filePath);
  // A file that exists but cannot be parsed is never treated as empty: doing
  // so would silently drop whatever was in it the moment this writes.
  if (error) throw new Error(`${filePath} cannot be read (${error}). Fix the file first: OpenChamber does not overwrite settings it cannot parse`);
  const next = isObject(value) ? { ...value } : {};
  const changed = mutate(next);
  if (changed === false) return { changed: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true };
};

/**
 * `PUT /api/config/compaction`'s body: `auto` -> `compaction.enabled`,
 * `keepTokens` -> `compaction.keepRecentTokens`, both straight mappings.
 * `buffer` has no clean mapping: OpenCode's is either a token count or a
 * share of the model's context window (`"20%"`), and Pi's `reserveTokens` is
 * always an absolute count with no per-model percentage concept at write
 * time, so a percentage is refused rather than guessed against some
 * assumed window. `background` (OpenCode's `experimental.background_compaction`)
 * has no Pi feature behind it at all: accepted and not stored, so the
 * Settings checkbox does not show a hard failure, but it will never read
 * back checked either (see CONFIG-NOTES.md, "Compaction: the buffer and
 * background fields").
 */
export const applyCompactionUpdate = (current, update) => {
  const next = { ...current };
  if ('auto' in update) {
    next.enabled = Boolean(update.auto);
  }
  if ('keepTokens' in update) {
    next.keepRecentTokens = update.keepTokens === null ? undefined : update.keepTokens;
  }
  if ('buffer' in update) {
    if (typeof update.buffer === 'string') {
      throw Object.assign(new Error('Pi has no per-model percentage buffer; send a token count instead of a share like "20%"'), { code: 'UNSUPPORTED_BUFFER_SHARE' });
    }
    next.reserveTokens = update.buffer === null ? undefined : update.buffer;
  }
  // `background` is accepted and dropped: see the function comment.
  for (const key of ['enabled', 'keepRecentTokens', 'reserveTokens']) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
};

export const createCompactionSettings = ({ getAgentDir }) => ({
  get: async () => {
    const { value } = await readJsonObject(agentPaths(getAgentDir()).settings);
    const compaction = isObject(value?.compaction) ? value.compaction : {};
    return {
      auto: compaction.enabled !== false,
      keepTokens: typeof compaction.keepRecentTokens === 'number' ? compaction.keepRecentTokens : null,
      buffer: typeof compaction.reserveTokens === 'number' ? compaction.reserveTokens : null,
      background: false,
    };
  },
  set: async (update) => {
    const filePath = agentPaths(getAgentDir()).settings;
    const { value } = await readJsonObject(filePath);
    const currentCompaction = isObject(value?.compaction) ? value.compaction : {};
    const nextCompaction = applyCompactionUpdate(currentCompaction, update);
    return writeSettingsFile(filePath, (next) => {
      if (Object.keys(nextCompaction).length > 0) next.compaction = nextCompaction;
      else delete next.compaction;
    });
  },
});

/**
 * `false | null | "random" | "<provider id>"`, OpenChamber's own choice: Pi
 * has no built-in web search, so there is no config file to write it into.
 * Kept as one small JSON file beside the bridge's other per-install state.
 */
export const createWebSearchChoiceStore = ({ filePath }) => ({
  get: async () => {
    const { value } = await readJsonObject(filePath);
    const stored = value?.selection;
    return stored === false || stored === null || stored === 'random' || typeof stored === 'string' ? stored : null;
  },
  set: async (selection) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, `${JSON.stringify({ selection }, null, 2)}\n`);
  },
});

const parseWebSearchSelection = (value) => {
  if (value === false || value === null || value === 'random') return value;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {ReturnType<typeof createCompactionSettings>} deps.compaction
 * @param {ReturnType<typeof createWebSearchChoiceStore>} deps.webSearch
 * @param {() => Promise<boolean>} [deps.isWebAccessPackageInstalled]  Whether `pi-web-access` (or another declared web-search package) is configured; the packages agent owns installing it.
 * @param {() => string} deps.getAgentDir
 */
export const registerSettingsConfigRoutes = (app, { compaction, webSearch, isWebAccessPackageInstalled = async () => false, getAgentDir }) => {
  app.get('/api/config/compaction', async (_req, res) => {
    try {
      res.json(await compaction.get());
    } catch (error) {
      console.error('[config/settings] failed to read compaction settings:', error);
      res.status(500).json({ error: error.message || 'Failed to read compaction settings' });
    }
  });

  app.put('/api/config/compaction', async (req, res) => {
    try {
      const result = await compaction.set(req.body ?? {});
      res.json({ success: true, changed: result.changed });
    } catch (error) {
      if (error?.code === 'UNSUPPORTED_BUFFER_SHARE') return res.status(400).json({ error: error.message });
      console.error('[config/settings] failed to save compaction settings:', error);
      res.status(500).json({ error: error.message || 'Failed to save compaction settings' });
    }
  });

  app.get('/api/config/websearch', async (_req, res) => {
    try {
      const [selection, pluginInstalled] = await Promise.all([webSearch.get(), isWebAccessPackageInstalled().catch(() => false)]);
      res.json({ selection, pluginInstalled, projectPath: null });
    } catch (error) {
      console.error('[config/settings] failed to read the web search choice:', error);
      res.status(500).json({ error: error.message || 'Failed to read the web search choice' });
    }
  });

  app.put('/api/config/websearch', async (req, res) => {
    const selection = parseWebSearchSelection(req.body?.selection);
    if (selection === undefined) return res.status(400).json({ error: 'selection must be false, null, "random" or a provider id' });
    try {
      await webSearch.set(selection);
      res.json({ success: true, changed: true });
    } catch (error) {
      console.error('[config/settings] failed to save the web search choice:', error);
      res.status(500).json({ error: error.message || 'Failed to save the web search choice' });
    }
  });

  const agentsMdPath = () => path.join(getAgentDir(), 'AGENTS.md');

  app.get('/api/behavior/agents-md', async (_req, res) => {
    const target = agentsMdPath();
    try {
      try {
        await fs.promises.access(target);
      } catch {
        return res.json({ content: '', exists: false, path: target });
      }
      const content = await fs.promises.readFile(target, 'utf8');
      res.json({ content, exists: true, path: target });
    } catch (error) {
      console.error('[config/settings] failed to read AGENTS.md:', error);
      res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    const target = agentsMdPath();
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedContent')) {
        const expected = req.body.expectedContent;
        let current = null;
        try {
          current = await fs.promises.readFile(target, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== expected) {
          return res.status(409).json({ error: 'AGENTS.md changed on disk since it was loaded', code: 'AGENTS_MD_CONFLICT' });
        }
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, content);
      res.json(buildAppliedResponse('AGENTS.md saved.'));
    } catch (error) {
      console.error('[config/settings] failed to write AGENTS.md:', error);
      res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
