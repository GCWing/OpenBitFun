/**
 * Virtualized FlowChat transcript with natural browser scroll range.
 *
 * The physical bottom keeps a short latest Turn at top, then places taller
 * output at the reading line. Its minimum extent survives card collapse; flex
 * layout supplies only the space needed. The follow controller owns scrolling.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { requestDeferredContentItem } from '@openbitfun/flow-chat-presentation/deferred-content';
import { findFlowChatFocusElement } from './flowChatFocusTarget';
import { useActiveSessionState } from '../../hooks/useActiveSessionState';
import { useSessionReadOnOpen } from '../../hooks/useSessionReadOnOpen';
import { useScrollToTurnHeader } from '../../hooks/useScrollToTurnHeader';
import type { SessionHistoryWindowDirection } from '../../store/FlowChatStore';
import {
  FLOWCHAT_TURNS_ROLLED_BACK_EVENT,
  type FlowChatTurnsRolledBackRequest,
} from '../../events/flowchatNavigation';
import {
  useActiveSession,
  useModernFlowChatStore,
  useModernFlowChatStoreApi,
  useVirtualItems,
  type VirtualItem,
} from '../../store/modernFlowChatStore';
import { useChatInputState } from '../../store/chatInputStateStore';
import type { ActiveTurnRenderRange } from '../../types/flow-chat';
import {
  computeFlowChatInputOverlayInsetPx,
  computeFlowChatInputStackFooterPx,
} from '../../utils/flowChatScrollLayout';
import { getMotionAwareScrollBehavior } from '../../utils/motionPreference';
import { ScrollToLatestBar } from '../ScrollToLatestBar';
import { ScrollToTurnHeaderButton } from '../ScrollToTurnHeaderButton';
import {
  findElementWithDataValue,
  findFlowChatFocusTextRange,
  findFlowChatSearchTextRanges,
  getFlowChatSearchTextRoot,
} from './flowChatSearchDom';
import { RuntimeStatusSlot } from './RuntimeStatusSlot';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { FlowChatScrollIntent, FlowChatTouchIntent, flowChatKeyScrollDirection, isFlowChatScrollbarPress } from './flowChatScrollIntent';
import { findRenderedTurnAnchorElement } from './flowChatViewportAnchor';
import { useFlowChatViewportAnchor } from './useFlowChatViewportAnchor';
import { useFlowChatLeadingExtent } from './useFlowChatLeadingExtent';
import {
  contentEndScrollTop,
  FLOWCHAT_AT_CONTENT_END_THRESHOLD_PX as AT_CONTENT_END_THRESHOLD_PX,
  FLOWCHAT_TURN_TOP_GAP_PX,
  isViewportAtTail,
  turnTopScrollTop,
  tailSpacerPxForViewport,
  turnTopAlignmentEntersReservedBlank,
} from './flowChatTailFollow';
import {
  isUsableFlowChatViewportRect,
  useFlowChatVirtualizer,
} from './useFlowChatVirtualizer';
import { FlowChatHistoryPager, type HistoryPageResult } from './flowChatHistoryPager';
import { useFlowChatViewportOwner } from './useFlowChatViewportOwner';
import {
  ONE_SHOT_NAVIGATION_HOLD_MS,
  type FlowChatViewportOwner,
} from './flowChatViewportOwnership';
import { USER_DRIVEN_SCROLL_WINDOW_MS } from './flowChatViewportAnchor';
import {
  historyBoundariesForVisibleRange,
  type HistoryBoundaryProximity,
} from './flowChatHistoryBoundary';
import { VirtualItemRenderer } from './VirtualItemRenderer';
import { FlowChatPrependSnapshot } from './FlowChatPrependSnapshot';
import { revealContainedRange } from '@openbitfun/flow-chat-presentation/scroll';
import { FlowChatOpeningBoundary } from './FlowChatOpeningBoundary';
import { useFlowChatVolatileContext } from './FlowChatContext';
import {
  estimateVirtualMessageItemHeightWithContext,
  type VirtualItemHeightEstimateContext,
} from './virtualMessageListLayout';
import { getKnownVirtualItemHeightPx } from './virtualItemHeightEstimators';
import { resolveVisibleFlowChatTurnIds } from './flowChatVisibleTurns';
import type { FlowChatViewportSnapshot } from './flowChatViewportSnapshot';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { useConversationTimeline } from '../../timeline/useConversationTimeline';
import { FlowChatReaderProvider } from '../../timeline/readerState';
import { findTimelineBlockIndex } from '../../timeline/document';
import { useTimelineInteraction, type TimelineReaderInteraction } from '../../timeline/useTimelineInteraction';
import { TimelineMutationBoundary } from '../../timeline/TimelineMutationBoundary';
import { getNextVisibleVirtualItemIndexes, isAmbientToolRunContinuationAfter } from './flowChatRhythm';
import {
  VIEWPORT_PLACEMENT_SETTLE_MS,
  roundViewportPx,
  traceViewport,
  traceViewportPlacement,
  traceViewportRepeating,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import { noteFlowListCommit } from '@/infrastructure/diagnostics/flowChatTailFollowDiagnostics';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { findExcerptSource, resolveExcerptRange } from '../../selection/flowChatSelection';
import { highlightExcerptRange } from '../../selection/locateConversationExcerpt';
import './VirtualMessageList.scss';
import { Icon } from '@openbitfun/ui';
import type { SubmittedMessageScrollIntent } from '../../services/submittedMessageScrollIntent';

const SEARCH_NAVIGATION_MAX_ATTEMPTS = 24;
/** Consecutive quiet frames that mark the opening viewport as settled. */
const OPEN_REVEAL_QUIET_FRAMES = 2;
/** Hard cap so the transcript is always revealed, settled or not. */
const OPEN_REVEAL_MAX_FRAMES = 40;
/**
 * Treat sub-pixel scroll offsets as the scroll start. WebView2 and inertial
 * scrolling can leave a tiny positive value after the viewport reaches the
 * top, which would otherwise make the edge fade flicker back on.
 */
const FLOWCHAT_SCROLL_START_THRESHOLD_PX = 1;

function readableViewportBounds(scroller: HTMLElement, inputOverlayInsetPx: number) {
  const top = scroller.getBoundingClientRect().top;
  const edgeFadePx = Number.parseFloat(
    getComputedStyle(scroller).getPropertyValue('--openbitfun-space-12'),
  ) || 0;
  return {
    top: top + (scroller.scrollTop <= FLOWCHAT_SCROLL_START_THRESHOLD_PX ? 0 : edgeFadePx),
    bottom: top + scroller.clientHeight - inputOverlayInsetPx - edgeFadePx,
  };
}
/**
 * Resize callbacks over which a viewport resting at the end is re-aligned after
 * the scroller's own box changes.
 *
 * One correction is not enough. A width change reflows every item, and a height
 * change makes the virtualizer render a different number of them; either way it
 * re-measures over the following passes, so the content end keeps moving after
 * the first callback. The window closes on its own so that
 * streaming content growth, which arrives through the same observer, never
 * inherits it.
 */
const TAIL_REALIGN_RESIZE_CALLBACKS = 6;
const HISTORY_WINDOW_DIRECTIONS: readonly SessionHistoryWindowDirection[] = ['before', 'after'];
/**
 * Transcripts mounted this session, counted.
 *
 * The list is keyed on the session id, so a switch is a full remount: new
 * scroller, empty measurement cache, fresh opening reveal, and a follow hook
 * that has never followed anything. Nothing in the trail said which instance a
 * line came from, and two of the three viewport faults measured here turned out
 * to be two instances disagreeing rather than one instance changing its mind.
 */
let nextViewportInstanceId = 0;
const IDLE_HISTORY_WINDOW_BOUNDARY_STATE: Record<
  SessionHistoryWindowDirection,
  'idle' | 'loading' | 'error'
> = { before: 'idle', after: 'idle' };

export type FlowChatTurnNavigationStatus = 'rejected' | 'pending' | 'settled';

export interface TurnNavigationOptions {
  behavior?: ScrollBehavior;
}

export type HistoryWindowBoundaryIntentResult = HistoryPageResult;

type HistoryWindowBoundaryIntentResponse =
  | HistoryWindowBoundaryIntentResult
  | boolean
  | void;

export interface HistoryWindowBoundaryIntentOptions {
  prepareViewportForPresentationCommit?: () => boolean | void | Promise<boolean | void>;
  cancelViewportPresentationCommit?: () => void;
}

export interface FlowChatTextNavigationTarget {
  virtualItemIndex: number;
  query: string;
  flowItemId?: string;
  occurrenceIndex?: number;
  expandableIds?: readonly string[];
  excerpt?: ConversationExcerptContext;
  onUnavailable?: () => void;
  isCurrent?: () => boolean;
}

export interface VirtualMessageListRef {
  scrollToTurn: (turnIndex: number) => void;
  scrollToIndex: (index: number) => void;
  scrollToSearchMatch: (target: FlowChatTextNavigationTarget) => void;
  notifyUserSelectionIntent: () => void;
  clearSearchMatch: () => void;
  scrollToPhysicalBottom: () => void;
  scrollToTurnEnd: (turnId: string) => boolean;
  isTurnRenderedInViewport: (turnId: string) => boolean;
  isTurnTextRenderedInViewport: (turnId: string) => boolean;
  scrollToLatestEndPosition: () => void;
  navigateToTurn: (turnId: string, options?: TurnNavigationOptions) => boolean;
  navigateToTurnWithStatus: (
    turnId: string,
    options?: TurnNavigationOptions,
  ) => FlowChatTurnNavigationStatus;
  prepareTurnNavigation: (
    turnId: string,
    options?: TurnNavigationOptions,
  ) => FlowChatTurnNavigationStatus;
  /**
   * Place a flow item in the readable viewport, clear of fades and the composer.
   * `false` means it is not rendered yet, so the caller should ask again.
   */
  focusFlowItem: (flowItemId: string) => boolean;
  captureViewportSnapshot: () => FlowChatViewportSnapshot | null;
  restoreViewportSnapshot: (snapshot: FlowChatViewportSnapshot) => boolean;
}

export interface VirtualMessageListProps {
  items?: VirtualItem[];
  /** Session catalog identity, independent from the current history window. */
  latestTurnId?: string;
  isViewportActive?: boolean;
  presentationMode?: 'tail' | 'history-window';
  viewportMode?: 'live-tail' | 'history-reading';
  historyWindow?: ActiveTurnRenderRange | null;
  presentationRevision?: number;
  historyBoundaryState?: Record<SessionHistoryWindowDirection, 'idle' | 'loading' | 'error'>;
  onHistoryWindowBoundaryIntent?: (
    direction: SessionHistoryWindowDirection,
    options?: HistoryWindowBoundaryIntentOptions,
  ) => HistoryWindowBoundaryIntentResponse | Promise<HistoryWindowBoundaryIntentResponse>;
  onRequestJumpToLatest?: () => void;
  onUserScrollIntent?: () => void;
  onViewportSnapshot?: (snapshot: FlowChatViewportSnapshot) => void;
  onViewportRestoreSettled?: (sessionId: string) => void;
  initialViewportSnapshot?: FlowChatViewportSnapshot | null;
}

type PreparedTurnNavigation = {
  turnId: string;
  behavior: ScrollBehavior;
};

/**
 * The gap the first Turn sits below.
 *
 * Every other Turn is top-aligned to the same gap explicitly, so this height is
 * the shared constant rather than a style of its own. It is also what the
 * virtualizer's `scrollPaddingStart` reserves, so an aim that is re-taken while
 * items measure keeps the same gap.
 *
 * Anything else rendered here is above the items in the scroll range, which is
 * why the virtualizer measures this element rather than assuming its height.
 */
const FlowChatListHeader = forwardRef<HTMLDivElement, {
  previousHistoryBoundaryStatusNode: React.ReactNode;
}>(({ previousHistoryBoundaryStatusNode }, ref) => (
  <div ref={ref} className="message-list-header-block">
    <div
      className="message-list-header"
      data-openbitfun-component="virtual-message-list"
      data-openbitfun-part="header"
      style={{
        height: `${FLOWCHAT_TURN_TOP_GAP_PX}px`,
        minHeight: `${FLOWCHAT_TURN_TOP_GAP_PX}px`,
      }}
    />
    {previousHistoryBoundaryStatusNode}
  </div>
));
FlowChatListHeader.displayName = 'FlowChatListHeader';

const FlowChatListFooter = ({
  bottomLayoutInsetPx,
  tailSpacerPx,
  nextHistoryBoundaryStatusNode,
  runtimeStatusSessionId,
}: {
  bottomLayoutInsetPx: number;
  tailSpacerPx: number;
  nextHistoryBoundaryStatusNode: React.ReactNode;
  runtimeStatusSessionId: string | null;
}) => (
  <>
    <div
      className="message-list-footer"
      data-openbitfun-component="virtual-message-list"
      data-openbitfun-part="footer"
      style={{
        height: `${bottomLayoutInsetPx}px`,
        minHeight: `${bottomLayoutInsetPx}px`,
      }}
    >
      {nextHistoryBoundaryStatusNode}
      <RuntimeStatusSlot sessionId={runtimeStatusSessionId} placement="footer" />
    </div>
    {/* Flex consumes/restores the latest Turn's trailing space without per-token writes. */}
    <div
      className="message-list-tail-spacer"
      data-openbitfun-component="virtual-message-list"
      data-openbitfun-part="tailSpacer"
      aria-hidden="true"
      style={{
        height: `${tailSpacerPx}px`,
        minHeight: `${tailSpacerPx}px`,
      }}
    />
  </>
);

const FlowChatHistoryPagingSentinel = ({
  state,
  label,
}: {
  state: 'idle' | 'loading' | 'error';
  label: string;
}) => (
  <div
    className="virtual-message-list__history-paging-sentinel"
    data-openbitfun-component="virtual-message-list"
    data-openbitfun-part="boundaryStatus"
    data-openbitfun-state={state === 'loading' ? 'preparing' : state === 'error' ? 'unavailable' : undefined}
    data-history-paging-sentinel={state}
    data-history-boundary-status={state === 'loading' ? 'preparing' : state === 'error' ? 'not-ready' : undefined}
    aria-hidden={state === 'idle'}
    role={state === 'idle' ? undefined : 'status'}
    aria-live={state === 'idle' ? undefined : 'polite'}
  >
    {state === 'loading' ? (
      <Icon glyph={Loader2} size="sm" aria-hidden className="virtual-message-list__history-paging-spinner" />
    ) : null}
    <span>{label}</span>
  </div>
);

