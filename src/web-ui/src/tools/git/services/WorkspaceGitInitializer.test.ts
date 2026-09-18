import { describe, expect, it, vi } from 'vitest';

const workspaceManagerMock = vi.hoisted(() => ({
  addEventListener: vi.fn(() => vi.fn()),
  getState: vi.fn(() => ({
    currentWorkspace: {
      id: 'workspace-1', rootPath: 'D:/workspace/OpenBitFun',
    },
  })),
}));

const gitStateManagerMock = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  invalidateCache: vi.fn(),
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: workspaceManagerMock,
}));

vi.mock('../state/GitStateManager', () => ({
  gitStateManager: gitStateManagerMock,
}));

import { workspaceGitInitializer } from './WorkspaceGitInitializer';

describe('WorkspaceGitInitializer startup refresh', () => {
  it('refreshes only the basic Git layer for the current workspace on startup', async () => {
    workspaceGitInitializer.start();
    await Promise.resolve();

    expect(gitStateManagerMock.refresh).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }, {
      layers: ['basic'],
      reason: 'mount',
      force: true,
      source: 'workspace_git_initializer',
    });
  });
});
