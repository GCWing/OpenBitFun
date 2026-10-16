import { describe, expect, it } from 'vitest';
import {
  WorkspaceKind,
  WorkspaceType,
  type WorkspaceInfo,
} from '@/shared/types/global-state';
import {
  getWorkspaceGitBasicInfoOptions,
  suppressWorkspaceGitRefreshOnMountDuringSessionTransition,
  WORKSPACE_GIT_PENDING_CANCEL_REASONS,
  WORKSPACE_GIT_PENDING_CANCEL_SOURCES,
} from './workspaceGitRefreshOptions';

const createWorkspace = (workspaceKind: WorkspaceKind): WorkspaceInfo => ({
  id: `${workspaceKind}-workspace`,
  name: 'OpenBitFun',
  rootPath: '/workspace/OpenBitFun',
  workspaceType: WorkspaceType.SingleProject,
  workspaceKind,
  languages: [],
  openedAt: '2026-06-02T00:00:00Z',
  lastAccessed: '2026-06-02T00:00:00Z',
  tags: [],
  ...(workspaceKind === WorkspaceKind.Remote
    ? {
        connectionId: 'remote-connection',
        sshHost: 'remote.example.com',
      }
    : {}),
});

describe('getWorkspaceGitBasicInfoOptions', () => {
  it('limits history-transition cancellation to passive workspace git auto refreshes', () => {
    expect(WORKSPACE_GIT_PENDING_CANCEL_REASONS).toEqual(['mount', 'visibility']);
    expect(WORKSPACE_GIT_PENDING_CANCEL_SOURCES).toEqual([
      'workspace_item_git_basic_info',
      'workspace_git_initializer',
    ]);
  });

  it('refreshes active local workspace rows on mount', () => {
    expect(getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Normal), true))
      .toEqual({
        isActive: true,
        refreshOnMount: true,
        refreshOnActive: true,
        participateInWindowFocusRefresh: false,
        debugSource: 'workspace_item_git_basic_info',
        cancelPendingRefreshSources: ['workspace_git_initializer'],
      });
  });

  it('defers inactive local workspace row refresh until activation', () => {
    expect(getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Normal), false))
      .toEqual({
        isActive: false,
        refreshOnMount: false,
        refreshOnActive: true,
        participateInWindowFocusRefresh: false,
        debugSource: 'workspace_item_git_basic_info',
        cancelPendingRefreshSources: ['workspace_git_initializer'],
      });
  });

  it('defers inactive remote workspace rows until activation too', () => {
    expect(getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Remote), false))
      .toMatchObject({ isActive: false, refreshOnMount: false, refreshOnActive: true });
    expect(getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Remote), true))
      .toMatchObject({ isActive: true, refreshOnMount: true, refreshOnActive: true });
  });

  it('suppresses only mount refresh during a history session transition', () => {
    const options = getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Normal), true);

    expect(suppressWorkspaceGitRefreshOnMountDuringSessionTransition(options, true))
      .toEqual({
        isActive: true,
        refreshOnMount: false,
        refreshOnActive: true,
        participateInWindowFocusRefresh: false,
        debugSource: 'workspace_item_git_basic_info',
        cancelPendingRefreshSources: ['workspace_git_initializer'],
      });
  });

  it('does not allocate replacement options outside history session transitions', () => {
    const options = getWorkspaceGitBasicInfoOptions(createWorkspace(WorkspaceKind.Normal), true);

    expect(suppressWorkspaceGitRefreshOnMountDuringSessionTransition(options, false))
      .toBe(options);
  });
});
