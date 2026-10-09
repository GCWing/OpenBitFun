import { describe, expect, it } from 'vitest';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { fileEditTarget } from './fileEdits';
import { buildFlowItemGroups, getModelRoundFlowGroups } from './roundGroups';
import { projectAdjacentFlowGroups } from './groupProjection';
import { indexFlowGroups } from './selectors';
import { isFlowGroupExpanded } from './types';

function edit(id: string, filePath = '/workspace/src/App.tsx', extra: Partial<FlowToolItem> = {}): FlowToolItem {
  return { id, type: 'tool', timestamp: 1, status: 'completed', toolName: 'Edit',
    toolCall: { id, input: { file_path: filePath, old_string: 'before', new_string: 'after' } }, ...extra };
}
function row(id: string, items: FlowItem[], turnId = 'turn'): Extract<VirtualItem, { type: 'model-round' }> {
  return { type: 'model-round', turnId, isLastRound: true, isTurnComplete: false,
    data: { id, items, index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false } };
}
function projected(rows: VirtualItem[], complete = true) {
  const output = projectAdjacentFlowGroups(rows, { isTurnComplete: complete });
  return { output, groups: output.flatMap(item => item.type === 'model-round'
    ? getModelRoundFlowGroups(item.data, item.projectedGroups) : []) };
}

describe('consecutive revisions of one file', () => {
  it('keeps one edit native and collects repeated Edit/Write calls without changing recorded data', () => {
    const items = [edit('one'), edit('two', undefined, { toolName: 'Write' })];
    const before = JSON.stringify(items);
    expect(buildFlowItemGroups({ items: items.slice(0, 1) })).toEqual([{ type: 'critical', item: items[0] }]);
    expect(buildFlowItemGroups({ items })).toMatchObject([{ type: 'file-edit', items }]);
    expect(JSON.stringify(items)).toBe(before);
  });

  it('uses the full case-sensitive target, including remote POSIX paths', () => {
    for (const target of ['/workspace/test/App.tsx', '/workspace/src/app.tsx', '/other/src/App.tsx']) {
      expect(buildFlowItemGroups({ items: [edit('one'), edit('two', target)] }).map(group => group.type))
        .toEqual(['critical', 'critical']);
    }
    expect(buildFlowItemGroups({ items: [edit('one', 'C:\\src\\App.tsx'), edit('two', 'C:/src/App.tsx')] }))
      .toMatchObject([{ type: 'file-edit' }]);
    expect(fileEditTarget(edit('posix', '/src/a\\b.ts'))).toBe('/src/a\\b.ts');
  });

  it('projects deferred identity and declines streaming, multi-file, plan and approval records', () => {
    const deferred = edit('wrapped', undefined, { toolName: 'CallDeferredTool',
      toolCall: { id: 'wrapped', input: { tool_name: 'Edit', args: { file_path: '/workspace/src/App.tsx' } } } });
    expect(buildFlowItemGroups({ items: [edit('one'), deferred] })).toMatchObject([{ type: 'file-edit' }]);
    for (const item of [edit('stream', undefined, { isParamsStreaming: true }),
      edit('permission', undefined, { status: 'pending_confirmation' }), edit('plan', '/workspace/task.plan.md'),
      edit('multi', undefined, { toolResult: { success: true, result: { locations: [{ path: '/a' }, { path: '/b' }] } } }),
      edit('delete', undefined, { toolName: 'Delete' })]) expect(fileEditTarget(item)).toBeUndefined();
  });

  it('keeps other operations as boundaries within and across rounds', () => {
    const boundaries: FlowItem[] = [
      edit('read', undefined, { toolName: 'Read' }), edit('other', '/another.ts'),
    ];
    for (const boundary of boundaries) {
      const items = [edit('one'), boundary, edit('two')];
      expect(buildFlowItemGroups({ items }).some(group => group.type === 'file-edit')).toBe(false);
      expect(projected([row('first', [items[0]]), row('boundary', [boundary]), row('last', [items[2]])]).groups
        .some(group => group.category === 'file-edit')).toBe(false);
    }
  });

  it('retains the earliest identity and navigation for cross-round revisions, without crossing turns', () => {
    const input = [row('first', [edit('one')]), row('second', [edit('two')])];
    const before = JSON.stringify(input);
    const { output, groups } = projected(input);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ category: 'file-edit', groupId: 'first:file-edit:one', phase: 'settled' });
    expect(groups[0].sourceGroupIds).toContain('second:file-edit:two');
    expect(indexFlowGroups(output).byMemberId.get('two')?.group.groupId).toBe('first:file-edit:one');
    expect(isFlowGroupExpanded(groups[0], new Map([['second:file-edit:two', true]]))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(projected([input[0], { ...input[1], turnId: 'another-turn' }]).groups).toHaveLength(0);
    expect(projected([input[0], row('other', [edit('two', '/another.ts')])]).groups).toHaveLength(0);
  });

  it('waits for a complete incoming target and exposes errors until explicitly collapsed', () => {
    const run = [edit('one'), edit('two')];
    const collecting = projected([row('first', run), row('incoming', [edit('three', undefined, { status: 'streaming', isParamsStreaming: true })])], false).groups[0];
    expect(collecting.phase).toBe('collecting');
    expect(isFlowGroupExpanded(collecting)).toBe(true);
    const failed = projected([row('first', [run[0], edit('two', undefined, {
      toolResult: { success: false, result: {}, error: 'Could not find replacement' },
    })])]).groups[0];
    expect(failed.needsAttention).toBe(true);
    expect(isFlowGroupExpanded(failed)).toBe(true);
    expect(isFlowGroupExpanded(failed, new Map([[failed.groupId, false]]))).toBe(false);
    const stopped = projected([row('first', [run[0], edit('two', undefined, { status: 'cancelled' })])]).groups[0];
    expect(isFlowGroupExpanded(stopped)).toBe(true);
  });
});
