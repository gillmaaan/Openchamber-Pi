import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedPiRuntime, managedToolFlags } from './managed-runtime.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = (settings) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-managed-'));
  roots.push(root);
  const gateSourcePath = path.join(root, 'gate-source.js');
  fs.writeFileSync(gateSourcePath, 'export default function () { /* gate */ }\n');
  let current = settings;
  const runtime = createManagedPiRuntime({
    fsPromises: fs.promises,
    path,
    instanceDir: path.join(root, 'instance'),
    readSettings: async () => current,
    gateSourcePath,
  });
  return { root, runtime, setSettings: (value) => { current = value; } };
};

describe('managedToolFlags', () => {
  it('uses the defaults OpenCode used: control, schedule, web, knowledge, render and secret on', () => {
    expect(managedToolFlags({})).toEqual({
      includeControl: true, includeSchedule: true, includeWeb: true, includeMemory: false, includeKnowledge: true,
      includeNotify: false, includeRender: true, includeImage: false, includeSecret: true, includeUsage: false, includeWorkflow: false,
    });
  });

  it('switches a default-on tool off only for an explicit false, and an opt-in tool on only for an explicit true', () => {
    const flags = managedToolFlags({ agentControlToolEnabled: false, agentMemoryToolEnabled: true, agentNotifyToolEnabled: 'yes' });
    expect(flags).toMatchObject({ includeControl: false, includeMemory: true, includeNotify: false });
  });
});

describe('managed pi runtime', () => {
  it('writes the gate and the managed tools into the instance folder and lists them', async () => {
    const { runtime, root } = setup({});
    await runtime.refresh();

    const paths = runtime.extensionPaths();
    expect(paths.map((file) => path.basename(file))).toEqual(['openchamber-gate.mjs', 'openchamber-managed-tools.mjs']);
    for (const file of paths) expect(file.startsWith(path.join(root, 'instance', 'pi'))).toBe(true);
    expect(fs.readFileSync(paths[0], 'utf8')).toContain('gate');
    expect(fs.readFileSync(paths[1], 'utf8')).toContain('openchamber');
    expect(fs.statSync(paths[1]).mode & 0o777).toBe(0o600);
  });

  it('drops the managed tools file when every tool is off and keeps the gate', async () => {
    const off = Object.fromEntries(['Control', 'Schedule', 'Web', 'Memory', 'Knowledge', 'Notify', 'Render', 'Image', 'Secret', 'Usage', 'Workflow'].map((name) => [`agent${name}ToolEnabled`, false]));
    const { runtime, setSettings } = setup({});
    await runtime.refresh();
    expect(runtime.extensionPaths()).toHaveLength(2);

    setSettings(off);
    await runtime.refresh();
    expect(runtime.extensionPaths().map((file) => path.basename(file))).toEqual(['openchamber-gate.mjs']);
    expect(fs.existsSync(path.join(path.dirname(runtime.extensionPaths()[0]), 'openchamber-managed-tools.mjs'))).toBe(false);
  });

  it('moves the generation on each refresh so stale processes can be told apart', async () => {
    const { runtime } = setup({});
    expect(runtime.generation).toBe(0);
    await runtime.refresh();
    await runtime.refresh();
    expect(runtime.generation).toBe(2);
  });

  it('applies the newest Settings when refreshes overlap', async () => {
    const { runtime, setSettings } = setup({ agentMemoryToolEnabled: false });
    const first = runtime.refresh();
    setSettings({ agentMemoryToolEnabled: true });
    const second = runtime.refresh();
    await Promise.all([first, second]);
    const source = fs.readFileSync(runtime.extensionPaths().find((file) => file.endsWith('managed-tools.mjs')), 'utf8');
    expect(source).toContain('openchamber_memory');
  });

  it('keeps serving the previous paths when a refresh fails', async () => {
    const { runtime, root } = setup({});
    await runtime.refresh();
    const before = runtime.extensionPaths();
    fs.rmSync(path.join(root, 'gate-source.js'));
    await expect(runtime.refresh()).rejects.toThrow();
    expect(runtime.extensionPaths()).toEqual(before);
  });
});
