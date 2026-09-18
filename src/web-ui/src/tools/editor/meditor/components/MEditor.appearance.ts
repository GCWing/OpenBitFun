import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const mEditorAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'm-editor',
  parts: [
    { id: 'root' }, { id: 'toolbar' }, { id: 'content' },
    { id: 'notice' }, { id: 'editPanel' }, { id: 'irPanel' },
  ],
};
