/** Native regression for companion-window activation after adding browser child WebViews. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-browser-window-'));
const userRoot = path.join(root, 'user');
const productHome = path.join(root, 'home');
const frontend = path.join(root, 'frontend');
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const manifest = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
await cp(frontendSource, frontend, { recursive: true });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), manifest,
  'The frontend changed during the snapshot. Finish the build and rerun.');
await mkdir(userRoot, { recursive: true });
await mkdir(productHome, { recursive: true });
const binaryName = 'openbitfun-desktop' + (process.platform === 'win32' ? '.exe' : '');
const binarySource = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug', binaryName));
const binary = path.join(root, binaryName);
const before = await stat(binarySource);
await cp(binarySource, binary);
const after = await stat(binarySource);
assert.equal(before.mtimeMs, after.mtimeMs, 'The Desktop binary changed during the snapshot. Rerun after the build.');
assert.equal(before.size, after.size);

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const log = await open(path.join(root, 'desktop.log'), 'w');
const app = spawn(binary, [], {
  cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env,
    OPENBITFUN_USER_ROOT: userRoot, OPENBITFUN_E2E_USER_ROOT: userRoot,
    OPENBITFUN_HOME: productHome, OPENBITFUN_E2E_HOME: productHome,
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: frontend, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  },
});
console.log('Native browser window evidence: ' + root);
let exitError;
app.on('error', error => { exitError = error; });
let session;
const report = { passed: false, platform: process.platform, binarySource,
  binaryModified: before.mtime.toISOString(), frontendRevision: JSON.parse(manifest).revision, checks: [] };
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + route, {
    method, signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || (result.value?.error && result.value?.ok === undefined)) throw new Error(JSON.stringify(result));
  return result.value;
}
async function until(read, description, timeout = 45_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    if (exitError) throw exitError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Desktop exited before ' + description);
    try { if (await read()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ' + description + ': ' + (last ?? 'not ready'));
}
const execute = (fn, ...args) => request('/session/' + session + '/execute/sync', { script: fn.toString(), args });
const invokeResult = (command, args = {}) => execute(async (command, args) => {
  try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) }; }
  catch (error) { return { ok: false, error: String(error) }; }
}, command, args);
const invoke = (command, args = {}) => invokeResult(command, args).then(result => {
  assert.equal(result.ok, true, command + ': ' + result.error);
  return result.value;
});
const windowCommand = command => invoke('plugin:window|' + command, { label: 'main' });
async function verifyActivation(label) {
  await windowCommand('hide');
  await until(async () => !(await windowCommand('is_visible')), 'hidden main window');
  // Both the pet body and bubble use this production command to raise the host.
  await invoke('show_main_window');
  await until(async () => await windowCommand('is_visible') && !(await windowCommand('is_minimized')), 'shown main window');
  await windowCommand('minimize');
  await until(() => windowCommand('is_minimized'), 'minimized main window');
  await invoke('show_main_window');
  await until(async () => await windowCommand('is_visible') && !(await windowCommand('is_minimized')), 'restored main window');
  assert.equal(await windowCommand('is_focused'), true);
  report.checks.push(label + ': hide/show, minimize/restore and focus');
}
try {
  await until(async () => (await request('/status')).ready, 'embedded driver');
  session = (await request('/session', {})).sessionId;
  await request('/session/' + session + '/timeouts', { script: 10000 });
  await until(() => execute(() => !!document.querySelector('[data-testid=nav-workspace-new-session-btn]')), 'workspace navigation');
  await verifyActivation('without child WebViews');
  for (const index of [1, 2]) {
    // Use the native browser creation path with a loopback URL. Network loading
    // is irrelevant to window identity; no external account or page is required.
    await invoke('browser_webview_create', { request: {
      label: 'embedded-browser-panel-view-activation-' + index,
      url: endpoint + '/status', x: 400, y: 100, width: 300, height: 200,
    } });
    await invoke('plugin:webview|webview_show', { label: 'embedded-browser-panel-view-activation-' + index });
    await invoke('plugin:webview|set_webview_focus', { label: 'embedded-browser-panel-view-activation-' + index });
    await verifyActivation(index + ' browser child WebView(s)');
    const children = (await invoke('plugin:webview|get_all_webviews'))
      .filter(view => view.window_label === 'main');
    assert.equal(children.length, index + 1, 'Activation must retain the main frontend and all browser children');
  }
  const snapshot = await invoke('miniapp_presentation', { request: { operation: 'snapshot' } });
  assert.ok(Array.isArray(snapshot.instances), 'The main frontend must still reach MiniApp presentation commands');
  for (const command of ['frontend_update_candidate_ready', 'frontend_update_candidate_failed']) {
    const result = await invokeResult(command, { request: { transactionId: 'missing-native-test', message: 'fixture' } });
    assert.deepEqual(result, { ok: false, error: 'No frontend update is awaiting a decision' });
  }
  const dropResult = await invokeResult('resolve_browser_dropped_file_paths', { request: { token: 'invalid token', fileCount: 1 } });
  assert.deepEqual(dropResult, { ok: false, error: 'Invalid browser drop token' });
  const previewResult = await invokeResult('set_file_drop_preview_target', { request: { targetId: 'native-test', bounds: null } });
  assert.deepEqual(previewResult, process.platform === 'win32'
    ? { ok: true, value: null }
    : { ok: false, error: 'Native file drag previews are only available on Windows' });
  report.checks.push('main-WebView command extraction with browser children');
  // Remote browser children must remain blocked by Tauri's origin ACL, even
  // though their parent is the main window and the commands accept Webview.
  await request('/session/' + session + '/window', { handle: 'embedded-browser-panel-view-activation-1' });
  try {
    await until(() => execute(() => !!window.__TAURI_INTERNALS__), 'browser child IPC');
    const result = await invokeResult('miniapp_presentation', { request: { operation: 'snapshot' } });
    assert.deepEqual(result, { ok: false, error: 'miniapp_presentation not allowed. Plugin not found' });
    const capture = await invokeResult('miniapp_market_capture_window');
    assert.deepEqual(capture, { ok: false, error: 'miniapp_market_capture_window not allowed. Plugin not found' });
  } finally {
    await request('/session/' + session + '/window', { handle: 'main' });
  }
  report.checks.push('remote browser children retain their origin ACL restrictions');
  await invoke('debug_open_devtools');
  await invoke('debug_close_devtools');
  report.checks.push('main frontend DevTools with browser children');
  await invoke('minimize_to_tray');
  assert.equal(await windowCommand('is_visible'), false);
  await invoke('show_main_window');
  await until(() => windowCommand('is_visible'), 'main window after tray hide');
  report.checks.push('tray hide/show with browser children');
  await invoke('set_main_window_transient_geometry', { request: { transient: true } });
  await invoke('set_main_window_transient_geometry', { request: { transient: false } });
  report.checks.push('window state persistence with browser children');
  for (const index of [1, 2]) {
    await invoke('plugin:webview|webview_close', { label: 'embedded-browser-panel-view-activation-' + index });
  }
  await verifyActivation('after closing browser children');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  if (session) await request('/session/' + session, undefined, 'DELETE').catch(() => {});
  if (app.exitCode === null && app.signalCode === null) {
    app.kill();
    await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  }
  await log.close();
  if (process.env.OPENBITFUN_E2E_KEEP_SNAPSHOT !== '1') {
    await rm(binary, { force: true });
    await rm(frontend, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...report, artifactRoot: root }));
}
