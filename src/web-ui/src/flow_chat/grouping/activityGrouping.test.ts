import { describe, expect, it } from 'vitest';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { isInterfaceObservation, isShellActivity, shellActivityStats } from './activityClassification';
import { captureFlowGroupFeedbackSnapshot, collectFlowGroupReceiveFeedback } from './receiveFeedback';
import { flowGroupPolicies } from './policies';
import { projectAdjacentFlowGroups } from './groupProjection';
import { buildFlowItemGroups, getModelRoundFlowGroups } from './roundGroups';

function tool(id: string, name = 'ExecCommand', input: Record<string, unknown> = {},
  status: FlowToolItem['status'] = 'completed'): FlowToolItem {
  return { id, type: 'tool', toolName: name, status, timestamp: 1,
    toolCall: { id, input }, toolResult: { success: true, result: {} } };
}

function model(id: string, items: FlowItem[], turnId = 'turn'): Extract<VirtualItem, { type: 'model-round' }> {
  return { type: 'model-round', turnId, isLastRound: false, isTurnComplete: false,
    data: { id, index: 0, startTime: 1, items, status: 'streaming', isComplete: false, isStreaming: true } };
}

function groups(rows: VirtualItem[]) {
  return rows.flatMap(row => row.type === 'model-round'
    ? getModelRoundFlowGroups(row.data, row.projectedGroups) : []);
}

