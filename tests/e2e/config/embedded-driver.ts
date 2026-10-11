import type { Options } from '@wdio/types';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DRIVER_HOST = '127.0.0.1';
const DRIVER_PORT = Number(process.env.OPENBITFUN_E2E_WEBDRIVER_PORT || 4445);
const DEV_SERVER_HOST = '127.0.0.1';
const DEV_SERVER_PORT = 1422;

let openbitfunApp: ChildProcess | null = null;
let devServerProcess: ChildProcess | null = null;
let ownsDevServer = false;

function projectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function e2eRuntimeRoot(): string {
  return process.env.OPENBITFUN_E2E_STORAGE_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_STORAGE_ROOT)
    : path.join(projectRoot(), 'tests', 'e2e', '.openbitfun', 'runtime');
}

function setDefaultEnvPath(name: string, value: string): void {
  if (!process.env[name]) {
    process.env[name] = value;
  }
}

function ensureIsolatedE2eStorageEnv(): void {
  if (process.env.OPENBITFUN_E2E_USE_REAL_PROFILE === '1') {
    delete process.env.OPENBITFUN_E2E_STORAGE_GUARD;
    return;
  }

  const root = e2eRuntimeRoot();
  const userRoot = process.env.OPENBITFUN_E2E_USER_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_USER_ROOT)
    : path.join(root, 'user-root');
  const homeRoot = process.env.OPENBITFUN_E2E_HOME
    ? path.resolve(process.env.OPENBITFUN_E2E_HOME)
    : path.join(root, 'home');

  process.env.OPENBITFUN_E2E_USER_ROOT = userRoot;
  process.env.OPENBITFUN_USER_ROOT = userRoot;
  process.env.OPENBITFUN_E2E_HOME = homeRoot;
  process.env.OPENBITFUN_HOME = homeRoot;
  process.env.OPENBITFUN_E2E_STORAGE_GUARD = '1';
  setDefaultEnvPath('OPENBITFUN_E2E_LOG_DIR', path.join(root, 'logs'));
  fs.mkdirSync(root, { recursive: true });
}

ensureIsolatedE2eStorageEnv();

type BrowserLogEntry = {
  level: string;
  message: string;
  timestamp: number;
};

type E2eBuildType = 'debug' | 'release' | 'release-fast';

function executableCandidates(buildType: E2eBuildType): string[] {
  const root = projectRoot();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `openbitfun-desktop${suffix}`;

  if (process.platform === 'darwin') {
    return [
      path.join(root, 'target', buildType, binaryName),
      path.join(root, 'target', buildType, 'OpenBitFun.app', 'Contents', 'MacOS', 'OpenBitFun'),
    ];
  }

  return [path.join(root, 'target', buildType, binaryName)];
}

export function getApplicationPath(): string {
  const forcedPath = process.env.OPENBITFUN_E2E_APP_PATH;
  const forcedMode = process.env.OPENBITFUN_E2E_APP_MODE?.toLowerCase();

  if (forcedPath) {
    return forcedPath;
  }

  if (forcedMode === 'debug') {
    return executableCandidates('debug')[0];
  }

  if (forcedMode === 'release-fast') {
    return executableCandidates('release-fast')[0];
  }

  if (forcedMode === 'release') {
    return executableCandidates('release')[0];
  }

  const debugMatch = executableCandidates('debug').find(candidate => fs.existsSync(candidate));
  if (debugMatch) {
    return debugMatch;
  }

  throw new Error(
    `Debug desktop build not found. Expected one of: ${executableCandidates('debug').join(', ')}`
  );
}

async function waitForDevServerIfNeeded(appPath: string): Promise<void> {
  if (process.env.OPENBITFUN_E2E_PACKAGED_FRONTEND === '1') return;
  if (!appPath.includes(`${path.sep}debug${path.sep}`)) {
    return;
  }

  const running = await isPortOpen(DEV_SERVER_PORT, [DEV_SERVER_HOST, '::1']);

  if (running) {
    console.log(`Dev server is already running on port ${DEV_SERVER_PORT}`);
    return;
  }

  await startDevServer();
}

