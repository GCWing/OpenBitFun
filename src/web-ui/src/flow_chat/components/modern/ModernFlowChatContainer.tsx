import { captureConfirmationAnchor } from '@openbitfun/ui';
import { globalEventBus } from '@/infrastructure/event-bus';
import { requireSessionOwningWorkspaceId } from '../../utils/sessionOrdering';
/**
 * Modern FlowChat container.
 * Uses virtual scrolling with Zustand and syncs legacy store state.
 */

import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect, useState, useSyncExternalStore, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import {
  VirtualMessageList,
  type FlowChatTurnNavigationStatus,
  type HistoryWindowBoundaryIntentResult,
  type HistoryWindowBoundaryIntentOptions,
  type VirtualMessageListRef,
} from './VirtualMessageList';
import {
  FlowChatHeader,
  type FlowChatHeaderCommandSummary,
} from './FlowChatHeader';
import type { SessionTreeSelection } from './SessionTreePopover';
import { FlowChatTurnRail, type FlowChatTurnRailItem } from './FlowChatTurnRail';
import { composerPresentationToTurnRailPreview, parseComposerPresentation } from '../../utils/composerPresentation';
import { BackgroundCommandInputDialog } from '../background-command/BackgroundCommandInputDialog';
import { WelcomePanel } from '../WelcomePanel';
import { HistorySessionPlaceholder } from './HistorySessionPlaceholder';
import { PeerUpdatesPausedNotice } from './PeerUpdatesPausedNotice';
import { HistorySessionLoadingBoundary } from './HistorySessionLoadingBoundary';
import {
  FlowChatContext,
  FlowChatContextValue,
  FlowChatVolatileContext,
  FlowChatVolatileContextValue,
} from './FlowChatContext';
import { useFlowGroupState } from './useFlowGroupState';
import { useFlowChatFileActions } from './useFlowChatFileActions';
import { useFlowChatNavigation } from './useFlowChatNavigation';
import { useFlowChatCopyDialog } from './useFlowChatCopyDialog';
import { useFlowChatSync } from './useFlowChatSync';
import { useFlowChatToolActions } from './useFlowChatToolActions';
import { useFlowChatSearch } from './useFlowChatSearch';
import { TrajectoryExplorer, type TrajectoryExplorerRef, type TrajectorySearchState, type TrajectorySelection } from '../../trajectory/TrajectoryExplorer';
import { trajectoryNodeKey } from '../../trajectory/trajectoryModel';
import { TRAJECTORY_NAVIGATE_EVENT, type TrajectoryPanelData, showTrajectoryRange } from '../../trajectory/trajectoryPanel';
import type { TrajectoryRangeSummary } from '../../trajectory/trajectoryRange';
import { useTrajectoryNavigation } from '../../trajectory/useTrajectoryNavigation';
import {
  createSessionVirtualItemProjector,
  useVirtualItems,
  useActiveSession,
  useVisibleTurnInfo,
  type VirtualItem,
  type VisibleTurnInfo,
} from '../../store/modernFlowChatStore';
import type { DialogTurn, Session, SessionHistoryPresentation } from '../../types/flow-chat';
import type { SessionHistoryWindowDirection } from '../../store/FlowChatStore';
import {
  FLOWCHAT_MESSAGE_SUBMITTED_EVENT,
  type FlowChatFocusItemRequest,
  type FlowChatMessageSubmittedRequest,
} from '../../events/flowchatNavigation';
import {
  useBackgroundCommandActivityStore,
  visibleBackgroundCommandActivitiesForSession,
  type BackgroundCommandActivity,
} from '../../store/backgroundCommandActivityStore';
import {
  useBackgroundSubagentActivityStore,
} from '../../store/backgroundSubagentActivityStore';
import { type LineRange } from '@/shared/editor/LineRange';
import { useConversationViewScope } from '../../contexts/conversationViewScope';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { flowChatSessionConfigForCurrentWorkspace } from '@/app/utils/projectSessionWorkspace';
import { createLogger } from '@/shared/utils/logger';
import { createBackgroundCommandOutputTab } from '@/shared/utils/tabUtils';
import { useFlowChatHttpLinkClick } from './useFlowChatHttpLinkClick';
import { isAcpFlowSession } from '../../utils/acpSession';
import { flowChatStore } from '../../store/FlowChatStore';
import { openBtwSessionInAuxPane } from '../../services/btwSessionPane';
import { FlowChatSelectionBar } from '../../selection/FlowChatSelectionBar';
import { ConversationExcerptSourceProvider } from '../../selection/ConversationExcerptSources';
import { hasActiveSessionLineageDescendants } from '../../utils/sessionLineage';
import {
  findDialogTurn,
  shouldUseLatestTurnFollowOutput,
} from '../../utils/flowChatTurnScrollPolicy';
import { isRemoteTraceContext, startupTrace } from '@/shared/utils/startupTrace';
import { scheduleAfterStartupPaint } from '@/shared/utils/startupTaskScheduling';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { notificationService } from '@/shared/notification-system';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { getActiveSurfaceScope, isLocalSurface, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { deleteSessionTreeBranch } from '../../services/deleteSessionTreeBranch';
import { resolveSessionDriverId } from '../../session-drivers/resolve';
import {
  clearHistorySessionOpenTransition,
  getHistorySessionOpenTransitionSnapshot,
  hasRenderableSessionContent,
  HISTORY_SESSION_OPEN_INTENT_EVENT,
  subscribeHistorySessionOpenTransition,
  type HistorySessionOpenIntentDetail,
} from '../../services/sessionOpenIntent';
import {
  recordHistoryPagingEvent,
  recordHistorySessionDiagnosticEvent,
  warnHistoryPagingRefusedWithPendingTurns,
  warnHistorySessionLoadingLayerStalled,
} from '../../services/historySessionDiagnostics';
import {
  resolveHistoryBoundaryTarget,
  resolveTailBoundaryPrecondition,
  resolveTailWindowGrowth,
  transcriptReachesLatestTurn,
  type RenderedTranscriptRange,
} from './flowChatLiveTailWindow';
import './ModernFlowChatContainer.scss';
import { pendingPermissionToolCallIdsForSession } from './permissionRequestRouting';
import { usePermissionRequests } from './usePermissionRequests';
import {
  buildContinuousHistoryProjection,
  canRetainContinuousHistoryProjection,
} from './continuousHistoryProjection';
import {
  projectedSessionTurnCount,
} from '../../utils/flowChatTurnIdentity';
import { createFlowChatTurnSummaryProjector, type FlowChatTurnSummary } from './flowChatTurnSummaries';
import type { FlowChatViewportSnapshot } from './flowChatViewportSnapshot';
import { peekConversationViewTransfer, registerConversationReader, takeConversationViewTransfer } from './flowChatViewHandoff';
import { getSubmittedMessagePreviews, subscribeSubmittedMessagePreviews } from '../../services/submittedMessagePresentation';

const log = createLogger('ModernFlowChatContainer');

interface ModernFlowChatContainerProps {
  className?: string;
  isViewportActive?: boolean;
  /** The hosting pane is being resized; width-derived measurement waits for it to settle. */
  resizeSuspended?: boolean;
  /** Preferred reading-column width; invalidates cached row heights on change. */
  contentWidth?: number;
  /** Whether the host-owned session right panel is open. */
  isRightPanelOpen?: boolean;
  /** Toggle the host-owned session right panel. */
  onToggleRightPanel?: () => void;
  /** Host-owned replacement for the ordinary new-session WelcomePanel. */
  emptyState?: React.ReactNode;

  // Host-owned file, tab, and visualization actions.
  onFileViewRequest?: (filePath: string, fileName: string, lineRange?: LineRange) => void;
  onTabOpen?: (tabInfo: any, sessionId?: string, panelType?: string) => void;
  onOpenVisualization?: (type: string, data: any) => void;
}

interface FlowChatHistoryPresentationState extends SessionHistoryPresentation {
  sessionId: string;
  revision: number;
}

export interface SessionViewportState {
  snapshot: FlowChatViewportSnapshot | null;
  historyPresentation: Omit<FlowChatHistoryPresentationState, 'turns'> | null;
  viewportIntent: FlowChatViewportIntent | null;
}

function historyBookmark(presentation: SessionViewportState['historyPresentation']): SessionViewportState['historyPresentation'] {
  return presentation ? {
    sessionId: presentation.sessionId, revision: presentation.revision, range: { ...presentation.range },
  } : null;
}

type FlowChatViewportIntent =
  | {
      kind: 'live-tail';
      sessionId: string;
    }
  | {
      kind: 'turn';
      sessionId: string;
      ordinal: number;
      turnId: string | null;
      source: 'canonical-tail' | 'history-range';
    };

interface QueuedTurnNavigation {
  ordinal: number;
  turnId: string | null;
}

type FlowChatHistoryBoundaryState = Record<
  SessionHistoryWindowDirection,
  'idle' | 'loading' | 'error'
>;

const IDLE_HISTORY_BOUNDARY_STATE: FlowChatHistoryBoundaryState = {
  before: 'idle',
  after: 'idle',
};

type BackgroundCommandSummary = {
  execSessionKey: string;
  execSessionId: number;
  title: string;
  command: string;
  status: 'running' | 'exited' | 'interrupted' | 'killed' | 'pruned' | 'failed';
  remote?: boolean;
  tty?: boolean;
  exitCode?: number;
  startedAt?: number;
  elapsedMs?: number;
  isStopping?: boolean;
};

const LATEST_TURN_AUTO_PIN_MAX_ATTEMPTS = 8;
const NO_VISIBLE_TURN_IDS: readonly string[] = [];

/**
 * A rail entry's capsule preview, parsed once per stored presentation.
 * Stored presentations are immutable records, so their identity is enough.
 */
const turnRailPreviews = new WeakMap<object, FlowChatTurnRailItem['capsulePreview'] | null>();
function turnRailPreviewFor(turn: DialogTurn | undefined): FlowChatTurnRailItem['capsulePreview'] {
  const value: unknown = turn?.userMessage?.metadata?.composerPresentation;
  if (!value || typeof value !== 'object') return undefined;
  let preview = turnRailPreviews.get(value);
  if (preview === undefined) {
    preview = composerPresentationToTurnRailPreview(parseComposerPresentation(value)) ?? null;
    turnRailPreviews.set(value, preview);
  }
  return preview ?? undefined;
}

/** Streaming replaces Turn objects without changing anything the rail reads. */
function sameTurnRailSources(left: readonly DialogTurn[], right: readonly DialogTurn[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index], b = right[index];
    if (a === b) continue;
    if (a.id !== b.id
      || a.userMessage?.content !== b.userMessage?.content
      || a.userMessage?.metadata?.composerPresentation !== b.userMessage?.metadata?.composerPresentation) return false;
  }
  return true;
}
const HISTORY_LOADING_LAYER_STALL_WARN_MS = 800;
const TURN_PIN_RETRY_MAX_ATTEMPTS = 120;
const MOCK_BACKGROUND_COMMANDS_STORAGE_KEY = 'openbitfun.flowChat.mockBackgroundCommands';

const MOCK_BACKGROUND_COMMANDS: BackgroundCommandSummary[] = [
  {
    execSessionKey: 'mock:interactive-input',
    execSessionId: 4216,
    title: 'node interactive-test.js',
    command: 'node interactive-test.js',
    status: 'running',
    remote: false,
    tty: true,
    startedAt: Date.now() - 24_000,
    elapsedMs: 24_000,
  },
  {
    execSessionKey: 'mock:test',
    execSessionId: 4217,
    title: 'cargo test -p terminal-core lifecycle_reports_running_and_natural_exit',
    command: 'cargo test -p terminal-core lifecycle_reports_running_and_natural_exit',
    status: 'running',
    remote: false,
    tty: true,
    startedAt: Date.now() - 42_000,
    elapsedMs: 42_000,
  },
  {
    execSessionKey: 'mock:build',
    execSessionId: 4218,
    title: 'pnpm run desktop:dev -- --profile heavy-ui-check',
    command: 'pnpm run desktop:dev -- --profile heavy-ui-check',
    status: 'running',
    remote: true,
    tty: true,
    startedAt: Date.now() - 96_000,
    elapsedMs: 96_000,
  },
  {
    execSessionKey: 'mock:finished',
    execSessionId: 4219,
    title: 'node scripts/i18n-audit.mjs',
    command: 'node scripts/i18n-audit.mjs',
    status: 'exited',
    remote: false,
    tty: false,
    exitCode: 0,
    startedAt: Date.now() - 14_000,
    elapsedMs: 13_400,
  },
];

function shouldShowMockBackgroundCommands(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return (
    (params.get('mockBackgroundCommands') === '1' || params.get('mockBackgroundActivities') === '1') ||
    window.localStorage?.getItem(MOCK_BACKGROUND_COMMANDS_STORAGE_KEY) === '1'
  );
}

