# Hindsight sidebar extension

## Ownership

This package owns the Hindsight sidebar panel and its local service. The public SDK owns frame transport, themes, service authentication, process lifetime and runtime switching. This is a separately installed extension, outside the app-owned built-in registry. `build.mjs` generates an installable `dist` folder without rebuilding OpenChamber. Each local or SSH-connected server installs its own copy.

## Invariants

- The service reads `~/.hindsight/coding-agent.json` on the active OpenChamber server for every outbound request. Global connection fields and `harnesses.pi` overrides are supported. It never writes this file, starts Hindsight, or changes the agent plugin configuration. This is a bank browser for that connection, independent of project-specific `paths` and `banks` routing in the agent plugin.
- The iframe receives selected bank, memory, document, mental-model and mission fields. API tokens, arbitrary configuration, upstream error bodies and metadata never enter the frame or logs. Original document text and memory text are displayed as text, including any HTML they contain.
- HTTPS and loopback HTTP endpoints are supported. URL credentials, query strings and fragments are rejected. Requests preserve a configured base path, refuse redirects and use a deadline and response-size limit. The frame cannot supply another endpoint or arbitrary upstream paths.
- The loopback listener authenticates every request, including health. The existing extension service capability and enterprise policy remain the host-side authorization gates. Installation requires the service grant; enterprise mode applies its existing source allowlist to this package.
- Web and Electron use the connected server, including SSH and relay connections. VS Code, hosted mobile and Capacitor mobile retain the SDK's explicit unsupported extension catalog.
- Lists load 50 entries per page. Bank selection can load additional banks. Memory and document searches run on Hindsight only when submitted; the knowledge-page tab lists mental models without a search. The archive tab requests invalidated facts explicitly so they remain accessible for restoration. No polling runs while the panel is idle or hidden.
- Reads reject obsolete completions when the selected bank, tab, page or entry changes. Fetch failures remain errors and never become empty authoritative lists. Statistics can fail independently of the entries. The host retires the entire frame and its pending SDK requests on runtime changes.
- Memory editing and reversible archiving are offered for world/experience facts. Derived observations remain read-only. Document deletion requires confirmation explaining that extracted memories are removed. No action runs until clicked. Mutations lock navigation and retain drafts on failure; successful mutations reload the list without retrying the write.
- Bank settings expose only reflection and extraction missions. The API update wraps those fields in `updates` and leaves every other bank setting unchanged. Managed knowledge-page queries and agent ingestion settings are intentionally read-only here because the coding-agent plugin reconciles them from its own configuration.
- All 15 host locales live in the package and follow `HostReadyContext.locale`; they do not import the host React i18n context.

## Decisions

### Why the connection belongs to a service

The config and token belong to the machine running OpenChamber. Reading them from a host service keeps SSH connections on the remote machine and credentials out of the sandboxed iframe. A browser fetch or desktop-only IPC connection would use the wrong machine on remote runtimes.

### Why the panel reads existing banks without ingestion

Opening memory management must not create banks, retain conversations or trigger paid synthesis. The existing Pi Hindsight plugin owns automatic memory; this panel reads and explicitly curates what Hindsight already holds.

### Why facts archive and documents delete

Hindsight exposes reversible curation for individual facts and permanent deletion for source documents. The panel keeps those distinct and presents the consequence before each action. Knowledge pages are read through the mental-model API, which includes coding-agent knowledge pages and ordinary mental models.
