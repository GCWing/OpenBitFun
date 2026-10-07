import type { FlowItem, FlowTextItem, FlowToolItem, ModelRound, ModelRoundAttempt } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { canvasArtifactReferenceFromToolItem } from '../utils/canvasArtifactPresentation';
import { isFlowItemVisible } from '../utils/flowItemVisibility';
import { canContinueFlowGroup, classifyFlowGroupItem, flowGroupPolicies, joinedFlowGroupCategory, meetsFlowGroupThreshold, type FlowGroupPolicyOptions } from './policies';
import { isFlowGroupMemberActive } from './lifecycle';
import { isShellActivity } from './activityClassification';
import { parseDeepResearchContent } from '../deep-research/deepResearchProtocol';
import type { ExploreGroupData, FlowGroupCategory, FlowGroupData, GroupedFlowItems, ModelRoundItemGroup } from './types';

export type { ModelRoundItemGroup } from './types';
export { getFlowGroupStateIds, isFlowGroupExpanded } from './types';
export { getFlowGroupStateIds as getExploreGroupStateIds, isFlowGroupExpanded as isExploreGroupExpanded } from './types';

/** Match the visible attempt rather than collecting failed retry history. */
export function getModelRoundActiveItems(round: Pick<ModelRound, 'items' | 'attempts'>): FlowItem[] {
  const activeAttempt = round.attempts?.reduce<ModelRoundAttempt | undefined>((latest, attempt) => (
    !attempt.diagnostic && (!latest || attempt.index >= latest.index) ? attempt : latest
  ), undefined);
  return activeAttempt?.items ?? (round.attempts?.length ? [] : round.items ?? []);
}

export function hasModelRoundNarrative(round: Pick<ModelRound, 'items' | 'attempts'>): boolean {
  return getModelRoundActiveItems(round).some(item => (
    (item.type === 'text' || item.type === 'thinking') && isFlowItemVisible(item)
  ));
}

export function hasModelRoundLeadingControls(round: ModelRound): boolean {
  return Boolean(round.renderHints?.continuedAfterInterruption || round.historyRounds?.length
    || (round.attempts?.length ?? 0) > 1 || round.attempts?.some(attempt => attempt.diagnostic));
}

/** Read old native retry hints as display metadata without rewriting saved records. */
export function isModelRoundGroupingDisabled(round: Pick<ModelRound, 'id' | 'renderHints' | 'attempts'>): boolean {
  if (round.renderHints?.disableExploreGrouping !== true) return false;
  // Preserve explicit policies, including sources advertised by a newer host.
  if (round.renderHints.disableExploreGroupingSource !== undefined) return true;
  // Only the native Runtime's recorded attempt identities prove the old automatic rule.
  const attempts = round.attempts ?? [];
  const legacyRetryHint = attempts.length > 1
    && attempts.every(attempt => attempt.id === `${round.id}:attempt:${attempt.index}`);
  return !legacyRetryHint;
}

/** Ordinary prose and reasoning do not end a tool run. Protocol text renders cards. */
export function isFlowGroupCompanion(item: FlowItem): boolean {
  return item.type === 'thinking' || (item.type === 'text'
    && !parseDeepResearchContent((item as FlowTextItem).content ?? '').hasProtocol);
}

/** Keep an introductory explanation visible; its following reasoning may join the first call. */
export function flowGroupCompanionStart(items: readonly FlowItem[], continuing: boolean): number {
  if (continuing) return 0;
  let start = items.length;
  while (start > 0 && items[start - 1].type === 'thinking') start--;
  return start;
}

export function buildInlineFlowGroupData(roundId: string, group: GroupedFlowItems, isLastGroupInTurn = group.isLast): FlowGroupData {
  if (group.projection) return group.projection;
  const tools = group.items.filter(item => item.type === 'tool');
  const anchor = tools[0];
  // Shell is only a legacy disclosure-key namespace, never a separate category.
  const sourceCategory = (item: FlowItem) => item.type === 'tool' && isShellActivity(item as FlowToolItem)
    ? 'shell' : classifyFlowGroupItem(item) ?? group.type;
  return flowGroupPolicies[group.type].create({
    // The first call keeps its original identity when an arriving Read joins Shell.
    groupId: `${roundId}:${sourceCategory(anchor)}:${anchor.id}`,
    // Preserve expansion of groups previously split at prose/reasoning boundaries.
    sourceGroupIds: tools.map(item => `${roundId}:${sourceCategory(item)}:${item.id}`),
    rounds: [], allItems: group.items,
    isGroupStreaming: group.items.some(isFlowGroupMemberActive),
    isLastGroupInTurn,
    wasCutByCritical: !group.isLast || !isLastGroupInTurn,
  });
}

