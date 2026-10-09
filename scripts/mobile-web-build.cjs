#!/usr/bin/env node

/**
 * Shared mobile-web build helpers for desktop dev/build flows.
 *
 * We must clean copied resources in Tauri target directories before rebuilding,
 * otherwise old Vite hashed assets remain in target profile mobile-web folders and get bundled
 * or uploaded by remote connect along with the latest files.
 */

const { execSync } = require('child_process');
const path = require('path');
const {
  printInfo,
  printSuccess,
  printError,
} = require('./console-style.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');

function decodeOutput(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  if (process.platform !== 'win32') return buffer.toString('utf-8');

  const utf8 = buffer.toString('utf-8');
  if (!utf8.includes('�')) return utf8;

  try {
    const { TextDecoder } = require('util');
    const decoder = new TextDecoder('gbk');
    const gbk = decoder.decode(buffer);
    if (gbk && !gbk.includes('�')) return gbk;
    return gbk || utf8;
  } catch (error) {
    return utf8;
  }
}

function tailOutput(output, maxLines = 12) {
  if (!output) return '';
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

function runSilent(command, cwd = ROOT_DIR) {
  try {
    const stdout = execSync(command, {
      cwd,
      stdio: 'pipe',
      encoding: 'buffer',
    });
    return { ok: true, stdout: decodeOutput(stdout), stderr: '' };
  } catch (error) {
    const stdout = error.stdout ? decodeOutput(error.stdout) : '';
    const stderr = error.stderr ? decodeOutput(error.stderr) : '';
    return { ok: false, stdout, stderr, error };
  }
}

function runInherit(command, cwd = ROOT_DIR) {
  try {
    execSync(command, { cwd, stdio: 'inherit' });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

const MOBILE_WEB_INPUT_IGNORED_DIRS = new Set(['node_modules', 'dist']);

/**
 * Newest mtime among the mobile-web build inputs (recursively for directories).
 * Returns null when nothing relevant exists.
 */
function getNewestInputMtime(entryPath) {
  const fs = require('fs');
  if (!fs.existsSync(entryPath)) {
    return null;
  }

  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    return null;
  }

  if (stat.isFile()) {
    return { path: entryPath, mtimeMs: stat.mtimeMs };
  }

  if (!stat.isDirectory()) {
    return null;
  }

  let newest = null;
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory() && MOBILE_WEB_INPUT_IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const candidate = getNewestInputMtime(path.join(entryPath, entry.name));
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) {
      newest = candidate;
    }
  }

  return newest;
}

// Marker lives outside dist/ so it never ships as a bundled Tauri resource.
function getMobileWebBuildMarkerPath(mobileWebDir) {
  return path.join(mobileWebDir, 'node_modules', '.cache', 'openbitfun-mobile-web-build-marker');
}

/**
 * mtime-based short-circuit (same idea as dev.cjs getDesktopPreviewRebuildPlan):
 * when dist/ exists and the build marker is newer than every input, the whole
 * clean/install/build cycle can be skipped. Escape hatches:
 *   --force flag / OPENBITFUN_MOBILE_WEB_FORCE_BUILD=1 env.
 */
function getMobileWebRebuildPlan(mobileWebDir, force = false, rootDir = ROOT_DIR) {
  const fs = require('fs');

  if (force) {
    return { shouldBuild: true, reason: 'Force rebuild requested for mobile-web' };
  }

  const markerPath = getMobileWebBuildMarkerPath(mobileWebDir);
  if (!fs.existsSync(path.join(mobileWebDir, 'dist', 'index.html')) || !fs.existsSync(markerPath)) {
    return { shouldBuild: true, reason: 'mobile-web dist is missing or has no build marker' };
  }

  const markerMtimeMs = fs.statSync(markerPath).mtimeMs;

  const inputs = [
    path.join(mobileWebDir, 'src'),
    path.join(mobileWebDir, 'public'),
    path.join(mobileWebDir, 'index.html'),
    path.join(mobileWebDir, 'package.json'),
    path.join(mobileWebDir, 'tsconfig.json'),
    path.join(rootDir, 'pnpm-lock.yaml'),
    path.join(rootDir, 'pnpm-workspace.yaml'),
    // src/mobile-web's prebuild rebuilds the design system, and mobile-web
    // consumes @openbitfun/ui through its package exports (no source alias, and
    // design-system/**/dist is generated rather than committed). Every file that
    // can change a design-system build output must therefore invalidate the
    // mobile-web dist, so watch the packages/ and tooling/ trees as a whole
    // instead of a file list that falls behind: new packages and package-root
    // configs such as vite.config.ts or tsconfig.build.json are covered without
    // maintenance. Generated dist/ and node_modules/ stay ignored, so build
    // output cannot re-trigger itself, and design-system/apps consumes these
    // packages rather than feeding them.
    path.join(rootDir, 'design-system', 'package.json'),
    path.join(rootDir, 'design-system', 'tsconfig.base.json'),
    path.join(rootDir, 'design-system', 'packages'),
    path.join(rootDir, 'design-system', 'tooling'),
  ];
  for (const entry of fs.readdirSync(mobileWebDir)) {
    if (entry.startsWith('vite.config.')) {
      inputs.push(path.join(mobileWebDir, entry));
    }
  }

  let newestInput = null;
  for (const input of inputs) {
    const candidate = getNewestInputMtime(input);
    if (candidate && (!newestInput || candidate.mtimeMs > newestInput.mtimeMs)) {
      newestInput = candidate;
    }
  }

  if (newestInput && newestInput.mtimeMs > markerMtimeMs) {
    return {
      shouldBuild: true,
      reason: `mobile-web inputs changed since the last build (${path.relative(rootDir, newestInput.path)})`,
    };
  }

  return {
    shouldBuild: false,
    reason: 'mobile-web dist is up to date; skipping clean/install/build (use --force or OPENBITFUN_MOBILE_WEB_FORCE_BUILD=1 to rebuild)',
  };
}

