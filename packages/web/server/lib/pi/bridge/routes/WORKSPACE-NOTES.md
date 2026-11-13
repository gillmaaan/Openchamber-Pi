# Workspace routes: decisions, deviations, hooks, gaps

`createWorkspace(deps)` in `workspace.js` serves the routes the UI calls for the files, the
repository and the shell commands of a folder, plus the location and debug routes. The header of
`workspace.js` documents `deps`. One module per concern sits next to it: `workspace-find.js`,
`workspace-write.js`, `workspace-watch.js`, `workspace-git.js`, `workspace-shells.js`.

`createWorkspaceRoutes(deps)` returns only the route list. The coordinator uses `createWorkspace(deps)`,
which also returns `close()` (ends file watches, kills nothing, removes the shell output folder).

Tests: `workspace.test.js` (35, files, repository, location, debug) and `workspace-shells.test.js`
(22). Both run through `createBridgeHttpServer` on a loopback port, over real folders, real git
repositories, real file watchers and, for shell commands, a real `pi --mode rpc` child. Bodies are also
decoded with OpenCode's own schemas (`test-support/workspace-schema.js`, `onExcessProperty: 'error'`).

## Routes served

| Route | Answer | Made of |
|---|---|---|
| `GET /api/fs/find` | `{location, data: [{path, type}]}` | `git ls-files`, else ripgrep, else a bounded walk |
| `POST /api/experimental/fs/write` | `{location, data: {path}}` | raw body written under `<tmp>/openchamber` |
| `POST`, `DELETE /api/experimental/fs/watch` | 204; `filesystem.changed {file, event}` | `fs.watch` per parent folder |
| `GET /api/vcs/status`, `/diff`, `/base` | `{location, data}` | `git`, intent-to-add on an index copy |
| `POST /api/vcs/init` | 204; 409; 503 | `git init` |
| `GET /api/shell`, `/api/shell/:id`, `/api/shell/:id/output`, `DELETE /api/shell/:id` | `{location, data}`, 204 | the shell store |
| `POST /api/session/:id/shell` | 204 when the command has ended | Pi RPC `bash` |
| `GET /api/experimental/job` | `{data: [Job]}` | shell store plus `deps.listJobs()` |
| `POST /api/session/:id/background` | 204, does nothing | see below |
| `POST /api/location/reload` | 204 | `deps.reload(directory)` when given |
| `GET`, `DELETE /api/debug/location` | `[]`; 204 | a released folder ends its watches |
| `POST /api/debug/heap-dump` | `{path, pid, memory}` | `v8.writeHeapSnapshot` |

## What was captured from a live OpenCode 2.2.6

An isolated `opencode serve` (own HOME, XDG and config folders) answered these; the shapes are in the
tests.

- `fs/find`: default `limit` 50, any positive integer accepted, `query` required (empty lists the
  folder), directories end in `/`, `.gitignore` applies, `limit=0` is a 400 `Expected a value greater
  than 0`. A path query such as `../` is just a fuzzy string.
- `fs/write`: the answer has `location`; the same path again overwrites; OpenCode wrote into the
  project and followed `..` (see the deviations).
- `fs/watch`: a file that is missing, a directory, a path outside the folder or empty is a 404
  `FileNotFoundError {path}`; an absolute path inside works; unwatching an unknown path is 204. The
  event is `filesystem.changed {file (absolute), event}` with `location`.
