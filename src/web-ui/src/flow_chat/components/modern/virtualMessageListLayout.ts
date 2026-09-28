import type { AnyFlowItem, FlowItem, FlowToolItem } from '../../types/flow-chat';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { getProjectedModelRoundGroups } from './modelRoundItemGrouping';
import {
  estimateFlowItemHeight as estimateFlowItemHeightByOwner,
  estimateVirtualItemHeight as estimateVirtualItemHeightByOwner,
  type VirtualItemHeightEstimateContext,
} from './virtualItemHeightEstimators';

export type { VirtualItemHeightEstimateContext, VirtualItemHeightEstimate } from './virtualItemHeightEstimators';

export const LIVE_SESSION_DEFAULT_ITEM_HEIGHT_PX = 200;
export const HISTORICAL_SESSION_DEFAULT_ITEM_HEIGHT_PX = 72;
export const HISTORICAL_SESSION_MODEL_ROUND_DEFAULT_ITEM_HEIGHT_PX = 960;
export const INITIAL_HISTORY_RENDER_MIN_TURN_COUNT = 2;
const INITIAL_HISTORY_RENDER_USER_ONLY_LATEST_MIN_TURN_COUNT = 3;
export const INITIAL_HISTORY_RENDER_MIN_ESTIMATED_HEIGHT_PX = 1400;

export function getLeadingVirtualItemIndexDelta<T>(
  previousItems: readonly T[],
  nextItems: readonly T[],
  getStableKey: (item: T) => string,
): number {
  if (previousItems.length === 0 || nextItems.length === 0) {
    return 0;
  }

  const previousFirstKey = getStableKey(previousItems[0]);
  const prependedCount = nextItems.findIndex(item => getStableKey(item) === previousFirstKey);
  if (prependedCount > 0) {
    return -prependedCount;
  }

  const nextFirstKey = getStableKey(nextItems[0]);
  const removedCount = previousItems.findIndex(item => getStableKey(item) === nextFirstKey);
  return removedCount > 0 ? removedCount : 0;
}

export function getVirtualMessageDefaultItemHeight(params: {
  isHistorical: boolean;
  hasCompactHistoricalProjection: boolean;
  hasInitialHistoryModelRoundProjection: boolean;
}): number {
  if (params.hasCompactHistoricalProjection) {
    return HISTORICAL_SESSION_DEFAULT_ITEM_HEIGHT_PX;
  }

  if (params.hasInitialHistoryModelRoundProjection) {
    return HISTORICAL_SESSION_MODEL_ROUND_DEFAULT_ITEM_HEIGHT_PX;
  }

  if (params.isHistorical) {
    return HISTORICAL_SESSION_DEFAULT_ITEM_HEIGHT_PX;
  }

  return LIVE_SESSION_DEFAULT_ITEM_HEIGHT_PX;
}

export function estimateTextHeightFromLength(textLength: number, basePx: number, lineHeightPx: number): number {
  const ESTIMATED_TEXT_CHARS_PER_LINE = 60;
  const lineCount = Math.max(1, Math.ceil(textLength / ESTIMATED_TEXT_CHARS_PER_LINE));
  return basePx + lineCount * lineHeightPx;
}

function describeFlowItemEstimate(
  item: FlowItem,
  index: number,
  totalCount: number,
  expandedThinkingItemIds: readonly string[],
): Record<string, unknown> {
  const content = item.type === 'text' || item.type === 'thinking' || item.type === 'user-steering'
    ? (item as AnyFlowItem & { content: string }).content
    : null;
  return {
    index,
    type: item.type,
    ...(item.type === 'tool'
      ? {
          toolName: getEffectiveToolName(item as FlowToolItem),
          status: item.status,
          isStreaming: (item as FlowToolItem).isParamsStreaming ?? false,
        }
      : {}),
    ...(content === null
      ? {}
      : {
          contentLength: content.length,
          lineCount: content.length === 0 ? 0 : content.split('\n').length,
        }),
    isLastItem: index === totalCount - 1,
    estimatedHeightPx: estimateFlowItemHeightByOwner(item as AnyFlowItem, {
      expandedThinkingItemIds,
    }).heightPx,
  };
}

