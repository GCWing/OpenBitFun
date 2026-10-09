import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const runtimeSettingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'runtime-settings',
  parts: [
    { id: 'root' },

    { id: 'control' },
    { id: 'petPicker' },
    { id: 'petChooser' },
    { id: 'petSummary' },
    { id: 'petStack' },
    { id: 'petTrigger' },
    { id: 'petList' },
    { id: 'petGroup' },
    { id: 'petOption' },
    { id: 'petOptionMain' },
    { id: 'petActions' },
    { id: 'platformNote' },
    { id: 'modalFooter' },
    { id: 'restartModal' },
  ],
  facets: [
    {
      id: 'view',
      attribute: 'data-openbitfun-view',
      values: [
        'pet',
        'permissions',
        'execution',
        'browser-desktop-control',
      ],
    },
  ],
  states: [
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
  ],
};
