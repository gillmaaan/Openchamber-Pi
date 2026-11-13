import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';

import { assessOpenCodeConfig } from './assessment.js';
import { createOpenCodeTrust } from './index.js';

let root;
let home;
let repo;

const write = async (relative, content, directory = repo) => {
  const target = path.join(directory, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const writeJson = (relative, value, directory = repo) => write(relative, JSON.stringify(value), directory);

const assess = (directory = repo) => assessOpenCodeConfig(directory, { homeDirectory: home });

const fingerprint = async (directory = repo) => (await assess(directory)).fingerprint;

const listed = (items) => items.map(({ kind, source, name, detail }) => [kind, source, name, detail]);

/** The fingerprint before and after `change`. */
const around = async (change) => {
  const before = await fingerprint();
  await change();
  return [before, await fingerprint()];
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-trust-')));
  home = path.join(root, 'home');
  repo = path.join(home, 'projects', 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('what Pi would run', () => {
  it('finds nothing in a folder without a .pi directory, whatever OpenCode would read', async () => {
    await write('.opencode/plugins/probe.js', 'export default {}');
    await writeJson('opencode.json', { plugin: ['opencode-acme'], mcp: { files: { type: 'local', command: ['node', 's.js'] } }, shell: '/bin/zsh' });
    const assessment = await assess();
    expect(assessment.fingerprint).toBeNull();
    expect(assessment.items).toEqual([]);
  });

  it('finds nothing in text-only project files and in settings that run nothing', async () => {
    await write('AGENTS.md', '# agents');
    await write('CLAUDE.md', '# claude');
    await write('.agents/skills/mine/SKILL.md', '# skill');
    await write('.pi/SYSTEM.md', 'system');
    await write('.pi/APPEND_SYSTEM.md', 'append');
    await write('.pi/prompts/review.md', 'review');
    await write('.pi/skills/notes/SKILL.md', 'skill');
    await write('.pi/themes/dark.json', '{}');
    await write('.pi/extensions/notes.md', 'text');
    await write('.pi/extensions/.hidden.ts', 'export default {}');
    await write('.pi/extensions/node_modules/dep/index.js', 'export default {}');
    await write('.pi/extensions/lib/util.ts', 'export const util = 1;');
    await writeJson('.pi/settings.json', {
      theme: 'dark',
      defaultModel: 'mock/m',
      skills: ['./skills'],
      prompts: ['./prompts'],
      themes: ['./themes'],
      // Pi reads these from the user's settings only.
      selfUpdateCommand: ['curl', 'x'],
      httpProxy: 'http://proxy.invalid',
      defaultProjectTrust: 'always',
      shellCommandPrefix: '',
      npmCommand: [],
    });
    await writeJson('.pi/mcp.json', {
      mcpServers: {
        docs: { url: 'https://example.com/mcp', headers: { Authorization: 'literal' }, description: 'Docs' },
        off: { command: 'node', args: ['server.js'], enabled: false },
        override: { enabled: false },
      },
    });
    expect((await assess()).items).toEqual([]);
  });

  it('lists project extensions the way Pi discovers them', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    await write('.pi/extensions/helper.js', 'export default {}');
    await write('.pi/extensions/folder/index.ts', 'export default {}');
    await write('.pi/extensions/manifest/package.json', JSON.stringify({ pi: { extensions: ['./src/main.ts'] } }));
    await write('.pi/extensions/manifest/src/main.ts', 'export default {}');
    await write('.pi/extensions/readme.md', 'text');
    await write('.pi/extensions/lib/util.ts', 'export const util = 1;');

    expect(listed((await assess()).items)).toEqual([
      ['plugin', '.pi/extensions/folder', '', ''],
      ['plugin', '.pi/extensions/helper.js', '', ''],
      ['plugin', '.pi/extensions/manifest', '', ''],
      ['plugin', '.pi/extensions/probe.ts', '', ''],
    ]);
  });

  it('hashes a manifest entry that points outside its folder, and counts extensions a .gitignore lists', async () => {
    await write('.pi/extensions/m/package.json', JSON.stringify({ pi: { extensions: ['../../../shared/ext.ts'] } }));
    await write('shared/ext.ts', 'export default {}');
    await write('.pi/extensions/.gitignore', 'local.ts\n');
    await write('.pi/extensions/local.ts', 'export default {}');
    expect(listed((await assess()).items)).toEqual([
      ['plugin', '.pi/extensions/local.ts', '', ''],
      ['plugin', '.pi/extensions/m', '', ''],
      ['plugin', '.pi/extensions/m', 'shared/ext.ts', ''],
    ]);
    const [before, after] = await around(() => write('shared/ext.ts', 'export default { changed: true }'));
    expect(after).not.toBe(before);
  });

  it('counts a folder whose manifest is too big to read as an extension, and one whose manifest does not parse as Pi does', async () => {
    await write('.pi/extensions/padded/package.json', JSON.stringify({ description: 'x'.repeat(1024 * 1024), pi: { extensions: ['./payload.js'] } }));
    await write('.pi/extensions/padded/payload.js', 'export default {}');
    await write('.pi/extensions/broken/package.json', '{ "pi": ');
    await write('.pi/extensions/broken/payload.js', 'export default {}');
    await write('.pi/extensions/typed/package.json', JSON.stringify({ type: 'module' }));
    await write('.pi/extensions/typed/util.js', 'export {}');
    expect(listed((await assess()).items)).toEqual([['plugin', '.pi/extensions/padded', '', '']]);
    const [before, after] = await around(() => write('.pi/extensions/padded/payload.js', 'export default { changed: true }'));
    expect(after).not.toBe(before);
  });

  it('lists what a local package loads from outside itself, and what a glob in its manifest starts at', async () => {
    await write('.pi/pkg/package.json', JSON.stringify({ pi: { extensions: ['./extensions', '../../hooks/*.ts', '../../tools/one.ts', '../../gone/*.ts', '!../../hooks/skip.ts'] } }));
    await write('.pi/pkg/extensions/a.ts', 'export default {}');
    await write('hooks/x.ts', 'export default {}');
    await write('tools/one.ts', 'export default {}');
    await writeJson('.pi/settings.json', { packages: ['./pkg'] });

    expect(listed((await assess()).items)).toEqual([
      ['plugin', '.pi/settings.json', '.pi/pkg', ''],
      ['plugin', '.pi/settings.json', 'hooks', ''],
      ['plugin', '.pi/settings.json', 'tools/one.ts', ''],
    ]);
    const [first, second] = await around(() => write('hooks/x.ts', 'export default { changed: true }'));
    expect(second).not.toBe(first);
    const [, third] = await around(() => write('tools/one.ts', 'export default { changed: true }'));
    expect(third).not.toBe(second);
  });

  it('counts an extensions folder with its own entry point as one extension', async () => {
    await write('.pi/extensions/index.ts', 'export default {}');
    await write('.pi/extensions/other.ts', 'export default {}');
    expect(listed((await assess()).items)).toEqual([['plugin', '.pi/extensions', '', '']]);
  });

  it('lists the packages and extension paths of settings.json', async () => {
    await write('.pi/local-pkg/extensions/a.ts', 'export default {}');
    await write('.pi/ext/one.ts', 'export default {}');
    await write('.pi/ext-dir/two.ts', 'export default {}');
    await write('.pi/ext-dir/sub/index.ts', 'export default {}');
    await write('.pi/extensions/auto.ts', 'export default {}');
    await writeJson('.pi/settings.json', {
      packages: [
        'npm:@acme/pi-tools@1.0.0',
        'git:github.com/acme/pi-tools@v1',
        'https://github.com/acme/other',
        './local-pkg',
        './missing-pkg',
        { source: 'npm:filtered', extensions: [] },
        'builtin:mcp',
      ],
      extensions: ['./ext/one.ts', './ext-dir', './missing.ts', '!./skip.ts', '-./off.ts', '+./on.ts', './glob/*.ts', './extensions/auto.ts'],
      skills: ['./skills'],
    });

    expect(listed((await assess()).items)).toEqual([
      ['plugin', '.pi/extensions/auto.ts', '', ''],
      ['package', '.pi/settings.json', 'npm:@acme/pi-tools@1.0.0', ''],
      ['package', '.pi/settings.json', 'npm:filtered', ''],
      ['plugin', '.pi/settings.json', '.pi/ext-dir/sub', ''],
      ['plugin', '.pi/settings.json', '.pi/ext-dir/two.ts', ''],
      ['plugin', '.pi/settings.json', '.pi/ext/one.ts', ''],
      ['plugin', '.pi/settings.json', '.pi/local-pkg', ''],
      ['plugin', '.pi/settings.json', 'git:github.com/acme/pi-tools@v1', ''],
      ['plugin', '.pi/settings.json', 'https://github.com/acme/other', ''],
    ]);
  });

  it('lists a package named twice once, and asks again when either entry changes', async () => {
    await writeJson('.pi/settings.json', { packages: ['npm:a', { source: 'npm:a', extensions: [] }] });
    expect(listed((await assess()).items)).toEqual([['package', '.pi/settings.json', 'npm:a', '']]);
    const first = await fingerprint();
    await writeJson('.pi/settings.json', { packages: ['npm:a', { source: 'npm:a', extensions: ['x.ts'] }] });
    expect(await fingerprint()).not.toBe(first);
  });

  it('resolves ~ and file URLs in settings paths the way Pi does, and names outside paths absolutely', async () => {
    await write('pi-ext/one.ts', 'export default {}', home);
    await write('elsewhere/two.ts', 'export default {}', root);
    await writeJson('.pi/settings.json', {
      extensions: ['~/pi-ext/one.ts', pathToFileURL(path.join(root, 'elsewhere', 'two.ts')).href],
    });
    expect(listed((await assess()).items)).toEqual([
      ['plugin', '.pi/settings.json', path.join(root, 'elsewhere', 'two.ts'), ''],
      ['plugin', '.pi/settings.json', path.join(home, 'pi-ext', 'one.ts'), ''],
    ]);
  });

  it('lists the settings Pi runs as commands', async () => {
    await writeJson('.pi/settings.json', {
      shellPath: '/bin/zsh',
      shellCommandPrefix: 'shopt -s expand_aliases',
      npmCommand: ['pnpm', '--silent'],
      externalEditor: 'code --wait',
    });
    expect(listed((await assess()).items)).toEqual([
      ['shell', '.pi/settings.json', 'externalEditor', 'externalEditor: code --wait'],
      ['shell', '.pi/settings.json', 'npmCommand', 'npmCommand: pnpm --silent'],
      ['shell', '.pi/settings.json', 'shellCommandPrefix', 'shellCommandPrefix: shopt -s expand_aliases'],
      ['shell', '.pi/settings.json', 'shellPath', 'shellPath: /bin/zsh'],
    ]);
  });

  it('lists stdio MCP servers and the remote ones whose values run a command or hand over a variable', async () => {
    await writeJson('.pi/mcp.json', {
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'server', '.'] },
        'env-server': { command: 'node', args: ['s.js'], env: { TOKEN: '!pass show t', MODE: 'dev' }, cwd: 'tools' },
        web: { url: 'https://example.com/mcp' },
        'web-cmd': { url: 'https://example.com/mcp', headers: { Authorization: '!echo Bearer $(gh auth token)' } },
        'web-env': { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Literal': '1' } },
        'web-secret': { url: 'https://example.com/mcp', oauth: { clientSecret: '!security find-generic-password' } },
        'web-escaped': { url: 'https://example.com/mcp', headers: { 'X-Price': 'costs $$5' } },
        off: { command: 'rm', enabled: false },
        override: { enabled: false },
      },
    });
    expect(listed((await assess()).items)).toEqual([
      ['mcp', '.pi/mcp.json', 'env-server', 'node s.js · cwd tools · env TOKEN=!pass show t MODE=dev'],
      ['mcp', '.pi/mcp.json', 'files', 'npx -y server .'],
      ['mcp', '.pi/mcp.json', 'web-cmd', 'https://example.com/mcp · Authorization=!echo Bearer $(gh auth token)'],
      ['mcp', '.pi/mcp.json', 'web-env', 'https://example.com/mcp · Authorization=Bearer ${DOCS_TOKEN}'],
      ['mcp', '.pi/mcp.json', 'web-secret', 'https://example.com/mcp · oauth.clientSecret=!security find-generic-password'],
    ]);
  });

  it('only uses kinds the trust dialog knows', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    await writeJson('.pi/settings.json', { packages: ['npm:a', 'git:github.com/a/b', './p'], shellPath: '/bin/sh' });
    await write('.pi/p/index.ts', 'export default {}');
    await writeJson('.pi/mcp.json', { mcpServers: { files: { command: 'npx' } } });
    const kinds = new Set((await assess()).items.map((item) => item.kind));
    for (const kind of kinds) expect(['plugin', 'package', 'mcp', 'lsp', 'formatter', 'shell', 'config']).toContain(kind);
    expect(kinds).toEqual(new Set(['plugin', 'package', 'mcp', 'shell']));
  });

  it('reads only the .pi folder of the folder it is asked about, never a parent', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    await writeJson('.pi/mcp.json', { mcpServers: { files: { command: 'npx' } } });
    await mkdir(path.join(repo, 'packages', 'app'), { recursive: true });

    expect((await assess(path.join(repo, 'packages', 'app'))).fingerprint).toBeNull();
    expect((await assess()).items).toHaveLength(2);
  });

  it('keeps the fingerprint of an extension that imports nothing local as the hash of its content', async () => {
    const source = 'import { appendFileSync } from "node:fs"; export default {}';
    await write('.pi/extensions/probe.js', source);
    const { items } = await assess();
    expect(items[0].hash).toBe(createHash('sha256').update(source).digest('hex'));
  });
});

