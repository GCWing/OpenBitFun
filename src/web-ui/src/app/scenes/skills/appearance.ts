import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const skillsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'skills',
  parts: [
    { id: 'root' }, { id: 'header' },
    { id: 'content' }, { id: 'installed' },
    { id: 'pageActions' },
    { id: 'addForm' },
    { id: 'controls' },
    { id: 'main' }, { id: 'toolbar' },
    { id: 'installedTable' },
    { id: 'loading' }, { id: 'error' }, { id: 'empty' }, { id: 'list' }, { id: 'skeleton' },
    { id: 'pagination' }, { id: 'pageButton' }, { id: 'pageInfo' },
    { id: 'discover' },
    { id: 'resultsInfo' },
    { id: 'detail' }, { id: 'detailBadges' }, { id: 'detailDescriptionViewport' },
    { id: 'detailDescription' }, { id: 'detailMetadata' }, { id: 'detailStatus' },
    { id: 'groups' }, { id: 'groupsHeader' }, { id: 'groupList' },
    { id: 'groupTable' }, { id: 'groupListHeader' },
    { id: 'groupRow' }, { id: 'groupOpen' }, { id: 'groupActions' },
    { id: 'groupEditor' }, { id: 'groupMembers' }, { id: 'groupMember' },
  ],
  facets: [
    { id: 'tab', attribute: 'data-openbitfun-tab', values: ['installed', 'discover'] },
    { id: 'category', attribute: 'data-openbitfun-category', values: ['all', 'builtin', 'user', 'project', 'groups'] },
  ],
  states: [
    { id: 'hover', selector: { kind: 'self', suffix: ':hover' } },
    { id: 'focusVisible', selector: { kind: 'self', suffix: ':focus-visible' } },
    { id: 'disabled', selector: { kind: 'self', suffix: ':disabled' } },
  ],
};
