import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const peerModeMock = vi.hoisted(() => ({ active: true }));
const stateMachineMock = vi.hoisted(() => ({
  get: vi.fn(() => ({
    getCurrentState: () => 'idle',
    getContext: () => ({ lastUpdateTime: 0 }),
  })),
  reset: vi.fn(),
  transition: vi.fn(async () => true),
}));
const agenticListenerMock = vi.hoisted(() => ({
  getIsListening: vi.fn(() => true),
  dispatchExternal: vi.fn(() => true),
}));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => peerModeMock.active,
}));

vi.mock('../../state-machine', () => ({
  stateMachineManager: stateMachineMock,
}));

vi.mock('../liveSessionInteractionStore', () => ({
  installLiveSessionInteractionMailbox: vi.fn(),
}));

vi.mock('../AgenticEventListener', () => ({
  agenticEventListener: agenticListenerMock,
}));

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { sessionStream } from '../../session-stream/SessionStream';
import { FlowChatStore } from '../../store/FlowChatStore';
import {
  installPeerSessionRefresh,
  isSessionProjectionAttachable,
  requestPeerSessionRefresh,
  runtimeProjectionCaughtUp,
} from './PeerSessionRefreshModule';
import { processToolEvent } from './ToolEventModule';
import {
  markRuntimeSessionProjectionStale,
  resetRuntimeSessionEventGateForTest,
} from '@/infrastructure/peer-device/runtimeSessionEventGate';

