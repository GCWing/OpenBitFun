import { projectUserQuestionTiming } from '../utils/userQuestionTiming';
/**
 * Flow Chat global state store
 * Prevents state loss when components remount
 */

import {
  FlowChatState,
  Session,
  DialogTurn,
  ModelRound,
  ModelRoundAttempt,
  ModelRoundAttemptDiagnostic,
  FlowItem,
  FlowToolItem,
  FlowImageAnalysisItem,
  ImageAnalysisResult,
  AnyFlowItem,
  AcpContextUsage,
  ActiveTurnRenderRange,
  LoadedTurnRange,
  LoadedTurnRangeSource,
  SessionConfig,
  SessionContextRestoreState,
  SessionHistoryViewState,
  SessionHistoryPresentation,
  SessionHistoryState,
  TokenUsage,
} from '../types/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import { optimisticTurnAdoptionKey } from '../utils/optimisticTurnAdoption';
import {
  isRemoteTraceContext,
  markPhaseAfterAnimationFrames,
  startupTrace,
} from '@/shared/utils/startupTrace';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { normalizeRemoteSessionScope } from '@/shared/utils/remoteSessionScope';
import { isSurfaceReconcileEnabled } from '@/infrastructure/peer-device/deviceSurfaceReconcile';
import { persistedMayWriteTurn } from '@/flow_chat/session-stream/SessionStream';
import { SessionRecordReplica, type SessionRecord } from '@/flow_chat/session-stream/SessionRecordReplica';
import { RelaySessionHistory } from '../services/RelaySessionHistory';
import { stateMachineManager } from '../state-machine';
import { ProcessingPhase, SessionExecutionState } from '../state-machine/types';
import { sessionCompletionReceipt } from '../utils/sessionCompletionReceipt';
import { isTurnAwaitingRecovery } from '../utils/interruptedTurnRecovery';
import { sessionActivityStore } from './sessionActivityStore';
import {
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  onSurfaceActivated,
  surfaceScopedKey,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';
import {
  isRuntimeSessionAttachmentInFlight,
  markRuntimeSessionProjectionStale,
} from '@/infrastructure/peer-device/runtimeSessionEventGate';
import { i18nService } from '@/infrastructure/i18n/core/I18nService';
import type {
  DialogTurnData,
  SessionContextUsage,
  SessionActivitySummary,
  SessionKind,
  SessionTurnCatalog,
} from '@/shared/types/session-history';
import {
  agentAPI,
  type LoadSessionTurnWindowResponse,
  type PendingUserQuestionSnapshot,
  type SessionRuntimeEventSnapshot,
  type SessionInfo as AgentSessionInfo,
  type SessionViewRestoreTiming,
} from '@/infrastructure/api/service-api/AgentAPI';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import {
  deriveLastFinishedAtFromMetadata,
  deriveSessionRelationshipFromMetadata,
  normalizeSessionRelationship,
} from '../utils/sessionMetadata';
import { sessionProjectWorkspacePath } from '../utils/sessionWorkspace';
import type { SessionTitleDescriptor } from '../utils/sessionTitle';
import { deriveContextUsageFromTurns } from '../utils/tokenUsageDisplay';
import { isAcpAgentType } from '../utils/acpSession';
import {
  deriveSessionTitleState,
  deriveSessionTitleStateFromMetadata,
  freezeSessionTitleState,
} from '../utils/sessionTitle';
import {
  isTransientToolStatus,
  normalizeRecoveredRoundStatus,
  normalizeRecoveredTextStatus,
  normalizeRecoveredThinkingStatus,
  normalizeRecoveredToolStatus,
  normalizeRecoveredTurnFinishReason,
  normalizeRecoveredTurnStatus,
  settleDialogTurnToTerminalStatus,
  settleInterruptedDialogTurn,
} from '../utils/dialogTurnStability';
import type { WorkspaceInfo } from '@/shared/types';
import { sessionBelongsToWorkspaceNavRow } from '../utils/sessionOrdering';
import { sessionMatchesWorkspace } from '../utils/workspaceScope';
import { resolveThreadGoalUserMessageDisplay } from '../utils/threadGoalDisplay';
import { cleanRemoteUserInput } from '../utils/userInputText';
import { useBackgroundSubagentActivityStore } from './backgroundSubagentActivityStore';
import { askUserQuestionDraftStore } from './askUserQuestionDraftStore';
import { sessionComposerStore } from './sessionComposerStore';
import { completeSessionMutationReconciliation } from './sessionMutationStore';
import { recordHistorySessionDiagnosticEvent } from '../services/historySessionDiagnostics';
import { liveSessionInteractionStore } from '../services/liveSessionInteractionStore';
import {
  isDispatchJobTerminal,
  isNonLocalDispatchTarget,
} from '@/features/dispatch/types';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import {
  isProvisionalUsageReportTurn,
  isProjectedSessionEmpty,
  canonicalSessionTurns,
  lastUserDialogTurn,
  projectedSessionTurnCount,
  resolveDialogTurnIdentity,
  resolveStorageTurnIndex,
} from '../utils/flowChatTurnIdentity';

const log = createLogger('FlowChatStore');

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function persistedCurrentContextUsageValue(
  metadata: { currentContextUsage?: SessionContextUsage },
): unknown {
  return metadata.currentContextUsage;
}

function deriveRestoredCurrentTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = record.inputTokens;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return undefined;
  }
  const totalTokens = record.totalTokens;
  const turnId = typeof record.turnId === 'string' && record.turnId.trim()
    ? record.turnId.trim()
    : undefined;
  const source = record.source === 'model_request' || record.source === 'context_compression'
    ? record.source
    : undefined;
  const outputTokens = record.outputTokens;
  const timestamp = record.timestamp;
  if (
    !turnId
    || !source
    || typeof totalTokens !== 'number'
    || !Number.isFinite(totalTokens)
    || totalTokens < 0
    || (
      outputTokens !== undefined
      && (
        typeof outputTokens !== 'number'
        || !Number.isFinite(outputTokens)
        || outputTokens < 0
      )
    )
    || typeof timestamp !== 'number'
    || !Number.isFinite(timestamp)
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    timestamp,
    turnId,
    source,
  };
}

function reconcileHydratedCurrentTokenUsage(
  currentTokenUsage: TokenUsage | undefined,
  dialogTurns: DialogTurn[],
  restoredAgentType: string | undefined,
  sourceVisibilityTurns: DialogTurn[] = dialogTurns,
): TokenUsage | undefined {
  if (isAcpAgentType(restoredAgentType)) {
    return undefined;
  }

  const sourceTurnId = currentTokenUsage?.turnId;
  const retainedUsage = sourceTurnId
    && !sourceVisibilityTurns.some(turn => turn.id === sourceTurnId)
    ? undefined
    : currentTokenUsage;

  return retainedUsage ?? deriveContextUsageFromTurns(dialogTurns);
}

function reconcileRestoreViewCurrentTokenUsage(
  currentTokenUsage: TokenUsage | undefined,
  authoritativeUsage: SessionContextUsage | null | undefined,
  dialogTurns: DialogTurn[],
  restoredAgentType: string | undefined,
  sourceVisibilityTurns: DialogTurn[] = dialogTurns,
): TokenUsage | undefined {
  if (isAcpAgentType(restoredAgentType)) {
    return undefined;
  }
  const candidateUsage = authoritativeUsage === undefined
    ? currentTokenUsage
    : authoritativeUsage === null
      ? undefined
      : deriveRestoredCurrentTokenUsage(authoritativeUsage);
  return reconcileHydratedCurrentTokenUsage(
    candidateUsage,
    dialogTurns,
    restoredAgentType,
    sourceVisibilityTurns,
  );
}

function currentTokenUsageAfterSourceRemoval(
  session: Pick<Session, 'currentTokenUsage' | 'isPartial'>,
  dialogTurns: DialogTurn[],
  sourceRemoved: boolean,
): TokenUsage | undefined {
  if (!sourceRemoved) {
    return session.currentTokenUsage;
  }
  return session.isPartial === true
    ? undefined
    : deriveContextUsageFromTurns(dialogTurns);
}

function persistedSessionRemoteScope(
  metadata: {
    remoteConnectionId?: unknown;
    remoteSshHost?: unknown;
    workspaceHostname?: unknown;
  },
  fallbackRemoteConnectionId?: string,
  fallbackRemoteSshHost?: string,
) {
  const connectionId = firstNonEmptyString(
    metadata.remoteConnectionId,
    fallbackRemoteConnectionId,
  );
  for (const host of [
    metadata.remoteSshHost,
    metadata.workspaceHostname,
    fallbackRemoteSshHost,
  ]) {
    const scope = normalizeRemoteSessionScope(connectionId, host);
    if (scope.remoteSshHost) {
      return scope;
    }
  }
  return normalizeRemoteSessionScope(connectionId);
}

function dispatchObserverOwnsSession(
  sessionId: string,
  session?: Session,
): boolean {
  return resolveSessionDriverId(sessionId, session) === 'dispatch';
}

function logPersistedDispatchMetadataOverlap(
  metadata: Record<string, unknown>,
  source: 'metadata-page' | 'metadata-list',
): void {
  const sessionId =
    typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined;
  if (!sessionId) return;

  const dispatchState = dispatchJobStore.getState();
  const observerJobIds = Object.values(dispatchState.jobs)
    .filter(job => job.sessionId === sessionId)
    .map(job => job.jobId);
  const sessionTombstoned = dispatchState.dismissedSessionIds.includes(sessionId);
  const metadataDispatchJobId =
    typeof metadata.dispatchJobId === 'string'
      ? metadata.dispatchJobId
      : typeof metadata.dispatch_job_id === 'string'
        ? metadata.dispatch_job_id
        : undefined;
  if (!sessionTombstoned && observerJobIds.length === 0 && !metadataDispatchJobId) {
    return;
  }

  log.info('Dispatch diagnostic: persisted backend metadata overlaps observer state', {
    source,
    sessionId,
    metadataDispatchJobId,
    observerJobIds,
    sessionTombstoned,
    dismissedSessionCount: dispatchState.dismissedSessionIds.length,
  });
}

function sameDispatchTargetIdentity(
  left: NonNullable<SessionConfig['dispatchTarget']>,
  right: NonNullable<SessionConfig['dispatchTarget']>,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'ssh':
      return right.kind === 'ssh' && left.connectionId === right.connectionId;
    case 'device':
      return right.kind === 'device' && left.deviceId === right.deviceId;
    case 'local':
      return right.kind === 'local';
  }
}

// Retired built-in ids remain readable for historical sessions and older peer
// hosts; new-session selection filters them from the current Agent catalog.
const VALID_AGENT_TYPES = new Set([
  'Standard',
  'Multitask',
  'debug',
  'Plan',
  'Cowork',
  'Claw',
  'DeepResearch',
  'Ultimate',
]);
const METADATA_LIST_RECENT_DEDUPE_TTL_MS = 1000;
const HISTORICAL_SESSION_INITIAL_REMOTE_TAIL_TURN_COUNT = 3;
const HISTORICAL_SESSION_INITIAL_LOCAL_TAIL_TURN_COUNT = 3;
const HISTORICAL_SESSION_FULL_HISTORY_IDLE_TIMEOUT_MS = 1500;
const HISTORICAL_SESSION_PREVIOUS_WINDOW_TURN_COUNT = 12;
const PEER_SESSION_REFRESH_TAIL_TURN_COUNT = 3;
const SETTLED_TURN_RECONCILE_TAIL_TURN_COUNT = 1;
const SESSION_TURN_WINDOW_DEFAULT_BEFORE = 4;
const SESSION_TURN_WINDOW_DEFAULT_AFTER = 12;
const SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET = 48;
const SESSION_HISTORY_PRESENTATION_HARD_TURN_BUDGET = 64;
const SESSION_HISTORY_PRESENTATION_PREFETCH_TURN_COUNT = 16;
const SESSION_HISTORY_LOADED_RANGE_CACHE_SOFT_TURN_BUDGET = 48;
const SESSION_HISTORY_LOADED_RANGE_CACHE_HARD_TURN_BUDGET = 64;

type RemoveSessionOptions = {
  nextActiveSessionId?: string | null;
};
const HISTORICAL_SESSION_FULL_HISTORY_FIRST_PAINT_TIMEOUT_MS = 2500;
const MAX_DEFERRED_FULL_HISTORY_PROJECTIONS = 3;

export interface PeerSessionSnapshotRefreshResult {
  applied: boolean;
  backendState: string;
  latestTurnId?: string;
  latestTurnStatus?: DialogTurn['status'];
  /** Present whenever the host sent a valid journal and this surface is still current. */
  runtimeEventSnapshot?: SessionRuntimeEventSnapshot;
  /** False when the rendered projection already includes this cursor. */
  runtimeEventReplayRequired?: boolean;
  /** Applied after Runtime event replay so the blocking card binds to its tool. */
  pendingUserQuestions?: PendingUserQuestionSnapshot;
}

export interface DispatchSnapshotApplyResult {
  applied: boolean;
  cursor: number;
}

export interface LoadSessionTurnWindowOptions {
  before?: number;
  after?: number;
  includeInternal?: boolean;
  source?: Exclude<LoadedTurnRangeSource, 'initial-tail' | 'live'>;
}

export type SessionHistoryWindowDirection = 'before' | 'after';

export interface SessionTurnOrdinalRange {
  startOrdinal: number;
  endOrdinalExclusive: number;
}

export type SessionTurnWindowLoadResult = {
  status: 'ready' | 'stale' | 'not-found' | 'unsupported';
  sessionId: string;
  targetOrdinal: number;
  targetTurnId?: string;
  navigationGeneration: number;
  isCurrent: boolean;
  cacheHit: boolean;
  range?: LoadedTurnRange;
  catalog?: SessionTurnCatalog;
  fallbackRequested?: boolean;
};

interface OrdinalInterval {
  startOrdinal: number;
  endOrdinalExclusive: number;
}

interface SessionTurnWindowProtection extends OrdinalInterval {
  surfaceId: DeviceSurfaceId;
  sessionId: string;
  retainCount: number;
}

function dispatchTerminalTurnStatus(
  state: NonNullable<SessionConfig['dispatchJobState']>,
): 'completed' | 'cancelled' | 'error' | null {
  if (state === 'succeeded') return 'completed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'failed') return 'error';
  return null;
}

export function isBackendSessionActivelyProcessing(state: unknown): boolean {
  if (typeof state !== 'string') {
    return false;
  }

  const normalized = state.trim().toLowerCase();
  return normalized === 'processing' ||
    normalized.startsWith('processing ') ||
    normalized.startsWith('processing {') ||
    normalized === 'waitingfortoolresponse' ||
    normalized === 'paused';
}

function normalizeLiveTurnStatus(status: unknown): DialogTurn['status'] {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  switch (normalized) {
    case 'pending':
      return 'pending';
    case 'image_analyzing':
      return 'image_analyzing';
    case 'finishing':
      return 'finishing';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    case 'inprogress':
    case 'processing':
    default:
      return 'processing';
  }
}

function normalizeLiveRoundStatus(
  status: unknown,
  parentTurnStatus: DialogTurn['status'],
): ModelRound['status'] {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  switch (normalized) {
    case 'pending':
      return 'pending';
    case 'streaming':
    case 'inprogress':
    case 'running':
      return 'streaming';
    case 'pending_confirmation':
      return 'pending_confirmation';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'error':
      return 'error';
    default:
      return parentTurnStatus === 'processing' || parentTurnStatus === 'pending'
        ? 'streaming'
        : normalizeRecoveredRoundStatus(status, parentTurnStatus);
  }
}

function normalizeLiveItemStatus(
  status: unknown,
  fallback: AnyFlowItem['status'],
): AnyFlowItem['status'] {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  switch (normalized) {
    case 'pending':
    case 'queued':
    case 'waiting':
    case 'preparing':
    case 'running':
    case 'streaming':
    case 'receiving':
    case 'completed':
    case 'cancelled':
    case 'rejected':
    case 'error':
    case 'analyzing':
    case 'pending_confirmation':
    case 'confirmed':
      return normalized;
    case 'starting':
      return 'preparing';
    default:
      return fallback;
  }
}

function compareDialogTurnOrder(left: DialogTurn, right: DialogTurn): number {
  const leftStorageIndex = left.storageTurnIndex ?? left.backendTurnIndex;
  const rightStorageIndex = right.storageTurnIndex ?? right.backendTurnIndex;
  if (
    typeof leftStorageIndex === 'number' &&
    typeof rightStorageIndex === 'number' &&
    leftStorageIndex !== rightStorageIndex
  ) {
    return leftStorageIndex - rightStorageIndex;
  }
  return left.startTime - right.startTime;
}

function runningStatusRank(status: string | undefined): number {
  switch (status) {
    case 'pending':
    case 'queued':
    case 'waiting':
    case 'preparing':
      return 0;
    case 'processing':
    case 'running':
    case 'streaming':
    case 'receiving':
    case 'analyzing':
      return 1;
    case 'pending_confirmation':
    case 'confirmed':
    case 'finishing':
    case 'cancelling':
      return 2;
    case 'completed':
    case 'cancelled':
    case 'rejected':
    case 'error':
      return 3;
    default:
      return 0;
  }
}

function substantiveRoundItems(round: ModelRound): AnyFlowItem[] {
  return round.items;
}

type RunningStreamItem = AnyFlowItem & {
  type: 'text' | 'thinking';
  content: string;
};

function streamProgressEntries(round: ModelRound): Map<string, RunningStreamItem> {
  const entries = new Map<string, RunningStreamItem>();
  const ordinals: Record<'text' | 'thinking', number> = {
    text: 0,
    thinking: 0,
  };

  for (const item of substantiveRoundItems(round)) {
    if (item.type !== 'text' && item.type !== 'thinking') {
      continue;
    }
    const ordinal = ordinals[item.type]++;
    const attempt =
      item.attemptId ||
      (typeof item.attemptIndex === 'number' ? `index:${item.attemptIndex}` : 'default');
    entries.set(`${item.type}:${attempt}:${ordinal}`, item as RunningStreamItem);
  }

  return entries;
}

function toolProgressEntries(round: ModelRound): Map<string, FlowToolItem> {
  const entries = new Map<string, FlowToolItem>();
  for (const item of substantiveRoundItems(round)) {
    if (item.type !== 'tool') {
      continue;
    }
    const tool = item as FlowToolItem;
    entries.set(tool.toolCall?.id || tool.id, tool);
  }
  return entries;
}

/**
 * Accept an active persisted snapshot only when it is provably ahead of the
 * controller projection. Peer text-item ids are generated independently on
 * each device, so progress is compared by round/type/attempt/ordinal and
 * content prefix instead of item id.
 */
function isRunningSnapshotForwardProgress(
  current: DialogTurn,
  snapshot: DialogTurn,
): boolean {
  if (current.id !== snapshot.id) {
    return false;
  }

  let advanced =
    runningStatusRank(snapshot.status) > runningStatusRank(current.status) ||
    snapshot.modelRounds.length > current.modelRounds.length;

  for (const currentRound of current.modelRounds) {
    const snapshotRound = snapshot.modelRounds.find(round => round.id === currentRound.id);
    if (!snapshotRound) {
      return false;
    }
    if (runningStatusRank(snapshotRound.status) < runningStatusRank(currentRound.status)) {
      return false;
    }
    if (runningStatusRank(snapshotRound.status) > runningStatusRank(currentRound.status)) {
      advanced = true;
    }

    const currentStreams = streamProgressEntries(currentRound);
    const snapshotStreams = streamProgressEntries(snapshotRound);
    for (const [key, currentItem] of currentStreams) {
      const snapshotItem = snapshotStreams.get(key);
      if (!snapshotItem || !snapshotItem.content.startsWith(currentItem.content)) {
        return false;
      }
      if (snapshotItem.content.length > currentItem.content.length) {
        advanced = true;
      }
    }
    if (snapshotStreams.size > currentStreams.size) {
      advanced = true;
    }

    const currentTools = toolProgressEntries(currentRound);
    const snapshotTools = toolProgressEntries(snapshotRound);
    for (const [key, currentTool] of currentTools) {
      const snapshotTool = snapshotTools.get(key);
      if (
        !snapshotTool ||
        runningStatusRank(snapshotTool.status) < runningStatusRank(currentTool.status) ||
        (currentTool.toolResult && !snapshotTool.toolResult)
      ) {
        return false;
      }
      if (
        runningStatusRank(snapshotTool.status) > runningStatusRank(currentTool.status) ||
        (!currentTool.toolResult && Boolean(snapshotTool.toolResult))
      ) {
        advanced = true;
      }
    }
    if (snapshotTools.size > currentTools.size) {
      advanced = true;
    }
  }

  return advanced;
}

/**
 * Whether replacing `current` with `snapshot` would erase projected content.
 *
 * Reconciliation repairs a projection; it must never gut one. The wholesale
 * replace path exists so a settled turn can adopt the host's authoritative
 * copy, and it skips the forward-progress comparator to do that. But a turn
 * carries its identity and user message independently of its rounds, so a
 * windowed or not-yet-checkpointed snapshot can name the same turn while
 * carrying none of its work. Replacing then leaves the user prompt on screen
 * with the entire response gone.
 *
 * This is reachable on any surface, and guaranteed right after a device-surface
 * switch: the rebuilt projection has no state machines, so every turn reads as
 * idle and every snapshot qualifies for replacement.
 */
function snapshotDropsProjectedTurnContent(
  current: DialogTurn,
  snapshot: DialogTurn,
): boolean {
  if (snapshot.modelRounds.length < current.modelRounds.length) {
    return true;
  }

  for (const currentRound of current.modelRounds) {
    const snapshotRound = snapshot.modelRounds.find(round => round.id === currentRound.id);
    if (!snapshotRound) {
      return true;
    }
    const currentStreams = streamProgressEntries(currentRound);
    const snapshotStreams = streamProgressEntries(snapshotRound);
    for (const [key, currentItem] of currentStreams) {
      const snapshotItem = snapshotStreams.get(key);
      // The same text/thinking item can still be only an earlier checkpoint
      // prefix. Item counts alone therefore do not make replacement lossless.
      if (!snapshotItem || !snapshotItem.content.startsWith(currentItem.content)) {
        return true;
      }
    }

    const currentTools = toolProgressEntries(currentRound);
    const snapshotTools = toolProgressEntries(snapshotRound);
    for (const [key, currentTool] of currentTools) {
      const snapshotTool = snapshotTools.get(key);
      if (!snapshotTool || (currentTool.toolResult && !snapshotTool.toolResult)) {
        return true;
      }
    }
  }

  return false;
}

function preserveClientDerivedDisplayItems(
  current: DialogTurn,
  persisted: DialogTurn,
): DialogTurn {
  let changed = false;
  const modelRounds = persisted.modelRounds.map(persistedRound => {
    const currentRound = current.modelRounds.find(round => round.id === persistedRound.id);
    if (!currentRound) {
      return persistedRound;
    }
    const persistedIds = new Set(persistedRound.items.map(item => item.id));
    const derivedItems = currentRound.items.filter(item =>
      item.type === 'tool'
      && item.id.startsWith('plan-display-')
      && !persistedIds.has(item.id),
    );
    if (derivedItems.length === 0) {
      return persistedRound;
    }
    changed = true;
    return {
      ...persistedRound,
      items: [...persistedRound.items, ...derivedItems],
    };
  });

  return changed ? { ...persisted, modelRounds } : persisted;
}

/**
 * Whether a persisted-record read may replace the Turn already projected.
 *
 * Contract 2 of docs/architecture/session-projection.md: the runtime stream
 * owns an executing Turn, so its persisted copy — deliberately stored idle so a
 * restart never revives work, and therefore lagging and shaped like a finished
 * Turn — must not be painted over it. Doing so left a controller showing less
 * of a Turn than the Host, and showing it as finished while the Host was still
 * streaming (regression: 2026-08-17).
 *
 * Those two symptoms together are the signature. Missing token usage is not
 * part of it: a provider that returns no usage stats produces the same empty
 * field on a perfectly healthy Turn.
 *
 * Two cases keep a content comparison, and both are places the contract does
 * not yet reach:
 *
 * - An older Host serves no runtime projection at all. With no runtime stream
 *   to own the Turn, its checkpoint is the only progress there is, so forward
 *   progress is still admitted.
 * - A settled Turn belongs to the persisted record, but a windowed or
 *   not-yet-checkpointed read can name a Turn while carrying none of its work.
 *   A history read carries no position for content it omitted, so "does this
 *   write lose content" is still the only question available. This guard is
 *   deletable once a read reports its own completeness.
 */
function persistedReadMayReplaceTurn(
  sessionId: string,
  projected: DialogTurn,
  incoming: DialogTurn,
  hostExecutingTurnId: string | undefined,
  hostServesRuntimeProjection: boolean,
): boolean {
  if (!persistedMayWriteTurn(sessionId, incoming.id, hostExecutingTurnId)) {
    return (
      !hostServesRuntimeProjection &&
      isRunningSnapshotForwardProgress(projected, incoming)
    );
  }
  return !snapshotDropsProjectedTurnContent(projected, incoming);
}

/** Empty current-Turn shell so Runtime journal replay cannot overlap a persist checkpoint. */
function asRuntimeReplayTurn(turn: DialogTurn): DialogTurn {
  return {
    ...turn,
    modelRounds: [],
    status: 'pending',
    endTime: undefined,
    error: undefined,
    errorDetail: undefined,
    success: undefined,
    finishReason: undefined,
    hasFinalResponse: undefined,
    recovery: undefined,
  };
}

function coerceRuntimeEventSnapshot(
  snapshot: SessionRuntimeEventSnapshot | null | undefined,
  sessionId: string,
  backendActive: boolean,
  fallbackActiveTurnId?: string,
): SessionRuntimeEventSnapshot | undefined {
  if (
    !backendActive ||
    snapshot?.sessionId !== sessionId ||
    typeof snapshot.streamId !== 'string' ||
    !snapshot.streamId ||
    !Number.isSafeInteger(snapshot.cursor) ||
    !Array.isArray(snapshot.events)
  ) {
    return undefined;
  }
  const activeTurnId = snapshot.activeTurnId || fallbackActiveTurnId;
  if (!activeTurnId) {
    return undefined;
  }
  if (snapshot.activeTurnId && snapshot.activeTurnId !== activeTurnId) {
    return undefined;
  }
  return snapshot.activeTurnId
    ? snapshot
    : { ...snapshot, activeTurnId };
}

interface PendingUserQuestionReconcileResult {
  turns: DialogTurn[];
  changed: boolean;
  revisionApplied: boolean;
}

/**
 * Rebuild the user-input card from the Runtime mailbox, independently of the
 * persisted Turn checkpoint. A running Tool can wait indefinitely, so its
 * push event is not recoverable by waiting for Turn completion.
 */
function reconcilePendingUserQuestionSnapshot(
  turns: DialogTurn[],
  snapshot: PendingUserQuestionSnapshot | undefined,
  previousRevision: number,
): PendingUserQuestionReconcileResult {
  if (
    !snapshot ||
    !Number.isFinite(snapshot.revision) ||
    snapshot.revision < previousRevision
  ) {
    return { turns, changed: false, revisionApplied: false };
  }

  const nextTurns = turns.map(turn => ({
    ...turn,
    modelRounds: turn.modelRounds.map(round => ({
      ...round,
      items: [...round.items],
    })),
  }));
  const pendingIds = new Set(snapshot.questions.map(question => question.toolId));
  let changed = false;
  let fullyApplied = true;

  // Remove only cards that this reconciliation path previously marked as
  // mailbox projections. An existing live/persisted item is marked only while
  // the Runtime says it is pending; after that, the mailbox is authoritative
  // for whether the blocking card should remain.
  for (const turn of nextTurns) {
    for (const round of turn.modelRounds) {
      const retained: AnyFlowItem[] = [];
      for (const item of round.items) {
        if (item.type !== 'tool') {
          retained.push(item);
          continue;
        }
        const tool = item as FlowToolItem;
        if (tool._runtimeInteractionProjection?.kind !== 'user_question') {
          retained.push(tool);
          continue;
        }
        const toolId = tool.toolCall?.id || tool.id;
        if (pendingIds.has(toolId)) {
          retained.push(tool);
          continue;
        }
        if (tool.toolResult || runningStatusRank(tool.status) >= 3) {
          const { _runtimeInteractionProjection: _projection, ...settledTool } = tool;
          retained.push(settledTool as FlowToolItem);
          changed = true;
          continue;
        }
        changed = true;
      }
      if (retained.length !== round.items.length) {
        round.items = retained;
      } else if (retained.some((item, index) => item !== round.items[index])) {
        round.items = retained;
      }
    }
  }

  for (const pending of snapshot.questions) {
    if (!pending || pending.sessionId === '') {
      continue;
    }
    const turn = pending.dialogTurnId
      ? nextTurns.find(candidate => candidate.id === pending.dialogTurnId)
      : nextTurns[nextTurns.length - 1];
    if (!turn || turn.sessionId !== pending.sessionId) {
      // Tail restore should always contain the active Turn. If it does not,
      // leave the revision uncommitted so the next reconciliation retries
      // after that Turn is available instead of losing the mailbox entry.
      fullyApplied = false;
      continue;
    }

    let targetRound = turn.modelRounds.find(round =>
      round.items.some(item =>
        item.type === 'tool' &&
        ((item as FlowToolItem).toolCall?.id === pending.toolId || item.id === pending.toolId)
      )
    );
    if (!targetRound && pending.modelRoundId) {
      targetRound = turn.modelRounds.find(round => round.id === pending.modelRoundId);
    }
    if (!targetRound) {
      targetRound = turn.modelRounds[turn.modelRounds.length - 1];
    }
    if (!targetRound) {
      targetRound = {
        id: pending.modelRoundId || `runtime-interaction-${pending.toolId}`,
        index: 0,
        items: [],
        isStreaming: true,
        isComplete: false,
        status: 'streaming',
        startTime: pending.registeredAtMs,
      };
      turn.modelRounds.push(targetRound);
      changed = true;
    }

    const existingIndex = targetRound.items.findIndex(item =>
      item.type === 'tool' &&
      ((item as FlowToolItem).toolCall?.id === pending.toolId || item.id === pending.toolId)
    );
    const existing = existingIndex >= 0
      ? targetRound.items[existingIndex] as FlowToolItem
      : undefined;
    const alreadyProjected =
      existing?._runtimeInteractionProjection?.revision === snapshot.revision &&
      existing.status === 'waiting' &&
      existing.toolName === 'AskUserQuestion' &&
      existing.isParamsStreaming === false &&
      existing.toolResult === undefined;
    if (!alreadyProjected) {
      const projected: FlowToolItem = {
        ...(existing || {
          id: pending.toolId,
          type: 'tool',
          timestamp: pending.registeredAtMs,
          requiresConfirmation: false,
        }),
        id: pending.toolId,
        type: 'tool',
        toolName: 'AskUserQuestion',
        userQuestionWait: projectUserQuestionTiming(pending.questions, pending.interactionStarted === true),
        toolCall: {
          id: pending.toolId,
          input: pending.questions,
        },
        toolResult: undefined,
        status: 'waiting',
        isParamsStreaming: false,
        startTime: existing?.startTime ?? pending.registeredAtMs,
        endTime: undefined,
        _runtimeInteractionProjection: {
          kind: 'user_question',
          revision: snapshot.revision,
        },
      };
      if (existingIndex >= 0) {
        targetRound.items[existingIndex] = projected;
      } else {
        targetRound.items.push(projected);
      }
      changed = true;
    }

    if (
      targetRound.status !== 'streaming' ||
      targetRound.isComplete ||
      !targetRound.isStreaming
    ) {
      targetRound.status = 'streaming';
      targetRound.isComplete = false;
      targetRound.isStreaming = true;
      changed = true;
    }
    if (turn.status !== 'processing') {
      turn.status = 'processing';
      changed = true;
    }
  }

  for (const turn of nextTurns) {
    turn.modelRounds = turn.modelRounds.map(round => {
      const reconciled = reconcileInteractionAttemptItems(round);
      changed ||= reconciled !== round;
      return reconciled;
    });
  }

  return {
    turns: changed ? nextTurns : turns,
    changed,
    revisionApplied: fullyApplied,
  };
}

/** Keep mailbox edits in the attempt owner used by rendering and later stream writes. */
function reconcileInteractionAttemptItems(round: ModelRound): ModelRound {
  if (!round.attempts?.length) return round;
  const attemptItems = flattenRoundAttemptItems(round);
  const isMailboxItem = (item: AnyFlowItem) => item.type === 'tool' &&
    item._runtimeInteractionProjection?.kind === 'user_question';
  if (!round.items.some(isMailboxItem) && !attemptItems.some(isMailboxItem)) return round;
  if (attemptItems.length === round.items.length &&
      attemptItems.every((item, index) => item === round.items[index])) return round;

  const itemsById = new Map(round.items.map(item => [item.id, item]));
  const ownedIds = new Set(round.attempts.flatMap(attempt => attempt.items.map(item => item.id)));
  const added = round.items.filter(item => !ownedIds.has(item.id));
  const attempts = round.attempts.map(attempt => ({
    ...attempt,
    items: attempt.items.flatMap(item => {
      const replacement = itemsById.get(item.id);
      return replacement ? [replacement] : [];
    }),
  }));
  if (added.length) {
    // Diagnostic-only attempts remain history. A recovered interaction must
    // have a visible current owner, even when the checkpoint has no live attempt.
    let active = sortAttemptEntries(attempts).at(-1);
    if (!active || active.diagnostic || active.status === 'superseded') {
      active = {
        id: `runtime-interaction:${round.id}`,
        index: Math.max(...attempts.map(attempt => attempt.index)) + 1,
        status: 'streaming',
        items: [],
      };
      attempts.push(active);
    }
    const owner = active;
    owner.items.push(...added.map(item => withAttemptMetadata(item, owner)));
  }
  return synchronizeRoundAttempts({ ...round, attempts });
}

function itemMatchesIdentity(item: AnyFlowItem, itemId: string): boolean {
  if (item.id === itemId) {
    return true;
  }

  if (item.type === 'tool') {
    return (item as FlowToolItem).toolCall?.id === itemId;
  }

  return false;
}

function withAttemptMetadata<T extends AnyFlowItem>(
  item: T,
  attempt: { id: string; index: number },
): T {
  if (item.attemptId === attempt.id && item.attemptIndex === attempt.index) {
    return item;
  }

  return {
    ...item,
    attemptId: attempt.id,
    attemptIndex: attempt.index,
  };
}

function sortAttemptEntries<T extends { index: number }>(attempts: T[]): T[] {
  return [...attempts].sort((left, right) => left.index - right.index);
}

function isFlowItemActiveStatus(status: AnyFlowItem['status']): boolean {
  return [
    'pending',
    'queued',
    'waiting',
    'preparing',
    'running',
    'streaming',
    'receiving',
    'pending_confirmation',
    'confirmed',
    'analyzing',
  ].includes(status);
}

function normalizeSupersededItem(item: AnyFlowItem, endedAt: number): AnyFlowItem {
  if (item.type === 'text') {
    return {
      ...item,
      isStreaming: false,
      status: 'completed',
    };
  }

  if (item.type === 'thinking') {
    return {
      ...item,
      isStreaming: false,
      isCollapsed: true,
      status: 'completed',
    };
  }

  if (item.type === 'tool') {
    const toolItem = item as FlowToolItem;
    if (!isFlowItemActiveStatus(toolItem.status)) {
      return item;
    }

    const startTime = toolItem.startTime;
    return {
      ...toolItem,
      status: 'cancelled',
      requiresConfirmation: false,
      acpPermission: undefined,
      isParamsStreaming: false,
      interruptionReason: 'retry_superseded',
      endTime: toolItem.endTime ?? endedAt,
      durationMs: toolItem.durationMs ?? (
        typeof startTime === 'number' ? Math.max(0, endedAt - startTime) : undefined
      ),
      toolResult: toolItem.toolResult ?? {
        result: null,
        success: false,
        error: 'Superseded by a newer retry in the same model round.',
      },
    };
  }

  return item;
}

