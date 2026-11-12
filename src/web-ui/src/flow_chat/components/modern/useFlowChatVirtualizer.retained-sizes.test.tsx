// @vitest-environment jsdom

/**
 * Sizes a transcript retained from an earlier mount, seeded on remount.
 *
 * A retained size is a measurement, not an estimate: rows that still have it
 * cost no correction, and the next resize of one is judged as a resize of
 * content the reader may be looking at, not as a first measurement.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ESTIMATE_PX = 100;

interface Item { key: string }

function Harness({ scroller, header, items, retainedItemSizes, shiftViewport, onApi }: {
  scroller: HTMLElement;
  header: HTMLElement;
  items: Item[];
  retainedItemSizes?: ReadonlyMap<string, number>;
  shiftViewport: (byPx: number) => boolean;
  onApi: (api: FlowChatVirtualizer) => void;
}) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  const headerRef = React.useRef<HTMLElement | null>(header);
  onApi(useFlowChatVirtualizer({
    items,
    scrollerRef,
    headerRef,
    getItemKey: (item: Item) => item.key,
    estimateItemHeightPx: () => ESTIMATE_PX,
    scrollPaddingStartPx: 0,
    writeViewport: () => true,
    shiftViewport,
    retainedItemSizes,
  }));
  return null;
}

describe('useFlowChatVirtualizer retained item sizes', () => {
  let container: HTMLDivElement, root: Root, scroller: HTMLDivElement, header: HTMLDivElement;
  let api: FlowChatVirtualizer;
  const heights = new Map<number, number>();
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  function renderRow(index: number, heightPx: number) {
    heights.set(index, heightPx);
    let element = scroller.querySelector<HTMLElement>(`[data-virtual-index="${index}"]`);
    if (!element) {
      element = document.createElement('div');
      element.setAttribute('data-virtual-index', String(index));
      element.getBoundingClientRect = () => ({ top: 0, bottom: heights.get(index)!, height: heights.get(index)!, width: 500 }) as DOMRect;
      scroller.appendChild(element);
    }
  }
  const mount = (retainedItemSizes: ReadonlyMap<string, number> | undefined, shiftViewport: (byPx: number) => boolean) => act(() => root.render(
    <Harness scroller={scroller} header={header} items={items} retainedItemSizes={retainedItemSizes}
      shiftViewport={shiftViewport} onApi={next => { api = next; }} />,
  ));

  beforeEach(() => {
    heights.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scroller = document.createElement('div');
    header = document.createElement('div');
    container.appendChild(scroller);
    // The reader is 200px into the first row: it starts above the viewport.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 200, set() {} });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reserves retained sizes in place of estimates and hands them back', () => {
    mount(new Map([['a', 300], ['b', 40]]), () => true);
    expect(api.getItemBounds(1)).toEqual({ startPx: 300, endPx: 340 });
    expect(api.getItemBounds(2)).toEqual({ startPx: 340, endPx: 340 + ESTIMATE_PX });
    // Unmeasured c is an estimate, not something to hand to the next mount.
    expect([...api.snapshotItemSizes()]).toEqual([['b', 40], ['a', 300]]);
  });

  it('judges a retained row that resizes while partly visible as a measured row', () => {
    const shiftViewport = vi.fn(() => true);
    mount(new Map([['a', 300], ['b', 300], ['c', 300]]), shiftViewport);
    renderRow(0, 300);
    act(() => api.measureRenderedItems());
    // Still its retained size: nothing to correct.
    expect(shiftViewport).not.toHaveBeenCalled();
    renderRow(0, 500);
    act(() => api.measureRenderedItems());
    // The reader is looking at its grown content; the viewport stays put.
    expect(shiftViewport).not.toHaveBeenCalled();
    expect(api.getItemBounds(1)).toEqual({ startPx: 500, endPx: 800 });
  });

  it('still owes a first measurement for a row that starts above the reader', () => {
    const shiftViewport = vi.fn(() => true);
    mount(undefined, shiftViewport);
    renderRow(0, 300);
    act(() => api.measureRenderedItems());
    expect(shiftViewport).toHaveBeenCalledWith(300 - ESTIMATE_PX);
  });
});
