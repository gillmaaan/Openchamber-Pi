// How OpenChamber starts `pi --mode rpc`: which JavaScript runtime runs Pi's
// bundled RPC entry, what environment the child gets, and its arguments.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_RPC_ENTRY_SPECIFIER = '@earendil-works/pi-coding-agent/rpc-entry';

/**
 * A file a separate process must read. Inside a packaged app the module
 * resolves to a path in `app.asar`, which Electron's own fs can read but a
 * spawned Node or Bun cannot; the package is unpacked beside it, so the same
 * file is used from `app.asar.unpacked` when it exists there.
 */
export const readableEntryPath = (file) => {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!String(file).includes(marker)) return file;
  const candidate = String(file).replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  try {
    return fs.existsSync(candidate) ? candidate : file;
  } catch {
    return file;
  }
};

/** Pi's bundled RPC entry. Resolved from the package so `pi` need not be on PATH. */
export const resolvePiRpcEntry = () => readableEntryPath(fileURLToPath(import.meta.resolve(PI_RPC_ENTRY_SPECIFIER)));

const isExecutableFile = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const findOnPath = (name, pathValue, platform) => {
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of String(pathValue ?? '').split(separator).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * The runtime that executes Pi's bundle.
 *
 * - Electron runs its own binary as plain Node with `ELECTRON_RUN_AS_NODE`.
 * - Under Bun (the dev server), Pi runs on a real Node when one is on PATH: Pi
 *   loads extensions through jiti and is tested on Node.
 * - Otherwise the current executable is Node already.
 *
 * @returns {{ command: string, env: Record<string,string> }}
 */
export const resolvePiRuntime = ({
  env = process.env,
  execPath = process.execPath,
  versions = process.versions,
  platform = process.platform,
} = {}) => {
  if (versions.electron) {
    return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  if (versions.bun) {
    const node = findOnPath('node', env.PATH, platform);
    return { command: node ?? execPath, env: {} };
  }
  return { command: execPath, env: {} };
};

// OpenChamber's own server secrets and the previous agent's switches never
// belong in an agent child that runs the user's shell commands.
const STRIPPED_ENV_PREFIXES = ['OPENCODE_'];
const STRIPPED_ENV_NAMES = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'BUN_INSTALL_CACHE_DIR']);

/**
 * The environment of a Pi child: the inherited one (the user's shell PATH,
 * provider keys, proxies) without the previous agent's variables, plus what
 * the caller adds last.
 */
export const buildPiChildEnv = (baseEnv, extra = {}) => {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv ?? {})) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_NAMES.has(name)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
};

/**
 * Arguments after the RPC entry. RPC cannot prompt for project trust, so the
 * caller decides: `--approve` loads the project's `.pi/*` resources, and
 * `--no-approve` makes Pi ignore them.
 * `--offline` keeps each child from running Pi's startup network work (update
 * and catalog checks) on its own.
 *
 * @param {object} options
 * @param {string} [options.sessionFile]  Resume this session file.
 * @param {string} [options.sessionId]    Create or reuse the session with this id.
 * @param {string[]} [options.extensions] Extension files loaded with `-e`.
 * @param {string} [options.model]        `provider/id[:thinking]`.
 * @param {string} [options.sessionDir]
 * @param {boolean} [options.approveProject]  Trust the project's `.pi/*`; false passes `--no-approve`, so a folder nobody trusted loads nothing from it.
 * @param {string[]} [options.extraArgs]  Appended last: tool selection, system prompt additions.
 */
export const buildPiRpcArgs = ({
  sessionFile,
  sessionId,
  extensions = [],
  model,
  sessionDir,
  approveProject = false,
  extraArgs = [],
} = {}) => {
  const args = ['--offline'];
  args.push(approveProject ? '--approve' : '--no-approve');
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (sessionFile) args.push('--session', sessionFile);
  else if (sessionId) args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  for (const extension of extensions) args.push('-e', extension);
  args.push(...extraArgs);
  return args;
};

const MINIMUM_NODE = [22, 19, 0];

const nodeMeetsMinimum = (version) => {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== MINIMUM_NODE[index]) return version[index] > MINIMUM_NODE[index];
  }
  return true;
};

/**
 * A sentence for the user when the runtime Pi would run on cannot run it, or
 * null. Pi needs Node 22.19 or newer; Electron brings its own and Bun runs the
 * agent itself, so only a Node found on PATH (or the server's own) is checked.
 */
export const piRuntimeProblem = ({ runtime = resolvePiRuntime(), spawnSyncImpl = spawnSync } = {}) => {
  if (runtime.env.ELECTRON_RUN_AS_NODE) return null;
  const result = spawnSyncImpl(runtime.command, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return `The runtime for the Pi coding agent (${runtime.command}) cannot be started.`;
  // Node prints "v24.21.0"; Bun prints a bare version and runs Pi itself.
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(String(result.stdout).trim());
  if (!match) return null;
  const version = match.slice(1, 4).map(Number);
  return nodeMeetsMinimum(version)
    ? null
    : `The Pi coding agent needs Node ${MINIMUM_NODE.join('.')} or newer, but ${runtime.command} is Node ${version.join('.')}.`;
};

/** The installed Pi version, read from the package that holds the RPC entry; null when it cannot be found. */
export const readPiVersion = ({ entry = null } = {}) => {
  try {
    let directory = path.dirname(entry ?? resolvePiRpcEntry());
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (parsed?.name === '@earendil-works/pi-coding-agent') return typeof parsed.version === 'string' ? parsed.version : null;
      }
      directory = path.dirname(directory);
    }
  } catch { /* an unreadable install has no version to report */ }
  return null;
};
