import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildPiRpcArgs, resolvePiRpcEntry, resolvePiRuntime } from './launch.js';
import { MANAGED_TOOLS, createPiPackages, createPiTrustReader, describeManagedExtensions } from './packages.js';
import { createPiCliRunner } from './packages-cli.js';
import { createPiRpcClient } from './rpc-client.js';
import { createPiFixture } from './test-support/pi-fixture.js';

// Everything here runs the real `pi` CLI against an isolated agent directory and
// a throwaway HOME. The only network address in reach is an unreachable
// loopback port, so a package that needs the registry fails fast and
// deterministically instead of touching npm.

let fixture;
let trusted;
let packages;
let initialSettings;
const clients = [];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const settingsFile = () => path.join(fixture.agentDir, 'settings.json');
/** What `/trust` in Pi saves: without it Pi refuses `-l` commands once a project has its own `.pi/settings.json`. */
const trustInPi = (directory) => fs.writeFileSync(path.join(fixture.agentDir, 'trust.json'), JSON.stringify({ [fs.realpathSync(directory)]: true }));
const projectSettingsFile = (dir = fixture.project) => path.join(dir, '.pi', 'settings.json');

const makeRunner = (extraEnv = {}) => createPiCliRunner({
  baseEnv: { ...fixture.env, npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0', ...extraEnv },
});

const makePackages = (overrides = {}) => createPiPackages({
  getAgentDir: () => fixture.agentDir,
  runPi: makeRunner(),
  isTrusted: async (directory) => trusted.has(directory),
  ...overrides,
});

/** A local Pi package with one extension, one skill and one prompt template. */
const makePackage = (name = 'demo-pkg', version = '1.2.3') => {
  const root = path.join(fixture.root, name);
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, keywords: ['pi-package'] }));
  fs.writeFileSync(path.join(root, 'extensions', 'hello.js'), 'export default function (pi) { pi.registerCommand("hello", { description: "hi", handler: async () => {} }); }\n');
  fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill\n---\nBody\n');
  fs.writeFileSync(path.join(root, 'prompts', 'review.md'), '---\ndescription: Review a thing\n---\nReview $1\n');
  return root;
};

/** The slash commands a real `pi --mode rpc` child offers for a folder: what the package really contributes. */
const commandsOf = async (cwd = fixture.project, { approve = true } = {}) => {
  const runtime = resolvePiRuntime();
  const client = createPiRpcClient({
    command: runtime.command,
    args: [resolvePiRpcEntry(), ...buildPiRpcArgs({ sessionId: `ses_${Math.random().toString(36).slice(2, 10)}`, approveProject: approve })],
    cwd,
    env: { ...fixture.env, ...runtime.env },
  });
  clients.push(client);
  const { commands } = await client.request('get_commands');
  client.kill('SIGKILL');
  await client.exited;
  return commands.filter((command) => command.sourceInfo?.source !== 'builtin').map((command) => command.name).sort();
};

beforeAll(() => {
  fixture = createPiFixture({ mockPort: 9 });
  initialSettings = fs.readFileSync(settingsFile(), 'utf8');
});
afterAll(() => {
  fixture.dispose();
});
beforeEach(() => {
  trusted = new Set([fixture.project]);
  packages = makePackages();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => { client.kill('SIGKILL'); await client.exited; }));
  // Every test starts from the fixture's own settings.
  fs.rmSync(settingsFile(), { force: true });
  fs.writeFileSync(settingsFile(), initialSettings);
  fs.rmSync(`${settingsFile()}.lock`, { recursive: true, force: true });
  fs.rmSync(path.join(fixture.agentDir, 'npm'), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.agentDir, 'extensions'), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.agentDir, 'trust.json'), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.project, '.pi'), { recursive: true, force: true });
});

describe('list', () => {
  it('answers with empty lists when nothing is configured', async () => {
    const result = await packages.list();
    expect(result).toEqual({ packages: [], extensions: [], projectTrusted: null, settingsErrors: [] });
  });

  it('reports a settings.json that is not JSON instead of failing, and never overwrites it', async () => {
    const broken = '{"defaultProvider": "mock",\n';
    fs.writeFileSync(settingsFile(), broken);

    const result = await packages.list({ directory: fixture.project });
    expect(result.packages).toEqual([]);
    expect(result.settingsErrors).toEqual([expect.objectContaining({ scope: 'user', path: settingsFile() })]);

    await expect(packages.add({ source: makePackage() })).rejects.toMatchObject({ code: 'SETTINGS_INVALID' });
    await expect(packages.setEnabled({ id: packages.encodeId('config', 'user:../x'), enabled: false })).rejects.toMatchObject({ code: expect.stringMatching(/SETTINGS_INVALID|NOT_FOUND/) });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(broken);
  });

  it('lists an installed package with its manifest, state and settings location', async () => {
    const root = makePackage('demo-pkg', '1.2.3');
    await packages.add({ source: root });

    const { packages: listed } = await packages.list();
    expect(listed).toEqual([expect.objectContaining({
      kind: 'local',
      name: 'demo-pkg',
      version: '1.2.3',
      scope: 'user',
      installed: true,
      installedPath: root,
      enabled: true,
      loaded: true,
      notLoadedReason: null,
      settingsPath: settingsFile(),
    })]);
    // Pi stores a local path relative to the settings file.
    expect(listed[0].source).toBe(path.relative(fixture.agentDir, root));
  });

  it('marks a configured package that is not on disk as not installed', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:left-behind@1.0.0'] }));
    const { packages: listed } = await packages.list();
    expect(listed[0]).toMatchObject({ kind: 'npm', name: 'left-behind', requested: '1.0.0', installed: false, version: null, loaded: false, notLoadedReason: 'not-installed' });
  });
});

