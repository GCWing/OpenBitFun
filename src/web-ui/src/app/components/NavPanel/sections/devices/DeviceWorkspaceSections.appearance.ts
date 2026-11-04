import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const navDeviceSectionAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'nav-device-section',
  parts: [{ id: 'root' }, { id: 'header' }, { id: 'body' }],
  states: [
    { id: 'rendered', selector: { kind: 'self', suffix: '[data-openbitfun-state~="rendered"]' } },
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
  ],
};
