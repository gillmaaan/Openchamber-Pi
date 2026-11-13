// Everything that sends input to Pi: prompts, commands, context, compaction,
// the inbox of what has been accepted but not yet delivered, and interrupt.
//
// Pi has no inbox: it takes a prompt, or queues one while it streams. The
// inbox the UI paints from is kept here, and the translator announces each
// item when Pi's own user message for it arrives.

import { compactionMessageIdAfter, thinkingLevelFromVariant } from '../wire/mapping.js';
import { ascendingId } from '../wire/ids.js';
import { PiRpcError } from '../rpc-client.js';
import { resolveCommandRun } from './commands.js';
import { conflict, invalidRequest, WireError } from './errors.js';

const COMPACT_TIMEOUT_MS = 10 * 60_000;
const NO_API_KEY = /^No API key found for the selected model\./;
const DATA_URI = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s;

const requireMessageId = (id) => {
  if (id !== undefined && (typeof id !== 'string' || !id.startsWith('msg_'))) {
    throw invalidRequest('Expected a string starting with "msg_"\n  at ["id"]', { kind: 'Payload' });
  }
};

/** What the user is told when Pi or its process refuses a prompt. */
const friendlyError = (error, directory) => {
  if (error instanceof WireError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PiRpcError && error.code === 'command_failed' && NO_API_KEY.test(message)) {
    return invalidRequest('No API key found for the selected model. Add one in Settings, Providers, or choose another model.', { kind: 'Payload' });
  }
  if (/ENOENT/.test(message) && directory) return invalidRequest(`The session folder does not exist: ${directory}`, { kind: 'Payload' });
  return invalidRequest(`The agent could not take the prompt: ${message}`, { kind: 'Payload' });
};

/**
 * Prompt `files`: a data URI becomes an inline file, anything else stays a
 * reference. Images also go to Pi as image blocks.
 */
const splitFiles = (files) => {
  const wire = [];
  const images = [];
  for (const file of Array.isArray(files) ? files : []) {
    const match = typeof file?.uri === 'string' ? DATA_URI.exec(file.uri) : null;
    if (!match) {
      if (typeof file?.uri === 'string') wire.push({ source: { type: 'uri', uri: file.uri }, mime: file.mime ?? 'application/octet-stream', ...(file.name ? { name: file.name } : {}) });
      continue;
    }
    const [, mime, data] = match;
    wire.push({ data, mime, source: { type: 'inline' }, ...(file.name ? { name: file.name } : {}), ...(file.description ? { description: file.description } : {}) });
    if (mime.startsWith('image/')) images.push({ type: 'image', data, mimeType: mime });
  }
  return { wire, images };
};

/** Non-image inline files that are text go into the prompt; Pi's prompt carries no other attachment. */
const textOfFiles = (files) => files
  .filter((file) => file.source?.type === 'inline' && !file.mime.startsWith('image/') && /^(text\/|application\/(json|xml|x-yaml|yaml))/.test(file.mime))
  .map((file) => `<attachment name="${file.name ?? 'file'}" type="${file.mime}">\n${Buffer.from(file.data, 'base64').toString('utf8')}\n</attachment>`);

