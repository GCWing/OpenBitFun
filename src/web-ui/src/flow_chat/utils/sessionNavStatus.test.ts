import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { DialogTurn, FlowToolItem, Session } from '../types/flow-chat';
import { SessionStateMachineImpl } from '../state-machine/SessionStateMachine';
import { SessionExecutionEvent } from '../state-machine/types';
import { deriveSessionNavStatus } from './sessionNavStatus';

function turn(id: string, state: DialogTurn['status'], tools: FlowToolItem[] = []): DialogTurn {
  return {
    id, sessionId: 'session', status: state, startTime: 1,
    userMessage: { id: `user-${id}`, content: 'Task', timestamp: 1 },
    modelRounds: [{ id: `round-${id}`, index: 0, items: tools, isStreaming: false,
      isComplete: state === 'completed', status: 'running', startTime: 1 }],
  };
}

function session(dialogTurns: DialogTurn[] = [], overrides: Partial<Session> = {}): Session {
  return { sessionId: 'session', title: 'Task', sessionKind: 'normal', dialogTurns,
    status: 'idle', config: { agentType: 'Standard' }, createdAt: 1, lastActiveAt: 1,
    error: null, ...overrides } as Session;
}

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return { requestId: 'request', sessionId: 'session', roundId: 'round-work', order: 0,
    projectId: 'workspace', agentId: 'Standard', action: 'edit', resources: [],
    source: { kind: 'tool_call', identity: 'Write' }, ...overrides };
}

function tool(name: string, state: FlowToolItem['status'] = 'pending_confirmation'): FlowToolItem {
  return { id: 'tool', type: 'tool', toolName: name, status: state, timestamp: 1,
    toolCall: { id: 'call', input: { questions: [{ question: 'Which option?' }] } } };
}

