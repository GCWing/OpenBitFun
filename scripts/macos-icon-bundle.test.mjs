import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { COMPOSER_ICON, ROOT, macosSourceDigest, readMacosFallback } from './macos-icon-assets.mjs';
import { requireModernIconTools, verifyMacosIconBundle } from './macos-icon-bundle.mjs';
import { prepareTauriConfig } from './desktop-tauri-build.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', windowsHide: true, ...options,
});

test('macOS uses a full-bleed Composer source and a current independent legacy export', async () => {
  const source = json(join(COMPOSER_ICON, 'icon.json'));
  assert.deepEqual(source['supported-platforms'], { squares: ['macOS'] });
  assert.equal(source.fill.solid, 'srgb:0.00000,0.00000,0.00000,1.00000');
  const mark = await sharp(join(COMPOSER_ICON, 'Assets/Mark.png')).metadata();
  assert.equal(mark.width, 1024);
  assert.equal(mark.height, 1024);
  assert.equal(mark.hasAlpha, true);
  assert.ok(readMacosFallback().length > 0);
  assert.equal(json(join(ROOT, 'assets/brand/macos/generated.json')).sourceSha256, macosSourceDigest());
});

test('CLI is locked and macOS overlays preserve the same dev/legacy icon', () => {
  for (const packagePath of ['package.json', 'OpenBitFun-Installer/package.json']) {
    assert.equal(json(join(ROOT, packagePath)).devDependencies['@tauri-apps/cli'], '2.11.4');
  }
  for (const app of ['src/apps/desktop', 'OpenBitFun-Installer/src-tauri']) {
    const directory = join(ROOT, app);
    const base = json(join(directory, 'tauri.conf.json'));
    const mac = json(join(directory, 'tauri.macos.conf.json'));
    assert.deepEqual(mac.bundle.icon.filter(icon => !icon.endsWith('.icon')), base.bundle.icon);
    assert.equal(resolve(directory, mac.bundle.icon.find(icon => icon.endsWith('.icon'))), COMPOSER_ICON);
    assert.match(mac.build.beforeBundleCommand, /check:macos-icons/);
  }
  assert.equal(json(join(ROOT, 'src/apps/desktop/tauri.dev.conf.json')).bundle.icon, undefined);
});

test('generated release config cannot overwrite platform icon selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbitfun-icon-config-'));
  const updaterEnabled = process.env.OPENBITFUN_ENABLE_UPDATER_ARTIFACTS;
  process.env.OPENBITFUN_ENABLE_UPDATER_ARTIFACTS = 'false';
  try {
    const configPath = join(directory, 'tauri.conf.json');
    writeFileSync(configPath, JSON.stringify({ bundle: { icon: ['legacy.icns', 'windows.ico'] } }));
    const generated = prepareTauriConfig(configPath, { desktopDir: directory });
    assert.equal(json(generated).bundle.icon, undefined);
  } finally {
    if (updaterEnabled === undefined) delete process.env.OPENBITFUN_ENABLE_UPDATER_ARTIFACTS;
    else process.env.OPENBITFUN_ENABLE_UPDATER_ARTIFACTS = updaterEnabled;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing, old, and unparseable actool fail instead of silently dropping modern icons', () => {
  assert.throws(() => requireModernIconTools(() => { throw new Error('not found'); }), /full Xcode 26/);
  for (const output of ['short-bundle-version: 16.4', 'bundle-version: 24411']) {
    assert.throws(() => requireModernIconTools(() => output), /refusing to silently omit/);
  }
  for (const version of ['26.2', '27.0']) {
    const calls = [];
    requireModernIconTools((command, args) => {
      calls.push([command, args]);
      return `/* com.apple.actool.version */\nshort-bundle-version: ${version}\n`;
    });
    assert.deepEqual(calls[1], ['xcrun', ['--find', 'assetutil']]);
  }
});

