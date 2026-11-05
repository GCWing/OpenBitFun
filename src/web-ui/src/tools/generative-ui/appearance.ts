import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const genUIApplicationAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'gen-ui-application',
  parts: [{ id: 'root' }, { id: 'content' }],
  states: [
    { id: 'rendered', selector: { kind: 'self', suffix: '[data-openbitfun-state~="rendered"]' } },
    { id: 'rejected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="rejected"]' } },
  ],
};

/** Appearance contract for the trusted OpenUI component implementations. */
export const genUIComponentsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'gen-ui-components',
  parts: [
    { id: 'root' },
    { id: 'layout' },
    { id: 'content' },
    { id: 'media' },
    { id: 'map' },
    { id: 'control' },
  ],
};

export const genUIGalleryAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'gen-ui-gallery',
  parts: [
    { id: 'root' },
    { id: 'sidebar' },
    { id: 'brand' },
    { id: 'section' },
    { id: 'items' },
    { id: 'content' },
    { id: 'header' },
    { id: 'actions' },
    { id: 'render' },
    { id: 'diagnostics' },
    { id: 'source' },
  ],
};
