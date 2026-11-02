import type { HostDialogQueue, QueueSnapshot } from '../../../../shared/dialog-queue/HostDialogQueue';
import { isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '../../shared/notification-system';

const log = createLogger('HostQueueSubmission');

/** The host's receipt, rather than the controller's busy state, owns send-now. */
export async function promoteAcceptedHostMessage(queue: HostDialogQueue, accepted: QueueSnapshot): Promise<void> {
  if (accepted.receipt?.status !== 'queued') return;
  try {
    await queue.act(accepted.receipt, 'promote');
  } catch (error) {
    if (isSurfaceChangedError(error)) throw error;
    // Submission was acknowledged already. The host queue retains the message
    // and any unresolved promotion for its recovery UI. Do not invite a second
    // submission when only delivery into the running turn is unconfirmed.
    log.warn('Accepted message could not be promoted', { sessionId: queue.sessionId, error });
    notificationService.error(i18nService.t('flow-chat:pendingQueue.errors.sendNowFailed'), { duration: 4000 });
  }
}
