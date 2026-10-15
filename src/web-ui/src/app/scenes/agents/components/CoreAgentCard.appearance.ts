import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const coreAgentCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'core-agent-card',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root' },
    { id: 'header' },
    { id: 'headerInfo' },
    { id: 'name' },
    { id: 'status' },
    { id: 'body' },
    { id: 'description' },
    { id: 'footer' },
    { id: 'meta' },
  ],
  states: [
    { id: 'connected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="connected"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
  ],
};