describe('PeerSessionRefreshModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    peerModeMock.active = true;
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    resetRuntimeSessionEventGateForTest();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hydrates once and repairs explicit gaps without periodic requests', async () => {
    const refreshPeerSessionSnapshot = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing',
      latestTurnId: 'turn-1',
      latestTurnStatus: 'processing',
    }));
    const state = {
      activeSessionId: 'session-1',
      sessions: new Map([
        ['session-1', {
          sessionId: 'session-1',
          workspaceId: 'workspace-1', workspacePath: '/peer/project',
          historyState: 'ready',
          isHistorical: false,
          isTransient: false,
        }],
      ]),
    };
    const context = {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: {
        flushNow: vi.fn(),
        clear: vi.fn(),
      },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshPeerSessionSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshPeerSessionSnapshot).toHaveBeenCalledTimes(1);

    requestPeerSessionRefresh('session-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshPeerSessionSnapshot).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it('does not poll when Peer Device Mode is inactive', async () => {
    peerModeMock.active = false;
    const refreshPeerSessionSnapshot = vi.fn();
    const context = {
      flowChatStore: {
        getState: () => ({
          activeSessionId: 'session-1',
          sessions: new Map(),
        }),
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: {
        flushNow: vi.fn(),
        clear: vi.fn(),
      },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(60_000 * 2);

    expect(refreshPeerSessionSnapshot).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('PeerSessionRefreshModule re-attach after a surface switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    peerModeMock.active = true;
    resetRuntimeSessionEventGateForTest();
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    resetRuntimeSessionEventGateForTest();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function contextWithSnapshot(
    refreshPeerSessionSnapshot: ReturnType<typeof vi.fn>,
  ) {
    const state = {
      activeSessionId: 'session-1',
      sessions: new Map([
        ['session-1', {
          sessionId: 'session-1',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'ready',
          isHistorical: false,
          isTransient: false,
          dialogTurns: [{
            id: 'turn-live',
            status: 'processing',
            modelRounds: [{ id: 'round-0', items: [] }],
          }],
        }],
      ]),
    };
    return {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
        reconcilePendingUserQuestions: vi.fn(),
        prepareRuntimeTurnReplay: vi.fn(),
      },
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;
  }

  it('re-attaches an executing turn when the snapshot was refused or unchanged', async () => {
    // The content-safety guard can refuse a snapshot that would gut the turn.
    // The host is still executing, so the rebuilt surface must reattach anyway.
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'idle',
      getContext: () => ({ lastUpdateTime: 0, version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));

    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).toHaveBeenCalled();
    expect(stateMachineMock.transition).toHaveBeenCalled();
    cleanup();
  });

  it('does not poll or churn while a turn is already streaming fresh events', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));

    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stateMachineMock.reset).not.toHaveBeenCalled();
    cleanup();
  });

  it('repairs a missing ToolEnd from the prefix instead of an empty suffix after the delivered cursor', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const stream = sessionStream('local', 'session-1');
    const position = (cursor: number) => ({ streamId: 'runtime-linux', cursor });
    stream.offer('agentic://dialog-turn-started', { turnId: 'turn-live' }, position(1), () => {});
    stream.offer('agentic://text-chunk', { turnId: 'turn-live' }, position(3), () => {});
    const delta = vi.spyOn(agentAPI, 'loadSessionEventBackfill').mockResolvedValue({
      kind: 'delta', sessionId: 'session-1', streamId: 'runtime-linux', cursor: 3, events: [],
    } as any);
    const refresh = vi.fn(async () => ({ applied: false }));
    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    expect(delta).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    cleanup();
    delta.mockRestore();
  });

  it('still attaches a fresh streaming turn when the projection is stale', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));

    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    markRuntimeSessionProjectionStale('local', 'session-1');
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('repairs a named session while the document is hidden', async () => {
    const documentStub = {
      visibilityState: 'visible' as Document['visibilityState'],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('document', documentStub);
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));

    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    refresh.mockClear();

    documentStub.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();

    requestPeerSessionRefresh('session-1');
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('attaches during FINISHING when the projection is stale', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'finishing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));

    const cleanup = installPeerSessionRefresh(contextWithSnapshot(refresh));
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).not.toHaveBeenCalled();

    markRuntimeSessionProjectionStale('local', 'session-1');
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('replays when the cursor matches but a journal ToolEnd is still running in the UI', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const runtimeEventSnapshot = {
      sessionId: 'session-1',
      streamId: 'runtime-a',
      cursor: 8,
      activeTurnId: 'turn-live',
      events: [{
        eventName: 'agentic://tool-event',
        payload: {
          sessionId: 'session-1',
          turnId: 'turn-live',
          roundId: 'round-0',
          toolEvent: {
            event_type: 'Completed',
            tool_id: 'read-1',
            tool_name: 'Read',
          },
        },
      }],
    };
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
      runtimeEventReplayRequired: false,
      runtimeEventSnapshot,
    }));
    const context = contextWithSnapshot(refresh);
    const session = context.flowChatStore.getState().sessions.get('session-1');
    session.dialogTurns[0].modelRounds[0].items = [{
      id: 'read-1',
      type: 'tool',
      toolName: 'Read',
      status: 'running',
      timestamp: 1,
      toolCall: { id: 'read-1', input: { file_path: 'README.md' } },
    }];

    expect(runtimeProjectionCaughtUp(session, runtimeEventSnapshot)).toBe(false);

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(agenticListenerMock.dispatchExternal).toHaveBeenCalledWith(
      'agentic://tool-event',
      runtimeEventSnapshot.events[0].payload,
    );
    expect(context.flowChatStore.prepareRuntimeTurnReplay).toHaveBeenCalledWith(
      'session-1',
      'turn-live',
    );
    cleanup();
  });

  it('preserves other-session events while replaying the Runtime projection before its mailbox', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'idle',
      getContext: () => ({ lastUpdateTime: 0, version: 0 }),
    });
    const runtimeEventSnapshot = {
      sessionId: 'session-1',
      streamId: 'runtime-a',
      cursor: 8,
      activeTurnId: 'turn-live',
      events: [
        {
          eventName: 'agentic://dialog-turn-started',
          payload: { sessionId: 'session-1', turnId: 'turn-live' },
        },
        {
          eventName: 'agentic://text-chunk',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-live',
            roundId: 'round-0',
            text: 'materialized output',
          },
        },
      ],
    };
    const pendingOtherSession: string[] = [];
    const paintedOtherSession: string[] = [];
    const refresh = vi.fn(async () => {
      pendingOtherSession.push('other-session text');
      return {
        applied: true,
        backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
        latestTurnId: 'turn-live',
        latestTurnStatus: 'processing',
        runtimeEventSnapshot,
        pendingUserQuestions: { revision: 2, questions: [] },
      };
    });
    const context = contextWithSnapshot(refresh);
    context.eventBatcher.flushNow.mockImplementation(() => paintedOtherSession.push(...pendingOtherSession.splice(0)));
    context.eventBatcher.clear.mockImplementation(() => { pendingOtherSession.length = 0; });

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(agenticListenerMock.dispatchExternal).toHaveBeenNthCalledWith(
      1,
      'agentic://dialog-turn-started',
      runtimeEventSnapshot.events[0].payload,
    );
    expect(agenticListenerMock.dispatchExternal).toHaveBeenNthCalledWith(
      2,
      'agentic://text-chunk',
      runtimeEventSnapshot.events[1].payload,
    );
    expect(paintedOtherSession).toEqual(['other-session text']);
    expect(context.eventBatcher.clear).not.toHaveBeenCalled();
    expect(context.flowChatStore.prepareRuntimeTurnReplay).toHaveBeenCalledWith(
      'session-1',
      'turn-live',
    );
    expect(context.flowChatStore.reconcilePendingUserQuestions).toHaveBeenCalledWith(
      'session-1',
      { revision: 2, questions: [] },
    );
    cleanup();
  });

  it('advances a healthy Runtime fence without resetting and replaying it', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
      runtimeEventReplayRequired: false,
      runtimeEventSnapshot: {
        sessionId: 'session-1',
        streamId: 'runtime-a',
        cursor: 8,
        activeTurnId: 'turn-live',
        events: [{
          eventName: 'agentic://text-chunk',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-live',
            roundId: 'round-0',
            text: 'already rendered',
          },
        }],
      },
    }));
    const context = contextWithSnapshot(refresh);

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(agenticListenerMock.dispatchExternal).not.toHaveBeenCalled();
    expect(context.eventBatcher.clear).not.toHaveBeenCalled();
    expect(stateMachineMock.reset).not.toHaveBeenCalled();
    cleanup();
  });

  it('reconciles the blocking mailbox when the Runtime projection is already current', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const pendingUserQuestions = {
      revision: 5,
      questions: [{
        toolId: 'ask-tool-1',
        sessionId: 'session-1',
        dialogTurnId: 'turn-live',
        modelRoundId: 'round-0',
        questions: { questions: [] },
        registeredAtMs: 1,
      }],
    };
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
      runtimeEventReplayRequired: false,
      runtimeEventSnapshot: {
        sessionId: 'session-1',
        streamId: 'runtime-a',
        cursor: 8,
        activeTurnId: 'turn-live',
        events: [],
      },
      pendingUserQuestions,
    }));
    const context = contextWithSnapshot(refresh);

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(context.flowChatStore.reconcilePendingUserQuestions).toHaveBeenCalledWith(
      'session-1',
      pendingUserQuestions,
    );
    expect(agenticListenerMock.dispatchExternal).not.toHaveBeenCalled();
    cleanup();
  });

  it('replays the Runtime journal even when persist merge was skipped', async () => {
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    const runtimeEventSnapshot = {
      sessionId: 'session-1',
      streamId: 'runtime-a',
      cursor: 20,
      activeTurnId: 'turn-live',
      events: [{
        eventName: 'agentic://tool-event',
        payload: { sessionId: 'session-1', turnId: 'turn-live', toolId: 'read-1' },
      }],
    };
    const refresh = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
      runtimeEventReplayRequired: true,
      runtimeEventSnapshot,
    }));
    const context = contextWithSnapshot(refresh);

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(agenticListenerMock.dispatchExternal).toHaveBeenCalledWith(
      'agentic://tool-event',
      runtimeEventSnapshot.events[0].payload,
    );
    cleanup();
  });
});

