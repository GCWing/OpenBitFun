import { describe, expect, it } from 'vitest';
import type { ExploreGroupData, VirtualItem } from '../../store/modernFlowChatStore';
import type { AnyFlowItem, FlowToolItem } from '../../types/flow-chat';
import { computeExploreStats } from '../../tool-cards/toolCardMetadata';
import { projectAdjacentExploreGroups } from './exploreGroupProjection';
import { getModelRoundExploreGroups, getProjectedModelRoundGroups } from './modelRoundItemGrouping';
import { resolveFlowChatFocusTarget } from './flowChatFocusTarget';
import { buildFlowChatSearchMatches } from './useFlowChatSearch';
import { estimateVirtualItemHeight, getKnownVirtualItemHeightPx } from './virtualItemHeightEstimators';
import { getVirtualItemStableKey } from './virtualItemIdentity';

function tool(id: string, toolName = 'Grep', status: FlowToolItem['status'] = 'completed'): FlowToolItem {
  return { id, type: 'tool', toolName, status, timestamp: 1, toolCall: { id, input: {} } };
}
function text(id: string, content = id): AnyFlowItem {
  return { id, type: 'text', content, isStreaming: false, status: 'completed', timestamp: 1 };
}
function model(id: string, items: AnyFlowItem[]): Extract<VirtualItem, { type: 'model-round' }> {
  return { type: 'model-round', turnId: 'turn', isLastRound: false, isTurnComplete: false,
    data: { id, index: 0, startTime: 1, items, status: 'completed', isComplete: true, isStreaming: false } };
}
function explore(id: string, items: AnyFlowItem[]): Extract<VirtualItem, { type: 'explore-group' }> {
  return { type: 'explore-group', turnId: 'turn', data: {
    groupId: id, allItems: items, rounds: [model(id, items).data], stats: computeExploreStats(items),
    isGroupStreaming: false, isLastGroupInTurn: false, wasCutByCritical: true,
  } };
}
function groups(items: VirtualItem[]): ExploreGroupData[] {
  return items.flatMap(item => item.type === 'explore-group' ? [item.data]
    : item.type === 'model-round' ? getModelRoundExploreGroups(item.data, item.projectedGroups) : []);
}

