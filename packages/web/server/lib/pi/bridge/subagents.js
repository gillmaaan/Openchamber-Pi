// The `subagent` tool: a model hands a piece of work to another agent and
// gets its answer back. Pi has no subagents, so the work runs as a child
// session of the caller's session (`parentID`), visible in the UI like any
// session; the tool call waits for it and returns its last reply.
//
// Two calls from the gate extension: `start` creates the child and sends the
// prompt, answering at once with the child's id (the row can open it while it
// runs); `wait` holds until the child is idle. A caller that goes away
// (the parent turn was interrupted) stops the child.

import { invalidRequest, WireError } from './errors.js';

const DEFAULT_AGENT = 'general';
const MAX_ANSWER_CHARS = 200_000;
const MODEL_REF = /^([^/]+)\/([^#]+)(?:#(.+))?$/;

const textOf = (message) => (message.content ?? [])
  .filter((block) => block.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('')
  .trim();

/**
 * @param {object} deps
 * @param {ReturnType<import('./session-service.js').createSessionService>} deps.service
 * @param {ReturnType<import('./prompting.js').createPrompting>} deps.prompting
 * @param {ReturnType<import('./chat-runtime.js').createChatRuntime>} deps.chat
 * @param {(directory: string) => Promise<string[]> | string[]} deps.listSubagents  Ids of the agents a subagent call may name.
 * @param {{ start: (job: { parentSessionID: string, childSessionID: string, agent: string, description?: string }) => void }} [deps.jobs]  The job list `GET /api/experimental/job` serves.
 */
export const createSubagents = ({ service, prompting, chat, listSubagents, jobs = { start: () => {} } }) => {
  const parseModel = (text) => {
    if (text === undefined) return undefined;
    const match = typeof text === 'string' ? MODEL_REF.exec(text) : null;
    if (!match) throw invalidRequest('Expected a model as provider/id or provider/id#variant\n  at ["model"]', { kind: 'Payload' });
    return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) };
  };

  /** Create the child session and send it the prompt. Returns the child's id. */
  const start = async ({ parentSessionID, agent = DEFAULT_AGENT, description, prompt, model }) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') throw invalidRequest('Expected a prompt\n  at ["prompt"]', { kind: 'Payload' });
    const parent = await service.requireRecord(parentSessionID);
    const directory = parent.location.directory;
    const allowed = await listSubagents(directory);
    if (!allowed.includes(agent)) {
      throw invalidRequest(`Unknown agent "${agent}". Use one of: ${allowed.join(', ')}`, { kind: 'Payload', field: 'agent' });
    }
    const child = await service.create({
      parentID: parentSessionID,
      title: typeof description === 'string' && description.trim() ? description.trim().slice(0, 80) : undefined,
      agent,
      model: parseModel(model) ?? (parent.model ? { providerID: parent.model.providerID, id: parent.model.id, ...(parent.model.variant && parent.model.variant !== 'default' ? { variant: parent.model.variant } : {}) } : undefined),
      location: { directory },
    });
    jobs.start({ parentSessionID, childSessionID: child.id, agent, description: typeof description === 'string' ? description : undefined });
    try {
      await prompting.prompt(child.id, { text: prompt });
    } catch (error) {
      jobs.finish?.(child.id, 'failed');
      await service.remove(child.id).catch(() => {});
      throw error;
    }
    return { sessionID: child.id };
  };

  /** The child's last reply once it is idle, as the tool result text. A stopped `signal` stops the child. */
  const wait = async ({ sessionID, parentSessionID, signal }) => {
    const child = await service.requireRecord(sessionID);
    if (!parentSessionID || child.parentID !== parentSessionID) {
      throw new WireError(403, 'ForbiddenError', 'This session is not a child of the caller');
    }
    const onAbort = () => { void prompting.interrupt(sessionID).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await service.waitForIdle(sessionID, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const record = await service.requireRecord(sessionID);
    const page = await chat.messages(sessionID, new URLSearchParams({ limit: '30' }));
    const reply = page.data.find((message) => message.type === 'assistant' && textOf(message) !== '');
    const failed = record.outcome === 'failed' || record.outcome === 'interrupted';
    const state = record.outcome === 'interrupted' ? 'interrupted' : failed ? 'failed' : 'completed';
    const answer = reply ? textOf(reply).slice(0, MAX_ANSWER_CHARS) : '(the agent gave no reply)';
    return {
      status: state,
      text: `<subagent sessionID="${sessionID}" state="${state}">\n${answer}\n</subagent>`,
    };
  };

  return { start, wait };
};
