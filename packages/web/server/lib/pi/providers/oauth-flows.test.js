import { afterEach, describe, expect, it } from 'vitest';

import { WireError } from '../bridge/errors.js';
import { createOAuthFlows, describeLoginError } from './oauth-flows.js';

// The attempts over fake logins: what each kind of login says through Pi's
// AuthInteraction, and what start, status, complete and cancel make of it.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** A login that shows a link, then waits for what `behavior` says. */
const make = (login, options = {}) => createOAuthFlows({ login, firstSignTimeoutMs: 500, completeWaitMs: 500, ...options });

let flows;
afterEach(() => { flows?.close(); flows = null; });

describe('an attempt that needs a pasted code', () => {
  it('opens with the link and mode code, takes the code through complete and settles as complete', async () => {
    const stored = [];
    flows = make(async (providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize', instructions: 'Sign in, then copy the code.' });
      const code = await interaction.prompt({ type: 'manual_code', message: 'Paste the code', placeholder: 'code#state' });
      if (code !== 'good') throw new Error('Missing authorization code');
      stored.push(providerId);
    });

    const attempt = await flows.start({ providerId: 'p1' });
    expect(attempt).toMatchObject({ url: 'https://auth.example/authorize', instructions: 'Sign in, then copy the code.', mode: 'code' });
    expect(attempt.paste).toBeUndefined();
    expect(attempt.time.expires).toBeGreaterThan(attempt.time.created);
    expect(flows.status('p1', attempt.attemptID)).toMatchObject({ status: 'pending' });

    await flows.complete('p1', attempt.attemptID, ' good ');
    expect(stored).toEqual(['p1']);
    expect(flows.status('p1', attempt.attemptID)).toMatchObject({ status: 'complete' });
    // A second complete of a settled attempt changes nothing.
    await flows.complete('p1', attempt.attemptID, 'again');
  });

  it('answers a wrong code with the flow\'s own message and settles as failed', async () => {
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await interaction.prompt({ type: 'manual_code', message: 'Paste', placeholder: 'code#state' });
      throw new Error('OAuth state mismatch; details=url=https://x; stack=Error: at secret/path.js:1');
    });
    const attempt = await flows.start({ providerId: 'p1' });
    await expect(flows.complete('p1', attempt.attemptID, 'bad')).rejects.toMatchObject({ status: 400, message: 'OAuth state mismatch' });
    expect(flows.status('p1', attempt.attemptID)).toEqual({ status: 'failed', message: 'OAuth state mismatch', time: expect.any(Object) });
  });

  it('refuses an empty code and a code for a flow that takes none', async () => {
    const waiting = deferred();
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' });
      await waiting.promise;
    });
    const device = await flows.start({ providerId: 'device' });
    await expect(flows.complete('device', device.attemptID, 'x')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/browser/) });

    flows.close();
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await interaction.prompt({ type: 'manual_code', message: 'Paste', placeholder: 'code#state' });
    });
    const attempt = await flows.start({ providerId: 'p1' });
    await expect(flows.complete('p1', attempt.attemptID, '  ')).rejects.toMatchObject({ status: 400, extra: { field: 'code' } });
  });
});

describe('an attempt the browser can finish by itself', () => {
  it('opens in mode auto with paste when the flow also takes a redirect address, and drops the paste once the browser won', async () => {
    const browser = deferred();
    let promptSignal;
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize', instructions: 'Complete login in your browser.' });
      const manual = new AbortController();
      promptSignal = manual;
      interaction.prompt({ type: 'manual_code', message: 'Paste the redirect URL', placeholder: 'http://localhost:53692/callback', signal: manual.signal }).catch(() => {});
      await browser.promise;
      manual.abort();
    });

    const attempt = await flows.start({ providerId: 'p1' });
    expect(attempt).toMatchObject({ mode: 'auto', paste: true });
    browser.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(promptSignal.signal.aborted).toBe(true);
    expect(flows.status('p1', attempt.attemptID)).toMatchObject({ status: 'complete' });
    // The paste is gone with the prompt.
    await expect(flows.complete('p1', attempt.attemptID, 'late')).resolves.toBeUndefined();
  });

  it('opens in mode auto without paste for a device code and shows the code where the page looks for it', async () => {
    const approved = deferred();
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'device_code', userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 });
      await approved.promise;
    });
    const attempt = await flows.start({ providerId: 'copilot' });
    expect(attempt).toMatchObject({ mode: 'auto', url: 'https://github.com/login/device', instructions: 'Enter code: WXYZ-9876' });
    expect(attempt.paste).toBeUndefined();
    expect(flows.status('copilot', attempt.attemptID).status).toBe('pending');
    approved.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flows.status('copilot', attempt.attemptID).status).toBe('complete');
  });
});

