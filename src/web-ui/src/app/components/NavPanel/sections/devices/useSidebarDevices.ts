import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { applyDeviceOrder, useDeviceOrderPreferences } from '@/app/navigation/deviceOrderPreferences';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useDeviceDirectory, isDeviceControllable, resolveDeviceNameFrom } from '@/infrastructure/account/deviceDirectory';
import { getActiveSurfaceId, LOCAL_SURFACE_ID, onSurfaceActivated, surfaceIdForDevice, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { reportedHostKind, type DeviceOverviewHostKind } from '../../deviceInterconnectionOverview';

/** One device in the sidebar session list. */
export interface SidebarDeviceSlot {
  surfaceId: DeviceSurfaceId;
  /** Account device id; null only while the local id is not known yet. */
  deviceId: string | null;
  name: string;
  isLocal: boolean;
  /** The window renders this device; its slot uses the live workspace list. */
  rendered: boolean;
  hostKind: DeviceOverviewHostKind | null;
  /** Reported operating system, when known. */
  os: string | null;
  /** Relay-confirmed mutual control; this machine is never gated by its own flag. */
  controllable: boolean;
  /**
   * Weak-link state of this device's control link or presence, for any
   * section, rendered or not: `reconnecting` while the attachment is degraded
   * or the device briefly left presence, `starting` while its host UI starts.
   */
  linkState?: SidebarDeviceLinkState | null;
}

export type SidebarDeviceLinkState = 'reconnecting' | 'starting';

/**
 * How long a device that left presence keeps its section, counted from when
 * it was first seen offline. A relay or routing reconnect briefly reports an
 * empty roster; dropping and re-adding every section then makes the whole
 * list jump.
 */
export const SIDEBAR_PRESENCE_GAP_GRACE_MS = 15_000;

/** Devices reported online since they last left presence, window-wide. */
const seenOnline = new Set<string>();
/** When each of those devices was first seen offline, window-wide. */
const offlineSince = new Map<string, number>();

/** Tests only. */
export function resetSidebarPresenceGapsForTest(): void {
  seenOnline.clear();
  offlineSince.clear();
}

interface PresenceGaps {
  /** Devices offline for less than the grace period. */
  ids: ReadonlySet<string>;
  /** When the earliest gap expires, or null. */
  nextExpiry: number | null;
}

function presenceGaps(devices: ReadonlyArray<{ device_id: string; online?: boolean }>, now: number): PresenceGaps {
  const ids = new Set<string>();
  let nextExpiry: number | null = null;
  for (const device of devices) {
    if (device.online) {
      seenOnline.add(device.device_id);
      offlineSince.delete(device.device_id);
      continue;
    }
    if (!seenOnline.has(device.device_id)) continue;
    // The grace starts when the device drops, not at the last roster that
    // happened to list it online: that one may be much older.
    let since = offlineSince.get(device.device_id);
    if (since === undefined) {
      since = now;
      offlineSince.set(device.device_id, since);
    }
    const expiry = since + SIDEBAR_PRESENCE_GAP_GRACE_MS;
    if (expiry <= now) {
      seenOnline.delete(device.device_id);
      offlineSince.delete(device.device_id);
      continue;
    }
    ids.add(device.device_id);
    nextExpiry = nextExpiry === null ? expiry : Math.min(nextExpiry, expiry);
  }
  return { ids, nextExpiry };
}

function linkStateOf(attachment: { health: string; hostStarting?: boolean } | undefined, presenceGap: boolean): SidebarDeviceLinkState | null {
  if (attachment?.health === 'degraded' || presenceGap) return 'reconnecting';
  if (attachment?.hostStarting) return 'starting';
  return null;
}

export type DevicePlatform = 'mac' | 'windows' | 'linux';

/** Platform of a reported OS string ("macOS 15", "Windows 11", user agent, ...). */
export function devicePlatform(os: string | null | undefined): DevicePlatform | null {
  const value = os?.toLowerCase() ?? '';
  if (/mac|darwin/.test(value)) return 'mac';
  if (/win/.test(value)) return 'windows';
  if (/linux|ubuntu|debian|fedora|arch|centos/.test(value)) return 'linux';
  return null;
}

/** Devices that report a controller kind have no workspaces to list. */
const CONTROLLER_KINDS = new Set(['mobile', 'watch']);

/**
 * The controller's saved order, falling back to this machine then online hosts
 * by name for devices the user has not arranged. The order never depends on which device is rendered,
 * so opening something on another device does not move any section.
 *
 * Returns a single slot when there is nothing else to show, so a signed-out or
 * single-device window renders exactly the plain workspace list.
 */
export function useSidebarDevices(localLabel: string): SidebarDeviceSlot[] {
  const directory = useDeviceDirectory();
  const deviceOrder = useDeviceOrderPreferences(state => state.order);
  const peer = usePeerDeviceModeOptional();
  const activeSurfaceId = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceId, getActiveSurfaceId);
  const renderedPeer = peer?.peerMode.active ? peer.peerMode : null;
  const attachments = peer?.attachments;
  const [gapClock, setGapClock] = useState(0);
  const gaps = useMemo(
    () => presenceGaps(directory.devices, Date.now()),
    // `gapClock` re-evaluates expiring gaps without a roster change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [directory.devices, gapClock],
  );
  useEffect(() => {
    if (gaps.nextExpiry === null) return undefined;
    const timer = setTimeout(() => setGapClock(tick => tick + 1), Math.max(0, gaps.nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [gaps]);

  return useMemo(() => {
    const localId = directory.localId;
    const local = localId ? directory.devices.find(device => device.device_id === localId) : undefined;
    const slots: SidebarDeviceSlot[] = [{
      surfaceId: LOCAL_SURFACE_ID,
      deviceId: localId,
      name: local ? resolveDeviceNameFrom(directory.devices, local.device_id) : localLabel,
      isLocal: true,
      rendered: activeSurfaceId === LOCAL_SURFACE_ID,
      hostKind: reportedHostKind(local?.device_kind) ?? 'desktop',
      os: local?.device_os ?? (typeof navigator === 'undefined' ? null : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`),
      controllable: true,
      linkState: null,
    }];
    const peers: SidebarDeviceSlot[] = directory.devices
      .filter(device => device.device_id !== localId && (device.online || gaps.ids.has(device.device_id))
        && !CONTROLLER_KINDS.has(device.device_kind?.trim().toLowerCase() ?? ''))
      .map(device => {
        const surfaceId = surfaceIdForDevice(device.device_id);
        const attachment = attachments?.find(item => item.deviceId === device.device_id);
        const linkKind = attachment?.capabilities?.hostKind;
        return {
          surfaceId,
          deviceId: device.device_id,
          name: resolveDeviceNameFrom(directory.devices, device.device_id),
          isLocal: false,
          rendered: activeSurfaceId === surfaceId,
          hostKind: linkKind ?? reportedHostKind(device.device_kind),
          os: device.device_os ?? null,
          controllable: isDeviceControllable(device),
          linkState: linkStateOf(attachment, !device.online),
        };
      });
    // Presence can lag behind a live control link; the rendered peer stays listed.
    if (renderedPeer && !peers.some(slot => slot.deviceId === renderedPeer.deviceId)) {
      const attachment = attachments?.find(item => item.deviceId === renderedPeer.deviceId);
      peers.push({
        surfaceId: surfaceIdForDevice(renderedPeer.deviceId),
        deviceId: renderedPeer.deviceId,
        name: resolveDeviceNameFrom(directory.devices, renderedPeer.deviceId, renderedPeer.deviceName),
        isLocal: false,
        rendered: true,
        hostKind: attachment?.capabilities?.hostKind ?? null,
        os: directory.devices.find(device => device.device_id === renderedPeer.deviceId)?.device_os ?? null,
        controllable: true,
        linkState: linkStateOf(attachment, false),
      });
    }
    peers.sort((a, b) => a.name.localeCompare(b.name) || a.surfaceId.localeCompare(b.surfaceId));
    return applyDeviceOrder([...slots, ...peers], deviceOrder, slot => slot.deviceId);
  }, [deviceOrder, activeSurfaceId, attachments, directory.devices, directory.localId, gaps, localLabel, renderedPeer]);
}

interface DeviceSectionDisclosureState {
  /** Explicit choices only; absent means open. */
  expanded: Record<string, boolean>;
  setExpanded: (surfaceId: DeviceSurfaceId, expanded: boolean) => void;
}

export const useDeviceSectionDisclosure = create<DeviceSectionDisclosureState>()(persist(
  set => ({
    expanded: {},
    setExpanded: (surfaceId, expanded) => set(state => ({ expanded: { ...state.expanded, [surfaceId]: expanded } })),
  }),
  {
    name: 'openbitfun.sidebar-device-sections.v1',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ expanded: state.expanded }),
  },
));
