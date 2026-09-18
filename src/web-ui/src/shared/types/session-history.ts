/**
 * Session persistence types.
 *
 * Used by session lists and persistence metadata in the frontend.
 */

import type { ReviewTargetEvidence, ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';
import type { AiErrorDetail } from '@/shared/ai-errors/aiErrorPresenter';
import type { SessionExecutionTarget } from '@/infrastructure/api/service-api/WorktreeAPI';

export type SessionKind = 'normal' | 'btw' | 'review' | 'deep_review' | 'miniapp' | 'subagent';
export type PersistedSessionKind = 'standard' | 'subagent';
export type SessionTitleSource = 'text' | 'i18n';
export type SessionRelationshipKind = 'btw' | 'review' | 'deep_review' | 'miniapp' | 'subagent';

export interface SessionRelationship {
  kind?: SessionRelationshipKind;
  parentSessionId?: string | null;
  parentRequestId?: string | null;
  parentDialogTurnId?: string | null;
  parentTurnIndex?: number | null;
  parentToolCallId?: string | null;
  subagentType?: string | null;
}

export interface SessionCustomMetadata extends Record<string, unknown> {
  kind?: SessionKind;
  parentSessionId?: string | null;
  parentRequestId?: string | null;
  parentDialogTurnId?: string | null;
  parentTurnIndex?: number | null;
  parentToolCallId?: string | null;
  subagentType?: string | null;
  forkOrigin?: {
    sessionId?: string | null;
    turnId?: string | null;
    turnIndex?: number | null;
    baseTitle?: string | null;
  } | null;
  lastFinishedAt?: number | null;
  titleSource?: SessionTitleSource | null;
  titleKey?: string | null;
  titleParams?: Record<string, unknown> | null;
  workspaceSessionNumber?: number;
}

export type SessionContextUsageSource = 'model_request' | 'context_compression';

/** Exact session-level context usage persisted by the Agent Session runtime. */
export interface SessionContextUsage {
  turnId: string;
  inputTokens: number;
  outputTokens?: number;
  totalTokens: number;
  timestamp: number;
  source: SessionContextUsageSource;
}

export interface SessionMetadata {
  workspaceId?: string;
  projectWorkspaceId?: string;
  sessionId: string;
  sessionName: string;
  /**
   * Current/default mode selection for the next dialog turn in this session.
   * This is not guaranteed to match either the last surviving history turn or
   * the most recent submission accepted by the runtime.
   */
  agentType: string;
  /**
   * Mode of the last surviving user dialog turn in persisted history.
   * Rollback and turn truncation update this value.
   */
  lastUserDialogAgentType?: string;
  /**
   * Mode of the most recent user submission accepted by the runtime.
   * This is used for prompt-cache guard semantics and does not rewind on
   * rollback.
   */
  lastSubmittedAgentType?: string;
  sessionKind?: PersistedSessionKind;
  modelName: string;
  createdAt: number;
  lastActiveAt: number;
  lastFinishedAt?: number | null;
  lastTurn?: SessionLastTurn;
  turnCount: number;
  messageCount: number;
  toolCallCount: number;
  status: SessionStatus;
  snapshotSessionId?: string;
  tags: string[];
  customMetadata?: SessionCustomMetadata;
  currentContextUsage?: SessionContextUsage;
  relationship?: SessionRelationship;
  todos?: any[];
  workspacePath?: string;
  projectWorkspacePath?: string;
  executionTarget?: SessionExecutionTarget;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  /** Backend unified workspace identity field: localhost for local, SSH host for remote. */
  workspaceHostname?: string;
  /**
   * Result notification cleared after its result is viewed. Execution and
   * resumable recovery remain separate facts in the activity/last-Turn summary.
   */
  unreadCompletion?: 'completed' | 'error' | 'interrupted';
  /**
   * High-priority attention status for the session.
   * 'ask_user' → pending AskUserQuestion waiting for answer.
   * 'tool_confirm' → pending tool confirmations.
   * Takes precedence over unreadCompletion in the UI.
   */
  needsUserAttention?: 'ask_user' | 'tool_confirm';
  /**
   * Persisted review action bar state for code review / deep review sessions.
   * Allows restoring the review action bar across app restarts.
   */
  reviewActionState?: ReviewActionPersistedState;
  /**
   * The per-run Deep Review reviewer manifest used to launch this session.
   * Continuation and later backend gates use this as the source of truth.
   */
  deepReviewRunManifest?: ReviewTeamRunManifest;
  reviewTargetEvidence?: ReviewTargetEvidence;
}

/** Index-sized execution facts; never contains message or tool payloads. */
export interface SessionLastTurn {
  turnId: string;
  turnIndex: number;
  status: 'inprogress' | 'completed' | 'error' | 'cancelled';
  endTime?: number;
  executionGeneration?: number;
  /** Explicit interrupted checkpoint; omitted by older hosts/metadata. */
  recoveryPending?: boolean;
}

export interface SessionActivitySummary {
  sessionId: string;
  execution: 'idle' | 'running' | 'queued' | 'error' | 'external' | (string & {});
  activeTurnId?: string;
  pendingApprovals: number;
  pendingQuestions: number;
  lastTurn?: SessionLastTurn;
  unreadCompletion?: 'completed' | 'error' | 'interrupted';
}

export interface ReviewActionPersistedState {
  version: number;
  phase: string;
  completedRemediationIds: string[];
  fixingRemediationIds?: string[];
  minimized: boolean;
  customInstructions: string;
  followUpReviewSessionId?: string;
  reviewTargetFilePaths?: string[];
  remediationModifiedFilePaths?: string[];
  remediationScopeRequiresWorkspaceFallback?: boolean;
  fixingBaselineTurnId?: string;
  persistedAt: number;
}

export type SessionStatus = 'active' | 'archived' | 'completed';
export type DialogTurnKind = 'user_dialog' | 'manual_compaction' | 'local_command';

export type LocalCommandKind = 'usage_report';

export interface LocalCommandMetadata {
  localCommandKind: LocalCommandKind;
  reportId?: string;
  schemaVersion?: number;
  generatedAt?: number;
  modelVisible: false;
  usageReport?: Record<string, any>;
  usageReportStatus?: 'loading' | 'completed';
  /** Frontend-only until the backend returns its authoritative turn catalog entry. */
  usageReportProvisional?: boolean;
  threadGoalKickoff?: boolean;
  threadGoalObjectiveUpdated?: boolean;
  threadGoalContinuation?: boolean;
  threadGoalContinuationCheck?: boolean;
  threadGoalObjective?: string;
  objective?: string;
  autoContinuationAttempt?: number;
  autoContinuationMax?: number;
}

export interface SessionList {
  sessions: SessionMetadata[];
  lastUpdated: number;
  version: string;
}

export interface SessionTurnCatalogEntry {
  ordinal: number;
  storageTurnIndex: number;
  turnId?: string;
  preview?: string;
  previewTruncated: boolean;
  capsulePreview?: TurnRailCapsulePreview;
}

export interface TurnRailCapsulePreview {
  segments: Array<
    | { kind: 'text'; text: string }
    | { kind: 'context'; contextType: string; label: string; title?: string }
    | { kind: 'inlineToken'; tokenType: string; label: string }
  >;
}

export interface SessionTurnCatalog {
  schemaVersion: number;
  sessionId: string;
  revision: string;
  totalTurnCount: number;
  complete: boolean;
  entries: SessionTurnCatalogEntry[];
}

export interface DialogTurnData {
  turnId: string;
  turnIndex: number;
  sessionId: string;
  timestamp: number;
  kind?: DialogTurnKind;
  /**
   * Mode used when this turn was submitted as a user dialog. Local utility
   * turns may leave this empty.
   */
  agentType?: string;
  userMessage: UserMessageData;
  modelRounds: ModelRoundData[];
  startTime: number;
  endTime?: number;
  durationMs?: number;
  tokenUsage?: DialogTurnTokenUsageData;
  status: TurnStatus;
  finishReason?: string;
  recoveryEpoch?: number;
  recovery?: {
    status: 'interrupted' | 'recovering';
    executionGeneration: number;
    resumeCount: number;
    interruptedAt?: number;
    modelId?: string;
  };
  hasFinalResponse?: boolean;
  error?: string;
  errorDetail?: AiErrorDetail;
}

export interface DialogTurnTokenUsageData {
  inputTokens: number;
  outputTokens?: number;
  totalTokens: number;
  timestamp: number;
}

export interface UserMessageData {
  id: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ModelRoundData {
  id: string;
  turnId: string;
  roundIndex: number;
  roundGroupId?: string;
  timestamp: number;
  renderHints?: ModelRoundRenderHints;
  textItems: TextItemData[];
  toolItems: ToolItemData[];
  thinkingItems?: ThinkingItemData[];
  startTime: number;
  endTime?: number;
  durationMs?: number;
  providerId?: string;
  modelConfigId?: string;
  effectiveModelName?: string;
  firstChunkMs?: number;
  firstVisibleOutputMs?: number;
  streamDurationMs?: number;
  attemptCount?: number;
  attemptDiagnostics?: ModelRoundAttemptDiagnostic[];
  failureCategory?: string;
  tokenDetails?: unknown;
  status: string;
}

export interface ModelRoundAttemptDiagnostic {
  attemptId: string;
  attemptIndex: number;
  category: string;
  rawError?: string;
  toolCalls?: ModelRoundAttemptToolDiagnostic[];
}

export interface ModelRoundAttemptToolDiagnostic {
  toolId?: string;
  toolName?: string;
  rawArguments?: string;
  validationError?: string;
}

export interface ModelRoundRenderHints {
  disableExploreGrouping?: boolean;
}

export interface TextItemData {
  id: string;
  content: string;
  isStreaming: boolean;
  timestamp: number;
  status?: string;
  orderIndex?: number;
  isMarkdown?: boolean;
  subagentSessionId?: string;
  attemptId?: string;
  attemptIndex?: number;
}

export interface ThinkingItemData {
    id: string;
    content: string;
    reasoningKind?: 'reasoning' | 'summary';
  isStreaming: boolean;
  isCollapsed: boolean;
  timestamp: number;
  orderIndex?: number;
  status?: string;
  subagentSessionId?: string;
  attemptId?: string;
  attemptIndex?: number;
}

export interface ToolItemData {
  id: string;
  toolName: string;
  toolCall: ToolCallData;
  toolResult?: ToolResultData;
  aiIntent?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  queueWaitMs?: number;
  preflightMs?: number;
  confirmationWaitMs?: number;
  executionMs?: number;
  orderIndex?: number;
  status?: string;
  interruptionReason?: 'app_restart' | 'retry_superseded';
  subagentSessionId?: string;
  subagentDialogTurnId?: string;
  attemptId?: string;
  attemptIndex?: number;
}

export interface ToolCallData {
  input: any;
  id: string;
}

export interface ToolResultData {
  result: any;
  success: boolean;
  resultForAssistant?: string;
  imageAttachments?: Array<{
    mime_type: string;
    data_base64: string;
  }>;
  error?: string;
  durationMs?: number;
}

export type TurnStatus = 'inprogress' | 'completed' | 'error' | 'cancelled';
