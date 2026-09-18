//! Types for session persistence

use openbitfun_core_types::ToolImageAttachment;
use openbitfun_core_types::{
    AiErrorDetail, SessionContinuationPolicy, SessionExecutionTarget, SessionKind,
};
use openbitfun_events::ModelRoundAttemptDiagnostic;
use serde::{Deserialize, Serialize};

pub const SESSION_STORAGE_SCHEMA_VERSION: u32 = 2;
pub const SESSION_TURN_CATALOG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionRelationshipKind {
    Btw,
    Review,
    DeepReview,
    Miniapp,
    Subagent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionRelationship {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SessionRelationshipKind>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "parent_session_id"
    )]
    pub parent_session_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "parent_request_id"
    )]
    pub parent_request_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "parent_dialog_turn_id"
    )]
    pub parent_dialog_turn_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "parent_turn_index"
    )]
    pub parent_turn_index: Option<usize>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "parent_tool_call_id"
    )]
    pub parent_tool_call_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "subagent_type"
    )]
    pub subagent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_policy: Option<SessionContinuationPolicy>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionMemoryMode {
    #[default]
    Enabled,
    Disabled,
    Polluted,
}

impl SessionMemoryMode {
    pub fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled)
    }
}

/// Session metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    /// Session ID
    #[serde(alias = "session_id")]
    pub session_id: String,

    /// Session name (user-editable)
    #[serde(alias = "session_name")]
    pub session_name: String,

    /// Agent type
    #[serde(
        alias = "agent_type",
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_agent_id"
    )]
    pub agent_type: String,
    /// Mode of the last surviving user dialog turn in the persisted history.
    ///
    /// This follows rollback and turn-truncation semantics and is used for
    /// first-entry vs ongoing mode reminders.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_user_dialog_agent_type"
    )]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_user_dialog_agent_type: Option<String>,
    /// Mode of the most recent user submission accepted by the scheduler.
    ///
    /// This is a session-level prompt-cache guard signal and intentionally does
    /// not rewind when history is rolled back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_submitted_agent_type"
    )]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_submitted_agent_type: Option<String>,

    /// Creator identity for future permission checks
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "created_by")]
    pub created_by: Option<String>,
    #[serde(default, alias = "session_kind", alias = "sessionKind")]
    pub session_kind: SessionKind,

    /// Whether this session is eligible for memory generation.
    #[serde(default, alias = "memory_mode", alias = "memoryMode")]
    pub memory_mode: SessionMemoryMode,

    /// Model name
    #[serde(alias = "model_name")]
    pub model_name: String,

    /// Created time (Unix timestamp ms)
    #[serde(alias = "created_at")]
    pub created_at: u64,

    /// Last active time (Unix timestamp ms)
    #[serde(alias = "last_active_at")]
    pub last_active_at: u64,

    /// Last dialog completion time (Unix timestamp ms)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_finished_at",
        alias = "lastFinishedAt"
    )]
    pub last_finished_at: Option<u64>,

    /// Compact latest user-Turn fact, maintained with the metadata index. Lists
    /// must not load transcript files to discover the latest outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<SessionLastTurn>,

    /// Turn count
    #[serde(alias = "turn_count")]
    pub turn_count: usize,

    /// Total message count (user + AI)
    #[serde(alias = "message_count")]
    pub message_count: usize,

    /// Total tool call count
    #[serde(alias = "tool_call_count")]
    pub tool_call_count: usize,

    /// Session status
    pub status: SessionStatus,

    /// Terminal session ID (if any)
    #[serde(skip_serializing_if = "Option::is_none", alias = "terminal_session_id")]
    pub terminal_session_id: Option<String>,

    /// Snapshot session ID (if any)
    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "sandbox_session_id",
        alias = "sandboxSessionId"
    )]
    pub snapshot_session_id: Option<String>,

    /// Tags (for categorization and search)
    #[serde(default)]
    pub tags: Vec<String>,

    /// Custom metadata
    #[serde(skip_serializing_if = "Option::is_none", alias = "custom_metadata")]
    pub custom_metadata: Option<serde_json::Value>,

    /// Latest authoritative context-usage value for restoring context display
    /// state across hosts and process restarts.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "current_context_usage"
    )]
    pub current_context_usage: Option<SessionContextUsage>,

    /// Structured child-session relationship metadata.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "relationship",
        alias = "session_relationship",
        alias = "sessionRelationship"
    )]
    pub relationship: Option<SessionRelationship>,

    /// Todo list (for persisting the session's todo state)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos: Option<serde_json::Value>,

    /// Persisted Review action-bar state, including follow-up linkage and scope.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "review_action_state",
        alias = "reviewActionState"
    )]
    pub review_action_state: Option<serde_json::Value>,

    /// Deep Review run manifest for this session, when the session was launched
    /// from Code Review Team.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "deep_review_run_manifest",
        alias = "deepReviewRunManifest"
    )]
    pub deep_review_run_manifest: Option<serde_json::Value>,

    /// Narrow target evidence for a standard Review session.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "review_target_evidence",
        alias = "reviewTargetEvidence"
    )]
    pub review_target_evidence: Option<serde_json::Value>,

    /// Cached reviewer outputs from previous deep review runs in this session.
    /// Keyed by packet_id, value is the reviewer's output text.
    /// Used for incremental review: when the fingerprint matches, skip re-dispatching.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "deep_review_cache",
        alias = "deepReviewCache"
    )]
    pub deep_review_cache: Option<serde_json::Value>,

    /// Workspace path this session belongs to (normalized source workspace root, not mirror dir)
    #[serde(skip_serializing_if = "Option::is_none", alias = "workspace_path")]
    pub workspace_path: Option<String>,

    /// Main project path that owns this session's persisted data. Legacy
    /// sessions omit it and use `workspace_path`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "project_workspace_path"
    )]
    pub project_workspace_path: Option<String>,

    /// Concrete execution target, including managed worktree identity.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "execution_target"
    )]
    pub execution_target: Option<SessionExecutionTarget>,

    /// Unified hostname for workspace identity: `localhost` for local workspaces,
    /// SSH host for remote workspaces.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "workspace_hostname"
    )]
    pub workspace_hostname: Option<String>,

    /// Owning-host workspace ID. Paths above are location projections only.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "workspace_id"
    )]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,

    /// Unread completion status for the session.
    /// 'completed' → green dot, 'error' → red dot.
    /// Cleared after the user switches to the session and the content renders.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "unread_completion",
        alias = "unreadCompletion"
    )]
    pub unread_completion: Option<String>,

    /// High-priority attention status for the session.
    /// Set when the session requires user action while not the active session.
    /// 'ask_user' → pending AskUserQuestion waiting for answer.
    /// 'tool_confirm' → pending tool confirmations.
    /// Takes precedence over unread_completion in the UI.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "needs_user_attention",
        alias = "needsUserAttention"
    )]
    pub needs_user_attention: Option<String>,
}

