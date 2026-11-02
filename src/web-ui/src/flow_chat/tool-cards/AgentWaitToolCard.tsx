import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

import { flowChatStore } from '../store/FlowChatStore';
import { resolveSubagentNameKey, SubagentDelegationAvatar } from '../subagent-identity';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { shouldShowAgentWaitSteeringHint } from './agentWaitSteeringHint';
import { resolveAgentWaitAvatarTargets, type AgentWaitAvatarTarget } from './agentWaitAvatarTargets';
import {
  AgentWaitToolCard as AgentWaitToolCardView,
  ToolCardDisclosure, ToolCardSection, ToolCardText,
} from '@openbitfun/ui/flow-chat';
import { useCurrentToolSessionParticipant } from './useToolSessionParticipant';
import { interactionOutcome, readInteractionInput, readToolRecord, toolString } from './toolInteractionModel';
import { formatRuntimeToolValue } from './runtimeToolCardModel';

interface AgentWaitResult {
  status?: string;
  results?: unknown[];
  pending_bg_task_ids?: string[];
}

function subscribeToFlowChatStore(listener: () => void): () => void {
  return flowChatStore.subscribe(() => listener());
}

export const AgentWaitToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  sessionId,
  displayContext,
}) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);
  const toolId = toolItem.id ?? toolCall?.id;
  const result = readToolRecord(toolResult?.result) as AgentWaitResult;
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
  const showSteeringHint = shouldShowAgentWaitSteeringHint(status, displayContext, session);
  const steeringHint = t('toolCards.agentWait.steeringHint');
  const readAvatarSnapshot = useCallback(() => {
    const { sessions } = flowChatStore.getState();
    return JSON.stringify(resolveAgentWaitAvatarTargets(
      readInteractionInput(toolItem),
      readToolRecord(toolResult?.result),
      sessionId ? sessions.get(sessionId) : undefined,
      { sessions, parentSessionId: sessionId },
    ));
  }, [sessionId, toolItem, toolResult?.result]);
  const avatarSnapshot = useSyncExternalStore(
    subscribeToFlowChatStore,
    readAvatarSnapshot,
    readAvatarSnapshot,
  );
  const avatarTargets = useMemo(() => JSON.parse(avatarSnapshot) as AgentWaitAvatarTarget[], [avatarSnapshot]);
  const avatarNames = avatarTargets.map(target => target.sessionId
    ? t(resolveSubagentNameKey(target.sessionId)) : t('toolCards.interaction.unknownAgent'));
  const hatching = !session?.isHistorical
    && ['pending', 'queued', 'preparing', 'streaming', 'receiving', 'running', 'waiting'].includes(status);
  const surfaceScope = getActiveSurfaceScope();
  const canOpenAgents = Boolean(session && !session.config?.dispatchTarget && !session.config?.dispatchJobId);

  const handleOpenAgent = useCallback((target: AgentWaitAvatarTarget, name: string, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!surfaceScope.isCurrent() || !sessionId || !target.sessionId) return;
    const sessions = flowChatStore.getState().sessions;
    const parentSession = sessions.get(sessionId);
    if (!parentSession || parentSession.config?.dispatchTarget || parentSession.config?.dispatchJobId) return;
    const childSession = sessions.get(target.sessionId);
    openBtwSessionInAuxPane({
      childSessionId: target.sessionId,
      parentSessionId: sessionId,
      workspaceId: childSession?.workspaceId,
      workspacePath: parentSession?.workspacePath,
      sessionKind: 'subagent',
      sessionTitle: name,
      agentType: childSession?.mode?.trim() || childSession?.config?.agentType?.trim() || undefined,
      parentToolCallId: childSession?.parentToolCallId || target.parentToolCallId,
      subagentType: childSession?.subagentType,
      remoteConnectionId: parentSession?.remoteConnectionId,
      remoteSshHost: parentSession?.remoteSshHost,
      includeInternal: true,
    });
  }, [sessionId, surfaceScope]);

  const waitDescription = status === 'completed' && result.status === 'steered'
    ? t('toolCards.agentWait.steered')
    : status === 'completed' && result.status === 'timed_out' && Array.isArray(result.pending_bg_task_ids)
      ? t('toolCards.agentWait.timedOut', { count: result.pending_bg_task_ids.length })
      : undefined;
  const summary = interactionOutcome(status, t, waitDescription ?? (Array.isArray(result.results)
    ? result.results.length ? t('toolCards.interaction.receivedResults', { value: formatNumber(result.results.length) })
      : t('toolCards.interaction.noResults') : t('toolCards.interaction.resultsReceived')),
    t('toolCards.interaction.waitingResults'));
  const outcomes = Array.isArray(result.results) ? result.results.map((value, index) => {
    const record = readToolRecord(value);
    const targetIndex = avatarTargets.findIndex(target => target.id === record.bg_task_id);
    const content = typeof value === 'string' ? value : typeof record.content === 'string' ? record.content : undefined;
    const error = toolString(record.error);
    const outcome = record.outcome === 'completed' ? t('toolCards.default.completed')
      : record.outcome === 'failed' ? t('toolCards.default.failed')
        : record.outcome === 'cancelled' ? t('toolCards.default.cancelled') : undefined;
    return <ToolCardSection key={toolString(record.bg_task_id) || index}
      label={result.results!.length > 1 ? avatarNames[targetIndex] || toolString(record.agent_id) || t('toolCards.interaction.unknownAgent') : undefined}>
      {content && <ToolCardText variant="prose">{content}</ToolCardText>}
      {error && error !== content && <ToolCardText variant="prose">{error}</ToolCardText>}
      {!error && outcome && (!content || record.outcome !== 'completed') && <ToolCardText variant="prose">{outcome}</ToolCardText>}
      {!content && !error && !outcome && <ToolCardDisclosure summary={t('toolCards.builtin.rawResult')}>
        <ToolCardText>{formatRuntimeToolValue(value)}</ToolCardText>
      </ToolCardDisclosure>}
    </ToolCardSection>;
  }) : [];

  return (
      <AgentWaitToolCardView
        action={t('toolCards.agentWait.title')}
        data-tool-card-id={toolId ?? ''}
        status={status}
        interaction={{ operation: 'receive', source,
          target: {
            label: avatarNames.join(' · ') || t('toolCards.interaction.unknownAgent'), kind: 'agent',
            avatar: <SubagentDelegationAvatar pending={hatching} size={16} showStatus={false} />,
          } }}
        resultSummary={summary}
        resultLabel={t('toolCards.interaction.inspectResult')}
        detailsTitle={t('toolCards.builtin.fields.results')}
        details={<>
          {outcomes.length === 0 && !toolResult?.error && <ToolCardText variant="prose">{summary}</ToolCardText>}
          {outcomes}
          {showSteeringHint && <ToolCardText variant="prose">{steeringHint}</ToolCardText>}
          {toolResult?.error && <ToolCardText variant="prose">{toolResult.error}</ToolCardText>}
        </>}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)
          ?? (showSteeringHint ? steeringHint : waitDescription)}
        agents={{
          items: avatarTargets.map((target, index) => ({
            id: target.id, name: avatarNames[index], openLabel: t('toolCards.taskTool.openInPanel'),
            avatar: <SubagentDelegationAvatar sessionId={target.sessionId} pending={hatching}
              name={avatarNames[index]} size={16} showStatus={false} />,
            onOpen: target.sessionId && canOpenAgents ? event => handleOpenAgent(target, avatarNames[index], event) : undefined,
          })),
          previousLabel: t('toolCards.agentWait.scrollPrevious'),
          nextLabel: t('toolCards.agentWait.scrollNext'),
        }}
      />
  );
};
