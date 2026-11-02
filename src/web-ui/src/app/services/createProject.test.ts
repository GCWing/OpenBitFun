import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';
import { createProject } from './createProject';
import type { WorkspaceInfo } from '@/shared/types';

const { createDirectory, openWorkspace, updateWorkspaceInfo, getSystemInfo, getServerInfo } = vi.hoisted(() => ({
  createDirectory: vi.fn(), openWorkspace: vi.fn(), updateWorkspaceInfo: vi.fn(),
  getSystemInfo: vi.fn(), getServerInfo: vi.fn(),
}));
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: { createDirectory }, systemAPI: { getSystemInfo } }));
vi.mock('@/features/ssh-remote/sshApi', () => ({ sshApi: { getServerInfo } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { openWorkspace, updateWorkspaceInfo } }));
const record = (extra = {}) => ({ id: 'project', name: 'frontend', rootPath: '/srv/frontend', ...extra } as WorkspaceInfo);

beforeEach(() => {
  vi.resetAllMocks();
  resetDeviceSurfaceForTest();
  openWorkspace.mockResolvedValue(record());
  getSystemInfo.mockResolvedValue({ platform: 'linux', homeDir: '/home/user' });
  getServerInfo.mockResolvedValue({ homeDir: '/home/remote' });
});
afterEach(() => resetDeviceSurfaceForTest());