/// Session status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Archived,
    Completed,
}

/// Session list (metadata for all sessions)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<SessionMetadata>,
    #[serde(alias = "last_updated")]
    pub last_updated: u64,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSessionMetadataFile {
    pub schema_version: u32,
    #[serde(flatten)]
    pub metadata: SessionMetadata,
}

impl StoredSessionMetadataFile {
    pub fn new(metadata: SessionMetadata) -> Self {
        Self {
            schema_version: SESSION_STORAGE_SCHEMA_VERSION,
            metadata,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDialogTurnFile {
    pub schema_version: u32,
    #[serde(flatten)]
    pub turn: DialogTurnData,
}

impl StoredDialogTurnFile {
    pub fn new(turn: DialogTurnData) -> Self {
        Self {
            schema_version: SESSION_STORAGE_SCHEMA_VERSION,
            turn,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSessionIndexFile {
    pub schema_version: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub metadata_file_count: usize,
    pub sessions: Vec<SessionMetadata>,
}

impl StoredSessionIndexFile {
    pub fn new(updated_at: u64, sessions: Vec<SessionMetadata>) -> Self {
        let metadata_file_count = sessions.len();
        Self::with_metadata_file_count(updated_at, sessions, metadata_file_count)
    }

    pub fn with_metadata_file_count(
        updated_at: u64,
        sessions: Vec<SessionMetadata>,
        metadata_file_count: usize,
    ) -> Self {
        Self {
            schema_version: SESSION_STORAGE_SCHEMA_VERSION,
            updated_at,
            metadata_file_count,
            sessions,
        }
    }
}

impl Default for SessionList {
    fn default() -> Self {
        Self {
            sessions: Vec::new(),
            last_updated: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            version: "1.0".to_string(),
        }
    }
}

/// Lightweight, rebuildable navigation metadata for one persisted dialog turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnCatalogEntry {
    /// Zero-based position in the current catalog projection.
    pub ordinal: usize,
    /// Absolute persisted Turn index used by the storage layout.
    pub storage_turn_index: usize,
    /// Missing only while a legacy catalog is being reconstructed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Bounded, user-readable input preview. Never contains model or tool output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub preview_truncated: bool,
    /// Small, read-only projection used to render Turn Rail tooltips without
    /// copying executable context payloads into the navigation catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capsule_preview: Option<TurnRailCapsulePreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnRailCapsulePreview {
    pub segments: Vec<TurnRailCapsuleSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnRailCapsuleSegment {
    Text {
        text: String,
    },
    Context {
        #[serde(rename = "contextType")]
        context_type: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    InlineToken {
        #[serde(rename = "tokenType")]
        token_type: String,
        label: String,
    },
}

/// Lightweight navigation catalog for a persisted Session.
///
/// This is a derived cache. Persisted Turn files and the staged-revert boundary
/// remain authoritative and may be used to rebuild this value at any time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnCatalog {
    pub schema_version: u32,
    pub session_id: String,
    /// Changes only when the visible storage sequence changes. Repairing
    /// optional Turn ids or previews does not invalidate an in-flight window.
    pub revision: String,
    pub total_turn_count: usize,
    pub complete: bool,
    pub entries: Vec<SessionTurnCatalogEntry>,
}

/// Result of loading one bounded, contiguous window around a persisted Turn.
///
/// Catalog changes caused by live appends, revert operations, or external
/// writers are ordinary synchronization outcomes rather than transport errors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionTurnWindowResponse {
    Ready {
        catalog_revision: String,
        total_turn_count: usize,
        start_ordinal: usize,
        end_ordinal_exclusive: usize,
        target_turn_id: String,
        turns: Vec<DialogTurnData>,
    },
    Stale {
        catalog: SessionTurnCatalog,
    },
    NotFound {
        catalog: SessionTurnCatalog,
    },
}

impl SessionTurnWindowResponse {
    pub fn ready_turns_mut(&mut self) -> Option<&mut Vec<DialogTurnData>> {
        match self {
            Self::Ready { turns, .. } => Some(turns),
            Self::Stale { .. } | Self::NotFound { .. } => None,
        }
    }
}

/// Full dialog turn data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogTurnData {
    /// Turn ID
    #[serde(alias = "turn_id")]
    pub turn_id: String,

    /// Turn index (starting from 0)
    #[serde(alias = "turn_index")]
    pub turn_index: usize,

    /// Session ID
    #[serde(alias = "session_id")]
    pub session_id: String,

    /// Timestamp
    pub timestamp: u64,

    /// Turn kind
    #[serde(default, alias = "turn_kind")]
    pub kind: DialogTurnKind,

    /// Agent type used for this turn when it represents a user dialog.
    /// Maintenance/local utility turns leave this empty so they do not affect
    /// mode-transition reminder semantics.
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "agent_type")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub agent_type: Option<String>,

    /// User message
    #[serde(alias = "user_message")]
    pub user_message: UserMessageData,

    /// Model interaction rounds
    #[serde(alias = "model_rounds")]
    pub model_rounds: Vec<ModelRoundData>,

    /// Turn start time
    #[serde(alias = "start_time")]
    pub start_time: u64,

    /// Turn end time
    #[serde(skip_serializing_if = "Option::is_none", alias = "end_time")]
    pub end_time: Option<u64>,

    /// Turn duration (milliseconds)
    #[serde(skip_serializing_if = "Option::is_none", alias = "duration_ms")]
    pub duration_ms: Option<u64>,

    /// Provider-reported token usage for this dialog turn, when available.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "token_usage"
    )]
    pub token_usage: Option<DialogTurnTokenUsageData>,

    /// Detailed finish reason recorded when the turn ended.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "finish_reason"
    )]
    pub finish_reason: Option<String>,

    /// Whether the turn produced a final assistant response visible to the user.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "has_final_response"
    )]
    pub has_final_response: Option<bool>,

    /// Terminal error message when the turn failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// Structured provider diagnostics for a failed turn.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "error_detail"
    )]
    pub error_detail: Option<AiErrorDetail>,

    /// Additive recovery lifecycle for an intentionally interrupted user turn.
    ///
    /// `TurnStatus` remains backward-compatible (`cancelled` while interrupted)
    /// so older builds can still load the turn and simply treat it as terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<DialogTurnRecoveryData>,

    /// Monotonic tombstone proving that the Runtime has owned persistence for
    /// this turn. It remains after recovery settles so a delayed whole-turn UI
    /// projection from an older execution generation cannot overwrite the
    /// authoritative terminal payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_epoch: Option<u32>,

    /// Turn status
    pub status: TurnStatus,
}

