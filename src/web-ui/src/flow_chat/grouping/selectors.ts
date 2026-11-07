import type { VirtualItem } from '../types/flow-chat-projection';
import { getModelRoundFlowGroups } from './roundGroups';
import { getFlowGroupStateIds, type FlowGroupBase, type FlowGroupData } from './types';

const virtualItemFlowGroupsCache = new WeakMap<VirtualItem, FlowGroupData[]>();
const emptyFlowGroups: FlowGroupData[] = [];

export function getVirtualItemFlowGroups(item: VirtualItem): FlowGroupData[] {
  const cached = virtualItemFlowGroupsCache.get(item);
  if (cached) return cached;
  let result: FlowGroupData[];
  if (item.type === 'explore-group') {
    result = [item.data];
  } else if (item.type === 'model-round') {
    result = getModelRoundFlowGroups(item.data, item.projectedGroups);
  } else {
    return emptyFlowGroups;
  }
  virtualItemFlowGroupsCache.set(item, result);
  return result;
}

export interface FlowGroupLocation {
  group: FlowGroupBase;
  turnId: string;
  virtualIndex: number;
}

interface FlowGroupIndex {
  byId: Map<string, FlowGroupLocation>;
  byMemberId: Map<string, FlowGroupLocation>;
  byTurnId: Map<string, FlowGroupLocation[]>;
}

const flowGroupIndexCache = new WeakMap<readonly VirtualItem[], FlowGroupIndex>();

/** One ownership index for disclosure and navigation, including merged legacy aliases. */
export function indexFlowGroups(items: readonly VirtualItem[]): FlowGroupIndex {
  const cached = flowGroupIndexCache.get(items);
  if (cached) return cached;

  // Copying the old maps already costs O(groups). Rebuild from cached per-row
  // groups so removed tails restore shadowed aliases, with no retained old array.
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
  const result = { byId, byMemberId, byTurnId };
  flowGroupIndexCache.set(items, result);
  return result;
}
