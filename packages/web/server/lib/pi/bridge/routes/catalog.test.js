// Contract tests of the catalog routes, through the bridge's HTTP server on a
// loopback port and an isolated Pi installation (its own agent directory and
// HOME, one custom provider served by the mock OpenAI server).
//
// Three checks per route:
// - the key paths and envelope equal a response captured from OpenCode 2.2.6
//   (`../fixtures`), apart from deviations the test names;
// - the body decodes with OpenCode's own schema (`@opencode/schema`);
// - the unhappy paths: a missing folder, an unknown agent, corrupt files, a
//   missing `mcp.json`, a malformed `SKILL.md`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPiCatalog } from '../../catalog.js';
import { createBridgeHttpServer } from '../http.js';
import { startMockOpenAi } from '../../test-support/mock-openai.js';
import { createPiFixture } from '../../test-support/pi-fixture.js';
import { createCatalogRoutes, readPiVersion, WIRE_VERSION } from './catalog.js';
import { loadOpencodeSchemas } from './test-support/opencode-schema.js';
import { expectShape } from './test-support/shape.js';

const PASSWORD = 'correct horse';
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const FIXTURES = new URL('../fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));

// What a developer's own environment must not leak into the provider list.
const PROVIDER_ENVIRONMENT = /(_API_KEY|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_SESSION_TOKEN)$|^(AWS_|AZURE_|CLOUDFLARE_|GOOGLE_|COPILOT_|ANTHROPIC_|VERTEX_)/;

let schemas;
let mock;
let savedEnvironment;
let isolatedHome;
const bridges = [];

beforeAll(async () => {
  savedEnvironment = {};
  for (const name of Object.keys(process.env)) {
    if (PROVIDER_ENVIRONMENT.test(name)) {
      savedEnvironment[name] = process.env[name];
      delete process.env[name];
    }
  }
  savedEnvironment.HOME = process.env.HOME;
  // Pi looks for Google application-default credentials under the real home.
  isolatedHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-catalog-home-'));
  process.env.HOME = isolatedHome;
  schemas = await loadOpencodeSchemas();
  mock = await startMockOpenAi();
});

afterAll(async () => {
  await mock.close();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();

const makeRepository = (root, name = 'repo') => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync(directory);
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

const writeText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/**
 * A bridge over a fresh Pi installation. `prepare(fixture)` writes extra files
 * before the first request; `deps(fixture)` adds or replaces route dependencies.
 */
const startBridge = async ({ settings = {}, prepare, deps } = {}) => {
  const pi = createPiFixture({ mockPort: mock.port, extraSettings: { defaultThinkingLevel: undefined, ...settings } });
  prepare?.(pi);
  const logs = [];
  const routeDeps = {
    catalog: createPiCatalog({ getAgentDir: () => pi.agentDir }),
    getDefaultDirectory: () => pi.project,
    getAgentDir: () => pi.agentDir,
    listKnownDirectories: () => [],
    getServerInfo: () => ({ pid: 4242, hostname: 'host.local', urls: ['http://127.0.0.1:4096'], tmp: path.join(pi.root, 'tmp') }),
    getHomeDir: () => pi.home,
    getPlanDirectory: () => '/work/home/.opencode/plan',
    log: (message) => logs.push(message),
    ...deps?.(pi),
  };
  const server = createBridgeHttpServer({ password: PASSWORD, routes: createCatalogRoutes(routeDeps) });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;

  const get = async (route, { directory = pi.project, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: {
        authorization: AUTHORIZATION,
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
        ...headers,
      },
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };

  const bridge = {
    pi,
    logs,
    get,
    base,
    close: async () => {
      await server.close();
      pi.dispose();
    },
  };
  bridges.push(bridge);
  return bridge;
};

const locationOf = (bridge, directory = bridge.pi.project) => ({ directory });

describe('server facts', () => {
  let bridge;
  beforeAll(async () => { bridge = await startBridge(); });

  it('serves info as a bare body on the wire version, with the Pi version beside it', async () => {
    const { status, body, headers } = await bridge.get('/api/info', { directory: null });

    expect(status).toBe(200);
    expect(headers.get('content-type')).toBe('application/json');
    expect(WIRE_VERSION).toBe('2.2.6');
    expect(body).toMatchObject({ version: '2.2.6', pid: 4242, hostname: 'host.local', urls: ['http://127.0.0.1:4096'] });
    expect(body.paths.tmp).toBe(path.join(bridge.pi.root, 'tmp'));
    expectShape(body, fixture('info'), { extra: ['agent', 'agent.name', 'agent.version'] });

    const sdk = await import('@earendil-works/pi-coding-agent');
    expect(body.agent).toEqual({ name: 'pi', version: sdk.VERSION });
    expect(readPiVersion()).toBe(sdk.VERSION);
    // The web server's compatibility gate: major 2 and at least 2.2.4.
    expect(body.version).toMatch(/^2\.2\.([4-9]|\d{2,})$/);
  });

  it('answers the location of the requested folder, falling back to the default one', async () => {
    const asked = await bridge.get('/api/location');
    expect(asked.body).toEqual({
      directory: bridge.pi.project,
      project: { id: expect.stringMatching(/^[0-9a-f]{40}$/), directory: bridge.pi.project, canonical: bridge.pi.project },
    });
    expectShape(asked.body, fixture('location'));
    schemas.location(asked.body);

    const fallback = await bridge.get('/api/location', { directory: null });
    expect(fallback.body.directory).toBe(bridge.pi.project);
  });

  it('answers a folder that does not exist with a tagged 404 and no data', async () => {
    const gone = path.join(bridge.pi.root, 'does-not-exist');
    for (const route of ['/api/location', '/api/model', '/api/skill', '/api/vcs', '/api/config']) {
      const { status, body } = await bridge.get(route, { directory: gone });
      expect(status, route).toBe(404);
      expect(body, route).toEqual({ _tag: 'LocationNotFoundError', location: { directory: gone }, message: `Location not found: ${gone}` });
      expectShape(body, fixture('location-not-found'));
    }
  });

  it('keeps the unknown-route and auth behavior of the transport', async () => {
    const unknown = await fetch(`${bridge.base}/api/nope`, { headers: { authorization: AUTHORIZATION } });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toBeNull();

    for (const route of ['/api/credential', '/api/config', '/api/model']) {
      const denied = await fetch(`${bridge.base}${route}`);
      expect(denied.status, route).toBe(401);
      expect(await denied.json()).toEqual({ _tag: 'UnauthorizedError', message: 'Authentication required' });
    }
  });

  it('lists the shells of /etc/shells as a bare array', async () => {
    const { body } = await bridge.get('/api/config/shell');
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expectShape(body, fixture('config-shell'));
    schemas.configShell(body);
    for (const shell of body) expect(fs.existsSync(shell.path)).toBe(true);
  });

  it('answers the empty lists the coordinator has not filled yet', async () => {
    const shells = await bridge.get('/api/shell');
    expect(shells.body).toEqual({ location: locationOf(bridge), data: [] });
    const saved = await bridge.get('/api/permission/saved', { directory: null });
    expect(saved.body).toEqual(fixture('permission-saved'));
  });
});

describe('projects and version control', () => {
  let bridge;
  let root;
  let repository;
  let worktree;
  let plain;

  beforeAll(async () => {
    bridge = await startBridge({
      deps: (pi) => {
        root = pi.root;
        repository = makeRepository(root);
        fs.mkdirSync(path.join(repository, 'packages', 'app'), { recursive: true });
        git(repository, 'branch', 'feature-x');
        git(repository, 'branch', 'other');
        worktree = path.join(root, 'repo-wt');
        git(repository, 'worktree', 'add', '-q', worktree, '-b', 'wt-branch');
        worktree = fs.realpathSync(worktree);
        plain = pi.project;
        return {
          listKnownDirectories: () => [
            repository,
            path.join(repository, 'packages', 'app'),
            worktree,
            { directory: plain, time: { created: 1000, updated: 9_000_000_000_000, active: 2000 } },
            'relative/ignored',
          ],
        };
      },
    });
  });

  it('groups the known folders by project and lists a linked worktree as a sandbox', async () => {
    const { status, body } = await bridge.get('/api/project', { directory: null });

    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    const repo = body.find((project) => project.canonical === repository);
    expect(repo).toMatchObject({ vcs: 'git', sandboxes: [worktree] });
    expect(repo.time.created).toBeLessThanOrEqual(repo.time.updated);
    const folder = body.find((project) => project.canonical === plain);
    expect(folder).toEqual({ id: expect.any(String), canonical: plain, time: { created: 1000, updated: 9_000_000_000_000, active: 2000 }, sandboxes: [] });
    expect(body[0].canonical).toBe(plain); // newest update first
    expect(body.map((project) => project.time.updated)).toEqual([...body.map((project) => project.time.updated)].sort((a, b) => b - a));
    expectShape(body, fixture('project'));
    schemas.project(body);
  });

  it('puts a worktree in its repository\'s project, with the worktree as directory and the checkout as canonical', async () => {
    const inRepo = await bridge.get('/api/location', { directory: repository });
    const inWorktree = await bridge.get('/api/location', { directory: worktree });

    expect(inWorktree.body.project.id).toBe(inRepo.body.project.id);
    expect(inWorktree.body.project).toMatchObject({ directory: worktree, canonical: repository });
    schemas.location(inWorktree.body);
  });

  it('answers the current and default branch of a repository', async () => {
    const { body } = await bridge.get('/api/vcs', { directory: repository });

    expect(body).toEqual({ location: { directory: repository }, data: { provider: 'git', branch: { current: 'main', default: 'main' } } });
    expectShape(body, fixture('vcs'));
    schemas.vcs(body.data);

    const sub = await bridge.get('/api/vcs', { directory: path.join(repository, 'packages', 'app') });
    expect(sub.body.data.branch.current).toBe('main');
  });

  it('follows origin/HEAD for the default branch and leaves out the current one on a detached HEAD', async () => {
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', repository, clone);
    git(clone, 'checkout', '-q', '-b', 'topic');
    const cloned = await bridge.get('/api/vcs', { directory: clone });
    expect(cloned.body.data.branch).toEqual({ current: 'topic', default: 'main' });

    git(clone, 'checkout', '-q', '--detach');
    const detached = await bridge.get('/api/vcs', { directory: clone });
    expect(detached.body.data.branch).toEqual({ default: 'main' });
    schemas.vcs(detached.body.data);
  });

  it('answers a folder outside any repository without a provider, as OpenCode does', async () => {
    const vcs = await bridge.get('/api/vcs', { directory: plain });
    expect(vcs.body).toEqual({ location: { directory: plain }, data: { branch: {} } });
    expectShape(vcs.body, fixture('vcs-nongit'));

    const branches = await bridge.get('/api/vcs/branch', { directory: plain });
    expect(branches.body).toEqual({ location: { directory: plain }, data: [] });
    expectShape(branches.body, fixture('vcs-branch-nongit'));
  });

  it('lists the local branches, filtered by search and limit', async () => {
    const all = await bridge.get('/api/vcs/branch', { directory: repository });
    expect(all.body.data).toEqual(['feature-x', 'main', 'other', 'wt-branch']);
    expectShape(all.body, fixture('vcs-branch'));
    schemas.branches(all.body.data);

    expect((await bridge.get('/api/vcs/branch?search=OTH', { directory: repository })).body.data).toEqual(['other']);
    expect((await bridge.get('/api/vcs/branch?limit=2', { directory: repository })).body.data).toEqual(['feature-x', 'main']);
    const invalid = await bridge.get('/api/vcs/branch?limit=0', { directory: repository });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ _tag: 'InvalidRequestError', kind: 'Query', field: 'limit', message: expect.any(String) });
  });

  it('serves what it knows when git cannot run, and says so in the log', async () => {
    const broken = await startBridge({
      deps: () => ({
        runGit: async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); },
      }),
    });
    makeRepository(broken.pi.root, 'project-with-git');
    const directory = path.join(broken.pi.root, 'project-with-git');

    const { status, body } = await broken.get('/api/vcs', { directory });

    expect(status).toBe(200);
    expect(body.data).toEqual({ provider: 'git', branch: {} });
    expect(broken.logs.some((message) => message.includes('spawn git ENOENT'))).toBe(true);
  });
});

