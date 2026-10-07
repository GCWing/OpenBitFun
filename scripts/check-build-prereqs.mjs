#!/usr/bin/env node

/**
 * Build prerequisite preflight check.
 *
 * Detects missing build prerequisites that cause confusing cargo/pnpm failures:
 *
 * - Root node_modules missing → pnpm scripts fail with "node_modules missing,
 *   did you mean to install?"
 * - A package directory inside node_modules/.pnpm unexpectedly empty (or a
 *   dangling link) → the matching node_modules/.bin shim resolves to a path
 *   without content, and nested tools fail with a confusing "Cannot find
 *   module .../bin/<tool>" error, for example
 *   ".../design-system/packages/ui/node_modules/typescript/bin/tsc"
 * - src/mobile-web/dist missing → cargo check -p openbitfun-desktop and
 *   cargo check --workspace fail with "resource path '../../mobile-web/dist'
 *   doesn't exist" in the openbitfun-desktop build script
 * - OpenCode extension Host dist missing → Desktop, CLI, and app-server
 *   builds cannot bundle or launch the Bun plugin Host resources
 * - sherpa-onnx prebuilt libs missing → sherpa-onnx-sys build script attempts
 *   a network download from GitHub that fails on poor connectivity
 *
 * Usage:
 *   node scripts/check-build-prereqs.mjs          # check only
 *   node scripts/check-build-prereqs.mjs --fix    # attempt to fix missing prereqs
 *
 * When cargo check or pnpm build fails with a confusing error about missing
 * resources or sherpa-onnx download failures, run this check first.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const DEFAULT_ROOT = join(SCRIPT_DIR, '..');
const ROOT_DIR = process.env.OPENBITFUN_BUILD_PREREQS_TEST_ROOT || DEFAULT_ROOT;
const FIX = process.argv.includes('--fix');

// --- Check logic (extracted for re-use and testing) ---

const VIRTUAL_STORE_SAMPLE_LIMIT = 5;

function readdirWithTypes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Package directories inside node_modules/.pnpm that pnpm recorded but whose
 * files are gone: an existing but empty package directory, or a link whose
 * target disappeared. Either one makes the workspace bin shims resolve to a
 * path without content.
 */
function findBrokenVirtualStorePackages(rootDir) {
  const virtualStoreDir = join(rootDir, 'node_modules', '.pnpm');
  if (!existsSync(virtualStoreDir)) {
    return [];
  }

  const isBroken = (packageDir, entry) => {
    // readdir reports the name of a dangling link, but the path cannot be opened.
    if (!existsSync(packageDir)) {
      return true;
    }
    // Links to peer packages hold no files themselves; their target is checked
    // through its own entry in the virtual store.
    if (entry.isSymbolicLink()) {
      return false;
    }
    return readdirWithTypes(packageDir).length === 0;
  };

  const broken = [];
  for (const storeEntry of readdirWithTypes(virtualStoreDir)) {
    if (!storeEntry.isDirectory()) {
      continue;
    }
    const storeNodeModules = join(virtualStoreDir, storeEntry.name, 'node_modules');

    for (const entry of readdirWithTypes(storeNodeModules)) {
      if (entry.name.startsWith('@')) {
        const scopeDir = join(storeNodeModules, entry.name);
        for (const scopedEntry of readdirWithTypes(scopeDir)) {
          const packageDir = join(scopeDir, scopedEntry.name);
          if (isBroken(packageDir, scopedEntry)) {
            broken.push(packageDir);
          }
        }
        continue;
      }
      const packageDir = join(storeNodeModules, entry.name);
      if (isBroken(packageDir, entry)) {
        broken.push(packageDir);
      }
    }
  }

  return broken;
}

