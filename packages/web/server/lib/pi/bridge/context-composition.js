// What fills a session's context besides the conversation: the system prompt,
// the project's instruction files, skills and the tool definitions, each with
// a token estimate and the text behind it.
//
// Only the Pi child knows what it sends the model, so the child reports it
// (`openchamber-context` command in `extension/gui-gate.js`, answered through
// `POST /_pi/context`) and this module turns the report into categories. The
// numbers are estimates at four characters a token, like the conversation
// estimate beside them in the UI.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { serviceUnavailable, unknownError } from './errors.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_TIMEOUT_MS = 10_000;

const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The system prompt as Pi renders it: XML-wrapped sections on their own lines,
 * with plain text before, between and after them. A line that opens a tag
 * only starts a section when its closing line exists.
 *
 * @returns {Array<{ tag: string | null, text: string }>}
 */
const splitPrompt = (prompt) => {
  const parts = [];
  let current = { tag: null, lines: [] };
  let openTag = null;
  const flush = () => {
    const text = current.lines.join('\n');
    if (text.trim() !== '') parts.push({ tag: current.tag, text });
    current = { tag: null, lines: [] };
  };
  for (const line of prompt.split('\n')) {
    if (openTag === null) {
      const opening = /^<([A-Za-z][\w:-]*)>\s*$/.exec(line);
      if (opening && prompt.includes(`</${opening[1]}>`)) {
        flush();
        openTag = opening[1];
        current = { tag: openTag, lines: [line] };
        continue;
      }
      current.lines.push(line);
      continue;
    }
    current.lines.push(line);
    if (line.trim() === `</${openTag}>`) {
      flush();
      openTag = null;
    }
  }
  flush();
  return parts;
};

/** Pi's own sections by tag; any other tag is a section somebody added. */
const SYSTEM_SECTION_IDS = { tools: 'toolList', rules: 'rules', docs: 'docs', cwd: 'workingDirectory' };

const sourceLabelOf = (tool) => {
  if (tool.name.startsWith('mcp__')) return `MCP: ${tool.name.split('__')[1] || tool.name}`;
  const source = isRecord(tool.source) ? tool.source : null;
  if (source?.path && !String(source.path).startsWith('builtin:')) return path.basename(String(source.path));
  return typeof source?.source === 'string' ? source.source : '';
};

const isBuiltinTool = (tool) => isRecord(tool.source) && tool.source.source === 'builtin';

const toolText = (tool) => {
  const schema = tool.parameters === undefined ? '' : JSON.stringify(tool.parameters, null, 2);
  return [tool.description ?? '', schema].filter((part) => part !== '').join('\n\n');
};

/** The tokens the provider receives for one tool: name, description and parameter schema. */
const toolTokens = (tool) => estimateTokens(JSON.stringify({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} }));

const byTokens = (a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label);

const category = (id, items) => ({ id, tokens: items.reduce((sum, item) => sum + item.tokens, 0), items: items.sort(byTokens) });

/**
 * @param {{ systemPrompt?: unknown, tools?: unknown }} snapshot  What the child reported.
 * @returns {{ totalTokens: number, categories: Array<{ id: string, tokens: number, items: Array<{ id: string, label: string, tokens: number, detail?: string, text: string }> }> }}
 */
