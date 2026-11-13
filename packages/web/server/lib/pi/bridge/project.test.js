import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { invalidRequest } from './errors.js';
import { resolveLocation } from './location.js';
import { resolveProject } from './project.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-project-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const mkdir = (...parts) => {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('resolveProject', () => {
  it('uses the checkout as the project root and leaves subpath out at the root', () => {
    const repo = mkdir('repo');
    fs.mkdirSync(path.join(repo, '.git'));
    const project = resolveProject(repo);
    expect(project).toMatchObject({ root: repo, vcs: 'git', subpath: undefined, checkout: null });
    expect(project.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports the path below the root as subpath and keeps the id', () => {
    const repo = mkdir('repo2');
    fs.mkdirSync(path.join(repo, '.git'));
    const nested = mkdir('repo2', 'packages', 'app');
    expect(resolveProject(nested)).toMatchObject({ root: repo, subpath: path.join('packages', 'app'), id: resolveProject(repo).id });
  });

  it('gives a worktree the id of its main checkout', () => {
    const main = mkdir('main');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const worktree = mkdir('wt', 'feature');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);

    const project = resolveProject(worktree);
    expect(project.id).toBe(resolveProject(main).id);
    expect(project).toMatchObject({ root: worktree, checkout: main, vcs: 'git' });
  });

  it('gives a folder outside any repository an id of its own and no vcs', () => {
    const plain = mkdir('plain');
    const project = resolveProject(plain);
    expect(project).toMatchObject({ root: plain, vcs: undefined, subpath: undefined });
    expect(project.id).not.toBe(resolveProject(mkdir('plain2')).id);
  });
});

describe('resolveLocation', () => {
  it('prefers the request directory over the default', () => {
    const dir = mkdir('loc-a');
    const location = resolveLocation({ directory: dir }, { getDefaultDirectory: () => root });
    expect(location.directory).toBe(dir);
  });

  it('falls back to the default when the request names none', () => {
    expect(resolveLocation({ directory: null }, { getDefaultDirectory: () => root }).directory).toBe(root);
  });

  it('answers a missing folder with a tagged 404', () => {
    const missing = path.join(root, 'nope');
    try {
      resolveLocation({ directory: missing }, { getDefaultDirectory: () => root });
      throw invalidRequest('should not reach');
    } catch (error) {
      expect(error).toMatchObject({ status: 404, tag: 'LocationNotFoundError', extra: { location: { directory: missing } } });
    }
  });
});
