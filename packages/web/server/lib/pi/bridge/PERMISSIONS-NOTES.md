# Permissions, forms and the Pi gate: notes for the coordinator

Pi has no permission system and no question tool. The bridge supplies both. A gate extension in the Pi child asks the bridge before every tool call, the bridge answers from rules or asks the user through `permission.asked`, and a `question` tool shows a typed form through `form.created`. This file lists what is built, the choices made, what the composition has to wire, and what is not proven.

## Files

| File | Role |
|---|---|
| `bridge/permission-rules.js` | Pure. Pattern matching, last-match-wins evaluation, the Pi tool to OpenCode action mapping, shell command splitting. |
| `bridge/permissions.js` | `createPermissionManager` and `createSavedPermissionStore` (JSON file). The manager's API is in its header. |
| `bridge/forms.js` | `createFormManager`. API in its header. |
| `bridge/request-source.js` | The bounded `resolveSource` lookup both managers use. |
| `bridge/routes/permissions.js`, `bridge/routes/forms.js` | The `/api` routes of wire spec 3.5. |
| `bridge/routes/pi-callback.js` | `createChildTokens` and the routes `POST /_pi/permission`, `POST /_pi/form`. |
| `extension/gui-gate.js` | The Pi extension: `tool_call` gate, `question` tool, `globalThis.__openchamberPiPermission`. Imports only `node:http`. |
| `test-support/gate-bridge.js` | Test harness: real hub, managers, routes and transport on one listener. |

Tests: `permission-rules.test.js`, `permissions.test.js`, `forms.test.js`, `routes/requests.test.js`, `routes/pi-callback.test.js`, and `extension/gui-gate.test.js` (a real `pi --mode rpc` child, the real transport and managers, a mock model).

## What must be wired

1. **Transport.** `http.js` checks Basic auth before it looks at the route, so a request with a bearer token gets 401. The callback routes carry `bypassBasicAuth: true` and check the token themselves. The transport has to skip its Basic check for a route with that flag and keep it for unknown routes, which must still answer 401 before 404. Sketch:
   ```js
   const route = compiled.find((candidate) => candidate.method === req.method && candidate.regex.test(url.pathname));
   if (!route?.bypassBasicAuth && !isAuthorized(req.headers.authorization, password)) throw unauthorized();
   ```
   `test-support/gate-bridge.js` serves those routes itself, the way the transport will once it honors the flag.
