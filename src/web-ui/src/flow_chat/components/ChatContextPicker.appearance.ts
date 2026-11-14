import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const chatContextPickerAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'chat-context-picker',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'content' },
    { id: 'currentDirectoryPath' }, { id: 'currentViewLabel' },
    { id: 'skillDescription' }, { id: 'footer' },
  ],
  states: [
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
  ],
};

/** Reads pre-rename Appearance data while targeting the current DOM contract. */
export const legacyFileMentionPickerAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'file-mention-picker',
  hostSelectorId: 'chat-context-picker',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'content' },
    { id: 'currentDirectoryPath' }, { id: 'currentViewLabel' },
    { id: 'skillDescription' }, { id: 'footer' },
  ],
  states: [
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
  ],
};