/**
 * @param {object} deps
 * @param {ReturnType<import('../live-session-host.js').createLiveSessionHost>} deps.host
 * @param {ReturnType<import('./session-service.js').createSessionService>} deps.service
 * @param {ReturnType<import('./chat-runtime.js').createChatRuntime>} deps.chat
 * @param {ReturnType<import('../session-meta-store.js').createSessionMetaStore>} deps.metaStore
 * @param {ReturnType<import('../session-files.js').createSessionFileIndex>} deps.fileIndex
 * @param {(skillID: string, directory: string) => Promise<{ id: string, name: string, text: string }|null>} [deps.resolveSkill]
 * @param {(name: string, args: string, directory: string) => Promise<{ text: string, config: object }>} deps.resolveCommand
 * @param {(agent: string, directory: string) => Promise<object>} [deps.agentProfile]  The profile a command's `agent` names; throws for an unknown or disabled one.
 * @param {(providerID: string, id: string) => Promise<object|null>} [deps.findModel]  A model a command or agent names, to refuse one Pi does not offer.
 * @param {{ start: Function, finish?: Function }} [deps.jobs]  The job list `GET /api/experimental/job` serves.
 * @param {{ nameSession: (request: object) => Promise<void> }} [deps.titles]  Names a session after its first prompt, in the background.
 * @param {(record: object) => Promise<object>} [deps.getLaunch]  Start options for a new Pi process: env, extensions, approveProject, extraArgs, model.
 * @param {(sessionID: string, input: { turn: boolean }) => Promise<void>} [deps.beforeInput]  Runs before a prompt (`turn: true`) or a
 *   compaction (`turn: false`) is accepted, ahead of the inbox event: commits a staged revert and takes the work tree snapshot a turn starts from.
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 */
export const createPrompting = ({
  host,
  service,
  chat,
  metaStore,
  fileIndex,
  resolveSkill = async () => null,
  resolveCommand,
  agentProfile = async (id) => ({ id, mode: 'all' }),
  findModel,
  jobs = { start: () => {} },
  contexts = null,
  getLaunch = async () => ({}),
  titles = { nameSession: async () => {} },
  beforeInput = async () => {},
  now = () => Date.now(),
  log = () => {},
}) => {
  /** sessionID -> Map(inboxID -> inbox record) of what is accepted and not yet delivered. */
  const inboxes = new Map();
  /** sessionID -> context items admitted without waking the agent, folded into the next prompt. */
  const held = new Map();
  /** sessionID -> `provider/id:variant` last applied to the running child. */
  const applied = new Map();

  const inboxOf = (sessionID) => {
    let inbox = inboxes.get(sessionID);
    if (!inbox) {
      inbox = new Map();
      inboxes.set(sessionID, inbox);
    }
    return inbox;
  };

  const liveSession = async (record) => {
    const file = await fileIndex.get(record.id);
    return { id: record.id, cwd: record.location.directory, agent: record.agent ?? 'build', ...(file ? { file: file.path } : {}) };
  };

  /** Make the child use the model chosen for the session; start it if needed. */
  const prepare = async (record) => {
    const session = await liveSession(record);
    // A different agent needs a fresh prompt and tool set, not just a sidecar change.
    const live = host.get(record.id);
    if (live && !live.busy && (live.stale || live.agent !== session.agent)) await host.close(record.id);
    // Start options (callback token, folder trust, tools) are decided once per process.
    await host.ensure(host.get(record.id) ? session : { ...session, launch: await getLaunch(record) });
    const desired = metaStore.get(record.id)?.model;
    if (desired) {
      const key = `${desired.providerID}/${desired.id}:${desired.variant ?? ''}`;
      if (applied.get(record.id) !== key) {
        await host.request(session, 'set_model', { provider: desired.providerID, modelId: desired.id });
        const level = thinkingLevelFromVariant(desired.variant);
        if (level) await host.request(session, 'set_thinking_level', { level });
        applied.set(record.id, key);
      }
    }
    return session;
  };

  host.on('exit', ({ sessionId }) => { applied.delete(sessionId); });

  /** Take back an accepted item whose delivery failed, and say why. */
  const withdraw = (sessionID, translator, inboxID) => {
    inboxOf(sessionID).delete(inboxID);
    chat.publish(sessionID, translator.cancelInbox(inboxID));
    if (!host.get(sessionID)?.busy) service.markSettled(sessionID);
  };

  const sendToPi = async (record, translator, inboxID, message, images, delivery) => {
    try {
      const session = await prepare(record);
      const streamingBehavior = host.get(record.id)?.busy ? (delivery === 'queue' ? 'followUp' : 'steer') : undefined;
      // Pi expands a leading slash command itself, and its RPC has no way to
      // turn that off. The bridge already resolved the command, so a prompt
      // that happens to start with "/" is literal text; one leading space keeps
      // Pi's own template and extension-command pass away from it.
      const literal = message.startsWith('/') ? ` ${message}` : message;
      await host.prompt(session, { message: literal, images, streamingBehavior });
    } catch (error) {
      withdraw(record.id, translator, inboxID);
      throw friendlyError(error, record.location.directory);
    }
  };

  const accept = async (record, translator, item) => {
    const inbox = inboxOf(record.id);
    const inboxRecord = { id: item.id, sessionID: record.id, time: { created: now() }, type: item.type, payload: item.payload, delivery: item.delivery };
    inbox.set(item.id, inboxRecord);
    chat.publish(record.id, translator.enqueueInbox({ inboxID: item.id, type: item.type, ...item.payload, delivery: item.delivery }));
    service.markRunning(record.id);
    return inboxRecord;
  };

  /**
   * Accept a prompt: announce it, hand it to Pi, answer with the inbox record.
   * A repeated message id answers the original record and sends nothing.
   */
  const prompt = async (sessionID, body) => {
    await service.requireRecord(sessionID);
    requireMessageId(body.id);
    if (typeof body.text !== 'string') throw invalidRequest('Expected a string\n  at ["text"]', { kind: 'Payload' });
    const id = body.id ?? ascendingId('msg');
    const existing = inboxOf(sessionID).get(id);
    if (existing) return existing;

    const delivery = body.delivery === 'queue' ? 'queue' : 'steer';
    await beforeInput(sessionID, { turn: true });
    // Read again: a move that was running meanwhile changed the folder.
    const record = await service.requireRecord(sessionID);
    const translator = await chat.translatorFor(record);
    const { wire: files, images } = splitFiles(body.files);

    const skills = [];
    for (const requested of Array.isArray(body.skills) ? body.skills : []) {
      const skill = await resolveSkill(requested.id, record.location.directory);
      if (!skill) throw invalidRequest(`Skill not found: ${requested.id}`, { kind: undefined, field: 'skills' });
      skills.push({ id: skill.id, name: skill.name, text: skill.text, ...(requested.mention ? { mention: requested.mention } : {}) });
    }

    const payload = {
      text: body.text,
      ...(files.length ? { files } : {}),
      ...(Array.isArray(body.agents) && body.agents.length ? { agents: body.agents } : {}),
      ...(skills.length ? { skills } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    };
    const inboxRecord = await accept(record, translator, { id, type: 'user', payload, delivery });

    // Context admitted earlier without waking the agent travels with this prompt.
    const context = held.get(sessionID) ?? [];
    held.delete(sessionID);
    for (const item of context) chat.publish(sessionID, translator.deliverInbox(item.id));
    const message = [
      ...context.map((item) => item.text),
      ...skills.map((skill) => skill.text),
      ...textOfFiles(files),
      body.text,
    ].join('\n\n');
    // A session that has no file and no title yet is being named by this prompt.
    const firstPrompt = !(await fileIndex.get(sessionID)) && !metaStore.get(sessionID)?.title;
    await sendToPi(record, translator, id, message, images, delivery);
    if (firstPrompt) {
      void titles.nameSession({
        sessionID,
        directory: record.location.directory,
        text: body.text,
        model: record.model ? { providerID: record.model.providerID, id: record.model.id } : undefined,
      });
    }
    return inboxRecord;
  };

  /**
   * Context for the agent. With `resume: false` it waits and travels with the
   * next prompt; otherwise it is sent now as a prompt of its own.
   */
  const synthetic = async (sessionID, body) => {
    const record = await service.requireRecord(sessionID);
    requireMessageId(body.id);
    if (typeof body.text !== 'string') throw invalidRequest('Expected a string\n  at ["text"]', { kind: 'Payload' });
    const id = body.id ?? ascendingId('msg');
    const existing = inboxOf(sessionID).get(id);
    if (existing) return existing;

    if (body.resume !== false) return prompt(sessionID, { id, text: body.text, delivery: body.delivery, metadata: body.metadata });

    const translator = await chat.translatorFor(record);
    const payload = { text: body.text, ...(body.description ? { description: body.description } : {}), ...(body.metadata ? { metadata: body.metadata } : {}) };
    const inboxRecord = await accept(record, translator, { id, type: 'synthetic', payload, delivery: body.delivery === 'queue' ? 'queue' : 'steer' });
    // Nothing is running on its account: only the next prompt wakes the agent.
    if (!host.get(sessionID)?.busy) service.markSettled(sessionID);
    held.set(sessionID, [...(held.get(sessionID) ?? []), { id, text: body.text }]);
    return inboxRecord;
  };

  /** The last answer a command's child left, in the shape a subagent call reports. */
  const childAnswer = async (sessionID) => {
    const page = await chat.messages(sessionID, new URLSearchParams({ limit: '30' }));
    const reply = page.data.find((message) => message.type === 'assistant'
      && (message.content ?? []).some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim()));
    const text = (reply?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
    return text || '(the agent gave no reply)';
  };

  /**
   * Deliver a finished child command's report to its idle parent, as OpenCode
   * does: the report starts the parent's next turn with the parent's own
   * selection. A parent removed meanwhile has nowhere to report to.
   */
  const reportChildResult = async (parent, childID, agent, description) => {
    try {
      await service.waitForIdle(childID);
      const record = await service.requireRecord(childID);
      const state = record.outcome === 'interrupted' ? 'interrupted' : record.outcome === 'failed' ? 'failed' : 'completed';
      const named = typeof description === 'string' && description.trim()
        ? ` description="${description.trim().replace(/"/g, '&quot;')}"`
        : '';
      await prompt(parent.id, {
        text: `<subagent sessionID="${childID}" state="${state}"${named}>\n${await childAnswer(childID)}\n</subagent>`,
        metadata: { source: 'subagent', childID, agent, state },
      });
    } catch (error) {
      log(`could not deliver the result of command child ${childID}: ${error?.message ?? error}`);
    }
  };

  /** Run the command in a child session and answer at once; the report starts the parent later. */
  const runChildCommand = async (parent, run, resolved, body) => {
    const description = typeof resolved.config?.description === 'string' ? resolved.config.description : undefined;
    const child = await service.create({
      parentID: parent.id,
      ...(description?.trim() ? { title: description.trim().slice(0, 80) } : {}),
      agent: run.agent,
      ...(run.model ? { model: run.model } : {}),
      location: { directory: parent.location.directory },
    });
    jobs.start({ parentSessionID: parent.id, childSessionID: child.id, agent: run.agent, description });
    try {
      await prompt(child.id, { text: resolved.text, files: body.files, delivery: body.delivery });
    } catch (error) {
      jobs.finish?.(child.id, 'failed');
      await service.remove(child.id).catch(() => {});
      throw error;
    }
    void reportChildResult(parent, child.id, run.agent, description);
  };

  /**
   * Resolve before folding in context: Pi only expands a template at the start
   * of a prompt. The command's `agent`, `model` and `subagent` then decide the
   * run, durably for an inline command and in a child for a subagent command.
   */
  const command = async (sessionID, body) => {
    const record = await service.requireRecord(sessionID);
    if (typeof body.name !== 'string' || !body.name) throw invalidRequest('Expected a string\n  at ["name"]', { kind: 'Payload' });
    const resolved = await resolveCommand(body.name, typeof body.text === 'string' ? body.text : '', record.location.directory);
    const run = await resolveCommandRun({
      config: resolved.config,
      record,
      sessionModel: metaStore.get(sessionID)?.model ?? null,
      agentProfile: (agent) => agentProfile(agent, record.location.directory),
      findModel,
    });
    if (run.child) {
      await runChildCommand(record, run, resolved, body);
      return;
    }
    if (run.agent !== (record.agent ?? 'build')) await service.switchAgent(sessionID, { agent: run.agent });
    if (run.model) await service.switchModel(sessionID, { model: run.model });
    await prompt(sessionID, { text: resolved.text, files: body.files, agents: body.agents, skills: body.skills, delivery: body.delivery });
  };

  /** What fills the session's context besides the conversation, read from its child (started when needed). */
  const contextComposition = async (sessionID) => {
    const record = await service.requireRecord(sessionID);
    if (!contexts) throw new Error('The context view is not wired');
    return contexts.read(await prepare(record));
  };

  /** Summarize the conversation so far. Pi answers when it is done; the events carry the rest. */
  const compact = async (sessionID, body) => {
    await service.requireRecord(sessionID);
    requireMessageId(body.id);
    await beforeInput(sessionID, { turn: false });
    const record = await service.requireRecord(sessionID);
    const translator = await chat.translatorFor(record);
    const id = body.id ?? compactionMessageIdAfter(translator.lastMessageTimestamp, metaStore.get(sessionID)?.idSalt);
    const inboxRecord = await accept(record, translator, { id, type: 'compaction', payload: {}, delivery: 'steer' });
    try {
      const session = await prepare(record);
      void host.request(session, 'compact', {}, { timeoutMs: COMPACT_TIMEOUT_MS }).catch(() => {});
    } catch (error) {
      withdraw(sessionID, translator, id);
      throw friendlyError(error, record.location.directory);
    }
    return inboxRecord;
  };

  /**
   * Stop the running turn. Prompts Pi had queued behind it would otherwise run
   * on after the abort, so they are taken out of its queue: dropped, as Pi's own
   * terminal does, or with `resume` sent again once the turn has ended.
   */
  const interrupt = async (sessionID, { resume = false } = {}) => {
    const record = await service.requireRecord(sessionID);
    let parked = [];
    if (host.get(sessionID)?.busy) {
      const queue = await host.request(await liveSession(record), 'clear_queue').catch(() => null);
      parked = [...(queue?.steering ?? []), ...(queue?.followUp ?? [])];
    }
    const interrupted = await service.interrupt(sessionID);
    if (parked.length === 0) return interrupted;

    if (resume) {
      const session = await liveSession(record);
      for (const text of parked) await host.prompt(session, { message: text }).catch(() => {});
      return interrupted;
    }
    const translator = await chat.translatorFor(record);
    for (const text of parked) {
      const item = [...inboxOf(sessionID).values()].find((candidate) => candidate.type === 'user' && candidate.payload.text === text);
      if (!item) continue;
      inboxOf(sessionID).delete(item.id);
      chat.publish(sessionID, translator.cancelInbox(item.id));
    }
    return interrupted;
  };

  const inbox = async (sessionID) => {
    const record = await service.requireRecord(sessionID);
    const translator = await chat.translatorFor(record);
    const pending = new Set(translator.pendingInbox().map((item) => item.inboxID));
    return [...inboxOf(sessionID).values()].filter((item) => pending.has(item.id));
  };

  const cancelInbox = async (sessionID, inboxID) => {
    const record = await service.requireRecord(sessionID);
    const translator = await chat.translatorFor(record);
    const item = inboxOf(sessionID).get(inboxID);
    inboxOf(sessionID).delete(inboxID);
    held.set(sessionID, (held.get(sessionID) ?? []).filter((candidate) => candidate.id !== inboxID));
    // A prompt Pi already queued is taken back out of its queue; the others go back in.
    if (item?.type === 'user' && host.get(sessionID)?.busy) {
      const queue = await host.request(await liveSession(record), 'clear_queue').catch(() => null);
      const rest = [...(queue?.steering ?? []).map((text) => ({ text, behavior: 'steer' })), ...(queue?.followUp ?? []).map((text) => ({ text, behavior: 'followUp' }))]
        .filter((entry) => entry.text !== item.payload.text);
      for (const entry of rest) await host.prompt(await liveSession(record), { message: entry.text, streamingBehavior: entry.behavior }).catch(() => {});
    }
    chat.publish(sessionID, translator.cancelInbox(inboxID));
  };

  const updateInbox = async (sessionID, inboxID, body) => {
    await service.requireRecord(sessionID);
    const item = inboxOf(sessionID).get(inboxID);
    if (!item) throw conflict(`Pending input cannot change to ${body.delivery}: ${inboxID}`);
    if (body.delivery !== 'steer' && body.delivery !== 'queue') throw invalidRequest('Expected "steer" | "queue"\n  at ["delivery"]', { kind: 'Payload' });
    item.delivery = body.delivery;
    service.emit('session.inbox.delivery.changed', { sessionID, inboxID, delivery: body.delivery });
  };

  const forget = (sessionID) => {
    inboxes.delete(sessionID);
    held.delete(sessionID);
    applied.delete(sessionID);
    chat.forget(sessionID);
  };

  return { prompt, synthetic, command, compact, contextComposition, interrupt, inbox, cancelInbox, updateInbox, forget };
};
