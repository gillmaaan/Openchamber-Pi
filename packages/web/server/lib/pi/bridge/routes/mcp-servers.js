// `GET /api/mcp`: the MCP servers Pi is configured with.
//
// Pi reads `<agentDir>/mcp.json` and, in a trusted project, `<cwd>/.pi/mcp.json`:
// `{ "mcpServers": { "<name>": { command | url, enabled?, ... } } }`. A project
// entry replaces the global one of the same name; an entry with none of
// `command`, `url` and `type` only overrides `enabled`, `exposure` and
// `toolExposure` of the global one (pi-contract 6.2).
//
// Pi connects its servers inside a running session, so without one the bridge
// cannot know a connection state. A server that is switched off is `disabled`;
// every other one is `pending`, which the UI shows as "not connected yet". A
// later phase fills in the real state from the live session's MCP extension.

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFullDefinition = (entry) => 'command' in entry || 'url' in entry || 'type' in entry;

/** @returns {Record<string, object>} The `mcpServers` object of a parsed file, or `{}`. */
export const serversOf = (document) => (isObject(document?.mcpServers) ? document.mcpServers : {});

/**
 * @param {Record<string, object>} globalServers
 * @param {Record<string, object>} projectServers
 * @param {(message: string) => void} [report]  Called for an entry Pi would not accept.
 */
export const mergeMcpServers = (globalServers, projectServers, report = () => {}) => {
  const merged = new Map();
  for (const [name, entry] of Object.entries(globalServers)) {
    if (!isObject(entry)) {
      report(`MCP server "${name}" in the global mcp.json is not an object and is skipped`);
      continue;
    }
    merged.set(name, entry);
  }
  for (const [name, entry] of Object.entries(projectServers)) {
    if (!isObject(entry)) {
      report(`MCP server "${name}" in the project mcp.json is not an object and is skipped`);
      continue;
    }
    if (isFullDefinition(entry)) {
      merged.set(name, entry);
      continue;
    }
    const base = merged.get(name);
    if (!base) {
      report(`MCP server "${name}" in the project mcp.json overrides a global server that does not exist and is skipped`);
      continue;
    }
    const overrides = Object.fromEntries(OVERRIDE_KEYS.filter((key) => key in entry).map((key) => [key, entry[key]]));
    merged.set(name, { ...base, ...overrides });
  }
  return merged;
};

/** @param {Map<string, object>} merged */
export const toMcpServers = (merged) => [...merged]
  .filter(([name]) => SERVER_NAME.test(name))
  .map(([name, entry]) => ({
    name,
    status: entry.enabled === false ? { status: 'disabled' } : { status: 'pending' },
  }));

/** Names Pi rejects, for the caller to report; `toMcpServers` drops them. */
export const invalidServerNames = (merged) => [...merged.keys()].filter((name) => !SERVER_NAME.test(name));
