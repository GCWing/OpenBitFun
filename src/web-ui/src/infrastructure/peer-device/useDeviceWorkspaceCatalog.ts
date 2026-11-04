import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { DeviceSurfaceId } from './deviceSurface';
import {
  deviceWorkspaceCatalog,
  type DeviceCatalogSessions,
  type DeviceCatalogSnapshot,
} from './deviceWorkspaceCatalog';

function useCatalogSubscription(surfaceId: DeviceSurfaceId) {
  return useCallback((notify: () => void) => deviceWorkspaceCatalog.subscribe(changed => {
    if (changed === surfaceId) notify();
  }), [surfaceId]);
}

/** Read a device catalog; it is loaded only while `enabled` (the section is open). */
export function useDeviceWorkspaceCatalog(surfaceId: DeviceSurfaceId, enabled: boolean): DeviceCatalogSnapshot {
  useEffect(() => (enabled ? deviceWorkspaceCatalog.retain(surfaceId) : undefined), [surfaceId, enabled]);
  const subscribe = useCatalogSubscription(surfaceId);
  const read = useCallback(() => deviceWorkspaceCatalog.getSnapshot(surfaceId), [surfaceId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Sessions of one catalog workspace, read only while it is expanded. */
export function useDeviceCatalogSessions(
  surfaceId: DeviceSurfaceId,
  workspaceId: string,
  enabled: boolean,
): DeviceCatalogSessions {
  useEffect(
    () => (enabled ? deviceWorkspaceCatalog.retainSessions(surfaceId, workspaceId) : undefined),
    [surfaceId, workspaceId, enabled],
  );
  const subscribe = useCatalogSubscription(surfaceId);
  const read = useCallback(
    () => deviceWorkspaceCatalog.getSessions(surfaceId, workspaceId),
    [surfaceId, workspaceId],
  );
  return useSyncExternalStore(subscribe, read, read);
}
