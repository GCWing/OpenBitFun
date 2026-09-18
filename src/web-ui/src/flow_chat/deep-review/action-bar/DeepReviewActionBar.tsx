import { Icon, Textarea, type IconName } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  AlertCircle,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import {
  buildPendingFollowUpReviewSessionId,
  getPendingFollowUpReviewRequestId,
  getReviewActionBarStateForSession,
  isPendingFollowUpReviewSessionId,
  useReviewActionBarStore,
  type DeepReviewCapacityQueueAction,
  type DeepReviewCapacityQueueState,
  type ReviewActionPhase,
} from '../../store/deepReviewActionBarStore';
import { buildSelectedReviewRemediationPrompt } from '../../utils/codeReviewRemediation';
import {
  buildDeepReviewRetryPrompt,
  extractDeepReviewRetryableSlices,
  type RemediationGroupId,
} from '../../utils/codeReviewReport';
import { continueDeepReviewSession } from '../../services/DeepReviewContinuationService';
import { flowChatManager } from '../../services/FlowChatManager';
import { persistReviewActionState } from '../../services/ReviewActionBarPersistenceService';
import { globalEventBus } from '@/infrastructure/event-bus';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { getAiErrorPresentation } from '@/shared/ai-errors/aiErrorPresenter';
import { confirmWarning } from '@/infrastructure/confirm-dialog';
import {
  aggregateReviewerProgress,
  buildErrorAttribution,
  buildRecoveryPlan,
  buildReviewerProgressSummary,
  evaluateDegradationOptions,
  extractPartialReviewData,
} from '../../utils/deepReviewExperience';
import { flowChatStore } from '../../store/FlowChatStore';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { useSceneStore } from '@/app/stores/sceneStore';
import type { SettingsPageId } from '@/app/scenes/settings/settingsTypes';
import {
  getReviewActionErrorMessage,
  formatElapsedTime,
} from './actionBarFormatting';
import { CapacityQueueNotice } from './CapacityQueueNotice';
import { DecisionExecutionGate } from './DecisionExecutionGate';
import { buildInterruptionDiagnostics } from './interruptionDiagnostics';
import { PartialResultsPanel } from './PartialResultsPanel';
import { RemediationSelectionPanel } from './RemediationSelectionPanel';
import { RecoveryPlanPreview } from './RecoveryPlanPreview';
import { ReviewActionControls, type FollowUpReviewState } from './ReviewActionControls';
import { ReviewActionHeader } from './ReviewActionHeader';
import {
  launchPreparedReviewSession,
  prepareReviewLaunchFromSlashCommand,
  prepareReviewLaunchFromSessionFiles,
} from '../../services/ReviewService';
import { createBtwRequestId } from '../../services/BtwThreadService';
import { openBtwSessionInAuxPane } from '../../services/btwSessionPane';
import type { Session } from '../../types/flow-chat';
import { useDeepReviewConsent } from '../../components/DeepReviewConsentDialog';
import { deriveDeepReviewSessionConcurrencyGuard } from '../../utils/deepReviewCapacityGuard';
import { isProjectedSessionEmpty } from '../../utils/flowChatTurnIdentity';
import '../../components/btw/DeepReviewActionBar.scss';

const log = createLogger('DeepReviewActionBar');

function openSettingsPage(pageId: SettingsPageId) {
  useSettingsStore.getState().openPage(pageId);
  useSceneStore.getState().openScene('settings');
}

function normalizeActionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'unknown error';
}

function deriveFollowUpReviewState(
  followUpSessionId: string | null,
  session: Session | null,
  activeAction: string | null,
): FollowUpReviewState {
  if (!followUpSessionId) return 'none';
  if (isPendingFollowUpReviewSessionId(followUpSessionId)) {
    return activeAction === 'review' ? 'launching' : 'retry';
  }
  if (!session) return 'retry';

  const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
  if (!lastTurn) {
    return session.isHistorical ||
      session.historyState === 'metadata-only' ||
      session.historyState === 'hydrating'
      ? 'available'
      : 'retry';
  }
  if (lastTurn.status === 'cancelled') return 'cancelled';
  if (lastTurn.status === 'error' || session.status === 'error') return 'failed';
  if (lastTurn.status === 'completed') return 'completed';
  return 'running';
}

function buildCapacityQueueControlToolIds(
  capacityQueueState: DeepReviewCapacityQueueState,
  action: DeepReviewCapacityQueueAction,
): string[] {
  const waitingReviewers = capacityQueueState.waitingReviewers ?? [];
  const targetReviewers = action === 'skip_optional'
    ? waitingReviewers.filter((reviewer) => reviewer.optional)
    : waitingReviewers;
  const toolIds = targetReviewers
    .map((reviewer) => reviewer.toolId)
    .filter((toolId): toolId is string => Boolean(toolId));

  if (toolIds.length > 0) {
    return [...new Set(toolIds)];
  }

  return capacityQueueState.toolId ? [capacityQueueState.toolId] : [];
}

const stopNestedScrollPropagation = (event: React.WheelEvent | React.TouchEvent) => {
  event.stopPropagation();
  if ('nativeEvent' in event && typeof event.nativeEvent.stopImmediatePropagation === 'function') {
    event.nativeEvent.stopImmediatePropagation();
  }
};

interface PendingDecisionAction {
  selectedIds: Set<string>;
}

interface ReviewActionBarProps {
  childSessionId?: string;
}

type PhaseIconComponent = React.ComponentType<{
  size?: number | string;
  style?: React.CSSProperties;
  className?: string;
}>;

