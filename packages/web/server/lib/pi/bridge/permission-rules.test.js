import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { decide, deniedToolNames, describeToolCall, lastMatchingRule, matchesPattern, splitShellCommand } from './permission-rules.js';

// The default agent of OpenCode 2.2.6 (golden 02): everything is allowed except .env files and the browser.
const BUILD_AGENT = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
  { action: 'question', resource: '*', effect: 'allow' },
  { action: 'browser', resource: '*', effect: 'deny' },
  { action: 'skill', resource: 'browser', effect: 'deny' },
];

const effectOf = (options) => decide(options).effect;
const check = (value, strict = false) => ({ value, strict });

describe('matching', () => {
  it('lets * stand for any characters, slashes and newlines included', () => {
    expect(matchesPattern('*', '')).toBe(true);
    expect(matchesPattern('*.env', '/work/project/.env')).toBe(true);
    expect(matchesPattern('/work/*', '/work/a/b/c.txt')).toBe(true);
    expect(matchesPattern('echo *', 'echo a\nb')).toBe(true);
    expect(matchesPattern('*.env', '/work/project/.env.local')).toBe(false);
    expect(matchesPattern('/work/*', '/other/a')).toBe(false);
  });

  it('takes every other character literally', () => {
    expect(matchesPattern('a.b', 'axb')).toBe(false);
    expect(matchesPattern('a.b', 'a.b')).toBe(true);
    expect(matchesPattern('what?', 'what?')).toBe(true);
    expect(matchesPattern('what?', 'whats')).toBe(false);
    expect(matchesPattern('(x)+[y]', '(x)+[y]')).toBe(true);
  });

  it('lets a pattern ending in " *" also match the bare prefix', () => {
    expect(matchesPattern('ls *', 'ls')).toBe(true);
    expect(matchesPattern('ls *', 'ls -la')).toBe(true);
    expect(matchesPattern('ls *', 'lsof')).toBe(false);
    expect(matchesPattern('ls*', 'lsof')).toBe(true);
  });

  it('picks the last matching rule', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'rm *', effect: 'deny' },
      { action: 'shell', resource: 'rm -i *', effect: 'ask' },
    ];
    expect(lastMatchingRule('shell', 'ls', rules).effect).toBe('allow');
    expect(lastMatchingRule('shell', 'rm -rf x', rules).effect).toBe('deny');
    expect(lastMatchingRule('shell', 'rm -i x', rules).effect).toBe('ask');
    expect(lastMatchingRule('shell', 'ls', rules.slice(1))).toBeNull();
  });

  it('skips entries that are not rules', () => {
    expect(lastMatchingRule('shell', 'ls', [null, 'x', { action: 'shell' }, { action: '*', resource: '*', effect: 'deny' }]).effect).toBe('deny');
    expect(lastMatchingRule('shell', 'ls', undefined, 'nope')).toBeNull();
  });
});

