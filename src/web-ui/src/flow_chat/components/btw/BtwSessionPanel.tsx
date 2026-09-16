import { OverflowText, Button, IconButton } from '@openbitfun/ui';
import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {getActiveSurfaceId, onSurfaceActivated} from '@/infrastructure/peer-device/deviceSurface';
import {createBtwPanelViewState, type BtwPanelViewState} from './btwPanelViewState';
import {useTranslation} from 'react-i18next';
import path from 'path-browserify';
import { CornerUpLeft, Loader2, Square } from 'lucide-react';
import {FlowChatContext, FlowChatVolatileContext} from '../modern/FlowChatContext';
import { FlowChatSelectionBar } from '../../selection/FlowChatSelectionBar';
import { ConversationExcerptSourceProvider } from '../../selection/ConversationExcerptSources';
import {BtwVirtualSessionList} from './BtwVirtualSessionList';
import {useBtwSessionState} from './useBtwSessionState';
import {useFlowChatViewportOwner} from '../modern/useFlowChatViewportOwner';
import {RuntimeStatusSlot} from '../modern/RuntimeStatusSlot';
import {pendingPermissionToolCallIdsForSession} from '../modern/permissionRequestRouting';
import {usePermissionRequests} from '../modern/usePermissionRequests';
import {useExploreGroupState} from '../modern/useExploreGroupState';
import {ChatInputApprovalBand} from '../ChatInputApprovalBand';
import {ScrollToBottomButton} from '@/flow_chat';
import {flowChatStore} from '../../store/FlowChatStore';
import type {DialogTurn, Session} from '../../types/flow-chat';
import {sessionToVirtualItems} from '../../store/modernFlowChatStore';
import {FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest} from '../../events/flowchatNavigation';
import {fileTabManager} from '@/shared/services/FileTabManager';
import {createTab} from '@/shared/utils/tabUtils';
import { type LineRange } from '@/shared/editor/LineRange';
import { Tooltip, Icon } from '@openbitfun/ui';
import { DEFAULT_RETAINED_MOUNT_MS, RetainedMountBoundary } from '@/shared/presence';
import {resolveSessionRelationship} from '../../utils/sessionMetadata';
import {agentAPI} from '@/infrastructure/api';
import {globalEventBus} from '@/infrastructure/event-bus';
import {notificationService} from '@/shared/notification-system';
import {createLogger} from '@/shared/utils/logger';
import {
  deriveReviewDetailProjection,
  filterReviewDetailItems,
  type ReviewDetailContentState,
  type ReviewDetailExecutionState,
} from '../../utils/reviewDetailState';
import {
  loadBtwSessionHistory,
  type BtwSessionViewKind,
} from '../../services/btwSessionPane';
import {findLatestCodeReviewResult, findLatestCodeReviewResultState} from '../../utils/reviewSessionSummary';
import {
  deriveDeepReviewInterruption,
  deriveDeepReviewResultRecoveryInterruption,
  type DeepReviewResultRecoveryReason,
} from '../../utils/deepReviewContinuation';
import {buildReviewRemediationItems, type CodeReviewRemediationData} from '../../utils/codeReviewRemediation';
import {ReviewActionBar} from './DeepReviewActionBar';
import {
  getPendingFollowUpReviewRequestId,
  getReviewActionBarStateForSession,
  isPendingFollowUpReviewSessionId,
  type ReviewActionMode,
  type ReviewActionPhase,
  useReviewActionBarStore,
} from '../../store/deepReviewActionBarStore';
import {loadPersistedReviewState} from '../../services/ReviewActionBarPersistenceService';
import type {ReviewActionPersistedState} from '@/shared/types/session-history';
import {sessionProjectWorkspacePath} from '../../utils/sessionWorkspace';
import {
  collectModifiedFilePathsFromTurns,
  hasOpaqueWorkspaceMutationRisk,
} from '../../utils/modifiedFilePaths';
import { getMotionAwareScrollBehavior } from '../../utils/motionPreference';
import { sessionLineageLifecycleForSession } from '../../utils/sessionLineage';
import {
  SubagentAvatar,
} from '../../subagent-identity';
import { FlowChatManager } from '../../services/FlowChatManager';
import { useSessionReadOnOpen } from '../../hooks/useSessionReadOnOpen';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { bindBtwTailFollow } from './btwTailFollow';

function findReviewChildByRequestId(
  parentSessionId: string | null | undefined,
  requestId: string,
): string | null {
  if (!parentSessionId) {
    return null;
  }
  for (const [sessionId, session] of flowChatStore.getState().sessions) {
    const relationship = resolveSessionRelationship(session);
    if (
      relationship.isReview &&
      relationship.parentSessionId === parentSessionId &&
      session.btwOrigin?.requestId === requestId
    ) {
      return sessionId;
    }
  }
  return null;
}
import './BtwSessionPanel.scss';

export interface BtwSessionPanelProps {
  isActive?: boolean;
  childSessionId?: string;
  parentSessionId?: string;
  workspacePath?: string;
  viewKind?: BtwSessionViewKind;
  displayTitle?: string;
}

const resolveSessionTitle = (session?: Pick<Session, 'title'> | null, fallback = 'Side thread') =>
  session?.title?.trim() || fallback;
const log = createLogger('BtwSessionPanel');
const REVIEW_ACTION_BOTTOM_BLANK_SPACE_PX = 96;
const EMPTY_ACTION_ID_SET = new Set<string>();
const EMPTY_REMEDIATION_ITEMS: ReturnType<typeof buildReviewRemediationItems> = [];
const REVIEW_DETAIL_CONTENT_STATE_KEYS: Record<ReviewDetailContentState, string> = {
  loading: 'childSession.reviewDetail.loading',
  'load-failed': 'childSession.reviewDetail.loadFailed',
  unavailable: 'childSession.reviewDetail.unavailable',
};
const REVIEW_DETAIL_EXECUTION_STATE_KEYS: Record<ReviewDetailExecutionState, string> = {
  preparing: 'childSession.reviewDetail.preparing',
  'completed-empty': 'childSession.reviewDetail.completedEmpty',
  'partial-timeout': 'childSession.reviewDetail.partialTimedOut',
  stopped: 'childSession.reviewDetail.stopped',
  interrupted: 'childSession.reviewDetail.interrupted',
  'timed-out': 'childSession.reviewDetail.timedOut',
  failed: 'childSession.reviewDetail.failed',
};

