import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

/** Product registration of the public component's concrete DOM anatomy. */
export const splitViewAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'split-view',
  parts: [
    { id: 'root', propertyProfile: 'layout' },
    { id: 'primary', propertyProfile: 'layout' },
    { id: 'secondary', propertyProfile: 'layout' },
    { id: 'divider', propertyProfile: 'layout' },
    { id: 'resizeHandle', propertyProfile: 'layout' },
    { id: 'actions' },
  ],
};
