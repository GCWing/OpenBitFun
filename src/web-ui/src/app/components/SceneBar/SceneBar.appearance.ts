import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const sceneBarAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'scene-bar',
  parts: [
    { id: 'root' },
    { id: 'tabs' },
    { id: 'scrollPrevious' },
    { id: 'scrollNext' },
    { id: 'controls' },
    { id: 'dropHint' },
    { id: 'history' },
  ],
};
