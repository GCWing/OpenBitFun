import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';
import type { Session } from '../types/flow-chat';
import type { FlowChatContext } from './flow-chat-manager/types';
import { canSelectSessionWorkspace, materializeSessionDraft, selectDraftWorkspace } from './sessionDraftService';
import { hasSessionStarted, isSessionBindingLocked } from '../utils/sessionLifecycle';
import { isSessionWorktreeBindingLocked } from '../utils/sessionWorktree';
import { shouldSyncSessionModelSelection } from '../utils/modelSelectionTarget';
import { chatInputSessionSubscriptionKey } from '../utils/chatInputSessionSubscription';

const ports = vi.hoisted(() => ({ create: vi.fn(), metadata: vi.fn(), permission: vi.fn(),
  workspaces: new Map<string, WorkspaceInfo>() }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: {
  createSession: ports.create, updateSessionPermissionMode: ports.permission,
} }));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { loadSessionMetadata: ports.metadata } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {
  getState: () => ({ openedWorkspaces: ports.workspaces, recentWorkspaces: [] }),
} }));
vi.mock('./sessionTitleMetadata', () => ({ initializeSessionTitleMetadata: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: (key: string) => key } }));

function harness(overrides: Partial<Session> = {}) {
  let state = { activeSessionId: 'reserved', sessions: new Map([['reserved', {
    sessionId: 'reserved', title: 'New', titleSource: 'text', mode: 'Standard', historyState: 'new',
    workspaceId: 'a', workspacePath: '/a', projectWorkspacePath: '/a',
    config: { modelName: 'model', worktreeIsolationRequested: true }, dialogTurns: [],
    status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
    draft: { workspaceId: 'a', phase: 'editing', turnId: 'first-turn' }, ...overrides,
  } as Session]]) };
  const context = { flowChatStore: { getState: () => state,
    setState: (update: (value: typeof state) => typeof state) => { state = update(state); },
  } } as unknown as FlowChatContext;
  return { context, read: () => state.sessions.get('reserved')!, state: () => state };
}

beforeEach(() => {
  vi.clearAllMocks();
  ports.workspaces.clear();
  for (const id of ['a', 'b', 'c']) ports.workspaces.set(id, { id, rootPath: `/${id}`, workspaceKind: 'normal' } as WorkspaceInfo);
  ports.create.mockImplementation(async request => ({ ...request, modelId: request.config.modelName }));
  ports.metadata.mockResolvedValue(null);
  ports.permission.mockResolvedValue({ mode: 'auto' });
});

