// Instruction entries: durable notes OpenChamber attaches to a session, such
// as the project knowledge and the response style. OpenCode held them itself;
// Pi has no such store, so the sidecar does, and the gate extension asks for the
// rendered text at the start of every run and puts it in the system prompt.
//
// A change is announced to the UI once, at the next run, as a `system` notice.

import { createHash } from 'node:crypto';

import { invalidRequest, WireError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_VALUE_CHARS = 100_000;

const textOfValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const hashOf = (value) => createHash('sha256').update(textOfValue(value)).digest('hex');

/**
 * @param {object} deps
 * @param {{ get: (id: string) => object|null, patch: (id: string, fields: object) => Promise<object|null> }} deps.metaStore
 * @param {(type: string, data: object, directory?: string) => void} deps.emit
 */
export const createInstructions = ({ metaStore, emit }) => {
  /** sessionID -> { key: hash } the UI was last told about. */
  const announced = new Map();

  const entriesOf = (sessionID) => metaStore.get(sessionID)?.instructions ?? {};

  const validateKey = (key) => {
    if (!KEY_PATTERN.test(key)) throw invalidRequest('Expected a key of letters, digits, dots, dashes and underscores\n  at ["key"]', { kind: 'Params' });
  };

  const list = (sessionID) => Object.entries(entriesOf(sessionID)).map(([key, value]) => ({ key, value }));

  const put = async (sessionID, key, value) => {
    validateKey(key);
    if (value === undefined) throw invalidRequest('Expected a value\n  at ["value"]', { kind: 'Payload' });
    if (textOfValue(value).length > MAX_VALUE_CHARS) {
      throw new WireError(413, 'ValueTooLargeError', `The entry is larger than ${MAX_VALUE_CHARS} characters`, { key });
    }
    await metaStore.patch(sessionID, { instructions: { ...entriesOf(sessionID), [key]: value } });
  };

  const remove = async (sessionID, key) => {
    validateKey(key);
    const { [key]: removed, ...rest } = entriesOf(sessionID);
    if (removed === undefined) return;
    await metaStore.patch(sessionID, { instructions: Object.keys(rest).length > 0 ? rest : null });
  };

  const render = (sessionID) => Object.entries(entriesOf(sessionID))
    .map(([key, value]) => `<context key="${key}">\n${textOfValue(value)}\n</context>`)
    .join('\n');

  /**
   * The text for this run's system prompt. When the entries differ from what
   * the UI was last told, announce the change (what the UI shows as the notice
   * "Instructions updated"). A session seen for the first time is not announced:
   * the entries were part of it from the start.
   */
  const forRun = (sessionID, directory) => {
    const current = Object.fromEntries(Object.entries(entriesOf(sessionID)).map(([key, value]) => [key, hashOf(value)]));
    const previous = announced.get(sessionID);
    announced.set(sessionID, current);
    if (previous) {
      const delta = {};
      for (const [key, hash] of Object.entries(current)) if (previous[key] !== hash) delta[`api/${key}`] = hash;
      for (const key of Object.keys(previous)) if (!(key in current)) delta[`api/${key}`] = 'removed';
      if (Object.keys(delta).length > 0) emit('session.instructions.updated', { sessionID, delta, text: render(sessionID) }, directory);
    }
    return render(sessionID);
  };

  const forget = (sessionID) => { announced.delete(sessionID); };

  return { list, put, remove, render, forRun, forget };
};
