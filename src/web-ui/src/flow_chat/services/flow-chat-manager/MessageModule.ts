/**
 * Message handling module
 * Shared submission choreography: busy-gate planning, queueing, mode
 * switching, conflict retries, and the error path. Flavor-specific transport
 * work (optimistic turns, dialog-turn start, steering) lives in the session
 * drivers.
 */

import { notificationService } from '../../../shared/notification-system';
import { stateMachineManager } from '../../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../../state-machine/types';
import { createLogger } from '@/shared/utils/logger';
import {
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatContext } from './types';
import { isProjectedSessionEmpty } from '../../utils/flowChatTurnIdentity';
import type { ImageContextData as ImageInputContextData } from '@/infrastructure/api/service-api/ImageContextTypes';
import { pendingQueueManager } from './PendingQueueModule';
import {
  isRuntimeSessionAttachmentInFlight,
  isRuntimeSessionProjectionStale,
  subscribeRuntimeSessionAttachmentFinished,
} from '@/infrastructure/peer-device/runtimeSessionEventGate';
import { isSessionInUseError } from '@/infrastructure/api/errors/TauriCommandError';
import { i18nService } from '@/infrastructure/i18n';
import { driverForSession } from '../../session-drivers/registry';
import type { SendMessageOptions, SubmissionDraft, TurnTracker } from '../../session-drivers/types';
import { assertSessionSubmissionAllowed } from '../../store/sessionMutationStore';
import { hasInterruptedTurnHoldingQueue } from '../../utils/interruptedTurnRecovery';
import { interruptedTurnRecoveryGate } from '../interruptedTurnRecoveryGate';
import { hasPendingVoiceExchanges, replayVoiceExchanges } from '../controlConversation';

export { syncSessionModelSelection } from '../../utils/modelSync';
export { markCurrentTurnItemsAsCancelled } from '../../utils/turnCancellation';

const log = createLogger('MessageModule');

interface SessionConflictRetry {
  notificationId: string;
  active: boolean;
  inFlight: boolean;
}

const sessionConflictRetries = new Map<string, SessionConflictRetry>();
const latestSendBySession = new Map<string, symbol>();

function clearSessionConflictRetry(sendKey: string): void {
  const current = sessionConflictRetries.get(sendKey);
  if (!current) return;
  current.active = false;
  sessionConflictRetries.delete(sendKey);
  notificationService.dismiss(current.notificationId);
}

function beginSessionSend(sendKey: string, sessionId: string): symbol {
  const attempt = Symbol(sessionId);
  latestSendBySession.set(sendKey, attempt);
  clearSessionConflictRetry(sendKey);
  return attempt;
}

function completeSessionSend(
  sendKey: string,
  attempt: symbol,
  retrySuccess?: () => void,
): void {
  if (latestSendBySession.get(sendKey) !== attempt) return;
  latestSendBySession.delete(sendKey);
  clearSessionConflictRetry(sendKey);
  retrySuccess?.();
}

/**
 * Submissions that have created a projection turn but have not yet handed the
 * turn to a host.
 *
 * Switching the rendered device surface selects another projection. A
 * submission caught mid-flight must not resume through that new projection —
 * and because the throw may land before `start_dialog_turn`, the surface switch
 * waits for submissions to drain first.
 */
let inFlightSubmissions = 0;
const inFlightSubmissionWaiters = new Set<() => void>();

function beginSubmission(): void {
  inFlightSubmissions += 1;
}

function endSubmission(): void {
  inFlightSubmissions = Math.max(0, inFlightSubmissions - 1);
  if (inFlightSubmissions === 0 && inFlightSubmissionWaiters.size > 0) {
    for (const notify of Array.from(inFlightSubmissionWaiters)) {
      notify();
    }
    inFlightSubmissionWaiters.clear();
  }
}

export function inFlightSubmissionCount(): number {
  return inFlightSubmissions;
}

/**
 * Salvage a submission that lost the race against a device-surface switch.
 *
 * When the host never accepted the turn the message exists nowhere, so it goes
 * back onto the session's pending queue — queues are keyed by surface and
 * session id, so returning to that device drains it. When the
 * host did accept it, the turn is already running there and nothing is owed.
 */
