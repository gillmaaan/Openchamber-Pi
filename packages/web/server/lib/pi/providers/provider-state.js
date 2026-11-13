// What OpenChamber keeps about providers that Pi has no place for, in its own
// data folder (never in Pi's agent directory):
//
// - the providers the user turned off in Settings. Pi has no such switch;
//   OpenChamber's lists (`/api/provider`, `/api/model`) leave them out
//   (`catalog.js`, `getHiddenProviders`) and Pi itself is not told.
// - the name of a stored login. Pi keeps one credential per provider and no
//   label, while the Settings page renames the login it shows.
//
// Without a folder both live in memory for the life of the process.

import path from 'node:path';

import { createJsonDocument } from './json-document.js';

const memory = () => {
  let value = {};
  return {
    read: () => ({ value }),
    update: (edit) => {
      const draft = structuredClone(value);
      const result = edit(draft);
      value = draft;
      return { result };
    },
  };
};

const open = (stateDir, fileName) => (stateDir
  ? createJsonDocument({ getFilePath: () => path.join(stateDir, fileName) })
  : memory());

const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry) : []);

/**
 * @param {object} options
 * @param {string} [options.stateDir]  OpenChamber's folder for the Pi bridge (`<dataDir>/pi`).
 * @param {(message: string) => void} [options.log]
 */
export const createProviderState = ({ stateDir, log = (message) => console.warn(`[pi-providers] ${message}`) }) => {
  const disabledFile = open(stateDir, 'disabled-providers.json');
  const labelFile = open(stateDir, 'credential-labels.json');
  let lastProblem = null;

  /** A file that cannot be read counts as empty for the lists, and is reported once; writes still refuse it. */
  const readSafely = (file, pick) => {
    try {
      const value = pick(file.read().value);
      lastProblem = null;
      return value;
    } catch (error) {
      if (lastProblem !== error.message) log(error.message);
      lastProblem = error.message;
      return pick({});
    }
  };

  const disabledProviders = () => readSafely(disabledFile, (value) => stringList(value.providers));

  /** Turns a provider off or on and answers the list as it is afterwards. */
  const setDisabled = (providerId, disabled) => disabledFile.update((draft) => {
    const next = stringList(draft.providers).filter((entry) => entry !== providerId);
    if (disabled) next.push(providerId);
    if (next.length > 0) draft.providers = next;
    else delete draft.providers;
    return next;
  }).result;

  const labels = () => readSafely(labelFile, (value) => (value.labels !== null && typeof value.labels === 'object' && !Array.isArray(value.labels)
    ? Object.fromEntries(Object.entries(value.labels).filter(([, label]) => typeof label === 'string' && label))
    : {}));

  /** An empty label forgets the name. */
  const setLabel = (providerId, label) => labelFile.update((draft) => {
    const next = { ...(draft.labels ?? {}) };
    if (label) next[providerId] = label;
    else delete next[providerId];
    if (Object.keys(next).length > 0) draft.labels = next;
    else delete draft.labels;
  });

  return { disabledProviders, setDisabled, labels, setLabel };
};
