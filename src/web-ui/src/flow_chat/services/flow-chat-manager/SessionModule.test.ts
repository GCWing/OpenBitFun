import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  ensureBackendSession,
  forkChatSession,
  hydrateSessionHistoryForDetail,
  pendingHistoryLoadKey,
  preloadHistoricalSessionForOpen,
  reloadSessionTitle,
  retryCreateBackendSession,
  resolveAgentTypeForSessionCreation,
  SESSION_ACTIVITY_TOUCH_DELAY_MS,
  switchChatSession,
} from './SessionModule';
import {
  activateSurface,
  LOCAL_SURFACE_ID,
} from '@/infrastructure/peer-device/deviceSurface';
import {
  clearHistorySessionOpenTransition,
  clearRecentHistorySessionOpenIntent,
  dispatchHistorySessionOpenIntent,
  getHistorySessionOpenTransitionSnapshot,
} from '../sessionOpenIntent';
import type { Session } from '../../types/flow-chat';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';

const agentApiMocks = vi.hoisted(() => ({
  ensureCoordinatorSession: vi.fn(),
  createSession: vi.fn(),
  getAvailableModes: vi.fn(),
}));

const configApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

const configManagerMocks = vi.hoisted(() => ({
  getConfigs: vi.fn(),
}));

const sessionApiMocks = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  forkSession: vi.fn(),
  loadSessionMetadata: vi.fn(),
}));

const persistenceMocks = vi.hoisted(() => ({
  touchSessionActivity: vi.fn(),
  cleanupSaveState: vi.fn(),
  cleanupSessionBuffers: vi.fn(),
}));

const stateMachineMocks = vi.hoisted(() => ({
  delete: vi.fn(),
}));

const dispatchStoreMocks = vi.hoisted(() => ({
  jobs: {} as Record<string, { sessionId: string }>,
  registerJob: vi.fn(),
  dismissSession: vi.fn(),
  updateTitle: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: agentApiMocks,
}));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: configApiMocks,
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: configManagerMocks,
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: sessionApiMocks,
}));

vi.mock('../../../shared/notification-system', () => ({
  notificationService: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: {
    getState: () => ({
      currentWorkspace: { id: 'workspace-1', rootPath: '/home/wsp/projects/Test', workspaceKind: 'normal' },
      openedWorkspaces: new Map([['workspace-1', { id: 'workspace-1', rootPath: '/home/wsp/projects/Test', workspaceKind: 'normal' }]]),
    }),
  },
}));

vi.mock('./PersistenceModule', () => ({
  touchSessionActivity: persistenceMocks.touchSessionActivity,
  cleanupSaveState: persistenceMocks.cleanupSaveState,
}));

vi.mock('./TextChunkModule', () => ({
  cleanupSessionBuffers: persistenceMocks.cleanupSessionBuffers,
}));

vi.mock('../../state-machine', () => ({
  stateMachineManager: stateMachineMocks,
}));

