vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { getState: () => ({ openedWorkspaces: new Map(), recentWorkspaces: [] }) } }));
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import type { Session } from '../types/flow-chat';
import {
  isRemoteWorkspaceSession,
  isLocalWorkspaceSession,
  requireSessionProjectWorkspacePath,
  sessionExecutionWorkspacePath,
  sessionProjectWorkspacePath,
} from './sessionWorkspace';

function session(
  values: Partial<Pick<Session, 'workspacePath' | 'projectWorkspacePath' | 'config'>>,
): Pick<Session, 'workspacePath' | 'projectWorkspacePath' | 'config'> {
  return {
    workspacePath: undefined,
    projectWorkspacePath: undefined,
    config: {},
    ...values,
  };
}

describe('sessionWorkspace', () => {
  it('uses only the ID-selected object kind, even when SSH hints disagree', () => {
    const local = { id: 'local-id', workspaceKind: WorkspaceKind.Normal } as WorkspaceInfo;
    const remote = { id: 'remote-id', workspaceKind: WorkspaceKind.Remote } as WorkspaceInfo;
    expect(isRemoteWorkspaceSession(undefined, local)).toBe(false);
    expect(isRemoteWorkspaceSession(undefined, remote)).toBe(true);
    expect(isRemoteWorkspaceSession({ workspaceId: local.id, config: { remoteConnectionId: 'dirty' } }, local)).toBe(false);
    expect(isRemoteWorkspaceSession({ workspaceId: remote.id, config: {} }, remote)).toBe(true);
    expect(isRemoteWorkspaceSession({ workspaceId: local.id }, remote)).toBe(false);
    expect(isLocalWorkspaceSession({ workspaceId: local.id }, remote)).toBe(false);
    expect(isLocalWorkspaceSession({ workspaceId: local.id }, local)).toBe(true);
    expect(isLocalWorkspaceSession({ workspaceId: remote.id }, remote)).toBe(false);
  });

  it('keeps execution and project roots distinct for a worktree session', () => {
    const worktreeSession = session({
      workspacePath: '/worktrees/wt-1',
      projectWorkspacePath: '/repo',
      config: {
        workspacePath: '/worktrees/wt-1',
        projectWorkspacePath: '/repo',
      },
    });

    expect(sessionExecutionWorkspacePath(worktreeSession)).toBe('/worktrees/wt-1');
    expect(sessionProjectWorkspacePath(worktreeSession)).toBe('/repo');
    expect(requireSessionProjectWorkspacePath(worktreeSession, 'session-1')).toBe('/repo');
  });

  it('treats legacy sessions as local to their execution root', () => {
    const legacySession = session({
      config: { workspacePath: '/repo' },
    });

    expect(sessionExecutionWorkspacePath(legacySession)).toBe('/repo');
    expect(sessionProjectWorkspacePath(legacySession)).toBe('/repo');
  });
});