describe('PeerSessionRefreshModule dead subscription recovery', () => {
  /**
   * The reported freeze: repeated device switching tore the agentic
   * subscription down, and the reconcile loop refused to run while it was
   * down — so the only path that could repair the session view was disabled by
   * the very condition it existed to repair.
   */
  function contextWithDeadSubscription() {
    const refreshPeerSessionSnapshot = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));
    const ensureLiveSubscription = vi.fn(async () => {});
    const state = {
      activeSessionId: 'session-1',
      sessions: new Map([
        ['session-1', {
          sessionId: 'session-1',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'ready',
          isHistorical: false,
          isTransient: false,
          dialogTurns: [{ id: 'turn-live', status: 'processing', modelRounds: [] }],
        }],
      ]),
    };
    return {
      refreshPeerSessionSnapshot,
      ensureLiveSubscription,
      context: {
        flowChatStore: {
          getState: () => state,
          subscribeSelector: vi.fn(() => () => {}),
          refreshPeerSessionSnapshot,
        },
        eventBatcher: { flushNow: vi.fn() },
        contentBuffers: new Map(),
        activeTextItems: new Map(),
        ensureLiveSubscription,
      } as any,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    peerModeMock.active = true;
    resetRuntimeSessionEventGateForTest();
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'idle',
      getContext: () => ({ lastUpdateTime: 0, version: 0 }),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    agenticListenerMock.getIsListening.mockReturnValue(true);
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('still reconciles when the subscription is down', async () => {
    agenticListenerMock.getIsListening.mockReturnValue(false);
    const { context, refreshPeerSessionSnapshot } = contextWithDeadSubscription();

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refreshPeerSessionSnapshot).toHaveBeenCalled();
    cleanup();
  });

  it('re-arms the subscription it found dead', async () => {
    agenticListenerMock.getIsListening.mockReturnValue(false);
    const { context, ensureLiveSubscription } = contextWithDeadSubscription();

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ensureLiveSubscription).toHaveBeenCalled();
    cleanup();
  });

  it('does not re-arm a subscription that is already live', async () => {
    agenticListenerMock.getIsListening.mockReturnValue(true);
    const { context, ensureLiveSubscription } = contextWithDeadSubscription();

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ensureLiveSubscription).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('isSessionProjectionAttachable', () => {
  const base = {
    workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
    isTransient: false,
    isHistorical: false,
    historyState: 'ready' as const,
  };

  it('accepts a hydrated live session', () => {
    expect(isSessionProjectionAttachable(base)).toBe(true);
  });

  it('accepts a locally created session that never left historyState new', () => {
    expect(isSessionProjectionAttachable({ ...base, historyState: 'new' })).toBe(true);
  });

  it('rejects metadata-only, hydrating, failed, historical, and transient shells', () => {
    expect(isSessionProjectionAttachable({ ...base, historyState: 'metadata-only' })).toBe(false);
    expect(isSessionProjectionAttachable({ ...base, historyState: 'hydrating' })).toBe(false);
    expect(isSessionProjectionAttachable({ ...base, historyState: 'failed' })).toBe(false);
    expect(isSessionProjectionAttachable({ ...base, isHistorical: true })).toBe(false);
    expect(isSessionProjectionAttachable({ ...base, isTransient: true })).toBe(false);
    expect(isSessionProjectionAttachable({ ...base, workspaceId: '   ' })).toBe(false);
    expect(isSessionProjectionAttachable(null)).toBe(false);
  });
});

describe('PeerSessionRefreshModule attach eligibility after a surface switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    peerModeMock.active = true;
    resetRuntimeSessionEventGateForTest();
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'idle',
      getContext: () => ({ lastUpdateTime: 0, version: 0 }),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('attaches a locally created session that is still historyState new', async () => {
    const refreshPeerSessionSnapshot = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: Streaming }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
    }));
    const state = {
      activeSessionId: 'session-new',
      sessions: new Map([
        ['session-new', {
          sessionId: 'session-new',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'new',
          isHistorical: false,
          isTransient: false,
          dialogTurns: [],
        }],
      ]),
    };
    const context = {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshPeerSessionSnapshot).toHaveBeenCalledWith(
      'session-new',
      expect.objectContaining({ requireActiveSession: false }),
    );
    cleanup();
  });

  it('does not attach a metadata-only historical shell', async () => {
    const refreshPeerSessionSnapshot = vi.fn();
    const state = {
      activeSessionId: 'session-meta',
      sessions: new Map([
        ['session-meta', {
          sessionId: 'session-meta',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'metadata-only',
          isHistorical: true,
          isTransient: false,
        }],
      ]),
    };
    const context = {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshPeerSessionSnapshot).not.toHaveBeenCalled();
    cleanup();
  });

  it('attaches a background session named by a dropped-event refresh', async () => {
    const refreshPeerSessionSnapshot = vi.fn(async () => ({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-bg", phase: Streaming }',
      latestTurnId: 'turn-bg',
      latestTurnStatus: 'processing',
    }));
    const state = {
      activeSessionId: 'session-active',
      sessions: new Map([
        ['session-active', {
          sessionId: 'session-active',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'new',
          isHistorical: false,
          isTransient: false,
        }],
        ['session-bg', {
          sessionId: 'session-bg',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'new',
          isHistorical: false,
          isTransient: false,
        }],
      ]),
    };
    const context = {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);
    refreshPeerSessionSnapshot.mockClear();

    requestPeerSessionRefresh('session-bg');
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshPeerSessionSnapshot).toHaveBeenCalledWith(
      'session-bg',
      expect.objectContaining({ requireActiveSession: false }),
    );
    cleanup();
  });

  it('repairs a second live session queued while the first attach is in flight', async () => {
    let releaseFirst: ((value: {
      applied: boolean;
      backendState: string;
      latestTurnId: string;
      latestTurnStatus: string;
    }) => void) | undefined;
    const refreshPeerSessionSnapshot = vi.fn((sessionId: string) => {
      if (sessionId === 'session-active') {
        return new Promise(resolve => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        applied: false,
        backendState: 'Processing { current_turn_id: "turn-bg", phase: Streaming }',
        latestTurnId: 'turn-bg',
        latestTurnStatus: 'processing',
      });
    });
    const state = {
      activeSessionId: 'session-active',
      sessions: new Map([
        ['session-active', {
          sessionId: 'session-active',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'new',
          isHistorical: false,
          isTransient: false,
        }],
        ['session-bg', {
          sessionId: 'session-bg',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'new',
          isHistorical: false,
          isTransient: false,
        }],
      ]),
    };
    const context = {
      flowChatStore: {
        getState: () => state,
        subscribeSelector: vi.fn(() => () => {}),
        refreshPeerSessionSnapshot,
      },
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any;

    const cleanup = installPeerSessionRefresh(context);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshPeerSessionSnapshot).toHaveBeenCalledTimes(1);

    requestPeerSessionRefresh('session-bg');
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshPeerSessionSnapshot).toHaveBeenCalledTimes(1);

    releaseFirst?.({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-active", phase: Streaming }',
      latestTurnId: 'turn-active',
      latestTurnStatus: 'processing',
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshPeerSessionSnapshot).toHaveBeenCalledWith(
      'session-bg',
      expect.objectContaining({ requireActiveSession: false }),
    );
    cleanup();
  });
});

