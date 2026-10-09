import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const archivedSessionsConfigAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'archived-sessions-config',
  parts: [
    { id: 'root' }, { id: 'headerActions' }, { id: 'loading' }, { id: 'empty' },
    { id: 'group' }, { id: 'groupHeader' }, { id: 'groupList' }, { id: 'row' },
    { id: 'rowInfo' }, { id: 'rowActions' },
  ],
  states: [
    { id: 'collapsed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="collapsed"]' } },
  ],
};
