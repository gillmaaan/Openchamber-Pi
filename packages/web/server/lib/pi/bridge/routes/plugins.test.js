import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPiPackages } from '../../packages.js';
import { createPiCliRunner } from '../../packages-cli.js';
import { createPiFixture } from '../../test-support/pi-fixture.js';
import { createBridgeHttpServer } from '../http.js';
import { createPluginBridgeRoutes } from './plugins.js';

// `/api/plugin` in the OpenCode dialect over real Pi packages. The registry
// answers are injected; the only network address in reach is an unreachable
// loopback port.

const PASSWORD = 'pw';
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

let fixture;
let initialSettings;
let trusted;
let registry;
let changes;
let bridge;
let base;

const settingsFile = () => path.join(fixture.agentDir, 'settings.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const makePackage = (name = 'demo-pkg') => {
  const root = path.join(fixture.root, name);
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'extensions', 'hello.js'), 'export default function () {}\n');
  return root;
};

const installNpm = (name, version) => {
  const target = path.join(fixture.agentDir, 'npm', 'node_modules', ...name.split('/'));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version }));
};

const call = (method, route, body, headers = {}) => fetch(`${base}${route}`, {
  method,
  headers: { authorization: auth, 'x-opencode-directory': encodeURIComponent(fixture.project), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeAll(() => {
  fixture = createPiFixture({ mockPort: 9 });
  initialSettings = fs.readFileSync(settingsFile(), 'utf8');
});
afterAll(() => fixture.dispose());

beforeEach(async () => {
  trusted = new Set([fixture.project]);
  changes = [];
  registry = async () => ({ status: 404, body: null });
  const packages = createPiPackages({
    getAgentDir: () => fixture.agentDir,
    runPi: createPiCliRunner({ baseEnv: { ...fixture.env, npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' } }),
    isTrusted: async (directory) => trusted.has(directory),
    fetchRegistry: (url, options) => registry(url, options),
    resolveRegistryRequest: (name) => ({ url: `https://registry.test/${encodeURIComponent(name).replace(/^%40/i, '@')}`, headers: {} }),
  });
  bridge = createBridgeHttpServer({
    password: PASSWORD,
    routes: createPluginBridgeRoutes({
      packages,
      getDefaultDirectory: () => fixture.project,
      readSettings: async () => ({ agentMemoryToolEnabled: true }),
      onChanged: (change) => changes.push(change),
    }),
  });
  const address = await bridge.listen();
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await bridge.close();
  fs.rmSync(settingsFile(), { force: true });
  fs.writeFileSync(settingsFile(), initialSettings);
  for (const name of ['npm', 'extensions', 'trust.json']) fs.rmSync(path.join(fixture.agentDir, name), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.project, '.pi'), { recursive: true, force: true });
});

const inventory = async (route = '/api/plugin', method = 'GET', body) => {
  const response = await call(method, route, body);
  expect(response.status).toBe(200);
  return response.json();
};

describe('GET /api/plugin', () => {
  it('answers the managed built-ins and nothing else for a fresh install', async () => {
    const { location, data } = await inventory();
    expect(location).toEqual({ directory: fixture.project });
    expect(data.map((row) => row.id)).toEqual(['openchamber.managed-tools', 'openchamber.gate']);
    expect(data.every((row) => row.source.type === 'builtin' && row.state.status === 'active' && row.features.server === true)).toBe(true);
  });

  it('lists packages and extension files with the target string the page matches on', async () => {
    const root = makePackage();
    fs.writeFileSync(settingsFile(), JSON.stringify({
      packages: [path.relative(fixture.agentDir, root), 'npm:installed-one@1.0.0', 'npm:left-behind', 'git:github.com/user/repo', { source: 'npm:off', skills: [], extensions: [], prompts: [], themes: [] }],
    }));
    installNpm('installed-one', '1.0.1');
    installNpm('off', '1.0.0');
    fs.mkdirSync(path.join(fixture.agentDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, 'extensions', 'greet.js'), 'export default () => {};\n');

    const { data } = await inventory();
    const byTarget = (target) => data.find((row) => row.source.target === target);

    expect(data.find((row) => row.source.type === 'local' && row.source.path === root)).toMatchObject({ state: { status: 'active' }, features: { server: true } });
    expect(byTarget('npm:installed-one@1.0.0')).toEqual({ id: 'pi.package:user:npm:installed-one@1.0.0', source: { type: 'package', target: 'npm:installed-one@1.0.0', version: '1.0.1' }, features: { server: true }, state: { status: 'active' } });
    expect(byTarget('npm:left-behind')).toMatchObject({ state: { status: 'failed', error: expect.stringContaining('Not installed') } });
    expect(byTarget('npm:off')).toBeUndefined();
    expect(data.find((row) => row.source.path === path.join(fixture.agentDir, 'extensions', 'greet.js'))).toMatchObject({ state: { status: 'active' } });
  });

  it('says a project\'s packages are not loaded when the project is not trusted', async () => {
    fs.mkdirSync(path.join(fixture.project, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(fixture.project, '.pi', 'settings.json'), JSON.stringify({ packages: ['npm:project-pkg'] }));
    trusted.clear();

    const { data } = await inventory();

    expect(data.find((row) => row.source.target === 'npm:project-pkg')).toMatchObject({
      state: { status: 'failed', error: expect.stringContaining('not a trusted project') },
    });
  });

  it('is a tagged 404 for a folder that does not exist and a 401 without the password', async () => {
    const missing = await call('GET', '/api/plugin', undefined, { 'x-opencode-directory': encodeURIComponent(path.join(fixture.root, 'missing')) });
    expect(missing.status).toBe(404);
    expect((await missing.json())._tag).toBe('LocationNotFoundError');
    expect((await fetch(`${base}/api/plugin`)).status).toBe(401);
  });
});

describe('POST /api/plugin/check', () => {
  it('flags the package that has a newer release and no other', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:floating', 'npm:pinned@1.0.0', 'npm:flaky'] }));
    installNpm('floating', '1.0.0');
    installNpm('pinned', '1.0.0');
    installNpm('flaky', '1.0.0');
    registry = async (url) => {
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      if (name === 'flaky') throw new Error('connect ECONNREFUSED');
      return { status: 200, body: { 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': {} } } };
    };

    const before = await inventory();
    expect(before.data.some((row) => row.source.outdated)).toBe(false);

    const { data } = await inventory('/api/plugin/check', 'POST', {});

    const flagged = data.filter((row) => row.source.outdated).map((row) => row.source.target);
    expect(flagged).toEqual(['npm:floating']);
    expect(data.find((row) => row.source.target === 'npm:flaky').source.outdated).toBeUndefined();
  });

  it('checks one target when asked to, and rejects a target that is not a string', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:one', 'npm:two'] }));
    installNpm('one', '1.0.0');
    installNpm('two', '1.0.0');
    const asked = [];
    registry = async (url) => { asked.push(decodeURIComponent(new URL(url).pathname.slice(1))); return { status: 200, body: { 'dist-tags': { latest: '2.0.0' }, versions: {} } }; };

    const { data } = await inventory('/api/plugin/check', 'POST', { target: 'npm:two' });

    expect(asked).toEqual(['two']);
    expect(data.filter((row) => row.source.outdated).map((row) => row.source.target)).toEqual(['npm:two']);
    const bad = await call('POST', '/api/plugin/check', { target: 3 });
    expect(bad.status).toBe(400);
    expect((await bad.json())._tag).toBe('InvalidRequestError');
  });
});

describe('POST /api/plugin/update', () => {
  it('updates a package by its target and answers 204', async () => {
    // A pinned release is not moved, so `pi update` needs no network.
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:pinned-pkg@1.0.0'] }));
    installNpm('pinned-pkg', '1.0.0');

    const response = await call('POST', '/api/plugin/update', { targets: ['npm:pinned-pkg@1.0.0'] });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(changes).toEqual([{ directory: fixture.project }]);
    expect(readJson(settingsFile()).packages).toEqual(['npm:pinned-pkg@1.0.0']);
  });

  it('rejects a body without targets, and a target nothing matches', async () => {
    for (const body of [{}, { targets: [] }, { targets: [1] }, { targets: [''] }]) {
      const response = await call('POST', '/api/plugin/update', body);
      expect(response.status).toBe(400);
      expect((await response.json())._tag).toBe('InvalidRequestError');
    }
    const unknown = await call('POST', '/api/plugin/update', { targets: ['npm:not-configured'] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toContain('npm:not-configured');
    expect(changes).toEqual([]);
  });

  it('answers 503 with the reason when Pi cannot update, and announces nothing', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ packages: ['npm:left-behind'] }));

    const response = await call('POST', '/api/plugin/update', { targets: ['npm:left-behind'] });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body._tag).toBe('ServiceUnavailableError');
    expect(body.message).toContain('ECONNREFUSED');
    expect(changes).toEqual([]);
  });
});
