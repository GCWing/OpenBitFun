import type { FlowItem, FlowTextItem, FlowToolItem } from '../types/flow-chat';
import { READ_TOOL_NAMES, SEARCH_TOOL_NAMES } from '../tool-cards/toolCardMetadata';
import { getEffectiveToolName } from './toolInvocationIdentity';

/** Shared by leaf cards and transcript composition so hidden cards leave no row. */
export function isToolCardVisible(toolItem: FlowToolItem): boolean {
  const failed = toolItem.status === 'error'
    || (toolItem.status === 'completed' && toolItem.toolResult?.success === false);
  if (!failed) return true;
  const toolName = getEffectiveToolName(toolItem);
  return !READ_TOOL_NAMES.has(toolName) && !SEARCH_TOOL_NAMES.has(toolName);
}

/** Presentation only: retain the recorded items and the identity of visible entries. */
export function isFlowItemVisible(item: FlowItem): boolean {
  if (item.type === 'text') {
    const textItem = item as FlowTextItem;
    const content = typeof textItem.content === 'string' ? textItem.content : String(textItem.content || '');
    return content.trim().length > 0;
  }
  return item.type !== 'tool' || isToolCardVisible(item as FlowToolItem);
}
