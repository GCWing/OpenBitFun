import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDshProfileRebuildPlan } from './prepare-dsh-profile.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createPackageTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-dsh-profile-'));
  const packageDir = path.join(root, 'packages', 'dsh-acp');
  const outDir = path.join(packageDir, 'dist-profile');
  const prepareScriptPath = path.join(root, 'scripts', 'prepare-dsh-profile.mjs');

  mkdirSync(path.join(packageDir, 'src'), { recursive: true });
  mkdirSync(path.join(packageDir, 'presets'), { recursive: true });
  mkdirSync(path.join(packageDir, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(path.join(packageDir, 'src', 'app.ts'), 'export {}\n');
  writeFileSync(path.join(packageDir, 'presets', 'preset.yml'), 'name: test\n');
  writeFileSync(path.join(packageDir, 'cordis.yml'), 'name: test\n');
  writeFileSync(path.join(packageDir, 'package.json'), '{}\n');
  writeFileSync(path.join(packageDir, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(packageDir, 'tsconfig.build.json'), '{}\n');
  writeFileSync(path.join(packageDir, 'scripts', 'build-profile.mjs'), 'export {}\n');
  writeFileSync(prepareScriptPath, 'export {}\n');

  return { root, packageDir, outDir, prepareScriptPath };
}

function writeStamp(outDir, stamp = { profile: 'openbitfun-acp', content: 'abc' }) {
  const stampPath = path.join(outDir, '.openbitfun-bridge.json');
  writeFileSync(stampPath, `${JSON.stringify(stamp)}\n`);
  return stampPath;
}

function setMtime(filePath, mtimeMs) {
  const atime = new Date(mtimeMs);
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, atime, mtime);
}

test('rebuilds when the profile stamp is missing', () => {
  const { root, packageDir, outDir, prepareScriptPath } = createPackageTree();
  try {
    const plan = getDshProfileRebuildPlan({ packageDir, outDir, prepareScriptPath });
    assert.equal(plan.shouldBuild, true);
    assert.match(plan.reason, /stamp is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rebuilds when force is requested', () => {
  const { root, packageDir, outDir, prepareScriptPath } = createPackageTree();
  try {
    const stampPath = writeStamp(outDir);
    setMtime(stampPath, Date.now() + 60_000);
    const plan = getDshProfileRebuildPlan({
      packageDir,
      outDir,
      prepareScriptPath,
      force: true,
    });
    assert.equal(plan.shouldBuild, true);
    assert.match(plan.reason, /Force rebuild/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rebuilds when the stamp is incomplete', () => {
  const { root, packageDir, outDir, prepareScriptPath } = createPackageTree();
  try {
    writeStamp(outDir, { profile: 'openbitfun-acp' });
    const plan = getDshProfileRebuildPlan({ packageDir, outDir, prepareScriptPath });
    assert.equal(plan.shouldBuild, true);
    assert.match(plan.reason, /incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rebuilds when an input is newer than the stamp', () => {
  const { root, packageDir, outDir, prepareScriptPath } = createPackageTree();
  try {
    const stampPath = writeStamp(outDir);
    const older = Date.now() - 60_000;
    const newer = Date.now();
    for (const filePath of [
      path.join(packageDir, 'src', 'app.ts'),
      path.join(packageDir, 'presets', 'preset.yml'),
      path.join(packageDir, 'cordis.yml'),
      path.join(packageDir, 'package.json'),
      path.join(packageDir, 'package-lock.json'),
      path.join(packageDir, 'tsconfig.build.json'),
      path.join(packageDir, 'scripts', 'build-profile.mjs'),
      prepareScriptPath,
      stampPath,
    ]) {
      setMtime(filePath, older);
    }
    setMtime(path.join(packageDir, 'src', 'app.ts'), newer);
    const plan = getDshProfileRebuildPlan({ packageDir, outDir, prepareScriptPath });
    assert.equal(plan.shouldBuild, true);
    assert.match(plan.reason, /inputs changed/);
    assert.match(plan.reason, /app\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips when a complete stamp is newer than every input', () => {
  const { root, packageDir, outDir, prepareScriptPath } = createPackageTree();
  try {
    const older = Date.now() - 60_000;
    const newer = Date.now();
    for (const filePath of [
      path.join(packageDir, 'src', 'app.ts'),
      path.join(packageDir, 'presets', 'preset.yml'),
      path.join(packageDir, 'cordis.yml'),
      path.join(packageDir, 'package.json'),
      path.join(packageDir, 'package-lock.json'),
      path.join(packageDir, 'tsconfig.build.json'),
      path.join(packageDir, 'scripts', 'build-profile.mjs'),
      prepareScriptPath,
    ]) {
      setMtime(filePath, older);
    }
    const stampPath = writeStamp(outDir);
    setMtime(stampPath, newer);
    const plan = getDshProfileRebuildPlan({ packageDir, outDir, prepareScriptPath });
    assert.equal(plan.shouldBuild, false);
    assert.match(plan.reason, /up to date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop:dev does not compile the DeepSeek profile', () => {
  const devScript = readFileSync(path.join(repoRoot, 'scripts', 'dev.cjs'), 'utf8');
  assert.doesNotMatch(devScript, /runCommandPrefixed\('dsh-profile'/);
  assert.doesNotMatch(devScript, /\['run', 'prepare:dsh-profile'\]/);
  assert.match(
    devScript,
    /Prepare resources \(mobile-web first; then parallel: monaco, version, flashgrep, plugin-host\)/,
  );
});

test('desktop clippy does not compile the DeepSeek profile', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.doesNotMatch(packageJson.scripts['lint:rs:desktop'], /prepare:dsh-profile/);
});

test('official frontend packaging still compiles the DeepSeek profile', () => {
  const frontendBuildAll = readFileSync(
    path.join(repoRoot, 'scripts', 'frontend-build-all.mjs'),
    'utf8',
  );
  assert.match(frontendBuildAll, /prepare:dsh-profile/);
});
