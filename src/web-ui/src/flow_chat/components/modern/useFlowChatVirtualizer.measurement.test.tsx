// @vitest-environment jsdom

/**
 * Item positions, against the DOM rather than against the reservation.
 *
 * This is the one place FlowChat depends on how the library keeps its
 * measurement cache, and the dependency is invisible from the outside: a
 * position read too early is a plausible number, not an error. It is also the
 * dependency most likely to move under a version bump — `getMeasurements` is
 * `private` in the published types, and `resizeItem` is the only public way in.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** What the estimate says before anything has been rendered. */
const ESTIMATE_PX = 100;
/** What the rows turn out to be, which is the whole gap this closes. */
const REAL_PX = 40;

interface Item {
  key: string;
  knownHeightPx?: number;
  estimatedHeightPx?: number;
}

interface HarnessProps {
  scroller: HTMLElement;
  header: HTMLElement;
  items: Item[];
  onApi: (api: FlowChatVirtualizer) => void;
  isViewportSuspended?: () => boolean;
  widthPx?: number;
}

function Harness({ scroller, header, items, onApi, isViewportSuspended, widthPx }: HarnessProps) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  const headerRef = React.useRef<HTMLElement | null>(header);
  onApi(useFlowChatVirtualizer({
    items,
    scrollerRef,
    headerRef,
    getItemKey: (item: Item) => item.key,
    estimateItemHeightPx: (item: Item) => item.estimatedHeightPx ?? ESTIMATE_PX,
    getKnownItemHeightPx: (item: Item) => item.knownHeightPx,
    estimateContext: { availableWidthPx: widthPx },
    isViewportSuspended,
    scrollPaddingStartPx: 0,
    writeViewport: () => true,
  }));
  return null;
}