async function fetchDriverStatus(): Promise<boolean> {
  try {
    const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/status`);
    if (!response.ok) {
      return false;
    }
    const body = await response.json() as { value?: { ready?: boolean } };
    return body.value?.ready === true;
  } catch {
    return false;
  }
}

async function createProbeSession(): Promise<string> {
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`Failed to create probe session: ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { value?: { sessionId?: string } };
  const sessionId = body.value?.sessionId;
  if (!sessionId) {
    throw new Error('Probe session did not return a session id');
  }
  return sessionId;
}

async function deleteProbeSession(sessionId: string): Promise<void> {
  await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function setProbeScriptTimeout(sessionId: string, timeoutMs: number): Promise<void> {
  await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}/timeouts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ script: timeoutMs }),
  }).catch(() => undefined);
}

async function probeDocumentReady(sessionId: string): Promise<boolean> {
  await setProbeScriptTimeout(sessionId, 1000);
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}/execute/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      script: `() => {
        const root = document.getElementById('root');
        const appLayout = document.querySelector('[data-testid="app-layout"], .openbitfun-app-layout');
        const mainContent = document.querySelector('[data-testid="app-main-content"], .openbitfun-app-main-workspace');
        const shell = document.querySelector(
          '.openbitfun-nav-panel, .openbitfun-scene-bar, .openbitfun-nav-bar, .welcome-scene'
        );
        const splashVisible = Boolean(document.querySelector('.splash-screen'));
        const tauriReady =
          typeof window.__TAURI__ !== 'undefined' ||
          typeof window.__TAURI_INTERNALS__ !== 'undefined';

        return Boolean(
          document?.body &&
          root &&
          root.childElementCount > 0 &&
          appLayout &&
          mainContent &&
          shell &&
          tauriReady &&
          !splashVisible
        );
      }`,
      args: [],
    }),
  });

  if (!response.ok) {
    throw new Error(`Document ready probe failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { value?: boolean };
  return body.value === true;
}

async function waitForEmbeddedDriverReady(timeoutMs: number = 30000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await fetchDriverStatus()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Embedded WebDriver did not become ready within ${timeoutMs}ms`);
}

async function waitForWebviewDocumentReady(timeoutMs: number = 30000): Promise<void> {
  const startedAt = Date.now();
  let lastError = 'OpenBitFun app shell is not ready';

  while (Date.now() - startedAt < timeoutMs) {
    let sessionId: string | null = null;

    try {
      sessionId = await createProbeSession();
      const ready = await probeDocumentReady(sessionId);
      if (ready) {
        await deleteProbeSession(sessionId);
        return;
      }
      lastError = 'OpenBitFun app shell is not ready';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (sessionId) {
        await deleteProbeSession(sessionId);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Webview document did not become ready within ${timeoutMs}ms: ${lastError}`);
}

async function fetchSessionLogs(
  sessionId: string,
  logType: string,
): Promise<BrowserLogEntry[]> {
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}/se/log`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: logType }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch logs: ${response.status} ${body}`);
  }

  const payload = await response.json() as { value?: BrowserLogEntry[] };
  return payload.value ?? [];
}

function stopOpenBitFunApp(): void {
  if (!openbitfunApp) {
    return;
  }

  openbitfunApp.kill();
  openbitfunApp = null;
}

function stopDevServer(): void {
  if (!devServerProcess || !ownsDevServer) {
    return;
  }

  devServerProcess.kill();
  devServerProcess = null;
  ownsDevServer = false;
}

async function isPortOpen(port: number, hosts: string[]): Promise<boolean> {
  return Promise.any(hosts.map(host => {
    return new Promise<boolean>((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(2000);
      client.connect(port, host, () => {
        client.destroy();
        resolve(true);
      });
      client.on('error', error => {
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

async function waitForPort(port: number, hosts: string[], timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port, hosts)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

async function startDevServer(): Promise<void> {
  if (devServerProcess) {
    await waitForPort(DEV_SERVER_PORT, [DEV_SERVER_HOST, '::1'], 60000);
    return;
  }

  console.log(`Starting dev server on http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`);

  const spawnOptions = {
    cwd: projectRoot(),
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    env: {
      ...process.env,
      TAURI_DEV_HOST: DEV_SERVER_HOST,
    },
  };

  if (process.platform === 'win32') {
    const commandLine = [
      'pnpm',
      '--dir',
      'src/web-ui',
      'exec',
      'vite',
      '--force',
      '--host',
      DEV_SERVER_HOST,
      '--port',
      String(DEV_SERVER_PORT),
    ].join(' ');

    devServerProcess = spawn(
      process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', commandLine],
      spawnOptions,
    );
  } else {
    devServerProcess = spawn(
      'pnpm',
      [
        '--dir',
        'src/web-ui',
        'exec',
        'vite',
        '--force',
        '--host',
        DEV_SERVER_HOST,
        '--port',
        String(DEV_SERVER_PORT),
      ],
      spawnOptions,
    );
  }
  ownsDevServer = true;

  devServerProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[dev-server] ${data.toString().trim()}`);
  });

  devServerProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[dev-server] ${data.toString().trim()}`);
  });

  devServerProcess.on('exit', (code, signal) => {
    console.log(`[dev-server] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    devServerProcess = null;
    ownsDevServer = false;
  });

  try {
    await waitForPort(DEV_SERVER_PORT, [DEV_SERVER_HOST, '::1'], 60000);
  } catch (error) {
    stopDevServer();
    throw error;
  }
}

