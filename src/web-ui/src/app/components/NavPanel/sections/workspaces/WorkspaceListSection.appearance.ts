import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const workspaceListSectionAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'workspace-list-section',
  parts: [
    { id: 'root' }, { id: 'empty' }, { id: 'item' }, { id: 'dropLine' },
    { id: 'viewTransition' }, { id: 'viewContent' }, { id: 'viewExits' },
  ],
  states: [
    { id: 'dragging', selector: { kind: 'self', suffix: '[data-openbitfun-state~="dragging"]' } },
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
    { id: 'transitioning', selector: { kind: 'self', suffix: '[data-openbitfun-state~="transitioning"]' } },
  ],
};
