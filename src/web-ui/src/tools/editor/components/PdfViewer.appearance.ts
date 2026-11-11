import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const pdfViewerAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'pdf-viewer',
  parts: [
    { id: 'reviewToolbar' }, { id: 'comments' },
    { id: 'root' },
    { id: 'info' },
    { id: 'container' },
    { id: 'loading' },
    { id: 'error' },
    { id: 'page' },
    { id: 'textLayer' },
  ],
  states: [
    { id: 'rendering', selector: { kind: 'ancestorPart', part: 'page', suffix: '[data-openbitfun-state~="rendering"]' } },
  ],
};
