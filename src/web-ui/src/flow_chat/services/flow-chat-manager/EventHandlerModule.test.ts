import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  __test_only__,
  handleDialogTurnComplete,
  handleSessionHistoryChanged,
  handleSessionStateChanged,
  insertSteeringItemIfAbsent,
  isAppWindowFocused,
  projectDialogTurnRecovered,
  shouldProcessEvent,
} from './EventHandlerModule';
import { stateMachineManager } from '../../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../../state-machine/types';
import { FlowChatStore } from '../../store/FlowChatStore';
import {
  markSessionTurnsRetired,
  useSessionMutationStore,
} from '../../store/sessionMutationStore';
import { notificationService } from '../../../shared/notification-system/services/NotificationService';
import type { DialogTurn, FlowToolItem, FlowUserSteeringItem, ModelRound, Session } from '../../types/flow-chat';
import type { FlowChatContext } from './types';
import { markOptimisticDispatchTurnMetadata } from '@/features/dispatch/optimisticDispatchTurn';
import { interruptedTurnRecoveryGate } from '../interruptedTurnRecoveryGate';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { localSessionDriver } from '../../session-drivers/local/LocalSessionDriver';
import { chatInputSessionSubscriptionKey } from '../../utils/chatInputSessionSubscription';
import { selectInterruptedTurnRecovery } from '../../utils/interruptedTurnRecovery';

const {
  buildBuiltInBrowserTabOptions,
  handleCompressionCompleted,
  handleTokenUsageUpdate,
} = __test_only__;

