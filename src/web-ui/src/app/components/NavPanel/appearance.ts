import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const navPanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'nav-panel',
  parts: [
    { id: 'root', propertyProfile: 'layout', visualRole: 'panel', continuityGroup: 'nav-panel' },
    { id: 'content', visualRole: 'continuous-surface', continuityGroup: 'nav-panel' },
    { id: 'mainLayer', propertyProfile: 'layout', visualRole: 'continuous-surface', continuityGroup: 'nav-panel' },
    { id: 'sceneLayer', propertyProfile: 'layout', visualRole: 'continuous-surface', continuityGroup: 'nav-panel' },
    { id: 'sceneContent', visualRole: 'content', continuityGroup: 'nav-panel' },
    { id: 'brandHeader', visualRole: 'toolbar', continuityGroup: 'nav-panel' },
    { id: 'utilityRow', visualRole: 'toolbar', continuityGroup: 'nav-panel' },
    { id: 'search', propertyProfile: 'control', visualRole: 'control' },
    { id: 'searchTrigger', propertyProfile: 'control', visualRole: 'control' },
    { id: 'todoEntry', propertyProfile: 'control', visualRole: 'control' },
    { id: 'topActions', visualRole: 'toolbar' },
    { id: 'topAction', propertyProfile: 'control', visualRole: 'control' },
    { id: 'topActionUnseen', propertyProfile: 'paint', visualRole: 'decoration' },
    { id: 'section', visualRole: 'content' },
    { id: 'stickySectionHeader', visualRole: 'toolbar', continuityGroup: 'nav-panel' },
    { id: 'sectionContent', visualRole: 'content' },
    { id: 'assistantSessionActions', propertyProfile: 'control', visualRole: 'control' },
    { id: 'footer', visualRole: 'toolbar', continuityGroup: 'nav-panel' },
    { id: 'deviceStatus', propertyProfile: 'control', visualRole: 'control' },
    { id: 'settingsEntry', propertyProfile: 'control', visualRole: 'control' },
  ],
  facets: [
    { id: 'layer', attribute: 'data-openbitfun-layer', values: ['main', 'scene'] },
    { id: 'action', attribute: 'data-openbitfun-action', values: ['new-session', 'smart-members', 'long-term-tracking', 'todos', 'extensions', 'agents', 'skills', 'ecosystem-compatibility', 'session-filter', 'assistant-manager', 'personal-overview'] },
    { id: 'section', attribute: 'data-openbitfun-section', values: ['smart-members', 'workspace', 'sessions'] },
  ],
  states: [
    { id: 'scene', selector: { kind: 'self', suffix: '[data-openbitfun-state~="scene"]' } },
    // Keep legacy split selectors valid in installed appearances.
    { id: 'split', selector: { kind: 'self', suffix: '[data-openbitfun-state~="split"]' } },
    { id: 'active', selector: { kind: 'self', suffix: '[data-openbitfun-state~="active"]' } },
    { id: 'open', selector: { kind: 'self', suffix: '[data-openbitfun-state~="open"]' } },
    { id: 'closing', selector: { kind: 'self', suffix: '[data-openbitfun-state~="closing"]' } },
    { id: 'empty', selector: { kind: 'self', suffix: '[data-openbitfun-state~="empty"]' } },
    { id: 'stuck', selector: { kind: 'self', suffix: '[data-openbitfun-state~="stuck"]' } },
    { id: 'local', selector: { kind: 'self', suffix: '[data-openbitfun-state~="local"]' } },
    { id: 'connected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="connected"]' } },
  ],
};
