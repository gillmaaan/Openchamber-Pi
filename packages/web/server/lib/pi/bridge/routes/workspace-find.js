// `GET /api/fs/find`: the file search behind `@` mentions, the command palette
// and the file tree filter.
//
// Answer (OpenCode 2.2.6, probed): `{ location, data: [{ path, type }] }` with
// `path` relative to the request's folder (a directory ends in `/`), `type`
// `file` or `directory`, ranked by how well the query matches. `query` is
// required (an empty one lists the folder), `limit` is a positive integer
// (default 50) and `type` narrows the answer.
//
// What the search reads, in order of preference:
// 1. `git ls-files --cached --others --exclude-standard`: the files git knows
//    or would add, so `.gitignore` (and `.git/info/exclude`, the global ignore
//    file) apply exactly as git applies them;
// 2. ripgrep's file listing (`--files`, `.gitignore` honored without a
//    repository too), for a folder that is not a repository or whose git
//    cannot run;
// 3. a bounded directory walk that skips `.git` and `node_modules`, when there
//    is neither.
// Every listing is relative to the folder, so a path outside it never appears.
// Symlinks are listed as the names they are and never followed. The list is
// capped at `MAX_INDEXED_PATHS`, the answer at `MAX_LIMIT` entries, and a
// search whose client went away stops its child process.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { invalidRequest } from '../errors.js';
import { json, STREAMED } from '../http.js';
import { createRipgrepResolver } from '../../../fs/ripgrep.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_INDEXED_PATHS = 200_000;
const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BUFFER = 64 * 1024 * 1024;
const WALK_MAX_FILES = 50_000;
const WALK_MAX_DEPTH = 30;
const WALK_SKIPPED = new Set(['.git', 'node_modules']);

const queryError = (message, field) => invalidRequest(`${message}\n  at ["${field}"]`, { kind: 'Query' });

const toSlashes = (relative) => (path.sep === '/' ? relative : relative.split(path.sep).join('/'));

/** How well `candidate` (lower-cased, `/`-separated) matches `needle`: higher is better, null is no match. */
const scoreMatch = (needle, candidate) => {
  if (needle === '') return 0;
  const trimmed = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (name === needle) return 1000;
  if (name.startsWith(needle)) return 900;
  const inName = name.indexOf(needle);
  if (inName !== -1) return 800 - Math.min(inName, 50);
  const inPath = candidate.indexOf(needle);
  if (inPath !== -1) return 600 - Math.min(inPath, 50);

  let at = -1;
  let gaps = 0;
  let boundaries = 0;
  for (const char of needle) {
    const next = candidate.indexOf(char, at + 1);
    if (next === -1) return null;
    if (at !== -1) gaps += next - at - 1;
    if (next === 0 || '/._- '.includes(candidate[next - 1])) boundaries += 1;
    at = next;
  }
  return Math.max(1, 300 + boundaries * 20 - Math.min(gaps, 250));
};

const parentDirectories = (files) => {
  const directories = new Set();
  for (const file of files) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) directories.add(file.slice(0, slash + 1));
  }
  return directories;
};

const walk = async (root, signal) => {
  const files = [];
  const queue = [{ relative: '', depth: 0 }];
  while (queue.length > 0 && files.length < WALK_MAX_FILES) {
    signal?.throwIfAborted();
    const { relative, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIPPED.has(entry.name) && depth < WALK_MAX_DEPTH) queue.push({ relative: child, depth: depth + 1 });
      } else if (entry.isFile() && files.length < WALK_MAX_FILES) {
        files.push(child);
      }
    }
  }
  return files;
};

const listWithRipgrep = (binary, directory, signal) => new Promise((resolve, reject) => {
  execFile(binary, ['--files', '--null', '--hidden', '--no-require-git', '--glob', '!.git/'], {
    cwd: directory,
    signal,
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: LIST_MAX_BUFFER,
    encoding: 'utf8',
    windowsHide: true,
  }, (error, stdout) => (error ? reject(error) : resolve(stdout.split('\0').filter(Boolean).map(toSlashes))));
});