describe('execution activity grouping', () => {
  it.each(['ExecCommand', 'WriteStdin', 'ExecControl', 'Bash'])('collects %s with exploration without any mode hints', toolName => {
    for (const call of [tool('shell', toolName),
      tool('deferred', 'CallDeferredTool', { tool_name: toolName, args: {} })]) {
      const items = [tool('before', 'Read'), call, tool('after', 'Read')];
      expect(buildFlowItemGroups({ items })).toMatchObject([{ type: 'explore', items }]);
      expect(buildFlowItemGroups({ items: [call], exploreEligibility: () => false }))
        .toMatchObject([{ type: 'explore', items: [call] }]);
    }
  });

  it('collects a continuous Shell run across model rounds and process ids', () => {
    const first = model('first', [tool('command-1', 'ExecCommand', { command: 'pwd', session_id: 'one', cwd: '/a' })]);
    const second = model('second', [tool('poll', 'WriteStdin', { session_id: 'one' }),
      tool('command-2', 'ExecCommand', { command: 'git status', session_id: 'two', cwd: '/b' }, 'running')]);
    const recorded = JSON.stringify([first, second]);
    const rows = projectAdjacentFlowGroups([first, second]);
    const shell = groups(rows);
    expect(shell).toHaveLength(1);
    expect(shell[0]).toMatchObject({ category: 'explore', groupId: 'first:shell:command-1', isGroupStreaming: true });
    expect(shell[0].allItems.map(item => item.id)).toEqual(['command-1', 'poll', 'command-2']);
    expect(shellActivityStats(shell[0].allItems as FlowToolItem[])).toMatchObject({ commands: 2, interactions: 1, running: 1 });
    expect((rows[1] as typeof second).projectedGroups).toEqual([]);
    expect(JSON.stringify([first, second])).toBe(recorded);
  });

  it('keeps adjacent reads and Shell calls in one work segment in either order', () => {
    const inline = buildFlowItemGroups({ items: [tool('read', 'Read'), tool('command'),
      tool('poll', 'WriteStdin'), tool('read-again', 'Read')] });
    expect(inline).toMatchObject([{ type: 'explore', items: [
      { id: 'read' }, { id: 'command' }, { id: 'poll' }, { id: 'read-again' },
    ] }]);

    for (const names of [['Read', 'ExecCommand'], ['ExecCommand', 'Read']]) {
      const first = model('first', [tool('first-call', names[0])]);
      const second = model('second', [tool('second-call', names[1])]);
      const rows = projectAdjacentFlowGroups([first, second]);
      const work = groups(rows);
      expect(work).toHaveLength(1);
      expect(work[0].category).toBe('explore');
      expect(work[0].allItems.map(item => item.id)).toEqual(['first-call', 'second-call']);
      expect(work[0].groupId).toBe(`first:${names[0] === 'Read' ? 'explore' : 'shell'}:first-call`);
      expect(work[0].sourceGroupIds).toContain(`second:${names[1] === 'Read' ? 'explore' : 'shell'}:second-call`);
      expect((rows[1] as typeof second).projectedGroups).toEqual([]);
      const t = ((key: string, values?: { count?: string; summary?: string }) =>
        values?.count ? `${key} ${values.count}` : `${key} ${values?.summary ?? ''}`) as Parameters<typeof flowGroupPolicies.explore.summarize>[1];
      const summary = flowGroupPolicies.explore.summarize(work[0].allItems, t, String);
      expect(summary.summary).toBe('workspaceGroup.summary 2');
      expect(summary.summaryDescription).toMatch(/exploreRegion\.readLabel\s+1/);
      expect(summary.summaryDescription).toContain('shellGroup.commands 1');
    }
    const running = model('round', [tool('command', 'ExecCommand', {}, 'running')]);
    const joined = model('round', [tool('command', 'ExecCommand'), tool('read', 'Read')]);
    const before = groups(projectAdjacentFlowGroups([running]))[0];
    const after = groups(projectAdjacentFlowGroups([joined]))[0];
    expect(after.groupId).toBe(before.groupId);
    expect(after.sourceGroupIds).toContain('round:explore:read');
  });

  it('joins a legacy whole-round exploration row to the next Shell call', () => {
    const legacy: Extract<VirtualItem, { type: 'explore-group' }> = {
      type: 'explore-group', turnId: 'turn', data: {
        groupId: 'legacy', rounds: [], allItems: [tool('read', 'Read')],
        stats: { readCount: 1, searchCount: 0, commandCount: 0 },
        isGroupStreaming: false, isLastGroupInTurn: false, wasCutByCritical: true,
      },
    };
    const shell = model('shell-round', [tool('command')]);
    const rows = projectAdjacentFlowGroups([legacy, shell]);
    expect(rows[0]).toMatchObject({ type: 'explore-group', data: {
      groupId: 'legacy', category: 'explore', allItems: [{ id: 'read' }, { id: 'command' }],
    } });
    expect((rows[1] as typeof shell).projectedGroups).toEqual([]);
  });

  it('counts inputs and process controls separately from new commands without showing failure counts', () => {
    const calls = [tool('command'), tool('input', 'WriteStdin'), tool('control', 'ExecControl'),
      { ...tool('legacy', 'Bash'), status: 'error' as const, toolResult: { success: false, result: {}, error: 'failed' } }];
    expect(calls.every(isShellActivity)).toBe(true);
    expect(shellActivityStats(calls)).toEqual({ commands: 2, interactions: 1, controls: 1, running: 0, failed: 1, stopped: 0, nonZero: 0 });
    expect(buildFlowItemGroups({ items: calls })).toMatchObject([{ type: 'explore', items: calls }]);
    const t = ((key: string, values?: { count?: string; summary?: string }) =>
      values?.count ? `${key} ${values.count}` : `${key} ${values?.summary ?? ''}`) as Parameters<typeof flowGroupPolicies.explore.summarize>[1];
    const summary = flowGroupPolicies.explore.summarize(calls, t, String);
    expect(summary.summary).toBe('workspaceGroup.summary 4');
    expect(summary.summaryDescription).toBe('workspaceGroup.description shellGroup.commands 2 · shellGroup.interactions 1 · shellGroup.controls 1');
    expect(flowGroupPolicies.explore.attributes(calls)['data-group-status']).toBe('failed');
  });

  it('reports nonzero exits and missing process sessions from structured results', () => {
    const nonzero = { ...tool('nonzero'), toolResult: { success: true, result: { exit_code: 1 } } };
    const missing = { ...tool('missing', 'WriteStdin'), toolResult: { success: true,
      result: JSON.stringify({ status: 'session_not_found' }) } };
    expect(shellActivityStats([nonzero, missing])).toMatchObject({ nonZero: 1, failed: 1 });
    expect(flowGroupPolicies.explore.attributes([nonzero])['data-group-status']).toBe('non-zero');
    expect(groups(projectAdjacentFlowGroups([model('round', [nonzero, missing])]))[0].needsAttention).toBe(true);
  });

  it('counts every operation in mixed exploration and execution, including repeated output reads', () => {
    const calls = [tool('read-1', 'Read'), tool('read-2', 'Read'), tool('run'),
      ...Array.from({ length: 4 }, (_, index) => tool(`poll-${index}`, 'WriteStdin'))];
    const t = ((key: string, values?: { count?: string; summary?: string }) =>
      `${key} ${values?.count ?? values?.summary ?? ''}`) as Parameters<typeof flowGroupPolicies.explore.summarize>[1];
    const summary = flowGroupPolicies.explore.summarize(calls, t, String);
    expect(summary.summary).toBe('workspaceGroup.summary 7');
    expect(summary.summaryDescription).toContain('shellGroup.commands 1');
    expect(summary.summaryDescription).toContain('shellGroup.interactions 4');
  });

  it('keeps approvals and meaningful cards as visible Shell boundaries', () => {
    const approval = { ...tool('approval'), status: 'pending_confirmation' as const };
    const approvalFlag = { ...tool('approval-flag', 'ExecCommand', {}, 'running'), requiresConfirmation: true };
    for (const boundary of [approval, approvalFlag,
      tool('write', 'Write'), tool('edit', 'Edit'), tool('delete', 'Delete'),
      tool('agent', 'AgentSpawn'), tool('wait', 'AgentWait'), tool('question', 'AskUserQuestion'),
      tool('code', 'RunCode'), tool('terminal', 'ControlHub', { domain: 'terminal', action: 'kill' }),
    ]) {
      expect(buildFlowItemGroups({ items: [tool('before'), boundary, tool('after')] }).map(group => group.type))
        .toEqual(['explore', 'critical', 'explore']);
    }
    expect(isShellActivity(tool('deferred', 'CallDeferredTool', { tool_name: 'ExecCommand', args: { command: 'pwd' } }))).toBe(true);
    expect(isShellActivity(approval)).toBe(false);
    expect(isShellActivity(approvalFlag)).toBe(false);
    const rows = projectAdjacentFlowGroups([
      model('first', [tool('first')]), model('file', [tool('edit', 'Edit')]), model('last', [tool('last')]),
    ]);
    expect(groups(rows).map(group => group.allItems.map(item => item.id))).toEqual([['first'], ['last']]);
    expect(groups(projectAdjacentFlowGroups([
      model('first', [tool('first')], 'turn-a'), model('second', [tool('second')], 'turn-b'),
    ]))).toHaveLength(2);
  });

  it('folds consecutive interface observations while leaving user-facing actions visible', () => {
    const browser = { ...tool('snapshot', 'ControlHub', { domain: 'browser', action: 'snapshot' }),
      toolResult: { success: true, result: { ok: true } } };
    const desktop = tool('state', 'ComputerUse', { action: 'get_app_state' });
    expect(isInterfaceObservation(browser)).toBe(true);
    expect(isInterfaceObservation(desktop)).toBe(true);
    expect(buildFlowItemGroups({ items: [browser, desktop] })).toMatchObject([{ type: 'interface' }]);
    expect(buildFlowItemGroups({ items: [browser] })).toEqual([{ type: 'critical', item: browser }]);
    for (const item of [
      tool('open', 'ControlHub', { domain: 'browser', action: 'open_builtin' }),
      tool('click', 'ControlHub', { domain: 'browser', action: 'click' }),
      tool('type', 'ComputerUse', { action: 'type_text' }),
      tool('screenshot', 'ComputerUse', { action: 'screenshot' }),
      tool('unknown', 'mcp__server__unknown'),
      { ...browser, id: 'failed', toolResult: { success: false, result: {} } },
    ]) expect(isInterfaceObservation(item)).toBe(false);
  });

  it('does not replay a receive effect for an already grouped running Shell call', () => {
    const running = model('round', [tool('command', 'ExecCommand', {}, 'running')]);
    const before = projectAdjacentFlowGroups([running]);
    const previous = captureFlowGroupFeedbackSnapshot(before, 'session');
    const updated = projectAdjacentFlowGroups([model('round', [{ ...tool('command'), status: 'completed' }])]);
    expect(collectFlowGroupReceiveFeedback(previous, updated, 'session').size).toBe(0);
  });
});
