import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface WorkspaceResourceLayout {
  filesCollapsed: boolean;
  terminalsCollapsed: boolean;
  terminalFraction: number;
  fileView: 'tree' | 'search';
}

export const DEFAULT_RESOURCE_LAYOUT: WorkspaceResourceLayout = {
  filesCollapsed: false,
  terminalsCollapsed: false,
  terminalFraction: 0.3,
  fileView: 'tree',
};

export function normalizeResourceLayout(input: Partial<WorkspaceResourceLayout> = {}): WorkspaceResourceLayout {
  return {
    filesCollapsed: input.filesCollapsed === true,
    terminalsCollapsed: input.terminalsCollapsed === true,
    terminalFraction: typeof input.terminalFraction === 'number' && Number.isFinite(input.terminalFraction)
      ? Math.min(0.75, Math.max(0.15, input.terminalFraction)) : 0.3,
    fileView: input.fileView === 'search' ? 'search' : 'tree',
  };
}

interface ResourceState {
  layouts: Record<string, WorkspaceResourceLayout>;
  updateLayout: (key: string, update: Partial<WorkspaceResourceLayout>) => void;
  /**
   * One-time upgrade of a layout persisted under a pre-ID key (surface,
   * connection, workspace ID, root path) to the ID-only key. No-op when the
   * new key already has a layout or the legacy key has none.
   */
  migrateLayout: (legacyKey: string, key: string) => void;
}

/** Presentation preferences only. Files and PTYs retain their existing owners. */
export const useWorkspaceResourceState = create<ResourceState>()(persist((set) => ({
  layouts: {},
  updateLayout: (key, update) => set(state => ({
    layouts: { ...state.layouts, [key]: normalizeResourceLayout({ ...state.layouts[key], ...update }) },
  })),
  migrateLayout: (legacyKey, key) => set(state => {
    if (legacyKey === key || state.layouts[key] || !state.layouts[legacyKey]) return state;
    const { [legacyKey]: legacy, ...rest } = state.layouts;
    return { layouts: { ...rest, [key]: legacy } };
  }),
}), {
  name: 'openbitfun-workspace-resource-layouts',
  version: 1,
  storage: createJSONStorage(() => localStorage),
  partialize: state => ({ layouts: state.layouts }),
  merge: (persisted, current) => {
    const layouts = (persisted as Partial<ResourceState> | undefined)?.layouts;
    if (!layouts || typeof layouts !== 'object' || Array.isArray(layouts)) return current;
    return { ...current, layouts: Object.fromEntries(Object.entries(layouts)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => [key, normalizeResourceLayout(value)])) };
  },
}));
