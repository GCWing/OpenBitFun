import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const setupWizardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'setup-wizard',
  parts: [
    { id: 'root', propertyProfile: 'layout' },
    { id: 'layout', propertyProfile: 'layout' },
    { id: 'header' }, { id: 'heading' }, { id: 'title' }, { id: 'headerActions' },
    { id: 'guide' }, { id: 'guideCopy' }, { id: 'progress' }, { id: 'step' },
    { id: 'content', propertyProfile: 'layout' },
    { id: 'contentInner', propertyProfile: 'layout' },
    { id: 'footer' },
  ],
};