vi.mock('../../../shared/notification-system/services/NotificationService', () => ({
  notificationService: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

describe('isAppWindowFocused', () => {
  it('returns true when no document is available', () => {
    expect(isAppWindowFocused()).toBe(true);
  });
});

describe('Claw bootstrap cancellation', () => {
  beforeEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('stops a backend-started bootstrap using its actual session and turn identities', async () => {
    const interrupt = vi.spyOn(agentAPI, 'interruptDialogTurn').mockResolvedValue(undefined);
    const store = FlowChatStore.getInstance();
    store.setState(() => ({
      sessions: new Map([['claw-1', {
        sessionId: 'claw-1', title: 'Claw', mode: 'Claw', sessionKind: 'normal',
        workspacePath: '/assistants/default', config: { agentType: 'Claw' },
        dialogTurns: [], status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
      } as Session]]),
      activeSessionId: 'claw-1',
    }));
    const context = createFlowChatContext();
    __test_only__.handleDialogTurnStarted(context, {
      sessionId: 'claw-1', turnId: 'assistant-bootstrap-1', turnIndex: 0,
      userInput: 'Please start bootstrap',
      userMessageMetadata: { assistant_bootstrap: { system_generated: true } },
    });

    expect(await localSessionDriver.cancel(context, 'claw-1')).toBe(true);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith('claw-1', 'assistant-bootstrap-1');
    expect(context.userCancelledSessionIds.has('claw-1')).toBe(true);
    expect(stateMachineManager.getCurrentState('claw-1')).toBe(SessionExecutionState.FINISHING);
  });
});

describe('built-in browser open request projection', () => {
  it('correlates replacement and new-tab requests with distinct stable keys', () => {
    expect(buildBuiltInBrowserTabOptions({
      url: ' https://openbitfun.com/ ',
      title: ' Docs ',
      requestId: ' request-1 ',
      replaceExisting: true,
    })).toMatchObject({
      title: 'Docs',
      data: {
        url: 'https://openbitfun.com/',
        openRequestId: 'request-1',
      },
      duplicateCheckKey: 'browser-panel',
      replaceExisting: true,
    });

    expect(buildBuiltInBrowserTabOptions({
      url: 'https://openbitfun.com/',
      requestId: 'request-2',
      replaceExisting: false,
    })).toMatchObject({
      duplicateCheckKey: 'browser-panel:request-2',
      replaceExisting: false,
    });
  });

  it('rejects a request that cannot create a browser target', () => {
    expect(buildBuiltInBrowserTabOptions({ url: '   ' })).toBeNull();
  });
});

describe('interrupted turn lifecycle', () => {
  beforeEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
    interruptedTurnRecoveryGate.resetForTests();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
    interruptedTurnRecoveryGate.resetForTests();
  });

  it.each(['running', 'restored-interrupted'] as const)(
    'keeps the composer recovery snapshot current through repeated stops from %s',
    async initialState => {
      const store = FlowChatStore.getInstance();
      const turn: DialogTurn = {
        id: 'turn-1',
        sessionId: 'session-1',
        agentType: 'Standard',
        userMessage: { id: 'user-1', content: 'continue this work', timestamp: 1 },
        modelRounds: [],
        status: initialState === 'running' ? 'processing' : 'cancelled',
        startTime: 1,
        ...(initialState === 'restored-interrupted' ? {
          finishReason: 'interrupted',
          recovery: { status: 'interrupted' as const, executionGeneration: 0 },
        } : {}),
      };
      createSessionWithTurn(turn);
      const context = createFlowChatContext();
      let composerSession = store.getState().sessions.get('session-1')!;
      // Use the actual subscription boundary used by ChatInput, rather than
      // reading fresh Store state after every event and hiding stale renders.
      const unsubscribe = store.subscribeSelector(
        state => chatInputSessionSubscriptionKey(state.sessions.get('session-1')!),
        () => { composerSession = store.getState().sessions.get('session-1')!; },
      );
      store.notifyListeners();
      const candidate = () => selectInterruptedTurnRecovery(composerSession, {
        draft: '',
        hasComposerAttachments: false,
        executionIdle: stateMachineManager.getCurrentState('session-1') === SessionExecutionState.IDLE,
        desktopRuntime: true,
        peerMode: false,
        acpSession: false,
        modeChangePending: false,
        modelChangePending: false,
      });
      let generation = 0;
      const interrupt = vi.spyOn(agentAPI, 'interruptDialogTurn').mockImplementation(async () => {
        // Production broadcasts settlement before the stop RPC returns.
        __test_only__.handleDialogTurnInterrupted(context, {
          sessionId: 'session-1', turnId: 'turn-1', executionGeneration: generation,
        });
      });

      try {
        if (initialState === 'running') {
          await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
            taskId: 'session-1', dialogTurnId: 'turn-1',
          });
          await localSessionDriver.cancel(context, 'session-1');
        }
        expect(candidate()).toEqual({
          sessionId: 'session-1', turnId: 'turn-1', executionGeneration: 0,
        });

        for (generation = 1; generation <= 3; generation += 1) {
          expect(interruptedTurnRecoveryGate.tryBegin(candidate()!)).toBe(true);
          __test_only__.handleDialogTurnRecovered(context, {
            sessionId: 'session-1', turnId: 'turn-1', executionGeneration: generation,
          });
          await Promise.resolve();
          expect(candidate()).toBeNull();
          expect(interruptedTurnRecoveryGate.isSessionInFlight('session-1')).toBe(false);
          // Stop immediately, without a new model round, token update, or
          // draft edit incidentally refreshing the composer's snapshot.
          await localSessionDriver.cancel(context, 'session-1');
          expect(candidate()).toEqual({
            sessionId: 'session-1', turnId: 'turn-1', executionGeneration: generation,
          });
          expect(composerSession.dialogTurns).toHaveLength(1);
        }
      } finally {
        unsubscribe();
        interrupt.mockRestore();
      }
    },
  );

  it('projects the authoritative recovered fence and releases the shared gate', async () => {
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'continue this work', timestamp: 1 },
      modelRounds: [{
        id: 'round-0',
        index: 0,
        items: [],
        isStreaming: true,
        isComplete: false,
        status: 'streaming',
        startTime: 1,
      }],
      status: 'processing',
      startTime: 1,
    };
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', {
        sessionId: 'session-1',
        dialogTurns: [turn],
        status: 'active',
        config: { agentType: 'Standard' },
        createdAt: 1,
        lastActiveAt: 1,
        error: null,
        sessionKind: 'normal',
      } as Session]]),
      activeSessionId: 'session-1',
    }));
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-1',
    });
    const context = createFlowChatContext();

    __test_only__.handleDialogTurnInterrupted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 0,
    });
    await Promise.resolve();

    let session = FlowChatStore.getInstance().getState().sessions.get('session-1')!;
    expect(session.dialogTurns).toHaveLength(1);
    expect(session.dialogTurns[0]).toMatchObject({
      id: 'turn-1',
      status: 'cancelled',
      finishReason: 'interrupted',
      recovery: { status: 'interrupted', executionGeneration: 0 },
    });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);

    expect(interruptedTurnRecoveryGate.tryBegin({
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 0,
    })).toBe(true);

    __test_only__.handleDialogTurnRecovered(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 1,
    });
    await Promise.resolve();

    session = FlowChatStore.getInstance().getState().sessions.get('session-1')!;
    expect(session.dialogTurns).toHaveLength(1);
    expect(session.dialogTurns[0]).toMatchObject({
      id: 'turn-1',
      status: 'processing',
      recovery: { status: 'recovering', executionGeneration: 1 },
    });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(
      SessionExecutionState.PROCESSING,
    );
    expect(interruptedTurnRecoveryGate.isSessionInFlight('session-1')).toBe(false);

    __test_only__.handleDialogTurnInterrupted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 0,
    });
    await Promise.resolve();

    session = FlowChatStore.getInstance().getState().sessions.get('session-1')!;
    expect(session.dialogTurns[0]).toMatchObject({
      status: 'processing',
      recovery: { status: 'recovering', executionGeneration: 1 },
    });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(
      SessionExecutionState.PROCESSING,
    );
  });

  it('does not settle a newer turn when an older interrupted event arrives late', async () => {
    const oldTurn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'old work', timestamp: 1 },
      modelRounds: [],
      status: 'processing',
      startTime: 1,
    };
    createSessionWithTurn(oldTurn);
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-1',
    });
    const context = createFlowChatContext();

    await stateMachineManager.transition(
      'session-1',
      SessionExecutionEvent.BACKEND_STREAM_COMPLETED,
    );
    handleSessionStateChanged(context, {
      sessionId: 'session-1',
      newState: 'Idle',
    });
    await Promise.resolve();

    const newTurn: DialogTurn = {
      id: 'turn-2',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-2', content: 'new work', timestamp: 2 },
      modelRounds: [],
      status: 'processing',
      startTime: 2,
    };
    FlowChatStore.getInstance().setState(state => {
      const sessions = new Map(state.sessions);
      const session = sessions.get('session-1')!;
      sessions.set('session-1', {
        ...session,
        dialogTurns: [...session.dialogTurns, newTurn],
      });
      return { ...state, sessions };
    });
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-2',
    });

    __test_only__.handleDialogTurnInterrupted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 0,
    });
    await Promise.resolve();

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1')!;
    expect(session.dialogTurns[0]).toMatchObject({
      id: 'turn-1',
      status: 'cancelled',
      recovery: { status: 'interrupted', executionGeneration: 0 },
    });
    expect(session.dialogTurns[1]).toMatchObject({ id: 'turn-2', status: 'processing' });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(
      SessionExecutionState.PROCESSING,
    );
    expect(stateMachineManager.get('session-1')?.getContext().currentDialogTurnId).toBe('turn-2');
  });

  it('does not revive a recovered generation after it was interrupted again', async () => {
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'resume safely', timestamp: 1 },
      modelRounds: [],
      status: 'cancelled',
      finishReason: 'interrupted',
      recovery: { status: 'interrupted', executionGeneration: 0, resumeCount: 0 },
      startTime: 1,
    };
    createSessionWithTurn(turn);
    const context = createFlowChatContext();

    projectDialogTurnRecovered(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 1,
    });
    await Promise.resolve();
    __test_only__.handleDialogTurnInterrupted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 1,
    });
    await Promise.resolve();

    __test_only__.handleDialogTurnRecovered(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      executionGeneration: 1,
    });
    await Promise.resolve();

    const current = FlowChatStore.getInstance().getState().sessions
      .get('session-1')!.dialogTurns[0];
    expect(current).toMatchObject({
      status: 'cancelled',
      finishReason: 'interrupted',
      recovery: { status: 'interrupted', executionGeneration: 1 },
    });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);
  });

  it('accepts durable recovered completion when the recovered event was dropped', async () => {
    vi.useFakeTimers();
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'keep retryable', timestamp: 1 },
      modelRounds: [],
      status: 'cancelled',
      finishReason: 'interrupted',
      recovery: { status: 'interrupted', executionGeneration: 1, resumeCount: 1 },
      startTime: 1,
    };
    createSessionWithTurn(turn);
    const context = createFlowChatContext();

    handleDialogTurnComplete(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      success: true,
      finishReason: 'complete',
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(500);

    expect(FlowChatStore.getInstance().getState().sessions
      .get('session-1')!.dialogTurns[0]).toMatchObject({
      status: 'completed',
      finishReason: 'complete',
    });
    expect(FlowChatStore.getInstance().getState().sessions
      .get('session-1')!.dialogTurns[0].recovery).toBeUndefined();
    vi.useRealTimers();
  });

  it('does not settle a newer turn when an older cancelled event arrives late', async () => {
    const oldTurn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'old', timestamp: 1 },
      modelRounds: [],
      status: 'processing',
      startTime: 1,
    };
    const newTurn: DialogTurn = {
      id: 'turn-2',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-2', content: 'new', timestamp: 2 },
      modelRounds: [],
      status: 'processing',
      startTime: 2,
    };
    createSessionWithTurn(oldTurn);
    FlowChatStore.getInstance().setState(state => {
      const sessions = new Map(state.sessions);
      sessions.set('session-1', { ...sessions.get('session-1')!, dialogTurns: [oldTurn, newTurn] });
      return { ...state, sessions };
    });
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-2',
    });
    const context = createFlowChatContext();

    __test_only__.handleDialogTurnCancelled(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
    }, vi.fn());
    await Promise.resolve();

    expect(FlowChatStore.getInstance().getState().sessions
      .get('session-1')!.dialogTurns[1]).toMatchObject({ id: 'turn-2', status: 'processing' });
    expect(stateMachineManager.getCurrentState('session-1')).toBe(
      SessionExecutionState.PROCESSING,
    );
  });

  it('holds finishing when backend idle arrives before the cancellation outcome', async () => {
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'stop', timestamp: 1 },
      modelRounds: [],
      status: 'processing',
      startTime: 1,
    };
    createSessionWithTurn(turn);
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-1',
    });
    await stateMachineManager.transition(
      'session-1',
      SessionExecutionEvent.BACKEND_STREAM_COMPLETED,
    );
    const context = createFlowChatContext();
    context.userCancelledSessionIds.add('session-1');

    handleSessionStateChanged(context, { sessionId: 'session-1', newState: 'Idle' });
    await Promise.resolve();

    expect(stateMachineManager.getCurrentState('session-1')).toBe(
      SessionExecutionState.FINISHING,
    );
  });
});