/** Bounded, content-free estimate details for FlowChat viewport diagnostics. */
export function describeVirtualItemEstimate(item: VirtualItem): Record<string, unknown> {
  if (item.type === 'model-round') {
    const flowItems = getProjectedModelRoundGroups(item).flatMap(group => group.type !== 'critical' ? group.items : [group.item]);
    const expandedThinkingItemIds = item.layoutHints?.expandedThinkingItemIds ?? [];
    const itemEstimates = flowItems.map((flowItem, index) => describeFlowItemEstimate(
      flowItem,
      index,
      flowItems.length,
      expandedThinkingItemIds,
    ));
    return {
      estimateKind: 'model-round',
      isLastRound: item.isLastRound,
      isTurnComplete: item.isTurnComplete,
      isStreaming: item.data.isStreaming,
      expandedThinkingItemIds,
      baseHeightPx: 80,
      contentEstimatePx: itemEstimates.reduce(
        (total, entry) => total + Number(entry.estimatedHeightPx ?? 0),
        0,
      ),
      itemEstimates,
    };
  }

  if (item.type === 'explore-group') {
    const itemEstimates = item.data.allItems.map((flowItem, index) => describeFlowItemEstimate(
      flowItem as AnyFlowItem,
      index,
      item.data.allItems.length,
      [],
    ));
    return {
      estimateKind: 'explore-group',
      itemCount: item.data.allItems.length,
      defaultExpanded: false,
      estimatedHeightPx: estimateVirtualItemHeightByOwner(item).heightPx,
      itemEstimates,
    };
  }

  return { estimateKind: item.type };
}

export function estimateVirtualMessageItemHeight(item: VirtualItem): number {
  return estimateVirtualItemHeightByOwner(item).heightPx;
}

export function estimateVirtualMessageItemHeightWithContext(
  item: VirtualItem,
  context: VirtualItemHeightEstimateContext = {},
): number {
  return estimateVirtualItemHeightByOwner(item, context).heightPx;
}

export interface InitialHistoryRenderWindow {
  items: VirtualItem[];
  startIndex: number;
  omittedEstimatedHeightPx: number;
  trailingOmittedEstimatedHeightPx: number;
  renderedEstimatedHeightPx: number;
  totalEstimatedHeightPx: number;
  isWindowed: boolean;
}

function uniqueTurnCount(items: VirtualItem[]): number {
  const turnIds = new Set<string>();
  items.forEach(item => {
    if (item.turnId) {
      turnIds.add(item.turnId);
    }
  });
  return turnIds.size;
}

function getLatestTurnId(items: VirtualItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turnId = items[index]?.turnId;
    if (turnId) {
      return turnId;
    }
  }
  return null;
}

function latestTurnHasModelRound(items: VirtualItem[]): boolean {
  const latestTurnId = getLatestTurnId(items);
  if (!latestTurnId) {
    return true;
  }

  return items.some(item =>
    item.turnId === latestTurnId &&
    item.type === 'model-round'
  );
}

function getInitialHistoryRenderMinTurnCount(items: VirtualItem[]): number {
  return latestTurnHasModelRound(items)
    ? INITIAL_HISTORY_RENDER_MIN_TURN_COUNT
    : INITIAL_HISTORY_RENDER_USER_ONLY_LATEST_MIN_TURN_COUNT;
}

export function selectInitialHistoryRenderWindow(
  items: VirtualItem[],
  options: {
    minTurnCount?: number;
    minEstimatedHeightPx?: number;
  } = {},
): InitialHistoryRenderWindow {
  const minTurnCount = Math.max(1, Math.floor(options.minTurnCount ?? getInitialHistoryRenderMinTurnCount(items)));
  const minEstimatedHeightPx = Math.max(0, options.minEstimatedHeightPx ?? INITIAL_HISTORY_RENDER_MIN_ESTIMATED_HEIGHT_PX);
  const totalEstimatedHeightPx = items.reduce(
    (total, item) => total + estimateVirtualMessageItemHeight(item),
    0,
  );

  if (items.length === 0 || uniqueTurnCount(items) <= minTurnCount) {
    return {
      items,
      startIndex: 0,
      omittedEstimatedHeightPx: 0,
      trailingOmittedEstimatedHeightPx: 0,
      renderedEstimatedHeightPx: totalEstimatedHeightPx,
      totalEstimatedHeightPx,
      isWindowed: false,
    };
  }

  let startIndex = items.length;
  let renderedEstimatedHeightPx = 0;
  const includedTurnIds = new Set<string>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    startIndex = index;
    renderedEstimatedHeightPx += estimateVirtualMessageItemHeight(item);
    if (item.turnId) {
      includedTurnIds.add(item.turnId);
    }

    const previousItem = items[index - 1];
    const stillInsideSameTurn =
      Boolean(item.turnId) &&
      previousItem?.turnId === item.turnId;
    if (
      !stillInsideSameTurn &&
      includedTurnIds.size >= minTurnCount &&
      renderedEstimatedHeightPx >= minEstimatedHeightPx
    ) {
      break;
    }
  }

  const omittedEstimatedHeightPx = items
    .slice(0, startIndex)
    .reduce((total, item) => total + estimateVirtualMessageItemHeight(item), 0);

  return {
    items: items.slice(startIndex),
    startIndex,
    omittedEstimatedHeightPx,
    trailingOmittedEstimatedHeightPx: 0,
    renderedEstimatedHeightPx,
    totalEstimatedHeightPx,
    isWindowed: startIndex > 0,
  };
}
