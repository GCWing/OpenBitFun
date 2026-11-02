import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const modelThinkingDisplayAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'model-thinking-display',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'leadingIcon' }, { id: 'label' },
    { id: 'expandContainer' }, { id: 'contentWrapper' }, { id: 'content' },
    { id: 'details' }, { id: 'detailsActions' },
  ],
  facets: [{ id: 'context', attribute: 'data-openbitfun-context', values: ['default', 'subagent-projection'] }],
  states: [
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
    { id: 'streaming', selector: { kind: 'self', suffix: '[data-openbitfun-state~="streaming"]' } },
  ],
};
