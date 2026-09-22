/**
 * FlowChat's virtualizer.
 *
 * Everything that knows which library places the items lives here. The rest of
 * FlowChat asks for offsets in scroller coordinates and gets them back; it never
 * sees an index space of the virtualizer's own, because there isn't one —
 * measurements are cached against item keys, so a history prepend leaves every
 * measured item exactly where it was.
 *
 * The reason this is TanStack Virtual and not react-virtuoso is one line of its
 * measurement pass:
 *
 *     const size = measured ?? this.options.estimateSize(i)
 *
 * A per-item estimate for everything unmeasured. react-virtuoso reserves a
 * single scalar for all of them, and this transcript alternates 38px user
 * messages with model rounds up to 5012px, so the scroll range was wrong by an
 * order of magnitude until an item was actually measured. Scrolling into a
 * freshly paged block then forced a burst of measurement — stalls of 119ms and
 * 295ms with no animation frame at all — and a correction of up to 11705px.
 *
 * Items are laid out in normal flow inside a padded window, not absolutely
 * positioned. When an item inside the window changes height the browser reflows
 * the ones below it in the same layout pass, so there is no frame where the
 * scroll has been corrected but the items have not moved yet.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  observeElementOffset as observeTanStackElementOffset,
  observeElementRect as observeTanStackElementRect,
  useVirtualizer,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';
import {
  roundViewportPx,
  traceViewport,
  traceViewportRepeating,
  isViewportDiagnosticsEnabled,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import type { FlowChatViewportOwner } from './flowChatViewportOwnership';
import {
  describeVirtualItemEstimate,
  type VirtualItemHeightEstimateContext,
} from './virtualMessageListLayout';

/** Item-count overscan. Roughly two Turns either side of the viewport. */
const FLOW_CHAT_OVERSCAN_ITEMS = 6;

/**
 * How long the library goes on re-aiming after an aim, mirrored from it.
 *
 * `MAX_RECONCILE_MS` in `virtual-core`, which is a local constant inside
 * `reconcileScroll` and so cannot be imported. Only ever read to decide that a
 * cancel has nothing left to cancel, so being out of date by a version bump
 * costs a redundant offset aim and nothing else.
 */
const VIRTUALIZER_REAIM_WINDOW_MS = 5_000;

/**
 * TanStack's default late-measurement adjustment is not safe for this list.
 *
 * Its rule is the right shape — adjust by *this item's* delta, and only for an
 * item above the viewport — but it applies that delta to `scrollOffset`, which
 * is the library's own copy of the scroll position and is refreshed only from
 * scroll events. Every continuous writer here assigns `scrollTop` directly, and
 * the scroll event for that assignment does not land until the following frame,
 * so a measurement arriving in between is compensated from a position the
 * viewport has already left. Measured on session open: nine corrections across
 * two frames walked the viewport from 7440 back to 3556 before the follow loop
 * wrote 7440 again.
 *
 * For a row wholly above the reader, the real viewport owner applies the
 * measured delta before TanStack updates its cache. Rows intersecting the
 * viewport are left alone: their content is what the reader is looking at.
 */
export interface FlowChatVirtualRow {
  index: number;
  key: string;
  startPx: number;
  endPx: number;
}

export interface FlowChatItemBounds {
  startPx: number;
  endPx: number;
}

/** A viewport box that can describe what the reader can actually see. */
export function isUsableFlowChatViewportRect(rect: Rect): boolean {
  return Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

/**
 * Keep transient minimized-window geometry out of TanStack's viewport state.
 *
 * WebView2 reports a zero-height scroller while the native window is minimized.
 * Publishing that sample makes the rendered window empty and throws away the
 * last reader position even though the React tree never left the screen. The
 * next positive sample is an ordinary reflow from the last usable rectangle.
 */
export function observeFlowChatViewportRect<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (rect: Rect) => void,
): void | (() => void) {
  return observeTanStackElementRect(instance, rect => {
    if (isUsableFlowChatViewportRect(rect)) {
      callback(rect);
    }
  });
}

/** A resize can shift the reader only when the whole row is above it. */
export function isItemFullyAboveViewport(itemEndPx: number, scrollTopPx: number): boolean {
  return itemEndPx <= scrollTopPx;
}

