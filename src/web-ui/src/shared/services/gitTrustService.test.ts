import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';
import {
  describeGitTrustFailure,
  requestGitRepositoryTrust,
  resetGitTrustDecisions,
  withGitRepositoryTrustRecovery,
} from './gitTrustService';

const confirmWarningMock = vi.hoisted(() => vi.fn());
const trustRepositoryMock = vi.hoisted(() => vi.fn());
const getRepositoryTrustMock = vi.hoisted(() => vi.fn());
const warningMock = vi.hoisted(() => vi.fn());
const successMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmWarning: confirmWarningMock,
}));

vi.mock('@/infrastructure/api', () => ({
  gitAPI: {
    trustRepository: trustRepositoryMock,
    getRepositoryTrust: getRepositoryTrustMock,
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    warning: warningMock,
    success: successMock,
  },
}));

const REPOSITORY_PATH = 'D:/workspace/project/OpenBitFun';

function untrustedError(repositoryPath = REPOSITORY_PATH): TauriCommandError {
  return new TauriCommandError('Command failed', {
    command: 'git_get_status',
    originalError: `git_repository_untrusted: ${repositoryPath}`,
  });
}

function grantedOutcome() {
  return {
    state: 'trusted',
    repositoryPath: REPOSITORY_PATH,
    alreadyTrusted: false,
    addedEntries: [REPOSITORY_PATH],
    detail: null,
    manualCommand: null,
  };
}

beforeEach(() => {
  resetGitTrustDecisions();
  confirmWarningMock.mockReset();
  trustRepositoryMock.mockReset();
  getRepositoryTrustMock.mockReset();
  getRepositoryTrustMock.mockRejectedValue(new Error('probe not stubbed'));
  warningMock.mockReset();
  successMock.mockReset();
});

describe('describeGitTrustFailure', () => {
  it('turns the stable repository trust code into localized copy', () => {
    expect(describeGitTrustFailure(untrustedError())).toBe(
      `panels/git:trust.required|${JSON.stringify({ path: REPOSITORY_PATH })}`,
    );
  });

  it('leaves unrelated failures to the calling surface', () => {
    expect(describeGitTrustFailure(new Error('provider unavailable'))).toBeUndefined();
  });
});

describe('requestGitRepositoryTrust', () => {
  it('grants trust only after the user confirms', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(true);
    expect(trustRepositoryMock).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
  });

  it('writes nothing when the user declines', async () => {
    confirmWarningMock.mockResolvedValue(false);

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);
    expect(trustRepositoryMock).not.toHaveBeenCalled();
  });

  it('asks once for a burst of callers on the same repository', async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmWarningMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    const first = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    const second = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    resolveConfirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
    expect(trustRepositoryMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask again in the quiet period after a decline', async () => {
    confirmWarningMock.mockResolvedValue(false);

    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);

    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask again in the quiet period after a failed grant', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(new Error('config is read-only'));

    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);

    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
    expect(trustRepositoryMock).toHaveBeenCalledTimes(1);
  });

  // The Trust button is visible and enabled after a failure. Returning false
  // without a dialog would read as a dead button, and would strand a user who
  // just fixed safe.directory in a terminal or reconnected a remote host.
  it('answers an explicit user request during the quiet period', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValueOnce(new Error('config is read-only'));

    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);

    trustRepositoryMock.mockResolvedValueOnce(grantedOutcome());
    await expect(
      requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH }, { userInitiated: true }),
    ).resolves.toBe(true);
    expect(confirmWarningMock).toHaveBeenCalledTimes(2);
  });

  it('still absorbs the automatic burst that follows a user request', async () => {
    confirmWarningMock.mockResolvedValue(false);

    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH }, { userInitiated: true });
    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);

    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes a burst across Windows spellings of one repository', async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmWarningMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    const first = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project/OpenBitFun' });
    const second = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: 'd:\\workspace\\project\\OpenBitFun' });
    resolveConfirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
    expect(trustRepositoryMock).toHaveBeenCalledTimes(1);
  });

  // The backend folds the whole path on Windows (`safe_directory_entry_matches`),
  // so a key that folded only the drive letter prompted twice for one entry.
  it('dedupes a burst across the case of a Windows path', async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmWarningMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    const first = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: 'D:/Workspace/Project/OpenBitFun' });
    const second = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: 'd:/workspace/project/openbitfun' });
    resolveConfirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  // A share mounted from another machine is the classic way a Windows folder
  // ends up owned by someone else, so UNC is a likely spelling here, not a rare one.
  it('dedupes a burst across the case of a UNC path', async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmWarningMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    const first = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: '\\\\Build01\\Shared\\OpenBitFun' });
    const second = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: '//build01/shared/openbitfun' });
    resolveConfirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  // The backend drops the trailing separator before comparing, so a key that
  // kept it made one repository two and prompted a second time in one burst.
  it('dedupes a burst across a trailing separator', async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmWarningMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    trustRepositoryMock.mockResolvedValue(grantedOutcome());

    const first = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: '/srv/shared/repo' });
    const second = requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: '/srv/shared/repo/' });
    resolveConfirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  it('keeps case-sensitive POSIX paths apart', async () => {
    confirmWarningMock.mockResolvedValue(false);

    await requestGitRepositoryTrust({ workspaceId: '/srv/Repo', repositoryPath: '/srv/Repo' });
    await requestGitRepositoryTrust({ workspaceId: '/srv/repo', repositoryPath: '/srv/repo' });

    expect(confirmWarningMock).toHaveBeenCalledTimes(2);
  });

  it('hands over the manual command when trust could not be applied', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockResolvedValue({
      state: 'trust_required',
      repositoryPath: REPOSITORY_PATH,
      alreadyTrusted: false,
      addedEntries: [],
      detail: 'detected dubious ownership',
      manualCommand: `git config --global --add safe.directory "${REPOSITORY_PATH}"`,
    });

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);
    expect(warningMock).toHaveBeenCalledTimes(1);
    expect(warningMock.mock.calls[0][0]).toContain('trust.unavailableWithCommand');
    expect(warningMock.mock.calls[0][0]).toContain('safe.directory');
  });

  it('reports a failed trust command instead of claiming success', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(new Error('config is read-only'));

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);
    expect(warningMock).toHaveBeenCalledTimes(1);
  });

  // A peer host denies granting on purpose. The read-only probe still answers
  // there, so the controller must end up showing the command instead of a
  // dead end.
  it('falls back to the read-only probe for the command when granting is refused', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(
      new Error("command 'git_trust_repository' is local-only and cannot run on peer"),
    );
    getRepositoryTrustMock.mockResolvedValue({
      state: 'trust_required',
      repositoryPath: REPOSITORY_PATH,
      detail: 'detected dubious ownership',
      manualCommand: `git config --global --add safe.directory "${REPOSITORY_PATH}"`,
    });

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);
    expect(getRepositoryTrustMock).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    expect(warningMock.mock.calls[0][0]).toContain('trust.unavailableWithCommand');
    expect(warningMock.mock.calls[0][0]).toContain('safe.directory');
  });

  // The manual command exists to be run. Once the user (or the owner of the
  // repository) has run it, the wall is down — reporting "could not be granted"
  // and answering `false` would strand a repository that already works.
  it('treats a repository fixed outside the product as recovered', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(
      new Error("command 'git_trust_repository' is local-only and cannot run on peer"),
    );
    getRepositoryTrustMock.mockResolvedValue({
      state: 'trusted',
      repositoryPath: REPOSITORY_PATH,
      detail: null,
      manualCommand: null,
    });

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(true);
    expect(warningMock).not.toHaveBeenCalled();
    expect(successMock).toHaveBeenCalledTimes(1);
    expect(successMock.mock.calls[0][0]).toContain('trust.alreadyTrusted');
  });

  // ...and the recovery it reports must be a real one: the next automatic call
  // gets a fresh prompt rather than the quiet period a failure would have set.
  it('does not silence the next caller after recovering outside the product', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValueOnce(new Error('config is read-only'));
    getRepositoryTrustMock.mockResolvedValue({
      state: 'trusted',
      repositoryPath: REPOSITORY_PATH,
      detail: null,
      manualCommand: null,
    });

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(true);

    trustRepositoryMock.mockResolvedValueOnce(grantedOutcome());
    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(true);
    expect(confirmWarningMock).toHaveBeenCalledTimes(2);
  });

  it('still reports the wall when the host is too old to answer the probe', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(new Error('unknown command'));
    getRepositoryTrustMock.mockRejectedValue(new Error('unknown command'));

    await expect(requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe(false);
    expect(warningMock).toHaveBeenCalledTimes(1);
    expect(warningMock.mock.calls[0][0]).toContain('trust.unavailable');
  });
});

