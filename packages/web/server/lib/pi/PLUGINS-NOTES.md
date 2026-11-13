# Plugins on Pi: packages and extension files

What OpenCode called a plugin entry is a Pi package in `settings.json` `packages`. What it called a plugin file is a file in an `extensions/` folder. The Settings Plugins page keeps its URLs and its payload shapes; the server underneath changed.

## Files

| File | Owns |
|---|---|
| `packages.js` | `createPiPackages(...)`: list, add, remove, update, updateTargets, updateEntry, setEnabled, check, contributions, searchRegistry, registryInfo, extension file operations. `createPiTrustReader`, `describeManagedExtensions`, `MANAGED_TOOLS`. |
| `packages-sources.js` | Which source strings reach `pi install`, how a settings entry is read, where Pi keeps the package, semver order. |
| `packages-settings.js` | Read and write `settings.json` (lock compatible with Pi's, symlink safe), the enabled switch, resource filters, extension override entries. |
| `packages-cli.js` | `createPiCliRunner()`: runs Pi's bundled `cli.js` (found next to `rpc-entry.js`), no shell, stdin closed, bounded and sanitized output, timeout that ends the process group. |
| `config-routes/plugins.js` | `createPluginConfigRoutes({ packages, resolveOptionalProjectDirectory, readSettings?, onChanged?, logger?, app? })`. Returns `{ register(app) }`; with `app` it registers at once. |
| `bridge/routes/plugins.js` | `createPluginBridgeRoutes({ packages, getDefaultDirectory, readSettings?, onChanged? })`: the `/api/plugin` list, `POST /api/plugin/check`, `POST /api/plugin/update`. Register it before the catalog's `/api/plugin`. |

Wiring, in the order the host needs it:

```js
const packages = createPiPackages({
  getAgentDir,                      // PI_CODING_AGENT_DIR or ~/.pi/agent
  isTrusted: isProjectTrusted,      // see "Trust" below
});
```

Everything else has a default: `runPi` is the CLI runner, `fetchRegistry` uses `fetch` with a 5 second timeout, the registry request (URL and auth) comes from the user's `.npmrc` through `opencode/npm-registry-config.js`, `fs` is `node:fs/promises`. Tests inject all of them. That import from `../opencode/` has to move with the OpenCode removal.

`onChanged` fires after a change that reaches Pi: `{ directory, scope, what: 'package' | 'extension' }` from the config routes, `{ directory }` from `/api/plugin/update`. A running Pi process keeps what it loaded. The host should emit `plugin.updated` and stop idle children (the way `managed-runtime.js` does with `generation`), so the next prompt starts with the new set.

## What Pi does that the code relies on

All of this was run against Pi 1.5.0, not read from the docs alone.

- `pi install <source> [-l]` installs first and writes `settings.json` second. A failed install leaves the file as it was. A relative local path is stored relative to the settings file (`../pkg`), so a source in settings is not the string the user typed.
- With a settings file Pi cannot parse, `pi install` prints a warning, installs, exits 0 and records nothing. `add` checks the file first and refuses (`SETTINGS_INVALID`), and checks that the entry is there afterwards (`INSTALL_NOT_RECORDED`).
- `pi remove` and `pi update` resolve a relative local path against their working directory, not the settings file. Local packages are always passed by absolute path.
- `pi remove` of a package that was never installed succeeds and removes the entry. `pi update` of an exact npm pin or a local path succeeds and does nothing.
- Saving the whole `packages` list is how Pi writes it, so two installs into one file at once lose one. Every mutation runs in a per-settings-file queue.
- Without a flag, Pi lets `pi install -l` into a folder with nothing under `.pi` pass, and after the first install `.pi/settings.json` exists and every later `-l` command needs a saved decision in `<agent dir>/trust.json`. Every project-scope command here therefore carries `--approve`, after `isTrusted` said yes for the folder, so the host's decision is the only one.
- `[]` for all four resource types in a package object loads nothing for a package folder (checked with `get_commands` on a real `pi --mode rpc`). A package that is a single extension file ignores filters and always loads, so it has `switchable: false`, is always `enabled`, and refuses the off switch and filters with `NOT_SWITCHABLE`. A package object may carry unknown keys; Pi keeps them.
- Extension files are switched with `-extensions/<name>` and `+extensions/<name>` in the settings `extensions` list, relative to the settings folder. That is what `pi config` writes. Pi discovers only `.ts` and `.js` files and folders with an `index.ts`/`index.js` or a `pi.extensions` manifest, one level deep. `.mjs` and `.cjs` are never loaded.

## Sources that are accepted

`add` accepts `npm:name[@version|tag|range]` (a bare `name[@version]` becomes an `npm:` source), `git:host/user/repo[@ref]`, `git:git@host:user/repo`, `https://` and `ssh://` repository addresses, `github:`, `gitlab:` and `bitbucket:` shorthands (rewritten to `git:host/...`), and local folders or files (`./x`, `../x`, `/x`, `~/x`, `file:///x`, made absolute). Everything else is `UNLOADABLE_SPEC`: Pi would read a bare `foo/bar` as a folder named that, and `http://` or `git://` clones without encryption.

A git source also refuses credentials in any spelling (`https://user:token@`, `git:user:token@host/...`, a query string), `#` (a ref is written `@ref`, because Pi hands an `#ref` to `git checkout` unchecked), and a name, host or ref that starts with `-`, which would reach npm or git as an option. Messages never repeat what looks like a credential.

A relative local path in `add` resolves against the project folder when one is given, and is refused without one. In `PATCH` a changed spec resolves against the settings folder, which is how the page shows it.

## Fields the page reads, and how they are filled

Entry (`GET /api/config/plugins` `entries[]`, a configured package):

| Field | Value |
|---|---|
| `id` | base64url of `config:<scope>:<source>`, as before |
| `spec` | the source string exactly as settings.json holds it (`npm:@scope/pkg@1.0.0`, `git:github.com/u/r@v1`, `../pkg`) |
| `parsedKind` | `npm`, `git`, or `path` (local folder; also a source Pi cannot place). `control` never occurs |
| `sourcePath` | the settings.json that declares it, so the page resolves a relative local spec the way Pi does |
| `options` | the package's resource filters (`{ extensions?, skills?, prompts?, themes? }`), present only when the package is on and filtered. The page's options JSON field edits them. Anything else in `options` is refused with `INVALID_OPTIONS` |
| `switchState` | `on`, `off`, or `unavailable` (project not trusted, or a single-file package). Never `unreadable` or `overridden` |
| `policyResource` | `plugin:<npm name or resolved path or source>`. It is only a key. Pi has no policy engine, so there is nothing to check it against |
| `resolvedPath` | local packages only |
| `legacy`, `kind` | `kind` is always `config`; `legacy` is gone |
| new: `name`, `version`, `installed`, `installedPath`, `enabled`, `switchable`, `loaded`, `notLoadedReason` | `notLoadedReason` is `project-not-trusted`, `not-installed`, or `disabled` |

File (`files[]`, an extension file or folder): `kind` is `file` for a `.ts`/`.js` file and `package` for a folder (display and switch only). New: `enabled`, `loaded`, `notLoadedReason`. `policyResource` is `plugin:<absolute path>`.

The list response adds `managed`, `projectTrusted` (`null` without a project) and `settingsErrors` (`[{ scope, path, message }]`). A settings file that does not parse is listed there and contributes no rows; the route still answers 200.

Mutations answer `{ success, message, ... }` as before, with `path`, `scope` and `id` where they apply. Deleting an extension file also answers a `warning` when the file went but a leftover switch entry could not be cleaned up. They never set `requiresReload`, so the page reloads its list only. The message says running sessions pick the change up when they restart.

Errors are `{ error, code }` (plus `detail` for a failed install):

| Status | Codes |
|---|---|
| 400 | `INVALID_SCOPE`, `INVALID_SPEC`, `UNLOADABLE_SPEC` (the page marks the spec field on this one), `INVALID_FILENAME`, `INVALID_DIRECTORY`, `INVALID_STATE`, `INVALID_OPTIONS`, `IDENTITY_CHANGED` |
| 403 | `PROJECT_NOT_TRUSTED` |
| 404 | `NOT_FOUND` |
| 409 | `ENTRY_EXISTS`, `FILE_EXISTS`, `SETTINGS_INVALID`, `PACKAGE_DISABLED`, `NOT_SWITCHABLE` |
| 502, 503, 504 | `INSTALL_FAILED`, `REMOVE_FAILED`, `UPDATE_FAILED`, `INSTALL_NOT_RECORDED`, `REGISTRY_UNAVAILABLE`, `CONTRIBUTIONS_UNAVAILABLE`, `PI_UNAVAILABLE`, `SETTINGS_LOCKED`, `PI_TIMEOUT` |

The page's store reads only `UNLOADABLE_SPEC` and `SWITCH_OVERRIDDEN` from the body; every other failure becomes "Failed to ..." in the UI. Showing `error` for `PROJECT_NOT_TRUSTED` and `INSTALL_FAILED` needs a store change.

Routes beyond the old set:

- `GET /api/config/plugins/search?q=&from=&size=` returns `{ total, results[] }`. Each result has `name`, `source` (`npm:<name>`), `version`, `description`, `keywords`, `date`, `publisher`, `links`, `weeklyDownloads`, `monthlyDownloads`, `flaggedInsecure` and `installed: [{ id, scope, enabled }]`. Empty `q` lists the most popular `pi-package` packages. A result is not vetted: the gallery lists whatever carries the keyword.
- `GET /api/config/plugins/entry/:id/contributions` returns `{ installed, root, extensions[], skills[], prompts[], themes[] }`. Each item has `name`, `path`, `relativePath`, `enabled` (false when a filter turns it off) and, for skills and prompts, `description`. The answer comes from Pi's own resolver (`DefaultPackageManager.resolve` with missing packages skipped), so manifests, globs and filters mean what they mean to Pi. `installed: false` is an answer, not an empty list.

`PATCH /entry/:id` changes the filters (`options`) and may change the spec to another spelling of the same package, such as a new version of an npm package; that runs `pi install` for the new source and Pi replaces the entry in place. Another package is refused (`IDENTITY_CHANGED`). The page sends the spec it shows on every save, and an unchanged spec is not touched.

## The bridge inventory

`GET /api/plugin` returns one row per package or extension Pi would load for the folder. Packages are `{ type: 'package', target: <settings source>, version?, outdated? }`, local folders and extension files are `{ type: 'local', path }`, managed extensions are `{ type: 'builtin' }`. A package that is switched off is left out, which the page reads as "not loaded". An enabled package that is not installed, or belongs to an untrusted project, is `state: { status: 'failed', error }` with the reason in `error`. `check` flags `outdated` for npm packages that follow `latest` (no version) or a dist-tag (`@next`) and whose target is newer. An exact pin is never flagged, and a range such as `^1.0.0` is reported with the latest release and `rangeLimited: true` but not flagged, because `pi update` stays inside the range and evaluating it needs semver ranges. A package whose registry answer failed gets no flag. `update` takes `targets` (the source strings), runs `pi update` for each, stops at the first failure and answers 204.

The page matches rows by `source.target`, and a local row by path. A local source written as `~/pkg` is a package target for the page (`configEntryRuntimeTarget`) but a local path here, so it shows "not reported". Pi writes relative paths itself, so only a hand-written `~/` entry hits this.

## Trust

`isTrusted(directory)` answers whether OpenChamber runs Pi for that folder with its project resources. Everything project scoped follows it:

- Adding, removing, updating, switching, editing or deleting a project package or extension file refuses with `PROJECT_NOT_TRUSTED` before anything is written. A trust check that throws means not trusted.
- Listing still works. Project rows carry `loaded: false`, `notLoadedReason: 'project-not-trusted'`, `switchState: 'unavailable'`, and `projectTrusted: false` is in the response. Reading a project extension file is allowed.
- `contributions` refuses, because Pi resolves nothing for an untrusted project.
- A project-scope command passes `--approve` for that one command and only after `isTrusted(directory)` answered yes; a global command passes nothing. A folder `isTrusted` refuses never reaches Pi.

`createPiTrustReader({ getAgentDir })` is the default. It decides as `pi install -l` does without a terminal: the closest saved decision in `trust.json`, else a folder with nothing to protect is trusted, else `defaultProjectTrust: "always"`. A corrupt `trust.json` means not trusted.

Two things the host has to keep consistent:

1. The host injects its own `isTrusted` (OpenChamber's folder trust, `approvalFlagFor`). A project it trusts works for every command even when Pi's `trust.json` says no, because `--approve` overrides it. A project the user distrusted in Pi's own terminal but trusted in OpenChamber is therefore changed here; Pi's own terminal keeps asking.
2. `loaded` is true for a project row when `isTrusted` is true. That is only honest if the same answer decides `approveProject` in `buildPiRpcArgs` (it now defaults to `--no-approve`). A Pi started with `--no-approve` loads nothing from the folder, which the packages test proves with `get_commands`.

## Managed OpenChamber extensions

`managed` in the list response (and `builtin` rows in `/api/plugin`) are not Pi packages and cannot be removed:

- `openchamber.managed-tools`: `enabled` when any tool is on. `tools[]` has one item per Settings flag with `flag` (the `managedToolFlags` key), `setting` (the Settings key, for example `agentScheduleToolEnabled`), `names` (the tools it registers) and `enabled`. The defaults come from `managedToolFlags`, so they have one source.
- `openchamber.gate`: always on.

Both have `readOnly: true`. The Plugins page should show them as built-in cards without a delete action, and each tool's switch should write the Settings flag the existing Settings toggles already write, not a plugin switch. `packages.test.js` checks the table in `MANAGED_TOOLS` against `managedToolFlags` and `managedToolSpecs`.

## Decisions

### Why `pi install` and not a settings write
Installing needs npm, git, dependency installs and Pi's own checks. Running the CLI keeps those identical to what a user gets in a terminal, and a later `pi list` agrees. The cost is a process per call and Pi's trust rules for `-l`.

### Why the switch is a settings write
Pi has no command for "off". `pi config` is a terminal UI. The all-`[]` object is Pi's documented way to load none of a package, and the plain string is "load everything". Filters the user wrote before switching off wait in `openchamberFilters` inside the same entry and come back on switching on, so a package narrowed to one extension does not start loading all of them. Pi keeps unknown keys on a package object.

### Why a glob is matched without a regular expression
`!glob` entries in a project's `settings.json` are read for the listing, which has to work before the project is trusted. Compiling them to a regular expression lets a crafted pattern freeze the server for minutes. The matcher walks a table, bounded in pattern length (200), pattern count (200) and path length (1024); what exceeds a bound does not match.

### Why the CLI runner settles on exit
A package's install script can leave a daemon that holds Pi's pipes. Waiting for the pipes to close would hold the call, and the settings queue behind it, until that daemon ends. The runner settles 300 ms after exit and closes the pipes.

### Why the settings writer has its own lock
Pi writes a settings file under a `<file>.lock` directory (proper-lockfile). The writer takes the same lock with `mkdir`, waits up to 2 seconds, and takes over one older than 10 seconds, as proper-lockfile does. A write goes to a temp file next to the real file and is renamed, and a symlinked settings file stays a symlink.

### Why local packages are passed by absolute path
Pi stores `../pkg`, but `remove` and `update` read what they are given against the current directory. An absolute path means the same thing in every command and every scope.

### Why the registry check uses registry JSON and not `npm view`
The request goes through the injected `fetchRegistry`, with the registry and credentials of the user's `.npmrc`, so tests never reach the network and no `npm` binary is needed to look. Limits: git packages are not checked (`checked: false`), and a range is not flagged (see the bridge section). The credentials are sent only to the registry the `.npmrc` names; the `pi-package` search goes to registry.npmjs.org without any.

### Why contributions use the Pi SDK
Manifest paths, globs, `!` and `+` entries and per-resource filters are Pi's rules. Rewriting them would drift. The SDK is already loaded by the catalog, and `resolve(async () => 'skip')` installs nothing.

## Not covered

- Git packages are not installed in any test: there is no offline git remote Pi accepts. Source parsing and settings handling for git are unit tested; a real `pi install git:` was not run.
- npm installs were run only to the point of failure (an unreachable registry), which proves settings stay untouched. A successful npm install from a registry was not run.
- `pi update` for an npm package with a newer release was not run (needs a registry). The pinned and local no-op paths were.
- `pi update <source>` of a project package reads Pi's saved trust only. If the same source is also in user scope, Pi updates that copy, exits 0, and the project request looks done.
- Extension files in the settings `extensions` list (explicit paths) are not listed. Only the `extensions/` folders are.
- Windows paths are handled by `node:path`, and not tested.
- `autoload: false` project deltas over a user package are preserved but not shown.
- Pi's own `-e` packages are not part of any list.

## What the UI still says

Strings and code that still describe OpenCode plugins (not edited here):

- `packages/ui/src/lib/i18n/messages/en.settings.ts` and the other `*.settings.ts` locales: `settings.plugins.switch.blockedByConfig`, `overriddenByConfig`, `unavailable`, `notAvailable`, `unreadable`, `settings.plugins.toast.reloadFailed`, `settings.plugins.status.notReported.description`, `settings.plugins.status.unknown.description`, `settings.plugins.toast.checkFailed`, `settings.plugins.validation.fileName` (lists `.mjs` and `.cjs`), `settings.plugins.validation.specUnloadable`, `settings.plugins.page.field.spec.placeholder`.
- `packages/ui/src/lib/i18n/messages/plugins-grid.i18n.ts`: `settings.plugins.grid.description` in every locale.
- `packages/ui/src/components/sections/plugins/AddPluginDialog.tsx`: `FILENAME_PATTERN` accepts `.mjs` and `.cjs`, which Pi never loads; the options field is now the filter JSON.
- `packages/ui/src/components/sections/plugins/PluginsGrid.tsx`: the switch is gated on `useIntegrationPolicyState` and `policyResource` (OpenCode's policy rules) and on `refreshAfterOpenCodeRestart`; none of that applies to Pi.
- `packages/ui/src/stores/usePluginsStore.ts`, `components/sections/plugins/pluginLoadState.ts`, `usePluginRuntimeStatus.ts`, `PluginStatusBanner.tsx`, `lib/opencode/plugins.ts`: comments and types describe OpenCode's inventory. The wire shape is the same, so they work unchanged.
