// `GET /api/session/:sessionID/context-composition`, OpenChamber's own route
// (not part of the OpenCode dialect): what fills the session's context besides
// the conversation. And the callback the Pi child answers it with.

import { invalidRequest, unauthorized, WireError } from '../errors.js';
import { json, noContent } from '../http.js';

const bearerOf = (header) => (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null);

/**
 * @param {object} deps
 * @param {{ contextComposition: (sessionID: string) => Promise<object> }} deps.prompting
 * @param {ReturnType<import('../context-composition.js').createContextCompositions>} deps.contexts
 * @param {{ verify: (token: string|null) => string|null }} deps.tokens
 */
export const createContextCompositionRoutes = ({ prompting, contexts, tokens }) => [
  {
    method: 'GET',
    path: '/api/session/:sessionID/context-composition',
    handler: async ({ params }) => json({ data: await prompting.contextComposition(params.sessionID) }),
  },
  {
    method: 'POST',
    path: '/_pi/context',
    bypassBasicAuth: true,
    handler: async (ctx) => {
      const sessionID = tokens.verify(bearerOf(ctx.req.headers.authorization));
      if (!sessionID) throw unauthorized();
      const body = await ctx.body();
      if (body?.sessionID !== sessionID) throw new WireError(403, 'ForbiddenError', 'This token belongs to another session', { sessionID: body?.sessionID });
      if (typeof body.requestId !== 'string' || body.requestId === '' || body.snapshot === null || typeof body.snapshot !== 'object') {
        throw invalidRequest('Expected requestId and snapshot', { kind: 'Payload' });
      }
      contexts.deliver(sessionID, body.requestId, body.snapshot);
      return noContent();
    },
  },
];
