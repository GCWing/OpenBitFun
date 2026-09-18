use crate::session_state::SessionState;
pub use openbitfun_core_types::SessionKind;
pub use openbitfun_core_types::{
    SessionAgentRouteOwner, SessionContinuationPolicy, SessionExecutionTarget,
    SessionModelBindingPolicy,
};
pub use openbitfun_runtime_ports::PermissionMode;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;
use uuid::Uuid;

// ============ Session ============

/// Session: contains multiple dialog turns
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub session_id: String,
    pub session_name: String,
    /// Current/default mode selection for the session.
    ///
    /// This is the mode the next dialog turn should run with by default. It is
    /// not required to match either the last surviving history turn or the last
    /// message submission accepted by the scheduler.
    #[serde(deserialize_with = "openbitfun_core_types::agent_identity::deserialize_agent_id")]
    pub agent_type: String,
    /// Cached mode of the last surviving user dialog turn in history.
    ///
    /// Reminder builders use this value for `previous_agent_type` so
    /// first-entry vs ongoing mode prompts follow the surviving transcript
    /// after rollbacks or turn truncation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_user_dialog_agent_type: Option<String>,
    /// Mode of the most recent user submission accepted by the scheduler.
    ///
    /// Unlike `last_user_dialog_agent_type`, this value is not rewound by
    /// history rollback. It tracks session-level prompt-cache compatibility for
    /// the next accepted submission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_submitted_agent_type: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "created_by",
        alias = "createdBy"
    )]
    pub created_by: Option<String>,
    #[serde(default, alias = "session_kind", alias = "sessionKind")]
    pub kind: SessionKind,

    /// Associated resources
    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "sandbox_session_id",
        alias = "sandboxSessionId"
    )]
    pub snapshot_session_id: Option<String>,

    /// Dialog turn ID list
    pub dialog_turn_ids: Vec<String>,

    /// Session state
    pub state: SessionState,

    /// Configuration
    pub config: SessionConfig,

    /// Context compression related
    pub compression_state: CompressionState,

    /// Lifecycle
    pub created_at: SystemTime,
    pub updated_at: SystemTime,
    pub last_activity_at: SystemTime,
}

/// Context compression state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompressionState {
    /// Time of last compression
    pub last_compression_at: Option<SystemTime>,
    /// Compression trigger count
    pub compression_count: usize,
}

impl CompressionState {
    pub fn increment_compression_count(&mut self) {
        self.last_compression_at = Some(SystemTime::now());
        self.compression_count += 1;
    }
}

impl Session {
    pub fn new(session_name: String, agent_type: String, config: SessionConfig) -> Self {
        let agent_type =
            openbitfun_core_types::agent_identity::canonical_agent_id(&agent_type).to_owned();
        let now = SystemTime::now();
        Self {
            session_id: Uuid::new_v4().to_string(),
            session_name,
            agent_type,
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            created_by: None,
            kind: SessionKind::Standard,
            snapshot_session_id: None,
            dialog_turn_ids: vec![],
            state: SessionState::Idle,
            config,
            compression_state: CompressionState::default(),
            created_at: now,
            updated_at: now,
            last_activity_at: now,
        }
    }

    pub fn new_with_id(
        session_id: String,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
    ) -> Self {
        let agent_type =
            openbitfun_core_types::agent_identity::canonical_agent_id(&agent_type).to_owned();
        let now = SystemTime::now();
        Self {
            session_id,
            session_name,
            agent_type,
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            created_by: None,
            kind: SessionKind::Standard,
            snapshot_session_id: None,
            dialog_turn_ids: vec![],
            state: SessionState::Idle,
            config,
            compression_state: CompressionState::default(),
            created_at: now,
            updated_at: now,
            last_activity_at: now,
        }
    }

    /// Stable routing identity for provider-side prompt-prefix caches.
    ///
    /// Legacy and independent sessions use their own session ID. Derived
    /// sessions that preserve a parent prompt prefix persist the parent's
    /// effective lineage in `SessionConfig`.
    pub fn effective_prompt_cache_lineage_id(&self) -> &str {
        self.config
            .prompt_cache_lineage_id
            .as_deref()
            .unwrap_or(&self.session_id)
    }
}

impl From<Session> for openbitfun_runtime_ports::AgentSessionCreateResult {
    fn from(session: Session) -> Self {
        let mut result = Self::new(session.session_id, session.session_name, session.agent_type);
        result.model_id = session.config.model_id;
        result.workspace_path = session.config.workspace_path;
        result.workspace_id = session.config.workspace_id;
        result.project_workspace_path = session.config.project_workspace_path;
        result.execution_target = session.config.execution_target;
        result
    }
}