describe('project composition', () => {
  it('uses the existing folder name for an unnamed single-folder project and tolerates legacy records', async () => {
    await expect(createProject({ name: '', folders: [{ path: '/srv/frontend' }] })).resolves.toBe(true);
    expect(openWorkspace).toHaveBeenCalledWith('/srv/frontend');
    expect(createDirectory).not.toHaveBeenCalled();
    expect(updateWorkspaceInfo).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects an assistant root instead of renaming it or reporting project success (remote=%s)', async remote => {
    openWorkspace.mockResolvedValue(record({ workspaceKind: 'assistant' }));
    const openRemote = vi.fn().mockResolvedValue(record({ workspaceKind: 'assistant' }));
    const folder = { path: '/srv/assistant', ...(remote ? { remote: { connectionId: 'ssh-1', connectionName: 'Host' } } : {}) };
    await expect(createProject({ name: 'New project', folders: [folder] }, openRemote))
      .rejects.toMatchObject({ name: 'AssistantProjectFolderError' });
    expect(updateWorkspaceInfo).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it('persists a unified name and associated folders together without discarding old associations', async () => {
    openWorkspace.mockResolvedValue(record({ relatedPaths: [{ path: '/srv/docs', description: 'Docs' }] }));
    await createProject({ name: '  Product  ', folders: [
      { path: '/srv/frontend' }, { path: '/srv/backend' }, { path: '/srv/backend/' }, { path: '/srv/docs' },
    ] });
    expect(updateWorkspaceInfo).toHaveBeenCalledOnce();
    expect(updateWorkspaceInfo).toHaveBeenCalledWith('project', {
      name: 'Product', relatedPaths: [{ path: '/srv/docs', description: 'Docs' }, { path: '/srv/backend' }],
    });
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['/home/user/', '/home/user/OpenBitFun/Projects/example'], ['/', '/OpenBitFun/Projects/example'],
    ['C:\\Users\\Person\\', 'C:/Users/Person/OpenBitFun/Projects/example'],
  ])('creates an empty project in the fixed directory for home %s', async (homeDir, expectedPath) => {
    getSystemInfo.mockResolvedValue({ homeDir });
    openWorkspace.mockResolvedValue(record({ name: 'example', rootPath: expectedPath }));
    await createProject({ name: 'example', folders: [] });
    expect(createDirectory).toHaveBeenCalledWith(expectedPath);
    expect(openWorkspace).toHaveBeenCalledWith(expectedPath);
    expect(updateWorkspaceInfo).not.toHaveBeenCalled();
  });

  it('does not reuse a created path after a device switch', async () => {
    createDirectory.mockImplementation(async () => { activateSurface(surfaceIdForDevice('another-host')); });
    await expect(createProject({ name: 'example', folders: [] })).rejects.toMatchObject({ name: 'SurfaceChangedError' });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('creates an empty SSH project on its chosen host without local fallback', async () => {
    const remote = { connectionId: 'ssh-1', connectionName: 'Host' };
    const draft = { name: 'example', folders: [], remote };
    await expect(createProject(draft)).rejects.toThrow('unavailable');
    expect(createDirectory).not.toHaveBeenCalled();
    const openRemote = vi.fn().mockResolvedValue(record({ name: 'example', rootPath: '/home/remote/OpenBitFun/Projects/example' }));
    await createProject(draft, openRemote);
    expect(getServerInfo).toHaveBeenCalledWith('ssh-1');
    expect(getSystemInfo).not.toHaveBeenCalled();
    expect(createDirectory).toHaveBeenCalledWith('/home/remote/OpenBitFun/Projects/example', 'ssh-1');
    expect(openRemote).toHaveBeenCalledWith({ path: '/home/remote/OpenBitFun/Projects/example', remote });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('does not apply associations after the active device changes while opening', async () => {
    openWorkspace.mockImplementation(async () => {
      activateSurface(surfaceIdForDevice('another-host'));
      return record();
    });
    await expect(createProject({ name: 'Product', folders: [{ path: '/srv/frontend' }, { path: '/srv/backend' }] })).rejects.toMatchObject({ name: 'SurfaceChangedError' });
    expect(updateWorkspaceInfo).not.toHaveBeenCalled();
  });

  it('keeps remote source paths on the selected connection and supports cancelling a rebind', async () => {
    const remote = { connectionId: 'ssh-1', connectionName: 'Build host' };
    const folders = [{ path: '/srv/frontend', remote }, { path: '/srv/backend', remote }];
    const openRemote = vi.fn().mockResolvedValue(null);
    await expect(createProject({ name: 'Product', folders }, openRemote)).resolves.toBe(false);
    expect(updateWorkspaceInfo).not.toHaveBeenCalled();
    openRemote.mockResolvedValue(record({ connectionId: 'ssh-1' }));
    await createProject({ name: 'Product', folders }, openRemote);
    expect(openRemote).toHaveBeenLastCalledWith(folders[0]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
    expect(updateWorkspaceInfo).toHaveBeenCalledWith('project', { name: 'Product', relatedPaths: [{ path: '/srv/backend' }] });
  });

  it('rejects mixed hosts and unnamed groups before opening anything', async () => {
    await expect(createProject({ name: 'Product', folders: [{ path: '/srv/a' }, { path: '/srv/b', remote: { connectionId: 'ssh-1', connectionName: 'Host' } }] })).rejects.toThrow('same host');
    await expect(createProject({ name: '', folders: [{ path: '/srv/a' }, { path: '/srv/b' }] })).rejects.toThrow('name is required');
    await expect(createProject({ name: '../outside', folders: [] })).rejects.toThrow('single folder name');
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it('keeps failed association updates retryable without creating another directory', async () => {
    updateWorkspaceInfo.mockRejectedValueOnce(new Error('Host offline')).mockResolvedValueOnce(record());
    const draft = { name: 'Product', folders: [{ path: '/srv/frontend' }, { path: '/srv/backend' }] };
    await expect(createProject(draft)).rejects.toThrow('Host offline');
    await expect(createProject(draft)).resolves.toBe(true);
    expect(updateWorkspaceInfo.mock.calls[0]).toEqual(updateWorkspaceInfo.mock.calls[1]);
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it('uses the peer home directory and fences a device switch during resolution', async () => {
    activateSurface(surfaceIdForDevice('peer'));
    getSystemInfo.mockResolvedValueOnce({ homeDir: '/home/peer' });
    await createProject({ name: 'example', folders: [] });
    expect(createDirectory).toHaveBeenCalledWith('/home/peer/OpenBitFun/Projects/example');
    createDirectory.mockClear();
    getSystemInfo.mockImplementationOnce(async () => {
      activateSurface(surfaceIdForDevice('other-peer'));
      return { homeDir: '/home/peer' };
    });
    await expect(createProject({ name: 'example', folders: [] })).rejects.toMatchObject({ name: 'SurfaceChangedError' });
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '~', 'relative/home'])('refuses missing or relative home directories from older hosts: %s', async homeDir => {
    getSystemInfo.mockResolvedValue({ platform: 'linux', homeDir });
    await expect(createProject({ name: 'example', folders: [] })).rejects.toMatchObject({ name: 'ProjectDirectoryUnavailableError' });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('never falls back to the current device when SSH home resolution is unavailable', async () => {
    getServerInfo.mockResolvedValue(null);
    await expect(createProject({ name: 'example', folders: [], remote: { connectionId: 'ssh-1', connectionName: 'Host' } }, vi.fn()))
      .rejects.toMatchObject({ name: 'ProjectDirectoryUnavailableError' });
    expect(getSystemInfo).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
  });
});
