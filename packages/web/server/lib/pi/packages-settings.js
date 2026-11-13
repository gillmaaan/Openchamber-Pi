// Reading and writing Pi's settings.json from OpenChamber.
//
// `pi install` and `pi remove` write the `packages` list themselves. The rest
// (the enabled switch of a package, a filter, the override entries that switch
// an extension file off) is written here, and the file is the user's: every key
// OpenChamber does not own survives a write untouched.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { codedError } from './packages-sources.js';

export const RESOURCE_KEYS = ['extensions', 'skills', 'prompts', 'themes'];
/** Where the user's own filters wait while a package is switched off. */
const STASHED_FILTERS_KEY = 'openchamberFilters';

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const stripBom = (text) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<{ file: string, exists: boolean, data: Record<string, unknown>, error: string|null }>}
 *   `error` is set when the file exists but cannot be used; `data` is then `{}`.
 */
export const readSettingsFile = async (fs, file) => {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, data: {}, error: null };
    return { file, exists: true, data: {}, error: `Cannot read ${file}: ${error?.message ?? error}` };
  }
  // Pi reads an empty file as no settings.
  if (text === '') return { file, exists: true, data: {}, error: null };
  try {
    const parsed = JSON.parse(stripBom(text));
    if (!isRecord(parsed)) return { file, exists: true, data: {}, error: 'Expected a JSON object' };
    return { file, exists: true, data: parsed, error: null };
  } catch (error) {
    return { file, exists: true, data: {}, error: error?.message ?? String(error) };
  }
};

// Pi guards its settings writes with `proper-lockfile`: a `<file>.lock`
// directory, taken with an atomic `mkdir` and stale after 10 seconds. Taking
// the same lock keeps a write of ours from landing between Pi's read and write.
const acquireLock = async (fs, lockDir, { attempts = 100, delayMs = 20, staleMs = 10_000 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(delayMs);
    }
  }
  throw codedError('Pi settings are locked by another process. Try again in a moment', 'SETTINGS_LOCKED');
};

const writeAtomically = async (fs, file, text) => {
  let target = file;
  try {
    target = await fs.realpath(file);
  } catch {
    // The file does not exist yet.
  }
  // A settings file that is a symlink (a dotfiles repository) stays a symlink.
  const mode = await fs.stat(target).then((stat) => stat.mode & 0o777, () => 0o666);
  const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Writes to settings files, one at a time per file.
 *
 * `queue` runs a whole operation (a `pi install` and the checks around it)
 * exclusively per settings file: Pi saves the whole `packages` list it read, so
 * two installs into one file at the same time lose one of them. `write` is the
 * locked read-modify-write inside such an operation; `update` is both.
 */
export const createSettingsWriter = ({ fs }) => {
  const tails = new Map();

  const queue = (file, task) => {
    const key = path.resolve(file);
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };

  /**
   * @param {string} file
   * @param {(data: Record<string, unknown>) => boolean|void} mutate  Edits `data` in place; returns `false` for "nothing to change".
   * @returns {Promise<{ changed: boolean }>}
   */
  const write = async (file, mutate) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lockDir = `${file}.lock`;
    await acquireLock(fs, lockDir);
    try {
      const current = await readSettingsFile(fs, file);
      if (current.error) {
        throw codedError(`${file} cannot be read (${current.error}). Fix the file first: OpenChamber does not overwrite settings it cannot parse`, 'SETTINGS_INVALID');
      }
      const next = structuredClone(current.data);
      if (mutate(next) === false) return { changed: false };
      await writeAtomically(fs, file, `${JSON.stringify(next, null, 2)}\n`);
      return { changed: true };
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { queue, write, update: (file, mutate) => queue(file, () => write(file, mutate)) };
};

export const packageEntries = (data) => (Array.isArray(data.packages) ? data.packages : []);

/** The source string of a `packages` item, or null for an item Pi would not read. */
export const entrySource = (entry) => {
  if (typeof entry === 'string') return entry;
  return isRecord(entry) && typeof entry.source === 'string' ? entry.source : null;
};

/** The resource filters of an object entry: only arrays of strings count. */
export const filtersOf = (entry) => {
  if (!isRecord(entry)) return null;
  const filters = {};
  for (const key of RESOURCE_KEYS) {
    if (isStringArray(entry[key])) filters[key] = [...entry[key]];
  }
  return Object.keys(filters).length > 0 ? filters : null;
};

/** The "switched off" form: every resource type filtered down to nothing. */
export const isDisabledEntry = (entry) => isRecord(entry) && RESOURCE_KEYS.every((key) => Array.isArray(entry[key]) && entry[key].length === 0);

const collapse = (object) => (Object.keys(object).length === 1 ? object.source : object);

/**
 * The entry with its enabled switch changed.
 *
 * Off is `{ source, extensions: [], skills: [], prompts: [], themes: [] }`;
 * on is the plain source string. Filters the user wrote before switching off
 * move to `openchamberFilters` and come back when the package is switched on,
 * so a package the user narrowed to one extension does not load everything again.
 */
export const withEnabled = (entry, enabled) => {
  const object = typeof entry === 'string' ? { source: entry } : { ...entry };
  if (enabled) {
    if (!isDisabledEntry(object)) return entry;
    const stashed = isRecord(object[STASHED_FILTERS_KEY]) ? object[STASHED_FILTERS_KEY] : null;
    delete object[STASHED_FILTERS_KEY];
    for (const key of RESOURCE_KEYS) {
      delete object[key];
      if (stashed && isStringArray(stashed[key])) object[key] = stashed[key];
    }
    return collapse(object);
  }
  if (isDisabledEntry(object)) return entry;
  const own = filtersOf(object);
  for (const key of RESOURCE_KEYS) object[key] = [];
  if (own) object[STASHED_FILTERS_KEY] = own;
  else delete object[STASHED_FILTERS_KEY];
  return object;
};

/** The entry with its resource filters replaced (an empty record removes them). */
export const withFilters = (entry, filters) => {
  const object = typeof entry === 'string' ? { source: entry } : { ...entry };
  delete object[STASHED_FILTERS_KEY];
  for (const key of RESOURCE_KEYS) {
    if (filters[key]) object[key] = [...filters[key]];
    else delete object[key];
  }
  return collapse(object);
};

// Extension files are switched with `-path` / `+path` entries in the settings
// `extensions` list, relative to the folder the settings file lives in: the
// entries `pi config` writes.

const toPosix = (value) => value.split(path.sep).join('/');
const stripDotSlash = (value) => (value.startsWith('./') ? value.slice(2) : value);

// The patterns come from a settings file, and a project's file is not the user's:
// a glob is matched with a table walk (time proportional to pattern times path)
// and never compiled to a regular expression, which a crafted pattern can make
// backtrack for minutes. Patterns and paths beyond these bounds do not match.
const MAX_GLOB_LENGTH = 200;
const MAX_GLOB_PATTERNS = 200;
const MAX_PATH_LENGTH = 1024;

/** `**` crosses folders, `*` and `?` stay inside one. */
const globMatches = (glob, text) => {
  if (glob.length > MAX_GLOB_LENGTH || text.length > MAX_PATH_LENGTH) return false;
  const tokens = [];
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (tokens.at(-1)?.kind !== 'any') tokens.push({ kind: 'any' });
    } else if (char === '*') tokens.push({ kind: 'segment' });
    else if (char === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'literal', char });
  }
  let row = new Array(text.length + 1).fill(false);
  row[0] = true;
  for (const token of tokens) {
    const next = new Array(text.length + 1).fill(false);
    if (token.kind === 'literal' || token.kind === 'one') {
      for (let column = 1; column <= text.length; column += 1) {
        const char = text[column - 1];
        next[column] = row[column - 1] && (token.kind === 'one' ? char !== '/' : char === token.char);
      }
    } else {
      next[0] = row[0];
      for (let column = 1; column <= text.length; column += 1) {
        next[column] = row[column] || (next[column - 1] && (token.kind === 'any' || text[column - 1] !== '/'));
      }
    }
    row = next;
  }
  return row[text.length];
};

