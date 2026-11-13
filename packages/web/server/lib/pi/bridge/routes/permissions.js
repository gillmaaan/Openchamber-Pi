// The permission routes of the OpenCode 2.2.6 dialect (wire spec 3.5): the
// pending requests, the reply, and the rules a reply of `always` saved.

import { invalidRequest, permissionNotFound } from '../errors.js';
import { json, noContent } from '../http.js';
import { resolveLocation } from '../location.js';

const DECISIONS = new Set(['once', 'always', 'reject']);
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * @param {object} deps
 * @param {ReturnType<import('../permissions.js').createPermissionManager>} deps.permissions
 * @param {ReturnType<import('../permissions.js').createSavedPermissionStore>} deps.store
 * @param {() => string} deps.getDefaultDirectory
 * @param {(sessionID: string) => Promise<unknown> | unknown} [deps.requireSession]  Throws `SessionNotFoundError` for an unknown session.
 */
export const createPermissionRoutes = ({ permissions, store, getDefaultDirectory, requireSession = () => {} }) => [
  {
    method: 'GET',
    path: '/api/permission/request',
    handler: (ctx) => {
      const { directory } = resolveLocation(ctx, { getDefaultDirectory });
      return json({ location: { directory }, data: permissions.listPending({ directory }) });
    },
  },
  {
    method: 'GET',
    path: '/api/session/:sessionID/permission',
    handler: async ({ params }) => {
      await requireSession(params.sessionID);
      return json({ data: permissions.listPending({ sessionID: params.sessionID }) });
    },
  },
  {
    method: 'GET',
    path: '/api/session/:sessionID/permission/:requestID',
    handler: ({ params }) => {
      const request = permissions.get(params.sessionID, params.requestID);
      if (!request) throw permissionNotFound(params.requestID);
      return json({ data: request });
    },
  },
  {
    method: 'POST',
    path: '/api/session/:sessionID/permission/:requestID/reply',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!DECISIONS.has(body.decision)) throw invalidRequest('Expected decision to be "once", "always" or "reject"', { kind: 'Payload', field: 'decision' });
      if (body.message !== undefined && typeof body.message !== 'string') throw invalidRequest('Expected message to be a string', { kind: 'Payload', field: 'message' });
      await permissions.reply(ctx.params.sessionID, ctx.params.requestID, { decision: body.decision, message: body.message });
      return noContent();
    },
  },
  { method: 'GET', path: '/api/permission/saved', handler: () => json({ data: store.list() }) },
  {
    method: 'PATCH',
    path: '/api/permission/saved/:id',
    handler: async (ctx) => {
      const body = await ctx.body();
      const fields = {};
      for (const key of ['action', 'resource']) {
        if (body[key] === undefined) continue;
        if (!isText(body[key])) throw invalidRequest(`Expected ${key} to be a non-empty string`, { kind: 'Payload', field: key });
        fields[key] = body[key];
      }
      const saved = await store.update(ctx.params.id, fields);
      if (!saved) throw permissionNotFound(ctx.params.id);
      return json({ data: saved });
    },
  },
  {
    method: 'DELETE',
    path: '/api/permission/saved/:id',
    handler: async ({ params }) => {
      await store.remove(params.id);
      return noContent();
    },
  },
];