describe('install, switch and remove with the real pi', () => {
  it('installs a local package globally, keeps the other settings keys, and Pi loads what it contributes', async () => {
    const before = readJson(settingsFile());
    const root = makePackage();

    const entry = await packages.add({ source: root });
    expect(entry).toMatchObject({ name: 'demo-pkg', scope: 'user', enabled: true });

    const after = readJson(settingsFile());
    expect(after).toEqual({ ...before, packages: [path.relative(fixture.agentDir, root)] });
    expect(await commandsOf()).toEqual(['hello', 'review', 'skill:demo-skill']);
  });

  it('switches a package off and on again, and Pi stops and resumes loading it', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });
    const source = path.relative(fixture.agentDir, root);

    await packages.setEnabled({ id, enabled: false });
    expect(readJson(settingsFile()).packages).toEqual([{ source, extensions: [], skills: [], prompts: [], themes: [] }]);
    expect((await packages.list()).packages[0]).toMatchObject({ enabled: false, loaded: false, notLoadedReason: 'disabled' });
    expect(await commandsOf()).toEqual([]);

    await packages.setEnabled({ id, enabled: true });
    expect(readJson(settingsFile()).packages).toEqual([source]);
    expect(await commandsOf()).toEqual(['hello', 'review', 'skill:demo-skill']);
  });

  it('gives a package its own filters back after a round trip through off', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });
    const source = path.relative(fixture.agentDir, root);
    await packages.updateEntry({ id, filters: { skills: [] } });
    expect(readJson(settingsFile()).packages).toEqual([{ source, skills: [] }]);
    expect(await commandsOf()).toEqual(['hello', 'review']);

    await packages.setEnabled({ id, enabled: false });
    expect(await commandsOf()).toEqual([]);
    await packages.setEnabled({ id, enabled: true });

    expect(readJson(settingsFile()).packages).toEqual([{ source, skills: [] }]);
    expect(await commandsOf()).toEqual(['hello', 'review']);
  });

  it('removes a package from settings and from what Pi loads', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });

    await packages.remove({ id });

    expect(readJson(settingsFile()).packages).toEqual([]);
    expect((await packages.list()).packages).toEqual([]);
    expect(await commandsOf()).toEqual([]);
    expect(fs.existsSync(root)).toBe(true);
    await expect(packages.remove({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a package that is already installed in the scope', async () => {
    const root = makePackage();
    await packages.add({ source: root });
    await expect(packages.add({ source: root })).rejects.toMatchObject({ code: 'ENTRY_EXISTS' });
    expect(readJson(settingsFile()).packages).toHaveLength(1);
  });

  it('leaves settings.json byte for byte as it was when an install fails', async () => {
    const original = `${JSON.stringify({ defaultProvider: 'mock', packages: [] }, null, 4)}\n`;
    fs.writeFileSync(settingsFile(), original);

    const error = await packages.add({ source: 'npm:never-published-package' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'INSTALL_FAILED' });
    expect(error.message).toContain('ECONNREFUSED');
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(original);
    await expect(packages.add({ source: path.join(fixture.root, 'no-such-folder') })).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(original);
  });

  it('serializes installs: the same source twice is one entry, different sources are all kept', async () => {
    const a = makePackage('pkg-a');

    const same = await Promise.allSettled([packages.add({ source: a }), packages.add({ source: a })]);
    expect(same.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(same.find((result) => result.status === 'rejected').reason.code).toBe('ENTRY_EXISTS');

    await Promise.all(['pkg-b', 'pkg-c', 'pkg-d'].map((name) => packages.add({ source: makePackage(name) })));

    expect(readJson(settingsFile()).packages.map((source) => path.basename(source)).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d']);
  });

  it('updates a local package without changing its entry', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });

    const result = await packages.update({ id });

    expect(result).toMatchObject({ id, scope: 'user', before: '1.2.3', after: '1.2.3', updated: false });
    expect(readJson(settingsFile()).packages).toEqual([path.relative(fixture.agentDir, root)]);
  });

  it('refuses an update by a source nothing matches', async () => {
    await expect(packages.updateTargets({ targets: ['npm:not-configured'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accepts the spec the page shows on every save, for a local package stored relative', async () => {
    const root = makePackage();
    const { id, source } = await packages.add({ source: root });
    expect(source).toBe(path.relative(fixture.agentDir, root));

    // No project folder, and the stored (settings-relative) spelling: the shape of the page's autosave.
    await packages.updateEntry({ id, spec: source, filters: { prompts: [] } });

    expect(readJson(settingsFile()).packages).toEqual([{ source, prompts: [] }]);
  });

  it('does not let a project folder that is gone block a user-scope change', async () => {
    const root = makePackage();
    const missing = path.join(fixture.root, 'deleted-project');
    const { id } = await packages.add({ source: root, directory: missing });

    await packages.setEnabled({ id, enabled: false, directory: missing });
    await packages.remove({ id, directory: missing });

    expect(readJson(settingsFile()).packages).toEqual([]);
  });

  it('changes the filters of an entry and refuses to change what package it is', async () => {
    const root = makePackage();
    const other = makePackage('other-pkg');
    const { id } = await packages.add({ source: root });

    await packages.updateEntry({ id, spec: root, filters: { prompts: ['prompts/review.md'] } });
    expect(await commandsOf()).toEqual(['hello', 'review', 'skill:demo-skill']);
    await packages.updateEntry({ id, filters: { prompts: [] } });
    expect(await commandsOf()).toEqual(['hello', 'skill:demo-skill']);
    await packages.updateEntry({ id, filters: {} });
    expect(readJson(settingsFile()).packages).toEqual([path.relative(fixture.agentDir, root)]);

    await expect(packages.updateEntry({ id, spec: other })).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });

    await packages.setEnabled({ id, enabled: false });
    await expect(packages.updateEntry({ id, filters: { skills: [] } })).rejects.toMatchObject({ code: 'PACKAGE_DISABLED' });
    await expect(packages.updateEntry({ id, filters: {} })).resolves.toBeTruthy();
  });
});

