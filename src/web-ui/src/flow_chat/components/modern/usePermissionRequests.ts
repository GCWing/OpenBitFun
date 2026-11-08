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
  ensureActivePermissionMailbox,
  liveSessionInteractionStore,
} from '../../services/liveSessionInteractionStore';

const EMPTY_EXTERNAL_REQUESTS: PermissionRequest[] = [];
const noopSubscribe = () => () => {};
const emptyExternalSnapshot = () => EMPTY_EXTERNAL_REQUESTS;

// Fine-grained, zero-argument snapshot projections of the live mailbox.
// `useSyncExternalStore` calls `getSnapshot` with no arguments and compares the
// result with `Object.is`, so each derivation must return the store's own
// already-immutable slice (no in-place mutation, no local identity caching that
// could swallow a nested mutation). Returning the field directly means the
// `Object.is` bail-out happens per slice, so churn in unrelated snapshot fields
// (pending replies, transport state, other mailboxes) no longer re-renders the
// consumers of this hook.
const getLiveSurfaceId = (): string | undefined =>
  liveSessionInteractionStore.getActiveSnapshot().surfaceId;

const getLiveRequests = (): PermissionRequest[] =>
  liveSessionInteractionStore.getActiveSnapshot().requests;

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

  // Two independent, fine-grained subscriptions replace the previous coarse
  // whole-snapshot subscription. Each getter is a proper zero-argument
  // `getSnapshot` that returns the store's own slice, so React bails out with
  // `Object.is` unless that specific slice changed. The subscription itself is
  // the store's own stable `subscribe` (module-level wrapper is unnecessary).
  const liveSurfaceId = useSyncExternalStore(
    liveSessionInteractionStore.subscribe,
    getLiveSurfaceId,
    getLiveSurfaceId,
  );

  const liveRequests = useSyncExternalStore(
    liveSessionInteractionStore.subscribe,
    getLiveRequests,
    getLiveRequests,
  );

  useEffect(() => {
    if (isLiveSource) void ensureActivePermissionMailbox();
  }, [isLiveSource, liveSurfaceId]);

  const respond = useCallback(
    async (requestId: string, reply: PermissionReplyKind, feedback?: string) => {
      await driver.respondPermission(sessionId ?? '', requestId, reply, feedback);
      if (isLiveSource) {
        liveSessionInteractionStore.markPermissionResolved(liveSurfaceId, requestId);
      }
    },
    [driver, sessionId, isLiveSource, liveSurfaceId],
  );

  const respondBatch = useCallback(
    async (requestId: string, reply: PermissionReplyKind, feedback?: string) => {
      const resolvedRequestIds = await driver.respondPermissionBatch(
        sessionId ?? '',
        requestId,
        reply,
        feedback,
      );
      if (isLiveSource) {
        resolvedRequestIds.forEach((requestId) => {
          liveSessionInteractionStore.markPermissionResolved(liveSurfaceId, requestId);
        });
      }
    },
    [driver, sessionId, isLiveSource, liveSurfaceId],
  );

  const effectiveRequests = isLiveSource ? liveRequests : externalRequests;
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
