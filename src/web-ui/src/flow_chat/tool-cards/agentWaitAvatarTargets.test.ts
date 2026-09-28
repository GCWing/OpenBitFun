import { describe, expect, it } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import { resolveAgentWaitAvatarTargets } from './agentWaitAvatarTargets';

function parentWithTasks(...tasks: FlowToolItem[]): Pick<Session, 'dialogTurns'> {
  return { dialogTurns: [{ modelRounds: [{ items: tasks }] }] as unknown as Session['dialogTurns'] };
}

function backgroundTask(bgTaskId: string, sessionId: string): FlowToolItem {
  return {
    id: bgTaskId, type: 'tool', toolName: 'Task', status: 'completed', timestamp: 1,
    toolCall: { id: bgTaskId, input: { run_in_background: true } },
    toolResult: { success: true, result: { bg_task_id: bgTaskId } },
    subagentSessionId: sessionId,
  };
}

describe('resolveAgentWaitAvatarSessionIds', () => {
  it('matches exact background IDs, keeps wait order and deduplicates the same subagent', () => {
    const parent = parentWithTasks(
      backgroundTask('a1_bg1', 'child-a'),
      backgroundTask('a1_bg2', 'child-a'),
      backgroundTask('a2_bg1', 'child-b'),
      backgroundTask('other_bg1', 'unrelated'),
    );
    expect(resolveAgentWaitAvatarTargets(
      { bg_task_ids: ['a2_bg1', 'a1_bg1', 'a1_bg2'] }, undefined, parent,
    )).toEqual([
      { id: 'a2_bg1', sessionId: 'child-b', parentToolCallId: 'a2_bg1' },
      { id: 'a1_bg1', sessionId: 'child-a', parentToolCallId: 'a1_bg1' },
    ]);
  });

  it('preserves unresolved result targets without inventing child sessions', () => {
    const parent = parentWithTasks(backgroundTask('a1_bg1', 'child-a'));
    expect(resolveAgentWaitAvatarTargets({}, {
      pending_bg_task_ids: ['a1_bg1'], results: [{ bg_task_id: 'unknown_bg1' }],
    }, parent)).toEqual([
      { id: 'a1_bg1', sessionId: 'child-a', parentToolCallId: 'a1_bg1' },
      { id: 'unknown_bg1' },
    ]);
    expect(resolveAgentWaitAvatarTargets({ bg_task_ids: ['unknown_bg1'] }, undefined, parent))
      .toEqual([{ id: 'unknown_bg1' }]);
  });

  it('resolves serialized history payloads to the recorded subagent identity', () => {
    const task = backgroundTask('a1_bg1', 'child-a');
    task.subagentSessionId = undefined;
    task.toolResult = { success: true, result: JSON.stringify({ bg_task_id: 'a1_bg1', session_id: 'child-a' }) };
    expect(resolveAgentWaitAvatarTargets(JSON.stringify({ bg_task_ids: ['a1_bg1'] }), undefined, parentWithTasks(task)))
      .toEqual([{ id: 'a1_bg1', sessionId: 'child-a', parentToolCallId: 'a1_bg1' }]);
  });

  it('links alias-only AgentSpawn and later AgentSendInput runs through the child session relationship', () => {
    const spawn = backgroundTask('a1_bg1', '');
    spawn.toolName = 'AgentSpawn';
    spawn.toolResult = { success: true, result: { agent_id: 'worker', bg_task_id: 'a1_bg1' } };
    const send = { ...spawn, id: 'send', toolName: 'AgentSendInput',
      toolCall: { id: 'send', input: { agent_id: 'worker' } },
      toolResult: { success: true, result: { agent_id: 'worker', bg_task_id: 'a1_bg2' } },
    };
    const parent = parentWithTasks(spawn, send);
    const child = { sessionId: 'child-a', sessionKind: 'subagent', parentSessionId: 'parent',
      parentToolCallId: 'a1_bg1', dialogTurns: [] } as unknown as Session;
    const context = { sessions: new Map([['child-a', child]]), parentSessionId: 'parent' };
    expect(resolveAgentWaitAvatarTargets({ bg_task_ids: ['a1_bg1', 'a1_bg2'] }, undefined, parent, context))
      .toEqual([{ id: 'a1_bg1', sessionId: 'child-a', parentToolCallId: 'a1_bg1' }]);
    expect(resolveAgentWaitAvatarTargets({ bg_task_ids: ['a1_bg1'] }, undefined, parent,
      { ...context, parentSessionId: 'unrelated-parent' })).toEqual([
      { id: 'a1_bg1', parentToolCallId: 'a1_bg1' },
    ]);
  });

  it('retains a cancelled background Task that never recorded a child session', () => {
    const task = backgroundTask('bg-probe_bg1', '');
    task.toolCall.input = { action: 'spawn', agent_id: 'bg-probe', run_in_background: true };
    task.toolResult = { success: true, result: {
      agent_id: 'bg-probe', bg_task_id: 'bg-probe_bg1', run_in_background: true, status: 'started',
    } };
    const result = { status: 'completed', pending_bg_task_ids: [], results: [{
      agent_id: 'bg-probe', bg_task_id: 'bg-probe_bg1', outcome: 'cancelled',
      error: 'Cancelled: Subagent task has been cancelled', content: null,
    }] };
    const context = { sessions: new Map(), parentSessionId: 'parent' };
    const [target] = resolveAgentWaitAvatarTargets({ bg_task_ids: ['bg-probe_bg1'] }, result, parentWithTasks(task), context);
    expect(target).toEqual({ id: 'bg-probe_bg1', parentToolCallId: 'bg-probe_bg1' });
    expect(resolveAgentWaitAvatarTargets({}, result, undefined, context))
      .toEqual([{ id: 'bg-probe_bg1' }]);
  });

  it('keeps the run key when the actual child relationship hydrates', () => {
    const spawn = backgroundTask('a1_bg1', '');
    spawn.toolName = 'AgentSpawn';
    spawn.toolResult = { success: true, result: { agent_id: 'worker', bg_task_id: 'a1_bg1' } };
    const parent = parentWithTasks(spawn);
    const context = { sessions: new Map<string, Session>(), parentSessionId: 'parent' };
    const [pending] = resolveAgentWaitAvatarTargets({ bg_task_ids: ['a1_bg1'] }, undefined, parent, context);
    context.sessions.set('child-a', { sessionId: 'child-a', sessionKind: 'subagent', parentSessionId: 'parent',
      parentToolCallId: 'a1_bg1', dialogTurns: [] } as unknown as Session);
    const [ready] = resolveAgentWaitAvatarTargets({ bg_task_ids: ['a1_bg1'] }, undefined, parent, context);
    expect(pending.sessionId).toBeUndefined();
    expect(ready.id).toBe(pending.id);
    expect(ready.sessionId).toBe('child-a');
  });
});
