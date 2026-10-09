import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const applicationSettingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'application-settings',
  parts: [
    { id: 'root' }, { id: 'launchAtLogin' }, { id: 'preventSleep' }, { id: 'autoUpdate' },
    { id: 'logging' }, { id: 'logPath' }, { id: 'terminal' },
    { id: 'windowBehavior' }, { id: 'notifications' },
  ],
};