/// Session configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub max_context_tokens: usize,
    pub auto_compact: bool,
    pub enable_tools: bool,
    pub safe_mode: bool,
    pub max_turns: usize,
    /// Read-only migration marker for sessions written by the retired Harness
    /// Profile implementation. New session data never serializes this field.
    #[serde(
        default,
        rename = "execution_profile",
        alias = "executionProfile",
        deserialize_with = "deserialize_legacy_minimal_agent",
        skip_serializing
    )]
    pub legacy_minimal_agent: bool,
    pub enable_context_compression: bool,
    /// Workspace path bound to this session. Used to run AI in the correct workspace
    /// without changing the desktop's foreground workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Main project root used for session persistence and project-scoped
    /// orchestration. For legacy and local sessions this is the same as
    /// `workspace_path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    /// Resolved execution target. Legacy sessions omit this and are treated as
    /// local sessions rooted at `workspace_path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<SessionExecutionTarget>,
    /// Stable workspace id for resolving workspace-scoped metadata such as related directories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    /// Projection of the owning workspace record; legacy sessions resolve this on load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<openbitfun_core_types::WorkspaceKind>,
    /// Saved connection projected from the workspace record. `workspace_kind`
    /// determines locality; absence of credentials must never select local I/O.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    /// SSH config `host` for locating `~/.openbitfun/remote_ssh/{host}/.../sessions` when disconnected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    /// Model config ID used by this session (for token usage tracking)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Explicit reasoning preset selected for this session. `None` means the
    /// model's default preset (Auto).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_preset: Option<String>,
    /// Explicit tool permission mode selected for this session. `None` follows
    /// the user-level default, so an unset session keeps tracking global
    /// configuration changes instead of freezing the value it was created with.
    ///
    /// Read leniently: a mode written by a newer build must not fail the whole
    /// persisted session state. See `deserialize_optional_permission_mode`.
    #[serde(
        default,
        deserialize_with = "openbitfun_runtime_ports::deserialize_optional_permission_mode",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_mode: Option<PermissionMode>,
    /// Whether this child session accepts another delegated turn.
    #[serde(default, skip_serializing_if = "is_reusable_continuation_policy")]
    pub continuation_policy: SessionContinuationPolicy,
    /// Whether config reconciliation may replace this session's model.
    #[serde(default, skip_serializing_if = "is_mutable_model_binding_policy")]
    pub model_binding_policy: SessionModelBindingPolicy,
    /// Runtime identity approved for an immutable concrete model binding.
    /// Mutable sessions leave this unset and continue to resolve selectors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_binding_fingerprint: Option<String>,
    /// Stable provider-cache lineage shared only by sessions that preserve an
    /// exact prompt prefix. `None` keeps legacy and independent sessions scoped
    /// to their own session ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_lineage_id: Option<String>,
    /// Durable owner of the logical main-agent route. External ownership is
    /// revalidated for every turn and never falls back by name alone.
    #[serde(default, skip_serializing_if = "is_local_agent_route_owner")]
    pub agent_route_owner: SessionAgentRouteOwner,
    /// Stable identity of the selected Agent route. This is distinct from a
    /// process-local generation key and survives plugin reloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_route_key: Option<String>,
}

fn deserialize_legacy_minimal_agent<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .get("harnessProfileId")
        .or_else(|| value.get("harness_profile_id"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id.eq_ignore_ascii_case("minimal")))
}

fn is_reusable_continuation_policy(policy: &SessionContinuationPolicy) -> bool {
    *policy == SessionContinuationPolicy::Reusable
}

fn is_mutable_model_binding_policy(policy: &SessionModelBindingPolicy) -> bool {
    *policy == SessionModelBindingPolicy::Mutable
}

fn is_local_agent_route_owner(owner: &SessionAgentRouteOwner) -> bool {
    *owner == SessionAgentRouteOwner::Local
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            max_context_tokens: 128128,
            auto_compact: true,
            enable_tools: true,
            safe_mode: true,
            max_turns: 200,
            legacy_minimal_agent: false,
            enable_context_compression: true,
            workspace_path: None,
            project_workspace_path: None,
            execution_target: None,
            workspace_id: None,
            project_workspace_id: None,
            workspace_kind: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            reasoning_preset: None,
            permission_mode: None,
            continuation_policy: SessionContinuationPolicy::default(),
            model_binding_policy: SessionModelBindingPolicy::default(),
            model_binding_fingerprint: None,
            prompt_cache_lineage_id: None,
            agent_route_owner: SessionAgentRouteOwner::Local,
            agent_route_key: None,
        }
    }
}

