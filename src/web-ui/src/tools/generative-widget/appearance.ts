import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const generativeWidgetAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'generative-widget',
  parts: [
    { id: 'application' },
    { id: 'app' },
    { id: 'empty' },
    { id: 'toolbar' },
    { id: 'repair' },
  ],
  states: [
    { id: 'empty', selector: { kind: 'self', suffix: '[data-openbitfun-state~="empty"]' } },
    { id: 'streaming', selector: { kind: 'self', suffix: '[data-openbitfun-state~="streaming"]' } },
    { id: 'failed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="failed"]' } },
    { id: 'cancelled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="cancelled"]' } },
    { id: 'rejected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="rejected"]' } },
    { id: 'ready', selector: { kind: 'self', suffix: '[data-openbitfun-state~="ready"]' } },
    { id: 'repair-required', selector: { kind: 'self', suffix: '[data-openbitfun-state~="repair-required"]' } },
  ],
};
