import React, { useMemo } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getToolCardStatus } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { SessionMessageToolCard as SessionMessageToolCardView } from '@openbitfun/ui/flow-chat';
import { interactionOutcome, readInteractionInput, readToolRecord } from './toolInteractionModel';
import { useToolSessionParticipant, useCurrentToolSessionParticipant } from './useToolSessionParticipant';

interface SessionMessageInput {
  workspace?: string;
  session_id?: string;
  session_name?: string;
  message?: string;
  agent_type?: string;
}

interface SessionMessageResult {
  success?: boolean;
  target_workspace?: string;
  target_session_id?: string;
  target_session_name?: string;
  target_agent_type?: string;
}

export const SessionMessageToolCard: React.FC<ToolCardProps> = React.memo(({
  toolItem,
  sessionId,
}) => {
  const { t } = useI18n('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const toolId = toolItem.id ?? toolCall?.id;

  const inputData = useMemo(
    () => readInteractionInput(toolItem) as SessionMessageInput,
    [toolItem]
  );

  const resultData = useMemo(
    () => readToolRecord(toolResult?.result) as SessionMessageResult,
    [toolResult?.result]
  );

  const status = getToolCardStatus(toolItem, resultData?.success === false);
  const targetSessionId = resultData?.target_session_id ?? inputData.session_id;
  const message = inputData.message ?? '';
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const target = useToolSessionParticipant(targetSessionId,
    resultData?.target_session_name || inputData.session_name || targetSessionId || t('toolCards.sessionMessage.unknownSession'), t,
    'session', { parentSessionId: sessionId });
  const targetLabel = target.kind === 'agent' ? target.label
    : resultData?.target_session_name || inputData.session_name || target.label;
  const summary = interactionOutcome(status, t, message.trim() ? t('toolCards.interaction.messageSent')
    : t('toolCards.interaction.messageAccepted'), t('toolCards.interaction.sendingMessage'));

  return (
    <div data-openbitfun-adapter="session-message" data-tool-card-id={toolId ?? ''}>
      <SessionMessageToolCardView
        status={status}
        action={t('toolCards.interaction.send')}
        interaction={{ operation: 'send', source, target: { ...target, label: targetLabel } }}
        summary={summary}
        resultLabel={t('toolCards.interaction.inspectMessage')}
        message={message || undefined}
        messageLabel={message ? t('toolCards.sessionMessage.message') : undefined}
        error={toolResult?.error || (status === 'error' ? t('toolCards.default.failed') : undefined)}
      />
    </div>
  );
});