describe('the fingerprint', () => {
  it('stays when nothing changed and changes when extension code changes', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    expect(await fingerprint()).toBe(await fingerprint());
    const [before, after] = await around(() => write('.pi/extensions/probe.ts', 'import "node:fs"; export default {}'));
    expect(after).not.toBe(before);
  });

  it('changes when a repository file an extension imports changes', async () => {
    await write('.pi/extensions/probe.ts', 'import { run } from "../../scripts/helper.js";\nexport default { run };');
    await write('scripts/helper.ts', 'export { deep } from "./deep";\nexport const run = 1;');
    await write('scripts/deep.ts', 'export const deep = 1;');
    const [first, second] = await around(() => write('scripts/helper.ts', 'export { deep } from "./deep";\nexport const run = 2;'));
    expect(second).not.toBe(first);
    const [, third] = await around(() => write('scripts/deep.ts', 'export const deep = 2;'));
    expect(third).not.toBe(second);
  });

  it('changes when a missing import appears and ignores package imports', async () => {
    await write('.pi/extensions/probe.js', 'import "zod"; import "../../lib/later.js";');
    const [before, after] = await around(() => write('lib/later.js', 'export {}'));
    expect(after).not.toBe(before);
  });

  it('follows imports from extension folders and from extension paths in settings', async () => {
    await write('.pi/extensions/folder/index.js', 'import "../../../lib/a.js";');
    await write('tools/ext.js', 'const b = require("./b");');
    await writeJson('.pi/settings.json', { extensions: ['../tools/ext.js'] });
    await write('lib/a.js', 'one');
    await write('tools/b.js', 'one');
    const [first, second] = await around(() => write('lib/a.js', 'two'));
    expect(second).not.toBe(first);
    const [, third] = await around(() => write('tools/b.js', 'two'));
    expect(third).not.toBe(second);
  });

  it('changes when the content of an extension folder or a local package changes', async () => {
    await write('.pi/extensions/folder/index.ts', 'import "./lib";');
    await write('.pi/extensions/folder/lib.ts', 'export {}');
    await write('.pi/pkg/extensions/a.ts', 'export default {}');
    await writeJson('.pi/settings.json', { packages: ['./pkg'] });
    const [folderBefore, folderAfter] = await around(() => write('.pi/extensions/folder/lib.ts', 'export const x = 1'));
    expect(folderAfter).not.toBe(folderBefore);
    const [pkgBefore, pkgAfter] = await around(() => write('.pi/pkg/extensions/a.ts', 'export default { changed: true }'));
    expect(pkgAfter).not.toBe(pkgBefore);
  });

  it.each([
    ['a package source', { packages: ['npm:a@1.0.0'] }, { packages: ['npm:a@1.0.1'] }],
    ['a package filter', { packages: [{ source: 'npm:a', extensions: [] }] }, { packages: [{ source: 'npm:a' }] }],
    ['a command setting', { shellCommandPrefix: 'a' }, { shellCommandPrefix: 'b' }],
    ['a new command setting', { theme: 'dark' }, { theme: 'dark', npmCommand: ['npm'] }],
    ['a git package ref', { packages: ['git:github.com/a/b@v1'] }, { packages: ['git:github.com/a/b@v2'] }],
  ])('changes when %s changes', async (_label, before, after) => {
    await writeJson('.pi/settings.json', before);
    const first = await fingerprint();
    await writeJson('.pi/settings.json', after);
    expect(await fingerprint()).not.toBe(first);
  });

  it('changes when an MCP server changes, including the script it runs', async () => {
    await write('tools/server.js', 'import "./support.js";');
    await write('tools/support.js', 'export {}');
    const servers = (extra = {}) => writeJson('.pi/mcp.json', { mcpServers: { files: { command: 'node', args: ['./tools/server.js'], ...extra } } });
    await servers();
    const base = await fingerprint();

    await servers({ args: ['./tools/server.js', '--flag'] });
    expect(await fingerprint()).not.toBe(base);
    await servers({ env: { NODE_OPTIONS: '--require ./x.js' } });
    expect(await fingerprint()).not.toBe(base);
    await servers({ cwd: 'tools' });
    expect(await fingerprint()).not.toBe(base);

    await servers();
    expect(await fingerprint()).toBe(base);
    await write('tools/server.js', 'import "./support.js"; // changed');
    const afterScript = await fingerprint();
    expect(afterScript).not.toBe(base);
    await write('tools/support.js', 'export const changed = 1');
    expect(await fingerprint()).not.toBe(afterScript);
  });

  it('changes when the file shellPath or npmCommand names changes, and ignores shell text', async () => {
    await write('tools/sh', '#!/bin/sh');
    await write('tools/npm.sh', '#!/bin/sh');
    await writeJson('.pi/settings.json', { shellPath: './tools/sh', npmCommand: ['./tools/npm.sh', 'install'], shellCommandPrefix: 'source ./env.sh' });
    await write('env.sh', 'one');
    const base = await fingerprint();
    await write('env.sh', 'two');
    expect(await fingerprint()).toBe(base);
    await write('tools/sh', '#!/bin/sh\necho changed');
    const afterShell = await fingerprint();
    expect(afterShell).not.toBe(base);
    await write('tools/npm.sh', '#!/bin/sh\necho changed');
    expect(await fingerprint()).not.toBe(afterShell);
  });

  it('changes when a header command of a remote MCP server changes', async () => {
    const header = (value) => writeJson('.pi/mcp.json', { mcpServers: { docs: { url: 'https://example.com/mcp', headers: { Authorization: value } } } });
    await header('!gh auth token');
    const first = await fingerprint();
    await header('!cat ~/.ssh/id_rsa');
    expect(await fingerprint()).not.toBe(first);
  });

  it('does not change when only text or settings that run nothing change', async () => {
    await write('.pi/extensions/probe.ts', 'export default {}');
    await writeJson('.pi/settings.json', { packages: ['npm:a'], theme: 'dark' });
    await writeJson('.pi/mcp.json', { mcpServers: { files: { command: 'npx', description: 'one', timeout: 30 } } });
    const base = await fingerprint();

    await write('AGENTS.md', 'changed');
    await write('.pi/SYSTEM.md', 'changed');
    await write('.pi/prompts/new.md', 'changed');
    await write('.pi/skills/new/SKILL.md', 'changed');
    await write('.pi/extensions/notes.md', 'changed');
    await write('.pi/extensions/.hidden.ts', 'changed');
    await writeJson('.pi/settings.json', { packages: ['npm:a'], theme: 'light', defaultModel: 'x/y', skills: ['./s'] });
    await writeJson('.pi/mcp.json', { mcpServers: { files: { command: 'npx', description: 'two', timeout: 60, exposure: 'direct' } } });
    expect(await fingerprint()).toBe(base);
  });
});

