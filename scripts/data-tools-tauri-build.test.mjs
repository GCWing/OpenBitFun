import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareDataToolsTauriConfig, dataToolsEnvironment } from './data-tools-tauri-build.mjs';
import { releaseVersion, validateReleaseTag, stage, PLATFORMS } from './data-tools-release.mjs';
import { prepareTauriConfig } from './desktop-tauri-build.mjs';
const ROOT = resolve(import.meta.dirname, '..');
const APP = join(ROOT, 'src/apps/data-tools');
const TEMP_ROOT = tmpdir();

function fixtureDirectory(t) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = mkdtempSync(join(TEMP_ROOT, 'data-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('independent bundle owns version, offline assets, icons and identity', (t) => {
  const output = prepareDataToolsTauriConfig(join(APP, 'tauri.conf.json'), fixtureDirectory(t));
  const config = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(config.productName, 'OpenBitFun Data Tools');
  assert.equal(config.identifier, 'com.openbitfun.data-tools');
  assert.deepEqual(config.app.windows.map(({ label }) => label), ['data-tools']);
  const capability = JSON.parse(readFileSync(join(APP, 'capabilities/data-tools.json'), 'utf8'));
  assert.equal(capability.identifier, 'data-tools');
  assert.deepEqual(capability.windows, ['data-tools']);
  assert.equal(config.mainBinaryName, 'openbitfun-data-tools');
  assert.equal(config.version, releaseVersion());
  assert.deepEqual(config.build, { frontendDist: 'ui' });
  assert.equal(config.plugins?.updater, undefined);
  assert.equal(config.bundle.externalBin, undefined);
  assert.ok(config.bundle.icon.every((icon) => !icon.includes('desktop') && existsSync(join(APP, icon))));
  assert.ok(config.app.security.csp.includes("connect-src 'self'"));
});

test('a Desktop product environment cannot change the migration destination identity', () => {
  const env = dataToolsEnvironment({ OPENBITFUN_PRODUCT_ID: 'acme', OPENBITFUN_DATA_NAMESPACE: 'acme', OPENBITFUN_DESKTOP_BINARY_NAME: 'acme', CI: '1' });
  assert.equal(env.OPENBITFUN_PRODUCT_ID, 'openbitfun');
  assert.equal(env.OPENBITFUN_DATA_NAMESPACE, 'openbitfun');
  assert.equal(env.OPENBITFUN_DESKTOP_BINARY_NAME, undefined);
  assert.equal(env.OPENBITFUN_PRODUCT_BINARY_NAME, 'openbitfun-data-tools');
  assert.equal(env.OPENBITFUN_PRODUCT_DISPLAY_NAME, 'OpenBitFun Data Tools');
  assert.equal(env.CI, 'true');
});

test('Desktop package generation has no Data Tools payload or build hook', () => {
  const desktop = join(ROOT, 'src/apps/desktop');
  const output = prepareTauriConfig(join(desktop, 'tauri.conf.json'), { desktopDir: desktop });
  const config = JSON.parse(readFileSync(output, 'utf8'));
  assert.ok(!(config.bundle.externalBin || []).some((file) => /data-migrator|data-tools/.test(file)));
  for (const file of ['scripts/dev.cjs', 'scripts/desktop-tauri-build.mjs', 'src/apps/desktop/src/lib.rs']) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /data-migrator|data-tools|legacy_migration_api/);
  }
});

test('Data Tools dependency and command closure exclude the main app and restart handshake', () => {
  const manifest = readFileSync(join(APP, 'Cargo.toml'), 'utf8');
  assert.doesNotMatch(manifest, /^openbitfun-core\s*=|product-full|product-capabilities|plugin-runtime/m);
  const source = readFileSync(join(APP, 'src/app_state.rs'), 'utf8');
  assert.doesNotMatch(source, /HandoffStore|MigrationOnboardingStore|restart_desktop|TrustedInstallationResolver/);
  const capability = readFileSync(join(APP, 'capabilities/data-tools.json'), 'utf8');
  assert.doesNotMatch(capability, /fs:|shell:|updater:|dialog:/);
});

test('independent release tags cannot be confused with main app versions', () => {
  const version = releaseVersion();
  assert.doesNotThrow(() => validateReleaseTag('data-tools-v' + version, version));
  assert.doesNotThrow(() => validateReleaseTag('data-migrator-v' + version, version));
  assert.throws(() => validateReleaseTag('v' + version, version));
  assert.throws(() => validateReleaseTag('data-tools-v9.0.0', version));
});

test('all static UI labels and locale keys have complete translations', () => {
  const html = readFileSync(join(APP, 'ui/index.html'), 'utf8');
  const locales = JSON.parse(readFileSync(join(APP, 'ui/locales.json'), 'utf8'));
  const keys = Object.keys(locales.en).sort();
  for (const labels of Object.values(locales)) {
    assert.deepEqual(Object.keys(labels).sort(), keys);
    for (const match of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) assert.ok(labels[match[1]], match[1]);
  }
});

for (const [platform, metadata] of Object.entries(PLATFORMS)) {
  test(`release staging uses Data Tools names and checksums on ${platform}`, {
    skip: platform === 'windows-x64' && process.platform !== 'win32',
  }, (t) => {
    const root = fixtureDirectory(t);
    const app = join(root, 'src/apps/data-tools');
    mkdirSync(app, { recursive: true });
    const version = releaseVersion();
    writeFileSync(join(app, 'Cargo.toml'), `version = "${version}"\n`);
    writeFileSync(join(app, 'tauri.conf.json'), JSON.stringify({ version }));
    const target = join(root, 'custom-target', metadata.target, 'release');
    if (platform === 'windows-x64') {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'openbitfun-data-tools.exe'), 'fixture executable');
      for (const file of ['README.md', 'README.zh-CN.md']) writeFileSync(join(app, file), 'fixture guide');
      writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'fixture notices');
    } else {
      const bundle = join(target, 'bundle', metadata.folder);
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, `OpenBitFun Data Tools_${version}_arch.${metadata.extension}`), 'fixture package');
      writeFileSync(join(bundle, `Other App_${version}_arch.${metadata.extension}`), 'unrelated package');
    }
    const output = stage(platform, { root, environment: {
      CARGO_TARGET_DIR: 'custom-target', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `data-tools-v${version}`,
    } });
    const asset = `openbitfun-data-tools-v${version}-${platform}.${metadata.extension}`;
    assert.equal(output, join(root, 'target/data-tools-release', platform, asset));
    const hash = createHash('sha256').update(readFileSync(output)).digest('hex');
    assert.equal(readFileSync(`${output}.sha256`, 'utf8'), `${hash}  ${asset}\n`);
    if (platform === 'windows-x64') {
      const listing = spawnSync('tar', ['-tf', output], { encoding: 'utf8', windowsHide: true });
      assert.equal(listing.status, 0, listing.stderr);
      assert.deepEqual(listing.stdout.trim().split(/\r?\n/).sort(), [
        'openbitfun-data-tools.exe', 'README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md',
      ].sort());
    } else assert.equal(readFileSync(output, 'utf8'), 'fixture package');
  });
}
