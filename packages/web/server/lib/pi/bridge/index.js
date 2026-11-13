// The Pi bridge: an in-process HTTP server on loopback that speaks the OpenCode
// 2.2.6 dialect and is backed by `pi --mode rpc` children.
//
// This file only composes. What each part owns is in its own header; the
// decisions behind the split are in `../DOCUMENTATION.md`.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPiCatalog } from '../catalog.js';
import { agentLaunchOptions, createAgentStore } from '../config-routes/agents.js';
import { createCommandStore, ensureBuiltinCommands } from '../config-routes/commands.js';
import { createMcpStore } from '../config-routes/mcp.js';
import { createSkillResolver, createSkillStore } from '../config-routes/skills.js';
import { createCommandResolver } from './commands.js';
import { createMcpOAuth, createPiLoginRunner } from './mcp-oauth.js';
import { invalidRequest } from './errors.js';
import { createProviderBridgeRoutes, createProviderService, createProviderState } from '../providers/index.js';
import { createPiGeneration } from '../generation.js';
import { createPiPackages } from '../packages.js';
import { createLiveSessionHost, createPiClientFactory } from '../live-session-host.js';
import { createSessionFileIndex, readSessionEntries, sessionDirFor } from '../session-files.js';
import { createSessionMetaStore } from '../session-meta-store.js';
import { tokensFromUsage } from '../wire/mapping.js';
import { createChatRuntime } from './chat-runtime.js';
import { createSubagents } from './subagents.js';
import { createInstructions } from './instructions.js';
import { createFormManager } from './forms.js';
import { createEventHub } from './hub.js';
import { createBridgeHttpServer } from './http.js';
import { createJobRegistry } from './jobs.js';
import { createPermissionManager, createSavedPermissionStore } from './permissions.js';
import { createTitles } from './titles.js';
import { createPrompting } from './prompting.js';
import { createSessionRecords } from './session-records.js';
import { createSessionService } from './session-service.js';
import { createBuiltinAgents } from './routes/builtin-agents.js';
import { createCatalogRoutes } from './routes/catalog.js';
import { createChatRoutes } from './routes/chat.js';
import { createWorkspace } from './routes/workspace.js';
import { createPluginBridgeRoutes } from './routes/plugins.js';
import { createFormRoutes } from './routes/forms.js';
import { createGenerateRoutes } from './routes/generate.js';
import { createContextCompositions } from './context-composition.js';
import { createContextCompositionRoutes } from './routes/context-composition.js';
import { createInstructionRoutes } from './routes/instructions.js';
import { createPermissionRoutes } from './routes/permissions.js';
import { createChildTokens, createPiCallbackRoutes } from './routes/pi-callback.js';
import { createSessionRoutes } from './routes/sessions.js';

const PLAN_PROMPT = (planDirectory) => [
  'You are in plan mode. Do not change files or run commands that change anything.',
  `Explore the project, then write your plan as a markdown file in ${planDirectory} and present it for approval.`,
].join(' ');

/** Pi usage sums to the wire's tokens and cost. */
const toWireUsage = (usage) => ({
  tokens: tokensFromUsage({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoning: usage.reasoning }),
  cost: usage.cost,
});

/**
 * @param {object} options
 * @param {string} options.password  The Basic-auth password every `/api` request must carry.
 * @param {string} options.dataDir  OpenChamber's data directory; the bridge keeps its own files under `<dataDir>/pi`.
 * @param {string} options.agentDir  Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 * @param {() => Record<string,string|undefined>} options.getBaseEnv  What a Pi child inherits.
 * @param {() => string} options.getDefaultDirectory
 * @param {(directory: string) => Promise<boolean>} [options.isTrusted]  Whether a folder's `.pi/*` may load.
 * @param {ReturnType<typeof createAgentStore>} [options.agentStore]  Profiles shared with the configuration routes.
 * @param {{ extensionPaths: () => string[], gatePath?: string }} [options.managed]  The extension files for every child.
 * @param {(request: { prompt: string, directory: string, model?: object }) => Promise<string>} [options.generateTitleText]  Writes a session title; default: the session's own model through Pi.
 * @param {(directory: string) => Promise<Map<string, object>>} [options.getMcpStatus]  Live MCP connection state for `/api/mcp`; without it every enabled server is `pending`.
 * @param {ReturnType<typeof createPiPackages>} [options.packages]  Pi package management; default: one that trusts the same folders as `isTrusted`.
 * @param {() => Promise<object|null>} [options.readSettings]  OpenChamber's settings, for the managed tool switches.
 * @param {() => void} [options.onPluginsChanged]
 * @param {string} [options.hostname]
 * @param {number} [options.port]
 * @param {(message: string) => void} [options.log]
 */
