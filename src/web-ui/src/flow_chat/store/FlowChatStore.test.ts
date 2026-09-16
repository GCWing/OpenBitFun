import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flowChatStore, mergeModelRoundAttemptDiagnostics } from './FlowChatStore';
import { sessionToVirtualItems } from './modernFlowChatStore';
import { buildModelRoundItemGroups } from '../components/modern/modelRoundItemGrouping';
import { sessionActivityStore } from './sessionActivityStore';
import {
  LOCAL_SURFACE_ID,
  SurfaceChangedError,
  activateSurface,
  isSurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatState, Session } from '../types/flow-chat';
import { startupTrace } from '@/shared/utils/startupTrace';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { resetLiveSessionInteractionStoreForTest } from '../services/liveSessionInteractionStore';
import {
  askUserQuestionDraftKey,
  askUserQuestionDraftStore,
} from './askUserQuestionDraftStore';

const apiMocks = vi.hoisted(() => ({
  getSessionInteractionMailbox: vi.fn(async (sessionId: string) => ({sessionId, userQuestions:{revision:0,questions:[]}, permissions:{revision:0,requests:[]}})),
  subscribeRelaySession: vi.fn(),
  relayRecord: null as ((value: any) => void) | null,
  relayReady: null as ((value: any) => void) | null,
  listSessions: vi.fn(),
  listSessionsPage: vi.fn(),
  loadSessionTurns: vi.fn(),
  saveSessionTurn: vi.fn(),
  deleteSession: vi.fn(),
  restoreSession: vi.fn(),
  restoreSessionView: vi.fn(),
  restoreSessionWithTurns: vi.fn(),
  loadSessionTurnWindow: vi.fn(),
  cancelSession: vi.fn(),
  cancelDispatchJob: vi.fn(),
  onPermissionRequestEvent: vi.fn(() => () => {}),
  subscribePermissionRequests: vi.fn(async () => undefined),
  listPendingPermissionRequests: vi.fn(async () => []),
}));

const peerModeFlagMock = vi.hoisted(() => ({ active: false }));

const configManagerMock = vi.hoisted(() => {
  const getConfig = vi.fn(async (path: string) => {
    if (path === 'ai.models') return [];
    if (path === 'ai.default_models') return {};
    return undefined;
  });
  return {
    getConfig,
    getConfigs: vi.fn(async (paths: string[]) => {
      const configs: Record<string, unknown> = {};
      for (const path of paths) {
        configs[path] = await getConfig(path);
      }
      return configs;
    }),
  };
});

const stateMachineManagerMock = vi.hoisted(() => ({
  delete: vi.fn(),
  getOrCreate: vi.fn(),
  reset: vi.fn(),
  transition: vi.fn(async () => true),
}));

vi.mock('@/infrastructure/api', () => ({
  sessionAPI: {
    listSessions: apiMocks.listSessions,
    listSessionsPage: apiMocks.listSessionsPage,
    loadSessionTurns: apiMocks.loadSessionTurns,
    saveSessionTurn: apiMocks.saveSessionTurn,
  },
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: {
    listSessions: apiMocks.listSessions,
    listSessionsPage: apiMocks.listSessionsPage,
    loadSessionTurns: apiMocks.loadSessionTurns,
    saveSessionTurn: apiMocks.saveSessionTurn,
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    getSessionInteractionMailbox: apiMocks.getSessionInteractionMailbox,
    cancelSession: apiMocks.cancelSession,
    deleteSession: apiMocks.deleteSession,
    restoreSession: apiMocks.restoreSession,
    get restoreSessionView() {
      return apiMocks.restoreSessionView;
    },
    restoreSessionWithTurns: apiMocks.restoreSessionWithTurns,
    loadSessionTurnWindow: apiMocks.loadSessionTurnWindow,
    onPermissionRequestEvent: apiMocks.onPermissionRequestEvent,
    subscribePermissionRequests: apiMocks.subscribePermissionRequests,
    listPendingPermissionRequests: apiMocks.listPendingPermissionRequests,
  },
}));

vi.mock('@/features/dispatch/dispatchApi', () => ({
  dispatchApi: {
    cancel: apiMocks.cancelDispatchJob,
  },
}));

vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({
  remoteConnectAPI: {
    onSessionInteractionChanged: () => () => {},
  onSessionRecord: (listener: (value: any) => void) => { apiMocks.relayRecord = listener; return () => { apiMocks.relayRecord = null; }; },
    onSessionReady: (listener: (value: any) => void) => { apiMocks.relayReady = listener; return () => { apiMocks.relayReady = null; }; },
    onSessionSyncError: vi.fn(() => () => {}),
    subscribeSession: apiMocks.subscribeRelaySession,
    unsubscribeSession: vi.fn(async () => {}),
  },
}));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => peerModeFlagMock.active,
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: configManagerMock,
}));

vi.mock('../state-machine', () => ({
  stateMachineManager: stateMachineManagerMock,
  SessionExecutionEvent: {
    START: 'start',
  },
}));

const resetStore = () => {
  // A test that rendered another device leaves that surface's container behind.
  activateSurface(LOCAL_SURFACE_ID);
  const surfaceContainers = (flowChatStore as any).surfaceContainers as Map<string, unknown>;
  Array.from(surfaceContainers.keys())
    .filter(surfaceId => surfaceId !== LOCAL_SURFACE_ID)
    .forEach(surfaceId => {
      flowChatStore.discardSurfaceState(surfaceId);
    });
  const metadataListRequests = (flowChatStore as any).metadataListRequests as
    | Map<string, { cleanupTimer?: ReturnType<typeof setTimeout> }>
    | undefined;
  metadataListRequests?.forEach(request => {
    if (request.cleanupTimer) {
      clearTimeout(request.cleanupTimer);
    }
  });
  metadataListRequests?.clear();
  const metadataPageRequests = (flowChatStore as any).metadataPageRequests as
    | Map<string, { cleanupTimer?: ReturnType<typeof setTimeout> }>
    | undefined;
  metadataPageRequests?.forEach(request => {
    if (request.cleanupTimer) {
      clearTimeout(request.cleanupTimer);
    }
  });
  metadataPageRequests?.clear();
  const fullHistoryHydrationRequests = (flowChatStore as any).fullHistoryHydrationRequests as
    | Map<string, { cancel?: () => void }>
    | undefined;
  fullHistoryHydrationRequests?.forEach(request => {
    request.cancel?.();
  });
  fullHistoryHydrationRequests?.clear();
  ((flowChatStore as any).deferredFullHistoryProjections as Map<string, unknown> | undefined)?.clear();
  ((flowChatStore as any).fullHistoryProjectionApplyRequests as Set<string> | undefined)?.clear();
  ((flowChatStore as any).sessionHistoryViews as Map<string, unknown> | undefined)?.clear();
  ((flowChatStore as any).sessionTurnWindowRequests as Map<string, unknown> | undefined)?.clear();
  ((flowChatStore as any).unsupportedRestoreCommands as Set<string> | undefined)?.clear();
  ((flowChatStore as any).pendingRemoveSessionOptions as Map<string, unknown> | undefined)?.clear();
  ((flowChatStore as any).userQuestionSnapshotRevisions as Map<string, number> | undefined)?.clear();
  flowChatStore.setState((): FlowChatState => ({
    sessions: new Map(),
    activeSessionId: null,
  }));
  dispatchJobStore.getState().clear();
  askUserQuestionDraftStore.setState({ drafts: {} });
  resetLiveSessionInteractionStoreForTest();
  flowChatStore.registerPersistUnreadCompletionCallback(() => {});
};

const createSession = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 'session-1',
  title: 'Session 1',
  dialogTurns: [],
  status: 'idle',
  config: { agentType: 'Standard' },
  createdAt: 1,
  lastActiveAt: 1,
  error: null,
  isHistorical: false,
  todos: [],
  maxContextTokens: 128128,
  mode: 'Standard',
  workspacePath: 'D:/workspace/OpenBitFun',
  isTransient: false,
  ...overrides,
});

const createPersistedTurn = (index: number, sessionId = 'history-1') => ({
  turnId: `turn-${index}`,
  turnIndex: index,
  sessionId,
  timestamp: index + 1,
  userMessage: {
    id: `user-${index}`,
    content: `prompt ${index}`,
    timestamp: index + 1,
  },
  modelRounds: [],
  startTime: index + 1,
  status: 'completed',
});

const createTurnCatalog = (
  count: number,
  revision = 'catalog-1',
  sessionId = 'history-1',
) => ({
  schemaVersion: 1,
  sessionId,
  revision,
  totalTurnCount: count,
  complete: true,
  entries: Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    storageTurnIndex: ordinal,
    turnId: `turn-${ordinal}`,
    preview: `prompt ${ordinal}`,
    previewTruncated: false,
  })),
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceReleasedLocalFullHistoryCompletion(): Promise<void> {
  await flushAsyncWork();
  await vi.advanceTimersByTimeAsync(1500);
  await flushAsyncWork();
}

function resetStartupTraceEventsForTest(): void {
  const trace = startupTrace as unknown as {
    phaseEvents: number;
    phaseRecords: unknown[];
  };
  trace.phaseEvents = 0;
  trace.phaseRecords.length = 0;
}

describe('FlowChatStore lazy worktree preference', () => {
  afterEach(() => {
    resetStore();
  });

  it('records and clears the desired state without changing the execution root', () => {
    const session = createSession({
      config: {
        workspacePath: '/repo',
        projectWorkspacePath: '/repo',
        executionTarget: { kind: 'local', rootPath: '/repo' },
      },
      workspacePath: '/repo',
      projectWorkspacePath: '/repo',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.setSessionWorktreeIsolationRequested(session.sessionId, true);
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config).toMatchObject({
      workspacePath: '/repo',
      worktreeIsolationRequested: true,
      executionTarget: { kind: 'local', rootPath: '/repo' },
    });

    flowChatStore.setSessionWorktreeIsolationRequested(session.sessionId, undefined);
    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.config
        .worktreeIsolationRequested,
    ).toBeUndefined();
  });
});

describe('FlowChatStore dispatch observer boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.cancelDispatchJob.mockResolvedValue({ cancelled: true });
  });

  afterEach(() => {
    resetStore();
  });

  it('accepts a canonical workspace path without allowing target identity changes', () => {
    const session = createSession({
      workspacePath: '/source',
      isHistorical: true,
      historyState: 'metadata-only',
      contextRestoreState: 'pending',
      config: {
        dispatchTargetRequest: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '~/repo',
        },
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '~/repo',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
        dispatchApprovalPolicy: 'reject-and-report',
      },
      dialogTurns: [],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateSessionDispatchTarget(session.sessionId, {
      targetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/home/user/repo',
      },
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/home/user/repo',
        displayName: 'renamed-host',
      },
      jobId: 'job-1',
      approvalPolicy: 'reject-and-report',
    });
    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.config
        .dispatchTarget,
    ).toMatchObject({
      connectionId: 'ssh-1',
      workspacePath: '/home/user/repo',
      displayName: 'renamed-host',
    });
    expect(flowChatStore.getState().sessions.get(session.sessionId)).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
    });

    flowChatStore.updateSessionDispatchTarget(session.sessionId, {
      targetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-2',
        workspacePath: '/other',
      },
      target: {
        kind: 'ssh',
        connectionId: 'ssh-2',
        workspacePath: '/other',
        displayName: 'other-host',
      },
      jobId: 'job-1',
      approvalPolicy: 'reject-and-report',
    });
    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.config
        .dispatchTarget,
    ).toMatchObject({
      connectionId: 'ssh-1',
      workspacePath: '/home/user/repo',
    });
  });

  it('leaves a detached target running when its source workspace closes', async () => {
    const session = createSession({
      workspacePath: '/source',
      config: {
        workspaceId: 'workspace-1',
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '/target',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
        dispatchJobState: 'running',
      },
      dialogTurns: [],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    await expect(flowChatStore.cancelRunningSessionsForWorkspace({
      id: 'workspace-1',
      rootPath: '/source',
      connectionId: undefined,
      sshHost: undefined,
    })).resolves.toEqual([]);

    expect(apiMocks.cancelDispatchJob).not.toHaveBeenCalled();
    expect(apiMocks.cancelSession).not.toHaveBeenCalled();
  });

  it('never saves a locally-cancelled observer turn into the session store', async () => {
    const session = createSession({
      workspacePath: '/source',
      config: {
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '/target',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
        dispatchJobState: 'running',
      },
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'run task',
          timestamp: 1,
        },
        modelRounds: [],
        status: 'processing',
        startTime: 1,
      }],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    await (flowChatStore as any).saveCancelledDialogTurn(
      session.sessionId,
      'turn-1',
    );

    expect(apiMocks.saveSessionTurn).not.toHaveBeenCalled();
  });

  it('keeps an existing failed terminal outcome when a stale cancelled snapshot arrives', () => {
    const terminalTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'run task',
        timestamp: 1,
      },
      modelRounds: [],
      status: 'error' as const,
      error: 'Target execution failed',
      startTime: 1,
      endTime: 2,
    };
    const session = createSession({
      workspacePath: '/source',
      config: {
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '/target',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
        dispatchJobState: 'failed',
        dispatchCursor: 10,
        dispatchLastError: 'Target execution failed',
      },
      error: 'Target execution failed',
      dialogTurns: [terminalTurn],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    const result = flowChatStore.applyDispatchSnapshot(session.sessionId, {
      jobId: 'job-1',
      state: 'cancelled',
      cursor: 10,
      expectedCursor: 10,
      terminalDrained: true,
    });
    const appliedSession = flowChatStore.getState().sessions.get(session.sessionId)!;

    expect(result).toEqual({ applied: true, cursor: 10 });
    expect(appliedSession.config.dispatchJobState).toBe('failed');
    expect(appliedSession.config.dispatchLastError).toBe('Target execution failed');
    expect(appliedSession.error).toBe('Target execution failed');
    expect(appliedSession.dialogTurns[0]).toBe(terminalTurn);
  });

  it('repairs a cached optimistic success when a follow-up fails before the executor adopts it', () => {
    const session = createSession({
      workspacePath: '/source',
      config: {
        dispatchTarget: { kind: 'ssh', connectionId: 'ssh-1', workspacePath: '/target', displayName: 'host' },
        dispatchJobId: 'job-1',
        dispatchJobState: 'failed',
        dispatchCursor: 10,
      },
      dialogTurns: [{
        id: 'dispatch_pending_job-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1', content: 'continue task', timestamp: 1,
          metadata: { __openbitfunOptimisticDispatchJobId: 'job-1' },
        },
        modelRounds: [], status: 'completed', startTime: 1, endTime: 2, success: true,
      }],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]), activeSessionId: session.sessionId,
    }));
    flowChatStore.applyDispatchSnapshot(session.sessionId, {
      jobId: 'job-1', state: 'failed', cursor: 10, expectedCursor: 10,
      lastError: 'Unsupported target reasoning preset', terminalDrained: true,
    });
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.dialogTurns[0]).toMatchObject({
      status: 'error', success: false, error: 'Unsupported target reasoning preset', modelRounds: [],
    });
  });
});

describe('FlowChatStore metadata persistence callbacks', () => {
  const completedSession = (): Session => createSession({
    hasUnreadCompletion: 'completed', lastFinishedAt: 10, historyState: 'ready',
    needsUserAttention: 'tool_confirm',
    dialogTurns: [{ id: 'finished-turn', sessionId: 'session-1', status: 'completed',
      userMessage: { id: 'user', content: 'Task', timestamp: 1 },
      modelRounds: [], startTime: 1, endTime: 10 }],
  });

  afterEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    resetStore();
  });

  it('acknowledges completion and preserves pending interaction facts', () => {
    const session = completedSession();
    flowChatStore.setState(() => ({ sessions: new Map([[session.sessionId, session]]) }));
    flowChatStore.clearSessionUnreadCompletion(session.sessionId);
    expect(flowChatStore.getState().sessions.get(session.sessionId)).toMatchObject({
      hasUnreadCompletion: undefined, needsUserAttention: 'tool_confirm',
    });
  });

  it.each(['new', 'metadata-only', 'ready'] as const)(
    'explicitly acknowledges a %s session and keeps a refreshed result read', (historyState) => {
      const session = { ...completedSession(), sessionId: `explicit-read-${historyState}`, historyState };
      if (historyState === 'metadata-only') session.dialogTurns = [];
      const summary = {
        sessionId: session.sessionId, execution: 'idle' as const,
        pendingApprovals: 0, pendingQuestions: 0, unreadCompletion: 'completed' as const,
        lastTurn: { turnId: 'finished-turn', turnIndex: 0, status: 'completed' as const, executionGeneration: 2 },
      };
      sessionActivityStore.applyRead(sessionActivityStore.beginRead(), [summary]);
      flowChatStore.setState(() => ({ sessions: new Map([[session.sessionId, session]]) }));
      const persist = vi.fn();
      flowChatStore.registerPersistUnreadCompletionCallback(persist);

      flowChatStore.clearSessionUnreadCompletion(session.sessionId);
      expect(flowChatStore.getState().sessions.get(session.sessionId)).toMatchObject({
        hasUnreadCompletion: undefined, needsUserAttention: 'tool_confirm',
      });
      expect(persist).toHaveBeenCalledWith(session.sessionId, undefined);
      expect(sessionActivityStore.get(session.sessionId)?.summary?.unreadCompletion).toBeUndefined();

      sessionActivityStore.applyRead(sessionActivityStore.beginRead(), [summary]);
      flowChatStore.applySessionActivityReceipt(sessionActivityStore.get(session.sessionId)!.summary!);
      expect(flowChatStore.getState().sessions.get(session.sessionId)?.hasUnreadCompletion).toBeUndefined();

      sessionActivityStore.applyRead(sessionActivityStore.beginRead(), [{ ...summary,
        lastTurn: { ...summary.lastTurn, executionGeneration: 3 },
      }]);
      flowChatStore.applySessionActivityReceipt(sessionActivityStore.get(session.sessionId)!.summary!);
      expect(flowChatStore.getState().sessions.get(session.sessionId)?.hasUnreadCompletion).toBe('completed');
    },
  );

  it('keeps the unread marker bound to the host summary generation', () => {
    const session = completedSession();
    flowChatStore.setState(() => ({ sessions: new Map([[session.sessionId, session]]) }));
    flowChatStore.applySessionActivityReceipt({
      sessionId: session.sessionId, execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
      unreadCompletion: 'completed',
      lastTurn: { turnId: 'finished-turn', turnIndex: 0, status: 'completed', executionGeneration: 2 },
    });
    const updated = flowChatStore.getState().sessions.get(session.sessionId)!;
    expect(updated.unreadCompletionGeneration).toBe(2);
    expect(updated.unreadCompletionTurnId).toBe('finished-turn');
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.hasUnreadCompletion).toBe('completed');
  });

  it('attaches the completion to its owner when a follow-up turn already exists', () => {
    const session = completedSession();
    session.dialogTurns.push({ ...session.dialogTurns[0], id: 'queued-follow-up', status: 'pending' });
    flowChatStore.setState(() => ({ sessions: new Map([[session.sessionId, session]]) }));
    flowChatStore.markSessionUnreadCompletion(session.sessionId, 'completed', 'finished-turn');
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.unreadCompletionTurnId).toBe('finished-turn');
  });

  it('persists unread completion clear only when the session state changes', () => {
    const persist = vi.fn();
    const session = createSession({ hasUnreadCompletion: 'completed' });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));
    flowChatStore.registerPersistUnreadCompletionCallback(persist);

    flowChatStore.clearSessionUnreadCompletion(session.sessionId);
    flowChatStore.clearSessionUnreadCompletion(session.sessionId);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(session.sessionId, undefined);
  });

  it('persists attention clear only when the session state changes', () => {
    const persist = vi.fn();
    const session = createSession({ needsUserAttention: 'ask_user' });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));
    flowChatStore.registerPersistUnreadCompletionCallback(persist);

    flowChatStore.clearSessionNeedsAttention(session.sessionId);
    flowChatStore.clearSessionNeedsAttention(session.sessionId);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(session.sessionId, undefined);
  });
});

