import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const contextUsagePopoverAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'context-usage-popover',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'totals' }, { id: 'body', propertyProfile: 'layout' },
    { id: 'bar', propertyProfile: 'layout' },
    { id: 'legend' }, { id: 'item' }, { id: 'status', propertyProfile: 'paint', visualRole: 'content' },
  ],
};

export const toolDefinitionsPreviewAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'tool-definitions-preview',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root' },
    { id: 'viewport', propertyProfile: 'layout' },
    { id: 'name', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'type', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'value', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'optional', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'help', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'nested', propertyProfile: 'layout' },
    { id: 'constraints' },
    { id: 'constraint' },
  ],
};

export const sessionUsagePanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'session-usage-panel',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root' },
    { id: 'header' },
    { id: 'section' },
    { id: 'summaryFacts' },
    { id: 'summaryFact' },
    { id: 'tokenChart', propertyProfile: 'layout' },
    { id: 'tokenGroup', propertyProfile: 'layout' },
    { id: 'legendDetail', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'legendShare', propertyProfile: 'layout' },
  ],
  states: [
    { id: 'fallback', selector: { kind: 'self', suffix: '[data-openbitfun-state~="fallback"]' } },
  ],
};
