// `GET /api/vcs` and `GET /api/vcs/branch`: the branch of the request's folder.
//
// What OpenCode 2.2.6 answers (golden 02, and a live probe for the cases the
// goldens lack): a git folder `{ provider: 'git', branch: { current, default } }`;
// a folder outside any repository `{ branch: {} }` with no `provider`, and `[]`
// for the branch list. `current` and `default` are each optional in the schema,
// so a value git cannot give is left out instead of guessed.

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 3000;

/** Runs `git <args>` in `cwd`; resolves with stdout, rejects on a non-zero exit, a missing git or the timeout. */
export const runGitCommand = (args, { cwd }) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

const DEFAULT_BRANCH_CANDIDATES = ['main', 'master'];

/**
 * @param {object} options
 * @param {(args: string[], options: { cwd: string }) => Promise<string>} options.runGit
 * @param {(message: string) => void} options.report  Called when git itself cannot run (not when a repository merely lacks an answer).
 */
export const createGitInfo = ({ runGit, report }) => {
  const attempt = async (directory, args) => {
    try {
      return (await runGit(args, { cwd: directory })).trim();
    } catch (error) {
      // Exit code 1 and 128 are git's own "no such ref" and "not here" answers;
      // anything else (a missing binary, the timeout) is a fault worth saying.
      if (typeof error?.code !== 'number') report(`git ${args[0]} failed in ${directory}: ${error?.message ?? error}`);
      return null;
    }
  };

  const hasBranch = async (directory, name) => (await attempt(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) !== null;

  const defaultBranch = async (directory, current) => {
    const remoteHead = await attempt(directory, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (remoteHead) return remoteHead.replace(/^origin\//, '');
    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
      if (await hasBranch(directory, candidate)) return candidate;
    }
    return current ?? null;
  };

  /** @param {string} directory @param {boolean} isRepository */
  const info = async (directory, isRepository) => {
    if (!isRepository) return { branch: {} };
    const current = await attempt(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const fallback = await defaultBranch(directory, current);
    return {
      provider: 'git',
      branch: {
        ...(current ? { current } : {}),
        ...(fallback ? { default: fallback } : {}),
      },
    };
  };

  /**
   * @param {string} directory
   * @param {boolean} isRepository
   * @param {{ search?: string | null, limit?: number | null }} [filter]
   */
  const branches = async (directory, isRepository, { search, limit } = {}) => {
    if (!isRepository) return [];
    const listed = await attempt(directory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    let names = (listed ?? '').split('\n').filter(Boolean);
    if (search) {
      const needle = search.toLowerCase();
      names = names.filter((name) => name.toLowerCase().includes(needle));
    }
    return limit ? names.slice(0, limit) : names;
  };

  return { info, branches };
};
