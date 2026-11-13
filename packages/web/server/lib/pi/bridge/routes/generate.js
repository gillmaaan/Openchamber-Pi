// One-shot generation routes (`/api/experimental/generate/*`). The server's
// small-model helper and the image tool call these; they store nothing.

import { invalidRequest } from '../errors.js';
import { json } from '../http.js';

const isRef = (value) => value && typeof value === 'object' && typeof value.id === 'string' && typeof value.providerID === 'string';

const requireText = (body, field) => {
  if (typeof body[field] !== 'string') throw invalidRequest(`Expected a string\n  at ["${field}"]`, { kind: 'Payload' });
  return body[field];
};

/**
 * @param {object} deps
 * @param {ReturnType<import('../../generation.js').createPiGeneration>} deps.generation
 */
export const createGenerateRoutes = ({ generation }) => {
  const text = async (ctx) => {
    const body = await ctx.body();
    const prompt = requireText(body, 'prompt');
    if (body.model !== undefined && !isRef(body.model)) throw invalidRequest('Expected a model reference\n  at ["model"]', { kind: 'Payload' });
    return json({ data: await generation.generateText({ prompt, model: body.model }) });
  };

  return [
    { method: 'POST', path: '/api/experimental/generate/text', handler: text },
    // The path clients used before the move to /generate/text.
    { method: 'POST', path: '/api/experimental/generate', handler: text },
    {
      method: 'POST',
      path: '/api/experimental/generate/image',
      handler: async (ctx) => {
        const body = await ctx.body();
        const prompt = requireText(body, 'prompt');
        if (!isRef(body.model)) throw invalidRequest('Expected a model reference\n  at ["model"]', { kind: 'Payload' });
        const n = body.n === undefined ? 1 : body.n;
        if (!Number.isInteger(n) || n < 1 || n > 8) throw invalidRequest('Expected an integer between 1 and 8\n  at ["n"]', { kind: 'Payload' });
        const images = Array.isArray(body.images) ? body.images : [];
        if (images.some((image) => typeof image?.data !== 'string' || typeof image?.mime !== 'string')) {
          throw invalidRequest('Expected images with data and mime\n  at ["images"]', { kind: 'Payload' });
        }
        return json({ data: await generation.generateImages({ model: body.model, prompt, images, n, aspect: body.aspect, resolution: body.resolution }) });
      },
    },
  ];
};
