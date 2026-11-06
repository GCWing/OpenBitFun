import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

interface DeviceVisibilityPreferences {
  /** Controller presentation only. Missing entries keep existing installs visible. */
  hidden: Record<DeviceSurfaceId, boolean>;
  setVisible: (surfaceId: DeviceSurfaceId, visible: boolean) => void;
}

export const useDeviceVisibilityPreferences = create<DeviceVisibilityPreferences>()(persist(
  set => ({
    hidden: {},
    setVisible: (surfaceId, visible) => set(state => ({
      hidden: { ...state.hidden, [surfaceId]: !visible },
    })),
  }),
  {
    name: 'openbitfun.sidebar-device-visibility.v1',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ hidden: state.hidden }),
    merge: (persisted, current) => {
      const saved = (persisted as Partial<DeviceVisibilityPreferences> | null)?.hidden;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return current;
      return {
        ...current,
        hidden: Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean')),
      };
    },
  },
));
