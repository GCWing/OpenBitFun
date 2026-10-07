import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const settingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'settings',
  parts: [
    { id: 'root', propertyProfile: 'layout', visualRole: 'workspace', continuityGroup: 'settings-workspace' },
    { id: 'content', propertyProfile: 'layout', visualRole: 'continuous-surface', continuityGroup: 'settings-workspace' },
    { id: 'loading', propertyProfile: 'overlay', visualRole: 'content' },
  ],
  facets: [{
    id: 'page',
    attribute: 'data-openbitfun-page',
    values: [
      'application.general',
      'application.appearance',
      'application.pet',
      'application.input',
      'ai.models',
      'ai.session-memory',
      'ai.execution',
      'ai.permissions',
      'development.editor',
      'development.terminal',
      'development.workspace',
      'tools.web-search',
      'tools.desktop-control',
      'tools.mcp',
      'tools.external-agents',
      'tools.automation',
      'data.usage',
      'data.archived',
      'data.diagnostics',
    ],
  }],
};
