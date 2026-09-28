import { describe, expect, it } from 'vitest';
import { buildModelRoundItemGroups, getModelRoundExploreGroups } from './modelRoundItemGrouping';
import type { FlowTextItem, FlowThinkingItem, FlowToolItem, FlowUserSteeringItem, ModelRound } from '../../types/flow-chat';

function makeTextItem(id: string): FlowTextItem {
  return {
    id,
    type: 'text',
    content: 'assistant text',
    isStreaming: false,
    isMarkdown: true,
    timestamp: 1000,
    status: 'completed',
  };
}

function makeReadTool(
  id: string,
  status: FlowToolItem['status'] = 'completed',
  endTime?: number,
): FlowToolItem {
  return {
    id,
    type: 'tool',
    toolName: 'Read',
    timestamp: 1001,
    status,
    toolCall: {
      id,
      input: { file_path: 'src/main.rs' },
    },
    ...(status === 'completed'
      ? {
          toolResult: {
            result: 'file contents',
            success: true,
          },
        }
      : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
}

function makeSteeringItem(id: string): FlowUserSteeringItem {
  return {
    id,
    type: 'user-steering',
    steeringId: id,
    content: 'Run the newly queued request now',
    roundIndex: 0,
    timestamp: 1002,
    status: 'pending',
  };
}

describe('buildModelRoundItemGroups', () => {
  it('connects thinking to the next visible item without mutating recorded entries', () => {
    const thinking: FlowThinkingItem = {
      id: 'thinking', type: 'thinking', content: 'Inspecting', timestamp: 1,
      status: 'completed', isStreaming: false, isCollapsed: true,
    };
    const blank = { ...makeTextItem('blank'), content: ' \n\t' };
    const hidden = makeReadTool('hidden', 'error');
    const edit = { ...makeReadTool('edit'), toolName: 'Edit' };
    const items = [thinking, blank, hidden, edit, { ...blank, id: 'trailing-blank' }];
    const groups = buildModelRoundItemGroups({
      items, isStreaming: false, disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });
    expect(groups).toEqual([
      { type: 'critical', item: thinking },
      { type: 'critical', item: edit },
    ]);
    expect(groups[0].type === 'critical' && groups[0].item).toBe(thinking);
    expect(groups[1].type === 'critical' && groups[1].item).toBe(edit);
    expect(items).toHaveLength(5);
  });

  it('hides failed deferred reads while retaining approvals, cancellations and failed edits', () => {
    const deferred: FlowToolItem = {
      ...makeReadTool('deferred', 'error'), toolName: 'CallDeferredTool',
      toolCall: { id: 'deferred', input: { tool_name: 'Read', args: { file_path: 'a.ts' } } },
    };
    const pending = { ...deferred, id: 'pending', status: 'pending_confirmation' as const };
    const cancelled = { ...deferred, id: 'cancelled', status: 'cancelled' as const, interruptionReason: 'app_restart' as const };
    const error = { ...makeReadTool('failed-edit', 'error'), toolName: 'Edit' };
    const groups = buildModelRoundItemGroups({
      items: [deferred, pending, cancelled, error], isStreaming: false,
      disableExploreGrouping: true, isCollapsibleTool: () => true,
    });
    expect(groups).toEqual([pending, cancelled, error].map(item => ({ type: 'critical', item })));
  });

  it('does not create rows from failed reads or blank text', () => {
    expect(buildModelRoundItemGroups({
      items: [{ ...makeTextItem('blank'), content: '' }, makeReadTool('hidden', 'error')],
      isStreaming: false, disableExploreGrouping: false, isCollapsibleTool: () => true,
    })).toEqual([]);
  });

  it('keeps user-steering items as critical visible content', () => {
    const steeringItem = makeSteeringItem('steering-1');

    const groups = buildModelRoundItemGroups({
      items: [steeringItem],
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: () => false,
    });

    expect(groups).toEqual([
      {
        type: 'critical',
        item: steeringItem,
      },
    ]);
  });

  it('flushes pending assistant text before rendering user-steering content', () => {
    const textItem = makeTextItem('text-1');
    const steeringItem = makeSteeringItem('steering-1');

    const groups = buildModelRoundItemGroups({
      items: [textItem, steeringItem],
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: () => false,
    });

    expect(groups).toEqual([
      {
        type: 'critical',
        item: textItem,
      },
      {
        type: 'critical',
        item: steeringItem,
      },
    ]);
  });

  it('keeps visible narrative outside exploration even when a read follows', () => {
    const textItem = makeTextItem('text-1');
    const toolItem = makeReadTool('tool-1');

    const groups = buildModelRoundItemGroups({
      items: [textItem, toolItem],
      isStreaming: false,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });

    expect(groups).toEqual([
      { type: 'critical', item: textItem },
      {
        type: 'explore',
        items: [toolItem],
        isLast: true,
      },
    ]);
  });

  it('keeps an active collapsible tool inside the preceding explore group', () => {
    const completedTool = makeReadTool('tool-1');
    const runningTool = makeReadTool('tool-2', 'running');

    const groups = buildModelRoundItemGroups({
      items: [completedTool, runningTool],
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });

    expect(groups).toEqual([
      {
        type: 'explore',
          items: [completedTool, runningTool],
          isLast: true,
      },
    ]);
  });

  it('merges a completed collapsible tool without waiting on wall-clock time', () => {
    const completedTool = makeReadTool('tool-1');
    const justCompletedTool = makeReadTool('tool-2', 'completed', 10_000);

    const groups = buildModelRoundItemGroups({
      items: [completedTool, justCompletedTool],
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });

    expect(groups).toEqual([
      {
        type: 'explore',
        items: [completedTool, justCompletedTool],
        isLast: true,
      },
    ]);
  });

  it('produces the same grouping whether or not the round is streaming', () => {
    const items = [makeReadTool('tool-1'), makeReadTool('tool-2', 'completed', 10_000)];

    const streaming = buildModelRoundItemGroups({
      items,
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });
    const settled = buildModelRoundItemGroups({
      items,
      isStreaming: false,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });

    expect(streaming).toEqual(settled);
  });

  it('collects preceding thinking once a following card is eligible, independently of round streaming', () => {
    const thinkingItem = {
      id: 'thinking-1',
      type: 'thinking' as const,
      content: 'Inspecting',
      isStreaming: true,
      timestamp: 999,
      status: 'streaming' as const,
    };
    const toolItem = makeReadTool('tool-1');

    const groups = buildModelRoundItemGroups({
      items: [thinkingItem, toolItem],
      isStreaming: true,
      disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    });

    expect(groups).toEqual([
      {
        type: 'explore',
        items: [thinkingItem, toolItem],
        isLast: true,
      },
    ]);
  });

  it('keeps completed thinking and text in recorded order inside one folded tool run', () => {
    const thinking: FlowThinkingItem = {
      id: 'thinking', type: 'thinking', content: 'Inspecting the second file',
      timestamp: 1001, status: 'completed', isStreaming: false, isCollapsed: true,
    };
    const before = makeReadTool('before');
    const after = makeReadTool('after');
    const text = makeTextItem('explanation');
    const items = [before, thinking, text, after];
    expect(buildModelRoundItemGroups({
      items, isStreaming: false, disableExploreGrouping: false,
      isCollapsibleTool: toolName => toolName === 'Read',
    })).toEqual([
      { type: 'explore', items: [before, thinking, text, after], isLast: true },
    ]);
    expect(items).toEqual([before, thinking, text, after]);
  });

  it('collects mixed-round searches with stable identities and shared operation counts', () => {
    const grep = { ...makeReadTool('grep'), toolName: 'Grep' };
    const glob = { ...makeReadTool('glob'), toolName: 'Glob' };
    const failed = makeReadTool('failed', 'error');
    const deferred = {
      ...makeReadTool('deferred'), toolName: 'CallDeferredTool',
      toolCall: { id: 'deferred', input: { tool_name: 'WebSearch', args: { query: 'architecture' } } },
    };
    const round: ModelRound = {
      id: 'round', index: 0, startTime: 1, status: 'completed', isStreaming: false, isComplete: true,
      items: [makeTextItem('intro'), grep, glob, failed, makeReadTool('read'), deferred],
    };
    const groups = getModelRoundExploreGroups(round);
    expect(groups.map(group => ({ id: group.groupId, ids: group.allItems.map(item => item.id), stats: group.stats }))).toEqual([
      { id: 'round:explore:grep', ids: ['grep', 'glob', 'read', 'deferred'], stats: { readCount: 1, searchCount: 3, commandCount: 0 } },
    ]);
    const appended = getModelRoundExploreGroups({ ...round, items: [...round.items, makeReadTool('later')] });
    expect(appended.map(group => group.groupId)).toEqual(groups.map(group => group.groupId));
    expect(getModelRoundExploreGroups({ ...round, renderHints: { disableExploreGrouping: true } })).toEqual([]);
    expect(getModelRoundExploreGroups({ ...round, items: [{ ...grep, isParamsStreaming: true }] }))
      .toMatchObject([{ groupId: 'round:explore:grep', isGroupStreaming: true, allItems: [{ id: 'grep' }] }]);
  });
});
