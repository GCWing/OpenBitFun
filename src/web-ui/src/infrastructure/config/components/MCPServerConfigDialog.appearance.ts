import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const mcpServerConfigDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'mcp-config-editor',
  parts: [
    { id: 'root' }, { id: 'field' }, { id: 'section' }, { id: 'keyValue' },
    { id: 'argument' }, { id: 'importRow' }, { id: 'actions' }, { id: 'hint' },
    { id: 'error' }, { id: 'advanced' }, { id: 'advancedFields' },
  ],
};
