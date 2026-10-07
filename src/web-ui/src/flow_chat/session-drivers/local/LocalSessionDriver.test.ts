import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSessionDriver } from './LocalSessionDriver';
import type { DialogTurn } from '../../types/flow-chat';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { consumeSubmittedMessageArrival } from '../../services/submittedMessagePresentation';

const { mockCreateSession, mockStartAcpDialogTurn, mockStartAgenticDialogTurn, mockEnsureCoordinatorSession, mockTransition, mockUpdateSessionMetadata, mockGetMode, mockUpdateMode } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockStartAcpDialogTurn: vi.fn(),
  mockStartAgenticDialogTurn: vi.fn(),
  mockEnsureCoordinatorSession: vi.fn(),
  mockTransition: vi.fn(),
  mockUpdateSessionMetadata: vi.fn(),
  mockGetMode: vi.fn(),
  mockUpdateMode: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: { startDialogTurn: mockStartAcpDialogTurn },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    createSession: mockCreateSession,
    startDialogTurn: mockStartAgenticDialogTurn,
    ensureCoordinatorSession: mockEnsureCoordinatorSession,
    getSessionPermissionMode: mockGetMode,
    updateSessionPermissionMode: mockUpdateMode,
  },
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: {} }));
vi.mock('@/infrastructure/api/service-api/WorktreeAPI', () => ({ worktreeAPI: {} }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: {
    getState: () => ({
      openedWorkspaces: new Map([['project-workspace', {
        id: 'project-workspace', rootPath: WORKSPACE_PATH, workspaceKind: 'normal',
      }]]),
      recentWorkspaces: [],
    }),
  },
}));

vi.mock('../../state-machine', () => ({
  stateMachineManager: {
    transition: mockTransition,
    getCurrentState: () => 'idle',
    get: () => undefined,
  },
}));

vi.mock('../shared', async importOriginal => ({
  ...await importOriginal<typeof import('../shared')>(),
  applyGeneratingTitlePlaceholder: vi.fn(),
}));
vi.mock('../../services/flow-chat-manager/PersistenceModule', () => ({
  cleanupSaveState: vi.fn(), updateSessionMetadata: mockUpdateSessionMetadata,
}));

vi.mock('../../utils/modelSync', () => ({ syncSessionModelSelection: vi.fn() }));
vi.mock('../../utils/modelResolution', () => ({
  getModelMaxTokens: vi.fn(async () => 32000),
  resolveReasoningPresetForSessionCreation: vi.fn(async () => 'balanced'),
}));
vi.mock('../../services/sessionTitleMetadata', () => ({
  initializeSessionTitleMetadata: vi.fn(async (_id, descriptor) => descriptor),
}));

const SESSION_ID = 'acp_dsh_session';
const WORKSPACE_PATH = '/Users/user/workspace/project';

describe('localSessionDriver conversation creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSession.mockResolvedValue({ sessionId: 'host-session', workspaceId: 'project' });
  });

  function seed(agentType = 'Standard') {
    return {
      surfaceScope: getActiveSurfaceScope(), draftId: 'reserved-session',
      config: { modelName: 'selected-model' }, agentType, sessionName: 'New chat',
      titleDescriptor: { text: 'New chat', source: 'text' as const },
      workspaceId: 'project', workspacePath: WORKSPACE_PATH, projectWorkspacePath: WORKSPACE_PATH,
    };
  }

  it('reserves a frontend conversation without creating a host session', async () => {
    const createSession = vi.fn();
    const context = { flowChatStore: { createSession } } as any;
    await expect(localSessionDriver.createSession(context, seed())).resolves.toBe('reserved-session');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).toBe('reserved-session');
    expect(createSession.mock.calls[0][1]).toMatchObject({
      workspaceId: 'project', modelName: 'selected-model', reasoningPreset: 'balanced',
    });
    expect(createSession.mock.calls[0].at(-1)).toEqual({
      workspaceId: 'project', phase: 'editing', turnId: expect.any(String),
    });
  });

  it('keeps assistant bootstrap on the existing immediate creation path', async () => {
    const createSession = vi.fn();
    const context = { flowChatStore: { createSession } } as any;
    await expect(localSessionDriver.createSession(context, seed('Claw'))).resolves.toBe('host-session');
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'Claw', workspaceId: 'project', workspacePath: WORKSPACE_PATH,
    }));
    expect(createSession.mock.calls[0][0]).toBe('host-session');
  });
});

function persistedTurn(id: string, storageTurnIndex: number): DialogTurn {
  return {
    id,
    sessionId: SESSION_ID,
    userMessage: { id: `user-${id}`, content: 'earlier', timestamp: 1 },
    modelRounds: [],
    status: 'completed',
    startTime: 1,
    storageTurnIndex,
  };
}

