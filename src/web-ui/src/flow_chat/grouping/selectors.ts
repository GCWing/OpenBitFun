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

let lastIndexedItems: readonly VirtualItem[] = [];
let lastIndexedById = new Map<string, FlowGroupLocation>();
let lastIndexedByMemberId = new Map<string, FlowGroupLocation>();
let lastIndexedByTurnId = new Map<string, FlowGroupLocation[]>();

/** One ownership index for disclosure and navigation, including merged legacy aliases. */
export function indexFlowGroups(items: readonly VirtualItem[]) {
  if (items === lastIndexedItems) {
    return { byId: lastIndexedById, byMemberId: lastIndexedByMemberId, byTurnId: lastIndexedByTurnId };
  }

  let prefixLen = 0;
  const maxPrefix = Math.min(lastIndexedItems.length, items.length);
  while (prefixLen < maxPrefix && lastIndexedItems[prefixLen] === items[prefixLen]) {
    prefixLen += 1;
  }

  // Only reuse prefix maps when strictly appending or mutating the tail (no removed items from the replaced suffix)
  const canReusePrefix = prefixLen > 0 && prefixLen >= lastIndexedItems.length - 2;
  const byId = canReusePrefix ? new Map(lastIndexedById) : new Map<string, FlowGroupLocation>();
  const byMemberId = canReusePrefix ? new Map(lastIndexedByMemberId) : new Map<string, FlowGroupLocation>();
  const byTurnId = new Map<string, FlowGroupLocation[]>();

  if (canReusePrefix) {
    // Remove entries from the replaced suffix of lastIndexedItems before indexing the new suffix
    const affectedTurnIds = new Set<string>();
    for (let i = prefixLen; i < lastIndexedItems.length; i += 1) {
      const oldItem = lastIndexedItems[i];
      affectedTurnIds.add(oldItem.turnId);
      for (const group of getVirtualItemFlowGroups(oldItem)) {
        for (const id of getFlowGroupStateIds(group)) byId.delete(id);
        byId.delete(group.groupId);
        for (const member of group.allItems) {
          if (byMemberId.get(member.id)?.virtualIndex === i) {
            byMemberId.delete(member.id);
          }
        }
      }
    }
    for (let i = prefixLen; i < items.length; i += 1) {
      affectedTurnIds.add(items[i].turnId);
    }
    for (const [turnId, locations] of lastIndexedByTurnId) {
      if (!affectedTurnIds.has(turnId)) {
        byTurnId.set(turnId, locations);
      } else {
        const kept = locations.filter(loc => loc.virtualIndex < prefixLen);
        if (kept.length > 0) byTurnId.set(turnId, kept);
      }
    }
  }

  const startIndex = canReusePrefix ? prefixLen : 0;
  for (let virtualIndex = startIndex; virtualIndex < items.length; virtualIndex += 1) {
    const item = items[virtualIndex];
    for (const group of getVirtualItemFlowGroups(item)) {
      const location = { group, turnId: item.turnId, virtualIndex };
      for (const id of getFlowGroupStateIds(group)) byId.set(id, location);
      byId.set(group.groupId, location);
      for (const member of group.allItems) if (!byMemberId.has(member.id)) byMemberId.set(member.id, location);
      const turnGroups = byTurnId.get(item.turnId) ?? [];
      turnGroups.push(location);
      byTurnId.set(item.turnId, turnGroups);
    }
  }

  lastIndexedItems = items;
  lastIndexedById = byId;
  lastIndexedByMemberId = byMemberId;
  lastIndexedByTurnId = byTurnId;
  return { byId, byMemberId, byTurnId };
}
