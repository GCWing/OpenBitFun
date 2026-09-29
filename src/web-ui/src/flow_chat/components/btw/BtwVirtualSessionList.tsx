import { useEmbeddedTimelineFollow } from '../../timeline/useEmbeddedTimelineFollow';
import { Fragment, useEffect, useRef, useState, type RefObject, type MutableRefObject } from 'react';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { VirtualItemRenderer } from '../modern/VirtualItemRenderer';
import { useFlowChatVirtualizer } from '../modern/useFlowChatVirtualizer';
import type { FlowChatViewportOwnerApi } from '../modern/useFlowChatViewportOwner';
import { getVirtualItemStableKey } from '../modern/virtualItemIdentity';
import { estimateVirtualMessageItemHeightWithContext } from '../modern/virtualMessageListLayout';
import type { BtwPanelViewState } from './btwPanelViewState';
import { useBtwPanelViewport } from './useBtwPanelViewport';
import { globalEventBus } from '@/infrastructure/event-bus';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest } from '../../events/flowchatNavigation';
import { findExcerptTextRoot, highlightLocatedExcerpt } from '../../selection/locateConversationExcerpt';
import { resolveExcerptRange } from '../../selection/flowChatSelection';
import { resolveFlowChatFocusTarget } from '../modern/flowChatFocusTarget';
import { useFlowChatContext } from '../modern/FlowChatContext';
import { useConversationTimeline } from '../../timeline/useConversationTimeline';
import { FlowChatReaderProvider } from '../../timeline/readerState';
import { useTimelineInteraction } from '../../timeline/useTimelineInteraction';
import { TimelineMutationBoundary } from '../../timeline/TimelineMutationBoundary';
import { findTimelineBlockIndex } from '../../timeline/document';
import { revealContainedRange } from '@openbitfun/flow-chat-presentation/scroll';

