/** Native regression for workspace HTML resources in actual native browser child WebViews. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-html-preview-'));
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
console.log('Native HTML preview evidence: ' + root);
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
const workspace = path.join(root, 'workspace');
for (const [directory, color, marker] of [['site/dist', 'rgb(23, 81, 139)', 'first'], ['other/build', 'rgb(163, 45, 18)', 'second']]) {
  const site = path.join(workspace, directory);
  await mkdir(path.join(site, 'assets'), { recursive: true });
  await writeFile(path.join(site, 'index #1.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css?version=1"><link rel="stylesheet" href="../shared.css"></head><body><main id="result">waiting</main><img id="image" src="/assets/pixel.png"><script type="module" src="./assets/main.mjs?version=1"></script></body></html>');
  await writeFile(path.join(site, 'assets/app.css'), '#result { color: ' + color + '; }');
  await writeFile(path.join(site, '../shared.css'), '#result { letter-spacing: 3px; }');
  await writeFile(path.join(site, 'assets/main.mjs'), 'const { marker } = await import("./chunk.mjs"); document.querySelector("#result").textContent = marker;');
  await writeFile(path.join(site, 'assets/chunk.mjs'), 'export const marker = ' + JSON.stringify(marker) + ';');
  await writeFile(path.join(site, 'assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
}
const spa = path.join(workspace, 'website #1/dist');
await mkdir(path.join(spa, 'assets'), { recursive: true });
await writeFile(path.join(spa, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><main id="route">loading</main><a id="navigate" href="/evaluation">Evaluation</a><img id="image" src="/assets/pixel.png"><script type="module" src="/assets/app.mjs"></script></body></html>');
await writeFile(path.join(spa, 'assets/app.css'), '#route { color: rgb(23, 81, 139); } @keyframes reveal { from { opacity: 0; } to { opacity: 1; } } #image { animation: reveal 120ms both; }');
await writeFile(path.join(spa, 'assets/app.mjs'), 'const { routes } = await import("./routes.mjs"); document.querySelector("#route").textContent = routes.includes(location.pathname) ? location.pathname : "PAGE NOT FOUND";');
await writeFile(path.join(spa, 'assets/routes.mjs'), 'export const routes = ["/", "/evaluation", "/docs/detail"];');
await cp(path.join(workspace, 'site/dist/assets/pixel.png'), path.join(spa, 'assets/pixel.png'));
const previews = [];
async function checkPage(label, marker, color) {
  await invoke('plugin:webview|webview_show', { label });
  await request('/session/' + session + '/window', { handle: label });
  try {
    await until(() => execute((marker, color) => {
      const result = document.querySelector('#result');
      const image = document.querySelector('#image');
      return result?.textContent === marker && getComputedStyle(result).color === color
        && getComputedStyle(result).letterSpacing === '3px' && image?.complete && image.naturalWidth === 1;
    }, marker, color), 'HTML, CSS, module import and image for ' + marker);
    const details = await execute(() => ({ url: location.href, text: document.querySelector('#result').textContent,
      color: getComputedStyle(document.querySelector('#result')).color,
      resources: performance.getEntriesByType('resource').map(entry => entry.name) }));
    assert.ok(!details.url.includes('previewToken='), 'Bootstrap token must leave the document URL');
    assert.ok(details.url.endsWith('/index%20%231.html'));
    report.checks.push(details);
  } finally {
    await request('/session/' + session + '/window', { handle: 'main' });
    await invoke('plugin:webview|webview_hide', { label });
  }
}
async function checkRoute(route) {
  await until(() => execute(route => {
    const result = document.querySelector('#route');
    const image = document.querySelector('#image');
    return document.visibilityState === 'visible' && location.pathname === route && result?.textContent === route
      && getComputedStyle(result).color === 'rgb(23, 81, 139)'
      && image?.complete && image.naturalWidth === 1 && getComputedStyle(image).opacity === '1';
  }, route), 'site route and resources for ' + route);
  report.checks.push(await execute(() => ({ url: location.href,
    route: document.querySelector('#route').textContent, imageWidth: document.querySelector('#image').naturalWidth,
    resources: performance.getEntriesByType('resource').map(entry => entry.name) })));
}
try {
  await until(async () => (await request('/status')).ready, 'embedded driver');
  session = (await request('/session', {})).sessionId;
  await request('/session/' + session + '/timeouts', { script: 10000 });
  await until(() => execute(() => !!window.__TAURI_INTERNALS__), 'main frontend');
  await invoke('show_main_window');
  const opened = await invoke('open_workspace', { request: { path: workspace, createLocal: true } });
  for (const [directory, marker, color] of [['site/dist', 'first', 'rgb(23, 81, 139)'], ['other/build', 'second', 'rgb(163, 45, 18)']]) {
    const preview = await invoke('html_preview_create', { request: { workspaceId: opened.id,
      filePath: path.join(workspace, directory, 'index #1.html') } });
    previews.push(preview);
    const label = 'embedded-browser-panel-view-html-' + marker;
    await invoke('browser_webview_create', { request: { label, url: preview.url, x: 350, y: 80, width: 480, height: 320 } });
    await checkPage(label, marker, color);
  }
  // The second preview must not replace the first preview's authorization cookie.
  await request('/session/' + session + '/window', { handle: 'embedded-browser-panel-view-html-first' });
  await request('/session/' + session + '/refresh', {});
  await request('/session/' + session + '/window', { handle: 'main' });
  await checkPage('embedded-browser-panel-view-html-first', 'first', 'rgb(23, 81, 139)');
  const sitePreview = await invoke('html_preview_create', { request: { workspaceId: opened.id,
    filePath: path.join(spa, 'index.html') } });
  previews.push(sitePreview);
  const siteLabel = 'embedded-browser-panel-view-html-site';
  await invoke('browser_webview_create', { request: { label: siteLabel, url: sitePreview.url, x: 350, y: 80, width: 480, height: 320 } });
  await invoke('plugin:webview|webview_show', { label: siteLabel });
  await request('/session/' + session + '/window', { handle: siteLabel });
  await checkRoute('/');
  await execute(() => document.querySelector('#navigate').click());
  await checkRoute('/evaluation');
  await request('/session/' + session + '/refresh', {});
  await checkRoute('/evaluation');
  const siteOrigin = new URL(sitePreview.url).origin;
  await request('/session/' + session + '/url', { url: siteOrigin + '/docs/detail?lang=en' });
  await checkRoute('/docs/detail');
  assert.equal(await execute(() => location.search), '?lang=en');
  const missing = await execute(async () => {
    const reply = await fetch('/assets/missing.png', { headers: { accept: 'image/png' } });
    return { status: reply.status, body: await reply.text() };
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body, 'Preview resource not found');
  await request('/session/' + session + '/window', { handle: 'main' });
  for (const preview of previews) await invoke('html_preview_release', { request: { sessionId: preview.sessionId } });
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
