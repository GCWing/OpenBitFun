import { resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { i18nService } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { agenticEventListener } from '@/flow_chat/services/AgenticEventListener';
import type { FlowChatContext } from '@/flow_chat/services/flow-chat-manager/types';
import type { DialogTurn } from '@/flow_chat/types/flow-chat';
import { clearRuntimeStatus } from '@/flow_chat/services/flow-chat-manager/RuntimeStatusModule';
import { clearRuntimeStatusState } from '@/flow_chat/store/runtimeStatusStore';
import { stateMachineManager } from '@/flow_chat/state-machine';
import { markOptimisticDispatchTurnMetadata } from './optimisticDispatchTurn';
import {
  SessionExecutionEvent,
  SessionExecutionState,
} from '@/flow_chat/state-machine/types';
import { dispatchApi } from './dispatchApi';
import { dispatchJobStore, type DispatchObserverJob } from './dispatchJobStore';
import {
  dispatchTargetLaneKey,
  isDispatchJobNotFoundError,
} from './dispatchTransport';
import {
  cancelDispatchTranscriptSaves,
  flushDispatchTranscriptSave,
  loadDispatchTranscript,
  scheduleDispatchTranscriptSave,
} from './dispatchTranscriptCache';
import type {
  DispatchAgentEventEnvelope,
  DispatchEvent,
  DispatchJobState,
  DispatchStatusResponse,
} from './types';
import {
  isDispatchJobTerminal,
  isNonLocalDispatchTarget,
} from './types';

const log = createLogger('DispatchJobObserver');

export const DISPATCH_JOB_POLL_INTERVAL_MS = 1800;
export const DISPATCH_IDLE_DISCOVERY_INTERVAL_MS = 30_000;
/**
 * Periodic polls of a target that just failed are spaced out, doubling up to
 * the idle discovery interval. A hung SSH status costs several 30-second round
 * trips, so retrying it every 1.8 seconds only queues more work behind it.
 * Explicit refreshes (an answered permission, a follow-up) bypass the delay.
 */
export const DISPATCH_TARGET_BACKOFF_BASE_MS = 2 * DISPATCH_JOB_POLL_INTERVAL_MS;
export const DISPATCH_TARGET_BACKOFF_MAX_MS = DISPATCH_IDLE_DISCOVERY_INTERVAL_MS;
const BASELINE_WORKTREE_CHECK_INTERVAL_MS = 30_000;
const baselineWorktreeChecks = new Map<string, { path: string; checkedAt: number }>();

type RefreshRequester = (jobId?: string) => void;

interface DispatchObserverLease {
  requestRefresh: RefreshRequester;
  dispose: () => void;
}

type DispatchObserverGlobal = typeof globalThis & {
  __openbitfunDispatchJobObserverLease__?: DispatchObserverLease;
};

function getDispatchObserverGlobal(): DispatchObserverGlobal {
  return globalThis as DispatchObserverGlobal;
}

export function requestDispatchJobRefresh(jobId?: string): void {
  getDispatchObserverGlobal()
    .__openbitfunDispatchJobObserverLease__
    ?.requestRefresh(jobId);
}

const RAW_EVENT_NAMES: Record<string, string> = {
  SessionCreated: 'agentic://session-created',
  SessionDeleted: 'agentic://session-deleted',
  SessionStateChanged: 'agentic://session-state-changed',
  SessionTitleGenerated: 'session_title_generated',
  ImageAnalysisStarted: 'agentic://image-analysis-started',
  ImageAnalysisCompleted: 'agentic://image-analysis-completed',
  DialogTurnStarted: 'agentic://dialog-turn-started',
  // v4: the target admits linked subagent sessions into the job event log,
  // and the driver resolver treats child sessions of a projection as
  // observer-only through the parent chain.
  SubagentSessionLinked: 'agentic://subagent-session-linked',
  ModelRoundStarted: 'agentic://model-round-started',
  ModelRoundCompleted: 'agentic://model-round-completed',
  ModelRoundAttemptSuperseded: 'agentic://model-round-attempt-superseded',
  TextChunk: 'agentic://text-chunk',
  ThinkingChunk: 'agentic://text-chunk',
  ToolEvent: 'agentic://tool-event',
  DialogTurnCompleted: 'agentic://dialog-turn-completed',
  DialogTurnFailed: 'agentic://dialog-turn-failed',
  DialogTurnCancelled: 'agentic://dialog-turn-cancelled',
  TokenUsageUpdated: 'agentic://token-usage-updated',
  ContextCompressionStarted: 'agentic://context-compression-started',
  ContextCompressionCompleted: 'agentic://context-compression-completed',
  ContextCompressionFailed: 'agentic://context-compression-failed',
  ThreadGoalUpdated: 'agentic://thread-goal-updated',
  DeepReviewQueueStateChanged: 'agentic://deep-review-queue-state-changed',
  // Upgrade-only raw variant alias from pre-removal targets.
  SessionModelAutoMigrated: 'agentic://session-model-fallback-applied',
  SessionModelFallbackApplied: 'agentic://session-model-fallback-applied',
  SessionReasoningPresetAutoCleared: 'agentic://session-reasoning-preset-auto-cleared',
  UserSteeringInjected: 'agentic://user-steering-injected',
};

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [camelKey(key), camelize(nested)]),
  );
}

