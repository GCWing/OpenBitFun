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

/**
 * Stable append boundaries keep reasoning beside its successor and capsule runs together.
 * When `previous` segments are provided, settled prefix segments are reused verbatim by reference,
 * and the growing trailing segment is incrementally updated, enabling high-frequency streaming reuse.
 */
export function buildFlowGroupRenderSegments(
  items: readonly FlowItem[],
  previous?: readonly FlowGroupRenderSegment[],
): FlowGroupRenderSegment[] {
  const segments: FlowGroupRenderSegment[] = [];
  const previousSegments = previous ?? [];
  let start = 0;

  const append = (end: number) => {
    const members = items.slice(start, end);
    const segIdx = segments.length;
    const reusable = previousSegments[segIdx];
    const memberCount = members.length;
    const firstMember = members[0];

    if (reusable && reusable.startIndex === start && reusable.key === (firstMember?.id ?? `seg-${start}`)) {
      const prevItems = reusable.items;
      const prevCount = prevItems.length;

      // Case 1: Closed settled segment where member items are completely unchanged by reference
      if (prevCount === memberCount) {
        let identical = true;
        for (let i = 0; i < memberCount; i += 1) {
          if (prevItems[i] !== members[i]) { identical = false; break; }
        }
        if (identical) {
          segments.push(reusable);
          start = end;
          return;
        }
        // Case 2a: Same length, only the streaming tail object replaced.
        let prefixIdentical = true;
        for (let i = 0; i < memberCount - 1; i += 1) {
          if (prevItems[i] !== members[i]) { prefixIdentical = false; break; }
        }
        if (prefixIdentical) {
          reusable.items = members;
          reusable.estimatedHeightPx = estimateFlowGroupItemsHeight(members);
          segments.push(reusable);
          start = end;
          return;
        }
      }
      // Case 2b: Growing by appended items — reuse cached height and add only the delta.
      else if (prevCount < memberCount) {
        let prefixIdentical = true;
        for (let i = 0; i < prevCount; i += 1) {
          if (prevItems[i] !== members[i]) { prefixIdentical = false; break; }
        }
        if (prefixIdentical) {
          reusable.items = members;
          reusable.estimatedHeightPx = reusable.estimatedHeightPx
            + estimateFlowGroupItemsHeight(members.slice(prevCount));
          segments.push(reusable);
          start = end;
          return;
        }
      }
    }

    // Case 3: Fresh segment
    segments.push({
      key: firstMember?.id ?? `seg-${start}`,
      items: members,
      startIndex: start,
      estimatedHeightPx: estimateFlowGroupItemsHeight(members),
    });
    start = end;
  };

  for (let index = 1; index < items.length; index += 1) {
    if (
      index - start >= SEGMENT_ITEMS &&
      items[index - 1].type !== 'thinking' &&
      !(isCapsule(items[index - 1]) && isCapsule(items[index]))
    ) {
      append(index);
    }
  }
  if (start < items.length) {
    append(items.length);
  }

  return segments;
}
