import React, { useEffect, useState } from 'react';
import { StatusPill, Tooltip, type StatusPillTone } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import {
  type DispatchTransportStatus as DispatchTransportStatusValue,
  type DispatchTransportStatusKind,
  useDispatchTransportStatus,
} from './useDispatchTransportStatus';

const log = createLogger('DispatchTransportStatus');

/** How often "last update Xs ago" is refreshed while the target is away. */
const RELATIVE_TIME_TICK_MS = 5_000;

const TONE: Record<DispatchTransportStatusKind, StatusPillTone> = {
  stopUnconfirmed: 'danger',
  notDelivered: 'warning',
  missingOnTarget: 'danger',
  unreachable: 'warning',
  stopping: 'neutral',
  awaitingConfirmation: 'warning',
  answerSent: 'neutral',
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

async function retryStop(status: DispatchTransportStatusValue): Promise<void> {
  try {
    // The manager owns the user-cancel bookkeeping the observer relies on.
    const { FlowChatManager } = await import('@/flow_chat/services/FlowChatManager');
    await FlowChatManager.getInstance().cancelSessionTask(status.sessionId);
  } catch (error) {
    log.warn('Dispatch stop retry failed', { jobId: status.jobId, error });
  }
}

interface DispatchTransportStatusProps {
  jobId: string | undefined;
}

/**
 * Inline status of the controller's link to a dispatch target: unreachable,
 * never delivered, stop pending or unconfirmed, prompts awaiting the target.
 * Renders nothing while the link is healthy.
 */
export const DispatchTransportStatus: React.FC<DispatchTransportStatusProps> = ({ jobId }) => {
  const { t, formatRelativeTime } = useI18n('flow-chat');
  const status = useDispatchTransportStatus(jobId);
  const now = useNow(status?.kind === 'unreachable' && status.lastReachableAt !== undefined);
  if (!status) return null;

  let label: string;
  let detail: string | undefined;
  switch (status.kind) {
    case 'unreachable':
      label = status.lastReachableAt !== undefined
        ? t('chatInput.dispatch.transport.unreachableSince', {
          time: formatRelativeTime(Math.min(status.lastReachableAt, now)),
        })
        : t('chatInput.dispatch.transport.unreachable');
      detail = status.unconfirmedPermissionCount > 0
        ? t('chatInput.dispatch.transport.awaitingConfirmation', {
          count: status.unconfirmedPermissionCount,
        })
        : status.lastTransportError;
      break;
    case 'notDelivered':
      label = t('chatInput.dispatch.transport.notDelivered');
      detail = t('chatInput.dispatch.transport.notDeliveredHint');
      break;
    case 'missingOnTarget':
      label = t('chatInput.dispatch.transport.missingOnTarget');
      detail = status.lastTransportError;
      break;
    case 'stopping':
      label = t('chatInput.dispatch.transport.stopping');
      break;
    case 'stopUnconfirmed':
      label = t('chatInput.dispatch.transport.stopUnconfirmed');
      detail = t('chatInput.dispatch.transport.stopUnconfirmedHint');
      break;
    case 'awaitingConfirmation':
      label = t('chatInput.dispatch.transport.awaitingConfirmation', {
        count: status.unconfirmedPermissionCount,
      });
      break;
    case 'answerSent':
      label = t('chatInput.dispatch.transport.answerSent');
      break;
  }

  const pill = (
    <StatusPill
      className="dispatch-target-picker__transport-status"
      tone={TONE[status.kind]}
      shape="rounded"
      role="status"
      aria-live="polite"
      data-testid="dispatch-transport-status"
      data-dispatch-transport={status.kind}
    >
      {label}
    </StatusPill>
  );

  return (
    <span className="dispatch-target-picker__transport" data-openbitfun-component="dispatch-target-picker" data-openbitfun-part="transport">
      {detail ? <Tooltip content={detail} placement="top">{pill}</Tooltip> : pill}
      {status.kind === 'stopUnconfirmed' ? (
        <button
          type="button"
          className="dispatch-target-picker__transport-action"
          data-testid="dispatch-transport-retry-stop"
          onClick={() => { void retryStop(status); }}
        >
          {t('chatInput.dispatch.transport.retryStop')}
        </button>
      ) : null}
    </span>
  );
};
