// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { SessionActivitySummary } from '@/shared/types/session-history';
import type { PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { SessionStateMachineImpl } from '../state-machine/SessionStateMachine';
import { SessionExecutionEvent, SessionExecutionState, type SessionStateMachine } from '../state-machine/types';

const sources = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  events: new Map<string, (event: unknown) => void>(),
  storeListeners: new Set<(state: { sessions: Map<string, Session> }) => void>(),
  read: vi.fn(),
  mailbox: vi.fn().mockResolvedValue(undefined),
  permissions: [] as PermissionRequest[],
  permissionListeners: new Set<() => void>(),
  reachability: new Map<string, 'unknown' | 'reachable' | 'unreachable'>(),
  navigationListeners: new Set<() => void>(),
  machines: new Map<string, SessionStateMachine>(),
  machineListeners: new Set<(sessionId: string, machine: SessionStateMachine) => void>(),
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: Object.fromEntries([
  'onSessionStateChanged', 'onSessionHistoryChanged', 'onSessionDeleted', 'onDialogTurnStarted',
  'onDialogTurnCompleted', 'onDialogTurnFailed', 'onDialogTurnCancelled', 'onDialogTurnInterrupted', 'onDialogTurnRecovered', 'onToolEvent',
].map(name => [name, (callback: (event: unknown) => void) => {
  sources.events.set(name, callback);
  return () => sources.events.delete(name);
}])) }));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { listSessionsPage: sources.read } }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: sources.sessions }),
  subscribe: (listener: (state: { sessions: Map<string, Session> }) => void) => {
    sources.storeListeners.add(listener);
    return () => sources.storeListeners.delete(listener);
  },
  applySessionActivityReceipt: (summary: SessionActivitySummary) => {
    const session = sources.sessions.get(summary.sessionId);
    if (!session || (session.hasUnreadCompletion === summary.unreadCompletion
      && session.unreadCompletionTurnId === summary.lastTurn?.turnId)) return;
    sources.sessions.set(summary.sessionId, { ...session, hasUnreadCompletion: summary.unreadCompletion,
      unreadCompletionTurnId: summary.lastTurn?.turnId });
    for (const listener of sources.storeListeners) listener({ sessions: sources.sessions });
  },
} }));
vi.mock('../state-machine', () => ({ stateMachineManager: {
  getSnapshot: (sessionId: string) => sources.machines.get(sessionId) ?? null,
  subscribeGlobal: (listener: (sessionId: string, machine: SessionStateMachine) => void) => {
    sources.machineListeners.add(listener);
    return () => sources.machineListeners.delete(listener);
  },
} }));
vi.mock('../session-drivers/registry', () => {
  const navigationStatusSource = {
    subscribe: (listener: () => void) => {
      sources.navigationListeners.add(listener);
      return () => sources.navigationListeners.delete(listener);
    },
    getSnapshot: (sessionId: string) => {
      const reachability = sources.reachability.get(sessionId);
      return reachability ? { reachability } : {};
    },
  };
  const driver = { permissionRequestSource: () => 'live', navigationStatusSource };
  return {
    driverForSession: () => driver,
    sessionDriverNavigationStatusSources: () => [navigationStatusSource],
  };
});
vi.mock('./liveSessionInteractionStore', () => ({
  ensureActivePermissionMailbox: sources.mailbox,
  liveSessionInteractionStore: {
    getActiveSnapshot: () => ({ requests: sources.permissions }),
    subscribe: (listener: () => void) => {
      sources.permissionListeners.add(listener);
      return () => sources.permissionListeners.delete(listener);
    },
  },
}));
import { installSessionNavStatusService, sessionNavStatusService } from './sessionNavStatusService';
import { sessionActivityStore } from '../store/sessionActivityStore';

let sequence = 0;
const disposers: Array<() => void> = [];
const row = (sessionId: string, config = {}): Session => ({
  sessionId, title: sessionId, workspaceId: 'workspace-1', workspacePath: '/workspace', dialogTurns: [],
  historyState: 'metadata-only',
  config: { agentType: 'Standard', ...config }, status: 'idle', createdAt: 1, lastActiveAt: 1,
  error: null, isHistorical: true,
} as Session);
const activity = (sessionId: string, execution = 'running'): SessionActivitySummary => ({
  sessionId, execution, pendingApprovals: 0, pendingQuestions: 0,
});
const response = (activities?: SessionActivitySummary[]) => ({
  sessions: [], activities, hasMore: false, totalTopLevelCount: 0, loadedTopLevelCount: 0,
});
beforeEach(() => {
  vi.useFakeTimers();
  sources.read.mockReset();
  sources.sessions.clear();
  sources.permissions = [];
  sources.reachability.clear();
  sources.machines.clear();
  activateSurface(`service-test-${++sequence}`);
});
afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const install = (...ids: string[]) => {
  disposers.push(installSessionNavStatusService());
  for (const id of ids) disposers.push(sessionNavStatusService.subscribe(id, () => {}));
};

