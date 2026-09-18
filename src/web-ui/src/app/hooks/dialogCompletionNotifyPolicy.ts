import type { AgenticEvent } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '@/flow_chat/types/flow-chat';

interface DialogCompletionNotificationInput {
  event: AgenticEvent;
  session?: Pick<Session, 'sessionKind' | 'parentSessionId'> | null;
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
  event: _event,
  session,
  isBackground,
  notificationsEnabled,
}: DialogCompletionNotificationInput): boolean {
  if (!isBackground || notificationsEnabled === false) {
    return false;
  }

  if (!session) {
    return false;
  }

  const sessionKind = session?.sessionKind ?? 'normal';
  if (sessionKind === 'btw' || sessionKind === 'review' || sessionKind === 'subagent') {
    return false;
  }

  // MiniApp headless agent runs (including the builtin LoopX driver) are
  // unattended by design: every turn completes quietly and the next one is
  // scheduled by the host. A completion toast per turn would train the owner
  // to ignore notifications. Human attention is requested only at owner
  // decision points, which the MiniApp surface itself raises through the
  // host notification bridge when a user gate appears.
  if (sessionKind === 'miniapp') {
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
