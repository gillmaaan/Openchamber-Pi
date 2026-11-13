// The workspace routes of the OpenCode 2.2.6 dialect, answered by the Pi bridge:
// the files, repository and shell commands of a folder, plus the location and
// debug routes that have nothing to do in a bridge with no locations.
//
// Served here (what each is made of is in WORKSPACE-NOTES.md):
// - `GET /api/fs/find`                      file search (workspace-find.js)
// - `POST /api/experimental/fs/write`       attachment files under the temp area (workspace-write.js)
// - `POST|DELETE /api/experimental/fs/watch` file watches and `filesystem.changed` (workspace-watch.js)
// - `GET /api/vcs/status|diff|base`, `POST /api/vcs/init` (workspace-git.js)
// - `GET /api/shell`, `/api/shell/:id`, `/api/shell/:id/output`, `DELETE /api/shell/:id`,
//   `POST /api/session/:id/shell`, `GET /api/experimental/job` (workspace-shells.js)
// - `POST /api/session/:id/background`      answers 204 and does nothing: Pi's tools cannot be moved to the background
// - `POST /api/location/reload`             204; `deps.reload(directory)` when the bridge has something to re-read
// - `GET|DELETE /api/debug/location`        `[]` and 204; a released location ends its file watches
// - `POST /api/debug/heap-dump`             a V8 heap snapshot of this process, under `<tmpDir>/openchamber-heap`
//
// Route order: `GET /api/shell` also exists in catalog.js as a stub that answers
// `[]`. `createBridgeHttpServer` takes the first match, so these routes go before
// the catalog's, or the stub is removed.
//
// `deps`:
// - `getDefaultDirectory()`: the folder a request without a directory answers for.
// - `requireSession(id)`: the session record (`{ id, location: { directory }, parentID? }`) or a 404 `SessionNotFoundError`.
// - `emit(type, data, directory, options?)`: publishes an event with `location: { directory }`.
//   `options.id` names the event: the UI derives the message of `session.shell.started`
//   from the event id (`evt_X` is `msg_X`), so `hub.emit` must honor it.
// - `host`: the live session host (`get`, `ensure`, `request`, `on`), the one the chat runs on.
// - `getLaunch?(record)`: the start options of a new Pi process for a session (the callback
//   token, the gate extension, folder trust: what prompting.js passes). Needed when a shell
//   command arrives for a session whose process is not live; without it that is a 503, because a
//   process started without them would run later turns without the permission gate.
// - `fileIndex?`: `{ get(sessionID) => { path } | null }`, to give a new process the session file.
// - `bindClientId?(sessionID, timestamp, messageID)`: records that the stored `shell` message
//   with Pi's `timestamp` is the one the UI minted as `messageID` (chat-runtime's `clientIds`).
//   Without it a reloaded transcript names the message differently from the live one.
// - `listJobs?()`: jobs that are not shell commands (`subagent`, `image`), merged into the job list.
// - `reload?(directory | null)`: called by `POST /api/location/reload`.
// - `runGit?(args, { cwd, timeoutMs?, maxBuffer?, env?, input?, signal? }) => Promise<string>`:
//   git; default `execFile git`, 10 s, rejects with the exit status as `error.code`.
// - `tmpDir?`: the temp folder `GET /api/info` reports as `paths.tmp`; default `os.tmpdir()`.
// - `maxWriteBytes?`, `writeHeapSnapshot?(file)`, `resolveRipgrep?()`: limits and test seams.
// - `watchOptions?`, `shellOptions?`: overrides for the watch registry (`fsWatch`, `debounceMs`,
//   `maxFiles`, `maxFolders`, `ttlMs`) and the shell store (`timeoutMs`, `maxRunning`,
//   `maxOutputBytes`, `keepaliveMs`, `retainMs`, `retainCount`, `shellPath`, `now`).
// - `log?`: `(message) => void` for problems that are not the request's fault; default `console.warn`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';

import { WireError } from '../errors.js';
import { json, noContent } from '../http.js';
import { resolveLocation } from '../location.js';
import { createReporter } from './pi-files.js';
import { createFileFinder, createFindRoutes } from './workspace-find.js';
import { createGitReviews, createVcsRoutes, runGitCommand } from './workspace-git.js';
import { createShellRoutes, createShells, requireSessionID } from './workspace-shells.js';
import { createFileWatches, createWatchRoutes } from './workspace-watch.js';
import { createTempFileWriter, createWriteRoutes } from './workspace-write.js';

