// Pi's `<agentDir>/models.json`: the providers a user declares beside Pi's
// built-in ones. This module only reads and writes the file; what a provider
// entry holds is `custom-provider.js`.

import path from 'node:path';

import { createJsonDocument } from './json-document.js';

export const MODELS_SCHEMA_URL = 'https://pi.dev/schemas/models.schema.json';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {{ getAgentDir: () => string }} options */
export const createModelsFile = ({ getAgentDir }) => {
  const document = createJsonDocument({
    getFilePath: () => path.join(getAgentDir(), 'models.json'),
    schemaUrl: MODELS_SCHEMA_URL,
    check: (value) => (value.providers !== undefined && !isRecord(value.providers) ? '"providers" must be an object' : null),
  });

  /** The declared providers by id. Throws `JsonDocumentError` when the file cannot be used. */
  const readProviders = () => document.read().value.providers ?? {};

  /**
   * Edits one provider entry. `edit(existing)` returns the new entry, or
   * `undefined` to leave the provider as it is; it runs against the file as it
   * is now and must not await.
   */
  const updateProvider = (providerId, edit) => document.update((draft) => {
    const providers = isRecord(draft.providers) ? draft.providers : {};
    const next = edit(providers[providerId]);
    if (next === undefined) return undefined;
    draft.providers = { ...providers, [providerId]: next };
    return next;
  });

  /** Deletes one provider entry; the other providers and every other key stay. */
  const removeProvider = (providerId) => document.update((draft) => {
    if (!isRecord(draft.providers) || !(providerId in draft.providers)) return false;
    delete draft.providers[providerId];
    return true;
  });

  return { readProviders, updateProvider, removeProvider, filePath: () => path.join(getAgentDir(), 'models.json') };
};