function catalogPhaseIcon(name: Extract<IconName, 'check-circle' | 'clock'>): PhaseIconComponent {
  return function CatalogPhaseIcon({ size = 18, style, className }) {
    return (
      <Icon
        name={name}
        size="lg"
        className={className}
        style={{ width: size, height: size, ...style }}
      />
    );
  };
}

const PHASE_CONFIG: Record<ReviewActionPhase, {
  icon: PhaseIconComponent;
  iconClass: string;
  variant: 'success' | 'warning' | 'error' | 'info' | 'loading';
}> = {
  idle: { icon: catalogPhaseIcon('clock'), iconClass: '', variant: 'info' },
  review_running: { icon: Loader2, iconClass: 'deep-review-action-bar__icon--loading', variant: 'loading' },
  review_completed: { icon: catalogPhaseIcon('check-circle'), iconClass: 'deep-review-action-bar__icon--success', variant: 'success' },
  fix_running: { icon: Loader2, iconClass: 'deep-review-action-bar__icon--loading', variant: 'loading' },
  fix_completed: { icon: catalogPhaseIcon('check-circle'), iconClass: 'deep-review-action-bar__icon--success', variant: 'success' },
  fix_failed: { icon: AlertCircle, iconClass: 'deep-review-action-bar__icon--error', variant: 'error' },
  fix_timeout: { icon: catalogPhaseIcon('clock'), iconClass: 'deep-review-action-bar__icon--warning', variant: 'warning' },
  fix_interrupted: { icon: AlertTriangle, iconClass: 'deep-review-action-bar__icon--warning', variant: 'warning' },
  review_waiting_capacity: { icon: catalogPhaseIcon('clock'), iconClass: 'deep-review-action-bar__icon--warning', variant: 'warning' },
  review_interrupted: { icon: AlertTriangle, iconClass: 'deep-review-action-bar__icon--warning', variant: 'warning' },
  resume_blocked: { icon: AlertTriangle, iconClass: 'deep-review-action-bar__icon--error', variant: 'error' },
  resume_running: { icon: Loader2, iconClass: 'deep-review-action-bar__icon--loading', variant: 'loading' },
  resume_failed: { icon: AlertCircle, iconClass: 'deep-review-action-bar__icon--error', variant: 'error' },
  review_error: { icon: AlertTriangle, iconClass: 'deep-review-action-bar__icon--error', variant: 'error' },
};