function recoverSubmissionAfterSurfaceSwitch(
  context: FlowChatContext,
  surfaceId: DeviceSurfaceId,
  sessionId: string,
  turnTracker: TurnTracker,
  draft: {
    message: string;
    displayMessage?: string;
    agentType?: string;
    options?: SendMessageOptions;
  },
): void {
  const hostHasTurn =
    turnTracker.hostAcceptedTurn || turnTracker.hostSubmitStarted === true;
  if (hostHasTurn) {
    log.info('Device surface switched after the host accepted the turn; it keeps running there', {
      sessionId,
    });
    return;
  }
  if (turnTracker.createdLocalTurnId) {
    context.flowChatStore.abandonOptimisticDialogTurn(
      surfaceId,
      sessionId,
      turnTracker.createdLocalTurnId,
    );
    stateMachineManager.resetForSurface(surfaceId, sessionId);
    context.processingManager.clearSessionStatusForSurface(surfaceId, sessionId);
  }
  try {
    pendingQueueManager.enqueueForSurface(surfaceId, {
      sessionId,
      content: draft.message,
      displayMessage: draft.displayMessage,
      agentType: draft.agentType,
      imageContexts: draft.options?.imageContexts,
      imageDisplayData: draft.options?.imageDisplayData,
      composerDraft: draft.options?.pendingQueueDraft,
      userMessageMetadata: draft.options?.userMessageMetadata,
    });
    log.info('Device surface switched before submit reached the host; message re-queued', {
      sessionId,
    });
  } catch (error) {
    // A full queue is the only expected failure, and dropping the message
    // silently would be worse than the original error toast.
    log.error('Failed to re-queue a message after a device surface switch', {
      sessionId,
      error,
    });
    notificationService.error(
      i18nService.t('flow-chat:session.surfaceSwitchDropped'),
      { title: i18nService.t('flow-chat:session.surfaceSwitchDroppedTitle'), duration: 6000 },
    );
  }
}

/**
 * Wait until no submission is mid-flight, or until `timeoutMs` elapses.
 *
 * Returns whether the wait drained. A timeout is not fatal: `sendMessage`
 * detects the surface change and recovers the message onto the pending queue.
 */
export function waitForInFlightSubmissions(timeoutMs: number): Promise<boolean> {
  if (inFlightSubmissions === 0) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    // `endSubmission` clears the waiter set before notifying, so the drained
    // path does not have to unregister itself; only a timeout leaves a stale
    // waiter behind.
    const notify = (): void => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    inFlightSubmissionWaiters.add(notify);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      inFlightSubmissionWaiters.delete(notify);
      resolve(false);
    }, timeoutMs);
  });
}

function acpClientIdFromMode(mode: string | undefined): string | null {
  const value = mode?.trim();
  if (!value?.startsWith('acp:')) return null;
  const clientId = value.slice('acp:'.length).trim();
  return clientId || null;
}

/**
 * Send message and handle response
 * @param message - Message sent to backend
 * @param sessionId - Session ID
 * @param displayMessage - Optional, message for UI display
 * @param agentType - Agent type
 * @param switchToMode - Optional, switch UI mode selector to this mode (if not provided, mode remains unchanged)
 */