describe('models, providers and the default', () => {
  it('serves the usable models in ModelInfo shape, with the thinking levels as variants', async () => {
    const bridge = await startBridge();
    const { status, body } = await bridge.get('/api/model');

    expect(status).toBe(200);
    expect(body.location).toEqual(locationOf(bridge));
    expect(body.data).toEqual([{
      id: 'mock-model',
      modelID: 'mock-model',
      providerID: 'mock',
      name: 'Mock Model',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${mock.port}/v1` },
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      variants: ['off', 'minimal', 'low', 'medium', 'high'].map((id) => ({ id, settings: { reasoningEffort: id } })),
      time: { released: 0 },
      cost: [],
      status: 'active',
      enabled: true,
      limit: { context: 32000, output: 4096 },
    }]);
    expectShape(body, fixture('model'), { missing: ['data[].settings.apiKey'] });
    schemas.model(body.data);
  });

  it('gives a model that cannot reason no variants and one that cannot switch thinking off no off', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(path.join(pi.agentDir, 'models.json'), {
        providers: {
          mock: {
            name: 'Mock',
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            api: 'openai-completions',
            apiKey: 'k',
            models: [
              { id: 'plain', name: 'Plain', input: ['text'] },
              { id: 'always-thinks', name: 'Always thinks', reasoning: true, thinkingLevelMap: { off: null, xhigh: 'xhigh' } },
              { id: 'seen', name: 'Seen', input: ['text', 'image'] },
            ],
          },
        },
      }),
    });
    const { body } = await bridge.get('/api/model');
    const byId = Object.fromEntries(body.data.map((model) => [model.id, model]));

    expect(byId.plain.variants).toEqual([]);
    expect(byId['always-thinks'].variants.map((variant) => variant.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(byId.seen.capabilities.input).toEqual(['text', 'image']);
    schemas.model(body.data);
  });

  it('prices a model per million tokens with its context tiers, and serves [] when no price is set', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(path.join(pi.agentDir, 'models.json'), {
        providers: {
          mock: {
            name: 'Mock',
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            api: 'openai-completions',
            apiKey: 'k',
            models: [
              {
                id: 'priced',
                name: 'Priced',
                reasoning: true,
                cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, tiers: [{ input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5, inputTokensAbove: 272000 }] },
              },
              { id: 'free', name: 'Free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      }),
    });
    const { body } = await bridge.get('/api/model');
    const priced = body.data.find((model) => model.id === 'priced');

    expect(priced.cost).toEqual([
      { input: 1, output: 5, cache: { read: 0.05, write: 1.25 } },
      { tier: { type: 'context', size: 272000 }, input: 2, output: 7.5, cache: { read: 0.1, write: 2.5 } },
    ]);
    expect(body.data.find((model) => model.id === 'free').cost).toEqual([]);
    expectShape({ location: body.location, data: [priced] }, fixture('model-tiered'), {
      missing: [
        'data[].capabilities.temperature',
        'data[].family',
        'data[].limit.input',
        'data[].type',
        'data[].variants[].settings.include',
        'data[].variants[].settings.include[]',
        'data[].variants[].settings.reasoningSummary',
      ],
    });
    schemas.model(body.data);
  });

  it('serves chat models only by default and adds image models when asked, matching types exactly', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(path.join(pi.agentDir, 'auth.json'), { openrouter: { type: 'api_key', key: 'sk-or-test' } }),
    });

    const chat = (await bridge.get('/api/model')).body.data;
    expect(chat.length).toBeGreaterThan(10);
    expect(chat.every((model) => model.type === undefined && model.capabilities.output.join() === 'text')).toBe(true);

    const both = (await bridge.get('/api/model?types=chat&types=image')).body.data;
    const images = both.filter((model) => model.type === 'image');
    expect(images.length).toBeGreaterThan(0);
    expect(images[0]).toMatchObject({ providerID: 'openrouter', capabilities: { tools: false, output: ['image'] }, variants: [], limit: { context: 0, output: 0 } });
    expect(both.length).toBe(chat.length + images.length);

    const onlyImages = (await bridge.get('/api/model?types=image')).body.data;
    expect(onlyImages.map((model) => model.id)).toEqual(images.map((model) => model.id));

    // Golden 01: the comma form names no type and matches nothing.
    expect((await bridge.get('/api/model?types=chat,image')).body.data).toEqual([]);
    expect((await bridge.get('/api/model?types=classifier')).body.data).toEqual([]);
    schemas.model(both);
  });

  it('serves Pi\'s default model, then falls back to the first usable one, then to null', async () => {
    const bridge = await startBridge();
    const configured = await bridge.get('/api/model/default');
    expect(configured.body.location).toEqual(locationOf(bridge));
    expect(configured.body.data).toMatchObject({ id: 'mock-model', providerID: 'mock' });
    expectShape(configured.body, fixture('model-default'), { missing: ['data.settings.apiKey'] });
    schemas.modelOne(configured.body.data);

    writeJson(path.join(bridge.pi.agentDir, 'settings.json'), { defaultProvider: 'mock', defaultModel: 'not-there' });
    expect((await bridge.get('/api/model/default')).body.data.id).toBe('mock-model');

    writeJson(path.join(bridge.pi.project, '.pi', 'settings.json'), { defaultProvider: 'mock', defaultModel: 'other' });
    expect((await bridge.get('/api/model/default')).body.data.id).toBe('mock-model');

    const none = await startBridge({ prepare: (pi) => fs.rmSync(path.join(pi.agentDir, 'models.json')) });
    const empty = await none.get('/api/model/default');
    expect(empty.body).toEqual({ location: locationOf(none), data: null });
    expectShape(empty.body, fixture('model-default-null'));
    expect((await none.get('/api/model')).body).toEqual({ location: locationOf(none), data: [] });
    expectShape((await none.get('/api/model')).body, fixture('model-empty'));
  });

  it('takes the default from the project settings over the global ones', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(path.join(pi.agentDir, 'models.json'), {
        providers: {
          mock: {
            name: 'Mock',
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            api: 'openai-completions',
            apiKey: 'k',
            models: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
          },
        },
      }),
      settings: { defaultProvider: 'mock', defaultModel: 'first' },
    });
    expect((await bridge.get('/api/model/default')).body.data.id).toBe('first');

    writeJson(path.join(bridge.pi.project, '.pi', 'settings.json'), { defaultProvider: 'mock', defaultModel: 'second' });
    expect((await bridge.get('/api/model/default')).body.data.id).toBe('second');
  });

  it('lists a provider that has a key in models.json, without the key and with its base URL', async () => {
    const bridge = await startBridge();
    const { body } = await bridge.get('/api/provider');

    expect(body.data).toEqual([{
      id: 'mock',
      name: 'Mock',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: '********' },
    }]);
    expect(JSON.stringify(body)).not.toContain('test-key');
    expectShape(body, fixture('provider'));
    schemas.provider(body.data);
  });

  it('lists providers that have a stored login or an environment key, and no others', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(path.join(pi.agentDir, 'auth.json'), {
        groq: { type: 'api_key', key: 'gsk-test' },
        anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 },
      }),
    });
    process.env.XAI_API_KEY = 'xai-test';
    try {
      const { body } = await bridge.get('/api/provider');
      const byId = Object.fromEntries(body.data.map((provider) => [provider.id, provider]));

      expect(Object.keys(byId).sort()).toEqual(['anthropic', 'groq', 'mock', 'xai']);
      expect(byId.groq).toMatchObject({ activation: 'auto', package: '@opencode/ai/providers/openai-compatible' });
      expect(byId.groq.settings.apiKey).toBeUndefined();
      expect(byId.anthropic.package).toBe('@opencode/ai/providers/anthropic');
      expectShape({ location: body.location, data: [byId.anthropic] }, fixture('provider-credentialed'), { missing: ['data[].integrationID', 'data[].settings.transport'] });
      schemas.provider(body.data);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it('names an environment reference by its variable and masks every other key', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        process.env.MOCK_PROVIDER_KEY = 'from-env';
        writeJson(path.join(pi.agentDir, 'models.json'), {
          providers: {
            mock: { name: 'Mock', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: '$MOCK_PROVIDER_KEY', models: [{ id: 'm' }] },
          },
        });
      },
    });
    try {
      const { body } = await bridge.get('/api/provider');
      expect(body.data.find((provider) => provider.id === 'mock').settings.apiKey).toBe('{env:MOCK_PROVIDER_KEY}');
      const config = (await bridge.get('/api/config')).body;
      expect(JSON.stringify(config)).not.toContain('from-env');
      expect(config[0].info.providers.mock.env).toEqual(['MOCK_PROVIDER_KEY']);
    } finally {
      delete process.env.MOCK_PROVIDER_KEY;
    }
  });
});

describe('a Pi installation with damaged files', () => {
  it('keeps Pi\'s built-in providers when models.json cannot be parsed, and logs the reason once', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'models.json'), '{ "providers": { oops');
        writeJson(path.join(pi.agentDir, 'auth.json'), { groq: { type: 'api_key', key: 'gsk-test' } });
      },
    });

    const first = await bridge.get('/api/model');
    const second = await bridge.get('/api/model');

    expect(first.status).toBe(200);
    expect(first.body.data.length).toBeGreaterThan(0);
    expect(first.body.data.every((model) => model.providerID === 'groq')).toBe(true);
    expect(second.status).toBe(200);
    const complaints = bridge.logs.filter((message) => message.includes('models.json'));
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain('Failed to parse models.json');

    const config = await bridge.get('/api/config');
    expect(config.status).toBe(200);
    expect(config.body.filter((entry) => entry.type === 'document' && entry.path.endsWith('models.json'))).toEqual([]);
    expect((await bridge.get('/api/provider')).body.data.map((provider) => provider.id)).toEqual(['groq']);
  });

  it('answers 503 instead of an empty catalog when auth.json cannot be parsed', async () => {
    const bridge = await startBridge({ prepare: (pi) => writeText(path.join(pi.agentDir, 'auth.json'), '{ not json') });

    for (const route of ['/api/model', '/api/model/default', '/api/provider', '/api/integration']) {
      const { status, body } = await bridge.get(route);
      expect(status, route).toBe(503);
      expect(body, route).toEqual({ _tag: 'ServiceUnavailableError', service: 'pi', message: expect.stringContaining('Pi\'s model catalog is unavailable') });
    }
    const credentials = await bridge.get('/api/credential', { directory: null });
    expect(credentials.status).toBe(503);
    expect(credentials.body._tag).toBe('ServiceUnavailableError');
  });

  it('treats a corrupt settings.json as absent, falls back to the first model, and logs it', async () => {
    const bridge = await startBridge({ prepare: (pi) => writeText(path.join(pi.agentDir, 'settings.json'), '[1,2') });

    const defaults = await bridge.get('/api/model/default');

    expect(defaults.status).toBe(200);
    expect(defaults.body.data.id).toBe('mock-model');
    expect(bridge.logs.some((message) => message.includes('settings.json'))).toBe(true);
  });
});

describe('agents', () => {
  it('serves the built-in profiles exactly as OpenCode lists them', async () => {
    const bridge = await startBridge();
    const { status, body } = await bridge.get('/api/agent');

    expect(status).toBe(200);
    expect(body).toEqual({ location: locationOf(bridge), data: fixture('agent').data });
    expect(body.data.map((agent) => agent.id)).toEqual(['build', 'general', 'explore', 'compaction', 'title', 'summary', 'plan']);
    schemas.agent(body.data);

    const build = await bridge.get('/api/agent/build');
    expect(build.body).toEqual({ location: locationOf(bridge), data: fixture('agent-build').data });
  });

  it('answers an unknown agent with AgentNotFoundError', async () => {
    const bridge = await startBridge();
    const { status, body } = await bridge.get('/api/agent/nope');

    expect(status).toBe(404);
    expect(body).toEqual(fixture('agent-missing'));
  });

  it('merges the profiles of the agent store over the built-in ones', async () => {
    const reviewer = {
      id: 'reviewer',
      name: 'Reviewer',
      mode: 'primary',
      hidden: false,
      description: 'Reviews changes',
      model: { id: 'mock-model', providerID: 'mock', variant: 'low' },
      request: { settings: {}, headers: {}, body: {} },
      permissions: [{ action: '*', resource: '*', effect: 'ask' }],
    };
    const seen = [];
    const bridge = await startBridge({
      deps: () => ({
        agentStore: {
          list: async (directory) => {
            seen.push(directory);
            return [reviewer, { id: 'plan', name: 'Plan', description: 'My plan', permissions: [] }, { name: 'no id' }];
          },
        },
      }),
    });

    const { body } = await bridge.get('/api/agent');

    expect(seen).toEqual([bridge.pi.project]);
    expect(body.data.map((agent) => agent.id)).toEqual(['build', 'general', 'explore', 'compaction', 'title', 'summary', 'plan', 'reviewer']);
    expect(body.data.find((agent) => agent.id === 'reviewer')).toEqual(reviewer);
    // A profile with a built-in's id replaces it, with the required fields filled in.
    expect(body.data.find((agent) => agent.id === 'plan')).toEqual({
      id: 'plan', name: 'Plan', description: 'My plan', mode: 'primary', hidden: false, permissions: [], request: { settings: {}, headers: {}, body: {} },
    });
    schemas.agent(body.data);

    const one = await bridge.get('/api/agent/reviewer');
    expect(one.body.data).toEqual(reviewer);
  });

  it('answers 503 when the agent store fails instead of hiding the user\'s profiles', async () => {
    const bridge = await startBridge({
      deps: () => ({ agentStore: { list: async () => { throw new Error('disk gone'); } } }),
    });

    for (const route of ['/api/agent', '/api/agent/build']) {
      const { status, body } = await bridge.get(route);
      expect(status, route).toBe(503);
      expect(body, route).toEqual({ _tag: 'ServiceUnavailableError', service: 'agents', message: 'The agent profiles are unavailable: disk gone' });
    }
  });

  it('keeps the plan agent writable only in the plan directory it is given', async () => {
    const bridge = await startBridge({ deps: () => ({ getPlanDirectory: () => '/plans/here' }) });
    const plan = (await bridge.get('/api/agent/plan')).body.data;
    expect(plan.permissions).toContainEqual({ action: 'edit', resource: '/plans/here/*', effect: 'allow' });
  });
});

describe('commands', () => {
  it('lists the built-in commands and the prompt templates of Pi, project templates first', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'prompts', 'greet.md'), '---\ndescription: Greets someone\nargument-hint: "[name]"\n---\nSay hello to $ARGUMENTS\n');
        writeText(path.join(pi.agentDir, 'prompts', 'summarize.md'), 'Summarize the open changes in two sentences, then list the files.\nMore text.');
        writeText(path.join(pi.agentDir, 'prompts', 'nested', 'deep.md'), '---\ndescription: Nested command\n---\nPLAIN nested $ARGUMENTS');
        writeText(path.join(pi.agentDir, 'prompts', 'notes.txt'), 'not markdown');
        writeText(path.join(pi.project, '.pi', 'prompts', 'greet.md'), '---\ndescription: Project greeting\n---\nHi');
        writeText(path.join(pi.project, '.pi', 'prompts', 'ship.md'), '---\ndescription: Ship it\n---\nShip');
      },
    });

    const { body } = await bridge.get('/api/command');

    expect(body.data).toEqual([
      { name: 'init', description: 'guided AGENTS.md setup' },
      { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
      { name: 'goal', description: 'keep working until an objective is met [pause|resume|clear]' },
      { name: 'greet', description: 'Project greeting' },
      { name: 'ship', description: 'Ship it' },
      { name: 'nested/deep', description: 'Nested command' },
      { name: 'summarize', description: 'Summarize the open changes in two sentences, then list the files.'.slice(0, 60) + '...' },
    ]);
    expect(body.location).toEqual(locationOf(bridge));
    schemas.command(body.data);
  });

  it('matches the captured list when the templates are the ones OpenCode had configured', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeText(path.join(pi.agentDir, 'prompts', 'greet.md'), '---\ndescription: Greets someone\n---\nSay hello to $ARGUMENTS [PLAIN]'),
    });
    const { body } = await bridge.get('/api/command');
    expect(body).toEqual({ location: locationOf(bridge), data: fixture('command').data });
  });

  it('lets a prompt template replace the built-in command of the same name and skips a template it cannot parse', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'prompts', 'review.md'), '---\ndescription: My review\n---\nReview');
        writeText(path.join(pi.agentDir, 'prompts', 'broken.md'), '---\ndescription: [unclosed\n---\nBody');
        writeText(path.join(pi.agentDir, 'prompts', 'fine.md'), '---\ndescription: Fine\n---\nBody');
      },
    });

    const { body } = await bridge.get('/api/command');

    expect(body.data.find((command) => command.name === 'review')).toEqual({ name: 'review', description: 'My review' });
    expect(body.data.map((command) => command.name)).toEqual(['init', 'review', 'goal', 'fine']);
    expect(bridge.logs.some((message) => message.includes('broken.md'))).toBe(true);
  });
});

describe('skills', () => {
  const skill = (name, description, body = `# ${name}\nDo the thing.`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

  it('lists the skills Pi discovers, from the user, the project and the .agents folders', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'skills', 'pdf-tools', 'SKILL.md'), skill('pdf-tools', 'Work with PDFs'));
        writeText(path.join(pi.home, '.agents', 'skills', 'house-style', 'SKILL.md'), skill('house-style', 'Follow the house style'));
        writeText(path.join(pi.project, '.pi', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploy the app'));
        writeText(path.join(pi.project, '.agents', 'skills', 'testing', 'SKILL.md'), skill('testing', 'Run the tests'));
        writeText(path.join(pi.project, '.agents', 'skills', 'loose.md'), skill('loose', 'A loose file is not a skill here'));
        writeText(path.join(pi.agentDir, 'skills', 'manual', 'SKILL.md'), '---\nname: manual\ndescription: Only when asked\ndisable-model-invocation: true\n---\nBody\n');
      },
    });

    const { body } = await bridge.get('/api/skill');

    expect(body.location).toEqual(locationOf(bridge));
    expect(body.data.map((entry) => entry.id)).toEqual(['deploy', 'testing', 'manual', 'pdf-tools', 'house-style']);
    const pdf = body.data.find((entry) => entry.id === 'pdf-tools');
    expect(pdf).toEqual({
      id: 'pdf-tools',
      name: 'pdf-tools',
      description: 'Work with PDFs',
      path: path.join(bridge.pi.agentDir, 'skills', 'pdf-tools', 'SKILL.md'),
      content: '# pdf-tools\nDo the thing.',
    });
    expect(body.data.find((entry) => entry.id === 'manual').autoinvoke).toBe(false);
    expect(pdf.autoinvoke).toBeUndefined();
    expectShape({ location: body.location, data: [pdf] }, fixture('skill'));
    schemas.skill(body.data);
  });

  it('walks .agents/skills from the folder up to the repository root and no further', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        const repository = makeRepository(pi.root, 'outer');
        writeText(path.join(repository, '.agents', 'skills', 'root-skill', 'SKILL.md'), skill('root-skill', 'At the repository root'));
        writeText(path.join(repository, 'packages', '.agents', 'skills', 'mid-skill', 'SKILL.md'), skill('mid-skill', 'In the middle'));
        writeText(path.join(repository, 'packages', 'app', '.agents', 'skills', 'app-skill', 'SKILL.md'), skill('app-skill', 'In the app'));
        writeText(path.join(pi.root, '.agents', 'skills', 'above-repo', 'SKILL.md'), skill('above-repo', 'Above the repository'));
      },
    });
    const app = path.join(bridge.pi.root, 'outer', 'packages', 'app');

    const { body } = await bridge.get('/api/skill', { directory: app });

    expect(body.data.map((entry) => entry.id)).toEqual(['app-skill', 'mid-skill', 'root-skill']);
  });

  it('skips a malformed SKILL.md and still lists the others', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'skills', 'good', 'SKILL.md'), skill('good', 'A fine skill'));
        writeText(path.join(pi.agentDir, 'skills', 'broken-yaml', 'SKILL.md'), '---\nname: broken\ndescription: [unclosed\n---\nBody\n');
        writeText(path.join(pi.agentDir, 'skills', 'no-description', 'SKILL.md'), '---\nname: no-description\n---\nBody\n');
        writeText(path.join(pi.agentDir, 'skills', 'also-good', 'SKILL.md'), skill('also-good', 'Another fine skill'));
      },
    });

    const { status, body } = await bridge.get('/api/skill');

    expect(status).toBe(200);
    expect(body.data.map((entry) => entry.id).sort()).toEqual(['also-good', 'good']);
    expect(bridge.logs.some((message) => message.includes('broken-yaml'))).toBe(true);
  });

  it('keeps the first skill of a name: project before user', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'skills', 'shared', 'SKILL.md'), skill('shared', 'The user one'));
        writeText(path.join(pi.project, '.pi', 'skills', 'shared', 'SKILL.md'), skill('shared', 'The project one'));
      },
    });

    const { body } = await bridge.get('/api/skill');

    expect(body.data).toHaveLength(1);
    expect(body.data[0].description).toBe('The project one');
  });

  it('leaves the project\'s folders out when the project is not trusted', async () => {
    const asked = [];
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'skills', 'user-skill', 'SKILL.md'), skill('user-skill', 'Always there'));
        writeText(path.join(pi.project, '.pi', 'skills', 'project-skill', 'SKILL.md'), skill('project-skill', 'Needs trust'));
        writeText(path.join(pi.project, '.agents', 'skills', 'agents-skill', 'SKILL.md'), skill('agents-skill', 'Needs trust too'));
        writeText(path.join(pi.project, '.pi', 'prompts', 'project-prompt.md'), 'Needs trust');
        writeJson(path.join(pi.project, '.pi', 'mcp.json'), { mcpServers: { projectOnly: { command: 'x' } } });
        writeJson(path.join(pi.project, '.pi', 'settings.json'), { defaultProvider: 'mock', defaultModel: 'other', packages: ['npm:project-package'] });
      },
      deps: () => ({ isProjectTrusted: async (directory) => { asked.push(directory); return false; } }),
    });

    // Routes that read nothing of the project do not ask whether it is trusted.
    await bridge.get('/api/model');
    await bridge.get('/api/agent');
    await bridge.get('/api/provider');
    expect(asked).toEqual([]);

    expect((await bridge.get('/api/skill')).body.data.map((entry) => entry.id)).toEqual(['user-skill']);
    expect((await bridge.get('/api/command')).body.data.map((entry) => entry.name)).toEqual(['init', 'review', 'goal']);
    expect((await bridge.get('/api/mcp')).body.data).toEqual([]);
    expect((await bridge.get('/api/plugin')).body.data).toEqual([]);
    expect((await bridge.get('/api/model/default')).body.data.id).toBe('mock-model');
    expect((await bridge.get('/api/config')).body.filter((entry) => entry.path?.includes(`${path.sep}.pi${path.sep}`))).toEqual([]);
    expect(asked.every((directory) => directory === bridge.pi.project)).toBe(true);
  });
});

