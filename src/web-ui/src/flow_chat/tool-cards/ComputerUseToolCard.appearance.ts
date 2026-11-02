import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const computerUseToolCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'computer-use-tool-card',
  parts: [
    { id: 'root' }, { id: 'content' }, { id: 'permissionDenied' },
    { id: 'expanded' }, { id: 'row' },
    { id: 'loopWarning' },
  ],
  states: [
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
    { id: 'failed', selector: { kind: 'self', suffix: '[data-openbitfun-state~="failed"]' } },
  ],
};
