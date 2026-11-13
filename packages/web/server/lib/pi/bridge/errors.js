// The tagged errors of the OpenCode 2.2.6 wire format. Every error body is
// `{ _tag, message, ...extra }` and the status per tag is fixed: the UI maps a
// tag to behavior (a 404 PermissionNotFoundError means "already settled").

export class WireError extends Error {
  constructor(status, tag, message, extra = {}) {
    super(message);
    this.name = 'WireError';
    this.status = status;
    this.tag = tag;
    this.extra = extra;
  }

  toBody() {
    return { _tag: this.tag, message: this.message, ...this.extra };
  }
}

export const invalidRequest = (message, { kind, field } = {}) => new WireError(400, 'InvalidRequestError', message, {
  ...(kind ? { kind } : {}),
  ...(field ? { field } : {}),
});
export const invalidCursor = (message = 'Invalid cursor') => new WireError(400, 'InvalidCursorError', message);
export const unauthorized = () => new WireError(401, 'UnauthorizedError', 'Authentication required');
export const sessionNotFound = (sessionID) => new WireError(404, 'SessionNotFoundError', `Session not found: ${sessionID}`, { sessionID });
export const messageNotFound = (sessionID, messageID) => new WireError(404, 'MessageNotFoundError', `Message not found: ${messageID}`, { sessionID, messageID });
export const permissionNotFound = (requestID) => new WireError(404, 'PermissionNotFoundError', `Permission request not found: ${requestID}`, { requestID });
export const formNotFound = (id) => new WireError(404, 'FormNotFoundError', `Form not found: ${id}`, { id });
export const agentNotFound = (agentID) => new WireError(404, 'AgentNotFoundError', `Agent not found: ${agentID}`, { agentID });
export const commandNotFound = (command) => new WireError(404, 'CommandNotFoundError', `Command not found: ${command}`, { command });
export const skillNotFound = (skill) => new WireError(404, 'SkillNotFoundError', `Skill not found: ${skill}`, { skill });
export const locationNotFound = (directory) => new WireError(404, 'LocationNotFoundError', `Location not found: ${directory}`, { location: { directory } });
export const conflict = (message, resource) => new WireError(409, 'ConflictError', message, resource ? { resource } : {});
export const sessionBusy = (sessionID) => new WireError(409, 'SessionBusyError', `Session is busy: ${sessionID}`, { sessionID });
export const formAlreadySettled = (id) => new WireError(409, 'FormAlreadySettledError', `Form already settled: ${id}`, { id });
export const formInvalidAnswer = (id, message) => new WireError(400, 'FormInvalidAnswerError', message, { id });
export const unknownError = (message, ref) => new WireError(500, 'UnknownError', message, ref ? { ref } : {});
export const serviceUnavailable = (message, service) => new WireError(503, 'ServiceUnavailableError', message, service ? { service } : {});

export const providerNotFound = (providerID) => new WireError(404, 'ProviderNotFoundError', `Provider not found: ${providerID}`, { providerID });
export const modelNotFound = (providerID, modelID) => new WireError(404, 'ModelNotFoundError', `Model not found: ${providerID}/${modelID}`, { providerID, modelID });
export const unsupportedModel = (providerID, modelID, capability) => new WireError(422, 'UnsupportedModelError', `${providerID}/${modelID} cannot ${capability}`, { providerID, modelID, capability });
/** The provider refused or failed a one-shot generation: `reason` is one of authentication, rate_limit, content_filter, invalid_request, overloaded, provider. */
export const providerRequest = (providerID, reason, message, { status, retryAfterMs } = {}) => new WireError(502, 'ProviderRequestError', message, {
  providerID,
  reason,
  ...(status ? { status } : {}),
  ...(retryAfterMs ? { retryAfterMs } : {}),
});
