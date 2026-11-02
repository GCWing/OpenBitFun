import type { VirtualItem } from '../types/flow-chat-projection';
import type { FlowItem, ModelRound } from '../types/flow-chat';
import type { FlowGroupData, ModelRoundItemGroup } from './types';
import { getFlowGroupCategory, getFlowGroupStateIds } from './types';
import { canContinueFlowGroup, flowGroupPolicies, hasPendingFlowGroupClassification, joinedFlowGroupCategory } from './policies';
import { flowGroupLifecycle } from './lifecycle';
import { buildInlineFlowGroupData, getModelRoundFlowGroups, getProjectedModelRoundGroups,
  flowGroupCompanionStart, hasModelRoundLeadingControls, isFlowGroupCompanion, isModelRoundGroupingDisabled, projectedFlowGroup } from './roundGroups';

/** Count only until the policy minimum; the shared threshold helper copies the item list. */
function reachesFlowGroupThreshold(category: ReturnType<typeof getFlowGroupCategory>, items: readonly FlowItem[]): boolean {
  const minimum = flowGroupPolicies[category].minimumItems;
  let collected = 0;
  for (const item of items) {
    if (item.type === 'tool' && ++collected >= minimum) return true;
  }
  return false;
}

/** Add this group's disclosure identities without rebuilding intermediate arrays. */
function collectSourceGroupIds(group: FlowGroupData, ids: Set<string>): void {
  for (const id of getFlowGroupStateIds(group)) ids.add(id);
  // A settled pure round may previously have rendered an inline group.
  if (group.sourceGroupIds) return;
  for (const round of group.rounds) {
    ids.add(round.id);
    for (const source of getModelRoundFlowGroups(round)) ids.add(source.groupId);
  }
}

function sourceGroupIds(group: FlowGroupData): readonly string[] {
  const ids = new Set<string>();
  collectSourceGroupIds(group, ids);
  return [...ids];
}

/** Finalize once per run instead of repeatedly copying and recounting its growing prefix. */
function mergeFlowGroupRun(parts: readonly FlowGroupData[]): FlowGroupData {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const mergedIds = new Set<string>();
  const rounds: ModelRound[] = [];
  const allItems: FlowItem[] = [];
  let category: ReturnType<typeof getFlowGroupCategory> | undefined;
  let isGroupStreaming = false;
  for (const part of parts) {
    category = joinedFlowGroupCategory(category, getFlowGroupCategory(part));
    for (const id of getFlowGroupStateIds(part)) mergedIds.add(id);
    // Recorded aliases already cover the rounds they were derived from.
    const inferFromRounds = part.sourceGroupIds === undefined;
    for (const round of part.rounds) {
      rounds.push(round);
      if (!inferFromRounds) continue;
      mergedIds.add(round.id);
      for (const source of getModelRoundFlowGroups(round)) mergedIds.add(source.groupId);
    }
    for (const item of part.allItems) allItems.push(item);
    if (part.isGroupStreaming) isGroupStreaming = true;
  }
  return flowGroupPolicies[category ?? getFlowGroupCategory(first)].create({
    ...first,
    sourceGroupIds: [...mergedIds],
    rounds,
    allItems,
    isGroupStreaming,
    isLastGroupInTurn: last.isLastGroupInTurn,
    wasCutByCritical: last.wasCutByCritical,
  });
}

/**
 * The earliest group owns each consecutive semantic run. Mixed model-round rows
 * retain their keys and critical contents; no recorded data is moved or mutated.
 */