describe('resolveDialogTurnDisplayContent', () => {
  it('prefers original user input for ordinary turns', () => {
    expect(
      __test_only__.resolveDialogTurnDisplayContent(
        '<user_query>\nwrapped runtime content\n</user_query>',
        'Original human message',
        { kind: 'user_dialog' },
      ),
    ).toBe('Original human message');
  });

  it('still prefers original user input when metadata is background_subagent_result', () => {
    expect(
      __test_only__.resolveDialogTurnDisplayContent(
        'Delivered result text',
        'Display content chosen by backend',
        { kind: 'background_subagent_result' },
      ),
    ).toBe('Display content chosen by backend');
  });
});

describe('dispatch optimistic turn reconciliation', () => {
  beforeEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('lets the target DialogTurnStarted event adopt the visible pending turn', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        'dispatch-session',
        {
          sessionId: 'dispatch-session',
          title: 'Remote task',
          dialogTurns: [{
            id: 'dispatch_pending_job-1',
            sessionId: 'dispatch-session',
            agentType: 'Standard',
            userMessage: {
              id: 'user-dispatch-1',
              content: 'Original visible prompt',
              timestamp: 1000,
              metadata: markOptimisticDispatchTurnMetadata(
                { source: 'composer' },
                'job-1',
              ),
            },
            modelRounds: [],
            status: 'pending',
            startTime: 1000,
          }],
          status: 'idle',
          config: {
            dispatchTarget: {
              kind: 'ssh',
              connectionId: 'ssh-1',
              workspacePath: '/target/repo',
              displayName: 'build-host',
            },
            dispatchJobId: 'job-1',
          },
          createdAt: 1000,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: 'dispatch-session',
    }));

    const context = createFlowChatContext();
    context.deferredStorageIdentitySaves?.add('dispatch-session:dispatch_pending_job-1');
    __test_only__.handleDialogTurnStarted(context, {
      sessionId: 'dispatch-session',
      turnId: 'target-turn-1',
      turnIndex: 0,
      userInput: 'Expanded target prompt',
      userMessageMetadata: { targetFact: true },
    });

    const turns = FlowChatStore.getInstance()
      .getState()
      .sessions.get('dispatch-session')
      ?.dialogTurns;
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({
      id: 'target-turn-1',
      userMessage: {
        content: 'Original visible prompt',
        metadata: {
          source: 'composer',
          targetFact: true,
        },
      },
      backendTurnIndex: 0,
      status: 'pending',
    });
    expect(turns?.[0]?.userMessage.metadata)
      .not.toHaveProperty('__openbitfunOptimisticDispatchJobId');
    expect(context.deferredStorageIdentitySaves).not.toContain(
      'dispatch-session:dispatch_pending_job-1',
    );
  });

  it('hydrates the real prompt into an audit-only dispatch placeholder', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        'dispatch-session',
        {
          sessionId: 'dispatch-session',
          title: 'Remote task title',
          dialogTurns: [{
            id: 'dispatch_pending_job-1',
            sessionId: 'dispatch-session',
            agentType: 'Standard',
            userMessage: {
              id: 'user-dispatch-1',
              content: '',
              timestamp: 1000,
              metadata: markOptimisticDispatchTurnMetadata(undefined, 'job-1'),
            },
            modelRounds: [{
              id: 'dispatch-setup:job-1',
              index: -1,
              items: [],
              isStreaming: false,
              isComplete: true,
              status: 'completed',
              startTime: 1000,
              endTime: 1000,
            }],
            status: 'pending',
            startTime: 1000,
          }],
          status: 'idle',
          config: {
            dispatchTarget: {
              kind: 'ssh',
              connectionId: 'ssh-1',
              workspacePath: '/target/repo',
              displayName: 'build-host',
            },
            dispatchJobId: 'job-1',
          },
          createdAt: 1000,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: 'dispatch-session',
    }));

    __test_only__.handleDialogTurnStarted(createFlowChatContext(), {
      sessionId: 'dispatch-session',
      turnId: 'target-turn-1',
      turnIndex: 0,
      userInput: 'Expanded target prompt',
      originalUserInput: 'Original user prompt',
      userMessageMetadata: { targetFact: true },
    });

    const turns = FlowChatStore.getInstance()
      .getState()
      .sessions.get('dispatch-session')
      ?.dialogTurns;
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({
      id: 'target-turn-1',
      userMessage: {
        content: 'Original user prompt',
        metadata: { targetFact: true },
      },
      modelRounds: [{ id: 'dispatch-setup:job-1' }],
    });
  });
});