function deriveAttemptStatus(
  round: ModelRound,
  attempt: ModelRoundAttempt,
  attemptIndex: number,
  attemptCount: number,
): ModelRoundAttempt['status'] {
  const isLatestAttempt = attemptIndex === attemptCount - 1;
  if (!isLatestAttempt) {
    return 'superseded';
  }

  if (round.status === 'completed') {
    return 'completed';
  }
  if (round.status === 'cancelled') {
    return 'cancelled';
  }
  if (round.status === 'error') {
    return 'failed';
  }
  if (attempt.status === 'superseded') {
    return 'superseded';
  }
  return 'streaming';
}

function normalizePersistedToolInterruptionReason(
  interruptionReason: unknown,
  status: unknown,
): FlowToolItem['interruptionReason'] {
  if (interruptionReason === 'retry_superseded') {
    return 'retry_superseded';
  }

  if (interruptionReason === 'app_restart') {
    return 'app_restart';
  }

  return isTransientToolStatus(status) ? 'app_restart' : undefined;
}

function flattenRoundAttemptItems(round: ModelRound): AnyFlowItem[] {
  const attempts = sortAttemptEntries(round.attempts ?? []);
  return attempts.flatMap(attempt => attempt.items);
}

function deriveRoundAttemptsFromItems(items: AnyFlowItem[]): ModelRound['attempts'] | undefined {
  const attempts: Array<ModelRoundAttempt> = [];
  const byKey = new Map<string, number>();
  const leadingUnassigned: AnyFlowItem[] = [];
  let currentAttemptKey: string | null = null;
  let hasAttemptedItems = false;

  const getOrCreateAttempt = (id: string, index: number) => {
    const key = `${id}::${index}`;
    const existingIndex = byKey.get(key);
    if (existingIndex !== undefined) {
      return attempts[existingIndex];
    }

    const attempt: ModelRoundAttempt = { id, index, status: 'streaming', items: [] as AnyFlowItem[] };
    byKey.set(key, attempts.length);
    attempts.push(attempt);
    return attempt;
  };

  for (const item of items) {
    const attemptId = typeof item.attemptId === 'string' && item.attemptId.length > 0
      ? item.attemptId
      : undefined;
    const attemptIndex = typeof item.attemptIndex === 'number' && Number.isFinite(item.attemptIndex)
      ? item.attemptIndex
      : undefined;

    if (attemptId || attemptIndex !== undefined) {
      hasAttemptedItems = true;
      const resolvedIndex = attemptIndex ?? attempts.length + 1;
      const resolvedId = attemptId ?? `attempt:${resolvedIndex}`;
      const attempt = getOrCreateAttempt(resolvedId, resolvedIndex);

      if (leadingUnassigned.length > 0 && attempts.length === 1 && attempt.items.length === 0) {
        attempt.items.push(...leadingUnassigned.map(unassigned => withAttemptMetadata(unassigned, attempt)));
        leadingUnassigned.length = 0;
      }

      attempt.items.push(withAttemptMetadata(item, attempt));
      currentAttemptKey = `${attempt.id}::${attempt.index}`;
      continue;
    }

    if (currentAttemptKey) {
      const attemptIndexInList = byKey.get(currentAttemptKey);
      if (attemptIndexInList !== undefined) {
        const attempt = attempts[attemptIndexInList];
        attempt.items.push(withAttemptMetadata(item, attempt));
        continue;
      }
    }

    leadingUnassigned.push(item);
  }

  if (!hasAttemptedItems) {
    return undefined;
  }

  if (leadingUnassigned.length > 0 && attempts.length > 0) {
    const firstAttempt = attempts[0];
    firstAttempt.items.unshift(...leadingUnassigned.map(item => withAttemptMetadata(item, firstAttempt)));
  }

  return sortAttemptEntries(attempts);
}

function synchronizeRoundAttempts(round: ModelRound): ModelRound {
  const attempts = round.attempts ?? deriveRoundAttemptsFromItems(round.items);
  if (!attempts || attempts.length === 0) {
    return round;
  }

  const endedAt = round.endTime ?? Date.now();
  const sortedAttempts = sortAttemptEntries(attempts).map((attempt, index, allAttempts) => {
    const status = deriveAttemptStatus(round, attempt, index, allAttempts.length);
    return {
      ...attempt,
      status,
      items: status === 'superseded'
        ? attempt.items.map(item => normalizeSupersededItem(item, endedAt))
        : attempt.items.map(item => {
            if (item.type === 'text') {
              return round.isStreaming ? item : { ...item, isStreaming: false };
            }
            if (item.type === 'thinking') {
              return round.isStreaming ? item : { ...item, isStreaming: false };
            }
            return item;
          }),
    };
  });
  const disableExploreGrouping = sortedAttempts.length > 1;

  return {
    ...round,
    attempts: sortedAttempts,
    items: flattenRoundAttemptItems({ ...round, attempts: sortedAttempts }),
    renderHints: disableExploreGrouping
      ? {
          ...(round.renderHints ?? {}),
          disableExploreGrouping: true,
        }
      : round.renderHints,
  };
}

export function mergeModelRoundAttemptDiagnostics(
  round: ModelRound,
  diagnostics: ModelRoundAttemptDiagnostic[] | undefined,
  options: { supersedeMatchingAttempts?: boolean } = {},
): ModelRound {
  if (!diagnostics || diagnostics.length === 0) {
    return round;
  }

  const attempts = round.attempts ?? deriveRoundAttemptsFromItems(round.items) ?? [];
  const diagnosticByKey = new Map<string, ModelRoundAttemptDiagnostic>();
  for (const diagnostic of round.attemptDiagnostics ?? []) {
    diagnosticByKey.set(`${diagnostic.attemptId}::${diagnostic.attemptIndex}`, diagnostic);
  }
  for (const attempt of attempts) {
    if (attempt.diagnostic) {
      diagnosticByKey.set(`${attempt.diagnostic.attemptId}::${attempt.diagnostic.attemptIndex}`, attempt.diagnostic);
    }
  }
  for (const diagnostic of diagnostics) {
    diagnosticByKey.set(`${diagnostic.attemptId}::${diagnostic.attemptIndex}`, diagnostic);
  }

  const sortedDiagnostics = [...diagnosticByKey.values()].sort((left, right) => (
    left.attemptIndex - right.attemptIndex || left.attemptId.localeCompare(right.attemptId)
  ));
  const supersededKeys = new Set(
    options.supersedeMatchingAttempts
      ? diagnostics.map(diagnostic => `${diagnostic.attemptId}::${diagnostic.attemptIndex}`)
      : [],
  );
  const nextAttempts = attempts.map(attempt => {
    const key = `${attempt.id}::${attempt.index}`;
    const diagnostic = diagnosticByKey.get(key) ?? attempt.diagnostic;
    return supersededKeys.has(key)
      ? { ...attempt, status: 'superseded' as const, diagnostic }
      : diagnostic ? { ...attempt, diagnostic } : attempt;
  });
  const knownKeys = new Set(nextAttempts.map(attempt => `${attempt.id}::${attempt.index}`));

  for (const diagnostic of sortedDiagnostics) {
    const key = `${diagnostic.attemptId}::${diagnostic.attemptIndex}`;
    if (!knownKeys.has(key)) {
      nextAttempts.push({
        id: diagnostic.attemptId,
        index: diagnostic.attemptIndex,
        status: 'superseded',
        items: [],
        diagnostic,
      });
    }
  }

  return {
    ...round,
    attemptDiagnostics: sortedDiagnostics,
    attempts: sortAttemptEntries(nextAttempts),
  };
}

interface FullHistoryHydrationReleaseOptions {
  immediate?: boolean;
  reason?: string;
}

interface MetadataListRequest {
  promise: Promise<void>;
  completedAtMs?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface MetadataPageRequest {
  promise: Promise<SessionMetadataPage>;
  completedAtMs?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface FullHistoryHydrationRequest {
  surfaceId: DeviceSurfaceId;
  sessionId: string;
  remote: boolean;
  requireActiveSession: boolean;
  sessionTraceId: string;
  promise: Promise<void>;
  cancel?: () => void;
  startNow?: () => void;
  releaseAfterInitialPaint?: (options?: FullHistoryHydrationReleaseOptions) => void;
}

interface CompleteSessionHistoryLoadRequest {
  sessionId: string;
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
  requireActiveSession?: boolean;
  startImmediately?: boolean;
  initialSessionTraceId: string;
  expectedDialogTurnIds: string[];
}

interface DeferredFullHistoryProjection {
  remote: boolean;
  requireActiveSession: boolean;
  expectedDialogTurnIds: string[];
  dialogTurns: DialogTurn[];
  contextRestoreState: SessionContextRestoreState;
  restoredSessionInfo?: AgentSessionInfo;
  restoredLastUserDialogMode?: string;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function selectPreferredTurnCatalog(
  current: SessionTurnCatalog | undefined,
  restored: SessionTurnCatalog | undefined,
): SessionTurnCatalog | undefined {
  if (!restored) {
    return current;
  }
  if (!current) {
    return restored;
  }
  if (current.complete && !restored.complete) {
    return current;
  }
  if (
    current.revision === restored.revision
    && current.complete === restored.complete
    && current.totalTurnCount === restored.totalTurnCount
  ) {
    return current;
  }
  return restored;
}

function truncateTurnCatalog(
  catalog: SessionTurnCatalog,
  endOrdinalExclusive: number,
  revision: string,
): SessionTurnCatalog {
  return {
    ...catalog,
    revision,
    totalTurnCount: endOrdinalExclusive,
    entries: catalog.entries
      .filter(entry => entry.ordinal < endOrdinalExclusive)
      .map(entry => ({ ...entry })),
  };
}

function mergeLoadedTurnRanges(
  ranges: readonly LoadedTurnRange[],
  incoming: LoadedTurnRange,
): LoadedTurnRange[] {
  const sorted = [...ranges, incoming]
    .filter(range =>
      range.startOrdinal >= 0
      && range.endOrdinalExclusive > range.startOrdinal
      && range.turns.length === range.endOrdinalExclusive - range.startOrdinal
    )
    .sort((left, right) =>
      left.startOrdinal - right.startOrdinal
      || left.endOrdinalExclusive - right.endOrdinalExclusive
      || left.lastAccessedAt - right.lastAccessedAt
    );
  const merged: LoadedTurnRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startOrdinal > previous.endOrdinalExclusive) {
      merged.push({ ...range, turns: [...range.turns] });
      continue;
    }

    const startOrdinal = previous.startOrdinal;
    const endOrdinalExclusive = Math.max(
      previous.endOrdinalExclusive,
      range.endOrdinalExclusive,
    );
    const turnsByOrdinal = new Map<number, DialogTurn>();
    previous.turns.forEach((turn, index) => {
      turnsByOrdinal.set(previous.startOrdinal + index, turn);
    });
    range.turns.forEach((turn, index) => {
      turnsByOrdinal.set(range.startOrdinal + index, turn);
    });
    const turns: DialogTurn[] = [];
    for (let ordinal = startOrdinal; ordinal < endOrdinalExclusive; ordinal += 1) {
      const turn = turnsByOrdinal.get(ordinal);
      if (!turn) {
        break;
      }
      turns.push(turn);
    }
    if (turns.length !== endOrdinalExclusive - startOrdinal) {
      merged.push({ ...range, turns: [...range.turns] });
      continue;
    }

    merged[merged.length - 1] = {
      startOrdinal,
      endOrdinalExclusive,
      turns,
      lastAccessedAt: Math.max(previous.lastAccessedAt, range.lastAccessedAt),
      source:
        range.lastAccessedAt >= previous.lastAccessedAt
          ? range.source
          : previous.source,
    };
  }

  return merged;
}

function sliceLoadedTurnRange(
  range: LoadedTurnRange,
  startOrdinal: number,
  endOrdinalExclusive: number,
): DialogTurn[] | null {
  if (
    startOrdinal < range.startOrdinal
    || endOrdinalExclusive > range.endOrdinalExclusive
    || endOrdinalExclusive <= startOrdinal
  ) {
    return null;
  }

  const turns = range.turns.slice(
    startOrdinal - range.startOrdinal,
    endOrdinalExclusive - range.startOrdinal,
  );
  return turns.length === endOrdinalExclusive - startOrdinal ? turns : null;
}

function mergeOrdinalIntervals(intervals: readonly OrdinalInterval[]): OrdinalInterval[] {
  const sorted = intervals
    .filter(interval => interval.endOrdinalExclusive > interval.startOrdinal)
    .map(interval => ({ ...interval }))
    .sort((left, right) =>
      left.startOrdinal - right.startOrdinal
      || left.endOrdinalExclusive - right.endOrdinalExclusive
    );
  const merged: OrdinalInterval[] = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startOrdinal > previous.endOrdinalExclusive) {
      merged.push(interval);
      continue;
    }
    previous.endOrdinalExclusive = Math.max(
      previous.endOrdinalExclusive,
      interval.endOrdinalExclusive,
    );
  }

  return merged;
}

function ordinalIsInIntervals(
  ordinal: number,
  intervals: readonly OrdinalInterval[],
): boolean {
  return intervals.some(interval =>
    interval.startOrdinal <= ordinal && interval.endOrdinalExclusive > ordinal
  );
}

function ordinalDistanceFromIntervals(
  ordinal: number,
  intervals: readonly OrdinalInterval[],
): number {
  if (intervals.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  let distance = Number.MAX_SAFE_INTEGER;
  for (const interval of intervals) {
    if (ordinal < interval.startOrdinal) {
      distance = Math.min(distance, interval.startOrdinal - ordinal);
    } else if (ordinal >= interval.endOrdinalExclusive) {
      distance = Math.min(distance, ordinal - interval.endOrdinalExclusive + 1);
    } else {
      return 0;
    }
  }
  return distance;
}

function subtractOrdinalIntervals(
  interval: OrdinalInterval,
  exclusions: readonly OrdinalInterval[],
): OrdinalInterval[] {
  const remaining: OrdinalInterval[] = [];
  let cursor = interval.startOrdinal;

  for (const exclusion of exclusions) {
    if (exclusion.endOrdinalExclusive <= cursor) {
      continue;
    }
    if (exclusion.startOrdinal >= interval.endOrdinalExclusive) {
      break;
    }
    if (exclusion.startOrdinal > cursor) {
      remaining.push({
        startOrdinal: cursor,
        endOrdinalExclusive: Math.min(exclusion.startOrdinal, interval.endOrdinalExclusive),
      });
    }
    cursor = Math.max(cursor, exclusion.endOrdinalExclusive);
    if (cursor >= interval.endOrdinalExclusive) {
      break;
    }
  }

  if (cursor < interval.endOrdinalExclusive) {
    remaining.push({
      startOrdinal: cursor,
      endOrdinalExclusive: interval.endOrdinalExclusive,
    });
  }
  return remaining;
}

function selectTargetHistoryPresentationRange(
  range: LoadedTurnRange,
  targetOrdinal: number,
): { startOrdinal: number; endOrdinalExclusive: number } {
  if (range.endOrdinalExclusive - range.startOrdinal <= SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET) {
    return {
      startOrdinal: range.startOrdinal,
      endOrdinalExclusive: range.endOrdinalExclusive,
    };
  }

  const beforeBudget = Math.min(
    SESSION_TURN_WINDOW_DEFAULT_BEFORE,
    SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET - 1,
  );
  let startOrdinal = Math.max(range.startOrdinal, targetOrdinal - beforeBudget);
  const endOrdinalExclusive = Math.min(
    range.endOrdinalExclusive,
    startOrdinal + SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET,
  );
  startOrdinal = Math.max(
    range.startOrdinal,
    endOrdinalExclusive - SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET,
  );

  return { startOrdinal, endOrdinalExclusive };
}

function selectExtendedHistoryPresentationRange(
  loadedRange: LoadedTurnRange,
  activeRange: ActiveTurnRenderRange,
  direction: SessionHistoryWindowDirection,
): { startOrdinal: number; endOrdinalExclusive: number } {
  let startOrdinal = activeRange.startOrdinal;
  let endOrdinalExclusive = activeRange.endOrdinalExclusive;

  if (direction === 'before') {
    startOrdinal = Math.max(
      loadedRange.startOrdinal,
      activeRange.startOrdinal - SESSION_HISTORY_PRESENTATION_PREFETCH_TURN_COUNT,
    );
  } else {
    endOrdinalExclusive = Math.min(
      loadedRange.endOrdinalExclusive,
      activeRange.endOrdinalExclusive + SESSION_HISTORY_PRESENTATION_PREFETCH_TURN_COUNT,
    );
  }

  if (endOrdinalExclusive - startOrdinal <= SESSION_HISTORY_PRESENTATION_HARD_TURN_BUDGET) {
    return { startOrdinal, endOrdinalExclusive };
  }

  if (direction === 'before') {
    endOrdinalExclusive = Math.min(
      loadedRange.endOrdinalExclusive,
      startOrdinal + SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET,
    );
  } else {
    startOrdinal = Math.max(
      loadedRange.startOrdinal,
      endOrdinalExclusive - SESSION_HISTORY_PRESENTATION_SOFT_TURN_BUDGET,
    );
  }

  return { startOrdinal, endOrdinalExclusive };
}

function startsWithStringArray(values: string[], prefix: string[]): boolean {
  return values.length >= prefix.length && prefix.every((value, index) => values[index] === value);
}

function scheduleHistoricalSessionFullHydrate(callback: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) {
      return;
    }
    callback();
  };

  const requestIdleCallback = (globalThis as {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  }).requestIdleCallback;
  const cancelIdleCallback = (globalThis as {
    cancelIdleCallback?: (handle: number) => void;
  }).cancelIdleCallback;

  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, {
      timeout: HISTORICAL_SESSION_FULL_HISTORY_IDLE_TIMEOUT_MS,
    });
    return () => {
      cancelled = true;
      cancelIdleCallback?.(handle);
    };
  }

  const timer = globalThis.setTimeout(run, HISTORICAL_SESSION_FULL_HISTORY_IDLE_TIMEOUT_MS);
  return () => {
    cancelled = true;
    globalThis.clearTimeout(timer);
  };
}

function scheduleLocalHistoricalSessionFullHydrate(
  callback: (reason: 'initial_paint' | 'timeout' | 'explicit') => void,
): {
  cancel: () => void;
  releaseAfterInitialPaint: (options?: FullHistoryHydrationReleaseOptions) => void;
} {
  let cancelled = false;
  let started = false;
  let cancelIdle: (() => void) | undefined;
  const timeout = globalThis.setTimeout(
    () => start('timeout'),
    HISTORICAL_SESSION_FULL_HISTORY_FIRST_PAINT_TIMEOUT_MS,
  );

  function start(reason: 'initial_paint' | 'timeout' | 'explicit') {
    if (cancelled || started) {
      return;
    }

    started = true;
    globalThis.clearTimeout(timeout);
    cancelIdle = scheduleHistoricalSessionFullHydrate(() => callback(reason));
  }

  return {
    cancel: () => {
      cancelled = true;
      globalThis.clearTimeout(timeout);
      cancelIdle?.();
    },
    releaseAfterInitialPaint: (options?: FullHistoryHydrationReleaseOptions) => {
      if (options?.immediate === true) {
        start('explicit');
        return;
      }
      if (started || cancelled) {
        return;
      }
      start('initial_paint');
    },
  };
}

function historicalSessionInitialTailTurnCount(remote: boolean): number {
  return remote
    ? HISTORICAL_SESSION_INITIAL_REMOTE_TAIL_TURN_COUNT
    : HISTORICAL_SESSION_INITIAL_LOCAL_TAIL_TURN_COUNT;
}

function sessionViewRestoreTimingTraceFields(
  timing: SessionViewRestoreTiming | undefined,
): Record<string, unknown> {
  if (!timing) {
    return {};
  }

  return {
    restoreResolveStorageDurationMs: timing.resolveStoragePathDurationMs,
    restoreVisibilityMetadataDurationMs: timing.visibilityMetadataDurationMs,
    restoreLoadSessionWithTurnsDurationMs: timing.loadSessionWithTurnsDurationMs,
    restoreNormalizeTurnIdsDurationMs: timing.normalizeTurnIdsDurationMs,
    restoreTurnCatalogDurationMs: timing.turnCatalogDurationMs,
    restoreTotalDurationMs: timing.totalDurationMs,
    restoreTurnTailCount: timing.turnLoad?.requestedTailTurnCount,
    restoreTurnLoadedCount: timing.turnLoad?.loadedTurnCount,
    restoreTurnTotalCount: timing.turnLoad?.totalTurnCount,
    restoreTurnFileCount: timing.turnLoad?.turnFileCount,
    restoreTurnMissingFileCount: timing.turnLoad?.missingTurnFileCount,
    restoreTurnFastPath: timing.turnLoad?.fastPath,
    restoreTurnMetadataDurationMs: timing.turnLoad?.metadataDurationMs,
    restoreTurnStateDurationMs: timing.turnLoad?.stateDurationMs,
    restoreTurnScanDurationMs: timing.turnLoad?.scanDurationMs,
    restoreTurnReadDurationMs: timing.turnLoad?.readDurationMs,
    restoreTurnMaxReadDurationMs: timing.turnLoad?.maxTurnReadDurationMs,
    restoreTurnBuildSessionDurationMs: timing.turnLoad?.buildSessionDurationMs,
    restoreTurnTotalDurationMs: timing.turnLoad?.totalDurationMs,
  };
}

function isUnsupportedTauriCommandError(error: unknown, command: string): boolean {
  const anyError = error as any;
  const originalError = anyError?.context?.originalError;
  const messageParts = [
    anyError?.message,
    typeof originalError === 'string' ? originalError : originalError?.message,
  ].filter((part): part is string => typeof part === 'string');
  const normalizedMessage = messageParts.join(' ').toLowerCase();
  const normalizedCommand = command.toLowerCase();
  const contextCommand =
    typeof anyError?.context?.command === 'string'
      ? anyError.context.command.toLowerCase()
      : '';
  const mentionsCommand =
    contextCommand === normalizedCommand ||
    normalizedMessage.includes(normalizedCommand);

  if (!mentionsCommand) {
    return false;
  }

  return normalizedMessage.includes('unknown command') ||
    normalizedMessage.includes('command not found') ||
    (normalizedMessage.includes('command') && normalizedMessage.includes('not found')) ||
    normalizedMessage.includes('not registered') ||
    normalizedMessage.includes('is not a function');
}

/** Transport / gateway failures must fail hydrate instead of falling through to more RPCs. */
function isSessionRestoreTransportError(error: unknown): boolean {
  const anyError = error as { message?: unknown; context?: { originalError?: unknown } };
  const originalError = anyError?.context?.originalError;
  const messageParts = [
    anyError?.message,
    typeof originalError === 'string' ? originalError : (originalError as { message?: unknown })?.message,
  ].filter((part): part is string => typeof part === 'string');
  const normalizedMessage = messageParts.join(' ').toLowerCase();
  return (
    normalizedMessage.includes('504') ||
    normalizedMessage.includes('gateway timeout') ||
    normalizedMessage.includes('peer hostinvoke transport') ||
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('timeout')
  );
}

