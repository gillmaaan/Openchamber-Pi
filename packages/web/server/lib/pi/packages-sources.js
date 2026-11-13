// Pi package sources: which strings OpenChamber hands to `pi install`, how a
// source already in settings.json is read, and where Pi keeps it on disk.
//
// Pi decides the same things in `core/package-manager.js` and `utils/git.js`.
// Pi treats every string it cannot place as a local path (`pi install foo`
// looks for a folder named foo), so the strings that come from a text field are
// checked here first and only the forms below reach the CLI.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const codedError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// npm package names, scoped or not, with an optional version, dist-tag or range.
// A name never starts with `-`: it would reach npm's argv as an option.
const NPM_NAME = String.raw`(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*`;
const NPM_VERSION = String.raw`[\w.*^~<>=|+ -]*[\w*]`;
const NPM_SPEC = new RegExp(`^(${NPM_NAME})(?:@(${NPM_VERSION}))?$`, 'i');
const NPM_NAME_MAX_LENGTH = 214;

const LOCAL_PATH = /^(?:\.{1,2}[\\/]|~(?:[\\/]|$)|\/|[A-Za-z]:[\\/])/;
const HOSTED_SHORTHAND_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
// A ref never starts with `-`: it would reach `git checkout` as an option.
const GIT_REF = /^[\w.+/][\w.+/-]*$/;
const GIT_HOST = /^[a-z0-9][a-z0-9.-]*$/i;
const UNSUPPORTED_SOURCE = 'Pi installs npm packages (npm:name), git repositories (git:github.com/user/repo or https://...) and local folders (./path or /absolute/path)';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Text with the credentials in a URL, or in the `user:token@host/path` shorthand, masked. */
export const maskCredentials = (text) => String(text ?? '')
  .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
  .replace(/(^|[\s:'"(])[\w.~-]+:[^\s/@:]+@(?=[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b)/gi, '$1***@');

const parseNpmSpec = (spec) => {
  const match = NPM_SPEC.exec(spec);
  if (!match || match[1].length > NPM_NAME_MAX_LENGTH) return null;
  return { name: match[1], version: match[2] ?? null, spec };
};

/** Pi's `splitRef`: a trailing `@ref` on a git source. */
const splitGitRef = (url) => {
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  const rest = scp ? scp[2] : url.includes('://') ? safeUrl(url)?.pathname.replace(/^\/+/, '') : url.slice(url.indexOf('/') + 1);
  const separator = rest?.indexOf('@') ?? -1;
  if (separator < 1 || separator === rest.length - 1) return { repo: url, ref: null };
  const ref = rest.slice(separator + 1);
  return { repo: url.slice(0, url.length - ref.length - 1), ref };
};

const safeUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const unsafeGitPart = (value, allowSlash) => {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  return [value, decoded].some((part) => (
    part.includes('\0') || part.includes('\\') || part.startsWith('/')
    || (!allowSlash && part.includes('/')) || part.split('/').includes('..')
  ));
};

/**
 * The host and repository path of a git source, as Pi stores the clone
 * (`<agent dir>/git/<host>/<path>`). Null for a shape this module does not
 * read; such a source can still be listed, it just has no known clone.
 */
export const parseGitSource = (value) => {
  let text = value.trim();
  // `#ref` (the hosted-repository form) and a query string name a ref, not a path.
  let hashRef = null;
  const hash = text.indexOf('#');
  if (hash > 0) {
    hashRef = text.slice(hash + 1) || null;
    text = text.slice(0, hash);
  }
  if (!/^(?:https?|ssh|git):\/\//i.test(text)) text = text.replace(/\?.*$/, '');
  const { repo, ref: atRef } = splitGitRef(text);
  const ref = hashRef ?? atRef;
  let host;
  let repoPath;
  const scp = /^git@([^:]+):(.+)$/.exec(repo);
  if (scp) {
    [, host, repoPath] = scp;
  } else if (/^(?:https?|ssh|git):\/\//i.test(repo)) {
    const url = safeUrl(repo);
    if (!url) return null;
    host = url.hostname;
    repoPath = url.pathname.replace(/^\/+/, '');
  } else {
    const slash = repo.indexOf('/');
    if (slash < 0) return null;
    host = repo.slice(0, slash);
    repoPath = repo.slice(slash + 1);
    if (!host.includes('.') && host !== 'localhost') return null;
  }
  // A host that is not a plain name (`user:token@host`, `-oProxyCommand=...`) is never a clone location.
  if (!host || !GIT_HOST.test(host)) return null;
  host = host.toLowerCase();
  repoPath = repoPath.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  if (repoPath.split('/').length < 2 || unsafeGitPart(host, false) || unsafeGitPart(repoPath, true)) return null;
  return { host, path: repoPath, ref, repoName: repoPath.split('/').at(-1) };
};

/** Resolve a local source against the folder a settings file lives in (`~`, absolute and `file://` forms included). */
export const resolveLocalSource = (source, baseDir, homedir = os.homedir()) => {
  const text = source.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      return path.resolve(baseDir, text);
    }
  }
  if (text === '~') return homedir;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homedir, text.slice(2));
  return path.resolve(baseDir, text);
};

/**
 * Read a source string as written in settings.json.
 *
 * @returns {{ kind: 'npm', name: string, version: string|null, spec: string }
 *   | { kind: 'git', host: string, path: string, ref: string|null, repoName: string }
 *   | { kind: 'local', path: string }
 *   | { kind: 'unknown' }}
 */
export const parseConfiguredSource = (source) => {
  const text = String(source).trim();
  if (text.startsWith('npm:')) {
    const parsed = parseNpmSpec(text.slice(4).trim());
    return parsed ? { kind: 'npm', ...parsed } : { kind: 'unknown' };
  }
  const isUrl = /^(?:https?|ssh|git):\/\//i.test(text);
  if (isUrl || text.startsWith('git:')) {
    const parsed = parseGitSource(isUrl ? text : text.slice(4));
    return parsed ? { kind: 'git', ...parsed } : { kind: 'unknown' };
  }
  if (/^(?:github|gitlab|bitbucket|builtin):/i.test(text)) return { kind: 'unknown' };
  return { kind: 'local', path: text };
};

/** What names the same package in two spellings: the npm name, the repository, or the folder. */
export const sourceIdentity = (source, baseDir, homedir) => {
  const parsed = parseConfiguredSource(source);
  if (parsed.kind === 'npm') return `npm:${parsed.name}`;
  if (parsed.kind === 'git') return `git:${parsed.host}/${parsed.path}`;
  if (parsed.kind === 'local') return `local:${resolveLocalSource(parsed.path, baseDir, homedir)}`;
  return `raw:${String(source).trim()}`;
};

/** Where Pi keeps the package, or null when the source has no location this module knows. */
export const installedPathFor = (source, baseDir, homedir) => {
  const parsed = parseConfiguredSource(source);
  if (parsed.kind === 'npm') return path.join(baseDir, 'npm', 'node_modules', ...parsed.name.split('/'));
  if (parsed.kind === 'git') return path.join(baseDir, 'git', parsed.host, ...parsed.path.split('/'));
  if (parsed.kind === 'local') return resolveLocalSource(parsed.path, baseDir, homedir);
  return null;
};

const assertGitSource = (rest) => {
  const text = rest.trim();
  if (/^(?:http|git):\/\//i.test(text)) {
    throw codedError('This source would clone over an unencrypted connection. Use https:// or ssh://', 'UNLOADABLE_SPEC');
  }
  const url = /^(?:https|ssh):\/\//i.test(text) ? safeUrl(splitGitRef(text).repo) : null;
  if (url && (url.password || (url.username && url.protocol === 'https:'))) {
    throw codedError('A package source must not contain credentials. Use an SSH key or a git credential helper', 'UNLOADABLE_SPEC');
  }
  // A ref is written `@ref`; `#` and a query string would carry an unchecked ref or a token into git.
  const parsed = /[#?]/.test(text) ? null : parseGitSource(text);
  if (!parsed || (parsed.ref && !GIT_REF.test(parsed.ref))) {
    throw codedError('This is not a git source Pi can clone. Use git:github.com/user/repo[@ref] or https://host/user/repo, without credentials or a query string', 'UNLOADABLE_SPEC');
  }
};

/**
 * Turn what a person typed into the source `pi install` receives, or refuse it.
 *
 * - `npm:name[@version]`, and a bare `name[@version]`, become `npm:` sources.
 * - `git:host/user/repo[@ref]`, `https://host/user/repo[@ref]`,
 *   `ssh://git@host/user/repo` and `github:user/repo[#ref]` become git sources.
 * - A local folder (`./x`, `../x`, `/x`, `~/x`, `file:///x`) becomes an absolute path:
 *   Pi stores a path relative to the settings file, and resolves one given to
 *   `remove` and `update` against its own working directory, so only an
 *   absolute path means the same thing in every command.
 *
 * @param {unknown} input
 * @param {{ cwd?: string|null, homedir?: string }} [options] `cwd` is what a relative local path resolves against.
 * @returns {{ source: string, kind: 'npm'|'git'|'local' }}
 */
export const normalizePackageSource = (input, { cwd = null, homedir = os.homedir() } = {}) => {
  if (typeof input !== 'string' || !input.trim()) {
    throw codedError('Package source must be a non-empty string', 'INVALID_SPEC');
  }
  const text = input.trim();
  if (CONTROL_CHARACTERS.test(text)) throw codedError('Package source cannot contain control characters', 'INVALID_SPEC');
  if (text.startsWith('-')) throw codedError(UNSUPPORTED_SOURCE, 'UNLOADABLE_SPEC');

  if (/^file:\/\//i.test(text) || LOCAL_PATH.test(text)) {
    const relative = !/^file:\/\//i.test(text) && !path.isAbsolute(text) && !text.startsWith('~');
    if (relative && !cwd) {
      throw codedError('A relative path needs a project folder to resolve against. Use an absolute path', 'UNLOADABLE_SPEC');
    }
    return { source: resolveLocalSource(text, cwd ?? '/', homedir), kind: 'local' };
  }

  if (text.startsWith('npm:')) {
    const parsed = parseNpmSpec(text.slice(4).trim());
    if (!parsed) throw codedError(`"${maskCredentials(text)}" is not an npm package spec`, 'UNLOADABLE_SPEC');
    return { source: `npm:${parsed.spec}`, kind: 'npm' };
  }

  if (/\s/.test(text)) throw codedError(UNSUPPORTED_SOURCE, 'UNLOADABLE_SPEC');

  // `git://` is a protocol before it is a prefix.
  if (/^(?:https|ssh|http|git):\/\//i.test(text)) {
    assertGitSource(text);
    return { source: text, kind: 'git' };
  }
  if (text.startsWith('git:')) {
    assertGitSource(text.slice(4));
    return { source: text, kind: 'git' };
  }

  const hosted = /^(github|gitlab|bitbucket):([^#\s]+?)(?:#(\S+))?$/i.exec(text);
  if (hosted) {
    const host = HOSTED_SHORTHAND_HOSTS[hosted[1].toLowerCase()];
    const source = `git:${host}/${hosted[2]}${hosted[3] ? `@${hosted[3]}` : ''}`;
    assertGitSource(source.slice(4));
    return { source, kind: 'git' };
  }

  const bare = parseNpmSpec(text);
  if (bare) return { source: `npm:${bare.spec}`, kind: 'npm' };

  throw codedError(`"${maskCredentials(text)}" is not a source Pi can install. ${UNSUPPORTED_SOURCE}`, 'UNLOADABLE_SPEC');
};

/** Whether two npm specs are the same version choice, for the guard on "edit this entry's spec". */
export const isExactVersion = (version) => typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version);

const parseVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(version).trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
};

/** Semver order: negative when `a` is older than `b`, null when either is not a version. */
export const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
};
