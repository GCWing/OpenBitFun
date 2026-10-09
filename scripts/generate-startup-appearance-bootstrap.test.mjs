import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { createStartupAppearanceViteConfig } from './startup-appearance-vite-config.mjs';

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('startup appearance bootstrap check is stable across line endings', () => {
  const generatorSource = readText('scripts/generate-startup-appearance-bootstrap.mjs');

  assert.match(generatorSource, /normalizeGeneratedText/, 'generator check should normalize line endings');
  assert.match(
    generatorSource,
    /replace\(?\/\\r\\n\?\/g,\s*'\\n'\)?/,
    'generator check should normalize CRLF and CR line endings to LF',
  );
  assert.match(
    generatorSource,
    /currentContentForCheck/,
    'generator check should compare normalized current content',
  );
});

test('startup appearance generation uses its isolated SSR config', () => {
  const generatorSource = readText('scripts/generate-startup-appearance-bootstrap.mjs');

  assert.match(
    generatorSource,
    /createServer\(createStartupAppearanceViteConfig\(webUiRoot\)\)/,
    'the generator must not inherit product dev configuration',
  );
});

test('the real generator server leaves product config and optimized dependencies untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-appearance-vite-'));
  const depsDir = path.join(root, 'node_modules/.vite/deps');
  fs.mkdirSync(depsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  // Loading the product config is a regression even if this invocation happens
  // to use the same hash. A generator must never initialize its client plugins.
  fs.writeFileSync(path.join(root, 'vite.config.mjs'), 'throw new Error("Product config must not run");');
  const sentinel = path.join(depsDir, 'react-virtuoso.js');
  fs.writeFileSync(sentinel, 'export const version = "live-dev";');
  fs.writeFileSync(path.join(root, 'src/palette.ts'), 'export const color: string = "palette";');
  fs.writeFileSync(path.join(root, 'src/entry.ts'), 'export { color } from "@/palette";');
  let server;
  try {
    server = await createServer(createStartupAppearanceViteConfig(root));
    assert.equal(server.config.configFile, undefined);
    assert.equal(server.config.server.hmr, false);
    assert.equal(server.config.server.middlewareMode, true);
    assert.equal(server.config.optimizeDeps.noDiscovery, true);
    assert.deepEqual(server.config.optimizeDeps.include, []);
    assert.notEqual(server.config.cacheDir, path.dirname(depsDir).replaceAll('\\', '/'));
    assert.equal((await server.ssrLoadModule('/src/entry.ts')).color, 'palette');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'export const version = "live-dev";');
  } finally {
    await server?.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
