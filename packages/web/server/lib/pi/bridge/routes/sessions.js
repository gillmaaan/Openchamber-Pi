// The session routes of the OpenCode 2.2.6 dialect. Status codes and envelopes
// are the contract (wire spec 1.3, 1.4): a mutation answers 204, a read answers
// `{ data }`, the list adds `cursor`. Sending, reading messages and interrupt are in chat.js.

import { json, noContent, STREAMED } from '../http.js';

/**
 * @param {object} deps
 * @param {ReturnType<import('../session-service.js').createSessionService>} deps.service
 * @param {ReturnType<import('../hub.js').createEventHub>} deps.hub
 */
export const createSessionRoutes = ({ service, hub }) => [
  {
    method: 'GET',
    path: '/api/event',
    handler: ({ res, query }) => {
      hub.subscribe(res, { types: query.getAll('types') });
      return STREAMED;
    },
  },
  { method: 'GET', path: '/api/session', handler: async ({ query }) => json(await service.list(query)) },
  {
    method: 'POST',
    path: '/api/session',
    handler: async (ctx) => json({ data: await service.create(await ctx.body(), ctx.directory) }),
  },
  // Before `:sessionID`, which would otherwise take "active" as an id.
  { method: 'GET', path: '/api/session/active', handler: () => json({ data: service.active() }) },
  { method: 'GET', path: '/api/session/:sessionID', handler: async ({ params }) => json({ data: await service.requireRecord(params.sessionID) }) },
  {
    method: 'PATCH',
    path: '/api/session/:sessionID',
    handler: async (ctx) => {
      await service.update(ctx.params.sessionID, await ctx.body());
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/api/session/:sessionID',
    handler: async ({ params }) => {
      await service.remove(params.sessionID);
      return noContent();
    },
  },
  {
    method: 'POST',
    path: '/api/session/:sessionID/view',
    handler: async (ctx) => {
      await service.view(ctx.params.sessionID, await ctx.body());
      return noContent();
    },
  },
  {
    method: 'POST',
    path: '/api/session/:sessionID/model',
    handler: async (ctx) => {
      await service.switchModel(ctx.params.sessionID, await ctx.body());
      return noContent();
    },
  },
  {
    method: 'POST',
    path: '/api/session/:sessionID/agent',
    handler: async (ctx) => {
      await service.switchAgent(ctx.params.sessionID, await ctx.body());
      return noContent();
    },
  },
];
