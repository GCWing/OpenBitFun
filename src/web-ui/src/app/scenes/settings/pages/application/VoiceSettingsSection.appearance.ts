import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const voiceInputConfigAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'voice-input-config',
  parts: [
    { id: 'root' }, { id: 'statusCard' }, { id: 'statusActions' },
    { id: 'modelDialog' }, { id: 'modelList' }, { id: 'modelCard' },
    { id: 'modelActions' }, { id: 'modelMore' },
  ],
};