/** The category and projection are constructed together by the selected policy. */
export function projectedFlowGroup(category: FlowGroupCategory, items: FlowItem[], isLast: boolean, projection?: FlowGroupData): GroupedFlowItems {
  return { type: category, items, isLast, ...(projection ? { projection } : {}) } as GroupedFlowItems;
}

export function getModelRoundFlowGroups(round: ModelRound, projectedGroups?: ModelRoundItemGroup[]): FlowGroupData[] {
  return (projectedGroups ?? buildFlowItemGroups({
    items: getModelRoundActiveItems(round), disabled: isModelRoundGroupingDisabled(round),
  })).flatMap(group => group.type === 'critical' ? [] : [buildInlineFlowGroupData(round.id, group)]);
}

export function getProjectedModelRoundGroups(item: Extract<VirtualItem, { type: 'model-round' }>, retainCandidates = false): ModelRoundItemGroup[] {
  return item.projectedGroups ?? buildFlowItemGroups({
    items: getModelRoundActiveItems(item.data).filter(member => !item.isTurnComplete || !canvasArtifactReferenceFromToolItem(member)),
    disabled: isModelRoundGroupingDisabled(item.data), retainCandidates,
  });
}

interface BuildFlowItemGroupsInput extends FlowGroupPolicyOptions {
  items: readonly FlowItem[];
  disabled?: boolean;
  /** Cross-round projection applies thresholds after collecting the visible run. */
  retainCandidates?: boolean;
}

/** Pure projection: no clocks, UI density, stream timers or mutation of recorded items. */
export function buildFlowItemGroups({ items, disabled = false, retainCandidates = false, ...policyOptions }: BuildFlowItemGroupsInput): ModelRoundItemGroup[] {
  const groups: ModelRoundItemGroup[] = [];
  let buffer: FlowItem[] = [];
  let pending: FlowItem[] = [];
  let category: FlowGroupCategory | undefined;
  const flush = (isLast: boolean) => {
    if (category && buffer.length) {
      if (retainCandidates || meetsFlowGroupThreshold(category, buffer)) {
        groups.push(projectedFlowGroup(category, buffer, isLast));
      } else {
        groups.push(...buffer.map(item => ({ type: 'critical' as const, item })));
      }
    }
    buffer = [];
    category = undefined;
  };
  for (const item of items) {
    if (!isFlowItemVisible(item)) continue;
    if (!disabled && isFlowGroupCompanion(item)) {
      pending.push(item);
      continue;
    }
    const nextCategory = disabled ? undefined : classifyFlowGroupItem(item, policyOptions);
    if (nextCategory) {
      const joinedCategory = joinedFlowGroupCategory(category, nextCategory);
      const continuing = category !== undefined && joinedCategory !== undefined
        && canContinueFlowGroup(nextCategory, buffer, [item]);
      const companionStart = flowGroupCompanionStart(pending, continuing);
      if (!continuing) {
        flush(false);
        groups.push(...pending.slice(0, companionStart).map(item => ({ type: 'critical' as const, item })));
      }
      category = joinedCategory ?? nextCategory;
      buffer.push(...pending.slice(companionStart), item);
    } else {
      // Only noncollectible cards or explicit interaction boundaries end the run.
      flush(false);
      groups.push(...pending.map(item => ({ type: 'critical' as const, item })));
      groups.push({ type: 'critical', item });
    }
    pending = [];
  }
  // Until another eligible call arrives, trailing prose/reasoning remains readable.
  flush(pending.length === 0);
  groups.push(...pending.map(item => ({ type: 'critical' as const, item })));
  return groups;
}

// Existing callers and compatibility tests retain their entry points and identities.
export const buildInlineToolGroupData = buildInlineFlowGroupData;
export const getModelRoundToolGroups = getModelRoundFlowGroups;
export function buildInlineExploreGroupData(roundId: string, group: Extract<GroupedFlowItems, { type: 'explore' }>, isLastGroupInTurn = group.isLast): ExploreGroupData {
  return buildInlineFlowGroupData(roundId, group, isLastGroupInTurn) as ExploreGroupData;
}
export function getModelRoundExploreGroups(round: ModelRound, projectedGroups?: ModelRoundItemGroup[]): ExploreGroupData[] {
  return getModelRoundFlowGroups(round, projectedGroups).filter((group): group is ExploreGroupData => (group.category ?? 'explore') === 'explore');
}
export function buildModelRoundItemGroups(input: {
  items: FlowItem[]; isStreaming: boolean; disableExploreGrouping: boolean;
  isCollapsibleTool: (toolName: string) => boolean; retainContextCandidates?: boolean;
}): ModelRoundItemGroup[] {
  return buildFlowItemGroups({ items: input.items, disabled: input.disableExploreGrouping,
    exploreEligibility: input.isCollapsibleTool, retainCandidates: input.retainContextCandidates });
}
