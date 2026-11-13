// `GET /api/vcs/status`, `/api/vcs/diff`, `/api/vcs/base` and `POST /api/vcs/init`:
// the review views of a repository, answered from `git`.
//
// What OpenCode 2.2.6 answers (probed on an isolated `opencode serve`):
// - status: `{ location, data: [{ file, additions, deletions, status }] }`, the
//   working tree against HEAD, untracked files included as "added". A folder
//   outside a repository is `[]`.
// - diff: the same files with their `patch`. `mode` is required: `working` (HEAD
//   against the working tree), `branch` (merge base with the base branch against
//   the working tree) and `committed` (merge base against HEAD, no working tree).
//   `untracked=folders` lists a wholly untracked folder as one `dir/` entry.
//   An unknown `base` is a 503 `ServiceUnavailableError` "No merge base available
//   for <base>".
// - base: `{ name, ref, source }`: the default branch (`default`) on the default
//   branch, the branch the current one was created from (`reflog`, read from
//   `branch: Created from X`) elsewhere, `null` without a repository or commit,
//   and a 503 "Choose a review base" when neither is known.
// - Paths are relative to the repository root, limited to the request's folder.
// - init: plain `git init` (the user's `init.defaultBranch` applies); 409 when the
//   folder already has version control, 503 `VCS initialization failed` when
//   git fails or the provider is not git.
//
// Untracked files reach git through a copy of the index with intent-to-add
// entries (`GIT_INDEX_FILE`), so the repository's own index is never written
// and the patches are git's own.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { conflict, invalidRequest, serviceUnavailable } from '../errors.js';
import { json, noContent } from '../http.js';
import { createGitInfo } from './git-info.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Untracked files read into a review; the rest are left out and logged. */
const MAX_UNTRACKED_FILES = 500;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Runs `git <args>` and resolves with stdout; rejects on a non-zero exit (the
 * error's `code` is the exit status and `stderr` its text), a missing git or
 * the timeout. This is the default of `deps.runGit`, which must accept the same
 * options.
 *
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number, maxBuffer?: number, env?: Record<string,string>, input?: string|Buffer, signal?: AbortSignal }} options
 */