2. **Routes.** Add `createPermissionRoutes({ permissions, store, getDefaultDirectory, requireSession })`, `createFormRoutes({ forms, getDefaultDirectory, requireSession })` and `createPiCallbackRoutes({ tokens, permissions, forms })`. `requireSession` should throw `SessionNotFoundError` for an unknown session, for example `(id) => service.requireRecord(id)`. The store comes from `createSavedPermissionStore({ filePath })`.
3. **`getContext(sessionID)`** for both managers returns `{ directory, agentRules, sessionRules }`, or `null` for an unknown session. `directory` has to be the same string `resolveLocation` produces for that session's folder, because `GET /api/permission/request` and `GET /api/form` filter by equality. `agentRules` are the `permissions` of the session's current agent (golden 02 shows the build agent's), `sessionRules` the session's own `permissions`. Both are read on every call, so a session patched mid-turn takes effect on the next tool call.
4. **`resolveSource(sessionID, toolCallId)`** returns `{ messageID }` of the assistant message that holds the call, and may be async. The managers wait at most 2 s and then send the request without `source` (or the form without `metadata.tool`). Pi emits `tool_execution_start` before it runs the gate, but stdout and the callback are separate channels, so the lookup is where the translator can hold the answer until it has numbered the call, which keeps the wire order `tool.called`, `permission.asked`. For a call made from a codemode script the managers ask with the parent's id (the call the chat shows).
5. **The child.** Per session: `session.env` gets `OPENCHAMBER_PI_BRIDGE_URL` (the base URL of the bridge's loopback listener, no path) and `OPENCHAMBER_PI_BRIDGE_TOKEN = tokens.issue(session.id)`; `getExtensions()` returns the absolute path of `extension/gui-gate.js` (`fileURLToPath(new URL('../extension/gui-gate.js', import.meta.url))`). Call `tokens.revoke(session.id)` when the child exits. A token names one session. A call from the same child about another session id (`new_session`, `fork`, `switch_session` inside the process) gets 403 and is blocked, which matches `live-session-host.js` running one child per session.
6. **`__openchamberPiPermission`** is installed by `gui-gate.js` when it loads. The managed tools extension reads it at call time, so the two extensions can load in either order. Nothing else sets it.
7. **Translator.** A blocked call is only an error result in Pi's stream. For `tool_execution_end` with `isError` call `permissions.takeBlocked(sessionID, toolCallId)`: `kind: 'rejected'` is `error.type: 'permission.rejected'` with the message, `kind: 'denied'` is `tool.execution`. For the `question` tool, `result.details` says which way it ended: `{ answers, truncated: false }` goes to `metadata`, `{ dismissed: true }` is `error.type: 'aborted'` with `The user dismissed this question`, `{ interrupted: true }` is an abort.
8. **Interrupt and exit need nothing extra.** `POST /interrupt` becomes Pi's `abort`; the gate passes `ctx.signal` to its request, so the held request closes and the manager drops it. A child that exits closes its sockets the same way. No `extension_ui_request` is involved, so the host's "cancel open dialogs first" step has nothing to do for these.

## Decisions

- **Order of rules.** The agent's rules, then the session's, last match wins, no match asks. The brief put the saved rules between the two, but golden 11 shows a session rule `shell * ask` and a saved `echo *` that stops the asking, so a saved rule has to beat a session `ask`. A saved rule only turns an `ask` into an `allow`: a `deny` stays a deny. OpenCode's order for saved rules against a deny was not captured.
- **Wildcards.** `*` is any characters including `/` and newlines. A pattern ending in ` *` also matches the bare prefix, so `ls *` covers a plain `ls`. `?` is literal. Rules that are not objects with three strings are skipped.
- **Shell commands.** `resources` is the whole line, as in golden 10. The rules look at each simple command of the line (split on unquoted `;`, `&&`, `||`, `|`, `&`, newline) and the strictest answer wins, so a saved `echo *` does not allow `echo hi; rm -rf x`. A line with `$(...)`, backticks or process substitution, or an unclosed quote, is opaque: only a rule whose resource is `*` allows it, and no pattern is offered to save. `save` is `<program> *` per command, except for programs that run other commands (`sh`, `bash`, `env`, `sudo`, `xargs`, ...), for commands that start with a variable assignment, and for opaque lines; then the request has no `save` and the UI offers no "always".
- **File tools.** `read` and `ls` are `read`, `grep` is `grep`, `find` is `glob`, `edit` and `write` are `edit`. The resource is the absolute path (`~` and a leading `@` resolved), and the saved pattern is that exact path. A directory pattern would make "always" on `.env` allow every file under it.
- **Other tools** (MCP, extension, `question`, `codemode`) are their own action on `*`, with the arguments as `metadata` (strings cut at 2000 characters) so the card shows what is being approved.
- **Messages.** Reject: the user's message, else `The user rejected this tool call.`. Deny by rule: `The user has specified a rule which prevents you from using this specific tool call (<action>: <resource>).`. Cancel of a form: the query `message`, else `The user dismissed this question`.
- **Interrupt.** An aborted request is dropped with no `permission.replied`, as OpenCode does. A form dropped the same way emits `form.cancelled`, so no client keeps a card nobody can answer. OpenCode's behavior for a pending form on interrupt was not captured.
- **`always` writes first.** The saved rules are written before the request is answered. When the write fails the request stays pending, nothing is emitted, and the reply answers 500, so the user can retry or choose once. A second reply, or an abort that landed during the write, ends in `PermissionNotFoundError`.
- **Fail closed.** No address or token, a refused connection, a non-200, a body that is not `{ allowed: true }`, an unknown session (404) and a bridge that goes away while a request is held all block the call with a reason. `secret.run` through `__openchamberPiPermission` rejects by throwing, which is the contract in `agent-tool/PI-EXTENSION.md`.
- **Why not `ctx.ui` dialogs.** They carry only strings, no tool call id, and an unanswered one makes Pi's `abort` hang. The HTTP callback carries structured data and ends with the call's own signal.
- **`node:http`, not `fetch`.** Pi's global fetch ends a request with no response after 5 minutes; a card waits as long as the user takes. The extension also adds the bridge host to `NO_PROXY` so a configured proxy never sees the token.
- **Question results.** Text `User has answered your questions: "<q>"="<a>", .... You can now continue with the user's answers in mind.`; several choices are joined with `, `, an unanswered question reads `Unanswered` (OpenCode 1.x worded it so; golden 25 shows only the answered case). Answers may leave fields out. Every string is accepted, because the form fields carry `custom: true`. The error messages for a wrong type are golden 25's (`Expected string for form field: q0`) and, for a multiselect, my own wording.
- **Saved rule list.** `GET /api/permission/saved` returns the rules of every project, as the route is global in the wire spec. The UI does not call it. A `PATCH` of an unknown id answers 404 `PermissionNotFoundError` (the tag was not captured), a change that equals another saved rule answers 409 `ConflictError`.

## What Pi does, observed

- Sibling tool calls in one assistant message are preflighted one after the other: with three bash calls there was never more than one request pending, and the next `tool_execution_start` came only after the previous one was answered. Each call still gets its own request and id.
- `ctx.signal` is set in the `tool_call` hook. `abort` with a request pending does not hang (the test bounds it at 5 s) and ends with `agent_settled { aborted: true }`, the request is dropped, no `permission.replied`, and the same child takes the next prompt.
- A blocked call is `tool_execution_end { isError: true }` whose text is the `reason`, and the model gets another step.
- Cancelling the question: the tool ends with `isError: true` and the dismissal text, the model takes its next step, the turn settles with `aborted` unset and `isStreaming` false. Nothing is left busy, unlike OpenCode's `execution.interrupted(shutdown)`.
- A tool result with `isError: true` keeps its `details` in `tool_execution_end`.
- Each nested call of a codemode script goes through the gate with `parentToolCallId`; a rejection reaches the script as the failure text.

## Not done or not proven

- No file previews (`metadata.files`) on `edit` and `write` requests, so the card shows the path only.
- A tool a deny rule names is removed from the model's tool list only for a stored agent profile whose rules deny every call (`deniedToolNames`, passed to Pi as `--exclude-tools` by `agentLaunchOptions`); OpenCode did it for every ruleset (golden 13). A session's own rules, the built-in agents and a rule that denies only some calls leave the tool listed, and a call to it fails at the gate.
- Other pending requests are not re-evaluated after a reply of `always` or a changed rule.
- The managed `secret.run` was not run through the gate, only a probe tool that calls `__openchamberPiPermission` with the same request shape. The managed side is covered in `agent-tool/pi-extension.test.js`.
- `user_bash` (the user's own `!` commands and the RPC `bash`) is not gated.
- Every test runs on Node. A held callback (25 s) and a client hang-up were checked in a Bun server script, not through the full stack. Windows, the Electron runtime and a packaged app (the extension path inside an asar) were not tried.
- The UI was not run against any of this.

## Open questions

1. Should a saved rule override a deny? Built as no.
2. What does OpenCode emit for a pending form when the turn is interrupted? Built as `form.cancelled`.
3. What does "always" save for file tools in OpenCode: the path, its directory, or `*`? Built as the exact path.
4. Should `extension/gui-gate.js` be copied to the data directory at start, as the managed tools extension is generated there, so a packaged build never hands Pi a path inside an archive?