function commandTitle(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}...` : trimmed;
}

function backgroundCommandSummaryFromActivity(activity: BackgroundCommandActivity): BackgroundCommandSummary {
  const endedAt = activity.endedAtMs;
  return {
    execSessionKey: activity.execSessionKey,
    execSessionId: activity.execSessionId,
    title: commandTitle(activity.command),
    command: activity.command,
    status: activity.status,
    remote: activity.remote,
    tty: activity.tty,
    exitCode: activity.exitCode,
    startedAt: activity.startedAtMs,
    elapsedMs: (activity.status === 'running' ? Date.now() : endedAt ?? Date.now()) - activity.startedAtMs,
  };
}

export const ModernFlowChatContainer: React.FC<ModernFlowChatContainerProps> = ({
  className = '',
  isViewportActive = true,
  resizeSuspended = false,
  contentWidth,
  isRightPanelOpen = false,
  onToggleRightPanel,
  emptyState,
  onFileViewRequest,
  onTabOpen,
  onOpenVisualization,
}) => {
  const { t } = useTranslation('flow-chat');
  const canonicalVirtualItems = useVirtualItems();
  const activeSession = useActiveSession();
  const [projectContinuousHistory] = useState(createSessionVirtualItemProjector);
  const [projectHistory] = useState(createSessionVirtualItemProjector);
  const surfaceScope = getActiveSurfaceScope();
  useLayoutEffect(() => activeSession?.sessionId
    ? flowChatStore.retainSessionHistory(activeSession.sessionId)
    : undefined, [activeSession?.sessionId, surfaceScope.epoch]);
  const submittedPreviews = useSyncExternalStore(
    subscribeSubmittedMessagePreviews,
    () => getSubmittedMessagePreviews(surfaceScope, activeSession?.sessionId ?? ''),
    () => getSubmittedMessagePreviews(surfaceScope, ''),
  );
  const [historyPresentation, setHistoryPresentation] = useState<FlowChatHistoryPresentationState | null>(null);
  const [historyRestore, setHistoryRestore] = useState<{ sessionId: string; status: 'loading' | 'failed' } | null>(null);
  const [historyRestoreRetry, setHistoryRestoreRetry] = useState(0);
  const [viewportIntent, setViewportIntent] = useState<FlowChatViewportIntent | null>(null);
  const [continuousProjectionSessionId, setContinuousProjectionSessionId] = useState<string | null>(null);
  const [historyBoundaryState, setHistoryBoundaryState] = useState<FlowChatHistoryBoundaryState>(
    IDLE_HISTORY_BOUNDARY_STATE,
  );
  const historyPresentationRef = useRef<FlowChatHistoryPresentationState | null>(null);
  const viewportIntentRef = useRef<FlowChatViewportIntent | null>(null);
  const updateViewportIntent = useCallback((next: FlowChatViewportIntent | null) => {
    viewportIntentRef.current = next;
    setViewportIntent(next);
  }, []);
  const historyBoundaryRequestsRef = useRef<Record<
    SessionHistoryWindowDirection,
    Promise<HistoryWindowBoundaryIntentResult> | null
  >>({
    before: null,
    after: null,
  });
  const historyPresentationOwnerGenerationRef = useRef(0);
  const invalidateHistoryPresentationOwner = useCallback(() => {
    // A superseded restore can no longer clear its own status. Transfer the
    // loading state together with ownership, before discarding its reply.
    historyPresentationOwnerGenerationRef.current += 1;
    setHistoryRestore(null);
  }, []);
  const activeHistoryPresentation = historyPresentation?.sessionId === activeSession?.sessionId
    ? historyPresentation
    : null;
  const activeViewportIntent = viewportIntent?.sessionId === activeSession?.sessionId
    ? viewportIntent
    : null;
  const activeSessionKnownTurnCount = activeSession
    ? projectedSessionTurnCount(activeSession)
    : 0;
  const activeHistoryPresentationFitsSession = Boolean(
    activeHistoryPresentation
    && activeHistoryPresentation.range.endOrdinalExclusive <= activeSessionKnownTurnCount
  );
  const isShowingHistoryPresentation = Boolean(
    activeHistoryPresentation
    && activeHistoryPresentationFitsSession
    && activeViewportIntent?.kind === 'turn'
    && activeViewportIntent.source === 'history-range'
  );
  const isReadingTurnViewport = activeViewportIntent?.kind === 'turn';
  const canonicalizedHistoryPresentation = useMemo(() => {
    if (!activeSession || !activeHistoryPresentation) {
      return null;
    }

    const canonicalTurnById = new Map(
      activeSession.dialogTurns.map(turn => [turn.id, turn]),
    );
    let changed = false;
    const turns = activeHistoryPresentation.turns.map(turn => {
      const canonicalTurn = canonicalTurnById.get(turn.id);
      if (!canonicalTurn || canonicalTurn === turn) {
        return turn;
      }
      changed = true;
      return canonicalTurn;
    });
    return changed
      ? { ...activeHistoryPresentation, turns }
      : activeHistoryPresentation;
  }, [activeHistoryPresentation, activeSession]);
  const continuousHistoryPresentation = useMemo(() => {
    if (!activeSession || !canonicalizedHistoryPresentation) {
      return null;
    }
    const presentation = buildContinuousHistoryProjection(
      activeSession,
      canonicalizedHistoryPresentation,
    );
    return presentation ? {
      ...presentation,
      sessionId: canonicalizedHistoryPresentation.sessionId,
      revision: canonicalizedHistoryPresentation.revision,
    } : null;
  }, [activeSession, canonicalizedHistoryPresentation]);
  const continuousHistoryVirtualItems = useMemo(() => {
    if (!activeSession || !continuousHistoryPresentation) {
      projectContinuousHistory(null);
      return null;
    }
    return projectContinuousHistory({
      ...activeSession,
      dialogTurns: continuousHistoryPresentation.turns,
    });
  }, [activeSession, continuousHistoryPresentation, projectContinuousHistory]);
  const continuousHistoryProjectionEligible = canRetainContinuousHistoryProjection(
    continuousHistoryPresentation,
    continuousHistoryVirtualItems?.length ?? Number.POSITIVE_INFINITY,
  );
  const isRetainingContinuousHistoryProjection = Boolean(
    activeSession
    && continuousProjectionSessionId === activeSession.sessionId
    && continuousHistoryProjectionEligible
  );
  const isRenderingContinuousHistoryProjection = Boolean(
    continuousHistoryProjectionEligible
    && (isShowingHistoryPresentation || isRetainingContinuousHistoryProjection)
  );
  const renderedHistoryPresentation = isRenderingContinuousHistoryProjection
    ? continuousHistoryPresentation
    : isShowingHistoryPresentation
      ? canonicalizedHistoryPresentation
      : null;
  const isRenderingHistoryProjection = Boolean(renderedHistoryPresentation);
  /**
   * The range the reader is actually looking at, for the paging ask.
   *
   * Deliberately the *rendered* presentation and not `historyPresentationRef`,
   * which holds the window the store cut. The continuous projection makes those
   * two differ — see `resolveHistoryBoundaryTarget`.
   */
  const renderedHistoryPresentationRef = useRef(renderedHistoryPresentation);
  renderedHistoryPresentationRef.current = renderedHistoryPresentation;
  /*
   * Whether the transcript on screen still reaches the newest Turn.
   *
   * Both consumers of `history-reading` — suppressing streaming follow, and the
   * jump-to-latest affordance — are asking this, not "did the user navigate".
   * A turn intent used to answer it faithfully because only navigation ever
   * activated a history window. Automatic tail paging activates one with nobody
   * navigating: a session whose loaded tail is shorter than the viewport pages
   * on open, and the viewport sitting on the newest output was then reported as
   * reading history, which pinned the jump-to-latest bar open and routed it
   * through a presentation reset that dropped the window and paged it back in.
   *
   * The window's own ordinal bookkeeping answers it exactly — these are ledger
   * numbers, not measurements — and keeps answering it as the session grows: a
   * Turn arriving past the end of the window flips this back on its own, where
   * a provenance flag recorded at activation time would stay stale and leave no
   * way back to the live tail.
   *
   * `isReadingTurnViewport` deliberately keeps its old meaning for the auto-tail
   * placement below, which asks a different question again: who owns the
   * viewport. Merging those two is the mistake this fixes.
   */
  const renderedTranscriptReachesLatestTurn = transcriptReachesLatestTurn({
    windowEndOrdinalExclusive: renderedHistoryPresentation?.range.endOrdinalExclusive ?? null,
    knownTurnCount: activeSessionKnownTurnCount,
  });
  const isViewportDetachedFromLiveTail = (
    isReadingTurnViewport && !renderedTranscriptReachesLatestTurn
  );
  const virtualItems = useMemo(() => {
    let items: VirtualItem[];
    if (!activeSession || !renderedHistoryPresentation) {
      projectHistory(null);
      items = canonicalVirtualItems;
    } else if (
      isRenderingContinuousHistoryProjection
      && continuousHistoryVirtualItems
    ) {
      projectHistory(null);
      items = continuousHistoryVirtualItems;
    } else {
      items = projectHistory({
        ...activeSession,
        dialogTurns: renderedHistoryPresentation.turns,
      });
    }
    if (!activeSession || isViewportDetachedFromLiveTail || submittedPreviews.length === 0) return items;
    const projectedTurnIds = new Set(activeSession.dialogTurns.map(turn => turn.id));
    const pendingItems = submittedPreviews
      .filter(preview => !projectedTurnIds.has(preview.turnId))
      .map((preview, index) => ({
        type: 'user-message' as const,
        data: preview.message,
        turnId: preview.turnId,
        absoluteTurnIndex: activeSessionKnownTurnCount + index + 1,
        turnStatus: 'pending' as const,
        submissionPhase: preview.phase,
        submissionError: preview.error,
      }));
    return pendingItems.length ? [...items, ...pendingItems] : items;
  }, [
    activeSession,
    activeSessionKnownTurnCount,
    canonicalVirtualItems,
    continuousHistoryVirtualItems,
    isRenderingContinuousHistoryProjection,
    isViewportDetachedFromLiveTail,
    renderedHistoryPresentation,
    submittedPreviews,
    projectHistory,
  ]);

  // The transcript reads the pending list to mark the tool cards that are
  // waiting; answering them belongs to the composer, which reads the same
  // shared subscription.
  const { requests: permissionRequests } = usePermissionRequests(activeSession?.sessionId);
  const visibleTurnInfo = useVisibleTurnInfo();
  const [queuedTurnNavigation, setQueuedTurnNavigation] = useState<QueuedTurnNavigation | null>(null);
  // A view mounted mid-open (for example by a device switch) adopts it.
  const [pendingHistoryOpenSession, setPendingHistoryOpenSession] = useState<HistorySessionOpenIntentDetail | null>(() => {
    const transition = getHistorySessionOpenTransitionSnapshot();
    return transition ? { sessionId: transition.sessionId, sessionTitle: transition.sessionTitle, maxMs: transition.maxMs } : null;
  });
  const [searchOpenRequest, setSearchOpenRequest] = useState(0);
  const backgroundCommandActivities = useBackgroundCommandActivityStore(state => state.activities);
  const [stoppingBackgroundCommandIds, setStoppingBackgroundCommandIds] = useState<Set<string>>(() => new Set());
  const [backgroundCommandInputTarget, setBackgroundCommandInputTarget] = useState<FlowChatHeaderCommandSummary | null>(null);
  const [isSendingBackgroundCommandInput, setIsSendingBackgroundCommandInput] = useState(false);
  const autoTailTurnKeyRef = useRef<string | null>(null);
  const releasedHistoryCompletionKeyRef = useRef<string | null>(null);
  const visibleTurnInfoRef = useRef<VisibleTurnInfo | null>(visibleTurnInfo);
  const turnSummariesRef = useRef<FlowChatTurnSummary[]>([]);
  const turnRailTurnIdsRef = useRef<Set<string>>(new Set());
  const requestTurnNavigationRef = useRef<((turnId: string) => FlowChatTurnNavigationStatus) | null>(null);
  const trajectoryViewId = useId();
  const [trajectoryOpen, setTrajectoryOpen] = useState(false);
  const [trajectorySelection, setTrajectorySelection] = useState<TrajectorySelection>();
  const [trajectorySelectionClearRequest, setTrajectorySelectionClearRequest] = useState(0);
  const [trajectorySearchInput, setTrajectorySearchInput] = useState('');
  const [trajectorySearchState, setTrajectorySearchState] = useState<TrajectorySearchState>({ count: 0, current: 0 });
  const trajectoryRef = useRef<TrajectoryExplorerRef>(null);
  const openTrajectory = useCallback(() => setTrajectoryOpen(true), []);
  const virtualListRef = useRef<VirtualMessageListRef>(null);
  const paneViewportRect = useRef<{ width: number; height: number }>();
  const chatScopeRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionViewportStateRef = useRef<Map<string, SessionViewportState>>(new Map());
  const viewScope = useConversationViewScope();
  const transferredRevision = useRef(0);
  const incomingViewTransfer = activeSession?.sessionId && isViewportActive
    ? peekConversationViewTransfer({ surfaceId: surfaceScope.surfaceId, sessionId: activeSession.sessionId }, viewScope ? 'dock' : 'main')
    : undefined;
  const restoreRevision = incomingViewTransfer?.revision ?? transferredRevision.current;
  // Consume only after commit, so an interrupted/StrictMode render cannot lose
  // the source's reading position before the destination has mounted.
  useLayoutEffect(() => {
    if (!incomingViewTransfer || !activeSession?.sessionId) return;
    sessionViewportStateRef.current.set(activeSession.sessionId, incomingViewTransfer.state);
    transferredRevision.current = incomingViewTransfer.revision;
    takeConversationViewTransfer({ surfaceId: surfaceScope.surfaceId, sessionId: activeSession.sessionId }, viewScope ? 'dock' : 'main', incomingViewTransfer.revision);
  }, [incomingViewTransfer, activeSession?.sessionId, surfaceScope.surfaceId, viewScope]);
  const viewportRestorePendingSessionIdRef = useRef<string | null>(null);
  const [viewportRestorePendingSessionId, setViewportRestorePendingSessionId] = useState<string | null>(null);
  const rememberedHistoryRange = activeSession?.sessionId
    ? incomingViewTransfer?.state.historyPresentation?.range
      ?? sessionViewportStateRef.current.get(activeSession.sessionId)?.historyPresentation?.range
    : undefined;
  const isRememberedHistoryRangeInvalid = Boolean(
    activeSession?.historyState === 'ready'
    && rememberedHistoryRange
    && rememberedHistoryRange.endOrdinalExclusive > activeSessionKnownTurnCount
  );
  const activeSessionViewportSnapshot = activeSession?.sessionId
    ? incomingViewTransfer?.state.snapshot ?? sessionViewportStateRef.current.get(activeSession.sessionId)?.snapshot ?? null
    : null;
  const isRestoringRememberedReadingPosition = Boolean(
    activeSessionViewportSnapshot
    && !activeSessionViewportSnapshot.isAtTail
    && activeSessionViewportSnapshot.anchorTurnId !== null
    && activeSessionViewportSnapshot.anchorOffsetPx !== null
  );
  const restoreGateSessionId = viewportRestorePendingSessionId
    ?? (
      activeSession?.sessionId !== activeSessionIdRef.current
      && isRestoringRememberedReadingPosition
        ? activeSession?.sessionId ?? null
        : null
    );
  const [historyInitialContentPostPaintKey, setHistoryInitialContentPostPaintKey] = useState<string | null>(null);
  const [historyLoadingPresentation, setHistoryLoadingPresentation] = useState<{ identity: string; ready: boolean } | null>(null);
  const handleHistoryPresentationChange = useCallback((identity: string, ready: boolean) => {
    setHistoryLoadingPresentation(previous => previous?.identity === identity && previous.ready === ready
      ? previous : { identity, ready });
  }, []);
  const workspaceContext = useWorkspaceContext();
  const workspacePath = viewScope ? activeSession?.workspacePath : workspaceContext.workspacePath;
  const activeWorkspace = viewScope ? undefined : workspaceContext.activeWorkspace;
  const allowUserMessageRollback = !isAcpFlowSession(activeSession);
  const historyState = activeSession?.historyState;

  const rememberSessionViewportState = useCallback((
    sessionId: string,
    patch: Partial<SessionViewportState>,
  ) => {
    const previous = sessionViewportStateRef.current.get(sessionId);
    sessionViewportStateRef.current.delete(sessionId);
    sessionViewportStateRef.current.set(sessionId, {
      snapshot: patch.snapshot !== undefined ? patch.snapshot : previous?.snapshot ?? null,
      historyPresentation: patch.historyPresentation !== undefined
        ? historyBookmark(patch.historyPresentation)
        : previous?.historyPresentation ?? null,
      viewportIntent: patch.viewportIntent !== undefined
        ? patch.viewportIntent
        : previous?.viewportIntent ?? null,
    });
    // Keep lightweight reader state for the view's lifetime. Evicting a body
    // must not also discard a user's position after visiting many sessions.
  }, []);

  const acceptViewportSnapshot = useCallback((snapshot: FlowChatViewportSnapshot) => {
    rememberSessionViewportState(snapshot.sessionId, { snapshot });
  }, [rememberSessionViewportState]);

  const handleViewportSnapshot = useCallback((snapshot: FlowChatViewportSnapshot) => {
    if (
      viewportRestorePendingSessionIdRef.current === snapshot.sessionId
      || restoreGateSessionId === snapshot.sessionId
    ) {
      return;
    }
    acceptViewportSnapshot(snapshot);
  }, [acceptViewportSnapshot, restoreGateSessionId]);

  useLayoutEffect(() => registerConversationReader({ surfaceId: surfaceScope.surfaceId, sessionId: activeSession?.sessionId ?? '' }, viewScope ? 'dock' : 'main', sessionId => {
    const cached = sessionViewportStateRef.current.get(sessionId);
    if (sessionId !== activeSessionIdRef.current) return cached ?? null;
    return {
      snapshot: virtualListRef.current?.captureViewportSnapshot() ?? cached?.snapshot ?? null,
      historyPresentation: historyBookmark(historyPresentationRef.current),
      viewportIntent: viewportIntentRef.current,
    };
  }), [surfaceScope.epoch, surfaceScope.surfaceId, activeSession?.sessionId, viewScope]);

  const handleViewportRestoreSettled = useCallback((sessionId: string) => {
    if (viewportRestorePendingSessionIdRef.current !== sessionId) return;
    viewportRestorePendingSessionIdRef.current = null;
    setViewportRestorePendingSessionId(null);
    const capturedSnapshot = virtualListRef.current?.captureViewportSnapshot() ?? null;
    if (capturedSnapshot?.sessionId === sessionId) {
      // Restoration started from an explicit reader-owned position. A scroll
      // event that recomputes the tail band can trail the final layout frame,
      // so its old ref value must not turn that restored position back into a
      // session-open tail request at the hand-off boundary.
      acceptViewportSnapshot({
        ...capturedSnapshot,
        isAtTail: false,
      });
    }
  }, [acceptViewportSnapshot]);
  const showHistoryPlaceholder = virtualItems.length === 0 && (
    historyState === 'metadata-only' ||
    historyState === 'hydrating' ||
    historyState === 'failed'
  );
  // Session and projected rows commit atomically. A ready internal Turn may
  // deliberately project no rows; it is not an unfinished hydration. Keep the
  // list/navigation mounted so earlier history remains reachable.
  const showSessionTranscript = virtualItems.length > 0
    || (historyState === 'ready' && activeSessionKnownTurnCount > 0);
  const isPendingHistoryOpenActiveSession =
    pendingHistoryOpenSession !== null &&
    activeSession?.sessionId === pendingHistoryOpenSession.sessionId;
  const {
    groupStates: exploreGroupStates,
    groupReceiveFeedback,
    expandedToolCapsules,
    onToolCapsuleExpandedChange,
    onGroupToggle: handleExploreGroupToggle,
    onExpandGroup: handleExpandGroup,
    onExpandAllInTurn: handleExpandAllInTurn,
    onCollapseGroup: handleCollapseGroup,
  } = useFlowGroupState(virtualItems, undefined, activeSession?.sessionId, undefined,
    surfaceScope.key('flow-group-feedback', surfaceScope.epoch, activeSession?.sessionId ?? ''));
  const { handleToolConfirm, handleToolReject } = useFlowChatToolActions();

  const { handleFileViewRequest } = useFlowChatFileActions({
    sessionId: activeSession?.sessionId,
    workspacePath,
    onFileViewRequest,
  });
  const handleHttpLinkClick = useFlowChatHttpLinkClick(
    activeSession?.workspaceId,
    activeSession?.workspacePath || workspacePath,
  );
  const {
    searchQuery,
    onSearchChange: setSearchQuery,
    matches: searchMatches,
    matchesByVirtualIndex: searchMatchesByVirtualIndex,
    clearSearch,
  } = useFlowChatSearch(virtualItems);
  const searchCurrentMatch = trajectorySelection ? searchMatches.find(match =>
    match.turnId === trajectorySelection.node.turnId && (trajectorySelection.node.focusItemId
      ? match.flowItemId === trajectorySelection.node.focusItemId : match.type === 'user-message')) : undefined;
  const closeTrajectory = useCallback(() => {
    setTrajectoryOpen(false); setTrajectorySelection(undefined); clearSearch();
    setTrajectorySearchInput(''); setTrajectorySearchState({ count: 0, current: 0 });
    setTrajectorySelectionClearRequest(value => value + 1);
    virtualListRef.current?.clearSearchMatch();
  }, [clearSearch]);

  useEffect(() => { virtualListRef.current?.clearSearchMatch(); }, [searchQuery]);

  useFlowChatSync();
  useFlowChatCopyDialog();

  const switchToLiveTailForSession = useCallback((
    sessionId: string,
    options?: { discardRecentHistory?: boolean },
  ) => {
    invalidateHistoryPresentationOwner();
    const retainContinuousProjection = (
      options?.discardRecentHistory !== true
      && activeSession?.sessionId === sessionId
      && continuousHistoryProjectionEligible
    );
    if (retainContinuousProjection) {
      setContinuousProjectionSessionId(sessionId);
    } else {
      setContinuousProjectionSessionId(null);
      flowChatStore.restoreSessionTailPresentation(sessionId);
    }
    if (options?.discardRecentHistory === true) {
      historyPresentationRef.current = null;
      setHistoryPresentation(null);
    }
    viewportRestorePendingSessionIdRef.current = null;
    setViewportRestorePendingSessionId(null);
    rememberSessionViewportState(sessionId, {
      snapshot: null,
      ...(options?.discardRecentHistory ? { historyPresentation: null } : {}),
      viewportIntent: { kind: 'live-tail', sessionId },
    });
    updateViewportIntent({ kind: 'live-tail', sessionId });
    setHistoryBoundaryState(IDLE_HISTORY_BOUNDARY_STATE);
    setQueuedTurnNavigation(null);
  }, [
    activeSession?.sessionId,
    continuousHistoryProjectionEligible,
    invalidateHistoryPresentationOwner,
    rememberSessionViewportState,
    updateViewportIntent,
  ]);

  useEffect(() => {
    historyPresentationRef.current = historyPresentation;
    if (historyPresentation?.sessionId) {
      rememberSessionViewportState(historyPresentation.sessionId, { historyPresentation });
    }
  }, [historyPresentation, rememberSessionViewportState]);

  useEffect(() => {
    const intent = viewportIntent;
    if (intent?.sessionId) {
      rememberSessionViewportState(intent.sessionId, { viewportIntent: intent });
    }
  }, [rememberSessionViewportState, viewportIntent]);

  useLayoutEffect(() => {
    const sessionId = activeSession?.sessionId;
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId && (previousSessionId !== sessionId
      || historyPresentationRef.current?.sessionId === previousSessionId)) {
      rememberSessionViewportState(previousSessionId, {
        historyPresentation: historyPresentationRef.current?.sessionId === previousSessionId
          ? historyPresentationRef.current
          : null,
        viewportIntent: viewportIntentRef.current?.sessionId === previousSessionId
          ? viewportIntentRef.current
          : null,
      });
    }
    activeSessionIdRef.current = sessionId ?? null;
    // A history rewrite can remove the saved range while this Session stays
    // selected. Never start restoring that retired bookmark (or resurrect it
    // on a later hydration/session switch).
    if (sessionId && isRememberedHistoryRangeInvalid) {
      sessionViewportStateRef.current.delete(sessionId);
    }
    const remembered = sessionId ? sessionViewportStateRef.current.get(sessionId) : undefined;
    invalidateHistoryPresentationOwner();
    const bookmark = remembered?.historyPresentation;
    const cached = sessionId && bookmark
      ? flowChatStore.reactivateSessionHistoryWindow(sessionId, bookmark.range)
      : null;
    const restoredHistoryPresentation = cached && bookmark ? { ...cached, sessionId: bookmark.sessionId, revision: bookmark.revision } : null;
    historyPresentationRef.current = restoredHistoryPresentation;
    setHistoryPresentation(restoredHistoryPresentation);
    setContinuousProjectionSessionId(null);
    const restoredIntent = remembered?.viewportIntent
      ?? (sessionId ? { kind: 'live-tail', sessionId } : null);
    const rememberedSnapshot = remembered?.snapshot ?? null;
    const shouldRestoreRememberedViewport = Boolean(
      rememberedSnapshot
      && !rememberedSnapshot.isAtTail
      && rememberedSnapshot.anchorTurnId !== null
      && rememberedSnapshot.anchorOffsetPx !== null
    );
    viewportRestorePendingSessionIdRef.current = shouldRestoreRememberedViewport
      ? sessionId ?? null
      : null;
    setViewportRestorePendingSessionId(viewportRestorePendingSessionIdRef.current);
    updateViewportIntent(restoredIntent);
    setHistoryBoundaryState(IDLE_HISTORY_BOUNDARY_STATE);
    historyBoundaryRequestsRef.current = { before: null, after: null };
    if (sessionId) {
      if (!restoredHistoryPresentation && !bookmark) {
        flowChatStore.restoreSessionTailPresentation(sessionId);
      }
    }
    if (sessionId && bookmark && !cached && activeSession?.historyState === 'ready') {
      setHistoryRestore({ sessionId, status: 'loading' });
      const generation = historyPresentationOwnerGenerationRef.current;
      let cancelled = false;
      void flowChatStore.restoreSessionHistoryWindow(sessionId, bookmark.range, () =>
        !cancelled && surfaceScope.isCurrent() && activeSessionIdRef.current === sessionId
        && historyPresentationOwnerGenerationRef.current === generation,
      ).then(presentation => {
        if (cancelled || !surfaceScope.isCurrent() || activeSessionIdRef.current !== sessionId
          || historyPresentationOwnerGenerationRef.current !== generation) return;
        if (!presentation) throw new Error('The saved history range is no longer available');
        const next = { ...presentation, sessionId, revision: bookmark.revision + 1 };
        historyPresentationRef.current = next;
        setHistoryPresentation(next);
        setHistoryRestore(null);
      }).catch(error => {
        if (cancelled || !surfaceScope.isCurrent() || activeSessionIdRef.current !== sessionId
          || historyPresentationOwnerGenerationRef.current !== generation) return;
        log.warn('Failed to restore reader history range', { sessionId, error });
        setHistoryRestore({ sessionId, status: 'failed' });
        setHistoryBoundaryState({ before: 'error', after: 'error' });
      });
      return () => { cancelled = true; };
    }
  }, [activeSession?.sessionId, activeSession?.historyState, isRememberedHistoryRangeInvalid, invalidateHistoryPresentationOwner, rememberSessionViewportState, updateViewportIntent, restoreRevision, historyRestoreRetry, surfaceScope]);

  const readerCatalogRef = useRef<{ sessionId: string | undefined; revision: string | undefined } | null>(null);
  useEffect(() => {
    const sessionId = activeSession?.sessionId;
    const revision = activeSession?.turnCatalog?.revision;
    const previous = readerCatalogRef.current;
    readerCatalogRef.current = { sessionId, revision };
    if (!sessionId || previous?.sessionId !== sessionId || previous.revision === revision) return;
    const intent = viewportIntentRef.current;
    if (intent?.kind !== 'turn' || intent.sessionId !== sessionId || intent.source !== 'history-range') {
      if (historyPresentationRef.current?.sessionId === sessionId) {
        switchToLiveTailForSession(sessionId, { discardRecentHistory: true });
      }
      return;
    }
    // The store invalidates cached ranges when the authoritative catalog
    // changes. Retire the view's matching owner too, then reload its bookmark
    // through the normal history path. Keeping only the rendered copy leaves
    // every later extend/synchronize pointed at a window the store no longer owns.
    invalidateHistoryPresentationOwner();
    setHistoryRestoreRetry(retry => retry + 1);
  }, [activeSession?.sessionId, activeSession?.turnCatalog?.revision, invalidateHistoryPresentationOwner, switchToLiveTailForSession]);

  useEffect(() => {
    const retainedSessionId = continuousProjectionSessionId;
    if (!retainedSessionId) {
      return;
    }
    if (retainedSessionId !== activeSession?.sessionId) {
      flowChatStore.restoreSessionTailPresentation(retainedSessionId);
      setContinuousProjectionSessionId(null);
      return;
    }
    if (continuousHistoryProjectionEligible) {
      return;
    }
    if (activeViewportIntent?.kind === 'live-tail') {
      flowChatStore.restoreSessionTailPresentation(retainedSessionId);
    }
    setContinuousProjectionSessionId(null);
  }, [
    activeSession?.sessionId,
    activeViewportIntent?.kind,
    continuousHistoryProjectionEligible,
    continuousProjectionSessionId,
  ]);

  useEffect(() => {
    if (!activeHistoryPresentation || activeHistoryPresentationFitsSession) {
      return;
    }
    switchToLiveTailForSession(activeHistoryPresentation.sessionId, { discardRecentHistory: true });
  }, [
    activeHistoryPresentation,
    activeHistoryPresentationFitsSession,
    switchToLiveTailForSession,
  ]);

  useEffect(() => {
    const handleHistorySessionOpenIntent = (event: Event) => {
      const detail = (event as CustomEvent<HistorySessionOpenIntentDetail>).detail;
      if (!detail?.sessionId) {
        return;
      }

      setPendingHistoryOpenSession({
        sessionId: detail.sessionId,
        sessionTitle: detail.sessionTitle,
        maxMs: detail.maxMs,
      });
      startupTrace.markPhase('historical_session_open_intent_overlay', {
        sessionId: detail.sessionId,
      });
    };

    window.addEventListener(HISTORY_SESSION_OPEN_INTENT_EVENT, handleHistorySessionOpenIntent);
    return () => {
      window.removeEventListener(HISTORY_SESSION_OPEN_INTENT_EVENT, handleHistorySessionOpenIntent);
    };
  }, []);

  useEffect(() => subscribeHistorySessionOpenTransition(() => {
    const transition = getHistorySessionOpenTransitionSnapshot();
    setPendingHistoryOpenSession(current => (
      current && transition?.sessionId !== current.sessionId ? null : current
    ));
  }), []);

  useEffect(() => {
    if (!pendingHistoryOpenSession) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPendingHistoryOpenSession(current => {
        if (current?.sessionId === pendingHistoryOpenSession.sessionId) {
          clearHistorySessionOpenTransition(pendingHistoryOpenSession.sessionId);
          return null;
        }
        return current;
      });
    }, pendingHistoryOpenSession.maxMs ?? 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pendingHistoryOpenSession]);

  useEffect(() => {
    if (!isPendingHistoryOpenActiveSession) {
      return;
    }

    if (showHistoryPlaceholder && historyState !== 'failed') {
      return;
    }

    // Settled either way: the open's transition ends now, not at its timeout
    // (a cross-device open allows up to 20 s, and its readers defer work).
    clearHistorySessionOpenTransition(pendingHistoryOpenSession.sessionId);
    setPendingHistoryOpenSession(null);
  }, [
    historyState,
    isPendingHistoryOpenActiveSession,
    pendingHistoryOpenSession?.sessionId,
    showHistoryPlaceholder,
  ]);

  // Scalar session facts for the stable context. Depending on scalars (not the
  // session object) keeps the context value referentially stable across
  // streaming flushes, which produce a new session object ~30x/second.
  const activeSessionId = activeSession?.sessionId;
  const activeSessionWorkspaceId = activeSession?.workspaceId
    || activeSession?.config?.workspaceId;
  const activeSessionWorkspacePath = activeSession?.workspacePath
    || activeSession?.config?.workspacePath;
  const activeSessionRemoteConnectionId = activeSession?.remoteConnectionId
    || activeSession?.config?.remoteConnectionId;
  const activeSessionIsHistorical = activeSession?.isHistorical === true;
  const activeSessionContextRestoreState = activeSession?.contextRestoreState;

  // Reuse the previous Set when the pending permission tool-call ids are
  // content-equal so consumers do not re-render on identity-only changes.
  const pendingPermissionToolCallIdsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingPermissionToolCallIds = useMemo(() => {
    const next = pendingPermissionToolCallIdsForSession(
      permissionRequests,
      activeSessionId,
    );
    const previous = pendingPermissionToolCallIdsRef.current;
    if (previous.size === next.size) {
      let contentEqual = true;
      for (const id of next) {
        if (!previous.has(id)) {
          contentEqual = false;
          break;
        }
      }
      if (contentEqual) {
        return previous;
      }
    }
    pendingPermissionToolCallIdsRef.current = next;
    return next;
  }, [permissionRequests, activeSessionId]);

  const contextValue: FlowChatContextValue = useMemo(() => ({
    onFileViewRequest: handleFileViewRequest,
    onTabOpen,
    onHttpLinkClick: handleHttpLinkClick,
    onOpenVisualization,
    onToolConfirm: handleToolConfirm,
    onToolReject: handleToolReject,
    sessionId: activeSessionId,
    workspaceId: activeSessionWorkspaceId,
    workspacePath: activeSessionWorkspacePath,
    remoteConnectionId: activeSessionRemoteConnectionId,
    isHistoricalSession: activeSessionIsHistorical,
    contextRestoreState: activeSessionContextRestoreState,
    allowUserMessageRollback,
    onGroupToggle: handleExploreGroupToggle,
    onExploreGroupToggle: handleExploreGroupToggle,
    onExpandGroup: handleExpandGroup,
    onExpandAllInTurn: handleExpandAllInTurn,
    onCollapseGroup: handleCollapseGroup,
    onToolCapsuleExpandedChange,
  }), [
    handleFileViewRequest,
    onTabOpen,
    handleHttpLinkClick,
    onOpenVisualization,
    handleToolConfirm,
    handleToolReject,
    activeSessionId,
    activeSessionWorkspaceId,
    activeSessionWorkspacePath,
    activeSessionRemoteConnectionId,
    activeSessionIsHistorical,
    activeSessionContextRestoreState,
    allowUserMessageRollback,
    handleExploreGroupToggle,
    handleExpandGroup,
    handleExpandAllInTurn,
    handleCollapseGroup,
    onToolCapsuleExpandedChange,
  ]);

  const volatileContextValue: FlowChatVolatileContextValue = useMemo(() => ({
    pendingPermissionToolCallIds,
    groupStates: exploreGroupStates,
    groupReceiveFeedback,
    exploreGroupStates,
    expandedToolCapsules,
    searchQuery,
    searchMatchesByVirtualIndex,
    searchCurrentMatch,
  }), [
    pendingPermissionToolCallIds,
    exploreGroupStates,
    expandedToolCapsules, groupReceiveFeedback,
    searchQuery,
    searchMatchesByVirtualIndex,
    searchCurrentMatch,
  ]);

  const renderedTurns = useMemo(
    () => renderedHistoryPresentation
      ? renderedHistoryPresentation.turns
      : activeSession?.dialogTurns ?? [],
    [activeSession?.dialogTurns, renderedHistoryPresentation],
  );
  const [projectTurnSummaries] = useState(createFlowChatTurnSummaryProjector);
  const { turnSummaries, renderedTurnSummaries, absoluteRenderedTurnSummaries } = projectTurnSummaries(
    activeSession, renderedTurns, renderedHistoryPresentation?.range.startOrdinal,
  );
  const activeTurnCatalog = activeSession?.turnCatalog;
  const turnCatalog = activeTurnCatalog?.sessionId === activeSession?.sessionId
    ? activeTurnCatalog
    : undefined;
  const sessionTotalTurnCount = activeSession
    ? projectedSessionTurnCount(activeSession)
    : 0;
  const absoluteRenderedTurnSummaryById = useMemo(() => {
    return new Map(absoluteRenderedTurnSummaries.map(turn => [turn.turnId, turn]));
  }, [absoluteRenderedTurnSummaries]);
  // Every streamed flush replaces `dialogTurns`; the rail only reads each
  // Turn's identity and user message, so it keeps the previous array until
  // one of those changes. Paging and rollback change ids or length.
  const turnRailSourcesRef = useRef<readonly DialogTurn[]>([]);
  const turnRailSources = useMemo(() => {
    const next = activeSession?.dialogTurns ?? [];
    if (sameTurnRailSources(turnRailSourcesRef.current, next)) return turnRailSourcesRef.current;
    turnRailSourcesRef.current = next;
    return next;
  }, [activeSession?.dialogTurns]);
  const turnRailItems = useMemo<FlowChatTurnRailItem[]>(() => {
    const historyView = activeSession?.sessionId
      ? flowChatStore.getSessionHistoryViewState(activeSession.sessionId)
      : undefined;
    const loadedTurns = [
      ...turnRailSources,
      ...(historyView?.loadedRanges.flatMap(range => range.turns) ?? []),
    ];
    const dialogTurnById = new Map(loadedTurns.map(turn => [turn.id, turn]));
    type LoadedRailTurn = { turnId: string; content: string; storageTurnIndex?: number; capsulePreview?: FlowChatTurnRailItem['capsulePreview'] };
    const loadedByStorageIndex = new Map<number, LoadedRailTurn>();
    const loadedByOrdinal = new Map<number, LoadedRailTurn>();
    for (const range of historyView?.loadedRanges ?? []) {
      range.turns.forEach((turn, index) => {
        const loaded = {
          turnId: turn.id,
          content: turn.userMessage?.content ?? '',
          storageTurnIndex: turn.storageTurnIndex ?? turn.backendTurnIndex,
          capsulePreview: turnRailPreviewFor(turn),
        };
        loadedByOrdinal.set(range.startOrdinal + index, loaded);
        const storageTurnIndex = turn.storageTurnIndex ?? turn.backendTurnIndex;
        if (typeof storageTurnIndex === 'number') {
          loadedByStorageIndex.set(storageTurnIndex, loaded);
        }
      });
    }
    for (const summary of absoluteRenderedTurnSummaries) {
      const dialogTurn = dialogTurnById.get(summary.turnId);
      const loaded = {
        turnId: summary.turnId,
        content: dialogTurn?.userMessage?.content ?? '',
        storageTurnIndex: summary.storageTurnIndex,
        capsulePreview: turnRailPreviewFor(dialogTurn),
      };
      loadedByOrdinal.set(Math.max(0, summary.turnIndex - 1), loaded);
      if (typeof summary.storageTurnIndex === 'number') {
        loadedByStorageIndex.set(summary.storageTurnIndex, loaded);
      }
    }

    const catalogEntryByOrdinal = new Map(
      (turnCatalog?.entries ?? []).map(entry => [entry.ordinal, entry]),
    );
    const itemCount = Math.max(sessionTotalTurnCount, turnCatalog?.entries.length ?? 0);
    const usedLoadedTurnIds = new Set<string>();
    const items = Array.from({ length: itemCount }, (_, ordinal): FlowChatTurnRailItem => {
      const catalogEntry = catalogEntryByOrdinal.get(ordinal);
      const storageTurnIndex = catalogEntry?.storageTurnIndex ?? ordinal;
      const catalogDialogTurn = catalogEntry?.turnId
        ? dialogTurnById.get(catalogEntry.turnId)
        : undefined;
      const loaded = [loadedByStorageIndex.get(storageTurnIndex),
        catalogEntry?.turnId && catalogDialogTurn ? {
          turnId: catalogEntry.turnId,
          content: catalogDialogTurn.userMessage?.content ?? '',
          storageTurnIndex: catalogDialogTurn.storageTurnIndex ?? catalogDialogTurn.backendTurnIndex,
          capsulePreview: turnRailPreviewFor(catalogDialogTurn),
        } : undefined, loadedByOrdinal.get(ordinal),
      ].find(candidate => {
        if (!candidate) return false;
        if (!catalogEntry) return true;
        if (catalogEntry.turnId && candidate.turnId !== catalogEntry.turnId) return false;
        return candidate.storageTurnIndex === undefined || candidate.storageTurnIndex === catalogEntry.storageTurnIndex;
      });
      const turnId = loaded?.turnId ?? catalogEntry?.turnId ?? null;
      if (loaded?.turnId) {
        usedLoadedTurnIds.add(loaded.turnId);
      }
      return {
        itemKey: `storage:${storageTurnIndex}`,
        turnId,
        ordinal,
        turnIndex: ordinal + 1,
        content: loaded?.content ?? catalogEntry?.preview ?? null,
        capsulePreview: loaded?.capsulePreview ?? catalogEntry?.capsulePreview,
      };
    });

    for (const summary of absoluteRenderedTurnSummaries) {
      if (usedLoadedTurnIds.has(summary.turnId)) {
        continue;
      }
      items.push({
        itemKey: typeof summary.storageTurnIndex === 'number'
          ? `storage:${summary.storageTurnIndex}`
          : `live:${summary.turnId}`,
        turnId: summary.turnId,
        ordinal: Math.max(0, summary.turnIndex - 1),
        turnIndex: summary.turnIndex,
        content: dialogTurnById.get(summary.turnId)?.userMessage?.content ?? '',
        capsulePreview: turnRailPreviewFor(dialogTurnById.get(summary.turnId)),
      });
    }

    return items.sort((left, right) => left.turnIndex - right.turnIndex);
  }, [
    absoluteRenderedTurnSummaries,
    turnRailSources,
    activeSession?.sessionId,
    sessionTotalTurnCount,
    turnCatalog,
  ]);
  const latestTurnId = turnSummaries[turnSummaries.length - 1]?.turnId;
  const hasPendingHistoryCompletion = activeSession?.sessionId
    ? flowChatStore.hasPendingSessionHistoryCompletion(activeSession.sessionId)
    : false;
  const hasDeferredHistoryProjection = activeSession?.sessionId
    ? flowChatStore.hasDeferredSessionHistoryProjection(activeSession.sessionId)
    : false;
  const historyInitialContentKey =
    activeSession?.sessionId &&
    latestTurnId &&
    activeSession.historyState === 'ready' &&
    virtualItems.length > 0 &&
    (
      activeSession.contextRestoreState === 'pending' ||
      hasPendingHistoryCompletion
    )
      ? `${activeSession.sessionId}:${latestTurnId}`
      : null;
  const shouldDeferBackgroundCommandSnapshot =
    activeSession?.historyState === 'metadata-only' ||
    activeSession?.historyState === 'hydrating' ||
    (
      historyInitialContentKey !== null &&
      historyInitialContentPostPaintKey !== historyInitialContentKey
    );
  const shouldScheduleBackgroundCommandSnapshotAfterPaint =
    historyInitialContentKey !== null &&
    historyInitialContentPostPaintKey === historyInitialContentKey;
  const activeHistoryRestore = historyRestore?.sessionId === activeSession?.sessionId ? historyRestore : null;
  const showFailedHistoryPlaceholder =
    (showHistoryPlaceholder && historyState === 'failed') || activeHistoryRestore?.status === 'failed';
  // Rendered records stay after a failed live read; without a cue they look
  // current while nothing new arrives. The next ready clears the failed state.
  const showUpdatesPaused = historyState === 'failed' && !showFailedHistoryPlaceholder
    && showSessionTranscript && !isLocalSurface(surfaceScope.surfaceId);
  const showHistoryOpenIntentOverlay =
    pendingHistoryOpenSession !== null &&
    (
      activeSession?.sessionId !== pendingHistoryOpenSession.sessionId ||
      (isPendingHistoryOpenActiveSession && showHistoryPlaceholder && !showFailedHistoryPlaceholder)
    );
  const showHistoryLoadingLayer =
    !showHistoryOpenIntentOverlay && !showFailedHistoryPlaceholder
    && (showHistoryPlaceholder || activeHistoryRestore?.status === 'loading');
  const historyLoadingIdentity = surfaceScope.key('history-loading', surfaceScope.epoch,
    showHistoryOpenIntentOverlay ? pendingHistoryOpenSession?.sessionId : activeSession?.sessionId);
  const isHistoryContentPresented = historyLoadingPresentation?.identity === historyLoadingIdentity && historyLoadingPresentation.ready;
  const shouldBlockHistoryTransitionInteraction =
    !isHistoryContentPresented || activeHistoryRestore?.status === 'loading' || showHistoryOpenIntentOverlay;
  useEffect(() => {
    if (!showHistoryLoadingLayer || !activeSession?.sessionId) {
      return;
    }

    const sessionId = activeSession.sessionId;
    recordHistorySessionDiagnosticEvent(sessionId, 'loading_layer_entered', {
      historyState,
      isHistorical: activeSession.isHistorical === true,
      isRemote: isRemoteTraceContext(activeSession.remoteConnectionId, activeSession.remoteSshHost),
      hasRenderableContent: hasRenderableSessionContent(activeSession),
      dialogTurnCount: activeSession.dialogTurns.length,
    });

    const timeoutId = window.setTimeout(() => {
      const latestState = flowChatStore.getState();
      const latestSession = latestState.sessions.get(sessionId) ?? activeSession;
      const activeSessionIdMatches = latestState.activeSessionId
        ? latestState.activeSessionId === sessionId
        : activeSession.sessionId === sessionId;

      warnHistorySessionLoadingLayerStalled(sessionId, {
        durationMs: HISTORY_LOADING_LAYER_STALL_WARN_MS,
        historyState: latestSession.historyState,
        isHistorical: latestSession.isHistorical === true,
        isRemote: isRemoteTraceContext(latestSession.remoteConnectionId, latestSession.remoteSshHost),
        activeSessionIdMatches,
        hasRenderableContent: hasRenderableSessionContent(latestSession),
        dialogTurnCount: latestSession.dialogTurns.length,
        hasPendingHistoryCompletion,
        hasDeferredHistoryProjection,
      });
    }, HISTORY_LOADING_LAYER_STALL_WARN_MS);

    return () => {
      window.clearTimeout(timeoutId);
      recordHistorySessionDiagnosticEvent(sessionId, 'loading_layer_exited', {
        historyState,
      });
    };
  }, [
    activeSession,
    hasDeferredHistoryProjection,
    hasPendingHistoryCompletion,
    historyState,
    showHistoryLoadingLayer,
  ]);
  const blockHistoryOverlayActivation = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    if (!showHistoryLoadingLayer && !shouldBlockHistoryTransitionInteraction) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, [shouldBlockHistoryTransitionInteraction, showHistoryLoadingLayer]);
  const latestTurn = useMemo(
    () => findDialogTurn(activeSession?.dialogTurns, latestTurnId),
    [activeSession?.dialogTurns, latestTurnId],
  );
  const latestTurnUsesFollowOutput = shouldUseLatestTurnFollowOutput(latestTurn);

  const navigationVisibleTurnInfo = useMemo<VisibleTurnInfo | null>(() => {
    if (!visibleTurnInfo) {
      return null;
    }

    const localTurn = renderedTurnSummaries.find(turn => turn.turnId === visibleTurnInfo.turnId);
    if (!localTurn) {
      return visibleTurnInfo;
    }

    return {
      ...visibleTurnInfo,
      turnIndex: localTurn.turnIndex,
      totalTurns: renderedTurnSummaries.length,
    };
  }, [renderedTurnSummaries, visibleTurnInfo]);
  const effectiveVisibleTurnInfo = useMemo<VisibleTurnInfo | null>(() => {
    if (!navigationVisibleTurnInfo) {
      return null;
    }

    return {
      ...navigationVisibleTurnInfo,
      turnIndex: absoluteRenderedTurnSummaryById.get(navigationVisibleTurnInfo.turnId)?.turnIndex
        ?? navigationVisibleTurnInfo.turnIndex,
      totalTurns: sessionTotalTurnCount,
    };
  }, [absoluteRenderedTurnSummaryById, navigationVisibleTurnInfo, sessionTotalTurnCount]);
  useEffect(() => {
    visibleTurnInfoRef.current = visibleTurnInfo;
  }, [visibleTurnInfo]);

  useEffect(() => {
    turnSummariesRef.current = renderedTurnSummaries;
  }, [renderedTurnSummaries]);

  useEffect(() => {
    turnRailTurnIdsRef.current = new Set(
      turnRailItems.flatMap(turn => turn.turnId ? [turn.turnId] : []),
    );
  }, [turnRailItems]);

  const requestTurnNavigation = useCallback((turnId: string): FlowChatTurnNavigationStatus => {
    if (!isViewportActive) {
      return 'rejected';
    }
    return virtualListRef.current?.navigateToTurnWithStatus(turnId, {
      behavior: 'auto',
    }) ?? 'rejected';
  }, [isViewportActive]);
  useEffect(() => {
    requestTurnNavigationRef.current = requestTurnNavigation;
  }, [requestTurnNavigation]);
  const handleVirtualListUserScrollIntent = useCallback(() => {
    setQueuedTurnNavigation(null);
  }, []);

  useEffect(() => {
    if (!isViewportActive || !queuedTurnNavigation) return;

    let cancelled = false;
    let frameId: number | null = null;
    let attempts = 0;

    const retry = () => {
      if (cancelled) return;

      const queuedTurnId = queuedTurnNavigation.turnId
        ?? turnSummariesRef.current.find(
          turn => turn.turnIndex === queuedTurnNavigation.ordinal + 1,
        )?.turnId
        ?? null;
      if (!queuedTurnId) {
        attempts += 1;
        if (attempts >= TURN_PIN_RETRY_MAX_ATTEMPTS) {
          setQueuedTurnNavigation(null);
          return;
        }
        frameId = requestAnimationFrame(retry);
        return;
      }

      if (visibleTurnInfoRef.current?.turnId === queuedTurnId) {
        setQueuedTurnNavigation(null);
        return;
      }

      if (!turnRailTurnIdsRef.current.has(queuedTurnId)) {
        setQueuedTurnNavigation(null);
        return;
      }
      const targetIsLoaded = turnSummariesRef.current.some(turn => turn.turnId === queuedTurnId);
      if (!targetIsLoaded) {
        return;
      }

      const navigationStatus = requestTurnNavigationRef.current?.(queuedTurnId) ?? 'rejected';
      if (navigationStatus === 'settled' || navigationStatus === 'pending') {
        setQueuedTurnNavigation(null);
        return;
      }

      attempts += 1;
      if (attempts >= TURN_PIN_RETRY_MAX_ATTEMPTS) {
        setQueuedTurnNavigation(null);
        return;
      }

      frameId = requestAnimationFrame(retry);
    };

    frameId = requestAnimationFrame(retry);

    return () => {
      cancelled = true;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    isViewportActive,
    queuedTurnNavigation,
    renderedTurnSummaries.length,
  ]);

  useLayoutEffect(() => {
    autoTailTurnKeyRef.current = null;
    releasedHistoryCompletionKeyRef.current = null;
    setTrajectoryOpen(false);
    setTrajectorySelection(undefined);
    setTrajectorySearchInput(''); setTrajectorySearchState({ count: 0, current: 0 });
    clearSearch();
    virtualListRef.current?.clearSearchMatch();
  }, [activeSession?.sessionId, surfaceScope.epoch, clearSearch]);

  useEffect(() => {
    setHistoryInitialContentPostPaintKey(null);
    setQueuedTurnNavigation(null);
  }, [activeSession?.sessionId]);

  useLayoutEffect(() => {
    const sessionId = activeSession?.sessionId;
    const latestTurnKey = sessionId && latestTurnId
      ? `${sessionId}:${latestTurnId}:${turnSummaries.length}`
      : null;
    if (
      !isViewportActive ||
      !sessionId ||
      viewportRestorePendingSessionId === sessionId ||
      isReadingTurnViewport ||
      isRestoringRememberedReadingPosition ||
      !latestTurnId ||
      !latestTurnKey ||
      autoTailTurnKeyRef.current === latestTurnKey
    ) {
      return;
    }

    if (latestTurnUsesFollowOutput) {
      autoTailTurnKeyRef.current = latestTurnKey;
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let attempts = 0;
    const scrollLatestTurnToNaturalEnd = () => {
      if (cancelled) return;
      attempts += 1;
      if (virtualListRef.current?.scrollToTurnEnd(latestTurnId)) {
        autoTailTurnKeyRef.current = latestTurnKey;
        return;
      }
      if (attempts < LATEST_TURN_AUTO_PIN_MAX_ATTEMPTS) {
        frameId = requestAnimationFrame(scrollLatestTurnToNaturalEnd);
      }
    };
    frameId = requestAnimationFrame(scrollLatestTurnToNaturalEnd);
    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    activeSession?.sessionId,
    isReadingTurnViewport,
    isRestoringRememberedReadingPosition,
    isViewportActive,
    latestTurnId,
    latestTurnUsesFollowOutput,
    turnSummaries.length,
    viewportRestorePendingSessionId,
  ]);

  useEffect(() => {
    const sessionId = activeSession?.sessionId;
    if (!isViewportActive) releasedHistoryCompletionKeyRef.current = null;
    if (
      !isViewportActive ||
      !sessionId ||
      activeSession.historyState !== 'ready' ||
      !latestTurnId
    ) {
      return;
    }

    const releaseKey = `${sessionId}:${latestTurnId}`;
    if (releasedHistoryCompletionKeyRef.current === releaseKey) {
      return;
    }

    if (!isHistoryContentPresented) return;

    let cancelled = false;
    const releaseAfterPaint = () => {
      if (cancelled) return;
      releasedHistoryCompletionKeyRef.current = releaseKey;
      const released = flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint(sessionId);
      clearHistorySessionOpenTransition(sessionId);
      startupTrace.markPhase('historical_session_initial_content_painted', {
        sessionId,
        latestTurnId,
        released,
        turnCount: turnSummaries.length,
      });
      setHistoryInitialContentPostPaintKey(releaseKey);
    };

    // The loading boundary already waits for complete content and the viewport
    // owner. Background reads start after that presentation has painted.
    const cancelAfterPaint = scheduleAfterStartupPaint(releaseAfterPaint, { frameCount: 2 });
    return () => {
      cancelled = true;
      cancelAfterPaint();
    };
  }, [
    activeSession?.historyState,
    activeSession?.sessionId,
    isHistoryContentPresented,
    isViewportActive,
    latestTurnId,
    surfaceScope.surfaceId,
    surfaceScope.epoch,
    turnSummaries.length,
  ]);

  const applyHistoryPresentation = useCallback((
    sessionId: string,
    presentation: SessionHistoryPresentation,
    options?: {
      completedBoundary?: SessionHistoryWindowDirection;
      viewportTarget?: {
        ordinal: number;
        turnId: string | null;
      };
    },
  ) => {
    invalidateHistoryPresentationOwner();
    setHistoryPresentation(previous => {
      const next: FlowChatHistoryPresentationState = {
        ...presentation,
        sessionId,
        revision: (previous?.sessionId === sessionId ? previous.revision : 0) + 1,
      };
      historyPresentationRef.current = next;
      return next;
    });
    if (options?.viewportTarget) {
      updateViewportIntent({
        kind: 'turn',
        sessionId,
        ordinal: options.viewportTarget.ordinal,
        turnId: options.viewportTarget.turnId,
        source: 'history-range',
      });
    }
    const completedBoundary = options?.completedBoundary;
    if (completedBoundary) {
      setHistoryBoundaryState(previous => ({
        ...previous,
        [completedBoundary]: 'idle',
      }));
    } else {
      setHistoryBoundaryState(IDLE_HISTORY_BOUNDARY_STATE);
    }
  }, [invalidateHistoryPresentationOwner, updateViewportIntent]);

  const restoreTailPresentation = useCallback((options?: {
    followLatest?: boolean;
    discardRecentHistory?: boolean;
  }) => {
    const sessionId = activeSession?.sessionId;
    if (!sessionId) {
      return false;
    }

    switchToLiveTailForSession(sessionId, {
      discardRecentHistory: options?.discardRecentHistory,
    });

    if (options?.followLatest) {
      requestAnimationFrame(() => {
        if (activeSessionIdRef.current === sessionId) {
          virtualListRef.current?.scrollToLatestEndPosition();
        }
      });
    }
    return true;
  }, [activeSession?.sessionId, switchToLiveTailForSession]);

  /*
   * Keep a tail-anchored history window anchored as the session grows.
   *
   * A window paged in from the tail stops at the newest Turn that existed when
   * it was cut. The session then appends a Turn and nothing moves the window's
   * end, so the transcript on screen silently stops at the previous Turn: the
   * message the user just sent is not rendered at all, and because
   * `latestTurnId` is read off the rendered items, follow-output never even
   * learns a new Turn exists — no pin, no follow, and no way to scroll to it.
   *
   * `resolveTailWindowGrowth` carries the reasoning and the reason it is not
   * edge-triggered; this effect is only the plumbing.
   */
  const tailAnchoredWindowEndRef = useRef<number | null>(null);
  useEffect(() => {
    const sessionId = activeSession?.sessionId;
    const windowEndOrdinalExclusive = sessionId
      ? renderedHistoryPresentation?.range.endOrdinalExclusive ?? null
      : null;
    const growth = resolveTailWindowGrowth({
      windowEndOrdinalExclusive,
      knownTurnCount: activeSessionKnownTurnCount,
      tailAnchoredWindowEnd: tailAnchoredWindowEndRef.current,
    });

    if (growth === 'release') {
      tailAnchoredWindowEndRef.current = null;
      return;
    }
    if (growth === 'anchor') {
      tailAnchoredWindowEndRef.current = windowEndOrdinalExclusive;
      return;
    }
    if (growth === 'none' || !sessionId || windowEndOrdinalExclusive === null) {
      return;
    }

    const extended = flowChatStore.extendSessionHistoryWindow(sessionId, 'after');
    // Requiring real growth keeps a store that declines to extend from being
    // re-applied under an ever-rising revision forever.
    if (extended && extended.range.endOrdinalExclusive > windowEndOrdinalExclusive) {
      tailAnchoredWindowEndRef.current = extended.range.endOrdinalExclusive;
      applyHistoryPresentation(sessionId, extended, { completedBoundary: 'after' });
      return;
    }

    // The newest Turn is not inside the loaded range this window was cut from.
    // Dropping back to the canonical tail costs a visible re-page of the
    // history above, which is why it is the fallback and not the rule — but it
    // is the only branch that always shows the message the user just sent.
    restoreTailPresentation();
  }, [
    activeSession?.sessionId,
    activeSessionKnownTurnCount,
    applyHistoryPresentation,
    renderedHistoryPresentation,
    restoreTailPresentation,
  ]);

  const jumpToLiveTail = useCallback(() => {
    return restoreTailPresentation({ followLatest: true });
  }, [restoreTailPresentation]);

  /*
   * A message sent from the composer gives up whatever history window is on
   * screen.
   *
   * `resolveTailWindowGrowth` deliberately leaves a navigated window alone as
   * the session grows, because a Turn arriving from elsewhere is no reason to
   * take a reader out of the history they are in. A Turn they submitted
   * themselves is, and nothing in the ledger tells the two apart — measured, a
   * message sent while parked on the first Turn left the transcript on a
   * 24-item window it was never in, with follow-output holding an answer it
   * had nothing to align.
   *
   * Deliberately not `followLatest`. Restoring the tail is enough: the Turn
   * comes into the transcript, and follow-output pins it to the viewport top
   * the way it pins any newly submitted Turn.
   */
  useEffect(() => {
    const handleMessageSubmitted = (event: Event) => {
      const { sessionId } = (event as CustomEvent<FlowChatMessageSubmittedRequest>).detail ?? {};
      const reaches = transcriptReachesLatestTurn({
        windowEndOrdinalExclusive: renderedHistoryPresentation?.range.endOrdinalExclusive ?? null,
        knownTurnCount: activeSessionKnownTurnCount,
      });
      if (!sessionId || sessionId !== activeSessionIdRef.current) return;
      if (reaches) {
        return;
      }
      restoreTailPresentation();
    };
    window.addEventListener(FLOWCHAT_MESSAGE_SUBMITTED_EVENT, handleMessageSubmitted);
    return () => {
      window.removeEventListener(FLOWCHAT_MESSAGE_SUBMITTED_EVENT, handleMessageSubmitted);
    };
  }, [
    activeSessionKnownTurnCount,
    renderedHistoryPresentation,
    restoreTailPresentation,
  ]);

  const handleTrajectoryRange = useCallback((range: TrajectoryRangeSummary | null, activate: boolean) => {
    const session = flowChatStore.getState().sessions.get(activeSessionIdRef.current ?? '');
    if (session) showTrajectoryRange(session, range, t('trajectory.rangeDetails'), activate, trajectoryViewId);
  }, [t, trajectoryViewId]);

  const navigateTrajectory = useTrajectoryNavigation({
    session: activeSession, items: virtualItems, listRef: virtualListRef, rootRef: chatScopeRef,
    present: applyHistoryPresentation, expand: handleExpandGroup, viewId: trajectoryViewId,
    selectionClearRequest: trajectorySelectionClearRequest,
  });
  const clearTrajectorySelection = useCallback(() => {
    setTrajectorySelection(undefined);
    setTrajectorySelectionClearRequest(value => value + 1);
    virtualListRef.current?.clearSearchMatch();
  }, []);
  const selectTrajectory = useCallback(async (selection: TrajectorySelection) => {
    const located = await navigateTrajectory(selection);
    if (located) setTrajectorySelection(selection);
    return located;
  }, [navigateTrajectory]);
  useEffect(() => globalEventBus.on<TrajectoryPanelData>(TRAJECTORY_NAVIGATE_EVENT, request => {
    if (!isViewportActive || request.viewId !== trajectoryViewId || request.surfaceId !== getActiveSurfaceScope().surfaceId
      || request.sessionId !== activeSessionIdRef.current) return;
    void selectTrajectory({ node: request.node, query: request.query }).catch(error => {
      log.warn('Failed to locate trajectory endpoint', { error });
    });
  }), [isViewportActive, trajectoryViewId, selectTrajectory]);

  const navigateToTurn = useCallback(async (target: FlowChatTurnRailItem | string) => {
    const targetItem = typeof target === 'string'
      ? turnRailItems.find(turn => turn.turnId === target)
      : target;
    const sessionId = activeSession?.sessionId;
    if (!targetItem || !sessionId) return false;

    const renderedTargetId = targetItem.turnId;
    const targetIsRendered = Boolean(
      renderedTargetId
      && renderedTurnSummaries.some(turn => turn.turnId === renderedTargetId),
    );
    if (renderedTargetId && targetIsRendered) {
      updateViewportIntent({
        kind: 'turn',
        sessionId,
        ordinal: targetItem.ordinal,
        turnId: renderedTargetId,
        source: isRenderingHistoryProjection ? 'history-range' : 'canonical-tail',
      });
      const navigationStatus = requestTurnNavigation(renderedTargetId);
      if (navigationStatus === 'settled' || navigationStatus === 'pending') {
        setQueuedTurnNavigation(null);
        return true;
      }
      setQueuedTurnNavigation({
        ordinal: targetItem.ordinal,
        turnId: renderedTargetId,
      });
      return true;
    }

    const recentHistoryPresentation = historyPresentationRef.current?.sessionId === sessionId
      ? historyPresentationRef.current
      : null;
    const recentHistoryTurn = recentHistoryPresentation
      ? recentHistoryPresentation.turns[
          targetItem.ordinal - recentHistoryPresentation.range.startOrdinal
        ]
      : undefined;
    const targetIsInRecentHistory = Boolean(
      recentHistoryPresentation
      && targetItem.ordinal >= recentHistoryPresentation.range.startOrdinal
      && targetItem.ordinal < recentHistoryPresentation.range.endOrdinalExclusive
      && recentHistoryTurn
      && (!targetItem.turnId || recentHistoryTurn.id === targetItem.turnId)
    );
    if (recentHistoryPresentation && targetIsInRecentHistory && recentHistoryTurn) {
      const reactivatedPresentation = flowChatStore.reactivateSessionHistoryWindow(
        sessionId,
        recentHistoryPresentation.range,
      );
      if (reactivatedPresentation) {
        const preparedNavigation = virtualListRef.current?.prepareTurnNavigation(recentHistoryTurn.id, {
          behavior: 'auto',
        }) ?? 'rejected';
        if (preparedNavigation !== 'rejected') {
          applyHistoryPresentation(sessionId, reactivatedPresentation, {
            viewportTarget: {
              ordinal: targetItem.ordinal,
              turnId: recentHistoryTurn.id,
            },
          });
          setQueuedTurnNavigation(null);
          return true;
        }
        flowChatStore.restoreSessionTailPresentation(sessionId);
      }
    }

    let result;
    try {
      result = await flowChatStore.loadSessionTurnWindow(sessionId, targetItem.ordinal, {
        source: 'target',
      });
    } catch (error) {
      log.warn('Failed to load the requested session Turn window', {
        sessionId,
        targetOrdinal: targetItem.ordinal,
        error,
      });
      return false;
    }

    if (result.status === 'ready' && result.isCurrent) {
      const targetTurnId = result.targetTurnId
        ?? result.range?.turns[result.targetOrdinal - (result.range?.startOrdinal ?? 0)]?.id
        ?? targetItem.turnId;
      if (!targetTurnId) {
        return false;
      }

      const preparedNavigation = virtualListRef.current?.prepareTurnNavigation(targetTurnId, {
        behavior: 'auto',
      }) ?? 'rejected';
      if (preparedNavigation === 'rejected') {
        return false;
      }
      const presentation = flowChatStore.activateSessionHistoryWindow(
        sessionId,
        result.targetOrdinal,
        result.navigationGeneration,
      );
      if (!presentation) {
        return false;
      }

      applyHistoryPresentation(sessionId, presentation, {
        viewportTarget: {
          ordinal: result.targetOrdinal,
          turnId: targetTurnId,
        },
      });
      setQueuedTurnNavigation(null);
      return true;
    }

    if (result.status === 'unsupported' || result.status === 'not-found') {
      const historyReady = await flowChatStore.ensureSessionFullHistory(
        sessionId,
        'turn-rail-navigation',
      );
      if (historyReady && activeSessionIdRef.current === sessionId) {
        restoreTailPresentation({ discardRecentHistory: true });
        updateViewportIntent({
          kind: 'turn',
          sessionId,
          ordinal: targetItem.ordinal,
          turnId: targetItem.turnId,
          source: 'canonical-tail',
        });
        setQueuedTurnNavigation({
          ordinal: targetItem.ordinal,
          turnId: targetItem.turnId,
        });
        return true;
      }
    }

    return false;
  }, [
    activeSession?.sessionId,
    applyHistoryPresentation,
    isRenderingHistoryProjection,
    renderedTurnSummaries,
    requestTurnNavigation,
    restoreTailPresentation,
    turnRailItems,
    updateViewportIntent,
  ]);

  // The rail is memoized; a click reads the committed navigation instead of
  // re-rendering the rail whenever one of its many inputs changes.
  const navigateToTurnRef = useRef(navigateToTurn);
  useLayoutEffect(() => { navigateToTurnRef.current = navigateToTurn; });
  const navigateFromTurnRail = useCallback((target: FlowChatTurnRailItem) => {
    void navigateToTurnRef.current(target);
  }, []);

  const handleNavigateToFocusTurn = useCallback(async (request: FlowChatFocusItemRequest) => {
    const sessionId = activeSession?.sessionId;
    if (!sessionId || request.sessionId !== sessionId) {
      return false;
    }

    const requestedTurnId = request.turnId?.trim() || null;
    const targetById = requestedTurnId
      ? turnRailItems.find(turn => turn.turnId === requestedTurnId)
      : undefined;
    if (targetById) {
      return navigateToTurn(targetById);
    }

    if (requestedTurnId) {
      const historyReady = await flowChatStore.ensureSessionFullHistory(
        sessionId,
        'flowchat-focus-navigation',
      );
      if (!historyReady || activeSessionIdRef.current !== sessionId) {
        return false;
      }
      const hydratedSession = flowChatStore.getState().sessions.get(sessionId);
      const hydratedTurnIndex = hydratedSession?.dialogTurns.findIndex(
        turn => turn.id === requestedTurnId,
      ) ?? -1;
      if (hydratedTurnIndex < 0) {
        return false;
      }

      restoreTailPresentation({ discardRecentHistory: true });
      updateViewportIntent({
        kind: 'turn',
        sessionId,
        ordinal: hydratedTurnIndex,
        turnId: requestedTurnId,
        source: 'canonical-tail',
      });
      setQueuedTurnNavigation({
        ordinal: hydratedTurnIndex,
        turnId: requestedTurnId,
      });
      return true;
    }

    const requestedOrdinal = typeof request.turnIndex === 'number'
      ? Math.max(0, Math.floor(request.turnIndex) - 1)
      : null;
    if (requestedOrdinal === null) {
      return false;
    }
    const targetByOrdinal = turnRailItems.find(turn => turn.ordinal === requestedOrdinal);
    return targetByOrdinal ? navigateToTurn(targetByOrdinal) : false;
  }, [
    activeSession?.sessionId,
    navigateToTurn,
    restoreTailPresentation,
    turnRailItems,
    updateViewportIntent,
  ]);

  useFlowChatNavigation({
    containerRef: chatScopeRef,
    isViewportActive,
    activeSessionId: activeSession?.sessionId,
    virtualItems,
    virtualListRef,
    onExpandExploreGroup: handleExpandGroup,
    onNavigateToFocusTurn: handleNavigateToFocusTurn,
  });

  const handleRetryHistoryLoad = useCallback(() => {
    const sessionId = activeSession?.sessionId;
    if (!sessionId) return;
    if (historyRestore?.sessionId === sessionId && historyRestore.status === 'failed') {
      setHistoryRestoreRetry(retry => retry + 1);
      return;
    }
    void FlowChatManager.getInstance().switchChatSession(sessionId);
  }, [activeSession?.sessionId, historyRestore]);

  const handleRetryPausedUpdates = useCallback(() => {
    const sessionId = activeSession?.sessionId;
    if (!sessionId) return;
    void flowChatStore.reloadRelaySessionFromHost(sessionId).catch(error => {
      log.warn('Failed to resume paused device updates', { sessionId, error });
    });
  }, [activeSession?.sessionId]);

  const handleHistoryWindowBoundaryIntent = useCallback((
    direction: SessionHistoryWindowDirection,
    options?: HistoryWindowBoundaryIntentOptions,
  ): Promise<HistoryWindowBoundaryIntentResult> => {
    const existingRequest = historyBoundaryRequestsRef.current[direction];
    if (existingRequest && !options?.synchronizeHistory) {
      return existingRequest;
    }

    const request = (async () => {
      const currentViewportIntent = viewportIntentRef.current;
      const presentation = currentViewportIntent?.kind === 'turn'
        && currentViewportIntent.source === 'history-range'
        ? historyPresentationRef.current
        : null;
      const sessionId = activeSessionIdRef.current;
      const presentationOwnerGeneration = historyPresentationOwnerGenerationRef.current;
      if (!sessionId || (presentation && presentation.sessionId !== sessionId)) {
        return 'cancelled';
      }

      const scope = getActiveSurfaceScope();
      const isCurrent = () => scope.isCurrent()
        && activeSessionIdRef.current === sessionId
        && historyPresentationOwnerGenerationRef.current === presentationOwnerGeneration
        && options?.isCurrent?.() !== false;
      if (options?.synchronizeHistory) {
        setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
        try {
          await flowChatStore.synchronizeSessionHistory(sessionId, isCurrent);
          if (!isCurrent()) return 'cancelled';
        } catch (error) {
          if (!isCurrent() || isSurfaceChangedError(error)) return 'cancelled';
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', { direction, reason: 'source-synchronization-failed' });
          log.warn('Failed to synchronize session history from its owner', { sessionId, direction, error });
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        }
      }
      // A catalog refresh or cache eviction can retire the store's window
      // while the reader still displays its copy. Reacquire that exact range
      // before extending it; repeatedly fetching the adjacent page cannot
      // restore a missing active window, even after an explicit source sync.
      const activeRange = flowChatStore.getSessionHistoryViewState(sessionId)?.activeRange;
      if (presentation && (!activeRange
        || activeRange.startOrdinal !== presentation.range.startOrdinal
        || activeRange.endOrdinalExclusive !== presentation.range.endOrdinalExclusive)) {
        setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
        try {
          const restored = await flowChatStore.restoreSessionHistoryWindow(sessionId, presentation.range, isCurrent);
          if (!isCurrent()) return 'cancelled';
          if (!restored) throw new Error('The reader history range is no longer available');
        } catch (error) {
          if (!isCurrent() || isSurfaceChangedError(error)) return 'cancelled';
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', { direction, reason: 'reader-range-restore-failed' });
          log.warn('Failed to reacquire reader history range', { sessionId, direction, error });
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        }
      }
      const session = flowChatStore.getState().sessions.get(sessionId);
      if (scope.surfaceId !== 'local' && !presentation) {
        if (direction === 'after' || session?.isPartial === false) {
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
          return 'exhausted';
        }
        setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
        try {
          const prepared = await options?.prepareViewportForPresentationCommit?.();
          if (prepared === false || !isCurrent()) {
            options?.cancelViewportPresentationCommit?.();
            return 'cancelled';
          }
          const loaded = await flowChatStore.loadOlderRelaySessionHistory(sessionId);
          if (!isCurrent()) return 'cancelled';
          return loaded ? 'applied' : 'exhausted';
        } catch (error) {
          options?.cancelViewportPresentationCommit?.();
          if (isSurfaceChangedError(error)) return 'cancelled';
          log.error('Relay history page failed', { sessionId, error });
          if (isCurrent()) setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        } finally {
          if (isCurrent()) {
            setHistoryBoundaryState(previous => previous[direction] === 'error'
              ? previous : { ...previous, [direction]: 'idle' });
          }
        }
      }
      const historyView = flowChatStore.getSessionHistoryViewState(sessionId);
      const totalTurnCount = Math.max(
        historyView?.catalog?.totalTurnCount ?? 0,
        session?.totalTurnCount ?? 0,
      );
      const loadedTurnCount = session?.dialogTurns.length ?? 0;
      recordHistoryPagingEvent(sessionId, 'requested', {
        direction,
        hasPresentation: presentation !== null,
        isPartial: session?.isPartial,
        historyState: session?.historyState,
        turnCatalogMatches: session?.turnCatalog?.sessionId === sessionId,
        catalogTotalTurnCount: historyView?.catalog?.totalTurnCount ?? null,
        sessionTotalTurnCount: session?.totalTurnCount ?? null,
        resolvedTotalTurnCount: totalTurnCount,
        loadedTurnCount,
        loadedRangeCount: historyView?.loadedRanges.length ?? null,
      });

      /*
       * The range the ask is derived from is the one on screen, which is the
       * continuous projection when that is what is rendered. `presentation`
       * stays the store's window, because the extension below operates on it.
       */
      let renderedRange: RenderedTranscriptRange | null =
        renderedHistoryPresentationRef.current?.sessionId === sessionId
          ? renderedHistoryPresentationRef.current.range
          : null;
      if (!presentation) {
        const precondition = resolveTailBoundaryPrecondition({
          direction,
          isPartial: session?.isPartial,
          hasSession: session !== undefined,
          turnCatalogMatches: session?.turnCatalog?.sessionId === sessionId,
        });
        if (precondition !== 'ask') {
          /*
           * Told apart because only one of them stops the asking. A boundary
           * that answers `cancelled` is re-armed and asked again on the
           * reader's next scroll event, which is right while the catalog is
           * still on its way and is a treadmill once the session has every Turn
           * it will ever have.
           */
          recordHistoryPagingEvent(
            sessionId,
            precondition === 'exhausted' ? 'outcome_exhausted' : 'outcome_cancelled',
            {
              direction,
              reason: precondition === 'exhausted' ? 'no-window-nothing-loadable' : 'precondition',
              isPartial: session?.isPartial,
              turnCatalogMatches: session?.turnCatalog?.sessionId === sessionId,
            },
          );
          if (precondition === 'exhausted') setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
          return precondition;
        }
        const canonicalTailRange = flowChatStore.getSessionCanonicalTailRange(sessionId);
        if (!canonicalTailRange) {
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
            direction,
            reason: 'no-canonical-tail-range',
          });
          return 'not-ready';
        }
        // No window, so the transcript on screen is the canonical tail: it
        // starts where that range does and runs to the newest Turn.
        renderedRange = {
          startOrdinal: canonicalTailRange.startOrdinal,
          endOrdinalExclusive: totalTurnCount,
        };
        recordHistoryPagingEvent(sessionId, 'target_resolved', {
          direction,
          canonicalTailStartOrdinal: canonicalTailRange.startOrdinal,
          targetOrdinal: canonicalTailRange.startOrdinal - 1,
        });
      }
      if (!renderedRange) {
        recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
          direction,
          reason: 'no-rendered-range',
        });
        return 'not-ready';
      }
      const target = resolveHistoryBoundaryTarget({
        direction,
        renderedRange,
        knownTurnCount: totalTurnCount,
      });
      if (target.status === 'exhausted') {
        recordHistoryPagingEvent(sessionId, 'outcome_exhausted', {
          direction,
          reason: target.reason,
          renderedStartOrdinal: renderedRange.startOrdinal,
          renderedEndOrdinalExclusive: renderedRange.endOrdinalExclusive,
          windowEndOrdinalExclusive: presentation?.range.endOrdinalExclusive ?? null,
          totalTurnCount,
        });
        /*
         * `exhausted` latches the direction off until the window moves, so
         * reaching it on an unknown or contradictory total is how history goes
         * silently missing rather than merely late.
         *
         * `reached-latest` is not that. It is what the bottom edge of a live
         * transcript answers every time the reader arrives at it.
         */
        if (target.reason === 'beyond-known-total') {
          warnHistoryPagingRefusedWithPendingTurns(sessionId, {
            direction,
            reason: totalTurnCount <= 0 ? 'exhausted-on-unknown-total' : 'exhausted-beyond-total',
            isPartial: session?.isPartial,
            loadedTurnCount,
            totalTurnCount,
            targetOrdinal: renderedRange.startOrdinal - 1,
          });
        }
        setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
        return 'exhausted';
      }
      const targetOrdinal = target.targetOrdinal;

      setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
      let viewportPreparationStarted = false;
      try {
        const result = direction === 'before'
          ? await flowChatStore.loadPreviousSessionTurnWindow(sessionId, targetOrdinal)
          : await flowChatStore.loadSessionTurnWindow(sessionId, targetOrdinal, {
            source: 'prefetch',
            before: 4,
            after: 12,
          });
        if (!result.isCurrent || !isCurrent()) {
          recordHistoryPagingEvent(sessionId, 'outcome_cancelled', {
            direction,
            reason: 'superseded',
            targetOrdinal,
            resultIsCurrent: result.isCurrent,
            activeSessionIsCurrent: activeSessionIdRef.current === sessionId,
          });
          /*
           * The status is ours to clear even though the load was not ours to
           * finish. Left as it was, this returns silently with the boundary
           * still reading `loading`, and the reader is shown history being
           * prepared by nobody for the rest of the session.
           */
          if (isCurrent()) {
            setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
          }
          return 'cancelled';
        }
        if (result.status !== 'ready') {
          if (result.status === 'unsupported') {
            const historyReady = await flowChatStore.ensureSessionFullHistory(
              sessionId,
              'sequential-history-navigation',
            );
            if (historyReady && isCurrent()) {
              recordHistoryPagingEvent(sessionId, 'outcome_applied', {
                direction,
                targetOrdinal,
                reason: 'full-history-hydrated',
              });
              setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
              return 'applied';
            }
          }
          /*
           * A refusal the reader is shown. It was silent here, and a status the
           * boundary keeps forever deserves a line saying which load produced
           * it: 266 asks in one session all landed on `not-found` and left the
           * status standing, with nothing in the trail between the ask and the
           * complaint.
           */
          if (!isCurrent()) return 'cancelled';
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
            direction,
            reason: `load-${result.status}`,
            targetOrdinal,
            surfaceId: scope.surfaceId,
            remoteWorkspace: Boolean(session?.remoteConnectionId || session?.remoteSshHost),
            requestedCatalogRevision: session?.turnCatalog?.revision ?? null,
            currentCatalogRevision: flowChatStore.getSessionHistoryViewState(sessionId)?.catalog?.revision ?? null,
          });
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        }

        viewportPreparationStarted = Boolean(options?.prepareViewportForPresentationCommit);
        const preparationResult = await options?.prepareViewportForPresentationCommit?.();
        const activeSessionIsCurrent = activeSessionIdRef.current === sessionId;
        const presentationOwnerIsCurrent = (
          historyPresentationOwnerGenerationRef.current === presentationOwnerGeneration
        );
        if (
          preparationResult === false
          || !activeSessionIsCurrent
          || !presentationOwnerIsCurrent
          || !isCurrent()
        ) {
          recordHistoryPagingEvent(sessionId, 'outcome_cancelled', {
            direction,
            reason: 'viewport-preparation',
            preparationResult: preparationResult ?? null,
            activeSessionIsCurrent,
            presentationOwnerIsCurrent,
          });
          if (preparationResult === false && activeSessionIsCurrent) {
            // The window was fetched and then thrown away: the Turns exist but
            // never reach the transcript, and the boundary status goes back to
            // idle exactly as if there were none.
            warnHistoryPagingRefusedWithPendingTurns(sessionId, {
              direction,
              reason: 'viewport-preparation-declined',
              isPartial: session?.isPartial,
              loadedTurnCount,
              totalTurnCount,
              targetOrdinal,
            });
          }
          if (viewportPreparationStarted) {
            options?.cancelViewportPresentationCommit?.();
          }
          if (activeSessionIsCurrent) {
            setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'idle' }));
          }
          return 'cancelled';
        }

        const nextPresentation = presentation
          ? flowChatStore.extendSessionHistoryWindow(sessionId, direction)
          : flowChatStore.activateSessionHistoryWindowFromTail(sessionId, targetOrdinal);
        if (!nextPresentation) {
          const currentHistoryView = flowChatStore.getSessionHistoryViewState(sessionId);
          if (viewportPreparationStarted) {
            options?.cancelViewportPresentationCommit?.();
          }
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
            direction,
            reason: 'no-next-presentation',
            targetOrdinal,
            surfaceId: scope.surfaceId,
            remoteWorkspace: Boolean(session?.remoteConnectionId || session?.remoteSshHost),
            currentCatalogRevision: currentHistoryView?.catalog?.revision ?? null,
            renderedStartOrdinal: renderedRange.startOrdinal,
            renderedEndOrdinalExclusive: renderedRange.endOrdinalExclusive,
            activeStartOrdinal: currentHistoryView?.activeRange?.startOrdinal ?? null,
            activeEndOrdinalExclusive: currentHistoryView?.activeRange?.endOrdinalExclusive ?? null,
          });
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        }
        applyHistoryPresentation(sessionId, nextPresentation, {
          completedBoundary: direction,
          ...(!presentation ? {
            viewportTarget: {
              ordinal: targetOrdinal,
              turnId: nextPresentation.turns[
                targetOrdinal - nextPresentation.range.startOrdinal
              ]?.id ?? null,
            },
          } : {}),
        });
        recordHistoryPagingEvent(sessionId, 'outcome_applied', {
          direction,
          targetOrdinal,
          startOrdinal: nextPresentation.range.startOrdinal,
          endOrdinalExclusive: nextPresentation.range.endOrdinalExclusive,
        });
        return 'applied';
      } catch (error) {
        if (viewportPreparationStarted) {
          options?.cancelViewportPresentationCommit?.();
        }
        if (isCurrent()) {
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
        }
        if (!isCurrent()) return 'cancelled';
        log.warn('Failed to prefetch an adjacent session Turn window', {
          sessionId,
          direction,
          targetOrdinal,
          error,
        });
        return 'not-ready';
      }
    })().finally(() => {
      // A session switch can install another request before this one settles.
      // Only the request that owns the slot may release it.
      if (historyBoundaryRequestsRef.current[direction] === request) {
        historyBoundaryRequestsRef.current[direction] = null;
      }
    });
    historyBoundaryRequestsRef.current[direction] = request;
    return request;
  }, [applyHistoryPresentation]);

  useEffect(() => {
    if (!activeSession?.sessionId) {
      return;
    }

    useBackgroundSubagentActivityStore
      .getState()
      .reconcileParent(flowChatStore.getState(), activeSession.sessionId);
  }, [activeSession?.dialogTurns.length, activeSession?.historyState, activeSession?.sessionId]);

  useEffect(() => {
    const agentSessionId = activeSession?.sessionId;
    if (!agentSessionId || shouldDeferBackgroundCommandSnapshot) {
      return;
    }

    let cancelled = false;
    let cancelScheduledSnapshot: (() => void) | null = null;
    const recoverSnapshot = () => {
      const pendingHistoryTransition = getHistorySessionOpenTransitionSnapshot();
      if (
        cancelled ||
        activeSessionIdRef.current !== agentSessionId ||
        (pendingHistoryTransition && pendingHistoryTransition.sessionId !== agentSessionId)
      ) {
        return;
      }

      void agentAPI.listBackgroundCommandActivities({ agentSessionId })
        .then((response) => {
          const currentHistoryTransition = getHistorySessionOpenTransitionSnapshot();
          if (
            !cancelled &&
            activeSessionIdRef.current === agentSessionId &&
            (!currentHistoryTransition || currentHistoryTransition.sessionId === agentSessionId)
          ) {
            useBackgroundCommandActivityStore
              .getState()
              .hydrateActivities(agentSessionId, response.activities);
          }
        })
        .catch(() => {
          /* Snapshot recovery is best-effort; live events remain authoritative. */
        });
    };

    if (shouldScheduleBackgroundCommandSnapshotAfterPaint) {
      cancelScheduledSnapshot = scheduleAfterStartupPaint(recoverSnapshot, { frameCount: 2 });
    } else {
      recoverSnapshot();
    }

    return () => {
      cancelled = true;
      cancelScheduledSnapshot?.();
    };
  }, [
    activeSession?.sessionId,
    shouldScheduleBackgroundCommandSnapshotAfterPaint,
    shouldDeferBackgroundCommandSnapshot,
  ]);

  const backgroundCommands = useMemo(
    () => visibleBackgroundCommandActivitiesForSession(
      backgroundCommandActivities,
      activeSession?.sessionId,
    ).map(backgroundCommandSummaryFromActivity),
    [activeSession?.sessionId, backgroundCommandActivities],
  );
  const [hasActiveSessionTreeDescendants, setHasActiveSessionTreeDescendants] = useState(() =>
    hasActiveSessionLineageDescendants(activeSession?.sessionId, flowChatStore.getState().sessions),
  );

  useEffect(() => {
    const rootSessionId = activeSession?.sessionId;
    const updateActivity = (sessions: Map<string, Session>) => {
      setHasActiveSessionTreeDescendants(
        hasActiveSessionLineageDescendants(rootSessionId, sessions),
      );
    };

    updateActivity(flowChatStore.getState().sessions);
    return flowChatStore.subscribeSelector(
      state => hasActiveSessionLineageDescendants(rootSessionId, state.sessions),
      setHasActiveSessionTreeDescendants,
    );
  }, [activeSession?.sessionId]);

  useEffect(() => {
    if (stoppingBackgroundCommandIds.size === 0) {
      return;
    }

    const runningCommandIds = new Set(
      backgroundCommands
        .filter(command => command.status === 'running')
        .map(command => command.execSessionKey),
    );
    if (import.meta.env.DEV && shouldShowMockBackgroundCommands()) {
      for (const command of MOCK_BACKGROUND_COMMANDS) {
        if (command.status === 'running') {
          runningCommandIds.add(command.execSessionKey);
        }
      }
    }
    setStoppingBackgroundCommandIds((previous) => {
      const next = new Set([...previous].filter(commandKey => runningCommandIds.has(commandKey)));
      return next.size === previous.size ? previous : next;
    });
  }, [backgroundCommands, stoppingBackgroundCommandIds.size]);

  const handleOpenSessionTreeSession = useCallback((selection: SessionTreeSelection) => {
    if (
      !activeSession?.sessionId ||
      selection.isRoot ||
      selection.sessionId === activeSession.sessionId ||
      !selection.parentSessionId
    ) {
      return;
    }

    openBtwSessionInAuxPane({
      childSessionId: selection.sessionId,
      parentSessionId: selection.parentSessionId,
      workspaceId: selection.workspaceId || activeSession.workspaceId || activeSession.config?.workspaceId,
      workspacePath: selection.workspacePath || activeSession.workspacePath,
      sessionKind: 'subagent',
      sessionTitle: selection.displayTitle,
      agentType: selection.agentType,
      parentToolCallId: selection.parentToolCallId,
      subagentType: selection.subagentType,
      remoteConnectionId: selection.remoteConnectionId || activeSession.remoteConnectionId,
      remoteSshHost: selection.remoteSshHost || activeSession.remoteSshHost,
      includeInternal: true,
    });
  }, [activeSession]);

  const handleCancelSessionTreeSession = useCallback(async (selection: SessionTreeSelection) => {
    try {
      const result = await agentAPI.cancelSession(selection.sessionId, { cancelDescendants: false });
      if (!result.cancelled) {
        notificationService.error(
          t('flowChatHeader.agentTreeCancelFailed'),
          { duration: 5000 },
        );
      }
      return result.cancelled;
    } catch (_error) {
      notificationService.error(
        t('flowChatHeader.agentTreeCancelFailed'),
        { duration: 5000 },
      );
      return false;
    }
  }, [t]);

  const handleDeleteSessionTreeSession = useCallback(async (selection: SessionTreeSelection, anchor?: ReturnType<typeof captureConfirmationAnchor>) => {
    if (selection.isRoot) return false;
    if (activeSession && resolveSessionDriverId(activeSession.sessionId, activeSession) === 'dispatch') {
      notificationService.error(t('flowChatHeader.agentTreeDeleteUnsupported'), { duration: 5000 });
      return false;
    }
    const scope = getActiveSurfaceScope();
    try {
      const confirmed = await confirmDanger(
        t('flowChatHeader.agentTreeDelete'),
        t('flowChatHeader.agentTreeDeleteConfirm', { name: selection.displayTitle }),
        { anchor, confirmText: t('flowChatHeader.agentTreeDelete') },
      );
      if (!confirmed) return false;
      await deleteSessionTreeBranch({ sessionId: selection.sessionId, workspaceId: requireSessionOwningWorkspaceId(flowChatStore.getState().sessions.get(selection.sessionId) || activeSession!) }, scope);
      return true;
    } catch (error) {
      if (!isSurfaceChangedError(error)) {
        notificationService.error(t('flowChatHeader.agentTreeDeleteFailed'), { duration: 5000 });
      }
      return false;
    }
  }, [activeSession, t]);

  const handleOpenBackgroundCommandOutput = useCallback((command: FlowChatHeaderCommandSummary) => {
    createBackgroundCommandOutputTab({
      execSessionKey: command.execSessionKey,
      execSessionId: command.execSessionId,
      remote: command.remote === true,
      title: command.title || t('backgroundCommandOutput.title'),
      command: command.command,
      mockKind: import.meta.env.DEV && command.execSessionKey.startsWith('mock:')
        ? command.execSessionKey.slice('mock:'.length)
        : undefined,
    });
  }, [t]);

  const handleRequestBackgroundCommandInput = useCallback((command: FlowChatHeaderCommandSummary) => {
    if (command.status !== 'running' || command.tty !== true) {
      return;
    }
    setBackgroundCommandInputTarget(command);
  }, []);

  const handleCloseBackgroundCommandInput = useCallback(() => {
    if (isSendingBackgroundCommandInput) {
      return;
    }
    setBackgroundCommandInputTarget(null);
  }, [isSendingBackgroundCommandInput]);

  const handleSendBackgroundCommandInput = useCallback(async (
    request: { chars: string; appendEnter: boolean },
  ) => {
    const command = backgroundCommandInputTarget;
    if (!command) {
      return;
    }

    setIsSendingBackgroundCommandInput(true);
    try {
      if (import.meta.env.DEV && command.execSessionKey.startsWith('mock:')) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
      } else {
        await agentAPI.sendBackgroundCommandInput({
          execSessionId: command.execSessionId,
          remote: command.remote === true,
          chars: request.chars,
          appendEnter: request.appendEnter,
        });
      }
      setBackgroundCommandInputTarget(null);
      notificationService.success(
        t('backgroundCommandInput.sendSucceeded'),
        { duration: 2500 },
      );
    } catch (_error) {
      notificationService.error(
        t('backgroundCommandInput.sendFailed'),
        { duration: 5000 },
      );
    } finally {
      setIsSendingBackgroundCommandInput(false);
    }
  }, [backgroundCommandInputTarget, t]);

  const handleStopBackgroundCommand = useCallback(async (command: FlowChatHeaderCommandSummary) => {
    if (command.status !== 'running') {
      return;
    }

    setStoppingBackgroundCommandIds((previous) => new Set(previous).add(command.execSessionKey));

    if (import.meta.env.DEV && command.execSessionKey.startsWith('mock:')) {
      window.setTimeout(() => {
        setStoppingBackgroundCommandIds((previous) => {
          const next = new Set(previous);
          next.delete(command.execSessionKey);
          return next;
        });
      }, 1200);
      return;
    }

    try {
      await agentAPI.controlBackgroundCommand({
        execSessionId: command.execSessionId,
        action: 'interrupt',
        remote: command.remote === true,
      });
    } catch (_error) {
      setStoppingBackgroundCommandIds((previous) => {
        const next = new Set(previous);
        next.delete(command.execSessionKey);
        return next;
      });
      notificationService.error(
        t('flowChatHeader.backgroundCommandStopFailed'),
        { duration: 5000 },
      );
    }
  }, [t]);

  const showMockBackgroundCommands = shouldShowMockBackgroundCommands();
  const headerBackgroundCommands = useMemo(
    () => (showMockBackgroundCommands
      ? [...backgroundCommands, ...MOCK_BACKGROUND_COMMANDS]
      : backgroundCommands
    ).map(command => ({
      ...command,
      isStopping: stoppingBackgroundCommandIds.has(command.execSessionKey),
    })),
    [backgroundCommands, showMockBackgroundCommands, stoppingBackgroundCommandIds],
  );
  const handleStopAllBackgroundCommands = useCallback(() => {
    for (const command of headerBackgroundCommands) {
      if (command.status !== 'running' || command.isStopping === true) {
        continue;
      }
      void handleStopBackgroundCommand(command);
    }
  }, [handleStopBackgroundCommand, headerBackgroundCommands]);

  useShortcut(
    'chat.newSession',
    { key: 'N', ctrl: true, scope: 'chat' },
    () => {
      void (async () => {
        try {
          await FlowChatManager.getInstance().createChatDraft(
            flowChatSessionConfigForCurrentWorkspace(activeWorkspace),
          );
        } catch (error) {
          log.error('Failed to create session from shortcut', { error });
        }
      })();
    },
    { priority: 10, description: 'keyboard.shortcuts.chat.newSession' }
  );

  useShortcut(
    'btw-fill',
    { key: 'B', ctrl: true, alt: true, scope: 'chat', allowInInput: true },
    () => {
      const selected = (window.getSelection?.()?.toString() ?? '').trim();
      const message = selected ? `/btw Explain this:\n\n${selected}` : '/btw ';
      window.dispatchEvent(new CustomEvent('fill-chat-input', { detail: { message, sessionId: activeSession?.sessionId } }));
    },
    { priority: 20, description: 'keyboard.shortcuts.chat.btwFill' }
  );

  useShortcut(
    'chat.search',
    { key: 'F', ctrl: true, scope: 'chat', allowInInput: false },
    () => {
      setSearchOpenRequest(prev => prev + 1);
    },
    { priority: 15, description: 'keyboard.shortcuts.chat.search' }
  );

  useShortcut(
    'chat.insertNewline',
    { key: 'Enter', ctrl: true, scope: 'chat', allowInInput: true },
    () => {
      document.execCommand('insertLineBreak');
    },
    { priority: 25, description: 'keyboard.shortcuts.chat.insertNewline' }
  );

  return (
    <FlowChatContext.Provider value={contextValue}>
      <ConversationExcerptSourceProvider sessionId={activeSession?.sessionId} active={isViewportActive}>
      <FlowChatVolatileContext.Provider value={volatileContextValue}>
      <div
        ref={chatScopeRef}
        className={`modern-flowchat-container flow-chat-typography ${className}`}
        data-shortcut-scope="chat"
        data-testid="flowchat-container"
        data-flowchat-selection-root={activeSession?.sessionId ?? ''}
        tabIndex={-1}
        data-session-id={activeSession?.sessionId ?? ''}
        data-openbitfun-component="modern-flow-chat"
        data-openbitfun-part="root"
      >
        <FlowChatSelectionBar rootRef={chatScopeRef} sessionId={activeSession?.sessionId} active={isViewportActive}
          onSelectionIntent={() => virtualListRef.current?.notifyUserSelectionIntent()} />
        <FlowChatHeader
          visible={showSessionTranscript}
          sessionId={activeSession?.sessionId}
          isRightPanelOpen={isRightPanelOpen}
          onToggleRightPanel={onToggleRightPanel}
          onTrajectoryOpen={openTrajectory}
          trajectoryOpen={trajectoryOpen}
          searchQuery={trajectorySearchInput} onSearchChange={setTrajectorySearchInput}
          searchMatchCount={trajectorySearchState.count} searchCurrentMatch={trajectorySearchState.current}
          onSearchNext={() => trajectoryRef.current?.next()} onSearchPrev={() => trajectoryRef.current?.previous()}
          onSearchClose={closeTrajectory}
          searchOpenRequest={searchOpenRequest}
          backgroundCommands={headerBackgroundCommands}
          onOpenSessionTreeSession={handleOpenSessionTreeSession}
          hasActiveSessionTreeDescendants={hasActiveSessionTreeDescendants}
          onCancelSessionTreeSession={handleCancelSessionTreeSession}
          onDeleteSessionTreeSession={handleDeleteSessionTreeSession}
          onOpenBackgroundCommandOutput={handleOpenBackgroundCommandOutput}
          onRequestBackgroundCommandInput={handleRequestBackgroundCommandInput}
          onStopBackgroundCommand={handleStopBackgroundCommand}
          onStopAllBackgroundCommands={handleStopAllBackgroundCommands}
        />

        {trajectoryOpen && activeSession && <TrajectoryExplorer
          ref={trajectoryRef}
          key={surfaceScope.key('trajectory', activeSession.sessionId)} session={activeSession}
          searchInput={trajectorySearchInput} onQueryChange={setSearchQuery} onSearchStateChange={setTrajectorySearchState}
          onSelect={selectTrajectory} onClose={closeTrajectory} onRangeChange={handleTrajectoryRange}
          onClearSelection={clearTrajectorySelection}
          selectedNodeKey={trajectorySelection ? trajectoryNodeKey(trajectorySelection.node) : undefined} />}

        <BackgroundCommandInputDialog
          command={backgroundCommandInputTarget}
          isSending={isSendingBackgroundCommandInput}
          onClose={handleCloseBackgroundCommandInput}
          onSend={handleSendBackgroundCommandInput}
        />

        {showUpdatesPaused ? (
          <PeerUpdatesPausedNotice
            surfaceId={surfaceScope.surfaceId}
            onRetry={handleRetryPausedUpdates}
          />
        ) : null}
        <div
          className="modern-flowchat-container__messages"
          data-testid="flowchat-messages"
          data-openbitfun-component="modern-flow-chat"
          data-openbitfun-part="messages"
          data-active-session-id={activeSession?.sessionId ?? ''}
          data-history-state={historyState ?? 'none'}
          data-context-restore-state={activeSession?.contextRestoreState ?? 'none'}
          data-is-partial={activeSession?.isPartial === true ? 'true' : 'false'}
          data-dialog-turn-count={activeSession?.dialogTurns.length ?? 0}
          data-virtual-item-count={virtualItems.length}
          data-show-history-placeholder={showHistoryPlaceholder ? 'true' : 'false'}
          data-show-history-transition-overlay={shouldBlockHistoryTransitionInteraction ? 'true' : 'false'}
          data-show-history-loading-layer={showHistoryLoadingLayer ? 'true' : 'false'}
          data-show-history-open-intent-overlay={showHistoryOpenIntentOverlay ? 'true' : 'false'}
          data-has-pending-history-completion={hasPendingHistoryCompletion ? 'true' : 'false'}
          data-has-deferred-history-projection={hasDeferredHistoryProjection ? 'true' : 'false'}
          data-presentation-mode={isRenderingHistoryProjection ? 'history-window' : 'tail'}
          data-viewport-intent={activeViewportIntent?.kind ?? 'live-tail'}
          data-latest-turn-id={latestTurnId ?? ''}
          data-history-initial-content-ready={isHistoryContentPresented ? 'true' : 'false'}
          data-pending-history-open-session-id={pendingHistoryOpenSession?.sessionId ?? ''}
          onClickCapture={blockHistoryOverlayActivation}
          onContextMenuCapture={blockHistoryOverlayActivation}
          onMouseDownCapture={blockHistoryOverlayActivation}
          onPointerDownCapture={blockHistoryOverlayActivation}
        >
          <HistorySessionLoadingBoundary
            identity={historyLoadingIdentity}
            loading={showHistoryLoadingLayer || showHistoryOpenIntentOverlay}
            hasTranscript={showSessionTranscript && activeHistoryRestore?.status !== 'loading' && !showFailedHistoryPlaceholder}
            disabled={showFailedHistoryPlaceholder || !isViewportActive}
            intent={showHistoryOpenIntentOverlay}
            label={t('historyState.loadingTitle')}
            onPresentationChange={handleHistoryPresentationChange}
          >
            {showFailedHistoryPlaceholder ? (
              <HistorySessionPlaceholder
                state="failed"
                onRetry={handleRetryHistoryLoad}
              />
            ) : activeHistoryRestore?.status === 'loading' ? null : !showSessionTranscript ? (
              showHistoryPlaceholder || showHistoryOpenIntentOverlay ? null : (
                emptyState !== undefined ? emptyState : (
                  <WelcomePanel
                    key={surfaceScope.key('welcome', surfaceScope.epoch,
                      activeSession?.sessionId ?? '', activeSession?.draft?.workspaceId ?? '')}
                    session={activeSession}
                    isActive={isViewportActive}
                    onQuickAction={(command) => {
                      window.dispatchEvent(new CustomEvent('fill-chat-input', {
                        detail: { message: command, sessionId: activeSession?.sessionId }
                      }));
                    }}
                  />
                )
              )
            ) : (
              <>
                <VirtualMessageList
                  ref={virtualListRef}
                  viewportRectRef={paneViewportRect}
                  contentPresented={isHistoryContentPresented}
                  items={virtualItems}
                  latestTurnId={latestTurnId}
                  isViewportActive={isViewportActive}
                  measurementSuspended={resizeSuspended}
                  contentWidth={contentWidth}
                  presentationMode={isRenderingHistoryProjection ? 'history-window' : 'tail'}
                  viewportMode={isViewportDetachedFromLiveTail ? 'history-reading' : 'live-tail'}
                  historyWindow={isShowingHistoryPresentation ? activeHistoryPresentation?.range ?? null : null}
                  presentationRevision={isShowingHistoryPresentation ? activeHistoryPresentation?.revision ?? 0 : 0}
                  historyBoundaryState={historyBoundaryState}
                  onHistoryWindowBoundaryIntent={handleHistoryWindowBoundaryIntent}
                  onRequestJumpToLatest={jumpToLiveTail}
                  onUserScrollIntent={handleVirtualListUserScrollIntent}
                  onViewportSnapshot={handleViewportSnapshot}
                  onViewportRestoreSettled={handleViewportRestoreSettled}
                  initialViewportSnapshot={activeSessionViewportSnapshot}
                />
              </>
            )}
            {showSessionTranscript ? (
              <FlowChatTurnRail
                turns={turnRailItems}
                currentTurnId={effectiveVisibleTurnInfo?.turnId ?? null}
                visibleTurnIds={effectiveVisibleTurnInfo?.visibleTurnIds ?? NO_VISIBLE_TURN_IDS}
                onNavigate={navigateFromTurnRail}
              />
            ) : null}
          </HistorySessionLoadingBoundary>
        </div>
      </div>
      </FlowChatVolatileContext.Provider>
      </ConversationExcerptSourceProvider>
    </FlowChatContext.Provider>
  );
};

ModernFlowChatContainer.displayName = 'ModernFlowChatContainer';