vi.mock('@/features/dispatch/dispatchJobStore', () => ({
  dispatchJobStore: {
    getState: () => dispatchStoreMocks,
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'history-1',
    workspaceId: 'workspace-1',
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
    parentSessionId: undefined,
    parentToolCallId: undefined,
    subagentType: undefined,
    btwOrigin: undefined,
    deepReviewRunManifest: undefined,
    ...overrides,
  };
}

function createContext(
  session: Session,
  options?: {
    additionalSessions?: Session[];
    activeSessionId?: string | null;
    deleteSessionImpl?: (
      sessionId: string,
      options?: { nextActiveSessionId?: string | null },
    ) => Promise<void> | void;
    removeSessionImpl?: (
      sessionId: string,
      options?: { nextActiveSessionId?: string | null },
    ) => string[] | void;
    getCascadeSessionIdsImpl?: (sessionId: string) => string[];
  },
) {
  const initialSessions = new Map<string, Session>([
    [session.sessionId, session],
    ...((options?.additionalSessions ?? []).map(extra => [extra.sessionId, extra] as const)),
  ]);
  let state = {
    sessions: initialSessions,
    activeSessionId: options?.activeSessionId ?? null as string | null,
  };
  const processingManager = {
    clearSessionStatus: vi.fn(),
  };
  const flowChatStore = {
    getState: () => state,
    createSession: vi.fn((
      sessionId: string,
      config?: Record<string, unknown>,
      _unused?: unknown,
      title?: string,
      _maxContextTokens?: number,
      agentType?: string,
      workspacePath?: string,
      remoteConnectionId?: string,
      remoteSshHost?: string,
    ) => {
      const nextSession = createSession({
        sessionId,
        title: title ?? sessionId,
        isHistorical: false,
        historyState: 'ready',
        config: {
          agentType: agentType ?? (config?.agentType as string | undefined) ?? 'Standard',
        },
        mode: agentType ?? 'Standard',
        workspacePath: workspacePath ?? (config?.workspacePath as string | undefined) ?? session.workspacePath,
        remoteConnectionId,
        remoteSshHost,
      });
      state = {
        ...state,
        sessions: new Map(state.sessions).set(sessionId, nextSession),
        activeSessionId: sessionId,
      };
    }),
    switchSession: vi.fn((sessionId: string) => {
      state = { ...state, activeSessionId: sessionId };
    }),
    loadSessionHistory: vi.fn(),
    getCascadeSessionIds: vi.fn((sessionId: string) => (
      options?.getCascadeSessionIdsImpl?.(sessionId) ?? [sessionId]
    )),
    deleteSession: vi.fn(async (
      sessionId: string,
      deleteOptions?: { nextActiveSessionId?: string | null },
    ) => {
      if (options?.deleteSessionImpl) {
        await options.deleteSessionImpl(sessionId, deleteOptions);
        return;
      }
      const nextSessions = new Map(state.sessions);
      nextSessions.delete(sessionId);
      state = {
        ...state,
        sessions: nextSessions,
        activeSessionId: state.activeSessionId === sessionId
          ? deleteOptions && 'nextActiveSessionId' in deleteOptions
            ? deleteOptions.nextActiveSessionId ?? null
            : null
          : state.activeSessionId,
      };
    }),
    removeSession: vi.fn((
      sessionId: string,
      removeOptions?: { nextActiveSessionId?: string | null },
    ) => {
      if (options?.removeSessionImpl) {
        return options.removeSessionImpl(sessionId, removeOptions) ?? [sessionId];
      }
      const removedSessionIds = options?.getCascadeSessionIdsImpl?.(sessionId) ?? [sessionId];
      const removedSessionIdSet = new Set(removedSessionIds);
      const nextSessions = new Map(state.sessions);
      removedSessionIds.forEach(id => nextSessions.delete(id));
      state = {
        ...state,
        sessions: nextSessions,
        activeSessionId: state.activeSessionId && removedSessionIdSet.has(state.activeSessionId)
          ? removeOptions && 'nextActiveSessionId' in removeOptions
            ? removeOptions.nextActiveSessionId ?? null
            : null
          : state.activeSessionId,
      };
      return removedSessionIds;
    }),
    setState: vi.fn((updater: any) => {
      state = updater(state);
    }),
  };

  return {
    context: {
      flowChatStore,
      processingManager,
      pendingHistoryLoads: new Map<string, Promise<void>>(),
      pendingContextRestores: new Map<string, Promise<void>>(),
    } as any,
    flowChatStore,
    processingManager,
  };
}

describe('resolveAgentTypeForSessionCreation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured fixed mode when the caller requests the default', async () => {
    configApiMocks.getConfig.mockResolvedValue({
      default_mode_strategy: 'fixed',
      default_mode_id: 'PlannerPlus',
    });
    agentApiMocks.getAvailableModes.mockResolvedValue([
      { id: 'Standard' },
      { id: 'PlannerPlus' },
    ]);

    await expect(resolveAgentTypeForSessionCreation(undefined, null)).resolves.toBe('PlannerPlus');
  });

  it('does not override any explicit mode, including the Standard Harness id', async () => {
    await expect(resolveAgentTypeForSessionCreation('Cowork', null)).resolves.toBe('Cowork');
    await expect(resolveAgentTypeForSessionCreation('Standard', null)).resolves.toBe('Standard');

    expect(configApiMocks.getConfig).not.toHaveBeenCalled();
    expect(agentApiMocks.getAvailableModes).not.toHaveBeenCalled();
  });

  it('follows the most recent explicit ChatInput selection', async () => {
    configApiMocks.getConfig.mockResolvedValue({
      default_mode_strategy: 'follow_last',
      default_mode_id: 'Ultimate',
      last_mode_id: 'Creative',
    });
    agentApiMocks.getAvailableModes.mockResolvedValue([
      { id: 'Standard' },
      { id: 'Creative' },
      { id: 'Ultimate' },
    ]);

    await expect(resolveAgentTypeForSessionCreation(undefined, null)).resolves.toBe('Creative');
  });

  it('preserves the fixed meaning of legacy default_mode_id config', async () => {
    configApiMocks.getConfig.mockResolvedValue({ default_mode_id: 'PlannerPlus' });
    agentApiMocks.getAvailableModes.mockResolvedValue([
      { id: 'Standard' },
      { id: 'PlannerPlus' },
    ]);

    await expect(resolveAgentTypeForSessionCreation(undefined, null)).resolves.toBe('PlannerPlus');
  });

  it('falls back to agentic when the configured default mode is unavailable', async () => {
    configApiMocks.getConfig.mockResolvedValue({
      default_mode_strategy: 'fixed',
      default_mode_id: 'MissingMode',
    });
    agentApiMocks.getAvailableModes.mockResolvedValue([{ id: 'Standard' }]);

    await expect(resolveAgentTypeForSessionCreation(undefined, null)).resolves.toBe('Standard');
  });
});

