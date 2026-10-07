import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getToolItemCardConfig, isToolCapsule } from '../../tool-cards/toolCardMetadata';
import type { FlowThinkingItem, FlowToolItem } from '../../types/flow-chat';
import { awaitsApproval } from '../../grouping/activityClassification';
import { getProjectedModelRoundGroups, hasModelRoundLeadingControls } from '../../grouping/roundGroups';
import { getKnownVirtualItemHeightPx } from './virtualItemHeightEstimators';

/** Skip only rows already known to occupy zero pixels, keeping every virtual key. */
export function getNextVisibleVirtualItemIndexes(items: readonly VirtualItem[]): number[] {
  const indexes = new Array<number>(items.length);
  let next = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    indexes[index] = next;
    if (getKnownVirtualItemHeightPx(items[index]) !== 0) next = index;
  }
  return indexes;
}

function boundaryToolItem(
  item: VirtualItem | undefined,
  edge: 'first' | 'last',
): FlowToolItem | undefined {
  if (item?.type !== 'model-round') {
    return undefined;
  }

  if (edge === 'first' && hasModelRoundLeadingControls(item.data)) return undefined;
  if (edge === 'last' && (item.canvasArtifactItems?.length || (item.isLastRound && item.isTurnComplete))) {
    return undefined;
  }

  // Use exactly the active, visible projection rendered by ModelRoundItem.
  const groups = getProjectedModelRoundGroups(item);
  let group = edge === 'first' ? groups[0] : groups.at(-1);
  if (edge === 'first' && group?.type === 'critical' && group.item.type === 'thinking') {
    const thinking = group.item as FlowThinkingItem;
    const successor = groups[1];
    // Only settled reasoning attached to its immediate tool successor is transparent.
    // Standalone, streaming, explicitly opened and multiple thoughts remain boundaries.
    if (!thinking.isStreaming && thinking.status === 'completed'
      && !item.layoutHints?.expandedThinkingItemIds.includes(thinking.id)
      && successor?.type === 'critical' && successor.item.type === 'tool') {
      group = successor;
    }
  }
  return group?.type === 'critical' && group.item.type === 'tool' ? group.item as FlowToolItem : undefined;
}

function isAmbientTool(
  item: VirtualItem,
  edge: 'first' | 'last',
  pendingPermissionToolCallIds?: ReadonlySet<string>,
): boolean {
  const toolItem = boundaryToolItem(item, edge);
  const config = toolItem && getToolItemCardConfig(toolItem);
  return Boolean(
    toolItem
    && config?.attention === 'ambient'
    && !isToolCapsule(config.toolName)
    && !awaitsApproval(toolItem)
    && !pendingPermissionToolCallIds?.has(toolItem.toolCall.id)
  );
}

/**
 * Model rounds are runtime structure, not a visual section boundary. Preserve a
 * text-like rhythm only when two adjacent round rows in the same user Turn meet
 * at ambient tools. Prominent tools such as Task/subagent cards retain their
 * flow-item gap even though virtualization renders them in separate DOM rows.
 */
export function isAmbientToolRunContinuationAfter(
  item: VirtualItem | undefined,
  nextItem: VirtualItem | undefined,
  pendingPermissionToolCallIds?: ReadonlySet<string>,
): boolean {
  return Boolean(
    item?.type === 'model-round'
    && nextItem?.type === 'model-round'
    && item.turnId === nextItem.turnId
    && isAmbientTool(item, 'last', pendingPermissionToolCallIds)
    && isAmbientTool(nextItem, 'first', pendingPermissionToolCallIds)
  );
}