describe('a package that is one extension file', () => {
  it('has no off state: Pi loads it whatever its filters say, so the switch is refused', async () => {
    const file = path.join(fixture.root, 'solo.js');
    fs.writeFileSync(file, 'export default function (pi) { pi.registerCommand("solo", { description: "hi", handler: async () => {} }); }\n');
    const entry = await packages.add({ source: file });
    expect(entry).toMatchObject({ kind: 'local', enabled: true, switchable: false, loaded: true });

    await expect(packages.setEnabled({ id: entry.id, enabled: false })).rejects.toMatchObject({ code: 'NOT_SWITCHABLE' });
    await expect(packages.updateEntry({ id: entry.id, filters: { extensions: [] } })).rejects.toMatchObject({ code: 'NOT_SWITCHABLE' });
    expect(await commandsOf()).toEqual(['solo']);

    // An off form somebody wrote by hand does not make it look off either.
    const source = path.relative(fixture.agentDir, file);
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: [{ source, extensions: [], skills: [], prompts: [], themes: [] }] }));
    expect((await packages.list()).packages[0]).toMatchObject({ enabled: true, switchable: false, loaded: true });
    expect(await commandsOf()).toEqual(['solo']);

    await packages.remove({ id: (await packages.list()).packages[0].id });
    expect(await commandsOf()).toEqual([]);
  });
});