describe('adjacent exploration projection', () => {
  it('collects inline/whole-round/inline runs once, preserving records, order and mixed row keys', () => {
    const first = model('first', [text('intro'), tool('grep-1')]);
    const middle = explore('middle', [tool('read', 'Read')]);
    const last = model('last', [tool('grep-2'), text('conclusion'), tool('after')]);
    const recorded = JSON.stringify([first, middle, last]);
    const projected = projectAdjacentExploreGroups([first, middle, last]);
    expect(projected.map(getVirtualItemStableKey)).toEqual([getVirtualItemStableKey(first), getVirtualItemStableKey(last)]);
    expect(groups(projected).map(group => group.allItems.map(item => item.id))).toEqual([
      ['grep-1', 'read', 'grep-2', 'conclusion', 'after'],
    ]);
    expect(groups(projected)[0].stats).toEqual({ readCount: 1, searchCount: 3, commandCount: 0 });
    expect(groups(projected)[0].sourceGroupIds).toEqual(expect.arrayContaining([
      'first:explore:grep-1', 'middle', 'middle:explore:read', 'last:explore:grep-2',
    ]));
    expect(JSON.stringify([first, middle, last])).toBe(recorded);
    const modelRows = projected.filter((item): item is Extract<VirtualItem, { type: 'model-round' }> => item.type === 'model-round');
    expect(modelRows[0].data).toBe(first.data);
    expect(modelRows[1].data).toBe(last.data);
  });

  it('collects leading mixed-round exploration into the preceding standalone group', () => {
    const rows = projectAdjacentExploreGroups([
      explore('explore', [tool('read', 'Read')]), model('mixed', [tool('search'), text('answer')]),
    ]);
    expect(groups(rows)).toHaveLength(1);
    expect(groups(rows)[0].allItems.map(item => item.id)).toEqual(['read', 'search']);
    const mixed = rows[1] as Extract<VirtualItem, { type: 'model-round' }>;
    expect(getProjectedModelRoundGroups(mixed)).toEqual([{ type: 'critical', item: mixed.data.items[1] }]);
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'search' }, rows)).toMatchObject({
      resolvedVirtualIndex: 0, expandExploreGroupId: 'explore',
    });
  });

  it.each([
    tool('failed', 'Edit', 'error'), tool('cancelled', 'Grep', 'cancelled'),
    tool('approval', 'Read', 'pending_confirmation'),
    tool('write', 'Write'), tool('task', 'Task'),
  ])('keeps $id as a visible boundary', boundary => {
    const rows = projectAdjacentExploreGroups([
      explore('before', [tool('before')]), model('boundary', [boundary]), explore('after', [tool('after')]),
    ]);
    expect(groups(rows).map(group => group.groupId)).toEqual(['before', 'after']);
  });

  it.each([
    text('narrative'),
    { id: 'thinking', type: 'thinking' as const, content: 'Reasoning', status: 'completed' as const,
      timestamp: 1, isStreaming: false, isCollapsed: true },
  ])('collects $id between standalone groups without losing its model-row key', companion => {
    const middle = model('middle', [companion]);
    const rows = projectAdjacentExploreGroups([
      explore('before', [tool('before')]), middle, explore('after', [tool('after')]),
    ]);
    expect(groups(rows).map(group => group.allItems.map(item => item.id))).toEqual([['before', companion.id, 'after']]);
    expect(getVirtualItemStableKey(rows[1])).toBe(getVirtualItemStableKey(middle));
    expect(estimateVirtualItemHeight(rows[1]).heightPx).toBe(0);
  });

  it('keeps continuation, retry history, user steering and turn boundaries', () => {
    const continued = model('continued', [tool('continued-read')]);
    continued.data.renderHints = { continuedAfterInterruption: true };
    const retried = model('retried', [tool('retried-read')]);
    retried.data.historyRounds = [model('earlier', [text('old')]).data];
    const steering: VirtualItem = { type: 'user-steering-message', turnId: 'turn',
      data: { id: 'steer', content: 'New instruction', timestamp: 1 }, steeringId: 'steer', steeringStatus: 'pending' };
    for (const boundary of [continued, retried, steering]) {
      const rows = projectAdjacentExploreGroups([explore('before', [tool('before')]), boundary]);
      expect(groups(rows)[0].allItems.map(item => item.id)).toEqual(['before']);
    }
    const otherTurn = { ...explore('other', [tool('other')]), turnId: 'other-turn' };
    expect(groups(projectAdjacentExploreGroups([explore('before', [tool('before')]), otherTurn]))).toHaveLength(2);
  });

  it('collects across blank and reasoning separators and locates thinking in its new owner', () => {
    const thinking: AnyFlowItem = { id: 'thinking', type: 'thinking', content: 'needle', timestamp: 1,
      status: 'completed', isStreaming: false, isCollapsed: true };
    const rows = projectAdjacentExploreGroups([
      model('first', [text('intro'), tool('first-search')]),
      model('blank', [text('blank', '  ')]), model('second', [thinking, tool('next-search')]),
    ]);
    expect(groups(rows)).toHaveLength(1);
    expect(buildFlowChatSearchMatches(rows, 'needle')).toEqual([expect.objectContaining({
      virtualItemIndex: 0, flowItemId: 'thinking', expandableIds: ['first:explore:first-search', 'thinking'],
    })]);
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'next-search' }, rows)).toMatchObject({
      resolvedVirtualIndex: 0, expandExploreGroupId: 'first:explore:first-search',
    });
  });

  it('keeps an emptied live row key without reserving duplicate exploration height', () => {
    const live = model('live', [tool('live-search')]);
    live.data.isStreaming = true;
    live.data.isComplete = false;
    const rows = projectAdjacentExploreGroups([explore('before', [tool('read', 'Read')]), live]);
    expect(rows.map(getVirtualItemStableKey)).toEqual(['explore-group:turn:before', 'model-round:turn:live']);
    expect(groups(rows)).toHaveLength(1);
    expect(estimateVirtualItemHeight(rows[1]).heightPx).toBe(0);
    expect(groups(rows)[0].groupId).toBe('before');
  });

  it('reserves real row height for a collected round with a footer or continuation control', () => {
    const collected = { ...model('collected', [tool('read', 'Read')]), projectedGroups: [] };
    expect(getKnownVirtualItemHeightPx(collected)).toBe(0);
    expect(getKnownVirtualItemHeightPx({ ...collected, isLastRound: true, isTurnComplete: true })).toBeUndefined();
    expect(getKnownVirtualItemHeightPx({
      ...collected,
      data: { ...collected.data, renderHints: { continuedAfterInterruption: true } },
    })).toBeUndefined();
  });
});
