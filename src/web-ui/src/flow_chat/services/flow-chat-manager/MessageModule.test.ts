import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSessionTask,
  drainPendingQueue,
  installPendingQueueDrainListener,
  sendMessage,
  syncSessionModelSelection,
} from './MessageModule';
import { SessionExecutionEvent } from '../../state-machine/types';
import {
  getRuntimeStatus,
  resetRuntimeStatuses,
} from '../../store/runtimeStatusStore';
import {
  tryBeginSessionMutation,
  useSessionMutationStore,
} from '../../store/sessionMutationStore';
import { interruptedTurnRecoveryGate } from '../interruptedTurnRecoveryGate';
import {
  LOCAL_SURFACE_ID,
  activateSurface,
} from '@/infrastructure/peer-device/deviceSurface';

import { beginRuntimeSessionAttachment } from '@/infrastructure/peer-device/runtimeSessionEventGate';

const mockSubscribeGlobal = vi.fn();
const mockTransition = vi.fn();
const mockGetCurrentState = vi.fn(() => 'processing');
const mockGetStateMachine = vi.fn(() => null);
const mockResetForSurface = vi.fn();
const mockUpdateSessionModel = vi.fn();
const mockStartDialogTurn = vi.fn();
const mockGetConfigs = vi.fn();
const mockDispatchSubmit = vi.fn();
const mockDispatchAppend = vi.fn();
const mockDispatchProgress = vi.fn();
const mockDispatchRefresh = vi.fn();
const mockBindSession = vi.fn();
const mockEnsureBackendSession = vi.fn();
const mockNotificationError = vi.fn();
const mockNotificationDismiss = vi.fn();
const mockPendingList = vi.fn((): unknown[] => []);
const mockPendingEnqueue = vi.fn();
const mockPendingEnqueueForSurface = vi.fn();
const mockPendingSetStatus = vi.fn();
const mockPendingRemove = vi.fn();

vi.mock('../../state-machine', () => ({
  SessionExecutionEvent: {
    FINISHING_SETTLED: 'finishing_settled',
    USER_CANCEL: 'user_cancel',
  },
  SessionExecutionState: {
    IDLE: 'idle',
    PROCESSING: 'processing',
    FINISHING: 'finishing',
  },
  stateMachineManager: {
    subscribeGlobal: (...args: unknown[]) => mockSubscribeGlobal(...args),
    getCurrentState: (...args: unknown[]) => mockGetCurrentState(...args),
    get: (...args: unknown[]) => mockGetStateMachine(...args),
    transition: (...args: any[]) => mockTransition(...args),
    resetForSurface: (...args: unknown[]) => mockResetForSurface(...args),
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    startDialogTurn: (...args: unknown[]) => mockStartDialogTurn(...args),
    updateSessionModel: (...args: unknown[]) => mockUpdateSessionModel(...args),
  },
}));

vi.mock('@/infrastructure/api/service-api/WorktreeAPI', () => ({
  worktreeAPI: {
    bindSession: (...args: unknown[]) => mockBindSession(...args),
  },
}));

vi.mock('@/features/dispatch/dispatchApi', () => ({
  dispatchApi: {
    submit: (...args: unknown[]) => mockDispatchSubmit(...args),
    append: (...args: unknown[]) => mockDispatchAppend(...args),
  },
}));

vi.mock('@/features/dispatch/dispatchJobStore', () => ({
  dispatchJobStore: {
    getState: () => ({
      updateProgress: (...args: unknown[]) => mockDispatchProgress(...args),
    }),
  },
}));

vi.mock('@/features/dispatch/DispatchJobObserver', () => ({
  requestDispatchJobRefresh: (...args: unknown[]) => mockDispatchRefresh(...args),
}));

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {},
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: (...args: unknown[]) => mockGetConfigs(...args),
  },
}));

vi.mock('../../../shared/notification-system', () => ({
  notificationService: {
    error: (...args: unknown[]) => mockNotificationError(...args),
    dismiss: (...args: unknown[]) => mockNotificationDismiss(...args),
  },
}));

vi.mock('./SessionModule', () => ({
  ensureBackendSession: (...args: unknown[]) => mockEnsureBackendSession(...args),
  getModelMaxTokens: vi.fn(async (modelId: string) => modelId === 'primary' ? 32000 : 64000),
  retryCreateBackendSession: vi.fn(),
}));

