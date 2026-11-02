import { describe, expect, it } from 'vitest';
import type { AnyFlowItem, FlowToolItem } from '../../types/flow-chat';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getContextLoadKind, isSettledContextLoad } from '../../tool-cards/contextLoadClassification';
import { isCollapsibleTool } from '../../tool-cards/toolCardMetadata';
import { buildModelRoundItemGroups, getModelRoundToolGroups, getProjectedModelRoundGroups, isExploreGroupExpanded } from './modelRoundItemGrouping';
import { projectAdjacentExploreGroups } from './exploreGroupProjection';
import { resolveFlowChatFocusTarget } from './flowChatFocusTarget';
import { estimateVirtualItemHeight } from './virtualItemHeightEstimators';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { buildFlowChatSearchMatches } from './useFlowChatSearch';

function tool(id: string, toolName = 'Skill', input: Record<string, unknown> = {}): FlowToolItem {
  return { id, type: 'tool', toolName, timestamp: 1, status: 'completed',
    toolCall: { id, input }, toolResult: { success: true, result: {} } };
}
function model(id: string, items: AnyFlowItem[], turnId = 'turn'): Extract<VirtualItem, { type: 'model-round' }> {
  return { type: 'model-round', turnId, isLastRound: false, isTurnComplete: false,
    data: { id, index: 0, startTime: 1, items, status: 'completed', isComplete: true, isStreaming: false } };
}
function contextGroups(items: VirtualItem[]) {
  return items.flatMap(item => item.type === 'model-round'
    ? getModelRoundToolGroups(item.data, item.projectedGroups).filter(group => group.category === 'context') : []);
}
function inline(items: AnyFlowItem[]) {
  return buildModelRoundItemGroups({ items, isStreaming: false, disableExploreGrouping: false, isCollapsibleTool });
}

describe('context loading classification', () => {
  it('classifies skill/spec and the three discovery actions, including deferred identities', () => {
    for (const item of [tool('skill'), tool('spec', 'GetToolSpec'),
      ...['list', 'search', 'get'].map(action => tool(action, 'OpenBitFunControl', { action })),
      tool('deferred', 'CallDeferredTool', { tool_name: 'OpenBitFunControl', args: { action: 'get' } }),
      tool('deferred-skill', 'CallDeferredTool', { tool_name: 'Skill', args: { command: 'review' } }),
    ]) expect(isSettledContextLoad(item)).toBe(true);
  });

  it('keeps execution, ordinary reading, MCP calls and unknown gateway targets outside context loading', () => {
    for (const item of [tool('read', 'Read', { file_path: 'SKILL.md' }), tool('compress', 'ContextCompression'),
      tool('command', 'ExecCommand'), tool('mcp', 'mcp__server__search'), tool('unknown', 'CallDeferredTool'),
      ...['open', 'execute', 'configure'].map(action => tool(action, 'OpenBitFunControl', { action })),
      tool('deferred-edit', 'CallDeferredTool', { tool_name: 'Edit', args: {} }),
    ]) expect(getContextLoadKind(item)).toBeUndefined();
  });

  it.each(['error', 'cancelled', 'rejected', 'pending_confirmation'] as const)(
    'keeps %s context calls visible', status => {
      const item = { ...tool('state'), status };
      expect(isSettledContextLoad(item)).toBe(false);
      expect(inline([tool('before'), item, tool('after')]).map(group => group.type)).toEqual(['critical', 'critical', 'critical']);
    },
  );

  it('does not fold failed results, partial parameters or unavailable capability contracts', () => {
    const failures = [
      { ...tool('partial'), isParamsStreaming: true },
      { ...tool('failed'), toolResult: { success: false, result: {} } },
      { ...tool('payload-failed'), toolResult: { success: true, result: { success: false } } },
      { ...tool('unavailable', 'OpenBitFunControl', { action: 'get' }),
        toolResult: { success: true, result: { capability: { id: 'remote' }, controlAvailability: { status: 'unavailable' } } } },
    ];
    failures.forEach(item => expect(isSettledContextLoad(item)).toBe(false));
  });
});

