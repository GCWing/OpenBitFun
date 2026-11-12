import { HostDialogQueue, newQueueTurnId, type QueueAttachment } from '../../../../shared/dialog-queue/HostDialogQueue';
export { newQueueTurnId };
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { accountIdentityService } from '@/infrastructure/account-identity/AccountIdentityService';
import { FlowChatStore } from '../store/FlowChatStore';
import { isAcpFlowSession } from '../utils/acpSession';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { translateAgentIdentityFields } from '../../../../shared/agent-harness/wire';
import { registerSubmittedMessageScrollIntent, finishSubmittedMessageScrollIntent, peekSubmittedMessageScrollIntent } from './submittedMessageScrollIntent';
import { getSubmittedMessagePreviews } from './submittedMessagePresentation';

const clients = new Map<string, HostDialogQueue>();
function currentAccount(): string {
  const user = accountIdentityService.getSnapshot().me?.user;
  return String(user?.accountId || user?.githubId || 'local');
}
export function hostQueueSupported(sessionId: string): boolean {
  const session = FlowChatStore.getInstance().getState().sessions.get(sessionId);
  if (!session || isAcpFlowSession(session) || resolveSessionDriverId(sessionId, session) !== 'local') return false;
  const scope = getActiveSurfaceScope();
  return isLocalSurface(scope.surfaceId)
    || peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.dialogQueueV1 === true;
}
export function hostDialogQueue(sessionId: string): HostDialogQueue {
  const scope = getActiveSurfaceScope();
  const account = currentAccount();
  const owner = JSON.stringify([account, scope.surfaceId, sessionId]);
  const key = JSON.stringify([owner, scope.epoch]);
  let client = clients.get(key);
  if (!client) {
    client = new HostDialogQueue(owner, sessionId, async request => {
      scope.assertCurrent('send queue operation');
      if (currentAccount() !== account) throw new Error('Queue account changed');
      // The queue has now selected the actual idempotent Turn id. Register
      // before invoking, since DialogTurnStarted can beat the RPC receipt.
      const intent = request.action === 'submit'
        ? peekSubmittedMessageScrollIntent(scope, sessionId, request.message.turnId)
          ?? (getSubmittedMessagePreviews(scope, sessionId).length > 0
            ? undefined
            : registerSubmittedMessageScrollIntent(scope, sessionId, request.message.turnId, null))
        : undefined;
      try {
        const result = await api.invoke<import('../../../../shared/dialog-queue/HostDialogQueue').QueueSnapshot>(
          'manage_dialog_queue', { request: translateAgentIdentityFields(request, 'legacy') });
        scope.assertCurrent('apply queue operation');
        if (currentAccount() !== account) throw new Error('Queue account changed');
        // Parking/steering work is not a new transcript placement. Later queue
        // drain or outbox replay must not resurrect this old send gesture.
        if (intent && result.receipt?.status !== 'started') finishSubmittedMessageScrollIntent(intent);
        return result;
      } catch (error) {
        if (intent) finishSubmittedMessageScrollIntent(intent);
        throw error;
      }
    });
    clients.set(key, client);
  }
  return client;
}
export function queueImageAttachments(images?: unknown[]): QueueAttachment[] {
  return (images ?? []).map(value => {
    const image = value as { id: string; data_url?: string; image_path?: string; mime_type?: string; metadata?: unknown };
    return { kind: 'remote_image', id: image.id, metadata: {
      ...(image.data_url ? { dataUrl: image.data_url } : {}),
      ...(image.image_path ? { imagePath: image.image_path } : {}),
      mimeType: image.mime_type, metadata: image.metadata,
    } };
  });
}

/**
 * The host refused a queue mutation because the session is not loaded there
 * and it could not (or, on an older host, would not) load it. The refusal comes
 * before any receipt exists: nothing was accepted, and nothing of this session
 * is executing on that host.
 */
export function isHostSessionNotLoadedRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.includes('Session is not loaded on the execution host');
}

/**
 * Drop the local outbox copy of a fresh submission the host refused outright.
 * Only for a caller that still holds the complete draft and resends it.
 */
export async function discardRefusedHostSubmission(
  queue: HostDialogQueue,
  message: Parameters<HostDialogQueue['submit']>[0],
  turnId: string,
): Promise<void> {
  // An identical unresolved record is what the queue retried instead of this
  // Turn ID; the same refusal proves the host never accepted it either.
  const saved = queue.pendingSubmission(message) ?? await queue.savedDraft(turnId);
  if (saved) await queue.dismiss(saved);
}
