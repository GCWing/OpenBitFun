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

const memberKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);

export function captureFlowGroupFeedbackSnapshot(items: readonly VirtualItem[], scope: string | undefined): FeedbackSnapshot {
  const activeMembers = new Set<string>();
  const groupedMembers = new Set<string>();
  for (const item of items) {
    for (const group of getVirtualItemFlowGroups(item)) {
      group.allItems.forEach(member => groupedMembers.add(memberKey(item.turnId, member.id)));
    }
    if (item.type !== 'model-round' || item.isTurnComplete) continue;
    for (const member of getModelRoundActiveItems(item.data)) {
      if (member.type === 'tool' && ((member as FlowToolItem).isParamsStreaming
        || ['pending', 'queued', 'preparing', 'running', 'streaming', 'pending_confirmation'].includes(member.status))) {
        activeMembers.add(memberKey(item.turnId, member.id));
      }
    }
  }
  return { scope, activeMembers, groupedMembers };
}

/** Legacy collection feedback; live windows already show arrivals without a pulse. */
export function collectFlowGroupReceiveFeedback(previous: FeedbackSnapshot | undefined, items: readonly VirtualItem[], scope: string | undefined): ReadonlyMap<string, FlowGroupReceiveFeedback> {
  const receipts = new Map<string, FlowGroupReceiveFeedback>();
  if (!previous || previous.scope !== scope) return receipts;
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
