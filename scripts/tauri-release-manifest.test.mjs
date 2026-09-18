import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('release version metadata is synchronized', () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const result = run('scripts/verify-release-version-sync.mjs', ['--version', version]);
  assert.equal(result.status, 0, result.stderr);
});

test('prepares a versioned custom Windows installer asset', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-manual-installer-'));
  const assets = path.join(temp, 'assets', 'nested');
  const out = path.join(temp, 'manual');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'openbitfun-installer.exe'), 'installer');

  const result = run('scripts/prepare-windows-installer-asset.mjs', [
    '--assets-dir', path.join(temp, 'assets'),
    '--version', '1.2.3',
    '--out-dir', out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(out, 'OpenBitFun_1.2.3_windows-x86_64-installer.exe'), 'utf8'),
    'installer'
  );
});

test('1.0.0-beta manifest keeps the updater URL separate from the manual installer URL', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-latest-manual-'));
  const updater = path.join(temp, 'updater');
  const manual = path.join(temp, 'manual');
  const out = path.join(temp, 'latest-v1.json');
  fs.mkdirSync(updater, { recursive: true });
  fs.mkdirSync(manual, { recursive: true });

  const updaterName = 'OpenBitFun_1.0.0-beta_windows-x86_64-setup.exe';
  fs.writeFileSync(path.join(updater, updaterName), 'setup');
  fs.writeFileSync(path.join(updater, `${updaterName}.sig`), 'inline-updater-signature');
  const installerName = 'OpenBitFun_1.0.0-beta_windows-x86_64-installer.exe';
  fs.writeFileSync(path.join(manual, installerName), 'installer');
  fs.writeFileSync(path.join(manual, `${installerName}.sig`), 'detached-signature');

  const generated = run('scripts/generate-tauri-latest-json.mjs', [
    '--assets-dir', updater,
    '--manual-assets-dir', manual,
    '--version', '1.0.0-beta',
    '--tag', 'v1.0.0-beta',
    '--repo', 'GCWing/OpenBitFun',
    '--out', out,
    '--required-platforms', 'windows-x86_64',
  ]);
  assert.equal(generated.status, 0, generated.stderr);

  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(manifest.platforms['windows-x86_64'].url, /-setup\.exe$/);
  assert.match(manifest.manual_installers['windows-x86_64'].url, /-installer\.exe$/);
  assert.equal(
    manifest.manual_installers['windows-x86_64'].signature_url,
    `${manifest.manual_installers['windows-x86_64'].url}.sig`
  );

  const verified = run('scripts/verify-tauri-latest-json.mjs', [
    '--manifest', out,
    '--version', '1.0.0-beta',
    '--required-platforms', 'windows-x86_64',
    '--required-manual-platforms', 'windows-x86_64',
  ]);
  assert.equal(verified.status, 0, verified.stderr);
});

// deb/rpm installs reject every payload that is not their own package format
// (tauri-plugin-updater: install_deb/install_rpm -> InvalidUpdaterFormat), so the
// feed must carry bundle-type keys. Regression: the 1.0.1 feed served the
// AppImage under the bare linux-x86_64 key and every deb install failed in-app
// updates with "invalid updater binary format".
test('deb and rpm installs get bundle-type Linux updater keys through collect + generate', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-deb-updater-'));
  const collected = path.join(temp, 'collected');
  const out = path.join(temp, 'latest-v1.json');
  const assets = [
    ['OpenBitFun_1.2.3_amd64.AppImage', 'appimage'],
    ['OpenBitFun_1.2.3_amd64.deb', 'deb'],
    ['OpenBitFun-1.2.3-1.x86_64.rpm', 'rpm'],
    ['OpenBitFun_1.2.3_arm64.deb', 'deb-arm64'],
    ['OpenBitFun-1.2.3-1.aarch64.rpm', 'rpm-arm64'],
  ];
  for (const [name, body] of assets) {
    fs.writeFileSync(path.join(temp, name), body);
    fs.writeFileSync(path.join(temp, `${name}.sig`), `sig ${name}`);
  }

  const staging = run('scripts/collect-tauri-updater-assets.mjs', [
    '--assets-dir', temp,
    '--version', '1.2.3',
    '--out-dir', collected,
    '--required-platforms', 'linux-x86_64,linux-x86_64-deb,linux-x86_64-rpm,linux-aarch64-deb,linux-aarch64-rpm',
  ]);
  assert.equal(staging.status, 0, staging.stderr);
  assert.deepEqual(fs.readdirSync(collected).sort(), [
    'OpenBitFun_1.2.3_linux-aarch64-deb.deb',
    'OpenBitFun_1.2.3_linux-aarch64-deb.deb.sig',
    'OpenBitFun_1.2.3_linux-aarch64-rpm.rpm',
    'OpenBitFun_1.2.3_linux-aarch64-rpm.rpm.sig',
    'OpenBitFun_1.2.3_linux-x86_64-deb.deb',
    'OpenBitFun_1.2.3_linux-x86_64-deb.deb.sig',
    'OpenBitFun_1.2.3_linux-x86_64-rpm.rpm',
    'OpenBitFun_1.2.3_linux-x86_64-rpm.rpm.sig',
    'OpenBitFun_1.2.3_linux-x86_64.AppImage',
    'OpenBitFun_1.2.3_linux-x86_64.AppImage.sig',
  ]);

  const generated = run('scripts/generate-tauri-latest-json.mjs', [
    '--assets-dir', collected,
    '--version', '1.2.3',
    '--tag', 'v1.2.3',
    '--repo', 'GCWing/OpenBitFun',
    '--out', out,
    '--required-platforms', 'linux-x86_64,linux-x86_64-deb,linux-x86_64-rpm,linux-aarch64-deb,linux-aarch64-rpm',
  ]);
  assert.equal(generated.status, 0, generated.stderr);

  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(manifest.platforms['linux-x86_64'].url, /OpenBitFun_1\.2\.3_linux-x86_64\.AppImage$/);
  assert.match(manifest.platforms['linux-x86_64-deb'].url, /OpenBitFun_1\.2\.3_linux-x86_64-deb\.deb$/);
  assert.match(manifest.platforms['linux-x86_64-rpm'].url, /OpenBitFun_1\.2\.3_linux-x86_64-rpm\.rpm$/);
  assert.match(manifest.platforms['linux-aarch64-deb'].url, /OpenBitFun_1\.2\.3_linux-aarch64-deb\.deb$/);
  assert.match(manifest.platforms['linux-aarch64-rpm'].url, /OpenBitFun_1\.2\.3_linux-aarch64-rpm\.rpm$/);
  // collect renames the files but copies signatures byte-for-byte: minisign
  // signatures cover the package bytes, not the asset name.
  const renamedToRawSignature = {
    'linux-x86_64': 'sig OpenBitFun_1.2.3_amd64.AppImage',
    'linux-x86_64-deb': 'sig OpenBitFun_1.2.3_amd64.deb',
    'linux-x86_64-rpm': 'sig OpenBitFun-1.2.3-1.x86_64.rpm',
    'linux-aarch64-deb': 'sig OpenBitFun_1.2.3_arm64.deb',
    'linux-aarch64-rpm': 'sig OpenBitFun-1.2.3-1.aarch64.rpm',
  };
  for (const [key, signature] of Object.entries(renamedToRawSignature)) {
    assert.equal(manifest.platforms[key].signature, signature);
  }

  const verified = run('scripts/verify-tauri-latest-json.mjs', [
    '--manifest', out,
    '--version', '1.2.3',
    '--required-platforms', 'linux-x86_64,linux-x86_64-deb,linux-x86_64-rpm,linux-aarch64-deb,linux-aarch64-rpm',
  ]);
  assert.equal(verified.status, 0, verified.stderr);
});