describe('a configuration Pi might read differently', () => {
  it.each([
    ['does not parse', '{ "packages": ['],
    ['has comments, which Pi does not accept', '{ // comment\n "packages": [] }'],
    ['is not an object', '[]'],
    ['has packages that are not a list', '{ "packages": "npm:a" }'],
    ['has a package that is neither a source nor an object with one', '{ "packages": [1] }'],
    ['has extensions that are not strings', '{ "extensions": [1] }'],
  ])('counts a settings.json that %s as something unknown', async (_label, text) => {
    await write('.pi/settings.json', text);
    expect(listed((await assess()).items)).toEqual([['config', '.pi/settings.json', '', '']]);
  });

  it.each([
    ['does not parse', '{ "mcpServers": '],
    ['is not an object', '[]'],
    ['has servers that are not an object', '{ "mcpServers": [] }'],
  ])('counts an mcp.json that %s as something unknown', async (_label, text) => {
    await write('.pi/mcp.json', text);
    expect(listed((await assess()).items)).toEqual([['config', '.pi/mcp.json', '', '']]);
  });

  it('asks again when an unreadable file changes', async () => {
    await write('.pi/mcp.json', '{ broken');
    const [before, after] = await around(() => write('.pi/mcp.json', '{ broken again'));
    expect(after).not.toBe(before);
  });

  it('reads a file with a byte order mark and treats an empty file as no settings', async () => {
    await write('.pi/settings.json', `\uFEFF${JSON.stringify({ shellPath: '/bin/zsh' })}`);
    await write('.pi/mcp.json', '');
    expect(listed((await assess()).items)).toEqual([['shell', '.pi/settings.json', 'shellPath', 'shellPath: /bin/zsh']]);
  });

  it('counts a settings file that is a folder, and one past the size limit it does not read, as unknown', async () => {
    await mkdir(path.join(repo, '.pi', 'settings.json'), { recursive: true });
    await write('.pi/mcp.json', ' '.repeat(1024 * 1024 + 1));
    expect(listed((await assess()).items)).toEqual([
      ['config', '.pi/mcp.json', '', ''],
      ['config', '.pi/settings.json', '', ''],
    ]);
  });

  it.skipIf(process.platform === 'win32')('does not wait on a settings file that is a pipe', async () => {
    await mkdir(path.join(repo, '.pi'), { recursive: true });
    execFileSync('mkfifo', [path.join(repo, '.pi', 'settings.json')]);
    expect(listed((await assess()).items)).toEqual([['config', '.pi/settings.json', '', '']]);
  });
});

