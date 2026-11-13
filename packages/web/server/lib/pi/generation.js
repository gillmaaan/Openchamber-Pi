// One-shot generation through Pi's own provider layer: text for titles, goals
// and walkthroughs, images for the image tool. Nothing is stored in a session;
// the credentials are the ones Pi holds, so a key added in Settings serves the
// chat and these calls alike.
//
// The SDK's `ModelRuntime` is built per call: it reads `auth.json` and
// `models.json` when it is created, and a key added a moment ago must work now.

import path from 'node:path';

import { classifyProviderError } from './wire/mapping.js';
import { modelNotFound, providerNotFound, providerRequest, unsupportedModel } from './bridge/errors.js';
import { readJsonObject } from './bridge/routes/pi-files.js';

const REASON_BY_ERROR_TYPE = {
  'provider.rate-limit': 'rate_limit',
  'provider.invalid-request': 'invalid_request',
  'provider.transport': 'provider',
  'provider.internal': 'provider',
};

const providerFailure = (providerID, message, stopReason) => {
  const classified = classifyProviderError(message, { stopReason });
  const reason = /\b(401|403)\b|api key|unauthor|forbidden|authentication/i.test(message) ? 'authentication' : REASON_BY_ERROR_TYPE[classified.type] ?? 'provider';
  return providerRequest(providerID, reason, classified.message ?? message, { status: classified.status, retryAfterMs: classified.retryAfterMs });
};

const textOf = (content) => content.filter((block) => block.type === 'text').map((block) => block.text).join('');

/**
 * @param {object} options
 * @param {() => string} options.getAgentDir
 * @param {() => Promise<typeof import('@earendil-works/pi-coding-agent')>} [options.loadSdk]
 * @param {() => number} [options.now]
 */
export const createPiGeneration = ({
  getAgentDir,
  loadSdk = () => import('@earendil-works/pi-coding-agent'),
  now = () => Date.now(),
}) => {
  const runtime = async () => {
    const sdk = await loadSdk();
    const agentDir = getAgentDir();
    return sdk.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      modelsStorePath: path.join(agentDir, 'models-store.json'),
      refreshOnCreate: true,
      allowModelNetwork: false,
    });
  };

  /** The model asked for, else Pi's default (`settings.json`), else the first one with working auth. */
  const chatModel = async (rt, ref) => {
    if (ref) {
      if (!rt.getProvider(ref.providerID)) throw providerNotFound(ref.providerID);
      const model = rt.getModel(ref.providerID, ref.id);
      if (!model) throw modelNotFound(ref.providerID, ref.id);
      return model;
    }
    const { value: settings } = await readJsonObject(path.join(getAgentDir(), 'settings.json'));
    const configured = settings?.defaultProvider && settings?.defaultModel ? rt.getModel(settings.defaultProvider, settings.defaultModel) : undefined;
    const model = configured ?? (await rt.getAvailable())[0];
    if (!model) throw modelNotFound('default', 'default');
    return model;
  };

  /**
   * `POST /api/experimental/generate/text`: one stateless generation, the assistant's text back.
   * `history` (a session file's entries, header excluded) puts the session's conversation, system
   * prompt and tool declarations ahead of the prompt, as `POST /api/session/:id/generate` needs;
   * nothing is written back to the session.
   */
  const generateText = async ({ prompt, model: ref, signal, history }) => {
    const rt = await runtime();
    const model = await chatModel(rt, ref);
    const sdk = history?.length ? await loadSdk() : null;
    const context = sdk ? sdk.convertToLlm(sdk.buildSessionContext(history).messages) : [];
    const options = { signal, ...(ref?.variant && ref.variant !== 'default' ? { reasoning: ref.variant } : {}) };
    const reply = await rt.completeSimple(model, { messages: [...context, { role: 'user', content: prompt, timestamp: now() }] }, options);
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      throw providerFailure(model.provider, reply.errorMessage ?? 'The provider returned an error.', reply.stopReason);
    }
    return { text: textOf(reply.content) };
  };

  /** `POST /api/experimental/generate/image`: images as base64, nothing stored. */
  const generateImages = async ({ model: ref, prompt, images = [], n = 1, aspect, resolution, signal }) => {
    const rt = await runtime();
    if (!rt.getProvider(ref.providerID)) throw providerNotFound(ref.providerID);
    const model = rt.getModelOfType('image', ref.providerID, ref.id);
    if (!model) {
      if (rt.getModel(ref.providerID, ref.id)) throw unsupportedModel(ref.providerID, ref.id, 'generate images');
      throw modelNotFound(ref.providerID, ref.id);
    }
    const input = [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mime }))];
    const options = { signal, metadata: { ...(aspect ? { aspect } : {}), ...(resolution ? { resolution } : {}) } };
    const results = [];
    let usage;
    for (let index = 0; index < Math.max(1, n); index += 1) {
      const reply = await rt.generateImages(model, { input }, options);
      if (reply.stopReason !== 'stop') throw providerFailure(model.provider, reply.errorMessage ?? 'The provider returned an error.', reply.stopReason);
      for (const block of reply.output) {
        if (block.type === 'image') results.push({ data: block.data, mime: block.mimeType, type: 'image' });
      }
      usage = reply.usage ?? usage;
    }
    return {
      images: results,
      ...(usage ? { usage: { input: usage.input, output: usage.output } } : {}),
    };
  };

  return { generateText, generateImages };
};
