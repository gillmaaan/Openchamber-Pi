import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';

import { createOpenCodeTrust, OPENCODE_TRUST_REQUIRED } from './index.js';

let root;
let home;
let repo;

const write = async (relative, content) => {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const makeTrust = () => createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-trust-')));
  home = path.join(root, 'home');
  repo = path.join(home, 'projects', 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createOpenCodeTrust', () => {
  it('opens a folder without code at once and refuses one with plugins until trusted', async () => {
    const trust = makeTrust();
    const request = { method: 'GET', path: '/api/agent', headers: { 'x-opencode-directory': encodeURIComponent(repo) } };
    expect(await trust.refusalFor(request)).toBeNull();

    await write('.pi/extensions/probe.js', 'export default {}');
    const fresh = makeTrust();
    const refusal = await fresh.refusalFor(request);
    expect(refusal?.status).toBe(403);
    expect(refusal?.body).toMatchObject({ code: OPENCODE_TRUST_REQUIRED, directory: repo });

    const shown = await fresh.handleRoute({ method: 'GET', query: { directory: repo } });
    expect(shown.body).toMatchObject({ trusted: false, items: [{ kind: 'plugin', source: '.pi/extensions/probe.js' }] });
    const answered = await fresh.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(answered).toMatchObject({ status: 200, body: { trusted: true } });
    expect(await fresh.refusalFor(request)).toBeNull();

    const stored = JSON.parse(await readFile(path.join(root, 'data', 'opencode-trust.json'), 'utf8'));
    expect(Object.values(stored.repositories)).toEqual([{ fingerprints: [shown.body.fingerprint] }]);
  });

  it('asks again when the configuration changes after it was trusted', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });

    await write('.pi/extensions/probe.js', 'export default { changed: true }');
    expect((await makeTrust().handleRoute({ method: 'GET', query: { directory: repo } })).body.trusted).toBe(false);
  });

  it('records nothing when the configuration changed after it was shown', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await write('.pi/extensions/second.js', 'export default {}');

    const answered = await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(answered.status).toBe(409);
    expect(answered.body.items).toHaveLength(2);
    expect((await trust.handleRoute({ method: 'GET', query: { directory: repo } })).body.trusted).toBe(false);
  });

  it('lets global session reads through and checks the folder a session runs in', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const trust = makeTrust();
    const headers = { 'x-opencode-directory': encodeURIComponent(repo) };
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session?limit=50', headers })).toBeNull();
    expect(await trust.refusalFor({ method: 'GET', path: '/api/session/ses_1/message', headers })).toBeNull();
    expect(await trust.refusalFor({ method: 'DELETE', path: '/api/debug/location', headers })).toBeNull();

    const resolveSessionDirectory = async () => repo;
    const prompt = { method: 'POST', path: '/api/session/ses_1/prompt', headers: {}, resolveSessionDirectory };
    expect((await trust.refusalFor(prompt))?.status).toBe(403);
    expect(await trust.refusalFor({ ...prompt, resolveSessionDirectory: async () => null })).toBeNull();
    expect((await trust.refusalFor({ ...prompt, resolveSessionDirectory: async () => { throw new Error('down'); } }))?.status).toBe(503);
  });

  it('checks the folder a session moves into and the folder it leaves', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const plain = path.join(home, 'projects', 'plain');
    await mkdir(path.join(plain, 'sub'), { recursive: true });
    const trust = makeTrust();
    const move = (from, directory) => trust.refusalFor({
      method: 'POST',
      path: '/api/session/ses_1/move',
      headers: {},
      resolveSessionDirectory: async () => from,
      readBody: async () => ({ directory }),
    });

    const into = await move(plain, repo);
    expect(into).toMatchObject({ status: 403, body: { code: OPENCODE_TRUST_REQUIRED, directory: repo } });
    // Relative to the session's folder and from home, the way OpenCode resolves it.
    expect((await move(path.join(home, 'projects', 'plain'), '../repo'))?.body.directory).toBe(repo);
    expect((await move(plain, '~/projects/repo'))?.body.directory).toBe(repo);
    expect((await move(repo, plain))?.body.directory).toBe(repo);

    expect(await move(plain, path.join(plain, 'sub'))).toBeNull();
    // A folder that is gone opens nothing: OpenChamber moves sessions out of those.
    expect(await move(path.join(home, 'projects', 'gone'), plain)).toBeNull();

    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await move(plain, repo)).toBeNull();
  });

  it('refuses a move whose destination it cannot read', async () => {
    const move = { method: 'POST', path: '/api/session/ses_1/move', headers: {}, resolveSessionDirectory: async () => repo };
    expect((await makeTrust().refusalFor({ ...move, readBody: async () => ({}) }))?.status).toBe(400);
    expect((await makeTrust().refusalFor({ ...move, readBody: async () => { throw new SyntaxError('bad json'); } }))?.status).toBe(400);
    expect((await makeTrust().refusalFor(move))?.status).toBe(400);
  });

  it('checks an MCP form reply against the folder it names, without looking up a session', async () => {
    const resolveSessionDirectory = async () => { throw new Error('global is not a session'); };
    const reply = {
      method: 'POST',
      path: '/api/session/global/form/frm_1/reply',
      headers: { 'x-opencode-directory': encodeURIComponent(repo) },
      resolveSessionDirectory,
    };
    expect(await makeTrust().refusalFor(reply)).toBeNull();
    expect(await makeTrust().refusalFor({ ...reply, method: 'DELETE', path: '/api/session/global/form/frm_1' })).toBeNull();

    await write('.pi/extensions/probe.js', 'export default {}');
    expect((await makeTrust().refusalFor(reply))?.status).toBe(403);
  });

  it('reads the folder from the location query as well', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const refusal = await makeTrust().refusalFor({
      method: 'GET',
      path: `/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(repo)}`,
      headers: {},
    });
    expect(refusal?.status).toBe(403);
  });

  it('trusts the projects the user already had, once, and asks about everything after', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const other = path.join(home, 'projects', 'other');
    await mkdir(path.join(other, '.pi', 'extensions'), { recursive: true });
    await writeFile(path.join(other, '.pi', 'extensions', 'probe.js'), 'export default {}');
    const withProjects = (directories) => createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => directories,
    });

    const first = withProjects([repo]);
    expect(await first.isTrusted(repo)).toBe(true);
    expect(await first.isTrusted(other)).toBe(false);

    // A project added later is not trusted by a second start.
    expect(await withProjects([repo, other]).isTrusted(other)).toBe(false);

    await write('.pi/extensions/probe.js', 'export default { changed: true }');
    expect(await withProjects([repo]).isTrusted(repo)).toBe(false);
  });

  it('seeds the other projects when one folder stops answering', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const hung = path.join(root, 'network-share');
    const fsPromises = {
      ...(await import('fs')).promises,
      realpath: async (target) => (target === hung ? new Promise(() => {}) : realpath(target)),
    };
    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      fsPromises,
      listKnownDirectories: async () => [hung, repo],
    });
    const started = Date.now();
    expect(await trust.isTrusted(repo)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('seeds nothing when the project list cannot be read', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const failing = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => { throw new Error('settings unreadable'); },
    });
    expect(await failing.isTrusted(repo)).toBe(false);
    const later = createOpenCodeTrust({
      storePath: path.join(root, 'data', 'opencode-trust.json'),
      homeDirectory: home,
      listKnownDirectories: async () => [repo],
    });
    expect(await later.isTrusted(repo)).toBe(true);
  });

  it('checks a folder once per opening while OpenCode reports closings', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    let clock = 0;
    const trust = createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home, now: () => clock });
    trust.followLocations(true);
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);

    // The folder stays open: a changed plugin is OpenCode's to reload, the
    // answer holds however long it has been.
    await write('.pi/extensions/probe.js', 'export default { changed: true }');
    clock += 60 * 60 * 1000;
    expect(await trust.isTrusted(repo)).toBe(true);

    // OpenCode closed the folder: the next opening reads it again.
    await trust.forget(repo);
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('keeps answers short while closings go unreported', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    let clock = 0;
    const trust = createOpenCodeTrust({ storePath: path.join(root, 'data', 'opencode-trust.json'), homeDirectory: home, now: () => clock });
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);

    await write('.pi/extensions/probe.js', 'export default { changed: true }');
    clock += 1000;
    expect(await trust.isTrusted(repo)).toBe(true);
    clock += 2000;
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('forgets every answer when it starts following closings', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    const trust = makeTrust();
    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(repo)).toBe(true);
    await write('.pi/extensions/probe.js', 'export default { changed: true }');
    trust.followLocations(true);
    expect(await trust.isTrusted(repo)).toBe(false);
  });

  it('trusts nothing from a store it cannot read', async () => {
    await write('.pi/extensions/probe.js', 'export default {}');
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'opencode-trust.json'), '{ broken');
    expect(await makeTrust().isTrusted(repo)).toBe(false);
  });
});
