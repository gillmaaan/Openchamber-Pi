# Catalog routes: decisions, gaps, open questions

`catalog.js` serves the read-only routes of the OpenCode 2.2.6 dialect from Pi:
`/api/info`, `location`, `project`, `vcs`, `vcs/branch`, `config`, `config/shell`,
`model`, `model/default`, `provider`, `agent`, `agent/:id`, `command`, `skill`,
`mcp`, `shell`, `integration`, `plugin`, `permission/saved`, `credential`. The
header of `catalog.js` documents `deps`. The helper modules next to it hold one
concern each (`model-info`, `config-documents`, `integrations`, `mcp-servers`,
`pi-resources`, `git-info`, `project-list`, `pi-files`, `builtin-agents`).

`catalog.test.js` (49 tests) runs the handlers through `createBridgeHttpServer` on a
loopback port over an isolated Pi installation, compares key paths and envelopes
with responses captured from OpenCode (`../fixtures`, trimmed), and decodes the
bodies with OpenCode's own schema (`@opencode/schema`, Effect Schema; it runs from
plain Node, with `effect` resolved next to the schema instead of imported by name).

## What was captured from a live OpenCode 2.2.6

The goldens lack some cases, so an isolated `opencode serve` was started in the
scratchpad (own HOME and XDG dirs, port 56341, stopped afterwards) and these were
read from it. They are in `../fixtures`.

- `GET /api/vcs` outside a repository is `{ location, data: { branch: {} } }`, no
  `provider`; `GET /api/vcs/branch` there is `data: []`. In a repository the first
  read of a cold location can answer `branch: {}` and fill in a moment later; the
  bridge has no cold start and answers complete.
- `GET /api/credential` is `{ data: [Credential.Entry] }`, no `location`:
  `{ id: "cred_...", integrationID, label, active, value }` with `value`
  `{ type: "key", key }` or `{ type: "oauth", methodID, access, refresh, expires, metadata? }`.
- `GET /api/mcp` entries are `{ name, status: { status, error? }, integrationID? }`.
  `status` is an object, not a string.
- `GET /api/model` lists `none` among the variants of a model that can switch
  reasoning off, and prices a model as an array of tiers.

## Decisions

- **Version.** `/api/info.version` is the wire version `2.2.6`. Beside it, outside
  the wire: `agent: { name: "pi", version }`, read from Pi's `package.json` (the
  package does not export it; the entry point is resolved with `import.meta.resolve`
  and the walk goes up to the manifest). `capabilities.persistentPty` is `false`: the
  bridge has no PTY routes.
- **Variants and `off`.** A reasoning model gets one variant per level Pi supports,
  `off` included, as `{ id, settings: { reasoningEffort: id } }`. OpenCode lists
  `none` for the models that can run without reasoning, and without `off` the picker
  could never turn thinking off. Pi's own rule already drops `off` for a model that
  maps it to null. A model that cannot reason has no variants. The ids are Pi's, so a
  variant maps one to one onto `set_thinking_level`. The picker's "Default" sends no
  variant, which Pi resolves from `defaultThinkingLevel` and `modelThinkingLevels`;
  the session service has to keep that meaning when it applies a model switch.
- **Cost.** One untiered entry from Pi's per-million prices, plus one tier per Pi
  tier (`inputTokensAbove` becomes `tier.size`). No price at all (a local server in
  `models.json` leaves them at 0) is `[]`, which is what OpenCode serves for a model
  it has no price for. `useConfigStore` reads `model.cost.find(...)`, so the field must
  be an array.
- **`package` and `settings`.** `package` maps Pi's `api` to OpenCode's native package
  names, because `custom-provider-form.ts` infers a provider's protocol from them
  (`openai-completions` is `@opencode/ai/providers/openai-compatible`, `openai-responses`
  is `.../openai`, `anthropic-messages` is `.../anthropic`; the rest get the nearest
  name or `pi:<api>`). `settings.baseURL` comes from the model's or provider's `baseUrl`.
- **Keys never leave in `settings`.** OpenCode serves a literal `apiKey` in provider
  and model settings. The UI only asks whether `settings.apiKey` is non-empty
  (`providerAuth.ts`), so a key written in `models.json` becomes `********`, and an
  environment reference (`$NAME`) becomes `{env:NAME}`. `headers` of `models.json` are
  not copied at all (they carry tokens). The key itself is only on `/api/credential`.
