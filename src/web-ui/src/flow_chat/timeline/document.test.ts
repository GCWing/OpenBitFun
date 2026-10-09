import { describe, expect, it } from 'vitest';
import { ConversationDocumentProjection, conversationContentRuns, findTimelineBlockIndex } from './document';
import { FlowChatReaderState } from './readerState';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { estimateVirtualItemHeight } from '../components/modern/virtualItemHeightEstimators';

const tool = (id: string, status: FlowToolItem['status'] = 'completed'): FlowToolItem => ({
  id, type: 'tool', toolName: 'Read', timestamp: 1, status,
  toolCall: { id, input: { file_path: `/src/${id}.ts` } }, toolResult: { success: true, result: {} },
});
const source = (items: FlowItem[]): Extract<VirtualItem, { type: 'model-round' }> => ({
  type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: true,
  data: { id: 'round', index: 0, startTime: 1, status: 'completed', isStreaming: false, isComplete: true, items },
});
const options = () => ({ reader: new FlowChatReaderState(), toolLabels: new Map<string, string>() });
const agent = (id: string, toolName = 'AgentSpawn', status: FlowToolItem['status'] = 'completed'): FlowToolItem => ({
  ...tool(id, status), toolName, toolCall: { id, input: { description: `Inspect ${id}` } },
});

