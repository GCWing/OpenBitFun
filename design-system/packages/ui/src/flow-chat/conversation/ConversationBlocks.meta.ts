import type { ComponentMeta } from '../../registry.types';

const tokens = [
  'control.flowChat.rowIconGap', 'type.flow.control.fontSize',
  'color.content.secondary', 'color.content.muted',
] as const;

export const thinkingBlockMeta = {
  category: 'flow-chat', name: 'ThinkingBlock', maturity: 'stable',
  description: 'Controlled reasoning and reasoning-summary anatomy shared with the production transcript.',
  props: [{ name: 'expanded', type: 'boolean' }, { name: 'label', type: 'string' }, { name: 'onToggle', type: '() => void' },
    { name: 'onOpenDetails', type: '() => void' },
    { name: 'streamingExpanded', type: 'boolean', defaultValue: 'false' },
    { name: 'onStreamingExpandedChange', type: '(expanded: boolean) => void' },
    { name: 'scrollOwner', type: "'self' | 'parent'", defaultValue: 'self' }],
  states: ['collapsed', 'expanded', 'streaming', 'summary'], tokens: [...tokens, 'control.flowChat.streamViewportBlockSize'],
} as const satisfies ComponentMeta;

export const exploreGroupMeta = {
  category: 'flow-chat', name: 'ExploreGroup', maturity: 'stable',
  description: 'A controlled exploration group with a quiet filled capsule, a separate disclosure hit target and natural-height content.',
  props: [{ name: 'expanded', type: 'boolean' }, { name: 'summary', type: 'string' },
    { name: 'placement', type: "'standalone' | 'inline'", defaultValue: 'standalone' },
    { name: 'summaryItems', type: 'readonly { label: string; count: string }[]' },
    { name: 'summaryDescription', type: 'string' }, { name: 'bounded', type: 'boolean', defaultValue: 'false' }],
  states: ['collapsed', 'expanded', 'streaming'],
  tokens: [...tokens, 'type.flow.control.fontFamily', 'type.flow.control.fontWeight', 'type.flow.control.lineHeight', 'type.flow.control.letterSpacing',
    'color.content.disabled', 'color.action.quiet.hover', 'color.action.quiet.pressed', 'border.width.default', 'control.statusPill.radius',
    'control.statusPill.paddingBlock', 'control.statusPill.paddingInline', 'control.height.sm', 'control.height.lg',
    'control.toolCard.ambientRowMinBlockSize', 'control.flowChat.streamViewportBlockSize', 'space.1', 'space.2', 'space.6'],
} as const satisfies ComponentMeta;

export const flowChatRuntimeStatusMeta = {
  category: 'flow-chat', name: 'FlowChatRuntimeStatus', maturity: 'stable',
  description: 'A resident runtime-status view with host-controlled visibility and submission delay.',
  props: [{ name: 'label', type: 'string' }, { name: 'visible', type: 'boolean' }, { name: 'revealDelayMs', type: 'number' }],
  states: ['visible', 'hidden'], tokens,
} as const satisfies ComponentMeta;

export const flowGroupMeta = {
  category: 'flow-chat', name: 'FlowGroup', maturity: 'stable',
  description: 'A controlled collection with capsule or bound file-revision summaries, shared disclosure and natural-height content.',
  props: [{ name: 'expanded', type: 'boolean' }, { name: 'summary', type: 'string' },
    { name: 'leading', type: 'ReactNode' }, { name: 'onExpandedChange', type: '(expanded: boolean) => void' },
    { name: 'itemCount', type: 'number' }, { name: 'receiveFeedback', type: 'FlowGroupReceiveFeedback' },
    { name: 'contentProps', type: 'HTMLAttributes<HTMLDivElement>' },
    { name: 'browser', type: 'FlowGroupBrowserProps' },
    { name: 'fileRevision', type: 'FlowGroupFileRevision' },
    { name: 'placement', type: "'standalone' | 'inline'", defaultValue: 'standalone' },
    { name: 'bounded', type: 'boolean', defaultValue: 'false' }],
  states: ['collapsed', 'expanded', 'streaming', 'file-collapsed', 'file-expanded', 'file-error'],
  tokens: [...exploreGroupMeta.tokens, 'layout.scrollArea.fadeExtent', 'motion.duration.fast', 'motion.easing.standard',
    'color.surface.panel', 'color.border.default', 'color.border.strong', 'color.status.danger.content',
    'control.activityItem.surfaceHeight', 'control.activityItem.surfaceRadius', 'type.body.xs.fontSize'],
} as const satisfies ComponentMeta;

export const contextLoadGroupMeta = {
  ...exploreGroupMeta,
  name: 'ContextLoadGroup',
  description: 'A controlled context-loading group for skills, tool specifications and capability discovery.',
  props: exploreGroupMeta.props.filter(prop => prop.name !== 'summaryItems'),
} as const satisfies ComponentMeta;