/**
 * @param {object} options
 * @param {(args: string[], options: object) => Promise<string>} options.runGit
 * @param {(message: string) => void} options.report
 * @param {() => Promise<string|null>} [options.resolveRipgrep]  The ripgrep binary, or null when there is none.
 */
export const createFileFinder = ({ runGit, report, resolveRipgrep = createRipgrepResolver({ fs, path }).resolveRipgrepBinary }) => {
  /** The files of `directory` as relative `/` paths, and whether the list was cut short. */
  const listFiles = async (directory, isRepository, signal) => {
    let files = null;
    if (isRepository) {
      try {
        const listed = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: directory, timeoutMs: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, signal });
        files = listed.split('\0').filter(Boolean);
      } catch (error) {
        if (signal?.aborted) throw error;
        report(`fs.find: git could not list ${directory}: ${error?.message ?? error}`);
      }
    }
    if (files === null) {
      try {
        const binary = await resolveRipgrep();
        if (binary) files = await listWithRipgrep(binary, directory, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        report(`fs.find: ripgrep could not list ${directory}: ${error?.message ?? error}`);
      }
    }
    if (files === null) files = await walk(directory, signal);
    return { files: files.slice(0, MAX_INDEXED_PATHS), truncated: files.length > MAX_INDEXED_PATHS };
  };

  /**
   * @param {string} directory
   * @param {{ query: string, type?: 'file'|'directory', limit: number, isRepository: boolean, signal?: AbortSignal }} request
   * @returns {Promise<Array<{ path: string, type: 'file'|'directory' }>>}
   */
  const find = async (directory, { query, type, limit, isRepository, signal }) => {
    const { files, truncated } = await listFiles(directory, isRepository, signal);
    if (truncated) report(`fs.find: ${directory} has more than ${MAX_INDEXED_PATHS} files; the search looks at the first ${MAX_INDEXED_PATHS}`);
    const needle = query.toLowerCase().replace(/\s+/g, '');

    const candidates = [];
    if (type !== 'directory') for (const file of files) candidates.push({ path: file, type: 'file' });
    if (type !== 'file') for (const folder of parentDirectories(files)) candidates.push({ path: folder, type: 'directory' });

    const scored = [];
    for (const candidate of candidates) {
      const score = scoreMatch(needle, candidate.path.toLowerCase());
      if (score !== null) scored.push({ ...candidate, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // A path git still lists but the disk no longer has is dropped.
    const top = scored.slice(0, limit);
    const alive = await Promise.all(top.map((entry) => (entry.type === 'directory'
      ? true
      : fs.promises.lstat(path.join(directory, entry.path)).then(() => true, () => false))));
    return top.filter((_, index) => alive[index]).map(({ path: relative, type: kind }) => ({ path: relative, type: kind }));
  };

  return { find };
};

const parseLimit = (text) => {
  if (text === null) return DEFAULT_LIMIT;
  const value = Number(text);
  if (!Number.isInteger(value)) throw queryError('Expected an integer', 'limit');
  if (value < 1) throw queryError('Expected a value greater than 0', 'limit');
  return Math.min(value, MAX_LIMIT);
};

/**
 * @param {object} deps
 * @param {(ctx: object) => { directory: string, project: { vcs?: string } }} deps.locate
 * @param {ReturnType<typeof createFileFinder>} deps.finder
 */
export const createFindRoutes = ({ locate, finder }) => [
  {
    method: 'GET',
    path: '/api/fs/find',
    handler: async (ctx) => {
      const query = ctx.query.get('query');
      if (query === null) throw queryError('Missing key', 'query');
      const type = ctx.query.get('type') ?? undefined;
      if (type !== undefined && type !== 'file' && type !== 'directory') throw queryError('Expected "file" | "directory"', 'type');
      const limit = parseLimit(ctx.query.get('limit'));
      const { directory, project } = locate(ctx);

      // A client that moved on (a new letter) ends the search and its child process.
      const controller = new AbortController();
      ctx.res.once('close', () => controller.abort());
      try {
        const data = await finder.find(directory, { query, type, limit, isRepository: project.vcs === 'git', signal: controller.signal });
        return json({ location: { directory }, data });
      } catch (error) {
        // Nobody is left to read an answer.
        if (controller.signal.aborted) return STREAMED;
        throw error;
      }
    },
  },
];