function resizeDeltaBand(deltaPx: number): string {
  const magnitudePx = Math.abs(deltaPx);
  if (magnitudePx < 1) return 'subpixel';
  if (magnitudePx < 16) return 'small';
  if (magnitudePx < 128) return 'medium';
  return 'large';
}

/**
 * The measurement pass, which the published types keep to themselves.
 *
 * `measurementsCache` is a public field, but it is only the place the memo
 * behind `getMeasurements` leaves its answer — reading it returns whatever the
 * last render put there, and a measurement arriving since then has invalidated
 * the memo without re-running it. `getMeasurements` is `private` in the `.d.ts`
 * although it is a plain instance field at runtime, so it is reached through
 * this shape rather than through some other public call whose side effect
 * happens to refresh the field.
 */
interface MeasuringVirtualizer {
  getMeasurements: () => ReadonlyArray<{ start: number; end: number }>;
}

export interface UseFlowChatVirtualizerOptions<T> {
  items: readonly T[];
  scrollerRef: RefObject<HTMLElement | null>;
  /**
   * Content rendered above the items, inside the same scroller.
   *
   * Its height is the offset every item start is expressed against, so it is
   * measured rather than assumed: the history paging sentinel appears and
   * disappears inside it while the reader is scrolling.
   */
  headerRef: RefObject<HTMLElement | null>;
  getItemKey: (item: T) => string;
  estimateItemHeightPx: (item: T, context?: VirtualItemHeightEstimateContext) => number;
  /** Data-driven inputs used by estimates before an item is mounted. */
  estimateContext?: VirtualItemHeightEstimateContext;
  /** Stable identity for data that changes an unmeasured row's estimate. */
  estimateContextRevision?: string | number;
  /** Seed the first window near the tail; subsequent positioning belongs to follow. */
  startAtTailOnMount?: boolean;
  /** Reconcile an opening follow target after a measured size changes. True
   * means the owner handled it and the actual offset can be published now. */
  reconcileOpeningMeasurement?: () => boolean;
  /** The host has temporarily withdrawn the scroller, such as window minimization. */
  isViewportSuspended?: () => boolean;
  /**
   * Gap kept above a Turn that has been scrolled to the top of the viewport.
   * Applied by the virtualizer itself so that its re-aim, which runs while
   * items below the target are still measuring, keeps the same gap.
   */
  scrollPaddingStartPx: number;
  /**
   * Every write the library makes goes through this.
   *
   * `scrollToFn` is a first-class option, so `scrollToIndex`, `scrollToOffset`
   * and the re-aim that follows them all arrive here — which is what makes
   * "nothing moves the viewport unregistered" true rather than aspirational.
   * The library's writes are a continuation of whoever asked for the aim, so
   * they are attributed to that owner and not to the library.
   */
  writeViewport: (request: {
    owner: FlowChatViewportOwner;
    topPx: number;
    behavior?: ScrollBehavior;
    holdForMs?: number;
  }) => boolean;
  /** Shift the viewport before a measurement changes row heights. */
  shiftViewport?: (byPx: number) => boolean;
}

