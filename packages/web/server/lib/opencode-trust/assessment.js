import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// What Pi runs from a folder's own `.pi` directory, found the way Pi 1.5
// discovers it (`core/package-manager.js`, `core/settings-manager.js`,
// `extensions/mcp/config.js` in `@earendil-works/pi-coding-agent`):
//
// - `.pi/extensions`: direct `.ts`/`.js` files and subfolders with an
//   `index.ts|js` or a `package.json` that declares `pi.extensions`.
// - `.pi/settings.json`: `packages` (an npm or git source is installed and
//   loaded, a local path is loaded as it is), `extensions` paths, and the
//   settings Pi runs as commands (`shellPath`, `shellCommandPrefix`,
//   `npmCommand`, `externalEditor`).
// - `.pi/mcp.json`: stdio servers, and `!command` or environment-variable
//   values in the `env`, `headers` and `oauth.clientSecret` of a server.
//
// Pi looks only in `<folder>/.pi`, never in a parent. Skills, prompt
// templates, themes, `SYSTEM.md` and context files are text and add nothing.

const PROJECT_DIRECTORY = '.pi';
const SETTINGS_FILE = 'settings.json';
const MCP_FILE = 'mcp.json';
const EXTENSIONS_DIRECTORY = 'extensions';
const MANIFEST_FILE = 'package.json';

// Settings that Pi merges from the project file over the user's and runs as a
// command. `selfUpdateCommand`, `httpProxy` and `defaultProjectTrust` are read
// from the user's settings only, so a project cannot set them.
const COMMAND_SETTINGS = ['shellPath', 'shellCommandPrefix', 'npmCommand', 'externalEditor'];
// The fields of an MCP server entry that decide what runs. Descriptions,
// exposure and timeouts change nothing about it.
const MCP_CODE_FIELDS = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth'];

// A configuration file past this size is not read: it counts as a file
// OpenChamber cannot show, fingerprinted by its size.
const CONFIG_BYTE_LIMIT = 1024 * 1024;

const EXTENSION_SOURCE = /\.(ts|js)$/;
const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/;
// `from '…'`, `import '…'`, `import('…')` and `require('…')`. A match in a
// comment or a string only hashes one more file.
const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]+)\1/g;
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
// `$NAME` and `${NAME}` in a value Pi resolves from the environment; `$$` and
// `$!` are escapes.
const ENVIRONMENT_REFERENCE = /\$(?:[$!]|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

// A folder is hashed file by file. Past these limits the remaining files count
// by path and size only, so a huge vendored tree cannot stall the check; a
// change in such a file that keeps its size goes unnoticed.
const TREE_CONTENT_FILE_LIMIT = 500;
const TREE_CONTENT_BYTE_LIMIT = 16 * 1024 * 1024;
// A folder is also walked only so far, so a package source such as `/` cannot
// send the check across the disk. Entries past the limit are not seen.
const TREE_ENTRY_LIMIT = 20000;
const TRUNCATED_LINE = `truncated at ${TREE_ENTRY_LIMIT} entries`;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const toSlashes = (value) => value.split(path.sep).join('/');

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value) => typeof value === 'string';

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const isInside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

const statOrNull = (fsPromises, target) => fsPromises.stat(target).catch(() => null);

const readDirectoryOrEmpty = (fsPromises, directory) => (
  fsPromises.readdir(directory, { withFileTypes: true }).catch(() => [])
);

/** A path for display and for the fingerprint: relative inside the folder, absolute outside it, so worktrees agree. */
const displayPath = (directory, target) => {
  if (target === directory) return '.';
  return toSlashes(isInside(directory, target) ? path.relative(directory, target) : target);
};

