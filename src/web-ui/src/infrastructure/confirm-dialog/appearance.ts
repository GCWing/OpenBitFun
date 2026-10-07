import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const confirmDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'confirm-dialog',
  parts: [
    { id: 'content' },
    { id: 'messageRow' },
    { id: 'icon' },
    { id: 'message' },
    { id: 'preview' },
    { id: 'actions' },
    { id: 'actionGroup' },
  ],
  facets: [{
    id: 'status',
    attribute: 'data-openbitfun-status',
    values: ['info', 'warning', 'danger', 'success'],
  }],
};