vi.mock('./PendingQueueModule', () => ({
  pendingQueueManager: {
    list: (...args: unknown[]) => mockPendingList(...args),
    enqueue: (...args: unknown[]) => mockPendingEnqueue(...args),
    enqueueForSurface: (...args: unknown[]) => mockPendingEnqueueForSurface(...args),
    setStatus: (...args: unknown[]) => mockPendingSetStatus(...args),
    remove: (...args: unknown[]) => mockPendingRemove(...args),
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

describe('MessageModule Session mutation admission', () => {
  beforeEach(() => {
    useSessionMutationStore.setState({ mutations: new Map(), retiredTurnIds: new Map() });
  });
  afterEach(() => {
    useSessionMutationStore.setState({ mutations: new Map(), retiredTurnIds: new Map() });
  });

  it('rejects an ordinary submission while Session history is mutating', async () => {
    const session = {
      sessionId: 'session-mutating',
      mode: 'Standard',
      dialogTurns: [],
      config: {},
      titleStatus: 'generated',
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
      },
    };
    tryBeginSessionMutation(session.sessionId, 'rollback', 'turn-7');

    await expect(sendMessage(context, 'interleaving prompt', session.sessionId)).rejects.toThrow(
      'history mutation',
    );
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
  });
});

describe('MessageModule session writer conflict', () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function conflictContext(sessionId: string) {
    const session = {
      sessionId,
      mode: 'Standard',
      dialogTurns: [] as any[],
      config: { modelName: 'primary' },
      titleStatus: 'generated',
      maxContextTokens: 32000,
    };
    return {
      session,
      context: {
        flowChatStore: {
          getSurfaceGeneration: () => 0,
          getState: () => ({ sessions: new Map([[sessionId, session]]) }),
          addDialogTurn: vi.fn((_id: string, turn: any) => session.dialogTurns.push(turn)),
          deleteDialogTurn: vi.fn((_id: string, turnId: string) => {
            session.dialogTurns = session.dialogTurns.filter(turn => turn.id !== turnId);
          }),
          updateSessionLastSubmittedMode: vi.fn(),
          updateSessionMode: vi.fn(),
          updateSessionModelName: vi.fn(),
          updateSessionMaxContextTokens: vi.fn(),
        },
        processingManager: {
          registerStatus: vi.fn(),
          clearSessionStatus: vi.fn(),
        },
        pendingHistoryLoads: new Map(),
        contentBuffers: new Map(),
        activeTextItems: new Map(),
      } as any,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetCurrentState.mockReturnValue('idle');
    mockGetStateMachine.mockReturnValue(null);
    mockTransition.mockResolvedValue(true);
    mockUpdateSessionModel.mockResolvedValue(undefined);
    mockStartDialogTurn.mockResolvedValue(undefined);
    mockPendingList.mockReturnValue([]);
    mockPendingEnqueue.mockReturnValue({ id: 'queued-message' });
    mockEnsureBackendSession.mockRejectedValue(
      new Error('session_in_use: Session is already open for writing: session-1'),
    );
    mockNotificationError
      .mockReturnValueOnce('notification-1')
      .mockReturnValueOnce('notification-2')
      .mockReturnValue('notification-3');
  });

  it('keeps only the latest explicit retry for one conflicted session', async () => {
    const session = {
      sessionId: 'session-1',
      mode: 'Standard',
      dialogTurns: [],
      config: {},
      titleStatus: 'generated',
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([['session-1', session]]) }),
        deleteDialogTurn: vi.fn(),
      },
      pendingHistoryLoads: new Map(),
    };

    await expect(sendMessage(context, 'hello', 'session-1')).rejects.toThrow(
      'session_in_use',
    );

    expect(context.flowChatStore.deleteDialogTurn).not.toHaveBeenCalled();
    expect(mockEnsureBackendSession).toHaveBeenCalledTimes(1);
    expect(mockNotificationError).toHaveBeenCalledTimes(1);
    const [message, options] = mockNotificationError.mock.calls[0];
    expect(message).toBe('flow-chat:session.inUseMessage');
    expect(options).toMatchObject({
      title: 'flow-chat:session.inUseTitle',
      duration: 0,
    });
    expect(options.actions).toHaveLength(1);
    expect(options.actions[0].label).toBe('flow-chat:session.retry');

    await expect(sendMessage(context, 'hello', 'session-1')).rejects.toThrow(
      'session_in_use',
    );
    expect(mockNotificationDismiss).toHaveBeenCalledWith('notification-1');
    const staleAction = options.actions[0];
    const latestAction = mockNotificationError.mock.calls[1][1].actions[0];

    staleAction.onClick();
    expect(mockEnsureBackendSession).toHaveBeenCalledTimes(2);

    latestAction.onClick();
    latestAction.onClick();
    await vi.waitFor(() => {
      expect(mockEnsureBackendSession).toHaveBeenCalledTimes(3);
    });
  });

  it('does not let an older retry failure replace a newer conflict', async () => {
    const sessionId = 'session-race-failure';
    const { context } = conflictContext(sessionId);
    const conflict = new Error(`session_in_use: Session is already open for writing: ${sessionId}`);

    await expect(sendMessage(context, 'older', sessionId)).rejects.toThrow('session_in_use');
    const retryAction = mockNotificationError.mock.calls[0][1].actions[0];
    const olderRetry = deferred<void>();
    const newerSend = deferred<void>();
    mockEnsureBackendSession
      .mockImplementationOnce(() => olderRetry.promise)
      .mockImplementationOnce(() => newerSend.promise);

    retryAction.onClick();
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(2));
    const newerResult = sendMessage(context, 'newer', sessionId);
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(3));

    newerSend.reject(conflict);
    await expect(newerResult).rejects.toThrow('session_in_use');
    expect(mockNotificationError).toHaveBeenCalledTimes(2);

    olderRetry.reject(conflict);
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(3));
    await Promise.resolve();

    expect(mockNotificationError).toHaveBeenCalledTimes(2);
    expect(mockNotificationDismiss).not.toHaveBeenCalledWith('notification-2');
  });

  it('does not let an older retry success dismiss a newer conflict', async () => {
    const sessionId = 'session-race-success';
    const { context } = conflictContext(sessionId);
    const conflict = new Error(`session_in_use: Session is already open for writing: ${sessionId}`);
    const retryStart = vi.fn();
    const retrySuccess = vi.fn();

    await expect(sendMessage(context, 'older', sessionId, undefined, undefined, undefined, {
      onSessionConflictRetryStart: retryStart,
      onSessionConflictRetrySuccess: retrySuccess,
    })).rejects.toThrow('session_in_use');
    const retryAction = mockNotificationError.mock.calls[0][1].actions[0];
    const olderRetry = deferred<void>();
    const newerSend = deferred<void>();
    mockEnsureBackendSession
      .mockImplementationOnce(() => olderRetry.promise)
      .mockImplementationOnce(() => newerSend.promise);

    retryAction.onClick();
    expect(retryStart).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(2));
    const newerResult = sendMessage(context, 'newer', sessionId);
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(3));

    newerSend.reject(conflict);
    await expect(newerResult).rejects.toThrow('session_in_use');
    olderRetry.resolve(undefined);
    await vi.waitFor(() => expect(mockStartDialogTurn).toHaveBeenCalledTimes(1));

    expect(mockNotificationError).toHaveBeenCalledTimes(2);
    expect(mockNotificationDismiss).not.toHaveBeenCalledWith('notification-2');
    expect(retrySuccess).not.toHaveBeenCalled();
  });

  it('does not let an older retry failure reset a newer processing turn', async () => {
    const sessionId = 'session-processing-race';
    const { context } = conflictContext(sessionId);
    const conflict = new Error(`session_in_use: Session is already open for writing: ${sessionId}`);

    await expect(sendMessage(context, 'older', sessionId)).rejects.toThrow('session_in_use');
    const retryAction = mockNotificationError.mock.calls[0][1].actions[0];
    const olderRetry = deferred<void>();
    const newerTurn = deferred<void>();
    let currentState = 'idle';
    let currentDialogTurnId: string | null = null;
    mockGetCurrentState.mockImplementation(() => currentState);
    mockGetStateMachine.mockReturnValue({
      getContext: () => ({ currentDialogTurnId }),
    } as any);
    mockTransition.mockImplementation(async (_id, event, payload) => {
      if (event === 'start') {
        currentState = 'processing';
        currentDialogTurnId = payload.dialogTurnId;
      }
      return true;
    });
    mockEnsureBackendSession
      .mockImplementationOnce(() => olderRetry.promise)
      .mockResolvedValueOnce(undefined);
    mockStartDialogTurn.mockImplementationOnce(() => newerTurn.promise);

    retryAction.onClick();
    await vi.waitFor(() => expect(mockEnsureBackendSession).toHaveBeenCalledTimes(2));
    const newerResult = sendMessage(context, 'newer', sessionId);
    await vi.waitFor(() => expect(mockStartDialogTurn).toHaveBeenCalledTimes(1));

    olderRetry.reject(conflict);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockTransition).not.toHaveBeenCalledWith(
      sessionId,
      'error_occurred',
      expect.anything(),
    );
    expect(mockTransition).not.toHaveBeenCalledWith(sessionId, 'reset');

    newerTurn.resolve(undefined);
    await expect(newerResult).resolves.toBeUndefined();
  });

  it('invalidates an old retry when a newer message is queued', async () => {
    const sessionId = 'session-queue-success';
    const { context } = conflictContext(sessionId);

    await expect(sendMessage(context, 'older', sessionId)).rejects.toThrow('session_in_use');
    const retryAction = mockNotificationError.mock.calls[0][1].actions[0];
    mockGetCurrentState.mockReturnValue('processing');

    await expect(sendMessage(context, 'newer', sessionId)).resolves.toBeUndefined();
    expect(mockPendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      content: 'newer',
    }));
    expect(mockNotificationDismiss).toHaveBeenCalledWith('notification-1');

    retryAction.onClick();
    expect(mockEnsureBackendSession).toHaveBeenCalledTimes(1);
  });

  it('does not turn external command delegation into a pending queue item', async () => {
    const sessionId = 'session-delegated-command';
    const { context } = conflictContext(sessionId);
    mockGetCurrentState.mockReturnValue('processing');

    await expect(sendMessage(
      context,
      'expanded prompt',
      sessionId,
      '/review',
      undefined,
      undefined,
      {
        execution: {
          kind: 'fresh_external_subagent',
          ecosystemId: 'opencode',
          logicalId: 'reviewer',
        },
      },
    )).rejects.toThrow('requires an idle session');

    expect(mockPendingEnqueue).not.toHaveBeenCalled();
    expect(mockEnsureBackendSession).not.toHaveBeenCalled();
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
  });
});