describe('MiniApp transient session reconciliation', () => {
  beforeEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('upgrades a SessionCreated placeholder when DialogTurnStarted identifies a MiniApp Agent run', () => {
    const store = FlowChatStore.getInstance();
    store.addExternalSession(
      'loopx-session',
      'LoopX #133',
      'Cowork',
      'D:/worktree',
    );

    __test_only__.handleDialogTurnStarted(createFlowChatContext(), {
      sessionId: 'loopx-session',
      turnId: 'loopx-turn-1',
      turnIndex: 0,
      userInput: 'Run LoopX task',
      userMessageMetadata: {
        surface: 'miniapp_agent',
        appId: 'builtin-bitfun-loopx',
      },
    });

    expect(store.getState().sessions.get('loopx-session')).toMatchObject({
      isTransient: true,
      agentBackedTransient: true,
      sessionKind: 'miniapp',
    });
  });
});

describe('mergeParamsPartialEventData', () => {
  it('appends Write argument deltas within a batch', () => {
    const merged = __test_only__.mergeParamsPartialEventData(
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        roundId: 'round-1',
        toolEvent: {
          event_type: 'ParamsPartial',
          tool_id: 'tool-1',
          tool_name: 'Write',
          params: '{"file_path":"src/app.ts","content":"',
        },
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        roundId: 'round-1',
        toolEvent: {
          event_type: 'ParamsPartial',
          tool_id: 'tool-1',
          tool_name: 'Write',
          params: 'hello',
        },
      },
    );

    expect((merged.toolEvent as any).params).toBe('{"file_path":"src/app.ts","content":"hello');
  });

});

describe('subagent parent helpers', () => {
  beforeEach(() => {
    resetFlowChatStore();
  });

  afterEach(() => {
    resetFlowChatStore();
  });

  it('finds the parent task card by subagent session and dialog turn', () => {
    const firstTask = makeTaskTool('task-1', {
      subagentSessionId: 'subagent-1',
      subagentDialogTurnId: 'child-turn-1',
    });
    const secondTask = makeTaskTool('task-2', {
      subagentSessionId: 'subagent-1',
      subagentDialogTurnId: 'child-turn-2',
    });

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        'parent-session',
        {
          sessionId: 'parent-session',
          title: 'Parent Session',
          dialogTurns: [{
            id: 'parent-turn',
            sessionId: 'parent-session',
            userMessage: {
              id: 'user-1',
              content: 'Run subagents',
              timestamp: 900,
            },
            modelRounds: [makeRound('round-1', [firstTask, secondTask])],
            status: 'processing',
            startTime: 900,
          }],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 800,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: 'parent-session',
    }));

    expect(__test_only__.findSubagentParentInfoByRound('subagent-1', 'child-turn-2'))
      .toEqual({
        sessionId: 'parent-session',
        dialogTurnId: 'parent-turn',
        toolCallId: 'task-2',
      });
  });

  it('projects a linked Review manifest into the live child session', () => {
    const task = makeTaskTool('task-review');
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        'parent-session',
        {
          sessionId: 'parent-session',
          title: 'Parent Session',
          dialogTurns: [{
            id: 'parent-turn',
            sessionId: 'parent-session',
            userMessage: { id: 'user-1', content: 'Review', timestamp: 900 },
            modelRounds: [makeRound('round-1', [task])],
            status: 'processing',
            startTime: 900,
          }],
          status: 'idle',
          config: { agentType: 'CodeReview' },
          createdAt: 800,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
          workspacePath: 'D:\\workspace\\repo',
        } as Session,
      ]]),
      activeSessionId: 'parent-session',
    }));
    __test_only__.handleSubagentSessionLinked(
      { currentWorkspacePath: 'D:\\workspace\\repo' } as FlowChatContext,
      {
        sessionId: 'review-child',
        parentSessionId: 'parent-session',
        parentDialogTurnId: 'parent-turn',
        parentToolCallId: 'task-review',
        agentType: 'ReviewWorker',
        focusedReviewDisplayLabel: 'Authentication boundary',
      },
    );

    expect(
      FlowChatStore.getInstance().getState().sessions.get('review-child')?.focusedReviewDisplayLabel,
    ).toBe('Authentication boundary');
  });

  it('stores an absolute parent Turn index when linking from a partial restored tail', () => {
    const task = makeTaskTool('task-tail');
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        'parent-session',
        {
          sessionId: 'parent-session',
          title: 'Parent Session',
          dialogTurns: [{
            id: 'parent-turn-100',
            sessionId: 'parent-session',
            backendTurnIndex: 99,
            userMessage: { id: 'user-100', content: 'Delegate work', timestamp: 900 },
            modelRounds: [makeRound('round-100', [task])],
            status: 'processing',
            startTime: 900,
          }],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 800,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
          isPartial: true,
          loadedTurnCount: 1,
          totalTurnCount: 100,
          turnCatalog: {
            schemaVersion: 1,
            sessionId: 'parent-session',
            revision: 'catalog-1',
            totalTurnCount: 100,
            complete: false,
            entries: [{
              ordinal: 99,
              storageTurnIndex: 99,
              turnId: 'parent-turn-100',
              preview: 'Delegate work',
              previewTruncated: false,
            }],
          },
        } as Session,
      ]]),
      activeSessionId: 'parent-session',
    }));

    __test_only__.handleSubagentSessionLinked(
      { currentWorkspacePath: 'D:\\workspace\\repo' } as FlowChatContext,
      {
        sessionId: 'child-session',
        parentSessionId: 'parent-session',
        parentDialogTurnId: 'parent-turn-100',
        parentToolCallId: 'task-tail',
        agentType: 'Explore',
      },
    );

    expect(
      FlowChatStore.getInstance().getState().sessions.get('child-session')?.btwOrigin,
    ).toMatchObject({
      parentSessionId: 'parent-session',
      parentDialogTurnId: 'parent-turn-100',
      parentTurnIndex: 100,
    });
  });
});

