import { describe, expect, it, vi } from 'vitest';

import { createMcpOAuth, mcpIntegrationOf } from './mcp-oauth.js';

const remote = (name, extra = {}) => ({ name, type: 'remote', url: `https://${name}.example.com`, ...extra });

const setup = ({ servers = [remote('docs')], now = () => 1000 } = {}) => {
  let finish;
  let output = null;
  const kill = vi.fn(() => finish?.({ code: null, stdout: '', stderr: 'terminated' }));
  const runLogin = vi.fn((serverName, directory, onLine) => {
    output = onLine;
    return { kill, result: new Promise((resolve) => { finish = resolve; }) };
  });
  const mcpOAuth = createMcpOAuth({ listServers: async () => servers, runLogin, now });
  return { mcpOAuth, runLogin, kill, end: (result) => finish(result), say: (line) => output?.(line) };
};

describe('MCP servers as OAuth integrations', () => {
  it('lists only remote servers that do not turn OAuth off, with the id the UI matches', async () => {
    const { mcpOAuth } = setup({
      servers: [remote('docs'), remote('noAuth', { oauth: false }), { name: 'local', type: 'local', command: ['node'] }],
    });
    const integrations = await mcpOAuth.integrations('/work/project');
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({ name: 'docs', metadata: { source: 'mcp' }, methods: [{ id: 'oauth', type: 'oauth' }] });
    expect(integrations[0].id).toMatch(/^mcp_[0-9a-f]{16}$/);
    expect((await mcpOAuth.integration(integrations[0].id, '/work/project')).name).toBe('docs');
    expect(await mcpOAuth.integration('anthropic', '/work/project')).toBeNull();
    expect(mcpIntegrationOf(remote('docs')).id).toBe(integrations[0].id);
  });

  it('runs one login per attempt and reports its URL, then complete on a clean exit', async () => {
    const { mcpOAuth, runLogin, end, say } = setup();
    const [integration] = await mcpOAuth.integrations(null);
    const attempt = await mcpOAuth.start({ integrationID: integration.id, directory: '/work/project' });
    expect(runLogin).toHaveBeenCalledWith('docs', '/work/project', expect.any(Function));
    expect(attempt).toMatchObject({ mode: 'auto', paste: true, url: '', instructions: expect.stringContaining('docs') });

    say('Open this in your browser: https://auth.example.com/start');
    expect(mcpOAuth.status(integration.id, attempt.attemptID).status).toBe('pending');
    end({ code: 0, stdout: '', stderr: '' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mcpOAuth.status(integration.id, attempt.attemptID).status).toBe('complete');
  });

  it('fails an attempt whose login exits non-zero, and cancels one that is killed', async () => {
    const first = setup();
    const [integration] = await first.mcpOAuth.integrations(null);
    const failed = await first.mcpOAuth.start({ integrationID: integration.id, directory: null });
    first.end({ code: 1, stdout: '', stderr: 'Sign-in failed: access denied' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.mcpOAuth.status(integration.id, failed.attemptID)).toMatchObject({ status: 'failed', message: 'Sign-in failed: access denied' });

    const second = setup();
    const cancelled = await second.mcpOAuth.start({ integrationID: integration.id, directory: null });
    second.mcpOAuth.cancel(integration.id, cancelled.attemptID);
    expect(second.kill).toHaveBeenCalledOnce();
    expect(second.mcpOAuth.status(integration.id, cancelled.attemptID)).toMatchObject({ status: 'failed', message: expect.stringContaining('cancelled') });
  });

  it('fails an attempt left open past its expiry and refuses an attempt of another integration', async () => {
    let now = 0;
    const { mcpOAuth } = setup({ now: () => now });
    const [integration] = await mcpOAuth.integrations(null);
    const attempt = await mcpOAuth.start({ integrationID: integration.id, directory: null });
    now = attempt.time.expires + 1;
    expect(mcpOAuth.status(integration.id, attempt.attemptID)).toMatchObject({ status: 'failed', message: expect.stringContaining('expired') });
    await expect(async () => mcpOAuth.status('mcp_other', attempt.attemptID)).rejects.toMatchObject({ status: 404 });
    await expect(async () => mcpOAuth.start({ integrationID: 'mcp_unknown', directory: null })).rejects.toMatchObject({ status: 404 });
  });
});
