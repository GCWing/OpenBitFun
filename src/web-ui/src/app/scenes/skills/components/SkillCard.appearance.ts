import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const skillCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'skill-card',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'open' }, { id: 'icon' },
    { id: 'body' }, { id: 'titleRow' }, { id: 'name' },
    { id: 'description' }, { id: 'actions' }, { id: 'action' },
  ],
  facets: [
    { id: 'variant', attribute: 'data-openbitfun-variant', values: ['skill', 'market'] },
    { id: 'level', attribute: 'data-openbitfun-level', values: ['user', 'project'] },
  ],
  states: [
    { id: 'hover', selector: { kind: 'self', suffix: ':hover' } },
    { id: 'focusVisible', selector: { kind: 'self', suffix: ':focus-visible' } },
    { id: 'disabled', selector: { kind: 'self', suffix: ':disabled' } },
    { id: 'shadowed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="shadowed"]' } },
    { id: 'builtin', selector: { kind: 'self', suffix: '[data-openbitfun-state~="builtin"]' } },
  ],
};
