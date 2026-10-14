import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const usageActivityGridAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'usage-activity-grid',
  parts: [{ id: 'root' }, { id: 'grid' }, { id: 'day' }, { id: 'footer' }, { id: 'legend' }],
};