function runChecks(rootDir) {
  const errors = [];
  const warnings = [];

  // --- Check 1: Root node_modules ---
  if (!existsSync(join(rootDir, 'node_modules'))) {
    errors.push({
      name: 'root node_modules',
      message: 'Root node_modules is missing. pnpm scripts will not work.',
      fix: ['pnpm', 'install'],
    });
  }

  // --- Check 2: pnpm virtual store integrity ---
  const brokenPackages = findBrokenVirtualStorePackages(rootDir);
  if (brokenPackages.length > 0) {
    const samples = brokenPackages
      .slice(0, VIRTUAL_STORE_SAMPLE_LIMIT)
      .map((packageDir) => relative(rootDir, packageDir));
    const remaining = brokenPackages.length - samples.length;
    const sampleText = remaining > 0 ? `${samples.join(', ')}, ...(+${remaining} more)` : samples.join(', ');

    errors.push({
      name: 'pnpm virtual store',
      message:
        `${brokenPackages.length} installed package(s) are missing their files: ${sampleText}. ` +
        'The matching node_modules/.bin shims point at a path without content, so nested tools fail with ' +
        'a confusing "Cannot find module .../bin/<tool>" error. pnpm install alone does not repair this: ' +
        'pnpm leaves an existing empty package directory untouched, so the broken directories must be removed first.',
      fix: ['pnpm', 'install'],
      cleanPaths: brokenPackages,
      fixNote:
        '--fix removes the broken package directories first, because pnpm install would otherwise leave them empty. To repair by hand, delete the paths above and run pnpm install.',
    });
  }

  // --- Check 3: mobile-web dist (required by openbitfun-desktop build script) ---
  if (!existsSync(join(rootDir, 'src', 'mobile-web', 'dist', 'index.html'))) {
    errors.push({
      name: 'mobile-web dist',
      message:
        "src/mobile-web/dist is missing. The openbitfun-desktop Tauri build script references '../../mobile-web/dist' as a resource, so 'cargo check -p openbitfun-desktop' and 'cargo check --workspace' will fail with \"resource path doesn't exist\".",
      fix: ['pnpm', 'run', 'prepare:mobile-web'],
    });
  }

  // --- Check 4: OpenCode extension Host dist (product runtime resource) ---
  const pluginHostDist = join(
    rootDir,
    'src',
    'apps',
    'extension-host',
    'dist',
  );
  const pluginHostEntries = [join(pluginHostDist, 'extension-host.js')];
  if (pluginHostEntries.some((entry) => !existsSync(entry))) {
    errors.push({
      name: 'OpenCode extension Host dist',
      message:
        'src/apps/extension-host/dist is missing the Bun Host entry. Desktop, CLI, and app-server builds require this plugin Host runtime resource.',
      fix: ['pnpm', 'run', 'plugin-host:prepare'],
    });
  }

  // --- Check 5: sherpa-onnx prebuilt libs ---
  // sherpa-onnx-sys build.rs auto-detects target/sherpa-onnx-prebuilt/<version>/lib/
  // and returns immediately without downloading. Only warn for the first-build
  // scenario where no prebuilt cache exists yet.
  const sherpaLibDirEnv = process.env.SHERPA_ONNX_LIB_DIR;
  const sherpaPrebuiltDir = join(rootDir, 'target', 'sherpa-onnx-prebuilt');

  if (sherpaLibDirEnv) {
    if (!existsSync(sherpaLibDirEnv)) {
      warnings.push({
        name: 'sherpa-onnx env var',
        message: `SHERPA_ONNX_LIB_DIR is set to "${sherpaLibDirEnv}" but the path does not exist.`,
      });
    }
  } else if (!existsSync(sherpaPrebuiltDir)) {
    warnings.push({
      name: 'sherpa-onnx',
      message:
        'No prebuilt sherpa-onnx cache found. The first build will download from GitHub. If connectivity is poor and the download fails, you can set SHERPA_ONNX_ARCHIVE_DIR to a directory containing the pre-downloaded archive.',
    });
  }
  // If prebuilt dir exists, build.rs auto-detects it — no warning needed.

  return { errors, warnings };
}

function collectPendingFixes(errors) {
  return errors
    .filter((e) => e.fix)
    .map((e) => ({
      name: e.name,
      fix: e.fix,
      cleanPaths: e.cleanPaths ?? [],
    }));
}

function reportResults({ errors, warnings }) {
  if (errors.length > 0) {
    console.error('Build prerequisite check failed:\n');
    for (const e of errors) {
      console.error(`  [FAIL] ${e.name}: ${e.message}`);
      if (e.fix) {
        console.error(`         Fix: ${e.fix.join(' ')}`);
      }
      if (e.fixNote) {
        console.error(`         Note: ${e.fixNote}`);
      }
    }
    console.error();
  }

  if (warnings.length > 0) {
    console.warn('Build prerequisite warnings:\n');
    for (const w of warnings) {
      console.warn(`  [WARN] ${w.name}: ${w.message}`);
    }
    console.warn();
  }
}

function runFixes(pendingFixes, rootDir) {
  let allSucceeded = true;
  for (const { fix, cleanPaths } of pendingFixes) {
    for (const target of cleanPaths) {
      // Only ever delete inside the virtual store: a broken path must not be
      // allowed to escape into source or user data.
      const virtualStorePrefix = `${join(rootDir, 'node_modules', '.pnpm')}${sep}`;
      if (!target.startsWith(virtualStorePrefix)) {
        console.error(`Refusing to remove path outside the pnpm virtual store: ${target}\n`);
        allSucceeded = false;
        continue;
      }
      console.log(`Removing broken package directory ${relative(rootDir, target)}`);
      rmSync(target, { recursive: true, force: true });
    }

    const [cmd, ...args] = fix;
    console.log(`$ ${fix.join(' ')}`);
    try {
      if (process.platform === 'win32') {
        execFileSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', fix.join(' ')],
          { stdio: 'inherit', cwd: rootDir },
        );
      } else {
        execFileSync(cmd, args, { stdio: 'inherit', cwd: rootDir });
      }
    } catch {
      console.error(`Fix command failed: ${fix.join(' ')}\n`);
      allSucceeded = false;
    }
    console.log();
  }
  return allSucceeded;
}

// --- Main ---

const firstResult = runChecks(ROOT_DIR);

if (firstResult.errors.length === 0 && firstResult.warnings.length === 0) {
  console.log('Build prerequisite check passed.');
  process.exit(0);
}

reportResults(firstResult);

if (firstResult.errors.length > 0) {
  const pendingFixes = collectPendingFixes(firstResult.errors);

  if (FIX && pendingFixes.length > 0) {
    console.log('Attempting fixes...\n');
    const allSucceeded = runFixes(pendingFixes, ROOT_DIR);

    if (allSucceeded) {
      console.log('Re-checking prerequisites...\n');
      const secondResult = runChecks(ROOT_DIR);
      reportResults(secondResult);

      if (secondResult.errors.length === 0) {
        console.log('All errors resolved after fix.');
        process.exit(0);
      }
      console.error('Some errors remain after fix.');
      process.exit(1);
    }
    console.error('Some fix attempts failed. See errors above.');
    process.exit(1);
  }

  console.error(
    'Run with --fix to attempt automatic fixes for missing prerequisites.',
  );
  process.exit(1);
}

// Only warnings, no errors
process.exit(0);