describe('useFlowChatVirtualizer measurement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scroller: HTMLDivElement;
  let header: HTMLDivElement;
  let api: FlowChatVirtualizer;

  /**
   * A row in the DOM, at a height jsdom would otherwise report as zero.
   *
   * `offsetHeight` and not a rect, because that is what the library's own
   * `measureElement` reads — the border box as an integer.
   */
  function renderRow(index: number, heightPx: number) {
    const element = document.createElement('div');
    element.setAttribute('data-virtual-index', String(index));
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: heightPx });
    scroller.appendChild(element);
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scroller = document.createElement('div');
    header = document.createElement('div');
    container.appendChild(scroller);

    const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    act(() => root.render(
      <Harness
        scroller={scroller}
        header={header}
        items={items}
        onApi={next => { api = next; }}
      />,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('places items by estimate until something has measured', () => {
    expect(api.getItemBounds(1)).toEqual({ startPx: ESTIMATE_PX, endPx: ESTIMATE_PX * 2 });
  });

  /**
   * Measure and read without letting React in between, which is the only
   * situation this exists for.
   *
   * The caller is a layout effect in the commit that prepended: the
   * re-render `resizeItem` schedules has not run, so anything reading the
   * `measurementsCache` field instead of the measurement pass still sees the
   * reservation. Letting `act` flush first would hide exactly that.
   */
  function measureAndRead(indexes: number[]) {
    let bounds: Array<{ startPx: number; endPx: number } | null> = [];
    act(() => {
      api.measureRenderedItems();
      bounds = indexes.map(index => api.getItemBounds(index));
    });
    return bounds;
  }

  it('places them by what the DOM says once the rendered rows are measured', () => {
    // The reservation was 100px a row and they are 40px, which is the shape of
    // every history junction measured: over by more than a factor of two.
    [0, 1, 2].forEach(index => renderRow(index, REAL_PX));

    expect(measureAndRead([0, 1, 2])).toEqual([
      { startPx: 0, endPx: REAL_PX },
      { startPx: REAL_PX, endPx: REAL_PX * 2 },
      { startPx: REAL_PX * 2, endPx: REAL_PX * 3 },
    ]);
  });

  it('leaves an item that is not rendered on its estimate', () => {
    // Only what has a height to read is read. The rest stay estimates, which is
    // what a virtualizer is — but they move, because the item above them did.
    renderRow(0, REAL_PX);

    expect(measureAndRead([0, 1])).toEqual([
      { startPx: 0, endPx: REAL_PX },
      { startPx: REAL_PX, endPx: REAL_PX + ESTIMATE_PX },
    ]);
  });

  it('never measures nested code or subagent viewport rows as transcript rows', () => {
    renderRow(0, REAL_PX);
    const nested = document.createElement('div');
    nested.setAttribute('data-flowchat-virtual-viewport', '');
    const line = document.createElement('div');
    line.setAttribute('data-virtual-index', '0');
    Object.defineProperty(line, 'offsetHeight', { value: 9999 });
    nested.appendChild(line); scroller.appendChild(nested);
    expect(measureAndRead([0])).toEqual([{ startPx: 0, endPx: REAL_PX }]);
  });

  it('retains unchanged mounted heights when scrollbar width invalidates the size cache', () => {
    [0, 1, 2].forEach(index => renderRow(index, REAL_PX));
    measureAndRead([2]);

    // Opening a collection introduces a scrollbar. Compact rows keep the same
    // border box, so ResizeObserver will not send another height change.
    for (const widthPx of [540, 525, 540]) {
      act(() => root.render(
        <Harness scroller={scroller} header={header}
          items={[{ key: 'a' }, { key: 'b' }, { key: 'c' }]} widthPx={widthPx}
          onApi={next => { api = next; }} />,
      ));
      expect(api.getItemBounds(2)).toEqual({ startPx: REAL_PX * 2, endPx: REAL_PX * 3 });
    }
  });

  it('replaces a stale measured size when a stable row is collected and restores its estimate when it returns', () => {
    renderRow(1, 300);
    measureAndRead([2]);
    expect(api.getItemBounds(2)?.startPx).toBe(400);

    act(() => root.render(
      <Harness
        scroller={scroller}
        header={header}
        items={[{ key: 'a' }, { key: 'b', knownHeightPx: 0 }, { key: 'c' }]}
        onApi={next => { api = next; }}
      />,
    ));
    expect(api.getItemBounds(1)).toEqual({ startPx: 100, endPx: 100 });
    expect(api.getItemBounds(2)?.startPx).toBe(100);

    act(() => root.render(
      <Harness
        scroller={scroller}
        header={header}
        items={[{ key: 'a' }, { key: 'b', estimatedHeightPx: 120 }, { key: 'c' }]}
        onApi={next => { api = next; }}
      />,
    ));
    expect(api.getItemBounds(2)?.startPx).toBe(220);
  });

  it('does not measure rendered rows while the native host has suspended the viewport', () => {
    act(() => root.render(
      <Harness
        scroller={scroller}
        header={header}
        items={[{ key: 'a' }, { key: 'b' }, { key: 'c' }]}
        onApi={next => { api = next; }}
        isViewportSuspended={() => true}
      />,
    ));
    renderRow(0, REAL_PX);

    expect(measureAndRead([0, 1])).toEqual([
      { startPx: 0, endPx: ESTIMATE_PX },
      { startPx: ESTIMATE_PX, endPx: ESTIMATE_PX * 2 },
    ]);
  });

  it('ignores an element carrying no usable index', () => {
    const stray = document.createElement('div');
    stray.setAttribute('data-virtual-index', 'not-an-index');
    Object.defineProperty(stray, 'offsetHeight', { configurable: true, value: 999 });
    scroller.appendChild(stray);
    renderRow(0, REAL_PX);

    expect(measureAndRead([0])).toEqual([{ startPx: 0, endPx: REAL_PX }]);
  });

  it('reports nothing for an index the transcript has no item at', () => {
    expect(api.getItemBounds(3)).toBeNull();
    expect(api.getItemBounds(-1)).toBeNull();
  });
});
