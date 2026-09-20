import { canCheckForAppUpdates } from './tauriEnv';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';

export function useHasAppUpdate(): boolean {
  const attention = useUpdateInstallStore(selectHasUpdateAttention);
  return canCheckForAppUpdates() && attention;
}
