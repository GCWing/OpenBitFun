import type { AnyFlowItem, FlowItem, FlowToolItem, ModelRound } from '../types/flow-chat';
import type { VirtualItem, TimelineBlock } from '../types/flow-chat-projection';
import { buildInlineToolGroupData, getProjectedModelRoundGroups, hasModelRoundLeadingControls } from '../grouping/roundGroups';
import { getFlowGroupDisclosureChoice, isFlowGroupExpanded, type FlowGroupData } from '../grouping/types';
import { filterFlowGroupItems, type FlowGroupStatusFilter } from '../grouping/browse';
import { isFlowItemVisible } from '../utils/flowItemVisibility';
import type { FlowChatReaderState } from './readerState';
import { getVirtualItemStableKey } from '../components/modern/virtualItemIdentity';
import { getConcurrentCapsuleRows } from '../tool-cards/toolCapsuleLayout';
import { AGENT_CARD_BATCH_SIZE, isAgentCardRun, isAgentLaunchCard } from './agentCardLayout';

export interface TimelineProjectionOptions {
  reader: FlowChatReaderState;
  sessionId?: string;
  groupStates?: ReadonlyMap<string, boolean>;
  expandedToolCapsules?: ReadonlySet<string>;
  pendingPermissionToolCallIds?: ReadonlySet<string>;
  toolLabels: ReadonlyMap<string, string>;
}

/** A thought and its successor stay together for the existing annotation handoff. */
export function conversationContentRuns(items: readonly FlowItem[]): FlowItem[][] {
  const runs: FlowItem[][] = [];
  let pending: FlowItem[] = [];
  let agentCount = 0;
  const flush = () => { if (pending.length) runs.push(pending); pending = []; agentCount = 0; };
  const parallel = getConcurrentCapsuleRows(items);
  for (const item of items) {
    const agent = isAgentLaunchCard(item);
    // A new thought or any other visible activity is a narrative boundary.
    if (agentCount && !agent) flush();
    pending.push(item);
    if (agent) {
      if (++agentCount === AGENT_CARD_BATCH_SIZE) flush();
    } else if (item.type !== 'thinking' && (parallel.get(item.id) !== 'member' || pending.length >= 4)) flush();
  }
  flush();
  return runs;
}

/** Expanded capsule keys inverted for this session: turn id -> expanded member ids. */
type ExpandedCapsuleIndex = Map<string, Set<string>>;

/**
 * Inverts the disclosure keys (`JSON [sessionId, turnId, itemId]`, as built by
 * `toolCapsuleStateKey`) once per projection, so a member test is a lookup
 * instead of a freshly serialized key per item. Most flushes expand nothing.
 */
function capsuleExpansionIndex(options: TimelineProjectionOptions): ExpandedCapsuleIndex | undefined {
  const keys = options.expandedToolCapsules;
  if (!keys?.size) return undefined;
  const sessionId = options.sessionId ?? '';
  const index: ExpandedCapsuleIndex = new Map();
  keys.forEach(key => {
    let parsed: unknown;
    try { parsed = JSON.parse(key); } catch { return; }
    if (!Array.isArray(parsed) || parsed.length < 3) return;
    const [session, turn, item] = parsed;
    if (session !== sessionId || typeof turn !== 'string' || typeof item !== 'string') return;
    const members = index.get(turn);
    if (members) members.add(item); else index.set(turn, new Set([item]));
  });
  return index;
}

function readerExpanded(
  group: FlowGroupData, turnId: string, options: TimelineProjectionOptions, expandedCapsules?: ExpandedCapsuleIndex,
): boolean {
  const choice = getFlowGroupDisclosureChoice(group, options.groupStates);
  const permission = group.allItems.some(item => item.type === 'tool'
    && (item.status === 'pending_confirmation' || options.pendingPermissionToolCallIds?.has((item as FlowToolItem).toolCall.id)));
  if (permission) return true;
  if (choice !== undefined) return choice;
  const expandedMembers = expandedCapsules?.get(turnId);
  return isFlowGroupExpanded(group, options.groupStates)
    || options.reader.isGroupHeld(group.groupId)
    || (expandedMembers !== undefined && group.allItems.some(item => expandedMembers.has(item.id)));
}

type RoundItem = Extract<VirtualItem, { type: 'model-round' }>;
const emptyItems: FlowItem[] = [];

/**
 * Execution rounds remain immutable source facts. Only this desktop projection
 * chooses render/measurement units. Reconciliation preserves unchanged leaves
 * even when a different leaf in the same live round receives another token.
 */
export class ConversationDocumentProjection {
  private previous = new Map<string, VirtualItem>();
  private sourceCache = new WeakMap<VirtualItem, { viewStamp: number; sourceIndex: number; items: VirtualItem[] }>();
  private next = new Map<string, VirtualItem>();
  private labels?: ReadonlyMap<string, string>;
  private viewStamp = 0;
  private viewInputs?: {
    readerRevision: number;
    groupStates?: ReadonlyMap<string, boolean>;
    expandedToolCapsules?: ReadonlySet<string>;
    pendingPermissionToolCallIds?: ReadonlySet<string>;
    stamp: number;
  };

