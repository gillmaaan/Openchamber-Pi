// `GET /api/experimental/session/stats`: usage over a time window, from the
// session files. The model steps come from the file index's cached summaries
// (`activity.steps`); tool calls are read from the files on request only, and
// kept per file until it changes.

import fs from 'node:fs';
import readline from 'node:readline';

import { invalidRequest } from './errors.js';
import { addTokens, tokensFromUsage, variantFromThinkingLevel, wireToolName, ZERO_TOKENS } from '../wire/mapping.js';

const QUARTER_HOUR_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

const zeroTokens = () => ({ ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } });

const parseInstant = (query, name) => {
  const text = query.get(name);
  if (text === null || text === '') return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw invalidRequest(`Expected a time in milliseconds\n  at ["${name}"]`, { kind: 'Query' });
  return value;
};

/** `YYYY-MM-DD` of an instant in a time zone; a zone's offset is a multiple of 15 minutes, so quarter-hours share a day. */
const createDayOf = (timeZone) => {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const cache = new Map();
  return (instant) => {
    const bucket = Math.floor(instant / QUARTER_HOUR_MS);
    let day = cache.get(bucket);
    if (!day) {
      day = format.format(bucket * QUARTER_HOUR_MS);
      cache.set(bucket, day);
    }
    return day;
  };
};

const longestStreak = (days) => {
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    const time = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && time - previous === DAY_MS ? run + 1 : 1;
    previous = time;
    best = Math.max(best, run);
  }
  return best;
};