const expandHome = (value, homeDirectory) => {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

/** A path from a settings file the way Pi resolves it: trimmed, `~` and `file://` expanded, relative to the `.pi` folder. */
const resolveSettingPath = (value, baseDirectory, homeDirectory) => {
  let expanded = expandHome(value.trim(), homeDirectory);
  if (expanded.startsWith('file://')) {
    try {
      expanded = fileURLToPath(expanded);
    } catch {
      return null;
    }
  }
  return path.resolve(baseDirectory, expanded);
};

const newBudget = () => ({ files: TREE_CONTENT_FILE_LIMIT, bytes: TREE_CONTENT_BYTE_LIMIT });

/** Takes one file of `size` bytes from `budget`; false once it is spent. */
const spend = (budget, size) => {
  if (budget.files <= 0 || budget.bytes < size) return false;
  budget.files -= 1;
  budget.bytes -= size;
  return true;
};

/** Content hash of a regular file, or its size once `budget` is spent, so a huge file is never read whole. */
const hashFileWithin = async (fsPromises, file, size, budget) => (
  spend(budget, size) ? sha256(await fsPromises.readFile(file)) : sha256(`size:${size}`)
);

/**
 * Hash of a folder and the script files in it, whose imports are followed.
 * `hashed` holds the files the hash covers. A linked folder inside the tree is
 * recorded with its link text and not entered, so what lies behind it is
 * covered only when a script imports it.
 */
const hashTree = async (fsPromises, root) => {
  const lines = [];
  const scripts = [];
  const hashed = new Set();
  const budget = newBudget();
  let visited = 0;
  const visit = async (directory) => {
    // `node_modules` goes last, so a vendored tree uses up the budget after the code.
    const entries = (await readDirectoryOrEmpty(fsPromises, directory))
      .filter((entry) => entry.name !== '.git')
      .sort((a, b) => (a.name === 'node_modules') - (b.name === 'node_modules') || byName(a, b));
    for (const entry of entries) {
      if (visited >= TREE_ENTRY_LIMIT) {
        if (!lines.includes(TRUNCATED_LINE)) lines.push(TRUNCATED_LINE);
        return;
      }
      visited += 1;
      const target = path.join(directory, entry.name);
      const relative = toSlashes(path.relative(root, target));
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      const info = await statOrNull(fsPromises, target);
      if (!info) continue;
      if (info.isDirectory()) {
        lines.push(`${relative}/ -> ${await fsPromises.readlink(target).catch(() => 'link')}`);
        continue;
      }
      hashed.add(target);
      // Reading a pipe or a device would never end.
      if (!info.isFile()) {
        lines.push(`${relative} special`);
        continue;
      }
      lines.push(`${relative} ${await hashFileWithin(fsPromises, target, info.size, budget).catch(() => 'unreadable')}`);
      if (SCRIPT_SOURCE.test(entry.name)) scripts.push(target);
    }
  };
  await visit(root);
  return { hash: sha256(lines.join('\n')), scripts, hashed };
};

const isFileAt = async (fsPromises, target) => Boolean((await statOrNull(fsPromises, target))?.isFile());

const isLocalReference = (value) => (
  value.startsWith('./') || value.startsWith('../') || value.startsWith('file://') || path.isAbsolute(value)
);

const resolveLocalReference = (value, documentDirectory) => {
  if (value.startsWith('file://')) {
    try {
      return new URL(value).pathname;
    } catch {
      return null;
    }
  }
  return path.resolve(documentDirectory, value);
};

/** The file a local import names, the way Bun resolves it; null when there is none. */
const resolveImport = async (fsPromises, specifier, fromDirectory) => {
  const base = resolveLocalReference(specifier, fromDirectory);
  if (!base) return null;
  const candidates = [
    base,
    // TypeScript sources import each other by their emitted `.js` names.
    base.replace(/\.([mc]?)js(x?)$/, '.$1ts$2'),
    ...IMPORT_EXTENSIONS.map((extension) => base + extension),
    ...IMPORT_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (await isFileAt(fsPromises, candidate)) return candidate;
  }
  return null;
};

/** Where a script's relative imports start from: its own folder, and the folder of its target when it is a link. */
const importDirectories = async (fsPromises, file) => {
  const real = await fsPromises.realpath(file).catch(() => file);
  return real === file ? [path.dirname(file)] : [path.dirname(file), path.dirname(real)];
};

/**
 * Lines naming every local file a script imports, directly or through each
 * other, that the extension's own hash does not cover (`ownFiles`), each with
 * its content hash, plus every local import that names no file yet. Package
 * imports are not followed: a repository does not write `node_modules`.
 */
const importedFileLines = async (fsPromises, ownFiles, base, scripts) => {
  const isOwn = (file) => ownFiles.has(file);
  const relative = (file) => toSlashes(path.relative(base, file));
  const budget = newBudget();
  const seen = new Set(scripts);
  const queue = [...scripts];
  const lines = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const info = await statOrNull(fsPromises, file);
    if (!info?.isFile()) continue;
    if (!spend(budget, info.size)) {
      if (!isOwn(file)) lines.push(`${relative(file)} size:${info.size}`);
      continue;
    }
    const content = await fsPromises.readFile(file).catch(() => null);
    if (!content) continue;
    if (!isOwn(file)) lines.push(`${relative(file)} ${sha256(content)}`);
    if (!SCRIPT_SOURCE.test(file)) continue;
    const directories = await importDirectories(fsPromises, file);
    for (const [, , specifier] of content.toString('utf8').matchAll(IMPORT_SPECIFIER)) {
      if (specifier.includes('${') || !isLocalReference(specifier)) continue;
      const targets = new Set();
      for (const directory of directories) {
        const target = await resolveImport(fsPromises, specifier, directory);
        if (target) targets.add(target);
      }
      if (targets.size === 0) {
        lines.push(`${relative(file)} imports ${specifier}: missing`);
        continue;
      }
      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return lines.sort();
};

/**
 * Content hash of a code file or folder and the local files it imports; null
 * when it is gone. Code that imports nothing local keeps the hash of its own
 * content. `entryFiles` are the files Pi loads from a folder.
 */
const hashCodeTarget = async (fsPromises, target, entryFiles = []) => {
  const info = await statOrNull(fsPromises, target);
  if (!info) return null;
  let own;
  if (info.isDirectory()) {
    own = await hashTree(fsPromises, target);
  } else if (info.isFile()) {
    own = {
      hash: await hashFileWithin(fsPromises, target, info.size, newBudget()).catch(() => null),
      scripts: [target],
      hashed: new Set([target]),
    };
  } else {
    return sha256('special');
  }
  if (own.hash === null) return null;
  // Entry points are followed even when the walk of a huge folder stopped before them.
  const scripts = [...own.scripts, ...entryFiles.filter((file) => !own.hashed.has(file))];
  const imports = await importedFileLines(fsPromises, own.hashed, info.isDirectory() ? target : path.dirname(target), scripts);
  return imports.length === 0 ? own.hash : sha256([own.hash, ...imports].join('\n'));
};

/**
 * A JSON configuration file as Pi reads it (`JSON.parse` after a byte order
 * mark). `missing` also covers an empty file, which Pi reads as no settings.
 * Everything Pi might still read differently is `invalid` with a hash of what
 * is there: a file that does not parse, is too big, is no regular file (a
 * pipe would block the read) or cannot be read. `unread` marks the last
 * three, where Pi may well read what this function did not.
 */
const readJsonFile = async (fsPromises, file) => {
  const info = await statOrNull(fsPromises, file);
  if (!info) return { state: 'missing' };
  if (!info.isFile()) return { state: 'invalid', hash: sha256('special'), unread: true };
  if (info.size > CONFIG_BYTE_LIMIT) return { state: 'invalid', hash: sha256(`size:${info.size}`), unread: true };
  let text;
  try {
    text = await fsPromises.readFile(file, 'utf8');
  } catch {
    return { state: 'invalid', hash: sha256('unreadable'), unread: true };
  }
  if (text.trim() === '') return { state: 'missing' };
  try {
    return { state: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')), text };
  } catch {
    return { state: 'invalid', hash: sha256(text) };
  }
};

const configItem = (source, hash) => ({ kind: 'config', source, name: '', detail: '', hash });

const entryKind = async (fsPromises, entry, target) => {
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
  const info = await statOrNull(fsPromises, target);
  return info?.isDirectory() ? 'directory' : info?.isFile() ? 'file' : null;
};

/**
 * The `pi.extensions` paths of a `package.json`: `declared` is null when it
 * names none Pi would accept, and `unread` is set when the file is there but
 * too big or otherwise unreadable here, so Pi may find paths this cannot.
 */
const manifestExtensions = async (fsPromises, file) => {
  const document = await readJsonFile(fsPromises, file);
  if (document.state !== 'ok' || !isRecord(document.value) || !isRecord(document.value.pi)) {
    return { declared: null, unread: document.unread === true };
  }
  const entries = document.value.pi.extensions;
  return { declared: Array.isArray(entries) && entries.every(isString) ? entries : null, unread: false };
};

/**
 * The files Pi loads for an extension folder: its manifest's paths that
 * exist, else `index.ts`, else `index.js`; null for none. A manifest that
 * cannot be read here makes the folder an extension with no known entry
 * point, hashed as a whole.
 */
const entryPointsOf = async (fsPromises, directory) => {
  const { declared, unread } = await manifestExtensions(fsPromises, path.join(directory, MANIFEST_FILE));
  if (declared?.length) {
    const entries = [];
    for (const declaredPath of declared) {
      const resolved = path.resolve(directory, declaredPath);
      if (await statOrNull(fsPromises, resolved)) entries.push(resolved);
    }
    if (entries.length > 0) return entries;
  }
  for (const name of ['index.ts', 'index.js']) {
    const index = path.join(directory, name);
    if (await statOrNull(fsPromises, index)) return [index];
  }
  return unread ? [] : null;
};

/**
 * One thing Pi loads as an extension: the path that is hashed and shown, and
 * the paths it loads from outside it, which are listed and hashed on their
 * own. A folder is hashed as a whole, since its entry point imports its siblings.
 */
const folderUnit = (directory, entries) => ({
  target: directory,
  entries: entries.filter((entry) => isInside(directory, entry)),
  outside: entries.filter((entry) => !isInside(directory, entry)),
});

/**
 * What Pi loads as extensions from a folder (`collectAutoExtensionEntries`): a
 * folder with its own entry point loads just that; otherwise each direct
 * `.ts` or `.js` file and each subfolder with an entry point. Hidden names
 * and `node_modules` are skipped. Pi also skips what `.gitignore`, `.ignore`
 * and `.fdignore` list; those are counted here.
 */
const discoverExtensionUnits = async (fsPromises, directory) => {
  if (!(await statOrNull(fsPromises, directory))?.isDirectory()) return [];
  const rootEntries = await entryPointsOf(fsPromises, directory);
  if (rootEntries) return [folderUnit(directory, rootEntries)];
  const units = [];
  const entries = (await readDirectoryOrEmpty(fsPromises, directory)).sort(byName);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    const kind = await entryKind(fsPromises, entry, target);
    if (kind === 'file' && EXTENSION_SOURCE.test(entry.name)) {
      units.push({ target, entries: [], outside: [] });
    } else if (kind === 'directory') {
      const entryPoints = await entryPointsOf(fsPromises, target);
      if (entryPoints) units.push(folderUnit(target, entryPoints));
    }
  }
  return units;
};

/** An item per path loaded from outside the extension that names it, so the dialog shows every file that runs. */
const outsideItems = async (context, paths, source) => {
  const items = [];
  for (const target of paths) {
    if (context.loaded.has(target)) continue;
    context.loaded.add(target);
    items.push({
      kind: 'plugin',
      source,
      name: displayPath(context.directory, target),
      detail: '',
      hash: await hashCodeTarget(context.fsPromises, target),
    });
  }
  return items;
};

/**
 * The items of one extension. Found in a folder (`named` false) it is listed
 * by its own path; named by a settings entry it is listed under that file.
 */
const unitItem = async (context, unit, source, named) => {
  if (context.loaded.has(unit.target)) return [];
  context.loaded.add(unit.target);
  const own = {
    kind: 'plugin',
    source: named ? source : displayPath(context.directory, unit.target),
    name: named ? displayPath(context.directory, unit.target) : '',
    detail: '',
    hash: await hashCodeTarget(context.fsPromises, unit.target, unit.entries),
  };
  return [own, ...await outsideItems(context, unit.outside, own.source)];
};

/** Content lines for the files `argv` names inside the folder: the script an MCP server or package manager runs. */
const localFileLines = async (context, argv, cwd) => {
  const lines = [];
  const seen = new Set();
  for (const argument of argv) {
    if (!isString(argument)) continue;
    const target = path.resolve(cwd, expandHome(argument, context.homeDirectory));
    if (seen.has(target) || !isInside(context.directory, target)) continue;
    seen.add(target);
    if (!(await statOrNull(context.fsPromises, target))?.isFile()) continue;
    lines.push(`${displayPath(context.directory, target)} ${await hashCodeTarget(context.fsPromises, target)}`);
  }
  return lines;
};

const describeValue = (value) => (
  isString(value) ? value : Array.isArray(value) ? value.map(String).join(' ') : JSON.stringify(value)
);

const isUnset = (value) => value === undefined || value === null || value === '' || value === false
  || (Array.isArray(value) && value.length === 0);

// The command is a file of the folder only when it names a path; a bare name is looked up in `PATH`.
const withCommand = (command, args) => [...(/[\\/]/.test(command) ? [command] : []), ...args];

// The files of the folder a command setting runs. `shellPath` is the shell
// itself, so it is a path whatever it looks like; an argv names a program and
// its arguments; shell text, such as a prefix, is not followed.
const filesOfCommand = (key, value) => {
  if (key === 'shellPath' && isString(value)) return [value];
  if (Array.isArray(value) && value.every(isString)) return withCommand(value[0], value.slice(1));
  return [];
};

const commandSettingItem = async (context, source, key, value) => {
  const lines = await localFileLines(context, filesOfCommand(key, value), context.directory);
  return {
    kind: 'shell',
    source,
    name: key,
    detail: `${key}: ${describeValue(value)}`,
    hash: lines.length === 0 ? null : sha256(lines.join('\n')),
  };
};

// How Pi classifies a package source (`parseSource` and `isLocalPath`):
// `npm:` is npm, these schemes are git, `builtin:` names no package and
// everything else is a path.
const GIT_SOURCE = /^(?:git|github|http|https|ssh):/;

// Entries Pi uses to filter the list. They name no path of their own.
const isPathPattern = (entry) => /^[!+-]/.test(entry) || entry.includes('*') || entry.includes('?');

/** The folder before the first wildcard of a glob, which stands for everything the glob matches; the entry itself when it has none. */
const staticPart = (entry) => {
  const segments = entry.split(/[\\/]/);
  const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
  return (wildcard === -1 ? segments : segments.slice(0, wildcard)).join('/') || '.';
};

/** The paths a local package's manifest loads from outside the package that exist; a glob counts the folder it starts in, whole. */
const packageOutsideTargets = async (context, root) => {
  const { declared } = await manifestExtensions(context.fsPromises, path.join(root, MANIFEST_FILE));
  const targets = [];
  for (const entry of (declared ?? []).filter((candidate) => !/^[!+-]/.test(candidate))) {
    const target = path.resolve(root, staticPart(entry));
    if (!isInside(root, target) && !targets.includes(target) && await statOrNull(context.fsPromises, target)) targets.push(target);
  }
  return targets;
};

const packageItem = async (context, source, entry) => {
  const spec = isString(entry) ? entry : entry.source;
  const trimmed = spec.trim();
  if (trimmed.startsWith('builtin:')) return [];
  // The filter decides whether the package's extensions load at all.
  const filter = isRecord(entry) ? sha256(JSON.stringify([entry.extensions ?? null, entry.autoload ?? null])) : null;
  if (trimmed.startsWith('npm:')) return [{ kind: 'package', source, name: spec, detail: '', hash: filter }];
  if (GIT_SOURCE.test(trimmed)) return [{ kind: 'plugin', source, name: spec, detail: '', hash: filter }];
  const target = resolveSettingPath(spec, path.join(context.directory, PROJECT_DIRECTORY), context.homeDirectory);
  const info = target ? await statOrNull(context.fsPromises, target) : null;
  if (!info) return [];
  const content = await hashCodeTarget(context.fsPromises, target);
  const own = {
    kind: 'plugin',
    source,
    name: displayPath(context.directory, target),
    detail: '',
    hash: filter === null ? content : sha256(`${content}\n${filter}`),
  };
  const outside = info.isDirectory() ? await packageOutsideTargets(context, target) : [];
  return [own, ...await outsideItems(context, outside, source)];
};

const isPackageEntry = (entry) => isString(entry) || (isRecord(entry) && isString(entry.source));

/**
 * The entries of `.pi/settings.json` that run code. A file that does not
 * parse, or whose `packages` or `extensions` have a shape Pi would not
 * accept, counts as code until the user has seen it.
 */
const settingsItems = async (context, file, source) => {
  const document = await readJsonFile(context.fsPromises, file);
  if (document.state === 'missing') return [];
  if (document.state === 'invalid') return [configItem(source, document.hash)];
  const settings = document.value;
  const { packages, extensions } = isRecord(settings) ? settings : {};
  const wellFormed = isRecord(settings)
    && (packages == null || (Array.isArray(packages) && packages.every(isPackageEntry)))
    && (extensions == null || (Array.isArray(extensions) && extensions.every(isString)));
  if (!wellFormed) return [configItem(source, sha256(document.text))];

  const items = [];
  for (const key of COMMAND_SETTINGS) {
    if (!isUnset(settings[key])) items.push(await commandSettingItem(context, source, key, settings[key]));
  }
  for (const entry of packages ?? []) items.push(...await packageItem(context, source, entry));

  const projectDirectory = path.join(context.directory, PROJECT_DIRECTORY);
  for (const entry of (extensions ?? []).filter((candidate) => !isPathPattern(candidate))) {
    const target = resolveSettingPath(entry, projectDirectory, context.homeDirectory);
    const info = target ? await statOrNull(context.fsPromises, target) : null;
    if (!info) continue;
    const units = info.isDirectory()
      ? await discoverExtensionUnits(context.fsPromises, target)
      : [{ target, entries: [], outside: [] }];
    for (const unit of units) items.push(...await unitItem(context, unit, source, true));
  }
  return items;
};

const environmentReferences = (value) => (
  value.startsWith('!') ? [] : [...value.matchAll(ENVIRONMENT_REFERENCE)].flatMap(([, braced, bare]) => braced ?? bare ?? [])
);

/** The `key=value` pairs of a string record that run a command or send an environment variable. */
const resolvedValues = (record) => (
  Object.entries(isRecord(record) ? record : {})
    .filter(([, value]) => isString(value) && (value.startsWith('!') || environmentReferences(value).length > 0))
    .map(([key, value]) => `${key}=${value}`)
);

const mcpServerItem = async (context, source, name, config) => {
  const record = Object.fromEntries(MCP_CODE_FIELDS.filter((field) => config[field] !== undefined).map((field) => [field, config[field]]));
  const base = { kind: 'mcp', source, name };
  if (isString(config.command)) {
    const args = Array.isArray(config.args) ? config.args.filter(isString) : [];
    const cwd = path.resolve(context.directory, isString(config.cwd) ? expandHome(config.cwd, context.homeDirectory) : '.');
    const files = await localFileLines(context, withCommand(config.command, args), cwd);
    const environment = Object.entries(isRecord(config.env) ? config.env : {}).filter(([, value]) => isString(value));
    const notes = [
      ...(isString(config.cwd) ? [`cwd ${config.cwd}`] : []),
      ...(environment.length > 0 ? [`env ${environment.map(([key, value]) => `${key}=${value}`).join(' ')}`] : []),
    ];
    return [{
      ...base,
      detail: [[config.command, ...args].join(' '), ...notes].join(' · '),
      hash: sha256(JSON.stringify([record, files])),
    }];
  }
  if (isString(config.url)) {
    const flagged = [
      ...resolvedValues(config.headers),
      ...resolvedValues({ 'oauth.clientSecret': isRecord(config.oauth) ? config.oauth.clientSecret : undefined }),
    ];
    if (flagged.length === 0) return [];
    return [{ ...base, detail: `${config.url} · ${flagged.join(' ')}`, hash: sha256(JSON.stringify([record, []])) }];
  }
  return [];
};

/**
 * The servers of `.pi/mcp.json` that run something: every enabled stdio
 * server, and a remote server whose headers or OAuth secret run a command or
 * hand over an environment variable. A remote server with literal headers
 * runs nothing on this machine.
 */
const mcpItems = async (context, file, source) => {
  const document = await readJsonFile(context.fsPromises, file);
  if (document.state === 'missing') return [];
  if (document.state === 'invalid') return [configItem(source, document.hash)];
  const root = document.value;
  if (!isRecord(root) || (root.mcpServers !== undefined && !isRecord(root.mcpServers))) {
    return [configItem(source, sha256(document.text))];
  }
  const items = [];
  const servers = Object.entries(root.mcpServers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, config] of servers) {
    if (!isRecord(config) || config.enabled === false) continue;
    items.push(...await mcpServerItem(context, source, name, config));
  }
  return items;
};

const compareItems = (a, b) => {
  for (const key of ['source', 'kind', 'name', 'detail']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
};

/** One item per what the user sees: the same package listed twice, with different filters, is one line with both in its hash. */
const mergeDuplicates = (sorted) => {
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && compareItems(last, item) === 0) last.hash = sha256(`${last.hash}\n${item.hash}`);
    else merged.push({ ...item });
  }
  return merged;
};

