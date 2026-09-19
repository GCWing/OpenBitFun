/**
 * Shared mount point for portaled overlays (menus, popovers, modals, tooltips).
 *
 * The host is a layer, not just a container: the stylesheet imported here gives
 * it a stacking context above every container that hosts app UI, which is what
 * keeps an overlay visible and clickable no matter how high the z-index of the
 * subtree it portaled out of. See AppearanceOverlayHost.scss.
 */

import { getOverlayHost } from '@openbitfun/ui';
import './AppearanceOverlayHost.scss';

const OVERLAY_HOST_ID = 'openbitfun-appearance-overlay-host';

export function getAppearanceOverlayHost(): HTMLDivElement {
  const host = getOverlayHost(document);
  host.id = OVERLAY_HOST_ID;
  return host;
}
