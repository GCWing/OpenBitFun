import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitStateManager } from './GitStateManager';
import type { GitStateLayer } from './types';

const gitApiMocks = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  getRepositoryBasic: vi.fn(),
  getRepository: vi.fn(),
  getStatus: vi.fn(),
  getBranches: vi.fn(),
  getCommits: vi.fn(),
  getRepositoryTrust: vi.fn(),
}));

const gitEventServiceMock = vi.hoisted(() => ({
  on: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  gitAPI: gitApiMocks,
}));

vi.mock('../services/GitEventService', () => ({
  gitEventService: gitEventServiceMock,
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: vi.fn(),
  },
}));

vi.mock('@/shared/utils/debugProbe', () => ({
  sendDebugProbe: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const repositoryPath = { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/OpenBitFun' };

describe('GitStateManager refresh performance guards', () => {
  let manager: GitStateManager;

  beforeEach(() => {
    vi.useFakeTimers();
    GitStateManager.resetInstance();
    manager = GitStateManager.getInstance();
    manager.setCacheConfig({ basic: 0, status: 0, detailed: 0 });

    gitApiMocks.isGitRepository.mockResolvedValue(true);
    gitApiMocks.getRepositoryBasic.mockResolvedValue({
      path: repositoryPath.repositoryPath,
      name: 'OpenBitFun',
      current_branch: 'main',
      is_bare: false,
      has_changes: false,
      remotes: [],
    });
    gitApiMocks.getRepository.mockResolvedValue({
      path: repositoryPath.repositoryPath,
      name: 'OpenBitFun',
      current_branch: 'main',
      is_bare: false,
      has_changes: true,
      remotes: ['origin'],
    });
    gitApiMocks.getStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });
  });

  afterEach(() => {
    manager.dispose();
    GitStateManager.resetInstance();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('refreshes the basic layer without fetching full status', async () => {
    const refresh = manager.refresh(repositoryPath, {
      layers: ['basic'],
      force: true,
      reason: 'mount',
    });

    await vi.advanceTimersByTimeAsync(100);
    await refresh;

    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
    expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(1);
    expect(gitApiMocks.getRepository).not.toHaveBeenCalled();
    expect(gitApiMocks.getStatus).not.toHaveBeenCalled();
    expect(manager.getState(repositoryPath)).toMatchObject({
      isRepository: true,
      currentBranch: 'main',
      hasChanges: false,
    });
  });

  it('merges duplicate mount refreshes for the same repository and layer', async () => {
    const first = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      reason: 'mount',
    });
    const second = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      reason: 'mount',
    });

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);

    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('cancels pending refreshes by merged source token before debounce execution', async () => {
    const first = manager.refresh(repositoryPath, {
      layers: ['basic'],
      reason: 'mount',
      source: 'workspace_git_initializer',
    });
    const second = manager.refresh(repositoryPath, {
      layers: ['basic'],
      reason: 'mount',
      source: 'workspace_item_git_basic_info',
    });

    expect(manager.cancelPendingRefresh(repositoryPath, {
      layers: ['basic'],
      reason: 'mount',
      source: 'workspace_item_git_basic_info',
    })).toBe(true);

    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(100);

    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    expect(gitApiMocks.getRepositoryBasic).not.toHaveBeenCalled();
  });

  it('does not run force refresh concurrently with an in-flight refresh', async () => {
    const firstStatus = deferred<Awaited<ReturnType<typeof gitApiMocks.getStatus>>>();
    gitApiMocks.getStatus
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce({
        staged: [],
        unstaged: [{ path: 'changed.ts', status: 'modified' }],
        untracked: [],
        conflicts: [],
        current_branch: 'main',
        ahead: 0,
        behind: 0,
      });

    const first = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      force: true,
      reason: 'mount',
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(1);

    const forced = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      force: true,
      reason: 'operation',
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(1);

    firstStatus.resolve({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });

    await first;
    await forced;
    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it('propagates an in-flight refresh failure to non-force joiners', async () => {
    const firstStatus = deferred<Awaited<ReturnType<typeof gitApiMocks.getStatus>>>();
    const failure = new Error('status failed');
    gitApiMocks.getStatus.mockReturnValueOnce(firstStatus.promise);

    const first = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      force: true,
      reason: 'mount',
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    const second = manager.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      reason: 'mount',
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    firstStatus.reject(failure);

    await expect(first).rejects.toThrow('status failed');
    await expect(second).rejects.toThrow('status failed');
    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('GitStateManager ownership trust', () => {
  let manager: GitStateManager;

  const untrustedError = () =>
    new Error(`git_repository_untrusted: ${repositoryPath.repositoryPath}`);

  beforeEach(() => {
    vi.useFakeTimers();
    GitStateManager.resetInstance();
    manager = GitStateManager.getInstance();
    manager.setCacheConfig({ basic: 0, status: 0, detailed: 0 });

    // The probe answers `true` for a repository Git refuses on ownership
    // grounds: it exists, Git just will not operate on it.
    gitApiMocks.isGitRepository.mockResolvedValue(true);
    gitApiMocks.getStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });
    gitApiMocks.getBranches.mockResolvedValue([]);
    gitApiMocks.getCommits.mockResolvedValue([]);
    // A host too old to answer the read-only probe is the default here; the
    // tests that rely on it opt in.
    gitApiMocks.getRepositoryTrust.mockRejectedValue(new Error('unknown command'));
  });

  afterEach(() => {
    manager.dispose();
    GitStateManager.resetInstance();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Drives one refresh to completion. The outcome is captured before the fake
   * timers advance: the refresh settles inside that window, and a rejection
   * with no handler attached yet surfaces as an unhandled rejection.
   */
  async function runRefresh(layers: GitStateLayer[]): Promise<void> {
    const settled = manager
      .refresh(repositoryPath, { layers, force: true, reason: 'manual' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(100);
    const failure = await settled;
    if (failure) {
      throw failure;
    }
  }

  const refreshBasicAndStatus = () => runRefresh(['basic', 'status']);

  it('records the ownership wall when a status read hits it', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(untrustedError());

    await expect(refreshBasicAndStatus()).rejects.toThrow('git_repository_untrusted');

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: true,
    });
  });

  // The state a host or device switch leaves behind: a successful refresh set
  // `isRepository`, and the ownership rejection that follows does not clear it.
  // The panel must key its trust view off the flag, not off `!isRepository`.
  it('keeps the wall visible after the repository already loaded once', async () => {
    await refreshBasicAndStatus();
    expect(manager.getState(repositoryPath)).toMatchObject({
      isRepository: true,
      repositoryTrustRequired: false,
    });

    gitApiMocks.getStatus.mockRejectedValueOnce(untrustedError());
    await expect(refreshBasicAndStatus()).rejects.toThrow('git_repository_untrusted');

    expect(manager.getState(repositoryPath)).toMatchObject({
      isRepository: true,
      repositoryTrustRequired: true,
    });
  });

  // A detailed-only refresh never reaches the ownership gate — it swallows its
  // own failures into empty arrays — so its success is not evidence that trust
  // is no longer required.
  it('does not let a detailed-only refresh clear the wall', async () => {
    await refreshBasicAndStatus();
    gitApiMocks.getStatus.mockRejectedValueOnce(untrustedError());
    await expect(refreshBasicAndStatus()).rejects.toThrow('git_repository_untrusted');

    gitApiMocks.getBranches.mockRejectedValueOnce(untrustedError());
    gitApiMocks.getCommits.mockRejectedValueOnce(untrustedError());
    await runRefresh(['detailed']);

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: true,
    });
  });

  // A dropped SSH connection is the realistic case: the wall is up, the next
  // automatic refresh fails on transport, and clearing the flag would leave
  // `isRepository: false` behind — the "initialize a repository" screen over a
  // repository that exists and is merely blocked.
  it('keeps the wall through an unrelated failure', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(untrustedError());
    await expect(refreshBasicAndStatus()).rejects.toThrow('git_repository_untrusted');

    gitApiMocks.isGitRepository.mockRejectedValueOnce(new Error('ssh: connection closed'));
    await expect(refreshBasicAndStatus()).rejects.toThrow('ssh: connection closed');

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: true,
    });
  });

  // Not every execution domain classifies the rejection. The CLI peer answers
  // the trust probe but has no `git_get_status`, so its refresh fails with
  // ordinary prose — and without the probe the wall would stay invisible and
  // the Trust button would never appear on a controller talking to that peer.
  it('consults the trust probe when the failure cannot classify itself', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('unsupported command: git_get_status'));
    gitApiMocks.getRepositoryTrust.mockResolvedValueOnce({
      state: 'trust_required',
      repositoryPath,
      detail: 'detected dubious ownership',
      manualCommand: `git config --global --add safe.directory '${repositoryPath.repositoryPath}'`,
    });

    await expect(refreshBasicAndStatus()).rejects.toThrow('unsupported command');

    expect(gitApiMocks.getRepositoryTrust).toHaveBeenCalledWith(repositoryPath);
    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: true,
      error: 'panels/git:trust.required',
    });
  });

  // A failure we cannot explain must not be dressed up as an ownership wall:
  // that shows a Trust button whose grant cannot fix anything, and hides the
  // real error behind it.
  it('leaves an unrelated failure unexplained when the probe says trust is fine', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('ssh: connection closed'));
    gitApiMocks.getRepositoryTrust.mockResolvedValueOnce({
      state: 'trusted',
      repositoryPath,
      detail: null,
      manualCommand: null,
    });

    await expect(refreshBasicAndStatus()).rejects.toThrow('ssh: connection closed');

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: false,
      error: 'ssh: connection closed',
    });
  });

  // The way out for an execution domain whose status read can never succeed.
  // The CLI peer has no `git_get_status`, so "refresh until it works" is not a
  // path back: the user fixes ownership over there, and the only thing that can
  // learn it is the probe. Without this the panel stays on the Trust screen for
  // a repository Git already accepts.
  it('drops the wall when the probe reports trust after it was raised', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('unsupported command: git_get_status'));
    gitApiMocks.getRepositoryTrust.mockResolvedValueOnce({
      state: 'trust_required',
      repositoryPath,
      detail: 'detected dubious ownership',
      manualCommand: `git config --global --add safe.directory ${repositoryPath.repositoryPath}`,
    });
    await expect(refreshBasicAndStatus()).rejects.toThrow('unsupported command');
    expect(manager.getState(repositoryPath)).toMatchObject({ repositoryTrustRequired: true });

    // Same unsupported status read as before — nothing about this domain has
    // changed except Git's answer over on the peer.
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('unsupported command: git_get_status'));
    gitApiMocks.getRepositoryTrust.mockResolvedValueOnce({
      state: 'trusted',
      repositoryPath,
      detail: null,
      manualCommand: null,
    });

    await expect(refreshBasicAndStatus()).rejects.toThrow('unsupported command');

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: false,
      error: 'unsupported command: git_get_status',
    });
  });

  // The other half: a probe that could not answer says nothing about trust, so
  // a wall raised earlier stays up rather than collapsing on a transport error.
  it('keeps the wall when the probe itself cannot answer', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('unsupported command: git_get_status'));
    gitApiMocks.getRepositoryTrust.mockResolvedValueOnce({
      state: 'trust_required',
      repositoryPath,
      detail: 'detected dubious ownership',
      manualCommand: `git config --global --add safe.directory ${repositoryPath.repositoryPath}`,
    });
    await expect(refreshBasicAndStatus()).rejects.toThrow('unsupported command');

    // Default mock: the probe rejects, as it would on a dropped connection.
    gitApiMocks.getStatus.mockRejectedValueOnce(new Error('unsupported command: git_get_status'));
    await expect(refreshBasicAndStatus()).rejects.toThrow('unsupported command');

    expect(manager.getState(repositoryPath)).toMatchObject({
      repositoryTrustRequired: true,
    });
  });

  it('clears the wall once a status read succeeds again', async () => {
    gitApiMocks.getStatus.mockRejectedValueOnce(untrustedError());
    await expect(refreshBasicAndStatus()).rejects.toThrow('git_repository_untrusted');

    await refreshBasicAndStatus();

    expect(manager.getState(repositoryPath)).toMatchObject({
      isRepository: true,
      repositoryTrustRequired: false,
    });
  });
});
