import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

/**
 * Shared full-size image preview. The scrim and close control belong to the
 * design-system `dialog` surface, so only the previewed image is app-owned.
 */
export const imageLightboxAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'image-lightbox',
  parts: [{ id: 'image', visualRole: 'content' }],
};
