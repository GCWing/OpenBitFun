// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useExploreGroupState } from './useExploreGroupState';
import { toolCapsuleStateKey } from '../../tool-cards/toolCapsuleModel';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowToolItem } from '../../types/flow-chat';
import { getModelRoundExploreGroups, isExploreGroupExpanded } from './modelRoundItemGrouping';
import { resolveFlowChatFocusTarget } from './flowChatFocusTarget';

it('retains open capsule state when rounds regroup, and clears it only on explicit collection', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  let state!: ReturnType<typeof useExploreGroupState>;
  function Harness({ items }: { items: VirtualItem[] }) {
    state = useExploreGroupState(items, undefined, 'session');
    return null;
  }
  const key = toolCapsuleStateKey('session', 'turn', 'read');
  try {
    act(() => root.render(<Harness items={[]} />));
    act(() => state.onToolCapsuleExpandedChange(key, true));
    expect(state.expandedToolCapsules.has(key)).toBe(true);
    const group = { type: 'explore-group', turnId: 'turn', data: { groupId: 'group', allItems: [{ id: 'read' }] } } as VirtualItem;
    act(() => root.render(<Harness items={[group]} />));
    expect(state.expandedToolCapsules.has(key)).toBe(true);
    act(() => state.onExpandGroup('group'));
    act(() => state.onToolCapsuleExpandedChange(key, false));
    expect(state.exploreGroupStates.get('group')).toBe(true);
    act(() => state.onToolCapsuleExpandedChange(key, true));
    act(() => state.onCollapseGroup('group'));
    expect(state.expandedToolCapsules.has(key)).toBe(false);
    expect(state.exploreGroupStates.get('group')).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

it('retains any merged source expansion and explicitly closes all source states and member details', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  const key = toolCapsuleStateKey('session', 'turn', 'read');
  const data = { groupId: 'owner', sourceGroupIds: ['owner', 'previous-inline', 'previous-round'], allItems: [{ id: 'read' }] };
  const item = { type: 'explore-group', turnId: 'turn', data } as VirtualItem;
  let state!: ReturnType<typeof useExploreGroupState>;
  function Harness() {
    state = useExploreGroupState([item], new Map([['previous-round', true]]), 'session', new Set([key]));
    return null;
  }
  try {
    act(() => root.render(<Harness />));
    expect(isExploreGroupExpanded((item as Extract<VirtualItem, { type: 'explore-group' }>).data, state.exploreGroupStates)).toBe(true);
    act(() => state.onCollapseGroup('owner'));
    expect([...state.exploreGroupStates.values()]).toEqual([false, false, false]);
    expect(state.expandedToolCapsules.has(key)).toBe(false);
    act(() => state.onExpandGroup('previous-inline'));
    expect(isExploreGroupExpanded((item as Extract<VirtualItem, { type: 'explore-group' }>).data, state.exploreGroupStates)).toBe(true);
    act(() => state.onExploreGroupToggle('owner'));
    expect([...state.exploreGroupStates.values()]).toEqual([false, false, false]);
  } finally {
    act(() => root.unmount());
  }
});

it('expands and collects mixed-round groups using the same identities as item navigation', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const search: FlowToolItem = {
    id: 'search', type: 'tool', toolName: 'Grep', status: 'completed', timestamp: 1,
    toolCall: { id: 'search', input: { pattern: 'needle' } }, toolResult: { success: true, result: 'match' },
  };
  const item: Extract<VirtualItem, { type: 'model-round' }> = {
    type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: true,
    data: {
      id: 'mixed-round', index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false,
      items: [{ id: 'intro', type: 'text', content: 'Searching', isStreaming: false, status: 'completed', timestamp: 1 }, search],
    },
  };
  const groupId = getModelRoundExploreGroups(item.data)[0].groupId;
  const key = toolCapsuleStateKey('session', 'turn', 'search');
  const otherKey = toolCapsuleStateKey('session', 'other-turn', 'other');
  let state!: ReturnType<typeof useExploreGroupState>;
  function Harness() {
    state = useExploreGroupState([item], undefined, 'session', new Set([key, otherKey]));
    return null;
  }
  try {
    act(() => root.render(<Harness />));
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'search' }, [item])).toMatchObject({
      resolvedVirtualIndex: 0, resolvedTurnId: 'turn', expandExploreGroupId: groupId,
    });
    expect(resolveFlowChatFocusTarget({ sessionId: 'session', itemId: 'intro' }, [item]).expandExploreGroupId).toBeUndefined();
    act(() => state.onExpandAllInTurn('turn'));
    expect(state.exploreGroupStates.get(groupId)).toBe(true);
    act(() => state.onCollapseGroup(groupId));
    expect(state.exploreGroupStates.get(groupId)).toBe(false);
    expect(state.expandedToolCapsules.has(key)).toBe(false);
    expect(state.expandedToolCapsules.has(otherKey)).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});
