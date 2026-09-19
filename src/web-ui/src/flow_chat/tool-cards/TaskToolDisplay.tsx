/**
 * TaskTool card display component.
 */

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { AlertTriangle, Split } from 'lucide-react';

import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import type { FlowToolItem, ToolCardProps } from '../types/flow-chat';
import {
  AgentControlToolCard as AgentControlToolCardView,
  AmbientToolCard,
  AmbientToolCardHeader,
  ToolCardStatusSlot,
} from '@openbitfun/ui/flow-chat';
import { taskCollapseStateManager } from '../store/TaskCollapseStateManager';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { ToolTimeoutIndicator } from './ToolTimeoutIndicator';
import { getReviewerContextBySubagentId } from '@/shared/services/reviewTeamService';
import type { ReviewerContext } from '@/shared/services/reviewTeamService';
import { loadBtwSessionHistory, openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { flowChatStore } from '../store/FlowChatStore';
import { useSessionGoalModeActive } from '../hooks/useSessionGoalModeActive';
import { deriveSubagentExecutionStatus } from '../utils/subagentProjection';
import { sessionLineageLifecycleForSession } from '../utils/sessionLineage';
import {
  SubagentAvatar,
} from '../subagent-identity';
import { deriveReviewTaskOutcome } from '../utils/reviewTaskOutcome';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { notificationService } from '@/shared/notification-system/services/NotificationService';
import './TaskToolDisplay.scss';
import './ModelThinkingDisplay.scss';

function readTaskDurationMs(toolResult: FlowToolItem['toolResult'] | undefined): number | undefined {
  const resultDuration = toolResult?.result?.duration;
  if (typeof resultDuration === 'number') {
    return resultDuration;
  }
  if (typeof toolResult?.duration_ms === 'number') {
    return toolResult.duration_ms;
  }
  return undefined;
}

function readTaskErrorMessage(toolResult: FlowToolItem['toolResult'] | undefined): string | null {
  if (typeof toolResult?.error === 'string' && toolResult.error.trim()) {
    return toolResult.error.trim();
  }
  const result = toolResult?.result;
  if (result && typeof result === 'object' && 'error' in result) {
    const message = String((result as { error?: unknown }).error ?? '').trim();
    return message || null;
  }
  return null;
}

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTaskAction(input: unknown, toolResult: FlowToolItem['toolResult'] | undefined): string {
  if (input && typeof input === 'object') {
    const action = readStringValue((input as Record<string, unknown>).action);
    if (action) {
      return action.toLowerCase();
    }
  }

  const result = toolResult?.result;
  if (result && typeof result === 'object') {
    const action = readStringValue((result as Record<string, unknown>).action);
    if (action) {
      return action.toLowerCase();
    }
  }

  return '';
}

function readTaskSessionId(input: unknown, toolResult: FlowToolItem['toolResult'] | undefined): string {
  if (input && typeof input === 'object') {
    const sessionId = readStringValue((input as Record<string, unknown>).session_id)
      || readStringValue((input as Record<string, unknown>).sessionId);
    if (sessionId) {
      return sessionId;
    }
  }

  const result = toolResult?.result;
  if (result && typeof result === 'object') {
    return readStringValue((result as Record<string, unknown>).session_id)
      || readStringValue((result as Record<string, unknown>).sessionId);
  }

  return '';
}

function readTaskSubagentType(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const data = input as Record<string, unknown>;
  return (
    readStringValue(data.subagent_type) ||
    readStringValue(data.subagentType) ||
    readStringValue(data.agent_type) ||
    readStringValue(data.agentType)
  );
}

function hasFocusedReviewAssignment(input: unknown): boolean {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const assignment = (input as Record<string, unknown>).focused_assignment;
  return !!assignment && typeof assignment === 'object';
}

function readTaskRunInBackground(input: unknown, toolResult: FlowToolItem['toolResult'] | undefined): boolean {
  if (input && typeof input === 'object') {
    const value = (input as Record<string, unknown>).run_in_background;
    if (typeof value === 'boolean') {
      return value;
    }
  }

  const result = toolResult?.result;
  if (result && typeof result === 'object') {
    const value = (result as Record<string, unknown>).run_in_background;
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return false;
}

function readTaskWasCancelled(
  status: FlowToolItem['status'],
  toolResult: FlowToolItem['toolResult'] | undefined,
): boolean {
  if (status === 'cancelled' || status === 'rejected') {
    return true;
  }

  const result = toolResult?.result;
  if (result && typeof result === 'object') {
    const resultStatus = readStringValue((result as Record<string, unknown>).status).toLowerCase();
    if (resultStatus === 'cancelled' || resultStatus === 'canceled') {
      return true;
    }
  }

  const error = readStringValue(toolResult?.error).toLowerCase();
  return Boolean(error && /\bcancell?ed\b/.test(error));
}

function subscribeToFlowChatStore(listener: () => void): () => void {
  return flowChatStore.subscribe(() => listener());
}

function readLinkedSubagentSnapshot(sessionId: string): string {
  if (!sessionId) {
    return '';
  }
  const session = flowChatStore.getState().sessions.get(sessionId);
  const turn = session?.dialogTurns?.[session.dialogTurns.length - 1];
  return JSON.stringify([
    session?.mode ?? '',
    session?.config?.agentType ?? '',
    session?.config?.modelName ?? '',
    session?.focusedReviewDisplayLabel ?? '',
    session?.deepReviewRunManifest?.focusedAssignment?.displayLabel ?? '',
    turn?.id ?? '',
    turn?.status ?? '',
    turn?.startTime ?? null,
    turn?.endTime ?? null,
    turn?.error ?? '',
    turn?.modelRounds?.some((round) => round.isStreaming) ?? false,
  ]);
}

function readFocusedReviewDisplayLabel(sessionId: string): string {
  if (!sessionId) {
    return '';
  }
  const session = flowChatStore.getState().sessions.get(sessionId);
  return readStringValue(
    session?.focusedReviewDisplayLabel
      ?? session?.deepReviewRunManifest?.focusedAssignment?.displayLabel,
  );
}

const LEGACY_DEEP_REVIEWER_TYPES = new Set([
  'ReviewBusinessLogic',
  'ReviewPerformance',
  'ReviewSecurity',
  'ReviewArchitecture',
  'ReviewFrontend',
  'ReviewGeneral',
  'ReviewJudge',
]);

function isDeepReviewReviewerTask(toolItem: FlowToolItem, parentSessionId?: string): boolean {
  const toolName = toolItem.toolName?.toLowerCase() ?? '';
  if (toolName === 'launchreviewagent') {
    return true;
  }
  if (toolName !== 'task') {
    return false;
  }

  const input = toolItem.toolCall?.input;
  if (!input || typeof input !== 'object') {
    return false;
  }

  const taskInput = input as Record<string, unknown>;
  const packetId = readStringValue(taskInput.packet_id) || readStringValue(taskInput.packetId);
  if (/^(reviewer|judge|managed-review):/i.test(packetId)) {
    return true;
  }

  const description = readStringValue(taskInput.description);
  if (/\bpacket\s+(reviewer|judge|managed-review):/i.test(description)) {
    return true;
  }

  const subagentType = readStringValue(taskInput.subagent_type);
  if (LEGACY_DEEP_REVIEWER_TYPES.has(subagentType)) {
    const parentSession = parentSessionId
      ? flowChatStore.getState().sessions.get(parentSessionId)
      : undefined;
    const parentAgentType = parentSession?.config?.agentType ?? parentSession?.mode ?? '';
    return parentAgentType === 'DeepReview';
  }

  return false;
}

export const TaskToolDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  interruptionNote,
  onOpenInPanel,
  sessionId,
  isLastItem,
}) => {
  const { t } = useTranslation('flow-chat');
  const defaultTimeoutDisabled = useSessionGoalModeActive(sessionId);
  const { t: tAgents } = useTranslation('scenes/agents');
  const { toolCall, toolResult, status, requiresConfirmation, userConfirmed } = toolItem;
  const toolId = toolItem.id ?? toolCall?.id;
  const rawTaskAction = readTaskAction(toolCall?.input, toolResult);
  const isCancelAction = rawTaskAction === 'cancel';
  const isBackgroundTask = readTaskRunInBackground(toolCall?.input, toolResult);
  const isReviewCoverageTask = isDeepReviewReviewerTask(toolItem, sessionId);
  const [isStoppingSubagent, setIsStoppingSubagent] = useState(false);
  
  // Restore collapse state; default to collapsed.
  const [isExpanded, setIsExpanded] = useState(() => {
    const savedState = taskCollapseStateManager.getCollapsedOrUndefined(toolItem.id);
    if (savedState !== undefined) {
      return !savedState;
    }
    return false;
  });
  
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running';
  const keepCollapsedWhileRunning = isCancelAction || isReviewCoverageTask;
  
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });
  
  const prevStatusRef = useRef(status);
  const userToggledRef = useRef(false);

  const updateCardExpandedState = useCallback((
    nextExpanded: boolean,
    reason: 'manual' | 'auto' = 'manual',
  ) => {
    if (reason === 'manual') {
      userToggledRef.current = true;
    }
    if (nextExpanded !== isExpanded) {
      /* Sync before the next commit paints so subagent wrapper + task card merge in one frame. */
      taskCollapseStateManager.setCollapsed(toolItem.id, !nextExpanded);
    }
    applyExpandedState(isExpanded, nextExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, toolItem.id]);

  useLayoutEffect(() => {
    const prevStatus = prevStatusRef.current;

    if (isCancelAction) {
      if (isExpanded) {
        updateCardExpandedState(false, 'auto');
      }
      prevStatusRef.current = status;
      return;
    }

    if (userToggledRef.current) {
      prevStatusRef.current = status;
      return;
    }
    
    if (prevStatus !== status) {
      prevStatusRef.current = status;
      
      if (status === 'completed') {
        if (isLastItem !== true) {
          updateCardExpandedState(false, 'auto');
        }
      } else if (isRunning && !keepCollapsedWhileRunning) {
        updateCardExpandedState(true, 'auto');
      }
    } else if (status === 'completed' && isLastItem === false && isExpanded) {
      updateCardExpandedState(false, 'auto');
    }
  }, [
    isCancelAction,
    isExpanded,
    isLastItem,
    isRunning,
    keepCollapsedWhileRunning,
    status,
    updateCardExpandedState,
  ]);
  
  useLayoutEffect(() => {
    taskCollapseStateManager.setCollapsed(toolItem.id, isCancelAction ? true : !isExpanded);
  }, [isCancelAction, isExpanded, toolItem.id]);

  const taskSessionId = readTaskSessionId(toolCall?.input, toolResult);
  const linkedSubagentSessionId = toolItem.subagentSessionId || taskSessionId;
  const readSubagentSnapshot = useCallback(
    () => readLinkedSubagentSnapshot(linkedSubagentSessionId),
    [linkedSubagentSessionId],
  );
  useSyncExternalStore(
    subscribeToFlowChatStore,
    readSubagentSnapshot,
    readSubagentSnapshot,
  );
  const linkedSubagentSession = linkedSubagentSessionId
    ? flowChatStore.getState().sessions.get(linkedSubagentSessionId)
    : undefined;
  const subagentAvatarStatus = linkedSubagentSession
    ? sessionLineageLifecycleForSession(linkedSubagentSession)
    : 'idle';
  const loadLinkedReviewHistory = useCallback(async () => {
    if (!linkedSubagentSessionId) {
      return;
    }
    await loadBtwSessionHistory({ childSessionId: linkedSubagentSessionId, parentSessionId: sessionId });
  }, [linkedSubagentSessionId, sessionId]);

  const getTaskInput = () => {
    if (!toolCall?.input) return null;

    const isEarlyDetection = toolCall.input._early_detection === true;
    const isPartialParams = toolCall.input._partial_params === true;

    if (isEarlyDetection || isPartialParams) {
      return null;
    }

    const inputKeys = Object.keys(toolCall.input).filter(key => !key.startsWith('_'));
    if (inputKeys.length === 0) return null;

    const { description, prompt } = toolCall.input;
    const inputSubagentType = readTaskSubagentType(toolCall.input);
    const agentType =
      readStringValue(linkedSubagentSession?.mode) ||
      readStringValue(linkedSubagentSession?.config?.agentType) ||
      inputSubagentType ||
      'Not provided';
    const modelName =
      readStringValue(toolItem.subagentModelDisplayName) ||
      readStringValue(toolItem.subagentModelId) ||
      readStringValue(linkedSubagentSession?.config?.modelName) ||
      readStringValue(toolCall.input.model_id) ||
      readStringValue(toolCall.input.modelId);

    if (isReviewCoverageTask) {
      const packetId = readStringValue(toolCall.input.packet_id)
        || readStringValue(toolCall.input.packetId);
      const isFocusedReview = hasFocusedReviewAssignment(toolCall.input)
        || (toolItem.toolName?.toLowerCase() === 'launchreviewagent' && !packetId);
      const focusedDisplayLabel = isFocusedReview
        ? readFocusedReviewDisplayLabel(linkedSubagentSessionId)
        : '';
      return {
        description: isFocusedReview
          ? focusedDisplayLabel || t('toolCards.taskTool.reviewFocusedDescription')
          : t('toolCards.taskTool.reviewCoverageDescription'),
        prompt: 'Not provided',
        agentType: t('toolCards.taskTool.reviewCoverageLabel'),
        modelName,
        reviewerContext: null,
        isReviewCoverageTask: true,
      };
    }

    // For built-in review-team reviewers outside the unified Review flow,
    // surface role context instead of the raw prompt so internal directives stay private.
    const reviewerContext: ReviewerContext | null =
      agentType !== 'Not provided'
        ? getReviewerContextBySubagentId(agentType)
        : null;

    return {
      description: description || prompt || 'Not provided',
      prompt: prompt || 'Not provided',
      agentType,
      modelName,
      reviewerContext,
      isReviewCoverageTask: false,
    };
  };

  const taskInput = getTaskInput();
  const displayIsExpanded = isCancelAction ? false : isExpanded;
  const hasRealPrompt = Boolean(
    taskInput && taskInput.prompt && taskInput.prompt !== 'Not provided',
  );
  const hasInterruptionNote = Boolean(interruptionNote);
  const needsConfirmation =
    requiresConfirmation && !userConfirmed && status !== 'completed' && status !== 'cancelled' && status !== 'rejected' && status !== 'error';

  /* Prompt body: same scroll + Markdown shell as ModelThinkingDisplay. */
  const promptContentRef = useRef<HTMLDivElement>(null);
  const [promptScrollState, setPromptScrollState] = useState({
    hasScroll: false,
    atTop: true,
    atBottom: true,
  });

  const checkPromptScrollState = useCallback(() => {
    const el = promptContentRef.current;
    if (!el) return;
    setPromptScrollState({
      hasScroll: el.scrollHeight > el.clientHeight,
      atTop: el.scrollTop <= 5,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 5,
    });
  }, []);

  useEffect(() => {
    if (!displayIsExpanded || !hasRealPrompt) return;
    const timer = setTimeout(checkPromptScrollState, 50);
    return () => clearTimeout(timer);
  }, [displayIsExpanded, hasRealPrompt, taskInput?.prompt, checkPromptScrollState]);

  const linkedSubagentTurn = linkedSubagentSession?.dialogTurns?.[
    linkedSubagentSession.dialogTurns.length - 1
  ];
  const projectedSubagentStatus = isBackgroundTask || isReviewCoverageTask
    ? deriveSubagentExecutionStatus(linkedSubagentTurn)
    : null;
  const projectedSubagentIsRunning = projectedSubagentStatus === 'running';
  const reviewTaskOutcome = isReviewCoverageTask && !projectedSubagentIsRunning
    ? deriveReviewTaskOutcome(toolItem)
    : null;
  const isReviewPartialTimeout = reviewTaskOutcome === 'partial-timeout';
  const rawTaskErrorMessage = readTaskErrorMessage(toolResult);
  const isReviewTimeout = reviewTaskOutcome === 'timed-out';
  const isCancelledResult = !projectedSubagentIsRunning && (
    readTaskWasCancelled(status, toolResult) || reviewTaskOutcome === 'stopped'
  );
  const displayStatus = projectedSubagentIsRunning
    ? 'running'
    : isCancelledResult
    ? 'cancelled'
    : projectedSubagentStatus ?? status;
  const effectiveIsRunning = projectedSubagentStatus == null
    ? isRunning
    : projectedSubagentIsRunning;
  const isFailed = !projectedSubagentIsRunning && (
    displayStatus === 'error' || (
      !isCancelledResult &&
      (status === 'error' ||
      (toolResult != null &&
        'success' in toolResult &&
        toolResult.success === false))
    )
  );
  const hasFailedOutcome = isFailed || isReviewTimeout;
  const projectedSubagentDurationMs = (isBackgroundTask || isReviewCoverageTask) &&
    linkedSubagentTurn?.endTime != null &&
    linkedSubagentTurn.startTime != null
    ? Math.max(0, linkedSubagentTurn.endTime - linkedSubagentTurn.startTime)
    : undefined;
  const taskDurationMs = projectedSubagentIsRunning
    ? undefined
    : isBackgroundTask || isReviewCoverageTask
    ? projectedSubagentDurationMs ?? readTaskDurationMs(toolResult)
    : readTaskDurationMs(toolResult);
  const taskErrorMessage = displayStatus === 'error'
    ? linkedSubagentTurn?.error || rawTaskErrorMessage
    : rawTaskErrorMessage;
  const visibleTaskErrorMessage = isReviewTimeout
    ? t('toolCards.taskTool.reviewTimedOut')
    : isReviewCoverageTask && taskErrorMessage
      ? t('toolCards.taskTool.reviewCheckUnavailable')
    : taskErrorMessage;
  const reviewOutcome = isReviewPartialTimeout
    ? { key: 'toolCards.taskTool.reviewPartialTimeout', kind: 'partial-timeout' }
    : isReviewTimeout
      ? { key: 'toolCards.taskTool.reviewTimedOut', kind: 'timed-out' }
      : isReviewCoverageTask && isCancelledResult
        ? { key: 'toolCards.taskTool.reviewStopped', kind: 'stopped' }
        : null;
  const completedDurationStatus = isCancelledResult || displayStatus === 'cancelled'
    ? 'cancelled'
    : hasFailedOutcome
      ? 'error'
      : status === 'cancelled' || status === 'rejected'
      ? 'cancelled'
      : displayStatus === 'completed' && taskDurationMs != null
        ? 'success'
        : undefined;

  const isTaskTool = toolItem.toolName?.toLowerCase() === 'task';
  const resolvedSubagentModel = (
    taskInput?.modelName?.trim()
    || ''
  );
  const showSubagentExecModel =
    isTaskTool &&
    !isReviewCoverageTask &&
    (
      Boolean(linkedSubagentSessionId)
      || Boolean(resolvedSubagentModel)
      || isRunning
    );
  const stableSubagentType = readTaskSubagentType(toolCall?.input)
    || readStringValue(linkedSubagentSession?.subagentType);
  const stableAgentType = readStringValue(linkedSubagentSession?.mode)
    || readStringValue(linkedSubagentSession?.config?.agentType)
    || stableSubagentType;
  const canStopSyncSubagent =
    (isTaskTool || isReviewCoverageTask) &&
    effectiveIsRunning &&
    !isCancelAction &&
    !isBackgroundTask &&
    Boolean(linkedSubagentSessionId);

  useEffect(() => {
    if (!effectiveIsRunning || !linkedSubagentSessionId) {
      setIsStoppingSubagent(false);
    }
  }, [effectiveIsRunning, linkedSubagentSessionId]);

  const handleStopSyncSubagent = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!linkedSubagentSessionId || isStoppingSubagent) {
      return;
    }

    setIsStoppingSubagent(true);
    const reportStopFailure = async () => {
      if (isReviewCoverageTask) {
        await loadLinkedReviewHistory().catch(() => undefined);
        const latestSession = flowChatStore.getState().sessions.get(linkedSubagentSessionId);
        const latestTurn = latestSession?.dialogTurns[latestSession.dialogTurns.length - 1];
        if (deriveSubagentExecutionStatus(latestTurn) !== 'running') {
          setIsStoppingSubagent(false);
          return;
        }
      }
      setIsStoppingSubagent(false);
      notificationService.error(t(isReviewCoverageTask
        ? 'toolCards.taskDetailPanel.stopReviewWorkFailed'
        : 'toolCards.taskDetailPanel.stopSubagentFailed'), {
        duration: 5000,
      });
    };
    try {
      const result = await agentAPI.cancelSession(linkedSubagentSessionId);
      if (isReviewCoverageTask && !result.cancelled) {
        await reportStopFailure();
      } else if (isReviewCoverageTask) {
        await loadLinkedReviewHistory().catch(() => undefined);
        setIsStoppingSubagent(false);
      } else if (!result.cancelled) {
        setIsStoppingSubagent(false);
        notificationService.error(t('toolCards.taskDetailPanel.stopSubagentFailed'), {
          duration: 5000,
        });
      }
    } catch (_error) {
      await reportStopFailure();
    }
  }, [isReviewCoverageTask, isStoppingSubagent, linkedSubagentSessionId, loadLinkedReviewHistory, t]);

  const handleCardClick = useCallback(() => {
    // Pause auto-scroll while the user toggles the card.
    updateCardExpandedState(!isExpanded);
  }, [isExpanded, updateCardExpandedState]);

  const showSummaryExpandHint = !isCancelAction && (
    hasFailedOutcome ||
    hasInterruptionNote ||
    hasRealPrompt ||
    needsConfirmation ||
    (Boolean(taskInput?.reviewerContext) && !taskInput?.isReviewCoverageTask)
  );

  const { taskSummaryLine, taskAgentTypeLabel, taskDesc } = useMemo(() => {
    const desc =
      (taskInput?.description || '').trim() || t('toolCards.taskDetailPanel.untitled');
    const raw = taskInput?.agentType;
    let agentTypeLabel: string;
    if (raw && raw !== 'Not provided') {
      const rc = taskInput?.isReviewCoverageTask ? null : taskInput?.reviewerContext;
      agentTypeLabel = taskInput?.isReviewCoverageTask
        ? t('toolCards.taskTool.reviewCoverageLabel')
        : rc
        ? tAgents(`reviewTeams.members.${rc.definitionKey}.funName`, {
            defaultValue: rc.roleName,
          })
        : raw;
    } else {
      agentTypeLabel = t('toolCards.taskTool.defaultAgentKind');
    }
    return {
      taskSummaryLine: taskInput?.isReviewCoverageTask
        ? desc
        : t('toolCards.taskTool.headerLine', {
          agentType: agentTypeLabel,
          description: desc,
        }),
      taskAgentTypeLabel: agentTypeLabel,
      taskDesc: desc,
    };
  }, [taskInput, t, tAgents]);

  const openTaskDetailPanel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isCancelAction) {
        return;
      }

      if (linkedSubagentSessionId && sessionId) {
        const parentSession = flowChatStore.getState().sessions.get(sessionId);
        openBtwSessionInAuxPane({
          childSessionId: linkedSubagentSessionId,
          parentSessionId: sessionId,
          workspacePath: parentSession?.workspacePath,
          sessionKind: 'subagent',
          sessionTitle: taskSummaryLine,
          agentType: stableAgentType || undefined,
          parentToolCallId: toolCall?.id || toolItem.id,
          subagentType: stableSubagentType || undefined,
          remoteConnectionId: parentSession?.remoteConnectionId,
          remoteSshHost: parentSession?.remoteSshHost,
          includeInternal: true,
          ...(isReviewCoverageTask ? { viewKind: 'review-check' as const } : {}),
        });
        return;
      }

      const panelData = { toolItem, taskInput, sessionId };
      const tabInfo = {
        type: 'task-detail',
        title: taskSummaryLine,
        data: panelData,
        metadata: { taskId: toolItem.id },
      };
      if (onOpenInPanel) {
        onOpenInPanel(tabInfo.type, tabInfo);
      } else {
        window.dispatchEvent(new CustomEvent('agent-create-tab', { detail: tabInfo }));
      }
    },
    [isCancelAction, isReviewCoverageTask, linkedSubagentSessionId, onOpenInPanel, sessionId, stableAgentType, stableSubagentType, taskInput, toolCall?.id, toolItem, taskSummaryLine],
  );

  const renderExpandedContent = () => {
    /* Failure stays in the summary status; do not repeat prompt/confirm in the expanded body. */
    if (hasFailedOutcome) {
      return null;
    }

    const rc = taskInput?.isReviewCoverageTask ? null : taskInput?.reviewerContext;

    if (
      !hasInterruptionNote &&
      !hasRealPrompt &&
      !needsConfirmation &&
      !rc
    ) {
      return null;
    }

    return (
      <div className="task-expanded-content" data-openbitfun-component="task-tool-display" data-openbitfun-part="expanded" data-openbitfun-state="expanded">
        {interruptionNote && (
          <>
            <div className="task-interruption-note" role="note" data-openbitfun-component="task-tool-display" data-openbitfun-part="interruption">
              <AlertTriangle size={14} strokeWidth={2} aria-hidden />
              <span>{interruptionNote}</span>
            </div>
            {(hasRealPrompt || needsConfirmation || rc) && (
              <div className="task-interruption-divider" aria-hidden />
            )}
          </>
        )}
        {rc ? (
          <div className="task-reviewer-context" data-openbitfun-component="task-tool-display" data-openbitfun-part="reviewer">
            <div className="task-reviewer-context__role" style={{ color: rc.accentColor }}>
              {tAgents(`reviewTeams.members.${rc.definitionKey}.role`, {
                defaultValue: rc.roleName,
              })}
            </div>
            <div className="task-reviewer-context__description">
              {tAgents(`reviewTeams.members.${rc.definitionKey}.description`, {
                defaultValue: rc.description,
              })}
            </div>
            <ul className="task-reviewer-context__responsibilities" data-openbitfun-component="task-tool-display" data-openbitfun-part="responsibilities">
              {rc.responsibilities.map((resp, idx) => (
                <li key={idx}>
                  {tAgents(`reviewTeams.members.${rc.definitionKey}.responsibilities.${idx}`, {
                    defaultValue: resp,
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          hasRealPrompt && (
          <div
            className={`thinking-content-wrapper task-prompt-wrapper${promptScrollState.hasScroll ? ' has-scroll' : ''}${
              promptScrollState.atTop ? ' at-top' : ''
            }${promptScrollState.atBottom ? ' at-bottom' : ''}`}
            data-openbitfun-component="task-tool-display"
            data-openbitfun-part="prompt"
          >
            <div
              ref={promptContentRef}
              className="thinking-content task-prompt-content expanded"
              onScroll={checkPromptScrollState}
            >
              <MarkdownRenderer
                content={taskInput!.prompt}
                isStreaming={false}
                className="thinking-markdown task-prompt-markdown"
              />
            </div>
          </div>
          )
        )}
      </div>
    );
  };

  if (isCancelAction) {
    const cancelSessionId = linkedSubagentSessionId || 'Not provided';
    return (
      <div data-openbitfun-component="task-tool-display" data-openbitfun-part="root">
        <div data-openbitfun-component="task-tool-display" data-openbitfun-part="cancel">
          <AmbientToolCard
            status={status}
            isExpanded={false}
            className="task-cancel-card"
            header={
              <AmbientToolCardHeader
                icon={<ToolCardStatusSlot status={status} toolIcon={<Split size={16} />} />}
                content={t('toolCards.taskTool.cancelSession', { sessionId: cancelSessionId })}
              />
            }
          />
        </div>
      </div>
    );
  }

  const statusLabel = reviewOutcome
    ? t(reviewOutcome.key)
    : hasFailedOutcome
      ? t('toolCards.taskTool.failed')
      : isCancelledResult || displayStatus === 'cancelled'
        ? t('flowChatHeader.agentTreeStatus.cancelled')
        : undefined;
  const statusTone = hasFailedOutcome
    ? isReviewPartialTimeout ? 'warning' : 'danger'
    : 'neutral';
  const stopActionLabel = isStoppingSubagent
    ? t(isReviewCoverageTask
      ? 'toolCards.taskDetailPanel.stoppingReviewWork'
      : 'toolCards.taskDetailPanel.stoppingSubagent')
    : t(isReviewCoverageTask
      ? 'toolCards.taskDetailPanel.stopReviewWork'
      : 'toolCards.taskDetailPanel.stopSubagent');

  return (
    <div
      data-openbitfun-component="task-tool-display"
      data-openbitfun-part="root"
      data-openbitfun-state={[isFailed && 'failed', displayIsExpanded && 'expanded'].filter(Boolean).join(' ') || undefined}
      ref={cardRootRef}
      data-tool-card-id={toolId ?? ''}
    >
      <AgentControlToolCardView
        status={displayStatus}
        isExpanded={displayIsExpanded}
        onToggle={showSummaryExpandHint ? handleCardClick : undefined}
        className="task-tool-display"
        agentName={t('toolCards.taskTool.headerLinePrefix', { agentType: taskAgentTypeLabel })}
        agentModel={showSubagentExecModel && resolvedSubagentModel ? resolvedSubagentModel : undefined}
        avatar={linkedSubagentSessionId ? (
          <SubagentAvatar
            sessionId={linkedSubagentSessionId}
            name={taskAgentTypeLabel}
            size={28}
            status={subagentAvatarStatus}
          />
        ) : <Split size={16} />}
        details={renderExpandedContent()}
        summaryExpandAffordance={showSummaryExpandHint}
        interruptAction={canStopSyncSubagent ? {
          disabled: isStoppingSubagent,
          label: stopActionLabel,
          onPress: handleStopSyncSubagent,
          pending: isStoppingSubagent,
        } : undefined}
        isFailed={hasFailedOutcome}
        onOpenAgent={openTaskDetailPanel}
        openAgentLabel={t('toolCards.taskTool.openInPanel')}
        requiresConfirmation={needsConfirmation}
        statusLabel={statusLabel}
        statusMeta={(
          <ToolTimeoutIndicator
            startTime={toolItem.startTime}
            isRunning={effectiveIsRunning}
            timeoutMs={
              typeof toolCall?.timeout_seconds === 'number' && toolCall.timeout_seconds > 0
                ? toolCall.timeout_seconds * 1000
                : typeof toolCall?.input?.timeout_seconds === 'number' && toolCall.input.timeout_seconds > 0
                ? toolCall.input.timeout_seconds * 1000
                : undefined
            }
            showControls={true}
            subagentSessionId={toolItem.subagentSessionId}
            defaultTimeoutDisabled={defaultTimeoutDisabled}
            completedDurationMs={taskDurationMs}
            showCompletedDuration={displayIsExpanded}
            completedStatus={completedDurationStatus}
            completedFailureReason={hasFailedOutcome ? visibleTaskErrorMessage ?? undefined : undefined}
          />
        )}
        statusTone={statusTone}
        summary={taskDesc}
      />
    </div>
  );
};
