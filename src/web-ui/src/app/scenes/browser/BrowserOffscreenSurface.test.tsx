// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import BrowserPanel from './BrowserPanel';
import { BrowserOffscreenSurface } from './BrowserOffscreenSurface';
import * as offscreenGpu from './browserOffscreenGpu';

const mocks = vi.hoisted(() => ({
  addContext: vi.fn(),
  evalInWebview: vi.fn(),
  invoke: vi.fn(),
  reportError: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@/shared/context-system', () => ({
  useContextStore: (select: (store: { addContext: typeof mocks.addContext }) => unknown) =>
    select({ addContext: mocks.addContext }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return () => mocks.listeners.delete(name);
  },
}));
vi.mock('./useEmbeddedBrowserWebview', async () => {
  const { useRef } = await import('react');
  const getWebviewLabel = () => 'browser';
  const getCurrentUrl = () => 'https://example.com';
  return {
    useEmbeddedBrowserWebview: () => ({
      currentUrl: getCurrentUrl(),
      inputValue: getCurrentUrl(),
      evalInWebview: mocks.evalInWebview,
      getWebviewLabel,
      getCurrentUrl,
      hasWebview: () => true,
      isTauri: true,
      offscreenLabel: getWebviewLabel(),
      offscreenVisible: true,
      reportPresentationError: mocks.reportError,
      viewportRef: useRef(null),
      webviewLabel: getWebviewLabel(),
    }),
  };
});

it('presents native ImageBitmaps in the DOM without invoking the pixel frame endpoint', async () => {
  mocks.invoke.mockClear().mockResolvedValue(undefined);
  const onError = vi.fn();
  const transferFromImageBitmap = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type =>
    type === 'bitmaprenderer' ? { transferFromImageBitmap } as unknown as ImageBitmapRenderingContext : null);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const target = window as Window & { __openbitfunPresentOsrTexture?: (...args: unknown[]) => void };
  try {
    await act(async () => root.render(<BrowserOffscreenSurface label="gpu" title="GPU" active sharedTexture onError={onError} />));
    expect(mocks.invoke.mock.calls).toEqual([
      ['browser_webview_osr_input', { request: { label: 'gpu', events: [{ kind: 'redraw' }] } }],
    ]);
    const bitmap = { width: 400, height: 300, close: vi.fn() };
    target.__openbitfunPresentOsrTexture!('gpu', false, bitmap, 20, 10, 360, 260, 0, 0, 2, 0xff102030);
    const canvas = host.querySelector<HTMLCanvasElement>('[data-testid=browser-offscreen-surface]')!;
    expect(canvas.dataset.presentation).toBe('shared-texture');
    expect(canvas.parentElement?.style.width).toBe('180px');
    expect(canvas.parentElement?.style.height).toBe('130px');
    expect(canvas.style.transform).toBe('translate(-10px, -5px)');
    expect(transferFromImageBitmap).toHaveBeenLastCalledWith(bitmap);
    expect(bitmap.close).toHaveBeenCalledOnce();
    mocks.listeners.get('browser-osr-ui-gpu')?.({ payload: { cursor: 2, caret: [45, 65] } });
    expect(canvas.style.cursor).toBe('text');
    expect(host.querySelector('textarea')?.style.left).toBe('25%');

    const popup = host.querySelector<HTMLElement>('[data-openbitfun-part=offscreenPopup]')!;
    target.__openbitfunPresentOsrTexture!('gpu', true, bitmap, 0, 0, 80, 40, 15, 25, 2, 0);
    expect([popup.hidden, popup.style.left, popup.style.top]).toEqual([false, '15px', '25px']);
    target.__openbitfunPresentOsrTexture!('gpu', true, null, 0, 0, 0, 0, 0, 0, 1, 0);
    expect(popup.hidden).toBe(true);
    expect(transferFromImageBitmap).toHaveBeenLastCalledWith(null);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(target.__openbitfunPresentOsrTexture).toBeUndefined();
});

