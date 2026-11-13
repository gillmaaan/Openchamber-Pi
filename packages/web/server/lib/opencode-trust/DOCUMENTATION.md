# Folder trust

## Ownership

Whether the agent may open a folder. Pi loads a folder's extensions, installs
its packages and starts the commands in its `.pi` configuration (MCP servers,
a custom shell, a package manager command) as soon as a Pi process starts
there. A cloned repository or a pull request checked out for review would run
its own code the moment OpenChamber shows it. This module refuses such a
folder until the user trusts exactly the configuration it has, and asks again
when that configuration changes.

- `assessment.js` finds what Pi would run from a folder, mirroring Pi 1.5
  discovery (`core/package-manager.js`, `core/settings-manager.js` and
  `extensions/mcp/config.js` in `@earendil-works/pi-coding-agent`), and
  fingerprints it. The exported name `assessOpenCodeConfig` is the one
  `index.js` imports.
- `approval.js` turns the answer into the flag every Pi child is started with.
- `store.js` keeps the trusted fingerprints per repository in
  `<dataDir>/opencode-trust.json`.
- `index.js` decides per request (`refusalFor`) and serves
  `GET`/`POST /api/opencode/trust` (`handleRoute`) for every runtime.
- `fetch-guard.js` puts the same decision in front of every request the
  server process sends OpenCode itself.
- `session-directory.js` names the folder of a session whose route runs in
  the session's own location.

`index.js`, `fetch-guard.js`, `session-directory.js` and the proxy middleware
still speak OpenCode's HTTP API, and the request rules under Invariants
describe that wiring. The trust question they ask is answered by the Pi
assessment. A Pi child does not go through them: the process that starts it
calls `approvalFlagFor` before every start.

The prompt lives in the shared UI (`packages/ui/src/lib/opencodeTrust.ts`,
`components/projects/OpenCodeTrustDialog.tsx`): the client hands a refusal to
it, shows what would run, saves a "trust" answer here and sends the refused
request again. The dialog reads the item kinds `plugin`, `package`, `mcp`,
`lsp`, `formatter`, `shell` and `config`, and fails to read an answer with any
other kind, so the assessment uses only these. `lsp` and `formatter` have no
Pi counterpart and stay unused.

Session admission also uses this prompt before registering an unknown host
destination as a project. A configuration that runs nothing or whose current
fingerprint is trusted registers without another dialog. There is no separate
folder-consent store. The destination registration route and VS Code workspace
bridge recheck trust before changing the registry. Runtime switches dismiss
pending UI prompts and invalidate their continuations.

Where the check runs:

| Runtime | Path to the agent | Check |
|---|---|---|
| Web, desktop, hosted and Capacitor mobile | UI through the server proxy | `opencode/proxy.js` middleware |
| Same server | server features with their own clients | `guardOpenCodeFetch`, installed over `globalThis.fetch` in `server/index.js` |
| VS Code | webview through the extension bridge | `vscode/src/bridge-proxy-runtime.ts`, same answers file |
| Pi child process | started by the server | `approvalFlagFor`, called with every start |
| An agent the user runs on their own | not through OpenChamber | none here; Pi has its own project trust |

## What Pi runs

Pi looks only in `<folder>/.pi`. The assessment lists:

| Source | What counts | Item kind |
|---|---|---|
| `.pi/extensions` | each direct `.ts` or `.js` file and each subfolder with an `index.ts|js` or a `package.json` that declares `pi.extensions`; a folder that has its own entry point counts as one extension; a manifest path outside the folder is a line of its own | `plugin` |
| `extensions` in `.pi/settings.json` | each path that exists, a folder resolved the same way as `.pi/extensions` | `plugin` |
| `packages` in `.pi/settings.json` | an `npm:` source | `package` |
| | a `git:`, `github:`, `http(s):` or `ssh:` source | `plugin` |
| | a local path, hashed with its content, and each path its manifest loads from outside it as a line of its own | `plugin` |
| `shellPath`, `shellCommandPrefix`, `npmCommand`, `externalEditor` in `.pi/settings.json` | any set value; the file `shellPath` names, and the files of `npmCommand`, are hashed | `shell` |
| `.pi/mcp.json` | an enabled stdio server | `mcp` |
| | an enabled remote server whose `headers` or `oauth.clientSecret` hold a `!command` or an environment variable | `mcp` |
| A file Pi reads here and the assessment cannot show | see "Why a file that cannot be read counts as code" | `config` |

