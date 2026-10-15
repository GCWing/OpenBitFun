import { create } from 'zustand';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { remoteConnectAPI, deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { InvalidationSync } from '../../../../shared/relay-transport/InvalidationSync';

/** Presentation only: presence and saved peer/dispatch names never overwrite GET metadata. */
export const useDeviceDirectory = create<{
  devices: AccountDeviceInfo[];
  localId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
}>(() => ({ devices: [], localId: null, status: 'idle' }));
let invalidate: (() => Promise<void>) | undefined;
let generation = 0;

/**
 * Alias resolution from a snapshot the caller already subscribed to.
 *
 * A memo body must use this form and list `useDeviceDirectory()` in its
 * dependencies: an imperative store read is invisible to the dependency rules,
 * so a memo that only calls `resolveDeviceName` keeps rendering a stale alias.
 */
export function resolveDeviceNameFrom(devices: AccountDeviceInfo[], deviceId: string, fallback = deviceId): string {
  const device = devices.find(item => item.device_id === deviceId);
  return device ? deviceDisplayName(device) : fallback;
}

/** Resolve from the live store, for code outside React's render data flow. */
export function resolveDeviceName(deviceId: string, fallback = deviceId): string {
  return resolveDeviceNameFrom(useDeviceDirectory.getState().devices, deviceId, fallback);
}

/**
 * The single gate every mutual-control entry point must reuse.
 *
 * The Relay computes `compatible` from *both* clients' reported build/protocol.
 * It returns `false` for a version mismatch and also for a peer that reported
 * no version information at all (an older client), so a `false` flag always
 * means "this peer is not mutually controllable" regardless of the reason.
 *
 * `compatible` is absent only on an older Relay that does not gate at all; that
 * is "unknown but usable" and must never block control.
 */
export function isDeviceControllable(device: Pick<AccountDeviceInfo, 'compatible'>): boolean {
  return device.compatible !== false;
}

/** Peer client build string for an incompatible device, when the Relay supplied one. */
export function deviceClientVersion(
  device: Pick<AccountDeviceInfo, 'device_client_version' | 'client_version'>,
): string | null {
  const version = (device.device_client_version ?? device.client_version)?.trim();
  return version ? version : null;
}

export function refreshDeviceDirectory(): Promise<void> {
  return invalidate?.() ?? Promise.resolve();
}

/** Mounted by the shell provider, fenced on account replacement and teardown. */
export function startDeviceDirectory(): () => void {
  const epoch = ++generation;
  useDeviceDirectory.setState({ devices: [], localId: null, status: 'loading' });
  const sync = new InvalidationSync(async () => {
    if (epoch === generation && useDeviceDirectory.getState().localId === null) {
      useDeviceDirectory.setState({ status: 'loading' });
    }
    try {
      const [devices, local] = await Promise.all([remoteConnectAPI.accountListDevices(), remoteConnectAPI.getDeviceInfo()]);
      if (epoch === generation) useDeviceDirectory.setState({ devices, localId: local.device_id, status: 'ready' });
    } catch {
      // An unavailable directory is not evidence that a device or alias was removed.
      if (epoch === generation) useDeviceDirectory.setState({ status: 'failed' });
    }
  });
  const refresh = () => sync.invalidate();
  invalidate = refresh;
  const stopPresence = api.listen('account://device-presence', () => { void refresh(); });
  const stopLogin = api.listen('account://login-state', () => { void refresh(); });
  const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
  document.addEventListener('visibilitychange', visible);
  const timer = setInterval(visible, 30_000);
  void refresh();
  return () => {
    sync.stop(); stopPresence(); stopLogin(); clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
    if (epoch === generation) {
      generation += 1;
      invalidate = undefined;
      useDeviceDirectory.setState({ devices: [], localId: null, status: 'idle' });
    }
  };
}
