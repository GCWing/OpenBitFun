import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const automationSettingsPageAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'automation-settings-page',
  parts: [
    { id: 'root', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'quickActions', visualRole: 'content' },
    { id: 'hooks', visualRole: 'content' },
  ],
};