export function projectDispatchAgentEvent(
  dispatchEvent: Extract<DispatchEvent, { type: 'agentEvent' }>,
): { eventName: string; payload: Record<string, unknown>; envelopeId?: string } | null {
  const outer = dispatchEvent as unknown as Record<string, unknown>;
  const envelope = dispatchEvent.event as DispatchAgentEventEnvelope;
  const eventRecord = envelope?.event && typeof envelope.event === 'object'
    ? envelope.event
    : dispatchEvent.event;
  const projectedName =
    (typeof outer.frontendEventName === 'string' && outer.frontendEventName)
    || (typeof envelope?.frontendEventName === 'string' && envelope.frontendEventName);
  const projectedPayload =
    (outer.frontendPayload && typeof outer.frontendPayload === 'object'
      ? outer.frontendPayload
      : undefined)
    || (envelope?.frontendPayload && typeof envelope.frontendPayload === 'object'
      ? envelope.frontendPayload
      : undefined);
  if (projectedName && projectedPayload) {
    return {
      eventName: projectedName,
      payload: projectedPayload as Record<string, unknown>,
      envelopeId: typeof envelope?.id === 'string' ? envelope.id : undefined,
    };
  }

  if (!eventRecord || typeof eventRecord !== 'object') {
    return null;
  }
  const raw = eventRecord as Record<string, unknown>;
  const rawType = typeof raw.type === 'string' ? raw.type : '';
  const eventName = RAW_EVENT_NAMES[rawType];
  if (!eventName) {
    return null;
  }
  const payload = camelize(raw) as Record<string, unknown>;
  delete payload.type;
  if (rawType === 'ThinkingChunk') {
    payload.text = payload.content;
    payload.contentType = 'thinking';
    payload.isThinkingEnd = payload.isEnd;
    delete payload.content;
    delete payload.isEnd;
  }
  if (rawType === 'SessionTitleGenerated' && payload.timestamp === undefined) {
    payload.timestamp = Date.now();
  }
  if (
    rawType === 'SessionModelAutoMigrated'
    && (payload.newModelId === 'auto' || payload.newModelId === 'default')
  ) {
    payload.newModelId = 'primary';
  }
  return {
    eventName,
    payload,
    envelopeId: typeof envelope?.id === 'string' ? envelope.id : undefined,
  };
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function transportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The target answered, but has no record of the job. The transport is fine,
 * so this must not put the target's other jobs behind a backoff.
 */
class DispatchJobNotFoundOnTarget extends Error {
  constructor(readonly jobId: string, message: string) {
    super(message);
    this.name = 'DispatchJobNotFoundOnTarget';
  }
}

/**
 * The status read itself failed. Only this backs a target off; an error while
 * projecting a successful response says nothing about the transport.
 */
class DispatchTargetReadFailed extends Error {
  constructor(readonly cause: unknown) {
    super(transportErrorMessage(cause));
    this.name = 'DispatchTargetReadFailed';
  }
}

function isJobStillObserved(job: DispatchObserverJob): boolean {
  const state = dispatchJobStore.getState();
  return (
    state.jobs[job.jobId]?.sessionId === job.sessionId
    && !state.dismissedJobIds.includes(job.jobId)
    && !state.dismissedSessionIds.includes(job.sessionId)
  );
}

async function checkBaselineWorktree(job: DispatchObserverJob): Promise<void> {
  const path = job.baselineWorktreePath?.trim();
  if (!path) return;
  const previous = baselineWorktreeChecks.get(job.jobId);
  const now = Date.now();
  if (
    previous?.path === path
    && now - previous.checkedAt < BASELINE_WORKTREE_CHECK_INTERVAL_MS
  ) {
    return;
  }
  baselineWorktreeChecks.set(job.jobId, { path, checkedAt: now });
  if (baselineWorktreeChecks.size > 2048) {
    baselineWorktreeChecks.clear();
    baselineWorktreeChecks.set(job.jobId, { path, checkedAt: now });
  }
  try {
    const exists = await systemAPI.checkPathExists(path);
    dispatchJobStore.getState().setBaselineWorktreeMissing(job.jobId, !exists);
  } catch (error) {
    // Availability is advisory here. The sync command performs the
    // authoritative check and returns a typed, user-visible failure.
    log.warn('Failed to check dispatch baseline worktree', {
      jobId: job.jobId,
      path,
      error,
    });
  }
}

export function dispatchEventId(event: DispatchEvent): string {
  if (event.type === 'agentEvent') {
    const envelope = event.event as DispatchAgentEventEnvelope;
    if (typeof envelope?.id === 'string' && envelope.id) {
      return envelope.id;
    }
  }
  return `${event.type}:${event.timestamp}:${hashText(JSON.stringify(event))}`;
}

async function ensureProjection(
  context: FlowChatContext,
  job: DispatchObserverJob,
): Promise<boolean> {
  await checkBaselineWorktree(job);
  const sourceWorkspacePath = job.sourceWorkspacePath?.trim() || undefined;
  const bindTarget = (cursor: number, cursorReset = false) => {
    context.flowChatStore.updateSessionDispatchTarget(job.sessionId, {
      targetRequest: job.targetRequest,
      target: job.target,
      jobId: job.jobId,
      approvalPolicy: job.approvalPolicy,
      model: job.model,
      reasoningPreset: job.reasoningPreset,
      modelCatalog: job.modelCatalog,
      availableModels: job.availableModels,
      defaultModel: job.defaultModel,
      state: job.state,
      cursor,
      cursorReset,
      sourceWorkspacePath,
      sourceWorkspaceId: job.sourceWorkspaceId,
    });
  };
  const restoreCachedProjection = async (): Promise<{
    hydrated: boolean;
    cursor: number;
  }> => {
    const cached = await loadDispatchTranscript(job);
    const hydrated =
      !!cached &&
      context.flowChatStore.hydrateDispatchTranscript(
        job.sessionId,
        // Cache content is disk state, not a validated projection. It is
        // rendered as-is, exactly like the turns the event replay would build.
        cached.dialogTurns as DialogTurn[],
      );
    if (hydrated && cached) {
      const current = dispatchJobStore.getState().jobs[job.jobId];
      if (
        !current?.titleSource
        && typeof cached.title === 'string'
        && cached.title.trim()
        && (cached.titleSource === 'generated' || cached.titleSource === 'manual')
      ) {
        dispatchJobStore.getState().updateTitle(job.jobId, cached.title, cached.titleSource);
        void context.flowChatStore.updateSessionTitle(job.sessionId, cached.title, 'generated');
      }
      bindTarget(cached.cursor, true);
      // The cache, not the persisted renderer state, decides where to resume.
      // The two are written separately, so the renderer's own cursor can be
      // ahead of the last transcript that was actually stored; resuming from
      // the ahead one would silently skip events the restored turns never saw.
      dispatchJobStore.getState().adoptCachedReplay(job.jobId, {
        cursor: cached.cursor,
        appliedEventIds: cached.appliedEventIds,
        eventLogComplete: cached.eventLogComplete,
        historyTruncated: cached.historyTruncated,
        omittedEventCount: cached.omittedEventCount,
      });
      return { hydrated: true, cursor: cached.cursor };
    }

    // An empty projection and a cursor without matching turns cannot be
    // resumed safely. Rebind the frontend and renderer state to byte zero so
    // the durable target history rebuilds the projection under current rules.
    bindTarget(0, true);
    dispatchJobStore.getState().resetReplay(job.jobId);
    return { hydrated: false, cursor: 0 };
  };
  const existing = context.flowChatStore.getState().sessions.get(job.sessionId);
  if (existing) {
    const needsProjectionRecovery =
      existing.isHistorical === true
      || existing.historyState === 'metadata-only'
      || existing.config.dispatchJobId !== job.jobId
      || !isNonLocalDispatchTarget(existing.config.dispatchTarget);
    if (existing.config.dispatchJobId !== job.jobId) {
      log.info('Dispatch diagnostic: observer adopted an existing flow chat session', {
        jobId: job.jobId,
        sessionId: job.sessionId,
        previousDispatchJobId: existing.config.dispatchJobId,
        wasHistorical: existing.isHistorical,
        historyState: existing.historyState,
      });
    }
    // Reconcile both immutable target identity and controller-side ownership.
    // The observer can start before FlowChat knows its workspace, so a legacy
    // outbound record may only gain its source path on a later poll.
    bindTarget(job.cursor);
    if (job.titleSource && existing.title !== job.title) {
      void context.flowChatStore.updateSessionTitle(job.sessionId, job.title, 'generated');
    }
    // Startup metadata can win the race and create this session before the
    // observer. Such a session has no turns, so merely binding the dispatch
    // target would leave the navigation row permanently empty and allow the
    // stale local-history path to replace the observer projection on click.
    if (needsProjectionRecovery && existing.dialogTurns?.length === 0) {
      const restored = await restoreCachedProjection();
      log.info('Dispatch diagnostic: observer restored an existing empty projection', {
        jobId: job.jobId,
        sessionId: job.sessionId,
        wasHistorical: existing.isHistorical,
        historyState: existing.historyState,
        restoredFromCache: restored.hydrated,
        resumeCursor: restored.cursor,
      });
    }
    return true;
  }

  // Never create a workspace-less projection. SessionsSection renders once
  // per workspace, and an unowned projection must not be allowed to appear in
  // every navigation group while startup workspace state is still loading.
  // Ownership is the source workspace ID; the path is only its checkout label
  // and is enough on its own solely for pre-ID records.
  if (!job.sourceWorkspaceId && !sourceWorkspacePath) {
    return false;
  }

  context.flowChatStore.addExternalSession(
    job.sessionId,
    job.title,
    job.agentType,
    sourceWorkspacePath,
    {
      projectWorkspacePath: sourceWorkspacePath,
      workspaceId: job.sourceWorkspaceId,
    },
  );
  // Bind the target before hydrating: restoring a transcript is only allowed
  // on a session already known to be an observer projection.
  bindTarget(0);
  const restored = await restoreCachedProjection();
  log.info('Dispatch diagnostic: observer created a flow chat projection', {
    jobId: job.jobId,
    sessionId: job.sessionId,
    sourceWorkspaceId: job.sourceWorkspaceId,
    state: job.state,
    // Which of the two restore paths ran, and from where. A projection that
    // reports `restoredFromCache: false` on every restart is the symptom to
    // chase if long histories still reload page by page.
    restoredFromCache: restored.hydrated,
    resumeCursor: restored.cursor,
  });
  return context.flowChatStore.getState().sessions.has(job.sessionId);
}

function auditDetail(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const release = details.release;
  if (!release || typeof release !== 'object') return undefined;
  const value = (release as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function auditStage(event: Extract<DispatchEvent, { type: 'audit' }>): string {
  return typeof event.details.stage === 'string' ? event.details.stage.trim() : '';
}

function cliInstallAuditLabel(
  event: Extract<DispatchEvent, { type: 'audit' }>,
): string | null {
  const version = auditDetail(event.details, 'version');
  switch (auditStage(event)) {
    case 'cli-install-started':
      return i18nService.t('flow-chat:chatInput.dispatch.cliInstallStarted', {
        version: version || i18nService.t('flow-chat:chatInput.dispatch.cliInstallUnknownVersion'),
      });
    case 'cli-install-succeeded':
      return i18nService.t('flow-chat:chatInput.dispatch.cliInstallSucceeded', {
        version: version || i18nService.t('flow-chat:chatInput.dispatch.cliInstallUnknownVersion'),
      });
    case 'cli-install-failed':
      return i18nService.t('flow-chat:chatInput.dispatch.cliInstallFailed');
    default:
      return i18nService.t('flow-chat:chatInput.dispatch.cliInstallInProgress');
  }
}

/**
 * The controller pushes this device's model configuration — API keys included
 * — to a target that cannot serve the chosen model. That is worth a line in
 * the transcript, so the automatic step stays as visible as the manual one it
 * replaced, and stays visible after replay or a controller restart.
 */
function modelSyncAuditLabel(
  event: Extract<DispatchEvent, { type: 'audit' }>,
): string | null {
  switch (auditStage(event)) {
    case 'model-sync-succeeded':
      return i18nService.t('flow-chat:chatInput.dispatch.modelSyncSucceeded');
    case 'model-sync-failed':
      return i18nService.t('flow-chat:chatInput.dispatch.modelSyncFailed');
    default:
      return i18nService.t('flow-chat:chatInput.dispatch.modelSyncStarted');
  }
}

function setupAuditLabel(
  event: Extract<DispatchEvent, { type: 'audit' }>,
): string | null {
  if (event.action === 'cli-install') return cliInstallAuditLabel(event);
  if (event.action === 'model-sync') return modelSyncAuditLabel(event);
  return null;
}

/**
 * Setup audits precede the target's SessionCreated/DialogTurnStarted events.
 * Project them into the optimistic turn so they remain visible after restart,
 * and so DialogTurnStarted can later adopt the same turn without duplication.
 */
function applySetupAudit(
  context: FlowChatContext,
  job: DispatchObserverJob,
  event: Extract<DispatchEvent, { type: 'audit' }>,
  eventId: string,
): void {
  const label = setupAuditLabel(event);
  if (!label) return;

  const session = context.flowChatStore.getState().sessions.get(job.sessionId);
  if (!session) return;
  const turnId = `dispatch_pending_${job.jobId}`;
  let turn = session.dialogTurns.find(candidate => candidate.id === turnId)
    ?? session.dialogTurns[0];
  if (!turn) {
    const timestamp = Date.parse(event.timestamp) || Date.now();
    const optimisticTurn: DialogTurn = {
      id: turnId,
      sessionId: job.sessionId,
      agentType: job.agentType,
      userMessage: {
        id: `user_dispatch_${job.jobId}`,
        // This turn exists only to retain setup audit rows until the target's
        // DialogTurnStarted event arrives. Leaving the prompt empty lets that
        // event hydrate the real user-visible content during a full replay.
        content: '',
        timestamp,
        metadata: markOptimisticDispatchTurnMetadata(undefined, job.jobId),
      },
      modelRounds: [],
      status: 'pending',
      startTime: timestamp,
    };
    context.flowChatStore.addDialogTurn(job.sessionId, optimisticTurn);
    turn = optimisticTurn;
  }

  const roundId = `dispatch-setup:${job.jobId}`;
  const timestamp = Date.parse(event.timestamp) || Date.now();
  context.flowChatStore.updateDialogTurn(job.sessionId, turn.id, current => {
    const existingRound = current.modelRounds.find(round => round.id === roundId);
    const item = {
      id: `dispatch-audit:${eventId}`,
      type: 'text' as const,
      content: label,
      isStreaming: false,
      isMarkdown: false,
      status: 'completed' as const,
      timestamp,
    };
    if (existingRound) {
      if (existingRound.items.some(candidate => candidate.id === item.id)) {
        return current;
      }
      return {
        ...current,
        modelRounds: current.modelRounds.map(round => (
          round.id === roundId
            ? { ...round, items: [...round.items, item] }
            : round
        )),
      };
    }
    return {
      ...current,
      modelRounds: [{
        id: roundId,
        index: -1,
        items: [item],
        isStreaming: false,
        isComplete: true,
        status: 'completed',
        startTime: timestamp,
        endTime: timestamp,
      }, ...current.modelRounds],
    };
  }, { touchActivity: false });
}

const TERMINAL_AGENT_EVENT_NAMES = new Set([
  'agentic://dialog-turn-completed',
  'agentic://dialog-turn-failed',
  'agentic://dialog-turn-cancelled',
]);

const START_AGENT_EVENT_NAME = 'agentic://dialog-turn-started';

/**
 * Frontend turn creation uses the renderer clock. During byte-zero replay that
 * clock is observer startup time, not task start time, so replace it with the
 * durable outer event timestamp before later terminal events derive duration.
 */
function applyStartEventTimestamp(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  timestamp: string,
): void {
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) return;
  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
    const startTime = Math.min(turn.startTime, eventTime);
    const userMessageTime = Math.min(turn.userMessage.timestamp, eventTime);
    if (
      turn.startTime === startTime
      && turn.userMessage.timestamp === userMessageTime
    ) {
      return turn;
    }
    return {
      ...turn,
      startTime,
      userMessage: {
        ...turn.userMessage,
        timestamp: userMessageTime,
      },
    };
  }, { touchActivity: false });
}

