# Pi runtime

## Ownership

How OpenChamber drives the Pi Coding Agent. The module owns:

- **Processes.** `rpc-client.js` talks JSONL to one `pi --mode rpc` child. `launch.js` picks the JavaScript runtime, builds the child's environment and arguments. `live-session-host.js` keeps a child for each session that runs a turn, waits on something, or was used a moment ago.
- **Job list.** `bridge/jobs.js` keeps the subagent children `GET /api/experimental/job` reports, from the subagent tool and from subagent commands. Each child's terminal wire event ends its entry, and a finished entry stays five minutes, as the shell store's do.
- **Settings files.** `config-routes/settings.js` serves `/api/config/compaction` and `/api/config/websearch` and the global `/api/behavior/agents-md` over Pi's own files: compaction keys in `<agentDir>/settings.json`, the web-search choice in the bridge's per-install state (Pi has no web search of its own), and `AGENTS.md` in the agent directory. The web server registers these before `opencode/routes.js`'s OpenCode-shaped handlers, which would otherwise answer first.
- **MCP servers.** `config-routes/mcp.js` owns CRUD on Pi's `mcp.json` and the 30-second `pi mcp list --json` status cache behind `/api/mcp`. The web server composes the CRUD routes in place of the legacy OpenCode writer, and the bridge receives the status provider, so a server added in Settings is one Pi actually loads and the list shows its real connection state. `bridge/mcp-oauth.js` presents each remote server with OAuth as an OpenCode integration (`mcp_…`) and answers its attempt routes: one attempt is one `pi mcp login`, its browser line becomes the attempt's URL, and its exit decides complete or failed. The MCP page and the work-status authorize action therefore sign in through Pi with no UI change.
- **Sessions on disk.** `session-files.js` reads Pi's session files without running an agent. `session-meta-store.js` is the sidecar for what the file cannot hold: archived, viewed, metadata, the chosen agent and model, run state, instruction entries, and sessions that have no file yet.
- **Providers.** `catalog.js` lists providers, models and credentials through Pi's `ModelRuntime`; `generation.js` runs one-shot text and image generation through the same runtime.
- **The bridge.** `bridge/` is an in-process HTTP server on loopback that speaks the OpenCode 2.2.6 dialect and answers from the parts above. `wire/` holds the pure translation between Pi's messages and events and that dialect.
- **Extensions Pi loads.** `extension/gui-gate.js` gates every tool call, provides the `question` tool and delivers instruction entries. `managed-runtime.js` writes it and the generated managed-tools extension (`../agent-tool/pi-extension.js`) into the server's instance folder.
- **Editable profiles and commands.** `config-routes/` owns the agent profile store and Pi prompt-template CRUD. The web server composes these handlers into its existing configuration routes, so desktop and mobile clients use the same files as the Pi runtime. `bridge/commands.js` resolves templates, including nested names, using fresh project trust and Pi's argument expander before context and attachments are combined, and plans what the command runs as. `command`'s `agent` and `model` switch the session durably before its turn, matching OpenCode 2.2.6; `subagent: true`, or a subagent-mode agent without `subagent: false`, runs the command in a child session and starts the parent's next turn with the child's report. The child report reaches the parent as a user-shaped message carrying `metadata.source: "subagent"`, not as the synthetic message OpenCode writes. A `$skill` mention resolves through the same store the Skills page edits and attaches the body as `<skill_content name="…">`, the wire's shape; a name no folder holds is a 400 before any inbox item is accepted. `config-routes/skills.js` also owns `/api/config/skills*`: listing with scope and source, SKILL.md and supporting-file CRUD, rename, the catalog scan and installs, all over Pi's own skill folders; a mutation retires idle children so the next prompt starts with the change. A profile file also carries the editor's `steps`, `temperature` and `top_p` so saving and reopening an agent loses nothing; Pi applies neither a per-agent temperature nor a step limit, which is a documented gap rather than a reason to drop the values on write.

It does not own what the UI draws (`packages/ui/src/lib/opencode/` reads the dialect), the proxy and trust gate in front of the bridge (`../opencode/proxy.js`, `../opencode-trust/`), or the server features that call the bridge over HTTP (scheduled tasks, workflows, notifications, quota).

Where a sub-area has its own notes, they sit next to it: `wire/NOTES.md` (translation rules and what was verified), `bridge/routes/NOTES.md` (catalog routes), `bridge/PERMISSIONS-NOTES.md` (permissions, forms, the callback channel).

## Invariants

