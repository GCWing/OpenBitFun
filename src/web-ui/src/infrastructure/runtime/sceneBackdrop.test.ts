// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeNativeSceneBackdrop } from './sceneBackdrop';

const bridge = vi.hoisted(() => ({ emit: vi.fn(), isMac: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: bridge.emit }));
vi.mock('./environment', () => ({ isMacOSDesktopRuntime: bridge.isMac }));

describe('native scene background', () => {
  let element: HTMLDivElement;
  let rect: DOMRect;
  let resize: () => void;
  let raf: (() => void) | undefined;
  let pixels: number[];
  let style: Partial<CSSStyleDeclaration>;
  let disconnect: ReturnType<typeof vi.fn>;
  let dispose: (() => void) | undefined;
  const flush = () => { const next = raf; raf = undefined; next?.(); };
  const lastSurface = () => bridge.emit.mock.calls.at(-1)?.[2].surface;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.isMac.mockReturnValue(true);
    bridge.emit.mockResolvedValue(undefined);
    pixels = [249, 248, 247, 255];
    raf = undefined;
    disconnect = vi.fn();
    style = { backgroundColor: 'rgb(249, 248, 247)', backgroundImage: 'none', opacity: '1', borderTopLeftRadius: '12px', borderBottomLeftRadius: '12px' };
    vi.stubGlobal('getComputedStyle', () => style);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { raf = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { raf = undefined; });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', fillRect: vi.fn(), getImageData: () => ({ data: pixels }),
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperties(window, {
      innerWidth: { value: 1200, configurable: true },
      innerHeight: { value: 800, configurable: true },
      devicePixelRatio: { value: 2, configurable: true },
    });
    element = document.createElement('div');
    rect = new DOMRect(300, 0, 900, 800);
    element.getBoundingClientRect = () => rect;
    document.body.append(element);
  });

  afterEach(() => {
    dispose?.(); dispose = undefined;
    element.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('projects scene insets and computed paint without sending every native resize', () => {
    ({ dispose } = observeNativeSceneBackdrop(element)); flush();
    expect(bridge.emit.mock.calls[0].slice(0, 2)).toEqual(['main', 'window://scene-backdrop']);
    expect(lastSurface()).toEqual({
      left: 300, top: 0, right: 0, bottom: 0, topLeftRadius: 12,
      bottomLeftRadius: 12, pixelRatio: 2, color: [249, 248, 247],
    });
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    rect = new DOMRect(300, 0, 1300, 800);
    resize(); window.dispatchEvent(new Event('resize')); flush();
    expect(bridge.emit).toHaveBeenCalledTimes(1);
    // Collapsing the sidebar updates the native origin, not only its size.
    rect = new DOMRect(0, 0, 1600, 800);
    resize(); flush();
    expect(lastSurface().left).toBe(0);
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledTimes(1);
  });

  it('refreshes theme and scale while leaving translucent or image backgrounds alone', () => {
    const observer = observeNativeSceneBackdrop(element); dispose = observer.dispose; flush();
    pixels = [31, 32, 33, 255];
    style.backgroundColor = 'rgb(31, 32, 33)';
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    observer.refresh(); flush();
    expect(lastSurface().color).toEqual([31, 32, 33]);
    expect(lastSurface().pixelRatio).toBe(3);
    pixels = [31, 32, 33, 120];
    style.backgroundColor = 'rgba(31, 32, 33, .47)';
    observer.refresh(); flush();
    expect(lastSurface()).toBeNull();
    pixels = [31, 32, 33, 255];
    style.backgroundColor = 'rgb(31, 32, 33)';
    style.backgroundImage = 'linear-gradient(red, blue)';
    observer.refresh(); flush();
    expect(lastSurface()).toBeNull();
  });

  it('clears a hidden/unmounted surface and cancels deferred updates on disposal', () => {
    const observer = observeNativeSceneBackdrop(element); dispose = observer.dispose; flush();
    rect = new DOMRect(); resize(); flush();
    expect(lastSurface()).toBeNull();
    observer.refresh(); observer.dispose(); dispose = undefined; flush();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(bridge.emit.mock.calls.at(-1)?.[2]).toMatchObject({ version: 1, release: true });
    const count = bridge.emit.mock.calls.length;
    resize(); flush();
    expect(bridge.emit).toHaveBeenCalledTimes(count);
  });

  it('skips non-macOS hosts and tolerates an unavailable optional bridge', async () => {
    bridge.isMac.mockReturnValue(false);
    const noop = observeNativeSceneBackdrop(element); noop.refresh(); noop.dispose(); flush();
    expect(bridge.emit).not.toHaveBeenCalled();
    bridge.isMac.mockReturnValue(true);
    bridge.emit.mockRejectedValue(new Error('unavailable'));
    ({ dispose } = observeNativeSceneBackdrop(element)); flush();
    await Promise.resolve();
    expect(lastSurface()).not.toBeNull();
  });
});