/**
 * A dispatch event timestamp is durable target history, unlike the renderer's
 * wall clock. Record it before the terminal transcript is cached so restarting
 * the controller cannot turn observer downtime into task duration.
 */
function applyTerminalEventTimestamp(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  timestamp: string,
): void {
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) return;
  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
    const endTime = Math.max(turn.startTime, eventTime);
    return turn.endTime === endTime ? turn : { ...turn, endTime };
  }, { touchActivity: false });
}

function applyEvent(
  context: FlowChatContext,
  job: DispatchObserverJob,
  event: DispatchEvent,
  eventId: string,
): boolean {
  if (event.type === 'audit') {
    applySetupAudit(context, job, event, eventId);
    return true;
  }
  if (event.type === 'jobState') {
    if (isDispatchJobTerminal(event.state)) {
      const turns = context.flowChatStore
        .getState()
        .sessions
        .get(job.sessionId)
        ?.dialogTurns ?? [];
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        applyTerminalEventTimestamp(
          context,
          job.sessionId,
          lastTurn.id,
          event.timestamp,
        );
      }
    }
    return true;
  }
  if (event.type !== 'agentEvent') {
    return true;
  }
  const projected = projectDispatchAgentEvent(event);
  if (!projected) {
    log.debug('Ignoring unprojectable target agent event', { event });
    return true;
  }
  if (
    projected.eventName === 'session_title_generated'
    && projected.payload.sessionId === job.sessionId
    && typeof projected.payload.title === 'string'
    && projected.payload.title.trim()
  ) {
    // A title is projection metadata too: keep it with the persisted observer
    // before advancing its cursor. Manual names win over replayed target events.
    dispatchJobStore.getState().updateTitle(job.jobId, projected.payload.title, 'generated');
    const title = dispatchJobStore.getState().jobs[job.jobId]?.title;
    if (title) {
      void context.flowChatStore.updateSessionTitle(job.sessionId, title, 'generated');
    }
    return true;
  }
  const applied = agenticEventListener.dispatchExternal(
    projected.eventName,
    projected.payload,
  );
  if (!applied) {
    return false;
  }
  context.eventBatcher.flushNow();
  const turnId = typeof projected.payload.turnId === 'string'
    ? projected.payload.turnId
    : undefined;
  if (turnId) {
    if (projected.eventName === START_AGENT_EVENT_NAME) {
      applyStartEventTimestamp(
        context,
        job.sessionId,
        turnId,
        event.timestamp,
      );
    } else if (TERMINAL_AGENT_EVENT_NAMES.has(projected.eventName)) {
      applyTerminalEventTimestamp(
        context,
        job.sessionId,
        turnId,
        event.timestamp,
      );
    }
  }
  return true;
}