describe('createChatSession', () => {
  beforeEach(() => {
    configApiMocks.getConfig.mockResolvedValue(null);
    configManagerMocks.getConfigs.mockResolvedValue({});
    agentApiMocks.getAvailableModes.mockResolvedValue([{ id: 'Standard' }]);
    agentApiMocks.createSession.mockResolvedValue({ sessionId: 'created-1' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an unknown explicit ID without selecting the active folder', async () => {
    const { context } = createContext(createSession());
    await expect(createChatSession(context, {
      workspaceId: 'missing-workspace', workspacePath: '/home/wsp/projects/Test',
    }, 'Standard')).rejects.toThrow('Workspace ID is unavailable');
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
  });

  it('dedupes concurrent creates before model config loading resolves', async () => {
    // This keeps the first create suspended in the model config path while the
    // second create enters with the same creation key.
    const modelConfig = createDeferred<Record<string, unknown>>();
    configManagerMocks.getConfigs.mockImplementation(async () => {
      await modelConfig.promise;
      return {};
    });

    const { context } = createContext(createSession({
      workspacePath: '/home/wsp/projects/Test',
    }));

    const firstCreate = createChatSession(context, { workspacePath: '/home/wsp/projects/Test' }, 'Standard');
    const secondCreate = createChatSession(context, { workspacePath: '/home/wsp/projects/Test' }, 'Standard');

    await Promise.resolve();
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();

    modelConfig.resolve({});
    await expect(Promise.all([firstCreate, secondCreate])).resolves.toEqual([
      'created-1',
      'created-1',
    ]);

    expect(agentApiMocks.createSession).toHaveBeenCalledTimes(1);
  });

  it('does not reuse or project a session creation from a superseded device activation', async () => {
    const firstResponse = createDeferred<{ sessionId: string }>();
    const secondResponse = createDeferred<{ sessionId: string }>();
    agentApiMocks.createSession
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = createContext(createSession({ workspacePath: '/shared/repo' }));
    const second = createContext(createSession({ workspacePath: '/shared/repo' }));
    let firstCreate: Promise<string> | undefined;
    let secondCreate: Promise<string> | undefined;

    try {
      activateSurface('peer-a');
      firstCreate = createChatSession(
        first.context,
        { workspacePath: '/shared/repo' },
        'Standard',
      );
      await vi.waitFor(() => {
        expect(agentApiMocks.createSession).toHaveBeenCalledTimes(1);
      });

      activateSurface('peer-b');
      secondCreate = createChatSession(
        second.context,
        { workspacePath: '/shared/repo' },
        'Standard',
      );
      await vi.waitFor(() => {
        expect(agentApiMocks.createSession).toHaveBeenCalledTimes(2);
      });

      secondResponse.resolve({ sessionId: 'peer-b-created' });
      await expect(secondCreate).resolves.toBe('peer-b-created');
      expect(second.flowChatStore.createSession).toHaveBeenCalledTimes(1);

      firstResponse.resolve({ sessionId: 'peer-a-created' });
      await expect(firstCreate).rejects.toMatchObject({ isSurfaceChangedError: true });
      expect(first.flowChatStore.createSession).not.toHaveBeenCalled();
    } finally {
      firstResponse.resolve({ sessionId: 'peer-a-created' });
      secondResponse.resolve({ sessionId: 'peer-b-created' });
      activateSurface(LOCAL_SURFACE_ID);
      await Promise.allSettled([firstCreate, secondCreate].filter(Boolean) as Promise<string>[]);
    }
  });

  it('projects the runtime-resolved model for a newly created session', async () => {
    configManagerMocks.getConfigs.mockImplementation(async (paths: string[]) => {
      if (paths.length === 1 && paths[0] === 'ai.agent_model_defaults') {
        return { 'ai.agent_model_defaults': { mode: 'model-b' } };
      }
      return {
        'ai.agent_model_defaults': { mode: 'model-b' },
        'ai.models': [{ id: 'model-b', enabled: true, context_window: 64000 }],
        'ai.default_models': { primary: 'model-b' },
      };
    });
    const { context, flowChatStore } = createContext(createSession({
      workspacePath: '/home/wsp/projects/Test',
    }));
    agentApiMocks.createSession.mockResolvedValueOnce({
      sessionId: 'created-1',
      modelId: 'model-b',
    });

    await createChatSession(context, { workspacePath: '/home/wsp/projects/Test' }, 'Standard');

    expect(agentApiMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        modelName: undefined,
      }),
    }));
    expect(flowChatStore.createSession).toHaveBeenCalledWith(
      'created-1',
      expect.objectContaining({ modelName: 'model-b' }),
      undefined,
      expect.any(String),
      64000,
      'Standard',
      '/home/wsp/projects/Test',
      undefined,
      undefined,
      expect.any(Object),
    );
  });

  it('preserves an explicit session model instead of applying the mode default', async () => {
    configManagerMocks.getConfigs.mockResolvedValue({
      'ai.agent_model_defaults': { mode: 'model-b' },
      'ai.models': [
        { id: 'model-a', enabled: true, context_window: 32000 },
        { id: 'model-b', enabled: true, context_window: 64000 },
      ],
      'ai.default_models': { primary: 'model-b' },
    });
    const { context, flowChatStore } = createContext(createSession({
      workspacePath: '/home/wsp/projects/Test',
    }));
    agentApiMocks.createSession.mockResolvedValueOnce({
      sessionId: 'created-1',
      modelId: 'model-a',
    });

    await createChatSession(context, {
      workspacePath: '/home/wsp/projects/Test',
      modelName: 'model-a',
    }, 'Standard');

    expect(agentApiMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        modelName: 'model-a',
      }),
    }));
    expect(flowChatStore.createSession).toHaveBeenCalledWith(
      'created-1',
      expect.objectContaining({ modelName: 'model-a' }),
      undefined,
      expect.any(String),
      32000,
      'Standard',
      '/home/wsp/projects/Test',
      undefined,
      undefined,
      expect.any(Object),
    );
  });

  it('creates an observer projection without a local model or backend session', async () => {
    configManagerMocks.getConfigs.mockRejectedValue(
      new Error('No controller-side model is configured'),
    );
    const { context, flowChatStore } = createContext(createSession({
      workspacePath: '/source/repo',
    }));

    const sessionId = await createChatSession(context, {
      workspacePath: '/source/repo',
      dispatchTargetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target/repo',
      },
      dispatchTarget: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target/repo',
        displayName: 'build-host',
      },
      dispatchApprovalPolicy: 'reject-and-report',
    }, 'Standard');

    expect(sessionId).toEqual(expect.any(String));
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
    expect(flowChatStore.createSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        modelName: undefined,
        dispatchJobId: expect.any(String),
        dispatchApprovalPolicy: 'reject-and-report',
        dispatchJobState: 'submitting',
        dispatchCursor: 0,
      }),
      undefined,
      expect.any(String),
      128128,
      'Standard',
      '/home/wsp/projects/Test',
      undefined,
      undefined,
      expect.any(Object),
    );
    expect(dispatchStoreMocks.registerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        state: 'submitting',
        approvalPolicy: 'reject-and-report',
        model: undefined,
      }),
    );
    expect(configManagerMocks.getConfigs).not.toHaveBeenCalled();
  });
});

describe('forkChatSession', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the source SSH identity through fork creation and history restore', async () => {
    const source = createSession({
      sessionId: 'remote-source',
      workspacePath: '/workspace/repo',
      remoteConnectionId: 'ssh-source',
      remoteSshHost: 'source-host',
    });
    const other = createSession({
      sessionId: 'other-host-session',
      workspacePath: '/workspace/repo',
      remoteConnectionId: 'ssh-other',
      remoteSshHost: 'other-host',
    });
    const { context, flowChatStore } = createContext(source, {
      additionalSessions: [other],
      activeSessionId: other.sessionId,
    });
    sessionApiMocks.forkSession.mockResolvedValueOnce({
      sessionId: 'remote-fork',
      sessionName: 'Remote fork',
      agentType: 'Standard',
    });

    await expect(forkChatSession(context, source.sessionId, 'turn-1'))
      .resolves.toBe('remote-fork');

    expect(sessionApiMocks.forkSession).toHaveBeenCalledWith(
      'remote-source', 'turn-1', 'workspace-1',
    );
    expect(flowChatStore.getState().sessions.get('remote-fork')).toMatchObject({
      workspacePath: '/workspace/repo',
      remoteConnectionId: 'ssh-source',
      remoteSshHost: 'source-host',
    });
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledWith('remote-fork', { deferFullHistoryUntilActive: true });
  });
});