- **Providers listed.** Every Pi provider with a working credential: stored in
  `auth.json`, a key in `models.json`, or an environment variable. `activation` is
  `enabled` for a provider written in `models.json` (OpenCode: a config entry) and
  `auto` for the others (OpenCode's value for a built-in with a login). This differs
  from the brief, which said `enabled` throughout; the UI only filters on `disabled`.
  No `models` inside, as in the wire spec. A model whose provider is missing here
  would be dropped by `useConfigStore`, so the list is derived from Pi's availability,
  not from `auth.json` alone.
- **Default model.** `defaultProvider` and `defaultModel` of `settings.json` (a
  project's `.pi/settings.json` wins), if that model is usable, else the first usable
  chat model, else `data: null`.
- **`types`.** Matched exactly. No `types`: chat only. `types=chat&types=image` adds Pi's
  image models (`getAllAvailable()` entries of type `image`; output `["image"]`,
  `tools: false`, `limit: { context: 0, output: 0 }` since Pi has no limits for them).
  The comma form matches nothing, as OpenCode does. Pi's classifier models are never
  served: an open question whether OpenCode's `decision` type should map to them.
- **Config documents.** `models.json` (providers in the shape the Providers page reads),
  global `settings.json` (`model`, with `variant` only when the file sets
  `defaultThinkingLevel`), project `.pi/settings.json`, then the directories. A missing
  file has no document. `apiKey: "$NAME"` becomes `env: ["NAME"]`; other keys are
  dropped. MCP, plugins and skills are not folded into `info`: the UI reads MCP config
  through OpenChamber's own routes, and the Pi semantics of `skills` entries (`!glob`,
  `+path`) are not OpenCode's.
- **Agents.** Built-ins are verbatim from golden 02, including the OpenCode prompts of
  explore, title and summary. Plan's one path rule (`edit` allowed under the plan folder)
  takes `getPlanDirectory()`, default `~/.opencode/plan`. `agentStore.list(directory)`
  profiles are appended; one with a built-in's id replaces it. A store that throws is a
  503, not "built-ins only": the user's agents would vanish silently.
- **Commands.** `init`, `review`, `goal` plus Pi prompt templates under
  `<agentDir>/prompts` and `<dir>/.pi/prompts`; description from frontmatter, else the
  first line cut at 60 characters, as Pi does. Discovery is recursive to preserve the
  editor's nested names, unlike Pi's native direct-child scan. Directory symlinks are
  not traversed. `bridge/commands.js` resolves those names before sending text to Pi.
  A template replaces a built-in of the same name. Project templates win over global ones.
- **Command execution.** Measured against OpenCode 2.2.6 in isolated runs: a command's
  `agent` and `model` switch the session durably before its turn (both emit their usual
  selection events); a named agent applies its pinned model, and an agent without one
  keeps the session's explicit model. A command that names no agent keeps the session's
  agent and model. `subagent: true`, or a named subagent-mode agent without
  `subagent: false`, runs the command in a child session: HTTP answers 204 at once, the
  parent stays idle, and the child's report starts the parent's next turn. The parent's
  selection is never changed by a child command. An expanded body that starts with `/` is
  sent with one leading space so Pi does not expand it a second time. `resolveCommandRun`
  refuses a model or thinking level the catalog does not offer before it persists anything.
  Three gaps remain:
  the parent sees the report as a user-shaped message with `metadata.source: "subagent"`
  rather than OpenCode's `synthetic` message; a command switch writes no
  `agent-switched`/`model-switched` transcript entry (OpenCode writes both, and Pi's first
  `model_change` entry is read as the session's starting model); and `goal` is listed but
  has no template the resolver can find.
- **Skills.** Each folder is scanned with Pi's own `loadSkillsFromDir`, so ignore files,
  symlinks, name rules and "a SKILL.md ends the recursion" are Pi's. The bridge chooses the
  folders as Pi's package manager does: `<dir>/.pi/skills`, `.agents/skills` from the folder up to
  the repository root (no further; without a repository up to the filesystem root),
  `<agentDir>/skills`, `~/.agents/skills`. A `.agents/skills` folder takes no loose Markdown
  files. First name wins, project before user. `content` is the body without frontmatter,
  `disable-model-invocation: true` is `autoinvoke: false`. A malformed `SKILL.md` is skipped
  and logged; the others are still listed. `prompting.js` resolves a prompt's `skills` through
  `config-routes/skills.js`'s store, with the folder's trust read afresh at prompt time, and
  attaches each body as `<skill_content name="…">` ahead of the prompt text; an id no scan
  holds is a 400 before any inbox item is accepted. The Skills page writes and edits those
  same folders. Skills a package or the `skills` setting adds need Pi's package manager and
  are not found.
- **MCP.** `<agentDir>/mcp.json` and `<dir>/.pi/mcp.json`, merged as Pi merges them (a project
  entry replaces the global one; an entry with no `command`, `url` or `type` only overrides
  `enabled`, `exposure`, `toolExposure`). `enabled: false` is `disabled`; without a status
  read every other server is `pending`. `getMcpStatus` fills `connected`, `failed` and
  `needs_auth` from `pi mcp list --json` (`config-routes/mcp.js`'s status cache, 30 s per
  folder, invalidated by a config edit); the server passes the provider, so the list shows
  live state. A name Pi rejects, or a project override of a server that does not exist, is
  skipped and logged. A missing file is an empty list.
- **Integrations.** One per Pi provider, id = provider id. Methods: `key` when Pi's provider
  takes a key, `oauth` (method id `oauth`, label from Pi's `loginLabel`) when it has OAuth, and
  an `env` method only for a variable Pi found set (Pi does not list the names for an unset
  one). Connections: a stored credential (`cred_<providerId>`, method `key` or `oauth`) and the
  environment variable. A key in `models.json` is shown on the provider instead.
- **Plugins.** Entries of `packages` and `extensions` in global and project `settings.json`,
  names only. `npm:` and `git:` sources are `package` with the spec as `target` (a version only
  when an `npm:` spec carries one); paths are `local` and resolve as Pi does (`~`, the agent
  directory for global settings, `<dir>/.pi` for project ones); `builtin:<name>` is `builtin`.
  `active` means configured, not loaded; a local path that does not exist is `failed`.
  `!`, `-` and `+` filter entries are not plugins and are skipped.
- **Credentials.** `<agentDir>/auth.json` as OpenCode's list, secrets included. A `!command` key
  is left out (listing it would mean running the command in a read route), as is an entry that
  is neither a key nor a login; both are named in the log. The key `env` map Pi allows on an
  API-key credential is not passed on. OAuth extras go to `metadata` and `accountId` is also
  given as `accountID`, the spelling `auth.js` reads. An unreadable `auth.json` is a 503, never
  `{ data: [] }`. Only the HTTP layer's Basic auth guards the route. `json()` cannot set headers,
  so the response has no `cache-control: no-store`.
- **Projects.** Folders from `listKnownDirectories()` grouped by project id; `canonical` is the
  main checkout, a linked worktree is a sandbox. Entries may be `{ directory, time }`; for a
  plain path the times are the project folder's birth and modification time.
- **VCS.** Outside a repository: `{ branch: {} }` and `[]`. In one: `current` from
  `symbolic-ref HEAD` (left out when detached), `default` from `origin/HEAD`, else `main` or
  `master` if it exists, else the current branch. Branches are the local ones, with `search`
  and `limit`. If git cannot run, the answer is what is known (`{ provider: "git", branch: {} }`)
  and the reason is logged.
- **Damaged files.** Pi keeps going with its built-in providers when `models.json` does not
  parse and records the error; so does the bridge, and it logs the message once. An unparsable
  `auth.json` makes Pi's availability check throw: `model`, `provider` and `integration` answer
  503 (declared for the first two) instead of an empty catalog. A corrupt `settings.json` or
  `mcp.json` is logged and treated as absent for that file only.

## Trust

Pi loads a project's `.pi/*` and `.agents/skills` only for a trusted project (`trust.json`,
`defaultProjectTrust`). The routes do not decide that. `deps.isProjectTrusted(directory)` is asked,
once per request and only by the routes that read project files, and when it answers false the
project's settings, prompts, skills and MCP config are left out. The default is "readable", which
matches the children `launch.js` starts with `--approve`. The coordinator decides, probably with
Pi's `ProjectTrustStore`; if trust is ever stricter than `--approve`, this hook is where the list
and the loaded resources are kept consistent.

## Changes to `../../catalog.js` (additive)

`models({ availableOnly, types })` takes `types`; each model carries `output` and `baseUrl`;
`providers()` runs one availability pass first and adds `sourceLabel`, `auth.oauthLoginLabel`,
`api`, `baseUrl`; `configError()` returns Pi's `models.json` parse error. The availability pass is a
fix: Pi fills its auth status only after one, so an environment key showed as `configured: false`
until `models()` had run once. Existing `catalog.test.js` passes unchanged.

## Gaps

- Catalog events (`config.updated`, `provider.updated`, `model.updated`, ...) when `~/.pi/agent`
  changes. Every route reads the file again per request, but the catalog's runtime holds
  `models.json` until `catalog.reload()`; `auth.json` edits are seen at once.
- Plugin load state, `cache.ttl` of models (Pi has `promptCache`; session warming pings on its
  own schedule without it), model release dates (`released: 0`, so the small-model pick falls
  back to the id tiers). MCP connection state is no longer a gap when the server passes
  `getMcpStatus`.
- Not served by the bridge: `PATCH`/`DELETE` of credentials and saved permissions,
  `POST /api/plugin/check|update`, `/api/vcs/status|diff|base|init`. Provider integrations
  and their key/external/OAuth connect routes are served; remote MCP servers with OAuth join
  that list as `mcp_…` entries whose attempts run `pi mcp login` (`bridge/mcp-oauth.js`).
  The MCP config and connect routes are registered by the web server, not the bridge. A
  saved-permissions list is empty because the permission flow has none yet.
- Skills and prompts from packages or the `skills`/`prompts` settings.
- `.agents/skills/openchamber-ui-guidance/SKILL.md` in this repository has an invalid YAML
  description (an unquoted `: `), so Pi skips it; the real run logged it. Outside this task.

## Open questions

1. Where may the plan agent write? `~/.opencode/plan` is OpenCode's folder; Pi has none.
2. Should OpenCode's `decision` model type map to Pi's classifier models?
3. A `!command` API key: is "not listed" right for the quota readers, or should the bridge run
   the command once through Pi's `ModelRuntime.getAuth` (what Pi does per request)?
4. Who fires the catalog events and calls `catalog.reload()`: the coordinator's file watcher?
5. `activation: auto` for built-in providers: keep OpenCode's value, or `enabled` throughout?
