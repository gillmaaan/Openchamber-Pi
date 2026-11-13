import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createBundledWebTarball, packTarball } from './bundled-web-package.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const makeTree = () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-bundled-web-'));
  roots.push(root);
  const web = path.join(root, 'web');
  const sdk = path.join(root, 'sdk');
  const dist = path.join(root, 'web-dist');
  fs.mkdirSync(path.join(web, 'server'), { recursive: true });
  fs.mkdirSync(path.join(web, 'bin'), { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({
    name: '@openchamber/web',
    version: '9.9.9',
    type: 'module',
    main: './server/index.js',
    bin: { openchamber: './bin/cli.js' },
    dependencies: { '@openchamber/sdk': 'workspace:*', zod: '^4.0.0' },
  }));
  fs.writeFileSync(path.join(web, 'server', 'index.js'), 'export default 1\n');
  fs.writeFileSync(path.join(web, 'bin', 'cli.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(web, 'bin', 'cli.js'), 0o755);
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@openchamber/sdk', version: '9.9.9', exports: { './ui': './dist/ui.js' } }));
  fs.writeFileSync(path.join(sdk, 'dist', 'index.js'), 'export const sdk = 1\n');
  fs.writeFileSync(path.join(sdk, 'README.md'), 'sdk\n');
  fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>\n');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)\n');
  return { root, web, sdk, dist };
};

const entries = (tarballPath) => zlib.gunzipSync(fs.readFileSync(tarballPath)).toString('latin1');

describe('the bundled web package', () => {
  test('stages the package, its UI build and a vendored SDK for a remote install', () => {
    const { root, web, sdk, dist } = makeTree();
    const result = createBundledWebTarball({ webPackageDir: web, sdkPackageDir: sdk, distDir: dist, workDir: path.join(root, 'work') });

    expect(result.version).toBe('9.9.9');
    expect(result.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.existsSync(result.tarballPath)).toBe(true);
    expect(fs.existsSync(result.vendorPath)).toBe(true);

    const outer = entries(result.tarballPath);
    expect(outer).toContain('package/package.json');
    expect(outer).toContain('package/server/index.js');
    expect(outer).toContain('package/bin/cli.js');
    expect(outer).toContain('package/dist/index.html');
    expect(outer).toContain('package/dist/assets/app.js');
    expect(outer).toContain('file:vendor/openchamber-sdk.tgz');
    expect(outer).toContain('@openchamber/sdk');

    const inner = entries(result.vendorPath);
    expect(inner).toContain('package/package.json');
    expect(inner).toContain('package/dist/index.js');
  });

  test('refuses a folder that is not the web package, and a missing UI build', () => {
    const { root, web, sdk, dist } = makeTree();
    expect(() => createBundledWebTarball({ webPackageDir: sdk, sdkPackageDir: sdk, distDir: dist, workDir: path.join(root, 'w1') })).toThrow('Not an @openchamber/web package');
    expect(() => createBundledWebTarball({ webPackageDir: web, sdkPackageDir: web, distDir: dist, workDir: path.join(root, 'w2') })).toThrow('Not an @openchamber/sdk package');
    expect(() => createBundledWebTarball({ webPackageDir: web, sdkPackageDir: sdk, distDir: path.join(root, 'missing'), workDir: path.join(root, 'w3') })).toThrow('UI build is missing');
  });

  test('writes tar headers a tar reader can take apart', () => {
    const packed = packTarball([
      { name: 'package/', directory: true },
      { name: 'package/a.txt', content: Buffer.from('hello') },
    ]);
    const raw = zlib.gunzipSync(packed);
    expect(raw.subarray(0, 8).toString()).toBe('package/');
    expect(raw[156]).toBe('5'.charCodeAt(0));
    expect(raw.subarray(512, 521).toString()).toBe('package/a');
    expect(raw[512 + 156]).toBe('0'.charCodeAt(0));
    expect(raw.subarray(512 + 512, 512 + 517).toString()).toBe('hello');
  });
});