- **One child, one session, one folder.** A child is started for a session in that session's folder and never switches. A child started with `--approve` would trust every folder it later enters, so the host never reuses one across folders.
- **The folder's trust decides `--approve`.** `buildLaunch` in `bridge/index.js` passes `--approve` only when `approvalFlagFor` (`../opencode-trust/approval.js`) answers so for that folder, read fresh at every start; any failure is `--no-approve`. Every child also gets `--session-dir` pinned to the folder Pi would use anyway, because Pi reads a project's own `sessionDir` before it checks trust.
- **The gate always loads, once.** Every child loads `gui-gate.js` through `-e`. A tool call the gate cannot confirm is blocked: no address, no token, a refused connection, an unknown session. The callback uses `node:http` and the child's per-session bearer token, never Pi's `fetch`, which cuts a response-less request after five minutes.
- **A pending dialog never blocks an abort.** Pi's `abort` waits for every extension dialog that has no timeout. The host answers each open dialog with `cancelled` before it sends `abort`, and a dialog some other extension raises is shown as a form and answered back.
- **Pi's file is the transcript.** Messages are rebuilt from the active branch of the session file plus the step still streaming. Nothing the UI shows from a transcript lives anywhere else. Pi writes a message when it ends, so a reload shows only finished messages.
- **Live events and stored messages agree.** The same ids, ordinals, tool states, usage and outcome come out of `wire/translator.js` and `wire/transcript.js`. `wire/ui-consistency.test.js` folds recorded Pi runs through the UI's own reducer and projection and compares.
- **Session ids are Pi's ids.** The bridge creates a session as `--session-id <ses_...>`; the id the UI minted is the id of Pi's file. A session the user made with the `pi` CLI appears in the list as `ses_<its UUID>`, because the dialect's ids start with `ses` (`wireSessionId` in `session-files.js`); its file keeps the UUID.
- **Status comes from four events.** `session.execution.started|succeeded|failed|interrupted` are the only run status the UI reads. A user interrupt is `interrupted` with reason `user`, never `shutdown`, which the UI ignores. A child that dies mid-turn ends its open step and the run with `failed`.
- **Credentials leave only through the bridge's own routes.** `GET /api/credential` sits behind Basic auth and answers `cache-control: no-store`. A Pi child's shell never sees the bridge password: the lifecycle does not put it in the environment.
- **Project resources are code.** Packages and extensions of a project, local MCP servers and the settings that name commands run only for a trusted folder; installing them into an untrusted folder is refused.
- **A running profile is a snapshot.** Configuration invalidation retires idle children and marks active children stale without changing their prompt, tools or agent rules mid-turn. Before the next idle prompt, a stale child is replaced using the current configuration. This does not establish profile-switch parity for prompts already queued inside Pi.

## Decisions

### Why the bridge speaks the OpenCode dialect and not a Pi-specific protocol

Every consumer already speaks it: the UI through `@opencode/client`, the VS Code bridge, relay and mobile, and about 25 server modules that call the agent over HTTP and read its event stream. A Pi-specific protocol would still need the dialect for those modules. The bridge is checked against it with `@opencode/schema`'s own decoders and against recorded responses of a real OpenCode 2.2.6, so a field the UI reads cannot go missing without a failing test. The cost is that Pi's concepts (a transcript tree, steering queues) are shown in OpenCode's shapes; `wire/NOTES.md` lists where they differ.

### Why one `pi --mode rpc` child per live session and not the SDK in the server process

A child isolates the server from extensions, a hung shell and MCP servers, gives each session an explicit environment (the SDK's `bash` tool inherits the host's whole `process.env`), and can be killed outright. The RPC protocol is documented and delta-only; the SDK's types change in almost every minor release. A child costs about 120 MB idle and starts in about 150 ms, so the host starts one only for a session that is running or recently used and closes it after five idle minutes. The SDK is used only for data paths that never run an agent: the model catalog, credentials, login, one-shot generation.

### Why sessions that have no file live in the sidecar

Pi creates a session file at the first message. The UI creates a session, shows it and may never send a prompt, so a draft needs an id, a folder and a model before any file exists. The sidecar keeps it until Pi's file appears; the file wins when both exist.

### Why Pi's bundle is unpacked in the packaged app

