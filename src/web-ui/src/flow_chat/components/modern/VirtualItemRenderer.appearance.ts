import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const virtualItemAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'virtual-item',
  parts: [{ id: 'root' }, { id: 'imageAnalyzing' }, { id: 'placeholder' }, { id: 'searchLine' }],
  states: [
    { id: 'itemFocus', selector: { kind: 'self', suffix: '[data-openbitfun-state~="itemFocus"]' } },
    { id: 'searchMatch', selector: { kind: 'self', suffix: '[data-openbitfun-state~="searchMatch"]' } },
    { id: 'searchCurrent', selector: { kind: 'self', suffix: '[data-openbitfun-state~="searchCurrent"]' } },
  ],
};
