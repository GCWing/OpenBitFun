import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const agentCompanionPetAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  // Stable package contract retained so existing Appearance customizations continue to
  // style the companion after its input-box presentation is removed.
  id: 'chat-input-pixel-pet',
  parts: [
    { id: 'root' }, { id: 'stage' }, { id: 'svg' }, { id: 'silhouette' },
    { id: 'face' }, { id: 'rest' }, { id: 'analyze' }, { id: 'wait' },
    { id: 'work' }, { id: 'hover' }, { id: 'drag' }, { id: 'petdex' },
  ],
  facets: [
    { id: 'mood', attribute: 'data-openbitfun-mood', values: ['rest', 'analyzing', 'waiting', 'working', 'hover', 'dragging'] },
    { id: 'layout', attribute: 'data-openbitfun-layout', values: ['default', 'center', 'stopRight', 'petdex', 'grok-live'] },
  ],
};