function isStreamingExecutionState(state: SessionExecutionState): boolean {
  return (
    state === SessionExecutionState.PROCESSING ||
    state === SessionExecutionState.FINISHING
  );
}

function reconcileDispatchTerminalRuntime(
  context: FlowChatContext,
  sessionId: string,
  state: DispatchJobState,
  lastError?: string,
): void {
  if (!isDispatchJobTerminal(state)) return;

  const pendingCompletion = context.pendingTurnCompletions?.get(sessionId);
  if (pendingCompletion?.timer) {
    clearTimeout(pendingCompletion.timer);
  }
  context.pendingTurnCompletions?.delete(sessionId);
  const runtimeStatusTimerPrefix = `${sessionId}:`;
  for (const [key, timer] of context.runtimeStatusTimers?.entries() ?? []) {
    if (!key.startsWith(runtimeStatusTimerPrefix)) {
      continue;
    }
    clearTimeout(timer);
    context.runtimeStatusTimers.delete(key);
  }
  const dialogTurns = context.flowChatStore
    .getState()
    .sessions
    .get(sessionId)
    ?.dialogTurns ?? [];
  const lastTurn = dialogTurns[dialogTurns.length - 1];
  if (lastTurn) {
    clearRuntimeStatus(context, sessionId, lastTurn.id);
  } else {
    clearRuntimeStatusState({ sessionId });
  }
  context.activeTextItems?.get(sessionId)?.clear();
  context.contentBuffers?.get(sessionId)?.clear();
  context.processingManager?.clearSessionStatus(sessionId);
  context.userCancelledSessionIds?.delete(sessionId);

  const settleStateMachine = async () => {
    const currentState = stateMachineManager.getCurrentState(sessionId);
    if (state === 'failed') {
      if (isStreamingExecutionState(currentState)) {
        await stateMachineManager.transition(
          sessionId,
          SessionExecutionEvent.ERROR_OCCURRED,
          { error: lastError || 'Dispatched task failed' },
        );
      }
      if (
        stateMachineManager.getCurrentState(sessionId) ===
        SessionExecutionState.ERROR
      ) {
        await stateMachineManager.transition(
          sessionId,
          SessionExecutionEvent.RESET,
        );
      }
      return;
    }

    if (isStreamingExecutionState(currentState)) {
      await stateMachineManager.transition(
        sessionId,
        SessionExecutionEvent.FINISHING_SETTLED,
      );
    }
  };

  void settleStateMachine().catch(error => {
    log.warn('Failed to settle dispatch terminal state machine', {
      sessionId,
      state,
      error,
    });
  });
}

