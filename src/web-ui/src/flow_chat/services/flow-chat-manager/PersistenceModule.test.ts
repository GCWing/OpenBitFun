import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { DialogTurn, ModelRound } from '../../types/flow-chat';
import {
  convertDialogTurnToBackendFormat,
  debouncedSaveDialogTurn,
  immediateSaveDialogTurn,
  saveDialogTurnToDisk,
  updateSessionMetadata,
} from './PersistenceModule';

// Vitest hoists `vi.mock` factories above ordinary module-scope declarations,
// so a plain `const` referenced inside the factory is still in its temporal
// dead zone when the factory runs. `vi.hoisted` hoists the value itself to
// the same point, ahead of `vi.mock`, so the factory can see it.
const { mockSaveSessionTurn, mockSaveSessionMetadata, mockLoadSessionMetadata } = vi.hoisted(
  () => ({
    mockSaveSessionTurn: vi.fn(),
    mockSaveSessionMetadata: vi.fn(),
    mockLoadSessionMetadata: vi.fn(),
  })
);

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: {
    saveSessionTurn: mockSaveSessionTurn,
    saveSessionMetadata: mockSaveSessionMetadata,
    loadSessionMetadata: mockLoadSessionMetadata,
  },
}));

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';

function createDialogTurn(status: DialogTurn['status'] = 'processing'): DialogTurn {
  const round: ModelRound = {
    id: 'round-1',
    index: 0,
    items: [],
    isStreaming: status !== 'completed',
    isComplete: status === 'completed',
    status: status === 'completed' ? 'completed' : 'streaming',
    startTime: 1000,
  };

  return {
    id: TURN_ID,
    sessionId: SESSION_ID,
    userMessage: {
      id: 'user-1',
      content: 'hello',
      timestamp: 900,
    },
    modelRounds: [round],
    status,
    startTime: 900,
    endTime: status === 'completed' ? 1200 : undefined,
    storageTurnIndex: 0,
  };
}

