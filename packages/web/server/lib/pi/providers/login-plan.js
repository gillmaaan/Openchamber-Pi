// What a provider's API-key login asks for, found out by running it.
//
// Pi's `ApiKeyAuth.login(interaction)` is a function that prompts: most providers
// ask for one secret, a few ask for more (Cloudflare wants an account id, Bedrock
// and Vertex first ask which kind of credential to use). The Settings page cannot
// ask mid-flight; it posts a key and a flat `answer` map, and it renders the
// `form` of the method it was given. So the prompts have to be known before the
// user connects.
//
// `exploreApiKeyLogin` runs the login with an interaction that answers every
// prompt itself and records them. A `select` prompt forks the walk: the login is
// run again once per option. Each way through is a route: the options chosen, and
// the text and secret prompts that followed. A route with a secret becomes the
// provider's key method; a route without one (an AWS profile, Application Default
// Credentials) becomes an `external` method.
//
// Only API-key logins are explored. They are prompts and no side effects. An
// OAuth login starts servers and network calls, so it is never run to be looked at.

import { invalidRequest } from '../bridge/errors.js';

/** Stops a walk at a `select` prompt after recording its options. */
const FORK = Symbol('fork');

const MAX_RUNS = 24;
const MAX_DEPTH = 4;
const RUN_TIMEOUT_MS = 1500;
/** However many branches a login has, the walk as a whole is over after this. */
const WALK_DEADLINE_MS = 4000;

/** A prompt that only waits for Enter ("Configure AWS credentials, then press Enter to continue") needs no answer from the user. */
const isAcknowledgement = (message) => /press enter/i.test(message);

/** "Enter Cloudflare account ID" is shown as "Cloudflare account ID". */
const titleOf = (message) => message.replace(/^enter\s+/i, '').replace(/^./, (first) => first.toUpperCase());
const slug = (message) => titleOf(message).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';

/** Field keys for a route's text prompts, unique within the route. */
const fieldKeys = (steps) => {
  const seen = new Map();
  return steps.map((step) => {
    if (step.type !== 'text' || isAcknowledgement(step.message)) return null;
    const base = slug(step.message);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
};

const withKeys = (route) => {
  const keys = fieldKeys(route.steps);
  return { ...route, steps: route.steps.map((step, index) => (keys[index] ? { ...step, key: keys[index] } : step)) };
};

/**
 * @param {(interaction: object) => Promise<unknown>} login  `provider.auth.apiKey.login`
 * @returns {Promise<Array<{ id: string, label: string, selects: string[], steps: object[], secret: boolean }>>}
 */
export const exploreApiKeyLogin = async (login) => {
  const routes = [];
  let runs = 0;
  const deadline = Date.now() + WALK_DEADLINE_MS;

  const walk = async (selects, labels) => {
    if (runs >= MAX_RUNS || Date.now() > deadline) return;
    runs += 1;
    const steps = [];
    const controller = new AbortController();
    let fork = null;
    let selectIndex = 0;
    const interaction = {
      signal: controller.signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (prompt.type === 'select') {
          if (selectIndex < selects.length) {
            const chosen = selects[selectIndex];
            selectIndex += 1;
            steps.push({ type: 'select', message: prompt.message, answer: chosen });
            return chosen;
          }
          fork = prompt;
          controller.abort();
          throw FORK;
        }
        steps.push({ type: prompt.type, message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) });
        return prompt.type === 'secret' ? 'probe' : '';
      },
    };
    // A login that ignores its signal must not hold the list: stop waiting for it.
    let timer;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('The login did not finish'));
      }, RUN_TIMEOUT_MS);
      timer.unref?.();
    });
    const running = Promise.resolve().then(() => login(interaction));
    running.catch(() => {});
    try {
      await Promise.race([running, timedOut]);
    } catch (error) {
      if (error !== FORK) return;
    } finally {
      clearTimeout(timer);
    }
    if (fork) {
      if (selects.length >= MAX_DEPTH) return;
      for (const option of fork.options) await walk([...selects, option.id], [...labels, option.label]);
      return;
    }
    routes.push(withKeys({ id: selects.join('/') || 'default', label: labels.join(' / '), selects, steps, secret: steps.some((step) => step.type === 'secret') }));
  };

  await walk([], []);
  return routes;
};

/** The one-secret route that stands in when a login cannot be explored. */
const FALLBACK_KEY_ROUTE = Object.freeze({ id: 'default', label: '', selects: [], steps: [{ type: 'secret', message: 'API key' }], secret: true });

/**
 * The methods a provider's API-key login gives: `keyRoute` (the first route that
 * asks for a secret) and one `externalRoutes` entry per route that does not.
 *
 * @param {((interaction: object) => Promise<unknown>) | undefined} login
 */
export const planApiKeyLogin = async (login) => {
  if (typeof login !== 'function') return { keyRoute: null, externalRoutes: [] };
  const routes = await exploreApiKeyLogin(login).catch(() => []);
  if (routes.length === 0) return { keyRoute: FALLBACK_KEY_ROUTE, externalRoutes: [] };
  return { keyRoute: routes.find((route) => route.secret) ?? null, externalRoutes: routes.filter((route) => !route.secret) };
};

/** The form fields of a route: one string field per text prompt. */
export const formOfRoute = (route) => route.steps
  .filter((step) => step.key)
  .map((step) => ({
    key: step.key,
    title: titleOf(step.message),
    type: 'string',
    required: true,
    ...(step.placeholder ? { placeholder: step.placeholder } : {}),
  }));

/**
 * The `AuthInteraction` that walks a route with the user's answers: selects take
 * the route's options, text prompts the matching `answer` entry, the secret the
 * key. A text prompt without an answer is a 400, so nothing half-configured is
 * stored.
 *
 * @param {{ steps: object[], selects: string[] }} route
 * @param {{ key?: string, answer?: Record<string, unknown>, signal?: AbortSignal }} input
 */
export const interactionForRoute = (route, { key, answer = {}, signal }) => {
  const byMessage = new Map(route.steps.filter((step) => step.key).map((step) => [step.message, step.key]));
  let selectIndex = 0;
  let secrets = 0;
  return {
    ...(signal ? { signal } : {}),
    notify: () => {},
    prompt: async (prompt) => {
      if (prompt.type === 'select') {
        const wanted = route.selects[selectIndex];
        selectIndex += 1;
        const option = prompt.options.find((candidate) => candidate.id === wanted) ?? prompt.options[0];
        return option.id;
      }
      if (prompt.type === 'secret') {
        secrets += 1;
        if (typeof key !== 'string' || key === '' || secrets > 1) throw invalidRequest(`${prompt.message} is required`, { kind: 'Payload', field: 'key' });
        return key;
      }
      if (prompt.type === 'text') {
        if (isAcknowledgement(prompt.message)) return '';
        const field = byMessage.get(prompt.message) ?? slug(prompt.message);
        const value = answer[field];
        const given = typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
        if (given === '') throw invalidRequest(`${prompt.message} is required`, { kind: 'Payload', field });
        return given;
      }
      throw invalidRequest(`This login asks for something a key form cannot answer: ${prompt.message}`, { kind: 'Payload' });
    },
  };
};
