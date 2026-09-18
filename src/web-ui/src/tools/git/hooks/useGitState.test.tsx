/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitState } from './useGitState';

const gitStateManagerMock = vi.hoisted(() => ({
  getState: vi.fn(() => null),
  subscribe: vi.fn(() => vi.fn()),
  registerWindowFocusRefresh: vi.fn(() => vi.fn()),
  refresh: vi.fn(() => Promise.resolve()),
  cancelPendingRefresh: vi.fn(() => false),
}));

vi.mock('../state/GitStateManager', () => ({
  gitStateManager: gitStateManagerMock,
}));

vi.mock('@/shared/utils/debugProbe', () => ({
  sendDebugProbe: vi.fn(),
}));

function GitStateHarness({
  isActive,
  refreshOnMount = true,
  cancelPendingRefreshSources,
}: {
  isActive: boolean;
  refreshOnMount?: boolean;
  cancelPendingRefreshSources?: string[];
}): null {
  useGitState({
    repositoryPath: { workspaceId: 'workspace-1' },
    isActive,
    refreshOnMount,
    refreshOnActive: true,
    layers: ['basic', 'status'],
    cancelPendingRefreshSources,
  });
  return null;
}

describe('useGitState visibility refresh', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('does not refresh inactive consumers on first mount and refreshes when activated', async () => {
    await act(async () => {
      root.render(<GitStateHarness isActive={false} />);
    });

    expect(gitStateManagerMock.refresh).not.toHaveBeenCalled();
    expect(gitStateManagerMock.registerWindowFocusRefresh).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<GitStateHarness isActive />);
    });

    expect(gitStateManagerMock.refresh).toHaveBeenCalledTimes(1);
    expect(gitStateManagerMock.refresh).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1' },
      {
        layers: ['basic', 'status'],
        reason: 'visibility',
        source: 'use_git_state',
      },
    );
    expect(gitStateManagerMock.registerWindowFocusRefresh).toHaveBeenCalledTimes(1);
  });

  it('cancels and replays active automatic refreshes when mount refresh is temporarily suppressed', async () => {
    await act(async () => {
      root.render(<GitStateHarness isActive refreshOnMount />);
    });

    expect(gitStateManagerMock.refresh).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1' },
      {
        layers: ['basic', 'status'],
        reason: 'mount',
        source: 'use_git_state',
      },
    );

    vi.clearAllMocks();

    await act(async () => {
      root.render(
        <GitStateHarness
          isActive
          refreshOnMount={false}
          cancelPendingRefreshSources={['workspace_git_initializer']}
        />,
      );
    });

    expect(gitStateManagerMock.cancelPendingRefresh).toHaveBeenCalledTimes(4);
    for (const reason of ['mount', 'visibility']) {
      expect(gitStateManagerMock.cancelPendingRefresh).toHaveBeenCalledWith(
        { workspaceId: 'workspace-1' },
        {
          layers: ['basic', 'status'],
          reason,
          source: 'use_git_state',
        },
      );
      expect(gitStateManagerMock.cancelPendingRefresh).toHaveBeenCalledWith(
        { workspaceId: 'workspace-1' },
        {
          layers: ['basic', 'status'],
          reason,
          source: 'workspace_git_initializer',
        },
      );
    }
    expect(gitStateManagerMock.refresh).not.toHaveBeenCalled();

    vi.clearAllMocks();

    await act(async () => {
      root.render(<GitStateHarness isActive refreshOnMount />);
    });

    expect(gitStateManagerMock.refresh).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1' },
      {
        layers: ['basic', 'status'],
        reason: 'visibility',
        source: 'use_git_state',
      },
    );
  });
});
