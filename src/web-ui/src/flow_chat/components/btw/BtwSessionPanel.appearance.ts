import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const btwSessionPanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'btw-session-panel',
  parts: [
    { id: 'root' },
    { id: 'header' },
    { id: 'headerMain' },
    { id: 'title' },
    { id: 'meta' },
    { id: 'actions' },
    { id: 'body' },
    { id: 'empty' },
    { id: 'scrollToBottom' },
    { id: 'minimized' },
    { id: 'actionBar' },
  ],
  facets: [
    { id: 'view', attribute: 'data-openbitfun-view', values: ['empty', 'session'] },
  ],
  states: [
    { id: 'hasActionBar', selector: { kind: 'self', suffix: '[data-openbitfun-state~="hasActionBar"]' } },
    { id: 'minimized', selector: { kind: 'self', suffix: '[data-openbitfun-state~="minimized"]' } },
    { id: 'hidden', selector: { kind: 'self', suffix: '[data-openbitfun-state~="hidden"]' } },
  ],
};
