import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceId, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { sessionPaneLayoutStore } from './sessionPaneLayoutStore';

/** Activate the view identity after the session/device owners commit their selection. */
export function startSessionPaneLayoutSync(): () => void {
  const sync = () => sessionPaneLayoutStore.getState().activate(
    getActiveSurfaceId(), flowChatStore.getState().activeSessionId,
  );
  sync();
  const stopSessions = flowChatStore.subscribe(sync);
  const stopSurfaces = onSurfaceActivated(sync);
  return () => { stopSessions(); stopSurfaces(); };
}
