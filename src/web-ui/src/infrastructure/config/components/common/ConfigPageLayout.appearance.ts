import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

/** The shared page paint owner survives each settings page's specific identity. */
export const configPageAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'config-page',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [{ id: 'root', propertyProfile: 'paint' }, { id: 'sectionBody', propertyProfile: 'paint' }],
};
