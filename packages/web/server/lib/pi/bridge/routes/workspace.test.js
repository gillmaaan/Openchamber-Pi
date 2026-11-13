// Contract tests of the workspace routes that need no Pi process: file search,
// attachment writes, file watches, the repository views, init, the location and
// debug routes. Everything runs through `createBridgeHttpServer` on a loopback
// port, over real folders, real git repositories and real file watchers. The
// shell commands, which run on Pi, are in workspace-shells.test.js.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sessionNotFound } from '../errors.js';
import { createBridgeHttpServer } from '../http.js';
import { loadWorkspaceSchemas } from './test-support/workspace-schema.js';
import { createWorkspace } from './workspace.js';

const PASSWORD = 'correct horse';
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

let root;
let schemas;
const stops = [];

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-workspace-')));
  schemas = await loadWorkspaceSchemas();
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
const folder = (name = 'dir') => {
  counter += 1;
  const directory = path.join(root, `${name}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();

const put = (file, text = 'x\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A bridge with just the workspace routes. `sessions` are the records `requireSession` knows. */
const start = async ({ directory = folder('default'), sessions = {}, ...deps } = {}) => {
  const events = [];
  const logs = [];
  const tmpDir = folder('tmp');
  const workspace = createWorkspace({
    getDefaultDirectory: () => directory,
    requireSession: async (id) => {
      if (!sessions[id]) throw sessionNotFound(id);
      return sessions[id];
    },
    emit: (type, data, location, options) => events.push({ type, data, directory: location, options }),
    host: { on: () => () => {}, get: () => null },
    tmpDir,
    log: (message) => logs.push(message),
    ...deps,
  });
  const server = createBridgeHttpServer({ password: PASSWORD, routes: workspace.routes });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  stops.push(async () => {
    workspace.close();
    await server.close();
  });

  const call = async (method, route, { dir = directory, body, raw, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: AUTHORIZATION,
        ...(dir ? { 'x-opencode-directory': encodeURIComponent(dir) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : raw,
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  return { call, events, logs, tmpDir, directory, base, workspace };
};

describe('GET /api/fs/find', () => {
  it('lists what git knows and would add, ranked, and leaves ignored files out', async () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    put(path.join(repository, '.gitignore'), 'node_modules\n*.log\n');
    put(path.join(repository, 'src', 'app.ts'));
    put(path.join(repository, 'src', 'deep', 'app.test.ts'));
    put(path.join(repository, 'docs', 'guide.md'));
    put(path.join(repository, 'node_modules', 'pkg', 'app.js'));
    put(path.join(repository, 'debug.log'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    put(path.join(repository, 'untracked app notes.txt'));
    put(path.join(repository, 'ünï', 'çode.ts'));
    const { call } = await start({ directory: repository });

    const answer = await call('GET', '/api/fs/find?query=app');
    expect(answer.status).toBe(200);
    expect(answer.body.location).toEqual({ directory: repository });
    const paths = answer.body.data.map((entry) => entry.path);
    expect(paths[0]).toBe('src/app.ts');
    expect(paths).toContain('src/deep/app.test.ts');
    expect(paths).toContain('untracked app notes.txt');
    expect(paths).not.toContain('node_modules/pkg/app.js');
    expect(paths.some((entry) => entry.includes('debug.log'))).toBe(false);
    expect(() => schemas.entries(answer.body.data)).not.toThrow();

    const directories = await call('GET', '/api/fs/find?query=src&type=directory');
    expect(directories.body.data).toEqual([{ path: 'src/', type: 'directory' }, { path: 'src/deep/', type: 'directory' }]);

    const files = await call('GET', '/api/fs/find?query=src&type=file');
    expect(files.body.data.every((entry) => entry.type === 'file')).toBe(true);

    const unicode = await call('GET', `/api/fs/find?query=${encodeURIComponent('çode')}`);
    expect(unicode.body.data.map((entry) => entry.path)).toContain('ünï/çode.ts');
    const spaced = await call('GET', '/api/fs/find?query=app%20notes');
    expect(spaced.body.data.map((entry) => entry.path)).toContain('untracked app notes.txt');
  });

  it('matches fuzzily and bounds the answer', async () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    for (let index = 0; index < 1100; index += 1) put(path.join(repository, 'many', `file-${index}.txt`), '');
    put(path.join(repository, 'src', 'components', 'ChatInput.tsx'));
    const { call } = await start({ directory: repository });

    const fuzzy = await call('GET', '/api/fs/find?query=chtinp');
    expect(fuzzy.body.data.map((entry) => entry.path)).toContain('src/components/ChatInput.tsx');

    expect((await call('GET', '/api/fs/find?query=file')).body.data).toHaveLength(50);
    expect((await call('GET', '/api/fs/find?query=file&limit=7')).body.data).toHaveLength(7);
    expect((await call('GET', '/api/fs/find?query=file&limit=100000')).body.data).toHaveLength(1000);
    expect((await call('GET', '/api/fs/find?query=')).body.data.length).toBeGreaterThan(0);
  });

  it('never leaves the folder: a query is not a path, siblings and symlinks stay out', async () => {
    const parent = folder('parent');
    const project = path.join(parent, 'project');
    put(path.join(project, 'inside.txt'));
    put(path.join(parent, 'secret.txt'));
    const outside = folder('outside');
    put(path.join(outside, 'leaked.txt'));
    fs.symlinkSync(outside, path.join(project, 'link-to-outside'));
    fs.symlinkSync(path.join(parent, 'secret.txt'), path.join(project, 'link-to-secret.txt'));
    git(project, 'init', '-q', '-b', 'main');
    const { call } = await start({ directory: project });

    for (const query of ['../secret', '../../', '/etc/passwd', 'secret', 'leaked']) {
      const answer = await call('GET', `/api/fs/find?query=${encodeURIComponent(query)}`);
      expect(answer.status).toBe(200);
      const paths = answer.body.data.map((entry) => entry.path);
      expect(paths.filter((entry) => entry.includes('leaked'))).toEqual([]);
      expect(paths.every((entry) => !path.isAbsolute(entry) && !entry.startsWith('..'))).toBe(true);
    }
  });

  it('answers a folder that is not a repository from ripgrep (.gitignore applies), and from a bounded walk without it', async () => {
    const plain = folder('plain');
    put(path.join(plain, '.gitignore'), 'build/\n');
    put(path.join(plain, 'src', 'main.js'));
    put(path.join(plain, 'build', 'main.js'));
    put(path.join(plain, 'node_modules', 'dep', 'main.js'));
    const outside = folder('outside');
    put(path.join(outside, 'main-outside.js'));
    fs.symlinkSync(outside, path.join(plain, 'src', 'link'));

    const withRipgrep = await start({ directory: plain });
    const viaRipgrep = (await withRipgrep.call('GET', '/api/fs/find?query=main&type=file')).body.data.map((entry) => entry.path);
    expect(viaRipgrep).toContain('src/main.js');
    expect(viaRipgrep).not.toContain('build/main.js');
    expect(viaRipgrep.some((entry) => entry.includes('outside'))).toBe(false);

    const withoutRipgrep = await start({ directory: plain, resolveRipgrep: async () => null });
    const viaWalk = (await withoutRipgrep.call('GET', '/api/fs/find?query=main&type=file')).body.data.map((entry) => entry.path);
    expect(viaWalk).toContain('src/main.js');
    expect(viaWalk).toContain('build/main.js');
    expect(viaWalk.some((entry) => entry.includes('node_modules'))).toBe(false);
    expect(viaWalk.some((entry) => entry.includes('outside'))).toBe(false);
  });

  it('falls back when git cannot list, and drops a tracked file the disk no longer has', async () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    put(path.join(repository, 'kept.txt'));
    put(path.join(repository, 'removed.txt'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    fs.rmSync(path.join(repository, 'removed.txt'));
    const working = await start({ directory: repository });
    expect((await working.call('GET', '/api/fs/find?query=txt')).body.data.map((entry) => entry.path)).toEqual(['kept.txt']);

    const broken = await start({ directory: repository, runGit: async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); } });
    const answer = await broken.call('GET', '/api/fs/find?query=kept');
    expect(answer.body.data.map((entry) => entry.path)).toEqual(['kept.txt']);
    expect(broken.logs.some((message) => message.includes('git could not list'))).toBe(true);
  });

  it('rejects a bad query with the tagged errors OpenCode answers, and a missing folder with LocationNotFoundError', async () => {
    const { call, directory } = await start();
    expect((await call('GET', '/api/fs/find')).body).toEqual({ _tag: 'InvalidRequestError', message: 'Missing key\n  at ["query"]', kind: 'Query' });
    expect((await call('GET', '/api/fs/find?query=a&limit=0')).body.message).toBe('Expected a value greater than 0\n  at ["limit"]');
    expect((await call('GET', '/api/fs/find?query=a&limit=')).status).toBe(400);
    expect((await call('GET', '/api/fs/find?query=a&limit=abc')).body.message).toBe('Expected an integer\n  at ["limit"]');
    expect((await call('GET', '/api/fs/find?query=a&limit=1.5')).status).toBe(400);
    expect((await call('GET', '/api/fs/find?query=a&type=x')).body.message).toBe('Expected "file" | "directory"\n  at ["type"]');

    const missing = path.join(directory, 'gone');
    const answer = await call('GET', '/api/fs/find?query=a', { dir: missing });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ _tag: 'LocationNotFoundError', location: { directory: missing } });
  });
});

describe('POST /api/experimental/fs/write', () => {
  const write = (ctx, file, bytes, headers = {}) => ctx.call('POST', `/api/experimental/fs/write?path=${encodeURIComponent(file)}`, { raw: bytes, headers: { 'content-type': 'application/octet-stream', ...headers } });

  it('writes the bytes under <tmp>/openchamber, binary included, and answers the path', async () => {
    const ctx = await start();
    const file = path.join(ctx.tmpDir, 'openchamber', 'abc123', 'photo.png');
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);
    const answer = await write(ctx, file, bytes);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ location: { directory: ctx.directory }, data: { path: file } });
    expect(() => schemas.written(answer.body.data)).not.toThrow();
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    // The same name again replaces the file; an empty body is an empty file.
    await write(ctx, file, Buffer.from('second'));
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
    expect((await write(ctx, path.join(path.dirname(file), 'empty.txt'), Buffer.alloc(0))).status).toBe(200);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['empty.txt', 'photo.png']);
  });

  it('refuses every path outside the temp area and writes nothing', async () => {
    const ctx = await start();
    const outside = path.join(ctx.directory, 'evil.txt');
    const inRoot = path.join(ctx.tmpDir, 'openchamber');
    const cases = [
      outside,
      path.join(ctx.tmpDir, 'plain.txt'),
      path.join(inRoot, '..', 'escape.txt'),
      `${inRoot}/x/../../escape.txt`,
      inRoot,
      'relative/file.txt',
    ];
    for (const target of cases) {
      const answer = await write(ctx, target, Buffer.from('x'));
      expect(answer.status, target).toBe(400);
      expect(answer.body._tag).toBe('InvalidRequestError');
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(ctx.tmpDir, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.tmpDir, 'plain.txt'))).toBe(false);

    const missing = await ctx.call('POST', '/api/experimental/fs/write', { raw: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } });
    expect(missing.body.message).toBe('Missing key\n  at ["path"]');
  });

  it('does not follow a link planted inside the area, and replaces a link at the target', async () => {
    const ctx = await start();
    const inRoot = path.join(ctx.tmpDir, 'openchamber');
    fs.mkdirSync(inRoot, { recursive: true, mode: 0o700 });
    const outside = folder('outside');
    put(path.join(outside, 'precious.txt'), 'keep');
    fs.symlinkSync(outside, path.join(inRoot, 'linked-folder'));
    const refused = await write(ctx, path.join(inRoot, 'linked-folder', 'new.txt'), Buffer.from('x'));
    expect(refused.status).toBe(400);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);

    fs.mkdirSync(path.join(inRoot, 'abc'));
    fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(inRoot, 'abc', 'file.txt'));
    const replaced = await write(ctx, path.join(inRoot, 'abc', 'file.txt'), Buffer.from('mine'));
    expect(replaced.status).toBe(200);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(path.join(inRoot, 'abc', 'file.txt')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(inRoot, 'abc', 'file.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a temp area that is a link, a folder in its place, and an oversized body, leaving nothing behind', async () => {
    const linked = await start();
    const target = folder('elsewhere');
    fs.symlinkSync(target, path.join(linked.tmpDir, 'openchamber'));
    const throughLink = await write(linked, path.join(linked.tmpDir, 'openchamber', 'a', 'f.txt'), Buffer.from('x'));
    expect(throughLink.status).toBe(503);
    expect(fs.readdirSync(target)).toEqual([]);

    const small = await start({ maxWriteBytes: 100 });
    const dir = path.join(small.tmpDir, 'openchamber', 'big');
    const tooBig = await write(small, path.join(dir, 'f.bin'), Buffer.alloc(5000, 1));
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.message).toContain('larger than 100 bytes');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect((await write(small, path.join(dir, 'ok.bin'), Buffer.alloc(100, 1))).status).toBe(200);

    fs.mkdirSync(path.join(dir, 'a-folder'));
    expect((await write(small, path.join(dir, 'a-folder'), Buffer.from('x'))).status).toBe(400);
    expect(fs.readdirSync(dir).sort()).toEqual(['a-folder', 'ok.bin']);
  });

  it('answers LocationNotFoundError for a missing folder', async () => {
    const ctx = await start();
    const answer = await ctx.call('POST', `/api/experimental/fs/write?path=${encodeURIComponent(path.join(ctx.tmpDir, 'openchamber', 'x'))}`, { dir: path.join(ctx.directory, 'gone'), raw: Buffer.from('x') });
    expect(answer.status).toBe(404);
    expect(answer.body._tag).toBe('LocationNotFoundError');
  });
});

describe('file watches', () => {
  const changes = (events) => events.filter((event) => event.type === 'filesystem.changed');
  const watch = (ctx, filePath, dir) => ctx.call('POST', '/api/experimental/fs/watch', { body: { path: filePath }, dir });
  const options = { debounceMs: 40 };

  it('reports a change once per burst, then a removal and the file coming back', async () => {
    const directory = folder('watched');
    const file = path.join(directory, 'notes.md');
    put(file, 'one\n');
    const ctx = await start({ directory, watchOptions: options });
    expect((await watch(ctx, 'notes.md')).status).toBe(204);

    for (let index = 0; index < 5; index += 1) fs.appendFileSync(file, `line ${index}\n`);
    await waitFor(() => changes(ctx.events).length >= 1);
    await sleep(250);
    expect(changes(ctx.events)).toEqual([{ type: 'filesystem.changed', data: { file, event: 'change' }, directory, options: undefined }]);

    fs.rmSync(file);
    await waitFor(() => changes(ctx.events).length >= 2);
    expect(changes(ctx.events)[1].data).toEqual({ file, event: 'unlink' });

    put(file, 'back\n');
    await waitFor(() => changes(ctx.events).length >= 3);
    expect(changes(ctx.events)[2].data).toEqual({ file, event: 'add' });
  });

  it('sees an editor that saves by writing a new file and renaming it, ignores its neighbours, and takes an absolute path', async () => {
    const directory = folder('watched');
    const file = path.join(directory, 'doc.txt');
    put(file, 'v1\n');
    const ctx = await start({ directory, watchOptions: options });
    expect((await watch(ctx, file)).status).toBe(204);

    put(path.join(directory, 'neighbour.txt'), 'noise\n');
    fs.writeFileSync(path.join(directory, '.doc.txt.swp'), 'v2 longer\n');
    fs.renameSync(path.join(directory, '.doc.txt.swp'), file);
    await waitFor(() => changes(ctx.events).length >= 1);
    await sleep(200);
    expect(changes(ctx.events).map((event) => event.data)).toEqual([{ file, event: 'change' }]);
  });

  it('answers FileNotFoundError for a path that is not an existing file inside the folder', async () => {
    const parent = folder('parent');
    const directory = path.join(parent, 'project');
    put(path.join(directory, 'real.txt'));
    put(path.join(directory, 'sub', 'file.txt'));
    put(path.join(parent, 'sibling.txt'));
    fs.symlinkSync(path.join(parent, 'sibling.txt'), path.join(directory, 'link.txt'));
    const ctx = await start({ directory, watchOptions: options });

    for (const requested of ['missing.txt', 'sub', '../sibling.txt', path.join(parent, 'sibling.txt'), '/etc/hosts', '', 'link.txt', '.']) {
      const answer = await watch(ctx, requested);
      expect(answer.status, requested).toBe(404);
      expect(answer.body, requested).toEqual({ _tag: 'FileNotFoundError', message: `File not found: ${requested}`, path: requested });
    }
    expect(ctx.workspace).toBeTruthy();
    expect((await ctx.call('POST', '/api/experimental/fs/watch')).status).toBe(400);
    expect((await ctx.call('POST', '/api/experimental/fs/watch', { body: { path: 5 } })).body.message).toBe('Expected string\n  at ["path"]');
    expect((await watch(ctx, 'real.txt', path.join(parent, 'gone'))).body._tag).toBe('LocationNotFoundError');
    expect((await watch(ctx, 'real.txt')).status).toBe(204);
    expect((await watch(ctx, 'sub/file.txt')).status).toBe(204);
  });

  it('stops on unwatch, on expiry, and when the location is released; unwatching an unknown path is fine', async () => {
    const directory = folder('watched');
    const first = path.join(directory, 'first.txt');
    const second = path.join(directory, 'second.txt');
    put(first);
    put(second);
    const created = [];
    const fsWatch = (...args) => {
      const watcher = fs.watch(...args);
      const close = watcher.close.bind(watcher);
      const record = { closed: false };
      watcher.close = () => { record.closed = true; close(); };
      created.push(record);
      return watcher;
    };
    const ctx = await start({ directory, watchOptions: { ...options, fsWatch } });
    await watch(ctx, 'first.txt');
    await watch(ctx, 'second.txt');
    expect(created).toHaveLength(1);

    expect((await ctx.call('DELETE', '/api/experimental/fs/watch', { body: { path: 'first.txt' } })).status).toBe(204);
    expect((await ctx.call('DELETE', '/api/experimental/fs/watch', { body: { path: 'never-watched.txt' } })).status).toBe(204);
    expect((await ctx.call('DELETE', '/api/experimental/fs/watch', { body: { path: '../outside.txt' } })).status).toBe(204);
    fs.appendFileSync(first, 'ignored\n');
    fs.appendFileSync(second, 'seen\n');
    await waitFor(() => changes(ctx.events).length >= 1);
    await sleep(150);
    expect(changes(ctx.events).map((event) => event.data.file)).toEqual([second]);
    expect(created[0].closed).toBe(false);

    // Releasing the location ends what is left and closes the OS watcher.
    expect((await ctx.call('DELETE', '/api/debug/location')).status).toBe(204);
    expect(created[0].closed).toBe(true);
    fs.appendFileSync(second, 'after release\n');
    await sleep(200);
    expect(changes(ctx.events)).toHaveLength(1);

    // Watching again works, and expires on its own.
    const shortLived = await start({ directory, watchOptions: { ...options, fsWatch, ttlMs: 120 } });
    await watch(shortLived, 'first.txt');
    const before = created.length;
    await waitFor(() => created.slice(before - 1).every((record) => record.closed));
    fs.appendFileSync(first, 'late\n');
    await sleep(200);
    expect(changes(shortLived.events)).toHaveLength(0);
  });

  it('watching again renews the expiry', async () => {
    const directory = folder('watched');
    const file = path.join(directory, 'renewed.txt');
    put(file);
    const ctx = await start({ directory, watchOptions: { ...options, ttlMs: 400 } });
    await watch(ctx, 'renewed.txt');
    await sleep(250);
    await watch(ctx, 'renewed.txt');
    await sleep(250);
    fs.appendFileSync(file, 'x\n');
    await waitFor(() => changes(ctx.events).length >= 1);
  });

  it('caps the watched files and folders with a 503, and releases a folder when its last file goes', async () => {
    const directory = folder('watched');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'sub/d.txt']) put(path.join(directory, name));
    const ctx = await start({ directory, watchOptions: { ...options, maxFiles: 2, maxFolders: 1 } });
    expect((await watch(ctx, 'a.txt')).status).toBe(204);
    expect((await watch(ctx, 'b.txt')).status).toBe(204);
    const full = await watch(ctx, 'c.txt');
    expect(full.status).toBe(503);
    expect(full.body._tag).toBe('ServiceUnavailableError');
    expect((await watch(ctx, 'a.txt')).status).toBe(204);

    await ctx.call('DELETE', '/api/experimental/fs/watch', { body: { path: 'a.txt' } });
    await ctx.call('DELETE', '/api/experimental/fs/watch', { body: { path: 'b.txt' } });
    expect((await watch(ctx, 'sub/d.txt')).status).toBe(204);
    expect((await watch(ctx, 'c.txt')).status).toBe(503);
  });

  it('drops the watches of a folder whose watcher fails, and closes every watcher when the bridge closes', async () => {
    const directory = folder('watched');
    put(path.join(directory, 'a.txt'));
    const { EventEmitter } = await import('node:events');
    const made = [];
    const fsWatch = () => {
      const watcher = new EventEmitter();
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      made.push(watcher);
      return watcher;
    };
    const ctx = await start({ directory, watchOptions: { ...options, fsWatch } });
    await watch(ctx, 'a.txt');
    made[0].emit('error', new Error('ENOSPC'));
    expect(made[0].closed).toBe(true);
    expect(ctx.logs.some((message) => message.includes('ENOSPC'))).toBe(true);

    await watch(ctx, 'a.txt');
    expect(made).toHaveLength(2);
    ctx.workspace.close();
    expect(made[1].closed).toBe(true);
    expect((await watch(ctx, 'a.txt')).status).toBe(503);
  });
});

describe('repository views', () => {
  /** A repository with every kind of change one review shows. */
  const reviewed = () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    put(path.join(repository, '.gitignore'), '*.log\n');
    put(path.join(repository, 'a.txt'), '1\n2\n');
    put(path.join(repository, 'gone.txt'), 'bye\n');
    put(path.join(repository, 'src', 'inner.txt'), 'inner\n');
    put(path.join(repository, 'src', 'other.txt'), 'other\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    put(path.join(repository, 'a.txt'), '1\n2\n3\n4\n');
    fs.rmSync(path.join(repository, 'gone.txt'));
    put(path.join(repository, 'staged.txt'), 'staged\n');
    git(repository, 'add', 'staged.txt');
    put(path.join(repository, 'loose.txt'), 'one\ntwo\n');
    put(path.join(repository, 'sub dir', 'with space.txt'), 'spaced\n');
    put(path.join(repository, 'src', 'inner.txt'), 'inner\nchanged\n');
    put(path.join(repository, 'noise.log'), 'ignored\n');
    fs.writeFileSync(path.join(repository, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    return repository;
  };

  const snapshotOf = (repository) => ({
    status: git(repository, 'status', '--porcelain=v1', '-uall'),
    index: fs.readFileSync(path.join(repository, '.git', 'index')).toString('hex'),
  });

  it('answers the status of the working tree against HEAD and leaves the repository exactly as it was', async () => {
    const repository = reviewed();
    const before = snapshotOf(repository);
    const { call } = await start({ directory: repository });

    const answer = await call('GET', '/api/vcs/status');
    expect(answer.status).toBe(200);
    expect(answer.body.location).toEqual({ directory: repository });
    expect(answer.body.data).toEqual([
      { file: 'a.txt', additions: 2, deletions: 0, status: 'modified' },
      { file: 'blob.bin', additions: 0, deletions: 0, status: 'added' },
      { file: 'gone.txt', additions: 0, deletions: 1, status: 'deleted' },
      { file: 'loose.txt', additions: 2, deletions: 0, status: 'added' },
      { file: 'src/inner.txt', additions: 1, deletions: 0, status: 'modified' },
      { file: 'staged.txt', additions: 1, deletions: 0, status: 'added' },
      { file: 'sub dir/with space.txt', additions: 1, deletions: 0, status: 'added' },
    ]);
    expect(() => schemas.fileStatuses(answer.body.data)).not.toThrow();
    expect(snapshotOf(repository)).toEqual(before);
  });

  it('answers the patches of the working tree, with git\'s own text for new, deleted and binary files', async () => {
    const repository = reviewed();
    const before = snapshotOf(repository);
    const { call } = await start({ directory: repository });
    const answer = await call('GET', '/api/vcs/diff?mode=working');
    expect(answer.status).toBe(200);
    const byFile = Object.fromEntries(answer.body.data.map((entry) => [entry.file, entry]));
    expect(Object.keys(byFile)).toEqual(['a.txt', 'blob.bin', 'gone.txt', 'loose.txt', 'src/inner.txt', 'staged.txt', 'sub dir/with space.txt']);
    expect(byFile['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 0 });
    expect(byFile['a.txt'].patch).toContain('diff --git a/a.txt b/a.txt');
    expect(byFile['a.txt'].patch).toContain('+3\n+4\n');
    expect(byFile['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byFile['gone.txt'].patch).toContain('deleted file mode 100644');
    expect(byFile['loose.txt']).toMatchObject({ status: 'added', additions: 2 });
    expect(byFile['loose.txt'].patch).toContain('new file mode 100644\nindex 0000000..');
    expect(byFile['loose.txt'].patch).toContain('--- /dev/null\n+++ b/loose.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    expect(byFile['blob.bin']).toMatchObject({ status: 'added', additions: 0, deletions: 0 });
    expect(byFile['blob.bin'].patch).toContain('Binary files /dev/null and b/blob.bin differ');
    expect(byFile['sub dir/with space.txt'].patch).toContain('+spaced');
    expect(answer.body.data.some((entry) => entry.file === 'noise.log')).toBe(false);
    expect(snapshotOf(repository)).toEqual(before);

    const none = await call('GET', '/api/vcs/diff?mode=working&context=0');
    expect(none.body.data.find((entry) => entry.file === 'src/inner.txt').patch).not.toContain('\n inner\n');
    const wide = await call('GET', '/api/vcs/diff?mode=working&context=3');
    expect(wide.body.data.find((entry) => entry.file === 'src/inner.txt').patch).toContain('\n inner\n');
  });

  it('lists a wholly untracked folder as one entry with untracked=folders', async () => {
    const repository = reviewed();
    const { call } = await start({ directory: repository });
    const answer = await call('GET', '/api/vcs/diff?mode=working&untracked=folders');
    const files = answer.body.data.map((entry) => entry.file);
    expect(files).toContain('sub dir/');
    expect(files).not.toContain('sub dir/with space.txt');
    expect(files).toContain('loose.txt');
    expect(answer.body.data.find((entry) => entry.file === 'sub dir/')).toEqual({
      file: 'sub dir/',
      patch: 'Index: sub dir/\n===================================================================\n--- sub dir/\t\n+++ sub dir/\t\n',
      additions: 0,
      deletions: 0,
      status: 'added',
    });
    expect([...files].sort()).toEqual(files);
  });

  it('limits a review to the request\'s folder and keeps repository-relative paths', async () => {
    const repository = reviewed();
    const { call } = await start({ directory: repository });
    const status = await call('GET', '/api/vcs/status', { dir: path.join(repository, 'src') });
    expect(status.body.data.map((entry) => entry.file)).toEqual(['src/inner.txt']);
    const diff = await call('GET', '/api/vcs/diff?mode=working', { dir: path.join(repository, 'src') });
    expect(diff.body.data.map((entry) => entry.file)).toEqual(['src/inner.txt']);
  });

  it('branch and committed reviews start at the merge base with the default branch, or at `base`', async () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    put(path.join(repository, 'base.txt'), 'base\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    git(repository, 'switch', '-q', '-c', 'feature', 'main');
    put(path.join(repository, 'feature.txt'), 'feature\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'feature');
    put(path.join(repository, 'wip.txt'), 'wip\n');
    const { call } = await start({ directory: repository });

    const files = async (query) => (await call('GET', `/api/vcs/diff?${query}`)).body.data.map((entry) => entry.file);
    expect(await files('mode=working')).toEqual(['wip.txt']);
    expect(await files('mode=committed')).toEqual(['feature.txt']);
    expect(await files('mode=branch')).toEqual(['feature.txt', 'wip.txt']);
    expect(await files('mode=committed&base=main')).toEqual(['feature.txt']);
    expect(await files('mode=committed&base=feature')).toEqual([]);

    const unknown = await call('GET', '/api/vcs/diff?mode=committed&base=nope');
    expect(unknown.status).toBe(503);
    expect(unknown.body).toEqual({ _tag: 'ServiceUnavailableError', message: 'No merge base available for nope', service: 'vcs' });

    const base = await call('GET', '/api/vcs/base');
    expect(base.body.data).toEqual({ name: 'main', ref: 'refs/heads/main', source: 'reflog' });
    expect(() => schemas.base(base.body.data)).not.toThrow();
  });

  it('answers the review base: the default branch on it, the branch it was created from, and "Choose a review base" otherwise', async () => {
    const repository = folder('repo');
    git(repository, 'init', '-q', '-b', 'main');
    put(path.join(repository, 'a.txt'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    const { call } = await start({ directory: repository });
    expect((await call('GET', '/api/vcs/base')).body.data).toEqual({ name: 'main', ref: 'refs/heads/main', source: 'default' });

    git(repository, 'checkout', '-q', '-b', 'from-head');
    const unknown = await call('GET', '/api/vcs/base');
    expect(unknown.status).toBe(503);
    expect(unknown.body).toEqual({ _tag: 'ServiceUnavailableError', message: 'Choose a review base', service: 'vcs' });

    git(repository, 'switch', '-q', '-c', 'from-main', 'main');
    expect((await call('GET', '/api/vcs/base')).body.data).toEqual({ name: 'main', ref: 'refs/heads/main', source: 'reflog' });
  });

  it('answers a folder outside any repository, an empty repository and a repository with no commit', async () => {
    const plain = folder('plain');
    const { call } = await start({ directory: plain });
    expect((await call('GET', '/api/vcs/status')).body.data).toEqual([]);
    expect((await call('GET', '/api/vcs/base')).body.data).toBeNull();
    expect((await call('GET', '/api/vcs/diff?mode=working')).body.data).toEqual([]);

    const fresh = folder('fresh');
    git(fresh, 'init', '-q', '-b', 'main');
    expect((await call('GET', '/api/vcs/status', { dir: fresh })).body.data).toEqual([]);
    expect((await call('GET', '/api/vcs/base', { dir: fresh })).body.data).toBeNull();
    put(path.join(fresh, 'first.txt'), 'first\n');
    git(fresh, 'add', 'first.txt');
    put(path.join(fresh, 'second.txt'), 'second\n');
    expect((await call('GET', '/api/vcs/status', { dir: fresh })).body.data).toEqual([
      { file: 'first.txt', additions: 1, deletions: 0, status: 'added' },
      { file: 'second.txt', additions: 1, deletions: 0, status: 'added' },
    ]);
    expect((await call('GET', '/api/vcs/diff?mode=committed', { dir: fresh })).body.data).toEqual([]);
    expect((await call('GET', '/api/vcs/diff?mode=branch', { dir: fresh })).body.data).toHaveLength(2);
  });

  it('rejects a bad query and never reads a base as an option', async () => {
    const repository = reviewed();
    const { call } = await start({ directory: repository });
    expect((await call('GET', '/api/vcs/diff')).body).toEqual({ _tag: 'InvalidRequestError', message: 'Missing key\n  at ["mode"]', kind: 'Query' });
    expect((await call('GET', '/api/vcs/diff?mode=git')).body.message).toBe('Expected Vcs.Mode\n  at ["mode"]');
    expect((await call('GET', '/api/vcs/diff?mode=working&untracked=x')).body.message).toBe('Expected Vcs.Untracked\n  at ["untracked"]');
    expect((await call('GET', '/api/vcs/diff?mode=working&context=-1')).body.message).toBe('Expected a value greater than or equal to 0\n  at ["context"]');
    expect((await call('GET', '/api/vcs/diff?mode=working&context=abc')).body.message).toBe('Expected an integer\n  at ["context"]');
    const sink = path.join(repository, 'pwned.txt');
    for (const base of [`--output=${sink}`, '-p', 'main%20--output=/tmp/x', '']) {
      expect((await call('GET', `/api/vcs/diff?mode=branch&base=${base}`)).status, base).toBe(400);
    }
    expect(fs.existsSync(sink)).toBe(false);
    expect((await call('GET', '/api/vcs/status', { dir: path.join(repository, 'gone') })).body._tag).toBe('LocationNotFoundError');
  });

  it('answers a git failure as 503, never as an empty review, and leaves out untracked files it cannot read', async () => {
    const repository = reviewed();
    const failing = await start({
      directory: repository,
      runGit: async (args) => {
        if (args[0] === 'ls-files') throw Object.assign(new Error('boom'), { code: 128, stderr: 'fatal: not a git repository' });
        return '';
      },
    });
    const status = await failing.call('GET', '/api/vcs/status');
    expect(status.status).toBe(503);
    expect(status.body).toMatchObject({ _tag: 'ServiceUnavailableError', service: 'vcs' });
    expect(status.body.message).toContain('fatal: not a git repository');

    const big = folder('repo');
    git(big, 'init', '-q', '-b', 'main');
    put(path.join(big, 'ok.txt'));
    fs.writeFileSync(path.join(big, 'huge.txt'), Buffer.alloc(3 * 1024 * 1024, 97));
    const ctx = await start({ directory: big });
    expect((await ctx.call('GET', '/api/vcs/status')).body.data.map((entry) => entry.file)).toEqual(['ok.txt']);
    expect(ctx.logs.some((message) => message.includes('left out of the review'))).toBe(true);
  });

  describe('POST /api/vcs/init', () => {
    it('runs git init, announces the branch, and refuses a folder that has version control', async () => {
      const plain = folder('plain');
      const { call, events } = await start({ directory: plain });
      const answer = await call('POST', '/api/vcs/init');
      expect(answer.status).toBe(204);
      expect(answer.text).toBe('');
      expect(fs.existsSync(path.join(plain, '.git'))).toBe(true);
      const branch = git(plain, 'symbolic-ref', '--short', 'HEAD').trim();
      expect(events).toEqual([{ type: 'vcs.branch.updated', data: { branch }, directory: plain, options: undefined }]);

      const again = await call('POST', '/api/vcs/init');
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ _tag: 'ConflictError', message: 'Project already has version control', resource: plain });
      const inside = await call('POST', '/api/vcs/init', { dir: folder('plain-inside') });
      expect(inside.status).toBe(204);
    });

    it('answers VCS initialization failed for another provider or a failing git, and 404 for a missing folder', async () => {
      const plain = folder('plain');
      const { call, events } = await start({ directory: plain });
      const other = await call('POST', '/api/vcs/init?provider=hg');
      expect(other.status).toBe(503);
      expect(other.body).toEqual({ _tag: 'ServiceUnavailableError', message: 'VCS initialization failed', service: 'hg' });
      expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);

      const broken = await start({ directory: plain, runGit: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
      const failed = await broken.call('POST', '/api/vcs/init');
      expect(failed.status).toBe(503);
      expect(failed.body.message).toBe('VCS initialization failed');
      expect(broken.events).toEqual([]);

      expect((await call('POST', '/api/vcs/init', { dir: path.join(plain, 'gone') })).body._tag).toBe('LocationNotFoundError');
      expect(events).toEqual([]);
    });
  });
});

describe('location, debug and session background', () => {
  it('reload answers 204 for any folder and calls the hook with it', async () => {
    const calls = [];
    const ctx = await start({ reload: async (directory) => { calls.push(directory); } });
    expect((await ctx.call('POST', '/api/location/reload')).status).toBe(204);
    expect((await ctx.call('POST', '/api/location/reload', { dir: null })).status).toBe(204);
    expect((await ctx.call('POST', '/api/location/reload', { dir: path.join(ctx.directory, 'gone') })).status).toBe(204);
    expect(calls).toEqual([ctx.directory, null, path.join(ctx.directory, 'gone')]);
  });

  it('lists no running locations and accepts an eviction of any folder', async () => {
    const ctx = await start();
    const listed = await ctx.call('GET', '/api/debug/location', { dir: null });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
    expect((await ctx.call('DELETE', '/api/debug/location')).status).toBe(204);
    expect((await ctx.call('DELETE', '/api/debug/location', { dir: null })).status).toBe(204);
    expect((await ctx.call('DELETE', `/api/debug/location?location[directory]=${encodeURIComponent(path.join(ctx.directory, 'gone'))}`, { dir: null })).status).toBe(204);
  });

  it('answers 204 to a background request for a known session and tagged errors otherwise', async () => {
    const ctx = await start({ sessions: { ses_known: { id: 'ses_known', location: { directory: '/x' } } } });
    expect((await ctx.call('POST', '/api/session/ses_known/background')).status).toBe(204);
    const unknown = await ctx.call('POST', '/api/session/ses_nope/background');
    expect(unknown.status).toBe(404);
    expect(unknown.body._tag).toBe('SessionNotFoundError');
    const bad = await ctx.call('POST', '/api/session/abc/background');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ _tag: 'InvalidRequestError', message: 'Expected a string starting with "ses"\n  at ["sessionID"]', kind: 'Params' });
  });

  describe('POST /api/debug/heap-dump', () => {
    it('writes a snapshot only this user can read, keeps the newest three and answers path, pid and memory', async () => {
      const written = [];
      const ctx = await start({ writeHeapSnapshot: (file) => { written.push(file); fs.writeFileSync(file, '{"snapshot":{}}'); } });
      let last;
      for (let index = 0; index < 5; index += 1) {
        last = await ctx.call('POST', '/api/debug/heap-dump', { dir: null });
        await sleep(5);
      }
      expect(last.status).toBe(200);
      expect(Object.keys(last.body).sort()).toEqual(['memory', 'path', 'pid']);
      expect(last.body.pid).toBe(process.pid);
      expect(Object.keys(last.body.memory).sort()).toEqual(['arrayBuffers', 'external', 'heapTotal', 'heapUsed', 'rss']);
      expect(last.body.path).toBe(written.at(-1));
      expect(path.dirname(last.body.path)).toBe(path.join(ctx.tmpDir, 'openchamber-heap'));
      expect(fs.statSync(last.body.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(last.body.path)).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(last.body.path))).toHaveLength(3);
    });

    it('answers a tagged 500 and leaves no file when V8 cannot write', async () => {
      const ctx = await start({ writeHeapSnapshot: () => { throw new Error('disk full'); } });
      const answer = await ctx.call('POST', '/api/debug/heap-dump', { dir: null });
      expect(answer.status).toBe(500);
      expect(answer.body).toEqual({ _tag: 'UnknownError', message: 'The heap snapshot could not be written' });
      expect(fs.readdirSync(path.join(ctx.tmpDir, 'openchamber-heap'))).toEqual([]);
    });
  });

  it('keeps unknown routes a bare 404 and the Basic auth in front of every route', async () => {
    const ctx = await start();
    const unknown = await fetch(`${ctx.base}/api/experimental/nope`, { headers: { authorization: AUTHORIZATION } });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('');
    for (const [method, route] of [['GET', '/api/fs/find?query=a'], ['POST', '/api/vcs/init'], ['GET', '/api/shell'], ['GET', '/api/experimental/job'], ['POST', '/api/debug/heap-dump'], ['POST', '/api/experimental/fs/write?path=/x']]) {
      const response = await fetch(`${ctx.base}${route}`, { method });
      expect(response.status, route).toBe(401);
      expect((await response.json())._tag).toBe('UnauthorizedError');
    }
  });
});
