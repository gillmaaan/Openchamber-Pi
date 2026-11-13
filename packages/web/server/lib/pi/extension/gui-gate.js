// OpenChamber's permission gate and `question` tool for a Pi child.
//
// Pi has no permission system and no question tool. This extension adds both
// and leaves every decision to the OpenChamber bridge that started the child:
//
// - A `tool_call` hook asks the bridge before every tool call (built-ins, MCP
//   and extension tools, and each call a codemode script makes) and blocks the
//   call when the answer is no. It fails closed: no bridge address, a refused
//   connection, a bad answer or an error all block with a reason.
// - The `question` tool asks the user through the bridge, which shows a form.
// - `globalThis.__openchamberPiPermission(request)` is installed for the
//   managed tools (agent-tool/PI-EXTENSION.md); it rejects by throwing.
//
// Environment: OPENCHAMBER_PI_BRIDGE_URL, the bridge's loopback address, and
// OPENCHAMBER_PI_BRIDGE_TOKEN, the bearer token of this child. Both calls are
// `POST /_pi/permission` and `POST /_pi/form` with `{ sessionID, toolCallId,
// ... }`; the bridge holds the response until the user answers.
//
// The calls use node:http, not fetch: Pi installs a global dispatcher that ends
// a request with no response after its idle timeout (5 minutes by default),
// and a card waits as long as the user takes. The abort signal of the call (an
// RPC `abort`) is passed to the request, so an unanswered question never keeps
// the turn from ending.
//
// No bare imports: Pi's loader needs nothing but Node's own modules here.

import http from 'node:http';

const REJECTED = 'The user rejected this tool call.';
const INTERRUPTED = 'Tool execution interrupted';

const QUESTION_DESCRIPTION = [
  'Ask the user one or more questions and wait for the answers.',
  'Use it to gather preferences or requirements, clarify an ambiguous instruction, get a decision on an implementation choice, or offer the user a direction to take.',
  'The user can always type their own answer, so do not add an "Other" option.',
  'Answers come back as lists of labels; set `multiple` to let the user pick more than one.',
  'If you recommend an option, put it first and end its label with "(Recommended)".',
].join('\n');

const QUESTION_PARAMETERS = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Questions to ask the user',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The complete question' },
          header: { type: 'string', description: 'A very short label for the question (at most 30 characters)' },
          options: {
            type: 'array',
            description: 'The choices on offer',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The choice, 1-5 words' },
                description: { type: 'string', description: 'What the choice means' },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
          multiple: { type: 'boolean', description: 'Allow selecting several choices' },
        },
        required: ['question', 'header', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

// The callback is loopback; a configured proxy must never see its token.
const exemptBridgeFromProxy = () => {
  const endpoint = process.env.OPENCHAMBER_PI_BRIDGE_URL;
  if (!endpoint || !URL.canParse(endpoint)) return;
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const entries = (process.env[key] || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(',');
  }
};

/** One POST to the bridge. Resolves `{ status, body }` (`body` is null when the answer is not JSON). */
const post = (route, payload, signal) => new Promise((resolve, reject) => {
  const base = process.env.OPENCHAMBER_PI_BRIDGE_URL;
  const token = process.env.OPENCHAMBER_PI_BRIDGE_TOKEN;
  if (!base || !token || !URL.canParse(route, base)) {
    reject(new Error('the bridge address or token is missing'));
    return;
  }
  const text = JSON.stringify(payload);
  const request = http.request(new URL(route, base), {
    method: 'POST',
    agent: false,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    },
    signal,
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      resolve({ status: response.statusCode, body });
    });
  });
  request.on('error', reject);
  request.end(text);
});

const describeError = (error) => (error instanceof Error ? error.message : String(error));