/// Provider-reported token usage attached to a dialog turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DialogTurnTokenUsageData {
    /// Input/prompt tokens for the model request.
    #[serde(alias = "input_tokens")]
    pub input_tokens: u64,

    /// Output/completion tokens, when the provider reports them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "output_tokens"
    )]
    pub output_tokens: Option<u64>,

    /// Total tokens reported by the provider for this request.
    #[serde(alias = "total_tokens")]
    pub total_tokens: u64,

    /// Frontend event timestamp in milliseconds since epoch.
    pub timestamp: u64,
}

/// Source of a persisted session context-usage value.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionContextUsageSource {
    ModelRequest,
    ContextCompression,
}

/// Exact context-usage value owned by the Agent Session runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextUsage {
    /// Dialog turn that produced this value.
    #[serde(alias = "turn_id")]
    pub turn_id: String,

    /// Input/prompt tokens for a model request, or the compacted context size.
    #[serde(alias = "input_tokens")]
    pub input_tokens: u64,

    /// Output/completion tokens when this value came from a model request.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "output_tokens"
    )]
    pub output_tokens: Option<u64>,

    /// Provider total for a model request, or the compacted context size.
    #[serde(alias = "total_tokens")]
    pub total_tokens: u64,

    /// Runtime event timestamp in milliseconds since epoch.
    pub timestamp: u64,

    pub source: SessionContextUsageSource,
}

/// Persisted dialog turn kind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum DialogTurnKind {
    #[default]
    UserDialog,
    ManualCompaction,
    LocalCommand,
}

impl DialogTurnKind {
    pub fn is_model_visible(self) -> bool {
        matches!(self, Self::UserDialog)
    }

    pub fn is_transcript_visible(self) -> bool {
        matches!(self, Self::UserDialog | Self::ManualCompaction)
    }
}

/// User message data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageData {
    pub id: String,
    pub content: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Model interaction round data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundData {
    pub id: String,
    #[serde(alias = "turn_id")]
    pub turn_id: String,
    #[serde(alias = "round_index")]
    pub round_index: usize,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "round_group_id"
    )]
    pub round_group_id: Option<String>,
    pub timestamp: u64,

    /// Text item entries
    #[serde(default, alias = "text_items")]
    pub text_items: Vec<TextItemData>,

    /// Tool call entries
    #[serde(default, alias = "tool_items")]
    pub tool_items: Vec<ToolItemData>,

    /// Thinking item entries
    #[serde(default, alias = "thinking_items")]
    pub thinking_items: Vec<ThinkingItemData>,

    #[serde(alias = "start_time")]
    pub start_time: u64,
    #[serde(skip_serializing_if = "Option::is_none", alias = "end_time")]
    pub end_time: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "duration_ms"
    )]
    pub duration_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "provider_id"
    )]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_config_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_model_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "first_chunk_ms"
    )]
    pub first_chunk_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "first_visible_output_ms"
    )]
    pub first_visible_output_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "stream_duration_ms"
    )]
    pub stream_duration_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "attempt_count"
    )]
    pub attempt_count: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        alias = "attempt_diagnostics"
    )]
    pub attempt_diagnostics: Vec<ModelRoundAttemptDiagnostic>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "failure_category"
    )]
    pub failure_category: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "token_details"
    )]
    pub token_details: Option<serde_json::Value>,
    pub status: String,
}

