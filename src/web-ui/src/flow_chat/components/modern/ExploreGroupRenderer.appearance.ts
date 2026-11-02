import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const fileEditGroupAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'file-edit-group',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'summary' }, { id: 'controls' },
    { id: 'contentWrapper' }, { id: 'content' }, { id: 'item' },
  ],
  states: [{ id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } }],
};
export const exploreGroupAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'explore-group',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'summary' },
    { id: 'contentWrapper' }, { id: 'controls' }, { id: 'content' }, { id: 'item' },
  ],
  states: [{ id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } }],
};
export const contextLoadGroupAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'context-load-group',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'summary' },
    { id: 'contentWrapper' }, { id: 'controls' }, { id: 'content' }, { id: 'item' },
  ],
  states: [{ id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } }],
};
export const shellGroupAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'shell-group',
  // Existing skins address the unified collection through their saved Shell id.
  hostSelectorId: 'explore-group',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'summary' },
    { id: 'contentWrapper' }, { id: 'controls' }, { id: 'content' }, { id: 'item' },
  ],
  states: [{ id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } }],
};
export const interfaceObservationGroupAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'interface-observation-group',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'summary' },
    { id: 'contentWrapper' }, { id: 'controls' }, { id: 'content' }, { id: 'item' },
  ],
  states: [{ id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } }],
};