function normalizeBoundaryResult(
  result: HistoryWindowBoundaryIntentResponse,
): HistoryWindowBoundaryIntentResult {
  if (result === true) return 'applied';
  if (result === false || result === undefined) return 'not-ready';
  return result;
}

/**
 * Whether a pointer press landed on the scroller's scrollbar rather than on the
 * transcript.
 *
 * `clientWidth` stops at the reserved scrollbar gutter, so the content box's
 * trailing edge falls one gutter width short of the bar. Everything past that
 * edge — the reserved track and the bar — is a scrollbar press, never a press
 * on the transcript column, which is inset well inside the content box.
 *
 * Measured on WebView2 with a one-sided 10px gutter: a press on the transcript
 * at `clientX` 1497, the content box ending at 1641, and presses on the bar at
 * 1643-1647. Reserving the gutter on both edges moves the boundary one gutter
 * width earlier, which only widens the band that counts as a bar press.
 *
 * Chromium does dispatch `pointerdown` for a scrollbar press. WebKit-backed
 * builds draw overlay scrollbars that take no layout width, leaving no gutter
 * to test against, so this returns false there and the drag stays unnoticed.
 */
function isScrollbarPress(event: PointerEvent, scroller: HTMLElement): boolean {
  return isFlowChatScrollbarPress(event, scroller);
}

function isElementVisibleInScroller(element: HTMLElement, scroller: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  return elementRect.bottom > scrollerRect.top && elementRect.top < scrollerRect.bottom;
}

