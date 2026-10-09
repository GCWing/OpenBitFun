import type { ComponentMeta } from '../../registry.types';

export const flowChatTurnMetricsMeta = {
  category: 'flow-chat', name: 'FlowChatTurnMetrics', maturity: 'stable',
  description: 'Quiet turn usage with a cache-hit ring and four output-speed levels, using shared Lucide Icon anatomy.',
  props: [
    { name: 'cacheHitRate', type: 'number | null' },
    { name: 'speedLevel', type: '1 | 2 | 3 | 4 | null' },
    { name: 'tokenValue', type: 'string | null' },
    { name: 'rateValue', type: 'string | null' },
    { name: 'tokenDescription', type: 'string' },
    { name: 'rateDescription', type: 'string' },
    { name: 'tokenDetails', type: 'ReactNode' },
    { name: 'rateDetails', type: 'ReactNode' },
  ],
  states: ['reported', 'unknown', 'hover', 'focus', 'click'],
  tokens: [
    'type.flow.meta.fontFamily', 'type.flow.meta.fontSize', 'type.flow.meta.fontWeight',
    'type.flow.meta.lineHeight', 'color.content.muted', 'color.border.default',
    'color.focus.ring', 'control.icon.size.sm', 'control.icon.strokeWidth',
    'color.content.secondary', 'color.border.subtle', 'color.surface.raised',
    'shadow.sm', 'effect.blur.base', 'border.width.default',
    'space.1', 'space.2', 'space.3', 'space.6', 'radius.pill', 'radius.lg',
  ],
} as const satisfies ComponentMeta;
