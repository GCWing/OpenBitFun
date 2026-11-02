import {
  MINIAPP_COMPOSER_MESSAGE_EVENT,
  type MiniAppComposerMessageDetail,
} from './miniAppStore';
import { isImageContext } from '@/shared/types/context';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';

const MINIAPP_MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;

interface PendingMiniAppMessage {
  token: string;
  resolveOnAgentRun: boolean;
  timeoutId: number;
  removeAbortListener: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

const pendingMessages = new Map<string, PendingMiniAppMessage>();
let messageSequence = 0;

function nextRequestId(): string {
  messageSequence += 1;
  return `miniapp-message-${Date.now()}-${messageSequence}`;
}

function dispatchMessage(
  detail: MiniAppComposerMessageDetail,
  requestId: string,
): void {
  window.dispatchEvent(new CustomEvent(MINIAPP_COMPOSER_MESSAGE_EVENT, {
    detail: {
      ...detail,
      requestId,
      source: detail.source ?? 'composer',
    },
  }));
}

function settlePendingMessage(
  requestId: string,
  settle: (pending: PendingMiniAppMessage) => void,
): boolean {
  const pending = pendingMessages.get(requestId);
  if (!pending) return false;
  pendingMessages.delete(requestId);
  window.clearTimeout(pending.timeoutId);
  pending.removeAbortListener();
  settle(pending);
  return true;
}

/**
 * Legacy fire-and-forget text route. Image submissions use the awaited route
 * below so preparation and admission failures can restore drafts.
 * Every dispatch gets an id for the injected SDK's replay coalescing.
 */
export function postMiniAppComposerMessage(
  detail: MiniAppComposerMessageDetail,
): string {
  const requestId = nextRequestId();
  dispatchMessage(detail, requestId);
  return requestId;
}

/**
 * Prepare attachments before delivery. Voice waits for the onUserMessage
 * callbacks; typed image input resolves on Agent acceptance, allowing Stop
 * while the MiniApp continues its post-processing. Plain typed input keeps
 * the legacy route, including older peer SDKs without acceptance receipts.
 */
export async function requestMiniAppComposerMessage(
  detail: MiniAppComposerMessageDetail,
  signal?: AbortSignal,
  options: { resolveOnAgentRun?: boolean } = {},
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('MiniApp message was cancelled before dispatch'));
  }

  const scope = getActiveSurfaceScope();
  const images = detail.contexts?.filter(isImageContext) ?? [];
  if (options.resolveOnAgentRun && !images.length && !detail.imageContexts?.length) {
    postMiniAppComposerMessage(detail);
    return;
  }
  if ((images.length || detail.imageContexts?.length) && !isLocalSurface(scope.surfaceId)) {
    const { peerConnectionManager } = await import('@/infrastructure/peer-device/PeerConnectionManager');
    scope.assertCurrent('check MiniApp image support');
    if (peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.miniAppAgentImagesV1 !== true) {
      throw new Error('miniapp_agent_images_v1_unsupported: The connected Peer host does not support MiniApp image attachments; update the executing Desktop host');
    }
  }
  if (images.length) {
    const { buildImagePayload, stripImageContextTags } = await import('@/flow_chat/utils/imagePayload');
    scope.assertCurrent('prepare MiniApp image attachments');
    const payload = await buildImagePayload(images, { requireInline: true });
    scope.assertCurrent('prepare MiniApp image attachments');
    if (signal?.aborted) throw new Error('MiniApp message was cancelled before dispatch');
    detail = {
      ...detail,
      text: stripImageContextTags(detail.text) || 'Use the attached images as context.',
      imageContexts: payload?.imageContexts,
    };
  }

  if (signal?.aborted) throw new Error('MiniApp message was cancelled before dispatch');
  const requestId = nextRequestId();
  const completion = new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      settlePendingMessage(requestId, pending => {
        pending.reject(new Error('MiniApp message was cancelled'));
      });
    };
    const timeoutId = window.setTimeout(() => {
      settlePendingMessage(requestId, pending => {
        pending.reject(new Error('MiniApp message timed out after 30 minutes'));
      });
    }, MINIAPP_MESSAGE_TIMEOUT_MS);
    signal?.addEventListener('abort', handleAbort, { once: true });
    pendingMessages.set(requestId, {
      token: detail.token,
      resolveOnAgentRun: options.resolveOnAgentRun === true,
      timeoutId,
      removeAbortListener: () => signal?.removeEventListener('abort', handleAbort),
      resolve,
      reject,
    });
  });

  dispatchMessage(detail, requestId);
  return completion;
}

/** Typed composers unlock Stop once the Runtime accepts the turn; voice waits for completion. */
export function acceptMiniAppComposerMessage(token: string, requestId: string): boolean {
  const pending = pendingMessages.get(requestId);
  if (pending?.token !== token || !pending.resolveOnAgentRun) return false;
  return settlePendingMessage(requestId, entry => entry.resolve());
}

/** Called only by the bridge instance that owns `token`. */
export function completeMiniAppComposerMessage(
  token: string,
  requestId: string,
  error?: string,
): boolean {
  const pending = pendingMessages.get(requestId);
  if (!pending || pending.token !== token) return false;
  return settlePendingMessage(requestId, entry => {
    if (error?.trim()) entry.reject(new Error(error.trim()));
    else entry.resolve();
  });
}

/** Fail pending voice work promptly when its owning iframe goes away. */
export function rejectPendingMiniAppComposerMessages(
  token: string,
  reason: string,
): void {
  for (const [requestId, pending] of pendingMessages) {
    if (pending.token !== token) continue;
    settlePendingMessage(requestId, entry => entry.reject(new Error(reason)));
  }
}
