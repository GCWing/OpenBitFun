// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitStateManager } from './GitStateManager';
import type { GitStateLayer } from './types';
import { globalEventBus } from '@/infrastructure/event-bus';

const workspaceCatalog = vi.hoisted(() => new Map<string, { workspaceKind: string; connectionId?: string }>());
const peerMode = vi.hoisted(() => ({ active: false }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({ openedWorkspaces: workspaceCatalog }) },
}));
vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => peerMode.active,
}));

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
    workspaceCatalog.clear();
    workspaceCatalog.set('workspace-1', { workspaceKind: 'normal' });
    workspaceCatalog.set('workspace-2', { workspaceKind: 'normal' });
    peerMode.active = false;
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

  it('keeps polling paused when another repository subscribes while hidden', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const addListener = vi.spyOn(document, 'addEventListener');
    const removeListener = vi.spyOn(document, 'removeEventListener');
    try {
      const unsubscribe = manager.registerPolling(repositoryPath);
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      const unsubscribeOther = manager.registerPolling({ workspaceId: 'workspace-2' });
      await vi.advanceTimersByTimeAsync(4100);
      expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
      const listeners = addListener.mock.calls.filter(([type]) => type === 'visibilitychange');
      expect(listeners).toHaveLength(1);

      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(100);
      expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(2);
      unsubscribe();
      unsubscribeOther();
      expect(removeListener).toHaveBeenCalledWith('visibilitychange', listeners[0][1]);
      await vi.advanceTimersByTimeAsync(4100);
      expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(2);
    } finally {
      hidden.mockRestore();
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it('does not start polling for an initially hidden document', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      manager.registerPolling(repositoryPath);
      await vi.advanceTimersByTimeAsync(4100);
      expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(100);
      expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
    }
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

  it('keeps passive subscriptions free of IO and reference-counts active demand', async () => {
    manager.subscribe(repositoryPath, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    const releaseA = manager.registerPolling(repositoryPath);
    const releaseB = manager.registerPolling(repositoryPath);
    releaseA();
    await vi.advanceTimersByTimeAsync(2100);
    expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(1);
    releaseB();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(1);
  });

  it('polls active SSH workspaces slowly and never broadcasts unchanged results', async () => {
    workspaceCatalog.set('workspace-1', { workspaceKind: 'remote', connectionId: 'ssh-a' });
    workspaceCatalog.set('workspace-2', { workspaceKind: 'remote', connectionId: 'ssh-b' });
    for (const workspaceId of ['workspace-1', 'workspace-2', 'workspace-3']) {
      manager.subscribe({ workspaceId }, () => {});
    }
    manager.registerPolling(repositoryPath);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(1);
    vi.mocked(globalEventBus.emit).mockClear();
    gitEventServiceMock.emit.mockClear();
    await vi.advanceTimersByTimeAsync(36_000);
    expect(gitApiMocks.getRepositoryBasic).toHaveBeenCalledTimes(2);
    expect(globalEventBus.emit).not.toHaveBeenCalled();
    expect(gitEventServiceMock.emit).not.toHaveBeenCalled();
    expect(gitApiMocks.getStatus).not.toHaveBeenCalled();
  });

  it('serializes background reads on one SSH connection without starving another repository', async () => {
    for (const workspaceId of ['workspace-1', 'workspace-2']) {
      workspaceCatalog.set(workspaceId, { workspaceKind: 'remote', connectionId: 'ssh-a' });
      manager.registerPolling({ workspaceId });
    }
    const read = deferred<any>();
    gitApiMocks.getRepositoryBasic.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
    read.resolve({ current_branch: 'main' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(2);
    expect(gitApiMocks.isGitRepository.mock.calls.map(([scope]) => scope.workspaceId))
      .toEqual(['workspace-1', 'workspace-2']);
  });

  it('backs off failures, allows immediate manual recovery and clears the visible error', async () => {
    workspaceCatalog.set('workspace-1', { workspaceKind: 'remote', connectionId: 'ssh-a' });
    const seen = vi.fn();
    manager.subscribe(repositoryPath, seen);
    manager.registerPolling(repositoryPath);
    gitApiMocks.isGitRepository.mockRejectedValueOnce(new Error('SSH disconnected'));
    await vi.advanceTimersByTimeAsync(30_100);
    expect(seen.mock.lastCall?.[0].error).toBe('SSH disconnected');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
    const retry = manager.refresh(repositoryPath, { layers: ['basic'], force: true });
    await vi.advanceTimersByTimeAsync(100);
    await retry;
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(2);
    expect(seen.mock.lastCall?.[0].error).toBeNull();
    await vi.advanceTimersByTimeAsync(33_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(3);
  });

  it('preserves peer-device polling suppression and uses conservative cadence without metadata', async () => {
    workspaceCatalog.clear();
    manager.registerPolling(repositoryPath);
    await vi.advanceTimersByTimeAsync(6000);
    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    peerMode.active = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    peerMode.active = false;
  });

  it('increases offline retry delays and caps them at five minutes', async () => {
    workspaceCatalog.set('workspace-1', { workspaceKind: 'remote', connectionId: 'ssh-a' });
    gitApiMocks.isGitRepository.mockRejectedValue(new Error('SSH disconnected'));
    manager.registerPolling(repositoryPath);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(242_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(302_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(302_000);
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(6);
  });

  it('cancels queued polling on deactivation but preserves a merged manual refresh', async () => {
    const release = manager.registerPolling(repositoryPath);
    await vi.advanceTimersByTimeAsync(2000);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    const releaseAgain = manager.registerPolling(repositoryPath);
    await vi.advanceTimersByTimeAsync(2000);
    const manual = manager.refresh(repositoryPath, { layers: ['basic'], force: true });
    releaseAgain();
    await vi.advanceTimersByTimeAsync(100);
    await manual;
    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(1);
  });

  it('drops a queued poll if the document becomes hidden during debounce', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    try {
      manager.registerPolling(repositoryPath);
      await vi.advanceTimersByTimeAsync(2000);
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(100);
      expect(gitApiMocks.isGitRepository).not.toHaveBeenCalled();
    } finally {
      hidden.mockRestore();
    }
  });

  it('notifies error recovery even when the branch and files stay unchanged', async () => {
    const first = manager.refresh(repositoryPath, { layers: ['basic'], force: true });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const seen = vi.fn();
    manager.subscribe(repositoryPath, seen, { immediate: false, layers: ['basic'] });
    gitApiMocks.isGitRepository.mockRejectedValueOnce(new Error('Offline'));
    const failed = manager.refresh(repositoryPath, { layers: ['basic'], force: true }).catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(seen.mock.lastCall?.[0].error).toBe('Offline');
    const recovered = manager.refresh(repositoryPath, { layers: ['basic'], force: true, silent: true });
    await vi.advanceTimersByTimeAsync(100);
    await recovered;
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.lastCall?.[0].error).toBeNull();
  });

  it('refreshes stale basic data on activation even with the default infinite TTL', async () => {
    manager.setCacheConfig({ basic: Infinity });
    const first = manager.refresh(repositoryPath, { layers: ['basic'], force: true });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    await vi.advanceTimersByTimeAsync(30_000);
    manager.registerPolling(repositoryPath);
    gitApiMocks.getRepositoryBasic.mockResolvedValueOnce({ current_branch: 'external-change' });
    const activate = manager.refresh(repositoryPath, { layers: ['basic'], reason: 'visibility' });
    await vi.advanceTimersByTimeAsync(100);
    await activate;
    expect(manager.getState(repositoryPath)?.currentBranch).toBe('external-change');
    expect(globalEventBus.emit).toHaveBeenLastCalledWith('git:state:changed',
      expect.objectContaining({ changedLayers: ['basic'] }));
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

/**
 * A manual checkout reaches the shared cache as a `branch:changed` event — both
 * the Git scene's branch list and the composer's branch picker emit it. These
 * tests pin the two properties that let every branch label read from one
 * variable: the write lands before any Git round trip, and it reaches
 * subscribers immediately.
 */
describe('GitStateManager branch switch propagation', () => {
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
    gitApiMocks.getStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });
    gitApiMocks.getBranches.mockResolvedValue([
      { name: 'main', current: true, remote: false, ahead: 0, behind: 0 },
      { name: 'feature', current: false, remote: false, ahead: 0, behind: 0 },
    ]);
    gitApiMocks.getCommits.mockResolvedValue([]);
  });

  afterEach(() => {
    manager.dispose();
    GitStateManager.resetInstance();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** The handler the manager registers for a completed checkout. */
  function branchChangedHandler(): (event: unknown) => void {
    const call = gitEventServiceMock.on.mock.calls.find(([type]) => type === 'branch:changed');
    if (!call) {
      throw new Error('branch:changed handler was not registered');
    }
    return call[1] as (event: unknown) => void;
  }

  function reportBranchChange(branchName: string): void {
    branchChangedHandler()({
      data: { repositoryPath, branch: { name: branchName }, timestamp: new Date() },
    });
  }

  async function primeState(): Promise<void> {
    const settled = manager
      .refresh(repositoryPath, { layers: ['basic', 'status', 'detailed'], force: true, reason: 'mount' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(100);
    const failure = await settled;
    if (failure) throw failure;
  }

  it('moves subscribers to the new branch before the refresh lands', async () => {
    await primeState();
    expect(manager.getState(repositoryPath)?.currentBranch).toBe('main');

    const seen: (string | null)[] = [];
    manager.subscribe(
      repositoryPath,
      state => { seen.push(state.currentBranch); },
      { layers: ['basic'], immediate: false },
    );

    // No Git call is made: the checkout report is the only input at this point.
    reportBranchChange('feature');

    expect(manager.getState(repositoryPath)?.currentBranch).toBe('feature');
    expect(seen).toEqual(['feature']);
  });

  it('moves the cached branch list marker without re-reading the repository', async () => {
    await primeState();
    gitApiMocks.getBranches.mockClear();

    reportBranchChange('feature');

    expect(manager.getState(repositoryPath)?.branches?.map(b => [b.name, b.current])).toEqual([
      ['main', false],
      ['feature', true],
    ]);
    expect(gitApiMocks.getBranches).not.toHaveBeenCalled();
  });

  // Git outranks the optimistic write: the reconciling refresh the same event
  // schedules replaces a value the host disagrees with.
  it('lets the reconciling refresh overwrite a branch Git reports differently', async () => {
    await primeState();

    reportBranchChange('feature');
    expect(manager.getState(repositoryPath)?.currentBranch).toBe('feature');

    await vi.advanceTimersByTimeAsync(100);

    expect(manager.getState(repositoryPath)?.currentBranch).toBe('main');
  });

  it('ignores a branch change report that carries no branch name', async () => {
    await primeState();

    branchChangedHandler()({ data: { repositoryPath, timestamp: new Date() } });

    expect(manager.getState(repositoryPath)?.currentBranch).toBe('main');
  });
});
