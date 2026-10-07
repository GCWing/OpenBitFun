import type { VirtualItem } from '../types/flow-chat-projection';
import { getModelRoundFlowGroups } from './roundGroups';
import { getFlowGroupStateIds, type FlowGroupBase, type FlowGroupData } from './types';

export function getVirtualItemFlowGroups(item: VirtualItem): FlowGroupData[] {
  if (item.type === 'explore-group') return [item.data];
  if (item.type === 'model-round') return getModelRoundFlowGroups(item.data, item.projectedGroups);
  return [];
}

export interface FlowGroupLocation {
  group: FlowGroupBase;
  turnId: string;
  virtualIndex: number;
}

/** One ownership index for disclosure and navigation, including merged legacy aliases. */
export function indexFlowGroups(items: readonly VirtualItem[]) {
  const byId = new Map<string, FlowGroupLocation>();
  const byMemberId = new Map<string, FlowGroupLocation>();
  const byTurnId = new Map<string, FlowGroupLocation[]>();
  items.forEach((item, virtualIndex) => {
    for (const group of getVirtualItemFlowGroups(item)) {
      const location = { group, turnId: item.turnId, virtualIndex };
      for (const id of getFlowGroupStateIds(group)) byId.set(id, location);
      byId.set(group.groupId, location);
      for (const member of group.allItems) if (!byMemberId.has(member.id)) byMemberId.set(member.id, location);
      const turnGroups = byTurnId.get(item.turnId) ?? [];
      turnGroups.push(location);
      byTurnId.set(item.turnId, turnGroups);
    }
  });
  return { byId, byMemberId, byTurnId };
}
