// Shared file-path and markdown helpers for the Pi config routes.
//
// Every entity this folder owns (agents, commands, skills) is a file under
// one of two roots: the global Pi agent directory, or a trusted project's
// `.pi/<kind>` folder. This module holds the one safe-name check, the atomic
// markdown read/write, and the global/project path resolution every store
// shares, so the four stores can't drift on what makes a name or a path safe.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import { writeFileAtomic } from '../../opencode/atomic-write.js';

/**
 * An entity name becomes `<dir>/<name>.md` or `<dir>/<name>/SKILL.md`. Express
 * decodes `%2F` in a route param, so a nested name (`group/name`) is fine; one
 * that climbs out of the directory, names an absolute path, or carries a
 * control character is not.
 */
export const isSafeEntityName = (name) => (
  typeof name === 'string'
  && name.length > 0
  && name.length <= 200
  && !/[\0\u0001-\u001f\\]/.test(name)
  && !path.isAbsolute(name)
  && name.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
);

/**
 * Resolves `candidate` (already joined under `root`) and refuses a path that
 * leaves `root` through a symlink. `root` itself must exist; `candidate`'s
 * final segment need not (a file not yet written).
 */
export const realUnderRoot = (root, candidate) => {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedParent = fs.realpathSync(path.dirname(candidate));
  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${candidate} is outside ${root}`);
  }
  return path.join(resolvedParent, path.basename(candidate));
};

const isFile = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
};

const isDirectory = (candidate) => {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
};

export { isFile, isDirectory };

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Pi's own frontmatter shape (`parseFrontmatter` in the SDK): `---\n<yaml>\n---`
 * at the very start of the file, the rest is the body. Unlike OpenCode's
 * reader this module stays lenient about YAML the same way: a block that
 * fails strict parsing is left as `{}` rather than throwing, so one odd file
 * does not take a whole listing down.
 */
export const parseMarkdown = (raw) => {
  const content = stripBom(raw);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: {}, body: content.trim() };
  let frontmatter;
  try {
    frontmatter = yaml.parse(match[1]) ?? {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: match[2].trim() };
};

export const readMarkdown = (filePath) => parseMarkdown(fs.readFileSync(filePath, 'utf8'));

/** Writes `---\n<yaml>\n---\n\n<body>` atomically; drops `null`/`undefined` frontmatter values. */
export const writeMarkdown = (filePath, frontmatter, body) => {
  const cleaned = Object.fromEntries(Object.entries(frontmatter ?? {}).filter(([, value]) => value !== null && value !== undefined));
  const yamlText = Object.keys(cleaned).length > 0 ? yaml.stringify(cleaned) : '';
  const content = yamlText ? `---\n${yamlText}---\n\n${body ?? ''}` : (body ?? '');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, content);
};

/**
 * Where a project's own copy of a resource kind lives, and whether reading or
 * writing it is allowed right now. A folder `isProjectTrusted` has not
 * approved is a folder Pi itself ignores for `.pi/*`, so a write there would
 * silently do nothing for the agent; callers refuse it instead of writing a
 * file nobody will ever read.
 *
 * @param {string} directory
 * @param {string} kind  `agents`, `prompts` or `skills`.
 */
export const projectDirFor = (directory, kind) => path.join(directory, '.pi', kind);

/** `true`/`false`/a rejected promise from `isProjectTrusted`; never throws. */
export const projectIsTrusted = async (isProjectTrusted, directory) => {
  try {
    return Boolean(await isProjectTrusted(directory));
  } catch {
    return false;
  }
};
