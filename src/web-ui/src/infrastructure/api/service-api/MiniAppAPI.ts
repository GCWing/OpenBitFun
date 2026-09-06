import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EsmDep {
  name: string;
  version?: string;
  url?: string;
}

export interface NpmDep {
  name: string;
  version: string;
}

export interface MiniAppSource {
  html: string;
  css: string;
  ui_js: string;
  esm_dependencies: EsmDep[];
  worker_js: string;
  npm_dependencies: NpmDep[];
}

export interface MiniAppPermissions {
  fs?: { read?: string[]; write?: string[] };
  shell?: { allow?: string[] };
  net?: { allow?: string[] };
  node?: { enabled?: boolean; max_memory_mb?: number; timeout_ms?: number };
  ai?: {
    enabled?: boolean;
    allowed_models?: string[];
    max_tokens_per_request?: number;
    rate_limit_per_minute?: number;
  };
  agent?: {
    enabled?: boolean;
    rate_limit_per_minute?: number;
  };
  notifications?: { system?: boolean };
  host?: {
    dialog?: boolean;
    clipboard_read?: boolean;
    clipboard_write?: boolean;
    open_external?: boolean;
    reveal_in_folder?: boolean;
    deck_render?: boolean;
    chat_composer?: boolean;
    system_info?: boolean;
  };
}

// ─── AI Types ─────────────────────────────────────────────────────────────────

