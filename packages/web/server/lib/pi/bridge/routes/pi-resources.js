// Skills and prompt templates of a folder, found the way Pi finds them.
//
// The per-directory scan of a skill folder is Pi's own `loadSkillsFromDir`
// (ignore files, symlinks, name and description rules, "a SKILL.md ends the
// recursion"), and frontmatter is Pi's `parseFrontmatter`, so the list agrees
// with what a Pi session of the same folder loads. What this module adds is the
// choice of folders, which Pi makes inside its package manager and does not
// export (`collectAncestorAgentsSkillDirs`, `resolve()` in package-manager.js).
//
// Order and collisions follow Pi: project folders before user folders, and on
// a name collision the first one wins.
//
// Project folders (`.pi/skills`, `.pi/prompts`, `.agents/skills`) are
// trust-gated in Pi; a caller that has decided a project is untrusted passes
// `includeProject: false`.
//
// Not covered: skills and prompts a package or the `skills`/`prompts` settings
// add. They need Pi's package manager (npm and git installs) to resolve.

import fs from 'node:fs';
import path from 'node:path';

import { resolveProject } from '../project.js';

const AGENTS_SKILLS = path.join('.agents', 'skills');
const PROMPT_DESCRIPTION_LIMIT = 60;

const isFile = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
};

const realPathOf = (candidate) => {
  try { return fs.realpathSync(candidate); } catch { return candidate; }
};

/**
 * `.agents/skills` of the folder and each ancestor up to the repository root
 * (without a repository, up to the filesystem root), nearest first.
 */
export const ancestorAgentsSkillDirs = (directory) => {
  const project = resolveProject(directory);
  const stop = project.vcs ? project.root : null;
  const dirs = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    dirs.push(path.join(current, AGENTS_SKILLS));
    if (current === stop || path.dirname(current) === current) break;
  }
  return dirs;
};

/**
 * @param {object} options
 * @param {() => Promise<typeof import('@earendil-works/pi-coding-agent')>} options.loadSdk
 * @param {() => string} options.getHomeDir
 * @param {(key: string, message: string | null) => void} options.report
 */
export const createResourceScanner = ({ loadSdk, getHomeDir, report }) => {
  let sdkPromise = null;
  const sdk = () => {
    sdkPromise ??= loadSdk().catch((error) => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
  };

  /**
   * @param {object} options
   * @param {string} options.agentDir
   * @param {string} options.directory
   * @param {boolean} options.includeProject
   */
  const skills = async ({ agentDir, directory, includeProject }) => {
    const pi = await sdk();
    const userAgentsDir = path.join(getHomeDir(), AGENTS_SKILLS);
    const sources = [
      ...(includeProject
        ? [
            { dir: path.join(directory, '.pi', 'skills'), source: 'project', agentsLayout: false },
            ...ancestorAgentsSkillDirs(directory)
              .filter((dir) => path.resolve(dir) !== path.resolve(userAgentsDir))
              .map((dir) => ({ dir, source: 'project', agentsLayout: true })),
          ]
        : []),
      { dir: path.join(agentDir, 'skills'), source: 'user', agentsLayout: false },
      { dir: userAgentsDir, source: 'user', agentsLayout: true },
    ];

    const found = new Map();
    const seenFiles = new Set();
    for (const { dir, source, agentsLayout } of sources) {
      const result = pi.loadSkillsFromDir({ dir, source });
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.type === 'warning') report(`skill:${diagnostic.path}:${diagnostic.message}`, `Skill ${diagnostic.path}: ${diagnostic.message}`);
      }
      for (const skill of result.skills) {
        // A `.agents/skills` folder takes no loose Markdown files, only skill folders.
        if (agentsLayout && path.basename(skill.filePath) !== 'SKILL.md' && path.dirname(skill.filePath) === dir) continue;
        const realPath = realPathOf(skill.filePath);
        if (seenFiles.has(realPath) || found.has(skill.name)) continue;
        let raw;
        try {
          raw = fs.readFileSync(skill.filePath, 'utf8');
        } catch (error) {
          report(`skill:${skill.filePath}:read`, `Skill ${skill.filePath} cannot be read: ${error.message}`);
          continue;
        }
        seenFiles.add(realPath);
        found.set(skill.name, {
          id: skill.name,
          name: skill.name,
          description: skill.description,
          ...(skill.disableModelInvocation ? { autoinvoke: false } : {}),
          path: skill.filePath,
          content: pi.stripFrontmatter(raw),
        });
      }
    }
    return [...found.values()];
  };

  /** Keep the editor's nested command names; do not follow directory symlinks or cycles. */
  const promptsIn = (pi, dir, prefix = '') => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const templates = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        templates.push(...promptsIn(pi, file, `${prefix}${entry.name}/`));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (!(entry.isFile() || (entry.isSymbolicLink() && isFile(file)))) continue;
      try {
        const { frontmatter, body } = pi.parseFrontmatter(fs.readFileSync(file, 'utf8'));
        let description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
        if (!description) {
          const firstLine = body.split('\n').find((line) => line.trim());
          if (firstLine) {
            description = firstLine.slice(0, PROMPT_DESCRIPTION_LIMIT);
            if (firstLine.length > PROMPT_DESCRIPTION_LIMIT) description += '...';
          }
        }
        templates.push({ name: `${prefix}${entry.name.replace(/\.md$/, '')}`, description });
      } catch (error) {
        report(`prompt:${file}`, `Prompt template ${file} is skipped: ${error.message}`);
      }
    }
    return templates;
  };

  /** Prompt templates as `{ name, description }`: project folder first, then `<agentDir>/prompts`. */
  const prompts = async ({ agentDir, directory, includeProject }) => {
    const pi = await sdk();
    const found = new Map();
    const dirs = [...(includeProject ? [path.join(directory, '.pi', 'prompts')] : []), path.join(agentDir, 'prompts')];
    for (const dir of dirs) {
      for (const template of promptsIn(pi, dir)) {
        if (!found.has(template.name)) found.set(template.name, template);
      }
    }
    return [...found.values()];
  };

  return { skills, prompts };
};
