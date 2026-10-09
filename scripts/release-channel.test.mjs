import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareReleaseVersions,
  resolveReleaseChannel,
  validateReleaseVersion,
} from './release-channel.mjs';
import { setBuildVersion } from './set-build-version.mjs';
import { decodeMinisignPublicKey } from './write-minisign-public-key.mjs';

const RAW_PUBLIC_KEY = `untrusted comment: minisign public key E3E0874CEC1C22C3
RWTDIhzsTIfg41w2Gwiei0zNDKaLYm9dQVpEWNQ/Ulpyt2mbS2JE1U2M`;

test('stable and beta channels resolve to isolated updater feeds', () => {
  const stable = resolveReleaseChannel('stable');
  const beta = resolveReleaseChannel('beta');
  assert.match(stable.primaryUpdaterEndpoint, /releases\/latest\/download/);
  assert.match(beta.primaryUpdaterEndpoint, /releases\/download\/channel-v1-beta/);
  assert.equal(beta.fallbackUpdaterEndpoint, 'https://openbitfun.com/release/beta/latest-v1.json');
  assert.notEqual(beta.primaryUpdaterEndpoint, stable.primaryUpdaterEndpoint);
  for (const config of [stable, beta]) {
    assert.ok(config.primaryUpdaterEndpoint.endsWith('/latest-v1.json'));
    assert.ok(config.fallbackUpdaterEndpoint.endsWith('/latest-v1.json'));
  }
});

test('channel promotion follows SemVer including beta precedence', () => {
  assert.equal(compareReleaseVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareReleaseVersions('1.0.0-beta', '0.2.19'), 1);
  assert.equal(compareReleaseVersions('1.0.0-beta', '1.0.0-beta.4'), -1);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareReleaseVersions('1.0.0-beta', '1.0.0-beta'), 0);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0-beta.9'), 1);
  assert.equal(compareReleaseVersions('1.0.1-beta.1', '1.0.0'), 1);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.1-beta.1'), -1);
  assert.equal(compareReleaseVersions('1.0.0-beta.2', '1.0.0-beta.2'), 0);
});

test('release versions must match their channel', () => {
  assert.equal(validateReleaseVersion('stable', '1.0.0'), '1.0.0');
  assert.equal(validateReleaseVersion('stable', '1.0.0-beta'), '1.0.0-beta');
  assert.throws(() => validateReleaseVersion('beta', '1.0.0-beta'));
  assert.throws(() => validateReleaseVersion('stable', '1.1.0-beta'));
  assert.equal(validateReleaseVersion('beta', '1.0.0-beta.1'), '1.0.0-beta.1');
  assert.throws(() => validateReleaseVersion('stable', '1.0.0-beta.1'));
  assert.throws(() => validateReleaseVersion('beta', '1.0.0'));
  assert.throws(() => validateReleaseVersion('beta', '1.0.0-beta.0'));
  assert.throws(() => validateReleaseVersion('stable', '0.2.19'));
  assert.equal(
    validateReleaseVersion('nightly', '1.0.0-nightly.20260811'),
    '1.0.0-nightly.20260811',
  );
});

test('release public key export accepts raw and legacy base64 values', () => {
  const expected = `${RAW_PUBLIC_KEY}\n`;
  assert.equal(decodeMinisignPublicKey(RAW_PUBLIC_KEY), expected);
  assert.equal(
    decodeMinisignPublicKey(Buffer.from(expected).toString('base64')),
    expected,
  );
  assert.throws(() => decodeMinisignPublicKey('not-a-key'));
});

