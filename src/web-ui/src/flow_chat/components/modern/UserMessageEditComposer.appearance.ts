import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const userMessageEditComposerAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'user-message-edit-composer',
  componentAttribute: 'data-openbitfun-product-component',
  parts: [{ id: 'root' }, { id: 'input' }, { id: 'actions' }, { id: 'action' }],
  facets: [
    { id: 'mode', attribute: 'data-openbitfun-mode', values: ['rich', 'plain'] },
    { id: 'action', attribute: 'data-openbitfun-action', values: ['cancel', 'submit'] },
  ],
  states: [
    { id: 'submitting', selector: { kind: 'ancestorPart', part: 'root', suffix: '[data-openbitfun-state~="submitting"]' } },
  ],
};
