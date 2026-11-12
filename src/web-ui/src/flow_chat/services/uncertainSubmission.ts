/**
 * Resolution of a turn start whose reply was lost.
 *
 * Once `start_dialog_turn` (or a dispatch submit) has been sent, the host may
 * own the Turn before the controller sees an acknowledgement. Deleting the
 * optimistic turn and restoring the composer then invites a resend that runs
 * the prompt twice. Instead the turn stays visible with a confirming label
 * while the host's authoritative view is read back:
 *
 * - The host has the turn: keep it; its records and events settle it.
 * - The host does not have it, or the read-back fails: remove the optimistic
 *   turn and retain the message in the pending queue as `failed` with the same
 *   Turn id, so an explicit Retry is deduplicated by `(sessionId, turnId)`.
 *
 * Dispatch submissions are settled by the dispatch observer instead: the job
 * state in `dispatchJobStore` says whether the target received the job.
 */

import { createLogger } from '@/shared/utils/logger';
import { isOutcomeUnknownError, isTauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { stateMachineManager } from '../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../state-machine/types';
import { clearRuntimeStatusState, showRuntimeStatus } from '../store/runtimeStatusStore';
import { pendingQueueManager, type EnqueueInput } from './flow-chat-manager/PendingQueueModule';
import type { FlowChatContext } from './flow-chat-manager/types';

const log = createLogger('UncertainSubmission');

export type UncertainSubmissionOutcome = 'delivered' | 'not_delivered' | 'unknown';

export interface UncertainSubmission {
  scope: SurfaceScope;
  sessionId: string;
  turnId: string;
  /** Retained for an explicit retry when the host does not have the turn. */
  retained: Omit<EnqueueInput, 'sessionId' | 'turnId' | 'initialStatus' | 'retryCount'>;
}

function confirmingRoundId(turnId: string): string {
  return `submission-confirm:${turnId}`;
}

function showConfirming(sessionId: string, turnId: string, label: string): void {
  showRuntimeStatus({ sessionId, turnId, roundId: confirmingRoundId(turnId), label });
}

function clearConfirming(sessionId: string, turnId: string): void {
  clearRuntimeStatusState({ sessionId, turnId, roundId: confirmingRoundId(turnId) });
}

/**
 * Remove the optimistic turn and keep the message for an explicit retry under
 * its Turn id. Never resubmits on its own.
 */
async function retainForRetry(
  context: FlowChatContext,
  submission: UncertainSubmission,
  outcome: Exclude<UncertainSubmissionOutcome, 'delivered'>,
  copy: { title: string; body: string },
): Promise<void> {
  const { scope, sessionId, turnId } = submission;
  clearConfirming(sessionId, turnId);
  if (!scope.isCurrent()) {
    // The surface left: keep the turn there and retain the draft on its queue.
    pendingQueueManager.enqueueForSurface(scope.surfaceId, {
      ...submission.retained, sessionId, turnId, initialStatus: 'failed', retryCount: 1,
    });
    return;
  }
  const machine = stateMachineManager.get(sessionId);
  if (machine?.getContext().currentDialogTurnId === turnId
    && machine.getCurrentState() === SessionExecutionState.PROCESSING) {
    await stateMachineManager.transition(sessionId, SessionExecutionEvent.ERROR_OCCURRED, { error: outcome });
    await stateMachineManager.transition(sessionId, SessionExecutionEvent.RESET);
  }
  context.processingManager.clearSessionStatus(sessionId);
  if (context.flowChatStore.getState().sessions.get(sessionId)?.dialogTurns.some(turn => turn.id === turnId)) {
    context.flowChatStore.deleteDialogTurn(sessionId, turnId);
  }
  try {
    pendingQueueManager.enqueueForSurface(scope.surfaceId, {
      ...submission.retained, sessionId, turnId, initialStatus: 'failed', retryCount: 1,
    });
  } catch (error) {
    log.error('Failed to retain an unconfirmed message', { sessionId, turnId, error });
  }
  notificationService.warning(copy.body, { title: copy.title, duration: 8000 });
}

/**
 * Peer device path: re-read the session from the host and look for the turn
 * in its canonical records.
 */
export async function confirmUncertainPeerSubmission(
  context: FlowChatContext,
  submission: UncertainSubmission,
): Promise<UncertainSubmissionOutcome> {
  const { scope, sessionId, turnId } = submission;
  showConfirming(sessionId, turnId, i18nService.t('flow-chat:session.submissionConfirming'));
  let outcome: UncertainSubmissionOutcome;
  try {
    if (!context.flowChatStore.relayHostHasTurn(sessionId, turnId)) {
      await context.flowChatStore.reloadRelaySessionFromHost(sessionId);
      // A read already in flight is reused; wait until its latest page applied.
      if (scope.isCurrent()) await context.flowChatStore.loadRelaySessionHistory(sessionId);
    }
    outcome = !scope.isCurrent() ? 'unknown'
      : context.flowChatStore.relayHostHasTurn(sessionId, turnId) ? 'delivered' : 'not_delivered';
  } catch (error) {
    log.warn('Failed to confirm a submission with an unknown outcome', { sessionId, turnId, error });
    outcome = 'unknown';
  }
  log.info('Resolved a submission with an unknown outcome', { sessionId, turnId, outcome });
  if (outcome === 'delivered') {
    clearConfirming(sessionId, turnId);
    return outcome;
  }
  await retainForRetry(context, submission, outcome, outcome === 'not_delivered'
    ? {
      title: i18nService.t('flow-chat:session.submissionNotDeliveredTitle'),
      body: i18nService.t('flow-chat:session.submissionNotDelivered'),
    }
    : {
      title: i18nService.t('flow-chat:session.submissionUnconfirmedTitle'),
      body: i18nService.t('flow-chat:session.submissionUnconfirmed'),
    });
  return outcome;
}

/**
 * A dispatch submit failure that may have happened after the request left:
 * a lost reply, or a transport failure on the way to the target. A refusal
 * before sending (validation, preflight) keeps its own error and the draft.
 */
export function isUncertainDispatchSubmitFailure(error: unknown): boolean {
  if (isOutcomeUnknownError(error)) return true;
  if (isTauriCommandError(error) && error.isNetworkError()) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed? ?out|network|connection|disconnected|transport|broken pipe|channel closed|reset by peer/i.test(message);
}

/** Dispatch job states that prove the target received the job. */
const RECEIVED_DISPATCH_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
/** Dispatch job states that keep the outcome open. */
const PENDING_DISPATCH_STATES = new Set(['submitting', 'submission_unknown']);

/**
 * Classify a dispatch job state. Any other state is a typed "not delivered"
 * outcome (for example `not_delivered`) from a newer observer; older builds
 * only ever report the received or pending states above.
 */
export function classifyDispatchDelivery(state: string | undefined): UncertainSubmissionOutcome {
  if (!state || PENDING_DISPATCH_STATES.has(state)) return 'unknown';
  return RECEIVED_DISPATCH_STATES.has(state) ? 'delivered' : 'not_delivered';
}

export interface DispatchJobStateSource {
  read: () => string | undefined;
  subscribe: (listener: () => void) => () => void;
  refresh: () => void;
  /**
   * The controller marks a submit whose request may have reached the target
   * `submission_unknown`. A job still `submitting` after this grace failed
   * before anything was sent. Omit when the failure itself was ambiguous.
   */
  submittingGraceMs?: number;
}

export const DISPATCH_SUBMITTING_GRACE_MS = 10_000;

/**
 * Dispatch path: keep the optimistic job turn and let the dispatch observer
 * settle it. Resolves once the job state proves receipt or non-delivery, or
 * the surface changes (then the turn stays on its surface for the observer).
 */
export function confirmUncertainDispatchSubmission(
  context: FlowChatContext,
  submission: UncertainSubmission,
  job: DispatchJobStateSource,
): Promise<UncertainSubmissionOutcome> {
  const { scope, sessionId, turnId } = submission;
  showConfirming(sessionId, turnId, i18nService.t('flow-chat:session.submissionCheckingTarget'));
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => settle('unknown', false);
    const settle = (outcome: UncertainSubmissionOutcome, act: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (graceTimer !== null) clearTimeout(graceTimer);
      scope.signal.removeEventListener('abort', abort);
      if (!act || outcome === 'delivered') {
        clearConfirming(sessionId, turnId);
        resolve(outcome);
        return;
      }
      void retainForRetry(context, submission, outcome, {
        title: i18nService.t('flow-chat:session.submissionNotDeliveredTitle'),
        body: i18nService.t('flow-chat:session.dispatchNotDelivered'),
      }).finally(() => resolve(outcome));
    };
    const check = () => {
      const outcome = classifyDispatchDelivery(job.read());
      if (outcome !== 'unknown') settle(outcome, true);
    };
    scope.signal.addEventListener('abort', abort, { once: true });
    unsubscribe = job.subscribe(check);
    check();
    if (settled) return;
    job.refresh();
    if (job.submittingGraceMs !== undefined) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        const state = job.read();
        if (!state || state === 'submitting') settle('not_delivered', true);
      }, job.submittingGraceMs);
    }
  });
}
