// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowResizeLayout } from './WindowResizeLayout';
import { useWindowResizeLayout } from './windowResizeScheduler';

const bridge = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('@/infrastructure/runtime/windowResize', () => ({ subscribeNativeWindowResizeEnd: bridge.subscribe }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Content() {
  const suspended = useWindowResizeLayout(state => state.measurementSuspended);
  return <textarea data-suspended={String(suspended)} defaultValue="unsent draft" />;
}

describe('live window resize layout scheduling', () => {
  let root: Root, container: HTMLDivElement;
  let ended: () => void;
  let stop: ReturnType<typeof vi.fn>;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  const suspended = () => useWindowResizeLayout.getState().measurementSuspended;
  const resize = (width: number, height = 800) => act(() => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height);
    window.dispatchEvent(new Event('resize'));
  });
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const frame = () => act(() => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(performance.now()));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    frames = new Map(); frameId = 0;
    vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback); return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    stop = vi.fn();
    bridge.subscribe.mockImplementation(callback => { ended = callback; return stop; });
    useWindowResizeLayout.setState({ measurementSuspended: false });
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<><WindowResizeLayout /><Content /></>));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it('keeps isolated adjustments and the first maximize frame live, without an overlay or extra DOM', () => {
    const draft = container.querySelector('textarea')!;
    draft.value = 'keep this';
    draft.focus();
    for (const width of [1010, 995, 1020, 1600]) {
      resize(width);
      expect(suspended()).toBe(false);
      advance(100);
    }
    expect(document.body.children).toHaveLength(1);
    expect(container.childNodes).toHaveLength(1);
    expect(container.querySelector('textarea')).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe('keep this');
  });

  it('releases bounded batches during uninterrupted dragging and allows a layout opportunity', () => {
    resize(1100);
    advance(16); resize(1200);
    expect(suspended()).toBe(true);
    advance(16); resize(1300);
    advance(16); resize(1400);
    expect(suspended()).toBe(true);
    advance(16); // 48 ms from the first batched event, not from the last one.
    expect(suspended()).toBe(false);
    resize(1500);
    expect(suspended()).toBe(false);
    frame();
    advance(16); resize(1600);
    expect(suspended()).toBe(true);
    expect(container.childNodes).toHaveLength(1);
  });

  it('releases at native mouseup immediately and does not re-suspend for the final DOM event', () => {
    resize(1100); advance(16); resize(1200);
    expect(suspended()).toBe(true);
    act(() => ended());
    expect(suspended()).toBe(false);
    expect(frames.size).toBe(0);
    resize(1201);
    expect(suspended()).toBe(false);
    advance(300);
    expect(suspended()).toBe(false);
  });

  it('catches up after a brief pause without native events, even if rendering frames stop', () => {
    resize(1100); advance(16); resize(1200);
    advance(31);
    expect(suspended()).toBe(true);
    advance(1);
    expect(suspended()).toBe(false);
    // A suspended RAF cannot keep measurement blocked or repeatedly re-arm it.
    resize(1300); advance(16); resize(1400);
    expect(suspended()).toBe(false);
  });

  it('ignores duplicates and unusable viewport bounds, and includes vertical resizing', () => {
    resize(1000); resize(1000);
    resize(1100, 0); resize(0, 800);
    expect(suspended()).toBe(false);
    resize(1000, 850); advance(16); resize(1000, 900);
    expect(suspended()).toBe(true);
    advance(16); resize(1000, 900); // No extension of the quiet timer.
    advance(16);
    expect(suspended()).toBe(false);
  });

  it('cancels work when hidden or unmounted and ignores late native completion', () => {
    resize(1100); advance(16); resize(1200);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(suspended()).toBe(false);
    resize(1300);
    expect(suspended()).toBe(false);
    act(() => root.render(null));
    expect(stop).toHaveBeenCalledOnce();
    act(() => ended());
    frame(); advance(2000);
    expect(suspended()).toBe(false);
    expect(frames.size).toBe(0);
  });
});
