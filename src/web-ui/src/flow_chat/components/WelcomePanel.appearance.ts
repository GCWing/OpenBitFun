import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const welcomePanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'welcome-panel',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root', propertyProfile: 'layout', visualRole: 'workspace' },
    { id: 'content', visualRole: 'card' },
    { id: 'greeting', visualRole: 'content' },
    { id: 'caption', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'modeIcon', propertyProfile: 'paint', visualRole: 'decoration' },
    { id: 'modeChoices', visualRole: 'content' },
    { id: 'modeOption', propertyProfile: 'control', visualRole: 'control' },
    { id: 'modeName', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'heading', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'tagline', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'divider', propertyProfile: 'paint', visualRole: 'divider' },
    { id: 'narrative', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'openWorkspaceAction', propertyProfile: 'control', visualRole: 'control' },
    { id: 'workspaceAction', propertyProfile: 'control', visualRole: 'control' },
    { id: 'workspaceMenu', propertyProfile: 'overlay', visualRole: 'popup' },
    { id: 'cowork', visualRole: 'content' },
  ],
  states: [
    { id: 'hover', selector: { kind: 'self', suffix: ':hover:not(:disabled)' } },
    { id: 'focusVisible', selector: { kind: 'self', suffix: ':focus-visible' } },
    { id: 'disabled', selector: { kind: 'self', suffix: ':disabled' } },
    { id: 'open', selector: { kind: 'self', suffix: '[data-openbitfun-state~="open"]' } },
  ],
};
