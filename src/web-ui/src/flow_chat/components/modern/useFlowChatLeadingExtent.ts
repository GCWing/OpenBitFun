import { useCallback, useMemo, useRef, type RefObject } from 'react';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowChatVirtualizer } from './useFlowChatVirtualizer';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { leadingExtentFloor, type LeadingExtentAnchor } from './flowChatLeadingExtent';
import { FLOWCHAT_TURN_TOP_GAP_PX } from './flowChatTailFollow';

type Virtualizer = Pick<FlowChatVirtualizer, 'getItemBounds'>;

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
  const state = useRef<{ scope: string; anchor: LeadingExtentAnchor | null; turnFloor: number }>({ scope, anchor: null, turnFloor: 0 });
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
    if (state.current.scope !== scope) state.current = { scope, anchor: null, turnFloor: 0 };
    return state.current;
  }, [scope]);
  const install = useCallback((floor: number | null) => {
    const extent = extentRef.current;
    const scroller = scrollerRef.current;
    if (!extent || !scroller?.clientHeight) return;
    const value = floor === null ? '' : `${floor + scroller.clientHeight}px`;
    if (extent.style.minHeight !== value) extent.style.minHeight = value;
  }, [extentRef, scrollerRef]);
  const mountedBounds = useCallback((key: string) => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const row = [...scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-virtual-item-key]')]
      .find(element => element.dataset.virtualItemKey === key);
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const startPx = scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top;
    return { startPx, endPx: startPx + rect.height };
  }, [scrollerRef]);

  const capture = useCallback((offset: number, exact = false) => {
    const scroller = scrollerRef.current;
    if (!scroller?.clientHeight || !items.length) return;
    const s = current();
    // Frames use cached measurements only: no DOM traversal or row remeasure.
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const bounds = virtualizer.getItemBounds(middle);
      if (!bounds || bounds.endPx <= offset) low = middle + 1;
      else high = middle;
    }
    let index = low;
    if (exact) {
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-virtual-item-key]')]
        .find(element => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > top && rect.top < top + scroller.clientHeight;
        });
      if (row) index = indexes.get(row.dataset.virtualItemKey!) ?? index;
    }
    const item = items[index];
    if (!item) return;
    const key = getVirtualItemStableKey(item);
    const bounds = (exact ? mountedBounds(key) : null) ?? virtualizer.getItemBounds(index);
    if (!bounds || bounds.startPx >= offset + scroller.clientHeight) return;
    const groupIndex = item.timeline?.group ? groupHeaders.get(item.timeline.group.groupId) : undefined;
    const groupHeaderKey = groupIndex === undefined ? undefined : getVirtualItemStableKey(items[groupIndex]);
    const groupBounds = groupIndex === undefined ? null
      : (exact && groupHeaderKey ? mountedBounds(groupHeaderKey) : null) ?? virtualizer.getItemBounds(groupIndex);
    s.anchor = { key, offsetPx: bounds.startPx - offset, heightPx: bounds.endPx - bounds.startPx,
      groupHeaderKey, groupHeaderOffsetPx: groupBounds ? groupBounds.startPx - offset : undefined };
    // Install before any later shrink, so native clamping cannot paint a frame
    // at the shortened tail before a ResizeObserver could repair it.
    install(Math.max(s.turnFloor, offset));
  }, [current, groupHeaders, indexes, install, items, mountedBounds, scrollerRef, virtualizer]);

  const refresh = useCallback((turnFloor: number | null) => {
    const s = current();
    s.turnFloor = turnFloor ?? 0;
    const anchor = s.anchor;
    let floor = turnFloor;
    if (anchor) {
      const primaryIndex = indexes.get(anchor.key);
      const index = primaryIndex ?? (anchor.groupHeaderKey ? indexes.get(anchor.groupHeaderKey) : undefined);
      if (index === undefined) s.anchor = null;
      else {
        const key = getVirtualItemStableKey(items[index]);
        const bounds = mountedBounds(key) ?? virtualizer.getItemBounds(index);
        if (bounds) {
          const resolved = leadingExtentFloor({ anchor, ...bounds, usesGroupHeader: primaryIndex === undefined });
          floor = Math.max(floor ?? 0, resolved.floorPx);
          if (key !== anchor.key || resolved.offsetPx !== anchor.offsetPx) {
            s.anchor = { key, offsetPx: resolved.offsetPx, heightPx: bounds.endPx - bounds.startPx };
            // A removed member/vanished card interior must not leave an older
            // reader anchor restoring the successor's former lower position.
            onAnchorRebased.current();
          }
        }
      }
    }
    install(floor);
  }, [current, indexes, install, items, mountedBounds, virtualizer]);

  // Structural transactions use the same leading edge. Choosing a surviving
  // successor instead would cancel the upward movement of content after a fold.
  const snapshot = useCallback(() => {
    const anchor = current().anchor;
    if (!anchor) return null;
    if (indexes.has(anchor.key)) return { key: anchor.key, offset: anchor.offsetPx };
    if (anchor.groupHeaderKey && indexes.has(anchor.groupHeaderKey)) return {
      key: anchor.groupHeaderKey,
      offset: Math.max(FLOWCHAT_TURN_TOP_GAP_PX, anchor.groupHeaderOffsetPx ?? FLOWCHAT_TURN_TOP_GAP_PX),
    };
    return null;
  }, [current, indexes]);
  return { capture, refresh, snapshot };
}