describe('shouldProcessEvent', () => {
  const mockSessionId = 'test-session';
  const mockTurnId = 'test-turn';

  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    useSessionMutationStore.setState({ mutations: new Map(), retiredTurnIds: new Map() });
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
    useSessionMutationStore.setState({ mutations: new Map(), retiredTurnIds: new Map() });
  });

  it('returns false for data event when no state machine exists', () => {
    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'TextChunk'),
    ).toBe(false);
  });

  it('returns true for state_sync event even when no state machine exists', () => {
    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'state_sync', 'SessionStateChanged'),
    ).toBe(true);
  });

  it('returns true for control event when state is IDLE', () => {
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.IDLE,
      getContext: () => ({ currentDialogTurnId: mockTurnId }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'control', 'DialogTurnStarted'),
    ).toBe(true);
  });

  it('returns false for control event when state is PROCESSING', () => {
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.PROCESSING,
      getContext: () => ({ currentDialogTurnId: mockTurnId }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'control', 'DialogTurnStarted'),
    ).toBe(false);
  });

  it('returns false for data event when state is not streaming', () => {
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.IDLE,
      getContext: () => ({ currentDialogTurnId: mockTurnId }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'TextChunk'),
    ).toBe(false);
  });

  it('recovers active latest-turn data when the state machine was reset to idle', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        mockSessionId,
        {
          sessionId: mockSessionId,
          title: 'Test Session',
          dialogTurns: [{
            id: mockTurnId,
            sessionId: mockSessionId,
            userMessage: {
              id: 'user-1',
              content: 'Continue review',
              timestamp: 1000,
            },
            modelRounds: [],
            status: 'processing',
            startTime: 1000,
          }],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 1000,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: mockSessionId,
    }));
    stateMachineManager.getOrCreate(mockSessionId);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'ToolEvent'),
    ).toBe(true);
    expect(stateMachineManager.getCurrentState(mockSessionId)).toBe(SessionExecutionState.PROCESSING);
    expect(stateMachineManager.get(mockSessionId)?.getContext().currentDialogTurnId).toBe(mockTurnId);
  });

  it('keeps accepting latest-turn data while idle recovery is still in flight', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        mockSessionId,
        {
          sessionId: mockSessionId,
          title: 'Test Session',
          dialogTurns: [{
            id: mockTurnId,
            sessionId: mockSessionId,
            userMessage: {
              id: 'user-1',
              content: 'Continue review',
              timestamp: 1000,
            },
            modelRounds: [],
            status: 'processing',
            startTime: 1000,
          }],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 1000,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: mockSessionId,
    }));
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.IDLE,
      getContext: () => ({ currentDialogTurnId: mockTurnId }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'ToolEvent'),
    ).toBe(true);
  });

  it('does not recover idle data for an old non-latest turn', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        mockSessionId,
        {
          sessionId: mockSessionId,
          title: 'Test Session',
          dialogTurns: [
            {
              id: mockTurnId,
              sessionId: mockSessionId,
              userMessage: {
                id: 'user-1',
                content: 'Old turn',
                timestamp: 1000,
              },
              modelRounds: [],
              status: 'processing',
              startTime: 1000,
            },
            {
              id: 'newer-turn',
              sessionId: mockSessionId,
              userMessage: {
                id: 'user-2',
                content: 'New turn',
                timestamp: 2000,
              },
              modelRounds: [],
              status: 'processing',
              startTime: 2000,
            },
          ],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 1000,
          lastActiveAt: 2000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: mockSessionId,
    }));
    stateMachineManager.getOrCreate(mockSessionId);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'ToolEvent'),
    ).toBe(false);
    expect(stateMachineManager.getCurrentState(mockSessionId)).toBe(SessionExecutionState.IDLE);
  });

  it('does not recover idle data for a cancelled latest turn', () => {
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([[
        mockSessionId,
        {
          sessionId: mockSessionId,
          title: 'Test Session',
          dialogTurns: [{
            id: mockTurnId,
            sessionId: mockSessionId,
            userMessage: {
              id: 'user-1',
              content: 'Cancelled review',
              timestamp: 1000,
            },
            modelRounds: [],
            status: 'cancelled',
            startTime: 1000,
          }],
          status: 'idle',
          config: { agentType: 'Standard' },
          createdAt: 1000,
          lastActiveAt: 1000,
          error: null,
          sessionKind: 'normal',
        } as Session,
      ]]),
      activeSessionId: mockSessionId,
    }));
    stateMachineManager.getOrCreate(mockSessionId);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'ToolEvent'),
    ).toBe(false);
    expect(stateMachineManager.getCurrentState(mockSessionId)).toBe(SessionExecutionState.IDLE);
  });

  it('returns false for data event when turn ID mismatches', () => {
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.PROCESSING,
      getContext: () => ({ currentDialogTurnId: 'different-turn' }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'TextChunk'),
    ).toBe(false);
  });

  it('returns true for data event when all conditions match', () => {
    vi.spyOn(stateMachineManager, 'get').mockReturnValue({
      getCurrentState: () => SessionExecutionState.PROCESSING,
      getContext: () => ({ currentDialogTurnId: mockTurnId }),
    } as any);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'TextChunk'),
    ).toBe(true);
  });

  it('drops data and turn-start events for a retired rollback suffix', () => {
    const context = createFlowChatContext();
    stateMachineManager.getOrCreate(mockSessionId);
    markSessionTurnsRetired(mockSessionId, [mockTurnId]);

    expect(
      shouldProcessEvent(mockSessionId, mockTurnId, 'data', 'TextChunk'),
    ).toBe(false);

    __test_only__.handleDialogTurnStarted(context, {
      sessionId: mockSessionId,
      turnId: mockTurnId,
      turnIndex: 7,
      userInput: 'late rollback event',
    });
    expect(
      FlowChatStore.getInstance().getState().sessions.get(mockSessionId),
    ).toBeUndefined();
  });
});