describe('MCP servers', () => {
  it('lists the servers of mcp.json, project entries replacing global ones, without a connection state', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeJson(path.join(pi.agentDir, 'mcp.json'), {
          mcpServers: {
            docs: { url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer secret' } },
            files: { command: 'npx', args: ['-y', 'files-server'], exposure: 'deferred' },
            retired: { command: 'old', enabled: false },
            'bad name!': { command: 'x' },
            notAnObject: 'nope',
          },
        });
        writeJson(path.join(pi.project, '.pi', 'mcp.json'), {
          mcpServers: {
            docs: { enabled: false },
            files: { command: 'node', args: ['local.js'] },
            local: { command: 'node', args: ['project.js'] },
            ghost: { enabled: true },
          },
        });
      },
    });

    const { body } = await bridge.get('/api/mcp');

    expect(body.location).toEqual(locationOf(bridge));
    expect(body.data).toEqual([
      { name: 'docs', status: { status: 'disabled' } },
      { name: 'files', status: { status: 'pending' } },
      { name: 'retired', status: { status: 'disabled' } },
      { name: 'local', status: { status: 'pending' } },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret');
    expectShape(body, fixture('mcp'), { missing: ['data[].integrationID', 'data[].status.error'] });
    schemas.mcp(body.data);
    expect(bridge.logs.some((message) => message.includes('"bad name!"'))).toBe(true);
    expect(bridge.logs.some((message) => message.includes('"ghost"'))).toBe(true);
  });

  it('answers an empty list when there is no mcp.json', async () => {
    const bridge = await startBridge();
    const { status, body } = await bridge.get('/api/mcp');
    expect(status).toBe(200);
    expect(body).toEqual({ location: locationOf(bridge), data: [] });
  });

  it('serves the project\'s servers when the global mcp.json is corrupt, and logs it', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        writeText(path.join(pi.agentDir, 'mcp.json'), '{"mcpServers": ');
        writeJson(path.join(pi.project, '.pi', 'mcp.json'), { mcpServers: { local: { command: 'node' } } });
      },
    });

    const { status, body } = await bridge.get('/api/mcp');

    expect(status).toBe(200);
    expect(body.data).toEqual([{ name: 'local', status: { status: 'pending' } }]);
    expect(bridge.logs.some((message) => message.includes('mcp.json'))).toBe(true);
  });
});

