// What OpenChamber knows about a session that Pi's file does not hold: whether
// it is archived or was viewed, its metadata map, the agent chosen for it, and
// the sessions that exist only in memory until Pi writes their file (Pi creates
// the file at the first message).
//
// One JSON file keyed by session id. Writes are serialized and atomic; a file
// that cannot be read is kept aside and replaced by an empty store, so a bad
// byte loses the sidecar data and never takes the session list down.

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../opencode/atomic-write.js';

const FORMAT_VERSION = 1;

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} options
 * @param {string} options.filePath
 * @param {(filePath: string, content: string) => void} [options.writeFile]
 * @param {() => number} [options.now]
 */
export const createSessionMetaStore = ({ filePath, writeFile = writeFileAtomic, now = () => Date.now() }) => {
  let records = null;
  let queue = Promise.resolve();

  const quarantine = () => {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${now()}`);
    } catch { /* nothing left to keep */ }
  };

  const load = () => {
    if (records) return records;
    records = new Map();
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return records;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      quarantine();
      return records;
    }
    if (!isPlainRecord(parsed) || parsed.version !== FORMAT_VERSION || !isPlainRecord(parsed.sessions)) {
      quarantine();
      return records;
    }
    for (const [id, record] of Object.entries(parsed.sessions)) {
      if (isPlainRecord(record)) records.set(id, record);
    }
    return records;
  };

  const persist = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFile(filePath, `${JSON.stringify({ version: FORMAT_VERSION, sessions: Object.fromEntries(load()) })}\n`);
  };

  /** Run a change after every earlier one, so concurrent patches do not lose each other. */
  const serialize = (change) => {
    const run = queue.then(change);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const get = (id) => load().get(id) ?? null;

  const all = () => Object.fromEntries(load());

  /**
   * Merge fields into a session's record. A key set to `undefined` or `null` is
   * removed; every other value replaces the old one whole.
   */
  const patch = (id, fields) => serialize(() => {
    const current = { ...(load().get(id) ?? {}) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) delete current[key];
      else current[key] = value;
    }
    if (Object.keys(current).length === 0) load().delete(id);
    else load().set(id, current);
    persist();
    return load().get(id) ?? null;
  });

  const remove = (id) => serialize(() => {
    if (!load().delete(id)) return false;
    persist();
    return true;
  });

  /** Sessions that have no Pi file yet, as `{ id, directory, createdAt }`. */
  const drafts = () => [...load()]
    .filter(([, record]) => isPlainRecord(record.draft) && typeof record.draft.directory === 'string')
    .map(([id, record]) => ({ id, directory: record.draft.directory, createdAt: record.draft.createdAt ?? 0 }));

  return { get, all, patch, remove, drafts };
};
