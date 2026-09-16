import { translateAgentIdentityFields } from '../../../../../shared/agent-harness/wire';
 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  DialogTurnData,
  ModelRoundAttemptDiagnostic,
  SessionContextUsage,
  SessionRelationship,
  SessionTurnCatalog,
} from '@/shared/types/session-history';
import type { ImageContextData as ImageInputContextData } from './ImageContextTypes';
import type { AgentSource } from './CustomAgentAPI';
import type {
  ReviewTargetEvidence,
  ReviewTeamRunManifest,
} from '@/shared/services/reviewTeamService';
import type {
  SessionExecutionTarget,
  SessionExecutionTargetRequest,
} from './WorktreeAPI';
import { toWorktreeCommandError } from './WorktreeAPI';



export interface SessionTitleGeneratedEvent {
  sessionId: string;
  title: string;
  method: 'ai' | 'fallback';
  timestamp: number;
}

export interface SessionModelFallbackAppliedEvent {
  sessionId: string;
  previousModelId: string;
  newModelId: string;
  reason: string;
}

export interface SessionReasoningPresetAutoClearedEvent {
  sessionId: string;
  previousPresetId: string;
  reason: string;
}

 
export interface SessionConfig {
  modelName?: string;
  reasoningPreset?: string;
  maxContextTokens?: number;
  autoCompact?: boolean;
  enableTools?: boolean;
  safeMode?: boolean;
  maxTurns?: number;
  enableContextCompression?: boolean;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

 
export interface CreateSessionRequest {
  sessionId?: string; 
  sessionName: string;
  agentType: string;
  workspacePath: string;
  projectWorkspacePath?: string;
  executionTarget?: SessionExecutionTargetRequest;
  requestId?: string;
  workspaceId?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  sessionKind?: 'standard' | 'subagent';
  relationship?: SessionRelationship;
  deepReviewRunManifest?: ReviewTeamRunManifest;
  reviewTargetEvidence?: ReviewTargetEvidence;
  config?: SessionConfig;
}

 
export interface CreateSessionResponse {
  sessionId: string;
  sessionName: string;
  agentType: string;
  modelId?: string;
  workspacePath?: string;
  workspaceId?: string;
  projectWorkspacePath?: string;
  executionTarget?: SessionExecutionTarget;
}

 
export interface StartDialogTurnRequest {
  sessionId: string;
  userInput: string;
  originalUserInput?: string;
  turnId?: string; 
  execution?: AgentDialogTurnExecution;
  agentType: string; 
  /** Concrete root where this session executes. */
  workspacePath?: string;
  /** Stable project root used to locate persistence for worktree sessions. */
  projectWorkspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  /** Optional multimodal image contexts (snake_case fields, aligned with backend ImageContextData). */
  imageContexts?: ImageInputContextData[];
  userMessageMetadata?: Record<string, unknown>;
}

export type AgentDialogTurnExecution =
  | { kind: 'standard' }
  | {
      kind: 'fresh_external_subagent';
      ecosystemId: string;
      logicalId: string;
    };

export interface StartDialogTurnResponse {
  success: boolean;
  message: string;
}

export type PermissionReplyKind = 'once' | 'always' | 'reject';

export interface PermissionRequestSource {
  kind: 'tool_call' | 'provider' | 'extension';
  identity: string;
}

export interface PermissionDelegationContext {
  parentSessionId: string;
  parentDialogTurnId?: string;
  parentToolCallId: string;
  subagentType: string;
}

export interface PermissionRequest {
  requestId: string;
  /** Model round that owns this permission request. */
  roundId: string;
  /** Stable permission order within the model round. */
  order: number;
  /** Provider/tool-stream call ID for correlating one concrete tool card. */
  toolCallId?: string;
  /** User-presentable workspace root; distinct from the stable project ID. */
  projectPath?: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  action: string;
  resources: string[];
  saveResources?: string[];
  source: PermissionRequestSource;
  delegation?: PermissionDelegationContext;
  displayMetadata?: Record<string, unknown>;
}

export interface PendingUserQuestion {
  toolId: string;
  sessionId: string;
  dialogTurnId?: string;
  modelRoundId?: string;
  questions: unknown;
  registeredAtMs: number;
  interactionStarted?: boolean;
}

export interface PendingUserQuestionSnapshot {
  revision: number;
  questions: PendingUserQuestion[];
}

export interface PermissionRequestSnapshot {
  revision: number;
  requests: PermissionRequest[];
}

/**
 * Runtime-owned blocking interactions required to re-attach a UI Surface to
 * a Session after push events were missed while another device was rendered.
 */
export interface SessionInteractionSnapshot {
  sessionId: string;
  userQuestions: PendingUserQuestionSnapshot;
  permissions: PermissionRequestSnapshot;
}

export interface RuntimeProjectedAgenticEvent {
  eventName: string;
  payload: Record<string, unknown>;
}

/**
 * Runtime-owned materialized projection of the current Turn. `streamId` and
 * `cursor` fence this snapshot against concurrent live events.
 */
export interface SessionRuntimeEventSnapshot {
  sessionId: string;
  streamId: string;
  cursor: number;
  activeTurnId?: string | null;
  events: RuntimeProjectedAgenticEvent[];
}

/**
 * Everything this client missed after the cursor it already applied.
 *
 * `delta` is contiguous: apply the events in order and the projection is
 * repaired in place. `snapshotRequired` means the Host cannot prove
 * contiguity — the cursor aged out of its replay window, it belongs to an
 * older Runtime process, or the Host keeps no journal at all.
 */
export type SessionEventBackfill =
  | {
      kind: 'delta';
      streamId: string;
      cursor: number;
      events: RuntimeProjectedAgenticEvent[];
      /**
       * Replaying events rebuilds a blocking interaction's card; only the
       * mailbox makes it answerable.
       */
      interactionSnapshot?: SessionInteractionSnapshot | null;
    }
  | { kind: 'snapshotRequired' };

export type PermissionRequestEvent =
  | { event: 'asked'; request: PermissionRequest }
  | { event: 'replied'; requestId: string; reply: { reply: PermissionReplyKind }; source: string }
  | { event: 'cancelled'; requestId: string; reason: string };

export interface CompactSessionRequest {
  sessionId: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

 
export interface SessionInfo {
  sessionId: string;
  /** Current/default mode selection for the next dialog turn. */
  sessionName: string;
  agentType: string;
  /** Current/default model selection for the next dialog turn. */
  modelName?: string;
  reasoningPreset?: string | null;
  /** Mode of the last surviving user dialog turn in session history. */
  lastUserDialogAgentType?: string;
  /** Mode of the most recent user submission accepted by the runtime. */
  lastSubmittedAgentType?: string;
  state: string;
  turnCount: number;
  createdAt: number;
}

export type SessionMemoryMode = 'enabled' | 'disabled' | 'polluted';

export interface SetSessionMemoryModeRequest {
  sessionId: string;
  mode: Exclude<SessionMemoryMode, 'polluted'>;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface SetSessionMemoryModeResponse {
  success: boolean;
  mode: SessionMemoryMode;
}

export interface ResetMemoryResponse {
  success: boolean;
}

export interface MemoryPathsResponse {
  memoriesRootDir: string;
}

export interface RestoreSessionWithTurnsResponse {
  session: SessionInfo;
  turns: DialogTurnData[];
}

export interface SessionTurnLoadTiming {
  requestedTailTurnCount?: number;
  loadedTurnCount: number;
  totalTurnCount: number;
  turnFileCount: number;
  missingTurnFileCount: number;
  fastPath: boolean;
  metadataDurationMs: number;
  stateDurationMs: number;
  scanDurationMs: number;
  readDurationMs: number;
  maxTurnReadDurationMs: number;
  buildSessionDurationMs: number;
  totalDurationMs: number;
}

export interface SessionViewRestoreTiming {
  resolveStoragePathDurationMs: number;
  visibilityMetadataDurationMs: number;
  loadSessionWithTurnsDurationMs: number;
  normalizeTurnIdsDurationMs: number;
  turnCatalogDurationMs?: number;
  totalDurationMs: number;
  turnLoad: SessionTurnLoadTiming;
}

export interface RestoreSessionViewResponse {
  session: SessionInfo;
  turns: DialogTurnData[];
  /** Absent when talking to an older Peer Host. */
  interactionSnapshot?: SessionInteractionSnapshot;
  /** Absent when talking to a host without resumable Session attachment. */
  runtimeEventSnapshot?: SessionRuntimeEventSnapshot | null;
  currentContextUsage?: SessionContextUsage | null;
  turnCatalog?: SessionTurnCatalog;
  contextRestoreState: 'ready' | 'pending';
  isPartial?: boolean;
  loadedTurnCount?: number;
  totalTurnCount?: number;
  timings?: SessionViewRestoreTiming;
}

export interface LoadSessionTurnWindowRequest {
  sessionId: string;
  workspacePath: string;
  includeInternal?: boolean;
  targetStorageTurnIndex: number;
  expectedTurnId?: string;
  expectedCatalogRevision?: string;
  before?: number;
  after?: number;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export type LoadSessionTurnWindowResponse =
  | {
      status: 'ready';
      catalogRevision: string;
      totalTurnCount: number;
      startOrdinal: number;
      endOrdinalExclusive: number;
      targetTurnId: string;
      turns: DialogTurnData[];
    }
  | {
      status: 'stale';
      catalog: SessionTurnCatalog;
    }
  | {
      status: 'not-found';
      catalog: SessionTurnCatalog;
    };

export interface RollbackSessionToTurnRequest {
  workspacePath: string;
  workspaceId?: string;
  workspaceHostname?: string;
  sessionId: string;
  targetTurnId: string;
  expectedStorageTurnIndex?: number;
  expectedCatalogRevision?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export type RollbackSessionToTurnOutcome =
  | {
      status: 'completed';
      sessionId: string;
      transcript: unknown;
      composer: { kind: 'preserve' } | { kind: 'clear' } | { kind: 'replace'; text: string };
      retiredTurnIds: string[];
      changed: boolean;
      hiddenTurnCount: number;
      boundaryStorageTurnIndex?: number;
      targetTurnId?: string;
      restoredFiles: string[];
      reloadRequired?: boolean;
      reloadReason?: string;
    }
  | {
      status: 'recovery_required';
      sessionId: string;
      mutationId: string;
      affectedFiles: string[];
      reason: string;
    };

type RollbackSessionToTurnCompletedOutcome = Extract<
  RollbackSessionToTurnOutcome,
  { status: 'completed' }
>;
type RollbackSessionToTurnRecoveryOutcome = Extract<
  RollbackSessionToTurnOutcome,
  { status: 'recovery_required' }
>;
type RollbackSessionToTurnWireOutcome =
  | (Omit<RollbackSessionToTurnCompletedOutcome, 'retiredTurnIds' | 'restoredFiles'> & {
      retiredTurnIds?: string[];
      restoredFiles?: string[];
    })
  | (Omit<RollbackSessionToTurnRecoveryOutcome, 'affectedFiles'> & {
      affectedFiles?: string[];
    });

export interface EnsureAssistantBootstrapRequest {
  sessionId: string;
  workspacePath: string;
}

export interface RunInitAgentsMdRequest {
  sessionId: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export type EnsureAssistantBootstrapStatus = 'started' | 'skipped' | 'blocked';

export type EnsureAssistantBootstrapReason =
  | 'bootstrap_started'
  | 'bootstrap_not_required'
  | 'session_has_existing_turns'
  | 'session_not_idle'
  | 'model_unavailable';

export interface EnsureAssistantBootstrapResponse {
  status: EnsureAssistantBootstrapStatus;
  reason: EnsureAssistantBootstrapReason;
  sessionId: string;
  turnId?: string;
  detail?: string;
}

export interface UpdateSessionModelRequest {
  sessionId: string;
  modelName: string;
  reasoningPreset?: string | null;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
}

/** `ask` | `auto_approve` | `full_access`; `null` clears the session override. */
export type SessionPermissionMode = 'ask' | 'auto_approve' | 'full_access';

export interface SessionPermissionModeRequest {
  sessionId: string;
  /** Omit or pass null to clear the override and follow the global default. */
  mode?: SessionPermissionMode | null;
  /** Exact active turn whose temporary override should be read or cleared. */
  turnId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
}

export interface SessionPermissionModeResponse {
  mode: SessionPermissionMode | null;
  turnMode?: SessionPermissionMode | null;
  activeTurnId?: string | null;
}

export interface ActiveTurnPermissionModeRequest extends SessionPermissionModeRequest {
  turnId: string;
}

export interface UpdateSessionModeRequest {
  sessionId: string;
  modeId: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
}

export type AgentContextReloadTarget = 'all' | 'skills' | 'instructions';

export interface AgentContextReloadRequest {
  sessionId: string;
  target: AgentContextReloadTarget;
}

export interface UpdateSessionTitleRequest {
  sessionId: string;
  title: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface ControlBackgroundCommandRequest {
  execSessionId: number;
  action: 'interrupt' | 'kill';
  remote: boolean;
}

export interface SendBackgroundCommandInputRequest {
  execSessionId: number;
  remote: boolean;
  chars: string;
  appendEnter: boolean;
}

export type BackgroundCommandOutputStatus =
  | 'running'
  | 'exited'
  | 'interrupted'
  | 'killed'
  | 'pruned'
  | 'failed';

export interface BackgroundCommandOutputMetadata {
  agentSessionId?: string;
  execSessionId?: number;
  command: string;
  workdir?: string;
  remote: boolean;
  tty: boolean;
  /** Missing on legacy hosts (fixed 80x24); null explicitly means unknown. */
  terminalSize?: { cols: number; rows: number } | null;
  status: BackgroundCommandOutputStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  retainedBytes: number;
  retainedLimitBytes: number;
  truncatedFromStart: boolean;
}

export interface ReadBackgroundCommandOutputRequest {
  execSessionId: number;
  remote: boolean;
  cursor?: number;
}

export interface ReadBackgroundCommandOutputResponse {
  metadata: BackgroundCommandOutputMetadata;
  cursor: number;
  reset: boolean;
  snapshot?: string;
  chunks: string[];
}

export interface ListBackgroundCommandActivitiesRequest {
  agentSessionId?: string;
}

export interface ListBackgroundCommandActivitiesResponse {
  activities: BackgroundCommandOutputMetadata[];
}

 
export interface ModeInfo {
  id: string;
  name: string;
  description: string;
  isReadonly: boolean;
  toolCount: number;
  defaultTools?: string[];
  /**
   * Combined prompt-cache compatibility key for mode-switch guards. Modes that
   * share the same key can reuse the same session-level prompt cache.
   */
  promptCacheScopeKey: string;
  configProfileId: string;
  configProfileLabel?: string;
  configProfileMemberModeIds: string[];
  source: AgentSource;
  path?: string;
  model?: string;
}



export interface SubagentParentInfo {
  toolCallId: string;
  sessionId: string;
  dialogTurnId: string;
}

export interface AgenticEvent {
  sessionId: string;
  turnId?: string;
  [key: string]: any;
}

export interface InterruptedDialogTurnEvent extends AgenticEvent {
  turnId: string;
  executionGeneration: number;
  modelId?: string;
}

export interface RecoverInterruptedDialogTurnRequest {
  sessionId: string;
  dialogTurnId: string;
  executionGeneration: number;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface RecoverInterruptedDialogTurnResponse {
  sessionId: string;
  turnId: string;
  executionGeneration: number;
}

export type DialogTurnStartedEvent = AgenticEvent;

export interface OpenBuiltInBrowserEvent {
  requestId?: string;
  url: string;
  title?: string;
  replaceExisting?: boolean;
}

export interface TextChunkEvent extends AgenticEvent {
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  text: string;
  contentType?: 'text' | 'thinking';
  isThinkingEnd?: boolean;
}

export interface ToolEvent extends AgenticEvent {
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  toolEvent: any;
}

export interface SubagentSessionLinkedEvent extends AgenticEvent {
  subagentDialogTurnId?: string;
  parentSessionId: string;
  parentDialogTurnId: string;
  parentToolCallId: string;
  agentType?: string;
  modelId?: string;
  focusedReviewDisplayLabel?: string;
}

export type DeepReviewQueueStatus =
  | 'queued_for_capacity'
  | 'paused_by_user'
  | 'running'
  | 'capacity_skipped';

export type DeepReviewQueueReason =
  | 'provider_rate_limit'
  | 'provider_concurrency_limit'
  | 'retry_after'
  | 'local_concurrency_cap'
  | 'launch_batch_blocked'
  | 'temporary_overload';

export interface DeepReviewQueueStateEventData {
  toolId: string;
  subagentType: string;
  status: DeepReviewQueueStatus;
  reason?: DeepReviewQueueReason;
  queuedReviewerCount: number;
  activeReviewerCount?: number;
  effectiveParallelInstances?: number;
  optionalReviewerCount?: number;
  queueElapsedMs?: number;
  runElapsedMs?: number;
  maxQueueWaitSeconds?: number;
  sessionConcurrencyHigh?: boolean;
}

export interface DeepReviewQueueStateChangedEvent extends AgenticEvent {
  queueState: DeepReviewQueueStateEventData;
}

export type DeepReviewQueueControlAction =
  | 'pause'
  | 'continue'
  | 'cancel'
  | 'skip_optional';

export interface DeepReviewQueueControlRequest {
  sessionId: string;
  dialogTurnId: string;
  toolId: string;
  action: DeepReviewQueueControlAction;
}

 
export interface ImageAnalysisEvent extends AgenticEvent {
  imageCount?: number;
  userInput?: string;
  success?: boolean;
  durationMs?: number;
}

export interface UserSteeringInjectedEvent extends AgenticEvent {
  turnId: string;
  roundIndex: number;
  steeringId: string;
  content: string;
  displayContent: string;
}

export interface ModelRoundCompletedEvent extends AgenticEvent {
  turnId: string;
  roundId: string;
  hasToolCalls?: boolean;
  durationMs?: number;
  providerId?: string;
  /** Resolved AI model configuration ID. */
  modelConfigId?: string;
  /** Provider model name sent on the request. */
  effectiveModelName?: string;
  firstChunkMs?: number;
  firstVisibleOutputMs?: number;
  streamDurationMs?: number;
  attemptCount?: number;
  failureCategory?: string;
  tokenDetails?: unknown;
}

export interface ModelRoundAttemptSupersededEvent extends AgenticEvent {
  turnId: string;
  roundId: string;
  diagnostic: ModelRoundAttemptDiagnostic;
}

export interface ModelRoundStartedEvent extends AgenticEvent {
  turnId: string;
  roundId: string;
  roundGroupId?: string;
  roundIndex: number;
  /** Resolved AI model configuration ID. */
  modelConfigId?: string;
  /** Provider model name sent on the request. */
  effectiveModelName?: string;
}

export interface AcpContextUsageUpdatedEvent extends AgenticEvent {
  clientId?: string;
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
}

export interface CompressionEvent extends AgenticEvent {
  compressionId: string;          
  
