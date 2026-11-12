/**
 * Translate host queue failures. The queue owner reports stable error codes
 * and messages; the raw text is for logs, never for the composer.
 */
const KNOWN_QUEUE_ERRORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/queue_conflict:/, 'pendingQueue.orderChanged'],
  [/queue_reorder_unsupported:/, 'pendingQueue.reorderUnsupported'],
  [/queue_scope_expired:/, 'hostQueue.errors.ownerRestarted'],
  [/too_late:/, 'hostQueue.errors.tooLate'],
  [/idempotency_conflict:/, 'hostQueue.errors.conflict'],
  [/Message queue is full/, 'hostQueue.errors.full'],
  [/Queue is blocked by interrupted/, 'hostQueue.errors.blocked'],
  [/Host did not acknowledge the submitted message|outcome_unknown:/, 'hostQueue.unknown'],
  [/Refresh the host queue before changing it/, 'hostQueue.errors.refreshFirst'],
];

/** Refusals that are expected and recovered elsewhere; they show no banner. */
const SILENT_QUEUE_ERRORS = /Session is not loaded/;

export function hostQueueErrorKey(raw: string | null | undefined): string | null {
  if (!raw || SILENT_QUEUE_ERRORS.test(raw)) return null;
  for (const [pattern, key] of KNOWN_QUEUE_ERRORS) {
    if (pattern.test(raw)) return key;
  }
  return 'hostQueue.errors.generic';
}