function createContext(dialogTurn: DialogTurn): any {
  const session = {
    sessionId: SESSION_ID,
    dialogTurns: [dialogTurn],
    workspaceId: 'workspace-local',
    workspacePath: 'D:/workspace/OpenBitFun',
    createdAt: 1,
    lastActiveAt: 2,
    status: 'active',
    config: {},
    error: null,
    sessionKind: 'normal',
  };

  return {
    saveDebouncers: new Map(),
    lastSaveTimestamps: new Map(),
    lastSaveHashes: new Map(),
    turnSaveInFlight: new Map(),
    turnSavePending: new Set(),
    deferredStorageIdentitySaves: new Set(),
    flowChatStore: {
      getState: () => ({
        sessions: new Map([[SESSION_ID, session]]),
        activeSessionId: SESSION_ID,
      }),
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PersistenceModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveSessionTurn.mockResolvedValue(undefined);
    mockSaveSessionMetadata.mockResolvedValue(undefined);
    mockLoadSessionMetadata.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('saves a visible result receipt with its retained generation and no metadata read', async () => {
    const turn = createDialogTurn('completed');
    turn.recoveryEpoch = 2;
    await updateSessionMetadata(createContext(turn), SESSION_ID, ['unreadCompletion', 'needsUserAttention']);
    expect(mockLoadSessionMetadata).not.toHaveBeenCalled();
    expect(mockSaveSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      unreadCompletion: undefined,
      lastTurn: expect.objectContaining({ turnId: TURN_ID, status: 'completed', executionGeneration: 2 }),
    }), 'workspace-local', ['unreadCompletion', 'needsUserAttention']);
  });

  it('never writes old notification metadata to a device selected during its read', async () => {
    const original = getActiveSurfaceId();
    try {
      activateSurface('metadata-origin');
      mockLoadSessionMetadata.mockImplementationOnce(async () => {
        activateSurface('metadata-new-device');
        return null;
      });
      await updateSessionMetadata(createContext(createDialogTurn('completed')), SESSION_ID);
      expect(mockSaveSessionMetadata).not.toHaveBeenCalled();
    } finally {
      activateSurface(original);
    }
  });

  it('persists dialog turn token usage metadata when available', () => {
    const turn = createDialogTurn('completed');
    turn.tokenUsage = {
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
      timestamp: 2400,
    };

    const persisted = convertDialogTurnToBackendFormat(turn, 0);

    expect(persisted.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
      timestamp: 2400,
    });
  });

  it('persists finish reason when present', () => {
    const turn = createDialogTurn('completed');
    turn.finishReason = 'max_rounds';
    turn.hasFinalResponse = false;

    const persisted = convertDialogTurnToBackendFormat(turn, 0);

    expect(persisted.finishReason).toBe('max_rounds');
    expect(persisted.hasFinalResponse).toBe(false);
  });

  it('persists terminal error diagnostics for failed turns', () => {
    const turn = createDialogTurn('error');
    turn.error = 'OpenAI Streaming API failed after 10 attempts: connection refused';
    turn.errorDetail = {
      category: 'network',
      provider: 'openai',
      requestId: 'req-1',
    };

    const persisted = convertDialogTurnToBackendFormat(turn, 0);

    expect(persisted).toMatchObject({
      error: 'OpenAI Streaming API failed after 10 attempts: connection refused',
      errorDetail: {
        category: 'network',
        provider: 'openai',
        requestId: 'req-1',
      },
      status: 'error',
    });
  });

  it('persists ACP permission metadata for pending confirmation tools', () => {
    const turn = createDialogTurn('processing');
    turn.modelRounds[0].items = [
      {
        id: 'tool-1',
        type: 'tool',
        toolName: 'Read',
        toolCall: {
          id: 'tool-1',
          input: {
            filePath: '/',
          },
        },
        status: 'pending_confirmation',
        timestamp: 1001,
        startTime: 1001,
        requiresConfirmation: true,
        userConfirmed: false,
        acpPermission: {
          permissionId: 'acp_permission_1',
          sessionId: 'remote-session-1',
          toolCallId: 'tool-1',
          requestedAt: 1002,
          options: [
            {
              optionId: 'once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            {
              optionId: 'reject',
              name: 'Reject',
              kind: 'reject_once',
            },
          ],
        },
      } as any,
    ];

    const persisted = convertDialogTurnToBackendFormat(turn, 0);
    const [toolItem] = persisted.modelRounds[0].toolItems;

    expect(toolItem.requiresConfirmation).toBe(true);
    expect(toolItem.userConfirmed).toBe(false);
    expect(toolItem.acpPermission).toEqual({
      permissionId: 'acp_permission_1',
      sessionId: 'remote-session-1',
      toolCallId: 'tool-1',
      requestedAt: 1002,
      options: [
        {
          optionId: 'once',
          name: 'Allow once',
          kind: 'allow_once',
        },
        {
          optionId: 'reject',
          name: 'Reject',
          kind: 'reject_once',
        },
      ],
    });
  });

  it('persists only the original deferred wire invocation', () => {
    const turn = createDialogTurn('completed');
    turn.modelRounds[0].items = [{
      id: 'tool-1',
      type: 'tool',
      toolName: 'CallDeferredTool',
      toolCall: {
        id: 'tool-1',
        input: {
          tool_name: 'WebFetch',
          args: { url: 'https://example.test' },
        },
      },
      status: 'completed',
      timestamp: 1001,
      startTime: 1001,
    }];

    const persisted = convertDialogTurnToBackendFormat(turn, 0);
    const [toolItem] = persisted.modelRounds[0].toolItems;

    expect(toolItem).toMatchObject({
      toolName: 'CallDeferredTool',
      toolCall: {
        id: 'tool-1',
        input: {
          tool_name: 'WebFetch',
          args: { url: 'https://example.test' },
        },
      },
    });
    expect(toolItem).not.toHaveProperty('effectiveToolName');
    expect(toolItem).not.toHaveProperty('effectiveToolInput');
  });

  it('refuses to overwrite persistence with a completed mixed deferred identity', () => {
    const turn = createDialogTurn('completed');
    turn.modelRounds[0].items = [{
      id: 'tool-broken',
      type: 'tool',
      toolName: 'CallDeferredTool',
      toolCall: {
        id: 'tool-broken',
        input: { name: 'Plan', overview: 'Overview', plan: '# Plan' },
      },
      status: 'completed',
      timestamp: 1001,
      startTime: 1001,
    }];

    expect(() => convertDialogTurnToBackendFormat(turn, 0)).toThrow(
      'Completed deferred tool is missing its wire invocation: tool-broken',
    );
  });

  it('coalesces non-terminal immediate saves into a short latest-state window', async () => {
    const turn = createDialogTurn('processing');
    const context = createContext(turn);

    immediateSaveDialogTurn(context, SESSION_ID, TURN_ID);
    immediateSaveDialogTurn(context, SESSION_ID, TURN_ID);

    await flushMicrotasks();
    expect(mockSaveSessionTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(mockSaveSessionTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(1);
  });

  it('checkpoints continuous streamed output without waiting for a quiet period', async () => {
    const turn = createDialogTurn('processing');
    const context = createContext(turn);

    debouncedSaveDialogTurn(context, SESSION_ID, TURN_ID, 2000);
    await vi.advanceTimersByTimeAsync(1000);
    debouncedSaveDialogTurn(context, SESSION_ID, TURN_ID, 2000);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockSaveSessionTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(1);

    debouncedSaveDialogTurn(context, SESSION_ID, TURN_ID, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(2);
  });

  it('flushes terminal turn saves immediately', async () => {
    const turn = createDialogTurn('completed');
    const context = createContext(turn);

    immediateSaveDialogTurn(context, SESSION_ID, TURN_ID);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(1);
    expect(context.saveDebouncers.size).toBe(0);
  });

  it('clears pending delayed saves when saving directly', async () => {
    const turn = createDialogTurn('processing');
    const context = createContext(turn);

    immediateSaveDialogTurn(context, SESSION_ID, TURN_ID);
    expect(context.saveDebouncers.size).toBe(1);

    await saveDialogTurnToDisk(context, SESSION_ID, TURN_ID);
    await flushMicrotasks();

    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(1);
    expect(context.saveDebouncers.size).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockSaveSessionTurn).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite Runtime-owned interrupted or recovering turns', async () => {
    const turn = createDialogTurn('processing');
    turn.recovery = {
      status: 'recovering',
      executionGeneration: 1,
      resumeCount: 1,
    };
    const context = createContext(turn);

    await saveDialogTurnToDisk(context, SESSION_ID, TURN_ID);
    await flushMicrotasks();

    expect(mockSaveSessionTurn).not.toHaveBeenCalled();
  });

  it('defers partial-history saves until a storage identity is available', async () => {
    const turn = createDialogTurn('completed');
    delete turn.storageTurnIndex;
    const context = createContext(turn);
    const session = context.flowChatStore.getState().sessions.get(SESSION_ID);
    session.isPartial = true;
    session.totalTurnCount = 23;
    session.dialogTurns = [turn];

    await saveDialogTurnToDisk(context, SESSION_ID, TURN_ID);

    expect(mockSaveSessionTurn).not.toHaveBeenCalled();
    expect(context.deferredStorageIdentitySaves).toContain(`${SESSION_ID}:${TURN_ID}`);

    turn.storageTurnIndex = 140;
    await saveDialogTurnToDisk(context, SESSION_ID, TURN_ID);
    expect(mockSaveSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnIndex: 140 }),
      'workspace-local',
    );
  });

  it('uses explicit storage identity even when local history is only a tail', async () => {
    const turn = createDialogTurn('completed');
    turn.storageTurnIndex = 140;
    const context = createContext(turn);
    const session = context.flowChatStore.getState().sessions.get(SESSION_ID);
    session.isPartial = true;
    session.totalTurnCount = 23;
    session.dialogTurns = [turn];

    await saveDialogTurnToDisk(context, SESSION_ID, TURN_ID);
    await flushMicrotasks();

    expect(mockSaveSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnIndex: 140 }),
      'workspace-local',
    );
  });
});