describe('FlowChatStore session removal active selection', () => {
  afterEach(() => {
    resetStore();
  });

  it('can clear the active session atomically while keeping other sessions', () => {
    const keepSession = createSession({
      sessionId: 'session-keep',
      title: 'Keep me',
    });
    const removeSession = createSession({
      sessionId: 'session-remove',
      title: 'Remove me',
    });

    flowChatStore.setState(() => ({
      sessions: new Map([
        [keepSession.sessionId, keepSession],
        [removeSession.sessionId, removeSession],
      ]),
      activeSessionId: removeSession.sessionId,
    }));

    const removedSessionIds = flowChatStore.removeSession(removeSession.sessionId, {
      nextActiveSessionId: null,
    });

    expect(removedSessionIds).toEqual(['session-remove']);
    expect(flowChatStore.getState().activeSessionId).toBeNull();
    expect(Array.from(flowChatStore.getState().sessions.keys())).toEqual(['session-keep']);
  });

  it('reuses pending delete intent when a concurrent local remove wins the race', async () => {
    const deleteDeferred = createDeferred<void>();
    apiMocks.deleteSession.mockImplementation(() => deleteDeferred.promise);
    const keepSession = createSession({
      sessionId: 'session-keep',
      title: 'Keep me',
      workspacePath: 'D:/workspace/OpenBitFun',
    });
    const removeSession = createSession({
      sessionId: 'session-remove',
      title: 'Remove me',
      workspacePath: 'D:/workspace/OpenBitFun',
    });

    flowChatStore.setState(() => ({
      sessions: new Map([
        [keepSession.sessionId, keepSession],
        [removeSession.sessionId, removeSession],
      ]),
      activeSessionId: removeSession.sessionId,
    }));

    const deleting = flowChatStore.deleteSession(removeSession.sessionId, {
      nextActiveSessionId: null,
    });
    await flushAsyncWork();

    const removedSessionIds = flowChatStore.removeSession(removeSession.sessionId);
    expect(removedSessionIds).toEqual(['session-remove']);
    expect(flowChatStore.getState().activeSessionId).toBeNull();

    deleteDeferred.resolve();
    await deleting;

    expect(flowChatStore.getState().activeSessionId).toBeNull();
    expect(Array.from(flowChatStore.getState().sessions.keys())).toEqual(['session-keep']);
  });
});

describe('FlowChatStore token usage', () => {
  afterEach(() => {
    resetStore();
  });

  it('stores provider token usage on the matching dialog turn', () => {
    const session = createSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'hello',
          timestamp: 1000,
        },
        modelRounds: [],
        status: 'completed',
        startTime: 1000,
        endTime: 2400,
      }],
    });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateTokenUsage(session.sessionId, {
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
    }, 'turn-1');

    const stored = flowChatStore.getState().sessions.get(session.sessionId);

    expect(stored?.currentTokenUsage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
    });
    expect(stored?.dialogTurns[0].tokenUsage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
    });
    expect(stored?.dialogTurns[0].tokenUsage?.timestamp).toEqual(expect.any(Number));
  });

  it('keeps session context usage as the latest request while accumulating turn usage', () => {
    const session = createSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'hello',
          timestamp: 1000,
        },
        modelRounds: [],
        status: 'processing',
        startTime: 1000,
      }],
    });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateTokenUsage(session.sessionId, {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }, 'turn-1');
    flowChatStore.updateTokenUsage(session.sessionId, {
      inputTokens: 200,
      outputTokens: 75,
      totalTokens: 275,
    }, 'turn-1');

    const stored = flowChatStore.getState().sessions.get(session.sessionId);

    expect(stored?.currentTokenUsage).toMatchObject({
      inputTokens: 200,
      outputTokens: 75,
      totalTokens: 275,
    });
    expect(stored?.dialogTurns[0].tokenUsage).toMatchObject({
      inputTokens: 300,
      outputTokens: 125,
      totalTokens: 425,
    });
  });

  it('falls back safely when deleting the turn that sourced current usage', () => {
    const previousTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: { id: 'user-1', content: 'first', timestamp: 1_000 },
      modelRounds: [{ id: 'round-1' }],
      tokenUsage: {
        inputTokens: 600,
        outputTokens: 100,
        totalTokens: 700,
        timestamp: 1_500,
      },
      status: 'completed' as const,
      startTime: 1_000,
    };
    const sourceTurn = {
      id: 'turn-2',
      sessionId: 'session-1',
      userMessage: { id: 'user-2', content: 'second', timestamp: 2_000 },
      modelRounds: [{ id: 'round-2' }],
      status: 'completed' as const,
      startTime: 2_000,
    };
    const session = createSession({
      dialogTurns: [previousTurn, sourceTurn],
      currentTokenUsage: {
        inputTokens: 1_200,
        outputTokens: 320,
        totalTokens: 1_520,
        timestamp: 2_500,
        turnId: 'turn-2',
        source: 'model_request',
      },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.deleteDialogTurn(session.sessionId, 'turn-2');

    expect(flowChatStore.getState().sessions.get(session.sessionId)?.currentTokenUsage).toEqual({
      ...previousTurn.tokenUsage,
      turnId: 'turn-1',
    });
  });

  it('does not derive a stale fallback from partial history after deleting the usage source', () => {
    const previousTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: { id: 'user-1', content: 'partial older turn', timestamp: 1_000 },
      modelRounds: [{ id: 'round-1' }],
      tokenUsage: {
        inputTokens: 600,
        outputTokens: 100,
        totalTokens: 700,
        timestamp: 1_500,
      },
      status: 'completed' as const,
      startTime: 1_000,
    };
    const sourceTurn = {
      id: 'turn-2',
      sessionId: 'session-1',
      userMessage: { id: 'user-2', content: 'source', timestamp: 2_000 },
      modelRounds: [{ id: 'round-2' }],
      status: 'completed' as const,
      startTime: 2_000,
    };
    const session = createSession({
      dialogTurns: [previousTurn, sourceTurn],
      isPartial: true,
      currentTokenUsage: {
        inputTokens: 1_200,
        outputTokens: 320,
        totalTokens: 1_520,
        timestamp: 2_500,
        turnId: 'turn-2',
        source: 'model_request',
      },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.deleteDialogTurn(session.sessionId, 'turn-2');

    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.currentTokenUsage,
    ).toBeUndefined();
  });

  it('clears usage when truncation removes its source and no safe fallback exists', () => {
    const retainedTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: { id: 'user-1', content: 'first', timestamp: 1_000 },
      modelRounds: [],
      status: 'completed' as const,
      startTime: 1_000,
    };
    const sourceTurn = {
      id: 'turn-2',
      sessionId: 'session-1',
      userMessage: { id: 'user-2', content: 'second', timestamp: 2_000 },
      modelRounds: [{ id: 'round-2' }],
      status: 'completed' as const,
      startTime: 2_000,
    };
    const session = createSession({
      dialogTurns: [retainedTurn, sourceTurn],
      currentTokenUsage: {
        inputTokens: 1_200,
        outputTokens: 320,
        totalTokens: 1_520,
        timestamp: 2_500,
        turnId: 'turn-2',
        source: 'model_request',
      },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.truncateDialogTurnsFrom(session.sessionId, 1);

    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.currentTokenUsage,
    ).toBeUndefined();
  });
});

describe('FlowChatStore round attempts', () => {
  afterEach(() => {
    resetStore();
  });

  it('supersedes active items from an older attempt when a newer attempt starts in the same round', () => {
    const session = createSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'hello',
          timestamp: 1000,
        },
        modelRounds: [{
          id: 'round-1',
          index: 0,
          items: [{
            id: 'ask-1',
            type: 'tool',
            toolName: 'AskUserQuestion',
            timestamp: 1100,
            status: 'preparing',
            attemptId: 'round-1:attempt:1',
            attemptIndex: 1,
            toolCall: {
              id: 'ask-1',
              input: {},
            },
            isParamsStreaming: true,
            startTime: 1100,
          }],
          isStreaming: true,
          isComplete: false,
          status: 'streaming',
          startTime: 1000,
        }],
        status: 'processing',
        startTime: 1000,
      }],
    });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.addModelRoundItem(session.sessionId, 'turn-1', {
      id: 'text-2',
      type: 'text',
      content: 'retry output',
      isStreaming: true,
      isMarkdown: true,
      timestamp: 1200,
      status: 'streaming',
      attemptId: 'round-1:attempt:2',
      attemptIndex: 2,
    }, 'round-1');

    const round = flowChatStore.getState().sessions.get(session.sessionId)?.dialogTurns[0]?.modelRounds[0];
    expect(round?.attempts?.map(attempt => attempt.status)).toEqual(['superseded', 'streaming']);

    const supersededTool = round?.attempts?.[0]?.items[0];
    expect(supersededTool).toMatchObject({
      type: 'tool',
      status: 'cancelled',
      interruptionReason: 'retry_superseded',
    });
  });

  it('immediately supersedes active items when retry diagnostics arrive before next attempt output', () => {
    const session = createSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'hello',
          timestamp: 1000,
        },
        modelRounds: [{
          id: 'round-1',
          index: 0,
          items: [{
            id: 'tool-1',
            type: 'tool',
            toolName: 'FakeTool',
            timestamp: 1100,
            status: 'preparing',
            attemptId: 'round-1:attempt:1',
            attemptIndex: 1,
            toolCall: {
              id: 'tool-1',
              input: {},
            },
            isParamsStreaming: true,
            startTime: 1100,
          }],
          isStreaming: true,
          isComplete: false,
          status: 'streaming',
          startTime: 1000,
        }],
        status: 'processing',
        startTime: 1000,
      }],
    });

    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateModelRound(session.sessionId, 'turn-1', 'round-1', round =>
      mergeModelRoundAttemptDiagnostics(round, [{
        attemptId: 'round-1:attempt:1',
        attemptIndex: 1,
        category: 'invalid_tool_arguments',
      }], { supersedeMatchingAttempts: true }),
    );

    const round = flowChatStore.getState().sessions.get(session.sessionId)?.dialogTurns[0]?.modelRounds[0];
    expect(round).toMatchObject({ status: 'streaming', isStreaming: true });
    expect(round?.attempts?.[0]).toMatchObject({
      status: 'superseded',
      diagnostic: { category: 'invalid_tool_arguments' },
    });
    expect(round?.attempts?.[0]?.items[0]).toMatchObject({
      type: 'tool',
      status: 'cancelled',
      isParamsStreaming: false,
      interruptionReason: 'retry_superseded',
    });
  });

  it('preserves retry superseded interruption details when restoring persisted turns', () => {
    const restoredTurn = (flowChatStore as any).convertToDialogTurns([{
      turnId: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'hello',
        timestamp: 1000,
        metadata: {},
      },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        status: 'completed',
        timestamp: 1000,
        textItems: [],
        thinkingItems: [],
        toolItems: [{
          id: 'ask-1',
          toolName: 'AskUserQuestion',
          toolCall: { id: 'ask-1', input: {} },
          toolResult: {
            result: null,
            success: false,
            error: 'Superseded by a newer retry in the same model round.',
          },
          startTime: 1100,
          endTime: 1200,
          status: 'cancelled',
          interruptionReason: 'retry_superseded',
          attemptId: 'round-1:attempt:1',
          attemptIndex: 1,
        }],
        attemptDiagnostics: [{
          attemptId: 'round-1:attempt:1',
          attemptIndex: 1,
          category: 'invalid_tool_arguments',
          toolCalls: [{
            toolId: 'ask-1',
            toolName: 'AskUserQuestion',
            rawArguments: '{"questions":',
            validationError: 'EOF while parsing an object',
          }],
        }],
      }],
      status: 'completed',
      timestamp: 1000,
    }])[0];

    const restoredRound = restoredTurn.modelRounds[0];
    expect(restoredRound.attempts?.map((attempt: any) => attempt.status)).toEqual(['completed']);
    expect(restoredRound.attempts?.[0]?.items[0]).toMatchObject({
      type: 'tool',
      status: 'cancelled',
      interruptionReason: 'retry_superseded',
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
    });
    expect(restoredRound.attempts?.[0]?.diagnostic?.toolCalls?.[0]).toMatchObject({
      rawArguments: '{"questions":',
      validationError: 'EOF while parsing an object',
    });
  });

  it('adds a diagnostic-only retry attempt to the collapsed history', () => {
    const round = mergeModelRoundAttemptDiagnostics({
      id: 'round-1',
      index: 0,
      items: [],
      isStreaming: false,
      isComplete: true,
      status: 'completed',
      startTime: 1000,
    }, [{
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      category: 'invalid_tool_arguments',
      toolCalls: [],
    }]);

    expect(round.attempts).toEqual([expect.objectContaining({
      id: 'round-1:attempt:1',
      index: 1,
      status: 'superseded',
      items: [],
      diagnostic: expect.objectContaining({ category: 'invalid_tool_arguments' }),
    })]);
  });

  it('attaches a diagnostic to the matching existing retry attempt', () => {
    const round = mergeModelRoundAttemptDiagnostics({
      id: 'round-1',
      index: 0,
      items: [],
      isStreaming: false,
      isComplete: true,
      status: 'completed',
      startTime: 1000,
      attempts: [{
        id: 'round-1:attempt:1',
        index: 1,
        status: 'superseded',
        items: [],
      }],
    }, [{
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      category: 'transient_request_error',
      rawError: 'provider connection reset',
    }]);

    expect(round.attempts).toHaveLength(1);
    expect(round.attempts?.[0]?.diagnostic).toMatchObject({
      category: 'transient_request_error',
      rawError: 'provider connection reset',
    });
  });

  it('accumulates diagnostics emitted one retry attempt at a time', () => {
    const afterFirstDiagnostic = mergeModelRoundAttemptDiagnostics({
      id: 'round-1',
      index: 0,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: 1000,
    }, [{
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      category: 'invalid_tool_arguments',
    }]);

    const afterSecondDiagnostic = mergeModelRoundAttemptDiagnostics(afterFirstDiagnostic, [{
      attemptId: 'round-1:attempt:2',
      attemptIndex: 2,
      category: 'transient_stream_error',
      rawError: 'connection reset',
    }]);

    expect(afterSecondDiagnostic.attemptDiagnostics?.map(diagnostic => diagnostic.attemptIndex)).toEqual([1, 2]);
    expect(afterSecondDiagnostic.attempts?.map(attempt => attempt.diagnostic?.category)).toEqual([
      'invalid_tool_arguments',
      'transient_stream_error',
    ]);
  });

  it('sorts retry diagnostics and the corresponding attempts by attempt index', () => {
    const round = mergeModelRoundAttemptDiagnostics({
      id: 'round-1',
      index: 0,
      items: [],
      isStreaming: false,
      isComplete: true,
      status: 'completed',
      startTime: 1000,
    }, [{
      attemptId: 'round-1:attempt:2',
      attemptIndex: 2,
      category: 'transient_stream_error',
    }, {
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      category: 'invalid_tool_arguments',
    }]);

    expect(round.attemptDiagnostics?.map(diagnostic => diagnostic.attemptIndex)).toEqual([1, 2]);
    expect(round.attempts?.map(attempt => attempt.index)).toEqual([1, 2]);
  });

  it('restores a persisted deferred call as its canonical wire invocation', () => {
    const [restoredTurn] = (flowChatStore as any).convertToDialogTurns([{
      turnId: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'fetch docs',
        timestamp: 1000,
        metadata: {},
      },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        status: 'completed',
        timestamp: 1000,
        textItems: [],
        thinkingItems: [],
        toolItems: [{
          id: 'tool-1',
          toolName: 'CallDeferredTool',
          toolCall: {
            id: 'tool-1',
            input: {
              tool_name: 'WebFetch',
              args: { url: 'https://example.test' },
            },
          },
          toolResult: { result: { content: 'docs' }, success: true },
          startTime: 1100,
          endTime: 1200,
          status: 'completed',
        }],
      }],
      status: 'completed',
      timestamp: 1000,
    }]);

    const tool = restoredTurn.modelRounds[0].items[0];
    expect(tool).toMatchObject({
      type: 'tool',
      toolName: 'CallDeferredTool',
      toolCall: {
        id: 'tool-1',
        input: {
          tool_name: 'WebFetch',
          args: { url: 'https://example.test' },
        },
      },
    });
    expect(projectEffectiveToolItem(tool as any)).toMatchObject({
      toolName: 'WebFetch',
      toolCall: { id: 'tool-1', input: { url: 'https://example.test' } },
    });
  });
});


describe('FlowChatStore ACP context usage', () => {
  afterEach(() => {
    resetStore();
  });

  it('stores ACP context usage separately from token usage reports', () => {
    const session = createSession({
      config: { agentType: 'acp:codex' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateAcpContextUsage(session.sessionId, {
      used: 42_000,
      size: 128_000,
      cost: { amount: 0.12, currency: 'USD' },
    });

    const stored = flowChatStore.getState().sessions.get(session.sessionId);
    expect(stored?.currentAcpContextUsage).toMatchObject({
      used: 42_000,
      size: 128_000,
      cost: { amount: 0.12, currency: 'USD' },
    });
    expect(stored?.currentTokenUsage).toBeUndefined();
  });
});

describe('FlowChatStore session model selection', () => {
  afterEach(() => {
    resetStore();
  });

  it('stores the primary selector on a legacy session without a model', () => {
    const session = createSession({ config: { agentType: 'Standard' } });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateSessionModelName(session.sessionId, 'primary');

    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config.modelName).toBe('primary');
  });

  it('sets and clears the session reasoning preset independently of the model', () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'model-a' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateSessionReasoningPreset(session.sessionId, '  high  ');
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config).toMatchObject({
      modelName: 'model-a',
      reasoningPreset: 'high',
    });

    flowChatStore.updateSessionReasoningPreset(session.sessionId, null);
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config.reasoningPreset)
      .toBeUndefined();
  });

  it('applies a model fallback notice that matches the stored model', () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'removed-model' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    const applied = flowChatStore.applySessionModelFallback(
      session.sessionId,
      'removed-model',
      'primary',
    );

    expect(applied).toBe(true);
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config.modelName).toBe('primary');
  });

  it('applies a model fallback notice when the session has no stored model yet', () => {
    const session = createSession({ config: { agentType: 'Standard' } });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    const applied = flowChatStore.applySessionModelFallback(
      session.sessionId,
      'removed-model',
      'primary',
    );

    expect(applied).toBe(true);
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config.modelName).toBe('primary');
  });

  it('ignores a stale model fallback notice that would revert a newer selection', () => {
    // Restore-time fallback races the explicit update that triggered the
    // restore: the composer already stored the picked model when the notice
    // for the old one lands.
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'removed-model' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    flowChatStore.updateSessionModelName(session.sessionId, 'deepseek-v4-flash');
    const applied = flowChatStore.applySessionModelFallback(
      session.sessionId,
      'removed-model',
      'primary',
    );

    expect(applied).toBe(false);
    expect(flowChatStore.getState().sessions.get(session.sessionId)?.config.modelName).toBe(
      'deepseek-v4-flash',
    );
  });

  it('ignores a model fallback notice for an unknown session', () => {
    expect(
      flowChatStore.applySessionModelFallback('missing-session', 'removed-model', 'primary'),
    ).toBe(false);
  });

  it('clears an invalidated reasoning preset when the notice matches', () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'model-a', reasoningPreset: 'high' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));

    expect(
      flowChatStore.applySessionReasoningPresetAutoClear(session.sessionId, 'high'),
    ).toBe(true);
    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.config.reasoningPreset,
    ).toBeUndefined();
  });

  it('ignores a stale reasoning preset clear after a newer selection', () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'model-a', reasoningPreset: 'high' },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));
    flowChatStore.updateSessionReasoningPreset(session.sessionId, 'low');

    expect(
      flowChatStore.applySessionReasoningPresetAutoClear(session.sessionId, 'high'),
    ).toBe(false);
    expect(
      flowChatStore.getState().sessions.get(session.sessionId)?.config.reasoningPreset,
    ).toBe('low');
  });
});

