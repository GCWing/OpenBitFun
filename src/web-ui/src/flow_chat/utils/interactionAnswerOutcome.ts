import { isOutcomeUnknownError } from '@/infrastructure/api/errors/TauriCommandError';

/**
 * Host refusals that mean the interaction is no longer waiting for this
 * answer: it was already answered (possibly by this request, whose reply was
 * lost), cancelled, or timed out. Matched on the stable runtime messages.
 */
const SETTLED_INTERACTION_PATTERN =
  /Pending permission request not found|Permission request not found|Waiting channel not found|Channel closed, cannot send answer/i;

function errorText(error: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    return `${error.message} ${errorText((error as { cause?: unknown }).cause, depth + 1)}`;
  }
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; data?: unknown };
    return [candidate.message, candidate.data].filter(value => typeof value === 'string').join(' ');
  }
  return '';
}

/**
 * Whether an answer failure must be confirmed against the host's interaction
 * mailbox before it is reported. A retry of an interaction that already
 * settled can never succeed, and a lost reply may hide an accepted answer.
 */
export function needsInteractionAnswerReadback(error: unknown): boolean {
  return isOutcomeUnknownError(error) || SETTLED_INTERACTION_PATTERN.test(errorText(error));
}

/**
 * How a failed answer ended once the host no longer waits for it.
 * `accepted`: the host took this answer. `unknown`: the reply was lost and the
 * answer may have been taken. `already_resolved`: the host refused it because
 * the interaction had already settled (answered elsewhere, cancelled, or timed
 * out), so this answer was not delivered.
 */
export type InteractionAnswerOutcome = 'accepted' | 'unknown' | 'already_resolved';

/** Classify a failure whose interaction the host no longer has pending. */
export function settledInteractionAnswerOutcome(error: unknown): Exclude<InteractionAnswerOutcome, 'accepted'> {
  return isOutcomeUnknownError(error) ? 'unknown' : 'already_resolved';
}
