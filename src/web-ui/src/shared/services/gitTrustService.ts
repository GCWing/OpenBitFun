/**
 * Ownership-trust recovery for Git-backed surfaces.
 *
 * Git refuses to read a repository whose directory is owned by another user
 * until the path is listed in the protected `safe.directory` configuration.
 * Callers that hit that wall hand the failure here: the service explains the
 * state, asks the user once, and — only after they agree — grants trust and
 * replays the operation.
 *
 * Trust is never granted implicitly. Listing a directory in `safe.directory`
 * tells Git to run hooks and config from a tree the current user does not own,
 * so the decision belongs to the user, not to the surface that tripped over it.
 */

import { confirmWarning } from '@/infrastructure/confirm-dialog';
import { gitAPI } from '@/infrastructure/api';
import type { GitTrustReport } from '@/infrastructure/api/service-api/GitAPI';
import {
  gitRepositoryUntrustedPath,
  isGitRepositoryUntrustedError,
} from '@/infrastructure/api/errors/TauriCommandError';
import { i18nService } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { GitWorkspaceScope, gitWorkspaceKey } from '@/infrastructure/api/service-api/GitAPI';

const log = createLogger('GitTrustService');

/**
 * How long a settled decision keeps later prompts quiet.
 *
 * One user action (launching Review, refreshing a panel) fans out into many
 * Git reads. Without this, every remaining call in the same burst would ask
 * again — after a decline, and just as much after a grant that failed (a
 * read-only configuration, a refusing peer host): confirming into the same
 * wall is not a fresh decision. The window is deliberately short: a fresh
 * attempt later is a fresh decision.
 */
const PROMPT_QUIET_PERIOD_MS = 30_000;

const inFlightRequests = new Map<string, Promise<boolean>>();
const promptQuietUntil = new Map<string, number>();

/** Trust decisions belong to the owning surface and workspace ID. */
const promptKey = gitWorkspaceKey;

/** Names an ownership rejection with localized, actionable copy. */
export function describeGitTrustFailure(failure: unknown): string | undefined {
  const repositoryPath = gitRepositoryUntrustedPath(failure);
  return repositoryPath
    ? i18nService.t('panels/git:trust.required', { path: repositoryPath })
    : undefined;
}

/** Test seam: forgets in-flight prompts and remembered decisions. */
export function resetGitTrustDecisions(): void {
  inFlightRequests.clear();
  promptQuietUntil.clear();
}

/**
 * Re-reads trust from the host that owns the repository.
 *
 * That host is the only one that can phrase the manual command, and in Peer
 * Device Mode it is also the only one allowed to grant: the peer refuses
 * `git_trust_repository` on purpose, so this read-only probe is how a
 * controller still ends up with something actionable. A host too old to answer
 * it returns `null`, which degrades to the generic message loudly rather than
 * silently.
 */
async function readTrustReport(repositoryPath: GitWorkspaceScope): Promise<GitTrustReport | null> {
  try {
    return await gitAPI.getRepositoryTrust(repositoryPath);
  } catch (error) {
    log.warn('Could not read Git repository trust for manual guidance', {
      repositoryPath,
      error,
    });
    return null;
  }
}

/**
 * Settles a grant that did not take, and reports whether the wall is still up.
 *
 * The re-read is not bookkeeping. The manual command exists to be run, and the
 * whole point of the paths that cannot grant — a remote workspace, a peer host,
 * a read-only configuration — is that the user (or the repository's owner)
 * fixes it elsewhere and comes back. By then Git accepts the repository, and
 * announcing "could not be granted" while answering the caller `false` strands
 * a repository that works: no refresh, no replay, and a warning about a wall
 * that is no longer there. Only a probe that still says `trustRequired`, or one
 * that could not answer at all, hands over the manual command.
 */
async function settleUngrantedTrust(
  repositoryPath: GitWorkspaceScope,
  reportedPath: string,
  manualCommand: string | null,
): Promise<boolean> {
  // Probe the path the caller will retry, not the one Git named: a rejection
  // raised against the administrative `.git` directory reports that directory,
  // and it is the worktree the caller is going to read again.
  const report = await readTrustReport(repositoryPath);
  if (report?.state === 'trusted') {
    promptQuietUntil.delete(promptKey(repositoryPath));
    log.info('Git repository trust was resolved outside the product', { repositoryPath });
    notificationService.success(
      i18nService.t('panels/git:trust.alreadyTrusted', { path: repositoryPath.repositoryPath ?? repositoryPath.workspaceId }),
    );
    return true;
  }

  // Like a decline, an unresolved failure settles the current burst: confirming
  // into the same wall is not a fresh decision, so no re-prompt until the quiet
  // period ends. Keyed on the caller's path — the key the next call arrives
  // under — while the message names the path Git actually rejected.
  promptQuietUntil.set(promptKey(repositoryPath), Date.now() + PROMPT_QUIET_PERIOD_MS);
  reportManualPath(reportedPath, manualCommand ?? report?.manualCommand ?? null);
  return false;
}

