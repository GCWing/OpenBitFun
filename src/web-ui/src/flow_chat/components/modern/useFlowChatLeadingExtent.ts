import { useCallback, useMemo, useRef, type RefObject } from 'react';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowChatVirtualizer } from './useFlowChatVirtualizer';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { leadingExtentFloor } from './flowChatLeadingExtent';
import { FLOWCHAT_TURN_TOP_GAP_PX } from './flowChatTailFollow';

type Virtualizer = Pick<FlowChatVirtualizer, 'getItemBounds'>;
type Bounds = { startPx: number; endPx: number };
// Keep both coordinates from the same layout sample. Rounded virtual heights
// and normal-flow DOM positions need not agree, even after output has settled.
type Measurement = { cached: Bounds; mounted?: Bounds };
type Anchor = {
  key: string;
  scrollTopPx: number;
  heightPx: number;
  measurement: Measurement;
  group?: { key: string; measurement: Measurement };
};
type State = { scope: string; anchor: Anchor | null; turnFloor: number; measured: Map<string, Measurement> };
const boundsOf = (measurement: Measurement) => measurement.mounted ?? measurement.cached;
const newState = (scope: string): State => ({ scope, anchor: null, turnFloor: 0, measured: new Map() });

/** Layout only. The follow/reader owners remain the only viewport writers. */
export function useFlowChatLeadingExtent(options: {
  scope: string;
  items: readonly VirtualItem[];
  virtualizer: Virtualizer;
  scrollerRef: RefObject<HTMLElement | null>;
  extentRef: RefObject<HTMLElement | null>;
  onAnchorRebased: () => void;
}) {
  const { items, virtualizer, scrollerRef, extentRef, scope } = options;
  const state = useRef<State | null>(null);
  const onAnchorRebased = useRef(options.onAnchorRebased);
  onAnchorRebased.current = options.onAnchorRebased;
  const indexes = useMemo(() => new Map(items.map((item, index) => [getVirtualItemStableKey(item), index])), [items]);
  const groupHeaders = useMemo(() => {
    const headers = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.timeline?.kind === 'group-header') headers.set(item.timeline.group!.groupId, index);
    });
    return headers;
  }, [items]);
  const current = useCallback(() => {
    if (!state.current || state.current.scope !== scope) state.current = newState(scope);
    return state.current;
  }, [scope]);
  const install = useCallback((floor: number | null) => {
    const extent = extentRef.current;
    const scroller = scrollerRef.current;
    if (!extent || !scroller?.clientHeight) return;
    const value = floor === null ? '' : `${floor + scroller.clientHeight}px`;
    if (extent.style.minHeight !== value) extent.style.minHeight = value;
  }, [extentRef, scrollerRef]);
  const measureLayout = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measured = new Map<string, Measurement>();
    const origin = scroller.scrollTop - scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-virtual-item-key]')) {
      const viewport = row.closest('[data-flowchat-virtual-viewport], [data-flowchat-scroller]');
      if (viewport && viewport !== scroller) continue;
      const key = row.dataset.virtualItemKey!;
      const index = indexes.get(key);
      const cached = index === undefined ? null : virtualizer.getItemBounds(index);
      if (!cached) continue;
      const rect = row.getBoundingClientRect();
      const startPx = origin + rect.top;
      measured.set(key, { cached, mounted: { startPx, endPx: startPx + rect.height } });
    }
    // Bounded by mounted rows; keep only scalars, never DOM/content instances.
    current().measured = measured;
  }, [current, indexes, scrollerRef, virtualizer]);
  const measurementAt = useCallback((index: number): Measurement | null => {
    const measured = current().measured.get(getVirtualItemStableKey(items[index]));
    if (measured) return measured;
    const cached = virtualizer.getItemBounds(index);
    return cached ? { cached } : null;
  }, [current, items, virtualizer]);
  const groupAt = useCallback((index: number) => {
    const groupId = items[index].timeline?.group?.groupId;
    const groupIndex = groupId === undefined ? undefined : groupHeaders.get(groupId);
    const measurement = groupIndex === undefined ? null : measurementAt(groupIndex);
    return measurement && groupIndex !== undefined
      ? { key: getVirtualItemStableKey(items[groupIndex]), measurement } : undefined;
  }, [groupHeaders, items, measurementAt]);

  const capture = useCallback((offset: number, exact = false) => {
    const scroller = scrollerRef.current;
    if (!scroller?.clientHeight || !items.length) return;
    const s = current();
    if (exact) measureLayout();
    // Frames reuse the layout snapshot: no DOM traversal or row remeasure.
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const bounds = virtualizer.getItemBounds(middle);
      if (!bounds || bounds.endPx <= offset) low = middle + 1;
      else high = middle;
    }
    let index = low;
    for (const [key, measurement] of s.measured) {
      const bounds = boundsOf(measurement);
      if (bounds.endPx > offset && bounds.startPx < offset + scroller.clientHeight) {
        index = indexes.get(key) ?? index;
        break;
      }
    }
    const item = items[index];
    if (!item) return;
    const key = getVirtualItemStableKey(item);
    const measurement = measurementAt(index);
    if (!measurement) return;
    const bounds = boundsOf(measurement);
    if (bounds.startPx >= offset + scroller.clientHeight) return;
    s.anchor = { key, scrollTopPx: offset, heightPx: bounds.endPx - bounds.startPx, measurement, group: groupAt(index) };
    // Install before any later shrink, so native clamping cannot paint a frame
    // at the shortened tail before a ResizeObserver could repair it.
    install(Math.max(s.turnFloor, offset));
  }, [current, groupAt, indexes, install, items, measureLayout, measurementAt, scrollerRef, virtualizer]);

  const refresh = useCallback((turnFloor: number | null) => {
    const s = current();
    measureLayout();
    s.turnFloor = turnFloor ?? 0;
    const anchor = s.anchor;
    let floor = turnFloor;
    if (anchor) {
      const primaryIndex = indexes.get(anchor.key);
      const index = primaryIndex ?? (anchor.group ? indexes.get(anchor.group.key) : undefined);
      if (index === undefined) s.anchor = null;
      else {
        const key = getVirtualItemStableKey(items[index]);
        const measurement = measurementAt(index);
        if (measurement) {
          const usesGroupHeader = primaryIndex === undefined;
          const previous = usesGroupHeader ? anchor.group!.measurement : anchor.measurement;
          // Compare like with like. If a row mounted/unmounted, bridge through
          // the pair of virtual samples rather than treating the DOM/cache
          // discrepancy as travel. The next sample then has the new basis.
          const useMounted = previous.mounted && measurement.mounted;
          const before = useMounted ? previous.mounted! : previous.cached;
          const bounds = useMounted ? measurement.mounted! : measurement.cached;
          const offsetPx = before.startPx - anchor.scrollTopPx;
          const resolved = leadingExtentFloor({
            anchor: { key, offsetPx, heightPx: anchor.heightPx, groupHeaderOffsetPx: offsetPx },
            ...bounds, usesGroupHeader,
          });
          const rebased = usesGroupHeader || resolved.offsetPx !== offsetPx;
          const actualBounds = boundsOf(measurement);
          // A vanished reading position is an explicit semantic fallback, so
          // align its surviving top against the best current measurement.
          const anchorFloor = rebased ? Math.max(0, actualBounds.startPx - resolved.offsetPx) : resolved.floorPx;
          floor = Math.max(floor ?? 0, anchorFloor);
          s.anchor = { key, scrollTopPx: anchorFloor, measurement,
            heightPx: rebased ? actualBounds.endPx - actualBounds.startPx : anchor.heightPx,
            group: rebased ? undefined : groupAt(index) };
          if (rebased) {
            // A removed member/vanished card interior must not leave an older
            // reader anchor restoring the successor's former lower position.
            onAnchorRebased.current();
          }
        }
      }
    }
    install(floor);
  }, [current, groupAt, indexes, install, items, measureLayout, measurementAt]);

  // Structural transactions use the same leading edge. Choosing a surviving
  // successor instead would cancel the upward movement of content after a fold.
  const snapshot = useCallback(() => {
    const anchor = current().anchor;
    if (!anchor) return null;
    if (indexes.has(anchor.key)) return { key: anchor.key, offset: boundsOf(anchor.measurement).startPx - anchor.scrollTopPx };
    if (anchor.group && indexes.has(anchor.group.key)) return {
      key: anchor.group.key,
      offset: Math.max(FLOWCHAT_TURN_TOP_GAP_PX, boundsOf(anchor.group.measurement).startPx - anchor.scrollTopPx),
    };
    return null;
  }, [current, indexes]);
  return { capture, refresh, snapshot };
}
