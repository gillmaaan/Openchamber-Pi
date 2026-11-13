import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ElectronSshManager } from './ssh-manager.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const BUNDLE = { version: '2.7.0', buildId: 'abc123def4567890' };

const setup = ({ marker = null, binaryPresent = 'yes', npm = '/usr/bin/npm' } = {}) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-ssh-bundled-'));
  roots.push(root);
  const tarballPath = path.join(root, 'openchamber-web.tgz');
  const vendorPath = path.join(root, 'vendor', 'openchamber-sdk.tgz');
  fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
  fs.writeFileSync(tarballPath, 'tarball');
  fs.writeFileSync(vendorPath, 'vendor');

  const manager = new ElectronSshManager({
    settingsFilePath: path.join(root, 'settings.json'),
    appVersion: BUNDLE.version,
    emit: () => {},
    createBundledWebTarball: async () => ({ tarballPath, vendorPath, ...BUNDLE }),
  });
  const commands = [];
  const uploads = [];
  manager.appendLogWithLevel = () => {};
  manager.resolveRemoteTool = async () => npm;
  manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
    commands.push(script);
    if (script === 'printf %s "$HOME"') return '/home/remote';
    if (script.startsWith('cat ') && script.includes('bundled-web.json')) return marker ? JSON.stringify(marker) : '';
    if (script.includes('[ -x ')) return binaryPresent;
    return '';
  };
  manager.uploadFileOverSsh = async (_parsed, _controlPath, localPath, remotePath) => {
    uploads.push({ localPath, remotePath });
  };
  return { manager, commands, uploads };
};

describe('the bundled remote install', () => {
  test('uploads this app\'s package and its vendored SDK, installs them, and writes the build marker', async () => {
    const { manager, commands, uploads } = setup();
    const { binPath, reinstalled } = await manager.ensureBundledWebInstall({}, '/tmp/control.sock');
    expect(reinstalled).toBe(true);

    expect(binPath).toBe('/home/remote/.openchamber/npm-global/bin/openchamber');
    expect(uploads.map((entry) => entry.remotePath)).toEqual([
      `/home/remote/.openchamber/npm-global/.bundled-web-${BUNDLE.buildId}/openchamber-web-${BUNDLE.buildId}.tgz`,
      `/home/remote/.openchamber/npm-global/.bundled-web-${BUNDLE.buildId}/vendor/openchamber-sdk.tgz`,
    ]);
    const install = commands.find((command) => command.includes('install -g'));
    expect(install).toContain("--prefix '/home/remote/.openchamber/npm-global'");
    expect(install).toContain(`openchamber-web-${BUNDLE.buildId}.tgz`);
    expect(install).toContain('bundled-web.json');
    expect(install).toContain(BUNDLE.buildId);
    expect(install).toContain(`.bundled-web-${BUNDLE.buildId}`);
    expect(install).toContain('rm -rf');
  });

  test('installs nothing when the marker and the binary say this build is already there', async () => {
    const { manager, commands, uploads } = setup({ marker: BUNDLE });
    expect(await manager.ensureBundledWebInstall({}, '/tmp/control.sock')).toEqual({ binPath: '/home/remote/.openchamber/npm-global/bin/openchamber', reinstalled: false });
    expect(uploads).toEqual([]);
    expect(commands.some((command) => command.includes('install -g'))).toBe(false);
  });

  test('reinstalls when the marker names another build', async () => {
    const { manager, commands } = setup({ marker: { version: BUNDLE.version, buildId: 'anotherbuild0000' } });
    await manager.ensureBundledWebInstall({}, '/tmp/control.sock');
    expect(commands.some((command) => command.includes('install -g'))).toBe(true);
  });

  test('reports a host without npm instead of falling back to the registry', async () => {
    const { manager } = setup({ npm: null });
    await expect(manager.ensureBundledWebInstall({}, '/tmp/control.sock')).rejects.toThrow('no npm');
  });

  test('uses the registry install only when this build cannot stage its own package', async () => {
    const { manager, commands } = setup();
    manager.createBundledWebTarball = null;
    expect(await manager.ensureBundledWebInstall({}, '/tmp/control.sock')).toBeNull();
    expect(commands).toEqual([]);
  });
});