describe('prompts the page does not show', () => {
  it('takes the first option of a login-method select and answers a text prompt from the connect answer', async () => {
    const asked = [];
    flows = make(async (_providerId, interaction) => {
      asked.push(await interaction.prompt({ type: 'select', message: 'Select login method:', options: [{ id: 'browser', label: 'Browser' }, { id: 'headless', label: 'Headless' }] }));
      asked.push(await interaction.prompt({ type: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' }));
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await new Promise(() => {});
    });
    await flows.start({ providerId: 'p1', answer: { enterprise_domain: ' company.ghe.com ' } });
    expect(asked).toEqual(['browser', 'company.ghe.com']);
  });

  it('fails a start whose login needs something it cannot ask, with the login\'s own words', async () => {
    flows = make(async (_providerId, interaction) => {
      await interaction.prompt({ type: 'secret', message: 'Enter a token' });
    });
    await expect(flows.start({ providerId: 'p1' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Enter a token') });
    expect(flows.size).toBe(0);
  });
});

describe('ending an attempt', () => {
  it('cancels the login through its signal and forgets the attempt', async () => {
    let signal;
    flows = make(async (_providerId, interaction) => {
      signal = interaction.signal;
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await new Promise((_resolve, reject) => interaction.signal.addEventListener('abort', () => reject(new Error('Login cancelled'))));
    });
    const attempt = await flows.start({ providerId: 'p1' });
    flows.cancel('p1', attempt.attemptID);
    expect(signal.aborted).toBe(true);
    expect(() => flows.status('p1', attempt.attemptID)).toThrow(WireError);
    expect(flows.size).toBe(0);
  });

  it('keeps one attempt per provider: starting again cancels the first', async () => {
    const signals = [];
    flows = make(async (_providerId, interaction) => {
      signals.push(interaction.signal);
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await new Promise(() => {});
    });
    const first = await flows.start({ providerId: 'p1' });
    const other = await flows.start({ providerId: 'p2' });
    const second = await flows.start({ providerId: 'p1' });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    expect(() => flows.status('p1', first.attemptID)).toThrow(/not found/);
    expect(flows.status('p1', second.attemptID).status).toBe('pending');
    expect(flows.status('p2', other.attemptID).status).toBe('pending');
  });

  it('settles an attempt that runs out its time as failed, with the reason, and stops the login', async () => {
    let signal;
    flows = make(async (_providerId, interaction) => {
      signal = interaction.signal;
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      // Pi's logins reject when their signal aborts.
      await new Promise((_resolve, reject) => interaction.signal.addEventListener('abort', () => reject(new Error('Login cancelled'))));
    }, { ttlMs: 60 });
    const attempt = await flows.start({ providerId: 'p1' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(signal.aborted).toBe(true);
    expect(flows.status('p1', attempt.attemptID)).toMatchObject({ status: 'failed', message: expect.stringMatching(/expired/) });
  });

  it('still runs the follow-up when a login stores its credential after the attempt ran out, and keeps what the page was told', async () => {
    const settled = [];
    flows = make(async (providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      // A login that ignores its signal and finishes after the attempt expired.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }, { ttlMs: 40, onSettled: (attempt) => settled.push(attempt.providerId) });
    const attempt = await flows.start({ providerId: 'p1' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(flows.status('p1', attempt.attemptID)).toMatchObject({ status: 'failed', message: expect.stringMatching(/expired/) });
    expect(settled).toEqual(['p1']);
  });

  it('refuses an attempt id that belongs to another provider', async () => {
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/a' });
      await new Promise(() => {});
    });
    const attempt = await flows.start({ providerId: 'p1' });
    expect(() => flows.status('p2', attempt.attemptID)).toThrow(/not found/);
    expect(() => flows.cancel('p2', attempt.attemptID)).toThrow(/not found/);
  });

  it('fails a start whose login gives no link in time and leaves nothing running', async () => {
    let signal;
    flows = make(async (_providerId, interaction) => {
      signal = interaction.signal;
      await new Promise(() => {});
    }, { firstSignTimeoutMs: 30 });
    await expect(flows.start({ providerId: 'p1' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/link/) });
    expect(signal.aborted).toBe(true);
    expect(flows.size).toBe(0);
  });

  it('runs the follow-up once, after the login stored its credential', async () => {
    const settled = [];
    flows = make(async (_providerId, interaction) => {
      interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://x.example/device' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }, { onSettled: (attempt) => settled.push([attempt.providerId, attempt.label]) });
    await flows.start({ providerId: 'p1', label: 'Work' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toEqual([['p1', 'Work']]);
  });
});

describe('describeLoginError', () => {
  it('keeps the first sentence of Pi\'s message and drops request details and stack traces', () => {
    expect(describeLoginError(new Error('Token exchange request failed. url=https://x/token; details=Error: boom; stack=at foo'))).toBe('Token exchange request failed. url=https://x/token');
    expect(describeLoginError(new Error('line one\nline two'))).toBe('line one');
    expect(describeLoginError(new Error(''))).toBe('The sign-in failed');
  });
});
