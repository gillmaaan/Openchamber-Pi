import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPiPackages } from '../packages.js';
import { createPiCliRunner } from '../packages-cli.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { createPluginConfigRoutes } from './plugins.js';

// The Settings Plugins page's routes over real Pi packages in an isolated agent
// directory. Registry answers are injected; the only network address in reach is
// an unreachable loopback port.

let fixture;
let initialSettings;
let trusted;
let app;
let changes;
let registryUrls;
let registryAnswer;

const settingsFile = () => path.join(fixture.agentDir, 'settings.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const makePackage = (name = 'demo-pkg') => {
  const root = path.join(fixture.root, name);
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'extensions', 'hello.js'), 'export default function () {}\n');
  fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill\n---\nBody\n');
  return root;
};

const dir = (directory) => (directory ? `?directory=${encodeURIComponent(directory)}` : '');

beforeAll(() => {
  fixture = createPiFixture({ mockPort: 9 });
  initialSettings = fs.readFileSync(settingsFile(), 'utf8');
});
afterAll(() => fixture.dispose());

beforeEach(() => {
  trusted = new Set([fixture.project]);
  changes = [];
  registryUrls = [];
  registryAnswer = async () => ({ status: 404, body: null });
  const packages = createPiPackages({
    getAgentDir: () => fixture.agentDir,
    runPi: createPiCliRunner({ baseEnv: { ...fixture.env, npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' } }),
    isTrusted: async (directory) => trusted.has(directory),
    fetchRegistry: async (url, options) => { registryUrls.push(url); return registryAnswer(url, options); },
    resolveRegistryRequest: (name) => ({ url: `https://registry.test/${encodeURIComponent(name).replace(/^%40/i, '@')}`, headers: {} }),
  });
  app = express();
  app.use(express.json());
  createPluginConfigRoutes({
    app,
    packages,
    resolveOptionalProjectDirectory: async (req) => {
      const directory = req.query.directory;
      if (!directory) return { directory: null };
      return fs.existsSync(directory) ? { directory } : { error: 'Directory not found' };
    },
    readSettings: async () => ({ agentScheduleToolEnabled: false, agentMemoryToolEnabled: true }),
    onChanged: (change) => changes.push(change),
    logger: { error: vi.fn() },
  });
});

afterEach(() => {
  fs.rmSync(settingsFile(), { force: true });
  fs.writeFileSync(settingsFile(), initialSettings);
  for (const name of ['npm', 'extensions', 'trust.json']) fs.rmSync(path.join(fixture.agentDir, name), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.project, '.pi'), { recursive: true, force: true });
});

describe('GET /api/config/plugins', () => {
  it('answers with empty lists, the managed extensions and no error for a fresh install', async () => {
    const response = await request(app).get('/api/config/plugins').expect(200);

    expect(response.body).toMatchObject({ entries: [], files: [], projectTrusted: null, settingsErrors: [] });
    expect(response.body.managed.map((row) => row.id)).toEqual(['openchamber.managed-tools', 'openchamber.gate']);
    const tools = response.body.managed[0].tools;
    expect(tools.find((tool) => tool.setting === 'agentScheduleToolEnabled')).toMatchObject({ enabled: false });
    expect(tools.find((tool) => tool.setting === 'agentMemoryToolEnabled')).toMatchObject({ enabled: true });
  });

  it('fills the page\'s entry and file fields from what Pi has', async () => {
    const root = makePackage();
    await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'user' }).expect(200);
    await request(app).post('/api/config/plugins/file').send({ fileName: 'greet.js', content: 'export default () => {};\n', scope: 'user' }).expect(200);

    const { body } = await request(app).get('/api/config/plugins').expect(200);

    expect(body.entries).toEqual([expect.objectContaining({
      spec: path.relative(fixture.agentDir, root),
      scope: 'user',
      kind: 'config',
      parsedKind: 'path',
      sourcePath: settingsFile(),
      switchState: 'on',
      policyResource: expect.stringMatching(/^plugin:/),
      resolvedPath: root,
      name: 'demo-pkg',
      version: '1.2.3',
      installed: true,
      enabled: true,
      loaded: true,
    })]);
    expect(body.entries[0].options).toBeUndefined();
    expect(body.files).toEqual([expect.objectContaining({
      fileName: 'greet.js', scope: 'user', kind: 'file', absolutePath: path.join(fixture.agentDir, 'extensions', 'greet.js'), switchState: 'on', loaded: true,
    })]);
  });

  it('reports a broken settings file as data, with status 200', async () => {
    fs.writeFileSync(settingsFile(), '{"packages": [');
    const response = await request(app).get('/api/config/plugins').expect(200);
    expect(response.body.entries).toEqual([]);
    expect(response.body.settingsErrors).toEqual([expect.objectContaining({ scope: 'user', path: settingsFile() })]);
  });

  it('marks the packages of an untrusted project as unavailable and not loaded', async () => {
    const root = makePackage();
    await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'project' }).query({ directory: fixture.project }).expect(200);
    trusted.clear();

    const { body } = await request(app).get(`/api/config/plugins${dir(fixture.project)}`).expect(200);

    expect(body.projectTrusted).toBe(false);
    expect(body.entries).toEqual([expect.objectContaining({ scope: 'project', switchState: 'unavailable', loaded: false, notLoadedReason: 'project-not-trusted' })]);
  });

  it('answers 400 for a folder the project resolver refuses', async () => {
    const response = await request(app).get(`/api/config/plugins${dir(path.join(fixture.root, 'missing'))}`).expect(400);
    expect(response.body).toEqual({ error: 'Directory not found' });
  });
});

