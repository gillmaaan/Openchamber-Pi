// The consistency check of the wire layer: a session seen live (translator
// events folded by the UI's own reducer) and the same session read back from
// Pi's file (entriesToWireMessages projected by the UI's own projection) must
// end up as the same messages, parts, tool states, usage and finish.
//
// Both halves are the UI's real code (`@openchamber/ui` is aliased to
// packages/ui/src in vitest), so a shape the UI does not accept fails here.

import { describe, expect, it } from 'vitest';

import { translateWireEvent } from '@openchamber/ui/lib/opencode/events.ts';
import { projectMessage } from '@openchamber/ui/lib/opencode/projection.ts';
import { withoutUnshownResult } from '@openchamber/ui/lib/opencode/toolContentShells.ts';
import { applyDirectoryEvent } from '@openchamber/ui/sync/event-reducer.ts';
import { INITIAL_STATE } from '@openchamber/ui/sync/types.ts';

import { activeBranch } from '../session-files.js';
import { loadWireSchemas } from './test-support/opencode-schema.js';
import { FIXTURE_NAMES, loadFixture, replayFixture } from './test-support/replay.js';
import { appendInflight, entriesToWireMessages } from './transcript.js';

const SESSION_ID = 'ses_fixture';

const newDraft = () => ({
  ...INITIAL_STATE,
  session: [{
    id: SESSION_ID, projectID: 'p', directory: '/work/project', title: '', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }],
  message: {},
  part: {},
  session_status: {},
  permission: {},
  form: {},
  sessionEventRevision: {},
  sessionDeletedRevision: {},
});

const foldLive = (draft, wireEvents) => {
  for (const { type, data, id, created } of wireEvents) {
    for (const syncEvent of translateWireEvent({ id, created, type, data })) applyDirectoryEvent(draft, syncEvent);
  }
};

// What the two halves legitimately differ in: wall-clock times (the hub stamps
// live ones, the file has Pi's), and private reducer bookkeeping.
const STRIP = new Set(['time', 'closedLocally', '__dedupeNextDeltaFields', 'sessionID', 'messageID']);
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([key, entry]) => !STRIP.has(key) && entry !== undefined);
    return Object.fromEntries(entries.map(([key, entry]) => [key, key === 'metadata' && entry && Object.keys(entry).length === 0 ? undefined : normalize(entry)]).filter(([, entry]) => entry !== undefined));
  }
  return value;
};

// The live reducer leaves the result of a finished `read` out of the store the
// moment the call ends (`withoutUnshownResult`); a stored page gets the same
// treatment from the server's part shells, so the stored side gets it here.
const shelled = (parts) => parts.map((part) => (part.type === 'tool' ? withoutUnshownResult(part) : part));
const projectOne = (wire) => {
  const projected = projectMessage(wire, SESSION_ID);
  return { ...projected, parts: shelled(projected.parts) };
};
const project = (wireMessages) => new Map(wireMessages.map(projectOne).map((projected) => [projected.message.id, projected]));

const compared = new Set(['user', 'assistant']);

/** The entries Pi had appended to the session file after `events` (it writes a message when it ends). */
const persistedEntries = (fixture, events) => {
  const ended = new Set(events.filter((event) => event.type === 'message_end').map((event) => `${event.message.role}:${event.message.timestamp}`));
  const written = [];
  for (const entry of fixture.entries) {
    if (entry.type === 'message' && entry.message.role !== 'system' && !ended.has(`${entry.message.role}:${entry.message.timestamp}`)) break;
    written.push(entry);
  }
  return written;
};

