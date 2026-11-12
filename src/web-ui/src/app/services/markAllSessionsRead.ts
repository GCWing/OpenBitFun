import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';

/**
 * Mark every session read: the rendered device's sessions locally, and every
 * other loaded device's sessions on their own hosts.
 */
export function markAllSessionsRead(): void {
  flowChatStore.clearAllSessionUnreadCompletions();
  const rendered = getActiveSurfaceId();
  for (const surfaceId of deviceWorkspaceCatalog.loadedSurfaces()) {
    if (surfaceId !== rendered) void deviceWorkspaceCatalog.markAllRead(surfaceId);
  }
}
