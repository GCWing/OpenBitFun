import type { AgenticEvent } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '@/flow_chat/types/flow-chat';
import { readBackgroundDelivery, shouldDeliverBackgroundCompletion } from '@/flow_chat/utils/backgroundDelivery';

interface DialogCompletionNotificationInput {
  event: AgenticEvent;
  session?: Pick<Session, 'sessionKind' | 'parentSessionId'> & Partial<Pick<Session, 'dialogTurns'>> | null;
  isBackground: boolean;
  notificationsEnabled?: boolean;
}

interface DialogCompletionNotificationCopyInput {
  sessionTitle?: string | null;
  success?: boolean | null;
  finishReason?: string | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function shouldSendDialogCompletionNotification({
  event,
  session,
  isBackground,
  notificationsEnabled,
}: DialogCompletionNotificationInput): boolean {
  if (!isBackground || notificationsEnabled === false) {
    return false;
  }
  if (!shouldDeliverBackgroundCompletion(event)) return false;

  if (!session) {
    return false;
  }

  const turn = session.dialogTurns?.find(turn => turn.id === (event.turnId ?? event.turn_id));
  const delivery = readBackgroundDelivery(event.backgroundDelivery ?? event.background_delivery, turn?.id ?? '');
  if (delivery && (delivery.executionGeneration ?? 0) < (turn?.recovery?.executionGeneration ?? turn?.recoveryEpoch ?? 0)) return false;
  const sessionKind = session?.sessionKind ?? 'normal';
  if (sessionKind === 'btw' || sessionKind === 'review' || sessionKind === 'subagent') {
    return false;
  }

  return true;
}

export function buildDialogCompletionNotificationCopy({
  sessionTitle,
  success,
  finishReason,
  t,
}: DialogCompletionNotificationCopyInput): { title: string; body: string } {
  const trimmedTitle = sessionTitle?.trim();
  const failed = success === false;
  const options = {
    sessionTitle: trimmedTitle,
    finishReason,
  };

  return {
    title: failed
      ? t('notify.dialogFailedTitle')
      : t('notify.dialogCompletedTitle'),
    body: trimmedTitle
      ? t(failed ? 'notify.dialogFailedWithSession' : 'notify.dialogCompletedWithSession', options)
      : t(failed ? 'notify.dialogFailedFallback' : 'notify.dialogCompletedFallback', options),
  };
}
