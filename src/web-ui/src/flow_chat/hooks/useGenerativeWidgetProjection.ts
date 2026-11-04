import { useCallback, useRef, useSyncExternalStore } from 'react';
import { flowChatStore } from '../store/FlowChatStore';
import {
  findGenerativeWidgetProjection,
  type GenerativeWidgetOrigin,
  type GenerativeWidgetProjection,
} from '../utils/generativeWidgetProjection';

export function useGenerativeWidgetProjection(
  origin: GenerativeWidgetOrigin | undefined,
): GenerativeWidgetProjection | null {
  const key = origin
    ? JSON.stringify([origin.surfaceId, origin.sessionId, origin.turnId ?? '', origin.toolCallId ?? '', origin.toolItemId ?? ''])
    : '';
  const cacheRef = useRef<{ key: string; snapshotKey: string; snapshot: GenerativeWidgetProjection | null }>({
    key,
    snapshotKey: `${key}:empty`,
    snapshot: null,
  });
  const getSnapshot = useCallback(() => {
    if (!origin) return null;
    const next = findGenerativeWidgetProjection(flowChatStore.getState(), origin, true);
    const nextKey = next
      ? `${key}:${JSON.stringify(next.origin)}:${next.status}:${next.interactionState}:${next.deliveryMode}:${next.libraryId}:${next.isFailed}:${next.readOnly}:${next.readOnlyReason}:${next.ownerRevision}:${next.title}:${JSON.stringify(next.app ?? null)}:${JSON.stringify(next.appState ?? null)}:${JSON.stringify(next.deliveryEvidence ?? null)}`
      : `${key}:missing`;
    const cache = cacheRef.current;
    if (cache.key !== key) {
      cache.key = key;
      cache.snapshotKey = `${key}:empty`;
      cache.snapshot = null;
    }
    if (nextKey !== cache.snapshotKey) {
      cache.snapshot = next;
      cache.snapshotKey = nextKey;
    }
    return cache.snapshot;
  }, [key, origin]);
  const subscribe = useCallback(
    (callback: () => void) => origin ? flowChatStore.subscribe(() => callback()) : () => undefined,
    [origin],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}