describe('MessageModule cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interruptedTurnRecoveryGate.resetForTests();
    resetRuntimeStatuses();
    mockGetCurrentState.mockReturnValue('processing');
    mockTransition.mockResolvedValue(true);
  });

  it('cancels persistent /btw sessions through the ordinary dialog-turn path', async () => {
    mockGetCurrentState
      .mockReturnValueOnce('processing')
      .mockReturnValue('finishing');
    const session = {
      sessionId: 'btw-child',
      isTransient: false,
      sessionKind: 'btw',
      dialogTurns: [],
      config: {},
    };
    const mockStoreCancelSessionTask = vi.fn();
    const contentBuffers = new Map([['btw-child', new Map([['round-1', 'text']])]]);
    const activeTextItems = new Map([['btw-child', new Map([['round-1', 'item-1']])]]);
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({
          activeSessionId: 'parent',
          sessions: new Map([['btw-child', session]]),
        }),
        cancelSessionTask: mockStoreCancelSessionTask,
      },
      userCancelledSessionIds: new Set<string>(),
      eventBatcher: {
        getBufferSize: vi.fn(() => 0),
        clear: vi.fn(),
      },
      pendingTurnCompletions: new Map(),
      runtimeStatusTimers: new Map(),
      handledTerminalTurnEvents: new Set<string>(),
      contentBuffers,
      activeTextItems,
    };

    await expect(cancelSessionTask(context, 'btw-child')).resolves.toBe(true);

    expect(mockTransition).toHaveBeenCalledWith(
      'btw-child',
      SessionExecutionEvent.USER_CANCEL,
    );
    expect(mockStoreCancelSessionTask).not.toHaveBeenCalled();
    expect(context.userCancelledSessionIds.has('btw-child')).toBe(true);
    expect(contentBuffers.has('btw-child')).toBe(false);
    expect(activeTextItems.has('btw-child')).toBe(false);
  });

  it('preserves the running UI when the interrupt transition rolls back to processing', async () => {
    mockGetCurrentState.mockReturnValue('processing');
    const session = {
      sessionId: 'session-interrupt-rejected',
      sessionKind: 'normal',
      dialogTurns: [],
      config: {},
    };
    const contentBuffers = new Map([[session.sessionId, new Map([['round-1', 'text']])]]);
    const activeTextItems = new Map([[session.sessionId, new Map([['round-1', 'item-1']])]]);
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
      },
      userCancelledSessionIds: new Set<string>(),
      eventBatcher: { getBufferSize: vi.fn(() => 0), clear: vi.fn() },
      pendingTurnCompletions: new Map(),
      runtimeStatusTimers: new Map(),
      handledTerminalTurnEvents: new Set<string>(),
      contentBuffers,
      activeTextItems,
    };

    await expect(cancelSessionTask(context, session.sessionId)).resolves.toBe(false);

    expect(context.userCancelledSessionIds.has(session.sessionId)).toBe(false);
    expect(contentBuffers.has(session.sessionId)).toBe(true);
    expect(activeTextItems.has(session.sessionId)).toBe(true);
  });

  it('queues a direct send while the cancellation outcome still owns the session', async () => {
    mockGetCurrentState.mockReturnValue('idle');
    mockPendingList.mockReturnValue([]);
    mockPendingEnqueue.mockReturnValue({ id: 'queued-during-cancel' });
    const session = {
      sessionId: 'session-cancel-in-flight',
      sessionKind: 'normal',
      dialogTurns: [],
      config: {},
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
      },
      userCancelledSessionIds: new Set([session.sessionId]),
    };

    const pendingQueueDraft = {
      value: 'follow-up',
      contexts: [],
      pendingLargePastes: { 'paste-1': 'full content' },
    };
    await sendMessage(
      context,
      'follow-up',
      session.sessionId,
      undefined,
      undefined,
      undefined,
      { pendingQueueDraft },
    );

    expect(mockPendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      content: 'follow-up',
      composerDraft: pendingQueueDraft,
    }));
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
  });

  it('sends a queued message once when snapshot replay became idle behind the attachment fence', async () => {
    mockGetCurrentState.mockReturnValue('idle');
    mockEnsureBackendSession.mockResolvedValue(undefined);
    mockStartDialogTurn.mockResolvedValue({ sessionId: 'resume-session', turnId: 'next-turn', status: 'started' });
    const session: any = { sessionId: 'resume-session', sessionKind: 'normal', mode: 'Standard',
      titleStatus: 'generated', dialogTurns: [], config: { modelName: 'primary' }, maxContextTokens: 32000 };
    const pending = { id: 'queued', sessionId: session.sessionId, content: 'next', status: 'queued', retryCount: 0 };
    mockPendingList.mockReturnValue([pending]);
    mockPendingSetStatus.mockImplementation((_session, _id, status) => { pending.status = status; });
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
        addDialogTurn: vi.fn((_sessionId: string, turn: any) => session.dialogTurns.push(turn)),
        deleteDialogTurn: vi.fn((_sessionId: string, turnId: string) => {
          session.dialogTurns = session.dialogTurns.filter((turn: any) => turn.id !== turnId);
        }),
        updateSessionLastSubmittedMode: vi.fn(),
        updateSessionMode: vi.fn(),
        updateSessionModelName: vi.fn(),
        updateSessionMaxContextTokens: vi.fn(),
      },
      processingManager: {
        registerStatus: vi.fn(),
        clearSessionStatus: vi.fn(),
      },
      userCancelledSessionIds: new Set<string>(),
      pendingHistoryLoads: new Map(),
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    };
    installPendingQueueDrainListener(context);
    const onIdle = mockSubscribeGlobal.mock.calls.at(-1)![0];
    const attachment = beginRuntimeSessionAttachment(LOCAL_SURFACE_ID, session.sessionId);
    onIdle(session.sessionId, { currentState: 'idle' });
    await Promise.resolve();
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
    attachment.finish({ streamId: 'host', cursor: 5 });
    // A held terminal delivery may report IDLE as well; coalesce the wakeups.
    onIdle(session.sessionId, { currentState: 'idle' });
    await vi.waitFor(() => expect(mockStartDialogTurn).toHaveBeenCalledTimes(1));
    expect(mockPendingRemove).toHaveBeenCalledWith(session.sessionId, pending.id);

    pending.status = 'queued';
    const nextAttachment = beginRuntimeSessionAttachment(LOCAL_SURFACE_ID, session.sessionId);
    nextAttachment.finish({ streamId: 'host', cursor: 6 });
    activateSurface('peer-other');
    await Promise.resolve();
    expect(mockStartDialogTurn).toHaveBeenCalledTimes(1);
    activateSurface(LOCAL_SURFACE_ID);
  });

  it('holds pending input while an interrupt outcome is still in flight', async () => {
    mockGetCurrentState.mockReturnValue('idle');
    mockPendingList.mockReturnValue([{
      id: 'pending-1',
      sessionId: 'session-1',
      content: 'do not auto-send',
      status: 'queued',
      retryCount: 0,
    }]);
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({
          sessions: new Map([['session-1', {
            sessionId: 'session-1',
            dialogTurns: [],
            config: {},
          }]]),
        }),
      },
      userCancelledSessionIds: new Set(['session-1']),
    };

    await drainPendingQueue(context, 'session-1');

    expect(mockPendingSetStatus).not.toHaveBeenCalled();
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
    expect(mockPendingRemove).not.toHaveBeenCalled();
  });

  it('rejects every direct submission while recovery admission is in flight', async () => {
    const session: any = {
      sessionId: 'session-interrupted',
      dialogTurns: [],
      config: {},
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
      },
    };
    interruptedTurnRecoveryGate.tryBegin({
      sessionId: session.sessionId,
      turnId: 'interrupted-turn',
      executionGeneration: 0,
    });

    await expect(sendMessage(context, 'must not race recovery', session.sessionId)).rejects.toThrow(
      'recovery is in flight',
    );
    expect(mockPendingEnqueue).not.toHaveBeenCalled();
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
  });

  it('lets an explicit send-now abandon interrupted recovery', async () => {
    mockGetCurrentState.mockReturnValue('idle');
    mockEnsureBackendSession.mockResolvedValue(undefined);
    mockStartDialogTurn.mockResolvedValue({
      sessionId: 'session-interrupted',
      turnId: 'new-turn',
      status: 'started',
    });
    const pendingItem = {
      id: 'pending-explicit',
      sessionId: 'session-interrupted',
      content: 'start new work',
      status: 'queued',
      retryCount: 0,
    };
    mockPendingList.mockReturnValue([pendingItem]);
    const session: any = {
      sessionId: 'session-interrupted',
      sessionKind: 'normal',
      mode: 'Standard',
      titleStatus: 'generated',
      dialogTurns: [{
        id: 'interrupted-turn',
        status: 'cancelled',
        finishReason: 'interrupted',
        recovery: { status: 'interrupted', executionGeneration: 0 },
      }],
      config: { modelName: 'primary' },
      maxContextTokens: 32_000,
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
        addDialogTurn: vi.fn((_sessionId: string, turn: any) => session.dialogTurns.push(turn)),
        deleteDialogTurn: vi.fn((_sessionId: string, turnId: string) => {
          session.dialogTurns = session.dialogTurns.filter((turn: any) => turn.id !== turnId);
        }),
        updateSessionLastSubmittedMode: vi.fn(),
        updateSessionMode: vi.fn(),
        updateSessionModelName: vi.fn(),
        updateSessionMaxContextTokens: vi.fn(),
      },
      processingManager: {
        registerStatus: vi.fn(),
        clearSessionStatus: vi.fn(),
      },
      userCancelledSessionIds: new Set<string>(),
      pendingHistoryLoads: new Map(),
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    };

    await drainPendingQueue(context, session.sessionId);
    expect(mockStartDialogTurn).not.toHaveBeenCalled();

    await drainPendingQueue(context, session.sessionId, {
      allowInterruptedRecoveryAbandon: true,
    });

    expect(mockStartDialogTurn).toHaveBeenCalledTimes(1);
    expect(mockPendingRemove).toHaveBeenCalledWith(session.sessionId, pendingItem.id);
  });

  it('holds an explicit send-now while recovery admission is in flight', async () => {
    mockGetCurrentState.mockReturnValue('idle');
    mockPendingList.mockReturnValue([{
      id: 'pending-race',
      sessionId: 'session-interrupted',
      content: 'must wait',
      status: 'queued',
      retryCount: 0,
    }]);
    const session: any = {
      sessionId: 'session-interrupted',
      dialogTurns: [{
        id: 'interrupted-turn',
        status: 'cancelled',
        finishReason: 'interrupted',
        recovery: { status: 'interrupted', executionGeneration: 0 },
      }],
      config: {},
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
      },
      userCancelledSessionIds: new Set<string>(),
    };
    interruptedTurnRecoveryGate.tryBegin({
      sessionId: session.sessionId,
      turnId: 'interrupted-turn',
      executionGeneration: 0,
    });

    await drainPendingQueue(context, session.sessionId, {
      allowInterruptedRecoveryAbandon: true,
    });

    expect(mockStartDialogTurn).not.toHaveBeenCalled();
    expect(mockPendingSetStatus).not.toHaveBeenCalled();
  });
});