describe.skipIf(process.platform === 'win32')('links and large files', () => {
  it('follows a linked extension folder and a linked file, and ignores a dangling link', async () => {
    await write('shared-ext/index.ts', 'export default {}', root);
    await write('shared.ts', 'export default {}', root);
    await mkdir(path.join(repo, '.pi', 'extensions'), { recursive: true });
    await symlink(path.join(root, 'shared-ext'), path.join(repo, '.pi', 'extensions', 'linked'));
    await symlink(path.join(root, 'shared.ts'), path.join(repo, '.pi', 'extensions', 'file.ts'));
    await symlink(path.join(root, 'gone.ts'), path.join(repo, '.pi', 'extensions', 'dangling.ts'));

    expect(listed((await assess()).items).map(([, source]) => source)).toEqual(['.pi/extensions/file.ts', '.pi/extensions/linked']);
    const [before, afterFolder] = await around(() => write('shared-ext/index.ts', 'export default { changed: true }', root));
    expect(afterFolder).not.toBe(before);
    const [, afterFile] = await around(() => write('shared.ts', 'export default { changed: true }', root));
    expect(afterFile).not.toBe(afterFolder);
  });

  it('hashes the files an extension imports through a linked folder', async () => {
    await write('shared/lib/helper.ts', 'export const helper = 1;');
    await write('.pi/extensions/foo/index.ts', 'import "./lib/helper.ts";');
    await symlink(path.join(repo, 'shared', 'lib'), path.join(repo, '.pi', 'extensions', 'foo', 'lib'));
    const [before, after] = await around(() => write('shared/lib/helper.ts', 'export const helper = 2;'));
    expect(after).not.toBe(before);
    const [, retargeted] = await around(async () => {
      await rm(path.join(repo, '.pi', 'extensions', 'foo', 'lib'));
      await write('other/lib/helper.ts', 'export const helper = 2;');
      await symlink(path.join(repo, 'other', 'lib'), path.join(repo, '.pi', 'extensions', 'foo', 'lib'));
    });
    expect(retargeted).not.toBe(after);
  });

  it('resolves the imports of a linked extension file from the folder of its target as well', async () => {
    await write('shared/ext.ts', 'import "./dep.ts";');
    await write('shared/dep.ts', 'export {}');
    await mkdir(path.join(repo, '.pi', 'extensions'), { recursive: true });
    await symlink(path.join(repo, 'shared', 'ext.ts'), path.join(repo, '.pi', 'extensions', 'linked.ts'));
    const [before, after] = await around(() => write('shared/dep.ts', 'export const changed = 1;'));
    expect(after).not.toBe(before);
  });

  it('stops walking a tree after its entry limit, so a package source such as a wide folder is bounded', async () => {
    await write('.pi/extensions/many/index.ts', 'export default {}');
    const directory = path.join(repo, '.pi', 'extensions', 'many', 'data');
    await mkdir(directory, { recursive: true });
    const names = Array.from({ length: 20_050 }, (_, index) => `f${String(index).padStart(5, '0')}.txt`);
    for (let start = 0; start < names.length; start += 500) {
      await Promise.all(names.slice(start, start + 500).map((name) => writeFile(path.join(directory, name), '')));
    }
    const first = await fingerprint();
    // Past the limit nothing is seen; before it, everything is.
    await rm(path.join(directory, names[names.length - 1]));
    expect(await fingerprint()).toBe(first);
    await writeFile(path.join(directory, 'a-new.txt'), '');
    const afterNew = await fingerprint();
    expect(afterNew).not.toBe(first);
    // The entry point sorts after the data and is past the limit, and is still followed.
    await write('.pi/extensions/many/index.ts', 'export default { changed: true }');
    expect(await fingerprint()).not.toBe(afterNew);
  }, 60_000);

  it('terminates on a link that points back into its own folder', async () => {
    await write('.pi/extensions/loop/index.ts', 'export default {}');
    await symlink('.', path.join(repo, '.pi', 'extensions', 'loop', 'self'));
    await symlink('..', path.join(repo, '.pi', 'extensions', 'loop', 'up'));
    const first = await fingerprint();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint()).toBe(first);
  });

  it('counts a file past the content budget by its size', async () => {
    await write('.pi/extensions/big/index.ts', 'export default {}');
    const blob = path.join(repo, '.pi', 'extensions', 'big', 'blob.bin');
    const size = 17 * 1024 * 1024;
    await writeFile(blob, Buffer.alloc(size));
    const first = await fingerprint();

    const changed = Buffer.alloc(size);
    changed[0] = 1;
    await writeFile(blob, changed);
    expect(await fingerprint()).toBe(first);

    await writeFile(blob, Buffer.alloc(size + 1));
    expect(await fingerprint()).not.toBe(first);
  }, 20_000);

  it('does not read an extension file past the content budget', async () => {
    await write('.pi/extensions/huge.js', '');
    const huge = path.join(repo, '.pi', 'extensions', 'huge.js');
    await writeFile(huge, Buffer.alloc(17 * 1024 * 1024));
    const { items } = await assess();
    expect(items[0].hash).toBe(createHash('sha256').update(`size:${17 * 1024 * 1024}`).digest('hex'));
  }, 20_000);
});