export function projectAdjacentFlowGroups(items: readonly VirtualItem[], options: { isTurnComplete?: boolean } = {}): VirtualItem[] {
  const projected: (VirtualItem | undefined)[] = [];
  const roundUpdates: (() => void)[] = [];
  let turnId: string | undefined;
  let turnComplete = options.isTurnComplete;
  let pending: { item: FlowItem; remove: () => void }[] = [];
  let owner: {
    parts: FlowGroupData[];
    update: (data: FlowGroupData) => void;
    removeCollected: (() => void)[];
  } | undefined;
  const flush = (sealed = true) => {
    if (owner) {
      const data = owner.parts.length > 1 ? mergeFlowGroupRun(owner.parts) : owner.parts[0];
      if (reachesFlowGroupThreshold(getFlowGroupCategory(data), data.allItems)) {
        owner.update({ ...data, ...flowGroupLifecycle(data.allItems, sealed) });
        owner.removeCollected.forEach(remove => remove());
      }
    }
    owner = undefined;
  };
  const collectOpenTailThinking = () => {
    // Only a tail with no successor is provisionally owned by the active run.
    // Once text or a noncollectible card arrives, reasoning belongs beside that
    // visible continuation rather than at the end of the preceding group.
    if (!owner || pending.length === 0 || pending.some(entry => entry.item.type !== 'thinking')) return;
    const companions = pending.splice(0);
    const last = owner.parts[owner.parts.length - 1];
    owner.parts[owner.parts.length - 1] = {
      ...last, allItems: [...last.allItems, ...companions.map(entry => entry.item)],
    };
    owner.removeCollected.push(...companions.map(entry => entry.remove));
  };
  const boundary = () => {
    flush();
    pending = [];
  };
  const collect = (data: FlowGroupData, update: (data: FlowGroupData) => void, remove: () => void) => {
    const continuing = owner !== undefined
      && joinedFlowGroupCategory(getFlowGroupCategory(owner.parts[0]), getFlowGroupCategory(data)) !== undefined
      && canContinueFlowGroup(getFlowGroupCategory(data), owner.parts[0].allItems, data.allItems);
    if (!continuing) flush();
    const companions = pending.slice(flowGroupCompanionStart(pending.map(entry => entry.item), continuing));
    pending = [];
    const next = companions.length ? flowGroupPolicies[getFlowGroupCategory(data)].create({
      ...data, allItems: [...companions.map(entry => entry.item), ...data.allItems],
    }) : data;
    if (owner) {
      owner.parts.push(next);
      owner.removeCollected.push(remove, ...companions.map(entry => entry.remove));
    } else {
      owner = { parts: [next], update, removeCollected: companions.map(entry => entry.remove) };
    }
  };

  for (const item of items) {
    if (turnId !== item.turnId) {
      boundary();
      turnComplete = options.isTurnComplete;
    }
    turnId = item.turnId;
    if (item.type === 'explore-group') {
      const index = projected.length;
      const data = { ...item.data, sourceGroupIds: [...sourceGroupIds(item.data)] };
      projected.push({ ...item, data });
      collect(data, next => {
        // Keep the legacy virtual-row kind and key for standalone exploration.
        if (next.category === undefined || next.category === 'explore') projected[index] = { ...item, data: next };
      }, () => { projected[index] = undefined; });
      continue;
    }
    if (item.type !== 'model-round') {
      boundary();
      projected.push(item);
      continue;
    }

    const disabled = isModelRoundGroupingDisabled(item.data);
    turnComplete = options.isTurnComplete ?? item.isTurnComplete;
    if (disabled || hasModelRoundLeadingControls(item.data)) boundary();
    const index = projected.length;
    projected.push(item);
    const groups = getProjectedModelRoundGroups(item, true);
    const firstExploreIndex = groups.findIndex(group => group.type === 'explore');
    const renderedGroups: (ModelRoundItemGroup | undefined)[] = [...groups];
    let changed = groups.some(group => group.type !== 'critical');
    // A long prose-only round can join a later group. Finalize each row once,
    // not once per moved paragraph, and retain its original virtual key.
    roundUpdates.push(() => {
      if (changed) projected[index] = { ...item, projectedGroups: renderedGroups.filter(
        (group): group is ModelRoundItemGroup => group !== undefined,
      ) };
    });
    groups.forEach((group, groupIndex) => {
      const remove = () => { renderedGroups[groupIndex] = undefined; changed = true; };
      if (group.type === 'critical') {
        if (!disabled && isFlowGroupCompanion(group.item)) {
          pending.push({ item: group.item, remove });
        }
        else if (!disabled && hasPendingFlowGroupClassification(group.item,
          owner ? getFlowGroupCategory(owner.parts[0]) : undefined)) {
          // Keep this unresolved card native without prematurely closing its predecessor.
          flush(false);
          pending = [];
        }
        else boundary();
        return;
      }
      let data = buildInlineFlowGroupData(item.data.id, group, item.isLastRound && groupIndex === groups.length - 1);
      // Read saved disclosure choices from the previous whole-round projection.
      if (group.type === 'explore' && firstExploreIndex === groupIndex) {
        data = { ...data, sourceGroupIds: [...new Set([...getFlowGroupStateIds(data), item.data.id])] };
      }
      collect(data, next => {
        renderedGroups[groupIndex] = projectedFlowGroup(getFlowGroupCategory(next), next.allItems, group.isLast, next);
        changed = true;
      }, remove);
    });
    // Attachments are visible cards; ordinary model-round endings are not boundaries.
    if (item.canvasArtifactItems?.length || disabled) boundary();
  }
  // Live reasoning stays inside the active window immediately. Trailing prose
  // stays outside until a following card proves it is not the final answer.
  collectOpenTailThinking();
  flush(turnComplete ?? true);
  roundUpdates.forEach(update => update());

  // Thresholds apply after cross-round adjacency; a single context call stays native.
  const rendered: VirtualItem[] = [];
  for (const item of projected) {
    if (item === undefined) continue;
    // Rows that already satisfy every group threshold keep their identity.
    if (item.type !== 'model-round' || !item.projectedGroups?.some(
      group => group.type !== 'critical' && !reachesFlowGroupThreshold(group.type, group.items))) {
      rendered.push(item);
      continue;
    }
    rendered.push({ ...item, projectedGroups: item.projectedGroups.flatMap((group): ModelRoundItemGroup[] =>
      group.type !== 'critical' && !reachesFlowGroupThreshold(group.type, group.items)
        ? group.items.map(member => ({ type: 'critical', item: member })) : [group]) });
  }
  return rendered;
}
