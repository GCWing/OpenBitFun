#!/usr/bin/env node

/**
 * Development environment startup script
 * Manages pre-build tasks and dev server startup
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const { execSync, spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  printHeader,
  printSuccess,
  printInfo,
  printError,
  printWarning,
  printStep,
  printComplete,
  printBlank,
} = require('./console-style.cjs');
const ROOT_DIR = path.resolve(__dirname, '..');
let DEV_SERVER_PORT = 1422;
const DEV_SERVER_HOSTS = ['localhost', '127.0.0.1', '::1'];
const DESKTOP_PREVIEW_REBUILD_INPUTS = [
  path.join(ROOT_DIR, 'Cargo.toml'),
  path.join(ROOT_DIR, 'src', 'apps', 'desktop'),
  path.join(ROOT_DIR, 'src', 'crates'),
];
const DESKTOP_PREVIEW_REBUILD_IGNORED_DIRS = new Set([
  '.openbitfun',
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const DESKTOP_PREVIEW_REBUILD_RELEVANT_EXTENSIONS = new Set([
  '.ftl',
  '.json',
  '.md',
  '.rs',
  '.toml',
  '.yaml',
  '.yml',
]);
const DESKTOP_PREVIEW_REBUILD_IGNORED_BASENAMES = new Set([
  'AGENTS-CN.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING_CN.md',
  'README.md',
  'README.zh-CN.md',
  'README_CN.md',
]);

function isDesktopMode(mode) {
  return mode === 'desktop' || mode === 'desktop-preview';
}

function getDesktopBinaryPath() {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `openbitfun-desktop${suffix}`;

  if (process.platform === 'darwin') {
    return path.join(ROOT_DIR, 'target', 'debug', 'OpenBitFun.app', 'Contents', 'MacOS', 'OpenBitFun');
  }

  return path.join(ROOT_DIR, 'target', 'debug', binaryName);
}

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

/**
 * Run command and show output
 */
function runCommand(command, cwd = ROOT_DIR) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];
    
    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: 'inherit'
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    child.on('error', reject);
  });
}

/**
 * Spawn a command with explicit args array (no shell interpolation, safe for paths with spaces)
 */
function spawnCommand(cmd, args, cwd = ROOT_DIR, envOverrides = {}, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      shell,
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Run a command asynchronously with piped output, prefixing every line so
 * parallel preparation steps stay distinguishable. Resolves (never rejects)
 * with { ok, code, error }.
 */
function runCommandPrefixed(prefix, cmd, args, cwd = ROOT_DIR, envOverrides = {}) {
  return new Promise((resolve) => {
    const spawnOptions = {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...envOverrides,
      },
    };
    const child = process.platform === 'win32'
      ? spawn(
          process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/s', '/c', cmd, ...args],
          spawnOptions,
        )
      : spawn(cmd, args, spawnOptions);

    const forward = (stream, out) => {
      let buffered = '';
      stream.on('data', (chunk) => {
        buffered += decodeOutput(chunk);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') {
            out.write(`[${prefix}] ${line}\n`);
          }
        }
      });
      stream.on('end', () => {
        if (buffered.trim() !== '') {
          out.write(`[${prefix}] ${buffered}\n`);
        }
      });
    };

    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    child.on('error', (error) => resolve({ ok: false, code: null, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: null }));
  });
}

function spawnBackgroundCommand(cmd, args, cwd = ROOT_DIR, env = process.env) {
  return spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
}

function spawnWindowsCommand(command, cwd = ROOT_DIR, env = process.env) {
  return spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', command], {
    cwd,
    stdio: 'inherit',
    env,
  });
}

function spawnWindowsCommandArgs(command, args, cwd = ROOT_DIR, env = process.env) {
  return spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', command, ...args], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
}