export interface FlowChatVirtualizer {
  /** The window of items to render, in order. */
  rows: FlowChatVirtualRow[];
  /** Space standing in for the items above the window. */
  paddingTopPx: number;
  /** Space standing in for the items below the window. */
  paddingBottomPx: number;
  /** Ref callback for a rendered row's outermost element. */
  measureRowElement: (element: HTMLElement | null) => void;
  /** Where an item sits in scroller coordinates, or null if it has no place yet. */
  getItemBounds: (index: number) => FlowChatItemBounds | null;
  /**
   * Bring the measurement cache level with the DOM for every rendered row.
   *
   * For callers that have to read a position in the same commit that changed
   * the items, before the library's own measurement has caught up.
   */
  measureRenderedItems: () => void;
  /** Publish an immediate DOM offset readback without moving the viewport. */
  syncViewportOffset: (actualOffsetPx: number) => void;
  /**
   * The items intersecting the viewport right now, read from live geometry.
   *
   * A callback rather than a value because it has to answer during a scroll,
   * which moves the viewport across the rendered window without changing it.
   */
  getVisibleItemRange: () => FlowChatVisibleItemRange | null;
  /**
   * Scroll so that an item lands at the viewport's start or centre.
   *
   * Preferred over an offset wherever it fits: the virtualizer re-aims at the
   * item for as long as the measurements under it keep moving, which an offset
   * cannot do because the offset is already stale by then.
   */
  scrollItemIntoView: (
    index: number,
    options: {
      align: 'start' | 'center';
      behavior?: 'auto' | 'smooth';
      /** Who the aim, and every re-aim it produces, belongs to. */
      owner: FlowChatViewportOwner;
      holdForMs?: number;
    },
  ) => void;
  /** Scroll to an offset in scroller coordinates. */
  scrollToOffset: (
    offsetPx: number,
    options: {
      behavior?: 'auto' | 'smooth';
      owner: FlowChatViewportOwner;
      holdForMs?: number;
    },
  ) => void;
  /**
   * Give up an aim that is still chasing its target.
   *
   * For the reader taking the viewport over. The re-aim is the other half of
   * `scrollItemIntoView` — it is what makes an aim at an item survive the
   * measurements landing under it — and it has no idea a gesture happened.
   *
   * A no-op when no aim is in flight, so it is safe on every wheel notch.
   */
  cancelAim: () => void;
}

export interface FlowChatVisibleItemRange {
  startIndex: number;
  endIndex: number;
}

/**
 * The items the reader can actually see.
 *
 * Deliberately not the rendered window: that carries overscan, and a transcript
 * short enough to render whole reports the first and last item as rendered no
 * matter where the viewport is. Anything asking "has the reader reached the end
 * of what is loaded" needs this instead, or it is asking whether the item
 * exists.
 *
 * Null when no item intersects the viewport at all, which is a real state — the
 * reserved tail blank is below every item — and the honest answer is that the
 * reader is at neither boundary.
 */
export function visibleRowRange(
  rows: readonly FlowChatVirtualRow[],
  scrollTopPx: number,
  clientHeightPx: number,
): FlowChatVisibleItemRange | null {
  const viewportEndPx = scrollTopPx + clientHeightPx;
  let startIndex = -1;
  let endIndex = -1;
  for (const row of rows) {
    if (row.endPx <= scrollTopPx || row.startPx >= viewportEndPx) continue;
    if (startIndex === -1) startIndex = row.index;
    endIndex = row.index;
  }
  return startIndex === -1 ? null : { startIndex, endIndex };
}

export interface FlowChatVirtualWindowPadding {
  paddingTopPx: number;
  paddingBottomPx: number;
}

/**
 * The space that stands in for the transcript outside the rendered window.
 *
 * The scroll range has to be the whole transcript's even though only a window
 * of it exists, and this is what makes up the difference. Offsets arrive in
 * scroller coordinates — measured from the top of the scroller, past whatever
 * is rendered above the items — so `contentStartPx` comes back off both ends:
 * padding is measured inside the element that holds the items.
 *
 * An empty window reserves nothing. There is no window to be outside of, and a
 * padding derived from one row that is not there would be the whole transcript
 * on one side and nothing on the other.
 */
export function virtualWindowPaddingPx(
  rows: readonly FlowChatVirtualRow[],
  totalSizePx: number,
  contentStartPx: number,
): FlowChatVirtualWindowPadding {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return { paddingTopPx: 0, paddingBottomPx: 0 };
  return {
    paddingTopPx: Math.max(0, first.startPx - contentStartPx),
    paddingBottomPx: Math.max(0, totalSizePx - (last.endPx - contentStartPx)),
  };
}

