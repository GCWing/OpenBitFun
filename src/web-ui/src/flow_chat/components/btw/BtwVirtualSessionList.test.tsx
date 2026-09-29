// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BtwVirtualSessionList } from './BtwVirtualSessionList';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowChatViewportOwnerApi } from '../modern/useFlowChatViewportOwner';

vi.mock('../modern/VirtualItemRenderer', () => ({
  VirtualItemRenderer: ({ index, measureRef }: { index: number; measureRef: React.Ref<HTMLDivElement> }) => (
    <div ref={measureRef} data-virtual-index={index}>{index}</div>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('BtwVirtualSessionList', () => {
  let host: HTMLDivElement;
  let scroller: HTMLDivElement;
  let header: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let followRef: { current: boolean };
  let owner: FlowChatViewportOwnerApi;
  let resizeObservers: Array<{ targets: Set<Element>; callback: ResizeObserverCallback }>;
  const items = Array.from({ length: 1000 }, (_, index) => ({
    type: 'image-analyzing', turnId: `turn-${index}`,
  } as VirtualItem));

  function render(renderedItems = items) {
    act(() => root.render(
      <BtwVirtualSessionList
        items={renderedItems}
        scrollerRef={{ current: scroller }}
        headerRef={{ current: header }}
        followRef={followRef}
        viewportOwner={owner}
        exploreGroupStates={new Map()}
        isHistorical={false}
      />,
    ));
  }

  beforeEach(() => {
    frames = new Map();
    resizeObservers = [];
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push({ targets: this.targets, callback });
      }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    });
    host = document.createElement('div');
    scroller = document.createElement('div');
    header = document.createElement('div');
    document.body.appendChild(scroller);
    scroller.append(header, host);
    for (const [key, value] of Object.entries({
      offsetHeight: 500, offsetWidth: 500, clientHeight: 500, clientWidth: 500, scrollHeight: 100000,
    })) Object.defineProperty(scroller, key, { configurable: true, value });
    // Real row measurement must be positive in jsdom, just as in WebView2.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
    root = createRoot(host);
    followRef = { current: false };
    owner = {
      write: vi.fn(() => true), shift: vi.fn(() => true),
      claim: vi.fn(() => true), release: vi.fn(), canShift: () => true, currentOwner: () => null,
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    scroller.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mounts a bounded window and reaches distant history by scrolling', () => {
    render();
    expect(host.querySelectorAll('[data-virtual-index]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('[data-virtual-index]').length).toBeLessThan(40);
    const initialIndexes = [...host.querySelectorAll('[data-virtual-index]')]
      .map(node => Number(node.getAttribute('data-virtual-index')));
    expect(host.querySelector('[data-virtual-index="500"]')).toBeNull();
    act(() => {
      scroller.scrollTop = 20000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const indexes = [...host.querySelectorAll('[data-virtual-index]')]
      .map(node => Number(node.getAttribute('data-virtual-index')));
    expect(Math.min(...indexes)).toBeGreaterThan(Math.max(...initialIndexes));
    expect(indexes.length).toBeLessThan(40);
  });

  it('rechecks follow intent before a queued frame and cancels on unmount', () => {
    followRef.current = true;
    render();
    vi.mocked(owner.write).mockClear();
    followRef.current = false;
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(16));
    });
    expect(owner.write).not.toHaveBeenCalled();
    followRef.current = true;
    render();
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(32));
    });
    expect(owner.write).toHaveBeenCalledWith({ owner: 'follow-output', topPx: 100000, holdForMs: 0 });
    render();
    act(() => root.render(null));
    expect(frames.size).toBe(0);
  });

  it('follows the measured scroll range when mounted content changes height', () => {
    followRef.current = true;
    render();
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(16));
    });
    vi.mocked(owner.write).mockClear();
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 120000 });
    act(() => {
      for (const observer of resizeObservers) {
        if (observer.targets.has(host.firstElementChild!)) {
          observer.callback([], {} as ResizeObserver);
        }
      }
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(32));
    });
    expect(owner.write).toHaveBeenCalledWith({
      owner: 'follow-output', topPx: 120000, holdForMs: 0,
    });
  });

  it.each([false, true])('settles tail rows when trailing margins are measured: %s', contained => {
    // Supplied CSS geometry: a 100px body and an 8px trailing child margin.
    // With flow-root both occupy the measured border box; with block the
    // margin escapes, still occupies layout space, and vanishes on unmount.
    // jsdom does not perform margin collapsing; this tests its consequences
    // against the real virtualizer and the panel's real follow scheduler.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.hasAttribute('data-virtual-index') ? (contained ? 108 : 100) : 0;
    });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => {
      const window = host.firstElementChild as HTMLElement | null;
      if (!window) return 500;
      return Math.max(500, 15 + Number.parseFloat(window.style.paddingTop || '0')
        + Number.parseFloat(window.style.paddingBottom || '0') + window.children.length * 108);
    } });
    let offset = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => Math.max(0, Math.min(offset, scroller.scrollHeight - scroller.clientHeight)),
      set: (value: number) => { offset = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight)); },
    });
    vi.mocked(owner.write).mockImplementation(({ topPx }) => {
      scroller.scrollTop = topPx;
      return true;
    });
    vi.mocked(owner.shift).mockImplementation(delta => {
      scroller.scrollTop += delta;
      return true;
    });
    followRef.current = true;
    render(items.slice(0, 20));
    const renderedWindows: string[] = [];
    const deliveredSizes = new WeakMap<object, Map<Element, number>>();
    for (let frame = 0; frame < 40; frame++) {
      act(() => {
        // New and resized rows are measured after layout, including rows
        // whose inline measurement was skipped during native scrolling.
        for (const observer of [...resizeObservers]) {
          const sizes = deliveredSizes.get(observer) ?? new Map<Element, number>();
          deliveredSizes.set(observer, sizes);
          const entries: ResizeObserverEntry[] = [];
          for (const target of observer.targets) {
            const blockSize = target === host.firstElementChild
              ? scroller.scrollHeight - 15 : (target as HTMLElement).offsetHeight;
            if (sizes.get(target) === blockSize) continue;
            sizes.set(target, blockSize);
            entries.push({ target, borderBoxSize: [{ blockSize, inlineSize: 500 }] } as unknown as ResizeObserverEntry);
          }
          if (entries.length) observer.callback(entries, {} as ResizeObserver);
        }
      });
      act(() => {
        // Browser scroll delivery precedes the next animation-frame write.
        scroller.dispatchEvent(new Event('scroll'));
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback(frame * 16));
      });
      if (frame >= 10) renderedWindows.push([...host.querySelectorAll('[data-virtual-index]')]
        .map(node => node.getAttribute('data-virtual-index')).join(','));
    }
    const window = host.firstElementChild as HTMLElement;
    const measuredTotal = Number.parseFloat(window.style.paddingTop || '0')
      + Number.parseFloat(window.style.paddingBottom || '0')
      + [...host.querySelectorAll<HTMLElement>('[data-virtual-index]')].reduce((sum, row) => sum + row.offsetHeight, 0);
    if (contained) {
      expect(new Set(renderedWindows).size).toBe(1);
      expect(host.querySelector('[data-virtual-index="19"]')).not.toBeNull();
      expect(scroller.scrollHeight - 15).toBe(measuredTotal);
    } else {
      // Adaptive overscan need not reproduce the old fixed-window oscillation,
      // but escaped margins still violate the geometry used for tail placement.
      expect(scroller.scrollHeight - 15 - measuredTotal).toBe(window.children.length * 8);
      expect(scroller.scrollHeight - 15).toBeGreaterThan(measuredTotal);
    }
  });
});
