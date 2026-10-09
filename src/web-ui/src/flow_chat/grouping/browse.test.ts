import { describe, expect, it } from 'vitest';
import type { FlowItem, FlowTextItem, FlowToolItem } from '../types/flow-chat';
import { filterFlowGroupItems, flowGroupToolCounts, type FlowGroupBrowseFilter } from './browse';
import { flowGroupPolicies } from './policies';

function tool(id: string, toolName = 'Read', input: Record<string, unknown> = {}): FlowToolItem {
  return { id, type: 'tool', toolName, status: 'completed', timestamp: 1,
    toolCall: { id, input }, toolResult: { success: true, result: {} } };
}
const labels = new Map([['Read', 'Read file'], ['ExecCommand', 'Execute command']]);
function filter(items: FlowItem[], changes: Partial<FlowGroupBrowseFilter> = {}, pending?: ReadonlySet<string>) {
  return filterFlowGroupItems(items, { tool: 'all', status: 'all', query: '', ...changes }, labels, pending);
}

describe('group browsing', () => {
  it('counts effective tools, including repeated calls, without counting prose', () => {
    expect(flowGroupToolCounts([tool('a'), tool('b', 'CallDeferredTool', { tool_name: 'Read', args: {} }),
      tool('c', 'Grep'), { id: 'text', type: 'text', content: 'Hello' } as FlowTextItem]))
      .toEqual([{ name: 'Read', count: 2 }, { name: 'Grep', count: 1 }]);
  });

  it('searches literal text in effective arguments, names, labels, outputs and companions', () => {
    const output = tool('result', 'ExecCommand');
    output.toolResult = { success: true, result: { rows: ['Needle output'] } };
    const deferred = tool('args', 'CallDeferredTool', { tool_name: 'Read', args: { path: 'src/[app]+.ts' } });
    const thought = { id: 'thinking', type: 'thinking', status: 'completed', content: 'Needle reasoning' } as FlowItem;
    const items = [deferred, output, thought];
    expect([...filter(items, { query: '[app]+' }).visibleIds]).toEqual(['args']);
    expect([...filter(items, { query: 'NEEDLE' }).visibleIds]).toEqual(['result', 'thinking']);
    expect([...filter(items, { query: 'read FILE' }).visibleIds]).toEqual(['args']);
    expect([...filter(items, { query: 'execcommand' }).visibleIds]).toEqual(['result']);
    expect([...filter(items, { query: 'needle' }).matchingThinkingIds]).toEqual(['thinking']);
    expect(filter(items).matchingThinkingIds.size).toBe(0);
    expect(filter(items, { query: '  ' }).filtering).toBe(false);
  });

  it('combines tool, status and text filters and pins approvals excluded by the query', () => {
    const active = { ...tool('active', 'CallDeferredTool', { tool_name: 'Read', args: { path: 'active.ts' } }), status: 'running' as const };
    const approval = { ...tool('permission', 'ExecCommand'), status: 'pending_confirmation' as const };
    const lateApproval = tool('late', 'ExecCommand');
    const items = [active, tool('done', 'Read', { path: 'active.ts' }), approval, lateApproval];
    const result = filter(items, { tool: 'Read', status: 'active', query: '.ts' }, new Set(['late']));
    expect([...result.visibleIds]).toEqual(['active', 'permission', 'late']);
    expect(result.matchingCount).toBe(1);
    expect(result.pinnedCount).toBe(2);
    expect(filter(items, { tool: 'Grep', query: 'missing' }).matchingCount).toBe(0);
  });

  it('includes failed, interrupted and nonzero Shell results in needs-attention', () => {
    const nonzero = { ...tool('nonzero', 'ExecCommand'), toolResult: { success: true, result: { exit_code: 1 } } };
    const stopped = { ...tool('stopped', 'ExecControl'), toolResult: { success: true, result: { completion: { status: 'killed' } } } };
    const missing = { ...tool('missing', 'WriteStdin'), toolResult: { success: true, result: '{"status":"session_not_found"}' } };
    const error = { ...tool('error'), status: 'error' as const };
    expect([...filter([tool('okay'), nonzero, stopped, missing, error], { status: 'attention' }).visibleIds])
      .toEqual(['nonzero', 'stopped', 'missing', 'error']);
  });

  it('does not stringify results or recursively loop over cyclic source data', () => {
    const result: Record<string, unknown> = { text: 'found' };
    result.self = result;
    result.toJSON = () => { throw new Error('Do not stringify'); };
    const item = { ...tool('cycle'), toolResult: { success: true, result } };
    expect(filter([item], { query: 'found' }).matchingCount).toBe(1);
    expect(filter([item], { query: 'missing' }).matchingCount).toBe(0);
  });
});

describe('concise collection summaries', () => {
  const t = ((key: string, values?: { count?: string; summary?: string }) =>
    `${key}${values?.count ? ` ${values.count}` : values?.summary ? ` ${values.summary}` : ''}`) as Parameters<typeof flowGroupPolicies.explore.summarize>[1];
  it('uses one exploration and execution summary for pure and mixed work', () => {
    const items = [tool('run', 'ExecCommand'), tool('poll', 'WriteStdin'), tool('stop', 'ExecControl')];
    expect(flowGroupPolicies.explore.summarize(items, t, String).summary).toBe('workspaceGroup.summary 3');
    expect(flowGroupPolicies.explore.summarize([tool('read')], t, String).summary).toBe('workspaceGroup.summary 1');
    expect(flowGroupPolicies.explore.summarize([tool('read'), ...items], t, String).summary).toBe('workspaceGroup.summary 4');
    expect(flowGroupPolicies.explore.summarize(items.slice(1), t, String).summary).toBe('workspaceGroup.summary 2');
    expect(flowGroupPolicies.explore.summarize([items[1]], t, String).summary).toBe('workspaceGroup.summary 1');
    expect(flowGroupPolicies.explore.summarize([items[2]], t, String).summary).toBe('workspaceGroup.summary 1');
    expect(flowGroupPolicies.explore.summarize([tool('read'), items[1]], t, String).summary).toBe('workspaceGroup.summary 2');
  });
  it('counts tool operations rather than thought/prose without appending status counts', () => {
    const thought = { id: 'thought', type: 'thinking', status: 'completed' } as FlowItem;
    for (const [category, key] of [['context', 'contextLoadGroup.summary'], ['interface', 'interfaceGroup.summary'],
      ['explore', 'workspaceGroup.summary']] as const) {
      expect(flowGroupPolicies[category].summarize([thought, tool('a'), tool('b')], t, String).summary).toBe(`${key} 2`);
    }
    expect(flowGroupPolicies.explore.summarize([{ ...tool('stopped', 'ExecCommand'), status: 'cancelled' }], t, String).summary)
      .toBe('workspaceGroup.summary 1');
  });
});
