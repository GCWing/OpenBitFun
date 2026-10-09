import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';

const syncMocks = vi.hoisted(() => {
  const flowState = {
    sessions: new Map<string, Session>(),
    activeSessionId: null as string | null,
  };
  const listeners = new Set<(state: typeof flowState) => void>();
  const modernState = {
    activeSession: null as Session | null,
    virtualItems: [] as unknown[],
    visibleTurnInfo: null as unknown,
    setActiveSession: vi.fn((session: Session | null) => {
      modernState.activeSession = session;
    }),
    clear: vi.fn(() => {
      modernState.activeSession = null;
      modernState.virtualItems = [];
      modernState.visibleTurnInfo = null;
    }),
  };

  return {
    flowState,
    listeners,
    modernState,
  };
});

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => syncMocks.flowState,
    subscribe: vi.fn((listener: (state: typeof syncMocks.flowState) => void) => {
      syncMocks.listeners.add(listener);
      return () => {
        syncMocks.listeners.delete(listener);
      };
    }),
  },
}));

vi.mock('../store/modernFlowChatStore', () => ({
  useModernFlowChatStore: {
    getState: () => syncMocks.modernState,
  },
}));

import { startAutoSync, syncSessionToModernStore } from './storeSync';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'history-1',
    title: 'Saved session',
    dialogTurns: [],
    status: 'idle',
    config: { agentType: 'Standard' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    isHistorical: true,
    historyState: 'metadata-only',
    todos: [],
    mode: 'Standard',
    workspacePath: 'D:/workspace/OpenBitFun',
    sessionKind: 'normal',
    ...overrides,
  };
}

describe('storeSync history session state', () => {
  afterEach(() => {
    syncMocks.flowState.sessions = new Map();
    syncMocks.flowState.activeSessionId = null;
    syncMocks.listeners.clear();
    syncMocks.modernState.activeSession = null;
    syncMocks.modernState.virtualItems = [];
    syncMocks.modernState.visibleTurnInfo = null;
    syncMocks.modernState.setActiveSession.mockClear();
    syncMocks.modernState.clear.mockClear();
  });

  it('preserves historyState when syncing historical sessions to the modern store', () => {
    const session = createSession();
    syncMocks.flowState.sessions = new Map([[session.sessionId, session]]);
    syncMocks.flowState.activeSessionId = session.sessionId;

    syncSessionToModernStore(session.sessionId);

    expect(syncMocks.modernState.setActiveSession).toHaveBeenCalledWith(session);
    expect(syncMocks.modernState.activeSession).toBe(session);
    expect(syncMocks.modernState.activeSession?.historyState).toBe('metadata-only');
  });

  it('repairs a ready active session when the modern item projection is empty', () => {
    const session = createSession({
      isHistorical: false,
      historyState: 'ready',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'history-1',
        userMessage: {
          id: 'user-1',
          content: 'Loaded history',
          timestamp: 1,
        },
        modelRounds: [],
        status: 'completed',
        startTime: 1,
      }],
    });
    syncMocks.flowState.sessions = new Map([[session.sessionId, session]]);
    syncMocks.flowState.activeSessionId = session.sessionId;
    syncMocks.modernState.activeSession = session;
    syncMocks.modernState.virtualItems = [];

    syncSessionToModernStore(session.sessionId);

    expect(syncMocks.modernState.setActiveSession).toHaveBeenCalledWith(session);
  });

  it('repairs an empty projection when auto sync starts on a ready active session', () => {
    const session = createSession({
      isHistorical: false,
      historyState: 'ready',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'history-1',
        userMessage: {
          id: 'user-1',
          content: 'Loaded history',
          timestamp: 1,
        },
        modelRounds: [],
        status: 'completed',
        startTime: 1,
      }],
    });
    syncMocks.flowState.sessions = new Map([[session.sessionId, session]]);
    syncMocks.flowState.activeSessionId = session.sessionId;
    syncMocks.modernState.activeSession = session;
    syncMocks.modernState.virtualItems = [];

    const unsubscribe = startAutoSync();
    unsubscribe();

    expect(syncMocks.modernState.setActiveSession).toHaveBeenCalledWith(session);
  });

  it.each([null, 'missing-session'])('clears stale presentation on initial sync with selection %s', activeSessionId => {
    syncMocks.flowState.activeSessionId = activeSessionId;
    syncMocks.modernState.activeSession = createSession();
    syncMocks.modernState.virtualItems = [{}];
    syncMocks.modernState.visibleTurnInfo = { turnId: 'old-turn' };

    const unsubscribe = startAutoSync();
    unsubscribe();

    expect(syncMocks.modernState).toMatchObject({
      activeSession: null, virtualItems: [], visibleTurnInfo: null,
    });
  });

  it('clears a selected record that disappears without a selection update', () => {
    const session = createSession();
    syncMocks.flowState.sessions.set(session.sessionId, session);
    syncMocks.flowState.activeSessionId = session.sessionId;
    const unsubscribe = startAutoSync();

    syncMocks.flowState.sessions.clear();
    syncMocks.listeners.forEach(listener => listener(syncMocks.flowState));
    unsubscribe();

    expect(syncMocks.modernState.activeSession).toBeNull();
  });

  it('does not turn an explicit presentation sync into a stale selection change', () => {
    const current = createSession({ sessionId: 'current' });
    const stale = createSession({ sessionId: 'stale' });
    syncMocks.flowState.sessions = new Map([[current.sessionId, current], [stale.sessionId, stale]]);
    syncMocks.flowState.activeSessionId = current.sessionId;
    syncMocks.modernState.activeSession = current;

    syncSessionToModernStore(stale.sessionId);

    expect(syncMocks.modernState.activeSession).toBe(current);
    expect(syncMocks.modernState.setActiveSession).not.toHaveBeenCalled();
  });

  it('projects a draft directory change before any message or canonical workspace change', () => {
    const session = createSession({
      isHistorical: false, historyState: 'new', workspaceId: 'original',
      draft: { workspaceId: 'original', phase: 'editing', turnId: 'first' },
    });
    syncMocks.flowState.sessions.set(session.sessionId, session);
    syncMocks.flowState.activeSessionId = session.sessionId;
    const stop = startAutoSync();
    const selected = { ...session, draft: { ...session.draft!, workspaceId: 'destination' } };
    syncMocks.flowState.sessions.set(session.sessionId, selected);
    syncMocks.listeners.forEach(listener => listener(syncMocks.flowState));
    stop();

    expect(syncMocks.modernState.activeSession).toBe(selected);
    expect(syncMocks.modernState.activeSession?.draft?.workspaceId).toBe('destination');
    expect(syncMocks.modernState.activeSession?.workspaceId).toBe('original');
    expect(syncMocks.flowState.activeSessionId).toBe(session.sessionId);
    expect(syncMocks.modernState.setActiveSession).toHaveBeenCalledTimes(2);
  });

  it('shares a subscription until the final host leaves and avoids duplicate projection work', () => {
    const session = createSession();
    syncMocks.flowState.sessions.set(session.sessionId, session);
    syncMocks.flowState.activeSessionId = session.sessionId;
    const stopShell = startAutoSync();
    const stopChat = startAutoSync();
    expect(syncMocks.listeners.size).toBe(1);
    expect(syncMocks.modernState.setActiveSession).toHaveBeenCalledTimes(1);

    stopChat();
    stopChat();
    syncMocks.flowState.activeSessionId = null;
    syncMocks.listeners.forEach(listener => listener(syncMocks.flowState));
    expect(syncMocks.modernState.activeSession).toBeNull();
    stopShell();
    expect(syncMocks.listeners.size).toBe(0);
  });
});
