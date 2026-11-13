import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  maskCredentials,
  installedPathFor,
  isExactVersion,
  normalizePackageSource,
  parseConfiguredSource,
  parseGitSource,
  resolveLocalSource,
  sourceIdentity,
} from './packages-sources.js';

const HOME = '/home/dev';
const normalize = (input, cwd = '/work/project') => normalizePackageSource(input, { cwd, homedir: HOME });

describe('normalizePackageSource', () => {
  it('passes npm sources through and prefixes a bare package spec', () => {
    expect(normalize('npm:@scope/pkg@1.2.3')).toEqual({ source: 'npm:@scope/pkg@1.2.3', kind: 'npm' });
    expect(normalize('npm:pi-tools')).toEqual({ source: 'npm:pi-tools', kind: 'npm' });
    expect(normalize('  pi-tools@^1.0.0 ')).toEqual({ source: 'npm:pi-tools@^1.0.0', kind: 'npm' });
    expect(normalize('@scope/pkg@next')).toEqual({ source: 'npm:@scope/pkg@next', kind: 'npm' });
  });

  it('accepts git and https sources and rewrites hosted shorthands', () => {
    expect(normalize('git:github.com/user/repo@v1')).toEqual({ source: 'git:github.com/user/repo@v1', kind: 'git' });
    expect(normalize('git:git@github.com:user/repo')).toEqual({ source: 'git:git@github.com:user/repo', kind: 'git' });
    expect(normalize('https://github.com/user/repo')).toEqual({ source: 'https://github.com/user/repo', kind: 'git' });
    expect(normalize('https://example.test/team/repo.git@main')).toEqual({ source: 'https://example.test/team/repo.git@main', kind: 'git' });
    expect(normalize('ssh://git@example.test/team/repo')).toEqual({ source: 'ssh://git@example.test/team/repo', kind: 'git' });
    expect(normalize('github:user/repo#v2')).toEqual({ source: 'git:github.com/user/repo@v2', kind: 'git' });
    expect(normalize('gitlab:group/project')).toEqual({ source: 'git:gitlab.com/group/project', kind: 'git' });
  });

  it('makes a local path absolute, because pi remove and update read a relative one against their own folder', () => {
    expect(normalize('./pkg')).toEqual({ source: '/work/project/pkg', kind: 'local' });
    expect(normalize('../shared/pkg')).toEqual({ source: '/work/shared/pkg', kind: 'local' });
    expect(normalize('/opt/pkg')).toEqual({ source: '/opt/pkg', kind: 'local' });
    expect(normalize('~/pi/pkg')).toEqual({ source: '/home/dev/pi/pkg', kind: 'local' });
    expect(normalize('file:///opt/my%20pkg')).toEqual({ source: '/opt/my pkg', kind: 'local' });
    expect(normalize('./with space')).toEqual({ source: '/work/project/with space', kind: 'local' });
    expect(() => normalize('./pkg', null)).toThrow(/absolute path/);
    expect(normalize('/opt/pkg', null).source).toBe('/opt/pkg');
  });

  it('refuses everything else with a reason', () => {
    const refused = (input, pattern) => {
      let error;
      try {
        normalize(input);
      } catch (caught) {
        error = caught;
      }
      expect(error, `"${input}" should be refused`).toBeDefined();
      expect(['INVALID_SPEC', 'UNLOADABLE_SPEC']).toContain(error.code);
      if (pattern) expect(error.message).toMatch(pattern);
    };
    refused('', /non-empty/);
    refused('   ');
    refused('--approve');
    refused('-l');
    refused('owner/repo', /npm packages/);
    refused('two words');
    refused('npm:');
    refused('npm:bad name');
    refused('npm:@scope');
    refused('http://example.test/user/repo', /unencrypted/);
    refused('git://example.test/user/repo', /unencrypted/);
    refused('git:http://example.test/user/repo', /unencrypted/);
    refused('https://token@example.test/user/repo', /credentials/);
    refused('https://user:secret@example.test/user/repo', /credentials/);
    refused('ssh://user:secret@example.test/user/repo', /credentials/);
    refused('git:github.com', /git source/);
    refused('git:github.com/justone', /git source/);
    refused('git:github.com/user/repo@bad ref');
    refused('git:github.com/user/../etc');
    refused('ftp://example.test/pkg');
    refused('pkg\nnpm:evil');
    refused('pkg\u0000');
    refused(`npm:${'a'.repeat(250)}`);
    refused(null);
    refused(42);
  });

  it('refuses a credential however it is spelled, and an option dressed as a name, host or ref', () => {
    const refused = (input) => {
      expect(() => normalize(input), input).toThrow();
    };
    refused('git:user:SECRETTOKEN@github.com/u/r');
    refused('git:tok@github.com/u/r');
    refused('git:https://user:SECRETTOKEN@github.com/u/r');
    refused('https://github.com/u/r?access_token=SECRET');
    refused('git:github.com/u/r?token=SECRET');
    refused('https://github.com/u/r#--pathspec-from-file=/etc/hosts');
    refused('github:u/r#--detach');
    refused('git:github.com/u/r@--upload-pack=evil');
    refused('npm:--force');
    refused('npm:-g');
    refused('--force');
    refused('@scope/-x');
    refused('npm:@-scope/x');
    refused('git:git@-oProxyCommand=evil:u/r');
    refused('git:-oProxyCommand=evil.example/u/r');
    refused('ssh://-oProxyCommand=evil/u/r');
    expect(normalize('npm:~tilde-pkg').kind).toBe('npm');
    expect(normalize('github:u/r#v1.2').source).toBe('git:github.com/u/r@v1.2');
  });

  it('does not repeat a credential in any message it refuses with', () => {
    for (const input of ['git:user:SECRETTOKEN@github.com/u/r', 'http://user:SECRETTOKEN@example.test/u/r', 'user:SECRETTOKEN@example.test/u/r bad', 'npm:user:SECRETTOKEN@example.test']) {
      let message = '';
      try {
        normalize(input);
      } catch (error) {
        message = error.message;
      }
      expect(message, input).not.toBe('');
      expect(message, input).not.toContain('SECRETTOKEN');
    }
  });

  it('does not repeat a credential in the message it refuses with', () => {
    let message = '';
    try {
      normalize('https://user:hunter2@example.test/user/repo');
    } catch (error) {
      message = error.message;
    }
    expect(message).not.toContain('hunter2');
  });
});

