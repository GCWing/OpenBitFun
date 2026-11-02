import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const computerUseControlAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'computer-control',
  parts: [{ id: 'root' }, { id: 'status' }, { id: 'preview' }, { id: 'pointer' }, { id: 'click' }, { id: 'sharing' }, { id: 'permissions' }],
};
