// OAuth sign-ins, as the stateful attempts the Providers page polls.
//
// The page starts an attempt (`connect/oauth`), shows the link or code it gets
// back, polls `status` until the attempt settles, and for a pasted code sends it
// to `complete`. Pi's `ModelRuntime.login(provider, 'oauth', interaction)` is one
// long call that talks through its `AuthInteraction`: `notify` hands out the link
// or the device code, `prompt` asks for a pasted code. An attempt is that call,
// running in the background, with what it says kept where `start`, `status` and
// `complete` can read it.
//
// What an attempt does with Pi's callbacks:
// - `notify` `auth_url`, `device_code`: the link, the instructions and the code
//   the page shows. A device code goes into the instructions as "Enter code:
//   ABCD-1234", which is where the page looks for it.
// - `prompt` `manual_code`: the flow also takes a pasted code or redirect URL.
//   When the prompt names a redirect address (`http://localhost:PORT/...`) the
//   browser can finish the flow itself and the paste is the way out for a
//   browser that cannot reach this machine: mode `auto` with `paste`. Otherwise
//   the paste is the only way (Anthropic's copy-code login): mode `code`.
// - `prompt` `select`: the first option, so the default login method runs. A
//   `text` prompt is answered from the connect request's `answer`, else left empty.
// - A prompt whose `signal` aborts (the browser callback won the race) is dropped.
//
// One attempt per provider: starting another cancels the first. An attempt ends
// when it settles, is cancelled, or runs out its time; a settled one stays
// readable for a few minutes so a poll that is a beat late still sees the result.

import { randomBytes } from 'node:crypto';

import { WireError, invalidRequest } from '../bridge/errors.js';

const DEFAULT_TTL_MS = 10 * 60_000;
const RETAIN_SETTLED_MS = 5 * 60_000;
const FIRST_SIGN_TIMEOUT_MS = 20_000;
const COMPLETE_WAIT_MS = 45_000;
/** A manual-code prompt follows the link in the same tick; this is the pause to let it register. */
const PROMPT_GRACE_MS = 40;

/** What the OAuth flow asks in a text prompt, by what the prompt says. Only GitHub Copilot asks one. */
export const OAUTH_PROMPT_FIELDS = [
  { match: /enterprise/i, key: 'enterprise_domain', title: 'GitHub Enterprise URL or domain', description: 'Leave empty for github.com.', placeholder: 'company.ghe.com' },
];

/** The form a provider's OAuth method carries, for the prompts the flow is known to ask. */
export const oauthFormFor = (providerId) => (providerId === 'github-copilot'
  ? OAUTH_PROMPT_FIELDS.map(({ key, title, description, placeholder }) => ({ key, title, description, placeholder, type: 'string' }))
  : []);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const attemptNotFound = (integrationID, attemptID) => new WireError(404, 'IntegrationAttemptNotFoundError', `Sign-in attempt not found: ${attemptID}`, { integrationID, attemptID });

/**
 * What a failed login says to the person: the first sentence of Pi's message.
 * Pi's token-exchange errors append the request details and a stack trace.
 */
export const describeLoginError = (error) => {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split(/;\s*(?:details|stack|body)=/)[0].split('\n')[0].trim();
  return (first || 'The sign-in failed').slice(0, 300);
};

/**
 * @param {object} options
 * @param {(providerId: string, interaction: object) => Promise<unknown>} options.login  Runs Pi's OAuth login and stores the credential.
 * @param {(attempt: { providerId: string, label?: string }) => void | Promise<void>} [options.onSettled]  Called once after a login stored its credential.
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.firstSignTimeoutMs]
 * @param {number} [options.completeWaitMs]
 * @param {(message: string) => void} [options.log]
 */
