// @vitest-environment jsdom
import React, { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer } from './useFlowChatVirtualizer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const windows: number[][] = [];
function Harness({ count, tail }: { count: number; tail: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const api = useFlowChatVirtualizer({
    items: Array.from({ length: count }, (_, index) => index),
    scrollerRef, headerRef,
    getItemKey: String,
    estimateItemHeightPx: () => 100,
    startAtTailOnMount: tail,
    scrollPaddingStartPx: 0,
    writeViewport: ({ topPx }) => {
      const element = scrollerRef.current;
      if (!element) return false;
      // Model a browser clamping a write while no rows have mounted yet.
      element.scrollTop = Math.max(0, Math.min(topPx, element.scrollHeight - 500));
      return true;
    },
  });
  useLayoutEffect(() => { windows.push(api.rows.map(row => row.index)); });
  return <div ref={scrollerRef} data-scroller>
    <div ref={headerRef} />
    <div data-items style={{ paddingTop: api.paddingTopPx, paddingBottom: api.paddingBottomPx }}>
      {api.rows.map(row => <div key={row.key} data-virtual-index={row.index} ref={api.measureRowElement} />)}
    </div>
  </div>;
}

describe('initial virtual window with the real virtualizer', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    windows.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    // Explicit geometry supplies jsdom's missing layout, not performance proof.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      if (this.hasAttribute('data-scroller')) return 500;
      return this.hasAttribute('data-virtual-index') ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const items = this.querySelector<HTMLElement>('[data-items]');
      return items ? Number.parseFloat(items.style.paddingTop || '0')
        + Number.parseFloat(items.style.paddingBottom || '0') + items.childElementCount * 80 : 0;
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = (count: number, tail: boolean) => act(() => root.render(<Harness count={count} tail={tail} />));

  it('mounts the tail first without measuring head rows, then accepts user scrolling', () => {
    render(34, true);
    const populated = windows.filter(window => window.length);
    expect(populated.length).toBeGreaterThan(0);
    expect(populated[0].at(-1)).toBe(33);
    expect(populated.every(window => window[0] > 0)).toBe(true);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(windows.at(-1)?.[0]).toBe(0);
  });

  it('waits for initially empty data before consuming the tail seed', () => {
    render(0, true);
    expect(windows.every(window => window.length === 0)).toBe(true);
    render(34, true);
    const first = windows.find(window => window.length)!;
    expect(first[0]).toBeGreaterThan(0);
    expect(first.at(-1)).toBe(33);
  });

  it('preserves the default head window for history and reading restoration', () => {
    render(34, false);
    expect(windows.find(window => window.length)?.[0]).toBe(0);
  });

  it('handles a single row and does not re-seed after later data changes', () => {
    render(1, true);
    expect(windows.find(window => window.length)).toEqual([0]);
    windows.length = 0;
    render(34, true);
    expect(windows.find(window => window.length)?.[0]).toBe(0);
  });
});
