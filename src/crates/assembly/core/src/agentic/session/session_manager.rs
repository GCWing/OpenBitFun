//! Session Manager
//!
//! Responsible for session CRUD, lifecycle management, and resource association

use crate::agentic::agents::get_agent_registry;
use crate::agentic::core::{
    new_turn_id, CompressionContract, CompressionState, InternalReminderKind, Message,
    MessageContent, MessageRole, MessageSemanticKind, ProcessingPhase, Session,
    SessionAgentRouteOwner, SessionConfig, SessionKind, SessionModelBindingPolicy, SessionState,
    SessionSummary, TurnStats,
};
use crate::agentic::image_analysis::ImageContextData;
use crate::agentic::keyed_lock::{KeyedAsyncLock, KeyedAsyncLockGuard};
use crate::agentic::memories::db::{MemoryDatabase, MEMORY_PHASE2_GLOBAL_JOB_KEY};
use crate::agentic::persistence::{MaterializedSessionReferenceTranscript, PersistenceManager};
use crate::agentic::session::revert::SessionRevertPhase;
use crate::agentic::session::session_store_port::CoreSessionStorePort;
use crate::agentic::session::{
    prompt_cache_persist_action, reconcile_prompt_cache_restore, CachedSystemPrompt,
    CachedUserContext, EvidenceLedgerCheckpoint, EvidenceLedgerEvent, EvidenceLedgerEventStatus,
    EvidenceLedgerSummary, EvidenceLedgerTargetKind, FileRevision, PromptCacheLookup,
    PromptCachePersistenceWriteAction, PromptCachePolicy, PromptCacheRestoreDecision,
    PromptCacheScope, ReviewReadCoverage, ReviewReadReceiptStore, SessionContextStore,
    SessionEvidenceLedger, SessionPromptCache, SessionPromptCacheStore, SystemPromptCacheIdentity,
    TokenAnchor, TokenAnchorSelection, TokenAnchorStore, TurnSkillAgentSnapshotStore,
    UserContextCacheIdentity,
};
use crate::agentic::skill_agent_snapshot::TurnSkillAgentSnapshot;
use crate::agentic::workspace::WorkspaceBinding;
use crate::agentic::ConversationCoordinator;
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog_without_refresh, normalize_reasoning_preset_for_model,
    project_model_reasoning_catalog, reasoning_preset_runtime_fingerprint,
    resolve_default_reasoning_preset, resolve_reasoning_preset,
};
use crate::service::config::types::{model_runtime_binding_fingerprint, AIConfig};
use crate::service::config::{
    get_app_language_code, get_global_config_service, short_model_user_language_instruction,
    subscribe_config_updates, ConfigUpdateEvent,
};
use crate::service::session::{
    DialogTurnData, DialogTurnKind, DialogTurnRecoveryData, DialogTurnRecoveryStatus,
    ModelRoundData, SessionContextUsage, SessionMemoryMode, SessionMetadata, SessionRelationship,
    SessionStatus, TextItemData, ThinkingItemData, ToolCallData, ToolItemData, ToolResultData,
    TranscriptLineRange, TurnStatus, UserMessageData,
};
use crate::service::snapshot::{
    ensure_snapshot_manager_for_workspace, get_or_create_snapshot_manager,
};
use crate::service::workspace::{get_global_workspace_service, WorkspaceInfo};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::sanitize_plain_model_output;
use crate::util::timing::elapsed_ms_u64;
use dashmap::{mapref::entry::Entry, DashMap};
use log::{debug, error, info, warn};
use openbitfun_core_types::SessionExecutionTarget;
pub use openbitfun_runtime_ports::SessionViewRestoreTiming;
use openbitfun_runtime_ports::{
    AgentTurnSettlementResult, PermissionMode, SessionStoragePathRequest, SessionStorePort,
};
use openbitfun_services_core::session::{
    apply_session_lineage, collect_hidden_subagent_cascade as collect_hidden_subagent_cascade_ids,
    merge_session_custom_metadata as merge_session_custom_metadata_value,
    set_deep_review_run_manifest, set_review_target_evidence, set_session_relationship,
    SessionStorageLayout, SessionWriteLock,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::time::{Duration, SystemTime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time;

#[cfg(test)]
tokio::task_local! {
    pub(crate) static TEST_MODEL_RESOLUTION_AI_CONFIG: crate::service::config::types::AIConfig;
}

/// Session manager configuration
#[derive(Debug, Clone)]
pub struct SessionManagerConfig {
    pub max_active_sessions: usize,
    pub session_idle_timeout: Duration,
    pub auto_save_interval: Duration,
    pub enable_persistence: bool,
    pub prompt_cache_policy: PromptCachePolicy,
}

/// Stable locator supplied by the UI for a session reference. The workspace
/// identity is required because session IDs are normally UUIDs but are not a
/// globally unique contract across all persisted workspaces.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReferenceLocator {
    pub session_id: String,
    /// Owning workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only pre-ID storage selector. New producers send workspace_id.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MaterializedSessionReference {
    pub session_id: String,
    pub session_name: String,
    pub transcript: MaterializedSessionReferenceTranscript,
}

pub(crate) const INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY: &str = "resolved_permission_mode";
pub(crate) const INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY: &str =
    "runtime_resolved_model_id";
pub(crate) const INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY: &str =
    "runtime_model_binding_fingerprint";
pub(crate) const INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY: &str = "runtime_reasoning_preset";
pub(crate) const INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY: &str =
    "runtime_reasoning_selection";
pub(crate) const INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY: &str =
    "runtime_reasoning_fingerprint";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TurnAdmissionSessionFacts {
    model_id: Option<String>,
    reasoning_preset: Option<String>,
    permission_mode: Option<PermissionMode>,
    max_context_tokens: usize,
    agent_type: String,
    agent_route_owner: SessionAgentRouteOwner,
    agent_route_key: Option<String>,
    enable_tools: bool,
    workspace_path: Option<String>,
    project_workspace_path: Option<String>,
    execution_target: Option<SessionExecutionTarget>,
    workspace_id: Option<String>,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
}

impl TurnAdmissionSessionFacts {
    pub(crate) fn from_session(session: &Session) -> Self {
        Self {
            model_id: session.config.model_id.clone(),
            reasoning_preset: session.config.reasoning_preset.clone(),
            permission_mode: session.config.permission_mode,
            max_context_tokens: session.config.max_context_tokens,
            agent_type: session.agent_type.clone(),
            agent_route_owner: session.config.agent_route_owner,
            agent_route_key: session.config.agent_route_key.clone(),
            enable_tools: session.config.enable_tools,
            workspace_path: session.config.workspace_path.clone(),
            project_workspace_path: session.config.project_workspace_path.clone(),
            execution_target: session.config.execution_target.clone(),
            workspace_id: session.config.workspace_id.clone(),
            remote_connection_id: session.config.remote_connection_id.clone(),
            remote_ssh_host: session.config.remote_ssh_host.clone(),
        }
    }

    pub(crate) fn with_reasoning_preset(mut self, reasoning_preset: Option<String>) -> Self {
        self.reasoning_preset = reasoning_preset;
        self
    }

    fn matches(&self, session: &Session) -> bool {
        self.model_id == session.config.model_id
            && self.reasoning_preset == session.config.reasoning_preset
            && self.permission_mode == session.config.permission_mode
            && self.max_context_tokens == session.config.max_context_tokens
            && self.agent_type == session.agent_type
            && self.agent_route_owner == session.config.agent_route_owner
            && self.agent_route_key == session.config.agent_route_key
            && self.enable_tools == session.config.enable_tools
            && self.workspace_path == session.config.workspace_path
            && self.project_workspace_path == session.config.project_workspace_path
            && self.execution_target == session.config.execution_target
            && self.workspace_id == session.config.workspace_id
            && self.remote_connection_id == session.config.remote_connection_id
            && self.remote_ssh_host == session.config.remote_ssh_host
    }
}

#[derive(Debug, Clone)]
pub(crate) struct InterruptedTurnRecoveryPlan {
    pub session_id: String,
    pub turn_id: String,
    pub turn_index: usize,
    pub agent_type: String,
    pub execution_generation: u32,
    pub resume_count: u32,
    pub initial_round_index: usize,
    pub resolved_permission_mode: PermissionMode,
    pub resolved_model_id: String,
    pub model_binding_fingerprint: String,
    pub user_input: String,
    pub messages: Vec<Message>,
    pub user_message_metadata: Option<serde_json::Value>,
}

impl Default for SessionManagerConfig {
    fn default() -> Self {
        Self {
            max_active_sessions: 100,
            session_idle_timeout: Duration::from_secs(3600), // 1 hour
            auto_save_interval: Duration::from_secs(300),    // 5 minutes
            enable_persistence: true,
            prompt_cache_policy: PromptCachePolicy::default(),
        }
    }
}

fn should_apply_session_model_fallback(
    binding_policy: SessionModelBindingPolicy,
    current_model_id: &str,
    invalidated_model_ids: &HashSet<&str>,
) -> bool {
    session_model_allows_fallback(binding_policy)
        && invalidated_model_ids.contains(current_model_id)
}

fn session_model_allows_fallback(binding_policy: SessionModelBindingPolicy) -> bool {
    binding_policy == SessionModelBindingPolicy::Mutable
}

fn effective_session_model_selector<'a>(
    ai_config: &'a crate::service::config::types::AIConfig,
    session: &'a Session,
) -> &'a str {
    session
        .config
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|model_id| !model_id.is_empty())
        .or_else(|| {
            (session.kind != SessionKind::Subagent)
                .then_some(ai_config.agent_model_defaults.mode.trim())
                .filter(|model_id| !model_id.is_empty())
        })
        .unwrap_or("primary")
}

fn concrete_model_for_session_selection<'a>(
    ai_config: &'a crate::service::config::types::AIConfig,
    session: &Session,
) -> Option<&'a crate::service::config::types::AIModelConfig> {
    let configured_model_id = effective_session_model_selector(ai_config, session);

    let resolved_model_id = if matches!(
        session.config.model_binding_policy,
        SessionModelBindingPolicy::ApprovedImmutable
    ) {
        ai_config.resolve_model_reference(configured_model_id)
    } else {
        ai_config.resolve_model_selection(configured_model_id)
    }?;

    ai_config
        .models
        .iter()
        .find(|model| model.enabled && model.id == resolved_model_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionTranscriptReference {
    pub uri: String,
    pub index_range: TranscriptLineRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionTitleMethod {
    Ai,
    Fallback,
}

impl SessionTitleMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ai => "ai",
            Self::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedSessionTitle {
    pub title: String,
    pub method: SessionTitleMethod,
}

// When a full skill/agent listing baseline is rebuilt at turn R, snapshots whose
// turn_index < R still contain now-redundant listing diff reminders. We do not
// eagerly rewrite all historical snapshots; instead restore/rollback sanitize those
// older snapshots lazily based on this persisted cutoff.
const LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY: &str = "listingBaselineRebuildTurnIndex";

fn current_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// Where a session executes, as a single atomic rebind.
#[derive(Debug, Clone)]
pub struct SessionExecutionBindingUpdate {
    pub workspace_path: String,
    pub project_workspace_path: String,
    pub workspace_id: Option<String>,
    pub execution_target: SessionExecutionTarget,
}

/// Stable failure categories for atomically moving a session execution root.
///
/// Worktree lifecycle maps these categories to its public structured error
/// contract without having to inspect human-readable `OpenBitFunError` messages.
#[derive(Debug, thiserror::Error)]
pub enum SessionExecutionBindingError {
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Internal(#[from] OpenBitFunError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionResourceCleanupPolicy {
    BestEffort,
    Required,
}

/// Session manager
pub struct SessionManager {
    /// Active sessions in memory
    sessions: Arc<DashMap<String, Session>>,

    /// Ephemeral permission override for the currently executing turn.
    ///
    /// This state is intentionally separate from `SessionConfig`: it may change
    /// between model rounds, and it must disappear when the owning turn ends.
    active_turn_permission_modes: Arc<DashMap<String, ActiveTurnPermissionMode>>,

    /// Process-local durability classification owned by the Session lifecycle.
    /// Entries are installed before a transient Session becomes visible and are
    /// removed with that Session; they are never serialized into public config.
    transient_session_ids: Arc<DashMap<String, ()>>,

    /// Recent authoritative terminal results for live Turn settlement callers.
    /// The bounded cache preserves the exact execution result; persisted Turns
    /// remain the fallback, while transient Sessions depend on this copy.
    turn_settlement_results: Arc<DashMap<(String, String), AgentTurnSettlementResult>>,
    turn_settlement_result_order: Arc<Mutex<VecDeque<(String, String)>>>,

    /// Exact admission accounting for loaded sessions. A permit is acquired
    /// before create/restore publishes runtime state and released on unload/delete/eviction.
    active_session_capacity: Arc<Semaphore>,
    active_session_permits: Arc<DashMap<String, OwnedSemaphorePermit>>,

    /// Runtime cache of session_id -> effective session storage path.
    /// Populated on session create/restore and used to restore evicted sessions
    /// or resolve workspace-bound operations that only receive a session_id.
    /// This cache is intentionally retained across memory eviction, but should
    /// be cleared when a session is explicitly deleted.
    session_storage_path_index: Arc<DashMap<String, SessionStoragePathBinding>>,

    /// Serializes create, restore, and delete mutations for one session ID.
    ///
    /// Storage-path claims prevent cross-workspace identity collisions, while
    /// this permit prevents a slower restore from replacing a session that a
    /// concurrent operation has already made active.
    session_mutation_locks: KeyedAsyncLock,

    /// Cross-process writers for durable Sessions currently loaded by this manager.
    /// The Session lifecycle remains the only owner of acquisition and release.
    session_write_locks: Arc<DashMap<String, SessionWriteLock>>,

    /// Sub-components
    context_store: Arc<SessionContextStore>,
    prompt_cache_store: Arc<SessionPromptCacheStore>,
    prompt_cache_operation_locks: KeyedAsyncLock,
    token_anchor_store: Arc<TokenAnchorStore>,
    turn_skill_agent_snapshot_store: Arc<TurnSkillAgentSnapshotStore>,
    skill_agent_baseline_override_snapshot_store: Arc<DashMap<String, TurnSkillAgentSnapshot>>,
    /// Session-scoped edit-constraint state. The in-memory copy serves the hot
    /// tool-validation path; the same state is persisted in session metadata so
    /// restore and fork paths preserve both constraints and extraction evidence.
    edit_constraints_store:
        Arc<DashMap<String, crate::agentic::execution::edit_constraint_guard::EditConstraintState>>,
    review_read_receipt_store: Arc<ReviewReadReceiptStore>,
    evidence_ledger: Arc<SessionEvidenceLedger>,
    evidence_ledger_operation_locks: Arc<KeyedAsyncLock>,
    persistence_manager: Arc<PersistenceManager>,
    memory_database: Arc<MemoryDatabase>,

    /// Configuration
    config: SessionManagerConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveTurnPermissionMode {
    pub turn_id: String,
    pub mode: PermissionMode,
}

fn clear_session_runtime_stores(
    session_id: &str,
    context_store: &SessionContextStore,
    prompt_cache_store: &SessionPromptCacheStore,
    token_anchor_store: &TokenAnchorStore,
    turn_skill_agent_snapshot_store: &TurnSkillAgentSnapshotStore,
    skill_agent_baseline_override_snapshot_store: &DashMap<String, TurnSkillAgentSnapshot>,
    review_read_receipt_store: &ReviewReadReceiptStore,
    evidence_ledger: &SessionEvidenceLedger,
) {
    context_store.delete_session(session_id);
    prompt_cache_store.delete_session(session_id);
    token_anchor_store.delete_session(session_id);
    turn_skill_agent_snapshot_store.delete_session(session_id);
    skill_agent_baseline_override_snapshot_store.remove(session_id);
    review_read_receipt_store.delete_session(session_id);
    evidence_ledger.delete_session(session_id);
}

#[derive(Clone)]
struct SessionAutoSaveSnapshot {
    session_id: String,
    updated_at: SystemTime,
    last_activity_at: SystemTime,
    session: Session,
}

#[derive(Clone)]
struct SessionCleanupCandidate {
    session_id: String,
    updated_at: SystemTime,
    last_activity_at: SystemTime,
}

#[derive(Clone, Debug)]
struct SessionStoragePathBinding {
    path: PathBuf,
    pending_claims: usize,
    committed: bool,
}

impl SessionManager {
    async fn lock_session_mutation(&self, session_id: &str) -> KeyedAsyncLockGuard {
        self.session_mutation_locks.lock(session_id).await
    }

    pub(crate) async fn acquire_session_mutation(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<KeyedAsyncLockGuard> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        Ok(self.lock_session_mutation(session_id).await)
    }

    fn reserve_active_session(&self) -> OpenBitFunResult<OwnedSemaphorePermit> {
        self.active_session_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                OpenBitFunError::Validation(format!(
                    "Exceeded maximum session limit: {}",
                    self.config.max_active_sessions
                ))
            })
    }

    fn commit_active_session_reservation(&self, session_id: &str, permit: OwnedSemaphorePermit) {
        let previous = self
            .active_session_permits
            .insert(session_id.to_string(), permit);
        debug_assert!(previous.is_none(), "active session permit already existed");
    }

    fn release_active_session_reservation(&self, session_id: &str) {
        self.active_session_permits.remove(session_id);
    }

    fn try_acquire_session_write_lock(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<SessionWriteLock> {
        self.persistence_manager
            .lock_session_writes(session_storage_path, session_id)
    }

    fn commit_session_write_lock(&self, session_id: &str, write_lock: SessionWriteLock) {
        match self.session_write_locks.entry(session_id.to_string()) {
            Entry::Vacant(entry) => {
                entry.insert(write_lock);
            }
            Entry::Occupied(_) => {
                debug_assert!(false, "Session write lock already existed");
            }
        }
    }

    fn release_session_write_lock(&self, session_id: &str) {
        self.session_write_locks.remove(session_id);
    }

    #[cfg(test)]
    pub(crate) fn evict_loaded_session_for_test(&self, session_id: &str) {
        self.sessions.remove(session_id);
        self.transient_session_ids.remove(session_id);
        self.clear_turn_settlement_results(session_id);
        self.release_active_session_reservation(session_id);
        self.release_session_write_lock(session_id);
    }

    #[cfg(test)]
    pub(crate) fn storage_path_binding_for_test(&self, session_id: &str) -> Option<PathBuf> {
        self.session_storage_path_index
            .get(session_id)
            .map(|binding| binding.path.clone())
    }

    fn normalize_session_storage_path(path: &Path) -> PathBuf {
        dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }

    fn claim_session_storage_path(
        &self,
        session_id: &str,
        requested_path: &Path,
        allow_existing_same_path: bool,
    ) -> OpenBitFunResult<bool> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let requested_path = Self::normalize_session_storage_path(requested_path);
        match self
            .session_storage_path_index
            .entry(session_id.to_string())
        {
            Entry::Vacant(entry) => {
                entry.insert(SessionStoragePathBinding {
                    path: requested_path,
                    pending_claims: 1,
                    committed: false,
                });
                Ok(true)
            }
            Entry::Occupied(mut entry) => {
                let existing_path = Self::normalize_session_storage_path(&entry.get().path);
                if existing_path != requested_path {
                    return Err(OpenBitFunError::Validation(format!(
                        "Session ID is already bound to another workspace: session_id={}, existing_storage_path={}, requested_storage_path={}",
                        session_id,
                        existing_path.display(),
                        requested_path.display()
                    )));
                }
                if !allow_existing_same_path {
                    return Err(OpenBitFunError::Validation(format!(
                        "Session ID already exists: {session_id}"
                    )));
                }
                if entry.get().committed {
                    Ok(false)
                } else {
                    entry.get_mut().pending_claims += 1;
                    Ok(true)
                }
            }
        }
    }

    fn commit_session_storage_path_claim(
        &self,
        session_id: &str,
        requested_path: &Path,
        claimed: bool,
    ) {
        if !claimed {
            return;
        }
        let requested_path = Self::normalize_session_storage_path(requested_path);
        if let Entry::Occupied(mut entry) = self
            .session_storage_path_index
            .entry(session_id.to_string())
        {
            if Self::normalize_session_storage_path(&entry.get().path) == requested_path {
                let binding = entry.get_mut();
                binding.committed = true;
                binding.pending_claims = 0;
            }
        }
    }

    fn release_failed_session_storage_path_claim(
        &self,
        session_id: &str,
        requested_path: &Path,
        claimed: bool,
    ) {
        if !claimed {
            return;
        }
        let requested_path = Self::normalize_session_storage_path(requested_path);
        let session_exists = self.sessions.contains_key(session_id);
        if let Entry::Occupied(mut entry) = self
            .session_storage_path_index
            .entry(session_id.to_string())
        {
            if Self::normalize_session_storage_path(&entry.get().path) != requested_path {
                return;
            }
            if session_exists {
                let binding = entry.get_mut();
                binding.committed = true;
                binding.pending_claims = 0;
                return;
            }
            let binding = entry.get_mut();
            binding.pending_claims = binding.pending_claims.saturating_sub(1);
            if binding.pending_claims == 0 && !binding.committed {
                entry.remove();
            }
        }
    }

    fn bind_session_storage_path_committed(&self, session_id: &str, path: PathBuf) {
        self.session_storage_path_index.insert(
            session_id.to_string(),
            SessionStoragePathBinding {
                path,
                pending_claims: 0,
                committed: true,
            },
        );
    }

    pub(crate) fn ensure_session_storage_path(
        &self,
        session_id: &str,
        requested_path: &Path,
    ) -> OpenBitFunResult<()> {
        let claimed = self.claim_session_storage_path(session_id, requested_path, true)?;
        self.commit_session_storage_path_claim(session_id, requested_path, claimed);
        Ok(())
    }

    pub(crate) fn validate_session_storage_path_binding(
        &self,
        session_id: &str,
        requested_path: &Path,
    ) -> OpenBitFunResult<()> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let requested_path = Self::normalize_session_storage_path(requested_path);
        let Some(binding) = self.session_storage_path_index.get(session_id) else {
            return Ok(());
        };
        let existing_path = Self::normalize_session_storage_path(&binding.path);
        if existing_path != requested_path {
            return Err(OpenBitFunError::Validation(format!(
                "Session ID is already bound to another workspace: session_id={}, existing_storage_path={}, requested_storage_path={}",
                session_id,
                existing_path.display(),
                requested_path.display()
            )));
        }
        Ok(())
    }

    pub(crate) fn is_session_loaded_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        if !self.sessions.contains_key(session_id) {
            return Ok(false);
        }
        self.ensure_session_storage_path(session_id, storage_path)?;
        Ok(true)
    }

    pub(crate) async fn active_turn_id_in_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<String>> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        self.validate_session_storage_path_binding(session_id, storage_path)?;
        Ok(self
            .get_session(session_id)
            .and_then(|session| match session.state {
                SessionState::Processing {
                    current_turn_id, ..
                } => Some(current_turn_id),
                _ => None,
            }))
    }

    pub(crate) async fn load_ai_config_for_model_resolution() -> Option<AIConfig> {
        #[cfg(test)]
        if let Ok(ai_config) = TEST_MODEL_RESOLUTION_AI_CONFIG.try_with(Clone::clone) {
            return Some(ai_config);
        }

        let config_service = get_global_config_service().await.ok()?;
        Self::load_effective_ai_config_from_service(config_service.as_ref()).await
    }

    async fn load_effective_ai_config_from_service(
        config_service: &crate::service::config::ConfigService,
    ) -> Option<AIConfig> {
        config_service.get_effective_ai_config().await.ok()
    }

    pub(crate) async fn resolve_effective_reasoning_preset_for_turn(
        resolved_model_id: &str,
        selected_preset: Option<&str>,
    ) -> OpenBitFunResult<(Option<String>, String)> {
        let ai_config = Self::load_ai_config_for_model_resolution()
            .await
            .ok_or_else(|| {
                OpenBitFunError::AIClient(
                    "AI configuration is unavailable for reasoning preset resolution".to_string(),
                )
            })?;
        Self::resolve_effective_reasoning_preset_from_config(
            &ai_config,
            resolved_model_id,
            selected_preset,
        )
        .await
    }

    async fn resolve_effective_reasoning_preset_from_config(
        ai_config: &AIConfig,
        resolved_model_id: &str,
        selected_preset: Option<&str>,
    ) -> OpenBitFunResult<(Option<String>, String)> {
        let canonical_model_id = ai_config
            .resolve_model_reference(resolved_model_id)
            .ok_or_else(|| {
                OpenBitFunError::AIClient(format!(
                    "Dialog turn model is unavailable for reasoning preset resolution: {resolved_model_id}"
                ))
            })?;
        let model = ai_config
            .models
            .iter()
            .find(|model| model.enabled && model.id == canonical_model_id)
            .ok_or_else(|| {
                OpenBitFunError::AIClient(format!(
                    "Dialog turn model configuration is unavailable: {canonical_model_id}"
                ))
            })?;
        let models_dev = load_models_dev_reasoning_catalog_without_refresh().await;
        let projection = project_model_reasoning_catalog(model, models_dev.catalog.as_deref());
        let preset = match selected_preset
            .map(str::trim)
            .filter(|preset| !preset.is_empty())
        {
            Some(selected_preset) => resolve_reasoning_preset(&projection, selected_preset)
                .ok_or_else(|| {
                    OpenBitFunError::Validation(format!(
                        "Reasoning preset is unavailable for the dialog turn model: {selected_preset}"
                    ))
                })
                .map(Some)?,
            None => resolve_default_reasoning_preset(&projection),
        };
        Ok((
            preset.map(|preset| preset.id.clone()),
            reasoning_preset_runtime_fingerprint(preset),
        ))
    }

    fn context_window_for_model_selection(
        ai_config: &crate::service::config::types::AIConfig,
        model_id: &str,
    ) -> Option<usize> {
        let trimmed = model_id.trim();
        let resolved_model_id = ai_config.resolve_model_selection(trimmed)?;
        ai_config
            .models
            .iter()
            .find(|model| model.id == resolved_model_id)
            .and_then(|model| model.context_window)
            .map(|tokens| tokens as usize)
    }

    fn session_context_window_from_ai_config(
        session: &Session,
        ai_config: &crate::service::config::types::AIConfig,
    ) -> Option<usize> {
        Self::context_window_for_model_selection(
            ai_config,
            effective_session_model_selector(ai_config, session),
        )
    }

    fn sync_session_context_window_from_ai_config(
        session: &mut Session,
        ai_config: &crate::service::config::types::AIConfig,
    ) -> Option<usize> {
        let context_window = Self::session_context_window_from_ai_config(session, ai_config)?;
        session.config.max_context_tokens = context_window;
        Some(context_window)
    }

    async fn normalize_session_reasoning_preset(
        session: &Session,
        ai_config: &crate::service::config::types::AIConfig,
    ) -> Option<String> {
        let Some(preset_id) = session
            .config
            .reasoning_preset
            .as_deref()
            .map(str::trim)
            .filter(|preset_id| !preset_id.is_empty() && !preset_id.eq_ignore_ascii_case("auto"))
        else {
            return None;
        };
        let Some(model) = concrete_model_for_session_selection(ai_config, session) else {
            // Model reconciliation owns unavailable model selectors. Do not
            // erase the preset while the concrete model is unresolved.
            return Some(preset_id.to_string());
        };
        let models_dev = load_models_dev_reasoning_catalog_without_refresh().await;
        normalize_reasoning_preset_for_model(model, models_dev.catalog.as_deref(), Some(preset_id))
    }

    fn normalize_session_title_input(title: &str) -> OpenBitFunResult<String> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(OpenBitFunError::validation(
                "Session title must not be empty".to_string(),
            ));
        }

        Ok(trimmed.to_string())
    }

    fn normalize_whitespace(value: &str) -> String {
        value.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn truncate_chars(value: &str, max_length: usize) -> String {
        value.chars().take(max_length).collect()
    }

    fn fallback_session_title(user_message: &str, max_length: usize) -> String {
        let max_length = max_length.max(1);
        let normalized = Self::normalize_whitespace(user_message);

        if normalized.is_empty() {
            return Self::truncate_chars("New Session", max_length);
        }

        let truncated_chars: Vec<char> = normalized.chars().take(max_length).collect();
        if normalized.chars().count() <= max_length {
            return truncated_chars.iter().collect();
        }

        let sentence_break_chars = ['。', '！', '？', '；', '.', '!', '?'];
        let break_chars = ['。', '！', '？', '；', '.', '!', '?', '，', ',', ' '];
        let min_break_index = max_length / 2;
        let mut best_break_index: Option<usize> = None;

        for (idx, ch) in truncated_chars.iter().enumerate() {
            if break_chars.contains(ch) && idx > min_break_index {
                best_break_index = Some(idx);
            }
        }

        if let Some(idx) = best_break_index {
            let candidate: String = truncated_chars[..=idx].iter().collect();
            if candidate
                .chars()
                .last()
                .map(|ch| sentence_break_chars.contains(&ch))
                .unwrap_or(false)
            {
                return candidate;
            }

            return format!("{}...", candidate.trim_end());
        }

        let truncated: String = truncated_chars.iter().collect();
        format!("{truncated}...")
    }

    fn paginate_messages(
        messages: &[Message],
        limit: usize,
        before_message_id: Option<&str>,
    ) -> (Vec<Message>, bool) {
        if messages.is_empty() {
            return (vec![], false);
        }

        let end_idx = if let Some(before_id) = before_message_id {
            messages.iter().position(|m| m.id == before_id).unwrap_or(0)
        } else {
            messages.len()
        };

        if end_idx == 0 {
            return (vec![], false);
        }

        let start_idx = end_idx.saturating_sub(limit);
        let has_more = start_idx > 0;

        (messages[start_idx..end_idx].to_vec(), has_more)
    }

    fn session_workspace_from_config(config: &SessionConfig) -> Option<PathBuf> {
        config.workspace_path.as_ref().map(PathBuf::from)
    }

    fn should_persist_session_kind(kind: SessionKind) -> bool {
        match kind {
            SessionKind::Standard | SessionKind::Subagent => true,
            SessionKind::EphemeralChild => false,
        }
    }

    fn should_persist_session_with_transient_ids(
        session: &Session,
        transient_session_ids: &DashMap<String, ()>,
    ) -> bool {
        !transient_session_ids.contains_key(&session.session_id)
            && Self::should_persist_session_kind(session.kind)
    }

    fn should_persist_session(&self, session: &Session) -> bool {
        Self::should_persist_session_with_transient_ids(session, &self.transient_session_ids)
    }

    fn same_session_version(
        session: &Session,
        updated_at: SystemTime,
        last_activity_at: SystemTime,
    ) -> bool {
        session.updated_at == updated_at && session.last_activity_at == last_activity_at
    }

    fn collect_auto_save_snapshots(
        sessions: &DashMap<String, Session>,
        transient_session_ids: &DashMap<String, ()>,
    ) -> Vec<SessionAutoSaveSnapshot> {
        sessions
            .iter()
            .filter_map(|entry| {
                let session = entry.value();
                if !Self::should_persist_session_with_transient_ids(session, transient_session_ids)
                {
                    return None;
                }
                Some(SessionAutoSaveSnapshot {
                    session_id: session.session_id.clone(),
                    updated_at: session.updated_at,
                    last_activity_at: session.last_activity_at,
                    session: session.clone(),
                })
            })
            .collect()
    }

    fn auto_save_snapshot_is_current(
        sessions: &DashMap<String, Session>,
        snapshot: &SessionAutoSaveSnapshot,
    ) -> bool {
        sessions
            .get(&snapshot.session_id)
            .map(|session| {
                Self::same_session_version(&session, snapshot.updated_at, snapshot.last_activity_at)
            })
            .unwrap_or(false)
    }

    fn auto_save_interval(interval: Duration) -> time::Interval {
        time::interval_at(time::Instant::now() + interval, interval)
    }

    fn is_session_expired(session: &Session, now: SystemTime, timeout: Duration) -> bool {
        now.duration_since(session.last_activity_at)
            .map(|idle_duration| idle_duration > timeout)
            .unwrap_or(false)
    }

    fn collect_expired_session_candidates(
        sessions: &DashMap<String, Session>,
        transient_session_ids: &DashMap<String, ()>,
        now: SystemTime,
        timeout: Duration,
    ) -> Vec<SessionCleanupCandidate> {
        sessions
            .iter()
            .filter_map(|entry| {
                let session = entry.value();
                // Idle eviction is a restore optimization for durable Sessions.
                // Non-persistent Sessions have an explicit lifecycle owner and
                // no on-disk state from which they could be restored.
                if !matches!(session.state, SessionState::Idle)
                    || !Self::should_persist_session_with_transient_ids(
                        session,
                        transient_session_ids,
                    )
                    || !Self::is_session_expired(session, now, timeout)
                {
                    return None;
                }
                Some(SessionCleanupCandidate {
                    session_id: session.session_id.clone(),
                    updated_at: session.updated_at,
                    last_activity_at: session.last_activity_at,
                })
            })
            .collect()
    }

    fn cleanup_candidate_matches_session(
        session: &Session,
        candidate: &SessionCleanupCandidate,
        now: SystemTime,
        timeout: Duration,
    ) -> bool {
        matches!(session.state, SessionState::Idle)
            && Self::same_session_version(session, candidate.updated_at, candidate.last_activity_at)
            && Self::is_session_expired(session, now, timeout)
    }

    fn cleanup_snapshot_for_candidate(
        sessions: &DashMap<String, Session>,
        candidate: &SessionCleanupCandidate,
        now: SystemTime,
        timeout: Duration,
    ) -> Option<Session> {
        sessions.get(&candidate.session_id).and_then(|session| {
            Self::cleanup_candidate_matches_session(&session, candidate, now, timeout)
                .then(|| session.clone())
        })
    }

    pub fn should_persist_session_id(&self, session_id: &str) -> bool {
        self.config.enable_persistence
            && !self.transient_session_ids.contains_key(session_id)
            && self
                .sessions
                .get(session_id)
                .map(|session| self.should_persist_session(&session))
                .unwrap_or(true)
    }

    pub(crate) fn is_transient_session(&self, session_id: &str) -> bool {
        self.transient_session_ids.contains_key(session_id)
    }

    async fn effective_storage_path_for_config_with_persistence(
        persistence_manager: &PersistenceManager,
        config: &SessionConfig,
    ) -> Option<PathBuf> {
        if let Some(id) = config.workspace_id.as_deref() {
            return CoreSessionStorePort::with_path_manager(
                persistence_manager.path_manager().clone(),
            )
            .resolve_workspace_storage(id)
            .await
            .ok()
            .map(|resolution| resolution.effective_storage_path);
        }
        let workspace_path = config.workspace_path.as_ref()?;
        let identity =
            crate::service::remote_ssh::workspace_state::resolve_workspace_session_identity(
                workspace_path,
                config.remote_connection_id.as_deref(),
                config.remote_ssh_host.as_deref(),
            )
            .await?;

        let runtime_service = persistence_manager.runtime_service();
        Some(if !identity.is_remote() {
            let project_workspace_path = config
                .project_workspace_path
                .as_deref()
                .unwrap_or_else(|| identity.logical_workspace_path());
            runtime_service
                .context_for_local_workspace(Path::new(project_workspace_path))
                .sessions_dir
        } else if identity.hostname == "_unresolved" {
            openbitfun_services_core::workspace_identity::unresolved_remote_session_storage_dir(
                runtime_service.path_manager().remote_ssh_mirror_root_dir(),
                identity.remote_connection_id.as_deref().unwrap_or_default(),
                identity.logical_workspace_path(),
            )
        } else {
            runtime_service
                .context_for_remote_workspace(&identity.hostname, identity.logical_workspace_path())
                .sessions_dir
        })
    }

    async fn effective_storage_path_for_config(&self, config: &SessionConfig) -> Option<PathBuf> {
        Self::effective_storage_path_for_config_with_persistence(
            self.persistence_manager.as_ref(),
            config,
        )
        .await
    }

    async fn effective_storage_path_for_workspace_path(&self, workspace_path: &Path) -> PathBuf {
        if self
            .persistence_manager
            .is_resolved_sessions_dir(workspace_path)
        {
            return workspace_path.to_path_buf();
        }
        let tmp_config = SessionConfig {
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            ..Default::default()
        };
        self.effective_storage_path_for_config(&tmp_config)
            .await
            .unwrap_or_else(|| workspace_path.to_path_buf())
    }

    pub(crate) async fn resolve_storage_path_for_workspace_path(
        &self,
        workspace_path: &Path,
    ) -> PathBuf {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self
            .effective_storage_path_for_workspace_path(workspace_path)
            .await;
        debug!(
            "Session storage path resolved from workspace: workspace_path={}, session_storage_path={}, duration_ms={}",
            workspace_path.display(),
            session_storage_path.display(),
            elapsed_ms_u64(storage_path_started_at)
        );
        session_storage_path
    }

    async fn resolve_storage_path_for_restore_workspace_path(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<PathBuf> {
        if self
            .persistence_manager
            .is_resolved_sessions_dir(workspace_path)
        {
            return Err(OpenBitFunError::Validation(format!(
                "Expected a workspace path, received a resolved sessions directory: {}",
                workspace_path.display()
            )));
        }
        Ok(self
            .resolve_storage_path_for_workspace_path(workspace_path)
            .await)
    }

    async fn resolve_storage_path_for_request(
        &self,
        request: SessionStoragePathRequest,
    ) -> OpenBitFunResult<PathBuf> {
        let storage_path_started_at = Instant::now();
        let requested_workspace_path = request.workspace_path.clone();
        let session_storage_path = CoreSessionStorePort::with_path_manager(
            self.persistence_manager.path_manager().clone(),
        )
        .resolve_session_storage_path(request)
        .await
        .map(|resolution| resolution.effective_storage_path)
        .map_err(|error| OpenBitFunError::Session(error.to_string()))?;
        debug!(
            "Session storage path resolved from workspace request: workspace_path={}, session_storage_path={}, duration_ms={}",
            requested_workspace_path.display(),
            session_storage_path.display(),
            elapsed_ms_u64(storage_path_started_at)
        );
        Ok(session_storage_path)
    }

    #[allow(dead_code)]
    fn session_workspace_path(&self, session_id: &str) -> Option<PathBuf> {
        self.sessions
            .get(session_id)
            .and_then(|session| Self::session_workspace_from_config(&session.config))
    }

    /// Resolve the effective storage path for a session by ID.
    /// For remote workspaces, maps the remote path to a local session storage path.
    pub(crate) async fn effective_session_storage_path(&self, session_id: &str) -> Option<PathBuf> {
        let config = self.sessions.get(session_id)?.config.clone();
        self.effective_storage_path_for_config(&config).await
    }

    pub(crate) fn path_manager(&self) -> Arc<crate::infrastructure::PathManager> {
        self.persistence_manager.path_manager().clone()
    }

    pub(crate) async fn load_related_dialog_turn(
        &self,
        parent_session_id: &str,
        related_session_id: &str,
        dialog_turn_id: &str,
    ) -> OpenBitFunResult<Option<DialogTurnData>> {
        let storage_path = self
            .effective_session_storage_path(parent_session_id)
            .await
            .or_else(|| {
                self.session_storage_path_index
                    .get(parent_session_id)
                    .map(|entry| entry.value().path.clone())
            })
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session storage path not found: {parent_session_id}"
                ))
            })?;
        let _related_history_read = self.acquire_session_mutation(related_session_id).await?;
        Ok(self
            .persistence_manager
            .load_visible_session_turns(&storage_path, related_session_id)
            .await?
            .into_iter()
            .find(|turn| turn.turn_id == dialog_turn_id))
    }

    pub async fn create_compression_transcript_reference(
        &self,
        session_id: &str,
        boundary_turn_index: usize,
        compression_id: &str,
        trigger: &str,
    ) -> OpenBitFunResult<Option<CompressionTranscriptReference>> {
        if !self.should_persist_session_id(session_id) {
            return Ok(None);
        }
        let storage_path = self
            .effective_session_storage_path(session_id)
            .await
            .or_else(|| {
                self.session_storage_path_index
                    .get(session_id)
                    .map(|entry| entry.value().path.clone())
            })
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session storage path is unavailable: {}",
                    session_id
                ))
            })?;
        let artifact = self
            .persistence_manager
            .create_compression_transcript(
                &storage_path,
                session_id,
                boundary_turn_index,
                compression_id,
                trigger,
            )
            .await?;
        if let Some(artifact) = artifact {
            debug!(
                "Created compression transcript: session_id={}, boundary_turn_index={}, transcript_path={}, meta_path={}",
                session_id,
                boundary_turn_index,
                artifact.transcript_path.display(),
                artifact.meta_path.display()
            );
            Ok(Some(CompressionTranscriptReference {
                uri: artifact.uri,
                index_range: artifact.index_range,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn persistent_model_exchange_trace_dir(&self, session_id: &str) -> Option<PathBuf> {
        if !self.should_persist_session_id(session_id) {
            return None;
        }

        let storage_path = self
            .effective_session_storage_path(session_id)
            .await
            .or_else(|| {
                self.session_storage_path_index
                    .get(session_id)
                    .map(|entry| entry.value().path.clone())
            })?;

        Some(SessionStorageLayout::new(storage_path).request_traces_dir(session_id))
    }

    /// Materialize a bounded transcript copy for a user-selected reference.
    /// The referenced session is only read by the backend; the generated file
    /// is written beneath the current session's artifacts so normal Read/Grep
    /// tools cannot traverse into another session's storage.
    pub async fn materialize_session_reference_transcript(
        &self,
        source_session_id: &str,
        reference: &SessionReferenceLocator,
        reference_artifact_stem: &str,
    ) -> OpenBitFunResult<MaterializedSessionReference> {
        openbitfun_core_types::validate_session_id(source_session_id)
            .map_err(OpenBitFunError::Validation)?;
        openbitfun_core_types::validate_session_id(&reference.session_id)
            .map_err(OpenBitFunError::Validation)?;
        openbitfun_core_types::validate_session_id(reference_artifact_stem)
            .map_err(OpenBitFunError::Validation)?;
        let workspace_id = reference
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let workspace_path = reference.workspace_path.trim();
        if workspace_id.is_none() && workspace_path.is_empty() {
            return Err(OpenBitFunError::Validation(
                "Referenced session workspace_id is required".to_string(),
            ));
        }

        let source_storage_path = self
            .effective_session_storage_path(source_session_id)
            .await
            .or_else(|| {
                self.session_storage_path_index
                    .get(source_session_id)
                    .map(|entry| entry.value().path.clone())
            })
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Current session storage path is unavailable: {}",
                    source_session_id
                ))
            })?;
        let reference_storage_path = CoreSessionStorePort::with_path_manager(
            self.persistence_manager.path_manager().clone(),
        )
        .resolve_storage_for_reference(
            workspace_id,
            workspace_path,
            reference.remote_connection_id.clone(),
            reference.remote_ssh_host.clone(),
        )
        .await
        .map(|resolution| resolution.effective_storage_path)
        .map_err(|error| OpenBitFunError::Session(error.to_string()))?;

        if source_session_id == reference.session_id
            && source_storage_path == reference_storage_path
        {
            return Err(OpenBitFunError::Validation(
                "A session cannot reference itself".to_string(),
            ));
        }

        let metadata = self
            .persistence_manager
            .load_session_metadata(&reference_storage_path, &reference.session_id)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Referenced session not found: {}",
                    reference.session_id
                ))
            })?;
        if metadata.status == SessionStatus::Archived {
            return Err(OpenBitFunError::Validation(format!(
                "Referenced session is archived: {}",
                reference.session_id
            )));
        }
        if !matches!(metadata.session_kind, SessionKind::Standard) {
            return Err(OpenBitFunError::Validation(format!(
                "Referenced session is not a visible top-level session: {}",
                reference.session_id
            )));
        }
        if self
            .get_session(&reference.session_id)
            .is_some_and(|session| matches!(session.state, SessionState::Processing { .. }))
        {
            return Err(OpenBitFunError::Validation(format!(
                "Referenced session is busy: {}",
                reference.session_id
            )));
        }

        let _reference_history_read = self.acquire_session_mutation(&reference.session_id).await?;

        let transcript = self
            .persistence_manager
            .materialize_session_reference_transcript(
                &source_storage_path,
                source_session_id,
                &reference_storage_path,
                &reference.session_id,
                reference_artifact_stem,
            )
            .await?;
        Ok(MaterializedSessionReference {
            session_id: reference.session_id.clone(),
            session_name: metadata.session_name,
            transcript,
        })
    }

    pub async fn resolve_session_workspace_binding(
        &self,
        session_id: &str,
    ) -> Option<WorkspaceBinding> {
        if let Some(config) = self
            .get_session(session_id)
            .map(|session| session.config.clone())
        {
            if let Some(binding) = ConversationCoordinator::build_workspace_binding(&config).await {
                return Some(binding);
            }
        }

        let indexed_storage_path = self
            .session_storage_path_index
            .get(session_id)
            .map(|entry| entry.value().path.clone());
        if let Some(session_storage_path) = indexed_storage_path {
            if let Some(binding) = self
                .resolve_persisted_session_workspace_binding(
                    session_id,
                    &session_storage_path,
                    None,
                )
                .await
            {
                return Some(binding);
            }
        }

        for workspace in self.tracked_workspace_candidates().await? {
            let Some(session_storage_path) =
                Self::session_storage_path_for_workspace_info(&workspace).await
            else {
                continue;
            };

            if let Some(binding) = self
                .resolve_persisted_session_workspace_binding(
                    session_id,
                    &session_storage_path,
                    Some(&workspace),
                )
                .await
            {
                if let Err(error) =
                    self.ensure_session_storage_path(session_id, &session_storage_path)
                {
                    debug!(
                        "Ignoring conflicting persisted session workspace binding: session_id={}, storage_path={}, error={}",
                        session_id,
                        session_storage_path.display(),
                        error
                    );
                    continue;
                }
                return Some(binding);
            }
        }

        None
    }

    async fn resolve_persisted_session_workspace_binding(
        &self,
        session_id: &str,
        session_storage_path: &Path,
        workspace_hint: Option<&WorkspaceInfo>,
    ) -> Option<WorkspaceBinding> {
        let metadata = match self
            .persistence_manager
            .load_session_metadata(session_storage_path, session_id)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => return None,
            Err(err) => {
                debug!(
                    "Failed to load session metadata while resolving workspace binding: session_id={} storage_path={} error={}",
                    session_id,
                    session_storage_path.display(),
                    err
                );
                return None;
            }
        };

        let config = self
            .session_config_from_persisted_metadata(&metadata, workspace_hint)
            .await?;

        ConversationCoordinator::build_workspace_binding(&config).await
    }

    async fn session_config_from_persisted_metadata(
        &self,
        metadata: &SessionMetadata,
        workspace_hint: Option<&WorkspaceInfo>,
    ) -> Option<SessionConfig> {
        let mut config = SessionConfig {
            workspace_id: metadata
                .workspace_id
                .clone()
                .or_else(|| workspace_hint.map(|record| record.id.clone())),
            project_workspace_id: metadata.project_workspace_id.clone(),
            workspace_path: metadata.workspace_path.clone().or_else(|| {
                workspace_hint.map(|record| record.root_path.to_string_lossy().into_owned())
            }),
            project_workspace_path: metadata.project_workspace_path.clone(),
            execution_target: metadata.execution_target.clone(),
            remote_ssh_host: metadata.workspace_hostname.clone(),
            ..SessionConfig::default()
        };
        crate::agentic::workspace::normalize_session_workspace(&mut config)
            .await
            .ok()?;
        Some(config)
    }

    async fn tracked_workspace_candidates(&self) -> Option<Vec<WorkspaceInfo>> {
        let workspace_service = get_global_workspace_service()?;
        let mut workspaces = workspace_service.list_workspace_infos().await;
        workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.last_accessed));
        Some(workspaces)
    }

    async fn session_storage_path_for_workspace_info(workspace: &WorkspaceInfo) -> Option<PathBuf> {
        CoreSessionStorePort::default()
            .resolve_workspace_storage(&workspace.id)
            .await
            .ok()
            .map(|resolution| resolution.effective_storage_path)
    }

    fn build_messages_from_turns(turns: &[DialogTurnData]) -> Vec<Message> {
        let mut messages = Vec::new();

        for turn in turns {
            if !turn.kind.is_model_visible() {
                continue;
            }

            let user_message = if let Some(metadata) = &turn.user_message.metadata {
                let images = metadata
                    .get("images")
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .map(|value| ImageContextData {
                                id: value
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                                image_path: value
                                    .get("image_path")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                data_url: value
                                    .get("data_url")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                mime_type: value
                                    .get("mime_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("image/png")
                                    .to_string(),
                                metadata: Some(value.clone()),
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                if images.is_empty() {
                    Message::user(turn.user_message.content.clone())
                } else {
                    Message::user_multimodal(turn.user_message.content.clone(), images)
                }
            } else {
                Message::user(turn.user_message.content.clone())
            };
            messages.push(
                user_message
                    .with_turn_id(turn.turn_id.clone())
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput),
            );

            let assistant_text = turn
                .model_rounds
                .iter()
                .flat_map(|round| round.text_items.iter())
                .map(|item| item.content.clone())
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");

            let assistant_thinking = turn
                .model_rounds
                .iter()
                .flat_map(|round| round.thinking_items.iter())
                .map(|item| item.content.clone())
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");

            let has_text = !assistant_text.trim().is_empty();
            let has_thinking = !assistant_thinking.trim().is_empty();

            if has_text || has_thinking {
                let reasoning_content = if has_thinking {
                    Some(assistant_thinking)
                } else {
                    None
                };
                messages.push(
                    Message::assistant_with_reasoning(
                        reasoning_content,
                        assistant_text,
                        Vec::new(),
                    )
                    .with_turn_id(turn.turn_id.clone()),
                );
            }
        }

        messages
    }

    async fn rebuild_messages_from_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<Message>> {
        let turns = self
            .persistence_manager
            .load_visible_session_turns(workspace_path, session_id)
            .await?;
        Ok(Self::build_messages_from_turns(&turns))
    }

    /// Persist the current runtime context by overwriting `snapshots/context-{turn_index}.json`.
    ///
    /// Save timing is intentionally tied to semantic context changes rather than token chunks:
    /// - after a turn starts and the user message enters runtime context
    /// - after assistant/tool messages are appended to runtime context
    /// - after compression replaces runtime context
    /// - once more when a turn completes or fails
    ///
    /// This is still a best-effort multi-file persistence flow, not a transactional commit.
    /// `session.json`, `turns/turn-*.json`, and `snapshots/context-*.json` may be briefly out of
    /// sync if the process crashes between writes, so restore logic must tolerate partial updates.
    async fn persist_context_snapshot_for_turn_best_effort(
        &self,
        session_id: &str,
        turn_index: usize,
        reason: &str,
    ) {
        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping context snapshot persistence because workspace path is unavailable: session_id={}, turn_index={}, reason={}",
                session_id, turn_index, reason
            );
            return;
        };

        let context_messages = self.context_store.get_context_messages(session_id);
        if let Err(err) = self
            .persistence_manager
            .save_turn_context_snapshot(&workspace_path, session_id, turn_index, &context_messages)
            .await
        {
            warn!(
                "failed to persist context snapshot: session_id={}, turn_index={}, reason={}, err={}",
                session_id, turn_index, reason, err
            );
        }
    }

    async fn persist_current_turn_context_snapshot_best_effort(
        &self,
        session_id: &str,
        reason: &str,
    ) {
        let Some(turn_index) = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.len().checked_sub(1))
        else {
            debug!(
                "Skipping current-turn context snapshot because no turn is active: session_id={}, reason={}",
                session_id, reason
            );
            return;
        };

        self.persist_context_snapshot_for_turn_best_effort(session_id, turn_index, reason)
            .await;
    }

    async fn ensure_prompt_cache_loaded(&self, session_id: &str) {
        if self.prompt_cache_store.has_session(session_id) {
            return;
        }
        let _operation_guard = self.prompt_cache_operation_locks.lock(session_id).await;
        if self.prompt_cache_store.has_session(session_id) {
            return;
        }

        let cache = if self.should_persist_session_id(session_id) {
            match self.effective_session_storage_path(session_id).await {
                Some(workspace_path) => {
                    match self
                        .load_prompt_cache_from_persistence(&workspace_path, session_id)
                        .await
                    {
                        Ok(Some(cache)) => cache,
                        Ok(None) => SessionPromptCache::default(),
                        Err(error) => {
                            warn!(
                                "Failed to load prompt cache: session_id={}, workspace_path={}, error={}",
                                session_id,
                                workspace_path.display(),
                                error
                            );
                            SessionPromptCache::default()
                        }
                    }
                }
                None => SessionPromptCache::default(),
            }
        } else {
            SessionPromptCache::default()
        };

        self.prompt_cache_store.replace_cache(session_id, cache);
    }

    async fn load_turn_skill_agent_snapshot_from_persistence(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
    ) -> OpenBitFunResult<Option<TurnSkillAgentSnapshot>> {
        self.persistence_manager
            .load_turn_skill_agent_snapshot(workspace_path, session_id, turn_index)
            .await
    }

    async fn load_prompt_cache_from_persistence(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionPromptCache>> {
        let cache = match self
            .persistence_manager
            .load_prompt_cache(workspace_path, session_id)
            .await?
        {
            Some(cache) => cache,
            None => return Ok(None),
        };

        let decision =
            reconcile_prompt_cache_restore(cache, self.config.prompt_cache_policy.persistence_ttl);
        match &decision {
            PromptCacheRestoreDecision::DeleteExpired => {
                self.persistence_manager
                    .delete_prompt_cache(workspace_path, session_id)
                    .await?;
            }
            PromptCacheRestoreDecision::SavePruned(cache) => {
                self.persistence_manager
                    .save_prompt_cache(workspace_path, session_id, cache)
                    .await?;
            }
            PromptCacheRestoreDecision::Keep(_) => {}
        }
        Ok(decision.into_cache())
    }

    async fn persist_prompt_cache_best_effort(&self, session_id: &str, reason: &str) {
        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping prompt cache persistence because workspace path is unavailable: session_id={}, reason={}",
                session_id, reason
            );
            return;
        };
        let _operation_guard = self.prompt_cache_operation_locks.lock(session_id).await;

        let cache = self
            .prompt_cache_store
            .get_cache(session_id)
            .unwrap_or_default();

        let persist_result = match prompt_cache_persist_action(&cache) {
            PromptCachePersistenceWriteAction::Delete => {
                self.persistence_manager
                    .delete_prompt_cache(&workspace_path, session_id)
                    .await
            }
            PromptCachePersistenceWriteAction::Save => {
                self.persistence_manager
                    .save_prompt_cache(&workspace_path, session_id, &cache)
                    .await
            }
        };

        if let Err(error) = persist_result {
            warn!(
                "Failed to persist prompt cache: session_id={}, workspace_path={}, reason={}, error={}",
                session_id,
                workspace_path.display(),
                reason,
                error
            );
        }
    }

    async fn ensure_token_anchors_loaded(&self, session_id: &str) {
        if self.token_anchor_store.has_session(session_id) {
            return;
        }

        let anchors = if self.should_persist_session_id(session_id) {
            match self.effective_session_storage_path(session_id).await {
                Some(workspace_path) => match self
                    .persistence_manager
                    .load_token_anchors(&workspace_path, session_id)
                    .await
                {
                    Ok(Some(anchors)) => anchors,
                    Ok(None) => Vec::new(),
                    Err(error) => {
                        warn!(
                            "Failed to load token anchors: session_id={}, workspace_path={}, error={}",
                            session_id,
                            workspace_path.display(),
                            error
                        );
                        Vec::new()
                    }
                },
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };

        if let Some(stats) = self.token_anchor_store.replace_session(session_id, anchors) {
            debug!(
                "Token anchor retention pruned loaded anchors: session_id={}, before={}, after={}, removed={}, recent_limit={}, retained_recent={}, retained_turn_boundaries={}",
                session_id,
                stats.before,
                stats.after,
                stats.removed,
                stats.recent_limit,
                stats.retained_recent,
                stats.retained_turn_boundaries
            );
        }
    }

    async fn persist_token_anchors_best_effort(&self, session_id: &str, reason: &str) {
        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping token anchor persistence because workspace path is unavailable: session_id={}, reason={}",
                session_id, reason
            );
            return;
        };

        let anchors = self.token_anchor_store.anchors(session_id);
        let persist_result = if anchors.is_empty() {
            self.persistence_manager
                .delete_token_anchors(&workspace_path, session_id)
                .await
        } else {
            self.persistence_manager
                .save_token_anchors(&workspace_path, session_id, &anchors)
                .await
        };

        if let Err(error) = persist_result {
            warn!(
                "Failed to persist token anchors: session_id={}, workspace_path={}, reason={}, error={}",
                session_id,
                workspace_path.display(),
                reason,
                error
            );
        }
    }

    pub async fn remember_token_anchor(&self, anchor: TokenAnchor) {
        let session_id = anchor.session_id.clone();
        self.ensure_token_anchors_loaded(&session_id).await;
        if let Some(stats) = self.token_anchor_store.append(anchor) {
            debug!(
                "Token anchor retention pruned anchors: session_id={}, before={}, after={}, removed={}, recent_limit={}, retained_recent={}, retained_turn_boundaries={}",
                session_id,
                stats.before,
                stats.after,
                stats.removed,
                stats.recent_limit,
                stats.retained_recent,
                stats.retained_turn_boundaries
            );
        }
        self.persist_token_anchors_best_effort(&session_id, "token_anchor_recorded")
            .await;
    }

    pub async fn latest_matching_token_anchor(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Option<TokenAnchor> {
        self.select_latest_matching_token_anchor(session_id, messages)
            .await
            .selected
    }

    pub async fn select_latest_matching_token_anchor(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> TokenAnchorSelection {
        self.ensure_token_anchors_loaded(session_id).await;
        self.token_anchor_store
            .select_latest_matching(session_id, messages)
    }

    pub async fn prune_token_anchors_to_messages(&self, session_id: &str, messages: &[Message]) {
        self.ensure_token_anchors_loaded(session_id).await;
        self.token_anchor_store
            .remove_non_matching(session_id, messages);
        self.persist_token_anchors_best_effort(session_id, "token_anchor_pruned")
            .await;
    }

    pub fn new(
        context_store: Arc<SessionContextStore>,
        persistence_manager: Arc<PersistenceManager>,
        config: SessionManagerConfig,
    ) -> Self {
        let enable_persistence = config.enable_persistence;
        let memory_database = Arc::new(MemoryDatabase::new(
            persistence_manager.path_manager().clone(),
        ));

        let manager = Self {
            sessions: Arc::new(DashMap::new()),
            active_turn_permission_modes: Arc::new(DashMap::new()),
            transient_session_ids: Arc::new(DashMap::new()),
            turn_settlement_results: Arc::new(DashMap::new()),
            turn_settlement_result_order: Arc::new(Mutex::new(VecDeque::new())),
            active_session_capacity: Arc::new(Semaphore::new(config.max_active_sessions)),
            active_session_permits: Arc::new(DashMap::new()),
            session_storage_path_index: Arc::new(DashMap::new()),
            session_mutation_locks: KeyedAsyncLock::default(),
            session_write_locks: Arc::new(DashMap::new()),
            context_store,
            prompt_cache_store: Arc::new(SessionPromptCacheStore::new()),
            prompt_cache_operation_locks: KeyedAsyncLock::default(),
            token_anchor_store: Arc::new(TokenAnchorStore::new()),
            turn_skill_agent_snapshot_store: Arc::new(TurnSkillAgentSnapshotStore::new()),
            skill_agent_baseline_override_snapshot_store: Arc::new(DashMap::new()),
            edit_constraints_store: Arc::new(DashMap::new()),
            review_read_receipt_store: Arc::new(ReviewReadReceiptStore::new()),
            evidence_ledger: Arc::new(SessionEvidenceLedger::new()),
            evidence_ledger_operation_locks: Arc::new(KeyedAsyncLock::default()),
            persistence_manager,
            memory_database,
            config,
        };

        // Start background tasks
        if enable_persistence {
            manager.spawn_auto_save_task();
        }
        manager.spawn_cleanup_task();
        manager.spawn_model_reconciliation_listener();

        manager
    }

    pub(crate) fn persistence_manager(&self) -> Arc<PersistenceManager> {
        self.persistence_manager.clone()
    }

    pub(crate) fn record_turn_settlement_result(
        &self,
        session_id: &str,
        turn_id: &str,
        result: AgentTurnSettlementResult,
    ) {
        const MAX_RECENT_TURN_SETTLEMENT_RESULTS: usize = 1_024;
        let key = (session_id.to_string(), turn_id.to_string());
        let mut order = self
            .turn_settlement_result_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.retain(|existing| existing != &key);
        self.turn_settlement_results.insert(key.clone(), result);
        order.push_back(key);
        while order.len() > MAX_RECENT_TURN_SETTLEMENT_RESULTS {
            if let Some(oldest) = order.pop_front() {
                self.turn_settlement_results.remove(&oldest);
            }
        }
    }

    pub(crate) fn turn_settlement_result(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Option<AgentTurnSettlementResult> {
        self.turn_settlement_results
            .get(&(session_id.to_string(), turn_id.to_string()))
            .map(|entry| entry.value().clone())
    }

    fn clear_turn_settlement_results(&self, session_id: &str) {
        let mut order = self
            .turn_settlement_result_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.retain(|key| {
            if key.0 != session_id {
                return true;
            }
            self.turn_settlement_results.remove(key);
            false
        });
    }

    fn clear_turn_settlement_result(&self, session_id: &str, turn_id: &str) {
        let key = (session_id.to_string(), turn_id.to_string());
        let mut order = self
            .turn_settlement_result_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.retain(|existing| existing != &key);
        self.turn_settlement_results.remove(&key);
    }

    pub async fn append_evidence_event(
        &self,
        event: EvidenceLedgerEvent,
    ) -> OpenBitFunResult<EvidenceLedgerEvent> {
        let _mutation_guard = self.lock_session_mutation(&event.session_id).await;
        let _operation_guard = self
            .evidence_ledger_operation_locks
            .lock(&event.session_id)
            .await;
        let should_persist = self.config.enable_persistence
            && self
                .sessions
                .get(&event.session_id)
                .is_some_and(|session| self.should_persist_session(&session));
        if !should_persist {
            return Ok(self.evidence_ledger.append(event));
        }

        let storage_path = self
            .effective_session_storage_path(&event.session_id)
            .await
            .or_else(|| {
                self.session_storage_path_index
                    .get(&event.session_id)
                    .map(|entry| entry.value().path.clone())
            })
            .ok_or_else(|| {
                OpenBitFunError::session(format!(
                    "Session storage path unavailable while persisting evidence: {}",
                    event.session_id
                ))
            })?;
        let persisted_events = self
            .persistence_manager
            .append_evidence_ledger_event(&storage_path, &event)
            .await?;
        // Project the persisted events to the session's currently visible
        // turns before publishing to memory. This prevents stale evidence
        // (from a sidecar that has not yet been converged, e.g. after an
        // older build rewrote session history) from re-entering the runtime.
        let visible_events = {
            let visible_turn_ids = self
                .sessions
                .get(&event.session_id)
                .map(|session| {
                    session
                        .dialog_turn_ids
                        .iter()
                        .cloned()
                        .collect::<std::collections::HashSet<String>>()
                })
                .unwrap_or_default();
            if visible_turn_ids.is_empty() {
                persisted_events
            } else {
                persisted_events
                    .into_iter()
                    .filter(|e| visible_turn_ids.contains(&e.turn_id))
                    .collect::<Vec<_>>()
            }
        };
        self.evidence_ledger
            .replace_session(&event.session_id, visible_events)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
        Ok(event)
    }

    /// Callers must hold the Session mutation boundary. The evidence operation
    /// lock serializes this retention with evidence appends and restores.
    ///
    /// `prune_persisted_sidecar` must only be true for permanent history
    /// truncations. Staged undo/redo keeps the sidecar complete so a later
    /// redo can restore hidden evidence; committing the revert or performing a
    /// legacy rollback permanently discards the hidden suffix, so those paths
    /// prune the sidecar as well.
    async fn retain_evidence_events_locked(
        &self,
        session_storage_path: Option<&Path>,
        session_id: &str,
        surviving_turn_ids: &HashSet<String>,
        prune_persisted_sidecar: bool,
    ) -> OpenBitFunResult<()> {
        let _operation_guard = self.evidence_ledger_operation_locks.lock(session_id).await;
        let storage_path = session_storage_path.ok_or_else(|| {
            OpenBitFunError::session(format!(
                "Session storage path unavailable while retaining evidence: {}",
                session_id
            ))
        })?;
        if prune_persisted_sidecar {
            let mut retained = Vec::new();
            if let Some(events) = self
                .persistence_manager
                .retain_evidence_ledger_events(storage_path, session_id, surviving_turn_ids)
                .await?
            {
                retained = events;
            }
            self.evidence_ledger
                .replace_session(session_id, retained)
                .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
            return Ok(());
        }
        // Staged undo/redo only changes what this runtime can see. Rebuild
        // memory from the untouched sidecar so redo can reveal hidden evidence
        // without losing it from disk.
        let sidecar_events = self
            .persistence_manager
            .load_evidence_ledger_events(storage_path, session_id)
            .await?;
        let retained = sidecar_events
            .into_iter()
            .filter(|event| surviving_turn_ids.contains(&event.turn_id))
            .collect::<Vec<_>>();
        self.evidence_ledger
            .replace_session(session_id, retained)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;
        Ok(())
    }

    pub async fn record_checkpoint_created(
        &self,
        session_id: &str,
        turn_id: &str,
        tool_name: &str,
        target: &str,
        checkpoint: EvidenceLedgerCheckpoint,
    ) -> OpenBitFunResult<EvidenceLedgerEvent> {
        self.append_evidence_event(EvidenceLedgerEvent::checkpoint_created(
            session_id, turn_id, tool_name, target, checkpoint,
        ))
        .await
    }

    pub fn evidence_events_for_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Vec<EvidenceLedgerEvent> {
        self.evidence_ledger.events_for_turn(session_id, turn_id)
    }

    pub fn evidence_summary_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> EvidenceLedgerSummary {
        self.evidence_ledger.summary_for_session(session_id, limit)
    }

    pub fn compression_contract_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Option<CompressionContract> {
        let contract: CompressionContract =
            self.evidence_summary_for_session(session_id, limit).into();
        (!contract.is_empty()).then_some(contract)
    }

    pub async fn record_subagent_partial_timeout(
        &self,
        session_id: &str,
        turn_id: &str,
        subagent_type: &str,
        partial_output: &str,
        error_kind: Option<&str>,
    ) -> OpenBitFunResult<EvidenceLedgerEvent> {
        let summary = format!(
            "Subagent {} timed out after producing partial output.",
            subagent_type
        );
        let event = EvidenceLedgerEvent::new(
            session_id,
            turn_id,
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            subagent_type,
            EvidenceLedgerEventStatus::PartialTimeout,
            summary,
        )
        .with_error_kind(error_kind.unwrap_or("timeout"))
        .with_partial_output(partial_output);

        self.append_evidence_event(event).await
    }

    /// Decide whether the given session model id is still usable.
    ///
    /// `model_id` is treated as "usable" when:
    /// - it is a special selector (`primary` / `fast` /
    ///   empty) — these are evaluated again at request time against
    ///   `default_models`, so their long-term validity is governed elsewhere;
    /// - it resolves to a model that exists AND is enabled.
    fn is_session_model_id_usable(
        ai_config: &crate::service::config::types::AIConfig,
        model_id: &str,
    ) -> bool {
        let trimmed = model_id.trim();
        if trimmed.is_empty() || trimmed == "primary" || trimmed == "fast" {
            return true;
        }
        ai_config.is_model_reference_active(trimmed)
    }

    /// Reset every active mutable session whose bound model was invalidated to
    /// the configured primary selector. Persists the change and emits a model
    /// fallback event so surfaces can refresh their session-owned selection.
    async fn apply_fallback_to_invalidated_session_models(
        &self,
        invalidated_model_ids: &[String],
        reason: &'static str,
    ) {
        if invalidated_model_ids.is_empty() {
            return;
        }
        let invalid: HashSet<&str> = invalidated_model_ids.iter().map(String::as_str).collect();

        // Snapshot affected sessions first to avoid holding DashMap iterators
        // across async writes.
        let affected: Vec<(String, String)> = self
            .sessions
            .iter()
            .filter_map(|entry| {
                let session = entry.value();
                let current = session.config.model_id.as_deref()?.trim().to_string();
                // External generations pin the model that the user approved.
                // If that model disappears, execution must fail closed instead
                // of silently changing the approved behavior.
                if should_apply_session_model_fallback(
                    session.config.model_binding_policy,
                    current.as_str(),
                    &invalid,
                ) {
                    Some((session.session_id.clone(), current))
                } else {
                    None
                }
            })
            .collect();

        if affected.is_empty() {
            return;
        }

        for (session_id, previous_model_id) in affected {
            if let Err(e) = self.update_session_model_id(&session_id, "primary").await {
                warn!(
                    "Failed to apply session model fallback after reconcile: session_id={}, previous={}, error={}",
                    session_id, previous_model_id, e
                );
                continue;
            }
            info!(
                "Session model fell back to primary: session_id={}, previous_model_id={}, reason={}",
                session_id, previous_model_id, reason
            );

            if let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() {
                coordinator
                    .emit_session_model_fallback_applied(
                        &session_id,
                        &previous_model_id,
                        "primary",
                        reason,
                    )
                    .await;
            }
        }
    }

    async fn reconcile_session_reasoning_preset_locked(
        &self,
        session_id: &str,
        ai_config: &crate::service::config::types::AIConfig,
        reason: &'static str,
    ) -> OpenBitFunResult<Option<String>> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let Some(original_session) = self.sessions.get(session_id).map(|value| value.clone())
        else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        };
        let Some(previous_preset_id) = original_session.config.reasoning_preset.clone() else {
            return Ok(None);
        };
        let normalized =
            Self::normalize_session_reasoning_preset(&original_session, ai_config).await;
        if normalized.is_some() {
            return Ok(normalized);
        }

        let mut updated_session = original_session.clone();
        updated_session.config.reasoning_preset = None;
        let now = SystemTime::now();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;
        if self.config.enable_persistence && self.should_persist_session(&original_session) {
            let workspace_path = self
                .effective_session_storage_path(session_id)
                .await
                .ok_or_else(|| {
                    OpenBitFunError::session(format!(
                        "Session storage path unavailable while clearing reasoning preset: {session_id}"
                    ))
                })?;
            if let Err(error) = self
                .persistence_manager
                .save_session(&workspace_path, &updated_session)
                .await
            {
                if let Err(rollback_error) = self
                    .persistence_manager
                    .save_session(&workspace_path, &original_session)
                    .await
                {
                    return Err(OpenBitFunError::session(format!(
                        "Reasoning preset persistence failed and rollback did not complete: session_id={session_id}, error={error}, rollback_error={rollback_error}"
                    )));
                }
                return Err(error);
            }
        }

        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.config.reasoning_preset = None;
            session.updated_at = now;
            session.last_activity_at = now;
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        }
        drop(_mutation_guard);

        warn!(
            "Session reasoning preset became unavailable; normalized to Auto: session_id={}, preset_id={}, reason={}",
            session_id, previous_preset_id, reason
        );
        if let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() {
            coordinator
                .emit_session_reasoning_preset_auto_cleared(session_id, &previous_preset_id, reason)
                .await;
        }
        Ok(None)
    }

    /// Last-resort turn-time canonicalization. Normal write/restore/config
    /// reconciliation paths should have already converged the Session.
    pub(crate) async fn reconcile_session_reasoning_preset_for_turn(
        &self,
        session_id: &str,
        reason: &'static str,
    ) -> OpenBitFunResult<Option<String>> {
        let Some(ai_config) = Self::load_ai_config_for_model_resolution().await else {
            return Ok(self
                .sessions
                .get(session_id)
                .and_then(|session| session.config.reasoning_preset.clone()));
        };
        self.reconcile_session_reasoning_preset_locked(session_id, &ai_config, reason)
            .await
    }

    async fn reconcile_loaded_session_reasoning_presets(&self, reason: &'static str) {
        let Some(ai_config) = Self::load_ai_config_for_model_resolution().await else {
            debug!(
                "Skipping session reasoning preset reconciliation because AI config is unavailable: reason={}",
                reason
            );
            return;
        };
        let candidates = self
            .sessions
            .iter()
            .filter(|entry| entry.config.reasoning_preset.is_some())
            .map(|entry| entry.session_id.clone())
            .collect::<Vec<_>>();

        for session_id in candidates {
            if let Err(error) = self
                .reconcile_session_reasoning_preset_locked(&session_id, &ai_config, reason)
                .await
            {
                warn!(
                    "Failed to reconcile session reasoning preset: session_id={}, reason={}, error={}",
                    session_id, reason, error
                );
            }
        }
    }

    /// Best-effort: drop cached AI clients for invalidated models so the next
    /// request rebuilds against the reconciled config.
    async fn invalidate_ai_clients_for_models(invalidated_model_ids: &[String]) {
        if invalidated_model_ids.is_empty() {
            return;
        }
        if let Ok(factory) = get_global_ai_client_factory().await {
            for model_id in invalidated_model_ids {
                factory.invalidate_model(model_id);
            }
        }
    }

    fn spawn_model_reconciliation_listener(&self) {
        let sessions = self.sessions.clone();
        let active_turn_permission_modes = self.active_turn_permission_modes.clone();
        let transient_session_ids = self.transient_session_ids.clone();
        let turn_settlement_results = self.turn_settlement_results.clone();
        let turn_settlement_result_order = self.turn_settlement_result_order.clone();
        let active_session_capacity = self.active_session_capacity.clone();
        let active_session_permits = self.active_session_permits.clone();
        let session_storage_path_index = self.session_storage_path_index.clone();
        let session_mutation_locks = self.session_mutation_locks.clone();
        let session_write_locks = self.session_write_locks.clone();
        let context_store = self.context_store.clone();
        let prompt_cache_store = self.prompt_cache_store.clone();
        let prompt_cache_operation_locks = self.prompt_cache_operation_locks.clone();
        let token_anchor_store = self.token_anchor_store.clone();
        let turn_skill_agent_snapshot_store = self.turn_skill_agent_snapshot_store.clone();
        let skill_agent_baseline_override_snapshot_store =
            self.skill_agent_baseline_override_snapshot_store.clone();
        let edit_constraints_store = self.edit_constraints_store.clone();
        let review_read_receipt_store = self.review_read_receipt_store.clone();
        let evidence_ledger = self.evidence_ledger.clone();
        let evidence_ledger_operation_locks = self.evidence_ledger_operation_locks.clone();
        let persistence_manager = self.persistence_manager.clone();
        let memory_database = self.memory_database.clone();
        let manager_config = self.config.clone();

        tokio::spawn(async move {
            let Some(mut receiver) = subscribe_config_updates() else {
                debug!(
                    "SessionManager: config update subscription unavailable; skipping model reconciliation listener"
                );
                return;
            };

            // Re-build a thin handle that mirrors `self` for the listener loop.
            // We can't move `self` into a 'static task, so we recreate the
            // surface area we need from the cloned shared fields above.
            let manager = Self {
                sessions,
                active_turn_permission_modes,
                transient_session_ids,
                turn_settlement_results,
                turn_settlement_result_order,
                active_session_capacity,
                active_session_permits,
                session_storage_path_index,
                session_mutation_locks,
                session_write_locks,
                context_store,
                prompt_cache_store,
                prompt_cache_operation_locks,
                token_anchor_store,
                turn_skill_agent_snapshot_store,
                skill_agent_baseline_override_snapshot_store,
                edit_constraints_store,
                review_read_receipt_store,
                evidence_ledger,
                evidence_ledger_operation_locks,
                persistence_manager,
                memory_database,
                config: manager_config,
            };

            loop {
                match receiver.recv().await {
                    Ok(ConfigUpdateEvent::ModelsReconciled {
                        invalidated_model_ids,
                        ..
                    }) => {
                        Self::invalidate_ai_clients_for_models(&invalidated_model_ids).await;
                        manager
                            .apply_fallback_to_invalidated_session_models(
                                &invalidated_model_ids,
                                "model_reconciled",
                            )
                            .await;
                    }
                    Ok(
                        ConfigUpdateEvent::ModelConfigurationUpdated
                        | ConfigUpdateEvent::AIModelUpdated { .. }
                        | ConfigUpdateEvent::DefaultAIModelUpdated { .. }
                        | ConfigUpdateEvent::ConfigReloaded,
                    ) => {
                        manager
                            .reconcile_loaded_session_reasoning_presets(
                                "model_configuration_updated",
                            )
                            .await;
                    }
                    Ok(ConfigUpdateEvent::ReasoningCatalogUpdated) => {
                        manager
                            .reconcile_loaded_session_reasoning_presets("reasoning_catalog_updated")
                            .await;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        debug!("SessionManager model reconciliation listener: channel closed");
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(
                            "SessionManager model reconciliation listener lagged by {} events; continuing",
                            n
                        );
                    }
                }
            }
        });
    }

    // ============ Session CRUD ============

    /// Create a new session
    pub async fn create_session(
        &self,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
    ) -> OpenBitFunResult<Session> {
        self.create_session_with_id_and_details(
            None,
            session_name,
            agent_type,
            config,
            None,
            SessionKind::Standard,
        )
        .await
    }

    /// Create a new session (supports specifying session ID)
    pub async fn create_session_with_id(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
    ) -> OpenBitFunResult<Session> {
        self.create_session_with_id_and_details(
            session_id,
            session_name,
            agent_type,
            config,
            None,
            SessionKind::Standard,
        )
        .await
    }

    /// Create a new session (supports specifying session ID and creator identity)
    pub async fn create_session_with_id_and_creator(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        created_by: Option<String>,
    ) -> OpenBitFunResult<Session> {
        self.create_session_with_id_and_details(
            session_id,
            session_name,
            agent_type,
            config,
            created_by,
            SessionKind::Standard,
        )
        .await
    }

    /// Create a new session with explicit kind.
    pub async fn create_session_with_id_and_details(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        created_by: Option<String>,
        kind: SessionKind,
    ) -> OpenBitFunResult<Session> {
        self.create_session_with_id_and_details_internal(
            session_id,
            session_name,
            agent_type,
            config,
            created_by,
            kind,
            false,
        )
        .await
    }

    pub(crate) async fn create_transient_session_with_id_and_details(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        created_by: Option<String>,
        kind: SessionKind,
    ) -> OpenBitFunResult<Session> {
        self.create_session_with_id_and_details_internal(
            session_id,
            session_name,
            agent_type,
            config,
            created_by,
            kind,
            true,
        )
        .await
    }

    async fn create_session_with_id_and_details_internal(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        created_by: Option<String>,
        kind: SessionKind,
        transient: bool,
    ) -> OpenBitFunResult<Session> {
        let mut config = config;
        crate::agentic::workspace::normalize_session_workspace(&mut config).await?;
        let _workspace_path = Self::session_workspace_from_config(&config).ok_or_else(|| {
            OpenBitFunError::Validation("Session workspace_path is required".to_string())
        })?;

        let session_storage_path = self
            .effective_storage_path_for_config(&config)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation("Session workspace_path is required".to_string())
            })?;

        let mut session = if let Some(id) = session_id {
            Session::new_with_id(id, session_name, agent_type.clone(), config)
        } else {
            Session::new(session_name, agent_type.clone(), config)
        };
        session.created_by = created_by;
        session.kind = kind;
        let ai_config = Self::load_ai_config_for_model_resolution().await;
        if let Some(ai_config) = ai_config.as_ref() {
            let previous_reasoning_preset = session.config.reasoning_preset.clone();
            session.config.reasoning_preset =
                Self::normalize_session_reasoning_preset(&session, ai_config).await;
            if previous_reasoning_preset.is_some() && session.config.reasoning_preset.is_none() {
                warn!(
                    "Session creation received an unavailable reasoning preset; normalizing to Auto: session_id={}, preset_id={}",
                    session.session_id,
                    previous_reasoning_preset.as_deref().unwrap_or_default()
                );
            }
            let previous_context_window = session.config.max_context_tokens;
            if let Some(resolved_context_window) =
                Self::sync_session_context_window_from_ai_config(&mut session, ai_config)
            {
                if resolved_context_window != previous_context_window {
                    debug!(
                        "Resolved session context window before creation: session_id={}, previous={}, resolved={}",
                        session.session_id, previous_context_window, resolved_context_window
                    );
                }
            }
        } else if let Some(preset_id) = session.config.reasoning_preset.as_deref() {
            session.config.reasoning_preset =
                Some(preset_id.trim().to_string()).filter(|preset_id| {
                    !preset_id.is_empty() && !preset_id.eq_ignore_ascii_case("auto")
                });
        }
        let persist = self.config.enable_persistence
            && !transient
            && Self::should_persist_session_kind(session.kind);
        let session_id = session.session_id.clone();
        let _mutation_guard = self.lock_session_mutation(&session_id).await;
        if self.sessions.contains_key(&session_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Session ID already exists: {session_id}"
            )));
        }
        let session_write_lock = if persist {
            Some(self.try_acquire_session_write_lock(&session_storage_path, &session_id)?)
        } else {
            None
        };

        // Claim both the runtime session ID and its workspace storage identity before
        // exposing the session. Persistent sessions must never reuse an on-disk ID:
        // overwriting the header would retain old turns and silently mix histories.
        if self.sessions.contains_key(&session_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Session ID already exists: {session_id}"
            )));
        }
        if self.config.enable_persistence
            && self
                .persistence_manager
                .session_storage_exists(&session_storage_path, &session_id)?
        {
            return Err(OpenBitFunError::Validation(format!(
                "Persisted session ID already exists: {session_id}"
            )));
        }
        let active_session_permit = self.reserve_active_session()?;
        let storage_claim =
            self.claim_session_storage_path(&session_id, &session_storage_path, true)?;

        // Persist before publishing runtime state. Cancellation or timeout while
        // this await is in progress cannot leave a writable in-memory Session.
        if persist {
            if let Err(error) = self
                .persistence_manager
                .create_session_if_absent(&session_storage_path, &session)
                .await
            {
                self.release_failed_session_storage_path_claim(
                    &session_id,
                    &session_storage_path,
                    storage_claim,
                );
                return Err(error);
            }
        }

        // Publication is synchronous after all fallible persistence work.
        match self.sessions.entry(session_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(session.clone());
            }
            Entry::Occupied(_) => {
                self.release_failed_session_storage_path_claim(
                    &session_id,
                    &session_storage_path,
                    storage_claim,
                );
                return Err(OpenBitFunError::Validation(format!(
                    "Session ID already exists: {session_id}"
                )));
            }
        }
        if transient {
            self.transient_session_ids.insert(session_id.clone(), ());
        }
        self.context_store.create_session(&session_id);
        self.token_anchor_store.create_session(&session_id);
        self.turn_skill_agent_snapshot_store
            .create_session(&session_id);
        self.review_read_receipt_store.create_session(&session_id);
        self.commit_session_storage_path_claim(&session_id, &session_storage_path, storage_claim);
        self.commit_active_session_reservation(&session_id, active_session_permit);
        if let Some(write_lock) = session_write_lock {
            self.commit_session_write_lock(&session_id, write_lock);
        }

        info!("Session created: session_name={}", session.session_name);

        Ok(session)
    }

    /// Get session
    pub fn get_session(&self, session_id: &str) -> Option<Session> {
        self.sessions.get(session_id).map(|s| s.clone())
    }

    /// Read only the execution fact; navigation must not clone Session content.
    pub fn get_session_state(&self, session_id: &str) -> Option<SessionState> {
        self.sessions
            .get(session_id)
            .map(|session| session.state.clone())
    }

    pub async fn cached_system_prompt(
        &self,
        session_id: &str,
        identity: &SystemPromptCacheIdentity,
    ) -> Option<String> {
        self.ensure_prompt_cache_loaded(session_id).await;
        match self.prompt_cache_store.lookup_system_prompt(
            session_id,
            identity,
            self.config.prompt_cache_policy.cache_ttl,
        ) {
            PromptCacheLookup::Hit(prompt) => Some(prompt),
            PromptCacheLookup::Miss => None,
            PromptCacheLookup::Expired => {
                self.persist_prompt_cache_best_effort(
                    session_id,
                    "system_prompt_cache_expired_cleanup",
                )
                .await;
                None
            }
        }
    }

    pub async fn remember_system_prompt(
        &self,
        session_id: &str,
        identity: SystemPromptCacheIdentity,
        prompt: String,
    ) {
        self.ensure_prompt_cache_loaded(session_id).await;
        self.prompt_cache_store
            .set_system_prompt(session_id, CachedSystemPrompt::new(identity, prompt));
        self.persist_prompt_cache_best_effort(session_id, "system_prompt_cached")
            .await;
    }

    pub async fn cached_user_context(
        &self,
        session_id: &str,
        identity: &UserContextCacheIdentity,
    ) -> Option<String> {
        self.ensure_prompt_cache_loaded(session_id).await;
        match self.prompt_cache_store.lookup_user_context(
            session_id,
            identity,
            self.config.prompt_cache_policy.cache_ttl,
        ) {
            PromptCacheLookup::Hit(user_context) => Some(user_context),
            PromptCacheLookup::Miss => None,
            PromptCacheLookup::Expired => {
                self.persist_prompt_cache_best_effort(
                    session_id,
                    "user_context_cache_expired_cleanup",
                )
                .await;
                None
            }
        }
    }

    pub async fn remember_user_context(
        &self,
        session_id: &str,
        identity: UserContextCacheIdentity,
        user_context: String,
    ) {
        self.ensure_prompt_cache_loaded(session_id).await;
        self.prompt_cache_store
            .set_user_context(session_id, CachedUserContext::new(identity, user_context));
        self.persist_prompt_cache_best_effort(session_id, "user_context_cached")
            .await;
    }

    pub async fn user_context_cache_generation(&self, session_id: &str) -> u64 {
        self.ensure_prompt_cache_loaded(session_id).await;
        self.prompt_cache_store.user_context_generation(session_id)
    }

    pub async fn remember_user_context_if_generation(
        &self,
        session_id: &str,
        generation: u64,
        identity: UserContextCacheIdentity,
        user_context: String,
    ) -> bool {
        self.ensure_prompt_cache_loaded(session_id).await;
        let stored = self.prompt_cache_store.set_user_context_if_generation(
            session_id,
            generation,
            CachedUserContext::new(identity, user_context),
        );
        if stored {
            self.persist_prompt_cache_best_effort(session_id, "user_context_cached")
                .await;
        }
        stored
    }

    pub async fn clone_prompt_cache(
        &self,
        source_session_id: &str,
        target_session_id: &str,
    ) -> bool {
        self.ensure_prompt_cache_loaded(source_session_id).await;
        let Some(cache) = self.prompt_cache_store.get_cache(source_session_id) else {
            return false;
        };
        if cache.is_empty() {
            return false;
        }

        self.prompt_cache_store
            .replace_cache(target_session_id, cache);
        self.persist_prompt_cache_best_effort(target_session_id, "prompt_cache_cloned")
            .await;
        true
    }

    pub async fn turn_skill_agent_snapshot(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> Option<TurnSkillAgentSnapshot> {
        if let Some(snapshot) = self
            .turn_skill_agent_snapshot_store
            .get_snapshot(session_id, turn_index)
        {
            return Some(snapshot);
        }

        if !self.should_persist_session_id(session_id) {
            return None;
        }

        let workspace_path = self.effective_session_storage_path(session_id).await?;
        match self
            .load_turn_skill_agent_snapshot_from_persistence(
                &workspace_path,
                session_id,
                turn_index,
            )
            .await
        {
            Ok(Some(snapshot)) => {
                self.turn_skill_agent_snapshot_store.set_snapshot(
                    session_id,
                    turn_index,
                    snapshot.clone(),
                );
                Some(snapshot)
            }
            Ok(None) => None,
            Err(error) => {
                warn!(
                    "Failed to load turn skill-agent snapshot: session_id={}, turn_index={}, workspace_path={}, error={}",
                    session_id,
                    turn_index,
                    workspace_path.display(),
                    error
                );
                None
            }
        }
    }

    pub async fn latest_turn_skill_agent_snapshot_at_or_before(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> Option<(usize, TurnSkillAgentSnapshot)> {
        let cached_snapshot = self
            .turn_skill_agent_snapshot_store
            .latest_snapshot_at_or_before(session_id, turn_index);
        if let Some(snapshot) = cached_snapshot.as_ref() {
            if snapshot.0 == turn_index || !self.should_persist_session_id(session_id) {
                return cached_snapshot;
            }
        }

        if !self.should_persist_session_id(session_id) {
            return cached_snapshot;
        }

        let workspace_path = self.effective_session_storage_path(session_id).await?;
        let scan_floor_exclusive = cached_snapshot.as_ref().map(|snapshot| snapshot.0);
        for index in (0..=turn_index).rev() {
            if scan_floor_exclusive.is_some_and(|floor| index <= floor) {
                break;
            }
            match self
                .load_turn_skill_agent_snapshot_from_persistence(&workspace_path, session_id, index)
                .await
            {
                Ok(Some(snapshot)) => {
                    self.turn_skill_agent_snapshot_store.set_snapshot(
                        session_id,
                        index,
                        snapshot.clone(),
                    );
                    return Some((index, snapshot));
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(
                        "Failed to load turn skill-agent snapshot while scanning backwards: session_id={}, turn_index={}, workspace_path={}, error={}",
                        session_id,
                        index,
                        workspace_path.display(),
                        error
                    );
                }
            }
        }

        cached_snapshot
    }

    pub async fn remember_turn_skill_agent_snapshot(
        &self,
        session_id: &str,
        turn_index: usize,
        snapshot: TurnSkillAgentSnapshot,
    ) {
        self.turn_skill_agent_snapshot_store
            .set_snapshot(session_id, turn_index, snapshot.clone());

        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping turn skill-agent snapshot persistence because workspace path is unavailable: session_id={}, turn_index={}",
                session_id, turn_index
            );
            return;
        };

        if let Err(error) = self
            .persistence_manager
            .save_turn_skill_agent_snapshot(&workspace_path, session_id, turn_index, &snapshot)
            .await
        {
            warn!(
                "Failed to persist turn skill-agent snapshot: session_id={}, turn_index={}, workspace_path={}, error={}",
                session_id,
                turn_index,
                workspace_path.display(),
                error
            );
        }
    }

    pub async fn recover_first_turn_skill_agent_snapshot(
        &self,
        session_id: &str,
        snapshot: TurnSkillAgentSnapshot,
    ) {
        self.turn_skill_agent_snapshot_store
            .remove_from(session_id, 1);
        self.turn_skill_agent_snapshot_store
            .set_snapshot(session_id, 0, snapshot.clone());

        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping first-turn skill-agent baseline recovery persistence because workspace path is unavailable: session_id={}",
                session_id
            );
            return;
        };

        if let Err(error) = self
            .persistence_manager
            .delete_turn_skill_agent_snapshots_from(&workspace_path, session_id, 1)
            .await
        {
            warn!(
                "Failed to prune turn skill-agent snapshots during baseline recovery: session_id={}, workspace_path={}, error={}",
                session_id,
                workspace_path.display(),
                error
            );
        }

        if let Err(error) = self
            .persistence_manager
            .save_turn_skill_agent_snapshot(&workspace_path, session_id, 0, &snapshot)
            .await
        {
            warn!(
                "Failed to persist recovered first-turn skill-agent snapshot: session_id={}, workspace_path={}, error={}",
                session_id,
                workspace_path.display(),
                error
            );
        }
    }

    pub async fn remember_skill_agent_baseline_override_snapshot(
        &self,
        session_id: &str,
        snapshot: TurnSkillAgentSnapshot,
    ) {
        self.skill_agent_baseline_override_snapshot_store
            .insert(session_id.to_string(), snapshot.clone());

        if !self.should_persist_session_id(session_id) {
            return;
        }

        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            debug!(
                "Skipping listing reminder baseline override persistence because workspace path is unavailable: session_id={}",
                session_id
            );
            return;
        };

        if let Err(error) = self
            .persistence_manager
            .save_skill_agent_baseline_override_snapshot(&workspace_path, session_id, &snapshot)
            .await
        {
            warn!(
                "Failed to persist listing reminder baseline override snapshot: session_id={}, workspace_path={}, error={}",
                session_id,
                workspace_path.display(),
                error
            );
        }
    }

    pub async fn skill_agent_baseline_override_snapshot(
        &self,
        session_id: &str,
    ) -> Option<TurnSkillAgentSnapshot> {
        if let Some(snapshot) = self
            .skill_agent_baseline_override_snapshot_store
            .get(session_id)
            .map(|value| value.clone())
        {
            return Some(snapshot);
        }

        if !self.should_persist_session_id(session_id) {
            return None;
        }

        let workspace_path = self.effective_session_storage_path(session_id).await?;
        let snapshot = match self
            .persistence_manager
            .load_skill_agent_baseline_override_snapshot(&workspace_path, session_id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                warn!(
                    "Failed to load listing reminder baseline override snapshot: session_id={}, workspace_path={}, error={}",
                    session_id,
                    workspace_path.display(),
                    error
                );
                return None;
            }
        };
        let snapshot = snapshot?;
        self.skill_agent_baseline_override_snapshot_store
            .insert(session_id.to_string(), snapshot.clone());
        Some(snapshot)
    }

    pub async fn seed_forked_skill_agent_listing_baselines(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) {
        // Forked children need two different baselines at the same time:
        // - the parent's turn-0 snapshot stays as the prompt/listing baseline so the child's
        //   first request can reuse the same full skill/agent listing prefix
        // - the parent's latest snapshot becomes the child's own turn-0 snapshot so later child
        //   turns diff against the fork-time surface instead of diffing forever against the
        //   parent's original turn-0 baseline
        let prompt_listing_baseline = self.turn_skill_agent_snapshot(parent_session_id, 0).await;
        if let Some(snapshot) = prompt_listing_baseline.clone() {
            self.remember_skill_agent_baseline_override_snapshot(child_session_id, snapshot)
                .await;
        }

        let latest_parent_snapshot = match self.get_turn_count(parent_session_id).checked_sub(1) {
            Some(turn_index) => self
                .latest_turn_skill_agent_snapshot_at_or_before(parent_session_id, turn_index)
                .await
                .map(|(_, snapshot)| snapshot),
            None => None,
        };

        if let Some(snapshot) = latest_parent_snapshot.or(prompt_listing_baseline) {
            self.remember_turn_skill_agent_snapshot(child_session_id, 0, snapshot)
                .await;
        }
    }

    /// Merges one extraction record into the active session state and persists
    /// the resulting constraints plus extraction evidence.
    pub async fn remember_edit_constraint_extraction(
        &self,
        session_id: &str,
        extraction: crate::agentic::execution::edit_constraint_guard::ConstraintExtractionRecord,
    ) {
        let mut state = self.edit_constraint_state(session_id).unwrap_or_default();
        state.merge_extraction(extraction);
        self.edit_constraints_store
            .insert(session_id.to_string(), state.clone());

        if self.should_persist_session_id(session_id) {
            if let Err(error) = self
                .merge_session_custom_metadata(
                    session_id,
                    json!({
                        crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY: state,
                    }),
                )
                .await
            {
                warn!(
                    "Failed to persist edit constraint state: session_id={}, error={}",
                    session_id, error
                );
            }
        }
    }

    /// Records paths first created through direct agent file tools. This is
    /// session-persistent provenance used to distinguish temporary agent
    /// helpers from repository files protected by edit constraints.
    pub async fn remember_edit_constraint_agent_created_paths(
        &self,
        session_id: &str,
        paths: Vec<String>,
        dialog_turn_id: &str,
    ) {
        let mut state = self.edit_constraint_state(session_id).unwrap_or_default();
        state.remember_agent_created_paths(paths, dialog_turn_id);
        self.edit_constraints_store
            .insert(session_id.to_string(), state.clone());

        if self.should_persist_session_id(session_id) {
            if let Err(error) = self
                .merge_session_custom_metadata(
                    session_id,
                    json!({
                        crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY: state,
                    }),
                )
                .await
            {
                warn!(
                    "Failed to persist agent-created file provenance: session_id={}, error={}",
                    session_id, error
                );
            }
        }
    }

    /// Removes direct-agent provenance after a successful delete. Descendants
    /// are removed as well so recursive cleanup cannot leave stale records.
    pub async fn forget_edit_constraint_agent_created_paths_under(
        &self,
        session_id: &str,
        paths: Vec<String>,
    ) {
        let Some(mut state) = self.edit_constraint_state(session_id) else {
            return;
        };
        state.forget_agent_created_paths_under(&paths);
        self.edit_constraints_store
            .insert(session_id.to_string(), state.clone());

        if self.should_persist_session_id(session_id) {
            if let Err(error) = self
                .merge_session_custom_metadata(
                    session_id,
                    json!({
                        crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY: state,
                    }),
                )
                .await
            {
                warn!(
                    "Failed to persist removed agent-created file provenance: session_id={}, error={}",
                    session_id, error
                );
            }
        }
    }

    /// Rewinds edit constraints and direct-file provenance to the turns that
    /// remain after a session rollback. This prevents a restriction, explicit
    /// relaxation, or temporary helper created in discarded future context
    /// from leaking into the resumed branch.
    pub async fn rollback_edit_constraint_state_to_turns(
        &self,
        session_id: &str,
        surviving_turn_ids: &std::collections::HashSet<String>,
    ) {
        let Some(mut state) = self.edit_constraint_state(session_id) else {
            return;
        };
        state.rollback_to_surviving_turns(surviving_turn_ids);
        self.edit_constraints_store
            .insert(session_id.to_string(), state.clone());

        if self.should_persist_session_id(session_id) {
            if let Err(error) = self
                .merge_session_custom_metadata(
                    session_id,
                    json!({
                        crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY: state,
                    }),
                )
                .await
            {
                warn!(
                    "Failed to persist rolled-back edit constraint state: session_id={}, error={}",
                    session_id, error
                );
            }
        }
    }

    pub fn edit_constraint_state(
        &self,
        session_id: &str,
    ) -> Option<crate::agentic::execution::edit_constraint_guard::EditConstraintState> {
        self.edit_constraints_store
            .get(session_id)
            .map(|value| value.clone())
    }

    fn edit_constraint_state_from_metadata(
        metadata: Option<&SessionMetadata>,
    ) -> Option<crate::agentic::execution::edit_constraint_guard::EditConstraintState> {
        let value = metadata?
            .custom_metadata
            .as_ref()?
            .get(crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY)?;
        match serde_json::from_value(value.clone()) {
            Ok(state) => Some(state),
            Err(error) => {
                warn!("Failed to restore edit constraint state from session metadata: {error}");
                None
            }
        }
    }

    pub fn edit_constraints(
        &self,
        session_id: &str,
    ) -> Option<Vec<crate::agentic::execution::edit_constraint_guard::ExtractedConstraint>> {
        self.edit_constraint_state(session_id)
            .map(|state| state.constraints)
    }

    /// Subagents inherit both active constraints and extraction evidence.
    pub async fn seed_forked_edit_constraints(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) {
        if let Some(mut state) = self.edit_constraint_state(parent_session_id) {
            state.mark_current_state_as_fork_baseline();
            self.edit_constraints_store
                .insert(child_session_id.to_string(), state.clone());
            if self.should_persist_session_id(child_session_id) {
                if let Err(error) = self
                    .merge_session_custom_metadata(
                        child_session_id,
                        json!({
                            crate::agentic::execution::edit_constraint_guard::EDIT_CONSTRAINT_METADATA_KEY: state,
                        }),
                    )
                    .await
                {
                    warn!(
                        "Failed to persist inherited edit constraint state: session_id={}, error={}",
                        child_session_id, error
                    );
                }
            }
        }
    }

    pub async fn rebuild_skill_agent_listing_baseline_to_latest(&self, session_id: &str) -> bool {
        let Some(turn_index) = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.len().checked_sub(1))
        else {
            return false;
        };

        let Some((_, latest_snapshot)) = self
            .latest_turn_skill_agent_snapshot_at_or_before(session_id, turn_index)
            .await
        else {
            return false;
        };

        if self
            .skill_agent_baseline_override_snapshot(session_id)
            .await
            .is_some()
        {
            self.remember_skill_agent_baseline_override_snapshot(
                session_id,
                latest_snapshot.clone(),
            )
            .await;
        }

        self.recover_first_turn_skill_agent_snapshot(session_id, latest_snapshot)
            .await;
        self.persist_listing_baseline_rebuild_turn_index_best_effort(session_id, turn_index)
            .await;

        let _ = self
            .remove_listing_diff_internal_reminders(session_id)
            .await;
        true
    }

    pub async fn remove_listing_diff_internal_reminders(&self, session_id: &str) -> bool {
        let changed = self
            .context_store
            .try_transform_context(session_id, |messages| {
                let (filtered, changed) =
                    Self::strip_listing_diff_internal_reminders(messages.to_vec());
                Ok((changed.then_some(filtered), changed))
            })
            .unwrap_or(false);
        if !changed {
            return false;
        }
        self.persist_current_turn_context_snapshot_best_effort(
            session_id,
            "listing_diff_internal_reminders_removed",
        )
        .await;
        true
    }

    fn strip_listing_diff_internal_reminders(messages: Vec<Message>) -> (Vec<Message>, bool) {
        let original_len = messages.len();
        let filtered_messages = messages
            .into_iter()
            .filter(|message| {
                !message
                    .internal_reminder_kind()
                    .is_some_and(InternalReminderKind::is_listing_diff)
            })
            .collect::<Vec<_>>();

        let changed = filtered_messages.len() != original_len;
        (filtered_messages, changed)
    }

    fn listing_baseline_rebuild_turn_index_from_custom_metadata(
        custom_metadata: Option<&serde_json::Value>,
    ) -> Option<usize> {
        custom_metadata?
            .get(LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY)?
            .as_u64()?
            .try_into()
            .ok()
    }

    fn listing_baseline_rebuild_turn_index_from_metadata(
        metadata: Option<&SessionMetadata>,
    ) -> Option<usize> {
        Self::listing_baseline_rebuild_turn_index_from_custom_metadata(
            metadata.and_then(|metadata| metadata.custom_metadata.as_ref()),
        )
    }

    async fn persist_context_snapshot_messages_best_effort(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
        messages: &[Message],
        reason: &str,
    ) {
        if !self.should_persist_session_id(session_id) {
            return;
        }

        if let Err(err) = self
            .persistence_manager
            .save_turn_context_snapshot(workspace_path, session_id, turn_index, messages)
            .await
        {
            warn!(
                "failed to persist explicit context snapshot: session_id={}, turn_index={}, reason={}, err={}",
                session_id, turn_index, reason, err
            );
        }
    }

    async fn sanitize_listing_diff_context_snapshot_if_needed(
        &self,
        workspace_path: &Path,
        session_id: &str,
        turn_index: usize,
        messages: Vec<Message>,
        cutoff_turn_index: Option<usize>,
        reason: &str,
    ) -> Vec<Message> {
        let Some(cutoff_turn_index) = cutoff_turn_index else {
            return messages;
        };
        // The rebuild performed at turn R already persisted snapshots on and after R against
        // the new baseline. Only snapshots strictly before that rebuilt turn need diff-reminder
        // cleanup, so the predicate is `< cutoff`, not `<= cutoff`.
        if turn_index >= cutoff_turn_index {
            return messages;
        }

        let (sanitized_messages, changed) = Self::strip_listing_diff_internal_reminders(messages);
        if !changed {
            return sanitized_messages;
        }

        debug!(
            "Sanitized listing diff reminders from pre-rebuild context snapshot: session_id={}, turn_index={}, cutoff_turn_index={}, reason={}",
            session_id, turn_index, cutoff_turn_index, reason
        );
        self.persist_context_snapshot_messages_best_effort(
            workspace_path,
            session_id,
            turn_index,
            &sanitized_messages,
            reason,
        )
        .await;
        sanitized_messages
    }

    async fn persist_listing_baseline_rebuild_turn_index_best_effort(
        &self,
        session_id: &str,
        turn_index: usize,
    ) {
        if let Err(err) = self
            .merge_session_custom_metadata(
                session_id,
                json!({
                    LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY: turn_index,
                }),
            )
            .await
        {
            warn!(
                "failed to persist listing baseline rebuild turn index: session_id={}, turn_index={}, err={}",
                session_id, turn_index, err
            );
        }
    }

    async fn truncate_listing_baseline_rebuild_turn_index_after_rollback(
        &self,
        workspace_path: &Path,
        session_id: &str,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        let metadata = self
            .persistence_manager
            .load_session_metadata(workspace_path, session_id)
            .await?;
        let Some(existing_cutoff) =
            Self::listing_baseline_rebuild_turn_index_from_metadata(metadata.as_ref())
        else {
            return Ok(());
        };

        if existing_cutoff <= target_turn {
            return Ok(());
        }

        // After rollback, the session branches again from `target_turn`. Keeping a cutoff newer
        // than that branch point would cause future snapshots on the new branch to be mistaken
        // for "pre-rebuild" history during the next restore, so clamp the cutoff down.
        self.merge_session_custom_metadata(
            session_id,
            json!({
                LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY: target_turn,
            }),
        )
        .await
    }

    pub async fn invalidate_prompt_cache(
        &self,
        session_id: &str,
        scope: PromptCacheScope,
        reason: &str,
    ) {
        self.ensure_prompt_cache_loaded(session_id).await;
        let changed = self.prompt_cache_store.invalidate(session_id, scope);

        if changed {
            debug!(
                "Invalidated session prompt cache: session_id={}, scope={:?}, reason={}",
                session_id, scope, reason
            );
            self.persist_prompt_cache_best_effort(session_id, reason)
                .await;
        }
    }

    /// Synchronously reset session state to Idle if it is currently Processing
    /// the expected turn.
    ///
    /// This is an in-memory-only operation intended for RAII-style cleanup in
    /// spawn tasks.  Because `Drop::drop` is synchronous we cannot do async
    /// file I/O here, but that is acceptable: the in-memory state is the
    /// source of truth at runtime, and `restore_session` already resets any
    /// non-Idle persisted state to Idle on application restart.
    pub fn reset_session_state_if_processing(&self, session_id: &str, expected_turn_id: &str) {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            if matches!(
                &session.state,
                SessionState::Processing {
                    current_turn_id,
                    ..
                } if current_turn_id == expected_turn_id
            ) {
                debug!(
                    "RAII guard resetting stuck Processing state to Idle: session_id={}, turn_id={}",
                    session_id, expected_turn_id
                );
                session.state = SessionState::Idle;
                session.updated_at = SystemTime::now();
                session.last_activity_at = SystemTime::now();
            }
        }
    }

    /// Update session state
    pub async fn update_session_state(
        &self,
        session_id: &str,
        new_state: SessionState,
    ) -> OpenBitFunResult<()> {
        let effective_path = self.effective_session_storage_path(session_id).await;

        // IMPORTANT: keep the DashMap guard scope short -- do NOT hold it across .await.
        // Collect the data needed for persistence, then release the guard before doing I/O.
        let should_persist = if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.state = new_state.clone();
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();

            self.config.enable_persistence && self.should_persist_session(&session)
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        };
        // RefMut guard released here -- DashMap shard lock is free.

        // Persist state changes outside the guard scope.
        if should_persist {
            if let Some(ref workspace_path) = effective_path {
                self.persistence_manager
                    .save_session_state(workspace_path, session_id, &new_state)
                    .await?;
            }
        }

        debug!(
            "Updated session state: session_id={}, state={:?}",
            session_id, new_state
        );

        Ok(())
    }

    /// Update session state only when the session is still processing the
    /// expected turn. Returns `true` when the state was updated.
    pub async fn update_session_state_for_turn_if_processing(
        &self,
        session_id: &str,
        expected_turn_id: &str,
        new_state: SessionState,
    ) -> OpenBitFunResult<bool> {
        let effective_path = self.effective_session_storage_path(session_id).await;

        let should_persist = if let Some(mut session) = self.sessions.get_mut(session_id) {
            let owns_processing_turn = matches!(
                &session.state,
                SessionState::Processing {
                    current_turn_id,
                    ..
                } if current_turn_id == expected_turn_id
            );

            if !owns_processing_turn {
                debug!(
                    "Skipped session state update for stale turn: session_id={}, expected_turn_id={}, current_state={:?}",
                    session_id, expected_turn_id, session.state
                );
                return Ok(false);
            }

            session.state = new_state.clone();
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();

            self.config.enable_persistence && self.should_persist_session(&session)
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        };

        if should_persist {
            if let Some(ref workspace_path) = effective_path {
                self.persistence_manager
                    .save_session_state(workspace_path, session_id, &new_state)
                    .await?;
            }
        }

        debug!(
            "Updated session state for turn: session_id={}, turn_id={}, state={:?}",
            session_id, expected_turn_id, new_state
        );

        Ok(true)
    }

    /// Update session title (in-memory + persistence)
    pub async fn update_session_title(
        &self,
        session_id: &str,
        title: &str,
    ) -> OpenBitFunResult<()> {
        let normalized_title = Self::normalize_session_title_input(title)?;
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        self.update_session_title_locked(session_id, normalized_title)
            .await
    }

    async fn update_session_title_locked(
        &self,
        session_id: &str,
        normalized_title: String,
    ) -> OpenBitFunResult<()> {
        let workspace_path = self.effective_session_storage_path(session_id).await;
        let mut updated_session = self
            .sessions
            .get(session_id)
            .map(|session| session.clone())
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        let now = SystemTime::now();
        updated_session.session_name = normalized_title.clone();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;

        if self.should_persist_session_id(session_id) {
            let Some(workspace_path) = workspace_path.as_ref() else {
                return Err(OpenBitFunError::Session(format!(
                    "Workspace path is unavailable for session {}",
                    session_id
                )));
            };
            let last_active_at = now
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            self.persistence_manager
                .update_session_title_metadata(
                    workspace_path,
                    session_id,
                    &updated_session.session_name,
                    last_active_at,
                )
                .await?;
        }

        let Some(mut session) = self.sessions.get_mut(session_id) else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        };
        session.session_name = updated_session.session_name;
        session.updated_at = now;
        session.last_activity_at = now;

        info!(
            "Session title updated: session_id={}, title={}",
            session_id, normalized_title
        );

        Ok(())
    }

    pub async fn update_session_title_if_current(
        &self,
        session_id: &str,
        expected_current_title: &str,
        title: &str,
    ) -> OpenBitFunResult<bool> {
        let normalized_title = Self::normalize_session_title_input(title)?;
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let Some(session) = self.sessions.get(session_id) else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        };

        if session.session_name != expected_current_title {
            debug!(
                "Skipping auto-generated title because current title changed: session_id={}, expected_title={}, current_title={}",
                session_id, expected_current_title, session.session_name
            );
            return Ok(false);
        }
        drop(session);

        self.update_session_title_locked(session_id, normalized_title)
            .await?;
        Ok(true)
    }

    /// Legacy mutation helper retained only for persistence-focused unit tests.
    /// Production callers must update the logical id and route owner atomically
    /// through `update_session_agent_binding`.
    #[cfg(test)]
    async fn update_session_agent_type(
        &self,
        session_id: &str,
        agent_type: &str,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let mut session = self
            .sessions
            .get(session_id)
            .map(|session| session.clone())
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;

        if session.agent_type == agent_type {
            return Ok(());
        }

        let now = SystemTime::now();
        session.agent_type = agent_type.to_string();
        session.updated_at = now;
        session.last_activity_at = now;

        if self.should_persist_session_id(session_id) {
            let last_active_at = now
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            self.update_persisted_session_metadata(session_id, |metadata| {
                metadata.agent_type = agent_type.to_string();
                metadata.last_active_at = last_active_at;
            })
            .await?;
        }

        if let Some(mut active_session) = self.sessions.get_mut(session_id) {
            active_session.agent_type = session.agent_type.clone();
            active_session.updated_at = now;
            active_session.last_activity_at = now;
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        drop(_mutation_guard);

        debug!(
            "Session agent type updated: session_id={}, agent_type={}",
            session_id, agent_type
        );

        Ok(())
    }

    /// Update the logical main-agent id and its durable route owner together.
    ///
    /// The owner is part of the execution binding: an externally owned Session
    /// must remain fail-closed after restart instead of resolving a same-name
    /// local mode. Persist the complete Session so metadata and state sidecar
    /// cannot disagree about this pair.
    pub async fn update_session_agent_binding(
        &self,
        session_id: &str,
        agent_type: &str,
        route_owner: SessionAgentRouteOwner,
        route_key: Option<String>,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let original_session = self
            .sessions
            .get(session_id)
            .map(|session| session.clone())
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        if original_session.agent_type == agent_type
            && original_session.config.agent_route_owner == route_owner
            && original_session.config.agent_route_key == route_key
        {
            return Ok(());
        }

        let mut updated_session = original_session.clone();
        let now = SystemTime::now();
        updated_session.agent_type = agent_type.to_string();
        updated_session.config.agent_route_owner = route_owner;
        updated_session.config.agent_route_key = route_key.clone();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;

        if self.should_persist_session_id(session_id) {
            if let Some(workspace_path) = self.effective_session_storage_path(session_id).await {
                if let Err(error) = self
                    .persistence_manager
                    .save_session(&workspace_path, &updated_session)
                    .await
                {
                    if let Err(rollback_error) = self
                        .persistence_manager
                        .save_session(&workspace_path, &original_session)
                        .await
                    {
                        return Err(OpenBitFunError::session(format!(
                            "Session agent binding persistence failed and rollback did not complete: session_id={session_id}, error={error}, rollback_error={rollback_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }

        let Some(mut active_session) = self.sessions.get_mut(session_id) else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        };
        active_session.agent_type = updated_session.agent_type;
        active_session.config.agent_route_owner = route_owner;
        active_session.config.agent_route_key = route_key.clone();
        active_session.updated_at = now;
        active_session.last_activity_at = now;
        debug!(
            "Session agent binding updated: session_id={}, agent_type={}, route_owner={:?}, route_key={:?}",
            session_id, agent_type, route_owner, route_key
        );

        Ok(())
    }

    /// Update the most recent scheduler-accepted user submission mode.
    ///
    /// This state is intentionally independent from rollback-sensitive history
    /// semantics. Prompt-cache guards should read this instead of deriving from
    /// surviving dialog turns.
    pub async fn update_last_submitted_agent_type(
        &self,
        session_id: &str,
        agent_type: &str,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.last_submitted_agent_type = Some(agent_type.to_string());
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            let session_snapshot = self.sessions.get(session_id).map(|s| s.clone());
            if let (Some(workspace_path), Some(session)) = (effective_path, session_snapshot) {
                self.persistence_manager
                    .save_session(&workspace_path, &session)
                    .await?;
            }
        }

        debug!(
            "Session last submitted agent type updated: session_id={}, agent_type={}",
            session_id, agent_type
        );

        Ok(())
    }

    /// Update whether a session runs its tool loop.
    ///
    /// `enable_tools` is persisted per session, so a session created while the
    /// caller disabled tools stays tool-less forever on reuse. Hosts that later
    /// change their mind (for example MiniApp runs that moved from a frontend
    /// switch to a backend allowlist) call this to repair existing sessions.
    pub async fn update_session_tool_enablement(
        &self,
        session_id: &str,
        enable_tools: bool,
    ) -> OpenBitFunResult<bool> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            if session.config.enable_tools == enable_tools {
                return Ok(false);
            }
            session.config.enable_tools = enable_tools;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            let session_snapshot = self.sessions.get(session_id).map(|s| s.clone());
            if let (Some(workspace_path), Some(session)) = (effective_path, session_snapshot) {
                self.persistence_manager
                    .save_session(&workspace_path, &session)
                    .await?;
            }
        }

        debug!(
            "Session tool enablement updated: session_id={}, enable_tools={}",
            session_id, enable_tools
        );

        Ok(true)
    }

    /// Inherit parent dialog mode state when creating forked child sessions.
    ///
    /// `last_user_dialog_agent_type` drives first-entry mode reminders, while
    /// `last_submitted_agent_type` preserves scheduler prompt-cache state.
    pub async fn inherit_session_agent_type_state(
        &self,
        session_id: &str,
        last_user_dialog_agent_type: Option<String>,
        last_submitted_agent_type: Option<String>,
    ) -> OpenBitFunResult<()> {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.last_user_dialog_agent_type = last_user_dialog_agent_type;
            session.last_submitted_agent_type = last_submitted_agent_type;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            let session_snapshot = self.sessions.get(session_id).map(|s| s.clone());
            if let (Some(workspace_path), Some(session)) = (effective_path, session_snapshot) {
                self.persistence_manager
                    .save_session(&workspace_path, &session)
                    .await?;
            }
        }

        debug!(
            "Session agent type state inherited: session_id={}",
            session_id
        );

        Ok(())
    }

    fn derive_last_user_dialog_agent_type_from_turns(
        turns: &[DialogTurnData],
        fallback_agent_type: Option<&str>,
    ) -> Option<String> {
        // New turns persist their mode on the turn itself. For older persisted
        // sessions that predate this field, fall back to the session default
        // only when at least one surviving user dialog turn exists.
        turns
            .iter()
            .rev()
            .find(|turn| turn.kind == DialogTurnKind::UserDialog)
            .and_then(|turn| {
                turn.agent_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
            })
            .or_else(|| {
                if turns
                    .iter()
                    .any(|turn| turn.kind == DialogTurnKind::UserDialog)
                {
                    fallback_agent_type
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned)
                } else {
                    None
                }
            })
    }

    /// Update session model id (in-memory + persistence)
    pub async fn update_session_model_id(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> OpenBitFunResult<()> {
        self.update_session_model_selection(session_id, model_id, None)
            .await
    }

    /// Atomically updates the model and optional reasoning preset.
    pub async fn update_session_model_selection(
        &self,
        session_id: &str,
        model_id: &str,
        reasoning_preset: Option<&str>,
    ) -> OpenBitFunResult<()> {
        let ai_config = Self::load_ai_config_for_model_resolution().await;
        let mut resolved_context_window = None;
        let mut auto_cleared_reasoning_preset = None;

        // If the session was evicted from memory (idle > 1h), try to restore it
        // using the storage path recorded when it was first created/restored.
        if !self.sessions.contains_key(session_id) && self.config.enable_persistence {
            let session_storage_path = self
                .session_storage_path_index
                .get(session_id)
                .map(|entry| entry.value().path.clone());
            if let Some(session_storage_path) = session_storage_path {
                debug!(
                    "Session evicted from memory, restoring for model update: session_id={}",
                    session_id
                );
                let _ = self
                    .restore_session_from_storage_path(&session_storage_path, session_id)
                    .await;
            }
        }

        // Restore owns the same keyed lock internally, so acquire the mutation
        // permit only after the optional restore completes. From here through
        // persistence, explicit deletion cannot remove and then be recreated by
        // a late model update.
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;

        let original_session = self
            .sessions
            .get(session_id)
            .map(|session| session.clone())
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;
        let mut updated_session = original_session.clone();
        updated_session.config.model_id = Some(model_id.to_string());
        updated_session.config.reasoning_preset = reasoning_preset
            .map(str::trim)
            .filter(|preset| !preset.is_empty() && !preset.eq_ignore_ascii_case("auto"))
            .map(ToOwned::to_owned);
        if let Some(ai_config) = ai_config.as_ref() {
            let requested_reasoning_preset = updated_session.config.reasoning_preset.clone();
            updated_session.config.reasoning_preset =
                Self::normalize_session_reasoning_preset(&updated_session, ai_config).await;
            if requested_reasoning_preset.is_some()
                && updated_session.config.reasoning_preset.is_none()
            {
                auto_cleared_reasoning_preset = requested_reasoning_preset.clone();
                warn!(
                    "Session reasoning preset is not available for the selected model; normalizing to Auto: session_id={}, model_id={}, preset_id={}",
                    session_id,
                    model_id,
                    requested_reasoning_preset.as_deref().unwrap_or_default()
                );
            }
            resolved_context_window =
                Self::sync_session_context_window_from_ai_config(&mut updated_session, ai_config);
        }
        let now = SystemTime::now();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            if let Some(workspace_path) = effective_path {
                if let Err(error) = self
                    .persistence_manager
                    .save_session(&workspace_path, &updated_session)
                    .await
                {
                    if let Err(rollback_error) = self
                        .persistence_manager
                        .save_session(&workspace_path, &original_session)
                        .await
                    {
                        return Err(OpenBitFunError::session(format!(
                            "Session model persistence failed and rollback did not complete: session_id={session_id}, error={error}, rollback_error={rollback_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }

        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.config.model_id = updated_session.config.model_id;
            session.config.reasoning_preset = updated_session.config.reasoning_preset.clone();
            session.config.max_context_tokens = updated_session.config.max_context_tokens;
            session.updated_at = now;
            session.last_activity_at = now;
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }

        debug!(
            "Session model selection updated: session_id={}, model_id={}, reasoning_preset={:?}, max_context_tokens={:?}",
            session_id,
            model_id,
            updated_session.config.reasoning_preset,
            resolved_context_window
        );

        if let Some(previous_preset_id) = auto_cleared_reasoning_preset {
            if let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() {
                coordinator
                    .emit_session_reasoning_preset_auto_cleared(
                        session_id,
                        &previous_preset_id,
                        "selection_unavailable",
                    )
                    .await;
            }
        }

        Ok(())
    }

    /// Sets the session's own tool permission mode (in-memory + persistence).
    ///
    /// `None` clears the override so the session follows the user-level default
    /// again, including later changes to that default. The value only takes
    /// effect from the next model round. A running round keeps the policy it
    /// resolved at its boundary, while later rounds read the updated session.
    pub async fn update_session_permission_mode(
        &self,
        session_id: &str,
        permission_mode: Option<PermissionMode>,
    ) -> OpenBitFunResult<()> {
        // Match the model-selection path: an evicted session is restored before
        // the mutation permit is taken, because restore owns the same keyed lock.
        if !self.sessions.contains_key(session_id) && self.config.enable_persistence {
            let session_storage_path = self
                .session_storage_path_index
                .get(session_id)
                .map(|entry| entry.value().path.clone());
            if let Some(session_storage_path) = session_storage_path {
                debug!(
                    "Session evicted from memory, restoring for permission mode update: session_id={}",
                    session_id
                );
                let _ = self
                    .restore_session_from_storage_path(&session_storage_path, session_id)
                    .await;
            }
        }

        let _mutation_guard = self.acquire_session_mutation(session_id).await?;

        let original_session = self
            .sessions
            .get(session_id)
            .map(|session| session.clone())
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;
        if original_session.config.permission_mode == permission_mode {
            return Ok(());
        }

        let mut updated_session = original_session.clone();
        updated_session.config.permission_mode = permission_mode;
        let now = SystemTime::now();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            if let Some(workspace_path) = effective_path {
                if let Err(error) = self
                    .persistence_manager
                    .save_session(&workspace_path, &updated_session)
                    .await
                {
                    // A selection that is not durable must not stay applied in
                    // memory, so restore the previous value before failing.
                    if let Err(rollback_error) = self
                        .persistence_manager
                        .save_session(&workspace_path, &original_session)
                        .await
                    {
                        return Err(OpenBitFunError::session(format!(
                            "Session permission mode persistence failed and rollback did not complete: session_id={session_id}, error={error}, rollback_error={rollback_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }

        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.config.permission_mode = permission_mode;
            session.updated_at = now;
            session.last_activity_at = now;
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }

        debug!(
            "Session permission mode updated: session_id={}, permission_mode={:?}",
            session_id, permission_mode
        );

        Ok(())
    }

    /// Reads the session's own permission mode without falling back to the
    /// user-level default. `None` means the session never chose one.
    pub fn session_permission_mode(&self, session_id: &str) -> Option<PermissionMode> {
        self.sessions
            .get(session_id)
            .and_then(|session| session.config.permission_mode)
    }

    /// Installs or replaces the ephemeral permission mode for one exact active
    /// turn. A stale update can never leak into a newer turn in the session.
    pub fn set_active_turn_permission_mode(
        &self,
        session_id: &str,
        turn_id: &str,
        permission_mode: PermissionMode,
    ) -> bool {
        let Some(session) = self.sessions.get(session_id) else {
            return false;
        };
        if !matches!(
            &session.state,
            SessionState::Processing { current_turn_id, .. } if current_turn_id == turn_id
        ) {
            return false;
        }

        // Keep the session shard read-locked through the write. A concurrent
        // turn-completion state update must happen after this insert, so its
        // cleanup cannot run just before a stale override is published.
        self.active_turn_permission_modes.insert(
            session_id.to_string(),
            ActiveTurnPermissionMode {
                turn_id: turn_id.to_string(),
                mode: permission_mode,
            },
        );
        true
    }

    pub fn active_turn_permission_mode(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Option<PermissionMode> {
        let session = self.sessions.get(session_id)?;
        if !matches!(
            &session.state,
            SessionState::Processing { current_turn_id, .. } if current_turn_id == turn_id
        ) {
            return None;
        }
        self.active_turn_permission_modes
            .get(session_id)
            .filter(|entry| entry.turn_id == turn_id)
            .map(|entry| entry.mode)
    }

    /// Clears an ephemeral override only when it belongs to the expected turn.
    pub fn clear_active_turn_permission_mode(&self, session_id: &str, turn_id: &str) -> bool {
        match self
            .active_turn_permission_modes
            .entry(session_id.to_string())
        {
            dashmap::mapref::entry::Entry::Occupied(entry) if entry.get().turn_id == turn_id => {
                entry.remove();
                true
            }
            _ => false,
        }
    }

    /// Rebind where a session executes (in-memory + persistence).
    ///
    /// Only the workspace roots and the resolved execution target move; session
    /// storage stays keyed on `project_workspace_path`, so the transcript keeps
    /// its identity when a session is moved into or out of a managed worktree.
    pub async fn update_session_execution_binding(
        &self,
        session_id: &str,
        binding: SessionExecutionBindingUpdate,
    ) -> Result<(), SessionExecutionBindingError> {
        // Mirrors update_session_model_id: an evicted session must be restored
        // before the mutation permit is taken. View-only historical restores do
        // not populate the storage-path index, so use the owning project path as
        // the stable fallback locator.
        if !self.sessions.contains_key(session_id) && self.config.enable_persistence {
            let session_storage_path = self
                .session_storage_path_index
                .get(session_id)
                .map(|entry| entry.value().path.clone());
            let restore_result = if let Some(session_storage_path) = session_storage_path {
                self.restore_session_from_storage_path(&session_storage_path, session_id)
                    .await
            } else {
                self.restore_session(Path::new(&binding.project_workspace_path), session_id)
                    .await
            };
            if let Err(restore_error) = restore_result {
                return match restore_error {
                    OpenBitFunError::NotFound(message) => {
                        Err(SessionExecutionBindingError::NotFound(message))
                    }
                    other => Err(SessionExecutionBindingError::Internal(other)),
                };
            }
        }

        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let mut has_persisted_turns = false;
        if self.should_persist_session_id(session_id) {
            if let Some(storage_path) = self.effective_session_storage_path(session_id).await {
                if self
                    .persistence_manager
                    .load_session_revert_state(&storage_path, session_id)
                    .await?
                    .is_some()
                {
                    return Err(SessionExecutionBindingError::Busy(
                        "Worktree isolation cannot change while Session undo or redo is pending"
                            .to_string(),
                    ));
                }
                has_persisted_turns = !self
                    .persistence_manager
                    .load_session_turns(&storage_path, session_id)
                    .await?
                    .is_empty();
            }
        }

        if let Some(mut session) = self.sessions.get_mut(session_id) {
            if has_persisted_turns
                || !session.dialog_turn_ids.is_empty()
                || !matches!(session.state, SessionState::Idle)
            {
                return Err(SessionExecutionBindingError::Busy(
                    "Worktree isolation can only be changed before the session's first message"
                        .to_string(),
                ));
            }
            session.config.workspace_path = Some(binding.workspace_path.clone());
            session.config.project_workspace_path = Some(binding.project_workspace_path.clone());
            session.config.execution_target = Some(binding.execution_target.clone());
            session.config.workspace_id = binding.workspace_id.clone();
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        } else {
            return Err(SessionExecutionBindingError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        }

        if self.should_persist_session_id(session_id) {
            let effective_path = self.effective_session_storage_path(session_id).await;
            let session_snapshot = self.sessions.get(session_id).map(|s| s.clone());
            if let (Some(workspace_path), Some(session)) = (effective_path, session_snapshot) {
                self.persistence_manager
                    .save_session(&workspace_path, &session)
                    .await?;
            }
        }

        debug!(
            "Session execution binding updated: session_id={}, workspace_path={}",
            session_id, binding.workspace_path
        );

        Ok(())
    }

    /// Sync session context window from AI config without requiring an explicit model_id.
    ///
    /// Subagent sessions created via `build_session_config_for_workspace` use
    /// `SessionConfig::default()` which hardcodes `max_context_tokens: 128128`.
    /// This method reloads the AI config and updates `max_context_tokens` to the
    /// model's actual configured `context_window`, so subagents with large-context
    /// models are not prematurely capped.
    pub async fn refresh_session_context_window(&self, session_id: &str) -> OpenBitFunResult<()> {
        if let Some(ai_config) = Self::load_ai_config_for_model_resolution().await {
            if let Some(mut session) = self.sessions.get_mut(session_id) {
                let previous = session.config.max_context_tokens;
                Self::sync_session_context_window_from_ai_config(&mut session, &ai_config);
                let updated = session.config.max_context_tokens;
                if updated != previous {
                    debug!(
                        "Refreshed session context window: session_id={}, previous={}, updated={}",
                        session_id, previous, updated
                    );
                }
            }
        }
        Ok(())
    }

    /// Update session activity time
    pub fn touch_session(&self, session_id: &str) {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.last_activity_at = SystemTime::now();
        }
    }

    async fn resolve_session_cleanup_workspace_path(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        fallback: &Path,
    ) -> PathBuf {
        if let Some(workspace_path) = self
            .sessions
            .get(session_id)
            .and_then(|session| session.config.workspace_path.as_deref().map(PathBuf::from))
        {
            return workspace_path;
        }

        if self.config.enable_persistence {
            if let Ok(Some(metadata)) = self
                .persistence_manager
                .load_session_metadata(session_storage_path, session_id)
                .await
            {
                if let Some(workspace_path) = metadata.workspace_path {
                    return PathBuf::from(workspace_path);
                }
            }
        }

        fallback.to_path_buf()
    }

    /// Delete session (cascade delete all resources)
    pub async fn delete_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        self.delete_session_locked(workspace_path, session_id).await
    }

    pub(crate) async fn delete_session_locked(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        let session_storage_path = self
            .resolve_storage_path_for_workspace_path(workspace_path)
            .await;
        self.validate_session_storage_path_binding(session_id, &session_storage_path)?;
        let cleanup_workspace_path = self
            .resolve_session_cleanup_workspace_path(
                &session_storage_path,
                session_id,
                workspace_path,
            )
            .await;
        self.delete_session_from_paths_locked(
            &cleanup_workspace_path,
            &session_storage_path,
            session_id,
        )
        .await
    }

    pub(crate) async fn delete_session_by_id(&self, session_id: &str) -> OpenBitFunResult<()> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.value().clone());
        let session_storage_path = if let Some(session) = session.as_ref() {
            self.effective_storage_path_for_config(&session.config)
                .await
                .or_else(|| {
                    self.session_storage_path_index
                        .get(session_id)
                        .map(|entry| entry.value().path.clone())
                })
        } else {
            self.session_storage_path_index
                .get(session_id)
                .map(|entry| entry.value().path.clone())
        };
        let Some(session_storage_path) = session_storage_path else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session storage path not found: {}",
                session_id
            )));
        };
        self.validate_session_storage_path_binding(session_id, &session_storage_path)?;
        let cleanup_workspace_path = self
            .resolve_session_cleanup_workspace_path(
                &session_storage_path,
                session_id,
                &session_storage_path,
            )
            .await;
        self.delete_session_from_paths_locked(
            &cleanup_workspace_path,
            &session_storage_path,
            session_id,
        )
        .await
    }

    /// Discards one loaded non-durable Session without touching persisted
    /// Session storage. Missing Sessions are an idempotent success.
    pub(crate) async fn discard_transient_session(
        &self,
        workspace_path: &Path,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let Some(root) = self.get_session(session_id) else {
            return Ok(false);
        };
        self.validate_transient_session_binding(
            &root,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
        )?;

        for descendant in self.transient_descendants_postorder(session_id) {
            let workspace_path = descendant
                .config
                .workspace_path
                .as_deref()
                .map(Path::new)
                .ok_or_else(|| {
                    OpenBitFunError::Validation(format!(
                        "Transient session workspace binding is missing: {}",
                        descendant.session_id
                    ))
                })?;
            self.discard_one_transient_session(
                workspace_path,
                descendant.config.remote_connection_id.as_deref(),
                descendant.config.remote_ssh_host.as_deref(),
                &descendant.session_id,
            )
            .await?;
        }

        self.discard_one_transient_session(
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
            session_id,
        )
        .await
    }

    pub(crate) fn transient_session_family_postorder(
        &self,
        workspace_path: &Path,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<String>> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let Some(root) = self.get_session(session_id) else {
            return Ok(Vec::new());
        };
        self.validate_transient_session_binding(
            &root,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
        )?;
        let mut family = self
            .transient_descendants_postorder(session_id)
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>();
        family.push(session_id.to_string());
        Ok(family)
    }

    fn transient_descendants_postorder(&self, root_session_id: &str) -> Vec<Session> {
        fn visit(
            parent_session_id: &str,
            sessions: &[Session],
            transient_session_ids: &DashMap<String, ()>,
            visited: &mut HashSet<String>,
            ordered: &mut Vec<Session>,
        ) {
            let marker = format!("session-{parent_session_id}");
            for child in sessions.iter().filter(|session| {
                transient_session_ids.contains_key(&session.session_id)
                    && session.created_by.as_deref() == Some(marker.as_str())
            }) {
                if !visited.insert(child.session_id.clone()) {
                    continue;
                }
                visit(
                    &child.session_id,
                    sessions,
                    transient_session_ids,
                    visited,
                    ordered,
                );
                ordered.push(child.clone());
            }
        }

        let sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut ordered = Vec::new();
        let mut visited = HashSet::from([root_session_id.to_string()]);
        visit(
            root_session_id,
            &sessions,
            &self.transient_session_ids,
            &mut visited,
            &mut ordered,
        );
        ordered
    }

    fn validate_transient_session_binding(
        &self,
        session: &Session,
        workspace_path: &Path,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> OpenBitFunResult<()> {
        if !self.is_transient_session(&session.session_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Cannot discard a durable session as transient: {}",
                session.session_id
            )));
        }
        let expected_workspace = Self::normalize_session_storage_path(workspace_path);
        let actual_workspace = session
            .config
            .workspace_path
            .as_deref()
            .map(Path::new)
            .map(Self::normalize_session_storage_path)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Transient session workspace binding is missing: {}",
                    session.session_id
                ))
            })?;
        if actual_workspace != expected_workspace
            || session.config.remote_connection_id.as_deref() != remote_connection_id
            || session.config.remote_ssh_host.as_deref() != remote_ssh_host
        {
            return Err(OpenBitFunError::Validation(format!(
                "Transient session ownership binding does not match: {}",
                session.session_id
            )));
        }
        Ok(())
    }

    async fn discard_one_transient_session(
        &self,
        workspace_path: &Path,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        let Some(session) = self.get_session(session_id) else {
            return Ok(false);
        };
        self.validate_transient_session_binding(
            &session,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
        )?;
        if matches!(session.state, SessionState::Processing { .. }) {
            return Err(OpenBitFunError::Validation(format!(
                "Cannot discard a processing transient session: {session_id}"
            )));
        }
        self.cleanup_session_owned_resources(
            session.config.workspace_id.as_deref(),
            session_id,
            SessionResourceCleanupPolicy::Required,
        )
        .await?;
        self.sessions.remove(session_id);
        self.transient_session_ids.remove(session_id);
        self.clear_turn_settlement_results(session_id);
        self.release_active_session_reservation(session_id);
        self.session_storage_path_index.remove(session_id);
        Ok(true)
    }

    /// Release one loaded session and its transient runtime stores while keeping
    /// persisted history and the storage-path binding available for a later restore.
    ///
    /// Callers must quiesce scheduler execution before unloading. A processing
    /// session is rejected so close/failure compensation cannot detach live work.
    pub(crate) async fn unload_session_from_memory(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        let Some(session) = self.get_session(session_id) else {
            return Ok(false);
        };
        if self.is_transient_session(session_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Cannot unload a transient session; use the owned discard path: {session_id}"
            )));
        }
        if matches!(session.state, SessionState::Processing { .. }) {
            return Err(OpenBitFunError::Validation(format!(
                "Cannot unload a processing session: {session_id}"
            )));
        }

        if self.config.enable_persistence && self.should_persist_session(&session) {
            let storage_path = self
                .effective_session_storage_path(session_id)
                .await
                .ok_or_else(|| {
                    OpenBitFunError::NotFound(format!(
                        "Session storage path is unavailable: {session_id}"
                    ))
                })?;
            self.persistence_manager
                .save_session(&storage_path, &session)
                .await?;
        }

        if self.sessions.remove(session_id).is_none() {
            return Ok(false);
        }
        self.clear_turn_settlement_results(session_id);
        self.release_active_session_reservation(session_id);
        self.active_turn_permission_modes.remove(session_id);
        clear_session_runtime_stores(
            session_id,
            self.context_store.as_ref(),
            self.prompt_cache_store.as_ref(),
            self.token_anchor_store.as_ref(),
            self.turn_skill_agent_snapshot_store.as_ref(),
            self.skill_agent_baseline_override_snapshot_store.as_ref(),
            self.review_read_receipt_store.as_ref(),
            self.evidence_ledger.as_ref(),
        );
        self.release_session_write_lock(session_id);
        Ok(true)
    }

    async fn cleanup_session_owned_resources(
        &self,
        workspace_id: Option<&str>,
        session_id: &str,
        policy: SessionResourceCleanupPolicy,
    ) -> OpenBitFunResult<()> {
        let mut required_error = None;
        let mut record_error = |stage: &'static str, error: String| {
            warn!(
                "Session resource cleanup failed: session_id={}, stage={}, error={}",
                session_id, stage, error
            );
            if policy == SessionResourceCleanupPolicy::Required && required_error.is_none() {
                required_error = Some(OpenBitFunError::Session(format!(
                    "Session resource cleanup is incomplete: session_id={session_id}, stage={stage}, error={error}"
                )));
            }
        };

        if let Some(snapshot_manager) =
            workspace_id.and_then(|id| ensure_snapshot_manager_for_workspace(id).ok())
        {
            let snapshot_service = snapshot_manager.get_snapshot_service();
            let snapshot_service = snapshot_service.read().await;
            if let Err(error) = snapshot_service.accept_session(session_id).await {
                record_error("snapshot", error.to_string());
            }
        }

        self.active_turn_permission_modes.remove(session_id);
        clear_session_runtime_stores(
            session_id,
            self.context_store.as_ref(),
            self.prompt_cache_store.as_ref(),
            self.token_anchor_store.as_ref(),
            self.turn_skill_agent_snapshot_store.as_ref(),
            self.skill_agent_baseline_override_snapshot_store.as_ref(),
            self.review_read_receipt_store.as_ref(),
            self.evidence_ledger.as_ref(),
        );

        if let Some(cron) = crate::service::cron::get_global_cron_service() {
            match cron.delete_jobs_for_session(session_id).await {
                Ok(removed) if removed > 0 => info!(
                    "Removed {} scheduled job(s) for session_id={}",
                    removed, session_id
                ),
                Ok(_) => {}
                Err(error) => record_error("cron", error.to_string()),
            }
        }

        use crate::service::terminal::TerminalApi;
        if let Ok(terminal_api) = TerminalApi::from_singleton() {
            let binding = terminal_api.session_manager().binding();
            if let Err(error) = binding.remove(session_id).await {
                record_error("terminal", error.to_string());
            }
        }

        if let Some(error) = required_error {
            return Err(error);
        }
        Ok(())
    }

    async fn delete_session_from_paths_locked(
        &self,
        cleanup_workspace_path: &Path,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        let delete_started_at = Instant::now();
        let cleanup_workspace_id = self
            .resolve_session_workspace_binding(session_id)
            .await
            .and_then(|binding| binding.workspace_id);
        let _temporary_write_lock = if self.config.enable_persistence
            && !self.is_transient_session(session_id)
            && !self.session_write_locks.contains_key(session_id)
        {
            Some(self.try_acquire_session_write_lock(session_storage_path, session_id)?)
        } else {
            None
        };
        debug!(
            "Session deletion started: session_id={}, cleanup_workspace_path={}, session_storage_path={}, persistence_enabled={}",
            session_id,
            cleanup_workspace_path.display(),
            session_storage_path.display(),
            self.config.enable_persistence
        );

        // Persisted deletion is the only fallible required stage. Complete it
        // before mutating loaded runtime state so a storage failure leaves the
        // active session usable and retryable.
        if self.config.enable_persistence {
            let revert_state = self
                .persistence_manager
                .load_session_revert_state(session_storage_path, session_id)
                .await?;
            if revert_state
                .as_ref()
                .is_some_and(|state| state.phase != SessionRevertPhase::Staged)
            {
                return Err(OpenBitFunError::OutcomeUnknown(format!(
                    "Session deletion cannot discard an unfinished revert transition: session_id={session_id}"
                )));
            }
            let persistence_stage_started_at = Instant::now();
            debug!(
                "Session deletion stage starting: session_id={}, stage=persistence_delete",
                session_id
            );
            self.persistence_manager
                .delete_session(session_storage_path, session_id)
                .await?;
            debug!(
                "Session deletion stage completed: session_id={}, stage=persistence_delete, duration_ms={}",
                session_id,
                elapsed_ms_u64(persistence_stage_started_at)
            );
            if let (Some(revert_state), Some(workspace_id)) =
                (revert_state, cleanup_workspace_id.as_deref())
            {
                match get_or_create_snapshot_manager(workspace_id, None)
                .await
                {
                    Ok(snapshot_manager) => {
                        if let Err(error) = snapshot_manager
                            .delete_workspace_revert_checkpoint(&revert_state)
                            .await
                        {
                            warn!(
                                "Failed to delete Session revert checkpoint after Session deletion: session_id={}, error={}",
                                session_id, error
                            );
                        }
                    }
                    Err(error) => warn!(
                        "Failed to initialize snapshot cleanup for deleted Session revert checkpoint: session_id={}, error={}",
                        session_id, error
                    ),
                }
            }
        }

        self.cleanup_session_owned_resources(
            cleanup_workspace_id.as_deref(),
            session_id,
            SessionResourceCleanupPolicy::BestEffort,
        )
        .await?;

        // 4. Remove from memory
        let memory_stage_started_at = Instant::now();
        debug!(
            "Session deletion stage starting: session_id={}, stage=in_memory_remove",
            session_id
        );
        self.sessions.remove(session_id);
        self.transient_session_ids.remove(session_id);
        self.clear_turn_settlement_results(session_id);
        self.release_active_session_reservation(session_id);
        debug!(
            "Session deletion stage completed: session_id={}, stage=in_memory_remove, duration_ms={}",
            session_id,
            elapsed_ms_u64(memory_stage_started_at)
        );
        self.session_storage_path_index.remove(session_id);
        self.release_session_write_lock(session_id);

        info!(
            "Session deletion completed: session_id={}, cleanup_workspace_path={}, session_storage_path={}, duration_ms={}",
            session_id,
            cleanup_workspace_path.display(),
            session_storage_path.display(),
            elapsed_ms_u64(delete_started_at)
        );

        Ok(())
    }

    /// Restore session from a local or legacy workspace path.
    ///
    /// Callers that know remote identity must use [`Self::restore_session_for_workspace`].
    /// Callers that already resolved a `sessions` directory must use
    /// [`Self::restore_session_from_storage_path`].
    pub async fn restore_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        self.restore_session_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_session_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        self.restore_session_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_internal_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        self.restore_internal_session_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_internal_session_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        self.restore_internal_session_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_session_from_storage_path(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        self.restore_session_from_storage_path_internal(session_storage_path, session_id, false)
            .await
    }

    pub async fn restore_internal_session_from_storage_path(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Session> {
        self.restore_session_from_storage_path_internal(session_storage_path, session_id, true)
            .await
    }

    async fn restore_session_from_storage_path_internal(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<Session> {
        let (session, _) = self
            .restore_session_with_turns_from_storage_path_internal(
                session_storage_path,
                session_id,
                include_internal,
            )
            .await?;
        Ok(session)
    }

    /// Restore the persisted session header and turns needed by the UI view
    /// without loading runtime context snapshots or inserting the session into
    /// the in-memory coordinator state.
    ///
    /// This workspace-path overload is for local or legacy callers. Remote
    /// callers must use [`Self::restore_session_view_for_workspace_timed`] or a
    /// storage-path restore method so remote identity is preserved.
    pub async fn restore_session_view(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        self.restore_session_view_timed(workspace_path, session_id)
            .await
            .map(|(session, turns, _)| (session, turns))
    }

    pub async fn restore_session_view_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, mut timing) = self
            .restore_session_view_from_storage_path_timed(&session_storage_path, session_id)
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, timing))
    }

    pub async fn restore_session_view_for_workspace_timed(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, mut timing) = self
            .restore_session_view_from_storage_path_timed(&session_storage_path, session_id)
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, timing))
    }

    pub async fn restore_internal_session_view(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        self.restore_internal_session_view_timed(workspace_path, session_id)
            .await
            .map(|(session, turns, _)| (session, turns))
    }

    pub async fn restore_internal_session_view_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, mut timing) = self
            .restore_internal_session_view_from_storage_path_timed(
                &session_storage_path,
                session_id,
            )
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, timing))
    }

    pub async fn restore_internal_session_view_for_workspace_timed(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, mut timing) = self
            .restore_internal_session_view_from_storage_path_timed(
                &session_storage_path,
                session_id,
            )
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, timing))
    }

    pub async fn restore_session_view_tail(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, usize)> {
        self.restore_session_view_tail_timed(workspace_path, session_id, tail_turn_count)
            .await
            .map(|(session, turns, total_turn_count, _)| (session, turns, total_turn_count))
    }

    pub async fn restore_session_view_tail_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionViewRestoreTiming,
    )> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, total_turn_count, mut timing) = self
            .restore_session_view_from_storage_path_tail_timed(
                &session_storage_path,
                session_id,
                tail_turn_count,
            )
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, total_turn_count, timing))
    }

    pub async fn restore_internal_session_view_tail(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, usize)> {
        self.restore_internal_session_view_tail_timed(workspace_path, session_id, tail_turn_count)
            .await
            .map(|(session, turns, total_turn_count, _)| (session, turns, total_turn_count))
    }

    pub async fn restore_internal_session_view_tail_timed(
        &self,
        workspace_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionViewRestoreTiming,
    )> {
        let storage_path_started_at = Instant::now();
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        let resolve_storage_path_duration_ms = elapsed_ms_u64(storage_path_started_at);
        let (session, turns, total_turn_count, mut timing) = self
            .restore_internal_session_view_from_storage_path_tail_timed(
                &session_storage_path,
                session_id,
                tail_turn_count,
            )
            .await?;
        timing.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok((session, turns, total_turn_count, timing))
    }

    pub async fn restore_session_view_from_storage_path_timed(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        self.restore_session_view_from_storage_path_internal(
            session_storage_path,
            session_id,
            false,
            None,
        )
        .await
        .map(|(session, turns, _, timing)| (session, turns, timing))
    }

    pub async fn restore_internal_session_view_from_storage_path_timed(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>, SessionViewRestoreTiming)> {
        self.restore_session_view_from_storage_path_internal(
            session_storage_path,
            session_id,
            true,
            None,
        )
        .await
        .map(|(session, turns, _, timing)| (session, turns, timing))
    }

    pub async fn restore_session_view_from_storage_path_tail_timed(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionViewRestoreTiming,
    )> {
        self.restore_session_view_from_storage_path_internal(
            session_storage_path,
            session_id,
            false,
            Some(tail_turn_count),
        )
        .await
    }

    pub async fn restore_internal_session_view_from_storage_path_tail_timed(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        tail_turn_count: usize,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionViewRestoreTiming,
    )> {
        self.restore_session_view_from_storage_path_internal(
            session_storage_path,
            session_id,
            true,
            Some(tail_turn_count),
        )
        .await
    }

    async fn restore_session_view_from_storage_path_internal(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        include_internal: bool,
        tail_turn_count: Option<usize>,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionViewRestoreTiming,
    )> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let restore_started_at = Instant::now();
        let resolve_storage_path_duration_ms = 0;
        debug!(
            "Session view restore phase completed: session_id={}, phase=use_storage_path, duration_ms={}",
            session_id, resolve_storage_path_duration_ms
        );

        let metadata_started_at = Instant::now();
        if self
            .persistence_manager
            .load_session_metadata(session_storage_path, session_id)
            .await?
            .is_some_and(|metadata| !include_internal && metadata.should_hide_from_user_lists())
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        let visibility_metadata_duration_ms = elapsed_ms_u64(metadata_started_at);
        debug!(
            "Session view restore phase completed: session_id={}, phase=load_metadata, duration_ms={}",
            session_id, visibility_metadata_duration_ms
        );

        let staged_revert = self
            .persistence_manager
            .load_session_revert_state(session_storage_path, session_id)
            .await?;
        let effective_tail_turn_count = staged_revert
            .as_ref()
            .map(|_| None)
            .unwrap_or(tail_turn_count);
        let session_started_at = Instant::now();
        let (mut session, mut persisted_turns, mut total_turn_count, turn_load) =
            if let Some(tail_turn_count) = effective_tail_turn_count {
                self.persistence_manager
                    .load_session_with_tail_turns_timed(
                        session_storage_path,
                        session_id,
                        tail_turn_count,
                    )
                    .await?
            } else {
                let (session, turns, timing) = self
                    .persistence_manager
                    .load_session_with_turns_timed(session_storage_path, session_id)
                    .await?;
                let total_turn_count = turns.len();
                (session, turns, total_turn_count, timing)
            };
        if let Some(revert) = staged_revert.as_ref() {
            persisted_turns.retain(|turn| turn.turn_index < revert.boundary_turn);
            total_turn_count = persisted_turns.len();
        }
        let load_session_with_turns_duration_ms = elapsed_ms_u64(session_started_at);
        debug!(
            "Session view restore phase completed: session_id={}, phase=load_session_with_turns, turn_count={}, total_turn_count={}, tail_turn_count={:?}, duration_ms={}",
            session_id,
            persisted_turns.len(),
            total_turn_count,
            tail_turn_count,
            load_session_with_turns_duration_ms
        );

        if !matches!(session.state, SessionState::Idle) {
            let old_state = session.state.clone();
            session.state = SessionState::Idle;
            debug!(
                "Resetting session state during view restore: session_id={}, state={:?} -> Idle",
                session_id, old_state
            );
        }

        let normalize_started_at = Instant::now();
        let persisted_turn_ids: Vec<String> = persisted_turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect();
        if session.dialog_turn_ids != persisted_turn_ids {
            debug!(
                "Session view restore normalized turn ids: session_id={}, session_turn_count={}, persisted_turn_count={}",
                session_id,
                session.dialog_turn_ids.len(),
                persisted_turn_ids.len()
            );
            session.dialog_turn_ids = persisted_turn_ids;
        }
        let normalize_turn_ids_duration_ms = elapsed_ms_u64(normalize_started_at);

        let total_duration_ms = elapsed_ms_u64(restore_started_at);
        debug!(
            "Session view restored: session_id={}, session_name={}, turn_count={}, total_duration_ms={}",
            session_id,
            session.session_name,
            persisted_turns.len(),
            total_duration_ms
        );

        let timing = SessionViewRestoreTiming {
            resolve_storage_path_duration_ms,
            visibility_metadata_duration_ms,
            load_session_with_turns_duration_ms,
            normalize_turn_ids_duration_ms,
            turn_catalog_duration_ms: 0,
            total_duration_ms,
            turn_load,
        };

        Ok((session, persisted_turns, total_turn_count, timing))
    }

    /// Restore session and return the persisted turns read during restore.
    ///
    /// This workspace-path overload is for local or legacy callers. Remote
    /// callers must use [`Self::restore_session_with_turns_for_workspace`] or a
    /// storage-path restore method so remote identity is preserved.
    pub async fn restore_session_with_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        self.restore_session_with_turns_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_session_with_turns_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        self.restore_session_with_turns_from_storage_path(&session_storage_path, session_id)
            .await
    }

    pub async fn restore_internal_session_with_turns(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        self.restore_internal_session_with_turns_from_storage_path(
            &session_storage_path,
            session_id,
        )
        .await
    }

    pub async fn restore_internal_session_with_turns_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let session_storage_path = self.resolve_storage_path_for_request(request).await?;
        self.restore_internal_session_with_turns_from_storage_path(
            &session_storage_path,
            session_id,
        )
        .await
    }

    pub async fn restore_session_with_turns_from_storage_path(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        self.restore_session_with_turns_from_storage_path_internal(
            session_storage_path,
            session_id,
            false,
        )
        .await
    }

    pub async fn restore_internal_session_with_turns_from_storage_path(
        &self,
        session_storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        self.restore_session_with_turns_from_storage_path_internal(
            session_storage_path,
            session_id,
            true,
        )
        .await
    }

    async fn restore_session_with_turns_from_storage_path_internal(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        let _evidence_ledger_guard = self.evidence_ledger_operation_locks.lock(session_id).await;

        if self.is_session_loaded_from_storage_path(session_storage_path, session_id)? {
            let session = self.get_session(session_id).ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Session not found after identity check: {session_id}"
                ))
            })?;
            let (_, turns, _) = if include_internal {
                self.restore_internal_session_view_from_storage_path_timed(
                    session_storage_path,
                    session_id,
                )
                .await?
            } else {
                self.restore_session_view_from_storage_path_timed(session_storage_path, session_id)
                    .await?
            };
            return Ok((session, turns));
        }

        let session_write_lock = if self.config.enable_persistence {
            Some(self.try_acquire_session_write_lock(session_storage_path, session_id)?)
        } else {
            None
        };
        let claimed = self.claim_session_storage_path(session_id, session_storage_path, true)?;
        let result = self
            .restore_session_with_turns_from_claimed_storage_path_internal(
                session_storage_path,
                session_id,
                include_internal,
            )
            .await;
        if result.is_err() {
            self.release_failed_session_storage_path_claim(
                session_id,
                session_storage_path,
                claimed,
            );
        } else if let Some(write_lock) = session_write_lock {
            self.commit_session_write_lock(session_id, write_lock);
        }
        result
    }

    async fn restore_session_with_turns_from_claimed_storage_path_internal(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        let restore_started_at = Instant::now();
        // Check if session is already in memory
        let session_already_in_memory = self.sessions.contains_key(session_id);
        let active_session_permit = if session_already_in_memory {
            None
        } else {
            Some(self.reserve_active_session()?)
        };

        debug!(
            "Session restore phase completed: session_id={}, phase=use_storage_path, duration_ms=0",
            session_id
        );

        let metadata_started_at = Instant::now();
        let session_metadata = self
            .persistence_manager
            .load_session_metadata(session_storage_path, session_id)
            .await?;
        if session_metadata
            .as_ref()
            .is_some_and(|metadata| !include_internal && metadata.should_hide_from_user_lists())
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        let listing_baseline_rebuild_turn_index =
            Self::listing_baseline_rebuild_turn_index_from_metadata(session_metadata.as_ref());
        let restored_edit_constraint_state =
            Self::edit_constraint_state_from_metadata(session_metadata.as_ref());
        debug!(
            "Session restore phase completed: session_id={}, phase=load_metadata, duration_ms={}",
            session_id,
            elapsed_ms_u64(metadata_started_at)
        );

        // 1. Load session and turns from storage in one pass
        let session_started_at = Instant::now();
        let (mut session, mut persisted_turns) = self
            .persistence_manager
            .load_session_with_turns(session_storage_path, session_id)
            .await?;
        let staged_revert = self
            .persistence_manager
            .load_session_revert_state(session_storage_path, session_id)
            .await?;
        if let Some(revert) = staged_revert.as_ref() {
            persisted_turns.retain(|turn| turn.turn_index < revert.boundary_turn);
        }
        let surviving_turn_ids: HashSet<String> = persisted_turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect();
        let all_evidence_events = self
            .persistence_manager
            .load_evidence_ledger_events(session_storage_path, session_id)
            .await?;
        let restored_evidence_events = all_evidence_events
            .iter()
            .filter(|event| surviving_turn_ids.contains(&event.turn_id))
            .cloned()
            .collect::<Vec<_>>();
        // Converge the sidecar to surviving turns when there is no staged undo
        // marker. A staged undo keeps the full sidecar on disk so a later redo
        // can restore hidden evidence. Without this convergence, a stale event
        // left by an older build (or a previous rollback) would re-enter memory
        // on the next evidence append.
        if staged_revert.is_none() && self.config.enable_persistence {
            let should_converge = self
                .sessions
                .get(session_id)
                .is_some_and(|session| self.should_persist_session(&session))
                || !session_already_in_memory;
            if should_converge {
                let converged_events = restored_evidence_events.clone();
                self.persistence_manager
                    .save_evidence_ledger_events(session_storage_path, session_id, converged_events)
                    .await?;
            }
        }
        debug!(
            "Session restore phase completed: session_id={}, phase=load_session_with_turns, turn_count={}, duration_ms={}",
            session_id,
            persisted_turns.len(),
            elapsed_ms_u64(session_started_at)
        );

        let ai_config_for_restore = Self::load_ai_config_for_model_resolution().await;
        let mut should_persist_restored_session = false;
        let mut fallback_previous_model_id = None;
        let mut auto_cleared_reasoning_preset = None;

        if !include_internal {
            let external_sources_supported =
                cfg!(feature = "external-sources") && !session.config.is_remote_workspace();
            #[cfg(feature = "external-sources")]
            if external_sources_supported {
                if let Err(error) =
                    crate::external_sources::ensure_external_source_workspace_snapshot(
                        session.config.workspace_id.as_deref(),
                    )
                    .await
                {
                    warn!(
                        "External agent source discovery failed during session restore: session_id={}, error_category={}",
                        session.session_id,
                        crate::external_sources::external_integration_error_code(&error),
                    );
                }
            }
            let agent_registry = get_agent_registry();
            agent_registry
                .load_custom_agents(session.config.workspace_id.as_deref())
                .await;
            let available_modes = agent_registry
                .get_modes_info_for_workspace(
                    session.config.workspace_id.as_deref(),
                    external_sources_supported,
                )
                .await;
            let persisted_binding = agent_registry.resolve_primary_agent_for_turn_with_route(
                &session.agent_type,
                session.config.workspace_id.as_deref(),
                external_sources_supported,
                Some(session.config.agent_route_owner),
                session.config.agent_route_key.as_deref(),
            );
            if let Some(binding) = persisted_binding {
                // A missing local route key is a valid legacy binding. Local
                // resolution is already constrained by the persisted owner, so
                // avoid rewriting the runtime state solely to backfill it.
                // External bindings still persist their exact provider route
                // key to prevent a same-name provider from taking over.
                let external_route_key_changed = session.config.agent_route_owner
                    == SessionAgentRouteOwner::External
                    && session.config.agent_route_key != binding.route_key;
                if session.config.agent_route_owner != binding.route_owner
                    || external_route_key_changed
                {
                    session.config.agent_route_owner = binding.route_owner;
                    session.config.agent_route_key = binding.route_key;
                    should_persist_restored_session = true;
                }
            } else if session.config.agent_route_owner == SessionAgentRouteOwner::External {
                warn!(
                    "Persisted external main agent is currently unavailable; preserving fail-closed session binding: session_id={}, persisted_mode={}",
                    session.session_id, session.agent_type
                );
            } else {
                let fallback_mode = available_modes
                    .iter()
                    .find(|mode| mode.id == "Standard")
                    .or_else(|| available_modes.first())
                    .map(|mode| mode.id.clone())
                    .ok_or_else(|| {
                        OpenBitFunError::Validation(
                            "No executable main agent mode is available for session restore"
                                .to_string(),
                        )
                    })?;
                warn!(
                    "Persisted session mode is unavailable; applying executable fallback: session_id={}, persisted_mode={}, fallback_mode={}",
                    session.session_id, session.agent_type, fallback_mode
                );
                session.agent_type = fallback_mode;
                session.config.agent_route_owner = SessionAgentRouteOwner::Local;
                session.config.agent_route_key = None;
                should_persist_restored_session = true;
            }
        }

        // Restore fallback: if the persisted model_id is no longer usable
        // (model deleted, disabled, or from a retired selector), repoint it to
        // the primary selector before the session re-enters memory.
        if let Some(persisted_model_id) = session.config.model_id.as_deref() {
            let trimmed = persisted_model_id.trim();
            let needs_fallback = if trimmed.is_empty()
                || !session_model_allows_fallback(session.config.model_binding_policy)
            {
                false
            } else if let Some(ai_config) = ai_config_for_restore.as_ref() {
                !Self::is_session_model_id_usable(ai_config, trimmed)
            } else {
                false
            };

            if needs_fallback {
                warn!(
                    "Session restore detected stale model_id; falling back to primary: session_id={}, previous_model_id={}",
                    session_id, trimmed
                );
                let previous_model_id = trimmed.to_string();
                session.config.model_id = Some("primary".to_string());
                should_persist_restored_session = true;
                fallback_previous_model_id = Some(previous_model_id);
            }
        }

        if let Some(ai_config) = ai_config_for_restore.as_ref() {
            let previous_reasoning_preset = session.config.reasoning_preset.clone();
            session.config.reasoning_preset =
                Self::normalize_session_reasoning_preset(&session, ai_config).await;
            if previous_reasoning_preset.is_some() && session.config.reasoning_preset.is_none() {
                auto_cleared_reasoning_preset = previous_reasoning_preset.clone();
                warn!(
                    "Session restore detected stale reasoning preset; normalizing to Auto: session_id={}, preset_id={}",
                    session_id,
                    previous_reasoning_preset.as_deref().unwrap_or_default()
                );
                should_persist_restored_session = true;
            }

            let previous_max_context_tokens = session.config.max_context_tokens;
            if let Some(context_window) =
                Self::sync_session_context_window_from_ai_config(&mut session, ai_config)
            {
                if context_window != previous_max_context_tokens {
                    should_persist_restored_session = true;
                    debug!(
                        "Session context window refreshed during restore: session_id={}, previous={}, resolved={}",
                        session_id, previous_max_context_tokens, context_window
                    );
                }
            }
        }

        // Reset session state to Idle
        // After application restart, previous Processing state is invalid and must be reset
        let previous_state_was_not_idle = !matches!(session.state, SessionState::Idle);
        let mut interrupted_recovery_restored_turn = None;
        if previous_state_was_not_idle {
            let old_state = session.state.clone();
            session.state = SessionState::Idle;
            should_persist_restored_session = true;
            debug!(
                "Resetting session state during restore: session_id={}, state={:?} -> Idle",
                session_id, old_state
            );
        }

        // A process exit can happen after the recovering Turn write but before
        // the Processing Session write, or after both. No execution survives
        // restart, so normalize from the durable Turn fact independently of
        // the stale Session state.
        if let Some(turn) = persisted_turns.last_mut().filter(|turn| {
            turn.status == TurnStatus::InProgress
                && turn
                    .recovery
                    .as_ref()
                    .is_some_and(|recovery| recovery.status == DialogTurnRecoveryStatus::Recovering)
        }) {
            let now = SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            turn.status = TurnStatus::Cancelled;
            turn.finish_reason = Some("interrupted".to_string());
            turn.end_time = Some(now);
            turn.duration_ms = Some(now.saturating_sub(turn.start_time));
            if let Some(recovery) = turn.recovery.as_mut() {
                recovery.status = DialogTurnRecoveryStatus::Interrupted;
                recovery.interrupted_at = Some(now);
                turn.recovery_epoch = Some(recovery.execution_generation);
            }
            interrupted_recovery_restored_turn = Some(turn.clone());
            should_persist_restored_session = true;
            info!(
                "Restored abandoned recovery generation as interrupted: session_id={}, turn_id={}",
                session_id, turn.turn_id
            );
        }

        // 2. Restore runtime context with snapshot-first semantics.
        // If the latest snapshot lags behind turn persistence, append the missing turn delta
        // instead of truncating session history.
        //
        // This compensates for the fact that persistence is not transactional across
        // `session.json`, `turns/*.json`, and `snapshots/context-*.json`.
        let persisted_turn_ids: Vec<String> = persisted_turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect();
        session.last_user_dialog_agent_type = Self::derive_last_user_dialog_agent_type_from_turns(
            &persisted_turns,
            Some(session.agent_type.as_str()),
        );
        let mut latest_turn_index: Option<usize> = None;
        let context_snapshot_started_at = Instant::now();
        let latest_context_snapshot = match staged_revert.as_ref() {
            Some(revert) => {
                self.persistence_manager
                    .load_latest_turn_context_snapshot_before(
                        session_storage_path,
                        session_id,
                        revert.boundary_turn,
                    )
                    .await?
            }
            None => {
                self.persistence_manager
                    .load_latest_turn_context_snapshot(session_storage_path, session_id)
                    .await?
            }
        };
        let mut messages = match latest_context_snapshot {
            Some((turn_index, msgs)) => {
                latest_turn_index = Some(turn_index);
                self.sanitize_listing_diff_context_snapshot_if_needed(
                    session_storage_path,
                    session_id,
                    turn_index,
                    msgs,
                    listing_baseline_rebuild_turn_index,
                    "restore_pre_listing_baseline_rebuild_snapshot",
                )
                .await
            }
            None => Self::build_messages_from_turns(&persisted_turns),
        };
        debug!(
            "Session restore phase completed: session_id={}, phase=load_context_snapshot, snapshot_turn_index={:?}, message_count={}, duration_ms={}",
            session_id,
            latest_turn_index,
            messages.len(),
            elapsed_ms_u64(context_snapshot_started_at)
        );

        if let Some(snapshot_turn_index) = latest_turn_index {
            let delta_turns = persisted_turns
                .iter()
                .filter(|turn| turn.turn_index > snapshot_turn_index)
                .cloned()
                .collect::<Vec<_>>();
            if !delta_turns.is_empty() {
                warn!(
                    "Context snapshot is behind persisted turns, rebuilding delta: session_id={}, snapshot_turn_index={}, persisted_turn_count={}",
                    session_id,
                    snapshot_turn_index,
                    persisted_turns.len()
                );
                messages.extend(Self::build_messages_from_turns(&delta_turns));
            }
        };

        if messages.is_empty() {
            debug!(
                "Session {} has empty persisted messages (may be new session)",
                session_id
            );
        }

        let recoverable_turn_count = if staged_revert.is_some() {
            persisted_turns.len()
        } else {
            latest_turn_index
                .map(|turn_index| turn_index + 1)
                .unwrap_or(0)
                .max(persisted_turns.len())
        };

        if session.dialog_turn_ids.len() < persisted_turns.len() {
            warn!(
                "Session metadata is behind persisted turns, rebuilding dialog_turn_ids: session_id={}, session_turn_count={}, persisted_turn_count={}",
                session_id,
                session.dialog_turn_ids.len(),
                persisted_turns.len()
            );
            session.dialog_turn_ids = persisted_turn_ids;
            should_persist_restored_session = true;
        } else if session.dialog_turn_ids.len() > recoverable_turn_count {
            warn!(
                "Session metadata exceeds recoverable history, truncating: session_id={}, session_turn_count={}, recoverable_turn_count={}",
                session_id,
                session.dialog_turn_ids.len(),
                recoverable_turn_count
            );
            session.dialog_turn_ids.truncate(recoverable_turn_count);
            should_persist_restored_session = true;
        } else if persisted_turns.len() == session.dialog_turn_ids.len()
            && session.dialog_turn_ids != persisted_turn_ids
        {
            warn!(
                "Session metadata turn ids diverge from persisted turns, normalizing order: session_id={}",
                session_id
            );
            session.dialog_turn_ids = persisted_turn_ids;
            should_persist_restored_session = true;
        }

        if recoverable_turn_count == 0 && !session.dialog_turn_ids.is_empty() && messages.is_empty()
        {
            warn!(
                "Session has no available context snapshot and messages are empty, clearing turns: session_id={}",
                session_id
            );
            session.dialog_turn_ids.clear();
            should_persist_restored_session = true;
        }

        // Complete all fallible restore migrations before publishing any runtime state.
        // A failed write keeps the session unloaded; restore-time recovery handles any
        // partial metadata/state update left by the existing multi-file persistence format.
        if let Some(turn) = interrupted_recovery_restored_turn.as_ref() {
            self.persistence_manager
                .save_dialog_turn(session_storage_path, turn)
                .await?;
        }
        if should_persist_restored_session && self.should_persist_session_id(session_id) {
            self.persistence_manager
                .save_session(session_storage_path, &session)
                .await?;
        }

        // Finish async notifications before publishing runtime state. If restore is
        // cancelled or times out before publication, the temporary write lock drops
        // together with this future and no writable in-memory Session remains.
        if let Some(previous_model_id) = fallback_previous_model_id {
            if let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() {
                coordinator
                    .emit_session_model_fallback_applied(
                        session_id,
                        &previous_model_id,
                        "primary",
                        "model_unavailable_on_restore",
                    )
                    .await;
            }
        }
        if let Some(previous_preset_id) = auto_cleared_reasoning_preset {
            if let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() {
                coordinator
                    .emit_session_reasoning_preset_auto_cleared(
                        session_id,
                        &previous_preset_id,
                        "preset_unavailable_on_restore",
                    )
                    .await;
            }
        }

        // 3. Publish the recovered runtime context only after migrations are durable.
        if session_already_in_memory {
            clear_session_runtime_stores(
                session_id,
                self.context_store.as_ref(),
                self.prompt_cache_store.as_ref(),
                self.token_anchor_store.as_ref(),
                self.turn_skill_agent_snapshot_store.as_ref(),
                self.skill_agent_baseline_override_snapshot_store.as_ref(),
                self.review_read_receipt_store.as_ref(),
                self.evidence_ledger.as_ref(),
            );
        }
        self.evidence_ledger
            .replace_session(session_id, restored_evidence_events)
            .map_err(|error| OpenBitFunError::parse(error.to_string()))?;

        let context_replace_started_at = Instant::now();
        self.context_store
            .replace_context(session_id, messages.clone());
        debug!(
            "Session restore phase completed: session_id={}, phase=replace_context, message_count={}, duration_ms={}",
            session_id,
            messages.len(),
            elapsed_ms_u64(context_replace_started_at)
        );
        let context_msg_count = self.context_store.get_context_messages(session_id).len();

        debug!(
            "Session restored: session_id={}, session_name={}, messages={}, context_messages={}, turn_count={}, total_duration_ms={}",
            session_id,
            session.session_name,
            messages.len(),
            context_msg_count,
            persisted_turns.len(),
            elapsed_ms_u64(restore_started_at)
        );

        // Do not infer unread completion from persisted runtime state during restore.
        // Older IDE versions could leave sessions in non-idle states on disk; treating those
        // as completed would surface misleading unread indicators after an upgrade.
        // Unread completion is now written only by runtime completion/persist paths.

        // 4. Add to memory (will overwrite if already exists)
        self.sessions
            .insert(session_id.to_string(), session.clone());
        if let Some(permit) = active_session_permit {
            self.commit_active_session_reservation(session_id, permit);
        }
        self.bind_session_storage_path_committed(session_id, session_storage_path.to_path_buf());

        if let Some(state) = restored_edit_constraint_state {
            self.edit_constraints_store
                .insert(session_id.to_string(), state);
        }

        Ok((session, persisted_turns))
    }

    /// Rollback "model context" to before the start of specified turn (i.e., keep 0..target_turn-1)
    pub async fn rollback_context_to_turn_start(
        &self,
        workspace_path: &Path,
        session_id: &str,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        let session_storage_path = self
            .resolve_storage_path_for_restore_workspace_path(workspace_path)
            .await?;
        if !self.sessions.contains_key(session_id) && self.config.enable_persistence {
            self.restore_session_from_storage_path(&session_storage_path, session_id)
                .await?;
        }
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        self.validate_session_storage_path_binding(session_id, &session_storage_path)?;
        self.rollback_context_to_turn_start_locked(&session_storage_path, session_id, target_turn)
            .await
    }

    /// Move the loaded Session to a persisted staged-revert boundary without
    /// deleting any turn, context snapshot, compression artifact, or evidence
    /// sidecar. The durable `session-revert.json` remains the authoritative
    /// visibility fact, and the complete sidecar lets a later redo restore the
    /// hidden evidence.
    pub(crate) async fn apply_staged_revert_context_locked(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        boundary_turn: usize,
    ) -> OpenBitFunResult<()> {
        let turns = self
            .persistence_manager
            .load_session_turns(session_storage_path, session_id)
            .await?;
        let visible_turns = turns
            .iter()
            .filter(|turn| turn.turn_index < boundary_turn)
            .cloned()
            .collect::<Vec<_>>();
        let listing_baseline_rebuild_turn_index = self
            .persistence_manager
            .load_session_metadata(session_storage_path, session_id)
            .await?
            .as_ref()
            .and_then(|metadata| {
                Self::listing_baseline_rebuild_turn_index_from_metadata(Some(metadata))
            });

        let messages = if boundary_turn == 0 {
            Vec::new()
        } else if let Some((snapshot_turn_index, snapshot_messages)) = self
            .persistence_manager
            .load_latest_turn_context_snapshot_before(
                session_storage_path,
                session_id,
                boundary_turn,
            )
            .await?
        {
            let mut messages = self
                .sanitize_listing_diff_context_snapshot_if_needed(
                    session_storage_path,
                    session_id,
                    snapshot_turn_index,
                    snapshot_messages,
                    listing_baseline_rebuild_turn_index,
                    "staged_revert_context_snapshot",
                )
                .await;
            let delta = visible_turns
                .iter()
                .filter(|turn| turn.turn_index > snapshot_turn_index)
                .cloned()
                .collect::<Vec<_>>();
            messages.extend(Self::build_messages_from_turns(&delta));
            messages
        } else {
            Self::build_messages_from_turns(&visible_turns)
        };

        self.context_store.replace_context(session_id, messages);
        self.review_read_receipt_store.clear_session(session_id);
        let fallback_agent_type = self
            .sessions
            .get(session_id)
            .map(|session| session.agent_type.clone());
        let last_user_dialog_agent_type = Self::derive_last_user_dialog_agent_type_from_turns(
            &visible_turns,
            fallback_agent_type.as_deref(),
        );
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.dialog_turn_ids = visible_turns
                .iter()
                .map(|turn| turn.turn_id.clone())
                .collect();
            session.last_user_dialog_agent_type = last_user_dialog_agent_type;
            session.state = SessionState::Idle;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        }
        let surviving_turn_ids = visible_turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect::<HashSet<_>>();
        self.retain_evidence_events_locked(
            Some(session_storage_path),
            session_id,
            &surviving_turn_ids,
            false,
        )
        .await?;
        Ok(())
    }

    /// Permanently discard the hidden suffix after a staged revert. Callers
    /// persist the `Committing` phase before entering this idempotent cleanup.
    pub(crate) async fn commit_staged_revert_context_locked(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        boundary_turn: usize,
    ) -> OpenBitFunResult<()> {
        self.apply_staged_revert_context_locked(session_storage_path, session_id, boundary_turn)
            .await?;

        let session_snapshot = self.sessions.get(session_id).and_then(|session| {
            (self.should_persist_session(&session) && self.config.enable_persistence)
                .then(|| session.clone())
        });
        if let Some(session) = session_snapshot {
            self.persistence_manager
                .save_session(session_storage_path, &session)
                .await?;
        }
        // Committing the marker permanently discards the hidden suffix, so the
        // evidence sidecar must be pruned to the surviving turns as well.
        self.persistence_manager
            .delete_dialog_turns_from(session_storage_path, session_id, boundary_turn)
            .await?;
        self.persistence_manager
            .delete_turn_context_snapshots_from(session_storage_path, session_id, boundary_turn)
            .await?;
        self.persistence_manager
            .delete_compression_transcripts_from(session_storage_path, session_id, boundary_turn)
            .await?;
        self.truncate_listing_baseline_rebuild_turn_index_after_rollback(
            session_storage_path,
            session_id,
            boundary_turn,
        )
        .await?;
        self.turn_skill_agent_snapshot_store
            .remove_from(session_id, boundary_turn);
        let surviving_turn_ids = self
            .sessions
            .get(session_id)
            .map(|session| {
                session
                    .dialog_turn_ids
                    .iter()
                    .cloned()
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        self.rollback_edit_constraint_state_to_turns(session_id, &surviving_turn_ids)
            .await;
        self.retain_evidence_events_locked(
            Some(session_storage_path),
            session_id,
            &surviving_turn_ids,
            true,
        )
        .await?;
        let messages = self.context_store.get_context_messages(session_id);
        self.prune_token_anchors_to_messages(session_id, &messages)
            .await;
        Ok(())
    }

    pub(crate) async fn rollback_context_to_turn_start_locked(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        let workspace_path = session_storage_path;

        self.validate_rollback_context_to_turn_start_locked(
            session_storage_path,
            session_id,
            target_turn,
        )
        .await?;
        let surviving_turns = if target_turn == 0 {
            Vec::new()
        } else {
            self.persistence_manager
                .load_session_turns(workspace_path, session_id)
                .await?
        };

        // Rollback may load a historical snapshot from before the latest rebuilt baseline. In
        // that case we must strip all listing diff reminders before the snapshot re-enters
        // runtime context, otherwise old diffs reappear after rollback/reopen.
        let listing_baseline_rebuild_turn_index = if self.config.enable_persistence {
            let metadata = self
                .persistence_manager
                .load_session_metadata(workspace_path, session_id)
                .await?;
            Self::listing_baseline_rebuild_turn_index_from_metadata(metadata.as_ref())
        } else {
            None
        };

        // 1) Load target context (target_turn == 0 => empty context)
        let messages = if target_turn == 0 {
            Vec::new()
        } else {
            let messages = self
                .persistence_manager
                .load_turn_context_snapshot(workspace_path, session_id, target_turn - 1)
                .await?
                .ok_or_else(|| {
                    OpenBitFunError::NotFound(format!(
                        "turn context snapshot not found: session_id={} turn={}",
                        session_id,
                        target_turn - 1
                    ))
                })?;
            self.sanitize_listing_diff_context_snapshot_if_needed(
                workspace_path,
                session_id,
                target_turn - 1,
                messages,
                listing_baseline_rebuild_turn_index,
                "rollback_restore_pre_listing_baseline_rebuild_snapshot",
            )
            .await
        };

        // 2) Restore the in-memory context cache.
        self.context_store
            .replace_context(session_id, messages.clone());
        self.review_read_receipt_store.clear_session(session_id);
        self.prune_token_anchors_to_messages(session_id, &messages)
            .await;

        let (last_user_dialog_agent_type, surviving_dialog_turn_ids) = if target_turn == 0 {
            (None, std::collections::HashSet::new())
        } else {
            let kept_turns = surviving_turns
                .into_iter()
                .take(target_turn)
                .collect::<Vec<_>>();
            let fallback_agent_type = self
                .sessions
                .get(session_id)
                .map(|session| session.agent_type.clone());
            let last_agent_type = Self::derive_last_user_dialog_agent_type_from_turns(
                &kept_turns,
                fallback_agent_type.as_deref(),
            );
            let turn_ids = kept_turns
                .iter()
                .map(|turn| turn.turn_id.clone())
                .collect::<std::collections::HashSet<_>>();
            (last_agent_type, turn_ids)
        };

        // 3) Truncate session turn list & persist
        // IMPORTANT: keep the DashMap guard scope short -- do NOT hold it across .await.
        let session_snapshot = if let Some(mut session) = self.sessions.get_mut(session_id) {
            if session.dialog_turn_ids.len() > target_turn {
                session.dialog_turn_ids.truncate(target_turn);
            }
            session.last_user_dialog_agent_type = last_user_dialog_agent_type;
            session.state = SessionState::Idle;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();

            let should_persist =
                self.should_persist_session(&session) && self.config.enable_persistence;
            if should_persist {
                Some(session.clone())
            } else {
                None
            }
        } else {
            None
        };
        // RefMut guard released here -- DashMap shard lock is free.
        self.clear_turn_settlement_results(session_id);

        if let Some(session) = session_snapshot {
            self.persistence_manager
                .save_session(workspace_path, &session)
                .await?;
        }

        // 4) Delete persisted turns and snapshots from target_turn (inclusive) onwards.
        // Runtime restore rebuilds history from persisted turn files, so removing only
        // context snapshots would make rolled-back prompts reappear after reload.
        if self.config.enable_persistence {
            self.persistence_manager
                .delete_dialog_turns_from(workspace_path, session_id, target_turn)
                .await?;
            self.persistence_manager
                .delete_turn_context_snapshots_from(workspace_path, session_id, target_turn)
                .await?;
            self.persistence_manager
                .delete_compression_transcripts_from(workspace_path, session_id, target_turn)
                .await?;
            self.truncate_listing_baseline_rebuild_turn_index_after_rollback(
                workspace_path,
                session_id,
                target_turn,
            )
            .await?;
        }
        self.turn_skill_agent_snapshot_store
            .remove_from(session_id, target_turn);
        self.rollback_edit_constraint_state_to_turns(session_id, &surviving_dialog_turn_ids)
            .await;
        self.retain_evidence_events_locked(
            Some(workspace_path),
            session_id,
            &surviving_dialog_turn_ids,
            true,
        )
        .await?;

        Ok(())
    }

    pub(crate) async fn validate_rollback_context_to_turn_start_locked(
        &self,
        session_storage_path: &Path,
        session_id: &str,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        if !self.config.enable_persistence {
            return Ok(());
        }
        if self
            .persistence_manager
            .load_session_revert_state(session_storage_path, session_id)
            .await?
            .is_some()
        {
            return Err(OpenBitFunError::OutcomeUnknown(format!(
                "Legacy context rollback cannot overlap a staged Session undo: session_id={session_id}"
            )));
        }
        self.persistence_manager
            .load_session_metadata(session_storage_path, session_id)
            .await?;
        self.persistence_manager
            .load_session_turns(session_storage_path, session_id)
            .await?;
        if target_turn > 0
            && self
                .persistence_manager
                .load_turn_context_snapshot(session_storage_path, session_id, target_turn - 1)
                .await?
                .is_none()
        {
            return Err(OpenBitFunError::NotFound(format!(
                "turn context snapshot not found: session_id={} turn={}",
                session_id,
                target_turn - 1
            )));
        }
        Ok(())
    }

    /// List all sessions
    pub async fn list_sessions(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Vec<SessionSummary>> {
        if self.config.enable_persistence {
            self.persistence_manager.list_sessions(workspace_path).await
        } else {
            let summaries: Vec<_> = self
                .sessions
                .iter()
                .map(|entry| {
                    let session = entry.value();
                    SessionSummary {
                        session_id: session.session_id.clone(),
                        session_name: session.session_name.clone(),
                        agent_type: session.agent_type.clone(),
                        model_id: session.config.model_id.clone(),
                        reasoning_preset: session.config.reasoning_preset.clone(),
                        last_user_dialog_agent_type: session.last_user_dialog_agent_type.clone(),
                        last_submitted_agent_type: session.last_submitted_agent_type.clone(),
                        created_by: session.created_by.clone(),
                        kind: session.kind,
                        turn_count: session.dialog_turn_ids.len(),
                        created_at: session.created_at,
                        last_activity_at: session.last_activity_at,
                        state: session.state.clone(),
                    }
                })
                .filter(|summary| {
                    !matches!(
                        summary.kind,
                        SessionKind::Subagent | SessionKind::EphemeralChild
                    )
                })
                .collect();
            Ok(summaries)
        }
    }

    pub async fn load_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionMetadata>> {
        self.persistence_manager
            .load_session_metadata(workspace_path, session_id)
            .await
    }

    pub async fn update_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata),
    ) -> OpenBitFunResult<()> {
        self.persistence_manager
            .update_session_metadata(workspace_path, session_id, update)
            .await
    }

    #[cfg(test)]
    pub async fn save_session_metadata(
        &self,
        workspace_path: &Path,
        metadata: &SessionMetadata,
    ) -> OpenBitFunResult<()> {
        self.persistence_manager
            .save_session_metadata(workspace_path, metadata)
            .await
    }

    pub async fn set_session_memory_mode(
        &self,
        workspace_path: &Path,
        session_id: &str,
        mode: SessionMemoryMode,
    ) -> OpenBitFunResult<()> {
        self.update_session_metadata_at_workspace(workspace_path, session_id, |metadata| {
            metadata.memory_mode = mode;
        })
        .await
    }

    pub async fn set_persisted_session_memory_mode(
        &self,
        session_id: &str,
        mode: SessionMemoryMode,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            metadata.memory_mode = mode;
        })
        .await
    }

    pub async fn mark_session_memory_mode_polluted(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        let mut should_enqueue_phase2 = false;
        self.update_session_metadata_at_workspace(workspace_path, session_id, |metadata| {
            should_enqueue_phase2 = matches!(
                metadata.memory_mode,
                SessionMemoryMode::Enabled | SessionMemoryMode::Polluted
            );
            if metadata.memory_mode == SessionMemoryMode::Enabled {
                metadata.memory_mode = SessionMemoryMode::Polluted;
            }
        })
        .await?;
        if should_enqueue_phase2 {
            self.enqueue_phase2_if_session_selected(session_id).await?;
        }
        Ok(())
    }

    async fn enqueue_phase2_if_session_selected(&self, session_id: &str) -> OpenBitFunResult<()> {
        if self
            .memory_database
            .phase2_selected_for_session(session_id)
            .await?
        {
            self.memory_database
                .enqueue_phase2_job(MEMORY_PHASE2_GLOBAL_JOB_KEY, current_unix_secs())
                .await?;
        }
        Ok(())
    }

    async fn metadata_workspace_path_for_update(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        if !self.should_persist_session_id(session_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Session persistence is disabled: {}",
                session_id
            )));
        }

        self.effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })
    }

    async fn ensure_session_metadata_persisted(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        if self
            .persistence_manager
            .load_session_metadata(workspace_path, session_id)
            .await?
            .is_some()
        {
            return Ok(());
        }

        let session = self
            .sessions
            .get(session_id)
            .map(|value| value.clone())
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;
        self.persistence_manager
            .save_session(workspace_path, &session)
            .await
    }

    async fn update_session_metadata_at_workspace(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata),
    ) -> OpenBitFunResult<()> {
        self.ensure_session_metadata_persisted(workspace_path, session_id)
            .await?;
        self.persistence_manager
            .update_session_metadata(workspace_path, session_id, update)
            .await
    }

    async fn update_persisted_session_metadata(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata),
    ) -> OpenBitFunResult<()> {
        if !self.should_persist_session_id(session_id) {
            return Ok(());
        }

        let workspace_path = self.metadata_workspace_path_for_update(session_id).await?;
        self.update_session_metadata_at_workspace(&workspace_path, session_id, update)
            .await
    }

    pub async fn merge_session_custom_metadata(
        &self,
        session_id: &str,
        patch: serde_json::Value,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            merge_session_custom_metadata_value(metadata, patch)
        })
        .await
    }

    pub(crate) async fn persist_current_context_usage(
        &self,
        session_id: &str,
        usage: SessionContextUsage,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let should_persist_usage = self.sessions.get(session_id).is_some_and(|session| {
            !session.agent_type.starts_with("acp:")
                && session
                    .dialog_turn_ids
                    .iter()
                    .any(|turn_id| turn_id == &usage.turn_id)
                && self.should_persist_session(&session)
        });
        if !should_persist_usage || !self.config.enable_persistence {
            return Ok(());
        }

        self.update_persisted_session_metadata(session_id, |metadata| {
            metadata.current_context_usage = Some(usage);
        })
        .await
    }

    pub async fn merge_session_relationship(
        &self,
        session_id: &str,
        relationship: SessionRelationship,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            set_session_relationship(metadata, relationship)
        })
        .await
    }

    pub async fn persist_session_lineage(
        &self,
        session_id: &str,
        relationship: SessionRelationship,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            apply_session_lineage(metadata, relationship)
        })
        .await
    }

    pub async fn collect_hidden_subagent_cascade_for_parent_turns(
        &self,
        workspace_path: &Path,
        parent_session_id: &str,
        parent_dialog_turn_ids: &HashSet<String>,
    ) -> OpenBitFunResult<Vec<String>> {
        if parent_session_id.trim().is_empty() || parent_dialog_turn_ids.is_empty() {
            return Ok(Vec::new());
        }

        let metadata_list = self
            .persistence_manager
            .list_session_metadata_including_internal(workspace_path)
            .await?;
        Ok(collect_hidden_subagent_cascade_ids(
            metadata_list,
            parent_session_id,
            parent_dialog_turn_ids,
        ))
    }

    pub async fn set_session_deep_review_run_manifest(
        &self,
        session_id: &str,
        deep_review_run_manifest: Option<serde_json::Value>,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            set_deep_review_run_manifest(metadata, deep_review_run_manifest)
        })
        .await
    }

    pub async fn set_session_review_target_evidence(
        &self,
        session_id: &str,
        review_target_evidence: Option<serde_json::Value>,
    ) -> OpenBitFunResult<()> {
        self.update_persisted_session_metadata(session_id, |metadata| {
            set_review_target_evidence(metadata, review_target_evidence)
        })
        .await
    }

    // ============ Dialog Turn Management ============

    async fn ensure_persisted_turn_append_allowed(&self, session_id: &str) -> OpenBitFunResult<()> {
        if !self.should_persist_session_id(session_id) {
            return Ok(());
        }
        let Some(storage_path) = self.effective_session_storage_path(session_id).await else {
            return Ok(());
        };
        if let Some(revert) = self
            .persistence_manager
            .load_session_revert_state(&storage_path, session_id)
            .await?
        {
            return Err(OpenBitFunError::Validation(format!(
                "Cannot append a persisted Turn while a Session revert is {:?}: session_id={}, boundary_turn={}",
                revert.phase, session_id, revert.boundary_turn
            )));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_persisted_turn(
        &self,
        session_id: &str,
        kind: DialogTurnKind,
        agent_type: Option<String>,
        user_input: String,
        turn_id: Option<String>,
        context_messages: Vec<Message>,
        processing_phase: ProcessingPhase,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        self.start_persisted_turn_locked(
            session_id,
            kind,
            agent_type,
            user_input,
            turn_id,
            context_messages,
            processing_phase,
            user_message_metadata,
        )
        .await
    }

    /// Start a persisted Turn while the caller owns the Session mutation lock.
    #[allow(clippy::too_many_arguments)]
    async fn start_persisted_turn_locked(
        &self,
        session_id: &str,
        kind: DialogTurnKind,
        agent_type: Option<String>,
        user_input: String,
        turn_id: Option<String>,
        context_messages: Vec<Message>,
        processing_phase: ProcessingPhase,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        self.ensure_persisted_turn_append_allowed(session_id)
            .await?;
        let session = self.get_session(session_id).ok_or_else(|| {
            OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
        })?;
        match &session.state {
            SessionState::Idle => {}
            SessionState::Processing {
                current_turn_id,
                phase,
            } => {
                return Err(OpenBitFunError::Validation(format!(
                    "Session is still processing: current_turn_id={}, phase={:?}",
                    current_turn_id, phase
                )));
            }
            SessionState::Error { .. } if kind == DialogTurnKind::UserDialog => {}
            SessionState::Error { error, .. } => {
                return Err(OpenBitFunError::Validation(format!(
                    "Session must be idle before starting a turn: {}",
                    error
                )));
            }
        }
        let workspace_path = self
            .effective_storage_path_for_config(&session.config)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;

        let turn_index = session.dialog_turn_ids.len();
        let turn_id = new_turn_id(turn_id);
        if session
            .dialog_turn_ids
            .iter()
            .any(|existing| existing == &turn_id)
        {
            return Err(OpenBitFunError::Validation(format!(
                "Dialog turn already exists: {turn_id}"
            )));
        }

        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.dialog_turn_ids.push(turn_id.clone());
            if kind == DialogTurnKind::UserDialog {
                session.last_user_dialog_agent_type = agent_type.clone();
            }
            session.state = SessionState::Processing {
                current_turn_id: turn_id.clone(),
                phase: processing_phase,
            };
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
        }

        for message in context_messages {
            self.context_store
                .add_message(session_id, message.with_turn_id(turn_id.clone()));
        }

        if self.should_persist_session_id(session_id) {
            let turn_data = DialogTurnData::new_with_kind(
                kind,
                turn_id.clone(),
                turn_index,
                session_id.to_string(),
                if kind == DialogTurnKind::UserDialog {
                    agent_type.clone()
                } else {
                    None
                },
                UserMessageData {
                    id: format!("{}-user", turn_id),
                    content: user_input,
                    timestamp: SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    metadata: user_message_metadata,
                },
            );

            // Clone the session data out of the DashMap guard before awaiting I/O.
            let session_snapshot = self.sessions.get(session_id).map(|s| s.clone());
            // Ref guard released -- DashMap shard lock is free.
            if let Some(session) = session_snapshot {
                self.persistence_manager
                    .save_session(&workspace_path, &session)
                    .await?;
            }
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn_data)
                .await?;
        }

        self.persist_context_snapshot_for_turn_best_effort(session_id, turn_index, "turn_started")
            .await;

        Ok(turn_id)
    }

    /// Start a new dialog turn
    /// turn_id: Optional frontend-specified ID, if None then backend generates
    /// Returns: turn_id
    pub async fn start_dialog_turn(
        &self,
        session_id: &str,
        agent_type: String,
        user_input: String,
        turn_id: Option<String>,
        image_contexts: Option<Vec<ImageContextData>>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let user_message =
            if let Some(images) = image_contexts.as_ref().filter(|v| !v.is_empty()).cloned() {
                Message::user_multimodal(user_input.clone(), images)
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            } else {
                Message::user(user_input.clone())
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            };

        let turn_id = self
            .start_persisted_turn(
                session_id,
                DialogTurnKind::UserDialog,
                Some(agent_type),
                user_input,
                turn_id,
                vec![user_message],
                ProcessingPhase::Starting,
                user_message_metadata,
            )
            .await?;

        debug!("Starting dialog turn: turn_id={}", turn_id);

        Ok(turn_id)
    }

    /// Starts a normal user dialog while the caller owns the Session mutation
    /// lock. This keeps staged-revert commit and new-turn admission atomic for
    /// non-model Runtime operations that still produce standard dialog turns.
    pub(crate) async fn start_dialog_turn_locked(
        &self,
        session_id: &str,
        agent_type: String,
        user_input: String,
        turn_id: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let user_message = Message::user(user_input.clone())
            .with_semantic_kind(MessageSemanticKind::ActualUserInput);
        self.start_persisted_turn_locked(
            session_id,
            DialogTurnKind::UserDialog,
            Some(agent_type),
            user_input,
            turn_id,
            vec![user_message],
            ProcessingPhase::Starting,
            user_message_metadata,
        )
        .await
    }

    pub async fn start_dialog_turn_with_prepended_messages(
        &self,
        session_id: &str,
        agent_type: String,
        user_input: String,
        turn_id: Option<String>,
        image_contexts: Option<Vec<ImageContextData>>,
        prepended_messages: Vec<Message>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let user_message =
            if let Some(images) = image_contexts.as_ref().filter(|v| !v.is_empty()).cloned() {
                Message::user_multimodal(user_input.clone(), images)
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            } else {
                Message::user(user_input.clone())
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            };

        let mut context_messages = prepended_messages;
        context_messages.push(user_message);

        let turn_id = self
            .start_persisted_turn(
                session_id,
                DialogTurnKind::UserDialog,
                Some(agent_type),
                user_input,
                turn_id,
                context_messages,
                ProcessingPhase::Starting,
                user_message_metadata,
            )
            .await?;

        debug!(
            "Starting dialog turn with prepended messages: turn_id={}",
            turn_id
        );

        Ok(turn_id)
    }

    /// Persist a Turn only if the execution-affecting Session settings still
    /// match the snapshot used to resolve its model, permission, agent route,
    /// workspace, prompt, and reasoning metadata. The validation and Turn
    /// append share one Session mutation lock, so a concurrent settings write
    /// must retry admission.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn start_dialog_turn_with_prepended_messages_if_session_matches(
        &self,
        session_id: &str,
        agent_type: String,
        user_input: String,
        turn_id: Option<String>,
        image_contexts: Option<Vec<ImageContextData>>,
        prepended_messages: Vec<Message>,
        user_message_metadata: Option<serde_json::Value>,
        expected: &TurnAdmissionSessionFacts,
    ) -> OpenBitFunResult<String> {
        let user_message =
            if let Some(images) = image_contexts.as_ref().filter(|v| !v.is_empty()).cloned() {
                Message::user_multimodal(user_input.clone(), images)
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            } else {
                Message::user(user_input.clone())
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            };
        let mut context_messages = prepended_messages;
        context_messages.push(user_message);

        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let current = self
            .get_session(session_id)
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        if !expected.matches(&current) {
            return Err(OpenBitFunError::Validation(
                "Session execution settings changed during turn admission; retry submission"
                    .to_string(),
            ));
        }

        self.start_persisted_turn_locked(
            session_id,
            DialogTurnKind::UserDialog,
            Some(agent_type),
            user_input,
            turn_id,
            context_messages,
            ProcessingPhase::Starting,
            user_message_metadata,
        )
        .await
    }

    /// Start a new dialog turn when the model-visible user message has already
    /// been inserted into runtime context by the caller.
    ///
    /// This is used by forked/hidden subagent flows that seed inherited context
    /// before they acquire a concrete dialog turn id. The turn still needs the
    /// normal persisted lifecycle (turn record, active turn bookkeeping, and
    /// context snapshot), but must not append a duplicate user message into the
    /// runtime context cache.
    pub async fn start_dialog_turn_with_existing_context(
        &self,
        session_id: &str,
        agent_type: String,
        user_input: String,
        turn_id: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let turn_id = self
            .start_persisted_turn(
                session_id,
                DialogTurnKind::UserDialog,
                Some(agent_type),
                user_input,
                turn_id,
                Vec::new(),
                ProcessingPhase::Starting,
                user_message_metadata,
            )
            .await?;

        debug!(
            "Starting dialog turn with existing context: turn_id={}",
            turn_id
        );

        Ok(turn_id)
    }

    /// Start a persisted maintenance turn that should not enter model-visible context.
    pub async fn start_maintenance_turn(
        &self,
        session_id: &str,
        display_message: String,
        turn_id: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let turn_id = self
            .start_persisted_turn(
                session_id,
                DialogTurnKind::ManualCompaction,
                None,
                display_message,
                turn_id,
                Vec::new(),
                ProcessingPhase::Compacting,
                user_message_metadata,
            )
            .await?;

        debug!("Starting maintenance turn: turn_id={}", turn_id);

        Ok(turn_id)
    }

    pub(crate) async fn start_maintenance_turn_locked(
        &self,
        session_id: &str,
        display_message: String,
        turn_id: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<String> {
        let turn_id = self
            .start_persisted_turn_locked(
                session_id,
                DialogTurnKind::ManualCompaction,
                None,
                display_message,
                turn_id,
                Vec::new(),
                ProcessingPhase::Compacting,
                user_message_metadata,
            )
            .await?;
        debug!("Starting maintenance turn: turn_id={}", turn_id);
        Ok(turn_id)
    }

    /// Record a provider-native voice exchange in the same model-visible ledger.
    /// Stable exchange IDs make transport retries harmless. Admission and persistence
    /// share the ordinary Session mutation lock; a running Agent is never overwritten.
    pub async fn append_voice_exchange(
        &self,
        session_id: &str,
        exchange_id: &str,
        user_text: String,
        assistant_text: String,
    ) -> OpenBitFunResult<()> {
        if exchange_id.trim().is_empty() || user_text.trim().is_empty() {
            return Err(OpenBitFunError::Validation(
                "Voice exchange requires an id and final user transcript".into(),
            ));
        }
        let _guard = self.acquire_session_mutation(session_id).await?;
        let mut session = self
            .get_session(session_id)
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        if session.dialog_turn_ids.iter().any(|id| id == exchange_id) {
            return Ok(());
        }
        if matches!(session.state, SessionState::Processing { .. }) {
            return Err(OpenBitFunError::Validation(
                "Voice exchange is waiting for the active Agent turn".into(),
            ));
        }
        self.ensure_persisted_turn_append_allowed(session_id)
            .await?;
        let storage = self
            .effective_storage_path_for_config(&session.config)
            .await
            .ok_or_else(|| OpenBitFunError::Validation("Session storage is unavailable".into()))?;
        let index = session.dialog_turn_ids.len();
        let timestamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let user = Message::user(user_text.clone())
            .with_semantic_kind(MessageSemanticKind::ActualUserInput)
            .with_turn_id(exchange_id.to_string());
        let assistant =
            Message::assistant(assistant_text.clone()).with_turn_id(exchange_id.to_string());
        let mut turn = DialogTurnData::new_with_kind(
            DialogTurnKind::UserDialog,
            exchange_id.to_string(),
            index,
            session_id.to_string(),
            Some(session.agent_type.clone()),
            UserMessageData {
                id: format!("{exchange_id}-user"),
                content: user_text,
                timestamp,
                metadata: Some(json!({ "source": "realtime_voice", "nativeExchange": true })),
            },
        );
        turn.timestamp = timestamp;
        turn.start_time = timestamp;
        turn.end_time = Some(timestamp);
        turn.duration_ms = Some(0);
        turn.status = TurnStatus::Completed;
        turn.model_rounds =
            Self::build_model_rounds_from_messages(&[assistant.clone()], exchange_id, timestamp);
        let persist = self.config.enable_persistence && self.should_persist_session(&session);
        // A failed write leaves the in-memory ledger untouched and can be retried.
        if persist {
            self.persistence_manager
                .save_dialog_turn(&storage, &turn)
                .await?;
        }
        session.dialog_turn_ids.push(exchange_id.to_string());
        session.updated_at = SystemTime::now();
        session.last_activity_at = session.updated_at;
        if persist {
            self.persistence_manager
                .save_session(&storage, &session)
                .await?;
        }
        self.sessions.insert(session_id.to_string(), session);
        self.context_store.add_message(session_id, user);
        if !assistant_text.is_empty() {
            self.context_store.add_message(session_id, assistant);
        }
        self.persist_context_snapshot_for_turn_best_effort(
            session_id,
            index,
            "voice_exchange_recorded",
        )
        .await;
        Ok(())
    }

    /// Append a completed local command turn that should be persisted in user-facing
    /// history without entering model-visible runtime context.
    pub async fn append_completed_local_command_turn(
        &self,
        session_id: &str,
        content: String,
        turn_id: Option<String>,
        timestamp_ms: Option<u64>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<DialogTurnData> {
        let _mutation_guard = self.lock_session_mutation(session_id).await;
        self.append_completed_local_command_turn_locked(
            session_id,
            content,
            turn_id,
            timestamp_ms,
            user_message_metadata,
        )
        .await
    }

    pub(crate) async fn append_completed_local_command_turn_locked(
        &self,
        session_id: &str,
        content: String,
        turn_id: Option<String>,
        timestamp_ms: Option<u64>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> OpenBitFunResult<DialogTurnData> {
        self.ensure_persisted_turn_append_allowed(session_id)
            .await?;
        let session = self.get_session(session_id).ok_or_else(|| {
            OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
        })?;
        let workspace_path = self
            .effective_storage_path_for_config(&session.config)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;

        let turn_id = new_turn_id(turn_id);
        let turn_index = session
            .dialog_turn_ids
            .iter()
            .position(|existing| existing == &turn_id)
            .unwrap_or(session.dialog_turn_ids.len());
        let timestamp = timestamp_ms.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        });
        let mut turn = DialogTurnData::new_with_kind(
            DialogTurnKind::LocalCommand,
            turn_id.clone(),
            turn_index,
            session_id.to_string(),
            None,
            UserMessageData {
                id: format!("{}-user", turn_id),
                content,
                timestamp,
                metadata: user_message_metadata,
            },
        );
        turn.timestamp = timestamp;
        turn.start_time = timestamp;
        turn.end_time = Some(timestamp);
        turn.duration_ms = Some(0);
        turn.status = TurnStatus::Completed;

        if self.config.enable_persistence && self.should_persist_session(&session) {
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn)
                .await?;
        }

        let session_snapshot = if let Some(mut session) = self.sessions.get_mut(session_id) {
            if !session
                .dialog_turn_ids
                .iter()
                .any(|existing| existing == &turn_id)
            {
                session.dialog_turn_ids.push(turn_id);
            }
            session.state = SessionState::Idle;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();

            if self.config.enable_persistence && self.should_persist_session(&session) {
                Some(session.clone())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(session) = session_snapshot {
            self.persistence_manager
                .save_session(&workspace_path, &session)
                .await?;
        }

        self.persist_context_snapshot_for_turn_best_effort(
            session_id,
            turn_index,
            "local_command_turn_persisted",
        )
        .await;

        Ok(turn)
    }

    /// Build model rounds from execution messages.
    ///
    /// Used by `complete_dialog_turn` to populate `model_rounds` when the
    /// host surface (e.g. CLI) does not persist rounds itself. This ensures
    /// turn files contain rich conversation data (text, tools, thinking) that
    /// other surfaces (e.g. Desktop) can render.
    pub(crate) fn build_model_rounds_from_messages(
        messages: &[Message],
        turn_id: &str,
        timestamp: u64,
    ) -> Vec<ModelRoundData> {
        let mut rounds: Vec<ModelRoundData> = Vec::new();

        for msg in messages {
            match msg.role {
                MessageRole::Assistant => {
                    let round_index = rounds.len();
                    let round_id = msg
                        .metadata
                        .round_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|round_id| !round_id.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{}-round-{}", turn_id, round_index));

                    let mut text_items = Vec::new();
                    let mut thinking_items = Vec::new();
                    let mut tool_items = Vec::new();
                    let mut order_index = 0usize;

                    match &msg.content {
                        MessageContent::Text(text) => {
                            if !text.trim().is_empty() {
                                text_items.push(Self::make_text_item(
                                    &format!("{}-text-{}", round_id, order_index),
                                    text,
                                    timestamp,
                                    order_index,
                                ));
                            }
                        }
                        MessageContent::Mixed {
                            reasoning_content,
                            text,
                            tool_calls,
                        } => {
                            // Thinking / reasoning content
                            if let Some(reasoning) = reasoning_content {
                                if !reasoning.trim().is_empty() {
                                    thinking_items.push(ThinkingItemData {
                                        id: format!("{}-think-{}", round_id, order_index),
                                        content: reasoning.clone(),
                                        reasoning_kind: msg.metadata.reasoning_content_kind,
                                        is_streaming: false,
                                        is_collapsed: true,
                                        timestamp,
                                        order_index: Some(order_index),
                                        status: Some("completed".to_string()),
                                        is_subagent_item: None,
                                        parent_task_tool_id: None,
                                        subagent_session_id: None,
                                        attempt_id: None,
                                        attempt_index: None,
                                    });
                                    order_index += 1;
                                }
                            }
                            // Text content
                            if !text.trim().is_empty() {
                                text_items.push(Self::make_text_item(
                                    &format!("{}-text-{}", round_id, order_index),
                                    text,
                                    timestamp,
                                    order_index,
                                ));
                                order_index += 1;
                            }
                            // Tool calls
                            for tc in tool_calls {
                                tool_items.push(ToolItemData {
                                    id: tc.tool_id.clone(),
                                    tool_name: tc.tool_name.clone(),
                                    tool_call: ToolCallData {
                                        input: tc.arguments.clone(),
                                        id: tc.tool_id.clone(),
                                    },
                                    tool_result: None,
                                    ai_intent: None,
                                    start_time: timestamp,
                                    end_time: None,
                                    duration_ms: None,
                                    queue_wait_ms: None,
                                    preflight_ms: None,
                                    confirmation_wait_ms: None,
                                    execution_ms: None,
                                    order_index: Some(order_index),
                                    is_subagent_item: None,
                                    parent_task_tool_id: None,
                                    subagent_session_id: None,
                                    subagent_dialog_turn_id: None,
                                    attempt_id: None,
                                    attempt_index: None,
                                    subagent_model_id: None,
                                    subagent_model_display_name: None,
                                    status: Some("completed".to_string()),
                                    interruption_reason: None,
                                });
                                order_index += 1;
                            }
                        }
                        MessageContent::Multimodal { text, .. } if !text.trim().is_empty() => {
                            text_items.push(Self::make_text_item(
                                &format!("{}-text-{}", round_id, order_index),
                                text,
                                timestamp,
                                order_index,
                            ));
                        }
                        _ => {}
                    }

                    // Only add the round if it has any content
                    if !text_items.is_empty()
                        || !tool_items.is_empty()
                        || !thinking_items.is_empty()
                    {
                        rounds.push(ModelRoundData {
                            id: round_id,
                            turn_id: turn_id.to_string(),
                            round_index,
                            round_group_id: None,
                            timestamp,
                            text_items,
                            tool_items,
                            thinking_items,
                            start_time: timestamp,
                            end_time: Some(timestamp),
                            duration_ms: Some(0),
                            provider_id: None,
                            model_config_id: None,
                            effective_model_name: None,
                            first_chunk_ms: None,
                            first_visible_output_ms: None,
                            stream_duration_ms: None,
                            attempt_count: None,
                            attempt_diagnostics: vec![],
                            failure_category: None,
                            token_details: None,
                            status: "completed".to_string(),
                        });
                    }
                }
                MessageRole::Tool => {
                    // Attach tool result to the matching tool item in the last round
                    if let MessageContent::ToolResult {
                        tool_id,
                        result,
                        result_for_assistant,
                        image_attachments,
                        is_error,
                        ..
                    } = &msg.content
                    {
                        if let Some(last_round) = rounds.last_mut() {
                            for tool_item in &mut last_round.tool_items {
                                if tool_item.id == *tool_id {
                                    let assistant_text = result_for_assistant
                                        .clone()
                                        .or_else(|| serde_json::to_string(result).ok());
                                    tool_item.tool_result = Some(ToolResultData {
                                        result: result.clone(),
                                        success: !is_error,
                                        result_for_assistant: assistant_text,
                                        image_attachments: image_attachments.clone(),
                                        error: if *is_error {
                                            result
                                                .get("error")
                                                .and_then(serde_json::Value::as_str)
                                                .map(str::to_owned)
                                                .or_else(|| serde_json::to_string(result).ok())
                                        } else {
                                            None
                                        },
                                        duration_ms: None,
                                    });
                                    tool_item.status = Some(
                                        if *is_error { "error" } else { "completed" }.to_string(),
                                    );
                                    tool_item.end_time = Some(timestamp);
                                    break;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        rounds
    }

    /// Helper to create a `TextItemData` with common defaults.
    fn make_text_item(id: &str, content: &str, timestamp: u64, order_index: usize) -> TextItemData {
        TextItemData {
            id: id.to_string(),
            content: content.to_string(),
            is_streaming: false,
            timestamp,
            is_markdown: true,
            order_index: Some(order_index),
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            status: Some("completed".to_string()),
            attempt_id: None,
            attempt_index: None,
        }
    }

    /// Complete dialog turn
    pub async fn complete_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        final_response: String,
        new_messages: &[Message],
        stats: TurnStats,
        finish_reason: Option<String>,
        has_final_response: Option<bool>,
    ) -> OpenBitFunResult<()> {
        if !self.should_persist_session_id(session_id) {
            debug!(
                "Skipping dialog turn persistence for transient session completion: session_id={}, turn_id={}, response_len={}, rounds={}",
                session_id,
                turn_id,
                final_response.len(),
                stats.total_rounds
            );
            return Ok(());
        }

        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;

        // The context snapshot is a session-level artifact built from the
        // in-memory context store; it does not participate in the projected
        // checkpoint race below. Persist it before taking the mutation lock so
        // slow storage (for example a remote SSH workspace) cannot extend the
        // critical section and stall the next turn's start behind completion.
        self.persist_context_snapshot_for_turn_best_effort(
            session_id,
            turn_index,
            "turn_completed",
        )
        .await;

        // Serialize Runtime completion against projected UI checkpoints. If a
        // checkpoint wins first, the generation journal below repairs it; if
        // completion wins first, the projected-save guard sees the terminal
        // authoritative record and cannot replace it with an older prefix.
        // Keep this critical section to the turn-record load, merge, and save
        // only: the same keyed lock also serializes dialog-turn starts, so any
        // extra work held here directly delays the next user message.
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;

        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;

        // Update state
        let completion_timestamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // The Runtime generation journal is authoritative at completion. A
        // frontend checkpoint may already contain assistant text, but that
        // text can be only a prefix when the final stream chunks were dropped.
        // Merge by stable round identity instead of treating any non-empty
        // projected text as proof that the Turn is complete.
        let turn_identity = turn.turn_id.clone();
        let generated_count = Self::append_generation_rounds(
            &mut turn,
            &turn_identity,
            new_messages,
            completion_timestamp,
        );
        if generated_count == 0 && !final_response.trim().is_empty() {
            let mut reconciled_existing_text = false;
            for round in turn.model_rounds.iter_mut().rev() {
                let Some(item) = round
                    .text_items
                    .iter_mut()
                    .rev()
                    .find(|item| !item.content.trim().is_empty())
                else {
                    continue;
                };
                if final_response == item.content || final_response.starts_with(&item.content) {
                    item.content = final_response.clone();
                    item.is_streaming = false;
                    item.status = Some("completed".to_string());
                    round.status = "completed".to_string();
                    round.end_time = Some(completion_timestamp);
                    reconciled_existing_text = true;
                }
                break;
            }

            let has_assistant_text = turn.model_rounds.iter().any(|round| {
                round
                    .text_items
                    .iter()
                    .any(|item| !item.content.trim().is_empty())
            });
            if !reconciled_existing_text && !has_assistant_text {
                // Fallback: append a single text-only round
                let round_index = turn.model_rounds.len();
                turn.model_rounds.push(ModelRoundData {
                    id: format!("{}-final-round", turn.turn_id),
                    turn_id: turn.turn_id.clone(),
                    round_index,
                    round_group_id: None,
                    timestamp: completion_timestamp,
                    text_items: vec![TextItemData {
                        id: format!("{}-final-text", turn.turn_id),
                        content: final_response.clone(),
                        is_streaming: false,
                        timestamp: completion_timestamp,
                        is_markdown: true,
                        order_index: Some(0),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        status: Some("completed".to_string()),
                        attempt_id: None,
                        attempt_index: None,
                    }],
                    tool_items: Vec::new(),
                    thinking_items: Vec::new(),
                    start_time: completion_timestamp,
                    end_time: Some(completion_timestamp),
                    duration_ms: Some(0),
                    provider_id: None,
                    model_config_id: None,
                    effective_model_name: None,
                    first_chunk_ms: None,
                    first_visible_output_ms: None,
                    stream_duration_ms: None,
                    attempt_count: None,
                    attempt_diagnostics: vec![],
                    failure_category: None,
                    token_details: None,
                    status: "completed".to_string(),
                });
            }
        }
        turn.status = TurnStatus::Completed;
        turn.recovery = None;
        turn.finish_reason = finish_reason;
        turn.has_final_response = has_final_response;
        turn.duration_ms = Some(stats.duration_ms);
        turn.end_time = Some(completion_timestamp);

        // Persist
        if self.should_persist_session_id(session_id) {
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn)
                .await?;
        }

        debug!(
            "Dialog turn completed: turn_id={}, rounds={}, tools={}",
            turn_id, stats.total_rounds, stats.total_tools
        );

        Ok(())
    }

    pub(crate) fn append_generation_rounds(
        turn: &mut DialogTurnData,
        turn_id: &str,
        new_messages: &[Message],
        timestamp: u64,
    ) -> usize {
        let mut next_round_index = turn
            .model_rounds
            .iter()
            .map(|round| round.round_index)
            .max()
            .map_or(0, |index| index.saturating_add(1));
        let generated_rounds =
            Self::build_model_rounds_from_messages(new_messages, turn_id, timestamp);
        let generated_count = generated_rounds.len();
        for mut round in generated_rounds {
            if let Some(existing_index) = turn
                .model_rounds
                .iter()
                .position(|existing| existing.id == round.id)
            {
                let existing = &turn.model_rounds[existing_index];
                for text_item in &mut round.text_items {
                    if let Some(previous) = existing
                        .text_items
                        .iter()
                        .find(|item| item.id == text_item.id)
                    {
                        text_item.timestamp = previous.timestamp;
                        text_item.is_markdown = previous.is_markdown;
                        text_item.order_index = previous.order_index;
                        text_item.is_subagent_item = previous.is_subagent_item;
                        text_item.parent_task_tool_id = previous.parent_task_tool_id.clone();
                        text_item.subagent_session_id = previous.subagent_session_id.clone();
                        text_item.status = previous.status.clone().or(text_item.status.clone());
                        text_item.attempt_id = previous.attempt_id.clone();
                        text_item.attempt_index = previous.attempt_index;
                    }
                }
                for thinking_item in &mut round.thinking_items {
                    if let Some(previous) = existing
                        .thinking_items
                        .iter()
                        .find(|item| item.id == thinking_item.id)
                    {
                        thinking_item.timestamp = previous.timestamp;
                        thinking_item.order_index = previous.order_index;
                        thinking_item.status =
                            previous.status.clone().or(thinking_item.status.clone());
                        thinking_item.is_subagent_item = previous.is_subagent_item;
                        thinking_item.parent_task_tool_id = previous.parent_task_tool_id.clone();
                        thinking_item.subagent_session_id = previous.subagent_session_id.clone();
                        thinking_item.attempt_id = previous.attempt_id.clone();
                        thinking_item.attempt_index = previous.attempt_index;
                    }
                }
                for tool_item in &mut round.tool_items {
                    if let Some(previous) = existing
                        .tool_items
                        .iter()
                        .find(|item| item.id == tool_item.id)
                    {
                        tool_item.ai_intent = previous.ai_intent.clone();
                        tool_item.start_time = previous.start_time;
                        tool_item.end_time = previous.end_time.or(tool_item.end_time);
                        tool_item.duration_ms = previous.duration_ms.or(tool_item.duration_ms);
                        tool_item.queue_wait_ms = previous.queue_wait_ms;
                        tool_item.preflight_ms = previous.preflight_ms;
                        tool_item.confirmation_wait_ms = previous.confirmation_wait_ms;
                        tool_item.execution_ms = previous.execution_ms;
                        tool_item.order_index = previous.order_index;
                        tool_item.is_subagent_item = previous.is_subagent_item;
                        tool_item.parent_task_tool_id = previous.parent_task_tool_id.clone();
                        tool_item.subagent_session_id = previous.subagent_session_id.clone();
                        tool_item.subagent_dialog_turn_id =
                            previous.subagent_dialog_turn_id.clone();
                        tool_item.attempt_id = previous.attempt_id.clone();
                        tool_item.attempt_index = previous.attempt_index;
                        tool_item.subagent_model_id = previous.subagent_model_id.clone();
                        tool_item.subagent_model_display_name =
                            previous.subagent_model_display_name.clone();
                        // A runtime result settles the request immediately. A persisted
                        // waiting/running checkpoint must not overwrite that newer fact.
                        if tool_item.tool_result.is_none() {
                            tool_item.status = previous.status.clone().or(tool_item.status.clone());
                            tool_item.interruption_reason = previous.interruption_reason.clone();
                        }
                    }
                }
                // Client-derived display cards are not part of the model's
                // generation journal. Preserve the recognized additive card
                // while replacing Runtime text/tool content authoritatively.
                let generated_tool_ids = round
                    .tool_items
                    .iter()
                    .map(|item| item.id.clone())
                    .collect::<std::collections::HashSet<_>>();
                let derived_tool_items = existing
                    .tool_items
                    .iter()
                    .filter(|item| {
                        item.id.starts_with("plan-display-")
                            && !generated_tool_ids.contains(&item.id)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                round.tool_items.extend(derived_tool_items);
                round.round_index = existing.round_index;
                round.round_group_id = existing.round_group_id.clone();
                round.timestamp = existing.timestamp;
                round.start_time = existing.start_time;
                round.end_time = existing.end_time.or(round.end_time);
                round.duration_ms = existing.duration_ms.or(round.duration_ms);
                round.provider_id = existing.provider_id.clone();
                round.model_config_id = existing.model_config_id.clone();
                round.effective_model_name = existing.effective_model_name.clone();
                round.first_chunk_ms = existing.first_chunk_ms;
                round.first_visible_output_ms = existing.first_visible_output_ms;
                round.stream_duration_ms = existing.stream_duration_ms;
                round.attempt_count = existing.attempt_count;
                round.attempt_diagnostics = existing.attempt_diagnostics.clone();
                round.failure_category = existing.failure_category.clone();
                round.token_details = existing.token_details.clone();
                if existing.status != "streaming" {
                    round.status = existing.status.clone();
                }
                turn.model_rounds[existing_index] = round;
            } else {
                round.round_index = next_round_index;
                next_round_index = next_round_index.saturating_add(1);
                turn.model_rounds.push(round);
            }
        }
        generated_count
    }

    /// Complete a reopened interrupted turn by appending only the messages
    /// produced by the current execution generation.
    pub async fn complete_recovered_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        execution_generation: u32,
        final_response: String,
        new_messages: &[Message],
        stats: TurnStats,
        finish_reason: Option<String>,
        has_final_response: Option<bool>,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {session_id}"
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {turn_id}"))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {turn_id}"))
            })?;

        if turn.status == TurnStatus::Completed && turn.recovery.is_none() {
            return Ok(());
        }
        let recovery = turn.recovery.as_ref().ok_or_else(|| {
            OpenBitFunError::Validation(format!(
                "Recovered dialog turn has no recovery metadata: {turn_id}"
            ))
        })?;
        if recovery.status != DialogTurnRecoveryStatus::Recovering
            || recovery.execution_generation != execution_generation
        {
            return Err(OpenBitFunError::Validation(format!(
                "Recovered turn generation mismatch: expected={execution_generation}, actual={}",
                recovery.execution_generation
            )));
        }

        let completion_timestamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let first_round_index = turn
            .model_rounds
            .iter()
            .map(|round| round.round_index)
            .max()
            .map_or(0, |index| index.saturating_add(1));
        let appended_count =
            Self::append_generation_rounds(&mut turn, turn_id, new_messages, completion_timestamp);
        if appended_count == 0 && !final_response.trim().is_empty() {
            turn.model_rounds.push(ModelRoundData {
                id: format!("{turn_id}-round-{first_round_index}"),
                turn_id: turn_id.to_string(),
                round_index: first_round_index,
                round_group_id: None,
                timestamp: completion_timestamp,
                text_items: vec![Self::make_text_item(
                    &format!("{turn_id}-round-{first_round_index}-text-0"),
                    &final_response,
                    completion_timestamp,
                    0,
                )],
                tool_items: Vec::new(),
                thinking_items: Vec::new(),
                start_time: completion_timestamp,
                end_time: Some(completion_timestamp),
                duration_ms: Some(0),
                provider_id: None,
                model_config_id: None,
                effective_model_name: None,
                first_chunk_ms: None,
                first_visible_output_ms: None,
                stream_duration_ms: None,
                attempt_count: None,
                attempt_diagnostics: vec![],
                failure_category: None,
                token_details: None,
                status: "completed".to_string(),
            });
        }
        turn.status = TurnStatus::Completed;
        turn.recovery_epoch = Some(execution_generation);
        turn.recovery = None;
        turn.finish_reason = finish_reason;
        turn.has_final_response = has_final_response;
        turn.duration_ms = Some(stats.duration_ms);
        turn.end_time = Some(completion_timestamp);

        // A recovered generation is Runtime-owned, so its context snapshot is
        // part of the completion commit. Persist it before the Completed Turn:
        // a crash after the snapshot leaves a Recovering Turn that restore can
        // safely normalize, while a Completed Turn never points at an older
        // same-index snapshot that omits this generation's tool/results tail.
        let context_messages = self.context_store.get_context_messages(session_id);
        self.persistence_manager
            .save_turn_context_snapshot(
                &workspace_path,
                session_id,
                turn.turn_index,
                &context_messages,
            )
            .await?;
        self.persistence_manager
            .save_dialog_turn(&workspace_path, &turn)
            .await?;
        Ok(())
    }

    /// Mark a dialog turn as failed and persist it.
    /// Unlike `complete_dialog_turn`, this sets the state to `Failed` with an error message.
    pub async fn fail_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        error: String,
    ) -> OpenBitFunResult<()> {
        self.fail_dialog_turn_with_messages(session_id, turn_id, error, &[])
            .await
    }

    pub(crate) async fn fail_dialog_turn_with_messages(
        &self,
        session_id: &str,
        turn_id: &str,
        error: String,
        generation_messages: &[Message],
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        if !self.should_persist_session_id(session_id) {
            debug!(
                "Skipping dialog turn persistence for transient session failure: session_id={}, turn_id={}, error={}",
                session_id, turn_id, error
            );
            return Ok(());
        }

        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let recovered_generation = turn.recovery.is_some();
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self::append_generation_rounds(&mut turn, turn_id, generation_messages, now);
        turn.status = TurnStatus::Error;
        turn.recovery = None;
        turn.finish_reason = Some("failed".to_string());
        turn.has_final_response = Some(false);
        turn.end_time = Some(now);

        if recovered_generation {
            let context_messages = self.context_store.get_context_messages(session_id);
            self.persistence_manager
                .save_turn_context_snapshot(
                    &workspace_path,
                    session_id,
                    turn.turn_index,
                    &context_messages,
                )
                .await?;
        } else {
            self.persist_context_snapshot_for_turn_best_effort(
                session_id,
                turn.turn_index,
                "turn_failed",
            )
            .await;
        }
        if self.should_persist_session_id(session_id) {
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn)
                .await?;
        }

        debug!(
            "Dialog turn marked as failed: turn_id={}, turn_index={}, error={}",
            turn_id, turn.turn_index, error
        );

        Ok(())
    }

    /// Mark a dialog turn as cancelled and persist it. Unlike
    /// `complete_dialog_turn`, this writes `TurnStatus::Cancelled` so the
    /// frontend / persistence layer can distinguish a user-cancelled turn
    /// from a fully-completed one. Any partial assistant content that was
    /// already streamed is preserved in `model_rounds`.
    pub async fn cancel_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> OpenBitFunResult<()> {
        self.cancel_dialog_turn_with_messages(session_id, turn_id, &[])
            .await
    }

    pub(crate) async fn cancel_dialog_turn_with_messages(
        &self,
        session_id: &str,
        turn_id: &str,
        generation_messages: &[Message],
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        if !self.should_persist_session_id(session_id) {
            debug!(
                "Skipping dialog turn persistence for transient session cancellation: session_id={}, turn_id={}",
                session_id, turn_id
            );
            return Ok(());
        }

        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let recovered_generation = turn.recovery.is_some();
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self::append_generation_rounds(&mut turn, turn_id, generation_messages, now);
        turn.status = TurnStatus::Cancelled;
        turn.recovery = None;
        turn.finish_reason = Some("cancelled".to_string());
        turn.end_time = Some(now);

        if recovered_generation {
            let context_messages = self.context_store.get_context_messages(session_id);
            self.persistence_manager
                .save_turn_context_snapshot(
                    &workspace_path,
                    session_id,
                    turn.turn_index,
                    &context_messages,
                )
                .await?;
        } else {
            self.persist_context_snapshot_for_turn_best_effort(
                session_id,
                turn.turn_index,
                "turn_cancelled",
            )
            .await;
        }

        self.persistence_manager
            .save_dialog_turn(&workspace_path, &turn)
            .await?;

        debug!(
            "Dialog turn marked as cancelled: turn_id={}, turn_index={}",
            turn_id, turn.turn_index
        );

        Ok(())
    }

    /// Persist a settled, intentionally interrupted user turn without adding a
    /// new persisted enum variant that older builds cannot deserialize.
    pub async fn mark_dialog_turn_interrupted(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> OpenBitFunResult<DialogTurnRecoveryData> {
        self.mark_dialog_turn_interrupted_with_messages(session_id, turn_id, &[])
            .await
    }

    pub(crate) async fn mark_dialog_turn_interrupted_with_messages(
        &self,
        session_id: &str,
        turn_id: &str,
        generation_messages: &[Message],
    ) -> OpenBitFunResult<DialogTurnRecoveryData> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        if !self.should_persist_session_id(session_id) {
            return Err(OpenBitFunError::Validation(
                "Recoverable interruption is unavailable for transient sessions".to_string(),
            ));
        }
        let session = self
            .get_session(session_id)
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        let turn_index = session
            .dialog_turn_ids
            .len()
            .checked_sub(1)
            .filter(|index| session.dialog_turn_ids[*index] == turn_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Only the latest dialog turn can be interrupted: {turn_id}"
                ))
            })?;
        let workspace_path = self
            .effective_storage_path_for_config(&session.config)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {session_id}"
                ))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {turn_id}"))
            })?;
        if turn.kind != DialogTurnKind::UserDialog {
            return Err(OpenBitFunError::Validation(
                "Only a user dialog turn can be interrupted".to_string(),
            ));
        }
        if turn
            .user_message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("acp_transport"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            return Err(OpenBitFunError::Validation(
                "Recoverable interruption is unavailable for ACP turns".to_string(),
            ));
        }
        if let Some(recovery) = turn
            .recovery
            .as_ref()
            .filter(|recovery| recovery.status == DialogTurnRecoveryStatus::Interrupted)
            .cloned()
        {
            if turn.recovery_epoch != Some(recovery.execution_generation) {
                turn.recovery_epoch = Some(recovery.execution_generation);
                self.persistence_manager
                    .save_dialog_turn(&workspace_path, &turn)
                    .await?;
            }
            return Ok(recovery);
        }
        if turn.status != TurnStatus::InProgress {
            return Err(OpenBitFunError::Validation(format!(
                "Dialog turn is not running: {turn_id}"
            )));
        }

        // Recovery is offered only when the exact settled model context is
        // durable. If this write fails, the coordinator falls back to an
        // ordinary non-recoverable cancellation rather than exposing a broken
        // continue button.
        let context_messages = self.context_store.get_context_messages(session_id);
        self.persistence_manager
            .save_turn_context_snapshot(&workspace_path, session_id, turn_index, &context_messages)
            .await?;
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let recovery = match turn.recovery.take() {
            Some(mut recovery) => {
                recovery.status = DialogTurnRecoveryStatus::Interrupted;
                recovery.interrupted_at = Some(now);
                recovery
            }
            None => DialogTurnRecoveryData {
                status: DialogTurnRecoveryStatus::Interrupted,
                execution_generation: 0,
                resume_count: 0,
                interrupted_at: Some(now),
                model_id: session.config.model_id.clone(),
            },
        };
        Self::append_generation_rounds(&mut turn, turn_id, generation_messages, now);
        turn.status = TurnStatus::Cancelled;
        turn.finish_reason = Some("interrupted".to_string());
        turn.end_time = Some(now);
        turn.duration_ms = Some(now.saturating_sub(turn.start_time));
        turn.recovery = Some(recovery.clone());
        turn.recovery_epoch = Some(recovery.execution_generation);
        self.persistence_manager
            .save_dialog_turn(&workspace_path, &turn)
            .await?;
        Ok(recovery)
    }

    /// Reopen the latest settled interrupted user turn from its exact context
    /// snapshot. This does not run prompt-submit hooks or append a user Turn.
    pub(crate) async fn reopen_interrupted_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        expected_execution_generation: u32,
    ) -> OpenBitFunResult<InterruptedTurnRecoveryPlan> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let session = self
            .get_session(session_id)
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Session not found: {session_id}")))?;
        let turn_index = session
            .dialog_turn_ids
            .len()
            .checked_sub(1)
            .filter(|index| session.dialog_turn_ids[*index] == turn_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Only the latest dialog turn can be recovered: {turn_id}"
                ))
            })?;
        let workspace_path = self
            .effective_storage_path_for_config(&session.config)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {session_id}"
                ))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {turn_id}"))
            })?;
        let original_turn = turn.clone();
        let recovery = turn.recovery.as_ref().ok_or_else(|| {
            OpenBitFunError::Validation(format!("Dialog turn has no recovery metadata: {turn_id}"))
        })?;
        if recovery.status != DialogTurnRecoveryStatus::Interrupted
            || recovery.execution_generation != expected_execution_generation
        {
            return Err(OpenBitFunError::Validation(format!(
                "Interrupted turn generation mismatch: expected={}, actual={}",
                expected_execution_generation, recovery.execution_generation
            )));
        }
        if recovery.model_id != session.config.model_id {
            return Err(OpenBitFunError::Validation(
                "The session model changed after interruption; start a new turn instead"
                    .to_string(),
            ));
        }
        if turn
            .agent_type
            .as_deref()
            .is_some_and(|agent_type| agent_type != session.agent_type)
        {
            return Err(OpenBitFunError::Validation(
                "The session agent mode changed after interruption; start a new turn instead"
                    .to_string(),
            ));
        }
        if turn.kind != DialogTurnKind::UserDialog || turn.status != TurnStatus::Cancelled {
            return Err(OpenBitFunError::Validation(format!(
                "Dialog turn is not recoverably interrupted: {turn_id}"
            )));
        }
        if turn
            .user_message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("acp_transport"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            return Err(OpenBitFunError::Validation(
                "Interrupted ACP turns cannot be recovered through the native runtime".to_string(),
            ));
        }
        if !matches!(session.state, SessionState::Idle) {
            return Err(OpenBitFunError::Validation(format!(
                "Session must be idle before recovering turn: {turn_id}"
            )));
        }
        let mut messages = self
            .persistence_manager
            .load_turn_context_snapshot(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Context snapshot is unavailable for interrupted turn: {turn_id}"
                ))
            })?;
        messages.retain(|message| {
            message.internal_reminder_kind() != Some(InternalReminderKind::InterruptedContinue)
        });
        messages.push(
            Message::internal_reminder(
                InternalReminderKind::InterruptedContinue,
                "Your previous work was interrupted by the user. Continue the same task from the last safe context boundary. Do not repeat completed work or assume that an interrupted tool call had no side effects; verify uncertain external state before acting again.",
            )
            .with_turn_id(turn_id.to_string()),
        );

        let next_generation = recovery.execution_generation.saturating_add(1);
        let next_resume_count = recovery.resume_count.saturating_add(1);
        turn.status = TurnStatus::InProgress;
        turn.finish_reason = None;
        turn.end_time = None;
        turn.duration_ms = None;
        turn.error = None;
        turn.error_detail = None;
        turn.recovery = Some(DialogTurnRecoveryData {
            status: DialogTurnRecoveryStatus::Recovering,
            execution_generation: next_generation,
            resume_count: next_resume_count,
            interrupted_at: recovery.interrupted_at,
            model_id: recovery.model_id.clone(),
        });
        turn.recovery_epoch = Some(next_generation);
        let initial_round_index = turn
            .model_rounds
            .iter()
            .map(|round| round.round_index)
            .max()
            .map_or(0, |index| index.saturating_add(1));
        let agent_type = turn
            .agent_type
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Interrupted turn has no agent type: {turn_id}"
                ))
            })?;
        let user_message_metadata = turn.user_message.metadata.clone();
        let resolved_permission_mode = user_message_metadata
            .as_ref()
            .and_then(|metadata| metadata.get(INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY))
            .and_then(serde_json::Value::as_str)
            .and_then(PermissionMode::parse)
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Interrupted turn has no frozen permission mode; start a new turn instead"
                        .to_string(),
                )
            })?;
        let resolved_model_id = user_message_metadata
            .as_ref()
            .and_then(|metadata| metadata.get(INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|model_id| !model_id.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Interrupted turn has no frozen resolved model; start a new turn instead"
                        .to_string(),
                )
            })?;
        let expected_model_binding_fingerprint = user_message_metadata
            .as_ref()
            .and_then(|metadata| {
                metadata.get(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
            })
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|fingerprint| !fingerprint.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Interrupted turn has no frozen model binding; start a new turn instead"
                        .to_string(),
                )
            })?;
        let ai_config = Self::load_ai_config_for_model_resolution()
            .await
            .ok_or_else(|| {
                OpenBitFunError::AIClient(
                    "AI configuration is unavailable; retry interrupted turn recovery".to_string(),
                )
            })?;
        let canonical_model_id = ai_config
            .resolve_model_reference(&resolved_model_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "The interrupted turn model is unavailable: {resolved_model_id}"
                ))
            })?;
        let model = ai_config
            .models
            .iter()
            .find(|model| model.enabled && model.id == canonical_model_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "The interrupted turn model is unavailable: {resolved_model_id}"
                ))
            })?;
        if model_runtime_binding_fingerprint(model) != expected_model_binding_fingerprint {
            return Err(OpenBitFunError::Validation(format!(
                "The interrupted turn model binding changed after interruption: {resolved_model_id}"
            )));
        }
        let resolved_reasoning_preset = match user_message_metadata
            .as_ref()
            .and_then(|metadata| metadata.get(INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY))
        {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(value)) => value
                .trim()
                .is_empty()
                .then_some(None)
                .unwrap_or_else(|| Some(value.trim().to_string())),
            _ => {
                return Err(OpenBitFunError::Validation(
                    "Interrupted turn has no frozen reasoning preset; start a new turn instead"
                        .to_string(),
                ))
            }
        };
        let expected_reasoning_fingerprint = user_message_metadata
            .as_ref()
            .and_then(|metadata| metadata.get(INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|fingerprint| !fingerprint.is_empty())
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Interrupted turn has no frozen reasoning fingerprint; start a new turn instead"
                        .to_string(),
                )
            })?;
        let reasoning_selection =
            match user_message_metadata.as_ref().and_then(|metadata| {
                metadata.get(INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY)
            }) {
                Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value)) => value
                    .trim()
                    .is_empty()
                    .then_some(None)
                    .unwrap_or_else(|| Some(value.trim().to_string())),
                _ => return Err(OpenBitFunError::Validation(
                    "Interrupted turn has no frozen reasoning selection; start a new turn instead"
                        .to_string(),
                )),
            };
        if reasoning_selection != session.config.reasoning_preset {
            return Err(OpenBitFunError::Validation(
                "The session reasoning preset changed after interruption; start a new turn instead"
                    .to_string(),
            ));
        }
        let (current_resolved_reasoning_preset, current_reasoning_fingerprint) =
            Self::resolve_effective_reasoning_preset_from_config(
                &ai_config,
                &resolved_model_id,
                reasoning_selection.as_deref(),
            )
            .await?;
        if current_resolved_reasoning_preset != resolved_reasoning_preset {
            return Err(OpenBitFunError::Validation(
                "The dialog turn reasoning contract changed after interruption; start a new turn instead"
                    .to_string(),
            ));
        }
        if current_reasoning_fingerprint != expected_reasoning_fingerprint {
            return Err(OpenBitFunError::Validation(
                "The dialog turn reasoning runtime contract changed after interruption; start a new turn instead"
                    .to_string(),
            ));
        }
        let user_input = turn.user_message.content.clone();

        let mut updated_session = session.clone();
        updated_session.state = SessionState::Processing {
            current_turn_id: turn_id.to_string(),
            phase: ProcessingPhase::Starting,
        };
        let now = SystemTime::now();
        updated_session.updated_at = now;
        updated_session.last_activity_at = now;

        self.persistence_manager
            .save_turn_context_snapshot(&workspace_path, session_id, turn_index, &messages)
            .await?;
        if let Err(error) = self
            .persistence_manager
            .save_dialog_turn(&workspace_path, &turn)
            .await
        {
            if let Err(rollback_error) = self
                .persistence_manager
                .save_dialog_turn(&workspace_path, &original_turn)
                .await
            {
                return Err(OpenBitFunError::session(format!(
                    "Recovery turn persistence failed and rollback did not complete: session_id={session_id}, turn_id={turn_id}, error={error}, rollback_error={rollback_error}"
                )));
            }
            return Err(error);
        }
        if let Err(error) = self
            .persistence_manager
            .save_session(&workspace_path, &updated_session)
            .await
        {
            let session_rollback = self
                .persistence_manager
                .save_session(&workspace_path, &session)
                .await;
            let turn_rollback = self
                .persistence_manager
                .save_dialog_turn(&workspace_path, &original_turn)
                .await;
            if session_rollback.is_err() || turn_rollback.is_err() {
                return Err(OpenBitFunError::session(format!(
                    "Recovery persistence failed and rollback did not complete: session_id={session_id}, turn_id={turn_id}, error={error}, session_rollback_error={:?}, turn_rollback_error={:?}",
                    session_rollback.err(),
                    turn_rollback.err(),
                )));
            }
            return Err(error);
        }

        self.sessions
            .insert(session_id.to_string(), updated_session);
        self.context_store
            .replace_context(session_id, messages.clone());
        self.clear_turn_settlement_result(session_id, turn_id);

        Ok(InterruptedTurnRecoveryPlan {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            turn_index,
            agent_type,
            execution_generation: next_generation,
            resume_count: next_resume_count,
            initial_round_index,
            resolved_permission_mode,
            resolved_model_id,
            model_binding_fingerprint: expected_model_binding_fingerprint,
            user_input,
            messages,
            user_message_metadata,
        })
    }

    pub(crate) async fn latest_dialog_turn_holds_dispatch(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        if !self.should_persist_session_id(session_id) {
            return Ok(false);
        }
        let Some(session) = self.get_session(session_id) else {
            return Ok(false);
        };
        let Some(turn_index) = session.dialog_turn_ids.len().checked_sub(1) else {
            return Ok(false);
        };
        let Some(workspace_path) = self
            .effective_storage_path_for_config(&session.config)
            .await
        else {
            return Ok(false);
        };
        let Some(turn) = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
        else {
            return Ok(false);
        };
        Ok(turn.status == TurnStatus::Cancelled
            && turn
                .recovery
                .as_ref()
                .is_some_and(|recovery| recovery.status == DialogTurnRecoveryStatus::Interrupted))
    }

    pub(crate) async fn abandon_interrupted_dialog_turn(
        &self,
        session_id: &str,
        expected_turn_id: Option<&str>,
    ) -> OpenBitFunResult<Option<String>> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        let Some(session) = self.get_session(session_id) else {
            return Ok(None);
        };
        let turn_index = match expected_turn_id {
            Some(expected) => session
                .dialog_turn_ids
                .iter()
                .position(|turn_id| turn_id == expected),
            None => session.dialog_turn_ids.len().checked_sub(1),
        };
        let Some(turn_index) = turn_index else {
            return Ok(None);
        };
        let Some(workspace_path) = self
            .effective_storage_path_for_config(&session.config)
            .await
        else {
            return Ok(None);
        };
        let Some(mut turn) = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
        else {
            return Ok(None);
        };
        if turn.status != TurnStatus::Cancelled
            || !turn
                .recovery
                .as_ref()
                .is_some_and(|recovery| recovery.status == DialogTurnRecoveryStatus::Interrupted)
        {
            return Ok(None);
        }
        turn.recovery = None;
        turn.finish_reason = Some("cancelled".to_string());
        let turn_id = turn.turn_id.clone();
        self.persistence_manager
            .save_dialog_turn(&workspace_path, &turn)
            .await?;
        Ok(Some(turn_id))
    }

    /// Complete a maintenance turn and persist its synthetic model round payload.
    pub async fn complete_maintenance_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        model_rounds: Vec<ModelRoundData>,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        self.complete_turn_with_model_rounds(
            session_id,
            turn_id,
            model_rounds,
            duration_ms,
            "maintenance_turn_completed",
        )
        .await
    }

    pub(crate) async fn complete_synthetic_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        model_rounds: Vec<ModelRoundData>,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        self.complete_turn_with_model_rounds(
            session_id,
            turn_id,
            model_rounds,
            duration_ms,
            "synthetic_dialog_turn_completed",
        )
        .await
    }

    async fn complete_turn_with_model_rounds(
        &self,
        session_id: &str,
        turn_id: &str,
        model_rounds: Vec<ModelRoundData>,
        duration_ms: u64,
        snapshot_reason: &str,
    ) -> OpenBitFunResult<()> {
        if !self.should_persist_session_id(session_id) {
            debug!(
                "Skipping turn persistence for transient session completion: session_id={}, turn_id={}, rounds={}, duration_ms={}",
                session_id,
                turn_id,
                model_rounds.len(),
                duration_ms
            );
            return Ok(());
        }

        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;

        let completion_timestamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        turn.model_rounds = model_rounds;
        turn.status = TurnStatus::Completed;
        turn.duration_ms = Some(duration_ms);
        turn.end_time = Some(completion_timestamp);

        self.persist_context_snapshot_for_turn_best_effort(
            session_id,
            turn.turn_index,
            snapshot_reason,
        )
        .await;

        if self.should_persist_session_id(session_id) {
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn)
                .await?;
        }

        Ok(())
    }

    /// Mark a maintenance turn as failed while preserving its synthetic tool state.
    pub async fn fail_maintenance_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        error: String,
        model_rounds: Vec<ModelRoundData>,
    ) -> OpenBitFunResult<()> {
        self.fail_turn_with_model_rounds(
            session_id,
            turn_id,
            error,
            model_rounds,
            "maintenance_turn_failed",
        )
        .await
    }

    pub(crate) async fn fail_synthetic_dialog_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        error: String,
        model_rounds: Vec<ModelRoundData>,
    ) -> OpenBitFunResult<()> {
        self.fail_turn_with_model_rounds(
            session_id,
            turn_id,
            error,
            model_rounds,
            "synthetic_dialog_turn_failed",
        )
        .await
    }

    async fn fail_turn_with_model_rounds(
        &self,
        session_id: &str,
        turn_id: &str,
        error: String,
        model_rounds: Vec<ModelRoundData>,
        snapshot_reason: &str,
    ) -> OpenBitFunResult<()> {
        if !self.should_persist_session_id(session_id) {
            debug!(
                "Skipping turn persistence for transient session failure: session_id={}, turn_id={}, rounds={}, error={}",
                session_id,
                turn_id,
                model_rounds.len(),
                error
            );
            return Ok(());
        }

        let workspace_path = self
            .effective_session_storage_path(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Session workspace_path is missing: {}",
                    session_id
                ))
            })?;
        let turn_index = self
            .sessions
            .get(session_id)
            .and_then(|session| session.dialog_turn_ids.iter().position(|id| id == turn_id))
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;
        let mut turn = self
            .persistence_manager
            .load_dialog_turn(&workspace_path, session_id, turn_index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Dialog turn not found: {}", turn_id))
            })?;

        let completion_timestamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        turn.model_rounds = model_rounds;
        turn.status = TurnStatus::Error;
        turn.error = Some(error.clone());
        turn.finish_reason = Some("failed".to_string());
        turn.has_final_response = Some(false);
        turn.duration_ms = Some(completion_timestamp.saturating_sub(turn.start_time));
        turn.end_time = Some(completion_timestamp);

        self.persist_context_snapshot_for_turn_best_effort(
            session_id,
            turn.turn_index,
            snapshot_reason,
        )
        .await;

        if self.should_persist_session_id(session_id) {
            self.persistence_manager
                .save_dialog_turn(&workspace_path, &turn)
                .await?;
        }

        debug!(
            "Turn marked as failed: turn_id={}, turn_index={}, error={}",
            turn_id, turn.turn_index, error
        );

        Ok(())
    }

    // ============ Helper Methods ============

    /// Get a best-effort message view for the session.
    /// When persistence is enabled, rebuild from persisted turns so callers see the
    /// canonical turn history instead of the runtime context cache.
    pub async fn get_messages(&self, session_id: &str) -> OpenBitFunResult<Vec<Message>> {
        if self.config.enable_persistence {
            if let Some(workspace_path) = self.effective_session_storage_path(session_id).await {
                let _history_read = self.acquire_session_mutation(session_id).await?;
                let messages = self
                    .rebuild_messages_from_turns(&workspace_path, session_id)
                    .await?;
                if !messages.is_empty() {
                    return Ok(messages);
                }
            }
        }

        Ok(self.context_store.get_context_messages(session_id))
    }

    /// Load canonical persisted turns for a user-facing transcript.
    ///
    /// This is intentionally separate from `get_messages`: runtime context
    /// reconstruction excludes model-invisible maintenance turns, while a
    /// transcript must be able to project those turns for the UI.
    pub(crate) async fn load_persisted_transcript_turns_locked(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<Option<Vec<DialogTurnData>>> {
        if !self.should_persist_session_id(session_id) {
            return Ok(None);
        }
        let Some(workspace_path) = self.effective_session_storage_path(session_id).await else {
            return Ok(None);
        };
        let mut turns = self
            .persistence_manager
            .load_session_turns(&workspace_path, session_id)
            .await?;
        if let Some(revert) = self
            .persistence_manager
            .load_session_revert_state(&workspace_path, session_id)
            .await?
        {
            turns.retain(|turn| turn.turn_index < revert.boundary_turn);
        }
        Ok(Some(turns))
    }

    /// Get a paginated best-effort message view for the session.
    pub async fn get_messages_paginated(
        &self,
        session_id: &str,
        limit: usize,
        before_message_id: Option<&str>,
    ) -> OpenBitFunResult<(Vec<Message>, bool)> {
        let messages = self.get_messages(session_id).await?;
        Ok(Self::paginate_messages(&messages, limit, before_message_id))
    }

    /// Get session's runtime context messages (may already include compressed reminders).
    pub async fn get_context_messages(&self, session_id: &str) -> OpenBitFunResult<Vec<Message>> {
        let context_messages = self.context_store.get_context_messages(session_id);

        Ok(context_messages)
    }

    /// Add a semantic message to the runtime context cache and immediately refresh the current
    /// turn snapshot so crashes do not lose the latest in-memory context change.
    pub async fn add_message(&self, session_id: &str, message: Message) -> OpenBitFunResult<()> {
        let memory_citation = message.metadata.memory_citation.clone();
        let turn_id = message.metadata.turn_id.clone();
        let round_id = message.metadata.round_id.clone();
        let message_id = message.id.clone();
        self.context_store.add_message(session_id, message);
        if let Some(citation) = memory_citation.as_ref() {
            if let Err(error) = self
                .memory_database
                .record_memory_citation(
                    session_id,
                    turn_id.as_deref(),
                    round_id.as_deref(),
                    &message_id,
                    citation,
                )
                .await
            {
                warn!(
                    "Failed to record memory citation: session_id={}, message_id={}, error={}",
                    session_id, message_id, error
                );
            }
        }
        self.persist_current_turn_context_snapshot_best_effort(session_id, "context_message_added")
            .await;
        Ok(())
    }

    /// Replace the runtime context cache for a session and immediately refresh the current turn
    /// snapshot. This is primarily used after compression rewrites the model-visible context.
    pub async fn replace_context_messages(&self, session_id: &str, messages: Vec<Message>) {
        self.context_store
            .replace_context(session_id, messages.clone());
        self.review_read_receipt_store.clear_session(session_id);
        self.prune_token_anchors_to_messages(session_id, &messages)
            .await;
        self.persist_current_turn_context_snapshot_best_effort(session_id, "context_replaced")
            .await;
    }

    /// Caller holds the session mutation guard through the subsequent formal
    /// compression side effects. The context entry lock also fences appends.
    pub(crate) fn transform_compression_context<T>(
        &self,
        session_id: &str,
        transform: impl FnOnce(&[Message]) -> OpenBitFunResult<(Option<Vec<Message>>, T)>,
    ) -> OpenBitFunResult<T> {
        self.context_store
            .try_transform_context(session_id, transform)
    }

    pub(crate) async fn persist_compression_context(&self, session_id: &str, messages: &[Message]) {
        self.review_read_receipt_store.clear_session(session_id);
        self.prune_token_anchors_to_messages(session_id, messages)
            .await;
        self.persist_current_turn_context_snapshot_best_effort(session_id, "context_compressed")
            .await;
    }

    pub fn record_review_read(
        &self,
        session_id: &str,
        logical_path: &str,
        revision: FileRevision,
        start_line: usize,
        end_line: usize,
        total_lines: usize,
    ) {
        self.review_read_receipt_store.record_review_read(
            session_id,
            logical_path,
            revision,
            start_line,
            end_line,
            total_lines,
        );
    }

    pub fn review_read_coverage(
        &self,
        session_id: &str,
        logical_path: &str,
        revision: FileRevision,
        start_line: usize,
        limit: usize,
    ) -> Option<ReviewReadCoverage> {
        self.review_read_receipt_store.review_read_coverage(
            session_id,
            logical_path,
            revision,
            start_line,
            limit,
        )
    }

    /// Get dialog turn count
    pub fn get_turn_count(&self, session_id: &str) -> usize {
        self.sessions
            .get(session_id)
            .map(|s| s.dialog_turn_ids.len())
            .unwrap_or(0)
    }

    /// Get session's compression state
    pub fn get_compression_state(&self, session_id: &str) -> Option<CompressionState> {
        self.sessions
            .get(session_id)
            .map(|s| s.compression_state.clone())
    }

    /// Update session's compression state
    pub async fn update_compression_state(
        &self,
        session_id: &str,
        compression_state: CompressionState,
    ) -> OpenBitFunResult<()> {
        let _mutation_guard = self.acquire_session_mutation(session_id).await?;
        self.update_compression_state_locked(session_id, compression_state)
            .await
    }

    pub(crate) async fn update_compression_state_locked(
        &self,
        session_id: &str,
        compression_state: CompressionState,
    ) -> OpenBitFunResult<()> {
        let effective_path = self.effective_session_storage_path(session_id).await;

        // IMPORTANT: keep the DashMap guard scope short -- do NOT hold it across .await.
        let session_snapshot = if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.compression_state = compression_state;
            session.updated_at = SystemTime::now();
            session.last_activity_at = SystemTime::now();
            if self.config.enable_persistence && self.should_persist_session(&session) {
                Some(session.clone())
            } else {
                None
            }
        } else {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        };
        // RefMut guard released here -- DashMap shard lock is free.

        if let Some(session) = session_snapshot {
            if let Some(ref workspace_path) = effective_path {
                self.persistence_manager
                    .save_session(workspace_path, &session)
                    .await?;
            }
        }

        Ok(())
    }

    async fn try_generate_session_title_with_ai(
        &self,
        session_id: &str,
        user_message: &str,
        max_length: usize,
    ) -> OpenBitFunResult<Option<String>> {
        use crate::util::types::Message;

        // Match agent `LANGUAGE_PREFERENCE`: use `app.language`, not I18nService (see `app_language` module).
        let lang_code = get_app_language_code().await;
        let language_instruction = short_model_user_language_instruction(lang_code.as_str());

        // Construct system prompt
        let system_prompt = format!(
            "You are a professional session title generation assistant. Based on the user's message content, generate a concise and accurate session title.\n\nRequirements:\n- Title should not exceed {} characters\n- {}\n- Concise and accurate, reflecting the conversation topic\n- Do not add quotes or other decorative symbols\n- Return only the title text, no other content",
            max_length, language_instruction
        );

        // Truncate message to save tokens (max 200 characters)
        let truncated_message = if user_message.chars().count() > 200 {
            format!("{}...", user_message.chars().take(200).collect::<String>())
        } else {
            user_message.to_string()
        };

        let user_prompt = format!(
            "User message: {}\n\nPlease generate session title:",
            truncated_message
        );

        // Construct messages (using AIClient's Message type)
        let messages = vec![
            Message {
                role: "system".to_string(),
                content: Some(system_prompt),
                reasoning_content: None,
                thinking_signature: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
                is_error: None,
                tool_image_attachments: None,
                model_response_replay: None,
            },
            Message {
                role: "user".to_string(),
                content: Some(user_prompt),
                reasoning_content: None,
                thinking_signature: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
                is_error: None,
                tool_image_attachments: None,
                model_response_replay: None,
            },
        ];

        // Resolve the task model. Inherit uses the session's resolved model
        // identity but deliberately does not carry its reasoning preset.
        let ai_client_factory = get_global_ai_client_factory().await.map_err(|e| {
            OpenBitFunError::AIClient(format!("Failed to get AI client factory: {}", e))
        })?;
        let ai_config = Self::load_ai_config_for_model_resolution()
            .await
            .ok_or_else(|| {
                OpenBitFunError::AIClient("Failed to load AI configuration".to_string())
            })?;
        let ai_client = match &ai_config.task_models.session_title {
            crate::service::config::types::TaskModelSelection::Fixed { model_id } => {
                ai_client_factory.get_client_resolved(model_id).await
            }
            crate::service::config::types::TaskModelSelection::Inherit => {
                let session = self.get_session(session_id).ok_or_else(|| {
                    OpenBitFunError::NotFound(format!("Session not found: {session_id}"))
                })?;
                let explicit_model_id = session
                    .config
                    .model_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|model_id| !model_id.is_empty());
                let fallback_model_id = if explicit_model_id.is_none() {
                    let workspace = session.config.workspace_id.as_deref();
                    Some(
                        get_agent_registry()
                            .get_model_id_for_agent(&session.agent_type, workspace)
                            .await
                            .map_err(|error| {
                                OpenBitFunError::AIClient(format!(
                                    "Failed to resolve session Agent model: {error}"
                                ))
                            })?,
                    )
                } else {
                    None
                };
                let configured_model_id = explicit_model_id
                    .or(fallback_model_id.as_deref())
                    .unwrap_or("primary");
                let selector = configured_model_id;
                let resolved_model_id =
                    ai_config.resolve_model_selection(selector).ok_or_else(|| {
                        OpenBitFunError::AIClient(format!(
                            "Failed to resolve inherited session model: {selector}"
                        ))
                    })?;
                if matches!(
                    session.config.model_binding_policy,
                    SessionModelBindingPolicy::ApprovedImmutable
                ) {
                    let fingerprint = session
                        .config
                        .model_binding_fingerprint
                        .as_deref()
                        .ok_or_else(|| {
                            OpenBitFunError::AIClient(
                                "Inherited immutable session model has no approved fingerprint"
                                    .to_string(),
                            )
                        })?;
                    ai_client_factory
                        .get_client_by_approved_binding(&resolved_model_id, fingerprint)
                        .await
                } else {
                    ai_client_factory.get_client_by_id(&resolved_model_id).await
                }
            }
        }
        .map_err(|e| OpenBitFunError::AIClient(format!("Failed to get AI client: {}", e)))?;

        let response = ai_client
            .send_message(messages, None)
            .await
            .map_err(|e| OpenBitFunError::ai(format!("AI call failed: {}", e)))?;

        let title = sanitize_plain_model_output(&response.text);
        if title.is_empty() {
            return Ok(None);
        }

        // Truncate title
        let final_title = if title.chars().count() > max_length {
            title.chars().take(max_length).collect::<String>()
        } else {
            title
        };

        Ok(Some(final_title))
    }

    /// Generate a concise session title, using AI first and falling back to a local heuristic.
    pub async fn resolve_session_title(
        &self,
        session_id: &str,
        user_message: &str,
        max_length: Option<usize>,
        allow_ai: bool,
    ) -> ResolvedSessionTitle {
        let max_length = max_length.unwrap_or(20).max(1);

        if allow_ai {
            match self
                .try_generate_session_title_with_ai(session_id, user_message, max_length)
                .await
            {
                Ok(Some(title)) => {
                    return ResolvedSessionTitle {
                        title,
                        method: SessionTitleMethod::Ai,
                    };
                }
                Ok(None) => {
                    warn!("AI session title generation returned empty output; using fallback");
                }
                Err(error) => {
                    warn!("AI session title generation failed; using fallback: {error}");
                }
            }
        }

        ResolvedSessionTitle {
            title: Self::fallback_session_title(user_message, max_length),
            method: SessionTitleMethod::Fallback,
        }
    }

    /// Generate session title
    ///
    /// Generate a concise and accurate session title based on user message content.
    pub async fn generate_session_title(
        &self,
        session_id: &str,
        user_message: &str,
        max_length: Option<usize>,
    ) -> OpenBitFunResult<String> {
        Ok(self
            .resolve_session_title(session_id, user_message, max_length, true)
            .await
            .title)
    }

    // ============ Background Tasks ============

    /// Start auto-save task
    fn spawn_auto_save_task(&self) {
        let sessions = self.sessions.clone();
        let transient_session_ids = self.transient_session_ids.clone();
        let persistence = self.persistence_manager.clone();
        let session_mutation_locks = self.session_mutation_locks.clone();
        let interval = self.config.auto_save_interval;

        tokio::spawn(async move {
            let mut ticker = Self::auto_save_interval(interval);

            loop {
                ticker.tick().await;

                for snapshot in Self::collect_auto_save_snapshots(&sessions, &transient_session_ids)
                {
                    let _mutation_guard = session_mutation_locks.lock(&snapshot.session_id).await;
                    if !Self::auto_save_snapshot_is_current(&sessions, &snapshot) {
                        continue;
                    }
                    if let Some(workspace_path) =
                        Self::effective_storage_path_for_config_with_persistence(
                            persistence.as_ref(),
                            &snapshot.session.config,
                        )
                        .await
                    {
                        if !Self::auto_save_snapshot_is_current(&sessions, &snapshot) {
                            continue;
                        }
                        if let Err(e) = persistence
                            .save_session(&workspace_path, &snapshot.session)
                            .await
                        {
                            error!(
                                "Failed to auto-save session: session_id={}, error={}",
                                snapshot.session_id, e
                            );
                        }
                    }
                }
            }
        });

        debug!("Auto-save task started");
    }

    /// Start cleanup task for expired sessions
    fn spawn_cleanup_task(&self) {
        let sessions = self.sessions.clone();
        let active_turn_permission_modes = self.active_turn_permission_modes.clone();
        let transient_session_ids = self.transient_session_ids.clone();
        let active_session_permits = self.active_session_permits.clone();
        let timeout = self.config.session_idle_timeout;
        let persistence = self.persistence_manager.clone();
        let enable_persistence = self.config.enable_persistence;
        let session_mutation_locks = self.session_mutation_locks.clone();
        let session_write_locks = self.session_write_locks.clone();
        let context_store = self.context_store.clone();
        let prompt_cache_store = self.prompt_cache_store.clone();
        let token_anchor_store = self.token_anchor_store.clone();
        let turn_skill_agent_snapshot_store = self.turn_skill_agent_snapshot_store.clone();
        let skill_agent_baseline_override_snapshot_store =
            self.skill_agent_baseline_override_snapshot_store.clone();
        let edit_constraints_store = self.edit_constraints_store.clone();
        let review_read_receipt_store = self.review_read_receipt_store.clone();
        let evidence_ledger = self.evidence_ledger.clone();

        tokio::spawn(async move {
            let mut ticker = time::interval(Duration::from_secs(60));

            loop {
                ticker.tick().await;

                let now = SystemTime::now();
                let candidates = Self::collect_expired_session_candidates(
                    &sessions,
                    &transient_session_ids,
                    now,
                    timeout,
                );

                for candidate in candidates {
                    let _mutation_guard = session_mutation_locks.lock(&candidate.session_id).await;
                    debug!(
                        "Cleaning up expired session: session_id={}",
                        candidate.session_id
                    );

                    let cleanup_now = SystemTime::now();
                    let Some(session) = Self::cleanup_snapshot_for_candidate(
                        &sessions,
                        &candidate,
                        cleanup_now,
                        timeout,
                    ) else {
                        continue;
                    };

                    let mut can_remove = true;
                    if enable_persistence
                        && Self::should_persist_session_with_transient_ids(
                            &session,
                            &transient_session_ids,
                        )
                    {
                        if let Some(workspace_path) =
                            Self::effective_storage_path_for_config_with_persistence(
                                persistence.as_ref(),
                                &session.config,
                            )
                            .await
                        {
                            if Self::cleanup_snapshot_for_candidate(
                                &sessions,
                                &candidate,
                                SystemTime::now(),
                                timeout,
                            )
                            .is_some()
                            {
                                if let Err(error) =
                                    persistence.save_session(&workspace_path, &session).await
                                {
                                    error!(
                                        "Failed to save Session before idle eviction: session_id={}, error={}",
                                        candidate.session_id, error
                                    );
                                    can_remove = false;
                                }
                            }
                        } else {
                            can_remove = false;
                        }
                    }

                    if !can_remove {
                        continue;
                    }

                    let removal_now = SystemTime::now();
                    if sessions
                        .remove_if(&candidate.session_id, |_, session| {
                            Self::cleanup_candidate_matches_session(
                                session,
                                &candidate,
                                removal_now,
                                timeout,
                            )
                        })
                        .is_some()
                    {
                        active_session_permits.remove(&candidate.session_id);
                        session_write_locks.remove(&candidate.session_id);
                        active_turn_permission_modes.remove(&candidate.session_id);
                        clear_session_runtime_stores(
                            &candidate.session_id,
                            context_store.as_ref(),
                            prompt_cache_store.as_ref(),
                            token_anchor_store.as_ref(),
                            turn_skill_agent_snapshot_store.as_ref(),
                            skill_agent_baseline_override_snapshot_store.as_ref(),
                            review_read_receipt_store.as_ref(),
                            evidence_ledger.as_ref(),
                        );
                        edit_constraints_store.remove(&candidate.session_id);
                    }
                }
            }
        });

        debug!("Cleanup task started");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        should_apply_session_model_fallback, CoreSessionStorePort, PermissionMode,
        SessionExecutionBindingError, SessionExecutionBindingUpdate, SessionManager,
        SessionManagerConfig, TurnAdmissionSessionFacts, TEST_MODEL_RESOLUTION_AI_CONFIG,
    };
    use crate::agentic::core::{
        CompressionState, Message, MessageContent, MessageRole, MessageSemanticKind,
        ProcessingPhase, Session, SessionAgentRouteOwner, SessionConfig, SessionModelBindingPolicy,
        SessionState, ToolCall, ToolResult, TurnStats,
    };
    use crate::agentic::persistence::{PersistenceManager, SessionBranchRequest};
    use crate::agentic::session::{
        revert::{SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION},
        EvidenceLedgerCheckpoint, PersistedEvidenceLedgerFile, PromptCachePolicy, PromptCacheScope,
        SessionContextStore, SystemPromptCacheIdentity, UserContextCacheIdentity,
    };
    #[cfg(feature = "remote-workspace")]
    use crate::agentic::session::{EvidenceLedgerEventStatus, EvidenceLedgerTargetKind};
    use crate::agentic::skill_agent_snapshot::{SkillSnapshotEntry, TurnSkillAgentSnapshot};
    use crate::infrastructure::ai::reasoning_catalog::{
        project_model_reasoning_catalog as project_test_model_reasoning_catalog,
        reasoning_preset_runtime_fingerprint as test_reasoning_preset_runtime_fingerprint,
        resolve_default_reasoning_preset as resolve_test_default_reasoning_preset,
        resolve_reasoning_preset as resolve_test_reasoning_preset,
    };
    use crate::infrastructure::PathManager;
    use crate::service::config::types::{
        model_runtime_binding_fingerprint as service_model_runtime_binding_fingerprint,
        AIConfig as ServiceAIConfig, AIModelConfig as ServiceAIModelConfig,
    };
    use crate::service::config::{ConfigManagerSettings, ConfigService};
    use crate::service::session::{
        DialogTurnData, DialogTurnKind, DialogTurnRecoveryStatus, ModelRoundData,
        SessionContextUsage, SessionContextUsageSource, SessionKind, SessionMetadata,
        SessionRelationship, SessionRelationshipKind, ToolCallData, ToolItemData, ToolResultData,
        TurnStatus, UserMessageData,
    };
    use crate::util::errors::OpenBitFunError;
    use dashmap::{try_result::TryResult, DashMap};
    use openbitfun_core_types::{
        ReasoningCatalogBinding, ReasoningConfig, ReasoningPreset, ReasoningPresetAction,
        SessionExecutionTarget,
    };
    use openbitfun_runtime_ports::{
        AgentTurnSettlementResult, AgentTurnSettlementStatus, SessionStoragePathRequest,
    };
    use openbitfun_services_core::session::SessionBranchBoundary;
    use serde_json::json;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};
    use uuid::Uuid;

    #[test]
    fn classified_edit_history_preserves_detail_and_readable_error() {
        let assistant = Message::assistant_with_tools(
            String::new(),
            vec![ToolCall {
                tool_id: "edit-1".into(),
                tool_name: "Edit".into(),
                arguments: json!({}),
                raw_arguments: None,
                is_error: false,
                parse_error: None,
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            }],
        );
        let result = Message::tool_result(ToolResult {
            tool_id: "edit-1".into(),
            tool_name: "Edit".into(),
            effective_tool_name: None,
            result: json!({"error":"[guidance] Inputs are equal", "error_detail":{"code":"edit_no_change", "kind":"guidance"}}),
            result_for_assistant: None,
            is_error: true,
            duration_ms: None,
            image_attachments: None,
        });
        let rounds =
            SessionManager::build_model_rounds_from_messages(&[assistant, result], "turn-1", 1);
        let encoded = serde_json::to_value(&rounds[0]).unwrap();
        let restored: crate::service::session::ModelRoundData =
            serde_json::from_value(encoded).unwrap();
        let result = restored.tool_items[0].tool_result.as_ref().unwrap();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("[guidance] Inputs are equal"));
        assert_eq!(result.result["error_detail"]["code"], "edit_no_change");
    }

    #[tokio::test]
    async fn runtime_model_is_visible_to_turn_admission_config() {
        let dir = tempfile::tempdir().expect("temporary config directory");
        let config = ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                dir.path().join("runtime-turn-admission"),
            ))),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .expect("test ConfigService");
        config
            .install_runtime_ai_model(ServiceAIModelConfig {
                id: "sdk:openai:fixture".to_string(),
                name: "SDK fixture".to_string(),
                provider: "openai".to_string(),
                model_name: "fixture-model".to_string(),
                base_url: "http://127.0.0.1:43123/v1".to_string(),
                api_key: "fixture-secret".to_string(),
                enabled: true,
                ..ServiceAIModelConfig::default()
            })
            .await
            .unwrap();

        let ai_config = SessionManager::load_effective_ai_config_from_service(&config)
            .await
            .expect("turn admission should see the runtime model");
        assert_eq!(
            ai_config.resolve_model_reference("sdk:openai:fixture"),
            Some("sdk:openai:fixture".to_string())
        );
    }

    struct TestWorkspace {
        path: PathBuf,
        workspace_id: String,
    }

    impl TestWorkspace {
        /// Creates the directory and registers it as a local workspace record
        /// in the shared fixture catalog. Sessions only exist inside registered
        /// workspaces, so a path-only `SessionConfig` naming this directory
        /// resolves to that record exactly like a folder a host has opened.
        /// The path is canonical so IO projections written back from the
        /// record compare equal on hosts with symlinked temp roots.
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openbitfun-session-restore-test-{}",
                Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("test workspace should be created");
            let path = dunce::canonicalize(&path).expect("test workspace should canonicalize");
            let record =
                crate::service::workspace::legacy_compat::register_local_fixture_blocking(&path);
            Self {
                path,
                workspace_id: record.id,
            }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn workspace_id(&self) -> &str {
            &self.workspace_id
        }

        fn path_manager(&self) -> Arc<PathManager> {
            Arc::new(PathManager::with_user_root_for_tests(
                self.path.join("user-root"),
            ))
        }
    }

    #[test]
    fn invalidated_model_fallback_preserves_approved_external_generation_binding() {
        let invalidated = HashSet::from(["removed-model"]);

        assert!(should_apply_session_model_fallback(
            SessionModelBindingPolicy::Mutable,
            "removed-model",
            &invalidated,
        ));
        assert!(!should_apply_session_model_fallback(
            SessionModelBindingPolicy::ApprovedImmutable,
            "removed-model",
            &invalidated,
        ));
        assert!(!should_apply_session_model_fallback(
            SessionModelBindingPolicy::Mutable,
            "active-model",
            &invalidated,
        ));
    }

    #[test]
    fn idle_eviction_only_selects_expired_idle_sessions_that_can_be_restored() {
        let now = SystemTime::now();
        let expired_at = now - Duration::from_secs(120);
        let mut durable = Session::new(
            "Durable".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        durable.last_activity_at = expired_at;
        let mut transient = Session::new(
            "Connection scoped".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        transient.last_activity_at = expired_at;
        let mut processing = Session::new(
            "Processing".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        processing.last_activity_at = expired_at;
        processing.state = SessionState::Processing {
            current_turn_id: "active-turn".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        let durable_id = durable.session_id.clone();
        let transient_id = transient.session_id.clone();
        let processing_id = processing.session_id.clone();
        let sessions = DashMap::new();
        sessions.insert(durable_id.clone(), durable);
        sessions.insert(transient_id.clone(), transient);
        sessions.insert(processing_id.clone(), processing);
        let transient_session_ids = DashMap::new();
        transient_session_ids.insert(transient_id.clone(), ());

        let candidates = SessionManager::collect_expired_session_candidates(
            &sessions,
            &transient_session_ids,
            now,
            Duration::from_secs(60),
        );

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.session_id.as_str())
                .collect::<Vec<_>>(),
            [durable_id.as_str()]
        );
        assert!(sessions.contains_key(&transient_id));
        assert!(sessions.contains_key(&processing_id));

        assert!(SessionManager::collect_expired_session_candidates(
            &sessions,
            &transient_session_ids,
            now,
            Duration::MAX,
        )
        .is_empty());
    }

    #[test]
    fn idle_eviction_rechecks_state_before_removing_candidate() {
        let now = SystemTime::now();
        let expired_at = now - Duration::from_secs(120);
        let mut session = Session::new(
            "Becomes active".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        session.last_activity_at = expired_at;
        let session_id = session.session_id.clone();
        let sessions = DashMap::new();
        sessions.insert(session_id.clone(), session);
        let transient_session_ids = DashMap::new();
        let candidate = SessionManager::collect_expired_session_candidates(
            &sessions,
            &transient_session_ids,
            now,
            Duration::from_secs(60),
        )
        .into_iter()
        .next()
        .expect("expired Idle Session should be selected");

        sessions
            .get_mut(&session_id)
            .expect("selected Session")
            .state = SessionState::Processing {
            current_turn_id: "active-turn".to_string(),
            phase: ProcessingPhase::Thinking,
        };

        assert!(SessionManager::cleanup_snapshot_for_candidate(
            &sessions,
            &candidate,
            now,
            Duration::from_secs(60),
        )
        .is_none());
        assert!(sessions
            .remove_if(&session_id, |_, session| {
                SessionManager::cleanup_candidate_matches_session(
                    session,
                    &candidate,
                    now,
                    Duration::from_secs(60),
                )
            })
            .is_none());
        assert!(matches!(
            sessions
                .get(&session_id)
                .expect("active Session retained")
                .state,
            SessionState::Processing { .. }
        ));
    }

    #[test]
    fn persisted_round_preserves_deferred_wire_call_and_effective_identity() {
        let assistant = Message::assistant_with_tools(
            String::new(),
            vec![ToolCall {
                tool_id: "tool-1".to_string(),
                tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
                arguments: json!({
                    "tool_name": "WebFetch",
                    "args": { "url": "https://example.test" }
                }),
                raw_arguments: None,
                is_error: false,
                parse_error: None,
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            }],
        )
        .with_turn_id("turn-1".to_string())
        .with_round_id("round-1".to_string());
        let result = Message::tool_result(ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
            effective_tool_name: Some("WebFetch".to_string()),
            result: json!({ "content": "external content" }),
            result_for_assistant: Some("external content".to_string()),
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        })
        .with_turn_id("turn-1".to_string())
        .with_round_id("round-1".to_string());

        let persisted_messages: Vec<Message> = serde_json::from_value(
            serde_json::to_value(vec![assistant, result]).expect("serialize messages"),
        )
        .expect("deserialize messages");
        let provider_result: crate::util::types::Message = (&persisted_messages[1]).into();
        assert_eq!(
            provider_result.name.as_deref(),
            Some(openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME)
        );

        let rounds =
            SessionManager::build_model_rounds_from_messages(&persisted_messages, "turn-1", 1);

        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].tool_items.len(), 1);
        let tool = &rounds[0].tool_items[0];
        assert_eq!(
            tool.tool_name,
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME
        );
        assert_eq!(
            tool.tool_call.input,
            json!({
                "tool_name": "WebFetch",
                "args": { "url": "https://example.test" }
            })
        );
        let (effective_name, effective_input) =
            crate::service::session::effective_tool_identity(tool);
        assert_eq!(effective_name, "WebFetch");
        assert_eq!(effective_input, &json!({ "url": "https://example.test" }));
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn test_manager(persistence_manager: Arc<PersistenceManager>) -> SessionManager {
        SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence_manager,
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        )
    }

    #[tokio::test]
    async fn refreshed_turn_settlement_results_remain_bounded_and_clear_with_the_session() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let result = |status| AgentTurnSettlementResult {
            status,
            final_response: None,
            finish_reason: None,
        };

        manager.record_turn_settlement_result(
            "session-refresh",
            "turn-refresh",
            result(AgentTurnSettlementStatus::Cancelled),
        );
        for index in 0..1_023 {
            manager.record_turn_settlement_result(
                "other-session",
                &format!("turn-{index}"),
                result(AgentTurnSettlementStatus::Completed),
            );
        }
        manager.record_turn_settlement_result(
            "session-refresh",
            "turn-refresh",
            result(AgentTurnSettlementStatus::Completed),
        );
        manager.record_turn_settlement_result(
            "other-session",
            "turn-overflow",
            result(AgentTurnSettlementStatus::Completed),
        );

        assert_eq!(
            manager
                .turn_settlement_result("session-refresh", "turn-refresh")
                .map(|result| result.status),
            Some(AgentTurnSettlementStatus::Completed)
        );
        manager.clear_turn_settlement_results("session-refresh");
        assert!(manager
            .turn_settlement_result("session-refresh", "turn-refresh")
            .is_none());
    }

    #[tokio::test]
    async fn completion_replaces_a_projected_text_prefix_with_runtime_generation_content() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Completion merge".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish the response".to_string(),
                Some("turn-completion-prefix".to_string()),
                None,
                None,
            )
            .await
            .expect("turn should start");

        let projected_prefix = Message::assistant("Saved prefix: 1.".to_string())
            .with_turn_id(turn_id.clone())
            .with_round_id("round-final".to_string());
        let mut persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        persisted_turn.model_rounds =
            SessionManager::build_model_rounds_from_messages(&[projected_prefix], &turn_id, 1);
        persisted_turn.model_rounds[0].tool_items.push(
            serde_json::from_value(serde_json::json!({
                "id": "plan-display-test",
                "toolName": "CreatePlan",
                "toolCall": { "id": "", "input": {} },
                "toolResult": {
                    "result": { "plan_file_path": "/tmp/plan.md" },
                    "success": true
                },
                "startTime": 1,
                "status": "completed"
            }))
            .expect("derived plan display tool"),
        );
        persistence_manager
            .save_dialog_turn(workspace.path(), &persisted_turn)
            .await
            .expect("projected prefix should persist");

        let complete_response = "Saved prefix: 1. first item\n2. second item";
        manager
            .complete_dialog_turn(
                &session.session_id,
                &turn_id,
                complete_response.to_string(),
                &[Message::assistant(complete_response.to_string())
                    .with_turn_id(turn_id.clone())
                    .with_round_id("round-final".to_string())],
                TurnStats {
                    total_rounds: 1,
                    total_tools: 0,
                    total_tokens: 0,
                    duration_ms: 1,
                },
                Some("complete".to_string()),
                Some(true),
            )
            .await
            .expect("completion should persist");

        let completed = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(completed.status, TurnStatus::Completed);
        assert_eq!(completed.finish_reason.as_deref(), Some("complete"));
        assert_eq!(completed.has_final_response, Some(true));
        assert_eq!(completed.model_rounds.len(), 1);
        assert_eq!(completed.model_rounds[0].id, "round-final");
        assert_eq!(
            completed.model_rounds[0].text_items[0].content,
            complete_response,
        );
        assert_eq!(completed.model_rounds[0].tool_items.len(), 1);
        assert_eq!(
            completed.model_rounds[0].tool_items[0].id,
            "plan-display-test",
        );
    }

    async fn reopen_interrupted_turn_for_test(
        manager: &SessionManager,
        session_id: &str,
        turn_id: &str,
        expected_generation: u32,
    ) -> crate::util::errors::OpenBitFunResult<super::InterruptedTurnRecoveryPlan> {
        TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                ServiceAIConfig {
                    models: vec![configured_reasoning_model("model-original")],
                    ..Default::default()
                },
                manager.reopen_interrupted_dialog_turn(session_id, turn_id, expected_generation),
            )
            .await
    }

    fn interrupted_turn_test_model_fingerprint() -> String {
        service_model_runtime_binding_fingerprint(&configured_reasoning_model("model-original"))
    }

    fn interrupted_turn_test_reasoning_fingerprint(selected_preset: Option<&str>) -> String {
        let model = configured_reasoning_model("model-original");
        let projection = project_test_model_reasoning_catalog(&model, None);
        let preset = selected_preset
            .and_then(|preset_id| resolve_test_reasoning_preset(&projection, preset_id))
            .or_else(|| {
                selected_preset
                    .is_none()
                    .then(|| resolve_test_default_reasoning_preset(&projection))
                    .flatten()
            });
        test_reasoning_preset_runtime_fingerprint(preset)
    }

    fn interrupted_turn_test_auto_reasoning_fingerprint(default_preset: &str) -> String {
        let model = reasoning_model_with_default("model-original", default_preset);
        let projection = project_test_model_reasoning_catalog(&model, None);
        test_reasoning_preset_runtime_fingerprint(resolve_test_default_reasoning_preset(
            &projection,
        ))
    }

    fn test_manager_with_config(
        persistence_manager: Arc<PersistenceManager>,
        config: SessionManagerConfig,
    ) -> SessionManager {
        SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence_manager,
            config,
        )
    }

    fn test_path_manager() -> Arc<PathManager> {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-session-manager-test-{}",
            Uuid::new_v4()
        ));
        Arc::new(PathManager::with_user_root_for_tests(
            root.join("user-root"),
        ))
    }

    fn in_memory_test_manager() -> SessionManager {
        let persistence_manager =
            Arc::new(PersistenceManager::new(test_path_manager()).expect("persistence manager"));
        SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence_manager,
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        )
    }

    #[tokio::test]
    async fn current_context_usage_is_persisted_by_the_session_owner() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Usage persistence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let usage = SessionContextUsage {
            turn_id: "turn-1".to_string(),
            input_tokens: 42_000,
            output_tokens: Some(1_500),
            total_tokens: 43_500,
            timestamp: 123,
            source: SessionContextUsageSource::ModelRequest,
        };
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids
            .push(usage.turn_id.clone());

        manager
            .persist_current_context_usage(&session.session_id, usage.clone())
            .await
            .expect("usage should persist");

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.current_context_usage, Some(usage));
    }

    #[tokio::test]
    async fn interrupted_turn_reopens_same_turn_from_snapshot_with_generation_cas() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Recovery".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish the task".to_string(),
                Some("turn-1".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .add_message(
                &session.session_id,
                Message::assistant("safe completed fragment".to_string())
                    .with_turn_id(turn_id.clone())
                    .with_round_id("round-0".to_string()),
            )
            .await
            .expect("safe boundary should persist");

        let interrupted = manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        assert_eq!(interrupted.execution_generation, 0);
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        manager
            .update_session_permission_mode(&session.session_id, Some(PermissionMode::FullAccess))
            .await
            .expect("session permission should change after interruption");

        let plan = reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect("same generation should recover");

        assert_eq!(plan.turn_id, turn_id);
        assert_eq!(plan.turn_index, 0);
        assert_eq!(plan.execution_generation, 1);
        assert_eq!(plan.resume_count, 1);
        assert_eq!(plan.initial_round_index, 0);
        assert_eq!(plan.resolved_permission_mode, PermissionMode::Ask);
        assert_eq!(plan.resolved_model_id, "model-original");
        assert_eq!(
            plan.messages
                .iter()
                .filter(|message| {
                    message.metadata.semantic_kind == Some(MessageSemanticKind::ActualUserInput)
                })
                .count(),
            1,
            "recovery must not duplicate the original user message"
        );
        assert!(plan.messages.iter().any(|message| {
            message
                .content
                .to_string()
                .contains("previous work was interrupted")
        }));

        let duplicate =
            reopen_interrupted_turn_for_test(&manager, &session.session_id, &plan.turn_id, 0)
                .await
                .expect_err("stale generation must be rejected");
        assert!(duplicate.to_string().contains("generation"), "{duplicate}");

        manager
            .cancel_dialog_turn(&session.session_id, &plan.turn_id)
            .await
            .expect("ordinary cancellation should settle recovered work");
        let persisted = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert!(
            persisted.recovery.is_none(),
            "ordinary cancellation must remove the recoverable state"
        );
    }

    #[tokio::test]
    async fn interrupted_turn_recovery_does_not_narrow_its_frozen_permission_mode() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Recovery permission".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    permission_mode: Some(PermissionMode::FullAccess),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish with the original permission".to_string(),
                Some("turn-permission".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "full_access",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        manager
            .update_session_permission_mode(&session.session_id, Some(PermissionMode::Ask))
            .await
            .expect("session permission should change after interruption");

        let plan = reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect("turn should keep its original permission contract");
        assert_eq!(plan.resolved_permission_mode, PermissionMode::FullAccess);
    }

    #[tokio::test]
    async fn interrupted_turn_recovery_rejects_a_changed_reasoning_preset() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Recovery reasoning preset".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    reasoning_preset: Some("high".to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "continue with one reasoning contract".to_string(),
                Some("turn-reasoning".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": "high",
                    "runtime_reasoning_selection": "high",
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(Some("high"))
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should remain loaded")
            .config
            .reasoning_preset = Some("low".to_string());

        let error = reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect_err("same Turn must not silently change reasoning preset");

        assert!(error.to_string().contains("reasoning preset"), "{error}");
    }

    #[tokio::test]
    async fn interrupted_turn_recovery_rejects_a_changed_auto_reasoning_default() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Recovery auto reasoning".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    model_id: Some("model-original".to_string()),
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "continue with the original auto reasoning default".to_string(),
                Some("turn-auto-reasoning".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": service_model_runtime_binding_fingerprint(
                        &reasoning_model_with_default("model-original", "low")
                    ),
                    "runtime_reasoning_preset": "high",
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_auto_reasoning_fingerprint("high")
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");

        let error = TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                ServiceAIConfig {
                    models: vec![reasoning_model_with_default("model-original", "low")],
                    ..Default::default()
                },
                manager.reopen_interrupted_dialog_turn(&session.session_id, &turn_id, 0),
            )
            .await
            .expect_err("Auto must not resolve to a different preset for the same Turn");

        assert!(error.to_string().contains("reasoning contract"), "{error}");
    }

    #[tokio::test]
    async fn interrupted_turn_recovery_rejects_a_changed_model_binding() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Recovery model binding".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    model_id: Some("model-original".to_string()),
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "continue with the original model binding".to_string(),
                Some("turn-model-binding".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");

        let mut changed_model = configured_reasoning_model("model-original");
        changed_model.model_name = "provider-model-v2".to_string();
        let error = TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                ServiceAIConfig {
                    models: vec![changed_model],
                    ..Default::default()
                },
                manager.reopen_interrupted_dialog_turn(&session.session_id, &turn_id, 0),
            )
            .await
            .expect_err("same model ID must not silently change its runtime binding");

        assert!(error.to_string().contains("model binding"), "{error}");
    }

    #[tokio::test]
    async fn dialog_turn_admission_rejects_a_concurrent_session_model_change() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Turn admission CAS".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    model_id: Some("model-original".to_string()),
                    reasoning_preset: Some("high".to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let expected = TurnAdmissionSessionFacts::from_session(&session);
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should remain loaded")
            .config
            .model_id = Some("model-updated".to_string());

        let error = manager
            .start_dialog_turn_with_prepended_messages_if_session_matches(
                &session.session_id,
                "Standard".to_string(),
                "must retry admission".to_string(),
                Some("turn-admission-race".to_string()),
                None,
                Vec::new(),
                Some(serde_json::json!({"runtime_resolved_model_id": "model-original"})),
                &expected,
            )
            .await
            .expect_err("a concurrent settings update must invalidate admission");

        assert!(error.to_string().contains("changed during turn admission"));
        assert_eq!(manager.get_turn_count(&session.session_id), 0);
    }

    #[tokio::test]
    async fn dialog_turn_admission_rejects_a_concurrent_context_window_change() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Turn admission context window CAS".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    model_id: Some("model-original".to_string()),
                    max_context_tokens: 128_128,
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let expected = TurnAdmissionSessionFacts::from_session(&session);
        TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                ServiceAIConfig {
                    models: vec![test_model("model-original", 256_000)],
                    ..Default::default()
                },
                manager.update_session_model_selection(&session.session_id, "model-original", None),
            )
            .await
            .expect("same-model context window refresh should succeed");

        let error = manager
            .start_dialog_turn_with_prepended_messages_if_session_matches(
                &session.session_id,
                "Standard".to_string(),
                "must reject stale context window".to_string(),
                Some("turn-admission-context-window-race".to_string()),
                None,
                Vec::new(),
                None,
                &expected,
            )
            .await
            .expect_err("a concurrent context window update must invalidate admission");

        assert!(error.to_string().contains("changed during turn admission"));
        assert_eq!(manager.get_turn_count(&session.session_id), 0);
    }

    #[tokio::test]
    async fn dialog_turn_admission_rejects_a_concurrent_agent_route_owner_change() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Turn admission route CAS".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let expected = TurnAdmissionSessionFacts::from_session(&session);
        manager
            .update_session_agent_binding(
                &session.session_id,
                "Standard",
                SessionAgentRouteOwner::External,
                None,
            )
            .await
            .expect("same-name route owner update should succeed");

        let error = manager
            .start_dialog_turn_with_prepended_messages_if_session_matches(
                &session.session_id,
                "Standard".to_string(),
                "must reject stale route owner".to_string(),
                Some("turn-admission-route-race".to_string()),
                None,
                Vec::new(),
                None,
                &expected,
            )
            .await
            .expect_err("a concurrent route owner update must invalidate admission");

        assert!(error.to_string().contains("changed during turn admission"));
        assert_eq!(manager.get_turn_count(&session.session_id), 0);
    }

    #[tokio::test]
    async fn dialog_turn_admission_rejects_a_concurrent_agent_route_key_change() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Turn admission route key CAS".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    agent_route_key: Some("local:agentic:v1".to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let expected = TurnAdmissionSessionFacts::from_session(&session);
        manager
            .update_session_agent_binding(
                &session.session_id,
                "Standard",
                SessionAgentRouteOwner::Local,
                Some("local:agentic:v2".to_string()),
            )
            .await
            .expect("same-owner route key update should succeed");

        let error = manager
            .start_dialog_turn_with_prepended_messages_if_session_matches(
                &session.session_id,
                "Standard".to_string(),
                "must reject stale route key".to_string(),
                Some("turn-admission-route-key-race".to_string()),
                None,
                Vec::new(),
                None,
                &expected,
            )
            .await
            .expect_err("a concurrent route key update must invalidate admission");

        assert!(error.to_string().contains("changed during turn admission"));
        assert_eq!(manager.get_turn_count(&session.session_id), 0);
    }

    #[tokio::test]
    async fn dialog_turn_admission_rejects_a_concurrent_execution_binding_change() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let original_workspace = workspace.path().to_string_lossy().to_string();
        let session = manager
            .create_session(
                "Turn admission workspace CAS".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(original_workspace.clone()),
                    project_workspace_path: Some(original_workspace.clone()),
                    execution_target: Some(SessionExecutionTarget::local(
                        original_workspace.clone(),
                    )),
                    workspace_id: Some(workspace.workspace_id().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let expected = TurnAdmissionSessionFacts::from_session(&session);
        let rebound_workspace = workspace.path().join("managed-worktree");
        manager
            .update_session_execution_binding(
                &session.session_id,
                SessionExecutionBindingUpdate {
                    workspace_path: rebound_workspace.to_string_lossy().to_string(),
                    project_workspace_path: original_workspace,
                    workspace_id: Some("workspace-rebound".to_string()),
                    execution_target: SessionExecutionTarget::local(
                        rebound_workspace.to_string_lossy().to_string(),
                    ),
                },
            )
            .await
            .expect("execution binding update should succeed before the first turn");

        let error = manager
            .start_dialog_turn_with_prepended_messages_if_session_matches(
                &session.session_id,
                "Standard".to_string(),
                "must reject stale workspace binding".to_string(),
                Some("turn-admission-workspace-race".to_string()),
                None,
                Vec::new(),
                None,
                &expected,
            )
            .await
            .expect_err("a concurrent execution binding update must invalidate admission");

        assert!(error.to_string().contains("changed during turn admission"));
        assert_eq!(manager.get_turn_count(&session.session_id), 0);
    }

    #[tokio::test]
    async fn recovery_persistence_failure_keeps_memory_and_disk_interrupted() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Recovery rollback".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish the task".to_string(),
                Some("turn-rollback".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");

        persistence_manager.fail_next_session_state_write_for_test(&session.session_id);
        reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect_err("injected session write must reject recovery");

        let active = manager
            .get_session(&session.session_id)
            .expect("session should remain active");
        assert!(matches!(active.state, SessionState::Idle));
        let persisted_session = persistence_manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .expect("session should reload");
        assert!(matches!(persisted_session.state, SessionState::Idle));
        let persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(persisted_turn.status, TurnStatus::Cancelled);
        assert_eq!(
            persisted_turn
                .recovery
                .as_ref()
                .map(|recovery| recovery.status),
            Some(DialogTurnRecoveryStatus::Interrupted),
        );

        let plan = reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect("retry should reopen after rollback");
        persistence_manager.fail_next_dialog_turn_write_for_test(&session.session_id);
        manager
            .complete_recovered_dialog_turn(
                &session.session_id,
                &turn_id,
                plan.execution_generation,
                "completion that cannot persist".to_string(),
                &[],
                TurnStats {
                    total_rounds: 1,
                    total_tools: 0,
                    total_tokens: 0,
                    duration_ms: 1,
                },
                Some("complete".to_string()),
                Some(true),
            )
            .await
            .expect_err("injected recovered completion write must fail");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("failed recovered completion should return to interruption");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("fallback interruption should settle idle");
        let persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(persisted_turn.status, TurnStatus::Cancelled);
        assert_eq!(
            persisted_turn.recovery_epoch,
            Some(plan.execution_generation)
        );
        assert_eq!(
            persisted_turn
                .recovery
                .as_ref()
                .map(|recovery| (recovery.status, recovery.execution_generation)),
            Some((
                DialogTurnRecoveryStatus::Interrupted,
                plan.execution_generation
            )),
        );
    }

    #[tokio::test]
    async fn recovered_completion_appends_rounds_after_the_existing_history() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Recovery append".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish the task".to_string(),
                Some("turn-append".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        let mut persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        persisted_turn.model_rounds = SessionManager::build_model_rounds_from_messages(
            &[Message::assistant("before interruption".to_string())
                .with_turn_id(turn_id.clone())
                .with_round_id("round-before".to_string())],
            &turn_id,
            1,
        );
        persistence_manager
            .save_dialog_turn(workspace.path(), &persisted_turn)
            .await
            .expect("existing round should persist");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager.record_turn_settlement_result(
            &session.session_id,
            &turn_id,
            AgentTurnSettlementResult {
                status: AgentTurnSettlementStatus::Cancelled,
                final_response: None,
                finish_reason: Some("interrupted".to_string()),
            },
        );
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        let plan = reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
            .await
            .expect("turn should reopen");
        assert!(manager
            .turn_settlement_result(&session.session_id, &turn_id)
            .is_none());

        manager
            .complete_recovered_dialog_turn(
                &session.session_id,
                &turn_id,
                plan.execution_generation,
                "after recovery".to_string(),
                &[Message::assistant("after recovery".to_string())
                    .with_turn_id(turn_id.clone())
                    .with_round_id("round-after".to_string())],
                TurnStats {
                    total_rounds: 1,
                    total_tools: 0,
                    total_tokens: 0,
                    duration_ms: 1,
                },
                Some("complete".to_string()),
                Some(true),
            )
            .await
            .expect("recovered completion should persist");

        let completed = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(completed.model_rounds.len(), 2);
        assert_eq!(completed.model_rounds[0].round_index, 0);
        assert_eq!(completed.model_rounds[1].round_index, 1);
        assert_eq!(
            completed.model_rounds[1].text_items[0].content,
            "after recovery"
        );
        assert!(completed.recovery.is_none());
        assert_eq!(completed.recovery_epoch, Some(plan.execution_generation));
        assert_eq!(completed.finish_reason.as_deref(), Some("complete"));
        assert_eq!(completed.has_final_response, Some(true));
    }

    #[tokio::test]
    async fn repeated_interruption_persists_recovered_generation_rounds() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Repeated recovery".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "continue through two interruptions".to_string(),
                Some("turn-repeat-interruption".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("first generation should interrupt");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        let first_recovery =
            reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
                .await
                .expect("first recovery should reopen");

        let assistant = Message::assistant_with_tools(
            String::new(),
            vec![ToolCall {
                tool_id: "tool-recovered".to_string(),
                tool_name: "Read".to_string(),
                arguments: json!({"path": "README.md"}),
                raw_arguments: None,
                is_error: false,
                parse_error: None,
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            }],
        )
        .with_turn_id(turn_id.clone())
        .with_round_id("recovered-round".to_string());
        let tool_result = Message::tool_result(ToolResult {
            tool_id: "tool-recovered".to_string(),
            tool_name: "Read".to_string(),
            effective_tool_name: None,
            result: json!({"content": "safe boundary"}),
            result_for_assistant: Some("safe boundary".to_string()),
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        })
        .with_turn_id(turn_id.clone())
        .with_round_id("recovered-round".to_string());
        manager
            .mark_dialog_turn_interrupted_with_messages(
                &session.session_id,
                &turn_id,
                &[assistant, tool_result],
            )
            .await
            .expect("recovered generation should interrupt durably");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle again");

        let persisted = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(persisted.model_rounds.len(), 1);
        assert_eq!(persisted.model_rounds[0].round_index, 0);
        assert_eq!(
            persisted.model_rounds[0].tool_items[0]
                .tool_result
                .as_ref()
                .map(|result| result.success),
            Some(true),
        );
        let next_recovery = reopen_interrupted_turn_for_test(
            &manager,
            &session.session_id,
            &turn_id,
            first_recovery.execution_generation,
        )
        .await
        .expect("second recovery should reopen after appended history");
        assert_eq!(next_recovery.initial_round_index, 1);
    }

    #[tokio::test]
    async fn first_interruption_merges_a_partially_persisted_round_prefix() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Interrupted merge".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "merge frontend and runtime rounds".to_string(),
                Some("turn-prefix-merge".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        let persisted_prefix = Message::assistant("frontend prefix".to_string())
            .with_turn_id(turn_id.clone())
            .with_round_id("round-shared".to_string());
        let mut persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        persisted_turn.model_rounds =
            SessionManager::build_model_rounds_from_messages(&[persisted_prefix], &turn_id, 1);
        persistence_manager
            .save_dialog_turn(workspace.path(), &persisted_turn)
            .await
            .expect("frontend prefix should persist");

        let runtime_rounds = [
            Message::assistant("runtime authoritative prefix".to_string())
                .with_turn_id(turn_id.clone())
                .with_round_id("round-shared".to_string()),
            Message::assistant("runtime missing tail".to_string())
                .with_turn_id(turn_id.clone())
                .with_round_id("round-tail".to_string()),
        ];
        manager
            .mark_dialog_turn_interrupted_with_messages(
                &session.session_id,
                &turn_id,
                &runtime_rounds,
            )
            .await
            .expect("interruption should merge the runtime journal");

        let persisted = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn should load")
            .expect("turn should exist");
        assert_eq!(persisted.model_rounds.len(), 2);
        assert_eq!(persisted.model_rounds[0].id, "round-shared");
        assert_eq!(persisted.model_rounds[0].round_index, 0);
        assert_eq!(
            persisted.model_rounds[0].text_items[0].content,
            "runtime authoritative prefix"
        );
        assert_eq!(persisted.model_rounds[1].id, "round-tail");
        assert_eq!(persisted.model_rounds[1].round_index, 1);
    }

    #[tokio::test]
    async fn restore_reopens_a_recovering_turn_when_the_session_write_was_lost() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Recovery restart".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    model_id: Some("primary".to_string()),
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "finish after restart".to_string(),
                Some("turn-restart".to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": interrupted_turn_test_model_fingerprint(),
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": interrupted_turn_test_reasoning_fingerprint(None)
                })),
            )
            .await
            .expect("turn should start");
        manager
            .mark_dialog_turn_interrupted(&session.session_id, &turn_id)
            .await
            .expect("turn should become interrupted");
        manager
            .update_session_state_for_turn_if_processing(
                &session.session_id,
                &turn_id,
                SessionState::Idle,
            )
            .await
            .expect("session should settle idle");
        let first_recovery =
            reopen_interrupted_turn_for_test(&manager, &session.session_id, &turn_id, 0)
                .await
                .expect("turn should start recovering");
        assert_eq!(first_recovery.execution_generation, 1);

        // Simulate a crash after the recovering Turn rename but before the
        // Processing Session rename. The older Idle Session file must not hide
        // the abandoned execution generation forever.
        let mut stale_session = persistence_manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .expect("persisted session should load");
        stale_session.state = SessionState::Idle;
        persistence_manager
            .save_session(workspace.path(), &stale_session)
            .await
            .expect("stale idle session should persist");
        manager.evict_loaded_session_for_test(&session.session_id);
        drop(manager);

        let restored_manager = test_manager(persistence_manager.clone());
        let (restored_session, restored_turns) = restored_manager
            .restore_session_with_turns(workspace.path(), &session.session_id)
            .await
            .expect("restart should restore the session");

        assert!(matches!(restored_session.state, SessionState::Idle));
        let restored_turn = restored_turns.last().expect("latest turn should restore");
        assert_eq!(restored_turn.status, TurnStatus::Cancelled);
        assert_eq!(
            restored_turn
                .recovery
                .as_ref()
                .map(|recovery| (recovery.status, recovery.execution_generation)),
            Some((DialogTurnRecoveryStatus::Interrupted, 1)),
        );

        let second_recovery =
            reopen_interrupted_turn_for_test(&restored_manager, &session.session_id, &turn_id, 1)
                .await
                .expect("the interrupted generation should remain recoverable");
        assert_eq!(second_recovery.execution_generation, 2);
    }

    #[tokio::test]
    async fn acp_context_usage_is_not_persisted_as_native_prompt_usage() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "ACP usage".to_string(),
                "acp:codex".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .persist_current_context_usage(
                &session.session_id,
                SessionContextUsage {
                    turn_id: "turn-1".to_string(),
                    input_tokens: 42_000,
                    output_tokens: Some(1_500),
                    total_tokens: 43_500,
                    timestamp: 123,
                    source: SessionContextUsageSource::ModelRequest,
                },
            )
            .await
            .expect("ACP usage should be ignored");

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert!(metadata.current_context_usage.is_none());
    }

    #[tokio::test]
    async fn delayed_context_usage_does_not_restore_a_removed_turn() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager.clone()));
        let session = manager
            .create_session(
                "Delayed usage".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should create");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids
            .push("turn-1".to_string());

        let mutation_guard = manager
            .acquire_session_mutation(&session.session_id)
            .await
            .expect("mutation guard");
        let delayed_manager = manager.clone();
        let delayed_session_id = session.session_id.clone();
        let delayed_write = tokio::spawn(async move {
            delayed_manager
                .persist_current_context_usage(
                    &delayed_session_id,
                    SessionContextUsage {
                        turn_id: "turn-1".to_string(),
                        input_tokens: 42_000,
                        output_tokens: Some(1_500),
                        total_tokens: 43_500,
                        timestamp: 123,
                        source: SessionContextUsageSource::ModelRequest,
                    },
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(!delayed_write.is_finished());

        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should remain active")
            .dialog_turn_ids
            .clear();
        drop(mutation_guard);
        delayed_write
            .await
            .expect("delayed write should join")
            .expect("delayed write should be ignored");

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert!(metadata.current_context_usage.is_none());
    }

    #[tokio::test]
    async fn execution_binding_rejects_a_session_after_its_first_turn() {
        let manager = in_memory_test_manager();
        let workspace = TestWorkspace::new();
        let session = manager
            .create_session(
                "Binding race".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should be created");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should remain loaded")
            .dialog_turn_ids
            .push("turn-1".to_string());

        let error = manager
            .update_session_execution_binding(
                &session.session_id,
                SessionExecutionBindingUpdate {
                    workspace_path: "/tmp/worktree".to_string(),
                    project_workspace_path: workspace.path().to_string_lossy().to_string(),
                    workspace_id: None,
                    execution_target: SessionExecutionTarget::local("/tmp/worktree".to_string()),
                },
            )
            .await
            .expect_err("a non-empty session must not move");

        assert!(matches!(error, SessionExecutionBindingError::Busy(_)));
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .and_then(|session| session.config.workspace_path),
            Some(workspace.path().to_string_lossy().to_string())
        );
    }

    #[tokio::test]
    async fn execution_binding_restores_a_view_only_empty_session_from_its_project() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "View-only binding".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    project_workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should be created");
        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));
        manager
            .session_storage_path_index
            .remove(&session.session_id);

        let target_path = workspace.path().join("managed-worktree");
        manager
            .update_session_execution_binding(
                &session.session_id,
                SessionExecutionBindingUpdate {
                    workspace_path: target_path.to_string_lossy().to_string(),
                    project_workspace_path: workspace.path().to_string_lossy().to_string(),
                    workspace_id: Some("workspace-2".to_string()),
                    execution_target: SessionExecutionTarget::local(
                        target_path.to_string_lossy().to_string(),
                    ),
                },
            )
            .await
            .expect("view-only session should restore and rebind");

        let restored = manager
            .get_session(&session.session_id)
            .expect("session should be loaded after rebinding");
        assert_eq!(
            restored.config.workspace_path.as_deref(),
            Some(target_path.to_string_lossy().as_ref())
        );
        assert_eq!(restored.config.workspace_id.as_deref(), Some("workspace-2"));
    }

    #[tokio::test]
    async fn execution_binding_rejects_a_boundary_zero_revert_after_explicit_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Boundary zero binding".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    project_workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..SessionConfig::default()
                },
            )
            .await
            .expect("session should be created");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        persistence_manager
            .save_dialog_turn(
                &storage_path,
                &DialogTurnData::new(
                    "turn-0".to_string(),
                    0,
                    session.session_id.clone(),
                    UserMessageData {
                        id: "user-0".to_string(),
                        content: "first prompt".to_string(),
                        timestamp: 1,
                        metadata: None,
                    },
                ),
            )
            .await
            .expect("persist first turn");
        persistence_manager
            .save_session_revert_state(
                &storage_path,
                &session.session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 0,
                    original_turn_end: 1,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("persist boundary zero marker");
        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("unload session"));
        let restored = manager
            .restore_session_from_storage_path(&storage_path, &session.session_id)
            .await
            .expect("restore from the known Session storage path");
        assert!(
            restored.dialog_turn_ids.is_empty(),
            "boundary-zero restore must project an empty visible history"
        );

        let target_path = workspace.path().join("managed-worktree");
        let error = manager
            .update_session_execution_binding(
                &session.session_id,
                SessionExecutionBindingUpdate {
                    workspace_path: target_path.to_string_lossy().to_string(),
                    project_workspace_path: workspace.path().to_string_lossy().to_string(),
                    workspace_id: Some("workspace-2".to_string()),
                    execution_target: SessionExecutionTarget::local(
                        target_path.to_string_lossy().to_string(),
                    ),
                },
            )
            .await
            .expect_err("a staged revert must pin its snapshot workspace");

        assert!(
            matches!(error, SessionExecutionBindingError::Busy(_)),
            "expected staged revert to reject rebinding as busy, got {error:?}"
        );
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session remains restored after rejection")
                .config
                .workspace_path
                .as_deref(),
            Some(workspace.path().to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn unloading_a_session_releases_capacity_without_deleting_persistence() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager_with_config(
            persistence_manager.clone(),
            SessionManagerConfig {
                max_active_sessions: 1,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        );
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };
        let first = manager
            .create_session(
                "First loaded session".to_string(),
                "Standard".to_string(),
                config.clone(),
            )
            .await
            .expect("first session should be created");

        assert!(manager
            .unload_session_from_memory(&first.session_id)
            .await
            .expect("session should unload"));
        assert!(manager.get_session(&first.session_id).is_none());
        assert!(
            persistence_manager
                .load_session_metadata(workspace.path(), &first.session_id)
                .await
                .expect("metadata should load")
                .is_some(),
            "unload must preserve persisted history"
        );

        let second = manager
            .create_session(
                "Second loaded session".to_string(),
                "Standard".to_string(),
                config,
            )
            .await
            .expect("unload should release the active-session slot");
        assert_ne!(first.session_id, second.session_id);
    }

    #[tokio::test]
    async fn a_persisted_session_has_one_writer_across_managers() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first = test_manager(Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        ));
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        let session = first
            .create_session(
                "Single writer".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("first writer should create the session");

        let duplicate = first
            .create_session_with_id(
                Some(session.session_id.clone()),
                "Duplicate".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("the current manager must reject an already-loaded Session ID");
        assert!(matches!(
            duplicate,
            crate::util::errors::OpenBitFunError::Validation(ref message)
                if message.contains("already exists")
        ));

        let error = second
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect_err("second writer must fail immediately");
        assert!(matches!(
            error,
            crate::util::errors::OpenBitFunError::SessionInUse { ref session_id }
                if session_id == &session.session_id
        ));

        let (view, _) = second
            .restore_session_view(workspace.path(), &session.session_id)
            .await
            .expect("read-only view must remain available");
        assert_eq!(view.session_id, session.session_id);

        assert!(first
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("first writer should unload"));
        second
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("writer should transfer after successful unload");
    }

    #[tokio::test]
    async fn different_sessions_in_the_same_workspace_can_have_different_writers() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence = Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("fixture persistence manager"),
        );
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };
        let first_session = Session::new_with_id(
            "first-workspace-session".to_string(),
            "First".to_string(),
            "Standard".to_string(),
            config.clone(),
        );
        let second_session = Session::new_with_id(
            "second-workspace-session".to_string(),
            "Second".to_string(),
            "Standard".to_string(),
            config,
        );
        persistence
            .save_session(workspace.path(), &first_session)
            .await
            .expect("first fixture");
        persistence
            .save_session(workspace.path(), &second_session)
            .await
            .expect("second fixture");
        let first = test_manager(Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        ));
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));

        first
            .restore_session(workspace.path(), &first_session.session_id)
            .await
            .expect("first Session writer");
        second
            .restore_session(workspace.path(), &second_session.session_id)
            .await
            .expect("second Session writer in the same workspace");
    }

    #[tokio::test]
    async fn workspace_path_aliases_cannot_bypass_session_single_writer() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first = test_manager(Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        ));
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        let session = first
            .create_session(
                "Aliased workspace".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("first writer");

        let error = second
            .restore_session(&workspace.path().join("."), &session.session_id)
            .await
            .expect_err("workspace alias must identify the same Session");
        assert!(matches!(
            error,
            crate::util::errors::OpenBitFunError::SessionInUse { .. }
        ));
    }

    #[tokio::test]
    async fn a_failed_restore_does_not_keep_the_session_write_lock() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first_persistence = Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        );
        let first = test_manager(first_persistence.clone());
        let session_id = "restore-after-failure";

        first
            .restore_session(workspace.path(), session_id)
            .await
            .expect_err("missing Session restore should fail");

        let fixture = Session::new_with_id(
            session_id.to_string(),
            "Recovered fixture".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        first_persistence
            .save_session(workspace.path(), &fixture)
            .await
            .expect("persist recovered fixture");
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        second
            .restore_session(workspace.path(), session_id)
            .await
            .expect("failed restore must release the temporary writer lock");
    }

    #[tokio::test]
    async fn a_failed_create_does_not_keep_the_session_write_lock() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first_persistence = Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        );
        let first = test_manager(first_persistence.clone());
        let session_id = "create-after-failure";
        first_persistence.fail_next_session_state_write_for_test(session_id);

        first
            .create_session_with_id(
                Some(session_id.to_string()),
                "Failed fixture".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("injected persistence failure");

        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        second
            .create_session_with_id(
                Some(session_id.to_string()),
                "Recovered fixture".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("failed create must release the temporary writer lock");
    }

    #[tokio::test]
    async fn failed_unload_save_keeps_the_session_write_lock() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first_persistence = Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        );
        let first = test_manager(first_persistence.clone());
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        let session = first
            .create_session(
                "Unload failure".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("first writer");
        first_persistence.fail_next_session_state_write_for_test(&session.session_id);

        first
            .unload_session_from_memory(&session.session_id)
            .await
            .expect_err("injected unload save failure");
        let error = second
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect_err("failed unload save must retain writer ownership");
        assert!(matches!(
            error,
            crate::util::errors::OpenBitFunError::SessionInUse { .. }
        ));
    }

    #[tokio::test]
    async fn rejected_unload_keeps_the_session_write_lock() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let first = test_manager(Arc::new(
            PersistenceManager::new(path_manager.clone()).expect("first persistence manager"),
        ));
        let second = test_manager(Arc::new(
            PersistenceManager::new(path_manager).expect("second persistence manager"),
        ));
        let session = first
            .create_session(
                "Processing".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("first writer");
        first
            .sessions
            .get_mut(&session.session_id)
            .expect("loaded Session")
            .state = SessionState::Processing {
            current_turn_id: "active-turn".to_string(),
            phase: ProcessingPhase::Thinking,
        };

        first
            .unload_session_from_memory(&session.session_id)
            .await
            .expect_err("processing Session must not unload");
        let error = second
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect_err("failed unload must retain writer ownership");
        assert!(matches!(
            error,
            crate::util::errors::OpenBitFunError::SessionInUse { .. }
        ));
    }

    #[tokio::test]
    async fn session_permission_mode_is_per_session_and_clearable() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };
        let first = manager
            .create_session_with_id_and_details(
                None,
                "First".to_string(),
                "Standard".to_string(),
                config.clone(),
                None,
                SessionKind::Standard,
            )
            .await
            .expect("create first session");
        let second = manager
            .create_session_with_id_and_details(
                None,
                "Second".to_string(),
                "Standard".to_string(),
                config,
                None,
                SessionKind::Standard,
            )
            .await
            .expect("create second session");

        // A new session starts without an override and follows the default.
        assert_eq!(manager.session_permission_mode(&first.session_id), None);

        manager
            .update_session_permission_mode(&first.session_id, Some(PermissionMode::FullAccess))
            .await
            .expect("set first session mode");

        // The selection stays inside the session it was made in.
        assert_eq!(
            manager.session_permission_mode(&first.session_id),
            Some(PermissionMode::FullAccess)
        );
        assert_eq!(manager.session_permission_mode(&second.session_id), None);

        // Clearing returns the session to the user-level default.
        manager
            .update_session_permission_mode(&first.session_id, None)
            .await
            .expect("clear first session mode");
        assert_eq!(manager.session_permission_mode(&first.session_id), None);
    }

    #[tokio::test]
    async fn session_permission_mode_update_rejects_a_missing_session() {
        let manager = in_memory_test_manager();

        let error = manager
            .update_session_permission_mode("missing-session", Some(PermissionMode::AutoApprove))
            .await
            .expect_err("unknown session must not silently succeed");
        assert!(matches!(
            error,
            crate::util::errors::OpenBitFunError::NotFound(_)
        ));
    }

    #[tokio::test]
    async fn active_turn_permission_mode_is_exact_mutable_and_stale_safe() {
        let manager = in_memory_test_manager();
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Active permission session".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        manager.sessions.insert(session_id.clone(), session);

        assert!(manager.set_active_turn_permission_mode(
            &session_id,
            "turn-1",
            PermissionMode::Ask,
        ));
        assert!(manager.set_active_turn_permission_mode(
            &session_id,
            "turn-1",
            PermissionMode::FullAccess,
        ));
        assert_eq!(
            manager.active_turn_permission_mode(&session_id, "turn-1"),
            Some(PermissionMode::FullAccess),
        );
        assert!(!manager.set_active_turn_permission_mode(
            &session_id,
            "stale-turn",
            PermissionMode::AutoApprove,
        ));

        manager
            .sessions
            .get_mut(&session_id)
            .expect("active session")
            .state = SessionState::Processing {
            current_turn_id: "turn-2".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        assert_eq!(
            manager.active_turn_permission_mode(&session_id, "turn-1"),
            None,
        );
        assert!(manager.set_active_turn_permission_mode(
            &session_id,
            "turn-2",
            PermissionMode::AutoApprove,
        ));
        assert!(!manager.clear_active_turn_permission_mode(&session_id, "turn-1"));
        assert_eq!(
            manager.active_turn_permission_mode(&session_id, "turn-2"),
            Some(PermissionMode::AutoApprove),
        );
        assert!(manager.clear_active_turn_permission_mode(&session_id, "turn-2"));
        assert_eq!(
            manager.active_turn_permission_mode(&session_id, "turn-2"),
            None,
        );
    }

    #[tokio::test]
    async fn transient_session_cannot_bypass_owned_discard_through_unload() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let session = manager
            .create_transient_session_with_id_and_details(
                None,
                "Connection Session".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
                None,
                SessionKind::Standard,
            )
            .await
            .expect("transient session should create");

        let error = manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect_err("transient session must use owned discard");
        assert!(error.to_string().contains("transient session"));
        assert!(manager.get_session(&session.session_id).is_some());
        assert!(manager.is_transient_session(&session.session_id));
    }

    #[tokio::test]
    async fn internal_delete_compensation_clears_transient_identity() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let session = manager
            .create_transient_session_with_id_and_details(
                None,
                "Prepared Subagent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
                None,
                SessionKind::Subagent,
            )
            .await
            .expect("transient subagent should create");

        manager
            .delete_session_by_id(&session.session_id)
            .await
            .expect("internal compensation should delete prepared subagent");

        assert!(manager.get_session(&session.session_id).is_none());
        assert!(!manager.is_transient_session(&session.session_id));
    }

    #[tokio::test]
    async fn restores_share_the_same_exact_active_session_capacity_as_creates() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };
        let first = Session::new(
            "First persisted".to_string(),
            "Standard".to_string(),
            config.clone(),
        );
        let second = Session::new(
            "Second persisted".to_string(),
            "Standard".to_string(),
            config,
        );
        persistence_manager
            .save_session(workspace.path(), &first)
            .await
            .expect("first fixture should persist");
        persistence_manager
            .save_session(workspace.path(), &second)
            .await
            .expect("second fixture should persist");
        let manager = test_manager_with_config(
            persistence_manager,
            SessionManagerConfig {
                max_active_sessions: 1,
                enable_persistence: true,
                ..Default::default()
            },
        );

        manager
            .restore_session(workspace.path(), &first.session_id)
            .await
            .expect("first restore should reserve the only slot");
        let error = manager
            .restore_session(workspace.path(), &second.session_id)
            .await
            .expect_err("second restore must respect active-session capacity");
        assert!(error.to_string().contains("maximum session limit"));

        manager
            .unload_session_from_memory(&first.session_id)
            .await
            .expect("first session should unload");
        manager
            .restore_session(workspace.path(), &second.session_id)
            .await
            .expect("unload should release capacity for a later restore");
    }

    #[tokio::test]
    async fn concurrent_creates_cannot_overbook_active_session_capacity() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager_with_config(
            persistence_manager,
            SessionManagerConfig {
                max_active_sessions: 1,
                enable_persistence: true,
                ..Default::default()
            },
        ));
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };

        let first = {
            let manager = manager.clone();
            let config = config.clone();
            tokio::spawn(async move {
                manager
                    .create_session_with_id(
                        Some("capacity-first".to_string()),
                        "First".to_string(),
                        "Standard".to_string(),
                        config,
                    )
                    .await
            })
        };
        let second = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .create_session_with_id(
                        Some("capacity-second".to_string()),
                        "Second".to_string(),
                        "Standard".to_string(),
                        config,
                    )
                    .await
            })
        };
        let first = first.await.expect("first create task should join");
        let second = second.await.expect("second create task should join");

        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(manager.sessions.len(), 1);
        assert_eq!(manager.active_session_permits.len(), 1);
    }

    #[tokio::test]
    async fn failed_unavailable_mode_migration_does_not_publish_the_restored_session() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Unavailable mode".to_string(),
            "removed-mode-that-cannot-exist".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("invalid historical mode fixture should persist");
        persistence_manager.fail_next_session_metadata_write_for_test(&session_id);
        let manager = test_manager_with_config(
            persistence_manager,
            SessionManagerConfig {
                enable_persistence: true,
                ..Default::default()
            },
        );

        let error = manager
            .restore_session(workspace.path(), &session_id)
            .await
            .expect_err("mode migration write failure must fail restore");

        assert!(error.to_string().contains("Injected session metadata"));
        assert!(
            manager.get_session(&session_id).is_none(),
            "failed migration must not consume active-session capacity"
        );
        assert!(manager.active_session_permits.is_empty());
        assert!(manager
            .session_storage_path_index
            .get(&session_id)
            .is_none());
    }

    #[tokio::test]
    async fn failed_restore_state_write_does_not_publish_context_or_capacity() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Unavailable mode".to_string(),
            "removed-mode-that-cannot-exist".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("historical session fixture should persist");
        persistence_manager.fail_next_session_state_write_for_test(&session_id);
        let manager = test_manager(persistence_manager);

        let error = manager
            .restore_session(workspace.path(), &session_id)
            .await
            .expect_err("state migration write failure must fail restore");

        assert!(error.to_string().contains("Injected session state"));
        assert!(manager.get_session(&session_id).is_none());
        assert!(manager.active_session_permits.is_empty());
        assert!(manager
            .session_storage_path_index
            .get(&session_id)
            .is_none());
        assert!(!manager.context_store.has_session(&session_id));
    }

    #[tokio::test]
    async fn session_model_update_is_restored_from_persistence() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Persisted model update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    model_id: Some("primary".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .update_session_model_id(&session.session_id, "fast")
            .await
            .expect("model update should persist");
        manager.evict_loaded_session_for_test(&session.session_id);

        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore from persistence");
        assert_eq!(restored.config.model_id.as_deref(), Some("fast"));
    }

    #[tokio::test]
    async fn restore_rewrites_retired_auto_model_selector_to_primary() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Legacy model selector".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                model_id: Some("auto".to_string()),
                ..Default::default()
            },
        );
        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("legacy session fixture should persist");
        let manager = test_manager(persistence_manager.clone());
        let mut ai_config = ServiceAIConfig {
            models: vec![test_model("primary-model", 512_000)],
            ..Default::default()
        };
        ai_config.default_models.primary = Some("primary-model".to_string());

        let restored = TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                ai_config,
                manager.restore_session(workspace.path(), &session_id),
            )
            .await
            .expect("legacy session should restore");

        assert_eq!(restored.config.model_id.as_deref(), Some("primary"));
        assert_eq!(
            persistence_manager
                .load_session(workspace.path(), &session_id)
                .await
                .expect("rewritten session should persist")
                .config
                .model_id
                .as_deref(),
            Some("primary")
        );
    }

    #[tokio::test]
    async fn failed_session_model_update_preserves_runtime_and_persisted_selector() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Failed model update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    model_id: Some("primary".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        persistence_manager.fail_next_session_state_write_for_test(&session.session_id);

        manager
            .update_session_model_id(&session.session_id, "fast")
            .await
            .expect_err("failed persistence must reject the model update");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session remains loaded")
                .config
                .model_id
                .as_deref(),
            Some("primary")
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("failed update should restore the previous model");
        assert_eq!(restored.config.model_id.as_deref(), Some("primary"));
    }

    #[tokio::test]
    async fn session_storage_identity_rejects_same_id_in_another_workspace() {
        let workspace = TestWorkspace::new();
        let other_workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session_id = "shared-session-id";

        assert!(manager
            .claim_session_storage_path(session_id, workspace.path(), true)
            .expect("first workspace claim"));
        let error = manager
            .claim_session_storage_path(session_id, other_workspace.path(), true)
            .expect_err("a second workspace must not reuse an active session id");

        let message = error.to_string();
        assert!(message.contains(session_id));
        assert!(message.contains("another workspace"));
    }

    #[tokio::test]
    async fn failed_claim_does_not_release_a_concurrent_same_workspace_claim() {
        let workspace = TestWorkspace::new();
        let other_workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session_id = "concurrent-restore-session";

        let first_claim = manager
            .claim_session_storage_path(session_id, workspace.path(), true)
            .expect("first restore claim");
        manager
            .claim_session_storage_path(session_id, workspace.path(), true)
            .expect("concurrent restore in the same workspace");

        manager.release_failed_session_storage_path_claim(
            session_id,
            workspace.path(),
            first_claim,
        );

        let error = manager
            .claim_session_storage_path(session_id, other_workspace.path(), true)
            .expect_err("a concurrent same-workspace restore must retain the binding");
        assert!(error.to_string().contains("another workspace"));
    }

    #[tokio::test]
    async fn ephemeral_session_creation_rejects_active_duplicate_but_allows_evicted_id_reuse() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let session_id = "reusable-session-id";
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };

        manager
            .create_session_with_id_and_details(
                Some(session_id.to_string()),
                "Original".to_string(),
                "Standard".to_string(),
                config.clone(),
                None,
                SessionKind::EphemeralChild,
            )
            .await
            .expect("first session should create");
        let duplicate = manager
            .create_session_with_id_and_details(
                Some(session_id.to_string()),
                "Duplicate".to_string(),
                "Standard".to_string(),
                config.clone(),
                None,
                SessionKind::EphemeralChild,
            )
            .await
            .expect_err("an active duplicate must fail");
        assert!(duplicate.to_string().contains("already exists"));

        manager.evict_loaded_session_for_test(session_id);
        manager
            .create_session_with_id_and_details(
                Some(session_id.to_string()),
                "Recreated".to_string(),
                "Standard".to_string(),
                config,
                None,
                SessionKind::EphemeralChild,
            )
            .await
            .expect("an evicted same-workspace session id should be reusable");
    }

    #[tokio::test]
    async fn persistent_session_creation_rejects_an_evicted_on_disk_id_without_overwriting_turns() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let manager = test_manager(persistence_manager);
        let session_id = "persisted-session-id";
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };

        manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Original".to_string(),
                "Standard".to_string(),
                config.clone(),
            )
            .await
            .expect("first persistent session should create");
        let turns_dir = sessions_dir.join(session_id).join("turns");
        std::fs::create_dir_all(&turns_dir).expect("turns directory");
        let sentinel = turns_dir.join("existing-turn.json");
        std::fs::write(&sentinel, b"existing history").expect("persisted turn sentinel");
        manager.evict_loaded_session_for_test(session_id);

        let error = manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Replacement".to_string(),
                "Standard".to_string(),
                config,
            )
            .await
            .expect_err("an evicted persistent session id must not be reused");

        assert!(error.to_string().contains("already exists"));
        assert_eq!(
            std::fs::read(&sentinel).expect("existing turns must remain untouched"),
            b"existing history"
        );
        assert!(manager.get_session(session_id).is_none());
    }

    #[tokio::test]
    async fn invalid_fixed_session_id_does_not_claim_or_insert_runtime_state() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let invalid_id = "../other-session";

        let error = manager
            .create_session_with_id(
                Some(invalid_id.to_string()),
                "Invalid".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("path-like session ids must be rejected");

        assert!(error.to_string().contains("session_id"));
        assert!(manager.get_session(invalid_id).is_none());
        assert!(manager.session_storage_path_index.get(invalid_id).is_none());
    }

    #[tokio::test]
    async fn persistent_session_creation_failure_does_not_publish_runtime_state() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = "failed-persistent-session";
        persistence_manager.fail_next_session_state_write_for_test(session_id);
        let manager = test_manager(persistence_manager.clone());
        let config = SessionConfig {
            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        };

        manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Must not become visible".to_string(),
                "Standard".to_string(),
                config.clone(),
            )
            .await
            .expect_err("state persistence failure must fail session creation");

        assert!(manager.get_session(session_id).is_none());
        assert!(manager.session_storage_path_index.get(session_id).is_none());
        assert!(!persistence_manager
            .session_storage_exists(workspace.path(), session_id)
            .expect("session storage existence"));
        assert!(persistence_manager
            .load_session_metadata(workspace.path(), session_id)
            .await
            .expect("load session metadata")
            .is_none());

        manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Retry succeeds".to_string(),
                "Standard".to_string(),
                config,
            )
            .await
            .expect("retry should not be blocked by partial persistence");
    }

    #[tokio::test]
    async fn background_title_update_cannot_recreate_storage_during_deletion() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let manager = Arc::new(test_manager(persistence_manager.clone()));
        let session = manager
            .create_session(
                "Original".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let session_id = session.session_id.clone();
        let deletion_guard = manager
            .acquire_session_mutation(&session_id)
            .await
            .expect("deletion mutation guard");

        let title_manager = manager.clone();
        let title_session_id = session_id.clone();
        let title_update = tokio::spawn(async move {
            title_manager
                .update_session_title_if_current(&title_session_id, "Original", "Generated title")
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !title_update.is_finished(),
            "title persistence must wait for the deletion mutation boundary"
        );

        persistence_manager
            .delete_session(&sessions_dir, &session_id)
            .await
            .expect("persistence deletion");
        manager.evict_loaded_session_for_test(&session_id);
        manager.session_storage_path_index.remove(&session_id);
        drop(deletion_guard);

        let error = title_update
            .await
            .expect("title task should not panic")
            .expect_err("deleted session title update must fail");
        assert!(error.to_string().contains("not found"));
        assert!(!sessions_dir.join(&session_id).exists());
    }

    #[tokio::test]
    async fn failed_title_persistence_does_not_publish_the_new_name_in_memory() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Original".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        {
            // Simulate a session whose persistence location can no longer be
            // resolved: neither its workspace record nor an IO projection.
            let mut loaded = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("loaded session");
            loaded.config.workspace_id = None;
            loaded.config.project_workspace_id = None;
            loaded.config.workspace_path = None;
            loaded.config.project_workspace_path = None;
        }

        manager
            .update_session_title(&session.session_id, "Not persisted")
            .await
            .expect_err("missing persistence path must reject the title update");

        let loaded = manager
            .get_session(&session.session_id)
            .expect("session must remain loaded");
        assert_eq!(loaded.session_name, "Original");
    }

    #[tokio::test]
    async fn session_title_update_does_not_rewrite_the_runtime_state_file() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Original".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        persistence_manager.fail_next_session_state_write_for_test(&session.session_id);

        manager
            .update_session_title(&session.session_id, "Renamed")
            .await
            .expect("title update must not rewrite runtime state");
        manager.evict_loaded_session_for_test(&session.session_id);

        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("metadata-only title update should remain restorable");
        assert_eq!(restored.session_name, "Renamed");
    }

    #[tokio::test]
    async fn failed_title_index_update_rolls_back_persisted_metadata() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Original".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let index_path = sessions_dir.join("index.json");
        std::fs::remove_file(&index_path).expect("replace index file");
        std::fs::create_dir(&index_path).expect("create invalid index directory");

        manager
            .update_session_title(&session.session_id, "Renamed")
            .await
            .expect_err("index failure must reject the title update");

        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session remains loaded")
                .session_name,
            "Original"
        );
        let metadata = persistence_manager
            .load_session_metadata(&sessions_dir, &session.session_id)
            .await
            .expect("metadata should remain readable")
            .expect("metadata should exist");
        assert_eq!(metadata.session_name, "Original");
    }

    #[tokio::test]
    async fn failed_title_rollback_reports_an_unknown_outcome() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Original".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let index_path = sessions_dir.join("index.json");
        std::fs::remove_file(&index_path).expect("replace index file");
        std::fs::create_dir(&index_path).expect("create invalid index directory");
        persistence_manager.fail_next_session_metadata_rollback_for_test(&session.session_id);

        let error = manager
            .update_session_title(&session.session_id, "Renamed")
            .await
            .expect_err("failed rollback must not report a definite failure");

        assert!(matches!(error, OpenBitFunError::OutcomeUnknown(_)));
        let metadata = persistence_manager
            .load_session_metadata(&sessions_dir, &session.session_id)
            .await
            .expect("metadata should remain readable")
            .expect("metadata should exist");
        assert_eq!(metadata.session_name, "Renamed");
    }

    #[tokio::test]
    async fn loaded_session_identity_check_preserves_processing_state() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let session = manager
            .create_session(
                "Active".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .session_storage_path_index
            .get(&session.session_id)
            .expect("storage binding")
            .path
            .clone();
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("active session")
            .state = SessionState::Processing {
            current_turn_id: "turn-active".to_string(),
            phase: ProcessingPhase::Thinking,
        };

        assert!(manager
            .is_session_loaded_from_storage_path(&storage_path, &session.session_id)
            .expect("identity check"));
        assert!(matches!(
            manager.get_session(&session.session_id).expect("session").state,
            SessionState::Processing { ref current_turn_id, .. }
                if current_turn_id == "turn-active"
        ));
    }

    #[tokio::test]
    async fn restoring_an_already_loaded_session_preserves_processing_state() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Active".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("active session")
            .state = SessionState::Processing {
            current_turn_id: "turn-active".to_string(),
            phase: ProcessingPhase::Thinking,
        };

        manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("idempotent restore");

        assert!(matches!(
            manager.get_session(&session.session_id).expect("session").state,
            SessionState::Processing { ref current_turn_id, .. }
                if current_turn_id == "turn-active"
        ));
    }

    #[tokio::test]
    async fn session_creation_waits_for_the_same_session_mutation_permit() {
        let workspace = TestWorkspace::new();
        let manager = Arc::new(in_memory_test_manager());
        let session_id = "serialized-create-session";
        let guard = manager.lock_session_mutation(session_id).await;
        let manager_for_create = manager.clone();
        let workspace_path = workspace.path().to_string_lossy().to_string();

        let create_task = tokio::spawn(async move {
            manager_for_create
                .create_session_with_id(
                    Some(session_id.to_string()),
                    "Serialized".to_string(),
                    "Standard".to_string(),
                    SessionConfig {
                        workspace_path: Some(workspace_path),
                        ..Default::default()
                    },
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(!create_task.is_finished());

        drop(guard);
        create_task
            .await
            .expect("create task should join")
            .expect("create should continue after the permit is released");
    }

    #[tokio::test]
    async fn session_restore_waits_for_the_same_session_mutation_permit() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Persisted".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        manager.evict_loaded_session_for_test(&session.session_id);

        let guard = manager.lock_session_mutation(&session.session_id).await;
        let manager_for_restore = manager.clone();
        let session_id = session.session_id.clone();
        let workspace_path = workspace.path().to_path_buf();
        let restore_task = tokio::spawn(async move {
            manager_for_restore
                .restore_session(&workspace_path, &session_id)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!restore_task.is_finished());

        drop(guard);
        restore_task
            .await
            .expect("restore task should join")
            .expect("restore should continue after the permit is released");
    }

    #[tokio::test]
    async fn session_mode_update_waits_for_the_same_session_mutation_permit() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Serialized mode update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let guard = manager.lock_session_mutation(&session.session_id).await;
        let manager_for_update = manager.clone();
        let session_id = session.session_id.clone();
        let update_task = tokio::spawn(async move {
            manager_for_update
                .update_session_agent_type(&session_id, "Cowork")
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!update_task.is_finished());

        drop(guard);
        update_task
            .await
            .expect("update task should join")
            .expect("mode update should continue after the permit is released");
    }

    #[tokio::test]
    async fn compression_update_waits_for_the_same_session_mutation_permit() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Serialized compression update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let guard = manager.lock_session_mutation(&session.session_id).await;
        let manager_for_update = manager.clone();
        let session_id = session.session_id.clone();
        let update_task = tokio::spawn(async move {
            manager_for_update
                .update_compression_state(
                    &session_id,
                    CompressionState {
                        last_compression_at: None,
                        compression_count: 1,
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!update_task.is_finished());

        drop(guard);
        update_task
            .await
            .expect("update task should join")
            .expect("compression update should continue after the permit is released");
    }

    #[tokio::test]
    async fn turn_start_waits_for_the_same_session_mutation_permit() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Serialized turn start".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let guard = manager.lock_session_mutation(&session.session_id).await;
        let manager_for_turn = manager.clone();
        let session_id = session.session_id.clone();
        let turn_task = tokio::spawn(async move {
            manager_for_turn
                .start_dialog_turn(
                    &session_id,
                    "Standard".to_string(),
                    "hello".to_string(),
                    Some("serialized-turn".to_string()),
                    None,
                    None,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!turn_task.is_finished());

        drop(guard);
        turn_task
            .await
            .expect("turn task should join")
            .expect("turn start should continue after the permit is released");
    }

    #[tokio::test]
    async fn same_session_mode_is_a_timestamp_preserving_noop() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Idempotent mode update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let before = manager
            .get_session(&session.session_id)
            .expect("active session before update");
        let before_updated_at = before.updated_at;
        let before_last_activity_at = before.last_activity_at;
        drop(before);
        tokio::time::sleep(Duration::from_millis(20)).await;

        manager
            .update_session_agent_type(&session.session_id, "Standard")
            .await
            .expect("same mode should succeed");

        let after = manager
            .get_session(&session.session_id)
            .expect("active session after update");
        assert_eq!(after.updated_at, before_updated_at);
        assert_eq!(after.last_activity_at, before_last_activity_at);
    }

    #[tokio::test]
    async fn session_mode_persists_without_a_turn_and_survives_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Durable mode update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .update_session_agent_type(&session.session_id, "Cowork")
            .await
            .expect("mode update should persist without a turn");
        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.agent_type, "Cowork");

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");
        assert_eq!(restored.agent_type, "Cowork");
    }

    #[tokio::test]
    async fn external_agent_binding_persists_atomically_and_never_restores_as_local_by_name() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Durable external route".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .update_session_agent_binding(
                &session.session_id,
                "Standard",
                SessionAgentRouteOwner::External,
                Some("test:external:agentic".to_string()),
            )
            .await
            .expect("same-id local-to-external rebind should persist");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("rebound session")
                .config
                .agent_route_owner,
            SessionAgentRouteOwner::External
        );
        manager
            .update_session_agent_binding(
                &session.session_id,
                "Standard",
                SessionAgentRouteOwner::Local,
                Some("local:agentic".to_string()),
            )
            .await
            .expect("same-id external-to-local rebind should persist");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("rebound session")
                .config
                .agent_route_owner,
            SessionAgentRouteOwner::Local
        );

        manager
            .update_session_agent_binding(
                &session.session_id,
                "Cowork",
                SessionAgentRouteOwner::External,
                Some("test:external:plan".to_string()),
            )
            .await
            .expect("external route update should persist without a turn");

        let (persisted, _) = persistence_manager
            .load_session_with_turns(workspace.path(), &session.session_id)
            .await
            .expect("persisted session should load");
        assert_eq!(persisted.agent_type, "Cowork");
        assert_eq!(
            persisted.config.agent_route_owner,
            SessionAgentRouteOwner::External
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("external route should restore fail-closed");
        assert_eq!(restored.agent_type, "Cowork");
        assert_eq!(
            restored.config.agent_route_owner,
            SessionAgentRouteOwner::External,
            "a same-name local mode must not capture a persisted external route"
        );
    }

    #[tokio::test]
    async fn session_mode_update_does_not_rewrite_the_runtime_state_file() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Metadata-only mode update".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        persistence_manager.fail_next_session_state_write_for_test(&session.session_id);

        manager
            .update_session_agent_type(&session.session_id, "Cowork")
            .await
            .expect("mode updates must not depend on rewriting runtime state");
        manager.evict_loaded_session_for_test(&session.session_id);

        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("metadata-only mode update should remain restorable");
        assert_eq!(restored.agent_type, "Cowork");
    }

    #[tokio::test]
    async fn persistence_manager_accessor_reuses_runtime_owner() {
        let persistence_manager =
            Arc::new(PersistenceManager::new(test_path_manager()).expect("persistence manager"));
        let manager = test_manager(persistence_manager.clone());

        assert!(Arc::ptr_eq(
            &persistence_manager,
            &manager.persistence_manager()
        ));
    }

    fn test_model(id: &str, context_window: u32) -> ServiceAIModelConfig {
        ServiceAIModelConfig {
            id: id.to_string(),
            name: id.to_string(),
            model_name: id.to_string(),
            enabled: true,
            context_window: Some(context_window),
            ..Default::default()
        }
    }

    fn configured_reasoning_model(id: &str) -> ServiceAIModelConfig {
        ServiceAIModelConfig {
            id: id.to_string(),
            name: id.to_string(),
            model_name: id.to_string(),
            enabled: true,
            reasoning: Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Disabled,
                presets: vec![ReasoningPreset {
                    id: "high".to_string(),
                    actions: vec![ReasoningPresetAction::Effort {
                        value: "high".to_string(),
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn reasoning_model_with_default(id: &str, default_preset: &str) -> ServiceAIModelConfig {
        ServiceAIModelConfig {
            id: id.to_string(),
            name: id.to_string(),
            model_name: id.to_string(),
            enabled: true,
            reasoning: Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Disabled,
                default_preset: Some(default_preset.to_string()),
                presets: ["low", "high"]
                    .into_iter()
                    .map(|preset_id| ReasoningPreset {
                        id: preset_id.to_string(),
                        actions: vec![ReasoningPresetAction::Effort {
                            value: preset_id.to_string(),
                        }],
                        ..Default::default()
                    })
                    .collect(),
            }),
            ..Default::default()
        }
    }

    #[cfg(feature = "model-catalog")]
    #[tokio::test]
    async fn reasoning_preset_normalization_uses_the_updated_model() {
        let ai_config = ServiceAIConfig {
            models: vec![
                configured_reasoning_model("model-a"),
                test_model("model-b", 128_000),
            ],
            ..Default::default()
        };
        let mut session = Session::new_with_id(
            "reasoning-selection".to_string(),
            "Reasoning selection".to_string(),
            "Standard".to_string(),
            SessionConfig {
                model_id: Some("model-a".to_string()),
                reasoning_preset: Some("high".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(
            SessionManager::normalize_session_reasoning_preset(&session, &ai_config).await,
            Some("high".to_string())
        );
        session.config.model_id = Some("model-b".to_string());
        assert_eq!(
            SessionManager::normalize_session_reasoning_preset(&session, &ai_config).await,
            None
        );
    }

    #[cfg(feature = "model-catalog")]
    #[tokio::test]
    async fn reasoning_preset_reconciliation_persists_auto_state() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Stale reasoning preset".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    model_id: Some("model-b".to_string()),
                    reasoning_preset: Some("obsolete".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        // The test config service is intentionally absent, so seed the legacy
        // invalid state that reconciliation must canonicalize.
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session remains loaded")
            .config
            .reasoning_preset = Some("obsolete".to_string());
        let seeded = manager
            .get_session(&session.session_id)
            .expect("seeded session");
        persistence_manager
            .save_session(workspace.path(), &seeded)
            .await
            .expect("seeded preset should persist");
        let ai_config = ServiceAIConfig {
            models: vec![test_model("model-b", 128_000)],
            ..Default::default()
        };

        manager
            .reconcile_session_reasoning_preset_locked(&session.session_id, &ai_config, "test")
            .await
            .expect("reconciliation should succeed");

        assert!(manager
            .get_session(&session.session_id)
            .expect("session remains loaded")
            .config
            .reasoning_preset
            .is_none());
        assert!(persistence_manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .expect("session should reload")
            .config
            .reasoning_preset
            .is_none());
    }

    #[tokio::test]
    async fn session_creation_persists_resolved_model_context_window() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let ai_config = ServiceAIConfig {
            models: vec![test_model("deepseek-v4-flash", 200_000)],
            ..Default::default()
        };

        let session = TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(ai_config, async {
                manager
                    .create_session(
                        "Remote session".to_string(),
                        "Standard".to_string(),
                        SessionConfig {
                            workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                            model_id: Some("deepseek-v4-flash".to_string()),
                            max_context_tokens: 128_128,
                            ..Default::default()
                        },
                    )
                    .await
            })
            .await
            .expect("session should create");

        assert_eq!(session.config.max_context_tokens, 200_000);
        let persisted = persistence_manager
            .load_session(workspace.path(), &session.session_id)
            .await
            .expect("persisted session should load");
        assert_eq!(persisted.config.max_context_tokens, 200_000);
    }

    #[test]
    fn sync_session_context_window_refreshes_stale_explicit_model_window() {
        let ai_config = ServiceAIConfig {
            models: vec![test_model("deepseek-v4-pro", 1_000_000)],
            ..Default::default()
        };

        let mut session = Session::new_with_id(
            "session-804".to_string(),
            "DeepSeek session".to_string(),
            "Standard".to_string(),
            SessionConfig {
                model_id: Some("deepseek-v4-pro".to_string()),
                max_context_tokens: 256_000,
                ..Default::default()
            },
        );

        let resolved =
            SessionManager::sync_session_context_window_from_ai_config(&mut session, &ai_config);

        assert_eq!(resolved, Some(1_000_000));
        assert_eq!(session.config.max_context_tokens, 1_000_000);
    }

    #[test]
    fn sync_session_context_window_resolves_missing_selection_through_mode_default_then_primary() {
        let mut ai_config = ServiceAIConfig {
            models: vec![
                test_model("primary-model", 512_000),
                test_model("agent-model", 1_000_000),
            ],
            ..Default::default()
        };
        ai_config.default_models.primary = Some("primary-model".to_string());
        ai_config.agent_model_defaults.mode = "agent-model".to_string();

        let mut session = Session::new_with_id(
            "session-default".to_string(),
            "Default session".to_string(),
            "Standard".to_string(),
            SessionConfig {
                model_id: None,
                max_context_tokens: 256_000,
                ..Default::default()
            },
        );

        let resolved =
            SessionManager::sync_session_context_window_from_ai_config(&mut session, &ai_config);

        assert_eq!(resolved, Some(1_000_000));
        assert_eq!(session.config.max_context_tokens, 1_000_000);

        ai_config.agent_model_defaults.mode = "primary".to_string();
        session.config.max_context_tokens = 256_000;

        let resolved =
            SessionManager::sync_session_context_window_from_ai_config(&mut session, &ai_config);

        assert_eq!(resolved, Some(512_000));
        assert_eq!(session.config.max_context_tokens, 512_000);
    }

    #[test]
    fn sync_session_context_window_resolves_missing_subagent_selection_through_primary() {
        let mut ai_config = ServiceAIConfig {
            models: vec![
                test_model("primary-model", 512_000),
                test_model("mode-model", 1_000_000),
            ],
            ..Default::default()
        };
        ai_config.default_models.primary = Some("primary-model".to_string());
        ai_config.agent_model_defaults.mode = "mode-model".to_string();

        let mut session = Session::new_with_id(
            "subagent-default".to_string(),
            "Default subagent".to_string(),
            "Explore".to_string(),
            SessionConfig {
                model_id: None,
                max_context_tokens: 256_000,
                ..Default::default()
            },
        );
        session.kind = SessionKind::Subagent;

        let resolved =
            SessionManager::sync_session_context_window_from_ai_config(&mut session, &ai_config);

        assert_eq!(resolved, Some(512_000));
        assert_eq!(session.config.max_context_tokens, 512_000);
    }

    #[tokio::test]
    async fn auto_save_interval_waits_before_first_tick() {
        let mut ticker = SessionManager::auto_save_interval(Duration::from_millis(40));
        let started = tokio::time::Instant::now();

        ticker.tick().await;

        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[tokio::test]
    async fn auto_save_snapshot_collection_releases_session_map_guards() {
        let workspace = TestWorkspace::new();
        let manager = in_memory_test_manager();
        let session = manager
            .create_session(
                "Auto-save snapshot".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let snapshots = SessionManager::collect_auto_save_snapshots(
            &manager.sessions,
            &manager.transient_session_ids,
        );
        assert!(snapshots
            .iter()
            .any(|snapshot| snapshot.session_id == session.session_id));

        match manager.sessions.try_get_mut(&session.session_id) {
            TryResult::Present(_) => {}
            TryResult::Absent => panic!("session should remain present"),
            TryResult::Locked => panic!("snapshot collection should not retain session map guards"),
        };
    }

    #[tokio::test]
    async fn reset_session_state_if_processing_ignores_a_newer_turn() {
        let manager = in_memory_test_manager();
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Active session".to_string(),
            "agent".to_string(),
            SessionConfig::default(),
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-2".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        manager.sessions.insert(session_id.clone(), session);

        manager.reset_session_state_if_processing(&session_id, "turn-1");

        let session = manager
            .get_session(&session_id)
            .expect("session should remain available");
        assert!(matches!(
            session.state,
            SessionState::Processing {
                ref current_turn_id,
                ..
            } if current_turn_id == "turn-2"
        ));
    }

    #[tokio::test]
    async fn reset_session_state_if_processing_resets_the_matching_turn() {
        let manager = in_memory_test_manager();
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Active session".to_string(),
            "agent".to_string(),
            SessionConfig::default(),
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        manager.sessions.insert(session_id.clone(), session);

        manager.reset_session_state_if_processing(&session_id, "turn-1");

        let session = manager
            .get_session(&session_id)
            .expect("session should remain available");
        assert!(matches!(session.state, SessionState::Idle));
    }

    #[tokio::test]
    async fn update_session_state_for_turn_if_processing_ignores_a_newer_turn() {
        let manager = in_memory_test_manager();
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Active session".to_string(),
            "agent".to_string(),
            SessionConfig::default(),
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-2".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        manager.sessions.insert(session_id.clone(), session);

        let updated = manager
            .update_session_state_for_turn_if_processing(&session_id, "turn-1", SessionState::Idle)
            .await
            .expect("conditional state update should not fail");

        let session = manager
            .get_session(&session_id)
            .expect("session should remain available");
        assert!(!updated);
        assert!(matches!(
            session.state,
            SessionState::Processing {
                ref current_turn_id,
                ..
            } if current_turn_id == "turn-2"
        ));
    }

    #[tokio::test]
    async fn update_session_state_for_turn_if_processing_updates_matching_turn() {
        let manager = in_memory_test_manager();
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Active session".to_string(),
            "agent".to_string(),
            SessionConfig::default(),
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: ProcessingPhase::Thinking,
        };
        manager.sessions.insert(session_id.clone(), session);

        let updated = manager
            .update_session_state_for_turn_if_processing(&session_id, "turn-1", SessionState::Idle)
            .await
            .expect("conditional state update should not fail");

        let session = manager
            .get_session(&session_id)
            .expect("session should remain available");
        assert!(updated);
        assert!(matches!(session.state, SessionState::Idle));
    }

    #[tokio::test]
    async fn voice_exchange_survives_restore_and_idempotent_replay() {
        let workspace = TestWorkspace::new();
        let persistence = Arc::new(PersistenceManager::new(workspace.path_manager()).unwrap());
        let manager = test_manager(persistence.clone());
        let session = manager
            .create_session(
                "Voice".into(),
                "agent".into(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        for _ in 0..2 {
            manager
                .append_voice_exchange(
                    &session.session_id,
                    "voice-1",
                    "Remember this".into(),
                    "I will".into(),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            manager
                .get_messages(&session.session_id)
                .await
                .unwrap()
                .len(),
            2
        );
        let turns = persistence
            .load_session_turns(workspace.path(), &session.session_id)
            .await
            .unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].kind, DialogTurnKind::UserDialog);
        assert_eq!(SessionManager::build_messages_from_turns(&turns).len(), 2);
        // The existing persisted UserDialog shape is enough; no new enum is required.
        let encoded = serde_json::to_value(&turns[0]).unwrap();
        let decoded: DialogTurnData = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.user_message.content, "Remember this");
        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("first writer should unload"));
        drop(manager);
        let restored = test_manager(persistence);
        restored
            .restore_session(workspace.path(), &session.session_id)
            .await
            .unwrap();
        restored
            .append_voice_exchange(
                &session.session_id,
                "voice-1",
                "Remember this".into(),
                "I will".into(),
            )
            .await
            .unwrap();
        assert_eq!(
            restored
                .get_messages(&session.session_id)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn voice_exchange_does_not_overwrite_a_running_turn() {
        let workspace = TestWorkspace::new();
        let manager = test_manager(Arc::new(
            PersistenceManager::new(workspace.path_manager()).unwrap(),
        ));
        let session = manager
            .create_session(
                "Voice".into(),
                "agent".into(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        manager.sessions.get_mut(&session.session_id).unwrap().state = SessionState::Processing {
            current_turn_id: "running".into(),
            phase: ProcessingPhase::Thinking,
        };
        assert!(manager
            .append_voice_exchange(&session.session_id, "voice-2", "Hello".into(), "Hi".into())
            .await
            .is_err());
        let unchanged = manager.get_session(&session.session_id).unwrap();
        assert!(matches!(unchanged.state, SessionState::Processing { .. }));
        assert!(unchanged.dialog_turn_ids.is_empty());
    }

    #[tokio::test]
    async fn append_completed_local_command_turn_persists_without_model_context() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Usage session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let turn = manager
            .append_completed_local_command_turn(
                &session.session_id,
                "# Session Usage Report".to_string(),
                Some("local-usage-1".to_string()),
                Some(42),
                Some(json!({
                    "localCommandKind": "usage_report",
                    "modelVisible": false,
                })),
            )
            .await
            .expect("local command turn should persist");

        assert_eq!(turn.kind, DialogTurnKind::LocalCommand);
        assert_eq!(turn.status, TurnStatus::Completed);

        let active = manager
            .get_session(&session.session_id)
            .expect("session should remain active");
        assert_eq!(active.dialog_turn_ids, vec!["local-usage-1".to_string()]);
        assert!(manager
            .context_store
            .get_context_messages(&session.session_id)
            .is_empty());

        let persisted_turns = persistence_manager
            .load_session_turns(workspace.path(), &session.session_id)
            .await
            .expect("turns should load");
        assert_eq!(persisted_turns.len(), 1);
        assert_eq!(persisted_turns[0].kind, DialogTurnKind::LocalCommand);
        assert!(SessionManager::build_messages_from_turns(&persisted_turns).is_empty());

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.turn_count, 1);
    }

    #[tokio::test]
    async fn append_completed_local_command_turn_waits_for_session_mutation() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Serialized local command".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let mutation = manager
            .acquire_session_mutation(&session.session_id)
            .await
            .expect("hold mutation boundary");
        let append_manager = manager.clone();
        let append_session_id = session.session_id.clone();
        let append = tokio::spawn(async move {
            append_manager
                .append_completed_local_command_turn(
                    &append_session_id,
                    "usage report".to_string(),
                    Some("usage-turn".to_string()),
                    Some(1),
                    None,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert!(!append.is_finished());
        drop(mutation);
        append
            .await
            .expect("append task should join")
            .expect("append should succeed after mutation releases");
    }

    #[tokio::test]
    async fn restore_session_resets_processing_state_without_marking_unread_completion() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Legacy processing session".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        session.state = SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: ProcessingPhase::Thinking,
        };

        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        persistence_manager
            .save_session_state(workspace.path(), &session_id, &session.state)
            .await
            .expect("processing state should save");

        let manager = test_manager(persistence_manager.clone());
        let restored = manager
            .restore_session(workspace.path(), &session_id)
            .await
            .expect("session should restore");
        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");

        assert!(matches!(restored.state, SessionState::Idle));
        assert_eq!(metadata.unread_completion, None);
    }

    #[tokio::test]
    async fn ephemeral_child_session_is_kept_in_memory_without_persisting() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());

        let session = manager
            .create_session_with_id_and_details(
                Some(Uuid::new_v4().to_string()),
                "Side thread".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
                Some("session-parent".to_string()),
                SessionKind::EphemeralChild,
            )
            .await
            .expect("ephemeral child session should create");

        assert!(manager.get_session(&session.session_id).is_some());
        assert!(persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata lookup should succeed")
            .is_none());
        assert_eq!(
            manager
                .persistent_model_exchange_trace_dir(&session.session_id)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn persisted_session_uses_session_local_model_exchange_trace_dir() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence_manager =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let manager = test_manager(persistence_manager);

        let session = manager
            .create_session_with_id_and_details(
                Some(Uuid::new_v4().to_string()),
                "Main thread".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
                None,
                SessionKind::Standard,
            )
            .await
            .expect("standard session should create");

        assert_eq!(
            manager
                .persistent_model_exchange_trace_dir(&session.session_id)
                .await,
            Some(
                path_manager
                    .project_sessions_dir(workspace.path())
                    .join(&session.session_id)
                    .join("request-traces")
            )
        );
    }

    #[tokio::test]
    async fn persist_session_lineage_updates_structured_relationship_and_clears_legacy_projection()
    {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());

        let session = manager
            .create_session_with_id_and_details(
                Some(Uuid::new_v4().to_string()),
                "Review child".to_string(),
                "CodeReview".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
                Some("session-parent".to_string()),
                SessionKind::Standard,
            )
            .await
            .expect("session should create");

        manager
            .merge_session_custom_metadata(
                &session.session_id,
                json!({
                    "kind": "review",
                    "parentSessionId": "stale-parent",
                    "parentRequestId": "stale-request",
                    "parentDialogTurnId": "stale-turn",
                    "parentTurnIndex": 1,
                    "parentToolCallId": "stale-tool",
                    "subagentType": "stale-subagent",
                    "preservedKey": "preserved-value",
                }),
            )
            .await
            .expect("legacy compatibility metadata should seed");

        manager
            .persist_session_lineage(
                &session.session_id,
                SessionRelationship {
                    kind: Some(SessionRelationshipKind::DeepReview),
                    parent_session_id: Some("parent-1".to_string()),
                    parent_request_id: Some("request-1".to_string()),
                    parent_dialog_turn_id: Some("turn-2".to_string()),
                    parent_turn_index: Some(2),
                    parent_tool_call_id: None,
                    subagent_type: None,
                    continuation_policy: None,
                },
            )
            .await
            .expect("lineage should persist");

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata lookup should succeed")
            .expect("metadata should exist");

        assert_eq!(
            metadata.relationship,
            Some(SessionRelationship {
                kind: Some(SessionRelationshipKind::DeepReview),
                parent_session_id: Some("parent-1".to_string()),
                parent_request_id: Some("request-1".to_string()),
                parent_dialog_turn_id: Some("turn-2".to_string()),
                parent_turn_index: Some(2),
                parent_tool_call_id: None,
                subagent_type: None,
                continuation_policy: None,
            })
        );

        let custom_metadata = metadata
            .custom_metadata
            .expect("non-lineage custom metadata should remain");
        assert_eq!(custom_metadata["preservedKey"], "preserved-value");
        assert!(custom_metadata.get("kind").is_none());
        assert!(custom_metadata.get("parentSessionId").is_none());
        assert!(custom_metadata.get("parentRequestId").is_none());
        assert!(custom_metadata.get("parentDialogTurnId").is_none());
        assert!(custom_metadata.get("parentTurnIndex").is_none());
        assert!(custom_metadata.get("parentToolCallId").is_none());
        assert!(custom_metadata.get("subagentType").is_none());
    }

    #[tokio::test]
    async fn collect_hidden_subagent_cascade_for_parent_turns_returns_post_order_matches() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());

        let mut matched_root = SessionMetadata::new(
            "child-root".to_string(),
            "Subagent: root".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        matched_root.session_kind = SessionKind::Subagent;
        matched_root.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent-session".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn-2".to_string()),
            parent_turn_index: Some(2),
            parent_tool_call_id: Some("tool-1".to_string()),
            subagent_type: Some("Explore".to_string()),
            continuation_policy: None,
        });
        persistence_manager
            .save_session_metadata(workspace.path(), &matched_root)
            .await
            .expect("matched root should save");

        let mut matched_grandchild = SessionMetadata::new(
            "grandchild".to_string(),
            "Subagent: grandchild".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        matched_grandchild.session_kind = SessionKind::Subagent;
        matched_grandchild.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("child-root".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("child-turn".to_string()),
            parent_turn_index: None,
            parent_tool_call_id: Some("tool-child".to_string()),
            subagent_type: Some("Explore".to_string()),
            continuation_policy: None,
        });
        persistence_manager
            .save_session_metadata(workspace.path(), &matched_grandchild)
            .await
            .expect("grandchild should save");

        let mut unmatched_root = SessionMetadata::new(
            "child-other-turn".to_string(),
            "Subagent: other turn".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        unmatched_root.session_kind = SessionKind::Subagent;
        unmatched_root.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent-session".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn-1".to_string()),
            parent_turn_index: Some(1),
            parent_tool_call_id: Some("tool-2".to_string()),
            subagent_type: Some("Explore".to_string()),
            continuation_policy: None,
        });
        persistence_manager
            .save_session_metadata(workspace.path(), &unmatched_root)
            .await
            .expect("unmatched root should save");

        let mut visible_review_child = SessionMetadata::new(
            "review-child".to_string(),
            "Review child".to_string(),
            "DeepReview".to_string(),
            "model".to_string(),
        );
        visible_review_child.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::DeepReview),
            parent_session_id: Some("parent-session".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn-2".to_string()),
            parent_turn_index: Some(2),
            parent_tool_call_id: None,
            subagent_type: None,
            continuation_policy: None,
        });
        persistence_manager
            .save_session_metadata(workspace.path(), &visible_review_child)
            .await
            .expect("visible review child should save");

        let matched_turn_ids = HashSet::from(["turn-2".to_string()]);
        let cascade = manager
            .collect_hidden_subagent_cascade_for_parent_turns(
                workspace.path(),
                "parent-session",
                &matched_turn_ids,
            )
            .await
            .expect("cascade lookup should succeed");

        assert_eq!(
            cascade,
            vec!["grandchild".to_string(), "child-root".to_string()]
        );
    }

    #[tokio::test]
    async fn core_session_store_port_resolves_local_storage_to_sessions_dir() {
        use openbitfun_runtime_ports::{
            SessionStorageKind, SessionStoragePathRequest, SessionStorePort,
        };

        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let port = CoreSessionStorePort::with_path_manager_for_tests(path_manager.clone());
        let resolution = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: workspace.path().to_path_buf(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("storage path should resolve");

        assert_eq!(resolution.storage_kind, SessionStorageKind::Local);
        assert_eq!(
            resolution.effective_storage_path,
            path_manager.project_sessions_dir(workspace.path())
        );
        assert_ne!(resolution.effective_storage_path, workspace.path());

        let resolved_again = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: resolution.effective_storage_path.clone(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("resolved sessions dir should pass through");
        assert_eq!(
            resolved_again.effective_storage_path,
            resolution.effective_storage_path
        );
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn core_session_store_port_resolves_unresolved_remote_storage_path() {
        use openbitfun_runtime_ports::{
            PortErrorKind, SessionStorageKind, SessionStoragePathRequest, SessionStorePort,
        };

        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let port = CoreSessionStorePort::with_path_manager_for_tests(path_manager.clone());

        // A connection ID alone is transport metadata, not a workspace
        // identity. Without a registered remote record the request must fail
        // loudly instead of inventing an `_unresolved` mirror.
        let error = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: PathBuf::from("/remote/project"),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: None,
            })
            .await
            .expect_err("unregistered remote reference must not resolve storage");
        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert!(
            error.message.contains("does not resolve"),
            "unexpected error: {}",
            error.message
        );

        // Sessions already persisted under a legacy `_unresolved` mirror stay
        // readable: the resolved sessions dir passes through with its kind.
        let legacy_unresolved_dir =
            openbitfun_services_core::workspace_identity::unresolved_remote_session_storage_dir(
                path_manager.remote_ssh_mirror_root_dir(),
                "conn-1",
                "/remote/project",
            );
        let resolution = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: legacy_unresolved_dir.clone(),
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: None,
            })
            .await
            .expect("legacy unresolved sessions dir should pass through");
        assert_eq!(
            resolution.storage_kind,
            SessionStorageKind::UnresolvedRemote
        );
        assert!(resolution.is_remote_storage());
        assert_eq!(resolution.remote_connection_id.as_deref(), Some("conn-1"));
        assert_eq!(resolution.effective_storage_path, legacy_unresolved_dir);
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn core_session_store_port_resolved_remote_sessions_dir_passes_through_only_sessions_root(
    ) {
        use openbitfun_runtime_ports::{
            SessionStorageKind, SessionStoragePathRequest, SessionStorePort,
        };

        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let port = CoreSessionStorePort::with_path_manager_for_tests(path_manager.clone());
        let sessions_dir =
            openbitfun_services_integrations::remote_ssh::remote_workspace_session_mirror_dir(
                path_manager.remote_ssh_mirror_root_dir(),
                "example-host",
                "/root/repo",
            );
        let resolved = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: sessions_dir.clone(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("resolved remote sessions dir should pass through");

        assert_eq!(resolved.storage_kind, SessionStorageKind::Remote);
        assert_eq!(resolved.effective_storage_path, sessions_dir);

        let runtime_root =
            openbitfun_services_integrations::remote_ssh::remote_workspace_runtime_root(
                path_manager.remote_ssh_mirror_root_dir(),
                "example-host",
                "/root/repo",
            );
        let runtime_root_resolution = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: runtime_root.clone(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await;

        assert!(
            runtime_root_resolution.is_err(),
            "remote runtime root must not pass as a resolved sessions dir"
        );
    }

    #[tokio::test]
    async fn restore_session_from_storage_path_accepts_resolved_sessions_dir() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence_manager =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let manager = test_manager(persistence_manager.clone());
        let sessions_dir = path_manager.project_sessions_dir(workspace.path());
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Resolved sessions restore".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        persistence_manager
            .save_session(&sessions_dir, &session)
            .await
            .expect("session should save to resolved sessions dir");

        let restored = manager
            .restore_session_from_storage_path(&sessions_dir, &session_id)
            .await
            .expect("storage restore should read the resolved sessions dir directly");

        assert_eq!(restored.session_id, session_id);
    }

    #[tokio::test]
    async fn restore_session_workspace_api_does_not_accept_resolved_sessions_dir() {
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence_manager =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let manager = test_manager(persistence_manager.clone());
        let sessions_dir = path_manager.project_sessions_dir(workspace.path());
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Resolved sessions restore".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );

        persistence_manager
            .save_session(&sessions_dir, &session)
            .await
            .expect("session should save to resolved sessions dir");

        let result = manager.restore_session(&sessions_dir, &session_id).await;

        assert!(
            result.is_err(),
            "workspace restore should not accept an already-resolved sessions dir"
        );
    }

    #[tokio::test]
    async fn restore_session_for_workspace_uses_remote_identity() {
        crate::service::workspace::legacy_compat::register_remote_fixture(
            "/home/wsp/project",
            "ssh-1",
            "dev-host",
        )
        .await;
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence_manager =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let manager = test_manager(persistence_manager.clone());
        let sessions_dir = crate::service::WorkspaceRuntimeService::new(path_manager.clone())
            .context_for_remote_workspace("dev-host", "/home/wsp/project")
            .sessions_dir;
        let session_id = Uuid::new_v4().to_string();
        let session = Session::new_with_id(
            session_id.clone(),
            "Remote identity restore".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some("/home/wsp/project".to_string()),
                remote_connection_id: Some("ssh-1".to_string()),
                remote_ssh_host: Some("dev-host".to_string()),
                ..Default::default()
            },
        );

        persistence_manager
            .save_session(&sessions_dir, &session)
            .await
            .expect("session should save to remote sessions dir");

        let restored = manager
            .restore_session_for_workspace(
                SessionStoragePathRequest {
                    workspace_path: PathBuf::from("/home/wsp/project"),
                    remote_connection_id: Some("ssh-1".to_string()),
                    remote_ssh_host: Some("dev-host".to_string()),
                },
                &session_id,
            )
            .await
            .expect("workspace restore should use remote identity");

        assert_eq!(restored.session_id, session_id);
    }

    #[tokio::test]
    async fn restore_session_view_loads_turns_without_restoring_runtime_context() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Large history".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        session.dialog_turn_ids = vec!["turn-1".to_string()];

        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");
        let turn = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            session_id.clone(),
            UserMessageData {
                id: "turn-1-user".to_string(),
                content: "hello".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        persistence_manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");
        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session_id,
                0,
                &[Message::user("snapshot prompt".to_string())],
            )
            .await
            .expect("context snapshot should save");

        let (view_session, turns) = manager
            .restore_session_view(workspace.path(), &session_id)
            .await
            .expect("session view should restore");

        assert_eq!(view_session.dialog_turn_ids, vec!["turn-1".to_string()]);
        assert_eq!(turns.len(), 1);
        assert!(manager.get_session(&session_id).is_none());
        assert!(manager
            .context_store
            .get_context_messages(&session_id)
            .is_empty());
    }

    #[tokio::test]
    async fn start_dialog_turn_with_existing_context_persists_turn_and_snapshot() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Fork child".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let seeded_messages = vec![
            Message::user("fork reminder".to_string()),
            Message::assistant("inherited context".to_string()),
        ];
        manager
            .replace_context_messages(&session.session_id, seeded_messages.clone())
            .await;

        let turn_id = manager
            .start_dialog_turn_with_existing_context(
                &session.session_id,
                "Standard".to_string(),
                "delegate task".to_string(),
                Some("subagent-turn-0".to_string()),
                None,
            )
            .await
            .expect("turn should start");

        assert_eq!(turn_id, "subagent-turn-0");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session should remain in memory")
                .dialog_turn_ids,
            vec!["subagent-turn-0".to_string()]
        );

        let persisted_turn = persistence_manager
            .load_dialog_turn(workspace.path(), &session.session_id, 0)
            .await
            .expect("turn load should succeed")
            .expect("turn should exist");
        assert_eq!(persisted_turn.turn_id, "subagent-turn-0");
        assert_eq!(persisted_turn.user_message.content, "delegate task");

        let snapshot = persistence_manager
            .load_turn_context_snapshot(workspace.path(), &session.session_id, 0)
            .await
            .expect("snapshot load should succeed")
            .expect("snapshot should exist");
        assert_eq!(snapshot.len(), seeded_messages.len());
        assert!(matches!(snapshot[0].role, MessageRole::User));
        assert!(matches!(snapshot[1].role, MessageRole::Assistant));
        assert!(matches!(
            &snapshot[0].content,
            MessageContent::Text(text) if text == "fork reminder"
        ));
        assert!(matches!(
            &snapshot[1].content,
            MessageContent::Text(text) if text == "inherited context"
        ));

        let runtime_context = manager
            .get_context_messages(&session.session_id)
            .await
            .expect("runtime context should remain readable");
        assert_eq!(runtime_context.len(), seeded_messages.len());
    }

    #[tokio::test]
    async fn dialog_and_maintenance_turn_admission_is_atomic() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Atomic admission".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let dialog = manager.start_dialog_turn(
            &session.session_id,
            "Standard".to_string(),
            "new user input".to_string(),
            Some("dialog-turn".to_string()),
            None,
            None,
        );
        let maintenance = manager.start_maintenance_turn(
            &session.session_id,
            "/compact".to_string(),
            Some("compact-turn".to_string()),
            None,
        );
        let (dialog_result, maintenance_result) = tokio::join!(dialog, maintenance);

        assert_eq!(
            usize::from(dialog_result.is_ok()) + usize::from(maintenance_result.is_ok()),
            1,
            "only one competing turn may acquire an idle session"
        );
        let active = manager
            .get_session(&session.session_id)
            .expect("session should remain available");
        assert_eq!(active.dialog_turn_ids.len(), 1);
        let accepted_turn = dialog_result
            .ok()
            .or_else(|| maintenance_result.ok())
            .expect("one turn should be admitted");
        assert!(matches!(
            active.state,
            SessionState::Processing {
                ref current_turn_id,
                ..
            } if current_turn_id == &accepted_turn
        ));
    }

    #[tokio::test]
    async fn user_dialog_retry_is_allowed_from_error_but_maintenance_is_not() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Retry admission".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        {
            let mut active = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("session should remain available");
            active.state = SessionState::Error {
                error: "retryable failure".to_string(),
                recoverable: true,
            };
        }

        let maintenance = manager
            .start_maintenance_turn(
                &session.session_id,
                "/compact".to_string(),
                Some("compact-turn".to_string()),
                None,
            )
            .await;
        assert!(
            maintenance.is_err(),
            "maintenance work must remain idle-only"
        );

        let retry_turn = manager
            .start_dialog_turn(
                &session.session_id,
                "Standard".to_string(),
                "retry after failure".to_string(),
                Some("retry-turn".to_string()),
                None,
                None,
            )
            .await
            .expect("ordinary dialog should preserve error-state retry semantics");
        assert_eq!(retry_turn, "retry-turn");
    }

    #[tokio::test]
    async fn maintenance_failure_persists_its_terminal_error() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Failed maintenance".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let turn_id = manager
            .start_maintenance_turn(
                &session.session_id,
                "/compact".to_string(),
                Some("compact-turn".to_string()),
                None,
            )
            .await
            .expect("maintenance turn should start");

        manager
            .fail_maintenance_turn(
                &session.session_id,
                &turn_id,
                "terminal persistence failed".to_string(),
                Vec::new(),
            )
            .await
            .expect("maintenance failure should persist");

        let _mutation = manager
            .acquire_session_mutation(&session.session_id)
            .await
            .expect("transcript mutation");
        let turns = manager
            .load_persisted_transcript_turns_locked(&session.session_id)
            .await
            .expect("turns should load")
            .expect("persistence should be enabled");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].status, TurnStatus::Error);
        assert_eq!(turns[0].finish_reason.as_deref(), Some("failed"));
        assert_eq!(turns[0].has_final_response, Some(false));
        assert_eq!(
            turns[0].error.as_deref(),
            Some("terminal persistence failed")
        );
    }

    #[tokio::test]
    async fn restore_session_view_preserves_full_visible_tool_result_payload() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "History with tool output".to_string(),
            "agent".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        session.dialog_turn_ids = vec!["turn-1".to_string()];

        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let visible_output = "complete visible output ".repeat(128);
        let assistant_output = "assistant visible summary ".repeat(16);
        let mut turn = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            session_id.clone(),
            UserMessageData {
                id: "turn-1-user".to_string(),
                content: "show full output".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        turn.model_rounds.push(ModelRoundData {
            id: "round-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 1,
            text_items: vec![],
            tool_items: vec![ToolItemData {
                id: "tool-1".to_string(),
                tool_name: "ExecCommand".to_string(),
                tool_call: ToolCallData {
                    id: "call-1".to_string(),
                    input: json!({ "cmd": "printf output" }),
                },
                tool_result: Some(ToolResultData {
                    result: json!({
                        "stdout": visible_output,
                        "nested": {
                            "stderr": "also visible",
                        },
                    }),
                    success: true,
                    result_for_assistant: Some(assistant_output.clone()),
                    image_attachments: None,
                    error: None,
                    duration_ms: Some(1),
                }),
                ai_intent: None,
                start_time: 1,
                end_time: Some(2),
                duration_ms: Some(1),
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
                order_index: None,
                is_subagent_item: None,
                parent_task_tool_id: None,
                subagent_session_id: None,
                subagent_dialog_turn_id: None,
                attempt_id: None,
                attempt_index: None,
                subagent_model_id: None,
                subagent_model_display_name: None,
                status: Some("completed".to_string()),
                interruption_reason: None,
            }],
            thinking_items: vec![],
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        });
        persistence_manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");

        let (view_session, turns) = manager
            .restore_session_view(workspace.path(), &session_id)
            .await
            .expect("session view should restore");

        let restored_result = turns[0].model_rounds[0].tool_items[0]
            .tool_result
            .as_ref()
            .expect("tool result should be preserved");
        assert_eq!(view_session.dialog_turn_ids, vec!["turn-1".to_string()]);
        assert_eq!(
            restored_result.result["stdout"].as_str(),
            Some(visible_output.as_str())
        );
        assert_eq!(
            restored_result.result["nested"]["stderr"].as_str(),
            Some("also visible")
        );
        assert_eq!(
            restored_result.result_for_assistant.as_deref(),
            Some(assistant_output.as_str())
        );
        assert!(manager.get_session(&session_id).is_none());
    }

    #[tokio::test]
    async fn rollback_context_deletes_persisted_turns_from_target() {
        use crate::agentic::execution::edit_constraint_guard::{
            ConstraintExtractionRecord, ConstraintMatcher, ConstraintOperationScope,
            ConstraintRevocation, ConstraintSource, ExtractedConstraint, ExtractionStatus,
            ModelExtractionStatus,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Rollback session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let test_constraint = ExtractedConstraint {
            id: "deterministic:test_files".to_string(),
            description: "do not modify tests".to_string(),
            operation_scope: ConstraintOperationScope::All,
            matcher: ConstraintMatcher::TestFiles,
            source: ConstraintSource::Deterministic,
            source_text: Some("Do not modify tests.".to_string()),
        };
        manager
            .remember_edit_constraint_extraction(
                &session.session_id,
                ConstraintExtractionRecord {
                    message_sha256: "turn-0-hash".to_string(),
                    dialog_turn_id: Some("turn-0".to_string()),
                    status: ExtractionStatus::Extracted,
                    constraints: vec![test_constraint.clone()],
                    deterministic_constraint_count: 1,
                    model_attempts: 0,
                    active_constraint_ids: Vec::new(),
                    revocation_authorized: true,
                    model_status: ModelExtractionStatus::NotRun,
                    model_constraints: Vec::new(),
                    model_revocations: Vec::new(),
                    revoked_constraint_ids: Vec::new(),
                    unmatched_revocation_ids: Vec::new(),
                    input_chars: 20,
                    prompt_chars: 20,
                    input_truncated: false,
                    latency_ms: 1,
                    extracted_at_ms: 1,
                    failure: None,
                    response_excerpt: None,
                },
            )
            .await;
        manager
            .remember_edit_constraint_agent_created_paths(
                &session.session_id,
                vec!["tests/kept-repro.rs".to_string()],
                "turn-0",
            )
            .await;
        manager
            .remember_edit_constraint_extraction(
                &session.session_id,
                ConstraintExtractionRecord {
                    message_sha256: "turn-1-hash".to_string(),
                    dialog_turn_id: Some("turn-1".to_string()),
                    status: ExtractionStatus::Extracted,
                    constraints: Vec::new(),
                    deterministic_constraint_count: 0,
                    model_attempts: 1,
                    active_constraint_ids: vec![test_constraint.id.clone()],
                    revocation_authorized: true,
                    model_status: ModelExtractionStatus::Parsed,
                    model_constraints: Vec::new(),
                    model_revocations: vec![ConstraintRevocation {
                        constraint_id: test_constraint.id.clone(),
                        description: "tests may now be modified".to_string(),
                    }],
                    revoked_constraint_ids: vec![test_constraint.id.clone()],
                    unmatched_revocation_ids: Vec::new(),
                    input_chars: 24,
                    prompt_chars: 24,
                    input_truncated: false,
                    latency_ms: 1,
                    extracted_at_ms: 2,
                    failure: None,
                    response_excerpt: None,
                },
            )
            .await;
        manager
            .remember_edit_constraint_agent_created_paths(
                &session.session_id,
                vec!["tests/future-repro.rs".to_string()],
                "turn-1",
            )
            .await;

        for index in 0..3 {
            let mut turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            turn.agent_type = Some(if index == 0 {
                "Standard".to_string()
            } else {
                "Cowork".to_string()
            });
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        {
            let mut active = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("session should be active");
            active.dialog_turn_ids = vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string(),
            ];
            active.last_user_dialog_agent_type = Some("Cowork".to_string());
        }
        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session.session_id,
                0,
                &[crate::agentic::core::Message::user("prompt 0".to_string())],
            )
            .await
            .expect("snapshot 0 should save");
        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session.session_id,
                1,
                &[
                    crate::agentic::core::Message::user("prompt 0".to_string()),
                    crate::agentic::core::Message::user("prompt 1".to_string()),
                ],
            )
            .await
            .expect("snapshot 1 should save");

        let revision = crate::agentic::session::FileRevision {
            modified_ns: 7,
            byte_len: 42,
            content_sha256: [7; 32],
        };
        manager.record_review_read(&session.session_id, "src/auth.rs", revision, 1, 20, 20);
        assert!(manager
            .review_read_coverage(&session.session_id, "src/auth.rs", revision, 1, 20)
            .is_some());

        manager
            .rollback_context_to_turn_start(workspace.path(), &session.session_id, 1)
            .await
            .expect("rollback should succeed");

        assert!(manager
            .review_read_coverage(&session.session_id, "src/auth.rs", revision, 1, 20)
            .is_none());

        let turns = persistence_manager
            .load_session_turns(workspace.path(), &session.session_id)
            .await
            .expect("turns should load");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].user_message.content, "prompt 0");
        assert_eq!(turns[0].agent_type.as_deref(), Some("Standard"));
        assert!(persistence_manager
            .load_turn_context_snapshot(workspace.path(), &session.session_id, 1)
            .await
            .expect("snapshot load should succeed")
            .is_none());
        assert_eq!(
            manager.edit_constraints(&session.session_id),
            Some(vec![test_constraint.clone()])
        );
        assert_eq!(
            manager
                .edit_constraint_state(&session.session_id)
                .expect("constraint state should remain cached")
                .agent_created_paths,
            vec!["tests/kept-repro.rs".to_string()]
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");
        assert_eq!(restored.dialog_turn_ids, vec!["turn-0".to_string()]);
        assert_eq!(
            restored.last_user_dialog_agent_type.as_deref(),
            Some("Standard")
        );
        assert_eq!(
            manager
                .context_store
                .get_context_messages(&session.session_id)
                .len(),
            1
        );

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata should load")
            .expect("metadata should exist");
        assert_eq!(metadata.turn_count, 1);
        let restored_state = SessionManager::edit_constraint_state_from_metadata(Some(&metadata))
            .expect("constraint metadata should restore");
        assert_eq!(restored_state.constraints, vec![test_constraint]);
        assert_eq!(
            restored_state.agent_created_paths,
            vec!["tests/kept-repro.rs".to_string()]
        );
    }

    #[tokio::test]
    async fn staged_revert_filters_runtime_restore_and_transcript_without_deleting_turns() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Staged revert".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..3 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|message_index| {
                    crate::agentic::core::Message::user(format!("prompt {message_index}"))
                })
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("context snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec![
            "turn-0".to_string(),
            "turn-1".to_string(),
            "turn-2".to_string(),
        ];
        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 2,
            original_turn_end: 3,
            phase: SessionRevertPhase::Staged,
            workspace_checkpoint: Vec::new(),
        };
        persistence_manager
            .save_session_revert_state(workspace.path(), &session.session_id, &state)
            .await
            .expect("staged revert should persist");

        let legacy_error = manager
            .validate_rollback_context_to_turn_start_locked(
                workspace.path(),
                &session.session_id,
                1,
            )
            .await
            .expect_err("legacy rollback must not truncate a staged Session suffix");
        assert!(matches!(legacy_error, OpenBitFunError::OutcomeUnknown(_)));

        manager
            .apply_staged_revert_context_locked(
                workspace.path(),
                &session.session_id,
                state.boundary_turn,
            )
            .await
            .expect("staged context should apply");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session should remain active")
                .dialog_turn_ids,
            vec!["turn-0".to_string(), "turn-1".to_string()]
        );
        assert_eq!(
            persistence_manager
                .load_session_turns(workspace.path(), &session.session_id)
                .await
                .expect("hidden turns should remain persisted")
                .len(),
            3
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("staged session should restore");
        assert_eq!(restored.dialog_turn_ids.len(), 2);
        assert_eq!(
            manager
                .context_store
                .get_context_messages(&session.session_id)
                .len(),
            2
        );
        let _mutation = manager
            .acquire_session_mutation(&session.session_id)
            .await
            .expect("transcript mutation");
        assert_eq!(
            manager
                .load_persisted_transcript_turns_locked(&session.session_id)
                .await
                .expect("transcript should load")
                .expect("transcript should be persisted")
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn rollback_context_failure_preserves_turn_history() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Rollback failure".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];

        let error = manager
            .rollback_context_to_turn_start(workspace.path(), &session.session_id, 1)
            .await
            .expect_err("missing context snapshot must fail rollback");

        assert!(error.to_string().contains("context snapshot"), "{error}");
        assert_eq!(
            manager
                .get_session(&session.session_id)
                .expect("session remains loaded")
                .dialog_turn_ids,
            vec!["turn-0".to_string(), "turn-1".to_string()]
        );
        assert_eq!(
            persistence_manager
                .load_session_turns(workspace.path(), &session.session_id)
                .await
                .expect("turns should remain")
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn rollback_context_waits_for_the_session_mutation_boundary() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager.clone()));
        let session = manager
            .create_session(
                "Serialized rollback".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session.session_id.clone(),
            UserMessageData {
                id: "turn-0-user".to_string(),
                content: "prompt".to_string(),
                timestamp: 0,
                metadata: None,
            },
        );
        persistence_manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string()];

        let mutation = manager
            .acquire_session_mutation(&session.session_id)
            .await
            .expect("hold mutation boundary");
        let rollback_manager = manager.clone();
        let rollback_workspace = workspace.path().to_path_buf();
        let rollback_session_id = session.session_id.clone();
        let rollback = tokio::spawn(async move {
            rollback_manager
                .rollback_context_to_turn_start(&rollback_workspace, &rollback_session_id, 0)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!rollback.is_finished());

        drop(mutation);
        rollback
            .await
            .expect("rollback task should join")
            .expect("rollback should succeed after mutation releases");
        assert!(persistence_manager
            .load_session_turns(workspace.path(), &session.session_id)
            .await
            .expect("turns should load")
            .is_empty());
    }

    #[tokio::test]
    async fn latest_skill_agent_snapshot_scans_persistence_beyond_stale_cache_hit() {
        use crate::agentic::skill_agent_snapshot::{
            AgentSnapshotEntry, SkillSnapshotEntry, TurnSkillAgentSnapshot,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Skill agent snapshot".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .remember_turn_skill_agent_snapshot(
                &session.session_id,
                0,
                TurnSkillAgentSnapshot {
                    skills: vec![SkillSnapshotEntry {
                        name: "skill-a".to_string(),
                        description: "desc-a".to_string(),
                        location: "/a".to_string(),
                    }],
                    subagents: vec![AgentSnapshotEntry {
                        id: "agent-a".to_string(),
                        description: "desc-a".to_string(),
                        default_tools: vec!["Read".to_string()],
                    }],
                },
            )
            .await;
        manager
            .remember_turn_skill_agent_snapshot(
                &session.session_id,
                1,
                TurnSkillAgentSnapshot {
                    skills: vec![SkillSnapshotEntry {
                        name: "skill-a".to_string(),
                        description: "desc-a".to_string(),
                        location: "/a".to_string(),
                    }],
                    subagents: vec![AgentSnapshotEntry {
                        id: "agent-b".to_string(),
                        description: "desc-b".to_string(),
                        default_tools: vec!["Read".to_string(), "Grep".to_string()],
                    }],
                },
            )
            .await;

        manager
            .turn_skill_agent_snapshot_store
            .delete_session(&session.session_id);
        manager
            .turn_skill_agent_snapshot_store
            .create_session(&session.session_id);
        manager.turn_skill_agent_snapshot_store.set_snapshot(
            &session.session_id,
            0,
            TurnSkillAgentSnapshot {
                skills: vec![SkillSnapshotEntry {
                    name: "skill-a".to_string(),
                    description: "desc-a".to_string(),
                    location: "/a".to_string(),
                }],
                subagents: vec![AgentSnapshotEntry {
                    id: "agent-a".to_string(),
                    description: "desc-a".to_string(),
                    default_tools: vec!["Read".to_string()],
                }],
            },
        );

        let latest = manager
            .latest_turn_skill_agent_snapshot_at_or_before(&session.session_id, 1)
            .await
            .expect("latest snapshot should exist");

        assert_eq!(latest.0, 1);
        assert_eq!(latest.1.subagents[0].id, "agent-b");
    }

    #[tokio::test]
    async fn rebuild_skill_agent_listing_baseline_to_latest_removes_listing_diff_reminders() {
        use crate::agentic::core::{InternalReminderKind, Message, MessageSemanticKind};
        use crate::agentic::skill_agent_snapshot::{SkillSnapshotEntry, TurnSkillAgentSnapshot};

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Listing baseline rebuild".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        {
            let mut active = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("session should be active");
            active.dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];
        }

        manager.context_store.replace_context(
            &session.session_id,
            vec![
                Message::internal_reminder(
                    InternalReminderKind::SkillListingDiff,
                    "# Skill Listing Update\n\nChanged",
                )
                .with_turn_id("turn-1".to_string()),
                Message::internal_reminder(
                    InternalReminderKind::AgentListingDiff,
                    "# Agent Listing Update\n\nChanged",
                )
                .with_turn_id("turn-1".to_string()),
                Message::user("real question".to_string())
                    .with_turn_id("turn-1".to_string())
                    .with_semantic_kind(MessageSemanticKind::ActualUserInput),
            ],
        );

        manager
            .remember_turn_skill_agent_snapshot(
                &session.session_id,
                0,
                TurnSkillAgentSnapshot {
                    skills: vec![SkillSnapshotEntry {
                        name: "old-skill".to_string(),
                        description: "old".to_string(),
                        location: "/old".to_string(),
                    }],
                    ..Default::default()
                },
            )
            .await;
        manager
            .remember_turn_skill_agent_snapshot(
                &session.session_id,
                1,
                TurnSkillAgentSnapshot {
                    skills: vec![SkillSnapshotEntry {
                        name: "new-skill".to_string(),
                        description: "new".to_string(),
                        location: "/new".to_string(),
                    }],
                    ..Default::default()
                },
            )
            .await;

        assert!(
            manager
                .rebuild_skill_agent_listing_baseline_to_latest(&session.session_id)
                .await
        );

        let context_messages = manager
            .context_store
            .get_context_messages(&session.session_id);
        assert_eq!(context_messages.len(), 1);
        assert_eq!(
            context_messages[0].metadata.semantic_kind,
            Some(MessageSemanticKind::ActualUserInput)
        );

        let baseline = manager
            .turn_skill_agent_snapshot(&session.session_id, 0)
            .await
            .expect("baseline snapshot should exist");
        assert_eq!(baseline.skills[0].name, "new-skill");
        assert!(manager
            .turn_skill_agent_snapshot(&session.session_id, 1)
            .await
            .is_none());

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata lookup should succeed")
            .expect("metadata should exist");
        assert_eq!(
            SessionManager::listing_baseline_rebuild_turn_index_from_metadata(Some(&metadata)),
            Some(1)
        );
    }

    #[tokio::test]
    async fn restore_session_sanitizes_pre_cutoff_listing_diff_snapshot() {
        use crate::agentic::core::{InternalReminderKind, Message, MessageSemanticKind};

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new_with_id(
            session_id.clone(),
            "Restore sanitize".to_string(),
            "Standard".to_string(),
            SessionConfig {
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        session.dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];

        persistence_manager
            .save_session(workspace.path(), &session)
            .await
            .expect("session should save");

        let mut metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session_id)
            .await
            .expect("metadata load should succeed")
            .expect("metadata should exist");
        metadata.custom_metadata = Some(json!({
            super::LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY: 2,
        }));
        persistence_manager
            .save_session_metadata(workspace.path(), &metadata)
            .await
            .expect("metadata should save");

        for index in 0..=1 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session_id,
                1,
                &[
                    Message::internal_reminder(
                        InternalReminderKind::SkillListingDiff,
                        "# Skill Listing Update\n\nChanged",
                    )
                    .with_turn_id("turn-1".to_string()),
                    Message::user("prompt 1".to_string())
                        .with_turn_id("turn-1".to_string())
                        .with_semantic_kind(MessageSemanticKind::ActualUserInput),
                ],
            )
            .await
            .expect("snapshot should save");

        let restored = manager
            .restore_session(workspace.path(), &session_id)
            .await
            .expect("session should restore");

        assert_eq!(
            restored.dialog_turn_ids,
            vec!["turn-0".to_string(), "turn-1".to_string()]
        );
        let context_messages = manager.context_store.get_context_messages(&session_id);
        assert_eq!(context_messages.len(), 1);
        assert_eq!(
            context_messages[0].metadata.semantic_kind,
            Some(MessageSemanticKind::ActualUserInput)
        );

        let sanitized_snapshot = persistence_manager
            .load_turn_context_snapshot(workspace.path(), &session_id, 1)
            .await
            .expect("snapshot load should succeed")
            .expect("snapshot should still exist");
        assert_eq!(sanitized_snapshot.len(), 1);
        assert_eq!(
            sanitized_snapshot[0].metadata.semantic_kind,
            Some(MessageSemanticKind::ActualUserInput)
        );
    }

    #[tokio::test]
    async fn rollback_sanitizes_pre_cutoff_snapshot_and_truncates_cutoff() {
        use crate::agentic::core::{InternalReminderKind, Message, MessageSemanticKind};

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Rollback sanitize".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..=2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
        }

        {
            let mut active = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("session should be active");
            active.dialog_turn_ids = vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string(),
            ];
        }

        manager
            .merge_session_custom_metadata(
                &session.session_id,
                json!({
                    super::LISTING_BASELINE_REBUILD_TURN_INDEX_METADATA_KEY: 2,
                }),
            )
            .await
            .expect("cutoff metadata should save");

        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session.session_id,
                0,
                &[
                    Message::internal_reminder(
                        InternalReminderKind::AgentListingDiff,
                        "# Agent Listing Update\n\nChanged",
                    )
                    .with_turn_id("turn-0".to_string()),
                    Message::user("prompt 0".to_string())
                        .with_turn_id("turn-0".to_string())
                        .with_semantic_kind(MessageSemanticKind::ActualUserInput),
                ],
            )
            .await
            .expect("snapshot 0 should save");
        persistence_manager
            .save_turn_context_snapshot(
                workspace.path(),
                &session.session_id,
                1,
                &[
                    Message::user("prompt 0".to_string()),
                    Message::user("prompt 1".to_string()),
                ],
            )
            .await
            .expect("snapshot 1 should save");

        manager
            .rollback_context_to_turn_start(workspace.path(), &session.session_id, 1)
            .await
            .expect("rollback should succeed");

        let context_messages = manager
            .context_store
            .get_context_messages(&session.session_id);
        assert_eq!(context_messages.len(), 1);
        assert_eq!(
            context_messages[0].metadata.semantic_kind,
            Some(MessageSemanticKind::ActualUserInput)
        );

        let sanitized_snapshot = persistence_manager
            .load_turn_context_snapshot(workspace.path(), &session.session_id, 0)
            .await
            .expect("snapshot 0 load should succeed")
            .expect("snapshot 0 should still exist");
        assert_eq!(sanitized_snapshot.len(), 1);
        assert_eq!(
            sanitized_snapshot[0].metadata.semantic_kind,
            Some(MessageSemanticKind::ActualUserInput)
        );

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata load should succeed")
            .expect("metadata should exist");
        assert_eq!(
            SessionManager::listing_baseline_rebuild_turn_index_from_metadata(Some(&metadata)),
            Some(1)
        );
    }

    #[tokio::test]
    async fn rollback_to_empty_history_clears_last_user_dialog_agent_type() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Rollback empty history".to_string(),
                "Cowork".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let mut turn = DialogTurnData::new(
            "turn-0".to_string(),
            0,
            session.session_id.clone(),
            UserMessageData {
                id: "turn-0-user".to_string(),
                content: "plan prompt".to_string(),
                timestamp: 0,
                metadata: None,
            },
        );
        turn.agent_type = Some("Cowork".to_string());
        persistence_manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");

        {
            let mut active = manager
                .sessions
                .get_mut(&session.session_id)
                .expect("session should be active");
            active.dialog_turn_ids = vec!["turn-0".to_string()];
            active.last_user_dialog_agent_type = Some("Cowork".to_string());
        }

        manager
            .rollback_context_to_turn_start(workspace.path(), &session.session_id, 0)
            .await
            .expect("rollback should succeed");

        let active = manager
            .get_session(&session.session_id)
            .expect("session should remain in memory");
        assert_eq!(active.agent_type, "Cowork");
        assert_eq!(active.last_user_dialog_agent_type, None);
    }

    #[tokio::test]
    async fn delete_session_removes_workspace_cache_entry() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Cached session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let session_storage_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        assert!(session_storage_dir.exists());
        let expected_storage_path =
            SessionManager::normalize_session_storage_path(&session_storage_dir);

        assert_eq!(
            manager
                .session_storage_path_index
                .get(&session.session_id)
                .as_deref()
                .map(|entry| entry.path.clone()),
            Some(expected_storage_path)
        );

        manager
            .delete_session(workspace.path(), &session.session_id)
            .await
            .expect("session should delete");

        assert!(manager
            .session_storage_path_index
            .get(&session.session_id)
            .is_none());
    }

    #[tokio::test]
    async fn delete_session_accepts_an_already_resolved_sessions_directory() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let resolved_sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Resolved storage session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        manager
            .delete_session(&resolved_sessions_dir, &session.session_id)
            .await
            .expect("resolved sessions path should be idempotent");

        assert!(manager.get_session(&session.session_id).is_none());
        assert!(!resolved_sessions_dir.join(&session.session_id).exists());
    }

    #[tokio::test]
    async fn evicted_session_uses_persisted_workspace_identity_for_snapshot_cleanup() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let resolved_sessions_dir = persistence_manager
            .path_manager()
            .project_sessions_dir(workspace.path());
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Evicted cleanup session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        manager.evict_loaded_session_for_test(&session.session_id);

        let cleanup_workspace_path = manager
            .resolve_session_cleanup_workspace_path(
                &resolved_sessions_dir,
                &session.session_id,
                &resolved_sessions_dir,
            )
            .await;

        assert_eq!(
            dunce::canonicalize(cleanup_workspace_path).expect("cleanup workspace should exist"),
            dunce::canonicalize(workspace.path()).expect("workspace should exist")
        );
    }

    #[tokio::test]
    async fn delete_session_rejects_a_loaded_session_from_another_workspace() {
        let workspace = TestWorkspace::new();
        let other_workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Bound session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        let error = manager
            .delete_session(other_workspace.path(), &session.session_id)
            .await
            .expect_err("cross-workspace deletion must be rejected");

        assert!(error.to_string().contains("another workspace"));
        assert!(manager.get_session(&session.session_id).is_some());
        assert!(manager
            .session_storage_path_index
            .contains_key(&session.session_id));
    }

    #[tokio::test]
    async fn persistence_delete_failure_preserves_loaded_runtime_context() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Failure atomic session".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        manager.context_store.add_message(
            &session.session_id,
            Message::user("runtime context must survive".to_string()),
        );
        let storage_path = manager
            .session_storage_path_index
            .get(&session.session_id)
            .expect("storage binding")
            .path
            .clone();
        let index_path = storage_path.join("index.json");
        std::fs::remove_file(&index_path).expect("replace index file");
        std::fs::create_dir(&index_path).expect("create invalid index directory");

        manager
            .delete_session(workspace.path(), &session.session_id)
            .await
            .expect_err("persistence failure should abort runtime cleanup");

        assert!(manager.get_session(&session.session_id).is_some());
        assert_eq!(
            manager
                .context_store
                .get_context_messages(&session.session_id)
                .len(),
            1
        );
        assert!(manager
            .session_storage_path_index
            .contains_key(&session.session_id));
    }

    #[tokio::test]
    async fn direct_delete_rejects_an_unfinished_revert_transition() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Pending revert delete".to_string(),
                "agent".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 0,
            original_turn_end: 1,
            phase: SessionRevertPhase::Applying,
            workspace_checkpoint: Vec::new(),
        };
        persistence_manager
            .save_session_revert_state(workspace.path(), &session.session_id, &state)
            .await
            .expect("pending marker should persist");

        let error = manager
            .delete_session(workspace.path(), &session.session_id)
            .await
            .expect_err("direct deletion must not discard recovery state");

        assert!(matches!(error, OpenBitFunError::OutcomeUnknown(_)));
        assert!(manager.get_session(&session.session_id).is_some());
        assert_eq!(
            persistence_manager
                .load_session_revert_state(workspace.path(), &session.session_id)
                .await
                .expect("marker load"),
            Some(state)
        );
    }

    #[test]
    fn build_messages_from_turns_skips_model_invisible_turns() {
        use crate::service::session::{DialogTurnData, DialogTurnKind, UserMessageData};

        let turns = vec![
            DialogTurnData::new(
                "turn-1".to_string(),
                0,
                "session-1".to_string(),
                UserMessageData {
                    id: "user-1".to_string(),
                    content: "hello".to_string(),
                    timestamp: 1,
                    metadata: None,
                },
            ),
            DialogTurnData::new_with_kind(
                DialogTurnKind::ManualCompaction,
                "turn-2".to_string(),
                1,
                "session-1".to_string(),
                None,
                UserMessageData {
                    id: "user-2".to_string(),
                    content: "/compact".to_string(),
                    timestamp: 2,
                    metadata: None,
                },
            ),
            DialogTurnData::new_with_kind(
                DialogTurnKind::LocalCommand,
                "turn-3".to_string(),
                2,
                "session-1".to_string(),
                None,
                UserMessageData {
                    id: "user-3".to_string(),
                    content: "# Session Usage Report".to_string(),
                    timestamp: 3,
                    metadata: Some(serde_json::json!({
                        "localCommandKind": "usage_report",
                        "modelVisible": false
                    })),
                },
            ),
        ];

        let messages = SessionManager::build_messages_from_turns(&turns);

        assert_eq!(messages.len(), 1);
        assert!(messages[0].is_actual_user_message());
    }

    #[test]
    fn fallback_session_title_uses_sentence_break_when_available() {
        let title = SessionManager::fallback_session_title(
            "Fix the flaky integration test. Add logging for retries.",
            20,
        );

        assert_eq!(title, "Fix the flaky...");
    }

    #[test]
    fn fallback_session_title_appends_ellipsis_when_truncated_without_sentence_break() {
        let title = SessionManager::fallback_session_title(
            "Implement session title generation fallback",
            12,
        );

        assert_eq!(title, "Implement...");
    }

    #[test]
    fn fallback_session_title_uses_default_for_blank_input() {
        let title = SessionManager::fallback_session_title("   ", 20);

        assert_eq!(title, "New Session");
    }

    #[tokio::test]
    async fn records_subagent_partial_timeout_in_evidence_ledger() {
        let persistence_manager =
            Arc::new(PersistenceManager::new(test_path_manager()).expect("persistence manager"));
        let manager = test_manager(persistence_manager);

        let event = manager
            .record_subagent_partial_timeout(
                "session-a",
                "turn-a",
                "ReviewSecurity",
                "Found token logging before timeout.",
                Some("timeout"),
            )
            .await
            .expect("in-memory evidence should record");

        assert!(!event.event_id.is_empty());
        let events = manager.evidence_events_for_turn("session-a", "turn-a");
        assert_eq!(events, vec![event.clone()]);
        let summary = manager.evidence_summary_for_session("session-a", 10);
        assert_eq!(summary.partial_subagent_results.len(), 1);
        assert_eq!(summary.partial_subagent_results[0].event_id, event.event_id);
    }

    #[tokio::test]
    async fn evidence_ledger_persists_across_session_unload_and_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Durable evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        let turn = DialogTurnData::new(
            "turn-a".to_string(),
            0,
            session.session_id.clone(),
            UserMessageData {
                id: "turn-a-user".to_string(),
                content: "continue".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        persistence_manager
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("turn should save");
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-a".to_string()];
        let event = manager
            .record_checkpoint_created(
                &session.session_id,
                "turn-a",
                "Edit",
                "src/lib.rs",
                EvidenceLedgerCheckpoint {
                    current_branch: Some("feature/evidence".to_string()),
                    dirty_state_summary: "staged=0, unstaged=1, untracked=0".to_string(),
                    touched_files: vec!["src/lib.rs".to_string()],
                    diff_hash: Some("abc123".to_string()),
                },
            )
            .await
            .expect("checkpoint should persist before mutation");
        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(&ledger_path).expect("ledger sidecar should exist"),
        )
        .expect("ledger sidecar should deserialize");
        assert_eq!(stored.session_id, session.session_id);
        assert_eq!(stored.events, vec![event.clone()]);

        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-a")
            .is_empty());

        manager
            .restore_session_from_storage_path(&storage_path, &session.session_id)
            .await
            .expect("session should restore with evidence");
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-a"),
            vec![event]
        );
        let summary = manager.evidence_summary_for_session(&session.session_id, 10);
        assert_eq!(summary.latest_checkpoints.len(), 1);
        assert_eq!(summary.latest_checkpoints[0].target, "src/lib.rs");
    }

    fn evidence_event_ids(ledger_path: &std::path::Path) -> Vec<String> {
        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(ledger_path).expect("ledger sidecar should exist"),
        )
        .expect("ledger sidecar should deserialize");
        stored
            .events
            .iter()
            .map(|event| event.event_id.clone())
            .collect()
    }

    struct StagedEvidenceSession {
        session_id: String,
        ledger_path: PathBuf,
    }

    async fn create_staged_evidence_session(
        manager: &SessionManager,
        persistence_manager: &PersistenceManager,
        workspace: &TestWorkspace,
        turn_count: usize,
    ) -> StagedEvidenceSession {
        let session = manager
            .create_session(
                "Staged evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        for index in 0..turn_count {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|message_index| {
                    crate::agentic::core::Message::user(format!("prompt {message_index}"))
                })
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("context snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = (0..turn_count)
            .map(|index| format!("turn-{index}"))
            .collect();
        for index in 0..turn_count {
            manager
                .record_subagent_partial_timeout(
                    &session.session_id,
                    &format!("turn-{index}"),
                    "ReviewSecurity",
                    &format!("Partial turn {index}"),
                    Some("timeout"),
                )
                .await
                .expect("turn evidence should persist");
        }
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        StagedEvidenceSession {
            session_id: session.session_id,
            ledger_path,
        }
    }

    #[tokio::test]
    async fn staged_revert_filters_memory_but_keeps_evidence_sidecar() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Staged revert evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..3 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|message_index| {
                    crate::agentic::core::Message::user(format!("prompt {message_index}"))
                })
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("context snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec![
            "turn-0".to_string(),
            "turn-1".to_string(),
            "turn-2".to_string(),
        ];
        let turn_0_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-0",
                "ReviewSecurity",
                "Partial turn 0",
                Some("timeout"),
            )
            .await
            .expect("turn-0 evidence should persist");
        let turn_1_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-1",
                "ReviewTests",
                "Partial turn 1",
                Some("timeout"),
            )
            .await
            .expect("turn-1 evidence should persist");
        let turn_2_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-2",
                "Edit",
                "Partial turn 2",
                Some("timeout"),
            )
            .await
            .expect("turn-2 evidence should persist");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let stored_before: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(&ledger_path).expect("ledger sidecar should exist"),
        )
        .expect("ledger sidecar should deserialize");
        assert_eq!(
            stored_before
                .events
                .iter()
                .map(|event| event.event_id.clone())
                .collect::<Vec<_>>(),
            vec![
                turn_0_event.event_id.clone(),
                turn_1_event.event_id.clone(),
                turn_2_event.event_id.clone(),
            ]
        );

        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 2,
            original_turn_end: 3,
            phase: SessionRevertPhase::Staged,
            workspace_checkpoint: Vec::new(),
        };
        persistence_manager
            .save_session_revert_state(workspace.path(), &session.session_id, &state)
            .await
            .expect("staged revert should persist");

        manager
            .apply_staged_revert_context_locked(
                workspace.path(),
                &session.session_id,
                state.boundary_turn,
            )
            .await
            .expect("staged context should apply");

        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-2")
            .is_empty());
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-1"),
            vec![turn_1_event.clone()]
        );
        let stored_after: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(&ledger_path).expect("ledger sidecar should still exist"),
        )
        .expect("ledger sidecar should deserialize");
        assert_eq!(
            stored_after.events,
            vec![
                turn_0_event.clone(),
                turn_1_event.clone(),
                turn_2_event.clone()
            ]
        );

        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("staged session should restore");
        assert_eq!(
            restored.dialog_turn_ids,
            vec!["turn-0".to_string(), "turn-1".to_string()]
        );
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-1"),
            vec![turn_1_event.clone()]
        );
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-2")
            .is_empty());
        assert_eq!(
            evidence_event_ids(&ledger_path),
            vec![
                turn_0_event.event_id.clone(),
                turn_1_event.event_id.clone(),
                turn_2_event.event_id.clone(),
            ]
        );
        assert_eq!(
            manager
                .evidence_summary_for_session(&session.session_id, 10)
                .partial_subagent_results
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn staged_undo_then_redo_restores_evidence_from_sidecar() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let staged =
            create_staged_evidence_session(&manager, &persistence_manager, &workspace, 3).await;
        let original_ledger = evidence_event_ids(&staged.ledger_path);
        assert_eq!(original_ledger.len(), 3);

        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 2,
            original_turn_end: 3,
            phase: SessionRevertPhase::Staged,
            workspace_checkpoint: Vec::new(),
        };
        persistence_manager
            .save_session_revert_state(workspace.path(), &staged.session_id, &state)
            .await
            .expect("staged undo should persist");
        let _mutation = manager
            .acquire_session_mutation(&staged.session_id)
            .await
            .expect("session mutation");
        manager
            .apply_staged_revert_context_locked(
                workspace.path(),
                &staged.session_id,
                state.boundary_turn,
            )
            .await
            .expect("staged undo should apply");
        assert!(manager
            .evidence_events_for_turn(&staged.session_id, "turn-2")
            .is_empty());
        assert_eq!(evidence_event_ids(&staged.ledger_path), original_ledger);

        // Redo clears the staged boundary back to the original end. The intact
        // sidecar must repopulate memory with the hidden turn evidence.
        manager
            .apply_staged_revert_context_locked(
                workspace.path(),
                &staged.session_id,
                state.original_turn_end,
            )
            .await
            .expect("redo should reapply the full boundary");
        assert_eq!(
            manager
                .evidence_events_for_turn(&staged.session_id, "turn-2")
                .len(),
            1
        );
        persistence_manager
            .delete_session_revert_state(workspace.path(), &staged.session_id)
            .await
            .expect("redo marker should clear");
        assert_eq!(
            manager
                .get_session(&staged.session_id)
                .expect("session should remain active")
                .dialog_turn_ids,
            vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string()
            ]
        );
        assert_eq!(evidence_event_ids(&staged.ledger_path), original_ledger);
        assert_eq!(
            manager
                .evidence_summary_for_session(&staged.session_id, 10)
                .partial_subagent_results
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn consecutive_staged_undo_and_redo_keep_sidecar_evidence() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let staged =
            create_staged_evidence_session(&manager, &persistence_manager, &workspace, 3).await;
        let original_ledger = evidence_event_ids(&staged.ledger_path);
        assert_eq!(original_ledger.len(), 3);
        let _mutation = manager
            .acquire_session_mutation(&staged.session_id)
            .await
            .expect("session mutation");

        for boundary in [2usize, 1, 0] {
            let state = SessionRevertState {
                schema_version: SESSION_REVERT_SCHEMA_VERSION,
                boundary_turn: boundary,
                original_turn_end: 3,
                phase: SessionRevertPhase::Staged,
                workspace_checkpoint: Vec::new(),
            };
            persistence_manager
                .save_session_revert_state(workspace.path(), &staged.session_id, &state)
                .await
                .expect("staged undo should persist");
            manager
                .apply_staged_revert_context_locked(workspace.path(), &staged.session_id, boundary)
                .await
                .expect("staged undo should apply");
        }
        assert!(manager
            .evidence_events_for_turn(&staged.session_id, "turn-2")
            .is_empty());
        assert!(manager
            .evidence_events_for_turn(&staged.session_id, "turn-1")
            .is_empty());
        assert_eq!(evidence_event_ids(&staged.ledger_path), original_ledger);

        for boundary in [1usize, 2, 3] {
            let state = SessionRevertState {
                schema_version: SESSION_REVERT_SCHEMA_VERSION,
                boundary_turn: boundary,
                original_turn_end: 3,
                phase: SessionRevertPhase::Staged,
                workspace_checkpoint: Vec::new(),
            };
            persistence_manager
                .save_session_revert_state(workspace.path(), &staged.session_id, &state)
                .await
                .expect("staged redo should persist");
            manager
                .apply_staged_revert_context_locked(workspace.path(), &staged.session_id, boundary)
                .await
                .expect("staged redo should apply");
        }
        persistence_manager
            .delete_session_revert_state(workspace.path(), &staged.session_id)
            .await
            .expect("redo marker should clear");
        assert_eq!(
            manager
                .get_session(&staged.session_id)
                .expect("session should remain active")
                .dialog_turn_ids,
            vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string()
            ]
        );
        assert_eq!(evidence_event_ids(&staged.ledger_path), original_ledger);
        assert_eq!(
            manager
                .evidence_events_for_turn(&staged.session_id, "turn-2")
                .len(),
            1
        );
        assert_eq!(
            manager
                .evidence_events_for_turn(&staged.session_id, "turn-1")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn restoring_clearing_phase_keeps_redo_evidence_available() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let staged =
            create_staged_evidence_session(&manager, &persistence_manager, &workspace, 3).await;
        let original_ledger = evidence_event_ids(&staged.ledger_path);
        assert_eq!(original_ledger.len(), 3);

        let state = SessionRevertState {
            schema_version: SESSION_REVERT_SCHEMA_VERSION,
            boundary_turn: 3,
            original_turn_end: 3,
            phase: SessionRevertPhase::Clearing,
            workspace_checkpoint: Vec::new(),
        };
        persistence_manager
            .save_session_revert_state(workspace.path(), &staged.session_id, &state)
            .await
            .expect("clearing marker should persist");
        assert!(manager
            .unload_session_from_memory(&staged.session_id)
            .await
            .expect("session should unload"));

        manager
            .restore_session(workspace.path(), &staged.session_id)
            .await
            .expect("clearing session should restore");
        let _mutation = manager
            .acquire_session_mutation(&staged.session_id)
            .await
            .expect("session mutation");
        manager
            .apply_staged_revert_context_locked(
                workspace.path(),
                &staged.session_id,
                state.boundary_turn,
            )
            .await
            .expect("clearing boundary should reapply");
        persistence_manager
            .delete_session_revert_state(workspace.path(), &staged.session_id)
            .await
            .expect("clearing marker should clear");
        assert_eq!(
            manager
                .get_session(&staged.session_id)
                .expect("session should restore")
                .dialog_turn_ids,
            vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string()
            ]
        );
        assert_eq!(
            manager
                .evidence_events_for_turn(&staged.session_id, "turn-2")
                .len(),
            1
        );
        assert_eq!(evidence_event_ids(&staged.ledger_path), original_ledger);
        assert_eq!(
            manager
                .evidence_summary_for_session(&staged.session_id, 10)
                .partial_subagent_results
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn staged_revert_prunes_evidence_sidecar_without_automatic_persistence() {
        use crate::agentic::session::revert::{
            SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let writer = test_manager(persistence_manager.clone());
        let session = writer
            .create_session(
                "Staged revert explicit history evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|message_index| {
                    crate::agentic::core::Message::user(format!("prompt {message_index}"))
                })
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("context snapshot should save");
        }
        writer
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];
        let turn_0_event = writer
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-0",
                "ReviewSecurity",
                "Partial turn 0",
                Some("timeout"),
            )
            .await
            .expect("turn-0 evidence should persist");
        let _turn_1_event = writer
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-1",
                "ReviewTests",
                "Partial turn 1",
                Some("timeout"),
            )
            .await
            .expect("turn-1 evidence should persist");
        let storage_path = writer
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        persistence_manager
            .save_session_revert_state(
                workspace.path(),
                &session.session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: SessionRevertPhase::Committing,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("staged revert should persist");
        assert!(writer
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));

        let manager = test_manager_with_config(
            persistence_manager.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        );
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("explicit history should restore");
        assert_eq!(restored.dialog_turn_ids, vec!["turn-0".to_string()]);
        manager
            .commit_staged_revert_context_locked(&storage_path, &session.session_id, 1)
            .await
            .expect("staged revert should commit without automatic persistence");

        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(
                storage_path
                    .join(&session.session_id)
                    .join("evidence-ledger.json"),
            )
            .expect("ledger sidecar should still exist"),
        )
        .expect("ledger sidecar should deserialize");
        assert_eq!(stored.events, vec![turn_0_event.clone()]);
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-0"),
            vec![turn_0_event]
        );
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-1")
            .is_empty());
        assert_eq!(
            manager
                .evidence_summary_for_session(&session.session_id, 10)
                .partial_subagent_results
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_rollback_prunes_evidence_ledger_to_surviving_turn_ids() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Rollback evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");

        for index in 0..2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|message_index| {
                    crate::agentic::core::Message::user(format!("prompt {message_index}"))
                })
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("context snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];
        let turn_0_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-0",
                "ReviewSecurity",
                "Partial turn 0",
                Some("timeout"),
            )
            .await
            .expect("turn-0 evidence should persist");
        let _turn_1_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-1",
                "ReviewTests",
                "Partial turn 1",
                Some("timeout"),
            )
            .await
            .expect("turn-1 evidence should persist");

        manager
            .rollback_context_to_turn_start(workspace.path(), &session.session_id, 1)
            .await
            .expect("rollback should succeed");

        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-1")
            .is_empty());
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-0"),
            vec![turn_0_event.clone()]
        );
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(
                storage_path
                    .join(&session.session_id)
                    .join("evidence-ledger.json"),
            )
            .expect("ledger sidecar should exist"),
        )
        .expect("ledger sidecar should deserialize");
        assert_eq!(stored.events, vec![turn_0_event.clone()]);

        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));
        let restored = manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("rolled-back session should restore");
        assert_eq!(restored.dialog_turn_ids, vec!["turn-0".to_string()]);
        assert_eq!(
            manager.evidence_events_for_turn(&session.session_id, "turn-0"),
            vec![turn_0_event]
        );
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-1")
            .is_empty());
        let contract = manager
            .compression_contract_for_session(&session.session_id, 10)
            .expect("compression contract should be available");
        assert!(
            contract
                .subagent_statuses
                .iter()
                .all(|item| item.target != "ReviewTests"),
            "rolled-back turn evidence must not enter the compression contract"
        );
        assert!(contract
            .subagent_statuses
            .iter()
            .any(|item| item.target == "ReviewSecurity"));
        assert_eq!(
            manager
                .evidence_summary_for_session(&session.session_id, 10)
                .partial_subagent_results
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn evidence_ledger_write_failure_does_not_publish_memory_only_evidence() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Evidence write failure".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        persistence_manager.fail_next_evidence_ledger_write_for_test(&session.session_id);

        manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-a",
                "ReviewSecurity",
                "Partial result",
                Some("timeout"),
            )
            .await
            .expect_err("durable append failure must be visible");

        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-a")
            .is_empty());
        assert!(manager
            .evidence_summary_for_session(&session.session_id, 10)
            .partial_subagent_results
            .is_empty());
    }

    #[tokio::test]
    async fn concurrent_evidence_appends_keep_disk_and_memory_complete() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = Arc::new(test_manager(persistence_manager));
        let session = manager
            .create_session(
                "Concurrent evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");

        let first_manager = manager.clone();
        let first_session_id = session.session_id.clone();
        let first = tokio::spawn(async move {
            first_manager
                .record_subagent_partial_timeout(
                    &first_session_id,
                    "turn-a",
                    "ReviewSecurity",
                    "First partial result",
                    Some("timeout"),
                )
                .await
                .expect("first evidence append")
        });
        let second_manager = manager.clone();
        let second_session_id = session.session_id.clone();
        let second = tokio::spawn(async move {
            second_manager
                .record_subagent_partial_timeout(
                    &second_session_id,
                    "turn-b",
                    "ReviewTests",
                    "Second partial result",
                    Some("timeout"),
                )
                .await
                .expect("second evidence append")
        });
        let first = first.await.expect("first append task");
        let second = second.await.expect("second append task");

        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(ledger_path).expect("ledger sidecar should exist"),
        )
        .expect("ledger sidecar should deserialize");
        let mut stored_ids = stored
            .events
            .into_iter()
            .map(|event| event.event_id)
            .collect::<Vec<_>>();
        let mut memory_ids = manager
            .evidence_ledger
            .events_for_session(&session.session_id)
            .into_iter()
            .map(|event| event.event_id)
            .collect::<Vec<_>>();
        let mut expected_ids = vec![first.event_id, second.event_id];
        stored_ids.sort();
        memory_ids.sort();
        expected_ids.sort();

        assert_eq!(stored_ids, expected_ids);
        assert_eq!(memory_ids, expected_ids);
    }

    #[tokio::test]
    async fn corrupt_evidence_ledger_blocks_restore_without_overwriting_original_bytes() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Corrupt evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");
        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let corrupt_bytes = b"{not valid evidence";
        std::fs::write(&ledger_path, corrupt_bytes).expect("corrupt fixture should write");
        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));

        manager
            .restore_session_from_storage_path(&storage_path, &session.session_id)
            .await
            .expect_err("corrupt evidence must not degrade to an empty ledger");

        assert!(manager.get_session(&session.session_id).is_none());
        assert_eq!(
            std::fs::read(&ledger_path).expect("corrupt sidecar should remain"),
            corrupt_bytes
        );
    }

    #[tokio::test]
    async fn corrupt_evidence_ledger_blocks_retention_without_overwriting_original_bytes() {
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Corrupt retention evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let ledger_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path")
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let corrupt_bytes = b"{not valid evidence";
        std::fs::write(&ledger_path, corrupt_bytes).expect("corrupt fixture should write");

        persistence_manager
            .retain_evidence_ledger_events(workspace.path(), &session.session_id, &HashSet::new())
            .await
            .expect_err("corrupt evidence must not degrade to an empty ledger");

        assert_eq!(
            std::fs::read(&ledger_path).expect("corrupt sidecar should remain"),
            corrupt_bytes
        );
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn remote_workspace_evidence_uses_the_resolved_session_mirror() {
        crate::service::workspace::legacy_compat::register_remote_fixture(
            "/home/wsp/project",
            "ssh-1",
            "dev-host",
        )
        .await;
        let workspace = TestWorkspace::new();
        let path_manager = workspace.path_manager();
        let persistence_manager =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let manager = test_manager(persistence_manager);
        let session = manager
            .create_session(
                "Remote evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some("/home/wsp/project".to_string()),
                    remote_connection_id: Some("ssh-1".to_string()),
                    remote_ssh_host: Some("dev-host".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("remote session should create");
        let event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-a",
                "ReviewSecurity",
                "Remote partial result",
                Some("timeout"),
            )
            .await
            .expect("remote evidence should persist");
        let sessions_dir = crate::service::WorkspaceRuntimeService::new(path_manager)
            .context_for_remote_workspace("dev-host", "/home/wsp/project")
            .sessions_dir;
        let ledger_path = sessions_dir
            .join(&session.session_id)
            .join("evidence-ledger.json");
        let stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(ledger_path).expect("remote ledger sidecar should exist"),
        )
        .expect("remote ledger sidecar should deserialize");

        assert_eq!(stored.events, vec![event]);
        assert_eq!(
            stored.events[0].target_kind,
            EvidenceLedgerTargetKind::Subagent
        );
        assert_eq!(
            stored.events[0].status,
            EvidenceLedgerEventStatus::PartialTimeout
        );
    }

    #[tokio::test]
    async fn restore_converges_evidence_sidecar_to_surviving_turns() {
        // P2 regression: after restore, the sidecar must be converged to the
        // surviving turns so a subsequent evidence append does not resurrect
        // stale events from a turn that no longer exists.
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Converge evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");

        // Create two turns with evidence.
        for index in 0..2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|i| crate::agentic::core::Message::user(format!("prompt {i}")))
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];
        for index in 0..2 {
            manager
                .record_subagent_partial_timeout(
                    &session.session_id,
                    &format!("turn-{index}"),
                    "ReviewSecurity",
                    &format!("Partial turn {index}"),
                    Some("timeout"),
                )
                .await
                .expect("evidence should persist");
        }
        let ledger_path = storage_path
            .join(&session.session_id)
            .join("evidence-ledger.json");
        assert_eq!(evidence_event_ids(&ledger_path).len(), 2);

        // Simulate an older build removing turn-1 from history but leaving
        // the evidence sidecar untouched.
        persistence_manager
            .delete_dialog_turns_from(workspace.path(), &session.session_id, 1)
            .await
            .expect("turn-1 should be deleted");
        persistence_manager
            .delete_turn_context_snapshots_from(workspace.path(), &session.session_id, 1)
            .await
            .expect("snapshot-1 should be deleted");

        // Unload and restore. The restore should converge the sidecar.
        assert!(manager
            .unload_session_from_memory(&session.session_id)
            .await
            .expect("session should unload"));
        manager
            .restore_session_from_storage_path(&storage_path, &session.session_id)
            .await
            .expect("session should restore");

        // The sidecar should now only contain turn-0's evidence.
        let sidecar_ids = evidence_event_ids(&ledger_path);
        assert_eq!(sidecar_ids.len(), 1);
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-1")
            .is_empty());

        // Appending new evidence must not resurrect turn-1's event.
        manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-0",
                "ReviewLogic",
                "New partial result",
                Some("timeout"),
            )
            .await
            .expect("new evidence should persist");
        let final_ids = evidence_event_ids(&ledger_path);
        assert_eq!(final_ids.len(), 2);
        assert!(manager
            .evidence_events_for_turn(&session.session_id, "turn-1")
            .is_empty());
        let summary = manager.evidence_summary_for_session(&session.session_id, 10);
        assert_eq!(summary.partial_subagent_results.len(), 2);
    }

    #[tokio::test]
    async fn branch_session_copies_evidence_ledger_for_inherited_turns() {
        // P1 regression: forking a session must copy the evidence ledger,
        // filtered to the copied turns and rewritten to the target session.
        let workspace = TestWorkspace::new();
        let persistence_manager = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Fork evidence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should create");
        let storage_path = manager
            .effective_session_storage_path(&session.session_id)
            .await
            .expect("storage path");

        // Create two turns with evidence.
        for index in 0..2 {
            let turn = DialogTurnData::new(
                format!("turn-{index}"),
                index,
                session.session_id.clone(),
                UserMessageData {
                    id: format!("turn-{index}-user"),
                    content: format!("prompt {index}"),
                    timestamp: index as u64,
                    metadata: None,
                },
            );
            persistence_manager
                .save_dialog_turn(workspace.path(), &turn)
                .await
                .expect("turn should save");
            let messages = (0..=index)
                .map(|i| crate::agentic::core::Message::user(format!("prompt {i}")))
                .collect::<Vec<_>>();
            persistence_manager
                .save_turn_context_snapshot(workspace.path(), &session.session_id, index, &messages)
                .await
                .expect("snapshot should save");
        }
        manager
            .sessions
            .get_mut(&session.session_id)
            .expect("session should be active")
            .dialog_turn_ids = vec!["turn-0".to_string(), "turn-1".to_string()];
        let turn_0_event = manager
            .record_checkpoint_created(
                &session.session_id,
                "turn-0",
                "Edit",
                "src/lib.rs",
                EvidenceLedgerCheckpoint {
                    current_branch: Some("feature/evidence".to_string()),
                    dirty_state_summary: "staged=0".to_string(),
                    touched_files: vec!["src/lib.rs".to_string()],
                    diff_hash: Some("abc".to_string()),
                },
            )
            .await
            .expect("turn-0 checkpoint should persist");
        let turn_1_event = manager
            .record_subagent_partial_timeout(
                &session.session_id,
                "turn-1",
                "ReviewSecurity",
                "Partial turn 1",
                Some("timeout"),
            )
            .await
            .expect("turn-1 evidence should persist");

        // Branch through turn-0 only.
        let branch_result = persistence_manager
            .branch_session(
                workspace.path(),
                &SessionBranchRequest {
                    source_session_id: session.session_id.clone(),
                    source_turn_id: "turn-0".to_string(),
                    boundary: SessionBranchBoundary::ThroughTurn,
                },
            )
            .await
            .expect("branch should succeed");

        // The fork should have turn-0's evidence but not turn-1's.
        let fork_ledger_path = storage_path
            .join(&branch_result.session_id)
            .join("evidence-ledger.json");
        assert!(
            fork_ledger_path.exists(),
            "fork evidence sidecar should exist"
        );
        let fork_stored: PersistedEvidenceLedgerFile = serde_json::from_slice(
            &std::fs::read(&fork_ledger_path).expect("fork ledger should read"),
        )
        .expect("fork ledger should deserialize");
        assert_eq!(fork_stored.session_id, branch_result.session_id);
        assert_eq!(fork_stored.events.len(), 1);
        assert_eq!(fork_stored.events[0].turn_id, "turn-0");
        assert_eq!(fork_stored.events[0].session_id, branch_result.session_id);
        assert_eq!(fork_stored.events[0].event_id, turn_0_event.event_id);
        // The checkpoint summary should be preserved.
        assert!(fork_stored.events[0].checkpoint.is_some());
        // turn-1's evidence must not be in the fork.
        assert!(fork_stored
            .events
            .iter()
            .all(|e| e.event_id != turn_1_event.event_id));
    }

    #[tokio::test]
    async fn prompt_cache_persists_across_session_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let workspace_path = workspace.path().to_string_lossy().to_string();
        let session = manager
            .create_session(
                "Prompt cache".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_path),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let identity = SystemPromptCacheIdentity::new("template:agentic_mode");
        let user_context_identity = UserContextCacheIdentity::new(
            "workspace_context|workspace_instructions|project_layout",
        );

        manager
            .remember_system_prompt(
                &session.session_id,
                identity.clone(),
                "cached system prompt".to_string(),
            )
            .await;
        manager
            .remember_user_context(
                &session.session_id,
                user_context_identity.clone(),
                "cached user context".to_string(),
            )
            .await;

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored_manager = test_manager(persistence_manager);
        restored_manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");

        assert_eq!(
            restored_manager
                .cached_system_prompt(&session.session_id, &identity)
                .await,
            Some("cached system prompt".to_string())
        );
        assert_eq!(
            restored_manager
                .cached_user_context(&session.session_id, &user_context_identity)
                .await,
            Some("cached user context".to_string())
        );
    }

    #[tokio::test]
    async fn skill_agent_baseline_override_snapshot_persists_across_session_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Listing baseline".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let baseline = TurnSkillAgentSnapshot {
            skills: vec![SkillSnapshotEntry {
                name: "skill-a".to_string(),
                description: "desc-a".to_string(),
                location: "/skills/a".to_string(),
            }],
            ..Default::default()
        };

        manager
            .remember_skill_agent_baseline_override_snapshot(&session.session_id, baseline.clone())
            .await;

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata load should succeed")
            .expect("metadata should exist");
        assert_eq!(metadata.custom_metadata, None);
        assert_eq!(
            persistence_manager
                .load_skill_agent_baseline_override_snapshot(workspace.path(), &session.session_id,)
                .await
                .expect("override snapshot load should succeed"),
            Some(baseline.clone())
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored_manager = test_manager(persistence_manager);
        restored_manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");

        assert_eq!(
            restored_manager
                .skill_agent_baseline_override_snapshot(&session.session_id)
                .await,
            Some(baseline)
        );
    }

    #[tokio::test]
    async fn edit_constraints_are_cached_and_inherited_by_forked_children() {
        use crate::agentic::execution::edit_constraint_guard::{
            ConstraintExtractionRecord, ConstraintMatcher, ConstraintOperationScope,
            ConstraintSource, ExtractedConstraint, ExtractionStatus, ModelExtractionStatus,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager);

        // Uncached: distinct from "cached but empty".
        assert_eq!(manager.edit_constraints("parent-session"), None);

        let constraints = vec![ExtractedConstraint {
            id: "test-files".to_string(),
            description: "don't modify test files".to_string(),
            operation_scope: ConstraintOperationScope::All,
            matcher: ConstraintMatcher::TestFiles,
            source: ConstraintSource::Legacy,
            source_text: None,
        }];
        manager
            .remember_edit_constraint_extraction(
                "parent-session",
                ConstraintExtractionRecord {
                    message_sha256: "message-hash".to_string(),
                    dialog_turn_id: Some("turn-1".to_string()),
                    status: ExtractionStatus::Extracted,
                    constraints: constraints.clone(),
                    deterministic_constraint_count: 0,
                    model_attempts: 1,
                    active_constraint_ids: Vec::new(),
                    revocation_authorized: true,
                    model_status: ModelExtractionStatus::Parsed,
                    model_constraints: constraints.clone(),
                    model_revocations: Vec::new(),
                    revoked_constraint_ids: Vec::new(),
                    unmatched_revocation_ids: Vec::new(),
                    input_chars: 10,
                    prompt_chars: 10,
                    input_truncated: false,
                    latency_ms: 1,
                    extracted_at_ms: 1,
                    failure: None,
                    response_excerpt: None,
                },
            )
            .await;
        assert_eq!(
            manager.edit_constraints("parent-session"),
            Some(constraints.clone())
        );
        manager
            .remember_edit_constraint_agent_created_paths(
                "parent-session",
                vec!["tests/parent_repro.rs".to_string()],
                "turn-1",
            )
            .await;

        // A forked child with no prior extraction inherits the parent's list.
        assert_eq!(manager.edit_constraints("child-session"), None);
        manager
            .seed_forked_edit_constraints("parent-session", "child-session")
            .await;
        assert_eq!(
            manager.edit_constraints("child-session"),
            Some(constraints.clone())
        );
        manager
            .rollback_edit_constraint_state_to_turns(
                "child-session",
                &std::collections::HashSet::new(),
            )
            .await;
        let child_state = manager
            .edit_constraint_state("child-session")
            .expect("forked state after rollback");
        assert_eq!(child_state.constraints, constraints);
        assert_eq!(
            child_state.agent_created_paths,
            vec!["tests/parent_repro.rs".to_string()]
        );

        // Seeding from a parent with no cached constraints is a no-op, not a panic.
        manager
            .seed_forked_edit_constraints("no-such-parent", "another-child")
            .await;
        assert_eq!(manager.edit_constraints("another-child"), None);
    }

    #[tokio::test]
    async fn edit_constraint_state_persists_across_session_restore() {
        use crate::agentic::execution::edit_constraint_guard::{
            ConstraintExtractionRecord, ConstraintMatcher, ConstraintOperationScope,
            ConstraintRevocation, ConstraintSource, ExtractedConstraint, ExtractionStatus,
            ModelExtractionStatus, EDIT_CONSTRAINT_METADATA_KEY,
        };

        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let session = manager
            .create_session(
                "Edit constraint persistence".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let constraint = ExtractedConstraint {
            id: "deterministic:test_files".to_string(),
            description: "do not modify tests".to_string(),
            operation_scope: ConstraintOperationScope::All,
            matcher: ConstraintMatcher::TestFiles,
            source: ConstraintSource::Deterministic,
            source_text: Some("Do not modify tests.".to_string()),
        };
        manager
            .remember_edit_constraint_extraction(
                &session.session_id,
                ConstraintExtractionRecord {
                    message_sha256: "message-hash".to_string(),
                    dialog_turn_id: Some("turn-1".to_string()),
                    status: ExtractionStatus::Extracted,
                    constraints: vec![constraint.clone()],
                    deterministic_constraint_count: 1,
                    model_attempts: 0,
                    active_constraint_ids: Vec::new(),
                    revocation_authorized: true,
                    model_status: ModelExtractionStatus::NotRun,
                    model_constraints: Vec::new(),
                    model_revocations: Vec::new(),
                    revoked_constraint_ids: Vec::new(),
                    unmatched_revocation_ids: Vec::new(),
                    input_chars: 20,
                    prompt_chars: 20,
                    input_truncated: false,
                    latency_ms: 1,
                    extracted_at_ms: 1,
                    failure: None,
                    response_excerpt: None,
                },
            )
            .await;
        manager
            .remember_edit_constraint_agent_created_paths(
                &session.session_id,
                vec!["tests/temporary-repro.rs".to_string()],
                "turn-1",
            )
            .await;
        manager
            .remember_edit_constraint_extraction(
                &session.session_id,
                ConstraintExtractionRecord {
                    message_sha256: "relaxation-hash".to_string(),
                    dialog_turn_id: Some("turn-2".to_string()),
                    status: ExtractionStatus::Extracted,
                    constraints: Vec::new(),
                    deterministic_constraint_count: 0,
                    model_attempts: 1,
                    active_constraint_ids: vec![constraint.id.clone()],
                    revocation_authorized: true,
                    model_status: ModelExtractionStatus::Parsed,
                    model_constraints: Vec::new(),
                    model_revocations: vec![ConstraintRevocation {
                        constraint_id: constraint.id.clone(),
                        description: "tests may be modified now".to_string(),
                    }],
                    revoked_constraint_ids: vec![constraint.id.clone()],
                    unmatched_revocation_ids: Vec::new(),
                    input_chars: 24,
                    prompt_chars: 24,
                    input_truncated: false,
                    latency_ms: 1,
                    extracted_at_ms: 2,
                    failure: None,
                    response_excerpt: None,
                },
            )
            .await;

        let metadata = persistence_manager
            .load_session_metadata(workspace.path(), &session.session_id)
            .await
            .expect("metadata load")
            .expect("metadata should exist");
        assert!(metadata
            .custom_metadata
            .as_ref()
            .and_then(|value| value.get(EDIT_CONSTRAINT_METADATA_KEY))
            .is_some());

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored_manager = test_manager(persistence_manager);
        restored_manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");
        assert_eq!(
            restored_manager.edit_constraints(&session.session_id),
            Some(Vec::new())
        );
        let restored_state = restored_manager
            .edit_constraint_state(&session.session_id)
            .expect("constraint state should restore");
        assert_eq!(restored_state.extractions.len(), 2);
        assert_eq!(
            restored_state.extractions[1].revoked_constraint_ids,
            vec![constraint.id]
        );
        assert_eq!(
            restored_state.agent_created_paths,
            vec!["tests/temporary-repro.rs".to_string()]
        );
    }

    #[tokio::test]
    async fn seed_forked_skill_agent_listing_baselines_splits_prompt_and_diff_baselines() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let parent = manager
            .create_session(
                "Parent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("parent session should create");
        let child = manager
            .create_session(
                "Child".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("child session should create");
        let prompt_baseline = TurnSkillAgentSnapshot {
            skills: vec![SkillSnapshotEntry {
                name: "skill-parent-turn-0".to_string(),
                description: "desc-0".to_string(),
                location: "/skills/turn-0".to_string(),
            }],
            ..Default::default()
        };
        let latest_baseline = TurnSkillAgentSnapshot {
            skills: vec![SkillSnapshotEntry {
                name: "skill-parent-latest".to_string(),
                description: "desc-latest".to_string(),
                location: "/skills/latest".to_string(),
            }],
            ..Default::default()
        };

        manager
            .remember_turn_skill_agent_snapshot(&parent.session_id, 0, prompt_baseline.clone())
            .await;
        manager
            .remember_turn_skill_agent_snapshot(&parent.session_id, 2, latest_baseline.clone())
            .await;
        {
            let mut parent_session = manager
                .sessions
                .get_mut(&parent.session_id)
                .expect("parent session should remain in memory");
            parent_session.dialog_turn_ids = vec![
                "turn-0".to_string(),
                "turn-1".to_string(),
                "turn-2".to_string(),
            ];
        }

        manager
            .seed_forked_skill_agent_listing_baselines(&parent.session_id, &child.session_id)
            .await;

        assert_eq!(
            manager
                .skill_agent_baseline_override_snapshot(&child.session_id)
                .await,
            Some(prompt_baseline.clone())
        );
        assert_eq!(
            manager
                .turn_skill_agent_snapshot(&child.session_id, 0)
                .await,
            Some(latest_baseline.clone())
        );

        manager.evict_loaded_session_for_test(&child.session_id);
        let restored_manager = test_manager(persistence_manager);
        restored_manager
            .restore_session(workspace.path(), &child.session_id)
            .await
            .expect("child session should restore");
        assert_eq!(
            restored_manager
                .skill_agent_baseline_override_snapshot(&child.session_id)
                .await,
            Some(prompt_baseline)
        );
        assert_eq!(
            restored_manager
                .turn_skill_agent_snapshot(&child.session_id, 0)
                .await,
            Some(latest_baseline)
        );
    }

    #[tokio::test]
    async fn prompt_cache_invalidation_removes_persisted_entries() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let workspace_path = workspace.path().to_string_lossy().to_string();
        let session = manager
            .create_session(
                "Prompt cache".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_path),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let identity = SystemPromptCacheIdentity::new("template:agentic_mode");
        let user_context_identity = UserContextCacheIdentity::new(
            "workspace_context|workspace_instructions|project_layout",
        );

        manager
            .remember_system_prompt(
                &session.session_id,
                identity.clone(),
                "cached system prompt".to_string(),
            )
            .await;
        manager
            .remember_user_context(
                &session.session_id,
                user_context_identity.clone(),
                "cached user context".to_string(),
            )
            .await;

        manager
            .invalidate_prompt_cache(&session.session_id, PromptCacheScope::All, "test")
            .await;

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored_manager = test_manager(persistence_manager.clone());
        restored_manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");

        assert_eq!(
            restored_manager
                .cached_system_prompt(&session.session_id, &identity)
                .await,
            None
        );
        assert_eq!(
            restored_manager
                .cached_user_context(&session.session_id, &user_context_identity)
                .await,
            None
        );
        assert_eq!(
            persistence_manager
                .load_prompt_cache(workspace.path(), &session.session_id)
                .await
                .expect("prompt cache load should succeed"),
            None
        );
    }

    #[tokio::test]
    async fn prompt_cache_invalidation_waits_for_an_inflight_lazy_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = Arc::new(test_manager(persistence_manager.clone()));
        let session = manager
            .create_session(
                "Prompt cache".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let identity = UserContextCacheIdentity::new(
            "workspace_context|workspace_instructions|project_layout",
        );

        manager
            .remember_user_context(
                &session.session_id,
                identity.clone(),
                "persisted user context".to_string(),
            )
            .await;
        manager
            .prompt_cache_store
            .delete_session(&session.session_id);

        let operation_guard = manager
            .prompt_cache_operation_locks
            .lock(&session.session_id)
            .await;
        let lookup_manager = manager.clone();
        let lookup_session_id = session.session_id.clone();
        let lookup_identity = identity.clone();
        let lookup = tokio::spawn(async move {
            lookup_manager
                .cached_user_context(&lookup_session_id, &lookup_identity)
                .await
        });
        tokio::task::yield_now().await;
        let invalidate_manager = manager.clone();
        let invalidate_session_id = session.session_id.clone();
        let invalidate = tokio::spawn(async move {
            invalidate_manager
                .invalidate_prompt_cache(
                    &invalidate_session_id,
                    PromptCacheScope::UserContext,
                    "test",
                )
                .await;
        });
        tokio::task::yield_now().await;
        drop(operation_guard);

        assert_eq!(
            lookup.await.expect("lookup task should complete"),
            Some("persisted user context".to_string())
        );
        invalidate.await.expect("invalidation task should complete");
        assert_eq!(
            persistence_manager
                .load_prompt_cache(workspace.path(), &session.session_id)
                .await
                .expect("prompt cache load should succeed"),
            None
        );
        manager
            .prompt_cache_store
            .delete_session(&session.session_id);
        assert_eq!(
            manager
                .cached_user_context(&session.session_id, &identity)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn clone_prompt_cache_copies_runtime_and_persisted_entries() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager(persistence_manager.clone());
        let workspace_path = workspace.path().to_string_lossy().to_string();
        let source_session = manager
            .create_session(
                "Prompt cache source".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_path.clone()),
                    ..Default::default()
                },
            )
            .await
            .expect("source session should be created");
        let target_session = manager
            .create_session(
                "Prompt cache target".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_path),
                    ..Default::default()
                },
            )
            .await
            .expect("target session should be created");
        let identity = SystemPromptCacheIdentity::new("template:agentic_mode");
        let user_context_identity = UserContextCacheIdentity::new(
            "workspace_context|workspace_instructions|project_layout",
        );

        manager
            .remember_system_prompt(
                &source_session.session_id,
                identity.clone(),
                "cached system prompt".to_string(),
            )
            .await;
        manager
            .remember_user_context(
                &source_session.session_id,
                user_context_identity.clone(),
                "cached user context".to_string(),
            )
            .await;

        assert!(
            manager
                .clone_prompt_cache(&source_session.session_id, &target_session.session_id)
                .await
        );
        assert_eq!(
            manager
                .cached_system_prompt(&target_session.session_id, &identity)
                .await,
            Some("cached system prompt".to_string())
        );
        assert_eq!(
            manager
                .cached_user_context(&target_session.session_id, &user_context_identity)
                .await,
            Some("cached user context".to_string())
        );
        assert_eq!(
            persistence_manager
                .load_prompt_cache(workspace.path(), &target_session.session_id)
                .await
                .expect("prompt cache load should succeed")
                .expect("cloned prompt cache should persist"),
            persistence_manager
                .load_prompt_cache(workspace.path(), &source_session.session_id)
                .await
                .expect("source prompt cache load should succeed")
                .expect("source prompt cache should exist")
        );
    }

    #[tokio::test]
    async fn prompt_cache_persistence_ttl_only_affects_cold_start_restore() {
        let workspace = TestWorkspace::new();
        let persistence_manager =
            Arc::new(PersistenceManager::new(workspace.path_manager()).expect("persistence"));
        let manager = test_manager_with_config(
            persistence_manager.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy {
                    cache_ttl: None,
                    persistence_ttl: Some(Duration::from_millis(0)),
                },
            },
        );
        let workspace_path = workspace.path().to_string_lossy().to_string();
        let session = manager
            .create_session(
                "Prompt cache".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_path),
                    ..Default::default()
                },
            )
            .await
            .expect("session should be created");
        let identity = SystemPromptCacheIdentity::new("template:agentic_mode");
        let user_context_identity = UserContextCacheIdentity::new(
            "workspace_context|workspace_instructions|project_layout",
        );

        manager
            .remember_system_prompt(
                &session.session_id,
                identity.clone(),
                "cached system prompt".to_string(),
            )
            .await;
        manager
            .remember_user_context(
                &session.session_id,
                user_context_identity.clone(),
                "cached user context".to_string(),
            )
            .await;

        assert_eq!(
            manager
                .cached_system_prompt(&session.session_id, &identity)
                .await,
            Some("cached system prompt".to_string())
        );
        assert_eq!(
            manager
                .cached_user_context(&session.session_id, &user_context_identity)
                .await,
            Some("cached user context".to_string())
        );

        manager.evict_loaded_session_for_test(&session.session_id);
        let restored_manager = test_manager_with_config(
            persistence_manager.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy {
                    cache_ttl: None,
                    persistence_ttl: Some(Duration::from_millis(0)),
                },
            },
        );
        restored_manager
            .restore_session(workspace.path(), &session.session_id)
            .await
            .expect("session should restore");

        assert_eq!(
            restored_manager
                .cached_system_prompt(&session.session_id, &identity)
                .await,
            None
        );
        assert_eq!(
            restored_manager
                .cached_user_context(&session.session_id, &user_context_identity)
                .await,
            None
        );
    }
}