/**
 * File the app's stdout/stderr is mirrored into for this run.
 *
 * In embedded WebDriver mode the app logs to stdout only (`build_log_targets`
 * skips every file target when `OPENBITFUN_WEBDRIVER_PORT` is set), so the
 * per-session `app.log` a spec would normally read never exists. Mirroring
 * stdout keeps the host log evidence durable and readable by specs.
 */
function appStdoutLogPath(): string {
  const directory = process.env.OPENBITFUN_E2E_LOG_DIR
    ? path.resolve(process.env.OPENBITFUN_E2E_LOG_DIR)
    : path.join(e2eRuntimeRoot(), 'logs');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(directory, `app-stdout-${stamp}.log`);
}

async function startOpenBitFunApp(): Promise<void> {
  const appPath = getApplicationPath();

  if (!fs.existsSync(appPath)) {
    console.error(`Application not found at: ${appPath}`);
    console.error('Please build the selected application first. Common commands:');
    console.error('cargo build -p openbitfun-desktop');
    console.error('pnpm run desktop:build:release-fast');
    throw new Error('Application not built');
  }

  await waitForDevServerIfNeeded(appPath);

  stopOpenBitFunApp();

  const stdoutLogPath = appStdoutLogPath();
  const stdoutLogStream = fs.createWriteStream(stdoutLogPath, { flags: 'a' });

  console.log(`Starting OpenBitFun with embedded WebDriver on port ${DRIVER_PORT}`);
  console.log(`Application: ${appPath}`);
  console.log(`Application stdout log: ${stdoutLogPath}`);

  openbitfunApp = spawn(appPath, [], {
    cwd: projectRoot(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENBITFUN_WEBDRIVER_PORT: String(DRIVER_PORT),
      OPENBITFUN_WEBDRIVER_LABEL: 'main',
    },
  });

  openbitfunApp.stdout?.on('data', (data: Buffer) => {
    stdoutLogStream.write(data);
    console.log(`[openbitfun-app] ${data.toString().trim()}`);
  });

  openbitfunApp.stderr?.on('data', (data: Buffer) => {
    stdoutLogStream.write(data);
    console.error(`[openbitfun-app] ${data.toString().trim()}`);
  });

  openbitfunApp.on('exit', (code, signal) => {
    stdoutLogStream.end();
    console.log(`[openbitfun-app] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  });

  await waitForEmbeddedDriverReady();
  await waitForWebviewDocumentReady();
  console.log(`Embedded WebDriver is ready on http://${DRIVER_HOST}:${DRIVER_PORT}`);
}

function sharedAfterTest(): Options.Testrunner['afterTest'] {
  return async function afterTest(test, _context, { error, passed }) {
    const isRealFailure = !passed && !!error;
    if (!isRealFailure) {
      return;
    }

    if (process.platform === 'linux') {
      console.warn('Skipping failure screenshot on linux');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotName = `failure-${test.title.replace(/\s+/g, '_')}-${timestamp}.png`;

    try {
      const screenshotDirectory = path.resolve(__dirname, '..', 'reports', 'screenshots');
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      const screenshotPath = path.join(screenshotDirectory, screenshotName);
      await browser.saveScreenshot(screenshotPath);
      console.log(`Screenshot saved: ${screenshotName}`);
    } catch (screenshotError) {
      console.error('Failed to save screenshot:', screenshotError);
    }
  };
}

export function createEmbeddedConfig(specs: string[], label: string): Options.Testrunner {
  return {
    runner: 'local',
    autoCompileOpts: {
      autoCompile: true,
      tsNodeOpts: {
        transpileOnly: true,
        project: path.resolve(__dirname, '..', 'tsconfig.json'),
      },
    },

    specs,
    exclude: [],

    maxInstances: 1,
    capabilities: [{
      maxInstances: 1,
      browserName: 'openbitfun',
      'openbitfun:embedded': true,
    } as any],

    logLevel: (process.env.E2E_LOG_LEVEL || 'info') as Options.Testrunner['logLevel'],
    bail: 0,
    baseUrl: '',
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,

    services: [],
    hostname: DRIVER_HOST,
    port: DRIVER_PORT,
    path: '/',
    // Node 26's built-in Undici rejects the hop-by-hop `Connection` header
    // that WebDriverIO 9 adds by default. The embedded driver is a local HTTP
    // endpoint and does not need callers to manage connection persistence.
    transformRequest: (requestOptions) => {
      const headers = requestOptions.headers as {
        delete?: (name: string) => void;
      } | undefined;
      headers?.delete?.('Connection');
      headers?.delete?.('Content-Length');
      return requestOptions;
    },

    framework: 'mocha',
    reporters: ['spec'],

    mochaOpts: {
      ui: 'bdd',
      // WebdriverIO snapshots this value into a hard wall-clock cap when a test
      // starts, so a spec's own `this.timeout(...)` cannot raise it afterwards.
      // Specs that legitimately run for minutes (real model turns, memory
      // consolidation) raise it through the environment instead of changing the
      // default for every suite.
      timeout: Number(process.env.OPENBITFUN_E2E_MOCHA_TIMEOUT ?? 120000),
      retries: 0,
    },

    onPrepare: async function onPrepare() {
      console.log(`Preparing ${label} E2E test run...`);
      const appPath = getApplicationPath();

      if (!fs.existsSync(appPath)) {
        console.error(`Application not found at: ${appPath}`);
        console.error('Please build the selected application first. Common commands:');
        console.error('cargo build -p openbitfun-desktop');
        console.error('pnpm run desktop:build:release-fast');
        throw new Error('Application not built');
      }

      console.log(`application: ${appPath}`);
      await waitForDevServerIfNeeded(appPath);
    },

    beforeSession: async function beforeSession() {
      await startOpenBitFunApp();
    },

    before: async function before() {
      const browserWithLogs = browser as WebdriverIO.Browser & {
        getLogs?: (logType: string) => Promise<BrowserLogEntry[]>;
      };

      if (typeof browserWithLogs.getLogs !== 'function') {
        browser.addCommand('getLogs', async function (this: WebdriverIO.Browser, logType: string) {
          return fetchSessionLogs(this.sessionId, logType);
        });
      }
    },

    afterSession: function afterSession() {
      console.log('Stopping OpenBitFun app...');
      stopOpenBitFunApp();
    },

    afterTest: sharedAfterTest(),

    onComplete: function onComplete() {
      console.log(`${label} E2E test run completed`);
      stopOpenBitFunApp();
      stopDevServer();
    },
  };
}
