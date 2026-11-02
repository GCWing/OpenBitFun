/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_JOB_POLL_INTERVAL_MS,
  DISPATCH_IDLE_DISCOVERY_INTERVAL_MS,
  dispatchEventId,
  installDispatchJobObserver,
  projectDispatchAgentEvent,
  requestDispatchJobRefresh,
} from './DispatchJobObserver';
import { dispatchJobStore } from './dispatchJobStore';
import {
  DISPATCH_TRANSCRIPT_SCHEMA_VERSION,
  type DispatchEvent,
  type DispatchStatusResponse,
} from './types';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getTurnOutputDurationMs, getTurnTtftMs } from '@/flow_chat/utils/turnUsageMetrics';
import { stateMachineManager } from '@/flow_chat/state-machine';
import {
  SessionExecutionEvent,
  SessionExecutionState,
} from '@/flow_chat/state-machine/types';
import { scheduleModelResponseStatus } from '@/flow_chat/services/flow-chat-manager/RuntimeStatusModule';
import {
  getRuntimeStatus,
  showRuntimeStatus,
  useRuntimeStatusStore,
} from '@/flow_chat/store/runtimeStatusStore';

const mocks = vi.hoisted(() => ({
  peerModeActive: false,
  listJobs: vi.fn(),
  status: vi.fn(),
  loadTranscript: vi.fn(),
  saveTranscript: vi.fn(),
  dispatchExternal: vi.fn(),
  checkPathExists: vi.fn(),
  sendSystemNotification: vi.fn(),
}));

vi.mock('./dispatchApi', () => ({
  dispatchApi: {
    listJobs: mocks.listJobs,
    status: mocks.status,
    loadTranscript: mocks.loadTranscript,
    saveTranscript: mocks.saveTranscript,
  },
}));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => mocks.peerModeActive,
}));

vi.mock('@/flow_chat/services/AgenticEventListener', () => ({
  agenticEventListener: {
    dispatchExternal: mocks.dispatchExternal,
  },
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: {
    checkPathExists: mocks.checkPathExists,
    sendSystemNotification: mocks.sendSystemNotification,
  },
}));

function runningOutboundRecord() {
  return {
    jobId: 'job-1',
    sessionId: 'session-1',
    target: {
      kind: 'ssh' as const,
      connectionId: 'ssh-1',
      workspacePath: '/repo',
      displayName: 'build-host',
    },
    sourceWorkspacePath: '/source',
    workspacePath: '/repo',
    promptPreview: 'Dispatch test',
    title: 'Dispatch test',
    agentType: 'Standard',
    approvalPolicy: 'reject-and-report' as const,
    lastCursor: 0,
    lastState: 'running' as const,
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:01Z',
  };
}

function registerRunningJob(
  overrides: { cursor?: number; appliedEventIds?: string[] } = {},
): void {
  mocks.listJobs.mockResolvedValue([runningOutboundRecord()]);
  dispatchJobStore.getState().registerJob({
    jobId: 'job-1',
    sessionId: 'session-1',
    targetRequest: {
      kind: 'ssh',
      connectionId: 'ssh-1',
      workspacePath: '/repo',
    },
    target: {
      kind: 'ssh',
      connectionId: 'ssh-1',
      workspacePath: '/repo',
      displayName: 'build-host',
    },
    sourceWorkspacePath: '/source',
    title: 'Dispatch test',
    agentType: 'Standard',
    approvalPolicy: 'reject-and-report',
    cursor: 0,
    state: 'running',
    appliedEventIds: [],
    pendingPermissions: [],
    eventLogComplete: true,
    historyTruncated: false,
    omittedEventCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function createContext() {
  const sessions = new Map<string, any>([
    ['session-1', {
      sessionId: 'session-1',
      config: {
        dispatchTarget: {
          kind: 'ssh',
          connectionId: 'ssh-1',
          workspacePath: '/repo',
          displayName: 'build-host',
        },
        dispatchJobId: 'job-1',
        dispatchCursor: 0,
      },
    }],
  ]);
  return {
    currentWorkspacePath: '/source',
    flowChatStore: {
      getState: vi.fn(() => ({ sessions })),
      addExternalSession: vi.fn(),
      updateSessionDispatchTarget: vi.fn(),
      updateSessionTitle: vi.fn(),
      applyDispatchSnapshot: vi.fn((
        sessionId: string,
        snapshot: { cursor: number; state: string },
      ) => {
        const session = sessions.get(sessionId);
        session.config.dispatchCursor = snapshot.cursor;
        session.config.dispatchJobState = snapshot.state;
        return { applied: true, cursor: snapshot.cursor };
      }),
      markSessionUnreadCompletion: vi.fn(),
    },
    eventBatcher: {
      flushNow: vi.fn(),
    },
  } as any;
}

function createTerminalContext() {
  const processingManager = {
    clearSessionStatus: vi.fn(),
  };
  return {
    currentWorkspacePath: '/source',
    flowChatStore,
    processingManager,
    eventBatcher: {
      flushNow: vi.fn(),
      getBufferSize: vi.fn(() => 0),
    },
    pendingTurnCompletions: new Map(),
    pendingHistoryLoads: new Map(),
    contentBuffers: new Map([
      ['session-1', new Map([['round-1', 'partial']])],
    ]),
    activeTextItems: new Map([
      ['session-1', new Map([['round-1', 'text-1']])],
    ]),
    saveDebouncers: new Map(),
    lastSaveTimestamps: new Map(),
    lastSaveHashes: new Map(),
    turnSaveInFlight: new Map(),
    turnSavePending: new Set(),
    runtimeStatusTimers: new Map(),
    userCancelledSessionIds: new Set(),
    handledTerminalTurnEvents: new Set(),
  } as any;
}

function installProcessingProjection(): void {
  const session = {
    sessionId: 'session-1',
    title: 'Dispatch test',
    dialogTurns: [{
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'run task',
        timestamp: 1,
      },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        items: [
          {
            id: 'text-1',
            type: 'text',
            content: 'partial output',
            status: 'streaming',
            isStreaming: true,
            timestamp: 1,
          },
          {
            id: 'tool-1',
            type: 'tool',
            toolName: 'ExecCommand',
            toolCall: {
              id: 'tool-1',
              input: {},
            },
            status: 'running',
            requiresConfirmation: false,
            isParamsStreaming: true,
            startTime: 1,
            timestamp: 1,
          },
        ],
        isStreaming: true,
        isComplete: false,
        status: 'streaming',
        startTime: 1,
      }],
      status: 'processing',
      startTime: 1,
    }],
    status: 'idle',
    config: {
      agentType: 'Standard',
      dispatchTargetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/repo',
      },
      dispatchTarget: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/repo',
        displayName: 'build-host',
      },
      dispatchJobId: 'job-1',
      dispatchApprovalPolicy: 'reject-and-report',
      dispatchJobState: 'running',
      dispatchCursor: 0,
    },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    historyState: 'ready',
    mode: 'Standard',
    workspacePath: '/source',
    projectWorkspacePath: '/source',
    sessionKind: 'normal',
  };
  flowChatStore.setState(() => ({
    sessions: new Map([['session-1', session as any]]),
    activeSessionId: 'session-1',
  }));
}