/** The pattern Pi uses for a file: its path relative to the settings folder. */
export const overrideTarget = (filePath, baseDir) => toPosix(path.relative(baseDir, filePath));

/** Pi's `isEnabledByOverrides` for one file: `!glob`, then `+exact`, then `-exact`. */
export const isEnabledByOverrides = (filePath, patterns, baseDir) => {
  const relative = overrideTarget(filePath, baseDir);
  const absolute = toPosix(filePath);
  const names = [relative, path.basename(filePath), absolute];
  const exact = (prefix) => patterns
    .filter((pattern) => pattern.startsWith(prefix))
    .map((pattern) => stripDotSlash(toPosix(pattern.slice(1))))
    .some((target) => target === relative || target === absolute);
  let enabled = true;
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .slice(0, MAX_GLOB_PATTERNS)
    .some((pattern) => names.some((name) => globMatches(toPosix(pattern.slice(1)), name)));
  if (excluded) enabled = false;
  if (exact('+')) enabled = true;
  if (exact('-')) enabled = false;
  return enabled;
};

/** The list without the `+path` / `-path` entries that name one of `filePaths`. */
export const withoutExtensionOverrides = (patterns, filePaths, baseDir) => {
  const targets = new Set(filePaths.map((filePath) => overrideTarget(filePath, baseDir)));
  return patterns.filter((pattern) => !((pattern[0] === '+' || pattern[0] === '-') && targets.has(stripDotSlash(toPosix(pattern.slice(1))))));
};

/** The `extensions` list after switching `filePaths` on or off, the way `pi config` writes it. */
export const withExtensionsEnabled = (patterns, filePaths, baseDir, enabled) => {
  const kept = withoutExtensionOverrides(patterns, filePaths, baseDir);
  if (enabled) {
    // A `+` entry is only needed when a glob exclusion still keeps the file off.
    for (const filePath of filePaths) {
      if (!isEnabledByOverrides(filePath, kept, baseDir)) kept.push(`+${overrideTarget(filePath, baseDir)}`);
    }
  } else {
    for (const filePath of filePaths) kept.push(`-${overrideTarget(filePath, baseDir)}`);
  }
  return kept;
};
