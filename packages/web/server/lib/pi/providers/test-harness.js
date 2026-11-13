// The provider routes over a real Pi runtime in an isolated agent directory:
// the bridge's HTTP transport with the provider routes in front of the catalog
// routes (the order the bridge composes them in), and the Express config
// routes. Nothing here reads the developer's ~/.pi or their API-key variables.

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBridgeHttpServer } from '../bridge/http.js';
import { createCatalogRoutes } from '../bridge/routes/catalog.js';
import { createPiCatalog } from '../catalog.js';
import { startMockOpenAi } from '../test-support/mock-openai.js';
import { createPiFixture } from '../test-support/pi-fixture.js';
import { createProviderBridgeRoutes } from './bridge-routes.js';
import { registerProviderConfigRoutes } from './config-routes.js';
import { createProviderService } from './service.js';
import { createProviderState } from './provider-state.js';

export const PASSWORD = 'providers-pw';
const basic = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

/** Provider keys in the developer's environment would make a test provider look connected. */
const KEY_VARIABLES = /(_API_KEY|_TOKEN|_AUTH_TOKEN)$|^AWS_|^GOOGLE_|^AZURE_|^CLOUDFLARE_/;

export const createHarness = async ({ flowOptions } = {}) => {
  const savedEnv = {};
  for (const name of Object.keys(process.env)) {
    if (KEY_VARIABLES.test(name)) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  }
  const mock = await startMockOpenAi();
  const fixture = createPiFixture({ mockPort: mock.port });
  const events = [];
  const hub = { emit: (event) => { events.push(event); return event; } };
  const state = createProviderState({ stateDir: path.join(fixture.root, 'state'), log: () => {} });
  const catalog = createPiCatalog({ getAgentDir: () => fixture.agentDir, getHiddenProviders: state.disabledProviders });
  const getDefaultDirectory = () => fixture.project;
  const providers = createProviderService({
    catalog,
    state,
    hub,
    getAgentDir: () => fixture.agentDir,
    getDefaultDirectory,
    log: () => {},
    flowOptions,
  });
  const transport = createBridgeHttpServer({
    password: PASSWORD,
    routes: [
      ...createProviderBridgeRoutes({ providers, getDefaultDirectory }),
      ...createCatalogRoutes({
        catalog,
        getDefaultDirectory,
        getAgentDir: () => fixture.agentDir,
        listKnownDirectories: () => [],
        getServerInfo: () => ({ pid: 1, urls: [], tmp: os.tmpdir() }),
        log: () => {},
      }),
    ],
    onError: (error) => { throw error; },
  });
  const address = await transport.listen({ hostname: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${address.port}`;

  const app = express();
  app.use(express.json());
  let available = true;
  registerProviderConfigRoutes(app, { getProviders: () => (available ? providers : null), log: () => {} });

  const call = (method, route, body, headers = {}) => fetch(`${url}${route}`, {
    method,
    headers: { authorization: basic, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (method, route, body, headers) => {
    const response = await call(method, route, body, headers);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const file = (name) => path.join(fixture.agentDir, name);
  const readJson = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));
  const readText = (name) => fs.readFileSync(file(name), 'utf8');
  /** What `auth.json` holds; Pi creates it as `{}` the first time it lists credentials. */
  const readAuth = () => (fs.existsSync(file('auth.json')) ? readJson('auth.json') : {});

  return {
    app,
    mock,
    fixture,
    events,
    catalog,
    state,
    providers,
    url,
    call,
    json,
    readJson,
    readText,
    readAuth,
    file,
    setBridgeDown: (down) => { available = !down; },
    /** The ids `GET /api/model` lists, as `provider/model`. */
    modelIds: async () => (await json('GET', '/api/model')).body.data.map((model) => `${model.providerID}/${model.id}`).sort(),
    types: () => events.map((event) => event.type),
    dispose: async () => {
      providers.close();
      await transport.close();
      await mock.close();
      fixture.dispose();
      for (const [name, value] of Object.entries(savedEnv)) process.env[name] = value;
    },
  };
};