describe('deciding', () => {
  it('asks when no rule matches', () => {
    expect(effectOf({ action: 'shell', checks: [check('ls')] })).toBe('ask');
  });

  it('allows everything but .env files under the default agent, and .env.example again', () => {
    const read = (file) => effectOf({ action: 'read', checks: [check(file)], agentRules: BUILD_AGENT });
    expect(read('/work/project/src/index.ts')).toBe('allow');
    expect(read('/work/project/.env')).toBe('ask');
    expect(read('/work/project/.env.local')).toBe('ask');
    expect(read('/work/project/.env.example')).toBe('allow');
    expect(effectOf({ action: 'shell', checks: [check('rm -rf /')], agentRules: BUILD_AGENT })).toBe('allow');
    expect(effectOf({ action: 'browser', checks: [check('*')], agentRules: BUILD_AGENT })).toBe('deny');
  });

  it('lets the session rules outrank the agent rules', () => {
    const sessionRules = [{ action: 'shell', resource: '*', effect: 'ask' }];
    expect(effectOf({ action: 'shell', checks: [check('echo hi')], agentRules: BUILD_AGENT, sessionRules })).toBe('ask');
    expect(effectOf({ action: 'read', checks: [check('/a')], agentRules: BUILD_AGENT, sessionRules })).toBe('allow');
  });

  it('lets a saved rule turn an ask into an allow, and nothing else', () => {
    const sessionRules = [{ action: 'shell', resource: '*', effect: 'ask' }];
    const saved = [{ action: 'shell', resource: 'echo *' }];
    expect(effectOf({ action: 'shell', checks: [check('echo hi')], agentRules: BUILD_AGENT, sessionRules, saved })).toBe('allow');
    expect(effectOf({ action: 'shell', checks: [check('ls')], agentRules: BUILD_AGENT, sessionRules, saved })).toBe('ask');
    const denied = [...sessionRules, { action: 'shell', resource: 'echo *', effect: 'deny' }];
    expect(effectOf({ action: 'shell', checks: [check('echo hi')], agentRules: BUILD_AGENT, sessionRules: denied, saved })).toBe('deny');
  });

  it('takes the strictest answer over several resources', () => {
    const agentRules = [{ action: 'shell', resource: 'git *', effect: 'allow' }, { action: 'shell', resource: 'curl *', effect: 'deny' }];
    expect(effectOf({ action: 'shell', checks: [check('git status'), check('git log')], agentRules })).toBe('allow');
    expect(effectOf({ action: 'shell', checks: [check('git status'), check('make')], agentRules })).toBe('ask');
    expect(effectOf({ action: 'shell', checks: [check('make'), check('curl x')], agentRules })).toBe('deny');
  });

  it('allows a strict resource only by a rule that is *, never by a narrower or a saved rule', () => {
    const line = check('echo $(rm x)', true);
    expect(effectOf({ action: 'shell', checks: [line], agentRules: [{ action: 'shell', resource: 'echo *', effect: 'allow' }] })).toBe('ask');
    expect(effectOf({ action: 'shell', checks: [line], agentRules: [], saved: [{ action: 'shell', resource: 'echo *' }] })).toBe('ask');
    expect(effectOf({ action: 'shell', checks: [line], agentRules: BUILD_AGENT })).toBe('allow');
  });

  it('treats an unknown effect as an ask', () => {
    expect(effectOf({ action: 'shell', checks: [check('ls')], agentRules: [{ action: '*', resource: '*', effect: 'maybe' }] })).toBe('ask');
  });
});

describe('splitting a command line', () => {
  it.each([
    ['ls', ['ls'], false],
    ['git status && git log | head', ['git status', 'git log', 'head'], false],
    ['a; b\nc || d & e', ['a', 'b', 'c', 'd', 'e'], false],
    ['echo "a; b" && echo \'c | d\'', ['echo "a; b"', "echo 'c | d'"], false],
    ['echo a\\; b', ['echo a\\; b'], false],
    ['make 2>&1 | tee log', ['make 2>&1', 'tee log'], false],
    ['cmd &> out', ['cmd &> out'], false],
    ['echo $(rm x)', ['echo $(rm x)'], true],
    ['echo `rm x`', ['echo `rm x`'], true],
    ['echo "$(rm x)"', ['echo "$(rm x)"'], true],
    ["echo '$(not run)'", ["echo '$(not run)'"], false],
    ['diff <(a) <(b)', ['diff <(a) <(b)'], true],
    ['echo "unterminated', ['echo "unterminated'], true],
  ])('%s', (command, segments, opaque) => {
    expect(splitShellCommand(command)).toEqual({ segments, opaque });
  });
});