describe('MessageModule detached dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPendingList.mockReturnValue([]);
    mockGetCurrentState.mockReturnValue('idle');
    mockDispatchSubmit.mockResolvedValue({
      accepted: true,
      jobId: 'job-1',
      sessionId: 'dispatch-session',
      state: 'queued',
    });
    mockDispatchAppend.mockResolvedValue({
      accepted: true,
      messageId: 'append-1',
    });
  });

  function createDispatchContext(approvalPolicy: 'auto' | 'reject-and-report' | 'remote') {
    const session = {
      sessionId: 'dispatch-session',
      title: 'New Chat',
      titleStatus: 'generated',
      mode: 'Standard',
      dialogTurns: [] as any[],
      workspacePath: '/controller/repo',
      projectWorkspacePath: '/controller/repo',
      workspaceId: 'workspace-1',
      config: {
        workspacePath: '/controller/repo',
        projectWorkspacePath: '/controller/repo',
        workspaceId: 'workspace-1',
        modelName: 'controller-model',
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
        dispatchJobId: 'job-1',
        dispatchApprovalPolicy: approvalPolicy,
        dispatchJobState: 'submitting',
        dispatchCursor: 0,
      },
    };
    return {
      session,
      context: {
        flowChatStore: {
          getSurfaceGeneration: () => 0,
          getState: () => ({
            activeSessionId: session.sessionId,
            sessions: new Map([[session.sessionId, session]]),
          }),
          addDialogTurn: vi.fn((_sessionId: string, turn: any) => {
            if (!session.dialogTurns.some(existing => existing.id === turn.id)) {
              session.dialogTurns.push(turn);
            }
          }),
          deleteDialogTurn: vi.fn((_sessionId: string, turnId: string) => {
            session.dialogTurns = session.dialogTurns.filter(turn => turn.id !== turnId);
          }),
          applyDispatchSnapshot: vi.fn(() => ({ applied: true, cursor: 0 })),
          updateSessionLastSubmittedMode: vi.fn(),
          updateSessionMode: vi.fn(),
        },
        pendingHistoryLoads: new Map(),
      } as any,
    };
  }

  it('projects the user message immediately while the target is still queued', async () => {
    const { context, session } = createDispatchContext('reject-and-report');
    session.config.dispatchIncludeUncommitted = true;
    let resolveSubmit!: (value: {
      accepted: boolean;
      jobId: string;
      sessionId: string;
      state: string;
    }) => void;
    mockDispatchSubmit.mockImplementationOnce(() => new Promise(resolve => {
      resolveSubmit = resolve;
    }));

    const submission = sendMessage(
      context,
      'expanded remote prompt',
      'dispatch-session',
      'run remote checks',
    );

    expect(session.dialogTurns).toHaveLength(1);
    expect(session.dialogTurns[0]).toMatchObject({
      id: 'dispatch_pending_job-1',
      sessionId: 'dispatch-session',
      agentType: 'Standard',
      userMessage: {
        content: 'run remote checks',
        metadata: {
          __openbitfunOptimisticDispatchJobId: 'job-1',
        },
      },
      modelRounds: [],
      status: 'pending',
    });
    expect(getRuntimeStatus('dispatch-session')).toMatchObject({
      turnId: 'dispatch_pending_job-1',
      roundId: 'dispatch-transfer:job-1',
      label: 'flow-chat:chatInput.dispatch.transferInProgress',
    });
    resolveSubmit({
      accepted: true,
      jobId: 'job-1',
      sessionId: 'dispatch-session',
      state: 'queued',
    });
    await submission;
    expect(getRuntimeStatus('dispatch-session')).toBeUndefined();

    expect(mockDispatchSubmit).toHaveBeenCalledWith({
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target/repo',
      },
      includeUncommitted: true,
      baseRef: 'HEAD',
      jobId: 'job-1',
      sessionId: 'dispatch-session',
      agentType: 'Standard',
      prompt: 'expanded remote prompt',
      approvalPolicy: 'reject-and-report',
      model: undefined,
      sourceWorkspacePath: '/controller/repo',
      sourceWorkspaceId: 'workspace-1',
    });
    expect(mockStartDialogTurn).not.toHaveBeenCalled();
    expect(mockBindSession).not.toHaveBeenCalled();
  });

  it('removes the optimistic message when dispatch submission fails', async () => {
    const { context, session } = createDispatchContext('reject-and-report');
    mockDispatchSubmit.mockRejectedValueOnce(new Error('target unavailable'));

    await expect(
      sendMessage(context, 'run remote checks', 'dispatch-session'),
    ).rejects.toThrow('target unavailable');

    expect(session.dialogTurns).toEqual([]);
  });

  it('submits with the session-scoped auto-approval setting without another confirmation', async () => {
    const { context } = createDispatchContext('auto');

    await expect(
      sendMessage(context, 'run remote checks', 'dispatch-session'),
    ).resolves.toBeUndefined();
    expect(mockDispatchSubmit).toHaveBeenCalledTimes(1);
  });

  it('steers a busy running dispatch instead of queueing the message', async () => {
    const { context, session } = createDispatchContext('remote');
    session.config.dispatchJobState = 'running';
    // Busy state machine + non-empty queue would normally enqueue; a running
    // dispatch must steer instead, because queued items only drain for
    // sessions that drive the local state machine.
    mockGetCurrentState.mockReturnValue('processing');
    mockPendingList.mockReturnValue([{ id: 'queued-1' }]);

    await expect(
      sendMessage(context, 'steer the remote turn', 'dispatch-session'),
    ).resolves.toBeUndefined();

    expect(mockDispatchAppend).toHaveBeenCalledTimes(1);
    expect(mockPendingEnqueue).not.toHaveBeenCalled();
    expect(mockDispatchSubmit).not.toHaveBeenCalled();
  });

  it('reuses the append message id after an ambiguous transport failure', async () => {
    const { context, session } = createDispatchContext('remote');
    session.config.dispatchJobState = 'running';
    mockDispatchAppend
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ accepted: true, messageId: 'append-1' });

    await expect(
      sendMessage(context, 'continue with the checks', 'dispatch-session'),
    ).rejects.toThrow('response lost');
    await expect(
      sendMessage(context, 'continue with the checks', 'dispatch-session'),
    ).resolves.toBeUndefined();

    expect(mockDispatchAppend).toHaveBeenCalledTimes(2);
    expect(mockDispatchAppend.mock.calls[0][3]).toBeTruthy();
    expect(mockDispatchAppend.mock.calls[1][3]).toBe(
      mockDispatchAppend.mock.calls[0][3],
    );
  });
});