test('stages GitHub release assets in a flat directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-release-assets-'));
  const first = path.join(temp, 'updater', 'latest.json');
  const second = path.join(temp, 'manual', 'installer.exe');
  const out = path.join(temp, 'staged');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, 'manifest');
  fs.writeFileSync(second, 'installer');

  const result = run('scripts/stage-github-release-assets.mjs', [
    '--out-dir', out,
    first,
    second,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'), 'manifest');
  assert.equal(fs.readFileSync(path.join(out, 'installer.exe'), 'utf8'), 'installer');
});

test('rejects duplicate GitHub release asset names before upload', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-release-duplicates-'));
  const first = path.join(temp, 'macos-x64', 'OpenBitFun.app.tar.gz.sig');
  const second = path.join(temp, 'macos-arm64', 'OpenBitFun.app.tar.gz.sig');
  const out = path.join(temp, 'staged');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, 'x64-signature');
  fs.writeFileSync(second, 'arm64-signature');

  const result = run('scripts/stage-github-release-assets.mjs', [
    '--out-dir', out,
    first,
    second,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate release asset name OpenBitFun\.app\.tar\.gz\.sig/);
  assert.match(result.stderr, /macos-x64/);
  assert.match(result.stderr, /macos-arm64/);
});

for (const version of ['1.0.0-beta', '1.0.0-beta.3']) {
test(`${version} Linux CLI and Relay manifests keep signed assets on the versioned repository release`, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-beta-linux-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const tag = `v${version}`;
  const assets = [];
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
    for (const name of [`openbitfun-cli-${version}-${target}.tar.gz`, `openbitfun-relay-server-${target}.tar.gz`]) {
      for (const suffix of ['', '.sha256', '.sig', '.sha256.sig']) {
        const filename = path.join(temp, name + suffix);
        fs.writeFileSync(filename, `fixture ${name}${suffix}`);
        assets.push(filename);
      }
    }
  }
  const out = path.join(temp, 'linux-binaries-v1.json');
  const result = run('scripts/generate-linux-binaries-manifest.mjs', [
    '--assets-dir', temp, '--version', version, '--tag', tag,
    '--repo', 'test-owner/OpenBitFun', '--out', out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.tag, tag);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['linux-aarch64', 'linux-x86_64']);
  for (const platform of Object.values(manifest.platforms)) {
    for (const artifact of [platform.cli, platform.relay]) {
      assert.equal(artifact.url, `https://github.com/test-owner/OpenBitFun/releases/download/${tag}/${artifact.filename}`);
      assert.equal(artifact.sha256Url, `${artifact.url}.sha256`);
      assert.equal(artifact.sigUrl, `${artifact.url}.sig`);
      assert.equal(artifact.sha256SigUrl, `${artifact.url}.sha256.sig`);
    }
  }
  const staged = path.join(temp, 'staged');
  const staging = run('scripts/stage-github-release-assets.mjs', ['--out-dir', staged, ...assets, out]);
  assert.equal(staging.status, 0, staging.stderr);
  assert.deepEqual(fs.readdirSync(staged).sort(), [...assets, out].map((file) => path.basename(file)).sort());
  fs.unlinkSync(assets.find((file) => file.endsWith('.tar.gz')));
  const missing = run('scripts/generate-linux-binaries-manifest.mjs', [
    '--assets-dir', temp, '--version', version, '--tag', tag,
    '--repo', 'test-owner/OpenBitFun', '--out', out,
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Required Linux release asset was not found/);
});

}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}