/// Text item data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextItemData {
    pub id: String,
    pub content: String,
    #[serde(alias = "is_streaming")]
    pub is_streaming: bool,
    pub timestamp: u64,
    /// Whether Markdown format (default `true`)
    #[serde(default = "default_is_markdown", alias = "is_markdown")]
    pub is_markdown: bool,

    /// Original order index (to restore the correct insertion order)
    #[serde(skip_serializing_if = "Option::is_none", alias = "order_index")]
    pub order_index: Option<usize>,

    /// Subagent marker field
    #[serde(skip_serializing_if = "Option::is_none", alias = "is_subagent_item")]
    pub is_subagent_item: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "parent_task_tool_id")]
    pub parent_task_tool_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "subagent_session_id")]
    pub subagent_session_id: Option<String>,

    /// Status field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "attempt_id")]
    pub attempt_id: Option<String>,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "attempt_index"
    )]
    pub attempt_index: Option<u32>,
}

fn default_is_markdown() -> bool {
    true
}

/// Thinking item data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingItemData {
    pub id: String,
    pub content: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "reasoning_kind"
    )]
    pub reasoning_kind: Option<openbitfun_core_types::ReasoningContentKind>,
    #[serde(alias = "is_streaming")]
    pub is_streaming: bool,
    #[serde(alias = "is_collapsed")]
    pub is_collapsed: bool,
    pub timestamp: u64,

    /// Original order index (to restore the correct insertion order)
    #[serde(skip_serializing_if = "Option::is_none", alias = "order_index")]
    pub order_index: Option<usize>,

    /// Status field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,

    /// Subagent marker field (fixes incorrect placement of subagent thinking content after restart)
    #[serde(skip_serializing_if = "Option::is_none", alias = "is_subagent_item")]
    pub is_subagent_item: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "parent_task_tool_id")]
    pub parent_task_tool_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "subagent_session_id")]
    pub subagent_session_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "attempt_id")]
    pub attempt_id: Option<String>,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "attempt_index"
    )]
    pub attempt_index: Option<u32>,
}

