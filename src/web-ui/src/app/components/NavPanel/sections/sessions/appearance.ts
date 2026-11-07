import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const sessionsSectionAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'sessions-section',
  parts: [
    { id: 'root' },
    { id: 'loading' },
    { id: 'aggregateLoading' },
    { id: 'row' },
    { id: 'rowMain' },
    { id: 'assistantAvatar' },
    { id: 'status' },
    { id: 'edit' },
    { id: 'actions' },
    { id: 'menu' },
    { id: 'deleteConfirmation' },
    { id: 'toggle' },
  ],
  states: [
    { id: 'active', selector: { kind: 'self', suffix: '[data-openbitfun-state~="active"]' } },
    { id: 'editing', selector: { kind: 'self', suffix: '[data-openbitfun-state~="editing"]' } },
    { id: 'menuOpen', selector: { kind: 'self', suffix: '[data-openbitfun-state~="menuOpen"]' } },
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'partial', selector: { kind: 'self', suffix: '[data-openbitfun-state~="partial"]' } },
  ],
};
