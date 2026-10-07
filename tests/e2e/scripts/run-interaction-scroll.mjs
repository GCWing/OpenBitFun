/** Real packaged desktop regression for driver reveal/focus and shell geometry. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-interaction-scroll-'));
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
console.log('Native interaction scroll evidence: ' + root);
let exitError;
app.on('error', error => { exitError = error; });
let session;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const observations = [];
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
const settle = () => execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
const pointerClick = target => request('/session/' + session + '/actions', { actions: [{ type: 'pointer', id: 'mouse',
  parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', origin: target, x: 0, y: 0 },
    { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
  ] }] });

function chromeGeometry() {
  const bar = [...document.querySelectorAll('.openbitfun-scene-top-bar')].find(el => el.getBoundingClientRect().width > 0);
  const surface = bar?.closest('.openbitfun-workspace-body__scene-surface');
  const tab = bar?.querySelector('[role=tab]');
  if (!surface) return null;
  return { surfaceScrollLeft: surface.scrollLeft, surfaceScrollTop: surface.scrollTop,
    barScrollLeft: bar.scrollLeft, barScrollTop: bar.scrollTop,
    tabGap: tab ? tab.getBoundingClientRect().left - surface.getBoundingClientRect().left : null,
    barPadding: getComputedStyle(bar).paddingLeft };
}

async function stableChrome(label, operation) {
  const before = await execute(chromeGeometry);
  assert.ok(before, 'Scene chrome must be present');
  await operation();
  await settle();
  const after = await execute(chromeGeometry);
  observations.push({ label, before, after });
  assert.ok(after, 'Scene chrome must remain present');
  const fields = ['surfaceScrollLeft', 'surfaceScrollTop', 'barScrollLeft', 'barScrollTop'];
  if (before.tabGap !== null) fields.push('tabGap');
  for (const field of fields) {
    assert.ok(Math.abs(after[field] - before[field]) < 1, label + ' displaced ' + field + ': ' + JSON.stringify({ before, after }));
  }
  if (before.tabGap !== null) assert.ok(after.tabGap > 0, label + ' clipped the first tab');
  report.checks.push(label);
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
}

async function recordClick(element) {
  await execute(el => {
    window.__openbitfunScrollClick = null;
    el.addEventListener('click', event => {
      window.__openbitfunScrollClick = { x: event.clientX, y: event.clientY,
        viewportWidth: innerWidth, viewportHeight: innerHeight };
    }, { once: true, passive: true });
    return true;
  }, element);
}

async function assertClick() {
  const point = await execute(() => window.__openbitfunScrollClick);
  assert.ok(point, 'The production target must receive a click');
  assert.ok(point.x >= 0 && point.x < point.viewportWidth && point.y >= 0 && point.y < point.viewportHeight,
    'The click point must lie inside the viewport: ' + JSON.stringify(point));
  return point;
}

try {
  await until(async () => (await request('/status')).ready, 'embedded driver');
  session = (await request('/session', {})).sessionId;
  await request('/session/' + session + '/timeouts', { script: 5000 });
  await until(() => execute(() => !!document.querySelector('[data-testid=nav-workspace-new-session-btn]')), 'workspace navigation');
  await click('[data-testid=nav-workspace-new-session-btn]');
  await until(async () => {
    const geometry = await execute(chromeGeometry);
    return geometry?.tabGap > 0 ? geometry : null;
  }, 'session chrome');
  await until(() => execute(() => !!document.querySelector('[data-testid=flowchat-header-right-panel]')), 'session actions');
  await settle();
  report.initial = await execute(chromeGeometry);
  assert.ok(report.initial.tabGap > 0);
  assert.equal(report.initial.surfaceScrollLeft, 0);

  await stableChrome('element click', async () => {
    const target = await locate('[data-testid=flowchat-header-right-panel]');
    await recordClick(target);
    await elementAction(target, 'click');
    await assertClick();
  });
  await stableChrome('element screenshot', async () => {
    const target = await locate('[data-testid=flowchat-header-right-panel]');
    const encoded = await request('/session/' + session + '/element/' + target[elementKey] + '/screenshot');
    const png = Buffer.from(encoded, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(path.join(root, 'element.png'), png);
  });
  await stableChrome('wheel skips hidden ancestors', async () => {
    const position = await execute(() => {
      const rect = document.querySelector('.openbitfun-scene-top-bar').getBoundingClientRect();
      return { x: Math.floor(rect.left + 20), y: Math.floor(rect.top + 2) };
    });
    const ancestors = await execute(({ x, y }) => {
      const result = [];
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const style = getComputedStyle(el);
        result.push({ tag: el.tagName, class: el.className, width: el.clientWidth, scrollWidth: el.scrollWidth,
          height: el.clientHeight, scrollHeight: el.scrollHeight, overflowX: style.overflowX, overflowY: style.overflowY });
      }
      return result;
    }, position);
    observations.push({ label: 'wheel target ancestors', ancestors });
    await request('/session/' + session + '/actions', { actions: [{ type: 'wheel', id: 'wheel', actions: [
      { type: 'scroll', origin: 'viewport', ...position, deltaX: 64, deltaY: 0 },
    ] }] });
    await request('/session/' + session + '/actions', undefined, 'DELETE');
  });
  await stableChrome('pointer actions', async () => {
    const target = await locate('[data-testid=flowchat-header-right-panel]');
    await recordClick(target);
    await pointerClick(target);
    await assertClick();
    await request('/session/' + session + '/actions', undefined, 'DELETE');
  });

  const editor = await until(async () => locate('[data-testid=chat-input-textarea][contenteditable=true]'), 'chat composer');
  await stableChrome('contenteditable send keys', async () => {
    await elementAction(editor, 'value', { text: 'scroll regression draft' });
    assert.equal(await execute(el => el.textContent, editor), 'scroll regression draft');
  });
  await stableChrome('contenteditable clear', async () => {
    await elementAction(editor, 'clear');
    assert.equal(await execute(el => el.textContent, editor), '');
  });
  // A real long settings page supplies a value input and offscreen controls.
  await click('[data-testid=nav-footer-settings-item]');
  const openSettings = await until(() => locate('[data-testid=nav-settings-open-item]'), 'settings menu entry', 5000);
  await elementAction(openSettings, 'click');
  const shortcutPage = await until(() => locate('[data-testid=settings-nav-page][data-settings-page="application.shortcuts"]'), 'shortcut settings navigation', 10_000);
  await elementAction(shortcutPage, 'click');
  const search = await until(() => locate('.kb-shortcuts__search input, input.kb-shortcuts__search'), 'shortcut search input', 5000);
  await stableChrome('input send keys', async () => {
    await elementAction(search, 'value', { text: 'scroll regression query' });
    assert.equal(await execute(el => el.value, search), 'scroll regression query');
    assert.equal(await execute(el => document.activeElement === el, search), true);
  });
  await stableChrome('input clear', async () => {
    await elementAction(search, 'clear');
    assert.equal(await execute(el => el.value, search), '');
  });

  const shortcutSelector = '[data-openbitfun-component=keyboard-shortcuts][data-openbitfun-part=key] button';
  const shortcuts = await until(async () => {
    const elements = await request('/session/' + session + '/elements', { using: 'css selector', value: shortcutSelector });
    return elements.length > 1 ? elements : null;
  }, 'keyboard shortcut settings');
  const scrollport = await execute(() => {
    for (let el = document.querySelector('[data-openbitfun-component=keyboard-shortcuts][data-openbitfun-part=content]'); el; el = el.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  });
  assert.ok(scrollport, 'The production settings page must have a scrollport');
  const scrollBefore = await execute(el => el.scrollTop, scrollport);
  await request('/session/' + session + '/actions', { actions: [{ type: 'wheel', id: 'settings-wheel', actions: [
    { type: 'scroll', origin: scrollport, x: 0, y: 0, deltaX: 0, deltaY: 64 },
  ] }] });
  const scrollAfter = await until(async () => {
    const position = await execute(el => el.scrollTop, scrollport);
    return position > scrollBefore ? position : null;
  }, 'wheel scrolling the real settings viewport', 5000);
  observations.push({ label: 'settings wheel', before: scrollBefore, after: scrollAfter });
  report.checks.push('wheel reaches the real scrollport through an element origin');
  await request('/session/' + session + '/actions', undefined, 'DELETE');
  const lastShortcut = shortcuts.at(-1);
  const offscreen = await execute(el => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
  }, lastShortcut);
  assert.ok(offscreen.top >= offscreen.viewportHeight, 'The last real shortcut must start below the viewport');
  await recordClick(lastShortcut);
  await elementAction(lastShortcut, 'click');
  const revealedPoint = await assertClick();
  assert.equal(await execute(el => el.getAttribute('aria-pressed'), lastShortcut), 'true');
  const horizontalOffsets = await execute(el => {
    const result = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX === 'hidden') result.push(parent.scrollLeft);
    }
    return result;
  }, lastShortcut);
  assert.ok(horizontalOffsets.every(offset => offset === 0), 'Offscreen reveal must not shift hidden horizontal ancestors');
  observations.push({ label: 'offscreen control', before: offscreen, click: revealedPoint, horizontalOffsets });
  report.checks.push('offscreen control reveal and activation');
  await elementAction(lastShortcut, 'click'); // Stop recording without changing a shortcut.

  const oversized = await locate('[data-openbitfun-component=keyboard-shortcuts][data-openbitfun-part=content]');
  const oversizedHeight = await execute(el => el.getBoundingClientRect().height, oversized);
  assert.ok(oversizedHeight > await execute(() => innerHeight), 'The real settings content must exceed the viewport');
  await recordClick(oversized);
  await elementAction(oversized, 'click');
  observations.push({ label: 'oversized target', height: oversizedHeight, click: await assertClick() });
  report.checks.push('oversized target uses an in-view click point');
  await recordClick(oversized);
  await pointerClick(oversized);
  observations.push({ label: 'oversized pointer origin', click: await assertClick() });
  report.checks.push('oversized pointer origin uses an in-view point');
  await request('/session/' + session + '/actions', undefined, 'DELETE');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (session) {
    const diagnostics = await execute(() => ({ url: location.href, ready: document.readyState,
      text: document.body?.innerText.slice(0, 3000), inputs: [...document.querySelectorAll('input')].map(el => ({
        id: el.id, class: el.className, parent: el.parentElement?.outerHTML.slice(0, 500),
      })), pointer: {
        x: window.__openbitfunWdRuntimeState?.pointer.x, y: window.__openbitfunWdRuntimeState?.pointer.y,
        target: window.__openbitfunWdRuntimeState?.pointer.target?.outerHTML?.slice(0, 500),
      } })).catch(String);
    await writeFile(path.join(root, 'failure.json'), JSON.stringify(diagnostics, null, 2));
  }
  console.error('Native interaction scroll regression failed. Artifacts: ' + root);
  throw error;
} finally {
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  if (session) await request('/session/' + session, undefined, 'DELETE').catch(() => {});
  if (app.exitCode === null && app.signalCode === null) {
    app.kill();
    await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  await log.close();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, artifactRoot: root }));
}