describe('FlowChatStore historical session hydration state', () => {
  beforeEach(() => {
    peerModeFlagMock.active = false;
    apiMocks.restoreSessionView.mockReset();
    apiMocks.restoreSessionWithTurns.mockReset();
    apiMocks.loadSessionTurns.mockReset();
    apiMocks.loadSessionTurnWindow.mockReset();
    vi.stubGlobal('CustomEvent', class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    peerModeFlagMock.active = false;
    resetStore();
    if (typeof apiMocks.restoreSessionView !== 'function') {
      (apiMocks as any).restoreSessionView = vi.fn();
    }
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads persisted metadata as metadata-only historical sessions', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        modelName: 'primary',
        createdAt: 10,
        lastActiveAt: 20,
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    const session = flowChatStore.getState().sessions.get('history-1');
    expect(session).toMatchObject({
      sessionId: 'history-1',
      isHistorical: true,
      historyState: 'metadata-only',
      dialogTurns: [],
    });
  });

  it('keeps persisted workspace identity separate from remote execution scope', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'local-history',
        title: 'Local session',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
        workspaceHostname: 'localhost',
      },
      {
        sessionId: 'legacy-remote-history',
        title: 'Legacy remote session',
        agentType: 'Standard',
        createdAt: 11,
        lastActiveAt: 21,
        remoteSshHost: 'localhost',
        workspaceHostname: 'legacy.example',
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    const local = flowChatStore.getState().sessions.get('local-history');
    expect(local?.workspaceHostname).toBe('localhost');
    expect(local?.remoteConnectionId).toBeUndefined();
    expect(local?.remoteSshHost).toBeUndefined();

    const legacyRemote = flowChatStore.getState().sessions.get('legacy-remote-history');
    expect(legacyRemote?.workspaceHostname).toBe('legacy.example');
    expect(legacyRemote?.remoteSshHost).toBe('legacy.example');
  });

  it('preserves a localhost SSH target when a remote connection id is present', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'remote-loopback-history',
        title: 'Remote loopback session',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
        workspaceHostname: 'localhost',
      },
    ]);

    await flowChatStore.initializeFromDisk(
      '/srv/project',
      'connection-1',
      'localhost',
    );

    expect(flowChatStore.getState().sessions.get('remote-loopback-history')).toMatchObject({
      remoteConnectionId: 'connection-1',
      remoteSshHost: 'localhost',
      workspaceHostname: 'localhost',
    });
  });

  it('restores history directly from the execution host', async () => {
    const order: string[] = [];
    apiMocks.restoreSessionView.mockImplementationOnce(async () => {
      order.push('restore');
      return {
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 0,
          createdAt: 1,
        },
        turns: [],
        contextRestoreState: 'ready',
      };
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(order).toEqual(['restore']);
  });


  it('restores history from the peer host in Peer Device Mode', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: [],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', '/Users/host/project');

    expect(apiMocks.restoreSessionView).toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')?.historyState).not.toBe('failed');
  });

  it('keeps an in-memory Peer Host turn live when opening mid-execution', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'keep going', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [{
            id: 'text-live',
            content: 'partial',
            isStreaming: true,
            timestamp: 2,
            status: 'streaming',
          }],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      contextRestoreState: 'pending',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', '/Users/host/project');

    const turn = flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0];
    expect(turn).toMatchObject({
      id: 'turn-live',
      status: 'processing',
      modelRounds: [{
        id: 'round-live',
        status: 'streaming',
        isStreaming: true,
        items: [{
          id: 'text-live',
          status: 'streaming',
          isStreaming: true,
          content: 'partial',
        }],
      }],
    });
    expect(stateMachineManagerMock.reset).toHaveBeenCalledWith('history-1');
    expect(stateMachineManagerMock.transition).toHaveBeenCalledWith(
      'history-1',
      'start',
      {
        taskId: 'history-1',
        dialogTurnId: 'turn-live',
      },
    );
  });

  it('does not paint a lagging persist of the current Turn when the Runtime journal is present', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'analyze the project', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [{
            id: 'read-readme',
            toolName: 'Read',
            status: 'running',
            timestamp: 2,
            toolCall: { id: 'read-readme', input: { path: 'README.md' } },
          }],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      runtimeEventSnapshot: {
        sessionId: 'history-1',
        streamId: 'runtime-a',
        cursor: 40,
        activeTurnId: 'turn-live',
        events: [{
          eventName: 'agentic://dialog-turn-started',
          payload: { sessionId: 'history-1', turnId: 'turn-live' },
        }],
      },
      contextRestoreState: 'pending',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', '/Users/host/project');

    expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0]).toMatchObject({
      id: 'turn-live',
      status: 'pending',
      modelRounds: [],
    });
  });

  it('does not let a lagging history load overwrite a live current-Turn projection', async () => {
    peerModeFlagMock.active = true;
    const liveTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'analyze the project', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'read-readme',
          type: 'tool' as const,
          toolName: 'Read',
          status: 'completed' as const,
          timestamp: 2,
          toolCall: { id: 'read-readme', input: { path: 'README.md' } },
          toolResult: { success: true },
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 2,
      }],
      status: 'processing' as const,
      startTime: 1,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/Users/host/project',
          historyState: 'ready',
          dialogTurns: [liveTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'analyze the project', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [{
            id: 'read-readme',
            toolName: 'Read',
            status: 'running',
            timestamp: 2,
            toolCall: { id: 'read-readme', input: { path: 'README.md' } },
          }],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      runtimeEventSnapshot: {
        sessionId: 'history-1',
        streamId: 'runtime-a',
        cursor: 40,
        activeTurnId: 'turn-live',
        events: [],
      },
      contextRestoreState: 'pending',
    });

    await flowChatStore.loadSessionHistory('history-1', '/Users/host/project');

    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({
      id: 'read-readme',
      status: 'completed',
    });
  });

  it('re-attaches a missed AskUserQuestion mailbox without restarting the running turn', async () => {
    peerModeFlagMock.active = true;
    const pendingQuestion = {
      toolId: 'ask-tool-1',
      sessionId: 'history-1',
      dialogTurnId: 'turn-live',
      modelRoundId: 'round-question',
      questions: {
        questions: [{
          question: 'Which verification should run?',
          header: 'Verification',
          options: [
            { label: 'Focused', description: 'Run the focused checks.' },
            { label: 'Full', description: 'Run the full suite.' },
          ],
        }],
      },
      registeredAtMs: 3,
    };
    const hostTurn = {
      turnId: 'turn-live',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-live', content: 'ask me first', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'inprogress',
    };
    const hostSession = {
      sessionId: 'history-1',
      sessionName: 'History 1',
      agentType: 'Standard',
      state: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
      turnCount: 1,
      createdAt: 1,
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession,
      turns: [hostTurn],
      interactionSnapshot: {
        sessionId: 'history-1',
        userQuestions: { revision: 7, questions: [pendingQuestion] },
        permissions: { revision: 2, requests: [] },
      },
      contextRestoreState: 'pending',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/Users/host/project',
          historyState: 'ready',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const firstRefresh = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );
    expect(firstRefresh.pendingUserQuestions).toEqual({
      revision: 7,
      questions: [pendingQuestion],
    });

    const recoveredTurn = flowChatStore
      .getState()
      .sessions.get('history-1')
      ?.dialogTurns[0];
    expect(recoveredTurn).toMatchObject({
      id: 'turn-live',
      status: 'processing',
      modelRounds: [{
        id: 'round-question',
        status: 'streaming',
        isStreaming: true,
        items: [{
          id: 'ask-tool-1',
          type: 'tool',
          toolName: 'AskUserQuestion',
          status: 'waiting',
          isParamsStreaming: false,
          toolCall: {
            id: 'ask-tool-1',
            input: pendingQuestion.questions,
          },
        }],
      }],
    });

    // An older Host omits the additive field. Absence means "event-only
    // compatibility", not an authoritative empty mailbox.
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession,
      turns: [hostTurn],
      contextRestoreState: 'pending',
    });
    await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items,
    ).toHaveLength(1);

    // An older snapshot cannot erase a request that a newer Runtime mailbox
    // already proved is still blocking the turn.
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession,
      turns: [hostTurn],
      interactionSnapshot: {
        sessionId: 'history-1',
        userQuestions: { revision: 6, questions: [] },
        permissions: { revision: 2, requests: [] },
      },
      contextRestoreState: 'pending',
    });
    await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items,
    ).toHaveLength(1);

    // Once the same Runtime publishes a newer empty mailbox, the recovered
    // card is removed without cancelling or restarting the Session.
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession,
      turns: [hostTurn],
      interactionSnapshot: {
        sessionId: 'history-1',
        userQuestions: { revision: 8, questions: [] },
        permissions: { revision: 3, requests: [] },
      },
      contextRestoreState: 'pending',
    });
    await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items,
    ).toEqual([]);
  });

  it('clears an unsubmitted question draft when an authoritative mailbox removes the tool', () => {
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          dialogTurns: [{
            id: 'turn-live',
            sessionId: 'history-1',
            userMessage: { id: 'user-live', content: 'ask me', timestamp: 1 },
            modelRounds: [],
            status: 'processing',
            startTime: 1,
          }],
        }),
      ]]),
      activeSessionId: 'history-1',
    }));

    const pendingQuestion = {
      toolId: 'ask-tool-1',
      sessionId: 'history-1',
      dialogTurnId: 'turn-live',
      modelRoundId: 'round-question',
      questions: {
        questions: [{
          question: 'Which verification should run?',
          header: 'Verification',
          options: [{ label: 'Focused', description: 'Run focused checks.' }],
        }],
      },
      registeredAtMs: 3,
    };

    expect(flowChatStore.reconcilePendingUserQuestions('history-1', {
      revision: 1,
      questions: [pendingQuestion],
    })).toBe(true);

    const draftKey = askUserQuestionDraftKey('history-1', 'ask-tool-1');
    askUserQuestionDraftStore.getState().setSingleAnswer(draftKey, 0, 'Focused');
    expect(askUserQuestionDraftStore.getState().drafts[draftKey]).toBeDefined();

    expect(flowChatStore.reconcilePendingUserQuestions('history-1', {
      revision: 2,
      questions: [],
    })).toBe(true);
    expect(askUserQuestionDraftStore.getState().drafts[draftKey]).toBeUndefined();
  });

  it.each(['single', 'retry', 'diagnostic', 'answered'] as const)('keeps recovered questions in the rendered attempt and settles them without resurrection (%s)', (scenario) => {
    const retry = scenario === 'retry';
    const task = { id: 'task', type: 'tool', toolName: 'Task', status: 'running',
      timestamp: 2, toolCall: { id: 'task', input: {} }, requiresConfirmation: false } as const;
    const attempt = { id: 'attempt-live', index: retry ? 2 : 1, status: 'streaming' as const,
      items: [{ ...task, attemptId: 'attempt-live', attemptIndex: retry ? 2 : 1 }] };
    const older = { id: 'attempt-old', index: 1, status: 'superseded' as const,
      items: [{ ...task, id: 'old-task', status: 'cancelled' as const,
        attemptId: 'attempt-old', attemptIndex: 1 }] };
    const attempts = scenario === 'diagnostic'
      ? [{ ...attempt, diagnostic: { category: 'invalid_tool_arguments' } }]
      : retry ? [older, attempt] : [attempt];
    const originalRound = { id: 'round-live', index: 0, status: 'streaming' as const,
      isStreaming: true, isComplete: false, startTime: 1,
      attempts, items: attempts.flatMap(entry => entry.items) };
    flowChatStore.setState(() => ({
      sessions: new Map([['history-1', createSession({ sessionId: 'history-1',
        dialogTurns: [{ id: 'turn-live', sessionId: 'history-1',
          userMessage: { id: 'user', content: 'ask me', timestamp: 1 },
          modelRounds: [originalRound], status: 'processing', startTime: 1 }] })]]),
      activeSessionId: 'history-1',
    }));
    const snapshot = { revision: 7, questions: [{ toolId: 'child-question',
      sessionId: 'history-1', dialogTurnId: 'turn-live',
      questions: { questions: [{ question: 'Which time zone?' }] }, registeredAtMs: 3 }] };
    const round = () => flowChatStore.getState().sessions.get('history-1')!.dialogTurns[0].modelRounds[0];
    flowChatStore.reconcilePendingUserQuestions('history-1', snapshot);
    expect(round().attempts!.at(-1)!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'child-question', status: 'waiting',
        attemptId: scenario === 'diagnostic' ? 'runtime-interaction:round-live' : 'attempt-live', isParamsStreaming: false }),
    ]));
    expect(round().items).toEqual(round().attempts!.flatMap(entry => entry.items));
    const visibleRound = sessionToVirtualItems(flowChatStore.getState().sessions.get('history-1')!)
      .find(item => item.type === 'model-round');
    expect(visibleRound?.type).toBe('model-round');
    if (visibleRound?.type === 'model-round') {
      const displayed = [...visibleRound.data.attempts!].reverse().find(entry => !entry.diagnostic)!;
      expect(buildModelRoundItemGroups({ items: displayed.items, isStreaming: true,
        disableExploreGrouping: false, isCollapsibleTool: () => false }))
        .toContainEqual({ type: 'critical', item: expect.objectContaining({ id: 'child-question' }) });
    }
    // Same-revision refresh is idempotent and retains the visible question.
    const beforeRefresh = round();
    flowChatStore.reconcilePendingUserQuestions('history-1', snapshot);
    expect(round()).toBe(beforeRefresh);
    flowChatStore.updateModelRoundItem('history-1', 'turn-live', 'child-question', { isParamsStreaming: true });
    flowChatStore.reconcilePendingUserQuestions('history-1', snapshot);
    expect(round().attempts!.at(-1)!.items.find(item => item.id === 'child-question'))
      .toMatchObject({ status: 'waiting', isParamsStreaming: false });
    expect(originalRound.items).toHaveLength(retry ? 2 : 1);
    expect(attempt.items).toHaveLength(1);
    if (retry) expect(round().attempts![0].items).toEqual(older.items);

    // The ordinary streaming update path rebuilds items from attempts.
    flowChatStore.updateModelRound('history-1', 'turn-live', 'round-live', current => ({ ...current }));
    expect(round().items.some(item => item.id === 'child-question')).toBe(true);
    if (scenario === 'answered') {
      flowChatStore.updateModelRoundItem('history-1', 'turn-live', 'child-question', {
        status: 'completed', toolResult: { success: true, result: { answers: { '0': 'UTC' } } },
      });
    }
    flowChatStore.reconcilePendingUserQuestions('history-1', { revision: 8, questions: [] });
    if (scenario === 'answered') {
      expect(round().items.find(item => item.id === 'child-question')).toMatchObject({ status: 'completed' });
      expect(round().items.find(item => item.id === 'child-question')).not.toHaveProperty('_runtimeInteractionProjection');
      expect(round().items).toEqual(round().attempts!.flatMap(entry => entry.items));
      return;
    }
    expect(round().items.some(item => item.id === 'child-question')).toBe(false);
    expect(round().attempts!.flatMap(entry => entry.items).some(item => item.id === 'child-question')).toBe(false);
    flowChatStore.updateModelRound('history-1', 'turn-live', 'round-live', current => ({ ...current }));
    expect(round().items.some(item => item.id === 'child-question')).toBe(false);
  });

  it('re-enables a same-revision mailbox card changed back to parameter streaming', () => {
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          dialogTurns: [{
            id: 'turn-live',
            sessionId: 'history-1',
            userMessage: { id: 'user-live', content: 'ask me', timestamp: 1 },
            modelRounds: [],
            status: 'processing',
            startTime: 1,
          }],
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    const snapshot = {
      revision: 4,
      questions: [{
        toolId: 'ask-tool-1',
        sessionId: 'history-1',
        dialogTurnId: 'turn-live',
        modelRoundId: 'round-question',
        questions: {
          questions: [{
            question: 'Continue?',
            header: 'Choice',
            options: [{ label: 'Yes', description: 'Continue.' }],
          }],
        },
        registeredAtMs: 3,
      }],
    };

    expect(flowChatStore.reconcilePendingUserQuestions('history-1', snapshot)).toBe(true);
    flowChatStore.setState(prev => {
      const session = prev.sessions.get('history-1')!;
      const dialogTurns = [...session.dialogTurns];
      const modelRounds = [...dialogTurns[0].modelRounds];
      const items = [...modelRounds[0].items];
      items[0] = {
        ...items[0],
        isParamsStreaming: true,
      } as any;
      modelRounds[0] = { ...modelRounds[0], items };
      dialogTurns[0] = { ...dialogTurns[0], modelRounds };
      const sessions = new Map(prev.sessions);
      sessions.set('history-1', { ...session, dialogTurns });
      return { ...prev, sessions };
    });

    expect(flowChatStore.reconcilePendingUserQuestions('history-1', snapshot)).toBe(true);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({
      status: 'waiting',
      isParamsStreaming: false,
    });
  });

  it('acquires an empty current-Turn base for Runtime event replay before applying interactions', async () => {
    peerModeFlagMock.active = true;
    const pendingQuestion = {
      toolId: 'ask-tool-1',
      sessionId: 'history-1',
      dialogTurnId: 'turn-live',
      modelRoundId: 'round-live',
      questions: { questions: [{ question: 'Continue?', header: 'Choice', options: [] }] },
      registeredAtMs: 4,
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'ask me', timestamp: 1 },
        modelRounds: [],
        startTime: 1,
        status: 'inprogress',
      }],
      interactionSnapshot: {
        sessionId: 'history-1',
        userQuestions: { revision: 3, questions: [pendingQuestion] },
        permissions: { revision: 0, requests: [] },
      },
      runtimeEventSnapshot: {
        sessionId: 'history-1',
        streamId: 'runtime-a',
        cursor: 12,
        activeTurnId: 'turn-live',
        events: [{
          eventName: 'agentic://dialog-turn-started',
          payload: { sessionId: 'history-1', turnId: 'turn-live' },
        }],
      },
      contextRestoreState: 'pending',
    });
    const staleProjectedTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'ask me', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'stale-text',
          type: 'text' as const,
          content: 'stale partial projection',
          timestamp: 2,
          status: 'streaming' as const,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 2,
      }],
      status: 'processing' as const,
      startTime: 1,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/Users/host/project',
          historyState: 'ready',
          dialogTurns: [staleProjectedTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
    );

    expect(result.runtimeEventSnapshot).toMatchObject({
      streamId: 'runtime-a',
      cursor: 12,
      activeTurnId: 'turn-live',
    });
    expect(result.pendingUserQuestions).toEqual({ revision: 3, questions: [pendingQuestion] });
    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0].modelRounds,
    ).toEqual([]);

    flowChatStore.reconcilePendingUserQuestions('history-1', result.pendingUserQuestions);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({
      id: 'ask-tool-1',
      toolName: 'AskUserQuestion',
      status: 'waiting',
    });
  });

  it('reconciles a newly persisted active Peer turn without replacing older history', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 1,
        sessionId: 'history-1',
        timestamp: 2,
        userMessage: { id: 'user-live', content: 'new prompt', timestamp: 2 },
        modelRounds: [],
        startTime: 2,
        status: 'inprogress',
      }],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
    });
    const oldTurn = {
      id: 'turn-old',
      sessionId: 'history-1',
      userMessage: { id: 'user-old', content: 'old prompt', timestamp: 1 },
      modelRounds: [],
      status: 'completed' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [oldTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result).toMatchObject({
      applied: true,
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    });
    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.id),
    ).toEqual(['turn-old', 'turn-live']);
  });

  it('keeps a healthy live projection when it already includes the Runtime cursor', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'keep streaming', timestamp: 1 },
        modelRounds: [],
        startTime: 1,
        status: 'inprogress',
      }],
      runtimeEventSnapshot: {
        sessionId: 'history-1',
        streamId: 'runtime-a',
        cursor: 12,
        activeTurnId: 'turn-live',
        events: [],
      },
      contextRestoreState: 'pending',
    });
    const liveTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'keep streaming', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'live-text',
          type: 'text' as const,
          content: 'already rendered',
          timestamp: 2,
          status: 'streaming' as const,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 2,
      }],
      status: 'processing' as const,
      startTime: 1,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/Users/host/project',
          historyState: 'ready',
          dialogTurns: [liveTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { shouldReplayRuntimeSnapshot: () => false },
    );

    expect(result.runtimeEventReplayRequired).toBe(false);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({ id: 'live-text', content: 'already rendered' });
  });

  it('still returns the Runtime journal when a live update wins the restore race', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockImplementationOnce(async () => {
      flowChatStore.setState(prev => {
        const current = prev.sessions.get('history-1');
        if (!current) {
          return prev;
        }
        return {
          ...prev,
          sessions: new Map([
            ['history-1', {
              ...current,
              currentTokenUsage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                timestamp: 2,
              },
            }],
          ]),
        };
      });
      return {
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
          turnCount: 1,
          createdAt: 1,
        },
        turns: [{
          turnId: 'turn-live',
          turnIndex: 0,
          sessionId: 'history-1',
          timestamp: 1,
          userMessage: { id: 'user-live', content: 'keep streaming', timestamp: 1 },
          modelRounds: [],
          startTime: 1,
          status: 'inprogress',
        }],
        runtimeEventSnapshot: {
          sessionId: 'history-1',
          streamId: 'runtime-a',
          cursor: 20,
          activeTurnId: 'turn-live',
          events: [{
            eventName: 'agentic://text-chunk',
            payload: { sessionId: 'history-1', turnId: 'turn-live', text: 'host' },
          }],
        },
        contextRestoreState: 'pending',
      };
    });
    const liveTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'keep streaming', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'read-readme',
          type: 'tool' as const,
          toolName: 'Read',
          status: 'running' as const,
          timestamp: 2,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 2,
      }],
      status: 'processing' as const,
      startTime: 1,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/Users/host/project',
          historyState: 'ready',
          dialogTurns: [liveTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { shouldReplayRuntimeSnapshot: () => true },
    );

    expect(result.runtimeEventSnapshot).toMatchObject({
      streamId: 'runtime-a',
      cursor: 20,
      activeTurnId: 'turn-live',
    });
    expect(result.runtimeEventReplayRequired).toBe(true);
  });

  it('advances a running Peer turn from a newer persisted checkpoint', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [{
            id: 'host-text-id',
            content: 'partial answer plus checkpoint',
            isStreaming: true,
            timestamp: 3,
            status: 'streaming',
          }],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      contextRestoreState: 'pending',
      isPartial: false,
      loadedTurnCount: 1,
      totalTurnCount: 1,
    });
    const localTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'controller-text-id',
          type: 'text' as const,
          content: 'partial answer',
          isStreaming: true,
          isMarkdown: true,
          timestamp: 2,
          status: 'streaming' as const,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 1,
      }],
      status: 'processing' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [localTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result.applied).toBe(true);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({
      id: 'host-text-id',
      content: 'partial answer plus checkpoint',
    });
  });

  it('does not regress a running Peer turn to an older persisted checkpoint', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [{
            id: 'host-text-id',
            content: 'partial answer',
            isStreaming: true,
            timestamp: 2,
            status: 'streaming',
          }],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      contextRestoreState: 'pending',
      isPartial: false,
      loadedTurnCount: 1,
      totalTurnCount: 1,
    });
    const localTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'controller-text-id',
          type: 'text' as const,
          content: 'partial answer plus live data',
          isStreaming: true,
          isMarkdown: true,
          timestamp: 3,
          status: 'streaming' as const,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 1,
      }],
      status: 'processing' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [localTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result.applied).toBe(false);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({
      id: 'controller-text-id',
      content: 'partial answer plus live data',
    });
  });

  it('clears Peer usage whose source turn is absent even when the running snapshot is unchanged', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [{
            id: 'host-text-id',
            content: 'partial answer',
            isStreaming: true,
            timestamp: 2,
            status: 'streaming',
          }],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'streaming',
        }],
        startTime: 1,
        status: 'inprogress',
      }],
      contextRestoreState: 'pending',
      isPartial: false,
      loadedTurnCount: 1,
      totalTurnCount: 1,
    });
    const localTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
      modelRounds: [{
        id: 'round-live',
        index: 0,
        items: [{
          id: 'controller-text-id',
          type: 'text' as const,
          content: 'partial answer plus live data',
          isStreaming: true,
          isMarkdown: true,
          timestamp: 3,
          status: 'streaming' as const,
        }],
        isStreaming: true,
        isComplete: false,
        status: 'streaming' as const,
        startTime: 1,
      }],
      status: 'processing' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [localTurn],
          currentTokenUsage: {
            inputTokens: 42_000,
            outputTokens: 1_000,
            totalTokens: 43_000,
            timestamp: 3,
            turnId: 'turn-no-longer-visible',
            source: 'model_request',
          },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result.applied).toBe(true);
    const refreshedSession = flowChatStore.getState().sessions.get('history-1');
    expect(refreshedSession?.currentTokenUsage).toBeUndefined();
    expect(refreshedSession?.dialogTurns[0].modelRounds[0].items[0]).toMatchObject({
      id: 'controller-text-id',
      content: 'partial answer plus live data',
    });
  });

  it('replaces stale local usage with authoritative Peer usage for a multi-round turn', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
        modelRounds: [
          {
            id: 'round-1',
            turnId: 'turn-live',
            roundIndex: 0,
            timestamp: 1,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 1,
            status: 'completed',
          },
          {
            id: 'round-2',
            turnId: 'turn-live',
            roundIndex: 1,
            timestamp: 2,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 2,
            status: 'completed',
          },
        ],
        tokenUsage: {
          inputTokens: 90_000,
          outputTokens: 2_000,
          totalTokens: 92_000,
          timestamp: 3,
        },
        startTime: 1,
        endTime: 3,
        status: 'completed',
      }],
      currentContextUsage: {
        inputTokens: 42_000,
        outputTokens: 1_500,
        totalTokens: 43_500,
        timestamp: 4,
        turnId: 'turn-live',
        source: 'model_request',
      },
      contextRestoreState: 'ready',
      isPartial: false,
      loadedTurnCount: 1,
      totalTurnCount: 1,
    });
    const localTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'continue', timestamp: 1 },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        items: [],
        isStreaming: false,
        isComplete: true,
        status: 'completed' as const,
        startTime: 1,
      }],
      status: 'completed' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [localTurn],
          currentTokenUsage: {
            inputTokens: 12_000,
            outputTokens: 500,
            totalTokens: 12_500,
            timestamp: 2,
            turnId: 'turn-live',
            source: 'model_request',
          },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result.applied).toBe(true);
    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toEqual({
      inputTokens: 42_000,
      outputTokens: 1_500,
      totalTokens: 43_500,
      timestamp: 4,
      turnId: 'turn-live',
      source: 'model_request',
    });
  });

  it('replaces a stale running projection after the Peer Host has completed', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        turnId: 'turn-live',
        turnIndex: 0,
        sessionId: 'history-1',
        timestamp: 1,
        userMessage: { id: 'user-live', content: 'finish this', timestamp: 1 },
        modelRounds: [{
          id: 'round-live',
          turnId: 'turn-live',
          roundIndex: 0,
          timestamp: 1,
          textItems: [{
            id: 'text-live',
            content: 'complete answer',
            isStreaming: false,
            timestamp: 2,
            status: 'completed',
          }],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          endTime: 3,
          status: 'completed',
        }],
        startTime: 1,
        endTime: 3,
        status: 'completed',
      }],
      contextRestoreState: 'pending',
      isPartial: false,
      loadedTurnCount: 1,
      totalTurnCount: 1,
    });
    const staleTurn = {
      id: 'turn-live',
      sessionId: 'history-1',
      userMessage: { id: 'user-live', content: 'finish this', timestamp: 1 },
      modelRounds: [],
      status: 'processing' as const,
      startTime: 1,
      backendTurnIndex: 0,
    };
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          dialogTurns: [staleTurn],
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/Users/host/project',
      { replaceRunningSnapshot: false },
    );

    expect(result.applied).toBe(true);
    expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0])
      .toMatchObject({
        status: 'completed',
        modelRounds: [{
          status: 'completed',
          items: [{
            type: 'text',
            content: 'complete answer',
          }],
        }],
      });
  });

  it('loads model config once while processing multiple persisted sessions', async () => {
    configManagerMock.getConfig.mockImplementation(async (path: string) => {
      if (path === 'ai.models') return [{ id: 'primary-model', context_window: 256000 }];
      if (path === 'ai.default_models') return { primary: 'primary-model' };
      return undefined;
    });
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session 1',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
      },
      {
        sessionId: 'history-2',
        title: 'Saved session 2',
        agentType: 'Standard',
        createdAt: 11,
        lastActiveAt: 21,
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    const configPaths = configManagerMock.getConfig.mock.calls.map(([path]) => path);
    expect(configPaths.filter(path => path === 'ai.models')).toHaveLength(1);
    expect(configPaths.filter(path => path === 'ai.default_models')).toHaveLength(1);
    expect(configManagerMock.getConfigs).toHaveBeenCalledWith([
      'ai.models',
      'ai.default_models',
    ]);
    expect(flowChatStore.getState().sessions.get('history-1')?.maxContextTokens).toBe(256000);
    expect(flowChatStore.getState().sessions.get('history-2')?.maxContextTokens).toBe(256000);
  });

  it('skips one bad metadata entry without dropping the rest of the session list', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'bad-1',
        title: 'Bad session',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
      },
      {
        sessionId: 'good-1',
        title: 'Good session',
        agentType: 'Standard',
        createdAt: 11,
        lastActiveAt: 21,
      },
    ]);
    stateMachineManagerMock.getOrCreate.mockImplementation((sessionId: string) => {
      if (sessionId === 'bad-1') {
        throw new Error('bad metadata');
      }
      return {};
    });

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.has('bad-1')).toBe(false);
    expect(flowChatStore.getState().sessions.get('good-1')).toMatchObject({
      sessionId: 'good-1',
      historyState: 'metadata-only',
    });
  });

  it('reuses an in-flight metadata list for the same workspace and remote identity', async () => {
    const sessions = createDeferred<any[]>();
    apiMocks.listSessions.mockReturnValueOnce(sessions.promise);

    const firstLoad = flowChatStore.initializeFromDisk(
      'D:/workspace/OpenBitFun',
      undefined,
      undefined,
      'first-source'
    );
    const secondLoad = flowChatStore.initializeFromDisk(
      'D:/workspace/OpenBitFun',
      undefined,
      undefined,
      'second-source'
    );

    await vi.waitFor(() => {
      expect(apiMocks.listSessions).toHaveBeenCalledTimes(1);
    });

    sessions.resolve([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
      },
    ]);

    await Promise.all([firstLoad, secondLoad]);

    expect(apiMocks.listSessions).toHaveBeenCalledTimes(1);
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      sessionId: 'history-1',
      historyState: 'metadata-only',
    });
  });

  it('reuses a recently completed metadata list for the same workspace', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        createdAt: 10,
        lastActiveAt: 20,
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun', undefined, undefined, 'first-source');
    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun', undefined, undefined, 'second-source');

    expect(apiMocks.listSessions).toHaveBeenCalledTimes(1);
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      sessionId: 'history-1',
      historyState: 'metadata-only',
    });
  });

  it('loads a paged metadata slice without requesting the full session list', async () => {
    apiMocks.listSessionsPage.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'history-1',
          title: 'Saved session',
          agentType: 'Standard',
          modelName: 'primary',
          createdAt: 10,
          lastActiveAt: 20,
          workspaceHostname: 'localhost',
        },
      ],
      totalTopLevelCount: 12,
      loadedTopLevelCount: 5,
      nextCursor: '5',
      hasMore: true,
    });

    const page = await flowChatStore.loadSessionMetadataPage(
      'D:/workspace/OpenBitFun',
      5,
      undefined,
      undefined,
      undefined,
      'nav_initial'
    );

    expect(apiMocks.listSessions).not.toHaveBeenCalled();
    expect(apiMocks.listSessionsPage).toHaveBeenCalledWith({
      workspacePath: 'D:/workspace/OpenBitFun',
      limit: 5,
      cursor: undefined,
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
    });
    expect(page).toMatchObject({
      totalTopLevelCount: 12,
      nextCursor: '5',
      hasMore: true,
    });
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      sessionId: 'history-1',
      historyState: 'metadata-only',
      workspaceHostname: 'localhost',
    });
    expect(flowChatStore.getState().sessions.get('history-1')?.remoteSshHost).toBeUndefined();
  });

  it('starts model config lookup while a paged metadata request is in flight', async () => {
    const events: string[] = [];
    const page = createDeferred<{
      sessions: any[];
      totalTopLevelCount: number;
      loadedTopLevelCount: number;
      nextCursor?: string;
      hasMore: boolean;
    }>();
    apiMocks.listSessionsPage.mockImplementationOnce(() => {
      events.push('page-request-start');
      return page.promise;
    });
    configManagerMock.getConfigs.mockImplementationOnce(async () => {
      events.push('model-config-start');
      return {
        'ai.models': [],
        'ai.default_models': {},
      };
    });

    const load = flowChatStore.loadSessionMetadataPage(
      'D:/workspace/OpenBitFun',
      5,
      undefined,
      undefined,
      undefined,
      'nav_initial'
    );

    await vi.waitFor(() => {
      expect(apiMocks.listSessionsPage).toHaveBeenCalledTimes(1);
    });
    await flushAsyncWork();

    expect(events).toContain('page-request-start');
    expect(events).toContain('model-config-start');

    page.resolve({
      sessions: [],
      totalTopLevelCount: 0,
      loadedTopLevelCount: 0,
      hasMore: false,
    });
    await load;
  });

  it('marks historical sessions hydrating while turns are loading and ready after completion', async () => {
    const turns = createDeferred<any[]>();
    apiMocks.restoreSessionView.mockImplementationOnce(async () => ({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: await turns.promise,
      contextRestoreState: 'pending',
    }));
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    const load = flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    await vi.waitFor(() => {
      expect(flowChatStore.getState().sessions.get('history-1')?.historyState).toBe('hydrating');
    });

    turns.resolve([]);
    await load;

    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      dialogTurns: [],
    });
  });

  it('never sends a dispatch observer projection through local history restore', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['session-1', createSession({
          sessionId: 'session-1',
          isHistorical: true,
          historyState: 'metadata-only',
          config: {
            agentType: 'Standard',
            dispatchTarget: {
              kind: 'ssh',
              connectionId: 'ssh-1',
              workspacePath: '/target',
              displayName: 'build-host',
            },
            dispatchJobId: 'job-1',
          },
        })],
      ]),
      activeSessionId: 'session-1',
    }));

    await flowChatStore.loadSessionHistory('session-1', '/source');

    expect(apiMocks.restoreSessionView).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(apiMocks.restoreSession).not.toHaveBeenCalled();
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('session-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
    });
  });

  it('preserves a dispatch transcript when an earlier local restore resolves late', async () => {
    const restore = createDeferred<{
      session: {
        sessionId: string;
        sessionName: string;
        agentType: string;
        state: string;
        turnCount: number;
        createdAt: number;
      };
      turns: any[];
      contextRestoreState: 'pending';
    }>();
    apiMocks.restoreSessionView.mockReturnValueOnce(restore.promise);
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['session-1', createSession({
          sessionId: 'session-1',
          workspacePath: '/source',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'session-1',
    }));

    const load = flowChatStore.loadSessionHistory('session-1', '/source');
    await vi.waitFor(() => {
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    });

    flowChatStore.updateSessionDispatchTarget('session-1', {
      targetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target',
      },
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target',
        displayName: 'build-host',
      },
      jobId: 'job-1',
      approvalPolicy: 'reject-and-report',
      cursor: 120,
      sourceWorkspacePath: '/source',
    });
    expect(flowChatStore.hydrateDispatchTranscript('session-1', [{
      id: 'turn-cached',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-cached',
        content: 'run task',
        timestamp: 1,
      },
      modelRounds: [{
        id: 'round-cached',
        index: 0,
        items: [{
          id: 'text-cached',
          type: 'text',
          content: 'cached body',
          status: 'completed',
          isStreaming: false,
          timestamp: 2,
        }],
        isStreaming: false,
        isComplete: true,
        status: 'completed',
        startTime: 1,
        endTime: 2,
      }],
      status: 'completed',
      startTime: 1,
      endTime: 2,
    } as any])).toBe(true);

    restore.resolve({
      session: {
        sessionId: 'session-1',
        sessionName: 'Saved local shell',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: [],
      contextRestoreState: 'pending',
    });
    await load;

    expect(flowChatStore.getState().sessions.get('session-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
      dialogTurns: [{
        id: 'turn-cached',
        modelRounds: [{ items: [{ content: 'cached body' }] }],
      }],
    });
    expect(stateMachineManagerMock.getOrCreate).not.toHaveBeenCalled();
    expect(stateMachineManagerMock.reset).not.toHaveBeenCalled();
  });

  it('merges restored model and reasoning selections into an existing subagent shell', async () => {
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'subagent-1',
        sessionName: 'Subagent 1',
        agentType: 'Explore',
        modelName: 'model-subagent',
        reasoningPreset: 'high',
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: [],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['subagent-1', createSession({
          sessionId: 'subagent-1',
          sessionKind: 'subagent',
          mode: 'Explore',
          config: { agentType: 'Explore' },
          workspacePath: 'D:/workspace/OpenBitFun',
        })],
      ]),
      activeSessionId: 'parent-1',
    }));

    await flowChatStore.loadSessionHistory(
      'subagent-1',
      'D:/workspace/OpenBitFun',
      undefined,
      undefined,
      undefined,
      { includeInternal: true },
    );

    expect(flowChatStore.getState().sessions.get('subagent-1')?.config.modelName)
      .toBe('model-subagent');
    expect(flowChatStore.getState().sessions.get('subagent-1')?.config.reasoningPreset)
      .toBe('high');
  });

  it('normalizes a restored null reasoning preset to Auto', async () => {
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'subagent-auto',
        sessionName: 'Subagent Auto',
        agentType: 'Explore',
        modelName: 'model-subagent',
        reasoningPreset: null,
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: [],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['subagent-auto', createSession({
          sessionId: 'subagent-auto',
          sessionKind: 'subagent',
          mode: 'Explore',
          config: { agentType: 'Explore', reasoningPreset: 'high' },
          workspacePath: 'D:/workspace/OpenBitFun',
        })],
      ]),
      activeSessionId: 'parent-1',
    }));

    await flowChatStore.loadSessionHistory(
      'subagent-auto',
      'D:/workspace/OpenBitFun',
      undefined,
      undefined,
      undefined,
      { includeInternal: true },
    );

    expect(flowChatStore.getState().sessions.get('subagent-auto')?.config.reasoningPreset)
      .toBeUndefined();
  });

  it('starts backend restore before notifying hydrating state', async () => {
    const events: string[] = [];
    const restore = createDeferred<{
      session: {
        sessionId: string;
        sessionName: string;
        agentType: string;
        state: string;
        turnCount: number;
        createdAt: number;
      };
      turns: any[];
      contextRestoreState: 'pending';
    }>();
    apiMocks.restoreSessionView.mockImplementationOnce(() => {
      events.push('restore-start');
      return restore.promise;
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));
    const unsubscribe = flowChatStore.subscribe(state => {
      if (state.sessions.get('history-1')?.historyState === 'hydrating') {
        events.push('hydrating-notified');
      }
    });

    try {
      const load = flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
      await vi.waitFor(() => {
        expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      });

      expect(events).toEqual(['restore-start', 'hydrating-notified']);

      restore.resolve({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 0,
          createdAt: 1,
        },
        turns: [],
        contextRestoreState: 'pending',
      });
      await load;
    } finally {
      unsubscribe();
    }
  });

  it('keeps active deferred metadata-only sessions stable while initial restore is pending', async () => {
    const restore = createDeferred<{
      session: {
        sessionId: string;
        sessionName: string;
        agentType: string;
        state: string;
        turnCount: number;
        createdAt: number;
      };
      turns: any[];
      contextRestoreState: 'pending';
    }>();
    const observedStates: string[] = [];
    apiMocks.restoreSessionView.mockReturnValueOnce(restore.promise);
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));
    const unsubscribe = flowChatStore.subscribe(state => {
      observedStates.push(state.sessions.get('history-1')?.historyState ?? 'missing');
    });

    try {
      const load = flowChatStore.loadSessionHistory(
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        undefined,
        { deferFullHistoryUntilActive: true },
      );
      await vi.waitFor(() => {
        expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      });

      expect(flowChatStore.getState().sessions.get('history-1')?.historyState).toBe('metadata-only');
      expect(observedStates).not.toContain('hydrating');

      restore.resolve({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 0,
          createdAt: 1,
        },
        turns: [],
        contextRestoreState: 'pending',
      });
      await load;

      expect(flowChatStore.getState().sessions.get('history-1')?.historyState).toBe('ready');
    } finally {
      unsubscribe();
    }
  });

  it('marks historical sessions failed when hydrate fails', async () => {
    apiMocks.restoreSessionView.mockRejectedValueOnce(new Error('restore failed'));
    apiMocks.loadSessionTurns.mockRejectedValueOnce(new Error('turn load failed'));
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await expect(
      flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun')
    ).rejects.toThrow('turn load failed');

    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: true,
      historyState: 'failed',
    });
  });

  it('does not change the active session when an older hydrate completes', async () => {
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 0,
        createdAt: 1,
      },
      turns: [],
      contextRestoreState: 'pending',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-2',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().activeSessionId).toBe('history-2');
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
    });
  });

  it('does not restore ACP historical sessions through the normal backend path', async () => {
    apiMocks.loadSessionTurns.mockResolvedValueOnce([]);
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['acp-1', createSession({
          sessionId: 'acp-1',
          isHistorical: true,
          historyState: 'metadata-only',
          mode: 'acp:test',
          config: { agentType: 'acp:test' },
        })],
      ]),
      activeSessionId: 'acp-1',
    }));

    await flowChatStore.loadSessionHistory('acp-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSession).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionView).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
  });

  it('uses view-restored turns without reading the turn files a second time', async () => {
    const visibleOutput = 'complete visible output '.repeat(64);
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [
        {
          id: 'round-1',
          turnId: 'turn-1',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [
            {
              id: 'tool-1',
              toolName: 'ExecCommand',
              toolCall: { id: 'call-1', input: { command: 'printf output' } },
              toolResult: {
                result: {
                  stdout: visibleOutput,
                  nested: { stderr: 'also visible' },
                },
                success: true,
                durationMs: 1,
              },
              startTime: 1,
              endTime: 2,
              durationMs: 1,
              status: 'completed',
            },
          ],
          thinkingItems: [],
          startTime: 1,
          endTime: 2,
          durationMs: 1,
          status: 'completed',
        },
      ],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn],
      contextRestoreState: 'pending',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
    });
    const toolItem = flowChatStore
      .getState()
      .sessions.get('history-1')
      ?.dialogTurns[0]
      ?.modelRounds[0]
      ?.items.find(item => item.type === 'tool') as any;
    expect(toolItem?.toolResult?.result?.stdout).toBe(visibleOutput);
    expect(toolItem?.toolResult?.result?.nested?.stderr).toBe('also visible');
    expect(toolItem?.toolResult?.resultForAssistant).toBeUndefined();
  });

  it('renders tail-restored turns before completing partial history in background', async () => {
    vi.useFakeTimers();
    const olderTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [olderTurn, latestTurn],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      expect(apiMocks.restoreSessionView).toHaveBeenNthCalledWith(
        1,
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        expect.any(String),
        undefined,
        3,
      );
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['latest prompt']);
      expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      });
      const partialLatestTurnRef = flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0];
      expect(partialLatestTurnRef).toBeDefined();
      flowChatStore.setSessionContextRestoreState('history-1', 'ready');
      flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1');

      await advanceReleasedLocalFullHistoryCompletion();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(apiMocks.restoreSessionView).toHaveBeenNthCalledWith(
        2,
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        expect.stringContaining('full'),
        undefined,
        undefined,
      );
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['latest prompt']);

      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'test')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt']);
      expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns[1]).toBe(partialLatestTurnRef);
      expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        contextRestoreState: 'ready',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepends full history without dropping turns added after partial restore', async () => {
    vi.useFakeTimers();
    const olderTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [olderTurn, latestTurn],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

      const newTurn = {
        id: 'turn-3',
        sessionId: 'history-1',
        userMessage: { id: 'user-3', content: 'new prompt', timestamp: 3 },
        modelRounds: [],
        status: 'processing',
        startTime: 3,
      } as any;
      flowChatStore.addDialogTurn('history-1', newTurn);

      flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1');
      await advanceReleasedLocalFullHistoryCompletion();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);
      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'test')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt', 'new prompt']);
      expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns[2]).toBe(newTurn);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips automatic full hydration for catalog-capable restores and hydrates on demand', async () => {
    vi.useFakeTimers();
    const turnData = (turnIndex: number) => ({
      turnId: `turn-${turnIndex}`,
      turnIndex: turnIndex - 1,
      sessionId: 'history-1',
      timestamp: turnIndex,
      userMessage: { id: `user-${turnIndex}`, content: `prompt ${turnIndex}`, timestamp: turnIndex },
      modelRounds: [],
      startTime: turnIndex,
      status: 'completed',
    });
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 5,
          createdAt: 1,
        },
        turns: [turnData(5)],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 5,
        turnCatalog: {
          schemaVersion: 1,
          sessionId: 'history-1',
          revision: 'partial-catalog',
          totalTurnCount: 5,
          complete: false,
          entries: Array.from({ length: 5 }, (_, ordinal) => ({
            ordinal,
            storageTurnIndex: ordinal,
            ...(ordinal === 4 ? { turnId: 'turn-5', preview: 'prompt 5' } : {}),
            previewTruncated: false,
          })),
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 5,
          createdAt: 1,
        },
        turns: [turnData(1), turnData(2), turnData(3), turnData(4), turnData(5)],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 5,
        totalTurnCount: 5,
        turnCatalog: {
          schemaVersion: 1,
          sessionId: 'history-1',
          revision: 'complete-catalog',
          totalTurnCount: 5,
          complete: true,
          entries: Array.from({ length: 5 }, (_, ordinal) => ({
            ordinal,
            storageTurnIndex: ordinal,
            turnId: `turn-${ordinal + 1}`,
            preview: `prompt ${ordinal + 1}`,
            previewTruncated: false,
          })),
        },
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(false);
      expect(flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1')).toBe(false);
      await vi.runOnlyPendingTimersAsync();
      await flushAsyncWork();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(false);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.id)
      ).toEqual(['turn-5']);
      expect(flowChatStore.getState().sessions.get('history-1')?.turnCatalog).toMatchObject({
        revision: 'partial-catalog',
        complete: false,
        totalTurnCount: 5,
      });

      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'search')).toBe(true);
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.id)
      ).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
      expect(flowChatStore.getState().sessions.get('history-1')?.turnCatalog).toMatchObject({
        revision: 'complete-catalog',
        complete: true,
        totalTurnCount: 5,
      });
      expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        isPartial: false,
        loadedTurnCount: 5,
        totalTurnCount: 5,
      });
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips committing stale local history hydrate when switching away before restore finishes', async () => {
    vi.useFakeTimers();
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    const partialRestore = createDeferred<any>();
    apiMocks.restoreSessionView.mockReturnValueOnce(partialRestore.promise);
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      const load = flowChatStore.loadSessionHistory(
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        undefined,
        { deferFullHistoryUntilActive: true },
      );
      await flushAsyncWork();

      flowChatStore.switchSession('history-2');
      partialRestore.resolve({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      });
      await load;

      expect(flowChatStore.getState().activeSessionId).toBe('history-2');
      expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        isHistorical: true,
        historyState: 'metadata-only',
        dialogTurns: [],
      });
      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(false);

      await vi.runOnlyPendingTimersAsync();
      await flushAsyncWork();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules deferred full history completion when switching back to a partial session', async () => {
    vi.useFakeTimers();
    const latestTurn = {
      id: 'turn-2',
      sessionId: 'history-1',
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    } as any;
    const olderTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [olderTurn, {
        turnId: 'turn-2',
        turnIndex: 1,
        sessionId: 'history-1',
        timestamp: 2,
        userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
        modelRounds: [],
        startTime: 2,
        status: 'completed',
      }],
      contextRestoreState: 'pending',
      isPartial: false,
      loadedTurnCount: 2,
      totalTurnCount: 2,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: false,
          historyState: 'ready',
          isPartial: true,
          loadedTurnCount: 1,
          totalTurnCount: 2,
          contextRestoreState: 'pending',
          dialogTurns: [latestTurn],
          workspacePath: 'D:/workspace/OpenBitFun',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-2',
    }));

    try {
      flowChatStore.switchSession('history-1');

      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
      flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1');
      await advanceReleasedLocalFullHistoryCompletion();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);
      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'test')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt']);
      expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending full history completion for the previous active session', async () => {
    vi.useFakeTimers();
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [latestTurn],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory(
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        undefined,
        { deferFullHistoryUntilActive: true },
      );

      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
      flowChatStore.switchSession('history-2');
      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(false);

      await vi.runOnlyPendingTimersAsync();
      await flushAsyncWork();

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending and deferred full history state when removing sessions for a workspace', () => {
    const cancelPending = vi.fn();
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspaceId: 'workspace-1',
          workspacePath: 'D:/workspace/OpenBitFun',
          isHistorical: true,
          historyState: 'ready',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    ((flowChatStore as any).fullHistoryHydrationRequests as Map<string, unknown>).set('pending-history-1', {
      surfaceId: LOCAL_SURFACE_ID,
      sessionId: 'history-1',
      remote: false,
      requireActiveSession: true,
      sessionTraceId: 'trace-1',
      promise: Promise.resolve(),
      cancel: cancelPending,
    });
    ((flowChatStore as any).deferredFullHistoryProjections as Map<string, unknown>).set('history-1', {
      remote: false,
      requireActiveSession: true,
      expectedDialogTurnIds: [],
      dialogTurns: [],
      contextRestoreState: 'ready',
    });
    ((flowChatStore as any).fullHistoryProjectionApplyRequests as Set<string>).add('history-1');

    expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
    expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);

    expect(flowChatStore.removeSessionsForWorkspace({
      id: 'workspace-1',
      rootPath: 'D:/workspace/OpenBitFun',
      connectionId: null,
      sshHost: null,
    })).toEqual(['history-1']);

    expect(cancelPending).toHaveBeenCalledTimes(1);
    expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(false);
    expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(false);
    expect((flowChatStore as any).fullHistoryProjectionApplyRequests.has('history-1')).toBe(false);
  });

  it('keeps explicit inactive local history completion for auxiliary session views', async () => {
    vi.useFakeTimers();
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [latestTurn],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: false,
          historyState: 'ready',
        })],
      ]),
      activeSessionId: 'history-2',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
      flowChatStore.switchSession('history-2');
      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel active full history completion when switching to a missing session', async () => {
    vi.useFakeTimers();
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [latestTurn],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory(
        'history-1',
        'D:/workspace/OpenBitFun',
        undefined,
        undefined,
        undefined,
        { deferFullHistoryUntilActive: true },
      );

      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
      flowChatStore.switchSession('missing-session');
      expect(flowChatStore.hasPendingSessionHistoryCompletion('history-1')).toBe(true);
      expect(flowChatStore.getState().activeSessionId).toBe('history-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps remote partial restore on the smaller compatibility tail', async () => {
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-remote',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-remote',
        sessionName: 'Remote History',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [latestTurn],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-remote', createSession({
          sessionId: 'history-remote',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-remote',
    }));

    await flowChatStore.loadSessionHistory(
      'history-remote',
      '/remote/workspace',
      undefined,
      'remote-1',
      'remote.example'
    );

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSessionView).toHaveBeenNthCalledWith(
      1,
      'history-remote',
      '/remote/workspace',
      'remote-1',
      'remote.example',
      expect.any(String),
      undefined,
      3,
    );
  });

  it('lets an explicit full-history consumer bypass remote idle deferral', async () => {
    vi.useFakeTimers();
    let idleCallback: (() => void) | null = null;
    const originalRequestIdleCallback = (globalThis as any).requestIdleCallback;
    const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback;
    (globalThis as any).requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 1;
    });
    (globalThis as any).cancelIdleCallback = vi.fn();

    const olderTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-remote',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-remote',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-remote',
          sessionName: 'Remote History',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-remote',
          sessionName: 'Remote History',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [olderTurn, latestTurn],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-remote', createSession({
          sessionId: 'history-remote',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-remote',
    }));

    try {
      await flowChatStore.loadSessionHistory(
        'history-remote',
        '/remote/workspace',
        undefined,
        'remote-1',
        'remote.example'
      );

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      expect(idleCallback).toBeTypeOf('function');
      const hydrationPromise = Array.from(
        ((flowChatStore as any).fullHistoryHydrationRequests as Map<string, { promise: Promise<void> }>).values()
      )[0]?.promise;
      expect(hydrationPromise).toBeInstanceOf(Promise);

      expect(flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-remote', {
        immediate: true,
        reason: 'test',
      })).toBe(false);
      expect(await flowChatStore.ensureSessionFullHistory(
        'history-remote',
        'search-before-idle',
      )).toBe(true);
      await hydrationPromise;

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-remote')).toBe(false);
      expect(
        flowChatStore.getState().sessions.get('history-remote')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt']);
      expect(flowChatStore.getState().sessions.get('history-remote')?.isPartial).toBe(false);

      idleCallback?.();
      await flushAsyncWork();
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
    } finally {
      (globalThis as any).requestIdleCallback = originalRequestIdleCallback;
      (globalThis as any).cancelIdleCallback = originalCancelIdleCallback;
      vi.useRealTimers();
    }
  });

  it('waits for initial paint and browser idle before completing partial history in background', async () => {
    vi.useFakeTimers();
    let idleCallback: (() => void) | null = null;
    const originalRequestIdleCallback = (globalThis as any).requestIdleCallback;
    const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback;
    (globalThis as any).requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 1;
    });
    (globalThis as any).cancelIdleCallback = vi.fn();

    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [
          {
            ...latestTurn,
            turnId: 'turn-1',
            turnIndex: 0,
            userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
          },
          latestTurn,
        ],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await flushAsyncWork();
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      expect(idleCallback).toBeNull();

      flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1');

      expect(idleCallback).toBeTypeOf('function');
      const hydrationPromise = Array.from(
        ((flowChatStore as any).fullHistoryHydrationRequests as Map<string, { promise: Promise<void> }>).values()
      )[0]?.promise;
      expect(hydrationPromise).toBeInstanceOf(Promise);
      idleCallback?.();
      await hydrationPromise;

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['latest prompt']);
      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'test')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt']);
    } finally {
      (globalThis as any).requestIdleCallback = originalRequestIdleCallback;
      (globalThis as any).cancelIdleCallback = originalCancelIdleCallback;
      vi.useRealTimers();
    }
  });

  it('delays partial history completion when idle callback is unavailable', async () => {
    vi.useFakeTimers();
    const originalRequestIdleCallback = (globalThis as any).requestIdleCallback;
    const originalCancelIdleCallback = (globalThis as any).cancelIdleCallback;
    delete (globalThis as any).requestIdleCallback;
    delete (globalThis as any).cancelIdleCallback;

    const latestTurn = {
      turnId: 'turn-2',
      turnIndex: 1,
      sessionId: 'history-1',
      timestamp: 2,
      userMessage: { id: 'user-2', content: 'latest prompt', timestamp: 2 },
      modelRounds: [],
      startTime: 2,
      status: 'completed',
    };
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [latestTurn],
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 1,
        totalTurnCount: 2,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 2,
          createdAt: 1,
        },
        turns: [
          {
            ...latestTurn,
            turnId: 'turn-1',
            turnIndex: 0,
            userMessage: { id: 'user-1', content: 'older prompt', timestamp: 1 },
          },
          latestTurn,
        ],
        contextRestoreState: 'pending',
        isPartial: false,
        loadedTurnCount: 2,
        totalTurnCount: 2,
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    try {
      await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2499);
      await flushAsyncWork();
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);

      flowChatStore.releaseSessionHistoryCompletionAfterInitialPaint('history-1');

      await vi.advanceTimersByTimeAsync(1499);
      await flushAsyncWork();
      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);

      const hydrationPromise = Array.from(
        ((flowChatStore as any).fullHistoryHydrationRequests as Map<string, { promise: Promise<void> }>).values()
      )[0]?.promise;
      expect(hydrationPromise).toBeInstanceOf(Promise);

      await vi.advanceTimersByTimeAsync(1);
      await flushAsyncWork();
      await hydrationPromise;

      expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
      expect(flowChatStore.hasDeferredSessionHistoryProjection('history-1')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['latest prompt']);
      expect(await flowChatStore.ensureSessionFullHistory('history-1', 'test')).toBe(true);
      expect(
        flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.userMessage.content)
      ).toEqual(['older prompt', 'latest prompt']);
    } finally {
      (globalThis as any).requestIdleCallback = originalRequestIdleCallback;
      (globalThis as any).cancelIdleCallback = originalCancelIdleCallback;
      vi.useRealTimers();
    }
  });

  it('falls back to restoreSessionWithTurns when view restore is unavailable', async () => {
    (apiMocks as any).restoreSessionView = undefined;
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionWithTurns.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionWithTurns).toHaveBeenCalledTimes(1);
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
    });
  });

  it('falls back to restoreSessionWithTurns when the view restore command is unavailable on the backend', async () => {
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockRejectedValueOnce(
      new Error('unknown command restore_session_view')
    );
    apiMocks.restoreSessionWithTurns.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSessionWithTurns).toHaveBeenCalledTimes(1);
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
    });
  });

  it('does not retry an unsupported view restore command for later sessions in the same runtime', async () => {
    const restoredTurn = (sessionId: string) => ({
      turnId: `${sessionId}-turn-1`,
      turnIndex: 0,
      sessionId,
      timestamp: 1,
      userMessage: { id: `${sessionId}-user-1`, content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    });
    apiMocks.restoreSessionView.mockRejectedValueOnce(
      new Error('unknown command restore_session_view')
    );
    apiMocks.restoreSessionWithTurns
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 1,
          createdAt: 1,
        },
        turns: [restoredTurn('history-1')],
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-2',
          sessionName: 'History 2',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 1,
          createdAt: 1,
        },
        turns: [restoredTurn('history-2')],
      });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    await flowChatStore.loadSessionHistory('history-2', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSessionWithTurns).toHaveBeenCalledTimes(2);
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
  });

  it('scopes unsupported restore command caching by remote identity', async () => {
    const restoredTurn = (sessionId: string) => ({
      turnId: `${sessionId}-turn-1`,
      turnIndex: 0,
      sessionId,
      timestamp: 1,
      userMessage: { id: `${sessionId}-user-1`, content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    });
    apiMocks.restoreSessionView
      .mockRejectedValueOnce(new Error('unknown command restore_session_view'))
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-2',
          sessionName: 'History 2',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 1,
          createdAt: 1,
        },
        turns: [restoredTurn('history-2')],
        contextRestoreState: 'pending',
      });
    apiMocks.restoreSessionWithTurns.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn('history-1')],
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['history-2', createSession({
          sessionId: 'history-2',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory(
      'history-1',
      '/remote/workspace',
      undefined,
      'remote-1',
      'old.example'
    );
    await flowChatStore.loadSessionHistory('history-2', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(2);
    expect(apiMocks.restoreSessionWithTurns).toHaveBeenCalledTimes(1);
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
  });

  it('falls back to legacy restore and turn loading when restoreSessionWithTurns is unavailable on the backend', async () => {
    (apiMocks as any).restoreSessionView = undefined;
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionWithTurns.mockRejectedValueOnce(
      new Error('unknown command restore_session_with_turns')
    );
    apiMocks.restoreSession.mockResolvedValueOnce({
      sessionId: 'history-1',
      sessionName: 'History 1',
      agentType: 'Standard',
      state: 'Idle',
      turnCount: 1,
      createdAt: 1,
    });
    apiMocks.loadSessionTurns.mockResolvedValueOnce([restoredTurn]);
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionWithTurns).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.loadSessionTurns).toHaveBeenCalledTimes(1);
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
      dialogTurns: expect.arrayContaining([
        expect.objectContaining({ id: 'turn-1' }),
      ]),
    });
  });

  it('uses view restore when available and marks backend context pending', async () => {
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      finishReason: 'max_rounds',
      hasFinalResponse: false,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn],
      contextRestoreState: 'pending',
      turnCatalog: {
        schemaVersion: 1,
        sessionId: 'history-1',
        revision: 'catalog-1',
        totalTurnCount: 1,
        complete: true,
        entries: [{
          ordinal: 0,
          storageTurnIndex: 0,
          turnId: 'turn-1',
          preview: 'hello',
          previewTruncated: false,
        }],
      },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      turnCatalog: expect.objectContaining({
        revision: 'catalog-1',
        complete: true,
      }),
      dialogTurns: expect.arrayContaining([
        expect.objectContaining({
          id: 'turn-1',
          finishReason: 'max_rounds',
          hasFinalResponse: false,
        }),
      ]),
    });
  });

  it('records scalar restore timing fields for historical session diagnostics', async () => {
    resetStartupTraceEventsForTest();
    const restoredTurn = {
      turnId: 'turn-1',
      turnIndex: 0,
      sessionId: 'history-1',
      timestamp: 1,
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      startTime: 1,
      status: 'completed',
    };
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [restoredTurn],
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 2,
      timings: {
        resolveStoragePathDurationMs: 1,
        visibilityMetadataDurationMs: 2,
        loadSessionWithTurnsDurationMs: 37,
        normalizeTurnIdsDurationMs: 4,
        totalDurationMs: 44,
        turnLoad: {
          requestedTailTurnCount: 3,
          loadedTurnCount: 1,
          totalTurnCount: 2,
          turnFileCount: 2,
          missingTurnFileCount: 0,
          fastPath: false,
          metadataDurationMs: 5,
          stateDurationMs: 6,
          scanDurationMs: 7,
          readDurationMs: 8,
          maxTurnReadDurationMs: 9,
          buildSessionDurationMs: 10,
          totalDurationMs: 36,
        },
      },
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    const restoreEvent = startupTrace.getSnapshot().phases.events
      .find(event =>
        event.phase === 'historical_session_restore_end' &&
        event.sessionId === 'history-1' &&
        event.restoreTotalDurationMs === 44
      );
    expect(restoreEvent).toMatchObject({
      restoreTotalDurationMs: 44,
      restoreLoadSessionWithTurnsDurationMs: 37,
      restoreTurnReadDurationMs: 8,
      restoreTurnMaxReadDurationMs: 9,
      restoreTurnLoadedCount: 1,
      restoreTurnTotalCount: 2,
      restoreTurnFastPath: false,
    });
  });

  it('seeds the restored tail, deduplicates target loads, and merges adjacent ranges', async () => {
    const catalog = createTurnCatalog(15);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 15,
        createdAt: 1,
      },
      turns: [12, 13, 14].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 15,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        }),
      ]]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges).toMatchObject([{
      startOrdinal: 12,
      endOrdinalExclusive: 15,
      source: 'initial-tail',
    }]);

    const deferred = createDeferred<any>();
    apiMocks.loadSessionTurnWindow.mockReturnValueOnce(deferred.promise);
    const firstLoad = flowChatStore.loadSessionTurnWindow('history-1', 3);
    const duplicateLoad = flowChatStore.loadSessionTurnWindow('history-1', 3);
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenCalledTimes(1);
    deferred.resolve({
      status: 'ready',
      catalogRevision: catalog.revision,
      totalTurnCount: 15,
      startOrdinal: 0,
      endOrdinalExclusive: 12,
      targetTurnId: 'turn-3',
      turns: Array.from({ length: 12 }, (_, index) => createPersistedTurn(index)),
    });

    const [firstResult, duplicateResult] = await Promise.all([firstLoad, duplicateLoad]);
    expect(firstResult).toMatchObject({ status: 'ready', cacheHit: false, isCurrent: true });
    expect(duplicateResult).toMatchObject({ status: 'ready', cacheHit: false, isCurrent: true });
    const historyView = flowChatStore.getSessionHistoryViewState('history-1');
    expect(historyView?.loadedRanges).toHaveLength(1);
    expect(historyView?.loadedRanges[0]).toMatchObject({
      startOrdinal: 0,
      endOrdinalExclusive: 15,
    });
    expect(historyView?.loadedRanges[0].turns).toHaveLength(15);
    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns.map(turn => turn.id),
    ).toEqual(['turn-12', 'turn-13', 'turn-14']);
  });

  it('discards cached history windows when an authoritative restore changes the catalog', async () => {
    const beforeCatalog = createTurnCatalog(8, 'catalog-before');
    const afterCatalog = createTurnCatalog(6, 'catalog-after');
    apiMocks.restoreSessionView
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 8,
          createdAt: 1,
        },
        turns: [5, 6, 7].map(index => createPersistedTurn(index)),
        turnCatalog: beforeCatalog,
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 3,
        totalTurnCount: 8,
      })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'history-1',
          sessionName: 'History 1',
          agentType: 'Standard',
          state: 'Idle',
          turnCount: 6,
          createdAt: 1,
        },
        turns: [3, 4, 5].map(index => createPersistedTurn(index)),
        turnCatalog: afterCatalog,
        contextRestoreState: 'pending',
        isPartial: true,
        loadedTurnCount: 3,
        totalTurnCount: 6,
      });
    apiMocks.loadSessionTurnWindow.mockResolvedValueOnce({
      status: 'ready',
      catalogRevision: beforeCatalog.revision,
      totalTurnCount: 8,
      startOrdinal: 0,
      endOrdinalExclusive: 8,
      targetTurnId: 'turn-0',
      turns: Array.from({ length: 8 }, (_, index) => createPersistedTurn(index)),
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        }),
      ]]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    const loaded = await flowChatStore.loadSessionTurnWindow('history-1', 0, {
      source: 'target',
    });
    expect(loaded.status).toBe('ready');
    expect(flowChatStore.activateSessionHistoryWindow(
      'history-1',
      0,
      loaded.navigationGeneration,
    )?.range).toMatchObject({ startOrdinal: 0, endOrdinalExclusive: 8 });

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getSessionHistoryViewState('history-1')).toMatchObject({
      catalog: { revision: 'catalog-after', totalTurnCount: 6 },
      activeRange: null,
      pendingTargetOrdinal: null,
      loadedRanges: [{
        startOrdinal: 3,
        endOrdinalExclusive: 6,
        turns: [
          expect.objectContaining({ id: 'turn-3' }),
          expect.objectContaining({ id: 'turn-4' }),
          expect.objectContaining({ id: 'turn-5' }),
        ],
      }],
    });
  });

  it('activates an adjacent catalog window from the restored tail without hydrating the session', async () => {
    const catalog = createTurnCatalog(15);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 15,
        createdAt: 1,
      },
      turns: [12, 13, 14].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 15,
    });
    apiMocks.loadSessionTurnWindow.mockResolvedValueOnce({
      status: 'ready',
      catalogRevision: catalog.revision,
      totalTurnCount: 15,
      startOrdinal: 0,
      endOrdinalExclusive: 12,
      targetTurnId: 'turn-11',
      turns: Array.from({ length: 12 }, (_, index) => createPersistedTurn(index)),
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        }),
      ]]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    expect(flowChatStore.getSessionCanonicalTailRange('history-1')).toEqual({
      startOrdinal: 12,
      endOrdinalExclusive: 15,
    });
    const loaded = await flowChatStore.loadSessionTurnWindow('history-1', 11, {
      source: 'prefetch',
      before: 12,
      after: 1,
    });
    expect(loaded).toMatchObject({ status: 'ready', isCurrent: true });

    const presentation = flowChatStore.activateSessionHistoryWindowFromTail('history-1', 11);
    expect(presentation?.range).toMatchObject({
      startOrdinal: 0,
      endOrdinalExclusive: 15,
      targetTurnId: null,
      mode: 'history-window',
    });
    expect(presentation?.turns).toHaveLength(15);
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 15,
    });
    expect(apiMocks.restoreSessionView).toHaveBeenCalledTimes(1);

    flowChatStore.restoreSessionTailPresentation('history-1');
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.activeRange).toBeNull();

    const reactivated = presentation
      ? flowChatStore.reactivateSessionHistoryWindow('history-1', presentation.range)
      : null;
    expect(reactivated?.range).toEqual(presentation?.range);
    expect(reactivated?.turns).toHaveLength(15);
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.activeRange).toEqual(
      presentation?.range,
    );
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenCalledTimes(1);
  });


  it('caches an optimistic turn after a partial restored tail at its absolute ordinal', async () => {
    const catalog = createTurnCatalog(23);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 23,
        createdAt: 1,
      },
      turns: [20, 21, 22].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 23,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        }),
      ]]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    flowChatStore.addDialogTurn('history-1', {
      id: 'turn-23',
      sessionId: 'history-1',
      userMessage: { id: 'user-23', content: 'new prompt', timestamp: 24 },
      modelRounds: [],
      status: 'pending',
      startTime: 24,
    });

    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isPartial: true,
      loadedTurnCount: 4,
      totalTurnCount: 24,
    });
    const loadedRanges = flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges ?? [];
    expect(loadedRanges).toMatchObject([{
      startOrdinal: 20,
      endOrdinalExclusive: 24,
    }]);
    expect(loadedRanges[0]?.turns.map(turn => turn.id)).toEqual([
      'turn-20',
      'turn-21',
      'turn-22',
      'turn-23',
    ]);
    expect(loadedRanges.some(range =>
      range.startOrdinal <= 3
      && range.endOrdinalExclusive > 3
      && range.turns.some(turn => turn.id === 'turn-23')
    )).toBe(false);
  });

  it('adopts an optimistic partial-tail turn in place without incrementing projected history twice', async () => {
    const catalog = createTurnCatalog(23);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 23,
        createdAt: 1,
      },
      turns: [20, 21, 22].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 23,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([['history-1', createSession({
        sessionId: 'history-1',
        isHistorical: true,
        historyState: 'metadata-only',
      })]]),
      activeSessionId: 'history-1',
    }));
    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');
    const optimistic = {
      id: 'optimistic-23',
      sessionId: 'history-1',
      userMessage: { id: 'user-23', content: 'new prompt', timestamp: 24 },
      modelRounds: [],
      status: 'pending' as const,
      startTime: 24,
    };
    flowChatStore.addDialogTurn('history-1', optimistic);

    expect(flowChatStore.replaceOptimisticDialogTurn('history-1', optimistic.id, {
      ...optimistic,
      id: 'turn-23',
      storageTurnIndex: 140,
      backendTurnIndex: 140,
    })).toBe(true);

    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      loadedTurnCount: 4,
      totalTurnCount: 24,
      dialogTurns: [
        { id: 'turn-20' },
        { id: 'turn-21' },
        { id: 'turn-22' },
        { id: 'turn-23', storageTurnIndex: 140 },
      ],
    });
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges)
      .toMatchObject([{ startOrdinal: 20, endOrdinalExclusive: 24 }]);
  });

  it('shifts cached ordinals after removing a counted optimistic turn', async () => {
    const catalog = createTurnCatalog(23);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 23,
        createdAt: 1,
      },
      turns: [20, 21, 22].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 23,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([['history-1', createSession({
        sessionId: 'history-1',
        isHistorical: true,
        historyState: 'metadata-only',
      })]]),
      activeSessionId: 'history-1',
    }));
    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    const createOptimisticTurn = (id: string, timestamp: number) => ({
      id,
      sessionId: 'history-1',
      userMessage: { id: `user-${id}`, content: id, timestamp },
      modelRounds: [],
      status: 'pending' as const,
      startTime: timestamp,
    });
    flowChatStore.addDialogTurn('history-1', createOptimisticTurn('optimistic-23', 24));
    flowChatStore.addDialogTurn('history-1', createOptimisticTurn('optimistic-24', 25));

    flowChatStore.deleteDialogTurn('history-1', 'optimistic-23');

    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      loadedTurnCount: 4,
      totalTurnCount: 24,
      dialogTurns: [
        { id: 'turn-20' },
        { id: 'turn-21' },
        { id: 'turn-22' },
        { id: 'optimistic-24' },
      ],
    });
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges)
      .toMatchObject([{ startOrdinal: 20, endOrdinalExclusive: 24 }]);
  });


  it('invalidates cached history and catalog entries after truncating a complete session', async () => {
    const catalog = createTurnCatalog(10);
    const dialogTurns = Array.from({ length: 10 }, (_, index) => createPersistedTurn(index));
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: false,
          loadedTurnCount: 10,
          totalTurnCount: 10,
          turnCatalog: catalog,
          dialogTurns,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    apiMocks.loadSessionTurnWindow.mockResolvedValueOnce({
      status: 'ready',
      catalogRevision: catalog.revision,
      totalTurnCount: 10,
      startOrdinal: 0,
      endOrdinalExclusive: 10,
      targetTurnId: 'turn-9',
      turns: dialogTurns,
    });

    const loaded = await flowChatStore.loadSessionTurnWindow('history-1', 9);
    expect(loaded).toMatchObject({ status: 'ready', isCurrent: true });
    const activated = flowChatStore.activateSessionHistoryWindow(
      'history-1',
      loaded.targetOrdinal,
      loaded.navigationGeneration,
    );
    expect(activated?.range.endOrdinalExclusive).toBe(10);

    flowChatStore.truncateDialogTurnsFrom('history-1', 9);

    const truncatedSession = flowChatStore.getState().sessions.get('history-1');
    expect(truncatedSession?.dialogTurns.map(turn => turn.id)).toEqual(
      dialogTurns.slice(0, 9).map(turn => turn.id),
    );
    expect(truncatedSession).toMatchObject({
      isPartial: false,
      loadedTurnCount: 9,
      totalTurnCount: 9,
      turnCatalog: {
        totalTurnCount: 9,
        entries: Array.from({ length: 9 }, (_, ordinal) => ({ ordinal })),
      },
    });
    expect(flowChatStore.getSessionHistoryViewState('history-1')).toMatchObject({
      activeRange: null,
      catalog: { totalTurnCount: 9 },
      loadedRanges: [{ startOrdinal: 0, endOrdinalExclusive: 9 }],
    });

    await expect(flowChatStore.loadSessionTurnWindow('history-1', 9)).resolves.toMatchObject({
      status: 'not-found',
      cacheHit: false,
    });

    flowChatStore.addDialogTurn('history-1', {
      ...createPersistedTurn(9),
      id: 'turn-new',
      turnId: 'turn-new',
    });
    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      totalTurnCount: 10,
      dialogTurns: [...dialogTurns.slice(0, 9), expect.objectContaining({ turnId: 'turn-new' })],
    });
    const postAppendRange = flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges
      .find(range => range.startOrdinal <= 9 && range.endOrdinalExclusive > 9);
    expect(postAppendRange?.turns.at(-1)?.id).toBe('turn-new');
  });

  it('caches an older response without letting it remain the current navigation intent', async () => {
    const catalog = createTurnCatalog(10);
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 10,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    const firstDeferred = createDeferred<any>();
    const secondDeferred = createDeferred<any>();
    apiMocks.loadSessionTurnWindow
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);

    const firstLoad = flowChatStore.loadSessionTurnWindow('history-1', 1);
    const secondLoad = flowChatStore.loadSessionTurnWindow('history-1', 6);
    firstDeferred.resolve({
      status: 'ready',
      catalogRevision: catalog.revision,
      totalTurnCount: 10,
      startOrdinal: 0,
      endOrdinalExclusive: 3,
      targetTurnId: 'turn-1',
      turns: [0, 1, 2].map(index => createPersistedTurn(index)),
    });
    const firstResult = await firstLoad;
    expect(firstResult).toMatchObject({ status: 'ready', isCurrent: false });

    secondDeferred.resolve({
      status: 'ready',
      catalogRevision: catalog.revision,
      totalTurnCount: 10,
      startOrdinal: 5,
      endOrdinalExclusive: 9,
      targetTurnId: 'turn-6',
      turns: [5, 6, 7, 8].map(index => createPersistedTurn(index)),
    });
    await expect(secondLoad).resolves.toMatchObject({ status: 'ready', isCurrent: true });
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges).toMatchObject([
      { startOrdinal: 0, endOrdinalExclusive: 3 },
      { startOrdinal: 5, endOrdinalExclusive: 9 },
    ]);
    expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns).toEqual([]);
  });

  it('activates only the current contiguous target window and extends it with prefetch data', async () => {
    const catalog = createTurnCatalog(60);
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 60,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    apiMocks.loadSessionTurnWindow
      .mockResolvedValueOnce({
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: 60,
        startOrdinal: 16,
        endOrdinalExclusive: 33,
        targetTurnId: 'turn-20',
        turns: Array.from({ length: 17 }, (_, index) => createPersistedTurn(index + 16)),
      })
      .mockResolvedValueOnce({
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: 60,
        startOrdinal: 29,
        endOrdinalExclusive: 46,
        targetTurnId: 'turn-33',
        turns: Array.from({ length: 17 }, (_, index) => createPersistedTurn(index + 29)),
      });

    const navigation = await flowChatStore.loadSessionTurnWindow('history-1', 20);
    expect(navigation).toMatchObject({ status: 'ready', isCurrent: true });
    const activated = flowChatStore.activateSessionHistoryWindow(
      'history-1',
      navigation.targetOrdinal,
      navigation.navigationGeneration,
    );
    expect(activated?.range).toMatchObject({
      startOrdinal: 16,
      endOrdinalExclusive: 33,
      targetTurnId: 'turn-20',
      mode: 'history-window',
    });
    expect(activated?.turns).toHaveLength(17);

    const generationBeforePrefetch = flowChatStore
      .getSessionHistoryViewState('history-1')
      ?.navigationGeneration;
    const prefetch = await flowChatStore.loadSessionTurnWindow('history-1', 33, {
      source: 'prefetch',
    });
    expect(prefetch).toMatchObject({ status: 'ready', isCurrent: true });
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.navigationGeneration).toBe(
      generationBeforePrefetch,
    );
    expect(flowChatStore.extendSessionHistoryWindow('history-1', 'after')?.range).toMatchObject({
      startOrdinal: 16,
      endOrdinalExclusive: 46,
      mode: 'history-window',
    });
    expect(flowChatStore.getState().sessions.get('history-1')?.dialogTurns).toEqual([]);
  });

  it('slices oversized merged ranges around the protected presentation window', async () => {
    const catalog = createTurnCatalog(100);
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 100,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    apiMocks.loadSessionTurnWindow
      .mockResolvedValueOnce({
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: 100,
        startOrdinal: 0,
        endOrdinalExclusive: 100,
        targetTurnId: 'turn-50',
        turns: Array.from({ length: 100 }, (_, index) => createPersistedTurn(index)),
      })
      .mockResolvedValueOnce({
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: 100,
        startOrdinal: 29,
        endOrdinalExclusive: 47,
        targetTurnId: 'turn-45',
        turns: Array.from({ length: 18 }, (_, index) => createPersistedTurn(index + 29)),
      });

    const navigation = await flowChatStore.loadSessionTurnWindow('history-1', 50);
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges).toMatchObject([{
      startOrdinal: 46,
      endOrdinalExclusive: 94,
    }]);
    const activated = flowChatStore.activateSessionHistoryWindow(
      'history-1',
      navigation.targetOrdinal,
      navigation.navigationGeneration,
    );
    expect(activated?.range).toMatchObject({
      startOrdinal: 46,
      endOrdinalExclusive: 94,
    });

    await flowChatStore.loadSessionTurnWindow('history-1', 45, {
      source: 'prefetch',
      before: 16,
      after: 1,
    });
    expect(flowChatStore.extendSessionHistoryWindow('history-1', 'before')?.range).toMatchObject({
      startOrdinal: 30,
      endOrdinalExclusive: 94,
    });
    expect(flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges).toMatchObject([{
      startOrdinal: 30,
      endOrdinalExclusive: 94,
    }]);
  });

  it('evicts least-recently-used non-tail ordinals while retaining recent target windows', async () => {
    const catalog = createTurnCatalog(120);
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 120,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    const windows = new Map([
      [5, { startOrdinal: 0, endOrdinalExclusive: 17 }],
      [30, { startOrdinal: 25, endOrdinalExclusive: 42 }],
      [55, { startOrdinal: 50, endOrdinalExclusive: 67 }],
      [80, { startOrdinal: 75, endOrdinalExclusive: 92 }],
    ]);
    apiMocks.loadSessionTurnWindow.mockImplementation(async request => {
      const targetOrdinal = request.targetStorageTurnIndex;
      const window = windows.get(targetOrdinal);
      if (!window) {
        throw new Error(`Unexpected target ordinal ${targetOrdinal}`);
      }
      return {
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: catalog.totalTurnCount,
        ...window,
        targetTurnId: `turn-${targetOrdinal}`,
        turns: Array.from(
          { length: window.endOrdinalExclusive - window.startOrdinal },
          (_, index) => createPersistedTurn(index + window.startOrdinal),
        ),
      };
    });

    await flowChatStore.loadSessionTurnWindow('history-1', 5);
    await flowChatStore.loadSessionTurnWindow('history-1', 30);
    await flowChatStore.loadSessionTurnWindow('history-1', 55);
    await expect(flowChatStore.loadSessionTurnWindow('history-1', 5)).resolves.toMatchObject({
      cacheHit: true,
    });
    await flowChatStore.loadSessionTurnWindow('history-1', 80);

    const loadedRanges = flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges ?? [];
    const loadedTurnCount = loadedRanges.reduce((count, range) => count + range.turns.length, 0);
    const containsOrdinal = (ordinal: number) => loadedRanges.some(range =>
      range.startOrdinal <= ordinal && range.endOrdinalExclusive > ordinal
    );
    expect(loadedTurnCount).toBe(48);
    expect(containsOrdinal(5)).toBe(true);
    expect(containsOrdinal(30)).toBe(false);
    expect(containsOrdinal(80)).toBe(true);
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenCalledTimes(4);
  });

  it('keeps the restored live tail outside the non-tail LRU budget', async () => {
    const catalog = createTurnCatalog(100);
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 100,
        createdAt: 1,
      },
      turns: [97, 98, 99].map(index => createPersistedTurn(index)),
      turnCatalog: catalog,
      contextRestoreState: 'pending',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 100,
    });
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    const windows = new Map([
      [5, { startOrdinal: 0, endOrdinalExclusive: 17 }],
      [25, { startOrdinal: 20, endOrdinalExclusive: 37 }],
      [45, { startOrdinal: 40, endOrdinalExclusive: 57 }],
      [65, { startOrdinal: 60, endOrdinalExclusive: 77 }],
    ]);
    apiMocks.loadSessionTurnWindow.mockImplementation(async request => {
      const targetOrdinal = request.targetStorageTurnIndex;
      const window = windows.get(targetOrdinal);
      if (!window) {
        throw new Error(`Unexpected target ordinal ${targetOrdinal}`);
      }
      return {
        status: 'ready',
        catalogRevision: catalog.revision,
        totalTurnCount: catalog.totalTurnCount,
        ...window,
        targetTurnId: `turn-${targetOrdinal}`,
        turns: Array.from(
          { length: window.endOrdinalExclusive - window.startOrdinal },
          (_, index) => createPersistedTurn(index + window.startOrdinal),
        ),
      };
    });

    await flowChatStore.loadSessionTurnWindow('history-1', 5);
    await flowChatStore.loadSessionTurnWindow('history-1', 25);
    await flowChatStore.loadSessionTurnWindow('history-1', 45);
    await flowChatStore.loadSessionTurnWindow('history-1', 65);

    const loadedRanges = flowChatStore.getSessionHistoryViewState('history-1')?.loadedRanges ?? [];
    const nonTailTurnCount = loadedRanges.reduce((count, range) => {
      const nonTailEndOrdinalExclusive = Math.min(range.endOrdinalExclusive, 97);
      return count + Math.max(0, nonTailEndOrdinalExclusive - range.startOrdinal);
    }, 0);
    expect(nonTailTurnCount).toBe(48);
    expect(loadedRanges.some(range =>
      range.startOrdinal <= 97 && range.endOrdinalExclusive >= 100
    )).toBe(true);
  });

  it('updates a stale catalog and retries the original Turn identity once', async () => {
    const catalog = createTurnCatalog(8, 'catalog-v1');
    const relocatedCatalog = {
      schemaVersion: 1,
      sessionId: 'history-1',
      revision: 'catalog-v2',
      totalTurnCount: 5,
      complete: true,
      entries: [
        { ordinal: 0, storageTurnIndex: 0, turnId: 'turn-0', preview: '0', previewTruncated: false },
        { ordinal: 1, storageTurnIndex: 1, turnId: 'turn-1', preview: '1', previewTruncated: false },
        { ordinal: 2, storageTurnIndex: 7, turnId: 'turn-4', preview: '4', previewTruncated: false },
        { ordinal: 3, storageTurnIndex: 8, turnId: 'turn-8', preview: '8', previewTruncated: false },
        { ordinal: 4, storageTurnIndex: 9, turnId: 'turn-9', preview: '9', previewTruncated: false },
      ],
    };
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 8,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    apiMocks.loadSessionTurnWindow
      .mockResolvedValueOnce({ status: 'stale', catalog: relocatedCatalog })
      .mockResolvedValueOnce({
        status: 'ready',
        catalogRevision: 'catalog-v2',
        totalTurnCount: 5,
        startOrdinal: 0,
        endOrdinalExclusive: 5,
        targetTurnId: 'turn-4',
        turns: [
          createPersistedTurn(0),
          createPersistedTurn(1),
          { ...createPersistedTurn(7), turnId: 'turn-4' },
          createPersistedTurn(8),
          createPersistedTurn(9),
        ],
      });

    await expect(flowChatStore.loadSessionTurnWindow('history-1', 4)).resolves.toMatchObject({
      status: 'ready',
      targetOrdinal: 2,
      targetTurnId: 'turn-4',
      isCurrent: true,
    });
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      targetStorageTurnIndex: 4,
      expectedTurnId: 'turn-4',
      expectedCatalogRevision: 'catalog-v1',
    }));
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      targetStorageTurnIndex: 7,
      expectedTurnId: 'turn-4',
      expectedCatalogRevision: 'catalog-v2',
    }));
    expect(flowChatStore.getState().sessions.get('history-1')?.turnCatalog?.revision).toBe(
      'catalog-v2',
    );
  });

  it('marks an unsupported window command per host and requests full-history fallback', async () => {
    const catalog = createTurnCatalog(5);
    flowChatStore.setState(() => ({
      sessions: new Map([[
        'history-1',
        createSession({
          sessionId: 'history-1',
          historyState: 'ready',
          isPartial: true,
          totalTurnCount: 5,
          turnCatalog: catalog,
        }),
      ]]),
      activeSessionId: 'history-1',
    }));
    const startFallback = vi.fn();
    ((flowChatStore as any).fullHistoryHydrationRequests as Map<string, unknown>).set('fallback', {
      surfaceId: LOCAL_SURFACE_ID,
      sessionId: 'history-1',
      remote: false,
      requireActiveSession: true,
      sessionTraceId: 'fallback',
      promise: Promise.resolve(),
      startNow: startFallback,
    });
    apiMocks.loadSessionTurnWindow.mockRejectedValueOnce(
      new Error('unknown command load_session_turn_window'),
    );

    await expect(flowChatStore.loadSessionTurnWindow('history-1', 1)).resolves.toMatchObject({
      status: 'unsupported',
      fallbackRequested: true,
    });
    expect(startFallback).toHaveBeenCalledTimes(1);
    await expect(flowChatStore.loadSessionTurnWindow('history-1', 1)).resolves.toMatchObject({
      status: 'unsupported',
    });
    expect(apiMocks.loadSessionTurnWindow).toHaveBeenCalledTimes(1);
  });

  it('backfills currentTokenUsage from the last completed turn after hydration', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [
        {
          ...createPersistedTurn(0),
          modelRounds: [{
            id: 'round-0',
            turnId: 'turn-0',
            roundIndex: 0,
            timestamp: 1,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 1,
            status: 'completed',
          }],
          endTime: 2,
          tokenUsage: {
            inputTokens: 1000,
            outputTokens: 100,
            totalTokens: 1100,
            timestamp: 2,
          },
        },
        {
          ...createPersistedTurn(1),
          modelRounds: [{
            id: 'round-1',
            turnId: 'turn-1',
            roundIndex: 0,
            timestamp: 3,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 3,
            status: 'completed',
          }],
          endTime: 4,
          tokenUsage: {
            inputTokens: 2400,
            outputTokens: 300,
            totalTokens: 2700,
            timestamp: 4,
          },
        },
      ],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toMatchObject({
      inputTokens: 2400,
      outputTokens: 300,
      totalTokens: 2700,
    });
  });

  it('does not backfill through the latest terminal turn when its usage spans multiple rounds', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 2,
        createdAt: 1,
      },
      turns: [
        {
          ...createPersistedTurn(0),
          modelRounds: [{
            id: 'round-0',
            turnId: 'turn-0',
            roundIndex: 0,
            timestamp: 1,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 1,
            status: 'completed',
          }],
          endTime: 2,
          tokenUsage: {
            inputTokens: 1000,
            outputTokens: 100,
            totalTokens: 1100,
            timestamp: 2,
          },
        },
        {
          ...createPersistedTurn(1),
          modelRounds: [
            {
              id: 'round-1',
              turnId: 'turn-1',
              roundIndex: 0,
              timestamp: 3,
              textItems: [],
              toolItems: [],
              thinkingItems: [],
              startTime: 3,
              status: 'completed',
            },
            {
              id: 'round-2',
              turnId: 'turn-1',
              roundIndex: 1,
              timestamp: 4,
              textItems: [],
              toolItems: [],
              thinkingItems: [],
              startTime: 4,
              status: 'completed',
            },
          ],
          endTime: 5,
          tokenUsage: {
            inputTokens: 8_900_000,
            outputTokens: 300,
            totalTokens: 8_900_300,
            timestamp: 5,
          },
        },
      ],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toBeUndefined();
  });

  it('uses the restored agent type to suppress native usage for ACP hydration', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'acp:test',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          id: 'round-0',
          turnId: 'turn-0',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'completed',
        }],
        endTime: 2,
        tokenUsage: {
          inputTokens: 2400,
          outputTokens: 300,
          totalTokens: 2700,
          timestamp: 2,
        },
      }],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
          mode: 'Standard',
          config: { agentType: 'Standard' },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      mode: 'acp:test',
      currentTokenUsage: undefined,
    });
  });

  it('keeps an existing currentTokenUsage when hydrating historical turns', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [
        {
          ...createPersistedTurn(0),
          modelRounds: [{
            id: 'round-0',
            turnId: 'turn-0',
            roundIndex: 0,
            timestamp: 1,
            textItems: [],
            toolItems: [],
            thinkingItems: [],
            startTime: 1,
            status: 'completed',
          }],
          endTime: 2,
          tokenUsage: {
            inputTokens: 2400,
            outputTokens: 300,
            totalTokens: 2700,
            timestamp: 2,
          },
        },
      ],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
          currentTokenUsage: {
            inputTokens: 999,
            outputTokens: 1,
            totalTokens: 1000,
            timestamp: 5,
            turnId: 'turn-0',
            source: 'model_request',
          },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toMatchObject({
      inputTokens: 999,
      outputTokens: 1,
      totalTokens: 1000,
      turnId: 'turn-0',
      source: 'model_request',
    });
  });

  it('discards stale exact usage but keeps a safe fallback when restore reports no exact usage', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          id: 'round-0',
          turnId: 'turn-0',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'completed',
        }],
        endTime: 2,
        tokenUsage: {
          inputTokens: 2400,
          outputTokens: 300,
          totalTokens: 2700,
          timestamp: 2,
        },
      }],
      currentContextUsage: null,
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
          currentTokenUsage: {
            inputTokens: 999,
            outputTokens: 1,
            totalTokens: 1000,
            timestamp: 5,
            turnId: 'turn-0',
            source: 'model_request',
          },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toMatchObject({
      inputTokens: 2400,
      outputTokens: 300,
      totalTokens: 2700,
      turnId: 'turn-0',
    });
  });

  it('invalidates restored context usage when its source turn is not visible after hydration', async () => {
    peerModeFlagMock.active = true;
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: {
        sessionId: 'history-1',
        sessionName: 'History 1',
        agentType: 'Standard',
        state: 'Idle',
        turnCount: 1,
        createdAt: 1,
      },
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          id: 'round-0',
          turnId: 'turn-0',
          roundIndex: 0,
          timestamp: 1,
          textItems: [],
          toolItems: [],
          thinkingItems: [],
          startTime: 1,
          status: 'completed',
        }],
        endTime: 2,
        tokenUsage: {
          inputTokens: 2400,
          outputTokens: 300,
          totalTokens: 2700,
          timestamp: 2,
        },
      }],
      contextRestoreState: 'ready',
    });
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          isHistorical: true,
          historyState: 'metadata-only',
          currentTokenUsage: {
            inputTokens: 42000,
            outputTokens: 1500,
            totalTokens: 43500,
            timestamp: 5,
            turnId: 'deleted-turn',
            source: 'model_request',
          },
        })],
      ]),
      activeSessionId: 'history-1',
    }));

    await flowChatStore.loadSessionHistory('history-1', 'D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toMatchObject({
      inputTokens: 2400,
      outputTokens: 300,
      totalTokens: 2700,
    });
  });

  it('restores current token usage from top-level persisted context metadata', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        modelName: 'primary',
        createdAt: 10,
        lastActiveAt: 20,
        currentContextUsage: {
          inputTokens: 42000,
          outputTokens: 1500,
          totalTokens: 43500,
          timestamp: 21,
          turnId: 'turn-7',
          source: 'model_request',
        },
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toMatchObject({
      inputTokens: 42000,
      outputTokens: 1500,
      totalTokens: 43500,
      turnId: 'turn-7',
      source: 'model_request',
    });
  });

  it('does not restore native context metadata for ACP sessions', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved ACP session',
        agentType: 'acp:test',
        modelName: 'primary',
        createdAt: 10,
        lastActiveAt: 20,
        currentContextUsage: {
          inputTokens: 42000,
          outputTokens: 1500,
          totalTokens: 43500,
          timestamp: 21,
          turnId: 'turn-7',
          source: 'model_request',
        },
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toBeUndefined();
  });

  it('ignores invalid persisted current context usage', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        modelName: 'primary',
        createdAt: 10,
        lastActiveAt: 20,
        currentContextUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          timestamp: 21,
          turnId: 'turn-7',
          source: 'model_request',
        },
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toBeUndefined();
  });

  it('ignores persisted context usage without valid provenance', async () => {
    apiMocks.listSessions.mockResolvedValueOnce([
      {
        sessionId: 'history-1',
        title: 'Saved session',
        agentType: 'Standard',
        modelName: 'primary',
        createdAt: 10,
        lastActiveAt: 20,
        currentContextUsage: {
          inputTokens: 42000,
          outputTokens: 1500,
          totalTokens: 43500,
          timestamp: 21,
          turnId: '   ',
          source: 'unknown_source',
        },
      },
    ]);

    await flowChatStore.initializeFromDisk('D:/workspace/OpenBitFun');

    expect(flowChatStore.getState().sessions.get('history-1')?.currentTokenUsage).toBeUndefined();
  });
});