/** `{ allowed: true }` or `{ allowed: false, message }`. Anything but a plain yes is a no. */
const askPermission = async (payload, signal) => {
  let response;
  try {
    response = await post('/_pi/permission', payload, signal);
  } catch (error) {
    if (signal?.aborted) return { allowed: false, message: INTERRUPTED };
    return { allowed: false, message: `OpenChamber could not reach its permission service (${describeError(error)}), so this tool call was blocked.` };
  }
  if (response.status === 200 && response.body?.allowed === true) return { allowed: true };
  if (response.status === 200 && response.body?.allowed === false) {
    return { allowed: false, message: typeof response.body.message === 'string' && response.body.message !== '' ? response.body.message : REJECTED };
  }
  return { allowed: false, message: `OpenChamber's permission service answered ${response.status}, so this tool call was blocked.` };
};

const sessionIdOf = (ctx) => {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (typeof id !== 'string' || id === '') return null;
  // Pi CLI files keep their UUID; callbacks use the same id as the bridge's session list.
  return id.startsWith('ses') ? id : `ses_${id}`;
};

/** What this child sends the model besides the conversation: the prompt and the tools it is offered. */
const contextSnapshot = (pi, ctx) => {
  const hidden = new Set(ctx.getSystemPromptOptions().hiddenTools ?? []);
  const active = new Set(pi.getActiveTools());
  return {
    systemPrompt: ctx.getSystemPrompt(),
    tools: pi.getAllTools()
      .filter((tool) => active.has(tool.name) && !hidden.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, source: tool.sourceInfo ?? null })),
  };
};

const failure = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

