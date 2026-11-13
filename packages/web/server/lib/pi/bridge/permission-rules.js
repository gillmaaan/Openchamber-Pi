// Permission rules for the Pi bridge: what a tool call is called in OpenCode's
// vocabulary, and what a ruleset says about it.
//
// A rule is `{ action, resource, effect: 'allow' | 'deny' | 'ask' }`. `*` in the
// action or the resource matches any characters, `/` and newlines included.
// A pattern that ends in ` *` also matches the bare prefix, so the saved rule
// `ls *` covers a plain `ls`. The last matching rule wins; no match asks.

import os from 'node:os';
import path from 'node:path';

const WILDCARD = '[\\s\\S]*';
const TRAILING_ARGUMENTS = ` ${WILDCARD}`;
const MAX_COMPILED_PATTERNS = 500;
const MAX_METADATA_STRING = 2_000;

const compiled = new Map();

const compilePattern = (pattern) => {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', WILDCARD);
  if (source.endsWith(TRAILING_ARGUMENTS)) source = `${source.slice(0, -TRAILING_ARGUMENTS.length)}( ${WILDCARD})?`;
  const regex = new RegExp(`^${source}$`);
  if (compiled.size >= MAX_COMPILED_PATTERNS) compiled.clear();
  compiled.set(pattern, regex);
  return regex;
};

export const matchesPattern = (pattern, value) => typeof pattern === 'string' && compilePattern(pattern).test(value);

const isRule = (rule) => rule !== null && typeof rule === 'object'
  && typeof rule.action === 'string' && typeof rule.resource === 'string' && typeof rule.effect === 'string';

const ruleMatches = (rule, action, resource) => matchesPattern(rule.action, action) && matchesPattern(rule.resource, resource);

/**
 * The last rule of the concatenated rulesets that matches, or null.
 * Entries that are not rules are skipped: a session can carry whatever a
 * client patched into it.
 */
export const lastMatchingRule = (action, resource, ...rulesets) => {
  const rules = rulesets.flatMap((ruleset) => (Array.isArray(ruleset) ? ruleset.filter(isRule) : []));
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (ruleMatches(rules[index], action, resource)) return rules[index];
  }
  return null;
};

const SEVERITY = { allow: 0, ask: 1, deny: 2 };
const strictest = (a, b) => (SEVERITY[b.effect] > SEVERITY[a.effect] ? b : a);

/**
 * What the rules say about a request. Saved `always` rules only turn an `ask`
 * into `allow`: a deny is never overridden, and a rule the user saved cannot
 * outrank one they wrote later.
 *
 * `checks` entries are `{ value, strict }`, one per resource the rules look
 * at. A strict check (a command line the rules cannot take apart) is allowed
 * only by a rule whose resource is `*`, never by a narrower rule or a saved one.
 *
 * @param {object} options
 * @param {string} options.action
 * @param {Array<{ value: string, strict?: boolean }>} options.checks
 * @param {Array} [options.agentRules]
 * @param {Array} [options.sessionRules]
 * @param {Array<{ action: string, resource: string }>} [options.saved]
 * @returns {{ effect: 'allow' | 'deny' | 'ask', resource: string | null }}
 */
export const decide = ({ action, checks, agentRules = [], sessionRules = [], saved = [] }) => {
  const savedAllows = saved.map(({ action: savedAction, resource }) => ({ action: savedAction, resource, effect: 'allow' }));
  let result = { effect: 'allow', resource: null };
  for (const { value, strict = false } of checks) {
    const rule = lastMatchingRule(action, value, agentRules, sessionRules);
    let effect = rule?.effect ?? 'ask';
    if (effect !== 'allow' && effect !== 'deny' && effect !== 'ask') effect = 'ask';
    if (effect === 'allow' && strict && rule.resource !== '*') effect = 'ask';
    if (effect === 'ask' && !strict && lastMatchingRule(action, value, savedAllows)) effect = 'allow';
    result = strictest(result, { effect, resource: value });
    if (effect === 'deny') break;
  }
  return result;
};

// A program that runs other commands: a pattern on its name would allow anything.
const WRAPPER_PROGRAMS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'env', 'sudo', 'doas', 'su', 'xargs', 'exec', 'eval',
  'nohup', 'time', 'timeout', 'nice', 'command', 'builtin', 'ssh', 'watch', 'script',
]);
const PROGRAM_NAME = /^[\w./~@+-]+$/;

/**
 * A command line as the rules see it: its simple commands, split on unquoted
 * `;`, `&&`, `||`, `|`, `&` and newlines. `opaque` is set when part of the
 * line is only known at run time (`$(...)`, backticks, process substitution)
 * or a quote never closes.
 */
export const splitShellCommand = (command) => {
  const segments = [];
  let current = '';
  let quote = null;
  let opaque = false;
  const endSegment = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      current += char + (next ?? '');
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && next === '(')) opaque = true;
    if (quote === '"') {
      current += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if ((char === '<' || char === '>') && next === '(') opaque = true;
    if (char === '&' && (command[index - 1] === '>' || command[index - 1] === '<' || next === '>')) {
      current += char;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if ((char === '|' || char === '&') && next === char) index += 1;
      endSegment();
      continue;
    }
    current += char;
  }
  endSegment();
  return { segments, opaque: opaque || quote !== null };
};

