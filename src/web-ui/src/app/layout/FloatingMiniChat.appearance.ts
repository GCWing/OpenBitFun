import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const floatingMiniChatAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'floating-mini-chat',
  parts: [{ id: 'root' }, { id: 'panel' }, { id: 'header' }, { id: 'body' }, { id: 'pending' }, { id: 'callStatus' }],
  facets: [{ id: 'mode', attribute: 'data-openbitfun-mode', values: ['chat', 'miniapp'] },
    { id: 'communicationMode', attribute: 'data-openbitfun-communication-mode', values: ['chat', 'voice'] }],
  states: [{ id: 'open', selector: { kind: 'ancestorPart', part: 'root', suffix: '[data-openbitfun-state~="open"]' } }],
};
