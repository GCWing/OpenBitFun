import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const latexEditorAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'latex-editor',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'source' }, { id: 'outline' },
    { id: 'preview' },
    { id: 'toolbar' },
    { id: 'diagnostics' },
    { id: 'empty' },
  ],
};