describe('entries', () => {
  it('creates, switches, narrows and deletes a package', async () => {
    const root = makePackage();
    const source = path.relative(fixture.agentDir, root);

    const created = await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'user', options: { skills: [] } }).expect(200);
    expect(created.body).toMatchObject({ success: true, scope: 'user', path: settingsFile() });
    expect(readJson(settingsFile()).packages).toEqual([{ source, skills: [] }]);
    const id = created.body.id;

    const entry = await request(app).get(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(200);
    expect(entry.body).toMatchObject({ id, spec: source, options: { skills: [] }, switchState: 'on' });

    const off = await request(app).put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`).send({ enabled: false }).expect(200);
    expect(off.body).toMatchObject({ success: true, enabled: false, message: 'Plugin disabled.' });
    expect((await request(app).get(`/api/config/plugins/entry/${encodeURIComponent(id)}`)).body).toMatchObject({ switchState: 'off', enabled: false });
    expect(readJson(settingsFile()).packages[0]).toMatchObject({ extensions: [], skills: [], prompts: [], themes: [] });

    await request(app).put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`).send({ enabled: true }).expect(200);
    expect(readJson(settingsFile()).packages).toEqual([{ source, skills: [] }]);

    await request(app).patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`).send({ options: {} }).expect(200);
    expect(readJson(settingsFile()).packages).toEqual([source]);

    await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(200);
    expect(readJson(settingsFile()).packages).toEqual([]);
    await request(app).get(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(404);

    expect(changes.map((change) => change.what)).toEqual(['package', 'package', 'package', 'package', 'package']);
  });

  it('keeps the page\'s error contract', async () => {
    const root = makePackage();
    await request(app).post('/api/config/plugins/entry').send({ spec: root }).expect(200);

    // A spec Pi cannot install: the page marks the field as rejected on this code.
    const unloadable = await request(app).post('/api/config/plugins/entry').send({ spec: 'owner/repo', scope: 'user' }).expect(400);
    expect(unloadable.body).toMatchObject({ code: 'UNLOADABLE_SPEC' });
    await request(app).post('/api/config/plugins/entry').send({ spec: 'http://example.test/o/r', scope: 'user' }).expect(400);
    await request(app).post('/api/config/plugins/entry').send({ spec: '', scope: 'user' }).expect(400);
    await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'global' }).expect(400);
    await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'project' }).expect(400);

    await request(app).post('/api/config/plugins/entry').send({ spec: root, scope: 'user' }).expect(409);
    await request(app).post('/api/config/plugins/entry').send({ spec: makePackage('other'), options: { nope: [] } }).expect(400);
    await request(app).post('/api/config/plugins/entry').send({ spec: makePackage('other'), options: { skills: 'all' } }).expect(400);
    await request(app).put('/api/config/plugins/entry/whatever/enabled').send({ enabled: 'yes' }).expect(400);
    await request(app).put('/api/config/plugins/entry/whatever/enabled').send({ enabled: true }).expect(400);
    await request(app).delete('/api/config/plugins/entry/whatever').expect(400);
  });

  it('refuses to switch off a package that is one extension file, and shows its switch as unavailable', async () => {
    const file = path.join(fixture.root, 'solo.js');
    fs.writeFileSync(file, 'export default function () {}\n');
    const created = await request(app).post('/api/config/plugins/entry').send({ spec: file }).expect(200);

    const response = await request(app).put(`/api/config/plugins/entry/${encodeURIComponent(created.body.id)}/enabled`).send({ enabled: false }).expect(409);
    expect(response.body).toMatchObject({ code: 'NOT_SWITCHABLE' });
    expect((await request(app).get(`/api/config/plugins/entry/${encodeURIComponent(created.body.id)}`)).body).toMatchObject({ switchState: 'unavailable', enabled: true, switchable: false });
  });

  it('refuses to change what package an entry is', async () => {
    const created = await request(app).post('/api/config/plugins/entry').send({ spec: makePackage('one') }).expect(200);
    const response = await request(app).patch(`/api/config/plugins/entry/${encodeURIComponent(created.body.id)}`).send({ spec: makePackage('two') }).expect(400);
    expect(response.body).toMatchObject({ code: 'IDENTITY_CHANGED' });
  });

  it('answers 403 with a clear message for a project it does not trust, and writes nothing', async () => {
    trusted.clear();
    const response = await request(app).post('/api/config/plugins/entry').query({ directory: fixture.project }).send({ spec: makePackage(), scope: 'project' }).expect(403);
    expect(response.body).toMatchObject({ code: 'PROJECT_NOT_TRUSTED', error: expect.stringContaining('not a trusted project') });
    expect(fs.existsSync(path.join(fixture.project, '.pi'))).toBe(false);
    expect(changes).toEqual([]);
  });

  it('answers 502 with the reason when the package manager fails, and leaves settings alone', async () => {
    const before = fs.readFileSync(settingsFile(), 'utf8');
    const response = await request(app).post('/api/config/plugins/entry').send({ spec: 'npm:never-published-package' }).expect(502);
    expect(response.body).toMatchObject({ code: 'INSTALL_FAILED', error: expect.stringContaining('ECONNREFUSED') });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before);
    expect(changes).toEqual([]);
  });

  it('answers 409 for a settings file it cannot parse, and does not touch it', async () => {
    fs.writeFileSync(settingsFile(), '{oops');
    const response = await request(app).post('/api/config/plugins/entry').send({ spec: makePackage() }).expect(409);
    expect(response.body).toMatchObject({ code: 'SETTINGS_INVALID' });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{oops');
  });

  it('answers 500 with a generic message for a failure it does not know', async () => {
    const failing = express();
    failing.use(express.json());
    const logger = { error: vi.fn() };
    createPluginConfigRoutes({
      app: failing,
      packages: { list: async () => { throw new Error('disk on fire'); } },
      resolveOptionalProjectDirectory: async () => ({ directory: null }),
      logger,
    });
    const response = await request(failing).get('/api/config/plugins').expect(500);
    expect(response.body).toEqual({ error: 'Failed to list plugins' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('files', () => {
  const body = 'export default function (pi) { pi.registerCommand("greet", { description: "hi", handler: async () => {} }); }\n';

  it('creates, reads, edits, switches and deletes an extension file', async () => {
    const created = await request(app).post('/api/config/plugins/file').send({ fileName: 'greet.js', content: body, scope: 'user' }).expect(200);
    const id = encodeURIComponent(created.body.id);

    expect((await request(app).get(`/api/config/plugins/file/${id}`).expect(200)).body).toEqual({ fileName: 'greet.js', scope: 'user', content: body });
    await request(app).put(`/api/config/plugins/file/${id}`).send({ content: `${body}// edited\n` }).expect(200);
    expect(fs.readFileSync(created.body.path, 'utf8')).toContain('// edited');

    await request(app).put(`/api/config/plugins/file/${id}/enabled`).send({ enabled: false }).expect(200);
    expect(readJson(settingsFile()).extensions).toEqual(['-extensions/greet.js']);
    expect((await request(app).get('/api/config/plugins')).body.files[0]).toMatchObject({ switchState: 'off', loaded: false });

    await request(app).delete(`/api/config/plugins/file/${id}`).expect(200);
    await request(app).get(`/api/config/plugins/file/${id}`).expect(404);
  });

  it('keeps the page\'s error contract for files', async () => {
    await request(app).post('/api/config/plugins/file').send({ fileName: 'greet.js', content: body }).expect(200);
    await request(app).post('/api/config/plugins/file').send({ fileName: 'greet.js', content: body }).expect(409);
    const mjs = await request(app).post('/api/config/plugins/file').send({ fileName: 'greet.mjs', content: body }).expect(400);
    expect(mjs.body).toMatchObject({ code: 'INVALID_FILENAME', error: expect.stringContaining('.js or .ts') });
    await request(app).post('/api/config/plugins/file').send({ fileName: '../x.js', content: body }).expect(400);
    await request(app).get('/api/config/plugins/file/nonsense').expect(400);
  });

  it('refuses project files in an untrusted folder', async () => {
    trusted.clear();
    const response = await request(app).post('/api/config/plugins/file').query({ directory: fixture.project }).send({ fileName: 'greet.js', content: body, scope: 'project' }).expect(403);
    expect(response.body.code).toBe('PROJECT_NOT_TRUSTED');
  });
});

