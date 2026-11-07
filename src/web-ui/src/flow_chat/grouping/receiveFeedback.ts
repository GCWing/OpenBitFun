import type { FlowGroupReceiveFeedback } from '@openbitfun/ui/flow-chat';
import type { FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { getModelRoundActiveItems } from './roundGroups';
import { getVirtualItemFlowGroups } from './selectors';

interface FeedbackSnapshot {
  scope: string | undefined;
  activeMembers: ReadonlySet<string>;
  groupedMembers: ReadonlySet<string>;
}

const memberKey = (turnId: string, itemId: string) => `${turnId}\u0000${itemId}`;

const itemFeedbackKeysCache = new WeakMap<VirtualItem, {
  activeKeys: readonly string[];
  groupedKeys: readonly string[];
}>();

function getItemFeedbackKeys(item: VirtualItem) {
  let cached = itemFeedbackKeysCache.get(item);
  if (cached) return cached;
  const groupedKeys: string[] = [];
  for (const group of getVirtualItemFlowGroups(item)) {
    for (const member of group.allItems) {
      groupedKeys.push(memberKey(item.turnId, member.id));
    }
  }
  const activeKeys: string[] = [];
  if (item.type === 'model-round' && !item.isTurnComplete) {
    for (const member of getModelRoundActiveItems(item.data)) {
      if (
        member.type === 'tool' &&
        ((member as FlowToolItem).isParamsStreaming ||
          ['pending', 'queued', 'preparing', 'running', 'streaming', 'pending_confirmation'].includes(member.status))
      ) {
        activeKeys.push(memberKey(item.turnId, member.id));
      }
    }
  }
  cached = { activeKeys, groupedKeys };
  itemFeedbackKeysCache.set(item, cached);
  return cached;
}

export function captureFlowGroupFeedbackSnapshot(items: readonly VirtualItem[], scope: string | undefined): FeedbackSnapshot {
  const activeMembers = new Set<string>();
  const groupedMembers = new Set<string>();
  for (const item of items) {
    if (item.type === 'model-round' && item.isTurnComplete) continue;
    const { activeKeys, groupedKeys } = getItemFeedbackKeys(item);
    for (let i = 0; i < activeKeys.length; i += 1) activeMembers.add(activeKeys[i]);
    for (let i = 0; i < groupedKeys.length; i += 1) groupedMembers.add(groupedKeys[i]);
  }
  return { scope, activeMembers, groupedMembers };
}

/** Legacy collection feedback; live windows already show arrivals without a pulse. */
export function collectFlowGroupReceiveFeedback(previous: FeedbackSnapshot | undefined, items: readonly VirtualItem[], scope: string | undefined): ReadonlyMap<string, FlowGroupReceiveFeedback> {
  const receipts = new Map<string, FlowGroupReceiveFeedback>();
  if (!previous || previous.scope !== scope || previous.activeMembers.size === 0) return receipts;
  for (const item of items) {
    for (const group of getVirtualItemFlowGroups(item)) {
      if (group.phase !== undefined) continue;
      if (!group.allItems.some(member => {
        const key = memberKey(item.turnId, member.id);
        return previous.activeMembers.has(key) && !previous.groupedMembers.has(key);
      })) continue;
      let claimed = false;
      receipts.set(group.groupId, { claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      } });
    }
  }
  return receipts;
}