function createHarness(existingTurns: DialogTurn[]) {
  const session: any = {
    sessionId: SESSION_ID,
    dialogTurns: [...existingTurns],
    workspacePath: WORKSPACE_PATH,
    config: {},
    mode: 'acp:dsh',
  };
  const addedTurns: DialogTurn[] = [];

  const context: any = {
    flowChatStore: {
      getState: () => ({ sessions: new Map([[SESSION_ID, session]]) }),
      addDialogTurn: (_sessionId: string, turn: DialogTurn) => {
        addedTurns.push(turn);
        session.dialogTurns = [...session.dialogTurns, turn];
      },
      deleteDialogTurn: vi.fn(),
      updateSessionLastSubmittedMode: vi.fn(),
      setSessionWorktreeIsolationRequested: vi.fn(),
    },
    processingManager: {
      registerStatus: vi.fn(),
      clearSessionStatus: vi.fn(),
    },
    pendingHistoryLoads: new Set<string>(),
    contentBuffers: new Map(),
    activeTextItems: new Map(),
  };

  return { context, session, addedTurns };
}

function startTurnInput(session: any) {
  return {
    surfaceScope: getActiveSurfaceScope(),
    sessionId: SESSION_ID,
    message: 'hello',
    displayMessage: 'hello',
    currentAgentType: 'acp:dsh',
    acpClientId: 'dsh',
    isFirstMessage: session.dialogTurns.length === 0,
    readySession: session,
    options: undefined,
  } as any;
}

describe('localSessionDriver.startTurn on an ACP session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransition.mockResolvedValue(true);
    mockStartAcpDialogTurn.mockResolvedValue(undefined);
    mockUpdateSessionMetadata.mockResolvedValue(undefined);
  });

  it('gives the first turn a storage slot so it can be persisted', async () => {
    const { context, session, addedTurns } = createHarness([]);

    await localSessionDriver.startTurn(context, startTurnInput(session), {
      createdLocalTurnId: null,
      hostAcceptedTurn: false,
    });

    expect(mockStartAcpDialogTurn).toHaveBeenCalledTimes(1);
    expect(addedTurns).toHaveLength(1);
    expect(consumeSubmittedMessageArrival(SESSION_ID, addedTurns[0].id, addedTurns[0].userMessage.id)).toBeDefined();
    expect(addedTurns[0].storageTurnIndex).toBe(0);
    expect(mockUpdateSessionMetadata).toHaveBeenCalledExactlyOnceWith(context, SESSION_ID, ['titleMetadata']);
    expect(mockStartAcpDialogTurn.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateSessionMetadata.mock.invocationCallOrder[0]);
  });

  it('continues after the turns already on disk when the session is resumed', async () => {
    const { context, session, addedTurns } = createHarness([
      persistedTurn('a', 0),
      persistedTurn('b', 1),
    ]);

    await localSessionDriver.startTurn(context, startTurnInput(session), {
      createdLocalTurnId: null,
      hostAcceptedTurn: false,
    });

    expect(addedTurns[0].storageTurnIndex).toBe(2);
    expect(mockUpdateSessionMetadata).not.toHaveBeenCalled();
  });

  it('leaves the slot to the runtime for a non-ACP turn', async () => {
    const { context, session, addedTurns } = createHarness([]);
    mockStartAgenticDialogTurn.mockResolvedValue(undefined);

    await localSessionDriver.startTurn(
      context,
      { ...startTurnInput(session), acpClientId: undefined, currentAgentType: 'Standard' },
      { createdLocalTurnId: null, hostAcceptedTurn: false },
    );

    expect(mockStartAgenticDialogTurn).toHaveBeenCalledTimes(1);
    expect(addedTurns[0].storageTurnIndex).toBeUndefined();
    expect(mockUpdateSessionMetadata).toHaveBeenCalledExactlyOnceWith(context, SESSION_ID, ['titleMetadata']);
  });

  it('does not release a default title slot when the host rejects the first turn', async () => {
    const { context, session } = createHarness([]);
    mockStartAcpDialogTurn.mockRejectedValueOnce(new Error('offline'));
    await expect(localSessionDriver.startTurn(context, startTurnInput(session), {
      createdLocalTurnId: null, hostAcceptedTurn: false,
    })).rejects.toThrow('offline');
    expect(mockUpdateSessionMetadata).not.toHaveBeenCalled();
  });
});

