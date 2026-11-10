import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const latexEditorAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'latex-editor',
  parts: [
    { id: 'preview' },
    { id: 'toolbar' },
    { id: 'diagnostics' },
    { id: 'empty' },
  ],
};
