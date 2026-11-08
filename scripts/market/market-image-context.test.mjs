import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(repoRoot, relativePath));

// Both markets build from the repo root with a per-Dockerfile ignore file, so
// the build context is a hand-maintained whitelist. Anything the Dockerfile
// copies must be allowlisted there, otherwise the COPY resolves to nothing.
const marketImages = [
  {
    name: 'miniapp',
    dockerfile: 'src/apps/miniapp-market-server/Dockerfile',
    ignoreFile: 'src/apps/miniapp-market-server/Dockerfile.dockerignore',
  },
  {
    name: 'skin',
    dockerfile: 'src/apps/skin-market-server/Dockerfile',
    ignoreFile: 'src/apps/skin-market-server/Dockerfile.dockerignore',
  },
];

function patchSectionPaths(cargoToml) {
  const lines = cargoToml.split('\n');
  const start = lines.findIndex((line) => /^\[patch\.crates-io\]\s*$/.test(line.trim()));
  assert.ok(start >= 0, 'Cargo.toml is expected to declare [patch.crates-io]');

  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(trimmed);
    if (match) paths.push(match[1].replace(/\/+$/, ''));
  }
  return paths;
}

function copiedPaths(dockerfile) {
  return dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
    .map((line) => line.slice('COPY '.length).trim().split(/\s+/)[0])
    .filter((source) => source !== '.');
}

function allowsDirectory(ignore, directory) {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^!${escaped}/(?:\\*\\*)?$`, 'm').test(ignore);
}

test('vendored crate patches ship with the market build contexts', () => {
  const patched = patchSectionPaths(read('Cargo.toml'));
  assert.ok(patched.length > 0, 'expected at least one patched path dependency');

  for (const image of marketImages) {
    const dockerfile = read(image.dockerfile);
    const ignore = read(image.ignoreFile);

    for (const cratePath of patched) {
      assert.ok(
        exists(cratePath),
        `${cratePath} is referenced by [patch.crates-io] but missing from the checkout`,
      );
      assert.match(
        dockerfile,
        new RegExp(`^COPY ${cratePath}/ ${cratePath}/$`, 'm'),
        `${image.name} image must COPY ${cratePath}/; Cargo resolves [patch.crates-io] paths even for a service-only build`,
      );
      assert.ok(
        allowsDirectory(ignore, cratePath),
        `${image.name} build context must allowlist ${cratePath}/`,
      );
    }
  }
});

test('every third_party COPY source is allowlisted in its build context', () => {
  for (const image of marketImages) {
    const ignore = read(image.ignoreFile);
    const sources = copiedPaths(read(image.dockerfile)).filter((source) =>
      source.startsWith('third_party/'),
    );
    assert.ok(sources.length > 0, `${image.name} Dockerfile should copy third_party sources`);

    for (const source of sources) {
      const directory = source.replace(/\/+$/, '');
      assert.ok(
        allowsDirectory(ignore, directory),
        `${image.name} build context must allowlist ${directory}/`,
      );
    }
  }
});

test('committed builtin assets survive the dist pruning rules', () => {
  // `product-domains` include_str!s this bundle, and it lives under a `dist`
  // directory, which the market context otherwise prunes wholesale.
  const bundle =
    'src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/dist/ui.bundle.js';
  assert.ok(exists(bundle), `${bundle} is committed and must stay in the tree`);

  for (const image of marketImages) {
    const ignore = read(image.ignoreFile);
    assert.match(
      ignore,
      /^\*\*\/dist$/m,
      `${image.name} build context is expected to prune dist directories`,
    );
    assert.match(
      ignore,
      new RegExp(`^!${bundle}$`, 'm'),
      `${image.name} build context must re-allowlist ${bundle}`,
    );
  }
});
