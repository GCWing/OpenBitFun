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
 *
 * Streaming ingress only ever appends to the tail, so a previous segment list is
 * reused verbatim for every boundary that is already closed. Only the trailing
 * segment is re-sliced and re-estimated, which keeps chunk cost proportional to
 * the tail instead of the whole collection.
 */
export function buildFlowGroupRenderSegments(
  items: readonly FlowItem[],
  previous?: readonly FlowGroupRenderSegment[],
): FlowGroupRenderSegment[] {
  const segments: FlowGroupRenderSegment[] = [];
  let start = 0;
  // Reuse the longest prefix of previous segments whose members are unchanged.
  // The trailing segment is always rebuilt: it is the one streaming grows.
  if (previous && previous.length > 0) {
    const reusable = previous.length - 1;
    for (let index = 0; index < reusable; index += 1) {
      const segment = previous[index];
      const members = segment.items;
      if (segment.startIndex !== start || start + members.length > items.length) break;
      let same = true;
      for (let offset = 0; offset < members.length; offset += 1) {
        if (items[start + offset] !== members[offset]) { same = false; break; }
      }
      if (!same) break;
      segments.push(segment);
      start += members.length;
    }
  }
  // The tail is rebuilt in place so its identity survives a streaming chunk:
  // only its members and height estimate change, never the segment object.
  const previousTail = previous && previous.length > 0 ? previous[previous.length - 1] : undefined;
  const tail = previousTail && previousTail.startIndex === start ? previousTail : undefined;
  const append = (end: number) => {
    const members = items.slice(start, end);
    if (tail && segments.length === previous!.length - 1) {
      tail.items = members;
      tail.estimatedHeightPx = estimateFlowGroupItemsHeight(members);
      segments.push(tail);
    } else {
      segments.push({ key: members[0].id, items: members, startIndex: start,
        estimatedHeightPx: estimateFlowGroupItemsHeight(members),
      });
    }
    start = end;
  };
  // A reused prefix may end exactly on a boundary; the next segment starts there.
  for (let index = start + 1; index < items.length; index += 1) {
    if (index - start >= SEGMENT_ITEMS && items[index - 1].type !== 'thinking'
      && !(isCapsule(items[index - 1]) && isCapsule(items[index]))) append(index);
  }
  if (start < items.length) append(items.length);
  return segments;
}

/**
 * Memoized segment compilation for a single collection.
 *
 * Streaming re-renders hand the same item array back on every chunk that does
 * not change the projection, and the previous segment list is reused for the
 * closed prefix. Keeping the last result per item array makes those renders
 * free instead of re-walking the collection.
 */
const segmentCache = new WeakMap<readonly FlowItem[], {
  previous: readonly FlowGroupRenderSegment[];
  result: FlowGroupRenderSegment[];
}>();

export function getFlowGroupRenderSegments(
  items: readonly FlowItem[],
  previous?: readonly FlowGroupRenderSegment[],
): FlowGroupRenderSegment[] {
  const cached = segmentCache.get(items);
  if (cached && cached.previous === previous) return cached.result;
  const result = buildFlowGroupRenderSegments(items, previous);
  segmentCache.set(items, { previous: previous ?? [], result });
  return result;
}
