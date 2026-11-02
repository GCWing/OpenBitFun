import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const miniAppGalleryAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'miniapp-gallery',
  parts: [{ id: 'root' }],
};

export const miniAppAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'miniapp',
  parts: [
    { id: 'root' },
    { id: 'header' },
    { id: 'titlebar' },
    { id: 'actionHint' },
    { id: 'content' },
    { id: 'loading' },
    { id: 'error' },
    { id: 'runner' },
    { id: 'preview' },
    { id: 'notice' },
  ],
  states: [{ id: 'customizing', selector: { kind: 'ancestorPart', part: 'root', suffix: '[data-openbitfun-state~="customizing"]' } }],
};
