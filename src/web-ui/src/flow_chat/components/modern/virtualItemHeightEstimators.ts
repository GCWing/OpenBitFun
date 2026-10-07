/**
 * Pure, data-driven height estimates used before a virtual row mounts.
 *
 * These are deliberately separate from React renderers: TanStack must reserve
 * space for an item before its DOM exists. Once mounted, ResizeObserver/DOM
 * measurement remains authoritative and replaces this estimate.
 */
import type {
  AnyFlowItem,
  FlowToolItem,
} from '../../types/flow-chat';
import type { ToolGroupData, VirtualItem } from '../../store/modernFlowChatStore';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { buildInlineFlowGroupData, getModelRoundActiveItems, getProjectedModelRoundGroups, hasModelRoundLeadingControls } from '../../grouping/roundGroups';
import { isFlowGroupExpanded } from '../../grouping/types';
import { estimateAgentCardColumns } from '../../timeline/agentCardLayout';

export interface VirtualItemHeightEstimateContext {
  /** Width available to the reading column, excluding the scrollbar. */
  availableWidthPx?: number;
  isHistorical?: boolean;
  expandedThinkingItemIds?: readonly string[];
  exploreGroupStates?: ReadonlyMap<string, boolean>;
  groupStates?: ReadonlyMap<string, boolean>;
}

export interface VirtualItemHeightEstimate {
  heightPx: number;
  confidence: 'high' | 'medium' | 'low';
  kind: string;
}

/** Collected rounds keep their virtual identity but have no visible row content. */
export function getKnownVirtualItemHeightPx(item: VirtualItem): number | undefined {
  if (item.timeline) return undefined;
  if (item.type !== 'model-round' || item.projectedGroups?.length !== 0
    || (item.isLastRound && item.isTurnComplete)
    || hasModelRoundLeadingControls(item.data)
    || item.canvasArtifactItems?.length
    || getModelRoundActiveItems(item.data).length === 0) return undefined;
  return 0;
}

const DEFAULT_WIDTH_PX = 900;
const MIN_TEXT_LINE_WIDTH_PX = 24;
const USER_MESSAGE_BASE_HEIGHT_PX = 96;
// typography-audit: allow -- virtualization estimates do not define rendered typography
const USER_MESSAGE_LINE_HEIGHT_PX = 22;
const MODEL_ROUND_BASE_HEIGHT_PX = 80;
const MODEL_ROUND_TEXT_BASE_HEIGHT_PX = 72;
// typography-audit: allow -- virtualization estimates do not define rendered typography
const MODEL_ROUND_TEXT_LINE_HEIGHT_PX = 30;
const TOOL_HEADER_HEIGHT_PX = 38;
const TOOL_COMPACT_HEIGHT_PX = 53;
const TODO_COMPACT_HEIGHT_PX = 24;
const TOOL_EXPANDED_BASE_HEIGHT_PX = 96;
// A 32px unframed header plus the transcript's 8px trailing gap; DOM wins after mount.
const EXPLORE_GROUP_HEADER_HEIGHT_PX = 40;
// The collapsed capsule matches a prominent row, including its two 1px strokes.
const EXPLORE_GROUP_COLLAPSED_HEIGHT_PX = 42;
const ESTIMATED_TEXT_CHARS_PER_LINE = 60;
const TERMINAL_TOOL_NAMES = new Set(['ExecCommand', 'WriteStdin', 'ExecControl']);
const COLLAPSED_TOOL_STATUSES = new Set(['completed', 'cancelled', 'error', 'rejected']);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function widthScale(widthPx: number | undefined): number {
  const width = Math.min(
    DEFAULT_WIDTH_PX,
    Math.max(MIN_TEXT_LINE_WIDTH_PX, widthPx ?? DEFAULT_WIDTH_PX),
  );
  return DEFAULT_WIDTH_PX / width;
}

function estimateTextLines(text: string, widthPx: number | undefined): number {
  return estimateTextLineCount(text.length, widthPx);
}

function estimateTextLineCount(textLength: number, widthPx: number | undefined): number {
  const scale = widthScale(widthPx);
  return Math.max(1, Math.ceil(textLength * scale / ESTIMATED_TEXT_CHARS_PER_LINE));
}