describe('handleDialogTurnFailed', () => {
  beforeEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('keeps a zero-round turn and records the terminal provider error', () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Initial request',
        timestamp: 900,
      },
      modelRounds: [],
      status: 'processing',
      startTime: 900,
    });
    const context = createFlowChatContext();
    context.userCancelledSessionIds.add('session-1');

    __test_only__.handleDialogTurnFailed(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      error: 'OpenAI Streaming API failed after 10 attempts: connection refused',
      errorDetail: {
        category: 'network',
        provider: 'openai',
      },
    });

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns.find(item => item.id === 'turn-1');

    expect(turn).toMatchObject({
      status: 'error',
      error: 'OpenAI Streaming API failed after 10 attempts: connection refused',
      errorDetail: {
        category: 'network',
        provider: 'openai',
      },
      modelRounds: [],
    });
    expect(notificationService.error).not.toHaveBeenCalled();
    expect(notificationService.warning).not.toHaveBeenCalled();
    expect(context.userCancelledSessionIds.has('session-1')).toBe(false);
  });
});

async function startStreamingMachine(): Promise<void> {
  await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
    taskId: 'session-1',
    dialogTurnId: 'turn-1',
  });
}

describe('handleModelRoundStart', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('creates a model round even when model identity fields are absent (external ACP agents)', async () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Initial request',
        timestamp: 900,
      },
      modelRounds: [],
      status: 'processing',
      startTime: 900,
    });
    await startStreamingMachine();
    const context = createFlowChatContext();

    expect(() =>
      __test_only__.handleModelRoundStart(context, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        roundId: 'round-1',
        roundIndex: 0,
      } as any),
    ).not.toThrow();

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns.find(item => item.id === 'turn-1');

    expect(turn?.modelRounds).toHaveLength(1);
    expect(turn?.modelRounds[0]).toMatchObject({
      id: 'round-1',
      index: 0,
      isStreaming: true,
    });
    expect(turn?.modelRounds[0]?.modelConfigId).toBeUndefined();
    expect(turn?.modelRounds[0]?.effectiveModelName).toBeUndefined();
  });

  it('trims and stores model identity fields when present', async () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Initial request',
        timestamp: 900,
      },
      modelRounds: [],
      status: 'processing',
      startTime: 900,
    });
    await startStreamingMachine();
    const context = createFlowChatContext();

    __test_only__.handleModelRoundStart(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
      roundIndex: 0,
      modelConfigId: '  config-1  ',
      effectiveModelName: '  gpt-4o  ',
    } as any);

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns.find(item => item.id === 'turn-1');

    expect(turn?.modelRounds).toHaveLength(1);
    expect(turn?.modelRounds[0]).toMatchObject({
      modelConfigId: 'config-1',
      effectiveModelName: 'gpt-4o',
    });
  });
});

function resetFlowChatStore(): void {
  FlowChatStore.getInstance().setState(() => ({
    sessions: new Map(),
    activeSessionId: null,
  }));
}

function makeRound(id: string, items: ModelRound['items'] = []): ModelRound {
  return {
    id,
    index: 0,
    items,
    isStreaming: true,
    isComplete: false,
    status: 'streaming',
    startTime: 1000,
  };
}

function makeTaskTool(id: string, overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id,
    type: 'tool',
    toolName: 'Task',
    timestamp: 1000,
    status: 'completed',
    toolCall: {
      id,
      input: {
        prompt: 'Run task',
      },
    },
    ...overrides,
  };
}

function createSessionWithTurn(turn: DialogTurn): void {
  const store = FlowChatStore.getInstance();
  store.createSession('session-1', {});
  store.addDialogTurn('session-1', turn);
}

function createFinishingTurn(): DialogTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    userMessage: {
      id: 'user-1',
      content: 'Initial request',
      timestamp: 900,
    },
    modelRounds: [{
      ...makeRound('round-1'),
      items: [],
    }],
    status: 'finishing',
    startTime: 900,
  };
}

function createFinishingSession(): Session {
  return {
    sessionId: 'session-1',
    title: 'Session 1',
    dialogTurns: [createFinishingTurn()],
    status: 'idle',
    config: { agentType: 'Standard' },
    createdAt: 800,
    lastActiveAt: 1000,
    error: null,
    isTransient: true,
  };
}

function createFlowChatContext(): FlowChatContext {
  return {
    flowChatStore: FlowChatStore.getInstance(),
    processingManager: {
      clearSessionStatus: vi.fn(),
    } as any,
    eventBatcher: {
      getBufferSize: vi.fn(() => 0),
      flushNow: vi.fn(),
      clear: vi.fn(),
    } as any,
    pendingTurnCompletions: new Map(),
    pendingHistoryLoads: new Map(),
    contentBuffers: new Map(),
    activeTextItems: new Map(),
    saveDebouncers: new Map(),
    lastSaveTimestamps: new Map(),
    lastSaveHashes: new Map(),
    turnSaveInFlight: new Map(),
    turnSavePending: new Set(),
    deferredStorageIdentitySaves: new Set(),
    runtimeStatusTimers: new Map(),
    userCancelledSessionIds: new Set(),
    pendingHistoryFenceSessions: new Set(),
    handledTerminalTurnEvents: new Set(),
    currentWorkspacePath: null,
  };
}

