// Which project a folder belongs to.
//
// OpenCode derives a project id from the repository's root commit, so every
// worktree of one repository shares it. Reading that needs `git`; this walks up
// for `.git` instead and follows a worktree's `.git` file to the main
// repository, so the id is stable and shared the same way without a process.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

const isDirectory = (candidate) => {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
};

/** For a worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`), the main checkout; null otherwise. */
const mainCheckoutOfWorktree = (gitFile) => {
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!match) return null;
    const gitdir = path.resolve(path.dirname(gitFile), match[1]);
    let commondir = gitdir;
    try {
      const pointer = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
      commondir = path.resolve(gitdir, pointer);
    } catch { /* a submodule's gitdir has no commondir */ }
    return path.basename(commondir) === '.git' ? path.dirname(commondir) : null;
  } catch {
    return null;
  }
};

/**
 * @param {string} directory  An absolute folder path.
 * @returns {{ id: string, root: string, checkout: string|null, vcs: 'git'|undefined, subpath: string|undefined }}
 *   `root` is the project root (the checkout, or for a worktree the folder
 *   holding its `.git` file); `subpath` is `directory` relative to it, absent
 *   at the root.
 */
export const resolveProject = (directory) => {
  const start = path.resolve(directory);
  for (let current = start; ; current = path.dirname(current)) {
    const dotGit = path.join(current, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* none here */ }
    if (stat) {
      const main = stat.isFile() ? mainCheckoutOfWorktree(dotGit) : null;
      const identity = main ?? current;
      const relative = path.relative(current, start);
      return { id: sha1(identity), root: current, checkout: main, vcs: 'git', subpath: relative === '' ? undefined : relative };
    }
    if (path.dirname(current) === current) break;
  }
  return { id: sha1(start), root: start, checkout: null, vcs: undefined, subpath: undefined };
};

export const directoryExists = (directory) => isDirectory(directory);
