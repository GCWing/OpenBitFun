// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAPI } from '@/infrastructure/api';
import { useWorkspaceSearchIndex } from './useWorkspaceSearchIndex';

vi.mock('@/infrastructure/api', () => ({
  workspaceAPI: {
    getSearchRepoStatus: vi.fn(),
    buildSearchIndex: vi.fn(),
    rebuildSearchIndex: vi.fn(),
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('workspace search availability', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['local-workspace-id', 'remote-workspace-id'])('ignores an existing enabled preference for %s', async (workspaceId) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    let result: ReturnType<typeof useWorkspaceSearchIndex>;
    function Probe() {
      result = useWorkspaceSearchIndex({ workspaceId, enabled: true, isRemote: true });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    try {
      expect(result!.supported).toBe(false);
      await act(async () => {
        expect(await result!.refreshStatus()).toBeNull();
        expect(await result!.buildIndex()).toBeNull();
        expect(await result!.rebuildIndex()).toBeNull();
      });
      expect(workspaceAPI.getSearchRepoStatus).not.toHaveBeenCalled();
      expect(workspaceAPI.buildSearchIndex).not.toHaveBeenCalled();
      expect(workspaceAPI.rebuildSearchIndex).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it('polls an enabled local workspace', async () => {
    vi.mocked(workspaceAPI.getSearchRepoStatus).mockResolvedValue({ repoStatus: {} } as never);
    const host = document.createElement('div');
    const root = createRoot(host);
    function Probe() {
      useWorkspaceSearchIndex({ workspaceId: 'local-workspace-id', enabled: true });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    try {
      expect(workspaceAPI.getSearchRepoStatus).toHaveBeenCalledWith('local-workspace-id');
    } finally {
      await act(async () => root.unmount());
    }
  });

});