/// Tool item data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolItemData {
    pub id: String,
    #[serde(alias = "tool_name")]
    pub tool_name: String,
    #[serde(alias = "tool_call")]
    pub tool_call: ToolCallData,
    #[serde(skip_serializing_if = "Option::is_none", alias = "tool_result")]
    pub tool_result: Option<ToolResultData>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "ai_intent")]
    pub ai_intent: Option<String>,
    #[serde(alias = "start_time")]
    pub start_time: u64,
    #[serde(skip_serializing_if = "Option::is_none", alias = "end_time")]
    pub end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "duration_ms")]
    pub duration_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "queue_wait_ms"
    )]
    pub queue_wait_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "preflight_ms"
    )]
    pub preflight_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "confirmation_wait_ms"
    )]
    pub confirmation_wait_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "execution_ms"
    )]
    pub execution_ms: Option<u64>,

    /// Original order index (to restore the correct insertion order)
    #[serde(skip_serializing_if = "Option::is_none", alias = "order_index")]
    pub order_index: Option<usize>,

    /// Subagent marker field
    #[serde(skip_serializing_if = "Option::is_none", alias = "is_subagent_item")]
    pub is_subagent_item: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "parent_task_tool_id")]
    pub parent_task_tool_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "subagent_session_id")]
    pub subagent_session_id: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "subagent_dialog_turn_id"
    )]
    pub subagent_dialog_turn_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "attempt_id")]
    pub attempt_id: Option<String>,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "attempt_index"
    )]
    pub attempt_index: Option<u32>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "subagent_model_id")]
    pub subagent_model_id: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "subagent_model_display_name"
    )]
    pub subagent_model_display_name: Option<String>,

    /// Status field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", alias = "interruption_reason")]
    pub interruption_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallData {
    pub input: serde_json::Value,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultData {
    pub result: serde_json::Value,
    pub success: bool,
    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "result_for_assistant"
    )]
    pub result_for_assistant: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "image_attachments"
    )]
    pub image_attachments: Option<Vec<ToolImageAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "duration_ms")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLineRange {
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptIndexEntry {
    #[serde(alias = "turn_index")]
    pub turn_index: usize,
    pub preview: String,
    #[serde(alias = "turn_range")]
    pub turn_range: TranscriptLineRange,
    #[serde(alias = "user_range")]
    pub user_range: TranscriptLineRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct SessionTranscriptExportOptions {
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub tool_inputs: bool,
    #[serde(default)]
    pub thinking: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptExport {
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(alias = "transcript_path")]
    pub transcript_path: String,
    #[serde(alias = "generated_at")]
    pub generated_at: u64,
    #[serde(alias = "source_fingerprint")]
    pub source_fingerprint: String,
    #[serde(alias = "includes_tools")]
    pub includes_tools: bool,
    #[serde(default, alias = "includes_tool_inputs")]
    pub includes_tool_inputs: bool,
    #[serde(alias = "includes_thinking")]
    pub includes_thinking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<String>>,
    #[serde(alias = "turn_count")]
    pub turn_count: usize,
    #[serde(alias = "line_count")]
    pub line_count: usize,
    #[serde(default = "default_transcript_line_range", alias = "index_range")]
    pub index_range: TranscriptLineRange,
    pub index: Vec<SessionTranscriptIndexEntry>,
}

fn default_transcript_line_range() -> TranscriptLineRange {
    TranscriptLineRange {
        start_line: 0,
        end_line: 0,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DialogTurnRecoveryStatus {
    Interrupted,
    Recovering,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DialogTurnRecoveryData {
    pub status: DialogTurnRecoveryStatus,
    /// Generation zero is the original execution; each recovery increments it.
    pub execution_generation: u32,
    #[serde(default)]
    pub resume_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_at: Option<u64>,
    /// Model binding captured at interruption. Recovery rejects a model switch
    /// instead of silently continuing one turn under a different model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

/// Turn status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnStatus {
    InProgress,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLastTurn {
    pub turn_id: String,
    pub turn_index: usize,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_generation: Option<u32>,
    /// A persisted interrupted recovery checkpoint, distinct from cancellation.
    /// None identifies older summaries that have not captured this fact yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_pending: Option<bool>,
}

impl SessionMetadata {
    pub fn needs_last_turn_backfill(&self) -> bool {
        self.turn_count > 0
            && self.last_turn.as_ref().is_none_or(|last| {
                last.status == TurnStatus::Cancelled && last.recovery_pending.is_none()
            })
    }

    /// Creates a new session metadata.
    pub fn new(
        session_id: String,
        session_name: String,
        agent_type: String,
        model_name: String,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            session_id,
            session_name,
            agent_type: openbitfun_core_types::agent_identity::canonical_agent_id(&agent_type)
                .to_owned(),
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            created_by: None,
            session_kind: SessionKind::Standard,
            memory_mode: SessionMemoryMode::Enabled,
            model_name,
            created_at: now,
            last_active_at: now,
            last_finished_at: None,
            turn_count: 0,
            message_count: 0,
            tool_call_count: 0,
            status: SessionStatus::Active,
            terminal_session_id: None,
            snapshot_session_id: None,
            tags: Vec::new(),
            custom_metadata: None,
            current_context_usage: None,
            relationship: None,
            todos: None,
            review_action_state: None,
            deep_review_run_manifest: None,
            review_target_evidence: None,
            deep_review_cache: None,
            workspace_path: None,
            project_workspace_path: None,
            execution_target: None,
            workspace_hostname: None,
            workspace_id: None,
            project_workspace_id: None,
            unread_completion: None,
            needs_user_attention: None,
            last_turn: None,
        }
    }

    /// Updates the last active time.
    pub fn touch(&mut self) {
        self.last_active_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
    }

    /// Increments the turn count.
    pub fn increment_turn(&mut self) {
        self.turn_count += 1;
    }

    /// Adds to the message count.
    pub fn add_messages(&mut self, count: usize) {
        self.message_count += count;
    }

    /// Adds to the tool call count.
    pub fn add_tool_calls(&mut self, count: usize) {
        self.tool_call_count += count;
    }

    pub fn is_subagent(&self) -> bool {
        matches!(self.session_kind, SessionKind::Subagent)
    }

    pub fn is_standard(&self) -> bool {
        matches!(self.session_kind, SessionKind::Standard)
    }

    pub fn is_internal_hidden(&self) -> bool {
        matches!(
            self.session_kind,
            SessionKind::Subagent | SessionKind::EphemeralChild
        )
    }

    pub fn is_legacy_leaked_subagent_candidate(&self) -> bool {
        let Some(created_by) = self.created_by.as_deref() else {
            return false;
        };
        if !created_by.starts_with("session-") {
            return false;
        }

        self.session_name.starts_with("Subagent: ")
    }

    pub fn should_hide_from_user_lists(&self) -> bool {
        self.is_internal_hidden() || self.is_legacy_leaked_subagent_candidate()
    }
}

impl DialogTurnData {
    /// Creates a new dialog turn.
    pub fn new(
        turn_id: String,
        turn_index: usize,
        session_id: String,
        user_message: UserMessageData,
    ) -> Self {
        Self::new_with_kind(
            DialogTurnKind::UserDialog,
            turn_id,
            turn_index,
            session_id,
            None,
            user_message,
        )
    }

    /// Creates a new dialog turn with an explicit persisted kind.
    pub fn new_with_kind(
        kind: DialogTurnKind,
        turn_id: String,
        turn_index: usize,
        session_id: String,
        agent_type: Option<String>,
        user_message: UserMessageData,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            turn_id,
            turn_index,
            session_id,
            timestamp: now,
            kind,
            agent_type,
            user_message,
            model_rounds: Vec::new(),
            start_time: now,
            end_time: None,
            duration_ms: None,
            token_usage: None,
            finish_reason: None,
            has_final_response: None,
            error: None,
            error_detail: None,
            recovery: None,
            recovery_epoch: None,
            status: TurnStatus::InProgress,
        }
    }

    /// Marks this turn as completed.
    pub fn mark_completed(&mut self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        self.end_time = Some(now);
        self.duration_ms = Some(now.saturating_sub(self.start_time));
        self.status = TurnStatus::Completed;
    }

    /// Counts total tool calls.
    pub fn count_tool_calls(&self) -> usize {
        self.model_rounds
            .iter()
            .map(|round| round.tool_items.len())
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DialogTurnData, DialogTurnKind, DialogTurnRecoveryData, DialogTurnRecoveryStatus,
        ModelRoundData, SessionMemoryMode, SessionMetadata, SessionRelationship,
        SessionRelationshipKind, SessionTurnWindowResponse, TextItemData, ThinkingItemData,
        ToolItemData, UserMessageData,
    };
    use openbitfun_core_types::{SessionContinuationPolicy, SessionKind};

    #[test]
    fn dialog_turn_kind_defaults_to_user_dialog_for_legacy_payloads() {
        let payload = serde_json::json!({
            "turnId": "turn-1",
            "turnIndex": 0,
            "sessionId": "session-1",
            "timestamp": 1,
            "userMessage": {
                "id": "user-1",
                "content": "hello",
                "timestamp": 1
            },
            "modelRounds": [],
            "startTime": 1,
            "status": "completed"
        });

        let turn: DialogTurnData =
            serde_json::from_value(payload).expect("legacy payload should deserialize");

        assert_eq!(turn.kind, DialogTurnKind::UserDialog);
        assert!(turn.recovery.is_none());
    }

    #[test]
    fn interrupted_turn_recovery_metadata_is_additive_and_generation_scoped() {
        let mut turn = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            "session-1".to_string(),
            UserMessageData {
                id: "user-1".to_string(),
                content: "hello".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        turn.recovery = Some(DialogTurnRecoveryData {
            status: DialogTurnRecoveryStatus::Interrupted,
            execution_generation: 2,
            resume_count: 2,
            interrupted_at: Some(42),
            model_id: Some("model-a".to_string()),
        });

        let serialized = serde_json::to_value(&turn).expect("serialize interrupted turn");
        assert_eq!(serialized["status"], "inprogress");
        assert_eq!(serialized["recovery"]["status"], "interrupted");
        assert_eq!(serialized["recovery"]["executionGeneration"], 2);
        assert_eq!(serialized["recovery"]["resumeCount"], 2);
        assert_eq!(serialized["recovery"]["interruptedAt"], 42);
        assert_eq!(serialized["recovery"]["modelId"], "model-a");

        let restored: DialogTurnData =
            serde_json::from_value(serialized).expect("restore interrupted turn");
        assert_eq!(restored.recovery, turn.recovery);
    }

    #[test]
    fn dialog_turn_data_new_defaults_to_user_dialog() {
        let turn = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            "session-1".to_string(),
            UserMessageData {
                id: "user-1".to_string(),
                content: "hello".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );

        assert_eq!(turn.kind, DialogTurnKind::UserDialog);
    }

    #[test]
    fn session_turn_window_response_uses_tagged_camel_case_wire_shape() {
        let turn = DialogTurnData::new(
            "turn-4".to_string(),
            4,
            "session-1".to_string(),
            UserMessageData {
                id: "user-4".to_string(),
                content: "hello".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        let serialized = serde_json::to_value(SessionTurnWindowResponse::Ready {
            catalog_revision: "catalog-1".to_string(),
            total_turn_count: 20,
            start_ordinal: 2,
            end_ordinal_exclusive: 10,
            target_turn_id: "turn-4".to_string(),
            turns: vec![turn],
        })
        .expect("window response should serialize");

        assert_eq!(serialized["status"], "ready");
        assert_eq!(serialized["catalogRevision"], "catalog-1");
        assert_eq!(serialized["totalTurnCount"], 20);
        assert_eq!(serialized["startOrdinal"], 2);
        assert_eq!(serialized["endOrdinalExclusive"], 10);
        assert_eq!(serialized["targetTurnId"], "turn-4");
    }

    #[test]
    fn dialog_turn_token_usage_round_trips_camel_case_payloads() {
        let payload = serde_json::json!({
            "turnId": "turn-1",
            "turnIndex": 0,
            "sessionId": "session-1",
            "timestamp": 1,
            "userMessage": {
                "id": "user-1",
                "content": "hello",
                "timestamp": 1
            },
            "modelRounds": [],
            "startTime": 1,
            "durationMs": 10,
            "tokenUsage": {
                "inputTokens": 1200,
                "outputTokens": 320,
                "totalTokens": 1520,
                "timestamp": 2
            },
            "status": "completed"
        });

        let turn: DialogTurnData =
            serde_json::from_value(payload).expect("turn payload should deserialize");

        let token_usage = turn
            .token_usage
            .as_ref()
            .expect("token usage should be preserved");
        assert_eq!(token_usage.input_tokens, 1200);
        assert_eq!(token_usage.output_tokens, Some(320));
        assert_eq!(token_usage.total_tokens, 1520);

        let serialized = serde_json::to_value(&turn).expect("turn should serialize");
        assert_eq!(serialized["tokenUsage"]["totalTokens"], 1520);
    }

    #[test]
    fn local_usage_report_turn_is_model_invisible() {
        assert!(!DialogTurnKind::LocalCommand.is_model_visible());
    }

    #[test]
    fn manual_compaction_turn_is_model_invisible() {
        assert!(!DialogTurnKind::ManualCompaction.is_model_visible());
        assert!(DialogTurnKind::ManualCompaction.is_transcript_visible());
        assert!(DialogTurnKind::UserDialog.is_transcript_visible());
        assert!(!DialogTurnKind::LocalCommand.is_transcript_visible());
    }

    #[test]
    fn session_metadata_marks_explicit_subagent_as_non_standard() {
        let mut metadata = SessionMetadata::new(
            "session-1".to_string(),
            "Subagent: explore repo".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        metadata.session_kind = SessionKind::Subagent;

        assert!(metadata.is_subagent());
        assert!(!metadata.is_standard());
    }

    #[test]
    fn session_memory_mode_defaults_to_enabled_for_new_and_legacy_metadata() {
        let metadata = SessionMetadata::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        );
        assert_eq!(metadata.memory_mode, SessionMemoryMode::Enabled);

        let payload = serde_json::json!({
            "sessionId": "session-1",
            "sessionName": "Legacy",
            "agentType": "Standard",
            "sessionKind": "standard",
            "modelName": "model",
            "createdAt": 1,
            "lastActiveAt": 1,
            "turnCount": 0,
            "messageCount": 0,
            "toolCallCount": 0,
            "status": "active"
        });
        let legacy: SessionMetadata =
            serde_json::from_value(payload).expect("legacy metadata should deserialize");
        assert_eq!(legacy.memory_mode, SessionMemoryMode::Enabled);
    }

    #[test]
    fn session_memory_mode_round_trips_disabled_and_polluted() {
        for mode in [SessionMemoryMode::Disabled, SessionMemoryMode::Polluted] {
            let mut metadata = SessionMetadata::new(
                "session-1".to_string(),
                "Session".to_string(),
                "Standard".to_string(),
                "model".to_string(),
            );
            metadata.memory_mode = mode;

            let encoded = serde_json::to_value(&metadata).expect("metadata should serialize");
            let decoded: SessionMetadata =
                serde_json::from_value(encoded).expect("metadata should deserialize");

            assert_eq!(decoded.memory_mode, mode);
        }
    }

    #[test]
    fn session_metadata_does_not_treat_standard_session_as_subagent_from_name_or_creator() {
        let mut metadata = SessionMetadata::new(
            "session-1".to_string(),
            "Subagent: repo sweep".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        metadata.created_by = Some("session-parent".to_string());

        assert!(!metadata.is_subagent());
        assert!(metadata.is_standard());
    }

    #[test]
    fn session_metadata_detects_legacy_leaked_subagent_candidate() {
        let mut metadata = SessionMetadata::new(
            "session-1".to_string(),
            "Subagent: repo sweep".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        metadata.created_by = Some("session-parent".to_string());

        assert!(!metadata.is_subagent());
        assert!(metadata.is_legacy_leaked_subagent_candidate());
        assert!(metadata.should_hide_from_user_lists());
    }

    #[test]
    fn session_relationship_round_trips_through_metadata_contract() {
        let mut metadata = SessionMetadata::new(
            "session-relationship".to_string(),
            "Review child".to_string(),
            "CodeReview".to_string(),
            "model".to_string(),
        );
        metadata.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Review),
            parent_session_id: Some("parent-1".to_string()),
            parent_request_id: Some("request-1".to_string()),
            parent_dialog_turn_id: Some("turn-2".to_string()),
            parent_turn_index: Some(2),
            parent_tool_call_id: None,
            subagent_type: None,
            continuation_policy: Some(SessionContinuationPolicy::FreshOnly),
        });

        let json = serde_json::to_value(&metadata).expect("metadata should serialize");
        let round_trip: SessionMetadata =
            serde_json::from_value(json).expect("metadata should deserialize");

        assert_eq!(round_trip.relationship, metadata.relationship);
    }

    #[test]
    fn review_target_evidence_round_trips_through_metadata_contract() {
        let mut metadata = SessionMetadata::new(
            "session-target".to_string(),
            "Review child".to_string(),
            "CodeReview".to_string(),
            "model".to_string(),
        );
        metadata.review_target_evidence = Some(serde_json::json!({
            "version": 1,
            "fingerprint": "target-fingerprint"
        }));

        let json = serde_json::to_value(&metadata).expect("metadata should serialize");
        assert_eq!(
            json["reviewTargetEvidence"]["fingerprint"],
            "target-fingerprint"
        );
        let round_trip: SessionMetadata =
            serde_json::from_value(json).expect("metadata should deserialize");

        assert_eq!(
            round_trip.review_target_evidence,
            metadata.review_target_evidence
        );
    }

    #[test]
    fn session_metadata_keeps_normal_sessions_visible() {
        let metadata = SessionMetadata::new(
            "session-1".to_string(),
            "Normal Session".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        );

        assert!(!metadata.is_subagent());
        assert!(metadata.is_standard());
    }

    #[test]
    fn persisted_runtime_span_fields_are_optional_and_round_trip() {
        let legacy_round_payload = serde_json::json!({
            "id": "round-legacy",
            "turnId": "turn-1",
            "roundIndex": 0,
            "timestamp": 1,
            "textItems": [],
            "toolItems": [],
            "thinkingItems": [],
            "startTime": 1,
            "endTime": 2,
            "status": "completed"
        });

        let legacy_round: ModelRoundData =
            serde_json::from_value(legacy_round_payload).expect("legacy round should deserialize");
        assert_eq!(legacy_round.duration_ms, None);
        assert_eq!(legacy_round.model_config_id, None);
        assert_eq!(legacy_round.first_chunk_ms, None);

        let round_payload = serde_json::json!({
            "id": "round-1",
            "turnId": "turn-1",
            "roundIndex": 0,
            "timestamp": 1,
            "textItems": [],
            "toolItems": [],
            "thinkingItems": [],
            "startTime": 1,
            "endTime": 121,
            "durationMs": 120,
            "providerId": "provider-a",
            "modelConfigId": "model-config-a",
            "effectiveModelName": "model-a",
            "firstChunkMs": 10,
            "firstVisibleOutputMs": 12,
            "streamDurationMs": 90,
            "attemptCount": 2,
            "failureCategory": "rate_limit",
            "tokenDetails": { "reasoningTokens": 7 },
            "status": "completed"
        });

        let round: ModelRoundData =
            serde_json::from_value(round_payload).expect("P1 round should deserialize");
        assert_eq!(round.duration_ms, Some(120));
        assert_eq!(round.provider_id.as_deref(), Some("provider-a"));
        assert_eq!(round.model_config_id.as_deref(), Some("model-config-a"));
        assert_eq!(round.effective_model_name.as_deref(), Some("model-a"));
        assert_eq!(round.first_visible_output_ms, Some(12));
        assert_eq!(round.attempt_count, Some(2));
        assert_eq!(round.failure_category.as_deref(), Some("rate_limit"));

        let encoded = serde_json::to_value(&round).expect("round should serialize");
        assert_eq!(encoded["durationMs"], 120);
        assert_eq!(encoded["modelConfigId"], "model-config-a");
        assert_eq!(encoded["effectiveModelName"], "model-a");
        assert_eq!(encoded["firstChunkMs"], 10);

        let tool_payload = serde_json::json!({
            "id": "tool-1",
            "toolName": "write_file",
            "toolCall": { "id": "call-1", "input": { "file_path": "src/main.rs" } },
            "startTime": 5,
            "endTime": 105,
            "durationMs": 100,
            "queueWaitMs": 7,
            "preflightMs": 11,
            "confirmationWaitMs": 13,
            "executionMs": 69,
            "status": "completed"
        });

        let tool: ToolItemData =
            serde_json::from_value(tool_payload).expect("P1 tool should deserialize");
        assert_eq!(tool.queue_wait_ms, Some(7));
        assert_eq!(tool.preflight_ms, Some(11));
        assert_eq!(tool.confirmation_wait_ms, Some(13));
        assert_eq!(tool.execution_ms, Some(69));

        let encoded = serde_json::to_value(&tool).expect("tool should serialize");
        assert_eq!(encoded["queueWaitMs"], 7);
        assert_eq!(encoded["executionMs"], 69);

        let text_payload = serde_json::json!({
            "id": "text-1",
            "content": "hello",
            "isStreaming": false,
            "timestamp": 10,
            "attemptId": "round-1:attempt:2",
            "attemptIndex": 2
        });
        let text: TextItemData =
            serde_json::from_value(text_payload).expect("text attempt fields should deserialize");
        assert_eq!(text.attempt_id.as_deref(), Some("round-1:attempt:2"));
        assert_eq!(text.attempt_index, Some(2));

        let encoded_text = serde_json::to_value(&text).expect("text should serialize");
        assert_eq!(encoded_text["attemptId"], "round-1:attempt:2");
        assert_eq!(encoded_text["attemptIndex"], 2);

        let thinking_payload = serde_json::json!({
            "id": "thinking-1",
            "content": "reasoning",
            "isStreaming": false,
            "isCollapsed": true,
            "timestamp": 11,
            "attemptId": "round-1:attempt:2",
            "attemptIndex": 2
        });
        let thinking: ThinkingItemData = serde_json::from_value(thinking_payload)
            .expect("thinking attempt fields should deserialize");
        assert!(thinking.reasoning_kind.is_none());
        assert_eq!(thinking.attempt_id.as_deref(), Some("round-1:attempt:2"));
        assert_eq!(thinking.attempt_index, Some(2));

        let tool_attempt_payload = serde_json::json!({
            "id": "tool-2",
            "toolName": "write_file",
            "toolCall": { "id": "call-2", "input": {} },
            "startTime": 1,
            "subagentDialogTurnId": "child-turn-1",
            "attemptId": "round-1:attempt:2",
            "attemptIndex": 2
        });
        let tool_with_attempt: ToolItemData = serde_json::from_value(tool_attempt_payload)
            .expect("tool attempt fields should deserialize");
        assert_eq!(
            tool_with_attempt.attempt_id.as_deref(),
            Some("round-1:attempt:2")
        );
        assert_eq!(tool_with_attempt.attempt_index, Some(2));
        assert_eq!(
            tool_with_attempt.subagent_dialog_turn_id.as_deref(),
            Some("child-turn-1")
        );

        let encoded_tool = serde_json::to_value(&tool_with_attempt).expect("tool should serialize");
        assert_eq!(encoded_tool["subagentDialogTurnId"], "child-turn-1");
    }

    #[test]
    fn session_metadata_preserves_deep_review_run_manifest() {
        let payload = serde_json::json!({
            "sessionId": "session-1",
            "sessionName": "Deep Review",
            "agentType": "DeepReview",
            "sessionKind": "standard",
            "modelName": "fast",
            "createdAt": 1,
            "lastActiveAt": 1,
            "turnCount": 0,
            "messageCount": 0,
            "toolCallCount": 0,
            "status": "active",
            "deep_review_run_manifest": {
                "reviewMode": "deep",
                "coreReviewers": [
                    { "subagentId": "ReviewBusinessLogic" }
                ],
                "skippedReviewers": [
                    { "subagentId": "ReviewFrontend", "reason": "not_applicable" }
                ]
            }
        });

        let metadata: SessionMetadata =
            serde_json::from_value(payload).expect("metadata should deserialize");

        assert_eq!(
            metadata.deep_review_run_manifest.as_ref().unwrap()["reviewMode"],
            "deep"
        );

        let serialized = serde_json::to_value(&metadata).expect("metadata should serialize");
        assert_eq!(
            serialized["deepReviewRunManifest"]["coreReviewers"][0]["subagentId"],
            "ReviewBusinessLogic"
        );
    }

    #[test]
    fn session_metadata_preserves_review_action_state() {
        let payload = serde_json::json!({
            "sessionId": "review-session",
            "sessionName": "Review",
            "agentType": "CodeReview",
            "modelName": "default",
            "createdAt": 1,
            "lastActiveAt": 1,
            "turnCount": 1,
            "messageCount": 1,
            "toolCallCount": 1,
            "status": "active",
            "tags": [],
            "reviewActionState": {
                "version": 1,
                "phase": "fix_completed",
                "followUpReviewSessionId": "follow-up-review"
            }
        });

        let metadata: SessionMetadata =
            serde_json::from_value(payload).expect("metadata should deserialize");
        assert_eq!(
            metadata.review_action_state.as_ref().unwrap()["followUpReviewSessionId"],
            "follow-up-review"
        );

        let serialized = serde_json::to_value(metadata).expect("metadata should serialize");
        assert_eq!(serialized["reviewActionState"]["phase"], "fix_completed");
    }
}
