import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const assistantCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'assistant-card',
  parts: [
    { id: 'root' }, { id: 'main' }, { id: 'header' }, { id: 'avatar' },
    { id: 'title' }, { id: 'name' }, { id: 'primaryBadge' }, { id: 'metadata' },
    { id: 'vibe' }, { id: 'creature' }, { id: 'footer' }, { id: 'setPrimary' }, { id: 'delete' },
    { id: 'visibility' },
  ],
  facets: [{ id: 'primary', attribute: 'data-openbitfun-primary', values: ['true', 'false'] }],
  states: [
    { id: 'busy', selector: { kind: 'ancestorPart', part: 'root', suffix: '[data-openbitfun-state~="busy"]' } },
  ],
};
