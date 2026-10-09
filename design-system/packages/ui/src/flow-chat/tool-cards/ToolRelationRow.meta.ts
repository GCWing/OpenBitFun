import type { ComponentMeta } from '../../registry.types';

export const toolRelationRowMeta = {
  category: 'flow-chat',
  name: 'ToolRelationRow',
  description: 'Plain actor and target identities navigate to their owning surfaces. Only the tinted outcome opens dialog details; the row never expands.',
  maturity: 'stable',
  props: [
    { name: 'interaction', type: 'ToolCardInteraction' },
    { name: 'result', type: 'ReactNode' },
    { name: 'status', type: 'FlowChatToolStatus' },
    { name: 'details', type: 'ReactNode' },
    { name: 'detailsTitle', type: 'ReactNode' },
    { name: 'detailsSize', type: 'DialogSize', defaultValue: 'sm' },
    { name: 'resultLabel', type: 'string' },
  ],
  states: ['default', 'hover', 'focus', 'loading', 'error'],
  tokens: ['radius.sm', 'control.height.sm', 'color.action.neutral.surface', 'color.action.quiet.hover', 'color.content.primary', 'color.content.secondary', 'color.status.danger.content'],
} as const satisfies ComponentMeta;
