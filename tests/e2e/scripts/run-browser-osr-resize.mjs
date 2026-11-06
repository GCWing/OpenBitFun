/** Measure the real workbench divider and CEF offscreen presentation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireSharedTexture = process.env.OPENBITFUN_E2E_BROWSER_GPU === '1';
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-browser-resize-'));
const frontend = path.join(root, 'frontend');
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const manifest = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
await cp(frontendSource, frontend, { recursive: true, mode: constants.COPYFILE_FICLONE });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), manifest);

const binaryName = process.platform === 'win32' ? 'openbitfun-desktop.exe' : 'openbitfun-desktop';
const defaultBinary = process.platform === 'darwin'
  ? `target/debug/bundle/macos/OpenBitFun.app/Contents/MacOS/${binaryName}` : `target/debug/${binaryName}`;
const source = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, defaultBinary));
const before = await stat(source);
let binary = source;
if (process.platform === 'darwin') {
  const appBundle = path.resolve(path.dirname(source), '../..');
  assert.equal(path.extname(appBundle), '.app', 'CEF E2E requires the complete macOS app bundle');
  const snapshot = path.join(root, path.basename(appBundle));
  await cp(appBundle, snapshot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  binary = path.join(snapshot, path.relative(appBundle, source));
}
const after = await stat(source);
assert.equal(after.mtimeMs, before.mtimeMs, 'Finish the Desktop build before running the fixture');
assert.equal(after.size, before.size);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

const fixture = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Resize fixture</title><style>
    html { background: #6bc591; font: 20px sans-serif; }
    body { margin: 24px; }
    aside { position: fixed; right: 0; top: 0; bottom: 0; width: 8px; background: #df8136; }
    @media (min-width: 560px) { main { max-width: 22em; } }
  </style><main id="resize-fixture-target">Chromium should reflow this text at each new viewport width.</main><aside></aside>`);
});
const fixtureUrl = `http://127.0.0.1:${await listen(fixture)}/`;
const probe = createServer();
const port = await listen(probe);
await new Promise(resolve => probe.close(resolve));

const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const log = await open(path.join(root, 'desktop.log'), 'w');
const app = spawn(binary, [], {
  cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env,
    OPENBITFUN_USER_ROOT: path.join(root, 'user'), OPENBITFUN_E2E_USER_ROOT: path.join(root, 'user'),
    OPENBITFUN_HOME: path.join(root, 'home'), OPENBITFUN_E2E_HOME: path.join(root, 'home'),
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: frontend, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
    OPENBITFUN_BROWSER_OSR: requireSharedTexture ? 'gpu' : '1', WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  },
});
console.log(`Native browser resize evidence: ${root}`);
let appError;
app.on('error', error => { appError = error; });
let session;
const report = { passed: false, platform: process.platform, source, frontendRevision: JSON.parse(manifest).revision,
  requiredPresentation: requireSharedTexture ? 'shared-texture' : 'cpu-frames' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, signal: AbortSignal.timeout(20_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}
async function until(read, description) {
  const deadline = Date.now() + 35_000;
  let last;
  while (Date.now() < deadline) {
    if (appError) throw appError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Desktop exited before ${description}`);
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${description}: ${last ?? 'not ready'}`);
}
const execute = (fn, ...args) => request(`/session/${session}/execute/sync`, { script: fn.toString(), args });
const invoke = (command, args = {}) => execute((command, args) => window.__TAURI_INTERNALS__.invoke(command, args), command, args);
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const locate = selector => request(`/session/${session}/element`, { using: 'css selector', value: selector });
async function click(selector) {
  await until(async () => {
    const element = await locate(selector);
    await request(`/session/${session}/element/${element[elementKey]}/click`, {});
    return true;
  }, selector);
}

async function capture(name) {
  const png = Buffer.from(await request(`/session/${session}/screenshot`), 'base64');
  if (name) await writeFile(path.join(root, `${name}.png`), png);
  return png;
}

async function pixelAt(png, { x, y, viewportWidth }) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / viewportWidth;
  const pixel = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
  return [...data.subarray(pixel, pixel + 3)];
}

const fixtureBackground = [107, 197, 145];
const sameColor = (actual, expected) => actual.length === expected.length
  && actual.every((channel, index) => Math.abs(channel - expected[index]) <= 3);

async function verifyMenuAboveBrowser() {
  const before = await capture();
  await click('[data-testid=nav-search-trigger]');
  const point = await until(() => execute(() => {
    const menu = document.querySelector('[data-testid=global-search-dialog]');
    const host = document.querySelector('[data-testid=browser-offscreen-surface]')?.closest('[data-webview-label]');
    if (!menu || !host) return null;
    const dialog = menu.getBoundingClientRect();
    const browser = host.getBoundingClientRect();
    const left = Math.max(dialog.left, browser.left);
    const top = Math.max(dialog.top, browser.top);
    const right = Math.min(dialog.right, browser.right);
    const bottom = Math.min(dialog.bottom, browser.bottom);
    if (right - left < 20 || bottom - top < 20) return null;
    const x = Math.round((left + right) / 2);
    const y = Math.round((top + bottom) / 2);
    return menu.contains(document.elementFromPoint(x, y)) ? { x, y, viewportWidth: innerWidth } : null;
  }), 'global search dialog overlapping the browser');
  const background = await pixelAt(before, point);
  assert.ok(sameColor(background, fixtureBackground), 'The overlap sample must start on the fixture page');
  const menuPixel = await until(async () => {
    const png = await capture();
    const pixel = await pixelAt(png, point);
    if (sameColor(pixel, background)) return null;
    await writeFile(path.join(root, 'menu-above-browser.png'), png);
    return pixel;
  }, 'native screenshot with the dialog above the browser pixels');
  await click('[data-testid=global-search-dialog] input');
  assert.equal(await execute(() => document.activeElement?.closest('[data-testid=global-search-dialog]') !== null), true);
  await request(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'menu-keyboard', actions: [
    { type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' },
  ] }] });
  await until(() => execute(() => !document.querySelector('[data-testid=global-search-dialog]')), 'global search dismissed');
  report.menu = { point, browserPixel: background, menuPixel };
}

async function verifyElementSelection() {
  const viewport = await execute(() => {
    const surface = document.querySelector('[data-testid=browser-offscreen-surface]');
    const rect = surface.parentElement.getBoundingClientRect();
    return { label: surface.closest('[data-webview-label]').dataset.webviewLabel, left: rect.left, top: rect.top, viewportWidth: innerWidth };
  });
  const switchView = handle => request(`/session/${session}/window`, { handle });
  async function inGuest(fn) {
    await switchView(viewport.label);
    try {
      return await execute(fn);
    } finally {
      await switchView('main');
    }
  }
  const element = await inGuest(() => {
    const { left, top, width, height } = document.querySelector('#resize-fixture-target').getBoundingClientRect();
    return { left, top, width, height };
  });
  const point = {
    x: Math.round(viewport.left + element.left + element.width / 2),
    y: Math.round(viewport.top + element.top + element.height / 2),
  };
  const borderPoint = {
    x: point.x, y: Math.floor(viewport.top + element.top + 1), viewportWidth: viewport.viewportWidth,
  };
  const before = await pixelAt(await capture(), borderPoint);
  const inspector = '[data-testid=browser-panel-title] button[aria-pressed]';
  await click(inspector);
  await until(() => execute(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', inspector), 'element picker enabled');
  const pointer = actions => request(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'browser-mouse',
    parameters: { pointerType: 'mouse' }, actions }] });
  await pointer([{ type: 'pointerMove', origin: 'viewport', ...point }]);
  const hover = await until(() => inGuest(() => {
    const picker = document.querySelector('[data-openbitfun-picker]')?.shadowRoot;
    const box = picker?.querySelector('.box:not([hidden])');
    if (picker?.querySelector('.tooltip')?.textContent !== 'main#resize-fixture-target' || !box) return null;
    const { left, top, width, height } = box.getBoundingClientRect();
    return { left, top, width, height };
  }), 'guest element hover box');
  assert.deepEqual(hover, element);
  const hoverPixel = await until(async () => {
    const png = await capture();
    const pixel = await pixelAt(png, borderPoint);
    if (sameColor(pixel, before)) return null;
    await writeFile(path.join(root, 'browser-element-hover.png'), png);
    return pixel;
  }, 'hover border in the main workbench screenshot');
  await pointer([{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]);
  await until(() => inGuest(() => !!document.querySelector('[data-openbitfun-picker]')?.shadowRoot
    ?.querySelector('.selected .box:not([hidden])')), 'guest selected box');
  const context = await until(() => execute(() => {
    const tag = document.querySelector('[data-testid=chat-input-textarea] [data-context-type=web-element]');
    return tag?.textContent?.includes('Chromium should reflow this text')
      ? { text: tag.textContent.trim(), source: tag.title } : null;
  }), 'selected web element in the chat composer');
  assert.equal(context.source, `${fixtureUrl} · main#resize-fixture-target`);
  const selectedPixel = await until(async () => {
    const png = await capture();
    const pixel = await pixelAt(png, borderPoint);
    if (sameColor(pixel, hoverPixel) || sameColor(pixel, before)) return null;
    await writeFile(path.join(root, 'browser-element-selected.png'), png);
    return pixel;
  }, 'selected border in the main workbench screenshot');
  report.inspector = { hover, hoverPixel, selectedPixel, context };
  await click(inspector);
}

try {
  await until(async () => (await request('/status')).ready, 'embedded WebDriver');
  session = (await request('/session', {})).sessionId;
  await request(`/session/${session}/timeouts`, { script: 15000 });
  await until(() => execute(() => !!document.querySelector('[data-testid=nav-search-trigger]')), 'workbench');
  const { id: workspaceId } = await invoke('open_workspace', { request: { path: workspace, createLocal: true } });
  await invoke('set_active_workspace', { request: { workspaceId } });
  const sessionId = randomUUID();
  await invoke('create_session', { request: { sessionId, sessionName: 'Browser resize', agentType: 'agentic',
    workspacePath: workspace, workspaceId, config: { modelName: 'resize-fixture', safeMode: false } } });
  const documentStart = await execute(() => {
    setTimeout(() => location.reload(), 0);
    return performance.timeOrigin;
  });
  await until(() => execute(start => performance.timeOrigin !== start, documentStart), 'reloaded workbench');
  await click(`[data-testid="nav-session-item"][data-session-id="${sessionId}"]`);
  await until(() => execute(id => document.querySelector(`[data-session-id="${id}"]`)?.dataset.sessionActive === 'true', sessionId), 'active session');
  await execute(url => window.dispatchEvent(new CustomEvent('agent-create-tab', {
    detail: { type: 'browser', title: 'Resize fixture', data: { url } },
  })), fixtureUrl);

  const initial = await until(() => execute(() => {
    const error = document.querySelector('[data-testid=browser-error-message]');
    if (error?.textContent) return { error: error.textContent };
    const canvas = document.querySelector('[data-testid=browser-offscreen-surface]');
    const host = canvas?.closest('[data-webview-label]');
    const rect = host?.getBoundingClientRect();
    const divider = document.querySelector('[data-openbitfun-component=split-view][data-openbitfun-part=resizeHandle]');
    if (!canvas?.style.width || !rect?.width || !divider?.getBoundingClientRect().width) return null;
    return { x: rect.x + 24, y: rect.y + rect.height / 2, viewportWidth: innerWidth, presentation: canvas.dataset.presentation };
  }), 'painted OSR browser in the split workbench');
  assert.ok(!initial.error, initial.error);
  assert.equal(initial.presentation, report.requiredPresentation, 'Use the requested OSR presentation');
  const settled = await until(async () => {
    const png = await capture();
    return sameColor(await pixelAt(png, initial), fixtureBackground) && png;
  }, 'native screenshot of the fixture page');
  await writeFile(path.join(root, 'before-drag.png'), settled);

  const measurements = await execute(async () => {
    const canvas = document.querySelector('[data-testid=browser-offscreen-surface]');
    const host = canvas.closest('[data-webview-label]');
    const surface = canvas.parentElement;
    const handle = document.querySelector('[data-openbitfun-component=split-view][data-openbitfun-part=resizeHandle]');
    const rect = handle.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const sign = host.getBoundingClientRect().left > x ? -1 : 1;
    const frames = [];
    const transport = [];
    const textures = [];
    const start = performance.now();
    const now = () => performance.now() - start;
    const presentTexture = window.__openbitfunPresentOsrTexture;
    if (presentTexture) {
      window.__openbitfunPresentOsrTexture = (...args) => {
        const [, popup, bitmap, , , width, , , , scale] = args;
        if (!popup && bitmap) textures.push({ received: now(), width: Math.round(width / scale) });
        return presentTexture(...args);
      };
    }
    const fetchOriginal = window.fetch;
    window.fetch = async function (url, options) {
      const command = String(url).split('/').at(-1);
      if (command !== 'browser_webview_osr_frame' && command !== 'browser_webview_set_bounds') {
        return fetchOriginal.call(this, url, options);
      }
      const entry = { command, sent: now(), width: JSON.parse(options.body).request.width };
      transport.push(entry);
      const response = await fetchOriginal.call(this, url, options);
      entry.headers = now();
      if (command === 'browser_webview_osr_frame') {
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const buffer = await read();
          entry.received = now();
          entry.bytes = buffer.byteLength;
          if (buffer.byteLength >= 52) {
            const header = new DataView(buffer);
            entry.width = header.getUint32(16, true);
            entry.compressed = header.getUint32(0, true) === 0x3352534f;
          }
          return buffer;
        };
      }
      return response;
    };
    let desiredOffset = 0;
    let frame;
    const sample = () => {
      frames.push({ ms: now(), desiredOffset, host: host.clientWidth,
        painted: Number.parseFloat(surface.style.width), canvas: canvas.width,
        backdrop: surface.parentElement.style.backgroundColor });
      frame = requestAnimationFrame(sample);
    };
    // The embedded WebDriver action bridge emits MouseEvent only. Dispatch
    // PointerEvents to the real divider and emulate capture for this sequence.
    handle.setPointerCapture = () => {};
    const send = (type, offset, buttons) => handle.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: x + offset * sign, clientY: y, button: 0, buttons,
    }));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    sample();
    try {
      send('pointerdown', 0, 1);
      for (let offset = 12; offset <= 192; offset += 12) {
        desiredOffset = offset;
        send('pointermove', offset, 1);
        await wait(24);
      }
      await wait(300);
      for (let offset = 180; offset >= 48; offset -= 12) {
        desiredOffset = offset;
        send('pointermove', offset, 1);
        await wait(24);
      }
      send('pointerup', desiredOffset, 0);
      await wait(450);
      return { frames, transport, textures, sign };
    } finally {
      cancelAnimationFrame(frame);
      delete handle.setPointerCapture;
      window.fetch = fetchOriginal;
      if (presentTexture) window.__openbitfunPresentOsrTexture = presentTexture;
    }
  });
  Object.assign(report, measurements);
  const { frames, transport, textures } = measurements;
  const widthChanges = new Set(frames.map(frame => frame.host));
  const paintedChanges = new Set(frames.map(frame => frame.painted));
  const requests = transport.filter(entry => entry.command === 'browser_webview_set_bounds');
  const firstFrames = new Map();
  for (const frame of requireSharedTexture ? textures : transport) {
    if (!frame.received) continue;
    const resize = requests.findLast(entry => entry.width === frame.width && entry.sent <= frame.received);
    if (resize && !firstFrames.has(resize)) firstFrames.set(resize, frame.received - resize.sent);
  }
  const firstFrameLatencies = [...firstFrames.values()].sort((a, b) => a - b);
  const presentedLatencies = frames.flatMap((frame, index) => {
    if (frame.painted === frames[index - 1]?.painted) return [];
    const resize = requests.findLast(entry => entry.width === frame.painted && entry.sent <= frame.ms);
    return resize ? [frame.ms - resize.sent] : [];
  }).sort((a, b) => a - b);
  const lastRequest = requests.at(-1);
  const finalPaint = frames.find(frame => frame.ms >= lastRequest?.sent && Math.abs(frame.host - frame.painted) <= 1);
  report.summary = {
    frames: frames.length, hostWidths: widthChanges.size, paintedWidths: paintedChanges.size,
    maxUnpaintedWidth: Math.max(...frames.map(frame => frame.host - frame.painted)),
    framesWithUnpaintedWidth: frames.filter(frame => frame.host - frame.painted > 1).length,
    maxFrameIntervalMs: Math.max(...frames.slice(1).map((frame, index) => frame.ms - frames[index].ms)),
    frameRequests: transport.filter(entry => entry.command === 'browser_webview_osr_frame').length,
    frameBytes: transport.reduce((bytes, entry) => bytes + (entry.bytes ?? 0), 0),
    textureFrames: textures.length,
    compressedFrames: transport.filter(entry => entry.compressed).length,
    matchedResizeCount: firstFrames.size,
    resizeToFrameP95Ms: firstFrameLatencies[Math.ceil(firstFrameLatencies.length * 0.95) - 1],
    resizeToPresentedP95Ms: presentedLatencies[Math.ceil(presentedLatencies.length * 0.95) - 1],
    finalPaintMs: finalPaint && finalPaint.ms - lastRequest.sent,
    final: frames.at(-1),
  };
  console.log(JSON.stringify(report.summary));
  if (requireSharedTexture) {
    assert.ok(report.summary.textureFrames > 0, 'The CEF importer must deliver textures during the sweep');
    assert.equal(report.summary.frameRequests, 0, 'The workbench must not invoke the CPU frame endpoint');
    assert.equal(report.summary.frameBytes, 0, 'No browser pixel bytes may cross Tauri IPC');
  }
  assert.ok(widthChanges.size >= 8, 'The real divider must move during the sweep');
  assert.ok(paintedChanges.size >= 8, 'The browser must reflow at intermediate widths');
  assert.ok(report.summary.finalPaintMs <= 250, 'The final browser width must catch up within 250 ms');
  assert.ok(Math.abs(frames.at(-1).host - frames.at(-1).painted) <= 1, 'The final native frame must match the panel');
  const rightEdge = await execute(() => {
    const canvas = document.querySelector('[data-testid=browser-offscreen-surface]');
    const rect = canvas.closest('[data-webview-label]').getBoundingClientRect();
    return { x: rect.right - 4, y: rect.y + rect.height / 2, viewportWidth: innerWidth };
  });
  const marker = await pixelAt(await capture('after-drag'), rightEdge);
  assert.ok(sameColor(marker, [223, 129, 54]),
    'The fixture right edge must reach the final native viewport width');

  // Hold a real paint response for a screenshot of the resize transition.
  // The timing sweep above is independent of this controlled delay.
  const changed = frames.find(frame => frame.host !== frames[0].host);
  const direction = Math.sign((changed.host - frames[0].host) * changed.desiredOffset) * measurements.sign;
  await execute((direction, sharedTexture) => {
    const handle = document.querySelector('[data-openbitfun-component=split-view][data-openbitfun-part=resizeHandle]');
    const rect = handle.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const send = (type, offset, buttons) => handle.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', isPrimary: true,
      clientX: x + offset * direction, clientY: y, button: 0, buttons,
    }));
    let release;
    const delay = new Promise(resolve => { release = resolve; });
    const read = Response.prototype.arrayBuffer;
    const textureDispatch = window.__openbitfunPresentOsrTexture;
    if (sharedTexture) {
      window.__openbitfunPresentOsrTexture = (_label, _popup, bitmap) => bitmap?.close();
    } else {
      Response.prototype.arrayBuffer = async function () {
        const bytes = await read.call(this);
        if (this.url.endsWith('/browser_webview_osr_frame')) await delay;
        return bytes;
      };
    }
    handle.setPointerCapture = () => {};
    window.__releaseBrowserResizeFixture = async () => {
      send('pointerup', 64, 0);
      delete handle.setPointerCapture;
      Response.prototype.arrayBuffer = read;
      release();
      if (sharedTexture) {
        window.__openbitfunPresentOsrTexture = textureDispatch;
        const canvas = document.querySelector('[data-testid=browser-offscreen-surface]');
        const label = canvas.closest('[data-webview-label]').dataset.webviewLabel;
        await window.__TAURI_INTERNALS__.invoke('browser_webview_osr_input', { request: { label, events: [{ kind: 'redraw' }] } });
      }
    };
    send('pointerdown', 0, 1);
    send('pointermove', 64, 1);
  }, direction, requireSharedTexture);
  try {
    const gap = await until(() => execute(() => {
      const canvas = document.querySelector('[data-testid=browser-offscreen-surface]');
      const host = canvas.closest('[data-webview-label]').getBoundingClientRect();
      const surface = canvas.parentElement.getBoundingClientRect();
      const width = host.right - surface.right;
      if (width < 16) return null;
      return { x: surface.right + width / 2, y: host.y + host.height / 2, viewportWidth: innerWidth, width };
    }), 'expanded viewport with a paint still pending');
    const samples = [];
    for (const screenshot of ['during-drag', 'during-drag-next', 'during-drag-last']) {
      samples.push(await pixelAt(await capture(screenshot), gap));
    }
    report.gap = { ...gap, pixel: samples[0], samples };
    assert.ok(samples.every(pixel => sameColor(pixel, fixtureBackground)),
      `The pending resize exposed an unexpected backdrop (${JSON.stringify(samples)})`);
  } finally {
    await execute(() => window.__releaseBrowserResizeFixture());
  }
  await until(() => execute(() => {
    const surface = document.querySelector('[data-testid=browser-offscreen-surface]');
    return Math.abs(surface.closest('[data-webview-label]').clientWidth - surface.parentElement.clientWidth) <= 1;
  }), 'browser caught up after the held paint');
  await verifyMenuAboveBrowser();
  await verifyElementSelection();
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (app.exitCode === null && app.signalCode === null) app.kill();
  fixture.closeAllConnections();
  fixture.close();
  await log.close();
}