describe('project scope', () => {
  it('installs into a trusted project, and Pi loads it for that project only', async () => {
    const root = makePackage();
    trustInPi(fixture.project);

    const entry = await packages.add({ source: root, scope: 'project', directory: fixture.project });

    expect(entry).toMatchObject({ scope: 'project', loaded: true, settingsPath: projectSettingsFile() });
    expect(readJson(projectSettingsFile()).packages).toEqual([path.relative(path.join(fixture.project, '.pi'), root)]);
    expect(readJson(settingsFile()).packages ?? []).toEqual([]);
    expect(await commandsOf(fixture.project)).toEqual(['hello', 'review', 'skill:demo-skill']);
    // What `loaded: false` for an untrusted project means: a Pi that does not approve the folder skips the package.
    expect(await commandsOf(fixture.project, { approve: false })).toEqual([]);
    expect(await commandsOf(fixture.root)).toEqual([]);

    const listed = await packages.list({ directory: fixture.project });
    expect(listed.projectTrusted).toBe(true);
    expect(listed.packages).toEqual([expect.objectContaining({ scope: 'project', loaded: true })]);

    await packages.setEnabled({ id: entry.id, enabled: false, directory: fixture.project });
    expect(await commandsOf(fixture.project)).toEqual([]);
    await packages.remove({ id: entry.id, directory: fixture.project });
    expect(readJson(projectSettingsFile()).packages).toEqual([]);
  });

  it('refuses to add code to a project it does not trust, and creates nothing there', async () => {
    trusted.clear();

    await expect(packages.add({ source: makePackage(), scope: 'project', directory: fixture.project }))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED', message: expect.stringContaining('not a trusted project') });
    await expect(packages.createExtensionFile({ fileName: 'x.js', content: '', scope: 'project', directory: fixture.project }))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED' });
    expect(fs.existsSync(path.join(fixture.project, '.pi'))).toBe(false);
  });

  it('lists the packages of an untrusted project as not loaded and refuses every change to them', async () => {
    const root = makePackage();
    const entry = await packages.add({ source: root, scope: 'project', directory: fixture.project });
    const settingsBefore = fs.readFileSync(projectSettingsFile(), 'utf8');
    trusted.clear();

    const listed = await packages.list({ directory: fixture.project });
    expect(listed.projectTrusted).toBe(false);
    expect(listed.packages).toEqual([expect.objectContaining({ scope: 'project', enabled: true, loaded: false, notLoadedReason: 'project-not-trusted' })]);

    for (const attempt of [
      () => packages.setEnabled({ id: entry.id, enabled: false, directory: fixture.project }),
      () => packages.remove({ id: entry.id, directory: fixture.project }),
      () => packages.update({ id: entry.id, directory: fixture.project }),
      () => packages.contributions({ id: entry.id, directory: fixture.project }),
      () => packages.updateTargets({ targets: [entry.source], directory: fixture.project }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED' });
    }
    expect(fs.readFileSync(projectSettingsFile(), 'utf8')).toBe(settingsBefore);
  });

  it('treats a trust check that throws as not trusted', async () => {
    const failing = makePackages({ isTrusted: async () => { throw new Error('trust store unreadable'); } });
    await expect(failing.add({ source: makePackage(), scope: 'project', directory: fixture.project })).rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED' });
    expect((await failing.list({ directory: fixture.project })).projectTrusted).toBe(false);
  });

  it('lets the host\'s trust decide: Pi\'s own trust.json, even a no, does not block a project the host trusts', async () => {
    // `.pi/settings.json` exists and trust.json says no. Every project-scope command carries
    // `--approve` for that one command, so the decision made through `isTrusted` is the only one.
    fs.mkdirSync(path.join(fixture.project, '.pi'), { recursive: true });
    fs.writeFileSync(projectSettingsFile(), '{}');
    fs.writeFileSync(path.join(fixture.agentDir, 'trust.json'), JSON.stringify({ [fs.realpathSync(fixture.project)]: false }));
    const hostTrusts = makePackages({ isTrusted: async () => true });

    const entry = await hostTrusts.add({ source: makePackage(), scope: 'project', directory: fixture.project });
    expect(readJson(projectSettingsFile()).packages).toHaveLength(1);
    await hostTrusts.remove({ id: entry.id, directory: fixture.project });
    expect(readJson(projectSettingsFile()).packages).toEqual([]);
  });

  it('runs every later project-scope command too, with no saved decision in Pi\'s trust store', async () => {
    // Without the flag, Pi wants a saved decision for every `-l` command once the folder has settings of its own.
    const entry = await packages.add({ source: makePackage(), scope: 'project', directory: fixture.project });
    await expect(packages.update({ id: entry.id, directory: fixture.project })).resolves.toMatchObject({ updated: false });
    await packages.remove({ id: entry.id, directory: fixture.project });
    expect(readJson(projectSettingsFile()).packages).toEqual([]);
  });

  it('validates the scope and the folder', async () => {
    await expect(packages.add({ source: makePackage(), scope: 'global' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await expect(packages.add({ source: makePackage(), scope: 'project' })).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
    await expect(packages.add({ source: makePackage(), scope: 'project', directory: 'relative/dir' })).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
    await expect(packages.list({ directory: path.join(fixture.root, 'missing') })).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
  });
});

describe('the default trust reader', () => {
  const reader = () => createPiTrustReader({ getAgentDir: () => fixture.agentDir });

  it('follows Pi: a folder with nothing to protect is trusted, one with project settings needs a decision', async () => {
    expect(await reader()(fixture.project)).toBe(true);

    fs.mkdirSync(path.join(fixture.project, '.pi'), { recursive: true });
    fs.writeFileSync(projectSettingsFile(), '{}');
    expect(await reader()(fixture.project)).toBe(false);

    fs.writeFileSync(path.join(fixture.agentDir, 'trust.json'), JSON.stringify({ [fs.realpathSync(path.dirname(fixture.project))]: true }));
    expect(await reader()(fixture.project)).toBe(true);

    fs.writeFileSync(path.join(fixture.agentDir, 'trust.json'), JSON.stringify({ [fs.realpathSync(fixture.project)]: false }));
    expect(await reader()(fixture.project)).toBe(false);
  });

  it('honours defaultProjectTrust and treats a corrupt trust store as not trusted', async () => {
    fs.mkdirSync(path.join(fixture.project, '.pi'), { recursive: true });
    fs.writeFileSync(projectSettingsFile(), '{}');
    const settings = readJson(settingsFile());
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings, defaultProjectTrust: 'always' }));
    expect(await reader()(fixture.project)).toBe(true);

    fs.writeFileSync(path.join(fixture.agentDir, 'trust.json'), '{not json');
    expect(await reader()(fixture.project)).toBe(false);
  });

  it('agrees with the pi CLI about whether it will modify project packages', async () => {
    const root = makePackage();
    const real = createPiPackages({ getAgentDir: () => fixture.agentDir, runPi: makeRunner() });
    // Fresh folder: the reader says trusted and pi installs.
    await expect(real.add({ source: root, scope: 'project', directory: fixture.project })).resolves.toMatchObject({ scope: 'project' });
    // Now `.pi/settings.json` exists and nobody decided: the reader refuses before pi is asked.
    const second = makePackage('second');
    await expect(real.add({ source: second, scope: 'project', directory: fixture.project })).rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED', message: expect.stringContaining('not a trusted project') });
  });
});

describe('check', () => {
  const installNpm = (name, version) => {
    const dir = path.join(fixture.agentDir, 'npm', 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  };
  const registry = (table) => async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const found = table[name];
    if (found === 'down') throw new Error('connect ECONNREFUSED');
    if (!found) return { status: 404, body: null };
    return { status: 200, body: { 'dist-tags': { latest: found.latest, ...found.tags }, versions: Object.fromEntries(found.versions.map((version) => [version, {}])) } };
  };

  it('flags a package whose newest release is newer, leaves pins alone, and says when it could not check', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({
      packages: ['npm:floating', 'npm:ranged@^1.0.0', 'npm:pinned@1.0.0', 'npm:uptodate', 'npm:offline', 'npm:@scope/scoped', 'git:github.com/user/repo', 'npm:tagged@next', 'npm:untagged@beta'],
    }));
    for (const [name, version] of [['floating', '1.0.0'], ['ranged', '1.0.0'], ['pinned', '1.0.0'], ['uptodate', '2.0.0'], ['offline', '1.0.0'], ['@scope/scoped', '0.9.0'], ['tagged', '1.0.0'], ['untagged', '1.0.0']]) installNpm(name, version);
    const requested = [];
    const checking = makePackages({
      fetchRegistry: async (url, options) => { requested.push(url); return registry({
        floating: { latest: '1.1.0', versions: ['1.0.0', '1.1.0'] },
        ranged: { latest: '1.2.0', versions: ['1.0.0', '1.2.0'] },
        pinned: { latest: '2.0.0', versions: ['1.0.0', '2.0.0'] },
        uptodate: { latest: '2.0.0', versions: ['2.0.0'] },
        offline: 'down',
        '@scope/scoped': { latest: '1.0.0', versions: ['0.9.0', '1.0.0'] },
        tagged: { latest: '1.0.0', tags: { next: '2.0.0-beta.1' }, versions: ['1.0.0', '2.0.0-beta.1'] },
        untagged: { latest: '3.0.0', versions: ['1.0.0', '3.0.0'] },
      })(url, options); },
      resolveRegistryRequest: (name) => ({ url: `https://registry.test/${encodeURIComponent(name).replace(/^%40/i, '@')}`, headers: {} }),
    });

    const results = await checking.check();
    const byName = Object.fromEntries(results.map((result) => [result.name, result]));

    expect(byName.floating).toMatchObject({ installedVersion: '1.0.0', latestVersion: '1.1.0', outdated: true, pinned: false, checked: true });
    // A range is reported with the latest release but not flagged: `pi update` stays inside the range.
    expect(byName.ranged).toMatchObject({ outdated: false, pinned: false, rangeLimited: true, latestVersion: '1.2.0', checked: true });
    // A dist-tag is followed, not `latest`.
    expect(byName.tagged).toMatchObject({ outdated: true, latestVersion: '2.0.0-beta.1', rangeLimited: false });
    expect(byName.untagged).toMatchObject({ outdated: false, checked: false, error: expect.stringContaining('"beta" tag') });
    expect(byName.pinned).toMatchObject({ latestVersion: '2.0.0', outdated: false, pinned: true, checked: true });
    expect(byName.uptodate).toMatchObject({ outdated: false, checked: true });
    expect(byName.offline).toMatchObject({ outdated: false, checked: false, error: expect.stringContaining('ECONNREFUSED') });
    expect(byName['@scope/scoped']).toMatchObject({ outdated: true });
    expect(byName.repo).toMatchObject({ checked: false, reason: expect.stringContaining('Git') });
    expect(requested.some((url) => url === 'https://registry.test/@scope%2Fscoped')).toBe(true);
  });

  it('does not report a package without an installed version as outdated', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:missing'] }));
    const checking = makePackages({
      fetchRegistry: registry({ missing: { latest: '1.0.0', versions: ['1.0.0'] } }),
      resolveRegistryRequest: (name) => ({ url: `https://registry.test/${name}`, headers: {} }),
    });
    expect(await checking.check()).toEqual([expect.objectContaining({ name: 'missing', installedVersion: null, outdated: false })]);
  });

  it('answers a registry lookup from the cache until it is refreshed', async () => {
    let calls = 0;
    const lookup = makePackages({
      fetchRegistry: async () => { calls += 1; return { status: 200, body: { 'dist-tags': { latest: `1.0.${calls}` }, versions: { '1.0.1': {} } } }; },
      resolveRegistryRequest: () => ({ url: 'https://registry.test/x', headers: {} }),
    });
    expect((await lookup.registryInfo('x')).latest).toBe('1.0.1');
    expect((await lookup.registryInfo('x')).latest).toBe('1.0.1');
    expect((await lookup.registryInfo('x', { forceRefresh: true })).latest).toBe('1.0.2');
    expect(calls).toBe(2);
  });

  it('never caches or hides a registry failure', async () => {
    let up = false;
    const lookup = makePackages({
      fetchRegistry: async () => { if (!up) throw new Error('offline'); return { status: 200, body: { 'dist-tags': { latest: '1.0.0' }, versions: {} } }; },
      resolveRegistryRequest: () => ({ url: 'https://registry.test/x', headers: {} }),
    });
    expect(await lookup.registryInfo('x')).toMatchObject({ ok: false, status: 'network', error: 'offline' });
    up = true;
    expect(await lookup.registryInfo('x')).toMatchObject({ ok: true, latest: '1.0.0' });
  });
});

