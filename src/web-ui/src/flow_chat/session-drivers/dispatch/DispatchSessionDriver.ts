/**
 * Dispatch session driver: controller-side observer projections of jobs that
 * execute on a detached target (SSH host or paired device).
 *
 * The projection contract (see `features/dispatch/README.md`): the target CLI
 * owns the durable session and event log; this controller owns only the
 * outbound observer index and a rendered transcript cache. Nothing here may
 * call `agentAPI.createSession`, `start_dialog_turn`, restore, or local
 * session persistence for a projection.
 */

import { createLogger } from '@/shared/utils/logger';
import { i18nService } from '@/infrastructure/i18n';
import type {
  PermissionReplyKind,
  PermissionRequest,
} from '@/infrastructure/api/service-api/AgentAPI';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import type { FlowChatContext, SessionConfig } from '../../services/flow-chat-manager/types';
import type { DialogTurn, Session } from '../../types/flow-chat';
import { FlowChatStore } from '../../store/FlowChatStore';
import { selectActivePermissionBatch } from '../../components/modern/permissionRequestRouting';
import type {
  SessionCascadeRemoval,
  SessionCreationSeed,
  SessionDriver,
  CompactSessionResult,
  SessionDriverNavigationStatusSource,
  SessionDriverOwnershipSource,
  StartTurnInput,
  StartTurnResult,
  SubmissionDraft,
  SubmissionPlan,
  TurnTracker,
  UsageReportUiParams,
} from '../types';
import {
  isDispatchJobTerminal,
  isNonLocalDispatchTarget,
  type DispatchTarget,
} from '@/features/dispatch/types';
import { dispatchApi } from '@/features/dispatch/dispatchApi';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { forgetDispatchTranscript } from '@/features/dispatch/dispatchTranscriptCache';
import { requestDispatchJobRefresh } from '@/features/dispatch/DispatchJobObserver';
import { arePendingPermissionsConfirmed, dispatchJobDeliveryStatus } from '@/features/dispatch/dispatchTransport';
import { isOutcomeUnknownError } from '@/infrastructure/api/errors/TauriCommandError';
import { markOptimisticDispatchTurnMetadata } from '@/features/dispatch/optimisticDispatchTurn';
import { openDispatchSessionFile, readDispatchSessionImage, downloadDispatchSessionFile } from '@/features/dispatch/dispatchFileNavigation';
import { cleanupSaveState } from '../../services/flow-chat-manager/PersistenceModule';
import { cleanupSessionBuffers } from '../../services/flow-chat-manager/TextChunkModule';
import { sessionProjectWorkspacePath } from '../../utils/sessionWorkspace';
import {
  clearRuntimeStatusState,
  showRuntimeStatus,
} from '../../store/runtimeStatusStore';
import { claimSubmissionRetry, releaseSubmissionRetry } from '../idempotency';
import { addSubmittedDialogTurn, applyGeneratingTitlePlaceholder } from '../shared';
import { confirmUncertainDispatchSubmission, DISPATCH_SUBMITTING_GRACE_MS } from '../../services/uncertainSubmission';

const log = createLogger('DispatchSessionDriver');

const DEVICE_ATTACHMENT_BUDGET_BYTES = 192 * 1024;
const APPEND_RETRY_SCOPE = 'dispatch-append';
const CONTINUE_RETRY_SCOPE = 'dispatch-continue';
const COMPACT_RETRY_SCOPE = 'dispatch-compact';
const EMPTY_PENDING_PERMISSIONS: ReadonlyArray<Record<string, unknown>> = [];
/**
 * Stop requests are idempotent on the target (a durable cancel marker), so a
 * transport failure is retried a few times before the outcome is reported as
 * unconfirmed. Exported for tests.
 */
export const DISPATCH_CANCEL_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * The durable job observed by a projection session. The bound config id wins;
 * the observer-store fallback covers the startup window before
 * `ensureProjection` binds the config.
 */
function jobIdForSession(sessionId: string): string | undefined {
  const session = FlowChatStore.getInstance().getState().sessions.get(sessionId);
  const configured = session?.config.dispatchJobId?.trim();
  if (configured) {
    return configured;
  }
  return Object.values(dispatchJobStore.getState().jobs)
    .find(job => job.sessionId === sessionId)?.jobId;
}

