import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitAPI } from './GitAPI';

const workspace = { workspaceId: 'workspace-1' };

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GitAPI repository probe cache', () => {
  let gitAPI: GitAPI;

  beforeEach(() => {
    gitAPI = new GitAPI();
    invokeMock.mockReset();
  });

  it('deduplicates concurrent repository probes for the same path', async () => {
    const deferred = createDeferred<boolean>();
    invokeMock.mockReturnValueOnce(deferred.promise);

    const first = gitAPI.isGitRepository(workspace);
    const second = gitAPI.isGitRepository(workspace);

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('git_is_repository', {
      request: { workspaceId: 'workspace-1' },
    });

    deferred.resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('isolates two workspace IDs with the same filesystem path', async () => {
    invokeMock.mockResolvedValue(true);
    await gitAPI.isGitRepository({ workspaceId: 'first', repositoryPath: '/same/root' });
    await gitAPI.isGitRepository({ workspaceId: 'second', repositoryPath: '/same/root' });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('reuses a recent repository probe result for the same path', async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(true);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('drops a cached probe result once ownership trust is granted', async () => {
    invokeMock.mockResolvedValueOnce(false);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);

    invokeMock.mockResolvedValueOnce({
      state: 'trusted',
      repositoryPath: 'D:/workspace/OpenBitFun',
      alreadyTrusted: false,
      addedEntries: ['D:/workspace/OpenBitFun'],
      detail: null,
      manualCommand: null,
    });
    await gitAPI.trustRepository(workspace);

    invokeMock.mockResolvedValueOnce(true);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(true);
  });

  it('keeps stale or mirror display paths out of workspace routing and cache keys', async () => {
    invokeMock.mockResolvedValueOnce(false);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);
    const staleProjection = { ...workspace, repositoryPath: '/local/hidden/remote-session-store' };
    await expect(gitAPI.isGitRepository(staleProjection)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('git_is_repository', {
      request: { workspaceId: 'workspace-1' },
    });
    invokeMock.mockResolvedValueOnce({ state: 'trusted' });
    await gitAPI.trustRepository(staleProjection);
    expect(invokeMock).toHaveBeenLastCalledWith('git_trust_repository', {
      request: { workspaceId: 'workspace-1' },
    });
    invokeMock.mockResolvedValueOnce(true);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(true);
  });

  // The user runs the manual command in a terminal, or the repository's owner
  // fixes ownership. Nothing in this process granted anything, so the read-only
  // probe is the only place that learns — and the stale `false` it leaves behind
  // fails the very retry the recovery just decided was worth making.
  it('drops a cached probe result once the read-only probe reports trust', async () => {
    invokeMock.mockResolvedValueOnce(false);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);

    invokeMock.mockResolvedValueOnce({
      state: 'trusted',
      repositoryPath: 'D:/workspace/OpenBitFun',
      detail: null,
      manualCommand: null,
    });
    await gitAPI.getRepositoryTrust(workspace);

    invokeMock.mockResolvedValueOnce(true);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(true);
  });

  it('keeps the cached probe result while the probe still reports the wall', async () => {
    invokeMock.mockResolvedValueOnce(false);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);

    invokeMock.mockResolvedValueOnce({
      state: 'trust_required',
      repositoryPath: 'D:/workspace/OpenBitFun',
      detail: 'detected dubious ownership',
      manualCommand: "git config --global --add safe.directory 'D:/workspace/OpenBitFun'",
    });
    await gitAPI.getRepositoryTrust(workspace);

    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached probe result when trust was not granted', async () => {
    invokeMock.mockResolvedValueOnce(false);
    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);

    invokeMock.mockResolvedValueOnce({
      state: 'trust_required',
      repositoryPath: 'D:/workspace/OpenBitFun',
      alreadyTrusted: false,
      addedEntries: [],
      detail: 'detected dubious ownership',
      manualCommand: 'git config --global --add safe.directory "D:/workspace/OpenBitFun"',
    });
    await gitAPI.trustRepository(workspace);

    await expect(gitAPI.isGitRepository(workspace)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