export interface AiCompleteOptions {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompleteResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiChatStartedResult {
  streamId: string;
}

export interface AiModelInfo {
  id: string;
  /** User-defined configuration name. */
  name: string;
  /** Actual model identifier shown in the host chat model picker. */
  modelName: string;
  provider: string;
  isDefault: boolean;
}

// ─── Agent bridge types ───────────────────────────────────────────────────────

export interface AgentContextFile {
  /** Plain file name exposed through a host-owned virtual snapshot under `.miniapp-context`. */
  name: string;
  /** UTF-8 app-supplied context treated as untrusted data by the Agent prompt. */
  content: string;
}

export interface AgentRunOptions {
  runId?: string;
  sessionName?: string;
  /**
   * User-facing request shown in the shared conversation surface. The full
   * `prompt` remains the MiniApp-owned agent protocol.
   */
  displayText?: string;
  /** Defaults to true host-side; only applies when a new session is created. */
  enableTools?: boolean;
  /** Reuse an existing hidden agent session from an earlier run of this app. */
  sessionId?: string;
  /**
   * Relative subdirectory inside the app's own appdata directory to use as
   * the agent workspace (file-protocol apps keep agent outputs there).
   */
  appDataWorkspace?: string;
  /**
   * Model selector for the hidden Cowork session (`primary`, `fast`, or a
   * concrete model config id). Applied on create and on session reuse.
   */
  model?: string;
  /**
   * Bounded context files exposed through a host-owned immutable virtual snapshot.
   * Marketplace Agents may Read/Grep only that exact per-run scope.
   */
  contextFiles?: AgentContextFile[];
}

export interface AgentRunStartedResult {
  sessionId: string;
  turnId: string;
  actionRunId: string;
  status: string;
}

export interface AgentEnsureSessionOptions {
  /** Rebind to the session already associated with this MiniApp topic. */
  sessionId?: string;
  sessionName?: string;
  /** Relative workspace inside the MiniApp's own appdata directory. */
  appDataWorkspace: string;
  /** Defaults to true host-side and applies only when a session is created. */
  enableTools?: boolean;
  /** Model selector applied on create and when reusing an existing session. */
  model?: string;
}

export interface AgentEnsureSessionResult {
  sessionId: string;
  workspacePath: string;
  created: boolean;
}

export interface AgentTurnTextResult {
  text: string;
}

export interface AgentCancelStaleRunsResult {
  cancelledRuns: number;
}

// ─── LoopX controller types ──────────────────────────────────────────────────

export type LoopxItemKind = 'issue' | 'pr';

export interface LoopxRepositoryKey {
  host: string;
  owner: string;
  repository: string;
}

export interface LoopxIssueKey {
  repository: LoopxRepositoryKey;
  kind: LoopxItemKind;
  number: number;
}

export type LoopxIntakeTarget =
  | { targetType: 'repository'; repository: LoopxRepositoryKey }
  | { targetType: 'item'; item: LoopxIssueKey };

export type LoopxRemoteItemState = 'unknown' | 'open' | 'closed' | 'merged';

export interface LoopxIntakeCandidate {
  key: LoopxIssueKey;
  url: string;
  title: string;
  state: LoopxRemoteItemState;
  stateReason: string | null;
  fromRepository: boolean;
  hasImages: boolean;
  defaultSelected: boolean;
}

export type LoopxWorkspaceDisposition =
  | 'existing_worktree'
  | 'new_worktree'
  | 'clone_required'
  | 'unavailable';

export interface LoopxWorkspacePreview {
  disposition: LoopxWorkspaceDisposition;
  path: string | null;
  repositoryVerified: boolean;
}

export interface LoopxModelCapability {
  modelId: string;
  available: boolean;
  supportsImages: boolean;
}

export type LoopxPermissionScope =
  | 'workspace_read'
  | 'workspace_write'
  | 'git_local'
  | 'github_read'
  | 'agent_execution'
  | 'publish'
  | 'public_comment'
  | 'pull_request'
  | 'merge'
  | 'production_action';

export interface LoopxIntakePreview {
  fingerprint: string;
  target: LoopxIntakeTarget;
  repository: LoopxRepositoryKey;
  workspace: LoopxWorkspacePreview;
  candidates: LoopxIntakeCandidate[];
  truncated: boolean;
  model: LoopxModelCapability;
  permissionScopes: LoopxPermissionScope[];
  resolvedAt: number;
  expiresAt: number | null;
}

export type LoopxEnvironmentFactStatus =
  | 'unknown'
  | 'checking'
  | 'available'
  | 'degraded'
  | 'unavailable';

export interface LoopxEnvironmentFact {
  status: LoopxEnvironmentFactStatus;
  version: string | null;
  detail: string | null;
  remediation: string | null;
  remediationAction: 'none' | 'install_loopx';
  checkedAt: number | null;
}

export interface LoopxCoreEnvironmentFacts {
  sidecar: LoopxEnvironmentFact;
  gitWorktree: LoopxEnvironmentFact;
  agentModel: LoopxEnvironmentFact;
}

export interface LoopxOptionalEnvironmentFacts {
  pythonFallback: LoopxEnvironmentFact;
  githubAuth: LoopxEnvironmentFact;
}

export type LoopxEnvironmentStatus = 'unknown' | 'checking' | 'ready' | 'degraded' | 'blocked';

export interface LoopxEnvironmentSnapshot {
  revision: number;
  status: LoopxEnvironmentStatus;
  core: LoopxCoreEnvironmentFacts;
  optional: LoopxOptionalEnvironmentFacts;
  checkedAt: number | null;
}

export type LoopxTaskState =
  | 'preparing'
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'retry_wait'
  | 'cancelling'
  | 'stopped'
| 'aborted'
  | 'recovery_required'
  | 'completed'
  | 'failed'
  | 'archived';

export type LoopxGoalState =
  | 'unknown'
  | 'active'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'archived';

export type LoopxPhase =
  | 'unknown'
  | 'validating_environment'
  | 'resolving_intake'
  | 'preparing_workspace'
  | 'creating_goal'
  | 'queued'
  | 'inspecting_goal'
  | 'building_turn'
  | 'starting_agent'
  | 'agent_running'
  | 'validating_progress'
  | 'settling_turn'
  | 'waiting_for_approval'
  | 'retry_backoff'
  | 'cancelling'
  | 'recovering'
  | 'finished';

export interface LoopxTaskIdentity {
  item: LoopxIssueKey;
  attempt: number;
  /** Issue / PR title captured at task creation; empty for legacy records. */
  title?: string;
}

export interface LoopxSettlementSummary {
  turnId: string | null;
  receiptId: string | null;
  durableRevision: string | null;
  settledAt: number | null;
}

export interface LoopxTaskSnapshot {
  taskId: string;
  batchId: string | null;
  identity: LoopxTaskIdentity;
  generation: number;
  revision: number;
  goalId: string | null;
  /** Authoritative Goal lifecycle projected from LoopX. */
  goalState: LoopxGoalState | null;
  agentId: string | null;
  /** BitFun host-job lifecycle, not the Goal authority. */
  state: LoopxTaskState;
  phase: LoopxPhase;
  pendingGateId?: string | null;
  pendingGateMessage?: string | null;
  pendingGateActionKind?: string | null;
  workspacePath: string | null;
  modelId: string | null;
  grantedScopes: LoopxPermissionScope[];
  currentTurnId: string | null;
  currentTool: string | null;
  lastOutputAt: number | null;
  deadlineAt: number | null;
  retryAt: number | null;
  error: string | null;
  settlement: LoopxSettlementSummary;
  autonomousTurnsSinceReview?: number;
  autonomyReviewBaselineReceipts?: number;
  createdAt: number;
  updatedAt: number;
}

export type LoopxExecutionDomain =
  | 'unknown'
  | 'local_desktop'
  | 'remote_workspace'
  | 'peer_device'
  | 'remote_control'
  | 'detached_dispatch';

export type LoopxExecutionSupport = 'supported' | 'unsupported_execution_domain';

export interface LoopxSnapshot {
  schemaVersion: number;
  streamId: string;
  cursor: number;
  revision: number;
  executionDomain: LoopxExecutionDomain;
  executionSupport: LoopxExecutionSupport;
  unsupportedReason: string | null;
  environment: LoopxEnvironmentSnapshot;
  tasks: LoopxTaskSnapshot[];
  generatedAt: number;
}

export type LoopxEventLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error';
export type LoopxEventSource = 'controller' | 'sidecar' | 'agent' | 'git' | 'github' | 'system';
export type LoopxEventKind =
  | 'progress'
  | 'task_created'
  | 'state_changed'
  | 'phase_changed'
  | 'log'
  | 'approval_required'
  | 'settlement_recorded'
  | 'environment_changed'
  | 'operation_cancelled'
  | 'snapshot_invalidated';

export interface LoopxEvent {
  streamId: string;
  cursor: number;
  taskId: string | null;
  generation: number | null;
  revision: number | null;
  kind: LoopxEventKind;
  level: LoopxEventLevel;
  source: LoopxEventSource;
  phase: LoopxPhase | null;
  message: string;
  important: boolean;
  toolName: string | null;
  deadlineAt: number | null;
  details: Record<string, string>;
  occurredAt: number;
}

export interface LoopxAttachRequest {
  knownStreamId?: string;
  afterCursor?: number;
  resumeDetected?: boolean;
}

export interface LoopxAttachResponse {
  snapshot: LoopxSnapshot;
}

export interface LoopxResolveIntakeRequest {
  input: string;
  modelId: string;
}

export interface LoopxResolveIntakeResponse {
  preview: LoopxIntakePreview;
}

export interface LoopxCreateTaskRequest {
  clientRequestId: string;
  previewFingerprint: string;
  selectedItems: LoopxIssueKey[];
  modelId: string;
  grantedScopes: LoopxPermissionScope[];
  retryTerminal: boolean;
}

export type LoopxCreateTaskOutcomeKind =
  | 'created'
  | 'opened_existing'
  | 'retry_confirmation_required'
  | 'closed_noop'
  | 'needs_live_verification';

export interface LoopxCreateTaskOutcome {
  item: LoopxIssueKey;
  kind: LoopxCreateTaskOutcomeKind;
  taskId: string | null;
  attempt: number | null;
  message: string | null;
}

export interface LoopxCreateTaskResponse {
  outcomes: LoopxCreateTaskOutcome[];
  snapshotRevision: number;
}

export type LoopxActionKind =
  | 'pause'
| 'abort'
  | 'resume'
  | 'resume_repository'
  | 'reset_all'
  | 'approve'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'install_loopx'
  | 'retry_environment';

export interface LoopxActionRequest {
  taskId?: string;
  repository?: LoopxRepositoryKey;
  action: LoopxActionKind;
  clientRequestId: string;
  expectedRevision: number;
  gateId?: string;
  note?: string;
}

export type LoopxActionStatus = 'applied' | 'duplicate' | 'revision_conflict' | 'rejected';

export interface LoopxActionResponse {
  status: LoopxActionStatus;
  currentRevision: number;
  task: LoopxTaskSnapshot | null;
  message: string | null;
}

export interface LoopxEventsSinceRequest {
  streamId: string;
  afterCursor: number;
  limit?: number;
}

export type LoopxEventsPageStatus = 'current' | 'snapshot_required';

export interface LoopxEventsSinceResponse {
  status: LoopxEventsPageStatus;
  streamId: string;
  events: LoopxEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export type LoopxTurnOutputStatus =
  | 'current'
  | 'task_not_found'
  | 'not_running'
  | 'stale_turn'
  | 'output_unavailable';

export type LoopxTurnOutputEventKind =
  | 'text'
  | 'thinking'
  | 'model_round_started'
  | 'model_round_completed'
  | 'tool';

export interface LoopxTurnOutputEvent {
  cursor: number;
  turnId: string;
  roundId: string | null;
  kind: LoopxTurnOutputEventKind;
  text: string | null;
  toolName: string | null;
  toolState: string | null;
  isEnd: boolean;
}

export interface LoopxTurnOutputSinceRequest {
  taskId: string;
  turnId?: string;
  streamId?: string;
  afterCursor: number;
  limit?: number;
}

export interface LoopxTurnOutputSinceResponse {
  status: LoopxTurnOutputStatus;
  taskId: string;
  turnId: string | null;
  streamId: string | null;
  events: LoopxTurnOutputEvent[];
  nextCursor: number;
  hasMore: boolean;
  message: string | null;
}

export interface LoopxExistingTask {
  taskId: string;
  identity: LoopxTaskIdentity;
  state: LoopxTaskState;
}

export interface MiniAppRuntimeState {
  source_revision: string;
  content_hash: string;
  deps_revision: string;
  deps_dirty: boolean;
  worker_restart_required: boolean;
  ui_recompile_required: boolean;
}

export type MiniAppRuntimeProfile = 'compatibility' | 'market_strict';

export interface MiniAppLocaleStrings {
  name?: string;
  description?: string;
  tags?: string[];
}

export interface MiniAppI18n {
  /** Map of locale id (e.g. "zh-CN", "en-US") to per-locale string overrides. */
  locales: Record<string, MiniAppLocaleStrings>;
}

export interface MiniAppMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tags: string[];
  version: number;
  created_at: number;
  updated_at: number;
  permissions: MiniAppPermissions;
  runtime?: MiniAppRuntimeState;
  runtime_profile?: MiniAppRuntimeProfile;
  /** Optional per-locale overrides for `name` / `description` / `tags`. */
  i18n?: MiniAppI18n;
}

export interface MiniApp extends MiniAppMeta {
  source: MiniAppSource;
  compiled_html: string;
  ai_context?: {
    original_prompt: string;
    conversation_id?: string;
    iteration_history: string[];
  };
}

export interface CreateMiniAppRequest {
  name: string;
  description: string;
  icon?: string;
  category?: string;
  tags?: string[];
  source: MiniAppSource;
  permissions?: MiniAppPermissions;
  ai_context?: { original_prompt: string };
}

export interface UpdateMiniAppRequest {
  name?: string;
  description?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  source?: MiniAppSource;
  permissions?: MiniAppPermissions;
}

export interface RuntimeStatus {
  available: boolean;
  kind?: string;
  version?: string;
  path?: string;
}

export interface InstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface RecompileResult {
  success: boolean;
  warnings?: string[];
}

// ─── API ─────────────────────────────────────────────────────────────────────

export interface MiniAppDraft {
  appId: string;
  draftId: string;
  sourceVersion: number;
  status: string;
  createdAt: number;
  updatedAt: number;
  draftRoot: string;
  app: MiniApp;
}

export interface MiniAppPermissionDiff {
  high_risk: boolean;
  added: string[];
  expanded: string[];
  removed: string[];
}

export interface MiniAppCustomizationMetadata {
  origin: {
    kind: 'builtin' | 'imported' | 'user_created' | 'market';
    builtin_id?: string;
    builtin_version?: number;
    market?: {
      listingId: string;
      releaseId: string;
      releaseNumber: number;
      packageSha256: string;
    };
  };
  local_override: boolean;
  last_applied_draft_id?: string;
  available_builtin_update?: {
    builtin_version: number;
    source_hash: string;
    detected_at: number;
  };
  declined_builtin_updates?: Array<{
    builtin_version: number;
    source_hash: string;
    declined_at: number;
    local_app_version?: number | null;
    local_app_updated_at?: number | null;
    last_applied_draft_id?: string | null;
  }>;
  updated_at: number;
}

function normalizeMiniApp(raw: MiniApp & { compiledHtml?: string }): MiniApp {
  const compiledHtml = raw.compiled_html ?? raw.compiledHtml ?? '';
  return {
    ...raw,
    compiled_html: compiledHtml,
  };
}

export class MiniAppAPI {
  async listMiniApps(): Promise<MiniAppMeta[]> {
    try {
      return await api.invoke('list_miniapps', {});
    } catch (error) {
      throw createTauriCommandError('list_miniapps', error);
    }
  }

