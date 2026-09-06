//! Narrow service boundary for the pinned LoopX CLI adapter.

use super::types::{
    LoopxCliGoalState, LoopxCurrentTodo, LoopxEventCursor, LoopxIntakeCandidate, LoopxIntakeTarget,
    LoopxIssueKey, LoopxPermissionScope, LoopxRemoteItemState, LoopxRepositoryKey,
    LoopxTurnOutputEvent,
};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

pub type LoopxCliFuture<'a, T> = Pin<Box<dyn Future<Output = LoopxCliResult<T>> + Send + 'a>>;
pub type LoopxCliResult<T> = Result<T, LoopxCliError>;

fn default_loopx_version() -> String {
    super::types::LOOPX_PINNED_VERSION.to_string()
}

fn default_cli_schema_version() -> u32 {
    super::types::LOOPX_CLI_SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliErrorKind {
    #[default]
    Backend,
    InvalidInput,
    NotFound,
    VersionMismatch,
    SchemaMismatch,
    Conflict,
    Cancelled,
    Timeout,
    Process,
    Io,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliError {
    pub kind: LoopxCliErrorKind,
    pub message: String,
    pub operation_id: Option<String>,
    pub retryable: bool,
}

impl LoopxCliError {
    pub fn new(kind: LoopxCliErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            operation_id: None,
            retryable: false,
        }
    }

    pub fn for_operation(mut self, operation_id: impl Into<String>) -> Self {
        self.operation_id = Some(operation_id.into());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

impl std::fmt::Display for LoopxCliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for LoopxCliError {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliCallContext {
    pub operation_id: String,
    pub deadline_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliGoalContext {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
    pub task_id: String,
    pub generation: u64,
    pub worktree_path: String,
    pub registry_path: String,
    /// Execution capabilities exposed by the selected Agent host. These are
    /// observed technical facts, not permission grants.
    pub available_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliProgressStage {
    #[default]
    StartingSidecar,
    InstallingRuntime,
    Handshake,
    ResolvingIntake,
    PlanningItem,
    CreatingGoal,
    InspectingGoal,
    BuildingTurn,
    AnsweringGate,
    SettlingTurn,
    Cancelling,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliProgress {
    pub operation_id: String,
    pub task_id: Option<String>,
    pub stage: LoopxCliProgressStage,
    pub message: String,
    pub occurred_at: i64,
}

/// Synchronous projection hook; the controller persists and broadcasts events.
pub trait LoopxCliProgressSink: Send + Sync {
    fn report(&self, progress: LoopxCliProgress);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliSource {
    #[default]
    Unknown,
    Bundled,
    System,
    PythonFallback,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliExecutableIdentity {
    pub source: LoopxCliSource,
    /// Adapter-owned executable identifier; never an argv fragment.
    pub identity: String,
    pub path: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliHandshakeRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
    #[serde(default = "default_loopx_version")]
    pub required_loopx_version: String,
    #[serde(default = "default_cli_schema_version")]
    pub required_schema_version: u32,
}

impl Default for LoopxCliHandshakeRequest {
    fn default() -> Self {
        Self {
            call: LoopxCliCallContext::default(),
            required_loopx_version: default_loopx_version(),
            required_schema_version: default_cli_schema_version(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliManifest {
    pub adapter_version: String,
    pub loopx_version: String,
    pub schema_version: u32,
    pub executable: LoopxCliExecutableIdentity,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliInstallManagedSourceRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliInstallManagedSourceResult {
    pub source_repository: String,
    pub source_tag: String,
    pub source_commit: String,
    pub install_path: String,
    pub loopx_version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliTodoPlan {
    pub role: String,
    pub task_class: String,
    pub action_kind: Option<String>,
    pub text: String,
    /// Stable workflow target key for this todo, when provided.
    pub target_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliResolveIntakeRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
    pub input: String,
    pub target: LoopxIntakeTarget,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliResolveIntakeResult {
    pub target: LoopxIntakeTarget,
    pub repository: LoopxRepositoryKey,
    pub candidates: Vec<LoopxIntakeCandidate>,
    pub truncated: bool,
    pub resolved_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxGithubAuthProbeRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
}

/// Result of the pre-flight GitHub access probe. The host surfaces this as the
/// `github_auth` environment fact so an auth/rate-limit failure is visible
/// before the user submits an intake, instead of surfacing as a 403 later.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxGithubAuthProbe {
    /// Whether an authenticated GitHub identity is available.
    pub authenticated: bool,
    /// Remaining core API rate limit, when the endpoint reports one.
    pub rate_limit_remaining: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliPlanItemRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub item: LoopxIssueKey,
    /// Public title already resolved by the host intake adapter. The LoopX
    /// process receives this as inline metadata and must not refetch it.
    pub title: String,
    /// Remote item state observed by the host intake adapter. LoopX treats
    /// GitHub as the source of truth, so the workflow plan must receive the
    /// state the adapter actually resolved instead of a fabricated default.
    pub state: LoopxRemoteItemState,
    /// Bounded label names observed by the host intake adapter (capped to
    /// match LoopX's own metadata projection). LoopX intake classification
    /// and code-context routing use these as routing hints.
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliIntakePlan {
    pub item: LoopxIssueKey,
    pub objective: String,
    pub todos: Vec<LoopxCliTodoPlan>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliCreateGoalRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub goal_id: String,
    pub agent_id: String,
    pub intake: LoopxCliIntakePlan,
    pub granted_scopes: Vec<LoopxPermissionScope>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliCreateGoalResult {
    pub goal_id: String,
    pub created: bool,
    pub durable_revision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliInspectGoalRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub goal_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliRunDecision {
    #[default]
    Wait,
    RunNow,
    WaitingForUser,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliUserGate {
    pub gate_id: String,
    pub message: String,
    pub action_kind: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliGoalSnapshot {
    pub goal_id: String,
    pub state: LoopxCliGoalState,
    pub durable_revision: String,
    pub run_decision: LoopxCliRunDecision,
    pub scheduler_hint_ms: Option<u64>,
    pub open_todo_count: u32,
    pub waiting_user_todo_count: u32,
    pub pending_user_gate: Option<LoopxCliUserGate>,
    /// Read-only projection of the frontier todo selected by the same LoopX
    /// envelope. Absent when LoopX did not select a todo; never authoritative.
    pub selected_todo: Option<LoopxCurrentTodo>,
    /// Read-only projection of the autonomous replan obligation the same
    /// envelope carries (`replan_action_packet.obligation_id`). When the
    /// plan runs dry (no open todo, no selected todo) the pinned CLI still
    /// projects `should_run=true` with this obligation and expects the host
    /// to drive one bounded autonomous replan turn bound to it: the agent
    /// writes back a successor todo, a typed terminal outcome, or a concrete
    /// blocker through the replan writeback. Only a todo-less `RunNow`
    /// frontier WITHOUT an open obligation is a host contract contradiction.
    /// Absent when the envelope carries no replan obligation.
    pub pending_replan_obligation_id: Option<String>,
    /// LoopX returned the turn envelope over its compaction budget
    /// (`compaction.within_budget == false`, route `contract_error`): the goal
    /// cannot be planned until its durable state shrinks. The host must not
    /// fail the task for this; it degrades to a loud backoff-and-retry wait.
    pub envelope_over_budget: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliBuildTurnRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub goal_id: String,
    pub agent_id: String,
    pub expected_durable_revision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliBuildTurnResult {
    pub goal_id: String,
    pub turn_id: String,
    /// Stable custom-runner re-entry instruction derived from the fresh LoopX
    /// TurnEnvelope. It is not a cached LoopX packet or rewritten heartbeat.
    #[serde(alias = "prompt")]
    pub agent_instruction: String,
    pub settlement_token: String,
    pub durable_revision: String,
    pub deadline_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliGateDecision {
    #[default]
    Approve,
    Reject,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliAnswerGateRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub goal_id: String,
    pub agent_id: String,
    pub gate_id: String,
    pub decision: LoopxCliGateDecision,
    pub note: Option<String>,
    pub granted_scope: Option<LoopxPermissionScope>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliAnswerGateResult {
    pub goal_id: String,
    pub gate_id: String,
    pub applied: bool,
    pub durable_revision: String,
    pub goal_state: LoopxCliGoalState,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxAgentTurnStatus {
    #[default]
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliSettleTurnRequest {
    #[serde(flatten)]
    pub context: LoopxCliGoalContext,
    pub goal_id: String,
    pub agent_id: String,
    pub turn_id: String,
    pub settlement_token: String,
    pub expected_durable_revision: String,
    pub agent_status: LoopxAgentTurnStatus,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliSettlementStatus {
    #[default]
    Settled,
    AlreadySettled,
    NoDurableProgress,
    RetryRequired,
    GoalCompleted,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliSettleTurnResult {
    pub goal_id: String,
    pub turn_id: String,
    pub receipt_id: String,
    pub status: LoopxCliSettlementStatus,
    pub before_revision: String,
    pub after_revision: String,
    pub validation_succeeded: bool,
    pub scheduler_hint_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliCancelRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
    pub target_operation_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliCancelResult {
    pub operation_id: String,
    pub target_operation_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliResetGoalsRequest {
    #[serde(flatten)]
    pub call: LoopxCliCallContext,
    pub goal_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCliResetGoalsResult {
    pub requested_goal_ids: Vec<String>,
    pub retired_goal_ids: Vec<String>,
    pub already_absent_goal_ids: Vec<String>,
    pub archived_goal_ids: Vec<String>,
    pub missing_runtime_goal_ids: Vec<String>,
    pub backup_paths: Vec<String>,
    pub archive_paths: Vec<String>,
}

/// Typed LoopX operations. No caller can pass raw CLI arguments through this port.
pub trait LoopxCliPort: Send + Sync {
    fn install_managed_source<'a>(
        &'a self,
        request: LoopxCliInstallManagedSourceRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliInstallManagedSourceResult>;

    fn handshake<'a>(
        &'a self,
        request: LoopxCliHandshakeRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliManifest>;

    fn resolve_intake<'a>(
        &'a self,
        request: LoopxCliResolveIntakeRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliResolveIntakeResult>;

    fn probe_github_auth<'a>(
        &'a self,
        request: LoopxGithubAuthProbeRequest,
    ) -> LoopxCliFuture<'a, LoopxGithubAuthProbe>;

    fn plan_item<'a>(
        &'a self,
        request: LoopxCliPlanItemRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliIntakePlan>;

    fn create_goal<'a>(
        &'a self,
        request: LoopxCliCreateGoalRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliCreateGoalResult>;

    fn inspect_goal<'a>(
        &'a self,
        request: LoopxCliInspectGoalRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliGoalSnapshot>;

    fn build_turn<'a>(
        &'a self,
        request: LoopxCliBuildTurnRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliBuildTurnResult>;

    fn answer_gate<'a>(
        &'a self,
        request: LoopxCliAnswerGateRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliAnswerGateResult>;

    /// Probes whether the authenticated GitHub identity can merge pull
    /// requests in the goal's repository. `Ok(None)` means unknown (no
    /// credential, probe failure, or unsupported provider); callers must fail
    /// open to the interactive gate instead of guessing.
    fn viewer_merge_authority<'a>(
        &'a self,
        context: &'a LoopxCliGoalContext,
        repository: &'a LoopxRepositoryKey,
    ) -> LoopxCliFuture<'a, Option<bool>>;

    /// Verify one external-host turn from LoopX-owned durable writeback. This
    /// read boundary must never repair, synthesize, or spend on the Agent's
    /// behalf.
    fn verify_turn_settlement<'a>(
        &'a self,
        request: LoopxCliSettleTurnRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliSettleTurnResult>;

    /// Retires explicit global routes and archives their runtime state after
    /// an explicit product reset has removed the corresponding workspaces.
    fn reset_goals<'a>(
        &'a self,
        request: LoopxCliResetGoalsRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliResetGoalsResult>;

    fn cancel<'a>(
        &'a self,
        request: LoopxCliCancelRequest,
        progress: &'a dyn LoopxCliProgressSink,
    ) -> LoopxCliFuture<'a, LoopxCliCancelResult>;
}

pub type LoopxHostFuture<'a, T> = Pin<Box<dyn Future<Output = LoopxHostResult<T>> + Send + 'a>>;
pub type LoopxHostResult<T> = Result<T, LoopxHostPortError>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxHostPortErrorKind {
    #[default]
    Backend,
    InvalidInput,
    NotFound,
    Unsupported,
    Conflict,
    Cancelled,
    Timeout,
    Io,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxHostPortError {
    pub kind: LoopxHostPortErrorKind,
    pub message: String,
    pub operation_id: Option<String>,
    pub retryable: bool,
}

impl LoopxHostPortError {
    pub fn new(kind: LoopxHostPortErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            operation_id: None,
            retryable: false,
        }
    }
}

impl std::fmt::Display for LoopxHostPortError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for LoopxHostPortError {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspacePrepareRequest {
    pub operation_id: String,
    pub task_id: String,
    pub item: LoopxIssueKey,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceProbeRequest {
    pub operation_id: String,
    /// When present, also verifies that Git can read the canonical repository.
    pub repository: Option<super::types::LoopxRepositoryKey>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceProbeResult {
    pub git_version: Option<String>,
    pub workspace_root: String,
    pub repository_verified: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspacePrepareResult {
    pub worktree_path: String,
    pub registry_path: String,
    pub reused: bool,
    pub repository_verified: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceVerifyRequest {
    pub operation_id: String,
    pub task_id: String,
    pub item: LoopxIssueKey,
    pub worktree_path: String,
    pub registry_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceVerifyResult {
    pub valid: bool,
    pub repository: Option<super::types::LoopxRepositoryKey>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceCancelRequest {
    pub operation_id: String,
    pub target_operation_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceCancelResult {
    pub target_operation_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceDisposeRequest {
    pub operation_id: String,
    pub task_id: String,
    pub item: LoopxIssueKey,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceDisposeResult {
    /// The worktree (and, when it was the last reference, the shared bare
    /// repository) was removed from disk.
    pub removed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceResetRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspaceResetResult {
    /// Task worktrees were detached from the active root. Implementations may
    /// reclaim them asynchronously and retain verified bare Git object caches.
    pub removed: bool,
}

/// Creates or reuses an isolated worktree for exactly one canonical item.
pub trait LoopxWorkspacePort: Send + Sync {
    fn probe(
        &self,
        request: LoopxWorkspaceProbeRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspaceProbeResult>;

    fn prepare(
        &self,
        request: LoopxWorkspacePrepareRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspacePrepareResult>;

    fn verify(
        &self,
        request: LoopxWorkspaceVerifyRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspaceVerifyResult>;

    fn cancel(
        &self,
        request: LoopxWorkspaceCancelRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspaceCancelResult>;

    /// Removes the task worktree after terminal settlement. With the shared
    /// bare-repository layout this also removes the bare repo once its last
    /// worktree is gone. The caller must guarantee the task is terminal.
    fn dispose(
        &self,
        request: LoopxWorkspaceDisposeRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspaceDisposeResult>;

    /// Removes every managed LoopX workspace and goal registry under the
    /// service-owned root. This is reserved for explicit full-reset actions.
    fn reset(
        &self,
        request: LoopxWorkspaceResetRequest,
    ) -> LoopxHostFuture<'_, LoopxWorkspaceResetResult>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentTurnMetadata {
    pub goal_id: String,
    pub loopx_turn_id: String,
    pub item: LoopxIssueKey,
    pub attempt: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentStartRequest {
    pub operation_id: String,
    pub task_id: String,
    pub generation: u64,
    pub worktree_path: String,
    #[serde(alias = "prompt")]
    pub instruction: String,
    pub model_id: String,
    pub granted_scopes: Vec<LoopxPermissionScope>,
    pub metadata: LoopxAgentTurnMetadata,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentStartResult {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentProbeRequest {
    pub operation_id: String,
    /// `None`, `auto`, and `primary` all validate the configured primary model.
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentProbeResult {
    pub model_id: String,
    pub supports_images: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentCancelRequest {
    pub operation_id: String,
    pub target_operation_id: String,
    pub task_id: String,
    pub generation: u64,
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentCancelResult {
    pub target_operation_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentFinishRequest {
    pub operation_id: String,
    pub task_id: String,
    pub generation: u64,
    pub worktree_path: String,
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentFinishResult {
    pub session_id: String,
    pub discarded: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentResetRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentResetResult {
    pub removed_runtime_event_logs: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentOutputSinceRequest {
    pub operation_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub stream_id: Option<String>,
    pub after_cursor: LoopxEventCursor,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAgentOutputSinceResult {
    pub stream_id: Option<String>,
    pub events: Vec<LoopxTurnOutputEvent>,
    pub next_cursor: LoopxEventCursor,
    pub has_more: bool,
}

/// Starts fresh transient Agent sessions bound to the prepared worktree.
pub trait LoopxAgentPort: Send + Sync {
    /// Reports technical execution capabilities of this concrete Agent host.
    /// These facts never imply user permission for an individual task.
    fn available_capabilities(&self) -> Vec<String>;

    fn probe(&self, request: LoopxAgentProbeRequest) -> LoopxHostFuture<'_, LoopxAgentProbeResult>;

    fn start(&self, request: LoopxAgentStartRequest) -> LoopxHostFuture<'_, LoopxAgentStartResult>;

    fn cancel(
        &self,
        request: LoopxAgentCancelRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentCancelResult>;

    /// Discards the fresh transient session after terminal settlement.
    fn finish(
        &self,
        request: LoopxAgentFinishRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentFinishResult>;

    /// Removes LoopX-owned transient Agent diagnostics after every active
    /// session has been cancelled and discarded.
    fn reset(&self, request: LoopxAgentResetRequest) -> LoopxHostFuture<'_, LoopxAgentResetResult>;

    /// Reads the in-flight Agent turn output projection. Completed turns may
    /// already have handed their data back to session persistence and discarded
    /// this transient projection.
    fn output_since(
        &self,
        request: LoopxAgentOutputSinceRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentOutputSinceResult>;
}