  /**
   * A stamp for the reader and group inputs, reused while they keep their
   * identity. Text streaming refreshes `sources` on every flush while these
   * stay the same object, so a quiet flush compares one number per source
   * instead of rebuilding a state-sized string and matching it by content.
   * Identity is what the caller already keys its own memo on.
   */
  private viewStampFor(options: TimelineProjectionOptions): number {
    const readerRevision = options.reader.getProjectionRevision();
    const cached = this.viewInputs;
    if (cached && cached.readerRevision === readerRevision
      && cached.groupStates === options.groupStates
      && cached.expandedToolCapsules === options.expandedToolCapsules
      && cached.pendingPermissionToolCallIds === options.pendingPermissionToolCallIds) {
      return cached.stamp;
    }

    const stamp = ++this.viewStamp;
    this.viewInputs = {
      readerRevision,
      groupStates: options.groupStates,
      expandedToolCapsules: options.expandedToolCapsules,
      pendingPermissionToolCallIds: options.pendingPermissionToolCallIds,
      stamp,
    };
    return stamp;
  }

  project(sources: readonly VirtualItem[], options: TimelineProjectionOptions): VirtualItem[] {
    if (this.labels !== options.toolLabels) {
      this.labels = options.toolLabels;
      this.sourceCache = new WeakMap();
    }
    this.next = new Map();
    const result: VirtualItem[] = [];
    const viewStamp = this.viewStampFor(options);
    const expandedCapsules = capsuleExpansionIndex(options);
    sources.forEach((original, sourceIndex) => {
      // Legacy whole-round groups obey the same residency contract. This is a
      // render adapter only; neither their recorded rounds nor ids are changed.
      const source: VirtualItem = original.type === 'explore-group' ? {
        type: 'model-round', turnId: original.turnId, isLastRound: false, isTurnComplete: false,
        data: { id: original.data.groupId, index: 0, startTime: 0, items: [],
          status: original.data.isGroupStreaming ? 'streaming' : 'completed',
          isComplete: !original.data.isGroupStreaming, isStreaming: original.data.isGroupStreaming },
        projectedGroups: [{ type: original.data.category ?? 'explore', items: original.data.allItems,
          isLast: original.data.isLastGroupInTurn, projection: original.data }],
      } as VirtualItem : original;
      if (source.type !== 'model-round') {
        const key = getVirtualItemStableKey(source);
        const cached = this.sourceCache.get(source);
        const row = cached?.sourceIndex === sourceIndex ? cached.items[0] : {
          ...source, timeline: { key, kind: 'content' as const, sourceIndex, memberIds: source.type === 'background-run' ? source.turn.modelRounds.flatMap(round => round.items.map(item => item.id)) : [] },
        };
        this.sourceCache.set(source, { viewStamp, sourceIndex, items: [row] });
        this.next.set(key, row);
        result.push(row);
        return;
      }
      // Source identity is already shared by completed immutable Turns. Reader
      // changes only invalidate their projection, never their payloads.
      const cached = this.sourceCache.get(original);
      if (cached?.viewStamp === viewStamp && cached.sourceIndex === sourceIndex) {
        for (const row of cached.items) this.next.set(row.timeline!.key, row);
        result.push(...cached.items);
        return;
      }
      const rows: VirtualItem[] = [];
      const add = (kind: TimelineBlock['kind'], id: string, members: FlowItem[], extra: Partial<TimelineBlock> = {}) => {
        const key = `${source.turnId}:${id}`;
        const previous = this.previous.get(key);
        const chrome = kind === 'round-header' || kind === 'round-footer';
        const isLastRound = (kind === 'round-footer' || (kind === 'content' && extra.last === true)) && source.isLastRound;
        const canvasArtifactItems = kind === 'round-footer' ? source.canvasArtifactItems : undefined;
        const layout = isAgentCardRun(members) ? 'agent-cards' : undefined;
        // Judge reuse from cheap primitives first; an unchanged block keeps the
        // previous row identity the virtualizer memoized, and now also keeps the
        // flush from allocating row payloads it would immediately discard.
        const reusable = previous?.type === 'model-round' && previous.timeline?.kind === kind
          && previous.timeline.sourceIndex === sourceIndex
          && (kind === 'group-members'
            ? previous.timeline.group?.groupId === extra.group?.groupId
              && previous.timeline.group?.phase === extra.group?.phase
              && previous.timeline.group?.isLastGroupInTurn === extra.group?.isLastGroupInTurn
              && previous.timeline.memberOrdinal === extra.memberOrdinal
            : previous.timeline.group === extra.group)
          && previous.timeline.expanded === extra.expanded
          && previous.timeline.layout === layout
          && previous.timeline.first === extra.first && previous.timeline.last === extra.last
          && previous.timeline.revealThinkingIds?.join('|') === extra.revealThinkingIds?.join('|')
          && previous.isLastRound === isLastRound && previous.isTurnComplete === source.isTurnComplete
          && previous.layoutHints?.expandedThinkingItemIds.join('|') === source.layoutHints?.expandedThinkingItemIds.join('|')
          && (chrome ? previous.data === source.data && previous.canvasArtifactItems === canvasArtifactItems
            : previous.data.items.length === members.length && previous.data.items.every((item, index) => item === members[index]))
          ? previous : undefined;
        if (reusable) {
          this.next.set(key, reusable);
          rows.push(reusable);
          return;
        }
        const data: ModelRound = chrome ? source.data : {
          ...source.data, items: members as AnyFlowItem[], attempts: undefined, historyRounds: undefined,
          renderHints: undefined,
          isStreaming: members.some(member => member.status === 'streaming' || member.status === 'running'
            || ('isStreaming' in member && member.isStreaming === true)),
        };
        const row: RoundItem = {
          ...source, data,
          projectedGroups: members.map(item => ({ type: 'critical', item })),
          isLastRound, canvasArtifactItems,
          timeline: { key, kind, sourceIndex, memberIds: members.map(item => item.id), layout, ...extra },
        };
        this.next.set(key, row);
        rows.push(row);
      };
      if (hasModelRoundLeadingControls(source.data)) add('round-header', `${source.data.id}:history`, emptyItems);
      const groups = getProjectedModelRoundGroups(source);
      let critical: FlowItem[] = [];
      const flush = (last = false) => {
        const runs = conversationContentRuns(critical);
        runs.forEach((run, index) => add('content', run[0].id, run, { last: last && index === runs.length - 1 }));
        critical = [];
      };
      groups.forEach(group => {
        if (group.type === 'critical') { if (isFlowItemVisible(group.item)) critical.push(group.item); return; }
        flush();
        const data = buildInlineToolGroupData(source.data.id, group, source.isLastRound && group.isLast);
        const expanded = readerExpanded(data, source.turnId, options, expandedCapsules);
        add('group-header', `group:${data.groupId}`, emptyItems, { group: data, expanded });
        if (!expanded) return;
        const prefix = `group:${data.groupId}:`;
        const filter = {
          query: options.reader.get(`${prefix}query`, ''),
          tool: options.reader.get(`${prefix}tool`, 'all'),
          status: options.reader.get(`${prefix}status`, 'all') as FlowGroupStatusFilter,
        };
        const all = data.allItems.filter(isFlowItemVisible);
        const browse = filterFlowGroupItems(all, filter, options.toolLabels, options.pendingPermissionToolCallIds);
        const runs = conversationContentRuns(all.filter(item => browse.visibleIds.has(item.id)));
        // Member blocks hold only group metadata, never the full source tree.
        const memberGroup = { ...data, rounds: [], allItems: [] };
        const ordinals = new Map(all.filter(member => member.type === 'tool').map((member, index) => [member.id, index]));
        runs.forEach((run, index) => add('group-members', run[0].id, run,
          { group: memberGroup, expanded, first: index === 0, last: index === runs.length - 1,
            memberOrdinal: ordinals.get(run.find(member => member.type === 'tool')?.id ?? ''),
            revealThinkingIds: run.filter(member => browse.matchingThinkingIds.has(member.id)).map(member => member.id) }));
      });
      flush(true);
      if ((source.isLastRound && source.isTurnComplete) || source.canvasArtifactItems?.length) {
        add('round-footer', `${source.data.id}:footer`, emptyItems);
      }
      this.sourceCache.set(original, { viewStamp, sourceIndex, items: rows });
      result.push(...rows);
    });
    this.previous = this.next;
    return result;
  }
}

/** Source/search indexes never leak into the virtualizer's block index space. */
export function findTimelineBlockIndex(items: readonly VirtualItem[], sourceIndex: number, memberId?: string): number {
  if (memberId) {
    const ownsSource = (item: VirtualItem, index: number) => sourceIndex < 0 || (item.timeline?.sourceIndex ?? index) === sourceIndex;
    const member = items.findIndex((item, index) => ownsSource(item, index) && (item.timeline?.memberIds.includes(memberId)
      || (item.type === 'model-round' && item.canvasArtifactItems?.some(candidate => candidate.id === memberId))));
    if (member >= 0) return member;
    const group = items.findIndex((item, index) => ownsSource(item, index) && item.timeline?.kind === 'group-header'
      && item.timeline.group?.allItems.some(candidate => candidate.id === memberId));
    if (group >= 0) return group;
  }
  return items.findIndex((item, index) => (item.timeline?.sourceIndex ?? index) === sourceIndex);
}