const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Every tool call of a file as `[time, name, outcome, durationMs]`; outcome 0 succeeded, 1 failed, 2 never finished. */
const scanToolCalls = async (filePath) => {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const calls = [];
  /** tool call id -> the call still waiting for its result; providers reuse ids, so the latest message wins. */
  const open = new Map();
  try {
    for await (const line of lines) {
      const isAssistant = line.includes('"role":"assistant"') && line.includes('"toolCall"');
      const isResult = line.includes('"role":"toolResult"');
      if (!isAssistant && !isResult) continue;
      let message;
      try { message = JSON.parse(line)?.message; } catch { continue; }
      if (isAssistant && message?.role === 'assistant') {
        for (const block of message.content ?? []) {
          if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
          const call = { time: message.timestamp, name: wireToolName(block.name), outcome: 2 };
          calls.push(call);
          open.set(block.id, call);
        }
      } else if (isResult && message?.role === 'toolResult') {
        const call = open.get(message.toolCallId);
        if (!call) continue;
        open.delete(message.toolCallId);
        call.outcome = message.isError === true ? 1 : 0;
        if (typeof message.durationMs === 'number') call.duration = message.durationMs;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return calls.map((call) => [call.time, call.name, call.outcome, call.duration]);
};

/**
 * @param {object} deps
 * @param {{ list: () => Promise<object[]> }} deps.fileIndex
 * @param {{ get: (id: string) => object|null }} deps.metaStore
 * @param {(directory: string) => { id: string }} deps.projectOf
 * @param {() => number} [deps.now]
 */
export const createSessionStats = ({ fileIndex, metaStore, projectOf, now = () => Date.now() }) => {
  /** file path -> { size, mtimeMs, calls } */
  const toolCache = new Map();

  const callsOf = async (session) => {
    const stat = await fs.promises.stat(session.path).catch(() => null);
    if (!stat) return [];
    const cached = toolCache.get(session.path);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.calls;
    const calls = await scanToolCalls(session.path);
    toolCache.set(session.path, { size: stat.size, mtimeMs: stat.mtimeMs, calls });
    return calls;
  };

  /** @param {URLSearchParams} query  `from`, `to` (ms; from inclusive, to exclusive), `project`, `timezone`, `tools` (none|summary|detail). */
  const report = async (query) => {
    const requestedFrom = parseInstant(query, 'from');
    const to = parseInstant(query, 'to') ?? now();
    if (requestedFrom !== undefined && requestedFrom >= to) throw invalidRequest('Expected "from" to be before "to"\n  at ["from"]', { kind: 'Query' });
    const timezone = query.get('timezone') || 'UTC';
    let dayOf;
    try { dayOf = createDayOf(timezone); } catch { throw invalidRequest(`Expected an IANA time zone\n  at ["timezone"]`, { kind: 'Query' }); }
    const toolsMode = query.get('tools') ?? 'summary';
    if (!['none', 'summary', 'detail'].includes(toolsMode)) throw invalidRequest('Expected "none" | "summary" | "detail"\n  at ["tools"]', { kind: 'Query' });
    const project = query.get('project') || undefined;

    let sessions = await fileIndex.list();
    if (project) sessions = sessions.filter((session) => projectOf(session.cwd).id === project);

    // Without `from` the range starts at the oldest message.
    let from = requestedFrom;
    if (from === undefined) {
      from = to;
      for (const session of sessions) {
        const { steps, prompts } = session.activity ?? { steps: [], prompts: [] };
        for (const step of steps) from = Math.min(from, step[0]);
        for (const time of prompts) from = Math.min(from, time);
      }
    }
    const inRange = (time) => time >= from && time < to;

    let counted = 0;
    let subagents = 0;
    let prompts = 0;
    let stepCount = 0;
    let tokens = zeroTokens();
    let cost = 0;
    const models = new Map();
    const days = new Map();
    const touched = [];

    for (const session of sessions) {
      const activity = session.activity ?? { steps: [], prompts: [] };
      const ownPrompts = activity.prompts.filter(inRange).length;
      let ownSteps = 0;
      for (const [time, provider, model, thinkingLevel, input, output, reasoning, cacheRead, cacheWrite, stepCost] of activity.steps) {
        if (!inRange(time)) continue;
        ownSteps += 1;
        const stepTokens = tokensFromUsage({ input, output, reasoning, cacheRead, cacheWrite });
        tokens = addTokens(tokens, stepTokens);
        cost += stepCost;
        const variant = variantFromThinkingLevel(thinkingLevel);
        const key = `${provider}\0${model}\0${variant}`;
        const entry = models.get(key) ?? { model: { id: String(model), providerID: String(provider), variant }, steps: 0, tokens: zeroTokens(), cost: 0 };
        entry.steps += 1;
        entry.tokens = addTokens(entry.tokens, stepTokens);
        entry.cost += stepCost;
        models.set(key, entry);
        const day = dayOf(time);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
      if (ownSteps === 0 && ownPrompts === 0) continue;
      counted += 1;
      if (metaStore.get(session.id)?.parentID) subagents += 1;
      prompts += ownPrompts;
      stepCount += ownSteps;
      touched.push(session);
    }

    let tools = { mode: 'none' };
    if (toolsMode !== 'none') {
      const totals = { calls: 0, succeeded: 0, failed: 0, unfinished: 0 };
      const byName = new Map();
      for (const session of touched) {
        for (const [time, name, outcome, duration] of await callsOf(session)) {
          if (!inRange(time)) continue;
          const entry = byName.get(name) ?? { name, calls: 0, succeeded: 0, failed: 0, unfinished: 0, durations: [] };
          entry.calls += 1;
          totals.calls += 1;
          if (outcome === 0) { entry.succeeded += 1; totals.succeeded += 1; if (typeof duration === 'number') entry.durations.push(duration); }
          else if (outcome === 1) { entry.failed += 1; totals.failed += 1; }
          else { entry.unfinished += 1; totals.unfinished += 1; }
          byName.set(name, entry);
        }
      }
      tools = toolsMode === 'summary'
        ? { mode: 'summary', totals }
        : {
          mode: 'detail',
          totals,
          usage: [...byName.values()]
            .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
            .map(({ durations, ...entry }) => ({ ...entry, ...(median(durations) !== undefined ? { durationP50: median(durations) } : {}) })),
        };
    }

    const activeDays = [...days.keys()].sort();
    const total = (usage) => usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write;
    return {
      range: { from, to },
      sessions: counted,
      subagents,
      prompts,
      steps: stepCount,
      tokens,
      cost,
      tools,
      activeDays: activeDays.length,
      streak: longestStreak(activeDays),
      activity: activeDays.map((date) => ({ date, steps: days.get(date) })),
      models: [...models.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
    };
  };

  return { report };
};
