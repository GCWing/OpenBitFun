import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const keyboardShortcutsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'keyboard-shortcuts',
  parts: [
    { id: 'root' }, { id: 'toolbar' },
    { id: 'search' }, { id: 'actions' }, { id: 'error' }, { id: 'list' },
    { id: 'item' }, { id: 'label' }, { id: 'key' }, { id: 'empty' },
  ],
  states: [
    { id: 'recording', selector: { kind: 'self', suffix: '[data-openbitfun-state~="recording"]' } },
    { id: 'conflict', selector: { kind: 'self', suffix: '[data-openbitfun-state~="conflict"]' } },
    { id: 'modified', selector: { kind: 'self', suffix: '[data-openbitfun-state~="modified"]' } },
  ],
};
