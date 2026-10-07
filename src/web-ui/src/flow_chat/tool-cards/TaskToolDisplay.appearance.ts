import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const taskToolDisplayAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'task-tool-display',
  parts: [
    { id: 'root' }, { id: 'cancel' },
  ],
  states: [
    { id: 'failed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="failed"]' } },
  ],
};
