import type { AnyFlowItem, FlowItem, FlowToolItem } from '../../types/flow-chat';
import { isFlowGroupMemberActive } from '../../grouping/lifecycle';
import { getToolItemCardConfig, isToolCapsule } from '../../tool-cards/toolCardMetadata';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { estimateFlowItemHeight } from './virtualItemHeightEstimators';

const SEGMENT_ITEMS = 16;

export interface FlowGroupRenderSegment {
  key: string;
  items: FlowItem[];
  startIndex: number;
  estimatedHeightPx: number;
}

const isCapsule = (item: FlowItem) => item.type === 'tool' && isToolCapsule(getEffectiveToolName(item as FlowToolItem));

export function estimateFlowGroupItemsHeight(items: readonly FlowItem[]): number {
  return items.reduce((total, item, index) => {
    if (item.type === 'thinking' && !isFlowGroupMemberActive(item) && index < items.length - 1) return total;
    // Settled ambient rows use about 22px of content plus a 12px paragraph gap.
    // This is an estimate,
    // never rendered typography; actual content takes over on activation.
    if (item.type === 'tool' && !isFlowGroupMemberActive(item)
      && getToolItemCardConfig(item as FlowToolItem).attention === 'ambient' && !isCapsule(item)) return total + 34;
    return total + estimateFlowItemHeight(item as AnyFlowItem).heightPx;
  }, 0);
}

/** Stable append boundaries keep reasoning beside its successor and capsule runs together. */
export function buildFlowGroupRenderSegments(items: readonly FlowItem[]): FlowGroupRenderSegment[] {
  const segments: FlowGroupRenderSegment[] = [];
  let start = 0;
  const append = (end: number) => {
    const members = items.slice(start, end);
    segments.push({ key: members[0].id, items: members, startIndex: start,
      estimatedHeightPx: estimateFlowGroupItemsHeight(members),
    });
    start = end;
  };
  for (let index = 1; index < items.length; index += 1) {
    if (index - start >= SEGMENT_ITEMS && items[index - 1].type !== 'thinking'
      && !(isCapsule(items[index - 1]) && isCapsule(items[index]))) append(index);
  }
  if (start < items.length) append(items.length);
  return segments;
}
