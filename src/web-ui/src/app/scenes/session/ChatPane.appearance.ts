import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const chatPaneAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'chat-pane',
  parts: [
    {
      id: 'root',
      propertyProfile: 'layout',
      visualRole: 'continuous-surface',
      continuityGroup: 'session-workspace',
    },
    { id: 'widthBoundary', propertyProfile: 'layout' },
    { id: 'widthHandle', propertyProfile: 'layout' },
  ],
};
