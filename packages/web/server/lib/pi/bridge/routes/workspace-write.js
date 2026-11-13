// `POST /api/experimental/fs/write`: the composer's attachment helper.
//
// The UI writes a file's bytes under `<paths.tmp>/openchamber/<random>/<name>`
// (`GET /api/info` names the temp folder) and hands the path it gets back to
// the agent, which reads there. The body is the raw bytes, `path` an absolute
// query parameter; the answer is `{ location, data: { path } }`.
//
// OpenCode writes anywhere the process can (a probe wrote into the project and
// followed `..`). The bridge writes only below `<tmpDir>/openchamber`:
// - the path must resolve (no `..` left) to a file under that folder;
// - the folder is created `0700` and must be a real folder of this user, not a
//   link someone else planted in a shared temp directory;
// - the folder of the file must resolve inside it after symlinks;
// - the bytes go to a file made with `O_EXCL` next to the target and are renamed
//   over it, so a link at the target is replaced and never followed, and a
//   failed or oversized upload leaves nothing behind;
// - the body is capped at `maxBytes`, and the rest is read and dropped so the
//   connection stays usable.

import fs from 'node:fs';
import path from 'node:path';

import { invalidRequest, serviceUnavailable } from '../errors.js';
import { json } from '../http.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * @param {object} options
 * @param {string} options.tmpDir  The temp folder `GET /api/info` reports.
 * @param {number} [options.maxBytes]
 */
export const createTempFileWriter = ({ tmpDir, maxBytes = DEFAULT_MAX_BYTES }) => {
  const root = path.resolve(tmpDir, 'openchamber');

  /** The writable folder: a real directory of this user, created on first use. */
  const ensureRoot = async () => {
    await fs.promises.mkdir(root, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const stat = await fs.promises.lstat(root);
    const owner = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== owner) {
      throw serviceUnavailable(`The temp folder ${root} is not a folder of this user`, 'fs');
    }
    return fs.promises.realpath(root);
  };

  /** Writes the request body to `requested`; resolves with the path that was written. */
  const write = async (requested, request) => {
    if (!path.isAbsolute(requested)) throw invalidRequest('Expected an absolute path\n  at ["path"]', { kind: 'Query' });
    const target = path.resolve(requested);
    if (!isInside(root, target)) throw invalidRequest(`Files can only be written under ${root}\n  at ["path"]`, { kind: 'Query' });

    const realRoot = await ensureRoot();
    const directory = path.dirname(target);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const realDirectory = await fs.promises.realpath(directory);
    if (realDirectory !== realRoot && !isInside(realRoot, realDirectory)) {
      throw invalidRequest(`Files can only be written under ${root}\n  at ["path"]`, { kind: 'Query' });
    }

    const partial = path.join(realDirectory, `.upload-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const handle = await fs.promises.open(partial, 'wx', 0o600);
    let total = 0;
    try {
      for await (const chunk of request) {
        total += chunk.length;
        if (total <= maxBytes) await handle.write(chunk);
      }
    } catch (error) {
      await handle.close();
      await fs.promises.rm(partial, { force: true });
      throw error;
    }
    await handle.close();
    if (total > maxBytes) {
      await fs.promises.rm(partial, { force: true });
      throw invalidRequest(`The file is larger than ${maxBytes} bytes`, { kind: 'Payload' });
    }
    try {
      await fs.promises.rename(partial, path.join(realDirectory, path.basename(target)));
    } catch (error) {
      await fs.promises.rm(partial, { force: true });
      if (['EISDIR', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error?.code)) throw invalidRequest('The path is not a file\n  at ["path"]', { kind: 'Query' });
      throw error;
    }
    return target;
  };

  return { root, write };
};

/**
 * @param {object} deps
 * @param {(ctx: object) => { directory: string }} deps.locate
 * @param {ReturnType<typeof createTempFileWriter>} deps.writer
 */
export const createWriteRoutes = ({ locate, writer }) => [
  {
    method: 'POST',
    path: '/api/experimental/fs/write',
    handler: async (ctx) => {
      const { directory } = locate(ctx);
      const requested = ctx.query.get('path');
      if (requested === null) throw invalidRequest('Missing key\n  at ["path"]', { kind: 'Query' });
      const written = await writer.write(requested, ctx.req);
      return json({ location: { directory }, data: { path: written } });
    },
  },
];
