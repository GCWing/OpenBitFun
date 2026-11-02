import { describe, expect, it } from 'vitest';
import {
  createTauriCommandError,
  gitRepositoryUntrustedPath,
  isGitRepositoryNotFoundError,
  isGitRepositoryUntrustedError,
  isNotAvailableError,
  isOutcomeUnknownError,
  isRemoteWorkspaceConnectionConflictError,
  isSessionInUseError,
  remoteWorkspaceConnectionConflictOwner,
  TauriCommandError,
} from './TauriCommandError';
import { SurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

it('preserves device cancellation through command error translation', () => {
  const cancellation = new SurfaceChangedError('peer', 4, 'list_sessions');
  expect(createTauriCommandError('list_sessions', cancellation)).toBe(cancellation);
});

describe('isGitRepositoryNotFoundError', () => {
  const legacyError = "Failed to get Git status: Repository not found: could not find repository at '/workspace'; class=Repository (6); code=NotFound (-3)";

  it.each([
    legacyError,
    new TauriCommandError(legacyError, {
      command: 'git_get_status',
      originalError: legacyError,
    }),
    { message: 'Host command failed', details: { originalError: legacyError } },
    { message: 'Internal error', data: legacyError },
    JSON.parse(JSON.stringify({ message: 'Internal error', data: legacyError })),
    new Error('fatal: not a git repository (or any of the parent directories): .git'),
  ])('recognizes existing host payloads through transport wrappers: %j', (error) => {
    expect(isGitRepositoryNotFoundError(error)).toBe(true);
  });

  it.each([
    'File not found: /workspace/src/file.ts',
    'Failed to get Git status: Permission denied',
    'git_repository_untrusted: /workspace',
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    'Network connection timed out',
  ])('does not misclassify another failure: %s', (message) => {
    expect(isGitRepositoryNotFoundError(new Error(message))).toBe(false);
  });
});

describe('isSessionInUseError', () => {
  it('recognizes local Tauri command errors without parsing human prose', () => {
    const error = new TauriCommandError('Command failed', {
      command: 'ensure_coordinator_session',
      originalError: new Error(
        'session_in_use: Session is already open for writing: session-1',
      ),
    });

    expect(isSessionInUseError(error)).toBe(true);
  });

  it('recognizes the same stable prefix through Peer error wrapping', () => {
    const error = {
      message: 'Host command failed',
      details: {
        originalError:
          'session_in_use: Session is already open for writing: session-1',
      },
    };

    expect(isSessionInUseError(error)).toBe(true);
  });

  it('does not classify similar human prose as the stable error', () => {
    expect(
      isSessionInUseError(
        new Error('This session seems to be in use by another process'),
      ),
    ).toBe(false);
  });
});

describe('isOutcomeUnknownError', () => {
  it('recognizes the stable rename error through Tauri and Peer wrappers', () => {
    expect(
      isOutcomeUnknownError(
        new TauriCommandError('Command failed', {
          command: 'update_session_title',
          originalError: 'outcome_unknown: inspect authoritative state',
        }),
      ),
    ).toBe(true);
    expect(
      isOutcomeUnknownError({
        message: 'Host command failed',
        details: { originalError: 'outcome_unknown: inspect authoritative state' },
      }),
    ).toBe(true);
  });

  it('does not infer unknown outcomes from human prose', () => {
    expect(isOutcomeUnknownError(new Error('The rename might have worked'))).toBe(false);
  });
});

describe('isNotAvailableError', () => {
  it('recognizes a stable unsupported capability prefix through wrappers', () => {
    expect(
      isNotAvailableError({
        context: { originalError: 'not_available: future profile is unsupported' },
      }),
    ).toBe(true);
  });

  it('does not infer unsupported state from prose', () => {
    expect(isNotAvailableError(new Error('This feature is unavailable'))).toBe(false);
  });
});

describe('isGitRepositoryUntrustedError', () => {
  it('recognizes the ownership rejection through Tauri and Peer wrappers', () => {
    expect(
      isGitRepositoryUntrustedError(
        new TauriCommandError('Command failed', {
          command: 'git_get_status',
          originalError: 'git_repository_untrusted: D:/workspace/project/OpenBitFun',
        }),
      ),
    ).toBe(true);
    expect(
      isGitRepositoryUntrustedError({
        message: 'Host command failed',
        details: { originalError: 'git_repository_untrusted: /srv/repo' },
      }),
    ).toBe(true);
  });

  it('recognizes the JSON-RPC shape web mode receives over the WebSocket transport', () => {
    // `webSocketResponseError` builds this: the protocol phrase is the message
    // and the host's stable code rides in `data`.
    const error = Object.assign(new Error('Invalid params'), {
      code: -32602,
      data: 'git_repository_untrusted: /srv/shared/repo',
    });

    expect(isGitRepositoryUntrustedError(error)).toBe(true);
    expect(gitRepositoryUntrustedPath(error)).toBe('/srv/shared/repo');
  });

  it('does not classify an ordinary Git failure as an ownership rejection', () => {
    expect(
      isGitRepositoryUntrustedError(new Error('Failed to get status: not a git repository')),
    ).toBe(false);
  });

  it('carries the repository path Git rejected', () => {
    const error = new TauriCommandError('Command failed', {
      command: 'git_get_status',
      originalError: 'git_repository_untrusted: D:/workspace/project/OpenBitFun',
    });

    expect(gitRepositoryUntrustedPath(error)).toBe('D:/workspace/project/OpenBitFun');
    expect(gitRepositoryUntrustedPath(new Error('unrelated'))).toBeUndefined();
  });

  it('reports no path when the backend sent the prefix without one', () => {
    expect(
      gitRepositoryUntrustedPath(new Error('git_repository_untrusted:   ')),
    ).toBeUndefined();
  });
});

describe('isRemoteWorkspaceConnectionConflictError', () => {
  const conflict =
    'remote_workspace_connection_conflict: Workspace remote_1 is bound to SSH connection ssh-root@example.com; reopening it with connection ssh-deploy@example.com requires confirmation.';

  it.each([
    conflict,
    new TauriCommandError('Command failed', {
      command: 'open_remote_workspace',
      originalError: conflict,
    }),
    { message: 'Host command failed', details: { originalError: conflict } },
    { message: 'Internal error', data: conflict },
  ])('recognizes the stable code through Desktop and Peer wrappers: %j', (error) => {
    expect(isRemoteWorkspaceConnectionConflictError(error)).toBe(true);
    expect(remoteWorkspaceConnectionConflictOwner(error)).toBe('ssh-root@example.com');
  });

  it.each([
    'Failed to open remote workspace: Remote workspace path is not a directory',
    'Failed to open remote workspace: remote_workspace_connection_conflict: wrapped by an old host',
    'remote_workspace_storage_conflict: Workspace remote_1 is owned by SSH connection ssh-root@example.com',
  ])('does not classify other failures: %s', (message) => {
    expect(isRemoteWorkspaceConnectionConflictError(new Error(message))).toBe(false);
    expect(remoteWorkspaceConnectionConflictOwner(new Error(message))).toBeUndefined();
  });
});