describe('reloadSessionTitle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replaces only the existing title from authoritative remote metadata', async () => {
    const dialogTurns = [{ id: 'turn-1' }] as Session['dialogTurns'];
    const session = createSession({
      title: 'Stale title',
      dialogTurns,
      workspacePath: '/remote/worktree',
      projectWorkspacePath: '/remote/project',
      remoteConnectionId: 'connection-1',
      remoteSshHost: 'ssh.example.test',
    });
    const { context, flowChatStore } = createContext(session);
    sessionApiMocks.loadSessionMetadata.mockResolvedValue({
      sessionId: session.sessionId,
      sessionName: 'Authoritative title',
      turnCount: 1,
      customMetadata: null,
    });

    await reloadSessionTitle(context, session.sessionId);

    expect(sessionApiMocks.loadSessionMetadata).toHaveBeenCalledWith(
      session.sessionId,
      'workspace-1',
    );
    const updated = flowChatStore.getState().sessions.get(session.sessionId);
    expect(updated?.title).toBe('Authoritative title');
    expect(updated?.dialogTurns).toBe(dialogTurns);
    expect(updated?.workspacePath).toBe('/remote/worktree');
  });
});

describe('SessionModule historical session coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dispatchStoreMocks.jobs = {};
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    clearRecentHistorySessionOpenIntent();
    clearHistorySessionOpenTransition();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('hydrates a metadata-only historical session before switching to avoid an empty loading page', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    const switching = switchChatSession(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.switchSession).not.toHaveBeenCalled();
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

    load.resolve();
    await switching;

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
  });

  it('does not select a hydrated session after its scene navigation was cancelled', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    let relevant = true;
    const switching = switchChatSession(context, 'history-1', () => relevant);
    await Promise.resolve();
    relevant = false;
    load.resolve();
    await switching;
    expect(flowChatStore.switchSession).not.toHaveBeenCalled();
  });

  it('activates a metadata-only historical session immediately when a recent user open intent exists', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    dispatchHistorySessionOpenIntent('history-1', 'Saved session');
    const switching = switchChatSession(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();

    load.resolve();
    await switching;

    expect(flowChatStore.switchSession).toHaveBeenCalledTimes(1);
  });

  it('keeps metadata-only historical sessions out of the active render path until hydrated', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    const switching = switchChatSession(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(flowChatStore.switchSession).not.toHaveBeenCalled();

    load.resolve();
    await switching;

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
  });

  it('defers activity touch until a metadata-only historical session has hydrated and switched', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    const switching = switchChatSession(context, 'history-1');
    await Promise.resolve();

    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();

    load.resolve();
    await switching;
    await Promise.resolve();

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_ACTIVITY_TOUCH_DELAY_MS - 1);
    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persistenceMocks.touchSessionActivity).toHaveBeenCalledWith(
      'history-1',
      'workspace-1',
    );
  });

  it('switches immediately when a historical session already has renderable tail content', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession({
      historyState: 'ready',
      dialogTurns: [{
        id: 'turn-1',
        userMessage: { id: 'user-turn-1', content: 'Latest prompt', timestamp: 1 },
        modelRounds: [],
        status: 'completed',
      } as any],
    }));
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    await switchChatSession(context, 'history-1');

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

    load.resolve();
    await load.promise;
  });

  it('touches only the latest active session during rapid switches', async () => {
    const firstSession = createSession({
      sessionId: 'history-1',
      historyState: 'ready',
      dialogTurns: [{ id: 'turn-1', userMessage: { content: 'one' } } as any],
    });
    const secondSession = createSession({
      sessionId: 'history-2',
      historyState: 'ready',
      dialogTurns: [{ id: 'turn-2', userMessage: { content: 'two' } } as any],
    });
    const { context, flowChatStore } = createContext(firstSession);
    flowChatStore.setState((prev: any) => ({
      ...prev,
      sessions: new Map(prev.sessions).set(secondSession.sessionId, secondSession),
    }));
    flowChatStore.loadSessionHistory.mockResolvedValue(undefined);
    persistenceMocks.touchSessionActivity.mockResolvedValue(undefined);

    await switchChatSession(context, 'history-1');
    await switchChatSession(context, 'history-2');

    expect(flowChatStore.switchSession).toHaveBeenNthCalledWith(1, 'history-1');
    expect(flowChatStore.switchSession).toHaveBeenNthCalledWith(2, 'history-2');
    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_ACTIVITY_TOUCH_DELAY_MS);

    expect(persistenceMocks.touchSessionActivity).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.touchSessionActivity).toHaveBeenCalledWith(
      'history-2',
      'workspace-1',
    );
  });

  it('does not touch activity when the delayed session no longer exists', async () => {
    const session = createSession({
      historyState: 'ready',
      dialogTurns: [{ id: 'turn-1', userMessage: { content: 'one' } } as any],
    });
    const { context, flowChatStore } = createContext(session);
    persistenceMocks.touchSessionActivity.mockResolvedValue(undefined);

    await switchChatSession(context, 'history-1');
    flowChatStore.setState((prev: any) => ({
      ...prev,
      sessions: new Map(),
    }));

    await vi.advanceTimersByTimeAsync(SESSION_ACTIVITY_TOUCH_DELAY_MS);

    expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();
  });

  it('does not touch activity on the device activated after the delay was scheduled', async () => {
    const session = createSession({
      historyState: 'ready',
      dialogTurns: [{ id: 'turn-1', userMessage: { content: 'one' } } as any],
    });
    const { context } = createContext(session);
    persistenceMocks.touchSessionActivity.mockResolvedValue(undefined);

    try {
      activateSurface('peer-a');
      await switchChatSession(context, 'history-1');

      activateSurface('peer-b');
      await vi.advanceTimersByTimeAsync(SESSION_ACTIVITY_TOUCH_DELAY_MS);

      expect(persistenceMocks.touchSessionActivity).not.toHaveBeenCalled();
    } finally {
      activateSurface(LOCAL_SURFACE_ID);
    }
  });

  it('does not block remote metadata-only historical sessions on local pre-hydration before switching', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession({
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'remote-host',
    }));
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    await switchChatSession(context, 'history-1');

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

    load.resolve();
    await load.promise;
  });

  it('preloads a local metadata-only historical session during a competing history load without switching', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);

    preloadHistoricalSessionForOpen(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(flowChatStore.switchSession).not.toHaveBeenCalled();

    load.resolve();
    await load.promise;
  });

  it('deduplicates concurrent detail hydration and includes internal child output', async () => {
    const load = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession({
      isHistorical: false,
      historyState: 'new',
      sessionKind: 'subagent',
    }));
    flowChatStore.loadSessionHistory.mockReturnValueOnce(load.promise);

    const first = hydrateSessionHistoryForDetail(context, 'history-1');
    const second = hydrateSessionHistoryForDetail(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledWith('history-1', { includeInternal: true, deferFullHistoryUntilActive: false });

    load.resolve();
    await Promise.all([first, second]);
  });

  it('does not reuse a same-id history load from another device activation', async () => {
    const firstLoad = createDeferred<void>();
    const secondLoad = createDeferred<void>();
    const first = createContext(createSession());
    const second = createContext(createSession());
    const sharedPendingLoads = new Map<string, Promise<void>>();
    const sharedCapabilities = new Map();
    first.context.pendingHistoryLoads = sharedPendingLoads;
    second.context.pendingHistoryLoads = sharedPendingLoads;
    first.context.pendingHistoryLoadCapabilities = sharedCapabilities;
    second.context.pendingHistoryLoadCapabilities = sharedCapabilities;
    first.flowChatStore.loadSessionHistory.mockReturnValueOnce(firstLoad.promise);
    second.flowChatStore.loadSessionHistory.mockReturnValueOnce(secondLoad.promise);
    let firstHydrate: Promise<void> | undefined;
    let secondHydrate: Promise<void> | undefined;

    try {
      activateSurface('peer-a');
      firstHydrate = hydrateSessionHistoryForDetail(first.context, 'history-1');
      expect(first.flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

      activateSurface('peer-b');
      secondHydrate = hydrateSessionHistoryForDetail(second.context, 'history-1');
      expect(second.flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
      expect(sharedPendingLoads.size).toBe(2);

      secondLoad.resolve();
      await expect(secondHydrate).resolves.toBeUndefined();

      firstLoad.resolve();
      await expect(firstHydrate).rejects.toMatchObject({ isSurfaceChangedError: true });
      expect(sharedPendingLoads.size).toBe(0);
    } finally {
      firstLoad.resolve();
      secondLoad.resolve();
      activateSurface(LOCAL_SURFACE_ID);
      await Promise.allSettled([firstHydrate, secondHydrate].filter(Boolean) as Promise<void>[]);
    }
  });

  it('uses the session ID binding when its path projection is missing', async () => {
    const { context, flowChatStore } = createContext(createSession({
      workspacePath: undefined,
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
      sessionKind: 'subagent',
    }));

    await hydrateSessionHistoryForDetail(context, 'history-1');

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledWith('history-1', { includeInternal: true, deferFullHistoryUntilActive: false });
  });

  it('restores by session workspace ID even when location projections are missing', async () => {
    const { context, flowChatStore } = createContext(createSession({
      workspacePath: undefined,
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
      sessionKind: 'subagent',
    }));

    const weakHydrate = hydrateSessionHistoryForDetail(context, 'history-1');
    const strongHydrate = hydrateSessionHistoryForDetail(context, 'history-1');

    await expect(weakHydrate).resolves.toBeUndefined();
    await expect(strongHydrate).resolves.toBeUndefined();
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledWith('history-1', { includeInternal: true, deferFullHistoryUntilActive: false });
  });

  it('upgrades a weaker in-flight preload before showing subagent details', async () => {
    const preload = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession({
      sessionKind: 'subagent',
    }));
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());
    flowChatStore.loadSessionHistory
      .mockReturnValueOnce(preload.promise)
      .mockResolvedValueOnce(undefined);

    preloadHistoricalSessionForOpen(context, 'history-1');
    await Promise.resolve();
    const detailHydrate = hydrateSessionHistoryForDetail(context, 'history-1');

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

    preload.resolve();
    await detailHydrate;

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(2);
    expect(flowChatStore.loadSessionHistory).toHaveBeenNthCalledWith(2, 'history-1', { includeInternal: true, deferFullHistoryUntilActive: false });
  });

  it('retries a reused preload that stale-skipped after explicit activation', async () => {
    const stalePreload = createDeferred<void>();
    const retryLoad = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());
    persistenceMocks.touchSessionActivity.mockResolvedValue(undefined);
    flowChatStore.loadSessionHistory
      .mockReturnValueOnce(stalePreload.promise)
      .mockImplementationOnce(async () => {
        await retryLoad.promise;
        flowChatStore.setState((prev: any) => {
          const session = prev.sessions.get('history-1');
          return {
            ...prev,
            sessions: new Map(prev.sessions).set('history-1', {
              ...session,
              isHistorical: false,
              historyState: 'ready',
              dialogTurns: [{
                id: 'turn-1',
                userMessage: { id: 'user-1', content: 'Restored prompt', timestamp: 1 },
                modelRounds: [],
                status: 'completed',
              }],
            }),
          };
        });
      });

    preloadHistoricalSessionForOpen(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(1);

    dispatchHistorySessionOpenIntent('history-1', 'Saved session');
    const switching = switchChatSession(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');

    stalePreload.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(2);

    retryLoad.resolve();
    await switching;

    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
    });
  });

  it('does not retry a reused stale preload after a newer switch request supersedes it', async () => {
    const stalePreload = createDeferred<void>();
    const newerSwitchLoad = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());
    flowChatStore.setState((prev: any) => ({
      ...prev,
      sessions: new Map(prev.sessions).set('history-2', createSession({
        sessionId: 'history-2',
        title: 'Newer target',
      })),
    }));
    persistenceMocks.touchSessionActivity.mockResolvedValue(undefined);
    flowChatStore.loadSessionHistory
      .mockReturnValueOnce(stalePreload.promise)
      .mockImplementationOnce(async () => {
        await newerSwitchLoad.promise;
        flowChatStore.setState((prev: any) => {
          const session = prev.sessions.get('history-2');
          return {
            ...prev,
            sessions: new Map(prev.sessions).set('history-2', {
              ...session,
              isHistorical: false,
              historyState: 'ready',
              dialogTurns: [{
                id: 'turn-2',
                userMessage: { id: 'user-2', content: 'Newer prompt', timestamp: 1 },
                modelRounds: [],
                status: 'completed',
              }],
            }),
          };
        });
      });

    preloadHistoricalSessionForOpen(context, 'history-1');
    await Promise.resolve();

    dispatchHistorySessionOpenIntent('history-1', 'Saved session');
    const firstSwitch = switchChatSession(context, 'history-1');
    await Promise.resolve();
    expect(flowChatStore.switchSession).toHaveBeenCalledWith('history-1');

    const secondSwitch = switchChatSession(context, 'history-2');
    await Promise.resolve();
    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(2);

    stalePreload.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).toHaveBeenCalledTimes(2);

    newerSwitchLoad.resolve();
    await firstSwitch;
    await secondSwitch;

    expect(flowChatStore.switchSession).toHaveBeenLastCalledWith('history-2');
  });

  it('does not preload standalone historical opens before the transition shield paints', () => {
    const { context, flowChatStore } = createContext(createSession());

    preloadHistoricalSessionForOpen(context, 'history-1');

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();
  });

  it('does not preload remote or already renderable historical sessions', async () => {
    const remoteSession = createSession({
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'remote-host',
    });
    const { context, flowChatStore } = createContext(remoteSession);
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-other'), Promise.resolve());

    preloadHistoricalSessionForOpen(context, 'history-1');

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();

    flowChatStore.setState((prev: any) => ({
      ...prev,
      sessions: new Map(prev.sessions).set('history-1', createSession({
        dialogTurns: [{
          id: 'turn-1',
          userMessage: { id: 'user-1', content: 'Existing prompt', timestamp: 1 },
          modelRounds: [],
        } as any],
      })),
    }));

    preloadHistoricalSessionForOpen(context, 'history-1');

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();
  });

  it('returns to the welcome state after deleting an empty new active session', async () => {
    const activeSession = createSession({
      sessionId: 'active-1',
      title: 'Current session',
      isHistorical: false,
      historyState: 'new',
    });
    const fallbackSession = createSession({
      sessionId: 'history-2',
      title: 'Assistant session',
    });
    const { context, flowChatStore, processingManager } = createContext(activeSession, {
      additionalSessions: [fallbackSession],
      activeSessionId: 'active-1',
      deleteSessionImpl: async (
        deletedSessionId: string,
        deleteOptions?: { nextActiveSessionId?: string | null },
      ) => {
        expect(deletedSessionId).toBe('active-1');
        expect(deleteOptions).toEqual({ nextActiveSessionId: null });
        flowChatStore.setState((prev: any) => {
          const nextSessions = new Map(prev.sessions);
          nextSessions.delete(deletedSessionId);
          return {
            ...prev,
            sessions: nextSessions,
            activeSessionId: deleteOptions && 'nextActiveSessionId' in deleteOptions
              ? deleteOptions.nextActiveSessionId ?? null
              : 'history-2',
          };
        });
      },
    });
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    const deleting = deleteChatSession(context, 'active-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(flowChatStore.deleteSession).toHaveBeenCalledWith(
      'active-1',
      { nextActiveSessionId: null },
    );
    await deleting;

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();
    expect(flowChatStore.getState().activeSessionId).toBeNull();
    expect(processingManager.clearSessionStatus).toHaveBeenCalledWith('active-1');
    expect(persistenceMocks.cleanupSaveState).toHaveBeenCalledWith(context, 'active-1');
  });

  it.each([
    ['deleting', deleteChatSession],
    ['archiving', archiveChatSession],
  ] as const)('cancels a speculative history-open transition when %s its target', async (_action, removeSession) => {
    const historicalSession = createSession({
      sessionId: 'history-delete',
      isHistorical: true,
      historyState: 'metadata-only',
      dialogTurns: [],
    });
    const { context } = createContext(historicalSession, {
      activeSessionId: null,
    });

    dispatchHistorySessionOpenIntent(historicalSession.sessionId, 'Saved session');
    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({
      sessionId: historicalSession.sessionId,
    });

    await removeSession(context, historicalSession.sessionId);

    expect(getHistorySessionOpenTransitionSnapshot()).toBeNull();
  });

  it('tombstones a deleted dispatch projection instead of deleting a local session', async () => {
    const session = createSession({
      sessionId: 'dispatch-session',
      isHistorical: false,
      config: {
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '/target/repo',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
      },
    });
    const { context, flowChatStore } = createContext(session, {
      activeSessionId: session.sessionId,
    });

    await deleteChatSession(context, session.sessionId);

    expect(dispatchStoreMocks.dismissSession).toHaveBeenCalledWith(
      session.sessionId,
      'job-1',
    );
    expect(flowChatStore.removeSession).toHaveBeenCalledWith(
      session.sessionId,
      { nextActiveSessionId: null },
    );
    expect(flowChatStore.deleteSession).not.toHaveBeenCalled();
  });

  it('deletes a dispatch projection found only through the observer job index', async () => {
    const session = createSession({
      sessionId: 'dispatch-session',
      isHistorical: false,
      config: { agentType: 'Standard' },
    });
    dispatchStoreMocks.jobs = {
      'job-1': { sessionId: session.sessionId },
    };
    const { context, flowChatStore } = createContext(session, {
      activeSessionId: session.sessionId,
    });

    await deleteChatSession(context, session.sessionId);

    expect(dispatchStoreMocks.dismissSession).toHaveBeenCalledWith(
      session.sessionId,
      undefined,
    );
    expect(flowChatStore.removeSession).toHaveBeenCalledWith(
      session.sessionId,
      { nextActiveSessionId: null },
    );
    expect(flowChatStore.deleteSession).not.toHaveBeenCalled();
  });

  it('returns to the welcome state after deleting a non-empty active session', async () => {
    const activeSession = createSession({
      sessionId: 'active-1',
      title: 'Current session',
      isHistorical: false,
      historyState: 'ready',
      dialogTurns: [{
        id: 'turn-1',
        userMessage: { id: 'user-1', content: 'hello', timestamp: 1 },
        modelRounds: [],
        status: 'completed',
      } as any],
    });
    const fallbackSession = createSession({
      sessionId: 'history-2',
      title: 'Assistant session',
    });
    const { context, flowChatStore, processingManager } = createContext(activeSession, {
      additionalSessions: [fallbackSession],
      activeSessionId: 'active-1',
      deleteSessionImpl: async (
        deletedSessionId: string,
        deleteOptions?: { nextActiveSessionId?: string | null },
      ) => {
        expect(deletedSessionId).toBe('active-1');
        expect(deleteOptions).toEqual({ nextActiveSessionId: null });
        flowChatStore.setState((prev: any) => {
          const nextSessions = new Map(prev.sessions);
          nextSessions.delete(deletedSessionId);
          return {
            ...prev,
            sessions: nextSessions,
            activeSessionId: deleteOptions && 'nextActiveSessionId' in deleteOptions
              ? deleteOptions.nextActiveSessionId ?? null
              : 'history-2',
          };
        });
      },
    });
    persistenceMocks.touchSessionActivity.mockResolvedValueOnce(undefined);

    const deleting = deleteChatSession(context, 'active-1');
    await Promise.resolve();

    expect(flowChatStore.deleteSession).toHaveBeenCalledWith(
      'active-1',
      { nextActiveSessionId: null },
    );
    await deleting;

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();
    expect(flowChatStore.switchSession).not.toHaveBeenCalled();
    expect(flowChatStore.getState().activeSessionId).toBeNull();
    expect(processingManager.clearSessionStatus).toHaveBeenCalledWith('active-1');
    expect(persistenceMocks.cleanupSaveState).toHaveBeenCalledWith(context, 'active-1');
  });

  it('returns to the welcome state after archiving an active session', async () => {
    const activeSession = createSession({
      sessionId: 'active-1',
      title: 'Current session',
      isHistorical: false,
      historyState: 'ready',
    });
    const fallbackSession = createSession({
      sessionId: 'history-2',
      title: 'Assistant session',
    });
    const { context, flowChatStore, processingManager } = createContext(activeSession, {
      additionalSessions: [fallbackSession],
      activeSessionId: 'active-1',
    });
    sessionApiMocks.archiveSession.mockResolvedValueOnce(undefined);

    await archiveChatSession(context, 'active-1');

    expect(sessionApiMocks.archiveSession).toHaveBeenCalledWith(
      'active-1',
      'workspace-1',
    );
    expect(flowChatStore.removeSession).toHaveBeenCalledWith(
      'active-1',
      { nextActiveSessionId: null },
    );
    expect(flowChatStore.getState().activeSessionId).toBeNull();
    expect(stateMachineMocks.delete).toHaveBeenCalledWith('active-1');
    expect(processingManager.clearSessionStatus).toHaveBeenCalledWith('active-1');
    expect(persistenceMocks.cleanupSaveState).toHaveBeenCalledWith(context, 'active-1');
    expect(persistenceMocks.cleanupSessionBuffers).toHaveBeenCalledWith(context, 'active-1');
  });

  it('reuses pending historical hydration before ensuring the backend session', async () => {
    const pendingHydrate = createDeferred<void>();
    const { context, flowChatStore } = createContext(createSession());
    context.pendingHistoryLoads.set(pendingHistoryLoadKey('history-1'), pendingHydrate.promise);
    agentApiMocks.ensureCoordinatorSession.mockResolvedValueOnce(undefined);

    const ensure = ensureBackendSession(context, 'history-1');
    await Promise.resolve();

    expect(flowChatStore.loadSessionHistory).not.toHaveBeenCalled();
    expect(agentApiMocks.ensureCoordinatorSession).not.toHaveBeenCalled();

    pendingHydrate.resolve();
    await ensure;

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
  });

  it('restores pending backend context for a view-restored session before send', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [{ id: 'turn-1' } as any],
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockResolvedValueOnce(undefined);

    await ensureBackendSession(context, 'history-1');

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      contextRestoreState: 'ready',
    });
  });

  it('restores view-restored subagent sessions as internal coordinator sessions before send', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [{ id: 'turn-1' } as any],
      sessionKind: 'subagent',
      parentSessionId: 'parent-1',
      subagentType: 'GeneralPurpose',
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockResolvedValueOnce(undefined);

    await ensureBackendSession(context, 'history-1');

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'history-1',
        includeInternal: true,
      }),
    );
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      contextRestoreState: 'ready',
    });
  });

  it('dedupes concurrent backend context restore for a view-restored session', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [{ id: 'turn-1' } as any],
    } as any));
    const restore = createDeferred<void>();
    agentApiMocks.ensureCoordinatorSession.mockReturnValueOnce(restore.promise);

    const firstEnsure = ensureBackendSession(context, 'history-1');
    const secondEnsure = ensureBackendSession(context, 'history-1');
    await Promise.resolve();

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);

    restore.resolve();
    await Promise.all([firstEnsure, secondEnsure]);

    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
    expect(context.pendingContextRestores.size).toBe(0);
    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      contextRestoreState: 'ready',
    });
  });

  it('does not reuse or commit a same-id context restore across device activations', async () => {
    const createRestoringContext = () => createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [{ id: 'turn-1' } as any],
    } as any));
    const first = createRestoringContext();
    const second = createRestoringContext();
    const sharedRestores = new Map<string, Promise<void>>();
    first.context.pendingContextRestores = sharedRestores;
    second.context.pendingContextRestores = sharedRestores;
    const firstRestore = createDeferred<void>();
    const secondRestore = createDeferred<void>();
    agentApiMocks.ensureCoordinatorSession
      .mockReturnValueOnce(firstRestore.promise)
      .mockReturnValueOnce(secondRestore.promise);
    let firstEnsure: Promise<void> | undefined;
    let secondEnsure: Promise<void> | undefined;

    try {
      activateSurface('peer-a');
      firstEnsure = ensureBackendSession(first.context, 'history-1');
      expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);

      activateSurface('peer-b');
      secondEnsure = ensureBackendSession(second.context, 'history-1');
      expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(2);
      expect(sharedRestores.size).toBe(2);

      secondRestore.resolve();
      await expect(secondEnsure).resolves.toBeUndefined();
      expect(second.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        contextRestoreState: 'ready',
      });

      firstRestore.resolve();
      await expect(firstEnsure).rejects.toMatchObject({ isSurfaceChangedError: true });
      expect(first.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
        contextRestoreState: 'pending',
      });
      expect(sharedRestores.size).toBe(0);
    } finally {
      firstRestore.resolve();
      secondRestore.resolve();
      activateSurface(LOCAL_SURFACE_ID);
      await Promise.allSettled([firstEnsure, secondEnsure].filter(Boolean) as Promise<void>[]);
    }
  });

  it('does not recreate a view-restored session with loaded turns when context restore fails', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [{ id: 'turn-1' } as any],
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('Session metadata not found')
    );

    await expect(ensureBackendSession(context, 'history-1')).rejects.toThrow();

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      contextRestoreState: 'failed',
    });
  });

  it('does not recreate metadata-only non-empty history when context restore fails', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [],
      totalTurnCount: 23,
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('Session metadata not found')
    );

    await expect(ensureBackendSession(context, 'history-1')).rejects.toThrow();

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
  });

  it('does not recreate a session that another OpenBitFun instance is writing', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [],
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('session_in_use: Session is already open for writing: history-1')
    );

    await expect(ensureBackendSession(context, 'history-1')).rejects.toThrow(
      'session_in_use:',
    );

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).not.toHaveBeenCalled();
  });

  it('keeps recreate fallback for empty pending context sessions', async () => {
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [],
    } as any));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('Session metadata not found')
    );
    agentApiMocks.createSession.mockResolvedValueOnce(undefined);

    await ensureBackendSession(context, 'history-1');

    expect(agentApiMocks.ensureCoordinatorSession).toHaveBeenCalledTimes(1);
    expect(agentApiMocks.createSession).toHaveBeenCalledTimes(1);
    expect(context.flowChatStore.getState().sessions.get('history-1')).toMatchObject({
      contextRestoreState: 'ready',
    });
  });

  it('recreates child sessions with structured relationship and deep review manifest', async () => {
    const deepReviewRunManifest = {
      workPackets: [],
      activeReviewers: [],
      optionalReviewers: [],
    } satisfies ReviewTeamRunManifest;
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      dialogTurns: [],
      sessionKind: 'deep_review',
      parentSessionId: 'parent-1',
      btwOrigin: {
        requestId: 'req-1',
        parentSessionId: 'parent-1',
        parentDialogTurnId: 'turn-9',
        parentTurnIndex: 9,
      },
      deepReviewRunManifest,
    }));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('Session metadata not found')
    );
    agentApiMocks.createSession.mockResolvedValueOnce(undefined);

    await ensureBackendSession(context, 'history-1');

    expect(agentApiMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        relationship: {
          kind: 'deep_review',
          parentSessionId: 'parent-1',
          parentRequestId: 'req-1',
          parentDialogTurnId: 'turn-9',
          parentTurnIndex: 9,
          parentToolCallId: null,
          subagentType: null,
        },
        deepReviewRunManifest,
      })
    );
  });

  it('recreates standard Review sessions with prepared target evidence', async () => {
    const reviewTargetEvidence = {
      version: 1,
      source: 'pull_request',
      fingerprint: 'review-target-fingerprint',
      baseRevision: '1'.repeat(40),
      headRevision: '2'.repeat(40),
      completeness: 'complete',
      workspaceBinding: 'unavailable',
      files: [],
      limitations: [],
      omittedFileCount: 0,
    } as Session['reviewTargetEvidence'];
    const { context } = createContext(createSession({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
      sessionKind: 'review',
      parentSessionId: 'parent-1',
      reviewTargetEvidence,
    }));
    agentApiMocks.ensureCoordinatorSession.mockRejectedValueOnce(
      new Error('Session metadata not found')
    );
    agentApiMocks.createSession.mockResolvedValueOnce(undefined);

    await ensureBackendSession(context, 'history-1');

    expect(agentApiMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ reviewTargetEvidence })
    );
  });

  it('retries child sessions with structured subagent relationship', async () => {
    const { context } = createContext(createSession({
      sessionId: 'subagent-1',
      isHistorical: false,
      historyState: 'ready',
      sessionKind: 'subagent',
      parentSessionId: 'parent-1',
      parentToolCallId: 'tool-7',
      subagentType: 'ReviewSecurity',
      btwOrigin: {
        parentSessionId: 'parent-1',
        parentDialogTurnId: 'turn-5',
        parentTurnIndex: 5,
      },
    }));
    agentApiMocks.createSession.mockResolvedValueOnce(undefined);

    await retryCreateBackendSession(context, 'subagent-1');

    expect(agentApiMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'subagent-1',
        relationship: {
          kind: 'subagent',
          parentSessionId: 'parent-1',
          parentRequestId: null,
          parentDialogTurnId: 'turn-5',
          parentTurnIndex: 5,
          parentToolCallId: 'tool-7',
          subagentType: 'ReviewSecurity',
        },
      })
    );
  });
});