describe('MessageModule model synchronization', () => {
  function modelSyncContext(modelName: string) {
    const session = {
      sessionId: 'same-name-session',
      config: { modelName, workspacePath: '/remote/repo' },
      remoteConnectionId: 'ssh-1', remoteSshHost: 'example.test',
      maxContextTokens: 32000,
    };
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([[session.sessionId, session]]) }),
        updateSessionModelName: vi.fn(),
        updateSessionMaxContextTokens: vi.fn(),
      },
    };
    return { context, session };
  }

  const sameNameModels = [
    { id: 'model-first', name: 'MOCK-8000', model_name: 'asdf', enabled: true, context_window: 32000 },
    { id: 'asdf', name: 'MOCK-8000-2', model_name: 'asdf', enabled: true, context_window: 64000 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfigs.mockResolvedValue({
      'ai.agent_model_defaults': { mode: 'model-b' },
      'ai.models': [
        { id: 'primary-model', enabled: true, context_window: 32000 },
        { id: 'model-b', enabled: true, context_window: 64000 },
      ],
      'ai.default_models': { primary: 'primary-model' },
    });
    mockUpdateSessionModel.mockResolvedValue(undefined);
  });

  it('sends the exact selected account ID with the original remote routing', async () => {
    mockGetConfigs.mockResolvedValue({
      'ai.models': sameNameModels, 'ai.default_models': { primary: 'model-first' },
    });
    const { context, session } = modelSyncContext('asdf');
    await syncSessionModelSelection(context, session.sessionId, 'Standard');
    expect(context.flowChatStore.updateSessionModelName).not.toHaveBeenCalled();
    expect(context.flowChatStore.updateSessionMaxContextTokens).toHaveBeenCalledWith(session.sessionId, 64000);
    expect(mockUpdateSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'asdf', remoteConnectionId: 'ssh-1', remoteSshHost: 'example.test',
      workspacePath: '/remote/repo',
    }));
  });

  it.each(['MOCK-8000', 'asdf', 'removed-model'])('does not replace unavailable ID %s with a name match or Primary', async modelName => {
    mockGetConfigs.mockResolvedValue({
      'ai.models': [sameNameModels[0]], 'ai.default_models': { primary: 'model-first' },
    });
    const { context, session } = modelSyncContext(modelName);
    await expect(syncSessionModelSelection(context, session.sessionId, 'Standard'))
      .rejects.toThrow('model configuration ID');
    expect(context.flowChatStore.updateSessionModelName).not.toHaveBeenCalled();
    expect(mockUpdateSessionModel).not.toHaveBeenCalled();
  });

  it('keeps an explicit primary selector when synchronizing before send', async () => {
    const session = {
      sessionId: 'session-primary',
      config: {
        modelName: 'primary',
        reasoningPreset: 'high',
        workspacePath: '/remote/repo',
      },
      remoteConnectionId: 'ssh-1',
      remoteSshHost: 'example.test',
      sessionKind: 'subagent',
      maxContextTokens: 64000,
    };
    const updateSessionModelName = vi.fn();
    const updateSessionMaxContextTokens = vi.fn();
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([['session-primary', session]]) }),
        updateSessionModelName,
        updateSessionMaxContextTokens,
      },
    };

    await syncSessionModelSelection(context, 'session-primary', 'Standard');

    expect(updateSessionModelName).not.toHaveBeenCalled();
    expect(updateSessionMaxContextTokens).toHaveBeenCalledWith('session-primary', 32000);
    expect(mockUpdateSessionModel).toHaveBeenCalledWith({
      sessionId: 'session-primary',
      modelName: 'primary',
      reasoningPreset: 'high',
      workspacePath: '/remote/repo',
      remoteConnectionId: 'ssh-1',
      remoteSshHost: 'example.test',
      includeInternal: true,
    });
  });

  it('migrates a legacy session without a model to the current mode default', async () => {
    const session = {
      sessionId: 'legacy-session',
      config: { workspacePath: '/local/repo' },
      maxContextTokens: 32000,
    };
    const updateSessionModelName = vi.fn();
    const updateSessionMaxContextTokens = vi.fn();
    const context: any = {
      flowChatStore: {
        getSurfaceGeneration: () => 0,
        getState: () => ({ sessions: new Map([['legacy-session', session]]) }),
        updateSessionModelName,
        updateSessionMaxContextTokens,
      },
    };

    await syncSessionModelSelection(context, 'legacy-session', 'Standard');

    expect(updateSessionModelName).toHaveBeenCalledWith('legacy-session', 'model-b');
    expect(updateSessionMaxContextTokens).toHaveBeenCalledWith('legacy-session', 64000);
    expect(mockUpdateSessionModel).toHaveBeenCalledWith({
      sessionId: 'legacy-session',
      modelName: 'model-b',
      reasoningPreset: null,
      workspacePath: '/local/repo',
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
      includeInternal: false,
    });
  });
});

