import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';

import { approvalFlagFor, PI_APPROVE_FLAG, PI_NO_APPROVE_FLAG } from './approval.js';
import { createOpenCodeTrust } from './index.js';

let root;
let repo;

const write = async (relative, content) => {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const makeTrust = () => createOpenCodeTrust({ storePath: path.join(root, 'data', 'trust.json'), homeDirectory: path.join(root, 'home') });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-approval-')));
  repo = path.join(root, 'home', 'projects', 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('approvalFlagFor', () => {
  it('approves a folder that runs nothing, with or without text resources', async () => {
    const trust = makeTrust();
    expect(await approvalFlagFor(repo, trust)).toBe(PI_APPROVE_FLAG);
    await write('.pi/SYSTEM.md', 'text');
    await write('.pi/prompts/review.md', 'text');
    expect(await approvalFlagFor(repo, trust)).toBe(PI_APPROVE_FLAG);
  });

  it('refuses approval until the exact configuration is trusted, and again once it changes', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    const trust = makeTrust();
    expect(await approvalFlagFor(repo, trust)).toBe(PI_NO_APPROVE_FLAG);

    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await approvalFlagFor(repo, trust)).toBe(PI_APPROVE_FLAG);

    // Inside the trust cache's window: the flag reads the folder as it is now.
    await write('.pi/extensions/probe.ts', 'export default { changed: true }');
    expect(await approvalFlagFor(repo, trust)).toBe(PI_NO_APPROVE_FLAG);
  });

  it('refuses approval when the check itself fails', async () => {
    const failing = { assess: async () => { throw new Error('disk unreadable'); } };
    expect(await approvalFlagFor(repo, failing)).toBe(PI_NO_APPROVE_FLAG);
  });

  it('refuses approval when the trust answers cannot be read', async () => {
    await write('.pi/mcp.json', JSON.stringify({ mcpServers: { files: { command: 'npx' } } }));
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'trust.json'), '{ broken');
    expect(await approvalFlagFor(repo, makeTrust())).toBe(PI_NO_APPROVE_FLAG);
  });
});
