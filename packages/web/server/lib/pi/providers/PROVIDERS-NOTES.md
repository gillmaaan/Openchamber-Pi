# Providers, API keys and logins on Pi

Module notes for `packages/web/server/lib/pi/providers/`. The module replaces
what `lib/opencode/{providers,auth,routes}.js` did for providers with the same
URLs and response shapes, over Pi's files.

## Ownership

- `service.js`: one object (`createProviderService`) that owns every provider
  write and read. The two route faces below call it and add nothing of their own.
- `bridge-routes.js`: `createProviderBridgeRoutes({ providers, getDefaultDirectory })`,
  the OpenCode wire dialect (`/api/integration…`, `/api/credential/:id…`).
- `config-routes.js`: `registerProviderConfigRoutes(app, { getProviders })`, the
  Express routes the Providers page and the custom-provider form use.
- `oauth-flows.js`: the stateful sign-in attempts around `ModelRuntime.login(provider, 'oauth', …)`.
- `login-plan.js`: finds what a provider's API-key login prompts for.
- `custom-provider.js`: the form's provider config to and from a `models.json` entry.
- `models-file.js`, `model-settings.js`, `provider-state.js`, `json-document.js`: the files and their one write rule.
- `catalog.js` (one level up) gained, additively: `getHiddenProviders` option,
  `providers({ includeHidden })`, `getRuntime()`, `listCredentials()`, `login()`.

## Composition (what the coordinator wires)

```js
// bridge/index.js
const providerState = createProviderState({ stateDir: piDataDir });
const catalog = createPiCatalog({ getAgentDir: () => agentDir, getHiddenProviders: providerState.disabledProviders });
const providers = createProviderService({ catalog, state: providerState, hub, getAgentDir: () => agentDir, getDefaultDirectory, log });
const routes = [
  ...createProviderBridgeRoutes({ providers, getDefaultDirectory }),   // BEFORE createCatalogRoutes: first match wins
  ...createCatalogRoutes({ catalog, ... }),
  ...
];
// return { ..., providers }; in close(): providers.close()

// server/index.js, where registerOpenCodeRoutes ran
registerProviderConfigRoutes(app, { getProviders: () => piBridge?.providers ?? null });
```

`getHiddenProviders` is what makes a provider switched off in Settings leave
`/api/provider`, `/api/model` and the integration list; without it the switch is
stored and has no effect.

### Old registrations to stop

In `lib/opencode/routes.js` (`registerOpenCodeRoutes`), these six, and nothing else:

| Route | Replaced by |
|---|---|
| `GET /api/provider/disabled` | `config-routes.js` |
| `PUT /api/provider/:providerId/disabled` | same |
| `GET /api/provider/:providerId/source` | same |
| `PUT /api/provider` | same |
| `POST /api/provider/discover-models` | same |
| `DELETE /api/provider/:providerId/auth` | same |

Keep the two `app.use` guards in that file (`isProviderConnectRequest`,
`isCredentialListRequest`): they still stand in front of the proxied
`/api/integration…` and `/api/credential` calls. `registerProviderLogoRoutes`
is agent-neutral and stays. `providers.js`, `auth.js` (credential reads for
quota and voice go through `GET /api/credential`, which the catalog routes
still serve) and `provider-env-aliases.js` have no Pi consumer from this module.

## Routes

Bridge, wire dialect:

```
GET    /api/integration, /api/integration/:id
POST   /api/integration/:id/connect/key          { key, answer?, label? }       204
POST   /api/integration/:id/connect/external     { methodID, answer?, label? }  204
POST   /api/integration/:id/connect/oauth        { methodID, answer?, label? }  { location, data: attempt }
GET    /api/integration/:id/connect/oauth/:attemptID                            { location, data: status }
POST   /api/integration/:id/connect/oauth/:attemptID/complete   { code }        204
DELETE /api/integration/:id/connect/oauth/:attemptID                            204
POST   /api/credential/:id/activate              204
PATCH  /api/credential/:id                       { label }  204
DELETE /api/credential/:id                       204
```

Not served (bare 404): `connect/command…` and `POST /api/credential`. Pi has no
command connect, and `POST /api/credential` is `renewStoredLogin`'s way of
replacing a login, which cannot work on Pi (below).

Express, OpenChamber's own: the six above plus `GET|PUT /api/pi/model-settings`
(`defaultModel`, `defaultThinkingLevel`, `enabledModels`, `modelThinkingLevels` of
`settings.json`; a key set to `null` is removed). The model-settings route is new
and has no UI caller yet.

After every change that touches the catalog the service emits `integration.updated`,
`provider.updated`, `model.updated`, and `credential.updated` when a credential
changed, with the default location, through the hub.

## What an integration is

An integration is a Pi provider (same id). Its `methods`:

- `key`: from the provider's API-key login. A login that prompts for more than the
  secret (Cloudflare's account id) gives the method a `form`.
- `env`: the variables the provider's own resolver looks up, learned by running it
  with an environment that is empty and recording the names. Never for a provider
  declared in `models.json`, whose resolver may run a command; there `apiKey: "$NAME"` names it.
- `oauth` (`id: "oauth"`): when Pi's provider has OAuth. GitHub Copilot's carries a
  form for the enterprise domain, because its flow asks for it first.
- `external` (`id: "external:<route>"`): a branch of the key login that stores no key
  (AWS profile, Application Default Credentials). Its credential is listed with
  `method: "external"`.

`connections`: the credential in `auth.json` (`id: "cred_<provider>"`) and a key
found in the environment. A key in `models.json` is a provider setting, as in OpenCode's config.

## Decisions

### Why the key login is run to be read, and OAuth never

Pi's `ApiKeyAuth.login` is a function that prompts; nothing declares what it asks.
The page needs the form before the user connects. `login-plan.js` runs it with an
interaction that records the prompts and forks at every `select`. API-key logins
are prompts only, so this is safe; an OAuth login starts servers and network calls,
so it is never run to look at it. The walk stops a login that ignores its abort signal
(1.5 s per run, 4 s overall) and falls back to one plain key field.

### Why OAuth picks the first option of a method select

The status route has no way to carry a question. Pi's flows ask which login method
to use (Anthropic, OpenAI Codex, Radius), and the first option is the browser login,
which also takes a pasted redirect, so a browser on another machine still finishes
through `complete`. Offering the other options needs the page to show them as methods;
that is a UI decision, not made here.

### Why `complete` waits for the login

The page treats a successful `complete` in `code` mode as "signed in" and re-reads the
catalog at once. The token exchange happens after the code is handed over, so `complete`
answers when the flow settles (up to 45 s) and returns the flow's own message when it fails.

### Why mode is read from the prompt's placeholder

Pi's `AuthInteraction` does not say whether the browser can finish on its own. The
flows that can (a loopback callback) give a redirect address as the manual prompt's
placeholder; copy-code flows give `code#state`. A placeholder that starts with `http`
is mode `auto` with `paste`, anything else is mode `code`. A new Pi flow that breaks
this shows as a code field where a link would do.

### Why one synchronous read-modify-write for every file

`json-document.js` reads, edits and replaces a file with no `await` between the read
and the write, so two requests of this process cannot interleave. Every write goes
through `writeFileAtomic`. A file that cannot be read or parsed is refused (409,
`config_file_unusable`, with the path and parser message) and never replaced: a
replacement would erase what the user had. `auth.json` is only written by Pi's
`ModelRuntime.login/logout`, which hold Pi's own file lock.

### Why reads of `auth.json` retry, and files of ours never fail a stored credential

Pi writes `auth.json` in place under its own lock, so a read during another login's write can
see half a file. `service.js` repeats a failed read (4 tries, 25 ms apart) and reports only a file
that stays unreadable (503), because an unreadable file must not read as "nothing connected".
The names of logins and the switched-off list are our own files: once Pi has stored or removed
a credential, a failed write to them is logged and the request still succeeds and is announced.
A rename or a switch is the operation itself, so there a broken file is a 409.

### Why switched-off providers and login names live in OpenChamber's folder

Pi has no switch for a provider and no label for a credential. `<dataDir>/pi/disabled-providers.json`
and `credential-labels.json` hold them; Pi's files are not touched. The catalog hides
a switched-off provider from lists and from `models()`; `catalog.model(provider, id)`
still answers, so a session that already uses it keeps working.

### Why `enabledModels` is not mapped to `model.enabled`

Pi's `enabledModels` is the set a user cycles through, not what is available. Mapping it
to `enabled` would show every model outside the set as disabled in the picker. The route
writes the key; what the pickers do with it is open.

### Why `models.json` has no project or custom scope

Pi reads one `models.json`, in the agent directory. `PUT /api/provider` with scope
`project` or `custom` answers 400 naming the file; `GET …/source` reports those layers
as absent. The page only sends `user`.

### What a custom provider cannot say in Pi

Refused with the reason: a model type other than chat, a thinking level Pi does not
know (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Dropped: the tools flag,
audio, video and pdf input, image output (Pi gives every model tools and takes text and
images). Kept as the user wrote them: `compat`, `authHeader`, `modelOverrides`, a model's
`cost`, `samplingParams` and any other key.
A model with levels becomes `reasoning: true` with a `thinkingLevelMap` that maps the
listed levels and marks the other base levels `null`; an empty list sets `reasoning: false`.

## Enterprise mode

`service.assertCanAdd()` runs before anything is read or written in: connect key,
external and OAuth start and complete, `PUT /api/provider`, discover-models. It
answers 403 with `code: "enterprise_mode"` (`ForbiddenError` on the bridge). Removing
a login, renaming it, switching a provider off and editing model settings only narrow
access and stay allowed. The Express guard in `routes.js` still stops the same calls
before they reach the proxy; this is the second lock Pi needs because it has no
`provider.use` policy. Pi's own CLI can still add keys to the same files: enterprise
mode cannot stop that.

## Not covered

- A write from another process (the `pi` CLI) between this server's read and write
  of `models.json`. Pi's own writers have the same gap for that file.
- `renewStoredLogin` (isolated-space token renewal) creates a row and then removes the
  old one. On Pi both rows are `cred_<provider>`, so the removal would delete the new
  login. It needs its own path before an isolated space can run on Pi.
- Which provider ids the app should treat as "popular" (`connectableProviders.ts`
  lists OpenCode ids such as `opencode-go`, `vercel`).
- MCP OAuth through `integration.oauth.*`: Pi's MCP login is `pi mcp login`.