describe('context group projection', () => {
  it('keeps one call native and folds two calls, including repeat loads of the same tool', () => {
    expect(inline([tool('one')])).toEqual([{ type: 'critical', item: tool('one') }]);
    const repeated = [tool('one', 'GetToolSpec', { tool_name: 'WebSearch' }), tool('two', 'GetToolSpec', { tool_name: 'WebSearch' })];
    expect(inline(repeated)).toEqual([{ type: 'context', items: repeated, isLast: true }]);
  });

  it('collects across model rounds without rewriting recorded items and uses the first operation as owner', () => {
    const recorded = [model('first', [tool('skill')]), model('second', [tool('spec', 'GetToolSpec')])];
    const original = JSON.stringify(recorded);
    const rows = projectAdjacentExploreGroups(recorded);
    const groups = contextGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ category: 'context', groupId: 'first:context:skill' });
    expect(groups[0].allItems.map(item => item.id)).toEqual(['skill', 'spec']);
    expect(rows.map(getVirtualItemStableKey)).toEqual(recorded.map(getVirtualItemStableKey));
    expect(estimateVirtualItemHeight(rows[1]).heightPx).toBe(0);
    expect(JSON.stringify(recorded)).toBe(original);
    expect(contextGroups(projectAdjacentExploreGroups(JSON.parse(original)))).toEqual(groups);
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'spec' }, rows)).toMatchObject({
      resolvedVirtualIndex: 0, expandExploreGroupId: 'first:context:skill',
    });
  });

  it('appends without resetting an open source group or changing its owner', () => {
    const first = model('first', [tool('one'), tool('two', 'GetToolSpec')]);
    const initial = contextGroups(projectAdjacentExploreGroups([first]))[0];
    const second = model('second', [tool('three', 'OpenBitFunControl', { action: 'search' })]);
    const appended = contextGroups(projectAdjacentExploreGroups([first, second]))[0];
    expect(appended.groupId).toBe(initial.groupId);
    expect(isExploreGroupExpanded(appended, new Map([[initial.groupId, true]]))).toBe(true);
    expect(isExploreGroupExpanded(appended, new Map([[initial.groupId, false]]))).toBe(false);
  });

  it.each([
    tool('explore', 'Read'), tool('execution', 'ExecCommand'),
  ] satisfies AnyFlowItem[])('keeps $id between two separate groups', boundary => {
    const rows = projectAdjacentExploreGroups([
      model('first', [tool('one'), tool('two')]), model('boundary', [boundary]), model('last', [tool('three'), tool('four')]),
    ]);
    expect(contextGroups(rows).map(group => group.allItems.map(item => item.id))).toEqual([['one', 'two'], ['three', 'four']]);
    const middle = rows[1] as Extract<VirtualItem, { type: 'model-round' }>;
    expect(getProjectedModelRoundGroups(middle)).toHaveLength(1);
  });

  it('collects intervening reasoning and prose and searches inside the resulting group', () => {
    const rows = projectAdjacentExploreGroups([
      model('first', [tool('one')]),
      model('explanation', [
        { id: 'text', type: 'text', content: 'Explanation', timestamp: 1, status: 'completed', isStreaming: false },
        { id: 'thinking', type: 'thinking', content: 'Reasoning', timestamp: 1, status: 'completed', isStreaming: false },
      ]),
      model('last', [tool('two')]),
    ]);
    expect(contextGroups(rows).map(group => group.allItems.map(item => item.id)))
      .toEqual([['one', 'text', 'thinking', 'two']]);
    expect(buildFlowChatSearchMatches(rows, 'Explanation')[0]).toMatchObject({
      virtualItemIndex: 0, flowItemId: 'text', expandableIds: ['first:context:one'],
    });
  });

  it('does not merge across turns, steering, retry controls, or disabled grouping', () => {
    const first = model('first', [tool('one')]);
    const second = model('second', [tool('two')]);
    const steering: VirtualItem = { type: 'user-steering-message', turnId: 'turn', steeringId: 'steer', steeringStatus: 'pending',
      data: { id: 'steer', content: 'Wait', timestamp: 1 } };
    for (const rows of [
      [first, { ...second, turnId: 'other-turn' }], [first, steering, second],
      [first, { ...second, data: { ...second.data, renderHints: { continuedAfterInterruption: true } } }],
      [first, { ...second, data: { ...second.data, renderHints: { disableExploreGrouping: true } } }],
      [first, { ...second, data: { ...second.data, historyRounds: [model('old', [tool('old')]).data] } }],
    ]) expect(contextGroups(projectAdjacentExploreGroups(rows))).toEqual([]);
  });

  it('keeps the active card in the same group through completion', () => {
    const first = model('first', [tool('one'), tool('two')]);
    const running = { ...tool('active', 'GetToolSpec'), status: 'running' as const };
    const live = model('live', [running]);
    const before = projectAdjacentExploreGroups([first, live]);
    expect(contextGroups(before)[0].allItems).toHaveLength(3);
    expect(getProjectedModelRoundGroups(before[1] as typeof live)).toEqual([]);
    const after = projectAdjacentExploreGroups([first, model('live', [{ ...running, status: 'completed' }])]);
    expect(contextGroups(after)[0].allItems).toHaveLength(3);
    expect(contextGroups(after)[0].groupId).toBe(contextGroups(before)[0].groupId);
  });
});