function writeMobileWebBuildMarker(mobileWebDir) {
  const fs = require('fs');
  const markerPath = getMobileWebBuildMarkerPath(mobileWebDir);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
}

function cleanStaleMobileWebResources(logInfo = printInfo, rootDir = ROOT_DIR) {
  const fs = require('fs');
  const targetDir = path.join(rootDir, 'target');
  if (!fs.existsSync(targetDir)) return 0;

  let cleaned = 0;
  const cleanIfPresent = (candidate) => {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      fs.rmSync(candidate, { recursive: true, force: true });
      cleaned += 1;
    }
  };

  for (const firstLevelEntry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!firstLevelEntry.isDirectory()) continue;
    const firstLevelDir = path.join(targetDir, firstLevelEntry.name);
    cleanIfPresent(path.join(firstLevelDir, 'mobile-web'));

    // Explicit Cargo targets stage resources under
    // target/<target-triple>/<profile>/mobile-web.
    for (const secondLevelEntry of fs.readdirSync(firstLevelDir, { withFileTypes: true })) {
      if (!secondLevelEntry.isDirectory()) continue;
      cleanIfPresent(path.join(firstLevelDir, secondLevelEntry.name, 'mobile-web'));
    }
  }

  if (cleaned > 0) {
    logInfo(`Cleaned stale mobile-web resources from ${cleaned} target profile(s)`);
  }

  return cleaned;
}

function buildMobileWeb(options = {}) {
  const {
    install = false,
    force = process.env.OPENBITFUN_MOBILE_WEB_FORCE_BUILD === '1',
    logInfo = printInfo,
    logSuccess = printSuccess,
    logError = printError,
  } = options;

  const mobileWebDir = path.join(ROOT_DIR, 'src/mobile-web');

  const rebuildPlan = getMobileWebRebuildPlan(mobileWebDir, force);
  if (!rebuildPlan.shouldBuild) {
    logInfo(rebuildPlan.reason);
    return { ok: true, skipped: true };
  }
  logInfo(rebuildPlan.reason);

  cleanStaleMobileWebResources(logInfo);

  if (install) {
    const installResult = runSilent('pnpm install --silent', mobileWebDir);
    if (!installResult.ok) {
      logError('mobile-web pnpm install failed');
      const output = tailOutput(installResult.stderr || installResult.stdout);
      if (output) {
        logError(output);
      } else if (installResult.error?.message) {
        logError(installResult.error.message);
      }
      return { ok: false };
    }
  }

  const buildResult = runInherit('pnpm run build', mobileWebDir);
  if (!buildResult.ok) {
    logError('mobile-web build failed');
    if (buildResult.error?.message) {
      logError(buildResult.error.message);
    }
    return { ok: false };
  }

  writeMobileWebBuildMarker(mobileWebDir);

  logSuccess('mobile-web build complete');
  return { ok: true };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const result = buildMobileWeb({
    install: args.includes('--install'),
    force: args.includes('--force') || process.env.OPENBITFUN_MOBILE_WEB_FORCE_BUILD === '1',
  });
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  buildMobileWeb,
  cleanStaleMobileWebResources,
  getMobileWebRebuildPlan,
};
