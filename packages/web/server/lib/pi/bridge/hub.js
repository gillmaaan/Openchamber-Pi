// The event hub behind `GET /api/event`.
//
// OpenCode's stream is volatile: no `id:` lines, no replay (`Last-Event-ID` is
// ignored), a subscriber sees only what happens after it connects, and a
// subscriber that cannot keep up is cut. Each frame is `data: <json>\n\n` with
// the event id inside the JSON; a `: heartbeat` comment every 15 s keeps the
// UI's stall timer (and the web server's 20 s upstream timeout) quiet.

import { ascendingId } from '../wire/ids.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
// A subscriber with this much unwritten data is dropped instead of buffered.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
  vary: 'Origin',
};

export const createEventHub = ({
  mintId = () => ascendingId('evt'),
  now = () => Date.now(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) => {
  const subscribers = new Set();
  let timer = null;

  const startHeartbeat = () => {
    if (timer || heartbeatMs <= 0) return;
    timer = setIntervalImpl(() => {
      for (const subscriber of subscribers) writeTo(subscriber, ': heartbeat\n\n');
    }, heartbeatMs);
    timer.unref?.();
  };

  const stopHeartbeat = () => {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  };

  const drop = (subscriber) => {
    if (!subscribers.delete(subscriber)) return;
    if (subscribers.size === 0) stopHeartbeat();
    try { subscriber.res.end(); } catch { /* the socket is already gone */ }
  };

  const writeTo = (subscriber, text) => {
    const { res } = subscriber;
    if (res.destroyed || res.writableEnded) {
      drop(subscriber);
      return;
    }
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      res.destroy();
      drop(subscriber);
      return;
    }
    res.write(text);
  };

  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

  /**
   * Publish an event to every subscriber and return its envelope.
   * `location` is added only where OpenCode sends one (see wire spec 4.1).
   * `id` names the event: the UI derives the message of `session.shell.started`
   * from it (`evt_X` is `msg_X`), so that event carries the client's message id.
   */
  const emit = ({ id, type, data = {}, location, durable, metadata }) => {
    const event = {
      id: id ?? mintId(),
      created: now(),
      type,
      ...(metadata ? { metadata } : {}),
      ...(location ? { location } : {}),
      data,
      ...(durable ? { durable } : {}),
    };
    const text = frame(event);
    for (const subscriber of subscribers) {
      if (subscriber.types && !subscriber.types.has(type)) continue;
      writeTo(subscriber, text);
    }
    return event;
  };

  /**
   * Attach a response to the stream. The caller has answered nothing yet; the
   * hub writes the headers, `server.connected` and the first heartbeat.
   */
  const subscribe = (res, { types } = {}) => {
    res.writeHead(200, SSE_HEADERS);
    const subscriber = { res, types: types?.length ? new Set(types) : null };
    res.write(`${frame({ id: mintId(), type: 'server.connected', data: {} })}: heartbeat\n\n`);
    subscribers.add(subscriber);
    startHeartbeat();
    res.on('close', () => drop(subscriber));
    return () => drop(subscriber);
  };

  const close = () => {
    for (const subscriber of [...subscribers]) drop(subscriber);
    stopHeartbeat();
  };

  return { emit, subscribe, close, get size() { return subscribers.size; } };
};
