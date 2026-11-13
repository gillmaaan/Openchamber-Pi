// The web server this app ships, packed into one npm tarball for a remote host.
//
// A remote instance runs @openchamber/web installed on that machine. Pulling it
// from the registry gave the remote a build that is not this one (it still
// expected the OpenCode CLI), so the SSH manager uploads this package instead.
// The tarball is laid out the way `npm pack` lays one out (`package/…`), carries
// the built UI as `package/dist`, and vendors @openchamber/sdk as a local file
// dependency this app ships, because `workspace:*` cannot be resolved outside
// the workspace and a registry lookup would fetch a build that is not this one.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** Files besides the UI build that a remote install needs from the web package. */
const WEB_ENTRIES = ['server', 'bin', 'README.md', 'package.json'];
/** What the vendored SDK needs; its own dependencies are installed by npm. */
const SDK_ENTRIES = ['dist', 'package.json', 'README.md'];

const BLOCK = 512;
const MODE_FILE = 0o644;
const MODE_EXEC = 0o755;

const writeString = (buffer, value, offset, length) => {
  buffer.write(String(value).slice(0, length), offset, length, 'utf8');
};

const writeOctal = (buffer, value, offset, length) => {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
};

/** One ustar header: type '5' is a folder, '0' a file. */
const tarHeader = (name, { size = 0, mode = MODE_FILE, directory = false } = {}) => {
  const header = Buffer.alloc(BLOCK, 0);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header[156] = directory ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
  header.write('        ', 148, 8, 'ascii');
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
};

const padding = (size) => (size % BLOCK === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - (size % BLOCK), 0));

/**
 * Packed entries -> a gzipped tarball npm can install. An entry's `name` is
 * its path in the archive; a folder entry ends in `/`.
 *
 * @param {Array<{ name: string, directory?: boolean, content?: Buffer, mode?: number }>} entries
 */
export const packTarball = (entries) => {
  const chunks = [];
  for (const entry of entries) {
    if (entry.directory) {
      chunks.push(tarHeader(entry.name, { mode: 0o755, directory: true }));
      continue;
    }
    chunks.push(tarHeader(entry.name, { size: entry.content.length, mode: entry.mode ?? MODE_FILE }));
    chunks.push(entry.content);
    chunks.push(padding(entry.content.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
};

/** Entries for a folder, every name prefixed with `prefix` (e.g. `package/`). */
const collectEntries = (root, prefix, entries = []) => {
  const walk = (relative) => {
    const full = path.join(root, relative);
    const stat = fs.statSync(full);
    const name = `${prefix}${relative.split(path.sep).join('/')}`;
    if (stat.isDirectory()) {
      entries.push({ name: name.endsWith('/') ? name : `${name}/`, directory: true });
      for (const child of fs.readdirSync(full).sort()) walk(relative ? path.join(relative, child) : child);
      return;
    }
    entries.push({ name, content: fs.readFileSync(full), mode: stat.mode & 0o111 ? MODE_EXEC : MODE_FILE });
  };
  walk('');
  return entries;
};

/**
 * Recursive copy with the calls Electron patches for `app.asar`
 * (`readdirSync`, `statSync`, `readFileSync`); `fs.cpSync` is not patched and
 * fails on a path inside the archive.
 */
const copyTree = (source, target) => {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(target, entry));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
};

const copyInto = (sourceRoot, relative, targetRoot) => {
  const source = path.join(sourceRoot, relative);
  if (!fs.existsSync(source)) return;
  copyTree(source, path.join(targetRoot, relative));
};

/**
 * Stages the app's web package and returns what a remote install uploads.
 *
 * The UI build is taken from `distDir` because a packaged app keeps it outside
 * the web package (`Resources/web-dist`). The SDK is vendored because the web
 * package depends on it as `workspace:*`, which npm cannot resolve outside the
 * workspace. npm resolves a `file:` dependency of an installed tarball against
 * the tarball's own folder, so the SDK sits in `vendor/` next to the tarball;
 * both files go to the remote host together.
 *
 * @param {object} options
 * @param {string} options.webPackageDir  The installed @openchamber/web folder.
 * @param {string} options.sdkPackageDir  The installed @openchamber/sdk folder.
 * @param {string} options.distDir        The built UI (Resources/web-dist).
 * @param {string} options.workDir        A folder this call may create and fill.
 * @returns {{ tarballPath: string, vendorPath: string, version: string, buildId: string }}
 */
export const createBundledWebTarball = ({ webPackageDir, sdkPackageDir, distDir, workDir }) => {
  const stage = path.join(workDir, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  for (const entry of WEB_ENTRIES) copyInto(webPackageDir, entry, stage);
  const packageNameAt = (folder) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).name ?? null;
    } catch {
      return null;
    }
  };
  if (packageNameAt(stage) !== '@openchamber/web') throw new Error(`Not an @openchamber/web package: ${webPackageDir}`);
  if (!fs.existsSync(distDir)) throw new Error(`The UI build is missing: ${distDir}`);
  copyTree(distDir, path.join(stage, 'dist'));

  const sdkStage = path.join(workDir, 'sdk-stage');
  fs.rmSync(sdkStage, { recursive: true, force: true });
  fs.mkdirSync(sdkStage, { recursive: true });
  for (const entry of SDK_ENTRIES) copyInto(sdkPackageDir, entry, sdkStage);
  if (packageNameAt(sdkStage) !== '@openchamber/sdk') throw new Error(`Not an @openchamber/sdk package: ${sdkPackageDir}`);

  const vendorDir = path.join(workDir, 'vendor');
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  const vendorPath = path.join(vendorDir, 'openchamber-sdk.tgz');
  fs.writeFileSync(vendorPath, packTarball(collectEntries(sdkStage, 'package/')));

  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  manifest.dependencies = { ...(manifest.dependencies ?? {}), '@openchamber/sdk': 'file:vendor/openchamber-sdk.tgz' };
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarball = packTarball(collectEntries(stage, 'package/'));
  const buildId = crypto.createHash('sha256').update(tarball).digest('hex').slice(0, 16);
  const tarballPath = path.join(workDir, `openchamber-web-${buildId}.tgz`);
  fs.writeFileSync(tarballPath, tarball);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(sdkStage, { recursive: true, force: true });
  return { tarballPath, vendorPath, version: String(manifest.version ?? ''), buildId };
};