The desktop app packs `node_modules` into `app.asar`, and the web server reads those files through Electron's fs, which understands the archive. A Pi child is a separate process (`node`/`bun`, or Electron itself with `ELECTRON_RUN_AS_NODE`), and neither can open a path inside the archive. The Electron build therefore unpacks `@earendil-works/pi-coding-agent/dist/bundle`, its manifest and `jiti`, and `launch.js`'s `readableEntryPath` points the child at the `app.asar.unpacked` copy when it exists; `packaged-app-contents.cjs` fails the build if those files stop being unpacked. The in-process SDK keeps loading from the archive. `jiti` is the extension loader Pi's bundle requires at run time: resolved from the unpacked tree, Node finds it beside the app's other unpacked modules.

### Why a literal prompt can gain one leading space

Pi's prompt path expands a leading slash command itself (extension commands, then skill commands, then prompt templates), and its RPC has no switch to turn that off. The bridge already resolved the command, so a body that starts with `/` is literal text, whether it is a command whose template begins with another command or a prompt a client sent as text. Sending it unchanged let Pi run a second, unintended expansion. `prompting.js` prefixes one space in that case, which keeps Pi's expansion pass away and changes nothing the model or the user reads; the stored message keeps the space.

### Why message ids come from the Pi message timestamp

Pi's events and entries carry no message ids, and `message.timestamp` is the same number in `message_start`, `message_end` and the stored entry (checked on every message of recorded runs). An id derived from it, in OpenCode's sortable format, is the same live and after a reload. The id the UI minted for a user message is kept in the sidecar (`clientIds`) and used in its place.

### Why the gate asks the bridge over HTTP and not through Pi's dialogs

Dialogs carry strings only, no tool call id, and an unanswered one hangs `abort`. The callback carries structured data, ends with the tool call's own signal and lets the bridge answer from rules before it ever asks the user. Rules are the agent's, then the session's, last match wins; a saved `always` rule turns an `ask` into `allow` and never overrides a `deny`.

### Why a tool an agent denies outright is also excluded from the child

A stored agent's permission rules only gate a call, and a gated tool still sits in the model's tool list with its description on every request, so a denied tool cost context and invited a call that could only fail. `agentLaunchOptions` therefore passes every tool the rules deny on every call (`deniedToolNames` in `bridge/permission-rules.js`, mirroring the gate's tool-to-action mapping) and the agent's own `exclude_tools` as `--exclude-tools`. The alternative, writing the derived list into the agent file when the editor saves, would keep a second copy of the deny that drifts as soon as someone edits the rules by hand; deriving at launch keeps the rules the one source. A rule that denies only some calls, a session's own rules and the built-in agents keep the tool listed, and the gate still refuses it there.

### Why the child reports what fills its context when asked

The context view splits what the agent sends before the conversation (system prompt, instruction files, skills, tool definitions) into categories and items. Only the Pi child knows that text, so the gate extension answers an `openchamber-context <id>` command with the prompt and the active tools through `POST /_pi/context`, and `GET /api/session/:id/context-composition` (`bridge/context-composition.js`) waits for it. The alternative, the child pushing a snapshot after every turn, would send tens of kilobytes per turn to a bridge nobody asked. An extension command runs at once, also while a turn streams, and adds nothing to the conversation, so reading never makes a session busy; a reply other than `handled` means the text became a prompt, which the manager aborts and reports as unavailable. The route may start the session's child, like any read that needs one. The sizes are estimates at four characters a token, the same as the conversation estimate beside them; the prompt is split by Pi's XML sections, so a Pi that renders its prompt differently shows its parts as "other additions" rather than failing.

### Why instruction entries go into a system prompt section

OpenCode held them itself. In Pi the extension reads the rendered text before every run and puts it in one section of the system prompt (`systemPromptOptions.sections`), which Pi diffs against what the model already has, so an unchanged entry costs no cache miss. A change is announced to the UI once, at the next run, as the notice "Instructions updated".

### Why the extension files are copied into the instance folder

A packaged app keeps its code in an archive. Pi loads an extension by path, and a path inside the archive is not one every runtime can read, so `managed-runtime.js` writes the gate and the generated tools next to the server's other run files and a Settings change rewrites them. A change also stops idle children, so the next prompt starts one with the new tools.

### Why an interrupt drops the prompts queued behind the turn

Pi carries on with queued prompts after an abort. OpenCode parks them. Parking would need an inbox that survives the process; the bridge instead takes them out of Pi's queue (`clear_queue`) and cancels their inbox items, as Pi's own terminal does, or sends them again when the request asks to resume.

### Why titles are generated by a model and start from the prompt

OpenCode named a session with a model call. The record shows the first line of the prompt at once and the bridge replaces it after one background generation, in OpenChamber's title style. A title the user sets meanwhile is kept, and a failed generation leaves the provisional title.
