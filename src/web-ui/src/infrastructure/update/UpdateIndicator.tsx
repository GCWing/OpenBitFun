import { canCheckForAppUpdates } from './tauriEnv';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';
import './UpdateIndicator.scss';

export function useHasAppUpdate(): boolean {
  const attention = useUpdateInstallStore(selectHasUpdateAttention);
  return canCheckForAppUpdates() && attention;
}

export function UpdateIndicator() {
  const visible = useHasAppUpdate();
  return visible ? <span className="openbitfun-update-indicator" aria-hidden="true"
    data-testid="app-update-indicator" data-openbitfun-component="update" data-openbitfun-part="indicator" /> : null;
}
