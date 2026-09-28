import React, { useCallback, useSyncExternalStore } from 'react';
import { ToolRelationRow, ToolCardText } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '../store/FlowChatStore';
import { resolveSubagentNameKey, SubagentAvatar } from '../subagent-identity';
import type { ToolCardProps } from '../types/flow-chat';
import { resolveBuiltinAgentSessions } from './builtinAgentSessions';
import { getToolCardStatus } from './toolCardStatus';
import { interactionOutcome, readInteractionInput, readToolRecord } from './toolInteractionModel';
import { subscribeToToolSessions, useCurrentToolSessionParticipant } from './useToolSessionParticipant';

/** Deleted participants retain their recorded identity and inspectable evidence. */
export const AgentDeleteToolCard: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const input = readInteractionInput(toolItem);
  const result = readToolRecord(toolItem.toolResult?.result);
  const status = getToolCardStatus(toolItem, result.success === false);
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const readLinks = useCallback(() => JSON.stringify(resolveBuiltinAgentSessions(toolItem, flowChatStore.getState().sessions, sessionId)), [toolItem, sessionId]);
  const links = JSON.parse(useSyncExternalStore(subscribeToToolSessions, readLinks, readLinks)) as Record<string, string>;
  const rawIds = input.agent_ids ?? result.agent_ids;
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : [rawIds]).filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map(id => id.trim()))];
  const targets = ids.map(id => {
    const linked = links[id];
    const label = linked ? t(resolveSubagentNameKey(linked)) : id;
    return { id, label, kind: 'agent' as const,
      avatar: linked ? <SubagentAvatar sessionId={linked} name={label} size={16} motion={false} showStatus={false} /> : undefined,
      openLabel: t('toolCards.interaction.inspectObject'),
      details: <ToolCardText variant="prose">{toolItem.toolResult?.error || t('toolCards.builtin.deleteAgentScope')}</ToolCardText>,
    };
  });
  const count = typeof result.deleted_agents === 'number' && Number.isFinite(result.deleted_agents) && result.deleted_agents >= 0
    ? result.deleted_agents : undefined;
  const summary = interactionOutcome(status, t, count === undefined ? t('toolCards.interaction.deleted')
    : t('toolCards.interaction.agentsDeleted', { value: formatNumber(count) }), t('toolCards.interaction.deleting'));

  return <ToolRelationRow data-openbitfun-adapter="agent-delete" data-tool-card-id={toolItem.id}
    interaction={{ operation: 'delete', source, targets, target: targets[0] ?? { kind: 'agent', label: t('toolCards.interaction.unknownAgent') } }}
    result={summary} status={status} resultLabel={t('toolCards.interaction.inspectResult')}
    detailsTitle={summary}
    details={<ToolCardText variant="prose">{toolItem.toolResult?.error || t('toolCards.builtin.deleteAgentScope')}</ToolCardText>} />;
};
