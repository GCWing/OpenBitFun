import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const flowToolCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'flow-tool-card',
  parts: [
    { id: 'root' },
    { id: 'note' },
  ],
  facets: [
    {
      id: 'attention',
      attribute: 'data-openbitfun-attention',
      values: ['ambient', 'prominent'],
    },
    {
      id: 'presentation',
      attribute: 'data-openbitfun-presentation',
      values: ['standard', 'dedicated', 'relation'],
    },
  ],
  states: [
    {
      id: 'permissionPending',
      selector: { kind: 'self', suffix: '[data-openbitfun-state~="permission-pending"]' },
    },
  ],
};