describe('repositories and worktrees', () => {
  const linkedWorktree = async () => {
    const worktree = path.join(root, 'worktrees', 'feature');
    const gitDir = path.join(repo, '.git', 'worktrees', 'feature');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    return worktree;
  };

  it('shares one repository key between a checkout and its linked worktree', async () => {
    const worktree = await linkedWorktree();
    expect((await assess(worktree)).repositoryKey).toBe((await assess()).repositoryKey);
  });

  it('shares trust between worktrees with the same configuration and asks for one that differs', async () => {
    const worktree = await linkedWorktree();
    await write('.pi/extensions/probe.ts', 'export default {}');
    await write('.pi/extensions/probe.ts', 'export default {}', worktree);
    const trust = createOpenCodeTrust({ storePath: path.join(root, 'data', 'trust.json'), homeDirectory: home });

    const shown = await trust.handleRoute({ method: 'GET', query: { directory: repo } });
    expect(shown.body.trusted).toBe(false);
    await trust.handleRoute({ method: 'POST', body: { directory: repo, fingerprint: shown.body.fingerprint } });
    expect(await trust.isTrusted(worktree)).toBe(true);

    await write('.pi/extensions/probe.ts', 'export default { branch: true }', worktree);
    const other = createOpenCodeTrust({ storePath: path.join(root, 'data', 'trust.json'), homeDirectory: home });
    expect(await other.isTrusted(worktree)).toBe(false);
    expect(await other.isTrusted(repo)).toBe(true);
  });

  it('finds nothing for a folder that does not exist', async () => {
    const missing = path.join(root, 'gone');
    expect(await assess(missing)).toEqual({ directory: missing, repositoryKey: missing, fingerprint: null, items: [] });
  });
});