export const composeContext = (snapshot) => {
  if (!isRecord(snapshot) || typeof snapshot.systemPrompt !== 'string' || !Array.isArray(snapshot.tools)) {
    throw unknownError('The agent reported its context in a shape OpenChamber does not know');
  }
  const system = [];
  const instructions = [];
  const skills = [];
  let remainder = '';

  const addSystem = (id, label, text) => {
    const existing = system.find((item) => item.id === id);
    if (existing) {
      existing.text = `${existing.text}\n\n${text}`;
      existing.tokens = estimateTokens(existing.text);
    } else {
      system.push({ id, label, tokens: estimateTokens(text), text });
    }
  };

  splitPrompt(snapshot.systemPrompt).forEach((part, index) => {
    if (part.tag === null) {
      addSystem(index === 0 ? 'preamble' : 'other', '', part.text.trim());
      return;
    }
    if (part.tag === 'project_context') {
      let frame = part.text;
      for (const match of part.text.matchAll(/<project_instructions path="([^"]*)">([\s\S]*?)<\/project_instructions>/g)) {
        frame = frame.replace(match[0], '');
        instructions.push({ id: `file:${match[1]}`, label: match[1], tokens: estimateTokens(match[0]), text: match[2].trim() });
      }
      remainder += `\n${frame}`;
      return;
    }
    if (part.tag === 'skills') {
      let frame = part.text;
      for (const match of part.text.matchAll(/<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<\/skill>/g)) {
        frame = frame.replace(match[0], '');
        skills.push({ id: `skill:${match[1].trim()}`, label: match[1].trim(), tokens: estimateTokens(match[0]), text: match[0].trim() });
      }
      remainder += `\n${frame}`;
      return;
    }
    const known = SYSTEM_SECTION_IDS[part.tag];
    if (known) addSystem(known, '', part.text);
    else addSystem(`section:${part.tag}`, part.tag, part.text);
  });
  if (remainder.replace(/<\/?[\w:-]+>/g, '').trim() !== '') addSystem('other', '', remainder.trim());

  const builtin = [];
  const custom = [];
  for (const tool of snapshot.tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') continue;
    const item = { id: `tool:${tool.name}`, label: tool.name, tokens: toolTokens(tool), text: toolText(tool) };
    if (isBuiltinTool(tool)) builtin.push(item);
    else custom.push({ ...item, detail: sourceLabelOf(tool) });
  }

  const categories = [
    category('system', system),
    category('instructions', instructions),
    category('skills', skills),
    category('builtinTools', builtin),
    category('customTools', custom),
  ];
  return { totalTokens: categories.reduce((sum, entry) => sum + entry.tokens, 0), categories };
};

/**
 * Asks a session's child what it sends the model and waits for the answer,
 * which arrives on a separate request (`deliver`).
 *
 * @param {object} deps
 * @param {{ request: Function, abort: Function }} deps.host
 */
export const createContextCompositions = ({ host, timeoutMs = DEFAULT_TIMEOUT_MS, newId = () => randomBytes(9).toString('base64url') }) => {
  /** requestId -> { sessionID, resolve, timer } */
  const pending = new Map();

  const settle = (requestId) => {
    const entry = pending.get(requestId);
    if (entry) clearTimeout(entry.timer);
    pending.delete(requestId);
    return entry ?? null;
  };

  /** `session` is the live session object the host takes (`prompting.prepare`). */
  const read = async (session) => {
    const requestId = newId();
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(serviceUnavailable('The agent did not report its context in time', 'pi'));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { sessionID: session.id, resolve, timer });
    });
    // A late answer to a request that already failed must not become an unhandled rejection.
    answer.catch(() => {});
    try {
      // An extension command runs at once, also while a turn streams, and starts no turn of its own.
      const reply = await host.request(session, 'prompt', { message: `/openchamber-context ${requestId}` }, { timeoutMs });
      if (reply?.disposition !== 'handled') {
        // Anything else means the text reached the model as a prompt.
        await host.abort(session.id).catch(() => {});
        throw serviceUnavailable('The agent did not know the context command', 'pi');
      }
    } catch (error) {
      settle(requestId);
      throw error;
    }
    return composeContext(await answer);
  };

  /** The child's answer. False when no request waits for it (it timed out, or the id is not ours). */
  const deliver = (sessionID, requestId, snapshot) => {
    const entry = pending.get(requestId);
    if (!entry || entry.sessionID !== sessionID) return false;
    settle(requestId);
    entry.resolve(snapshot);
    return true;
  };

  return { read, deliver };
};
