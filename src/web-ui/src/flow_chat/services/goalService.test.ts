import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import { runGoalCommand } from './goalService';

const mocks = vi.hoisted(() => ({
  activateSessionGoal: vi.fn(),
  bindSession: vi.fn(),
  getSessionThreadGoal: vi.fn(),
  getState: vi.fn(),
  pendingList: vi.fn(),
  pendingRemove: vi.fn(),
  setSessionWorktreeIsolationRequested: vi.fn(),
  setThreadGoal: vi.fn(),
  updateSessionExecutionTarget: vi.fn(),
  notificationSuccess: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    activateSessionGoal: (params: unknown) => mocks.activateSessionGoal(params),
    clearSessionThreadGoal: vi.fn(),
    getSessionThreadGoal: (params: unknown) => mocks.getSessionThreadGoal(params),
    setSessionThreadGoalStatus: vi.fn(),
    updateSessionThreadGoalObjective: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/WorktreeAPI', () => ({
  worktreeAPI: {
    bindSession: (...args: unknown[]) => mocks.bindSession(...args),
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    error: vi.fn(),
    info: vi.fn(),
    success: (...args: unknown[]) => mocks.notificationSuccess(...args),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => mocks.getState(),
    setSessionWorktreeIsolationRequested: (...args: unknown[]) => (
      mocks.setSessionWorktreeIsolationRequested(...args)
    ),
    setThreadGoal: (...args: unknown[]) => mocks.setThreadGoal(...args),
    updateSessionExecutionTarget: (...args: unknown[]) => (
      mocks.updateSessionExecutionTarget(...args)
    ),
  },
}));

vi.mock('./flow-chat-manager/PendingQueueModule', () => ({
  pendingQueueManager: {
    list: (...args: unknown[]) => mocks.pendingList(...args),
    remove: (...args: unknown[]) => mocks.pendingRemove(...args),
  },
}));

describe('/goal worktree preparation', () => {
  let currentSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = {
      sessionId: 'session-1',
      dialogTurns: [],
      status: 'active',
      config: {
        workspaceId: 'workspace-1',
        workspacePath: '/repo',
        projectWorkspacePath: '/repo',
        executionTarget: {
          kind: 'local',
          rootPath: '/repo',
        },
        worktreeIsolationRequested: true,
      },
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      projectWorkspacePath: '/repo',
      createdAt: 0,
      lastActiveAt: 0,
      error: null,
      sessionKind: 'normal',
    };

    mocks.getState.mockImplementation(() => ({
      sessions: new Map([[currentSession.sessionId, currentSession]]),
    }));
    mocks.pendingList.mockReturnValue([]);
    mocks.getSessionThreadGoal.mockResolvedValue({ goal: null });
    mocks.bindSession.mockResolvedValue({
      sessionId: currentSession.sessionId,
      workspacePath: '/worktrees/wt-1',
      projectWorkspacePath: '/repo',
      workspaceId: 'workspace-1',
      executionTarget: {
        kind: 'managedWorktree',
        worktreeId: 'wt-1',
        rootPath: '/worktrees/wt-1',
      },
    });
    mocks.updateSessionExecutionTarget.mockImplementation((
      _sessionId: string,
      binding: {
        workspacePath: string;
        projectWorkspacePath: string;
        workspaceId?: string;
        executionTarget: Session['config']['executionTarget'];
      },
    ) => {
      currentSession = {
        ...currentSession,
        workspacePath: binding.workspacePath,
        projectWorkspacePath: binding.projectWorkspacePath,
        workspaceId: binding.workspaceId,
        config: {
          ...currentSession.config,
          workspacePath: binding.workspacePath,
          projectWorkspacePath: binding.projectWorkspacePath,
          workspaceId: binding.workspaceId,
          executionTarget: binding.executionTarget,
        },
      };
    });
    mocks.setSessionWorktreeIsolationRequested.mockImplementation((
      _sessionId: string,
      requested: boolean | undefined,
    ) => {
      currentSession = {
        ...currentSession,
        config: {
          ...currentSession.config,
          worktreeIsolationRequested: requested,
        },
      };
    });
    mocks.activateSessionGoal.mockResolvedValue({
      goal: {
        goalId: 'goal-1',
        objective: 'finish the task',
        status: 'active',
      },
    });
  });

  it('materializes the pending worktree before activating a new goal', async () => {
    const result = await runGoalCommand({
      session: currentSession,
      action: { kind: 'set', objective: 'finish the task' },
      usageMessage: 'usage',
      failedTitle: 'failed',
      unknownErrorMessage: 'unknown',
      activatedTitle: 'activated',
      clearedTitle: 'cleared',
      pausedTitle: 'paused',
      resumedTitle: 'resumed',
      editedTitle: 'edited',
    });

    expect(mocks.bindSession).toHaveBeenCalledWith(
      'session-1',
      true,
      expect.any(String),
      { enabled: true, projectWorkspaceId: 'workspace-1', projectWorkspacePath: '/repo' },
    );
    expect(mocks.activateSessionGoal).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
      userHint: 'finish the task',
    });
    expect(mocks.bindSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateSessionGoal.mock.invocationCallOrder[0],
    );
    expect(currentSession.config.executionTarget?.worktreeId).toBe('wt-1');
    expect(currentSession.config.worktreeIsolationRequested).toBeUndefined();
    expect(result).toMatchObject({
      goalId: 'goal-1',
      objective: 'finish the task',
      status: 'active',
    });
  });

  it('clears a stale worktree request instead of rebinding a nonempty session', async () => {
    currentSession = {
      ...currentSession,
      totalTurnCount: 1,
    };

    await runGoalCommand({
      session: currentSession,
      action: { kind: 'set', objective: 'finish the task' },
      usageMessage: 'usage',
      failedTitle: 'failed',
      unknownErrorMessage: 'unknown',
      activatedTitle: 'activated',
      clearedTitle: 'cleared',
      pausedTitle: 'paused',
      resumedTitle: 'resumed',
      editedTitle: 'edited',
    });

    expect(mocks.bindSession).not.toHaveBeenCalled();
    expect(mocks.setSessionWorktreeIsolationRequested).toHaveBeenCalledWith(
      'session-1',
      undefined,
    );
    expect(mocks.activateSessionGoal).toHaveBeenCalledOnce();
    expect(currentSession.config.worktreeIsolationRequested).toBeUndefined();
  });
});
