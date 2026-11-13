// `POST /api/experimental/fs/watch` and `DELETE /api/experimental/fs/watch`: the
// file watches behind `lib/watchedFiles` (a file open on screen re-reads itself
// the moment an agent, an editor or a terminal changes it).
//
// OpenCode 2.2.6 (probed): a watch is one file under the request's folder, given
// relative to it or absolute; a path that is not an existing file inside the
// folder is a 404 `FileNotFoundError { path }`; the answer is 204. A change
// arrives as the ephemeral `filesystem.changed { file, event }` with the
// folder as `location`: `file` absolute, `event` `add`, `change` or `unlink`.
// A watch lasts 24 hours and watching again renews it; unwatching an unknown
// path is a 204 too.
//
// How it is built here:
// - One non-recursive `fs.watch` per parent folder, shared by every watched file
//   in it. Watching a single file needs no recursion, and a recursive watch of
//   a project tree costs an inotify watch per folder (or, on Linux before
//   Node 20, is not available at all). The folder is watched, not the file, so
//   an editor that saves by writing a new file and renaming it is seen.
// - A raw event only schedules a check: the file is stat-ed after a quiet
//   moment (`debounceMs`) and the event is what changed since the last check
//   (`add`, `change`, `unlink`), so the burst of events one save produces is one
//   `filesystem.changed`.
// - At most `maxFiles` watched files and `maxFolders` watched folders; past
//   that a watch is a 503 `ServiceUnavailableError`, which the UI reads as "poll
//   instead" (`watching: false`).
// - Watches end by expiry, by unwatching, when the location is released
//   (`stopLocation`) and when the bridge closes (`close`).

import fs from 'node:fs';
import path from 'node:path';

import { invalidRequest, serviceUnavailable, WireError } from '../errors.js';
import { noContent } from '../http.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const fileNotFound = (requested) => new WireError(404, 'FileNotFoundError', `File not found: ${requested}`, { path: requested });

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const signatureOf = (stat) => `${stat.ino}:${stat.size}:${stat.mtimeNs}`;

/**
 * @param {object} options
 * @param {(type: string, data: object, directory: string) => void} options.emit
 * @param {typeof fs.watch} [options.fsWatch]
 * @param {number} [options.debounceMs]
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxFolders]
 * @param {number} [options.ttlMs]
 * @param {(message: string) => void} [options.log]
 */
