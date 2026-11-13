// `/api/plugin`, `/api/plugin/check` and `/api/plugin/update` of the OpenCode
// 2.2.6 dialect, answered from Pi packages.
//
// The Settings page matches its package rows to this inventory by `source.target`
// (the source string verbatim, no implicit `@latest`) and local rows by path
// (`pluginLoadState.ts`), so a package keeps the string settings.json holds.
//
// Register these before the catalog's `/api/plugin`, which answers from the
// settings file alone and knows neither the install state nor the trust of a project.

import { invalidRequest, serviceUnavailable } from '../errors.js';
import { json, noContent } from '../http.js';
import { resolveLocation } from '../location.js';
import { managedToolFlags } from '../../managed-runtime.js';
import { describeManagedExtensions } from '../../packages.js';

const REFUSALS = new Set(['INVALID_SCOPE', 'INVALID_SPEC', 'UNLOADABLE_SPEC', 'INVALID_DIRECTORY', 'NOT_FOUND', 'PROJECT_NOT_TRUSTED', 'IDENTITY_CHANGED']);

const FAILED_REASON = {
  'project-not-trusted': (directory) => `Not loaded: ${directory} is not a trusted project, so Pi skips its packages and extensions.`,
  'not-installed': () => 'Not installed. Pi installs a missing package when it starts, which needs the network.',
};

const failedState = (reason, directory) => ({ status: 'failed', error: FAILED_REASON[reason](directory) });

/**
 * One PluginInfo per package or extension Pi would load for the folder. A
 * package switched off is left out: the page reads "not reported" as "not
 * loaded", which is what it is.
 */
const toInventory = (listing, directory, outdatedIds, managed) => {
  const rows = [];
  for (const extension of managed) {
    if (extension.enabled) {
      rows.push({ id: extension.id, source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } });
    }
  }
  for (const pkg of listing.packages) {
    if (pkg.notLoadedReason === 'disabled') continue;
    const source = pkg.kind === 'local'
      ? { type: 'local', path: pkg.resolvedPath ?? pkg.installedPath ?? pkg.source }
      : {
        type: 'package',
        target: pkg.source,
        ...(pkg.version ? { version: pkg.version } : {}),
        ...(outdatedIds.has(pkg.id) ? { outdated: true } : {}),
      };
    rows.push({
      id: `pi.package:${pkg.scope}:${pkg.source}`,
      source,
      features: { server: true },
      state: pkg.loaded ? { status: 'active' } : failedState(pkg.notLoadedReason, directory),
    });
  }
  for (const extension of listing.extensions) {
    if (extension.notLoadedReason === 'disabled') continue;
    rows.push({
      id: `pi.extension:${extension.scope}:${extension.name}`,
      source: { type: 'local', path: extension.absolutePath },
      features: { server: true },
      state: extension.loaded ? { status: 'active' } : failedState(extension.notLoadedReason, directory),
    });
  }
  return rows;
};

/** A refusal is the caller's request; a failed install, a stopped Pi or a locked file is the service. */
const toWireError = (error) => {
  if (REFUSALS.has(error?.code)) return invalidRequest(error.message, { kind: 'Payload', field: 'targets' });
  if (error?.code) return serviceUnavailable(error.message, 'pi');
  return error;
};

/**
 * @param {object} deps
 * @param {ReturnType<import('../../packages.js').createPiPackages>} deps.packages
 * @param {() => string} deps.getDefaultDirectory
 * @param {() => Promise<object|null>} [deps.readSettings]  OpenChamber's settings, for the managed tool switches.
 * @param {(change: { directory: string }) => void} [deps.onChanged]  After an update, so the host can announce `plugin.updated`.
 */
export const createPluginBridgeRoutes = ({
  packages,
  getDefaultDirectory,
  readSettings = async () => null,
  onChanged = () => {},
}) => {
  const inventory = async (directory, outdatedIds = new Set()) => {
    const [listing, settings] = await Promise.all([
      packages.list({ directory }),
      Promise.resolve(readSettings()).catch(() => null),
    ]);
    return toInventory(listing, directory, outdatedIds, describeManagedExtensions(managedToolFlags(settings)));
  };

  return [
    {
      method: 'GET',
      path: '/api/plugin',
      handler: async (ctx) => {
        const { directory } = resolveLocation(ctx, { getDefaultDirectory });
        return json({ location: { directory }, data: await inventory(directory) });
      },
    },
    {
      method: 'POST',
      path: '/api/plugin/check',
      handler: async (ctx) => {
        const { directory } = resolveLocation(ctx, { getDefaultDirectory });
        const body = await ctx.body();
        if (body.target !== undefined && typeof body.target !== 'string') {
          throw invalidRequest('target must be a package target', { kind: 'Payload', field: 'target' });
        }
        let checked;
        try {
          checked = await packages.check({ directory, ...(body.target ? { sources: [body.target] } : {}) });
        } catch (error) {
          throw toWireError(error);
        }
        // A package whose registry answer failed keeps no flag: the inventory never says "up to date" for it.
        const outdated = new Set(checked.filter((result) => result.outdated).map((result) => result.id));
        return json({ location: { directory }, data: await inventory(directory, outdated) });
      },
    },
    {
      method: 'POST',
      path: '/api/plugin/update',
      handler: async (ctx) => {
        const { directory } = resolveLocation(ctx, { getDefaultDirectory });
        const body = await ctx.body();
        if (!Array.isArray(body.targets) || body.targets.length === 0 || !body.targets.every((target) => typeof target === 'string' && target)) {
          throw invalidRequest('targets must be a non-empty list of package targets', { kind: 'Payload', field: 'targets' });
        }
        try {
          await packages.updateTargets({ targets: body.targets, directory });
        } catch (error) {
          throw toWireError(error);
        }
        onChanged({ directory });
        return noContent();
      },
    },
  ];
};
