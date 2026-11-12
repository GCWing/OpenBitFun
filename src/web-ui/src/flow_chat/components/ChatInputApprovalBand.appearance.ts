import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

/**
 * The surface id stays `permission-request-panel` even though the component is
 * now a band inside the composer: saved appearance data targets this id, and
 * renaming it would silently drop styling for the approval surface.
 */
export const chatInputApprovalBandAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'permission-request-panel',
  parts: [
    { id: 'root' }, { id: 'request' }, { id: 'risk' }, { id: 'confirming' }, { id: 'error' },
    { id: 'actions' }, { id: 'scope' }, { id: 'grantScope' },
  ],
  states: [
    { id: 'responding', selector: { kind: 'self', suffix: '[data-openbitfun-state~="responding"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
  ],
};
