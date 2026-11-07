import { describe, expect, it } from 'vitest';
import type { VirtualItem } from '../types/flow-chat-projection';
import { indexFlowGroups } from './selectors';

function group(id: string, aliases: string[] = []): VirtualItem {
  return { type: 'explore-group', turnId: `turn-${id}`, data: {
    groupId: id, sourceGroupIds: aliases, rounds: [], allItems: [],
    isGroupStreaming: false, isLastGroupInTurn: false, wasCutByCritical: true,
    stats: { readCount: 0, searchCount: 0, commandCount: 0 },
  } };
}

describe('flow group ownership index', () => {
  it('restores a prefix alias when a tail that shadowed it is removed or replaced', () => {
    const first = group('first', ['shared']);
    const tail = group('tail', ['shared']);
    const before = indexFlowGroups([first, tail]);
    expect(before.byId.get('shared')?.virtualIndex).toBe(1);
    const shortened = indexFlowGroups([first]);
    expect(shortened.byId.get('shared')?.group.groupId).toBe('first');
    indexFlowGroups([first, tail]);
    const replaced = indexFlowGroups([first, group('replacement')]);
    expect(replaced.byId.get('shared')?.group.groupId).toBe('first');
    expect(replaced.byTurnId.has('turn-tail')).toBe(false);
    expect(before.byId.get('shared')?.group.groupId).toBe('tail');
  });

  it('reuses an unchanged transcript and keeps indexes isolated across equal-id sessions', () => {
    const first = [group('same', ['alias'])];
    const other = [group('same')];
    const before = indexFlowGroups(first);
    expect(indexFlowGroups(first)).toBe(before);
    expect(indexFlowGroups(other).byId.has('alias')).toBe(false);
    expect(indexFlowGroups(first)).toBe(before);
  });
});
