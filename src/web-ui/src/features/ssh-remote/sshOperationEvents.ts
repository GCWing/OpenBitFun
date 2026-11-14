/**
 * Window event raised when an operation on an SSH connection timed out. A
 * timeout is the earliest sign of a link that died silently (sleep, network
 * change), so the connection provider re-verifies the link instead of waiting
 * for its next heartbeat.
 */
export const SSH_OPERATION_TIMEOUT_EVENT = 'openbitfun:ssh-operation-timeout';

export interface SshOperationTimeoutDetail {
  connectionId: string;
}

export function isSshTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed? ?out|timeout/i.test(message);
}

/** Announce a timed-out operation on `connectionId`; other errors are ignored. */
export function reportSshOperationTimeout(connectionId: string, error: unknown): void {
  if (!isSshTimeoutError(error) || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SshOperationTimeoutDetail>(
    SSH_OPERATION_TIMEOUT_EVENT,
    { detail: { connectionId } },
  ));
}