async function setFinishingMachine(): Promise<void> {
  await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
    taskId: 'session-1',
    dialogTurnId: 'turn-1',
  });
  await stateMachineManager.transition('session-1', SessionExecutionEvent.BACKEND_STREAM_COMPLETED);
}

function putFinishingSessionInStore(): void {
  FlowChatStore.getInstance().setState(() => ({
    sessions: new Map([['session-1', createFinishingSession()]]),
    activeSessionId: 'session-1',
  }));
}

describe('insertSteeringItemIfAbsent', () => {
  beforeEach(() => {
    resetFlowChatStore();
  });

  afterEach(() => {
    resetFlowChatStore();
  });

  it('inserts a visible steering item even before the first model round starts', () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Initial request',
        timestamp: 900,
      },
      modelRounds: [],
      status: 'processing',
      startTime: 900,
    });

    const inserted = insertSteeringItemIfAbsent({
      sessionId: 'session-1',
      turnId: 'turn-1',
      steeringId: 'steer-1',
      content: 'Please adjust this now',
      status: 'pending',
    });

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns.find(item => item.id === 'turn-1');

    expect(inserted).toBe(true);
    expect(turn?.modelRounds).toHaveLength(1);
    expect(turn?.modelRounds[0]?.items[0]).toMatchObject({
      id: 'steering_steer-1',
      type: 'user-steering',
      content: 'Please adjust this now',
      status: 'pending',
    });
  });

  it('dedupes an existing steering item across all rounds when backend confirms it', () => {
    const pendingSteering: FlowUserSteeringItem = {
      id: 'steering_steer-1',
      type: 'user-steering',
      steeringId: 'steer-1',
      content: 'Original steering',
      roundIndex: 0,
      timestamp: 1001,
      status: 'pending',
    };
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Initial request',
        timestamp: 900,
      },
      modelRounds: [
        makeRound('round-1', [pendingSteering]),
        makeRound('round-2'),
      ],
      status: 'processing',
      startTime: 900,
    });

    const inserted = insertSteeringItemIfAbsent({
      sessionId: 'session-1',
      turnId: 'turn-1',
      steeringId: 'steer-1',
      content: 'Original steering',
      roundIndex: 1,
      status: 'completed',
    });

    const rounds = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns.find(item => item.id === 'turn-1')
      ?.modelRounds ?? [];
    const steeringItems = rounds.flatMap(round =>
      round.items.filter(item => item.type === 'user-steering'),
    );

    expect(inserted).toBe(false);
    expect(steeringItems).toHaveLength(1);
    expect(steeringItems[0]).toMatchObject({
      id: 'steering_steer-1',
      status: 'completed',
      roundIndex: 1,
    });
  });
});

describe('handleSessionStateChanged', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('finalizes pending turn completion when backend reports idle during finishing', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    context.pendingTurnCompletions.set('session-1', {
      turnId: 'turn-1',
      lastActivityAt: Date.now(),
      timer: null,
    });
    await setFinishingMachine();

    handleSessionStateChanged(context, { sessionId: 'session-1', newState: 'Idle' });

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0];
    expect(turn?.status).toBe('completed');
    expect(context.pendingTurnCompletions.has('session-1')).toBe(false);
    expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);
  });

  it('finalizes a finishing turn even if the pending completion record was lost', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    await setFinishingMachine();

    handleSessionStateChanged(context, { sessionId: 'session-1', newState: 'Idle' });

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0];
    expect(turn?.status).toBe('completed');
    expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);
  });
});

describe('handleSessionHistoryChanged', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
  });

  afterEach(() => {
    resetFlowChatStore();
  });

  it('reconciles the latest settled native turn after the durable history fence', async () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'request', timestamp: 1 },
      modelRounds: [],
      status: 'completed',
      startTime: 1,
      endTime: 2,
    });
    const reconcile = vi.spyOn(
      FlowChatStore.getInstance(),
      'reconcileSettledDialogTurn',
    ).mockResolvedValue(true);

    const context = createFlowChatContext();
    handleSessionHistoryChanged(context, {
      sessionId: 'session-1',
    });
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledWith('session-1', 'turn-1');
    expect(context.pendingHistoryFenceSessions.has('session-1')).toBe(false);
  });

  it('parks the fence for the completion finalizer while the turn is still settling', async () => {
    createSessionWithTurn({
      id: 'turn-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      userMessage: { id: 'user-1', content: 'request', timestamp: 1 },
      modelRounds: [],
      status: 'finishing',
      startTime: 1,
    });
    const reconcile = vi.spyOn(
      FlowChatStore.getInstance(),
      'reconcileSettledDialogTurn',
    ).mockResolvedValue(true);

    const context = createFlowChatContext();
    handleSessionHistoryChanged(context, {
      sessionId: 'session-1',
    });
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
    expect(context.pendingHistoryFenceSessions.has('session-1')).toBe(true);
  });
});