const isActiveReviewTurnStatus = (status?: DialogTurn['status']) =>
  status === 'pending' ||
  status === 'image_analyzing' ||
  status === 'processing' ||
  status === 'finishing';

type DeepReviewActionData = CodeReviewRemediationData & {
  review_mode?: 'standard' | 'deep';
};

const isSameReviewResult = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const BtwSessionPanelContent: React.FC<BtwSessionPanelProps & { viewState: BtwPanelViewState }> = ({
  childSessionId,
  parentSessionId,
  workspacePath,
  viewKind,
  displayTitle,
  viewState,
}) => {
  const { t } = useTranslation('flow-chat');
  const { childSession, parentMetadata, reviewTaskOutcome } = useBtwSessionState(
    childSessionId, parentSessionId, viewKind === 'review-check',
  );
  const [stoppingReview, setStoppingReview] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(() => {
    viewState.restoring = !viewState.followTail && viewState.anchor !== null;
    return !viewState.followTail;
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const listHeaderRef = useRef<HTMLDivElement>(null);
  const viewportOwner = useFlowChatViewportOwner(scrollContainerRef);
  useSessionReadOnOpen(childSessionId ?? null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const [actionBarHeight, setActionBarHeight] = useState(0);
  const shouldAutoScrollRef = useRef(viewState.followTail);

  // Embedded child sessions live outside the primary composer. Give direct
  // child requests an actionable surface here, while delegated requests stay
  // exclusively owned by the parent session.
  const {
    requests: permissionRequests,
    ownedRequests: ownedPermissionRequests,
    ownedActiveBatch: activePermissionBatch,
    respond: respondPermission,
    respondBatch: respondPermissionBatch,
  } = usePermissionRequests(childSessionId);
  const pendingPermissionToolCallIds = useMemo(
    () => pendingPermissionToolCallIdsForSession(permissionRequests, childSessionId),
    [permissionRequests, childSessionId],
  );

  const childSessionRef = useRef(childSession);
  childSessionRef.current = childSession;
  const childRelationship = resolveSessionRelationship(childSession);
  const childKind = childRelationship.kind === 'review' ||
    childRelationship.kind === 'deep_review' ||
    childRelationship.kind === 'miniapp' ||
    childRelationship.kind === 'subagent'
    ? childRelationship.kind
    : 'btw';
  const subagentAvatarStatus = childKind === 'subagent' && childSession
    ? sessionLineageLifecycleForSession(childSession)
    : 'idle';
  const childBadgeLabel = viewKind === 'review-check'
    ? t('toolCards.taskTool.reviewCoverageLabel')
    : t(`childSession.kinds.${childKind}.short`, {
    defaultValue: childKind === 'deep_review'
      ? 'Strict'
      : childKind === 'review'
        ? 'Review'
        : childKind === 'subagent'
          ? 'Agent'
        : childKind === 'miniapp'
          ? 'MiniApp'
          : t('btw.shortLabel'),
    });
  const childTitleFallback = t(`childSession.kinds.${childKind}.title`, {
    defaultValue: t('btw.threadLabel'),
  });
  const childOriginLabel = t(`childSession.kinds.${childKind}.origin`, {
    defaultValue: t('btw.origin'),
  });
  const showOriginMeta = childKind !== 'miniapp' && childKind !== 'subagent';
  const sessionVirtualItems = useMemo(
    () => sessionToVirtualItems(childSession ?? null),
    [childSession],
  );
  const virtualItems = useMemo(
    () => viewKind === 'review-check'
      ? filterReviewDetailItems(sessionVirtualItems)
      : sessionVirtualItems,
    [sessionVirtualItems, viewKind],
  );
  const {
    exploreGroupStates,
    onExploreGroupToggle,
    onExpandGroup,
    onExpandAllInTurn,
    onCollapseGroup,
  } = useExploreGroupState(virtualItems, viewState.exploreGroupStates);
  useEffect(() => {
    viewState.exploreGroupStates = exploreGroupStates;
  }, [exploreGroupStates, viewState]);
  const isReviewDetail = viewKind === 'review-check' || childKind === 'review' || childKind === 'deep_review';
  const reviewDetailProjection = isReviewDetail
    ? deriveReviewDetailProjection(childSession, virtualItems.length > 0, reviewTaskOutcome)
    : null;
  const reviewDetailNotices = reviewDetailProjection
    ? [
        ...(reviewDetailProjection.execution
          ? [{
              state: reviewDetailProjection.execution,
              key: REVIEW_DETAIL_EXECUTION_STATE_KEYS[reviewDetailProjection.execution],
            }]
          : []),
        ...(reviewDetailProjection.content
          ? [{
              state: reviewDetailProjection.content,
              key: REVIEW_DETAIL_CONTENT_STATE_KEYS[reviewDetailProjection.content],
            }]
          : []),
      ]
    : [];
  const canRetryReviewDetailLoad = virtualItems.length === 0 && Boolean(
    reviewDetailProjection?.content === 'load-failed' ||
    reviewDetailProjection?.content === 'unavailable' ||
    reviewDetailProjection?.execution === 'partial-timeout'
  );

  // Load history for historical sessions that have not yet had their turns loaded.
  const loadChildHistory = useCallback(async () => {
    if (!childSessionId || !childSession) return;

    const path = workspacePath ?? childSession.workspacePath ?? parentMetadata?.workspacePath;
    if (!path) return;

    await loadBtwSessionHistory({
      childSessionId,
      ...(!childSession.workspacePath
        ? {
            workspacePath: path,
            remoteConnectionId: childSession.remoteConnectionId || parentMetadata?.remoteConnectionId,
            remoteSshHost: childSession.remoteSshHost || parentMetadata?.remoteSshHost,
          }
        : {}),
    });
  }, [childSessionId, childSession, parentMetadata, workspacePath]);

  useEffect(() => {
    if (!childSession?.isHistorical || childSession.historyState !== 'metadata-only') return;
    void loadChildHistory().catch(() => undefined);
  }, [childSession?.historyState, childSession?.isHistorical, loadChildHistory]);

  const updateScrollAffordance = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollToBottom(distanceFromBottom > 120);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    return bindBtwTailFollow(container, (following) => {
      shouldAutoScrollRef.current = following;
      viewState.followTail = following;
    }, updateScrollAffordance);
  }, [updateScrollAffordance, viewState]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !shouldAutoScrollRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!shouldAutoScrollRef.current) return;
      viewportOwner.write({ owner: 'follow-output', topPx: container.scrollHeight, holdForMs: 0 });
      setShowScrollToBottom(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [virtualItems, viewportOwner]);

  const handleScrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    shouldAutoScrollRef.current = true;
    viewState.followTail = true;
    viewState.restoring = false;
    viewportOwner.write({
      owner: 'one-shot-navigation',
      topPx: container.scrollHeight,
      behavior: getMotionAwareScrollBehavior('smooth'),
    });
    setShowScrollToBottom(false);
  }, [viewportOwner, viewState]);

  const handleFileViewRequest = useCallback((
    filePath: string,
    fileName: string,
    lineRange?: LineRange
  ) => {
    let absoluteFilePath = filePath;
    const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);

    if (!isWindowsAbsolutePath && !path.isAbsolute(filePath) && workspacePath) {
      absoluteFilePath = path.join(workspacePath, filePath);
    }

    fileTabManager.openFile({
      filePath: absoluteFilePath,
      fileName,
      workspacePath,
      jumpToRange: lineRange,
      mode: 'agent',
    });
  }, [workspacePath]);

  const handleTabOpen = useCallback((tabInfo: any) => {
    if (!tabInfo?.type) return;
    createTab({
      type: tabInfo.type,
      title: tabInfo.title || 'New Tab',
      data: tabInfo.data,
      metadata: tabInfo.metadata,
      checkDuplicate: !!tabInfo.metadata?.duplicateCheckKey,
      duplicateCheckKey: tabInfo.metadata?.duplicateCheckKey,
      replaceExisting: false,
      mode: 'agent',
    });
  }, []);

  const contextValue = useMemo(() => ({
    onFileViewRequest: handleFileViewRequest,
    onTabOpen: handleTabOpen,
    sessionId: childSessionId,
    activeSessionOverride: childSession ?? null,
    allowUserMessageRollback: false,
    allowUserMessageEdit: false,
    allowTranscriptExport: viewKind !== 'review-check',
    onExploreGroupToggle,
    onExpandGroup,
    onExpandAllInTurn,
    onCollapseGroup,
  }), [
    childSession,
    childSessionId,
    handleFileViewRequest,
    handleTabOpen,
    onExploreGroupToggle,
    onExpandGroup,
    onExpandAllInTurn,
    onCollapseGroup,
    viewKind,
  ]);

  const volatileContextValue = useMemo(() => ({
    exploreGroupStates,
    pendingPermissionToolCallIds,
  }), [exploreGroupStates, pendingPermissionToolCallIds]);

  const lastDialogTurn = childSession?.dialogTurns[childSession.dialogTurns.length - 1];
  const isTurnProcessing = isActiveReviewTurnStatus(lastDialogTurn?.status);

  const canStopReviewSession =
    (viewKind === 'review-check' || childKind === 'review' || childKind === 'deep_review') &&
    isTurnProcessing &&
    !stoppingReview;

  // ---- Review action bar integration ----
  const actionBarState = useReviewActionBarStore((s) =>
    getReviewActionBarStateForSession(s, childSessionId),
  );
  const actionBarPhase = actionBarState?.phase ?? 'idle';
  const actionBarMinimized = actionBarState?.minimized ?? false;
  const actionBarChildSessionId = actionBarState?.childSessionId ?? null;
  const actionBarCompletedIds = actionBarState?.completedRemediationIds ?? EMPTY_ACTION_ID_SET;
  const actionBarRemediationItems = actionBarState?.remediationItems ?? EMPTY_REMEDIATION_ITEMS;
  const actionBarSelectedIds = actionBarState?.selectedRemediationIds ?? EMPTY_ACTION_ID_SET;
  const actionBarFixingIds = actionBarState?.fixingRemediationIds ?? EMPTY_ACTION_ID_SET;
  const actionBarLastSubmittedAction = actionBarState?.lastSubmittedAction ?? null;
  const isDeepReview = childKind === 'deep_review';
  const isReviewSession = childKind === 'review' || childKind === 'deep_review';
  const canReturnToParentSession = (viewKind === 'review-check' || isReviewSession) && Boolean(parentSessionId);
  const btwOrigin = childSession?.btwOrigin;
  const showReviewActionBar =
    isReviewSession &&
    actionBarChildSessionId === childSessionId &&
    actionBarPhase !== 'idle' &&
    !actionBarMinimized;

  const [retainedReviewActionBarOwnerId, setRetainedReviewActionBarOwnerId] = useState<string | null>(
    showReviewActionBar ? childSessionId ?? null : null,
  );
  useEffect(() => {
    const ownerId = childSessionId ?? null;
    if (showReviewActionBar && ownerId) {
      setRetainedReviewActionBarOwnerId(ownerId);
      return undefined;
    }
    if (!ownerId || retainedReviewActionBarOwnerId !== ownerId) {
      if (retainedReviewActionBarOwnerId !== null) {
        setRetainedReviewActionBarOwnerId(null);
      }
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setRetainedReviewActionBarOwnerId((currentOwnerId) =>
        currentOwnerId === ownerId ? null : currentOwnerId,
      );
    }, DEFAULT_RETAINED_MOUNT_MS);
    return () => window.clearTimeout(timer);
  }, [childSessionId, retainedReviewActionBarOwnerId, showReviewActionBar]);
  const retainsReviewActionBarLayout = Boolean(
    showReviewActionBar ||
    (childSessionId && retainedReviewActionBarOwnerId === childSessionId),
  );

  const showMinimizedIndicator =
    isReviewSession &&
    actionBarChildSessionId === childSessionId &&
    actionBarPhase !== 'idle' &&
    actionBarMinimized;
  const reviewActionBottomPadding = retainsReviewActionBarLayout
    ? actionBarHeight + REVIEW_ACTION_BOTTOM_BLANK_SPACE_PX
    : showMinimizedIndicator
      ? REVIEW_ACTION_BOTTOM_BLANK_SPACE_PX
      : 0;
  const parentLabel = resolveSessionTitle(parentMetadata, t('btw.parent'));
  const backTooltip = btwOrigin?.parentTurnIndex
    ? t('flowChatHeader.btwBackTooltipWithTurn', {
        title: parentLabel,
        turn: btwOrigin.parentTurnIndex,
      })
    : t('flowChatHeader.btwBackTooltipWithoutTurn', {
        title: parentLabel,
      });

  const remainingCount = actionBarRemediationItems.length - actionBarCompletedIds.size;
  const totalCount = actionBarRemediationItems.length;
  const fixScopedIds = actionBarFixingIds.size > 0 ? actionBarFixingIds : actionBarSelectedIds;
  const fixScopedCompletedCount = [...fixScopedIds].filter((id) => actionBarCompletedIds.has(id)).length;
  const minimizedCountLabel = (
    ['fix_running', 'fix_completed', 'fix_failed', 'fix_timeout', 'fix_interrupted'].includes(actionBarPhase) &&
    fixScopedIds.size > 0
  )
    ? `${fixScopedCompletedCount}/${fixScopedIds.size}`
    : `${remainingCount}/${totalCount}`;
  const minimizedActionLabel = useMemo(() => {
    switch (actionBarPhase) {
      case 'review_running':
        return isDeepReview
          ? t('deepReviewActionBar.minimizedReviewRunningDeep')
          : t('deepReviewActionBar.minimizedReviewRunningStandard');
      case 'fix_running':
        return actionBarLastSubmittedAction === 'fix-review'
          ? t('deepReviewActionBar.minimizedFixReview')
          : t('deepReviewActionBar.minimizedFix');
      case 'fix_completed':
        return t('deepReviewActionBar.minimizedFixCompleted');
      case 'fix_failed':
      case 'fix_timeout':
      case 'review_error':
        return t('deepReviewActionBar.minimizedFixFailed');
      case 'review_interrupted':
      case 'resume_blocked':
      case 'resume_failed':
        return t('deepReviewActionBar.minimizedReviewInterrupted');
      case 'resume_running':
        return t('deepReviewActionBar.minimizedResume');
      default:
        return isDeepReview
          ? t('shared:features.deepReview')
          : t('deepReviewActionBar.minimizedStandard');
    }
  }, [actionBarPhase, actionBarLastSubmittedAction, isDeepReview, t]);

  // Detect when a review completes with a remediation plan and auto-show the action bar.
  useEffect(() => {
    if (!isReviewSession || !childSessionId || !childSession) return;

    const latestReviewResultState = findLatestCodeReviewResultState(childSession);
    const latestReviewData = latestReviewResultState.status === 'valid'
      ? latestReviewResultState.result as DeepReviewActionData
      : null;
    const reviewMode: ReviewActionMode = isDeepReview ? 'deep' : 'standard';
    const latestReviewMode = latestReviewData?.review_mode ?? 'standard';
    const lastTurn = childSession.dialogTurns[childSession.dialogTurns.length - 1];
    const turnStatus = lastTurn?.status;
    const isComplete = turnStatus === 'completed';
    const isError = turnStatus === 'error' || Boolean(childSession.error);
    const isReviewRunning = isActiveReviewTurnStatus(turnStatus);
    const deepReviewInterruption = isDeepReview
      ? deriveDeepReviewInterruption(childSession)
      : null;
    const resultRecoveryReason: DeepReviewResultRecoveryReason | null =
      isDeepReview && isComplete
        ? latestReviewResultState.status === 'missing'
          ? 'missing_submit_code_review'
          : latestReviewResultState.status === 'invalid'
            ? 'invalid_submit_code_review'
            : latestReviewData && latestReviewMode !== 'deep'
              ? 'wrong_review_mode'
              : null
        : null;
    const resultRecoveryInterruption = resultRecoveryReason
      ? deriveDeepReviewResultRecoveryInterruption(childSession, resultRecoveryReason)
      : null;

    const store = useReviewActionBarStore.getState();
    const currentActionState = store.getSessionState(childSessionId);
    const isCurrentResumeRunning =
      currentActionState?.phase === 'resume_running';
    if (isCurrentResumeRunning) {
      const resumeTurnHasStarted =
        !currentActionState.resumeBaselineTurnId ||
        lastTurn?.id !== currentActionState.resumeBaselineTurnId;

      if (!resumeTurnHasStarted) {
        return;
      }

      if (turnStatus === 'error') {
        store.updatePhase('resume_failed', lastTurn?.error ?? childSession.error ?? undefined, childSessionId);
        store.restore(childSessionId);
        return;
      }

      if (turnStatus === 'cancelled' && deepReviewInterruption) {
        store.showInterruptedActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          interruption: deepReviewInterruption,
        });
        store.restore(childSessionId);
        return;
      }

      if (turnStatus !== 'completed') {
        return;
      }
    }

    if (isReviewRunning) {
      const canShowRunningAction =
        !currentActionState ||
        currentActionState.phase === 'idle';

      if (canShowRunningAction) {
        store.showRunningActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          reviewMode,
        });
      }
      return;
    }

    if (resultRecoveryInterruption) {
      const canShowResultRecovery =
        !currentActionState ||
        currentActionState.phase === 'idle' ||
        currentActionState.phase === 'review_waiting_capacity' ||
        currentActionState.phase === 'resume_running';

      if (canShowResultRecovery) {
        store.showInterruptedActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          interruption: resultRecoveryInterruption,
        });
      }
      return;
    }

    if (isDeepReview && (!latestReviewData || latestReviewMode !== 'deep') && deepReviewInterruption) {
      store.showInterruptedActionBar({
        childSessionId,
        parentSessionId: parentSessionId ?? null,
        interruption: deepReviewInterruption,
      });
      return;
    }

    if (!isDeepReview && !latestReviewData && currentActionState) {
      const terminalWithoutReport = isComplete || isError || turnStatus === 'cancelled';
      if (terminalWithoutReport) {
        const message = lastTurn?.error ?? childSession.error ?? (
          turnStatus === 'cancelled'
            ? t('deepReviewActionBar.reviewCancelledWithoutReport')
            : t('deepReviewActionBar.reviewEndedWithoutReport')
        );
        store.setActiveAction(null, undefined, childSessionId);
        store.updatePhase('review_error', message, childSessionId);
        store.restore(childSessionId);
      }
      return;
    }

    if (!latestReviewData) return;
    if (isDeepReview && latestReviewMode !== 'deep') return;
    if (!isDeepReview && latestReviewMode === 'deep') return;

    const hasRemediationPlan = buildReviewRemediationItems(latestReviewData).length > 0;

    // Only activate if the action bar is idle or not yet shown for this session
    if (currentActionState && currentActionState.phase !== 'idle') {
      // A fix request briefly coexists with the previous completed review turn
      // until FlowChatManager creates the new fix turn; ignore that stale terminal state.
      const currentFixTurnHasStarted = currentActionState.phase !== 'fix_running' ||
        !currentActionState.fixingBaselineTurnId ||
        lastTurn?.id !== currentActionState.fixingBaselineTurnId;

      if (currentActionState.phase === 'fix_running' && !currentFixTurnHasStarted && (isComplete || isError)) {
        return;
      }

      if (
        currentActionState.phase === 'fix_running' &&
        currentFixTurnHasStarted &&
        (isComplete || isError || turnStatus === 'cancelled')
      ) {
        store.setRemediationModifiedFilePaths(
          collectModifiedFilePathsFromTurns(
            childSession.dialogTurns,
            currentActionState.fixingBaselineTurnId,
            childSession.workspacePath,
          ),
          childSessionId,
        );
        store.setRemediationScopeRequiresWorkspaceFallback(
          hasOpaqueWorkspaceMutationRisk(
            childSession.dialogTurns,
            currentActionState.fixingBaselineTurnId,
          ),
          childSessionId,
        );
      }

      // Update phase based on turn status if currently showing
      if (turnStatus === 'cancelled' && currentActionState.phase === 'fix_running') {
        const fixScopeIds = currentActionState.fixingRemediationIds.size > 0
          ? currentActionState.fixingRemediationIds
          : currentActionState.selectedRemediationIds;
        const remainingFixIds = [...fixScopeIds].filter((id) => !currentActionState.completedRemediationIds.has(id));
        store.setRemainingFixIds(remainingFixIds, childSessionId);
        store.setActiveAction(null, undefined, childSessionId);
        store.updatePhase('fix_interrupted', undefined, childSessionId);
        store.restore(childSessionId);
      } else if (isError && currentActionState.phase === 'resume_running') {
        store.updatePhase('resume_failed', childSession.error ?? undefined, childSessionId);
      } else if (
        isError &&
        currentActionState.phase !== 'fix_failed' &&
        currentActionState.phase !== 'review_error' &&
        currentActionState.phase !== 'fix_interrupted'
      ) {
        store.updatePhase(
          currentActionState.phase === 'fix_running' ? 'fix_failed' : 'review_error',
          childSession.error ?? undefined,
          childSessionId,
        );
      } else if (isComplete && currentActionState.phase === 'fix_running') {
        if (hasRemediationPlan && !isSameReviewResult(currentActionState.reviewData, latestReviewData)) {
          store.showActionBar({
            childSessionId,
            parentSessionId: parentSessionId ?? null,
            reviewData: latestReviewData,
            reviewMode,
            phase: 'review_completed',
            completedRemediationIds: currentActionState.completedRemediationIds,
          });
        } else {
          // Fix completed with no further remediation needed — update phase to
          // show completion state in the action bar instead of dismissing it.
          store.updatePhase('fix_completed', undefined, childSessionId);
        }
      } else if (isComplete && currentActionState.phase === 'resume_running') {
        store.showActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          reviewData: latestReviewData,
          reviewMode,
          phase: 'review_completed',
          completedRemediationIds: currentActionState.completedRemediationIds,
        });
      } else if (isComplete && currentActionState.phase === 'review_running') {
        store.showActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          reviewData: latestReviewData,
          reviewMode,
          phase: 'review_completed',
          completedRemediationIds: currentActionState.completedRemediationIds,
        });
      } else if (isComplete && currentActionState.phase === 'review_waiting_capacity') {
        store.showActionBar({
          childSessionId,
          parentSessionId: parentSessionId ?? null,
          reviewData: latestReviewData,
          reviewMode,
          phase: 'review_completed',
        });
      }
      return;
    }

    if (!isComplete && !isError) return;

    if (isError) {
      store.showActionBar({
        childSessionId,
        parentSessionId: parentSessionId ?? null,
        reviewData: latestReviewData,
        reviewMode,
        phase: 'review_error',
      });
      return;
    }

    store.showActionBar({
      childSessionId,
      parentSessionId: parentSessionId ?? null,
      reviewData: latestReviewData,
      reviewMode,
      phase: 'review_completed',
    });
  }, [
    childSession,
    childSessionId,
    parentSessionId,
    isReviewSession,
    isDeepReview,
    actionBarPhase,
    actionBarChildSessionId,
    t,
  ]);

  const persistedReviewWorkspacePath = childSession
    ? sessionProjectWorkspacePath(childSession)
    : undefined;
  const persistedReviewRemoteConnectionId = childSession?.remoteConnectionId;
  const persistedReviewRemoteSshHost = childSession?.remoteSshHost;

  // Restore persisted review action state once for each stable session location.
  useEffect(() => {
    if (!isReviewSession || !childSessionId || !persistedReviewWorkspacePath) return;
    const locationKey = JSON.stringify([
      childSessionId, persistedReviewWorkspacePath,
      persistedReviewRemoteConnectionId, persistedReviewRemoteSshHost,
    ]);
    if (viewState.restoredReviewLocation === locationKey) return;

    const store = useReviewActionBarStore.getState();
    const currentActionState = store.getSessionState(childSessionId);
    const canReplaceDerivedReviewState = currentActionState && [
      'review_running',
      'review_completed',
      'review_interrupted',
    ].includes(currentActionState.phase);
    // Initial session projection may finish before metadata is loaded. Persisted
    // action state is more specific for fix/review recovery than that projection.
    if (!canReplaceDerivedReviewState && currentActionState && currentActionState.phase !== 'idle') return;

    let cancelled = false;

    loadPersistedReviewState(
      childSessionId,
      persistedReviewWorkspacePath,
      persistedReviewRemoteConnectionId,
      persistedReviewRemoteSshHost,
    ).then((persisted: ReviewActionPersistedState | null) => {
      const latestChildSession = childSessionRef.current;
      if (cancelled || !latestChildSession) return;
      if (
        sessionProjectWorkspacePath(latestChildSession) !== persistedReviewWorkspacePath
        || latestChildSession.remoteConnectionId !== persistedReviewRemoteConnectionId
        || latestChildSession.remoteSshHost !== persistedReviewRemoteSshHost
      ) return;
      viewState.restoredReviewLocation = locationKey;
      if (!persisted) return;

      const latestReviewData = findLatestCodeReviewResult(latestChildSession) as DeepReviewActionData | null;
      const reviewMode: ReviewActionMode = isDeepReview ? 'deep' : 'standard';

      // Detect fix interruption
      let phase: ReviewActionPhase = persisted.phase as ReviewActionPhase;
      let remainingFixIds: string[] = [];
      const fixingBaselineTurnId = persisted.fixingBaselineTurnId ?? null;
      let remediationModifiedFilePaths = persisted.remediationModifiedFilePaths ?? [];
      let remediationScopeRequiresWorkspaceFallback =
        persisted.remediationScopeRequiresWorkspaceFallback ?? false;

      if (persisted.phase === 'fix_running') {
        const lastTurn = latestChildSession.dialogTurns[latestChildSession.dialogTurns.length - 1];
        const isStillRunning = isActiveReviewTurnStatus(lastTurn?.status);

        if (!isStillRunning) {
          // Fix was interrupted — determine remaining items
          phase = 'fix_interrupted';
          const latestItems = latestReviewData ? buildReviewRemediationItems(latestReviewData) : [];
          const latestIds = new Set(latestItems.map((i) => i.id));
          // Items that were being fixed but still exist in latest review data
          const completedIds = new Set(persisted.completedRemediationIds);
          remainingFixIds = (persisted.fixingRemediationIds ?? [])
            .filter((id: string) => latestIds.has(id) && !completedIds.has(id));
        }
        remediationModifiedFilePaths = [
          ...new Set([
            ...remediationModifiedFilePaths,
            ...collectModifiedFilePathsFromTurns(
              latestChildSession.dialogTurns,
              fixingBaselineTurnId,
              latestChildSession.workspacePath,
            ),
          ]),
        ];
        remediationScopeRequiresWorkspaceFallback =
          remediationScopeRequiresWorkspaceFallback ||
          hasOpaqueWorkspaceMutationRisk(
            latestChildSession.dialogTurns,
            fixingBaselineTurnId,
          );
      }

      store.showActionBar({
        childSessionId,
        parentSessionId: parentSessionId ?? null,
        reviewData: latestReviewData ?? ({} as CodeReviewRemediationData),
        reviewMode,
        phase,
        completedRemediationIds: new Set(persisted.completedRemediationIds),
      });

      // Apply additional restored state
      store.setCustomInstructions(persisted.customInstructions, childSessionId);
      if (persisted.reviewTargetFilePaths?.length) {
        store.setReviewTargetFilePaths(persisted.reviewTargetFilePaths, childSessionId);
      }
      if (remediationModifiedFilePaths.length) {
        store.setRemediationModifiedFilePaths(
          remediationModifiedFilePaths,
          childSessionId,
        );
      }
      store.setRemediationScopeRequiresWorkspaceFallback(
        remediationScopeRequiresWorkspaceFallback,
        childSessionId,
      );
      if (phase === 'fix_running' && fixingBaselineTurnId) {
        store.setFixingBaselineTurnId(fixingBaselineTurnId, childSessionId);
      }
      if (persisted.followUpReviewSessionId) {
        const pendingRequestId = getPendingFollowUpReviewRequestId(
          persisted.followUpReviewSessionId,
        );
        const followUpSessionId = pendingRequestId
          ? findReviewChildByRequestId(parentSessionId, pendingRequestId)
          : isPendingFollowUpReviewSessionId(persisted.followUpReviewSessionId)
            ? null
            : persisted.followUpReviewSessionId;
        if (
          followUpSessionId &&
          flowChatStore.getState().sessions.has(followUpSessionId)
        ) {
          store.setFollowUpReviewSessionId(followUpSessionId, childSessionId);
        } else if (pendingRequestId) {
          store.setFollowUpReviewSessionId(
            persisted.followUpReviewSessionId,
            childSessionId,
          );
        }
      }
      if (persisted.minimized) {
        store.minimize(childSessionId);
      }
      if (remainingFixIds.length > 0) {
        store.setRemainingFixIds(remainingFixIds, childSessionId);
      }
    }).catch(() => {
      // Ignore persistence load errors
    });

    return () => {
      cancelled = true;
    };
  }, [
    childSessionId,
    parentSessionId,
    isReviewSession,
    isDeepReview,
    persistedReviewWorkspacePath,
    persistedReviewRemoteConnectionId,
    persistedReviewRemoteSshHost,
    viewState,
  ]);

  // Observe action bar height to adjust body padding dynamically
  useEffect(() => {
    if (!retainsReviewActionBarLayout) {
      setActionBarHeight(0);
      return;
    }

    const el = actionBarRef.current;
    if (!el) return;
    const measuredEl =
      el.querySelector<HTMLElement>('.deep-review-action-bar') ?? el;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        setActionBarHeight(h);
      }
    });

    observer.observe(measuredEl);
    // Initial measurement
    setActionBarHeight(measuredEl.getBoundingClientRect().height);

    return () => {
      observer.disconnect();
    };
  }, [retainsReviewActionBarLayout]);

  const handleStopReviewSession = useCallback(async () => {
    if (!childSessionId || stoppingReview || !isTurnProcessing) {
      return;
    }

    setStoppingReview(true);
    const reportUnconfirmedStop = async () => {
      await loadChildHistory().catch(() => undefined);
      const latestSession = flowChatStore.getState().sessions.get(childSessionId);
      const latestTurn = latestSession?.dialogTurns[latestSession.dialogTurns.length - 1];
      if (isActiveReviewTurnStatus(latestTurn?.status)) {
        notificationService.error(
          t(viewKind === 'review-check'
            ? 'toolCards.taskDetailPanel.stopReviewWorkFailed'
            : 'childSession.stopReviewFailed'),
        );
      }
    };
    try {
      const result = await agentAPI.cancelSession(childSessionId);
      if (!result.cancelled) {
        await reportUnconfirmedStop();
      } else {
        await loadChildHistory().catch(() => undefined);
      }
    } catch (error) {
      log.error('Failed to stop review session', { childSessionId, error });
      await reportUnconfirmedStop();
    } finally {
      setStoppingReview(false);
    }
  }, [childSessionId, stoppingReview, isTurnProcessing, loadChildHistory, t, viewKind]);

  const stopReviewLabel = viewKind === 'review-check'
    ? t('toolCards.taskDetailPanel.stopReviewWork')
    : t('childSession.stopReview');
  const stoppingReviewLabel = viewKind === 'review-check'
    ? t('toolCards.taskDetailPanel.stoppingReviewWork')
    : t('childSession.stoppingReview');
  const returnToParentLabel = viewKind === 'review-check'
    ? t('childSession.backToReview')
    : t('btw.backToParent');

  const handleReturnToParentSession = useCallback(() => {
    const resolvedParentSessionId = btwOrigin?.parentSessionId || parentSessionId;
    if (!resolvedParentSessionId) {
      return;
    }

    const requestId = btwOrigin?.requestId;
    const request: FlowChatFocusItemRequest = {
      sessionId: resolvedParentSessionId,
      turnId: btwOrigin?.parentDialogTurnId,
      turnIndex: btwOrigin?.parentTurnIndex,
      itemId: requestId ? `btw_marker_${requestId}` : undefined,
      source: 'btw-back',
    };

    globalEventBus.emit(
      FLOWCHAT_FOCUS_ITEM_EVENT,
      request,
      'BtwSessionPanel',
    );
  }, [btwOrigin, parentSessionId]);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      childKind !== 'btw' ||
      !isTurnProcessing ||
      !childSessionId ||
      isImeOwnedKeyboardEvent(event.nativeEvent)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void FlowChatManager.getInstance().cancelSessionTask(childSessionId);
  }, [childKind, childSessionId, isTurnProcessing]);

  if (!childSessionId || !childSession) {
    return (
      <div className="btw-session-panel btw-session-panel--empty" data-openbitfun-component="btw-session-panel" data-openbitfun-part="root" data-openbitfun-view="empty">
        <div className="btw-session-panel__empty-state" data-openbitfun-component="btw-session-panel" data-openbitfun-part="empty">
          {t('btw.emptyThreadLabel', { label: t('btw.threadLabel') })}
        </div>
      </div>
    );
  }

  return (
    <FlowChatContext.Provider value={contextValue}>
      <ConversationExcerptSourceProvider sessionId={childSession.sessionId}>
      <FlowChatVolatileContext.Provider value={volatileContextValue}>
      <div
        className={`btw-session-panel${retainsReviewActionBarLayout ? ' btw-session-panel--has-action-bar' : ''}`}
        onKeyDown={handlePanelKeyDown}
        data-openbitfun-component="btw-session-panel"
        data-openbitfun-part="root"
        data-openbitfun-view="session"
        data-openbitfun-state={retainsReviewActionBarLayout ? 'hasActionBar' : undefined}
      >
        <div className="btw-session-panel__header" data-openbitfun-component="btw-session-panel" data-openbitfun-part="header">
          <div className="btw-session-panel__header-left" data-openbitfun-component="btw-session-panel" data-openbitfun-part="headerMain">
            {childKind === 'subagent' ? (
              <SubagentAvatar
                sessionId={childSessionId}
                name={displayTitle}
                size={24}
                status={subagentAvatarStatus}
              />
            ) : null}
            <span className="btw-session-panel__badge" data-openbitfun-component="btw-session-panel" data-openbitfun-part="badge">{childBadgeLabel}</span>
          </div>
          <div className="btw-session-panel__header-title-wrap">
            <OverflowText className="btw-session-panel__title" data-openbitfun-component="btw-session-panel" data-openbitfun-part="title">
              {displayTitle?.trim() || (viewKind === 'review-check'
                ? childBadgeLabel
                : resolveSessionTitle(childSession, childTitleFallback))}
            </OverflowText>
          </div>
          <div className="btw-session-panel__header-right" data-openbitfun-component="btw-session-panel" data-openbitfun-part="actions">
            {showOriginMeta && (
              <div className="btw-session-panel__meta" data-openbitfun-component="btw-session-panel" data-openbitfun-part="meta">
                <span className="btw-session-panel__meta-label">{childOriginLabel}</span>
                <Icon name="link" size="2xs" />
                <OverflowText className="btw-session-panel__meta-title">{resolveSessionTitle(parentMetadata, t('btw.parent'))}</OverflowText>
              </div>
            )}
            {(viewKind === 'review-check' || childKind === 'review' || childKind === 'deep_review') && (
              <Tooltip content={stoppingReview
                  ? stoppingReviewLabel
                  : stopReviewLabel}>
                <IconButton
                  className="btw-session-panel__stop-button"
                  size="sm"
                  onClick={() => void handleStopReviewSession()}
                  disabled={!canStopReviewSession}
                  aria-label={stoppingReview
                    ? stoppingReviewLabel
                    : stopReviewLabel}
                  data-testid="btw-session-panel-stop-review"
                  icon={stoppingReview ? (
                    <Loader2
                      className="btw-session-panel__stop-spinner"
                      size={11}
                      data-testid="btw-session-panel-stop-spinner"
                    />
                  ) : (
                    <Square size={11} />
                  )}
                />
              </Tooltip>
            )}
            {canReturnToParentSession && (
              <Tooltip content={viewKind === 'review-check' ? returnToParentLabel : backTooltip}>
                <IconButton
                  className="btw-session-panel__origin-button"
                  size="sm"
                  onClick={handleReturnToParentSession}
                  aria-label={returnToParentLabel}
                  data-testid="btw-session-panel-origin-button"
                  icon={<CornerUpLeft size={12} />}
                />
              </Tooltip>
            )}
          </div>
        </div>

        {activePermissionBatch ? (
          <div className="btw-session-panel__permission-approval">
            <ChatInputApprovalBand
              key={`${activePermissionBatch.sessionId}:${activePermissionBatch.roundId}`}
              requests={activePermissionBatch.requests}
              totalPendingCount={ownedPermissionRequests.length}
              onRespond={respondPermission}
              onRespondBatch={respondPermissionBatch}
            />
          </div>
        ) : null}

        <div
          ref={scrollContainerRef}
          data-flowchat-selection-root={childSessionId}
          data-flowchat-parent-session-id={parentSessionId}
          tabIndex={-1}
          className="btw-session-panel__body"
          data-openbitfun-component="btw-session-panel"
          data-openbitfun-part="body"
          style={{
            paddingTop: 0,
            overflowAnchor: 'none',
            ...(reviewActionBottomPadding > 0 ? { paddingBottom: reviewActionBottomPadding } : {}),
          }}
        >
          {/* Include the top inset and notices in the virtualizer's measured offset. */}
          <div ref={listHeaderRef} style={{ paddingTop: 12 }}>
            {isReviewDetail && reviewDetailNotices.length > 0 && (
              <div
                className={`btw-session-panel__empty-state${virtualItems.length > 0 ? ' btw-session-panel__empty-state--with-content' : ''}`}
                data-openbitfun-component="btw-session-panel"
                data-openbitfun-part="empty"
                role={reviewDetailNotices.some(({ state }) =>
                  state === 'load-failed' || state === 'failed' || state === 'timed-out')
                  ? 'alert'
                  : 'status'}
                aria-live="polite"
              >
                {reviewDetailNotices.map(({ state, key }) => (
                  <span key={state}>{t(key, { label: childBadgeLabel })}</span>
                ))}
                {canRetryReviewDetailLoad && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadChildHistory}
                  >
                    {t('childSession.reviewDetail.retryLoad')}
                  </Button>
                )}
              </div>
            )}
          </div>
          {virtualItems.length === 0 ? (
            !isReviewDetail || reviewDetailNotices.length === 0 ? (
              <div className="btw-session-panel__empty-state" data-openbitfun-component="btw-session-panel" data-openbitfun-part="empty">{t('session.empty')}</div>
            ) : null
          ) : (
            <BtwVirtualSessionList
              key={childSessionId}
              items={virtualItems}
              scrollerRef={scrollContainerRef}
              headerRef={listHeaderRef}
              followRef={shouldAutoScrollRef}
              viewportOwner={viewportOwner}
              exploreGroupStates={exploreGroupStates}
              onExpandGroup={onExpandGroup}
              isHistorical={childSession.isHistorical === true}
              viewState={viewState}
            />
          )}
          {childSession.sessionKind === 'btw' && <FlowChatSelectionBar rootRef={scrollContainerRef}
            sessionId={childSessionId} parentSessionId={parentSessionId} onSelectionIntent={() => {
              shouldAutoScrollRef.current = false;
              viewState.followTail = false;
            }} />}
          <RuntimeStatusSlot
            sessionId={childSessionId}
            className="btw-session-panel__runtime-status"
          />
        </div>
        <ScrollToBottomButton
          visible={showScrollToBottom}
          onClick={handleScrollToBottom}
          focusReturnRef={scrollContainerRef}
          className="btw-session-panel__scroll-to-bottom"
          data-openbitfun-component="btw-session-panel"
          data-openbitfun-part="scrollToBottom"
        />
        <div
          className="btw-session-panel__minimized-indicator"
          data-openbitfun-component="btw-session-panel"
          data-openbitfun-part="minimized"
          data-openbitfun-state={showMinimizedIndicator ? 'minimized' : 'hidden'}
          aria-hidden={!showMinimizedIndicator}
          {...(!showMinimizedIndicator ? { inert: '' } : {})}
        >
            <button
              type="button"
              onClick={() => useReviewActionBarStore.getState().restore(childSessionId)}
              className="btw-session-panel__minimized-button"
              aria-label={t('deepReviewActionBar.restore', {
                label: minimizedActionLabel,
              })}
            >
              <Icon name="spark" size="sm" />
              <span className="btw-session-panel__minimized-text">
                {minimizedActionLabel}
              </span>
              {totalCount > 0 && (
                <span className="btw-session-panel__minimized-count">
                  {minimizedCountLabel}
                </span>
              )}
            </button>
        </div>

        <RetainedMountBoundary present={showReviewActionBar}>
          <div
            ref={actionBarRef}
            className="btw-session-panel__action-bar-wrapper"
            data-openbitfun-component="btw-session-panel"
            data-openbitfun-part="actionBar"
            data-visible={showReviewActionBar ? 'true' : 'false'}
            aria-hidden={!showReviewActionBar}
            {...(!showReviewActionBar ? { inert: '' } : {})}
          >
            <ReviewActionBar childSessionId={childSessionId} />
          </div>
        </RetainedMountBoundary>
      </div>
      </FlowChatVolatileContext.Provider>
      </ConversationExcerptSourceProvider>
    </FlowChatContext.Provider>
  );
};

export const BtwSessionPanel: React.FC<BtwSessionPanelProps> = (props) => {
  const surfaceId = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceId, getActiveSurfaceId);
  const viewState = useMemo(createBtwPanelViewState, [surfaceId, props.childSessionId, props.viewKind]);
  return props.isActive === false ? null : (
    <BtwSessionPanelContent
      key={`${surfaceId}:${props.childSessionId}:${props.viewKind ?? ''}`}
      {...props}
      viewState={viewState}
    />
  );
};

BtwSessionPanel.displayName = 'BtwSessionPanel';