describe('registry status', () => {
  const answer = (table) => async (url) => {
    const found = table[decodeURIComponent(new URL(url).pathname.slice(1))];
    if (found === 'down') throw new Error('connect ECONNREFUSED');
    if (!found) return { status: 404, body: null };
    return { status: 200, body: { 'dist-tags': { latest: found.latest }, versions: Object.fromEntries(found.versions.map((version) => [version, {}])) } };
  };

  it('answers every kind of result the page renders', async () => {
    registryAnswer = answer({
      pinned: { latest: '2.0.0', versions: ['1.0.0', '2.0.0'] },
      floating: { latest: '2.0.0', versions: ['1.0.0', '2.0.0'] },
      yanked: { latest: '2.0.0', versions: ['2.0.0'] },
      offline: 'down',
    });
    const root = makePackage();
    await request(app).post('/api/config/plugins/entry').send({ spec: root }).expect(200);
    const relative = path.relative(fixture.agentDir, root);
    const specs = ['npm:pinned@1.0.0', 'npm:floating', 'npm:yanked@1.5.0', 'npm:absent', 'npm:offline', 'npm:bad@', relative, '/no/such/folder', 'git:github.com/user/repo'];

    const { body } = await request(app).get(`/api/config/plugins/registry?specs=${specs.map(encodeURIComponent).join(',')}`).expect(200);
    const byKind = Object.fromEntries(body.results.map((result) => [result.spec, result]));

    expect(byKind['npm:pinned@1.0.0']).toMatchObject({ kind: 'npm-ok', name: 'pinned', currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true });
    expect(byKind['npm:floating']).toMatchObject({ kind: 'npm-ok', currentVersion: null, hasUpdate: false });
    expect(byKind['npm:yanked@1.5.0']).toMatchObject({ kind: 'npm-missing-version', currentVersion: '1.5.0', latestVersion: '2.0.0' });
    expect(byKind['npm:absent']).toMatchObject({ kind: 'npm-missing-package' });
    expect(byKind['npm:offline']).toMatchObject({ kind: 'npm-network', error: expect.stringContaining('ECONNREFUSED') });
    expect(byKind['npm:bad@']).toMatchObject({ kind: 'npm-malformed' });
    expect(byKind[relative]).toMatchObject({ kind: 'path-ok', absolutePath: root });
    expect(byKind['/no/such/folder']).toMatchObject({ kind: 'path-missing', absolutePath: '/no/such/folder' });
    expect(byKind['git:github.com/user/repo']).toEqual({ kind: 'git-ok', spec: 'git:github.com/user/repo' });
  });

  it('asks the registry once per package and again on refresh', async () => {
    registryAnswer = answer({ one: { latest: '1.0.0', versions: ['1.0.0'] } });
    const url = (extra = '') => `/api/config/plugins/registry?specs=${encodeURIComponent('npm:one@1.0.0')},${encodeURIComponent('npm:one@1.0.0')}${extra}`;
    await request(app).get(url()).expect(200);
    await request(app).get(url()).expect(200);
    expect(registryUrls).toHaveLength(1);
    await request(app).get(url('&refresh=true')).expect(200);
    expect(registryUrls).toHaveLength(2);
    await request(app).get(`/api/config/plugins/registry?specs=${Array.from({ length: 101 }, (_, index) => `npm:p${index}`).join(',')}`).expect(400);
  });
});

