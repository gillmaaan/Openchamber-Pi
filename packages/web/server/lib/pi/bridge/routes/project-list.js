// `GET /api/project`: the projects the bridge has seen.
//
// OpenCode lists the projects it opened. The bridge's counterpart is the set of
// folders its sessions ran in (`listKnownDirectories`), grouped by project id
// (`resolveProject`): every folder of one repository, linked worktrees
// included, is one project. `canonical` is the main checkout, a linked
// worktree's own folder is a sandbox.
//
// Times: a caller that knows when a folder was first and last used passes
// `{ directory, time: { created, updated, active } }`. For a plain string the
// times come from the project folder on disk (birth and modification time),
// since the bridge has no record of its own.

import fs from 'node:fs';
import path from 'node:path';

import { resolveProject } from '../project.js';

const timesOf = (directory) => {
  try {
    const stat = fs.statSync(directory);
    const created = Math.trunc(stat.birthtimeMs || stat.ctimeMs);
    const updated = Math.trunc(stat.mtimeMs);
    return { created, updated, active: updated };
  } catch {
    return null;
  }
};

/** @param {Array<string | { directory: string, time?: { created?: number, updated?: number, active?: number } }>} known */
export const buildProjectList = (known) => {
  const byId = new Map();
  for (const entry of known) {
    const directory = typeof entry === 'string' ? entry : entry?.directory;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) continue;
    const project = resolveProject(path.resolve(directory));
    const canonical = project.checkout ?? project.root;
    const reported = typeof entry === 'string' ? null : entry.time;
    const measured = timesOf(canonical);
    const created = reported?.created ?? measured?.created ?? 0;
    const updated = reported?.updated ?? measured?.updated ?? created;
    const active = reported?.active ?? updated;

    const existing = byId.get(project.id);
    if (!existing) {
      byId.set(project.id, {
        id: project.id,
        canonical,
        ...(project.vcs ? { vcs: project.vcs } : {}),
        time: { created, updated, active },
        sandboxes: project.checkout ? [project.root] : [],
      });
      continue;
    }
    existing.time = {
      created: Math.min(existing.time.created, created),
      updated: Math.max(existing.time.updated, updated),
      active: Math.max(existing.time.active, active),
    };
    if (project.checkout && !existing.sandboxes.includes(project.root)) existing.sandboxes.push(project.root);
  }
  return [...byId.values()].sort((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id));
};
