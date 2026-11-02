import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { SessionAPI } from './SessionAPI';

const invokeMock = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ desktop: true }));

vi.mock('./ApiClient', () => ({ api: { invoke: invokeMock } }));
vi.mock('@/infrastructure/runtime/environment', () => ({
  isTauriRuntime: () => runtime.desktop,
}));

describe('Session storage directory access', () => {
  const sessionAPI = new SessionAPI();

  beforeEach(() => {
    invokeMock.mockReset();
    runtime.desktop = true;
    activateSurface('local');
  });

  it.each(['local-project', 'remote-project', 'assistant-project', 'worktree-project'])(
    'asks the host to resolve %s storage by identity without supplying an execution path',
    async workspaceId => {
      await sessionAPI.revealStorageDirectory(workspaceId);
      expect(invokeMock).toHaveBeenCalledWith('reveal_session_storage_directory', {
        request: { workspace_id: workspaceId, session_id: undefined },
      });
      invokeMock.mockReset();
      await sessionAPI.revealStorageDirectory(workspaceId, 'session-1');
      expect(invokeMock).toHaveBeenCalledWith('reveal_session_storage_directory', {
        request: { workspace_id: workspaceId, session_id: 'session-1' },
      });
    },
  );

  it('refuses peer storage even when workspace and session IDs collide with local records', async () => {
    activateSurface('peer-device');
    expect(sessionAPI.canRevealStorageDirectory()).toBe(false);
    await expect(sessionAPI.revealStorageDirectory('local-project', 'session-1'))
      .rejects.toThrow('local desktop');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('refuses browser access to a host file manager', async () => {
    runtime.desktop = false;
    expect(sessionAPI.canRevealStorageDirectory()).toBe(false);
    await expect(sessionAPI.revealStorageDirectory('workspace-1')).rejects.toThrow('local desktop');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('requires explicit identities and surfaces a missing stored session', async () => {
    await expect(sessionAPI.revealStorageDirectory('')).rejects.toThrow('Workspace ID');
    await expect(sessionAPI.revealStorageDirectory('workspace-1', '')).rejects.toThrow('Session ID');
    expect(invokeMock).not.toHaveBeenCalled();
    invokeMock.mockRejectedValueOnce('The session has no stored directory in this workspace');
    await expect(sessionAPI.revealStorageDirectory('workspace-1', 'session-1'))
      .rejects.toThrow('The session has no stored directory in this workspace');
  });
});
