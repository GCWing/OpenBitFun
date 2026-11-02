import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const subagentProjectionAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'subagent-projection',
  parts: [
    { id: 'root' }, { id: 'truncated' }, { id: 'hint' }, { id: 'message' },
    { id: 'item' },
    { id: 'container' }, { id: 'content' },
  ],
  states: [
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
  ],
};