describe('FlowChatStore reconcile snapshot content safety', () => {
  const HYDRATED_ROUND = {
    id: 'round-0',
    turnId: 'turn-0',
    roundIndex: 0,
    timestamp: 2,
    textItems: [{ id: 'text-0', content: 'OpenBitFun is an agentic IDE…', timestamp: 2 }],
    toolItems: [],
    thinkingItems: [],
    startTime: 2,
    status: 'completed',
  };

  const hostSession = (state = 'Idle') => ({
    sessionId: 'history-1',
    sessionName: 'History 1',
    agentType: 'Standard',
    state,
    turnCount: 1,
    createdAt: 1,
  });

  beforeEach(() => {
    peerModeFlagMock.active = false;
    apiMocks.restoreSessionView.mockReset();
    vi.stubGlobal('CustomEvent', class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    resetStore();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function hydrateSessionWithContent(): Promise<void> {
    flowChatStore.setState(() => ({
      sessions: new Map([
        ['history-1', createSession({
          sessionId: 'history-1',
          workspacePath: '/repo/OpenBitFun',
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: 'history-1',
    }));
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{ ...createPersistedTurn(0), modelRounds: [HYDRATED_ROUND], endTime: 3 }],
      contextRestoreState: 'ready',
    });
    await flowChatStore.loadSessionHistory('history-1', '/repo/OpenBitFun');
  }

  it('keeps a hydrated turn when a wholesale replace snapshot carries none of its work', async () => {
    // The reported failure: after switching device away and back, the rebuilt
    // projection has no state machines, so every turn reads as idle and every
    // snapshot qualifies for wholesale replacement. A windowed snapshot names
    // the turn but carries no rounds, so replacing it left the user prompt on
    // screen with the whole response gone.
    await hydrateSessionWithContent();
    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0].modelRounds,
    ).toHaveLength(1);

    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{ ...createPersistedTurn(0), modelRounds: [] }],
      contextRestoreState: 'ready',
    });

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/repo/OpenBitFun',
      { replaceRunningSnapshot: true, requireActiveSession: true },
    );

    expect(result.applied).toBe(false);
    const turn = flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0];
    expect(turn?.modelRounds).toHaveLength(1);
    expect(turn?.modelRounds[0].items).toHaveLength(1);
  });

  it('refuses a replace that would drop a round the projection already shows', async () => {
    await hydrateSessionWithContent();

    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{ ...HYDRATED_ROUND, id: 'round-other' }],
      }],
      contextRestoreState: 'ready',
    });

    await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/repo/OpenBitFun',
      { replaceRunningSnapshot: true, requireActiveSession: true },
    );

    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0].modelRounds[0].id,
    ).toBe('round-0');
  });

  it('refuses an equal-item-count checkpoint that shortens rendered text', async () => {
    await hydrateSessionWithContent();

    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          ...HYDRATED_ROUND,
          textItems: [{ id: 'text-0', content: 'OpenBitFun is', timestamp: 2 }],
        }],
      }],
      contextRestoreState: 'ready',
    });

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/repo/OpenBitFun',
      { requireActiveSession: true },
    );

    expect(result.applied).toBe(false);
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({ content: 'OpenBitFun is an agentic IDE…' });
  });

  it('repairs a settled local or Peer projection from the host tail', async () => {
    await hydrateSessionWithContent();
    const completeContent = 'OpenBitFun is an agentic IDE… with a complete persisted response.';
    flowChatStore.addModelRoundItem('history-1', 'turn-0', {
      id: 'plan-display-test',
      type: 'tool',
      toolName: 'CreatePlan',
      toolCall: { id: '', input: {} },
      toolResult: {
        result: { plan_file_path: '/tmp/plan.md' },
        success: true,
      },
      timestamp: 2,
      status: 'completed',
    }, 'round-0');

    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          ...HYDRATED_ROUND,
          textItems: [{ id: 'text-0', content: completeContent, timestamp: 2 }],
        }],
        endTime: 3,
      }],
      contextRestoreState: 'ready',
    });

    await expect(
      flowChatStore.reconcileSettledDialogTurn('history-1', 'turn-0'),
    ).resolves.toBe(true);
    expect(apiMocks.restoreSessionView).toHaveBeenLastCalledWith(
      'history-1',
      '/repo/OpenBitFun',
      undefined,
      undefined,
      'settled-turn-turn-0',
      false,
      1,
    );
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items[0],
    ).toMatchObject({ content: completeContent });
    expect(
      flowChatStore.getState().sessions.get('history-1')
        ?.dialogTurns[0].modelRounds[0].items,
    ).toContainEqual(expect.objectContaining({ id: 'plan-display-test' }));
  });

  it('still adopts the host copy when the snapshot carries the projected work', async () => {
    // The guard must not disable wholesale replacement, which is how a settled
    // turn picks up the host's authoritative copy.
    await hydrateSessionWithContent();

    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: hostSession(),
      turns: [{
        ...createPersistedTurn(0),
        modelRounds: [{
          ...HYDRATED_ROUND,
          textItems: [
            { id: 'text-0', content: 'OpenBitFun is an agentic IDE…', timestamp: 2 },
            { id: 'text-1', content: '…with multi-device control.', timestamp: 3 },
          ],
        }],
      }],
      contextRestoreState: 'ready',
    });

    const result = await flowChatStore.refreshPeerSessionSnapshot(
      'history-1',
      '/repo/OpenBitFun',
      { replaceRunningSnapshot: true, requireActiveSession: true },
    );

    expect(result.applied).toBe(true);
    expect(
      flowChatStore.getState().sessions.get('history-1')?.dialogTurns[0].modelRounds[0].items,
    ).toHaveLength(2);
  });
});