export const runGitCommand = (args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_OUTPUT_BYTES, env, input, signal }) => new Promise((resolve, reject) => {
  const child = execFile('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
    signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

const firstLine = (error) => String(error?.stderr || error?.message || error).trim().split('\n')[0];

const queryError = (message, field) => invalidRequest(`${message}\n  at ["${field}"]`, { kind: 'Query' });

/** `adds\tdels\tpath\0` rows of `git diff --numstat -z --no-renames`; a binary file counts 0 and 0. */
const parseNumstat = (text) => {
  const rows = [];
  for (const row of text.split('\0')) {
    const first = row.indexOf('\t');
    const second = row.indexOf('\t', first + 1);
    if (first === -1 || second === -1) continue;
    const added = row.slice(0, first);
    const removed = row.slice(first + 1, second);
    rows.push({ file: row.slice(second + 1), additions: added === '-' ? 0 : Number(added), deletions: removed === '-' ? 0 : Number(removed) });
  }
  return rows;
};

/** `X\0path\0` pairs of `git diff --name-status -z --no-renames`. */
const parseNameStatus = (text) => {
  const fields = text.split('\0').filter((field) => field !== '');
  const codes = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) codes.set(fields[index + 1], fields[index][0]);
  return codes;
};

const statusOfCode = (code) => (code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');

/** One patch per file of a `git diff` text, each from its `diff --git` line to the next. */
const splitPatches = (text) => {
  const marker = 'diff --git ';
  const starts = text.startsWith(marker) ? [0] : [];
  // Content lines carry a prefix (` `, `+`, `-`), so a line that opens with the marker is a file header.
  for (let at = text.indexOf(`\n${marker}`); at !== -1; at = text.indexOf(`\n${marker}`, at + 1)) starts.push(at + 1);
  return starts.map((begin, index) => text.slice(begin, starts[index + 1] ?? text.length));
};

const statusOfPatch = (patch) => {
  const hunk = patch.indexOf('\n@@');
  const header = hunk === -1 ? patch : patch.slice(0, hunk);
  if (/^new file mode/m.test(header)) return 'added';
  if (/^deleted file mode/m.test(header)) return 'deleted';
  return 'modified';
};

const folderEntry = (file) => ({
  file,
  patch: `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n`,
  additions: 0,
  deletions: 0,
  status: 'added',
});

/**
 * @param {object} options
 * @param {(args: string[], options: object) => Promise<string>} options.runGit
 * @param {string} options.tmpDir  Where the index copy of a working-tree review lives for a moment.
 * @param {(message: string) => void} options.report
 */
export const createGitReviews = ({ runGit, tmpDir, report }) => {
  const info = createGitInfo({ runGit, report });

  /** A command whose failure is a failure of the answer. */
  const git = async (directory, args, options = {}) => {
    try {
      return await runGit(args, { cwd: directory, ...options });
    } catch (error) {
      throw serviceUnavailable(`git failed: ${firstLine(error)}`, 'vcs');
    }
  };

  /** A command whose non-zero exit is itself an answer: the trimmed output, or null. */
  const probe = async (directory, args) => {
    try {
      return (await runGit(args, { cwd: directory })).trim();
    } catch (error) {
      if (typeof error?.code === 'number') return null;
      throw serviceUnavailable(`git failed: ${firstLine(error)}`, 'vcs');
    }
  };

  const hasCommit = async (directory) => (await probe(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) !== null;

  const branchRef = async (directory, name) => {
    if ((await probe(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) !== null) return `refs/heads/${name}`;
    if ((await probe(directory, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`])) !== null) return `refs/remotes/origin/${name}`;
    return null;
  };

  /** `data` of `GET /api/vcs/base`. */
  const baseOf = async (directory) => {
    if (!(await hasCommit(directory))) return null;
    const { branch } = await info.info(directory, true);
    const defaultName = branch.default ?? null;
    if (!branch.current || branch.current === defaultName) {
      const ref = defaultName ? await branchRef(directory, defaultName) : null;
      return ref ? { name: defaultName, ref, source: 'default' } : null;
    }
    const reflog = await probe(directory, ['reflog', 'show', '--format=%gs', `refs/heads/${branch.current}`]);
    const origin = (reflog ?? '').split('\n').reverse().map((line) => /^branch: Created from (.+)$/.exec(line)?.[1]).find(Boolean);
    if (origin && origin !== 'HEAD' && origin !== branch.current) {
      const ref = await branchRef(directory, origin);
      if (ref) return { name: origin, ref, source: 'reflog' };
    }
    throw serviceUnavailable('Choose a review base', 'vcs');
  };

  /** The commit a `branch` or `committed` review starts from. */
  const mergeBaseOf = async (directory, requested) => {
    let target = requested ?? (await info.info(directory, true)).branch.default ?? null;
    if (target === null) return (await probe(directory, ['rev-parse', 'HEAD'])) ?? EMPTY_TREE;
    if (requested && (await probe(directory, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`])) === null) {
      throw serviceUnavailable(`No merge base available for ${requested}`, 'vcs');
    }
    const base = await probe(directory, ['merge-base', 'HEAD', target]);
    if (!base) throw serviceUnavailable(`No merge base available for ${target}`, 'vcs');
    return base;
  };

  /** Untracked files (and, with `folders`, wholly untracked folders) of the request's folder. */
  const untrackedOf = async (directory, folders) => {
    const listed = (await git(directory, ['ls-files', '-z', '--others', '--exclude-standard', ...(folders ? ['--directory'] : [])])).split('\0').filter(Boolean);
    const collapsed = listed.filter((entry) => entry.endsWith('/'));
    const candidates = listed.filter((entry) => !entry.endsWith('/'));
    const files = [];
    for (const file of candidates) {
      if (files.length >= MAX_UNTRACKED_FILES) break;
      try {
        const stat = await fs.promises.lstat(path.join(directory, file));
        if (stat.isFile() && stat.size <= MAX_UNTRACKED_FILE_BYTES) files.push(file);
      } catch { /* gone since the listing */ }
    }
    if (files.length < candidates.length) {
      report(`vcs: ${candidates.length - files.length} untracked file(s) in ${directory} are left out of the review (over ${MAX_UNTRACKED_FILES} files, or ${MAX_UNTRACKED_FILE_BYTES} bytes each)`);
    }
    return { files, collapsed };
  };

  /**
   * Runs `work(env, collapsed)` with an index that lists the untracked files as
   * intent-to-add, so `git diff` shows them as new files. Without untracked
   * files `env` is empty and the repository's own index is read.
   */
  const withUntracked = async (directory, { folders = false } = {}, work) => {
    const { files, collapsed } = await untrackedOf(directory, folders);
    if (files.length === 0) return work({}, collapsed);
    const copyDirectory = await fs.promises.mkdtemp(path.join(tmpDir, 'openchamber-index-'));
    const indexFile = path.join(copyDirectory, 'index');
    try {
      const own = (await git(directory, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
      await fs.promises.copyFile(own, indexFile).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      await git(directory, ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env: { GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: '1' },
        input: files.join('\0'),
      });
      return await work({ GIT_INDEX_FILE: indexFile }, collapsed);
    } finally {
      await fs.promises.rm(copyDirectory, { recursive: true, force: true });
    }
  };

  /** `data` of `GET /api/vcs/status`. */
  const status = async (directory) => {
    const base = (await hasCommit(directory)) ? 'HEAD' : EMPTY_TREE;
    return withUntracked(directory, {}, async (env) => {
      const [counts, names] = await Promise.all([
        git(directory, ['diff', base, '--numstat', '-z', '--no-renames', '--no-ext-diff', '--', '.'], { env }),
        git(directory, ['diff', base, '--name-status', '-z', '--no-renames', '--no-ext-diff', '--', '.'], { env }),
      ]);
      const codes = parseNameStatus(names);
      return parseNumstat(counts).map((row) => ({ ...row, status: statusOfCode(codes.get(row.file)) }));
    });
  };

  /** Files and patches of `git diff <revisions>` under the request's folder. */
  const read = async (directory, revisions, env, context) => {
    const flags = ['--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...(context === null ? [] : [`-U${context}`])];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [text, counts] = await Promise.all([
        git(directory, ['diff', ...revisions, ...flags, '--', '.'], { env }),
        git(directory, ['diff', ...revisions, '--numstat', '-z', '--no-renames', '--no-ext-diff', '--', '.'], { env }),
      ]);
      const patches = splitPatches(text);
      const rows = parseNumstat(counts);
      // A file that changed between the two reads: read again once.
      if (patches.length === rows.length) {
        return rows.map((row, index) => ({ ...row, patch: patches[index], status: statusOfPatch(patches[index]) }));
      }
    }
    throw serviceUnavailable('The working tree changed while it was read', 'vcs');
  };

  /** `data` of `GET /api/vcs/diff`. */
  const diff = async (directory, { mode, base, context, untracked }) => {
    const hasHead = await hasCommit(directory);
    if (mode === 'committed') return hasHead ? read(directory, [await mergeBaseOf(directory, base), 'HEAD'], {}, context) : [];

    const start = !hasHead ? EMPTY_TREE : mode === 'working' ? 'HEAD' : await mergeBaseOf(directory, base);
    return withUntracked(directory, { folders: untracked === 'folders' }, async (env, collapsed) => {
      const files = await read(directory, [start], env, context);
      if (collapsed.length === 0) return files;
      const prefix = (await git(directory, ['rev-parse', '--show-prefix'])).trim();
      return [...files, ...collapsed.map((entry) => folderEntry(`${prefix}${entry}`))]
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    });
  };

  /** `git init`; the branch HEAD points at afterwards, or null. */
  const initialize = async (directory) => {
    try {
      await runGit(['init', '--quiet'], { cwd: directory });
    } catch (error) {
      report(`git init failed in ${directory}: ${firstLine(error)}`);
      throw serviceUnavailable('VCS initialization failed', 'git');
    }
    return probe(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  };

  return { status, diff, baseOf, initialize };
};

const parseContext = (text) => {
  if (text === null) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) throw queryError('Expected an integer', 'context');
  if (value < 0) throw queryError('Expected a value greater than or equal to 0', 'context');
  return value;
};

/** A branch or commit name that cannot be read as an option or a pathspec. */
const parseBase = (text) => {
  if (text === null) return undefined;
  if (text === '' || text.startsWith('-') || /[\s\0]/.test(text)) throw queryError('Expected a branch or commit name', 'base');
  return text;
};

/**
 * @param {object} deps
 * @param {(ctx: object) => { directory: string, project: { vcs?: string } }} deps.locate
 * @param {(type: string, data: object, directory: string) => void} deps.emit
 * @param {ReturnType<typeof createGitReviews>} deps.reviews
 */
export const createVcsRoutes = ({ locate, emit, reviews }) => {
  const located = (read) => async (ctx) => {
    const location = locate(ctx);
    return json({ location: { directory: location.directory }, data: await read(location, ctx) });
  };

  return [
    { method: 'GET', path: '/api/vcs/status', handler: located(({ directory, project }) => (project.vcs === 'git' ? reviews.status(directory) : [])) },
    { method: 'GET', path: '/api/vcs/base', handler: located(({ directory, project }) => (project.vcs === 'git' ? reviews.baseOf(directory) : null)) },
    {
      method: 'GET',
      path: '/api/vcs/diff',
      handler: located(({ directory, project }, ctx) => {
        const mode = ctx.query.get('mode');
        if (mode === null) throw queryError('Missing key', 'mode');
        if (!['working', 'branch', 'committed'].includes(mode)) throw queryError('Expected Vcs.Mode', 'mode');
        const untracked = ctx.query.get('untracked') ?? 'files';
        if (!['files', 'folders'].includes(untracked)) throw queryError('Expected Vcs.Untracked', 'untracked');
        const context = parseContext(ctx.query.get('context'));
        const base = parseBase(ctx.query.get('base'));
        return project.vcs === 'git' ? reviews.diff(directory, { mode, base, context, untracked }) : [];
      }),
    },
    {
      method: 'POST',
      path: '/api/vcs/init',
      handler: async (ctx) => {
        const { directory, project } = locate(ctx);
        if (project.vcs === 'git') throw conflict('Project already has version control', directory);
        const provider = ctx.query.get('provider') ?? 'git';
        if (provider !== 'git') throw serviceUnavailable('VCS initialization failed', provider);
        const branch = await reviews.initialize(directory);
        if (branch) emit('vcs.branch.updated', { branch }, directory);
        return noContent();
      },
    },
  ];
};
