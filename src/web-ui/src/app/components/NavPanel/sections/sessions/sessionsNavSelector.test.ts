import { describe, expect, it } from 'vitest';
import type { FlowChatState, Session } from '../../../../../flow_chat/types/flow-chat';
import { createSessionsNavSelector } from './sessionsNavSelector';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    dialogTurns: [],
    status: 'idle',
    config: {},
    sessionKind: 'normal',
    ...overrides,
  } as Session;
}

function state(sessions: Session[], activeSessionId: string | null = null): FlowChatState {
  return { sessions: new Map(sessions.map(item => [item.sessionId, item])), activeSessionId } as FlowChatState;
}

describe('createSessionsNavSelector', () => {
  it('notifies navigation when metadata supplies an imported source label', () => {
    const select = createSessionsNavSelector();
    const value = session();
    expect(select(state([value]))).toBe(1);
    expect(select(state([{ ...value, importedSource: 'codex' }]))).toBe(2);
  });
  it('reuses the revision when only non-navigation session data changes', () => {
    const select = createSessionsNavSelector();
    const first = session();

    expect(select(state([first]))).toBe(1);
    expect(select(state([{ ...first, dialogTurns: [{ id: 'turn-1' }] as Session['dialogTurns'] }]))).toBe(1);
  });

  it('increments for navigation fields and session ordering changes', () => {
    const select = createSessionsNavSelector();
    const first = session();
    const second = session({ sessionId: 'session-2' });

    expect(select(state([first, second]))).toBe(1);
    expect(select(state([{ ...first, title: 'Renamed' }, second]))).toBe(2);
    expect(select(state([{ ...first, title: 'Renamed', needsUserAttention: 'ask_user' }, second]))).toBe(3);
    expect(select(state([second, { ...first, title: 'Renamed', needsUserAttention: 'ask_user' }]))).toBe(4);
  });
});
