import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAPI } from './AgentAPI';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
    listen: vi.fn(),
  },
}));

describe('AgentAPI', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('lists sessions by workspace ID without sending a filesystem identity', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await agentAPI.listSessions('workspace-1');
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('list_sessions', {
      request: { workspaceId: 'workspace-1' },
    });
  });

  it.each([
    ['restoreSession', 'restore_session'],
    ['restoreSessionWithTurns', 'restore_session_with_turns'],
    ['restoreSessionView', 'restore_session_view'],
  ] as const)('restores with an ID through %s', async (method, command) => {
    await agentAPI[method]('session-1', 'workspace-1', 'trace-1', true);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(command, {
      request: { sessionId: 'session-1', workspaceId: 'workspace-1', traceId: 'trace-1', includeInternal: true },
    });
  });

  it('ensures a coordinator session using only its workspace ID', async () => {
    await agentAPI.ensureCoordinatorSession({ sessionId: 'session-1', workspaceId: 'workspace-1' });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('ensure_coordinator_session', {
      request: { sessionId: 'session-1', workspaceId: 'workspace-1' },
    });
  });

  it('preserves remote identity when querying the workspace mode catalog', async () => {
    invokeMock.mockResolvedValueOnce([]);

    await agentAPI.getAvailableModes({
      workspaceId: 'remote-workspace-id',
    });

    expect(invokeMock).toHaveBeenCalledWith('get_available_modes', {
      request: {
        workspaceId: 'remote-workspace-id',
      },
    });
  });

  it('sends an explicit Session mode rebind through the typed selector request', async () => {
    await agentAPI.updateSessionMode({
      sessionId: 'session-1',
      modeId: 'reviewer',
      workspacePath: 'D:/workspace/OpenBitFun',
      remoteConnectionId: 'remote-1',
    });

    expect(invokeMock).toHaveBeenCalledWith('update_session_mode', {
      request: {
        sessionId: 'session-1',
        modeId: 'reviewer',
        workspacePath: 'D:/workspace/OpenBitFun',
        remoteConnectionId: 'remote-1',
      },
    });
  });

  it('loads a bounded Session Turn window through a structured request', async () => {
    invokeMock.mockResolvedValueOnce({
      status: 'ready',
      catalogRevision: 'catalog-1',
      totalTurnCount: 20,
      startOrdinal: 4,
      endOrdinalExclusive: 20,
      targetTurnId: 'turn-8',
      turns: [],
    });

    await agentAPI.loadSessionTurnWindow({
      sessionId: 'session-1',
      workspacePath: 'D:/workspace/OpenBitFun',
      targetStorageTurnIndex: 8,
      expectedTurnId: 'turn-8',
      expectedCatalogRevision: 'catalog-1',
      before: 4,
      after: 12,
      remoteConnectionId: 'remote-1',
    });

    expect(invokeMock).toHaveBeenCalledWith('load_session_turn_window', {
      request: {
        sessionId: 'session-1',
        workspacePath: 'D:/workspace/OpenBitFun',
        targetStorageTurnIndex: 8,
        expectedTurnId: 'turn-8',
        expectedCatalogRevision: 'catalog-1',
        before: 4,
        after: 12,
        remoteConnectionId: 'remote-1',
      },
    });
  });

  it('normalizes omitted rollback file and retired-turn arrays', async () => {
    invokeMock.mockResolvedValueOnce({
      status: 'completed',
      sessionId: 'session-1',
      transcript: { sessionId: 'session-1', messages: [] },
      composer: { kind: 'preserve' },
      changed: true,
      hiddenTurnCount: 1,
    });

    await expect(agentAPI.rollbackSessionToTurn({
      workspaceId: 'workspace-id',
      sessionId: 'session-1',
      targetTurnId: 'turn-7',
    })).resolves.toMatchObject({
      status: 'completed',
      retiredTurnIds: [],
      restoredFiles: [],
    });

    invokeMock.mockResolvedValueOnce({
      status: 'recovery_required',
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      reason: 'reconcile marker',
    });
    await expect(agentAPI.rollbackSessionToTurn({
      workspaceId: 'workspace-id',
      sessionId: 'session-1',
      targetTurnId: 'turn-7',
    })).resolves.toMatchObject({
      status: 'recovery_required',
      affectedFiles: [],
    });
  });

  it('sends subagent timeout controls with the desktop command request shape', async () => {
    await agentAPI.setSubagentTimeout('subagent-session', { type: 'disable' });

    expect(invokeMock).toHaveBeenCalledWith('set_subagent_timeout', {
      request: {
        sessionId: 'subagent-session',
        action: { type: 'Disable', payload: null },
      },
    });
  });

  it('reloads one closed session context target through a structured request', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(agentAPI.reloadSessionContext({
      sessionId: 'session-1',
      target: 'instructions',
    })).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('reload_session_context', {
      request: {
        sessionId: 'session-1',
        target: 'instructions',
      },
    });
  });

  it('returns whether session cancellation was accepted for an active turn', async () => {
    invokeMock.mockResolvedValueOnce({
      cancelled: true,
      dialogTurnId: 'turn-1',
    });

    await expect(agentAPI.cancelSession('subagent-session')).resolves.toEqual({
      cancelled: true,
      dialogTurnId: 'turn-1',
    });
    expect(invokeMock).toHaveBeenCalledWith('cancel_session', {
      request: { sessionId: 'subagent-session' },
    });
  });

  it('preserves a no-active-turn cancellation response', async () => {
    invokeMock.mockResolvedValueOnce({
      cancelled: false,
      dialogTurnId: null,
    });

    await expect(agentAPI.cancelSession('idle-session')).resolves.toEqual({
      cancelled: false,
      dialogTurnId: null,
    });
  });

  it('can cancel a session without cancelling its descendants', async () => {
    invokeMock.mockResolvedValueOnce({
      cancelled: true,
      dialogTurnId: 'turn-parent',
    });

    await agentAPI.cancelSession('parent-session', { cancelDescendants: false });

    expect(invokeMock).toHaveBeenCalledWith('cancel_session', {
      request: {
        sessionId: 'parent-session',
        cancelDescendants: false,
      },
    });
  });

  it('sends subagent timeout extensions with seconds in the action payload', async () => {
    await agentAPI.setSubagentTimeout('subagent-session', { type: 'extend', seconds: 300 });

    expect(invokeMock).toHaveBeenCalledWith('set_subagent_timeout', {
      request: {
        sessionId: 'subagent-session',
        action: { type: 'Extend', payload: { seconds: 300 } },
      },
    });
  });

  it('responds to permission requests by request id', async () => {
    await agentAPI.respondPermission('permission-1', 'reject', 'Use a read-only path');

    expect(invokeMock).toHaveBeenCalledWith('respond_permission', {
      request: {
        requestId: 'permission-1',
        reply: 'reject',
        feedback: 'Use a read-only path',
      },
    });
  });

  it('responds to the current and following permission requests atomically', async () => {
    invokeMock.mockResolvedValue(['permission-1', 'permission-2']);

    await expect(
      agentAPI.respondPermissionBatch('permission-1', 'always'),
    ).resolves.toEqual(['permission-1', 'permission-2']);

    expect(invokeMock).toHaveBeenCalledWith('respond_permission_batch', {
      request: {
        requestId: 'permission-1',
        reply: 'always',
      },
    });
  });

  it('preserves structured worktree errors during atomic session creation', async () => {
    invokeMock.mockRejectedValueOnce(JSON.stringify({
      code: 'copy_conflict',
      message: 'A selected local file already exists in the target worktree',
      recoveryPath: '/tmp/recover-worktree',
    }));

    await expect(agentAPI.createSession({
      sessionName: 'Isolated task',
      agentType: 'Standard',
      workspacePath: '/repo',
      projectWorkspacePath: '/repo',
      requestId: 'request-worktree-1',
      executionTarget: {
        kind: 'newManagedWorktree',
        baseRef: 'HEAD',
        copyLocalChanges: true,
      },
    })).rejects.toMatchObject({
      name: 'WorktreeCommandError',
      code: 'copy_conflict',
      recoveryPath: '/tmp/recover-worktree',
    });
  });

});