describe('withGitRepositoryTrustRecovery', () => {
  it('replays the operation once after trust is granted', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockResolvedValue(grantedOutcome());
    const operation = vi
      .fn()
      .mockRejectedValueOnce(untrustedError())
      .mockResolvedValueOnce('status');

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe('status');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('surfaces the original error when the user declines', async () => {
    confirmWarningMock.mockResolvedValue(false);
    const error = untrustedError();
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not loop when the repository stays untrusted after a grant', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockResolvedValue(grantedOutcome());
    const error = untrustedError();
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  // The quiet period absorbs a burst of automatic Git reads. It must not answer
  // a deliberate launch with a silent refusal plus an error telling the user to
  // trust the folder "when prompted".
  it('still prompts a user-initiated recovery during the quiet period', async () => {
    confirmWarningMock.mockResolvedValue(false);
    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);

    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockResolvedValue(grantedOutcome());
    const operation = vi
      .fn()
      .mockRejectedValueOnce(untrustedError())
      .mockResolvedValueOnce('status');

    await expect(
      withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH }, { userInitiated: true }),
    ).resolves.toBe('status');
    expect(confirmWarningMock).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for an automatic recovery during the quiet period', async () => {
    confirmWarningMock.mockResolvedValue(false);
    await requestGitRepositoryTrust({ workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH });

    const error = untrustedError();
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).rejects.toBe(error);
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
  });

  // The whole point of handing over a manual command on a host that cannot
  // grant: the user runs it, comes back, and the operation goes through.
  it('replays after the user fixed trust in a terminal', async () => {
    confirmWarningMock.mockResolvedValue(true);
    trustRepositoryMock.mockRejectedValue(new Error('config is read-only'));
    getRepositoryTrustMock.mockResolvedValue({
      state: 'trusted',
      repositoryPath: REPOSITORY_PATH,
      detail: null,
      manualCommand: null,
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(untrustedError())
      .mockResolvedValueOnce('status');

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).resolves.toBe('status');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('leaves every other failure untouched', async () => {
    const error = new Error('not a git repository');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withGitRepositoryTrustRecovery(operation, { workspaceId: 'workspace-1', repositoryPath: REPOSITORY_PATH })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(confirmWarningMock).not.toHaveBeenCalled();
  });
});
