import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const editorConfigAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'editor-config',
  parts: [
    { id: 'root' }, { id: 'content' },
  ],
  states: [
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
  ],
};