export function useFlowChatVirtualizer<T>({
  items,
  scrollerRef,
  headerRef,
  getItemKey,
  estimateItemHeightPx,
  estimateContext,
  estimateContextRevision,
  startAtTailOnMount = false,
  reconcileOpeningMeasurement,
  isViewportSuspended = () => false,
  scrollPaddingStartPx,
  writeViewport,
  shiftViewport = () => false,
}: UseFlowChatVirtualizerOptions<T>): FlowChatVirtualizer {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const initialTailRef = useRef(startAtTailOnMount);
  const hasInitialItemsRef = useRef(items.length > 0);
  if (items.length > 0) hasInitialItemsRef.current = true;
  const reconcileOpeningMeasurementRef = useRef(reconcileOpeningMeasurement);
  reconcileOpeningMeasurementRef.current = reconcileOpeningMeasurement;
  const pendingMeasurementRef = useRef(false);
  const pendingMeasurementShiftRef = useRef(false);
  const publishMeasuredOffsetRef = useRef<((actualOffsetPx?: number) => void) | null>(null);
  const syncViewportOffset = useCallback((actualOffsetPx: number) => {
    if (Number.isFinite(actualOffsetPx)) publishMeasuredOffsetRef.current?.(actualOffsetPx);
  }, []);
  const writeViewportRef = useRef(writeViewport);
  writeViewportRef.current = writeViewport;
  /**
   * Who the aim currently in flight belongs to.
   *
   * The library re-aims for as long as the measurements under its target keep
   * moving, and those later writes arrive with no caller of ours on the stack.
   * They are still the same request, so they are attributed to whoever made
   * it — which is also what lets a gesture preempt a navigation that is still
   * chasing its Turn.
   *
   * Until anyone has asked for an aim, the library still writes: it places the
   * scroller against its own state on mount. That write belongs to no request
   * of ours, so it is attributed to the lowest authority that describes it —
   * the library putting content where it thinks it goes. Naming a navigation
   * here instead let a 0px write on session open outrank follow-output for the
   * whole of the opening reveal.
   */
  const aimOwnerRef = useRef<FlowChatViewportOwner>('layout-correction');
  const aimHoldForMsRef = useRef<number | undefined>(undefined);
  /**
   * When the aim that is still being re-aimed at was made, if there is one.
   *
   * The library does not say when it stops, so this is how a cancel knows
   * whether there is anything to cancel: cleared when it is given up, and read
   * against the library's own window when it was not. Wrong only in the
   * direction of cancelling an aim that had already finished, which writes
   * nothing.
   */
  const aimStartedAtMsRef = useRef<number | null>(null);
  const getItemKeyRef = useRef(getItemKey);
  getItemKeyRef.current = getItemKey;
  const estimateItemHeightRef = useRef(estimateItemHeightPx);
  estimateItemHeightRef.current = estimateItemHeightPx;
  const estimateContextRef = useRef(estimateContext);
  estimateContextRef.current = estimateContext;
  const isViewportSuspendedRef = useRef(isViewportSuspended);
  isViewportSuspendedRef.current = isViewportSuspended;

  const [contentStartPx, setContentStartPx] = useState(0);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() => {
      setContentStartPx(header.offsetHeight);
    });
    observer.observe(header, { box: 'border-box' });
    setContentStartPx(header.offsetHeight);
    return () => observer.disconnect();
  }, [headerRef]);

  /*
   * Stable across renders on purpose. The virtualizer keys its measurement pass
   * on the identity of these, so a fresh closure per render would re-measure
   * the whole transcript every time a single streaming item changed. They read
   * the current items through a ref instead, which is sound because a change
   * that matters — an item added or removed — moves `count` as well.
   */
  const estimateSize = useCallback((index: number) => {
    const item = itemsRef.current[index];
    return item === undefined ? 0 : estimateItemHeightRef.current(item, estimateContextRef.current);
  }, []);

  const resolveItemKey = useCallback((index: number) => {
    // Recreate the callback when estimate inputs change. TanStack uses the
    // callback identity to invalidate its derived measurement positions while
    // retaining DOM-measured sizes in its key cache.
    void estimateContextRevision;
    const item = itemsRef.current[index];
    return item === undefined ? index : getItemKeyRef.current(item);
  }, [estimateContextRevision]);

  const virtualizer = useVirtualizer({
    // A live-tail open previously mounted rows 0..13 before moving to 22..33;
    // the first head measurement flushed 372.3ms of pending layout in a trace.
    // Seed the last item's estimated start without reading DOM geometry. This
    // avoids that head window; real measurement and follow still own settling.
    // Same-session retest: rowRef total 377.3 -> 4.2ms; reveal probe completed
    // at 1540.3 -> 806.7ms. These are single-trace timings, not paint guarantees.
    // Keep an empty hydration from consuming the one-time initial offset.
    enabled: !initialTailRef.current || hasInitialItemsRef.current,
    initialOffset: () => initialTailRef.current
      ? itemsRef.current.slice(0, -1).reduce((offset, item) => (
        offset + estimateItemHeightRef.current(item, estimateContextRef.current)
      ), 0)
      : 0,
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    observeElementRect: observeFlowChatViewportRect,
    observeElementOffset: (instance, callback) => {
      let synchronized = false;
        const publish = (actualOffsetPx?: number) => {
          const scroller = instance.scrollElement;
          if (!scroller || scroller !== scrollerRef.current || isViewportSuspendedRef.current()) return;
          const actualOffset = actualOffsetPx ?? scroller.scrollTop;
        synchronized = true;
        // false avoids a nested flushSync while React is attaching measured rows.
        if (instance.scrollOffset !== actualOffset) callback(actualOffset, false);
      };
      publishMeasuredOffsetRef.current = publish;
      const cleanup = observeTanStackElementOffset(instance, (offset, isScrolling) => {
        // TanStack's debounced scroll-end callback captures the last native-event
        // offset. It must not undo a newer synchronous measurement reconciliation.
        if (synchronized && !isScrolling && instance.scrollElement) offset = instance.scrollElement.scrollTop;
        if (isScrolling) synchronized = false;
        callback(offset, isScrolling);
      });
      return () => {
        cleanup?.();
        if (publishMeasuredOffsetRef.current === publish) publishMeasuredOffsetRef.current = null;
      };
    },
    onChange: (_instance, sync) => {
      if (sync || !pendingMeasurementRef.current) return;
      pendingMeasurementRef.current = false;
      const shifted = pendingMeasurementShiftRef.current;
      pendingMeasurementShiftRef.current = false;
      // A trace showed rows 22..26 shrinking by 729px while range selection
      // still used 8669px. They unmounted, then remounted on the delayed 7940px
      // scroll event (113.8ms style work on removal). Reconcile through follow,
      // then publish the real offset before React selects the next window.
      // Retest: five row cleanups became zero; post-reveal sampling advanced
      // from 786.8ms to 596.4ms (single desktop trace, not paint timing).
      const reconciled = reconcileOpeningMeasurementRef.current?.();
      // Ordinary reading also shifts the real viewport when measured rows above
      // it shrink. Publish that readback after the size cache updates, before
      // selecting a window from the old offset and unmounting those same rows.
      if (reconciled || shifted) publishMeasuredOffsetRef.current?.();
    },
    estimateSize,
    getItemKey: resolveItemKey,
    // Items carry their own index attribute already; measuring reads it back.
    indexAttribute: 'data-virtual-index',
    overscan: FLOW_CHAT_OVERSCAN_ITEMS,
    scrollMargin: contentStartPx,
    scrollPaddingStart: scrollPaddingStartPx,
    /*
     * The library's only way out to the DOM. Routing it through the register
     * is what closes the gap the contract used to describe as unclosable: a
     * write from inside the library is now a write like any other, refusable
     * by whatever outranks the aim it came from.
     */
    scrollToFn: (offsetPx, { behavior }) => {
      if (isViewportSuspendedRef.current()) return;
      writeViewportRef.current({
        owner: aimOwnerRef.current,
        topPx: offsetPx,
        behavior,
        holdForMs: aimHoldForMsRef.current,
      });
    },
  });
  // An instance field rather than an option, so it is assigned here — before
  // any measurement callback can reach `resizeItem`.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) => {
    pendingMeasurementRef.current = true;
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    if (isViewportSuspendedRef.current()) return false;
    const beforeScrollTopPx = scroller.scrollTop;
    const beforeScrollHeightPx = scroller.scrollHeight;
    // A row that merely starts above the viewport may still be visible. Its
    // resize changes content inside the reader rather than moving content that
    // is wholly above it, so compensating its full delta would pull the reader
    // by the size of a row they are looking at (history model rounds can be
    // several thousand pixels). Only a row whose end is above the viewport can
    // move the reader's existing content and needs a viewport shift.
    const fullyAboveViewport = isItemFullyAboveViewport(item.end, beforeScrollTopPx);
    const applied = fullyAboveViewport ? shiftViewport(delta) : false;
    if (applied) pendingMeasurementShiftRef.current = true;
    const virtualItem = itemsRef.current[item.index];
    if (isViewportDiagnosticsEnabled()) {
      const diagnosticItem = virtualItem as {
        type?: unknown;
        turnId?: unknown;
      } | undefined;
      const itemKey = virtualItem === undefined ? null : getItemKeyRef.current(virtualItem);
      traceViewportRepeating(
        `itemResize|${itemKey ?? 'unknown'}|${fullyAboveViewport}|${applied}|${resizeDeltaBand(delta)}`,
        {
          location: 'virtualizer.itemResize',
          message: 'an item changed size during virtualizer measurement',
          travelPx: delta,
          data: () => ({
            index: item.index,
            itemKey,
            itemType: typeof diagnosticItem?.type === 'string' ? diagnosticItem.type : null,
            turnId: typeof diagnosticItem?.turnId === 'string' ? diagnosticItem.turnId : null,
            estimatedSizePx: virtualItem === undefined
              ? null
              : roundViewportPx(estimateItemHeightRef.current(virtualItem)),
            previousItemSizePx: roundViewportPx(item.size),
            nextItemSizePx: roundViewportPx(item.size + delta),
            itemStartPx: roundViewportPx(item.start),
            itemEndPx: roundViewportPx(item.end),
            deltaPx: roundViewportPx(delta),
            fullyAboveViewport,
            beforeScrollTopPx: roundViewportPx(beforeScrollTopPx),
            beforeScrollHeightPx: roundViewportPx(beforeScrollHeightPx),
            applied,
            afterScrollTopPx: roundViewportPx(scroller.scrollTop),
            afterScrollHeightPx: roundViewportPx(scroller.scrollHeight),
            estimateBreakdown: virtualItem && typeof virtualItem === 'object' && 'type' in virtualItem
              ? describeVirtualItemEstimate(virtualItem as unknown as Parameters<typeof describeVirtualItemEstimate>[0])
              : null,
          }),
        },
      );
    }
    /*
     * TanStack's default adjustment is based on its cached scroll offset. This
     * list writes the real scroller through the viewport register, so that copy
     * can be one frame stale. Move the real viewport before the new size enters
     * the cache; otherwise a shrinking range can make the browser clamp
     * scrollTop to the physical tail before the reader's anchor gets a chance
     * to restore it.
     */
    return false;
  };

  const virtualRows = virtualizer.getVirtualItems();
  const totalSizePx = virtualizer.getTotalSize();

  const rows = useMemo<FlowChatVirtualRow[]>(() => virtualRows.map(row => ({
    index: row.index,
    key: String(row.key),
    startPx: row.start,
    endPx: row.end,
  })), [virtualRows]);

  const { paddingTopPx, paddingBottomPx } = virtualWindowPaddingPx(
    rows,
    totalSizePx,
    contentStartPx,
  );

  const measureRowElement = virtualizer.measureElement;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const getVisibleItemRange = useCallback((): FlowChatVisibleItemRange | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    return visibleRowRange(rowsRef.current, scroller.scrollTop, scroller.clientHeight);
  }, [scrollerRef]);

  /**
   * Everything rendered, measured now rather than whenever the library gets to it.
   *
   * The library measures a row inline as its ref attaches, but only when the
   * reader is holding still:
   *
   *     if ((!this.isScrolling || this.scrollState) && ...) this.resizeItem(...)
   *
   * History pages in exactly when they are not: the reader scrolls up into the
   * boundary, the rows arrive in the DOM at their real heights, and the cache
   * keeps the estimates it reserved for them. The ResizeObserver does catch
   * them — after the layout effects of the commit that added them, which is a
   * frame later than the one reader of these positions that cannot wait. The
   * prepend compensation has to move the reader in the same paint as the rows
   * that displaced them. Measured across four junctions, height reserved
   * against scroll range actually gained: 2174/670, 2494/949, 2346/609,
   * 2580/1917.
   *
   * Rendered rows only, because only they have a height to read; the rest stay
   * estimates, which is what a virtualizer is. A row whose height has not
   * changed costs nothing — `resizeItem` returns on a zero delta — so this is
   * the same work the ResizeObserver was going to do, done a frame earlier.
   */
  const measureRenderedItems = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || isViewportSuspendedRef.current()) return;
    const elements = scroller.querySelectorAll<HTMLElement>('[data-virtual-index]');
    for (const element of elements) {
      const index = Number(element.getAttribute('data-virtual-index'));
      if (!Number.isInteger(index)) continue;
      virtualizer.resizeItem(
        index,
        virtualizer.options.measureElement(element, undefined, virtualizer),
      );
    }
  }, [scrollerRef, virtualizer]);

  const getItemBounds = useCallback((index: number): FlowChatItemBounds | null => {
    const measurement = (virtualizer as unknown as MeasuringVirtualizer)
      .getMeasurements()[index];
    return measurement ? { startPx: measurement.start, endPx: measurement.end } : null;
  }, [virtualizer]);

  const scrollItemIntoView = useCallback((
    index: number,
    options: {
      align: 'start' | 'center';
      behavior?: 'auto' | 'smooth';
      owner: FlowChatViewportOwner;
      holdForMs?: number;
    },
  ) => {
    aimOwnerRef.current = options.owner;
    aimHoldForMsRef.current = options.holdForMs;
    aimStartedAtMsRef.current = performance.now();
    virtualizer.scrollToIndex(index, {
      align: options.align,
      behavior: options.behavior ?? 'auto',
    });
  }, [virtualizer]);

  const scrollToOffset = useCallback((
    offsetPx: number,
    options: {
      behavior?: 'auto' | 'smooth';
      owner: FlowChatViewportOwner;
      holdForMs?: number;
    },
  ) => {
    aimOwnerRef.current = options.owner;
    aimHoldForMsRef.current = options.holdForMs;
    aimStartedAtMsRef.current = performance.now();
    virtualizer.scrollToOffset(offsetPx, {
      align: 'start',
      behavior: options.behavior ?? 'auto',
    });
  }, [virtualizer]);

  const cancelAim = useCallback(() => {
    const startedAtMs = aimStartedAtMsRef.current;
    if (startedAtMs === null) return;
    aimStartedAtMsRef.current = null;
    const scroller = scrollerRef.current;
    // Already over, by the library's own clock. Aiming again would only start
    // another reconcile to sit out.
    if (!scroller || performance.now() - startedAtMs > VIRTUALIZER_REAIM_WINDOW_MS) return;
    /*
     * Aimed at the offset the scroller is already at, rather than by clearing
     * the library's `scrollState`, which is private and would have to be
     * reached through a cast that no version bump would warn us about.
     *
     * An offset aim carries no index, and the reconcile recomputes its target
     * from the index — so with none, the target can never change again, and
     * writing again is the only thing it does when the target changes. The
     * write this makes goes to the position the scroller already holds, which
     * is a no-op whether the register grants it or refuses it.
     */
    aimOwnerRef.current = 'layout-correction';
    aimHoldForMsRef.current = undefined;
    const givenUpAtPx = scroller.scrollTop;
    virtualizer.scrollToOffset(givenUpAtPx, { align: 'start', behavior: 'auto' });
    traceViewport({
      location: 'virtualizer.aimCancelled',
      message: 'an aim was given up because the reader took the viewport',
      data: () => ({
        givenUpAtPx: roundViewportPx(givenUpAtPx),
        aimAgeMs: Math.round(performance.now() - startedAtMs),
      }),
    });
  }, [scrollerRef, virtualizer]);

  return {
    rows,
    paddingTopPx,
    paddingBottomPx,
    measureRowElement,
    getItemBounds,
    measureRenderedItems,
    syncViewportOffset,
    getVisibleItemRange,
    scrollItemIntoView,
    scrollToOffset,
    cancelAim,
  };
}