export const createFileWatches = ({
  emit,
  fsWatch = fs.watch,
  debounceMs = 75,
  maxFiles = 256,
  maxFolders = 64,
  ttlMs = DAY_MS,
  log = () => {},
}) => {
  /** `<location>\0<file>` -> { directory, file, folder, exists, signature, check, expiry } */
  const files = new Map();
  /** folder -> { watcher, files: Set<entry> } */
  const folders = new Map();
  let closed = false;

  const keyOf = (directory, file) => `${directory}\0${file}`;

  const dropFolderIfUnused = (folder) => {
    const shared = folders.get(folder);
    if (!shared || shared.files.size > 0) return;
    folders.delete(folder);
    try { shared.watcher.close(); } catch { /* already closed */ }
  };

  const remove = (entry) => {
    clearTimeout(entry.check);
    clearTimeout(entry.expiry);
    files.delete(keyOf(entry.directory, entry.file));
    folders.get(entry.folder)?.files.delete(entry);
    dropFolderIfUnused(entry.folder);
  };

  const check = async (entry) => {
    entry.check = null;
    if (closed || files.get(keyOf(entry.directory, entry.file)) !== entry) return;
    let stat = null;
    try {
      stat = await fs.promises.lstat(entry.file, { bigint: true });
    } catch { /* gone */ }
    if (closed || files.get(keyOf(entry.directory, entry.file)) !== entry) return;

    let event = null;
    if (stat && !entry.exists) event = 'add';
    else if (stat && signatureOf(stat) !== entry.signature) event = 'change';
    else if (!stat && entry.exists) event = 'unlink';
    entry.exists = stat !== null;
    entry.signature = stat ? signatureOf(stat) : null;
    if (event) emit('filesystem.changed', { file: entry.file, event }, entry.directory);
  };

  const schedule = (entry) => {
    if (entry.check) clearTimeout(entry.check);
    entry.check = setTimeout(() => { void check(entry); }, debounceMs);
    entry.check.unref?.();
  };

  const watchFolder = (folder) => {
    const existing = folders.get(folder);
    if (existing) return existing;
    if (folders.size >= maxFolders) throw serviceUnavailable('Too many folders are being watched', 'fs');
    let watcher;
    try {
      watcher = fsWatch(folder, { persistent: false }, (_type, name) => {
        const shared = folders.get(folder);
        if (!shared) return;
        const changed = name === null || name === undefined ? null : String(name);
        for (const entry of shared.files) {
          if (changed === null || changed === path.basename(entry.file)) schedule(entry);
        }
      });
    } catch (error) {
      throw serviceUnavailable(`The folder cannot be watched: ${error?.message ?? error}`, 'fs');
    }
    const shared = { watcher, files: new Set() };
    watcher.on('error', (error) => {
      // The folder was removed or the OS gave up: its watches end, the UI renews them.
      log(`fs.watch on ${folder} ended: ${error?.message ?? error}`);
      for (const entry of [...shared.files]) remove(entry);
    });
    folders.set(folder, shared);
    return shared;
  };

  /** Watch `file` (absolute, inside `directory`, existing); watching again renews the expiry. */
  const watch = async (directory, file) => {
    if (closed) throw serviceUnavailable('The bridge is shutting down', 'fs');
    const key = keyOf(directory, file);
    const known = files.get(key);
    if (known) {
      clearTimeout(known.expiry);
      known.expiry = setTimeout(() => remove(known), ttlMs);
      known.expiry.unref?.();
      return;
    }
    if (files.size >= maxFiles) throw serviceUnavailable('Too many files are being watched', 'fs');
    const stat = await fs.promises.lstat(file, { bigint: true });
    const folder = path.dirname(file);
    const shared = watchFolder(folder);
    const entry = { directory, file, folder, exists: true, signature: signatureOf(stat), check: null, expiry: null };
    entry.expiry = setTimeout(() => remove(entry), ttlMs);
    entry.expiry.unref?.();
    shared.files.add(entry);
    files.set(key, entry);
  };

  const unwatch = (directory, file) => {
    const entry = files.get(keyOf(directory, file));
    if (entry) remove(entry);
  };

  /** The location was released: every watch under it ends. */
  const stopLocation = (directory) => {
    for (const entry of [...files.values()]) {
      if (entry.directory === directory) remove(entry);
    }
  };

  const close = () => {
    closed = true;
    for (const entry of [...files.values()]) remove(entry);
  };

  return { watch, unwatch, stopLocation, close, get size() { return files.size; }, get folders() { return folders.size; } };
};

/**
 * Resolves the path of a watch request against the folder. `null` when it
 * falls outside the folder (also through a symlink, for files that exist).
 */
const resolveInside = async (directory, requested, { mustExist }) => {
  const absolute = path.resolve(directory, requested);
  if (!isInside(directory, absolute)) return null;
  if (!mustExist) return absolute;
  try {
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    const [realDirectory, realFile] = await Promise.all([fs.promises.realpath(directory), fs.promises.realpath(absolute)]);
    if (!isInside(realDirectory, realFile) || !(await fs.promises.stat(realFile)).isFile()) return null;
    return absolute;
  } catch {
    return null;
  }
};

const requestedPath = async (ctx) => {
  const body = await ctx.body();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('Expected object', { kind: 'Payload' });
  if (!('path' in body)) throw invalidRequest('Missing key\n  at ["path"]', { kind: 'Payload' });
  if (typeof body.path !== 'string') throw invalidRequest('Expected string\n  at ["path"]', { kind: 'Payload' });
  return body.path;
};

/**
 * @param {object} deps
 * @param {(ctx: object) => { directory: string }} deps.locate
 * @param {ReturnType<typeof createFileWatches>} deps.watches
 */
export const createWatchRoutes = ({ locate, watches }) => [
  {
    method: 'POST',
    path: '/api/experimental/fs/watch',
    handler: async (ctx) => {
      const { directory } = locate(ctx);
      const requested = await requestedPath(ctx);
      const file = await resolveInside(directory, requested, { mustExist: true });
      if (!file) throw fileNotFound(requested);
      try {
        await watches.watch(directory, file);
      } catch (error) {
        if (error?.code === 'ENOENT') throw fileNotFound(requested);
        throw error;
      }
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/api/experimental/fs/watch',
    handler: async (ctx) => {
      const { directory } = locate(ctx);
      const file = await resolveInside(directory, await requestedPath(ctx), { mustExist: false });
      if (file) watches.unwatch(directory, file);
      return noContent();
    },
  },
];