/** `surfaceScopedKey` puts the surface first, so a key can name its own owner. */
function surfaceOfScopedKey(key: string): DeviceSurfaceId | null {
  try {
    const parsed = JSON.parse(key) as unknown[];
    return typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch {
    return null;
  }
}

/**
 * A capability is negotiated with one host, not with a path: an older peer that
 * rejects `restore_session_view` says nothing about this machine. Without the
 * surface every non-SSH host collapsed onto `'local'`, so one switch permanently
 * downgraded local history restore.
 */
function restoreCommandSupportKey(
  command: string,
  remoteConnectionId?: string,
  remoteSshHost?: string
): string {
  return surfaceScopedKey(
    getActiveSurfaceId(),
    command,
    remoteConnectionId?.trim() || 'local',
    remoteSshHost?.trim().toLowerCase() || '',
  );
}

function isValidPersistedAgentType(agentType: string): boolean {
  return VALID_AGENT_TYPES.has(agentType) || agentType.startsWith('acp:');
}

interface SelectorListener<T = any> {
  selector: (state: FlowChatState) => T;
  callback: (selected: T) => void;
  isEqual: (a: T, b: T) => boolean;
  lastValue: T | undefined;
  hasLastValue: boolean;
}

/**
 * One device's world.
 *
 * Sessions and their history projections are addressed by session id and
 * workspace path, and neither is unique across devices — the same repository is
 * routinely open at the same path on two machines. Each surface therefore keeps
 * its own container, and a switch *selects* one instead of destroying it: the
 * device you return to still has its sessions, and reconciliation repairs them
 * instead of reloading from nothing.
 */
interface SurfaceStateContainer {
  readonly surfaceId: DeviceSurfaceId;
  state: FlowChatState;
  readonly sessionHistoryViews: Map<string, SessionHistoryViewState>;
  readonly sessionHistoryTurnAccessTimes: Map<string, Map<number, number>>;
  readonly deferredFullHistoryProjections: Map<string, DeferredFullHistoryProjection>;
  readonly fullHistoryProjectionApplyRequests: Set<string>;
  readonly pendingRemoveSessionOptions: Map<string, RemoveSessionOptions>;
  readonly userQuestionSnapshotRevisions: Map<string, number>;
  readonly relayQuestionMailboxes: Map<string, PendingUserQuestionSnapshot>;
  readonly relayMailboxVersions: Map<string, number>;
  readonly relayRecordVersions: Map<string, number>;
  readonly relayMailboxReads: Map<string, Promise<void>>;
  readonly relaySessionRecords: Map<string, SessionRecordReplica>;
  readonly relaySessionHistory: Map<string, RelaySessionHistory>;
}

function createSurfaceStateContainer(surfaceId: DeviceSurfaceId): SurfaceStateContainer {
  return {
    surfaceId,
    state: {
      sessions: new Map(),
      activeSessionId: null,
    },
    sessionHistoryViews: new Map(),
    sessionHistoryTurnAccessTimes: new Map(),
    deferredFullHistoryProjections: new Map(),
    fullHistoryProjectionApplyRequests: new Set(),
    pendingRemoveSessionOptions: new Map(),
    userQuestionSnapshotRevisions: new Map(),
    relayQuestionMailboxes: new Map(),
    relayRecordVersions: new Map(),
    relayMailboxVersions: new Map(),
    relayMailboxReads: new Map(),
    relaySessionRecords: new Map(),
    relaySessionHistory: new Map(),
  };
}

export class FlowChatStore {
  private static instance: FlowChatStore;
  private surfaceContainers = new Map<DeviceSurfaceId, SurfaceStateContainer>();
  private listeners: Set<(state: FlowChatState) => void> = new Set();
  private selectorListeners: Set<SelectorListener> = new Set();
  private silentMode = false;
  /**
   * Request dedup and negotiated capabilities outlive the switch that stranded
   * them, so their keys carry the surface instead of the container: an entry
   * created under one activation is still reaped correctly after another one
   * takes over.
   */
  private metadataListRequests = new Map<string, MetadataListRequest>();
  private metadataPageRequests = new Map<string, MetadataPageRequest>();
  /** Announced switches, for the window before a surface activation lands. */
  private detachedSurfaceGeneration = 0;
  private fullHistoryHydrationRequests = new Map<string, FullHistoryHydrationRequest>();
  private sessionHistoryAccessClock = 0;
  private sessionTurnWindowRequests = new Map<string, Promise<LoadSessionTurnWindowResponse>>();
  /** Requested intervals remain protected until every deduplicated caller processes the response. */
  private sessionTurnWindowProtections = new Map<string, SessionTurnWindowProtection>();
  private unsupportedRestoreCommands = new Set<string>();
  private onPersistUnreadCompletion?: (sessionId: string, value: 'completed' | 'error' | 'interrupted' | undefined) => void;

  private constructor() {
    this.clearOldStorage();
    // Selecting another surface swaps the whole visible state; subscribers keep
    // rendering the previous device's sessions until they are told.
    onSurfaceActivated(() => {
      for (const container of this.surfaceContainers.values()) {
        for (const subscription of container.relaySessionHistory.values()) subscription.close();
        container.relaySessionHistory.clear();
      }
      this.notifyListeners();
    });
  }

  private get activeSurface(): SurfaceStateContainer {
    const surfaceId = getActiveSurfaceId();
    const existing = this.surfaceContainers.get(surfaceId);
    if (existing) {
      return existing;
    }
    const created = createSurfaceStateContainer(surfaceId);
    this.surfaceContainers.set(surfaceId, created);
    return created;
  }

  private get state(): FlowChatState {
    return this.activeSurface.state;
  }

  private set state(next: FlowChatState) {
    this.activeSurface.state = next;
  }

  private get sessionHistoryViews(): Map<string, SessionHistoryViewState> {
    return this.activeSurface.sessionHistoryViews;
  }

  /** Per-ordinal recency survives adjacent range merges and enables stable range slicing. */
  private get sessionHistoryTurnAccessTimes(): Map<string, Map<number, number>> {
    return this.activeSurface.sessionHistoryTurnAccessTimes;
  }

  private get deferredFullHistoryProjections(): Map<string, DeferredFullHistoryProjection> {
    return this.activeSurface.deferredFullHistoryProjections;
  }

  private get fullHistoryProjectionApplyRequests(): Set<string> {
    return this.activeSurface.fullHistoryProjectionApplyRequests;
  }

  private get pendingRemoveSessionOptions(): Map<string, RemoveSessionOptions> {
    return this.activeSurface.pendingRemoveSessionOptions;
  }

  private get userQuestionSnapshotRevisions(): Map<string, number> {
    return this.activeSurface.userQuestionSnapshotRevisions;
  }

  /** Key a store-level cache entry to the surface that asked for it. */
  private surfaceKey(...parts: Array<string | number | undefined | null>): string {
    return surfaceScopedKey(getActiveSurfaceId(), ...parts);
  }

  /** Records outlive a switch; only the rendered surface may observe its own. */
  private ownedByActiveSurface(record: { surfaceId: DeviceSurfaceId }): boolean {
    return record.surfaceId === getActiveSurfaceId();
  }

  private clearOldStorage(): void {
    try {
      const keysToRemove = [
        'openbitfun-flow-chat-state',
        'openbitfun-flow-chat-global',
        'openbitfun-session-ids'
      ];
      
      keysToRemove.forEach(key => {
        if (localStorage.getItem(key)) {
          localStorage.removeItem(key);
        }
      });

      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('openbitfun-session-')) {
          localStorage.removeItem(key);
        }
      });
    } catch (error) {
      log.warn('Failed to clear old storage data', error);
    }
  }


  public static getInstance(): FlowChatStore {
    if (!FlowChatStore.instance) {
      FlowChatStore.instance = new FlowChatStore();
    }
    return FlowChatStore.instance;
  }

  public getState(): FlowChatState {
    return this.state;
  }

  public getSessionHistoryViewState(sessionId: string): SessionHistoryViewState | undefined {
    const view = this.sessionHistoryViews.get(sessionId);
    if (!view) {
      return undefined;
    }
    return {
      ...view,
      loadedRanges: view.loadedRanges.map(range => ({
        ...range,
        turns: [...range.turns],
      })),
      activeRange: view.activeRange ? { ...view.activeRange } : null,
    };
  }

  public getSessionCanonicalTailRange(sessionId: string): SessionTurnOrdinalRange | null {
    const interval = this.getSessionHistoryTailProtectedIntervals(
      sessionId,
      this.sessionHistoryViews.get(sessionId),
    )[0];
    return interval ? { ...interval } : null;
  }

  public activateSessionHistoryWindow(
    sessionId: string,
    targetOrdinal: number,
    navigationGeneration: number,
  ): SessionHistoryPresentation | null {
    const view = this.sessionHistoryViews.get(sessionId);
    const normalizedTargetOrdinal = Math.max(0, Math.floor(targetOrdinal));
    if (
      this.state.activeSessionId !== sessionId
      || !view
      || view.navigationGeneration !== navigationGeneration
      || view.pendingTargetOrdinal !== normalizedTargetOrdinal
    ) {
      return null;
    }

    const loadedRange = view.loadedRanges.find(range =>
      range.startOrdinal <= normalizedTargetOrdinal
      && range.endOrdinalExclusive > normalizedTargetOrdinal
    );
    if (!loadedRange) {
      return null;
    }

    const selected = selectTargetHistoryPresentationRange(loadedRange, normalizedTargetOrdinal);
    const turns = sliceLoadedTurnRange(
      loadedRange,
      selected.startOrdinal,
      selected.endOrdinalExclusive,
    );
    if (!turns) {
      return null;
    }

    const targetTurn = turns[normalizedTargetOrdinal - selected.startOrdinal];
    const range: ActiveTurnRenderRange = {
      ...selected,
      targetTurnId: targetTurn?.id ?? null,
      mode: 'history-window',
    };
    this.touchSessionHistoryTurnRange(
      sessionId,
      loadedRange,
      selected.startOrdinal,
      selected.endOrdinalExclusive,
    );
    view.activeRange = range;
    view.pendingTargetOrdinal = null;
    this.pruneSessionLoadedTurnRanges(sessionId, view);
    return { range: { ...range }, turns: [...turns] };
  }

  public reactivateSessionHistoryWindow(
    sessionId: string,
    range: ActiveTurnRenderRange,
  ): SessionHistoryPresentation | null {
    const view = this.sessionHistoryViews.get(sessionId);
    if (
      this.state.activeSessionId !== sessionId
      || !view
      || range.mode !== 'history-window'
    ) {
      return null;
    }

    const loadedRange = view.loadedRanges.find(candidate =>
      candidate.startOrdinal <= range.startOrdinal
      && candidate.endOrdinalExclusive >= range.endOrdinalExclusive
    );
    if (!loadedRange) {
      return null;
    }

    const turns = sliceLoadedTurnRange(
      loadedRange,
      range.startOrdinal,
      range.endOrdinalExclusive,
    );
    if (!turns) {
      return null;
    }

    const targetTurnId = range.targetTurnId && turns.some(turn => turn.id === range.targetTurnId)
      ? range.targetTurnId
      : null;
    const nextRange: ActiveTurnRenderRange = {
      ...range,
      targetTurnId,
      mode: 'history-window',
    };
    view.navigationGeneration += 1;
    view.pendingTargetOrdinal = null;
    this.touchSessionHistoryTurnRange(
      sessionId,
      loadedRange,
      nextRange.startOrdinal,
      nextRange.endOrdinalExclusive,
    );
    view.activeRange = nextRange;
    this.pruneSessionLoadedTurnRanges(sessionId, view);
    return { range: { ...nextRange }, turns: [...turns] };
  }

  public extendSessionHistoryWindow(
    sessionId: string,
    direction: SessionHistoryWindowDirection,
  ): SessionHistoryPresentation | null {
    const view = this.sessionHistoryViews.get(sessionId);
    const activeRange = view?.activeRange;
    if (
      this.state.activeSessionId !== sessionId
      || !view
      || !activeRange
      || activeRange.mode !== 'history-window'
    ) {
      return null;
    }

    const loadedRange = view.loadedRanges.find(range =>
      range.startOrdinal <= activeRange.startOrdinal
      && range.endOrdinalExclusive >= activeRange.endOrdinalExclusive
    );
    if (!loadedRange) {
      return null;
    }

    const selected = selectExtendedHistoryPresentationRange(loadedRange, activeRange, direction);
    const turns = sliceLoadedTurnRange(
      loadedRange,
      selected.startOrdinal,
      selected.endOrdinalExclusive,
    );
    if (!turns) {
      return null;
    }

    const targetTurnId = activeRange.targetTurnId && turns.some(turn => turn.id === activeRange.targetTurnId)
      ? activeRange.targetTurnId
      : null;
    const range: ActiveTurnRenderRange = {
      ...selected,
      targetTurnId,
      mode: 'history-window',
    };
    this.touchSessionHistoryTurnRange(
      sessionId,
      loadedRange,
      selected.startOrdinal,
      selected.endOrdinalExclusive,
    );
    view.activeRange = range;
    this.pruneSessionLoadedTurnRanges(sessionId, view);
    return { range: { ...range }, turns: [...turns] };
  }

  public activateSessionHistoryWindowFromTail(
    sessionId: string,
    targetOrdinal: number,
  ): SessionHistoryPresentation | null {
    const session = this.state.sessions.get(sessionId);
    const view = this.sessionHistoryViews.get(sessionId);
    if (
      this.state.activeSessionId !== sessionId
      || !session
      || !view
      || view.activeRange !== null
    ) {
      return null;
    }

    const totalTurnCount = projectedSessionTurnCount(session);
    const normalizedTargetOrdinal = Math.max(0, Math.floor(targetOrdinal));
    const tailOrdinal = totalTurnCount - 1;
    const loadedRange = view.loadedRanges.find(range =>
      range.startOrdinal <= normalizedTargetOrdinal
      && range.endOrdinalExclusive > normalizedTargetOrdinal
      && range.startOrdinal <= tailOrdinal
      && range.endOrdinalExclusive > tailOrdinal
    );
    if (!loadedRange) {
      return null;
    }

    const endOrdinalExclusive = Math.min(totalTurnCount, loadedRange.endOrdinalExclusive);
    const startOrdinal = Math.max(
      loadedRange.startOrdinal,
      endOrdinalExclusive - SESSION_HISTORY_PRESENTATION_HARD_TURN_BUDGET,
    );
    if (normalizedTargetOrdinal < startOrdinal) {
      return null;
    }
    const turns = sliceLoadedTurnRange(loadedRange, startOrdinal, endOrdinalExclusive);
    if (!turns) {
      return null;
    }

    const range: ActiveTurnRenderRange = {
      startOrdinal,
      endOrdinalExclusive,
      targetTurnId: null,
      mode: 'history-window',
    };
    this.touchSessionHistoryTurnRange(
      sessionId,
      loadedRange,
      startOrdinal,
      endOrdinalExclusive,
    );
    view.activeRange = range;
    this.pruneSessionLoadedTurnRanges(sessionId, view);
    return { range: { ...range }, turns: [...turns] };
  }

  public restoreSessionTailPresentation(sessionId: string): void {
    const view = this.sessionHistoryViews.get(sessionId);
    if (!view) {
      return;
    }
    view.navigationGeneration += 1;
    view.pendingTargetOrdinal = null;
    view.activeRange = null;
    this.pruneSessionLoadedTurnRanges(sessionId, view);
  }

  private ensureSessionHistoryView(
    sessionId: string,
    catalog?: SessionTurnCatalog | null,
  ): SessionHistoryViewState {
    const existing = this.sessionHistoryViews.get(sessionId);
    if (existing) {
      if (catalog !== undefined && existing.catalog === null) {
        existing.catalog = catalog;
      }
      return existing;
    }

    const created: SessionHistoryViewState = {
      catalog: catalog ?? null,
      loadedRanges: [],
      activeRange: null,
      pendingTargetOrdinal: null,
      navigationGeneration: 0,
    };
    this.sessionHistoryViews.set(sessionId, created);
    return created;
  }

  private nextSessionHistoryAccessTime(candidate: number = Date.now()): number {
    this.sessionHistoryAccessClock = Math.max(
      this.sessionHistoryAccessClock + 1,
      candidate,
    );
    return this.sessionHistoryAccessClock;
  }

  private getSessionHistoryTurnAccessTimes(sessionId: string): Map<number, number> {
    const existing = this.sessionHistoryTurnAccessTimes.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<number, number>();
    this.sessionHistoryTurnAccessTimes.set(sessionId, created);
    return created;
  }

  private touchSessionHistoryTurnRange(
    sessionId: string,
    range: LoadedTurnRange,
    startOrdinal: number,
    endOrdinalExclusive: number,
    accessedAt: number = this.nextSessionHistoryAccessTime(),
  ): void {
    const boundedStartOrdinal = Math.max(range.startOrdinal, startOrdinal);
    const boundedEndOrdinalExclusive = Math.min(
      range.endOrdinalExclusive,
      endOrdinalExclusive,
    );
    if (boundedEndOrdinalExclusive <= boundedStartOrdinal) {
      return;
    }

    const accessTimes = this.getSessionHistoryTurnAccessTimes(sessionId);
    for (
      let ordinal = boundedStartOrdinal;
      ordinal < boundedEndOrdinalExclusive;
      ordinal += 1
    ) {
      accessTimes.set(ordinal, accessedAt);
    }
    range.lastAccessedAt = Math.max(range.lastAccessedAt, accessedAt);
  }

  private getSessionHistoryTailProtectedIntervals(
    sessionId: string,
    _view?: SessionHistoryViewState,
  ): OrdinalInterval[] {
    const session = this.state.sessions.get(sessionId);
    if (!session || session.dialogTurns.length === 0) {
      return [];
    }
    const canonicalTailTurns = session.dialogTurns.filter(
      turn => !isProvisionalUsageReportTurn(turn),
    );
    if (canonicalTailTurns.length === 0) {
      return [];
    }

    const totalTurnCount = projectedSessionTurnCount(session);
    if (totalTurnCount <= 0) {
      return [];
    }

    return [{
      startOrdinal: Math.max(0, totalTurnCount - canonicalTailTurns.length),
      endOrdinalExclusive: totalTurnCount,
    }];
  }

  private getSessionHistoryProtectedIntervals(
    sessionId: string,
    view: SessionHistoryViewState,
    tailIntervals: readonly OrdinalInterval[],
  ): OrdinalInterval[] {
    const intervals: OrdinalInterval[] = [...tailIntervals];
    if (view.activeRange) {
      intervals.push({
        startOrdinal: view.activeRange.startOrdinal,
        endOrdinalExclusive: view.activeRange.endOrdinalExclusive,
      });
    }
    const pendingTargetOrdinal = view.pendingTargetOrdinal;
    if (pendingTargetOrdinal !== null) {
      const pendingRange = view.loadedRanges.find(range =>
        range.startOrdinal <= pendingTargetOrdinal
        && range.endOrdinalExclusive > pendingTargetOrdinal
      );
      if (pendingRange) {
        intervals.push(selectTargetHistoryPresentationRange(
          pendingRange,
          pendingTargetOrdinal,
        ));
      } else {
        intervals.push({
          startOrdinal: pendingTargetOrdinal,
          endOrdinalExclusive: pendingTargetOrdinal + 1,
        });
      }
    }
    for (const protection of this.sessionTurnWindowProtections.values()) {
      if (!this.ownedByActiveSurface(protection) || protection.sessionId !== sessionId) {
        continue;
      }
      intervals.push({
        startOrdinal: protection.startOrdinal,
        endOrdinalExclusive: protection.endOrdinalExclusive,
      });
    }
    return mergeOrdinalIntervals(intervals);
  }

  private pruneSessionLoadedTurnRanges(
    sessionId: string,
    view: SessionHistoryViewState = this.ensureSessionHistoryView(sessionId),
  ): void {
    // The canonical tail is retained outside the ordinary cache budget. When
    // non-tail data crosses the hard limit, LRU entries are sliced back toward
    // the soft limit without touching active or pending navigation intervals.
    const tailIntervals = mergeOrdinalIntervals(
      this.getSessionHistoryTailProtectedIntervals(sessionId, view),
    );
    const nonTailSegments = view.loadedRanges.flatMap(range =>
      subtractOrdinalIntervals(range, tailIntervals).map(interval => ({
        ...interval,
        range,
      }))
    );
    const nonTailTurnCount = nonTailSegments.reduce(
      (count, segment) => count + segment.endOrdinalExclusive - segment.startOrdinal,
      0,
    );
    if (
      nonTailTurnCount
      <= SESSION_HISTORY_LOADED_RANGE_CACHE_HARD_TURN_BUDGET
    ) {
      return;
    }
    const nonTailOrdinals = nonTailSegments.flatMap(segment =>
      Array.from(
        { length: segment.endOrdinalExclusive - segment.startOrdinal },
        (_, index) => ({
          ordinal: segment.startOrdinal + index,
          range: segment.range,
        }),
      )
    );

    const protectedIntervals = this.getSessionHistoryProtectedIntervals(
      sessionId,
      view,
      tailIntervals,
    );
    const protectedNonTailCount = nonTailOrdinals.reduce(
      (count, entry) => count + Number(
        ordinalIsInIntervals(entry.ordinal, protectedIntervals),
      ),
      0,
    );
    const retainedNonTailTarget = Math.max(
      SESSION_HISTORY_LOADED_RANGE_CACHE_SOFT_TURN_BUDGET,
      protectedNonTailCount,
    );
    const evictionCount = Math.max(
      0,
      nonTailOrdinals.length - retainedNonTailTarget,
    );
    if (evictionCount === 0) {
      return;
    }

    const accessTimes = this.getSessionHistoryTurnAccessTimes(sessionId);
    const candidates = nonTailOrdinals
      .filter(entry => !ordinalIsInIntervals(entry.ordinal, protectedIntervals))
      .sort((left, right) => {
        const leftAccessedAt = accessTimes.get(left.ordinal) ?? left.range.lastAccessedAt;
        const rightAccessedAt = accessTimes.get(right.ordinal) ?? right.range.lastAccessedAt;
        return leftAccessedAt - rightAccessedAt
          || ordinalDistanceFromIntervals(right.ordinal, protectedIntervals)
            - ordinalDistanceFromIntervals(left.ordinal, protectedIntervals)
          || left.ordinal - right.ordinal;
      });
    const evictedOrdinals = new Set(
      candidates.slice(0, evictionCount).map(entry => entry.ordinal),
    );
    if (evictedOrdinals.size === 0) {
      return;
    }

    const retainedRanges: LoadedTurnRange[] = [];
    const retainedOrdinals = new Set<number>();
    for (const range of view.loadedRanges) {
      let segmentStartOrdinal: number | null = null;
      for (
        let ordinal = range.startOrdinal;
        ordinal <= range.endOrdinalExclusive;
        ordinal += 1
      ) {
        const retained = ordinal < range.endOrdinalExclusive
          && !evictedOrdinals.has(ordinal);
        if (retained && segmentStartOrdinal === null) {
          segmentStartOrdinal = ordinal;
          continue;
        }
        if (retained || segmentStartOrdinal === null) {
          continue;
        }

        const segmentTurns = range.turns.slice(
          segmentStartOrdinal - range.startOrdinal,
          ordinal - range.startOrdinal,
        );
        if (segmentTurns.length > 0) {
          let lastAccessedAt = range.lastAccessedAt;
          for (
            let retainedOrdinal = segmentStartOrdinal;
            retainedOrdinal < ordinal;
            retainedOrdinal += 1
          ) {
            retainedOrdinals.add(retainedOrdinal);
            lastAccessedAt = Math.max(
              lastAccessedAt,
              accessTimes.get(retainedOrdinal) ?? range.lastAccessedAt,
            );
          }
          retainedRanges.push({
            startOrdinal: segmentStartOrdinal,
            endOrdinalExclusive: ordinal,
            turns: segmentTurns,
            lastAccessedAt,
            source: range.source,
          });
        }
        segmentStartOrdinal = null;
      }
    }

    for (const ordinal of accessTimes.keys()) {
      if (!retainedOrdinals.has(ordinal)) {
        accessTimes.delete(ordinal);
      }
    }
    if (accessTimes.size === 0) {
      this.sessionHistoryTurnAccessTimes.delete(sessionId);
    }
    view.loadedRanges = retainedRanges;
  }

  private cacheSessionLoadedTurnRange(
    sessionId: string,
    range: LoadedTurnRange,
    catalog?: SessionTurnCatalog | null,
    preferredOrdinal: number = range.startOrdinal,
  ): LoadedTurnRange {
    const view = this.ensureSessionHistoryView(sessionId, catalog);
    const accessedAt = this.nextSessionHistoryAccessTime(range.lastAccessedAt);
    const incomingRange = { ...range, lastAccessedAt: accessedAt };
    view.loadedRanges = mergeLoadedTurnRanges(view.loadedRanges, incomingRange);
    const mergedRange = view.loadedRanges.find(candidate =>
      candidate.startOrdinal <= incomingRange.startOrdinal
      && candidate.endOrdinalExclusive >= incomingRange.endOrdinalExclusive
    );
    if (mergedRange) {
      this.touchSessionHistoryTurnRange(
        sessionId,
        mergedRange,
        incomingRange.startOrdinal,
        incomingRange.endOrdinalExclusive,
        accessedAt,
      );
    }
    this.pruneSessionLoadedTurnRanges(sessionId, view);
    return view.loadedRanges.find(candidate =>
      candidate.startOrdinal <= preferredOrdinal
      && candidate.endOrdinalExclusive > preferredOrdinal
    ) ?? incomingRange;
  }

  private seedSessionHistoryLoadedRanges(
    sessionId: string,
    source: LoadedTurnRangeSource = 'initial-tail',
  ): void {
    const session = this.state.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const catalog = session.turnCatalog?.sessionId === sessionId
      ? session.turnCatalog
      : undefined;
    const existingView = this.sessionHistoryViews.get(sessionId);
    if (
      catalog
      && existingView?.catalog
      && existingView.catalog.revision !== catalog.revision
    ) {
      existingView.navigationGeneration += 1;
      existingView.pendingTargetOrdinal = null;
      existingView.activeRange = null;
      existingView.loadedRanges = [];
      this.sessionHistoryTurnAccessTimes.delete(sessionId);
    }
    const view = this.ensureSessionHistoryView(sessionId, catalog ?? null);
    if (catalog) {
      view.catalog = catalog;
    }
    const canonicalTailTurns = session.dialogTurns.filter(
      turn => !isProvisionalUsageReportTurn(turn),
    );
    if (canonicalTailTurns.length === 0) {
      return;
    }

    const entryByTurnId = new Map(
      (catalog?.entries ?? [])
        .filter(entry => typeof entry.turnId === 'string')
        .map(entry => [entry.turnId as string, entry]),
    );
    const entryByStorageIndex = new Map(
      (catalog?.entries ?? []).map(entry => [entry.storageTurnIndex, entry]),
    );
    const located = canonicalTailTurns
      .map(turn => {
        const storageTurnIndex = resolveStorageTurnIndex(session, turn);
        const entry = entryByTurnId.get(turn.id)
          ?? (storageTurnIndex !== undefined
            ? entryByStorageIndex.get(storageTurnIndex)
            : undefined);
        return entry ? { ordinal: entry.ordinal, turn } : null;
      })
      .filter((value): value is { ordinal: number; turn: DialogTurn } => value !== null)
      .sort((left, right) => left.ordinal - right.ordinal);
    const uniqueLocated = located.filter(
      (value, index) => index === 0 || located[index - 1].ordinal !== value.ordinal,
    );
    const now = Date.now();

    if (uniqueLocated.length === canonicalTailTurns.length) {
      let groupStart = 0;
      for (let index = 1; index <= uniqueLocated.length; index += 1) {
        const continues = index < uniqueLocated.length
          && uniqueLocated[index].ordinal === uniqueLocated[index - 1].ordinal + 1;
        if (continues) {
          continue;
        }
        const group = uniqueLocated.slice(groupStart, index);
        this.cacheSessionLoadedTurnRange(sessionId, {
          startOrdinal: group[0].ordinal,
          endOrdinalExclusive: group[group.length - 1].ordinal + 1,
          turns: group.map(value => value.turn),
          lastAccessedAt: now,
          source,
        }, catalog ?? null);
        groupStart = index;
      }
      return;
    }

    const totalTurnCount = projectedSessionTurnCount(session);
    const startOrdinal = Math.max(0, totalTurnCount - canonicalTailTurns.length);
    this.cacheSessionLoadedTurnRange(sessionId, {
      startOrdinal,
      endOrdinalExclusive: startOrdinal + canonicalTailTurns.length,
      turns: [...canonicalTailTurns],
      lastAccessedAt: now,
      source,
    }, catalog ?? null);
  }

  private updateAuthoritativeSessionTurnCatalog(
    sessionId: string,
    catalog: SessionTurnCatalog,
  ): void {
    if (catalog.sessionId !== sessionId) {
      return;
    }
    this.ensureSessionHistoryView(sessionId, catalog).catalog = catalog;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        turnCatalog: catalog,
        totalTurnCount: catalog.totalTurnCount,
      });
      return { ...prev, sessions: newSessions };
    });
  }

  private isSessionTurnNavigationCurrent(
    sessionId: string,
    generation: number,
    targetOrdinal: number,
  ): boolean {
    const view = this.sessionHistoryViews.get(sessionId);
    return this.state.activeSessionId === sessionId
      && view?.navigationGeneration === generation
      && view.pendingTargetOrdinal === targetOrdinal;
  }

  private isSessionTurnWindowRequestCurrent(
    sessionId: string,
    generation: number,
    targetOrdinal: number,
    source: 'target' | 'prefetch',
  ): boolean {
    if (source === 'target') {
      return this.isSessionTurnNavigationCurrent(sessionId, generation, targetOrdinal);
    }

    const view = this.sessionHistoryViews.get(sessionId);
    return this.state.activeSessionId === sessionId
      && view?.navigationGeneration === generation
      && (view.activeRange === null || view.activeRange.mode === 'history-window');
  }

  private invalidateSessionTurnNavigationIntents(): void {
    for (const [sessionId, view] of this.sessionHistoryViews) {
      if (view.pendingTargetOrdinal === null) {
        continue;
      }
      view.navigationGeneration += 1;
      view.pendingTargetOrdinal = null;
      this.pruneSessionLoadedTurnRanges(sessionId, view);
    }
  }

  private getMetadataListRequestKey(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
  ): string {
    return this.surfaceKey(
      workspacePath,
      remoteConnectionId || '',
      remoteSshHost || '',
    );
  }

  private getMetadataPageRequestKey(
    workspacePath: string,
    limit: number,
    cursor?: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
  ): string {
    return this.surfaceKey(
      workspacePath,
      remoteConnectionId || '',
      remoteSshHost || '',
      cursor || '',
      limit,
    );
  }

  private getFullHistoryHydrationKey(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    includeInternal?: boolean,
  ): string {
    return this.surfaceKey(
      sessionId,
      workspacePath,
      remoteConnectionId || '',
      remoteSshHost || '',
      includeInternal === true ? 1 : 0,
    );
  }

  private scheduleCompleteSessionHistoryLoad(
    request: CompleteSessionHistoryLoadRequest,
  ): FullHistoryHydrationRequest {
    const requestKey = this.getFullHistoryHydrationKey(
      request.sessionId,
      request.workspacePath,
      request.remoteConnectionId,
      request.remoteSshHost,
      request.includeInternal,
    );
    const existingRequest = this.fullHistoryHydrationRequests.get(requestKey);
    if (existingRequest) {
      if (request.startImmediately === true) {
        existingRequest.startNow?.();
      }
      return existingRequest;
    }

    const remote = isRemoteTraceContext(request.remoteConnectionId, request.remoteSshHost);
    const requireActiveSession = request.requireActiveSession === true;
    startupTrace.markPhase('historical_session_full_hydrate_scheduled', {
      remote,
      sessionId: request.sessionId,
      sessionTraceId: request.initialSessionTraceId,
      loadedTurnCount: request.expectedDialogTurnIds.length,
      requireActiveSession,
      scheduler: remote ? 'idle' : 'after_initial_paint_idle',
    });

    let cancelScheduled: (() => void) | undefined;
    let releaseAfterInitialPaint: ((options?: FullHistoryHydrationReleaseOptions) => void) | undefined;
    let resolveRequest: (() => void) | undefined;
    let started = false;
    let startFullHydrate: (
      trigger: 'idle' | 'initial_paint' | 'timeout' | 'explicit',
    ) => void = () => undefined;
    const promise = new Promise<void>(resolve => {
      resolveRequest = resolve;
      startFullHydrate = (trigger: 'idle' | 'initial_paint' | 'timeout' | 'explicit') => {
        if (started) {
          return;
        }
        started = true;
        startupTrace.markPhase('historical_session_full_hydrate_released', {
          remote,
          sessionId: request.sessionId,
          sessionTraceId: request.initialSessionTraceId,
          trigger,
        });
        void this.completeSessionHistoryLoad(request)
          .catch(error => {
            startupTrace.markPhase('historical_session_full_hydrate_failed', {
              remote,
              sessionId: request.sessionId,
              sessionTraceId: `${request.initialSessionTraceId}-full`,
            });
            if (isSurfaceChangedError(error)) {
              return;
            }
            log.warn('Failed to complete partial session history restore', {
              sessionId: request.sessionId,
              error,
            });
          })
          .finally(resolve);
      };

      if (request.startImmediately === true) {
        startFullHydrate('explicit');
        return;
      }

      if (remote) {
        cancelScheduled = scheduleHistoricalSessionFullHydrate(() => startFullHydrate('idle'));
        return;
      }

      const scheduled = scheduleLocalHistoricalSessionFullHydrate(startFullHydrate);
      cancelScheduled = scheduled.cancel;
      releaseAfterInitialPaint = scheduled.releaseAfterInitialPaint;
    }).finally(() => {
      const currentRequest = this.fullHistoryHydrationRequests.get(requestKey);
      if (currentRequest?.promise === promise) {
        this.fullHistoryHydrationRequests.delete(requestKey);
      }
    });

    const hydrationRequest: FullHistoryHydrationRequest = {
      surfaceId: getActiveSurfaceId(),
      sessionId: request.sessionId,
      remote,
      requireActiveSession,
      sessionTraceId: request.initialSessionTraceId,
      promise,
      cancel: () => {
        cancelScheduled?.();
        resolveRequest?.();
      },
      startNow: () => {
        cancelScheduled?.();
        startFullHydrate('explicit');
      },
    };

    if (releaseAfterInitialPaint) {
      hydrationRequest.releaseAfterInitialPaint = (options?: FullHistoryHydrationReleaseOptions) => {
        releaseAfterInitialPaint?.(options);
      };
    }

    this.fullHistoryHydrationRequests.set(requestKey, hydrationRequest);
    return hydrationRequest;
  }

  private cancelLocalSessionHistoryCompletion(sessionId: string, reason: string): boolean {
    let cancelled = false;
    for (const [requestKey, request] of this.fullHistoryHydrationRequests) {
      if (
        !this.ownedByActiveSurface(request)
        || request.sessionId !== sessionId
        || request.remote
        || !request.requireActiveSession
      ) {
        continue;
      }
      request.cancel?.();
      this.fullHistoryHydrationRequests.delete(requestKey);
      startupTrace.markPhase('historical_session_full_hydrate_cancelled', {
        remote: false,
        sessionId,
        sessionTraceId: request.sessionTraceId,
        reason,
      });
      cancelled = true;
    }
    return cancelled;
  }

  private clearRemovedSessionHistoryState(sessionIds: Iterable<string>, reason: string): void {
    const removedSessionIds = new Set(sessionIds);
    for (const id of removedSessionIds) {
      this.activeSurface.relaySessionHistory.get(id)?.close();
      this.activeSurface.relaySessionHistory.delete(id);
      this.activeSurface.relaySessionRecords.delete(id);
      this.activeSurface.relayQuestionMailboxes.delete(id);
      this.activeSurface.relayRecordVersions.delete(id);
      this.activeSurface.relayMailboxVersions.delete(id);
    }
    if (removedSessionIds.size === 0) {
      return;
    }

    for (const [requestKey, request] of this.fullHistoryHydrationRequests) {
      if (!this.ownedByActiveSurface(request) || !removedSessionIds.has(request.sessionId)) {
        continue;
      }

      request.cancel?.();
      this.fullHistoryHydrationRequests.delete(requestKey);
      startupTrace.markPhase('historical_session_full_hydrate_cancelled', {
        remote: request.remote,
        sessionId: request.sessionId,
        sessionTraceId: request.sessionTraceId,
        reason,
      });
    }

    for (const sessionId of removedSessionIds) {
      this.deferredFullHistoryProjections.delete(sessionId);
      this.fullHistoryProjectionApplyRequests.delete(sessionId);
      this.sessionHistoryViews.delete(sessionId);
      this.sessionHistoryTurnAccessTimes.delete(sessionId);
      this.userQuestionSnapshotRevisions.delete(sessionId);
    }

    const activeSurfaceId = getActiveSurfaceId();
    for (const requestKey of this.sessionTurnWindowRequests.keys()) {
      try {
        const [surfaceId, sessionId] = JSON.parse(requestKey) as [DeviceSurfaceId, string];
        if (surfaceId === activeSurfaceId && removedSessionIds.has(sessionId)) {
          this.sessionTurnWindowRequests.delete(requestKey);
        }
      } catch {
        // Ignore malformed internal keys; they expire when their request settles.
      }
    }
    for (const [requestKey, protection] of this.sessionTurnWindowProtections) {
      if (this.ownedByActiveSurface(protection) && removedSessionIds.has(protection.sessionId)) {
        this.sessionTurnWindowProtections.delete(requestKey);
      }
    }
  }

  private scheduleActiveLegacyPartialSessionHistoryCompletion(
    sessionId: string,
    reason: string
  ): boolean {
    const session = this.state.sessions.get(sessionId);
    if (
      this.state.activeSessionId !== sessionId ||
      !session ||
      session.historyState !== 'ready' ||
      session.isPartial !== true ||
      session.turnCatalog?.sessionId === sessionId ||
      isRemoteTraceContext(session.remoteConnectionId, session.remoteSshHost) ||
      this.hasPendingSessionHistoryCompletion(sessionId) ||
      this.hasDeferredSessionHistoryProjection(sessionId)
    ) {
      return false;
    }

    const canonicalTurns = canonicalSessionTurns(session);
    const workspacePath = sessionProjectWorkspacePath(session);
    if (!workspacePath || canonicalTurns.length === 0) {
      return false;
    }

    const sessionTraceId = `${sessionId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
    startupTrace.markPhase('historical_session_full_hydrate_rescheduled', {
      remote: false,
      sessionId,
      sessionTraceId,
      reason,
      loadedTurnCount: canonicalTurns.length,
      totalTurnCount: session.totalTurnCount,
    });
    this.scheduleCompleteSessionHistoryLoad({
      sessionId,
      workspacePath,
      initialSessionTraceId: sessionTraceId,
      requireActiveSession: true,
      expectedDialogTurnIds: canonicalTurns.map(turn => turn.id),
    });
    return true;
  }

  public hasPendingSessionHistoryCompletion(sessionId: string): boolean {
    for (const request of this.fullHistoryHydrationRequests.values()) {
      if (this.ownedByActiveSurface(request) && request.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  public hasDeferredSessionHistoryProjection(sessionId: string): boolean {
    return this.deferredFullHistoryProjections.has(sessionId);
  }

  public async ensureSessionFullHistory(sessionId: string, reason: string): Promise<boolean> {
    if (getActiveSurfaceId() !== 'local') {
      const scope = getActiveSurfaceScope();
      const surface = this.activeSurface;
      await this.loadRelaySessionHistory(sessionId);
      scope.assertCurrent('complete relay session history');
      const history = surface.relaySessionHistory.get(sessionId);
      while (surface.state.sessions.get(sessionId)?.isPartial) {
        if (!history || !await history.loadOlder()) break;
        scope.assertCurrent('continue relay session history');
      }
      scope.assertCurrent('finish relay session history');
      return surface.state.sessions.get(sessionId)?.isPartial === false;
    }
    const session = this.state.sessions.get(sessionId);
    if (!session || session.historyState !== 'ready') {
      return false;
    }
    if (session.isPartial !== true) {
      return true;
    }

    this.fullHistoryProjectionApplyRequests.add(sessionId);
    const applied = this.applyDeferredSessionHistoryProjection(sessionId, reason);
    if (applied) {
      return true;
    }

    let hydrationRequest = Array.from(this.fullHistoryHydrationRequests.values()).find(
      request => this.ownedByActiveSurface(request) && request.sessionId === sessionId,
    );
    if (!hydrationRequest) {
      const canonicalTurns = canonicalSessionTurns(session);
      const workspacePath = sessionProjectWorkspacePath(session);
      if (!workspacePath || canonicalTurns.length === 0) {
        this.fullHistoryProjectionApplyRequests.delete(sessionId);
        return false;
      }

      const sessionTraceId = `${sessionId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
      hydrationRequest = this.scheduleCompleteSessionHistoryLoad({
        sessionId,
        workspacePath,
        remoteConnectionId: session.remoteConnectionId,
        remoteSshHost: session.remoteSshHost,
        includeInternal: session.sessionKind === 'subagent',
        requireActiveSession: false,
        startImmediately: true,
        initialSessionTraceId: sessionTraceId,
        expectedDialogTurnIds: canonicalTurns.map(turn => turn.id),
      });
    } else {
      hydrationRequest.startNow?.();
    }

    startupTrace.markPhase('historical_session_full_history_ensure_requested', {
      sessionId,
      reason,
      remote: hydrationRequest.remote,
      loadedTurnCount: canonicalSessionTurns(session).length,
      totalTurnCount: session.totalTurnCount,
    });
    await hydrationRequest.promise;

    const appliedAfterLoad = this.applyDeferredSessionHistoryProjection(sessionId, reason);
    const ready = this.state.sessions.get(sessionId)?.isPartial !== true;
    if (!ready) {
      this.fullHistoryProjectionApplyRequests.delete(sessionId);
    }
    startupTrace.markPhase('historical_session_full_history_ensure_finished', {
      sessionId,
      reason,
      remote: hydrationRequest.remote,
      ready,
      applied: appliedAfterLoad,
    });
    return ready;
  }

  private requestTurnWindowCompatibilityFallback(sessionId: string): boolean {
    const session = this.state.sessions.get(sessionId);
    if (!session || session.historyState !== 'ready' || session.isPartial !== true) {
      return false;
    }
    void this.ensureSessionFullHistory(sessionId, 'turn-window-unsupported');
    return true;
  }

  private retainSessionTurnWindowProtection(
    key: string,
    protection: Omit<SessionTurnWindowProtection, 'retainCount' | 'surfaceId'>,
  ): () => void {
    const existing = this.sessionTurnWindowProtections.get(key);
    if (existing) {
      existing.retainCount += 1;
    } else {
      this.sessionTurnWindowProtections.set(key, {
        ...protection,
        surfaceId: getActiveSurfaceId(),
        retainCount: 1,
      });
    }

    return () => {
      const current = this.sessionTurnWindowProtections.get(key);
      if (!current) {
        return;
      }
      current.retainCount -= 1;
      if (current.retainCount <= 0) {
        this.sessionTurnWindowProtections.delete(key);
      }
    };
  }

  private async invokeSessionTurnWindowRequest(
    key: string,
    request: Parameters<typeof agentAPI.loadSessionTurnWindow>[0],
  ): Promise<LoadSessionTurnWindowResponse> {
    const existing = this.sessionTurnWindowRequests.get(key);
    if (existing) {
      return existing;
    }

    const promise = agentAPI.loadSessionTurnWindow(request);
    this.sessionTurnWindowRequests.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.sessionTurnWindowRequests.get(key) === promise) {
        this.sessionTurnWindowRequests.delete(key);
      }
    }
  }

  public async loadSessionTurnWindow(
    sessionId: string,
    targetOrdinal: number,
    options?: LoadSessionTurnWindowOptions,
  ): Promise<SessionTurnWindowLoadResult> {
    if (getActiveSurfaceId() !== 'local') {
      await this.ensureSessionFullHistory(sessionId, 'relay-turn-navigation');
    }
    const session = this.state.sessions.get(sessionId);
    const catalog = session?.turnCatalog?.sessionId === sessionId
      ? session.turnCatalog
      : this.sessionHistoryViews.get(sessionId)?.catalog ?? undefined;
    const normalizedTargetOrdinal = Math.max(0, Math.floor(targetOrdinal));
    const view = this.ensureSessionHistoryView(sessionId, catalog ?? null);
    const source = options?.source ?? 'target';
    if (source === 'target' && view.pendingTargetOrdinal !== normalizedTargetOrdinal) {
      view.navigationGeneration += 1;
      view.pendingTargetOrdinal = normalizedTargetOrdinal;
    }
    const generation = view.navigationGeneration;
    const entry = catalog?.entries.find(
      candidate => candidate.ordinal === normalizedTargetOrdinal,
    );
    if (!session || !catalog || !entry) {
      return {
        status: 'not-found',
        sessionId,
        targetOrdinal: normalizedTargetOrdinal,
        navigationGeneration: generation,
        isCurrent: this.isSessionTurnWindowRequestCurrent(
          sessionId,
          generation,
          normalizedTargetOrdinal,
          source,
        ),
        cacheHit: false,
        ...(catalog ? { catalog } : {}),
      };
    }

    const cachedRange = view.loadedRanges.find(range =>
      range.startOrdinal <= normalizedTargetOrdinal
      && range.endOrdinalExclusive > normalizedTargetOrdinal
    );
    if (cachedRange) {
      const cachedTarget = cachedRange.turns[normalizedTargetOrdinal - cachedRange.startOrdinal];
      if (!entry.turnId || cachedTarget?.id === entry.turnId) {
        const selected = selectTargetHistoryPresentationRange(
          cachedRange,
          normalizedTargetOrdinal,
        );
        this.touchSessionHistoryTurnRange(
          sessionId,
          cachedRange,
          selected.startOrdinal,
          selected.endOrdinalExclusive,
        );
        return {
          status: 'ready',
          sessionId,
          targetOrdinal: normalizedTargetOrdinal,
          targetTurnId: cachedTarget?.id,
          navigationGeneration: generation,
          isCurrent: this.isSessionTurnWindowRequestCurrent(
            sessionId,
            generation,
            normalizedTargetOrdinal,
            source,
          ),
          cacheHit: true,
          range: cachedRange,
          catalog,
        };
      }
    }

    if (getActiveSurfaceId() !== 'local') {
      // Turn navigation reads the same canonical log replica. It never starts
      // a second transcript restore/RPC path after a cache eviction.
      const before = Math.max(0, Math.floor(options?.before ?? SESSION_TURN_WINDOW_DEFAULT_BEFORE));
      const after = Math.max(1, Math.floor(options?.after ?? SESSION_TURN_WINDOW_DEFAULT_AFTER));
      const startOrdinal = Math.max(0, normalizedTargetOrdinal - before);
      const endOrdinalExclusive = Math.min(catalog.entries.length, normalizedTargetOrdinal + after);
      const byId = new Map(session.dialogTurns.map(turn => [turn.id, turn]));
      const turns = catalog.entries.slice(startOrdinal, endOrdinalExclusive)
        .map(entry => entry.turnId ? byId.get(entry.turnId) : undefined);
      if (turns.some(turn => !turn)) throw new Error('Relay turn catalog does not match its history');
      const range = this.cacheSessionLoadedTurnRange(sessionId, {
        startOrdinal, endOrdinalExclusive, turns: turns as DialogTurn[],
        lastAccessedAt: Date.now(), source: 'target',
      }, catalog, normalizedTargetOrdinal);
      return { status: 'ready', sessionId, targetOrdinal: normalizedTargetOrdinal,
        targetTurnId: entry.turnId, navigationGeneration: generation,
        isCurrent: this.isSessionTurnWindowRequestCurrent(sessionId, generation, normalizedTargetOrdinal, source),
        cacheHit: true, range, catalog };
    }

    const workspacePath = sessionProjectWorkspacePath(session);
    if (!workspacePath) {
      return {
        status: 'not-found',
        sessionId,
        targetOrdinal: normalizedTargetOrdinal,
        navigationGeneration: generation,
        isCurrent: this.isSessionTurnWindowRequestCurrent(
          sessionId,
          generation,
          normalizedTargetOrdinal,
          source,
        ),
        cacheHit: false,
        catalog,
      };
    }

    const before = Math.min(
      SESSION_HISTORY_PRESENTATION_PREFETCH_TURN_COUNT,
      Math.max(0, Math.floor(options?.before ?? SESSION_TURN_WINDOW_DEFAULT_BEFORE)),
    );
    const after = Math.min(
      SESSION_HISTORY_PRESENTATION_PREFETCH_TURN_COUNT,
      Math.max(1, Math.floor(options?.after ?? SESSION_TURN_WINDOW_DEFAULT_AFTER)),
    );
    return this.loadSessionTurnWindowAttempt({
      sessionId,
      workspacePath,
      remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost,
      includeInternal:
        options?.includeInternal
        ?? session.sessionKind === 'subagent',
      targetOrdinal: normalizedTargetOrdinal,
      targetStorageTurnIndex: entry.storageTurnIndex,
      originalTargetTurnId: entry.turnId,
      catalog,
      before,
      after,
      source,
      generation,
      staleRetryCount: 0,
    });
  }

  private async loadSessionTurnWindowAttempt(request: {
    sessionId: string;
    workspacePath: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
    includeInternal: boolean;
    targetOrdinal: number;
    targetStorageTurnIndex: number;
    originalTargetTurnId?: string;
    catalog: SessionTurnCatalog;
    before: number;
    after: number;
    source: 'target' | 'prefetch';
    generation: number;
    staleRetryCount: number;
  }): Promise<SessionTurnWindowLoadResult> {
    const scope = getActiveSurfaceScope();
    const supportKey = restoreCommandSupportKey(
      'load_session_turn_window',
      request.remoteConnectionId,
      request.remoteSshHost,
    );
    if (
      typeof agentAPI.loadSessionTurnWindow !== 'function'
      || this.unsupportedRestoreCommands.has(supportKey)
    ) {
      const fallbackRequested = this.requestTurnWindowCompatibilityFallback(request.sessionId);
      return {
        status: 'unsupported',
        sessionId: request.sessionId,
        targetOrdinal: request.targetOrdinal,
        targetTurnId: request.originalTargetTurnId,
        navigationGeneration: request.generation,
        isCurrent: this.isSessionTurnWindowRequestCurrent(
          request.sessionId,
          request.generation,
          request.targetOrdinal,
          request.source,
        ),
        cacheHit: false,
        catalog: request.catalog,
        fallbackRequested,
      };
    }

    const requestKey = this.surfaceKey(
      request.sessionId,
      request.workspacePath,
      request.remoteConnectionId ?? '',
      request.remoteSshHost ?? '',
      request.targetStorageTurnIndex,
      request.catalog.revision,
      request.before,
      request.after,
    );
    const releaseWindowProtection = this.retainSessionTurnWindowProtection(
      requestKey,
      {
        sessionId: request.sessionId,
        startOrdinal: Math.max(0, request.targetOrdinal - request.before),
        endOrdinalExclusive: Math.min(
          request.catalog.totalTurnCount,
          request.targetOrdinal + request.after + 1,
        ),
      },
    );
    let response: LoadSessionTurnWindowResponse;
    try {
      response = await this.invokeSessionTurnWindowRequest(requestKey, {
        sessionId: request.sessionId,
        workspacePath: request.workspacePath,
        includeInternal: request.includeInternal,
        targetStorageTurnIndex: request.targetStorageTurnIndex,
        expectedTurnId: request.originalTargetTurnId,
        expectedCatalogRevision: request.catalog.revision,
        before: request.before,
        after: request.after,
        remoteConnectionId: request.remoteConnectionId,
        remoteSshHost: request.remoteSshHost,
      });
    } catch (error) {
      releaseWindowProtection();
      if (!isUnsupportedTauriCommandError(error, 'load_session_turn_window')) {
        throw error;
      }
      this.unsupportedRestoreCommands.add(supportKey);
      const fallbackRequested = this.requestTurnWindowCompatibilityFallback(request.sessionId);
      startupTrace.markPhase('historical_session_turn_window_fallback', {
        sessionId: request.sessionId,
        remote: isRemoteTraceContext(request.remoteConnectionId, request.remoteSshHost),
        reason: 'unsupported-command',
        fallbackRequested,
      });
      return {
        status: 'unsupported',
        sessionId: request.sessionId,
        targetOrdinal: request.targetOrdinal,
        targetTurnId: request.originalTargetTurnId,
        navigationGeneration: request.generation,
        isCurrent: this.isSessionTurnWindowRequestCurrent(
          request.sessionId,
          request.generation,
          request.targetOrdinal,
          request.source,
        ),
        cacheHit: false,
        catalog: request.catalog,
        fallbackRequested,
      };
    }

    try {
      // Windows are cached against the projection they were requested for.
      scope.assertCurrent('loadSessionTurnWindow');
      if (response.status === 'ready') {
        if (
          response.endOrdinalExclusive <= response.startOrdinal
          || response.turns.length !== response.endOrdinalExclusive - response.startOrdinal
        ) {
          throw new Error('Session Turn window response is not contiguous');
        }
        const liveTurnId = [...(this.state.sessions.get(request.sessionId)?.dialogTurns ?? [])]
          .reverse()
          .find(turn => !['completed', 'cancelled', 'error'].includes(turn.status))?.id;
        const turns = this.convertToDialogTurns(response.turns, {
          activeTurnId: liveTurnId,
        });
        const incomingRange: LoadedTurnRange = {
          startOrdinal: response.startOrdinal,
          endOrdinalExclusive: response.endOrdinalExclusive,
          turns,
          lastAccessedAt: Date.now(),
          source: request.source,
        };
        const currentCatalog = this.sessionHistoryViews.get(request.sessionId)?.catalog;
        const range = this.state.sessions.has(request.sessionId)
          && (!currentCatalog || currentCatalog.revision === response.catalogRevision)
          ? this.cacheSessionLoadedTurnRange(
            request.sessionId,
            incomingRange,
            undefined,
            request.targetOrdinal,
          )
          : incomingRange;
        return {
          status: 'ready',
          sessionId: request.sessionId,
          targetOrdinal: request.targetOrdinal,
          targetTurnId: response.targetTurnId,
          navigationGeneration: request.generation,
          isCurrent: this.isSessionTurnWindowRequestCurrent(
            request.sessionId,
            request.generation,
            request.targetOrdinal,
            request.source,
          ),
          cacheHit: false,
          range,
          catalog: request.catalog,
        };
      }

      const isCurrent = this.isSessionTurnWindowRequestCurrent(
        request.sessionId,
        request.generation,
        request.targetOrdinal,
        request.source,
      );
      const currentCatalog = this.sessionHistoryViews.get(request.sessionId)?.catalog;
      if (
        isCurrent
        || !currentCatalog
        || currentCatalog.revision === request.catalog.revision
      ) {
        this.updateAuthoritativeSessionTurnCatalog(request.sessionId, response.catalog);
      }
      if (response.status === 'stale' && request.staleRetryCount === 0 && isCurrent) {
        const relocatedEntry = request.originalTargetTurnId
          ? response.catalog.entries.find(entry => entry.turnId === request.originalTargetTurnId)
          : response.catalog.entries.find(
            entry => entry.storageTurnIndex === request.targetStorageTurnIndex,
          );
        if (relocatedEntry) {
          const view = this.sessionHistoryViews.get(request.sessionId);
          if (request.source === 'target' && view?.navigationGeneration === request.generation) {
            view.pendingTargetOrdinal = relocatedEntry.ordinal;
          }
          return this.loadSessionTurnWindowAttempt({
            ...request,
            targetOrdinal: relocatedEntry.ordinal,
            targetStorageTurnIndex: relocatedEntry.storageTurnIndex,
            originalTargetTurnId: relocatedEntry.turnId ?? request.originalTargetTurnId,
            catalog: response.catalog,
            staleRetryCount: 1,
          });
        }
        return {
          status: 'not-found',
          sessionId: request.sessionId,
          targetOrdinal: request.targetOrdinal,
          targetTurnId: request.originalTargetTurnId,
          navigationGeneration: request.generation,
          isCurrent,
          cacheHit: false,
          catalog: response.catalog,
        };
      }

      return {
        status: response.status,
        sessionId: request.sessionId,
        targetOrdinal: request.targetOrdinal,
        targetTurnId: request.originalTargetTurnId,
        navigationGeneration: request.generation,
        isCurrent,
        cacheHit: false,
        catalog: response.catalog,
      };
    } finally {
      releaseWindowProtection();
    }
  }

  public releaseSessionHistoryCompletionAfterInitialPaint(
    sessionId: string,
    options?: FullHistoryHydrationReleaseOptions
  ): boolean {
    let released = false;
    for (const request of this.fullHistoryHydrationRequests.values()) {
      if (!this.ownedByActiveSurface(request) || request.sessionId !== sessionId) {
        continue;
      }
      if (!request.releaseAfterInitialPaint) {
        continue;
      }
      request.releaseAfterInitialPaint(options);
      released = true;
    }
    return released;
  }

  private shouldDeferFullHistoryProjection(sessionId: string, remote: boolean, _requireActiveSession: boolean): boolean {
    if (this.fullHistoryProjectionApplyRequests.has(sessionId)) {
      return false;
    }

    if (remote) {
      return true;
    }

    return this.state.activeSessionId === sessionId;
  }

  private setDeferredFullHistoryProjection(
    sessionId: string,
    projection: DeferredFullHistoryProjection
  ): void {
    this.deferredFullHistoryProjections.delete(sessionId);
    this.deferredFullHistoryProjections.set(sessionId, projection);

    while (this.deferredFullHistoryProjections.size > MAX_DEFERRED_FULL_HISTORY_PROJECTIONS) {
      const oldestSessionId = this.deferredFullHistoryProjections.keys().next().value;
      if (!oldestSessionId) {
        break;
      }

      this.deferredFullHistoryProjections.delete(oldestSessionId);
      this.fullHistoryProjectionApplyRequests.delete(oldestSessionId);
      startupTrace.markPhase('historical_session_full_hydrate_deferred_projection_evicted', {
        sessionId: oldestSessionId,
        reason: 'cache-limit',
      });
    }
  }

  private applyDeferredSessionHistoryProjection(sessionId: string, reason: string): boolean {
    const projection = this.deferredFullHistoryProjections.get(sessionId);
    if (!projection) {
      return false;
    }

    if (projection.remote && !this.fullHistoryProjectionApplyRequests.has(sessionId)) {
      startupTrace.markPhase('historical_session_full_hydrate_remote_projection_blocked', {
        remote: true,
        sessionId,
        reason,
        turnCount: projection.dialogTurns.length,
      });
      return false;
    }

    const result = this.applyCompletedSessionHistoryProjection(sessionId, projection);
    if (result.applied) {
      this.deferredFullHistoryProjections.delete(sessionId);
      this.fullHistoryProjectionApplyRequests.delete(sessionId);
      startupTrace.markPhase('historical_session_full_hydrate_deferred_projection_applied', {
        remote: projection.remote,
        sessionId,
        reason,
        turnCount: projection.dialogTurns.length,
        preservedTurnCount: result.preservedTurnCount,
      });
    }

    return result.applied;
  }

  public revealPreviousSessionHistoryWindow(
    sessionId: string,
    reason: string,
    turnLimit: number = HISTORICAL_SESSION_PREVIOUS_WINDOW_TURN_COUNT
  ): boolean {
    const projection = this.deferredFullHistoryProjections.get(sessionId);
    if (!projection) {
      return false;
    }

    const boundedTurnLimit = Math.max(1, Math.floor(turnLimit));
    let revealed = false;
    let revealedTurnCount = 0;
    let loadedTurnCount = 0;
    let totalTurnCount = projection.dialogTurns.length;
    let remainingBefore = 0;
    let nextExpectedDialogTurnIds: string[] = [];

    this.setState(prev => {
      if (projection.requireActiveSession && !projection.remote && prev.activeSessionId !== sessionId) {
        return prev;
      }

      const session = prev.sessions.get(sessionId);
      if (!session || session.historyState !== 'ready' || session.dialogTurns.length === 0) {
        return prev;
      }

      const firstLoadedTurnId = session.dialogTurns[0]?.id;
      if (!firstLoadedTurnId) {
        return prev;
      }

      const firstLoadedIndex = projection.dialogTurns.findIndex(turn => turn.id === firstLoadedTurnId);
      if (firstLoadedIndex <= 0) {
        return prev;
      }

      const startIndex = Math.max(0, firstLoadedIndex - boundedTurnLimit);
      const currentTurnIds = new Set(session.dialogTurns.map(turn => turn.id));
      const previousWindow = projection.dialogTurns
        .slice(startIndex, firstLoadedIndex)
        .filter(turn => !currentTurnIds.has(turn.id));
      if (previousWindow.length === 0) {
        return prev;
      }

      const currentDialogTurnsById = new Map(session.dialogTurns.map(turn => [turn.id, turn]));
      const projectionDialogTurnIds = new Set(projection.dialogTurns.map(turn => turn.id));
      const mergedDialogTurns = [
        ...previousWindow.map(turn => currentDialogTurnsById.get(turn.id) ?? turn),
        ...session.dialogTurns,
      ];
      nextExpectedDialogTurnIds = [];
      for (const turn of mergedDialogTurns) {
        if (!projectionDialogTurnIds.has(turn.id)) {
          break;
        }
        nextExpectedDialogTurnIds.push(turn.id);
      }
      revealed = true;
      revealedTurnCount = previousWindow.length;
      loadedTurnCount = canonicalSessionTurns({ dialogTurns: mergedDialogTurns }).length;
      totalTurnCount = Math.max(
        session.totalTurnCount ?? 0,
        projection.dialogTurns.length,
        loadedTurnCount,
      );
      remainingBefore = startIndex;

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        dialogTurns: mergedDialogTurns,
        isPartial: remainingBefore > 0,
        loadedTurnCount,
        totalTurnCount,
        contextRestoreState:
          session.contextRestoreState === 'ready' ? 'ready' : projection.contextRestoreState,
        mode: projection.restoredSessionInfo?.agentType || session.mode,
        lastUserDialogMode: projection.restoredLastUserDialogMode,
        lastSubmittedMode:
          projection.restoredSessionInfo?.lastSubmittedAgentType ?? session.lastSubmittedMode,
      });

      return {
        ...prev,
        sessions: newSessions,
      };
    });

    if (!revealed) {
      return false;
    }

    if (remainingBefore === 0) {
      this.deferredFullHistoryProjections.delete(sessionId);
      this.fullHistoryProjectionApplyRequests.delete(sessionId);
    } else if (nextExpectedDialogTurnIds.length > 0) {
      this.deferredFullHistoryProjections.set(sessionId, {
        ...projection,
        expectedDialogTurnIds: nextExpectedDialogTurnIds,
      });
    }

    startupTrace.markPhase('historical_session_deferred_window_revealed', {
      remote: projection.remote,
      sessionId,
      reason,
      turnLimit: boundedTurnLimit,
      revealedTurnCount,
      loadedTurnCount,
      totalTurnCount,
      remainingBefore,
    });
    return true;
  }

  private applyCompletedSessionHistoryProjection(
    sessionId: string,
    projection: DeferredFullHistoryProjection
  ): { applied: boolean; preservedTurnCount: number } {
    let applied = false;
    let preservedTurnCount = 0;

    this.setState(prev => {
      if (projection.requireActiveSession && !projection.remote && prev.activeSessionId !== sessionId) {
        return prev;
      }

      const session = prev.sessions.get(sessionId);
      if (!session || session.historyState !== 'ready') {
        return prev;
      }

      const currentDialogTurns = session.dialogTurns;
      const currentDialogTurnIds = currentDialogTurns.map(turn => turn.id);
      const canMergeCurrentTurns =
        areStringArraysEqual(currentDialogTurnIds, projection.expectedDialogTurnIds) ||
        startsWithStringArray(currentDialogTurnIds, projection.expectedDialogTurnIds);
      if (!canMergeCurrentTurns) {
        return prev;
      }

      const currentDialogTurnsById = new Map(currentDialogTurns.map(turn => [turn.id, turn]));
      const restoredDialogTurnIds = new Set(projection.dialogTurns.map(turn => turn.id));
      const appendedCurrentDialogTurns = currentDialogTurns
        .slice(projection.expectedDialogTurnIds.length)
        .filter(turn => !restoredDialogTurnIds.has(turn.id));
      const mergedDialogTurns = [
        ...projection.dialogTurns.map(turn => currentDialogTurnsById.get(turn.id) ?? turn),
        ...appendedCurrentDialogTurns,
      ];
      const mergedCanonicalTurnCount = canonicalSessionTurns({ dialogTurns: mergedDialogTurns }).length;
      preservedTurnCount = mergedDialogTurns.reduce(
        (count, turn) => count + (currentDialogTurnsById.get(turn.id) === turn ? 1 : 0),
        0,
      );
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        dialogTurns: mergedDialogTurns,
        isPartial: false,
        loadedTurnCount: mergedCanonicalTurnCount,
        totalTurnCount: Math.max(
          session.totalTurnCount ?? 0,
          projection.dialogTurns.length,
          mergedCanonicalTurnCount,
        ),
        contextRestoreState:
          session.contextRestoreState === 'ready' ? 'ready' : projection.contextRestoreState,
        mode: projection.restoredSessionInfo?.agentType || session.mode,
        lastUserDialogMode: projection.restoredLastUserDialogMode,
        lastSubmittedMode:
          projection.restoredSessionInfo?.lastSubmittedAgentType ?? session.lastSubmittedMode,
      });
      applied = true;

      return {
        ...prev,
        sessions: newSessions,
      };
    });

    if (applied) {
      this.seedSessionHistoryLoadedRanges(sessionId, 'initial-tail');
    }

    return { applied, preservedTurnCount };
  }

  private async completeSessionHistoryLoad(
    request: CompleteSessionHistoryLoadRequest
  ): Promise<void> {
    const fullTraceId = `${request.initialSessionTraceId}-full`;
    const startedAt = nowMs();
    const remote = isRemoteTraceContext(request.remoteConnectionId, request.remoteSshHost);
    if (request.requireActiveSession === true && !remote && this.state.activeSessionId !== request.sessionId) {
      startupTrace.markPhase('historical_session_full_hydrate_skipped', {
        remote,
        sessionId: request.sessionId,
        sessionTraceId: fullTraceId,
        reason: 'inactive-before-start',
      });
      return;
    }
    startupTrace.markPhase('historical_session_full_hydrate_start', {
      remote,
      sessionId: request.sessionId,
      sessionTraceId: fullTraceId,
      loadedTurnCount: request.expectedDialogTurnIds.length,
    });

    const scope = getActiveSurfaceScope();
    const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
    const restored = await agentAPI.restoreSessionView(
      request.sessionId,
      request.workspacePath,
      request.remoteConnectionId,
      request.remoteSshHost,
      fullTraceId,
      request.includeInternal,
      undefined,
    );
    scope.assertCurrent('completeSessionHistoryLoad');

    if (request.requireActiveSession === true && !remote && this.state.activeSessionId !== request.sessionId) {
      startupTrace.markPhase('historical_session_full_hydrate_skipped', {
        remote,
        sessionId: request.sessionId,
        sessionTraceId: fullTraceId,
        reason: 'inactive-after-restore',
        ...sessionViewRestoreTimingTraceFields(restored.timings),
        durationMs: elapsedMs(startedAt),
      });
      return;
    }

    if (restored.turnCatalog?.sessionId === request.sessionId) {
      this.setState(prev => {
        const session = prev.sessions.get(request.sessionId);
        if (!session) {
          return prev;
        }
        const turnCatalog = selectPreferredTurnCatalog(session.turnCatalog, restored.turnCatalog);
        if (turnCatalog === session.turnCatalog) {
          return prev;
        }

        const newSessions = new Map(prev.sessions);
        newSessions.set(request.sessionId, {
          ...session,
          turnCatalog,
        });
        return {
          ...prev,
          sessions: newSessions,
        };
      });
    }

    const convertStartedAt = nowMs();
    const activeTurnId = isBackendSessionActivelyProcessing(restored.session.state)
      ? restored.turns[restored.turns.length - 1]?.turnId
      : undefined;
    const dialogTurns = this.convertToDialogTurns(restored.turns, { activeTurnId });
    const restoredLastUserDialogMode =
      restored.session.lastUserDialogAgentType || this.deriveLastUserDialogMode(dialogTurns);
    const contextRestoreState: SessionContextRestoreState =
      restored.contextRestoreState === 'ready' ? 'ready' : 'pending';
    startupTrace.markPhase('historical_session_full_hydrate_convert_end', {
      remote,
      sessionId: request.sessionId,
      sessionTraceId: fullTraceId,
      turnCount: dialogTurns.length,
      durationMs: elapsedMs(convertStartedAt),
    });

    const projection: DeferredFullHistoryProjection = {
      remote,
      requireActiveSession: request.requireActiveSession === true,
      expectedDialogTurnIds: request.expectedDialogTurnIds,
      dialogTurns,
      contextRestoreState,
      restoredSessionInfo: restored.session,
      restoredLastUserDialogMode,
    };
    let applied = false;
    let preservedTurnCount = 0;
    if (this.shouldDeferFullHistoryProjection(request.sessionId, remote, request.requireActiveSession === true)) {
      this.setDeferredFullHistoryProjection(request.sessionId, projection);
      startupTrace.markPhase('historical_session_full_hydrate_deferred_projection', {
        remote,
        sessionId: request.sessionId,
        sessionTraceId: fullTraceId,
        turnCount: dialogTurns.length,
      });
    } else {
      const result = this.applyCompletedSessionHistoryProjection(request.sessionId, projection);
      applied = result.applied;
      preservedTurnCount = result.preservedTurnCount;
      if (applied) {
        this.deferredFullHistoryProjections.delete(request.sessionId);
        this.fullHistoryProjectionApplyRequests.delete(request.sessionId);
      }
    }

    startupTrace.markPhase('historical_session_full_hydrate_end', {
      remote,
      sessionId: request.sessionId,
      sessionTraceId: fullTraceId,
      turnCount: dialogTurns.length,
      applied,
      preservedTurnCount,
      ...sessionViewRestoreTimingTraceFields(restored.timings),
      durationMs: elapsedMs(startedAt),
    });
    if (applied) {
      markPhaseAfterAnimationFrames(startupTrace, 'historical_session_full_hydrate_after_state_commit_frame', {
        remote,
        sessionId: request.sessionId,
        sessionTraceId: fullTraceId,
        turnCount: dialogTurns.length,
        durationMs: elapsedMs(startedAt),
      }, {
        frameCount: 2,
      });
    }
  }

  public setState(updater: (prevState: FlowChatState) => FlowChatState): void {
    const newState = updater(this.state);
    this.state = newState;
    
    if (!this.silentMode) {
      // Notify plain listeners (backward compat)
      this.listeners.forEach(listener => {
        try {
          listener(newState);
        } catch (error) {
          console.error('[FlowChatStore] Listener threw an error, skipping:', error);
        }
      });

      // Notify selector listeners
      this.selectorListeners.forEach(entry => {
        try {
          const nextValue = entry.selector(newState);
          if (!entry.hasLastValue || !entry.isEqual(entry.lastValue, nextValue)) {
            entry.lastValue = nextValue;
            entry.hasLastValue = true;
            entry.callback(nextValue);
          }
        } catch (error) {
          console.error('[FlowChatStore] Selector listener threw an error, skipping:', error);
        }
      });
    }
  }
  
  /**
   * Silent state update (does not trigger listeners)
   * Used for batch updates, call notifyListeners() after completion
   */
  public setStateSilent(updater: (prevState: FlowChatState) => FlowChatState): void {
    const prevSilentMode = this.silentMode;
    this.silentMode = true;
    try {
      this.setState(updater);
    } finally {
      this.silentMode = prevSilentMode;
    }
  }
  
  /**
   * Manually notify all listeners (call after batch updates complete)
   */
  public notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.state);
      } catch (error) {
        console.error('[FlowChatStore] Listener threw an error during notifyListeners, skipping:', error);
      }
    });
    this.selectorListeners.forEach(entry => {
      try {
        const nextValue = entry.selector(this.state);
        if (!entry.hasLastValue || !entry.isEqual(entry.lastValue, nextValue)) {
          entry.lastValue = nextValue;
          entry.hasLastValue = true;
          entry.callback(nextValue);
        }
      } catch (error) {
        console.error('[FlowChatStore] Selector listener threw an error during notifyListeners, skipping:', error);
      }
    });
  }
  
  public beginSilentMode(): void {
    this.silentMode = true;
  }
  
  public endSilentMode(): void {
    this.silentMode = false;
    this.notifyListeners();
  }

  private collectCascadeSessionIds(
    rootSessionId: string,
    sessions: Map<string, Session>
  ): string[] {
    if (!sessions.has(rootSessionId)) {
      return [];
    }

    const childSessionIdsByParent = new Map<string, string[]>();
    sessions.forEach(session => {
      const parentSessionId = session.parentSessionId;
      if (!parentSessionId) {
        return;
      }

      const existing = childSessionIdsByParent.get(parentSessionId) || [];
      existing.push(session.sessionId);
      childSessionIdsByParent.set(parentSessionId, existing);
    });

    const visited = new Set<string>();
    const orderedSessionIds: string[] = [];

    const visit = (sessionId: string): void => {
      if (visited.has(sessionId)) {
        return;
      }

      visited.add(sessionId);
      const childSessionIds = childSessionIdsByParent.get(sessionId) || [];
      childSessionIds.forEach(childSessionId => {
        visit(childSessionId);
      });
      orderedSessionIds.push(sessionId);
    };

    visit(rootSessionId);
    return orderedSessionIds;
  }

  public getCascadeSessionIds(sessionId: string): string[] {
    return this.collectCascadeSessionIds(sessionId, this.state.sessions);
  }

  public subscribe(listener: (state: FlowChatState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeSelector<T>(
    selector: (state: FlowChatState) => T,
    callback: (selected: T) => void,
    options?: { isEqual?: (a: T, b: T) => boolean },
  ): () => void {
    const entry: SelectorListener<T> = {
      selector,
      callback,
      isEqual: options?.isEqual ?? Object.is,
      lastValue: undefined,
      hasLastValue: false,
    };
    this.selectorListeners.add(entry);
    return () => {
      this.selectorListeners.delete(entry);
    };
  }

  /**
   * Register a callback to persist unread completion changes.
   * Called by FlowChatManager during initialization.
   */
  public registerPersistUnreadCompletionCallback(
    callback: (sessionId: string, value: 'completed' | 'error' | 'interrupted' | undefined) => void
  ): void {
    this.onPersistUnreadCompletion = callback;
  }

  private deriveLastUserDialogMode(dialogTurns: DialogTurn[]): string | undefined {
    for (let index = dialogTurns.length - 1; index >= 0; index -= 1) {
      const turn = dialogTurns[index];
      const kind = turn.kind || 'user_dialog';
      const agentType = turn.agentType?.trim();
      if (kind === 'user_dialog' && agentType) {
        return agentType;
      }
    }

    return undefined;
  }

  public createSession(
    sessionId: string,
    config: SessionConfig,
    _unused?: undefined,
    title?: string,
    maxContextTokens?: number,
    mode?: string,
    workspacePath?: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    titleDescriptor?: SessionTitleDescriptor,
  ): void {
    import('../state-machine').then(({ stateMachineManager }) => {
      stateMachineManager.getOrCreate(sessionId);
    });
    
    this.setState(prev => {
      const relationship = normalizeSessionRelationship({ sessionKind: 'normal' });
      const titleState = deriveSessionTitleState(titleDescriptor);
      const session: Session = {
        sessionId,
        title:
          titleState.title ||
          title ||
          i18nService.t('flow-chat:session.new'),
        titleSource: titleState.titleSource,
        titleI18nKey: titleState.titleI18nKey,
        titleI18nParams: titleState.titleI18nParams,
        workspaceSessionNumber: titleState.workspaceSessionNumber,
        titleStatus: undefined,
        dialogTurns: [],
        status: 'idle',
        config,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        lastFinishedAt: undefined,
        error: null,
        historyState: 'new',
        maxContextTokens: maxContextTokens || 128128,
        mode: mode || 'Standard',
        lastUserDialogMode: undefined,
        lastSubmittedMode: undefined,
        workspacePath,
        projectWorkspacePath: config.projectWorkspacePath,
        workspaceId: config.workspaceId,
        remoteConnectionId,
        remoteSshHost,
        parentSessionId: relationship.parentSessionId,
        sessionKind: relationship.sessionKind,
        parentToolCallId: relationship.parentToolCallId,
        subagentType: relationship.subagentType,
        btwThreads: [],
        btwOrigin: relationship.btwOrigin,
        isTransient: false,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, session);

      return {
        ...prev,
        sessions: newSessions,
        activeSessionId: sessionId
      };
    });
  }

  /**
   * Add a session created externally (e.g., from mobile remote) without switching the active session.
   * workspacePath is stored on the session so the sidebar can filter by current workspace.
   */
  public addExternalSession(
    sessionId: string,
    title: string,
    mode: string,
    workspacePath?: string,
    meta?: {
      parentSessionId?: string;
      sessionKind?: SessionKind;
      btwOrigin?: Session['btwOrigin'];
      parentToolCallId?: string;
      subagentType?: string;
      isTransient?: boolean;
      agentBackedTransient?: boolean;
      deepReviewRunManifest?: Session['deepReviewRunManifest'];
      focusedReviewDisplayLabel?: Session['focusedReviewDisplayLabel'];
      reviewTargetEvidence?: Session['reviewTargetEvidence'];
      reviewTargetFilePaths?: Session['reviewTargetFilePaths'];
      projectWorkspacePath?: string;
      executionTarget?: Session['config']['executionTarget'];
      workspaceId?: string;
    },
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): void {
    import('../state-machine').then(({ stateMachineManager }) => {
      stateMachineManager.getOrCreate(sessionId);
    });

    this.setState(prev => {
      if (prev.sessions.has(sessionId)) {
        return prev;
      }

      const relationship = normalizeSessionRelationship(meta);
      const session: Session = {
        sessionId,
        title: title || i18nService.t('flow-chat:session.new'),
        titleSource: 'text',
        titleI18nKey: undefined,
        titleI18nParams: undefined,
        titleStatus: 'generated',
        dialogTurns: [],
        status: 'idle',
        config: {
          maxContextTokens: 128128,
          autoCompact: true,
          enableTools: true,
          workspacePath,
          projectWorkspacePath: meta?.projectWorkspacePath,
          executionTarget: meta?.executionTarget,
          workspaceId: meta?.workspaceId,
        } as any,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        lastFinishedAt: undefined,
        error: null,
        maxContextTokens: 128128,
        mode: mode || 'Standard',
        lastUserDialogMode: undefined,
        lastSubmittedMode: undefined,
        isHistorical: false,
        historyState: 'new',
        workspacePath,
        projectWorkspacePath: meta?.projectWorkspacePath,
        workspaceId: meta?.workspaceId,
        remoteConnectionId,
        remoteSshHost,
        parentSessionId: relationship.parentSessionId,
        sessionKind: relationship.sessionKind,
        parentToolCallId: relationship.parentToolCallId,
        subagentType: relationship.subagentType,
        btwThreads: [],
        btwOrigin: relationship.btwOrigin,
        deepReviewRunManifest: meta?.deepReviewRunManifest,
        focusedReviewDisplayLabel: meta?.focusedReviewDisplayLabel,
        reviewTargetEvidence: meta?.reviewTargetEvidence,
        reviewTargetFilePaths: meta?.reviewTargetFilePaths,
        isTransient: meta?.isTransient ?? false,
        agentBackedTransient: meta?.agentBackedTransient ?? false,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, session);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public switchSession(sessionId: string): void {
    const previousSessionId = this.state.activeSessionId;
    const targetSessionExists = this.state.sessions.has(sessionId);
    if (targetSessionExists && previousSessionId !== sessionId) {
      this.invalidateSessionTurnNavigationIntents();
    }
    if (targetSessionExists && previousSessionId && previousSessionId !== sessionId) {
      this.cancelLocalSessionHistoryCompletion(previousSessionId, 'session-switch');
    }

    let sessionMode: string | undefined;
    
    this.setState(prev => {
      if (!prev.sessions.has(sessionId)) return prev;
      
      const session = prev.sessions.get(sessionId)!;
      sessionMode = session.mode;
      
      const updatedSession = {
        ...session,
        lastActiveAt: Date.now()
      };
      
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
        activeSessionId: sessionId
      };
    });
    
    window.dispatchEvent(new CustomEvent('openbitfun:session-switched', {
      detail: { sessionId, mode: sessionMode || 'Standard' }
    }));

    if (targetSessionExists && previousSessionId !== sessionId) {
      this.scheduleActiveLegacyPartialSessionHistoryCompletion(sessionId, 'session-switch');
    }
  }

  /**
   * Update session mode
   * @param sessionId Session ID
   * @param mode Mode ID (e.g., 'Standard', 'Plan')
   */
  public updateSessionMode(sessionId: string, mode: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      if (session.mode === mode) return prev;

      const updatedSession = {
        ...session,
        mode,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Record the mode used by the most recent user submission accepted by the runtime.
   * Unlike `lastUserDialogMode`, this does not rewind when history is rolled back.
   */
  public updateSessionLastSubmittedMode(sessionId: string, mode: string): void {
    const normalizedMode = mode.trim();
    if (!normalizedMode) {
      return;
    }

    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || session.lastSubmittedMode === normalizedMode) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        lastSubmittedMode: normalizedMode,
        lastActiveAt: Date.now(),
      });

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public setGoalModeActive(sessionId: string, active: boolean): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      if (Boolean(session.goalModeActive) === active) return prev;

      const updatedSession = {
        ...session,
        goalModeActive: active,
        lastActiveAt: Date.now(),
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public setThreadGoal(
    sessionId: string,
    goal: Session['threadGoal'] | null
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const active =
        Boolean(goal) &&
        (goal!.status === 'active' || goal!.status === 'budgetLimited');

      const prevGoal = session.threadGoal;
      const sameGoal =
        (prevGoal == null && goal == null) ||
        (prevGoal != null &&
          goal != null &&
          prevGoal.goalId === goal.goalId &&
          prevGoal.status === goal.status &&
          prevGoal.objective === goal.objective &&
          prevGoal.updatedAt === goal.updatedAt &&
          prevGoal.tokensUsed === goal.tokensUsed &&
          prevGoal.tokenBudget === goal.tokenBudget &&
          prevGoal.timeUsedSeconds === goal.timeUsedSeconds &&
          (prevGoal.autoContinuationCount ?? 0) === (goal.autoContinuationCount ?? 0));

      if (sameGoal && Boolean(session.goalModeActive) === active) {
        return prev;
      }

      const updatedSession = {
        ...session,
        threadGoal: goal ?? undefined,
        goalModeActive: active,
        lastActiveAt: Date.now(),
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public updateSessionModelName(sessionId: string, modelName: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const normalizedModelName = modelName.trim() || 'primary';
      if (session.config.modelName?.trim() === normalizedModelName) {
        return prev;
      }

      const updatedSession = {
        ...session,
        config: {
          ...session.config,
          modelName: normalizedModelName,
        },
        lastActiveAt: Date.now(),
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public updateSessionReasoningPreset(sessionId: string, presetId?: string | null): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const normalizedPreset = presetId?.trim() || undefined;
      if (session.config.reasoningPreset === normalizedPreset) return prev;

      const updatedSession = {
        ...session,
        config: {
          ...session.config,
          reasoningPreset: normalizedPreset,
        },
        lastActiveAt: Date.now(),
      };
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);
      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Apply a backend `SessionModelFallbackApplied` notice as a compare-and-swap.
   *
   * The backend emits this while restoring a session whose persisted model is
   * gone. That restore is frequently triggered by the very model update the
   * user just made, so the notice can land *after* the composer already stored
   * the newly picked model. Applying it blindly reverts the user's choice, and
   * the reverted value is what the next send pushes back to the backend.
   *
   * Only apply the fallback while the session still holds the model the backend
   * replaced (or holds no selection yet). Mirrors the CLI guard in
   * `src/apps/cli/src/modes/chat/selection.rs`.
   *
   * Returns whether the fallback was applied.
   */
  public applySessionModelFallback(
    sessionId: string,
    previousModelId: string,
    newModelId: string,
  ): boolean {
    const session = this.state.sessions.get(sessionId);
    if (!session) return false;

    const currentModelName = session.config.modelName?.trim();
    if (currentModelName && currentModelName !== previousModelId.trim()) {
      return false;
    }

    this.updateSessionModelName(sessionId, newModelId);
    return true;
  }

  /** Clear a backend-invalidated reasoning preset without overwriting a newer choice. */
  public applySessionReasoningPresetAutoClear(
    sessionId: string,
    previousPresetId: string,
  ): boolean {
    const session = this.state.sessions.get(sessionId);
    if (
      !session
      || session.config.reasoningPreset?.trim() !== previousPresetId.trim()
    ) {
      return false;
    }

    this.updateSessionReasoningPreset(sessionId, undefined);
    return true;
  }

  /** Update the target-owned model choice before an observer job is submitted. */
  public updateSessionDispatchModel(sessionId: string, modelName: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      const normalizedModelName = modelName.trim();
      if (
        !session
        || !normalizedModelName
        || session.config.dispatchModel === normalizedModelName
      ) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        config: {
          ...session.config,
          dispatchModel: normalizedModelName,
          dispatchReasoningPreset: 'auto',
        },
        lastActiveAt: Date.now(),
      });
      return { ...prev, sessions: newSessions };
    });
  }

  /** Update the target-owned reasoning choice for the next dispatch turn. */
  public updateSessionDispatchReasoningPreset(sessionId: string, presetId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      const normalizedPreset = presetId.trim();
      if (!session || !normalizedPreset || session.config.dispatchReasoningPreset === normalizedPreset) {
        return prev;
      }
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        config: { ...session.config, dispatchReasoningPreset: normalizedPreset },
        lastActiveAt: Date.now(),
      });
      return { ...prev, sessions: newSessions };
    });
  }

  /** Update the approval policy; the next turn carries it to the target. */
  public updateSessionDispatchApprovalPolicy(
    sessionId: string,
    approvalPolicy: NonNullable<SessionConfig['dispatchApprovalPolicy']>,
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || session.config.dispatchApprovalPolicy === approvalPolicy) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        config: {
          ...session.config,
          dispatchApprovalPolicy: approvalPolicy,
        },
        lastActiveAt: Date.now(),
      });
      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Apply a backend session rebind (worktree isolation toggled on or off).
   * The project root stays put; only the execution directory moves.
   */
  public updateSessionExecutionTarget(
    sessionId: string,
    binding: {
      workspacePath: string;
      projectWorkspacePath: string;
      workspaceId?: string;
      executionTarget: Session['config']['executionTarget'];
    },
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        workspacePath: binding.workspacePath,
        projectWorkspacePath: binding.projectWorkspacePath,
        workspaceId: binding.workspaceId ?? session.workspaceId,
        config: {
          ...session.config,
          workspacePath: binding.workspacePath,
          projectWorkspacePath: binding.projectWorkspacePath,
          workspaceId: binding.workspaceId ?? session.config.workspaceId,
          executionTarget: binding.executionTarget,
        },
        lastActiveAt: Date.now(),
      });

      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Bind an observer-only session to its immutable dispatch target.
   * This updates frontend state only; it must never create a local runtime
   * session or write the normal session store.
   */
  public updateSessionDispatchTarget(
    sessionId: string,
    binding: {
      targetRequest: NonNullable<SessionConfig['dispatchTargetRequest']>;
      target: NonNullable<SessionConfig['dispatchTarget']>;
      jobId: string;
      approvalPolicy: NonNullable<SessionConfig['dispatchApprovalPolicy']>;
      model?: string;
      reasoningPreset?: string;
      modelCatalog?: SessionConfig['dispatchModelCatalog'];
      availableModels?: string[];
      defaultModel?: string;
      state?: NonNullable<SessionConfig['dispatchJobState']>;
      cursor?: number;
      /**
       * Observer recovery may deliberately resume from a transcript cache that
       * trails the renderer cursor persisted before shutdown. Only that paired
       * cache/replay path may move the projection cursor backwards.
       */
      cursorReset?: boolean;
      sourceWorkspacePath?: string;
      sourceWorkspaceId?: string;
    },
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const currentTarget = session.config.dispatchTarget;
      if (
        currentTarget &&
        currentTarget.kind !== 'local' &&
        !sameDispatchTargetIdentity(currentTarget, binding.target)
      ) {
        log.warn('Ignoring dispatch target mutation for an existing observer session', {
          sessionId,
          currentTarget,
          requestedTarget: binding.target,
        });
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      const sourceWorkspacePath = binding.sourceWorkspacePath?.trim() || undefined;
      const sourceWorkspaceId = binding.sourceWorkspaceId?.trim() || undefined;
      newSessions.set(sessionId, {
        ...session,
        // Observer projections are reconstructed from the target event log,
        // never from the local session-history API. Reclassifying a startup
        // metadata row here prevents a later click from hydrating empty local
        // history over a dispatch transcript restored by the observer.
        isHistorical: false,
        historyState: 'ready',
        contextRestoreState: 'ready',
        isPartial: false,
        loadedTurnCount: canonicalSessionTurns(session).length,
        totalTurnCount: projectedSessionTurnCount(session),
        workspacePath: sourceWorkspacePath ?? session.workspacePath,
        projectWorkspacePath:
          sourceWorkspacePath ?? session.projectWorkspacePath,
        workspaceId: sourceWorkspaceId ?? session.workspaceId,
        config: {
          ...session.config,
          workspacePath:
            sourceWorkspacePath ?? session.config.workspacePath,
          projectWorkspacePath:
            sourceWorkspacePath ?? session.config.projectWorkspacePath,
          workspaceId: sourceWorkspaceId ?? session.config.workspaceId,
          dispatchTargetRequest: binding.targetRequest,
          dispatchTarget: binding.target,
          dispatchJobId: binding.jobId,
          dispatchApprovalPolicy: binding.approvalPolicy,
          dispatchModel: binding.model ?? session.config.dispatchModel,
          dispatchReasoningPreset:
            binding.reasoningPreset ?? session.config.dispatchReasoningPreset,
          dispatchModelCatalog:
            binding.modelCatalog ?? session.config.dispatchModelCatalog,
          dispatchAvailableModels:
            binding.availableModels ?? session.config.dispatchAvailableModels,
          dispatchDefaultModel:
            binding.defaultModel ?? session.config.dispatchDefaultModel,
          dispatchJobState: binding.state ?? session.config.dispatchJobState ?? 'queued',
          dispatchCursor: binding.cursorReset
            ? Math.max(0, binding.cursor ?? 0)
            : Math.max(0, binding.cursor ?? session.config.dispatchCursor ?? 0),
        },
        lastActiveAt: Date.now(),
      });
      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Restore an observer projection's transcript from the controller's UI cache.
   *
   * Frontend state only, exactly like {@link updateSessionDispatchTarget}: the
   * target CLI still owns the durable session, so this must not create a local
   * runtime session or write the normal session store.
   *
   * The turns and the cursor are cached together, so the cursor may only be
   * adopted when this call reports success. Refuses to hydrate a session that
   * already has turns — replacing live content with a stale cache would drop
   * whatever the observer projected in the meantime.
   */
  public hydrateDispatchTranscript(
    sessionId: string,
    turns: DialogTurn[],
  ): boolean {
    if (turns.length === 0) return false;
    let hydrated = false;

    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (
        !session ||
        !isProjectedSessionEmpty(session) ||
        !session.config.dispatchTarget ||
        session.config.dispatchTarget.kind === 'local'
      ) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        isHistorical: false,
        historyState: 'ready',
        contextRestoreState: 'ready',
        isPartial: false,
        loadedTurnCount: turns.length,
        totalTurnCount: turns.length,
        dialogTurns: [...turns].sort(compareDialogTurnOrder),
      });
      hydrated = true;
      return { ...prev, sessions: newSessions };
    });

    return hydrated;
  }

  /**
   * Commit a target-side status snapshot only when it still follows the cursor
   * that was polled. The observer applies all events first, then calls this
   * method; a stale response therefore cannot jump the durable cursor forward.
   */
  public applyDispatchSnapshot(
    sessionId: string,
    snapshot: {
      jobId: string;
      state: NonNullable<SessionConfig['dispatchJobState']>;
      cursor: number;
      lastError?: string;
      expectedCursor?: number;
      cursorReset?: boolean;
      /**
       * True only after the observer receives an empty terminal page at the
       * same cursor. Earlier terminal pages may still have projected events.
       */
      terminalDrained?: boolean;
    },
  ): DispatchSnapshotApplyResult {
    let unreadCompletion: Session['hasUnreadCompletion'];
    let result: DispatchSnapshotApplyResult = {
      applied: false,
      cursor: this.state.sessions.get(sessionId)?.config.dispatchCursor ?? 0,
    };

    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (
        !session ||
        session.config.dispatchJobId !== snapshot.jobId ||
        !session.config.dispatchTarget ||
        session.config.dispatchTarget.kind === 'local'
      ) {
        return prev;
      }
      const currentCursor = session.config.dispatchCursor ?? 0;
      if (
        (!snapshot.cursorReset && snapshot.cursor < currentCursor) ||
        (
          snapshot.expectedCursor !== undefined &&
          snapshot.expectedCursor !== currentCursor
        )
      ) {
        result = { applied: false, cursor: currentCursor };
        return prev;
      }

      const effectiveState = isDispatchJobTerminal(session.config.dispatchJobState)
        ? session.config.dispatchJobState!
        : snapshot.state;
      const terminal = isDispatchJobTerminal(effectiveState);
      const settledAt = Date.now();
      const terminalTurnStatus = snapshot.terminalDrained
        ? dispatchTerminalTurnStatus(effectiveState)
        : null;
      let dialogTurns = session.dialogTurns;
      const lastTurn = dialogTurns[dialogTurns.length - 1];
      if (terminalTurnStatus && (session.config.dispatchJobState !== effectiveState
        || (lastTurn && lastTurn.status !== terminalTurnStatus))) {
        unreadCompletion = terminalTurnStatus === 'completed' ? 'completed'
          : terminalTurnStatus === 'error' ? 'error' : 'interrupted';
      }
      if (terminalTurnStatus && lastTurn) {
        const settledTurn = settleDialogTurnToTerminalStatus(
          lastTurn,
          terminalTurnStatus,
          settledAt,
          terminalTurnStatus === 'error'
            ? snapshot.lastError || session.error || 'Dispatched task failed'
            : undefined,
          {
            // A cached optimistic turn has no executor-owned terminal event.
            // A previous job snapshot can have settled it while its follow-up
            // was being submitted; the current target outcome must repair it.
            preserveTerminalOutcome: optimisticTurnAdoptionKey(lastTurn) !== snapshot.jobId,
          },
        );
        if (settledTurn !== lastTurn) {
          dialogTurns = [...dialogTurns.slice(0, -1), settledTurn];
        }
      }
      const terminalError = effectiveState === 'failed'
        ? snapshot.lastError || session.error || 'Dispatched task failed'
        : session.error;
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        dialogTurns,
        error: terminalError,
        hasUnreadCompletion: unreadCompletion ?? session.hasUnreadCompletion,
        lastActiveAt: settledAt,
        lastFinishedAt: terminal
          ? session.lastFinishedAt ?? settledAt
          : session.lastFinishedAt,
        config: {
          ...session.config,
          dispatchJobState: effectiveState,
          dispatchCursor: snapshot.cursor,
          dispatchLastError:
            snapshot.lastError ?? session.config.dispatchLastError,
        },
      });
      result = { applied: true, cursor: snapshot.cursor };
      return { ...prev, sessions: newSessions };
    });

    if (unreadCompletion) this.onPersistUnreadCompletion?.(sessionId, unreadCompletion);
    return result;
  }

  /**
   * Record an empty session's desired isolation state without touching Git.
   * MessageModule materializes this preference only after the user submits the
   * first prompt.
   */
  public setSessionWorktreeIsolationRequested(
    sessionId: string,
    requested: boolean | undefined,
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const newSessions = new Map(prev.sessions);
      const config = { ...session.config };
      if (requested === undefined) {
        delete config.worktreeIsolationRequested;
      } else {
        config.worktreeIsolationRequested = requested;
      }
      newSessions.set(sessionId, {
        ...session,
        config,
        lastActiveAt: Date.now(),
      });
      return { ...prev, sessions: newSessions };
    });
  }

  public updateSessionFocusedReviewDisplayLabel(
    sessionId: string,
    focusedReviewDisplayLabel: Session['focusedReviewDisplayLabel'],
  ): void {
    if (!focusedReviewDisplayLabel) return;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || session.focusedReviewDisplayLabel === focusedReviewDisplayLabel) return prev;

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, { ...session, focusedReviewDisplayLabel });
      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Update session relationship metadata (parent/child grouping, kind, etc.).
   * This is UI-only and does not affect backend behavior directly.
   */
  public updateSessionRelationship(
    sessionId: string,
    updates: {
      parentSessionId?: string;
      sessionKind?: SessionKind;
      parentToolCallId?: string;
      subagentType?: string;
    }
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const relationship = normalizeSessionRelationship({
        sessionKind: updates.sessionKind ?? session.sessionKind,
        parentSessionId: updates.parentSessionId ?? session.parentSessionId,
        btwOrigin: session.btwOrigin,
        parentToolCallId:
          updates.parentToolCallId !== undefined
            ? updates.parentToolCallId
            : session.parentToolCallId,
        subagentType:
          updates.subagentType !== undefined
            ? updates.subagentType
            : session.subagentType,
      });
      const next: Session = {
        ...session,
        parentSessionId: relationship.parentSessionId,
        sessionKind: relationship.sessionKind,
        parentToolCallId: relationship.parentToolCallId,
        subagentType: relationship.subagentType,
        btwOrigin: relationship.btwOrigin,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, next);

      return { ...prev, sessions: newSessions };
    });
  }

  public updateSessionBtwOrigin(
    sessionId: string,
    origin: Session['btwOrigin'],
    sessionKind: SessionKind = 'btw'
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const relationship = normalizeSessionRelationship({
        sessionKind,
        parentSessionId: origin?.parentSessionId ?? session.parentSessionId,
        btwOrigin: { ...(session.btwOrigin || {}), ...(origin || {}) },
      });
      const next: Session = {
        ...session,
        parentSessionId: relationship.parentSessionId,
        sessionKind: relationship.sessionKind,
        btwOrigin: relationship.btwOrigin,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, next);
      return { ...prev, sessions: newSessions };
    });
  }

  public addBtwThreadMarker(
    parentSessionId: string,
    marker: {
      requestId: string;
      childSessionId: string;
      title: string;
      status: 'running' | 'done' | 'error';
      createdAt: number;
      parentDialogTurnId?: string;
      parentTurnIndex?: number;
      error?: string;
    }
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(parentSessionId);
      if (!session) return prev;

      const existing = session.btwThreads || [];
      if (existing.some(t => t.requestId === marker.requestId)) {
        return prev;
      }

      const nextSession: Session = {
        ...session,
        btwThreads: [marker, ...existing].slice(0, 20),
        lastActiveAt: Date.now(),
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(parentSessionId, nextSession);
      return { ...prev, sessions: newSessions };
    });
  }

  public updateBtwThreadMarker(
    parentSessionId: string,
    requestId: string,
    updates: Partial<{
      status: 'running' | 'done' | 'error';
      error?: string;
      title: string;
    }>
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(parentSessionId);
      if (!session) return prev;

      const existing = session.btwThreads || [];
      if (existing.length === 0) return prev;

      const nextThreads = existing.map(t => {
        if (t.requestId !== requestId) return t;
        return { ...t, ...updates };
      });

      const newSessions = new Map(prev.sessions);
      newSessions.set(parentSessionId, { ...session, btwThreads: nextThreads });
      return { ...prev, sessions: newSessions };
    });
  }

  public removeBtwThreadMarker(parentSessionId: string, requestId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(parentSessionId);
      if (!session) return prev;
      const existing = session.btwThreads || [];
      const nextThreads = existing.filter(t => t.requestId !== requestId);
      const newSessions = new Map(prev.sessions);
      newSessions.set(parentSessionId, { ...session, btwThreads: nextThreads });
      return { ...prev, sessions: newSessions };
    });
  }

  /**
   * Move session to front by updating createdAt timestamp
   */
  public moveSessionToFront(sessionId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const updatedSession = {
        ...session,
        createdAt: Date.now(),
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public async deleteSession(sessionId: string, options?: RemoveSessionOptions): Promise<void> {
    const sessionIdsToDelete = this.getCascadeSessionIds(sessionId);
    if (sessionIdsToDelete.length === 0) {
      return;
    }
    if (options) {
      this.pendingRemoveSessionOptions.set(sessionId, options);
    }

    const { stateMachineManager } = await import('../state-machine');
    sessionIdsToDelete.forEach(id => {
      stateMachineManager.delete(id);
    });

    try {
      const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
      const deleteResults = await Promise.allSettled(
        sessionIdsToDelete.map(async id => {
          const sess = this.state.sessions.get(id);
          const workspacePath = sess ? sessionProjectWorkspacePath(sess) : undefined;
          if (!workspacePath) {
            throw new Error(`Workspace path not found for session ${id}`);
          }

          await agentAPI.deleteSession(
            id,
            workspacePath,
            sess?.remoteConnectionId,
            sess?.remoteSshHost
          );
        })
      );

      deleteResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.error('Failed to delete session on backend', {
            sessionId: sessionIdsToDelete[index],
            error: result.reason,
          });
        }
      });
    } catch (error) {
      log.error('Failed to delete session on backend', { sessionId, error });
    }

    const removedSessionIds = this.removeSession(sessionId, options);
    sessionComposerStore.getState().removeDrafts(removedSessionIds);
    askUserQuestionDraftStore.getState().removeSessionDrafts(removedSessionIds);
    this.pendingRemoveSessionOptions.delete(sessionId);
  }

  public removeSession(sessionId: string, options?: RemoveSessionOptions): string[] {
    const removedSessionIds = this.getCascadeSessionIds(sessionId);
    if (removedSessionIds.length === 0) {
      this.pendingRemoveSessionOptions.delete(sessionId);
      return [];
    }
    const resolvedOptions = options ?? this.pendingRemoveSessionOptions.get(sessionId);
    this.pendingRemoveSessionOptions.delete(sessionId);
    this.clearRemovedSessionHistoryState(removedSessionIds, 'session-removed');
    useBackgroundSubagentActivityStore.getState().removeSessions(removedSessionIds);

    this.setState(prev => {
      const removedSessionIdSet = new Set(removedSessionIds);
      const newSessions = new Map(prev.sessions);
      const removedSessions = removedSessionIds
        .map(id => prev.sessions.get(id))
        .filter((session): session is Session => Boolean(session));

      removedSessionIds.forEach(id => {
        newSessions.delete(id);
      });

      removedSessions.forEach(session => {
        const parentSessionId = session.btwOrigin?.parentSessionId ?? session.parentSessionId;
        if (!parentSessionId || removedSessionIdSet.has(parentSessionId)) {
          return;
        }

        const parentSession = newSessions.get(parentSessionId);
        if (!parentSession?.btwThreads?.length) {
          return;
        }

        const requestId = session.btwOrigin?.requestId;
        const nextThreads = parentSession.btwThreads.filter(thread => {
          if (thread.childSessionId === session.sessionId) {
            return false;
          }

          if (requestId && thread.requestId === requestId) {
            return false;
          }

          return true;
        });

        if (nextThreads.length !== parentSession.btwThreads.length) {
          newSessions.set(parentSessionId, {
            ...parentSession,
            btwThreads: nextThreads,
          });
        }
      });

      let newActiveSessionId = prev.activeSessionId;
      if (prev.activeSessionId && removedSessionIdSet.has(prev.activeSessionId)) {
        if (resolvedOptions && 'nextActiveSessionId' in resolvedOptions) {
          newActiveSessionId = resolvedOptions.nextActiveSessionId ?? null;
        } else {
          const remainingSessions = Array.from(newSessions.keys());
          newActiveSessionId = remainingSessions.length > 0 ? remainingSessions[0] : null;
        }
      }

      return {
        ...prev,
        sessions: newSessions,
        activeSessionId: newActiveSessionId
      };
    });

    return removedSessionIds;
  }

  public clearSession(sessionId?: string): void {
    const targetSessionId = sessionId || this.state.activeSessionId;
    if (!targetSessionId) return;

    this.setState(prev => {
      const session = prev.sessions.get(targetSessionId);
      if (!session) return prev;

      const clearedSession = {
        ...session,
        dialogTurns: [],
        error: null,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(targetSessionId, clearedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Remove sessions bound to a workspace using stable id + host/path scope (never path-only).
   */
  public removeSessionsForWorkspace(
    workspace: Pick<WorkspaceInfo, 'id' | 'rootPath' | 'connectionId' | 'sshHost'>
  ): string[] {
    const removedSessionIds = Array.from(this.state.sessions.values())
      .filter(session => sessionMatchesWorkspace(session, workspace))
      .map(session => session.sessionId);

    return this.removeSessionsByIds(removedSessionIds);
  }

  public async cancelRunningSessionsForWorkspace(
    workspace: Pick<WorkspaceInfo, 'id' | 'rootPath' | 'connectionId' | 'sshHost'>
  ): Promise<string[]> {
    const runningSessions = Array.from(this.state.sessions.values())
      .filter(session => sessionMatchesWorkspace(session, workspace))
      .filter(session => {
        if (isNonLocalDispatchTarget(session.config.dispatchTarget)) {
          // Closing the source workspace must not stop a detached target job.
          // Only the explicit task Stop action owns dispatch cancellation.
          return false;
        }
        const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
        return Boolean(
          lastTurn &&
          !['completed', 'cancelled', 'error'].includes(lastTurn.status)
        );
      });
    const runningSessionIds = runningSessions.map(session => session.sessionId);

    if (runningSessionIds.length === 0) {
      return [];
    }

    const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
    await Promise.allSettled(
      runningSessions.map(async session => {
        const sessionId = session.sessionId;
        try {
          await agentAPI.cancelSession(sessionId);
        } catch (error) {
          log.warn('Failed to cancel running session before closing workspace', {
            sessionId,
            workspaceId: workspace.id,
            error,
          });
        } finally {
          this.cancelSessionTask(sessionId);
        }
      })
    );

    return runningSessionIds;
  }

  /** @deprecated Prefer `removeSessionsForWorkspace` with full `WorkspaceInfo`. */
  public removeSessionsByWorkspace(
    workspacePath: string,
    remoteConnectionId?: string | null,
    remoteSshHost?: string | null
  ): string[] {
    const removedSessionIds = Array.from(this.state.sessions.values())
      .filter(session =>
        sessionBelongsToWorkspaceNavRow(session, workspacePath, remoteConnectionId, remoteSshHost)
      )
      .map(session => session.sessionId);

    return this.removeSessionsByIds(removedSessionIds);
  }

  private removeSessionsByIds(removedSessionIds: string[]): string[] {

    if (removedSessionIds.length === 0) {
      return [];
    }
    this.clearRemovedSessionHistoryState(removedSessionIds, 'sessions-removed');

    const removedSessionIdSet = new Set(removedSessionIds);

    this.setState(prev => {
      const newSessions = new Map(prev.sessions);
      removedSessionIdSet.forEach(sessionId => {
        newSessions.delete(sessionId);
      });

      return {
        ...prev,
        sessions: newSessions,
        activeSessionId:
          prev.activeSessionId && removedSessionIdSet.has(prev.activeSessionId)
            ? null
            : prev.activeSessionId
      };
    });

    return removedSessionIds;
  }

  /**
   * Detach from the rendered surface without discarding it.
   *
   * A switch is a view change, not a teardown: this device's container stays, so
   * returning to it shows its sessions immediately and reconciliation repairs
   * them instead of reloading from nothing. Only its metadata dedup entries are
   * dropped, so the next activation re-reads the list rather than adopting a
   * request that raced the switch.
   *
   * Returns no session ids on purpose — nothing was removed, and callers must
   * not tear down state machines for sessions that still exist on their device.
   */
  public prepareForSurfaceSwitch(): string[] {
    this.detachedSurfaceGeneration = this.getSurfaceGeneration() + 1;
    this.forgetSurfaceMetadataRequests(getActiveSurfaceId());
    return [];
  }

  /**
   * Forget a device entirely: its sessions, caches and negotiated capabilities.
   * For a device that is gone (attachment dropped for good), never for a switch.
   */
  public discardSurfaceState(surfaceId: DeviceSurfaceId): string[] {
    const container = this.surfaceContainers.get(surfaceId);
    const removedSessionIds = container
      ? Array.from(container.state.sessions.keys())
      : [];
    this.surfaceContainers.delete(surfaceId);
    sessionComposerStore.getState().removeSurfaceDrafts(surfaceId);
    askUserQuestionDraftStore.getState().removeSurfaceDrafts(surfaceId);
    this.forgetSurfaceMetadataRequests(surfaceId);

    for (const [requestKey, request] of this.fullHistoryHydrationRequests) {
      if (request.surfaceId !== surfaceId) {
        continue;
      }
      request.cancel?.();
      this.fullHistoryHydrationRequests.delete(requestKey);
    }
    for (const [requestKey, protection] of this.sessionTurnWindowProtections) {
      if (protection.surfaceId === surfaceId) {
        this.sessionTurnWindowProtections.delete(requestKey);
      }
    }
    for (const requestKey of this.sessionTurnWindowRequests.keys()) {
      if (surfaceOfScopedKey(requestKey) === surfaceId) {
        this.sessionTurnWindowRequests.delete(requestKey);
      }
    }
    for (const supportKey of this.unsupportedRestoreCommands) {
      if (surfaceOfScopedKey(supportKey) === surfaceId) {
        this.unsupportedRestoreCommands.delete(supportKey);
      }
    }

    if (surfaceId === getActiveSurfaceId()) {
      this.notifyListeners();
    }
    return removedSessionIds;
  }

  private forgetSurfaceMetadataRequests(surfaceId: DeviceSurfaceId): void {
    for (const [requestKey, request] of this.metadataListRequests) {
      if (surfaceOfScopedKey(requestKey) !== surfaceId) {
        continue;
      }
      if (request.cleanupTimer) {
        clearTimeout(request.cleanupTimer);
      }
      this.metadataListRequests.delete(requestKey);
    }
    for (const [requestKey, request] of this.metadataPageRequests) {
      if (surfaceOfScopedKey(requestKey) !== surfaceId) {
        continue;
      }
      if (request.cleanupTimer) {
        clearTimeout(request.cleanupTimer);
      }
      this.metadataPageRequests.delete(requestKey);
    }
  }

  /**
   * Activation epochs, not store wipes. Callers compare this across an await to
   * decide whether what they read back still belongs to the rendered surface, so
   * it must also move in the window between an announced switch and the
   * activation that follows it.
   */
  public getSurfaceGeneration(): number {
    return Math.max(this.detachedSurfaceGeneration, getActiveSurfaceScope().epoch);
  }

  public getActiveSession(): Session | null {
    if (!this.state.activeSessionId) {
      return null;
    }
    return this.state.sessions.get(this.state.activeSessionId) || null;
  }

  public addDialogTurn(sessionId: string, dialogTurn: DialogTurn): void {
    let appendedTurn = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      if (session.dialogTurns.some(turn => turn.id === dialogTurn.id)) {
        return prev;
      }

      const updatedDialogTurns = [...session.dialogTurns, dialogTurn];
      const updatedCanonicalTurnCount = canonicalSessionTurns({
        dialogTurns: updatedDialogTurns,
      }).length;
      const storageTurnIndex = resolveStorageTurnIndex(session, dialogTurn);
      const catalog = session.turnCatalog?.sessionId === sessionId
        ? session.turnCatalog
        : undefined;
      const catalogAlreadyCountsTurn = catalog?.entries.some(entry =>
        entry.turnId === dialogTurn.id
        || (
          storageTurnIndex !== undefined
          && entry.storageTurnIndex === storageTurnIndex
        )
      ) === true;
      const previousTotalTurnCount = projectedSessionTurnCount(session);
      const updatedSession = {
        ...session,
        dialogTurns: updatedDialogTurns,
        loadedTurnCount: updatedCanonicalTurnCount,
        totalTurnCount: Math.max(
          updatedCanonicalTurnCount,
          previousTotalTurnCount + (catalogAlreadyCountsTurn ? 0 : 1),
        ),
        lastUserDialogMode: this.deriveLastUserDialogMode(updatedDialogTurns),
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);
      appendedTurn = true;

      return {
        ...prev,
        sessions: newSessions
      };
    });
    const updatedSession = this.state.sessions.get(sessionId);
    if (appendedTurn && updatedSession) {
      const catalog = updatedSession.turnCatalog?.sessionId === sessionId
        ? updatedSession.turnCatalog
        : undefined;
      const identity = resolveDialogTurnIdentity(updatedSession, dialogTurn);
      if (!identity) {
        return;
      }
      this.cacheSessionLoadedTurnRange(sessionId, {
        startOrdinal: identity.ordinal,
        endOrdinalExclusive: identity.ordinal + 1,
        turns: [dialogTurn],
        lastAccessedAt: Date.now(),
        source: 'live',
      }, catalog ?? null);
    }
  }

  public deleteDialogTurn(sessionId: string, dialogTurnId: string): void {
    let deletedTurn: DialogTurn | undefined;
    let deletedOrdinal: number | undefined;
    let shiftLaterOrdinals = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      deletedTurn = session.dialogTurns.find(turn => turn.id === dialogTurnId);
      if (!deletedTurn) return prev;
      deletedOrdinal = resolveDialogTurnIdentity(session, deletedTurn)?.ordinal;
      const updatedDialogTurns = session.dialogTurns.filter(turn => turn.id !== dialogTurnId);
      const catalogCountsDeletedTurn = resolveStorageTurnIndex(session, deletedTurn) !== undefined;
      const countedOptimisticTurn = !catalogCountsDeletedTurn
        && !isProvisionalUsageReportTurn(deletedTurn);
      shiftLaterOrdinals = countedOptimisticTurn;
      const nextCanonicalTurnCount = canonicalSessionTurns({ dialogTurns: updatedDialogTurns }).length;
      const currentTokenUsage = currentTokenUsageAfterSourceRemoval(
        session,
        updatedDialogTurns,
        session.currentTokenUsage?.turnId === dialogTurnId,
      );

      const updatedSession = {
        ...session,
        dialogTurns: updatedDialogTurns,
        currentTokenUsage,
        loadedTurnCount: nextCanonicalTurnCount,
        totalTurnCount: countedOptimisticTurn
          ? Math.max(nextCanonicalTurnCount, projectedSessionTurnCount(session) - 1)
          : session.totalTurnCount,
        lastUserDialogMode: this.deriveLastUserDialogMode(updatedDialogTurns),
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
    const view = this.sessionHistoryViews.get(sessionId);
    if (view && deletedTurn && deletedOrdinal !== undefined) {
      const retainedRanges: LoadedTurnRange[] = [];
      for (const range of view.loadedRanges) {
        let groupStartOrdinal: number | undefined;
        let groupTurns: DialogTurn[] = [];
        const flushGroup = () => {
          if (groupStartOrdinal === undefined || groupTurns.length === 0) {
            return;
          }
          retainedRanges.push({
            ...range,
            startOrdinal: groupStartOrdinal,
            endOrdinalExclusive: groupStartOrdinal + groupTurns.length,
            turns: groupTurns,
          });
          groupStartOrdinal = undefined;
          groupTurns = [];
        };

        range.turns.forEach((turn, localIndex) => {
          if (turn.id === dialogTurnId) {
            flushGroup();
            return;
          }
          const ordinal = range.startOrdinal + localIndex;
          const nextOrdinal = shiftLaterOrdinals && ordinal > deletedOrdinal!
            ? ordinal - 1
            : ordinal;
          if (
            groupStartOrdinal !== undefined
            && nextOrdinal !== groupStartOrdinal + groupTurns.length
          ) {
            flushGroup();
          }
          groupStartOrdinal ??= nextOrdinal;
          groupTurns.push(turn);
        });
        flushGroup();
      }
      view.loadedRanges = retainedRanges;

      if (shiftLaterOrdinals) {
        const accessTimes = this.sessionHistoryTurnAccessTimes.get(sessionId);
        if (accessTimes) {
          const shiftedAccessTimes = new Map<number, number>();
          for (const [ordinal, accessedAt] of accessTimes) {
            if (ordinal === deletedOrdinal) {
              continue;
            }
            shiftedAccessTimes.set(
              ordinal > deletedOrdinal ? ordinal - 1 : ordinal,
              accessedAt,
            );
          }
          if (shiftedAccessTimes.size > 0) {
            this.sessionHistoryTurnAccessTimes.set(sessionId, shiftedAccessTimes);
          } else {
            this.sessionHistoryTurnAccessTimes.delete(sessionId);
          }
        }
        if (view.pendingTargetOrdinal !== null && view.pendingTargetOrdinal > deletedOrdinal) {
          view.pendingTargetOrdinal -= 1;
        }
        if (view.activeRange) {
          const startOrdinal = view.activeRange.startOrdinal > deletedOrdinal
            ? view.activeRange.startOrdinal - 1
            : view.activeRange.startOrdinal;
          const endOrdinalExclusive = view.activeRange.endOrdinalExclusive > deletedOrdinal
            ? view.activeRange.endOrdinalExclusive - 1
            : view.activeRange.endOrdinalExclusive;
          view.activeRange = endOrdinalExclusive > startOrdinal
            ? { ...view.activeRange, startOrdinal, endOrdinalExclusive }
            : null;
        }
      }
    }
    if (deletedTurn && !isProvisionalUsageReportTurn(deletedTurn)) {
      this.seedSessionHistoryLoadedRanges(sessionId, 'live');
    }
  }

  /**
   * Remove a local optimistic turn whose submission was cancelled by a device
   * switch before any host accepted it. This deliberately addresses the owning
   * surface instead of the rendered one; otherwise a same-id session on the new
   * device is edited while the original stays permanently busy.
   */
  public abandonOptimisticDialogTurn(
    surfaceId: DeviceSurfaceId,
    sessionId: string,
    dialogTurnId: string,
  ): void {
    const container = this.surfaceContainers.get(surfaceId);
    const session = container?.state.sessions.get(sessionId);
    const deletedTurn = session?.dialogTurns.find(turn => turn.id === dialogTurnId);
    if (!container || !session || !deletedTurn) {
      return;
    }

    const dialogTurns = session.dialogTurns.filter(turn => turn.id !== dialogTurnId);
    const countedOptimisticTurn = resolveStorageTurnIndex(session, deletedTurn) === undefined
      && !isProvisionalUsageReportTurn(deletedTurn);
    const canonicalTurnCount = canonicalSessionTurns({ dialogTurns }).length;
    const sessions = new Map(container.state.sessions);
    sessions.set(sessionId, {
      ...session,
      dialogTurns,
      currentTokenUsage: currentTokenUsageAfterSourceRemoval(
        session,
        dialogTurns,
        session.currentTokenUsage?.turnId === dialogTurnId,
      ),
      loadedTurnCount: canonicalTurnCount,
      totalTurnCount: countedOptimisticTurn
        ? Math.max(canonicalTurnCount, projectedSessionTurnCount(session) - 1)
        : session.totalTurnCount,
      lastUserDialogMode: this.deriveLastUserDialogMode(dialogTurns),
      lastActiveAt: Date.now(),
    });
    container.state = { ...container.state, sessions };

    // The optimistic turn may have been included in a loaded-range projection.
    // Rebuild that derived cache when the device is rendered again rather than
    // retaining an ordinal that no longer exists.
    container.sessionHistoryViews.delete(sessionId);
    container.sessionHistoryTurnAccessTimes.delete(sessionId);
    container.deferredFullHistoryProjections.delete(sessionId);
    container.fullHistoryProjectionApplyRequests.delete(sessionId);

    if (surfaceId === getActiveSurfaceId()) {
      this.notifyListeners();
    }
  }

  /**
   * Delete all dialog turns from turnIndex (inclusive)
   * Used for turn rollback: revert to before this turn and remove this turn and all subsequent history
   */
  public truncateDialogTurnsFrom(sessionId: string, turnIndex: number): void {

    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const clampedIndex = Math.max(0, Math.min(turnIndex, session.dialogTurns.length));
      const updatedDialogTurns = session.dialogTurns.slice(0, clampedIndex);
      const removedCurrentUsageSource = Boolean(
        session.currentTokenUsage?.turnId
        && session.dialogTurns.slice(clampedIndex).some(
          turn => turn.id === session.currentTokenUsage?.turnId,
        ),
      );
      const hasCompleteHistory = session.isPartial !== true;
      const historyView = this.sessionHistoryViews.get(sessionId);
      const currentCatalog = session.turnCatalog?.sessionId === sessionId
        ? session.turnCatalog
        : historyView?.catalog?.sessionId === sessionId
          ? historyView.catalog
          : undefined;
      const truncatedCatalog = hasCompleteHistory && currentCatalog
        ? truncateTurnCatalog(
          currentCatalog,
          clampedIndex,
          `${currentCatalog.revision}:rollback:${clampedIndex}:${Date.now()}`,
        )
        : undefined;
      const updatedSession = {
        ...session,
        dialogTurns: updatedDialogTurns,
        currentTokenUsage: currentTokenUsageAfterSourceRemoval(
          session,
          updatedDialogTurns,
          removedCurrentUsageSource,
        ),
        ...(hasCompleteHistory ? {
          loadedTurnCount: updatedDialogTurns.length,
          totalTurnCount: updatedDialogTurns.length,
          turnCatalog: truncatedCatalog,
        } : {}),
        lastUserDialogMode: this.deriveLastUserDialogMode(updatedDialogTurns),
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      if (hasCompleteHistory) {
        if (historyView) {
          historyView.navigationGeneration += 1;
          historyView.pendingTargetOrdinal = null;
          historyView.activeRange = null;
          historyView.catalog = truncatedCatalog ?? null;
          historyView.loadedRanges = historyView.loadedRanges.flatMap(range => {
            if (range.startOrdinal >= clampedIndex) {
              return [];
            }
            const endOrdinalExclusive = Math.min(range.endOrdinalExclusive, clampedIndex);
            return [{
              ...range,
              endOrdinalExclusive,
              turns: range.turns.slice(0, endOrdinalExclusive - range.startOrdinal),
            }];
          });
        }
        const accessTimes = this.sessionHistoryTurnAccessTimes.get(sessionId);
        if (accessTimes) {
          for (const ordinal of accessTimes.keys()) {
            if (ordinal >= clampedIndex) {
              accessTimes.delete(ordinal);
            }
          }
          if (accessTimes.size === 0) {
            this.sessionHistoryTurnAccessTimes.delete(sessionId);
          }
        }
        this.deferredFullHistoryProjections.delete(sessionId);
        this.fullHistoryProjectionApplyRequests.delete(sessionId);
      }

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public async loadRelaySessionHistory(sessionId: string): Promise<void> {
    const surface = this.activeSurface;
    if (surface.surfaceId === 'local') throw new Error('Local history is owned by the local runtime');
    if (!surface.state.sessions.has(sessionId)) throw new Error('Relay session shell is not loaded');
    let history = surface.relaySessionHistory.get(sessionId);
    if (!history) {
      history = new RelaySessionHistory(sessionId,
        record => this.applyRelaySessionRecord(record),
        ready => {
          this.setState(previous => {
            const session = previous.sessions.get(sessionId);
            if (!session) return previous;
            const sessions = new Map(previous.sessions);
            sessions.set(sessionId, { ...session, historyState: 'ready', isHistorical: false,
              // This surface owns presentation only. Execution-context loading
              // remains on the runtime when it accepts the next command.
              contextRestoreState: 'ready',
              isPartial: ready.hasMore, loadedTurnCount: session.dialogTurns.length });
            return { ...previous, sessions };
          });
          if (!ready.hasMore) this.refreshRelayTurnCatalog(sessionId);
        }, error => {
          log.error('Relay session history failed', { sessionId, error });
          this.setSessionHistoryState(sessionId, 'failed');
          // Retrying opens a fresh replay owner; a failed owner must not turn
          // the subsequent ready notification into a false successful page.
          if (surface.relaySessionHistory.get(sessionId) === history) {
            surface.relaySessionHistory.delete(sessionId);
            history?.close();
          }
        }, () => this.refreshRelayInteractionMailbox(sessionId));
      surface.relaySessionHistory.set(sessionId, history);
    }
    try { await history.open(); }
    catch (error) {
      if (surface === this.activeSurface) this.setSessionHistoryState(sessionId, 'failed');
      if (surface.relaySessionHistory.get(sessionId) === history) surface.relaySessionHistory.delete(sessionId);
      throw error;
    }
  }

  private refreshRelayInteractionMailbox(sessionId: string): Promise<void> {
    const surface = this.activeSurface;
    surface.relayMailboxVersions.set(sessionId, (surface.relayMailboxVersions.get(sessionId) ?? 0) + 1);
    const existing = surface.relayMailboxReads.get(sessionId);
    if (existing) return existing;
    const scope = getActiveSurfaceScope();
    const read = (async () => {
      while (scope.isCurrent() && surface === this.activeSurface) {
        const mailboxVersion = surface.relayMailboxVersions.get(sessionId);
        const recordVersion = surface.relayRecordVersions.get(sessionId) ?? 0;
        const eventVersion = liveSessionInteractionStore.captureEventVersion(scope.surfaceId);
        const mailbox = await agentAPI.getSessionInteractionMailbox(sessionId);
        if (!scope.isCurrent() || surface !== this.activeSurface || !surface.state.sessions.has(sessionId) || mailbox.sessionId !== sessionId) return;
        if (mailboxVersion !== surface.relayMailboxVersions.get(sessionId)) continue;
        liveSessionInteractionStore.reconcilePermissionSnapshot(scope.surfaceId, sessionId, mailbox.permissions, eventVersion);
        // Canonical terminal facts fence an overlapping mailbox response. Do
        // not turn a busy token stream into repeated mailbox requests.
        if (recordVersion !== (surface.relayRecordVersions.get(sessionId) ?? 0)) {
          const turns = surface.state.sessions.get(sessionId)?.dialogTurns ?? [];
          mailbox.userQuestions = { ...mailbox.userQuestions, questions: mailbox.userQuestions.questions.filter(question => {
            const turn = turns.find(value => value.id === question.dialogTurnId);
            const item = turns.flatMap(value => value.modelRounds.flatMap(round => round.items))
              .find(value => value.type === 'tool' && value.toolCall.id === question.toolId);
            return (!turn || !['completed', 'cancelled', 'error'].includes(turn.status))
              && (!item || item.type !== 'tool' || !['completed', 'failed', 'cancelled', 'error'].includes(item.status));
          }) };
        }
        surface.relayQuestionMailboxes.set(sessionId, mailbox.userQuestions);
        this.reconcilePendingUserQuestions(sessionId, mailbox.userQuestions);
        return;
      }
    })().finally(() => { surface.relayMailboxReads.delete(sessionId); });
    surface.relayMailboxReads.set(sessionId, read);
    return read;
  }

  public async loadOlderRelaySessionHistory(sessionId: string): Promise<boolean> {
    await this.loadRelaySessionHistory(sessionId);
    const history = this.activeSurface.relaySessionHistory.get(sessionId);
    if (!history) throw new Error('Relay session history is no longer active');
    return history.loadOlder();
  }

  private refreshRelayTurnCatalog(sessionId: string): void {
    const session = this.state.sessions.get(sessionId);
    if (!session || session.isPartial !== false) return;
    const turns = session.dialogTurns.filter(turn => !isProvisionalUsageReportTurn(turn));
    // Optimistic submissions have no storage index yet. Do not invent one or
    // confuse storage positions (which can contain gaps) with visible ordinals.
    if (turns.some(turn => turn.storageTurnIndex === undefined)) return;
    const entries = turns.map((turn, ordinal) => ({
      ordinal, storageTurnIndex: turn.storageTurnIndex!, turnId: turn.id,
      preview: turn.userMessage.content, previewTruncated: false,
    }));
    const revision = `relay:${entries.map(entry => entry.turnId).join('|')}`;
    this.updateAuthoritativeSessionTurnCatalog(sessionId, {
      schemaVersion: 1, sessionId, revision, complete: true,
      totalTurnCount: entries.length, entries,
    });
    this.seedSessionHistoryLoadedRanges(sessionId);
  }

  /** Both realtime delivery and historical pages use the same record owner. */
  public applyRelaySessionRecord(record: SessionRecord): void {
    const surface = this.activeSurface;
    if (surface.surfaceId === 'local') throw new Error('Relay record cannot target the local runtime');
    if (!surface.state.sessions.has(record.sessionId)) throw new Error('Relay session shell is not loaded');
    let replica = surface.relaySessionRecords.get(record.sessionId);
    if (!replica) {
      replica = new SessionRecordReplica(record.sessionId);
      surface.relaySessionRecords.set(record.sessionId, replica);
    }
    const previousTurn = surface.state.sessions.get(record.sessionId)?.dialogTurns;
    const change = replica.apply(record);
    surface.relayRecordVersions.set(record.sessionId, (surface.relayRecordVersions.get(record.sessionId) ?? 0) + 1);
    if (!change) return;
    const incoming = change.turn
      ? this.convertToDialogTurns([change.turn], { activeTurnId: change.turn.turnId })[0]
      : null;
    this.setState(previous => {
      const session = previous.sessions.get(record.sessionId);
      if (!session) return previous;
      let dialogTurns = session.dialogTurns.filter(turn => turn.id !== change.turnId);
      if (incoming) {
        // A submission can be painted before the runtime allocates its turn ID.
        // The stable user-message ID joins that optimistic row to its echo.
        dialogTurns = dialogTurns.filter(turn => turn.userMessage.id !== incoming.userMessage.id);
        dialogTurns.push(incoming);
        dialogTurns.sort((a, b) => a.storageTurnIndex !== undefined && b.storageTurnIndex !== undefined
          ? a.storageTurnIndex - b.storageTurnIndex : a.startTime - b.startTime);
      }
      const sessions = new Map(previous.sessions);
      sessions.set(record.sessionId, { ...session, dialogTurns });
      return { ...previous, sessions };
    });
    const mailbox = surface.relayQuestionMailboxes.get(record.sessionId);
    if (mailbox) {
      const turns = this.state.sessions.get(record.sessionId)?.dialogTurns ?? [];
      const questions = mailbox.questions.filter(question => {
        const turn = turns.find(value => value.id === question.dialogTurnId);
        if (turn && ['completed', 'cancelled', 'error'].includes(turn.status)) return false;
        const item = turns.flatMap(value => value.modelRounds.flatMap(round => round.items))
          .find(value => value.type === 'tool' && value.toolCall.id === question.toolId);
        return !item || item.type !== 'tool' || !['completed', 'failed', 'cancelled', 'error'].includes(item.status);
      });
      const currentMailbox = { ...mailbox, questions };
      surface.relayQuestionMailboxes.set(record.sessionId, currentMailbox);
      this.reconcilePendingUserQuestions(record.sessionId, currentMailbox);
    }
    const currentTurns = this.state.sessions.get(record.sessionId)?.dialogTurns ?? [];
    if (previousTurn?.length !== currentTurns.length
      || previousTurn?.some((turn, index) => turn.id !== currentTurns[index]?.id
        || turn.storageTurnIndex !== currentTurns[index]?.storageTurnIndex)) {
      this.refreshRelayTurnCatalog(record.sessionId);
    }
    const latest = currentTurns.at(-1);
    const running = latest && !['completed', 'cancelled', 'error'].includes(latest.status);
    const round = latest?.modelRounds.at(-1);
    const pendingTools = running ? latest.modelRounds.flatMap(modelRound => modelRound.items)
      .filter((item): item is FlowToolItem => item.type === 'tool' && item.status === 'pending_confirmation')
      .map(item => item.toolCall.id) : [];
    stateMachineManager.getOrCreate(record.sessionId).acceptRuntimeStatus({
      state: latest?.status === 'error' ? SessionExecutionState.ERROR
        : running ? SessionExecutionState.PROCESSING : SessionExecutionState.IDLE,
      turnId: latest?.id ?? null, roundId: round?.id ?? null,
      phase: !running ? null : pendingTools.length ? ProcessingPhase.TOOL_CONFIRMING
        : round?.items.some(item => item.type === 'tool' && item.status === 'running')
          ? ProcessingPhase.TOOL_CALLING : ProcessingPhase.THINKING,
      pendingTools, error: latest?.error ?? null,
    });
  }

  public updateDialogTurn(
    sessionId: string,
    dialogTurnId: string,
    updater: (turn: DialogTurn) => DialogTurn,
    options?: { touchActivity?: boolean }
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const updatedDialogTurns = session.dialogTurns.map(turn => 
        turn.id === dialogTurnId ? updater(turn) : turn
      );

      const updatedSession = {
        ...session,
        dialogTurns: updatedDialogTurns,
        lastActiveAt: options?.touchActivity === false
          ? session.lastActiveAt
          : Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Replace a provisional Turn in place so projected counts and cached history
   * keep one stable ordinal across runtime adoption.
   */
  public replaceOptimisticDialogTurn(
    sessionId: string,
    optimisticTurnId: string,
    replacement: DialogTurn,
  ): boolean {
    let replaced = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;
      const localIndex = session.dialogTurns.findIndex(turn => turn.id === optimisticTurnId);
      if (localIndex < 0) return prev;

      const dialogTurns = [...session.dialogTurns];
      dialogTurns[localIndex] = replacement;
      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        dialogTurns,
        lastUserDialogMode: this.deriveLastUserDialogMode(dialogTurns),
        lastActiveAt: Date.now(),
      });
      replaced = true;
      return { ...prev, sessions: newSessions };
    });

    if (replaced) {
      const view = this.sessionHistoryViews.get(sessionId);
      if (view) {
        view.loadedRanges = view.loadedRanges.map(range => ({
          ...range,
          turns: range.turns.map(turn => turn.id === optimisticTurnId ? replacement : turn),
        }));
      }
    }
    return replaced;
  }

  /**
   * Add image analysis phase to dialog turn
   */
  public addImageAnalysisPhase(
    sessionId: string, 
    dialogTurnId: string, 
    imageContexts: import('@/shared/types/context').ImageContext[]
  ): void {
    this.updateDialogTurn(sessionId, dialogTurnId, turn => {
      const imageAnalysisItems: FlowImageAnalysisItem[] = imageContexts.map((ctx, index) => ({
        id: `img-analysis-${ctx.id}`,
        type: 'image-analysis',
        imageContext: ctx,
        result: null,
        status: 'analyzing',
        timestamp: Date.now() + index,
      }));

      return {
        ...turn,
        imageAnalysisPhase: {
          items: imageAnalysisItems,
          status: 'analyzing',
          startTime: Date.now(),
        },
        status: 'image_analyzing',
      };
    });
  }

  /**
   * Update image analysis results
   */
  public updateImageAnalysisResults(
    sessionId: string,
    dialogTurnId: string,
    results: ImageAnalysisResult[]
  ): void {
      this.updateDialogTurn(sessionId, dialogTurnId, turn => {
        if (!turn.imageAnalysisPhase) {
          log.warn('Attempting to update non-existent image analysis phase', { sessionId, dialogTurnId });
          return turn;
        }

      const updatedItems: FlowImageAnalysisItem[] = turn.imageAnalysisPhase.items.map(item => {
        const result = results.find(r => r.image_id === item.imageContext.id);
        if (result) {
          return {
            ...item,
            result,
            status: 'completed' as const,
          };
        }
        return item;
      });

      const allCompleted = updatedItems.every(item => item.status === 'completed');

      return {
        ...turn,
        imageAnalysisPhase: {
          ...turn.imageAnalysisPhase,
          items: updatedItems,
          status: allCompleted ? 'completed' : 'analyzing',
          endTime: allCompleted ? Date.now() : undefined,
        },
        status: allCompleted ? 'pending' : 'image_analyzing',
      };
    });
  }

  /**
   * Update single image analysis item status (for error handling)
   */
  public updateImageAnalysisItem(
    sessionId: string,
    dialogTurnId: string,
    imageId: string,
    updates: { status?: 'analyzing' | 'completed' | 'error'; error?: string; result?: any }
  ): void {
    this.updateDialogTurn(sessionId, dialogTurnId, turn => {
      if (!turn.imageAnalysisPhase) return turn;

      const updatedItems = turn.imageAnalysisPhase.items.map(item => {
        if (item.imageContext.id === imageId) {
          return { ...item, ...updates };
        }
        return item;
      });

      return {
        ...turn,
        imageAnalysisPhase: {
          ...turn.imageAnalysisPhase,
          items: updatedItems,
        },
      };
    });
  }

  public addModelRound(sessionId: string, dialogTurnId: string, modelRound: ModelRound): void {
    this.updateDialogTurn(sessionId, dialogTurnId, turn => ({
      ...turn,
      modelRounds: [...turn.modelRounds, synchronizeRoundAttempts(modelRound)],
      status: 'processing'
    }));
  }

  public updateModelRound(sessionId: string, dialogTurnId: string, modelRoundId: string, updater: (round: ModelRound) => ModelRound): void {
    this.updateDialogTurn(sessionId, dialogTurnId, turn => ({
      ...turn,
      modelRounds: turn.modelRounds.map(round => 
        round.id === modelRoundId ? synchronizeRoundAttempts(updater(round)) : round
      )
    }));
  }

  /**
   * Batch update multiple model round items (reduces store update frequency)
   */
  public batchUpdateModelRoundItems(
    sessionId: string, 
    dialogTurnId: string, 
    updates: Array<{ itemId: string; changes: Partial<FlowItem> }>
  ): void {
    if (updates.length === 0) return;
    
    this.updateDialogTurn(sessionId, dialogTurnId, turn => {
      const updatedModelRounds = turn.modelRounds.map(round => {
        const activeAttempts = round.attempts ?? deriveRoundAttemptsFromItems(round.items);

        if (activeAttempts && activeAttempts.length > 0) {
          let roundChanged = false;
          const nextAttempts = activeAttempts.map(attempt => {
            let attemptChanged = false;
            const nextItems = attempt.items.map(item => {
              const update = updates.find(u => itemMatchesIdentity(item, u.itemId));
              if (!update) {
                return item;
              }

              attemptChanged = true;
              roundChanged = true;
              return { ...item, ...update.changes } as AnyFlowItem;
            });

            return attemptChanged ? { ...attempt, items: nextItems } : attempt;
          });

          return roundChanged
            ? synchronizeRoundAttempts({
                ...round,
                attempts: nextAttempts,
              })
            : round;
        }

        return {
          ...round,
          items: round.items.map(item => {
            const update = updates.find(u => itemMatchesIdentity(item, u.itemId));
            return update ? ({ ...item, ...update.changes } as AnyFlowItem) : item;
          })
        };
      });
      
      return {
        ...turn,
        modelRounds: updatedModelRounds
      };
    });
  }

  public addModelRoundItem(sessionId: string, dialogTurnId: string, item: AnyFlowItem, modelRoundId?: string): void {
    this.updateDialogTurn(sessionId, dialogTurnId, turn => {
      let targetModelRoundIndex = turn.modelRounds.length - 1;
        if (modelRoundId) {
          targetModelRoundIndex = turn.modelRounds.findIndex(round => round.id === modelRoundId);
          if (targetModelRoundIndex === -1) {
            log.warn('Model round not found', { sessionId, dialogTurnId, modelRoundId });
            return turn;
          }
        }
        
        if (targetModelRoundIndex === -1) {
          log.warn('No available model rounds', { sessionId, dialogTurnId });
          return turn;
        }

      const targetModelRound = turn.modelRounds[targetModelRoundIndex];

      const existingItem = targetModelRound.items.find(existingItem => existingItem.id === item.id);
      if (existingItem) {
        return turn;
      }

      const updatedModelRounds = [...turn.modelRounds];
      const activeAttempts = targetModelRound.attempts ?? deriveRoundAttemptsFromItems(targetModelRound.items);
      const incomingAttemptId = typeof item.attemptId === 'string' && item.attemptId.length > 0
        ? item.attemptId
        : undefined;
      const incomingAttemptIndex = typeof item.attemptIndex === 'number' && Number.isFinite(item.attemptIndex)
        ? item.attemptIndex
        : undefined;

      if (!activeAttempts || activeAttempts.length === 0) {
        if (!incomingAttemptId && incomingAttemptIndex === undefined) {
          updatedModelRounds[targetModelRoundIndex] = {
            ...targetModelRound,
            items: [...targetModelRound.items, item]
          };
        } else {
          const initialAttempt = {
            id: incomingAttemptId ?? `attempt:${incomingAttemptIndex ?? 1}`,
            index: incomingAttemptIndex ?? 1,
          };
          const attemptItems = [
            ...targetModelRound.items.map(existing => withAttemptMetadata(existing, initialAttempt)),
            withAttemptMetadata(item, initialAttempt),
          ];
          updatedModelRounds[targetModelRoundIndex] = synchronizeRoundAttempts({
            ...targetModelRound,
            attempts: [{
              ...initialAttempt,
              status: 'streaming',
              items: attemptItems,
            }],
          });
        }
      } else {
        const latestAttempt = sortAttemptEntries(activeAttempts)[activeAttempts.length - 1];
        const targetAttempt = {
          id: incomingAttemptId ?? latestAttempt.id,
          index: incomingAttemptIndex ?? latestAttempt.index,
        };
        const normalizedItem = withAttemptMetadata(item, targetAttempt);
        const targetAttemptKey = `${targetAttempt.id}::${targetAttempt.index}`;
        let attemptFound = false;
        const nextAttempts = activeAttempts.map(attempt => {
          const attemptKey = `${attempt.id}::${attempt.index}`;
          if (attemptKey !== targetAttemptKey) {
            return attempt;
          }

          attemptFound = true;
          return {
            ...attempt,
            items: [...attempt.items, normalizedItem],
          };
        });

        updatedModelRounds[targetModelRoundIndex] = synchronizeRoundAttempts({
          ...targetModelRound,
          attempts: attemptFound
            ? nextAttempts
            : [...nextAttempts, { ...targetAttempt, status: 'streaming', items: [normalizedItem] }],
        });
      }

      return {
        ...turn,
        modelRounds: updatedModelRounds
      };
    });
  }

  /**
   * Silent add ModelRound item (does not trigger listeners)
   * Used for batch update scenarios
   */
  public addModelRoundItemSilent(sessionId: string, dialogTurnId: string, item: AnyFlowItem, modelRoundId?: string): void {
    const prevSilentMode = this.silentMode;
    this.silentMode = true;
    try {
      this.addModelRoundItem(sessionId, dialogTurnId, item, modelRoundId);
    } finally {
      this.silentMode = prevSilentMode;
    }
  }

  public updateModelRoundItem(sessionId: string, dialogTurnId: string, itemId: string, updates: Partial<FlowItem>): boolean {
    let updated = false;
    this.updateDialogTurn(sessionId, dialogTurnId, turn => {
      
      const updatedModelRounds = turn.modelRounds.map(modelRound => {
        if (updated) return modelRound;

        const activeAttempts = modelRound.attempts ?? deriveRoundAttemptsFromItems(modelRound.items);
        if (activeAttempts && activeAttempts.length > 0) {
          let foundInAttempts = false;
          const nextAttempts = activeAttempts.map(attempt => {
            let attemptChanged = false;
            const nextItems = attempt.items.map(item => {
              if (!itemMatchesIdentity(item, itemId)) {
                return item;
              }

              foundInAttempts = true;
              attemptChanged = true;
              return { ...item, ...updates } as AnyFlowItem;
            });

            return attemptChanged ? { ...attempt, items: nextItems } : attempt;
          });

          if (foundInAttempts) {
            updated = true;
            return synchronizeRoundAttempts({
              ...modelRound,
              attempts: nextAttempts,
            });
          }
        }

        const updatedItems = modelRound.items.map((item: any) => {
          if (!itemMatchesIdentity(item, itemId)) {
            return item;
          }

          return { ...item, ...updates };
        });

        if (updatedItems.some((item: any) => itemMatchesIdentity(item, itemId))) {
          updated = true;
          return { ...modelRound, items: updatedItems };
        }

        return modelRound;
      });
      
      if (!updated) {
        log.warn('Item not found for update', { sessionId, dialogTurnId, itemId });
        return turn;
      }

      return {
        ...turn,
        modelRounds: updatedModelRounds
      };
    });
    if (!updated) {
      markRuntimeSessionProjectionStale(getActiveSurfaceScope().surfaceId, sessionId);
    }
    return updated;
  }

  /**
   * Silent update ModelRound item (does not trigger listeners)
   * Used for batch update scenarios
   */
  public updateModelRoundItemSilent(sessionId: string, dialogTurnId: string, itemId: string, updates: Partial<FlowItem>): boolean {
    const prevSilentMode = this.silentMode;
    this.silentMode = true;
    try {
      return this.updateModelRoundItem(sessionId, dialogTurnId, itemId, updates);
    } finally {
      this.silentMode = prevSilentMode;
    }
  }

  /**
   * Find tool item (for early detection updates)
   */
  public findToolItem(sessionId: string, dialogTurnId: string, toolUseId: string): FlowItem | null {
    const session = this.state.sessions.get(sessionId);
    if (!session) return null;

    const dialogTurn = session.dialogTurns.find(turn => turn.id === dialogTurnId);
    if (!dialogTurn) return null;

    for (const modelRound of dialogTurn.modelRounds) {
      const item = modelRound.items.find((item: any) => {
        if (item.id === toolUseId) return true;
        if (item.type === 'tool') {
          const ti = item as FlowToolItem;
          return ti.toolCall?.id === toolUseId;
        }
        return false;
      });
      if (item) {
        return item;
      }
    }

    return null;
  }

  public updateTokenUsage(
    sessionId: string, 
    tokenUsage: Pick<
      TokenUsage,
      'inputTokens' | 'outputTokens' | 'totalTokens' | 'turnId' | 'source'
    >,
    dialogTurnId?: string
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const nextTokenUsage: TokenUsage = {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        totalTokens: tokenUsage.totalTokens,
        timestamp: Date.now(),
        ...(tokenUsage.turnId ? { turnId: tokenUsage.turnId } : {}),
        ...(tokenUsage.source ? { source: tokenUsage.source } : {}),
      };
      let dialogTurns = session.dialogTurns;
      if (dialogTurnId) {
        const turnIndex = session.dialogTurns.findIndex(turn => turn.id === dialogTurnId);
        if (turnIndex !== -1) {
          const previousTurnUsage = session.dialogTurns[turnIndex].tokenUsage;
          const accumulatedOutputTokens = previousTurnUsage
            ? (
                typeof previousTurnUsage.outputTokens === 'number' &&
                typeof nextTokenUsage.outputTokens === 'number'
                  ? previousTurnUsage.outputTokens + nextTokenUsage.outputTokens
                  : undefined
              )
            : nextTokenUsage.outputTokens;
          const accumulatedTurnUsage: TokenUsage = {
            inputTokens: (previousTurnUsage?.inputTokens ?? 0) + nextTokenUsage.inputTokens,
            outputTokens: accumulatedOutputTokens,
            totalTokens: (previousTurnUsage?.totalTokens ?? 0) + nextTokenUsage.totalTokens,
            timestamp: nextTokenUsage.timestamp,
          };
          dialogTurns = [...session.dialogTurns];
          dialogTurns[turnIndex] = {
            ...dialogTurns[turnIndex],
            tokenUsage: accumulatedTurnUsage,
          };
        }
      }

      const updatedSession = {
        ...session,
        currentTokenUsage: nextTokenUsage,
        dialogTurns
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public updateAcpContextUsage(
    sessionId: string,
    contextUsage: { used: number; size: number; cost?: { amount: number; currency: string } }
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const nextUsage: AcpContextUsage = {
        used: contextUsage.used,
        size: contextUsage.size,
        timestamp: Date.now(),
      };
      if (contextUsage.cost) {
        nextUsage.cost = contextUsage.cost;
      }

      const currentUsage = session.currentAcpContextUsage;
      if (
        currentUsage &&
        currentUsage.used === nextUsage.used &&
        currentUsage.size === nextUsage.size &&
        currentUsage.cost?.amount === nextUsage.cost?.amount &&
        currentUsage.cost?.currency === nextUsage.cost?.currency
      ) {
        return prev;
      }

      const updatedSession = {
        ...session,
        currentAcpContextUsage: nextUsage,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public rollbackTokenUsage(): void {
  }

  public updateSessionMaxContextTokens(sessionId: string, maxContextTokens: number): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      if (session.maxContextTokens === maxContextTokens) return prev;

      const updatedSession = {
        ...session,
        maxContextTokens
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public setError(sessionId: string, error: string | null): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const updatedSession: Session = {
        ...session,
        error,
        status: error ? 'error' as const : 'idle' as const,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public markSessionFinished(sessionId: string, timestamp: number = Date.now()): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const updatedSession: Session = {
        ...session,
        lastActiveAt: timestamp,
        lastFinishedAt: timestamp,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public markSessionUnreadCompletion(
    sessionId: string,
    completionKind: 'completed' | 'error' | 'interrupted',
    turnId?: string,
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const turn = turnId ? session.dialogTurns.find(candidate => candidate.id === turnId) : lastUserDialogTurn(session);
      const updatedSession: Session = {
        ...session,
        hasUnreadCompletion: completionKind,
        unreadCompletionTurnId: turnId ?? turn?.id,
        unreadCompletionGeneration: turn?.recovery?.executionGeneration ?? turn?.recoveryEpoch,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return { ...prev, sessions: newSessions };
    });
    this.onPersistUnreadCompletion?.(sessionId, completionKind);
  }

  public clearSessionUnreadCompletion(
    sessionId: string,
    expected?: { surfaceId: DeviceSurfaceId; receipt: string },
  ): void {
    let didClear = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || !session.hasUnreadCompletion) return prev;
      if (expected && (getActiveSurfaceId() !== expected.surfaceId
        || sessionCompletionReceipt(session) !== expected.receipt)) return prev;
      if (expected) {
        const summary = sessionActivityStore.get(sessionId)?.summary;
        const turn = lastUserDialogTurn(session);
        if (summary && (summary.execution === 'running' || summary.execution === 'queued'
          || (summary.unreadCompletion && summary.lastTurn && (summary.lastTurn.turnId !== turn?.id
            || summary.lastTurn.status !== turn?.status
            || summary.lastTurn.executionGeneration !== (turn?.recovery?.executionGeneration ?? turn?.recoveryEpoch)
            || (summary.lastTurn.recoveryPending !== undefined
              && summary.lastTurn.recoveryPending !== isTurnAwaitingRecovery(turn)))))) return prev;
      }

      const updatedSession: Session = {
        ...session,
        hasUnreadCompletion: undefined,
        unreadCompletionTurnId: undefined,
        unreadCompletionGeneration: undefined,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      didClear = true;
      return { ...prev, sessions: newSessions };
    });
    if (didClear) {
      const turn = lastUserDialogTurn(this.state.sessions.get(sessionId));
      if (turn) sessionActivityStore.acknowledge(sessionId, turn.id,
        turn.recovery?.executionGeneration ?? turn.recoveryEpoch, isTurnAwaitingRecovery(turn));
      this.onPersistUnreadCompletion?.(sessionId, undefined);
    }
  }

  /** Mirror only the summary's read marker, never its state into the Turn model. */
  public applySessionActivityReceipt(summary: SessionActivitySummary): void {
    this.setState(prev => {
      const session = prev.sessions.get(summary.sessionId);
      if (!session || session.config.dispatchJobId) return prev;
      const turnId = summary.unreadCompletion ? summary.lastTurn?.turnId : undefined;
      const generation = summary.unreadCompletion ? summary.lastTurn?.executionGeneration : undefined;
      if (session.hasUnreadCompletion === summary.unreadCompletion && session.unreadCompletionTurnId === turnId
        && session.unreadCompletionGeneration === generation) return prev;
      const sessions = new Map(prev.sessions);
      sessions.set(summary.sessionId, {
        ...session, hasUnreadCompletion: summary.unreadCompletion, unreadCompletionTurnId: turnId,
        unreadCompletionGeneration: generation,
      });
      return { ...prev, sessions };
    });
  }

  public setSessionNeedsAttention(
    sessionId: string,
    attentionKind: 'ask_user' | 'tool_confirm'
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      const updatedSession: Session = {
        ...session,
        needsUserAttention: attentionKind,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return { ...prev, sessions: newSessions };
    });
    this.onPersistUnreadCompletion?.(sessionId, undefined);
  }

  public clearSessionNeedsAttention(sessionId: string): void {
    let didClear = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || !session.needsUserAttention) return prev;

      const updatedSession: Session = {
        ...session,
        needsUserAttention: undefined,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      didClear = true;
      return { ...prev, sessions: newSessions };
    });
    if (didClear) {
      this.onPersistUnreadCompletion?.(sessionId, undefined);
    }
  }

  public async updateSessionTitle(
    sessionId: string,
    title: string,
    status: 'generating' | 'generated' | 'failed'
  ): Promise<void> {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) return prev;

      // As soon as the user meaningfully interacts with the session we freeze the
      // title to text, so later locale changes do not rewrite real conversation names.
      const nextTitleState = freezeSessionTitleState(title);
      const updatedSession = {
        ...session,
        ...nextTitleState,
        titleStatus: status,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Cancel current session task (UI state update)
   * Called by SessionStateMachine side effects, updates all related states to cancelled
   */
  public cancelSessionTask(sessionId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        log.warn('Session not found', { sessionId });
        return prev;
      }

      const lastDialogTurn = session.dialogTurns[session.dialogTurns.length - 1];
      if (!lastDialogTurn) {
        log.warn('No dialog turns found', { sessionId });
        return prev;
      }

      if (lastDialogTurn.status === 'completed' || lastDialogTurn.status === 'cancelled') {
        return prev;
      }

      const settledAt = Date.now();
      const updatedDialogTurns = session.dialogTurns.map((turn, index) =>
        index === session.dialogTurns.length - 1
          ? settleInterruptedDialogTurn(turn, settledAt)
          : turn
      );

      const updatedSession = {
        ...session,
        dialogTurns: updatedDialogTurns,
        status: 'idle' as const,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      window.dispatchEvent(new CustomEvent('openbitfun:dialog-cancelled', {
        detail: { sessionId }
      }));

      const lastTurn = updatedDialogTurns[updatedDialogTurns.length - 1];
      if (lastTurn && lastTurn.status === 'cancelled') {
        this.saveCancelledDialogTurn(sessionId, lastTurn.id).catch(error => {
          log.error('Failed to save cancelled dialog turn', { sessionId, turnId: lastTurn.id, error });
        });
      }

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Save cancelled dialog turn to disk
   */
  private async saveCancelledDialogTurn(sessionId: string, turnId: string): Promise<void> {
    try {
      const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
      const session = this.state.sessions.get(sessionId);
      if (!session) {
        log.warn('Session not found, skipping save', { sessionId, turnId });
        return;
      }
      if (session.isTransient) {
        return;
      }
      if (isNonLocalDispatchTarget(session.config.dispatchTarget)) {
        return;
      }

      const workspacePath = sessionProjectWorkspacePath(session);
      if (!workspacePath) {
        log.warn('Workspace path not available, skipping save', { sessionId, turnId });
        return;
      }

      const dialogTurn = session.dialogTurns.find(turn => turn.id === turnId);
      if (!dialogTurn) {
        log.warn('Dialog turn not found, skipping save', { sessionId, turnId });
        return;
      }

      const turnIndex = resolveStorageTurnIndex(session, dialogTurn);
      if (turnIndex === undefined) {
        log.debug('Cancelled dialog turn has no storage identity, deferring persistence', {
          sessionId,
          turnId,
        });
        return;
      }
      
      const turnData = {
        turnId,
        turnIndex,
        sessionId,
        timestamp: dialogTurn.startTime,
        kind: dialogTurn.kind || 'user_dialog',
        userMessage: {
          id: dialogTurn.userMessage.id,
          content: dialogTurn.userMessage.content,
          timestamp: dialogTurn.userMessage.timestamp,
          metadata: dialogTurn.userMessage.metadata,
        },
        modelRounds: dialogTurn.modelRounds.map((round, roundIndex) => {
          const textItems = round.items
            .filter(item => item.type === 'text')
            .map(item => ({
              id: item.id,
              content: (item as any).content || '',
              isStreaming: false,
              timestamp: item.timestamp,
              status: item.status,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            }));
          
          const toolItems = round.items
            .filter(item => item.type === 'tool')
            .map(item => ({
              id: item.id,
              toolName: (item as any).toolName || '',
              interruptionReason: (item as any).interruptionReason,
              toolCall: (item as any).toolCall || { input: {}, id: item.id },
              toolResult: (item as any).toolResult,
              aiIntent: (item as any).aiIntent,
              startTime: (item as any).startTime || item.timestamp,
              endTime: (item as any).endTime,
              status: item.status,
              durationMs: (item as any).durationMs ?? ((item as any).endTime
                ? (item as any).endTime - (item as any).startTime
                : undefined),
              queueWaitMs: (item as any).queueWaitMs,
              preflightMs: (item as any).preflightMs,
              confirmationWaitMs: (item as any).confirmationWaitMs,
              executionMs: (item as any).executionMs,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            }));
          
          const thinkingItems = round.items
            .filter(item => item.type === 'thinking')
            .map(item => ({
              id: item.id,
              content: (item as any).content || '',
              isStreaming: false,
              isCollapsed: (item as any).isCollapsed || false,
              timestamp: item.timestamp,
              status: item.status,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            }));
          
          return {
            id: round.id,
            turnId,
            roundIndex,
            roundGroupId: round.roundGroupId,
            timestamp: round.startTime,
            renderHints: round.renderHints,
            textItems,
            toolItems,
            thinkingItems,
            startTime: round.startTime,
            endTime: round.endTime || Date.now(),
            durationMs: round.durationMs,
            providerId: round.providerId,
            modelConfigId: round.modelConfigId,
            effectiveModelName: round.effectiveModelName,
            firstChunkMs: round.firstChunkMs,
            firstVisibleOutputMs: round.firstVisibleOutputMs,
            streamDurationMs: round.streamDurationMs,
            attemptCount: round.attemptCount,
            attemptDiagnostics: round.attemptDiagnostics,
            failureCategory: round.failureCategory,
            tokenDetails: round.tokenDetails,
            status: round.status
          };
        }),
        startTime: dialogTurn.startTime,
        endTime: dialogTurn.endTime || Date.now(),
        durationMs: (dialogTurn.endTime || Date.now()) - dialogTurn.startTime,
        tokenUsage: dialogTurn.tokenUsage,
        status: 'cancelled' as const
      };

      await sessionAPI.saveSessionTurn(
        turnData,
        workspacePath,
        session.remoteConnectionId,
        session.remoteSshHost
      );
    } catch (error) {
      log.error('Failed to save cancelled dialog turn', { sessionId, turnId, error });
    }
  }


  /**
   * Initialize by loading persisted session metadata from disk
   * Clears sessions from other workspaces, then loads sessions for the target workspace.
   */
  public async refreshWorkspaceFromDisk(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceSource = 'refresh'
  ): Promise<void> {
    const requestKey = this.getMetadataListRequestKey(workspacePath, remoteConnectionId, remoteSshHost);
    this.metadataListRequests.delete(requestKey);
    await this.initializeFromDisk(workspacePath, remoteConnectionId, remoteSshHost, traceSource);
  }

  public async initializeFromDisk(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceSource = 'unknown'
  ): Promise<void> {
    const requestKey = this.getMetadataListRequestKey(workspacePath, remoteConnectionId, remoteSshHost);
    const existingRequest = this.metadataListRequests.get(requestKey);
    const remote = isRemoteTraceContext(remoteConnectionId, remoteSshHost);
    if (existingRequest) {
      const completedAtMs = existingRequest.completedAtMs;
      const isRecentCompletedRequest =
        completedAtMs !== undefined &&
        elapsedMs(completedAtMs) <= METADATA_LIST_RECENT_DEDUPE_TTL_MS;

      if (completedAtMs === undefined || isRecentCompletedRequest) {
        startupTrace.markPhase('session_metadata_list_deduped', {
          remote,
          source: traceSource,
          dedupeState: completedAtMs === undefined ? 'in-flight' : 'recent',
        });
        return existingRequest.promise;
      }

      if (existingRequest.cleanupTimer) {
        clearTimeout(existingRequest.cleanupTimer);
      }
      this.metadataListRequests.delete(requestKey);
    }

    let succeeded = false;
    const loadPromise = this.initializeFromDiskUncached(
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
      traceSource,
    ).then(result => {
      succeeded = result;
    });

    const request: MetadataListRequest = { promise: loadPromise };
    this.metadataListRequests.set(requestKey, request);

    loadPromise.finally(() => {
      const currentRequest = this.metadataListRequests.get(requestKey);
      if (currentRequest !== request) {
        return;
      }

      if (!succeeded) {
        this.metadataListRequests.delete(requestKey);
        return;
      }

      request.completedAtMs = nowMs();
      request.cleanupTimer = setTimeout(() => {
        if (this.metadataListRequests.get(requestKey) === request) {
          this.metadataListRequests.delete(requestKey);
        }
      }, METADATA_LIST_RECENT_DEDUPE_TTL_MS);
    });

    return loadPromise;
  }

  private async loadSessionMetadataModelConfig(): Promise<{
    models: any[];
    defaultModels: Record<string, string>;
  }> {
    let models: any[] = [];
    let defaultModels: Record<string, string> = {};
    try {
      const { configManager } = await import('@/infrastructure/config/services/ConfigManager');
      const configData = await configManager.getConfigs([
        'ai.models',
        'ai.default_models',
      ]);

      if (Array.isArray(configData['ai.models'])) {
        models = configData['ai.models'];
      }
      if (
        configData['ai.default_models'] &&
        typeof configData['ai.default_models'] === 'object'
      ) {
        defaultModels = configData['ai.default_models'] as Record<string, string>;
      }
    } catch (error) {
      log.warn('Failed to load model config for session metadata, using defaults', { error });
    }

    return { models, defaultModels };
  }

  private async processPersistedSessionMetadataList(
    sessions: any[],
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    modelConfigPromise?: Promise<{
      models: any[];
      defaultModels: Record<string, string>;
    }>,
    includeArchived = false,
  ): Promise<void> {
    const scope = getActiveSurfaceScope();
    const [
      { stateMachineManager },
      { models, defaultModels },
    ] = await Promise.all([
      import('../state-machine'),
      modelConfigPromise ?? this.loadSessionMetadataModelConfig(),
    ]);
    // This page describes the device it was read from. Importing it into
    // whichever surface happens to be rendered now would mix two devices'
    // session lists under one workspace path.
    scope.assertCurrent('processPersistedSessionMetadataList');

    const processSession = async (metadata: any) => {
      try {
        logPersistedDispatchMetadataOverlap(metadata, 'metadata-page');
        scope.assertCurrent('processPersistedSessionMetadata');
        const existingSession = this.state.sessions.get(metadata.sessionId);
        if (existingSession) {
          return;
        }
        if (!includeArchived && metadata.status === 'archived') {
          return;
        }

        stateMachineManager.getOrCreate(metadata.sessionId);

        let maxContextTokens = 128128;
        if (metadata.modelName) {
          const model = models.find((m: any) => m.name === metadata.modelName || m.id === metadata.modelName);
          if (model?.context_window) {
            maxContextTokens = model.context_window;
          }
        }

        if (maxContextTokens === 128128) {
          const primaryModelId = defaultModels?.primary;

          if (primaryModelId) {
            const primaryModel = models.find((m: any) => m.id === primaryModelId);
            if (primaryModel?.context_window) {
              maxContextTokens = primaryModel.context_window;
            }
          }
        }

        const relationship = deriveSessionRelationshipFromMetadata(metadata);
        const lastFinishedAt = deriveLastFinishedAtFromMetadata(metadata);
        const titleState = deriveSessionTitleStateFromMetadata(metadata);
        const hasDynamicDefaultTitle = titleState.titleSource === 'i18n';
        const remoteScope = persistedSessionRemoteScope(
          metadata,
          remoteConnectionId,
          remoteSshHost,
        );
        const persistedCurrentContextUsage = persistedCurrentContextUsageValue(metadata);

        this.setState(prev => {
          if (!scope.isCurrent() || prev.sessions.has(metadata.sessionId)) {
            return prev;
          }

          const rawAgentType = metadata.agentType || 'Standard';
          const validatedAgentType = isValidPersistedAgentType(rawAgentType) ? rawAgentType : 'Standard';
          const restoredCurrentTokenUsage = isAcpAgentType(validatedAgentType)
            ? undefined
            : deriveRestoredCurrentTokenUsage(persistedCurrentContextUsage);

          if (rawAgentType !== validatedAgentType) {
            log.warn('Invalid agentType, falling back to agentic', { sessionId: metadata.sessionId, rawAgentType, validatedAgentType });
          }

          const session: Session = {
            sessionId: metadata.sessionId,
            title: titleState.title,
            titleSource: titleState.titleSource,
            titleI18nKey: titleState.titleI18nKey,
            titleI18nParams: titleState.titleI18nParams,
            workspaceSessionNumber: titleState.workspaceSessionNumber,
            titleStatus: hasDynamicDefaultTitle ? undefined : 'generated',
            dialogTurns: [],
            status: 'idle',
            persistedStatus: metadata.status,
            config: {
              agentType: validatedAgentType,
              modelName: metadata.modelName,
              workspacePath: metadata.workspacePath || workspacePath,
              projectWorkspacePath: metadata.projectWorkspacePath || workspacePath,
              executionTarget: metadata.executionTarget,
            },
            createdAt: metadata.createdAt,
            lastActiveAt: metadata.lastActiveAt,
            lastFinishedAt,
            error: null,
            isHistorical: true,
            historyState: 'metadata-only',
            todos: (metadata as any).todos || [],
            maxContextTokens,
            currentTokenUsage: restoredCurrentTokenUsage,
            mode: validatedAgentType,
            lastUserDialogMode: metadata.lastUserDialogAgentType,
            lastSubmittedMode: metadata.lastSubmittedAgentType,
            workspacePath: (metadata as any).workspacePath || workspacePath,
            projectWorkspacePath: metadata.projectWorkspacePath || workspacePath,
            remoteConnectionId: remoteScope.remoteConnectionId,
            remoteSshHost: remoteScope.remoteSshHost,
            workspaceHostname: metadata.workspaceHostname,
            parentSessionId: relationship.parentSessionId,
            sessionKind: relationship.sessionKind,
            parentToolCallId: relationship.parentToolCallId,
            subagentType: relationship.subagentType,
            btwThreads: [],
            btwOrigin: relationship.btwOrigin,
            hasUnreadCompletion: metadata.unreadCompletion,
            needsUserAttention: metadata.needsUserAttention,
            deepReviewRunManifest: metadata.deepReviewRunManifest,
            reviewTargetEvidence: metadata.reviewTargetEvidence,
            isTransient: false,
          };

          const newSessions = new Map(prev.sessions);
          newSessions.set(metadata.sessionId, session);

          return {
            ...prev,
            sessions: newSessions,
          };
        });
      } catch (error) {
        if (isSurfaceChangedError(error)) {
          throw error;
        }
        log.warn('Failed to process persisted session metadata', {
          sessionId: metadata?.sessionId,
          error,
        });
      }
    };

    await Promise.all(sessions.map(processSession));
  }

  /**
   * Opt-in archived projection for navigation views. Normal session hydration
   * keeps archived records out of the working set until this is requested.
   */
  public async loadArchivedSessionMetadata(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
  ): Promise<void> {
    const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
    const sessions = await sessionAPI.listArchivedSessions(
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
    );
    await this.processPersistedSessionMetadataList(
      sessions,
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
      undefined,
      true,
    );
  }

  /**
   * Ensure a search/deep-link target has a metadata projection before the
   * canonical session activation flow runs. This deliberately loads one
   * authoritative record instead of teaching callers how to synthesize a
   * FlowChat Session from persistence DTOs.
   */
  public async ensurePersistedSessionMetadata(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
  ): Promise<boolean> {
    if (this.state.sessions.has(sessionId)) {
      return true;
    }

    const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
    const metadata = await sessionAPI.loadSessionMetadata(
      sessionId,
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
    );
    if (!metadata || metadata.status === 'archived') {
      return false;
    }

    await this.processPersistedSessionMetadataList(
      [metadata],
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
    );
    return this.state.sessions.has(sessionId);
  }

  public async loadSessionMetadataPage(
    workspacePath: string,
    limit: number,
    cursor?: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceSource = 'unknown'
  ): Promise<SessionMetadataPage> {
    const requestKey = this.getMetadataPageRequestKey(
      workspacePath,
      limit,
      cursor,
      remoteConnectionId,
      remoteSshHost,
    );
    const existingRequest = this.metadataPageRequests.get(requestKey);
    const remote = isRemoteTraceContext(remoteConnectionId, remoteSshHost);
    if (existingRequest) {
      const completedAtMs = existingRequest.completedAtMs;
      const isRecentCompletedRequest =
        completedAtMs !== undefined &&
        elapsedMs(completedAtMs) <= METADATA_LIST_RECENT_DEDUPE_TTL_MS;

      if (completedAtMs === undefined || isRecentCompletedRequest) {
        startupTrace.markPhase('session_metadata_page_deduped', {
          remote,
          source: traceSource,
          cursor: cursor || null,
          limit,
          dedupeState: completedAtMs === undefined ? 'in-flight' : 'recent',
        });
        return existingRequest.promise;
      }

      if (existingRequest.cleanupTimer) {
        clearTimeout(existingRequest.cleanupTimer);
      }
      this.metadataPageRequests.delete(requestKey);
    }

    const loadPromise = this.loadSessionMetadataPageUncached(
      workspacePath,
      limit,
      cursor,
      remoteConnectionId,
      remoteSshHost,
      traceSource,
    );

    const request: MetadataPageRequest = { promise: loadPromise };
    this.metadataPageRequests.set(requestKey, request);

    loadPromise
      .then(() => {
        const currentRequest = this.metadataPageRequests.get(requestKey);
        if (currentRequest !== request) {
          return;
        }

        request.completedAtMs = nowMs();
        request.cleanupTimer = setTimeout(() => {
          if (this.metadataPageRequests.get(requestKey) === request) {
            this.metadataPageRequests.delete(requestKey);
          }
        }, METADATA_LIST_RECENT_DEDUPE_TTL_MS);
      })
      .catch(() => {
        if (this.metadataPageRequests.get(requestKey) === request) {
          this.metadataPageRequests.delete(requestKey);
        }
      });

    return loadPromise;
  }

  private async loadSessionMetadataPageUncached(
    workspacePath: string,
    limit: number,
    cursor?: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceSource = 'unknown'
  ): Promise<SessionMetadataPage> {
    const activityScope = getActiveSurfaceScope();
    const activityRead = sessionActivityStore.beginRead(activityScope.surfaceId);
    const traceStartedAt = nowMs();
    const remote = isRemoteTraceContext(remoteConnectionId, remoteSshHost);
    const metadataListTraceId = `metadata-page-${Math.random().toString(36).slice(2, 8)}`;
    startupTrace.markPhase('session_metadata_page_start', {
      remote,
      source: traceSource,
      metadataListTraceId,
      cursor: cursor || null,
      limit,
    });

    try {
      const importStartedAt = nowMs();
      startupTrace.markPhase('session_metadata_api_import_start', {
        remote,
        source: traceSource,
        metadataListTraceId,
      });
      const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
      startupTrace.markPhase('session_metadata_api_import_end', {
        remote,
        source: traceSource,
        metadataListTraceId,
        durationMs: elapsedMs(importStartedAt),
      });
      let page: SessionMetadataPage;
      let modelConfigPromise: Promise<{
        models: any[];
        defaultModels: Record<string, string>;
      }> | undefined;
      const pageRequestStartedAt = nowMs();
      try {
        startupTrace.markPhase('session_metadata_page_request_start', {
          remote,
          source: traceSource,
          metadataListTraceId,
          command: 'list_persisted_sessions_page',
        });
        const pagePromise = sessionAPI.listSessionsPage({
          workspacePath,
          limit,
          cursor,
          remoteConnectionId,
          remoteSshHost,
        });
        modelConfigPromise = this.loadSessionMetadataModelConfig();
        page = await pagePromise;
        startupTrace.markPhase('session_metadata_page_request_end', {
          remote,
          source: traceSource,
          metadataListTraceId,
          command: 'list_persisted_sessions_page',
          durationMs: elapsedMs(pageRequestStartedAt),
        });
      } catch (error) {
        if (!isUnsupportedTauriCommandError(error, 'list_persisted_sessions_page')) {
          startupTrace.markPhase('session_metadata_page_request_failed', {
            remote,
            source: traceSource,
            metadataListTraceId,
            command: 'list_persisted_sessions_page',
            durationMs: elapsedMs(pageRequestStartedAt),
          });
          throw error;
        }

        const fallbackStartedAt = nowMs();
        startupTrace.markPhase('session_metadata_page_request_start', {
          remote,
          source: traceSource,
          metadataListTraceId,
          command: 'list_persisted_sessions',
          fallback: true,
        });
        const sessions = await sessionAPI.listSessions(workspacePath, remoteConnectionId, remoteSshHost);
        startupTrace.markPhase('session_metadata_page_request_end', {
          remote,
          source: traceSource,
          metadataListTraceId,
          command: 'list_persisted_sessions',
          fallback: true,
          durationMs: elapsedMs(fallbackStartedAt),
        });
        page = {
          sessions,
          totalTopLevelCount: sessions.length,
          loadedTopLevelCount: sessions.length,
          nextCursor: undefined,
          hasMore: false,
        };
      }

      await this.processPersistedSessionMetadataList(
        page.sessions,
        workspacePath,
        remoteConnectionId,
        remoteSshHost,
        modelConfigPromise,
      );
      if (activityScope.isCurrent() && page.activities) {
        sessionActivityStore.applyRead(activityRead, page.activities);
      }
      startupTrace.markPhase('session_metadata_page_end', {
        remote,
        source: traceSource,
        metadataListTraceId,
        sessionCount: page.sessions.length,
        totalTopLevelCount: page.totalTopLevelCount,
        loadedTopLevelCount: page.loadedTopLevelCount,
        hasMore: page.hasMore,
        durationMs: elapsedMs(traceStartedAt),
      });
      return page;
    } catch (error) {
      startupTrace.markPhase('session_metadata_page_failed', {
        remote,
        source: traceSource,
        metadataListTraceId,
        durationMs: elapsedMs(traceStartedAt),
      });
      if (isSurfaceChangedError(error)) {
        // The page belongs to a device this window no longer renders. Its own
        // container kept whatever landed; abandoning is not a load failure.
        log.debug('Abandoned a session metadata page after a device surface switch', {
          workspacePath,
          source: traceSource,
        });
        throw error;
      }
      log.error('Failed to load persisted session metadata page', error);
      throw error;
    }
  }

  private async initializeFromDiskUncached(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceSource = 'unknown'
  ): Promise<boolean> {
    const traceStartedAt = nowMs();
    const remote = isRemoteTraceContext(remoteConnectionId, remoteSshHost);
    const metadataListTraceId = `metadata-${Math.random().toString(36).slice(2, 8)}`;
    let sessionCount = 0;
    startupTrace.markPhase('session_metadata_list_start', {
      remote,
      source: traceSource,
      metadataListTraceId,
    });
    const scope = getActiveSurfaceScope();
    try {
      const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
      const sessions = await sessionAPI.listSessions(workspacePath, remoteConnectionId, remoteSshHost);
      sessionCount = sessions.length;
      scope.assertCurrent('initializeFromDisk');
      startupTrace.markPhase('session_metadata_list_loaded', {
        remote,
        source: traceSource,
        metadataListTraceId,
        sessionCount,
      });

      const { stateMachineManager } = await import('../state-machine');

      let models: any[] = [];
      let defaultModels: Record<string, string> = {};
      try {
        const { configManager } = await import('@/infrastructure/config/services/ConfigManager');
        const configData = await configManager.getConfigs([
          'ai.models',
          'ai.default_models',
        ]);

        if (Array.isArray(configData['ai.models'])) {
          models = configData['ai.models'];
        }
        if (
          configData['ai.default_models'] &&
          typeof configData['ai.default_models'] === 'object'
        ) {
          defaultModels = configData['ai.default_models'] as Record<string, string>;
        }
      } catch (error) {
        log.warn('Failed to load model config for session metadata, using defaults', { error });
      }

      const processSession = async (metadata: any) => {
        try {
          logPersistedDispatchMetadataOverlap(metadata, 'metadata-list');
          scope.assertCurrent('initializeFromDiskSession');
          const existingSession = this.state.sessions.get(metadata.sessionId);
          if (existingSession) {
            return;
          }
          // Skip archived sessions - they are managed in the settings page
          if (metadata.status === 'archived') {
            return;
          }

          stateMachineManager.getOrCreate(metadata.sessionId);

          let maxContextTokens = 128128;
          if (metadata.modelName) {
            const model = models.find((m: any) => m.name === metadata.modelName || m.id === metadata.modelName);
            if (model?.context_window) {
              maxContextTokens = model.context_window;
            }
          }

          if (maxContextTokens === 128128) {
            const primaryModelId = defaultModels?.primary;

            if (primaryModelId) {
              const primaryModel = models.find((m: any) => m.id === primaryModelId);
              if (primaryModel?.context_window) {
                maxContextTokens = primaryModel.context_window;
              }
            }
          }

          const relationship = deriveSessionRelationshipFromMetadata(metadata);
          const lastFinishedAt = deriveLastFinishedAtFromMetadata(metadata);
          const titleState = deriveSessionTitleStateFromMetadata(metadata);
          const hasDynamicDefaultTitle = titleState.titleSource === 'i18n';
          const remoteScope = persistedSessionRemoteScope(
            metadata,
            remoteConnectionId,
            remoteSshHost,
          );
          const persistedCurrentContextUsage = persistedCurrentContextUsageValue(metadata);

          this.setState(prev => {
            if (!scope.isCurrent() || prev.sessions.has(metadata.sessionId)) {
              return prev;
            }

            const rawAgentType = metadata.agentType || 'Standard';
            const validatedAgentType = isValidPersistedAgentType(rawAgentType) ? rawAgentType : 'Standard';
            const restoredCurrentTokenUsage = isAcpAgentType(validatedAgentType)
              ? undefined
              : deriveRestoredCurrentTokenUsage(persistedCurrentContextUsage);

            if (rawAgentType !== validatedAgentType) {
              log.warn('Invalid agentType, falling back to agentic', { sessionId: metadata.sessionId, rawAgentType, validatedAgentType });
            }

            const session: Session = {
              sessionId: metadata.sessionId,
              title: titleState.title,
              titleSource: titleState.titleSource,
              titleI18nKey: titleState.titleI18nKey,
              titleI18nParams: titleState.titleI18nParams,
              workspaceSessionNumber: titleState.workspaceSessionNumber,
              titleStatus: hasDynamicDefaultTitle ? undefined : 'generated',
              dialogTurns: [],
              status: 'idle',
              persistedStatus: metadata.status,
              config: {
                agentType: validatedAgentType,
                modelName: metadata.modelName,
                workspacePath: metadata.workspacePath || workspacePath,
                projectWorkspacePath: metadata.projectWorkspacePath || workspacePath,
                executionTarget: metadata.executionTarget,
              },
              createdAt: metadata.createdAt,
              lastActiveAt: metadata.lastActiveAt,
              lastFinishedAt,
              error: null,
              isHistorical: true,
              historyState: 'metadata-only',
              todos: (metadata as any).todos || [],
              maxContextTokens,
              currentTokenUsage: restoredCurrentTokenUsage,
              mode: validatedAgentType,
              lastUserDialogMode: metadata.lastUserDialogAgentType,
              lastSubmittedMode: metadata.lastSubmittedAgentType,
              workspacePath: (metadata as any).workspacePath || workspacePath,
              projectWorkspacePath: metadata.projectWorkspacePath || workspacePath,
              remoteConnectionId: remoteScope.remoteConnectionId,
              remoteSshHost: remoteScope.remoteSshHost,
              workspaceHostname: metadata.workspaceHostname,
              parentSessionId: relationship.parentSessionId,
              sessionKind: relationship.sessionKind,
              parentToolCallId: relationship.parentToolCallId,
              subagentType: relationship.subagentType,
              btwThreads: [],
              btwOrigin: relationship.btwOrigin,
              hasUnreadCompletion: metadata.unreadCompletion,
              needsUserAttention: metadata.needsUserAttention,
              deepReviewRunManifest: metadata.deepReviewRunManifest,
              reviewTargetEvidence: metadata.reviewTargetEvidence,
              isTransient: false,
            };

            const newSessions = new Map(prev.sessions);
            newSessions.set(metadata.sessionId, session);

            return {
              ...prev,
              sessions: newSessions,
            };
          });
        } catch (error) {
          if (isSurfaceChangedError(error)) {
            throw error;
          }
          log.warn('Failed to process persisted session metadata', {
            sessionId: metadata?.sessionId,
            error,
          });
        }
      };

      await Promise.all(sessions.map(processSession));
      startupTrace.markPhase('session_metadata_list_end', {
        remote,
        source: traceSource,
        metadataListTraceId,
        sessionCount,
        durationMs: elapsedMs(traceStartedAt),
      });
      return true;
    } catch (error) {
      startupTrace.markPhase('session_metadata_list_failed', {
        remote,
        source: traceSource,
        metadataListTraceId,
        sessionCount,
        durationMs: elapsedMs(traceStartedAt),
      });
      if (isSurfaceChangedError(error)) {
        log.debug('Abandoned a session metadata list after a device surface switch', {
          workspacePath,
          source: traceSource,
        });
        return false;
      }
      log.error('Failed to load persisted sessions', error);
      return false;
    }
  }

  public setSessionHistoryState(sessionId: string, historyState: SessionHistoryState): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || session.historyState === historyState) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        historyState,
      });

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  public setSessionContextRestoreState(
    sessionId: string,
    contextRestoreState: SessionContextRestoreState
  ): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session || session.contextRestoreState === contextRestoreState) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        contextRestoreState,
      });

      return {
        ...prev,
        sessions: newSessions,
      };
    });
  }

  /**
   * Reconcile the active Peer Device session with a small authoritative
   * snapshot from the host.
   *
   * Peer agentic events remain the primary low-latency path. This snapshot is
   * the recovery path for a controller that attached after lifecycle events,
   * or for a DeviceEvent gap (the relay stream has no ACK/replay contract).
   */
  public async refreshPeerSessionSnapshot(
    sessionId: string,
    workspacePath: string,
    options?: {
      requireActiveSession?: boolean;
      shouldApply?: () => boolean;
      shouldReplayRuntimeSnapshot?: (snapshot: SessionRuntimeEventSnapshot) => boolean;
    },
  ): Promise<PeerSessionSnapshotRefreshResult> {
    const scope = getActiveSurfaceScope();
    const interactionEventVersion = liveSessionInteractionStore.captureEventVersion(
      scope.surfaceId,
    );
    const initialSession = this.state.sessions.get(sessionId);
    if (!initialSession) {
      return {
        applied: false,
        backendState: 'Unknown',
      };
    }

    const restored = await agentAPI.restoreSessionView(
      sessionId,
      workspacePath,
      initialSession.remoteConnectionId,
      initialSession.remoteSshHost,
      `peer-refresh-${sessionId.slice(0, 8)}`,
      undefined,
      PEER_SESSION_REFRESH_TAIL_TURN_COUNT,
    );
    // This snapshot describes the device it was read from; reconciling it into
    // the surface that is rendered now would merge two devices' turns.
    scope.assertCurrent('refreshPeerSessionSnapshot');
    if (restored.interactionSnapshot?.sessionId === sessionId) {
      liveSessionInteractionStore.reconcilePermissionSnapshot(
        scope.surfaceId,
        sessionId,
        restored.interactionSnapshot.permissions,
        interactionEventVersion,
      );
    }
    const backendActive = isBackendSessionActivelyProcessing(restored.session.state);
    const persistTailTurnId = restored.turns[restored.turns.length - 1]?.turnId;
    const runtimeEventSnapshot = coerceRuntimeEventSnapshot(
      restored.runtimeEventSnapshot,
      sessionId,
      backendActive,
      persistTailTurnId,
    );
    const activeTurnId = backendActive
      ? runtimeEventSnapshot?.activeTurnId ?? persistTailTurnId
      : undefined;
    const runtimeEventReplayRequired = runtimeEventSnapshot
      ? options?.shouldReplayRuntimeSnapshot?.(runtimeEventSnapshot) ?? true
      : false;
    const runtimeReplaySnapshot = runtimeEventReplayRequired
      ? runtimeEventSnapshot
      : undefined;
    const snapshotTurns = this.convertToDialogTurns(restored.turns, { activeTurnId }).map(turn =>
      runtimeReplaySnapshot && turn.id === runtimeReplaySnapshot.activeTurnId
        ? asRuntimeReplayTurn(turn)
        : turn
    );
    const pendingUserQuestions =
      restored.interactionSnapshot?.sessionId === sessionId
        ? restored.interactionSnapshot.userQuestions
        : undefined;
    let applied = false;
    let pendingQuestionSnapshotApplied = false;

    this.setState(prev => {
      if (
        options?.shouldApply?.() === false ||
        (
          options?.requireActiveSession !== false &&
          prev.activeSessionId !== sessionId
        )
      ) {
        return prev;
      }

      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }
      const persistMergeSafe = session === initialSession;
      // A live event or hydrate won the race while HostInvoke was in flight.
      // Persisted-turn merge is then unsafe, but a required Runtime replay
      // still needs an empty current-Turn shell — hiding the journal used to
      // leave in-progress tool cards frozen.
      if (!persistMergeSafe && !runtimeReplaySnapshot) {
        return prev;
      }

      if (!persistMergeSafe && runtimeReplaySnapshot) {
        const replayTurnId = runtimeReplaySnapshot.activeTurnId;
        if (!replayTurnId) {
          return prev;
        }
        const mergedTurns = [...session.dialogTurns];
        const existingIndex = mergedTurns.findIndex(turn => turn.id === replayTurnId);
        if (existingIndex === -1) {
          const shell = snapshotTurns.find(turn => turn.id === replayTurnId);
          if (!shell) {
            return prev;
          }
          mergedTurns.push(shell);
        } else {
          mergedTurns[existingIndex] = asRuntimeReplayTurn(mergedTurns[existingIndex]);
        }
        const newSessions = new Map(prev.sessions);
        newSessions.set(sessionId, {
          ...session,
          dialogTurns: mergedTurns,
          isHistorical: false,
          historyState: 'ready',
        });
        applied = true;
        return {
          ...prev,
          sessions: newSessions,
        };
      }

      let mergedTurns = [...session.dialogTurns];
      let turnsChanged = false;
      for (const snapshotTurn of snapshotTurns) {
        const existingIndex = mergedTurns.findIndex(turn => turn.id === snapshotTurn.id);
        if (existingIndex === -1) {
          mergedTurns.push(snapshotTurn);
          turnsChanged = true;
        } else if (
          // The Runtime journal replay *is* the runtime writer, so it always
          // establishes its own active Turn.
          runtimeReplaySnapshot && snapshotTurn.id === runtimeReplaySnapshot.activeTurnId
            ? true
            : persistedReadMayReplaceTurn(
                sessionId,
                mergedTurns[existingIndex],
                snapshotTurn,
                activeTurnId,
                Boolean(runtimeEventSnapshot),
              )
        ) {
          mergedTurns[existingIndex] = snapshotTurn;
          turnsChanged = true;
        }
      }

      mergedTurns.sort(compareDialogTurnOrder);
      if (!runtimeReplaySnapshot) {
        const previousQuestionRevision = this.userQuestionSnapshotRevisions.get(sessionId) ?? -1;
        const questionReconciliation = reconcilePendingUserQuestionSnapshot(
          mergedTurns,
          pendingUserQuestions,
          previousQuestionRevision,
        );
        if (questionReconciliation.changed) {
          mergedTurns = questionReconciliation.turns;
          turnsChanged = true;
        }
        if (questionReconciliation.revisionApplied && pendingUserQuestions) {
          pendingQuestionSnapshotApplied = true;
          this.userQuestionSnapshotRevisions.set(
            sessionId,
            pendingUserQuestions.revision,
          );
        }
      }
      const turnCatalog = restored.turnCatalog?.sessionId === sessionId
        ? selectPreferredTurnCatalog(session.turnCatalog, restored.turnCatalog)
        : session.turnCatalog;
      const restoredAgentType =
        restored.session.agentType || session.mode || session.config.agentType;
      const currentTokenUsage = reconcileRestoreViewCurrentTokenUsage(
        session.currentTokenUsage,
        restored.currentContextUsage,
        mergedTurns,
        restoredAgentType,
        snapshotTurns,
      );
      if (
        !turnsChanged
        && turnCatalog === session.turnCatalog
        && restoredAgentType === session.mode
        && currentTokenUsage === session.currentTokenUsage
      ) {
        return prev;
      }

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, {
        ...session,
        dialogTurns: mergedTurns,
        isHistorical: false,
        historyState: 'ready',
        contextRestoreState:
          session.contextRestoreState === 'ready'
            ? 'ready'
            : restored.contextRestoreState,
        isPartial: session.isPartial === true,
        loadedTurnCount: Math.max(session.loadedTurnCount ?? 0, mergedTurns.length),
        totalTurnCount: Math.max(
          session.totalTurnCount ?? 0,
          restored.totalTurnCount ?? restored.session.turnCount,
          mergedTurns.length,
        ),
        turnCatalog,
        config: {
          ...session.config,
          ...(restored.session.modelName
            ? { modelName: restored.session.modelName }
            : {}),
          ...(restored.session.reasoningPreset !== undefined
            ? { reasoningPreset: restored.session.reasoningPreset?.trim() || undefined }
            : {}),
        },
        mode: restoredAgentType,
        lastUserDialogMode:
          restored.session.lastUserDialogAgentType || session.lastUserDialogMode,
        lastSubmittedMode:
          restored.session.lastSubmittedAgentType ?? session.lastSubmittedMode,
        currentTokenUsage,
      });
      applied = true;

      return {
        ...prev,
        sessions: newSessions,
      };
    });

    if (pendingQuestionSnapshotApplied && pendingUserQuestions) {
      askUserQuestionDraftStore.getState().reconcilePendingTools(
        scope.surfaceId,
        sessionId,
        pendingUserQuestions.questions.map(question => question.toolId),
      );
    }

    if (applied) {
      this.seedSessionHistoryLoadedRanges(sessionId, 'initial-tail');
    }

    const latestTurn = snapshotTurns[snapshotTurns.length - 1];
    return {
      applied,
      backendState: restored.session.state,
      latestTurnId: latestTurn?.id,
      latestTurnStatus: latestTurn?.status,
      ...(pendingUserQuestions && scope.isCurrent()
        ? { pendingUserQuestions }
        : {}),
      ...(runtimeEventSnapshot && scope.isCurrent()
        ? {
            runtimeEventSnapshot,
            runtimeEventReplayRequired,
          }
        : {}),
    };
  }

  /**
   * Repair one terminal Turn from the host's canonical persisted record.
   *
   * Runtime chunks are optimized for latency and can be lost while a window is
   * suspended or a Peer controller reconnects. Once the Runtime has settled,
   * persistence owns the Turn, so local and device surfaces both perform this
   * small tail read instead of treating the last painted chunk as complete.
   */
  public async reconcileSettledDialogTurn(
    sessionId: string,
    turnId: string,
  ): Promise<boolean> {
    const scope = getActiveSurfaceScope();
    const initialSession = this.state.sessions.get(sessionId);
    const workspacePath = initialSession
      ? sessionProjectWorkspacePath(initialSession)
      : undefined;
    if (!initialSession || !workspacePath) {
      return false;
    }

    const restored = await agentAPI.restoreSessionView(
      sessionId,
      workspacePath,
      initialSession.remoteConnectionId,
      initialSession.remoteSshHost,
      `settled-turn-${turnId.slice(0, 8)}`,
      initialSession.sessionKind === 'subagent',
      SETTLED_TURN_RECONCILE_TAIL_TURN_COUNT,
    );
    scope.assertCurrent('reconcileSettledDialogTurn');

    const backendActive = isBackendSessionActivelyProcessing(restored.session.state);
    const persistedTailTurnId = restored.turns[restored.turns.length - 1]?.turnId;
    const runtimeSnapshot = coerceRuntimeEventSnapshot(
      restored.runtimeEventSnapshot,
      sessionId,
      backendActive,
      persistedTailTurnId,
    );
    const hostExecutingTurnId = backendActive
      ? runtimeSnapshot?.activeTurnId ?? persistedTailTurnId
      : undefined;
    if (hostExecutingTurnId === turnId) {
      return false;
    }

    const incoming = this.convertToDialogTurns(restored.turns)
      .find(turn => turn.id === turnId);
    if (
      !incoming
      || !['completed', 'cancelled', 'error'].includes(incoming.status)
    ) {
      return false;
    }

    let applied = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }
      const turnIndex = session.dialogTurns.findIndex(turn => turn.id === turnId);
      if (turnIndex < 0) {
        return prev;
      }
      const current = session.dialogTurns[turnIndex];
      const reconciled = preserveClientDerivedDisplayItems(current, incoming);
      if (
        !['completed', 'cancelled', 'error'].includes(current.status)
        || !persistedReadMayReplaceTurn(
          sessionId,
          current,
          reconciled,
          hostExecutingTurnId,
          Boolean(runtimeSnapshot),
        )
      ) {
        return prev;
      }

      const dialogTurns = [...session.dialogTurns];
      dialogTurns[turnIndex] = {
        ...current,
        ...reconciled,
        tokenUsage: reconciled.tokenUsage ?? current.tokenUsage,
        success: reconciled.success ?? current.success,
        finishReason: reconciled.finishReason ?? current.finishReason,
        hasFinalResponse: reconciled.hasFinalResponse ?? current.hasFinalResponse,
      };
      const sessions = new Map(prev.sessions);
      sessions.set(sessionId, {
        ...session,
        dialogTurns,
      });
      applied = true;
      return {
        ...prev,
        sessions,
      };
    });

    return applied;
  }

  /** Empty the current Turn so journal replay cannot overlap a persist checkpoint. */
  public prepareRuntimeTurnReplay(sessionId: string, turnId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }
      const index = session.dialogTurns.findIndex(turn => turn.id === turnId);
      if (index === -1) {
        return prev;
      }
      const dialogTurns = [...session.dialogTurns];
      dialogTurns[index] = asRuntimeReplayTurn(dialogTurns[index]);
      const sessions = new Map(prev.sessions);
      sessions.set(sessionId, {
        ...session,
        dialogTurns,
      });
      return {
        ...prev,
        sessions,
      };
    });
  }

  /** Reconcile blocking user questions after Runtime event replay. */
  public reconcilePendingUserQuestions(
    sessionId: string,
    pendingUserQuestions: PendingUserQuestionSnapshot | undefined,
  ): boolean {
    const surfaceId = getActiveSurfaceId();
    let applied = false;
    let pendingQuestionSnapshotApplied = false;
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }
      const previousRevision = this.userQuestionSnapshotRevisions.get(sessionId) ?? -1;
      const reconciliation = reconcilePendingUserQuestionSnapshot(
        session.dialogTurns,
        pendingUserQuestions,
        previousRevision,
      );
      if (reconciliation.revisionApplied && pendingUserQuestions) {
        pendingQuestionSnapshotApplied = true;
        this.userQuestionSnapshotRevisions.set(sessionId, pendingUserQuestions.revision);
      }
      if (!reconciliation.changed) {
        applied = reconciliation.revisionApplied;
        return prev;
      }
      const sessions = new Map(prev.sessions);
      sessions.set(sessionId, {
        ...session,
        dialogTurns: reconciliation.turns,
      });
      applied = true;
      return { ...prev, sessions };
    });
    if (pendingQuestionSnapshotApplied && pendingUserQuestions) {
      askUserQuestionDraftStore.getState().reconcilePendingTools(
        surfaceId,
        sessionId,
        pendingUserQuestions.questions.map(question => question.toolId),
      );
    }
    return applied;
  }

  /**
   * Lazy load session history (convert historical data to FlowChat format)
   */
  public async loadSessionHistory(
    sessionId: string,
    workspacePath: string,
    limit?: number,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    options?: {
      includeInternal?: boolean;
      deferFullHistoryUntilActive?: boolean;
    }
  ): Promise<void> {
    const traceStartedAt = nowMs();
    const remote = isRemoteTraceContext(remoteConnectionId, remoteSshHost);
    const sessionTraceId = `${sessionId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
    startupTrace.markPhase('historical_session_hydrate_start', {
      remote,
      sessionId,
      sessionTraceId,
    });
    const scope = getActiveSurfaceScope();
    const initialSession = this.state.sessions.get(sessionId);
    const preserveDispatchObserverProjection = (): boolean => {
      const latestSession = this.state.sessions.get(sessionId);
      if (!dispatchObserverOwnsSession(sessionId, latestSession)) {
        return false;
      }

      // If the observer has already bound the target, make its ownership
      // explicit. If only the durable job index is present, leave the metadata
      // placeholder untouched until ensureProjection supplies the full target.
      if (isNonLocalDispatchTarget(latestSession?.config.dispatchTarget)) {
        this.setState(prev => {
          const session = prev.sessions.get(sessionId);
          if (
            !session
            || !isNonLocalDispatchTarget(session.config.dispatchTarget)
          ) {
            return prev;
          }
          const newSessions = new Map(prev.sessions);
          newSessions.set(sessionId, {
            ...session,
            isHistorical: false,
            historyState: 'ready',
            contextRestoreState: 'ready',
            isPartial: false,
            loadedTurnCount: canonicalSessionTurns(session).length,
            totalTurnCount: projectedSessionTurnCount(session),
          });
          return { ...prev, sessions: newSessions };
        });
      }
      return true;
    };
    const finishDispatchObserverSkip = (stage: 'initial' | 'late' | 'failed'): void => {
      startupTrace.markPhase('historical_session_hydrate_end', {
        remote,
        sessionId,
        sessionTraceId,
        skipped: true,
        reason: 'dispatch-observer-owned',
        stage,
        durationMs: elapsedMs(traceStartedAt),
      });
    };
    if (preserveDispatchObserverProjection()) {
      finishDispatchObserverSkip('initial');
      return;
    }
    if (scope.surfaceId !== 'local') {
      this.setSessionHistoryState(sessionId, 'hydrating');
      await this.loadRelaySessionHistory(sessionId);
      scope.assertCurrent('load relay session history');
      return;
    }
    // The caller remains authoritative for legacy and remote sessions. Only a
    // persisted dual-root binding may redirect history storage to the project
    // root; otherwise a stale in-memory execution path can cross workspaces.
    const storageWorkspacePath =
      initialSession?.projectWorkspacePath
      || initialSession?.config.projectWorkspacePath
      || workspacePath;
    const suppressInitialHydratingState =
      !remote &&
      options?.deferFullHistoryUntilActive === true &&
      this.state.activeSessionId === sessionId &&
      initialSession?.isHistorical === true &&
      initialSession.historyState === 'metadata-only';
    let hydratingStateNotified = false;
    const notifyHydratingState = (): void => {
      if (suppressInitialHydratingState) {
        return;
      }
      if (hydratingStateNotified) {
        return;
      }
      hydratingStateNotified = true;
      this.setSessionHistoryState(sessionId, 'hydrating');
    };

    try {
      const existingSession = this.state.sessions.get(sessionId);
      const isAcpSession = existingSession?.mode?.startsWith('acp:') ||
        existingSession?.config.agentType?.startsWith('acp:');
      let turns: DialogTurnData[] | undefined;
      let restoredSessionInfo: AgentSessionInfo | undefined;
      let contextRestoreState: SessionContextRestoreState = 'ready';
      let restoredHistoryPartial = false;
      let restoredLoadedTurnCount: number | undefined;
      let restoredTotalTurnCount: number | undefined;
      let restoredTurnCatalog: SessionTurnCatalog | undefined;
      let restoredTiming: SessionViewRestoreTiming | undefined;
      let restoredCurrentContextUsage: SessionContextUsage | null | undefined;
      let restoredRuntimeEventSnapshot: SessionRuntimeEventSnapshot | undefined;

      const stateMachineManagerPromise = import('../state-machine');
      if (!isAcpSession) {
        const restoreStartedAt = nowMs();
        startupTrace.markPhase('historical_session_restore_start', {
          remote,
          sessionId,
          sessionTraceId,
        });
        try {
          const restoreSessionViewSupportKey = restoreCommandSupportKey(
            'restore_session_view',
            remoteConnectionId,
            remoteSshHost
          );
          const restoreSessionWithTurnsSupportKey = restoreCommandSupportKey(
            'restore_session_with_turns',
            remoteConnectionId,
            remoteSshHost
          );
          const restoreWithTurnsOrSession = async (): Promise<void> => {
            if (
              typeof agentAPI.restoreSessionWithTurns === 'function' &&
              !this.unsupportedRestoreCommands.has(restoreSessionWithTurnsSupportKey)
            ) {
              try {
                const restoredPromise = agentAPI.restoreSessionWithTurns(
                  sessionId,
                  storageWorkspacePath,
                  remoteConnectionId,
                  remoteSshHost,
                  sessionTraceId,
                  options?.includeInternal,
                );
                notifyHydratingState();
                const restored = await restoredPromise;
                restoredSessionInfo = restored.session;
                turns = restored.turns;
                contextRestoreState = 'ready';
                return;
              } catch (error) {
                if (!isUnsupportedTauriCommandError(error, 'restore_session_with_turns')) {
                  throw error;
                }
                this.unsupportedRestoreCommands.add(restoreSessionWithTurnsSupportKey);
                startupTrace.markPhase('historical_session_restore_fallback', {
                  remote,
                  sessionId,
                  sessionTraceId,
                  from: 'restore_session_with_turns',
                  to: 'restore_session',
                  reason: 'unsupported-command',
                });
              }
            }

            const restoredSessionPromise = agentAPI.restoreSession(
              sessionId,
              storageWorkspacePath,
              remoteConnectionId,
              remoteSshHost,
              sessionTraceId,
              options?.includeInternal,
            );
            notifyHydratingState();
            restoredSessionInfo = await restoredSessionPromise;
            contextRestoreState = 'ready';
          };

          if (
            typeof agentAPI.restoreSessionView === 'function' &&
            !this.unsupportedRestoreCommands.has(restoreSessionViewSupportKey)
          ) {
            try {
              const restoredPromise = agentAPI.restoreSessionView(
                sessionId,
                storageWorkspacePath,
                remoteConnectionId,
                remoteSshHost,
                sessionTraceId,
                options?.includeInternal,
                historicalSessionInitialTailTurnCount(remote),
              );
              notifyHydratingState();
              const restored = await restoredPromise;
              restoredSessionInfo = restored.session;
              turns = restored.turns;
              contextRestoreState =
                restored.contextRestoreState === 'ready' ? 'ready' : 'pending';
              restoredHistoryPartial = restored.isPartial === true;
              restoredLoadedTurnCount = restored.loadedTurnCount;
              restoredTotalTurnCount = restored.totalTurnCount;
              restoredTurnCatalog = restored.turnCatalog?.sessionId === sessionId
                ? restored.turnCatalog
                : undefined;
              restoredTiming = restored.timings;
              restoredCurrentContextUsage = restored.currentContextUsage;
              restoredRuntimeEventSnapshot = coerceRuntimeEventSnapshot(
                restored.runtimeEventSnapshot,
                sessionId,
                isBackendSessionActivelyProcessing(restored.session.state),
                restored.turns[restored.turns.length - 1]?.turnId,
              );
            } catch (error) {
              if (!isUnsupportedTauriCommandError(error, 'restore_session_view')) {
                throw error;
              }
              this.unsupportedRestoreCommands.add(restoreSessionViewSupportKey);
              startupTrace.markPhase('historical_session_restore_fallback', {
                remote,
                sessionId,
                sessionTraceId,
                from: 'restore_session_view',
                to: 'restore_session_with_turns',
                reason: 'unsupported-command',
              });
              await restoreWithTurnsOrSession();
            }
          } else {
            await restoreWithTurnsOrSession();
          }
          startupTrace.markPhase('historical_session_restore_end', {
            remote,
            sessionId,
            sessionTraceId,
            turnCount: Array.isArray(turns) ? turns.length : 0,
            loadedTurnCount: restoredLoadedTurnCount,
            totalTurnCount: restoredTotalTurnCount,
            isPartial: restoredHistoryPartial,
            contextRestoreState,
            ...sessionViewRestoreTimingTraceFields(restoredTiming),
            durationMs: elapsedMs(restoreStartedAt),
          });
        } catch (error) {
          if (isSurfaceChangedError(error)) {
            throw error;
          }
          if (isSessionRestoreTransportError(error)) {
            throw error;
          }
          contextRestoreState = 'pending';
          startupTrace.markPhase('historical_session_restore_failed', {
            remote,
            sessionId,
            sessionTraceId,
            durationMs: elapsedMs(restoreStartedAt),
          });
          log.warn('Backend session restore failed (may be new session)', { sessionId, error });
        }
      }
      
      if (!turns) {
        notifyHydratingState();
        const turnsLoadStartedAt = nowMs();
        startupTrace.markPhase('historical_session_turns_load_start', {
          remote,
          sessionId,
          sessionTraceId,
        });
        const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
        turns = await sessionAPI.loadSessionTurns(
          sessionId,
          storageWorkspacePath,
          limit,
          remoteConnectionId,
          remoteSshHost
        );
        startupTrace.markPhase('historical_session_turns_load_end', {
          remote,
          sessionId,
          sessionTraceId,
          turnCount: Array.isArray(turns) ? turns.length : 0,
          durationMs: elapsedMs(turnsLoadStartedAt),
        });
      }
      const stateMachineModule = await stateMachineManagerPromise;
      // Restored turns belong to the device they were read from, and the state
      // machine they are about to drive is shared, so a stale hydrate must stop
      // here rather than commit into whichever surface is rendered now.
      scope.assertCurrent('loadSessionHistory');
      // A local restore may have started just before the observer bound this
      // session. Re-check ownership after every restore await and before any
      // commit or state-machine mutation so that late empty history cannot
      // overwrite a reconstructed dispatch transcript.
      if (preserveDispatchObserverProjection()) {
        finishDispatchObserverSkip('late');
        return;
      }
      const { stateMachineManager, SessionExecutionEvent } = stateMachineModule;
      stateMachineManager.getOrCreate(sessionId);
      startupTrace.markPhase('historical_session_turns_loaded', {
        remote,
        sessionId,
        sessionTraceId,
        turnCount: Array.isArray(turns) ? turns.length : 0,
      });

      const skipStaleLocalHydrateCommit =
        !remote &&
        options?.deferFullHistoryUntilActive === true &&
        this.state.activeSessionId !== sessionId;
      if (skipStaleLocalHydrateCommit) {
        this.setState(prev => {
          const session = prev.sessions.get(sessionId);
          if (!session || prev.activeSessionId === sessionId) {
            return prev;
          }

          const newSessions = new Map(prev.sessions);
          newSessions.set(sessionId, {
            ...session,
            historyState: session.isHistorical ? 'metadata-only' : session.historyState,
          });

          return {
            ...prev,
            sessions: newSessions,
          };
        });
        stateMachineManager.reset(sessionId);
        startupTrace.markPhase('historical_session_hydrate_stale_commit_skipped', {
          remote,
          sessionId,
          sessionTraceId,
          loadedTurnCount: restoredLoadedTurnCount,
          totalTurnCount: restoredTotalTurnCount,
          isPartial: restoredHistoryPartial,
          durationMs: elapsedMs(traceStartedAt),
        });
        recordHistorySessionDiagnosticEvent(sessionId, 'store_stale_commit_skipped', {
          remote,
          loadedTurnCount: restoredLoadedTurnCount,
          totalTurnCount: restoredTotalTurnCount,
          isPartial: restoredHistoryPartial,
        });
        startupTrace.markPhase('historical_session_hydrate_end', {
          remote,
          sessionId,
          sessionTraceId,
          skipped: true,
          loadedTurnCount: restoredLoadedTurnCount,
          totalTurnCount: restoredTotalTurnCount,
          isPartial: restoredHistoryPartial,
          durationMs: elapsedMs(traceStartedAt),
        });
        return;
      }
      
      const convertStartedAt = nowMs();
      const activeTurnId = isBackendSessionActivelyProcessing(restoredSessionInfo?.state)
        ? restoredRuntimeEventSnapshot?.activeTurnId ?? turns[turns.length - 1]?.turnId
        : undefined;
      const dialogTurns = this.convertToDialogTurns(turns, { activeTurnId }).map(turn =>
        restoredRuntimeEventSnapshot && turn.id === activeTurnId
          ? asRuntimeReplayTurn(turn)
          : turn
      );
      const restoredLastUserDialogMode =
        restoredSessionInfo?.lastUserDialogAgentType || this.deriveLastUserDialogMode(dialogTurns);
      startupTrace.markPhase('historical_session_convert_end', {
        remote,
        sessionId,
        sessionTraceId,
        turnCount: dialogTurns.length,
        durationMs: elapsedMs(convertStartedAt),
      });
      
      const stateCommitStartedAt = nowMs();
      this.setState(prev => {
        const session = prev.sessions.get(sessionId);
        if (!session) return prev;

        const restoredAgentType =
          restoredSessionInfo?.agentType || session.mode || session.config.agentType;
        const mergedTurns = dialogTurns.map(loaded => {
          const existing = session.dialogTurns.find(turn => turn.id === loaded.id);
          // Disk hydrate is the persisted record, so the same ownership rule
          // applies: it may not overwrite the Turn the runtime stream owns.
          if (
            existing &&
            !persistedReadMayReplaceTurn(
              sessionId,
              existing,
              loaded,
              activeTurnId,
              Boolean(restoredRuntimeEventSnapshot),
            )
          ) {
            return existing;
          }
          return loaded;
        });

        const updatedSession = {
          ...session,
          dialogTurns: mergedTurns,
          isHistorical: false,
          historyState: 'ready' as const,
          contextRestoreState,
          isPartial: restoredHistoryPartial,
          loadedTurnCount: restoredLoadedTurnCount ?? dialogTurns.length,
          totalTurnCount: restoredTotalTurnCount ?? dialogTurns.length,
          turnCatalog: selectPreferredTurnCatalog(session.turnCatalog, restoredTurnCatalog),
          error: null,
          config: {
            ...session.config,
            ...(restoredSessionInfo?.modelName
              ? { modelName: restoredSessionInfo.modelName }
              : {}),
            ...(restoredSessionInfo?.reasoningPreset !== undefined
              ? { reasoningPreset: restoredSessionInfo.reasoningPreset?.trim() || undefined }
              : {}),
          },
          mode: restoredAgentType,
          lastUserDialogMode: restoredLastUserDialogMode,
          lastSubmittedMode:
            restoredSessionInfo?.lastSubmittedAgentType ?? session.lastSubmittedMode,
          currentTokenUsage: reconcileRestoreViewCurrentTokenUsage(
            session.currentTokenUsage,
            restoredCurrentContextUsage,
            mergedTurns,
            restoredAgentType,
          ),
        };
        
        const newSessions = new Map(prev.sessions);
        newSessions.set(sessionId, updatedSession);
        
        return {
          ...prev,
          sessions: newSessions,
        };
      });
      this.seedSessionHistoryLoadedRanges(sessionId, 'initial-tail');
      startupTrace.markPhase('historical_session_state_commit_end', {
        remote,
        sessionId,
        sessionTraceId,
        turnCount: dialogTurns.length,
        totalTurnCount: restoredTotalTurnCount,
        isPartial: restoredHistoryPartial,
        durationMs: elapsedMs(stateCommitStartedAt),
      });
      recordHistorySessionDiagnosticEvent(sessionId, 'store_state_commit_finished', {
        remote,
        dialogTurnCount: dialogTurns.length,
        totalTurnCount: restoredTotalTurnCount,
        isPartial: restoredHistoryPartial,
      });
      markPhaseAfterAnimationFrames(startupTrace, 'historical_session_after_state_commit_frame', {
        remote,
        sessionId,
        sessionTraceId,
        turnCount: dialogTurns.length,
        totalTurnCount: restoredTotalTurnCount,
        isPartial: restoredHistoryPartial,
        durationMs: elapsedMs(traceStartedAt),
      }, {
        frameCount: 2,
      });
      
      // Historical views normally settle to IDLE. When the same process still
      // owns a live turn (notably a Peer Host), keep the controller state
      // machine aligned so subsequent streamed chunks are accepted even though
      // their DialogTurnStarted event happened before the controller attached.
      // An in-flight Runtime attach already owns that machine; resetting here
      // would drop the journal replay and freeze in-progress tool cards.
      if (!isRuntimeSessionAttachmentInFlight(scope.surfaceId, sessionId)) {
        stateMachineManager.reset(sessionId);
        if (activeTurnId) {
          await stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
            taskId: sessionId,
            dialogTurnId: activeTurnId,
          });
        }
      }
      if (activeTurnId && isSurfaceReconcileEnabled()) {
        const { requestPeerSessionRefresh } = await import(
          '../services/flow-chat-manager/PeerSessionRefreshModule'
        );
        requestPeerSessionRefresh(sessionId);
      }
      completeSessionMutationReconciliation(sessionId);
      startupTrace.markPhase('historical_session_hydrate_end', {
        remote,
        sessionId,
        sessionTraceId,
        turnCount: dialogTurns.length,
        totalTurnCount: restoredTotalTurnCount,
        isPartial: restoredHistoryPartial,
        durationMs: elapsedMs(traceStartedAt),
      });
      if (restoredHistoryPartial) {
        const supportsTurnCatalog = restoredTurnCatalog?.sessionId === sessionId;
        const deferFullHistoryUntilActive =
          !remote &&
          options?.deferFullHistoryUntilActive === true &&
          this.state.activeSessionId !== sessionId;
        if (supportsTurnCatalog) {
          startupTrace.markPhase('historical_session_full_hydrate_skipped', {
            remote,
            sessionId,
            sessionTraceId,
            reason: 'turn-catalog-windowing-available',
            loadedTurnCount: dialogTurns.length,
            totalTurnCount: restoredTotalTurnCount,
          });
        } else if (!deferFullHistoryUntilActive) {
          this.scheduleCompleteSessionHistoryLoad({
            sessionId,
            workspacePath: storageWorkspacePath,
            remoteConnectionId,
            remoteSshHost,
            includeInternal: options?.includeInternal,
            requireActiveSession: options?.deferFullHistoryUntilActive === true,
            initialSessionTraceId: sessionTraceId,
            expectedDialogTurnIds: dialogTurns.map(turn => turn.id),
          });
        } else {
          startupTrace.markPhase('historical_session_full_hydrate_deferred', {
            remote,
            sessionId,
            sessionTraceId,
            reason: 'inactive-after-tail-restore',
            loadedTurnCount: dialogTurns.length,
            totalTurnCount: restoredTotalTurnCount,
          });
        }
      }
    } catch (error) {
      // The same race can fail instead of resolving. Once dispatch owns the
      // session, that stale local failure must not relabel its projection as a
      // failed historical session or surface an irrelevant restore error.
      if (preserveDispatchObserverProjection()) {
        finishDispatchObserverSkip('failed');
        return;
      }
      if (isSurfaceChangedError(error)) {
        // Abandoned, not failed: the session is intact on its own device, and
        // painting `failed` here would do it against another one.
        startupTrace.markPhase('historical_session_hydrate_end', {
          remote,
          sessionId,
          sessionTraceId,
          skipped: true,
          reason: 'device-surface-changed',
          durationMs: elapsedMs(traceStartedAt),
        });
        throw error;
      }
      this.setState(prev => {
        const session = prev.sessions.get(sessionId);
        if (!session) return prev;

        const newSessions = new Map(prev.sessions);
        newSessions.set(sessionId, {
          ...session,
          isHistorical: true,
          historyState: 'failed',
        });

        return {
          ...prev,
          sessions: newSessions,
        };
      });
      startupTrace.markPhase('historical_session_hydrate_failed', {
        remote,
        sessionId,
        sessionTraceId,
        durationMs: elapsedMs(traceStartedAt),
      });
      recordHistorySessionDiagnosticEvent(sessionId, 'store_hydrate_failed', {
        remote,
      });
      log.error('Failed to load session history', { sessionId, error });
      throw error;
    }
  }

  /**
   * Convert DialogTurnData to FlowChat DialogTurn format
   */
  private convertToDialogTurns(
    turns: any[],
    options?: { activeTurnId?: string },
  ): DialogTurn[] {
    return turns.map(turn => {
      const isLiveTurn = options?.activeTurnId === turn.turnId;
      const metadata = turn.userMessage.metadata;
      const metaImages = metadata?.images;
      const hasImages = Array.isArray(metaImages) && metaImages.length > 0;
      const images = hasImages
        ? metaImages.map((img: any) => ({
            id: img.id || img.name || `img-${Date.now()}`,
            name: img.name || 'image',
            dataUrl: img.data_url,
            imagePath: img.image_path,
            mimeType: img.mime_type,
          }))
        : undefined;

      const rawDisplay =
        metadata?.localCommandKind === 'usage_report'
          || metadata?.threadGoalKickoff
          || metadata?.threadGoalObjectiveUpdated
          || metadata?.threadGoalContinuation
          ? turn.userMessage.content
          : metadata?.original_text || cleanRemoteUserInput(turn.userMessage.content);
      const displayContent = resolveThreadGoalUserMessageDisplay(
        rawDisplay,
        metadata as Record<string, unknown> | undefined
      );
      const normalizedTurnStatus = isLiveTurn
        ? normalizeLiveTurnStatus(turn.status)
        : normalizeRecoveredTurnStatus(turn.status, { error: undefined });
      const persistedFinishReason =
        typeof turn.finishReason === 'string'
          ? turn.finishReason
          : typeof turn.finish_reason === 'string'
            ? turn.finish_reason
            : undefined;
      const rawTokenUsage = turn.tokenUsage ?? turn.token_usage;

      return {
      id: turn.turnId,
      sessionId: turn.sessionId,
      kind: turn.kind || 'user_dialog',
      agentType: turn.agentType,
      userMessage: {
        id: turn.userMessage.id,
        type: 'user' as const,
        content: displayContent,
        timestamp: turn.userMessage.timestamp,
        hasImages,
        metadata,
        images,
      },
      modelRounds: turn.modelRounds.map((round: any) => {
        const normalizedRoundStatus = isLiveTurn
          ? normalizeLiveRoundStatus(round.status, normalizedTurnStatus)
          : normalizeRecoveredRoundStatus(round.status, normalizedTurnStatus);
        const flatItems = [
          ...round.textItems.map((text: any) => ({
            id: text.id,
            type: 'text' as const,
            content: text.content,
            isStreaming: isLiveTurn ? text.isStreaming === true : false,
            isMarkdown: text.isMarkdown !== undefined ? text.isMarkdown : true,
            timestamp: text.timestamp,
            status: isLiveTurn
              ? normalizeLiveItemStatus(
                  text.status,
                  text.isStreaming === true ? 'streaming' : 'completed',
                )
              : normalizeRecoveredTextStatus(text.status, normalizedTurnStatus),
            orderIndex: text.orderIndex,
            subagentSessionId: text.subagentSessionId,
            attemptId: text.attemptId,
            attemptIndex: text.attemptIndex,
          })),
          ...round.toolItems.map((tool: any) => ({
              id: tool.id,
              type: 'tool' as const,
              toolName: tool.toolName,
              toolCall: tool.toolCall,
              interruptionReason: normalizePersistedToolInterruptionReason(
                tool.interruptionReason,
                tool.status,
              ),
              toolResult: tool.toolResult,
              aiIntent: tool.aiIntent,
              requiresConfirmation: tool.requiresConfirmation,
              userConfirmed: tool.userConfirmed,
              acpPermission: tool.acpPermission,
              startTime: tool.startTime,
              endTime: tool.endTime,
              durationMs: tool.durationMs,
              queueWaitMs: tool.queueWaitMs,
              preflightMs: tool.preflightMs,
              confirmationWaitMs: tool.confirmationWaitMs,
              executionMs: tool.executionMs,
              timestamp: tool.startTime,
              status: isLiveTurn
                ? tool.toolResult
                  ? (tool.toolResult.success ? 'completed' : 'error')
                  : normalizeLiveItemStatus(tool.status, 'running')
                : normalizeRecoveredToolStatus(
                    tool.status,
                    normalizedTurnStatus,
                    tool.toolResult,
                  ),
              orderIndex: tool.orderIndex,
              subagentSessionId: tool.subagentSessionId,
              subagentDialogTurnId: tool.subagentDialogTurnId,
              subagentModelId: tool.subagentModelId,
              subagentModelDisplayName: tool.subagentModelDisplayName,
              attemptId: tool.attemptId,
              attemptIndex: tool.attemptIndex,
            })),
          ...(round.thinkingItems || []).map((thinking: any) => ({
            id: thinking.id,
            type: 'thinking' as const,
            content: thinking.content,
            isStreaming: isLiveTurn ? thinking.isStreaming === true : false,
            isCollapsed: isLiveTurn
              ? (thinking.isCollapsed ?? thinking.isStreaming !== true)
              : (thinking.isCollapsed ?? true),
            timestamp: thinking.timestamp,
            status: isLiveTurn
              ? normalizeLiveItemStatus(
                  thinking.status,
                  thinking.isStreaming === true ? 'streaming' : 'completed',
                )
              : normalizeRecoveredThinkingStatus(thinking.status, normalizedTurnStatus),
            orderIndex: thinking.orderIndex,
            subagentSessionId: thinking.subagentSessionId,
            attemptId: thinking.attemptId,
            attemptIndex: thinking.attemptIndex,
          })),
        ].sort((a: any, b: any) => {
          const aIndex = a.orderIndex !== undefined ? a.orderIndex : a.timestamp || 0;
          const bIndex = b.orderIndex !== undefined ? b.orderIndex : b.timestamp || 0;
          
          return aIndex - bIndex;
        });

        const hydratedRound = mergeModelRoundAttemptDiagnostics(synchronizeRoundAttempts({
          id: round.id,
          index: round.roundIndex ?? 0,
          roundGroupId: round.roundGroupId,
          renderHints: round.renderHints,
          items: flatItems,
          isStreaming:
            isLiveTurn &&
            (normalizedRoundStatus === 'pending' ||
              normalizedRoundStatus === 'streaming' ||
              normalizedRoundStatus === 'pending_confirmation'),
          isComplete:
            normalizedRoundStatus !== 'pending' &&
            normalizedRoundStatus !== 'streaming' &&
            normalizedRoundStatus !== 'pending_confirmation',
          status: normalizedRoundStatus,
          startTime: round.startTime ?? round.timestamp,
          endTime: round.endTime,
          durationMs: round.durationMs,
          providerId: round.providerId,
          modelConfigId: round.modelConfigId,
          effectiveModelName: round.effectiveModelName,
          firstChunkMs: round.firstChunkMs,
          firstVisibleOutputMs: round.firstVisibleOutputMs,
          streamDurationMs: round.streamDurationMs,
          attemptCount: round.attemptCount,
          attemptDiagnostics: round.attemptDiagnostics,
          failureCategory: round.failureCategory,
          tokenDetails: round.tokenDetails,
        }), round.attemptDiagnostics);

        return hydratedRound;
      }),
      timestamp: turn.timestamp,
      status: normalizedTurnStatus,
      finishReason: isLiveTurn
        ? persistedFinishReason
        : normalizeRecoveredTurnFinishReason(turn.status, persistedFinishReason),
      recovery: turn.recovery,
      recoveryEpoch: turn.recoveryEpoch,
      hasFinalResponse:
        typeof turn.hasFinalResponse === 'boolean'
          ? turn.hasFinalResponse
          : typeof turn.has_final_response === 'boolean'
            ? turn.has_final_response
            : undefined,
      error: typeof turn.error === 'string' ? turn.error : undefined,
      errorDetail: turn.errorDetail ?? turn.error_detail,
      startTime: turn.startTime,
      endTime: turn.endTime,
      tokenUsage: rawTokenUsage
        ? {
            inputTokens: rawTokenUsage.inputTokens ?? rawTokenUsage.input_tokens,
            outputTokens: rawTokenUsage.outputTokens ?? rawTokenUsage.output_tokens,
            totalTokens: rawTokenUsage.totalTokens ?? rawTokenUsage.total_tokens,
            timestamp: rawTokenUsage.timestamp,
          }
        : undefined,
      storageTurnIndex: turn.turnIndex,
      backendTurnIndex: turn.turnIndex,
    };
    });
  }

  public setDialogTurnTodos(sessionId: string, turnId: string, todos: import('../types/flow-chat').TodoItem[]): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        log.warn('Session not found, cannot set turn todos', { sessionId, turnId });
        return prev;
      }

      const turnIndex = session.dialogTurns.findIndex(turn => turn.id === turnId);
      if (turnIndex === -1) {
        log.warn('Dialog turn not found, cannot set turn todos', { sessionId, turnId });
        return prev;
      }

      const updatedTurns = [...session.dialogTurns];
      updatedTurns[turnIndex] = {
        ...updatedTurns[turnIndex],
        todos: [...todos]
      };

      const updatedSession = {
        ...session,
        dialogTurns: updatedTurns,
        lastActiveAt: Date.now()
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  public getDialogTurnTodos(sessionId: string, turnId: string): import('../types/flow-chat').TodoItem[] {
    const session = this.state.sessions.get(sessionId);
    if (!session) return [];

    const turn = session.dialogTurns.find(t => t.id === turnId);
    return turn?.todos || [];
  }
  
  public deleteTodo(sessionId: string, todoId: string): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        log.warn('Session not found, cannot delete todo', { sessionId, todoId });
        return prev;
      }

      const todos = session.todos || [];
      const updatedTodos = todos.filter(t => t.id !== todoId);

      const updatedSession = {
        ...session,
        todos: updatedTodos,
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }

  /**
   * Get all todo items for session (aggregates todos from all DialogTurns)
   * Mainly used by PlannerPanel to display overall progress
   */
  public getTodos(sessionId: string): import('../types/flow-chat').TodoItem[] {
    const session = this.state.sessions.get(sessionId);
    if (!session) return [];
    
    const allTodos: import('../types/flow-chat').TodoItem[] = [];
    session.dialogTurns.forEach(turn => {
      if (turn.todos && turn.todos.length > 0) {
        allTodos.push(...turn.todos);
      }
    });
    
    if (session.todos && session.todos.length > 0) {
      allTodos.push(...session.todos);
    }
    
    return allTodos;
  }

  public setTodos(sessionId: string, todos: import('../types/flow-chat').TodoItem[]): void {
    this.setState(prev => {
      const session = prev.sessions.get(sessionId);
      if (!session) {
        return prev;
      }

      const updatedSession = {
        ...session,
        todos: [...todos],
      };

      const newSessions = new Map(prev.sessions);
      newSessions.set(sessionId, updatedSession);

      return {
        ...prev,
        sessions: newSessions
      };
    });
  }
}

export const flowChatStore = FlowChatStore.getInstance();