function estimateTextHeight(
  text: string,
  basePx: number,
  lineHeightPx: number,
  widthPx: number | undefined,
): number {
  return basePx + estimateTextLines(text, widthPx) * lineHeightPx;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function toolInput(tool: FlowToolItem): Record<string, unknown> {
  return objectValue(tool.partialParams ?? tool.toolCall?.input);
}

function toolResultText(tool: FlowToolItem): string {
  const result = objectValue(tool.toolResult?.result);
  return stringValue(
    result.output
      ?? result.content
      ?? result.result
      ?? tool.toolResult?.resultForAssistant
      ?? tool.toolResult?.error,
  );
}

function toolContentLength(tool: FlowToolItem): number {
  const input = toolInput(tool);
  const candidates = [
    input.content,
    input.contents,
    input.new_string,
    input.old_string,
    input.command,
    input.cmd,
    input.description,
    toolResultText(tool),
  ];
  return candidates.reduce<number>((total, value) => total + stringValue(value).length, 0);
}

function todoCount(tool: FlowToolItem): number {
  const input = toolInput(tool);
  const result = objectValue(tool.toolResult?.result);
  const todos = input.todos ?? result.todos;
  return Array.isArray(todos) ? todos.length : 0;
}

function isTerminalTool(toolName: string): boolean {
  return TERMINAL_TOOL_NAMES.has(toolName);
}

function isCollapsedByStatus(tool: FlowToolItem): boolean {
  return COLLAPSED_TOOL_STATUSES.has(tool.status);
}

export function estimateFlowItemHeight(
  item: AnyFlowItem,
  context: VirtualItemHeightEstimateContext = {},
): VirtualItemHeightEstimate {
  // A live thought starts as one line even when its parent keeps the body
  // mounted. User expansion is measured after mount, not inferred from length.
  if (item.type === 'thinking' && (item.isStreaming || item.status === 'streaming')) {
    return { heightPx: 40, confidence: 'high', kind: 'thinking-streaming' };
  }
  if (item.type === 'thinking' && !(context.expandedThinkingItemIds ?? []).includes(item.id)) {
    return { heightPx: 40, confidence: 'high', kind: 'thinking-collapsed' };
  }

  if (item.type === 'text' || item.type === 'thinking' || item.type === 'user-steering') {
    return {
      heightPx: clamp(
        estimateTextHeight(item.content, MODEL_ROUND_TEXT_BASE_HEIGHT_PX, MODEL_ROUND_TEXT_LINE_HEIGHT_PX, context.availableWidthPx),
        40,
        3200,
      ),
      confidence: 'medium',
      kind: item.type,
    };
  }

  if (item.type === 'image-analysis') {
    return { heightPx: 320, confidence: 'low', kind: 'image-analysis' };
  }

  if (item.type === 'tool') {
    return estimateToolHeight(item, context);
  }

  return { heightPx: 72, confidence: 'low', kind: 'flow-item' };
}

export function estimateToolHeight(
  tool: FlowToolItem,
  context: VirtualItemHeightEstimateContext = {},
): VirtualItemHeightEstimate {
  const toolName = getEffectiveToolName(tool);
  const contentLength = toolContentLength(tool);
  const collapsed = isCollapsedByStatus(tool);
  const contentLines = estimateTextLineCount(contentLength, context.availableWidthPx);

  if (toolName === 'TodoWrite') {
    const count = todoCount(tool);
    return {
      heightPx: collapsed ? TODO_COMPACT_HEIGHT_PX : clamp(TOOL_EXPANDED_BASE_HEIGHT_PX + count * 30, 96, 360),
      confidence: count > 0 ? 'high' : 'medium',
      kind: 'tool-todo-write',
    };
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'CreateCanvas' || toolName === 'UpdateCanvas') {
    return {
      heightPx: collapsed
        ? TOOL_COMPACT_HEIGHT_PX
        : clamp(TOOL_EXPANDED_BASE_HEIGHT_PX + contentLines * 22, TOOL_EXPANDED_BASE_HEIGHT_PX, 480),
      confidence: contentLength > 0 ? 'high' : 'medium',
      kind: `tool-${toolName.toLowerCase()}`,
    };
  }

  if (isTerminalTool(toolName)) {
    const outputLines = Math.max(1, Math.min(15, contentLines));
    return {
      heightPx: collapsed
        ? TOOL_COMPACT_HEIGHT_PX
        : TOOL_HEADER_HEIGHT_PX + 22 * outputLines + 40,
      confidence: contentLength > 0 ? 'medium' : 'low',
      kind: 'tool-terminal',
    };
  }

  if (collapsed) {
    return { heightPx: TOOL_COMPACT_HEIGHT_PX, confidence: 'medium', kind: 'tool-collapsed' };
  }

  return {
    heightPx: clamp(TOOL_HEADER_HEIGHT_PX + contentLines * 22, 72, 420),
    confidence: 'low',
    kind: 'tool-generic',
  };
}

export function estimateModelRoundHeight(
  item: Extract<VirtualItem, { type: 'model-round' }>,
  context: VirtualItemHeightEstimateContext = {},
): VirtualItemHeightEstimate {
  const flowItems = getModelRoundActiveItems(item.data);
  if (flowItems.length === 0) {
    return { heightPx: 200, confidence: 'low', kind: 'model-round-empty' };
  }
  const groups = getProjectedModelRoundGroups(item);
  if (getKnownVirtualItemHeightPx(item) === 0) {
    return { heightPx: 0, confidence: 'high', kind: 'model-round-collected' };
  }
  const contentHeight = groups.reduce((total, group) => total + (group.type !== 'critical'
    ? estimateFlowGroupHeight(buildInlineFlowGroupData(item.data.id, group, item.isLastRound && group.isLast), context).heightPx
    : estimateFlowItemHeight(group.item as AnyFlowItem, context).heightPx), 0);
  return {
    heightPx: Math.max(MODEL_ROUND_BASE_HEIGHT_PX + contentHeight, 200),
    confidence: flowItems.some(flowItem => flowItem.type === 'tool') ? 'medium' : 'high',
    kind: 'model-round',
  };
}

export function estimateExploreGroupHeight(
  item: { type: 'explore-group'; turnId: string; data: ToolGroupData },
  context: VirtualItemHeightEstimateContext = {},
): VirtualItemHeightEstimate {
  return estimateFlowGroupHeight(item.data, context);
}

export function estimateFlowGroupHeight(data: ToolGroupData, context: VirtualItemHeightEstimateContext = {}): VirtualItemHeightEstimate {
  const isExpanded = isFlowGroupExpanded(data, context.groupStates ?? context.exploreGroupStates);
  // File identity, revision count and two exposed page edges share one header.
  const fileRevisionHeader = 'category' in data && data.category === 'file-edit' ? 44 : undefined;
  const contentHeight = data.allItems.reduce<number>(
    (total, flowItem) => total + estimateFlowItemHeight(flowItem as AnyFlowItem, context).heightPx,
    0,
  );
  return {
    heightPx: isExpanded
      ? (fileRevisionHeader ?? EXPLORE_GROUP_HEADER_HEIGHT_PX) + contentHeight
      : (fileRevisionHeader ?? EXPLORE_GROUP_COLLAPSED_HEIGHT_PX),
    confidence: 'medium',
    kind: isExpanded ? 'explore-group-expanded' : 'explore-group-collapsed',
  };
}

export function estimateVirtualItemHeight(
  item: VirtualItem,
  context: VirtualItemHeightEstimateContext = {},
): VirtualItemHeightEstimate {
  if (item.timeline && item.type === 'model-round') {
    if (item.timeline.layout === 'agent-cards') {
      const thoughts = item.data.items.filter(member => member.type === 'thinking');
      const cardCount = item.data.items.length - thoughts.length;
      const rows = Math.ceil(cardCount / estimateAgentCardColumns(context.availableWidthPx));
      // Identity cards keep two fixed content lines in every execution state.
      // Sum visual rows, not individual cards; DOM owns approvals/wrapped notes.
      return { heightPx: rows * (80 + 12)
        + thoughts.reduce((height, thought) => height + estimateFlowItemHeight(thought, context).heightPx, 0),
        confidence: 'medium', kind: 'timeline-agent-cards' };
    }
    const { kind, expanded, group } = item.timeline;
    const heightPx = kind === 'group-header' ? (group?.category === 'file-edit' ? 52 : expanded ? 48 : 36)
      : kind === 'round-header' ? 48 : kind === 'round-footer' ? 56
        : item.data.items.reduce((height, member) => height + estimateFlowItemHeight(member as AnyFlowItem, context).heightPx, 0);
    return { heightPx: Math.max(1, heightPx), confidence: 'medium', kind: `timeline-${kind}` };
  }
  switch (item.type) {
    case 'user-message':
    case 'user-steering-message':
      return {
        heightPx: clamp(
          estimateTextHeight(item.data.content, USER_MESSAGE_BASE_HEIGHT_PX, USER_MESSAGE_LINE_HEIGHT_PX, context.availableWidthPx),
          96,
          320,
        ),
        confidence: 'high',
        kind: 'user-message',
      };
    case 'model-round':
      return estimateModelRoundHeight(item, {
        ...context,
        expandedThinkingItemIds: item.layoutHints?.expandedThinkingItemIds
          ?? context.expandedThinkingItemIds,
      });
    case 'explore-group':
      return estimateExploreGroupHeight(item, context);
    case 'turn-completion-notice':
      return { heightPx: 120, confidence: 'high', kind: 'turn-completion-notice' };
    case 'turn-failure-notice':
      return { heightPx: 160, confidence: 'medium', kind: 'turn-failure-notice' };
    case 'image-analyzing':
      return { heightPx: 200, confidence: 'low', kind: 'image-analyzing' };
  }
}

export function estimateVirtualItemHeightPx(
  item: VirtualItem,
  context: VirtualItemHeightEstimateContext = {},
): number {
  return estimateVirtualItemHeight(item, context).heightPx;
}