/// Session summary (for list display)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub session_name: String,
    /// Current/default mode selection for the session.
    #[serde(deserialize_with = "openbitfun_core_types::agent_identity::deserialize_agent_id")]
    pub agent_type: String,
    /// Runtime-owned model selector currently bound to the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Explicit reasoning preset currently bound to the session. `None`
    /// means the model's canonical default (Auto).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_preset: Option<String>,
    /// Mode of the last surviving user dialog turn in the session history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_user_dialog_agent_type: Option<String>,
    /// Mode of the most recent user submission accepted by the scheduler.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_submitted_agent_type: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "created_by",
        alias = "createdBy"
    )]
    pub created_by: Option<String>,
    #[serde(default, alias = "session_kind", alias = "sessionKind")]
    pub kind: SessionKind,
    pub turn_count: usize,
    pub created_at: SystemTime,
    pub last_activity_at: SystemTime,
    pub state: SessionState,
}

/// Persisted session state sidecar used by product session storage.
///
/// The runtime owns this wire shape because it contains provider-neutral session
/// facts. Product persistence code still owns file I/O and path resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionStateFile {
    pub schema_version: u32,
    pub config: SessionConfig,
    pub snapshot_session_id: Option<String>,
    /// Derived runtime cache for reminder semantics. The source of truth lives
    /// on persisted dialog turns via `DialogTurnData.agent_type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_user_dialog_agent_type: Option<String>,
    /// Session-level prompt-cache guard state. This records the most recent user
    /// submission accepted by the scheduler and intentionally does not rewind on
    /// history rollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_submitted_agent_type: Option<String>,
    pub compression_state: CompressionState,
    pub runtime_state: SessionState,
}