/**
 * One status page: pull from the job's current cursor, apply every event, then
 * commit. Returns whether the cursor moved, which is the only reason to ask for
 * another page in the same poll.
 */
async function refreshJobPage(
  context: FlowChatContext,
  requestedJobId: string,
  isObserverCurrent: () => boolean,
): Promise<'progressed' | 'settled'> {
  if (!isObserverCurrent()) {
    return 'settled';
  }
  // Re-read every page: draining spans several awaits, and the store is where
  // the cursor this page must request has just been committed.
  const job = dispatchJobStore.getState().jobs[requestedJobId];
  if (!job) {
    return 'settled';
  }

  const requestCursor = job.cursor;
  let response: DispatchStatusResponse;
  try {
    response = await dispatchApi.status(job.jobId, requestCursor);
  } catch (error) {
    if (!isObserverCurrent() || !isJobStillObserved(job)) {
      return 'settled';
    }
    if (isDispatchJobNotFoundError(error)) {
      // Distinct from `unreachable`: the target is up and answered. For a
      // submission whose outcome was unknown this means it was never
      // delivered, and an idempotent resubmit with the same id is safe.
      dispatchJobStore.getState().setTransportState(
        job.jobId,
        'notFound',
        transportErrorMessage(error),
      );
      throw new DispatchJobNotFoundOnTarget(job.jobId, transportErrorMessage(error));
    }
    dispatchJobStore.getState().setTransportState(
      job.jobId,
      'unreachable',
      transportErrorMessage(error),
    );
    throw new DispatchTargetReadFailed(error);
  }
  // Deleting a dispatch session writes a projection tombstone while an
  // already-issued target poll may still be in flight. Never let that stale
  // response project SessionCreated/DialogTurnStarted and recreate the row.
  if (!isObserverCurrent() || !isJobStillObserved(job)) {
    return 'settled';
  }
  // A successful target status request is the only authoritative signal that
  // clears a transient transport failure. It does not alter the durable job
  // state beyond the snapshot applied below.
  dispatchJobStore.getState().setTransportState(job.jobId, 'reachable');
  // Terminal event handling and snapshot reconciliation clear this marker.
  // Capture it first so a controller-initiated cancellation cannot be
  // misreported as a newly completed background task.
  const userCancelledBeforeRefresh =
    context.userCancelledSessionIds?.has(job.sessionId) ?? false;
  for (const event of response.events) {
    if (!isObserverCurrent() || !isJobStillObserved(job)) {
      return 'settled';
    }
    const eventId = dispatchEventId(event);
    if (dispatchJobStore.getState().hasAppliedEvent(job.jobId, eventId)) {
      continue;
    }
    if (!applyEvent(context, job, event, eventId)) {
      return 'settled';
    }
    // Persist each applied id immediately. If a later event in this response
    // fails, the cursor stays put but already-applied chunks are not duplicated.
    dispatchJobStore.getState().updateProgress(job.jobId, {
      appliedEventIds: [eventId],
    });
  }
  if (!isObserverCurrent() || !isJobStillObserved(job)) {
    return 'settled';
  }

  const terminalDrained =
    isDispatchJobTerminal(response.state) &&
    requestCursor === response.cursor &&
    response.events.length === 0;
  const sessionBeforeSnapshot = context.flowChatStore
    .getState()
    .sessions
    .get(job.sessionId);
  const dialogTurnsBeforeSnapshot = sessionBeforeSnapshot?.dialogTurns ?? [];
  const lastTurnBeforeSnapshot =
    dialogTurnsBeforeSnapshot[dialogTurnsBeforeSnapshot.length - 1];
  const terminalEventHandled =
    !!lastTurnBeforeSnapshot &&
    (
      context.handledTerminalTurnEvents?.has(
        `${job.sessionId}:${lastTurnBeforeSnapshot.id}`,
      ) ?? false
    );
  const terminalTurnSettled =
    !!lastTurnBeforeSnapshot &&
    (
      lastTurnBeforeSnapshot.status === 'completed' ||
      lastTurnBeforeSnapshot.status === 'cancelled' ||
      lastTurnBeforeSnapshot.status === 'error'
    ) &&
    lastTurnBeforeSnapshot.endTime !== undefined;
  const needsTerminalFallback =
    terminalDrained && (!terminalEventHandled || !terminalTurnSettled);
  const applied = context.flowChatStore.applyDispatchSnapshot(job.sessionId, {
    jobId: job.jobId,
    state: response.state,
    cursor: response.cursor,
    lastError: response.lastError,
    expectedCursor: requestCursor,
    cursorReset: response.cursorReset,
    terminalDrained: needsTerminalFallback,
  });
  if (!applied.applied) {
    return 'settled';
  }
  const background =
    typeof document !== 'undefined'
    && (document.hidden || !document.hasFocus());
  const knownPermissionIds = new Set(
    (job.pendingPermissions ?? [])
      .map(request => request.requestId)
      .filter((requestId): requestId is string => typeof requestId === 'string'),
  );
  const newPermissionCount = response.pendingPermissions.filter(request => (
    typeof request.requestId === 'string'
    && !knownPermissionIds.has(request.requestId)
  )).length;
  dispatchJobStore.getState().updateProgress(job.jobId, {
    cursor: response.cursor,
    state: response.state,
    lastError: response.lastError,
    cursorReset: response.cursorReset,
    terminalDrained,
    pendingPermissions: response.pendingPermissions,
    eventLogComplete: response.eventLogComplete,
    historyTruncated: response.historyTruncated,
    omittedEventCount: response.omittedEventCount,
  });
  // Both halves are committed here: the projection holds every event of this
  // page and the cursor is the one that produced it. Capturing the pair now,
  // rather than when the throttled write runs, is what keeps a cached cursor
  // from ever being paired with turns from a different point in the stream.
  const projectedSession = context.flowChatStore.getState().sessions.get(job.sessionId);
  const committedJob = dispatchJobStore.getState().jobs[job.jobId];
  if (projectedSession && committedJob) {
    scheduleDispatchTranscriptSave(
      committedJob,
      projectedSession.dialogTurns,
      applied.cursor,
    );
  }
  if (
    job.eventLogComplete !== false
    && response.eventLogComplete === false
  ) {
    notificationService.warning(
      i18nService.t('common:dispatch.eventHistoryIncomplete'),
      { duration: 6000 },
    );
  }
  if (background && newPermissionCount > 0) {
    void systemAPI.sendSystemNotification(
      i18nService.t('common:dispatch.permissionTitle'),
      i18nService.t('common:dispatch.permissionBody', {
        task: job.title,
        count: newPermissionCount,
      }),
    ).catch(error => {
      log.warn('Failed to send dispatched permission notification', {
        jobId: job.jobId,
        error,
      });
    });
  }
  const becameTerminal =
    !isDispatchJobTerminal(job.state)
    && isDispatchJobTerminal(response.state);
  if (
    becameTerminal
    && response.state !== 'cancelled'
    && !userCancelledBeforeRefresh
  ) {
    const activeSessionId = context.flowChatStore.getState().activeSessionId;
    if (activeSessionId !== job.sessionId || background) {
      context.flowChatStore.markSessionUnreadCompletion(
        job.sessionId,
        response.state === 'failed' ? 'error' : 'completed',
      );
    }
    if (background) {
      const title = response.state === 'failed'
        ? i18nService.t('common:dispatch.completionFailedTitle')
        : i18nService.t('common:dispatch.completionTitle');
      const body = i18nService.t('common:dispatch.completionBody', {
        task: job.title,
        target:
          job.target.kind === 'ssh' || job.target.kind === 'device'
            ? (job.target.kind === 'device' ? resolveDeviceName(job.target.deviceId, job.target.displayName) : job.target.displayName)
            : i18nService.t('common:dispatch.localTarget'),
      });
      void systemAPI.sendSystemNotification(title, body).catch(error => {
        log.warn('Failed to send dispatched task completion notification', {
          jobId: job.jobId,
          error,
        });
      });
    }
  }
  if (terminalDrained) {
    // Nothing more will ever change this transcript. Write it now instead of
    // leaving the last few turns to a throttle window that a shutdown could
    // cut short.
    void flushDispatchTranscriptSave(job.jobId);
  }
  if (needsTerminalFallback) {
    const effectiveSession = context.flowChatStore
      .getState()
      .sessions
      .get(job.sessionId);
    const effectiveState = effectiveSession?.config.dispatchJobState;
    if (!effectiveState || !isDispatchJobTerminal(effectiveState)) {
      return 'settled';
    }
    reconcileDispatchTerminalRuntime(
      context,
      job.sessionId,
      effectiveState,
      effectiveSession.config.dispatchLastError ||
        effectiveSession.error ||
        response.lastError,
    );
  }
  return response.cursor > requestCursor ? 'progressed' : 'settled';
}