describe('FlowChatStore device surfaces', () => {
  const PEER_SURFACE_ID = 'device-b';

  const restoredTurn = (sessionId: string) => ({
    turnId: `${sessionId}-turn-1`,
    turnIndex: 0,
    sessionId,
    timestamp: 1,
    userMessage: { id: `${sessionId}-user-1`, content: 'hello', timestamp: 1 },
    modelRounds: [],
    startTime: 1,
    status: 'completed',
  });

  const restoredSession = (sessionId: string) => ({
    sessionId,
    sessionName: sessionId,
    agentType: 'Standard',
    state: 'Idle',
    turnCount: 1,
    createdAt: 1,
  });

  const seedSession = (sessionId: string) => {
    flowChatStore.setState(() => ({
      sessions: new Map([
        [sessionId, createSession({
          sessionId,
          isHistorical: true,
          historyState: 'metadata-only',
        })],
      ]),
      activeSessionId: sessionId,
    }));
  };

  beforeEach(() => {
    peerModeFlagMock.active = false;
    apiMocks.restoreSessionView.mockReset();
    apiMocks.restoreSessionWithTurns.mockReset();
    apiMocks.listSessionsPage.mockReset();
  });

  afterEach(() => {
    resetStore();
  });

  it('keeps a failed peer log isolated and never falls back to transcript RPC', async () => {
    activateSurface(PEER_SURFACE_ID);
    seedSession('peer-1');
    apiMocks.subscribeRelaySession.mockRejectedValueOnce(new Error('Relay unavailable'));
    await expect(flowChatStore.loadSessionHistory('peer-1', '/repo/OpenBitFun'))
      .rejects.toThrow('Relay unavailable');
    expect(apiMocks.restoreSessionView).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('peer-1')?.historyState).toBe('failed');

    activateSurface(LOCAL_SURFACE_ID);
    seedSession('local-1');
    apiMocks.restoreSessionView.mockResolvedValueOnce({
      session: restoredSession('local-1'),
      turns: [restoredTurn('local-1')],
      contextRestoreState: 'ready',
    });
    await flowChatStore.loadSessionHistory('local-1', '/repo/OpenBitFun');
    expect(apiMocks.restoreSessionView).toHaveBeenCalledOnce();
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
    expect(flowChatStore.getState().sessions.get('local-1')?.historyState).toBe('ready');
  });

  it('builds visible turn navigation from canonical records without treating storage gaps as ordinals', async () => {
    activateSurface(PEER_SURFACE_ID);
    seedSession('peer-log');
    stateMachineManagerMock.getOrCreate.mockReturnValue({ acceptRuntimeStatus: vi.fn() });
    apiMocks.subscribeRelaySession.mockImplementationOnce(async () => {
      for (const index of [2, 11]) {
        const { modelRounds: _rounds, ...turn } = createPersistedTurn(index, 'peer-log');
        apiMocks.relayRecord?.({ sessionId: 'peer-log', id: `turn/${turn.turnId}`, revision: index + 1, turn });
      }
      apiMocks.relayReady?.({ sessionId: 'peer-log', hasMore: false, oldestSeq: 1, cursor: 2 });
      return 'peer-log-subscription';
    });
    await flowChatStore.loadSessionHistory('peer-log', '/runtime');
    const session = flowChatStore.getState().sessions.get('peer-log');
    expect(session?.turnCatalog?.entries.map(entry => [entry.ordinal, entry.storageTurnIndex]))
      .toEqual([[0, 2], [1, 11]]);
    const selected = await flowChatStore.loadSessionTurnWindow('peer-log', 1);
    expect(selected.status).toBe('ready');
    expect(selected.targetTurnId).toBe('turn-11');
    expect(apiMocks.loadSessionTurnWindow).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionView).not.toHaveBeenCalled();
    expect(apiMocks.restoreSessionWithTurns).not.toHaveBeenCalled();
  });

  it('retains mailbox questions across canonical updates and clears them when the owning turn completes', async () => {
    activateSurface(PEER_SURFACE_ID);
    seedSession('peer-mailbox');
    stateMachineManagerMock.getOrCreate.mockReturnValue({ acceptRuntimeStatus: vi.fn() });
    const {modelRounds: _rounds, ...stored} = createPersistedTurn(0, 'peer-mailbox');
    const turn = {...stored, status:'inprogress'};
    apiMocks.getSessionInteractionMailbox.mockResolvedValueOnce({sessionId:'peer-mailbox', permissions:{revision:0,requests:[]}, userQuestions:{revision:1,questions:[{toolId:'question',sessionId:'peer-mailbox',dialogTurnId:'turn-0',modelRoundId:'round-q',questions:{questions:[{question:'Proceed?'}]},registeredAtMs:1}]}} as any);
    apiMocks.subscribeRelaySession.mockImplementationOnce(async () => {
      apiMocks.relayRecord?.({sessionId:'peer-mailbox',id:'turn/turn-0',revision:1,turn});
      apiMocks.relayReady?.({sessionId:'peer-mailbox',hasMore:false,oldestSeq:1,cursor:1});
      return 'mailbox-subscription';
    });
    await flowChatStore.loadRelaySessionHistory('peer-mailbox');
    const tools = () => flowChatStore.getState().sessions.get('peer-mailbox')!.dialogTurns.flatMap(row=>row.modelRounds.flatMap(round=>round.items));
    await vi.waitFor(()=>expect(tools().find(item=>item.id==='question')).toMatchObject({status:'waiting'}));
    apiMocks.relayRecord?.({sessionId:'peer-mailbox',id:'turn/turn-0',revision:2,turn});
    expect(tools().find(item=>item.id==='question')).toMatchObject({status:'waiting'});
    apiMocks.relayRecord?.({sessionId:'peer-mailbox',id:'turn/turn-0',revision:3,turn:{...turn,status:'completed'}});
    expect(tools().find(item=>item.id==='question')).toBeUndefined();
  });

  it('does not revive a question when a completed record races a mailbox response', async () => {
    activateSurface(PEER_SURFACE_ID); seedSession('peer-mailbox-race');
    stateMachineManagerMock.getOrCreate.mockReturnValue({ acceptRuntimeStatus: vi.fn() });
    let resolveMailbox!: (value: any) => void;
    apiMocks.getSessionInteractionMailbox.mockImplementationOnce(() => new Promise(resolve => {resolveMailbox=resolve;}));
    const {modelRounds:_rounds,...stored}=createPersistedTurn(0,'peer-mailbox-race');
    apiMocks.subscribeRelaySession.mockImplementationOnce(async()=>{
      apiMocks.relayRecord?.({sessionId:'peer-mailbox-race',id:'turn/turn-0',revision:1,turn:{...stored,status:'inprogress'}});
      apiMocks.relayReady?.({sessionId:'peer-mailbox-race',hasMore:false,oldestSeq:1,cursor:1}); return 'race-subscription';
    });
    await flowChatStore.loadRelaySessionHistory('peer-mailbox-race');
    apiMocks.relayRecord?.({sessionId:'peer-mailbox-race',id:'turn/turn-0',revision:2,turn:stored});
    resolveMailbox({sessionId:'peer-mailbox-race',permissions:{revision:0,requests:[]},userQuestions:{revision:1,questions:[{toolId:'question',sessionId:'peer-mailbox-race',dialogTurnId:'turn-0',questions:{questions:[]},registeredAtMs:1}]}});
    await Promise.resolve(); await Promise.resolve();
    expect(flowChatStore.getState().sessions.get('peer-mailbox-race')!.dialogTurns[0].status).toBe('completed');
    expect(flowChatStore.getState().sessions.get('peer-mailbox-race')!.dialogTurns[0].modelRounds).toHaveLength(0);
  });

  it('keeps each device sessions across a switch away and back', async () => {
    seedSession('local-1');

    activateSurface(PEER_SURFACE_ID);
    expect(flowChatStore.getState().sessions.has('local-1')).toBe(false);
    seedSession('peer-1');

    activateSurface(LOCAL_SURFACE_ID);
    const localState = flowChatStore.getState();
    expect(localState.activeSessionId).toBe('local-1');
    expect(localState.sessions.has('local-1')).toBe(true);
    expect(localState.sessions.has('peer-1')).toBe(false);

    activateSurface(PEER_SURFACE_ID);
    const peerState = flowChatStore.getState();
    expect(peerState.activeSessionId).toBe('peer-1');
    expect(peerState.sessions.has('peer-1')).toBe(true);
  });

  it('abandons an optimistic turn on its owning device without touching an equal peer session', () => {
    seedSession('shared-session');
    const optimisticTurn = {
      id: 'optimistic-turn',
      sessionId: 'shared-session',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
      modelRounds: [],
      status: 'pending' as const,
      startTime: 1,
    };
    flowChatStore.addDialogTurn('shared-session', optimisticTurn);

    activateSurface(PEER_SURFACE_ID);
    seedSession('shared-session');
    flowChatStore.addDialogTurn('shared-session', {
      ...optimisticTurn,
      id: 'peer-turn',
    });

    flowChatStore.abandonOptimisticDialogTurn(
      LOCAL_SURFACE_ID,
      'shared-session',
      'optimistic-turn',
    );

    expect(flowChatStore.getState().sessions.get('shared-session')?.dialogTurns)
      .toHaveLength(1);
    activateSurface(LOCAL_SURFACE_ID);
    expect(flowChatStore.getState().sessions.get('shared-session')?.dialogTurns)
      .toHaveLength(0);
  });

  // The rendered pane is derived from the store through this subscription, so
  // selecting another container has to announce itself or the previous device's
  // messages stay on screen.
  it('notifies subscribers when another device becomes the rendered one', () => {
    seedSession('local-1');
    const observedActiveSessionIds: Array<string | null> = [];
    const unsubscribe = flowChatStore.subscribe(state => {
      observedActiveSessionIds.push(state.activeSessionId);
    });

    try {
      activateSurface(PEER_SURFACE_ID);
      expect(observedActiveSessionIds).toEqual([null]);

      seedSession('peer-1');
      activateSurface(LOCAL_SURFACE_ID);
      expect(observedActiveSessionIds).toEqual([null, 'peer-1', 'local-1']);
    } finally {
      unsubscribe();
    }
  });

  it('reports the switch through the surface generation without dropping sessions', () => {
    seedSession('local-1');
    const generationBefore = flowChatStore.getSurfaceGeneration();

    flowChatStore.prepareForSurfaceSwitch();
    activateSurface(PEER_SURFACE_ID);

    expect(flowChatStore.getSurfaceGeneration()).toBeGreaterThan(generationBefore);
    activateSurface(LOCAL_SURFACE_ID);
    expect(flowChatStore.getState().sessions.has('local-1')).toBe(true);
  });

  it('loads session metadata once per device for the same workspace path', async () => {
    apiMocks.listSessionsPage.mockResolvedValue({
      sessions: [],
      totalTopLevelCount: 0,
      loadedTopLevelCount: 0,
      nextCursor: undefined,
      hasMore: false,
    });

    await flowChatStore.loadSessionMetadataPage('/repo/OpenBitFun', 5);
    expect(apiMocks.listSessionsPage).toHaveBeenCalledTimes(1);

    // Same path, other machine: the dedup entry must not answer for it.
    activateSurface(PEER_SURFACE_ID);
    await flowChatStore.loadSessionMetadataPage('/repo/OpenBitFun', 5);

    expect(apiMocks.listSessionsPage).toHaveBeenCalledTimes(2);
  });

  it('abandons a history restore that lands after the window switched device', async () => {
    seedSession('local-1');
    apiMocks.restoreSessionView.mockImplementationOnce(async () => {
      activateSurface(PEER_SURFACE_ID);
      return {
        session: restoredSession('local-1'),
        turns: [restoredTurn('local-1')],
        contextRestoreState: 'ready',
      };
    });

    await expect(
      flowChatStore.loadSessionHistory('local-1', '/repo/OpenBitFun'),
    ).rejects.toSatisfy(isSurfaceChangedError);

    // Neither device may be told the restore failed: the peer never asked, and
    // the local projection is intact in its own container.
    expect(flowChatStore.getState().sessions.has('local-1')).toBe(false);
    activateSurface(LOCAL_SURFACE_ID);
    expect(flowChatStore.getState().sessions.get('local-1')).toMatchObject({
      historyState: 'metadata-only',
    });
  });

  it('never projects a local interaction snapshot into the peer selected mid-refresh', async () => {
    seedSession('shared-session');
    const restore = createDeferred<any>();
    apiMocks.restoreSessionView.mockReturnValueOnce(restore.promise);

    const refresh = flowChatStore.refreshPeerSessionSnapshot(
      'shared-session',
      '/repo/OpenBitFun',
      { requireActiveSession: true },
    );
    await flushAsyncWork();

    activateSurface(PEER_SURFACE_ID);
    seedSession('shared-session');
    restore.resolve({
      session: {
        ...restoredSession('shared-session'),
        state: 'Processing { current_turn_id: "shared-session-turn-1" }',
      },
      turns: [{
        ...restoredTurn('shared-session'),
        status: 'inprogress',
      }],
      interactionSnapshot: {
        sessionId: 'shared-session',
        userQuestions: {
          revision: 1,
          questions: [{
            toolId: 'local-question',
            sessionId: 'shared-session',
            dialogTurnId: 'shared-session-turn-1',
            modelRoundId: 'local-round',
            questions: { questions: [] },
            registeredAtMs: 2,
          }],
        },
        permissions: { revision: 1, requests: [] },
      },
      contextRestoreState: 'pending',
    });

    await expect(refresh).rejects.toSatisfy(isSurfaceChangedError);
    expect(
      flowChatStore.getState().sessions.get('shared-session')?.dialogTurns,
    ).toEqual([]);

    activateSurface(LOCAL_SURFACE_ID);
    expect(
      flowChatStore.getState().sessions.get('shared-session')?.dialogTurns,
    ).toEqual([]);
  });

  it('does not fall back onto the next device after a typed surface cancellation', async () => {
    seedSession('local-1');
    apiMocks.restoreSessionView.mockRejectedValueOnce(
      new SurfaceChangedError(LOCAL_SURFACE_ID, 1, 'restore session view'),
    );

    await expect(
      flowChatStore.loadSessionHistory('local-1', '/repo/OpenBitFun'),
    ).rejects.toSatisfy(isSurfaceChangedError);

    expect(apiMocks.loadSessionTurns).not.toHaveBeenCalled();
  });
});
