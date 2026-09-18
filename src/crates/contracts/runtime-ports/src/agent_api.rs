use super::*;

/// Reserved turn metadata/context key used to carry a provider-neutral JSON
/// output schema through persistence and interrupted-turn recovery.
pub const OUTPUT_SCHEMA_CONTEXT_KEY: &str = "openbitfun_output_schema";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCreateRequest {
    pub session_name: String,
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_route_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<SessionExecutionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCreateResult {
    pub session_id: String,
    #[serde(default)]
    pub session_name: String,
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<SessionExecutionTarget>,
}

impl AgentSessionCreateResult {
    pub fn new(
        session_id: impl Into<String>,
        session_name: impl Into<String>,
        agent_type: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            session_name: session_name.into(),
            agent_type: agent_type.into(),
            model_id: None,
            workspace_path: None,
            workspace_id: None,
            project_workspace_path: None,
            execution_target: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID wire input. New producers send workspace_id.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_dialog_agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_submitted_agent_type: Option<String>,
    #[serde(default)]
    pub turn_count: usize,
    pub created_at_ms: u64,
    pub last_active_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDeleteRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only protocol field. Current callers provide workspace_id.
    #[serde(default)]
    pub workspace_path: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRenameRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only protocol field. Current callers provide workspace_id.
    #[serde(default)]
    pub workspace_path: String,
    pub session_id: String,
    pub session_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionArchiveRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only protocol field. Current callers provide workspace_id.
    #[serde(default)]
    pub workspace_path: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

/// Sets the persisted archive state without exposing product-specific archive UI.
///
/// This is separate from [`AgentSessionArchiveRequest`] so existing archive-only
/// consumers keep their current request shape and behavior.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionArchiveStateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only protocol field. Current callers provide workspace_id.
    #[serde(default)]
    pub workspace_path: String,
    pub session_id: String,
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

/// Records one completed local command result in user-visible session history.
///
/// This request intentionally cannot select another turn kind or opt the turn
/// into model context. It is not a generic transcript-writing contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalCommandTurnRecordRequest {
    pub session_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

/// The authoritative persisted identity assigned to a completed local command Turn.
///
/// The product-facing adapter may use this result to reconcile a provisional UI
/// projection. Catalog data remains owned by the session persistence boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalCommandTurnRecordResult {
    pub turn_id: String,
    pub storage_turn_index: usize,
}

/// Starts one user-authored shell command as a normal, model-visible tool turn.
///
/// The caller provides the exact turn identity so interactive adapters can
/// register cancellation before the side effect is admitted. Implementations
/// must route execution through the normal tool, permission, and audit owners;
/// this is not a generic process-spawn or arbitrary-tool contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUserShellCommandRequest {
    pub session_id: String,
    pub turn_id: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUserShellCommandResult {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionModelUpdateRequest {
    pub session_id: String,
    pub model_id: String,
}

/// Atomically selects a model and an optional reasoning preset for the next
/// turn. The legacy model-only request remains available for older clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionModelSelection {
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_preset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionModelSelectionUpdateRequest {
    pub session_id: String,
    pub selection: AgentSessionModelSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionModeUpdateRequest {
    pub session_id: String,
    pub mode_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_route_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentModeCatalogQuery {
    /// Authoritative workspace identity. Current callers must supply this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only input from pre-ID clients; removed after the compatibility sunset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub include_external: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeCatalogEntry {
    pub id: String,
    #[serde(default)]
    pub route_key: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub is_external: bool,
}

#[async_trait::async_trait]
pub trait AgentModeCatalogPort: Send + Sync {
    async fn list_modes(
        &self,
        query: AgentModeCatalogQuery,
    ) -> PortResult<Vec<AgentModeCatalogEntry>>;
}

/// Starts one audited manual context-compaction maintenance turn.
///
/// The caller supplies the exact turn identity so process adapters can register
/// cancellation ownership before the side effect is admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionCompactionRequest {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionCompactionResult {
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentContextReloadTarget {
    All,
    Skills,
    Instructions,
}

impl AgentContextReloadTarget {
    pub const fn includes_skills(self) -> bool {
        matches!(self, Self::All | Self::Skills)
    }

    pub const fn includes_instructions(self) -> bool {
        matches!(self, Self::All | Self::Instructions)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContextReloadRequest {
    pub session_id: String,
    pub target: AgentContextReloadTarget,
}

#[async_trait::async_trait]
pub trait AgentContextReloadPort: Send + Sync {
    async fn reload_session_context(&self, request: AgentContextReloadRequest) -> PortResult<()>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Delivers answers to a pending user-question tool call.
pub struct AgentUserAnswersRequest {
    pub tool_id: String,
    pub answers: serde_json::Value,
}

#[async_trait::async_trait]
/// Routes product responses to the existing user-input owner.
///
/// Implementations do not own approval policy or interaction lifecycle state.
pub trait AgentInteractionResponsePort: Send + Sync {
    async fn submit_user_answers(&self, request: AgentUserAnswersRequest) -> PortResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionForkRequest {
    /// Owning-host workspace ID. Normal callers must supply this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire input; interpreted only by the upgrade adapter.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub source_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

/// Forks a session at an explicitly selected persisted turn.
///
/// This is additive to [`AgentSessionForkRequest`] so existing Rust SDK
/// consumers keep the source-compatible latest-turn request shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionForkAtTurnRequest {
    /// Owning-host workspace ID. Normal callers must supply this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire input; interpreted only by the upgrade adapter.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub source_session_id: String,
    pub source_turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

/// Forks a session immediately before an explicitly selected persisted turn.
///
/// The selected turn is the replayable prompt boundary and is not copied into
/// the fork. This stays separate from [`AgentSessionForkAtTurnRequest`] so its
/// inclusive behavior remains source- and behavior-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionForkBeforeTurnRequest {
    /// Owning-host workspace ID. Normal callers must supply this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire input; interpreted only by the upgrade adapter.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    pub source_session_id: String,
    pub source_turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionForkResult {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUsageRequest {
    pub session_id: String,
    /// Owning workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. New producers send workspace_id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default)]
    pub include_hidden_subagents: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnSettlementRequest {
    pub session_id: String,
    pub turn_id: String,
    pub wait_timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnSettlementStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnSettlementResult {
    pub status: AgentTurnSettlementStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_response: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionWorkspaceRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionWorkspaceBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<openbitfun_core_types::WorkspaceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<SessionExecutionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

pub const AGENT_WORKSPACE_REFERENCES_METADATA_KEY: &str = "workspace_references";
pub const MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentWorkspaceReferenceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReferenceSourceRange {
    /// Zero-based character offset in the original user input.
    pub start: usize,
    /// Exclusive zero-based character offset in the original user input.
    pub end: usize,
    pub value: String,
}

/// A user-selected workspace path carried as structured turn metadata.
///
/// The path is workspace-relative and slash-normalized. It is not an
/// authorization token: the runtime owner validates the current Session
/// binding and path again before accepting the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReference {
    pub path: String,
    pub kind: AgentWorkspaceReferenceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub source: AgentWorkspaceReferenceSourceRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReferenceSearchRequest {
    pub session_id: String,
    #[serde(default)]
    pub query: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReferenceSearchEntry {
    pub path: String,
    pub kind: AgentWorkspaceReferenceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReferenceSearchResult {
    #[serde(default)]
    pub entries: Vec<AgentWorkspaceReferenceSearchEntry>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageWorkspaceReferencesRequest {
    pub session_id: String,
    pub message_id: String,
}

pub fn put_agent_workspace_references(
    metadata: &mut serde_json::Map<String, serde_json::Value>,
    references: &[AgentWorkspaceReference],
) -> PortResult<()> {
    if references.is_empty() {
        metadata.remove(AGENT_WORKSPACE_REFERENCES_METADATA_KEY);
        return Ok(());
    }
    if references.len() > MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            format!(
                "a message can reference at most {MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN} workspace paths"
            ),
        ));
    }
    let value = serde_json::to_value(references).map_err(|error| {
        PortError::new(
            PortErrorKind::InvalidRequest,
            format!("failed to serialize workspace references: {error}"),
        )
    })?;
    metadata.insert(AGENT_WORKSPACE_REFERENCES_METADATA_KEY.to_string(), value);
    Ok(())
}

pub fn agent_workspace_references_from_metadata(
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> PortResult<Vec<AgentWorkspaceReference>> {
    let Some(value) = metadata.get(AGENT_WORKSPACE_REFERENCES_METADATA_KEY) else {
        return Ok(Vec::new());
    };
    let references: Vec<AgentWorkspaceReference> =
        serde_json::from_value(value.clone()).map_err(|error| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                format!("invalid workspace reference metadata: {error}"),
            )
        })?;
    if references.len() > MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            format!(
                "a message can reference at most {MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN} workspace paths"
            ),
        ));
    }
    Ok(references)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSubmissionRequest {
    pub session_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentSubmissionSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AgentInputAttachment>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentDialogTurnExecution {
    Standard,
    FreshExternalSubagent {
        ecosystem_id: String,
        logical_id: String,
    },
}

impl Default for AgentDialogTurnExecution {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDialogTurnRequest {
    pub session_id: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "AgentDialogTurnExecution::is_standard")]
    pub execution: AgentDialogTurnExecution,
    pub agent_type: String,
    /// Execution root projection retained for pre-ID clients; never a workspace key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Owning workspace ID used to locate the session when it is not loaded.
    /// Paths and SSH fields below are upgrade-only projections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    pub policy: DialogSubmissionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_route: Option<AgentSessionReplyRoute>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prepended_reminders: Vec<AgentDialogPrependedReminder>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AgentInputAttachment>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

/// Recover one settled interrupted user dialog without creating a new Turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentDialogTurnRecoveryRequest {
    pub session_id: String,
    pub turn_id: String,
    /// Compare-and-set generation observed by the caller.
    pub execution_generation: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Owning workspace ID; when present it is the only identity compared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentDialogTurnRecoveryOutcome {
    pub session_id: String,
    pub turn_id: String,
    pub execution_generation: u32,
}

/// Steering request for one exact running dialog turn.
///
/// Carries the same payload shape as a turn submission: a mid-turn steering
/// message is an ordinary user message that happens to arrive while a turn is
/// running, so attachments and message metadata ride along with the text
/// rather than forcing the user to wait for a turn boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDialogSteerRequest {
    pub session_id: String,
    pub turn_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AgentInputAttachment>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

impl AgentDialogTurnExecution {
    pub fn is_standard(&self) -> bool {
        matches!(self, Self::Standard)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDialogPrependedReminder {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackgroundResultRequest {
    pub session_id: String,
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_content: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentThreadGoalDeliveryKind {
    Resumed,
    ObjectiveUpdated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadGoalDeliveryRequest {
    pub session_id: String,
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    pub kind: AgentThreadGoalDeliveryKind,
    pub goal: ThreadGoal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum DialogQueuePriority {
    Low = 0,
    Normal = 1,
    High = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DialogSubmissionPolicy {
    pub trigger_source: DialogTriggerSource,
    pub queue_priority: DialogQueuePriority,
}

impl DialogSubmissionPolicy {
    pub const fn new(
        trigger_source: DialogTriggerSource,
        queue_priority: DialogQueuePriority,
    ) -> Self {
        Self {
            trigger_source,
            queue_priority,
        }
    }

    pub const fn for_source(trigger_source: DialogTriggerSource) -> Self {
        let queue_priority = match trigger_source {
            DialogTriggerSource::AgentSession => DialogQueuePriority::Low,
            DialogTriggerSource::ScheduledJob => DialogQueuePriority::Low,
            DialogTriggerSource::DesktopUi
            | DialogTriggerSource::DesktopApi
            | DialogTriggerSource::Cli
            | DialogTriggerSource::SdkHost => DialogQueuePriority::Normal,
            DialogTriggerSource::RemoteRelay | DialogTriggerSource::Bot => {
                DialogQueuePriority::Normal
            }
        };
        Self::new(trigger_source, queue_priority)
    }

    pub const fn with_queue_priority(mut self, queue_priority: DialogQueuePriority) -> Self {
        self.queue_priority = queue_priority;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogSubmitOutcome {
    Started { session_id: String, turn_id: String },
    Queued { session_id: String, turn_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DialogSessionStateFact {
    Missing,
    Idle,
    Processing,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DialogSubmitQueueFacts {
    pub session_state: DialogSessionStateFact,
    pub queue_has_items: bool,
    pub policy: DialogSubmissionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogSubmitQueueAction {
    StartImmediately,
    ClearQueueAndStartImmediately,
    EnqueueThenStartNext,
    EnqueueForActiveTurn,
}

pub const fn resolve_dialog_submit_queue_action(
    facts: DialogSubmitQueueFacts,
) -> DialogSubmitQueueAction {
    match facts.session_state {
        DialogSessionStateFact::Missing => DialogSubmitQueueAction::StartImmediately,
        DialogSessionStateFact::Error => DialogSubmitQueueAction::ClearQueueAndStartImmediately,
        DialogSessionStateFact::Idle => {
            if facts.queue_has_items {
                DialogSubmitQueueAction::EnqueueThenStartNext
            } else {
                DialogSubmitQueueAction::StartImmediately
            }
        }
        DialogSessionStateFact::Processing => DialogSubmitQueueAction::EnqueueForActiveTurn,
    }
}

pub fn should_suppress_agent_session_cancelled_reply(
    policy: &DialogSubmissionPolicy,
    reply_source_session_id: Option<&str>,
    requester_session_id: &str,
) -> bool {
    policy.trigger_source == DialogTriggerSource::AgentSession
        && reply_source_session_id.is_some_and(|source| source == requester_session_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogTurnOutcomeKind {
    Completed,
    Cancelled,
    Interrupted,
    Failed,
}

pub const fn should_skip_agent_session_reply(
    outcome_kind: DialogTurnOutcomeKind,
    suppressed_cancelled_reply: bool,
) -> bool {
    matches!(outcome_kind, DialogTurnOutcomeKind::Interrupted)
        || matches!(outcome_kind, DialogTurnOutcomeKind::Cancelled) && suppressed_cancelled_reply
}

/// Source session route used when an agent-session request should reply to the
/// requester after the target session finishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionReplyRoute {
    pub source_session_id: String,
    pub source_workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_remote_ssh_host: Option<String>,
}

/// Outcome for steering a message into an already-running dialog turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DialogSteerOutcome {
    /// Steering was buffered for the running turn and will be consumed at the
    /// next model-round boundary.
    Buffered {
        session_id: String,
        turn_id: String,
        steering_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundInjectionKind {
    UserSteering,
    BackgroundResult,
    ThreadGoalObjectiveUpdated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RoundInjectionToolPreemption {
    None,
    InterruptAfterCurrentAtomicUnit,
    CancelRunningCooperatively,
    CancelRunningForcefully,
}

impl RoundInjectionToolPreemption {
    pub const fn should_interrupt_after_current_atomic_unit(self) -> bool {
        !matches!(self, Self::None)
    }

    pub const fn should_cancel_running_tools(self) -> bool {
        matches!(
            self,
            Self::CancelRunningCooperatively | Self::CancelRunningForcefully
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundInjectionExecutionPolicy {
    pub tool_preemption: RoundInjectionToolPreemption,
}

impl RoundInjectionExecutionPolicy {
    pub const fn new(tool_preemption: RoundInjectionToolPreemption) -> Self {
        Self { tool_preemption }
    }
}

impl Default for RoundInjectionExecutionPolicy {
    fn default() -> Self {
        Self::new(RoundInjectionToolPreemption::None)
    }
}

impl RoundInjectionKind {
    pub const fn default_execution_policy(self) -> RoundInjectionExecutionPolicy {
        match self {
            Self::UserSteering => RoundInjectionExecutionPolicy::new(
                RoundInjectionToolPreemption::InterruptAfterCurrentAtomicUnit,
            ),
            Self::BackgroundResult | Self::ThreadGoalObjectiveUpdated => {
                RoundInjectionExecutionPolicy::new(RoundInjectionToolPreemption::None)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoundInjectionTarget {
    /// Only inject into the exact targeted running turn.
    ExactTurn(String),
    /// Inject into whichever turn is currently running for the session.
    CurrentRunningTurn,
}

/// A message to inject into the currently running dialog turn at the next
/// model-round boundary.
#[derive(Debug, Clone, PartialEq)]
pub struct RoundInjection {
    pub id: String,
    pub kind: RoundInjectionKind,
    pub execution_policy: RoundInjectionExecutionPolicy,
    pub target: RoundInjectionTarget,
    pub content: String,
    pub display_content: String,
    /// Attachments that ride into the running turn with the injected message.
    /// Consumers rebuild them into a multimodal user message, so a steering
    /// message with images is no different from one sent at a turn boundary.
    pub attachments: Vec<AgentInputAttachment>,
    /// Message metadata carried alongside the injected content (same shape as
    /// a turn submission's `metadata`).
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub created_at: std::time::SystemTime,
}

/// Observes round-boundary injections for a given running turn.
pub trait DialogRoundInjectionSource: Send + Sync {
    fn has_pending(&self, session_id: &str, turn_id: &str) -> bool;
    fn pending_tool_preemption(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> RoundInjectionToolPreemption;
    fn take_pending(&self, session_id: &str, turn_id: &str) -> Vec<RoundInjection>;

    fn acknowledge_consumed(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _injection_id: &str,
        _kind: RoundInjectionKind,
    ) {
    }
}

/// Legacy session metadata key for the pre-Codex goal mode experiment.
pub const GOAL_MODE_METADATA_KEY: &str = "goal_mode";

/// Persisted thread goal stored in session custom metadata.
pub const THREAD_GOAL_METADATA_KEY: &str = "thread_goal";

pub const MAX_THREAD_GOAL_OBJECTIVE_CHARS: usize = 4_000;

pub const MAX_CONTEXT_SUMMARY_CHARS: usize = 12_000;

/// Max automatic goal continuation dialog turns per objective (legacy goal_mode parity).
pub const MAX_THREAD_GOAL_AUTO_CONTINUATIONS: u32 = 100;

/// Alias retained for migration from legacy `goal_mode` metadata and docs.
pub const MAX_GOAL_CONTINUATIONS: u32 = MAX_THREAD_GOAL_AUTO_CONTINUATIONS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ThreadGoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

impl ThreadGoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::UsageLimited => "usageLimited",
            Self::BudgetLimited => "budgetLimited",
            Self::Complete => "complete",
        }
    }
}

pub fn validate_thread_goal_objective(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("goal objective must not be empty".to_string());
    }
    if value.chars().count() > MAX_THREAD_GOAL_OBJECTIVE_CHARS {
        return Err(format!(
            "goal objective must be at most {MAX_THREAD_GOAL_OBJECTIVE_CHARS} characters"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoal {
    pub goal_id: String,
    pub session_id: String,
    pub objective: String,
    pub status: ThreadGoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
    #[serde(default)]
    pub tokens_used: i64,
    #[serde(default)]
    pub time_used_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Auto-continuation dialog turns scheduled toward this goal (resets on new objective).
    #[serde(default)]
    pub auto_continuation_count: u32,
}

impl ThreadGoal {
    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            ThreadGoalStatus::Active | ThreadGoalStatus::BudgetLimited
        )
    }

    pub fn remaining_tokens(&self) -> Option<i64> {
        self.token_budget
            .map(|budget| (budget - self.tokens_used).max(0))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetThreadGoalResult {
    pub goal: ThreadGoal,
    pub replaced_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadGoalContinuationPlan {
    pub prepended_reminders: Vec<String>,
    pub display_message: String,
    pub user_message_metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalToolResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<ThreadGoal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_budget_report: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadGoalGetRequest {
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadGoalCreateRequest {
    pub session_id: String,
    pub workspace_path: String,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadGoalUpdateStatusRequest {
    pub session_id: String,
    pub workspace_path: String,
    pub status: ThreadGoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompressionContract {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub touched_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verification_commands: Vec<CompressionContractItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocking_failures: Vec<CompressionContractItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagent_statuses: Vec<CompressionContractItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompressionContractItem {
    pub target: String,
    pub status: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

impl CompressionContract {
    pub fn is_empty(&self) -> bool {
        self.touched_files.is_empty()
            && self.verification_commands.is_empty()
            && self.blocking_failures.is_empty()
            && self.subagent_statuses.is_empty()
    }

    pub fn render_for_model(&self) -> String {
        let mut lines = vec![
            "The following facts were retained during compression. Use them as authoritative context when continuing the task."
                .to_string(),
        ];

        if !self.touched_files.is_empty() {
            lines.push("Touched files:".to_string());
            for file in &self.touched_files {
                lines.push(format!("- {}", file));
            }
        }

        render_contract_items(
            &mut lines,
            "Verification commands:",
            &self.verification_commands,
        );
        render_contract_items(&mut lines, "Blocking failures:", &self.blocking_failures);
        render_contract_items(&mut lines, "Subagent statuses:", &self.subagent_statuses);

        lines.join("\n")
    }
}

fn render_contract_items(lines: &mut Vec<String>, title: &str, items: &[CompressionContractItem]) {
    if items.is_empty() {
        return;
    }

    lines.push(title.to_string());
    for item in items {
        let mut rendered = format!("- {} [{}]: {}", item.target, item.status, item.summary);
        if let Some(error_kind) = item.error_kind.as_ref() {
            rendered.push_str(&format!(" ({})", error_kind));
        }
        lines.push(rendered);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentInputAttachment {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

impl AgentInputAttachment {
    pub fn remote_image(
        id: impl Into<String>,
        name: impl Into<String>,
        data_url: impl Into<String>,
    ) -> Self {
        let mut metadata = serde_json::Map::new();
        metadata.insert("name".to_string(), serde_json::Value::String(name.into()));
        metadata.insert(
            "dataUrl".to_string(),
            serde_json::Value::String(data_url.into()),
        );

        Self {
            kind: "remote_image".to_string(),
            id: id.into(),
            metadata,
        }
    }

    /// Build a `remote_image` attachment from a renderer image context.
    ///
    /// Either `image_path` or `data_url` must be present — consumers reject an
    /// attachment carrying neither.
    pub fn image_context(
        id: impl Into<String>,
        image_path: Option<String>,
        data_url: Option<String>,
        mime_type: impl Into<String>,
        context_metadata: Option<serde_json::Value>,
    ) -> Self {
        let mut metadata = serde_json::Map::new();
        if let Some(image_path) = image_path {
            metadata.insert(
                "imagePath".to_string(),
                serde_json::Value::String(image_path),
            );
        }
        if let Some(data_url) = data_url {
            metadata.insert("dataUrl".to_string(), serde_json::Value::String(data_url));
        }
        metadata.insert(
            "mimeType".to_string(),
            serde_json::Value::String(mime_type.into()),
        );
        if let Some(context_metadata) = context_metadata {
            metadata.insert("metadata".to_string(), context_metadata);
        }

        Self {
            kind: "remote_image".to_string(),
            id: id.into(),
            metadata,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentSubmissionResult {
    pub turn_id: String,
    #[serde(default)]
    pub accepted: bool,
}

#[async_trait::async_trait]
pub trait AgentSubmissionPort: Send + Sync {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult>;

    /// Creates a session with an exact caller-provided identity.
    ///
    /// Providers that do not support exact identity creation keep the default
    /// typed unsupported response. A successful response must preserve
    /// `session_id` exactly.
    async fn create_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        let _ = (session_id, request);
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "exact session identity creation is not supported by this provider",
        ))
    }

    /// Creates one caller-identified connection-scoped Session.
    ///
    /// The Session uses the normal Runtime owners but must not become durable
    /// product state. This narrow operation lets process adapters provide
    /// bounded cleanup without pretending that crash-safe durable creation has
    /// already been specified.
    async fn create_transient_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        let _ = (session_id, request);
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "transient exact session creation is not supported by this provider",
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult>;

    async fn resolve_session_agent_type(&self, session_id: &str) -> PortResult<Option<String>>;
}

#[async_trait::async_trait]
pub trait AgentSessionManagementPort: Send + Sync {
    async fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> PortResult<Vec<AgentSessionSummary>>;

    async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()>;

    async fn rename_session(&self, request: AgentSessionRenameRequest) -> PortResult<()> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "session rename is not supported by this provider",
        ))
    }

    async fn archive_session(&self, request: AgentSessionArchiveRequest) -> PortResult<()> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "session archive is not supported by this provider",
        ))
    }

    async fn set_session_archived(
        &self,
        request: AgentSessionArchiveStateRequest,
    ) -> PortResult<()> {
        if request.archived {
            return self
                .archive_session(AgentSessionArchiveRequest {
                    workspace_id: request.workspace_id,
                    workspace_path: request.workspace_path,
                    session_id: request.session_id,
                    remote_connection_id: request.remote_connection_id,
                    remote_ssh_host: request.remote_ssh_host,
                })
                .await;
        }
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "session unarchive is not supported by this provider",
        ))
    }

    async fn resolve_session_workspace_binding(
        &self,
        request: AgentSessionWorkspaceRequest,
    ) -> PortResult<Option<AgentSessionWorkspaceBinding>>;
}

/// Provider-neutral lifecycle facts needed to render a Session lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionLifecycleStatus {
    Active,
    Archived,
    Completed,
}

/// Minimal Session facts exposed by the Runtime lineage capability.
///
/// This intentionally does not mirror the persistence owner's full metadata
/// object. Product surfaces receive only the stable facts required for
/// navigation and status display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageEntry {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    pub created_at_ms: u64,
    pub status: AgentSessionLifecycleStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    /// Parent-scoped semantic handle assigned when this subagent was launched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Owning workspace ID; authoritative when present. Paths below are
    /// location projections only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_completion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_user_attention: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageSnapshot {
    pub root_session_id: String,
    #[serde(default)]
    pub sessions: Vec<AgentSessionLineageEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID protocol field. New callers must provide workspace_id.
    #[serde(default)]
    pub workspace_path: String,
    pub anchor_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageTranscriptRequest {
    /// Owning workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. New producers send workspace_id.
    pub workspace_path: String,
    pub root_session_id: String,
    pub session_id: String,
    /// Terminal Turns that an authoritative read must prove settled. This is a
    /// read-consistency precondition; settlement and transcript construction
    /// remain Runtime-owned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_settled_turn_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageInspection {
    pub transcript: SessionTranscript,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageCancellationRequest {
    /// Owning workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. New producers send workspace_id.
    pub workspace_path: String,
    pub root_session_id: String,
    pub session_id: String,
    /// Exact Turn shown as active when the user requested interruption. The
    /// Runtime rejects a changed target instead of cancelling a newer Turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_active_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentSubmissionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

/// Authoritative Session-lineage use cases shared by product surfaces.
///
/// The provider owns persistence scope, legacy relationship normalization,
/// membership/order, and consistent transcript reads. Surfaces may project
/// the returned flat snapshot into their own tree presentation, but must not
/// recompute lineage facts or read Session files directly.
#[async_trait::async_trait]
pub trait AgentSessionLineagePort: Send + Sync {
    async fn get_session_lineage(
        &self,
        request: AgentSessionLineageRequest,
    ) -> PortResult<Option<AgentSessionLineageSnapshot>>;

    async fn read_lineage_session_transcript(
        &self,
        request: AgentSessionLineageTranscriptRequest,
    ) -> PortResult<AgentSessionLineageInspection>;

    async fn cancel_lineage_session(
        &self,
        request: AgentSessionLineageCancellationRequest,
    ) -> PortResult<AgentTurnCancellationResult>;
}

/// Narrow workspace-reference use cases shared by first-party interactive
/// adapters. Implementations keep filesystem search and persisted message
/// lookup behind the authoritative Session owner.
#[async_trait::async_trait]
pub trait AgentWorkspaceReferencePort: Send + Sync {
    async fn search_workspace_references(
        &self,
        request: AgentWorkspaceReferenceSearchRequest,
    ) -> PortResult<AgentWorkspaceReferenceSearchResult>;

    async fn workspace_references_for_message(
        &self,
        request: AgentMessageWorkspaceReferencesRequest,
    ) -> PortResult<Vec<AgentWorkspaceReference>>;
}

/// Deadline-bearing request for releasing a loaded Session from one runtime.
/// The lifecycle method decides whether persisted storage is preserved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionReleaseRequest {
    /// Owning workspace ID; authoritative when present.
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. New producers send workspace_id.
    pub workspace_path: String,
    pub session_id: String,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
    pub wait_timeout_ms: u64,
}

/// Compatibility name for callers that only discard transient Sessions.
pub type AgentTransientSessionDiscardRequest = AgentSessionReleaseRequest;

/// Runtime lifecycle owner for releasing loaded Sessions.
#[async_trait::async_trait]
pub trait AgentSessionClosePort: Send + Sync {
    /// Quiesces and discards only a loaded transient Session owned by the
    /// caller. Implementations must reject durable Sessions and must never
    /// remove persisted Session storage through this operation.
    async fn discard_transient_session(
        &self,
        request: AgentSessionReleaseRequest,
    ) -> PortResult<bool> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "transient session discard is not supported by this provider",
        ))
    }

    /// Quiesces and unloads a durable Session while preserving its persisted
    /// state so another runtime can restore it later.
    async fn unload_persisted_session(
        &self,
        request: AgentSessionReleaseRequest,
    ) -> PortResult<bool> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "persisted session unload is not supported by this provider",
        ))
    }
}

#[async_trait::async_trait]
pub trait AgentLocalCommandTurnPort: Send + Sync {
    async fn record_completed_local_command_turn(
        &self,
        request: AgentLocalCommandTurnRecordRequest,
    ) -> PortResult<AgentLocalCommandTurnRecordResult>;
}

#[async_trait::async_trait]
pub trait AgentUserShellCommandPort: Send + Sync {
    async fn run_user_shell_command(
        &self,
        request: AgentUserShellCommandRequest,
    ) -> PortResult<AgentUserShellCommandResult>;
}

#[async_trait::async_trait]
pub trait AgentSessionModelPort: Send + Sync {
    async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> PortResult<()>;

    async fn update_session_model(
        &self,
        request: AgentSessionModelUpdateRequest,
    ) -> PortResult<()> {
        self.update_session_model_selection(AgentSessionModelSelectionUpdateRequest {
            session_id: request.session_id,
            selection: AgentSessionModelSelection {
                model_id: request.model_id,
                reasoning_preset: None,
            },
        })
        .await
    }
}

#[async_trait::async_trait]
pub trait AgentSessionModePort: Send + Sync {
    async fn update_session_mode(&self, request: AgentSessionModeUpdateRequest) -> PortResult<()>;
}

#[async_trait::async_trait]
#[async_trait::async_trait]
pub trait AgentSessionCompactionPort: Send + Sync {
    async fn start_session_compaction(
        &self,
        request: AgentSessionCompactionRequest,
    ) -> PortResult<AgentSessionCompactionResult>;
}

/// Local Session history mutation requested by an interactive product surface.
///
/// This is deliberately narrower than a generic checkpoint or workspace rewind
/// API: one Core-owned operation keeps the persisted transcript, model context,
/// and tracked workspace files on the same staged boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRevertRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only path projection for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRollbackToTurnRequest {
    /// Upgrade-only path projection for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    /// Stable workspace identity supplied by newer product surfaces. This is
    /// optional so older clients keep using the path-based compatibility path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Legacy host projection. Never infer workspace kind from this or an ID prefix;
    /// the host must resolve workspace_id to its authoritative workspace object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_hostname: Option<String>,
    pub session_id: String,
    pub target_turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_storage_turn_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_catalog_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSessionWorkspaceLocation {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentSessionComposerUpdate {
    Preserve,
    Replace { text: String },
    Clear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRevertResult {
    pub session_id: String,
    pub transcript: SessionTranscript,
    pub composer: AgentSessionComposerUpdate,
    /// Active and queued Turns retired by the maintenance boundary. Consumers
    /// use this as an event-stream fence after replacing their local projection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retired_turn_ids: Vec<String>,
    pub changed: bool,
    pub hidden_turn_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_storage_turn_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restored_files: Vec<String>,
    /// The mutation committed, but the response could not include an
    /// authoritative transcript. Consumers must reload before using their
    /// local Session projection.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reload_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reload_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentSessionRollbackToTurnOutcome {
    Completed {
        #[serde(flatten)]
        result: AgentSessionRevertResult,
    },
    RecoveryRequired {
        session_id: String,
        mutation_id: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        affected_files: Vec<String>,
        reason: String,
    },
}

#[async_trait::async_trait]
pub trait AgentSessionRevertPort: Send + Sync {
    async fn undo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> PortResult<AgentSessionRevertResult>;

    async fn redo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> PortResult<AgentSessionRevertResult>;

    async fn rollback_session_to_turn(
        &self,
        request: AgentSessionRollbackToTurnRequest,
    ) -> PortResult<AgentSessionRollbackToTurnOutcome> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "targeted Session rollback is not supported",
        ))
    }
}

#[async_trait::async_trait]
pub trait AgentSessionForkPort: Send + Sync {
    async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> PortResult<AgentSessionForkResult>;

    async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "exact-turn session fork is not supported by this provider",
        ))
    }

    async fn fork_session_before_turn(
        &self,
        request: AgentSessionForkBeforeTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        let _ = request;
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "before-turn session fork is not supported by this provider",
        ))
    }
}

#[async_trait::async_trait]
pub trait AgentSessionUsagePort: Send + Sync {
    async fn generate_session_usage(
        &self,
        request: AgentSessionUsageRequest,
    ) -> PortResult<openbitfun_core_types::SessionUsageReport>;
}

#[async_trait::async_trait]
pub trait AgentTurnSettlementPort: Send + Sync {
    async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> PortResult<AgentTurnSettlementResult>;
}

#[async_trait::async_trait]
pub trait AgentDialogTurnPort: Send + Sync {
    async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> PortResult<DialogSubmitOutcome>;

    async fn steer_dialog_turn(
        &self,
        _request: AgentDialogSteerRequest,
    ) -> PortResult<DialogSteerOutcome> {
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "dialog turn steering is not supported by this provider",
        ))
    }

    async fn recover_interrupted_turn(
        &self,
        _request: AgentDialogTurnRecoveryRequest,
    ) -> PortResult<AgentDialogTurnRecoveryOutcome> {
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "interrupted dialog turn recovery is not supported by this provider",
        ))
    }
}

#[async_trait::async_trait]
pub trait AgentLifecycleDeliveryPort: Send + Sync {
    async fn deliver_background_result(
        &self,
        request: AgentBackgroundResultRequest,
    ) -> PortResult<()>;

    async fn deliver_thread_goal(&self, request: AgentThreadGoalDeliveryRequest) -> PortResult<()>;
}

#[async_trait::async_trait]
pub trait AgentThreadGoalManagementPort: Send + Sync {
    async fn get_thread_goal(
        &self,
        request: AgentThreadGoalGetRequest,
    ) -> PortResult<Option<ThreadGoal>>;

    async fn create_thread_goal(
        &self,
        request: AgentThreadGoalCreateRequest,
    ) -> PortResult<ThreadGoal>;

    async fn update_thread_goal_status(
        &self,
        request: AgentThreadGoalUpdateStatusRequest,
    ) -> PortResult<ThreadGoal>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnCancellationRequest {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentSubmissionSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requester_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_timeout_ms: Option<u64>,
    /// Whether a Session-wide cancellation also cascades into descendants.
    #[serde(default = "default_cancel_descendants")]
    pub cancel_descendants: bool,
}

fn default_cancel_descendants() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnCancellationResult {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub requested: bool,
}

/// Request an intentional, recoverable interruption of one active Turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnInterruptionRequest {
    pub session_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentSubmissionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnInterruptionResult {
    pub session_id: String,
    pub turn_id: String,
    pub requested: bool,
}

#[async_trait::async_trait]
pub trait AgentTurnCancellationPort: Send + Sync {
    async fn cancel_turn(
        &self,
        request: AgentTurnCancellationRequest,
    ) -> PortResult<AgentTurnCancellationResult>;

    async fn interrupt_turn(
        &self,
        _request: AgentTurnInterruptionRequest,
    ) -> PortResult<AgentTurnInterruptionResult> {
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "recoverable interruption is not supported by this provider",
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteControlSessionState {
    Idle,
    Processing,
    Error,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStateRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStateSnapshot {
    pub session_id: String,
    pub state: RemoteControlSessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(default)]
    pub queue_depth: usize,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[async_trait::async_trait]
pub trait RemoteControlStatePort: Send + Sync {
    async fn read_remote_control_state(
        &self,
        request: RemoteControlStateRequest,
    ) -> PortResult<Option<RemoteControlStateSnapshot>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptRequest {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscript {
    pub session_id: String,
    #[serde(default)]
    pub messages: Vec<TranscriptMessage>,
}

/// Read-only transcript content shared by runtime consumers.
///
/// This projection preserves portable history facts without exposing the Core persistence
/// message type. Multimodal entries report attachment counts rather than transporting image
/// payloads; callers that need attachment content require a separate, authorized capability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TranscriptContent {
    Text(String),
    Multimodal {
        text: String,
        image_count: usize,
    },
    ToolResult {
        tool_id: String,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effective_tool_name: Option<String>,
        result: serde_json::Value,
        is_error: bool,
    },
    Mixed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
        text: String,
        #[serde(default)]
        tool_calls: Vec<TranscriptToolCall>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptToolCall {
    pub tool_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
    pub content: TranscriptContent,
}

#[async_trait::async_trait]
pub trait SessionTranscriptReader: Send + Sync {
    async fn read_session_transcript(
        &self,
        request: SessionTranscriptRequest,
    ) -> PortResult<SessionTranscript>;
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn workspace_binding_reads_legacy_shape_without_guessing_kind() {
        let legacy =
            serde_json::json!({"workspacePath":"/same/path", "remoteConnectionId":"ssh-1"});
        let binding: AgentSessionWorkspaceBinding = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(binding.workspace_kind, None);
        assert_eq!(binding.workspace_id, None);
        assert_eq!(binding.project_workspace_id, None);
        assert_eq!(serde_json::to_value(binding).unwrap(), legacy);
        let current = serde_json::json!({"workspacePath":"/same/path", "workspaceId":"Workspace-A", "projectWorkspaceId":"Project-A", "workspaceKind":"normal", "remoteConnectionId":"stale-ssh"});
        let binding: AgentSessionWorkspaceBinding =
            serde_json::from_value(current.clone()).unwrap();
        assert_eq!(
            binding.workspace_kind,
            Some(openbitfun_core_types::WorkspaceKind::Normal)
        );
        assert_eq!(serde_json::to_value(binding).unwrap(), current);
    }

    #[test]
    fn turn_settlement_result_serializes_authoritative_terminal_facts() {
        let result = AgentTurnSettlementResult {
            status: AgentTurnSettlementStatus::Completed,
            final_response: Some("final answer".to_string()),
            finish_reason: Some("complete".to_string()),
        };

        assert_eq!(
            serde_json::to_value(&result).expect("serialize turn settlement result"),
            serde_json::json!({
                "status": "completed",
                "finalResponse": "final answer",
                "finishReason": "complete",
            })
        );
        assert_eq!(
            serde_json::from_value::<AgentTurnSettlementResult>(serde_json::json!({
                "status": "cancelled"
            }))
            .expect("deserialize turn settlement result"),
            AgentTurnSettlementResult {
                status: AgentTurnSettlementStatus::Cancelled,
                final_response: None,
                finish_reason: None,
            }
        );
    }
    #[test]
    fn session_revert_contract_preserves_authoritative_transcript_and_composer_intent() {
        let result = AgentSessionRevertResult {
            session_id: "session-1".to_string(),
            transcript: SessionTranscript {
                session_id: "session-1".to_string(),
                messages: Vec::new(),
            },
            composer: AgentSessionComposerUpdate::Replace {
                text: "restore this prompt".to_string(),
            },
            retired_turn_ids: vec!["turn-2".to_string(), "turn-queued".to_string()],
            changed: true,
            hidden_turn_count: 2,
            boundary_storage_turn_index: Some(7),
            target_turn_id: Some("turn-1".to_string()),
            restored_files: vec!["src/lib.rs".to_string()],
            reload_required: false,
            reload_reason: None,
        };

        let value = serde_json::to_value(&result).expect("session revert result should serialize");
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["composer"]["kind"], "replace");
        assert_eq!(value["composer"]["text"], "restore this prompt");
        assert_eq!(value["hiddenTurnCount"], 2);
        assert_eq!(value["retiredTurnIds"][1], "turn-queued");
        assert!(value.get("reloadRequired").is_none());
        assert!(value.get("reloadReason").is_none());
        assert_eq!(
            serde_json::from_value::<AgentSessionRevertResult>(value)
                .expect("session revert result should deserialize"),
            result
        );
    }

    #[test]
    fn targeted_session_rollback_contract_uses_camel_case_and_typed_outcomes() {
        let request = AgentSessionRollbackToTurnRequest {
            workspace_path: "E:/workspace".to_string(),
            workspace_id: Some("local_workspace-1".to_string()),
            workspace_hostname: Some("localhost".to_string()),
            session_id: "session-1".to_string(),
            target_turn_id: "turn-7".to_string(),
            expected_storage_turn_index: Some(7),
            expected_catalog_revision: Some("catalog-3".to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let request_json = serde_json::to_value(&request).expect("serialize rollback request");
        assert_eq!(request_json["workspacePath"], "E:/workspace");
        assert_eq!(request_json["workspaceId"], "local_workspace-1");
        assert_eq!(request_json["workspaceHostname"], "localhost");
        assert_eq!(request_json["targetTurnId"], "turn-7");
        assert_eq!(request_json["expectedStorageTurnIndex"], 7);
        assert_eq!(request_json["expectedCatalogRevision"], "catalog-3");
        assert_eq!(
            serde_json::from_value::<AgentSessionRollbackToTurnRequest>(request_json)
                .expect("deserialize rollback request"),
            request
        );

        let legacy_request =
            serde_json::from_value::<AgentSessionRollbackToTurnRequest>(serde_json::json!({
                "workspacePath": "E:/workspace",
                "sessionId": "session-1",
                "targetTurnId": "turn-7"
            }))
            .expect("deserialize pre-workspace-identity rollback request");
        assert_eq!(legacy_request.workspace_id, None);
        assert_eq!(legacy_request.workspace_hostname, None);
        // IDs are opaque. SSH metadata is an old projection, not type authority.
        let request_with_id: AgentSessionRollbackToTurnRequest =
            serde_json::from_value(serde_json::json!({
                "workspaceId": "opaque-workspace-id", "remoteConnectionId": "stale-projection",
                "sessionId": "session-1", "targetTurnId": "turn-7"
            }))
            .unwrap();
        assert_eq!(
            request_with_id.workspace_id.as_deref(),
            Some("opaque-workspace-id")
        );
        assert_eq!(request_with_id.workspace_path, "");

        let completed = AgentSessionRollbackToTurnOutcome::Completed {
            result: AgentSessionRevertResult {
                session_id: "session-1".to_string(),
                transcript: SessionTranscript {
                    session_id: "session-1".to_string(),
                    messages: Vec::new(),
                },
                composer: AgentSessionComposerUpdate::Preserve,
                retired_turn_ids: vec!["turn-7".to_string()],
                changed: true,
                hidden_turn_count: 1,
                boundary_storage_turn_index: Some(7),
                target_turn_id: Some("turn-7".to_string()),
                restored_files: vec!["src/lib.rs".to_string()],
                reload_required: true,
                reload_reason: Some("transcript read failed".to_string()),
            },
        };
        let completed_json =
            serde_json::to_value(&completed).expect("serialize completed rollback");
        assert_eq!(completed_json["status"], "completed");
        assert_eq!(completed_json["boundaryStorageTurnIndex"], 7);
        assert_eq!(completed_json["retiredTurnIds"][0], "turn-7");
        assert_eq!(completed_json["reloadRequired"], true);
        assert_eq!(completed_json["reloadReason"], "transcript read failed");

        let recovery = AgentSessionRollbackToTurnOutcome::RecoveryRequired {
            session_id: "session-1".to_string(),
            mutation_id: "mutation-1".to_string(),
            affected_files: vec!["src/lib.rs".to_string()],
            reason: "authoritative reload failed".to_string(),
        };
        let recovery_json = serde_json::to_value(&recovery).expect("serialize recovery rollback");
        assert_eq!(recovery_json["status"], "recovery_required");
        assert_eq!(recovery_json["mutationId"], "mutation-1");
        assert_eq!(recovery_json["affectedFiles"][0], "src/lib.rs");
    }

    #[test]
    fn workspace_reference_metadata_round_trips_without_expanding_dialog_turn_dto() {
        let references = vec![AgentWorkspaceReference {
            path: "src/lib.rs".to_string(),
            kind: AgentWorkspaceReferenceKind::File,
            start_line: Some(12),
            end_line: Some(24),
            source: AgentWorkspaceReferenceSourceRange {
                start: 7,
                end: 28,
                value: "@src/lib.rs#12-24".to_string(),
            },
        }];
        let mut metadata = serde_json::Map::new();

        put_agent_workspace_references(&mut metadata, &references)
            .expect("workspace reference metadata should serialize");

        assert_eq!(
            agent_workspace_references_from_metadata(&metadata)
                .expect("workspace reference metadata should deserialize"),
            references
        );
        assert_eq!(
            metadata[AGENT_WORKSPACE_REFERENCES_METADATA_KEY][0]["startLine"],
            12
        );
    }

    #[test]
    fn workspace_reference_metadata_rejects_invalid_shapes() {
        let metadata = serde_json::Map::from_iter([(
            AGENT_WORKSPACE_REFERENCES_METADATA_KEY.to_string(),
            serde_json::json!([{"path": 7}]),
        )]);

        let error = agent_workspace_references_from_metadata(&metadata)
            .expect_err("invalid workspace reference metadata must fail closed");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);

        let too_many = vec![
            serde_json::json!({
                "path": "src/lib.rs",
                "kind": "file",
                "source": {"start": 0, "end": 11, "value": "@src/lib.rs"}
            });
            MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN + 1
        ];
        let metadata = serde_json::Map::from_iter([(
            AGENT_WORKSPACE_REFERENCES_METADATA_KEY.to_string(),
            serde_json::Value::Array(too_many),
        )]);
        assert!(agent_workspace_references_from_metadata(&metadata).is_err());

        let references = vec![
            AgentWorkspaceReference {
                path: "src/lib.rs".to_string(),
                kind: AgentWorkspaceReferenceKind::File,
                start_line: None,
                end_line: None,
                source: AgentWorkspaceReferenceSourceRange {
                    start: 0,
                    end: 11,
                    value: "@src/lib.rs".to_string(),
                },
            };
            MAX_AGENT_WORKSPACE_REFERENCES_PER_TURN + 1
        ];
        assert!(put_agent_workspace_references(&mut serde_json::Map::new(), &references).is_err());
    }

    #[test]
    fn context_reload_contract_is_closed_and_target_specific() {
        let cases = [
            (AgentContextReloadTarget::All, "all", true, true),
            (AgentContextReloadTarget::Skills, "skills", true, false),
            (
                AgentContextReloadTarget::Instructions,
                "instructions",
                false,
                true,
            ),
        ];

        for (target, serialized_target, skills, instructions) in cases {
            assert_eq!(target.includes_skills(), skills);
            assert_eq!(target.includes_instructions(), instructions);
            let request = AgentContextReloadRequest {
                session_id: "session-1".to_string(),
                target,
            };
            assert_eq!(
                serde_json::to_value(&request).expect("serialize request"),
                serde_json::json!({
                    "sessionId": "session-1",
                    "target": serialized_target,
                })
            );
            assert_eq!(
                serde_json::from_value::<AgentContextReloadRequest>(serde_json::json!({
                    "sessionId": "session-1",
                    "target": serialized_target,
                }))
                .expect("deserialize request"),
                request
            );
        }

        assert!(
            serde_json::from_value::<AgentContextReloadRequest>(serde_json::json!({
                "sessionId": "session-1",
                "target": "all",
                "unexpected": true,
            }))
            .is_err()
        );
    }

    #[derive(Default)]
    struct ArchiveOnlySessionProvider {
        archived_requests: Mutex<Vec<AgentSessionArchiveRequest>>,
    }

    #[async_trait::async_trait]
    impl AgentSessionManagementPort for ArchiveOnlySessionProvider {
        async fn list_sessions(
            &self,
            _request: AgentSessionListRequest,
        ) -> PortResult<Vec<AgentSessionSummary>> {
            Ok(Vec::new())
        }

        async fn delete_session(&self, _request: AgentSessionDeleteRequest) -> PortResult<()> {
            Ok(())
        }

        async fn archive_session(&self, request: AgentSessionArchiveRequest) -> PortResult<()> {
            self.archived_requests.lock().unwrap().push(request);
            Ok(())
        }

        async fn resolve_session_workspace_binding(
            &self,
            _request: AgentSessionWorkspaceRequest,
        ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
            Ok(None)
        }
    }

    struct LatestTurnForkOnlyProvider;

    #[async_trait::async_trait]
    impl AgentSessionForkPort for LatestTurnForkOnlyProvider {
        async fn fork_session(
            &self,
            request: AgentSessionForkRequest,
        ) -> PortResult<AgentSessionForkResult> {
            Ok(AgentSessionForkResult {
                session_id: format!("{}-fork", request.source_session_id),
                session_name: "Fork".to_string(),
                agent_type: "Standard".to_string(),
            })
        }
    }

    fn archive_state_request(archived: bool) -> AgentSessionArchiveStateRequest {
        AgentSessionArchiveStateRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            archived,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        }
    }

    #[tokio::test]
    async fn archive_state_default_preserves_archive_only_provider_compatibility() {
        let provider = ArchiveOnlySessionProvider::default();

        AgentSessionManagementPort::set_session_archived(&provider, archive_state_request(true))
            .await
            .expect("archive=true should delegate to the legacy provider");
        // Scoped so the guard is provably released before the await below.
        {
            let requests = provider.archived_requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].workspace_path, "/workspace/project");
            assert_eq!(requests[0].session_id, "session_1");
            assert_eq!(requests[0].remote_connection_id.as_deref(), Some("conn-1"));
            assert_eq!(requests[0].remote_ssh_host.as_deref(), Some("host-1"));
        }

        let error = AgentSessionManagementPort::set_session_archived(
            &provider,
            archive_state_request(false),
        )
        .await
        .expect_err("legacy providers must reject unarchive by default");
        assert_eq!(error.kind, PortErrorKind::NotAvailable);
        assert_eq!(provider.archived_requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn fork_workspace_id_wire_contract_preserves_100_payloads() {
        let id_only = serde_json::json!({"workspaceId":"workspace-1","sourceSessionId":"session-1","sourceTurnId":"turn-1"});
        let latest: AgentSessionForkRequest = serde_json::from_value(id_only.clone()).unwrap();
        let at: AgentSessionForkAtTurnRequest = serde_json::from_value(id_only.clone()).unwrap();
        let before: AgentSessionForkBeforeTurnRequest = serde_json::from_value(id_only).unwrap();
        assert_eq!(latest.workspace_id.as_deref(), Some("workspace-1"));
        assert!(latest.workspace_path.is_empty());
        assert!(at.workspace_path.is_empty());
        assert!(before.workspace_path.is_empty());
        let legacy = serde_json::json!({"workspacePath":"/srv/project","sourceSessionId":"session-1","sourceTurnId":"turn-1","remoteConnectionId":"ssh-1"});
        let latest: AgentSessionForkRequest = serde_json::from_value(legacy.clone()).unwrap();
        let at: AgentSessionForkAtTurnRequest = serde_json::from_value(legacy.clone()).unwrap();
        let before: AgentSessionForkBeforeTurnRequest = serde_json::from_value(legacy).unwrap();
        assert!(latest.workspace_id.is_none());
        for value in [
            serde_json::to_value(latest).unwrap(),
            serde_json::to_value(at).unwrap(),
            serde_json::to_value(before).unwrap(),
        ] {
            assert_eq!(value["workspacePath"], "/srv/project");
            assert_eq!(value["remoteConnectionId"], "ssh-1");
            assert!(value.get("workspaceId").is_none());
        }
    }

    #[tokio::test]
    async fn exact_turn_fork_default_preserves_latest_turn_only_provider_compatibility() {
        let provider = LatestTurnForkOnlyProvider;
        let error = AgentSessionForkPort::fork_session_at_turn(
            &provider,
            AgentSessionForkAtTurnRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                source_session_id: "session_1".to_string(),
                source_turn_id: "turn_1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        )
        .await
        .expect_err("legacy providers must reject exact-turn fork by default");

        assert_eq!(error.kind, PortErrorKind::NotAvailable);
    }

    #[tokio::test]
    async fn before_turn_fork_default_preserves_existing_provider_compatibility() {
        let provider = LatestTurnForkOnlyProvider;
        let error = AgentSessionForkPort::fork_session_before_turn(
            &provider,
            AgentSessionForkBeforeTurnRequest {
                workspace_id: None,
                workspace_path: "/workspace/project".to_string(),
                source_session_id: "session_1".to_string(),
                source_turn_id: "turn_1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        )
        .await
        .expect_err("existing providers must reject before-turn fork by default");

        assert_eq!(error.kind, PortErrorKind::NotAvailable);
    }

    #[test]
    fn session_mutations_accept_ids_without_paths_and_preserve_old_payloads() {
        let id_only = serde_json::json!({"workspaceId":"workspace-1","sessionId":"session-1"});
        let delete: AgentSessionDeleteRequest = serde_json::from_value(id_only.clone()).unwrap();
        assert_eq!(delete.workspace_id.as_deref(), Some("workspace-1"));
        assert!(delete.workspace_path.is_empty());
        let archive: AgentSessionArchiveRequest = serde_json::from_value(id_only).unwrap();
        assert_eq!(archive.workspace_id.as_deref(), Some("workspace-1"));
        let old = serde_json::json!({"workspacePath":"/project","sessionId":"session-1"});
        let legacy: AgentSessionDeleteRequest = serde_json::from_value(old.clone()).unwrap();
        assert!(legacy.workspace_id.is_none());
        assert_eq!(serde_json::to_value(legacy).unwrap(), old);
        let lineage: AgentSessionLineageRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace-1", "anchorSessionId":"session-1"
        }))
        .unwrap();
        assert_eq!(lineage.workspace_id.as_deref(), Some("workspace-1"));
        assert!(lineage.workspace_path.is_empty());
    }

    #[test]
    fn agent_session_create_request_keeps_rust_literal_compatible() {
        let request = AgentSessionCreateRequest {
            agent_route_key: None,
            session_name: "Generated session".to_string(),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/workspace/project".to_string()),
            project_workspace_path: None,
            execution_target: None,
            workspace_id: Some("workspace-1".to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: Some("provider/model".to_string()),
            metadata: serde_json::Map::new(),
        };

        let json = serde_json::to_value(request).expect("serialize create request");

        assert!(json.get("sessionId").is_none());
        assert_eq!(json["workspaceId"], "workspace-1");
        assert_eq!(json["modelId"], "provider/model");
    }

    #[test]
    fn agent_session_create_request_keeps_legacy_payload_compatible() {
        let request: AgentSessionCreateRequest = serde_json::from_value(serde_json::json!({
            "sessionName": "Generated session",
            "agentType": "Standard",
            "workspacePath": "/workspace/project"
        }))
        .expect("deserialize legacy create request");

        let json = serde_json::to_value(request).expect("serialize create request");
        assert!(json.get("sessionId").is_none());
        assert!(json.get("workspaceId").is_none());
        assert!(json.get("modelId").is_none());
    }

    #[test]
    fn agent_session_create_result_keeps_legacy_payload_shape() {
        let legacy = serde_json::json!({
            "sessionId": "session_1",
            "sessionName": "Main",
            "agentType": "Standard"
        });

        let result: AgentSessionCreateResult =
            serde_json::from_value(legacy.clone()).expect("deserialize legacy create result");

        assert_eq!(result.workspace_path, None);
        assert_eq!(result.model_id, None);
        assert_eq!(result.workspace_id, None);
        assert_eq!(result.project_workspace_path, None);
        assert_eq!(result.execution_target, None);
        assert_eq!(
            serde_json::to_value(result).expect("serialize legacy create result"),
            legacy
        );
    }

    #[test]
    fn agent_session_create_result_carries_normalized_workspace_facts() {
        let result: AgentSessionCreateResult = serde_json::from_value(serde_json::json!({
            "sessionId": "session_1",
            "sessionName": "Main",
            "agentType": "Standard",
            "modelId": "provider/model",
            "workspacePath": "/worktrees/session_1",
            "workspaceId": "workspace_1",
            "projectWorkspacePath": "/workspace/project",
            "executionTarget": {
                "kind": "managedWorktree",
                "worktreeId": "worktree_1",
                "rootPath": "/worktrees/session_1",
                "baseRef": "main",
                "baseCommit": "0123456789abcdef",
                "branch": "openbitfun/session_1",
                "lifecycle": "managed"
            }
        }))
        .expect("deserialize complete create result");

        assert_eq!(
            result.workspace_path.as_deref(),
            Some("/worktrees/session_1")
        );
        assert_eq!(result.model_id.as_deref(), Some("provider/model"));
        assert_eq!(result.workspace_id.as_deref(), Some("workspace_1"));
        assert_eq!(
            result.project_workspace_path.as_deref(),
            Some("/workspace/project")
        );
        let target = result.execution_target.expect("resolved execution target");
        assert_eq!(target.kind, SessionExecutionTargetKind::ManagedWorktree);
        assert_eq!(target.worktree_id.as_deref(), Some("worktree_1"));
        assert_eq!(target.root_path, "/worktrees/session_1");
    }

    #[test]
    fn agent_submission_request_serializes_with_stable_camel_case() {
        let request = AgentSubmissionRequest {
            session_id: "session_1".to_string(),
            message: "hello".to_string(),
            turn_id: None,
            source: None,
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        };

        let json = serde_json::to_value(request).expect("serialize request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["message"], "hello");
        assert!(json.get("source").is_none());
        assert!(json.get("attachments").is_none());
    }

    #[test]
    fn agent_submission_request_serializes_source_without_changing_field_case() {
        let request = AgentSubmissionRequest {
            session_id: "session_1".to_string(),
            message: "hello".to_string(),
            turn_id: None,
            source: Some(AgentSubmissionSource::RemoteRelay),
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        };

        let json = serde_json::to_value(request).expect("serialize request");

        assert_eq!(json["source"], "remote_relay");
        assert!(json.get("turnId").is_none());
    }

    #[test]
    fn delegated_dialog_turn_target_is_typed_and_provider_neutral() {
        let target = AgentDialogTurnExecution::FreshExternalSubagent {
            ecosystem_id: "opencode".to_string(),
            logical_id: "reviewer".to_string(),
        };

        assert_eq!(
            serde_json::to_value(target).expect("serialize delegated execution"),
            serde_json::json!({
                "kind": "fresh_external_subagent",
                "ecosystemId": "opencode",
                "logicalId": "reviewer",
            })
        );
        assert_eq!(
            AgentDialogTurnExecution::default(),
            AgentDialogTurnExecution::Standard
        );
        assert!(
            serde_json::from_value::<AgentDialogTurnExecution>(serde_json::json!({
                "kind": "fresh_external_subagent",
                "ecosystemId": "opencode",
                "logicalId": "reviewer",
                "model": "provider/model"
            }))
            .is_err()
        );
    }

    #[test]
    fn dialog_submission_policy_preserves_current_surface_queue_defaults() {
        let remote = DialogSubmissionPolicy::for_source(DialogTriggerSource::RemoteRelay);
        assert_eq!(remote.queue_priority, DialogQueuePriority::Normal);

        let bot = DialogSubmissionPolicy::for_source(DialogTriggerSource::Bot);
        assert_eq!(bot.queue_priority, DialogQueuePriority::Normal);

        let agent_session = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);
        assert_eq!(agent_session.queue_priority, DialogQueuePriority::Low);

        let cli = DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli);
        assert_eq!(cli.queue_priority, DialogQueuePriority::Normal);

        let sdk_host = DialogSubmissionPolicy::for_source(DialogTriggerSource::SdkHost);
        assert_eq!(sdk_host.queue_priority, DialogQueuePriority::Normal);
    }

    #[test]
    fn dialog_submit_outcome_preserves_started_and_queued_fields() {
        let started = DialogSubmitOutcome::Started {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
        };
        let queued = DialogSubmitOutcome::Queued {
            session_id: "session_1".to_string(),
            turn_id: "turn_2".to_string(),
        };

        assert_eq!(
            started,
            DialogSubmitOutcome::Started {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
            }
        );
        assert_ne!(started, queued);
    }

    #[test]
    fn dialog_submit_queue_action_preserves_current_scheduler_routing_policy() {
        let remote = DialogSubmissionPolicy::for_source(DialogTriggerSource::RemoteRelay);

        let agent_session = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);

        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Missing,
                queue_has_items: true,
                policy: remote,
            }),
            DialogSubmitQueueAction::StartImmediately
        );
        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Error,
                queue_has_items: true,
                policy: remote,
            }),
            DialogSubmitQueueAction::ClearQueueAndStartImmediately
        );
        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Idle,
                queue_has_items: false,
                policy: remote,
            }),
            DialogSubmitQueueAction::StartImmediately
        );
        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Idle,
                queue_has_items: true,
                policy: remote,
            }),
            DialogSubmitQueueAction::EnqueueThenStartNext
        );
        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Processing,
                queue_has_items: false,
                policy: remote,
            }),
            DialogSubmitQueueAction::EnqueueForActiveTurn
        );
        assert_eq!(
            resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
                session_state: DialogSessionStateFact::Processing,
                queue_has_items: false,
                policy: agent_session,
            }),
            DialogSubmitQueueAction::EnqueueForActiveTurn
        );
    }

    #[test]
    fn agent_session_reply_decisions_preserve_cancel_suppression_boundary() {
        let policy = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);
        assert!(should_suppress_agent_session_cancelled_reply(
            &policy,
            Some("requester"),
            "requester",
        ));
        assert!(!should_suppress_agent_session_cancelled_reply(
            &policy,
            Some("requester"),
            "other",
        ));

        let remote = DialogSubmissionPolicy::for_source(DialogTriggerSource::RemoteRelay);
        assert!(!should_suppress_agent_session_cancelled_reply(
            &remote,
            Some("requester"),
            "requester",
        ));

        assert!(should_skip_agent_session_reply(
            DialogTurnOutcomeKind::Cancelled,
            true,
        ));
        assert!(!should_skip_agent_session_reply(
            DialogTurnOutcomeKind::Cancelled,
            false,
        ));
        assert!(!should_skip_agent_session_reply(
            DialogTurnOutcomeKind::Completed,
            true,
        ));
        assert!(!should_skip_agent_session_reply(
            DialogTurnOutcomeKind::Failed,
            true,
        ));
    }

    #[test]
    fn agent_session_reply_route_keeps_requester_fields() {
        let route = AgentSessionReplyRoute {
            source_session_id: "requester_session".to_string(),
            source_workspace_path: "/workspace/requester".to_string(),
            source_remote_connection_id: Some("conn-1".to_string()),
            source_remote_ssh_host: Some("host-1".to_string()),
        };

        assert_eq!(route.source_session_id, "requester_session");
        assert_eq!(route.source_workspace_path, "/workspace/requester");
        assert_eq!(route.source_remote_connection_id.as_deref(), Some("conn-1"));
        assert_eq!(route.source_remote_ssh_host.as_deref(), Some("host-1"));
    }

    #[test]
    fn dialog_steer_outcome_preserves_buffered_fields() {
        let outcome = DialogSteerOutcome::Buffered {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            steering_id: "steer_1".to_string(),
        };

        assert_eq!(
            outcome,
            DialogSteerOutcome::Buffered {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                steering_id: "steer_1".to_string(),
            }
        );
    }

    #[test]
    fn round_injection_contract_keeps_kind_and_target_identity() {
        assert_eq!(
            RoundInjectionKind::UserSteering,
            RoundInjectionKind::UserSteering
        );
        assert_ne!(
            RoundInjectionKind::UserSteering,
            RoundInjectionKind::BackgroundResult
        );

        let target = RoundInjectionTarget::ExactTurn("turn_1".to_string());
        assert_eq!(
            target,
            RoundInjectionTarget::ExactTurn("turn_1".to_string())
        );
        assert_ne!(target, RoundInjectionTarget::CurrentRunningTurn);
        assert_eq!(
            RoundInjectionKind::UserSteering
                .default_execution_policy()
                .tool_preemption,
            RoundInjectionToolPreemption::InterruptAfterCurrentAtomicUnit
        );
        assert_eq!(
            RoundInjectionKind::BackgroundResult
                .default_execution_policy()
                .tool_preemption,
            RoundInjectionToolPreemption::None
        );
    }

    #[test]
    fn round_injection_source_contract_drains_portable_injections() {
        struct StaticInjectionSource {
            injection: RoundInjection,
        }

        impl DialogRoundInjectionSource for StaticInjectionSource {
            fn has_pending(&self, session_id: &str, turn_id: &str) -> bool {
                session_id == "session_1" && turn_id == "turn_1"
            }

            fn pending_tool_preemption(
                &self,
                session_id: &str,
                turn_id: &str,
            ) -> RoundInjectionToolPreemption {
                if self.has_pending(session_id, turn_id) {
                    self.injection.execution_policy.tool_preemption
                } else {
                    RoundInjectionToolPreemption::None
                }
            }

            fn take_pending(&self, session_id: &str, turn_id: &str) -> Vec<RoundInjection> {
                if self.has_pending(session_id, turn_id) {
                    vec![self.injection.clone()]
                } else {
                    Vec::new()
                }
            }
        }

        let source = StaticInjectionSource {
            injection: RoundInjection {
                id: "injection_1".to_string(),
                kind: RoundInjectionKind::BackgroundResult,
                execution_policy: RoundInjectionKind::BackgroundResult.default_execution_policy(),
                target: RoundInjectionTarget::CurrentRunningTurn,
                content: "result".to_string(),
                display_content: "result".to_string(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
                created_at: std::time::SystemTime::UNIX_EPOCH,
            },
        };

        assert!(source.has_pending("session_1", "turn_1"));
        assert!(!source.has_pending("session_2", "turn_1"));
        assert_eq!(
            source.pending_tool_preemption("session_1", "turn_1"),
            RoundInjectionToolPreemption::None
        );
        let drained = source.take_pending("session_1", "turn_1");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].id, "injection_1");
        assert_eq!(drained[0].kind, RoundInjectionKind::BackgroundResult);
    }

    #[test]
    fn thread_goal_active_status_includes_budget_limited() {
        let active = ThreadGoal {
            goal_id: "goal_1".to_string(),
            session_id: "session_1".to_string(),
            objective: "Ship feature".to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: Some(10_000),
            tokens_used: 100,
            time_used_seconds: 5,
            created_at: 1,
            updated_at: 2,
            auto_continuation_count: 0,
        };
        assert!(active.is_active());
        assert_eq!(active.remaining_tokens(), Some(9_900));

        let budget_limited = ThreadGoal {
            status: ThreadGoalStatus::BudgetLimited,
            ..active.clone()
        };
        assert!(budget_limited.is_active());

        let paused = ThreadGoal {
            status: ThreadGoalStatus::Paused,
            ..active
        };
        assert!(!paused.is_active());
    }

    #[test]
    fn thread_goal_tool_response_serializes_optional_fields() {
        let response = ThreadGoalToolResponse {
            goal: None,
            remaining_tokens: Some(42),
            completion_budget_report: None,
        };
        let json = serde_json::to_value(response).expect("serialize thread goal tool response");
        assert!(json.get("goal").is_none());
        assert_eq!(json["remainingTokens"], 42);
        assert!(json.get("completionBudgetReport").is_none());
    }

    #[test]
    fn compression_contract_renders_model_visible_fields() {
        let contract = CompressionContract {
            touched_files: vec!["src/lib.rs".to_string()],
            verification_commands: vec![CompressionContractItem {
                target: "cargo test -p openbitfun-runtime-ports".to_string(),
                status: "passed".to_string(),
                summary: "runtime ports contract tests passed".to_string(),
                error_kind: None,
            }],
            blocking_failures: vec![CompressionContractItem {
                target: "cargo check".to_string(),
                status: "failed".to_string(),
                summary: "compile error before migration".to_string(),
                error_kind: Some("compile".to_string()),
            }],
            subagent_statuses: Vec::new(),
        };

        let rendered = contract.render_for_model();

        assert!(rendered.contains("The following facts were retained during compression."));
        assert!(rendered.contains("Touched files:"));
        assert!(rendered.contains("- src/lib.rs"));
        assert!(rendered.contains(
            "- cargo test -p openbitfun-runtime-ports [passed]: runtime ports contract tests passed"
        ));
        assert!(
            rendered.contains("- cargo check [failed]: compile error before migration (compile)")
        );
    }

    #[test]
    fn agent_submission_request_serializes_explicit_turn_id_contract() {
        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "turnId".to_string(),
            serde_json::Value::String("legacy_metadata_turn".to_string()),
        );
        let request = AgentSubmissionRequest {
            session_id: "session_1".to_string(),
            message: "hello".to_string(),
            turn_id: Some("explicit_turn".to_string()),
            source: Some(AgentSubmissionSource::RemoteRelay),
            attachments: Vec::new(),
            metadata,
        };

        let json = serde_json::to_value(request).expect("serialize request");

        assert_eq!(json["turnId"], "explicit_turn");
        assert_eq!(json["metadata"]["turnId"], "legacy_metadata_turn");
    }

    #[test]
    fn remote_image_attachment_serializes_portable_metadata_contract() {
        let attachment =
            AgentInputAttachment::remote_image("image-1", "clip.png", "data:image/png;base64,abc");

        let json = serde_json::to_value(attachment).expect("serialize attachment");

        assert_eq!(json["kind"], "remote_image");
        assert_eq!(json["id"], "image-1");
        assert_eq!(json["metadata"]["name"], "clip.png");
        assert_eq!(json["metadata"]["dataUrl"], "data:image/png;base64,abc");
    }

    #[test]
    fn agent_dialog_turn_request_serializes_lifecycle_contract() {
        let request = AgentDialogTurnRequest {
            session_id: "session_1".to_string(),
            message: "hello".to_string(),
            output_schema: Some(serde_json::json!({ "type": "object" })),
            original_message: Some("raw hello".to_string()),
            turn_id: Some("turn_1".to_string()),
            execution: Default::default(),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/workspace/project".to_string()),
            workspace_id: None,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
            policy: DialogSubmissionPolicy::new(
                AgentSubmissionSource::RemoteRelay,
                DialogQueuePriority::High,
            ),
            reply_route: Some(AgentSessionReplyRoute {
                source_session_id: "source_session".to_string(),
                source_workspace_path: "/workspace/source".to_string(),
                source_remote_connection_id: Some("conn-1".to_string()),
                source_remote_ssh_host: Some("host-1".to_string()),
            }),
            prepended_reminders: vec![AgentDialogPrependedReminder {
                kind: "session_message_request".to_string(),
                text: "sent by another agent".to_string(),
            }],
            attachments: vec![AgentInputAttachment::remote_image(
                "image-1",
                "clip.png",
                "data:image/png;base64,abc",
            )],
            metadata: serde_json::Map::new(),
        };

        let json = serde_json::to_value(request).expect("serialize dialog turn request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["message"], "hello");
        assert_eq!(json["outputSchema"]["type"], "object");
        assert_eq!(json["originalMessage"], "raw hello");
        assert_eq!(json["turnId"], "turn_1");
        assert_eq!(json["agentType"], "Standard");
        assert_eq!(json["workspacePath"], "/workspace/project");
        assert_eq!(json["remoteConnectionId"], "conn-1");
        assert_eq!(json["remoteSshHost"], "host-1");
        assert_eq!(json["policy"]["triggerSource"], "remote_relay");
        assert_eq!(json["policy"]["queuePriority"], "high");
        assert!(json["policy"].get("skipToolConfirmation").is_none());
        assert_eq!(json["replyRoute"]["sourceSessionId"], "source_session");
        assert_eq!(json["replyRoute"]["sourceRemoteConnectionId"], "conn-1");
        assert_eq!(json["replyRoute"]["sourceRemoteSshHost"], "host-1");
        assert_eq!(
            json["prependedReminders"][0]["kind"],
            "session_message_request"
        );
        assert_eq!(json["attachments"][0]["kind"], "remote_image");
    }

    #[test]
    fn agent_dialog_steer_contract_round_trips_exact_turn_identity() {
        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "kind".to_string(),
            serde_json::Value::String("steering".to_string()),
        );
        let request = AgentDialogSteerRequest {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            content: "Please also check the tests".to_string(),
            display_content: Some("Also check tests".to_string()),
            attachments: vec![AgentInputAttachment::remote_image(
                "image-1",
                "shot.png",
                "data:image/png;base64,abc",
            )],
            metadata,
        };
        let outcome = DialogSteerOutcome::Buffered {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            steering_id: "steer_1".to_string(),
        };

        let request_json = serde_json::to_value(&request).expect("serialize steer request");
        let outcome_json = serde_json::to_value(&outcome).expect("serialize steer outcome");

        assert_eq!(request_json["sessionId"], "session_1");
        assert_eq!(request_json["turnId"], "turn_1");
        assert_eq!(request_json["content"], "Please also check the tests");
        assert_eq!(request_json["displayContent"], "Also check tests");
        // A steering message carries the same payload a turn submission does.
        assert_eq!(request_json["attachments"][0]["kind"], "remote_image");
        assert_eq!(request_json["metadata"]["kind"], "steering");
        assert_eq!(outcome_json["kind"], "buffered");
        assert_eq!(outcome_json["sessionId"], "session_1");
        assert_eq!(outcome_json["turnId"], "turn_1");
        assert_eq!(outcome_json["steeringId"], "steer_1");

        assert_eq!(
            serde_json::from_value::<AgentDialogSteerRequest>(request_json)
                .expect("deserialize steer request"),
            request
        );
        assert_eq!(
            serde_json::from_value::<DialogSteerOutcome>(outcome_json)
                .expect("deserialize steer outcome"),
            outcome
        );
    }

    #[test]
    fn agent_background_result_request_serializes_lifecycle_contract() {
        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "kind".to_string(),
            serde_json::Value::String("background_result".to_string()),
        );
        let request = AgentBackgroundResultRequest {
            session_id: "session_1".to_string(),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/workspace/project".to_string()),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
            content: "full result".to_string(),
            display_content: Some("short result".to_string()),
            metadata,
        };

        let json = serde_json::to_value(request).expect("serialize background result request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["agentType"], "Standard");
        assert_eq!(json["workspacePath"], "/workspace/project");
        assert_eq!(json["remoteConnectionId"], "conn-1");
        assert_eq!(json["remoteSshHost"], "host-1");
        assert_eq!(json["content"], "full result");
        assert_eq!(json["displayContent"], "short result");
        assert_eq!(json["metadata"]["kind"], "background_result");
    }

    #[test]
    fn agent_thread_goal_delivery_request_serializes_lifecycle_contract() {
        let request = AgentThreadGoalDeliveryRequest {
            session_id: "session_1".to_string(),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/workspace/project".to_string()),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
            kind: AgentThreadGoalDeliveryKind::ObjectiveUpdated,
            goal: ThreadGoal {
                goal_id: "goal_1".to_string(),
                session_id: "session_1".to_string(),
                objective: "Ship the refactor".to_string(),
                status: ThreadGoalStatus::Active,
                token_budget: Some(1000),
                tokens_used: 10,
                time_used_seconds: 0,
                created_at: 1,
                updated_at: 2,
                auto_continuation_count: 0,
            },
        };

        let json = serde_json::to_value(request).expect("serialize thread goal delivery request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["agentType"], "Standard");
        assert_eq!(json["workspacePath"], "/workspace/project");
        assert_eq!(json["remoteConnectionId"], "conn-1");
        assert_eq!(json["remoteSshHost"], "host-1");
        assert_eq!(json["kind"], "objective_updated");
        assert_eq!(json["goal"]["goalId"], "goal_1");
    }

    #[test]
    fn agent_thread_goal_management_requests_serialize_stable_shape() {
        let get_request = AgentThreadGoalGetRequest {
            session_id: "session_1".to_string(),
            workspace_path: "/workspace/project".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let create_request = AgentThreadGoalCreateRequest {
            session_id: "session_1".to_string(),
            workspace_path: "/workspace/project".to_string(),
            objective: "Ship the refactor".to_string(),
            token_budget: Some(1000),
        };
        let update_request = AgentThreadGoalUpdateStatusRequest {
            session_id: "session_1".to_string(),
            workspace_path: "/workspace/project".to_string(),
            status: ThreadGoalStatus::Complete,
            turn_id: Some("turn_1".to_string()),
        };

        let get_json = serde_json::to_value(get_request).expect("serialize get request");
        let create_json = serde_json::to_value(create_request).expect("serialize create request");
        let update_json = serde_json::to_value(update_request).expect("serialize update request");

        assert_eq!(get_json["sessionId"], "session_1");
        assert_eq!(get_json["workspacePath"], "/workspace/project");
        assert_eq!(get_json["remoteConnectionId"], "conn-1");
        assert_eq!(get_json["remoteSshHost"], "host-1");
        assert_eq!(create_json["objective"], "Ship the refactor");
        assert_eq!(create_json["tokenBudget"], 1000);
        assert_eq!(update_json["status"], "complete");
        assert_eq!(update_json["turnId"], "turn_1");
    }

    #[test]
    fn agent_turn_cancellation_request_serializes_current_contract() {
        let request = AgentTurnCancellationRequest {
            session_id: "session_1".to_string(),
            turn_id: Some("turn_1".to_string()),
            source: Some(AgentSubmissionSource::Bot),
            requester_session_id: Some("requester_session".to_string()),
            reason: Some("user_cancelled".to_string()),
            wait_timeout_ms: Some(1500),
            cancel_descendants: false,
        };

        let json = serde_json::to_value(request).expect("serialize cancel request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["turnId"], "turn_1");
        assert_eq!(json["source"], "bot");
        assert_eq!(json["requesterSessionId"], "requester_session");
        assert_eq!(json["reason"], "user_cancelled");
        assert_eq!(json["waitTimeoutMs"], 1500);
        assert_eq!(json["cancelDescendants"], false);

        let legacy = serde_json::from_value::<AgentTurnCancellationRequest>(serde_json::json!({
            "sessionId": "session_1"
        }))
        .expect("deserialize legacy cancel request");
        assert!(legacy.cancel_descendants);
    }

    #[test]
    fn interrupted_turn_requests_are_typed_and_generation_scoped() {
        let interrupt = AgentTurnInterruptionRequest {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            source: Some(AgentSubmissionSource::DesktopUi),
            wait_timeout_ms: Some(30_000),
        };
        let recover = AgentDialogTurnRecoveryRequest {
            session_id: "session_1".to_string(),
            turn_id: "turn_1".to_string(),
            execution_generation: 1,
            workspace_path: Some("/workspace/project".to_string()),
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        let interrupt_json = serde_json::to_value(interrupt).expect("serialize interruption");
        let recover_json = serde_json::to_value(recover).expect("serialize recovery");

        assert_eq!(interrupt_json["turnId"], "turn_1");
        assert_eq!(interrupt_json["source"], "desktop_ui");
        assert_eq!(recover_json["executionGeneration"], 1);
        assert_eq!(recover_json["workspacePath"], "/workspace/project");
    }

    #[test]
    fn session_lineage_contracts_serialize_provider_neutral_facts() {
        let request = AgentSessionLineageRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            anchor_session_id: "child_1".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let snapshot = AgentSessionLineageSnapshot {
            root_session_id: "root_1".to_string(),
            sessions: vec![AgentSessionLineageEntry {
                session_id: "child_1".to_string(),
                session_name: "Research".to_string(),
                agent_type: "explore".to_string(),
                created_at_ms: 1_000,
                status: AgentSessionLifecycleStatus::Completed,
                active_turn_id: None,
                parent_session_id: Some("root_1".to_string()),
                parent_tool_call_id: Some("tool_1".to_string()),
                subagent_type: Some("explore".to_string()),
                agent_id: Some("parser-review".to_string()),
                workspace_path: Some("/workspace/project".to_string()),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("host-1".to_string()),
                unread_completion: Some("interrupted".to_string()),
                needs_user_attention: None,
            }],
        };
        let transcript_request = AgentSessionLineageTranscriptRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            root_session_id: "root_1".to_string(),
            session_id: "child_1".to_string(),
            required_settled_turn_ids: vec!["turn-terminal".to_string()],
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let cancellation_request = AgentSessionLineageCancellationRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            root_session_id: "root_1".to_string(),
            session_id: "child_1".to_string(),
            expected_active_turn_id: Some("turn-live".to_string()),
            source: Some(AgentSubmissionSource::Cli),
            reason: Some("user_cancelled".to_string()),
            wait_timeout_ms: Some(5_000),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let inspection = AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: "child_1".to_string(),
                messages: Vec::new(),
            },
            active_turn_id: Some("turn-live".to_string()),
        };

        let request_json = serde_json::to_value(request).expect("serialize lineage request");
        let snapshot_json = serde_json::to_value(snapshot).expect("serialize lineage snapshot");
        let transcript_json =
            serde_json::to_value(transcript_request).expect("serialize transcript request");
        let cancellation_json =
            serde_json::to_value(cancellation_request).expect("serialize cancellation request");
        let inspection_json =
            serde_json::to_value(inspection).expect("serialize lineage inspection");

        assert_eq!(request_json["anchorSessionId"], "child_1");
        assert_eq!(request_json["remoteConnectionId"], "conn-1");
        assert_eq!(snapshot_json["rootSessionId"], "root_1");
        assert_eq!(snapshot_json["sessions"][0]["status"], "completed");
        assert_eq!(snapshot_json["sessions"][0]["parentSessionId"], "root_1");
        assert_eq!(snapshot_json["sessions"][0]["agentId"], "parser-review");

        let legacy_entry = serde_json::from_value::<AgentSessionLineageEntry>(serde_json::json!({
            "sessionId": "legacy-child",
            "sessionName": "Legacy child",
            "agentType": "explore",
            "createdAtMs": 1,
            "status": "completed"
        }))
        .expect("legacy lineage entries without agentId remain readable");
        assert!(legacy_entry.agent_id.is_none());
        assert_eq!(
            snapshot_json["sessions"][0]["unreadCompletion"],
            "interrupted"
        );
        assert_eq!(transcript_json["sessionId"], "child_1");
        assert_eq!(transcript_json["rootSessionId"], "root_1");
        assert_eq!(
            transcript_json["requiredSettledTurnIds"],
            serde_json::json!(["turn-terminal"])
        );
        let legacy_transcript =
            serde_json::from_value::<AgentSessionLineageTranscriptRequest>(serde_json::json!({
                "workspacePath": "/workspace/project",
                "rootSessionId": "root_1",
                "sessionId": "child_1"
            }))
            .expect("deserialize precondition-free lineage transcript request");
        assert!(legacy_transcript.required_settled_turn_ids.is_empty());
        assert_eq!(cancellation_json["source"], "cli");
        assert_eq!(cancellation_json["waitTimeoutMs"], 5_000);
        assert_eq!(cancellation_json["expectedActiveTurnId"], "turn-live");
        let legacy_cancellation =
            serde_json::from_value::<AgentSessionLineageCancellationRequest>(serde_json::json!({
                "workspacePath": "/workspace/project",
                "rootSessionId": "root_1",
                "sessionId": "child_1"
            }))
            .expect("deserialize pre-exact-target lineage cancellation request");
        assert!(legacy_cancellation.expected_active_turn_id.is_none());
        assert_eq!(inspection_json["transcript"]["sessionId"], "child_1");
        assert_eq!(inspection_json["activeTurnId"], "turn-live");
    }

    #[test]
    fn session_list_accepts_legacy_payload_and_emits_id_only_requests() {
        let legacy: AgentSessionListRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "/project", "remoteConnectionId": "connection-1"
        }))
        .unwrap();
        assert!(legacy.workspace_id.is_none());
        assert_eq!(legacy.workspace_path, "/project");
        assert_eq!(
            serde_json::from_value::<AgentSessionListRequest>(
                serde_json::to_value(&legacy).unwrap()
            )
            .unwrap(),
            legacy
        );
        let current: AgentSessionListRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "workspace-1"
        }))
        .unwrap();
        assert!(current.workspace_path.is_empty());
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::json!({"workspaceId": "workspace-1"})
        );
    }

    #[test]
    fn agent_session_management_contracts_serialize_stable_shape() {
        let list_request = AgentSessionListRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let summary = AgentSessionSummary {
            session_id: "session_1".to_string(),
            session_name: "Main".to_string(),
            agent_type: "Standard".to_string(),
            model_id: Some("provider/model".to_string()),
            reasoning_preset: Some("high".to_string()),
            last_user_dialog_agent_type: Some("plan".to_string()),
            last_submitted_agent_type: Some("Standard".to_string()),
            turn_count: 3,
            created_at_ms: 1000,
            last_active_at_ms: 2000,
        };
        let delete_request = AgentSessionDeleteRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let rename_request = AgentSessionRenameRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            session_name: "Renamed".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let archive_request = AgentSessionArchiveRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let archive_state_request = AgentSessionArchiveStateRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "session_1".to_string(),
            archived: false,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let fork_request = AgentSessionForkRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            source_session_id: "session_1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let fork_at_turn_request = AgentSessionForkAtTurnRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            source_session_id: "session_1".to_string(),
            source_turn_id: "turn_2".to_string(),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let fork_before_turn_request = AgentSessionForkBeforeTurnRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            source_session_id: "session_1".to_string(),
            source_turn_id: "turn_2".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let model_request = AgentSessionModelUpdateRequest {
            session_id: "session_1".to_string(),
            model_id: "provider/model".to_string(),
        };
        let mode_request = AgentSessionModeUpdateRequest {
            agent_route_key: None,
            session_id: "session_1".to_string(),
            mode_id: "Standard".to_string(),
        };
        let workspace_request = AgentSessionWorkspaceRequest {
            session_id: "session_1".to_string(),
        };
        let workspace_binding = AgentSessionWorkspaceBinding {
            workspace_kind: None,
            project_workspace_id: None,
            workspace_id: Some("workspace_1".to_string()),
            workspace_path: "/workspace/project".to_string(),
            project_workspace_path: None,
            execution_target: None,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };

        let list_json = serde_json::to_value(list_request).expect("serialize list request");
        let summary_json = serde_json::to_value(summary).expect("serialize summary");
        let delete_json = serde_json::to_value(delete_request).expect("serialize delete request");
        let rename_json = serde_json::to_value(rename_request).expect("serialize rename request");
        let archive_json =
            serde_json::to_value(archive_request).expect("serialize archive request");
        let archive_state_json =
            serde_json::to_value(archive_state_request).expect("serialize archive-state request");
        let fork_json = serde_json::to_value(fork_request).expect("serialize fork request");
        let fork_at_turn_json =
            serde_json::to_value(fork_at_turn_request).expect("serialize exact-turn fork request");
        let fork_before_turn_json = serde_json::to_value(fork_before_turn_request)
            .expect("serialize before-turn fork request");
        let model_json = serde_json::to_value(model_request).expect("serialize model request");
        let mode_json = serde_json::to_value(mode_request).expect("serialize mode request");
        let workspace_json =
            serde_json::to_value(workspace_request).expect("serialize workspace request");
        let binding_json =
            serde_json::to_value(workspace_binding).expect("serialize workspace binding");

        assert_eq!(list_json["workspacePath"], "/workspace/project");
        assert_eq!(list_json["remoteConnectionId"], "conn-1");
        assert_eq!(summary_json["modelId"], "provider/model");
        assert_eq!(summary_json["lastUserDialogAgentType"], "plan");
        assert_eq!(summary_json["lastSubmittedAgentType"], "Standard");
        assert_eq!(list_json["remoteSshHost"], "host-1");
        assert_eq!(summary_json["sessionId"], "session_1");
        assert_eq!(summary_json["turnCount"], 3);
        assert_eq!(summary_json["createdAtMs"], 1000);
        assert_eq!(summary_json["lastActiveAtMs"], 2000);
        assert_eq!(delete_json["sessionId"], "session_1");
        assert_eq!(delete_json["remoteConnectionId"], "conn-1");
        assert_eq!(delete_json["remoteSshHost"], "host-1");
        assert_eq!(rename_json["sessionName"], "Renamed");
        assert_eq!(rename_json["remoteConnectionId"], "conn-1");
        assert_eq!(archive_json["sessionId"], "session_1");
        assert_eq!(archive_json["remoteSshHost"], "host-1");
        assert_eq!(archive_state_json["archived"], false);
        assert!(fork_json.get("sourceTurnId").is_none());
        assert_eq!(fork_at_turn_json["sourceTurnId"], "turn_2");
        assert_eq!(fork_before_turn_json["sourceTurnId"], "turn_2");
        assert_eq!(fork_before_turn_json["sourceSessionId"], "session_1");
        assert_eq!(model_json["sessionId"], "session_1");
        assert_eq!(model_json["modelId"], "provider/model");
        assert_eq!(mode_json["sessionId"], "session_1");
        assert_eq!(mode_json["modeId"], "Standard");
        assert_eq!(workspace_json["sessionId"], "session_1");
        assert_eq!(binding_json["workspaceId"], "workspace_1");
        assert_eq!(binding_json["workspacePath"], "/workspace/project");
        assert_eq!(binding_json["remoteConnectionId"], "conn-1");
        assert_eq!(binding_json["remoteSshHost"], "host-1");
    }

    #[test]
    fn local_command_turn_contract_has_fixed_narrow_shape() {
        let mut metadata = serde_json::Map::new();
        metadata.insert("kind".to_string(), serde_json::json!("usage_report"));
        let request = AgentLocalCommandTurnRecordRequest {
            session_id: "session_1".to_string(),
            content: "Usage report".to_string(),
            turn_id: Some("turn_1".to_string()),
            timestamp_ms: Some(1000),
            metadata,
        };

        let json = serde_json::to_value(request).expect("serialize local command turn");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["content"], "Usage report");
        assert_eq!(json["turnId"], "turn_1");
        assert_eq!(json["timestampMs"], 1000);
        assert_eq!(json["metadata"]["kind"], "usage_report");
        assert!(json.get("turnKind").is_none());
        assert!(json.get("modelVisible").is_none());
    }

    #[test]
    fn local_command_turn_result_serializes_authoritative_identity() {
        let result = AgentLocalCommandTurnRecordResult {
            turn_id: "turn_8".to_string(),
            storage_turn_index: 7,
        };

        let json = serde_json::to_value(result).expect("serialize local command turn result");

        assert_eq!(json["turnId"], "turn_8");
        assert_eq!(json["storageTurnIndex"], 7);
        assert_eq!(json.as_object().map(|value| value.len()), Some(2));
    }

    #[test]
    fn remote_control_state_snapshot_serializes_active_turn_contract() {
        let snapshot = RemoteControlStateSnapshot {
            session_id: "session_1".to_string(),
            state: RemoteControlSessionState::Processing,
            active_turn_id: Some("turn_1".to_string()),
            queue_depth: 2,
            metadata: serde_json::Map::new(),
        };

        let json = serde_json::to_value(snapshot).expect("serialize state snapshot");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["state"], "processing");
        assert_eq!(json["activeTurnId"], "turn_1");
        assert_eq!(json["queueDepth"], 2);
    }

    #[test]
    fn session_transcript_request_serializes_turn_id_contract() {
        let request = SessionTranscriptRequest {
            session_id: "session_1".to_string(),
            turn_id: Some("turn_1".to_string()),
        };

        let json = serde_json::to_value(request).expect("serialize transcript request");

        assert_eq!(json["sessionId"], "session_1");
        assert_eq!(json["turnId"], "turn_1");
        assert!(json.get("fromTurnId").is_none());
    }

    #[test]
    fn transcript_contract_keeps_portable_message_identity_and_content() {
        let message = TranscriptMessage {
            id: Some("message_1".to_string()),
            role: "assistant".to_string(),
            turn_id: Some("turn_1".to_string()),
            timestamp_ms: Some(3000),
            content: TranscriptContent::Text("done".to_string()),
        };

        let message_json = serde_json::to_value(message).expect("serialize transcript message");

        assert_eq!(message_json["id"], "message_1");
        assert_eq!(message_json["timestampMs"], 3000);
        assert_eq!(message_json["content"]["Text"], "done");
    }
}