describe('parseConfiguredSource', () => {
  it('reads each source form as Pi writes it in settings.json', () => {
    expect(parseConfiguredSource('npm:@scope/pkg@^1.0')).toEqual({ kind: 'npm', name: '@scope/pkg', version: '^1.0', spec: '@scope/pkg@^1.0' });
    expect(parseConfiguredSource('npm:pkg')).toMatchObject({ kind: 'npm', name: 'pkg', version: null });
    expect(parseConfiguredSource('git:github.com/user/repo@v1')).toEqual({ kind: 'git', host: 'github.com', path: 'user/repo', ref: 'v1', repoName: 'repo' });
    expect(parseConfiguredSource('https://github.com/user/repo.git')).toMatchObject({ kind: 'git', host: 'github.com', path: 'user/repo', ref: null });
    expect(parseConfiguredSource('git:git@github.com:user/repo@main')).toMatchObject({ kind: 'git', host: 'github.com', path: 'user/repo', ref: 'main' });
    expect(parseConfiguredSource('git://example.test/user/repo')).toMatchObject({ kind: 'git', host: 'example.test', path: 'user/repo' });
    expect(parseConfiguredSource('../pkg')).toEqual({ kind: 'local', path: '../pkg' });
    expect(parseConfiguredSource('/abs/pkg')).toEqual({ kind: 'local', path: '/abs/pkg' });
  });

  it('calls a source it cannot place unknown instead of guessing', () => {
    expect(parseConfiguredSource('npm:')).toEqual({ kind: 'unknown' });
    expect(parseConfiguredSource('git:nonsense')).toEqual({ kind: 'unknown' });
    expect(parseConfiguredSource('github:user/repo')).toEqual({ kind: 'unknown' });
    expect(parseConfiguredSource('builtin:mcp')).toEqual({ kind: 'unknown' });
  });

  it('reads a git source the way Pi names its clone: host in lower case, no trailing slash, #ref as the ref', () => {
    expect(parseConfiguredSource('https://GitHub.com/U/r/')).toMatchObject({ host: 'github.com', path: 'U/r' });
    expect(parseConfiguredSource('git:github.com/u/r#v1')).toMatchObject({ host: 'github.com', path: 'u/r', ref: 'v1' });
    expect(parseConfiguredSource('https://github.com/u/r.git?x=1')).toMatchObject({ path: 'u/r', ref: null });
    expect(sourceIdentity('https://github.com/u/r/', '/b', HOME)).toBe(sourceIdentity('git:github.com/u/r', '/b', HOME));
    expect(parseConfiguredSource('git:user:tok@github.com/u/r')).toEqual({ kind: 'unknown' });
    expect(parseConfiguredSource('git:git@-evil:u/r')).toEqual({ kind: 'unknown' });
  });

  it('keeps unsafe git paths out of the clone location', () => {
    expect(parseGitSource('github.com/user/../../etc')).toBeNull();
    expect(parseGitSource('github.com/user')).toBeNull();
    expect(parseGitSource('localhost/user/repo')).toMatchObject({ host: 'localhost', path: 'user/repo' });
    expect(parseGitSource('nodot/user/repo')).toBeNull();
  });
});

