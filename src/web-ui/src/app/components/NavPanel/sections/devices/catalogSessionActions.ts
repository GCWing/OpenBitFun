import type { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import type { BackgroundActions } from './BackgroundSessionList';
import type { SidebarDeviceSlot } from './useSidebarDevices';
import { runDeviceSessionAction, type DeviceSessionAction } from './openOnDevice';

/** Intent key of a catalog session action; the row shows progress while it runs. */
export const catalogSessionActionKey = (sessionId: string, kind: string) => `session-action:${sessionId}:${kind}`;

const FAILURE_KEYS: Partial<Record<DeviceSessionAction['kind'], string>> = {
  duplicate: 'nav.sessions.duplicateFailed',
  'open-worktree': 'nav.sessions.openWorktreeWorkspaceFailed',
  'reveal-storage': 'nav.sessions.openStorageDirectoryFailed',
};

export function runCatalogSessionAction(
  actions: BackgroundActions,
  peer: ReturnType<typeof usePeerDeviceModeOptional>,
  slot: SidebarDeviceSlot,
  sessionId: string,
  action: DeviceSessionAction,
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  actions.run(
    catalogSessionActionKey(sessionId, action.kind),
    () => runDeviceSessionAction(peer, slot, sessionId, action, t),
    FAILURE_KEYS[action.kind] ?? 'nav.devices.sessionActionFailed',
  );
}