describe('handleDialogTurnComplete', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
    vi.spyOn(FlowChatStore.getInstance(), 'reconcileSettledDialogTurn')
      .mockResolvedValue(false);
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('treats unsuccessful completed events as errors instead of normal completion', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    await setFinishingMachine();

    handleDialogTurnComplete(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      success: false,
      finishReason: 'empty_round',
    }, vi.fn());

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0];

    expect(turn?.status).toBe('error');
    expect(turn?.error).toContain('empty response');
    expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);
  });

  it('keeps abnormal completion turns on the completed path when no final response was produced', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    await setFinishingMachine();

    handleDialogTurnComplete(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      success: true,
      finishReason: 'max_rounds',
      hasFinalResponse: false,
    }, vi.fn());

    const turn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0];

    expect(turn?.status).toBe('finishing');
    expect(turn?.finishReason).toBe('max_rounds');
    expect(turn?.hasFinalResponse).toBe(false);
  });

  it('preserves the event duration when the quiet completion finalizer runs later', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    await setFinishingMachine();

    handleDialogTurnComplete(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      durationMs: 21_206,
      success: true,
      finishReason: 'stop',
      hasFinalResponse: true,
    }, vi.fn());

    const eventOwnedEndTime = 900 + 21_206;
    expect(FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0].endTime).toBe(eventOwnedEndTime);

    // Durable fence lands while the turn is still finalizing: it must be
    // parked instead of racing the persistence commit with an extra read.
    handleSessionHistoryChanged(context, { sessionId: 'session-1' });
    expect(FlowChatStore.getInstance().reconcileSettledDialogTurn)
      .not.toHaveBeenCalled();
    expect(context.pendingHistoryFenceSessions.has('session-1')).toBe(true);

    handleSessionStateChanged(context, {
      sessionId: 'session-1',
      newState: 'Idle',
    });

    const finalizedTurn = FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0];
    expect(finalizedTurn?.status).toBe('completed');
    expect(finalizedTurn?.endTime).toBe(eventOwnedEndTime);
    expect(FlowChatStore.getInstance().reconcileSettledDialogTurn)
      .toHaveBeenCalledTimes(1);
    expect(FlowChatStore.getInstance().reconcileSettledDialogTurn)
      .toHaveBeenCalledWith('session-1', 'turn-1');
    expect(context.pendingHistoryFenceSessions.has('session-1')).toBe(false);
  });

  it('skips the settled-turn reconcile when no durable fence has been observed', async () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();
    await setFinishingMachine();

    handleDialogTurnComplete(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      success: true,
      finishReason: 'stop',
      hasFinalResponse: true,
    }, vi.fn());

    handleSessionStateChanged(context, {
      sessionId: 'session-1',
      newState: 'Idle',
    });

    expect(FlowChatStore.getInstance()
      .getState()
      .sessions.get('session-1')
      ?.dialogTurns[0].status).toBe('completed');
    expect(FlowChatStore.getInstance().reconcileSettledDialogTurn)
      .not.toHaveBeenCalled();
  });

  it('clears the cancellation gate when the same turn completes during cancel', async () => {
    vi.useFakeTimers();
    try {
      putFinishingSessionInStore();
      const context = createFlowChatContext();
      context.userCancelledSessionIds.add('session-1');
      await setFinishingMachine();

      handleDialogTurnComplete(context, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        success: true,
        finishReason: 'complete',
        hasFinalResponse: true,
      }, vi.fn());

      expect(context.userCancelledSessionIds.has('session-1')).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(context.userCancelledSessionIds.has('session-1')).toBe(false);
      expect(stateMachineManager.getCurrentState('session-1')).toBe(SessionExecutionState.IDLE);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handleCompressionCompleted', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('writes the compacted token count into currentTokenUsage when applied', () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();

    handleCompressionCompleted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      compressionId: 'compression-1',
      applied: true,
      tokensBefore: 90_000,
      tokensAfter: 15_000,
      compressionRatio: 0.17,
      durationMs: 500,
      hasSummary: true,
      summarySource: 'model',
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toEqual({
      inputTokens: 15_000,
      outputTokens: undefined,
      totalTokens: 15_000,
      timestamp: expect.any(Number),
      turnId: 'turn-1',
      source: 'context_compression',
    });
  });

  it('does not touch currentTokenUsage when the compression was not applied', () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();

    handleCompressionCompleted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      compressionId: 'compression-1',
      applied: false,
      tokensBefore: 90_000,
      tokensAfter: 90_000,
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toBeUndefined();
  });

  it('ignores invalid tokensAfter values even when applied', () => {
    putFinishingSessionInStore();
    const context = createFlowChatContext();

    handleCompressionCompleted(context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      compressionId: 'compression-1',
      applied: true,
      tokensAfter: undefined,
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toBeUndefined();
  });

  it('ignores a delayed successful compression after its source turn was removed', () => {
    putFinishingSessionInStore();
    FlowChatStore.getInstance().deleteDialogTurn('session-1', 'turn-1');

    handleCompressionCompleted(createFlowChatContext(), {
      sessionId: 'session-1',
      turnId: 'turn-1',
      compressionId: 'compression-1',
      applied: true,
      tokensBefore: 90_000,
      tokensAfter: 15_000,
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toBeUndefined();
  });
});

describe('handleTokenUsageUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  afterEach(() => {
    resetFlowChatStore();
    stateMachineManager.clear();
  });

  it('tracks the source turn on current usage without adding provenance to accumulated turn usage', () => {
    putFinishingSessionInStore();

    handleTokenUsageUpdate(createFlowChatContext(), {
      sessionId: 'session-1',
      turnId: 'turn-1',
      inputTokens: 1_200,
      outputTokens: 320,
      totalTokens: 1_520,
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 320,
      totalTokens: 1_520,
      turnId: 'turn-1',
      source: 'model_request',
    });
    expect(session?.dialogTurns[0].tokenUsage).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 320,
      totalTokens: 1_520,
    });
    expect(session?.dialogTurns[0].tokenUsage).not.toHaveProperty('turnId');
    expect(session?.dialogTurns[0].tokenUsage).not.toHaveProperty('source');
  });

  it('ignores a delayed model usage update after its source turn was removed', () => {
    putFinishingSessionInStore();
    FlowChatStore.getInstance().deleteDialogTurn('session-1', 'turn-1');

    handleTokenUsageUpdate(createFlowChatContext(), {
      sessionId: 'session-1',
      turnId: 'turn-1',
      inputTokens: 1_200,
      outputTokens: 320,
      totalTokens: 1_520,
    });

    const session = FlowChatStore.getInstance().getState().sessions.get('session-1');
    expect(session?.currentTokenUsage).toBeUndefined();
  });
});
