import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const workspaceIconAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'workspace-icon', parts: [{ id: 'root' }, { id: 'image' }],
};
export const workspaceIconEditorAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'workspace-icon-editor', parts: [{ id: 'root' }, { id: 'row' }, { id: 'previewPanel' }, { id: 'controls' }, { id: 'glyphs' }, { id: 'preview' }, { id: 'color' }, { id: 'error' }, { id: 'label' }],
};