test('bundle validation rejects a missing catalog, wrong icon name, and mismatched fallback', () => {
  const app = mkdtempSync(join(tmpdir(), 'openbitfun-icon-validation-'));
  const resources = join(app, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  let plist = { CFBundleIconName: 'Icon', CFBundleIconFile: 'app.icns' };
  let assets = [{ AssetType: 'Icon Image', Name: 'Icon' }];
  const execute = command => JSON.stringify(command.endsWith('plutil') ? plist : assets);
  const fallback = Buffer.from('fixture legacy data');
  const verify = () => verifyMacosIconBundle(app, { execute, fallback });
  try {
    assert.throws(verify, /ENOENT/);
    writeFileSync(join(resources, 'Assets.car'), 'fixture catalog');
    writeFileSync(join(resources, 'app.icns'), fallback);
    verify();
    assets = [{ AssetType: 'Image', Name: 'Icon' }];
    assert.throws(verify, /no Icon Image/);
    assets = [{ AssetType: 'Icon Image', Name: 'WrongName' }];
    assert.throws(verify, /no Icon Image/);
    assets = [{ AssetType: 'Icon Image', Name: 'Icon' }];
    writeFileSync(join(resources, 'app.icns'), 'wrong fallback');
    assert.throws(verify, /differs/);
    plist = { CFBundleIconFile: 'app.icns' };
    assert.throws(verify, /both CFBundleIconName/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('Apple iconutil decodes all ten legacy/Retina representations with Dock margins', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbitfun-icon-decode-'));
  try {
    const iconset = join(directory, 'fallback.iconset');
    run('/usr/bin/iconutil', ['--convert', 'iconset', '--output', iconset,
      join(ROOT, 'assets/brand/exports/openbitfun-app-icon.icns')]);
    const files = readdirSync(iconset).filter(file => file.endsWith('.png'));
    assert.equal(files.length, 10);
    for (const file of files) {
      const { data, info } = await sharp(join(iconset, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const size = info.width;
      assert.equal(info.height, size);
      let first = -1;
      let last = -1;
      for (let x = 0; x < size; x++) {
        assert.equal(data[x * 4 + 3], 0, `${file} top margin`);
        if (data[(Math.floor(size / 2) * size + x) * 4 + 3] >= 128) {
          if (first < 0) first = x;
          last = x;
        }
      }
      assert.ok(first >= size * 0.07 && first <= size * 0.14, `${file} body size`);
      assert.ok(Math.abs(first - (size - 1 - last)) <= 1, `${file} centered body`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function bundleFixture(modern) {
  const directory = mkdtempSync(join(tmpdir(), 'openbitfun-icon-bundle-'));
  try {
    for (const name of ['src', 'frontend', 'target/release']) mkdirSync(join(directory, name), { recursive: true });
    writeFileSync(join(directory, 'src/main.rs'), 'fn main() {}');
    writeFileSync(join(directory, 'frontend/index.html'), '<html></html>');
    writeFileSync(join(directory, 'Cargo.toml'), '[package]\nname="icon-probe"\nversion="0.1.0"\nedition="2021"\n');
    // Bundle a real Mach-O without building/launching the application. This
    // exercises the locked Tauri bundler and Apple asset tools, not Dock UI.
    copyFileSync('/usr/bin/true', join(directory, 'target/release/icon-probe'));
    const desktop = join(ROOT, 'src/apps/desktop');
    const selected = json(join(desktop, modern ? 'tauri.macos.conf.json' : 'tauri.conf.json'));
    writeFileSync(join(directory, 'tauri.conf.json'), JSON.stringify({
      productName: 'Icon Probe', version: '0.1.0', identifier: 'com.openbitfun.iconprobe',
      build: { frontendDist: 'frontend' },
      bundle: { active: true, targets: ['app'], icon: selected.bundle.icon.map(icon => resolve(desktop, icon)) },
    }));
    const env = { ...process.env, CI: 'true', CARGO_TARGET_DIR: join(directory, 'target') };
    // Release runners have signing/notarization credentials. Disposable icon
    // fixtures must never submit to Apple's notary service or use those keys.
    for (const key of Object.keys(env)) {
      if (key.startsWith('APPLE_') || key.startsWith('TAURI_SIGNING_')) delete env[key];
    }
    delete env.TAURI_CONFIG;
    delete env.CARGO_BUILD_TARGET;
    run(process.execPath, [join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--bundles', 'app'], { cwd: directory, env });
    const app = join(directory, 'target/release/bundle/macos/Icon Probe.app');
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]));
    assert.deepEqual(readFileSync(join(app, 'Contents/Resources', plist.CFBundleIconFile)), readMacosFallback());
    if (modern) verifyMacosIconBundle(app);
    else assert.equal(existsSync(join(app, 'Contents/Resources/Assets.car')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('locked Tauri CLI bundles the legacy ICNS without modifying it', {
  skip: process.platform !== 'darwin',
}, () => bundleFixture(false));

test('locked Tauri CLI compiles the modern source and emits both Info.plist icon keys', {
  skip: process.platform !== 'darwin' || process.env.OPENBITFUN_TEST_MACOS_BUNDLE !== '1'
    ? 'Requires full Xcode; enabled explicitly on both macOS packaging runners.' : false,
}, () => {
  requireModernIconTools();
  bundleFixture(true);
});
