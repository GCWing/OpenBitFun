import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const appearanceSettingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'appearance-settings',
  parts: [
    { id: 'root' }, { id: 'content' },

    { id: 'packageSection' }, { id: 'packagePreview' }, { id: 'packageBuiltinTheme' },
  ],
  facets: [
    { id: 'packageType', attribute: 'data-openbitfun-package-type', values: ['native'] },
  ],
  states: [
    { id: 'hover', selector: { kind: 'self', suffix: ':hover' } },
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
  ],
};
