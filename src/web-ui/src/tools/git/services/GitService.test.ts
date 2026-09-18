import { describe, expect, it, vi, beforeEach } from 'vitest';
import { gitService } from './GitService';

const gitApiMocks = vi.hoisted(() => ({
  commit: vi.fn(),
  push: vi.fn(),
  resetFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getRepository: vi.fn(),
  getStatus: vi.fn(),
}));

const gitStateManagerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  gitAPI: gitApiMocks,
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

vi.mock('../state/GitStateManager', () => ({
  gitStateManager: gitStateManagerMock,
}));

const repositoryPath = { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/OpenBitFun' };

describe('GitService dangerous operation refresh guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitStateManagerMock.refresh.mockResolvedValue(undefined);
    gitApiMocks.commit.mockResolvedValue({ success: true });
    gitApiMocks.push.mockResolvedValue({ success: true });
    gitApiMocks.resetFiles.mockResolvedValue({ success: true });
  });

  it('forces a fresh basic/status refresh before committing', async () => {
    const order: string[] = [];
    gitStateManagerMock.refresh.mockImplementation(async () => {
      order.push('refresh');
    });
    gitApiMocks.commit.mockImplementation(async () => {
      order.push('commit');
      return { success: true };
    });

    await gitService.commit(repositoryPath, { message: 'test' });

    expect(order).toEqual(['refresh', 'commit']);
    expect(gitStateManagerMock.refresh).toHaveBeenCalledWith(repositoryPath, {
      force: true,
      layers: ['basic', 'status'],
      reason: 'operation',
      silent: true,
    });
  });

  it('forces a fresh basic/status refresh before push and reset operations', async () => {
    await gitService.push(repositoryPath);
    await gitService.resetFiles(repositoryPath, ['src/app.ts'], false);

    expect(gitStateManagerMock.refresh).toHaveBeenCalledTimes(2);
    expect(gitApiMocks.push).toHaveBeenCalledTimes(1);
    expect(gitApiMocks.resetFiles).toHaveBeenCalledTimes(1);
  });
});

// The negative cache is consulted before the call is even attempted, so what
// lands in it decides whether a repository can ever be read again this window.
describe('GitService non-repository cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('remembers a path that really is not a repository', async () => {
    const path = { workspaceId: 'D:/workspace/not-a-repo', repositoryPath: 'D:/workspace/not-a-repo' };
    gitApiMocks.getStatus.mockRejectedValue(new Error('not a git repository'));

    await expect(gitService.getStatus(path)).resolves.toBeNull();
    await expect(gitService.getStatus(path)).resolves.toBeNull();

    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('does not remember an ownership rejection as "not a repository"', async () => {
    // Caching it would outlive the trust decision the user is about to make,
    // and would hide the error the recovery flow keys off.
    const path = { workspaceId: 'D:/workspace/untrusted-repo', repositoryPath: 'D:/workspace/untrusted-repo' };
    gitApiMocks.getStatus.mockRejectedValue(
      new Error(`git_repository_untrusted: ${path.repositoryPath}`),
    );

    await expect(gitService.getStatus(path)).resolves.toBeNull();
    await expect(gitService.getStatus(path)).resolves.toBeNull();

    expect(gitApiMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps reprobing a repository the ownership gate blocked', async () => {
    const path = { workspaceId: 'D:/workspace/untrusted-probe', repositoryPath: 'D:/workspace/untrusted-probe' };
    gitApiMocks.isGitRepository.mockRejectedValue(
      new Error(`git_repository_untrusted: ${path.repositoryPath}`),
    );

    await expect(gitService.isGitRepository(path)).resolves.toBe(false);
    await expect(gitService.isGitRepository(path)).resolves.toBe(false);

    expect(gitApiMocks.isGitRepository).toHaveBeenCalledTimes(2);
  });
});

// A mutation's error string is rendered in the panel as-is. The stable code is
// for code to branch on, not for a person to read.
describe('GitService mutation ownership rejections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitStateManagerMock.refresh.mockResolvedValue(undefined);
  });

  it('names the wall when a local mutation throws the stable code', async () => {
    gitApiMocks.commit.mockRejectedValue(
      new Error(`git_repository_untrusted: ${repositoryPath.repositoryPath}`),
    );

    await expect(gitService.commit(repositoryPath, { message: 'test' })).resolves.toEqual({
      success: false,
      error: 'panels/git:trust.required',
    });
  });

  // The remote executor returns the failure rather than throwing it, so the
  // returned result needs the same translation as the thrown error.
  it('names the wall when a remote mutation returns the stable code', async () => {
    gitApiMocks.push.mockResolvedValue({
      success: false,
      error: `git_repository_untrusted: /srv/shared/repo`,
      data: { remoteExecution: true, exitCode: 128 },
    });

    await expect(gitService.push(repositoryPath)).resolves.toMatchObject({
      success: false,
      error: 'panels/git:trust.required',
      data: { remoteExecution: true, exitCode: 128 },
    });
  });

  it('leaves an ordinary mutation failure exactly as it came', async () => {
    gitApiMocks.push.mockResolvedValue({
      success: false,
      error: 'error: failed to push some refs',
    });

    await expect(gitService.push(repositoryPath)).resolves.toEqual({
      success: false,
      error: 'error: failed to push some refs',
    });

    gitApiMocks.resetFiles.mockRejectedValue(new Error('unable to write index'));
    await expect(gitService.resetFiles(repositoryPath, ['src/app.ts'])).resolves.toEqual({
      success: false,
      error: 'unable to write index',
    });
  });
});
