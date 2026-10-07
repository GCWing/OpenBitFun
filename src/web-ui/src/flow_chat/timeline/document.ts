import type { AnyFlowItem, FlowItem, FlowToolItem, ModelRound } from '../types/flow-chat';
import type { VirtualItem, TimelineBlock } from '../types/flow-chat-projection';
import { buildInlineToolGroupData, getProjectedModelRoundGroups, hasModelRoundLeadingControls } from '../grouping/roundGroups';
import { getFlowGroupDisclosureChoice, isFlowGroupExpanded, type FlowGroupData } from '../grouping/types';
import { filterFlowGroupItems, type FlowGroupStatusFilter } from '../grouping/browse';
import { isFlowItemVisible } from '../utils/flowItemVisibility';
import { toolCapsuleStateKey } from '../tool-cards/toolCapsuleModel';
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

function readerExpanded(group: FlowGroupData, turnId: string, options: TimelineProjectionOptions): boolean {
  const choice = getFlowGroupDisclosureChoice(group, options.groupStates);
  const permission = group.allItems.some(item => item.type === 'tool'
    && (item.status === 'pending_confirmation' || options.pendingPermissionToolCallIds?.has((item as FlowToolItem).toolCall.id)));
  if (permission) return true;
  if (choice !== undefined) return choice;
  return isFlowGroupExpanded(group, options.groupStates)
    || options.reader.isGroupHeld(group.groupId)
    || group.allItems.some(item => options.expandedToolCapsules?.has(toolCapsuleStateKey(options.sessionId, turnId, item.id)));
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
  private sourceCache = new WeakMap<VirtualItem, { revision: string; items: VirtualItem[] }>();
  private next = new Map<string, VirtualItem>();
  private labels?: ReadonlyMap<string, string>;

  project(sources: readonly VirtualItem[], options: TimelineProjectionOptions): VirtualItem[] {
    if (this.labels !== options.toolLabels) {
      this.labels = options.toolLabels;
      this.sourceCache = new WeakMap();
    }
    this.next = new Map();
    const result: VirtualItem[] = [];
    const viewRevision = `${options.reader.getProjectionRevision()}:${[...(options.groupStates ?? [])].map(([id, value]) => `${id}:${value}`).join('|')}:${[...(options.expandedToolCapsules ?? [])].join('|')}:${[...(options.pendingPermissionToolCallIds ?? [])].join('|')}`;
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
        const row = cached?.revision === String(sourceIndex) ? cached.items[0] : {
          ...source, timeline: { key, kind: 'content' as const, sourceIndex, memberIds: [] },
        };
        this.sourceCache.set(source, { revision: String(sourceIndex), items: [row] });
        this.next.set(key, row);
        result.push(row);
        return;
      }
      // Source identity is already shared by completed immutable Turns. Reader
      // changes only invalidate their projection, never their payloads.
      const revision = `${sourceIndex}:${viewRevision}`;
      const cached = this.sourceCache.get(original);
      if (cached?.revision === revision) {
        for (const row of cached.items) this.next.set(row.timeline!.key, row);
        result.push(...cached.items);
        return;
      }
      const rows: VirtualItem[] = [];
      const add = (kind: TimelineBlock['kind'], id: string, members: FlowItem[], extra: Partial<TimelineBlock> = {}) => {
        const key = `${source.turnId}:${id}`;
        const previous = this.previous.get(key);
        const chrome = kind === 'round-header' || kind === 'round-footer';
        const data: ModelRound = chrome ? source.data : {
          ...source.data, items: members as AnyFlowItem[], attempts: undefined, historyRounds: undefined,
          renderHints: undefined,
          isStreaming: members.some(member => member.status === 'streaming' || member.status === 'running'
            || ('isStreaming' in member && member.isStreaming === true)),
        };
        const row: RoundItem = {
          ...source, data,
          projectedGroups: members.map(item => ({ type: 'critical', item })),
          isLastRound: (kind === 'round-footer' || (kind === 'content' && extra.last === true)) && source.isLastRound,
          canvasArtifactItems: kind === 'round-footer' ? source.canvasArtifactItems : undefined,
          timeline: { key, kind, sourceIndex, memberIds: members.map(item => item.id),
            layout: isAgentCardRun(members) ? 'agent-cards' : undefined, ...extra },
        };
        const reused = previous?.type === 'model-round' && previous.timeline?.kind === kind
          && previous.timeline.sourceIndex === sourceIndex
          && (kind === 'group-members'
            ? previous.timeline.group?.groupId === extra.group?.groupId
              && previous.timeline.group?.phase === extra.group?.phase
              && previous.timeline.group?.isLastGroupInTurn === extra.group?.isLastGroupInTurn
              && previous.timeline.memberOrdinal === extra.memberOrdinal
            : previous.timeline.group === extra.group)
          && previous.timeline.expanded === extra.expanded
          && previous.timeline.layout === row.timeline!.layout
          && previous.timeline.first === extra.first && previous.timeline.last === extra.last
          && previous.timeline.revealThinkingIds?.join('|') === extra.revealThinkingIds?.join('|')
          && previous.isLastRound === row.isLastRound && previous.isTurnComplete === row.isTurnComplete
          && previous.layoutHints?.expandedThinkingItemIds.join('|') === row.layoutHints?.expandedThinkingItemIds.join('|')
          && (chrome ? previous.data === data && previous.canvasArtifactItems === row.canvasArtifactItems
            : previous.data.items.length === members.length && previous.data.items.every((item, index) => item === members[index]))
          ? previous : row;
        this.next.set(key, reused);
        rows.push(reused);
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
        const expanded = readerExpanded(data, source.turnId, options);
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
      this.sourceCache.set(original, { revision, items: rows });
      result.push(...rows);
    });
    this.previous = this.next;
    return result;
  }
}

/** Source/search indexes never leak into the virtualizer's block index space. */
export function findTimelineBlockIndex(items: readonly VirtualItem[], sourceIndex: number, memberId?: string): number {
  if (memberId) {
    const member = items.findIndex(item => item.timeline?.memberIds.includes(memberId)
      || (item.type === 'model-round' && item.canvasArtifactItems?.some(candidate => candidate.id === memberId)));
    if (member >= 0) return member;
    const group = items.findIndex(item => item.timeline?.kind === 'group-header'
      && item.timeline.group?.allItems.some(candidate => candidate.id === memberId));
    if (group >= 0) return group;
  }
  return items.findIndex((item, index) => (item.timeline?.sourceIndex ?? index) === sourceIndex);
}