- `vcs`: paths are repository-relative and limited to the request's folder; `mode` is required;
  `committed` is merge base to HEAD; `untracked=folders` makes a `dir/` entry with an `Index:` patch;
  an unknown `base` is a 503 `No merge base available for <base>`; `base` on a branch made with
  `git checkout -b` is a 503 `Choose a review base`, and `git switch -c x main` gives `source: reflog`;
  `vcs/init` runs plain `git init` (the user's `init.defaultBranch` applies), 409 `Project already has
  version control`, another provider is a 503 `VCS initialization failed`.
- `shell`: `POST /session/:id/shell` answers when the command ends, which is why the UI tolerates a
  lost response. A finished command leaves the list but stays readable by id until deleted; `DELETE` of an
  unknown id is 204; the output page default is 64 KiB; an id in another folder is a 404
  `ShellNotFoundError`. The event order is `shell.created`, `session.shell.started`, `shell.exited`,
  `session.shell.ended`, then a synthetic inbox item; `session.shell.started` carries the event id
  `evt_X` for the message id `msg_X` the UI sent.
- `job`: global, `{data}`, `title` is the command, unknown session 404, `descendants` is a boolean.
- `location/reload`, `debug/location`: 204 for any folder, also a missing one; `GET` lists the running
  folders as `[{directory}]`.

## Decisions

### Why shell commands run on Pi's RPC `bash` and not on a process the bridge spawns

A command the user types in the composer has to reach three places: the live view, the stored message
and the agent's context. Pi's `bash` command records a `bashExecution` entry in the session file
(`wire/transcript.js` already maps it to a `shell` message) and gives it to the model with the next
prompt. A direct spawn would give the live view only; the stored message and the agent's note would
need a second store the message list does not read. The cost is that the session's Pi child has to run
(about half a second on first use, then reused) and the limits listed below.

### Why every command gets an RPC id of its own

`bash_execution_update` repeats the id of the request that produced it, and `rpc-client.js` made that
id internally. Commands that run side by side in one session would mix their output. `request()` now
takes `{ id }` (additive) and each command is `shell:<shellID>`.

### Why a command that stops one of several in a session stops all of them

Pi's `abort_bash` aborts every user command of the session. `DELETE /api/shell/:id` therefore ends all of
them, and each is reported `killed`. A pid-based kill needs the pid, which Pi's RPC does not report.

### Why the live output is a file

`GET /api/shell/:id/output` pages by byte cursor and the UI polls it, so the captured deltas go to a
`0600` file in a `0700` folder, capped at 8 MiB (`truncated: true` past it), not to memory. A finished
command is kept 30 minutes or until 100 newer ones finished, then its file goes.

### Why the ended event carries Pi's own output

`session.shell.ended.output` is what Pi stored (a tail of at most about 50 KB), the same text
`wire/transcript.js` serves after a reload, so the live row and the reloaded row agree. The file holds more.

### Why the completion note is two events and no inbox record

The UI continues the agent after a "run" button in a reply from the synthetic message whose metadata is
`{source: 'shell', shellID, state}`. The bridge publishes `session.inbox.enqueued` and, at once,
`session.inbox.delivered`. Nothing is added to prompting.js's inbox and the text is not sent to Pi, which
already has the command as a `bashExecution`.

### Why a quiet command pings its process

The host closes a child that saw no event for five minutes, and a quiet command sends none (a build that
prints nothing for ten minutes would be killed). While a session has a running command the store sends
`get_state` every 30 s, only to a live process: `host.request` would otherwise start one without the
gate extension.

### Why a process is started with `getLaunch` or not at all

A child started without the launch options runs later turns without the permission gate. The store
starts a child only with `deps.getLaunch(record)`, and refuses with a 503 when it has none.

### Why `fs/find` reads git's file list

`git ls-files --cached --others --exclude-standard` applies `.gitignore`, `.git/info/exclude` and the
global ignore exactly as git does, in about 50 ms for 30,000 files (no cache needed). A folder that is
not a repository, or whose git fails, goes to ripgrep (`--files`), then to a walk that skips `.git` and
`node_modules` and does not follow symlinks. The list is capped at 200,000 paths, the answer at 1000.
The query is scored (basename, path, then subsequence) and never used as a path.

### Why `fs/watch` watches the parent folder, not the file and not a tree

One non-recursive `fs.watch` per folder serves all files watched in it, sees an editor that saves by
renaming a new file over the old one, and costs one OS watch where a recursive watch of the project costs
one per folder. A raw event only schedules a check after 75 ms of quiet; the check compares
inode, size and mtime and emits one `add`, `change` or `unlink`. Caps: 256 files, 64 folders (503 past
it, which the UI reads as "poll"). Watches end by expiry (24 h, renewed by watching again), `unwatch`,
`DELETE /api/debug/location` for the folder, and `close()`.

### Why a review reads untracked files through an index copy

`git diff` shows an untracked file only as an intent-to-add entry. Adding those to the repository's own
index would change what the user sees in `git status`. The store copies the index to a temp folder,
points `GIT_INDEX_FILE` at the copy, adds the untracked files there and diffs. Patches, binary handling
and counts are git's. The test checks that `git status` and the index bytes are the same afterwards.
More than 500 untracked files, or one over 2 MiB, are left out and logged.

### Why the heap snapshot is written

The button exists to attach memory reports, and the process that grows is this one. The file holds
whatever the process holds (keys, prompts), so it is `0600` in a `0700` folder and stays on the machine;
the newest three are kept. It blocks the event loop for as long as V8 serializes, which stalls every
open stream of the OpenChamber server, not only the agent. Refusing with a 503 is a one-line change if
the maintainers prefer that.

### Why `POST /api/session/:id/background` does nothing

Pi has no way to move a running tool to the background; its `bash` tool has no such mode. The answer is
the 204 OpenCode gives when nothing blocks. Effect: the "move to background" action in the status row
looks like it worked and the command keeps blocking. The UI decides when to offer it from its own state,
so only a change there could hide it.

### Why `GET /api/experimental/job` is served

It is in 2.2.6, and the fallback in `session-activity.js` (a bare 404 means "no job list, use the older
reads") exists for older OpenCode only. The bare 404 of an unknown route stays (`http.js`, tested).
Shell jobs come from the store; subagents and images come from `deps.listJobs()`.

## Deviations from OpenCode

- `fs/write` writes only below `<tmpDir>/openchamber`, with a `0700` folder that must be a real folder of
  this user, no link followed, a rename over the target, and a body cap (64 MiB). OpenCode wrote anywhere.
  A refused path is a 400 tagged `InvalidRequestError`; a temp area that is a link is a 503.
- `output?limit=0` is a 400 (OpenCode answers a bare 500). A page is at most 1 MiB and ends on a
  character boundary.
- `GET /api/debug/location` is always `[]`; `POST /api/location/reload` is a no-op without `deps.reload`.
- `ShellInfo` has no `pid`. `shell` is `/bin/bash` (`shellOptions.shellPath`).
- Stopping and the deferred record: while the agent streams, and in a session with no assistant message
  yet, Pi writes the `bashExecution` entry later (after the turn, or with the first assistant message),
  so the stored message appears then. The live row does not depend on it.
- No default command timeout (OpenCode has none); `shellOptions.timeoutMs` sets one (`timeout` status).

## Hooks the coordinator wires (bridge/index.js)

1. Put these routes before `createCatalogRoutes`, or delete catalog.js's `GET /api/shell` stub: the
   server takes the first match. `GET /api/vcs` and `/api/vcs/branch` stay in the catalog.
2. `const workspace = createWorkspace({ getDefaultDirectory, requireSession, emit, host, getLaunch:
   buildLaunch, fileIndex, bindClientId, tmpDir, listJobs, reload })`; `routes.push(...workspace.routes)`;
   call `workspace.close()` in `close()`.
3. `emit(type, data, directory, options)` must pass `options.id` to the hub. `hub.js` takes `{ id }`
   now (a one-line additive change made here); `service.emit` does not forward it, so the workspace gets
   its own `emit` that calls `hub.emit({ id, type, data, location })` with the same location rule as
   `service.emit` (`LOCATIONLESS_EVENTS` does not list any event of this module).
4. `bindClientId(sessionID, timestamp, messageID)` is chat-runtime's `persistClientId`. Without it the
   shell message after a reload has the id Pi's entry derives (`shellMessageId`), not the one the UI minted.
5. `tmpDir` is the value `getServerInfo().tmp` reports (`paths.tmp`). The UI writes attachments to
   `<tmp>/openchamber/<hex>/<name>` and the agent has to read there; whoever owns the permission rules
   decides whether that needs an allow rule.
6. `listJobs` is `bridge/jobs.js`: `{kind: 'subagent', id, sessionID (parent), status, title,
   time, childSessionID, agent, description}` for a subagent tool call and a subagent command. The
   child's terminal wire event ends its entry; a finished entry stays five minutes. Without it a
   running subagent is not in the job list.
7. `reload(directory | null)`: `catalog.reload()` and the catalog `*.updated` events, if a reload is to
   refresh the UI (nothing in the UI calls the route today).
8. `project.updated` after `vcs/init` is not sent; `refreshKnownDirectories()` is the place if wanted.

Two shared files changed, both additive: `rpc-client.js` (`request(..., { id })`) and `bridge/hub.js`
(`emit({ id })`). Their own tests (`rpc-client.test.js`, `index.test.js`, `live-session-host.test.js`)
pass.

## What the UI calls and who answers it

Every SDK call of the UI (`call("...")` in `client.ts` and `lib/opencode/*`) was matched against the
registered routes. Mine: `file.find`, `file.write`, `file.watch`, `job.list`, `shell.list|output|remove`,
`session.shell`, `session.background`, `vcs.init`, `debug.heapDump`, `debug.location.evict`. Not mine and
not registered when this was written: `session.fork|move|diff|revert.*|generate`,
`experimental.session.stats` (session operations), `mcp.connect|disconnect`, `websearch.providers`,
`integration.connect.*|oauth.*`, `credential.remove` (providers and config pages). A route the UI calls
and nobody serves is a bare 404.

Never called by the UI, so left as a bare 404: `fs/read`, `fs/list`, `pty*`, `persistent-pty*`,
`worktree*`, `reference`, `rpc`, `plugin/gui`, `POST /api/shell`, `PATCH /api/project/:id`,
`experimental/{voice,media,schedule,artifacts,usage,session/export|import|log|terminal}`. No code reads a
404 from them except `isOpencodeNotFound` sites for routes served here.

## Not proven

- Linux and Windows: the file watcher tests ran on macOS (FSEvents); the shell tests need `bash`.
- A command that starts background children (`sleep 100 &`): `abort_bash` was only run on a foreground
  command; whether Pi's abort reaches grandchildren is Pi's behavior.
- The five-minute reaper against a really quiet command (only the ping is tested, with a fake host).
- The message id binding against a real session file: the entry lookup is tested on hand-made JSONL;
  the Pi file of a session without an assistant message does not exist yet.
- The UI in a browser: nothing here ran the real UI against these routes.
- Repositories above 30,000 files for `fs/find`; submodules and nested checkouts (git lists a submodule
  as one path, which is treated as a file).

## Open questions

1. Is "stopping one command stops all of the session's" acceptable, or should a command run on a
   process the bridge spawns, with the entry written to the session file by the bridge?
2. Heap snapshot: keep writing it, or refuse because it snapshots the whole OpenChamber server?
3. Should there be a default command timeout (a dev server started with `!` holds its request open for
   as long as it runs, as in OpenCode)?