  trigger?: string;                // "auto" | "manual" | "user_message"
  tokensBefore?: number;           
  contextWindow?: number;          
  
  compressionCount?: number;       
  tokensAfter?: number;            
  compressionRatio?: number;       
  durationMs?: number;             
  hasSummary?: boolean;            
  summarySource?: 'model' | 'local_fallback' | 'none';
  
  error?: string;                  
}



export class AgentAPI {
  
  

  

   
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    try {
      return await api.invoke<CreateSessionResponse>('create_session', { request });
    } catch (error) {
      if (request.executionTarget && request.executionTarget.kind !== 'local') {
        throw toWorktreeCommandError(error);
      }
      throw createTauriCommandError('create_session', error, request);
    }
  }

   
  async startDialogTurn(request: StartDialogTurnRequest): Promise<{ success: boolean; message: string }> {
    try {
      return await api.invoke<{ success: boolean; message: string }>('start_dialog_turn', { request });
    } catch (error) {
      throw createTauriCommandError('start_dialog_turn', error, request);
    }
  }

  async compactSession(request: CompactSessionRequest): Promise<{ success: boolean; message: string }> {
    try {
      return await api.invoke<{ success: boolean; message: string }>('compact_session', { request });
    } catch (error) {
      throw createTauriCommandError('compact_session', error, request);
    }
  }

