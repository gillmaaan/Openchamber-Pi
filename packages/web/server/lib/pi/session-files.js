// Reading Pi's session files without running an agent.
//
// A session is one JSONL file under `<agentDir>/sessions/--<cwd>--/`. Line 1 is
// the header; every other line is a tree node `{type, id, parentId, timestamp}`.
// The directory name encodes the cwd lossily, so the cwd always comes from the
// header. Pi appends one line per finished message with no lock: a reader can
// see a half-written last line and must ignore it.
//
// Format version 3 is the one this module understands (Pi 1.5.0). A newer
// version is reported as unsupported instead of misread.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const SUPPORTED_SESSION_FORMAT_VERSION = 3;

const TYPE_PREFIX = /^\{"type":"([a-z_]+)"/;

/** Entry type of a raw line without parsing it; null when the line is not an entry. */
const lineType = (line) => TYPE_PREFIX.exec(line)?.[1] ?? null;

const tryParse = (line) => {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

/**
 * The id the wire shows for a Pi session. Sessions the bridge created already
 * start with `ses` (their id is the one the UI minted); one made by the `pi`
 * CLI has a UUID, which the dialect's `ses...` ids cannot hold, so it is shown
 * as `ses_<uuid>`. A UUID is hexadecimal and never starts with `ses`, so the
 * two forms cannot collide.
 */
export const wireSessionId = (piId) => (piId.startsWith('ses') ? piId : `ses_${piId}`);

/**
 * The folder Pi keeps a working directory's sessions in: the real path without
 * its leading separator, `/`, `\` and `:` turned into `-`, between `--` marks.
 * Passing it as `--session-dir` pins where a child writes, so a project's own
 * `sessionDir` setting (which Pi reads even for an untrusted project) cannot
 * move a session out of the store the bridge reads.
 */
export const sessionDirFor = (sessionsDir, cwd) => {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* a folder that is gone keeps its name */ }
  return path.join(sessionsDir, `--${real.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
};

/** The id Pi put in a session file name: `<timestamp>_<id>.jsonl`. */
export const sessionIdFromFileName = (fileName) => {
  const match = /^[^_]+_(.+)\.jsonl$/.exec(fileName);
  return match ? match[1] : null;
};

const readHeaderLine = async (filePath) => {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 16 * 1024 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
};

/**
 * Header of a session file, or a reason it cannot be used.
 * @returns {Promise<{ ok: true, header: object } | { ok: false, reason: 'empty'|'invalid'|'unsupported_version' }>}
 */
export const readSessionHeader = async (filePath) => {
  const line = await readHeaderLine(filePath);
  if (!line) return { ok: false, reason: 'empty' };
  const header = tryParse(line);
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  if (header.version !== SUPPORTED_SESSION_FORMAT_VERSION) return { ok: false, reason: 'unsupported_version' };
  return { ok: true, header };
};

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });

const addUsage = (total, usage) => {
  if (!usage || typeof usage !== 'object') return;
  total.input += Number(usage.input) || 0;
  total.output += Number(usage.output) || 0;
  total.cacheRead += Number(usage.cacheRead) || 0;
  total.cacheWrite += Number(usage.cacheWrite) || 0;
  total.reasoning += Number(usage.reasoning) || 0;
  total.cost += Number(usage.cost?.total) || 0;
};

/**
 * One pass over a session file for what a session list shows: the name, the
 * first user prompt, how many messages it holds, when it last changed, the
 * model and thinking level last chosen, and the usage of every assistant
 * message. Only the lines that carry that information are parsed.
 *
 * `activity` is what the usage report counts: `steps` (one `[time, provider,
 * model, thinkingLevel, input, output, reasoning, cacheRead, cacheWrite, cost]`
 * per assistant message) and `prompts` (the time of each user message). A
 * session that was forked from another one starts with a copy of its history;
 * what happened before the fork is not counted again.
 */
export const summarizeSessionFile = async (filePath) => {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let name;
  let firstUserText;
  let messageCount = 0;
  let lastTimestamp;
  let model;
  let thinkingLevel;
  const usage = emptyUsage();
  const steps = [];
  const prompts = [];
  let ownSince = 0;
  try {
    let first = true;
    for await (const line of lines) {
      if (first) {
        first = false;
        header = tryParse(line);
        if (typeof header?.parentSession === 'string') ownSince = Date.parse(header.timestamp) || 0;
        continue;
      }
      const type = lineType(line);
      if (type === 'message') {
        messageCount += 1;
        if (line.includes('"role":"assistant"')) {
          const message = tryParse(line)?.message;
          addUsage(usage, message?.usage);
          if (message && typeof message.timestamp === 'number' && message.timestamp > ownSince) {
            const u = message.usage ?? {};
            steps.push([message.timestamp, message.provider, message.model, message.thinkingLevel ?? thinkingLevel, Number(u.input) || 0, Number(u.output) || 0, Number(u.reasoning) || 0, Number(u.cacheRead) || 0, Number(u.cacheWrite) || 0, Number(u.cost?.total) || 0]);
          }
        }
        if (line.includes('"role":"user"')) {
          const stamp = Date.parse(/"timestamp":"([^"]+)"/.exec(line.slice(0, 200))?.[1] ?? '');
          if (Number.isFinite(stamp) && stamp > ownSince) prompts.push(stamp);
        }
        if (firstUserText === undefined && line.includes('"role":"user"')) {
          const entry = tryParse(line);
          const content = entry?.message?.content;
          firstUserText = typeof content === 'string'
            ? content
            : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
        }
      } else if (type === 'session_info') {
        const entry = tryParse(line);
        name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
      } else if (type === 'model_change') {
        const entry = tryParse(line);
        if (typeof entry?.provider === 'string' && typeof entry?.modelId === 'string') model = { provider: entry.provider, modelId: entry.modelId };
      } else if (type === 'thinking_level_change') {
        const entry = tryParse(line);
        if (typeof entry?.thinkingLevel === 'string') thinkingLevel = entry.thinkingLevel;
      }
      const stamp = /"timestamp":"([^"]+)"/.exec(line.slice(0, 200));
      if (stamp) lastTimestamp = stamp[1];
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { header, name, firstUserText: firstUserText ?? '', messageCount, lastTimestamp, model, thinkingLevel, usage, activity: { steps, prompts } };
};

/**
 * Every entry of a session file in append order, header excluded. A last line
 * that does not parse is a write in progress and is skipped.
 */
export const readSessionEntries = async (filePath) => {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const entries = [];
  try {
    let first = true;
    for await (const line of lines) {
      if (first) {
        first = false;
        continue;
      }
      if (!line) continue;
      const entry = tryParse(line);
      if (entry) entries.push(entry);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return entries;
};

/**
 * The active branch: from the last entry (Pi opens a file with its leaf at the
 * last line) follow `parentId` to the root, returned root first.
 */
export const activeBranch = (entries) => {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  for (let entry = entries.at(-1); entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    seen.add(entry.id);
    branch.push(entry);
  }
  return branch.reverse();
};

/**
 * The index of every session file under a sessions directory, cached per file
 * by size and mtime so a listing re-reads only what changed.
 */
export const createSessionFileIndex = ({ sessionsDir, now = () => Date.now(), ttlMs = 400 } = {}) => {
  const summaries = new Map();
  let snapshot = null;
  let snapshotAt = 0;
  let inFlight = null;

  const listFiles = async () => {
    let directories;
    try {
      directories = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const full = path.join(sessionsDir, directory.name);
      let names;
      try {
        names = await fs.promises.readdir(full);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.jsonl')) files.push(path.join(full, name));
      }
    }
    return files;
  };

  const summarize = async (filePath) => {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    const cached = summaries.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.session;

    const headerResult = await readSessionHeader(filePath);
    if (!headerResult.ok) {
      summaries.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, session: null, reason: headerResult.reason });
      return null;
    }
    const summary = await summarizeSessionFile(filePath);
    const header = headerResult.header;
    const session = {
      id: wireSessionId(header.id),
      piId: header.id,
      path: filePath,
      cwd: header.cwd,
      parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : undefined,
      name: summary.name,
      firstUserText: summary.firstUserText,
      messageCount: summary.messageCount,
      model: summary.model,
      thinkingLevel: summary.thinkingLevel,
      usage: summary.usage,
      activity: summary.activity,
      createdAt: Date.parse(header.timestamp) || stat.birthtimeMs,
      updatedAt: Date.parse(summary.lastTimestamp ?? '') || stat.mtimeMs,
    };
    summaries.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, session });
    return session;
  };

  const rebuild = async () => {
    const files = await listFiles();
    const sessions = [];
    for (const filePath of files) {
      const session = await summarize(filePath);
      if (session) sessions.push(session);
    }
    for (const known of [...summaries.keys()]) {
      if (!files.includes(known)) summaries.delete(known);
    }
    snapshot = sessions;
    snapshotAt = now();
    return sessions;
  };

  /** All sessions, newest change first. Concurrent callers share one scan. */
  const list = async ({ force = false } = {}) => {
    if (!force && snapshot && now() - snapshotAt < ttlMs) return snapshot;
    inFlight ??= rebuild().finally(() => { inFlight = null; });
    const sessions = await inFlight;
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const get = async (id) => (await list()).find((session) => session.id === id) ?? null;

  const invalidate = () => {
    snapshot = null;
  };

  return { list, get, invalidate };
};
