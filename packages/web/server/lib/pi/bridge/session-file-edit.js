// Changing a Pi session file the bridge does not run an agent on: copying a
// prefix into a new session (fork), changing the folder it belongs to (move),
// cutting the end off (revert commit) and appending a notice.
//
// Every change either replaces the file in one rename or appends whole lines,
// so a reader (or a crash) sees the old file or the new one, never half of
// either. Callers stop the Pi child that holds the file first: a child keeps
// appending to the inode it opened, which a rename leaves behind.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { activeBranch, readSessionEntries, readSessionHeader } from '../session-files.js';
import { LOCATION_SWITCHED_ENTRY } from '../wire/transcript.js';
import { noticeMessageId } from '../wire/mapping.js';

const HEADER_CHUNK_BYTES = 64 * 1024;
const SESSION_FORMAT_VERSION = 3;

const tmpNameFor = (filePath, tag) => `${filePath}.${tag}-${process.pid}-${randomBytes(4).toString('hex')}`;

const lineOf = (value) => `${JSON.stringify(value)}\n`;

/** An 8-character hex id the way Pi mints them, not in `taken`. */
export const newEntryId = (taken) => {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!taken.has(id)) return id;
  }
};

const writeAtomic = async (filePath, write) => {
  const tmp = tmpNameFor(filePath, 'tmp');
  // A replaced file keeps its permissions; a new one gets what Pi gives its own (umask applies).
  const mode = await fs.promises.stat(filePath).then((stat) => stat.mode & 0o777, () => null);
  const handle = await fs.promises.open(tmp, 'wx', mode ?? 0o666);
  try {
    if (mode !== null) await handle.chmod(mode);
    await write(handle);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
};

/** The header and the entries of a session file. The header is null when the file has none Pi 1.5.0 can use. */
export const readSessionFile = async (filePath) => {
  const result = await readSessionHeader(filePath);
  if (!result.ok) return { header: null, entries: [], reason: result.reason };
  return { header: result.header, entries: await readSessionEntries(filePath) };
};

/** Write a whole session file: the header, then the entries. */
export const writeSessionFile = (filePath, header, entries) => writeAtomic(filePath, async (handle) => {
  await handle.writeFile([header, ...entries].map(lineOf).join(''), 'utf8');
});

const fileNameFor = (id, now) => `${new Date(now).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`;

/**
 * A new session file that holds the first `cutIndex` entries of the source's
 * active branch under a new header: its own id, `parentSession` naming the
 * source. The notices of a move keep their meaning but get ids of their own
 * (ids derive from the fork's salt), as every message of the copy does.
 *
 * @param {object} options
 * @param {string} options.sourcePath
 * @param {object} options.sourceHeader
 * @param {object[]} options.sourceEntries  All entries of the source file.
 * @param {number} options.cutIndex  How many entries of the active branch to keep.
 * @param {string} options.newId
 * @param {string} options.targetDir  The folder the new file goes into.
 * @param {string} options.cwd
 * @param {number} options.now
 * @returns {Promise<{ path: string, entries: object[] }>}
 */
export const forkSessionFile = async ({ sourcePath, sourceHeader, sourceEntries, cutIndex, newId, targetDir, cwd, now }) => {
  const kept = activeBranch(sourceEntries).slice(0, cutIndex).map((entry) => {
    if (entry.type === 'custom' && entry.customType === LOCATION_SWITCHED_ENTRY && typeof entry.data?.messageId === 'string') {
      return { ...entry, data: { ...entry.data, messageId: noticeMessageId('location', entry.data.created, entry.data.messageId, newId) } };
    }
    return entry;
  });
  const header = {
    type: 'session',
    version: sourceHeader.version ?? SESSION_FORMAT_VERSION,
    id: newId,
    timestamp: new Date(now).toISOString(),
    cwd,
    parentSession: sourcePath,
  };
  await fs.promises.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, fileNameFor(newId, now));
  await writeSessionFile(filePath, header, kept);
  return { path: filePath, entries: kept };
};