function status(
  overrides: Partial<DispatchStatusResponse> = {},
): DispatchStatusResponse {
  return {
    state: 'running',
    cursor: 0,
    events: [],
    pendingPermissions: [],
    cursorReset: false,
    historyTruncated: false,
    eventLogComplete: true,
    omittedEventCount: 0,
    ...overrides,
  };
}

function cachedTranscript(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: DISPATCH_TRANSCRIPT_SCHEMA_VERSION,
    jobId: 'job-1',
    sessionId: 'session-1',
    cursor: 120,
    dialogTurns: [{
      id: 'turn-cached',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-cached',
        content: 'run task',
        timestamp: 1,
      },
      modelRounds: [],
      status: 'completed',
      startTime: 1,
    }],
    appliedEventIds: ['event-cached'],
    eventLogComplete: true,
    historyTruncated: false,
    omittedEventCount: 0,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('DispatchJobObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.peerModeActive = false;
    dispatchJobStore.getState().clear();
    useRuntimeStatusStore.getState().reset();
    flowChatStore.setState(() => ({
      sessions: new Map(),
      activeSessionId: null,
    }));
    useRuntimeStatusStore.getState().reset();
    stateMachineManager.clear();
    mocks.listJobs.mockReset().mockResolvedValue([]);
    mocks.status.mockReset();
    mocks.loadTranscript.mockReset().mockResolvedValue(null);
    mocks.saveTranscript.mockReset().mockResolvedValue(true);
    mocks.dispatchExternal.mockReset().mockReturnValue(true);
    mocks.checkPathExists.mockReset().mockResolvedValue(true);
    mocks.sendSystemNotification.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    stateMachineManager.clear();
    flowChatStore.setState(() => ({
      sessions: new Map(),
      activeSessionId: null,
    }));
    vi.useRealTimers();
  });

  describe('poll scheduling', () => {
    let cleanup: (() => void) | undefined;

    afterEach(() => {
      cleanup?.();
      cleanup = undefined;
    });

    it.each(['visible', 'hidden'])('discovers idle jobs at a bounded low rate while %s', async visibility => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
      cleanup = installDispatchJobObserver(createContext());

      await vi.advanceTimersByTimeAsync(60_000);

      // One initial discovery and two 30-second checks, previously 34 reads.
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
      expect(mocks.status).not.toHaveBeenCalled();
      cleanup();
      registerRunningJob();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
    });

    it.each(['queued', 'running', 'submission_unknown'] as const)('keeps the fast cadence for %s jobs', async state => {
      registerRunningJob();
      dispatchJobStore.getState().registerJob({ ...dispatchJobStore.getState().jobs['job-1'], state });
      mocks.listJobs.mockResolvedValue([{ ...runningOutboundRecord(), lastState: state }]);
      mocks.status.mockResolvedValue(status({ state }));
      cleanup = installDispatchJobObserver(createContext());

      await vi.advanceTimersByTimeAsync(3 * DISPATCH_JOB_POLL_INTERVAL_MS);

      expect(mocks.listJobs).toHaveBeenCalledTimes(4);
      expect(mocks.status).toHaveBeenCalledTimes(4);
    });

    it.each(['visible', 'hidden'])('finds another instance\'s durable job without a renderer event while %s', async visibility => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);

      // Only the host response changes: no store mutation, storage event or
      // explicit refresh from the submitting instance reaches this renderer.
      mocks.listJobs.mockResolvedValue([{ ...runningOutboundRecord(), lastCursor: 99 }]);
      mocks.status.mockResolvedValue(status());
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS - 1);
      expect(mocks.listJobs).toHaveBeenCalledTimes(1);
      expect(mocks.status).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.status).toHaveBeenCalledWith('job-1', 0);
      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(mocks.status).toHaveBeenCalledTimes(2);
    });

    it('wakes immediately when this renderer registers a job during idle discovery', async () => {
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      registerRunningJob();
      mocks.status.mockResolvedValue(status());

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.status).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(mocks.status).toHaveBeenCalledTimes(2);
    });

    it('waits for terminal event draining before reducing the polling rate', async () => {
      registerRunningJob();
      mocks.status.mockResolvedValueOnce(status({
        state: 'succeeded', cursor: 12,
        events: [{ type: 'jobState', state: 'succeeded', timestamp: '2026-07-28T00:00:00Z' }],
      })).mockResolvedValue(status({ state: 'succeeded', cursor: 12 }));
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchJobStore.getState().jobs['job-1'].terminalDrained).toBe(false);

      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(mocks.status).toHaveBeenCalledTimes(2);
      expect(dispatchJobStore.getState().jobs['job-1'].terminalDrained).toBe(true);
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS - 1);
      expect(mocks.listJobs).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
      expect(mocks.status).toHaveBeenCalledTimes(2);

      // A local follow-up must wake a terminal job without waiting 30 seconds.
      dispatchJobStore.getState().markFollowUpAccepted('job-1', 'queued');
      mocks.listJobs.mockResolvedValue([{ ...runningOutboundRecord(), lastState: 'queued' }]);
      mocks.status.mockResolvedValue(status({ state: 'running', cursor: 12 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.status).toHaveBeenCalledTimes(3);
    });

    it('preserves background progress, approval delivery and completion notifications', async () => {
      registerRunningJob();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      const context = createContext();
      const permission = { requestId: 'approval-1', type: 'tool' };
      context.flowChatStore.getState().sessions.get('session-1').dialogTurns = [];
      mocks.status.mockResolvedValue(status());
      cleanup = installDispatchJobObserver(context);
      await vi.advanceTimersByTimeAsync(0);
      mocks.status.mockResolvedValueOnce(status({
        cursor: 10,
        events: [{
          type: 'agentEvent', timestamp: '2026-07-28T00:00:00Z',
          event: { id: 'progress-1', frontendEventName: 'agentic://text-chunk',
            frontendPayload: { sessionId: 'session-1', turnId: 'turn-1', roundId: 'round-1', text: 'working' } },
        }],
        pendingPermissions: [permission],
      })).mockResolvedValue(status({ cursor: 10, pendingPermissions: [permission] }));
      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(mocks.dispatchExternal).toHaveBeenCalledWith('agentic://text-chunk', expect.objectContaining({ text: 'working' }));
      expect(dispatchJobStore.getState().jobs['job-1'].pendingPermissions).toEqual([permission]);
      expect(mocks.sendSystemNotification).toHaveBeenCalledTimes(1);

      // Approval acknowledgement requests a refresh immediately, not on the timer.
      mocks.status.mockResolvedValue(status({ cursor: 10 }));
      requestDispatchJobRefresh('job-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchJobStore.getState().jobs['job-1'].pendingPermissions).toEqual([]);
      mocks.status.mockResolvedValue(status({ state: 'succeeded', cursor: 10 }));
      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(context.flowChatStore.markSessionUnreadCompletion).toHaveBeenCalledWith('session-1', 'completed');
      expect(mocks.sendSystemNotification).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.sendSystemNotification).toHaveBeenCalledTimes(2);
    });

    it('retains full refresh requests across a slow read without overlapping polls', async () => {
      const discovery = createDeferred<ReturnType<typeof runningOutboundRecord>[]>();
      mocks.listJobs.mockReturnValueOnce(discovery.promise);
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      requestDispatchJobRefresh('job-1');
      requestDispatchJobRefresh();
      await vi.advanceTimersByTimeAsync(2 * DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(1);
      discovery.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.listJobs).toHaveBeenCalledTimes(2);
    });

    it('coalesces refreshes for different jobs during a slow target read without losing either', async () => {
      registerRunningJob();
      dispatchJobStore.getState().registerJob({
        ...dispatchJobStore.getState().jobs['job-1'], jobId: 'job-2', sessionId: 'session-2',
      });
      mocks.listJobs.mockResolvedValue([
        runningOutboundRecord(),
        { ...runningOutboundRecord(), jobId: 'job-2', sessionId: 'session-2' },
      ]);
      const context = createContext();
      const sessions = context.flowChatStore.getState().sessions;
      sessions.set('session-2', {
        ...sessions.get('session-1'), sessionId: 'session-2',
        config: { ...sessions.get('session-1').config, dispatchJobId: 'job-2' },
      });
      mocks.status.mockResolvedValue(status());
      cleanup = installDispatchJobObserver(context);
      await vi.advanceTimersByTimeAsync(0);
      mocks.status.mockClear();
      mocks.listJobs.mockClear();

      const targetRead = createDeferred<DispatchStatusResponse>();
      mocks.status.mockReturnValueOnce(targetRead.promise);
      requestDispatchJobRefresh('job-1');
      await vi.advanceTimersByTimeAsync(0);
      requestDispatchJobRefresh('job-1');
      requestDispatchJobRefresh('job-2');
      await vi.advanceTimersByTimeAsync(2 * DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(1);
      expect(mocks.status).toHaveBeenCalledTimes(1);

      targetRead.resolve(status());
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.listJobs).toHaveBeenCalledTimes(2);
      expect(mocks.status.mock.calls).toEqual([
        ['job-1', 0], ['job-1', 0], ['job-2', 0],
      ]);
    });

    it('replays a job submitted and completed by another instance between idle discoveries', async () => {
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      mocks.listJobs.mockResolvedValue([{
        ...runningOutboundRecord(), lastState: 'succeeded', lastCursor: 99,
      }]);
      mocks.status.mockResolvedValueOnce(status({
        state: 'succeeded', cursor: 99,
        events: [{ type: 'jobState', state: 'succeeded', timestamp: '2026-07-28T00:00:00Z' }],
      })).mockResolvedValue(status({ state: 'succeeded', cursor: 99 }));

      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.status).toHaveBeenCalledWith('job-1', 0);
      await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
      expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
        cursor: 99, state: 'succeeded', terminalDrained: true,
      });
    });

    it('does not revive a disposed observer when its discovery or queued refresh finishes', async () => {
      const discovery = createDeferred<ReturnType<typeof runningOutboundRecord>[]>();
      mocks.listJobs.mockReturnValueOnce(discovery.promise);
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      requestDispatchJobRefresh();
      cleanup();
      discovery.resolve([runningOutboundRecord()]);

      await vi.advanceTimersByTimeAsync(2 * DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(1);
      expect(mocks.status).not.toHaveBeenCalled();
      expect(dispatchJobStore.getState().jobs).toEqual({});
    });

    it('refreshes on visibility recovery and retries failed idle discovery', async () => {
      mocks.listJobs.mockRejectedValueOnce(new Error('temporary index failure'));
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(2);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
    });

    it('keeps controller polling suppressed in peer mode and replaces observers cleanly', async () => {
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(0);
      cleanup = installDispatchJobObserver(createContext());
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
      mocks.peerModeActive = true;
      requestDispatchJobRefresh();
      await vi.advanceTimersByTimeAsync(2 * DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(3);
      mocks.peerModeActive = false;
      await vi.advanceTimersByTimeAsync(DISPATCH_IDLE_DISCOVERY_INTERVAL_MS);
      expect(mocks.listJobs).toHaveBeenCalledTimes(4);
    });
  });

  it.each(['ssh', 'device'] as const)('persists %s generated titles and restores them after projection recreation', async (kind) => {
    registerRunningJob();
    if (kind === 'device') {
      const target = { kind: 'device' as const, deviceId: 'device-1', workspacePath: '/repo', displayName: 'peer' };
      dispatchJobStore.getState().registerJob({ ...dispatchJobStore.getState().jobs['job-1'], target, targetRequest: target });
      mocks.listJobs.mockResolvedValue([{ ...runningOutboundRecord(), target }]);
    }
    installProcessingProjection();
    const projection = flowChatStore.getState().sessions.get('session-1')!;
    projection.config.dispatchTarget = dispatchJobStore.getState().jobs['job-1'].target;
    mocks.status.mockResolvedValue(status({ cursor: 50, events: [{
      type: 'agentEvent', timestamp: '2026-07-28T00:00:02Z',
      event: { id: 'title-1', event: { type: 'SessionTitleGenerated', session_id: 'session-1', title: 'Investigate build failure' } },
    }] }));
    const cleanup = installDispatchJobObserver(createTerminalContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(flowChatStore.getState().sessions.get('session-1')?.title).toBe('Investigate build failure');
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({ title: 'Investigate build failure', titleSource: 'generated' });
    cleanup();

    // A recreated renderer resumes from its paired transcript cursor, which
    // may already be past the title event, while the index still has the default.
    const storage = dispatchJobStore.persist.getOptions().storage!;
    const persisted = (await storage.getItem('openbitfun-dispatch-jobs-v1'))!;
    dispatchJobStore.setState({ jobs: {} });
    await storage.setItem('openbitfun-dispatch-jobs-v1', persisted);
    await dispatchJobStore.persist.rehydrate();
    flowChatStore.setState(() => ({ sessions: new Map(), activeSessionId: null }));
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({ cursor: 50 }));
    mocks.status.mockResolvedValue(status({ cursor: 50, events: [] }));
    const restored = installDispatchJobObserver(createTerminalContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(flowChatStore.getState().sessions.get('session-1')?.title).toBe('Investigate build failure');
    restored();
  });

  it('keeps a manual name when a legacy target title is replayed', async () => {
    registerRunningJob();
    dispatchJobStore.getState().updateTitle('job-1', 'My investigation');
    installProcessingProjection();
    mocks.status.mockResolvedValue(status({ cursor: 50, events: [{
      type: 'agentEvent', timestamp: '2026-07-28T00:00:02Z',
      event: { frontendEventName: 'session_title_generated', frontendPayload: { sessionId: 'session-1', title: 'Old generated name' } },
    }] }));
    const cleanup = installDispatchJobObserver(createTerminalContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(flowChatStore.getState().sessions.get('session-1')?.title).toBe('My investigation');
    expect(dispatchJobStore.getState().jobs['job-1'].title).toBe('My investigation');
    cleanup();
  });

  it('replays a pre-title transcript cache so the generated name is recovered after upgrade', async () => {
    registerRunningJob({ cursor: 50, appliedEventIds: ['title-1'] });
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({ schemaVersion: 4, cursor: 50 }));
    mocks.status.mockResolvedValue(status({ cursor: 50, events: [{
      type: 'agentEvent', timestamp: '2026-07-28T00:00:02Z',
      event: { id: 'title-1', event: { type: 'SessionTitleGenerated', session_id: 'session-1', title: 'Recovered title' } },
    }] }));
    const cleanup = installDispatchJobObserver(createTerminalContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).toHaveBeenCalledWith('job-1', 0);
    expect(flowChatStore.getState().sessions.get('session-1')?.title).toBe('Recovered title');
    cleanup();
  });

  it('restores title metadata from the transcript when the renderer cache is missing', async () => {
    mocks.listJobs.mockResolvedValue([runningOutboundRecord()]);
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({ title: 'Cached investigation', titleSource: 'generated' }));
    mocks.status.mockResolvedValue(status({ cursor: 50, events: [] }));
    const cleanup = installDispatchJobObserver(createTerminalContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(flowChatStore.getState().sessions.get('session-1')?.title).toBe('Cached investigation');
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({ title: 'Cached investigation', titleSource: 'generated' });
    cleanup();
  });

  it('projects raw target events into the existing frontend event contract', () => {
    const projected = projectDispatchAgentEvent({
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-1',
        event: {
          type: 'TextChunk',
          session_id: 'session-1',
          turn_id: 'turn-1',
          round_id: 'round-1',
          text: 'hello',
        },
      },
    });

    expect(projected).toEqual({
      eventName: 'agentic://text-chunk',
      envelopeId: 'event-1',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        roundId: 'round-1',
        text: 'hello',
      },
    });
  });

  it.each([undefined, 0, 1_500])('preserves optional request TTFT from target replay (%s)', ttftMs => {
    const timing = ttftMs === undefined ? {} : { ttft_ms: ttftMs };
    const projected = projectDispatchAgentEvent({
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-completed',
        event: {
          type: 'ModelRoundCompleted',
          session_id: 'session-1',
          turn_id: 'turn-1',
          round_id: 'round-1',
          first_visible_output_ms: 1_000,
          stream_duration_ms: 5_000,
          ...timing,
        },
      },
    });
    expect(projected).toMatchObject({
      eventName: 'agentic://model-round-completed',
      payload: { firstVisibleOutputMs: 1_000, streamDurationMs: 5_000 },
    });
    if (ttftMs === undefined) {
      expect(projected?.payload).not.toHaveProperty('ttftMs');
    } else {
      expect(projected?.payload).toHaveProperty('ttftMs', ttftMs);
    }
  });

  it('canonicalizes legacy model migration events from older targets', () => {
    expect(projectDispatchAgentEvent({
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-model-fallback',
        event: {
          type: 'SessionModelAutoMigrated',
          session_id: 'session-1',
          previous_model_id: 'removed-model',
          new_model_id: 'auto',
          reason: 'model_deleted',
        },
      },
    })).toEqual({
      eventName: 'agentic://session-model-fallback-applied',
      envelopeId: 'event-model-fallback',
      payload: {
        sessionId: 'session-1',
        previousModelId: 'removed-model',
        newModelId: 'primary',
        reason: 'model_deleted',
      },
    });
  });

  it('projects subagent links so child sessions render under the projection', () => {
    // Child ownership is driver-resolved through the parent chain, so the
    // link event flows into the normal pipeline like any other event.
    expect(projectDispatchAgentEvent({
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-child',
        frontendEventName: 'agentic://subagent-session-linked',
        frontendPayload: {
          parentSessionId: 'session-1',
          childSessionId: 'child-1',
        },
        event: {
          type: 'SubagentSessionLinked',
          parent_session_id: 'session-1',
          child_session_id: 'child-1',
        },
      },
    })).toMatchObject({
      eventName: 'agentic://subagent-session-linked',
      envelopeId: 'event-child',
    });
  });

  it('keeps the cursor until an event applies, then deduplicates it on replay', async () => {
    registerRunningJob();
    const event: DispatchEvent = {
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-1',
        frontendEventName: 'agentic://text-chunk',
        frontendPayload: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          roundId: 'round-1',
          text: 'hello',
        },
      },
    };
    mocks.status.mockResolvedValue(status({
      cursor: 25,
      events: [event],
    }));
    mocks.dispatchExternal
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].cursor).toBe(0);
    expect(mocks.dispatchExternal).toHaveBeenCalledTimes(1);

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].cursor).toBe(25);
    expect(dispatchJobStore.getState().hasAppliedEvent('job-1', dispatchEventId(event))).toBe(true);
    expect(mocks.dispatchExternal).toHaveBeenCalledTimes(2);

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispatchExternal).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('renders SSH CLI installation audits inside the dispatch transcript', async () => {
    registerRunningJob();
    const started: DispatchEvent = {
      type: 'audit',
      timestamp: '2026-07-28T00:00:00Z',
      action: 'cli-install',
      details: {
        stage: 'cli-install-started',
        release: { version: '1.2.3', target: 'x86_64-unknown-linux-gnu' },
      },
    };
    const succeeded: DispatchEvent = {
      type: 'audit',
      timestamp: '2026-07-28T00:00:01Z',
      action: 'cli-install',
      details: {
        stage: 'cli-install-succeeded',
        release: { version: '1.2.3', cliPath: '/usr/local/bin/openbitfun' },
      },
    };
    mocks.status.mockResolvedValue(status({
      cursor: 2,
      events: [
        started,
        {
          type: 'audit',
          timestamp: '2026-07-28T00:00:00.500Z',
          action: 'unrelated-audit',
          details: {},
        },
        succeeded,
      ],
    }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    const turn = flowChatStore
      .getState()
      .sessions
      .get('session-1')
      ?.dialogTurns[0];
    expect(turn).toMatchObject({
      id: 'dispatch_pending_job-1',
      userMessage: {
        content: '',
        metadata: { __openbitfunOptimisticDispatchJobId: 'job-1' },
      },
    });
    expect(turn?.modelRounds).toHaveLength(1);
    expect(turn?.modelRounds[0].items).toEqual([
      expect.objectContaining({
        id: `dispatch-audit:${dispatchEventId(started)}`,
        type: 'text',
        content: expect.stringContaining('1.2.3'),
      }),
      expect.objectContaining({
        id: `dispatch-audit:${dispatchEventId(succeeded)}`,
        type: 'text',
        content: expect.stringContaining('1.2.3'),
      }),
    ]);
    // Replayed setup rows precede model output without contributing tokens or timing.
    const rounds = [...turn!.modelRounds, {
      id: 'model-round-0', index: 0, items: [], isStreaming: false, isComplete: true,
      status: 'completed' as const, startTime: 0,
      ttftMs: 1_500, firstVisibleOutputMs: 1_000, streamDurationMs: 5_000,
    }];
    expect(getTurnTtftMs(rounds)).toBe(1_500);
    expect(getTurnOutputDurationMs(rounds)).toBe(4_000);
    expect(mocks.dispatchExternal).not.toHaveBeenCalled();
    cleanup();
  });

  it('renders an automatic model configuration push inside the transcript', async () => {
    // Submission copies this device's API keys to a target that cannot serve
    // the chosen model. That has to stay as visible as the manual button it
    // replaced, including after a replay from byte zero.
    registerRunningJob();
    const started: DispatchEvent = {
      type: 'audit',
      timestamp: '2026-08-09T00:00:00Z',
      action: 'model-sync',
      details: { stage: 'model-sync-started', sync: { requestedModel: 'model-a' } },
    };
    const succeeded: DispatchEvent = {
      type: 'audit',
      timestamp: '2026-08-09T00:00:02Z',
      action: 'model-sync',
      details: { stage: 'model-sync-succeeded', sync: { modelCount: 4 } },
    };
    mocks.status.mockResolvedValue(status({
      cursor: 2,
      events: [started, succeeded],
    }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    const turn = flowChatStore
      .getState()
      .sessions
      .get('session-1')
      ?.dialogTurns[0];
    const items = turn?.modelRounds[0].items ?? [];
    expect(items).toEqual([
      expect.objectContaining({
        id: `dispatch-audit:${dispatchEventId(started)}`,
        type: 'text',
        content: expect.any(String),
      }),
      expect.objectContaining({
        id: `dispatch-audit:${dispatchEventId(succeeded)}`,
        type: 'text',
        content: expect.any(String),
      }),
    ]);
    // Each stage says something of its own; a shared placeholder would hide
    // whether the push actually landed.
    const labels = items.map(item => 'content' in item ? item.content : '');
    expect(labels[0]).not.toBe('');
    expect(labels[0]).not.toBe(labels[1]);
    // The synced payload carries API keys and must never reach the transcript.
    expect(labels.join(' ')).not.toContain('model-a');
    cleanup();
  });

  it('marks a missing baseline worktree during observer reconciliation', async () => {
    registerRunningJob();
    dispatchJobStore.getState().registerJob({
      ...dispatchJobStore.getState().jobs['job-1'],
      baselineWorktreePath: '/source/.openbitfun/worktrees/missing-baseline',
    });
    mocks.checkPathExists.mockResolvedValue(false);
    mocks.status.mockResolvedValue(status());
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.checkPathExists).toHaveBeenCalledWith(
      '/source/.openbitfun/worktrees/missing-baseline',
    );
    expect(dispatchJobStore.getState().jobs['job-1'].baselineWorktreeMissing)
      .toBe(true);
    cleanup();
  });

  it('drains every terminal page before it stops polling', async () => {
    registerRunningJob();
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [{
          type: 'jobState',
          timestamp: '2026-07-28T00:00:00Z',
          state: 'succeeded',
        }],
      }))
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [],
      }));
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      state: 'succeeded',
      cursor: 12,
      terminalDrained: false,
    });

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].terminalDrained).toBe(true);

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('resumes draining after the target accepts a follow-up on a terminal job', async () => {
    registerRunningJob();
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [{
          type: 'jobState',
          timestamp: '2026-07-28T00:00:00Z',
          state: 'succeeded',
        }],
      }))
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [],
      }));
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].terminalDrained).toBe(true);
    expect(mocks.status).toHaveBeenCalledTimes(2);

    // Regression: the drained terminal job accepts a follow-up turn. The
    // target re-queues, runs it, and appends its events, but a renderer that
    // keeps the job pinned terminal-and-drained never pulls another page and
    // the follow-up's response silently never renders.
    dispatchJobStore.getState().markFollowUpAccepted('job-1', 'queued');
    mocks.listJobs.mockResolvedValue([{
      ...runningOutboundRecord(),
      lastState: 'queued' as const,
    }]);
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'running',
        cursor: 30,
        events: [{
          type: 'agentEvent',
          timestamp: '2026-07-28T00:01:00Z',
          event: {
            id: 'event-follow-up',
            frontendEventName: 'agentic://text-chunk',
            frontendPayload: {
              sessionId: 'session-1',
              turnId: 'turn-2',
              roundId: 'round-2',
              text: 'follow-up answer',
            },
          },
        }],
      }))
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 34,
        events: [{
          type: 'jobState',
          timestamp: '2026-07-28T00:01:05Z',
          state: 'succeeded',
        }],
      }))
      .mockResolvedValue(status({
        state: 'succeeded',
        cursor: 34,
        events: [],
      }));

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      state: 'running',
      cursor: 30,
      terminalDrained: false,
    });
    expect(mocks.dispatchExternal).toHaveBeenCalledWith(
      'agentic://text-chunk',
      expect.objectContaining({ text: 'follow-up answer' }),
    );

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      state: 'succeeded',
      cursor: 34,
    });

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].terminalDrained).toBe(true);
    const settledCalls = mocks.status.mock.calls.length;

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).toHaveBeenCalledTimes(settledCalls);
    cleanup();
  });

  it('does not query a target job before submit acknowledgement', async () => {
    registerRunningJob();
    dispatchJobStore.getState().updateProgress('job-1', { state: 'submitting' });
    // updateProgress cannot regress running to submitting, so register the true pre-ack shape.
    dispatchJobStore.getState().registerJob({
      ...dispatchJobStore.getState().jobs['job-1'],
      state: 'submitting',
    });
    mocks.listJobs.mockResolvedValue([]);
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not recreate a dismissed projection from an in-flight status response', async () => {
    registerRunningJob();
    const deferred = createDeferred<DispatchStatusResponse>();
    mocks.status.mockReturnValue(deferred.promise);
    const context = createContext();
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).toHaveBeenCalledWith('job-1', 0);

    dispatchJobStore.getState().dismissJob('job-1');
    deferred.resolve(status({
      cursor: 1,
      events: [{
        type: 'agentEvent',
        timestamp: '2026-07-28T00:00:01Z',
        event: {
          id: 'event-after-delete',
          frontendEventName: 'agentic://session-created',
          frontendPayload: {
            sessionId: 'session-1',
            sessionName: 'Dispatch test',
          },
        },
      }],
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.dispatchExternal).not.toHaveBeenCalled();
    expect(context.flowChatStore.applyDispatchSnapshot).not.toHaveBeenCalled();
    expect(dispatchJobStore.getState().jobs['job-1']).toBeUndefined();
    expect(dispatchJobStore.getState().dismissedJobIds).toContain('job-1');
    cleanup();
  });

  it('never restores an unowned legacy job into the current workspace', async () => {
    const record = {
      jobId: 'job-restored',
      sessionId: 'session-restored',
      target: {
        kind: 'ssh' as const,
        connectionId: 'ssh-1',
        workspacePath: '/target/repo',
        displayName: 'build-host',
      },
      workspacePath: '/target/repo',
      promptPreview: 'Dispatch test',
      title: 'Dispatch test',
      agentType: 'Standard',
      approvalPolicy: 'reject-and-report' as const,
      lastCursor: 0,
      lastState: 'running' as const,
      createdAt: '2026-07-28T00:00:00Z',
      updatedAt: '2026-07-28T00:00:01Z',
    };
    mocks.listJobs.mockResolvedValue([record]);
    mocks.status.mockResolvedValue(status());
    const sessions = new Map<string, any>();
    const context = createContext();
    context.currentWorkspacePath = null;
    context.flowChatStore.getState = vi.fn(() => ({ sessions }));
    context.flowChatStore.applyDispatchSnapshot = vi.fn(() => ({
      applied: true,
      cursor: 0,
    }));
    context.flowChatStore.addExternalSession = vi.fn((
      sessionId: string,
      _title: string,
      _mode: string,
      workspacePath: string,
      meta: { projectWorkspacePath: string },
    ) => {
      sessions.set(sessionId, {
        sessionId,
        workspacePath,
        projectWorkspacePath: meta.projectWorkspacePath,
        config: {},
      });
    });

    const cleanup = installDispatchJobObserver(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.flowChatStore.addExternalSession).not.toHaveBeenCalled();

    context.currentWorkspacePath = '/projects/OpenBitFun';
    await vi.advanceTimersByTimeAsync(DISPATCH_JOB_POLL_INTERVAL_MS);
    expect(context.flowChatStore.addExternalSession).not.toHaveBeenCalled();
    expect(dispatchJobStore.getState().jobs['job-restored']).toBeUndefined();
    expect(mocks.status).not.toHaveBeenCalled();
    cleanup();
  });

  it('restores a projection only from its durable source workspace', async () => {
    mocks.listJobs.mockResolvedValue([{
      jobId: 'job-restored',
      sessionId: 'session-restored',
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/target/repo',
        displayName: 'build-host',
      },
      sourceWorkspacePath: '/projects/OpenBitFun',
      sourceWorkspaceId: 'workspace-1',
      workspacePath: '/target/repo',
      promptPreview: 'Dispatch test',
      title: 'Dispatch test',
      agentType: 'Standard',
      approvalPolicy: 'reject-and-report',
      lastCursor: 0,
      lastState: 'running',
      createdAt: '2026-07-28T00:00:00Z',
      updatedAt: '2026-07-28T00:00:01Z',
    }]);
    mocks.status.mockResolvedValue(status());
    const sessions = new Map<string, any>();
    const context = createContext();
    context.currentWorkspacePath = null;
    context.flowChatStore.getState = vi.fn(() => ({ sessions }));
    context.flowChatStore.applyDispatchSnapshot = vi.fn(() => ({
      applied: true,
      cursor: 0,
    }));
    context.flowChatStore.addExternalSession = vi.fn((
      sessionId: string,
      _title: string,
      _mode: string,
      workspacePath: string,
      meta: { projectWorkspacePath: string; workspaceId?: string },
    ) => {
      sessions.set(sessionId, {
        sessionId,
        workspacePath,
        projectWorkspacePath: meta.projectWorkspacePath,
        workspaceId: meta.workspaceId,
        config: {},
      });
    });

    const cleanup = installDispatchJobObserver(context);
    await vi.advanceTimersByTimeAsync(0);

    expect(context.flowChatStore.addExternalSession).toHaveBeenCalledWith(
      'session-restored',
      'Dispatch test',
      'Standard',
      '/projects/OpenBitFun',
      expect.objectContaining({
        projectWorkspacePath: '/projects/OpenBitFun',
        workspaceId: 'workspace-1',
      }),
    );
    expect(mocks.status).toHaveBeenCalledWith('job-restored', 0);
    cleanup();
  });

  it('continues polling while hidden so background notifications can observe changes', async () => {
    registerRunningJob();
    mocks.status.mockResolvedValue(status({ state: 'running' }));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.status).toHaveBeenCalledTimes(1);

    cleanup();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('does not present target cancellation as a successful completion', async () => {
    registerRunningJob();
    const context = createContext();
    context.userCancelledSessionIds = new Set(['session-1']);
    mocks.status.mockResolvedValue(status({
      state: 'cancelled',
      cursor: 1,
      events: [],
    }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);

    expect(context.flowChatStore.markSessionUnreadCompletion).not.toHaveBeenCalled();
    cleanup();
  });

  it('reports transient target unreachability without terminalizing the job and clears it after recovery', async () => {
    registerRunningJob();
    mocks.status
      .mockRejectedValueOnce(new Error('SSH target is offline'))
      .mockResolvedValueOnce(status({ state: 'running' }));
    const cleanup = installDispatchJobObserver(createContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].state).toBe('running');
    expect(dispatchJobStore.getState().transportByJobId['job-1']).toEqual({
      reachability: 'unreachable',
      lastTransportError: 'SSH target is offline',
    });

    requestDispatchJobRefresh('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchJobStore.getState().jobs['job-1'].state).toBe('running');
    expect(dispatchJobStore.getState().transportByJobId['job-1']).toEqual({
      reachability: 'reachable',
      lastTransportError: undefined,
    });
    cleanup();
  });

  it('drains the terminal log within one poll and settles cancellation without a dialog-turn-cancelled event', async () => {
    registerRunningJob();
    installProcessingProjection();
    const context = createTerminalContext();
    await stateMachineManager.transition(
      'session-1',
      SessionExecutionEvent.START,
      { taskId: 'session-1', dialogTurnId: 'turn-1' },
    );
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'cancelled',
        cursor: 12,
        events: [{
          type: 'jobState',
          timestamp: '2026-07-29T00:00:00Z',
          state: 'cancelled',
        }],
      }))
      .mockResolvedValueOnce(status({
        state: 'cancelled',
        cursor: 12,
        events: [],
      }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    // The terminal page carrying events does not settle anything by itself;
    // the empty page at the same cursor does. Both are pulled in this one
    // cycle, so a long log no longer costs one poll interval per page.
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.status).toHaveBeenNthCalledWith(1, 'job-1', 0);
    expect(mocks.status).toHaveBeenNthCalledWith(2, 'job-1', 12);
    const turn = flowChatStore.getState().sessions.get('session-1')?.dialogTurns[0];
    expect(turn).toMatchObject({
      status: 'cancelled',
      modelRounds: [{
        status: 'cancelled',
        isStreaming: false,
        isComplete: true,
        items: [
          { id: 'text-1', status: 'cancelled', isStreaming: false },
          { id: 'tool-1', status: 'cancelled', isParamsStreaming: false },
        ],
      }],
    });
    expect(stateMachineManager.getCurrentState('session-1'))
      .toBe(SessionExecutionState.IDLE);
    expect(context.processingManager.clearSessionStatus)
      .toHaveBeenCalledWith('session-1');
    expect(mocks.dispatchExternal).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not count controller downtime in a replayed terminal turn duration', async () => {
    const startedAt = Date.parse('2026-07-28T00:00:00Z');
    const completedAt = Date.parse('2026-07-28T00:00:27Z');
    const replayedAt = Date.parse('2026-07-28T00:16:44Z');
    vi.setSystemTime(replayedAt);
    registerRunningJob();
    installProcessingProjection();
    const session = flowChatStore.getState().sessions.get('session-1')!;
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...session,
        dialogTurns: [{
          ...session.dialogTurns[0],
          startTime: replayedAt,
          userMessage: {
            ...session.dialogTurns[0].userMessage,
            timestamp: replayedAt,
          },
        }],
      }),
    }));
    const startedEvent: DispatchEvent = {
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:00Z',
      event: {
        id: 'event-started',
        frontendEventName: 'agentic://dialog-turn-started',
        frontendPayload: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          userInput: 'run task',
        },
      },
    };
    const completedEvent: DispatchEvent = {
      type: 'agentEvent',
      timestamp: '2026-07-28T00:00:27Z',
      event: {
        id: 'event-completed',
        frontendEventName: 'agentic://dialog-turn-completed',
        frontendPayload: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          success: true,
        },
      },
    };
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [startedEvent, completedEvent],
      }))
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 12,
        events: [],
      }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    const settledTurn = flowChatStore
      .getState()
      .sessions
      .get('session-1')!
      .dialogTurns[0];
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(settledTurn.status).toBe('completed');
    expect(settledTurn.startTime).toBe(startedAt);
    expect(settledTurn.userMessage.timestamp).toBe(startedAt);
    expect(settledTurn.endTime).toBe(completedAt);
    expect(settledTurn.endTime! - settledTurn.startTime).toBe(27_000);
    expect(mocks.saveTranscript).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        schemaVersion: DISPATCH_TRANSCRIPT_SCHEMA_VERSION,
        dialogTurns: [expect.objectContaining({
          status: 'completed',
          startTime: startedAt,
          endTime: completedAt,
        })],
      }),
    );
    cleanup();
  });

  it('restores a terminal metadata placeholder before honoring terminalDrained', async () => {
    registerRunningJob({ cursor: 900, appliedEventIds: ['event-stale'] });
    const registered = dispatchJobStore.getState().jobs['job-1'];
    dispatchJobStore.getState().registerJob({
      ...registered,
      state: 'succeeded',
      terminalDrained: true,
    });
    mocks.listJobs.mockResolvedValue([{
      ...runningOutboundRecord(),
      lastCursor: 900,
      lastState: 'succeeded',
    }]);
    installProcessingProjection();
    const metadataSession = flowChatStore.getState().sessions.get('session-1')!;
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...metadataSession,
        dialogTurns: [],
        isHistorical: true,
        historyState: 'metadata-only',
        contextRestoreState: 'pending',
        config: {
          ...metadataSession.config,
          dispatchCursor: 900,
        },
      }),
    }));
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({
      dialogTurns: [{
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
      }],
    }));
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 140,
        events: [{
          type: 'audit',
          timestamp: '2026-07-29T00:00:00Z',
          action: 'unrelated-audit',
          details: {},
        }],
      }))
      .mockResolvedValueOnce(status({
        state: 'succeeded',
        cursor: 140,
      }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.status).toHaveBeenCalledWith('job-1', 120);
    const restoredSession = flowChatStore.getState().sessions.get('session-1');
    expect(restoredSession).toMatchObject({
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'ready',
      dialogTurns: [{
        id: 'turn-cached',
        modelRounds: [{
          items: [{ content: 'cached body' }],
        }],
      }],
      config: {
        dispatchCursor: 140,
      },
    });
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      cursor: 140,
      terminalDrained: true,
      appliedEventIds: expect.arrayContaining(['event-cached']),
    });
    expect(mocks.status).toHaveBeenNthCalledWith(2, 'job-1', 140);
    cleanup();
  });

  it('does not reset a legitimately empty live observer projection on each poll', async () => {
    registerRunningJob({ cursor: 25, appliedEventIds: ['event-setup'] });
    installProcessingProjection();
    const liveSession = flowChatStore.getState().sessions.get('session-1')!;
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...liveSession,
        dialogTurns: [],
        isHistorical: false,
        historyState: 'ready',
        contextRestoreState: 'ready',
        config: {
          ...liveSession.config,
          dispatchCursor: 25,
        },
      }),
    }));
    mocks.status.mockResolvedValue(status({ cursor: 25 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.loadTranscript).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith('job-1', 25);
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      cursor: 25,
      appliedEventIds: ['event-setup'],
    });
    cleanup();
  });

  it('resumes a restarted projection from the cached transcript instead of replaying', async () => {
    // The renderer's own cursor survived in localStorage but its transcript did
    // not. The cache is what makes resuming possible at all, so it also decides
    // where to resume — even though it trails the persisted cursor here.
    registerRunningJob({ cursor: 900, appliedEventIds: ['event-stale'] });
    mocks.loadTranscript.mockResolvedValue(cachedTranscript());
    mocks.status.mockResolvedValue(status({ state: 'running', cursor: 120 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.status).toHaveBeenNthCalledWith(1, 'job-1', 120);
    const session = flowChatStore.getState().sessions.get('session-1');
    expect(session?.dialogTurns.map(turn => turn.id)).toEqual(['turn-cached']);
    expect(session?.config.dispatchCursor).toBe(120);
    const job = dispatchJobStore.getState().jobs['job-1'];
    expect(job.cursor).toBe(120);
    // Replaced, not merged: an id remembered past the cached cursor would make
    // the observer skip an event whose projection is not in the restored turns.
    expect(job.appliedEventIds).toEqual(['event-cached']);
    cleanup();
  });

  it('replays from byte zero when no transcript is cached', async () => {
    registerRunningJob({ cursor: 900 });
    mocks.loadTranscript.mockResolvedValue(null);
    mocks.status.mockResolvedValue(status({ state: 'running', cursor: 0 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.status).toHaveBeenNthCalledWith(1, 'job-1', 0);
    expect(dispatchJobStore.getState().jobs['job-1'].cursor).toBe(0);
    expect(flowChatStore.getState().sessions.get('session-1')?.dialogTurns)
      .toEqual([]);
    cleanup();
  });

  it('replays from byte zero when the cached transcript predates the current projection rules', async () => {
    registerRunningJob({ cursor: 900 });
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({
      schemaVersion: DISPATCH_TRANSCRIPT_SCHEMA_VERSION - 1,
    }));
    mocks.status.mockResolvedValue(status({ state: 'running', cursor: 0 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.status).toHaveBeenNthCalledWith(1, 'job-1', 0);
    expect(flowChatStore.getState().sessions.get('session-1')?.dialogTurns)
      .toEqual([]);
    cleanup();
  });

  it('rewinds an existing metadata placeholder to byte zero and advances after an invalid cache', async () => {
    registerRunningJob({ cursor: 900, appliedEventIds: ['event-stale'] });
    installProcessingProjection();
    const metadataSession = flowChatStore.getState().sessions.get('session-1')!;
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...metadataSession,
        dialogTurns: [],
        isHistorical: true,
        historyState: 'metadata-only',
        contextRestoreState: 'pending',
        config: {
          ...metadataSession.config,
          dispatchCursor: 900,
        },
      }),
    }));
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({
      schemaVersion: DISPATCH_TRANSCRIPT_SCHEMA_VERSION - 1,
    }));
    mocks.status
      .mockResolvedValueOnce(status({
        state: 'running',
        cursor: 12,
        events: [{
          type: 'audit',
          timestamp: '2026-07-29T00:00:00Z',
          action: 'unrelated-audit',
          details: {},
        }],
      }))
      .mockResolvedValueOnce(status({ state: 'running', cursor: 12 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.status).toHaveBeenNthCalledWith(1, 'job-1', 0);
    expect(mocks.status).toHaveBeenNthCalledWith(2, 'job-1', 12);
    expect(flowChatStore.getState().sessions.get('session-1')?.config.dispatchCursor)
      .toBe(12);
    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      cursor: 12,
      appliedEventIds: expect.not.arrayContaining(['event-stale']),
    });
    cleanup();
  });

  it('restores truncation facts with the transcript so an incomplete history is not shown as whole', async () => {
    registerRunningJob();
    mocks.loadTranscript.mockResolvedValue(cachedTranscript({
      eventLogComplete: false,
      historyTruncated: true,
      omittedEventCount: 42,
    }));
    mocks.status.mockResolvedValue(status({
      state: 'running',
      cursor: 120,
      eventLogComplete: false,
      historyTruncated: true,
      omittedEventCount: 42,
    }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);

    expect(dispatchJobStore.getState().jobs['job-1']).toMatchObject({
      eventLogComplete: false,
      historyTruncated: true,
      omittedEventCount: 42,
    });
    cleanup();
  });

  it('caches the transcript together with the cursor that produced it', async () => {
    registerRunningJob();
    installProcessingProjection();
    mocks.status.mockResolvedValue(status({ state: 'running', cursor: 12 }));
    const cleanup = installDispatchJobObserver(createTerminalContext());

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.saveTranscript).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.saveTranscript).toHaveBeenCalledTimes(1);
    const [jobId, payload] = mocks.saveTranscript.mock.calls[0];
    expect(jobId).toBe('job-1');
    expect(payload).toMatchObject({
      schemaVersion: DISPATCH_TRANSCRIPT_SCHEMA_VERSION,
      jobId: 'job-1',
      sessionId: 'session-1',
      cursor: 12,
    });
    expect(payload.dialogTurns.map((turn: { id: string }) => turn.id))
      .toEqual(['turn-1']);
    cleanup();
  });

  it('cancels delayed runtime status rendering when a terminal snapshot drains', async () => {
    registerRunningJob();
    installProcessingProjection();
    const context = createTerminalContext();
    scheduleModelResponseStatus(
      context,
      'session-1',
      'turn-1',
      'round-1',
      { delayMs: 1000 },
    );
    showRuntimeStatus({
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
    });
    expect(context.runtimeStatusTimers.size).toBe(1);
    expect(getRuntimeStatus('session-1')).toBeDefined();
    mocks.status.mockResolvedValue(status({
      state: 'succeeded',
      cursor: 0,
      events: [],
    }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    expect(context.runtimeStatusTimers.size).toBe(0);
    expect(getRuntimeStatus('session-1')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1000);
    expect(getRuntimeStatus('session-1')).toBeUndefined();
    cleanup();
  });

  it('safely settles a queued job that reaches terminal state before any turn event', async () => {
    registerRunningJob();
    installProcessingProjection();
    const queuedSession = flowChatStore.getState().sessions.get('session-1')!;
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...queuedSession,
        dialogTurns: [],
      }),
    }));
    const context = createTerminalContext();
    mocks.status.mockResolvedValue(status({
      state: 'cancelled',
      cursor: 0,
      events: [],
    }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    const session = flowChatStore.getState().sessions.get('session-1');
    expect(session?.dialogTurns).toEqual([]);
    expect(session?.config.dispatchJobState).toBe('cancelled');
    expect(stateMachineManager.getCurrentState('session-1'))
      .toBe(SessionExecutionState.IDLE);
    cleanup();
  });

  it('does not duplicate convergence already owned by a terminal agent event', async () => {
    registerRunningJob();
    installProcessingProjection();
    const session = flowChatStore.getState().sessions.get('session-1')!;
    const terminalTurn = {
      ...session.dialogTurns[0],
      status: 'completed' as const,
      success: true,
      endTime: 5,
      modelRounds: [],
    };
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(state.sessions).set('session-1', {
        ...session,
        dialogTurns: [terminalTurn],
      }),
    }));
    const context = createTerminalContext();
    context.handledTerminalTurnEvents.add('session-1:turn-1');
    mocks.status.mockResolvedValue(status({
      state: 'succeeded',
      cursor: 0,
      events: [],
    }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    const appliedTurn = flowChatStore
      .getState()
      .sessions
      .get('session-1')!
      .dialogTurns[0];
    expect(appliedTurn).toBe(terminalTurn);
    expect(context.processingManager.clearSessionStatus).not.toHaveBeenCalled();
    expect(stateMachineManager.getCurrentState('session-1'))
      .toBe(SessionExecutionState.IDLE);
    cleanup();
  });

  it.each([
    {
      jobState: 'failed' as const,
      turnState: 'error',
      itemState: 'error',
      lastError: 'Remote execution failed',
    },
    {
      jobState: 'succeeded' as const,
      turnState: 'completed',
      itemState: 'completed',
      lastError: undefined,
    },
  ])('settles $jobState snapshots idempotently after terminal drain', async ({
    jobState,
    turnState,
    itemState,
    lastError,
  }) => {
    registerRunningJob();
    installProcessingProjection();
    const context = createTerminalContext();
    await stateMachineManager.transition(
      'session-1',
      SessionExecutionEvent.START,
      { taskId: 'session-1', dialogTurnId: 'turn-1' },
    );
    mocks.status.mockResolvedValue(status({
      state: jobState,
      cursor: 0,
      events: [],
      lastError,
    }));
    const cleanup = installDispatchJobObserver(context);

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const firstSession = flowChatStore.getState().sessions.get('session-1')!;
    const firstTurn = firstSession.dialogTurns[0];
    expect(firstTurn.status).toBe(turnState);
    expect(firstTurn.modelRounds[0].items[0].status).toBe(itemState);
    expect(stateMachineManager.getCurrentState('session-1'))
      .toBe(SessionExecutionState.IDLE);
    if (jobState === 'failed') {
      expect(firstSession.error).toBe(lastError);
      expect(firstTurn.error).toBe(lastError);
    }

    const repeated = flowChatStore.applyDispatchSnapshot('session-1', {
      jobId: 'job-1',
      state: jobState,
      cursor: 0,
      expectedCursor: 0,
      lastError,
      terminalDrained: true,
    });
    const repeatedTurn = flowChatStore
      .getState()
      .sessions
      .get('session-1')!
      .dialogTurns[0];
    expect(repeated).toEqual({ applied: true, cursor: 0 });
    expect(repeatedTurn).toBe(firstTurn);
    expect(repeatedTurn.endTime).toBe(firstTurn.endTime);
    expect(stateMachineManager.getCurrentState('session-1'))
      .toBe(SessionExecutionState.IDLE);
    cleanup();
  });
});