describe('navigation status synchronization', () => {
  it('keeps a local submission running across a host read that predates host acceptance', async () => {
    const id = 'local-start-race';
    const pending = { id: 'new-turn', status: 'pending', modelRounds: [] } as unknown as Session['dialogTurns'][number];
    sources.sessions.set(id, { ...row(id), historyState: 'new', dialogTurns: [pending] });
    sources.read.mockResolvedValue(response([activity(id, 'idle')]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    const machine = new SessionStateMachineImpl(id);
    await machine.transition(SessionExecutionEvent.START, { dialogTurnId: pending.id });
    const snapshot = machine.getSnapshot();
    sources.machines.set(id, snapshot);
    sources.machineListeners.forEach(listener => listener(id, snapshot));
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    // The old idle snapshot is accepted as a host fact, but does not cancel a local submission.
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionActivityStore.get(id)?.summary?.execution).toBe('idle');
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    sources.events.get('onDialogTurnStarted')!({ sessionId: id, turnId: pending.id });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    // Host completion wins even if the local transcript has not caught up yet.
    sources.events.get('onDialogTurnCompleted')!({ sessionId: id, turnId: pending.id });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('unread');
  });

  it.each([SessionExecutionState.IDLE, SessionExecutionState.ERROR])(
    'ends local startup protection when the submitting machine enters %s', async state => {
      const id = `submission-ended-${state}`;
      sources.sessions.set(id, { ...row(id), historyState: 'new', dialogTurns: [
        { id: 'new-turn', status: 'pending', modelRounds: [] } as unknown as Session['dialogTurns'][number],
      ] });
      sources.read.mockResolvedValue(response([activity(id, 'idle')]));
      install(id);
      await vi.advanceTimersByTimeAsync(100);
      const machine = new SessionStateMachineImpl(id);
      await machine.transition(SessionExecutionEvent.START, { dialogTurnId: 'new-turn' });
      sources.machines.set(id, machine.getSnapshot());
      sources.machineListeners.forEach(listener => listener(id, sources.machines.get(id)!));
      expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
      sources.machines.set(id, { ...machine.getSnapshot(), currentState: state });
      sources.machineListeners.forEach(listener => listener(id, sources.machines.get(id)!));
      expect(sessionNavStatusService.getSnapshot(id).kind).toBe('idle');
    },
  );

  it('keeps selection stable and promotes background starts even without mounted rows', () => {
    const older = { ...row('older'), createdAt: 10 };
    const newer = { ...row('newer'), createdAt: 20 };
    sources.sessions.set(older.sessionId, older);
    sources.sessions.set(newer.sessionId, newer);
    install();
    const notify = vi.fn();
    disposers.push(sessionNavStatusService.subscribeOrdering(notify));
    sources.sessions.set(older.sessionId, { ...older, status: 'active', lastActiveAt: Date.now() });
    sources.storeListeners.forEach(listener => listener({ sessions: sources.sessions }));
    expect(sessionNavStatusService.getSortTimestamp(older)).toBe(10);
    expect(notify).not.toHaveBeenCalled();
    sources.events.get('onDialogTurnStarted')!({ sessionId: older.sessionId, turnId: 'turn' });
    const startedAt = sessionNavStatusService.getSortTimestamp(older);
    expect(startedAt).toBeGreaterThan(sessionNavStatusService.getSortTimestamp(newer));
    expect(sessionNavStatusService.isRunning(older.sessionId)).toBe(true);
    notify.mockClear();
    sources.events.get('onDialogTurnStarted')!({ sessionId: older.sessionId, turnId: 'turn' });
    sources.events.get('onSessionStateChanged')!({ sessionId: older.sessionId, newState: 'processing' });
    expect(sessionNavStatusService.getSortTimestamp(older)).toBe(startedAt);
    expect(notify).not.toHaveBeenCalled();
    sources.events.get('onDialogTurnCompleted')!({ sessionId: older.sessionId, turnId: 'turn' });
    expect(sessionNavStatusService.getSortTimestamp(older)).toBe(startedAt);
    expect(sessionNavStatusService.isRunning(older.sessionId)).toBe(false);
    expect(sources.read).not.toHaveBeenCalled();
  });

  it('promotes detached jobs through the same queued to running projection', () => {
    const value = row('dispatch-order', { dispatchJobId: 'job', dispatchJobState: 'queued' });
    sources.sessions.set(value.sessionId, value);
    install();
    let startedAt: number | undefined;
    for (const dispatchJobState of ['running', 'completed'] as const) {
      sources.sessions.set(value.sessionId, { ...value, config: { ...value.config, dispatchJobState } });
      sources.storeListeners.forEach(listener => listener({ sessions: sources.sessions }));
      expect(sessionNavStatusService.getSortTimestamp(value)).toBeGreaterThan(value.createdAt);
      startedAt ??= sessionNavStatusService.getSortTimestamp(value);
      expect(sessionNavStatusService.getSortTimestamp(value)).toBe(startedAt);
      expect(sessionNavStatusService.isRunning(value.sessionId)).toBe(dispatchJobState === 'running');
    }
    expect(sources.read).not.toHaveBeenCalled();
  });

  it('retains ordering when rows remount and only promotes again after a blocking interaction resumes', () => {
    const value = row('remount-order', { dispatchJobId: 'job', dispatchJobState: 'running' });
    sources.sessions.set(value.sessionId, value);
    install();
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(value.createdAt);
    const unsubscribe = sessionNavStatusService.subscribe(value.sessionId, () => {});
    unsubscribe();
    disposers.push(sessionNavStatusService.subscribe(value.sessionId, () => {}));
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(value.createdAt);
    sources.permissions = [{ requestId: 'approval', sessionId: value.sessionId, roundId: 'round' } as PermissionRequest];
    sources.permissionListeners.forEach(listener => listener());
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(value.createdAt);
    sources.permissions = [];
    sources.permissionListeners.forEach(listener => listener());
    expect(sessionNavStatusService.getSortTimestamp(value)).toBeGreaterThan(value.createdAt);
  });

  it('retains starts and completions from a background device without reordering the current device', () => {
    const value = row('same-id-on-devices');
    sources.sessions.set(value.sessionId, value);
    activateSurface('ordering-local');
    install();
    activateSurface('ordering-peer');
    activateSurface('ordering-local');
    sessionActivityStore.observe('ordering-peer', 'agentic://dialog-turn-started', {
      sessionId: value.sessionId, turnId: 'remote-turn',
    });
    sessionActivityStore.observe('ordering-peer', 'agentic://dialog-turn-completed', {
      sessionId: value.sessionId, turnId: 'remote-turn',
    });
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(value.createdAt);
    activateSurface('ordering-peer');
    const startedAt = sessionNavStatusService.getSortTimestamp(value);
    expect(startedAt).toBeGreaterThan(value.createdAt);
    activateSurface('ordering-local');
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(value.createdAt);
    activateSurface('ordering-peer');
    expect(sessionNavStatusService.getSortTimestamp(value)).toBe(startedAt);
    expect(sources.read).not.toHaveBeenCalled();
  });

  it('bootstraps all unopened rows in one request and never populates their transcripts', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `initial-${i}`);
    ids.forEach(id => sources.sessions.set(id, row(id)));
    sources.read.mockResolvedValue(response(ids.map(id => activity(id))));
    install(...ids);
    await vi.advanceTimersByTimeAsync(100);
    expect(sources.read).toHaveBeenCalledTimes(1);
    expect(sources.read.mock.calls[0][0].sessionIds).toHaveLength(40);
    expect(sources.events.size).toBe(10);
    for (const id of ids) {
      expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
      expect(sources.sessions.get(id)?.dialogTurns).toHaveLength(0);
    }
  });

  it('receives lifecycle status before any session scene or state machine exists', async () => {
    const id = 'background';
    sources.sessions.set(id, row(id));
    sources.read.mockResolvedValue(response([activity(id, 'idle')]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    sources.events.get('onDialogTurnStarted')!({ sessionId: id, turnId: 'new' });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    sources.events.get('onDialogTurnCompleted')!({ sessionId: id, turnId: 'new' });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('unread');
    expect(sources.sessions.get(id)?.unreadCompletionTurnId).toBe('new');
  });

  it('reconciles only the permission owner and delegated parent when their mailbox changes', async () => {
    const ids = ['approval-owner', 'delegated-parent', 'unaffected'];
    ids.forEach(id => sources.sessions.set(id, row(id)));
    sources.read.mockImplementation(({ sessionIds }: { sessionIds: string[] }) =>
      Promise.resolve(response(sessionIds.map(id => activity(id, 'idle')))));
    install(...ids);
    await vi.advanceTimersByTimeAsync(100);
    sources.permissions = [{ requestId: 'request', sessionId: ids[0], roundId: 'round',
      delegation: { parentSessionId: ids[1], parentDialogTurnId: 'parent-turn' },
    } as PermissionRequest];
    sources.permissionListeners.forEach(listener => listener());
    expect(sessionNavStatusService.getSnapshot(ids[0]).kind).toBe('approval');
    expect(sessionNavStatusService.getSnapshot(ids[1]).kind).toBe('approval');
    await vi.advanceTimersByTimeAsync(100);
    expect(sources.read.mock.calls[1][0].sessionIds).toEqual(ids.slice(0, 2));
  });

  it('drops an old device response and re-reads the current surface', async () => {
    const id = 'same-id';
    sources.sessions.set(id, row(id));
    let finish!: (value: ReturnType<typeof response>) => void;
    sources.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(response([{ ...activity(id, 'error'), unreadCompletion: 'error' }]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    activateSurface('new-device-for-service-test');
    finish(response([activity(id, 'running')]));
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('error');
  });

  it('backs off settled rows and refreshes immediately when the window regains focus', async () => {
    const id = 'settled';
    sources.sessions.set(id, row(id));
    sources.read.mockResolvedValue(response([activity(id, 'idle')]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sources.read).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    expect(sources.read).toHaveBeenCalledTimes(2);
  });

  it('keeps a viewed failure hidden across a wake and delayed host persistence', async () => {
    const id = 'read-error';
    sources.sessions.set(id, row(id));
    const failed: SessionActivitySummary = { ...activity(id, 'error'), unreadCompletion: 'error',
      lastTurn: { turnId: 'failed-turn', turnIndex: 0, status: 'error', recoveryPending: false } };
    sources.read.mockResolvedValue(response([failed]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('error');
    sessionActivityStore.acknowledge(id, 'failed-turn', undefined, false);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('idle');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('idle');
    expect(sources.sessions.get(id)?.hasUnreadCompletion).toBeUndefined();
    expect(sources.sessions.get(id)?.dialogTurns).toHaveLength(0);
  });

  it('retains a viewed pause, then clears a viewed cancellation of that same Turn', async () => {
    const id = 'paused-then-stopped';
    sources.sessions.set(id, row(id));
    sources.read.mockResolvedValue(response([activity(id, 'idle')]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    sources.events.get('onDialogTurnInterrupted')!({ sessionId: id, turnId: 'turn', executionGeneration: 1 });
    sessionActivityStore.acknowledge(id, 'turn', 1, true);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('paused');
    sources.events.get('onDialogTurnCancelled')!({ sessionId: id, turnId: 'turn', executionGeneration: 1 });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('stopped');
    sessionActivityStore.acknowledge(id, 'turn', 1, false);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('idle');
  });

  it('keeps offline rows explicit and recovers on a later wake', async () => {
    const id = 'offline';
    sources.sessions.set(id, row(id));
    sources.read.mockRejectedValueOnce(new Error('Host unavailable')).mockResolvedValue(response([activity(id)]));
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('syncing');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
  });

  it('uses legacy events when the optional summary extension is unavailable', async () => {
    const id = 'legacy';
    sources.sessions.set(id, row(id));
    sources.read.mockResolvedValue(response());
    install(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('syncing');
    sources.events.get('onDialogTurnStarted')!({ sessionId: id, turnId: 'legacy-turn' });
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources.read).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing host summary explicit without spinning requests', async () => {
    const id = 'missing-summary';
    sources.sessions.set(id, row(id));
    sources.read.mockResolvedValue(response([]));
    install(id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('syncing');
    expect(sources.read).toHaveBeenCalledTimes(1);
  });

  it('never queries controller-local persistence for a detached dispatch projection', async () => {
    const id = 'dispatch';
    sources.sessions.set(id, row(id, { dispatchJobId: 'job', dispatchJobState: 'queued' }));
    install(id);
    await vi.advanceTimersByTimeAsync(200);
    expect(sources.read).not.toHaveBeenCalled();
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('queued');
  });

  it('reads detached transport reachability through the session driver source', () => {
    const id = 'offline-dispatch';
    sources.sessions.set(id, row(id, { dispatchJobId: 'job', dispatchJobState: 'running' }));
    install(id);
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('running');
    sources.reachability.set(id, 'unreachable');
    sources.navigationListeners.forEach(listener => listener());
    expect(sessionNavStatusService.getSnapshot(id).kind).toBe('syncing');
  });
});
