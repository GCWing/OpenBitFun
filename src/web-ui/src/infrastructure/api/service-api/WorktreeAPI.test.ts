import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeAPI, WorktreeCommandError } from './WorktreeAPI';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

describe('WorktreeAPI', () => {
  let api: WorktreeAPI;

  beforeEach(() => {
    api = new WorktreeAPI();
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it('uses project-scoped commands and never enables force by default', async () => {
    invokeMock.mockResolvedValue({ worktreeId: 'wt-1', removed: true });

    await api.remove(
      { projectWorkspaceId: 'workspace-1', projectWorkspacePath: '/repo' },
      'wt-1',
      'request-1',
    );

    expect(invokeMock).toHaveBeenCalledWith('worktree_remove', {
      request: {
        projectWorkspaceId: 'workspace-1',
        projectWorkspacePath: '/repo',
        worktreeId: 'wt-1',
        requestId: 'request-1',
        force: false,
      },
    });
  });

  it('lists the local workspace worktree catalog through a structured request', async () => {
    invokeMock.mockResolvedValue([]);

    await api.listProjects();

    expect(invokeMock).toHaveBeenCalledWith('worktree_list_projects', {
      request: {},
    });
  });

  it('preserves stable structured error codes', async () => {
    const transportError = Object.assign(new Error('command failed'), {
      data: {
        code: 'dirty_worktree',
        message: 'The worktree contains local changes',
      },
    });
    invokeMock.mockRejectedValue(transportError);

    await expect(
      api.remove({ projectWorkspacePath: '/repo' }, 'wt-1', 'request-2'),
    ).rejects.toMatchObject({
      name: 'WorktreeCommandError',
      code: 'dirty_worktree',
      message: 'The worktree contains local changes',
    } satisfies Partial<WorktreeCommandError>);
  });

  it('unwraps domain errors nested by ApiClient command handling', async () => {
    const transportError = Object.assign(new Error('Session not found: history-1'), {
      code: 'COMMAND_FAILED',
      details: {
        originalError: {
          code: 'worktree_not_found',
          message: 'Session not found: history-1',
        },
      },
    });
    invokeMock.mockRejectedValue(transportError);

    await expect(
      api.bindSession('history-1', true, 'request-3', {
        projectWorkspacePath: 'D:\\workspace\\OpenBitFun',
      }),
    ).rejects.toMatchObject({
      name: 'WorktreeCommandError',
      code: 'worktree_not_found',
      message: 'Session not found: history-1',
    } satisfies Partial<WorktreeCommandError>);
  });

  it('sends the project locator when binding a historical session', async () => {
    invokeMock.mockResolvedValue({
      sessionId: 'history-1',
      workspacePath: '/worktrees/wt-1',
      projectWorkspacePath: '/repo',
      executionTarget: {
        kind: 'managedWorktree',
        worktreeId: 'wt-1',
        rootPath: '/worktrees/wt-1',
      },
    });

    await api.bindSession('history-1', true, 'request-4', {
      projectWorkspaceId: 'workspace-1',
      projectWorkspacePath: '/repo',
    });

    expect(invokeMock).toHaveBeenCalledWith('worktree_bind_session', {
      request: {
        sessionId: 'history-1',
        enabled: true,
        requestId: 'request-4',
        projectWorkspaceId: 'workspace-1',
        projectWorkspacePath: '/repo',
      },
    });
  });

  it('omits a blank project workspace ID from legacy path-only locators', async () => {
    invokeMock.mockResolvedValue([]);

    await api.list({ projectWorkspaceId: '  ', projectWorkspacePath: '/repo' });

    expect(invokeMock).toHaveBeenCalledWith('worktree_list', {
      request: { projectWorkspacePath: '/repo' },
    });
  });

  it('subscribes to event-driven worktree updates', () => {
    const unsubscribe = vi.fn();
    const callback = vi.fn();
    listenMock.mockReturnValue(unsubscribe);

    expect(api.onChanged(callback)).toBe(unsubscribe);
    expect(listenMock).toHaveBeenCalledWith('worktree://changed', callback);
  });
});