export const ReviewActionBar: React.FC<ReviewActionBarProps> = ({ childSessionId: scopedChildSessionId }) => {
  const { t } = useTranslation('flow-chat');
  const store = useReviewActionBarStore();
  const scopedState = scopedChildSessionId
    ? getReviewActionBarStateForSession(store, scopedChildSessionId)
    : null;
  const actionState = scopedState ?? store;
  const {
    childSessionId,
    parentSessionId,
    reviewMode,
    phase,
    reviewData,
    remediationItems,
    selectedRemediationIds,
    activeAction,
    followUpReviewSessionId,
    reviewTargetFilePaths,
    lastSubmittedAction,
    customInstructions,
    errorMessage,
    interruption,
    completedRemediationIds,
    fixingRemediationIds,
    remediationModifiedFilePaths,
    remediationScopeRequiresWorkspaceFallback,
    remainingFixIds,
    decisionSelections,
    capacityQueueState,
  } = actionState;
  const { confirmDeepReviewLaunch, deepReviewConsentDialog } = useDeepReviewConsent();

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [showRemediationList, setShowRemediationList] = useState(true);
  const [showPartialResults, setShowPartialResults] = useState(false);
  const [expandedDecisionIds, setExpandedDecisionIds] = useState<Set<string>>(new Set());
  const [pendingDecisionAction, setPendingDecisionAction] = useState<PendingDecisionAction | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [longRunningNotified, setLongRunningNotified] = useState(false);

  const selectedCount = selectedRemediationIds.size;
  const isFixDisabled = activeAction !== null || selectedCount === 0;
  const isDeepReview = reviewMode === 'deep';
  const hasInterruption = isDeepReview && Boolean(interruption);
  const isResumeRunning = phase === 'resume_running';
  const showInterruptionDetails = hasInterruption && !isResumeRunning;
  const showCapacityQueueNotice = isDeepReview &&
    Boolean(capacityQueueState) &&
    capacityQueueState?.status !== 'running' &&
    capacityQueueState?.status !== 'capacity_skipped';
  const backendQueueControlToolIds = useMemo(
    () => capacityQueueState
      ? buildCapacityQueueControlToolIds(capacityQueueState, 'cancel')
      : [],
    [capacityQueueState],
  );
  const hasBackendQueueControlTarget = Boolean(
    childSessionId &&
    capacityQueueState?.dialogTurnId &&
    backendQueueControlToolIds.length > 0,
  );
  const supportsInlineQueueControls =
    capacityQueueState?.controlMode === 'backend'
      ? hasBackendQueueControlTarget
      : capacityQueueState?.controlMode !== 'session_stop_only';
  const handleCapacityQueueAction = useCallback(async (
    action: DeepReviewCapacityQueueAction,
    applyLocalAction: () => void,
  ) => {
    if (!capacityQueueState) {
      return;
    }

    if (capacityQueueState.controlMode !== 'backend') {
      applyLocalAction();
      return;
    }

    const toolIds = buildCapacityQueueControlToolIds(capacityQueueState, action);
    if (!childSessionId || !capacityQueueState.dialogTurnId || toolIds.length === 0) {
      notificationService.error(t('deepReviewActionBar.capacityQueue.controlFailed'));
      return;
    }

    const dialogTurnId = capacityQueueState.dialogTurnId;
    const controlResults = await Promise.allSettled(toolIds.map((toolId) => agentAPI.controlDeepReviewQueue({
      sessionId: childSessionId,
      dialogTurnId,
      toolId,
      action,
    })));
    const failedResults = controlResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedResults.length > 0) {
      const reason = normalizeActionErrorMessage(failedResults[0].reason);
      log.warn('Failed to control DeepReview capacity queue', failedResults[0].reason);
      if (failedResults.length < toolIds.length) {
        notificationService.error(t('deepReviewActionBar.capacityQueue.controlPartiallyFailedWithReason', {
          failed: failedResults.length,
          total: toolIds.length,
          reason,
        }));
        return;
      }
      notificationService.error(t('deepReviewActionBar.capacityQueue.controlFailedWithReason', {
        reason,
      }));
      return;
    }

    applyLocalAction();
  }, [capacityQueueState, childSessionId, t]);

  const handleOpenReviewSettings = useCallback(() => {
    useSettingsStore.getState().openDestination({
      pageId: 'tools.execution',
    });
    useSceneStore.getState().openScene('settings');
  }, []);

  // ---- progress tracking ----
  const sessions = flowChatStore.getState().sessions;
  const childSession = useMemo(() => {
    if (!childSessionId) return null;
    return Array.from(sessions.values()).find((s) => s.sessionId === childSessionId) ?? null;
  }, [sessions, childSessionId]);
  const followUpReviewSession = followUpReviewSessionId &&
    !isPendingFollowUpReviewSessionId(followUpReviewSessionId)
    ? sessions.get(followUpReviewSessionId) ?? null
    : null;
  const followUpReviewState = deriveFollowUpReviewState(
    followUpReviewSessionId,
    followUpReviewSession,
    activeAction,
  );

  const retryableSlices = useMemo(() => {
    if (!isDeepReview || !reviewData || !childSession?.deepReviewRunManifest) {
      return [];
    }
    return extractDeepReviewRetryableSlices(reviewData, childSession.deepReviewRunManifest);
  }, [isDeepReview, reviewData, childSession?.deepReviewRunManifest]);

  const reviewerProgress = useMemo(() => {
    if (!childSession || childSession.sessionKind !== 'deep_review') return [];
    return aggregateReviewerProgress(childSession);
  }, [childSession]);

  const progressSummary = useMemo(() => {
    if (reviewerProgress.length === 0) return null;
    return buildReviewerProgressSummary(reviewerProgress);
  }, [reviewerProgress]);

  const progressText = useMemo(() => {
    if (!progressSummary) {
      return null;
    }
    if (phase === 'resume_running') {
      return t('deepReviewActionBar.progressResumePreserved', {
        preserved: progressSummary.completed,
        total: progressSummary.total,
      });
    }
    return t('deepReviewActionBar.progressHandled', {
      handled: progressSummary.handled,
      total: progressSummary.total,
      defaultValue: progressSummary.text,
    });
  }, [phase, progressSummary, t]);
  const managedReviewPlan = childSession?.deepReviewRunManifest?.managedReviewPlan;

  const partialResults = useMemo(() => {
    if (!childSession || childSession.sessionKind !== 'deep_review') return null;
    return extractPartialReviewData(childSession);
  }, [childSession]);

  // ---- error attribution ----
  const errorAttribution = useMemo(() => {
    if (!interruption) return null;
    return buildErrorAttribution(interruption);
  }, [interruption]);

  // ---- recovery plan ----
  const recoveryPlan = useMemo(() => {
    if (!interruption) return null;
    return buildRecoveryPlan(interruption);
  }, [interruption]);

  // ---- degradation options ----
  const degradationOptions = useMemo(() => {
    if (!interruption) return [];
    return evaluateDegradationOptions(interruption);
  }, [interruption]);

  const modelRecoveryAction = useMemo(() => {
    const actionCodes = new Set(interruption?.recommendedActions.map((action) => action.code) ?? []);
    if (actionCodes.has('switch_model')) {
      return 'switch_model';
    }
    if (actionCodes.has('open_model_settings')) {
      return 'open_model_settings';
    }
    return null;
  }, [interruption]);

  // ---- long-running hint ----
  useEffect(() => {
    if (phase !== 'review_running' && phase !== 'fix_running' && phase !== 'resume_running') {
      setElapsedMs(0);
      setLongRunningNotified(false);
      return;
    }
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setElapsedMs(elapsed);
      if (elapsed > 3 * 60 * 1000 && !longRunningNotified) {
        setLongRunningNotified(true);
        notificationService.info(
          t('deepReviewActionBar.longRunningHint'),
          { duration: 5000 },
        );
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [phase, longRunningNotified, t]);

  const phaseConfig = PHASE_CONFIG[phase];
  const PhaseIcon = phaseConfig.icon;

  const decisionGateItems = useMemo(() => {
    if (!pendingDecisionAction) {
      return [];
    }
    return remediationItems.filter((item) => (
      pendingDecisionAction.selectedIds.has(item.id) &&
      item.requiresDecision &&
      !completedRemediationIds.has(item.id)
    ));
  }, [completedRemediationIds, pendingDecisionAction, remediationItems]);

  const decisionGateMissingSelection = useMemo(() => (
    decisionGateItems.some((item) => (
      (item.decisionContext?.options?.length ?? 0) > 0 &&
      decisionSelections[item.id] == null
    ))
  ), [decisionGateItems, decisionSelections]);

  const handleToggleRemediation = useCallback((id: string) => {
    store.toggleRemediation(id, childSessionId ?? undefined);
  }, [childSessionId, store]);

  const handleToggleAll = useCallback(() => {
    store.toggleAllRemediation(childSessionId ?? undefined);
  }, [childSessionId, store]);

  const handleToggleGroup = useCallback((groupId: RemediationGroupId | 'ungrouped') => {
    store.toggleGroupRemediation(groupId, childSessionId ?? undefined);
  }, [childSessionId, store]);

  const handleToggleDecisionExpansion = useCallback((id: string) => {
    setExpandedDecisionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleStartFixing = useCallback(async (
    overrideSelectedIds?: Set<string>,
    options?: { skipDecisionGate?: boolean },
  ) => {
    if (!reviewData || !childSessionId) return;

    const idsToFix = overrideSelectedIds ?? selectedRemediationIds;
    const selectedDecisionItems = remediationItems.filter((item) => (
      idsToFix.has(item.id) &&
      item.requiresDecision &&
      !completedRemediationIds.has(item.id)
    ));
    if (!options?.skipDecisionGate && selectedDecisionItems.length > 0) {
      const decisionIds = selectedDecisionItems.map((item) => item.id);
      setPendingDecisionAction({ selectedIds: new Set(idsToFix) });
      setShowRemediationList(true);
      setExpandedDecisionIds((current) => new Set([...current, ...decisionIds]));
      return;
    }

    const action = 'fix';
    let prompt = buildSelectedReviewRemediationPrompt({
      reviewData,
      selectedIds: idsToFix,
      reviewMode,
      completedItems: [...completedRemediationIds],
      decisionSelections,
    });

    if (!prompt) return;

    if (customInstructions.trim()) {
      prompt = `${prompt}\n\n## User Instructions\n${customInstructions.trim()}`;
    }

    const baselineTurnId = childSession?.dialogTurns.at(-1)?.id ?? null;
    store.setActiveAction(action, { baselineTurnId }, childSessionId);
    store.updatePhase('fix_running', undefined, childSessionId);
    store.minimize(childSessionId ?? undefined);

    try {
      await persistReviewActionState(useReviewActionBarStore.getState());
      await flowChatManager.sendMessage(
        prompt,
        childSessionId,
        t(isDeepReview
            ? 'reviewActionBar.fixRequestDisplayDeep'
            : 'reviewActionBar.fixRequestDisplayStandard', {
            defaultValue: isDeepReview
              ? 'Start fixing strict review findings'
              : 'Start fixing review findings',
          }),
        'ReviewFixer',
        'Standard',
      );
    } catch (error) {
      log.error('Failed to start review remediation', { childSessionId, reviewMode, error });
      const msg = error instanceof Error ? error.message : String(error);
      const isTimeout = /timeout/i.test(msg);
      const message = getReviewActionErrorMessage(error, t, t('deepReviewActionBar.actionStartFailed'));
      store.updatePhase(isTimeout ? 'fix_timeout' : 'fix_failed', message, childSessionId);
      store.restore(childSessionId ?? undefined);
      notificationService.error(
        message,
        { duration: 5000 },
      );
    } finally {
      store.setActiveAction(null, undefined, childSessionId);
    }
  }, [reviewData, childSessionId, childSession, selectedRemediationIds, remediationItems, completedRemediationIds, customInstructions, reviewMode, isDeepReview, decisionSelections, store, t]);

  const handleReviewFixes = useCallback(async () => {
    if (!isTauriRuntime()) {
      notificationService.warning(t('chatInput.reviewUnavailableSurface'));
      return;
    }
    const workspacePath = childSession?.workspacePath;
    if (!childSessionId || !parentSessionId || !workspacePath) {
      notificationService.error(t('deepReviewActionBar.reviewFixesUnavailable'));
      return;
    }

    const currentActionState = store.getSessionState(childSessionId);
    if (!currentActionState || currentActionState.activeAction !== null) {
      return;
    }
    const pendingFollowUpRequestId = getPendingFollowUpReviewRequestId(
      currentActionState.followUpReviewSessionId,
    );
    const currentFollowUpSession = currentActionState.followUpReviewSessionId &&
      !pendingFollowUpRequestId
      ? flowChatStore.getState().sessions.get(currentActionState.followUpReviewSessionId) ?? null
      : null;
    const currentFollowUpState = deriveFollowUpReviewState(
      currentActionState.followUpReviewSessionId,
      currentFollowUpSession,
      currentActionState.activeAction,
    );
    if (!['none', 'retry', 'failed', 'cancelled'].includes(currentFollowUpState)) {
      return;
    }
    const recoverableEmptySessionRequestId = currentFollowUpSession
      && isProjectedSessionEmpty(currentFollowUpSession)
      ? currentFollowUpSession.btwOrigin?.requestId
      : undefined;

    store.setActiveAction('review', undefined, childSessionId);
    try {
      const originalReviewTargetFilePaths = reviewTargetFilePaths.length > 0
        ? reviewTargetFilePaths
        : childSession.reviewTargetFilePaths
        ?? childSession.deepReviewRunManifest?.target.files
          .filter((file) => !file.excluded)
          .map((file) => file.normalizedPath)
        ?? [];
      const followUpReviewTargetFilePaths = [
        ...new Set([
          ...originalReviewTargetFilePaths,
          ...remediationModifiedFilePaths,
        ]),
      ];
      if (followUpReviewTargetFilePaths.length === 0) {
        notificationService.info(t('deepReviewActionBar.reviewFixesScopeFallback'), {
          duration: 4000,
        });
      }
      if (remediationScopeRequiresWorkspaceFallback) {
        notificationService.info(t('deepReviewActionBar.reviewFixesCommandScopeFallback'), {
          duration: 5000,
        });
      }
      const prepared = remediationScopeRequiresWorkspaceFallback
        ? await prepareReviewLaunchFromSlashCommand(
            '/review',
            workspacePath,
            childSession.remoteConnectionId,
            childSession.workspaceId,
          )
        : followUpReviewTargetFilePaths.length > 0
        ? await prepareReviewLaunchFromSessionFiles(followUpReviewTargetFilePaths, {
            workspacePath,
            workspaceId: childSession.workspaceId,
            remoteConnectionId: childSession.remoteConnectionId,
          })
        : await prepareReviewLaunchFromSlashCommand(
            '/review',
            workspacePath,
            childSession.remoteConnectionId,
            childSession.workspaceId,
          );
      if (prepared.mode === 'strict' && prepared.requiresConsent) {
        const confirmed = await confirmDeepReviewLaunch(prepared.runManifest, {
          sessionConcurrencyGuard: deriveDeepReviewSessionConcurrencyGuard(
            flowChatStore.getState(),
            parentSessionId,
          ),
        });
        if (!confirmed) {
          return;
        }
      }

      const followUpRequestId = pendingFollowUpRequestId
        ?? recoverableEmptySessionRequestId
        ?? createBtwRequestId('review_follow_up');
      store.setFollowUpReviewSessionId(
        buildPendingFollowUpReviewSessionId(followUpRequestId),
        childSessionId,
      );
      await persistReviewActionState(useReviewActionBarStore.getState());

      const launched = await launchPreparedReviewSession({
        parentSessionId,
        workspacePath,
        displayMessage: t('deepReviewActionBar.reviewFixesRequest'),
        childSessionName: t('deepReviewActionBar.reviewFixesThreadTitle'),
        requestId: followUpRequestId,
        prepared,
      });
      store.setFollowUpReviewSessionId(launched.childSessionId, childSessionId);
      if (launched?.launchStatus === 'uncertain') {
        notificationService.warning(t('deepReviewActionBar.launchError.uncertain'), {
          duration: 8000,
        });
      }
      try {
        await persistReviewActionState(useReviewActionBarStore.getState());
      } catch (error) {
        log.warn('Follow-up review started but its final session id was not persisted', {
          childSessionId,
          followUpReviewSessionId: launched.childSessionId,
          error,
        });
      }
    } catch (error) {
      log.error('Failed to start remediation follow-up review', {
        childSessionId,
        reviewMode,
        error,
      });
      const message = getReviewActionErrorMessage(error, t, t('deepReviewActionBar.actionStartFailed'));
      notificationService.error(message, { duration: 5000 });
    } finally {
      store.setActiveAction(null, undefined, childSessionId);
    }
  }, [
    childSession,
    childSessionId,
    confirmDeepReviewLaunch,
    parentSessionId,
    remediationModifiedFilePaths,
    remediationScopeRequiresWorkspaceFallback,
    reviewMode,
    reviewTargetFilePaths,
    store,
    t,
  ]);

  const handleOpenFollowUpReview = useCallback(() => {
    if (!followUpReviewSession || !parentSessionId) return;
    openBtwSessionInAuxPane({
      childSessionId: followUpReviewSession.sessionId,
      parentSessionId,
      workspacePath: followUpReviewSession.workspacePath ?? childSession?.workspacePath,
      expand: true,
      sessionKind: followUpReviewSession.sessionKind === 'deep_review' ? 'deep_review' : 'review',
      sessionTitle: followUpReviewSession.title,
      agentType: followUpReviewSession.config?.agentType,
      remoteConnectionId: followUpReviewSession.remoteConnectionId,
      remoteSshHost: followUpReviewSession.remoteSshHost,
    });
  }, [childSession?.workspacePath, followUpReviewSession, parentSessionId]);

  const handleConfirmDecisionGate = useCallback(async () => {
    if (!pendingDecisionAction || decisionGateMissingSelection) {
      return;
    }

    const action = pendingDecisionAction;
    setPendingDecisionAction(null);
    await handleStartFixing(action.selectedIds, { skipDecisionGate: true });
  }, [decisionGateMissingSelection, handleStartFixing, pendingDecisionAction]);

  const handleCancelDecisionGate = useCallback(() => {
    setPendingDecisionAction(null);
  }, []);

  const handleRetryIncompleteSlices = useCallback(async () => {
    if (!childSessionId || retryableSlices.length === 0) return;

    store.setActiveAction('retry', undefined, childSessionId);
    try {
      await flowChatManager.sendMessage(
        buildDeepReviewRetryPrompt(retryableSlices),
        childSessionId,
        t('deepReviewActionBar.retryIncompleteRequestDisplay', {
          count: retryableSlices.length,
        }),
        'DeepReview',
        'Standard',
      );
      store.minimize(childSessionId);
    } catch (error) {
      log.error('Failed to start DeepReview retry coverage', { childSessionId, error });
      const message = getReviewActionErrorMessage(error, t, t('deepReviewActionBar.retryIncompleteFailed'));
      notificationService.error(message, { duration: 5000 });
    } finally {
      store.setActiveAction(null, undefined, childSessionId);
    }
  }, [childSessionId, retryableSlices, store, t]);

  const handleFillBackInput = useCallback(async () => {
    if (!reviewData) return;

    let prompt = buildSelectedReviewRemediationPrompt({
      reviewData,
      selectedIds: selectedRemediationIds,
      reviewMode,
      decisionSelections,
    });

    if (customInstructions.trim()) {
      prompt = `${prompt}\n\n## User Instructions\n${customInstructions.trim()}`;
    }

    if (!prompt) return;

    // Check if chat input already has content — require confirmation before replacing
    const currentInputRequest: { getValue?: () => string } = {};
    globalEventBus.emit('chat-input:get-state', currentInputRequest);
    const currentInput = currentInputRequest.getValue?.() ?? '';

    if (currentInput.trim()) {
      const confirmed = await confirmWarning(
        t('deepReviewActionBar.replaceInputConfirmTitle'),
        t('deepReviewActionBar.replaceInputConfirmMessage'),
        {
          confirmText: t('deepReviewActionBar.replaceInputConfirmAction'),
        },
      );
      if (!confirmed) return;
    }

    globalEventBus.emit('fill-chat-input', {
      content: prompt,
      mode: 'replace',
    });

    store.minimize(childSessionId ?? undefined);
  }, [reviewData, childSessionId, selectedRemediationIds, customInstructions, reviewMode, decisionSelections, store, t]);

  const handleMinimize = useCallback(() => {
    store.minimize(childSessionId ?? undefined);
  }, [childSessionId, store]);

  const handleContinueReview = useCallback(async () => {
    if (!interruption) return;

    if (!interruption.canResume) {
      const confirmed = await confirmWarning(
        t('deepReviewActionBar.resumeBlockedConfirmTitle'),
        t('deepReviewActionBar.resumeBlockedConfirmMessage'),
        {
          confirmText: t('deepReviewActionBar.resumeBlockedConfirmAction'),
        },
      );
      if (!confirmed) return;
    }

    const resumeBaselineTurnId = childSession?.dialogTurns.at(-1)?.id ?? null;
    store.setActiveAction('resume', { baselineTurnId: resumeBaselineTurnId }, childSessionId ?? undefined);
    store.updatePhase('resume_running', undefined, childSessionId ?? undefined);
    store.minimize(childSessionId ?? undefined);
    try {
      await continueDeepReviewSession(interruption, t('deepReviewActionBar.resumeRequestDisplay'), { force: !interruption.canResume });
    } catch (error) {
      log.error('Failed to continue interrupted strict review', { childSessionId, error });
      const message = t('deepReviewActionBar.resumeFailedMessage');
      store.updatePhase('resume_failed', message, childSessionId ?? undefined);
      store.restore(childSessionId ?? undefined);
      notificationService.error(message, { duration: 5000 });
    } finally {
      store.setActiveAction(null, undefined, childSessionId ?? undefined);
    }
  }, [childSession, childSessionId, interruption, store, t]);

  const handleContinueFix = useCallback(async () => {
    if (!reviewData || !childSessionId || remainingFixIds.length === 0) return;

    const remainingSet = new Set(remainingFixIds);
    store.setSelectedRemediationIds(remainingSet, childSessionId);

    await handleStartFixing(remainingSet);
  }, [reviewData, childSessionId, remainingFixIds, store, handleStartFixing]);

  const handleOpenModelSettings = useCallback(async () => {
    if (!interruption) return;
    openSettingsPage('ai.models');
  }, [interruption]);

  const handleViewPartialResults = useCallback(() => {
    setShowPartialResults(true);
  }, []);

  const handleDegradationAction = useCallback((type: string) => {
    if (type === 'view_partial') {
      setShowPartialResults(true);
    }
  }, []);

  const displayErrorMessage = useMemo(() => {
    if (!errorMessage) return null;

    return getReviewActionErrorMessage(errorMessage, t, t('deepReviewActionBar.actionStartFailed'));
  }, [errorMessage, t]);

  const handleCopyDiagnostics = useCallback(async () => {
    const detail = interruption?.errorDetail;
    if (!detail) return;

    const diagnostics = buildInterruptionDiagnostics(detail, getAiErrorPresentation(detail), t);

    try {
      await navigator.clipboard.writeText(diagnostics);
      notificationService.success(t('deepReviewActionBar.diagnosticsCopied'), { duration: 2500 });
    } catch {
      notificationService.error(t('deepReviewActionBar.diagnosticsCopyFailed'), { duration: 2500 });
    }
  }, [interruption, t]);

  const phaseTitle = useMemo(() => {
    if (hasInterruption && interruption?.errorDetail && errorAttribution) {
      const categoryLabel = t(errorAttribution.title, { defaultValue: errorAttribution.category });
      if (phase === 'review_interrupted') {
        return t('deepReviewActionBar.reviewInterruptedWithReason', {
          reason: categoryLabel,
        });
      }
      if (phase === 'resume_blocked') {
        return t('deepReviewActionBar.resumeBlockedWithReason', {
          reason: categoryLabel,
        });
      }
      if (phase === 'resume_failed') {
        return t('deepReviewActionBar.resumeFailedWithReason', {
          reason: categoryLabel,
        });
      }
      if (phase === 'review_error') {
        return t('deepReviewActionBar.reviewErrorWithReason', {
          reason: categoryLabel,
        });
      }
    }

    switch (phase) {
      case 'review_running':
        return t(isDeepReview ? 'deepReviewActionBar.reviewRunningDeep' : 'deepReviewActionBar.reviewRunningStandard', {
          defaultValue: isDeepReview ? 'Strict review in progress...' : 'Review in progress...',
        });
      case 'review_completed':
        return t(isDeepReview ? 'reviewActionBar.reviewCompletedDeep' : 'reviewActionBar.reviewCompletedStandard', {
          defaultValue: isDeepReview ? 'Strict review completed' : 'Review completed',
        });
      case 'fix_running':
        if (lastSubmittedAction === 'fix-review') {
          return t('deepReviewActionBar.fixAndReviewRunning');
        }
        return t('deepReviewActionBar.fixRunning');
      case 'fix_completed':
        return t('deepReviewActionBar.fixCompleted');
      case 'fix_failed':
        return t('deepReviewActionBar.fixFailed');
      case 'fix_timeout':
        return t('deepReviewActionBar.fixTimeout');
      case 'review_waiting_capacity':
        return t('deepReviewActionBar.reviewWaitingCapacity');
      case 'review_interrupted':
        return t('deepReviewActionBar.reviewInterrupted');
      case 'resume_blocked':
        return t('deepReviewActionBar.resumeBlocked');
      case 'resume_running':
        return t('deepReviewActionBar.resumeRunning');
      case 'resume_failed':
        return t('deepReviewActionBar.resumeFailed');
      case 'review_error':
        return t('deepReviewActionBar.reviewError');
      default:
        return '';
    }
  }, [phase, isDeepReview, t, hasInterruption, interruption, errorAttribution, lastSubmittedAction]);

  if (phase === 'idle' || !childSessionId) {
    return null;
  }

  return (
    <div
      data-openbitfun-product-component="deep-review-action-bar"
      data-openbitfun-product-part="root"
      data-openbitfun-phase={phase}
      data-openbitfun-variant={phaseConfig.variant}
      className={`deep-review-action-bar deep-review-action-bar--${phaseConfig.variant}`}
      onWheel={stopNestedScrollPropagation}
      onTouchMove={stopNestedScrollPropagation}
    >
      <ReviewActionHeader
        reviewData={reviewData}
        PhaseIcon={PhaseIcon}
        phaseIconClass={phaseConfig.iconClass}
        phaseTitle={phaseTitle}
        errorMessage={displayErrorMessage}
        minimizeLabel={t('deepReviewActionBar.minimize')}
        onMinimize={handleMinimize}
      />

      {phase === 'review_running' && managedReviewPlan && (
        <div
          className="deep-review-action-bar__progress"
          role="status"
          aria-live="polite"
          data-openbitfun-product-component="deep-review-action-bar"
          data-openbitfun-product-part="progress"
        >
          <span className="deep-review-action-bar__progress-text">
            {t('deepReviewActionBar.managedCoverageProgress', {
              planned: managedReviewPlan.plannedFileCount,
              total: managedReviewPlan.totalFileCount,
              parallel: managedReviewPlan.maxParallelInstances,
            })}
          </span>
          {managedReviewPlan.deferredFileCount > 0 && (
            <span className="deep-review-action-bar__elapsed">
              {t('deepReviewActionBar.managedCoverageDeferred', {
                count: managedReviewPlan.deferredFileCount,
              })}
            </span>
          )}
        </div>
      )}

      {/* Running progress */}
      {(['review_running', 'fix_running', 'resume_running'].includes(phase)) && progressSummary && (
        <div className="deep-review-action-bar__progress" data-openbitfun-product-component="deep-review-action-bar" data-openbitfun-product-part="progress">
          <span className="deep-review-action-bar__progress-text">
            {progressText}
          </span>
          {elapsedMs > 0 && (
            <span className="deep-review-action-bar__elapsed">
              {t('deepReviewActionBar.elapsedTime', {
                time: formatElapsedTime(elapsedMs),
              })}
            </span>
          )}
        </div>
      )}

      {/* Capacity queue notice */}
      {showCapacityQueueNotice && capacityQueueState && (
        <CapacityQueueNotice
          capacityQueueState={capacityQueueState}
          supportsInlineQueueControls={supportsInlineQueueControls}
          onContinueQueue={() => handleCapacityQueueAction(
            'continue',
            () => store.continueCapacityQueue(childSessionId ?? undefined),
          )}
          onPauseQueue={() => handleCapacityQueueAction(
            'pause',
            () => store.pauseCapacityQueue(childSessionId ?? undefined),
          )}
          onSkipOptionalQueuedReviewers={() => handleCapacityQueueAction(
            'skip_optional',
            () => store.skipOptionalQueuedReviewers(childSessionId ?? undefined),
          )}
          onCancelQueuedReviewers={() => handleCapacityQueueAction(
            'cancel',
            () => store.cancelQueuedReviewers(childSessionId ?? undefined),
          )}
          onOpenReviewSettings={handleOpenReviewSettings}
        />
      )}

      <PartialResultsPanel
        progressSummary={showInterruptionDetails ? progressSummary : null}
        partialResults={partialResults}
        showPartialResults={showPartialResults}
        onTogglePartialResults={() => setShowPartialResults(!showPartialResults)}
      />

      {/* Error attribution card */}
      {showInterruptionDetails && errorAttribution && (
        <div
          className={`deep-review-action-bar__attribution deep-review-action-bar__attribution--${errorAttribution.severity}`}
          data-openbitfun-product-component="deep-review-action-bar"
          data-openbitfun-product-part="attribution"
          role="status"
          aria-live="polite"
        >
          <span className="deep-review-action-bar__attribution-message">
            {t(errorAttribution.description, { defaultValue: '' })}
          </span>
        </div>
      )}

      {/* Recovery plan preview */}
      {showInterruptionDetails && recoveryPlan && (
        <RecoveryPlanPreview recoveryPlan={recoveryPlan} />
      )}

      {/* Context overflow degradation options */}
      {showInterruptionDetails && interruption?.errorDetail?.category === 'context_overflow' && (
        <div className="deep-review-action-bar__degradation" data-openbitfun-product-component="deep-review-action-bar" data-openbitfun-product-part="degradation">
          <span className="deep-review-action-bar__degradation-title">
            {t('deepReviewActionBar.contextOverflowTitle')}
          </span>
          {degradationOptions.map((option) => (
            <button
              key={option.type}
              type="button"
              className="deep-review-action-bar__degradation-option"
              data-openbitfun-product-component="deep-review-action-bar"
              data-openbitfun-product-part="degradationOption"
              disabled={!option.enabled}
              onClick={() => handleDegradationAction(option.type)}
            >
              <span className="deep-review-action-bar__degradation-label">
                {t(option.labelKey, { defaultValue: option.type })}
              </span>
              <span className="deep-review-action-bar__degradation-desc">
                {t(option.descriptionKey, { defaultValue: '' })}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Remediation selection stays visible while fixes run so progress remains inspectable. */}
      {['review_completed', 'fix_running', 'fix_completed', 'fix_interrupted'].includes(phase) && remediationItems.length > 0 && (
        <RemediationSelectionPanel
          remediationItems={remediationItems}
          selectedRemediationIds={selectedRemediationIds}
          completedRemediationIds={completedRemediationIds}
          fixingRemediationIds={fixingRemediationIds}
          decisionSelections={decisionSelections}
          showRemediationList={showRemediationList}
          expandedDecisionIds={expandedDecisionIds}
          selectionDisabled={phase === 'fix_running' || phase === 'fix_completed'}
          onToggleRemediation={handleToggleRemediation}
          onToggleAll={handleToggleAll}
          onToggleGroup={handleToggleGroup}
          onToggleList={() => setShowRemediationList(!showRemediationList)}
          onToggleDecisionExpansion={handleToggleDecisionExpansion}
          onSetDecisionSelection={(itemId, optionIndex) =>
            store.setDecisionSelection(itemId, optionIndex, childSessionId ?? undefined)
          }
        />
      )}

      {phase === 'review_completed' && pendingDecisionAction && decisionGateItems.length > 0 && (
        <DecisionExecutionGate
          items={decisionGateItems}
          decisionSelections={decisionSelections}
          customInstructions={customInstructions}
          confirmDisabled={decisionGateMissingSelection}
          onSelectDecision={(itemId, optionIndex) =>
            store.setDecisionSelection(itemId, optionIndex, childSessionId ?? undefined)
          }
          onCustomInstructionsChange={(value) =>
            store.setCustomInstructions(value, childSessionId ?? undefined)
          }
          onConfirm={handleConfirmDecisionGate}
          onCancel={handleCancelDecisionGate}
        />
      )}

      {/* Friendly message when review completed with no remediation items */}
      {phase === 'review_completed' && remediationItems.length === 0 && (
        <div className="deep-review-action-bar__no-issues" data-openbitfun-product-component="deep-review-action-bar" data-openbitfun-product-part="noIssues">
          <Icon name="check-circle" size="lg" style={{ width: 18, height: 18 }} className="deep-review-action-bar__no-issues-icon" />
          <span className="deep-review-action-bar__no-issues-text">
            {t('reviewActionBar.noIssuesFound')}
          </span>
        </div>
      )}

      {/* Fix completed — show success message */}
      {phase === 'fix_completed' && (
        <div className="deep-review-action-bar__fix-done" data-openbitfun-product-component="deep-review-action-bar" data-openbitfun-product-part="fixDone">
          <Icon name="check-circle" size="md" className="deep-review-action-bar__fix-done-icon" />
          <span className="deep-review-action-bar__fix-done-text">
            {t('deepReviewActionBar.fixCompletedMessage')}
          </span>
        </div>
      )}

      {/* Custom instructions input */}
      {phase === 'review_completed' && remediationItems.length > 0 && !pendingDecisionAction && (
        <div
          className="deep-review-action-bar__custom"
          data-openbitfun-product-component="deep-review-action-bar"
          data-openbitfun-product-part="custom"
          data-openbitfun-state={showCustomInput ? 'expanded' : undefined}
        >
          <button
            type="button"
            className="deep-review-action-bar__custom-toggle"
            onClick={() => setShowCustomInput(!showCustomInput)}
          >
            <MessageSquare size={14} />
            <span>
              {showCustomInput
                ? t('deepReviewActionBar.hideCustomInput')
                : t('deepReviewActionBar.showCustomInput')}
            </span>
          </button>
          {showCustomInput && (
            <Textarea
              className="deep-review-action-bar__custom-textarea"
              data-openbitfun-product-component="deep-review-action-bar"
              data-openbitfun-product-part="customInput"
              placeholder={t('deepReviewActionBar.customInstructionsPlaceholder')}
              value={customInstructions}
              onChange={(e) => store.setCustomInstructions(e.target.value, childSessionId ?? undefined)}
              rows={2}
            />
          )}
        </div>
      )}

      <ReviewActionControls
        phase={phase}
        isDeepReview={isDeepReview}
        retryableSliceCount={retryableSlices.length}
        remediationItemCount={remediationItems.length}
        hasInterruption={showInterruptionDetails}
        partialResultsAvailable={Boolean(partialResults?.hasPartialResults)}
        activeAction={activeAction}
        followUpReviewState={followUpReviewState}
        canLaunchFollowUpReview={isTauriRuntime()}
        isFixDisabled={isFixDisabled}
        isResumeRunning={isResumeRunning}
        remainingFixIds={remainingFixIds}
        modelRecoveryAction={modelRecoveryAction}
        reviewData={reviewData}
        onRetryIncompleteSlices={handleRetryIncompleteSlices}
        onStartFixing={handleStartFixing}
        onReviewFixes={handleReviewFixes}
        onOpenFollowUpReview={handleOpenFollowUpReview}
        onFillBackInput={handleFillBackInput}
        onContinueReview={handleContinueReview}
        onOpenModelSettings={handleOpenModelSettings}
        onCopyDiagnostics={handleCopyDiagnostics}
        onViewPartialResults={handleViewPartialResults}
        onContinueFix={handleContinueFix}
        onSkipRemainingFixes={() => store.skipRemainingFixes(childSessionId ?? undefined)}
        onMinimize={handleMinimize}
      />
      {deepReviewConsentDialog}
    </div>
  );
};

export const DeepReviewActionBar = ReviewActionBar;
