import { requestSettingsNavigation } from '@/infrastructure/config/settingsDraftRegistry';
import type { InteractionMotion } from '@/shared/utils/motionPreference';
import { create } from 'zustand';
import { resolveSettingsDestination, type SettingsDestinationInput } from './settingsDestination';
import { DEFAULT_SETTINGS_PAGE_ID } from './settingsRegistry';
import type {
  SettingsPageId,
  SettingsSectionId,
  SettingsViewId
} from './settingsTypes';

interface SettingsState {
  activePageId: SettingsPageId;
  activeViewId: SettingsViewId | null;
  activeSectionId: SettingsSectionId | null;
  navigationRequestId: number;
  pageTransitionTarget: SettingsPageId | null;
  pageTransitionMotion: InteractionMotion;
  pageTransitionSequence: number;
  openDestination: (destination: SettingsDestinationInput, motion?: InteractionMotion) => void;
  openPage: (pageId: SettingsPageId, motion?: InteractionMotion) => void;
  setActiveView: (viewId: SettingsViewId) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  activePageId: DEFAULT_SETTINGS_PAGE_ID,
  activeViewId: null,
  activeSectionId: null,
  navigationRequestId: 0,
  pageTransitionTarget: null,
  pageTransitionMotion: 'instant',
  pageTransitionSequence: 0,
  searchQuery: '',

  openDestination: (destination, motion = 'instant') => {
    const resolvedDestination = resolveSettingsDestination(destination);
    const nextViewId = resolvedDestination.viewId ?? null;
    const current = get();
    requestSettingsNavigation(
      {
        pageId: current.activePageId,
        viewId: current.activeViewId ?? undefined,
      },
      {
        kind: 'settings',
        pageId: resolvedDestination.pageId,
        viewId: nextViewId ?? undefined,
      },
      () => set((state) => ({
        activePageId: resolvedDestination.pageId,
        activeViewId: nextViewId,
        activeSectionId: resolvedDestination.sectionId ?? null,
        navigationRequestId: state.navigationRequestId + 1,
        pageTransitionTarget: resolvedDestination.pageId,
        pageTransitionMotion: motion,
        pageTransitionSequence: state.pageTransitionSequence + 1,
      })),
    );
  },
  openPage: (pageId, motion = 'instant') => {
    get().openDestination({ pageId }, motion);
  },
  setActiveView: (viewId) => {
    const current = get();
    requestSettingsNavigation(
      {
        pageId: current.activePageId,
        viewId: current.activeViewId ?? undefined,
      },
      {
        kind: 'settings',
        pageId: current.activePageId,
        viewId,
      },
      () => set((state) => ({
        activeViewId: viewId,
        activeSectionId: null,
        navigationRequestId: state.navigationRequestId + 1,
      })),
    );
  },
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
