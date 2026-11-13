// Work tree snapshots for revert and per-turn diffs.
//
// OpenCode kept a private git repository per project and recorded the work tree
// around every step. This does the same with `git` and a bare repository under
// `<dataDir>/pi/snapshots/<projectID>`, addressed only through `--git-dir`,
// `--work-tree` and a private `GIT_INDEX_FILE`: the user's own repository, its
// index and its refs are never read for content or written.
//
// A snapshot is a tree hash (`git add -A` into the private index, then
// `git write-tree`). `.gitignore`, the repository's `info/exclude` and the
// user's global excludes decide what a snapshot holds, so ignored files (a
// `.env`, build output) are neither copied into the private repository nor
// touched by a restore. Files are paths relative to the session's folder.
//
// Every git process runs with a deadline and a bounded output. A snapshot that
// fails or times out is "no snapshot", never a wrong one.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { unknownError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESTORE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_CHARS = 400_000;
const GIT_CONFIG = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'core.symlinks=true',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
  '-c', 'advice.addEmbeddedRepo=false',
];

export class SnapshotError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SnapshotError';
  }
}

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

const gitEnv = (base, extra) => {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    // Another repository's settings in the environment must never steer a snapshot.
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extra };
};

/** One git process: bounded time and output, stdout as a Buffer. */
const runGit = ({ gitBin, args, env, cwd, input, timeoutMs, maxBytes = MAX_OUTPUT_BYTES }) => new Promise((resolve, reject) => {
  const child = spawn(gitBin, [...GIT_CONFIG, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const err = [];
  let size = 0;
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn(value);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(reject, new SnapshotError(`git ${args[0] ?? ''} did not finish in ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  child.on('error', (error) => finish(reject, Object.assign(new SnapshotError(`could not run git: ${error.message}`, { cause: error }), { missing: error.code === 'ENOENT' })));
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      child.kill('SIGKILL');
      finish(reject, new SnapshotError(`git ${args[0] ?? ''} produced more than ${maxBytes} bytes`));
      return;
    }
    out.push(chunk);
  });
  child.stderr.on('data', (chunk) => { if (err.reduce((total, part) => total + part.length, 0) < 16_384) err.push(chunk); });
  child.on('close', (code) => finish(resolve, { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').trim() }));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** `foo/bar` as a safe relative path inside the folder, or null. */
const safeRelative = (file) => {
  if (typeof file !== 'string' || file === '' || /[\0\n]/.test(file)) return null;
  const normalized = path.posix.normalize(file.split(path.sep).join('/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split('/').includes('.git')) return null;
  return normalized;
};

const countPatch = (patch) => {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) additions += 1;
    else if (inHunk && line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
};

const STATUS = { A: 'added', D: 'deleted' };

/** Where git keeps `info/exclude` for the repository at `root` (a worktree's `.git` is a file that points at it). */
const userExcludeFile = (root) => {
  try {
    const dotGit = path.join(root, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return path.join(dotGit, 'info', 'exclude');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    const gitdir = path.resolve(root, match[1]);
    let common = gitdir;
    try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
    return path.join(common, 'info', 'exclude');
  } catch {
    return null;
  }
};

/**
 * @param {object} options
 * @param {string} options.rootDir  Where the private repositories live (`<dataDir>/pi/snapshots`).
 * @param {string} [options.gitBin]
 * @param {() => Record<string, string|undefined>} [options.getEnv]  The environment git runs in.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.restoreTimeoutMs]
 * @param {(message: string) => void} [options.log]
 */
export const createSnapshotStore = ({
  rootDir,
  gitBin = 'git',
  getEnv = () => process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  restoreTimeoutMs = DEFAULT_RESTORE_TIMEOUT_MS,
  log = () => {},
}) => {
  let available = true;
  /** projectID -> Promise of the private repository directory. */
  const repos = new Map();
  /** index file -> tail of the work queued on it: one git writer per index. */
  const queues = new Map();

  const git = async ({ args, repo, root, index, input, timeout = timeoutMs, maxBytes, cwd }) => {
    const env = gitEnv(getEnv(), {
      GIT_DIR: repo,
      ...(root ? { GIT_WORK_TREE: root } : {}),
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    });
    try {
      return await runGit({ gitBin, args, env, cwd: cwd ?? root ?? repo, input, timeoutMs: timeout, maxBytes });
    } catch (error) {
      if (error?.missing) available = false;
      throw error;
    }
  };

  const mustSucceed = (result, what) => {
    if (result.code !== 0) throw new SnapshotError(`${what} failed (${result.code}): ${result.stderr.slice(0, 300)}`);
    return result;
  };

  const ensureRepo = (projectID) => {
    let ready = repos.get(projectID);
    if (!ready) {
      const repo = path.join(rootDir, projectID);
      ready = (async () => {
        if (!fs.existsSync(path.join(repo, 'HEAD'))) {
          await fs.promises.mkdir(repo, { recursive: true });
          const env = gitEnv(getEnv(), {});
          const result = await runGit({ gitBin, args: ['init', '--bare', '--quiet', repo], env, cwd: rootDir, timeoutMs }).catch((error) => {
            if (error?.missing) available = false;
            throw error;
          });
          mustSucceed(result, 'git init');
        }
        return repo;
      })();
      // A failed init is not remembered: the next call tries again.
      ready.catch(() => repos.delete(projectID));
      repos.set(projectID, ready);
    }
    return ready;
  };

  const serialized = (key, work) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(work);
    const tail = run.then(() => {}, () => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  };

  const indexFor = (repo, root, subpath) => path.join(repo, `index-${sha1(`${root}\0${subpath ?? ''}`).slice(0, 16)}`);

  /**
   * The work tree of `directory` as a tree hash, or null when no snapshot can
   * be made (no git, a timeout, an unreadable folder). `root` is the project
   * root (the folder with `.git`), `subpath` the session folder below it.
   */
  const track = async ({ projectID, root, subpath }) => {
    if (!available) return null;
    try {
      const repo = await ensureRepo(projectID);
      const index = indexFor(repo, root, subpath);
      return await serialized(index, async () => {
        // The repository's own `info/exclude` still applies to a private repository's snapshot.
        const source = userExcludeFile(root);
        await fs.promises.mkdir(path.join(repo, 'info'), { recursive: true });
        const exclude = source ? await fs.promises.readFile(source, 'utf8').catch(() => '') : '';
        await fs.promises.writeFile(path.join(repo, 'info', 'exclude'), exclude);

        const add = await git({ args: ['add', '-A', '--ignore-errors', '--', subpath || '.'], repo, root, index });
        // `--ignore-errors` still exits 1 for files it could not read; anything above that is fatal.
        if (add.code !== 0 && add.code !== 1) throw new SnapshotError(`git add failed (${add.code}): ${add.stderr.slice(0, 300)}`);
        const tree = mustSucceed(await git({ args: ['write-tree'], repo, root, index }), 'git write-tree').stdout.toString('utf8').trim();
        return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
      });
    } catch (error) {
      log(`snapshot of ${root} failed: ${error?.message ?? error}`);
      return null;
    }
  };

  const relativeArgs = (subpath) => (subpath ? [`--relative=${subpath}`] : []);

  /** Files that differ between two snapshots: `[{ file, status }]`, paths relative to the session folder. */
  const changedFiles = async ({ projectID, subpath, from, to }) => {
    const repo = await ensureRepo(projectID);
    const result = mustSucceed(await git({
      args: ['diff-tree', '-r', '--no-renames', '--name-status', '-z', ...relativeArgs(subpath), from, to],
      repo,
    }), 'git diff-tree');
    const parts = result.stdout.toString('utf8').split('\0');
    const files = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const code = parts[index];
      const file = parts[index + 1];
      if (!code || !file) continue;
      files.push({ file, status: STATUS[code[0]] ?? 'modified' });
    }
    return files;
  };

  /**
   * The per-file diff between two snapshots, as OpenCode's `FileDiff`. `files`
   * limits it to those paths; a patch larger than the cap is replaced by a
   * header that says so, a binary file has no hunks and counts no lines.
   */
  const diff = async ({ projectID, subpath, from, to, files, context = 3 }) => {
    const wanted = files ? new Set(files) : null;
    const names = (await changedFiles({ projectID, subpath, from, to })).filter((entry) => !wanted || wanted.has(entry.file));
    if (names.length === 0) return [];
    const repo = await ensureRepo(projectID);
    const result = mustSucceed(await git({
      args: ['diff', '--no-ext-diff', '--no-color', '--no-renames', `-U${context}`, ...relativeArgs(subpath), from, to],
      repo,
    }), 'git diff');
    const patches = new Map();
    let currentFile = null;
    let currentLines = [];
    const flush = () => { if (currentFile !== null) patches.set(currentFile, currentLines.join('\n')); };
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const header = /^diff --git a\/(.+) b\/\1$/.exec(line);
      if (header) {
        flush();
        currentFile = header[1];
        currentLines = [line];
      } else if (currentFile !== null) {
        currentLines.push(line);
      }
    }
    flush();
    return names.map(({ file, status }) => {
      let patch = patches.get(file) ?? '';
      if (patch !== '' && !patch.endsWith('\n')) patch += '\n';
      const counts = countPatch(patch);
      if (patch.length > MAX_PATCH_CHARS) {
        patch = `${patch.split('\n').slice(0, 4).join('\n')}\n(the diff of this file is too large to show)\n`;
      }
      return { file, patch, ...counts, status };
    });
  };

  /** Resolve a destination below `cwd` and make sure no symlink on the way leads out of it. */
  const destinationFor = (cwdReal, file) => {
    const relative = safeRelative(file);
    if (!relative) throw new SnapshotError(`Refusing to restore a path outside the folder: ${file}`);
    const destination = path.join(cwdReal, ...relative.split('/'));
    let ancestor = path.dirname(destination);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = fs.realpathSync(ancestor);
    if (real !== cwdReal && !real.startsWith(cwdReal + path.sep)) throw new SnapshotError(`Refusing to restore through a link that leaves the folder: ${file}`);
    return { relative, destination };
  };

  const lstat = (target) => fs.promises.lstat(target).catch((error) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error)));

  /** Copy a file or recreate a link at `to`, through a temp name in the same folder and a rename. */
  const place = async (from, to, stat) => {
    const tmp = `${to}.oc-restore-${randomBytes(4).toString('hex')}`;
    try {
      if (stat.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(from), tmp);
      else {
        await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(tmp, stat.mode & 0o7777);
      }
      await fs.promises.rename(tmp, to);
    } catch (error) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  /**
   * Bring files of the work tree to their content in a snapshot, all or
   * nothing. `plan` maps a path (relative to the session folder) to the
   * snapshot it should match: present there, the file is written; absent, it
   * is deleted. Files are checked out of the snapshots into a staging folder
   * first, the files they replace are backed up, and then each is swapped in
   * by rename. A failure part way puts every swapped file back from its
   * backup and throws; only when that fails too the backup folder is kept and
   * the error says so.
   *
   * @returns {Promise<string[]>} The files that changed.
   */
  const restore = async ({ projectID, root, subpath, directory, plan }) => {
    if (!available) throw new SnapshotError('git is not available');
    const repo = await ensureRepo(projectID);
    const cwdReal = fs.realpathSync(directory);
    const staging = path.join(repo, 'staging', randomBytes(6).toString('hex'));
    const backupDir = path.join(staging, 'backup');
    await fs.promises.mkdir(backupDir, { recursive: true });
    const applied = [];
    const createdDirs = [];
    let keepStaging = false;
    try {
      // 1. Check every snapshot's files out into staging.
      const byTree = new Map();
      for (const [file, tree] of plan) {
        const { relative } = destinationFor(cwdReal, file);
        byTree.set(tree, [...(byTree.get(tree) ?? []), relative]);
      }
      const staged = new Map();
      let treeIndex = 0;
      for (const [tree, files] of byTree) {
        const tmpIndex = path.join(staging, `index-${treeIndex}`);
        const prefix = path.join(staging, `tree-${treeIndex}`) + path.sep;
        treeIndex += 1;
        const names = files.map((file) => path.posix.join(subpath ? subpath.split(path.sep).join('/') : '', file));
        // Which of the files the snapshot holds as a file or link: the others are deleted by the restore.
        const probe = mustSucceed(await git({
          args: ['cat-file', '--batch-check'], repo, input: `${names.map((name) => `${tree}:${name}`).join('\n')}\n`, timeout: restoreTimeoutMs,
        }), 'git cat-file').stdout.toString('utf8').split('\n');
        const held = names.filter((name, position) => / blob \d+$/.test(probe[position] ?? ''));
        if (held.length === 0) continue;
        mustSucceed(await git({ args: ['read-tree', tree], repo, root, index: tmpIndex, timeout: restoreTimeoutMs }), 'git read-tree');
        mustSucceed(await git({
          args: ['checkout-index', '-f', '-z', '--stdin', `--prefix=${prefix}`],
          repo, root, index: tmpIndex, input: `${held.join('\0')}\0`, timeout: restoreTimeoutMs,
        }), 'git checkout-index');
        files.forEach((file, position) => {
          if (held.includes(names[position])) staged.set(file, path.join(prefix, ...names[position].split('/')));
        });
      }

      // 2. Decide what each file needs and back up what will be replaced.
      const operations = [];
      for (const [file] of plan) {
        const { relative, destination } = destinationFor(cwdReal, file);
        const source = staged.get(relative);
        const sourceStat = source ? await lstat(source) : null;
        const current = await lstat(destination);
        if (sourceStat?.isDirectory()) continue; // a nested repository: not ours to write
        if (sourceStat && current?.isDirectory()) throw new SnapshotError(`A folder is in the way of ${relative}`);
        if (!sourceStat && (!current || current.isDirectory())) continue;
        const operation = { relative, destination, source: sourceStat ? source : null, sourceStat, existed: current !== null, backup: null };
        if (current) {
          operation.backup = path.join(backupDir, String(operations.length));
          operation.backupStat = current;
          if (current.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(destination), operation.backup);
          else await fs.promises.copyFile(destination, operation.backup);
        }
        operations.push(operation);
      }

      // 3. Swap files in; any failure rolls the swapped ones back.
      try {
        for (const operation of operations) {
          if (operation.source) {
            const folder = path.dirname(operation.destination);
            if (!fs.existsSync(folder)) {
              let missing = folder;
              const made = [];
              while (!fs.existsSync(missing)) { made.push(missing); missing = path.dirname(missing); }
              await fs.promises.mkdir(folder, { recursive: true });
              createdDirs.push(...made);
            }
            await place(operation.source, operation.destination, operation.sourceStat);
          } else {
            await fs.promises.unlink(operation.destination);
          }
          applied.push(operation);
        }
      } catch (error) {
        const problems = [];
        for (const operation of applied.reverse()) {
          try {
            if (operation.backup) await place(operation.backup, operation.destination, operation.backupStat);
            else await fs.promises.rm(operation.destination, { force: true });
          } catch (rollbackError) {
            problems.push(`${operation.relative}: ${rollbackError.message}`);
          }
        }
        for (const folder of createdDirs) await fs.promises.rmdir(folder).catch(() => {});
        if (problems.length > 0) {
          keepStaging = true;
          throw new SnapshotError(`Restoring files failed (${error.message}) and ${problems.length} could not be put back; their originals are in ${backupDir}: ${problems.join('; ')}`, { cause: error });
        }
        throw new SnapshotError(`Restoring files failed and nothing was changed: ${error.message}`, { cause: error });
      }

      // Folders that held only files this restore deleted are removed again, never the session folder.
      for (const operation of operations) {
        if (operation.source) continue;
        let folder = path.dirname(operation.destination);
        while (folder !== cwdReal && folder.startsWith(cwdReal + path.sep)) {
          try { await fs.promises.rmdir(folder); } catch { break; }
          folder = path.dirname(folder);
        }
      }
      return operations.map((operation) => operation.relative);
    } finally {
      if (!keepStaging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { track, changedFiles, diff, restore, isAvailable: () => available };
};

/**
 * What each assistant message's step saw of the work tree: `{ start, end,
 * files }` per message id, one JSON line each, appended when the step ends. A
 * file of its own and not the session sidecar: the sidecar is rewritten whole
 * on every patch, and a long session has thousands of steps.
 *
 * @param {object} options
 * @param {string} options.dir
 */
export const createStepLog = ({ dir }) => {
  /** sessionID -> Map(messageID -> record) */
  const cache = new Map();

  const fileOf = (sessionID) => path.join(dir, `${sessionID.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);

  const load = async (sessionID) => {
    let records = cache.get(sessionID);
    if (records) return records;
    records = new Map();
    let text = '';
    try { text = await fs.promises.readFile(fileOf(sessionID), 'utf8'); } catch { /* none yet */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const { m, ...record } = JSON.parse(line);
        if (typeof m === 'string') records.set(m, record);
      } catch { /* a half-written last line */ }
    }
    // A load that raced another one keeps the first map, so appends in between are not lost.
    return cache.get(sessionID) ?? (cache.set(sessionID, records), records);
  };

  return {
    /** messageID -> `{ start?, end?, files? }` for the session. */
    map: load,
    append: async (sessionID, messageID, record) => {
      const records = await load(sessionID);
      records.set(messageID, record);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(fileOf(sessionID), `${JSON.stringify({ m: messageID, ...record })}\n`);
    },
    /** Forget the records of removed messages. */
    drop: async (sessionID, messageIDs) => {
      const records = await load(sessionID);
      let changed = false;
      for (const id of messageIDs) changed = records.delete(id) || changed;
      if (!changed) return;
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(fileOf(sessionID), [...records].map(([m, record]) => JSON.stringify({ m, ...record })).join('\n') + (records.size ? '\n' : ''));
    },
    remove: async (sessionID) => {
      cache.delete(sessionID);
      await fs.promises.rm(fileOf(sessionID), { force: true });
    },
  };
};

/** What a restore that failed tells the person: a reference to look it up by, never the git output. */
export const restoreFailure = (error, ref, log) => {
  log(`restore failed (${ref}): ${error?.stack ?? error}`);
  return unknownError('The files could not be restored. Nothing was left half changed unless the log says otherwise.', ref);
};
