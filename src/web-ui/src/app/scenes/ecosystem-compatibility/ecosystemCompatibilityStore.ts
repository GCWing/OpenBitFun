import { create } from 'zustand';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import type { EcosystemProductId } from './ecosystemCompatibilityModel';

/** Legacy external-sources destinations focus the discovery switch in the header. */
export type EcosystemCompatibilityOwnerSurface = 'acp' | 'external-sources' | null;

export interface EcosystemCompatibilityDestination {
  productId?: EcosystemProductId;
  ownerSurface?: Exclude<EcosystemCompatibilityOwnerSurface, null>;
}

interface EcosystemCompatibilityState {
  selectedProductId: EcosystemProductId;
  ownerSurface: EcosystemCompatibilityOwnerSurface;
  selectProduct: (productId: EcosystemProductId) => void;
  setOwnerSurface: (ownerSurface: EcosystemCompatibilityOwnerSurface) => void;
  openDestination: (destination: EcosystemCompatibilityDestination) => void;
}

export const useEcosystemCompatibilityStore = create<EcosystemCompatibilityState>((set) => ({
  selectedProductId: 'codex',
  ownerSurface: null,
  selectProduct: (selectedProductId) => set({
    selectedProductId,
    ownerSurface: null,
  }),
  setOwnerSurface: (ownerSurface) => set({ ownerSurface }),
  openDestination: (destination) => set((state) => ({
    selectedProductId: destination.productId ?? state.selectedProductId,
    ownerSurface: destination.ownerSurface ?? state.ownerSurface,
  })),
}));

/** Opens the settings destination while preserving product and owner deep links. */
export function openEcosystemCompatibility(
  destination?: EcosystemCompatibilityDestination,
): void {
  if (destination) {
    useEcosystemCompatibilityStore.getState().openDestination(destination);
  }
  useSettingsStore.getState().openPage('tools.external-import');
  useSceneStore.getState().openScene('settings');
}
