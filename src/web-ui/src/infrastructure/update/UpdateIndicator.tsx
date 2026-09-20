import { useHasAppUpdate } from './useHasAppUpdate';
import './UpdateIndicator.scss';

export function UpdateIndicator() {
  const visible = useHasAppUpdate();
  return visible ? <span className="openbitfun-update-indicator" aria-hidden="true"
    data-testid="app-update-indicator" data-openbitfun-component="update" data-openbitfun-part="indicator" /> : null;
}