describe('new conversation workspace ownership', () => {
  it('changes the draft target without navigating or creating anything; only first send binds the target', async () => {
    const h = harness();
    const before = chatInputSessionSubscriptionKey(h.read());
    selectDraftWorkspace(h.context, 'reserved', 'b');
    expect(h.read().workspaceId).toBe('a');
    expect(h.read().draft?.workspaceId).toBe('b');
    expect(h.state().activeSessionId).toBe('reserved');
    expect(h.read().config.worktreeIsolationRequested).toBeUndefined();
    expect(chatInputSessionSubscriptionKey(h.read())).not.toBe(before);
    expect(ports.create).not.toHaveBeenCalled();
    await materializeSessionDraft(h.context, 'reserved');
    expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'reserved', workspaceId: 'b', workspacePath: '/b', projectWorkspacePath: '/b',
    }));
    expect(h.read().workspaceId).toBe('b');
    expect(h.read().draft?.phase).toBe('ready');
    expect(h.read().draft?.turnId).toBe('first-turn');
  });

  it('uses the last selected target and keeps model and permission choices local until creation', async () => {
    const h = harness({ draft: { workspaceId: 'a', phase: 'editing', turnId: 'first', permissionMode: 'auto' } });
    expect(shouldSyncSessionModelSelection(h.read())).toBe(false);
    selectDraftWorkspace(h.context, 'reserved', 'b');
    selectDraftWorkspace(h.context, 'reserved', 'c');
    await materializeSessionDraft(h.context, 'reserved');
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'c' }));
    expect(ports.permission).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'c', mode: 'auto' }));
  });

  it('serializes creation and locks a stale directory handler while creation is pending', async () => {
    let finish!: (value: object) => void;
    ports.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = harness();
    const first = materializeSessionDraft(h.context, 'reserved');
    const retry = materializeSessionDraft(h.context, 'reserved');
    expect(canSelectSessionWorkspace(h.read())).toBe(false);
    expect(() => selectDraftWorkspace(h.context, 'reserved', 'b')).toThrow('locked');
    finish({ sessionId: 'reserved', workspaceId: 'a' });
    await Promise.all([first, retry]);
    expect(ports.create).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost create acknowledgement with the reserved identity instead of creating another session', async () => {
    const h = harness();
    selectDraftWorkspace(h.context, 'reserved', 'b');
    ports.create.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(materializeSessionDraft(h.context, 'reserved')).rejects.toThrow('Connection lost');
    ports.metadata.mockResolvedValueOnce({ sessionId: 'reserved', workspaceId: 'b', workspacePath: '/b',
      sessionName: 'New', agentType: 'Standard', modelName: 'model' });
    await materializeSessionDraft(h.context, 'reserved');
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.metadata).toHaveBeenCalledWith('reserved', 'b');
    expect(h.read().workspaceId).toBe('b');
  });

  it('does not fall back to the original directory when the target has closed', async () => {
    const h = harness();
    selectDraftWorkspace(h.context, 'reserved', 'b');
    ports.workspaces.delete('b');
    await expect(materializeSessionDraft(h.context, 'reserved')).rejects.toThrow('unavailable');
    expect(ports.create).not.toHaveBeenCalled();
    expect(h.read().draft?.phase).toBe('editing');
    selectDraftWorkspace(h.context, 'reserved', 'a');
    expect(h.read().draft?.workspaceId).toBe('a');
  });

  it('leaves a draft editable when its linked worktree cannot resolve the owning project', async () => {
    ports.workspaces.set('b', { ...ports.workspaces.get('b')!,
      worktree: { isMain: false, mainWorkspaceId: 'missing' },
    } as WorkspaceInfo);
    const h = harness();
    selectDraftWorkspace(h.context, 'reserved', 'b');
    await expect(materializeSessionDraft(h.context, 'reserved')).rejects.toThrow('project workspace is unavailable');
    expect(ports.create).not.toHaveBeenCalled();
    expect(canSelectSessionWorkspace(h.read())).toBe(true);
  });

  it('resolves an SSH target from its workspace record and drops source connection fields', async () => {
    const remote = { id: 'remote', workspaceKind: 'remote', rootPath: '/srv/app',
      connectionId: 'ssh-b', sshHost: 'host-b' } as WorkspaceInfo;
    ports.workspaces.set(remote.id, remote);
    const h = harness({ remoteConnectionId: 'old', remoteSshHost: 'old-host' });
    selectDraftWorkspace(h.context, 'reserved', 'remote');
    await materializeSessionDraft(h.context, 'reserved');
    expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'remote',
      workspacePath: '/srv/app', remoteConnectionId: 'ssh-b', remoteSshHost: 'host-b' }));
    expect(h.read().remoteConnectionId).toBe('ssh-b');
  });

  it('never unlocks an accepted conversation after rollback, or an unknown historical projection', () => {
    const rolledBack = harness({ lastSubmittedMode: 'Standard' }).read();
    expect(hasSessionStarted(rolledBack)).toBe(true);
    expect(canSelectSessionWorkspace(rolledBack)).toBe(false);
    expect(isSessionWorktreeBindingLocked(rolledBack, false)).toBe(true);
    const historical = harness({ draft: undefined, historyState: 'metadata-only', isHistorical: true }).read();
    expect(isSessionBindingLocked(historical)).toBe(true);
    expect(canSelectSessionWorkspace(historical)).toBe(false);
  });
});
