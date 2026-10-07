import React, { useCallback, useSyncExternalStore } from 'react';
import { SessionMessageToolCard as SessionMessageToolCardView } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { flowChatStore } from '../store/FlowChatStore';
import type { ToolCardProps } from '../types/flow-chat';
import { getToolCardStatus } from './toolCardStatus';
import { interactionOutcome, readInteractionInput, readToolRecord, resolveInteractionAgentSessionId, toolString } from './toolInteractionModel';
import { subscribeToToolSessions, useToolSessionParticipant, useCurrentToolSessionParticipant } from './useToolSessionParticipant';

/** Sending and stopping describe this call's outcome, independently of the child's lifecycle. */
export const AgentInteractionToolCard: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { t } = useI18n('flow-chat');
  const input = readInteractionInput(toolItem);
  const result = readToolRecord(toolItem.toolResult?.result);
  const stopping = toolItem.toolName === 'AgentInterrupt' || input.action === 'cancel'
    || result.action === 'cancel' || result.action === 'interrupt';
  const status = getToolCardStatus(toolItem, result.success === false);
  const readLinkedSession = useCallback(() => {
    const { sessions } = flowChatStore.getState();
    return resolveInteractionAgentSessionId(toolItem, sessionId ? sessions.get(sessionId) : undefined,
      { sessions, parentSessionId: sessionId });
  }, [toolItem, sessionId]);
  const linkedSessionId = useSyncExternalStore(subscribeToToolSessions, readLinkedSession, readLinkedSession);
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const target = useToolSessionParticipant(linkedSessionId, t('toolCards.interaction.unknownAgent'), t, 'agent',
    { parentSessionId: sessionId, parentToolCallId: toolItem.toolCall?.id || toolItem.id });
  const message = typeof input.prompt === 'string' ? input.prompt
    : typeof input.message === 'string' ? input.message : typeof input.input === 'string' ? input.input : '';
  const interrupted = result.interrupted_background_tasks ?? result.cancelled_background_tasks;
  const stoppedCount = typeof interrupted === 'number' && Number.isFinite(interrupted) && interrupted >= 0 ? interrupted : undefined;
  const action = stopping ? t('toolCards.interaction.interrupt') : t('toolCards.interaction.send');
  const completed = stopping ? stoppedCount === 0 ? t('toolCards.interaction.noActiveRuns')
    : stoppedCount !== undefined ? t('toolCards.interaction.interruptedRuns', { count: stoppedCount })
      : t('toolCards.interaction.stopRequested')
    : message.trim() ? t('toolCards.interaction.messageSent') : t('toolCards.interaction.messageAccepted');
  const summary = interactionOutcome(status, t, completed,
    stopping ? t('toolCards.interaction.stopping') : t('toolCards.interaction.sendingMessage'));

  return <div data-openbitfun-adapter="agent-interaction" data-tool-card-id={toolItem.id}>
    <SessionMessageToolCardView status={status} action={action}
      interaction={{ operation: stopping ? 'interrupt' : 'send', source, target }}
      summary={summary} resultLabel={stopping ? t('toolCards.interaction.inspectResult') : t('toolCards.interaction.inspectMessage')}
      message={!stopping && message ? message : undefined} messageLabel={t('toolCards.sessionMessage.message')}
      error={toolItem.toolResult?.error || (status === 'error' ? toolString(result.error) || t('toolCards.default.failed') : undefined)} />
  </div>;
};
