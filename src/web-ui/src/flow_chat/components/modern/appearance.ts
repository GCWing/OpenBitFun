import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const virtualMessageListAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'virtual-message-list',
  parts: [
    { id: 'root' },
    { id: 'empty' },
    { id: 'emptyMessage' },
    { id: 'header' },
    { id: 'boundaryStatus' },
    { id: 'items' },
    { id: 'footer' },
    { id: 'tailSpacer' },
  ],
  states: [
    { id: 'empty', selector: { kind: 'self', suffix: '[data-openbitfun-state~="empty"]' } },
    { id: 'preparing', selector: { kind: 'self', suffix: '[data-openbitfun-state~="preparing"]' } },
    { id: 'unavailable', selector: { kind: 'self', suffix: '[data-openbitfun-state~="unavailable"]' } },
  ],
};

export const modernFlowChatAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'modern-flow-chat',
  parts: [
    { id: 'root' },
    { id: 'messages' },
    { id: 'historyContent' },
    { id: 'historySkeleton' },
    { id: 'historyOverlay' },
    { id: 'historyOpenIntent' },
    // Hidden compatibility slot: older installed packages can still address it.
    { id: 'historyOpenIntentSpinner' },
  ],
};
