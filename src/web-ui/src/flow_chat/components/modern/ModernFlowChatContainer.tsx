import { requireSessionWorkspaceId } from '../../utils/sessionWorkspace';
/**
 * Modern FlowChat container.
 * Uses virtual scrolling with Zustand and syncs legacy store state.
 */

import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect, useState } from 'react';
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
import {
  FlowChatContext,
  FlowChatContextValue,
  FlowChatVolatileContext,
  FlowChatVolatileContextValue,
} from './FlowChatContext';
import { useExploreGroupState } from './useExploreGroupState';
import { useFlowChatFileActions } from './useFlowChatFileActions';
import { useFlowChatNavigation } from './useFlowChatNavigation';
import { useFlowChatCopyDialog } from './useFlowChatCopyDialog';
import { useFlowChatSync } from './useFlowChatSync';
import { useFlowChatToolActions } from './useFlowChatToolActions';
import { useFlowChatSearch } from './useFlowChatSearch';
import {
  sessionToVirtualItems,
  useVirtualItems,
  useActiveSession,
  useVisibleTurnInfo,
  type VisibleTurnInfo,
} from '../../store/modernFlowChatStore';
import type { Session, SessionHistoryPresentation } from '../../types/flow-chat';
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
import { parsePullRequestUrl } from '@/shared/utils/pullRequestLinks';
import { createBackgroundCommandOutputTab, createReviewPlatformPullRequestDetailTab } from '@/shared/utils/tabUtils';
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
import {
  traceViewport,
  traceViewportRepeating,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import { scheduleAfterStartupPaint } from '@/shared/utils/startupTaskScheduling';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { notificationService } from '@/shared/notification-system';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
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
  canonicalSessionTurns,
  projectedSessionTurnCount,
  resolveTurnOrdinal,
} from '../../utils/flowChatTurnIdentity';
import type { FlowChatViewportSnapshot } from './flowChatViewportSnapshot';
import { peekConversationViewTransfer, registerConversationReader, takeConversationViewTransfer } from './flowChatViewHandoff';

const log = createLogger('ModernFlowChatContainer');

