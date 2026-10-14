import { create } from 'zustand';

export type InstalledFilter = 'all' | 'builtin' | 'user' | 'project' | `source:${string}`;
export type SkillsView = InstalledFilter | 'groups';
export type SkillTab = 'installed' | 'discover';

interface SkillsSceneState {
  nativeNavigationRequest: number;
  nativeNavigationTarget: SkillTab;
  openNativeSkills: (target?: SkillTab) => void;
  searchDraft: string;
  marketQuery: string;
  installedView: SkillsView;
  isAddFormOpen: boolean;
  setSearchDraft: (value: string) => void;
  submitMarketQuery: () => void;
  setInstalledView: (view: SkillsView) => void;
  setAddFormOpen: (open: boolean) => void;
  toggleAddForm: () => void;
}

export const useSkillsSceneStore = create<SkillsSceneState>((set) => ({
  nativeNavigationRequest: 0,
  nativeNavigationTarget: 'installed',
  openNativeSkills: (target = 'installed') => set((state) => ({
    nativeNavigationRequest: state.nativeNavigationRequest + 1,
    nativeNavigationTarget: target,
    installedView: 'all',
    ...(target === 'discover' ? { searchDraft: '', marketQuery: '' } : {}),
  })),
  searchDraft: '',
  marketQuery: '',
  installedView: 'all',
  isAddFormOpen: false,
  setSearchDraft: (value) => set({ searchDraft: value }),
  submitMarketQuery: () => set((state) => ({ marketQuery: state.searchDraft.trim() })),
  setInstalledView: (view) => set({ installedView: view }),
  setAddFormOpen: (open) => set({ isAddFormOpen: open }),
  toggleAddForm: () => set((state) => ({ isAddFormOpen: !state.isAddFormOpen })),
}));