describe('MessageModule device surface switch', () => {
  /**
   * A device-surface switch clears every session projection. A submission
   * caught in `startTurn`'s async window (state transition, worktree bind,
   * model sync) used to resume against an empty store and throw
   * "Session lost after adding dialog turn" — reported as a turn failure even
   * though the turn had never reached a host, so the message was lost.
   */
  function switchingContext(sessionId: string, options?: { switchAfterTransition?: boolean }) {
    const session = {
      sessionId,
      mode: 'Standard',
      dialogTurns: [] as any[],
      config: { modelName: 'primary', workspacePath: '/repo' },
      titleStatus: 'generated',
      maxContextTokens: 32000,
    };
    const sessions = new Map<string, any>([[sessionId, session]]);
    let surfaceGeneration = 0;

    const switchSurface = () => {
      surfaceGeneration += 1;
      sessions.clear();
      activateSurface('peer-switch-target');
    };

    if (options?.switchAfterTransition) {
      // The switch lands while the state machine transition is awaited, which
      // is exactly where the reported failure happened.
      mockTransition.mockImplementation(async () => {
        switchSurface();
        return true;
      });
    }

    return {
      session,
      switchSurface,
      context: {
        flowChatStore: {
          getSurfaceGeneration: () => surfaceGeneration,
          getState: () => ({ sessions }),
          addDialogTurn: vi.fn((_id: string, turn: any) => session.dialogTurns.push(turn)),
          deleteDialogTurn: vi.fn(),
          abandonOptimisticDialogTurn: vi.fn(),
          updateSessionLastSubmittedMode: vi.fn(),
          updateSessionMode: vi.fn(),
          updateSessionModelName: vi.fn(),
          updateSessionMaxContextTokens: vi.fn(),
        },
        processingManager: {
          registerStatus: vi.fn(),
          clearSessionStatus: vi.fn(),
          clearSessionStatusForSurface: vi.fn(),
        },
        pendingHistoryLoads: new Map(),
        contentBuffers: new Map(),
        activeTextItems: new Map(),
      } as any,
    };
  }

  beforeEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    vi.resetAllMocks();
    mockGetCurrentState.mockReturnValue('idle');
    mockGetStateMachine.mockReturnValue(null);
    mockTransition.mockResolvedValue(true);
    mockUpdateSessionModel.mockResolvedValue(undefined);
    mockStartDialogTurn.mockResolvedValue(undefined);
    mockPendingList.mockReturnValue([]);
    mockPendingEnqueue.mockReturnValue({ id: 'requeued' });
    mockPendingEnqueueForSurface.mockReturnValue({ id: 'requeued' });
    mockEnsureBackendSession.mockResolvedValue(undefined);
  });

  it('does not report a turn failure when the surface switched mid-submission', async () => {
    const { context } = switchingContext('session-switch', { switchAfterTransition: true });

    await expect(
      sendMessage(context, 'keep working', 'session-switch'),
    ).resolves.toBeUndefined();

    expect(mockNotificationError).not.toHaveBeenCalled();
  });

  it('re-queues the message when the host never accepted the turn', async () => {
    const { context } = switchingContext('session-switch', { switchAfterTransition: true });

    await sendMessage(context, 'keep working', 'session-switch');

    expect(mockStartDialogTurn).not.toHaveBeenCalled();
    expect(mockPendingEnqueueForSurface).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({ sessionId: 'session-switch', content: 'keep working' }),
    );
    expect(context.processingManager.registerStatus).not.toHaveBeenCalled();
    expect(context.flowChatStore.abandonOptimisticDialogTurn).toHaveBeenCalledWith(
      'local',
      'session-switch',
      expect.any(String),
    );
    expect(mockResetForSurface).toHaveBeenCalledWith('local', 'session-switch');
    expect(context.processingManager.clearSessionStatusForSurface).toHaveBeenCalledWith(
      'local',
      'session-switch',
    );
  });

  it('leaves an accepted turn alone when the surface switches after submission', async () => {
    const { context, switchSurface } = switchingContext('session-accepted');
    // The host takes the turn, and only then does the user switch device.
    mockStartDialogTurn.mockImplementation(async () => {
      switchSurface();
    });

    await sendMessage(context, 'already running', 'session-accepted');

    expect(mockStartDialogTurn).toHaveBeenCalledTimes(1);
    expect(mockPendingEnqueueForSurface).not.toHaveBeenCalled();
    expect(mockNotificationError).not.toHaveBeenCalled();
  });

  it('does not re-queue when startDialogTurn was sent and the invoke then fails after a switch', async () => {
    const { context, switchSurface } = switchingContext('session-accepted');
    mockStartDialogTurn.mockImplementation(async () => {
      switchSurface();
      throw new Error('invoke aborted after transport swap');
    });

    await sendMessage(context, 'already running', 'session-accepted');

    expect(mockStartDialogTurn).toHaveBeenCalledTimes(1);
    expect(mockPendingEnqueueForSurface).not.toHaveBeenCalled();
    expect(context.flowChatStore.abandonOptimisticDialogTurn).not.toHaveBeenCalled();
    expect(mockNotificationError).not.toHaveBeenCalled();
  });

  it('still reports ordinary failures when the surface did not change', async () => {
    const { context } = switchingContext('session-normal');
    mockStartDialogTurn.mockRejectedValue(new Error('backend exploded'));

    await expect(
      sendMessage(context, 'boom', 'session-normal'),
    ).rejects.toThrow('backend exploded');

    expect(mockNotificationError).toHaveBeenCalled();
  });
});
