/** Actual pinned xterm RenderService; fake frame/visibility clocks, no WebView. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../../src/web-ui/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('vite'))('esbuild');
const root = process.env.OPENBITFUN_XTERM_SOURCE || path.resolve(webRequire.resolve('@xterm/xterm'), '../..');
const result = await build({
  entryPoints: [path.join(root, 'src/browser/services/RenderService.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'es2021',
  alias: { common: path.join(root, 'src/common'), browser: path.join(root, 'src/browser'), vs: path.join(root, 'src/vs') },
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});
const { RenderService } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const event = () => ({ dispose() {} });
function fixture() {
  let nextId = 1;
  const frames = new Map(), timeouts = new Map(), observers = [];
  const window = {
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { const id = nextId++; timeouts.set(id, callback); return id; },
    clearTimeout: id => timeouts.delete(id),
    IntersectionObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} },
  };
  const runFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const intersect = visible => observers.forEach(callback => callback([{ isIntersecting: visible, intersectionRatio: +visible }]));
  const core = { decPrivateModes: { synchronizedOutput: false } };
  const service = new RenderService(24, {},
    { onOptionChange: event, onMultipleOptionChange: event },
    { onCharSizeChange: event, hasValidSize: true, measure() {} }, core,
    { onDecorationRegistered: event, onDecorationRemoved: event },
    { onResize: event, buffers: { onBufferActivate: event } },
    { window, onDprChange: event, onWindowChange: event }, { onChangeColors: event });
  let redraw;
  const renderer = {
    dimensions: { css: { cell: { width: 8, height: 16 }, canvas: { width: 640, height: 384 } }, device: {} },
    rendered: [], selections: [], resizes: [],
    onRequestRedraw: callback => { redraw = callback; return { dispose() {} }; },
    renderRows(start, end) { this.rendered.push([start, end]); },
    handleSelectionChanged(start, end, column) {
      this.selections.push([start, end, column]);
      redraw?.({ start: 0, end: 23 });
    },
    handleBlur() { this.focused = false; redraw?.({ start: 0, end: 23 }); },
    handleFocus() { this.focused = true; redraw?.({ start: 0, end: 23 }); },
    handleResize(cols, rows) { this.resizes.push([cols, rows]); redraw?.({ start: 0, end: rows - 1 }); },
    handleDevicePixelRatioChange() {}, handleCharSizeChanged() {}, handleCursorMove() {}, clear() {}, dispose() {},
  };
  const contentEvents = [], renderEvents = [];
  service.setRenderer(renderer); intersect(true); runFrames(); runFrames();
  renderer.rendered = []; renderer.selections = []; renderer.resizes = [];
  service.onRenderedViewportChange(value => contentEvents.push(value));
  service.onRender(value => renderEvents.push(value));
  return { service, renderer, core, intersect, runFrames, contentEvents, renderEvents, timeouts };
}

test('a queued frame cannot redraw after becoming hidden; resume draws latest content', () => {
  const f = fixture();
  try {
    f.service.refreshRows(0, 23); f.intersect(false); f.runFrames();
    assert.deepEqual(f.renderer.rendered, []); assert.deepEqual(f.renderEvents, []); assert.deepEqual(f.contentEvents, []);
    f.intersect(true); f.runFrames();
    assert.deepEqual(f.renderer.rendered, [[0, 23]]); assert.deepEqual(f.contentEvents, [{ start: 0, end: 23 }]);
  } finally { f.service.dispose(); }
});

test('selection, focus and resize retain latest state while row drawing is paused', () => {
  const f = fixture();
  try {
    f.intersect(false);
    f.service.handleSelectionChanged([0, 3], [8, 5], false);
    f.service.handleSelectionChanged([1, 4], [9, 6], true);
    f.service.handleFocus(); f.service.handleBlur(); f.service.resize(90, 30); f.service.handleResize(90, 30);
    f.runFrames();
    assert.deepEqual(f.renderer.rendered, []); assert.deepEqual(f.renderEvents, []);
    assert.deepEqual(f.renderer.selections.at(-1), [[1, 4], [9, 6], true]); assert.equal(f.renderer.focused, false);
    f.intersect(true); f.runFrames();
    assert.deepEqual(f.renderer.rendered.at(-1), [0, 29]);
    assert.deepEqual(f.renderer.resizes.at(-1), [90, 30]);
  } finally { f.service.dispose(); }
});

test('selection replay only happens once and keeps the full refresh content event', () => {
  const f = fixture();
  try {
    f.service.handleSelectionChanged([0, 3], [8, 5], false); f.runFrames();
    f.renderer.selections = []; f.renderer.rendered = []; f.contentEvents.length = 0;
    f.service.setRenderer(f.renderer); f.runFrames(); f.runFrames(); f.runFrames();
    assert.equal(f.renderer.selections.length, 1);
    assert.deepEqual(f.contentEvents, [{ start: 0, end: 23 }]);
  } finally { f.service.dispose(); }
});

test('a visible selection redraw remains buffered during synchronized output', () => {
  const f = fixture();
  try {
    f.core.decPrivateModes.synchronizedOutput = true;
    f.service.handleSelectionChanged([0, 3], [8, 5], false); f.runFrames();
    assert.deepEqual(f.renderer.rendered, []);
    f.core.decPrivateModes.synchronizedOutput = false;
    f.service.refreshRows(0, 0); f.runFrames();
    assert.deepEqual(f.renderer.rendered, [[0, 23]]);
  } finally { f.service.dispose(); }
});
