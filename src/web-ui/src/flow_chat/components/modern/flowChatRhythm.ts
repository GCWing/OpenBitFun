import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getToolItemCardConfig } from '../../tool-cards/toolCardMetadata';
import type { FlowToolItem } from '../../types/flow-chat';

function boundaryToolItem(
  item: VirtualItem | undefined,
  edge: 'first' | 'last',
): FlowToolItem | undefined {
  if (item?.type !== 'model-round') {
    return undefined;
  }

  const visibleItems = item.data.items.filter(flowItem => flowItem.type !== 'user-steering');
  const flowItem = edge === 'first'
    ? visibleItems[0]
    : visibleItems.at(-1);

  return flowItem?.type === 'tool' ? flowItem : undefined;
}

function isAmbientTool(toolItem: FlowToolItem | undefined): boolean {
  return Boolean(
    toolItem
    && getToolItemCardConfig(toolItem).attention === 'ambient'
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
): boolean {
  return Boolean(
    item?.type === 'model-round'
    && nextItem?.type === 'model-round'
    && item.turnId === nextItem.turnId
    && isAmbientTool(boundaryToolItem(item, 'last'))
    && isAmbientTool(boundaryToolItem(nextItem, 'first'))
  );
}
