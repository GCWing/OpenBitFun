import { describe, expect, it } from 'vitest';
import type { FlowItem, FlowTextItem, FlowThinkingItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { buildFlowItemGroups, getProjectedModelRoundGroups } from './roundGroups';
import { projectAdjacentFlowGroups } from './groupProjection';
import { indexFlowGroups } from './selectors';
import { flowGroupPolicies } from './policies';
import { isFlowGroupExpanded, type FlowGroupCategory } from './types';
import { buildFlowChatSearchMatches } from '../components/modern/useFlowChatSearch';
import { resolveFlowChatFocusTarget } from '../components/modern/flowChatFocusTarget';

type ToolFamily = FlowGroupCategory | 'shell';
function tool(id: string, category: ToolFamily = 'explore'): FlowToolItem {
  return { id, type: 'tool', timestamp: 1, status: 'completed',
    toolName: { explore: 'Read', context: 'GetToolSpec', shell: 'ExecCommand', interface: 'ComputerUse', 'file-edit': 'Edit' }[category],
    toolCall: { id, input: category === 'interface' ? { action: 'get_app_state' }
      : category === 'file-edit' ? { file_path: '/remote/src/App.tsx' } : {} },
    toolResult: { success: true, result: {} } };
}
function narrative(id: string, type: 'thinking' | 'text' = 'thinking'): FlowTextItem | FlowThinkingItem {
  const common = { id, content: id, timestamp: 1, status: 'completed' as const, isStreaming: false };
  return type === 'thinking' ? { ...common, type, isCollapsed: true } : { ...common, type };
}
function row(id: string, items: FlowItem[]): Extract<VirtualItem, { type: 'model-round' }> {
  return { type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: true,
    data: { id, items, index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false } };
}
const categories: ToolFamily[] = ['explore', 'context', 'shell', 'interface', 'file-edit'];

describe('card-based collection boundaries', () => {
  it.each(categories)('%s collects leading reasoning and intervening prose in recorded order', category => {
    const intro = narrative('intro', 'text');
    const collected = [narrative('plan'), tool('one', category), narrative('progress', 'text'),
      narrative('next-plan'), tool('two', category)];
    const answer = narrative('answer', 'text');
    const items = [intro, ...collected, answer];
    expect(buildFlowItemGroups({ items })).toEqual([
      { type: 'critical', item: intro },
      { type: category === 'shell' ? 'explore' : category, items: collected, isLast: false },
      { type: 'critical', item: answer },
    ]);
    expect(items).toEqual([intro, ...collected, answer]);
  });

  it.each(categories)('%s merges through prose-only rounds and ignores model-round completion flags', category => {
    const inputs = [row('first', [narrative('intro', 'text'), tool('one', category)]),
      row('middle', [narrative('progress', 'text'), narrative('needle')]),
      row('last', [tool('two', category), narrative('answer', 'text')])];
    const recorded = JSON.stringify(inputs);
    const rows = projectAdjacentFlowGroups(inputs);
    const index = indexFlowGroups(rows);
    const owner = index.byMemberId.get('one')!;
    expect(index.byTurnId.get('turn')).toHaveLength(1);
    expect(owner.group.allItems.map(item => item.id)).toEqual(['one', 'progress', 'needle', 'two']);
    expect(index.byMemberId.get('two')).toBe(owner);
    expect(getProjectedModelRoundGroups(rows[1] as typeof inputs[0])).toEqual([]);
    expect(getProjectedModelRoundGroups(rows[2] as typeof inputs[0])).toEqual([
      { type: 'critical', item: inputs[2].data.items[1] },
    ]);
    expect(buildFlowChatSearchMatches(rows, 'needle')).toEqual([expect.objectContaining({
      virtualItemIndex: 0, expandableIds: [owner.group.groupId, 'needle'],
    })]);
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'needle' }, rows)).toMatchObject({
      resolvedVirtualIndex: 0, expandExploreGroupId: owner.group.groupId,
    });
    expect(projectAdjacentFlowGroups(rows)).toEqual(rows);
    expect(JSON.stringify(inputs)).toBe(recorded);
  });

  it.each(['context', 'interface', 'file-edit'] as const)('%s thresholds count only cards and leave uncollected narrative in its row', category => {
    const thinking = narrative('thinking');
    const call = tool('one', category);
    expect(buildFlowItemGroups({ items: [thinking, call] })).toEqual([
      { type: 'critical', item: thinking }, { type: 'critical', item: call },
    ]);
    const inputs = [row('thinking', [thinking]), row('tool', [call])];
    const rows = projectAdjacentFlowGroups(inputs);
    expect(indexFlowGroups(rows).byId.size).toBe(0);
    expect(getProjectedModelRoundGroups(rows[0] as typeof inputs[0])).toEqual([{ type: 'critical', item: thinking }]);
    expect(getProjectedModelRoundGroups(rows[1] as typeof inputs[0])).toEqual([{ type: 'critical', item: call }]);
  });

  it('preserves old disclosure aliases when previously separated groups become one', () => {
    const rows = projectAdjacentFlowGroups([row('round', [tool('one'), narrative('thinking'), tool('two'), tool('run', 'shell')])]);
    const group = indexFlowGroups(rows).byMemberId.get('two')!.group;
    expect(group.groupId).toBe('round:explore:one');
    expect(isFlowGroupExpanded(group, new Map([['round:explore:two', true]]))).toBe(true);
    expect(isFlowGroupExpanded(group, new Map([['round:shell:run', true]]))).toBe(true);
    expect(flowGroupPolicies.explore.attributes(group.allItems)['data-read-count']).toBe('2');
  });

  it('shows the live trailing thought inside the active run before the next card arrives', () => {
    const thinking = { ...narrative('thinking'), status: 'streaming' as const, isStreaming: true };
    const before = projectAdjacentFlowGroups([row('first', [tool('one')]), row('live', [thinking])]);
    expect(getProjectedModelRoundGroups(before[1] as Extract<VirtualItem, { type: 'model-round' }>))
      .toEqual([]);
    expect(indexFlowGroups(before).byMemberId.get('thinking')!.group.allItems.map(item => item.id))
      .toEqual(['one', 'thinking']);
    const after = projectAdjacentFlowGroups([row('first', [tool('one')]), row('live', [thinking, tool('two')])]);
    expect(indexFlowGroups(after).byMemberId.get('one')!.group.allItems.map(item => item.id))
      .toEqual(['one', 'thinking', 'two']);
  });

  it('keeps reasoning beside the following prose when a collected run ends at a user-facing card', () => {
    const thinking = narrative('thinking');
    const answer = narrative('answer', 'text');
    const wait = { ...tool('wait'), toolName: 'AgentWait' };
    const inputs = [row('reads', [tool('one'), tool('two')]), row('follow-up', [thinking, answer, wait])];
    const projected = projectAdjacentFlowGroups(inputs);
    expect(indexFlowGroups(projected).byMemberId.get('one')!.group.allItems.map(item => item.id))
      .toEqual(['one', 'two']);
    expect(indexFlowGroups(projected).byMemberId.has('thinking')).toBe(false);
    expect(getProjectedModelRoundGroups(projected[1] as typeof inputs[0])).toEqual([
      { type: 'critical', item: thinking },
      { type: 'critical', item: answer },
      { type: 'critical', item: wait },
    ]);
    expect(projectAdjacentFlowGroups(projected)).toEqual(projected);
  });

  it('keeps reasoning beside an immediate noncollectible card', () => {
    const thinking = narrative('thinking');
    const wait = { ...tool('wait'), toolName: 'AgentWait' };
    const inputs = [row('reads', [tool('one'), tool('two')]), row('follow-up', [thinking, wait])];
    const projected = projectAdjacentFlowGroups(inputs);
    expect(getProjectedModelRoundGroups(projected[1] as typeof inputs[0])).toEqual([
      { type: 'critical', item: thinking },
      { type: 'critical', item: wait },
    ]);
  });
});