describe('search and contributions', () => {
  it('searches the registry and marks the packages that are already configured', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:pi-subagents@0.87.0'] }));
    registryAnswer = async () => ({
      status: 200,
      body: { total: 2, objects: [{ package: { name: 'pi-subagents', version: '0.87.0', description: 'delegation' } }, { package: { name: 'pi-other', version: '1.0.0' } }] },
    });

    const { body } = await request(app).get('/api/config/plugins/search?q=agents&size=5').expect(200);

    expect(new URL(registryUrls[0]).searchParams.get('text')).toBe('keywords:pi-package agents');
    expect(body.total).toBe(2);
    expect(body.results[0]).toMatchObject({ name: 'pi-subagents', source: 'npm:pi-subagents', installed: [{ scope: 'user', enabled: true }] });
    expect(body.results[1]).toMatchObject({ name: 'pi-other', installed: [] });
  });

  it('answers 502 when the registry cannot be reached', async () => {
    registryAnswer = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
    const response = await request(app).get('/api/config/plugins/search').expect(502);
    expect(response.body).toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
  });

  it('lists what an installed package contributes', async () => {
    const created = await request(app).post('/api/config/plugins/entry').send({ spec: makePackage() }).expect(200);

    const { body } = await request(app).get(`/api/config/plugins/entry/${encodeURIComponent(created.body.id)}/contributions`).expect(200);

    expect(body).toMatchObject({ installed: true });
    expect(body.extensions).toEqual([expect.objectContaining({ name: 'hello', enabled: true })]);
    expect(body.skills).toEqual([expect.objectContaining({ name: 'demo-skill', description: 'A demo skill' })]);
    expect(body.prompts).toEqual([]);
  });
});
