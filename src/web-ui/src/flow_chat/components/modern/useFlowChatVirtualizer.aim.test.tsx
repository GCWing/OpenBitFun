// @vitest-environment jsdom

/**
 * The re-aim, and giving it up.
 *
 * An aim at an item is not one write. The library recomputes the target offset
 * every frame from measurements that are still landing, and writes again
 * whenever it moves — for up to five seconds. That is the whole reason to
 * prefer `scrollItemIntoView` over an offset, and it is also the reason a
 * reader who takes the viewport over can be pulled back to where they were
 * going seconds after they stopped going there.
 *
 * The first test here exists to prove the mechanism runs at all, because the
 * second one is only meaningful if it does: "no second write" is what a
 * re-aim that never armed looks like too.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** What the reservation says a row is before anything has measured. */
const ESTIMATE_PX = 100;
/** What the rows turn out to be — over by more than a factor of two. */
const REAL_PX = 40;
const TARGET_INDEX = 5;

interface Item {
  key: string;
}

interface HarnessProps {
  scroller: HTMLElement;
  header: HTMLElement;
  items: Item[];
  writeViewport: (request: { topPx: number }) => boolean;
  onApi: (api: FlowChatVirtualizer) => void;
}

function Harness({ scroller, header, items, writeViewport, onApi }: HarnessProps) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  const headerRef = React.useRef<HTMLElement | null>(header);
  onApi(useFlowChatVirtualizer({
    items,
    scrollerRef,
    headerRef,
    getItemKey: (item: Item) => item.key,
    estimateItemHeightPx: () => ESTIMATE_PX,
    scrollPaddingStartPx: 0,
    writeViewport,
  }));
  return null;
}

describe('useFlowChatVirtualizer aim', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scroller: HTMLDivElement;
  let header: HTMLDivElement;
  let api: FlowChatVirtualizer;
  let writes: number[];
  let frames: FrameRequestCallback[];

  /**
   * A row at a height jsdom would otherwise report as zero. `offsetHeight`
   * rather than a rect, because that is what the library's measurement reads.
   */
  function renderRow(index: number, heightPx: number) {
    const element = document.createElement('div');
    element.setAttribute('data-virtual-index', String(index));
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: heightPx });
    scroller.appendChild(element);
  }

  /**
   * Shrink everything above the target, which is what moves the target's own
   * offset: 5 rows reserved at 100px turn out to be 40px, so an aim placed at
   * 500 belongs at 200.
   */
  function measureRowsAboveTarget() {
    act(() => {
      for (let index = 0; index < TARGET_INDEX; index += 1) renderRow(index, REAL_PX);
      api.measureRenderedItems();
    });
  }

  function runFrames(count: number) {
    for (let index = 0; index < count; index += 1) {
      const frame = frames.shift();
      if (!frame) return;
      act(() => frame(16));
    }
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = this.offsetHeight;
      return { top: 0, bottom: height, height, width: this.offsetWidth } as DOMRect;
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scroller = document.createElement('div');
    header = document.createElement('div');
    container.appendChild(scroller);
    // Without a scroll range the library clamps every aim to 0, which would
    // make all of these pass for the wrong reason.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 10_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });

    writes = [];
    const writeViewport = ({ topPx }: { topPx: number }) => {
      writes.push(topPx);
      // The register's granted write, and the scroll event it produces — which
      // is the only way the library learns where the viewport actually is.
      scroller.scrollTop = topPx;
      scroller.dispatchEvent(new Event('scroll'));
      return true;
    };

    const items = Array.from({ length: 10 }, (_, index) => ({ key: `item-${index}` }));
    act(() => root.render(
      <Harness
        scroller={scroller}
        header={header}
        items={items}
        writeViewport={writeViewport}
        onApi={next => { api = next; }}
      />,
    ));
    // The library places the scroller against its own state on mount. That
    // write belongs to no aim, and counting it would hide the ones that do.
    writes = [];
    frames = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-aims at the item when a measurement moves it', () => {
    act(() => api.scrollItemIntoView(TARGET_INDEX, {
      align: 'start',
      owner: 'one-shot-navigation',
    }));
    expect(writes).toEqual([TARGET_INDEX * ESTIMATE_PX]);

    measureRowsAboveTarget();
    runFrames(1);

    // The aim followed its item down rather than staying at the offset it was
    // first given. This is the behaviour worth keeping.
    expect(writes).toEqual([TARGET_INDEX * ESTIMATE_PX, TARGET_INDEX * REAL_PX]);
  });

  it('stops re-aiming once the aim has been given up', () => {
    /*
     * Measured: a Turn navigation placed the viewport at 5358, the reader took
     * over 6ms later, and 12ms after that the re-aim asked for 7784 and was
     * refused. The refusal is not the fix — the library never learns of it, and
     * the gesture's hold in the register lasts 200ms against a five-second
     * re-aim, so the write after the hold lapses is granted.
     */
    act(() => api.scrollItemIntoView(TARGET_INDEX, {
      align: 'start',
      owner: 'one-shot-navigation',
    }));
    act(() => api.cancelAim());
    // The cancel aims at the offset the scroller already holds, which is how it
    // leaves the re-aim with no index to recompute from.
    expect(writes).toEqual([TARGET_INDEX * ESTIMATE_PX, TARGET_INDEX * ESTIMATE_PX]);

    measureRowsAboveTarget();
    runFrames(5);

    expect(writes).toEqual([TARGET_INDEX * ESTIMATE_PX, TARGET_INDEX * ESTIMATE_PX]);
  });

  it('does nothing when there is no aim to give up', () => {
    // Called on every wheel notch, so this is the common case by a long way.
    act(() => api.cancelAim());
    act(() => api.cancelAim());

    expect(writes).toEqual([]);
  });

  it('gives up an aim only once', () => {
    act(() => api.scrollItemIntoView(TARGET_INDEX, {
      align: 'start',
      owner: 'one-shot-navigation',
    }));
    act(() => api.cancelAim());
    act(() => api.cancelAim());
    act(() => api.cancelAim());

    expect(writes).toHaveLength(2);
  });
});
