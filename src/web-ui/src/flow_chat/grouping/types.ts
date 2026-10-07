import type { FlowItem, ModelRound } from '../types/flow-chat';

/** Display-only ownership; never serialized into sessions or transport payloads. */
export interface FlowGroupBase {
  groupId: string;
  /** Legacy and merged identities retain the reader's disclosure choices. */
  sourceGroupIds?: string[];
  rounds: ModelRound[];
  allItems: FlowItem[];
  isGroupStreaming: boolean;
  /** Derived from transcript boundaries, never from a quiet stream or a timer. */
  phase?: 'collecting' | 'settling' | 'settled';
  needsAttention?: boolean;
  isLastGroupInTurn: boolean;
  /** Records a noncollectible boundary independently of disclosure and scrolling. */
  wasCutByCritical: boolean;
}

export interface ExploreGroupStats {
  readCount: number;
  searchCount: number;
  commandCount: number;
}

export interface ExploreGroupData extends FlowGroupBase {
  /** Unified exploration/execution; retain the legacy id and missing-category compatibility. */
  category?: 'explore';
  stats: ExploreGroupStats;
}

export interface ContextLoadGroupData extends FlowGroupBase {
  category: 'context';
}

export interface InterfaceGroupData extends FlowGroupBase {
  category: 'interface';
}

export interface FileEditGroupData extends FlowGroupBase {
  category: 'file-edit';
}

export interface FlowGroupDataByCategory {
  explore: ExploreGroupData;
  context: ContextLoadGroupData;
  interface: InterfaceGroupData;
  'file-edit': FileEditGroupData;
}

export type FlowGroupCategory = keyof FlowGroupDataByCategory;
export type FlowGroupData = FlowGroupDataByCategory[FlowGroupCategory];
export type GroupedFlowItems = {
  [K in FlowGroupCategory]: { type: K; items: FlowItem[]; isLast: boolean; projection?: FlowGroupDataByCategory[K] }
}[FlowGroupCategory];
export type ModelRoundItemGroup = GroupedFlowItems | { type: 'critical'; item: FlowItem };

// Compatibility names for existing adapters and saved in-memory view state.
export type ToolGroupData = FlowGroupBase;
export type CollapsibleToolGroupData = FlowGroupData;

export function getFlowGroupCategory(group: FlowGroupData): FlowGroupCategory {
  return group.category ?? 'explore';
}

export function getFlowGroupStateIds(group: FlowGroupBase): readonly string[] {
  const aliases = group.sourceGroupIds;
  return aliases?.includes(group.groupId) ? aliases : [group.groupId, ...(aliases ?? [])];
}

export function isFlowGroupExpanded(group: FlowGroupBase & { category?: FlowGroupCategory }, states?: ReadonlyMap<string, boolean>): boolean {
  const choice = getFlowGroupDisclosureChoice(group, states);
  // Failed file revisions stay visible until the reader explicitly folds them.
  return choice ?? ((group.category === 'file-edit' && group.needsAttention === true)
    || group.phase === 'collecting' || group.phase === 'settling'
    || (group.phase === undefined && group.isGroupStreaming));
}

/** Missing means automatic; old boolean entries remain explicit reader choices. */
export function getFlowGroupDisclosureChoice(group: FlowGroupBase, states?: ReadonlyMap<string, boolean>): boolean | undefined {
  const choices = getFlowGroupStateIds(group).map(id => states?.get(id));
  return choices.includes(true) ? true : choices.includes(false) ? false : undefined;
}
