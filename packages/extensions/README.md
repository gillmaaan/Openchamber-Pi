# Built-in extensions

App-owned extensions live here and use the public `@openchamber/sdk` contract. This directory is not a Bun workspace and adds no runtime dependencies. The build resolves SDK entrypoints from the SDK workspace.

From the repository root:

```bash
bun run extensions:build
```

`registry.json` is the allowlist. Each entry names a package directory, explicit files to ship, and browser or Node build entries. Browser entries must produce a single IIFE; embed imported images rather than relying on runtime-relative URLs. The build stamps package versions with the app version and validates the finished packages with the same parser as user installs.

Output goes to `packages/web/server/built-in-extensions/`. It is generated, ignored by Git, and included in the web package. Root installation, web builds and web packaging build it automatically. Rebuild after editing a built-in, then reopen its panel. Registry changes require a server restart.

Packaged Electron unpacks these resources from ASAR so future service entries can run as ordinary files. The backend selects its app-owned registry; user extensions and user data are stored separately.

The built-in registry is currently empty. Builds still ship an empty registry and remove resources from previously bundled extensions. Build tests create temporary fixtures instead of shipping a demo.

## Standalone Hindsight extension

`hindsight/` is installed separately rather than shipped in the built-in registry. Its right-sidebar panel reads `~/.hindsight/coding-agent.json` through a service on the connected OpenChamber server. API tokens stay out of the frame. Web and Electron support the panel, including remote servers. Mobile and VS Code retain their unsupported extension catalog.

```bash
bun run extensions:hindsight:build
```

Install the generated `hindsight/dist` folder through Settings → Extensions on each server. Installation requests the local-service capability. Updating the folder and reopening the panel updates the extension without rebuilding OpenChamber.

Run the extension checks from the repository root:

```bash
bun run test:extensions
bun run lint:extensions
bun check -p packages/extensions/tsconfig.json
```

Hindsight source and connection invariants: [hindsight/DOCUMENTATION.md](./hindsight/DOCUMENTATION.md).

Implementation and trust rules: [DOCUMENTATION.md](./DOCUMENTATION.md).