export const createOAuthFlows = ({
  login,
  onSettled = () => {},
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  firstSignTimeoutMs = FIRST_SIGN_TIMEOUT_MS,
  completeWaitMs = COMPLETE_WAIT_MS,
  log = () => {},
}) => {
  /** @type {Map<string, any>} */
  const attempts = new Map();
  const byProvider = new Map();

  const forget = (attempt) => {
    clearTimeout(attempt.expiryTimer);
    clearTimeout(attempt.retainTimer);
    if (attempts.get(attempt.id) === attempt) attempts.delete(attempt.id);
    if (byProvider.get(attempt.providerId) === attempt.id) byProvider.delete(attempt.providerId);
  };

  const retain = (attempt) => {
    clearTimeout(attempt.expiryTimer);
    clearTimeout(attempt.retainTimer);
    attempt.retainTimer = setTimeout(() => forget(attempt), RETAIN_SETTLED_MS);
    attempt.retainTimer.unref?.();
  };

  /** Stops the login. What it then rejects with is not the attempt's result: `ended` marks that. */
  const abort = (attempt) => {
    attempt.ended = true;
    attempt.controller.abort();
    attempt.manual?.reject(new Error('Login cancelled'));
    attempt.manual = null;
  };

  const handleEvent = (attempt, event) => {
    if (event.type === 'auth_url') {
      attempt.url = event.url;
      attempt.instructions = event.instructions ?? '';
    } else if (event.type === 'device_code') {
      attempt.url = event.verificationUri;
      attempt.instructions = `Enter code: ${event.userCode}`;
      if (Number.isFinite(event.expiresInSeconds)) attempt.expires = Math.min(attempt.expires, now() + event.expiresInSeconds * 1000);
    }
  };

  const handlePrompt = (attempt, prompt, answer) => {
    if (prompt.type === 'manual_code') {
      return new Promise((resolve, reject) => {
        const manual = { resolve, reject, placeholder: String(prompt.placeholder ?? '') };
        attempt.manual = manual;
        const drop = () => {
          if (attempt.manual === manual) attempt.manual = null;
          reject(new Error('Login cancelled'));
        };
        prompt.signal?.addEventListener('abort', drop, { once: true });
      });
    }
    if (prompt.type === 'select') return Promise.resolve(prompt.options[0].id);
    if (prompt.type === 'text') {
      const field = OAUTH_PROMPT_FIELDS.find((candidate) => candidate.match.test(prompt.message));
      const value = field ? answer[field.key] : undefined;
      return Promise.resolve(typeof value === 'string' ? value.trim() : '');
    }
    return Promise.reject(new Error(`This sign-in asks for "${prompt.message}", which the page cannot answer`));
  };

  const view = (attempt) => ({ attemptID: attempt.id, time: { created: attempt.created, expires: attempt.expires } });

  /**
   * Starts an attempt and answers once the flow has given its link or code.
   *
   * @returns {Promise<{ attemptID: string, url: string, instructions: string, mode: 'auto' | 'code', paste?: true, time: { created: number, expires: number } }>}
   */
  const start = async ({ providerId, answer = {}, label }) => {
    const previous = byProvider.get(providerId);
    if (previous) {
      const old = attempts.get(previous);
      if (old) {
        if (old.status === 'pending') abort(old);
        forget(old);
      }
    }

    const created = now();
    const attempt = {
      id: `att_${randomBytes(12).toString('hex')}`,
      providerId,
      label,
      controller: new AbortController(),
      created,
      expires: created + ttlMs,
      status: 'pending',
      message: '',
      url: '',
      instructions: '',
      manual: null,
      ended: false,
    };
    attempts.set(attempt.id, attempt);
    byProvider.set(providerId, attempt.id);

    let signed;
    const firstSign = new Promise((resolve) => { signed = resolve; });
    const interaction = {
      signal: attempt.controller.signal,
      notify: (event) => {
        handleEvent(attempt, event);
        if (event.type === 'auth_url' || event.type === 'device_code') signed();
      },
      prompt: (prompt) => handlePrompt(attempt, prompt, answer),
    };

    attempt.done = login(providerId, interaction).then(
      async () => {
        // The credential is stored either way, so the follow-up runs; the page was already told how the attempt ended.
        if (!attempt.ended) attempt.status = 'complete';
        try {
          await onSettled(attempt);
        } catch (error) {
          log(`sign-in follow-up for ${providerId} failed: ${error?.message ?? error}`);
        }
      },
      (error) => {
        if (attempt.ended) return;
        attempt.status = 'failed';
        attempt.message = error instanceof WireError ? error.message : describeLoginError(error);
      },
    ).finally(() => {
      attempt.manual = null;
      signed();
      if (attempts.get(attempt.id) === attempt) retain(attempt);
    });

    attempt.expiryTimer = setTimeout(() => {
      if (attempt.status !== 'pending') return;
      abort(attempt);
      attempt.status = 'failed';
      attempt.message = 'The sign-in expired. Start it again.';
      retain(attempt);
    }, Math.max(1, attempt.expires - created));
    attempt.expiryTimer.unref?.();

    let timeout;
    await Promise.race([
      firstSign,
      attempt.done,
      new Promise((resolve) => { timeout = setTimeout(resolve, firstSignTimeoutMs); timeout.unref?.(); }),
    ]);
    clearTimeout(timeout);

    if (attempt.status === 'failed') {
      forget(attempt);
      throw invalidRequest(attempt.message, { kind: 'Payload' });
    }
    if (attempt.status === 'pending' && !attempt.url) {
      abort(attempt);
      forget(attempt);
      throw invalidRequest('The provider did not give a sign-in link in time. Try again.', { kind: 'Payload' });
    }
    if (attempt.status === 'pending') await sleep(PROMPT_GRACE_MS);

    const base = { attemptID: attempt.id, url: attempt.url, instructions: attempt.instructions, time: { created: attempt.created, expires: attempt.expires } };
    if (!attempt.manual) return { ...base, mode: 'auto' };
    return /^https?:\/\//i.test(attempt.manual.placeholder) ? { ...base, mode: 'auto', paste: true } : { ...base, mode: 'code' };
  };

  const find = (providerId, attemptID) => {
    const attempt = attempts.get(attemptID);
    if (!attempt || attempt.providerId !== providerId) throw attemptNotFound(providerId, attemptID);
    return attempt;
  };

  const status = (providerId, attemptID) => {
    const attempt = find(providerId, attemptID);
    const { time } = view(attempt);
    if (attempt.status === 'failed') return { status: 'failed', message: attempt.message, time };
    return { status: attempt.status, time };
  };

  /**
   * Hands a pasted code or redirect address to the waiting flow and answers when
   * the flow settles (the token exchange is one request), so the page's next read
   * is the result. A flow that fails after the paste answers with its message.
   */
  const complete = async (providerId, attemptID, code) => {
    const attempt = find(providerId, attemptID);
    if (attempt.status === 'complete') return;
    if (attempt.status === 'failed') throw invalidRequest(attempt.message, { kind: 'Payload' });
    if (typeof code !== 'string' || code.trim() === '') throw invalidRequest('A code is required', { kind: 'Payload', field: 'code' });
    if (!attempt.manual) throw invalidRequest('This sign-in finishes in the browser and takes no pasted code', { kind: 'Payload', field: 'code' });
    const { resolve } = attempt.manual;
    attempt.manual = null;
    resolve(code.trim());
    let timer;
    await Promise.race([attempt.done, new Promise((done) => { timer = setTimeout(done, completeWaitMs); })]);
    clearTimeout(timer);
    if (attempt.status === 'failed') throw invalidRequest(attempt.message, { kind: 'Payload' });
  };

  /** Ends an attempt and its login. An attempt that already ended is only forgotten. */
  const cancel = (providerId, attemptID) => {
    const attempt = find(providerId, attemptID);
    if (attempt.status === 'pending') abort(attempt);
    forget(attempt);
  };

  const close = () => {
    for (const attempt of [...attempts.values()]) {
      if (attempt.status === 'pending') abort(attempt);
      forget(attempt);
    }
  };

  return { start, status, complete, cancel, close, get size() { return attempts.size; } };
};
