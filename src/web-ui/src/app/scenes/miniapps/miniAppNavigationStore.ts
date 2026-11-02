import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

interface MiniAppNavigationState {
  /** Controller presentation preferences, isolated by the device owning each app. */
  pinnedAppIdsBySurface: Record<string, string[]>;
  setPinned: (surfaceId: string, appId: string, pinned: boolean) => void;
}

const EMPTY_IDS: string[] = [];

function normalizePins(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([surfaceId, ids]) =>
    Array.isArray(ids)
      ? [[surfaceId, [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]]]
      : [],
  ));
}

export const useMiniAppNavigationStore = create<MiniAppNavigationState>()(persist(
  (set) => ({
    pinnedAppIdsBySurface: {},
    setPinned: (surfaceId, appId, pinned) => set(state => {
      if (!appId.trim()) return state;
      const ids = state.pinnedAppIdsBySurface[surfaceId] ?? EMPTY_IDS;
      if (ids.includes(appId) === pinned) return state;
      return {
        pinnedAppIdsBySurface: {
          ...state.pinnedAppIdsBySurface,
          [surfaceId]: pinned ? [...ids, appId] : ids.filter(id => id !== appId),
        },
      };
    }),
  }),
  {
    name: 'openbitfun-miniapp-navigation',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ pinnedAppIdsBySurface: state.pinnedAppIdsBySurface }),
    merge: (persisted, current) => ({
      ...current,
      pinnedAppIdsBySurface: normalizePins((persisted as Partial<MiniAppNavigationState> | null)?.pinnedAppIdsBySurface),
    }),
  },
));

export function useMiniAppNavigation() {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope);
  const pinnedAppIds = useMiniAppNavigationStore(state => state.pinnedAppIdsBySurface[scope.surfaceId] ?? EMPTY_IDS);
  return {
    scope,
    pinnedAppIds,
    setPinned: (appId: string, pinned: boolean) => {
      if (scope.isCurrent()) useMiniAppNavigationStore.getState().setPinned(scope.surfaceId, appId, pinned);
    },
  };
}