const VirtualMessageListSession = forwardRef<VirtualMessageListRef, VirtualMessageListProps>(({
  items,
  latestTurnId,
  isViewportActive = true,
  presentationMode = 'tail',
  viewportMode = presentationMode === 'history-window' ? 'history-reading' : 'live-tail',
  historyWindow = null,
  presentationRevision: _presentationRevision = 0,
  historyBoundaryState = IDLE_HISTORY_WINDOW_BOUNDARY_STATE,
  onHistoryWindowBoundaryIntent,
  onRequestJumpToLatest,
  onUserScrollIntent,
  onViewportSnapshot,
  onViewportRestoreSettled,
  initialViewportSnapshot = null,
}, ref) => {
  const { t } = useTranslation('flow-chat');
  /**
   * This render, counted.
   *
   * The price of following the tail by growing an item is paid here: a height
   * change makes the virtualizer re-measure, which lands back in this component.
   * A follow that scrolls inside an item instead claims to cost nothing, and
   * this is the counter that claim is checked against. Deliberately dependency
   * free — every commit counts, whatever caused it.
   */
  useEffect(() => {
    noteFlowListCommit();
  });
  const modernStore = useModernFlowChatStoreApi();
  const canonicalVirtualItems = useVirtualItems();
  const sourceItems = items ?? canonicalVirtualItems;
  const { exploreGroupStates, pendingPermissionToolCallIds } = useFlowChatVolatileContext();
  const activeSession = useActiveSession();
  const activeSessionState = useActiveSessionState();
  const activeSessionId = activeSession?.sessionId ?? null;
  const { items: virtualItems, reader } = useConversationTimeline(sourceItems, activeSessionId ?? undefined, 'main');
  const timelineItemsRef = useRef(virtualItems);
  timelineItemsRef.current = virtualItems;
  const nextVisibleItemIndexes = useMemo(() => getNextVisibleVirtualItemIndexes(virtualItems), [virtualItems]);
  /**
   * The newest Turn the session has, which is what "a new Turn" means.
   *
   * Deliberately a fact about the ledger and not about the projection.
   * `virtualItems.at(-1)` answers where the presentation currently *ends*, and
   * a history window re-cut moves that to a Turn which has existed for hours:
   * measured, navigating to Turn 2 landed correctly and was then overwritten
   * twice, because each window loaded on the way ended somewhere new and each
   * of those read as a submission, pinning the window's last Turn to the top.
   *
   * Whether the Turn can be *acted on* is a second question, and it belongs
   * with the response rather than the identity — qualifying the identity by
   * visibility instead makes a Turn that merely came into view look new, which
   * is the same bug wearing the opposite sign.
   */
  const viewportIdRef = useRef<number | null>(null);
  if (viewportIdRef.current === null) {
    nextViewportInstanceId += 1;
    viewportIdRef.current = nextViewportInstanceId;
  }
  const viewportId = viewportIdRef.current;
  // Mirrors, so the unmount line below can report the state it ended on rather
  // than the state it was created with.
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const isViewportActiveRef = useRef(isViewportActive);
  isViewportActiveRef.current = isViewportActive;
  const itemCountRef = useRef(virtualItems.length);
  itemCountRef.current = virtualItems.length;
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  /**
   * Who is moving the viewport, for everything in this transcript that moves
   * it. Declared here because the scroller is, and every writer below takes it
   * from this one place rather than keeping its own opinion of the others.
   */
  const viewportOwner = useFlowChatViewportOwner(scrollerElementRef);
  const headerElementRef = useRef<HTMLDivElement | null>(null);
  const extentElementRef = useRef<HTMLDivElement | null>(null);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [viewportHeightPx, setViewportHeightPx] = useState(0);
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  /** Last scroller box the resize observer saw, to tell it apart from a content change. */
  const observedViewportBoxRef = useRef<{ width: number; height: number } | null>(null);
  /** Native minimization withdraws the scroller without unmounting the session. */
  const isViewportSuspendedRef = useRef(false);
  const suspendedViewportScrollTopRef = useRef<number | null>(null);
  const viewportResumeFrameRef = useRef<number | null>(null);
  /** Remaining resize callbacks over which to keep a resting viewport at the end. */
  const tailRealignCallbacksRef = useRef(0);
  /** Synchronous mirror of `isAtBottom`, read by a resize for the pre-resize answer. */
  const isAtTailRef = useRef(true);
  /** A pointer is held on the scrollbar, so the scrolling it causes is intent. */
  const isScrollbarPressRef = useRef(false);
  // Streaming commits rebind geometry listeners. A physical gesture spans
  // those commits, so its fractional travel and touch origin must survive.
  const nativeScrollIntent = useMemo(() => ({
    wheel: new FlowChatScrollIntent(), touch: new FlowChatTouchIntent(), scrollbar: new FlowChatScrollIntent(),
  }), []);
  const viewportSnapshotFrameRef = useRef<number | null>(null);
  const lastSnapshotRestoreErrorPxRef = useRef(Number.POSITIVE_INFINITY);
  const onViewportSnapshotRef = useRef(onViewportSnapshot);
  onViewportSnapshotRef.current = onViewportSnapshot;
  const [isAtBottom, setIsAtBottom] = useState(true);
  // A brand-new transcript with only the foreground send shell has no history
  // geometry to settle. Reveal that first bubble in the submission frame.
  const [isOpenViewportSettled, setIsOpenViewportSettled] = useState(() => (
    activeSession?.dialogTurns.length === 0
    && virtualItems.length === 1
    && virtualItems[0].type === 'user-message'
    && virtualItems[0].submissionPhase !== undefined
  ));
  useSessionReadOnOpen(activeSessionId, isViewportActive);
  const shouldRestoreInitialSnapshot = Boolean(
    initialViewportSnapshot
    && initialViewportSnapshot.sessionId === activeSessionId
    && !initialViewportSnapshot.isAtTail
    && initialViewportSnapshot.anchorTurnId !== null
    && initialViewportSnapshot.anchorOffsetPx !== null
  );
  const preparedTurnNavigationRef = useRef<PreparedTurnNavigation | null>(null);
  // Selection identity only; this must never hold or reposition the viewport.
  const navigatedTurnIdRef = useRef<string | null>(null);
  const [historyPager] = useState(() => new FlowChatHistoryPager());
  const [historyPageRevision, acknowledgeHistoryPage] = useState(0);
  const readerScrollPositionRef = useRef<number | null>(null);
  const pagingLayoutKeyRef = useRef<string | null>(null);
  const windowBoundsKey = historyWindow
    ? `${historyWindow.startOrdinal}:${historyWindow.endOrdinalExclusive}`
    : presentationMode;
  /** Assigned below, once the boundary evaluation it stands for exists. */
  const evaluateHistoryBoundariesRef = useRef<() => void>(() => {});
  const searchNavigationRequestIdRef = useRef(0);
  const visibleTurnUpdateFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => () => {
    searchNavigationRequestIdRef.current += 1;
    historyPager.reset();
  }, [activeSessionId, historyPager]);

  const reconcileOpeningMeasurementRef = useRef<() => boolean>(() => false);
  const isExpandingSearchSourceRef = useRef(false);
  const readerInteractionRef = useRef<(kind: TimelineReaderInteraction) => void>(() => {});
  const interactionKeys = useTimelineInteraction(scrollerElementRef, reader, () => viewportOwner.currentOwner() === 'follow-output', undefined, kind => readerInteractionRef.current(kind));
  const pinnedKeys = useMemo(() => submissionKey
    ? new Set([...interactionKeys, submissionKey]) : interactionKeys, [interactionKeys, submissionKey]);
  const virtualizer = useFlowChatVirtualizer({
    pinnedKeys,
    items: virtualItems,
    startAtTailOnMount: presentationMode !== 'history-window' && !shouldRestoreInitialSnapshot,
    reconcileOpeningMeasurement: () => reconcileOpeningMeasurementRef.current(),
    scrollerRef: scrollerElementRef,
    headerRef: headerElementRef,
    getItemKey: getVirtualItemStableKey,
    estimateItemHeightPx: estimateVirtualMessageItemHeightWithContext,
    getKnownItemHeightPx: getKnownVirtualItemHeightPx,
    estimateContext: {
      availableWidthPx: viewportWidthPx > 0 ? viewportWidthPx : scrollerElement?.clientWidth,
      isHistorical: activeSession?.isHistorical === true,
      exploreGroupStates,
    } satisfies VirtualItemHeightEstimateContext,
    estimateContextRevision: [
      viewportWidthPx,
      activeSession?.isHistorical === true ? 'historical' : 'live',
      [...(exploreGroupStates?.entries() ?? [])]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([groupId, expanded]) => `${groupId}:${expanded ? 1 : 0}`)
        .join(','),
    ].join('|'),
    isViewportSuspended: () => isViewportSuspendedRef.current,
    scrollPaddingStartPx: FLOWCHAT_TURN_TOP_GAP_PX,
    writeViewport: viewportOwner.write,
    shiftViewport: viewportOwner.shift,
  });

  const userMessageItems = useMemo(() => virtualItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'user-message'), [virtualItems]);

  const isStreamingOutput = useMemo(() => {
    if (viewportMode === 'history-reading') return false;
    if (activeSessionState.isProcessing) return true;
    const latestTurn = activeSession?.dialogTurns.at(-1);
    return Boolean(
      latestTurn && (
        latestTurn.status === 'processing' ||
        latestTurn.status === 'finishing' ||
        latestTurn.status === 'image_analyzing' ||
        latestTurn.modelRounds.some(round => round.isStreaming)
      )
    );
  }, [activeSession, activeSessionState.isProcessing, viewportMode]);

  const inputHeight = useChatInputState(state => state.inputHeight);
  const inputOverlayInsetPx = computeFlowChatInputOverlayInsetPx(inputHeight);
  const bottomLayoutInsetPx = computeFlowChatInputStackFooterPx(inputHeight);

  const tailSpacerPx = tailSpacerPxForViewport(viewportHeightPx, bottomLayoutInsetPx);
  const tailSpacerPxRef = useRef(tailSpacerPx);
  useLayoutEffect(() => {
    tailSpacerPxRef.current = tailSpacerPx;
  }, [tailSpacerPx]);

  /*
   * The paging diagnostics need a few session facts, but `activeSession` is a
   * fresh object on every streaming flush: depending on it would rebuild
   * `requestHistoryBoundary` and therefore the rendered-range effect many times
   * a second. Hold the session itself by reference — one assignment per render,
   * no allocation — and read the fields only on the rare diagnostic path.
   */
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  const isOpenViewportSettledRef = useRef(isOpenViewportSettled);
  isOpenViewportSettledRef.current = isOpenViewportSettled;
  const isOpeningViewport = useCallback(() => !isOpenViewportSettledRef.current, []);

  const getRenderedUserMessageElement = useCallback((turnId: string) => (
    findRenderedTurnAnchorElement(scrollerElementRef.current, turnId)
  ), []);

  const readContentEndScrollTop = useCallback((scroller: HTMLElement) => (
    contentEndScrollTop({
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    })
  ), []);

  /**
   * The content-end scroll, issued *through the virtualizer*.
   *
   * Writing the scroller directly is cheaper, but it leaves any pending re-aim
   * in place — the virtualizer keeps chasing its last target for as long as the
   * measurements under it move. A caller correcting one of its own scrolls has
   * to replace that chase rather than outrun it, and only another scroll issued
   * through the virtualizer does.
   *
   * The target is read off live geometry rather than aligned to the last item,
   * because the end of *real content* is above the resident tail spacer and no
   * item knows where that is.
   */
  const scrollToContentEndThroughVirtualizer = useCallback((
    behavior: 'auto' | 'smooth',
    owner: FlowChatViewportOwner = 'follow-output',
    // A one-shot owner has to state its window here as anywhere else. Only a
    // writer that releases may hold the viewport without one.
    holdForMs?: number,
  ) => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    virtualizer.scrollToOffset(readContentEndScrollTop(scroller), {
      behavior,
      owner,
      holdForMs,
    });
  }, [readContentEndScrollTop, virtualizer]);

  const userMessageIndexes = useMemo(() => new Map(userMessageItems.map(({ item, index }) => [item.turnId, index])), [userMessageItems]);
  const resolveTurnTopScrollTop = useCallback((turnId: string) => {
    const scroller = scrollerElementRef.current;
    const element = getRenderedUserMessageElement(turnId);
    if (!scroller || !element) return null;
    return turnTopScrollTop(
      scroller.scrollTop
        + element.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top,
    );
  }, [getRenderedUserMessageElement]);

  const tailTurnId = presentationMode === 'tail' ? virtualItems.at(-1)?.turnId : undefined;
  const rebaseLeadingAnchorRef = useRef<() => void>(() => {});
  const { capture: captureLeadingExtent, refresh: refreshLeadingExtent, snapshot: snapshotLeadingExtent } = useFlowChatLeadingExtent({
    scope: JSON.stringify([activeSessionId, presentationMode, tailTurnId]),
    items: virtualItems, virtualizer, scrollerRef: scrollerElementRef, extentRef: extentElementRef,
    onAnchorRebased: () => rebaseLeadingAnchorRef.current(),
  });
  const readLayoutTarget = useCallback(() => {
    const scroller = scrollerElementRef.current;
    const extent = extentElementRef.current;
    if (!scroller || !extent) return 0;
    const index = tailTurnId === undefined ? undefined : userMessageIndexes.get(tailTurnId);
    const bounds = index === undefined ? null : virtualizer.getItemBounds(index);
    // This is a property of the current Turn, not a consumable send receipt.
    // CSS consumes/restores trailing flex space as cards grow/fold. Keeping the
    // minimum in place prevents an intermediate browser clamp on collapse.
    // Cached virtual bounds keep it current while its user row is unmounted,
    // including prepends; a mounted row supplies exact normal-flow geometry.
    const top = tailTurnId !== undefined && bounds
      ? resolveTurnTopScrollTop(tailTurnId) ?? turnTopScrollTop(bounds.startPx)
      : null;
    refreshLeadingExtent(top);
    // Reading only changes layout, never ownership or scroll position. Follow,
    // jump and the native scrollbar share this actual reachable endpoint.
    return readContentEndScrollTop(scroller);
  }, [readContentEndScrollTop, refreshLeadingExtent, resolveTurnTopScrollTop, tailTurnId, userMessageIndexes, virtualizer]);

  const publishFollowOffset = useCallback((offset: number) => {
    virtualizer.syncViewportOffset(offset);
    // Opening estimates are still settling; do not turn those estimates into
    // a persistent leading edge before the viewport has been revealed.
    if (!isOpeningViewport()) captureLeadingExtent(offset);
  }, [captureLeadingExtent, isOpeningViewport, virtualizer]);
  useLayoutEffect(() => {
    if (isOpenViewportSettled && scrollerElementRef.current) {
      captureLeadingExtent(scrollerElementRef.current.scrollTop, true);
    }
    // Only on reveal. Layout changes resolve the existing anchor, never replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpenViewportSettled]);

  const placeSubmittedMessage = useCallback((intent: SubmittedMessageScrollIntent): number | null => {
    const item = virtualItems.find(candidate => candidate.turnId === intent.turnId && candidate.type === 'user-message');
    const turn = activeSessionRef.current?.dialogTurns.find(candidate => candidate.id === intent.turnId);
    if (!item || item.type !== 'user-message' || item.data.id !== intent.messageId
      || (turn && turn.userMessage.id !== intent.messageId)) return null;
    const scroller = scrollerElementRef.current;
    if (!scroller || !extentElementRef.current) return null;
    if (!getRenderedUserMessageElement(intent.turnId)) {
      // Materialize just this stable row before measuring it. Do not traverse
      // history or mount a whole Turn to get a user-message anchor.
      setSubmissionKey(getVirtualItemStableKey(item));
      return null;
    }
    virtualizer.cancelAim();
    virtualizer.measureRenderedItems();
    const top = resolveTurnTopScrollTop(intent.turnId);
    if (top === null) return null;
    extentElementRef.current.style.minHeight = `${top + scroller.clientHeight}px`;
    if (!viewportOwner.write({ owner: 'follow-output', topPx: top })) return null;
    virtualizer.syncViewportOffset(scroller.scrollTop);
    captureLeadingExtent(scroller.scrollTop, true);
    setSubmissionKey(null);
    return scroller.scrollTop;
  }, [captureLeadingExtent, getRenderedUserMessageElement, resolveTurnTopScrollTop, viewportOwner, virtualItems, virtualizer]);
  const outputTurns = useMemo(() => new Set(virtualItems.filter(item => item.type !== 'user-message').map(item => item.turnId)), [virtualItems]);

  const {
    isFollowingOutput,
    enterFollowOutput,
    exitFollowOutput,
    scheduleFollowToLatest,
    isFollowingOutputNow,
    isFollowCorrectingViewport,
    handleUserScrollIntent,
    handleTurnsRolledBack,
    handleScroll,
    handleViewportResize,
    getFollowTargetScrollTop,
  } = useFlowChatFollowOutput({
    activeSessionId: activeSessionId ?? undefined,
    virtualItemCount: virtualItems.length,
    isStreaming: isStreamingOutput,
    isViewportActive,
    startAtTailOnMount: presentationMode !== 'history-window' && !shouldRestoreInitialSnapshot,
    isViewportSuspended: () => isViewportSuspendedRef.current,
    scrollerRef: scrollerElementRef,
    readLayoutTarget,
    placeSubmittedMessage,
    hasRenderedOutput: turnId => outputTurns.has(turnId),
    cancelPendingPlacement: () => setSubmissionKey(null),
    cancelNavigation: virtualizer.cancelAim,
    isOpeningViewport,
    onViewportOffset: publishFollowOffset,
    viewportOwner,
    viewportId,
  });

  reconcileOpeningMeasurementRef.current = () => {
    if (isOpenViewportSettledRef.current || isViewportSuspendedRef.current
      || !isViewportActive || !isFollowingOutputNow()
      || viewportOwner.currentOwner() !== 'follow-output') return false;
    scheduleFollowToLatest();
    return true;
  };

  /**
   * The anchor stands down for anyone aiming at a target of their own — and for
   * nobody else, the reader included.
   *
   * Its correction is a displacement repair, the same kind of act as the
   * prepend compensation, so it asks the register the same question. Measured:
   * with the anchor ranked under the gesture it stood down 23 times and
   * corrected nothing at all, while the transcript shrank 200px under a reader
   * who had not moved — and the compensation, which is a pixel delta, cannot
   * follow a re-measurement that lands after it.
   *
   * The opening reveal is the one term left beside the register, because it is
   * a phase rather than a writer and the thing moving the viewport during it is
   * follow-output — see `flowChatViewportOwnership.ts`.
   */
  const isViewportOwnedElsewhere = useCallback(() => (
    isViewportSuspendedRef.current || !viewportOwner.canShift() || isOpeningViewport()
  ), [isOpeningViewport, viewportOwner]);

  const shiftAnchorCorrection = useCallback((byPx: number) => {
    viewportOwner.shift(byPx);
  }, [viewportOwner]);

  const viewportAnchor = useFlowChatViewportAnchor({
    scrollerRef: scrollerElementRef,
    isViewportOwnedElsewhere,
    shiftViewport: shiftAnchorCorrection,
  });
  rebaseLeadingAnchorRef.current = viewportAnchor.reanchorAfterNavigation;

  /**
   * Keep the viewport on the same content when history is prepended.
   *
   * This is the half of react-virtuoso's `firstItemIndex` that nothing replaced.
   * Keying measurements on item identity means a prepend invalidates none of
   * them, which is the other half — but the scroll offset is still a number,
   * and items arriving above it push the reader's content down by their height
   * while it stays where it was.
   *
   * Everything downstream assumes this does not happen, and all three of the
   * failures measured here were that assumption breaking:
   *
   * - The virtualizer re-windows from its own scroll offset, which lags by a
   *   frame, so it renders the head. The paging rule reads that as the reader
   *   having arrived at the head and pages again, and again.
   * - The anchored Turn falls outside that window, so the anchor cannot find
   *   its element, drops the anchor and corrects nothing — measured, 655px of
   *   history arrived and `scrollTop` held at 23.
   * - With the reader left at the head, the boundary never re-arms.
   *
   * The amount is a delta and not a total: the height of exactly the items that
   * arrived above, read from the virtualizer's own placement of the item that
   * used to be first. Their heights are estimates until they measure, so this
   * lands close rather than exactly, and the anchor — which can now find its
   * Turn — takes it the rest of the way.
   */
  const firstItemKeyRef = useRef<string | null>(null);
  const prependSnapshotRef = useRef<{ firstKey: string; scrollHeight: number } | null>(null);
  const prependItemKeys = useMemo(() => virtualItems.map(getVirtualItemStableKey), [virtualItems]);
  useLayoutEffect(() => {
    const previousFirstKey = firstItemKeyRef.current;
    const nextFirstKey = virtualItems[0] ? getVirtualItemStableKey(virtualItems[0]) : null;
    firstItemKeyRef.current = nextFirstKey;

    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const snapshot = prependSnapshotRef.current;
    prependSnapshotRef.current = null;
    if (isViewportSuspendedRef.current) return;
    if (previousFirstKey === null || previousFirstKey === nextFirstKey) return;
    if (!snapshot || snapshot.firstKey !== previousFirstKey) return;
    const previousScrollHeightPx = snapshot.scrollHeight;
    // Absent means the head was trimmed rather than extended, and there is no
    // prepended height to account for.
    const movedTo = virtualItems.findIndex(
      item => getVirtualItemStableKey(item) === previousFirstKey,
    );
    if (movedTo <= 0) return;
    /*
     * The rows that arrived are already in the DOM at their real heights, and
     * the cache still holds the estimates it reserved for them: the library
     * skips its inline measurement while the reader is scrolling, and history
     * arrives only then. Measuring here is the difference between a
     * compensation derived from a guess and one derived from the layout the
     * reader is looking at.
     */
    virtualizer.measureRenderedItems();
    const arrived = virtualizer.getItemBounds(movedTo);
    const head = virtualizer.getItemBounds(0);
    if (!arrived || !head) return;
    const prependedPx = arrived.startPx - head.startPx;
    if (prependedPx <= 0) return;
    /*
     * A displacement, not a position, which is why it is a shift and not a
     * write. It is left to whoever already holds a target — the follow loop
     * re-asserting it, a navigation reaching a Turn — and to nobody else.
     *
     * A gesture in particular cannot refuse it. History pages in only while the
     * reader is scrolling up into it, so routing this through the priority
     * order refused every compensation there ever was.
     */
    const fromPx = scroller.scrollTop;
    /*
     * Three bounds on how far the reader has to move, and the smallest wins.
     *
     * Each is an upper bound on the true amount, and they fail in different
     * directions, so the smallest is the only one that cannot overshoot:
     *
     * - `prependedPx` is what the virtualizer *reserved* for the items that
     *   arrived. It over-states while they are estimates, and they are
     *   estimates exactly when this runs: the DOM has already rendered them at
     *   their real heights, and the measurement cache has not heard yet.
     *   Measured, twice in one session: 2174px reserved against 670px of real
     *   growth, then 2494px against 949px.
     * - `scrollRangeGrowthPx` is what the scroll range actually gained, which
     *   is the DOM's own answer. It over-states only if the transcript also
     *   grew below the reader in the same commit.
     * - What the range can absorb before the reader is inside the reserved
     *   blank. Content arriving above them cannot push them past the end of the
     *   transcript, so needing more than this is proof the amount is wrong.
     *
     * Overshooting is the expensive direction: it puts the reader below the
     * content end, inside the reserved blank. Undershooting leaves
     * them looking at slightly earlier content, which the anchor removes.
     */
    const contentEndPx = readContentEndScrollTop(scroller);
    const scrollRangeGrowthPx = scroller.scrollHeight - previousScrollHeightPx;
    const shiftedPx = Math.max(0, Math.min(
      prependedPx,
      scrollRangeGrowthPx,
      contentEndPx - fromPx,
    ));
    const compensated = shiftedPx > 0 && viewportOwner.shift(shiftedPx);
    /*
     * This one movement is made on the anchor's behalf, so it is the one it
     * must not read as the reader having scrolled. Everything else that changes
     * `scrollTop` between two of its corrections is somebody's deliberate
     * movement, and the anchor is right to leave those alone.
     */
    if (compensated) viewportAnchor.absorbViewportShift(shiftedPx);
    /*
     * A refusal leaves the displacement to whoever holds a target — so make
     * sure they are awake to take it.
     *
     * Follow-output is the only holder that can be asleep. Its ownership
     * deliberately outlives its frame loop, so that streaming can resume
     * without re-entering, and the loop stops on its own once the transcript
     * settles; a navigation's aim is still running by construction. So a page
     * landing after the settle budget ran
     * out is refused by a writer that will never act, and the reader is left
     * holding an offset that now means something else.
     *
     * Measured, from the fault this was found in: 22301px of history arrived
     * above a viewport at 0, the shift was refused with `heldBy:
     * follow-output`, and nothing moved for the rest of the session — the
     * transcript was revealed at the top of the window, eight Turns above the
     * tail. Re-asserting is idempotent when the loop *is* running: it aims at
     * the offset the follow rule already owns.
     */
    const wokeFollowOutput = !compensated
      && shiftedPx > 0
      && viewportOwner.currentOwner() === 'follow-output';
    if (wokeFollowOutput) scheduleFollowToLatest();
    /*
     * Both amounts, because their disagreement is the diagnosis. `prependedPx`
     * against what the scroll range actually grew by says how far the cache is
     * ahead of the DOM; against `shiftedPx` it says how much of the
     * compensation had to be given up, which is what the reader feels as a
     * jump that the anchor then has to finish undoing.
     */
    traceViewport({
      location: 'virtualMessageList.prependCompensated',
      message: 'history arrived above the reader',
      data: () => {
        const followTargetPx = getFollowTargetScrollTop();
        return {
          viewportId,
          compensated,
          prependedPx: roundViewportPx(prependedPx),
          shiftedPx: roundViewportPx(shiftedPx),
          scrollRangeGrowthPx: roundViewportPx(scrollRangeGrowthPx),
          itemsAbove: movedTo,
          fromPx: roundViewportPx(fromPx),
          contentEndPx: roundViewportPx(contentEndPx),
          scrollTopPx: roundViewportPx(scroller.scrollTop),
          /*
           * Who the displacement was left to, and where they are taking it.
           * A refused shift is only correct if the holder then places the
           * reader itself; read after the re-assertion above, so `null` here
           * with `wokeFollowOutput` true is a holder that could not be woken —
           * the register believes someone owns the viewport and the follow rule
           * believes it is not following, which is the one state nothing can
           * recover from on its own.
           */
          followTargetPx: followTargetPx === null ? null : roundViewportPx(followTargetPx),
          wokeFollowOutput,
          isOpening: isOpeningViewport(),
          // The baseline every later `anchor.correct` in this settle is read
          // against: a correction that arrives with the range unchanged is a
          // compensation that over-shot, and one that arrives with the range
          // smaller is the transcript above the reader measuring down.
          scrollRangePx: roundViewportPx(scroller.scrollHeight),
          presentationMode,
        };
      },
    });
  }, [
    getFollowTargetScrollTop,
    isOpeningViewport,
    presentationMode,
    readContentEndScrollTop,
    scheduleFollowToLatest,
    viewportAnchor,
    viewportId,
    viewportOwner,
    virtualItems,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    viewportAnchor.openSettleWindow('items');
  }, [viewportAnchor, virtualItems]);

  const updateVisibleTurnInfoFromViewport = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportEntries = Array.from(
      scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-turn-id]'),
    ).map(element => {
      const rect = element.getBoundingClientRect();
      return {
        turnId: element.dataset.turnId ?? null,
        itemType: element.dataset.itemType ?? null,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const visibleTurnIds = resolveVisibleFlowChatTurnIds(
      viewportEntries,
      scrollerRect.top,
      scrollerRect.bottom,
    );
    if (isFollowingOutputNow()) navigatedTurnIdRef.current = null;
    const navigatedTurnId = navigatedTurnIdRef.current;
    // A top gap can expose the preceding Turn; a content-end clamp can expose
    // several. Neither makes that earlier Turn the user's navigation target.
    // Until the target arrives on screen, keep reporting actual visibility.
    const currentTurnId = navigatedTurnId && visibleTurnIds.includes(navigatedTurnId)
      ? navigatedTurnId
      : visibleTurnIds[0] ?? null;
    const currentTurn = currentTurnId
      ? userMessageItems.find(({ item }) => item.turnId === currentTurnId)
      : undefined;
    const store = modernStore.getState();

    if (!currentTurn || currentTurn.item.type !== 'user-message') {
      if (store.visibleTurnInfo !== null) store.setVisibleTurnInfo(null);
      return;
    }

    const nextVisibleTurnInfo = {
      turnIndex: userMessageItems.indexOf(currentTurn) + 1,
      totalTurns: userMessageItems.length,
      userMessage: currentTurn.item.data.content ?? '',
      turnId: currentTurn.item.turnId,
      visibleTurnIds,
    };
    const previous = store.visibleTurnInfo;
    const unchanged = previous?.turnId === nextVisibleTurnInfo.turnId
      && previous.turnIndex === nextVisibleTurnInfo.turnIndex
      && previous.totalTurns === nextVisibleTurnInfo.totalTurns
      && previous.userMessage === nextVisibleTurnInfo.userMessage
      && previous.visibleTurnIds.length === visibleTurnIds.length
      && previous.visibleTurnIds.every((turnId, index) => turnId === visibleTurnIds[index]);
    if (!unchanged) store.setVisibleTurnInfo(nextVisibleTurnInfo);
  }, [isFollowingOutputNow, modernStore, userMessageItems]);

  const scheduleVisibleTurnInfoUpdate = useCallback(() => {
    if (visibleTurnUpdateFrameRef.current !== null) return;
    visibleTurnUpdateFrameRef.current = requestAnimationFrame(() => {
      visibleTurnUpdateFrameRef.current = null;
      updateVisibleTurnInfoFromViewport();
    });
  }, [updateVisibleTurnInfoFromViewport]);

  const setNavigatedTurn = useCallback((turnId: string | null) => {
    navigatedTurnIdRef.current = turnId;
    if (turnId !== null) historyPager.reset();
    // Different tail Turns can land at the same offset, emitting no scroll.
    scheduleVisibleTurnInfoUpdate();
  }, [historyPager, scheduleVisibleTurnInfoUpdate]);

  const notifyUserScrollIntent = useCallback((direction?: SessionHistoryWindowDirection, interaction?: TimelineReaderInteraction) => {
    const scroller = scrollerElementRef.current;
    if (scroller && !isViewportSuspendedRef.current) captureLeadingExtent(scroller.scrollTop, true);
    if (direction) historyPager.readerIntent(direction);
    /*
     * The reader outranks everything, and the claim is what makes that true of
     * writers that are already in flight rather than only of ones yet to
     * start. It lapses on its own after the same window the anchor uses to
     * decide a scroll was theirs — a gesture has no completion event, so the
     * hold has to end by itself or nothing below it could ever write again.
     */
    viewportOwner.claim('user-gesture', { holdForMs: USER_DRIVEN_SCROLL_WINDOW_MS });
    /*
     * The claim alone does not reach the library's re-aim. It goes on
     * recomputing its target for five seconds and writes again whenever a
     * measurement moves it, and the claim only refuses those writes while the
     * gesture's own hold is live — 200ms after the last wheel notch, against a
     * five-second re-aim. Measured: a Turn navigation placed at 5358, the
     * reader took over 6ms later, and 12ms after that the re-aim asked for
     * 7784 and was refused. Nothing had ended it; it was still armed when the
     * recording stopped.
     */
    virtualizer.cancelAim();
    searchNavigationRequestIdRef.current += 1;
    viewportAnchor.markUserScrollIntent();
    if (interaction) handleUserScrollIntent(direction, 'reader-interaction');
    else handleUserScrollIntent(direction);
    setNavigatedTurn(null);
    onUserScrollIntent?.();
    /*
     * A gesture that moves nothing is still the reader asking to go up, and it
     * is the only signal there is once they are already at the top: the wheel
     * emits no `scroll` event when the offset cannot change, so the scroll
     * handler's evaluation never runs.
     *
     * Measured on a tail window of three Turns that fitted inside the viewport,
     * so the whole scroll range was reserved blank: twenty gestures over seven
     * seconds produced twenty `user-gesture` claims, no scroll events, and not
     * one boundary evaluation. Nothing could ever page.
     *
     * After `handleUserScrollIntent`, which clears follow-output's ownership
     * synchronously — so this asks as the reader rather than as our placement.
     */
    evaluateHistoryBoundariesRef.current();
  }, [
    captureLeadingExtent,
    historyPager,
    handleUserScrollIntent,
    onUserScrollIntent,
    setNavigatedTurn,
    viewportAnchor,
    viewportOwner,
    virtualizer,
  ]);

  readerInteractionRef.current = kind => {
    if (isExpandingSearchSourceRef.current) return;
    traceViewportRepeating(`reader|interaction|${viewportId}|${kind}`, {
      location: 'viewport.readerInteraction', message: 'Reader activated transcript content',
      data: () => ({ kind, viewportId }),
    });
    notifyUserScrollIntent(undefined, kind);
  };

  const captureViewportSnapshot = useCallback((): FlowChatViewportSnapshot | null => {
    const scroller = scrollerElementRef.current;
    if (!scroller || !activeSessionId || !isUsableFlowChatViewportRect({
      width: scroller.clientWidth,
      height: scroller.clientHeight,
    })) {
      return null;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const entries = Array.from(
      scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-turn-id]'),
    ).map(element => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        turnId: element.dataset.turnId ?? null,
        itemType: element.dataset.itemType ?? null,
        itemKey: element.dataset.virtualItemKey ?? null,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const anchorEntry = entries.find(entry => (
      entry.bottom > scrollerRect.top && entry.top < scrollerRect.bottom
    ));
    const anchorTurnId = anchorEntry?.turnId ?? null;
    const anchorElement = anchorEntry?.element;
    const anchorRect = anchorElement?.getBoundingClientRect();

    return {
      sessionId: activeSessionId,
      presentationMode,
      viewportMode,
      historyWindow,
      anchorItemKey: anchorEntry?.itemKey ?? null,
      anchorItemType: anchorEntry?.itemType ?? null,
      anchorTurnId,
      anchorOffsetPx: anchorRect
        ? roundViewportPx(anchorRect.top - scrollerRect.top)
        : null,
      scrollTopPx: roundViewportPx(scroller.scrollTop),
      isAtTail: isAtTailRef.current,
      capturedAtMs: Math.round(performance.now()),
    };
  }, [activeSessionId, historyWindow, presentationMode, viewportMode]);

  const restoreViewportSnapshot = useCallback((snapshot: FlowChatViewportSnapshot): boolean => {
    if (snapshot.sessionId !== activeSessionId) return false;
    const scroller = scrollerElementRef.current;
    if (!scroller || snapshot.anchorTurnId === null || snapshot.anchorOffsetPx === null) {
      return false;
    }
    const exactAnchor = snapshot.anchorItemKey
      ? Array.from(
        scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-virtual-item-key]'),
      ).find(element => element.dataset.virtualItemKey === snapshot.anchorItemKey) ?? null
      : null;
    const exactAnchorIndex = snapshot.anchorItemKey
      ? virtualItems.findIndex(item => getVirtualItemStableKey(item) === snapshot.anchorItemKey)
      : -1;
    const mustMaterializeExactAnchor = snapshot.anchorItemKey !== null
      && snapshot.anchorItemKey !== undefined
      && exactAnchorIndex >= 0
      && exactAnchor === null;
    const anchor = mustMaterializeExactAnchor
      ? null
      : exactAnchor ?? findRenderedTurnAnchorElement(scroller, snapshot.anchorTurnId);
    if (!anchor) {
      lastSnapshotRestoreErrorPxRef.current = Number.POSITIVE_INFINITY;
      const materializeByPx = snapshot.scrollTopPx - scroller.scrollTop;
      if (Math.abs(materializeByPx) > 0.5 && viewportOwner.shift(materializeByPx)) {
        traceViewport({
          location: 'viewport.sessionSnapshotMaterializing',
          message: 'FlowChat used the saved offset to materialize the semantic session anchor',
          data: () => ({
            sessionId: snapshot.sessionId,
            anchorItemKey: snapshot.anchorItemKey,
            anchorItemType: snapshot.anchorItemType,
            anchorTurnId: snapshot.anchorTurnId,
            approximateScrollTopPx: snapshot.scrollTopPx,
            shiftedPx: roundViewportPx(materializeByPx),
          }),
        });
      }
      return false;
    }
    const currentOffsetPx = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const correctionPx = currentOffsetPx - snapshot.anchorOffsetPx;
    lastSnapshotRestoreErrorPxRef.current = Math.abs(correctionPx);
    if (Math.abs(correctionPx) > 0.5) {
      if (!viewportOwner.shift(correctionPx)) return false;
    }
    // Seed the ordinary settle loop from the restored relationship so later
    // virtual-item measurements keep the same Turn at the same viewport offset.
    viewportAnchor.captureAnchor();
    viewportAnchor.openSettleWindow('snapshot');
    traceViewport({
      location: 'viewport.sessionSnapshotRestored',
      message: 'FlowChat restored a session anchor from its semantic snapshot',
      data: () => ({
        sessionId: snapshot.sessionId,
        anchorItemKey: snapshot.anchorItemKey,
        anchorItemType: snapshot.anchorItemType,
        resolvedBy: exactAnchor ? 'virtual-item' : 'turn-fallback',
        anchorTurnId: snapshot.anchorTurnId,
        expectedOffsetPx: snapshot.anchorOffsetPx,
        currentOffsetPx: roundViewportPx(currentOffsetPx),
        correctionPx: roundViewportPx(correctionPx),
      }),
    });
    return true;
  }, [activeSessionId, viewportAnchor, viewportOwner, virtualItems]);

  const publishViewportSnapshot = useCallback(() => {
    const snapshot = captureViewportSnapshot();
    if (snapshot) onViewportSnapshotRef.current?.(snapshot);
  }, [captureViewportSnapshot]);

  const scheduleViewportSnapshot = useCallback(() => {
    if (viewportSnapshotFrameRef.current !== null) return;
    viewportSnapshotFrameRef.current = requestAnimationFrame(() => {
      viewportSnapshotFrameRef.current = null;
      publishViewportSnapshot();
    });
  }, [publishViewportSnapshot]);

  useEffect(() => () => {
    if (visibleTurnUpdateFrameRef.current !== null) {
      cancelAnimationFrame(visibleTurnUpdateFrameRef.current);
      visibleTurnUpdateFrameRef.current = null;
    }
    if (viewportSnapshotFrameRef.current !== null) {
      cancelAnimationFrame(viewportSnapshotFrameRef.current);
      viewportSnapshotFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    scheduleViewportSnapshot();
  }, [historyWindow, presentationMode, scheduleViewportSnapshot, virtualItems, viewportMode]);

  useLayoutEffect(() => {
    traceViewport({
      location: isViewportActive ? 'viewport.sceneActivated' : 'viewport.sceneDeactivated',
      message: isViewportActive
        ? 'FlowChat viewport became active'
        : 'FlowChat viewport became inactive but remained mounted',
      data: () => ({
        viewportId,
        sessionId: activeSessionIdRef.current,
        isViewportActive,
        snapshot: captureViewportSnapshot(),
      }),
    });
    if (!isViewportActive) publishViewportSnapshot();
    else scheduleViewportSnapshot();
  }, [captureViewportSnapshot, isViewportActive, publishViewportSnapshot, scheduleViewportSnapshot, viewportId]);

  /*
   * The transcript's own lifetime, which every viewport line above is relative
   * to. A remount resets the scroller to offset 0, empties the measurement
   * cache and re-arms the opening reveal — so a placement that looks like it
   * was undone is often a placement made to a scroller that no longer exists.
   * The layout cleanup captures while the outgoing scroller still has geometry.
   */
  useLayoutEffect(() => {
    traceViewport({
      location: 'virtualMessageList.mounted',
      message: 'a transcript was mounted',
      data: () => ({
        viewportId,
        sessionId: activeSessionIdRef.current,
        itemCount: itemCountRef.current,
        isViewportActive: isViewportActiveRef.current,
      }),
    });
    return () => {
      publishViewportSnapshot();
      traceViewport({
        location: 'virtualMessageList.unmounted',
        message: 'a transcript was unmounted',
        data: () => ({
          viewportId,
          sessionId: activeSessionIdRef.current,
          itemCount: itemCountRef.current,
          scrollTopPx: roundViewportPx(scrollerElementRef.current?.scrollTop ?? 0),
        }),
      });
    };
  }, [publishViewportSnapshot, viewportId]);

  useLayoutEffect(() => {
    if (!shouldRestoreInitialSnapshot || !initialViewportSnapshot || isOpenViewportSettled) {
      return;
    }
    let cancelled = false;
    let frameId: number | null = null;
    let attempts = 0;
    let quietFrames = 0;
    const restore = () => {
      if (cancelled) return;
      attempts += 1;
      if (restoreViewportSnapshot(initialViewportSnapshot)) {
        quietFrames = lastSnapshotRestoreErrorPxRef.current <= 0.5
          ? quietFrames + 1
          : 0;
        if (quietFrames >= 2) {
          traceViewport({
            location: 'viewport.sessionSnapshotSettled',
            message: 'FlowChat session snapshot remained stable across painted frames',
            data: () => ({
              sessionId: initialViewportSnapshot.sessionId,
              anchorItemKey: initialViewportSnapshot.anchorItemKey,
              anchorItemType: initialViewportSnapshot.anchorItemType,
              anchorTurnId: initialViewportSnapshot.anchorTurnId,
              attempts,
              quietFrames,
              finalErrorPx: roundViewportPx(lastSnapshotRestoreErrorPxRef.current),
            }),
          });
          onViewportRestoreSettled?.(initialViewportSnapshot.sessionId);
          setIsOpenViewportSettled(true);
          return;
        }
      }
      if (attempts < 12) {
        frameId = requestAnimationFrame(restore);
        return;
      }
      traceViewport({
        location: 'viewport.sessionSnapshotRestoreAbandoned',
        message: 'FlowChat could not materialize the saved session anchor',
        data: () => ({
          sessionId: initialViewportSnapshot.sessionId,
          anchorItemKey: initialViewportSnapshot.anchorItemKey,
          anchorItemType: initialViewportSnapshot.anchorItemType,
          anchorTurnId: initialViewportSnapshot.anchorTurnId,
          attempts,
          itemCount: virtualItems.length,
        }),
      });
      onViewportRestoreSettled?.(initialViewportSnapshot.sessionId);
      setIsOpenViewportSettled(true);
    };
    restore();
    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    initialViewportSnapshot,
    isOpenViewportSettled,
    onViewportRestoreSettled,
    restoreViewportSnapshot,
    shouldRestoreInitialSnapshot,
    virtualItems.length,
  ]);

  /*
   * Opening reveal.
   *
   * A session mounts against an unmeasured transcript: for the first frames the
   * real content is a few hundred pixels of estimate, so the end of content
   * genuinely *is* the top, and the settle then walks the viewport down as items
   * measure and history pages in. Every step of that walk is correct and every
   * step is visible, which reads as a flash. Hold the transcript hidden — laid
   * out and measurable, just not painted — until it stops moving.
   */
  useLayoutEffect(() => {
    if (!scrollerElement || isOpenViewportSettled || shouldRestoreInitialSnapshot) return;

    let frame = 0;
    let quietFrames = 0;
    let rafId: number | null = null;
    const lastVirtualIndex = virtualItems.length - 1;

    const check = () => {
      frame += 1;
      /*
       * Geometry stability is not a settle signal on its own: before the virtualizer
       * renders anything, `scrollHeight` and the content end sit unchanged at
       * their unmeasured values, which is indistinguishable from having
       * finished. Require the last item to actually be rendered with its end
       * inside the viewport — that is the thing the reveal is waiting for.
       */
      const lastItem = scrollerElement.querySelector<HTMLElement>(
        `.virtual-item-wrapper[data-virtual-index="${lastVirtualIndex}"]`,
      );
      const contentEnd = readContentEndScrollTop(scrollerElement);
      const inPosition = Math.abs(scrollerElement.scrollTop - contentEnd) <= AT_CONTENT_END_THRESHOLD_PX;
      const tailVisible = lastItem !== null
        && lastItem.getBoundingClientRect().bottom
          <= scrollerElement.getBoundingClientRect().bottom + AT_CONTENT_END_THRESHOLD_PX;
      quietFrames = tailVisible && inPosition ? quietFrames + 1 : 0;

      if (quietFrames >= OPEN_REVEAL_QUIET_FRAMES || frame >= OPEN_REVEAL_MAX_FRAMES) {
        /*
         * Revealed on the frame cap rather than on quiet means the transcript
         * was still moving when it became visible, which is what the reader
         * reports as the session flickering on open.
         */
        traceViewport({
          location: 'virtualMessageList.openReveal',
          message: 'transcript revealed',
          data: () => {
            const followTargetPx = getFollowTargetScrollTop();
            return {
              viewportId,
              settled: quietFrames >= OPEN_REVEAL_QUIET_FRAMES,
              frames: frame,
              itemCount: virtualItems.length,
              scrollTopPx: roundViewportPx(scrollerElement.scrollTop),
              contentEndPx: roundViewportPx(readContentEndScrollTop(scrollerElement)),
              /*
               * Revealed away from the content end is the reader's "it opened
               * on the wrong Turn", and these two say whose it is: a follow
               * that owns a target it has not reached is a placement still on
               * its way, and no target at all is nobody having taken the
               * transcript on open.
               */
              followTargetPx: followTargetPx === null ? null : roundViewportPx(followTargetPx),
              isFollowCorrecting: isFollowCorrectingViewport(),
            };
          },
        });
        setIsOpenViewportSettled(true);
        return;
      }
      rafId = requestAnimationFrame(check);
    };
    rafId = requestAnimationFrame(check);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    getFollowTargetScrollTop,
    isFollowCorrectingViewport,
    isOpenViewportSettled,
    readContentEndScrollTop,
    scrollerElement,
    shouldRestoreInitialSnapshot,
    viewportId,
    virtualItems.length,
  ]);

  /*
   * "At the bottom" is a band, not a point. Its upper edge is the end of real
   * content and its lower edge is whatever the follow rule owns, so a pinned
   * Turn and a held collapse gap both count as being at the end — neither is a
   * reason to offer a jump to the latest output. Below the band is reserved
   * blank, which is: without the lower edge, parking a viewport deep in the
   * spacer read as "at the bottom" and hid the only way back.
   */
  const updateIsAtBottom = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const contentEnd = readContentEndScrollTop(scroller);
    /*
     * A follow still travelling counts as being at the end.
     *
     * The follow's write is eased, so it rides a little behind the offset it
     * owns by design, and what it is behind is arriving on its own. Judged on
     * the raw offset, a burst of two or three lines drops the viewport out of
     * the band for a few frames and flashes the jump-to-latest bar over a
     * transcript that is already following the newest output — and clicking it
     * would have nothing to do. Ownership alone cannot stand in for this: it
     * outlives the frame loop, which is exactly the state a viewport stranded
     * in the reserved blank is in.
     */
    const atTail = isFollowCorrectingViewport() || isViewportAtTail({
      scrollTop: scroller.scrollTop,
      contentEndScrollTop: contentEnd,
      // Nothing owns an offset outside follow, so the band collapses onto the
      // content end.
      followTargetScrollTop: getFollowTargetScrollTop() ?? contentEnd,
      thresholdPx: AT_CONTENT_END_THRESHOLD_PX,
    });
    // Mirrored to a ref because a resize needs the answer from before it, and
    // the state update does not land until the next render.
    isAtTailRef.current = atTail;
    setIsAtBottom(atTail);
  }, [getFollowTargetScrollTop, isFollowCorrectingViewport, readContentEndScrollTop]);

  const updateIsAtScrollStart = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const nextIsAtScrollStart = scroller.scrollTop <= FLOWCHAT_SCROLL_START_THRESHOLD_PX;
    const nextAttribute = nextIsAtScrollStart ? 'true' : 'false';
    if (scroller.dataset.scrollAtStart !== nextAttribute) {
      // This attribute drives only the CSS mask. Keeping it out of React state
      // prevents a visual scroll update from re-rendering the virtualizer and
      // evaluating the history boundary a second time for the same gesture.
      scroller.dataset.scrollAtStart = nextAttribute;
    }
  }, []);

  /*
   * The band's lower edge is whatever the follow rule owns, so it moves when
   * ownership changes — and that can happen with the viewport perfectly still.
   * A jump to latest that lands on a pin the viewport is already on writes
   * nothing. That produces no scroll event, so without this the affordance
   * stays as the last scroll
   * left it: visible, over a viewport that is already at the tail, and inert
   * because clicking it has nothing left to do.
   */
  useEffect(() => {
    updateIsAtBottom();
  }, [isFollowingOutput, updateIsAtBottom]);

  const resumeSuspendedViewport = useCallback(() => {
    viewportResumeFrameRef.current = null;
    if (!isViewportSuspendedRef.current) return;

    isViewportSuspendedRef.current = false;
    const suspendedScrollTopPx = suspendedViewportScrollTopRef.current;
    suspendedViewportScrollTopRef.current = null;
    const scrollTopBeforeRecoveryPx = scrollerElementRef.current?.scrollTop ?? null;
    const wasFollowingOutput = isFollowingOutputNow();
    let restoredAnchor = false;
    let restoredScrollTopFallback = false;

    if (!wasFollowingOutput) {
      restoredAnchor = viewportAnchor.restoreAnchorAfterViewportResume();
      if (!restoredAnchor && suspendedScrollTopPx !== null) {
        viewportOwner.write({
          owner: 'layout-correction',
          topPx: suspendedScrollTopPx,
        });
        restoredScrollTopFallback = true;
      }
      viewportAnchor.openSettleWindow('resume');
    }

    traceViewport({
      location: 'viewport.hostResumeRecovered',
      message: 'native host viewport recovery completed',
      data: () => {
        const scroller = scrollerElementRef.current;
        return {
          wasFollowingOutput,
          restoredAnchor,
          restoredScrollTopFallback,
          suspendedScrollTopPx: suspendedScrollTopPx === null
            ? null
            : roundViewportPx(suspendedScrollTopPx),
          scrollTopBeforeRecoveryPx: scrollTopBeforeRecoveryPx === null
            ? null
            : roundViewportPx(scrollTopBeforeRecoveryPx),
          scrollTopAfterRecoveryPx: scroller ? roundViewportPx(scroller.scrollTop) : null,
          viewportBox: scroller
            ? { width: scroller.clientWidth, height: scroller.clientHeight }
            : null,
        };
      },
    });

    scheduleFollowToLatest();
    scheduleVisibleTurnInfoUpdate();
    scheduleViewportSnapshot();
    updateIsAtBottom();
  }, [
    isFollowingOutputNow,
    scheduleFollowToLatest,
    scheduleViewportSnapshot,
    scheduleVisibleTurnInfoUpdate,
    updateIsAtBottom,
    viewportAnchor,
    viewportOwner,
  ]);

  useEffect(() => () => {
    if (viewportResumeFrameRef.current !== null) {
      cancelAnimationFrame(viewportResumeFrameRef.current);
      viewportResumeFrameRef.current = null;
    }
  }, []);

  /*
   * A rollback removed Turns from the session, so the transcript ends somewhere
   * it did not a moment ago — and the Turn follow-output was pinning may be one
   * of the ones that stopped existing. The follow rule settles on the new tail;
   * it declines for a reader who owns the viewport, which is the case when the
   * rollback came from the middle of a transcript they were reading.
   */
  useEffect(() => {
    const handleTurnsRolledBackEvent = (event: Event) => {
      const detail = (event as CustomEvent<FlowChatTurnsRolledBackRequest>).detail;
      if (!detail?.sessionId || detail.sessionId !== activeSessionId) return;
      handleTurnsRolledBack();
    };
    window.addEventListener(FLOWCHAT_TURNS_ROLLED_BACK_EVENT, handleTurnsRolledBackEvent);
    return () => {
      window.removeEventListener(FLOWCHAT_TURNS_ROLLED_BACK_EVENT, handleTurnsRolledBackEvent);
    };
  }, [activeSessionId, handleTurnsRolledBack]);

  useEffect(() => {
    if (!scrollerElement) return;
    const { wheel: wheelIntent, touch: touchIntent, scrollbar: scrollbarIntent } = nativeScrollIntent;
    const handleNativeScroll = () => {
      if (isViewportSuspendedRef.current) return;
      const position = viewportOwner.readReaderScrollPosition();
      const previous = readerScrollPositionRef.current;
      readerScrollPositionRef.current = position;
      const owner = viewportOwner.currentOwner();
      const delta = previous === null ? 0 : position - previous;
      const direction = delta < -0.5 ? 'before' : delta > 0.5 ? 'after' : undefined;
      // Synchronous corrections are removed by the register. Smooth owned
      // navigation/follow scrolls are excluded here; unowned momentum counts.
      if (direction && (owner === null || owner === 'user-gesture')) {
        captureLeadingExtent(scrollerElement.scrollTop, true);
        historyPager.readerIntent(direction);
      }
      if (owner === 'one-shot-navigation') captureLeadingExtent(scrollerElement.scrollTop, true);
      /*
       * A scroll under a scrollbar press is the one case where a plain scroll
       * event does carry intent — the press is what qualifies it. Left
       * unqualified, a drag never released the viewport: follow-output kept
       * writing its target every frame against the thumb (measured: a 100px
       * oscillation, every frame, for as long as the drag lasted). Recognising
       * the drag transfers ownership to the reader and preserves where it ends.
       */
      if (isScrollbarPressRef.current) {
        const dragDirection = scrollbarIntent.travel(0, delta, performance.now());
        if (dragDirection) notifyUserScrollIntent(dragDirection);
      }
      updateIsAtScrollStart();
      updateIsAtBottom();
      handleScroll();
      /*
       * Re-anchor to wherever the user has arrived, and only there. The rule
       * for "was this scroll the user's" lives with the anchor.
       */
      viewportAnchor.captureAnchorForScroll();
      scheduleVisibleTurnInfoUpdate();
      publishViewportSnapshot();
      /*
       * Paging is a question about where the reader is, so a scroll is its
       * primary input. Through a ref: this listener must not be torn down and
       * re-attached every time the transcript changes.
       */
      evaluateHistoryBoundariesRef.current();
    };
    const handleWheel = (event: WheelEvent) => {
      const direction = wheelIntent.wheel(event, scrollerElement.clientHeight);
      if (direction) notifyUserScrollIntent(direction);
    };
    const handleTouchStart = (event: TouchEvent) => { touchIntent.start(event); };
    const handleTouchMove = (event: TouchEvent) => {
      const direction = touchIntent.move(event);
      if (direction) notifyUserScrollIntent(direction);
    };
    const handleTouchEnd = () => { touchIntent.end(); };
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = flowChatKeyScrollDirection(event);
      if (direction) notifyUserScrollIntent(direction);
    };
    /*
     * Arming rather than releasing outright: `scrollbar-gutter: stable` keeps
     * the gutter reserved whether or not a bar is drawn in it, so a press there
     * is only intent once something actually scrolls. A click on the thumb that
     * moves nothing leaves the viewport where it was.
     */
    const handlePointerDown = (event: PointerEvent) => {
      isScrollbarPressRef.current = isScrollbarPress(event, scrollerElement);
      scrollbarIntent.reset();
      if (isScrollbarPressRef.current) readerScrollPositionRef.current = viewportOwner.readReaderScrollPosition();
    };
    const handlePointerRelease = () => {
      isScrollbarPressRef.current = false;
      scrollbarIntent.reset();
    };
    scrollerElement.addEventListener('scroll', handleNativeScroll, { passive: true });
    scrollerElement.addEventListener('wheel', handleWheel, { passive: true });
    scrollerElement.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollerElement.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollerElement.addEventListener('touchend', handleTouchEnd, { passive: true });
    scrollerElement.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    scrollerElement.addEventListener('keydown', handleKeyDown);
    scrollerElement.addEventListener('pointerdown', handlePointerDown, { passive: true });
    // On the window: a drag can be released anywhere, including outside it.
    window.addEventListener('pointerup', handlePointerRelease, { passive: true });
    window.addEventListener('pointercancel', handlePointerRelease, { passive: true });
    return () => {
      scrollerElement.removeEventListener('scroll', handleNativeScroll);
      scrollerElement.removeEventListener('wheel', handleWheel);
      scrollerElement.removeEventListener('touchstart', handleTouchStart);
      scrollerElement.removeEventListener('touchmove', handleTouchMove);
      scrollerElement.removeEventListener('touchend', handleTouchEnd);
      scrollerElement.removeEventListener('touchcancel', handleTouchEnd);
      scrollerElement.removeEventListener('keydown', handleKeyDown);
      scrollerElement.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, [
    captureLeadingExtent,
    historyPager,
    handleScroll,
    nativeScrollIntent,
    notifyUserScrollIntent,
    publishViewportSnapshot,
    scheduleVisibleTurnInfoUpdate,
    scrollerElement,
    updateIsAtScrollStart,
    updateIsAtBottom,
    viewportAnchor,
    viewportOwner,
  ]);

  useEffect(() => {
    if (!scrollerElement) return;
    const observer = new ResizeObserver(() => {
      const nextViewportBox = {
        width: scrollerElement.clientWidth,
        height: scrollerElement.clientHeight,
      };
      /*
       * A minimized WebView2 window reports a zero-height scroller while the
       * document remains visible. That is suspension, not a layout request:
       * accepting it would collapse the tail spacer, empty the virtual window,
       * clear the visible Turn and run a full-height scroll correction. Keep
       * every downstream owner on the last usable box until layout returns.
       */
      if (!isUsableFlowChatViewportRect(nextViewportBox)) {
        if (!isViewportSuspendedRef.current) {
          isViewportSuspendedRef.current = true;
          suspendedViewportScrollTopRef.current = scrollerElement.scrollTop;
          tailRealignCallbacksRef.current = 0;
          traceViewport({
            location: 'viewport.hostSuspended',
            message: 'native host withdrew the viewport from layout',
            data: () => ({
              receivedViewportBox: nextViewportBox,
              lastUsableViewportBox: observedViewportBoxRef.current,
              scrollTopPx: roundViewportPx(scrollerElement.scrollTop),
              scrollHeightPx: roundViewportPx(scrollerElement.scrollHeight),
              renderedRowCount: scrollerElement.querySelectorAll('[data-virtual-index]').length,
              tailSpacerPx: roundViewportPx(tailSpacerPxRef.current),
              isAtTail: isAtTailRef.current,
              viewportOwner: viewportOwner.currentOwner(),
            }),
          });
        }
        if (viewportResumeFrameRef.current !== null) {
          cancelAnimationFrame(viewportResumeFrameRef.current);
          viewportResumeFrameRef.current = null;
        }
        return;
      }
      updateIsAtScrollStart();
      const isResumingSuspendedViewport = isViewportSuspendedRef.current;
      if (isResumingSuspendedViewport) {
        traceViewport({
          location: 'viewport.hostResumeDetected',
          message: 'native host returned viewport geometry',
          data: () => ({
            recoveredViewportBox: nextViewportBox,
            lastUsableViewportBox: observedViewportBoxRef.current,
            suspendedScrollTopPx: suspendedViewportScrollTopRef.current === null
              ? null
              : roundViewportPx(suspendedViewportScrollTopRef.current),
            scrollTopPx: roundViewportPx(scrollerElement.scrollTop),
            scrollHeightPx: roundViewportPx(scrollerElement.scrollHeight),
            renderedRowCount: scrollerElement.querySelectorAll('[data-virtual-index]').length,
            tailSpacerPx: roundViewportPx(tailSpacerPxRef.current),
          }),
        });
        observedViewportBoxRef.current = nextViewportBox;
        setViewportHeightPx(nextViewportBox.height);
        setViewportWidthPx(nextViewportBox.width);
        if (viewportResumeFrameRef.current === null) {
          viewportResumeFrameRef.current = requestAnimationFrame(resumeSuspendedViewport);
        }
        return;
      }
      /*
       * This observer watches the content too. Content growth moves the follow
       * target away from a resting viewport and can never strand it, so only a
       * change to the scroller's own box opens the re-alignment window — a
       * width change reflows the transcript, a height change moves the content
       * end directly, and both keep settling for a few callbacks afterwards.
       */
      const previousViewportBox = observedViewportBoxRef.current;
      const viewportBoxChanged = previousViewportBox !== null && (
        nextViewportBox.width !== previousViewportBox.width
        || nextViewportBox.height !== previousViewportBox.height
      );
      observedViewportBoxRef.current = nextViewportBox;
      if (viewportBoxChanged) {
        tailRealignCallbacksRef.current = TAIL_REALIGN_RESIZE_CALLBACKS;
      }
      setViewportHeightPx(nextViewportBox.height);
      setViewportWidthPx(nextViewportBox.width);

      /*
       * Before paint, and ahead of everything below: this observer is the one
       * callback the browser delivers between the transcript changing height
       * and the frame being painted, which is the only place a correction can
       * still be invisible. A viewport box change is not a content shift, so a
       * genuine resize re-anchors instead of correcting.
       */
      // Resolve the leading extent before any reader-anchor restoration. The
      // shortened tail must not drag visible preceding content downward.
      scheduleFollowToLatest();
      if (viewportBoxChanged) {
        viewportAnchor.captureAnchor();
      } else {
        viewportAnchor.openSettleWindow('resize');
      }

      if (tailRealignCallbacksRef.current > 0) {
        tailRealignCallbacksRef.current -= 1;
        handleViewportResize({
          // Non-zero only on the callback that carries the change itself; the
          // rest of the window is there for the reflow settling afterwards.
          viewportHeightDeltaPx: viewportBoxChanged
            ? nextViewportBox.height - previousViewportBox.height
            : 0,
          // The band check from before this resize, so this must run ahead of
          // `updateIsAtBottom` below.
          wasAtTail: isAtTailRef.current,
        });
      }

      scheduleVisibleTurnInfoUpdate();
      scheduleViewportSnapshot();
      updateIsAtBottom();
    });
    /*
     * The virtualizer's own first child is a viewport-sized box — it stays at
     * the scroller's height no matter how much transcript there is, so
     * observing it never reported a content change at all. The item list is
     * the element that grows, and its padding is where the virtualizer parks
     * item space, which the content box does not include.
     */
    const content = scrollerElement.querySelector('[data-testid="flowchat-item-list"]')
      ?? scrollerElement.firstElementChild;
    if (content) observer.observe(content, { box: 'border-box' });
    observer.observe(scrollerElement);
    return () => observer.disconnect();
  }, [
    handleViewportResize,
    resumeSuspendedViewport,
    scheduleFollowToLatest,
    scheduleViewportSnapshot,
    scheduleVisibleTurnInfoUpdate,
    scrollerElement,
    updateIsAtScrollStart,
    updateIsAtBottom,
    viewportAnchor,
    viewportOwner,
  ]);

  /**
   * Top-align a Turn, without scrolling into the reserved blank to do it.
   *
   * The branch is on what is *knowable*, not on where the Turn is. A rendered
   * Turn has a resolvable offset, so the clamp is decided before anything
   * moves and the requested behaviour survives. An unrendered one is known
   * only to the virtualizer, so it is placed instantly and the answer read back —
   * both writes land in the same task, so the correction costs a second scroll
   * but not a second visible movement.
   */
  const navigateToTurnWithStatus = useCallback((
    turnId: string,
    options?: TurnNavigationOptions,
  ): FlowChatTurnNavigationStatus => {
    const targetIndex = virtualItems.findIndex(item => (
      item.turnId === turnId && item.type === 'user-message'
    ));
    if (targetIndex < 0) {
      traceViewport({
        location: 'turnNavigation.rejected',
        message: 'the requested Turn is not in the presentation',
        data: () => ({ turnId, itemCount: virtualItems.length, presentationMode }),
      });
      return 'rejected';
    }
    exitFollowOutput('scroll-to-turn');
    setNavigatedTurn(turnId);
    /*
     * Ahead of the placement, so that nothing between here and the commit that
     * renders it can restore the position being left. The reading position the
     * reader is choosing is the one they are about to land on.
     */
    viewportAnchor.reanchorAfterNavigation();

    const behavior = options?.behavior === 'smooth' ? 'smooth' : 'auto';
    const alignTurnToTop = () => virtualizer.scrollItemIntoView(targetIndex, {
      align: 'start',
      behavior,
      owner: 'one-shot-navigation',
      holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
    });
    const scroller = scrollerElementRef.current;
    const renderedTurnTopScrollTop = resolveTurnTopScrollTop(turnId);
    /*
     * Which branch ran is most of the diagnosis. "It stopped on the wrong Turn"
     * has already been a re-aim chasing a target below a moving measurement, a
     * clamp into the reserved blank, and a window re-cut arriving underneath —
     * and the branch, the target index and the drift afterwards tell them
     * apart. The drift in particular: a navigation that lands and is then taken
     * away leaves the same final position as one that never aimed right.
     */
    const traceNavigation = (
      branch: string,
      place: () => void,
      targetPx?: number,
      extra?: () => Record<string, unknown>,
    ) => {
      traceViewportPlacement(
        scroller,
        {
          location: 'turnNavigation.placed',
          message: 'Turn navigation placed the viewport',
          targetPx,
          /*
           * Past the navigation's own hold, always. Everything the hold is
           * postponing happens on the frame it lapses, so a sample taken
           * inside it can only ever report success — measured: a placement
           * reported `driftPx: 0` at 400ms and was dragged 1653px away 11ms
           * later, while three identical placements that were sampled after
           * the hold all reported the drift.
           */
          settleAfterMs: ONE_SHOT_NAVIGATION_HOLD_MS
            + (behavior === 'smooth' ? 900 : VIEWPORT_PLACEMENT_SETTLE_MS),
          data: () => ({
            branch,
            turnId,
            targetIndex,
            itemCount: virtualItems.length,
            behavior,
            presentationMode,
            ...(extra?.() ?? {}),
          }),
        },
        place,
      );
    };

    if (scroller && renderedTurnTopScrollTop !== null) {
      if (turnTopAlignmentEntersReservedBlank({
        turnTopScrollTop: renderedTurnTopScrollTop,
        contentEndScrollTop: readContentEndScrollTop(scroller),
      })) {
        traceNavigation(
          'rendered-clamped-to-content-end',
          () => scrollToContentEndThroughVirtualizer(
            behavior,
            'one-shot-navigation',
            ONE_SHOT_NAVIGATION_HOLD_MS,
          ),
        );
      } else {
        traceNavigation('rendered-top-aligned', alignTurnToTop, renderedTurnTopScrollTop);
      }
      return 'settled';
    }

    /*
     * Placed instantly on purpose: an animated scroll has not arrived yet, so
     * there would be nothing to read back. The requested behaviour is spent on
     * the placement, which is what turn-rail navigation already asks for.
     *
     * The clamp belongs to the same placement rather than being a second one.
     * It is decided from where the instant placement landed and applied in the
     * same task, so the reader sees one movement — and tracing it as two made
     * the first one's outcome sample compare the offset the viewport came to
     * rest at against a position this function had itself replaced 20ms
     * earlier. Measured: `driftPx: -892.7` against a target of 2484 that was
     * superseded by 1591, which is the clamp working exactly as intended
     * reported as the largest displacement in the recording.
     */
    let clampedToContentEnd = false;
    let unclampedPx: number | null = null;
    traceNavigation(
      'unrendered-placed-instantly',
      () => {
        virtualizer.scrollItemIntoView(targetIndex, {
          align: 'start',
          owner: 'one-shot-navigation',
          holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
        });
        if (!scroller) return;
        unclampedPx = scroller.scrollTop;
        if (!turnTopAlignmentEntersReservedBlank({
          turnTopScrollTop: scroller.scrollTop,
          // Re-read: placing the viewport renders items, which re-measures the
          // transcript and moves the content end with it.
          contentEndScrollTop: readContentEndScrollTop(scroller),
        })) {
          return;
        }
        clampedToContentEnd = true;
        scrollToContentEndThroughVirtualizer(
          'auto',
          'one-shot-navigation',
          ONE_SHOT_NAVIGATION_HOLD_MS,
        );
      },
      undefined,
      // Where the Turn's own alignment would have put the viewport, kept
      // because the clamp is only correct if that offset was in the blank.
      () => ({
        clampedToContentEnd,
        unclampedPx: unclampedPx === null ? null : roundViewportPx(unclampedPx),
      }),
    );
    return 'settled';
  }, [
    exitFollowOutput,
    presentationMode,
    readContentEndScrollTop,
    resolveTurnTopScrollTop,
    scrollToContentEndThroughVirtualizer,
    setNavigatedTurn,
    viewportAnchor,
    virtualItems,
    virtualizer,
  ]);

  const navigateToTurn = useCallback((turnId: string, options?: TurnNavigationOptions) => (
    navigateToTurnWithStatus(turnId, options) !== 'rejected'
  ), [navigateToTurnWithStatus]);

  /**
   * Centre a flow item — a tool call, a text block — inside its Turn.
   *
   * The virtualizer cannot be asked for this: it aligns *items*, and a flow
   * item lives inside one, so a centred model round is not a centred tool call.
   * That is the carve-out the contract already makes for a target that is not
   * an item, and the offset goes through the register like every other write.
   *
   * Returns whether the item was there to aim at. A focus request arriving
   * before its Turn has rendered asks again on the next frame.
   */
  const focusFlowItem = useCallback((flowItemId: string): boolean => {
    const scroller = scrollerElementRef.current;
    if (!scroller || !flowItemId) return false;
    if (requestDeferredContentItem(scroller, flowItemId)) return false;
    const element = findFlowChatFocusElement(scroller, flowItemId);
    if (!element) {
      const blockIndex = findTimelineBlockIndex(virtualItems, -1, flowItemId);
      if (blockIndex >= 0) virtualizer.scrollItemIntoView(blockIndex, { align: 'center', owner: 'one-shot-navigation' });
      return false;
    }

    exitFollowOutput('scroll-to-index');
    setNavigatedTurn(
      element.closest<HTMLElement>('.virtual-item-wrapper[data-turn-id]')?.dataset.turnId ?? null,
    );
    const range = findFlowChatFocusTextRange(element);
    if (range) revealContainedRange(range, scroller);
    const line = range && Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
    if (range && !line) return false;
    const readable = readableViewportBounds(scroller, inputOverlayInsetPx);
    const readableHeight = readable.bottom - readable.top;
    if (readableHeight <= 0) return false;
    const elementRect = element.getBoundingClientRect();
    // Long sources need reading room below their opening line. Short items can
    // fit at the center, but both use the same fade/input-safe area as search.
    const longSource = elementRect.height > readableHeight;
    const sourceTop = longSource ? line?.top ?? elementRect.top : elementRect.top;
    const targetTop = readable.top + (longSource
      ? readableHeight / 3
      : (readableHeight - elementRect.height) / 2);
    const topPx = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      scroller.scrollTop + sourceTop - targetTop));
    viewportAnchor.reanchorAfterNavigation();
    // Replace any earlier Turn/item aim so later measurements cannot pull the
    // opening line back beneath the top fade.
    virtualizer.scrollToOffset(topPx, {
      owner: 'one-shot-navigation',
      holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
    });
    return true;
  }, [exitFollowOutput, inputOverlayInsetPx, setNavigatedTurn, viewportAnchor, virtualItems, virtualizer]);

  const prepareTurnNavigation = useCallback((
    turnId: string,
    options?: TurnNavigationOptions,
  ): FlowChatTurnNavigationStatus => {
    if (!turnId || !activeSessionId) return 'rejected';
    historyPager.reset();
    exitFollowOutput('scroll-to-turn');
    preparedTurnNavigationRef.current = {
      turnId,
      behavior: options?.behavior ?? 'auto',
    };
    return 'pending';
  }, [activeSessionId, exitFollowOutput, historyPager]);

  useLayoutEffect(() => {
    const prepared = preparedTurnNavigationRef.current;
    if (!prepared) return;
    const status = navigateToTurnWithStatus(prepared.turnId, { behavior: prepared.behavior });
    if (status === 'settled') preparedTurnNavigationRef.current = null;
  }, [navigateToTurnWithStatus, virtualItems]);

  /**
   * Land on a Turn by its position in the transcript on screen.
   *
   * Instant, like the other two ways the same request can be resolved. This is
   * the last-resort branch of a focus request — `resolvedTurnId` and
   * `resolvedVirtualIndex` are tried first, both instant — and which branch runs
   * depends only on what the request happened to carry, not on anything the
   * reader did. Animating this one made the same usage-report click animate or
   * jump depending on whether the report knew the Turn's id.
   */
  const scrollToTurn = useCallback((turnIndex: number) => {
    const target = userMessageItems[turnIndex - 1];
    if (target) navigateToTurn(target.item.turnId, { behavior: 'auto' });
  }, [navigateToTurn, userMessageItems]);

  const scrollToIndex = useCallback((sourceIndex: number) => {
    const index = findTimelineBlockIndex(virtualItems, sourceIndex);
    if (index < 0 || index >= virtualItems.length) return;
    exitFollowOutput('scroll-to-index');
    setNavigatedTurn(virtualItems[index].turnId);
    virtualizer.scrollItemIntoView(index, {
      align: 'center',
      owner: 'one-shot-navigation',
      holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
    });
  }, [exitFollowOutput, setNavigatedTurn, virtualItems, virtualizer]);

  const scrollToTurnEnd = useCallback((turnId: string) => {
    let targetIndex = -1;
    for (let index = virtualItems.length - 1; index >= 0; index -= 1) {
      if (virtualItems[index]?.turnId === turnId) {
        targetIndex = index;
        break;
      }
    }
    const scroller = scrollerElementRef.current;
    const bounds = targetIndex < 0 ? null : virtualizer.getItemBounds(targetIndex);
    if (!bounds || !scroller) return false;
    // Deliberately does not exit follow-output. This is the session-open
    // placement, which wants the same position the tail follow is settling on;
    // releasing ownership here strands the viewport wherever this one early
    // shot landed, before item measurement and history paging have finished.
    //
    // Aligned by hand rather than by asking for the last item's end: the
    // virtualizer's own end alignment runs to the bottom of the scroll range,
    // and the resident tail spacer lives down there.
    virtualizer.scrollToOffset(bounds.endPx - scroller.clientHeight, {
      owner: 'follow-output',
    });
    return true;
  }, [virtualItems, virtualizer]);

  const isTurnRenderedInViewport = useCallback((turnId: string) => {
    const scroller = scrollerElementRef.current;
    const element = getRenderedUserMessageElement(turnId);
    return Boolean(scroller && element && isElementVisibleInScroller(element, scroller));
  }, [getRenderedUserMessageElement]);

  const isTurnTextRenderedInViewport = useCallback((turnId: string) => {
    const scroller = scrollerElementRef.current;
    const element = getRenderedUserMessageElement(turnId);
    return Boolean(
      scroller &&
      element &&
      element.textContent?.trim() &&
      isElementVisibleInScroller(element, scroller)
    );
  }, [getRenderedUserMessageElement]);

  const clearSearchMatch = useCallback(() => {
    searchNavigationRequestIdRef.current += 1;
    reader.set('navigation:thinking', '');
    virtualizer.cancelAim();
  }, [reader, virtualizer]);

  useEffect(() => () => reader.set('navigation:thinking', ''), [reader]);

  const scrollToSearchMatch = useCallback((target: FlowChatTextNavigationTarget) => {
    clearSearchMatch();
    if (target.flowItemId && target.expandableIds?.includes(target.flowItemId)) {
      reader.set('navigation:thinking', target.flowItemId);
    }
    exitFollowOutput('scroll-to-index');
    setNavigatedTurn(sourceItems[target.virtualItemIndex]?.turnId ?? null);
    const requestId = searchNavigationRequestIdRef.current;
    let attempts = 0;
    let materializing: number | null = null;
    const traceSkipped = (reason: string) => traceViewport({
      location: 'searchNavigation.skipped',
      message: 'search navigation kept the viewport at its reading position',
      data: () => ({
        reason,
        virtualItemIndex: target.virtualItemIndex,
        flowItemId: target.flowItemId,
        occurrenceIndex: target.occurrenceIndex ?? 0,
        scrollTopPx: roundViewportPx(scrollerElementRef.current?.scrollTop ?? 0),
      }),
    });
    const resolve = () => {
      if (searchNavigationRequestIdRef.current !== requestId) return;
      if (target.isCurrent && !target.isCurrent()) { virtualizer.cancelAim(); return; }
      attempts += 1;
      const retry = (reason: string) => {
        if (attempts < SEARCH_NAVIGATION_MAX_ATTEMPTS) requestAnimationFrame(resolve);
        else {
          if (materializing !== null) virtualizer.cancelAim();
          traceSkipped(reason);
          target.onUnavailable?.();
        }
      };
      const scroller = scrollerElementRef.current;
      if (!scroller) {
        traceSkipped('no-scroller');
        return;
      }
      const blockIndex = findTimelineBlockIndex(timelineItemsRef.current, target.virtualItemIndex, target.flowItemId);
      const targetBlock = timelineItemsRef.current[blockIndex]?.timeline;
      if (target.flowItemId && targetBlock?.kind === 'group-header') {
        const prefix = `group:${targetBlock.group!.groupId}:`;
        if (reader.get(`${prefix}query`, '') || reader.get(`${prefix}tool`, 'all') !== 'all'
          || reader.get(`${prefix}status`, 'all') !== 'all') {
          reader.set(`${prefix}query`, ''); reader.set(`${prefix}tool`, 'all'); reader.set(`${prefix}status`, 'all');
          retry('source-filter-cleared'); return;
        }
      }
      const wrapper = Array.from(
        scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper'),
      ).find(element => Number(element.dataset.virtualIndex) === blockIndex);
      if (!wrapper) {
        // Coarse item alignment is only for materializing an unmounted row.
        // A mounted hit can be resolved before any painted placement.
        if (blockIndex >= 0 && materializing !== blockIndex) {
          materializing = blockIndex;
          viewportAnchor.reanchorAfterNavigation();
          virtualizer.scrollItemIntoView(blockIndex, {
            align: 'center',
            owner: 'one-shot-navigation',
            holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
          });
        }
        retry('row-not-mounted');
        return;
      }
      for (const expandableId of target.expandableIds ?? []) {
        if (requestDeferredContentItem(wrapper, expandableId)) {
          retry('source-not-mounted');
          return;
        }
        const expandable = findElementWithDataValue(wrapper, 'data-tool-card-id', expandableId);
        if (expandable?.dataset.expanded === 'false' || expandable?.dataset.streamingExpanded === 'false') {
          if (expandable.hasAttribute('data-flow-group')) {
            // Compatibility groups still own a local disclosure. This scoped
            // activation belongs to navigation, not a new reader gesture.
            isExpandingSearchSourceRef.current = true;
            try { expandable.querySelector<HTMLElement>('[data-openbitfun-part="header"][role="button"]')?.click(); }
            finally { isExpandingSearchSourceRef.current = false; }
          }
          retry('source-not-expanded');
          return;
        }
      }
      if (requestDeferredContentItem(wrapper, target.flowItemId ?? target.excerpt?.fragments[0]?.flowItemId)) {
        retry('source-not-mounted');
        return;
      }
      const root = target.excerpt
        ? findExcerptSource(wrapper, target.excerpt.fragments[0])
        : getFlowChatSearchTextRoot(wrapper, target.flowItemId);
      if (!root) {
        retry('source-not-mounted');
        return;
      }
      const ranges = target.excerpt ? [] : findFlowChatSearchTextRanges(root, target.query);
      const rangeIndex = Math.min(target.occurrenceIndex ?? 0, Math.max(0, ranges.length - 1));
      const range = target.excerpt ? resolveExcerptRange(root, target.excerpt.fragments[0]) : ranges[rangeIndex] ?? null;
      if (range) revealContainedRange(range, wrapper);
      // Use the same first painted line as the passive current-line marker.
      const rangeRect = range && Array.from(range.getClientRects())
        .find(rect => rect.width > 0 && rect.height > 0);
      if (!rangeRect) {
        retry('text-not-painted');
        return;
      }
      // Read the design-system spacing used by the scroller's edge masks.
      // The floating input and its fade are outside the readable viewport.
      const { top: readableTop, bottom: readableBottom } = readableViewportBounds(scroller, inputOverlayInsetPx);
      if (readableBottom <= readableTop) {
        if (materializing !== null) virtualizer.cancelAim();
        traceSkipped('no-readable-area');
        return;
      }
      if (target.excerpt && range) {
        const clear = highlightExcerptRange(range);
        window.setTimeout(clear, 1800);
      }
      if (rangeRect.top >= readableTop && rangeRect.bottom <= readableBottom) {
        if (materializing !== null) virtualizer.cancelAim();
        traceSkipped('already-readable');
        return;
      }

      // Replacing the item aim through the virtualizer prevents its later
      // remeasurements from pulling the viewport back to the row's center.
      viewportAnchor.reanchorAfterNavigation();
      const topPx = Math.max(0, Math.min(
        scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + (rangeRect.top + rangeRect.bottom) / 2
          - (readableTop + readableBottom) / 2,
      ));
      virtualizer.scrollToOffset(topPx, {
        owner: 'one-shot-navigation',
        holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
      });
    };
    resolve();
  }, [clearSearchMatch, exitFollowOutput, inputOverlayInsetPx, setNavigatedTurn, viewportAnchor, sourceItems, reader, virtualizer]);

  const requestHistoryBoundary = useCallback((direction: SessionHistoryWindowDirection) => {
    const opening = isOpeningViewport();
    const following = isFollowingOutputNow();
    // Opening/follow placements are not reader demand. Keep the initial ask
    // available until their ownership ends, as before.
    if (opening || following || !onHistoryWindowBoundaryIntent) {
      const reason = opening ? 'opening-reveal' : following ? 'follow-output-owns-the-viewport' : 'no-handler';
      traceViewportRepeating(`paging|${direction}|${reason}`, {
        location: 'historyPaging.refused',
        message: 'history paging is waiting for viewport ownership or a handler',
        data: () => ({ direction, viewportId, reason }),
      });
      return;
    }
    const ticket = historyPager.begin(direction);
    if (!ticket) {
      traceViewportRepeating(`paging|${direction}|${historyPager.snapshot(direction).phase}`, {
        location: 'historyPaging.refused',
        message: 'history paging is waiting for its request, layout, or reader',
        data: () => ({ direction, ...historyPager.snapshot(direction) }),
      });
      return;
    }
    traceViewport({
      location: 'historyPaging.asked',
      message: 'reader demand dispatched a history page',
      data: () => ({ direction, viewportId, requestId: ticket.id }),
    });
    // Reserve the ticket before invoking: even a synchronous callback/re-entry
    // cannot dispatch it twice. Rejections and synchronous throws share cleanup.
    void Promise.resolve().then(() => historyPager.isCurrent(ticket)
      ? onHistoryWindowBoundaryIntent(direction, {
        prepareViewportForPresentationCommit: () => historyPager.prepareCommit(ticket),
      })
      : 'cancelled' as const).then(normalizeBoundaryResult).catch(() => 'not-ready' as const).then(result => {
      const accepted = historyPager.finish(ticket, result);
      traceViewport({
        location: 'historyPaging.completed',
        message: accepted ? 'history page result accepted' : 'obsolete history page result ignored',
        data: () => ({ direction, completedRequestId: ticket.id, result, ...historyPager.snapshot(direction) }),
      });
      if (accepted && result === 'applied') {
        // Also covers a page that was already projected: the acknowledgement
        // commits after the parent's presentation updates, without a timer.
        acknowledgeHistoryPage(revision => revision + 1);
      }
    });
  }, [historyPager, isFollowingOutputNow, isOpeningViewport, onHistoryWindowBoundaryIntent, viewportId]);

  /**
   * Whether either end of the loaded transcript is on screen, and act on it.
   *
   * Reads live geometry rather than the rendered window. The window carries
   * overscan and, for a transcript short enough to render whole, reports the
   * first and last item as present wherever the viewport is — which makes it
   * mute on the only question being asked. Measured: a 21-item transcript
   * rendered 21 rows from index 0 no matter where the reader stood, so the
   * head boundary read as reached forever and the tail never re-armed.
   *
   * A scroll moves the viewport across the window without changing it, so this
   * has to be a callback that both the scroll handler and the item-change
   * effect can invoke, rather than a value either of them derives.
   */
  const readHistoryBoundaryProximity = useCallback((): HistoryBoundaryProximity | null => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return null;
    const head = virtualizer.getItemBounds(0);
    const tail = virtualizer.getItemBounds(virtualItems.length - 1);
    if (!head || !tail) return null;
    return {
      aboveViewportPx: scroller.scrollTop - head.startPx,
      belowViewportPx: tail.endPx - (scroller.scrollTop + scroller.clientHeight),
      viewportHeightPx: scroller.clientHeight,
    };
  }, [virtualItems.length, virtualizer]);

  const evaluateHistoryBoundaries = useCallback(() => {
    const range = virtualizer.getVisibleItemRange();
    if (!range) {
      /*
       * No row intersects the viewport, so there is no reader position to
       * derive a boundary from. That is a real state and not a degenerate one:
       * a transcript shorter than the viewport puts the whole scroll range
       * inside the reserved blank, and the bottom of it shows no Turn at all.
       *
       * Traced because the silence was the hard part to read. A session stuck
       * here logged nothing for seven seconds while the reader kept scrolling,
       * and the only way to tell "nobody asked" from "the ask was refused" was
       * the absence of an anchor capture.
       */
      traceViewportRepeating('paging|no-visible-range', {
        location: 'historyPaging.noVisibleRange',
        message: 'no row is in the viewport, so there is no boundary to judge',
        data: () => ({
          itemCount: virtualItems.length,
          scrollTopPx: roundViewportPx(scrollerElementRef.current?.scrollTop ?? 0),
        }),
      });
      return;
    }
    // Prefetch proximity decides the ask; geometry alone creates no demand.
    const proximity = readHistoryBoundaryProximity();
    const asking = new Set(historyBoundariesForVisibleRange(
      range,
      virtualItems.length,
      presentationMode,
      proximity,
    ));
    historyPager.observeProximity(asking);
    for (const direction of HISTORY_WINDOW_DIRECTIONS) {
      if (asking.has(direction)) requestHistoryBoundary(direction);
    }
  }, [
    historyPager,
    presentationMode,
    readHistoryBoundaryProximity,
    requestHistoryBoundary,
    virtualItems.length,
    virtualizer,
  ]);

  // Deliberately after prepend compensation and prepared navigation effects.
  // Run for every commit: request completion can follow the content commit.
  useLayoutEffect(() => {
    if (isViewportSuspendedRef.current) return;
    historyPager.commitLayout(windowBoundsKey, {
      before: virtualItems[0] ? getVirtualItemStableKey(virtualItems[0]) : null,
      after: virtualItems.length ? getVirtualItemStableKey(virtualItems[virtualItems.length - 1]) : null,
    });
    // Content replacement can clamp native scrollTop. That is not user travel.
    const layoutKey = `${windowBoundsKey}:${virtualItems.length}:${virtualItems[0] ? getVirtualItemStableKey(virtualItems[0]) : ''}`;
    if (pagingLayoutKeyRef.current !== layoutKey) {
      pagingLayoutKeyRef.current = layoutKey;
      readerScrollPositionRef.current = viewportOwner.readReaderScrollPosition();
    }
  });

  evaluateHistoryBoundariesRef.current = evaluateHistoryBoundaries;

  useEffect(() => {
    scheduleVisibleTurnInfoUpdate();
    evaluateHistoryBoundaries();
  }, [
    evaluateHistoryBoundaries,
    historyPageRevision,
    /*
     * Follow-output releasing the viewport is a reason to ask again, not only a
     * reason the last ask was declined.
     */
    isFollowingOutput,
    /*
     * And so is the transcript finishing its opening placement, for the same
     * reason: the ask that the reveal refused above is owed a second chance,
     * and this is the only thing that changes when the reveal ends. A session
     * whose loaded tail is shorter than one viewport produces no scroll events
     * at all — it has nowhere to scroll — so without this it would never page
     * its older Turns in until the reader spun the wheel against a boundary
     * that could not move.
     */
    isOpenViewportSettled,
    scheduleVisibleTurnInfoUpdate,
    virtualizer.rows,
  ]);

  useLayoutEffect(() => {
    scheduleVisibleTurnInfoUpdate();
  }, [isFollowingOutput, scheduleVisibleTurnInfoUpdate, virtualItems]);

  useEffect(() => {
    if (userMessageItems.length === 0) {
      modernStore.getState().setVisibleTurnInfo(null);
    }
  }, [modernStore, userMessageItems.length]);

  const handleScrollerRef = useCallback((element: HTMLElement | null) => {
    const scroller = element;
    scrollerElementRef.current = scroller;
    setScrollerElement(scroller);
    if (scroller) {
      updateIsAtScrollStart();
      if (!scroller.hasAttribute('tabindex')) {
        scroller.tabIndex = -1;
      }
      const initialViewportBox = {
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      };
      if (isUsableFlowChatViewportRect(initialViewportBox)) {
        setViewportHeightPx(initialViewportBox.height);
        setViewportWidthPx(initialViewportBox.width);
        // Seed the box so the observer's first callback is not read as a resize.
        observedViewportBoxRef.current = initialViewportBox;
      }
    }
  }, [updateIsAtScrollStart]);

  const scrollToPhysicalBottom = useCallback(() => {
    historyPager.reset();
    setNavigatedTurn(null);
    enterFollowOutput('jump-to-latest');
    updateIsAtBottom();
  }, [enterFollowOutput, historyPager, setNavigatedTurn, updateIsAtBottom]);

  const scrollToLatestEndPosition = useCallback(() => {
    historyPager.reset();
    onUserScrollIntent?.();
    setNavigatedTurn(null);
    enterFollowOutput('jump-to-latest');
    // Entering follow can leave the viewport exactly where it is, which
    // produces no scroll event to recompute the band from.
    updateIsAtBottom();
  }, [enterFollowOutput, historyPager, onUserScrollIntent, setNavigatedTurn, updateIsAtBottom]);

  useImperativeHandle(ref, () => ({
    scrollToTurn,
    scrollToIndex,
    scrollToSearchMatch,
    notifyUserSelectionIntent: () => readerInteractionRef.current('selection'),
    clearSearchMatch,
    scrollToPhysicalBottom,
    scrollToTurnEnd,
    isTurnRenderedInViewport,
    isTurnTextRenderedInViewport,
    scrollToLatestEndPosition,
    navigateToTurn,
    navigateToTurnWithStatus,
    prepareTurnNavigation,
    focusFlowItem,
    captureViewportSnapshot,
    restoreViewportSnapshot,
  }), [
    captureViewportSnapshot,
    clearSearchMatch,
    focusFlowItem,
    isTurnRenderedInViewport,
    isTurnTextRenderedInViewport,
    navigateToTurn,
    navigateToTurnWithStatus,
    prepareTurnNavigation,
    scrollToIndex,
    scrollToLatestEndPosition,
    scrollToPhysicalBottom,
    scrollToSearchMatch,
    scrollToTurn,
    scrollToTurnEnd,
    restoreViewportSnapshot,
  ]);

  const visibleTurnInfo = useModernFlowChatStore(state => state.visibleTurnInfo);
  const handleJumpToCurrentTurn = useCallback(() => {
    if (visibleTurnInfo?.turnId) {
      navigateToTurn(visibleTurnInfo.turnId, {
        behavior: getMotionAwareScrollBehavior('smooth'),
      });
    }
  }, [navigateToTurn, visibleTurnInfo?.turnId]);
  const { shouldShowButton: shouldShowTurnHeaderButton, handleClick: handleTurnHeaderClick } =
    useScrollToTurnHeader({
      scrollerRef: scrollerElementRef,
      currentTurnId: visibleTurnInfo?.turnId ?? null,
      currentTurnIndex: visibleTurnInfo?.turnIndex ?? 0,
      visibleTurnInfo,
      onJumpToCurrentTurn: handleJumpToCurrentTurn,
    });
  const previousHistoryBoundaryStatusNode = useMemo(() => (
    historyBoundaryState.before !== 'idle' ? (
      <FlowChatHistoryPagingSentinel
        state={historyBoundaryState.before}
        label={historyBoundaryState.before === 'error'
          ? t('historyState.olderHistoryNotReady')
          : t('historyState.preparingOlderHistory')}
      />
    ) : null
  ), [historyBoundaryState.before, t]);
  const nextHistoryBoundaryStatusNode = useMemo(() => (
    presentationMode === 'history-window' && historyBoundaryState.after !== 'idle' ? (
      <FlowChatHistoryPagingSentinel
        state={historyBoundaryState.after}
        /*
         * By state, like the boundary above it. One label for both read as
         * history being prepared forever whenever a page failed, which is the
         * one case where the reader is owed the opposite of "hold on".
         */
        label={historyBoundaryState.after === 'error'
          ? t('historyState.newerHistoryNotReady')
          : t('historyState.loadingDescription')}
      />
    ) : null
  ), [historyBoundaryState.after, presentationMode, t]);

  if (virtualItems.length === 0) {
    return (
      <div
        data-openbitfun-component="virtual-message-list"
        data-openbitfun-part="root"
        data-openbitfun-state="empty"
        className="virtual-message-list virtual-message-list--empty"
        data-testid="flowchat-message-list-empty"
      >
        <div className="empty-state" data-openbitfun-component="virtual-message-list" data-openbitfun-part="empty">
          <p data-openbitfun-component="virtual-message-list" data-openbitfun-part="emptyMessage">No messages yet</p>
        </div>
      </div>
    );
  }

  return (
    <FlowChatReaderProvider store={reader}>
    <TimelineMutationBoundary itemKeys={prependItemKeys} scrollerRef={scrollerElementRef}
      canRepair={() => !isViewportSuspendedRef.current && !isViewportOwnedElsewhere()} shift={viewportOwner.shift}
      snapshotAnchor={snapshotLeadingExtent}
      onRepaired={viewportAnchor.captureAnchor}>
    <FlowChatPrependSnapshot itemKeys={prependItemKeys} scrollerRef={scrollerElementRef} snapshotRef={prependSnapshotRef}>
    <FlowChatOpeningBoundary
      data-openbitfun-component="virtual-message-list"
      data-openbitfun-part="root"
      className="virtual-message-list"
      data-testid="flowchat-message-list"
      data-presentation-mode={presentationMode}
      data-viewport-mode={viewportMode}
      data-streaming-output={isStreamingOutput ? 'true' : 'false'}
      data-open-viewport-settled={isOpenViewportSettled ? 'true' : 'false'}
      opening={!isOpenViewportSettled}
    >
      <div
        ref={handleScrollerRef}
        className="virtual-message-list__scroller"
        data-flowchat-scroller="true"
        data-testid="flowchat-scroller"
        data-openbitfun-viewport-inset-bottom={inputOverlayInsetPx}
        style={{
          '--_flow-chat-input-overlay-inset': `${inputOverlayInsetPx}px`,
        } as React.CSSProperties}
      >
        <div className="virtual-message-list__extent" ref={extentElementRef}>
        <FlowChatListHeader
          ref={headerElementRef}
          previousHistoryBoundaryStatusNode={previousHistoryBoundaryStatusNode}
        />
        {/*
          The window of rendered items, with the rest of the transcript standing
          in as padding above and below. Items stay in normal flow so that one
          growing reflows the ones under it in the same layout pass.
        */}
        <div
          className="virtual-message-list__items"
          data-openbitfun-component="virtual-message-list"
          data-openbitfun-part="items"
          data-testid="flowchat-item-list"
          style={{
            paddingTop: `${virtualizer.paddingTopPx}px`,
            paddingBottom: `${virtualizer.paddingBottomPx}px`,
          }}
        >
          {virtualizer.rows.map((row, rowIndex) => {
            const item = virtualItems[row.index];
            const nextItem = virtualItems[nextVisibleItemIndexes[row.index]];
            return (
              <React.Fragment key={row.key}>
              {rowIndex > 0 && row.startPx > virtualizer.rows[rowIndex - 1].endPx &&
                <div aria-hidden="true" style={{ height: row.startPx - virtualizer.rows[rowIndex - 1].endPx }} />}
              <VirtualItemRenderer
                key={row.key}
                item={item}
                index={row.index}
                isLatestTurn={item.turnId === latestTurnId}
                endsBeforeUserTurn={nextItem?.type === 'user-message'}
                continuesAmbientToolRunAfter={isAmbientToolRunContinuationAfter(item, nextItem, pendingPermissionToolCallIds)}
                measureRef={virtualizer.measureRowElement}
              />
              </React.Fragment>
            );
          })}
        </div>
        <FlowChatListFooter
          bottomLayoutInsetPx={bottomLayoutInsetPx}
          tailSpacerPx={tailSpacerPx}
          nextHistoryBoundaryStatusNode={nextHistoryBoundaryStatusNode}
          runtimeStatusSessionId={activeSessionId}
        />
        </div>
      </div>

      <ScrollToTurnHeaderButton
        visible={shouldShowTurnHeaderButton}
        onClick={handleTurnHeaderClick}
        turnLabel={visibleTurnInfo ? `Turn ${visibleTurnInfo.turnIndex}` : undefined}
      />
      <ScrollToLatestBar
        visible={(viewportMode === 'history-reading' || !isAtBottom) && virtualItems.length > 0}
        onClick={viewportMode === 'history-reading' && onRequestJumpToLatest
          ? onRequestJumpToLatest
          : scrollToLatestEndPosition}
        focusReturnRef={scrollerElementRef}
        inputHeight={inputHeight}
      />
    </FlowChatOpeningBoundary>
    </FlowChatPrependSnapshot>
    </TimelineMutationBoundary>
    </FlowChatReaderProvider>
  );
});

VirtualMessageListSession.displayName = 'VirtualMessageListSession';

export const VirtualMessageList = forwardRef<VirtualMessageListRef, VirtualMessageListProps>((props, ref) => {
  const activeSession = useActiveSession();
  return <VirtualMessageListSession key={activeSession?.sessionId ?? 'no-active-session'} ref={ref} {...props} />;
});

VirtualMessageList.displayName = 'VirtualMessageList';
