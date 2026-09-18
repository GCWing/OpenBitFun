/**
 * Flow Chat type definitions
 * Supports mixed streaming output.
 */

import type {
  DialogTurnKind,
  SessionKind,
  SessionContextUsageSource,
  SessionTitleSource,
  SessionTurnCatalog,
} from '@/shared/types/session-history';
import type { AiErrorDetail } from '@/shared/ai-errors/aiErrorPresenter';
import type { ReviewTargetEvidence, ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';
import type { ContextItem } from '@/shared/types/context';

export type ModelRoundAttemptDiagnostic = import('@/shared/types/session-history').ModelRoundAttemptDiagnostic;

// Base type for streaming items.
export interface FlowItem {
  id: string;
  type: 'text' | 'tool' | 'image-analysis' | 'thinking' | 'user-steering';
  timestamp: number;
  status: 'pending' | 'queued' | 'waiting' | 'preparing' | 'running' | 'streaming' | 'receiving' | 'completed' | 'cancelled' | 'rejected' | 'error' | 'analyzing' | 'pending_confirmation' | 'confirmed'; // Includes error, analyzing, and confirmation states.
  attemptId?: string;
  attemptIndex?: number;

  /**
   * Session-scoped subagent linkage.
   * Used by parent Task tools and projected subagent output.
   */
  subagentSessionId?: string;
}

export interface FlowTextItem extends FlowItem {
  type: 'text';
  content: string;
  isStreaming: boolean;
  isMarkdown?: boolean;
}

export interface FlowThinkingItem extends FlowItem {
  type: 'thinking';
  content: string;
  reasoningKind?: 'reasoning' | 'summary';
  isStreaming: boolean;
  isCollapsed: boolean; // Whether the thinking block is collapsed.
}

export interface FlowToolItem extends FlowItem {
  type: 'tool';
  /** Provider-facing identity. Deferred calls remain `CallDeferredTool`. */
  toolName: string;
  terminalSessionId?: string;
  interruptionReason?: 'app_restart' | 'retry_superseded';
  toolCall: {
    input: any;
    id: string;
    timeout_seconds?: number;
  };
  toolResult?: {
    result: any;
    success: boolean;
    resultForAssistant?: string;
    imageAttachments?: Array<{
      mime_type: string;
      data_base64: string;
    }>;
    error?: string;
    duration_ms?: number;
  };
  requiresConfirmation?: boolean;
  userConfirmed?: boolean;
  acpPermission?: {
    permissionId: string;
    sessionId?: string;
    toolCallId?: string;
    requestedAt: number;
    options?: Array<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>;
    toolCall?: {
      toolCallId?: string;
      title?: string;
      rawInput?: unknown;
      content?: unknown;
    };
  };
  aiIntent?: string; // AI rationale for calling the tool.
  startTime?: number;  // Tool start time.
  endTime?: number;    // Tool end time.
  durationMs?: number;
  queueWaitMs?: number;
  preflightMs?: number;
  confirmationWaitMs?: number;
  executionMs?: number;

  /** Resolved subagent AI model configuration ID captured on the parent Task tool. */
  subagentModelId?: string;
  /** Provider model name used by the subagent's round. */
  subagentModelDisplayName?: string;

  /** Child dialog turn produced by this parent Task call. */
  subagentDialogTurnId?: string;
  
  // Streaming parameter buffering.
  isParamsStreaming?: boolean;  // Params are streaming in.
  partialParams?: Record<string, any>;  // Partial params during streaming.
  _paramsBuffer?: string;  // Internal buffer for accumulated params.

  /**
   * Runtime re-attachment marker. This item was reconstructed from an
   * authoritative pending-interaction mailbox rather than a persisted Turn.
   * It is removed or settled when a newer mailbox revision says the request
   * no longer exists.
   */
  _runtimeInteractionProjection?: {
    kind: 'user_question';
    revision: number;
  };
  /** Host-owned live question state, independent of model tool arguments. */
  userQuestionWait?: {
    deadlineMs?: number | null;
    monotonicDeadlineMs?: number;
    interactionStarted: boolean;
  };
}

export interface ToolRejectOptions {
  permissionOptionId?: string;
  instruction?: string;
}

export interface FlowImageAnalysisItem extends FlowItem {
  type: 'image-analysis';
  imageContext: import('@/shared/types/context').ImageContext;
  result?: ImageAnalysisResult | null;
  error?: string;
}

/**
 * A user-authored "steering" message injected mid-turn via the
 * `steer_dialog_turn` Tauri command. Rendered inline inside the running
 * model round so the user can see the message they steered the agent with.
 */
/** One image attached to a steering message, in display shape. */
export interface SteeringImage {
  id: string;
  name?: string;
  dataUrl?: string;
  imagePath?: string;
  mimeType?: string;
}

export interface FlowUserSteeringItem extends FlowItem {
  type: 'user-steering';
  steeringId: string;
  content: string;
  /** Images sent with the steering message, rendered under its text. */
  images?: SteeringImage[];
  /** Round index reported by the backend at injection time. */
  roundIndex: number;
}

export type AnyFlowItem =
  | FlowTextItem
  | FlowThinkingItem
  | FlowToolItem
  | FlowImageAnalysisItem
  | FlowUserSteeringItem;

export interface ImageAnalysisResult {
  image_id: string;
  summary: string;              // Short summary.
  detailed_description: string; // Detailed description.
  detected_elements: string[];  // Key detected elements.
  confidence: number;           // Confidence score (0-1).
  analysis_time_ms: number;     // Analysis duration.
}

export interface ModelRoundRenderHints {
  /** Display-only recovery boundary, derived from the preceding cancelled round. */
  continuedAfterInterruption?: boolean;
  /**
   * Keep all round items in the normal transcript instead of merging
   * collapsible tools and adjacent narrative into an explore group.
   */
  disableExploreGrouping?: boolean;
}

export interface ModelRoundAttempt {
  id: string;
  index: number;
  status: 'streaming' | 'completed' | 'superseded' | 'failed' | 'cancelled';
  items: AnyFlowItem[];
  diagnostic?: ModelRoundAttemptDiagnostic;
}

// Model round: output from a single model call.
export interface ModelRound {
  id: string;
  index: number;
  roundGroupId?: string;
  items: AnyFlowItem[];
  attempts?: ModelRoundAttempt[];
  historyRounds?: ModelRound[];
  isStreaming: boolean;
  isComplete: boolean;
  status: 'pending' | 'streaming' | 'completed' | 'cancelled' | 'rejected' | 'error' | 'pending_confirmation';
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
  error?: string;
  renderHints?: ModelRoundRenderHints;
}

// Token usage stats.
export interface TokenUsage {
  inputTokens: number;
  outputTokens?: number;
  totalTokens: number;
  timestamp: number;
  /** Persisted source turn used to invalidate usage after history rewrites. */
  turnId?: string;
  /** Runtime provenance for restored session-level context usage. */
  source?: SessionContextUsageSource;
}

export interface AcpContextUsage {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
  timestamp: number;
}

// Dialog turn: user input + full AI response across model rounds.
export interface DialogTurn {
  id: string;
  sessionId: string; // Used for event filtering.
  kind?: DialogTurnKind;
  /**
   * Mode used when this user-facing dialog turn was submitted.
   * Local utility turns may leave this empty.
   */
  agentType?: string;
  userMessage: {
    id: string;
    content: string;
    timestamp: number;
    hasImages?: boolean;
    metadata?: Record<string, any>;
    images?: Array<{
      id: string;
      name: string;
      dataUrl?: string;
      imagePath?: string;
      mimeType?: string;
    }>;
  };
  
  // Image analysis phase (only when images exist).
  imageAnalysisPhase?: {
    items: FlowImageAnalysisItem[];
    status: 'analyzing' | 'completed' | 'error';
    startTime: number;
    endTime?: number;
  };
  
  enhancedMessage?: string;
  
  modelRounds: ModelRound[];  // Model rounds in chronological order.
  status: 'pending' | 'image_analyzing' | 'processing' | 'finishing' | 'completed' | 'cancelling' | 'cancelled' | 'error'; // Includes image_analyzing.
  startTime: number;
  endTime?: number;
  error?: string;
  errorDetail?: AiErrorDetail;
  tokenUsage?: TokenUsage;
  todos?: TodoItem[];
  /** Backend persistence slot. It may be sparse and must not be used as ordinal. */
  storageTurnIndex?: number;
  /** @deprecated Compatibility for older restored projections. Use `storageTurnIndex`. */
  backendTurnIndex?: number;
  /** Whether the turn completed successfully. */
  success?: boolean;
  /** Why the turn finished. */
  finishReason?: string;
  /** Additive recovery metadata for an intentionally interrupted turn. */
  /** Runtime generation retained after recovery has settled. */
  recoveryEpoch?: number;
  recovery?: {
    status: 'interrupted' | 'recovering';
    executionGeneration: number;
    resumeCount: number;
    interruptedAt?: number;
    modelId?: string;
  };
  /** Whether the turn produced a final assistant response visible to the user. */
  hasFinalResponse?: boolean;
}

declare const localTurnIndexBrand: unique symbol;
declare const turnOrdinalBrand: unique symbol;
declare const storageTurnIndexBrand: unique symbol;

/** Position inside the currently loaded `dialogTurns` array. */
export type LocalTurnIndex = number & { readonly [localTurnIndexBrand]: 'LocalTurnIndex' };
/** Zero-based visible Turn position inside the complete Session history. */
export type TurnOrdinal = number & { readonly [turnOrdinalBrand]: 'TurnOrdinal' };
/** Opaque backend persistence slot. It may be sparse and differ from ordinal. */
export type StorageTurnIndex = number & { readonly [storageTurnIndexBrand]: 'StorageTurnIndex' };

export interface DialogTurnIdentity {
  ordinal: TurnOrdinal;
  storageTurnIndex?: StorageTurnIndex;
  state: 'optimistic' | 'persisted';
}

export interface FlowChatState {
  sessions: Map<string, Session>;
  activeSessionId: string | null;
}

export interface TodoItem {
  id: string;
  content: string; // Imperative task description.
  status: 'pending' | 'in_progress' | 'completed';
}

export type SessionHistoryState =
  | 'new'
  | 'metadata-only'
  | 'hydrating'
  | 'ready'
  | 'failed';

export type LoadedTurnRangeSource = 'initial-tail' | 'target' | 'prefetch' | 'live';

export interface LoadedTurnRange {
  startOrdinal: number;
  endOrdinalExclusive: number;
  turns: DialogTurn[];
  lastAccessedAt: number;
  source: LoadedTurnRangeSource;
}

export interface ActiveTurnRenderRange {
  startOrdinal: number;
  endOrdinalExclusive: number;
  targetTurnId: string | null;
  mode: 'tail' | 'history-window';
}

export interface SessionHistoryViewState {
  catalog: SessionTurnCatalog | null;
  loadedRanges: LoadedTurnRange[];
  activeRange: ActiveTurnRenderRange | null;
  pendingTargetOrdinal: number | null;
  navigationGeneration: number;
}

export interface SessionHistoryPresentation {
  range: ActiveTurnRenderRange;
  turns: DialogTurn[];
}

export type SessionContextRestoreState =
  | 'ready'
  | 'pending'
  | 'failed';

// Session state.
export interface Session {
  sessionId: string;
  title?: string;
  /**
   * Untouched default sessions keep an i18n key so locale changes can re-render
   * their title. Once a real title is generated or renamed, we freeze it as text.
   */
  titleSource?: SessionTitleSource;
  titleI18nKey?: string;
  titleI18nParams?: Record<string, unknown>;
  /** Host-assigned display slot, occupied only while this session has its default title. */
  workspaceSessionNumber?: number;
  titleStatus?: 'generating' | 'generated' | 'failed';
  /**
   * In-memory canonical working set for this session.
   *
   * Live and fully hydrated sessions normally contain all canonical Turns.
   * When `isPartial` is true, this contains only the restored live tail;
   * older paged windows remain in `SessionHistoryViewState.loadedRanges`.
   *
   * This array may temporarily contain provisional frontend Turns that have
   * not been persisted. Never derive a backend storage index from its length
   * or local array position; use `DialogTurn.storageTurnIndex` and
   * `turnCatalog` for persisted identity and ordinals.
   */
  dialogTurns: DialogTurn[];
  
  // Derived status from deriveSessionStatus():
  // - 'active': sessionId === activeSessionId
  // - 'error': state machine state === ERROR
  // - 'idle': otherwise
  status: 'active' | 'idle' | 'error';
  /** Persisted backend status retained while historical turns are metadata-only. */
  persistedStatus?: 'active' | 'archived' | 'completed';
  
  config: SessionConfig;
  createdAt: number;
  lastActiveAt: number;
  lastFinishedAt?: number;
  updatedAt?: number;
  
  // Persist the last error; real-time errors come from context.errorMessage.
  error: string | null;
  
  // Historical sessions are persisted and require lazy loading.
  isHistorical?: boolean;

  /**
   * Lazy history lifecycle for persisted sessions:
   * - 'new': an empty local session that should show the normal welcome state.
   * - 'metadata-only': persisted metadata is visible, but turns have not hydrated yet.
   * - 'hydrating': history is currently being restored / loaded.
   * - 'ready': turns are available, or the session no longer needs lazy history.
   * - 'failed': hydrate failed and the UI should offer retry instead of showing a new session.
   */
  historyState?: SessionHistoryState;

  /**
   * Backend runtime-context lifecycle for sessions restored through the fast
   * history view path. Turns may be visible while model context is still loaded
   * lazily; message sending must ensure this becomes 'ready' first.
   */
  contextRestoreState?: SessionContextRestoreState;

  /**
   * True when the session currently contains only a tail preview of persisted
   * history. Destructive history actions must wait for the full history hydrate
   * so UI indexes cannot drift from persisted backend turn indexes.
   */
  isPartial?: boolean;
  loadedTurnCount?: number;
  totalTurnCount?: number;
  turnCatalog?: SessionTurnCatalog;
  
  todos?: TodoItem[];
  
  currentTokenUsage?: TokenUsage;
  currentAcpContextUsage?: AcpContextUsage;
  maxContextTokens?: number;
  
  /**
   * Current/default mode selection in the chat input for this session.
   * This controls what the next dialog turn should use by default.
   */
  mode?: string;
  /**
   * Mode of the last surviving user dialog turn in the current session
   * history. Rollback and turn truncation should follow this value.
   */
  lastUserDialogMode?: string;
  /**
   * Mode of the most recent user submission accepted by the runtime.
   * This is used for prompt-cache guard semantics and does not rewind on
   * rollback.
   */
  lastSubmittedMode?: string;

  // Workspace this session belongs to. Used for sidebar display filtering.
  // Sessions are always kept in store for event processing; only display is filtered.
  workspacePath?: string;

  /** Main project that owns this session when `workspacePath` is a linked worktree. */
  projectWorkspacePath?: string;

  /** Stable backend id — always set for new sessions; do not infer workspace from path alone. */
  workspaceId?: string;
  projectWorkspaceId?: string;

  /** SSH remote: same `workspacePath` on different hosts must not share coordinator/persistence. */
  remoteConnectionId?: string;

  /** SSH config host for `~/.openbitfun/remote_ssh/{host}/...` session paths when disconnected. */
  remoteSshHost?: string;

  /** Persisted workspace identity host; `localhost` is the local-workspace sentinel. */
  workspaceHostname?: string;

  /**
   * Optional parent session id for hierarchical sessions.
   * Used by /btw "side threads" and potentially other derived sessions.
   */
  parentSessionId?: string;

  /** Session kind for UI grouping. */
  sessionKind: SessionKind;

  /**
   * For hidden subagent sessions, records which parent Task tool launched it.
   * Helps reopen the real child session from parent task cards and header lists.
   */
  parentToolCallId?: string;

  /** Logical subagent id / type used to launch this hidden subagent session. */
  subagentType?: string;

  /** Whether `/goal` mode is active for this session. */
  goalModeActive?: boolean;

  /** Latest thread goal snapshot for UI (/goal menu, edit, resume). */
  threadGoal?: {
    goalId: string;
    objective: string;
    status: string;
    tokensUsed?: number;
    tokenBudget?: number | null;
    timeUsedSeconds?: number;
    updatedAt?: number;
    autoContinuationCount?: number;
  };

  /**
   * Lightweight markers for /btw threads created from this session.
   * Stored only on the parent session for quick navigation.
   */
  btwThreads?: Array<{
    requestId: string;
    childSessionId: string;
    title: string;
    status: 'running' | 'done' | 'error';
    createdAt: number;
    parentDialogTurnId?: string;
    /** 1-based turn index in the parent session when /btw was asked (best-effort). */
    parentTurnIndex?: number;
    error?: string;
  }>;

  /**
   * For /btw child sessions: where this side thread was asked from in the parent session.
   * This is best-effort and may be missing for older sessions.
   */
  btwOrigin?: {
    requestId?: string;
    parentSessionId?: string;
    parentDialogTurnId?: string;
    parentTurnIndex?: number;
  };

  /**
   * Set when a session finishes (completed / error / cancelled) while not the active session.
   * Cleared after the user switches to it and the content renders.
   * 'completed' → green dot, 'error' → red dot, 'interrupted' → red dot (partial stream recovery).
   */
  hasUnreadCompletion?: 'completed' | 'error' | 'interrupted';
  /** Result identity from a lightweight summary that may precede transcript hydration. */
  unreadCompletionTurnId?: string;
  unreadCompletionGeneration?: number;

  /**
   * Set when a session requires user attention while not the active session.
   * This is a high-priority alert that takes precedence over hasUnreadCompletion.
   * 'ask_user' → session has pending AskUserQuestion waiting for answer
   * 'tool_confirm' → session has pending tool confirmations
   * Cleared when the user switches to the session or the pending action is resolved.
   */
  needsUserAttention?: 'ask_user' | 'tool_confirm';

  /** Per-run reviewer manifest for Deep Review child sessions. */
  deepReviewRunManifest?: ReviewTeamRunManifest;

  /** Runtime-admitted live projection of a focused Review label. */
  focusedReviewDisplayLabel?: string;

  /** Immutable target identity used to associate Review results with a PR or Git target. */
  reviewTargetEvidence?: ReviewTargetEvidence;

  /** Original file scope for Review remediation follow-ups. */
  reviewTargetFilePaths?: string[];

  /**
   * Runtime-only session that should stay in memory but never be persisted or
   * shown in the main session navigation.
   */
  isTransient?: boolean;

  /** Transient UI session backed by a real agent session. */
  agentBackedTransient?: boolean;
}

export interface SessionConfig {
  modelName?: string;
  /** Explicit reasoning preset for the next turn; omitted means model default. */
  reasoningPreset?: string;
  agentType?: string;
  context?: Record<string, string>;
  workspacePath?: string;
  /** Main project scope used for persistence when execution happens in a worktree. */
  projectWorkspacePath?: string;
  /** Requested target used only while creating a new session. */
  executionTargetRequest?: import('@/infrastructure/api/service-api/WorktreeAPI').SessionExecutionTargetRequest;
  /** Resolved target returned and persisted by the backend. */
  executionTarget?: import('@/infrastructure/api/service-api/WorktreeAPI').SessionExecutionTarget;
  /** Requested device on which a new session will execute. */
  dispatchTargetRequest?: import('@/features/dispatch/types').DispatchTargetRequest;
  /** Immutable resolved target for an observer-only dispatched session. */
  dispatchTarget?: import('@/features/dispatch/types').DispatchTarget;
  /** Durable target-side job observed by this projection. */
  dispatchJobId?: string;
  /** Explicit unattended permission behavior selected before submission. */
  dispatchApprovalPolicy?: import('@/features/dispatch/types').DispatchApprovalPolicy;
  /** Carry the baseline worktree's uncommitted changes into the base commit. */
  dispatchIncludeUncommitted?: boolean;
  /** Git revision used to create the immutable dispatch baseline. */
  dispatchBaseRef?: string;
  /** Target model explicitly selected during preflight; omitted to use the target default. */
  dispatchModel?: string;
  /** Target-owned canonical reasoning projection reported during preflight. */
  dispatchModelCatalog?: import('@/infrastructure/api/service-api/AIApi').AIModelCatalog;
  /** Target reasoning preset. `auto` explicitly clears a prior override. */
  dispatchReasoningPreset?: string;
  /** Model ids reported by the selected target during dispatch preflight. */
  dispatchAvailableModels?: string[];
  /** Target-owned default model reported during dispatch preflight. */
  dispatchDefaultModel?: string;
  /** Last target-side job state applied by the observer. */
  dispatchJobState?: import('@/features/dispatch/types').DispatchJobState;
  /** Byte cursor applied successfully from the target-side event log. */
  dispatchCursor?: number;
  /** Last target-side job error, if any. */
  dispatchLastError?: string;
  /**
   * Composer-only preference for an empty session. The concrete worktree is
   * materialized after the first prompt is submitted, not when the checkbox
   * is clicked.
   */
  worktreeIsolationRequested?: boolean;
  /** Binds session to `WorkspaceInfo.id` (path alone is insufficient for remotes). */
  workspaceId?: string;
  projectWorkspaceId?: string;
  /** Disambiguates sessions when multiple remote workspaces share the same `workspacePath`. */
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

/**
 * A user message queued by the frontend while the session's current dialog turn
 * is still running. Items are persisted per-session and consumed in FIFO order
 * once the session returns to IDLE; users may also "send now" to inject the item
 * mid-turn (Codex-style steering) via the new `steer_dialog_turn` Tauri command.
 */
export interface QueuedComposerDraft {
  /** Original editor value before transport-specific prompt expansion. */
  value: string;
  /** Composer-owned context chips, including the original image attachments. */
  contexts: ContextItem[];
  /** Large-paste substitutions needed to expand placeholders on resubmission. */
  pendingLargePastes: Record<string, string>;
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  /** Rendered content sent to the model (may equal `displayMessage`). */
  content: string;
  /** Original user-visible text used by the queue UI and steering display. */
  displayMessage?: string;
  timestamp: number;
  /**
   * Lifecycle:
   * - `queued`: waiting in FIFO; eligible for auto-drain when session goes IDLE.
   * - `sending`: drain in progress (becoming a new dialog turn).
   * - `sending_now`: user explicitly steered the running turn with this item.
   * - `failed`: auto-restored from a failed turn — auto-drain is suppressed
   *   and the user must edit / send-now / delete to clear it (avoids reentry
   *   into the same failure loop).
   */
  status: 'queued' | 'sending' | 'sending_now' | 'failed';
  retryCount: number;
  /** Agent type / mode in effect when the user enqueued the message. */
  agentType?: string;
  /** Image / attachment payloads forwarded to `start_dialog_turn` when drained. */
  imageContexts?: unknown[];
  imageDisplayData?: unknown[];
  /** Optional for upgrade compatibility with queues persisted by older builds. */
  composerDraft?: QueuedComposerDraft;
  /** Structured metadata forwarded to `start_dialog_turn` when drained. */
  userMessageMetadata?: Record<string, unknown>;
  localDialogTurnId?: string;
}

export interface ParsedChunk {
  type: 'text' | 'tool_call' | 'tool_result';
  content: string;
  toolInfo?: {
    tool: string;
    input: any;
    id: string;
  };
  toolResult?: {
    id: string;
    result: any;
    success: boolean;
    error?: string;
  };
}

export interface ToolCardConfig {
  attention: 'ambient' | 'prominent';
  presentation: 'standard' | 'dedicated';
  toolName: string;
  displayName: string;
  icon: string;
  requiresConfirmation: boolean;
  resultDisplayType: 'hidden' | 'summary' | 'detailed';
  description?: string;
  displayMode?: 'compact' | 'standard' | 'detailed' | 'terminal';
  primaryColor?: string;
}

export type ToolCardDisplayContext = 'default' | 'subagent-projection';

export interface ToolCardProps {
  toolItem: FlowToolItem;
  config: ToolCardConfig;
  interruptionNote?: string | null;
  onOpenInEditor?: (filePath: string) => void;
  onOpenInPanel?: (panelType: string, data: any) => void;
  onExpand?: () => void;
  sessionId?: string;
  turnId?: string;
  displayContext?: ToolCardDisplayContext;
  /**
   * Whether this card is the current visual tail of the conversation.
   * Live cards use this to keep their final result visible until a newer
   * action arrives, instead of collapsing in the same frame as completion.
   */
  isLastItem?: boolean;
  /** Callback for MCP App ui/message requests. Returns whether the message was handled successfully. */
  onMcpAppMessage?: (params: import('@/infrastructure/api/service-api/MCPAPI').McpUiMessageParams) => Promise<import('@/infrastructure/api/service-api/MCPAPI').McpUiMessageResult>;
}

// Flow Chat callbacks for layered events.
export interface FlowChatCallbacks {
  onDialogTurnStart?: (dialogTurnId: string, userMessage: string) => void;
  onDialogTurnComplete?: (dialogTurnId: string, totalModelRounds: number) => void;
  onModelRoundStart?: (dialogTurnId: string, modelRoundId: string, roundIndex: number) => void;
  onModelRoundContent?: (
    dialogTurnId: string, 
    modelRoundId: string, 
    contentType: 'text' | 'tool_call' | 'tool_result' | 'thinking',
    content: string,
    metadata?: any
  ) => void;
  onModelRoundEnd?: (dialogTurnId: string, modelRoundId: string, status: string) => void;
  onTaskComplete?: (totalDialogTurns: number, result?: any) => void;
  onTaskError?: (error: string, dialogTurnId?: string, modelRoundId?: string) => void;
}

// Flow Chat actions.
export interface FlowChatActions {
  sendMessage: (message: string, sessionId?: string) => Promise<void>;
  createSession: (config?: Partial<SessionConfig>) => Promise<string>;
  switchSession: (sessionId: string) => void;
  confirmTool: (toolId: string) => void;
  rejectTool: (toolId: string) => void;
  clearSession: (sessionId?: string) => void;
  deleteSession: (sessionId: string) => Promise<void>; // Now async.
  retryLastMessage: () => void;
}