/** The first line of a file and the byte offset where the second starts. */
const readFirstLine = async (filePath) => {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunks = [];
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(HEADER_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return { line: Buffer.concat(chunks).toString('utf8'), next: position };
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(buffer.subarray(0, newline));
        return { line: Buffer.concat(chunks).toString('utf8'), next: position + newline + 1 };
      }
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
};

const renameAcross = async (from, to) => {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fs.promises.rm(from);
  }
};

/**
 * Make a session belong to another folder: the header's `cwd` becomes
 * `newCwd`, and the file moves into the folder Pi keeps that cwd's sessions in
 * (`pi --continue` looks there). Two renames: the header change replaces the
 * file in place, then the file moves. A crash between them leaves a file whose
 * header is right in the old folder, which the session index reads fine.
 *
 * @returns {Promise<{ path: string }>}
 */
export const moveSessionFile = async ({ filePath, newCwd, targetDir }) => {
  const { line, next } = await readFirstLine(filePath);
  let header;
  try { header = JSON.parse(line); } catch { header = null; }
  if (!header || header.type !== 'session') throw new Error(`Not a session file: ${filePath}`);

  await writeAtomic(filePath, async (handle) => {
    await handle.writeFile(lineOf({ ...header, cwd: newCwd }), 'utf8');
    const source = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let position = next;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await handle.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
    } finally {
      await source.close();
    }
  });

  if (path.resolve(path.dirname(filePath)) === path.resolve(targetDir)) return { path: filePath };
  await fs.promises.mkdir(targetDir, { recursive: true });
  const destination = path.join(targetDir, path.basename(filePath));
  if (fs.existsSync(destination)) throw new Error(`A session file already exists at ${destination}`);
  await renameAcross(filePath, destination);
  return { path: destination };
};

/** Append one entry as the new leaf. Pi's own lines end with a newline; a missing one is added first. */
export const appendSessionEntry = async (filePath, entry) => {
  const handle = await fs.promises.open(filePath, 'a+');
  try {
    const { size } = await handle.stat();
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    await handle.appendFile(`${prefix}${lineOf(entry)}`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** A custom entry, as the leaf of the active branch of `entries`. */
export const customEntryAfterLeaf = (entries, customType, data, now) => {
  const taken = new Set(entries.map((entry) => entry.id));
  const leaf = entries.at(-1);
  return {
    type: 'custom',
    id: newEntryId(taken),
    parentId: leaf?.id ?? null,
    timestamp: new Date(now).toISOString(),
    customType,
    data,
  };
};

/**
 * Remove `entries[cutIndex]` of the active branch and everything that hangs
 * below it, in one atomic replacement. Branches that split off earlier stay;
 * if one of them would then be the last line (which Pi opens as the current
 * leaf), the kept part of the active branch moves behind it.
 *
 * @returns {Promise<{ removed: Set<string> }>} The ids of the removed entries.
 */
export const truncateSessionFile = async ({ filePath, header, entries, cutIndex }) => {
  const branch = activeBranch(entries);
  const cut = branch[cutIndex];
  if (!cut) return { removed: new Set() };

  const children = new Map();
  for (const entry of entries) {
    if (entry.parentId) children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry.id]);
  }
  const removed = new Set();
  const pending = [cut.id];
  while (pending.length > 0) {
    const id = pending.pop();
    if (removed.has(id)) continue;
    removed.add(id);
    pending.push(...(children.get(id) ?? []));
  }

  const kept = entries.filter((entry) => !removed.has(entry.id));
  const leaf = branch[cutIndex - 1];
  let ordered = kept;
  if (leaf && kept.at(-1)?.id !== leaf.id) {
    const onBranch = new Set(branch.slice(0, cutIndex).map((entry) => entry.id));
    ordered = [...kept.filter((entry) => !onBranch.has(entry.id)), ...kept.filter((entry) => onBranch.has(entry.id))];
  }
  await writeSessionFile(filePath, header, ordered);
  return { removed };
};
