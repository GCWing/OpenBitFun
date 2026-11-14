import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  type PermissionReplyKind,
  type PermissionRequest,
} from '@/infrastructure/api/service-api/AgentAPI';
import {
  selectActivePermissionBatch,
  selectActivePermissionBatchOwnedBySession,
  selectPermissionRequestsForSession,
  selectPermissionRequestsOwnedBySession,
} from './permissionRequestRouting';
import { FlowChatStore } from '../../store/FlowChatStore';
import { driverForSession } from '../../session-drivers/registry';
import {
  confirmPermissionsStillPending,
  ensureActivePermissionMailbox,
  liveSessionInteractionStore,
} from '../../services/liveSessionInteractionStore';
import {
  needsInteractionAnswerReadback,
  settledInteractionAnswerOutcome,
  type InteractionAnswerOutcome,
} from '../../utils/interactionAnswerOutcome';

export interface PermissionAnswerHooks {
  /** The reply was lost or refused as settled; the host mailbox is being read. */
  onConfirming?: () => void;
}

/**
 * A lost reply may hide an accepted answer, and a retry of a settled request
 * can never succeed. Read the host's pending requests: an answer is complete
 * once none of its requests are pending; otherwise the original error stands.
 * A refusal of a settled request means this answer was not delivered, which
 * the caller must not present as submitted.
 */
async function confirmAfterFailedAnswer(
  error: unknown,
  requestIds: readonly string[],
  hooks: PermissionAnswerHooks | undefined,
): Promise<Exclude<InteractionAnswerOutcome, 'accepted'>> {
  if (!needsInteractionAnswerReadback(error)) throw error;
  hooks?.onConfirming?.();
  const stillPending = await confirmPermissionsStillPending(requestIds);
  if (stillPending.length > 0) throw error;
  return settledInteractionAnswerOutcome(error);
}

const EMPTY_EXTERNAL_REQUESTS: PermissionRequest[] = [];
const noopSubscribe = () => () => {};
const emptyExternalSnapshot = () => EMPTY_EXTERNAL_REQUESTS;

export function usePermissionRequests(sessionId?: string) {
  // Driver resolution is per-render: the caller re-renders on any session
  // change, so a projection whose dispatch config binds late is picked up.
  const session = sessionId
    ? FlowChatStore.getInstance().getState().sessions.get(sessionId)
    : undefined;
  const driver = driverForSession(sessionId ?? '', session);
  const source = useMemo(
    () => driver.permissionRequestSource(sessionId ?? ''),
    [driver, sessionId],
  );
  const isLiveSource = source === 'live';

  const externalRequests = useSyncExternalStore(
    isLiveSource ? noopSubscribe : source.subscribe,
    isLiveSource ? emptyExternalSnapshot : source.getSnapshot,
  ) as unknown as PermissionRequest[];

  const liveMailbox = useSyncExternalStore(
    liveSessionInteractionStore.subscribe,
    liveSessionInteractionStore.getActiveSnapshot,
    liveSessionInteractionStore.getActiveSnapshot,
  );

  useEffect(() => {
    if (isLiveSource) void ensureActivePermissionMailbox();
  }, [isLiveSource, liveMailbox.surfaceId]);

  const respond = useCallback(
    async (
      requestId: string,
      reply: PermissionReplyKind,
      feedback?: string,
      hooks?: PermissionAnswerHooks,
    ): Promise<InteractionAnswerOutcome> => {
      try {
        await driver.respondPermission(sessionId ?? '', requestId, reply, feedback);
      } catch (error) {
        if (!isLiveSource) throw error;
        return confirmAfterFailedAnswer(error, [requestId], hooks);
      }
      if (isLiveSource) {
        liveSessionInteractionStore.markPermissionResolved(liveMailbox.surfaceId, requestId);
      }
      return 'accepted';
    },
    [driver, sessionId, isLiveSource, liveMailbox.surfaceId],
  );

  const respondBatch = useCallback(
    async (
      requestId: string,
      reply: PermissionReplyKind,
      feedback?: string,
      hooks?: PermissionAnswerHooks,
    ): Promise<InteractionAnswerOutcome> => {
      // Captured before answering: a lost reply leaves no resolved id list.
      const batchIds = new Set([requestId, ...(isLiveSource
        ? selectActivePermissionBatch(liveMailbox.requests, sessionId)?.requests
          .map(request => request.requestId) ?? []
        : [])]);
      let resolvedRequestIds: string[];
      try {
        resolvedRequestIds = await driver.respondPermissionBatch(
          sessionId ?? '',
          requestId,
          reply,
          feedback,
        );
      } catch (error) {
        if (!isLiveSource) throw error;
        return confirmAfterFailedAnswer(error, [...batchIds], hooks);
      }
      if (isLiveSource) {
        resolvedRequestIds.forEach((requestId) => {
          liveSessionInteractionStore.markPermissionResolved(
            liveMailbox.surfaceId,
            requestId,
          );
        });
      }
      return 'accepted';
    },
    [driver, sessionId, isLiveSource, liveMailbox.surfaceId, liveMailbox.requests],
  );

  const effectiveRequests = isLiveSource ? liveMailbox.requests : externalRequests;
  const sessionRequests = useMemo(
    () => selectPermissionRequestsForSession(effectiveRequests, sessionId),
    [effectiveRequests, sessionId],
  );

  const activeBatch = useMemo(
    () => selectActivePermissionBatch(effectiveRequests, sessionId),
    [effectiveRequests, sessionId],
  );
  const ownedRequests = useMemo(
    () => selectPermissionRequestsOwnedBySession(effectiveRequests, sessionId),
    [effectiveRequests, sessionId],
  );
  const ownedActiveBatch = useMemo(
    () => selectActivePermissionBatchOwnedBySession(effectiveRequests, sessionId),
    [effectiveRequests, sessionId],
  );

  // Keep the broad projection for transcript/task-card state, while exposing
  // the owner-only projection for permission UI so one request has one
  // actionable surface.
  return {
    requests: sessionRequests,
    activeBatch,
    ownedRequests,
    ownedActiveBatch,
    respond,
    respondBatch,
  };
}