describe('config', () => {
  it('serves models.json and settings.json as documents in the shape OpenCode serves its own', async () => {
    const bridge = await startBridge();
    const { body } = await bridge.get('/api/config', { directory: null });

    const modelsPath = path.join(bridge.pi.agentDir, 'models.json');
    const settingsPath = path.join(bridge.pi.agentDir, 'settings.json');
    expect(body).toEqual([
      {
        type: 'document',
        path: modelsPath,
        info: {
          providers: {
            mock: {
              name: 'Mock',
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: `http://127.0.0.1:${mock.port}/v1` },
              models: {
                'mock-model': {
                  name: 'Mock Model',
                  capabilities: {
                    tools: true,
                    input: ['text'],
                    output: ['text'],
                    reasoning: { supported: true, effort: ['minimal', 'low', 'medium', 'high'] },
                  },
                  limit: { context: 32000, output: 4096 },
                },
              },
            },
          },
        },
      },
      { type: 'document', path: settingsPath, info: { model: { providerID: 'mock', model: 'mock-model' } } },
      { type: 'directory', path: bridge.pi.agentDir },
    ]);
    expect(JSON.stringify(body)).not.toContain('test-key');
    // OpenCode's capture also has a configured command and the literal key; neither comes from Pi's files.
    expectShape(body, fixture('config'), {
      records: ['[].info.providers', '[].info.providers.*.models'],
      missing: [
        '[].info.commands',
        '[].info.commands.greet',
        '[].info.commands.greet.description',
        '[].info.commands.greet.template',
        '[].info.providers.*.settings.apiKey',
      ],
    });
    schemas.config(body);
  });

  it('adds the project settings as a later document and its .pi folder as a directory, and a thinking level as variant', async () => {
    const bridge = await startBridge({ settings: { defaultThinkingLevel: 'high' } });
    writeJson(path.join(bridge.pi.project, '.pi', 'settings.json'), { defaultProvider: 'mock', defaultModel: 'mock-model', defaultThinkingLevel: 'low' });

    const { body } = await bridge.get('/api/config');

    const documents = body.filter((entry) => entry.type === 'document');
    expect(documents.map((entry) => path.basename(path.dirname(entry.path)) + '/' + path.basename(entry.path))).toEqual([
      'agent/models.json',
      'agent/settings.json',
      '.pi/settings.json',
    ]);
    expect(documents[1].info.model).toEqual({ providerID: 'mock', model: 'mock-model', variant: 'high' });
    expect(documents[2].info.model).toEqual({ providerID: 'mock', model: 'mock-model', variant: 'low' });
    expect(body.at(-1)).toEqual({ type: 'directory', path: path.join(bridge.pi.project, '.pi') });
    schemas.config(body);
  });

  it('serves just the agent directory when Pi has no files yet', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        fs.rmSync(path.join(pi.agentDir, 'models.json'));
        fs.rmSync(path.join(pi.agentDir, 'settings.json'));
      },
    });
    const { body } = await bridge.get('/api/config');
    expect(body).toEqual([{ type: 'directory', path: bridge.pi.agentDir }]);
    expectShape(body, fixture('config-empty'));
  });
});

