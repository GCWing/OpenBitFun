import { describe, expect, it } from 'vitest';
import { ConversationDocumentProjection, conversationContentRuns, findTimelineBlockIndex } from './document';
import { FlowChatReaderState } from './readerState';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { estimateVirtualItemHeight } from '../components/modern/virtualItemHeightEstimators';
import { buildInlineToolGroupData } from '../grouping/roundGroups';
import { projectAdjacentFlowGroups } from '../grouping/groupProjection';
import { toolCapsuleStateKey } from '../tool-cards/toolCapsuleModel';
import { localizeMarkdownMatch } from './markdownSectionSearch';
import { getVirtualItemBookmarkKey } from '../components/modern/virtualItemIdentity';

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
  it('retains live reading rows when a single settled attempt omits item metadata and restores blank lines', () => {
    const raw = Array.from({ length: 300 }, (_, index) => `\n\nStream paragraph ${index}: ${'Readable **text**. '.repeat(24)}`
      + (index % 8 === 7 ? '\n\n```typescript\nexport const streamed = true;\n```\n' : '')).join('');
    const clean = raw.replace(/\n{3,}/g, '\n\n');
    const text = { id: 'live', type: 'text', content: clean.slice(0, clean.lastIndexOf('\n\nStream paragraph 240:')),
      attemptId: 'first-attempt', attemptIndex: 1, isMarkdown: true, isStreaming: true, status: 'streaming' } as FlowItem;
    const projection = new ConversationDocumentProjection(), opts = options();
    const live = projection.project([source([text])], opts).filter(row => row.timeline?.markdownSection);
    const durable = { ...text, id: 'journal-text', content: raw, attemptId: undefined, attemptIndex: undefined,
      isStreaming: false, status: 'completed' } as FlowItem;
    const incoming = source([durable]); incoming.data.attemptCount = 1;
    const settled = projection.project([incoming], opts).filter(row => row.timeline?.markdownSection);
    expect(settled.slice(0, live.length).map(row => row.timeline?.key)).toEqual(live.map(row => row.timeline?.key));
    expect(settled.map(row => raw.slice(row.timeline!.markdownSection!.start, row.timeline!.markdownSection!.end)).join('')).toBe(raw);
    expect(settled.every(row => row.type === 'model-round' && row.data.items[0] === durable)).toBe(true);
    const reopened = new ConversationDocumentProjection().project([incoming], options()).filter(row => row.timeline?.markdownSection);
    expect(reopened.map(getVirtualItemBookmarkKey)).toEqual(settled.map(getVirtualItemBookmarkKey));
    expect(settled.some((row, index) => index > 0 && row.timeline?.key !== `turn:live:markdown:${row.timeline?.markdownSection?.start}`)).toBe(true);
  });

  it.each([undefined, 2])('does not guess missing attempt identity with attempt count %s', attemptCount => {
    const text = { id: 'live', type: 'text', content: 'Answer', attemptId: 'first-attempt', attemptIndex: 1, status: 'completed' } as FlowItem;
    const projection = new ConversationDocumentProjection(), opts = options();
    projection.project([source([text])], opts);
    const incoming = source([{ ...text, id: 'journal', attemptId: undefined, attemptIndex: undefined } as FlowItem]);
    incoming.data.attemptCount = attemptCount;
    expect(projection.project([incoming], opts)[0].timeline?.key).toBe('turn:journal');
  });

  it('keeps measured section keys while adopting durable narrative IDs and a missing suffix', () => {
    const content = 'A paragraph with some text.\n\n'.repeat(600);
    const thought = { id: 'thinking-live', type: 'thinking', content: 'Reasoning.\n\nMore.', status: 'completed' } as FlowItem;
    const text = { id: 'text-live', type: 'text', content, isMarkdown: true, status: 'completed', isStreaming: false } as FlowItem;
    const projection = new ConversationDocumentProjection(), opts = options();
    const live = projection.project([source([thought, text])], opts).filter(row => row.timeline?.markdownSection);
    const durable = [{ ...thought, id: 'round-thinking-0', content: 'Reasoning.\n\n\nMore.' },
      { ...text, id: 'round-text-1', content: content + 'Recovered suffix.\n\n'.repeat(400) }] as FlowItem[];
    const incoming = source(durable);
    const before = JSON.stringify(incoming);
    const settled = projection.project([incoming], opts).filter(row => row.timeline?.markdownSection);
    expect(settled.slice(0, live.length).map(row => row.timeline?.key)).toEqual(live.map(row => row.timeline?.key));
    expect(settled[0].timeline?.memberIds).toEqual(['round-thinking-0', 'round-text-1']);
    expect(settled.every(row => row.type === 'model-round' && row.data.items.at(-1) === durable[1])).toBe(true);
    expect(findTimelineBlockIndex(settled, 0, 'round-text-1', settled[1].timeline!.markdownSection!.start)).toBe(1);
    expect(JSON.stringify(incoming)).toBe(before);
    // A repeated host read retains the alias; another view starts from canonical IDs.
    expect(projection.project([source(durable.map(item => ({ ...item })))], opts).map(row => row.timeline?.key))
      .toEqual(projection.project([incoming], opts).map(row => row.timeline?.key));
    const reopened = new ConversationDocumentProjection().project([incoming], options());
    expect(reopened[0].timeline?.key).toBe('turn:round-thinking-0');
    expect(reopened.filter(row => row.timeline?.markdownSection).map(getVirtualItemBookmarkKey))
      .toEqual(settled.map(getVirtualItemBookmarkKey));
  });

  it.each(['retry', 'replacement', 'insertion', 'tool', 'round', 'turn', 'eviction'] as const)(
    'does not alias unrelated narrative during %s', change => {
    const text = { id: 'live', type: 'text', content: 'Original answer', status: 'completed', attemptId: 'attempt', attemptIndex: 0 } as FlowItem;
    const projection = new ConversationDocumentProjection(), opts = options();
    const before = source([text, tool('tool')]);
    projection.project([before], opts);
    const replacement = { ...text, id: 'durable', ...(change === 'retry' ? { attemptId: 'retry', attemptIndex: 1 }
      : change === 'replacement' ? { content: 'Different answer' } : {}) } as FlowItem;
    const after = source([replacement, tool(change === 'tool' ? 'other-tool' : 'tool'),
      ...(change === 'insertion' ? [tool('inserted')] : [])]);
    if (change === 'round') after.data = { ...after.data, id: 'another-round' };
    if (change === 'turn') after.turnId = 'another-turn';
    if (change === 'eviction') projection.project([], opts);
    const rows = projection.project([after], opts);
    expect(rows[findTimelineBlockIndex(rows, 0, 'durable')].timeline?.key).toBe(`${after.turnId}:durable`);
  });

  it('avoids duplicate display keys when a later canonical item uses an earlier alias', () => {
    const projection = new ConversationDocumentProjection(), opts = options();
    const text = { id: 'live', type: 'text', content: 'Answer', status: 'completed' } as FlowItem;
    projection.project([source([text])], opts);
    const durable = { ...text, id: 'durable' };
    const settledSource = source([durable]);
    expect(projection.project([settledSource], opts)[0].timeline?.key).toBe('turn:live');
    const rows = projection.project([source([durable, { ...text, content: 'New text' } as FlowItem])], opts);
    expect(new Set(rows.map(row => row.timeline?.key)).size).toBe(rows.length);
    expect(rows[0].timeline?.key).toBe('turn:durable');
    expect(projection.project([settledSource], opts)[0].timeline?.key).toBe('turn:durable');
  });

  it('windows large Markdown with canonical identity, bounded estimates and exact search occurrences', () => {
    const content = Array.from({ length: 300 }, (_, i) => `Paragraph ${i}: fixture **text**.\n\n`).join('')
      + '\n```ts\n' + 'const example = 1;\n'.repeat(100) + '```\n\n' + 'End fixture.\n\n'.repeat(400);
    const text = { id: 'large', type: 'text', content, isMarkdown: true, status: 'completed', isStreaming: false } as FlowItem;
    const input = source([text]), projection = new ConversationDocumentProjection(), opts = options();
    const rows = projection.project([input], opts).filter(row => row.timeline?.markdownSection);
    expect(rows.length).toBeGreaterThan(4);
    expect(rows[0].timeline?.key).toBe('turn:large');
    expect(rows.every(row => row.type === 'model-round' && row.data.items[0] === text)).toBe(true);
    expect(rows.map(row => content.slice(row.timeline!.markdownSection!.start, row.timeline!.markdownSection!.end)).join('')).toBe(content);
    expect(Math.max(...rows.map(row => estimateVirtualItemHeight(row).heightPx))).toBeLessThan(5000);
    const match = { flowItemId: 'large', occurrenceIndex: 600 };
    const hits = rows.map(row => localizeMarkdownMatch(row, 'fixture', match)).filter(Boolean);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.occurrenceIndex).toBeLessThan(match.occurrenceIndex);
    expect(projection.project([input], opts).slice(0, rows.length)).toEqual(rows);
    const last = rows.at(-1)!;
    expect(findTimelineBlockIndex(rows, 0, 'large', last.timeline!.markdownSection!.start)).toBe(rows.length - 1);
    opts.reader.set('navigation:whole-text', 'turn:large');
    expect(projection.project([input], opts).some(row => row.timeline?.markdownSection)).toBe(false);
    expect(input.data.items[0]).toBe(text);
  });

  it('maps repeated matches after Unicode case folding changes source length', () => {
    const content = 'İ fixture repeated.\n\n'.repeat(1000);
    const text = { id: 'unicode', type: 'text', content, isMarkdown: true, status: 'completed', isStreaming: false } as FlowItem;
    const rows = new ConversationDocumentProjection().project([source([text])], options());
    const match = { flowItemId: 'unicode', occurrenceIndex: 900 };
    const localized = rows.filter(row => row.timeline?.markdownSection)
      .flatMap(row => {
        const hit = localizeMarkdownMatch(row, 'FIXTURE', match);
        return hit ? [{ row, hit }] : [];
      });
    expect(localized).toHaveLength(1);
    const section = localized[0].row.timeline!.markdownSection!;
    const before = content.slice(0, section.start).match(/fixture/g)?.length ?? 0;
    expect(localized[0].hit.occurrenceIndex).toBe(900 - before);
  });

  it('keeps incremental live section keys through appends and completion, including thinking handoff', () => {
    const text = { id: 'live', type: 'text', content: 'A paragraph with some text.\n\n'.repeat(900), isMarkdown: true, status: 'streaming', isStreaming: true } as FlowItem;
    const projection = new ConversationDocumentProjection(), opts = options();
    const first = projection.project([source([{ ...text, content: 'A paragraph with some text.\n\n' } as FlowItem])], opts);
    expect(first[0].timeline?.markdownSection).toEqual({ start: 0, end: 29 });
    const streamed = projection.project([source([text])], opts).filter(row => row.timeline?.markdownSection);
    expect(streamed.length).toBeGreaterThan(4);
    expect(streamed[0].timeline?.key).toBe(first[0].timeline?.key);
    const growing = { ...text, content: text.content + 'Another paragraph.\n\n'.repeat(300) } as FlowItem;
    const appended = projection.project([source([growing])], opts).filter(row => row.timeline?.markdownSection);
    expect(appended.slice(0, streamed.length - 1).map(row => row.timeline?.markdownSection))
      .toEqual(streamed.slice(0, -1).map(row => row.timeline?.markdownSection));
    const complete = { ...growing, status: 'completed', isStreaming: false } as FlowItem;
    const settled = projection.project([source([complete])], opts).filter(row => row.timeline?.markdownSection);
    expect(settled.map(row => row.timeline)).toEqual(appended.map(row => row.timeline));
    expect(new ConversationDocumentProjection().project([source([complete])], opts)
      .filter(row => row.timeline?.markdownSection).map(row => row.timeline)).toEqual(settled.map(row => row.timeline));
    const thought = { id: 'thought', type: 'thinking', content: 'Thinking', status: 'completed' } as FlowItem;
    const handoff = new ConversationDocumentProjection().project([source([thought, complete])], opts);
    expect(handoff[0].timeline?.memberIds).toEqual(['thought', 'live']);
    expect(handoff[0].timeline?.key).toBe('turn:thought');
    expect(handoff.slice(1).filter(row => row.timeline?.markdownSection).every(row => row.timeline?.memberIds.join() === 'live')).toBe(true);
  });

  it('preserves section bookmark coordinates when a medium live reply reopens as history', () => {
    const text = { id: 'medium', type: 'text', content: 'A medium paragraph.\n\n'.repeat(350), isMarkdown: true, status: 'streaming', isStreaming: true } as FlowItem;
    const opts = options();
    const live = new ConversationDocumentProjection().project([source([text])], opts);
    const history = new ConversationDocumentProjection().project([source([{ ...text, status: 'completed', isStreaming: false } as FlowItem])], opts);
    const ranges = (rows: VirtualItem[]) => rows.filter(row => row.timeline?.markdownSection).map(row => ({ key: row.timeline!.key, range: row.timeline!.markdownSection }));
    expect(ranges(live).length).toBeGreaterThan(1);
    expect(ranges(history)).toEqual(ranges(live));
  });
  it('retains source and member navigation identities inside a quiet execution receipt', () => {
    const projection = new ConversationDocumentProjection();
    const input = { type: 'background-run', turnId: 'quiet', turn: {
      userMessage: { content: 'Task instructions' }, modelRounds: [{ items: [{ id: 'raw-text', type: 'text', content: 'Original result' }] }],
    } } as unknown as VirtualItem;
    const before = JSON.stringify(input);
    const rows = projection.project([input], options());
    expect(rows[0].timeline?.memberIds).toEqual(['raw-text']);
    expect(findTimelineBlockIndex(rows, 0, 'raw-text')).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('resolves repeated member ids within the requested source row', () => {
    const projection = new ConversationDocumentProjection();
    const first = source([agent('reused')]);
    const second = { ...source([agent('reused')]), turnId: 'another-turn' };
    const rows = projection.project([first, second], options());
    const index = findTimelineBlockIndex(rows, 1, 'reused');
    expect(rows[index].turnId).toBe('another-turn');
    expect(rows[index].timeline?.sourceIndex).toBe(1);
  });

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

  describe('running group presentation', () => {
    // Group lifecycle comes from the same projection the transcript uses.
    const live = (items: FlowItem[]) => projectAdjacentFlowGroups([{
      type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: false,
      data: { id: 'round', index: 0, startTime: 1, status: 'streaming', isStreaming: true, isComplete: false, items },
    } as VirtualItem], { isTurnComplete: false })[0];
    const shown = (rows: VirtualItem[]) => rows.filter(row => row.timeline?.kind === 'group-members')
      .flatMap(row => row.timeline!.memberIds);
    const header = (rows: VirtualItem[]) => rows.find(row => row.timeline?.kind === 'group-header')!.timeline!;

    it('shows only the call in flight for a serial run', () => {
      const rows = new ConversationDocumentProjection().project([live([tool('a'), tool('b'), tool('c', 'running')])], options());
      expect(header(rows)).toMatchObject({ expanded: false, liveMembers: true });
      expect(header(rows).group!.phase).toBe('collecting');
      expect(shown(rows)).toEqual(['c']);
    });

    it('shows only the calls still running in a parallel batch', () => {
      const rows = new ConversationDocumentProjection().project(
        [live([tool('a'), tool('b', 'running'), tool('c'), tool('d', 'running')])], options());
      expect(shown(rows)).toEqual(['b', 'd']);
    });

    it('keeps the latest call between serial steps instead of emptying the group', () => {
      const rows = new ConversationDocumentProjection().project([live([tool('a'), tool('b')])], options());
      expect(header(rows).liveMembers).toBe(true);
      expect(shown(rows)).toEqual(['b']);
    });

    it('lists every member once the reader expands the running group', () => {
      const projection = new ConversationDocumentProjection();
      const input = live([tool('a'), tool('b'), tool('c', 'running')]);
      const id = header(projection.project([input], options())).group!.groupId;
      const rows = projection.project([input], { ...options(), groupStates: new Map([[id, true]]) });
      expect(header(rows)).toMatchObject({ expanded: true });
      expect(header(rows).liveMembers).toBeUndefined();
      expect(shown(rows)).toEqual(['a', 'b', 'c']);
    });

    it('keeps an approval answerable inside a folded group without the settled calls', () => {
      const projection = new ConversationDocumentProjection();
      const input = live([tool('a'), tool('b'), tool('c')]);
      const id = header(projection.project([input], options())).group!.groupId;
      const rows = projection.project([input], {
        ...options(), groupStates: new Map([[id, false]]), pendingPermissionToolCallIds: new Set(['b']),
      });
      expect(shown(rows)).toEqual(['b']);
    });

    it('keeps a held running group on its live call instead of expanding it', () => {
      const projection = new ConversationDocumentProjection();
      const opts = options();
      const input = live([tool('a'), tool('b'), tool('c', 'running')]);
      const id = header(projection.project([input], opts)).group!.groupId;
      // A revealing member and an on-screen reader both hold the group.
      const release = opts.reader.holdGroup(id, 'reveal:text');
      expect(shown(projection.project([input], opts))).toEqual(['c']);
      // Settling under the hold keeps what the reader sees until it releases.
      const settled = source([tool('a'), tool('b'), tool('c')]);
      const held = projection.project([settled], opts);
      expect(header(held).liveMembers).toBe(true);
      expect(shown(held)).toEqual(['c']);
      release();
      expect(shown(projection.project([settled], opts))).toEqual([]);
    });

    it('keeps the assistant narrative visible while finished calls fold', () => {
      const note = { id: 'note', type: 'text', content: 'Checking the branch.', isMarkdown: true, isStreaming: false,
        status: 'completed', timestamp: 1 } as FlowItem;
      const rows = new ConversationDocumentProjection().project([live([tool('a'), note, tool('b'), tool('c', 'running')])], options());
      expect(shown(rows)).toEqual(['note', 'c']);
    });

    it('folds a settled group to its header', () => {
      const rows = new ConversationDocumentProjection().project([source([tool('a'), tool('b'), tool('c')])], options());
      expect(header(rows)).toMatchObject({ expanded: false });
      expect(header(rows).liveMembers).toBeUndefined();
      expect(shown(rows)).toEqual([]);
    });
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

  it('opens a group when one member holds an expanded capsule key of this session', () => {
    const projection = new ConversationDocumentProjection();
    const input = source([tool('a'), tool('b')]);
    const open = (sessionId: string | undefined, keys: string[]) => projection
      .project([input], { ...options(), sessionId, expandedToolCapsules: new Set(keys) })
      .some(row => row.timeline?.kind === 'group-members');
    expect(projection.project([input], { ...options(), sessionId: 'session' })
      .some(row => row.timeline?.kind === 'group-members')).toBe(false);
    expect(open('session', [toolCapsuleStateKey('session', 'turn', 'b')])).toBe(true);
    // A foreign session or an unreadable key never opens this transcript.
    expect(open('session', [toolCapsuleStateKey('other', 'turn', 'b'), 'unreadable'])).toBe(false);
  });

  it('reuses unchanged member rows and replaces only the one that changed', () => {
    const projection = new ConversationDocumentProjection();
    const items = [tool('a'), tool('b')];
    const groupId = buildInlineToolGroupData('round', { type: 'explore', items, isLast: true }).groupId;
    const opts = () => ({ ...options(), groupStates: new Map([[groupId, true]]) });
    const members = (rows: VirtualItem[]) => rows.filter(row => row.timeline?.kind === 'group-members');
    const first = members(projection.project([source(items)], opts()));
    expect(first).toHaveLength(2);
    expect(members(projection.project([source(items)], opts())).map(row => first.includes(row))).toEqual([true, true]);
    const changed = members(projection.project([source([items[0], { ...items[1], partialParams: { file_path: '/b' } }])], opts()));
    expect(changed.map(row => first.includes(row))).toEqual([true, false]);
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
