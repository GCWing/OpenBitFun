import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const generativeWidgetInlineAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'generative-widget-inline',
  parts: [
    { id: 'root' },
  ],
  states: [
    { id: 'failed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="failed"]' } },
    { id: 'streaming', selector: { kind: 'self', suffix: '[data-openbitfun-state~="streaming"]' } },
  ],
};

