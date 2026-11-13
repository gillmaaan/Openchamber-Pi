// Pi's own files as the catalog routes read them. Every read goes to the file
// at request time, so an edit made with the `pi` CLI shows up on the next call;
// only `models.json` is also held by the catalog's runtime (see NOTES.md).

import fs from 'node:fs/promises';
import path from 'node:path';

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * A JSON file that must hold an object. A missing file is not an error (most
 * of Pi's files are optional); anything else that stops the file from being
 * used is reported in `error`, so the caller can say so instead of treating
 * the file as empty.
 *
 * @returns {Promise<{ value: Record<string, unknown> | null, error: string | null }>}
 */
export const readJsonObject = async (file) => {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { value: null, error: null };
    return { value: null, error: `Cannot read ${file}: ${error.message}` };
  }
  try {
    const parsed = JSON.parse(stripBom(text));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: `${file} must hold a JSON object` };
    }
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `Cannot parse ${file}: ${error.message}` };
  }
};

/**
 * Logs a problem once per distinct message and key, so a route polled every
 * few seconds does not repeat itself. Reporting `null` for a key says the
 * problem is gone; the same message later is logged again.
 *
 * @param {(message: string) => void} log
 */
export const createReporter = (log) => {
  const last = new Map();
  return (key, message) => {
    if (message === null || message === undefined) {
      last.delete(key);
      return;
    }
    if (last.get(key) === message) return;
    last.set(key, message);
    log(message);
  };
};

/** Pi's files in its agent directory. */
export const agentPaths = (agentDir) => ({
  settings: path.join(agentDir, 'settings.json'),
  models: path.join(agentDir, 'models.json'),
  auth: path.join(agentDir, 'auth.json'),
  mcp: path.join(agentDir, 'mcp.json'),
});

/** Pi's files in a project's `.pi` folder. */
export const projectPaths = (directory) => ({
  config: path.join(directory, '.pi'),
  settings: path.join(directory, '.pi', 'settings.json'),
  mcp: path.join(directory, '.pi', 'mcp.json'),
});
