import { useToolCardDisclosure } from '../timeline/readerState';
import React, { useMemo } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { SessionControlToolCard as SessionControlToolCardView } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { interactionOutcome, readInteractionInput, readToolRecord } from './toolInteractionModel';
import { useToolSessionParticipant, useCurrentToolSessionParticipant } from './useToolSessionParticipant';

interface SessionSummary {
  session_id?: string;
  session_name?: string;
  agent_type?: string;
}

interface SessionControlInput {
  action?: 'create' | 'cancel' | 'delete' | 'rename' | 'list';
  workspace?: string;
  session_id?: string;
  session_name?: string;
  agent_type?: string;
}

interface SessionControlResult {
  success?: boolean;
  action?: 'create' | 'cancel' | 'delete' | 'rename' | 'list';
  workspace?: string;
  count?: number;
  session_id?: string;
  session_name?: string;
  had_active_turn?: boolean;
  cancelled_turn_id?: string;
  status?: 'cancel_requested' | 'no_active_turn';
  session?: SessionSummary;
  sessions?: SessionSummary[];
}

export const SessionControlToolCard: React.FC<ToolCardProps> = React.memo(({
  toolItem,
  sessionId: sourceSessionId,
  onExpand,
}) => {
  const { t } = useI18n('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const inputData = useMemo(
    () => readInteractionInput(toolItem) as SessionControlInput,
    [toolItem]
  );

  const resultData = useMemo(
    () => readToolRecord(toolResult?.result) as SessionControlResult,
    [toolResult?.result]
  );

  const status = getToolCardStatus(toolItem, resultData?.success === false);
  const action = resultData?.action ?? inputData.action ?? 'list';
  const workspace = resultData?.workspace ?? inputData.workspace;
  const session = resultData?.session;
  const sessionId = session?.session_id ?? resultData?.session_id ?? inputData.session_id;
  const sessionName = session?.session_name ?? resultData?.session_name ?? inputData.session_name;
  const source = useCurrentToolSessionParticipant(sourceSessionId, t);
  const target = useToolSessionParticipant(sessionId, sessionName || sessionId || t('toolCards.sessionControl.unknownSession'), t,
    'session', { parentSessionId: sourceSessionId, enabled: action !== 'list'
      && !(action === 'delete' && (status === 'completed' || status === 'confirmed')) });
  const agentType = session?.agent_type ?? inputData.agent_type;
  const sessions = Array.isArray(resultData?.sessions) ? resultData.sessions : [];
  const sessionCount = resultData?.count ?? sessions.length;
  const cancelStatus = resultData?.status;
  const hadActiveTurn = resultData?.had_active_turn;
  const cancelledTurnId = resultData?.cancelled_turn_id;
  const hasDetails = Boolean(
    action !== 'list' ||
    workspace ||
    sessionId ||
    sessionName ||
    agentType ||
    sessions.length ||
    cancelStatus ||
    hadActiveTurn !== undefined ||
    cancelledTurnId ||
    toolResult?.error
  );
  const actionLabels = {
    create: t('toolCards.interaction.create'),
    cancel: t('toolCards.interaction.interrupt'),
    delete: t('toolCards.interaction.delete'),
    rename: t('toolCards.interaction.rename'),
    list: t('toolCards.interaction.list'),
  };
  const statusLabel = status === 'error' ? t('toolCards.default.failed')
    : status === 'cancelled' ? t('toolCards.default.cancelled')
      : status === 'rejected' ? t('toolCards.default.rejected')
        : action === 'cancel' && status === 'completed' ? cancelStatus === 'no_active_turn'
          ? t('toolCards.sessionControl.noActiveTurnStatus') : t('toolCards.sessionControl.cancelRequestedStatus') : undefined;

  const completed = action === 'create' ? t('toolCards.interaction.sessionCreated')
    : action === 'cancel' ? cancelStatus === 'no_active_turn' ? t('toolCards.interaction.noActiveRuns') : t('toolCards.interaction.stopRequested')
      : action === 'delete' ? t('toolCards.interaction.sessionDeleted')
        : action === 'rename' ? t('toolCards.interaction.renamed') : t('toolCards.interaction.list');
  const active = action === 'create' ? t('toolCards.interaction.creatingSession')
    : action === 'cancel' ? t('toolCards.interaction.stopping')
      : action === 'delete' ? t('toolCards.interaction.deleting')
        : action === 'rename' ? t('toolCards.interaction.renaming') : t('toolCards.sessionControl.listingSessions');
  const summary = interactionOutcome(status, t, completed, active);

  const fields = [
    workspace ? { label: `${t('shared:features.workspace')}:`, value: workspace } : null,
    sessionId ? { label: `${t('toolCards.sessionControl.sessionId')}:`, value: sessionId } : null,
    sessionName ? { label: `${t('toolCards.sessionControl.sessionName')}:`, value: sessionName } : null,
    agentType ? { label: `${t('toolCards.sessionControl.agentType')}:`, value: agentType } : null,
    action === 'cancel' && cancelStatus ? {
      label: `${t('toolCards.sessionControl.cancelStatus')}:`,
      value: cancelStatus === 'no_active_turn'
        ? t('toolCards.sessionControl.noActiveTurnStatus')
        : t('toolCards.sessionControl.cancelRequestedStatus'),
    } : null,
    action === 'cancel' && cancelledTurnId
      ? { label: `${t('toolCards.sessionControl.cancelledTurnId')}:`, value: cancelledTurnId }
      : null,
    action === 'cancel' && hadActiveTurn !== undefined ? {
      label: `${t('toolCards.sessionControl.hadActiveTurn')}:`,
      value: hadActiveTurn
        ? t('toolCards.sessionControl.booleanYes')
        : t('toolCards.sessionControl.booleanNo'),
    } : null,
    action === 'list'
      ? { label: `${t('toolCards.sessionControl.sessionCount')}:`, value: sessionCount }
      : null,
  ].filter((field): field is NonNullable<typeof field> => Boolean(field));

  return (
    <div ref={cardRootRef} data-openbitfun-adapter="session-control" data-tool-card-id={toolId ?? ''}>
      <SessionControlToolCardView
        status={status}
        action={actionLabels[action]}
        interaction={action !== 'list' ? {
          operation: action === 'cancel' ? 'interrupt' : action,
          source, target: { ...target, label: sessionName || target.label },
        } : undefined}
        statusLabel={action === 'list' ? statusLabel : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error) ?? statusLabel}
        isExpanded={action === 'list' && isExpanded}
        resultLabel={t('toolCards.interaction.inspectResult')}
        onToggle={action === 'list' && hasDetails
          ? () => applyExpandedState(isExpanded, !isExpanded, setIsExpanded, { onExpand })
          : undefined}
        summary={action === 'list' ? workspace || t('toolCards.sessionControl.currentWorkspace') : summary}
        resultSummary={action === 'list' && status === 'completed'
          && (typeof resultData?.count === 'number' || Array.isArray(resultData?.sessions))
          ? t('toolCards.sessionControl.resultCount', { count: sessionCount }) : undefined}
        fields={action === 'list' ? fields : undefined}
        sessions={action === 'list' ? sessions.map((item, index) => ({
          agentType: item.agent_type || '-',
          id: item.session_id || t('toolCards.sessionControl.unknownSession'),
          key: `${item.session_id ?? 'session'}-${index}`,
          name: item.session_name || t('toolCards.sessionControl.defaultSessionName'),
        })) : undefined}
        emptyState={action === 'list' && Array.isArray(resultData?.sessions) && sessions.length === 0 && status === 'completed'
          ? t('toolCards.sessionControl.noSessions')
          : undefined}
        error={toolResult?.error || (status === 'error' ? t('toolCards.default.failed') : undefined)}
      />
    </div>
  );
});
