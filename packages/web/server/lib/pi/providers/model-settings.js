// The model keys of Pi's `<agentDir>/settings.json`: the default model, the
// default thinking level, the per-model thinking levels and the model patterns
// Pi cycles through (`enabledModels`). Every other key of the file is left as it
// is, and a file that cannot be parsed is never rewritten (`json-document.js`).

import path from 'node:path';

import { createJsonDocument } from './json-document.js';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLevel = (value) => THINKING_LEVELS.includes(value);

const fail = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const pick = (settings) => ({
  defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null,
  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : null,
  defaultThinkingLevel: isLevel(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : null,
  enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((entry) => typeof entry === 'string') : null,
  modelThinkingLevels: isRecord(settings.modelThinkingLevels)
    ? Object.fromEntries(Object.entries(settings.modelThinkingLevels).filter(([, level]) => isLevel(level)))
    : {},
});

/** @param {{ getAgentDir: () => string }} options */
export const createModelSettings = ({ getAgentDir }) => {
  const document = createJsonDocument({ getFilePath: () => path.join(getAgentDir(), 'settings.json') });

  const read = () => pick(document.read().value);

  /**
   * Applies a patch; a key set to `null` is removed from the file.
   *
   * - `defaultModel`: `{ provider, model }` or `null`.
   * - `defaultThinkingLevel`: one of Pi's levels or `null`.
   * - `enabledModels`: model patterns or `null` (null means every model).
   * - `modelThinkingLevels`: `{ "provider/model": level | null }`, merged into the file's map.
   *
   * Throws an error with `statusCode` 400 for a value Pi would not accept, before
   * anything is written.
   */
  const update = (patch) => {
    if (patch.defaultModel !== undefined && patch.defaultModel !== null) {
      const { provider, model } = patch.defaultModel;
      if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) throw fail('defaultModel needs a provider and a model');
    }
    if (patch.defaultThinkingLevel !== undefined && patch.defaultThinkingLevel !== null && !isLevel(patch.defaultThinkingLevel)) {
      throw fail(`defaultThinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    if (patch.enabledModels !== undefined && patch.enabledModels !== null
      && (!Array.isArray(patch.enabledModels) || patch.enabledModels.some((entry) => typeof entry !== 'string' || !entry.trim()))) {
      throw fail('enabledModels must be a list of model patterns');
    }
    if (patch.modelThinkingLevels !== undefined) {
      if (!isRecord(patch.modelThinkingLevels)) throw fail('modelThinkingLevels must be an object');
      for (const [key, level] of Object.entries(patch.modelThinkingLevels)) {
        if (level !== null && !isLevel(level)) throw fail(`The thinking level of ${key} must be one of ${THINKING_LEVELS.join(', ')}`);
      }
    }

    document.update((draft) => {
      if (patch.defaultModel === null) {
        delete draft.defaultProvider;
        delete draft.defaultModel;
      } else if (patch.defaultModel) {
        draft.defaultProvider = patch.defaultModel.provider;
        draft.defaultModel = patch.defaultModel.model;
      }
      if (patch.defaultThinkingLevel === null) delete draft.defaultThinkingLevel;
      else if (patch.defaultThinkingLevel) draft.defaultThinkingLevel = patch.defaultThinkingLevel;
      if (patch.enabledModels === null) delete draft.enabledModels;
      else if (patch.enabledModels) draft.enabledModels = patch.enabledModels.map((entry) => entry.trim());
      if (patch.modelThinkingLevels) {
        const levels = isRecord(draft.modelThinkingLevels) ? { ...draft.modelThinkingLevels } : {};
        for (const [key, level] of Object.entries(patch.modelThinkingLevels)) {
          if (level === null) delete levels[key];
          else levels[key] = level;
        }
        if (Object.keys(levels).length > 0) draft.modelThinkingLevels = levels;
        else delete draft.modelThinkingLevels;
      }
    });
    return read();
  };

  return { read, update };
};