  async getMiniApp(appId: string, appearanceMode?: string, workspacePath?: string): Promise<MiniApp> {
    try {
      const raw = await api.invoke<MiniApp & { compiledHtml?: string }>('get_miniapp', {
        request: { appId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
      const normalized = normalizeMiniApp(raw);
      return normalized;
    } catch (error) {
      throw createTauriCommandError('get_miniapp', error, { appId, workspacePath });
    }
  }

  async createMiniApp(req: CreateMiniAppRequest, workspacePath?: string): Promise<MiniApp> {
    try {
      return await api.invoke('create_miniapp', { request: { ...req, workspacePath } });
    } catch (error) {
      throw createTauriCommandError('create_miniapp', error, { workspacePath });
    }
  }

  async updateMiniApp(appId: string, req: UpdateMiniAppRequest, workspacePath?: string): Promise<MiniApp> {
    try {
      return await api.invoke('update_miniapp', { appId, request: { ...req, workspacePath } });
    } catch (error) {
      throw createTauriCommandError('update_miniapp', error, { appId, workspacePath });
    }
  }

  async deleteMiniApp(appId: string): Promise<void> {
    try {
      await api.invoke('delete_miniapp', { appId });
    } catch (error) {
      throw createTauriCommandError('delete_miniapp', error, { appId });
    }
  }

  async getMiniAppVersions(appId: string): Promise<number[]> {
    try {
      return await api.invoke('get_miniapp_versions', { appId });
    } catch (error) {
      throw createTauriCommandError('get_miniapp_versions', error);
    }
  }

  async rollbackMiniApp(appId: string, version: number): Promise<MiniApp> {
    try {
      return await api.invoke('rollback_miniapp', { appId, version });
    } catch (error) {
      throw createTauriCommandError('rollback_miniapp', error);
    }
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    try {
      return await api.invoke('miniapp_runtime_status', {});
    } catch (error) {
      throw createTauriCommandError('miniapp_runtime_status', error);
    }
  }

  async workerCall(
    appId: string,
    method: string,
    params: Record<string, unknown>,
    workspacePath?: string,
  ): Promise<unknown> {
    try {
      return await api.invoke('miniapp_worker_call', {
        request: { appId, method, params, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_worker_call', error, { appId, method, workspacePath });
    }
  }

  /**
   * Host-side framework primitive call (no Bun/Node Worker required).
   *
   * Method must be in the `fs.* / shell.* / os.* / net.*` namespace; the host
   * dispatch will reject anything else. Used for MiniApps with
   * `permissions.node.enabled = false`, and transparently invoked by the
   * iframe bridge for those apps.
   */
  async hostCall(
    appId: string,
    method: string,
    params: Record<string, unknown>,
    workspacePath?: string,
  ): Promise<unknown> {
    try {
      return await api.invoke('miniapp_host_call', {
        request: { appId, method, params, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_host_call', error, { appId, method, workspacePath });
    }
  }

  async workerStop(appId: string): Promise<void> {
    try {
      await api.invoke('miniapp_worker_stop', { appId });
    } catch (error) {
      throw createTauriCommandError('miniapp_worker_stop', error);
    }
  }

  async workerListRunning(): Promise<string[]> {
    try {
      return await api.invoke('miniapp_worker_list_running', {});
    } catch (error) {
      throw createTauriCommandError('miniapp_worker_list_running', error);
    }
  }

  async installDeps(appId: string): Promise<InstallResult> {
    try {
      return await api.invoke('miniapp_install_deps', { appId });
    } catch (error) {
      throw createTauriCommandError('miniapp_install_deps', error);
    }
  }

  async recompile(appId: string, appearanceMode?: string, workspacePath?: string): Promise<RecompileResult> {
    try {
      return await api.invoke('miniapp_recompile', {
        request: { appId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_recompile', error, { appId, workspacePath });
    }
  }

  async importFromPath(path: string, workspacePath?: string): Promise<MiniApp> {
    try {
      return await api.invoke('miniapp_import_from_path', {
        request: { path, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_import_from_path', error, { path, workspacePath });
    }
  }

  async syncFromFs(appId: string, appearanceMode?: string, workspacePath?: string): Promise<MiniApp> {
    try {
      return await api.invoke('miniapp_sync_from_fs', {
        request: { appId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_sync_from_fs', error, { appId, workspacePath });
    }
  }

  // ─── Draft commands ─────────────────────────────────────────────────────────

  async createDraft(appId: string, appearanceMode?: string, workspacePath?: string): Promise<MiniAppDraft> {
    try {
      return await api.invoke('miniapp_create_draft', {
        request: { appId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_create_draft', error, { appId, workspacePath });
    }
  }

  async getDraft(appId: string, draftId: string): Promise<MiniAppDraft> {
    try {
      return await api.invoke('miniapp_get_draft', {
        request: { appId, draftId }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_get_draft', error, { appId, draftId });
    }
  }

  async syncDraftFromFs(
    appId: string,
    draftId: string,
    appearanceMode?: string,
    workspacePath?: string,
  ): Promise<MiniAppDraft> {
    try {
      return await api.invoke('miniapp_sync_draft_from_fs', {
        request: { appId, draftId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_sync_draft_from_fs', error, { appId, draftId, workspacePath });
    }
  }

  async setDraftPermissions(
    appId: string,
    draftId: string,
    permissions: MiniAppPermissions,
    appearanceMode?: string,
    workspacePath?: string,
  ): Promise<MiniAppDraft> {
    try {
      return await api.invoke('miniapp_set_draft_permissions', {
        request: { appId, draftId, permissions, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_set_draft_permissions', error, { appId, draftId, workspacePath });
    }
  }

  async permissionDiffForDraft(appId: string, draftId: string): Promise<MiniAppPermissionDiff> {
    try {
      return await api.invoke('miniapp_permission_diff_for_draft', {
        request: { appId, draftId }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_permission_diff_for_draft', error, { appId, draftId });
    }
  }

  async applyDraft(
    appId: string,
    draftId: string,
    appearanceMode?: string,
    workspacePath?: string,
  ): Promise<MiniApp> {
    try {
      return await api.invoke('miniapp_apply_draft', {
        request: { appId, draftId, appearanceMode: appearanceMode ?? undefined, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_apply_draft', error, { appId, draftId, workspacePath });
    }
  }

  async discardDraft(appId: string, draftId: string): Promise<void> {
    try {
      await api.invoke('miniapp_discard_draft', {
        request: { appId, draftId }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_discard_draft', error, { appId, draftId });
    }
  }

  async getDraftStorage(appId: string, draftId: string, key: string): Promise<unknown> {
    try {
      return await api.invoke('get_miniapp_draft_storage', {
        request: { appId, draftId, key }
      });
    } catch (error) {
      throw createTauriCommandError('get_miniapp_draft_storage', error, { appId, draftId, key });
    }
  }

  async setDraftStorage(appId: string, draftId: string, key: string, value: unknown): Promise<void> {
    try {
      await api.invoke('set_miniapp_draft_storage', {
        request: { appId, draftId, key, value }
      });
    } catch (error) {
      throw createTauriCommandError('set_miniapp_draft_storage', error, { appId, draftId, key });
    }
  }

  async draftWorkerCall(
    appId: string,
    draftId: string,
    method: string,
    params: Record<string, unknown>,
    workspacePath?: string,
  ): Promise<unknown> {
    try {
      return await api.invoke('miniapp_draft_worker_call', {
        request: { appId, draftId, method, params, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_draft_worker_call', error, { appId, draftId, method, workspacePath });
    }
  }

  async draftHostCall(
    appId: string,
    draftId: string,
    method: string,
    params: Record<string, unknown>,
    workspacePath?: string,
  ): Promise<unknown> {
    try {
      return await api.invoke('miniapp_draft_host_call', {
        request: { appId, draftId, method, params, workspacePath }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_draft_host_call', error, { appId, draftId, method, workspacePath });
    }
  }

  async draftWorkerStop(appId: string, draftId: string): Promise<void> {
    try {
      await api.invoke('miniapp_draft_worker_stop', {
        request: { appId, draftId }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_draft_worker_stop', error, { appId, draftId });
    }
  }

  async getCustomizationMetadata(appId: string): Promise<MiniAppCustomizationMetadata | null> {
    try {
      return await api.invoke('miniapp_get_customization_metadata', { appId });
    } catch (error) {
      throw createTauriCommandError('miniapp_get_customization_metadata', error, { appId });
    }
  }

  async declineBuiltinUpdate(
    appId: string,
    builtinVersion: number,
    sourceHash: string,
  ): Promise<MiniAppCustomizationMetadata | null> {
    try {
      return await api.invoke('miniapp_decline_builtin_update', {
        request: { appId, builtinVersion, sourceHash }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_decline_builtin_update', error, {
        appId,
        builtinVersion,
      });
    }
  }

  // ─── AI commands ────────────────────────────────────────────────────────────

  async aiComplete(appId: string, prompt: string, options?: AiCompleteOptions): Promise<AiCompleteResult> {
    try {
      return await api.invoke('miniapp_ai_complete', {
        request: {
          appId,
          prompt,
          systemPrompt: options?.systemPrompt,
          model: options?.model,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
        }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_ai_complete', error, { appId });
    }
  }

  async aiChat(
    appId: string,
    messages: AiChatMessage[],
    streamId: string,
    options?: AiChatOptions,
  ): Promise<AiChatStartedResult> {
    try {
      return await api.invoke('miniapp_ai_chat', {
        request: {
          appId,
          messages,
          streamId,
          systemPrompt: options?.systemPrompt,
          model: options?.model,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
        }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_ai_chat', error, { appId, streamId });
    }
  }

  async aiCancel(appId: string, streamId: string): Promise<void> {
    try {
      await api.invoke('miniapp_ai_cancel', { request: { appId, streamId } });
    } catch (error) {
      throw createTauriCommandError('miniapp_ai_cancel', error, { appId, streamId });
    }
  }

  async aiListModels(appId: string): Promise<AiModelInfo[]> {
    try {
      return await api.invoke('miniapp_ai_list_models', { request: { appId } });
    } catch (error) {
      throw createTauriCommandError('miniapp_ai_list_models', error, { appId });
    }
  }

  // ─── Agent bridge commands ──────────────────────────────────────────────────

  async agentEnsureSession(
    appId: string,
    options: AgentEnsureSessionOptions,
  ): Promise<AgentEnsureSessionResult> {
    try {
      return await api.invoke('miniapp_agent_ensure_session', {
        request: {
          appId,
          sessionId: options.sessionId,
          sessionName: options.sessionName,
          appDataWorkspace: options.appDataWorkspace,
          enableTools: options.enableTools,
          model: options.model,
        }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_agent_ensure_session', error, { appId });
    }
  }

  async agentRun(
    appId: string,
    prompt: string,
    workspacePath?: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunStartedResult> {
    try {
      return await api.invoke('miniapp_agent_run', {
        request: {
          appId,
          prompt,
          runId: options?.runId,
          sessionName: options?.sessionName,
          displayText: options?.displayText,
          workspacePath,
          enableTools: options?.enableTools,
          sessionId: options?.sessionId,
          appDataWorkspace: options?.appDataWorkspace,
          model: options?.model,
          contextFiles: options?.contextFiles,
        }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_agent_run', error, { appId });
    }
  }

  async agentCancel(appId: string, sessionId: string, turnId: string): Promise<void> {
    try {
      await api.invoke('miniapp_agent_cancel', { request: { appId, sessionId, turnId } });
    } catch (error) {
      throw createTauriCommandError('miniapp_agent_cancel', error, { appId, sessionId, turnId });
    }
  }

  async agentTurnText(appId: string, sessionId: string, turnId: string): Promise<AgentTurnTextResult> {
    try {
      return await api.invoke('miniapp_agent_turn_text', { request: { appId, sessionId, turnId } });
    } catch (error) {
      throw createTauriCommandError('miniapp_agent_turn_text', error, { appId, sessionId, turnId });
    }
  }

  async agentCancelStaleRuns(appId: string): Promise<AgentCancelStaleRunsResult> {
    try {
      return await api.invoke('miniapp_agent_cancel_stale_runs', { request: { appId } });
    } catch (error) {
      throw createTauriCommandError('miniapp_agent_cancel_stale_runs', error, { appId });
    }
  }

  /**
   * Render one slide HTML page in a hidden host WebView and return base64
   * PNG/PDF data. Desktop-only; used for page-by-page deck export.
   */
  async renderSlidePage(
    appId: string,
    options: { html: string; format: string; width?: number; height?: number },
  ): Promise<string> {
    try {
      return await api.invoke('miniapp_render_slide_page', {
        request: {
          html: options.html,
          format: options.format,
          width: options.width,
          height: options.height,
        }
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_render_slide_page', error, { appId });
    }
  }
}

export const miniAppAPI = new MiniAppAPI();