interface BtwVirtualSessionListProps {
  items: VirtualItem[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  headerRef: RefObject<HTMLDivElement | null>;
  followRef: MutableRefObject<boolean>;
  viewportOwner: FlowChatViewportOwnerApi;
  exploreGroupStates: Map<string, boolean>;
  isHistorical: boolean;
  viewState?: BtwPanelViewState;
  onExpandGroup?: (id: string) => void;
}

/** The embedded transcript shares row placement, not the primary session shell. */
export function BtwVirtualSessionList({
  items: sourceItems, scrollerRef, headerRef, followRef, viewportOwner,
  exploreGroupStates, isHistorical, viewState, onExpandGroup,
}: BtwVirtualSessionListProps) {
  const { sessionId } = useFlowChatContext();
  const { items, reader } = useConversationTimeline(sourceItems, sessionId, 'side');
  const windowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const updateWidth = () => setWidth(scroller.clientWidth);
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scroller);
    updateWidth();
    return () => observer.disconnect();
  }, [scrollerRef]);
  const cancelAimRef = useRef<() => void>(() => {});
  const pinnedKeys = useTimelineInteraction(scrollerRef, reader, () => followRef.current, undefined, () => {
    followRef.current = false;
    if (viewState) viewState.followTail = false;
    viewportOwner.release('follow-output'); cancelAimRef.current();
  });
  const virtualizer = useFlowChatVirtualizer({
    pinnedKeys,
    items,
    scrollerRef,
    headerRef,
    getItemKey: getVirtualItemStableKey,
    estimateItemHeightPx: estimateVirtualMessageItemHeightWithContext,
    estimateContext: {
      availableWidthPx: width || undefined,
      exploreGroupStates,
      isHistorical,
    },
    estimateContextRevision: `${width}|${isHistorical}|${[...exploreGroupStates]
      .map(([id, expanded]) => `${id}:${expanded}`).join(',')}`,
    scrollPaddingStartPx: 0,
    writeViewport: viewportOwner.write,
    shiftViewport: viewportOwner.shift,
  });
  cancelAimRef.current = virtualizer.cancelAim;
  useBtwPanelViewport(viewState, items, scrollerRef, windowRef, virtualizer, viewportOwner);
  const navigationRef = useRef({ items, sourceItems, virtualizer, onExpandGroup });
  navigationRef.current = { items, sourceItems, virtualizer, onExpandGroup };
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let generation = 0;
    let frame = 0;
    const cancel = () => {
      generation++; cancelAnimationFrame(frame); navigationRef.current.virtualizer.cancelAim();
      reader.set('navigation:thinking', '');
    };
    const unsubscribe = globalEventBus.on<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, request => {
      if (!request.embedded || !request.excerpt || request.sessionId !== scroller.dataset.flowchatSelectionRoot) return;
      cancel();
      const ownGeneration = generation;
      const scope = getActiveSurfaceScope();
      if (request.surfaceEpoch !== scope.epoch) return;
      const excerpt = request.excerpt;
      const fragment = excerpt.fragments[0];
      reader.set('navigation:thinking', fragment.flowItemId ?? '');
      const startedAt = performance.now();
      let materialized = -1;
      let expandedGroup: string | undefined;
      followRef.current = false;
      if (viewState) viewState.followTail = false;
      const aim = () => {
        if (generation !== ownGeneration || !scope.isCurrent()) return;
        const current = navigationRef.current;
        const source = findExcerptTextRoot(excerpt);
        const ready = source && !source.closest('[data-markdown-pending]') && !source.querySelector('[data-markdown-pending]');
        const range = ready && resolveExcerptRange(source, fragment);
        if (range) {
          revealContainedRange(range, scroller);
          const bounds = scroller.getBoundingClientRect();
          const rect = range.getBoundingClientRect();
          current.virtualizer.cancelAim();
          if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
            current.virtualizer.scrollToOffset(scroller.scrollTop + rect.top - bounds.top - bounds.height / 3,
              { owner: 'one-shot-navigation', holdForMs: 0 });
          }
          highlightLocatedExcerpt(excerpt);
          return;
        }
        {
          const target = resolveFlowChatFocusTarget(request, current.sourceItems);
          const index = fragment.flowItemId ? findTimelineBlockIndex(current.items, target.resolvedVirtualIndex ?? -1, fragment.flowItemId)
            : current.items.findIndex(item => item.type === 'user-message' && item.turnId === fragment.turnId);
          if (index === undefined || index < 0) { request.onUnavailable?.(); return; }
          if (target.expandExploreGroupId && expandedGroup !== target.expandExploreGroupId) {
            expandedGroup = target.expandExploreGroupId;
            reader.set(`group:${expandedGroup}:query`, '');
            reader.set(`group:${expandedGroup}:tool`, 'all');
            reader.set(`group:${expandedGroup}:status`, 'all');
            current.onExpandGroup?.(target.expandExploreGroupId);
          }
          if (materialized !== index) {
            current.virtualizer.scrollItemIntoView(index, { align: 'center', owner: 'one-shot-navigation' });
            materialized = index;
          }
        }
        if (performance.now() - startedAt >= 2000) { request.onUnavailable?.(); return; }
        frame = requestAnimationFrame(aim);
      };
      aim();
    });
    scroller.addEventListener('wheel', cancel, { passive: true });
    scroller.addEventListener('touchmove', cancel, { passive: true });
    scroller.addEventListener('pointerdown', cancel);
    scroller.addEventListener('keydown', cancel);
    return () => {
      cancel(); unsubscribe(); scroller.removeEventListener('wheel', cancel); scroller.removeEventListener('touchmove', cancel);
      scroller.removeEventListener('pointerdown', cancel); scroller.removeEventListener('keydown', cancel);
    };
  }, [scrollerRef, followRef, viewState, reader]);

  useEmbeddedTimelineFollow({ scrollerRef, contentRef: windowRef, followRef, viewportOwner,
    revision: items, cancelAim: virtualizer.cancelAim });

  return (
    <FlowChatReaderProvider store={reader}>
    <TimelineMutationBoundary itemKeys={items.map(getVirtualItemStableKey)} scrollerRef={scrollerRef}
      canRepair={() => !followRef.current && viewportOwner.canShift()} shift={viewportOwner.shift}>
    <div
      ref={windowRef}
      style={{ paddingTop: virtualizer.paddingTopPx, paddingBottom: virtualizer.paddingBottomPx }}
    >
      {virtualizer.rows.map((row, rowIndex) => (
        <Fragment key={row.key}>
        {rowIndex > 0 && row.startPx > virtualizer.rows[rowIndex - 1].endPx &&
          <div aria-hidden="true" style={{ height: row.startPx - virtualizer.rows[rowIndex - 1].endPx }} />}
        <VirtualItemRenderer
          key={row.key}
          item={items[row.index]}
          index={row.index}
          measureRef={virtualizer.measureRowElement}
        />
        </Fragment>
      ))}
    </div>
    </TimelineMutationBoundary>
    </FlowChatReaderProvider>
  );
}