describe('integrations, plugins and credentials', () => {
  const authFile = (pi) => path.join(pi.agentDir, 'auth.json');

  it('lists every Pi provider with its login methods and connections', async () => {
    process.env.XAI_API_KEY = 'xai-test';
    const bridge = await startBridge({
      prepare: (pi) => writeJson(authFile(pi), {
        groq: { type: 'api_key', key: 'gsk-test' },
        anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 },
      }),
    });
    try {
      const { body } = await bridge.get('/api/integration');
      const byId = Object.fromEntries(body.data.map((integration) => [integration.id, integration]));

      expect(body.data.length).toBeGreaterThan(30);
      expect(byId.groq).toEqual({
        id: 'groq',
        name: expect.any(String),
        methods: [{ type: 'key' }],
        connections: [{ type: 'credential', id: 'cred_groq', label: 'default', method: 'key' }],
      });
      expect(byId.anthropic.connections).toEqual([{ type: 'credential', id: 'cred_anthropic', label: 'default', method: 'oauth' }]);
      expect(byId.anthropic.methods).toEqual([
        { type: 'key' },
        { id: 'oauth', type: 'oauth', label: expect.stringContaining('Anthropic') },
      ]);
      expect(byId.xai.connections).toEqual([{ type: 'env', name: 'XAI_API_KEY' }]);
      expect(byId.xai.methods).toContainEqual({ type: 'env', names: ['XAI_API_KEY'] });
      expect(byId.mock.connections).toEqual([]);
      expect(byId.openai.connections).toEqual([]);
      expect(byId.openai.methods).toContainEqual({ id: 'oauth', type: 'oauth', label: 'Sign in with ChatGPT' });
      // OpenCode's captures have no environment connection; the schema has one (`name`).
      expectShape({ location: body.location, data: [byId.anthropic, byId.xai] }, fixture('integration'), { extra: ['data[].connections[].name'] });
      // The captured OpenAI entry names the variables it reads; Pi does not list them for a provider with no key set.
      expectShape({ location: body.location, data: [byId.openai] }, fixture('integration-disconnected'), { missing: ['data[].methods[].names', 'data[].methods[].names[]'] });
      schemas.integration(body.data);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it('lists the packages and extensions of settings.json as plugins, names only', async () => {
    const bridge = await startBridge({
      prepare: (pi) => {
        fs.mkdirSync(path.join(pi.agentDir, 'ext'), { recursive: true });
        writeText(path.join(pi.agentDir, 'ext', 'present.ts'), 'export default () => {};');
      },
      settings: {
        packages: ['npm:@scope/helper@1.2.3', 'npm:plain', { source: 'git:github.com/user/repo@main', skills: [] }, './missing-package'],
        extensions: ['ext/present.ts', '/nowhere/gone.ts', '+builtin:mcp', '-builtin:codemode', '!skip/*'],
      },
    });
    writeJson(path.join(bridge.pi.project, '.pi', 'settings.json'), { packages: ['npm:project-only', 'npm:plain'] });

    const { body } = await bridge.get('/api/plugin');

    const agentDir = bridge.pi.agentDir;
    expect(body.location).toEqual(locationOf(bridge));
    expect(body.data).toEqual([
      { source: { type: 'package', target: 'npm:project-only' }, features: { server: true }, state: { status: 'active' } },
      { source: { type: 'package', target: 'npm:plain' }, features: { server: true }, state: { status: 'active' } },
      { source: { type: 'package', target: 'npm:@scope/helper@1.2.3', version: '1.2.3' }, features: { server: true }, state: { status: 'active' } },
      { source: { type: 'package', target: 'git:github.com/user/repo@main' }, features: { server: true }, state: { status: 'active' } },
      {
        source: { type: 'local', path: path.join(agentDir, 'missing-package') },
        features: { server: true },
        state: { status: 'failed', error: `Path not found: ${path.join(agentDir, 'missing-package')}` },
      },
      { source: { type: 'local', path: path.join(agentDir, 'ext', 'present.ts') }, features: { server: true }, state: { status: 'active' } },
      {
        source: { type: 'local', path: '/nowhere/gone.ts' },
        features: { server: true },
        state: { status: 'failed', error: 'Path not found: /nowhere/gone.ts' },
      },
      { id: 'builtin:mcp', source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } },
    ]);
    expectShape({ location: body.location, data: [body.data.at(-1)] }, fixture('plugin'));
    schemas.plugin(body.data);
  });

  it('answers an empty plugin list for a fresh installation', async () => {
    const bridge = await startBridge();
    expect((await bridge.get('/api/plugin')).body).toEqual({ location: locationOf(bridge), data: [] });
  });

  it('serves the stored credentials with their secrets, as OpenCode did for local callers', async () => {
    const bridge = await startBridge({
      prepare: (pi) => writeJson(authFile(pi), {
        groq: { type: 'api_key', key: 'gsk-test-123' },
        anthropic: { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 1900000000000 },
        'openai-codex': { type: 'oauth', access: 'a2', refresh: 'r2', expires: 1900000000001, accountId: 'acc-1' },
      }),
    });

    const { status, body } = await bridge.get('/api/credential', { directory: null });

    expect(status).toBe(200);
    expect(body).toEqual({
      data: [
        { id: 'cred_groq', integrationID: 'groq', label: 'default', active: true, value: { type: 'key', key: 'gsk-test-123' } },
        {
          id: 'cred_anthropic',
          integrationID: 'anthropic',
          label: 'default',
          active: true,
          value: { type: 'oauth', methodID: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 1900000000000 },
        },
        {
          id: 'cred_openai-codex',
          integrationID: 'openai-codex',
          label: 'default',
          active: true,
          value: { type: 'oauth', methodID: 'oauth', access: 'a2', refresh: 'r2', expires: 1900000000001, metadata: { accountId: 'acc-1', accountID: 'acc-1' } },
        },
      ],
    });
    expectShape({ data: body.data.slice(0, 2) }, fixture('credential'), { records: ['data[].value.metadata'], missing: ['data[].value.metadata', 'data[].value.metadata.*'] });
    schemas.credential(body.data.slice(0, 2));
  });

  it('answers an empty list without auth.json, and leaves out a !command key and a malformed entry', async () => {
    const empty = await startBridge();
    expect((await empty.get('/api/credential', { directory: null })).body).toEqual({ data: [] });

    const bridge = await startBridge({
      prepare: (pi) => writeJson(authFile(pi), {
        groq: { type: 'api_key', key: '!op read secret' },
        xai: { type: 'api_key', key: 'xai-ok' },
        odd: 'a string',
        empty: { type: 'api_key' },
      }),
    });
    const { body } = await bridge.get('/api/credential', { directory: null });
    expect(body.data.map((entry) => entry.integrationID)).toEqual(['xai']);
    expect(bridge.logs.some((message) => message.includes('groq') && message.includes('odd') && message.includes('empty'))).toBe(true);
  });
});
