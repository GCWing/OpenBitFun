import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { syncWorkPlugin } from './sync-work-diagnostic.mjs';

const root = fileURLToPath(new URL('../../../src/web-ui/', import.meta.url));
const outDir = process.env.OPENBITFUN_SYNC_DIAGNOSTIC_BUILD;
assert.ok(outDir && path.isAbsolute(outDir), 'Set a new absolute diagnostic output directory');
await access(outDir).then(() => { throw new Error('Diagnostic output must not already exist'); }, error => {
  if (error.code !== 'ENOENT') throw error;
});
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')));
await build({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'production',
  plugins: [syncWorkPlugin()], build: { outDir, emptyOutDir: false } });
