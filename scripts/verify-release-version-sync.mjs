#!/usr/bin/env node
import { readFileSync } from 'fs';

const args = parseArgs(process.argv.slice(2));
// Desktop release workflows resolve their version from the root package. Mobile
// apps ship on their own cadence, so they form a separate consistency group.
const expected = args.version || readJsonVersion('package.json');
const versions = new Map([
  ['package.json', readJsonVersion('package.json')],
  ['Cargo.toml', readTomlVersion('Cargo.toml', /version = "([^"]+)" # x-release-please-version/)],
  ['OpenBitFun-Installer/package.json', readJsonVersion('OpenBitFun-Installer/package.json')],
  ['OpenBitFun-Installer/src-tauri/Cargo.toml', readTomlVersion('OpenBitFun-Installer/src-tauri/Cargo.toml', /^version = "([^"]+)"/m)],
  ['src/web-ui/package.json', readJsonVersion('src/web-ui/package.json')],
  ['src/mobile-web/package.json', readJsonVersion('src/mobile-web/package.json')],
  ['src/miniapp-market-web/package.json', readJsonVersion('src/miniapp-market-web/package.json')],
  ['src/skin-market-web/package.json', readJsonVersion('src/skin-market-web/package.json')],
  ['src/apps/relay-server/Cargo.toml', readTomlVersion('src/apps/relay-server/Cargo.toml', /version = "([^"]+)" # x-release-please-version/)],
  ['src/crates/services/relay-service/Cargo.toml', readTomlVersion('src/crates/services/relay-service/Cargo.toml', /^version = "([^"]+)"/m)],
  ['src/crates/services/page-function-runtime/Cargo.toml', readTomlVersion('src/crates/services/page-function-runtime/Cargo.toml', /^version = "([^"]+)"/m)],
]);

const mobileVersions = new Map([
  ['src/apps/mobile/android/app/build.gradle.kts', readTextVersion('src/apps/mobile/android/app/build.gradle.kts', /versionName\s*=\s*"([^"]+)"/)],
  ['src/apps/mobile/ios/OpenBitFun/Info.plist', readTextVersion('src/apps/mobile/ios/OpenBitFun/Info.plist', /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)],
  ['src/apps/mobile/harmonyos/AppScope/app.json5', readTextVersion('src/apps/mobile/harmonyos/AppScope/app.json5', /"versionName"\s*:\s*"([^"]+)"/)],
]);

if (!expected.includes('-')) {
  const releasePleaseManifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'));
  versions.set('.release-please-manifest.json', releasePleaseManifest['.']);
}

const mismatches = [...versions].filter(([, version]) => version !== expected);
const mobileExpected = args['mobile-version'] || mobileVersions.values().next().value;
const mobileMismatches = [...mobileVersions].filter(([, version]) => version !== mobileExpected);
for (const [file, version] of mismatches) {
  console.error(`[release-version] ${file}: expected ${expected}, found ${version}`);
}
for (const [file, version] of mobileMismatches) {
  console.error(`[release-version] ${file}: expected mobile ${mobileExpected}, found ${version}`);
}
if (mismatches.length > 0 || mobileMismatches.length > 0) {
  process.exit(1);
}
console.log(`[release-version] OK: desktop ${expected}; mobile ${mobileExpected}`);

function readJsonVersion(file) {
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

function readTomlVersion(file, pattern) {
  return readTextVersion(file, pattern);
}

function readTextVersion(file, pattern) {
  const match = pattern.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`Version was not found in ${file}`);
  return match[1];
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith('--')) continue;
    parsed[arg.slice(2)] = rawArgs[i + 1];
    i += 1;
  }
  return parsed;
}
