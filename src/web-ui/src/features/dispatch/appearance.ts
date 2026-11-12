import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const dispatchInstallDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'dispatch-install-dialog',
  parts: [{ id: 'root' }, { id: 'header' }, { id: 'body' }, { id: 'actions' }],
};

export const dispatchResultDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'dispatch-result-dialog',
  parts: [{ id: 'root' }, { id: 'header' }, { id: 'body' }, { id: 'actions' }],
};

export const dispatchTargetPickerAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'dispatch-target-picker',
  parts: [{ id: 'root' }, { id: 'trigger' }, { id: 'menu' }, { id: 'option' }, { id: 'transport' }],
};
