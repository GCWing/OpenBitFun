import type { VirtualItem } from '../types/flow-chat-projection';
import type { FlowItem } from '../types/flow-chat';
import type { FlowGroupData, ModelRoundItemGroup } from './types';
import { getFlowGroupCategory, getFlowGroupStateIds } from './types';
import { canContinueFlowGroup, flowGroupPolicies, hasPendingFlowGroupClassification, joinedFlowGroupCategory, meetsFlowGroupThreshold } from './policies';
import { flowGroupLifecycle } from './lifecycle';
import { buildInlineFlowGroupData, getModelRoundFlowGroups, getProjectedModelRoundGroups,
  flowGroupCompanionStart, hasModelRoundLeadingControls, isFlowGroupCompanion, isModelRoundGroupingDisabled, projectedFlowGroup } from './roundGroups';

function sourceGroupIds(group: FlowGroupData): readonly string[] {
  if (group.sourceGroupIds) return getFlowGroupStateIds(group);
  return [...new Set([
    ...getFlowGroupStateIds(group),
    // A settled pure round may previously have rendered an inline group.
    ...group.rounds.flatMap(round => [round.id, ...getModelRoundFlowGroups(round).map(source => source.groupId)]),
  ])];
}

/** Finalize once per run instead of repeatedly copying and recounting its growing prefix. */
function mergeFlowGroupRun(parts: readonly FlowGroupData[]): FlowGroupData {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const category = parts.reduce<ReturnType<typeof getFlowGroupCategory> | undefined>(
    (joined, part) => joinedFlowGroupCategory(joined, getFlowGroupCategory(part)), undefined,
  ) ?? getFlowGroupCategory(first);
  return flowGroupPolicies[category].create({
    ...first,
    sourceGroupIds: [...new Set(parts.flatMap(part => [...sourceGroupIds(part)]))],
    rounds: parts.flatMap(part => part.rounds),
    allItems: parts.flatMap(part => part.allItems),
    isGroupStreaming: parts.some(part => part.isGroupStreaming),
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
      if (meetsFlowGroupThreshold(getFlowGroupCategory(data), data.allItems)) {
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
  return projected.filter((item): item is VirtualItem => item !== undefined).map(item => {
    if (item.type !== 'model-round' || !item.projectedGroups?.some(group => group.type !== 'critical' && !meetsFlowGroupThreshold(group.type, group.items))) return item;
    return { ...item, projectedGroups: item.projectedGroups.flatMap((group): ModelRoundItemGroup[] =>
      group.type !== 'critical' && !meetsFlowGroupThreshold(group.type, group.items)
        ? group.items.map(member => ({ type: 'critical', item: member })) : [group]) };
  });
}
