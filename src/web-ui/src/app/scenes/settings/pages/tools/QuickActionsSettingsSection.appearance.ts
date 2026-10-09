import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const quickActionsConfigAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'quick-actions-config',
  parts: [
    { id: 'root' }, { id: 'content' }, { id: 'list' },
    { id: 'dialog' }, { id: 'dialogIcon' }, { id: 'field' }, { id: 'dialogFooter' },
    { id: 'row' }, { id: 'rowIcon' }, { id: 'rowBody' }, { id: 'rowControls' },
  ],
};
