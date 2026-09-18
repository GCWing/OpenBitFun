#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { basename, join } from 'path';

const args = parseArgs(process.argv.slice(2));
const assetsDir = requireArg(args, 'assets-dir');
const version = requireArg(args, 'version');
const outDir = requireArg(args, 'out-dir');

const requiredPlatforms = parseListArg(
  args['required-platforms'] ||
    'windows-x86_64,darwin-x86_64,darwin-aarch64,linux-x86_64,linux-aarch64'
);

if (!existsSync(assetsDir)) {
  fail(`Assets directory does not exist: ${assetsDir}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const collected = {};
for (const sigPath of walkFiles(assetsDir).filter((file) => file.endsWith('.sig'))) {
  const bundlePath = sigPath.slice(0, -'.sig'.length);
  if (!existsSync(bundlePath) || !isUpdaterBundle(bundlePath)) {
    continue;
  }

  const platform = inferPlatform(bundlePath);
  if (!platform) {
    console.warn(`[collect-updater] Skipping artifact with unknown platform: ${bundlePath}`);
    continue;
  }

  if (collected[platform]) {
    fail(
      `Duplicate updater artifact for ${platform}: ${bundlePath} conflicts with ${collected[platform].source}`
    );
  }

  const outputName = updaterOutputName(bundlePath, version, platform);
  const outputPath = join(outDir, outputName);
  const outputSigPath = `${outputPath}.sig`;
  copyFileSync(bundlePath, outputPath);
  copyFileSync(sigPath, outputSigPath);

  collected[platform] = {
    source: bundlePath,
    output: outputPath,
    signature: outputSigPath,
  };
  console.log(`[collect-updater] ${platform}: ${basename(outputPath)}`);
}

const missing = requiredPlatforms.filter((platform) => !collected[platform]);
if (missing.length > 0) {
  const found = Object.keys(collected).sort();
  const signedArtifacts = walkFiles(assetsDir)
    .filter((file) => file.endsWith('.sig'))
    .map((file) => file.replace(/\\/g, '/'))
    .sort();
  console.error(`[collect-updater] Found platforms: ${found.length > 0 ? found.join(', ') : '(none)'}`);
  console.error('[collect-updater] Signed artifacts found:');
  for (const artifact of signedArtifacts) {
    console.error(`[collect-updater]   ${artifact}`);
  }
  fail(`Missing required updater platforms: ${missing.join(', ')}`);
}

console.log(`[collect-updater] Wrote ${Object.keys(collected).length} updater artifacts to ${outDir}`);

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = rawArgs[i + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for --${key}`);
    }
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

function requireArg(parsed, key) {
  const value = parsed[key];
  if (!value) {
    fail(`Missing required argument --${key}`);
  }
  return value;
}

function parseListArg(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isUpdaterBundle(file) {
  const lower = file.toLowerCase();
  return (
    lower.endsWith('.appimage') ||
    lower.endsWith('.app.tar.gz') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.exe') ||
    lower.endsWith('.deb') ||
    lower.endsWith('.rpm')
  );
}

function updaterOutputName(file, version, platform) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.app.tar.gz')) {
    return `OpenBitFun_${version}_${platform}.app.tar.gz`;
  }
  if (lower.endsWith('.appimage')) {
    return `OpenBitFun_${version}_${platform}.AppImage`;
  }
  if (lower.endsWith('.zip')) {
    return `OpenBitFun_${version}_${platform}.zip`;
  }
  if (lower.endsWith('.exe')) {
    return `OpenBitFun_${version}_${platform}-setup.exe`;
  }
  if (lower.endsWith('.deb')) {
    // The bundle-type platform key is part of the name, so the renamed copy
    // never collides with the raw bundler deb staged from release-assets.
    return `OpenBitFun_${version}_${platform}.deb`;
  }
  if (lower.endsWith('.rpm')) {
    return `OpenBitFun_${version}_${platform}.rpm`;
  }
  if (lower.endsWith('.tar.gz')) {
    return `OpenBitFun_${version}_${platform}.tar.gz`;
  }
  fail(`Unsupported updater artifact extension: ${file}`);
}

function inferPlatform(file) {
  const lower = file.replace(/\\/g, '/').toLowerCase();
  const arch = inferArch(lower);
  if (!arch) {
    return null;
  }

  if (lower.endsWith('.zip') || lower.includes('setup.exe')) {
    return `windows-${arch}`;
  }
  if (lower.endsWith('.appimage')) {
    return `linux-${arch}`;
  }
  if (lower.includes('.appimage.tar.gz')) {
    return `linux-${arch}`;
  }
  if (lower.endsWith('.deb')) {
    // Bundle-type key: tauri-plugin-updater installs a deb payload via dpkg only
    // when the running install is itself a deb, so these clients must receive a
    // dedicated `linux-<arch>-deb` entry instead of the AppImage the bare key
    // serves.
    return `linux-${arch}-deb`;
  }
  if (lower.endsWith('.rpm')) {
    return `linux-${arch}-rpm`;
  }
  if (lower.includes('.app.tar.gz')) {
    return `darwin-${arch}`;
  }

  return null;
}

function inferArch(name) {
  if (/(^|[\\/_.-])(x86_64|x64|amd64)([\\/_.-]|$)/.test(name)) {
    return 'x86_64';
  }
  if (/(^|[\\/_.-])(aarch64|arm64)([\\/_.-]|$)/.test(name)) {
    return 'aarch64';
  }
  return null;
}

function fail(message) {
  console.error(`[collect-updater] ${message}`);
  process.exit(1);
}
