# Pi migration of the VS Code extension

The extension still starts OpenCode from `src/opencode.ts` (`startManagedOpenCodeServer`, around
the managed-start block) and writes OpenCode-shaped configuration from its special handlers. The
web/desktop runtime already speaks the OpenCode 2.2.6 dialect from Pi through
`../web/server/lib/pi/bridge/`; the extension needs the same bridge inside its extension host.

## Verified constraints

These were checked against VS Code 1.145 and Pi 1.5.0; they decide the shape of the work.

- **The extension bundle is CommonJS and excludes `node_modules`.** `esbuild`/webpack output plus
  `--no-dependencies` and `.vscodeignore` mean Pi is not shipped today. Pi's package is ESM and
  resolves its own files with `import.meta.resolve`, so it must exist as real files on disk, not
  inside the extension bundle.
- **Pi needs a real Node runtime.** Pi requires Node 22.19 or newer. An extension host older than
  that cannot load it in-process; a separate process on a discovered Node (or a bundled one) is
  then required. Check the host's `process.versions.node` before choosing in-process.
- **Pi needs its CLI, RPC entry, gate extension and SDK assets on disk.** Ship
  `@earendil-works/pi-coding-agent/dist/bundle` and `jiti` unpacked under the extension's resources
  and rewrite resolved `import.meta.resolve` paths to that tree, as the desktop build does
  (`../web/server/lib/pi/launch.js`, `readableEntryPath`).
- **Starts are serialized and cancellable.** The managed-start path serializes attempts, tracks a
  revision, and stops a superseded start; a Pi bridge must keep that ownership instead of spawning
  a second host.
- **Configuration handlers write legacy files.** The extension serves skills, MCP and some settings
  handlers itself before the proxy; they must call `../web/server/lib/pi/config-routes/` stores so
  the extension and Pi agree on one set of files.
- **MCP OAuth is same-machine.** `pi mcp login` opens a listener on the machine running Pi; a
  Remote-SSH window whose Pi runs on the remote host needs that host's browser, which the extension
  cannot open.
- **Shutdown must reach the whole tree.** Pi's RPC shutdown signals only its immediate child; the
  extension's existing process-tree guarantee has to cover Pi's children too.

## Smallest complete route

1. Bundle a Pi bridge entry for the extension host (Node 22.19+), or start the existing bridge from
   the shipped resources on a separate process.
2. Point the existing proxy, SDK dialect and SSE code at that bridge's loopback URL; the webview and
   message protocol stay as they are.
3. Swap the special config handlers to the Pi stores.
4. Rebuild the VSIX with Pi's unpacked resources and check `process.versions.node` fallback.

Until then the extension keeps spawning OpenCode; do not ship a half-switched extension host.
