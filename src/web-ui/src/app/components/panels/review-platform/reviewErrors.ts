import { getReviewActionErrorMessage } from '@/flow_chat/deep-review/action-bar/actionBarFormatting';
import type { DeepReviewLaunchError } from '@/flow_chat/deep-review/launch/launchErrors';
import { describeGitTrustFailure } from '@/shared/services/gitTrustService';
import { isGitUnavailableError, isGitRepositoryUntrustedError, reviewPlatformErrorCode } from '@/infrastructure/api/errors/TauriCommandError';
import type { ReviewPlatformAuthChallenge } from '@/infrastructure/api';

type ReviewTranslate = (key: string, options?: Record<string, unknown>) => string;

export type ReviewErrorFallback = 'loadFailed' | 'detailsFailed' | 'ciLogFailed' | 'reviewFailed' | 'saveTokenFailed' | 'clearTokenFailed' | 'openAuthFailed' | 'copyAuthFailed';

export function reviewPlatformErrorMessage(error: unknown, t: ReviewTranslate, fallback: ReviewErrorFallback = 'loadFailed'): string {
  if ((error as DeepReviewLaunchError | null)?.launchErrorMessageKey) {
    return getReviewActionErrorMessage(error, (key, options) => t(key, { ...options, ns: 'flow-chat' }), t('common:reviewPlatform.messages.reviewFailed'));
  }
  if (isGitUnavailableError(error)) return t('common:reviewPlatform.errors.gitUnavailable');
  if (isGitRepositoryUntrustedError(error)) return describeGitTrustFailure(error) ?? t('common:reviewPlatform.errors.repositoryUntrusted');
  switch (reviewPlatformErrorCode(error)) {
    case 'invalidRepository': return t('common:reviewPlatform.errors.invalidRepository');
    case 'repositoryUntrusted': return t('common:reviewPlatform.errors.repositoryUntrusted');
    case 'remoteNotFound': return t('common:reviewPlatform.errors.remoteNotFound');
    case 'unsupportedPlatform': return t('common:reviewPlatform.errors.unsupportedPlatform');
    case 'providerFailed': return t('common:reviewPlatform.errors.providerFailed');
    case 'authenticationRequired': return t('common:reviewPlatform.errors.authenticationRequired');
    case 'permissionDenied': return t('common:reviewPlatform.errors.permissionDenied');
    case 'notFound': return t('common:reviewPlatform.errors.notFound');
    case 'networkFailed': return t('common:reviewPlatform.errors.networkFailed');
    case 'invalidResponse': return t('common:reviewPlatform.errors.invalidResponse');
    case 'staleTarget': return t('common:reviewPlatform.errors.staleTarget');
    case 'evidenceTooLarge': return t('common:reviewPlatform.errors.evidenceTooLarge');
    case 'targetIsPullRequest': return t('common:reviewPlatform.errors.targetIsPullRequest');
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const localized = localizedErrorText(message, t);
  if (localized !== undefined) return localized;
  // Unknown technical failures stay in the diagnostic log, not in the UI.
  switch (fallback) {
    case 'loadFailed': return t('common:reviewPlatform.errors.loadFailed');
    case 'detailsFailed': return t('common:reviewPlatform.messages.detailsFailed');
    case 'ciLogFailed': return t('common:reviewPlatform.messages.ciLogFailed');
    case 'reviewFailed': return t('common:reviewPlatform.messages.reviewFailed');
    case 'saveTokenFailed': return t('common:reviewPlatform.messages.saveTokenFailed');
    case 'clearTokenFailed': return t('common:reviewPlatform.messages.clearTokenFailed');
    case 'openAuthFailed': return t('common:reviewPlatform.messages.openAuthFailed');
    case 'copyAuthFailed': return t('common:reviewPlatform.messages.copyAuthFailed');
  }
}

function localizedErrorText(message: string, t: ReviewTranslate): string | undefined {
  switch (message) {
    case "Review failed \u00b7 open to inspect": return t('common:reviewPlatform.messages.reviewFailedInspect');
    case "Review complete \u00b7 result unavailable \u00b7 open to inspect": return t('common:reviewPlatform.messages.reviewResultUnavailable');
    case "Review error": return t('common:reviewPlatform.messages.reviewError');
    case "No active workspace is available.": return t('common:reviewPlatform.messages.noWorkspace');
    case "This link is not a supported pull request URL.": return t('common:reviewPlatform.messages.unsupportedLink');
    case "Open or create a chat session before sending PR context.": return t('common:reviewPlatform.messages.chatRequired');
    case "Open or create a chat session before reviewing this pull request.": return t('common:reviewPlatform.messages.reviewChatRequired');
    case "Review started, but its start acknowledgement is uncertain.": return t('common:reviewPlatform.messages.reviewUncertain');
    case "Token is required.": return t('common:reviewPlatform.messages.tokenRequired');
    case "This pull request could not be resolved from the remotes of the current workspace.": return t('common:reviewPlatform.messages.unresolvedPullRequest');
    case "GitHub pull request head SHA was not available.": return t('common:reviewPlatform.messages.headUnavailable');
    case "No matching GitHub Actions job was found for this check run.": return t('common:reviewPlatform.messages.noActionsJob');
    case "The matching GitHub Actions job does not expose a job id.": return t('common:reviewPlatform.messages.noActionsJobId');
    default: return undefined;
  }
}

export function reviewErrorText(message: string | null | undefined, t: ReviewTranslate): string {
  return message ? localizedErrorText(message, t) ?? message : "";
}

export function reviewAuthErrorMessage(challenge: ReviewPlatformAuthChallenge, t: ReviewTranslate): string {
  if (challenge.platform === 'github') {
    return t('common:reviewPlatform.auth.github', { command: 'gh auth login --hostname ' + challenge.host });
  }
  const options = { host: challenge.host };
  switch (challenge.state) {
    case 'missing': return t('common:reviewPlatform.auth.missing', options);
    case 'insufficient_scope': return t('common:reviewPlatform.auth.insufficientScope', options);
    default: return t('common:reviewPlatform.auth.invalid', options);
  }
}