const dispatchNavigationStatusSource: SessionDriverNavigationStatusSource = {
  subscribe: listener => dispatchJobStore.subscribe(listener),
  getSnapshot: sessionId => {
    const jobId = jobIdForSession(sessionId);
    const reachability = jobId
      ? dispatchJobStore.getState().transportByJobId[jobId]?.reachability
      : undefined;
    if (!reachability) return {};
    // Navigation only distinguishes observable from not observable. A job the
    // target does not know cannot be observed either; the chat explains which.
    return { reachability: reachability === 'notFound' ? 'unreachable' : reachability };
  },
};

interface PermissionSnapshotCache {
  pending: ReadonlyArray<Record<string, unknown>> | undefined;
  answered: readonly string[] | undefined;
  confirmed: boolean;
  value: ReadonlyArray<Record<string, unknown>>;
}

const permissionSnapshotCache = new Map<string, PermissionSnapshotCache>();

/**
 * The actionable prompts of a job: only those a successful status read has
 * confirmed, minus the ones this controller already answered. Prompts restored
 * from disk or kept while the target is unreachable are not offered, so a reply
 * cannot go to a request the target may have resolved or expired.
 *
 * The result is cached per session so `useSyncExternalStore` sees a stable
 * reference while nothing relevant changed.
 */
export function actionableDispatchPermissions(
  sessionId: string,
): ReadonlyArray<Record<string, unknown>> {
  const jobId = jobIdForSession(sessionId);
  if (!jobId) {
    return EMPTY_PENDING_PERMISSIONS;
  }
  const state = dispatchJobStore.getState();
  const pending = state.jobs[jobId]?.pendingPermissions;
  const answered = state.answeredPermissionIdsByJobId[jobId];
  const confirmed = arePendingPermissionsConfirmed(jobId);
  const cached = permissionSnapshotCache.get(sessionId);
  if (
    cached
    && cached.pending === pending
    && cached.answered === answered
    && cached.confirmed === confirmed
  ) {
    return cached.value;
  }
  let value: ReadonlyArray<Record<string, unknown>> = EMPTY_PENDING_PERMISSIONS;
  if (confirmed && pending?.length) {
    const answeredIds = new Set(answered ?? []);
    const unanswered = answeredIds.size === 0
      ? pending
      : pending.filter(request => (
        typeof request.requestId !== 'string' || !answeredIds.has(request.requestId)
      ));
    value = unanswered.length > 0 ? unanswered : EMPTY_PENDING_PERMISSIONS;
  }
  if (permissionSnapshotCache.size > 256) {
    permissionSnapshotCache.clear();
  }
  permissionSnapshotCache.set(sessionId, { pending, answered, confirmed, value });
  return value;
}

/**
 * Answer prompts optimistically: they leave the actionable list at once and
 * come back only if the answer could not be delivered.
 */
async function answerDispatchPermissions(
  jobId: string,
  requestIds: string[],
  reply: PermissionReplyKind,
  feedback?: string,
): Promise<void> {
  if (!arePendingPermissionsConfirmed(jobId)) {
    throw new Error(
      i18nService.t('flow-chat:chatInput.dispatch.errors.permissionNotConfirmed'),
    );
  }
  const store = dispatchJobStore.getState();
  store.markPermissionsAnswered(jobId, requestIds);
  const delivered: string[] = [];
  try {
    for (const requestId of requestIds) {
      await dispatchApi.answerPermission(jobId, requestId, reply, feedback);
      delivered.push(requestId);
    }
  } catch (error) {
    dispatchJobStore.getState().unmarkPermissionsAnswered(
      jobId,
      requestIds.filter(requestId => !delivered.includes(requestId)),
    );
    requestDispatchJobRefresh(jobId);
    throw error;
  }
  requestDispatchJobRefresh(jobId);
}

function cancelRetryDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isClientDeadlineError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 'REQUEST_TIMEOUT' || message === 'Request timeout';
}

/**
 * Ask the target to stop a job, retrying transport failures. The outcome is
 * recorded in the observer store so the chat can show `stopping` until the
 * target reports a terminal state, or `unconfirmed` when no attempt landed.
 */
