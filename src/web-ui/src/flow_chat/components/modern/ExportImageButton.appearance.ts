import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const exportImageAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'export-image',
  // Persisted package names stay stable; product hooks coexist with IconButton.
  componentAttribute: 'data-openbitfun-product-component',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'logo' }, { id: 'title' },
    { id: 'timestamp' }, { id: 'user' }, { id: 'assistant' }, { id: 'round' },
    { id: 'text' }, { id: 'thinking' }, { id: 'tool' }, { id: 'footer' },
    { id: 'trigger' }, { id: 'options' }, { id: 'optionCard' }, { id: 'optionContent' },
    { id: 'optionLabel' }, { id: 'optionPreview' },
  ],
  states: [{ id: 'exporting', selector: { kind: 'self', suffix: '[data-openbitfun-state~="exporting"]' } }],
};