describe('searchRegistry', () => {
  const searchBody = {
    total: 13529,
    objects: [{
      downloads: { weekly: 847921, monthly: 3249299 },
      flags: { insecure: 0 },
      package: {
        name: 'pi-subagents', version: '0.87.0', description: 'Pi extension for delegation', keywords: ['pi-package', 'pi'], date: '2026-11-07T07:33:10.514Z',
        publisher: { username: 'nicopreme' }, links: { npm: 'https://www.npmjs.com/package/pi-subagents', homepage: 'https://example.test', repository: 'git+https://example.test/r.git' },
      },
    }, { package: { name: '@scope/other', keywords: [] }, flags: { insecure: 1 } }, { nonsense: true }],
  };

  it('lists the most popular pi packages for an empty query', async () => {
    const urls = [];
    const search = makePackages({ fetchRegistry: async (url) => { urls.push(url); return { status: 200, body: searchBody }; } });

    const result = await search.searchRegistry({ query: '   ' });

    const url = new URL(urls[0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://registry.npmjs.org/-/v1/search');
    expect(url.searchParams.get('text')).toBe('keywords:pi-package');
    expect(url.searchParams.get('popularity')).toBe('1.0');
    expect(url.searchParams.get('size')).toBe('20');
    expect(result.total).toBe(13529);
    expect(result.results).toEqual([
      {
        name: 'pi-subagents', source: 'npm:pi-subagents', version: '0.87.0', description: 'Pi extension for delegation', keywords: ['pi-package', 'pi'], date: '2026-11-07T07:33:10.514Z', publisher: 'nicopreme',
        links: { npm: 'https://www.npmjs.com/package/pi-subagents', homepage: 'https://example.test', repository: 'https://example.test/r' },
        weeklyDownloads: 847921, monthlyDownloads: 3249299, flaggedInsecure: false,
      },
      expect.objectContaining({ name: '@scope/other', source: 'npm:@scope/other', version: null, description: '', weeklyDownloads: null, flaggedInsecure: true }),
    ]);
  });

  it('passes on only web addresses as links', async () => {
    const search = makePackages({ fetchRegistry: async () => ({ status: 200, body: { total: 1, objects: [{ package: { name: 'x', links: { npm: 'javascript:alert(1)', homepage: 'https://example.test', repository: 'git+ssh://git@example.test/r.git' } } }] } }) });
    expect((await search.searchRegistry({})).results[0].links).toEqual({ npm: null, homepage: 'https://example.test', repository: null });
  });

  it('searches within the pi-package keyword and bounds the page', async () => {
    const urls = [];
    const search = makePackages({ fetchRegistry: async (url) => { urls.push(url); return { status: 200, body: searchBody }; } });

    await search.searchRegistry({ query: 'permission  gate\u0000', from: 40, size: 500 });
    const url = new URL(urls[0]);
    expect(url.searchParams.get('text')).toBe('keywords:pi-package permission gate');
    expect(url.searchParams.get('popularity')).toBeNull();
    expect(url.searchParams.get('size')).toBe('50');
    expect(url.searchParams.get('from')).toBe('40');
  });

  it('fails loudly when the registry cannot answer', async () => {
    const down = makePackages({ fetchRegistry: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); } });
    await expect(down.searchRegistry({})).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE', message: expect.stringContaining('ENOTFOUND') });
    const odd = makePackages({ fetchRegistry: async () => ({ status: 503, body: null }) });
    await expect(odd.searchRegistry({})).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE', message: expect.stringContaining('503') });
    const malformed = makePackages({ fetchRegistry: async () => ({ status: 200, body: { nothing: 1 } }) });
    await expect(malformed.searchRegistry({})).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
  });
});

