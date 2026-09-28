/**
 * TaskTool card display component.
 */

import React, {
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { Icon } from '@openbitfun/ui';
import { getToolCardStatusDescription } from './toolCardStatus';

import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { FlowToolItem, ToolCardProps } from '../types/flow-chat';
import {
  AgentControlToolCard as AgentControlToolCardView,
  AmbientToolCard,
  AmbientToolCardHeader,
  ToolCardStatusSlot,
} from '@openbitfun/ui/flow-chat';
import { getReviewerContextBySubagentId } from '@/shared/services/reviewTeamService';
import type { ReviewerContext } from '@/shared/services/reviewTeamService';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { flowChatStore } from '../store/FlowChatStore';
import { deriveSubagentExecutionStatus, findProjectedSession } from '../utils/subagentProjection';
import { sessionLineageLifecycleForSession } from '../utils/sessionLineage';
import {
  SubagentAvatar,
  SubagentDelegationAvatar,
  resolveSubagentAvatarAccent,
  resolveSubagentNameKey,
} from '../subagent-identity';
import { deriveReviewTaskOutcome } from '../utils/reviewTaskOutcome';
import { AgentInteractionToolCard } from './AgentInteractionToolCard';
import { readInteractionInput, readToolRecord } from './toolInteractionModel';

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

  const result = readToolRecord(toolResult?.result);
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

const TaskLaunchDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  onOpenInPanel,
  sessionId,
}) => {
  const { t, currentLanguage } = useI18n('flow-chat');
  const { t: tAgents } = useI18n('scenes/agents');
  const { toolCall, toolResult, status, requiresConfirmation, userConfirmed } = toolItem;
  const toolId = toolItem.id ?? toolCall?.id;
  const rawTaskAction = readTaskAction(toolCall?.input, toolResult);
  const isCancelAction = rawTaskAction === 'cancel';
  const isBackgroundTask = readTaskRunInBackground(toolCall?.input, toolResult);
  const isReviewCoverageTask = isDeepReviewReviewerTask(toolItem, sessionId);
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running';

  const taskSessionId = readTaskSessionId(toolCall?.input, toolResult);
  const readSubagentSessionId = useCallback(() => (
    toolItem.subagentSessionId || taskSessionId || findProjectedSession(flowChatStore.getState(), {
      parentSessionId: sessionId,
      parentToolIds: new Set([toolItem.id, toolCall?.id].filter((id): id is string => Boolean(id))),
    })?.sessionId || ''
  ), [sessionId, taskSessionId, toolCall?.id, toolItem.id, toolItem.subagentSessionId]);
  // Persisted Task results may carry only the agent alias. The child session's
  // relationship still identifies the originating call, and may hydrate later.
  const linkedSubagentSessionId = useSyncExternalStore(
    subscribeToFlowChatStore, readSubagentSessionId, readSubagentSessionId,
  );
  const agentDisplayName = linkedSubagentSessionId
    ? t(resolveSubagentNameKey(linkedSubagentSessionId)) : t('toolCards.interaction.unknownAgent');
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
      readStringValue(linkedSubagentSession?.config?.modelName) ||
      readStringValue(toolItem.subagentModelId) ||
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
  const needsConfirmation = requiresConfirmation && !userConfirmed
    && !['completed', 'cancelled', 'rejected', 'error'].includes(status);

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
  const reviewOutcome = isReviewPartialTimeout
    ? { key: 'toolCards.taskTool.reviewPartialTimeout', kind: 'partial-timeout' }
    : isReviewTimeout
      ? { key: 'toolCards.taskTool.reviewTimedOut', kind: 'timed-out' }
      : isReviewCoverageTask && isCancelledResult
        ? { key: 'toolCards.taskTool.reviewStopped', kind: 'stopped' }
        : null;
  const stableSubagentType = readTaskSubagentType(toolCall?.input)
    || readStringValue(linkedSubagentSession?.subagentType);
  const stableAgentType = readStringValue(linkedSubagentSession?.mode)
    || readStringValue(linkedSubagentSession?.config?.agentType)
    || stableSubagentType;
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
                icon={<ToolCardStatusSlot status={status} toolIcon={<Icon name="users" size="sm" />} />}
                action={t('toolCards.interaction.interrupt')}
                content={cancelSessionId}
                statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
              />
            }
          />
        </div>
      </div>
    );
  }

  const capsuleLifecycle = hasFailedOutcome ? 'error'
    : isCancelledResult || displayStatus === 'cancelled' || displayStatus === 'rejected' ? 'cancelled'
      : needsConfirmation || displayStatus === 'waiting' ? 'waiting'
        : effectiveIsRunning ? 'running'
          : displayStatus === 'completed' || displayStatus === 'confirmed' ? 'completed'
            : subagentAvatarStatus;
  const statusLabel = reviewOutcome
    ? t(reviewOutcome.key)
    : hasFailedOutcome
      ? t('toolCards.taskTool.failed')
      : isCancelledResult || displayStatus === 'cancelled'
        ? t('flowChatHeader.agentTreeStatus.cancelled')
        : capsuleLifecycle === 'completed'
          ? undefined
          : t(`flowChatHeader.agentTreeStatus.${capsuleLifecycle}`);
  const statusTone = hasFailedOutcome
    ? isReviewPartialTimeout ? 'warning' : 'danger'
    : 'neutral';

  return (
    <div
      data-openbitfun-component="task-tool-display"
      data-openbitfun-part="root"
      data-openbitfun-state={hasFailedOutcome ? 'failed' : undefined}
      data-tool-card-id={toolId ?? ''}
    >
      <AgentControlToolCardView
        lang={currentLanguage}
        status={displayStatus}
        className="task-tool-display"
        agentName={agentDisplayName}
        accentColor={linkedSubagentSessionId ? resolveSubagentAvatarAccent(linkedSubagentSessionId) : undefined}
        avatar={(
          <SubagentDelegationAvatar
            sessionId={linkedSubagentSessionId}
            pending={!hasFailedOutcome && !isCancelledResult && !needsConfirmation
              && ['pending', 'queued', 'preparing', 'streaming', 'receiving', 'running'].includes(status)}
            name={agentDisplayName}
            size={40}
            motion
            showStatus={false}
            status={capsuleLifecycle}
          />
        )}
        isFailed={hasFailedOutcome}
        onOpenAgent={openTaskDetailPanel}
        openAgentLabel={t('toolCards.taskTool.openInPanel')}
        requiresConfirmation={needsConfirmation}
        statusLabel={statusLabel}
        statusTone={statusTone}
        summary={taskDesc}
        preview={{
          avatar: linkedSubagentSessionId ? (
            <SubagentAvatar sessionId={linkedSubagentSessionId} name={agentDisplayName}
              size={40} showStatus={false} status={capsuleLifecycle} />
          ) : <SubagentDelegationAvatar pending={false} motion={false} size={40} showStatus={false} />,
          agentType: taskAgentTypeLabel,
          model: taskInput?.modelName || readStringValue(linkedSubagentSession?.config?.modelName)
            || readStringValue(toolItem.subagentModelDisplayName) || readStringValue(toolItem.subagentModelId)
            || t('subagentIdentity.preview.unknownModel'),
          labels: {
            agentType: t('subagentIdentity.preview.agentType'),
            model: t('subagentIdentity.preview.model'),
            description: t('subagentIdentity.preview.description'),
          },
        }}
      />
    </div>
  );
};

export const TaskToolDisplay: React.FC<ToolCardProps> = props => {
  const action = readTaskAction(readInteractionInput(props.toolItem), props.toolItem.toolResult);
  return action === 'send_input' || action === 'cancel'
    ? <AgentInteractionToolCard {...props} /> : <TaskLaunchDisplay {...props} />;
};
