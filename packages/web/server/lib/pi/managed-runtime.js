// The extension files OpenChamber hands every Pi child, derived from Settings.
//
// OpenCode read a config file it watched; Pi loads extensions when a process
// starts. So the files are written here, in this server's own instance folder
// (never read from inside an app archive), and the child factory asks
// `extensionPaths()` each time it starts a process. A Settings change rewrites
// the files and `generation` moves, which tells the host its idle processes are
// stale: they stop, and the next prompt starts one with the new tools.

import { createPiManagedToolsExtensionSource } from '../agent-tool/pi-extension.js';

const MANAGED_TOOLS_FILE = 'openchamber-managed-tools.mjs';
const GATE_FILE = 'openchamber-gate.mjs';

/** The managed tools Settings switches on, with the defaults the OpenCode runtime used. */
export const managedToolFlags = (settings) => ({
  includeControl: settings?.agentControlToolEnabled !== false,
  includeSchedule: settings?.agentScheduleToolEnabled !== false,
  includeWeb: settings?.agentWebToolEnabled !== false,
  includeMemory: settings?.agentMemoryToolEnabled === true,
  includeKnowledge: settings?.agentKnowledgeToolEnabled !== false,
  includeNotify: settings?.agentNotifyToolEnabled === true,
  includeRender: settings?.agentRenderToolEnabled !== false,
  includeImage: settings?.agentImageToolEnabled === true,
  includeSecret: settings?.agentSecretToolEnabled !== false,
  includeUsage: settings?.agentUsageToolEnabled === true,
  includeWorkflow: settings?.agentWorkflowToolEnabled === true,
});

/**
 * @param {object} options
 * @param {typeof import('node:fs/promises')} options.fsPromises
 * @param {typeof import('node:path')} options.path
 * @param {string} options.instanceDir  This server's folder (`<data-dir>/run/instances/<pid>`).
 * @param {() => Promise<object|null>} options.readSettings
 * @param {string} options.gateSourcePath  The gate extension's source file, copied next to the managed tools.
 */
export const createManagedPiRuntime = ({ fsPromises, path, instanceDir, readSettings, gateSourcePath }) => {
  const root = path.join(instanceDir, 'pi');
  let paths = [];
  let generation = 0;
  let writing = Promise.resolve();

  const write = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const flags = managedToolFlags(settings);
    await fsPromises.mkdir(root, { recursive: true });

    const next = [];
    const gatePath = path.join(root, GATE_FILE);
    await fsPromises.writeFile(gatePath, await fsPromises.readFile(gateSourcePath, 'utf8'), { mode: 0o600 });
    next.push(gatePath);

    const managedToolsPath = path.join(root, MANAGED_TOOLS_FILE);
    if (Object.values(flags).some(Boolean)) {
      await fsPromises.writeFile(managedToolsPath, createPiManagedToolsExtensionSource(flags), { mode: 0o600 });
      next.push(managedToolsPath);
    } else {
      await fsPromises.rm(managedToolsPath, { force: true });
    }
    paths = next;
    generation += 1;
  };

  /** Write the files for the current Settings. Writes run one after another, newest Settings last. */
  const refresh = () => {
    writing = writing.then(write, write);
    return writing;
  };

  return {
    refresh,
    /** Where the gate copy lives: always loaded, so a child never starts without it. */
    gatePath: path.join(root, GATE_FILE),
    /** `-e` files for a child that starts now. */
    extensionPaths: () => [...paths],
    /** Moves on every refresh; a process started under an older one is stale. */
    get generation() { return generation; },
  };
};
