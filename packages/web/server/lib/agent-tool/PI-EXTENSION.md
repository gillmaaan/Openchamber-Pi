# Managed tools as a Pi extension

`pi-extension.js` exports `createPiManagedToolsExtensionSource(options)`. It takes the capability flags of `createPluginSource` (`includeControl`, `includeSchedule`, `includeWeb`, `includeMemory`, `includeKnowledge`, `includeNotify`, `includeRender`, `includeImage`, `includeSecret`, `includeUsage`, `includeWorkflow`) and returns the source of one self-contained ES module. Its default export `(pi) => void` registers the same tools the OpenCode plugin registers, over the same callback (`POST $OPENCHAMBER_AGENT_TOOL_URL` with `Authorization: Bearer $OPENCHAMBER_AGENT_TOOL_TOKEN`, body `{ input, sessionID, callID, tool }`). The server half is unchanged.

The module has no bare imports. It uses `node:http` and `node:https` and plain JSON Schema objects as `parameters`, so Pi's jiti loads it from any directory, with or without a `package.json`.

## What is shared with the OpenCode plugin

Tool names, descriptions, input schemas, the Code Mode split, namespace lines and the input normalization come from `runtime.js`, through `managedToolSpecs(flags)` and `toolInputPreparation(spec)`. The normalization is the same code text: `link` and `dependsOn` revival, flattened inputs, the single-action JSON revival, the bare `run` of the secret tool and the two boolean spellings. `createPluginSource` builds from the same two functions, and its output is byte-identical to what it produced before they existed, for all 2047 flag combinations. `pi-extension.test.js` compares the two generators tool by tool and runs both against one stub with the same raw inputs.

## What the extension owns

- **Exposure.** Every tool is `direct`, declared under its own name. A spec with `codeMode: true` would register as `codemode` with a namespace of its own name and its catalog line; none does, so no test runs that path against Pi.
- **Activating Pi's `codemode` tool.** Pi 1.5.0 does not do it for extension tools. It does for MCP servers. Without the `session_start` handler the model's tool list has no `codemode` and the registered tools are unreachable. The handler adds `codemode` to the active tools when the extension registers at least one Code Mode tool, and every session start (new, resume, fork, reload) runs it again. With every tool direct the handler is not generated.
- **Result.** Content is the server's envelope as text. `details.openchamber` is `{ schemaVersion, action, description, ok, answer? }`, where the OpenCode plugin put `metadata.openchamber`. `isError` is `false` for every envelope, including `ok: false`. `onUpdate` sends the same details shape before the call and after it.
- **Session id.** `ctx.sessionManager.getSessionId()`. A call that cannot name its session returns an `ok: false` envelope and calls nothing. `callID` is Pi's `toolCallId`. For a call made from a codemode script that is `<codemode call id>/<n>`; every tool is direct now, so the ids are the ones the chat sees.
- **Waiting calls.** `render.page` with `awaitAnswer`, `secret.request` and `secret.run` register an abort controller under their session. Pi's `input` event fires for every prompt, steer and follow-up, whoever sends it, and aborts those controllers. The call then returns `{ answered: false, reason: "chat" }` with the closed-in-chat note, and the agent reads the message next. A call that only shows a page is not ended. `secret.forget` does not wait.
- **Transport.** The callback is a `node:http` request. Pi installs a global dispatcher with an idle timeout (`httpIdleTimeoutMs`, 300000 by default), and a `fetch` that waits longer for the user's answer fails with `UND_ERR_HEADERS_TIMEOUT`. The test sets the timeout to 1 second and shows both: a `fetch` probe fails, the tool keeps waiting. The abort signal is passed to the request.
- **Bare actions.** Pi checks the action against the schema before `execute` runs and refuses `read` for `memory.read`. The server resolves bare names inside the calling tool, so multi-action tools register `prepareArguments`, which resolves them the same way before the check. An unknown action still reaches Pi's validation error.
- **Proxy.** `exemptCallbackFromProxy` runs when the extension loads and adds the callback host to `NO_PROXY` and `no_proxy`. Pi's global dispatcher and Node's env proxy support would otherwise route the token through a configured proxy.
- **`openchamber_workflow_answer`.** Registered with `defaultActive: false`, which is what the managed OpenCode config did by denying it in every session. A workflow agent's Pi declares it with `--tools +openchamber_workflow_answer`.

## The permission hook for `secret.run`

Pi has no permission system. Before the call reaches the server, `secret.run` validates its command and awaits `globalThis.__openchamberPiPermission(request)` with

```js
{ sessionID, toolCallId, tool: 'openchamber_secret', action: 'shell',
  resources: [commandLine], save: ['<program> *'], signal }
```

`commandLine` is drawn by the server's own `secretRunCommandLine`, so the line the user approves is the one the card shows. The function rejects by throwing, and the error text reaches the agent as the tool's failure. When no function is installed, `secret.run` returns an `ok: false` envelope that names `secret.request` and calls nothing.

The hook is read inside the Pi process. The OpenChamber server cannot set it. A second extension loaded with `-e` into the same Pi process installs it, for example one that asks the user through `ctx.ui.confirm`. The test installs one that way.

## Verified, with Pi 1.5.0 over `pi --mode rpc`

- A direct tool call and a call after `new_session` reach the stub with the bearer token, `{ input, sessionID, callID, tool }` and the Pi session id. The envelope comes back as the tool result with `details.openchamber`.
- An `ok: false` envelope, a connection refused, a non-JSON response and a missing connection each give an `ok: false` envelope result, and the turn finishes.
- `abort` during a held render call closes the held request.
- A prompt sent with `streamingBehavior: "steer"`, a `steer` and a `follow_up` each end a waiting page with the chat answer. The message is in the model's next request.
- The gate is asked first, a refusal ends the call without reaching the stub, and no gate refuses `secret.run`.
- Every tool except the workflow answer tool is declared under its own name, and no `codemode` tool is declared by the extension.
- The server route (`createAgentToolRuntime().registerRoutes`) receives the Pi session id, resolves its directory and sets `secretRunAuthorized` for `secret.run` from the secret tool.

## Not verified

- The OpenChamber UI reading `details.openchamber` from Pi's stored tool results.
- An `input` event from an extension's `sendUserMessage`, and another extension's `input` handler returning `handled` before this one runs. Both would keep a waiting page open.
- The Code Mode path (`codeMode: true`) against a real Pi, and a Pi with its built-in codemode extension disabled.
- Windows and the Electron runtime (`ELECTRON_RUN_AS_NODE`). The test runs Pi on Node 24.

## Differences the OpenCode plugin did not have

- Behind `codemode`, Pi rendered a tool's input as a TypeScript declaration that kept the union of action names and dropped the per-action descriptions of the `oneOf` branches. How Pi shows a direct tool's schema to the model was not checked.
- Pi's validation error for an unknown action names only the first action (`expected "memory.read"`), where the server's own error lists all of them.
