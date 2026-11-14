import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const visualSkinConfigAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'visual-skin-settings',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [{ id: 'section' }, { id: 'card', propertyProfile: 'paint' }],
  states: [
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
  ],
};