describe('live events and the stored file agree', () => {
  it.each(FIXTURE_NAMES)('%s: same messages, parts, tool states, usage and finish', (name) => {
    const fixture = loadFixture(name);
    const { wireEvents, clientIds } = replayFixture(fixture);

    const draft = newDraft();
    foldLive(draft, wireEvents);
    const live = draft.message[SESSION_ID] ?? [];

    const storedWire = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd, clientIds });
    const stored = project(storedWire);

    const storedIds = storedWire.filter((wire) => compared.has(wire.type)).map((wire) => wire.id);
    const liveIds = live.filter((message) => compared.has(message.role)).map((message) => message.id);
    expect(liveIds).toEqual(storedIds);

    for (const message of live.filter((candidate) => compared.has(candidate.role))) {
      const projected = stored.get(message.id);
      expect(projected, `stored copy of ${message.id}`).toBeDefined();
      expect(normalize(message), `${message.role} ${message.id}`).toEqual(normalize(projected.message));
      expect(normalize(draft.part[message.id] ?? []), `parts of ${message.role} ${message.id}`).toEqual(normalize(projected.parts));
    }
  });

  it.each(FIXTURE_NAMES)('%s: the run outcome and the usage totals agree', (name) => {
    const fixture = loadFixture(name);
    const { wireEvents, clientIds, translator } = replayFixture(fixture);
    const draft = newDraft();
    foldLive(draft, wireEvents);
    const storedWire = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd, clientIds });
    const lastIdle = storedWire.filter((wire) => wire.type === 'idle').at(-1);
    if (lastIdle) expect(draft.session[0].outcome).toBe(lastIdle.outcome);
    expect(draft.session_status[SESSION_ID]).toEqual({ type: 'idle' });
    const totals = translator.totals();
    expect(draft.session[0].cost).toBe(totals.cost);
    expect(draft.session[0].tokens).toEqual(totals.tokens);
  });

  it.each(FIXTURE_NAMES)('%s: the idle message of each run has the id the live terminal event announced', (name) => {
    const fixture = loadFixture(name);
    const { wireEvents, clientIds } = replayFixture(fixture);
    const announced = wireEvents.filter((event) => event.idleMessage).map((event) => event.idleMessage.id);
    const stored = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd, clientIds }).filter((wire) => wire.type === 'idle').map((wire) => wire.id);
    expect(announced).toEqual(stored);
  });

  it('compaction: the live record and the stored one are the same message', () => {
    const fixture = loadFixture('compaction');
    const { wireEvents, clientIds } = replayFixture(fixture);
    const draft = newDraft();
    foldLive(draft, wireEvents);
    const live = draft.message[SESSION_ID].find((message) => message.role === 'compaction');
    const stored = entriesToWireMessages({ entries: activeBranch(fixture.entries), cwd: fixture.cwd, clientIds }).find((wire) => wire.type === 'compaction');
    expect(live.id).toBe(stored.id);
    const { message } = projectMessage(stored, SESSION_ID);
    expect(normalize({ ...live, metadata: undefined })).toEqual(normalize({ ...message, metadata: undefined }));
    expect(live.status).toBe('completed');
  });

  it.each(FIXTURE_NAMES)('%s: a page read at any moment agrees with what the live events built so far', async (name) => {
    const { decodeMessage } = await loadWireSchemas();
    const fixture = loadFixture(name);
    let compared = 0;
    const seenStates = new Set();

    // Re-feed the events one at a time, as the coordinator would, and at each
    // point compare the open step's message in the UI store with the message a
    // page read would serve: the file as far as Pi wrote it, plus the
    // translator's in-flight message.
    for (let upTo = 1; upTo <= fixture.events.length; upTo += 1) {
      const prefix = { ...fixture, events: fixture.events.slice(0, upTo) };
      const replay = replayFixture(prefix);
      const open = replay.translator.inflightAssistantMessage();
      if (!open) continue;
      compared += 1;
      expect(() => decodeMessage(open), `in-flight message after event ${upTo}`).not.toThrow();

      const draft = newDraft();
      foldLive(draft, replay.wireEvents);
      const liveMessage = (draft.message[SESSION_ID] ?? []).find((message) => message.id === open.id);
      expect(liveMessage, `the UI holds ${open.id} after event ${upTo}`).toBeDefined();

      const written = persistedEntries(fixture, prefix.events);
      const page = appendInflight(entriesToWireMessages({ entries: activeBranch(written), cwd: fixture.cwd, clientIds: replay.clientIds, running: true }), open);
      const served = projectOne(page.find((message) => message.id === open.id));

      const liveParts = draft.part[open.id] ?? [];
      expect(served.parts.map((part) => part.id), `part ids after event ${upTo}`).toEqual(liveParts.map((part) => part.id));
      served.parts.forEach((part, index) => {
        const livePart = liveParts[index];
        if (part.type === 'tool') {
          seenStates.add(part.state.status);
          // A page shows the tool call as the live events left it.
          expect(normalize(part), `${part.id} after event ${upTo}`).toEqual(normalize(livePart));
        } else if (livePart.time?.end !== undefined) {
          expect(part.text, `${part.id} after event ${upTo}`).toBe(livePart.text);
        } else {
          // A block still streaming is empty in a page read until it ends.
          expect(part.text, `${part.id} after event ${upTo}`).toBe('');
        }
      });
      expect(normalize(served.message)).toMatchObject(normalize({ id: liveMessage.id, role: 'assistant', agent: liveMessage.agent, providerID: liveMessage.providerID, modelID: liveMessage.modelID, variant: liveMessage.variant }));
    }
    expect(compared).toBeGreaterThan(0);
    if (name === 'tool-steps') expect([...seenStates].sort()).toEqual(['completed', 'error', 'pending', 'running']);
  });
});

