import { describe, expect, it } from 'vitest';

import { exploreApiKeyLogin, formOfRoute, interactionForRoute, planApiKeyLogin } from './login-plan.js';

// Pi's API-key logins are functions that prompt. These are fake ones with the
// shapes of Pi's own (one secret; secret plus text; a method select that forks).

const oneSecret = async (interaction) => ({ type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Enter Acme API key' }) });
const withAccount = async (interaction) => {
  const key = await interaction.prompt({ type: 'secret', message: 'Enter Acme API key' });
  const account = await interaction.prompt({ type: 'text', message: 'Enter Acme account ID' });
  return { type: 'api_key', key, env: { ACME_ACCOUNT: account } };
};
const methods = async (interaction) => {
  const method = await interaction.prompt({
    type: 'select',
    message: 'Select method:',
    options: [{ id: 'token', label: 'Bearer token' }, { id: 'profile', label: 'Profile' }, { id: 'chain', label: 'Existing chain' }],
  });
  if (method === 'token') return { type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Enter token' }) };
  if (method === 'profile') return { type: 'api_key', env: { PROFILE: await interaction.prompt({ type: 'text', message: 'Enter profile name' }) } };
  await interaction.prompt({ type: 'text', message: 'Configure credentials, then press Enter to continue' });
  return { type: 'api_key' };
};

describe('planApiKeyLogin', () => {
  it('finds the single secret of an ordinary login and no extra form', async () => {
    const plan = await planApiKeyLogin(oneSecret);
    expect(plan.keyRoute).toMatchObject({ id: 'default', secret: true });
    expect(formOfRoute(plan.keyRoute)).toEqual([]);
    expect(plan.externalRoutes).toEqual([]);
  });

  it('turns the other prompts of a login into form fields with readable titles', async () => {
    const { keyRoute } = await planApiKeyLogin(withAccount);
    expect(formOfRoute(keyRoute)).toEqual([{ key: 'acme_account_id', title: 'Acme account ID', type: 'string', required: true }]);
  });

  it('walks every branch of a method select: the route with a secret is the key, the others are external', async () => {
    const plan = await planApiKeyLogin(methods);
    expect(plan.keyRoute).toMatchObject({ id: 'token', label: 'Bearer token' });
    expect(plan.externalRoutes.map((route) => [route.id, route.label])).toEqual([['profile', 'Profile'], ['chain', 'Existing chain']]);
    expect(formOfRoute(plan.externalRoutes[0])).toEqual([{ key: 'profile_name', title: 'Profile name', type: 'string', required: true }]);
    // A prompt that only waits for Enter needs no answer from the page.
    expect(formOfRoute(plan.externalRoutes[1])).toEqual([]);
  });

  it('plans nothing for an ambient-only provider and a plain key for a login that cannot be walked', async () => {
    expect(await planApiKeyLogin(undefined)).toEqual({ keyRoute: null, externalRoutes: [] });
    const broken = await planApiKeyLogin(async () => { throw new Error('boom'); });
    expect(broken.keyRoute).toMatchObject({ id: 'default', secret: true });
    expect(broken.externalRoutes).toEqual([]);
  });

  it('gives up on a login that never answers, without hanging', async () => {
    const started = Date.now();
    const routes = await exploreApiKeyLogin(() => new Promise(() => {}));
    expect(routes).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('interactionForRoute', () => {
  const run = async (login, input) => {
    const { keyRoute, externalRoutes } = await planApiKeyLogin(login);
    const route = input.route === 'external' ? externalRoutes[0] : keyRoute;
    return login(interactionForRoute(route, input));
  };

  it('answers the secret and the text prompts from the key and the answer map', async () => {
    expect(await run(withAccount, { key: 'fake', answer: { acme_account_id: ' acct ' } })).toEqual({ type: 'api_key', key: 'fake', env: { ACME_ACCOUNT: 'acct' } });
  });

  it('picks the route\'s options in a select and answers an acknowledgement prompt itself', async () => {
    expect(await run(methods, { route: 'external', answer: { profile_name: 'work' } })).toEqual({ type: 'api_key', env: { PROFILE: 'work' } });
    expect(await run(methods, { key: 'fake' })).toEqual({ type: 'api_key', key: 'fake' });
  });

  it('refuses a missing key or answer with a tagged 400 naming the field', async () => {
    await expect(run(oneSecret, { key: '' })).rejects.toMatchObject({ status: 400, extra: { field: 'key' } });
    await expect(run(withAccount, { key: 'fake', answer: {} })).rejects.toMatchObject({ status: 400, extra: { field: 'acme_account_id' } });
    await expect(run(withAccount, { key: 'fake', answer: { acme_account_id: '   ' } })).rejects.toMatchObject({ status: 400 });
  });
});
