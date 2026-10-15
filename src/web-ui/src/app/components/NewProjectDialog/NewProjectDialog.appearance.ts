import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const newProjectDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'new-project-dialog',
  parts: [
    { id: 'root' }, { id: 'title' }, { id: 'content' },
    { id: 'field' }, { id: 'pathSelector' },
    { id: 'error' }, { id: 'footer' }, { id: 'choices' },
  ],
};