describe('where Pi keeps a package', () => {
  it('resolves npm, git and local sources against the settings folder', () => {
    const agent = '/home/dev/.pi/agent';
    expect(installedPathFor('npm:@scope/pkg@1.0.0', agent, HOME)).toBe(path.join(agent, 'npm', 'node_modules', '@scope', 'pkg'));
    expect(installedPathFor('git:github.com/user/repo@v1', agent, HOME)).toBe(path.join(agent, 'git', 'github.com', 'user', 'repo'));
    expect(installedPathFor('../../pkg', '/work/project/.pi', HOME)).toBe('/work/pkg');
    expect(installedPathFor('~/pkg', agent, HOME)).toBe('/home/dev/pkg');
    expect(installedPathFor('npm:', agent, HOME)).toBeNull();
    expect(resolveLocalSource('./x', '/base', HOME)).toBe('/base/x');
  });

  it('names one package the same way whatever its version or spelling', () => {
    const base = '/home/dev/.pi/agent';
    expect(sourceIdentity('npm:pkg@1.0.0', base, HOME)).toBe(sourceIdentity('npm:pkg@2.0.0', base, HOME));
    expect(sourceIdentity('npm:pkg', base, HOME)).not.toBe(sourceIdentity('npm:other', base, HOME));
    expect(sourceIdentity('git:github.com/user/repo@v1', base, HOME)).toBe(sourceIdentity('https://github.com/user/repo.git', base, HOME));
    expect(sourceIdentity('../pkg', base, HOME)).toBe(sourceIdentity('/home/dev/.pi/pkg', base, HOME));
    expect(sourceIdentity('../pkg', base, HOME)).not.toBe(sourceIdentity('../pkg', '/work/project/.pi', HOME));
  });
});

describe('versions', () => {
  it('orders versions the way semver does', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('v1.0.0+build', '1.0.0')).toBe(0);
    expect(compareVersions('latest', '1.0.0')).toBeNull();
  });

  it('tells an exact pin from a tag or a range', () => {
    expect(['1.2.3', '1.0.0-beta.1', '1.0.0+sha'].every(isExactVersion)).toBe(true);
    expect(['^1.2.3', '1.x', 'latest', '', null, undefined, '>=1 <2'].some(isExactVersion)).toBe(false);
  });
});

describe('maskCredentials', () => {
  it('masks URL userinfo and the user:token@host shorthand, and leaves other text alone', () => {
    expect(maskCredentials('clone https://user:tok@example.test/u/r and ssh://git@host/x')).toBe('clone https://***@example.test/u/r and ssh://***@host/x');
    expect(maskCredentials('git:user:SECRET@github.com/u/r')).toBe('git:***@github.com/u/r');
    expect(maskCredentials('git@github.com:u/r npm:foo@1.2.3 @scope/pkg@next a@b.c:80')).toBe('git@github.com:u/r npm:foo@1.2.3 @scope/pkg@next a@b.c:80');
  });
});
