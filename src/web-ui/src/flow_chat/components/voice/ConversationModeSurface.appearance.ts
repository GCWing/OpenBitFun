import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const conversationModeSurfaceAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'conversation-mode-surface',
  parts: [
    { id: 'root' },
    { id: 'body' },
    { id: 'voiceHeader' },
    { id: 'modeSwitch' },
    { id: 'modeSwitchButton' },
    { id: 'composer' },
    { id: 'history' },
    { id: 'images' },
    { id: 'imagePreview' },
  ],
  states: [
    { id: 'chat', selector: { kind: 'self', suffix: '[data-openbitfun-state~="chat"]' } },
    { id: 'voice', selector: { kind: 'self', suffix: '[data-openbitfun-state~="voice"]' } },
  ],
};