/**
 * Upper bound on pages pulled in one poll cycle.
 *
 * Draining is what makes a long history load in one pass instead of one page
 * per 1.8s tick. The bound keeps a target that keeps producing events from
 * starving every other job in the same cycle.
 */
const MAX_DRAIN_PAGES = 12;

/**
 * Returns `contacted` only when at least one status read reached the target,
 * which is what clears a target backoff.
 */
async function refreshJob(
  context: FlowChatContext,
  requestedJobId: string,
  isObserverCurrent: () => boolean,
): Promise<'contacted' | 'skipped'> {
  if (!isObserverCurrent()) {
    return 'skipped';
  }
  const job = dispatchJobStore.getState().jobs[requestedJobId];
  if (!job) {
    return 'skipped';
  }
  // `submitting` is a local pre-ack state. There is no durable target job to
  // query yet, and a failed submit intentionally remains retryable.
  if (job.state === 'submitting') {
    return 'skipped';
  }
  const projectionExisted = context.flowChatStore.getState().sessions.has(job.sessionId);
  if (!await ensureProjection(context, job)) {
    return 'skipped';
  }
  // Cache adoption and byte-zero fallback both reset terminalDrained. Re-read
  // after projection reconciliation so a stale pre-ensure snapshot cannot
  // suppress the status request that completes restoration.
  const reconciledJob = dispatchJobStore.getState().jobs[requestedJobId];
  if (!reconciledJob) {
    return 'skipped';
  }
  if (
    projectionExisted
    && isDispatchJobTerminal(reconciledJob.state)
    && reconciledJob.terminalDrained
  ) {
    return 'skipped';
  }

  for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
    if (await refreshJobPage(context, requestedJobId, isObserverCurrent) === 'settled') {
      return 'contacted';
    }
  }
  log.debug('Stopped draining dispatch pages at the per-poll bound', {
    jobId: requestedJobId,
  });
  return 'contacted';
}

