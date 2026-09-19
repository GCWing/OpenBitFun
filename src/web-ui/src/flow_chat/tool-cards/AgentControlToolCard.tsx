import React, {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { MarkdownRenderer } from '@/infrastructure/markdown';
import { flowChatStore } from '../store/FlowChatStore';
import {
  formatAgentIdForDisplay,
  SubagentAvatar,
} from '../subagent-identity';
import type { FlowToolItem, ToolCardProps } from '../types/flow-chat';
import {
  sessionLineageLifecycleForSession,
  type SessionLineageLifecycle,
} from '../utils/sessionLineage';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { AgentControlToolCard as AgentControlToolCardView } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';

const PARAMETER_STREAMING_STATUSES = new Set<FlowToolItem['status']>([
  'preparing',
  'streaming',
  'receiving',
]);

function readString(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== 'object') {
    return '';
  }

  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function fallbackLifecycle(status: FlowToolItem['status']): SessionLineageLifecycle {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'rejected':
      return 'cancelled';
    case 'error':
      return 'error';
    case 'waiting':
      return 'waiting';
    case 'pending':
    case 'queued':
      return 'idle';
    default:
      return 'running';
  }
}

function statusForLifecycle(
  lifecycle: SessionLineageLifecycle,
  fallback: FlowToolItem['status'],
): FlowToolItem['status'] {
  switch (lifecycle) {
    case 'running':
    case 'finishing':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return fallback;
  }
}

function subscribeToFlowChatStore(listener: () => void): () => void {
  return flowChatStore.subscribe(() => listener());
}

function readLinkedAgentSnapshot(sessionId: string): string {
  if (!sessionId) {
    return '';
  }

  const session = flowChatStore.getState().sessions.get(sessionId);
  const latestTurn = session?.dialogTurns?.[session.dialogTurns.length - 1];
  return JSON.stringify([
    session?.title ?? '',
    session?.mode ?? '',
    session?.subagentType ?? '',
    session?.config?.agentType ?? '',
    session?.needsUserAttention ?? false,
    session?.status ?? '',
    session?.persistedStatus ?? '',
    session?.hasUnreadCompletion ?? '',
    latestTurn?.id ?? '',
    latestTurn?.status ?? '',
    latestTurn?.modelRounds?.some(round => round.isStreaming) ?? false,
  ]);
}

export const AgentControlToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, status } = toolItem;
  const toolId = toolItem.id ?? toolCall?.id;
  const params = toolItem.partialParams ?? toolCall?.input;
  const prompt = readString(params, 'prompt');
  const inputAgentType = readString(params, 'agent_type', 'agentType');
  const agentId = readString(params, 'agent_id', 'agentId')
    || readString(toolItem.toolResult?.result, 'agent_id', 'agentId');
  const linkedSubagentSessionId = toolItem.subagentSessionId ?? '';
  const readSnapshot = useCallback(
    () => readLinkedAgentSnapshot(linkedSubagentSessionId),
    [linkedSubagentSessionId],
  );

  useSyncExternalStore(
    subscribeToFlowChatStore,
    readSnapshot,
    readSnapshot,
  );

  const linkedSession = linkedSubagentSessionId
    ? flowChatStore.getState().sessions.get(linkedSubagentSessionId)
    : undefined;
  const lifecycle = linkedSession
    ? sessionLineageLifecycleForSession(linkedSession)
    : fallbackLifecycle(status);
  const agentName = agentId
    || linkedSession?.subagentType?.trim()
    || linkedSession?.mode?.trim()
    || inputAgentType
    || t('toolCards.taskTool.defaultAgentKind');
  const agentDisplayName = agentId ? formatAgentIdForDisplay(agentId) : agentName;
  const stableAgentType = linkedSession?.mode?.trim()
    || linkedSession?.config?.agentType?.trim()
    || inputAgentType;
  const stableSubagentType = linkedSession?.subagentType?.trim() || inputAgentType;
  const isParameterStreaming = Boolean(toolItem.isParamsStreaming)
    || PARAMETER_STREAMING_STATUSES.has(status);
  const displayStatus = isParameterStreaming
    ? status
    : statusForLifecycle(lifecycle, status);
  const canExpand = Boolean(prompt) && !isParameterStreaming;
  const canOpenSession = Boolean(linkedSubagentSessionId && sessionId);
  const [isExpanded, setIsExpanded] = useState(false);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const updateExpandedState = useCallback((nextExpanded: boolean) => {
    applyExpandedState(isExpanded, nextExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded]);

  useLayoutEffect(() => {
    if (isParameterStreaming && isExpanded) {
      updateExpandedState(false);
    }
  }, [isExpanded, isParameterStreaming, updateExpandedState]);

  const handleToggle = useCallback(() => {
    if (!canExpand) {
      return;
    }
    updateExpandedState(!isExpanded);
  }, [canExpand, isExpanded, updateExpandedState]);

  const handleOpenSession = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!linkedSubagentSessionId || !sessionId) {
      return;
    }

    const parentSession = flowChatStore.getState().sessions.get(sessionId);
    openBtwSessionInAuxPane({
      childSessionId: linkedSubagentSessionId,
      parentSessionId: sessionId,
      workspacePath: parentSession?.workspacePath,
      sessionKind: 'subagent',
      sessionTitle: agentDisplayName,
      agentType: stableAgentType || undefined,
      parentToolCallId: toolCall?.id || toolItem.id,
      subagentType: stableSubagentType || undefined,
      remoteConnectionId: parentSession?.remoteConnectionId,
      remoteSshHost: parentSession?.remoteSshHost,
      includeInternal: true,
    });
  }, [
    agentDisplayName,
    linkedSubagentSessionId,
    sessionId,
    stableAgentType,
    stableSubagentType,
    toolCall?.id,
    toolItem.id,
  ]);

  const statusTone = lifecycle === 'running' || lifecycle === 'finishing'
    ? 'success'
    : lifecycle === 'waiting'
      ? 'warning'
      : lifecycle === 'error' || lifecycle === 'cancelled'
        ? 'danger'
        : 'neutral';

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="agent-control-tool-card"
      data-tool-card-id={toolId ?? ''}
    >
      <AgentControlToolCardView
        status={displayStatus}
        isExpanded={isExpanded}
        onToggle={canExpand ? handleToggle : undefined}
        agentName={agentDisplayName}
        avatar={linkedSubagentSessionId ? (
          <SubagentAvatar
            sessionId={linkedSubagentSessionId}
            name={agentName}
            size={28}
            status={lifecycle}
          />
        ) : undefined}
        statusLabel={t(`flowChatHeader.agentTreeStatus.${lifecycle}`)}
        statusTone={statusTone}
        onOpenAgent={canOpenSession ? handleOpenSession : undefined}
        openAgentLabel={t('toolCards.taskTool.openInPanel')}
        prompt={prompt ? (
          <MarkdownRenderer
            content={prompt}
            isStreaming={false}
          />
        ) : undefined}
      />
    </div>
  );
};