describe('localSessionDriver review repair permissions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTransition.mockResolvedValue(true);
    mockStartAgenticDialogTurn.mockResolvedValue(undefined);
    mockGetMode.mockResolvedValue({ mode: 'auto_approve' });
  });

  it('waits for parent permission inheritance before starting the repair', async () => {
    const { context, session } = createHarness([]);
    Object.assign(session, { sessionKind: 'review', parentSessionId: 'parent', mode: 'agentic' });
    let finishUpdate!: () => void;
    mockUpdateMode.mockImplementation(() => new Promise<void>((resolve) => { finishUpdate = resolve; }));
    const submission = localSessionDriver.startTurn(context, {
      ...startTurnInput(session), acpClientId: undefined, currentAgentType: 'ReviewFixer',
    }, { createdLocalTurnId: null, hostAcceptedTurn: false });
    await vi.waitFor(() => expect(mockUpdateMode).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, mode: 'auto_approve' }),
    ));
    expect(mockStartAgenticDialogTurn).not.toHaveBeenCalled();
    finishUpdate();
    await submission;
    expect(mockStartAgenticDialogTurn).toHaveBeenCalledTimes(1);
    expect(mockStartAgenticDialogTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'ReviewFixer',
    }));
  });

  it('does not start repair with stale permissions if inheritance fails', async () => {
    const { context, session } = createHarness([]);
    Object.assign(session, { sessionKind: 'deep_review', parentSessionId: 'parent', mode: 'agentic' });
    mockUpdateMode.mockRejectedValue(new Error('permission update failed'));
    await expect(localSessionDriver.startTurn(context, {
      ...startTurnInput(session), acpClientId: undefined, currentAgentType: 'ReviewFixer',
    }, { createdLocalTurnId: null, hostAcceptedTurn: false })).rejects.toThrow('permission update failed');
    expect(mockStartAgenticDialogTurn).not.toHaveBeenCalled();
  });
});


const queueMocks = vi.hoisted(() => ({ supported: vi.fn(() => false), submit: vi.fn() }));
vi.mock('../../services/hostDialogQueue', () => ({
  hostQueueSupported: queueMocks.supported,
  hostDialogQueue: () => ({ submit: queueMocks.submit }),
  queueImageAttachments: () => [],
}));

describe('host queue submissions', () => {
  beforeEach(() => { vi.clearAllMocks(); queueMocks.supported.mockReturnValue(true); queueMocks.submit.mockResolvedValue({ receipt: { status: 'queued' } }); });
  it('lets authoritative host events start a turn without clearing an existing active presentation', async () => {
    const { context, session, addedTurns } = createHarness([]);
    session.mode = 'Standard';
    context.contentBuffers.set(SESSION_ID, 'active output');
    context.activeTextItems.set(SESSION_ID, 'active item');
    const input = { ...startTurnInput(session), acpClientId: undefined, currentAgentType: 'Standard', isFirstMessage: false,
      options: { turnId: 'stable-request-id' } };
    const tracker = { createdLocalTurnId: null, hostAcceptedTurn: false };
    await localSessionDriver.startTurn(context, input, tracker);
    expect(queueMocks.submit).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }), expect.any(Object), 'stable-request-id');
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockStartAgenticDialogTurn).not.toHaveBeenCalled();
    expect(context.contentBuffers.get(SESSION_ID)).toBe('active output');
    expect(context.activeTextItems.get(SESSION_ID)).toBe('active item');
    expect(addedTurns).toHaveLength(0);
    expect(tracker.hostAcceptedTurn).toBe(true);
  });
});

describe('worktree follow-up submissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureCoordinatorSession.mockResolvedValue(undefined);
    mockTransition.mockResolvedValue(true);
    mockStartAgenticDialogTurn.mockResolvedValue(undefined);
    queueMocks.submit.mockResolvedValue({ receipt: { status: 'queued' } });
  });

  it.each([false, true])('prepares the owning project and sends the next turn with host queue support %s', async supportsQueue => {
    queueMocks.supported.mockReturnValue(supportsQueue);
    const { context, session } = createHarness([persistedTurn('turn-1', 0)]);
    Object.assign(session, {
      mode: 'Standard',
      isHistorical: false,
      historyState: 'ready',
      workspaceId: 'worktree-not-in-catalog',
      workspacePath: '/worktrees/task',
      projectWorkspaceId: 'project-workspace',
      projectWorkspacePath: WORKSPACE_PATH,
      config: {
        executionTarget: { kind: 'managedWorktree', worktreeId: 'worktree-1', rootPath: '/worktrees/task' },
      },
    });
    const tracker = { createdLocalTurnId: null, hostAcceptedTurn: false };

    await localSessionDriver.ensureReady(context, SESSION_ID);
    await localSessionDriver.startTurn(context, {
      ...startTurnInput(session), acpClientId: undefined, currentAgentType: 'Standard',
    }, tracker);

    expect(mockEnsureCoordinatorSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID, workspaceId: 'project-workspace', includeInternal: false,
    });
    if (supportsQueue) {
      expect(queueMocks.submit).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'hello' }), expect.any(Object), undefined,
      );
      expect(mockStartAgenticDialogTurn).not.toHaveBeenCalled();
    } else {
      expect(mockStartAgenticDialogTurn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: SESSION_ID,
        workspaceId: 'worktree-not-in-catalog',
        workspacePath: '/worktrees/task',
        projectWorkspacePath: WORKSPACE_PATH,
      }));
    }
    expect(tracker.hostAcceptedTurn).toBe(true);
    expect(session.workspacePath).toBe('/worktrees/task');
    expect(session.dialogTurns[0].id).toBe('turn-1');
  });
});
