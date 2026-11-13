// The integration and credential routes of the OpenCode 2.2.6 dialect, answered
// from Pi. The bridge composes these before the catalog's own `GET
// /api/integration`, so the first match is the one that knows how to connect.
//
//   GET    /api/integration                                  the list, one entry per Pi provider
//                                                            plus one per remote OAuth MCP server
//   GET    /api/integration/:id                              one entry
//   POST   /api/integration/:id/connect/key                  { key, answer?, label? }       -> 204
//   POST   /api/integration/:id/connect/external             { methodID, answer?, label? }  -> 204
//   POST   /api/integration/:id/connect/oauth                { methodID, answer?, label? }  -> { location, data: attempt }
//   GET    /api/integration/:id/connect/oauth/:attemptID     { location, data: status }
//   POST   /api/integration/:id/connect/oauth/:attemptID/complete   { code }               -> 204
//   DELETE /api/integration/:id/connect/oauth/:attemptID                                   -> 204
//   POST   /api/credential/:id/activate                                                    -> 204
//   PATCH  /api/credential/:id                               { label }                      -> 204
//   DELETE /api/credential/:id                                                              -> 204
//
// `GET /api/credential` (the stored credentials, secrets included) stays with
// the catalog routes. The command connect routes and `POST /api/credential` have
// no Pi equivalent and answer the bare 404 of an unknown route. What writes, and
// what enterprise mode refuses, is in `service.js`.
//
// `deps`: `{ providers: ReturnType<createProviderService>, getDefaultDirectory }`.

import { invalidRequest, WireError } from '../bridge/errors.js';
import { json, noContent } from '../bridge/http.js';
import { resolveLocation } from '../bridge/location.js';

const asRecord = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

/**
 * @param {object} deps
 * @param {ReturnType<import('./service.js').createProviderService>} deps.providers
 * @param {() => string} deps.getDefaultDirectory
 * @param {ReturnType<import('../bridge/mcp-oauth.js').createMcpOAuth>} [deps.mcpOAuth]  Remote MCP servers as integrations with an OAuth sign-in.
 */
export const createProviderBridgeRoutes = ({ providers, getDefaultDirectory, mcpOAuth = null }) => {
  const located = (ctx, data) => json({ location: { directory: resolveLocation(ctx, { getDefaultDirectory }).directory }, data });

  const bodyOf = async (ctx) => {
    const body = await ctx.body();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('Expected a JSON object body', { kind: 'Payload' });
    return body;
  };

  const answerOf = (body) => {
    if (body.answer === undefined) return undefined;
    if (body.answer === null || typeof body.answer !== 'object' || Array.isArray(body.answer)) throw invalidRequest('answer must be an object', { kind: 'Payload', field: 'answer' });
    return body.answer;
  };
  const labelOf = (body) => (typeof body.label === 'string' ? body.label : undefined);

  const usesMcp = (integrationID) => Boolean(mcpOAuth?.owns(integrationID));
  const requireMcpIntegration = async (integrationID, directory) => {
    const found = await mcpOAuth.integration(integrationID, directory);
    if (!found) throw new WireError(404, 'IntegrationNotFoundError', `Integration not found: ${integrationID}`, { integrationID });
    return found;
  };

  return [
    {
      method: 'GET',
      path: '/api/integration',
      handler: async (ctx) => {
        const location = resolveLocation(ctx, { getDefaultDirectory });
        const mcp = mcpOAuth ? await mcpOAuth.integrations(location.directory) : [];
        return located(ctx, [...await providers.integrations(), ...mcp]);
      },
    },
    {
      method: 'GET',
      path: '/api/integration/:integrationID',
      handler: async (ctx) => located(ctx, usesMcp(ctx.params.integrationID)
        ? await requireMcpIntegration(ctx.params.integrationID, resolveLocation(ctx, { getDefaultDirectory }).directory)
        : await providers.integration(ctx.params.integrationID)),
    },
    {
      method: 'POST',
      path: '/api/integration/:integrationID/connect/key',
      handler: async (ctx) => {
        const body = await bodyOf(ctx);
        await providers.connectKey({ integrationID: ctx.params.integrationID, key: body.key, answer: answerOf(body), label: labelOf(body) });
        return noContent();
      },
    },
    {
      method: 'POST',
      path: '/api/integration/:integrationID/connect/external',
      handler: async (ctx) => {
        const body = await bodyOf(ctx);
        await providers.connectExternal({ integrationID: ctx.params.integrationID, methodID: body.methodID, answer: answerOf(body), label: labelOf(body) });
        return noContent();
      },
    },
    {
      method: 'POST',
      path: '/api/integration/:integrationID/connect/oauth',
      handler: async (ctx) => {
        // Resolved before the attempt starts: a folder that is gone must not leave a login running.
        const location = resolveLocation(ctx, { getDefaultDirectory });
        const body = await bodyOf(ctx);
        const attempt = usesMcp(ctx.params.integrationID)
          ? await mcpOAuth.start({ integrationID: ctx.params.integrationID, directory: location.directory })
          : await providers.startOAuth({ integrationID: ctx.params.integrationID, methodID: body.methodID, answer: answerOf(body), label: labelOf(body) });
        return json({ location: { directory: location.directory }, data: attempt });
      },
    },
    {
      method: 'GET',
      path: '/api/integration/:integrationID/connect/oauth/:attemptID',
      handler: (ctx) => located(ctx, usesMcp(ctx.params.integrationID)
        ? mcpOAuth.status(ctx.params.integrationID, ctx.params.attemptID)
        : providers.oauthStatus(ctx.params.integrationID, ctx.params.attemptID)),
    },
    {
      method: 'POST',
      path: '/api/integration/:integrationID/connect/oauth/:attemptID/complete',
      handler: async (ctx) => {
        const body = await bodyOf(ctx);
        if (usesMcp(ctx.params.integrationID)) mcpOAuth.complete(ctx.params.integrationID, ctx.params.attemptID);
        else await providers.completeOAuth(ctx.params.integrationID, ctx.params.attemptID, body.code);
        return noContent();
      },
    },
    {
      method: 'DELETE',
      path: '/api/integration/:integrationID/connect/oauth/:attemptID',
      handler: (ctx) => {
        if (usesMcp(ctx.params.integrationID)) mcpOAuth.cancel(ctx.params.integrationID, ctx.params.attemptID);
        else providers.cancelOAuth(ctx.params.integrationID, ctx.params.attemptID);
        return noContent();
      },
    },
    {
      method: 'POST',
      path: '/api/credential/:credentialID/activate',
      handler: async (ctx) => {
        await providers.activateCredential(ctx.params.credentialID);
        return noContent();
      },
    },
    {
      method: 'PATCH',
      path: '/api/credential/:credentialID',
      handler: async (ctx) => {
        const body = asRecord(await ctx.body());
        await providers.renameCredential(ctx.params.credentialID, body.label);
        return noContent();
      },
    },
    {
      method: 'DELETE',
      path: '/api/credential/:credentialID',
      handler: async (ctx) => {
        await providers.removeCredential(ctx.params.credentialID);
        return noContent();
      },
    },
  ];
};