interface PollBackoff {
  failures: number;
  retryAt: number;
}

function nextBackoff(previous: PollBackoff | undefined, now: number): PollBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = Math.min(
    DISPATCH_TARGET_BACKOFF_MAX_MS,
    DISPATCH_TARGET_BACKOFF_BASE_MS * 2 ** (failures - 1),
  );
  return { failures, retryAt: now + delay };
}

/**
 * Jobs waiting in one target lane. The value says whether the refresh was
 * explicitly requested; explicit refreshes run first and ignore backoff.
 */
interface PollLane {
  running: boolean;
  /** Job whose status read is in flight; a periodic poll of it is redundant. */
  current?: string;
  queue: Map<string, boolean>;
}

export function installDispatchJobObserver(context: FlowChatContext): () => void {
  const observerGlobal = getDispatchObserverGlobal();
  const previousLease = observerGlobal.__openbitfunDispatchJobObserverLease__;
  if (previousLease) {
    log.info('Replacing an existing dispatch job observer');
    previousLease.dispose();
  }

  let disposed = false;
  // Single-flight reconciliation of the controller-local outbound index.
  // Target status reads do not run under this flag: they run in per-target
  // lanes, so one slow or offline target never holds up the others.
  let reconciling = false;
  // A full refresh (jobId undefined) is still a request. Coalesce different
  // targeted requests into a full refresh instead of losing an approval wakeup.
  let pendingRefresh: { jobId?: string } | null = null;
  let immediateTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let pollIntervalMs = 0;
  let unsubscribeJobs: (() => void) | null = null;
  let handleVisibilityChanged: (() => void) | null = null;
  const lanes = new Map<string, PollLane>();
  let runningLaneCount = 0;
  const targetBackoff = new Map<string, PollBackoff>();
  const missingJobBackoff = new Map<string, PollBackoff>();
  // When each job's last read finished. A periodic poll right behind an
  // explicit one (a follow-up wakes both) would only repeat the same read.
  const lastReadAt = new Map<string, number>();
  const lease: DispatchObserverLease = {
    requestRefresh: schedule,
    dispose,
  };
  const ownsLease = (): boolean => (
    !disposed
    && observerGlobal.__openbitfunDispatchJobObserverLease__ === lease
  );
  const isBusy = (): boolean => reconciling || runningLaneCount > 0;

  function enqueue(job: DispatchObserverJob, explicit: boolean): void {
    const key = dispatchTargetLaneKey(job.target);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { running: false, queue: new Map() };
      lanes.set(key, lane);
    }
    if (explicit) {
      // Explicit refreshes answer a user action: they run before periodic
      // polls, in the order they were requested.
      const rest = [...lane.queue].filter(([jobId]) => jobId !== job.jobId);
      lane.queue = new Map([
        ...rest.filter(([, queuedExplicit]) => queuedExplicit),
        [job.jobId, true],
        ...rest.filter(([, queuedExplicit]) => !queuedExplicit),
      ]);
    } else if (!lane.queue.has(job.jobId) && lane.current !== job.jobId) {
      lane.queue.set(job.jobId, false);
    }
    if (!lane.running) {
      void drainLane(key, lane);
    }
  }

  async function drainLane(key: string, lane: PollLane): Promise<void> {
    lane.running = true;
    runningLaneCount += 1;
    try {
      while (lane.queue.size > 0) {
        if (!ownsLease() || isPeerDeviceModeActive()) {
          lane.queue.clear();
          return;
        }
        const [jobId] = lane.queue.keys();
        lane.queue.delete(jobId);
        lane.current = jobId;
        try {
          if (await refreshJob(context, jobId, ownsLease) === 'contacted') {
            targetBackoff.delete(key);
            missingJobBackoff.delete(jobId);
            lastReadAt.set(jobId, Date.now());
          }
        } catch (error) {
          if (!ownsLease()) {
            return;
          }
          lastReadAt.set(jobId, Date.now());
          if (error instanceof DispatchJobNotFoundOnTarget) {
            // The target answered, so its other jobs stay on schedule.
            targetBackoff.delete(key);
            missingJobBackoff.set(jobId, nextBackoff(missingJobBackoff.get(jobId), Date.now()));
            log.warn('Dispatch job is not known to its target', { jobId });
            continue;
          }
          if (!(error instanceof DispatchTargetReadFailed)) {
            // The target answered; projecting its response failed locally.
            // Retry on the normal cadence without penalizing the target.
            targetBackoff.delete(key);
            log.warn('Dispatch job refresh failed', { jobId, error });
            continue;
          }
          targetBackoff.set(key, nextBackoff(targetBackoff.get(key), Date.now()));
          log.warn('Dispatch target status read failed', {
            jobId,
            lane: key,
            error: error.cause,
          });
          // The target's other periodic polls would wait on the same failed
          // transport. Report them unreachable now and let the backoff decide
          // when to try again; explicit requests still run.
          const message = transportErrorMessage(error);
          for (const [queuedJobId, explicit] of [...lane.queue]) {
            if (explicit) continue;
            lane.queue.delete(queuedJobId);
            dispatchJobStore.getState().setTransportState(queuedJobId, 'unreachable', message);
          }
        }
      }
    } finally {
      lane.running = false;
      lane.current = undefined;
      runningLaneCount -= 1;
      if (lanes.get(key) === lane && lane.queue.size === 0) {
        lanes.delete(key);
      }
      if (ownsLease()) {
        updatePollingInterval();
      }
    }
  }

  function isBackedOff(job: DispatchObserverJob, now: number): boolean {
    const readAt = lastReadAt.get(job.jobId);
    if (readAt !== undefined && now - readAt < DISPATCH_JOB_POLL_INTERVAL_MS / 2) return true;
    const target = targetBackoff.get(dispatchTargetLaneKey(job.target));
    if (target && target.retryAt > now) return true;
    const missing = missingJobBackoff.get(job.jobId);
    return !!missing && missing.retryAt > now;
  }

  async function run(requestedJobId?: string): Promise<void> {
    if (!ownsLease() || isPeerDeviceModeActive()) return;

    // A refresh for a known job goes straight to its target lane. It does not
    // need the outbound index, and must not wait for another target's read.
    if (requestedJobId) {
      const known = dispatchJobStore.getState().jobs[requestedJobId];
      if (known) {
        enqueue(known, true);
        return;
      }
    }
    if (reconciling) {
      pendingRefresh = pendingRefresh === null || pendingRefresh.jobId === requestedJobId
        ? { jobId: requestedJobId }
        : {};
      return;
    }

    reconciling = true;
    try {
      const records = await dispatchApi.listJobs();
      if (!ownsLease()) {
        return;
      }
      dispatchJobStore.getState().mergeOutboundRecords(records);
      const now = Date.now();
      const jobs = Object.values(dispatchJobStore.getState().jobs)
        .filter(job => !requestedJobId || job.jobId === requestedJobId);
      for (const job of jobs) {
        if (!ownsLease()) {
          return;
        }
        const explicit = !!requestedJobId;
        if (!explicit && isBackedOff(job, now)) {
          continue;
        }
        enqueue(job, explicit);
      }
    } catch (error) {
      if (!ownsLease()) {
        return;
      }
      const message = transportErrorMessage(error);
      const jobs = Object.values(dispatchJobStore.getState().jobs)
        .filter(job => (
          job.state !== 'submitting' &&
          (!requestedJobId || job.jobId === requestedJobId) &&
          !(isDispatchJobTerminal(job.state) && job.terminalDrained)
        ));
      for (const job of jobs) {
        dispatchJobStore.getState().setTransportState(
          job.jobId,
          'unreachable',
          message,
        );
      }
      log.warn('Failed to reconcile outbound dispatch jobs', { error });
    } finally {
      reconciling = false;
      if (ownsLease()) {
        updatePollingInterval();
        if (pendingRefresh) schedule(pendingRefresh.jobId);
      }
    }
  }

  function updatePollingInterval(): void {
    if (!ownsLease()) return;
    const hasUnsettledJobs = Object.values(dispatchJobStore.getState().jobs).some(job => (
      !isDispatchJobTerminal(job.state) || !job.terminalDrained
    ));
    const nextIntervalMs = hasUnsettledJobs
      ? DISPATCH_JOB_POLL_INTERVAL_MS
      : DISPATCH_IDLE_DISCOVERY_INTERVAL_MS;
    if (interval !== null && pollIntervalMs === nextIntervalMs) return;
    if (interval !== null) clearInterval(interval);
    pollIntervalMs = nextIntervalMs;
    // Idle discovery remains active while hidden: another controller process
    // can submit a job without updating this renderer's store or sending events.
    interval = setInterval(() => { void run(); }, nextIntervalMs);
  }

  function schedule(jobId?: string): void {
    if (!ownsLease()) return;
    // A refresh for a known job is served by its target lane right away; the
    // outbound index is only read for discovery.
    if (jobId && dispatchJobStore.getState().jobs[jobId]) {
      // Deferred so a caller writing the store is never re-entered.
      setTimeout(() => { void run(jobId); }, 0);
      return;
    }
    pendingRefresh = pendingRefresh === null || pendingRefresh.jobId === jobId
      ? { jobId }
      : {};
    // Keep discovery requests queued across a slow index read. Periodic ticks
    // never start a second in-flight reconciliation.
    if (reconciling) return;
    if (immediateTimer !== null) {
      clearTimeout(immediateTimer);
    }
    immediateTimer = setTimeout(() => {
      immediateTimer = null;
      if (reconciling) return;
      const requestedJobId = pendingRefresh?.jobId;
      pendingRefresh = null;
      void run(requestedJobId);
    }, 0);
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    if (observerGlobal.__openbitfunDispatchJobObserverLease__ === lease) {
      delete observerGlobal.__openbitfunDispatchJobObserverLease__;
    }
    if (immediateTimer !== null) {
      clearTimeout(immediateTimer);
      immediateTimer = null;
    }
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    pendingRefresh = null;
    for (const lane of lanes.values()) lane.queue.clear();
    lanes.clear();
    targetBackoff.clear();
    missingJobBackoff.clear();
    lastReadAt.clear();
    unsubscribeJobs?.();
    unsubscribeJobs = null;
    if (typeof document !== 'undefined' && handleVisibilityChanged) {
      document.removeEventListener('visibilitychange', handleVisibilityChanged);
    }
    // Drop rather than flush: a pending payload only ever trails what is
    // already cached, so losing it costs a few replayed events, while writing
    // during teardown could race whatever tears the store down next.
    cancelDispatchTranscriptSaves();
  }
  observerGlobal.__openbitfunDispatchJobObserverLease__ = lease;

  updatePollingInterval();
  unsubscribeJobs = dispatchJobStore.subscribe(() => {
    if (!ownsLease()) return;
    // Polls update the store repeatedly while replaying events. Keep the
    // cadence current (a lane can sit on a hung target for minutes), but do
    // not treat those writes as a reason to start another poll.
    if (isBusy()) {
      updatePollingInterval();
      return;
    }
    const wasIdle = pollIntervalMs === DISPATCH_IDLE_DISCOVERY_INTERVAL_MS;
    updatePollingInterval();
    if (wasIdle && pollIntervalMs === DISPATCH_JOB_POLL_INTERVAL_MS) schedule();
  });
  handleVisibilityChanged = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      // Waking up often follows a sleep or network change; give every target
      // a fresh attempt instead of honoring backoff earned on the old network.
      targetBackoff.clear();
      missingJobBackoff.clear();
      lastReadAt.clear();
      schedule();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChanged);
  }
  schedule();

  return dispose;
}