interface ModernFlowChatContainerProps {
  className?: string;
  isViewportActive?: boolean;
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

interface FlowChatTurnSummary {
  turnId: string;
  turnIndex: number;
  storageTurnIndex?: number;
}

interface FlowChatHistoryPresentationState extends SessionHistoryPresentation {
  sessionId: string;
  revision: number;
}

export interface SessionViewportState {
  snapshot: FlowChatViewportSnapshot | null;
  historyPresentation: FlowChatHistoryPresentationState | null;
  viewportIntent: FlowChatViewportIntent | null;
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
const HISTORY_INITIAL_CONTENT_PAINT_MAX_ATTEMPTS = 30;
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
  const [historyPresentation, setHistoryPresentation] = useState<FlowChatHistoryPresentationState | null>(null);
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
      return null;
    }
    return sessionToVirtualItems({
      ...activeSession,
      dialogTurns: continuousHistoryPresentation.turns,
    });
  }, [activeSession, continuousHistoryPresentation]);
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
    if (!activeSession || !renderedHistoryPresentation) {
      return canonicalVirtualItems;
    }
    if (
      isRenderingContinuousHistoryProjection
      && continuousHistoryVirtualItems
    ) {
      return continuousHistoryVirtualItems;
    }
    return sessionToVirtualItems({
      ...activeSession,
      dialogTurns: renderedHistoryPresentation.turns,
    });
  }, [
    activeSession,
    canonicalVirtualItems,
    continuousHistoryVirtualItems,
    isRenderingContinuousHistoryProjection,
    renderedHistoryPresentation,
  ]);

  // The transcript reads the pending list to mark the tool cards that are
  // waiting; answering them belongs to the composer, which reads the same
  // shared subscription.
  const { requests: permissionRequests } = usePermissionRequests(activeSession?.sessionId);
  const visibleTurnInfo = useVisibleTurnInfo();
  const [queuedTurnNavigation, setQueuedTurnNavigation] = useState<QueuedTurnNavigation | null>(null);
  const [pendingHistoryOpenSession, setPendingHistoryOpenSession] = useState<HistorySessionOpenIntentDetail | null>(null);
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
  const searchFullHistorySessionIdRef = useRef<string | null>(null);
  const virtualListRef = useRef<VirtualMessageListRef>(null);
  const chatScopeRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionViewportStateRef = useRef<Map<string, SessionViewportState>>(new Map());
  const viewScope = useConversationViewScope();
  const surfaceScope = getActiveSurfaceScope();
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
  const [historyInitialContentReadyKey, setHistoryInitialContentReadyKey] = useState<string | null>(null);
  const [historyInitialContentPostPaintKey, setHistoryInitialContentPostPaintKey] = useState<string | null>(null);
  const workspaceContext = useWorkspaceContext();
  const workspacePath = viewScope ? activeSession?.workspacePath : workspaceContext.workspacePath;
  const activeWorkspace = viewScope ? undefined : workspaceContext.activeWorkspace;
  const allowUserMessageRollback = !isAcpFlowSession(activeSession);
  const historyState = activeSession?.historyState;
  const hasRestoredTurnsPendingVirtualItems =
    historyState === 'ready' &&
    (activeSession?.dialogTurns.length ?? 0) > 0 &&
    virtualItems.length === 0;

  const rememberSessionViewportState = useCallback((
    sessionId: string,
    patch: Partial<SessionViewportState>,
  ) => {
    const previous = sessionViewportStateRef.current.get(sessionId);
    sessionViewportStateRef.current.set(sessionId, {
      snapshot: patch.snapshot !== undefined ? patch.snapshot : previous?.snapshot ?? null,
      historyPresentation: patch.historyPresentation !== undefined
        ? patch.historyPresentation
        : previous?.historyPresentation ?? null,
      viewportIntent: patch.viewportIntent !== undefined
        ? patch.viewportIntent
        : previous?.viewportIntent ?? null,
    });
  }, []);

  const acceptViewportSnapshot = useCallback((snapshot: FlowChatViewportSnapshot) => {
    rememberSessionViewportState(snapshot.sessionId, { snapshot });
    traceViewportRepeating(`sessionSnapshot|${snapshot.sessionId}|${snapshot.presentationMode}`, {
      location: 'viewport.sessionSnapshotCaptured',
      message: 'FlowChat stored a semantic viewport snapshot for a session',
      data: () => ({
        sessionId: snapshot.sessionId,
        presentationMode: snapshot.presentationMode,
        viewportMode: snapshot.viewportMode,
        historyWindow: snapshot.historyWindow,
        anchorItemKey: snapshot.anchorItemKey,
        anchorItemType: snapshot.anchorItemType,
        anchorTurnId: snapshot.anchorTurnId,
        anchorOffsetPx: snapshot.anchorOffsetPx,
        scrollTopPx: snapshot.scrollTopPx,
        isAtTail: snapshot.isAtTail,
      }),
    });
  }, [rememberSessionViewportState]);

  const handleViewportSnapshot = useCallback((snapshot: FlowChatViewportSnapshot) => {
    if (
      viewportRestorePendingSessionIdRef.current === snapshot.sessionId
      || restoreGateSessionId === snapshot.sessionId
    ) {
      traceViewportRepeating(`sessionSnapshotIgnored|${snapshot.sessionId}`, {
        location: 'viewport.sessionSnapshotIgnoredDuringRestore',
        message: 'FlowChat ignored a provisional viewport snapshot while restoring a session',
        data: () => ({
          sessionId: snapshot.sessionId,
          anchorItemKey: snapshot.anchorItemKey,
          anchorItemType: snapshot.anchorItemType,
          anchorTurnId: snapshot.anchorTurnId,
          anchorOffsetPx: snapshot.anchorOffsetPx,
          scrollTopPx: snapshot.scrollTopPx,
          isAtTail: snapshot.isAtTail,
        }),
      });
      return;
    }
    acceptViewportSnapshot(snapshot);
  }, [acceptViewportSnapshot, restoreGateSessionId]);

  useLayoutEffect(() => registerConversationReader({ surfaceId: surfaceScope.surfaceId, sessionId: activeSession?.sessionId ?? '' }, viewScope ? 'dock' : 'main', sessionId => {
    const cached = sessionViewportStateRef.current.get(sessionId);
    if (sessionId !== activeSessionIdRef.current) return cached ?? null;
    return {
      snapshot: virtualListRef.current?.captureViewportSnapshot() ?? cached?.snapshot ?? null,
      historyPresentation: historyPresentationRef.current,
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
    historyState === 'failed' ||
    hasRestoredTurnsPendingVirtualItems
  );
  const isPendingHistoryOpenActiveSession =
    pendingHistoryOpenSession !== null &&
    activeSession?.sessionId === pendingHistoryOpenSession.sessionId;
  const {
    exploreGroupStates,
    onExploreGroupToggle: handleExploreGroupToggle,
    onExpandGroup: handleExpandGroup,
    onExpandAllInTurn: handleExpandAllInTurn,
    onCollapseGroup: handleCollapseGroup,
  } = useExploreGroupState(virtualItems);
  const { handleToolConfirm, handleToolReject } = useFlowChatToolActions();

  const { handleFileViewRequest } = useFlowChatFileActions({
    sessionId: activeSession?.sessionId,
    workspacePath,
    onFileViewRequest,
  });
  const handleHttpLinkClick = useCallback((url: string, _event: React.MouseEvent<HTMLAnchorElement>) => {
    const pullRequestTarget = parsePullRequestUrl(url);
    if (!pullRequestTarget) {
      return false;
    }

    if (!activeSession?.workspaceId) return false;
    createReviewPlatformPullRequestDetailTab({
      workspaceId: activeSession.workspaceId,
      workspacePath: activeSession?.workspacePath || workspacePath,
      pullRequestId: pullRequestTarget.pullRequestId,
      pullRequestUrl: pullRequestTarget.webUrl,
      title: `PR #${pullRequestTarget.pullRequestId}`,
    });
    return true;
  }, [activeSession?.workspaceId, activeSession?.workspacePath, workspacePath]);
  const {
    searchQuery,
    onSearchChange: setSearchQuery,
    matches: searchMatches,
    matchesByVirtualIndex: searchMatchesByVirtualIndex,
    currentMatchIndex: searchCurrentMatchIndex,
    goToNext: handleSearchNext,
    goToPrev: handleSearchPrev,
    clearSearch,
  } = useFlowChatSearch(virtualItems);
  const searchCurrentMatch = searchMatches[searchCurrentMatchIndex];
  const searchCurrentMatchFlowItemId = searchCurrentMatch?.flowItemId;
  const searchCurrentMatchTurnId = searchCurrentMatch?.turnId;
  const searchCurrentMatchVirtualItemIndex = searchCurrentMatch?.virtualItemIndex ?? -1;
  const searchCurrentMatchOccurrenceIndex = searchCurrentMatch?.occurrenceIndex ?? 0;
  const searchCurrentMatchExpandableKey = searchCurrentMatch?.expandableIds?.join('\u0000') ?? '';

  useFlowChatSync();
  useFlowChatCopyDialog();

  const switchToLiveTailForSession = useCallback((
    sessionId: string,
    options?: { discardRecentHistory?: boolean },
  ) => {
    historyPresentationOwnerGenerationRef.current += 1;
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
    rememberSessionViewportState(sessionId, { snapshot: null });
    updateViewportIntent({ kind: 'live-tail', sessionId });
    setHistoryBoundaryState(IDLE_HISTORY_BOUNDARY_STATE);
    setQueuedTurnNavigation(null);
  }, [
    activeSession?.sessionId,
    continuousHistoryProjectionEligible,
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
    if (previousSessionId && previousSessionId !== sessionId) {
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
    const remembered = sessionId ? sessionViewportStateRef.current.get(sessionId) : undefined;
    historyPresentationOwnerGenerationRef.current += 1;
    const restoredHistoryPresentation = remembered?.historyPresentation ?? null;
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
      if (!restoredHistoryPresentation) {
        flowChatStore.restoreSessionTailPresentation(sessionId);
      }
      traceViewport({
        location: 'viewport.sessionStateRestored',
        message: 'FlowChat restored the remembered session viewport state',
        data: () => ({
          sessionId,
          previousSessionId,
          restoredPresentationMode: restoredHistoryPresentation ? 'history-window' : 'tail',
          restoredViewportIntent: restoredIntent,
          snapshot: rememberedSnapshot,
        }),
      });
    }
  }, [activeSession?.sessionId, rememberSessionViewportState, updateViewportIntent, restoreRevision]);

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
    historyPresentationOwnerGenerationRef.current += 1;
    historyPresentationRef.current = null;
    setHistoryPresentation(null);
    setContinuousProjectionSessionId(null);
    if (activeSession?.sessionId) {
      flowChatStore.restoreSessionTailPresentation(activeSession.sessionId);
    }
    if (
      activeViewportIntent?.kind === 'turn'
      && activeViewportIntent.source === 'history-range'
    ) {
      updateViewportIntent(activeSession?.sessionId
        ? { kind: 'live-tail', sessionId: activeSession.sessionId }
        : null);
    }
    setHistoryBoundaryState(IDLE_HISTORY_BOUNDARY_STATE);
  }, [
    activeHistoryPresentation,
    activeHistoryPresentationFitsSession,
    activeSession?.sessionId,
    activeViewportIntent,
    updateViewportIntent,
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
    }, 4000);

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

    if (historyState === 'failed') {
      clearHistorySessionOpenTransition(pendingHistoryOpenSession.sessionId);
    }
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
    onExploreGroupToggle: handleExploreGroupToggle,
    onExpandGroup: handleExpandGroup,
    onExpandAllInTurn: handleExpandAllInTurn,
    onCollapseGroup: handleCollapseGroup,
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
  ]);

  const volatileContextValue: FlowChatVolatileContextValue = useMemo(() => ({
    pendingPermissionToolCallIds,
    exploreGroupStates,
    searchQuery,
    searchMatchesByVirtualIndex,
    searchCurrentMatch,
  }), [
    pendingPermissionToolCallIds,
    exploreGroupStates,
    searchQuery,
    searchMatchesByVirtualIndex,
    searchCurrentMatch,
  ]);

  const turnSummaries = useMemo<FlowChatTurnSummary[]>(() => {
    if (!activeSession) {
      return [];
    }
    return canonicalSessionTurns(activeSession).map((turn, index) => ({
        turnId: turn.id,
        turnIndex: (resolveTurnOrdinal(activeSession, turn) ?? index) + 1,
        storageTurnIndex: turn.storageTurnIndex ?? turn.backendTurnIndex,
      }));
  }, [activeSession]);
  const renderedTurns = useMemo(
    () => renderedHistoryPresentation
      ? renderedHistoryPresentation.turns
      : activeSession?.dialogTurns ?? [],
    [activeSession?.dialogTurns, renderedHistoryPresentation],
  );
  const renderedTurnSummaries = useMemo<FlowChatTurnSummary[]>(() => {
    return renderedTurns
      .filter(turn => turn.userMessage?.metadata?.usageReportProvisional !== true)
      .map((turn, index) => ({
        turnId: turn.id,
        turnIndex: index + 1,
        storageTurnIndex: turn.storageTurnIndex ?? turn.backendTurnIndex,
      }));
  }, [renderedTurns]);
  const activeTurnCatalog = activeSession?.turnCatalog;
  const turnCatalog = activeTurnCatalog?.sessionId === activeSession?.sessionId
    ? activeTurnCatalog
    : undefined;
  const sessionTotalTurnCount = activeSession
    ? projectedSessionTurnCount(activeSession)
    : 0;
  const absoluteRenderedTurnSummaries = useMemo<FlowChatTurnSummary[]>(() => {
    if (renderedHistoryPresentation) {
      return renderedTurnSummaries.map((turn, index) => ({
        ...turn,
        turnIndex: renderedHistoryPresentation.range.startOrdinal + index + 1,
      }));
    }
    return renderedTurnSummaries.map(turn => ({
      ...turn,
      turnIndex: activeSession
        ? (resolveTurnOrdinal(activeSession, turn.turnId) ?? turn.turnIndex - 1) + 1
        : turn.turnIndex,
    }));
  }, [
    activeSession,
    renderedHistoryPresentation,
    renderedTurnSummaries,
  ]);
  const absoluteRenderedTurnSummaryById = useMemo(() => {
    return new Map(absoluteRenderedTurnSummaries.map(turn => [turn.turnId, turn]));
  }, [absoluteRenderedTurnSummaries]);
  const turnRailItems = useMemo<FlowChatTurnRailItem[]>(() => {
    const historyView = activeSession?.sessionId
      ? flowChatStore.getSessionHistoryViewState(activeSession.sessionId)
      : undefined;
    const loadedTurns = [
      ...(activeSession?.dialogTurns ?? []),
      ...(historyView?.loadedRanges.flatMap(range => range.turns) ?? []),
    ];
    const dialogTurnById = new Map(loadedTurns.map(turn => [turn.id, turn]));
    const loadedByStorageIndex = new Map<number, { turnId: string; content: string; capsulePreview?: FlowChatTurnRailItem['capsulePreview'] }>();
    const loadedByOrdinal = new Map<number, { turnId: string; content: string; capsulePreview?: FlowChatTurnRailItem['capsulePreview'] }>();
    for (const range of historyView?.loadedRanges ?? []) {
      range.turns.forEach((turn, index) => {
        const loaded = {
          turnId: turn.id,
          content: turn.userMessage?.content ?? '',
          capsulePreview: composerPresentationToTurnRailPreview(
            parseComposerPresentation(turn.userMessage?.metadata?.composerPresentation),
          ),
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
        capsulePreview: composerPresentationToTurnRailPreview(
          parseComposerPresentation(dialogTurn?.userMessage?.metadata?.composerPresentation),
        ),
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
      const loaded = loadedByStorageIndex.get(storageTurnIndex)
        ?? (catalogEntry?.turnId && catalogDialogTurn ? {
          turnId: catalogEntry.turnId,
          content: catalogDialogTurn.userMessage?.content ?? '',
          capsulePreview: composerPresentationToTurnRailPreview(
            parseComposerPresentation(catalogDialogTurn.userMessage?.metadata?.composerPresentation),
          ),
        } : undefined)
        ?? loadedByOrdinal.get(ordinal);
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
        capsulePreview: composerPresentationToTurnRailPreview(
          parseComposerPresentation(dialogTurnById.get(summary.turnId)?.userMessage?.metadata?.composerPresentation),
        ),
      });
    }

    return items.sort((left, right) => left.turnIndex - right.turnIndex);
  }, [
    absoluteRenderedTurnSummaries,
    activeSession?.dialogTurns,
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
  const shouldBlockHistoryInitialContentInteraction =
    historyInitialContentKey !== null &&
    historyInitialContentReadyKey !== historyInitialContentKey;
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
  const showFailedHistoryPlaceholder =
    showHistoryPlaceholder && historyState === 'failed';
  const showHistoryOpenIntentOverlay =
    pendingHistoryOpenSession !== null &&
    (
      activeSession?.sessionId !== pendingHistoryOpenSession.sessionId ||
      (isPendingHistoryOpenActiveSession && showHistoryPlaceholder && !showFailedHistoryPlaceholder)
    );
  const shouldBlockHistoryTransitionInteraction =
    shouldBlockHistoryInitialContentInteraction ||
    showHistoryOpenIntentOverlay;
  const showHistoryLoadingLayer =
    !showHistoryOpenIntentOverlay && !showFailedHistoryPlaceholder && showHistoryPlaceholder;
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
    searchFullHistorySessionIdRef.current = null;
  }, [activeSession?.sessionId]);

  useEffect(() => {
    setHistoryInitialContentReadyKey(null);
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
    if (
      !isViewportActive ||
      !sessionId ||
      activeSession.historyState !== 'ready' ||
      (
        activeSession.contextRestoreState !== 'pending' &&
        !hasPendingHistoryCompletion
      ) ||
      !latestTurnId
    ) {
      return;
    }

    const releaseKey = `${sessionId}:${latestTurnId}`;
    if (releasedHistoryCompletionKeyRef.current === releaseKey) {
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let cancelAfterPaint: (() => void) | null = null;
    let attempts = 0;

    const releaseAfterPaint = () => {
      if (cancelled) {
        return;
      }
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

    const checkLatestTextVisibility = () => {
      if (cancelled) {
        return;
      }

      attempts += 1;
      if (virtualListRef.current?.isTurnTextRenderedInViewport(latestTurnId) === true) {
        setHistoryInitialContentReadyKey(releaseKey);
        cancelAfterPaint = scheduleAfterStartupPaint(releaseAfterPaint, { frameCount: 2 });
        return;
      }

      if (attempts >= HISTORY_INITIAL_CONTENT_PAINT_MAX_ATTEMPTS) {
        setHistoryInitialContentReadyKey(releaseKey);
        setHistoryInitialContentPostPaintKey(releaseKey);
        releasedHistoryCompletionKeyRef.current = releaseKey;
        clearHistorySessionOpenTransition(sessionId);
        startupTrace.markPhase('historical_session_initial_content_paint_signal_missed', {
          sessionId,
          latestTurnId,
          attempts,
        });
        return;
      }

      frameId = requestAnimationFrame(checkLatestTextVisibility);
    };

    frameId = requestAnimationFrame(checkLatestTextVisibility);

    return () => {
      cancelled = true;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      cancelAfterPaint?.();
    };
  }, [
    activeSession?.historyState,
    activeSession?.contextRestoreState,
    activeSession?.sessionId,
    hasPendingHistoryCompletion,
    isViewportActive,
    latestTurnId,
    turnSummaries.length,
  ]);

  useEffect(() => {
    if (searchCurrentMatchVirtualItemIndex < 0 || !searchQuery.trim()) {
      virtualListRef.current?.clearSearchMatch();
      return;
    }

    const frameId = requestAnimationFrame(() => {
      virtualListRef.current?.scrollToSearchMatch({
        virtualItemIndex: searchCurrentMatchVirtualItemIndex,
        query: searchQuery,
        flowItemId: searchCurrentMatchFlowItemId,
        occurrenceIndex: searchCurrentMatchOccurrenceIndex,
        expandableIds: searchCurrentMatchExpandableKey
          ? searchCurrentMatchExpandableKey.split('\u0000')
          : undefined,
      });
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [
    searchCurrentMatchFlowItemId,
    searchCurrentMatchTurnId,
    searchCurrentMatchExpandableKey,
    searchCurrentMatchVirtualItemIndex,
    searchCurrentMatchOccurrenceIndex,
    searchQuery,
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
    historyPresentationOwnerGenerationRef.current += 1;
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
  }, [updateViewportIntent]);

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

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    const sessionId = activeSession?.sessionId;
    if (
      !query.trim()
      || !sessionId
      || activeSession.isPartial !== true
      || searchFullHistorySessionIdRef.current === sessionId
    ) {
      return;
    }

    searchFullHistorySessionIdRef.current = sessionId;
    void flowChatStore.ensureSessionFullHistory(sessionId, 'flowchat-search').then(ready => {
      if (ready && activeSessionIdRef.current === sessionId) {
        restoreTailPresentation({ discardRecentHistory: true });
      } else if (activeSessionIdRef.current === sessionId) {
        searchFullHistorySessionIdRef.current = null;
      }
    });
  }, [activeSession?.isPartial, activeSession?.sessionId, restoreTailPresentation, setSearchQuery]);

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
    void FlowChatManager.getInstance().switchChatSession(sessionId);
  }, [activeSession?.sessionId]);

  const handleHistoryWindowBoundaryIntent = useCallback((
    direction: SessionHistoryWindowDirection,
    options?: HistoryWindowBoundaryIntentOptions,
  ): Promise<HistoryWindowBoundaryIntentResult> => {
    const existingRequest = historyBoundaryRequestsRef.current[direction];
    if (existingRequest) {
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

      const session = flowChatStore.getState().sessions.get(sessionId);
      if (getActiveSurfaceScope().surfaceId !== 'local' && !presentation) {
        if (direction === 'after' || session?.isPartial === false) return 'exhausted';
        const scope = getActiveSurfaceScope();
        setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
        try {
          const prepared = await options?.prepareViewportForPresentationCommit?.();
          if (prepared === false || !scope.isCurrent() || activeSessionIdRef.current !== sessionId) {
            options?.cancelViewportPresentationCommit?.();
            return 'cancelled';
          }
          const loaded = await flowChatStore.loadOlderRelaySessionHistory(sessionId);
          if (!scope.isCurrent() || activeSessionIdRef.current !== sessionId) return 'cancelled';
          return loaded ? 'applied' : 'exhausted';
        } catch (error) {
          options?.cancelViewportPresentationCommit?.();
          if (isSurfaceChangedError(error)) return 'cancelled';
          log.error('Relay history page failed', { sessionId, error });
          if (scope.isCurrent()) setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
          return 'not-ready';
        } finally {
          if (scope.isCurrent() && activeSessionIdRef.current === sessionId) {
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
        return 'exhausted';
      }
      const targetOrdinal = target.targetOrdinal;

      setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'loading' }));
      let viewportPreparationStarted = false;
      try {
        const result = await flowChatStore.loadSessionTurnWindow(sessionId, targetOrdinal, {
          source: 'prefetch',
          before: direction === 'before' ? 12 : 4,
          after: direction === 'after' ? 12 : 1,
        });
        if (!result.isCurrent || activeSessionIdRef.current !== sessionId) {
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
          if (activeSessionIdRef.current === sessionId) {
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
            if (historyReady && activeSessionIdRef.current === sessionId) {
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
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
            direction,
            reason: `load-${result.status}`,
            targetOrdinal,
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
          if (viewportPreparationStarted) {
            options?.cancelViewportPresentationCommit?.();
          }
          recordHistoryPagingEvent(sessionId, 'outcome_not_ready', {
            direction,
            reason: 'no-next-presentation',
            targetOrdinal,
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
        if (activeSessionIdRef.current === sessionId) {
          setHistoryBoundaryState(previous => ({ ...previous, [direction]: 'error' }));
        }
        log.warn('Failed to prefetch an adjacent session Turn window', {
          sessionId,
          direction,
          targetOrdinal,
          error,
        });
        return 'not-ready';
      }
    })().finally(() => {
      historyBoundaryRequestsRef.current[direction] = null;
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

  const handleDeleteSessionTreeSession = useCallback(async (selection: SessionTreeSelection) => {
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
        { confirmText: t('flowChatHeader.agentTreeDelete') },
      );
      if (!confirmed) return false;
      await deleteSessionTreeBranch({ sessionId: selection.sessionId, workspaceId: requireSessionWorkspaceId(flowChatStore.getState().sessions.get(selection.sessionId) || activeSession!) }, scope);
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
          await FlowChatManager.getInstance().createChatSession(
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
          visible={virtualItems.length > 0}
          sessionId={activeSession?.sessionId}
          isRightPanelOpen={isRightPanelOpen}
          onToggleRightPanel={onToggleRightPanel}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          searchMatchCount={searchMatches.length}
          searchCurrentMatch={searchMatches.length > 0 ? searchCurrentMatchIndex + 1 : 0}
          onSearchNext={handleSearchNext}
          onSearchPrev={handleSearchPrev}
          onSearchClose={clearSearch}
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

        <BackgroundCommandInputDialog
          command={backgroundCommandInputTarget}
          isSending={isSendingBackgroundCommandInput}
          onClose={handleCloseBackgroundCommandInput}
          onSend={handleSendBackgroundCommandInput}
        />

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
          data-history-initial-content-ready={
            historyInitialContentKey === null || historyInitialContentReadyKey === historyInitialContentKey
              ? 'true'
              : 'false'
          }
          data-pending-history-open-session-id={pendingHistoryOpenSession?.sessionId ?? ''}
          onClickCapture={blockHistoryOverlayActivation}
          onContextMenuCapture={blockHistoryOverlayActivation}
          onMouseDownCapture={blockHistoryOverlayActivation}
          onPointerDownCapture={blockHistoryOverlayActivation}
        >
          <>
            {showFailedHistoryPlaceholder ? (
              <HistorySessionPlaceholder
                state="failed"
                onRetry={handleRetryHistoryLoad}
              />
            ) : virtualItems.length === 0 ? (
              showHistoryPlaceholder || showHistoryOpenIntentOverlay ? null : (
                emptyState !== undefined ? emptyState : (
                  <WelcomePanel
                    key={activeSession?.sessionId ?? 'welcome'}
                    sessionMode={activeSession?.mode}
                    workspaceId={activeSession?.workspaceId || activeSession?.config?.workspaceId}
                    workspacePath={activeSession?.workspacePath}
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
                  items={virtualItems}
                  isViewportActive={isViewportActive}
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
            {virtualItems.length > 0 ? (
              <FlowChatTurnRail
                turns={turnRailItems}
                currentTurnId={effectiveVisibleTurnInfo?.turnId ?? null}
                visibleTurnIds={effectiveVisibleTurnInfo?.visibleTurnIds ?? []}
                onNavigate={navigateToTurn}
              />
            ) : null}
            {showHistoryLoadingLayer && (
              <div
                className="modern-flowchat-container__history-overlay"
                role="status"
                aria-label={t('historyState.loadingTitle')}
                data-openbitfun-component="modern-flow-chat"
                data-openbitfun-part="historyOverlay"
              >
                <HistorySessionPlaceholder
                  state={historyState === 'metadata-only' ? 'metadata-only' : 'hydrating'}
                />
              </div>
            )}
            {showHistoryOpenIntentOverlay && (
              <div
                className="modern-flowchat-container__history-open-intent-shield"
                data-openbitfun-component="modern-flow-chat"
                data-openbitfun-part="historyOpenIntent"
                role="status"
                aria-label={t('historyState.loadingTitle')}
              >
                <span
                  className="modern-flowchat-container__history-open-intent-spinner"
                  data-openbitfun-component="modern-flow-chat"
                  data-openbitfun-part="historyOpenIntentSpinner"
                  aria-hidden="true"
                />
              </div>
            )}
          </>
        </div>
      </div>
      </FlowChatVolatileContext.Provider>
      </ConversationExcerptSourceProvider>
    </FlowChatContext.Provider>
  );
};

ModernFlowChatContainer.displayName = 'ModernFlowChatContainer';
