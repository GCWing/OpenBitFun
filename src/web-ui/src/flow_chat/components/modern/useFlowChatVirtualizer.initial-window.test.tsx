// @vitest-environment jsdom
import React, { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const windows: number[][] = [];
const viewportWrites: Array<{ topPx: number; behavior?: ScrollBehavior }> = [];
let latestApi: FlowChatVirtualizer;
let reconcileEnabled = false;
let shortOverscan = false;
let viewportSuspended = false;
let shiftEnabled = false;
const unobserve = vi.fn();
const rowObservers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];

function KeyedHarness({ items, endOrigin, pinnedKeys, isReaderScrolling }: {
  items: string[]; endOrigin: boolean; pinnedKeys?: ReadonlySet<string>; isReaderScrolling?: () => boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const api = useFlowChatVirtualizer({
    items, scrollerRef, headerRef, endOrigin, pinnedKeys, isReaderScrolling,
    isViewportSuspended: () => viewportSuspended,
    getItemKey: item => item,
    estimateItemHeightPx: () => 80,
    scrollPaddingStartPx: 0,
    writeViewport: () => true,
  });
  latestApi = api;
  return <div ref={scrollerRef} data-scroller>
    <div ref={headerRef} />
    {api.rows.map(row => <div key={row.key} data-row-key={row.key}
      data-virtual-index={row.index} ref={api.measureRowElement} />)}
  </div>;
}
function Harness({ count, tail }: { count: number; tail: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const api = useFlowChatVirtualizer({
    items: Array.from({ length: count }, (_, index) => index),
    scrollerRef, headerRef,
    getItemKey: String,
    estimateItemHeightPx: () => 100,
    startAtTailOnMount: tail,
    isViewportSuspended: () => viewportSuspended,
    shiftViewport: delta => {
      const scroller = scrollerRef.current;
      if (!shiftEnabled || !scroller) return false;
      scroller.scrollTop += delta;
      return true;
    },
    reconcileOpeningMeasurement: () => {
      const scroller = scrollerRef.current;
      if (!reconcileEnabled || !scroller) return false;
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - 500);
      // Opening follow publishes from inside measurement reconciliation too.
      latestApi.syncViewportOffset(scroller.scrollTop);
      return true;
    },
    scrollPaddingStartPx: 0,
    writeViewport: ({ topPx, behavior }) => {
      viewportWrites.push({ topPx, behavior });
      const element = scrollerRef.current;
      if (!element) return false;
      // Model a browser clamping a write while no rows have mounted yet.
      element.scrollTop = Math.max(0, Math.min(topPx, element.scrollHeight - 500));
      return true;
    },
  });
  latestApi = api;
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
    viewportWrites.length = 0;
    reconcileEnabled = false;
    shortOverscan = false;
    viewportSuspended = false;
    shiftEnabled = false;
    unobserve.mockClear();
    rowObservers.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = this.offsetHeight;
      return { top: 0, bottom: height, height, width: this.offsetWidth } as DOMRect;
    });
    vi.stubGlobal('ResizeObserver', class {
      entry: (typeof rowObservers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, elements: new Set() };
        rowObservers.push(this.entry);
      }
      observe(element: Element) { this.entry.elements.add(element); }
      unobserve(element: Element) { unobserve(element); this.entry.elements.delete(element); }
      disconnect() { this.entry.elements.clear(); }
    });
    // Explicit geometry supplies jsdom's missing layout, not performance proof.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      if (this.hasAttribute('data-scroller')) return 500;
      if (!this.hasAttribute('data-virtual-index')) return 0;
      return shortOverscan && Number(this.getAttribute('data-virtual-index')) < 27 ? 10 : 80;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const items = this.querySelector<HTMLElement>('[data-items]');
      return items ? Number.parseFloat(items.style.paddingTop || '0')
        + Number.parseFloat(items.style.paddingBottom || '0')
        + [...items.children].reduce((sum, row) => sum + (row as HTMLElement).offsetHeight, 0) : 0;
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
    vi.useRealTimers();
  });
  const render = (count: number, tail: boolean) => act(() => root.render(<Harness count={count} tail={tail} />));

  it('reuses a covered reading window and immediately covers a distant wheel step', () => {
    render(200, false);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      scroller.scrollTop = 4000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const rows = [...host.querySelectorAll('[data-virtual-index]')];
    const commits = windows.length;
    act(() => {
      scroller.scrollTop += 80;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(windows.length).toBe(commits);
    expect([...host.querySelectorAll('[data-virtual-index]')]).toEqual(rows);
    act(() => {
      scroller.scrollTop = 11000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(windows.length).toBeGreaterThan(commits);
    const range = latestApi.getVisibleItemRange()!;
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      expect(host.querySelector(`[data-virtual-index="${index}"]`)).not.toBeNull();
    }
  });

  it('reuses bottom-origin history windows with the latest row pinned', () => {
    const items = Array.from({ length: 200 }, (_, index) => `key-${index}`);
    act(() => root.render(<KeyedHarness items={items} endOrigin pinnedKeys={new Set(['key-199'])} />));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => { scroller.scrollTop = -4000; scroller.dispatchEvent(new Event('scroll')); });
    const committed = latestApi;
    act(() => { scroller.scrollTop -= 80; scroller.dispatchEvent(new Event('scroll')); });
    expect(latestApi).toBe(committed);
    expect(latestApi.rows.some(row => row.key === 'key-199')).toBe(true);
  });

  it('updates a pinned row address even when the visible window keeps its keys', () => {
    const items = Array.from({ length: 200 }, (_, index) => `key-${index}`);
    const pinnedKeys = new Set(['key-199']);
    act(() => root.render(<KeyedHarness items={items} endOrigin={false} pinnedKeys={pinnedKeys} />));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => { scroller.scrollTop = 4000; scroller.dispatchEvent(new Event('scroll')); });
    const reordered = [...items];
    [reordered[198], reordered[199]] = [reordered[199], reordered[198]];
    act(() => root.render(<KeyedHarness items={reordered} endOrigin={false} pinnedKeys={pinnedKeys} />));
    expect(latestApi.rows.find(row => row.key === 'key-199')?.index).toBe(198);
    expect(latestApi.rows.some(row => row.key === 'key-198')).toBe(false);
  });

  it('releases a retained window so an inserted visible row is mounted', () => {
    const items = Array.from({ length: 200 }, (_, index) => `key-${index}`);
    act(() => root.render(<KeyedHarness items={items} endOrigin={false} />));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => { scroller.scrollTop = 4000; scroller.dispatchEvent(new Event('scroll')); });
    const visible = latestApi.getVisibleItemRange()!;
    const inserted = [...items];
    inserted.splice(visible.startIndex + 1, 0, 'inserted-visible');
    act(() => root.render(<KeyedHarness items={inserted} endOrigin={false} />));
    expect(host.querySelector('[data-row-key="inserted-visible"]')).not.toBeNull();
  });

  it('keeps reader-owned overscan across a non-scrolling measurement readback', () => {
    const items = Array.from({ length: 200 }, (_, index) => `key-${index}`);
    let reading = true;
    act(() => root.render(<KeyedHarness items={items} endOrigin={false} isReaderScrolling={() => reading} />));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => { scroller.scrollTop = 4000; scroller.dispatchEvent(new Event('scroll')); });
    const keys = latestApi.rows.map(row => row.key);
    // The real adapter publishes compensated offsets with isScrolling=false.
    act(() => { scroller.scrollTop += 80; latestApi.syncViewportOffset(scroller.scrollTop); });
    expect(latestApi.rows.map(row => row.key)).toEqual(keys);
    reading = false;
    act(() => { scroller.scrollTop += 80; latestApi.syncViewportOffset(scroller.scrollTop); });
    expect(latestApi.rows.map(row => row.key)).not.toEqual(keys);
  });

  it.each([
    [false, false], [false, true], [true, false],
  ])('observes rows mounted during suspension after resuming (%s → %s)', (initialOrigin, resumedOrigin) => {
    viewportSuspended = true;
    act(() => root.render(<KeyedHarness items={['a', 'b', 'c']} endOrigin={initialOrigin} />));
    const row = host.querySelector<HTMLElement>('[data-row-key="b"]')!;
    expect(row).not.toBeNull();
    expect(rowObservers.some(entry => entry.elements.has(row))).toBe(false);
    // A still-suspended commit can discard other rows and switch the origin.
    act(() => root.render(<KeyedHarness items={['a', 'b', 'd']} endOrigin={resumedOrigin} />));
    viewportSuspended = false;
    act(() => root.render(<KeyedHarness items={['a', 'b', 'd']} endOrigin={resumedOrigin} />));
    expect(host.querySelector('[data-row-key="b"]')).toBe(row);
    const observer = rowObservers.find(entry => entry.elements.has(row));
    expect(observer).toBeDefined();
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ height: 221.5 } as DOMRect);
    act(() => observer!.callback([{ target: row } as ResizeObserverEntry], {} as ResizeObserver));
    const bounds = latestApi.getItemBounds(1)!;
    expect(bounds.endPx - bounds.startPx).toBe(221.5);
  });

  it.each([false, true])('keeps observer measurements on surviving keys after insertion (endOrigin=%s)', endOrigin => {
    const initial = ['a', 'b', 'c'];
    act(() => root.render(<KeyedHarness items={initial} endOrigin={endOrigin} />));
    const row = host.querySelector<HTMLElement>('[data-row-key="b"]')!;
    const updated = endOrigin ? [...initial, 'new-tail'] : ['older', ...initial];
    act(() => root.render(<KeyedHarness items={updated} endOrigin={endOrigin} />));
    expect(host.querySelector('[data-row-key="b"]')).toBe(row);
    const observer = rowObservers.find(entry => entry.elements.has(row))!;
    expect(observer).toBeDefined();
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ height: 221.5 } as DOMRect);
    act(() => observer.callback([{ target: row } as ResizeObserverEntry], {} as ResizeObserver));
    const height = (key: string) => {
      const bounds = latestApi.getItemBounds(updated.indexOf(key))!;
      return bounds.endPx - bounds.startPx;
    };
    expect(height('b')).toBe(221.5);
    expect(height('a')).toBe(80);
    expect(height('c')).toBe(80);
  });

  it('unobserves removed rows when the transcript becomes empty without new attachments', () => {
    render(8, false);
    const rows = [...host.querySelectorAll('[data-virtual-index]')];
    expect(rows.length).toBeGreaterThan(0);
    unobserve.mockClear();
    render(0, false);
    expect(host.querySelectorAll('[data-virtual-index]')).toHaveLength(0);
    for (const row of rows) expect(unobserve).toHaveBeenCalledWith(row);
  });

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

  it('measures newly mounted rows during a gesture before ResizeObserver delivers', () => {
    render(100, false);
    const firstWindow = new Set(windows.at(-1));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      scroller.scrollTop = 4000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const arrived = windows.at(-1)!.filter(index => !firstWindow.has(index));
    expect(arrived.length).toBeGreaterThan(0);
    // No observer delivery or animation frame: the first scrolling commit
    // must already agree with the rows' actual heights, not their estimates.
    for (const index of arrived) {
      const bounds = latestApi.getItemBounds(index)!;
      expect(bounds.endPx - bounds.startPx).toBe(80);
    }
  });

  it('keeps a smooth aim stable and resumes immediate measurement on reader takeover', () => {
    // A short Turn header precedes an answer taller than the viewport. While
    // returning to that mounted header, earlier overscan rows enter the window.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      if (this.hasAttribute('data-scroller')) return 500;
      if (!this.hasAttribute('data-virtual-index')) return 0;
      return Number(this.getAttribute('data-virtual-index')) === 40 ? 3000 : 80;
    });
    render(100, false);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      scroller.scrollTop = 4000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    act(() => latestApi.measureRenderedItems());
    act(() => {
      scroller.scrollTop = 5200;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const target = 39;
    expect(host.querySelector(`[data-virtual-index="${target}"]`)).not.toBeNull();
    const targetStart = latestApi.getItemBounds(target)!.startPx;
    const beforeAim = new Set(windows.at(-1));
    const pendingFrames: FrameRequestCallback[] = [];
    vi.mocked(requestAnimationFrame).mockImplementation(callback => {
      pendingFrames.push(callback);
      return pendingFrames.length + 100;
    });
    viewportWrites.length = 0;
    act(() => latestApi.scrollItemIntoView(target, {
      align: 'start', behavior: 'smooth', owner: 'one-shot-navigation',
    }));
    // Deliver an in-flight native animation offset, without a reader gesture
    // or ResizeObserver delivery. The adapter must preserve the library's
    // smooth-scroll measurement policy for newly mounted overscan rows.
    act(() => {
      scroller.scrollTop = targetStart + 20;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(windows.at(-1)!.some(index => index < target && !beforeAim.has(index))).toBe(true);
    for (const callback of pendingFrames.splice(0)) act(() => callback(16));
    expect(latestApi.getItemBounds(target)!.startPx).toBe(targetStart);
    expect(viewportWrites).toEqual([{ topPx: targetStart, behavior: 'smooth' }]);

    // The ordinary intent handler cancels the aim before reader scrolling.
    // New rows must still be measured synchronously in that first commit.
    const beforeTakeover = new Set(windows.at(-1));
    act(() => {
      latestApi.cancelAim();
      scroller.scrollTop = 8000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const arrived = windows.at(-1)!.filter(index => !beforeTakeover.has(index));
    expect(arrived.length).toBeGreaterThan(0);
    for (const index of arrived) {
      const bounds = latestApi.getItemBounds(index)!;
      expect(bounds.endPx - bounds.startPx).toBe(80);
    }
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

  it('expands the opening window from a readback before any native scroll arrives', () => {
    shortOverscan = true;
    render(34, true);
    reconcileEnabled = true;
    const initialFirst = windows.at(-1)![0];
    expect(initialFirst).toBeGreaterThan(0);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      latestApi.scrollToOffset(scroller.scrollHeight - 500, { owner: 'follow-output' });
      latestApi.syncViewportOffset(scroller.scrollTop);
    });
    const first = windows.at(-1)![0];
    expect(first).toBeLessThan(initialFirst);
    expect(windows.at(-1)!.at(-1)).toBe(33);
    const row = host.querySelector(`[data-virtual-index="${first}"]`);
    const commits = windows.length;
    act(() => latestApi.syncViewportOffset(scroller.scrollTop));
    expect(windows).toHaveLength(commits);
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(200);
    });
    expect(windows.at(-1)![0]).toBe(first);
    expect(host.querySelector(`[data-virtual-index="${first}"]`)).toBe(row);
    reconcileEnabled = false;
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(windows.at(-1)![0]).toBe(0);
  });

  it('does not publish readbacks while the viewport is suspended', () => {
    render(34, true);
    const commits = windows.length;
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    viewportSuspended = true;
    act(() => latestApi.syncViewportOffset(scroller.scrollTop));
    expect(windows).toHaveLength(commits);
    viewportSuspended = false;
    act(() => latestApi.syncViewportOffset(scroller.scrollTop));
    expect(windows.at(-1)![0]).toBe(0);
  });

  it('keeps the live window aligned when native layout clamps before its scroll event', () => {
    render(34, true);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      latestApi.scrollToOffset(scroller.scrollHeight - 500, { owner: 'follow-output' });
      latestApi.syncViewportOffset(scroller.scrollTop);
    });
    // A collection above the output shrinks. The browser clamps now, while
    // native scroll/scroll-end delivery still describes the previous range.
    shortOverscan = true;
    act(() => {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - 500);
      latestApi.measureRenderedItems();
    });
    const measuredWindow = [...windows.at(-1)!];
    const mountedRows = [...host.querySelectorAll('[data-virtual-index]')];
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(windows.at(-1)).toEqual(measuredWindow);
    expect([...host.querySelectorAll('[data-virtual-index]')]).toEqual(mountedRows);
  });

  it('keeps the measured reading window stable before the compensation scroll event arrives', () => {
    shortOverscan = true;
    render(34, true);
    shiftEnabled = true;
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      scroller.scrollTop = 2500;
      scroller.dispatchEvent(new Event('scroll'));
    });
    act(() => latestApi.measureRenderedItems());
    expect(scroller.scrollTop).toBeLessThan(2500);
    const committedWindow = [...windows.at(-1)!];
    const mountedRows = [...host.querySelectorAll('[data-virtual-index]')];
    // Scroll-end still holds the offset from before the owner applied the shift.
    act(() => vi.advanceTimersByTime(200));
    expect(windows.at(-1)).toEqual(committedWindow);
    expect([...host.querySelectorAll('[data-virtual-index]')]).toEqual(mountedRows);
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(windows.at(-1)).toEqual(committedWindow);
    expect([...host.querySelectorAll('[data-virtual-index]')]).toEqual(mountedRows);
  });

  it.each([false, true])('reconciles measured overscan before delayed events (enabled=%s)', enabled => {
    shortOverscan = true;
    render(34, true);
    reconcileEnabled = enabled;
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      latestApi.scrollToOffset(scroller.scrollHeight - 500, { owner: 'follow-output' });
      scroller.dispatchEvent(new Event('scroll'));
    });
    const first = windows.at(-1)![0];
    if (!enabled) {
      // Control: the old cached offset contracts the window back to the last row.
      expect(first).toBe(27);
      return;
    }
    expect(first).toBeLessThan(27);
    const overscanRow = host.querySelector(`[data-virtual-index="${first}"]`);
    expect(overscanRow).not.toBeNull();
    // Native scroll dispatch is intentionally withheld after reconciliation.
    // The old scroll-end timeout must not restore its captured, outdated offset.
    act(() => vi.advanceTimersByTime(200));
    expect(windows.at(-1)![0]).toBe(first);
    expect(host.querySelector(`[data-virtual-index="${first}"]`)).toBe(overscanRow);
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(windows.at(-1)![0]).toBe(first);
    expect(host.querySelector(`[data-virtual-index="${first}"]`)).toBe(overscanRow);
  });
});
