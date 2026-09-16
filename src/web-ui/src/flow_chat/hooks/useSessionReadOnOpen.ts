import { useEffect, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';

/** An open session is read while its scene and document are in the foreground. */
export function useSessionReadOnOpen(sessionId: string | null, isActive = true): void {
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);

  useEffect(() => {
    if (!sessionId || !isActive) return;
    let disposed = false;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      // Store notifications may arrive during a write; acknowledge after it finishes.
      queueMicrotask(() => {
        scheduled = false;
        if (disposed || !surface.isCurrent()
          || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        flowChatStore.clearSessionUnreadCompletion(sessionId);
      });
    };
    const unsubscribe = flowChatStore.subscribeSelector(
      state => state.sessions.get(sessionId)?.hasUnreadCompletion,
      schedule,
    );
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [sessionId, isActive, surface]);
}
