import { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import type { DialogTurn } from '../../types/flow-chat';
import { UserMessageItem } from './UserMessageItem';
import { ModelRoundItem } from './ModelRoundItem';
import { backgroundDeliveryFromMetadata } from '../../utils/backgroundDelivery';
import './BackgroundRunItem.scss';

/** A delivery receipt is presentation only; expanding it reads the original execution. */
export function BackgroundRunItem({ turn, absoluteTurnIndex, forceOpen = false, expandedThinkingItemIds = [] }: {
  turn: DialogTurn; absoluteTurnIndex?: number; forceOpen?: boolean; expandedThinkingItemIds?: string[];
}) {
  const { t, formatNumber } = useI18n('flow-chat');
  const delivery = backgroundDeliveryFromMetadata(turn.userMessage.metadata, turn.id);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const completed = ['completed', 'finishing'].includes(turn.status);
  return (
    <details className="background-run" open={open}
      data-openbitfun-component="background-run" data-openbitfun-part="root"
      onToggle={event => setOpen(event.currentTarget.open)}>
      <summary data-openbitfun-component="background-run" data-openbitfun-part="summary">
        <span>{t(completed ? 'backgroundDelivery.quiet' : 'backgroundDelivery.running')}</span>
        <span className="background-run__action">{t('backgroundDelivery.executionDetails')}</span>
      </summary>
      {open ? (
        <div data-openbitfun-component="background-run" data-openbitfun-part="details">
          {delivery?.decisionUsage ? <p>{t('backgroundDelivery.adjudicationUsage', { tokens: formatNumber(delivery.decisionUsage.totalTokens) })}</p> : null}
          <UserMessageItem message={turn.userMessage} turnId={turn.id} absoluteTurnIndex={absoluteTurnIndex} turnStatus={turn.status} />
          {turn.modelRounds.map((round, index) => <ModelRoundItem key={round.id} round={round} turnId={turn.id}
            expandedThinkingItemIds={expandedThinkingItemIds} isLastRound={index === turn.modelRounds.length - 1} isTurnComplete={completed}
            turnStartedAt={turn.startTime} turnEndedAt={turn.endTime} turnTokenUsage={turn.tokenUsage} />)}
        </div>
      ) : null}
    </details>
  );
}
