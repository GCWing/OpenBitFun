import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAPI, type SessionPermissionModeRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '../types/flow-chat';
import {
  canTreatMissingPermissionModeAsDefault,
  isSessionNotFoundError,
  sessionPermissionModeScope,
} from './sessionPermissionMode';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {} }));

const emptyNewSession = {
  dialogTurns: [],
  historyState: 'new' as const,
  isHistorical: false,
  persistedTurnCount: undefined,
};

describe('session permission mode lifecycle', () => {
  it('does not classify a missing projection as a host-record failure', () => {
    expect(canTreatMissingPermissionModeAsDefault(undefined)).toBe(false);
  });

  it('treats an empty new local projection as inheriting the default', () => {
    expect(canTreatMissingPermissionModeAsDefault(emptyNewSession)).toBe(true);
  });

  it.each([
    ['a historical session', { ...emptyNewSession, isHistorical: true }],
    ['a hydrated session', { ...emptyNewSession, historyState: 'ready' as const }],
    ['a session with persisted turns', { ...emptyNewSession, persistedTurnCount: 1 }],
    ['a session with projected turns', {
      ...emptyNewSession,
      dialogTurns: [{ id: 'turn-1' }] as Session['dialogTurns'],
    }],
  ])('does not hide missing records for %s', (_label, session) => {
    expect(canTreatMissingPermissionModeAsDefault(session)).toBe(false);
  });

  it('requires the specific missing-session error before suppressing the notification', () => {
    expect(isSessionNotFoundError(new Error('Not found: Session not found: session-1'))).toBe(true);
    expect(isSessionNotFoundError(new Error('Host offline'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Permission denied'))).toBe(false);
  });
});

describe('composer permission request scope', () => {
  // Shape registered by agent.ensureSession, including a restored topic whose
  // history is already present when the floating conversation opens.
  const miniAppSession = {
    sessionId: 'miniapp-topic',
    sessionKind: 'miniapp',
    isTransient: true,
    agentBackedTransient: true,
    workspaceId: 'appdata-workspace',
    workspacePath: '/host/miniapps/market-lens/research/topic',
    config: {},
    historyState: 'ready',
    dialogTurns: [{ id: 'previous-turn' }],
    persistedTurnCount: 1,
  } as Session;

  beforeEach(() => { invoke.mockReset(); });

  it.each([
    ['getSessionPermissionMode', 'get_session_permission_mode'],
    ['updateSessionPermissionMode', 'update_session_permission_mode'],
    ['updateActiveTurnPermissionMode', 'update_active_turn_permission_mode'],
  ] as const)('accesses a restored MiniApp internal session through %s', async (method, command) => {
    const result = { mode: 'ask', turnMode: 'auto_approve', activeTurnId: 'active-turn' };
    invoke.mockImplementation(async (_command: string, { request }: { request: SessionPermissionModeRequest }) => {
      // The host's selector rejects hidden sessions unless explicitly included,
      // even when their history and live runtime have already been loaded.
      if (!request.includeInternal) throw new Error(`Session not found: ${request.sessionId}`);
      return result;
    });
    const request = {
      sessionId: miniAppSession.sessionId,
      turnId: 'active-turn',
      ...sessionPermissionModeScope(miniAppSession),
      ...(method === 'getSessionPermissionMode' ? {} : { mode: 'ask' as const }),
    };
    await expect(agentAPI[method]({ ...request, includeInternal: undefined })).rejects.toThrow('Session not found');
    await expect(agentAPI[method](request)).resolves.toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith(command, { request: {
      sessionId: 'miniapp-topic', turnId: 'active-turn',
      workspaceId: 'appdata-workspace', workspacePath: miniAppSession.workspacePath,
      includeInternal: true, remoteConnectionId: undefined, remoteSshHost: undefined,
      ...(method === 'getSessionPermissionMode' ? {} : { mode: 'ask' }),
    } });
    expect(canTreatMissingPermissionModeAsDefault(miniAppSession)).toBe(false);
  });

  it('keeps legacy path-only MiniApp topics addressable without inventing a workspace ID', () => {
    const legacy = { ...miniAppSession, workspaceId: undefined };
    const wireScope = JSON.parse(JSON.stringify(sessionPermissionModeScope(legacy)));
    expect(wireScope).toEqual({ workspacePath: miniAppSession.workspacePath, includeInternal: true });
  });

  it('preserves the owning project and POSIX scope for a remote subagent in a worktree', () => {
    const remote = { ...miniAppSession, sessionKind: 'subagent', agentBackedTransient: false,
      workspaceId: 'remote-worktree', workspacePath: '/srv/project/.worktrees/task',
      projectWorkspaceId: 'remote-project', projectWorkspacePath: '/srv/project',
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'target-host',
      config: { executionTarget: { kind: 'worktree', worktreeId: 'task' } },
    } as Session;
    expect(sessionPermissionModeScope(remote)).toEqual({
      workspaceId: 'remote-project', workspacePath: '/srv/project',
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'target-host', includeInternal: true,
    });
  });

  it('does not opt ordinary or UI-only transient sessions into internal visibility', () => {
    const ordinary = { ...miniAppSession, sessionKind: 'normal', agentBackedTransient: false } as Session;
    expect(sessionPermissionModeScope(ordinary).includeInternal).toBe(false);
    expect(sessionPermissionModeScope(undefined)).toEqual({
      workspaceId: undefined, workspacePath: undefined, remoteConnectionId: undefined,
      remoteSshHost: undefined, includeInternal: false,
    });
  });

  it('propagates a real host failure for a MiniApp instead of reporting a default-mode success', async () => {
    invoke.mockRejectedValue(new Error('Host offline'));
    await expect(agentAPI.getSessionPermissionMode({ sessionId: miniAppSession.sessionId,
      ...sessionPermissionModeScope(miniAppSession),
    })).rejects.toThrow('Host offline');
  });
});
