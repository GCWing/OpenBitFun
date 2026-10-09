import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const worktreeSettingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'worktree-settings',
  parts: [{ id: 'root' }, { id: 'results' }, { id: 'project' }, { id: 'worktreeList' }],
};