describe('session navigation status', () => {
  it.each([
    ['running', {}, 'running'],
    ['running', { pendingApprovals: 2 }, 'approval'],
    ['running', { pendingQuestions: 1 }, 'input'],
    ['error', { unreadCompletion: 'error' as const }, 'error'],
    ['error', {}, 'idle'],
    ['idle', { unreadCompletion: 'completed' as const }, 'unread'],
    ['queued', {}, 'queued'],
  ] as const)('projects %s before the session is opened', (execution, fields, expected) => {
    expect(deriveSessionNavStatus({ session: session([], { historyState: 'metadata-only' }),
      activity: { sessionId: 'session', execution, pendingApprovals: 0, pendingQuestions: 0, ...fields },
    }).kind).toBe(expected);
  });

  it('corrects a stale running transcript with the host terminal summary', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing')]),
      activity: { sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
        lastTurn: { turnId: 'work', turnIndex: 0, status: 'completed' }, unreadCompletion: 'completed' },
    }).kind).toBe('unread');
  });

  it.each(['completed', 'error', 'cancelled'] as const)('keeps a viewed legacy %s quiet after history hydrates', (outcome) => {
    expect(deriveSessionNavStatus({ session: session([turn('legacy', outcome)], { historyState: 'ready' }),
      activity: { sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0 },
    }).kind).toBe('idle');
  });

  it('does not revive stale execution or approvals when a legacy host is idle', () => {
    expect(deriveSessionNavStatus({ session: session([turn('legacy', 'processing', [tool('Write')])]),
      activity: { sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0 },
    }).kind).toBe('idle');
  });

  it('lets a newer host outcome supersede an older hydrated error', () => {
    expect(deriveSessionNavStatus({ session: session([turn('old', 'error')]),
      activity: { sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
        lastTurn: { turnId: 'new', turnIndex: 1, status: 'completed' } },
    }).kind).toBe('idle');
  });

  it('hides a host-reported error after its unread marker is cleared', () => {
    expect(deriveSessionNavStatus({ session: session([], { historyState: 'metadata-only' }),
      activity: { sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
        lastTurn: { turnId: 'failed', turnIndex: 1, status: 'error' } },
    }).kind).toBe('idle');
  });

  it('does not invent a resumable pause from stale processing after a restart', () => {
    expect(deriveSessionNavStatus({ session: session(), activity: {
      sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
      lastTurn: { turnId: 'work', turnIndex: 0, status: 'inprogress' },
    } }).kind).toBe('idle');
  });

  it('keeps an acknowledged resumable pause visible before opening the session', () => {
    expect(deriveSessionNavStatus({ session: session(), activity: {
      sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
      lastTurn: { turnId: 'work', turnIndex: 0, status: 'cancelled', recoveryPending: true },
    } }).kind).toBe('paused');
  });

  it.each(['completed', 'error', 'cancelled'] as const)('acknowledges a %s result without changing its outcome', (outcome) => {
    const unread = outcome === 'cancelled' ? 'interrupted' : outcome;
    const value = session([turn('work', outcome)], { hasUnreadCompletion: unread });
    expect(deriveSessionNavStatus({ session: value }).kind)
      .toBe(outcome === 'completed' ? 'unread' : outcome === 'cancelled' ? 'stopped' : 'error');
    expect(deriveSessionNavStatus({ session: { ...value, hasUnreadCompletion: undefined } }).kind).toBe('idle');
  });

  it('lets a host-confirmed cancellation replace stale hydrated recovery state', () => {
    const paused = { ...turn('work', 'cancelled'), finishReason: 'interrupted',
      recovery: { status: 'interrupted' as const, executionGeneration: 1, resumeCount: 0 } };
    expect(deriveSessionNavStatus({ session: session([paused]), activity: {
      sessionId: 'session', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
      lastTurn: { turnId: 'work', turnIndex: 0, status: 'cancelled', recoveryPending: false },
    } }).kind).toBe('idle');
  });

  it('keeps an unavailable status explicit', () => {
    expect(deriveSessionNavStatus({ session: session(), unavailable: true }).kind).toBe('syncing');
  });

  it('keeps a delivered approval answerable while activity is unavailable', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing')]), unavailable: true,
      permissions: [permission()] })).toEqual({ kind: 'approval', pendingCount: 1 });
  });
  it('shows execution for ordinary project sessions as well as selected sessions', () => {
    const value = session([turn('work', 'processing')]);
    expect(deriveSessionNavStatus({ session: value }).kind).toBe('running');
    expect(deriveSessionNavStatus({ session: { ...value, status: 'active' } }).kind).toBe('running');
  });

  it('gives mailbox approval priority over execution and counts distinct requests', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing')]),
      permissions: [permission(), permission(), permission({ requestId: 'second' })],
    })).toEqual({ kind: 'approval', pendingCount: 2 });
  });

  it('retains approvals after selection clears the legacy attention marker', () => {
    expect(deriveSessionNavStatus({ session: session([], { status: 'active' }),
      permissions: [permission()] }).kind).toBe('approval');
  });

  it('routes delegated approvals to the parent but rejects another session request', () => {
    const value = session([turn('parent', 'processing')]);
    expect(deriveSessionNavStatus({ session: value, permissions: [permission({ sessionId: 'child',
      delegation: { parentSessionId: 'session', parentDialogTurnId: 'parent',
        parentToolCallId: 'task', subagentType: 'code' } })] }).kind).toBe('approval');
    expect(deriveSessionNavStatus({ session: value,
      permissions: [permission({ sessionId: 'unrelated' })] }).kind).toBe('running');
  });

  it('does not revive an approval owned by a settled turn', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'completed')]),
      permissions: [permission()] }).kind).toBe('idle');
  });

  it('distinguishes questions from legacy tool approvals', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing', [tool('AskUserQuestion')])]) }).kind).toBe('input');
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing', [tool('Write')])]) }).kind).toBe('approval');
  });

  it('reads the executing turn when a follow-up is queued after it', async () => {
    const machine = new SessionStateMachineImpl('session');
    await machine.transition(SessionExecutionEvent.START, { turnId: 'work' });
    const snapshot = machine.getSnapshot();
    snapshot.context.currentDialogTurnId = 'work';
    expect(deriveSessionNavStatus({ session: session([
      turn('work', 'processing', [tool('AskUserQuestion')]), turn('queued', 'pending'),
    ]), machine: snapshot }).kind).toBe('input');
  });

  it('shows a retry instead of an older failure', () => {
    expect(deriveSessionNavStatus({ session: session([turn('old', 'error'), turn('new', 'processing')],
      { hasUnreadCompletion: 'error' }) }).kind).toBe('running');
  });

  it('only marks whole-turn failure as an error', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'processing', [tool('Read', 'error')])]) }).kind).toBe('running');
    expect(deriveSessionNavStatus({ session: session([turn('work', 'error')], { hasUnreadCompletion: 'error' }) }).kind).toBe('error');
  });

  it('does not interpret cancellation or partial recovery as success', () => {
    expect(deriveSessionNavStatus({ session: session([turn('work', 'cancelled')],
      { hasUnreadCompletion: 'completed' }) }).kind).toBe('stopped');
    const recovered = { ...turn('work', 'cancelled'), finishReason: 'interrupted', recovery: { status: 'interrupted' as const,
      executionGeneration: 1, resumeCount: 0 } };
    expect(deriveSessionNavStatus({ session: session([recovered]) }).kind).toBe('paused');
  });

  it('keeps successful completion visible only while unread', () => {
    const value = session([turn('work', 'completed')], { hasUnreadCompletion: 'completed' });
    expect(deriveSessionNavStatus({ session: value }).kind).toBe('unread');
    expect(deriveSessionNavStatus({ session: { ...value, hasUnreadCompletion: undefined } }).kind).toBe('idle');
  });

  it('keeps old metadata readable without guessing completion for unhydrated sessions', () => {
    expect(deriveSessionNavStatus({ session: session() }).kind).toBe('idle');
    expect(deriveSessionNavStatus({ session: session([], { hasUnreadCompletion: 'completed' }) }).kind).toBe('unread');
    expect(deriveSessionNavStatus({ session: session([], { needsUserAttention: 'tool_confirm' }) }).kind).toBe('approval');
  });

  it('uses target dispatch facts and exposes stale transport separately', () => {
    const value = session([], { config: { agentType: 'Standard', dispatchJobState: 'running' } });
    expect(deriveSessionNavStatus({ session: value }).kind).toBe('running');
    expect(deriveSessionNavStatus({ session: value, reachability: 'unreachable' }).kind).toBe('syncing');
    // Approval ranks below an unreachable target: the prompt may be stale and
    // a reply could not be delivered anyway.
    const awaiting = session([turn('work', 'processing', [tool('Bash')])],
      { config: { agentType: 'Standard', dispatchJobState: 'running' } });
    expect(deriveSessionNavStatus({ session: awaiting }).kind).toBe('approval');
    expect(deriveSessionNavStatus({ session: awaiting, reachability: 'unreachable' }).kind).toBe('syncing');
    expect(deriveSessionNavStatus({ session: value, reachability: 'unreachable',
      permissions: [permission({ sessionId: 'session' })] }).kind).toBe('syncing');
    expect(deriveSessionNavStatus({ session: value, reachability: 'reachable',
      permissions: [permission({ sessionId: 'session' })] }).kind).toBe('approval');
    expect(deriveSessionNavStatus({ session: { ...value, hasUnreadCompletion: 'error',
      config: { ...value.config, dispatchJobState: 'failed' } } }).kind).toBe('error');
    expect(deriveSessionNavStatus({ session: { ...value,
      config: { ...value.config, dispatchJobState: 'failed' } } }).kind).toBe('idle');
  });
});
