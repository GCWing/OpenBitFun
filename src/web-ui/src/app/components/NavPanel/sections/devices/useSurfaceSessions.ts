import { useCallback, useSyncExternalStore } from 'react';
import { getActiveSurfaceId, onSurfaceActivated, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';

/** A surface's sessions; re-renders on seeding and on rendered-surface updates. */
export function useSurfaceSessions(surfaceId: DeviceSurfaceId): ReadonlyMap<string, Session> {
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribeSurface = flowChatStore.subscribeSurfaceSessions(changed => { if (changed === surfaceId) notify(); });
    // Rendered-surface updates (streaming included) matter only while this
    // device is the rendered one; selectors keep other devices quiet.
    const unsubscribeActive = flowChatStore.subscribe(() => { if (getActiveSurfaceId() === surfaceId) notify(); });
    const unsubscribeActivation = onSurfaceActivated(notify);
    return () => { unsubscribeSurface(); unsubscribeActive(); unsubscribeActivation(); };
  }, [surfaceId]);
  const read = useCallback(() => flowChatStore.getSurfaceSessions(surfaceId), [surfaceId]);
  return useSyncExternalStore(subscribe, read, read);
}