function reportManualPath(repositoryPath: string, manualCommand: string | null): void {
  const message = manualCommand
    ? i18nService.t('panels/git:trust.unavailableWithCommand', {
        path: repositoryPath,
        command: manualCommand,
      })
    : i18nService.t('panels/git:trust.unavailable', { path: repositoryPath });
  notificationService.warning(message, {
    title: i18nService.t('panels/git:trust.title'),
    duration: 0,
  });
}

async function promptAndTrust(repositoryPath: GitWorkspaceScope): Promise<boolean> {
  const confirmed = await confirmWarning(
    i18nService.t('panels/git:trust.title'),
    i18nService.t('panels/git:trust.message', { path: repositoryPath.repositoryPath ?? repositoryPath.workspaceId }),
    {
      confirmText: i18nService.t('panels/git:trust.confirm'),
      cancelText: i18nService.t('panels/git:trust.cancel'),
    },
  );

  if (!confirmed) {
    promptQuietUntil.set(promptKey(repositoryPath), Date.now() + PROMPT_QUIET_PERIOD_MS);
    log.info('Git repository trust declined by user', { repositoryPath });
    return false;
  }

  try {
    const outcome = await gitAPI.trustRepository(repositoryPath);
    if (outcome.state === 'trusted') {
      promptQuietUntil.delete(promptKey(repositoryPath));
      notificationService.success(
        i18nService.t('panels/git:trust.granted', { path: repositoryPath.repositoryPath ?? repositoryPath.workspaceId }),
      );
      return true;
    }

    // The backend reached the repository but could not make Git accept it —
    // a remote workspace, a read-only configuration, an unexpected path shape.
    // Re-read before deciding: the user may have run the command themselves.
    log.warn('Git repository trust could not be applied', {
      repositoryPath,
      state: outcome.state,
      detail: outcome.detail,
    });
    const reportedPath = outcome.repositoryPath ?? repositoryPath.repositoryPath ?? repositoryPath.workspaceId;
    return await settleUngrantedTrust(repositoryPath, reportedPath, outcome.manualCommand);
  } catch (error) {
    // Includes the hosts that refuse to grant at all: a peer host denies
    // `git_trust_repository` on purpose, and an older host does not know it.
    log.error('Failed to grant Git repository trust', { repositoryPath, error });
    return await settleUngrantedTrust(repositoryPath, repositoryPath.repositoryPath ?? repositoryPath.workspaceId, null);
  }
}

export interface GitRepositoryTrustRequestOptions {
  /**
   * The user asked for this directly (the Trust button), rather than a Git read
   * tripping over the wall.
   *
   * A direct ask is always answered: the quiet period exists to keep one user
   * action from prompting once per Git call in the burst, not to make a visible
   * button do nothing. Silently returning `false` to a click reads as a broken
   * button, and it strands the user who just fixed `safe.directory` in a
   * terminal or reconnected a remote host.
   */
  userInitiated?: boolean;
}

/**
 * Asks the user to trust a repository Git rejected, and grants it on approval.
 *
 * Concurrent callers for the same path share one prompt. Returns whether Git
 * now accepts the repository.
 */
export function requestGitRepositoryTrust(
  repositoryPath: GitWorkspaceScope,
  options: GitRepositoryTrustRequestOptions = {},
): Promise<boolean> {
  const key = promptKey(repositoryPath);
  const pending = inFlightRequests.get(key);
  if (pending) {
    return pending;
  }

  const quietUntil = promptQuietUntil.get(key);
  if (quietUntil !== undefined) {
    if (quietUntil > Date.now() && !options.userInitiated) {
      return Promise.resolve(false);
    }
    promptQuietUntil.delete(key);
  }

  const request = promptAndTrust(repositoryPath).finally(() => {
    inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, request);
  return request;
}

/**
 * Runs a read-only Git operation, recovering once from an ownership rejection.
 *
 * Anything other than an ownership rejection propagates untouched, and the
 * replay happens at most once — so a repository that stays untrusted fails with
 * its original error instead of looping.
 *
 * Only for operations that are safe to run twice. Do not wrap mutations.
 *
 * Pass `userInitiated` when the operation is one discrete thing the user asked
 * for (launching Review), rather than one call inside an automatic burst: the
 * quiet period would otherwise answer a deliberate action with a silent `false`
 * and an error telling them to trust the folder "when prompted".
 */
export async function withGitRepositoryTrustRecovery<T>(
  operation: () => Promise<T>,
  workspace: GitWorkspaceScope,
  options: GitRepositoryTrustRequestOptions = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isGitRepositoryUntrustedError(error)) {
      throw error;
    }

    const repositoryPath = gitRepositoryUntrustedPath(error);
    if (!repositoryPath) {
      throw error;
    }

    const trusted = await requestGitRepositoryTrust(workspace, options);
    if (!trusted) {
      throw error;
    }

    return await operation();
  }
}