describe('contributions', () => {
  it('lists what an installed package loads, as Pi resolves it', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });

    const result = await packages.contributions({ id });

    expect(result).toMatchObject({ installed: true, source: path.relative(fixture.agentDir, root) });
    expect(result.extensions).toEqual([expect.objectContaining({ name: 'hello', relativePath: 'extensions/hello.js', enabled: true })]);
    expect(result.skills).toEqual([expect.objectContaining({ name: 'demo-skill', description: 'A demo skill', relativePath: 'skills/demo-skill/SKILL.md', enabled: true })]);
    expect(result.prompts).toEqual([expect.objectContaining({ name: 'review', description: 'Review a thing', enabled: true })]);
    expect(result.themes).toEqual([]);
  });

  it('shows a resource a filter switches off as disabled, and a manifest in place of the folders', async () => {
    const root = makePackage();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.js'), 'export default () => {};\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.2.3', pi: { extensions: ['./src/main.js'], skills: ['./skills'], prompts: ['./prompts/*.md'] } }));
    const { id } = await packages.add({ source: root });
    await packages.updateEntry({ id, filters: { skills: [] } });

    const result = await packages.contributions({ id });

    expect(result.extensions.map((extension) => extension.relativePath)).toEqual(['src/main.js']);
    expect(result.skills).toEqual([expect.objectContaining({ name: 'demo-skill', enabled: false })]);
    expect(result.prompts).toEqual([expect.objectContaining({ name: 'review', enabled: true })]);
  });

  it('says so when the package is not installed instead of listing nothing', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:left-behind@1.0.0'] }));
    const [entry] = (await packages.list()).packages;
    expect(await packages.contributions({ id: entry.id })).toMatchObject({ installed: false, root: null, extensions: [] });
  });

  it('reports a package manager that cannot be loaded as an error', async () => {
    const root = makePackage();
    const broken = makePackages({ loadSdk: async () => { throw new Error('sdk missing'); } });
    const { id } = await broken.add({ source: root });
    await expect(broken.contributions({ id })).rejects.toMatchObject({ code: 'CONTRIBUTIONS_UNAVAILABLE' });
  });
});

describe('extension files', () => {
  const greet = 'export default function (pi) { pi.registerCommand("greet", { description: "hi", handler: async () => {} }); }\n';

  it('creates, reads, edits and deletes a file in the extensions folder', async () => {
    const created = await packages.createExtensionFile({ fileName: 'greet.js', content: greet });
    expect(created).toMatchObject({ fileName: 'greet.js', scope: 'user', absolutePath: path.join(fixture.agentDir, 'extensions', 'greet.js') });
    expect(await commandsOf()).toEqual(['greet']);

    expect(await packages.readExtensionFile({ id: created.id })).toEqual({ fileName: 'greet.js', scope: 'user', content: greet });
    await expect(packages.createExtensionFile({ fileName: 'greet.js', content: '' })).rejects.toMatchObject({ code: 'FILE_EXISTS' });

    await packages.updateExtensionFile({ id: created.id, content: greet.replace('greet', 'wave') });
    expect(await commandsOf()).toEqual(['wave']);

    const listed = await packages.list();
    expect(listed.extensions).toEqual([expect.objectContaining({ name: 'greet.js', kind: 'file', scope: 'user', enabled: true, loaded: true })]);

    await packages.deleteExtensionFile({ id: created.id });
    expect(fs.existsSync(created.absolutePath)).toBe(false);
    await expect(packages.readExtensionFile({ id: created.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(packages.deleteExtensionFile({ id: created.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads and edits a file whose name this page would not create, but not one that leaves the folder', async () => {
    fs.mkdirSync(path.join(fixture.agentDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, 'extensions', 'MyExt.ts'), greet);
    const [item] = (await packages.list()).extensions;
    expect(item).toMatchObject({ name: 'MyExt.ts', kind: 'file' });

    expect((await packages.readExtensionFile({ id: item.id })).content).toBe(greet);
    await packages.updateExtensionFile({ id: item.id, content: '// edited\n' });
    expect(fs.readFileSync(item.absolutePath, 'utf8')).toBe('// edited\n');

    for (const name of ['../x.js', 'sub/x.js', '.hidden.js', 'a\\b.js', 'x.txt']) {
      await expect(packages.readExtensionFile({ id: packages.encodeId('file', `user:${name}`) })).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    }
  });

  it('refuses names Pi would not load or that leave the folder', async () => {
    for (const fileName of ['greet.mjs', 'greet.cjs', '../evil.js', 'sub/evil.js', 'Greet.js', '', '.hidden.js', 'greet']) {
      await expect(packages.createExtensionFile({ fileName, content: greet })).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    }
    expect(fs.existsSync(path.join(fixture.agentDir, 'extensions'))).toBe(false);
  });

  it('switches a file off and on with the override entries pi config writes, and Pi follows', async () => {
    const { id } = await packages.createExtensionFile({ fileName: 'greet.js', content: greet });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readJson(settingsFile()), extensions: ['extensions/other.js'] }));

    await packages.setExtensionEnabled({ id, enabled: false });
    expect(readJson(settingsFile()).extensions).toEqual(['extensions/other.js', '-extensions/greet.js']);
    expect((await packages.list()).extensions[0]).toMatchObject({ enabled: false, loaded: false, notLoadedReason: 'disabled' });
    expect(await commandsOf()).toEqual([]);

    await packages.setExtensionEnabled({ id, enabled: true });
    expect(readJson(settingsFile()).extensions).toEqual(['extensions/other.js']);
    expect(await commandsOf()).toEqual(['greet']);
    expect(await packages.setExtensionEnabled({ id, enabled: true })).toMatchObject({ changed: false });
  });

  it('deletes the file and says so when the settings file cannot be cleaned up', async () => {
    const { id, absolutePath } = await packages.createExtensionFile({ fileName: 'greet.js', content: greet });
    await packages.setExtensionEnabled({ id, enabled: false });
    fs.writeFileSync(settingsFile(), '{broken');

    const result = await packages.deleteExtensionFile({ id });

    expect(fs.existsSync(absolutePath)).toBe(false);
    expect(result.warning).toContain('could not be updated');
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{broken');
  });

  it('forgets the override of a deleted file so a new file of that name loads', async () => {
    const { id } = await packages.createExtensionFile({ fileName: 'greet.js', content: greet });
    await packages.setExtensionEnabled({ id, enabled: false });

    await packages.deleteExtensionFile({ id });
    expect(readJson(settingsFile()).extensions ?? []).toEqual([]);
    await packages.createExtensionFile({ fileName: 'greet.js', content: greet });
    expect(await commandsOf()).toEqual(['greet']);
  });

  it('lists an extension folder and switches it by its entry file', async () => {
    const dir = path.join(fixture.agentDir, 'extensions', 'bundle');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), greet);
    fs.mkdirSync(path.join(fixture.agentDir, 'extensions', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, 'extensions', 'notes', 'README.md'), 'not an extension');

    const { extensions } = await packages.list();
    expect(extensions).toEqual([expect.objectContaining({ name: 'bundle', kind: 'directory', enabled: true })]);

    await packages.setExtensionEnabled({ id: extensions[0].id, enabled: false });
    expect(readJson(settingsFile()).extensions).toEqual(['-extensions/bundle/index.js']);
    expect(await commandsOf()).toEqual([]);
  });

  it('keeps project files out of an untrusted folder and lists them as not loaded', async () => {
    const created = await packages.createExtensionFile({ fileName: 'greet.js', content: greet, scope: 'project', directory: fixture.project });
    trusted.clear();

    expect((await packages.list({ directory: fixture.project })).extensions).toEqual([expect.objectContaining({ scope: 'project', loaded: false, notLoadedReason: 'project-not-trusted' })]);
    expect((await packages.readExtensionFile({ id: created.id, directory: fixture.project })).content).toBe(greet);
    for (const attempt of [
      () => packages.updateExtensionFile({ id: created.id, content: 'x', directory: fixture.project }),
      () => packages.deleteExtensionFile({ id: created.id, directory: fixture.project }),
      () => packages.setExtensionEnabled({ id: created.id, enabled: false, directory: fixture.project }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'PROJECT_NOT_TRUSTED' });
    }
    expect(fs.readFileSync(created.absolutePath, 'utf8')).toBe(greet);
  });
});

describe('settings writes', () => {
  it('waits for a lock Pi holds, steals a stale one, and keeps a symlinked settings file a symlink', async () => {
    const root = makePackage();
    const { id } = await packages.add({ source: root });
    const lock = `${settingsFile()}.lock`;

    fs.mkdirSync(lock);
    setTimeout(() => fs.rmdirSync(lock), 150);
    const startedAt = Date.now();
    await packages.setEnabled({ id, enabled: false });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);

    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await packages.setEnabled({ id, enabled: true });
    expect(fs.existsSync(lock)).toBe(false);

    const real = path.join(fixture.root, 'dotfiles-settings.json');
    fs.copyFileSync(settingsFile(), real);
    fs.rmSync(settingsFile());
    fs.symlinkSync(real, settingsFile());
    await packages.setEnabled({ id, enabled: false });
    expect(fs.lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(readJson(real).packages[0]).toMatchObject({ skills: [] });
    expect(readJson(real).defaultProvider).toBe('mock');
  });

  it('preserves keys it does not own, and unknown keys on a package entry', async () => {
    const root = makePackage();
    const source = path.relative(fixture.agentDir, root);
    fs.writeFileSync(settingsFile(), `﻿${JSON.stringify({ theme: 'dark', retry: { enabled: true }, packages: [{ source, autoload: true, note: 'mine' }, 'npm:other'] })}`);
    const [entry] = (await packages.list()).packages;

    await packages.setEnabled({ id: entry.id, enabled: false });
    await packages.setEnabled({ id: entry.id, enabled: true });

    expect(readJson(settingsFile())).toEqual({ theme: 'dark', retry: { enabled: true }, packages: [{ source, autoload: true, note: 'mine' }, 'npm:other'] });
  });
});

describe('managed extensions', () => {
  it('names the Settings flag behind every managed tool', async () => {
    const { managedToolFlags } = await import('./managed-runtime.js');
    const { managedToolSpecs } = await import('../agent-tool/runtime.js');
    for (const tool of MANAGED_TOOLS) {
      expect(managedToolFlags({ [tool.setting]: true })[tool.flag]).toBe(true);
      expect(managedToolFlags({ [tool.setting]: false })[tool.flag]).toBe(false);
      const only = Object.fromEntries(MANAGED_TOOLS.map((other) => [other.flag, other.flag === tool.flag]));
      expect(managedToolSpecs(only).map((spec) => spec.name)).toEqual(tool.tools);
    }
    expect(MANAGED_TOOLS).toHaveLength(Object.keys(managedToolFlags({})).length);
  });

  it('describes them as read-only built-in rows', () => {
    const rows = describeManagedExtensions({ includeControl: true, includeSchedule: false });
    expect(rows.map((row) => row.id)).toEqual(['openchamber.managed-tools', 'openchamber.gate']);
    expect(rows.every((row) => row.readOnly && row.kind === 'managed')).toBe(true);
    expect(rows[0].tools.find((tool) => tool.setting === 'agentScheduleToolEnabled')).toMatchObject({ enabled: false, names: ['openchamber_schedule'] });
    expect(rows[0].tools.find((tool) => tool.setting === 'agentControlToolEnabled')).toMatchObject({ enabled: true });
    expect(describeManagedExtensions({})[0].enabled).toBe(false);
  });
});
