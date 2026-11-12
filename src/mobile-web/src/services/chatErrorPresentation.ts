import { classifyRelayFailure } from '../../../shared/relay-transport/RelayFailure';
import { UNSUPPORTED_HOST_MESSAGE } from '../../../shared/relay-transport/HostStream';
import { RemoteHostCommandError } from './RelayHttpClient';
import {
  isWorkspaceIdReferencesUnsupportedError,
  RemoteSessionModelWriteUnconfirmedError,
} from './RemoteSessionManager';

type Translate = (key: string, params?: Record<string, string | number>) => string;

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : '';
}

/** The command provably never reached the host: the local transport or the
 * Relay refused it before dispatch (the Relay answers "RPC target
 * unavailable" when the desktop has no live connection). */
export function isNotSubmittedFailure(error: unknown): boolean {
  return /request was not submitted|rpc target unavailable|before dispatch/i.test(messageOf(error));
}

/**
 * The command may have reached the host but its answer was lost: the Relay
 * connection changed after submission, or the acknowledgement timed out.
 * A host's own decrypted answer is never "unknown".
 */
export function isUnknownOutcomeFailure(error: unknown): boolean {
  if (error instanceof RemoteHostCommandError || isNotSubmittedFailure(error)) return false;
  const message = messageOf(error).toLowerCase();
  return message.includes('delivery outcome is unknown')
    || message.includes('operation has timed out');
}

/**
 * User-facing sentence for a failed chat operation or stream read.
 *
 * Transport failures go through the shared Relay classifier and become
 * translated copy; the raw detail stays in the console. A host's own answer
 * (`RemoteHostCommandError`) and failures the classifier cannot place keep
 * their text, because it is the most specific explanation available.
 */
export function describeChatError(error: unknown, t: Translate): string {
  if (error instanceof RemoteSessionModelWriteUnconfirmedError) return t(error.messageKey);
  if (isWorkspaceIdReferencesUnsupportedError(error)) return t('workspace.idReferencesUnsupported');
  const message = messageOf(error);
  if (message === UNSUPPORTED_HOST_MESSAGE) return t('chat.hostStreamUnsupported');
  if (error instanceof RemoteHostCommandError) return message || t('chat.remoteFailed');
  if (/rpc target unavailable/i.test(message)) return t('chat.desktopUnavailable');
  if (isNotSubmittedFailure(error)) return t('chat.notSubmitted');
  if (isUnknownOutcomeFailure(error)) return t('chat.outcomeUnknown');
  const kind = classifyRelayFailure(error);
  if (kind !== 'unknown') console.warn('[ChatError] transport failure', kind, message);
  switch (kind) {
    case 'network': return t('devices.failureNetwork');
    case 'relay-unavailable': return t('devices.failureRelayUnavailable');
    case 'relay-version-retired': return t('devices.failureRelayVersionRetired');
    case 'client-outdated': return t('devices.failureClientOutdated');
    case 'auth': return t('devices.authorizationExpired');
    default: return message || t('chat.remoteFailed');
  }
}
