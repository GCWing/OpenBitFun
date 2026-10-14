import { create } from 'zustand';

export type NurseryPage = 'gallery' | 'assistant';

interface NurseryStoreState {
  page: NurseryPage;
  activeWorkspaceId: string | null;
  openGallery: () => void;
  openAssistant: (workspaceId: string) => void;
}

export const useNurseryStore = create<NurseryStoreState>((set) => ({
  page: 'gallery',
  activeWorkspaceId: null,
  openGallery: () => set({ page: 'gallery', activeWorkspaceId: null }),
  openAssistant: (workspaceId) => set({ page: 'assistant', activeWorkspaceId: workspaceId }),
}));
