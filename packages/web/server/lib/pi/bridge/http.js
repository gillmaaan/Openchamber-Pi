// The HTTP face of the Pi bridge: the OpenCode 2.2.6 transport rules.
//
// - Basic auth, user `opencode`, the managed password. Without it: 401 JSON.
//   A route may opt out with `bypassBasicAuth` when it checks its own credential.
// - JSON in and out; a 204 has no body and no content type.
// - Every failure is a tagged error body (`errors.js`). An unknown route is a
//   bare 404 with no body: `session-activity.js` tells "no such route" from a
//   tagged 404 by that.
// - A location-scoped request names its folder in `x-opencode-directory`
//   (percent-encoded) or `location[directory]`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { invalidRequest, unauthorized, unknownError, WireError } from './errors.js';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

const sameSecret = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const isAuthorized = (header, password) => {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return decoded.slice(0, colon) === 'opencode' && sameSecret(decoded.slice(colon + 1), password);
};

const compilePath = (pattern) => {
  const names = [];
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
};

const decodeSegment = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

const directoryFrom = (req, searchParams) => {
  const header = req.headers['x-opencode-directory'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw) return decodeSegment(raw);
  return searchParams.get('location[directory]') || null;
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw invalidRequest('Request body is too large', { kind: 'Payload' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** Handlers return these; `STREAMED` means the handler wrote the response itself. */
export const json = (body, status = 200, headers = {}) => ({ kind: 'json', status, body, headers });
export const noContent = () => ({ kind: 'empty', status: 204 });
export const STREAMED = Object.freeze({ kind: 'streamed' });

/**
 * @param {object} options
 * @param {string} options.password
 * @param {Array<{ method: string, path: string, handler: (ctx: object) => Promise<object> | object }>} options.routes
 * @param {(error: Error, ref: string) => void} [options.onError]
 */
export const createBridgeHttpServer = ({ password, routes, onError = () => {} }) => {
  const compiled = routes.map((route) => ({ ...route, ...compilePath(route.path) }));

  const send = (res, result) => {
    if (result.kind === 'streamed') return;
    if (result.kind === 'empty') {
      res.writeHead(result.status);
      res.end();
      return;
    }
    const text = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...result.headers,
    });
    res.end(text);
  };

  const sendError = (res, error) => {
    let wire = error;
    if (!(error instanceof WireError)) {
      const ref = randomBytes(6).toString('hex');
      onError(error, ref);
      wire = unknownError('Internal error', ref);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    send(res, json(wire.toBody(), wire.status));
  };

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge.local');
      const route = compiled.find((candidate) => candidate.method === req.method && candidate.regex.test(url.pathname));
      // A route that carries its own credential (the Pi children's per-session
      // bearer token on `/_pi/*`) opts out of Basic auth and checks it itself.
      // Everything else, an unknown route included, needs the password first.
      if (!route?.bypassBasicAuth && !isAuthorized(req.headers.authorization, password)) throw unauthorized();
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }

      const match = route.regex.exec(url.pathname);
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeSegment(match[index + 1])]));
      let parsedBody;
      const ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        directory: directoryFrom(req, url.searchParams),
        /** The JSON body; `{}` when the request sent none. */
        body: async () => {
          if (parsedBody !== undefined) return parsedBody;
          const text = await readBody(req);
          if (text.trim() === '') {
            parsedBody = {};
            return parsedBody;
          }
          try {
            parsedBody = JSON.parse(text);
          } catch {
            throw invalidRequest('Expected a valid JSON body', { kind: 'Payload' });
          }
          return parsedBody;
        },
      };

      const result = await route.handler(ctx);
      if (result === STREAMED) return;
      send(res, result ?? noContent());
    } catch (error) {
      sendError(res, error);
    }
  };

  const server = http.createServer((req, res) => { void handle(req, res); });

  const listen = ({ hostname = '127.0.0.1', port = 0 } = {}) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });

  const close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return { server, listen, close };
};