export async function cancelDispatchJob(jobId: string): Promise<boolean> {
  const store = dispatchJobStore.getState();
  if (isDispatchJobTerminal(store.jobs[jobId]?.state)) {
    store.setCancelState(jobId, undefined);
    return false;
  }
  store.setCancelState(jobId, 'stopping');
  let lastError: unknown;
  for (let attempt = 0; attempt <= DISPATCH_CANCEL_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await cancelRetryDelay(DISPATCH_CANCEL_RETRY_DELAYS_MS[attempt - 1]);
      if (isDispatchJobTerminal(dispatchJobStore.getState().jobs[jobId]?.state)) {
        dispatchJobStore.getState().setCancelState(jobId, undefined);
        return false;
      }
      // A follow-up accepted meanwhile (an earlier attempt landed after all)
      // clears `stopping`; retrying would cancel the user's new turn.
      if (dispatchJobStore.getState().cancelStateByJobId?.[jobId] !== 'stopping') {
        return false;
      }
    }
    try {
      const response = await dispatchApi.cancel(jobId);
      // `cancelled: false` on a live job means the target recorded the request
      // and the worker stops itself; the observer clears `stopping` once the
      // target reports a terminal state.
      requestDispatchJobRefresh(jobId);
      return response.cancelled;
    } catch (error) {
      lastError = error;
      log.warn('Dispatch stop request failed', {
        jobId,
        attempt: attempt + 1,
        error,
      });
    }
  }
  dispatchJobStore.getState().setCancelState(jobId, 'unconfirmed');
  requestDispatchJobRefresh(jobId);
  log.warn('Dispatch stop request was not confirmed by the target', {
    jobId,
    error: lastError,
  });
  throw new Error(
    i18nService.t('flow-chat:chatInput.dispatch.errors.stopUnconfirmed'),
  );
}

const dispatchOwnershipSource: SessionDriverOwnershipSource = {
  subscribe: listener => dispatchJobStore.subscribe(listener),
};

/**
 * Convert composer image contexts into inline wire attachments. Throws when a
 * context has no data URL (path-only) or a device target's inline budget is
 * exceeded — both need the user to adjust, not silent truncation.
 */
function dispatchAttachments(
  session: Session | undefined,
  imageContexts: readonly { id: string; data_url?: string; mime_type: string; metadata?: Record<string, unknown> }[] | undefined,
): import('@/features/dispatch/dispatchApi').DispatchInlineAttachment[] | undefined {
  if (!imageContexts?.length) {
    return undefined;
  }
  const attachments = imageContexts.map(image => {
    const dataUrl = image.data_url?.trim();
    if (!dataUrl) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.attachmentUnavailable'),
      );
    }
    const name = typeof image.metadata?.name === 'string' ? image.metadata.name : undefined;
    return {
      id: image.id,
      name,
      mimeType: image.mime_type,
      dataUrl,
    };
  });
  if (session?.config.dispatchTarget?.kind === 'device') {
    const total = attachments.reduce((sum, attachment) => sum + attachment.dataUrl.length, 0);
    if (total > DEVICE_ATTACHMENT_BUDGET_BYTES) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.deviceAttachmentTooLarge'),
      );
    }
  }
  return attachments;
}

