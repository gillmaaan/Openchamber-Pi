// Forms for the Pi bridge. OpenCode's `question` tool shows the user a typed
// form; Pi has no such tool, so the gate extension (`../extension/gui-gate.js`)
// registers one that calls back here and waits.
//
// `createFormManager({ hub, getContext, resolveSource })`
//   hub            The event hub; `form.created|replied|cancelled` go out through it.
//   getContext     `(sessionID) => { directory } | null`; `null` is an unknown session.
//   resolveSource  `(sessionID, toolCallId) => { messageID } | undefined`, or a
//                  promise of it: the assistant message that holds the tool
//                  call (the wire order is `tool.called`, then `form.created`),
//                  waited for at most `sourceWaitMs` (2 s). Without it the
//                  form carries no `metadata.tool`.
//
// `ask({ sessionID, toolCallId, parentToolCallId?, questions, signal })`
//   `questions` is the `question` tool's input: `[{ question, header, options:
//   [{ label, description }], multiple? }]`. It emits `form.created` and waits.
//   Resolves `{ status: 'answered', answers, answer, text }`, where `answers`
//   holds one list per question (empty when unanswered) and `text` is the
//   tool's result, or `{ status: 'dismissed', message }` when the user
//   cancelled or `signal` aborted first. A form dropped by `signal` emits
//   `form.cancelled`, so no client keeps a card nobody can answer.
//
// `reply(sessionID, formID, answer)`, `cancel(sessionID, formID, { message? })`,
// `listPending({ directory?, sessionID? })`, `get(sessionID, formID)`.
//   A settled form answers `get` with its state for a while and gives
//   `FormAlreadySettledError` to a second reply or cancel. An unknown id is a
//   `FormNotFoundError`.

import { ascendingId } from '../wire/ids.js';
import { formAlreadySettled, formInvalidAnswer, formNotFound, invalidRequest, sessionNotFound } from './errors.js';
import { lookupSource, SOURCE_WAIT_MS } from './request-source.js';

export const DISMISSED_MESSAGE = 'The user dismissed this question';
const INTERRUPTED_MESSAGE = 'Tool execution interrupted';
const MAX_SETTLED_FORMS = 200;

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';

/** The tool input as typed fields, or a `InvalidRequestError` naming what is wrong. */
const fieldsFor = (questions) => {
  if (!Array.isArray(questions) || questions.length === 0) throw invalidRequest('Expected at least one question', { kind: 'Payload', field: 'questions' });
  return questions.map((entry, index) => {
    const at = `questions[${index}]`;
    if (!isPlainRecord(entry) || !isText(entry.question) || typeof entry.header !== 'string') {
      throw invalidRequest(`${at} needs a question and a header`, { kind: 'Payload', field: 'questions' });
    }
    const options = Array.isArray(entry.options) ? entry.options : [];
    if (!options.every((option) => isPlainRecord(option) && isText(option.label))) {
      throw invalidRequest(`${at}.options needs a label on every option`, { kind: 'Payload', field: 'questions' });
    }
    return {
      key: `q${index}`,
      title: entry.header,
      description: entry.question,
      type: entry.multiple === true ? 'multiselect' : 'string',
      options: options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      })),
      custom: true,
    };
  });
};

/** The first thing wrong with an answer, as the message of a `FormInvalidAnswerError`, or null. */
const answerProblem = (fields, answer) => {
  if (!isPlainRecord(answer)) return 'Expected an object of answers';
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(answer)) {
    const field = byKey.get(key);
    if (!field) return `Unexpected form field: ${key}`;
    const choices = field.options.map((option) => option.value);
    if (field.type === 'multiselect') {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return `Expected array of strings for form field: ${key}`;
      if (!field.custom && !value.every((item) => choices.includes(item))) return `Expected only listed options for form field: ${key}`;
    } else {
      if (typeof value !== 'string') return `Expected string for form field: ${key}`;
      if (!field.custom && value !== '' && !choices.includes(value)) return `Expected one of the listed options for form field: ${key}`;
    }
  }
  return null;
};

const answersOf = (fields, answer) => fields.map((field) => {
  const value = answer[field.key];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value !== '' ? [value] : [];
});

