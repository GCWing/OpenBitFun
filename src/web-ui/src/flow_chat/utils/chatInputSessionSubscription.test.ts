import { describe, expect, it } from 'vitest';

import type { DialogTurn, Session } from '../types/flow-chat';
import { chatInputSessionSubscriptionKey } from './chatInputSessionSubscription';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    dialogTurns: [],
    status: 'idle',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    ...overrides,
  } as Session;
}

describe('chatInputSessionSubscriptionKey', () => {
  it.each<Partial<Session>>([
    { continuationPolicy: 'fresh_only' }, { historyState: 'hydrating' },
    { persistedStatus: 'archived' }, { parentSessionId: 'new-parent' },
    { config: { dispatchTargetRequest: { kind: 'ssh', connectionId: 'host' } } },
    { draft: { workspaceId: 'other', phase: 'editing', turnId: 'first' } },
  ])('invalidates target eligibility when conversation facts change: %j', change => {
    expect(chatInputSessionSubscriptionKey(session(change))).not.toBe(chatInputSessionSubscriptionKey(session()));
  });

  it('invalidates the first-turn lock when projected history counts change', () => {
    expect(chatInputSessionSubscriptionKey(session({ totalTurnCount: 1 }))).not.toBe(
      chatInputSessionSubscriptionKey(session({ totalTurnCount: 0 })),
    );
  });

  it('does not refresh the composer for streamed text or tool progress', () => {
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      status: 'processing',
      startTime: 1,
      userMessage: { id: 'user-1', content: 'finish the task', timestamp: 1 },
      modelRounds: [],
      recovery: { status: 'recovering', executionGeneration: 1 },
    };
    const before = session({ dialogTurns: [turn] });
    const after = session({
      ...before,
      lastActiveAt: 2,
      dialogTurns: [{
        ...turn,
        modelRounds: [{
          id: 'round-1', index: 1, startTime: 2,
          isStreaming: true, isComplete: false, status: 'streaming',
          items: [{
            id: 'text-1', type: 'text', content: 'Working on it',
            timestamp: 2, isStreaming: true,
          }],
        }],
      }],
    });
    expect(chatInputSessionSubscriptionKey(after)).toBe(chatInputSessionSubscriptionKey(before));
  });
});
