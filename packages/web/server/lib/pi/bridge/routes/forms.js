// The form routes of the OpenCode 2.2.6 dialect (wire spec 3.5): the pending
// forms the `question` tool raised, the answer, and the cancel.

import { formNotFound, invalidRequest } from '../errors.js';
import { json, noContent } from '../http.js';
import { resolveLocation } from '../location.js';

/**
 * @param {object} deps
 * @param {ReturnType<import('../forms.js').createFormManager>} deps.forms
 * @param {() => string} deps.getDefaultDirectory
 * @param {(sessionID: string) => Promise<unknown> | unknown} [deps.requireSession]  Throws `SessionNotFoundError` for an unknown session.
 */
export const createFormRoutes = ({ forms, getDefaultDirectory, requireSession = () => {} }) => [
  {
    method: 'GET',
    path: '/api/form',
    handler: (ctx) => {
      const { directory } = resolveLocation(ctx, { getDefaultDirectory });
      return json({ location: { directory }, data: forms.listPending({ directory }) });
    },
  },
  {
    method: 'GET',
    path: '/api/session/:sessionID/form',
    handler: async ({ params }) => {
      await requireSession(params.sessionID);
      return json({ data: forms.listPending({ sessionID: params.sessionID }) });
    },
  },
  {
    method: 'GET',
    path: '/api/session/:sessionID/form/:formID',
    handler: ({ params }) => {
      const form = forms.get(params.sessionID, params.formID);
      if (!form) throw formNotFound(params.formID);
      return json({ data: form });
    },
  },
  {
    method: 'POST',
    path: '/api/session/:sessionID/form/:formID/reply',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (body.answer === null || typeof body.answer !== 'object' || Array.isArray(body.answer)) {
        throw invalidRequest('Expected answer to be an object', { kind: 'Payload', field: 'answer' });
      }
      forms.reply(ctx.params.sessionID, ctx.params.formID, body.answer);
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/api/session/:sessionID/form/:formID',
    handler: ({ params, query }) => {
      forms.cancel(params.sessionID, params.formID, { message: query.get('message') || undefined });
      return noContent();
    },
  },
];
