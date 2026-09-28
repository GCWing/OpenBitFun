import { describe, expect, it } from 'vitest';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { projectAdjacentFlowGroups } from './groupProjection';
import { getVirtualItemFlowGroups } from './selectors';
import { isFlowGroupExpanded, type FlowGroupCategory } from './types';

type ToolFamily = FlowGroupCategory | 'shell';
const categories: ToolFamily[] = ['explore', 'context', 'shell', 'interface'];
function tool(id: string, category: ToolFamily, status: FlowToolItem['status']): FlowToolItem {
  return { id, type: 'tool', timestamp: 1, status,
    toolName: { explore: 'Read', context: 'GetToolSpec', shell: 'ExecCommand', interface: 'ComputerUse' }[category],
    toolCall: { id, input: category === 'interface' ? { action: 'get_app_state' } : {} },
    ...(status === 'completed' ? { toolResult: { success: true, result: {} } } : {}),
  };
}
function row(id: string, items: FlowItem[], complete = false): VirtualItem {
  return { type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: complete,
    data: { id, items, index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false } };
}

describe('live collection lifecycle', () => {
  it.each(categories)('%s keeps running and completed calls in one open owner until the Turn ends', category => {
    const snapshots = [
      [row('one', [tool('one', category, 'running')]), row('two', [tool('two', category, 'running')])],
      [row('one', [tool('one', category, 'completed')]), row('two', [tool('two', category, 'running')])],
      [row('one', [tool('one', category, 'completed')]), row('two', [tool('two', category, 'completed')])],
    ];
    let ownerId: string | undefined;
    for (const inputs of snapshots) {
      const recorded = JSON.stringify(inputs);
      const rows = projectAdjacentFlowGroups(inputs);
      const groups = rows.flatMap(getVirtualItemFlowGroups);
      expect(groups).toHaveLength(1);
      const group = groups[0];
      ownerId ??= group.groupId;
      expect(group.groupId).toBe(ownerId);
      expect(group.phase).toBe('collecting');
      expect(group.allItems.map(item => item.id)).toEqual(['one', 'two']);
      expect(isFlowGroupExpanded(group)).toBe(true);
      expect(isFlowGroupExpanded(group, new Map([[ownerId, false]]))).toBe(false);
      expect(projectAdjacentFlowGroups(rows)).toEqual(rows);
      expect(JSON.stringify(inputs)).toBe(recorded);
    }
    const finalRows = projectAdjacentFlowGroups(snapshots[2], { isTurnComplete: true });
    const settled = finalRows.flatMap(getVirtualItemFlowGroups)[0];
    expect(settled.phase).toBe('settled');
    expect(isFlowGroupExpanded(settled)).toBe(false);
    expect(isFlowGroupExpanded(settled, new Map([[ownerId!, true]]))).toBe(true);
  });

  it('seals at an independent card and waits for pending execution before collapsing', () => {
    const render = (status: FlowToolItem['status']) => projectAdjacentFlowGroups([
      row('read', [tool('read', 'explore', status)]),
      row('write', [{ ...tool('write', 'explore', 'running'), toolName: 'Write' }]),
    ]).flatMap(getVirtualItemFlowGroups)[0];
    expect(render('running')).toMatchObject({ phase: 'settling', isGroupStreaming: true });
    expect(render('completed')).toMatchObject({ phase: 'settled', isGroupStreaming: false });
  });

  it.each(['explore', 'context', 'shell'] as const)('%s stays open while the next call streams parameters', category => {
    const initial = [tool('one', category, 'completed'), tool('two', category, 'completed')];
    const project = (next: FlowToolItem) => projectAdjacentFlowGroups([row('round', [...initial, next])])
      .flatMap(getVirtualItemFlowGroups);
    const snapshots = [
      { ...tool('next', category, 'streaming'), isParamsStreaming: true },
      tool('next', category, 'running'),
      tool('next', category, 'completed'),
    ].map(project);
    for (const groups of snapshots) {
      expect(groups).toHaveLength(1);
      expect(groups[0].groupId).toBe(snapshots[0][0].groupId);
      expect(groups[0].phase).toBe('collecting');
      expect(groups[0].allItems.map(item => item.id)).toEqual(['one', 'two', 'next']);
      expect(isFlowGroupExpanded(groups[0])).toBe(true);
    }
  });

  it.each(['CallDeferredTool', 'OpenBitFunControl', 'ControlHub', 'ComputerUse'])('keeps reasoning beside %s while its parameters resolve', toolName => {
    const initial: FlowItem[] = [tool('read', 'explore', 'completed'),
      { id: 'thought', type: 'thinking', status: 'completed', timestamp: 1 }];
    const next = { ...tool('next', 'explore', 'streaming'), toolName, isParamsStreaming: true };
    const projecting = projectAdjacentFlowGroups([row('round', [...initial, next])]);
    const collecting = projecting.flatMap(getVirtualItemFlowGroups)[0];
    expect(collecting.phase).toBe('collecting');
    expect(collecting.allItems.map(item => item.id)).toEqual(['read']);
    expect(projectAdjacentFlowGroups(projecting)).toEqual(projecting);
    const resolved = projectAdjacentFlowGroups([row('round', [...initial,
      { ...next, isParamsStreaming: false, status: 'running' }])]).flatMap(getVirtualItemFlowGroups)[0];
    expect(resolved.groupId).toBe(collecting.groupId);
    expect(resolved.phase).toBe('settled');
    expect(resolved.allItems.map(item => item.id)).toEqual(['read']);
  });

  it('seals for a known noncollectible card even while its parameters are streaming', () => {
    const group = projectAdjacentFlowGroups([row('round', [tool('read', 'explore', 'completed'),
      { ...tool('write', 'explore', 'streaming'), toolName: 'Write', isParamsStreaming: true }])])
      .flatMap(getVirtualItemFlowGroups)[0];
    expect(group.phase).toBe('settled');
  });

  it.each(['pending', 'queued', 'running', 'streaming', 'preparing'] as const)('includes %s context calls without counting reasoning', status => {
    const groups = projectAdjacentFlowGroups([row('round', [tool('one', 'context', status),
      { id: 'thought', type: 'thinking', timestamp: 1, status: 'completed' }, tool('two', 'context', status)])])
      .flatMap(getVirtualItemFlowGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0].allItems.map(item => item.id)).toEqual(['one', 'thought', 'two']);
    expect(groups[0].phase).toBe('collecting');
  });

  it('retains abnormal Shell status while collapsing the completed group', () => {
    const group = projectAdjacentFlowGroups([row('shell', [tool('shell', 'shell', 'error')], true)])
      .flatMap(getVirtualItemFlowGroups)[0];
    expect(group).toMatchObject({ phase: 'settled', needsAttention: true });
    expect(isFlowGroupExpanded(group)).toBe(false);
    expect(isFlowGroupExpanded(group, new Map([[group.groupId, true]]))).toBe(true);
  });

  it('does not collect a permission request or unknown interface action', () => {
    for (const boundary of [tool('permission', 'explore', 'pending_confirmation'),
      { ...tool('unknown', 'interface', 'running'), toolCall: { id: 'unknown', input: { action: 'click' } } }]) {
      const groups = projectAdjacentFlowGroups([row('one', [tool('one', 'explore', 'completed')]),
        row('boundary', [boundary]), row('two', [tool('two', 'explore', 'completed')])]).flatMap(getVirtualItemFlowGroups);
      expect(groups.map(group => group.phase)).toEqual(['settled', 'collecting']);
      expect(groups.flatMap(group => group.allItems).some(item => item.id === boundary.id)).toBe(false);
    }
  });
});