  async activateSessionGoal(request: {
    sessionId: string;
    userHint?: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<{
    success: boolean;
    goal: {
      goalId: string;
      sessionId: string;
      objective: string;
      status: string;
      tokenBudget?: number | null;
      tokensUsed: number;
      timeUsedSeconds: number;
      createdAt: number;
      updatedAt: number;
    };
  }> {
    try {
      return await api.invoke('activate_session_goal', { request });
    } catch (error) {
      throw createTauriCommandError('activate_session_goal', error, request);
    }
  }

  async getSessionThreadGoal(request: {
    sessionId: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<{
    goal: {
      goalId: string;
      sessionId: string;
      objective: string;
      status: string;
      tokenBudget?: number | null;
      tokensUsed: number;
      timeUsedSeconds: number;
      createdAt: number;
      updatedAt: number;
    } | null;
  }> {
    try {
      return await api.invoke('get_session_thread_goal', { request });
    } catch (error) {
      throw createTauriCommandError('get_session_thread_goal', error, request);
    }
  }

  async clearSessionThreadGoal(request: {
    sessionId: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<void> {
    try {
      await api.invoke('clear_session_thread_goal', { request });
    } catch (error) {
      throw createTauriCommandError('clear_session_thread_goal', error, request);
    }
  }

  async setSessionThreadGoalStatus(request: {
    sessionId: string;
    status: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<{
    goalId: string;
    sessionId: string;
    objective: string;
    status: string;
    tokenBudget?: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  }> {
    try {
      return await api.invoke('set_session_thread_goal_status', { request });
    } catch (error) {
      throw createTauriCommandError('set_session_thread_goal_status', error, request);
    }
  }

  async updateSessionThreadGoalObjective(request: {
    sessionId: string;
    objective: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<{
    goalId: string;
    sessionId: string;
    objective: string;
    status: string;
    tokenBudget?: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  }> {
    try {
      return await api.invoke('update_session_thread_goal_objective', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_thread_goal_objective', error, request);
    }
  }

  async ensureAssistantBootstrap(
    request: EnsureAssistantBootstrapRequest
  ): Promise<EnsureAssistantBootstrapResponse> {
    try {
      return await api.invoke<EnsureAssistantBootstrapResponse>('ensure_assistant_bootstrap', {
        request
      });
    } catch (error) {
      throw createTauriCommandError('ensure_assistant_bootstrap', error, request);
    }
  }

  async runInitAgentsMd(
    request: RunInitAgentsMdRequest
  ): Promise<StartDialogTurnResponse> {
    try {
      return await api.invoke<StartDialogTurnResponse>('run_init_agents_md', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('run_init_agents_md', error, request);
    }
  }

   
  async cancelDialogTurn(sessionId: string, dialogTurnId: string): Promise<void> {
    try {
      await api.invoke<void>('cancel_dialog_turn', { request: { sessionId, dialogTurnId } });
    } catch (error) {
      throw createTauriCommandError('cancel_dialog_turn', error, { sessionId, dialogTurnId });
    }
  }

  async interruptDialogTurn(sessionId: string, dialogTurnId: string): Promise<void> {
    try {
      await api.invoke<void>('interrupt_dialog_turn', { request: { sessionId, dialogTurnId } });
    } catch (error) {
      throw createTauriCommandError('interrupt_dialog_turn', error, { sessionId, dialogTurnId });
    }
  }

  async recoverInterruptedDialogTurn(
    request: RecoverInterruptedDialogTurnRequest,
  ): Promise<RecoverInterruptedDialogTurnResponse> {
    try {
      return await api.invoke<RecoverInterruptedDialogTurnResponse>(
        'recover_interrupted_dialog_turn',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('recover_interrupted_dialog_turn', error, request);
    }
  }

  /**
   * Inject a user "steering" message into the currently running dialog turn.
   * Mirrors Codex CLI's Esc-to-steer behavior: the message is queued on the
   * Rust side and consumed by the execution engine at the next round boundary
   * without ending the current turn.
   *
   * Carries the same payload a turn submission does — attachments and message
   * metadata included — so a message keeps its content whether it is sent at a
   * turn boundary or injected into a running turn.
   */
  async steerDialogTurn(request: {
    sessionId: string;
    dialogTurnId: string;
    content: string;
    displayContent?: string;
    imageContexts?: unknown[];
    userMessageMetadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; steeringId: string }> {
    try {
      return await api.invoke<{ success: boolean; steeringId: string }>(
        'steer_dialog_turn',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('steer_dialog_turn', error, request);
    }
  }

  async controlDeepReviewQueue(request: DeepReviewQueueControlRequest): Promise<void> {
    try {
      await api.invoke<void>('control_deep_review_queue', { request });
    } catch (error) {
      throw createTauriCommandError('control_deep_review_queue', error, request);
    }
  }

   
  async deleteSession(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<void> {
    try {
      await api.invoke<void>('delete_session', { 
        request: { sessionId, workspacePath, remoteConnectionId, remoteSshHost } 
      });
    } catch (error) {
      throw createTauriCommandError('delete_session', error, { sessionId, workspacePath });
    }
  }

   
  async restoreSession(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceId?: string,
    includeInternal?: boolean,
  ): Promise<SessionInfo> {
    try {
      return await api.invoke<SessionInfo>('restore_session', {
        request: {
          sessionId,
          workspacePath,
          remoteConnectionId,
          remoteSshHost,
          traceId,
          includeInternal,
        },
      });
    } catch (error) {
      throw createTauriCommandError('restore_session', error, { sessionId, workspacePath });
    }
  }

  async restoreSessionWithTurns(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceId?: string,
    includeInternal?: boolean,
  ): Promise<RestoreSessionWithTurnsResponse> {
    try {
      return await api.invoke<RestoreSessionWithTurnsResponse>('restore_session_with_turns', {
        request: {
          sessionId,
          workspacePath,
          remoteConnectionId,
          remoteSshHost,
          traceId,
          includeInternal,
        },
      });
    } catch (error) {
      throw createTauriCommandError('restore_session_with_turns', error, { sessionId, workspacePath });
    }
  }

  async getSessionInteractionMailbox(sessionId: string): Promise<SessionInteractionSnapshot> {
    return api.invoke<SessionInteractionSnapshot>('get_session_interaction_mailbox', { request: { sessionId } });
  }

  async restoreSessionView(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string,
    traceId?: string,
    includeInternal?: boolean,
    tailTurnCount?: number,
  ): Promise<RestoreSessionViewResponse> {
    try {
      return await api.invoke<RestoreSessionViewResponse>('restore_session_view', {
        request: {
          sessionId,
          workspacePath,
          remoteConnectionId,
          remoteSshHost,
          traceId,
          includeInternal,
          ...(tailTurnCount !== undefined ? { tailTurnCount } : {}),
        },
      });
    } catch (error) {
      throw createTauriCommandError('restore_session_view', error, { sessionId, workspacePath });
    }
  }

  async loadSessionEventBackfill(
    sessionId: string,
    streamId: string,
    cursor: number,
  ): Promise<SessionEventBackfill> {
    try {
      return await api.invoke<SessionEventBackfill>('load_session_event_backfill', {
        request: { sessionId, streamId, cursor },
      });
    } catch (error) {
      throw createTauriCommandError('load_session_event_backfill', error, {
        sessionId,
        streamId,
        cursor,
      });
    }
  }

  async loadSessionTurnWindow(
    request: LoadSessionTurnWindowRequest,
  ): Promise<LoadSessionTurnWindowResponse> {
    try {
      return await api.invoke<LoadSessionTurnWindowResponse>('load_session_turn_window', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('load_session_turn_window', error, {
        sessionId: request.sessionId,
        workspacePath: request.workspacePath,
        targetStorageTurnIndex: request.targetStorageTurnIndex,
      });
    }
  }

  async rollbackSessionToTurn(
    request: RollbackSessionToTurnRequest,
  ): Promise<RollbackSessionToTurnOutcome> {
    try {
      const outcome = await api.invoke<RollbackSessionToTurnWireOutcome>('rollback_session_to_turn', {
        request,
      });
      if (outcome.status === 'completed') {
        return {
          ...outcome,
          retiredTurnIds: outcome.retiredTurnIds ?? [],
          restoredFiles: outcome.restoredFiles ?? [],
        };
      }
      return {
        ...outcome,
        affectedFiles: outcome.affectedFiles ?? [],
      };
    } catch (error) {
      throw createTauriCommandError('rollback_session_to_turn', error, {
        sessionId: request.sessionId,
        targetTurnId: request.targetTurnId,
      });
    }
  }

  async setSessionMemoryMode(
    request: SetSessionMemoryModeRequest
  ): Promise<SetSessionMemoryModeResponse> {
    try {
      return await api.invoke<SetSessionMemoryModeResponse>('set_session_memory_mode', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('set_session_memory_mode', error, request);
    }
  }

  async resetMemory(): Promise<ResetMemoryResponse> {
    try {
      return await api.invoke<ResetMemoryResponse>('reset_memory');
    } catch (error) {
      throw createTauriCommandError('reset_memory', error);
    }
  }

  async getMemoryPaths(): Promise<MemoryPathsResponse> {
    try {
      return await api.invoke<MemoryPathsResponse>('get_memory_paths');
    } catch (error) {
      throw createTauriCommandError('get_memory_paths', error);
    }
  }

  /**
   * No-op if the session is already in the coordinator; otherwise loads it from disk
   * using the same workspace path resolution as restore_session (required for SSH remote workspaces).
   */
  async ensureCoordinatorSession(request: {
    sessionId: string;
    workspacePath: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
    includeInternal?: boolean;
  }): Promise<void> {
    try {
      await api.invoke<void>('ensure_coordinator_session', { request });
    } catch (error) {
      throw createTauriCommandError('ensure_coordinator_session', error, request);
    }
  }

  async updateSessionModel(request: UpdateSessionModelRequest): Promise<void> {
    try {
      await api.invoke<void>('update_session_model', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_model', error, request);
    }
  }

  /**
   * Sets the tool permission mode for one session. Other open sessions keep
   * their own selection; passing no mode returns this session to the
   * user-level default.
   */
  async updateSessionPermissionMode(
    request: SessionPermissionModeRequest,
  ): Promise<SessionPermissionModeResponse> {
    try {
      return await api.invoke<SessionPermissionModeResponse>(
        'update_session_permission_mode',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('update_session_permission_mode', error, request);
    }
  }

  /** Updates the temporary mode for one exact active turn. */
  async updateActiveTurnPermissionMode(
    request: ActiveTurnPermissionModeRequest,
  ): Promise<SessionPermissionModeResponse> {
    try {
      return await api.invoke<SessionPermissionModeResponse>(
        'update_active_turn_permission_mode',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('update_active_turn_permission_mode', error, request);
    }
  }

  /** Reads a session's own permission mode; `null` means it follows the default. */
  async getSessionPermissionMode(
    request: SessionPermissionModeRequest,
  ): Promise<SessionPermissionModeResponse> {
    try {
      return await api.invoke<SessionPermissionModeResponse>(
        'get_session_permission_mode',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('get_session_permission_mode', error, request);
    }
  }

  async updateSessionMode(request: UpdateSessionModeRequest): Promise<void> {
    try {
      await api.invoke<void>('update_session_mode', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_mode', error, request);
    }
  }

  async reloadSessionContext(
    request: AgentContextReloadRequest,
  ): Promise<void> {
    try {
      await api.invoke<void>('reload_session_context', { request });
    } catch (error) {
      throw createTauriCommandError('reload_session_context', error, request);
    }
  }

  async updateSessionTitle(request: UpdateSessionTitleRequest): Promise<string> {
    try {
      return await api.invoke<string>('update_session_title', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_title', error, request);
    }
  }


   
  async listSessions(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<SessionInfo[]> {
    try {
      return await api.invoke<SessionInfo[]>('list_sessions', {
        request: { workspacePath, remoteConnectionId, remoteSshHost },
      });
    } catch (error) {
      throw createTauriCommandError('list_sessions', error, { workspacePath });
    }
  }

  async listPendingPermissionRequests(): Promise<PermissionRequest[]> {
    try {
      return await api.invoke<PermissionRequest[]>('list_pending_permission_requests');
    } catch (error) {
      throw createTauriCommandError('list_pending_permission_requests', error);
    }
  }

  async subscribePermissionRequests(): Promise<void> {
    try {
      await api.invoke<void>('subscribe_permission_requests');
    } catch (error) {
      throw createTauriCommandError('subscribe_permission_requests', error);
    }
  }

  async respondPermission(
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
  ): Promise<void> {
    const request = {
      requestId,
      reply,
      ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
    };
    try {
      await api.invoke<void>('respond_permission', { request });
    } catch (error) {
      throw createTauriCommandError('respond_permission', error, request);
    }
  }

  async respondPermissionBatch(
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
  ): Promise<string[]> {
    const request = {
      requestId,
      reply,
      ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
    };
    try {
      return await api.invoke<string[]>('respond_permission_batch', { request });
    } catch (error) {
      throw createTauriCommandError('respond_permission_batch', error, request);
    }
  }

  onPermissionRequestEvent(callback: (event: PermissionRequestEvent) => void): () => void {
    return api.listen<PermissionRequestEvent>('permission://event', callback);
  }
  

   
  onSessionCreated(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://session-created', callback);
  }

  onSessionDeleted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://session-deleted', callback);
  }

  onSessionStateChanged(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://session-state-changed', callback);
  }

  onSessionHistoryChanged(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://session-history-changed', callback);
  }

  onSessionModelFallbackApplied(
    callback: (event: SessionModelFallbackAppliedEvent) => void
  ): () => void {
    return api.listen<SessionModelFallbackAppliedEvent>(
      'agentic://session-model-fallback-applied',
      callback
    );
  }

  onSessionReasoningPresetAutoCleared(
    callback: (event: SessionReasoningPresetAutoClearedEvent) => void
  ): () => void {
    return api.listen<SessionReasoningPresetAutoClearedEvent>(
      'agentic://session-reasoning-preset-auto-cleared',
      callback
    );
  }

   
  onDialogTurnStarted(callback: (event: DialogTurnStartedEvent) => void): () => void {
    return api.listen<DialogTurnStartedEvent>('agentic://dialog-turn-started', callback);
  }

   
  onModelRoundStarted(callback: (event: ModelRoundStartedEvent) => void): () => void {
    return api.listen<ModelRoundStartedEvent>('agentic://model-round-started', callback);
  }

  onModelRoundCompleted(callback: (event: ModelRoundCompletedEvent) => void): () => void {
    return api.listen<ModelRoundCompletedEvent>('agentic://model-round-completed', callback);
  }

  onModelRoundAttemptSuperseded(callback: (event: ModelRoundAttemptSupersededEvent) => void): () => void {
    return api.listen<ModelRoundAttemptSupersededEvent>('agentic://model-round-attempt-superseded', callback);
  }

  onTextChunk(callback: (event: TextChunkEvent) => void): () => void {
    return api.listen<TextChunkEvent>('agentic://text-chunk', callback);
  }

   
  onToolEvent(callback: (event: ToolEvent) => void): () => void {
    return api.listen<ToolEvent>('agentic://tool-event', callback);
  }

  onSubagentSessionLinked(
    callback: (event: SubagentSessionLinkedEvent) => void
  ): () => void {
    return api.listen<SubagentSessionLinkedEvent>(
      'agentic://subagent-session-linked',
      callback
    );
  }

  onDeepReviewQueueStateChanged(
    callback: (event: DeepReviewQueueStateChangedEvent) => void
  ): () => void {
    return api.listen<DeepReviewQueueStateChangedEvent>(
      'agentic://deep-review-queue-state-changed',
      callback
    );
  }

   
  onDialogTurnCompleted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://dialog-turn-completed', callback);
  }

  onUserSteeringInjected(
    callback: (event: UserSteeringInjectedEvent) => void,
  ): () => void {
    return api.listen<UserSteeringInjectedEvent>('agentic://user-steering-injected', callback);
  }

   
  onDialogTurnFailed(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://dialog-turn-failed', callback);
  }

   
  onDialogTurnCancelled(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://dialog-turn-cancelled', callback);
  }

  onDialogTurnInterrupted(callback: (event: InterruptedDialogTurnEvent) => void): () => void {
    return api.listen<InterruptedDialogTurnEvent>('agentic://dialog-turn-interrupted', callback);
  }

  onDialogTurnRecovered(callback: (event: InterruptedDialogTurnEvent) => void): () => void {
    return api.listen<InterruptedDialogTurnEvent>('agentic://dialog-turn-recovered', callback);
  }

   
  onTokenUsageUpdated(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agentic://token-usage-updated', callback);
  }

  onAcpContextUsageUpdated(
    callback: (event: AcpContextUsageUpdatedEvent) => void
  ): () => void {
    return api.listen<AcpContextUsageUpdatedEvent>(
      'agentic://acp-context-usage-updated',
      callback
    );
  }

   
  onContextCompressionStarted(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agentic://context-compression-started', callback);
  }

   
  onContextCompressionCompleted(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agentic://context-compression-completed', callback);
  }

   
  onContextCompressionFailed(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agentic://context-compression-failed', callback);
  }

  onThreadGoalUpdated(
    callback: (event: { sessionId: string; goal?: Record<string, unknown> | null }) => void
  ): () => void {
    return api.listen('agentic://thread-goal-updated', callback);
  }

  onOpenBuiltInBrowser(callback: (event: OpenBuiltInBrowserEvent) => void): () => void {
    return api.listen<OpenBuiltInBrowserEvent>('agentic://open-built-in-browser', callback);
  }

  onImageAnalysisStarted(callback: (event: ImageAnalysisEvent) => void): () => void {
    return api.listen<ImageAnalysisEvent>('agentic://image-analysis-started', callback);
  }

  onImageAnalysisCompleted(callback: (event: ImageAnalysisEvent) => void): () => void {
    return api.listen<ImageAnalysisEvent>('agentic://image-analysis-completed', callback);
  }

   
  async getAvailableTools(): Promise<string[]> {
    try {
      return await api.invoke<string[]>('get_available_tools');
    } catch (error) {
      throw createTauriCommandError('get_available_tools', error);
    }
  }

  async getDefaultReviewTeamDefinition(): Promise<unknown> {
    try {
      return await api.invoke<unknown>('get_default_review_team_definition');
    } catch (error) {
      throw createTauriCommandError('get_default_review_team_definition', error);
    }
  }

  async generateSessionTitle(
    sessionId: string,
    userMessage: string,
    maxLength?: number
  ): Promise<string> {
    try {
      return await api.invoke<string>('generate_session_title', {
        request: {
          sessionId,
          userMessage,
          maxLength: maxLength || 20
        }
      });
    } catch (error) {
      throw createTauriCommandError('generate_session_title', error, {
        sessionId,
        userMessage,
        maxLength
      });
    }
  }

   
  onSessionTitleGenerated(
    callback: (event: SessionTitleGeneratedEvent) => void
  ): () => void {
    return api.listen<SessionTitleGeneratedEvent>('session_title_generated', callback);
  }

  async cancelSession(
    sessionId: string,
    options?: { cancelDescendants?: boolean },
  ): Promise<{
    cancelled: boolean;
    dialogTurnId: string | null;
  }> {
    try {
      const request = {
        sessionId,
        ...(options?.cancelDescendants === undefined
          ? {}
          : { cancelDescendants: options.cancelDescendants }),
      };
      return await api.invoke<{
        cancelled: boolean;
        dialogTurnId: string | null;
      }>('cancel_session', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('cancel_session', error, { sessionId });
    }
  }

  async setSubagentTimeout(
    sessionId: string,
    action: { type: 'disable' } | { type: 'restore' } | { type: 'extend'; seconds: number },
  ): Promise<void> {
    const actionPayload = action.type === 'disable'
      ? { type: 'Disable', payload: null }
      : action.type === 'restore'
        ? { type: 'Restore', payload: null }
        : { type: 'Extend', payload: { seconds: action.seconds } };
    try {
      await api.invoke<void>('set_subagent_timeout', {
        request: { sessionId, action: actionPayload },
      });
    } catch (error) {
      throw createTauriCommandError('set_subagent_timeout', error, { sessionId, action: action.type });
    }
  }

  async controlBackgroundCommand(request: ControlBackgroundCommandRequest): Promise<void> {
    const actionPayload = request.action === 'interrupt' ? 'interrupt' : 'kill';
    try {
      await api.invoke<void>('control_background_command', {
        request: {
          execSessionId: request.execSessionId,
          action: actionPayload,
          remote: request.remote,
        },
      });
    } catch (error) {
      throw createTauriCommandError('control_background_command', error, request);
    }
  }

  async sendBackgroundCommandInput(request: SendBackgroundCommandInputRequest): Promise<void> {
    try {
      await api.invoke<void>('send_background_command_input', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('send_background_command_input', error, {
        execSessionId: request.execSessionId,
        remote: request.remote,
        appendEnter: request.appendEnter,
      });
    }
  }

  async readBackgroundCommandOutput(
    request: ReadBackgroundCommandOutputRequest,
  ): Promise<ReadBackgroundCommandOutputResponse> {
    try {
      return await api.invoke<ReadBackgroundCommandOutputResponse>('read_background_command_output', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('read_background_command_output', error, request);
    }
  }

  async listBackgroundCommandActivities(
    request: ListBackgroundCommandActivitiesRequest,
  ): Promise<ListBackgroundCommandActivitiesResponse> {
    try {
      return await api.invoke<ListBackgroundCommandActivitiesResponse>('list_background_command_activities', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('list_background_command_activities', error, request);
    }
  }

  async getAgentInfo(agentType: string): Promise<ModeInfo & { agent_type: string; when_to_use: string; tools: string; location: string }> {
    return {
      id: agentType,
      name: agentType,
      description: `${agentType} agent`,
      isReadonly: false,
      toolCount: 0,
      promptCacheScopeKey: agentType,
      configProfileId: agentType,
      configProfileMemberModeIds: [agentType],
      source: 'builtin',
      agent_type: agentType,
      when_to_use: `Use ${agentType} for related tasks`,
      tools: 'all',
      location: 'builtin',
    };
  }

  

   
  async getAvailableModes(request: {
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  } = {}): Promise<ModeInfo[]> {
    try {
      return translateAgentIdentityFields(await api.invoke<ModeInfo[]>('get_available_modes', { request }), 'canonical');
    } catch (error) {
      throw createTauriCommandError('get_available_modes', error);
    }
  }

}


export const agentAPI = new AgentAPI();
