import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const agentsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'agents',
  parts: [
    { id: 'root' },
    { id: 'zones' },
    { id: 'harnessPresentation' },
    { id: 'harnessPreview', visualRole: 'content' },
    { id: 'filters' },
    { id: 'catalogGrid' },
    { id: 'detailSection' },
    { id: 'capabilityCards', visualRole: 'content' },
  ],
};
