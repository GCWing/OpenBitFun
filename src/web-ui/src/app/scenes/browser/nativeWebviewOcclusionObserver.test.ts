// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeNativeWebviewOcclusion } from './nativeWebviewOcclusionObserver';

let cleanups: Array<() => void>;
beforeEach(() => {
  cleanups = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function subscribe(viewport: HTMLDivElement, listener: () => void) {
  const stop = observeNativeWebviewOcclusion(viewport, listener);
  cleanups.push(stop);
  return () => { cleanups.splice(cleanups.indexOf(stop), 1); stop(); };
}
const flush = () => Promise.resolve();

it('shares one DOM observer and ignores unrelated animation mutations across visible browsers', async () => {
  const first = document.createElement('div');
  const second = document.createElement('div');
  const animation = document.createElement('div');
  document.body.append(first, second, animation);
  const observe = vi.spyOn(MutationObserver.prototype, 'observe');
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const query = vi.spyOn(document, 'querySelectorAll');
  const updateA = vi.fn();
  const updateB = vi.fn();
  const stopA = subscribe(first, updateA);
  const stopB = subscribe(second, updateB);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(1);
  updateA.mockClear();
  updateB.mockClear();
  query.mockClear();
  for (let frame = 0; frame < 120; frame++) {
    animation.style.transform = `translateX(${frame}px)`;
    animation.dispatchEvent(new Event('animationend', { bubbles: true }));
    await flush();
  }
  expect(updateA).not.toHaveBeenCalled();
  expect(updateB).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  stopA();
  expect(disconnect).not.toHaveBeenCalled();
  const overlay = document.createElement('div');
  overlay.setAttribute('data-openbitfun-native-webview-occlusion', '');
  document.body.append(overlay);
  await flush();
  expect(updateA).not.toHaveBeenCalled();
  expect(updateB).toHaveBeenCalledTimes(1);
  stopB();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it('tracks nested portals, marker changes, ancestor visibility and removal without document rescans', async () => {
  const viewport = document.createElement('div');
  const portal = document.createElement('div');
  document.body.append(viewport, portal);
  const update = vi.fn();
  subscribe(viewport, update);
  const query = vi.spyOn(document, 'querySelectorAll');
  update.mockClear();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<div data-openbitfun-native-webview-occlusion></div>';
  portal.append(wrapper);
  await flush();
  expect(update).toHaveBeenCalledTimes(1);
  portal.style.visibility = 'hidden';
  await flush();
  expect(update).toHaveBeenCalledTimes(2);
  wrapper.firstElementChild!.removeAttribute('data-openbitfun-native-webview-occlusion');
  await flush();
  expect(update).toHaveBeenCalledTimes(3);
  wrapper.firstElementChild!.className = 'canvas-mission-control';
  await flush();
  expect(update).toHaveBeenCalledTimes(4);
  wrapper.remove();
  await flush();
  expect(update).toHaveBeenCalledTimes(5);
  expect(query).not.toHaveBeenCalled();
});

it('pauses observation while the document is hidden and reconciles overlays on return', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const viewport = document.createElement('div');
  document.body.append(viewport);
  const update = vi.fn();
  subscribe(viewport, update);
  update.mockClear();
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  const overlay = document.createElement('div');
  overlay.setAttribute('data-openbitfun-native-webview-occlusion', '');
  document.body.append(overlay);
  await flush();
  expect(update).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(update).toHaveBeenCalledTimes(1);
  overlay.style.visibility = 'hidden';
  await flush();
  expect(update).toHaveBeenCalledTimes(2);
});