/** `<program> *` for a simple command, or null when a pattern on its program would allow too much. */
const savePatternOf = (segment) => {
  const program = segment.split(/\s+/, 1)[0];
  if (!PROGRAM_NAME.test(program) || WRAPPER_PROGRAMS.has(program)) return null;
  return `${program} *`;
};

const describeShell = (command) => {
  const { segments, opaque } = splitShellCommand(command);
  const checks = opaque || segments.length === 0
    ? [{ value: command, strict: true }]
    : segments.map((value) => ({ value, strict: false }));
  const patterns = opaque ? [] : segments.map(savePatternOf);
  const save = patterns.length > 0 && patterns.every(Boolean) ? [...new Set(patterns)] : undefined;
  return { action: 'shell', resources: [command], checks, save };
};

/** Pi's path argument as the absolute path a rule is written against. */
const resolveToolPath = (directory, value) => {
  let given = typeof value === 'string' && value !== '' ? value : '.';
  if (given.startsWith('@')) given = given.slice(1);
  if (given === '~' || given.startsWith('~/')) given = path.join(os.homedir(), given.slice(1));
  return path.resolve(directory, given).split(path.sep).join('/');
};

const PATH_TOOLS = { read: 'read', ls: 'read', grep: 'grep', find: 'glob', edit: 'edit', write: 'edit' };
const SHELL_TOOLS = ['bash', 'powershell'];
const BUILTIN_TOOLS = [...SHELL_TOOLS, ...Object.keys(PATH_TOOLS)];
const BUILTIN_ACTIONS = new Set(['shell', ...Object.values(PATH_TOOLS)]);

const truncateStrings = (value) => {
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING ? `${value.slice(0, MAX_METADATA_STRING)}... (${value.length - MAX_METADATA_STRING} more characters)` : value;
  }
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateStrings(entry)]));
  return value;
};

/**
 * A Pi tool call in OpenCode's terms.
 *
 * - `bash` and `powershell` are `shell`; the request lists the whole command
 *   line and offers `<program> *` per simple command to save.
 * - `read`, `ls`, `grep`, `find`, `edit` and `write` are `read`, `read`,
 *   `grep`, `glob`, `edit`, `edit` on the absolute path they touch, which is
 *   also what is saved.
 * - Any other tool (MCP, extension, `question`, `codemode`) is its own action
 *   on `*`, and its arguments travel as metadata so the user can see them.
 *
 * @returns {{ action: string, resources: string[], checks: Array<{ value: string, strict?: boolean }>, save?: string[], metadata?: object }}
 *   `resources` is what the user sees; `checks` is what the rules are asked.
 */
export const describeToolCall = ({ tool, input, directory }) => {
  const args = input !== null && typeof input === 'object' ? input : {};
  if (tool === 'bash' || tool === 'powershell') return describeShell(typeof args.command === 'string' ? args.command : '');
  if (Object.hasOwn(PATH_TOOLS, tool)) {
    const resource = resolveToolPath(directory, args.path);
    return { action: PATH_TOOLS[tool], resources: [resource], checks: [{ value: resource }], save: [resource] };
  }
  return {
    action: tool,
    resources: ['*'],
    checks: [{ value: '*' }],
    save: ['*'],
    ...(Object.keys(args).length > 0 ? { metadata: truncateStrings(args) } : {}),
  };
};

/** Every call of `action` is denied: its last whole-tool rule denies and no later rule lets a narrower call through. */
const deniesEveryCall = (rules, action) => {
  let last = -1;
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (ruleMatches(rules[index], action, '*')) {
      last = index;
      break;
    }
  }
  if (last < 0 || rules[last].effect !== 'deny') return false;
  return rules.slice(last + 1).every((rule) => rule.effect === 'deny' || !matchesPattern(rule.action, action));
};

/**
 * The tools a ruleset denies outright, by Pi's names: the ones the gate would
 * refuse on every call, so the model need not be offered them. A tool that any
 * narrower rule still allows (`shell ls * allow` after `shell * deny`) stays.
 * Built-in tools follow the action the gate gives them (`shell` covers `bash`
 * and `powershell`, `read` covers `read` and `ls`, `edit` covers `edit` and
 * `write`); any other action is its own tool name or pattern (`mcp__srv__*`).
 * Only what the gate itself would deny counts, so a v1 rule on `bash` or
 * `write`, which the gate never asks about, hides nothing.
 *
 * @param {Array} rules
 * @returns {string[]}
 */
export const deniedToolNames = (rules) => {
  const list = Array.isArray(rules) ? rules.filter(isRule) : [];
  const names = new Set();
  for (const tool of BUILTIN_TOOLS) {
    const action = SHELL_TOOLS.includes(tool) ? 'shell' : PATH_TOOLS[tool];
    if (deniesEveryCall(list, action)) names.add(tool);
  }
  for (const { action } of list) {
    if (action === '*' || BUILTIN_ACTIONS.has(action) || BUILTIN_TOOLS.includes(action)) continue;
    if (deniesEveryCall(list, action)) names.add(action);
  }
  return [...names];
};