export const createPiBridge = async ({
  password,
  dataDir,
  agentDir,
  getBaseEnv,
  getDefaultDirectory,
  isTrusted = async () => false,
  agentStore = createAgentStore({ getAgentDir: () => agentDir, isProjectTrusted: isTrusted }),
  managed = { extensionPaths: () => [] },
  generateTitleText,
  getMcpStatus,
  packages = createPiPackages({ getAgentDir: () => agentDir, isTrusted: (directory) => isTrusted(directory) }),
  readSettings = async () => null,
  onPluginsChanged = () => {},
  hostname = '127.0.0.1',
  port = 0,
  log = (message) => console.warn(`[pi-bridge] ${message}`),
}) => {
  const piDataDir = path.join(dataDir, 'pi');
  const fileIndex = createSessionFileIndex({ sessionsDir: path.join(agentDir, 'sessions') });
  const metaStore = createSessionMetaStore({ filePath: path.join(piDataDir, 'session-meta.json') });
  const hub = createEventHub();
  const tokens = createChildTokens();
  const providerState = createProviderState({ stateDir: piDataDir });
  const catalog = createPiCatalog({ getAgentDir: () => agentDir, getHiddenProviders: providerState.disabledProviders });
  const planDirectory = path.join(agentDir, 'plans');
  const builtinAgents = createBuiltinAgents({ planDirectory });
  const resolveAgent = async (id, directory) => {
    const stored = await agentStore.get(id, directory);
    if (stored?.profile.disabled) throw invalidRequest(`Agent is disabled: ${id}`, { kind: 'Payload', field: 'agent' });
    if (stored) return { profile: stored.profile, launch: agentLaunchOptions(stored.profile) };
    const builtin = builtinAgents.find((agent) => agent.id === id);
    if (!builtin) throw invalidRequest(`Unknown agent: ${id}`, { kind: 'Payload', field: 'agent' });
    return { profile: builtin, launch: { extraArgs: id === 'plan' ? ['--append-system-prompt', PLAN_PROMPT(planDirectory)] : (builtin.system ? ['--append-system-prompt', builtin.system] : []) } };
  };

  let baseUrl = null;
  // The gate always loads, once: the managed runtime's copy when there is one.
  const gatePath = managed.gatePath ?? fileURLToPath(new URL('../extension/gui-gate.js', import.meta.url));

  /** What a new Pi child for this session starts with. */
  const buildLaunch = async (record) => {
    const { profile, launch } = await resolveAgent(record.agent ?? 'build', record.location.directory);
    const approveProject = await isTrusted(record.location.directory).catch(() => false);
    let defaultTools;
    if (!Array.isArray(profile.tools)) {
      // Reset built-ins restored from another agent without filtering extension tools.
      const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
      const settings = SettingsManager.create(record.location.directory, agentDir, { projectTrusted: approveProject });
      defaultTools = settings.getDefaultTools() ?? ['read', 'bash', 'edit', 'write'];
    }
    return {
      ...launch,
      agentRules: profile.permissions ?? [],
      env: {
        OPENCHAMBER_PI_BRIDGE_URL: baseUrl,
        OPENCHAMBER_PI_BRIDGE_TOKEN: tokens.issue(record.id),
        // Children write where the bridge reads.
        PI_CODING_AGENT_DIR: agentDir,
        OPENCHAMBER_PI_DEFAULT_TOOLS: defaultTools ? JSON.stringify(defaultTools) : undefined,
      },
      extensions: [gatePath, ...managed.extensionPaths().filter((file) => file !== gatePath)],
      approveProject,
      // Pins where the child writes: a project's own `sessionDir` must not move a session.
      sessionDir: sessionDirFor(path.join(agentDir, 'sessions'), record.location.directory),
    };
  };

  const host = createLiveSessionHost({ createClient: createPiClientFactory({ getBaseEnv }) });
  const records = createSessionRecords({ fileIndex, metaStore, toWireUsage });
  // Subagent children, from the tool and from subagent commands; the job list
  // reads it, and each child's terminal event ends its entry.
  const jobs = createJobRegistry();

  // The folders sessions ran in, for `/api/project`, kept as a snapshot because that route is synchronous.
  let knownDirectories = [];
  const refreshKnownDirectories = async () => {
    const sessions = await records.list(new URLSearchParams({ limit: '1000' }));
    const byDirectory = new Map();
    for (const session of sessions.data) {
      const known = byDirectory.get(session.location.directory);
      byDirectory.set(session.location.directory, {
        directory: session.location.directory,
        time: { created: Math.min(known?.time.created ?? Infinity, session.time.created), updated: Math.max(known?.time.updated ?? 0, session.time.updated), active: Math.max(known?.time.active ?? 0, session.time.updated) },
      });
    }
    knownDirectories = [...byDirectory.values()];
  };

  let chat;
  let prompting;
  let instructionsStore;
  const service = createSessionService({
    records,
    metaStore,
    fileIndex,
    host,
    hub,
    getDefaultDirectory,
    validateAgent: resolveAgent,
    onRemoved: (id) => {
      prompting?.forget(id);
      chat?.forget(id);
      instructionsStore?.forget(id);
      void refreshKnownDirectories().catch(() => {});
    },
  });

  const getContext = (sessionID) => {
    // Permission and form calls come from a running child, so the folder is the child's.
    const live = host.get(sessionID);
    if (!live) return null;
    const meta = metaStore.get(sessionID) ?? {};
    return { directory: live.cwd, agentRules: live.agentRules ?? [], sessionRules: meta.permissions ?? [] };
  };
  const resolveSource = (sessionID, toolCallId) => chat?.sourceOfCall(sessionID, toolCallId);
  const permissionStore = createSavedPermissionStore({ filePath: path.join(piDataDir, 'saved-permissions.json') });
  const permissions = createPermissionManager({ hub, getContext, resolveSource, store: permissionStore });
  const forms = createFormManager({ hub, getContext, resolveSource });

  const instructions = createInstructions({ metaStore, emit: (type, data, directory) => service.emit(type, data, directory) });
  instructionsStore = instructions;

  chat = createChatRuntime({
    host,
    service,
    fileIndex,
    metaStore,
    permissions,
    forms,
    tokens,
    readEntries: readSessionEntries,
    log,
    hooks: { onWireEvent: (sessionID, wire) => jobs.onWireEvent(sessionID, wire) },
  });
  const generation = createPiGeneration({ getAgentDir: () => agentDir });
  const titles = createTitles({
    generateText: generateTitleText ?? (async ({ prompt, model }) => (await generation.generateText({ prompt, model })).text),
    metaStore,
    rename: (id, body) => service.update(id, body),
    log,
  });
  ensureBuiltinCommands({ getAgentDir: () => agentDir, log });
  const commandStore = createCommandStore({ getAgentDir: () => agentDir, isProjectTrusted: isTrusted });
  // A remote MCP server with OAuth is an integration whose sign-in is one
  // `pi mcp login`, run against the same agent directory the children use.
  const mcpStore = createMcpStore({ getAgentDir: () => agentDir, isProjectTrusted: isTrusted });
  const mcpOAuth = createMcpOAuth({
    listServers: (directory) => mcpStore.list(directory),
    runLogin: createPiLoginRunner({ baseEnv: () => ({ ...getBaseEnv(), PI_CODING_AGENT_DIR: agentDir }) }),
  });
  // A `$skill` mention attaches the skill's text to the prompt as the wire
  // wraps it (`<skill_content name="…">`), from the same scan `/api/skill`
  // and the Skills page serve.
  const skillStore = createSkillStore({ getAgentDir: () => agentDir, isProjectTrusted: isTrusted });
  const resolveSkill = createSkillResolver(skillStore);
  const contexts = createContextCompositions({ host });
  prompting = createPrompting({
    host,
    contexts,
    service,
    chat,
    metaStore,
    fileIndex,
    getLaunch: buildLaunch,
    titles,
    resolveCommand: createCommandResolver(commandStore),
    resolveSkill,
    agentProfile: async (id, directory) => (await resolveAgent(id, directory)).profile,
    findModel: (providerID, id) => catalog.model(providerID, id),
    jobs,
    log,
  });
  const stopChat = chat.start();

  const subagents = createSubagents({
    service,
    prompting,
    chat,
    jobs,
    listSubagents: async (directory) => {
      const agents = new Map(builtinAgents.map((agent) => [agent.id, agent]));
      for (const agent of await agentStore.list(directory)) agents.set(agent.id, agent);
      return [...agents.values()].filter((agent) => agent.mode !== 'primary' && !agent.hidden && !agent.disabled).map((agent) => agent.id);
    },
  });
  const providers = createProviderService({ catalog, state: providerState, hub, getAgentDir: () => agentDir, getDefaultDirectory, log });
  const requireSession = (id) => service.requireRecord(id);
  const workspace = createWorkspace({
    getDefaultDirectory,
    requireSession,
    host,
    getLaunch: buildLaunch,
    fileIndex,
    tmpDir: os.tmpdir(),
    bindClientId: (sessionID, timestamp, messageID) => chat.bindClientId(sessionID, timestamp, messageID),
    listJobs: () => jobs.list(),
    // The UI derives a shell message's id from its event id, so the id travels with the event.
    emit: (type, data, directory, options) => hub.emit({ ...(options?.id ? { id: options.id } : {}), type, data, ...(directory ? { location: { directory } } : {}) }),
    reload: async () => { catalog.reload(); },
    log,
  });
  const routes = [
    ...createSessionRoutes({ service, hub }),
    ...createChatRoutes({ chat, prompting, service }),
    ...createInstructionRoutes({ instructions, tokens, requireSession }),
    ...createContextCompositionRoutes({ prompting, contexts, tokens }),
    ...createGenerateRoutes({ generation }),
    // Before the catalog: its `/api/integration`, `/api/plugin` and `/api/shell` are placeholders these replace.
    ...workspace.routes,
    ...createProviderBridgeRoutes({ providers, getDefaultDirectory, mcpOAuth }),
    ...createPluginBridgeRoutes({ packages, getDefaultDirectory, readSettings, onChanged: onPluginsChanged }),
    ...createCatalogRoutes({
      catalog,
      agentStore,
      getDefaultDirectory,
      getAgentDir: () => agentDir,
      listKnownDirectories: () => knownDirectories,
      getServerInfo: () => ({ pid: process.pid, hostname: os.hostname(), urls: [baseUrl], tmp: os.tmpdir() }),
      isProjectTrusted: isTrusted,
      getPlanDirectory: () => planDirectory,
      getMcpStatus,
    }),
    ...createPiCallbackRoutes({ tokens, permissions, forms, subagents }),
    ...createPermissionRoutes({ permissions, store: permissionStore, getDefaultDirectory, requireSession }),
    ...createFormRoutes({ forms, getDefaultDirectory, requireSession }),
  ];

  const transport = createBridgeHttpServer({
    password,
    routes,
    onError: (error, ref) => log(`request failed (${ref}): ${error?.stack ?? error}`),
  });
  const address = await transport.listen({ hostname, port });
  baseUrl = `http://${hostname}:${address.port}`;
  await refreshKnownDirectories().catch((error) => log(`could not list sessions: ${error?.message ?? error}`));

  return {
    url: baseUrl,
    port: address.port,
    hostname,
    host,
    hub,
    service,
    chat,
    prompting,
    metaStore,
    fileIndex,
    catalog,
    providers,
    refreshKnownDirectories,
    /** Settings that shape a child changed: idle ones stop, the next prompt starts one that has them. */
    invalidateIdle: () => host.closeIdle(),
    /** Pi's files (settings, models, auth, extensions) changed: rebuild the catalog and replace idle processes. */
    refreshConfig: async () => {
      catalog.reload();
      await host.closeIdle();
    },
    close: async () => {
      stopChat();
      mcpOAuth.close();
      providers.close?.();
      workspace.close?.();
      await host.shutdown();
      hub.close();
      await transport.close();
    },
  };
};
