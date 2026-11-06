import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';

/** Account device IDs, independent of the currently rendered device. */
interface DeviceOrderPreferences {
  order: string[];
  move: (deviceId: string, targetId: string, placement: 'before' | 'after', visibleIds: string[]) => void;
}

function validIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
    : [];
}

/** Unranked devices retain their normal order after explicitly arranged ones. */
export function applyDeviceOrder<T>(items: T[], order: string[], id: (item: T) => string | null): T[] {
  const ranks = new Map(order.map((deviceId, index) => [deviceId, index]));
  return [...items].sort((a, b) =>
    (ranks.get(id(a) ?? '') ?? order.length) - (ranks.get(id(b) ?? '') ?? order.length));
}

export function sortAccountDevices(devices: AccountDeviceInfo[], localId: string | null, order: string[]): AccountDeviceInfo[] {
  const defaults = [...devices].sort((a, b) => {
    if ((a.device_id === localId) !== (b.device_id === localId)) return a.device_id === localId ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return deviceDisplayName(a).localeCompare(deviceDisplayName(b)) || a.device_id.localeCompare(b.device_id);
  });
  return applyDeviceOrder(defaults, order, device => device.device_id);
}

/** Presentation on this controller only: never saved to either host's config. */
export const useDeviceOrderPreferences = create<DeviceOrderPreferences>()(persist(
  set => ({
    order: [],
    move: (deviceId, targetId, placement, visibleIds) => set(state => {
      if (deviceId === targetId || !visibleIds.includes(deviceId) || !visibleIds.includes(targetId)) return state;
      const combined = validIds([...state.order, ...visibleIds]).filter(id => id !== deviceId);
      combined.splice(combined.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, deviceId);
      return { order: combined };
    }),
  }),
  {
    name: 'openbitfun.device-order.v1',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ order: state.order }),
    merge: (persisted, current) => ({
      ...current,
      order: validIds((persisted as Partial<DeviceOrderPreferences> | null)?.order),
    }),
  },
));