/** The tool's result text, as OpenCode words it. */
const answerText = (fields, answers) => {
  const parts = fields.map((field, index) => `"${field.description}"="${answers[index].length > 0 ? answers[index].join(', ') : 'Unanswered'}"`);
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
};

/**
 * @param {object} deps  See the header.
 */
export const createFormManager = ({ hub, getContext, resolveSource = () => undefined, sourceWaitMs = SOURCE_WAIT_MS }) => {
  /** formID -> { form, directory, settle(outcome), onAbort } */
  const pending = new Map();
  /** formID -> { form, state }, oldest first */
  const settled = new Map();

  const rememberSettled = (form, state) => {
    settled.set(form.id, { form, state });
    if (settled.size > MAX_SETTLED_FORMS) settled.delete(settled.keys().next().value);
  };

  const ask = async ({ sessionID, toolCallId, parentToolCallId, questions, signal }) => {
    const context = getContext(sessionID);
    if (!context) throw sessionNotFound(sessionID);
    const fields = fieldsFor(questions);
    if (signal?.aborted) return { status: 'dismissed', message: INTERRUPTED_MESSAGE };

    const source = await lookupSource(resolveSource, sessionID, parentToolCallId ?? toolCallId, sourceWaitMs);
    if (signal?.aborted) return { status: 'dismissed', message: INTERRUPTED_MESSAGE };

    const form = {
      id: ascendingId('frm'),
      sessionID,
      title: 'Questions',
      metadata: { kind: 'question', ...(source?.messageID ? { tool: { messageID: source.messageID, id: parentToolCallId ?? toolCallId } } : {}) },
      fields,
    };
    const location = { directory: context.directory };
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!pending.delete(form.id)) return;
        const message = INTERRUPTED_MESSAGE;
        rememberSettled(form, { status: 'cancelled', message });
        hub.emit({ type: 'form.cancelled', data: { id: form.id, sessionID }, location });
        resolve({ status: 'dismissed', message });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(form.id, {
        form,
        directory: context.directory,
        settle: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      });
      hub.emit({ type: 'form.created', data: { form }, location });
    });
  };

  const claim = (sessionID, formID) => {
    const entry = pending.get(formID);
    if (entry && entry.form.sessionID === sessionID) return entry;
    if (settled.get(formID)?.form.sessionID === sessionID) throw formAlreadySettled(formID);
    throw formNotFound(formID);
  };

  const reply = (sessionID, formID, answer) => {
    const entry = claim(sessionID, formID);
    const problem = answerProblem(entry.form.fields, answer);
    if (problem) throw formInvalidAnswer(formID, problem);
    pending.delete(formID);
    rememberSettled(entry.form, { status: 'answered', answer });
    hub.emit({ type: 'form.replied', data: { id: formID, sessionID, answer }, location: { directory: entry.directory } });
    const answers = answersOf(entry.form.fields, answer);
    entry.settle({ status: 'answered', answers, answer, text: answerText(entry.form.fields, answers) });
  };

  const cancel = (sessionID, formID, { message } = {}) => {
    const entry = claim(sessionID, formID);
    pending.delete(formID);
    rememberSettled(entry.form, { status: 'cancelled', ...(message ? { message } : {}) });
    hub.emit({ type: 'form.cancelled', data: { id: formID, sessionID }, location: { directory: entry.directory } });
    entry.settle({ status: 'dismissed', message: message || DISMISSED_MESSAGE });
  };

  const listPending = ({ directory, sessionID } = {}) => [...pending.values()]
    .filter((entry) => (directory === undefined || entry.directory === directory) && (sessionID === undefined || entry.form.sessionID === sessionID))
    .map((entry) => structuredClone(entry.form));

  /** The form with its `state`, or null when this session never had it (or it fell out of memory). */
  const get = (sessionID, formID) => {
    const entry = pending.get(formID);
    if (entry && entry.form.sessionID === sessionID) return { ...structuredClone(entry.form), state: { status: 'pending' } };
    const done = settled.get(formID);
    if (done && done.form.sessionID === sessionID) return { ...structuredClone(done.form), state: structuredClone(done.state) };
    return null;
  };

  return { ask, reply, cancel, listPending, get };
};
