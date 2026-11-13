// `GET /api/integration`, `GET /api/plugin` and `GET /api/credential`, over what
// Pi keeps: its providers and their login methods, the packages and extensions
// of `settings.json`, and the credentials of `auth.json`.
//
// An integration is a Pi provider. Its id is the provider id, which is also how
// OpenCode keys the integrations of its built-in providers, so the Providers
// page finds a provider's connections by `provider.id` as before.

import fs from 'node:fs';
import path from 'node:path';

/** The stored credential of a provider. Pi keeps one per provider, so the id is derived from the provider. */
export const credentialIdFor = (providerId) => `cred_${providerId}`;

/** The id `login` and `logout` of a provider use for Pi's OAuth, the only sign-in method besides a key. */
export const OAUTH_METHOD_ID = 'oauth';

const connectionsOf = (provider) => {
  const connections = [];
  if (provider.credentialType) {
    connections.push({
      type: 'credential',
      id: credentialIdFor(provider.id),
      label: 'default',
      method: provider.credentialType === 'oauth' ? 'oauth' : 'key',
    });
  }
  // A key in the environment is a connection the user did not store. A key in
  // `models.json` is shown on the provider (`settings.apiKey`), as OpenCode
  // does for a key in its config, and an in-memory runtime key is nobody's.
  if (provider.source === 'environment' && provider.sourceLabel) {
    connections.push({ type: 'env', name: provider.sourceLabel });
  }
  return connections;
};

/** @param {object} provider  One entry of `catalog.providers()`. */
export const toIntegrationInfo = (provider) => ({
  id: provider.id,
  name: provider.name,
  methods: [
    ...(provider.auth.apiKey ? [{ type: 'key' }] : []),
    ...(provider.source === 'environment' && provider.sourceLabel ? [{ type: 'env', names: [provider.sourceLabel] }] : []),
    ...(provider.auth.oauth
      ? [{
          id: OAUTH_METHOD_ID,
          type: 'oauth',
          label: provider.auth.oauthLoginLabel ?? `Sign in with ${provider.auth.oauthName ?? provider.name}`,
        }]
      : []),
  ],
  connections: connectionsOf(provider),
});

/**
 * Pi's `auth.json` as OpenCode's credential list: `{ id, integrationID, label,
 * active, value }`, secrets included. The caller is the OpenChamber server
 * (`readOpenCodeCredentials`); the HTTP layer's Basic auth is the only gate.
 *
 * - `api_key` becomes `{ type: 'key', key }`. A key written as `!command` is
 *   resolved by running the command, which a read route must not do, so it is
 *   left out and named in the returned `skipped`.
 * - `oauth` becomes `{ type: 'oauth', methodID, access, refresh, expires,
 *   metadata }`. Fields Pi adds to the credential go to `metadata`, and
 *   `accountId` is also given as `accountID`, the spelling `auth.js` reads.
 * - A key that comes from the environment or `models.json` is not stored in
 *   `auth.json` and not listed, which is also what OpenCode does.
 *
 * @param {Record<string, unknown>} auth  The parsed file.
 * @returns {{ entries: object[], skipped: string[] }}
 */