Text adds nothing: `AGENTS.md`, `CLAUDE.md`, `.pi/SYSTEM.md`,
`.pi/APPEND_SYSTEM.md`, skills, prompt templates, themes, and settings that
only change models, themes or limits. Pi reads `selfUpdateCommand`,
`httpProxy` and `defaultProjectTrust` from the user's settings only, so a
project cannot set them and they are not listed.

## Invariants

- A request that names a folder (`x-opencode-directory`, `?directory=`,
  `location[directory]`) or acts on a session reaches OpenCode only when that
  folder's configuration runs nothing or its current fingerprint is trusted.
  A header is read the way OpenCode reads it: percent-decoded, or as it
  arrived when decoding fails, so a folder named `1%72epo%ZZ` is checked under
  that literal name. Routes that start no location (session list and detail, message pages, the
  event stream, credentials, deleting or viewing a session, unloading a
  location) pass, so a paused folder still lists and shows its sessions. Any
  other route, including ones OpenCode adds later, is checked.
- Moving a session (`POST /api/session/:id/move`) is checked against the
  folder it moves into, read from the body and resolved the way OpenCode
  resolves it (`~` from home, a relative path from the session's folder), and
  against the session's current folder: OpenCode opens the destination to
  validate it and the source to see whether it still runs. A source folder
  that is gone opens nothing and passes, so sessions still move out of deleted
  folders. A move whose body names no directory, or that the runtime cannot
  read, answers 400 without reaching OpenCode. Every runtime hands the body to
  `refusalFor` through `readBody`: the proxy parses it, `guardOpenCodeFetch`
  reads a copy, the VS Code bridge decodes its base64 body.
  The proxy's worktree checkout gate (`../opencode/proxy.js`) resolves the
  destination with the same `readMoveDestination`, so both gates agree on
  which folder a move opens.
- A session route is checked against the session's folder as well, read from
  OpenCode's session record. The `global` owner is the exception: OpenCode
  files MCP elicitation forms under it, it has no session record, and its
  routes, such as a form's reply and cancel, run in the folder the request
  names, so only that folder is checked. A lookup of `global` answers 400, which would refuse
  every reply to such a form.
- Trust is per repository: every worktree of one repository shares the
  answers, and a worktree whose configuration differs from every trusted one
  asks. The latest 20 fingerprints per repository are kept, so switching
  between branches that each carry trusted extensions does not ask again.
- A fingerprint covers what runs and nothing else. Editing text, a model or
  a theme never asks again; changing a package source, an extension, an MCP
  command, a command setting or any file one of them imports does.
- Every Pi child starts with the flag `approvalFlagFor` answers. `--approve`
  goes only to a folder that runs nothing or whose current fingerprint is
  trusted. `--no-approve` goes to every other folder and whenever the check
  fails. The flag overrides Pi's own `trust.json` and `defaultProjectTrust`,
  so the answers file here is the only trust decision a child gets.
- The assessment bounds what it reads from a hostile folder. It does not open
  a pipe or a device, reads no configuration file past 1 MiB and no more than
  500 files and 16 MiB of one extension, package or import chain, visits at
  most 20,000 directory entries per tree, and follows a link to a file but
  never into a linked folder inside a tree. A package source such as `/` is
  cut off at the entry limit.
- The projects already in the user's list when the check first runs are
  trusted as they are, once (`seeded` in the answers file). The rule was
  written for OpenCode, which had already run those folders. `index.js` still
  seeds, so a folder that was a project before the check started has its
  current `.pi` configuration trusted without a prompt. A project added later,
  a worktree whose configuration differs, and any later change to a seeded
  project ask. A seeding that cannot read the project list records nothing and
  runs again on the next start. Every check waits for the seeding, so projects
  are read in parallel and one that takes over 2 seconds (a network share that
  stopped answering) is left out and asks when opened.

## Cost

Measured with Node on an M-series Mac, 200 checks of the same folder: 0.06 ms
for a folder without a `.pi` directory, and 13 ms for a folder with 35
extension files that each import a local file, plus a settings file with
packages and an MCP file with two servers. Requests that name no folder, or
name only global routes, read nothing.

The server reads a folder once each time OpenCode opens it. A trusted answer
holds until OpenCode reports the folder closed (`location.shutdown` on the
event stream, through `forget`); the next opening reads it again, which is
where a pull made while it was closed is caught. While the event stream is
down closings go unreported, so answers last 2 seconds, and a new connection
forgets them all (`followLocations`). Untrusted answers always last 2
seconds, so a folder whose extension was removed opens without a prompt.
`approvalFlagFor` skips this cache and reads the folder fresh.

VS Code follows closings the same way: its global event watcher
(`vscode/src/sessionActivityWatcher.ts`) runs while the extension is
connected to OpenCode and reports `location.shutdown` to the shared instance
in `vscode/src/opencodeTrust.ts`.
- A store that cannot be read trusts nothing. The prompt returns rather than
  code running unasked; the next answer rewrites the file.
- `POST /api/opencode/trust` records only the fingerprint the user was shown.
  When the configuration changed since, nothing is recorded and the answer
  carries the current configuration to show instead.
- Startup warming and the directory server-side reads fall back to
  (`lifecycle.js` through `getWarmupDirectories` and `onLastDirectoryChanged`
  in `server/index.js`) are trusted folders only, so features that read
  OpenCode with no folder of their own keep working on a folder that may open.

## Decisions

### Why queued prompts read trust again

Several worktrees can have untrusted assessments before the user answers the
first prompt. Each queued prompt reads the server's current assessment when
its turn arrives, so the first saved answer also opens unchanged worktrees
without another confirmation. Already-trusted requests bypass the prompt queue;
a failed assessment still leaves its folder closed.

### Why a gate in OpenChamber and not Pi's own project trust

Pi saves a decision per folder path in `~/.pi/agent/trust.json`, and the
nearest saved decision wins, so "Trust parent folder" covers everything
below it. A saved decision says nothing about what the folder holds, so a
`git pull` that adds an extension to a trusted project runs it unasked. Pi RPC
cannot prompt: without a flag or a saved decision a child silently skips the
project's resources. The file is also shared with every Pi CLI on the machine,
so a click in OpenChamber would trust the folder for the terminal too.
OpenChamber therefore decides by fingerprint and passes `--approve` or
`--no-approve`, which Pi applies before `trust.json`. Writing the user's "yes"
into `trust.json` was weighed and rejected for the reasons above.

### Why the fingerprint covers code, not the whole configuration

Only entries that run code count: extension files and folders (content
hashed), packages (the source string, plus the content of a local one), the
command settings Pi honors from a project, and the stdio MCP servers or
remote servers whose values run a command. A folder with only models,
prompts, skills or themes opens without a prompt, and editing those never
asks again. Settings Pi reads from the user's file only are left out. A
package filter (`extensions`, `autoload` on an object entry) goes into the
package's hash, since it decides whether the package's extensions load. A
package listed twice is one line with both entries in its hash.

### Why only `<folder>/.pi` and not the parents

Pi reads a project's `.pi/settings.json`, `.pi/mcp.json` and `.pi/extensions`
from the working directory alone. OpenCode walked up to the repository root,
Pi does not, so a `.pi` folder in a parent changes nothing for a child started
in a subfolder, and counting it would ask about code that never runs. Trust
is still per repository: the answers are keyed by the repository and every
worktree shares them, and the fingerprint is that of the folder asked about.
Pi also reads `.agents/skills` in the ancestors up to the repository root;
those hold text.

### Why a file that cannot be read counts as code

A `.pi/settings.json` or `.pi/mcp.json` that does not parse, has a `packages`,
`extensions` or `mcpServers` of another shape, is past 1 MiB, is a folder or a
pipe, or cannot be read becomes one `config` item, fingerprinted by what is
in it. A `package.json` in an extension folder is read the way Pi reads it, so
one that does not parse declares nothing. One that is past 1 MiB, a folder or
unreadable may declare entry points this module cannot see, so its folder
counts as an extension and is hashed whole. Pi 1.5 parses both files with `JSON.parse` and runs nothing from a file
that fails, so the item protects against others reading the same file:
Pi's next release may accept more, and an installed extension such as
`pi-mcp-adapter` replaces Pi's MCP support and reads `.pi/mcp.json` with its
own parser. The cost is one prompt for a file that is broken anyway, and the
dialog names the file. An empty file is read as no settings, which is what
Pi does. A parser that accepted comments, as the OpenCode one did, would let
a file Pi rejects pass, so the assessment uses Pi's strict parse.

### Why an extension's hash covers the local files it imports

A trusted extension that imports `../../scripts/helper.js` runs whatever that
file holds, so a pull request could change the helper and keep the
extension's own hash. The local files an extension's scripts import, and the
files those import, are hashed into the extension's hash, along with every
local import that names no file yet. An extension that imports nothing local
keeps the hash of its own content. A folder extension is hashed as a whole,
since its entry point imports its siblings, and the entry point is followed
even when the walk of a huge folder stopped before it. A file reached through
a linked folder inside the extension counts as an import, because the tree
hash records only where the link points. The imports of a linked file are
resolved from its own folder and from the folder of its target, since Pi may
use either. Package imports are left out
because `node_modules` comes from an install and a repository does not
commit it.

### Why the script an MCP server or package manager runs is hashed

`node ./tools/mcp.js` runs the file, and a pull request can change it under
the same command line. The arguments of a stdio server, and the entries of
`npmCommand`, that name a file inside the folder are hashed like an extension,
imports included. So is the file `shellPath` names, which Pi runs as the shell
for every command. A file outside the folder is skipped: `command` is often an
absolute path to an installed program such as `node`, and hashing it would
ask again after every upgrade. `shellCommandPrefix`, `externalEditor` and
`!command` values are shell text, so what they read is not followed.

### Why a remote MCP server counts only when its values run something

A remote server runs on another machine, and its tools reach the model the
same way text in `AGENTS.md` does, which Pi loads without trust. It counts
when `headers` or `oauth.clientSecret` hold a `!command`, which runs here, or
an environment variable such as `${DOCS_TOKEN}`, which hands a value from the
server's environment to a host the repository names. Pi's docs also advise keeping servers with
credentials in the user's file. A header with a literal value runs nothing
here and sends nothing of the user's. Pi rejects `auth` in a
project file, so it is not read.

### Why entries Pi would reject still count

An MCP server with a bad name or a `command` and a `url` together, an extension
a `-path`, `!pattern` or glob entry switches off, a file `.gitignore` lists in
`.pi/extensions`, and the whole folder before a glob in a local package's
manifest are listed although Pi 1.5 would skip or narrow them. The
assessment errs toward asking: a list that matched Pi exactly would let code
through the first time Pi's validation changes, and the cost of the
difference is a line in a dialog. Missing paths are the exception. A path that
does not exist runs nothing, and when it appears the fingerprint changes.

### Why paths outside the folder are shown absolute

A path inside the folder appears relative to it, so a checkout and its
worktrees produce the same fingerprint and share trust. A path outside, such
as `~/pi-ext/one.ts`, a package kept next to the repository or a file a
manifest loads from elsewhere, appears in full.
A relative form such as `../../shared` would differ between worktrees that sit
at different depths and ask once per worktree.

### Why `--approve` also goes to a folder that runs nothing

A folder without extensions, packages or MCP servers can still carry skills,
prompt templates, `SYSTEM.md` and settings such as the default model. Pi
loads those only for an approved project, so `--no-approve` would make them
vanish for every plain project. They are text, and the assessment found
nothing to run, so the child gets `--approve`.

### Why the server guards `fetch` globally

Server features call OpenCode with folders the UI hands them, each through a
client of its own (session titles, routing, dispatched sessions, scheduled
runs, the agent's OpenChamber tool). A check per feature missed the session
title lookup in testing and would miss the next feature too. One guard on the
process's `fetch` covers all of them; requests to any other origin pass
untouched. The proxy forwards through `http-proxy-middleware`, not `fetch`, so
it keeps its own middleware.

### Known limits

- The decision is made when a child starts. A running child reads the
  folder again on `/reload` or the reload command, so a branch switch with
  new extensions loads them under the old answer. A process that reloads
  calls `approvalFlagFor` again and restarts with the answer.
- A process started with `--approve` trusts every folder it later enters:
  Pi applies the flag to each working directory of the process, so a
  `switch_session` or `/resume` into a session of another folder loads that
  folder's extensions. One child serves one folder.
- Pi reads the project `sessionDir` before it resolves trust, also under
  `--no-approve`, so a folder can redirect where sessions are written.
  `--session-dir` on the command line overrides it, and every child gets one.
- A package Pi installs lands in `.pi/npm` or `.pi/git`, which the
  assessment does not hash: Pi writes them itself, and hashing them would ask
  again after every install. A repository that commits its own copy there and
  changes it later runs the new code under the same fingerprint. With
  `--offline` a missing package is not installed, but one that is already
  there loads.
- An extension's imports are followed when they name a file by a literal
  relative or absolute path. Package imports, `tsconfig` path aliases,
  computed import specifiers and files an extension reads and evaluates
  itself are not, so a change behind one of them does not ask again.
- A folder past 500 files or 16 MB is hashed by path and size beyond that
  budget, and its imports are followed within a budget of the same size. Past
  20,000 entries a folder is not walked further.
- A manifest the module cannot read (past 1 MiB, a pipe) may name files
  outside its folder or package that are not followed.
- An extension installed in the user's own Pi that reads project files with
  its own rules, such as `pi-mcp-adapter`, is outside this check.
- The agent's own `session_move` tool runs inside OpenCode and reaches no
  OpenChamber runtime, so the gate does not see it. OpenCode opens the
  destination from there as it would for the CLI.