export default (pi) => {
  exemptBridgeFromProxy();

  pi.on('session_start', () => {
    const raw = process.env.OPENCHAMBER_PI_DEFAULT_TOOLS;
    if (raw === undefined) return;
    const defaults = JSON.parse(raw);
    if (!Array.isArray(defaults) || !defaults.every((name) => typeof name === 'string')) {
      throw new Error('Invalid OpenChamber default tool selection');
    }
    // Pi restores a transcript's old agent loadout. Reset its core tools while
    // leaving extension activation and MCP exposure under Pi's ownership.
    const builtins = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
    const activeExtensions = pi.getActiveTools().filter((name) => !builtins.has(name));
    const patterns = defaults.map((pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
    const configured = pi.getAllTools().filter((tool) => patterns.some((pattern) => pattern.test(tool.name))).map((tool) => tool.name);
    pi.setActiveTools([...new Set([...activeExtensions, ...configured])]);
  });

  pi.on('tool_call', async (event, ctx) => {
    const sessionID = sessionIdOf(ctx);
    if (!sessionID) return { block: true, reason: 'OpenChamber could not tell which session made this tool call, so it was blocked.' };
    const answer = await askPermission({
      sessionID,
      toolCallId: event.toolCallId,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      tool: event.toolName,
      input: event.input,
    }, ctx.signal);
    return answer.allowed ? undefined : { block: true, reason: answer.message };
  });

  // The bridge asks what fills the context (`GET /api/session/:id/context-composition`)
  // with this command and an id. It runs at once, also while a turn streams,
  // and adds nothing to the conversation; the answer goes back as a request.
  pi.registerCommand('openchamber-context', {
    description: 'Report to OpenChamber what fills the context (used by its context view)',
    handler: async (args, ctx) => {
      const requestId = String(args ?? '').trim();
      const sessionID = sessionIdOf(ctx);
      if (!requestId || !sessionID) return;
      try {
        await post('/_pi/context', { sessionID, requestId, snapshot: contextSnapshot(pi, ctx) });
      } catch { /* the bridge's request times out and tells its caller */ }
    },
  });

  // Notes OpenChamber attached to the session (project knowledge, response
  // style) join the system prompt as one section. They are context, not a
  // safety decision: when the bridge cannot be reached the run goes on without.
  pi.on('before_agent_start', async (event, ctx) => {
    const sessionID = sessionIdOf(ctx);
    const sections = event.systemPromptOptions?.sections;
    if (!sessionID || !sections) return;
    let text = '';
    try {
      const response = await post('/_pi/instructions', { sessionID }, ctx.signal);
      if (response.status === 200 && typeof response.body?.text === 'string') text = response.body.text;
    } catch { /* leave the section as it is */ return; }
    if (text) sections['openchamber-context'] = text;
    else delete sections['openchamber-context'];
  });

  // The managed tools ask this for what the tool_call hook cannot see: the
  // command line of a secret.run call. A refusal is a throw.
  globalThis.__openchamberPiPermission = async (request) => {
    const answer = await askPermission({
      sessionID: request.sessionID,
      toolCallId: request.toolCallId,
      tool: request.tool,
      action: request.action,
      resources: request.resources,
      ...(Array.isArray(request.save) ? { save: request.save } : {}),
    }, request.signal);
    if (!answer.allowed) throw new Error(answer.message);
  };

  pi.registerTool({
    name: 'question',
    label: 'Question',
    description: QUESTION_DESCRIPTION,
    parameters: QUESTION_PARAMETERS,
    exposure: 'direct',
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionID = sessionIdOf(ctx);
      if (!sessionID) return failure('OpenChamber could not tell which session asked this question.');
      let response;
      try {
        response = await post('/_pi/form', {
          sessionID,
          toolCallId,
          ...(toolCallId.includes('/') ? { parentToolCallId: toolCallId.slice(0, toolCallId.indexOf('/')) } : {}),
          questions: params.questions,
        }, signal);
      } catch (error) {
        if (signal?.aborted) return failure(INTERRUPTED, { interrupted: true });
        return failure(`OpenChamber could not show this question (${describeError(error)}).`);
      }
      const body = response.body;
      if (response.status === 200 && body?.status === 'answered' && typeof body.text === 'string') {
        return { content: [{ type: 'text', text: body.text }], details: { answers: body.answers, truncated: false } };
      }
      if (response.status === 200 && body?.status === 'dismissed' && typeof body.message === 'string') {
        return failure(body.message, { dismissed: true });
      }
      return failure(`OpenChamber could not show this question (it answered ${response.status}).`);
    },
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Hand a self-contained task to another agent and get its answer back. It runs in a session of its own that the user can open.',
      'Agents: general (default; can read, search and change files and run commands) and explore (read-only search of the codebase).',
      'Give it everything it needs in the prompt, it does not see this conversation. Several calls in one reply run in parallel.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'general or explore; default general' },
        description: { type: 'string', description: 'Three to five words naming the task; it becomes the session title' },
        prompt: { type: 'string', description: 'The complete task for the agent' },
        model: { type: 'string', description: 'provider/id, only when the user asks; default this session\'s model' },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    exposure: 'direct',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const sessionID = sessionIdOf(ctx);
      if (!sessionID) return failure('OpenChamber could not tell which session made this call.');
      let started;
      try {
        started = await post('/_pi/subagent/start', {
          sessionID,
          toolCallId,
          agent: params.agent,
          description: params.description,
          prompt: params.prompt,
          model: params.model,
        }, signal);
      } catch (error) {
        if (signal?.aborted) return failure(INTERRUPTED, { interrupted: true });
        return failure(`OpenChamber could not start the agent (${describeError(error)}).`);
      }
      const childSessionID = started.body?.sessionID;
      if (started.status !== 200 || typeof childSessionID !== 'string') {
        return failure(typeof started.body?.message === 'string' ? started.body.message : `OpenChamber could not start the agent (it answered ${started.status}).`);
      }
      onUpdate?.({ content: [{ type: 'text', text: 'The agent is working.' }], details: { sessionID: childSessionID, status: 'running' } });
      let finished;
      try {
        finished = await post('/_pi/subagent/wait', { sessionID, toolCallId, childSessionID }, signal);
      } catch (error) {
        if (signal?.aborted) return failure(INTERRUPTED, { interrupted: true, sessionID: childSessionID, status: 'interrupted' });
        return failure(`OpenChamber lost the agent (${describeError(error)}).`, { sessionID: childSessionID });
      }
      if (finished.status === 200 && typeof finished.body?.text === 'string') {
        return { content: [{ type: 'text', text: finished.body.text }], details: { sessionID: childSessionID, status: finished.body.status ?? 'completed' } };
      }
      return failure(`OpenChamber could not read the agent's answer (it answered ${finished.status}).`, { sessionID: childSessionID });
    },
  });
};