describe('a Pi process that dies mid-turn', () => {
  // A recorded stream cut off at `cutAfter`, then the exit the coordinator reports.
  const crash = (name, cutAfter) => {
    const fixture = loadFixture(name);
    const index = fixture.events.findIndex(cutAfter);
    expect(index, `cut point in ${name}`).toBeGreaterThan(-1);
    const cut = { ...fixture, events: fixture.events.slice(0, index + 1) };
    const replay = replayFixture(cut);
    const exitEvents = replay.translator.onProcessExit({ code: null, signal: 'SIGKILL' });
    const wireEvents = [...replay.wireEvents, ...exitEvents.map((event, at) => ({ ...event, id: `evt_x${at}`, created: 1_800_000_000_000 + at }))];
    const draft = newDraft();
    foldLive(draft, wireEvents);
    const stored = entriesToWireMessages({ entries: activeBranch(persistedEntries(fixture, cut.events)), cwd: fixture.cwd, clientIds: replay.clientIds });
    return { fixture, replay, exitEvents, wireEvents, draft, stored };
  };

  const secondStep = (event, nth) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && nth;

  it.each([
    ['mid-text', 'reasoning-bash', (() => { let seen = 0; return (event) => { if (event.type === 'message_start' && event.message.role === 'assistant') seen += 1; return seen === 2 && secondStep(event, true); }; })()],
    ['mid-tool', 'reasoning-bash', (event) => event.type === 'tool_execution_start'],
    ['parallel tools', 'tool-steps', (event) => event.type === 'tool_execution_start' && event.toolCallId === 'call_0_1'],
  ])('%s: the UI ends with an idle, failed session and no open message', async (_label, name, cutAfter) => {
    const { checkEvent, decodeMessage } = await loadWireSchemas();
    const { exitEvents, draft } = crash(name, cutAfter);
    for (const event of exitEvents) {
      expect(() => checkEvent(event), `${event.type}`).not.toThrow();
      if (event.idleMessage) expect(() => decodeMessage(event.idleMessage)).not.toThrow();
    }
    expect(exitEvents.at(-1).type).toBe('session.execution.failed');
    expect(exitEvents.at(-1).idleMessage).toMatchObject({ outcome: 'failed', error: { type: 'provider.transport' } });
    expect(draft.session_status[SESSION_ID]).toEqual({ type: 'idle' });
    expect(draft.session[0].outcome).toBe('failed');
    for (const message of draft.message[SESSION_ID].filter((candidate) => candidate.role === 'assistant')) {
      expect(message.time.completed, `${message.id} is closed`).toBeDefined();
      expect(message.finish, `${message.id} has a finish`).toBeDefined();
    }
    for (const parts of Object.values(draft.part)) {
      for (const part of parts.filter((candidate) => candidate.type === 'tool')) expect(['completed', 'error']).toContain(part.state.status);
      for (const part of parts.filter((candidate) => candidate.type === 'text' || candidate.type === 'reasoning')) expect(part.time?.end, `${part.id} is ended`).toBeDefined();
    }
  });

  it('mid-text: the message that never reached the file shows the partial text with the error until a reload', () => {
    let seen = 0;
    const { draft, stored } = crash('reasoning-bash', (event) => {
      if (event.type === 'message_start' && event.message.role === 'assistant') seen += 1;
      return seen === 2 && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta';
    });
    const live = draft.message[SESSION_ID].filter((message) => message.role === 'assistant');
    expect(live).toHaveLength(2);
    const open = live[1];
    expect(open).toMatchObject({ finish: 'error', error: { type: 'provider.transport', message: 'The agent process stopped unexpectedly (signal SIGKILL).' } });
    expect(draft.part[open.id].map((part) => part.text)).toEqual(['Done: ']);
    // The first step is in the file and agrees with the store.
    expect(stored.filter((message) => message.type === 'assistant')).toHaveLength(1);
    expect(normalize(draft.part[live[0].id])).toEqual(normalize(projectOne(stored.find((message) => message.type === 'assistant')).parts));
    expect(stored.some((message) => message.id === open.id)).toBe(false);
  });

  it('mid-tool: the stored step shows the call the same way the live events left it', () => {
    const { draft, stored } = crash('reasoning-bash', (event) => event.type === 'tool_execution_start');
    const wire = stored.find((message) => message.type === 'assistant');
    const live = draft.message[SESSION_ID].find((message) => message.role === 'assistant');
    expect(live.id).toBe(wire.id);
    expect(normalize(draft.part[live.id])).toEqual(normalize(projectOne(wire).parts));
    expect(draft.part[live.id].find((part) => part.type === 'tool').state).toMatchObject({ status: 'error', errorType: 'aborted', error: 'Tool execution interrupted' });
    // The file cannot say why the run stopped: the stored step keeps Pi's own finish.
    expect(wire.finish).toBe('tool-calls');
    expect(live).toMatchObject({ finish: 'error', error: { type: 'provider.transport' } });
  });
});

