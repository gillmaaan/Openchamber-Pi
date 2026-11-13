// The routes that read and send a session's conversation: message pages, the
// inbox, prompt, synthetic, command, compact and interrupt (wire spec 3.3, 3.4).

import { invalidRequest } from '../errors.js';
import { json, noContent, STREAMED } from '../http.js';

/**
 * @param {object} deps
 * @param {ReturnType<import('../chat-runtime.js').createChatRuntime>} deps.chat
 * @param {ReturnType<import('../prompting.js').createPrompting>} deps.prompting
 * @param {ReturnType<import('../session-service.js').createSessionService>} deps.service
 */
export const createChatRoutes = ({ chat, prompting, service }) => [
  { method: 'GET', path: '/api/session/:sessionID/message', handler: async ({ params, query }) => json(await chat.messages(params.sessionID, query)) },
  { method: 'GET', path: '/api/session/:sessionID/message/:messageID', handler: async ({ params }) => json({ data: await chat.message(params.sessionID, params.messageID) }) },
  { method: 'GET', path: '/api/session/:sessionID/context', handler: async ({ params }) => json({ data: await chat.context(params.sessionID) }) },
  { method: 'GET', path: '/api/session/:sessionID/inbox', handler: async ({ params }) => json({ data: await prompting.inbox(params.sessionID) }) },
  {
    method: 'PATCH',
    path: '/api/session/:sessionID/inbox/:inboxID',
    handler: async (ctx) => {
      await prompting.updateInbox(ctx.params.sessionID, ctx.params.inboxID, await ctx.body());
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/api/session/:sessionID/inbox/:inboxID',
    handler: async ({ params }) => {
      await prompting.cancelInbox(params.sessionID, params.inboxID);
      return noContent();
    },
  },
  { method: 'POST', path: '/api/session/:sessionID/prompt', handler: async (ctx) => json({ data: await prompting.prompt(ctx.params.sessionID, await ctx.body()) }) },
  {
    // Scheduled tasks and workflows wait on a session this way; a client that hangs up stops waiting.
    method: 'POST',
    path: '/api/experimental/session/:sessionID/wait',
    handler: async ({ params, req, res }) => {
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      req.on('aborted', () => controller.abort());
      try {
        await service.waitForIdle(params.sessionID, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return STREAMED;
        throw error;
      }
      return noContent();
    },
  },
  { method: 'POST', path: '/api/session/:sessionID/synthetic', handler: async (ctx) => json({ data: await prompting.synthetic(ctx.params.sessionID, await ctx.body()) }) },
  {
    method: 'POST',
    path: '/api/session/:sessionID/command',
    handler: async (ctx) => {
      await prompting.command(ctx.params.sessionID, await ctx.body());
      return noContent();
    },
  },
  { method: 'POST', path: '/api/session/:sessionID/compact', handler: async (ctx) => json({ data: await prompting.compact(ctx.params.sessionID, await ctx.body()) }) },
  {
    method: 'POST',
    path: '/api/session/:sessionID/interrupt',
    handler: async ({ params, query }) => {
      const resume = query.get('resume');
      if (resume !== null && resume !== 'true' && resume !== 'false') throw invalidRequest('Expected "true" | "false"\n  at ["resume"]', { kind: 'Query' });
      return json({ interrupted: await prompting.interrupt(params.sessionID, { resume: resume === 'true' }) });
    },
  },
];
