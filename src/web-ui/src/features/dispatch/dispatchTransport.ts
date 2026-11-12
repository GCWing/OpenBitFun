import { dispatchJobStore } from './dispatchJobStore';
import type { DispatchTarget, DispatchTargetRequest } from './types';
import { isDispatchJobTerminal } from './types';

/**
 * Stable marker the controller puts at the start of a status error when the
 * target answered but has no record of the job. Keep in sync with
 * `DISPATCH_JOB_NOT_FOUND_MARKER` in the core dispatch service.
 */
export const DISPATCH_JOB_NOT_FOUND_MARKER = '[dispatch_job_not_found]';

/**
 * Text an older controller (or a controller relaying an older target) returns
 * for the same condition. Both the job directory and its commit marker are
 * checked by the target store; either missing means the job never landed.
 */
const LEGACY_NOT_FOUND_PATTERNS = [
  /dispatch job not found:/i,
  /dispatch job is not committed:/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * True when a status error says the target has no such job, as opposed to the
 * target being unreachable. Accepts the typed marker from current controllers
 * and the plain text older ones still produce.
 */
export function isDispatchJobNotFoundError(error: unknown): boolean {
  const text = errorText(error);
  return text.includes(DISPATCH_JOB_NOT_FOUND_MARKER)
    || LEGACY_NOT_FOUND_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * One polling lane per target transport. Jobs on the same target share the
 * SSH connection or device relay, so they are polled one after another; jobs
 * on different targets never wait for each other.
 */
export function dispatchTargetLaneKey(
  target: DispatchTarget | DispatchTargetRequest | undefined,
): string {
  switch (target?.kind) {
    case 'ssh':
      return `ssh:${target.connectionId}`;
    case 'device':
      return `device:${target.deviceId}`;
    default:
      return 'local';
  }
}

/**
 * Whether the target has the job, as far as this controller can tell.
 *
 * - `pending`: no submit acknowledgement and no target answer yet.
 * - `delivered`: the target acknowledged or reported the job.
 * - `notDelivered`: the submit outcome was unknown and the target answered
 *   that it has no such job. Retrying the submit with the same job id is safe.
 * - `missingOnTarget`: the target once had the job but no longer reports it.
 */
export type DispatchDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'notDelivered'
  | 'missingOnTarget';

export function dispatchJobDeliveryStatus(jobId: string): DispatchDeliveryStatus {
  const state = dispatchJobStore.getState();
  const job = state.jobs[jobId];
  if (!job) return 'pending';
  const reachability = state.transportByJobId[jobId]?.reachability;
  const unacknowledged = job.state === 'submitting' || job.state === 'submission_unknown';
  if (reachability === 'notFound') {
    return unacknowledged ? 'notDelivered' : 'missingOnTarget';
  }
  if (unacknowledged) return 'pending';
  return 'delivered';
}

/**
 * Pending permission prompts restored from disk, or kept while the target is
 * unreachable, are not actionable: only a successful status read confirms
 * they are still pending. Terminal jobs have none.
 */
export function arePendingPermissionsConfirmed(jobId: string): boolean {
  const state = dispatchJobStore.getState();
  const job = state.jobs[jobId];
  if (!job || isDispatchJobTerminal(job.state)) return false;
  return state.transportByJobId[jobId]?.reachability === 'reachable';
}