async function appendToDispatchJob(
  sessionId: string,
  jobId: string,
  message: string,
  displayMessage: string | undefined,
  attachments?: import('@/features/dispatch/dispatchApi').DispatchInlineAttachment[],
): Promise<void> {
  // Keep the id stable across an ambiguous transport failure. A retry with
  // the same message can then ask the target mailbox for the same idempotent
  // append instead of injecting the steering text twice.
  const retry = claimSubmissionRetry(
    APPEND_RETRY_SCOPE,
    sessionId,
    message,
    displayMessage,
    () =>
      globalThis.crypto?.randomUUID?.()
      ?? `dispatch-message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const response = await dispatchApi.append(
    jobId,
    message,
    displayMessage,
    retry.id,
    attachments,
  );
  if (!response.accepted) {
    releaseSubmissionRetry(APPEND_RETRY_SCOPE, sessionId, retry.id);
    throw new Error(
      i18nService.t('flow-chat:chatInput.dispatch.errors.appendRejected'),
    );
  }
  releaseSubmissionRetry(APPEND_RETRY_SCOPE, sessionId, retry.id);
  requestDispatchJobRefresh(jobId);
}

/**
 * Start the next turn of a finished dispatch job.
 *
 * The optimistic turn mirrors the first-message path so the user sees their
 * message immediately; the target's own `DialogTurnStarted` adopts it once
 * the follow-up worker starts.
 */
async function continueDispatchJob(
  context: FlowChatContext,
  input: StartTurnInput,
  jobId: string,
): Promise<void> {
  const { sessionId, message, displayMessage } = input;
  const followUpSession =
    context.flowChatStore.getState().sessions.get(sessionId) ?? input.readySession;
  const followUpAgentType =
    (input.currentAgentType?.trim() || followUpSession.mode || 'Standard').trim();
  // The composer edits these between turns; the follow-up carries them as
  // per-turn overrides which the target persists onto the job.
  const turnModel = followUpSession.config.dispatchModel?.trim() || undefined;
  const turnReasoningPreset = followUpSession.config.dispatchReasoningPreset?.trim() || undefined;
  const turnApprovalPolicy = followUpSession.config.dispatchApprovalPolicy;
  const turnAttachments = dispatchAttachments(followUpSession, input.options?.imageContexts);
  // Reused across retries so a lost response cannot start two turns. The
  // match key includes the per-turn options and attachment ids: the target
  // refuses a turnId bound to different content, so changed inputs must mint
  // a new turn id.
  const retry = claimSubmissionRetry(
    CONTINUE_RETRY_SCOPE,
    sessionId,
    JSON.stringify([
      message,
      turnModel ?? null,
      turnReasoningPreset ?? null,
      turnApprovalPolicy ?? null,
      turnAttachments?.map(attachment => attachment.id) ?? null,
    ]),
    displayMessage,
    () =>
      globalThis.crypto?.randomUUID?.()
      ?? `dispatch-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const optimisticTurnId = `dispatch_pending_${jobId}`;
  addSubmittedDialogTurn(context, input.surfaceScope, sessionId, {
    id: optimisticTurnId,
    sessionId,
    agentType: followUpAgentType,
    userMessage: {
      id: `user_dispatch_${retry.id}`,
      content: displayMessage || message,
      timestamp: Date.now(),
      hasImages: (input.options?.imageDisplayData?.length ?? 0) > 0,
      images: input.options?.imageDisplayData,
      metadata: markOptimisticDispatchTurnMetadata(
        input.options?.userMessageMetadata,
        jobId,
      ),
    },
    modelRounds: [],
    status: 'pending',
    startTime: Date.now(),
  });

  let response: Awaited<ReturnType<typeof dispatchApi.continueJob>>;
  try {
    response = await dispatchApi.continueJob(
      jobId,
      retry.id,
      message,
      displayMessage,
      {
        model: turnModel,
        reasoningPreset: turnReasoningPreset,
        approvalPolicy: turnApprovalPolicy,
        ...(turnAttachments ? { attachments: turnAttachments } : {}),
      },
    );
  } catch (error) {
    // The target may have queued the turn before the response was lost. Keep
    // the retry id (the target dedupes a resend of the same intent) and let
    // the observer pull the job's events, so an accepted turn still appears.
    context.flowChatStore.deleteDialogTurn(sessionId, optimisticTurnId);
    settleUncertainFollowUp(jobId);
    throw error;
  }
  releaseSubmissionRetry(CONTINUE_RETRY_SCOPE, sessionId, retry.id);
  if (!response.accepted) {
    context.flowChatStore.deleteDialogTurn(sessionId, optimisticTurnId);
    throw new Error(
      i18nService.t('flow-chat:chatInput.dispatch.errors.followUpRejected'),
    );
  }
  // The accepted response reports the target's post-queue state. Applying
  // it here reopens the observer's drain gate, which stays shut for a
  // terminal job even after the outbound record leaves its terminal state.
  dispatchJobStore.getState().markFollowUpAccepted(jobId, response.state);
  requestDispatchJobRefresh(jobId);
}

/** A follow-up request of unknown outcome: observe the job instead of assuming either way. */
function settleUncertainFollowUp(jobId: string): void {
  dispatchJobStore.getState().reopenTerminalObservation(jobId);
  requestDispatchJobRefresh(jobId);
}

/**
 * Fixed context budget for projections: no controller-side provider is ever
 * resolved for them, so there is no model to read a real window from.
 */
const DISPATCH_OBSERVER_MAX_CONTEXT_TOKENS = 128128;

function dismissDispatchObserverProjection(
  sessionId: string,
  session: Session | undefined,
): void {
  // Collect before dismissing: dismissSession removes the store entries that
  // are the only remaining link from this session to its cached transcripts.
  const jobIds = new Set(
    Object.values(dispatchJobStore.getState().jobs)
      .filter(job => job.sessionId === sessionId)
      .map(job => job.jobId),
  );
  const configuredJobId = session?.config.dispatchJobId?.trim();
  if (configuredJobId) {
    jobIds.add(configuredJobId);
  }

  dispatchJobStore.getState().dismissSession(
    sessionId,
    session?.config.dispatchJobId,
  );

  // The projection is gone for good, so its cached transcript must not stay
  // readable on disk until retention gets around to it.
  jobIds.forEach(jobId => {
    void forgetDispatchTranscript(jobId);
  });
}

function removeProjectionLocally(
  context: FlowChatContext,
  sessionId: string,
  removal: SessionCascadeRemoval,
): void {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  dismissDispatchObserverProjection(sessionId, session);
  context.flowChatStore.removeSession(
    sessionId,
    removal.removedActiveSession ? { nextActiveSessionId: null } : undefined,
  );
  removal.removedSessionIds.forEach(id => {
    context.processingManager.clearSessionStatus(id);
    cleanupSaveState(context, id);
    cleanupSessionBuffers(context, id);
  });
}

export const dispatchSessionDriver: SessionDriver = {
  fileAccess: { open: openDispatchSessionFile, readImage: readDispatchSessionImage, download: downloadDispatchSessionFile },
  id: 'dispatch',
  navigationStatusSource: dispatchNavigationStatusSource,
  ownershipSource: dispatchOwnershipSource,

  confirmUncertainSubmission(context, submission, error) {
    const { sessionId } = submission;
    const jobId = context.flowChatStore.getState().sessions.get(sessionId)?.config.dispatchJobId;
    if (!jobId) return undefined;
    return confirmUncertainDispatchSubmission(context, submission, {
      // The observer reports a job the target never received as
      // `notFound` reachability while its state stays unacknowledged.
      read: () => (dispatchJobDeliveryStatus(jobId) === 'notDelivered' ? 'not_delivered'
        : dispatchJobStore.getState().jobs?.[jobId]?.state
          ?? context.flowChatStore.getState().sessions.get(sessionId)?.config.dispatchJobState),
      subscribe: listener => {
        const unsubscribeJobs = dispatchJobStore.subscribe(listener);
        const unsubscribeSession = context.flowChatStore.subscribe(listener);
        return () => { unsubscribeJobs(); unsubscribeSession(); };
      },
      // A client deadline says nothing about the target; only a failure that
      // provably happened before sending may settle by grace.
      submittingGraceMs: isOutcomeUnknownError(error) || isClientDeadlineError(error)
        ? undefined : DISPATCH_SUBMITTING_GRACE_MS,
      refresh: () => requestDispatchJobRefresh(jobId),
    });
  },

  async createSession(context: FlowChatContext, seed: SessionCreationSeed): Promise<string> {
    if (seed.config.modelPoolId) throw new Error(i18nService.t('flow-chat:modelSelector.pools.surfaceUnsupported'));
    const {
      surfaceScope,
      config,
      agentType,
      sessionName,
      titleDescriptor,
      workspacePath,
      projectWorkspacePath,
      workspaceId,
      remoteConnectionId,
      remoteSshHost,
    } = seed;
    surfaceScope.assertCurrent('start dispatch session creation');

    if (!isNonLocalDispatchTarget(config.dispatchTargetRequest)) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.targetInvalid'),
      );
    }
    const dispatchTarget: DispatchTarget = config.dispatchTarget
      ?? (
        config.dispatchTargetRequest.kind === 'ssh'
          ? {
              ...config.dispatchTargetRequest,
              displayName: config.dispatchTargetRequest.connectionId,
            }
          : {
              ...config.dispatchTargetRequest,
              displayName: config.dispatchTargetRequest.deviceId,
            }
      );
    const sessionId =
      globalThis.crypto?.randomUUID?.()
      ?? `dispatch-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const jobId =
      config.dispatchJobId?.trim()
      || `dispatch-${globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const approvalPolicy = config.dispatchApprovalPolicy;
    if (!approvalPolicy) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.approvalRequired'),
      );
    }
    const resolvedConfig: SessionConfig = {
      ...config,
      // A dispatch projection must not inherit or resolve a controller-side
      // provider. The target selection, when explicit, lives in dispatchModel.
      modelName: undefined,
      workspaceId: workspaceId ?? config.workspaceId,
      workspacePath,
      projectWorkspacePath,
      dispatchTargetRequest: config.dispatchTargetRequest,
      dispatchTarget,
      dispatchJobId: jobId,
      dispatchApprovalPolicy: approvalPolicy,
      dispatchIncludeUncommitted: config.dispatchIncludeUncommitted ?? false,
      dispatchBaseRef: config.dispatchBaseRef?.trim() || 'HEAD',
      dispatchJobState: 'submitting',
      dispatchCursor: 0,
    };

    // This is an observer projection only. In particular, do not call
    // agentAPI.createSession: the target CLI owns the durable session.
    surfaceScope.assertCurrent('create dispatch session projection');
    context.flowChatStore.createSession(
      sessionId,
      resolvedConfig,
      undefined,
      sessionName,
      DISPATCH_OBSERVER_MAX_CONTEXT_TOKENS,
      agentType,
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
      titleDescriptor,
    );
    dispatchJobStore.getState().registerJob({
      jobId,
      sessionId,
      targetRequest: config.dispatchTargetRequest,
      target: dispatchTarget,
      sourceWorkspacePath: workspacePath,
      sourceWorkspaceId: resolvedConfig.workspaceId,
      title: sessionName,
      agentType,
      approvalPolicy,
      // Do not inherit the controller's model selector. An omitted target
      // model lets the probed target use its own configured default.
      model: config.dispatchModel?.trim() || undefined,
      reasoningPreset: config.dispatchReasoningPreset?.trim() || undefined,
      modelCatalog: config.dispatchModelCatalog,
      availableModels: config.dispatchAvailableModels,
      defaultModel: config.dispatchDefaultModel,
      cursor: 0,
      state: 'submitting',
      appliedEventIds: [],
      pendingPermissions: [],
      eventLogComplete: true,
      historyTruncated: false,
      omittedEventCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return sessionId;
  },

  async deleteSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    const observerJobIds = Object.values(dispatchJobStore.getState().jobs)
      .filter(job => job.sessionId === sessionId)
      .map(job => job.jobId);
    log.info('Dispatch diagnostic: projection delete evaluated', {
      sessionId,
      sessionFound: Boolean(session),
      dispatchTargetKind: session?.config.dispatchTarget?.kind,
      dispatchJobId: session?.config.dispatchJobId,
      observerJobIds,
      cascadeSessionIds: removal.removedSessionIds,
    });
    removeProjectionLocally(context, sessionId, removal);
    log.info('Dispatch diagnostic: projection removed from flow chat store', {
      sessionId,
      activeSessionId: context.flowChatStore.getState().activeSessionId,
    });
  },

  async archiveSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void> {
    // Archiving an observer projection is a local dismiss: the target keeps
    // its durable session; the tombstone stops reconciliation reviving it.
    removeProjectionLocally(context, sessionId, removal);
  },

  async renameSession(
    context: FlowChatContext,
    sessionId: string,
    title: string,
  ): Promise<string> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    await context.flowChatStore.updateSessionTitle(sessionId, title, 'generated');
    if (session.config.dispatchJobId) {
      dispatchJobStore.getState().updateTitle(session.config.dispatchJobId, title);
    }
    return title;
  },

  ensureReady(): void {
    // Nothing to prepare: the target owns the durable session, and submission
    // itself is what creates the job. Deliberately synchronous — see the
    // interface note about the optimistic-projection timing invariant.
  },

  async cancel(context: FlowChatContext, sessionId: string): Promise<boolean> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    const jobId = session?.config.dispatchJobId;
    if (!jobId) {
      return false;
    }
    const cancelled = await cancelDispatchJob(jobId);
    if (cancelled) {
      context.userCancelledSessionIds.add(sessionId);
    }
    return cancelled;
  },

  async compactSession(context: FlowChatContext, sessionId: string, turnId?: string): Promise<CompactSessionResult> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    const jobId = session?.config.dispatchJobId;
    if (!jobId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    const state = session?.config.dispatchJobState;
    if (!isDispatchJobTerminal(state)) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.compactWhileRunning'),
      );
    }
    // Same idempotency contract as a prompt follow-up: a retried request
    // reuses the turn id so a lost response cannot start two compactions.
    const retry = claimSubmissionRetry(
      COMPACT_RETRY_SCOPE,
      sessionId,
      'compact',
      undefined,
      () =>
        turnId
        ?? globalThis.crypto?.randomUUID?.()
        ?? `dispatch-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    let response: Awaited<ReturnType<typeof dispatchApi.continueJob>>;
    try {
      response = await dispatchApi.continueJob(jobId, retry.id, '', undefined, {
        kind: 'compact',
      });
    } catch (error) {
      // Unknown outcome: keep the id for an idempotent retry and observe.
      settleUncertainFollowUp(jobId);
      throw error;
    }
    releaseSubmissionRetry(COMPACT_RETRY_SCOPE, sessionId, retry.id);
    if (!response.accepted) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.compactRejected'),
      );
    }
    // Same as a prompt follow-up: reopen the observer's drain gate with the
    // target-reported state, or the compact turn's events are never pulled.
    dispatchJobStore.getState().markFollowUpAccepted(jobId, response.state);
    requestDispatchJobRefresh(jobId);
    return { accepted: true, turnId: retry.id };
  },

  async runUsageReport(
    context: FlowChatContext,
    sessionId: string,
    uiParams: UsageReportUiParams,
  ): Promise<{ shown: boolean }> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    const jobId = jobIdForSession(sessionId);
    if (!jobId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    const { runUsageReportCommand } = await import('../../services/usageReportService');
    const result = await runUsageReportCommand({
      session,
      ...uiParams,
      // The target computes the report from its persisted session; nothing is
      // written back, here or there.
      fetchReport: async () => {
        const response = await dispatchApi.query(jobId, 'usageReport');
        return response.report as SessionUsageReport;
      },
    });
    return { shown: result.shown };
  },

  permissionRequestSource(sessionId: string) {
    return {
      subscribe: (listener: () => void) => dispatchJobStore.subscribe(listener),
      getSnapshot: () => actionableDispatchPermissions(sessionId),
    };
  },

  async respondPermission(
    sessionId: string,
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
  ): Promise<void> {
    const jobId = jobIdForSession(sessionId);
    if (!jobId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    await answerDispatchPermissions(jobId, [requestId], reply, feedback);
  },

  async respondPermissionBatch(
    sessionId: string,
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
  ): Promise<string[]> {
    const jobId = jobIdForSession(sessionId);
    if (!jobId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    const pending = actionableDispatchPermissions(sessionId) as unknown as PermissionRequest[];
    const batch = selectActivePermissionBatch(pending, sessionId);
    const requestIds = batch?.requests.map(request => request.requestId) ?? [requestId];
    await answerDispatchPermissions(jobId, requestIds, reply, feedback);
    // The observer store refreshes from the target; there is no local
    // subscription state to reconcile.
    return [];
  },

  planSubmission(context: FlowChatContext, sessionId: string): SubmissionPlan {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (
      !isNonLocalDispatchTarget(session?.config.dispatchTarget)
      || !session?.config.dispatchJobId
      || (
        session.config.dispatchJobState !== 'queued'
        && session.config.dispatchJobState !== 'running'
      )
    ) {
      return { kind: 'queue' };
    }
    return { kind: 'steer' };
  },

  async steer(
    context: FlowChatContext,
    sessionId: string,
    draft: SubmissionDraft,
  ): Promise<void> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    const jobId = session?.config.dispatchJobId;
    if (!jobId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    await appendToDispatchJob(
      sessionId,
      jobId,
      draft.message,
      draft.displayMessage,
      dispatchAttachments(session, draft.imageContexts),
    );
  },

  async startTurn(
    context: FlowChatContext,
    input: StartTurnInput,
    tracker: TurnTracker,
  ): Promise<StartTurnResult> {
    const {
      sessionId,
      message,
      displayMessage,
      currentAgentType,
      isFirstMessage,
      readySession,
      options,
    } = input;

    if (readySession.config.modelPoolId) throw new Error(i18nService.t('flow-chat:modelSelector.pools.surfaceUnsupported'));
    const targetRequest = readySession.config.dispatchTargetRequest;
    const jobId = readySession.config.dispatchJobId;
    const approvalPolicy = readySession.config.dispatchApprovalPolicy;
    if (!targetRequest || targetRequest.kind === 'local' || !jobId || !approvalPolicy) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionUnavailable'),
      );
    }
    const dispatchState = readySession.config.dispatchJobState;
    if (dispatchState === 'queued' || dispatchState === 'running') {
      // A turn is already in flight; this message steers it rather than
      // starting another one underneath it. Attachments ride along.
      await appendToDispatchJob(
        sessionId,
        jobId,
        message,
        displayMessage,
        dispatchAttachments(readySession, options?.imageContexts),
      );
      return 'detached';
    }
    if (dispatchState && isDispatchJobTerminal(dispatchState)) {
      // The previous turn finished. A dispatch session is a conversation, so
      // this starts the next turn against the same target session, worktree,
      // and event log instead of refusing the message.
      await continueDispatchJob(context, input, jobId);
      return 'detached';
    }
    if (
      dispatchState !== 'submitting' &&
      dispatchState !== 'submission_unknown'
    ) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.sessionNotReady'),
      );
    }
    if (isFirstMessage) {
      applyGeneratingTitlePlaceholder(context, sessionId, message);
    }

    const submitAttachments = dispatchAttachments(readySession, options?.imageContexts);
    const optimisticTurnId = `dispatch_pending_${jobId}`;
    const optimisticTurn: DialogTurn = {
      id: optimisticTurnId,
      sessionId,
      agentType: currentAgentType,
      userMessage: {
        id: `user_dispatch_${Date.now()}`,
        content: displayMessage || message,
        timestamp: Date.now(),
        hasImages: (options?.imageDisplayData?.length ?? 0) > 0,
        images: options?.imageDisplayData,
        metadata: markOptimisticDispatchTurnMetadata(
          options?.userMessageMetadata,
          jobId,
        ),
      },
      modelRounds: [],
      status: 'pending',
      startTime: Date.now(),
    };
    addSubmittedDialogTurn(context, input.surfaceScope, sessionId, optimisticTurn);
    tracker.createdLocalTurnId = optimisticTurnId;

    const includeUncommitted = readySession.config.dispatchIncludeUncommitted ?? false;
    const baseRef = readySession.config.dispatchBaseRef?.trim() || 'HEAD';
    const sourceWorkspacePath = sessionProjectWorkspacePath(readySession);
    const sourceWorkspaceId =
      readySession.workspaceId || readySession.config.workspaceId;
    const transferRoundId = `dispatch-transfer:${jobId}`;
    // Provisioning is always more than a submit now — a worktree is created,
    // the target checks out the baseline, and objects may be transferred —
    // so the transfer label always applies.
    showRuntimeStatus({
      sessionId,
      turnId: optimisticTurnId,
      roundId: transferRoundId,
      label: i18nService.t('flow-chat:chatInput.dispatch.transferInProgress'),
    });
    let response: Awaited<ReturnType<typeof dispatchApi.submit>>;
    tracker.hostSubmitStarted = true;
    try {
      response = await dispatchApi.submit({
        target: targetRequest,
        baseRef,
        includeUncommitted,
        jobId,
        sessionId,
        agentType: currentAgentType,
        prompt: message,
        approvalPolicy,
        model: readySession.config.dispatchModel?.trim() || undefined,
        reasoningPreset: readySession.config.dispatchReasoningPreset?.trim() || undefined,
        ...(sourceWorkspacePath ? { sourceWorkspacePath } : {}),
        ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
        ...(submitAttachments ? { attachments: submitAttachments } : {}),
      });
    } finally {
      clearRuntimeStatusState({
        sessionId,
        turnId: optimisticTurnId,
        roundId: transferRoundId,
      });
    }
    if (!response.accepted || response.jobId !== jobId || response.sessionId !== sessionId) {
      throw new Error(
        i18nService.t('flow-chat:chatInput.dispatch.errors.submissionUnconfirmed'),
      );
    }
    tracker.hostAcceptedTurn = true;
    context.flowChatStore.applyDispatchSnapshot(sessionId, {
      jobId,
      state: response.state,
      cursor: readySession.config.dispatchCursor ?? 0,
      expectedCursor: readySession.config.dispatchCursor ?? 0,
    });
    dispatchJobStore.getState().updateProgress(jobId, {
      state: response.state,
    });
    context.flowChatStore.updateSessionLastSubmittedMode(sessionId, currentAgentType);
    requestDispatchJobRefresh(jobId);
    return 'completed';
  },
};
