// Helpers for tests that replay a recorded Pi session (wire/fixtures/*.json)
// through the translator the way the coordinator drives it: it enqueues each
// prompt when it accepts it, then feeds every Pi event in order.

import fs from 'node:fs';

import { activeBranch } from '../../session-files.js';
import { createIdMinter } from '../ids.js';
import { compactionMessageIdAfter } from '../mapping.js';
import { createEventTranslator } from '../translator.js';

const fixturesDir = new URL('../fixtures/', import.meta.url);

export const FIXTURE_NAMES = fs.readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

export const loadFixture = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, fixturesDir), 'utf8'));

const textOf = (message) => (typeof message.content === 'string'
  ? message.content
  : message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'));

const filesOf = (message) => (Array.isArray(message.content)
  ? message.content.filter((block) => block.type === 'image').map((block) => ({ data: block.data, mime: block.mimeType, source: { type: 'inline' } }))
  : []);

/**
 * Feeds `fixture.events` to a translator.
 *
 * - A user message at the start of a cycle was enqueued before `agent_start`; a
 *   steered or queued one when Pi's `queue_update` listed it.
 * - A manual compaction was enqueued with the id the stored transcript derives.
 *
 * @returns {{ translator, wireEvents: object[], clientIds: Record<string,string>, enqueued: string[] }}
 *   `wireEvents` carry an envelope like the hub would add: `id`, `created`.
 */
export const replayFixture = (fixture, { thinkingLevel = 'low', totals } = {}) => {
  let clock = 1_700_000_000_000;
  const clientIds = {};
  const translator = createEventTranslator({
    sessionId: 'ses_fixture',
    cwd: fixture.cwd,
    totals,
    getThinkingLevel: () => thinkingLevel,
    now: () => clock,
    onClientId: ({ timestamp, id }) => { clientIds[timestamp] = id; },
  });

  const wireEvents = [];
  const enqueued = [];
  const emit = (events) => {
    for (const wire of events) {
      clock += 10;
      wireEvents.push({ ...wire, id: `evt_${String(wireEvents.length + 1).padStart(6, '0')}`, created: clock });
    }
  };
  // The UI mints a message id a few milliseconds before Pi stamps the message,
  // in the same id format (`ascendingId("msg")`).
  const mintUiId = (piTimestamp) => createIdMinter({ now: () => piTimestamp - 4, random: () => `UiMinted${String(enqueued.length).padStart(6, '0')}` }).ascending('msg');
  const enqueue = (text, files = [], piTimestamp = clock) => {
    const inboxID = mintUiId(piTimestamp);
    enqueued.push(text);
    emit(translator.enqueueInbox({ inboxID, text, files: files.length > 0 ? files : undefined }));
  };

  const events = fixture.events;
  const userStarts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'message_start' && event.message.role === 'user');
  const queuedSeen = new Set();

  events.forEach((event, index) => {
    if (event.type === 'agent_start') {
      const next = userStarts.find((start) => start.index > index);
      const nextAssistant = events.findIndex((candidate, at) => at > index && candidate.type === 'message_start' && candidate.message.role === 'assistant');
      if (next && (nextAssistant === -1 || next.index < nextAssistant) && !queuedSeen.has(next.index)) {
        queuedSeen.add(next.index);
        enqueue(textOf(next.event.message), filesOf(next.event.message), next.event.message.timestamp);
      }
    }
    if (event.type === 'queue_update') {
      for (const text of [...event.steering, ...event.followUp]) {
        const start = userStarts.find((candidate) => candidate.index > index && !queuedSeen.has(candidate.index) && textOf(candidate.event.message) === text);
        if (start) {
          queuedSeen.add(start.index);
          enqueue(text, [], start.event.message.timestamp);
        }
      }
    }
    if (event.type === 'compaction_start' && event.reason === 'manual') {
      emit(translator.enqueueInbox({ inboxID: compactionMessageIdAfter(translator.lastMessageTimestamp), type: 'compaction' }));
    }
    emit(translator.onPiEvent(event));
  });

  return { translator, wireEvents, clientIds, enqueued };
};

export const branchOf = (fixture) => activeBranch(fixture.entries);
