// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmbeddedBrowserWebview } from './useEmbeddedBrowserWebview';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {}),
  view: { label: 'test-browser', show: vi.fn(async () => {}), hide: vi.fn(async () => {}),
    close: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) },
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@tauri-apps/api/webview', () => ({ Webview: { getByLabel: async () => mocks.view } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const log = { warn: vi.fn(), error: vi.fn() };
let browser: ReturnType<typeof useEmbeddedBrowserWebview>;
function Harness({ active }: { active: boolean }) {
  browser = useEmbeddedBrowserWebview({ defaultUrl: 'https://example.com', isVisible: active, labelPrefix: 'test', log });
  return <div ref={browser.viewportRef} />;
}

let root: Root;
let container: HTMLDivElement;
let viewportBounds: DOMRect;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async () => {});
  vi.stubGlobal('__TAURI__', {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  viewportBounds = new DOMRect(0, 0, 200, 200);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => viewportBounds);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(active = true) {
  await act(async () => root.render(<Harness active={active} />));
}
async function mutate(change: () => void) {
  await act(async () => { change(); });
}
function overlay() {
  const node = document.createElement('div');
  node.setAttribute('data-openbitfun-native-webview-occlusion', '');
  node.getBoundingClientRect = () => new DOMRect(50, 50, 100, 100);
  return node;
}

it('keeps creation, navigation, resize and activation hidden while any floating panel overlaps', async () => {
  const first = overlay();
  const second = overlay();
  document.body.append(first, second);
  await render();
  expect(mocks.view.show).not.toHaveBeenCalled();
  expect(mocks.view.setFocus).not.toHaveBeenCalled();

  await act(async () => browser.loadUrl('https://example.com/next'));
  await mutate(() => { viewportBounds = new DOMRect(0, 0, 250, 250); window.dispatchEvent(new Event('resize')); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  await render(false);
  await render(true);
  expect(mocks.view.show).not.toHaveBeenCalled();
  expect(mocks.view.setFocus).not.toHaveBeenCalled();
  await mutate(() => first.remove());
  expect(mocks.view.show).not.toHaveBeenCalled();
  await mutate(() => second.remove());
  expect(mocks.view.show).toHaveBeenCalledOnce();
  expect(mocks.view.setFocus).not.toHaveBeenCalled();
});

it('responds to an already mounted panel becoming visible and restores only the active tab', async () => {
  const panel = overlay();
  panel.style.visibility = 'hidden';
  document.body.append(panel);
  await render();
  expect(mocks.view.show).toHaveBeenCalledOnce();
  await mutate(() => { panel.style.visibility = 'visible'; });
  expect(mocks.view.hide).toHaveBeenCalledOnce();
  await render(false);
  await mutate(() => panel.remove());
  expect(mocks.view.show).toHaveBeenCalledOnce();
  await render(true);
  expect(mocks.view.show).toHaveBeenCalledTimes(2);
});

it('does not show or focus when navigation finishes after deactivation', async () => {
  await render();
  mocks.view.show.mockClear();
  mocks.view.setFocus.mockClear();
  let finishNavigation!: () => void;
  mocks.invoke.mockImplementation(async (...args) => {
    if (args[0] === 'browser_webview_navigate') await new Promise<void>(resolve => { finishNavigation = resolve; });
  });
  let navigation!: Promise<void>;
  await act(async () => { navigation = browser.loadUrl('https://example.com/slow'); });
  await render(false);
  await act(async () => { finishNavigation(); await navigation; });
  expect(mocks.view.show).not.toHaveBeenCalled();
  expect(mocks.view.setFocus).not.toHaveBeenCalled();
});

it('releases temporary toolbar suppression after activation settles', async () => {
  await render();
  await mutate(() => window.dispatchEvent(new Event('toolbar-mode-activating')));
  expect(mocks.view.hide).toHaveBeenCalledOnce();
  await act(async () => browser.loadUrl('https://example.com/next'));
  expect(mocks.view.show).toHaveBeenCalledOnce();
  await mutate(() => window.dispatchEvent(new Event('toolbar-mode-activation-finished')));
  expect(mocks.view.show).toHaveBeenCalledTimes(2);
});

it('keeps the old native rectangle occluded until the delayed bounds update completes', async () => {
  const panel = overlay();
  document.body.append(panel);
  await render();
  let finishBounds!: () => void;
  mocks.invoke.mockImplementation(async (...args) => {
    if (args[0] === 'browser_webview_set_bounds') await new Promise<void>(resolve => { finishBounds = resolve; });
  });
  await mutate(() => {
    viewportBounds = new DOMRect(500, 0, 200, 200);
    window.dispatchEvent(new Event('resize'));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  expect(mocks.view.show).not.toHaveBeenCalled();
  await act(async () => finishBounds());
  expect(mocks.view.show).toHaveBeenCalledOnce();
});

it('does not invoke native APIs in the web surface', async () => {
  Reflect.deleteProperty(window, '__TAURI__');
  await render();
  await act(async () => browser.loadUrl('https://example.com/next'));
  await mutate(() => document.body.append(overlay()));
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.view.show).not.toHaveBeenCalled();
  expect(mocks.view.hide).not.toHaveBeenCalled();
});

it('does no layout scans for unrelated DOM animation or inactive browser tabs', async () => {
  const animated = document.createElement('div');
  document.body.append(animated);
  await render();
  const query = vi.spyOn(document, 'querySelectorAll');
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  bounds.mockClear();
  for (let frame = 0; frame < 120; frame++) {
    await mutate(() => { animated.style.transform = `translateX(${frame}px)`; });
  }
  expect(query).not.toHaveBeenCalled();
  expect(bounds).not.toHaveBeenCalled();
  await render(false);
  query.mockClear();
  bounds.mockClear();
  await mutate(() => document.body.append(overlay()));
  expect(query).not.toHaveBeenCalled();
  expect(bounds).not.toHaveBeenCalled();
});

it('still clears toolbar suspension when an inactive tab misses the finishing transition', async () => {
  await render();
  await mutate(() => window.dispatchEvent(new Event('toolbar-mode-activating')));
  await render(false);
  await mutate(() => window.dispatchEvent(new Event('toolbar-mode-activation-finished')));
  await render(true);
  expect(mocks.view.show).toHaveBeenCalledTimes(2);
});

it('aligns native and preview edges at fractional DPI and applies a one-physical-pixel move', async () => {
  vi.stubGlobal('devicePixelRatio', 1.5);
  viewportBounds = new DOMRect(912.333374, 128.333343, 747, 938.333374);
  await render();
  const creation = mocks.invoke.mock.calls.find(call => call[0] === 'browser_webview_create')!;
  const { request } = creation[1] as { request: { x: number; y: number; width: number; height: number } };
  expect(request.x * 1.5).toBeCloseTo(1369);
  expect(request.y * 1.5).toBeCloseTo(193);
  expect((request.x + request.width) * 1.5).toBeCloseTo(2489);
  expect((request.y + request.height) * 1.5).toBeCloseTo(1600);
  expect(viewportBounds.left + browser.previewBounds!.left).toBeCloseTo(request.x);
  expect(viewportBounds.top + browser.previewBounds!.top).toBeCloseTo(request.y);
  expect(browser.previewBounds!.width).toBe(request.width);
  expect(browser.previewBounds!.height).toBe(request.height);

  mocks.invoke.mockClear();
  await mutate(() => {
    viewportBounds = new DOMRect(viewportBounds.left, viewportBounds.top + 2 / 3, viewportBounds.width, viewportBounds.height);
    window.dispatchEvent(new Event('resize'));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  const update = mocks.invoke.mock.calls.find(call => call[0] === 'browser_webview_set_bounds')!;
  expect(update).toBeDefined();
  const updated = (update[1] as { request: { y: number } }).request;
  expect(updated.y * 1.5).toBeCloseTo(194);
  expect(viewportBounds.top + browser.previewBounds!.top).toBeCloseTo(updated.y);
});

it('keeps the decoded preview beneath a popup without waiting for the next capture', async () => {
  vi.stubGlobal('Image', class { src = ''; decode = async () => {}; });
  mocks.invoke.mockImplementation(async command => command === 'browser_webview_capture_preview'
    ? { status: 'ready', dataUrl: 'data:image/jpeg;base64,preview' } : undefined);
  await render();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(browser.previewUrl).toBe('data:image/jpeg;base64,preview');
  await mutate(() => document.body.append(overlay()));
  expect(mocks.view.hide).toHaveBeenCalledOnce();
  expect(browser.previewUrl).toBe('data:image/jpeg;base64,preview');
  await act(async () => browser.loadUrl('https://example.com/new-page'));
  expect(browser.previewUrl).toBeNull();
});
