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
  const cacheRef = useRef<{ key: string; session: unknown; turn: unknown; snapshot: GenerativeWidgetProjection | null }>({
    key,
    session: undefined,
    turn: undefined,
    snapshot: null,
  });
  const getSnapshot = useCallback(() => {
    if (!origin) return null;
    const state = flowChatStore.getState();
    const session = state.sessions.get(origin.sessionId);
    const turn = origin.turnId ? session?.dialogTurns.find(value => value.id === origin.turnId) : undefined;
    const cache = cacheRef.current;
    if (cache.key !== key) {
      cache.key = key;
      cache.session = undefined;
      cache.turn = undefined;
      cache.snapshot = null;
    }
    if (cache.session !== session || cache.turn !== turn) {
      cache.session = session;
      cache.turn = turn;
      cache.snapshot = findGenerativeWidgetProjection(state, origin, true);
    }
    return cache.snapshot;
  }, [key, origin]);
  const subscribe = useCallback(
    (callback: () => void) => origin ? flowChatStore.subscribeSelector(
      state => {
        const session = state.sessions.get(origin.sessionId);
        const turn = origin.turnId ? session?.dialogTurns.find(value => value.id === origin.turnId) : undefined;
        return { session, turn };
      },
      () => callback(),
      { isEqual: (a, b) => a.session === b.session && a.turn === b.turn },
    ) : () => undefined,
    [origin?.sessionId, origin?.turnId],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}