pub fn sanitize_persisted_session_state(state: &SessionState) -> SessionState {
    match state {
        SessionState::Processing { .. } => SessionState::Idle,
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_persisted_session_state, CompressionState, PermissionMode,
        PersistedSessionStateFile, Session, SessionAgentRouteOwner, SessionConfig,
        SessionContinuationPolicy, SessionModelBindingPolicy,
    };
    use crate::session_state::{ProcessingPhase, SessionState};

    fn persisted_state_json(permission_mode: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1,
            "config": {
                "max_context_tokens": 128128,
                "auto_compact": true,
                "enable_tools": true,
                "safe_mode": true,
                "max_turns": 200,
                "enable_context_compression": true,
                "permission_mode": permission_mode,
            },
            "snapshot_session_id": null,
            "compression_state": { "last_compression_at": null, "compression_count": 0 },
            "runtime_state": "Idle",
        })
    }

    #[test]
    fn persisted_session_state_survives_a_permission_mode_from_a_newer_build() {
        let known: PersistedSessionStateFile =
            serde_json::from_value(persisted_state_json(serde_json::json!("full_access")))
                .expect("known mode should load");
        assert_eq!(
            known.config.permission_mode,
            Some(PermissionMode::FullAccess)
        );

        // The whole state file must still load; only the unreadable selection is
        // dropped, leaving the session on the user-level default.
        let unknown: PersistedSessionStateFile =
            serde_json::from_value(persisted_state_json(serde_json::json!("read_only")))
                .expect("an unknown mode must not fail the state file");
        assert_eq!(unknown.config.permission_mode, None);
        assert_eq!(unknown.config.max_context_tokens, 128128);
        assert!(unknown.config.enable_tools);
    }

    #[test]
    fn unset_permission_mode_keeps_persisted_config_bytes_unchanged() {
        let serialized = serde_json::to_value(SessionConfig::default()).expect("serialize");
        assert!(serialized.get("permission_mode").is_none());
    }

    #[test]
    fn prompt_cache_lineage_defaults_to_the_session_id_and_round_trips() {
        let mut legacy_value = serde_json::to_value(SessionConfig::default()).expect("serialize");
        legacy_value
            .as_object_mut()
            .expect("config should serialize as an object")
            .remove("prompt_cache_lineage_id");
        let legacy_config: SessionConfig =
            serde_json::from_value(legacy_value).expect("deserialize legacy config");
        let mut session =
            Session::new("Session".to_string(), "Standard".to_string(), legacy_config);
        assert!(session.config.prompt_cache_lineage_id.is_none());
        assert_eq!(
            session.effective_prompt_cache_lineage_id(),
            session.session_id
        );

        session.config.prompt_cache_lineage_id = Some("root-session".to_string());
        assert_eq!(session.effective_prompt_cache_lineage_id(), "root-session");

        let serialized = serde_json::to_value(&session.config).expect("serialize");
        assert_eq!(
            serialized["prompt_cache_lineage_id"],
            serde_json::json!("root-session")
        );
        let restored: SessionConfig = serde_json::from_value(serialized).expect("deserialize");
        assert_eq!(
            restored.prompt_cache_lineage_id.as_deref(),
            Some("root-session")
        );
    }
    use openbitfun_core_types::{
        SessionExecutionTarget, SessionExecutionTargetKind, WorktreeLifecycle,
    };
    use openbitfun_runtime_ports::AgentSessionCreateResult;
    use serde_json::json;

    #[test]
    fn session_config_default_preserves_existing_context_budget() {
        let config = SessionConfig::default();

        assert_eq!(config.max_context_tokens, 128128);
        assert!(config.auto_compact);
        assert!(config.enable_tools);
        assert!(config.safe_mode);
        assert_eq!(config.max_turns, 200);
        assert!(config.enable_context_compression);
        assert!(config.workspace_path.is_none());
        assert!(config.workspace_id.is_none());
        assert!(config.remote_connection_id.is_none());
        assert!(config.remote_ssh_host.is_none());
        assert!(config.model_id.is_none());
        assert!(config.reasoning_preset.is_none());
        assert_eq!(
            config.continuation_policy,
            SessionContinuationPolicy::Reusable
        );
        assert_eq!(
            config.model_binding_policy,
            SessionModelBindingPolicy::Mutable
        );
        assert_eq!(config.agent_route_owner, SessionAgentRouteOwner::Local);
        assert!(config.agent_route_key.is_none());
    }

    #[test]
    fn external_agent_route_owner_persists_and_legacy_sessions_default_local() {
        let config = SessionConfig {
            agent_route_owner: SessionAgentRouteOwner::External,
            agent_route_key: Some("opencode:plugin:build".to_string()),
            ..SessionConfig::default()
        };
        let mut serialized = serde_json::to_value(&config).expect("serialize session config");
        assert_eq!(serialized["agent_route_owner"], "external");
        assert_eq!(serialized["agent_route_key"], "opencode:plugin:build");

        serialized
            .as_object_mut()
            .expect("session config object")
            .remove("agent_route_owner");
        serialized
            .as_object_mut()
            .expect("session config object")
            .remove("agent_route_key");
        let restored: SessionConfig =
            serde_json::from_value(serialized).expect("deserialize legacy session config");
        assert_eq!(restored.agent_route_owner, SessionAgentRouteOwner::Local);
        assert!(restored.agent_route_key.is_none());
    }

    #[test]
    fn non_default_subagent_session_policies_are_persisted_and_legacy_defaults_remain_compatible() {
        let config = SessionConfig {
            continuation_policy: SessionContinuationPolicy::FreshOnly,
            model_binding_policy: SessionModelBindingPolicy::ApprovedImmutable,
            ..SessionConfig::default()
        };
        let serialized = serde_json::to_value(&config).expect("session config should serialize");
        assert_eq!(serialized["continuation_policy"], "fresh_only");
        assert_eq!(serialized["model_binding_policy"], "approved_immutable");

        let mut legacy = serialized;
        legacy
            .as_object_mut()
            .expect("session config should be an object")
            .remove("continuation_policy");
        legacy
            .as_object_mut()
            .expect("session config should be an object")
            .remove("model_binding_policy");
        let restored: SessionConfig =
            serde_json::from_value(legacy).expect("legacy session config should deserialize");
        assert_eq!(
            restored.continuation_policy,
            SessionContinuationPolicy::Reusable
        );
        assert_eq!(
            restored.model_binding_policy,
            SessionModelBindingPolicy::Mutable
        );
    }

    #[test]
    fn new_session_preserves_legacy_runtime_defaults() {
        let session = Session::new(
            "Session".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );

        assert_eq!(session.session_name, "Session");
        assert_eq!(session.agent_type, "Standard");
        assert_eq!(session.dialog_turn_ids, Vec::<String>::new());
        assert_eq!(session.state, SessionState::Idle);
        assert_eq!(session.compression_state.compression_count, 0);
        assert!(session.last_user_dialog_agent_type.is_none());
        assert!(session.last_submitted_agent_type.is_none());
        assert!(session.created_by.is_none());
        assert!(session.snapshot_session_id.is_none());
    }

    #[test]
    fn session_create_result_preserves_normalized_workspace_facts() {
        let execution_target = SessionExecutionTarget {
            kind: SessionExecutionTargetKind::ManagedWorktree,
            worktree_id: Some("worktree_1".to_string()),
            root_path: "/worktrees/session_1".to_string(),
            base_ref: Some("main".to_string()),
            base_commit: Some("0123456789abcdef".to_string()),
            branch: Some("openbitfun/session_1".to_string()),
            lifecycle: Some(WorktreeLifecycle::Managed),
        };
        let session = Session::new_with_id(
            "session_1".to_string(),
            "Main".to_string(),
            "Standard".to_string(),
            SessionConfig {
                model_id: Some("provider/model".to_string()),
                workspace_path: Some("/worktrees/session_1".to_string()),
                workspace_id: Some("workspace_1".to_string()),
                project_workspace_path: Some("/workspace/project".to_string()),
                execution_target: Some(execution_target.clone()),
                ..SessionConfig::default()
            },
        );

        let result = AgentSessionCreateResult::from(session);

        assert_eq!(result.session_id, "session_1");
        assert_eq!(result.session_name, "Main");
        assert_eq!(result.agent_type, "Standard");
        assert_eq!(result.model_id.as_deref(), Some("provider/model"));
        assert_eq!(
            result.workspace_path.as_deref(),
            Some("/worktrees/session_1")
        );
        assert_eq!(result.workspace_id.as_deref(), Some("workspace_1"));
        assert_eq!(
            result.project_workspace_path.as_deref(),
            Some("/workspace/project")
        );
        assert_eq!(result.execution_target, Some(execution_target));
    }

    #[test]
    fn persisted_session_state_sanitizes_processing_to_idle() {
        let sanitized = sanitize_persisted_session_state(&SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: ProcessingPhase::Thinking,
        });

        assert_eq!(sanitized, SessionState::Idle);
        assert_eq!(
            sanitize_persisted_session_state(&SessionState::Error {
                error: "boom".to_string(),
                recoverable: true,
            }),
            SessionState::Error {
                error: "boom".to_string(),
                recoverable: true,
            }
        );
    }

    #[test]
    fn persisted_session_state_file_shape_stays_compatible() {
        let file = PersistedSessionStateFile {
            schema_version: 1,
            config: SessionConfig {
                workspace_path: Some("/workspace".to_string()),
                model_id: Some("model-a".to_string()),
                ..SessionConfig::default()
            },
            snapshot_session_id: Some("snapshot-1".to_string()),
            last_user_dialog_agent_type: Some("Standard".to_string()),
            last_submitted_agent_type: Some("DeepReview".to_string()),
            compression_state: CompressionState {
                last_compression_at: None,
                compression_count: 2,
            },
            runtime_state: SessionState::Idle,
        };

        assert_eq!(
            serde_json::to_value(file).expect("persisted session state should serialize"),
            json!({
                "schema_version": 1,
                "config": {
                    "max_context_tokens": 128128,
                    "auto_compact": true,
                    "enable_tools": true,
                    "safe_mode": true,
                    "max_turns": 200,
                    "enable_context_compression": true,
                    "workspace_path": "/workspace",
                    "model_id": "model-a"
                },
                "snapshot_session_id": "snapshot-1",
                "last_user_dialog_agent_type": "Standard",
                "last_submitted_agent_type": "DeepReview",
                "compression_state": {
                    "last_compression_at": null,
                    "compression_count": 2
                },
                "runtime_state": "Idle"
            })
        );
    }

    #[test]
    fn legacy_minimal_profile_is_read_once_and_never_written_again() {
        let mut serialized = serde_json::to_value(SessionConfig::default()).expect("serialize");
        serialized["execution_profile"] = serde_json::json!({
            "harnessProfileId": "minimal",
            "schemaVersion": 1,
            "selectedBy": "user"
        });
        let restored: SessionConfig =
            serde_json::from_value(serialized).expect("legacy config should deserialize");
        assert!(restored.legacy_minimal_agent);

        let rewritten = serde_json::to_value(restored).expect("serialize migrated config");
        assert!(rewritten.get("execution_profile").is_none());
    }
}

impl SessionConfig {
    pub fn is_remote_workspace(&self) -> bool {
        self.workspace_kind == Some(openbitfun_core_types::WorkspaceKind::Remote)
    }
}
