import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSnapshotStore, createStepLog } from './session-snapshots.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const hashOf = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');

describe('work tree snapshots', () => {
  let temp;
  let repo;
  let store;
  const target = () => ({ projectID: 'proj1', root: repo, subpath: '' });

  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-snap-')));
    repo = path.join(temp, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
    git(repo, 'init', '-q', '.');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n*.log\n.env\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'sub file\n');
    fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 250, 0, 7]));
    fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'i.js'), 'ignored\n');
    fs.writeFileSync(path.join(repo, 'debug.log'), 'log\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    store = createSnapshotStore({ rootDir: path.join(temp, 'snapshots') });
  });
  afterEach(() => {
    fs.chmodSync(path.join(repo, 'sub'), 0o755);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('snapshots the work tree without touching the user repository, and honors ignore rules', async () => {
    fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const userIndex = hashOf(path.join(repo, '.git', 'index'));
    const status = git(repo, 'status', '--porcelain');
    const refs = git(repo, 'for-each-ref');

    const first = await store.track(target());
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await store.track(target())).toBe(first);

    const names = git(path.join(temp, 'snapshots', 'proj1'), 'ls-tree', '-r', '--name-only', first).split('\n').filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['a.txt', 'untracked.txt', 'bin.dat', 'sub/s.txt']));
    expect(names.some((name) => name.startsWith('node_modules') || name === 'debug.log' || name === '.env' || name.startsWith('.git/'))).toBe(false);
    // The dirty content is in the snapshot, and the user's repository saw nothing.
    expect(git(path.join(temp, 'snapshots', 'proj1'), 'show', `${first}:a.txt`)).toBe('one\ntwo\ndirty\n');
    expect(hashOf(path.join(repo, '.git', 'index'))).toBe(userIndex);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(git(repo, 'for-each-ref')).toBe(refs);

    fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n');
    expect(await store.track(target())).not.toBe(first);
  });

  it('honors the repository info/exclude', async () => {
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'private.txt\n');
    fs.writeFileSync(path.join(repo, 'private.txt'), 'mine\n');
    const tree = await store.track(target());
    expect(git(path.join(temp, 'snapshots', 'proj1'), 'ls-tree', '-r', '--name-only', tree)).not.toContain('private.txt');
  });

  it('diffs two snapshots: edit, new file, deleted file, binary, with counts and statuses', async () => {
    const before = await store.track(target());
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(repo, 'created.txt'), 'data\n');
    fs.rmSync(path.join(repo, 'b.txt'));
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([9, 9, 0, 0, 9]));
    fs.writeFileSync(path.join(repo, 'debug.log'), 'changed ignored\n');
    const after = await store.track(target());

    const diffs = await store.diff({ ...target(), from: before, to: after });
    const byFile = Object.fromEntries(diffs.map((entry) => [entry.file, entry]));
    expect(Object.keys(byFile).sort()).toEqual(['a.txt', 'b.txt', 'bin.dat', 'created.txt']);
    expect(byFile['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byFile['a.txt'].patch).toContain('diff --git a/a.txt b/a.txt');
    expect(byFile['created.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(byFile['created.txt'].patch).toContain('new file mode 100644');
    expect(byFile['b.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byFile['b.txt'].patch).toContain('deleted file mode 100644');
    expect(byFile['bin.dat']).toMatchObject({ status: 'modified', additions: 0, deletions: 0 });
    expect(byFile['bin.dat'].patch).toMatch(/Binary files/);

    const only = await store.diff({ ...target(), from: before, to: after, files: ['created.txt'], context: 0 });
    expect(only.map((entry) => entry.file)).toEqual(['created.txt']);
    expect(await store.changedFiles({ ...target(), from: before, to: before })).toEqual([]);
  });

  it('restores edits, new files, deleted files, binary content and modes, and leaves everything else alone', async () => {
    const before = await store.track(target());
    const binary = path.join(repo, 'bin.dat');
    const binaryHash = hashOf(binary);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'rewritten\n');
    fs.writeFileSync(path.join(repo, 'created.txt'), 'data\n');
    fs.mkdirSync(path.join(repo, 'newdir'));
    fs.writeFileSync(path.join(repo, 'newdir', 'n.txt'), 'n\n');
    fs.rmSync(path.join(repo, 'b.txt'));
    fs.writeFileSync(binary, Buffer.from([9, 9, 9]));
    fs.chmodSync(path.join(repo, 'run.sh'), 0o644);
    // Not part of the plan: a user's own edit, an ignored file.
    fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'user edit\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=2\n');

    const plan = new Map(['a.txt', 'created.txt', 'newdir/n.txt', 'b.txt', 'bin.dat', 'run.sh'].map((file) => [file, before]));
    const changed = await store.restore({ ...target(), directory: repo, plan });
    expect(changed.sort()).toEqual(['a.txt', 'b.txt', 'bin.dat', 'created.txt', 'newdir/n.txt', 'run.sh']);

    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(fs.existsSync(path.join(repo, 'created.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'newdir'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('bee\n');
    expect(hashOf(binary)).toBe(binaryHash);
    expect(fs.statSync(path.join(repo, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(repo, 'sub', 's.txt'), 'utf8')).toBe('user edit\n');
    expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toBe('SECRET=2\n');
    expect(fs.readdirSync(repo).filter((name) => name.includes('oc-restore'))).toEqual([]);
    // The tree matches the snapshot again for the planned files.
    const after = await store.track(target());
    const stillDifferent = (await store.changedFiles({ ...target(), from: before, to: after })).map((entry) => entry.file);
    expect(stillDifferent).toEqual(['sub/s.txt']);
  });

  it('works for a session folder below the project root', async () => {
    const target2 = { projectID: 'proj1', root: repo, subpath: 'sub' };
    const before = await store.track(target2);
    fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'sub', 'new.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'outside\n');
    const after = await store.track(target2);
    const diffs = await store.diff({ ...target2, from: before, to: after });
    expect(diffs.map((entry) => entry.file).sort()).toEqual(['new.txt', 's.txt']);
    expect(diffs[0].patch).toContain('a/');

    await store.restore({ ...target2, directory: path.join(repo, 'sub'), plan: new Map([['s.txt', before], ['new.txt', before]]) });
    expect(fs.readFileSync(path.join(repo, 'sub', 's.txt'), 'utf8')).toBe('sub file\n');
    expect(fs.existsSync(path.join(repo, 'sub', 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('outside\n');
  });

  it('puts every file back when a restore fails part way', async () => {
    const before = await store.track(target());
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited a\n');
    fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'edited s\n');
    // The second file's folder cannot take a new file, so its swap fails after the first one went in.
    fs.chmodSync(path.join(repo, 'sub'), 0o555);
    const snapshotOfDisk = () => ({ a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), s: fs.readFileSync(path.join(repo, 'sub', 's.txt'), 'utf8') });
    const disk = snapshotOfDisk();

    await expect(store.restore({ ...target(), directory: repo, plan: new Map([['a.txt', before], ['sub/s.txt', before]]) })).rejects.toThrow(/nothing was changed/);
    expect(snapshotOfDisk()).toEqual(disk);
    expect(fs.readdirSync(repo).filter((name) => name.includes('oc-restore'))).toEqual([]);
    expect(fs.readdirSync(path.join(repo, 'sub'))).toEqual(['s.txt']);
    expect(fs.existsSync(path.join(temp, 'snapshots', 'proj1', 'staging', fs.readdirSync(path.join(temp, 'snapshots', 'proj1', 'staging'))[0] ?? 'none'))).toBe(false);
  });

  it('refuses paths that leave the folder and links that lead out of it, changing nothing', async () => {
    const before = await store.track(target());
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'o.txt'), 'outside original\n');
    fs.rmSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'sub'));

    await expect(store.restore({ ...target(), directory: repo, plan: new Map([['../outside/o.txt', before]]) })).rejects.toThrow(/outside the folder/);
    await expect(store.restore({ ...target(), directory: repo, plan: new Map([['a.txt', before], ['sub/s.txt', before]]) })).rejects.toThrow(/link that leaves/);
    await expect(store.restore({ ...target(), directory: repo, plan: new Map([['.git/config', before]]) })).rejects.toThrow(/outside the folder/);
    expect(fs.readdirSync(outside)).toEqual(['o.txt']);
    expect(fs.readFileSync(path.join(outside, 'o.txt'), 'utf8')).toBe('outside original\n');
  });

  it('reports no snapshot when git is missing or too slow, and says it is not available', async () => {
    const missing = createSnapshotStore({ rootDir: path.join(temp, 'none'), gitBin: path.join(temp, 'no-such-git') });
    expect(await missing.track(target())).toBeNull();
    expect(missing.isAvailable()).toBe(false);
    await expect(missing.restore({ ...target(), directory: repo, plan: new Map() })).rejects.toThrow(/not available/);

    const slow = createSnapshotStore({ rootDir: path.join(temp, 'slow'), timeoutMs: 1 });
    expect(await slow.track(target())).toBeNull();
  });

  it('keeps one step log line per assistant message and drops removed ones', async () => {
    const log = createStepLog({ dir: path.join(temp, 'steps') });
    await log.append('ses_x', 'msg_a', { start: 's1', end: 'e1', files: ['a.txt'] });
    await log.append('ses_x', 'msg_b', { start: 'e1', end: 'e2', files: [] });
    const reread = createStepLog({ dir: path.join(temp, 'steps') });
    expect([...(await reread.map('ses_x')).keys()]).toEqual(['msg_a', 'msg_b']);
    await reread.drop('ses_x', ['msg_b']);
    expect([...(await createStepLog({ dir: path.join(temp, 'steps') }).map('ses_x')).keys()]).toEqual(['msg_a']);
    await reread.remove('ses_x');
    expect((await createStepLog({ dir: path.join(temp, 'steps') }).map('ses_x')).size).toBe(0);
  });
});
