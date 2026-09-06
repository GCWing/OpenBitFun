//! Stable LoopX MiniApp wire types.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const LOOPX_BUILTIN_APP_ID: &str = "builtin-bitfun-loopx";
pub const LOOPX_PINNED_VERSION: &str = "0.5.1";
pub const LOOPX_CLI_SCHEMA_VERSION: u32 = 1;

pub type LoopxEventCursor = u64;

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxRepositoryKey {
    pub host: String,
    pub owner: String,
    pub repository: String,
}

impl LoopxRepositoryKey {
    pub fn canonical_id(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.repository)
    }

    pub fn label(&self) -> String {
        format!("{}/{}", self.owner, self.repository)
    }
}

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum LoopxItemKind {
    #[default]
    Issue,
    #[serde(rename = "pr", alias = "pull_request")]
    PullRequest,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxIssueKey {
    pub repository: LoopxRepositoryKey,
    pub kind: LoopxItemKind,
    pub number: u64,
}

impl LoopxIssueKey {
    pub fn canonical_id(&self) -> String {
        let collection = match self.kind {
            LoopxItemKind::Issue => "issues",
            LoopxItemKind::PullRequest => "pull",
        };
        format!(
            "{}/{}/{}",
            self.repository.canonical_id(),
            collection,
            self.number
        )
    }

    pub fn canonical_url(&self) -> String {
        format!("https://{}", self.canonical_id())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "targetType", rename_all = "snake_case")]
pub enum LoopxIntakeTarget {
    Repository { repository: LoopxRepositoryKey },
    Item { item: LoopxIssueKey },
}

impl Default for LoopxIntakeTarget {
    fn default() -> Self {
        Self::Repository {
            repository: LoopxRepositoryKey::default(),
        }
    }
}

impl LoopxIntakeTarget {
    pub fn repository(&self) -> &LoopxRepositoryKey {
        match self {
            Self::Repository { repository } => repository,
            Self::Item { item } => &item.repository,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxRemoteItemState {
    Open,
    Closed,
    Merged,
    #[default]
    #[serde(other)]
    Unknown,
}

impl LoopxRemoteItemState {
    pub fn is_resolved(self) -> bool {
        matches!(self, Self::Closed | Self::Merged)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxIntakeCandidate {
    pub key: LoopxIssueKey,
    pub url: String,
    pub title: String,
    /// Bounded plain-text excerpt of the issue/PR body, kept for task
    /// surfaces. The projection intentionally never retains the full remote
    /// body (only this trimmed excerpt) to bound snapshot size.
    pub description: String,
    pub state: LoopxRemoteItemState,
    pub state_reason: Option<String>,
    /// Bounded label names from the remote item (capped to match LoopX's own
    /// metadata projection). Empty for legacy snapshots.
    pub labels: Vec<String>,
    pub from_repository: bool,
    pub has_images: bool,
    /// Repository/list intake must not silently select every candidate.
    pub default_selected: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxWorkspaceDisposition {
    ExistingWorktree,
    NewWorktree,
    CloneRequired,
    #[default]
    Unavailable,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxWorkspacePreview {
    pub disposition: LoopxWorkspaceDisposition,
    pub path: Option<String>,
    pub repository_verified: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxModelCapability {
    pub model_id: String,
    pub available: bool,
    pub supports_images: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxPermissionScope {
    WorkspaceRead,
    WorkspaceWrite,
    GitLocal,
    GithubRead,
    AgentExecution,
    Publish,
    PublicComment,
    PullRequest,
    Merge,
    ProductionAction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxIntakePreview {
    pub fingerprint: String,
    pub target: LoopxIntakeTarget,
    pub repository: LoopxRepositoryKey,
    pub workspace: LoopxWorkspacePreview,
    pub candidates: Vec<LoopxIntakeCandidate>,
    pub truncated: bool,
    pub model: LoopxModelCapability,
    pub permission_scopes: Vec<LoopxPermissionScope>,
    pub resolved_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEnvironmentFactStatus {
    Checking,
    Available,
    Degraded,
    Unavailable,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEnvironmentRemediationAction {
    InstallLoopx,
    #[default]
    #[serde(other)]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxEnvironmentFact {
    pub status: LoopxEnvironmentFactStatus,
    pub version: Option<String>,
    pub detail: Option<String>,
    pub remediation: Option<String>,
    pub remediation_action: LoopxEnvironmentRemediationAction,
    pub checked_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCoreEnvironmentFacts {
    pub sidecar: LoopxEnvironmentFact,
    pub git_worktree: LoopxEnvironmentFact,
    pub agent_model: LoopxEnvironmentFact,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxOptionalEnvironmentFacts {
    pub python_fallback: LoopxEnvironmentFact,
    pub github_auth: LoopxEnvironmentFact,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEnvironmentStatus {
    Checking,
    Ready,
    Degraded,
    Blocked,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxEnvironmentSnapshot {
    pub revision: u64,
    pub status: LoopxEnvironmentStatus,
    pub core: LoopxCoreEnvironmentFacts,
    pub optional: LoopxOptionalEnvironmentFacts,
    pub checked_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxTaskState {
    Preparing,
    Queued,
    Running,
    WaitingForUser,
    RetryWait,
    Cancelling,
    Stopped,
    Aborted,
    Completed,
    Failed,
    Archived,
    #[default]
    #[serde(other)]
    RecoveryRequired,
}

/// Authoritative Goal lifecycle projected from the LoopX CLI. This is kept
/// separate from [`LoopxTaskState`], which describes BitFun's local host job
/// (workspace, Agent session, cancellation, and recovery lifecycle).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCliGoalState {
    #[default]
    Unknown,
    Active,
    WaitingForUser,
    Completed,
    Failed,
    Archived,
}

impl LoopxTaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Stopped | Self::Aborted | Self::Completed | Self::Failed | Self::Archived
        )
    }

    pub fn was_executing_at_shutdown(self) -> bool {
        matches!(self, Self::Running | Self::Cancelling)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxPhase {
    ValidatingEnvironment,
    ResolvingIntake,
    PreparingWorkspace,
    CreatingGoal,
    Queued,
    InspectingGoal,
    BuildingTurn,
    StartingAgent,
    AgentRunning,
    ValidatingProgress,
    SettlingTurn,
    WaitingForApproval,
    RetryBackoff,
    Cancelling,
    Recovering,
    Finished,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTaskIdentity {
    pub item: LoopxIssueKey,
    pub attempt: u32,
    /// Issue / PR title captured at task creation, so task surfaces can show
    /// content instead of only the item number. Empty for legacy records.
    pub title: String,
    /// Bounded plain-text excerpt of the issue/PR description captured at
    /// task creation. Empty for legacy records.
    pub description: String,
    /// Remote item state observed at task creation. `Unknown` for legacy
    /// records; the LoopX plan packet must never be built from a fabricated
    /// open state when the adapter actually resolved a terminal state.
    pub state: LoopxRemoteItemState,
    /// Bounded label names observed at task creation. Empty for legacy
    /// records; LoopX intake classification uses these as routing hints.
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxSettlementSummary {
    pub turn_id: Option<String>,
    pub receipt_id: Option<String>,
    pub durable_revision: Option<String>,
    pub settled_at: Option<i64>,
}

/// Bounded read-only projection of the LoopX frontier todo that the current
/// turn plan selected. This is a UX snapshot only: the LoopX registry remains
/// the sole authority for todo lifecycle, and the host must not act on this
/// projection beyond display.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCurrentTodo {
    pub todo_id: String,
    pub task_class: String,
    pub action_kind: String,
    pub target_key: String,
    pub claimed_by: String,
    /// Authoritative LoopX due projection for monitor todos, kept as the raw
    /// LoopX string (typically an ISO timestamp) so the host never fabricates
    /// a parse result.
    pub next_due_at: Option<String>,
    /// Bounded recommended-action text from the same LoopX envelope.
    pub recommended_action: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTaskSnapshot {
    #[serde(alias = "id")]
    pub task_id: String,
    pub batch_id: Option<String>,
    pub identity: LoopxTaskIdentity,
    pub generation: u64,
    pub revision: u64,
    pub goal_id: Option<String>,
    /// Read-only Goal lifecycle from LoopX. Legacy records leave this absent
    /// until the host reconciles them against the CLI.
    pub goal_state: Option<LoopxCliGoalState>,
    pub agent_id: Option<String>,
    /// BitFun host-job lifecycle; this is not the Goal authority.
    #[serde(alias = "status")]
    pub state: LoopxTaskState,
    pub phase: LoopxPhase,
    /// Durable answerable gate projection. Event history may be truncated, so
    /// interactive approval surfaces must not depend on replay to recover it.
    pub pending_gate_id: Option<String>,
    pub pending_gate_message: Option<String>,
    pub pending_gate_action_kind: Option<String>,
    pub workspace_path: Option<String>,
    pub model_id: Option<String>,
    pub granted_scopes: Vec<LoopxPermissionScope>,
    pub current_turn_id: Option<String>,
    pub current_tool: Option<String>,
    /// Last known LoopX frontier todo projection. Absent for legacy records
    /// and cleared when the Goal reaches a terminal projection.
    pub current_todo: Option<LoopxCurrentTodo>,
    pub last_output_at: Option<i64>,
    /// Bounded final response from the latest Agent turn. It is persisted
    /// before settlement so recovery surfaces retain the useful outcome even
    /// when settlement verification fails. Empty for legacy tasks and active turns
    /// that have not produced a final response yet.
    pub last_agent_summary: Option<String>,
    pub last_agent_summary_at: Option<i64>,
    /// Parsed `loopx_summary_v1` block extracted from the latest agent summary.
    /// None for legacy tasks or when the agent produced no valid block; the UI
    /// falls back to the raw text in that case.
    pub structured_summary: Option<serde_json::Value>,
    /// Why the task currently needs recovery (host_restart, execution_failure,
    /// settlement_unverified, plan_exhausted, repository_paused, manual_restore).
    /// Absent for legacy records and for tasks that are not in RecoveryRequired.
    pub recovery_reason: Option<String>,
    pub deadline_at: Option<i64>,
    pub retry_at: Option<i64>,
    pub error: Option<String>,
    pub settlement: LoopxSettlementSummary,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxExecutionDomain {
    LocalDesktop,
    RemoteWorkspace,
    PeerDevice,
    RemoteControl,
    DetachedDispatch,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxExecutionSupport {
    Supported,
    #[default]
    #[serde(other)]
    UnsupportedExecutionDomain,
}

fn default_contract_schema_version() -> u32 {
    LOOPX_CLI_SCHEMA_VERSION
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxSnapshot {
    #[serde(default = "default_contract_schema_version")]
    pub schema_version: u32,
    pub stream_id: String,
    pub cursor: LoopxEventCursor,
    pub revision: u64,
    pub execution_domain: LoopxExecutionDomain,
    pub execution_support: LoopxExecutionSupport,
    pub unsupported_reason: Option<String>,
    pub environment: LoopxEnvironmentSnapshot,
    pub tasks: Vec<LoopxTaskSnapshot>,
    pub generated_at: i64,
}

impl Default for LoopxSnapshot {
    fn default() -> Self {
        Self {
            schema_version: default_contract_schema_version(),
            stream_id: String::new(),
            cursor: 0,
            revision: 0,
            execution_domain: LoopxExecutionDomain::default(),
            execution_support: LoopxExecutionSupport::default(),
            unsupported_reason: None,
            environment: LoopxEnvironmentSnapshot::default(),
            tasks: Vec::new(),
            generated_at: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEventLevel {
    Trace,
    Debug,
    Warning,
    Error,
    #[default]
    #[serde(other)]
    Info,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEventSource {
    #[default]
    Controller,
    Sidecar,
    Agent,
    Git,
    Github,
    System,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEventKind {
    #[default]
    Progress,
    TaskCreated,
    StateChanged,
    PhaseChanged,
    Log,
    ApprovalRequired,
    SettlementRecorded,
    EnvironmentChanged,
    OperationCancelled,
    SnapshotInvalidated,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxEvent {
    pub stream_id: String,
    pub cursor: LoopxEventCursor,
    pub task_id: Option<String>,
    pub generation: Option<u64>,
    pub revision: Option<u64>,
    pub kind: LoopxEventKind,
    pub level: LoopxEventLevel,
    pub source: LoopxEventSource,
    pub phase: Option<LoopxPhase>,
    pub message: String,
    pub important: bool,
    pub tool_name: Option<String>,
    pub deadline_at: Option<i64>,
    pub details: BTreeMap<String, String>,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAttachRequest {
    pub known_stream_id: Option<String>,
    pub after_cursor: Option<LoopxEventCursor>,
    /// Set only when the trusted MiniApp detects a wall-clock discontinuity
    /// consistent with host suspend/resume. Legacy clients omit it.
    pub resume_detected: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxAttachResponse {
    pub snapshot: LoopxSnapshot,
}

fn default_loopx_model_id() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxResolveIntakeRequest {
    pub input: String,
    #[serde(default = "default_loopx_model_id")]
    pub model_id: String,
}

impl Default for LoopxResolveIntakeRequest {
    fn default() -> Self {
        Self {
            input: String::new(),
            model_id: default_loopx_model_id(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxResolveIntakeResponse {
    pub preview: LoopxIntakePreview,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCreateTaskRequest {
    pub client_request_id: String,
    pub preview_fingerprint: String,
    pub selected_items: Vec<LoopxIssueKey>,
    pub model_id: String,
    pub granted_scopes: Vec<LoopxPermissionScope>,
    pub retry_terminal: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxCreateTaskOutcomeKind {
    #[default]
    Created,
    OpenedExisting,
    RetryConfirmationRequired,
    ClosedNoop,
    NeedsLiveVerification,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCreateTaskOutcome {
    pub item: LoopxIssueKey,
    pub kind: LoopxCreateTaskOutcomeKind,
    pub task_id: Option<String>,
    pub attempt: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxCreateTaskResponse {
    pub outcomes: Vec<LoopxCreateTaskOutcome>,
    pub snapshot_revision: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxActionKind {
    #[default]
    Pause,
    Abort,
    Resume,
    ResumeRepository,
    ResetAll,
    Approve,
    Reject,
    Archive,
    Restore,
    InstallLoopx,
    RetryEnvironment,
    #[serde(other)]
    Unsupported,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxActionRequest {
    pub task_id: Option<String>,
    pub repository: Option<LoopxRepositoryKey>,
    pub action: LoopxActionKind,
    pub client_request_id: String,
    pub expected_revision: u64,
    pub gate_id: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxActionStatus {
    #[default]
    Applied,
    Duplicate,
    RevisionConflict,
    Rejected,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxActionResponse {
    pub status: LoopxActionStatus,
    pub current_revision: u64,
    pub task: Option<LoopxTaskSnapshot>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxEventsSinceRequest {
    pub stream_id: String,
    pub after_cursor: LoopxEventCursor,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxEventsPageStatus {
    #[default]
    Current,
    SnapshotRequired,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxEventsSinceResponse {
    pub status: LoopxEventsPageStatus,
    pub stream_id: String,
    pub events: Vec<LoopxEvent>,
    pub next_cursor: LoopxEventCursor,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxTurnOutputStatus {
    #[default]
    Current,
    TaskNotFound,
    NotRunning,
    StaleTurn,
    OutputUnavailable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxTurnOutputEventKind {
    #[default]
    Text,
    Thinking,
    ModelRoundStarted,
    ModelRoundCompleted,
    Tool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTurnOutputEvent {
    pub cursor: LoopxEventCursor,
    pub turn_id: String,
    pub round_id: Option<String>,
    pub kind: LoopxTurnOutputEventKind,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_state: Option<String>,
    pub is_end: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTurnOutputSinceRequest {
    pub task_id: String,
    pub turn_id: Option<String>,
    pub stream_id: Option<String>,
    pub after_cursor: LoopxEventCursor,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTurnOutputSinceResponse {
    pub status: LoopxTurnOutputStatus,
    pub task_id: String,
    pub turn_id: Option<String>,
    pub stream_id: Option<String>,
    pub events: Vec<LoopxTurnOutputEvent>,
    pub next_cursor: LoopxEventCursor,
    pub has_more: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxExistingTask {
    pub task_id: String,
    pub identity: LoopxTaskIdentity,
    pub state: LoopxTaskState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_task_snapshot_defaults_agent_summary_fields() {
        let task: LoopxTaskSnapshot = serde_json::from_value(serde_json::json!({
            "taskId": "legacy-task",
            "state": "queued",
            "phase": "queued"
        }))
        .expect("legacy task snapshot");

        assert_eq!(task.last_agent_summary, None);
        assert_eq!(task.last_agent_summary_at, None);
        assert_eq!(task.pending_gate_id, None);
        assert_eq!(task.pending_gate_message, None);
        assert_eq!(task.pending_gate_action_kind, None);
    }

    #[test]
    fn legacy_attach_request_defaults_resume_signal() {
        let request: LoopxAttachRequest = serde_json::from_value(serde_json::json!({
            "knownStreamId": "stream-1",
            "afterCursor": 4
        }))
        .expect("legacy attach request");

        assert!(!request.resume_detected);
    }
}