test('build version projection and verification work without npm workspace lockfiles', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-build-version-'));
  const jsonFiles = [
    'package.json',
    'OpenBitFun-Installer/package.json',
    'src/web-ui/package.json',
    'src/mobile-web/package.json',
    'src/miniapp-market-web/package.json',
    'src/skin-market-web/package.json',
  ];
  for (const relative of jsonFiles) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: '1.0.0' }));
  }
  writeFixture(
    root,
    'Cargo.toml',
    `[package]
name = "build-version-fixture"
version = "1.0.0" # x-release-please-version
edition = "2021"

[workspace]
members = []
exclude = ["src/apps/relay-server", "OpenBitFun-Installer/src-tauri"]
`,
  );
  writeFixture(root, 'src/lib.rs', 'pub fn fixture() {}\n');
  writeFixture(
    root,
    'src/apps/relay-server/Cargo.toml',
    'version = "1.0.0" # x-release-please-version\n',
  );
  writeFixture(root, 'OpenBitFun-Installer/src-tauri/Cargo.toml', 'version = "1.0.0"\n');
  writeFixture(root, 'src/crates/services/relay-service/Cargo.toml', 'version = "1.0.0"\n');
  writeFixture(
    root,
    'src/crates/services/page-function-runtime/Cargo.toml',
    'version = "1.0.0"\n',
  );
  writeFixture(
    root,
    'src/apps/mobile/android/app/build.gradle.kts',
    '        versionName = "1.0.0"\n',
  );
  writeFixture(
    root,
    'src/apps/mobile/ios/OpenBitFun/Info.plist',
    '<key>CFBundleShortVersionString</key>\n<string>1.0.0</string>\n',
  );
  writeFixture(
    root,
    'src/apps/mobile/harmonyos/AppScope/app.json5',
    '{\n  "app": {\n    "versionName": "1.0.0"\n  }\n}\n',
  );
  const initialLock = spawnSync('cargo', ['generate-lockfile'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(initialLock.status, 0, initialLock.stderr);

  setBuildVersion(root, '1.1.0-beta.2');

  for (const relative of jsonFiles) {
    const data = JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
    assert.equal(data.version, '1.1.0-beta.2');
  }
  for (const relative of [
    'package-lock.json',
    'OpenBitFun-Installer/package-lock.json',
    'src/mobile-web/package-lock.json',
    'tests/e2e/package-lock.json',
  ]) {
    assert.equal(existsSync(path.join(root, relative)), false, relative);
  }
  const versionCheck = spawnSync(process.execPath, [
    path.resolve('scripts/verify-release-version-sync.mjs'),
    '--version', '1.1.0-beta.2',
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(versionCheck.status, 0, versionCheck.stderr);
  assert.match(readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), /1\.1\.0-beta\.2/);
  assert.match(
    readFileSync(path.join(root, 'src/apps/relay-server/Cargo.toml'), 'utf8'),
    /1\.1\.0-beta\.2/,
  );
  assert.match(
    readFileSync(path.join(root, 'src/crates/services/relay-service/Cargo.toml'), 'utf8'),
    /1\.1\.0-beta\.2/,
  );
  assert.match(
    readFileSync(path.join(root, 'src/crates/services/page-function-runtime/Cargo.toml'), 'utf8'),
    /1\.1\.0-beta\.2/,
  );
  assert.match(
    readFileSync(path.join(root, 'src/apps/mobile/android/app/build.gradle.kts'), 'utf8'),
    /versionName = "1\.0\.0"/,
  );
  assert.match(
    readFileSync(path.join(root, 'src/apps/mobile/ios/OpenBitFun/Info.plist'), 'utf8'),
    /<string>1\.0\.0<\/string>/,
  );
  assert.match(
    readFileSync(path.join(root, 'src/apps/mobile/harmonyos/AppScope/app.json5'), 'utf8'),
    /"versionName": "1\.0\.0"/,
  );
  assert.match(
    readFileSync(path.join(root, 'Cargo.lock'), 'utf8'),
    /name = "build-version-fixture"\nversion = "1\.1\.0-beta\.2"/,
  );
  const lockedMetadata = spawnSync('cargo', ['metadata', '--locked', '--no-deps'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(lockedMetadata.status, 0, lockedMetadata.stderr);
});

function writeFixture(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}


test('Desktop, CLI and SSH dispatch consume only the versioned stable feeds', () => {
  const stable = resolveReleaseChannel('stable');
  for (const file of [
    'src/apps/desktop/src/api/system_api.rs',
    'src/crates/services/services-integrations/src/remote_ssh/dispatch_ssh.rs',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(stable.primaryUpdaterEndpoint), file);
    assert.ok(source.includes(stable.fallbackUpdaterEndpoint), file);
    assert.doesNotMatch(source, /https:[^"\s]+\/latest\.json/);
  }
  const cli = readFileSync(new URL('../src/apps/cli/src/self_update.rs', import.meta.url), 'utf8');
  assert.ok(cli.includes('https://github.com/GCWing/OpenBitFun/releases/latest/download/linux-binaries-v1.json'));
  assert.ok(cli.includes('https://openbitfun.com/release/linux-binaries-v1.json'));
});
