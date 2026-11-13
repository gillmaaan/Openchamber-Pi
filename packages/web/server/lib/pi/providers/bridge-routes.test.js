import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness } from './test-harness.js';

// The integration and credential routes over a real Pi runtime in an isolated
// agent directory. Keys are fake; an assertion about a stored key checks the
// file, and nothing prints it.

let h;
afterEach(async () => {
  delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  await h?.dispose();
  h = null;
});

const integration = async (id) => (await h.json('GET', `/api/integration/${id}`)).body.data;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /api/integration', () => {
  it('lists every Pi provider with the ways to connect it, in the location envelope', async () => {
    h = await createHarness();
    const { status, body } = await h.json('GET', '/api/integration');
    expect(status).toBe(200);
    expect(body.location).toEqual({ directory: h.fixture.project });
    const byId = new Map(body.data.map((entry) => [entry.id, entry]));
    expect(body.data.length).toBeGreaterThan(40);

    expect(byId.get('openai')).toEqual({
      id: 'openai',
      name: 'OpenAI',
      methods: [
        { type: 'key' },
        { type: 'env', names: ['OPENAI_API_KEY'] },
        { id: 'oauth', type: 'oauth', label: 'Sign in with ChatGPT' },
      ],
      connections: [],
    });
    // A provider whose key login asks for more than the key gets that as the form the page renders.
    expect(byId.get('cloudflare-workers-ai').methods[0]).toEqual({
      type: 'key',
      form: [{ key: 'cloudflare_account_id', title: 'Cloudflare account ID', type: 'string', required: true }],
    });
    // A login that stores no key is an external method.
    expect(byId.get('amazon-bedrock').methods.filter((method) => method.type === 'external')).toEqual([
      { id: 'external:aws-profile', type: 'external', label: 'AWS profile', form: [{ key: 'aws_profile_name', title: 'AWS profile name', type: 'string', required: true }] },
      { id: 'external:credential-chain', type: 'external', label: 'Existing AWS credential chain' },
    ]);
    // GitHub Copilot's sign-in asks for an enterprise domain first.
    expect(byId.get('github-copilot').methods.find((method) => method.type === 'oauth').form[0]).toMatchObject({ key: 'enterprise_domain', type: 'string' });
    // A provider declared in models.json takes a key, and names no variable when its key is a literal.
    expect(byId.get('mock')).toEqual({ id: 'mock', name: 'Mock', methods: [{ type: 'key' }], connections: [] });
  });

  it('reports a key from the environment as a connection the page cannot remove, and a missing one as none', async () => {
    h = await createHarness();
    process.env.XAI_API_KEY = 'fake-env-key';
    try {
      h.catalog.reload();
      const xai = await integration('xai');
      expect(xai.connections).toEqual([{ type: 'env', name: 'XAI_API_KEY' }]);
      expect(xai.methods).toContainEqual({ type: 'env', names: ['XAI_API_KEY'] });
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it('answers a tagged 404 for a provider Pi does not list', async () => {
    h = await createHarness();
    const { status, body } = await h.json('GET', '/api/integration/no-such-provider');
    expect(status).toBe(404);
    expect(body).toMatchObject({ _tag: 'IntegrationNotFoundError', integrationID: 'no-such-provider' });
  });
});

describe('connecting an API key', () => {
  it('stores the key through Pi, brings the provider\'s models into /api/model and announces the change; removing it takes them away', async () => {
    h = await createHarness();
    expect(await h.modelIds()).toEqual(['mock/mock-model']);

    const connect = await h.json('POST', '/api/integration/openai/connect/key', { key: '  sk-fake-123  ', label: 'Work' });
    expect(connect.status).toBe(204);

    expect(h.readJson('auth.json')).toEqual({ openai: { type: 'api_key', key: 'sk-fake-123' } });
    expect((await h.modelIds()).filter((id) => id.startsWith('openai/')).length).toBeGreaterThan(10);
    expect((await integration('openai')).connections).toEqual([{ type: 'credential', id: 'cred_openai', label: 'Work', method: 'key' }]);
    expect(h.types()).toEqual(['credential.updated', 'integration.updated', 'provider.updated', 'model.updated']);
    expect(h.events[0].location).toEqual({ directory: h.fixture.project });

    h.events.length = 0;
    expect((await h.json('DELETE', '/api/credential/cred_openai')).status).toBe(204);
    expect(await h.modelIds()).toEqual(['mock/mock-model']);
    expect(h.readJson('auth.json')).toEqual({});
    expect((await integration('openai')).connections).toEqual([]);
    expect(h.types()).toContain('credential.updated');
    // The name of the removed login does not come back with the next one.
    await h.json('POST', '/api/integration/openai/connect/key', { key: 'sk-fake-456' });
    expect((await integration('openai')).connections[0].label).toBe('default');
  });

  it('refuses an empty key, a key for an unknown provider and a provider without a key login, writing nothing', async () => {
    h = await createHarness();
    const empty = await h.json('POST', '/api/integration/openai/connect/key', { key: '   ' });
    expect(empty).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError', field: 'key' } });
    const unknown = await h.json('POST', '/api/integration/nope/connect/key', { key: 'k' });
    expect(unknown).toMatchObject({ status: 404, body: { _tag: 'IntegrationNotFoundError' } });
    const noBody = await h.json('POST', '/api/integration/openai/connect/key', []);
    expect(noBody.status).toBe(400);
    expect(h.readAuth()).toEqual({});
    expect(h.events).toEqual([]);
  });

  it('asks for what the provider\'s login asks for besides the key, and stores it with the key', async () => {
    h = await createHarness();
    const missing = await h.json('POST', '/api/integration/cloudflare-workers-ai/connect/key', { key: 'cf-fake' });
    expect(missing).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError', field: 'cloudflare_account_id' } });
    expect(h.readAuth()).toEqual({});

    const saved = await h.json('POST', '/api/integration/cloudflare-workers-ai/connect/key', { key: 'cf-fake', answer: { cloudflare_account_id: 'acct-1' } });
    expect(saved.status).toBe(204);
    expect(h.readJson('auth.json')['cloudflare-workers-ai']).toEqual({ type: 'api_key', key: 'cf-fake', env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' } });
  });

  it('keeps every key when several providers are connected at once', async () => {
    h = await createHarness();
    const ids = ['openai', 'groq', 'mistral', 'deepseek', 'together', 'cerebras'];
    const results = await Promise.all(ids.map((id) => h.json('POST', `/api/integration/${id}/connect/key`, { key: `fake-${id}` })));
    expect(results.map((result) => result.status)).toEqual(ids.map(() => 204));
    const stored = h.readJson('auth.json');
    expect(Object.keys(stored).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(stored[id]).toEqual({ type: 'api_key', key: `fake-${id}` });
  });
});

describe('credentials that hold no key', () => {
  it('connects an AWS profile as an external credential and lists it as one', async () => {
    h = await createHarness();
    const wrong = await h.json('POST', '/api/integration/amazon-bedrock/connect/external', { methodID: 'bearer-token' });
    expect(wrong).toMatchObject({ status: 404, body: { _tag: 'IntegrationMethodNotFoundError' } });
    const missing = await h.json('POST', '/api/integration/amazon-bedrock/connect/external', { methodID: 'external:aws-profile' });
    expect(missing).toMatchObject({ status: 400, body: { field: 'aws_profile_name' } });

    const saved = await h.json('POST', '/api/integration/amazon-bedrock/connect/external', { methodID: 'external:aws-profile', answer: { aws_profile_name: 'work' } });
    expect(saved.status).toBe(204);
    expect(h.readJson('auth.json')['amazon-bedrock']).toEqual({ type: 'api_key', env: { AWS_PROFILE: 'work' } });
    expect((await integration('amazon-bedrock')).connections).toEqual([{ type: 'credential', id: 'cred_amazon-bedrock', label: 'default', method: 'external' }]);
  });
});

describe('the stored credential of a provider', () => {
  const connected = async () => {
    h = await createHarness();
    await h.json('POST', '/api/integration/groq/connect/key', { key: 'fake-groq' });
    h.events.length = 0;
  };

  it('renames, activates and removes it', async () => {
    await connected();
    expect((await h.json('PATCH', '/api/credential/cred_groq', { label: ' Personal ' })).status).toBe(204);
    expect((await integration('groq')).connections[0].label).toBe('Personal');
    expect(h.types()).toContain('credential.updated');

    // Pi keeps one credential per provider, so the only one is the active one.
    expect((await h.json('POST', '/api/credential/cred_groq/activate')).status).toBe(204);
    expect(h.readJson('auth.json')).toEqual({ groq: { type: 'api_key', key: 'fake-groq' } });
  });

  it('rejects a rename or activation of a credential that does not exist and treats removing it as done', async () => {
    await connected();
    expect(await h.json('PATCH', '/api/credential/cred_openai', { label: 'x' })).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError' } });
    expect(await h.json('POST', '/api/credential/cred_openai/activate')).toMatchObject({ status: 400 });
    expect(await h.json('PATCH', '/api/credential/not-ours', { label: 'x' })).toMatchObject({ status: 400 });
    expect((await h.json('PATCH', '/api/credential/cred_groq', {})).status).toBe(400);
    expect((await h.json('DELETE', '/api/credential/cred_openai')).status).toBe(204);
    expect(h.readJson('auth.json')).toEqual({ groq: { type: 'api_key', key: 'fake-groq' } });
  });

  it('is still listed by GET /api/credential, which the catalog routes serve', async () => {
    await connected();
    const { body } = await h.json('GET', '/api/credential');
    expect(body.data).toEqual([{ id: 'cred_groq', integrationID: 'groq', label: 'default', active: true, value: { type: 'key', key: 'fake-groq' } }]);
  });
});

describe('files of the app\'s own that cannot be used', () => {
  const stateFile = (name) => path.join(h.fixture.root, 'state', name);
  const breakFile = (name) => {
    fs.mkdirSync(path.dirname(stateFile(name)), { recursive: true });
    fs.writeFileSync(stateFile(name), '{ not json');
  };

  it('does not fail a key that Pi already stored because the name of the login could not be kept', async () => {
    h = await createHarness();
    breakFile('credential-labels.json');
    const connect = await h.json('POST', '/api/integration/groq/connect/key', { key: 'fake-groq', label: 'Work' });
    expect(connect.status).toBe(204);
    expect(h.readAuth()).toEqual({ groq: { type: 'api_key', key: 'fake-groq' } });
    // The page is told, so it does not keep showing the provider as unconnected.
    expect(h.types()).toEqual(['credential.updated', 'integration.updated', 'provider.updated', 'model.updated']);
    expect((await integration('groq')).connections[0]).toMatchObject({ id: 'cred_groq', label: 'default' });

    h.events.length = 0;
    expect((await h.json('DELETE', '/api/credential/cred_groq')).status).toBe(204);
    expect(h.readAuth()).toEqual({});
    expect(h.types()).toContain('credential.updated');
    expect(fs.readFileSync(stateFile('credential-labels.json'), 'utf8')).toBe('{ not json');
  });

  it('refuses a rename it cannot keep, with the file named', async () => {
    h = await createHarness();
    await h.json('POST', '/api/integration/groq/connect/key', { key: 'fake-groq' });
    breakFile('credential-labels.json');
    const rename = await h.json('PATCH', '/api/credential/cred_groq', { label: 'x' });
    expect(rename).toMatchObject({ status: 409, body: { _tag: 'ConflictError', code: 'config_file_unusable' } });
    expect(rename.body.message).toContain('credential-labels.json');
  });
});

describe('an auth.json that cannot be read', () => {
  it('is an error for the list, never a list of providers with nothing connected', async () => {
    h = await createHarness();
    await h.json('POST', '/api/integration/groq/connect/key', { key: 'fake-groq' });
    fs.writeFileSync(h.file('auth.json'), '{ not json');
    const list = await h.json('GET', '/api/integration');
    expect(list).toMatchObject({ status: 503, body: { _tag: 'ServiceUnavailableError' } });
    // The model probe reads the file itself and names it.
    await expect(h.providers.discoveryDefaults('groq')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('auth.json') });
    expect(fs.readFileSync(h.file('auth.json'), 'utf8')).toBe('{ not json');
  });
});

describe('a login whose own error carries what it was given', () => {
  it('never returns the key in the answer', async () => {
    h = await createHarness();
    h.catalog.login = async () => { throw new Error('Provider rejected sk-secret-abc123 as invalid'); };
    const response = await h.json('POST', '/api/integration/groq/connect/key', { key: 'sk-secret-abc123' });
    expect(response.status).toBe(503);
    expect(response.body.message).toContain('[redacted]');
    expect(JSON.stringify(response.body)).not.toContain('sk-secret-abc123');
  });
});

describe('signing in with OAuth', () => {
  /** A provider whose sign-in shows a link and asks for the code the browser page shows. */
  const registerFake = async (login) => {
    const rt = await h.catalog.getRuntime();
    rt.registerProvider('fake-oauth', {
      name: 'Fake OAuth',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      oauth: {
        name: 'Fake sign-in',
        login,
        refreshToken: async (credential) => credential,
        getApiKey: (credential) => credential.access,
      },
      models: [{ id: 'fake-model', name: 'Fake Model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    });
  };
  const codeLogin = async (callbacks) => {
    callbacks.onAuth({ url: 'https://auth.example/authorize?x=1', instructions: 'Sign in, then copy the code.' });
    const code = await callbacks.onManualCodeInput();
    if (code !== 'good-code') throw new Error('Bad code');
    return { access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 3_600_000 };
  };
  const start = () => h.json('POST', '/api/integration/fake-oauth/connect/oauth', { methodID: 'oauth' });

  it('walks start, status and complete, stores the login in auth.json and announces it', async () => {
    h = await createHarness();
    await registerFake(codeLogin);
    expect((await integration('fake-oauth')).methods).toEqual([{ id: 'oauth', type: 'oauth', label: 'Sign in with Fake sign-in' }]);

    const started = await start();
    expect(started.status).toBe(200);
    expect(started.body.location).toEqual({ directory: h.fixture.project });
    expect(started.body.data).toMatchObject({ url: 'https://auth.example/authorize?x=1', instructions: 'Sign in, then copy the code.', mode: 'code' });
    const { attemptID } = started.body.data;

    const pending = await h.json('GET', `/api/integration/fake-oauth/connect/oauth/${attemptID}`);
    expect(pending.body.data).toMatchObject({ status: 'pending' });

    h.events.length = 0;
    const done = await h.json('POST', `/api/integration/fake-oauth/connect/oauth/${attemptID}/complete`, { code: 'good-code' });
    expect(done.status).toBe(204);
    expect((await h.json('GET', `/api/integration/fake-oauth/connect/oauth/${attemptID}`)).body.data.status).toBe('complete');

    expect(h.readJson('auth.json')['fake-oauth']).toMatchObject({ type: 'oauth', access: 'fake-access', refresh: 'fake-refresh' });
    expect((await integration('fake-oauth')).connections).toEqual([{ type: 'credential', id: 'cred_fake-oauth', label: 'default', method: 'oauth' }]);
    expect(await h.modelIds()).toContain('fake-oauth/fake-model');
    expect(h.types()).toEqual(['credential.updated', 'integration.updated', 'provider.updated', 'model.updated']);
  });

  it('reports a wrong code with the login\'s message, settles the attempt as failed and lets a new attempt succeed', async () => {
    h = await createHarness();
    await registerFake(codeLogin);
    const first = (await start()).body.data.attemptID;

    const wrong = await h.json('POST', `/api/integration/fake-oauth/connect/oauth/${first}/complete`, { code: 'bad' });
    expect(wrong).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError', message: 'Bad code' } });
    expect((await h.json('GET', `/api/integration/fake-oauth/connect/oauth/${first}`)).body.data).toMatchObject({ status: 'failed', message: 'Bad code' });
    expect(h.readAuth()).toEqual({});
    expect(h.types()).toEqual([]);

    const second = (await start()).body.data.attemptID;
    expect((await h.json('POST', `/api/integration/fake-oauth/connect/oauth/${second}/complete`, { code: 'good-code' })).status).toBe(204);
    expect(Object.keys(h.readJson('auth.json'))).toEqual(['fake-oauth']);
  });

  it('cancels a waiting attempt: the login is aborted, nothing is stored and the attempt is gone', async () => {
    h = await createHarness();
    let aborted = false;
    await registerFake(async (callbacks) => {
      callbacks.onAuth({ url: 'https://auth.example/authorize' });
      await new Promise((_resolve, reject) => callbacks.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Login cancelled')); }));
    });
    const { attemptID } = (await start()).body.data;
    expect((await h.json('DELETE', `/api/integration/fake-oauth/connect/oauth/${attemptID}`)).status).toBe(204);
    await wait(20);
    expect(aborted).toBe(true);
    expect(await h.json('GET', `/api/integration/fake-oauth/connect/oauth/${attemptID}`)).toMatchObject({ status: 404, body: { _tag: 'IntegrationAttemptNotFoundError', attemptID } });
    expect(h.readAuth()).toEqual({});
    expect(h.types()).toEqual([]);
  });

  it('follows a device-code sign-in through status alone', async () => {
    h = await createHarness();
    const approved = {};
    approved.promise = new Promise((resolve) => { approved.resolve = resolve; });
    await registerFake(async (callbacks) => {
      callbacks.onDeviceCode({ userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' });
      await approved.promise;
      return { access: 'device-access', refresh: 'device-refresh', expires: Date.now() + 3_600_000 };
    });
    const started = (await start()).body.data;
    expect(started).toMatchObject({ mode: 'auto', url: 'https://auth.example/device', instructions: 'Enter code: ABCD-1234' });
    expect(started.paste).toBeUndefined();

    approved.resolve();
    await wait(50);
    expect((await h.json('GET', `/api/integration/fake-oauth/connect/oauth/${started.attemptID}`)).body.data.status).toBe('complete');
    expect(h.readJson('auth.json')['fake-oauth'].access).toBe('device-access');
  });

  it('starts nothing when the request names a folder that does not exist', async () => {
    h = await createHarness();
    let started = false;
    await registerFake(async (callbacks) => {
      started = true;
      callbacks.onAuth({ url: 'https://auth.example/authorize' });
      await new Promise(() => {});
    });
    const gone = encodeURIComponent(`${h.fixture.root}/no-such-folder`);
    const response = await h.json('POST', '/api/integration/fake-oauth/connect/oauth', { methodID: 'oauth' }, { 'x-opencode-directory': gone });
    expect(response).toMatchObject({ status: 404, body: { _tag: 'LocationNotFoundError' } });
    expect(started).toBe(false);
  });

  it('refuses a method the provider does not have and a code for an attempt that is not there', async () => {
    h = await createHarness();
    await registerFake(codeLogin);
    expect(await h.json('POST', '/api/integration/fake-oauth/connect/oauth', { methodID: 'nope' })).toMatchObject({ status: 404, body: { _tag: 'IntegrationMethodNotFoundError' } });
    expect(await h.json('POST', '/api/integration/groq/connect/oauth', { methodID: 'oauth' })).toMatchObject({ status: 404, body: { _tag: 'IntegrationMethodNotFoundError' } });
    expect(await h.json('POST', '/api/integration/fake-oauth/connect/oauth/att_missing/complete', { code: 'x' })).toMatchObject({ status: 404, body: { _tag: 'IntegrationAttemptNotFoundError' } });
  });

  it('aborts a waiting login when the service closes', async () => {
    h = await createHarness();
    let aborted = false;
    await registerFake(async (callbacks) => {
      callbacks.onAuth({ url: 'https://auth.example/authorize' });
      await new Promise((_resolve, reject) => callbacks.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Login cancelled')); }));
    });
    await start();
    h.providers.close();
    await wait(20);
    expect(aborted).toBe(true);
  });
});

describe('enterprise mode', () => {
  it('refuses every way to add a provider login, writes nothing and keeps removing allowed', async () => {
    h = await createHarness();
    await h.json('POST', '/api/integration/groq/connect/key', { key: 'fake-groq' });
    h.events.length = 0;
    const before = h.readText('auth.json');

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const refused = [
      await h.json('POST', '/api/integration/openai/connect/key', { key: 'sk-fake' }),
      await h.json('POST', '/api/integration/amazon-bedrock/connect/external', { methodID: 'external:aws-profile', answer: { aws_profile_name: 'work' } }),
      await h.json('POST', '/api/integration/openai/connect/oauth', { methodID: 'oauth' }),
      await h.json('POST', '/api/integration/openai/connect/oauth/att_x/complete', { code: 'x' }),
    ];
    for (const result of refused) {
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ _tag: 'ForbiddenError', code: 'enterprise_mode' });
    }
    expect(h.readText('auth.json')).toBe(before);
    expect(h.events).toEqual([]);

    // Reading, renaming and removing only narrow access.
    expect((await h.json('GET', '/api/integration')).status).toBe(200);
    expect((await h.json('PATCH', '/api/credential/cred_groq', { label: 'x' })).status).toBe(204);
    expect((await h.json('DELETE', '/api/credential/cred_groq')).status).toBe(204);
    expect(h.readJson('auth.json')).toEqual({});

    // The same request goes through once the mode is off.
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    expect((await h.json('POST', '/api/integration/openai/connect/key', { key: 'sk-fake' })).status).toBe(204);
  });
});