describe('PeerSessionRefreshModule journal apply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    peerModeMock.active = true;
    resetRuntimeSessionEventGateForTest();
    stateMachineMock.get.mockReturnValue({
      getCurrentState: () => 'processing',
      getContext: () => ({ lastUpdateTime: Date.now(), version: 0 }),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    FlowChatStore.getInstance().setState(prev => ({
      ...prev,
      sessions: new Map(),
      activeSessionId: null,
    }));
  });

  afterEach(() => {
    resetRuntimeSessionEventGateForTest();
    agenticListenerMock.dispatchExternal.mockReset();
    agenticListenerMock.dispatchExternal.mockReturnValue(true);
    FlowChatStore.getInstance().setState(prev => ({
      ...prev,
      sessions: new Map(),
      activeSessionId: null,
    }));
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('replays a cursor-covered ToolEnd until the card is completed', async () => {
    const store = FlowChatStore.getInstance();
    store.setState(prev => ({
      ...prev,
      activeSessionId: 'session-1',
      sessions: new Map([[
        'session-1',
        {
          sessionId: 'session-1',
          title: 'Live',
          workspaceId: 'workspace-1', workspacePath: '/repo/OpenBitFun',
          historyState: 'ready',
          isHistorical: false,
          isTransient: false,
          dialogTurns: [{
            id: 'turn-live',
            sessionId: 'session-1',
            userMessage: { id: 'user-1', content: 'Read it', timestamp: 1 },
            modelRounds: [{
              id: 'round-0',
              index: 0,
              items: [{
                id: 'read-1',
                type: 'tool',
                toolName: 'Read',
                status: 'running',
                timestamp: 2,
                toolCall: { id: 'read-1', input: { file_path: 'README.md' } },
              }],
              isStreaming: true,
              isComplete: false,
              status: 'streaming',
              startTime: 2,
            }],
            status: 'processing',
            startTime: 1,
          }],
          status: 'active',
          config: { agentType: 'Standard' },
          createdAt: 1,
          lastActiveAt: 2,
          error: null,
          sessionKind: 'normal',
        } as any,
      ]]),
    }));

    const runtimeEventSnapshot = {
      sessionId: 'session-1',
      streamId: 'runtime-a',
      cursor: 4,
      activeTurnId: 'turn-live',
      events: [
        {
          eventName: 'agentic://tool-event',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-live',
            roundId: 'round-0',
            toolEvent: {
              event_type: 'Started',
              tool_id: 'read-1',
              tool_name: 'Read',
              params: { file_path: 'README.md' },
            },
          },
        },
        {
          eventName: 'agentic://tool-event',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-live',
            roundId: 'round-0',
            toolEvent: {
              event_type: 'Completed',
              tool_id: 'read-1',
              tool_name: 'Read',
              result: 'ok',
            },
          },
        },
      ],
    };

    agenticListenerMock.dispatchExternal.mockImplementation((eventName: string, payload: any) => {
      if (eventName === 'agentic://tool-event') {
        processToolEvent(
          {
            flowChatStore: store,
            eventBatcher: { getBufferSize: () => 0, flushNow: () => {} },
            saveDebouncers: new Map(),
            lastSaveTimestamps: new Map(),
            lastSaveHashes: new Map(),
            turnSaveInFlight: new Map(),
            turnSavePending: new Set(),
          } as any,
          payload.sessionId,
          payload.turnId,
          payload.roundId,
          payload.toolEvent,
        );
      }
      return true;
    });

    vi.spyOn(store, 'refreshPeerSessionSnapshot').mockResolvedValue({
      applied: false,
      backendState: 'Processing { current_turn_id: "turn-live", phase: ToolExecution }',
      latestTurnId: 'turn-live',
      latestTurnStatus: 'processing',
      runtimeEventReplayRequired: false,
      runtimeEventSnapshot,
    });

    const cleanup = installPeerSessionRefresh({
      flowChatStore: store,
      eventBatcher: { flushNow: vi.fn(), clear: vi.fn() },
      contentBuffers: new Map(),
      activeTextItems: new Map(),
    } as any);

    await vi.advanceTimersByTimeAsync(1);

    expect(store.findToolItem('session-1', 'turn-live', 'read-1')?.status).toBe('completed');
    expect(runtimeProjectionCaughtUp(
      store.getState().sessions.get('session-1'),
      runtimeEventSnapshot,
    )).toBe(true);
    cleanup();
  });
});