describe('desktop conversation document', () => {
  it('packs adjacent launch cards independently of execution status or timing', () => {
    const projection = new ConversationDocumentProjection();
    const launches = [agent('a', 'Task', 'running'), agent('b', 'AgentSpawn', 'cancelled'), agent('c', 'LaunchReviewAgent', 'error')];
    const input = source(launches);
    const before = JSON.stringify(input);
    const rows = projection.project([input], options());
    expect(rows[0].timeline?.layout).toBe('agent-cards');
    expect(rows[0].timeline?.memberIds).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) expect(findTimelineBlockIndex(rows, 0, id)).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps launch batches bounded and earlier blocks stable while new agents arrive', () => {
    const projection = new ConversationDocumentProjection();
    const opts = options();
    const launches = Array.from({ length: 600 }, (_, index) => agent(`agent-${index}`));
    const first = projection.project([source(launches.slice(0, 7))], opts);
    const next = projection.project([source(launches.slice(0, 8))], opts);
    expect(next[0]).toBe(first[0]);
    expect(next[1].timeline?.key).toBe(first[1].timeline?.key);
    expect(next[1].timeline?.memberIds).toEqual(['agent-6', 'agent-7']);
    const large = projection.project([source(launches)], opts);
    const batches = large.filter(row => row.timeline?.layout === 'agent-cards');
    expect(batches).toHaveLength(100);
    expect(batches.every(row => row.timeline!.memberIds.length === 6)).toBe(true);
    expect(large[findTimelineBlockIndex(large, 0, 'agent-599')].timeline?.memberIds).toContain('agent-599');
  });

  it('preserves thinking successors and stops card rows at narrative and interaction boundaries', () => {
    const thought = { id: 'thought', type: 'thinking', content: 'Planning', status: 'completed', isStreaming: false } as FlowItem;
    const text = { id: 'text', type: 'text', content: 'Next task', status: 'completed', isStreaming: false } as FlowItem;
    const send = { ...agent('send', 'Task'), toolCall: { id: 'send', input: { action: 'send_input' } } };
    const cancel = { ...agent('cancel', 'Task'), toolResult: { success: true, result: { action: 'cancel' } } };
    const deferred = { ...agent('deferred'), toolName: 'CallDeferredTool',
      toolCall: { id: 'deferred', input: { tool_name: 'AgentSpawn', args: {} } } };
    expect(conversationContentRuns([thought, agent('a'), deferred, text, agent('b'), send, cancel, agent('c'), thought, agent('d')])
      .map(run => run.map(item => item.id))).toEqual([
      ['thought', 'a', 'deferred'], ['text'], ['b'], ['send'], ['cancel'], ['c'], ['thought', 'd'],
    ]);
  });

  it('estimates visual grid rows instead of summing the heights of every card', () => {
    const projection = new ConversationDocumentProjection();
    const opts = options();
    const one = projection.project([source([agent('a')])], opts)[0];
    const three = projection.project([source([agent('a'), agent('b'), agent('c')])], opts)[0];
    expect(estimateVirtualItemHeight(three, { availableWidthPx: 900 }).heightPx)
      .toBe(estimateVirtualItemHeight(one, { availableWidthPx: 900 }).heightPx);
    expect(estimateVirtualItemHeight(three, { availableWidthPx: 640 }).heightPx).toBe(184);
    expect(estimateVirtualItemHeight(three, { availableWidthPx: 400 }).heightPx).toBe(276);
  });

  it('projects a large group into bounded independent members without duplicating payload trees', () => {
    const projection = new ConversationDocumentProjection();
    const input = source(Array.from({ length: 1000 }, (_, index) => tool(`read-${index}`)));
    const before = JSON.stringify(input);
    const opts = options();
    const collapsed = projection.project([input], opts);
    const header = collapsed.find(item => item.timeline?.kind === 'group-header')!;
    expect(collapsed.some(item => item.timeline?.kind === 'group-members')).toBe(false);
    expect(findTimelineBlockIndex(collapsed, 0, 'read-900')).toBe(collapsed.indexOf(header));
    const open = projection.project([input], { ...opts, groupStates: new Map([[header.timeline!.group!.groupId, true]]) });
    const members = open.filter(item => item.timeline?.kind === 'group-members');
    expect(members).toHaveLength(1000);
    expect(members.every(item => item.timeline!.memberIds.length === 1 && item.timeline!.group!.allItems.length === 0)).toBe(true);
    expect(open[findTimelineBlockIndex(open, 0, 'read-900')].timeline?.memberIds).toEqual(['read-900']);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps unchanged leaves stable while another member receives output', () => {
    const projection = new ConversationDocumentProjection();
    const a = tool('a'), b = tool('b', 'running');
    const opts = options();
    const first = projection.project([source([a, b])], opts);
    const next = projection.project([source([a, { ...b, partialParams: { file_path: '/b' } }])], opts);
    expect(next.find(item => item.timeline?.memberIds[0] === 'a'))
      .toBe(first.find(item => item.timeline?.memberIds[0] === 'a'));
    expect(next.find(item => item.timeline?.memberIds[0] === 'b'))
      .not.toBe(first.find(item => item.timeline?.memberIds[0] === 'b'));
  });

  it('honors explicit folding without destroying child choices and always exposes permission requests', () => {
    const projection = new ConversationDocumentProjection();
    const opts = options();
    const input = source([tool('a'), tool('b')]);
    const header = projection.project([input], opts).find(item => item.timeline?.group)!;
    const id = header.timeline!.group!.groupId;
    opts.reader.set('card:b:details', true);
    const release = opts.reader.holdGroup(id, 'selection');
    expect(projection.project([input], opts).some(item => item.timeline?.kind === 'group-members')).toBe(true);
    const folded = { ...opts, groupStates: new Map([[id, false]]) };
    expect(projection.project([input], folded).some(item => item.timeline?.kind === 'group-members')).toBe(false);
    expect(opts.reader.get('card:b:details', false)).toBe(true);
    expect(projection.project([input], { ...folded, pendingPermissionToolCallIds: new Set(['b']) })
      .some(item => item.timeline?.memberIds.includes('b'))).toBe(true);
    release();
  });

  it('applies remembered filters before materialization and supports legacy group sources', () => {
    const projection = new ConversationDocumentProjection();
    const opts = options();
    const legacy: VirtualItem = { type: 'explore-group', turnId: 'turn', data: {
      groupId: 'legacy', allItems: [tool('a'), { ...tool('b', 'error'), toolName: 'ExecCommand' }], rounds: [],
      stats: { readCount: 2, searchCount: 0, commandCount: 0 },
      isGroupStreaming: false, isLastGroupInTurn: true, wasCutByCritical: false,
    } };
    opts.reader.set('group:legacy:status', 'attention');
    const rows = projection.project([legacy], { ...opts, groupStates: new Map([['legacy', true]]) });
    expect(rows[0].timeline?.expanded).toBe(true);
    expect(rows.flatMap(row => row.timeline?.memberIds ?? [])).toEqual(['b']);
  });
});
