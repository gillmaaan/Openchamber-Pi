// The instruction-entry routes of the OpenCode dialect, and the callback the
// gate extension uses to read the rendered text at the start of a run.

import { invalidRequest, unauthorized, WireError } from '../errors.js';
import { json, noContent } from '../http.js';

const bearerOf = (header) => (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null);

/**
 * @param {object} deps
 * @param {ReturnType<import('../instructions.js').createInstructions>} deps.instructions
 * @param {{ verify: (token: string|null) => string|null }} deps.tokens
 * @param {(sessionID: string) => Promise<{ location: { directory: string } }>} deps.requireSession
 */
export const createInstructionRoutes = ({ instructions, tokens, requireSession }) => [
  {
    method: 'GET',
    path: '/api/experimental/session/:sessionID/instructions/entries',
    handler: async ({ params }) => {
      await requireSession(params.sessionID);
      return json({ data: instructions.list(params.sessionID) });
    },
  },
  {
    method: 'PUT',
    path: '/api/experimental/session/:sessionID/instructions/entries/:key',
    handler: async (ctx) => {
      await requireSession(ctx.params.sessionID);
      const body = await ctx.body();
      if (!('value' in body)) throw invalidRequest('Expected a value\n  at ["value"]', { kind: 'Payload' });
      await instructions.put(ctx.params.sessionID, ctx.params.key, body.value);
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/api/experimental/session/:sessionID/instructions/entries/:key',
    handler: async ({ params }) => {
      await requireSession(params.sessionID);
      await instructions.remove(params.sessionID, params.key);
      return noContent();
    },
  },
  {
    method: 'POST',
    path: '/_pi/instructions',
    bypassBasicAuth: true,
    handler: async (ctx) => {
      const sessionID = tokens.verify(bearerOf(ctx.req.headers.authorization));
      if (!sessionID) throw unauthorized();
      const body = await ctx.body();
      if (body.sessionID !== sessionID) throw new WireError(403, 'ForbiddenError', 'This token belongs to another session', { sessionID: body.sessionID });
      const record = await requireSession(sessionID);
      return json({ text: instructions.forRun(sessionID, record.location.directory) });
    },
  },
];
