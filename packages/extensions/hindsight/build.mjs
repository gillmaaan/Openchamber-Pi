import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGuestPackage } from '../../web/server/lib/guests/catalog.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const destination = path.join(root, 'dist');
await fs.mkdir(destination, { recursive: true });
for (const [entry, target] of [['panel', 'browser'], ['service', 'node']]) {
  const result = await Bun.build({
    entrypoints: [path.join(root, `${entry}.ts`)], target, format: target === 'browser' ? 'iife' : 'esm',
    minify: target === 'browser', sourcemap: 'none', env: 'disable', write: false,
    plugins: [{ name: 'sdk-source', setup(build) {
      build.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path: name }) => ({ path: fileURLToPath(new URL(name.endsWith('/ui') ? '../../sdk/src/ui/index.ts' : '../../sdk/src/index.ts', import.meta.url)) }));
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new Error('Extension bundle failed');
  await fs.writeFile(path.join(destination, `${entry}.js`), new Uint8Array(await result.outputs[0].arrayBuffer()));
}
await fs.copyFile(path.join(root, 'package.json'), path.join(destination, 'package.json'));
await fs.copyFile(path.join(root, 'panel.html'), path.join(destination, 'panel.html'));
const inspected = await inspectGuestPackage(destination, { openchamberVersion: '2.7.0' });
if (!inspected.ok) throw new Error('Extension package validation failed');
console.log(destination);