function runWindowsCommandArgs(command, args, cwd = ROOT_DIR, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawnWindowsCommandArgs(command, args, cwd, env);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

function stopChildProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F >nul 2>&1`);
      return;
    } catch (error) {
      // Fall through to a best-effort kill below.
    }
  }

  try {
    child.kill('SIGTERM');
  } catch (error) {
    // Ignore cleanup failures on shutdown paths.
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortOpen(port, hosts = DEV_SERVER_HOSTS) {
  return Promise.any(hosts.map((host) => {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(1500);
      client.connect(port, host, () => {
        client.destroy();
        resolve(true);
      });
      client.on('error', (error) => {
        client.destroy();
        reject(error);
      });
      client.on('timeout', () => {
        client.destroy();
        reject(new Error(`Timeout connecting to ${host}:${port}`));
      });
    });
  })).then(() => true).catch(() => false);
}

async function waitForPort(port, hosts = DEV_SERVER_HOSTS, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port, hosts)) {
      return;
    }
    await wait(500);
  }

  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

async function runDesktopTargetGcBestEffort(profile = 'debug') {
  try {
    const { runGcBestEffort } = await import(
      pathToFileURL(path.join(__dirname, 'cargo-target-gc.mjs')).href
    );
    printInfo('Pruning stale Cargo target caches (keep latest only)');
    runGcBestEffort({
      rootDir: ROOT_DIR,
      profile,
      logger: {
        info: (message) => printInfo(message),
        warn: (message) => printError(message),
      },
    });
  } catch (error) {
    printError(`Target GC skipped: ${error.message || String(error)}`);
  }
}

async function runDesktopTargetGc(profile = 'debug') {
  try {
    const { runGcBestEffort } = await import(
      pathToFileURL(path.join(__dirname, 'cargo-target-gc.mjs')).href
    );
    printInfo('Pruning stale Cargo target caches (keep latest only)...');
    runGcBestEffort({
      rootDir: ROOT_DIR,
      profile,
      logger: {
        info: (message) => printInfo(message),
        warn: (message) => printWarning(message),
      },
    });
  } catch (error) {
    printWarning(`target-gc skipped: ${error.message || String(error)}`);
  }
}

async function rebuildDesktopDebugBinary() {
  const buildEnv = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG || 'line-tables-only',
    CARGO_PROFILE_DEV_INCREMENTAL: process.env.CARGO_PROFILE_DEV_INCREMENTAL || 'true',
    CARGO_PROFILE_DEV_CODEGEN_UNITS: process.env.CARGO_PROFILE_DEV_CODEGEN_UNITS || '256',
  };

  printInfo('Building openbitfun-desktop in dev mode with reduced debug info for faster local relink');
  printInfo(
    `Fast local build env: CARGO_PROFILE_DEV_DEBUG=${buildEnv.CARGO_PROFILE_DEV_DEBUG}, ` +
    `CARGO_PROFILE_DEV_CODEGEN_UNITS=${buildEnv.CARGO_PROFILE_DEV_CODEGEN_UNITS}`
  );

  await spawnCommand(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    ['build', '-p', 'openbitfun-desktop'],
    ROOT_DIR,
    buildEnv,
  );
}

function getNewestTrackedInput(entryPath) {
  if (!fs.existsSync(entryPath)) {
    return null;
  }

  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    return null;
  }

  if (stat.isFile()) {
    const basename = path.basename(entryPath);
    if (DESKTOP_PREVIEW_REBUILD_IGNORED_BASENAMES.has(basename)) {
      return null;
    }

    const ext = path.extname(entryPath).toLowerCase();
    if (!DESKTOP_PREVIEW_REBUILD_RELEVANT_EXTENSIONS.has(ext)) {
      return null;
    }

    const isEmbeddedMarkdown = entryPath.includes(`${path.sep}prompts${path.sep}`)
      || entryPath.includes(
        `${path.sep}service${path.sep}announcement${path.sep}content${path.sep}`,
      );
    if (ext === '.md' && !isEmbeddedMarkdown) {
      return null;
    }

    return {
      path: entryPath,
      mtimeMs: stat.mtimeMs,
    };
  }

  if (!stat.isDirectory()) {
    return null;
  }

  let newest = null;
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory() && DESKTOP_PREVIEW_REBUILD_IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const candidate = getNewestTrackedInput(path.join(entryPath, entry.name));
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) {
      newest = candidate;
    }
  }

  return newest;
}

function getDesktopPreviewRebuildPlan(desktopBinary, forceRebuild = false) {
  if (forceRebuild) {
    return {
      shouldRebuild: true,
      reason: 'Force rebuild requested for desktop preview',
    };
  }

  if (!fs.existsSync(desktopBinary)) {
    return {
      shouldRebuild: true,
      reason: 'Debug desktop binary is missing',
    };
  }

  const binaryMtimeMs = fs.statSync(desktopBinary).mtimeMs;
  let newestInput = null;

  for (const input of DESKTOP_PREVIEW_REBUILD_INPUTS) {
    const candidate = getNewestTrackedInput(input);
    if (candidate && (!newestInput || candidate.mtimeMs > newestInput.mtimeMs)) {
      newestInput = candidate;
    }
  }

  if (newestInput && newestInput.mtimeMs > binaryMtimeMs) {
    return {
      shouldRebuild: true,
      reason: `Rust / Tauri inputs changed since the last preview (${path.relative(ROOT_DIR, newestInput.path)})`,
    };
  }

  return {
    shouldRebuild: false,
    reason: `Reusing debug desktop binary: ${path.relative(ROOT_DIR, desktopBinary)}`,
  };
}

async function ensureDesktopDebugBinaryForPreview(forceRebuild = false) {
  const desktopBinary = getDesktopBinaryPath();
  const rebuildPlan = getDesktopPreviewRebuildPlan(desktopBinary, forceRebuild);

  if (!rebuildPlan.shouldRebuild) {
    printInfo(rebuildPlan.reason);
    return desktopBinary;
  }

  printInfo(`${rebuildPlan.reason}; rebuilding before preview`);
  await rebuildDesktopDebugBinary();
  printSuccess('Debug desktop binary rebuilt for preview');
  return desktopBinary;
}

async function startDesktopPreview() {
  const desktopBinary = getDesktopBinaryPath();

  if (!fs.existsSync(desktopBinary)) {
    printError(`Debug desktop binary not found: ${desktopBinary}`);
    printInfo('Retry with `pnpm run desktop:preview:debug -- --force-rebuild` or build it with `cargo build -p openbitfun-desktop`');
    process.exit(1);
  }

  let appProcess = null;
  let devServerProcess = null;
  let ownsDevServer = false;
  let shuttingDown = false;

  const cleanup = () => {
    stopChildProcess(appProcess);
    if (ownsDevServer) {
      stopChildProcess(devServerProcess);
    }
  };

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    cleanup();
    await runDesktopTargetGc('debug');
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    printInfo('Stopping desktop preview...');
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    printInfo('Stopping desktop preview...');
    void shutdown(0);
  });

  if (await isPortOpen(DEV_SERVER_PORT)) {
    printInfo(`Reusing web UI dev server on http://localhost:${DEV_SERVER_PORT}`);
  } else {
    printInfo(`Starting web UI dev server on http://localhost:${DEV_SERVER_PORT}`);
    const viteArgs = [
      '--dir',
      'src/web-ui',
      'run',
      'dev',
      '--',
      '--host',
      'localhost',
      '--port',
      String(DEV_SERVER_PORT),
    ];
    const viteEnv = {
      ...process.env,
      TAURI_DEV_HOST: 'localhost',
    };

    devServerProcess = process.platform === 'win32'
      ? spawnWindowsCommand(`pnpm ${viteArgs.join(' ')}`, ROOT_DIR, viteEnv)
      : spawnBackgroundCommand('pnpm', viteArgs, ROOT_DIR, viteEnv);
    ownsDevServer = true;

    devServerProcess.on('error', (error) => {
      printError(`Web UI dev server failed to start: ${error.message || String(error)}`);
      shutdown(1);
    });

    devServerProcess.on('exit', (code, signal) => {
      devServerProcess = null;
      ownsDevServer = false;
      if (!appProcess && !shuttingDown && code !== 0) {
        printError(`Web UI dev server exited before desktop launch (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        shutdown(code ?? 1);
        return;
      }
      if (appProcess && appProcess.exitCode === null && !shuttingDown) {
        printError(`Web UI dev server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        shutdown(code ?? 1);
      }
    });

    try {
      await waitForPort(DEV_SERVER_PORT);
    } catch (error) {
      printError(error.message || String(error));
      await shutdown(1);
    }

    printSuccess(`Web UI dev server is ready on http://localhost:${DEV_SERVER_PORT}`);
  }

  printInfo(`Launching debug desktop binary: ${desktopBinary}`);

  // Dev builds must never share the user data home with an installed (or any
  // other) OpenBitFun build: durable stores like the agent coordination SQLite
  // carry schema versions, and a newer build upgrading the shared database
  // hard-rejects older builds (observed as every LoopX task entering
  // recovery). `OPENBITFUN_USER_ROOT` is the documented data-root override;
  // point it at the dedicated dev data home so cross-build schema collisions
  // are structurally impossible. E2E runs use their own guarded roots and are
  // unaffected.
  const devUserRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.openbitfun.desktop.dev', 'openbitfun');
  printInfo(`Dev data root (OPENBITFUN_USER_ROOT): ${devUserRoot}`);

  appProcess = spawnBackgroundCommand(desktopBinary, [], ROOT_DIR, {
    ...process.env,
    OPENBITFUN_USER_ROOT: process.env.OPENBITFUN_USER_ROOT || devUserRoot,
    // Debug previews must upload the current workspace build. The adjacent
    // target/debug resource tree is only a build-time copy and can lag behind
    // mobile-web edits made while the desktop binary is being reused.
    OPENBITFUN_MOBILE_WEB_DIR: path.join(ROOT_DIR, 'src/mobile-web/dist'),
  });

  appProcess.on('error', (error) => {
    printError(`Desktop preview failed to start: ${error.message || String(error)}`);
    void shutdown(1);
  });

  appProcess.on('exit', (code, signal) => {
    if (!shuttingDown) {
      printInfo(`Desktop preview exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    }
    void shutdown(code ?? 0);
  });

  printSuccess('Desktop preview is running');
  printInfo('Front-end edits continue to use Vite HMR; rebuild Rust only when desktop-side code changes');

  await new Promise(() => {});
}

/**
 * Ensure the bundled, compiled loopx CLI sidecar exists for desktop dev.
 *
 * The runtime prefers this sidecar (`CARGO_MANIFEST_DIR/resources/loopx`,
 * see desktop app_state::resolve_bundled_loopx_dir), so desktop:dev mirrors
 * the packaging build instead of silently falling back to a system `loopx`
 * command. The staged manifest.json carries the exact pin and a sha256 of the
 * binary: when both match (and the checksum is intact) the build is skipped in
 * seconds; a pin change or corruption triggers a rebuild. A build failure is a
 * warning, never a dev-start blocker — the existing system-command fallback in
 * loopx_cli.rs stays as the degraded path.
 */
async function ensureLoopxSidecar() {
  const helperUrl = pathToFileURL(path.join(__dirname, 'build-loopx.mjs')).href;
  const helper = await import(helperUrl);
  const loopxDir = path.join(ROOT_DIR, 'src', 'apps', 'desktop', 'resources', 'loopx');
  const manifestPath = path.join(loopxDir, 'manifest.json');
  const binaryName = process.platform === 'win32' ? 'loopx.exe' : 'loopx';
  const binaryPath = path.join(loopxDir, binaryName);

  try {
    if (fs.existsSync(manifestPath) && fs.existsSync(binaryPath)) {
      const { createHash } = require('node:crypto');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const expected = (manifest.sha256 || '').replace(/^sha256:/, '');
      const actual = createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
      if (manifest.version === helper.LOOPX_VERSION && expected && actual === expected) {
        printInfo(
          `loopx sidecar up to date (v${helper.LOOPX_VERSION}${manifest.commit ? ` @ ${manifest.commit}` : ''})`
        );
        return { ok: true, code: 0, error: null };
      }
      printInfo('loopx sidecar pin or checksum changed; rebuilding...');
    } else {
      printInfo(
        'loopx sidecar missing; building bundled CLI (first desktop:dev run may take a while)...'
      );
    }
    await helper.buildLoopx();
    printSuccess(`loopx sidecar ready (v${helper.LOOPX_VERSION})`);
    return { ok: true, code: 0, error: null };
  } catch (error) {
    printWarning(
      `loopx sidecar build skipped (${error.message}); dev will fall back to a system loopx command`
    );
    return { ok: true, code: 0, error: null };
  }
}

/**
 * Main entry
 */
async function main() {
  const { resolveDevServerPorts } = await import('./dev-server-ports.mjs');
  DEV_SERVER_PORT = resolveDevServerPorts().port;
  const startTime = Date.now();
  let mode = process.argv[2] || 'web'; // web | desktop
  const extraArgs = process.argv.slice(3);
  let forceDesktopPreviewRebuild = extraArgs.includes('--force-rebuild');

  if (mode === 'desktop-preview-rebuild') {
    mode = 'desktop-preview';
    forceDesktopPreviewRebuild = true;
  }

  const desktopMode = isDesktopMode(mode);
  const modeLabelMap = {
    desktop: 'Desktop',
    'desktop-preview': 'Desktop Debug Preview',
    web: 'Web',
  };
  const modeLabel = modeLabelMap[mode] || 'Web';
  
  printHeader(`OpenBitFun ${modeLabel} Development`);
  printBlank();

  const totalSteps = 2;
  let currentStep = 1;

  // Step 1: Run all independent preparation tasks in parallel.
  // copy-monaco / generate-version / mobile-web / flashgrep / plugin-host / loopx
  // have no
  // dependencies on each other; each task's output is line-prefixed so the
  // interleaved logs stay attributable. The DeepSeek bridge is not prepared
  // here: it is not a compile-time Tauri resource. Official desktop:build
  // compiles it; local DeepSeek sessions run `pnpm run prepare:dsh-profile`.
  printStep(
    currentStep++,
    totalSteps,
    desktopMode
      ? 'Prepare resources (parallel: monaco, version, mobile-web, flashgrep, plugin-host, loopx)'
      : 'Prepare resources (parallel: monaco, version)'
  );

  const prepTasks = [
    {
      name: 'Copy Monaco resources',
      hint: 'Hint: run `pnpm install` in repo root if dependencies are missing',
      promise: runCommandPrefixed('copy-monaco', 'pnpm', ['run', 'copy-monaco', '--silent']),
    },
    {
      name: 'Generate version info',
      promise: runCommandPrefixed('version', 'node', [
        'scripts/generate-version.cjs',
        '--build-env',
        'development',
      ]),
    },
  ];

  if (desktopMode) {
    prepTasks.push({
      name: 'Prepare OpenCode extension Host',
      hint: 'Hint: install Bun, then run `pnpm run plugin-host:prepare`',
      promise: runCommandPrefixed('plugin-host', 'pnpm', ['run', 'plugin-host:prepare']),
    });
    prepTasks.push({
      name: 'Prepare loopx CLI sidecar',
      promise: ensureLoopxSidecar(),
    });
    prepTasks.push({
      name: 'Prepare speech libraries',
      promise: (async () => {
        try {
          const { prepareSherpaDev } = await import('./prepare-sherpa-dev.mjs');
          prepareSherpaDev(ROOT_DIR);
          return { ok: true, code: 0 };
        } catch (error) {
          return { ok: false, code: null, error };
        }
      })(),
    });
    prepTasks.push({
      name: 'Prepare workspace search daemon',
      promise: (async () => {
        try {
          const { ensureFlashgrepBinary } = await import(
            pathToFileURL(path.join(__dirname, 'prepare-flashgrep-resource.mjs')).href
          );
          process.env.FLASHGREP_DAEMON_BIN = ensureFlashgrepBinary();
          return { ok: true, code: 0 };
        } catch (error) {
          return { ok: false, code: null, error };
        }
      })(),
    });
    prepTasks.push({
      name: 'Build mobile-web',
      promise: runCommandPrefixed('mobile-web', 'node', ['scripts/mobile-web-build.cjs', '--install']),
    });
  }

  const prepResults = await Promise.all(prepTasks.map((task) => task.promise));
  let prepFailed = false;
  prepResults.forEach((result, index) => {
    const task = prepTasks[index];
    if (result.ok) {
      return;
    }
    prepFailed = true;
    printError(`${task.name} failed`);
    if (result.error && result.error.message) {
      printError(result.error.message);
    }
    if (result.code !== null && result.code !== undefined && result.code !== 0) {
      printError(`Exit code: ${result.code}`);
    }
    if (task.hint) {
      printInfo(task.hint);
    }
  });
  if (prepFailed) {
    process.exit(1);
  }

  if (desktopMode) {
    const baselineHelperUrl = pathToFileURL(
      path.join(__dirname, 'frontend-workbench-dev-baseline.mjs')
    ).href;
    const { getFrontendWorkbenchDevBaselinePlan } = await import(baselineHelperUrl);
    const baselinePlan = getFrontendWorkbenchDevBaselinePlan(ROOT_DIR);
    if (baselinePlan.shouldBuild) {
      printInfo(`${baselinePlan.reason}; building the editable desktop frontend baseline`);
      const baselineResult = await runCommandPrefixed(
        'frontend-workbench',
        'pnpm',
        ['--dir', 'src/web-ui', 'run', 'build:desktop'],
      );
      if (!baselineResult.ok) {
        printError('FrontendWorkbench baseline build failed');
        if (baselineResult.error?.message) {
          printError(baselineResult.error.message);
        }
        if (baselineResult.code !== null && baselineResult.code !== undefined) {
          printError(`Exit code: ${baselineResult.code}`);
        }
        process.exit(1);
      }
    } else {
      printInfo(baselinePlan.reason);
    }
  }
  printSuccess('Preparation tasks complete');

  const prepTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Final step: Start dev server
  const startStepLabel = mode === 'desktop-preview'
    ? 'Start desktop preview'
    : 'Start dev server';
  printStep(currentStep, totalSteps, startStepLabel);
  printInfo(`Prep took ${prepTime}s`);
  
  printComplete('Initialization complete');
  
  try {
    if (mode === 'desktop') {
      const desktopDir = path.join(ROOT_DIR, 'src/apps/desktop');
      const tauriConfig = path.join(desktopDir, 'tauri.dev.conf.json');
      // Pin the same codegen-unit count the desktop-preview path uses
      // (rebuildDesktopDebugBinary). 256 is already cargo's dev default when
      // incremental compilation is on; pinning it keeps parallel codegen even
      // when CARGO_INCREMENTAL=0 drops the default to 16. An explicitly set
      // CARGO_PROFILE_DEV_CODEGEN_UNITS in the caller's environment wins.
      const tauriDevEnv = {
        ...process.env,
        CARGO_PROFILE_DEV_CODEGEN_UNITS: process.env.CARGO_PROFILE_DEV_CODEGEN_UNITS || '256',
        // Tauri copies bundle resources into target/debug at process startup.
        // Point Remote Connect at the live workspace dist so a newly generated
        // QR code never uploads a stale mobile-web bundle.
        OPENBITFUN_MOBILE_WEB_DIR: path.join(ROOT_DIR, 'src/mobile-web/dist'),
      };
      try {
        const args = ['dev', '--config', tauriConfig, '--config', JSON.stringify({ build: { devUrl: `http://localhost:${DEV_SERVER_PORT}` } })];
        if (process.platform === 'win32') {
          // Running the generated .cmd shim directly via spawn is flaky on Windows.
          // Use cmd.exe with an explicit args array so the desktop app directory
          // stays the Tauri project root without pnpm workspace path rewriting.
          const tauriBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tauri.cmd');
          await runWindowsCommandArgs(tauriBin, args, desktopDir, tauriDevEnv);
        } else {
          const tauriBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tauri');
          await spawnCommand(tauriBin, args, desktopDir, {
            CARGO_PROFILE_DEV_CODEGEN_UNITS: tauriDevEnv.CARGO_PROFILE_DEV_CODEGEN_UNITS,
            OPENBITFUN_MOBILE_WEB_DIR: tauriDevEnv.OPENBITFUN_MOBILE_WEB_DIR,
          });
        }
      } finally {
        // Option B: prune only when the desktop:dev session ends, not on each rebuild.
        await runDesktopTargetGc('debug');
      }
    } else if (mode === 'desktop-preview') {
      await ensureDesktopDebugBinaryForPreview(forceDesktopPreviewRebuild);
      await startDesktopPreview();
    } else {
      await runCommand('pnpm run dev', path.join(ROOT_DIR, 'src/web-ui'));
    }
  } catch (error) {
    printError('Dev server failed to start');
    if (error?.message) {
      printError(error.message);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  printError('Startup failed: ' + error.message);
  process.exit(1);
});