export async function sendMessage(
  context: FlowChatContext,
  message: string,
  sessionId: string,
  displayMessage?: string,
  agentType?: string,
  switchToMode?: string,
  options?: SendMessageOptions
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }
  const surfaceScopeAtSend = getActiveSurfaceScope();
  const sendCoordinationKey = surfaceScopeAtSend.key(
    'session-send',
    surfaceScopeAtSend.epoch,
    sessionId,
  );
  if (interruptedTurnRecoveryGate.isSessionInFlight(sessionId)) {
    throw new Error('Interrupted turn recovery is in flight');
  }
  assertSessionSubmissionAllowed(sessionId, options?.sessionMutationLeaseId);
  const sendAttempt = beginSessionSend(sendCoordinationKey, sessionId);
  const draft: SubmissionDraft = {
    message,
    displayMessage,
    imageContexts: options?.imageContexts,
  };

  if (!options?.bypassPendingQueue) {
    const machineState = stateMachineManager.getCurrentState(sessionId);
    const sessionBusy =
      machineState === SessionExecutionState.PROCESSING ||
      machineState === SessionExecutionState.FINISHING ||
      context.userCancelledSessionIds?.has(sessionId) === true;
    const hasPendingQueue = pendingQueueManager.list(sessionId).length > 0;

    if (sessionBusy || hasPendingQueue) {
      if (options?.execution?.kind === 'fresh_external_subagent') {
        throw new Error('External subagent command delegation requires an idle session');
      }
      // Steer-eligibility must be decided before queueing: a steerable
      // message that gets queued never drains for flavors that do not drive
      // the local state machine.
      const plan = driverForSession(sessionId, session)
        .planSubmission(context, sessionId, draft);
      if (plan.kind === 'reject') {
        throw new Error(plan.reason);
      }
      if (plan.kind === 'steer') {
        await driverForSession(sessionId, session).steer(context, sessionId, draft);
        return;
      }
      try {
        const item = pendingQueueManager.enqueue({
          sessionId,
          content: message,
          displayMessage,
          agentType,
          imageContexts: options?.imageContexts,
          imageDisplayData: options?.imageDisplayData,
          composerDraft: options?.pendingQueueDraft,
          userMessageMetadata: options?.userMessageMetadata,
        });
        log.info('Message enqueued: session busy or queue non-empty', {
          sessionId,
          state: machineState,
          queuedItemId: item.id,
          queueDepth: pendingQueueManager.list(sessionId).length,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Failed to queue message';
        log.error('Failed to enqueue pending message', { sessionId, error });
        notificationService.error(reason, {
          title: 'Queue full',
          duration: 4000,
        });
        throw error;
      }
      completeSessionSend(
        sendCoordinationKey,
        sendAttempt,
        options?.fromSessionConflictRetry
          ? options.onSessionConflictRetrySuccess
          : undefined,
      );
      return;
    }
  }

  // Switch UI mode if specified
  if (switchToMode && switchToMode !== session.mode) {
    context.flowChatStore.updateSessionMode(sessionId, switchToMode);
    window.dispatchEvent(new CustomEvent('openbitfun:session-switched', {
      detail: { sessionId, mode: switchToMode }
    }));
  }

  const turnTracker: TurnTracker = { createdLocalTurnId: null, hostAcceptedTurn: false };
  // A device-surface switch swaps the projection this submission reads through.
  // Anything read back after an await belongs to the surface captured here.
  const surfaceGenerationAtSend = context.flowChatStore.getSurfaceGeneration();
  const surfaceIdAtSend = surfaceScopeAtSend.surfaceId;
  beginSubmission();

  try {
    // Recover final native replies before starting the next text turn. Keep
    // normal text sends synchronous and inside the existing surface fence.
    if (hasPendingVoiceExchanges(sessionId)) {
      await replayVoiceExchanges(sessionId);
      surfaceScopeAtSend.assertCurrent('restore conversation history before submission');
    }
    const refreshedSession = context.flowChatStore.getState().sessions.get(sessionId) ?? session;
    const currentAgentType = (agentType?.trim() || refreshedSession.mode || 'Standard').trim();
    const acpClientId = acpClientIdFromMode(currentAgentType);
    const driver = driverForSession(sessionId, refreshedSession);
    if (
      options?.execution?.kind === 'fresh_external_subagent'
      && (acpClientId || driver.id !== 'local')
    ) {
      throw new Error('External subagent command delegation requires the local OpenBitFun runtime');
    }

    if (
      !acpClientId &&
      agentType?.trim() &&
      refreshedSession.mode !== currentAgentType
    ) {
      context.flowChatStore.updateSessionMode(sessionId, currentAgentType);
    }

    if (
      context.pendingHistoryLoads.has(
        surfaceScopeAtSend.key('history-load', surfaceScopeAtSend.epoch, sessionId),
      )
    ) {
      throw new Error('Session history is still restoring, please retry once loading finishes');
    }

    if (!acpClientId) {
      // A driver with nothing to prepare returns void; awaiting only real
      // promises keeps the projection's optimistic turn synchronous with the
      // user's send action.
      const readiness = driver.ensureReady(context, sessionId);
      if (readiness) {
        await readiness;
        surfaceScopeAtSend.assertCurrent('prepare session submission');
      }
    }

    const readySession = context.flowChatStore.getState().sessions.get(sessionId);
    if (!readySession) {
      throw new Error(`Session lost before starting dialog turn: ${sessionId}`);
    }

    const isFirstMessage = isProjectedSessionEmpty(readySession)
      && readySession.titleStatus !== 'generated';

    const outcome = await driver.startTurn(
      context,
      {
        surfaceScope: surfaceScopeAtSend,
        sessionId,
        message,
        displayMessage,
        currentAgentType,
        acpClientId,
        isFirstMessage,
        readySession,
        options,
      },
      turnTracker,
    );
    if (outcome === 'detached') {
      // The message steered or continued target-owned work; the shared
      // post-submission bookkeeping does not apply.
      return;
    }

    completeSessionSend(
      sendCoordinationKey,
      sendAttempt,
      options?.fromSessionConflictRetry
        ? options.onSessionConflictRetrySuccess
        : undefined,
    );

  } catch (error) {
    // The window moved to another device mid-submission. That is not a turn
    // failure: the session still exists on its own device, and the state
    // machine and turn we would "clean up" no longer belong to the rendered
    // surface. Recover the message instead of reporting an error.
    if (
      isSurfaceChangedError(error)
      || context.flowChatStore.getSurfaceGeneration() !== surfaceGenerationAtSend
    ) {
      recoverSubmissionAfterSurfaceSwitch(context, surfaceIdAtSend, sessionId, turnTracker, {
        message,
        displayMessage,
        agentType,
        options,
      });
      if (latestSendBySession.get(sendCoordinationKey) === sendAttempt) {
        latestSendBySession.delete(sendCoordinationKey);
      }
      return;
    }

    log.error('Failed to send message', { sessionId: sessionId, error });

    const errorMessage = error instanceof Error ? error.message : 'Failed to send message';

    const currentState = stateMachineManager.getCurrentState(sessionId);
    const activeDialogTurnId = stateMachineManager
      .get(sessionId)
      ?.getContext().currentDialogTurnId;
    const ownsProcessingTurn =
      turnTracker.createdLocalTurnId !== null &&
      activeDialogTurnId === turnTracker.createdLocalTurnId;
    if (currentState === SessionExecutionState.PROCESSING && ownsProcessingTurn) {
      await stateMachineManager.transition(sessionId, SessionExecutionEvent.ERROR_OCCURRED, {
        error: errorMessage
      });
      await stateMachineManager.transition(sessionId, SessionExecutionEvent.RESET);
    }

    const state = context.flowChatStore.getState();
    const currentSession = state.sessions.get(sessionId);
    if (turnTracker.createdLocalTurnId && currentSession && !options?.preserveTurnOnStartError) {
      context.flowChatStore.deleteDialogTurn(sessionId, turnTracker.createdLocalTurnId);
    }

    if (!options?.preserveTurnOnStartError) {
      if (isSessionInUseError(error)) {
        if (latestSendBySession.get(sendCoordinationKey) !== sendAttempt) {
          throw error;
        }
        clearSessionConflictRetry(sendCoordinationKey);
        const retry: SessionConflictRetry = {
          notificationId: '',
          active: true,
          inFlight: false,
        };
        retry.notificationId = notificationService.error(
          i18nService.t('flow-chat:session.inUseMessage'), {
          title: i18nService.t('flow-chat:session.inUseTitle'),
          duration: 0,
          actions: [{
            label: i18nService.t('flow-chat:session.retry'),
            variant: 'primary',
            onClick: () => {
              if (
                !retry.active ||
                retry.inFlight ||
                !surfaceScopeAtSend.isCurrent() ||
                sessionConflictRetries.get(sendCoordinationKey) !== retry
              ) {
                return;
              }
              retry.inFlight = true;
              options?.onSessionConflictRetryStart?.();
              void sendMessage(
                context,
                message,
                sessionId,
                displayMessage,
                agentType,
                switchToMode,
                { ...options, fromSessionConflictRetry: true },
              )
                .catch(() => undefined);
            },
          }],
        });
        sessionConflictRetries.set(sendCoordinationKey, retry);
      } else {
        if (latestSendBySession.get(sendCoordinationKey) === sendAttempt) {
          latestSendBySession.delete(sendCoordinationKey);
          notificationService.error(errorMessage, {
            title: 'Thinking process error',
            duration: 5000
          });
        }
      }
    } else if (latestSendBySession.get(sendCoordinationKey) === sendAttempt) {
      latestSendBySession.delete(sendCoordinationKey);
    }

    throw error;
  } finally {
    endSubmission();
  }
}

export async function cancelSessionTask(context: FlowChatContext, requestedSessionId?: string): Promise<boolean> {
  try {
    const state = context.flowChatStore.getState();
    const sessionId = requestedSessionId || state.activeSessionId;

    if (!sessionId) {
      log.debug('No active session to cancel');
      return false;
    }

    const session = state.sessions.get(sessionId);
    return await driverForSession(sessionId, session).cancel(context, sessionId);
  } catch (error) {
    log.error('Failed to cancel current task', error);
    return false;
  }
}

export async function cancelCurrentTask(context: FlowChatContext): Promise<boolean> {
  return cancelSessionTask(context);
}

/**
 * Drain a single head item from the pending queue if the session is currently IDLE.
 * Called by the global state-machine subscriber after a turn completes.
 */
export async function drainPendingQueue(
  context: FlowChatContext,
  sessionId: string,
  options?: { allowInterruptedRecoveryAbandon?: boolean },
): Promise<void> {
  if (isRuntimeSessionAttachmentInFlight(getActiveSurfaceId(), sessionId) ||
      isRuntimeSessionProjectionStale(getActiveSurfaceId(), sessionId)) {
    return;
  }
  const machineState = stateMachineManager.getCurrentState(sessionId);
  if (machineState !== SessionExecutionState.IDLE) {
    return;
  }
  if (interruptedTurnRecoveryGate.isSessionInFlight(sessionId)) {
    log.debug('Pending queue held while interrupted recovery admission is in flight', {
      sessionId,
    });
    return;
  }
  if (context.userCancelledSessionIds.has(sessionId)) {
    log.debug('Pending queue held until cancellation outcome is authoritative', { sessionId });
    return;
  }
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (
    hasInterruptedTurnHoldingQueue(session)
    && !options?.allowInterruptedRecoveryAbandon
  ) {
    log.debug('Pending queue held for interrupted turn recovery decision', { sessionId });
    return;
  }
  // Find the head item *that is still eligible for auto-drain*. Items with
  // `retryCount > 0` (e.g. restored from a failed turn) are deliberately
  // skipped here — the user must explicitly act on them to avoid re-entering
  // the same failure mode automatically.
  const allItems = pendingQueueManager.list(sessionId);
  const next = allItems.find(
    (item) => (item.retryCount ?? 0) === 0 && item.status === 'queued',
  );
  if (!next) return;

  // If there are blocking failed items in front of this one, also skip — the
  // user expects FIFO order, so we should not silently jump ahead of a failed
  // entry. Once they clear / send-now the failed entry, the listener will
  // re-fire on the next IDLE state event.
  const blockedByFailed = allItems
    .slice(0, allItems.indexOf(next))
    .some((item) => (item.retryCount ?? 0) > 0 || item.status === 'failed');
  if (blockedByFailed) {
    log.debug('Auto-drain blocked by a failed item ahead of head', {
      sessionId,
      pending: allItems.length,
    });
    return;
  }

  pendingQueueManager.setStatus(sessionId, next.id, 'sending');

  try {
    await sendMessage(
      context,
      next.content,
      sessionId,
      next.displayMessage,
      next.agentType,
      undefined,
      {
        imageContexts: next.imageContexts as ImageInputContextData[] | undefined,
        imageDisplayData: next.imageDisplayData as
          | Array<{
              id: string;
              name: string;
              dataUrl?: string;
              imagePath?: string;
              mimeType?: string;
            }>
          | undefined,
        pendingQueueDraft: next.composerDraft,
        userMessageMetadata: next.userMessageMetadata,
        bypassPendingQueue: true,
      },
    );
    // Only remove the item AFTER sendMessage completes successfully so we keep
    // the original id / timestamp / retryCount on failure (no UI flicker, no
    // reset of the retry counter, and FIFO order is preserved).
    pendingQueueManager.remove(sessionId, next.id);
  } catch (error) {
    log.error('Failed to drain pending queue item', { sessionId, itemId: next.id, error });
    // Mark in place. The auto-drain listener skips `failed` items so the user
    // can edit / send-now / delete without entering a tight retry loop.
    pendingQueueManager.setStatus(sessionId, next.id, 'failed');
  }
}

let queueDrainListenerInstalled = false;
let queueDrainContext: FlowChatContext | null = null;

const scheduledQueueDrains = new Set<string>();

function schedulePendingQueueDrain(sessionId: string): void {
  const scope = getActiveSurfaceScope();
  const key = JSON.stringify([scope.surfaceId, scope.epoch, sessionId]);
  if (scheduledQueueDrains.has(key)) return;
  scheduledQueueDrains.add(key);
  queueMicrotask(() => {
    scheduledQueueDrains.delete(key);
    if (!scope.isCurrent() || !queueDrainContext) return;
    if (pendingQueueManager.list(sessionId).length === 0) return;
    void drainPendingQueue(queueDrainContext, sessionId);
  });
}

/** Install (once) the state-machine listener that drains the queue when a session returns to IDLE. */
export function installPendingQueueDrainListener(context: FlowChatContext): void {
  queueDrainContext = context;
  if (queueDrainListenerInstalled) {
    return;
  }
  queueDrainListenerInstalled = true;
  stateMachineManager.subscribeGlobal((sessionId, machine) => {
    if (machine.currentState !== SessionExecutionState.IDLE) return;
    schedulePendingQueueDrain(sessionId);
  });
  subscribeRuntimeSessionAttachmentFinished((surfaceId, sessionId) => {
    if (surfaceId === getActiveSurfaceId()) schedulePendingQueueDrain(sessionId);
  });
}
