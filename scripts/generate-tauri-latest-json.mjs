#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

const args = parseArgs(process.argv.slice(2));
const assetsDir = requireArg(args, 'assets-dir');
const version = requireArg(args, 'version');
const tag = requireArg(args, 'tag');
const repo = requireArg(args, 'repo');
const out = requireArg(args, 'out');
const requiredPlatforms = parseListArg(args['required-platforms'] || '');
const manualAssetsDir = args['manual-assets-dir'];

if (!existsSync(assetsDir)) {
  fail(`Assets directory does not exist: ${assetsDir}`);
}

const platforms = {};
for (const sigPath of walkFiles(assetsDir).filter((file) => file.endsWith('.sig'))) {
  const bundlePath = sigPath.slice(0, -'.sig'.length);
  if (!existsSync(bundlePath) || !isUpdaterBundle(bundlePath)) {
    continue;
  }

  const platform = inferPlatform(bundlePath);
  if (!platform) {
    console.warn(`[latest-json] Skipping updater artifact with unknown platform: ${bundlePath}`);
    continue;
  }

  if (platforms[platform]) {
    console.warn(`[latest-json] Replacing duplicate ${platform} artifact: ${bundlePath}`);
  }

  const assetName = basename(bundlePath);
  platforms[platform] = {
    signature: readFileSync(sigPath, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`,
  };
}

const platformNames = Object.keys(platforms);
if (platformNames.length === 0) {
  fail('No signed updater artifacts were found. Expected .AppImage.sig, .app.tar.gz.sig, .tar.gz.sig, .zip.sig, .exe.sig, .deb.sig, or .rpm.sig files.');
}

const missingPlatforms = requiredPlatforms.filter((platform) => !platforms[platform]);
if (missingPlatforms.length > 0) {
  fail(`Missing required updater platforms: ${missingPlatforms.join(', ')}`);
}

const manifest = {
  version,
  notes: '',
  pub_date: new Date().toISOString(),
  platforms,
};

if (manualAssetsDir) {
  const installerName = `OpenBitFun_${version}_windows-x86_64-installer.exe`;
  const installerPath = join(manualAssetsDir, installerName);
  const signaturePath = `${installerPath}.sig`;
  if (!existsSync(installerPath) || !existsSync(signaturePath)) {
    fail(`Missing signed manual installer pair: ${installerPath} and ${signaturePath}`);
  }
  const assetUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(installerName)}`;
  manifest.manual_installers = {
    'windows-x86_64': {
      url: assetUrl,
      signature_url: `${assetUrl}.sig`,
    },
  };
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[latest-json] Wrote ${out}`);
for (const platform of Object.keys(platforms).sort()) {
  console.log(`[latest-json] ${platform}: ${platforms[platform].url}`);
}

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

function parseListArg(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireArg(parsed, key) {
  const value = parsed[key];
  if (!value) {
    fail(`Missing required argument --${key}`);
  }
  return value;
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

function inferPlatform(file) {
  const lower = file.replace(/\\/g, '/').toLowerCase();
  const arch = inferArch(lower);
  if (!arch) {
    return null;
  }

  if (lower.endsWith('.zip')) {
    return `windows-${arch}`;
  }
  if (lower.includes('-setup.exe') || lower.includes('_setup.exe') || lower.endsWith('setup.exe')) {
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
  console.error(`[latest-json] ${message}`);
  process.exit(1);
}
