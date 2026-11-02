#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function setBuildVersion(root, version) {
  if (!/^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid build version: ${version}`);
  }

  for (const relative of [
    'package.json',
    'OpenBitFun-Installer/package.json',
    'src/web-ui/package.json',
    'src/mobile-web/package.json',
    'src/miniapp-market-web/package.json',
    'src/skin-market-web/package.json',
  ]) {
    const file = path.join(root, relative);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.version = version;
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  replaceVersion(
    path.join(root, 'Cargo.toml'),
    /^version = "[^"]+" # x-release-please-version$/m,
    `version = "${version}" # x-release-please-version`,
  );
  replaceVersion(
    path.join(root, 'src/apps/relay-server/Cargo.toml'),
    /^version = "[^"]+" # x-release-please-version$/m,
    `version = "${version}" # x-release-please-version`,
  );
  replaceVersion(
    path.join(root, 'OpenBitFun-Installer/src-tauri/Cargo.toml'),
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  for (const relative of [
    'src/crates/services/relay-service/Cargo.toml',
    'src/crates/services/page-function-runtime/Cargo.toml',
  ]) {
    replaceVersion(
      path.join(root, relative),
      /^version = "[^"]+"$/m,
      `version = "${version}"`,
    );
  }

  syncCargoLock(root);
}

// Workspace members inherit the root version, so the lockfile carries a copy of
// it for every member. Leaving those stale breaks any later `cargo --locked`
// invocation. Cargo has to do the rewrite: a text substitution would also catch
// third-party crates that happen to publish the same version string, and would
// miss members that pin a version of their own.
//
// This cannot run with --offline: resolving the workspace walks every source,
// and the git dependencies (tauri) are not in a cold CI cargo home yet.
function syncCargoLock(root) {
  if (!existsSync(path.join(root, 'Cargo.lock'))) {
    return;
  }

  const result = spawnSync('cargo', ['update', '--workspace'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Failed to run cargo update: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo update --workspace failed with exit code ${result.status}\n${result.stderr || ''}`,
    );
  }
}

function replaceVersion(file, pattern, replacement) {
  const source = readFileSync(file, 'utf8');
  if (!pattern.test(source)) {
    throw new Error(`Version marker was not found in ${file}`);
  }
  writeFileSync(file, source.replace(pattern, replacement), 'utf8');
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = readArg(process.argv.slice(2), '--version');
    if (!version) {
      throw new Error('Missing required --version argument');
    }
    setBuildVersion(ROOT, version);
    console.log(`[build-version] Updated release metadata to ${version}`);
  } catch (error) {
    console.error(`[build-version] ${error.message || error}`);
    process.exit(1);
  }
}
