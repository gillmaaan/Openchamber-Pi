// The way back from a Pi child into the bridge: `POST /_pi/permission` and
// `POST /_pi/form`, called by the gate extension (`../../extension/gui-gate.js`)
// from inside the child.
//
// These are not OpenCode routes and not under `/api`, so the web server's proxy
// never forwards them; they live on the bridge's own loopback listener. They
// carry no Basic password: each route sets `bypassBasicAuth` and checks the
// child's bearer token itself. The transport must skip its Basic check for a
// route with that flag (see PERMISSIONS-NOTES.md).
//
// A call holds its response for as long as the user takes. When the child
// drops the connection (its call was aborted, or the child died) the held
// request is dropped with it.

import { randomBytes } from 'node:crypto';

import { invalidRequest, unauthorized, WireError } from '../errors.js';
import { json } from '../http.js';

/**
 * The bearer token of each Pi child, one per child process: it names the one
 * session that child serves, and a call about another session is refused.
 */
export const createChildTokens = () => {
  /** token -> sessionID */
  const sessions = new Map();

  return {
    /** A fresh token for a child about to start. */
    issue: (sessionID) => {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, sessionID);
      return token;
    },
    /** The session a token belongs to, or null. */
    verify: (token) => (typeof token === 'string' ? sessions.get(token) ?? null : null),
    /** Every token of a session, when its child is gone. */
    revoke: (sessionID) => {
      for (const [token, owner] of sessions) {
        if (owner === sessionID) sessions.delete(token);
      }
    },
  };
};

const isText = (value) => typeof value === 'string' && value !== '';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const bearerOf = (header) => {
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1] : null;
};

/**
 * @param {object} deps
 * @param {ReturnType<createChildTokens>} deps.tokens
 * @param {ReturnType<import('../permissions.js').createPermissionManager>} deps.permissions
 * @param {ReturnType<import('../forms.js').createFormManager>} deps.forms
 */
export const createPiCallbackRoutes = ({ tokens, permissions, forms, subagents = null }) => {
  /** The checked body of a callback, and a signal that fires when the child hangs up. */
  const accept = async (ctx) => {
    const sessionID = tokens.verify(bearerOf(ctx.req.headers.authorization));
    if (!sessionID) throw unauthorized();
    const body = await ctx.body();
    if (!isRecord(body) || !isText(body.sessionID) || !isText(body.toolCallId)) {
      throw invalidRequest('Expected sessionID and toolCallId', { kind: 'Payload' });
    }
    if (body.sessionID !== sessionID) {
      throw new WireError(403, 'ForbiddenError', 'This token belongs to another session', { sessionID: body.sessionID });
    }
    const controller = new AbortController();
    ctx.res.on('close', () => {
      if (!ctx.res.writableFinished) controller.abort();
    });
    // A child that hung up while the body was still being read has already closed.
    if (ctx.res.destroyed || ctx.req.socket?.destroyed) controller.abort();
    return { body, signal: controller.signal };
  };

  return [
    {
      method: 'POST',
      path: '/_pi/permission',
      bypassBasicAuth: true,
      handler: async (ctx) => {
        const { body, signal } = await accept(ctx);
        if (!isText(body.tool)) throw invalidRequest('Expected tool', { kind: 'Payload', field: 'tool' });
        const override = body.action === undefined ? {} : {
          action: body.action,
          resources: body.resources,
          save: body.save,
        };
        if (body.action !== undefined) {
          const listOf = (value) => Array.isArray(value) && value.every(isText);
          if (!isText(body.action) || !listOf(body.resources) || body.resources.length === 0 || (body.save !== undefined && !listOf(body.save))) {
            throw invalidRequest('Expected action, resources and save to be text', { kind: 'Payload', field: 'action' });
          }
        }
        const result = await permissions.request({
          sessionID: body.sessionID,
          toolCallId: body.toolCallId,
          parentToolCallId: isText(body.parentToolCallId) ? body.parentToolCallId : undefined,
          tool: body.tool,
          input: isRecord(body.input) ? body.input : {},
          signal,
          ...override,
        });
        return json(result);
      },
    },
    {
      method: 'POST',
      path: '/_pi/form',
      bypassBasicAuth: true,
      handler: async (ctx) => {
        const { body, signal } = await accept(ctx);
        const outcome = await forms.ask({
          sessionID: body.sessionID,
          toolCallId: body.toolCallId,
          parentToolCallId: isText(body.parentToolCallId) ? body.parentToolCallId : undefined,
          questions: body.questions,
          signal,
        });
        return json(outcome);
      },
    },
    ...(subagents ? [
      {
        method: 'POST',
        path: '/_pi/subagent/start',
        bypassBasicAuth: true,
        handler: async (ctx) => {
          const { body } = await accept(ctx);
          return json(await subagents.start({
            parentSessionID: body.sessionID,
            agent: isText(body.agent) ? body.agent : undefined,
            description: body.description,
            prompt: body.prompt,
            model: body.model,
          }));
        },
      },
      {
        method: 'POST',
        path: '/_pi/subagent/wait',
        bypassBasicAuth: true,
        handler: async (ctx) => {
          const { body, signal } = await accept(ctx);
          if (!isText(body.childSessionID)) throw invalidRequest('Expected childSessionID', { kind: 'Payload', field: 'childSessionID' });
          return json(await subagents.wait({ sessionID: body.childSessionID, parentSessionID: body.sessionID, signal }));
        },
      },
    ] : []),
  ];
};
