/** Live signed-update workflow. Real Desktop, release endpoints and isolated persistent storage; never installs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.platform, 'win32', 'This live updater runner uses the Windows isolated persistent WebView');
if (process.argv.includes('--build')) {
  const verificationGuide = await readFile(path.join(repo, 'docs/verify-downloads.md'), 'utf8');
  const publicKey = verificationGuide.match(/Public key: `(RW[A-Za-z0-9+/=]+)`/)?.[1];
  assert.ok(publicKey, 'The documented release public key is required for live signature verification');
  const config = JSON.parse(process.env.TAURI_CONFIG || '{}');
  config.identifier ??= 'com.openbitfun.desktop.dev';
  config.plugins = { ...config.plugins, updater: {
    ...config.plugins?.updater,
    pubkey: Buffer.from('untrusted comment: minisign public key\n' + publicKey + '\n').toString('base64'),
    endpoints: ['https://github.com/GCWing/OpenBitFun/releases/latest/download/latest-v1.json', 'https://openbitfun.com/release/latest-v1.json'],
  } };
  const build = spawn('cargo', ['build', '-p', 'openbitfun-desktop'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TAURI_CONFIG: JSON.stringify(config) },
  });
  const [code] = await once(build, 'exit');
  assert.equal(code, 0, 'Desktop build failed');
}
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-app-update-'));
const userRoot = path.join(root, 'user');
const productHome = path.join(root, 'home');
const frontend = path.join(root, 'frontend');
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const manifest = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
await cp(frontendSource, frontend, { recursive: true });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), manifest,
  'The frontend build changed during the snapshot. Finish the build and rerun.');
assert.equal(await readFile(path.join(frontend, 'frontend-revision.json'), 'utf8'), manifest);
await mkdir(userRoot, { recursive: true });
await mkdir(productHome, { recursive: true });
const binaryName = 'openbitfun-desktop' + (process.platform === 'win32' ? '.exe' : '');
const binarySource = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug', binaryName));
const binary = path.join(root, binaryName);
const binaryStat = await stat(binarySource);
await cp(binarySource, binary);
const afterCopy = await stat(binarySource);
assert.equal(afterCopy.mtimeMs, binaryStat.mtimeMs, 'The Desktop binary changed during the snapshot. Rerun after the build.');
assert.equal(afterCopy.size, binaryStat.size);
assert.equal((await stat(binary)).size, binaryStat.size);

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const log = await open(path.join(root, 'desktop.log'), 'w');
const launch = () => spawn(binary, [], {
  cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env,
    OPENBITFUN_USER_ROOT: userRoot, OPENBITFUN_E2E_USER_ROOT: userRoot,
    OPENBITFUN_HOME: productHome, OPENBITFUN_E2E_HOME: productHome,
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: frontend, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
    OPENBITFUN_E2E_PERSISTENT_WEBVIEW: '1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(userRoot, 'data', 'e2e-webview'),
  },
});
let app = launch();
console.log('Native app update evidence: ' + root);
let exitError;
app.on('error', error => { exitError = error; });
let session;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const observations = [];
const pendingPath = path.join(userRoot, 'data', 'app-updates', 'pending.json');
const report = { passed: false, platform: process.platform, frontendSource, frontendRevision: JSON.parse(manifest).revision,
  binarySource, binaryModified: binaryStat.mtime.toISOString(),
  artifactRoot: root, checks: [], observations };
await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));

async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + route, {
    method, signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}

async function until(read, description, timeout = 45_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    if (exitError) throw exitError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Desktop exited before ' + description);
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ' + description + ': ' + (last ?? 'not ready'));
}

const execute = (fn, ...args) => request('/session/' + session + '/execute/sync', { script: fn.toString(), args });
const locate = selector => request('/session/' + session + '/element', { using: 'css selector', value: selector });
const elementAction = (element, action, body = {}) => request('/session/' + session + '/element/' + element[elementKey] + '/' + action, body);
const click = async selector => elementAction(await locate(selector), 'click');

async function activateTestWindow() {
  if (process.platform !== 'win32') return;
  // Activate this isolated process only. A background Tauri setFocus request can be
  // refused by Windows; DOM focus shims would not test the actual foreground gate.
  const activation = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `(New-Object -ComObject WScript.Shell).AppActivate(${app.pid}) | Out-Null`], {
    windowsHide: true, stdio: 'ignore',
  });
  await once(activation, 'exit');
}

class AppUpdatePage {
  present(selector) { return execute(selector => {
    const el = document.querySelector(selector);
    return Boolean(el && el.getBoundingClientRect().width > 0 && !el.closest('[inert]'));
  }, selector); }
  wait(selector, timeout) { return until(() => this.present(selector), selector, timeout); }
  click(id) { return click(`[data-testid="${id}"]`); }
  snapshot() { return execute(() => ({
    discovery: JSON.parse(localStorage.getItem('openbitfun:update:checkSnapshot') ?? 'null'),
    reminders: JSON.parse(localStorage.getItem('openbitfun:update:reminders') ?? '{}'),
    skipped: localStorage.getItem('openbitfun:update:skippedVersion'),
    foreground: document.hasFocus(), visibility: document.visibilityState,
  })); }
  async checkManually() {
    await this.click('nav-footer-settings-item');
    await this.wait('[data-testid=nav-check-updates]');
    await this.click('nav-check-updates');
    await this.wait('[data-testid=app-update-download]');
  }
  async reload() {
    await execute(() => { setTimeout(() => location.reload(), 0); return true; });
    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.wait('[data-testid=nav-footer-settings-item]');
    await activateTestWindow();
    await execute(async () => { await window.__TAURI__.window.getCurrentWindow().setFocus(); await window.__TAURI__.webview.getCurrentWebview().setFocus(); window.focus(); return true; });
    await this.click('nav-workspace-new-session-btn');
    await until(() => execute(() => document.hasFocus()), 'the native WebView to gain focus');
    // Let the real five-second startup gate settle; no fake timers or API replacements.
    await new Promise(resolve => setTimeout(resolve, 6500));
  }
}
const page = new AppUpdatePage();
async function record(label) {
  report.checks.push(label);
  observations.push({ label, state: await page.snapshot() });
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log('PASS: ' + label);
}
async function attach() {
  await until(async () => (await request('/status')).ready, 'embedded driver');
  session = (await request('/session', {})).sessionId;
  await request('/session/' + session + '/timeouts', { script: 10000 });
  await page.wait('[data-testid=nav-footer-settings-item]');
  await activateTestWindow();
  await execute(async () => { await window.__TAURI__.window.getCurrentWindow().setFocus(); await window.__TAURI__.webview.getCurrentWebview().setFocus(); window.focus(); return true; });
  await page.click('nav-workspace-new-session-btn');
  await until(() => execute(() => document.hasFocus()), 'the native WebView to gain focus');
}
async function stop() {
  if (session && app.exitCode === null && app.signalCode === null) {
    await execute(() => { setTimeout(() => { void window.__TAURI__.core.invoke('quit_app', { request: {} }); }, 0); return true; }).catch(() => {});
    await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 10000))]);
  }
  if (session) await request('/session/' + session, undefined, 'DELETE').catch(() => {});
  session = null;
  if (app.exitCode === null && app.signalCode === null) {
    app.kill();
    await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
}
try {
  await attach();
  report.currentVersion = await execute(() => window.__TAURI__.core.invoke('get_app_version', { request: {} }));
  await page.wait('[data-testid=app-update-download]', 60000);
  let snapshot = await page.snapshot();
  assert.equal(snapshot.discovery.result.updateAvailable, true, 'A genuinely newer public release is required');
  report.releaseVersion = snapshot.discovery.result.latestVersion;
  const checkedAt = snapshot.discovery.checkedAt;
  await record('startup discovers the real public release and presents its notice');

  await page.click('app-update-later');
  assert.ok((await page.snapshot()).reminders.available.deferredAt);
  await page.reload();
  assert.equal(await page.present('[data-testid=app-update-notice]'), false);
  assert.equal((await page.snapshot()).discovery.checkedAt, checkedAt);
  await record('startup reuses recent discovery and preserves the explicit deferral');

  // Age only the real persisted dismissal in this isolated profile to exercise 24-hour expiry.
  // Network responses, package bytes, runtime state and the system clock remain untouched.
  await execute(() => {
    const key = 'openbitfun:update:reminders';
    const reminders = JSON.parse(localStorage.getItem(key));
    reminders.available.deferredAt -= 25 * 60 * 60 * 1000;
    localStorage.setItem(key, JSON.stringify(reminders));
    return true;
  });
  await page.reload();
  await page.wait('[data-testid=app-update-download]');
  assert.equal((await page.snapshot()).discovery.checkedAt, checkedAt);
  await record('an expired reminder is presented from cache without rechecking the release');

  await page.click('app-update-skip');
  await page.reload();
  assert.equal((await page.snapshot()).skipped, report.releaseVersion);
  assert.equal(await page.present('[data-testid=app-update-notice]'), false);
  await page.checkManually();
  await record('skip survives reload while manual discovery can still present the release');

  await page.click('app-update-download');
  await execute(async () => { await window.__TAURI__.window.getCurrentWindow().minimize(); return true; });
  const pending = await until(async () => {
    try { return JSON.parse(await readFile(pendingPath, 'utf8')); } catch { return null; }
  }, 'the verified public package to be saved in isolated storage', 600000);
  assert.equal(pending.version, report.releaseVersion);
  const packagePath = path.join(path.dirname(pendingPath), pending.sha256 + '.package');
  assert.ok((await stat(packagePath)).size > 1024 * 1024, 'Must stage the real release package');
  report.pending = { version: pending.version, platform: pending.platform, packageBytes: (await stat(packagePath)).size };
  assert.equal(await page.present('[data-testid=app-update-install-dialog]'), false);
  await record('download and signature verification finish in the background without opening installation');

  await activateTestWindow();
  await execute(async () => {
    const win = window.__TAURI__.window.getCurrentWindow();
    await win.unminimize(); await win.show(); await win.setFocus(); await window.__TAURI__.webview.getCurrentWebview().setFocus(); window.focus(); return true;
  });
  await page.click('nav-workspace-new-session-btn');
  await page.wait('[data-testid=app-update-install-dialog]');
  await page.wait('[data-testid=app-update-install-confirm]');
  await record('returning to the foreground automatically opens installation confirmation');
  await page.click('app-update-install-later');
  snapshot = await page.snapshot();
  assert.ok(snapshot.reminders.ready.deferredAt);
  report.deferredBeforeRestart = snapshot.reminders.ready;
  await new Promise(resolve => setTimeout(resolve, 1500));
  await stop();
  app = launch();
  app.on('error', error => { exitError = error; });
  await attach();
  await new Promise(resolve => setTimeout(resolve, 6500));
  report.afterRestart = await page.snapshot();
  assert.equal(await page.present('[data-testid=app-update-install-dialog]'), false);
  await page.wait('[data-testid=nav-update-download-button]');
  await page.click('nav-update-download-button');
  await page.wait('[data-testid=app-update-install-dialog]');
  await record('a real process restart preserves deferral and keeps the package manually installable');
  await page.click('app-update-install-later');
  assert.equal(await execute(() => window.__TAURI__.core.invoke('get_app_version', { request: {} })), report.currentVersion);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (session) {
    report.failureState = await page.snapshot().catch(String);
    report.failure = await execute(() => ({ url: location.href, text: document.body?.innerText.slice(0, 3500),
      focus: document.hasFocus(), visibility: document.visibilityState })).catch(String);
  }
  console.error('Native update regression failed. Artifacts: ' + root);
  throw error;
} finally {
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  await stop();
  await log.close();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, artifactRoot: root }));
}
