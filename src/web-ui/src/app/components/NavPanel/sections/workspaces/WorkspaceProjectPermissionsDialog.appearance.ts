import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const workspaceProjectPermissionsDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'workspace-project-permissions-dialog',
  parts: [
    { id: 'root' }, { id: 'grant' }, { id: 'rule' }, { id: 'footer' }, { id: 'addForm' },
  ],
};
