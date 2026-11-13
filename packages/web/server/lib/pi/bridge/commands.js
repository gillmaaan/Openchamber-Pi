// Resolve a command from the same store the editor writes, before context and
// attachments are folded into its prompt. Pi's RPC expands only a leading slash
// command, so delegating expansion after that fold silently loses the template.
//
// `resolveCommandRun` then reads the command's `agent`, `model` and `subagent`
// the way OpenCode 2.2.6 does: inline commands switch the session's selection
// durably before their turn; subagent commands run in a child and leave the
// parent's selection alone. `prompting.js` performs both.

import { parseModelRef } from '../config-routes/agents.js';
import { isSafeEntityName } from '../config-routes/paths.js';
import { commandNotFound, invalidRequest, modelNotFound } from './errors.js';

// Pi 1.5.0 does not export its template expander from the SDK entry point. Use
// the installed, pinned implementation rather than maintaining a second parser.
const templateModule = new URL('./core/prompt-templates.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;

/** @param {ReturnType<import('../config-routes/commands.js').createCommandStore>} store */
export const createCommandResolver = (store) => async (name, args, directory) => {
  if (!isSafeEntityName(name)) throw invalidRequest('Invalid command name', { kind: 'Payload', field: 'name' });
  const stored = await store.getConfig(name, directory);
  if (stored.source === 'none') throw commandNotFound(name);
  const { expandPromptTemplate } = await import(templateModule);
  const text = expandPromptTemplate(`/${name}${args ? ` ${args}` : ''}`, [{ name, content: stored.config.template }]);
  return { text, config: stored.config };
};

/** A profile's pinned model, with its thinking level as the variant when the model ref carries none. */
const modelOfProfile = (profile) => {
  const ref = parseModelRef(profile?.model);
  if (!ref) return null;
  return ref.variant || !profile.thinking ? ref : { ...ref, variant: profile.thinking };
};

const assertModel = async (ref, findModel) => {
  if (!findModel || !ref) return;
  const found = await findModel(ref.providerID, ref.id);
  if (!found) throw modelNotFound(ref.providerID, ref.id);
  const levels = Array.isArray(found.thinkingLevels) ? found.thinkingLevels : [];
  if (ref.variant && !levels.includes(ref.variant)) {
    throw invalidRequest(`Model ${ref.providerID}/${ref.id} has no thinking level "${ref.variant}"`, { kind: 'Payload', field: 'model' });
  }
};

/**
 * What a command runs as, measured against OpenCode 2.2.6:
 * - A named `agent` switches the session's agent durably and uses that agent's
 *   pinned model when it has one; without one the session keeps its explicit
 *   model (and Pi's default when it has none).
 * - A command `model` switches the session's model durably.
 * - A command that names no agent keeps the session's agent and model; its own
 *   `model` still applies.
 * - `subagent: true`, or a named agent whose mode is `subagent` without
 *   `subagent: false`, runs in a child session and leaves the parent's
 *   selection alone. The child's model is the command's, else the target
 *   agent's, else the parent's explicit selection, else Pi's default.
 *
 * `sessionModel` is the parent's explicit selection, not the model Pi last ran:
 * a command must not promote a transcript model into a session choice.
 */
export const resolveCommandRun = async ({ config, record, sessionModel = null, agentProfile, findModel }) => {
  const source = config ?? {};
  const rawModel = typeof source.model === 'string' && source.model.trim() ? source.model.trim() : null;
  const commandModel = rawModel ? parseModelRef(rawModel) : null;
  if (rawModel && !commandModel) throw invalidRequest(`Invalid model reference: ${rawModel}`, { kind: 'Payload', field: 'model' });

  const namedAgent = typeof source.agent === 'string' && source.agent.trim() ? source.agent.trim() : null;
  const agent = namedAgent ?? record.agent ?? 'build';
  const profile = await agentProfile(agent);
  const agentModel = modelOfProfile(profile);
  const child = source.subagent === true || (source.subagent !== false && namedAgent !== null && profile?.mode === 'subagent');

  const model = commandModel ?? (child ? agentModel ?? sessionModel : namedAgent ? agentModel : null);
  if (commandModel) await assertModel(commandModel, findModel);
  else if (model && model === agentModel) await assertModel(agentModel, findModel);

  return { agent, model, child };
};
