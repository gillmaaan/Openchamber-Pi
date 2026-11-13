// Resolving the folder a location-scoped request works in.

import path from 'node:path';

import { locationNotFound } from './errors.js';
import { directoryExists, resolveProject } from './project.js';

/**
 * The folder of a request: `x-opencode-directory` or `location[directory]`,
 * else the default the bridge was started with (OpenCode answers a request with
 * neither for its own working directory). A folder that does not exist is a
 * tagged 404, never an empty answer.
 *
 * @param {{ directory: string|null }} ctx
 * @param {{ getDefaultDirectory: () => string }} options
 */
export const resolveLocation = (ctx, { getDefaultDirectory }) => {
  const requested = ctx.directory ?? getDefaultDirectory();
  const directory = path.resolve(requested);
  if (!directoryExists(directory)) throw locationNotFound(directory);
  return { directory, project: resolveProject(directory) };
};
