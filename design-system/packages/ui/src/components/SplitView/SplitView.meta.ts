import type { ComponentMeta } from '../../registry.types';

export const splitViewMeta = {
  category: 'primitive',
  description: 'A controlled two-pane layout with stable content containers, reversible placement, and accessible resizing.',
  maturity: 'stable',
  name: 'SplitView',
  props: [
    { name: 'primary', type: 'ReactNode' },
    { name: 'secondary', type: 'ReactNode' },
    { name: 'mode', type: 'split | primary | secondary', defaultValue: 'split' },
    { name: 'secondarySide', type: 'left | right', defaultValue: 'right' },
    { name: 'rightSize', type: 'number' },
    { name: 'onRightSizeChange', type: '(size: number) => void' },
    { name: 'dividerActions', type: 'ReactNode' },
    { name: 'dividerLabel', type: 'string' },
  ],
  states: ['split', 'primary', 'secondary'],
  tokens: ['color.border.subtle', 'color.surface.raised', 'color.accent.default', 'color.focus.ring', 'space.1', 'space.2', 'space.3', 'radius.lg'],
} as const satisfies ComponentMeta;