const KEPT_HEAP_SNAPSHOTS = 3;

/**
 * @param {object} deps  See the header.
 * @returns {{ routes: object[], close: () => void }}  `close` ends the file watches and stops what the shell store holds; call it when the bridge closes.
 */
export const createWorkspace = (deps) => {
  const { getDefaultDirectory, requireSession, emit, host } = deps;
  for (const [name, value] of Object.entries({ getDefaultDirectory, requireSession, emit, host })) {
    if (!value) throw new TypeError(`createWorkspaceRoutes needs deps.${name}`);
  }
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const runGit = deps.runGit ?? runGitCommand;
  const reporter = createReporter(deps.log ?? ((message) => console.warn(`[pi-bridge] ${message}`)));
  const report = (message) => reporter(message.slice(0, 80), message);

  const locate = (ctx) => resolveLocation(ctx, { getDefaultDirectory });

  const reviews = createGitReviews({ runGit, tmpDir, report });
  const finder = createFileFinder({ runGit, report, ...(deps.resolveRipgrep ? { resolveRipgrep: deps.resolveRipgrep } : {}) });
  const writer = createTempFileWriter({ tmpDir, maxBytes: deps.maxWriteBytes });
  const watches = createFileWatches({ emit, log: report, ...deps.watchOptions });
  const shells = createShells({
    host,
    emit,
    tmpDir,
    requireSession,
    getLaunch: deps.getLaunch,
    fileIndex: deps.fileIndex,
    bindClientId: deps.bindClientId,
    listJobs: deps.listJobs,
    report,
    ...deps.shellOptions,
  });

  const writeHeapSnapshot = deps.writeHeapSnapshot ?? ((file) => v8.writeHeapSnapshot(file));

  /** A heap snapshot of this process. It holds whatever the process holds, so it is written `0600` in a `0700` folder and stays on this machine. */
  const heapDump = async () => {
    const directory = path.join(tmpDir, 'openchamber-heap');
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const file = path.join(directory, `heap-${process.pid}-${stamp}.heapsnapshot`);
    try {
      await fs.promises.writeFile(file, '', { mode: 0o600, flag: 'wx' });
      writeHeapSnapshot(file);
    } catch (error) {
      await fs.promises.rm(file, { force: true });
      report(`heap snapshot failed: ${error?.message ?? error}`);
      throw new WireError(500, 'UnknownError', 'The heap snapshot could not be written');
    }
    const kept = (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.heapsnapshot')).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - KEPT_HEAP_SNAPSHOTS))) await fs.promises.rm(path.join(directory, name), { force: true });
    return { path: file, pid: process.pid, memory: process.memoryUsage() };
  };

  const routes = [
    ...createFindRoutes({ locate, finder }),
    ...createWriteRoutes({ locate, writer }),
    ...createWatchRoutes({ locate, watches }),
    ...createVcsRoutes({ locate, emit, reviews }),
    ...createShellRoutes({ locate, requireSession, shells }),
    {
      // Pi has no way to move a running tool to the background, so there is nothing to move: OpenCode answers 204 too when nothing blocks.
      method: 'POST',
      path: '/api/session/:sessionID/background',
      handler: async (ctx) => {
        await requireSession(requireSessionID(ctx.params.sessionID));
        return noContent();
      },
    },
    {
      method: 'POST',
      path: '/api/location/reload',
      handler: async (ctx) => {
        await deps.reload?.(ctx.directory ? path.resolve(ctx.directory) : null);
        return noContent();
      },
    },
    // The bridge keeps no per-folder services, so there is nothing running to list.
    { method: 'GET', path: '/api/debug/location', handler: () => json([]) },
    {
      method: 'DELETE',
      path: '/api/debug/location',
      handler: (ctx) => {
        // A released folder ends the watches the bridge holds for it; asked for no folder it does nothing.
        if (ctx.directory) watches.stopLocation(path.resolve(ctx.directory));
        return noContent();
      },
    },
    { method: 'POST', path: '/api/debug/heap-dump', handler: async () => json(await heapDump()) },
  ];

  return {
    routes,
    close: () => {
      watches.close();
      shells.close();
    },
  };
};

/** @param {object} deps  See the header. */
export const createWorkspaceRoutes = (deps) => createWorkspace(deps).routes;