export const toCredentialEntries = (auth) => {
  const entries = [];
  const skipped = [];
  for (const [providerId, credential] of Object.entries(auth)) {
    if (credential === null || typeof credential !== 'object') {
      skipped.push(providerId);
      continue;
    }
    const base = { id: credentialIdFor(providerId), integrationID: providerId, label: 'default', active: true };
    if (credential.type === 'api_key') {
      if (typeof credential.key !== 'string' || credential.key === '' || credential.key.startsWith('!')) {
        skipped.push(providerId);
        continue;
      }
      entries.push({ ...base, value: { type: 'key', key: credential.key } });
      continue;
    }
    if (credential.type === 'oauth' && typeof credential.access === 'string' && typeof credential.refresh === 'string') {
      const { access, refresh, expires } = credential;
      const extra = Object.fromEntries(Object.entries(credential)
        .filter(([key]) => !['type', 'access', 'refresh', 'expires'].includes(key)));
      const metadata = { ...extra, ...(typeof extra.accountId === 'string' ? { accountID: extra.accountId } : {}) };
      entries.push({
        ...base,
        value: {
          type: 'oauth',
          methodID: OAUTH_METHOD_ID,
          refresh,
          access,
          expires: Number.isFinite(expires) ? Math.max(0, Math.trunc(expires)) : 0,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
      });
      continue;
    }
    skipped.push(providerId);
  }
  return { entries, skipped };
};

const BUILTIN_PREFIX = /^builtin:/;

const isLocalPath = (spec) => /^(\.{1,2}[\\/]|~[\\/]?|\/|[A-Za-z]:[\\/])/.test(spec) || spec === '.' || spec === '..';

/**
 * `npm:@scope/pkg@1.2.3` and `git:github.com/user/repo@ref`: the source is
 * kept verbatim as the plugin's target; only an `npm:` spec carries a version
 * that can be told apart (`@scope/pkg@1.2.3`, `pkg@1.2.3`).
 */
const npmVersionOf = (spec) => {
  if (!spec.startsWith('npm:')) return undefined;
  const name = spec.slice(4);
  const at = name.lastIndexOf('@');
  return at > 0 ? name.slice(at + 1) || undefined : undefined;
};

const resolveLocal = (spec, { baseDir, homeDir }) => {
  if (spec === '~') return homeDir;
  if (spec.startsWith('~/') || spec.startsWith('~\\')) return path.join(homeDir, spec.slice(2));
  return path.resolve(baseDir, spec);
};

/**
 * Pi packages and extensions of one `settings.json` as OpenCode plugin entries.
 *
 * - `packages` entries are a source string or `{ source, ... }`; `extensions`
 *   entries are paths (`!glob`, `-path` exclusions and `+path` forces are
 *   settings of the resource filter, not plugins, and are skipped) or
 *   `builtin:<name>`.
 * - A local path that does not exist is `failed` with the reason. Every other
 *   entry is `active`: without a running Pi session there is no load result
 *   to report, so `active` means "configured", and a later phase can replace
 *   it with what the session loaded.
 * - Relative local paths resolve against `baseDir`, as Pi resolves them
 *   (the agent directory for global settings, `<cwd>/.pi` for project ones).
 *
 * @param {Record<string, unknown> | null} settings
 * @param {{ baseDir: string, homeDir: string }} options
 */
export const toPluginInfos = (settings, { baseDir, homeDir }) => {
  const plugins = [];
  const localPlugin = (spec) => {
    const resolved = resolveLocal(spec, { baseDir, homeDir });
    return {
      source: { type: 'local', path: resolved },
      features: { server: true },
      state: fs.existsSync(resolved) ? { status: 'active' } : { status: 'failed', error: `Path not found: ${resolved}` },
    };
  };

  for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
    const spec = typeof entry === 'string' ? entry : entry?.source;
    if (typeof spec !== 'string' || spec === '') continue;
    if (isLocalPath(spec)) {
      plugins.push(localPlugin(spec));
      continue;
    }
    const version = npmVersionOf(spec);
    plugins.push({
      source: { type: 'package', target: spec, ...(version ? { version } : {}) },
      features: { server: true },
      state: { status: 'active' },
    });
  }

  for (const entry of Array.isArray(settings?.extensions) ? settings.extensions : []) {
    if (typeof entry !== 'string' || entry === '') continue;
    if (entry.startsWith('!') || entry.startsWith('-')) continue;
    const spec = entry.startsWith('+') ? entry.slice(1) : entry;
    if (BUILTIN_PREFIX.test(spec)) {
      plugins.push({ id: spec, source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } });
      continue;
    }
    plugins.push(localPlugin(spec));
  }
  return plugins;
};

const keyOf = (plugin) => (plugin.source.type === 'package' ? `package:${plugin.source.target}`
  : plugin.source.type === 'local' ? `local:${plugin.source.path}`
    : `builtin:${plugin.id}`);

/** Plugins of several settings files in order, the first mention of a source winning. */
export const mergePlugins = (lists) => {
  const merged = new Map();
  for (const plugin of lists.flat()) {
    if (!merged.has(keyOf(plugin))) merged.set(keyOf(plugin), plugin);
  }
  return [...merged.values()];
};