describe('describing a tool call', () => {
  const directory = path.resolve('/work/project');
  const describe_ = (tool, input) => describeToolCall({ tool, input, directory });

  it('maps bash to shell with the command line and a program pattern to save', () => {
    expect(describe_('bash', { command: 'echo hi' })).toEqual({
      action: 'shell', resources: ['echo hi'], checks: [{ value: 'echo hi', strict: false }], save: ['echo *'],
    });
  });

  it('offers one pattern per command of a compound line, and none for a line it cannot take apart', () => {
    expect(describe_('bash', { command: 'git status && ls -la; git log' }).save).toEqual(['git *', 'ls *']);
    expect(describe_('bash', { command: 'git status && ls -la' }).checks.map((entry) => entry.value)).toEqual(['git status', 'ls -la']);
    const opaque = describe_('bash', { command: 'echo $(whoami)' });
    expect(opaque.save).toBeUndefined();
    expect(opaque.checks).toEqual([{ value: 'echo $(whoami)', strict: true }]);
  });

  it('offers no pattern for a program that runs other commands', () => {
    for (const command of ['bash -c "rm x"', 'sudo rm x', 'env FOO=1 make', 'xargs rm', 'git status && sh x.sh', 'FOO=1 make']) {
      expect(describe_('bash', { command }).save, command).toBeUndefined();
    }
    expect(describe_('bash', { command: './run.sh --fast' }).save).toEqual(['./run.sh *']);
  });

  it('maps file tools to an action on the absolute path', () => {
    expect(describe_('read', { path: 'src/a.ts' })).toMatchObject({ action: 'read', resources: [path.resolve('/work/project/src/a.ts')], save: [path.resolve('/work/project/src/a.ts')] });
    expect(describe_('read', { path: '/etc/hosts' }).resources).toEqual(['/etc/hosts']);
    expect(describe_('read', { path: '@src/a.ts' }).resources).toEqual([path.resolve('/work/project/src/a.ts')]);
    expect(describe_('ls', {})).toMatchObject({ action: 'read', resources: [directory] });
    expect(describe_('grep', { pattern: 'x', path: 'src' })).toMatchObject({ action: 'grep', resources: [path.resolve('/work/project/src')] });
    expect(describe_('find', { pattern: '*.ts' })).toMatchObject({ action: 'glob', resources: [directory] });
    expect(describe_('edit', { path: 'a.txt', edits: [] }).action).toBe('edit');
    expect(describe_('write', { path: 'a.txt', content: 'x' }).action).toBe('edit');
  });

  it('makes an extension or MCP tool its own action, with its arguments as metadata', () => {
    expect(describe_('mcp__github__create_issue', { title: 'x' })).toEqual({
      action: 'mcp__github__create_issue', resources: ['*'], checks: [{ value: '*' }], save: ['*'], metadata: { title: 'x' },
    });
    expect(describe_('question', {})).toEqual({ action: 'question', resources: ['*'], checks: [{ value: '*' }], save: ['*'] });
  });

  it('cuts long strings in the metadata', () => {
    const metadata = describe_('custom', { body: 'x'.repeat(5_000) }).metadata;
    expect(metadata.body.length).toBeLessThan(2_100);
    expect(metadata.body).toContain('3000 more characters');
  });
});

describe('deniedToolNames', () => {
  const deny = (action, resource = '*') => ({ action, resource, effect: 'deny' });

  it('names the Pi tools behind a denied action', () => {
    expect(deniedToolNames([deny('shell')]).sort()).toEqual(['bash', 'powershell']);
    expect(deniedToolNames([deny('read')]).sort()).toEqual(['ls', 'read']);
    expect(deniedToolNames([deny('glob'), deny('grep')]).sort()).toEqual(['find', 'grep']);
    expect(deniedToolNames([deny('edit')]).sort()).toEqual(['edit', 'write']);
  });

  it('takes any other action as its own tool name or pattern', () => {
    expect(deniedToolNames([deny('openchamber_web'), deny('mcp__radius__*'), deny('question')]).sort())
      .toEqual(['mcp__radius__*', 'openchamber_web', 'question']);
  });

  it('keeps a tool a narrower rule still allows, and one only some calls are denied', () => {
    expect(deniedToolNames([deny('shell'), { action: 'shell', resource: 'ls *', effect: 'allow' }])).toEqual([]);
    expect(deniedToolNames([deny('shell', 'rm *')])).toEqual([]);
    expect(deniedToolNames([{ action: 'read', resource: '*', effect: 'ask' }])).toEqual([]);
  });

  it('lets a later rule for the whole tool win, as the gate does', () => {
    expect(deniedToolNames([deny('shell'), { action: 'shell', resource: '*', effect: 'allow' }])).toEqual([]);
    expect(deniedToolNames([{ action: 'shell', resource: '*', effect: 'allow' }, deny('shell')]).sort()).toEqual(['bash', 'powershell']);
    expect(deniedToolNames([{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }]).sort())
      .toEqual(['bash', 'edit', 'find', 'grep', 'powershell', 'write']);
  });

  it('ignores v1 keys the gate never asks about, and entries that are not rules', () => {
    expect(deniedToolNames([deny('bash'), deny('write'), null, 'x', { action: 'shell' }])).toEqual([]);
    expect(deniedToolNames(undefined)).toEqual([]);
  });
});