it('forwards panel coordinates to the picker and adds the clicked element to chat', async () => {
  const guest = document.implementation.createHTMLDocument();
  guest.body.innerHTML = '<button id="hovered">Hover</button><button id="picked">Selected text</button>';
  const hovered = guest.getElementById('hovered')!;
  const picked = guest.getElementById('picked')!;
  let hoveredRect = new DOMRect(4, 8, 22, 16);
  vi.spyOn(hovered, 'getClientRects').mockImplementation(() => [hoveredRect] as unknown as DOMRectList);
  vi.spyOn(picked, 'getClientRects').mockReturnValue([new DOMRect(36, 12, 45, 18)] as unknown as DOMRectList);
  const guestWindow = {
    innerWidth: 200,
    innerHeight: 200,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
    __TAURI_INTERNALS__: {
      invoke: async (_command: string, { event, payload }: { event: string; payload: unknown }) => {
        mocks.listeners.get(event)?.({ payload });
      },
    },
  };
  mocks.evalInWebview.mockImplementation(async script => {
    new Function('window', 'document', script)(guestWindow, guest);
  });

  const rgba = vi.fn();
  const putImageData = vi.fn();
  const draw = vi.fn();
  const dispose = vi.fn();
  vi.spyOn(offscreenGpu, 'createOffscreenGpu').mockImplementation(canvas => {
    canvas.width = canvas.height = 8;
    return { draw, dispose };
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type =>
    type === '2d' ? { putImageData } as unknown as CanvasRenderingContext2D : null);
  vi.stubGlobal('ImageData', class { constructor(data: Uint8ClampedArray) { rgba([...data.slice(0, 4)]); } });
  let bounds = new DOMRect(50, 80, 200, 100);
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(() => bounds);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  const runAnimationFrame = () => act(async () => {
    const queued = [...callbacks.values()];
    callbacks.clear();
    queued.forEach(callback => callback(0));
  });

  function fullFrame(revision: number, width: number) {
    const frame = new ArrayBuffer(52 + width * 4 * 4);
    [0x3152534f, revision, width, 4, width / 2, 2, 0, 0, width, 4, 0, -1, -1]
      .forEach((value, index) => new DataView(frame).setUint32(index * 4, value, true));
    new Uint32Array(frame, 52).fill(0xff102030);
    return frame;
  }
  let receiveFrame: (frame: ArrayBuffer) => void = () => {};
  mocks.invoke.mockImplementation(async (command, { request }) => {
    if (command === 'browser_webview_osr_frame') {
      return request.afterRevision === 0 ? fullFrame(1, 4) : new Promise<ArrayBuffer>(resolve => { receiveFrame = resolve; });
    }
    for (const event of request.events) {
      if (event.kind === 'move') hovered.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      if (event.kind === 'button' && event.up) {
        picked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }
  });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  document.documentElement.style.setProperty('--openbitfun-domain-inspector-active-border', 'rgb(12, 34, 56)');
  document.documentElement.style.setProperty('--openbitfun-domain-inspector-selected-border', 'rgb(56, 34, 12)');
  try {
    await act(async () => root.render(<BrowserPanel isActive />));
    await runAnimationFrame();
    const canvas = host.querySelector('canvas')!;
    const surface = canvas.parentElement!;
    const backdrop = surface.parentElement!;
    expect(backdrop.parentElement?.dataset.openbitfunPart).toBe('webviewHost');
    expect([canvas.width, canvas.height]).toEqual([8, 8]);
    expect([canvas.style.width, canvas.style.height]).toEqual(['4px', '4px']);
    expect(draw).toHaveBeenCalledWith(4, 4, 0, 0, 4, 4, expect.any(Uint8Array));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="browserView.startElementSelection"]')!.click();
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 150 }));
    });
    await runAnimationFrame();
    const overlay = guest.querySelector('[data-openbitfun-picker]')!.shadowRoot!;
    expect(overlay.querySelector('.tooltip')?.textContent).toBe('button#hovered');
    const box = overlay.querySelector<HTMLElement>('.box')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['4px', '8px', '22px', '16px']);
    expect(box.style.borderColor).toBe('rgb(12, 34, 56)');
    hoveredRect = new DOMRect(5, 9, 24, 16);
    await runAnimationFrame();
    expect([box.style.left, box.style.width]).toEqual(['5px', '24px']);

    // A moved DOM panel uses its new rect with the logical size of the Retina frame.
    bounds = new DOMRect(300, 180, 200, 100);
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 450, clientY: 250, buttons: 1 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 450, clientY: 250 }));
    });
    await runAnimationFrame();
    expect(mocks.invoke).toHaveBeenCalledWith('browser_webview_osr_input', {
      request: { label: 'browser', events: [
        { kind: 'button', pointer: { x: 1, y: 1, width: 2, height: 2, modifiers: 16, panelOrigin: [300, 180] }, button: 'left', up: false, clicks: 1 },
        { kind: 'button', pointer: { x: 1, y: 1, width: 2, height: 2, modifiers: 0, panelOrigin: [300, 180] }, button: 'left', up: true, clicks: 1 },
      ] },
    });
    expect(mocks.addContext).toHaveBeenCalledWith(expect.objectContaining({
      type: 'web-element',
      path: 'button#picked',
      textContent: 'Selected text',
      sourceUrl: 'https://example.com',
    }));
    expect(overlay.querySelector('.selected .box')).toBe(box);
    expect([box.style.left, box.style.width]).toEqual(['36px', '45px']);
    expect(box.style.borderColor).toBe('rgb(56, 34, 12)');
    expect(mocks.reportError).not.toHaveBeenCalled();

    const menuItem = document.createElement('button');
    host.append(menuItem);
    const selectMenuItem = vi.fn();
    menuItem.addEventListener('click', selectMenuItem);
    const inputCallCount = mocks.invoke.mock.calls.filter(([command]) => command === 'browser_webview_osr_input').length;
    await act(async () => menuItem.click());
    await runAnimationFrame();
    expect(selectMenuItem).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'browser_webview_osr_input')).toHaveLength(inputCallCount);

    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mocks.listeners.has('browser-inspector-element-selected-browser')).toBe(false);
    expect(guest.querySelector('[data-openbitfun-picker]')).toBeNull();

    // The old frame stays at its logical size until Chromium paints the new size.
    backdrop.parentElement!.style.width = '3px';
    expect([surface.style.width, surface.style.height]).toEqual(['2px', '2px']);
    await act(async () => receiveFrame(fullFrame(2, 6)));
    expect([canvas.width, canvas.style.width, canvas.style.height]).toEqual([8, '4px', '4px']);
    expect([surface.style.width, surface.style.height]).toEqual(['3px', '2px']);
    expect(backdrop.style.backgroundColor).toBe('rgb(16, 32, 48)');
    expect(mocks.invoke).toHaveBeenCalledWith('browser_webview_osr_frame', {
      request: { label: 'browser', afterRevision: 2, protocol: 3 },
    });

    const keyboard = host.querySelector('textarea')!;
    await act(async () => {
      keyboard.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65 }));
      keyboard.dispatchEvent(new CompositionEvent('compositionstart'));
      keyboard.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni' }));
      keyboard.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }));
    });
    await runAnimationFrame();
    expect(mocks.invoke).toHaveBeenCalledWith('browser_webview_osr_input', {
      request: { label: 'browser', events: [
        { kind: 'key', key: 'a', code: 'KeyA', virtualKey: 65, location: 0, modifiers: 0, repeat: false, up: false, text: 'a' },
        { kind: 'composition', text: 'ni', commit: false },
        { kind: 'composition', text: '你', commit: true },
      ] },
    });

    await act(async () => canvas.dispatchEvent(new Event('webglcontextlost')));
    const softwareCanvas = host.querySelector('canvas')!;
    expect(softwareCanvas).not.toBe(canvas);
    expect(dispose).toHaveBeenCalledOnce();
    expect([softwareCanvas.width, softwareCanvas.height]).toEqual([4, 4]);
    expect(rgba).toHaveBeenCalledWith([0x10, 0x20, 0x30, 0xff]);
    expect(mocks.reportError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    document.documentElement.style.removeProperty('--openbitfun-domain-inspector-active-border');
    document.documentElement.style.removeProperty('--openbitfun-domain-inspector-selected-border');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