const projectItems = async (context) => {
  const projectDirectory = path.join(context.directory, PROJECT_DIRECTORY);
  if (!(await statOrNull(context.fsPromises, projectDirectory))?.isDirectory()) return [];
  const sourceOf = (name) => `${PROJECT_DIRECTORY}/${name}`;
  const items = [];
  for (const unit of await discoverExtensionUnits(context.fsPromises, path.join(projectDirectory, EXTENSIONS_DIRECTORY))) {
    items.push(...await unitItem(context, unit, '', false));
  }
  items.push(...await settingsItems(context, path.join(projectDirectory, SETTINGS_FILE), sourceOf(SETTINGS_FILE)));
  items.push(...await mcpItems(context, path.join(projectDirectory, MCP_FILE), sourceOf(MCP_FILE)));
  return mergeDuplicates(items.sort(compareItems));
};

/**
 * The repository a folder belongs to, so every worktree of one repository
 * shares its trust answers: the common git dir for a checkout or a linked
 * worktree, the folder itself outside Git.
 */
const repositoryKey = async (fsPromises, directory) => {
  let current = directory;
  for (;;) {
    const dotGit = path.join(current, '.git');
    const info = await fsPromises.lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) {
      return fsPromises.realpath(dotGit).catch(() => dotGit);
    }
    if (info?.isFile()) {
      const pointer = await fsPromises.readFile(dotGit, 'utf8').catch(() => '');
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (match) {
        const gitDir = path.resolve(current, match[1].trim());
        const common = (await fsPromises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
        const commonDir = common ? path.resolve(gitDir, common) : gitDir;
        return fsPromises.realpath(commonDir).catch(() => commonDir);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return directory;
    current = parent;
  }
};

const fingerprintOf = (items) => (
  items.length === 0
    ? null
    : sha256(JSON.stringify(items.map(({ kind, source, name, detail, hash }) => [kind, source, name, detail, hash])))
);

/**
 * What Pi would run from `directory`'s `.pi` configuration, with a
 * fingerprint of it and the repository it belongs to. `fingerprint` is null
 * when there is nothing to run. A folder that does not exist has nothing: Pi
 * cannot open it either. `homeDirectory` expands `~` in paths the way Pi does.
 */
export const assessOpenCodeConfig = async (directory, {
  fsPromises = fs.promises,
  homeDirectory = os.homedir(),
} = {}) => {
  const resolved = await fsPromises.realpath(path.resolve(directory)).catch(() => null);
  if (!resolved) {
    return { directory, repositoryKey: path.resolve(directory), fingerprint: null, items: [] };
  }
  const items = await projectItems({ fsPromises, directory: resolved, homeDirectory, loaded: new Set() });
  return {
    directory: resolved,
    repositoryKey: await repositoryKey(fsPromises, resolved),
    fingerprint: fingerprintOf(items),
    items,
  };
};
