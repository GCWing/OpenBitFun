import { useCallback, useSyncExternalStore } from 'react';
import type { RemoteSessionManager } from '../services/RemoteSessionManager';

/** Re-render when the control target's capability snapshot or probe changes. */
export function useHostCapabilityRevision(sessionMgr: RemoteSessionManager): number {
  const subscribe = useCallback(
    (listener: () => void) => sessionMgr.onHostCapabilitiesChange(listener),
    [sessionMgr],
  );
  const read = useCallback(() => sessionMgr.hostCapabilityRevision, [sessionMgr]);
  return useSyncExternalStore(subscribe, read, read);
}
