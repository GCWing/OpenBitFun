import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

/** Billing is shared by the composer and model settings, using semantic tokens. */
export const modelBillingAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'model-billing',
  parts: [{ id: 'root' }, { id: 'editor' }, { id: 'compactSummary' }],
};
