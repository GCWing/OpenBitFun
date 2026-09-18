//! Core Agent Runtime compatibility adapter boundary.
//!
//! Product runtime assembly facts live in `openbitfun-product-capabilities`. Core
//! keeps only compatibility exports and adapter wiring that still depends on
//! existing concrete core paths.

#[cfg(all(feature = "tools-pages", feature = "remote-connect"))]
pub mod account_pages;
mod runtime_services;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use openbitfun_agent_runtime::permission::PermissionRequestManager;
use openbitfun_agent_runtime::sdk::{
    AgentEventReceiver, AgentEventSource, AgentRuntime, AgentSessionForkAtTurnRequest,
    AgentSessionForkBeforeTurnRequest, AgentSessionForkPort, AgentSessionForkRequest,
    AgentSessionForkResult, AgentSessionLifecycleStatus, AgentSessionLineageCancellationRequest,
    AgentSessionLineageEntry, AgentSessionLineageInspection, AgentSessionLineagePort,
    AgentSessionLineageRequest, AgentSessionLineageSnapshot, AgentSessionLineageTranscriptRequest,
    AgentSessionUsagePort, AgentSessionUsageRequest, AgentTurnCancellationResult,
    AgentTurnSettlementPort, AgentTurnSettlementRequest, AgentTurnSettlementResult,
    AgentTurnSettlementStatus, SessionTranscript,
};
use openbitfun_core_types::{SESSION_PROVIDER_ACP, SESSION_PROVIDER_METADATA_KEY};
#[cfg(feature = "product-search")]
use openbitfun_product_domains::product_search::{
    SessionContentSearchRequest, SessionContentSearchResponse, SessionSearchDiagnostic,
    SessionSearchDiagnosticCode, SessionSearchSessionDocument, SessionSearchTurnDocument,
    MAX_SESSION_CONTENT_SEARCH_QUERY_CHARS,
};
#[cfg(feature = "product-search")]
use openbitfun_runtime_ports::ProductSearchPort;
use openbitfun_runtime_ports::{
    AgentContextReloadPort, AgentContextReloadRequest, ClockPort, LocalWorkspaceSnapshotPort,
    LocalWorkspaceSnapshotSessionRequest, LocalWorkspaceSnapshotStats,
    LocalWorkspaceSnapshotTurnRequest, PortError, PortErrorKind, PortResult,
    RuntimeServiceCapability, RuntimeServicePort, SessionStoragePathRequest, SessionStorePort,
    SessionTranscriptRequest, SessionTurnWindowRequest, SessionViewRestoreTiming,
};
use openbitfun_runtime_services::RuntimeServices;
use openbitfun_services_core::permission_store::ProjectPermissionSqliteStore;
use openbitfun_services_core::session::{
    build_session_lineage_snapshot, normalized_session_relationship, SessionBranchBoundary,
    SessionRelationshipKind,
};
#[cfg(feature = "product-search")]
use openbitfun_services_core::session_search::{SessionSearchIndexError, SessionSearchSqliteIndex};

use crate::agentic::coordination::{
    runtime_transcript_messages_from_turns, validate_required_lineage_turns_settled,
    ConversationCoordinator, DialogScheduler, SessionMaintenancePermit,
};
use crate::agentic::core::Session;
use crate::agentic::events::EventQueue;
use crate::agentic::keyed_lock::KeyedAsyncLockGuard;
use crate::agentic::persistence::session_branch::SessionBranchRequest;
use crate::agentic::persistence::{PersistenceManager, SessionMetadataPage};
use crate::agentic::session::transcript_render::transcript_final_assistant_content;
#[cfg(feature = "product-search")]
use crate::agentic::session::transcript_render::{
    transcript_display_assistant_content, transcript_display_user_content,
};
use crate::agentic::session::{
    CoreSessionStorePort, PromptCacheScope,
    INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY,
    INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY,
    INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY,
};
use crate::agentic::tools::implementations::skills::SkillRegistry;
use crate::service::remote_ssh::workspace_state::{
    workspace_session_identity, WorkspaceSessionIdentity,
};
use crate::service::session::{
    DialogTurnData, SessionMetadata, SessionTranscriptExport, SessionTranscriptExportOptions,
    SessionTurnCatalog, SessionTurnWindowResponse, TurnStatus,
};
#[cfg(feature = "product-search")]
use crate::service::session::{DialogTurnKind, SessionStatus};
use crate::service::session_usage::{
    generate_session_usage_report_from_storage_path, SessionUsageReport,
};
use crate::service::snapshot::{
    get_snapshot_manager_for_workspace, initialize_snapshot_manager_for_workspace,
    open_snapshot_manager_for_view, SnapshotError, SnapshotManager,
};
use crate::service::token_usage::TokenUsageService;
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};

pub use openbitfun_product_capabilities::ProductRuntimeAssembly as CoreProductRuntimeAssembly;
pub use runtime_services::{build_local_runtime_services, CoreRuntimeServicesProvider};

fn projected_turn_save_would_overwrite_runtime_state(
    persisted: &DialogTurnData,
    projected: &DialogTurnData,
) -> bool {
    let projected_drops_persisted_content =
        || {
            if projected.model_rounds.len() < persisted.model_rounds.len() {
                return true;
            }
            persisted.model_rounds.iter().any(|persisted_round| {
                let Some(projected_round) = projected
                    .model_rounds
                    .iter()
                    .find(|round| round.id == persisted_round.id)
                else {
                    return true;
                };

                let text_was_shortened =
                    persisted_round
                        .text_items
                        .iter()
                        .enumerate()
                        .any(|(index, persisted_item)| {
                            projected_round.text_items.get(index).is_none_or(|item| {
                                !item.content.starts_with(&persisted_item.content)
                            })
                        });
                let thinking_was_shortened = persisted_round.thinking_items.iter().enumerate().any(
                    |(index, persisted_item)| {
                        projected_round
                            .thinking_items
                            .get(index)
                            .is_none_or(|item| !item.content.starts_with(&persisted_item.content))
                    },
                );
                let tool_was_dropped = persisted_round.tool_items.iter().any(|persisted_tool| {
                    projected_round
                        .tool_items
                        .iter()
                        .find(|tool| tool.id == persisted_tool.id)
                        .is_none_or(|tool| {
                            persisted_tool.tool_result.is_some() && tool.tool_result.is_none()
                        })
                });

                text_was_shortened || thinking_was_shortened || tool_was_dropped
            })
        };

    persisted.recovery.is_some()
        || persisted.recovery_epoch.is_some()
        || projected.recovery.is_some()
        || projected.recovery_epoch.is_some()
        || (matches!(
            persisted.status,
            TurnStatus::Completed | TurnStatus::Cancelled | TurnStatus::Error
        ) && (projected.status == TurnStatus::InProgress
            || projected_drops_persisted_content()))
}

fn merge_runtime_owned_turn_facts(
    persisted: &DialogTurnData,
    projected: &DialogTurnData,
) -> DialogTurnData {
    let mut merged = projected.clone();
    merged.agent_type = persisted.agent_type.clone();

    let Some(persisted_metadata) = persisted
        .user_message
        .metadata
        .as_ref()
        .and_then(serde_json::Value::as_object)
    else {
        return merged;
    };
    let projected_metadata = merged
        .user_message
        .metadata
        .get_or_insert_with(|| serde_json::json!({}));
    if !projected_metadata.is_object() {
        *projected_metadata = serde_json::json!({});
    }
    let target = projected_metadata
        .as_object_mut()
        .expect("projected metadata was normalized to an object");
    for key in [
        INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY,
        INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY,
        INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY,
        INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY,
        INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY,
        INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY,
    ] {
        if let Some(value) = persisted_metadata.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
    merged
}

struct ProductEventQueueDrain {
    task: tokio::task::JoinHandle<()>,
}

impl ProductEventQueueDrain {
    fn start(queue: Arc<EventQueue>) -> Self {
        let task = tokio::spawn(async move {
            loop {
                queue.wait_for_events().await;
                while !queue.dequeue_configured_batch().await.is_empty() {}
            }
        });
        Self { task }
    }
}

impl Drop for ProductEventQueueDrain {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Product-host owner that keeps the legacy event queue bounded while the
/// assembled Agent Runtime exposes the read-only subscription surface.
#[derive(Clone)]
pub struct CoreProductEventQueueOwner {
    source: AgentEventSource,
    _drain: Arc<ProductEventQueueDrain>,
}

impl CoreProductEventQueueOwner {
    pub fn new(queue: Arc<EventQueue>) -> Self {
        Self {
            source: AgentEventSource::new(queue.clone()),
            _drain: Arc::new(ProductEventQueueDrain::start(queue)),
        }
    }

    pub fn runtime_source(&self) -> AgentEventSource {
        self.source.clone()
    }
}

/// Compatibility wrapper for hosts that still subscribe outside `AgentRuntime`.
///
/// First-party hosts must retain [`CoreProductEventQueueOwner`] and subscribe
/// through `AgentRuntime`. This wrapper remains only to avoid silently breaking
/// existing `openbitfun-core` consumers during the migration.
#[deprecated(note = "use CoreProductEventQueueOwner and subscribe through AgentRuntime instead")]
#[derive(Clone)]
pub struct CoreProductAgentEventSource {
    owner: CoreProductEventQueueOwner,
}

#[allow(deprecated)]
impl CoreProductAgentEventSource {
    pub fn new(queue: Arc<EventQueue>) -> Self {
        Self {
            owner: CoreProductEventQueueOwner::new(queue),
        }
    }

    pub fn subscribe(&self) -> AgentEventReceiver {
        self.owner.runtime_source().subscribe()
    }

    pub fn runtime_source(&self) -> AgentEventSource {
        self.owner.runtime_source()
    }
}

/// Returns the process-shared dialog scheduler used by sibling product hosts.
pub fn ensure_product_dialog_scheduler(
    agentic_system: &crate::agentic::system::AgenticSystem,
) -> Arc<DialogScheduler> {
    if let Some(scheduler) = crate::agentic::coordination::get_global_scheduler() {
        return scheduler;
    }

    let session_manager = agentic_system.coordinator.get_session_manager().clone();
    let scheduler = DialogScheduler::new(agentic_system.coordinator.clone(), session_manager);
    agentic_system
        .coordinator
        .set_scheduler_notifier(scheduler.outcome_sender());
    agentic_system
        .coordinator
        .set_round_injection_source(scheduler.round_injection_monitor());
    crate::agentic::coordination::set_global_scheduler(scheduler.clone());
    scheduler
}

#[derive(Debug, Clone, Copy, Default)]
struct SystemPermissionClock;

impl RuntimeServicePort for SystemPermissionClock {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::Clock
    }
}

impl ClockPort for SystemPermissionClock {
    fn now_unix_millis(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or_default()
    }
}

static PERMISSION_REQUEST_MANAGER: OnceLock<Arc<PermissionRequestManager>> = OnceLock::new();

/// Returns the process-shared permission request owner used by product
/// surfaces. Pending requests remain process-local; only remembered grants and
/// audit facts are written to the user data directory.
pub fn core_permission_request_manager() -> Result<Arc<PermissionRequestManager>, String> {
    if let Some(manager) = PERMISSION_REQUEST_MANAGER.get() {
        return Ok(manager.clone());
    }

    let path_manager = crate::infrastructure::PathManager::new()
        .map_err(|error| format!("Failed to initialize permission path manager: {error}"))?;
    let store = Arc::new(ProjectPermissionSqliteStore::new(
        path_manager.user_data_dir().join("permissions"),
    ));
    let audit_store: Arc<dyn openbitfun_runtime_ports::PermissionAuditStorePort> = store.clone();
    let reply_store: Arc<dyn openbitfun_runtime_ports::PermissionReplyStorePort> = store.clone();
    let grant_store: Arc<dyn openbitfun_runtime_ports::PermissionGrantStorePort> = store;
    let manager = Arc::new(
        PermissionRequestManager::new(audit_store, reply_store, Arc::new(SystemPermissionClock))
            .with_grant_store(grant_store),
    );
    let _ = PERMISSION_REQUEST_MANAGER.set(manager);
    PERMISSION_REQUEST_MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "Failed to initialize shared permission request manager".to_string())
}

/// Serializes one compatibility mutation with Core's session lifecycle.
pub struct CoreSessionMutationPermit {
    _guard: KeyedAsyncLockGuard,
    session_id: String,
    storage_path: PathBuf,
}

/// Holds a stable persisted-session visibility boundary while a product reads
/// facts that are also changed by Session undo/redo.
pub struct CoreSessionReadPermit {
    _guard: KeyedAsyncLockGuard,
    visible_turn_end: Option<usize>,
}

impl CoreSessionReadPermit {
    /// Exclusive turn end for product facts. `None` means the complete session
    /// is visible because no undo is staged.
    pub fn visible_turn_end(&self) -> Option<usize> {
        self.visible_turn_end
    }
}

/// Holds Core's scheduler boundary while a product compatibility operation
/// mutates session state that must not overlap turn dispatch.
pub struct CoreSessionMaintenancePermit {
    _permit: SessionMaintenancePermit,
}

fn validate_persisted_session_id(session_id: &str) -> OpenBitFunResult<()> {
    openbitfun_core_types::validate_session_id(session_id).map_err(OpenBitFunError::Validation)
}

fn validate_session_workspace_identity(
    session: &Session,
    expected: &WorkspaceSessionIdentity,
) -> OpenBitFunResult<()> {
    let config = &session.config;
    let actual = config.workspace_path.as_deref().and_then(|path| {
        workspace_session_identity(
            path,
            config.remote_connection_id.as_deref(),
            config.remote_ssh_host.as_deref(),
        )
    });
    if actual.as_ref() != Some(expected) {
        return Err(OpenBitFunError::Validation(format!(
            "Session workspace identity does not match the requested workspace scope: {}",
            session.session_id,
        )));
    }
    Ok(())
}

async fn fork_workspace_binding(
    session: &Session,
    requested_workspace_id: &str,
) -> OpenBitFunResult<crate::agentic::WorkspaceBinding> {
    let mut config = session.config.clone();
    crate::agentic::workspace::normalize_session_workspace(&mut config).await?;
    let id = config
        .workspace_id
        .as_deref()
        .ok_or_else(|| OpenBitFunError::Validation("Session workspace ID is required".into()))?;
    if requested_workspace_id != id
        && config.project_workspace_id.as_deref() != Some(requested_workspace_id)
    {
        return Err(OpenBitFunError::Validation(format!(
            "Session workspace identity does not match the requested workspace ID: {}",
            session.session_id
        )));
    }
    crate::agentic::WorkspaceBinding::resolve(id).await
}

async fn begin_consistent_persisted_session_read(
    coordinator: &ConversationCoordinator,
    persistence: &PersistenceManager,
    storage_path: &Path,
    session_id: &str,
    expected_workspace: Option<&WorkspaceSessionIdentity>,
) -> OpenBitFunResult<CoreSessionReadPermit> {
    validate_persisted_session_id(session_id)?;
    let session_manager = coordinator.get_session_manager();
    let guard = session_manager.acquire_session_mutation(session_id).await?;
    session_manager.validate_session_storage_path_binding(session_id, storage_path)?;

    // A remote mirror's Session directory predates connection-specific snapshot
    // scopes. Check durable and loaded identity under the same lock before
    // reconciling history or exposing any operation content.
    if let Some(expected) = expected_workspace {
        if let Some(session) = session_manager.get_session(session_id) {
            validate_session_workspace_identity(&session, expected)?;
        }
        let persisted = persistence
            .load_session_header(storage_path, session_id)
            .await?;
        validate_session_workspace_identity(&persisted, expected)?;
    }

    if let Some(state) = persistence
        .load_session_revert_state(storage_path, session_id)
        .await?
    {
        if state.phase != crate::agentic::session::revert::SessionRevertPhase::Staged {
            if session_manager.get_session(session_id).is_none() {
                return Err(OpenBitFunError::OutcomeUnknown(
                    "Session facts are unavailable until the unfinished undo transition is restored"
                        .to_string(),
                ));
            }
            coordinator
                .reconcile_session_revert_locked(storage_path, session_id)
                .await?;
        }
    }

    let visible_turn_end = persistence
        .load_session_revert_state(storage_path, session_id)
        .await?
        .map(|state| state.boundary_turn);
    Ok(CoreSessionReadPermit {
        _guard: guard,
        visible_turn_end,
    })
}

fn latest_persisted_turn_id(turns: &[DialogTurnData]) -> OpenBitFunResult<String> {
    turns
        .last()
        .map(|turn| turn.turn_id.clone())
        .ok_or_else(|| {
            OpenBitFunError::Validation("Session has no persisted turns to fork".to_string())
        })
}

async fn generate_core_session_usage_report(
    persistence: &PersistenceManager,
    token_usage_service: &TokenUsageService,
    session_storage_path: &Path,
    request: AgentSessionUsageRequest,
) -> OpenBitFunResult<SessionUsageReport> {
    validate_persisted_session_id(&request.session_id)?;
    generate_session_usage_report_from_storage_path(
        persistence,
        Some(token_usage_service),
        session_storage_path,
        request,
    )
    .await
}

async fn load_visible_persisted_session_turns(
    persistence: &PersistenceManager,
    storage_path: &Path,
    session_id: &str,
    visible_turn_end: Option<usize>,
    limit: Option<usize>,
) -> OpenBitFunResult<Vec<DialogTurnData>> {
    let mut turns = persistence
        .load_session_turns(storage_path, session_id)
        .await?;
    if let Some(end) = visible_turn_end {
        turns.retain(|turn| turn.turn_index < end);
    }
    if let Some(limit) = limit {
        let start = turns.len().saturating_sub(limit);
        turns = turns.split_off(start);
    }
    Ok(turns)
}

fn runtime_lineage_snapshot(
    snapshot: openbitfun_services_core::session::SessionLineageSnapshot,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> AgentSessionLineageSnapshot {
    AgentSessionLineageSnapshot {
        root_session_id: snapshot.root_session_id,
        sessions: snapshot
            .sessions
            .into_iter()
            .map(|metadata| {
                let relationship = normalized_session_relationship(&metadata);
                AgentSessionLineageEntry {
                    session_id: metadata.session_id,
                    session_name: metadata.session_name,
                    agent_type: metadata.agent_type,
                    created_at_ms: metadata.created_at,
                    status: match metadata.status {
                        openbitfun_services_core::session::SessionStatus::Active => {
                            AgentSessionLifecycleStatus::Active
                        }
                        openbitfun_services_core::session::SessionStatus::Archived => {
                            AgentSessionLifecycleStatus::Archived
                        }
                        openbitfun_services_core::session::SessionStatus::Completed => {
                            AgentSessionLifecycleStatus::Completed
                        }
                    },
                    active_turn_id: None,
                    parent_session_id: relationship
                        .as_ref()
                        .and_then(|value| value.parent_session_id.clone()),
                    parent_tool_call_id: relationship
                        .as_ref()
                        .and_then(|value| value.parent_tool_call_id.clone()),
                    subagent_type: relationship
                        .as_ref()
                        .and_then(|value| value.subagent_type.clone()),
                    agent_id: None,
                    workspace_id: metadata.workspace_id,
                    workspace_path: metadata.workspace_path,
                    remote_connection_id: remote_connection_id.map(str::to_string),
                    remote_ssh_host: remote_ssh_host.map(str::to_string),
                    unread_completion: metadata.unread_completion,
                    needs_user_attention: metadata.needs_user_attention,
                }
            })
            .collect(),
    }
}

fn snapshot_port_error(error: SnapshotError) -> PortError {
    let kind = match &error {
        SnapshotError::SnapshotNotFound(_)
        | SnapshotError::SessionNotFound(_)
        | SnapshotError::OperationNotFound(_)
        | SnapshotError::FileNotFound(_) => PortErrorKind::NotFound,
        SnapshotError::Io(_)
        | SnapshotError::WorkspaceIo(_)
        | SnapshotError::Serialization(_)
        | SnapshotError::GitIsolationFailure(_)
        | SnapshotError::ConfigError(_)
        | SnapshotError::ToolExecution(_) => PortErrorKind::Backend,
    };
    PortError::new(kind, error.to_string())
}

fn snapshot_initialization_port_error(error: SnapshotError) -> PortError {
    PortError::new(PortErrorKind::NotAvailable, error.to_string())
}

fn validate_local_snapshot_workspace(workspace_path: &Path) -> PortResult<()> {
    if workspace_path.as_os_str().is_empty() {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            "workspace path is required",
        ));
    }
    if !workspace_path.is_dir() {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            format!(
                "Workspace directory does not exist: {}",
                workspace_path.display()
            ),
        ));
    }
    Ok(())
}

async fn ensure_local_snapshot_manager(workspace_id: &str) -> PortResult<Arc<SnapshotManager>> {
    let workspace_path = local_snapshot_root(workspace_id).await?;
    validate_local_snapshot_workspace(&workspace_path)?;
    if let Some(manager) = get_snapshot_manager_for_workspace(workspace_id) {
        return Ok(manager);
    }
    initialize_snapshot_manager_for_workspace(workspace_id, None)
        .await
        .map_err(snapshot_initialization_port_error)?;
    get_snapshot_manager_for_workspace(workspace_id).ok_or_else(|| {
        PortError::new(
            PortErrorKind::Backend,
            format!(
                "Snapshot manager is unavailable for workspace {}",
                workspace_path.display()
            ),
        )
    })
}

async fn local_snapshot_manager_for_view(workspace_id: &str) -> PortResult<Arc<SnapshotManager>> {
    let workspace_path = local_snapshot_root(workspace_id).await?;
    validate_local_snapshot_workspace(&workspace_path)?;
    open_snapshot_manager_for_view(workspace_id)
        .await
        .map_err(snapshot_port_error)
}

/// Core-backed access to the existing local workspace snapshot owner.
///
/// The returned port is intentionally separate from the Agent Runtime SDK and
/// does not accept remote workspace identity.
pub struct CoreLocalWorkspaceSnapshot;

impl CoreLocalWorkspaceSnapshot {
    pub fn build() -> Arc<dyn LocalWorkspaceSnapshotPort> {
        Arc::new(Self)
    }
}

async fn local_snapshot_root(workspace_id: &str) -> PortResult<PathBuf> {
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        PortError::new(
            PortErrorKind::NotAvailable,
            "Workspace service is unavailable",
        )
    })?;
    let record = service
        .require_workspace(workspace_id)
        .await
        .map_err(|e| PortError::new(PortErrorKind::InvalidRequest, e.to_string()))?;
    if record.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            "Snapshot system not supported for remote workspace",
        ));
    }
    Ok(record.root_path)
}

#[async_trait::async_trait]
impl LocalWorkspaceSnapshotPort for CoreLocalWorkspaceSnapshot {
    async fn prepare_local_workspace(&self, workspace_id: String) -> PortResult<()> {
        ensure_local_snapshot_manager(&workspace_id).await?;
        Ok(())
    }

    async fn get_session_files(
        &self,
        request: LocalWorkspaceSnapshotSessionRequest,
    ) -> PortResult<Vec<PathBuf>> {
        validate_persisted_session_id(&request.session_id).map_err(runtime_port_error)?;
        let manager = local_snapshot_manager_for_view(&request.workspace_id).await?;
        manager
            .get_session_files_before(&request.session_id, request.max_turn_exclusive)
            .await
            .map_err(snapshot_port_error)
    }

    async fn get_session_stats(
        &self,
        request: LocalWorkspaceSnapshotSessionRequest,
    ) -> PortResult<LocalWorkspaceSnapshotStats> {
        validate_persisted_session_id(&request.session_id).map_err(runtime_port_error)?;
        let manager = local_snapshot_manager_for_view(&request.workspace_id).await?;
        let stats = manager
            .get_session_stats_fact_before(&request.session_id, request.max_turn_exclusive)
            .await
            .map_err(snapshot_port_error)?;
        Ok(LocalWorkspaceSnapshotStats {
            session_id: stats.session_id,
            total_files: stats.total_files,
            total_turns: stats.total_turns,
            total_changes: stats.total_changes,
        })
    }

    async fn rollback_workspace_files_to_turn(
        &self,
        request: LocalWorkspaceSnapshotTurnRequest,
    ) -> PortResult<Vec<PathBuf>> {
        validate_persisted_session_id(&request.session_id).map_err(runtime_port_error)?;
        ensure_local_snapshot_manager(&request.workspace_id)
            .await?
            .rollback_workspace_files_to_boundary(&request.session_id, request.turn_index)
            .await
            .map_err(snapshot_port_error)
    }
}

/// Product-assembly entry for the public Agent Runtime SDK.
///
/// Concrete coordinator and scheduler ownership remains in Core. Product
/// surfaces receive only the SDK runtime assembled from validated services and
/// harnesses; plugin runtime bindings are deliberately not part of this API.
pub struct CoreProductAgentRuntime;

pub(crate) async fn fork_session_for_plugin(
    workspace_id: String,
    source_session_id: String,
    source_message_id: Option<String>,
) -> Result<AgentSessionForkResult, String> {
    let coordinator = crate::agentic::coordination::get_global_coordinator()
        .ok_or_else(|| "Session coordinator is not initialized".to_string())?;
    let scheduler = crate::agentic::coordination::get_global_scheduler()
        .ok_or_else(|| "Dialog scheduler is not initialized".to_string())?;
    let path_manager =
        crate::infrastructure::try_get_path_manager_arc().map_err(|error| error.to_string())?;
    let token_usage_service = Arc::new(
        TokenUsageService::new(path_manager)
            .await
            .map_err(|error| error.to_string())?,
    );
    let operations =
        CoreSessionOperationsPort::new(coordinator.clone(), scheduler, token_usage_service);
    match source_message_id {
        Some(message_id) => {
            let source_turn_id = coordinator
                .get_messages(&source_session_id)
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|message| message.id == message_id)
                .and_then(|message| message.metadata.turn_id)
                .ok_or_else(|| format!("Source message was not found: {message_id}"))?;
            AgentSessionForkPort::fork_session_at_turn(
                &operations,
                AgentSessionForkAtTurnRequest {
                    workspace_id: Some(workspace_id.clone()),
                    workspace_path: String::new(),
                    source_session_id,
                    source_turn_id,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
            )
            .await
            .map_err(|error| error.to_string())
        }
        None => AgentSessionForkPort::fork_session(
            &operations,
            AgentSessionForkRequest {
                workspace_id: Some(workspace_id),
                workspace_path: String::new(),
                source_session_id,
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        )
        .await
        .map_err(|error| error.to_string()),
    }
}

impl CoreProductAgentRuntime {
    /// Build a narrow session and interaction facade for an existing product
    /// owner. This does not assemble runtime services, harnesses, events, or a
    /// complete delivery profile.
    pub fn build_session_surface(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
    ) -> Result<AgentRuntime, String> {
        let session_operations = Arc::new(CoreSessionOperationsPort::new(
            coordinator.clone(),
            scheduler.clone(),
            token_usage_service,
        ));
        CoreServiceAgentRuntime::session_surface_agent_runtime(
            coordinator,
            scheduler,
            session_operations.clone(),
            session_operations.clone(),
            session_operations,
        )
    }

    /// Build the Desktop/Rich-client Session facade with the Runtime-owned
    /// materialized event projection used for client reattachment.
    pub fn build_session_surface_with_event_journal(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        event_journal: Arc<openbitfun_agent_runtime::sdk::SessionEventJournal>,
    ) -> Result<AgentRuntime, String> {
        Self::build_session_surface(coordinator, scheduler, token_usage_service)
            .map(|runtime| runtime.with_session_event_journal(event_journal))
    }

    #[deprecated(note = "use build_with_event_source for first-party product runtimes")]
    pub fn build(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        services: RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        Self::build_with_optional_event_source(
            coordinator,
            scheduler,
            token_usage_service,
            None,
            services,
        )
    }

    pub fn build_with_event_source(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        event_source: AgentEventSource,
        services: RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        Self::build_with_optional_event_source(
            coordinator,
            scheduler,
            token_usage_service,
            Some(event_source),
            services,
        )
    }

    fn build_with_optional_event_source(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        event_source: Option<AgentEventSource>,
        services: RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let session_operations = Arc::new(CoreSessionOperationsPort::new(
            coordinator.clone(),
            scheduler.clone(),
            token_usage_service,
        ));
        CoreServiceAgentRuntime::product_agent_runtime(
            coordinator,
            scheduler,
            event_source,
            session_operations.clone(),
            session_operations.clone(),
            session_operations.clone(),
            session_operations,
            services,
        )
    }

    /// Build the ACP surface with its protocol requirement that a session
    /// rejects a second prompt while another turn is active.
    pub fn build_acp(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        event_source: AgentEventSource,
        services: RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        CoreServiceAgentRuntime::acp_product_agent_runtime(
            coordinator,
            scheduler,
            event_source,
            services,
        )
    }

    /// Build the standalone Agent SDK Host implementation candidate.
    ///
    /// The Host receives the same Core-owned session, query, event, cancellation,
    /// and settlement capabilities as the CLI product runtime. It does not own
    /// a second agent loop or protocol-specific execution services.
    pub fn build_sdk_host(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        event_source: AgentEventSource,
        services: RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let session_operations = Arc::new(CoreSessionOperationsPort::new(
            coordinator.clone(),
            scheduler.clone(),
            token_usage_service,
        ));
        CoreServiceAgentRuntime::sdk_host_product_agent_runtime(
            coordinator,
            scheduler,
            event_source,
            session_operations.clone(),
            session_operations.clone(),
            session_operations,
            services,
        )
    }
}

/// Core-owned compatibility boundary for product operations not yet exposed by
/// the public Agent Runtime SDK.
///
/// This facade does not own execution. It delegates to the same coordinator,
/// session manager, persistence manager, and user-input channels used by Core.
#[derive(Clone)]
pub struct CoreAgentRuntimeCompatibility {
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
    persistence: Arc<PersistenceManager>,
}

impl CoreAgentRuntimeCompatibility {
    pub async fn ensure_control_conversation(
        &self,
    ) -> OpenBitFunResult<crate::agentic::coordination::ControlConversation> {
        self.coordinator.ensure_control_conversation().await
    }

    pub async fn create_control_conversation(
        &self,
        request: crate::agentic::coordination::CreateControlConversationRequest,
    ) -> OpenBitFunResult<crate::agentic::coordination::ControlConversation> {
        self.coordinator.create_control_conversation(request).await
    }

    pub async fn record_voice_exchange(
        &self,
        request: crate::agentic::coordination::VoiceExchangeRequest,
    ) -> OpenBitFunResult<()> {
        self.coordinator.record_voice_exchange(request).await
    }

    pub fn build(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> Self {
        let persistence = coordinator.get_session_manager().persistence_manager();

        Self {
            coordinator,
            scheduler,
            persistence,
        }
    }

    /// Permission selectors use the invocation's Session owner, including Peer hosts.
    pub fn session_permission_mode(
        &self,
        session_id: &str,
    ) -> Option<openbitfun_runtime_ports::PermissionMode> {
        self.coordinator
            .get_session_manager()
            .session_permission_mode(session_id)
    }

    pub async fn update_session_permission_mode(
        &self,
        session_id: &str,
        mode: Option<openbitfun_runtime_ports::PermissionMode>,
    ) -> OpenBitFunResult<()> {
        self.coordinator
            .get_session_manager()
            .update_session_permission_mode(session_id, mode)
            .await
    }

    pub fn active_turn_permission_mode(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Option<openbitfun_runtime_ports::PermissionMode> {
        self.coordinator
            .get_session_manager()
            .active_turn_permission_mode(session_id, turn_id)
    }

    pub fn set_active_turn_permission_mode(
        &self,
        session_id: &str,
        turn_id: &str,
        mode: openbitfun_runtime_ports::PermissionMode,
    ) -> bool {
        self.coordinator
            .get_session_manager()
            .set_active_turn_permission_mode(session_id, turn_id, mode)
    }

    pub fn clear_active_turn_permission_mode(&self, session_id: &str, turn_id: &str) -> bool {
        self.coordinator
            .get_session_manager()
            .clear_active_turn_permission_mode(session_id, turn_id)
    }

    /// Start a manual context compaction as a caller-identified turn.
    ///
    /// Detached dispatch supplies its own turn id so the compaction's
    /// DialogTurn/ContextCompression events can be attributed in its event
    /// log; completion is observed through those events, not awaited here.
    pub async fn start_manual_compaction(
        &self,
        session_id: String,
        turn_id: String,
    ) -> Result<(), String> {
        self.coordinator
            .start_manual_compaction_turn(session_id, turn_id)
            .await
            .map_err(|error| error.to_string())
    }

    /// Cancel a running tool execution on this host.
    ///
    /// The controller renders tool cards (e.g. the Terminal card's Interrupt
    /// button) for Turns this host owns, so it must be able to stop a running
    /// tool here. This is the per-tool interrupt contract behind the
    /// `cancel_tool` HostInvoke command; both Desktop and CLI Peer Hosts reach
    /// the same Core-owned coordinator the local UI does, one level finer than
    /// `cancel_dialog_turn`.
    pub async fn cancel_tool(&self, tool_id: &str, reason: String) -> Result<(), String> {
        self.coordinator
            .cancel_tool(tool_id, reason)
            .await
            .map_err(|error| error.to_string())
    }

    /// Applies the same Core deployment owner before a product compatibility
    /// path attaches to or mutates a structured workspace scope.
    pub fn ensure_workspace_runtime_ownership(
        &self,
        request: &SessionStoragePathRequest,
    ) -> OpenBitFunResult<()> {
        self.coordinator.ensure_workspace_runtime_ownership(
            &request.workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
    }

    /// Refresh user-visible declarative context without adding a second
    /// lifecycle owner. Skill discovery and Session prompt caching keep their
    /// existing owners; this method only coordinates one product request.
    pub async fn reload_session_context(
        &self,
        request: AgentContextReloadRequest,
    ) -> OpenBitFunResult<()> {
        let session_id = request.session_id.trim();
        validate_persisted_session_id(session_id)?;

        if self
            .coordinator
            .get_session_manager()
            .get_session(session_id)
            .is_none()
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Session '{session_id}' is not loaded"
            )));
        }

        if request.target.includes_skills() {
            SkillRegistry::global().refresh().await;
        }
        if request.target.includes_instructions() {
            self.coordinator
                .get_session_manager()
                .invalidate_prompt_cache(
                    session_id,
                    PromptCacheScope::UserContext,
                    "user_requested_instruction_reload",
                )
                .await;
        }

        Ok(())
    }

    pub async fn restore_session_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<Session> {
        validate_persisted_session_id(session_id)?;
        if include_internal {
            self.coordinator
                .restore_internal_session_from_storage_path(storage_path, session_id)
                .await
        } else {
            self.coordinator
                .restore_session_from_storage_path(storage_path, session_id)
                .await
        }
    }

    pub async fn restore_session_view_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
        include_internal: bool,
        tail_turn_count: Option<usize>,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionTurnCatalog,
        SessionViewRestoreTiming,
    )> {
        validate_persisted_session_id(session_id)?;
        let (session, turns, total_turn_count, mut timing) = if let Some(tail_turn_count) =
            tail_turn_count
        {
            if include_internal {
                self.coordinator
                    .restore_internal_session_view_from_storage_path_tail_timed(
                        storage_path,
                        session_id,
                        tail_turn_count,
                    )
                    .await?
            } else {
                self.coordinator
                    .restore_session_view_from_storage_path_tail_timed(
                        storage_path,
                        session_id,
                        tail_turn_count,
                    )
                    .await?
            }
        } else {
            let (session, turns, timing) = if include_internal {
                self.coordinator
                    .restore_internal_session_view_from_storage_path_timed(storage_path, session_id)
                    .await?
            } else {
                self.coordinator
                    .restore_session_view_from_storage_path_timed(storage_path, session_id)
                    .await?
            };
            let total_turn_count = turns.len();
            (session, turns, total_turn_count, timing)
        };
        let turn_catalog_started_at = Instant::now();
        let turn_catalog = self
            .persistence
            .load_session_turn_catalog(storage_path, session_id, &turns, total_turn_count)
            .await?;
        timing.turn_catalog_duration_ms = turn_catalog_started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        timing.total_duration_ms = timing
            .total_duration_ms
            .saturating_add(timing.turn_catalog_duration_ms);
        Ok((session, turns, total_turn_count, turn_catalog, timing))
    }

    pub async fn load_session_turn_window_from_storage_path(
        &self,
        storage_path: &Path,
        mut request: SessionTurnWindowRequest,
    ) -> OpenBitFunResult<SessionTurnWindowResponse> {
        validate_persisted_session_id(&request.session_id)?;
        if self
            .persistence
            .load_session_metadata(storage_path, &request.session_id)
            .await?
            .is_some_and(|metadata| {
                !request.include_internal && metadata.should_hide_from_user_lists()
            })
        {
            return Err(OpenBitFunError::NotFound(format!(
                "Session not found: {}",
                request.session_id
            )));
        }

        let _read = self
            .begin_persisted_session_read(storage_path, &request.session_id)
            .await?;
        request.workspace_path = storage_path.to_path_buf();
        self.persistence.load_session_turn_window(&request).await
    }

    pub async fn restore_session_with_turns_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        validate_persisted_session_id(session_id)?;
        if include_internal {
            self.coordinator
                .restore_internal_session_with_turns_from_storage_path(storage_path, session_id)
                .await
        } else {
            self.coordinator
                .restore_session_with_turns_from_storage_path(storage_path, session_id)
                .await
        }
    }

    pub async fn restore_session_view_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
        include_internal: bool,
        tail_turn_count: Option<usize>,
    ) -> OpenBitFunResult<(
        Session,
        Vec<DialogTurnData>,
        usize,
        SessionTurnCatalog,
        SessionViewRestoreTiming,
    )> {
        validate_persisted_session_id(session_id)?;
        let storage_path = self.resolve_persisted_session_storage_path(request).await?;
        self.restore_session_view_from_storage_path(
            &storage_path,
            session_id,
            include_internal,
            tail_turn_count,
        )
        .await
    }

    pub async fn restore_session_with_turns_for_workspace(
        &self,
        request: SessionStoragePathRequest,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<(Session, Vec<DialogTurnData>)> {
        validate_persisted_session_id(session_id)?;
        if include_internal {
            self.coordinator
                .restore_internal_session_with_turns_for_workspace(request, session_id)
                .await
        } else {
            self.coordinator
                .restore_session_with_turns_for_workspace(request, session_id)
                .await
        }
    }

    pub async fn list_persisted_sessions(
        &self,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Vec<SessionMetadata>> {
        self.persistence.list_session_metadata(workspace_path).await
    }

    pub async fn list_persisted_sessions_page(
        &self,
        workspace_path: &Path,
        cursor: Option<&str>,
        limit: usize,
    ) -> OpenBitFunResult<SessionMetadataPage> {
        self.persistence
            .list_session_metadata_page(workspace_path, cursor, limit)
            .await
    }

    /// A bounded navigation read over metadata + current runtime owners. Initial
    /// pages stay index-only; targeted reads can repair missing legacy outcomes
    /// without restoring a Session or changing execution state.
    pub async fn list_persisted_sessions_page_with_activity(
        &self,
        runtime: &AgentRuntime,
        workspace_path: &Path,
        cursor: Option<&str>,
        limit: usize,
        session_ids: Option<&[String]>,
    ) -> OpenBitFunResult<SessionMetadataPage> {
        use futures::StreamExt;
        use openbitfun_agent_runtime::session_state::SessionState;
        use openbitfun_services_core::session::page::{
            empty_session_metadata_page, SessionActivitySummary,
        };

        if let Some(ids) = session_ids {
            if ids.len() > 128 {
                return Err(OpenBitFunError::Validation(
                    "A session activity batch may contain at most 128 session ids".to_string(),
                ));
            }
            for id in ids {
                validate_persisted_session_id(id)?;
            }
        }
        let mut page = if session_ids.is_some() {
            empty_session_metadata_page()
        } else {
            self.list_persisted_sessions_page(workspace_path, cursor, limit)
                .await?
        };
        let selected = match session_ids {
            Some(ids) => {
                self.persistence
                    .session_metadata_by_ids(workspace_path, ids)
                    .await?
            }
            None => page.sessions.clone(),
        };
        // Capture the mailbox once for the batch, including delegated owners.
        let mut approvals = std::collections::HashMap::<String, usize>::new();
        for request in runtime.pending_permission_requests().map_err(|error| {
            OpenBitFunError::Service(format!(
                "Session activity permission snapshot unavailable: {error}"
            ))
        })? {
            *approvals.entry(request.session_id.clone()).or_default() += 1;
            if let Some(parent) = request.delegation {
                if parent.parent_session_id != request.session_id {
                    *approvals.entry(parent.parent_session_id).or_default() += 1;
                }
            }
        }
        let manager = self.coordinator.get_session_manager();
        let questions = openbitfun_agent_runtime::user_questions::get_user_input_manager()
            .pending_question_counts();
        let selected = futures::stream::iter(selected)
            .map(|metadata| {
                let manager = &manager;
                let approvals = &approvals;
                let questions = &questions;
                async move {
                    let native = metadata.custom_metadata.as_ref()
                        .and_then(|custom| custom.get(SESSION_PROVIDER_METADATA_KEY))
                        .and_then(serde_json::Value::as_str) != Some(SESSION_PROVIDER_ACP);
                    let live = matches!(manager.get_session_state(&metadata.session_id),
                        Some(SessionState::Processing { .. } | SessionState::Error { .. }))
                        || self.scheduler.is_session_busy_or_queued(&metadata.session_id)
                        || approvals.contains_key(&metadata.session_id)
                        || questions.contains_key(&metadata.session_id);
                    if native && !live && metadata.needs_last_turn_backfill() {
                        // Publish metadata immediately. The application-level
                        // sidebar synchronizer coalesces missing activities into
                        // a targeted batch instead of blocking the first page.
                        session_ids?;
                        let session_id = metadata.session_id.clone();
                        match self.persistence.backfill_session_last_turn(workspace_path, metadata).await {
                            Ok(metadata) => Some(metadata),
                            Err(error) => {
                                // Omit only this unavailable activity. Existing
                                // client backoff handles missing entries; the
                                // Session and its history remain untouched.
                                log::warn!("Failed to repair legacy session activity: session_id={}, error={}",
                                    session_id, error);
                                None
                            }
                        }
                    } else {
                        Some(metadata)
                    }
                }
            })
            .buffered(2)
            .filter_map(|metadata| async { metadata })
            .collect::<Vec<_>>()
            .await;
        page.activities = Some(
            selected
                .into_iter()
                .map(|metadata| {
                    let state = manager.get_session_state(&metadata.session_id);
                    let (execution, active_turn_id) = match state {
                        Some(SessionState::Processing {
                            current_turn_id, ..
                        }) => ("running", Some(current_turn_id)),
                        _ if self.scheduler.queue_depth(&metadata.session_id) > 0 => {
                            ("queued", None)
                        }
                        _ if self
                            .scheduler
                            .is_session_busy_or_queued(&metadata.session_id) =>
                        {
                            ("running", None)
                        }
                        Some(SessionState::Error { .. }) => ("error", None),
                        _ if metadata
                            .custom_metadata
                            .as_ref()
                            .and_then(|custom| custom.get(SESSION_PROVIDER_METADATA_KEY))
                            .and_then(serde_json::Value::as_str)
                            == Some(SESSION_PROVIDER_ACP) =>
                        {
                            ("external", None)
                        }
                        _ => ("idle", None),
                    };
                    SessionActivitySummary {
                        pending_approvals: approvals
                            .get(&metadata.session_id)
                            .copied()
                            .unwrap_or_default(),
                        pending_questions: questions
                            .get(&metadata.session_id)
                            .copied()
                            .unwrap_or_default(),
                        session_id: metadata.session_id,
                        execution: execution.to_string(),
                        active_turn_id,
                        last_turn: metadata.last_turn,
                        unread_completion: metadata.unread_completion,
                    }
                })
                .collect(),
        );
        Ok(page)
    }

    /// Search presentation-safe persisted Session content at an already-resolved
    /// sessions root. The SQLite sidecar is reconciled against authoritative
    /// metadata before every query and stale transcript rows are never served.
    #[cfg(feature = "product-search")]
    pub async fn search_persisted_session_content(
        &self,
        storage_path: &Path,
        query: &str,
        limit: usize,
        include_archived: bool,
    ) -> OpenBitFunResult<SessionContentSearchResponse> {
        let query = validated_session_content_search_query(query)?;
        if query.is_empty() {
            return Ok(SessionContentSearchResponse::default());
        }
        if !storage_path.exists() {
            return Ok(SessionContentSearchResponse::default());
        }

        let metadata = self.list_persisted_sessions(storage_path).await?;
        let documents = metadata
            .iter()
            .map(session_search_document)
            .collect::<Vec<_>>();
        let revisions = documents
            .iter()
            .map(|document| {
                (
                    document.session_id.clone(),
                    document.source_revision.clone(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        let index = SessionSearchSqliteIndex::new(storage_path);
        let reconciliation = index
            .reconcile_sessions(documents)
            .await
            .map_err(session_search_index_error)?;
        let mut diagnostics = Vec::new();

        for session_id in reconciliation.stale_session_ids {
            let Some(source_revision) = revisions.get(&session_id) else {
                continue;
            };
            let turns = match self
                .load_persisted_session_turns(storage_path, &session_id, None)
                .await
            {
                Ok(turns) => turns,
                Err(error) => {
                    log::warn!(
                        "Failed to read persisted Session for product search: session_id={session_id}, error={error}"
                    );
                    diagnostics.push(SessionSearchDiagnostic {
                        code: SessionSearchDiagnosticCode::SessionUnreadable,
                        session_id: Some(session_id),
                        message: "Session content could not be indexed".to_string(),
                    });
                    continue;
                }
            };
            let turn_documents = turns
                .iter()
                .filter(|turn| turn.kind == DialogTurnKind::UserDialog)
                .map(session_search_turn_document)
                .collect::<Vec<_>>();
            if let Err(error) = index
                .replace_session_turns(&session_id, source_revision, turn_documents)
                .await
            {
                match error {
                    SessionSearchIndexError::InvalidDocument(message) => {
                        log::warn!(
                            "Product search rejected a persisted Session document: session_id={session_id}, error={message}"
                        );
                        diagnostics.push(SessionSearchDiagnostic {
                            code: SessionSearchDiagnosticCode::SessionIndexStale,
                            session_id: Some(session_id),
                            message: "Session search index remained stale".to_string(),
                        });
                    }
                    error => return Err(session_search_index_error(error)),
                }
            }
        }

        let mut response = index
            .search(query, limit, include_archived)
            .await
            .map_err(session_search_index_error)?;
        response.diagnostics.extend(diagnostics);
        Ok(response)
    }

    pub async fn load_persisted_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionMetadata>> {
        validate_persisted_session_id(session_id)?;
        self.persistence
            .load_session_metadata(workspace_path, session_id)
            .await
    }

    /// True when an external agent (ACP), not this Runtime, drives the Session.
    ///
    /// The Runtime never starts or completes those Turns, so it holds no
    /// history branch for them and loading them into the Session manager only
    /// rewrites their mode to a local fallback. Their history is projected by
    /// the frontend, which is its only writer.
    pub async fn is_externally_projected_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        let metadata = self
            .load_persisted_session_metadata(workspace_path, session_id)
            .await?;
        Ok(metadata
            .as_ref()
            .and_then(|metadata| metadata.custom_metadata.as_ref())
            .and_then(|custom| custom.get(SESSION_PROVIDER_METADATA_KEY))
            .and_then(serde_json::Value::as_str)
            == Some(SESSION_PROVIDER_ACP))
    }

    pub async fn update_persisted_session_metadata(
        &self,
        workspace_path: &Path,
        session_id: &str,
        update: impl FnOnce(&mut SessionMetadata),
    ) -> OpenBitFunResult<()> {
        validate_persisted_session_id(session_id)?;
        self.persistence
            .update_session_metadata(workspace_path, session_id, update)
            .await
    }

    pub fn is_session_loaded_in_memory(&self, session_id: &str) -> OpenBitFunResult<bool> {
        validate_persisted_session_id(session_id)?;
        Ok(self
            .coordinator
            .get_session_manager()
            .get_session(session_id)
            .is_some())
    }

    /// Return the authoritative in-memory session snapshot when this process
    /// currently owns the session runtime.
    ///
    /// Persisted session state intentionally sanitizes `Processing` to `Idle`
    /// so a later process restart cannot resurrect work. Live read-only views
    /// (for example Peer Device controllers) still need the current process
    /// state to distinguish an executing session from interrupted history.
    pub fn loaded_session_snapshot(&self, session_id: &str) -> OpenBitFunResult<Option<Session>> {
        validate_persisted_session_id(session_id)?;
        Ok(self
            .coordinator
            .get_session_manager()
            .get_session(session_id))
    }

    pub async fn update_loaded_session_title(
        &self,
        session_id: &str,
        title: &str,
    ) -> OpenBitFunResult<String> {
        validate_persisted_session_id(session_id)?;
        self.coordinator
            .update_session_title(session_id, title)
            .await
    }

    pub async fn resolve_persisted_session_storage_path(
        &self,
        request: SessionStoragePathRequest,
    ) -> OpenBitFunResult<PathBuf> {
        CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
            .resolve_session_storage_path(request)
            .await
            .map(|resolution| resolution.effective_storage_path)
            .map_err(|error| OpenBitFunError::Session(error.to_string()))
    }

    pub fn is_session_loaded_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<bool> {
        validate_persisted_session_id(session_id)?;
        self.coordinator
            .get_session_manager()
            .is_session_loaded_from_storage_path(storage_path, session_id)
    }

    pub async fn ensure_session_loaded_from_storage_path(
        &self,
        storage_path: &Path,
        session_id: &str,
        include_internal: bool,
    ) -> OpenBitFunResult<()> {
        if self.is_session_loaded_from_storage_path(storage_path, session_id)? {
            return Ok(());
        }
        if include_internal {
            self.coordinator
                .restore_internal_session_from_storage_path(storage_path, session_id)
                .await?;
        } else {
            self.coordinator
                .restore_session_from_storage_path(storage_path, session_id)
                .await?;
        }
        Ok(())
    }

    pub async fn begin_persisted_session_mutation(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<CoreSessionMutationPermit> {
        validate_persisted_session_id(session_id)?;
        let session_manager = self.coordinator.get_session_manager();
        let guard = session_manager.acquire_session_mutation(session_id).await?;
        session_manager.validate_session_storage_path_binding(session_id, storage_path)?;
        Ok(CoreSessionMutationPermit {
            _guard: guard,
            session_id: session_id.to_string(),
            storage_path: storage_path.to_path_buf(),
        })
    }

    /// Admit an external history import only when no undo/redo transaction is
    /// active. The returned permit must remain alive for the complete batch.
    /// Importers intentionally fail closed instead of guessing how a remote
    /// history should merge with a locally staged branch.
    pub async fn begin_external_persisted_history_write(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<CoreSessionMutationPermit> {
        let permit = self
            .begin_persisted_session_mutation(storage_path, session_id)
            .await?;
        if self
            .persistence
            .load_session_revert_state(storage_path, session_id)
            .await?
            .is_some()
        {
            return Err(OpenBitFunError::SessionInUse {
                session_id: session_id.to_string(),
            });
        }
        Ok(permit)
    }

    pub async fn begin_persisted_session_read(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<CoreSessionReadPermit> {
        begin_consistent_persisted_session_read(
            self.coordinator.as_ref(),
            self.persistence.as_ref(),
            storage_path,
            session_id,
            None,
        )
        .await
    }

    pub async fn begin_persisted_session_read_for_workspace(
        &self,
        storage_path: &Path,
        session_id: &str,
        workspace: &WorkspaceSessionIdentity,
    ) -> OpenBitFunResult<CoreSessionReadPermit> {
        begin_consistent_persisted_session_read(
            self.coordinator.as_ref(),
            self.persistence.as_ref(),
            storage_path,
            session_id,
            Some(workspace),
        )
        .await
    }

    pub async fn begin_session_maintenance(
        &self,
        storage_path: &Path,
        session_id: &str,
        wait_timeout_ms: u64,
    ) -> OpenBitFunResult<CoreSessionMaintenancePermit> {
        let permit = self
            .scheduler
            .begin_session_maintenance(
                session_id,
                storage_path,
                std::time::Duration::from_millis(wait_timeout_ms),
            )
            .await?;
        Ok(CoreSessionMaintenancePermit { _permit: permit })
    }

    /// Compatibility-only lifecycle operation for ACP setup compensation and
    /// session/close. It releases loaded Core state but preserves persistence
    /// and the storage binding so the same session can be restored later.
    pub async fn unload_persisted_session(&self, session_id: &str) -> OpenBitFunResult<bool> {
        validate_persisted_session_id(session_id)?;
        self.coordinator
            .get_session_manager()
            .unload_session_from_memory(session_id)
            .await
    }

    pub async fn cancel_background_subagents_for_parent(
        &self,
        parent_session_id: &str,
        subagent_session_id: &str,
    ) -> OpenBitFunResult<usize> {
        self.coordinator
            .cancel_background_subagents_for_parent(parent_session_id, subagent_session_id, true)
            .await
    }

    pub async fn rollback_persisted_session_context_to_turn_start(
        &self,
        permit: &CoreSessionMutationPermit,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        self.coordinator
            .get_session_manager()
            .rollback_context_to_turn_start_locked(
                &permit.storage_path,
                &permit.session_id,
                target_turn,
            )
            .await
    }

    pub async fn validate_persisted_session_context_rollback(
        &self,
        permit: &CoreSessionMutationPermit,
        target_turn: usize,
    ) -> OpenBitFunResult<()> {
        self.coordinator
            .get_session_manager()
            .validate_rollback_context_to_turn_start_locked(
                &permit.storage_path,
                &permit.session_id,
                target_turn,
            )
            .await
    }

    /// Commits any staged Session undo before a snapshot mutation starts a
    /// different destructive history branch. The caller must retain the
    /// mutation permit through the complete snapshot operation.
    pub async fn commit_session_revert_before_snapshot_mutation(
        &self,
        permit: &CoreSessionMutationPermit,
    ) -> OpenBitFunResult<()> {
        self.coordinator
            .commit_session_revert_locked(&permit.storage_path, &permit.session_id)
            .await
    }

    /// Snapshot recording belongs to an already admitted turn and must never
    /// append operation history behind a staged Session undo boundary.
    pub async fn ensure_snapshot_record_allowed(
        &self,
        permit: &CoreSessionMutationPermit,
    ) -> OpenBitFunResult<()> {
        if self
            .persistence
            .load_session_revert_state(&permit.storage_path, &permit.session_id)
            .await?
            .is_some()
        {
            return Err(OpenBitFunError::OutcomeUnknown(format!(
                "Snapshot recording is not allowed while a Session undo is staged: session_id={}",
                permit.session_id
            )));
        }
        Ok(())
    }

    pub async fn load_persisted_session_turns(
        &self,
        storage_path: &Path,
        session_id: &str,
        limit: Option<usize>,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        let read = self
            .begin_persisted_session_read(storage_path, session_id)
            .await?;
        load_visible_persisted_session_turns(
            self.persistence.as_ref(),
            storage_path,
            session_id,
            read.visible_turn_end(),
            limit,
        )
        .await
    }

    pub async fn load_persisted_session_turns_for_mutation(
        &self,
        permit: &CoreSessionMutationPermit,
        limit: Option<usize>,
    ) -> OpenBitFunResult<Vec<DialogTurnData>> {
        let visible_turn_end = self
            .persistence
            .load_session_revert_state(&permit.storage_path, &permit.session_id)
            .await?
            .map(|state| state.boundary_turn);
        load_visible_persisted_session_turns(
            self.persistence.as_ref(),
            &permit.storage_path,
            &permit.session_id,
            visible_turn_end,
            limit,
        )
        .await
    }

    pub async fn export_persisted_session_transcript(
        &self,
        storage_path: &Path,
        session_id: &str,
        options: &SessionTranscriptExportOptions,
    ) -> OpenBitFunResult<SessionTranscriptExport> {
        let _read = self
            .begin_persisted_session_read(storage_path, session_id)
            .await?;
        self.persistence
            .export_session_transcript(storage_path, session_id, options)
            .await
    }

    pub async fn touch_persisted_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        validate_persisted_session_id(session_id)?;
        self.persistence
            .touch_session(workspace_path, session_id)
            .await
    }

    pub async fn save_persisted_dialog_turn(
        &self,
        permit: &CoreSessionMutationPermit,
        turn: &DialogTurnData,
    ) -> OpenBitFunResult<()> {
        validate_persisted_session_id(&turn.session_id)?;
        if turn.session_id != permit.session_id {
            return Err(OpenBitFunError::Validation(format!(
                "Turn session does not match the active mutation: turn_session_id={}, mutation_session_id={}",
                turn.session_id, permit.session_id
            )));
        }
        if self
            .is_externally_projected_session(&permit.storage_path, &permit.session_id)
            .await?
        {
            // No Runtime history branch exists to validate against: the external
            // agent owns the conversation and the projection is the only writer.
            return self
                .persistence
                .save_dialog_turn(&permit.storage_path, turn)
                .await;
        }
        let session = self
            .coordinator
            .get_session_manager()
            .get_session(&permit.session_id)
            .ok_or_else(|| {
                OpenBitFunError::OutcomeUnknown(format!(
                    "Session must be loaded before saving a projected Turn: session_id={}",
                    permit.session_id
                ))
            })?;
        let expected_turn_id = session.dialog_turn_ids.get(turn.turn_index);
        if expected_turn_id != Some(&turn.turn_id) {
            return Err(OpenBitFunError::Validation(format!(
                "Turn does not belong to the active Session history branch: session_id={}, turn_index={}, turn_id={}",
                permit.session_id, turn.turn_index, turn.turn_id
            )));
        }
        let mut projected = turn.clone();
        if let Some(persisted) = self
            .persistence
            .load_dialog_turn(&permit.storage_path, &permit.session_id, turn.turn_index)
            .await?
        {
            if projected_turn_save_would_overwrite_runtime_state(&persisted, turn) {
                log::debug!(
                    "Ignoring stale projected Turn save owned by the runtime: session_id={}, turn_id={}, persisted_status={:?}, projected_status={:?}",
                    permit.session_id,
                    turn.turn_id,
                    persisted.status,
                    turn.status
                );
                return Ok(());
            }
            projected = merge_runtime_owned_turn_facts(&persisted, turn);
        }
        self.persistence
            .save_dialog_turn(&permit.storage_path, &projected)
            .await
    }

    pub async fn delete_hidden_subagent_sessions_for_parent_turns(
        &self,
        workspace_path: &Path,
        parent_session_id: &str,
        parent_dialog_turn_ids: &std::collections::HashSet<String>,
    ) -> OpenBitFunResult<Vec<String>> {
        validate_persisted_session_id(parent_session_id)?;
        self.coordinator
            .delete_hidden_subagent_sessions_for_parent_turns(
                workspace_path,
                parent_session_id,
                parent_dialog_turn_ids,
            )
            .await
    }
}

#[cfg(feature = "product-search")]
fn session_search_document(metadata: &SessionMetadata) -> SessionSearchSessionDocument {
    SessionSearchSessionDocument {
        session_id: metadata.session_id.clone(),
        title: metadata.session_name.clone(),
        tags: metadata.tags.clone(),
        archived: metadata.status == SessionStatus::Archived,
        updated_at_ms: i64::try_from(metadata.last_active_at).unwrap_or(i64::MAX),
        source_revision: format!(
            "v1:{}:{}:{}:{}:{}",
            metadata.turn_count,
            metadata.message_count,
            metadata.tool_call_count,
            metadata.last_active_at,
            metadata.last_finished_at.unwrap_or_default(),
        ),
    }
}

#[cfg(feature = "product-search")]
fn session_search_turn_document(turn: &DialogTurnData) -> SessionSearchTurnDocument {
    SessionSearchTurnDocument {
        session_id: turn.session_id.clone(),
        turn_id: turn.turn_id.clone(),
        turn_index: turn.turn_index,
        user_text: transcript_display_user_content(turn),
        assistant_text: transcript_display_assistant_content(turn),
        updated_at_ms: i64::try_from(turn.end_time.unwrap_or(turn.timestamp)).unwrap_or(i64::MAX),
    }
}

#[cfg(feature = "product-search")]
fn session_search_index_error(error: SessionSearchIndexError) -> OpenBitFunError {
    log::warn!("Product search index operation failed: {error}");
    OpenBitFunError::Session("Session content search is temporarily unavailable".to_string())
}

#[cfg(feature = "product-search")]
fn validated_session_content_search_query(query: &str) -> OpenBitFunResult<&str> {
    let query = query.trim();
    if query.chars().count() > MAX_SESSION_CONTENT_SEARCH_QUERY_CHARS {
        return Err(OpenBitFunError::Validation(format!(
            "Session content search queries must not exceed {MAX_SESSION_CONTENT_SEARCH_QUERY_CHARS} characters"
        )));
    }
    Ok(query)
}

#[async_trait::async_trait]
impl AgentContextReloadPort for CoreAgentRuntimeCompatibility {
    async fn reload_session_context(
        &self,
        request: AgentContextReloadRequest,
    ) -> openbitfun_runtime_ports::PortResult<()> {
        CoreAgentRuntimeCompatibility::reload_session_context(self, request)
            .await
            .map_err(|error| {
                openbitfun_runtime_ports::PortError::new(
                    openbitfun_runtime_ports::PortErrorKind::Backend,
                    error.to_string(),
                )
            })
    }
}

#[cfg(feature = "product-search")]
#[async_trait::async_trait]
impl ProductSearchPort for CoreAgentRuntimeCompatibility {
    async fn search_session_content(
        &self,
        request: SessionContentSearchRequest,
    ) -> PortResult<SessionContentSearchResponse> {
        let limit = request.normalized_limit();
        let workspace_id = request
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let storage_path = if let Some(workspace_id) = workspace_id {
            CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
                .resolve_workspace_storage(workspace_id)
                .await?
                .effective_storage_path
        } else {
            // Legacy peers identify the workspace only by path.
            if request.workspace_path.trim().is_empty() {
                return Err(PortError::new(
                    PortErrorKind::InvalidRequest,
                    "Session content search requires a workspace ID",
                ));
            }
            self.resolve_persisted_session_storage_path(SessionStoragePathRequest {
                workspace_path: PathBuf::from(request.workspace_path),
                remote_connection_id: request.remote_connection_id,
                remote_ssh_host: request.remote_ssh_host,
            })
            .await
            .map_err(runtime_port_error)?
        };
        self.search_persisted_session_content(
            &storage_path,
            &request.query,
            limit,
            request.include_archived,
        )
        .await
        .map_err(runtime_port_error)
    }
}

#[derive(Clone)]
struct CoreSessionOperationsPort {
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
    persistence: Arc<PersistenceManager>,
    token_usage_service: Arc<TokenUsageService>,
}

impl CoreSessionOperationsPort {
    fn new(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
    ) -> Self {
        let persistence = coordinator.get_session_manager().persistence_manager();
        Self {
            coordinator,
            scheduler,
            persistence,
            token_usage_service,
        }
    }

    /// Session storage for a request that names its workspace by ID, falling
    /// back to the legacy path selector only for pre-ID producers.
    async fn resolve_session_storage_for_reference(
        &self,
        workspace_id: Option<&str>,
        workspace_path: &str,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
    ) -> PortResult<PathBuf> {
        CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
            .resolve_storage_for_reference(
                workspace_id,
                workspace_path,
                remote_connection_id,
                remote_ssh_host,
            )
            .await
            .map(|resolution| resolution.effective_storage_path)
    }

    async fn resolve_fork_workspace_id(
        &self,
        workspace_id: Option<&str>,
        legacy_path: &str,
        legacy_connection: Option<&str>,
        legacy_host: Option<&str>,
        source_session_id: &str,
    ) -> PortResult<String> {
        let service =
            crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
                runtime_port_error(OpenBitFunError::service("Workspace service is unavailable"))
            })?;
        let record = match workspace_id {
            Some(id) => service
                .require_workspace(id)
                .await
                .map_err(runtime_port_error)?,
            None => service
                .resolve_legacy_fork_workspace_reference(
                    self.coordinator.get_session_manager().as_ref(),
                    legacy_path,
                    legacy_connection,
                    legacy_host,
                    source_session_id,
                )
                .await
                .map_err(runtime_port_error)?,
        };
        Ok(record.id)
    }

    async fn validate_lineage_descendant(
        &self,
        storage_path: &Path,
        root_session_id: &str,
        session_id: &str,
    ) -> PortResult<()> {
        validate_persisted_lineage_descendant(
            self.persistence.as_ref(),
            storage_path,
            root_session_id,
            session_id,
        )
        .await
    }

    async fn fork_at_persisted_turn(
        &self,
        storage_path: &Path,
        source_session_id: String,
        source_turn_id: Option<String>,
        boundary: SessionBranchBoundary,
        workspace_id: &str,
    ) -> PortResult<AgentSessionForkResult> {
        if source_turn_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "source turn id is required",
            ));
        }
        let session_manager = self.coordinator.get_session_manager();
        let expected_workspace = {
            let _guard = session_manager
                .acquire_session_mutation(&source_session_id)
                .await
                .map_err(runtime_port_error)?;
            session_manager
                .validate_session_storage_path_binding(&source_session_id, storage_path)
                .map_err(runtime_port_error)?;
            let persisted = self
                .persistence
                .load_session_header(storage_path, &source_session_id)
                .await
                .map_err(runtime_port_error)?;
            let binding = fork_workspace_binding(&persisted, workspace_id)
                .await
                .map_err(runtime_port_error)?;
            let execution_id = binding.workspace_id.as_deref().expect("resolved binding");
            if let Some(loaded) = session_manager.get_session(&source_session_id) {
                fork_workspace_binding(&loaded, execution_id)
                    .await
                    .map_err(runtime_port_error)?;
            }
            self.coordinator
                .ensure_workspace_runtime_ownership(
                    binding.root_path(),
                    binding.session_identity.remote_connection_id.as_deref(),
                    if binding.is_remote() {
                        Some(binding.session_identity.hostname.as_str())
                    } else {
                        None
                    },
                )
                .map_err(runtime_port_error)?;
            execution_id.to_owned()
        };
        if !session_manager
            .is_session_loaded_from_storage_path(storage_path, &source_session_id)
            .map_err(runtime_port_error)?
        {
            // Restore owns its own mutation lock. Do not use Coordinator's
            // restore-and-reconcile facade: identity must be rechecked before
            // an unfinished undo transition can change files or history.
            session_manager
                .restore_session_from_storage_path(storage_path, &source_session_id)
                .await
                .map_err(runtime_port_error)?;
        }
        let _mutation_guard = session_manager
            .acquire_session_mutation(&source_session_id)
            .await
            .map_err(runtime_port_error)?;
        session_manager
            .validate_session_storage_path_binding(&source_session_id, storage_path)
            .map_err(runtime_port_error)?;
        if let Some(loaded) = session_manager.get_session(&source_session_id) {
            fork_workspace_binding(&loaded, &expected_workspace)
                .await
                .map_err(runtime_port_error)?;
        }
        let persisted = self
            .persistence
            .load_session_header(storage_path, &source_session_id)
            .await
            .map_err(runtime_port_error)?;
        fork_workspace_binding(&persisted, &expected_workspace)
            .await
            .map_err(runtime_port_error)?;

        self.coordinator
            .reconcile_session_revert_locked(storage_path, &source_session_id)
            .await
            .map_err(runtime_port_error)?;
        let revert_boundary = self
            .persistence
            .load_session_revert_state(storage_path, &source_session_id)
            .await
            .map_err(runtime_port_error)?
            .map(|state| state.boundary_turn);
        let source_turns = self
            .persistence
            .load_session_turns(storage_path, &source_session_id)
            .await
            .map_err(runtime_port_error)?;
        let source_turn_id = match source_turn_id {
            Some(source_turn_id) => {
                let source_turn = source_turns
                    .iter()
                    .find(|turn| turn.turn_id == source_turn_id)
                    .ok_or_else(|| {
                        PortError::new(
                            PortErrorKind::NotFound,
                            format!("Source turn not found in persisted session: {source_turn_id}"),
                        )
                    })?;
                if revert_boundary
                    .is_some_and(|boundary_turn| source_turn.turn_index >= boundary_turn)
                {
                    return Err(PortError::new(
                        PortErrorKind::InvalidRequest,
                        "Cannot fork from a turn hidden by the current Session undo boundary",
                    ));
                }
                source_turn_id
            }
            None => latest_persisted_turn_id(
                &source_turns
                    .into_iter()
                    .filter(|turn| {
                        revert_boundary.is_none_or(|boundary_turn| turn.turn_index < boundary_turn)
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(runtime_port_error)?,
        };
        let source_session_id_for_coordination = source_session_id.clone();
        let result = self
            .persistence
            .branch_session(
                storage_path,
                &SessionBranchRequest {
                    source_session_id,
                    source_turn_id,
                    boundary,
                },
            )
            .await
            .map_err(runtime_port_error)?;
        if let Err(error) = self
            .coordinator
            .initialize_fork_coordination(&source_session_id_for_coordination, &result.session_id)
            .await
        {
            if let Err(cleanup_error) = self
                .persistence
                .delete_session(storage_path, &result.session_id)
                .await
            {
                return Err(PortError::new(
                    PortErrorKind::CleanupRequired,
                    format!(
                        "Session fork coordination initialization failed and rollback did not complete: session_id={}, error={}, cleanup_error={}",
                        result.session_id, error, cleanup_error
                    ),
                ));
            }
            return Err(runtime_port_error(error));
        }
        Ok(AgentSessionForkResult {
            session_id: result.session_id,
            session_name: result.session_name,
            agent_type: result.agent_type,
        })
    }
}

async fn validate_persisted_lineage_descendant(
    persistence: &PersistenceManager,
    storage_path: &Path,
    root_session_id: &str,
    session_id: &str,
) -> PortResult<()> {
    if session_id == root_session_id {
        return Err(PortError::new(
            PortErrorKind::InvalidRequest,
            "Lineage target is not a descendant of the requested root",
        ));
    }

    let mut current_session_id = session_id.to_string();
    let mut visited = std::collections::HashSet::new();
    loop {
        if !visited.insert(current_session_id.clone()) {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Session lineage contains a parent cycle",
            ));
        }
        let metadata = persistence
            .load_session_metadata(storage_path, &current_session_id)
            .await
            .map_err(runtime_port_error)?
            .ok_or_else(|| {
                PortError::new(
                    if current_session_id == session_id {
                        PortErrorKind::NotFound
                    } else {
                        PortErrorKind::InvalidRequest
                    },
                    format!("Session lineage entry was not found: {current_session_id}"),
                )
            })?;
        let parent_session_id = normalized_session_relationship(&metadata)
            .filter(|relationship| relationship.kind == Some(SessionRelationshipKind::Subagent))
            .and_then(|relationship| relationship.parent_session_id)
            .map(|parent_session_id| parent_session_id.trim().to_string())
            .filter(|parent_session_id| !parent_session_id.is_empty());
        if current_session_id == root_session_id {
            let Some(parent_session_id) = parent_session_id else {
                return Ok(());
            };
            // Match `build_session_lineage_snapshot`: a broken parent link
            // makes the current entry the effective root, while an existing
            // parent proves that the requested root is only an intermediate
            // descendant.
            if persistence
                .load_session_metadata(storage_path, &parent_session_id)
                .await
                .map_err(runtime_port_error)?
                .is_none()
            {
                return Ok(());
            }
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Lineage target is not a descendant of the requested root",
            ));
        }
        current_session_id = parent_session_id.ok_or_else(|| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                "Lineage target is not a descendant of the requested root",
            )
        })?;
    }
}

fn runtime_port_error(error: OpenBitFunError) -> PortError {
    let kind = match &error {
        OpenBitFunError::Validation(_) => PortErrorKind::InvalidRequest,
        OpenBitFunError::NotFound(_) => PortErrorKind::NotFound,
        OpenBitFunError::Timeout(_) => PortErrorKind::Timeout,
        OpenBitFunError::Cancelled(_) => PortErrorKind::Cancelled,
        OpenBitFunError::SessionInUse { .. } => PortErrorKind::SessionInUse,
        OpenBitFunError::SessionCreateCleanupRequired { .. } => PortErrorKind::CleanupRequired,
        OpenBitFunError::OutcomeUnknown(_) => PortErrorKind::OutcomeUnknown,
        _ => PortErrorKind::Backend,
    };
    PortError::new(kind, error.to_string())
}

#[async_trait::async_trait]
impl AgentSessionLineagePort for CoreSessionOperationsPort {
    async fn get_session_lineage(
        &self,
        request: AgentSessionLineageRequest,
    ) -> PortResult<Option<AgentSessionLineageSnapshot>> {
        validate_persisted_session_id(&request.anchor_session_id).map_err(runtime_port_error)?;
        let service =
            crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
                PortError::new(
                    PortErrorKind::NotAvailable,
                    "Workspace service is unavailable",
                )
            })?;
        // Upgrade-only ingress: convert old wire payloads once, then route by ID.
        let workspace = service
            .resolve_legacy_workspace_reference(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.as_deref(),
                request.remote_ssh_host.as_deref(),
            )
            .await
            .map_err(runtime_port_error)?
            .ok_or_else(|| {
                PortError::new(PortErrorKind::InvalidRequest, "Workspace ID is unavailable")
            })?;
        let resolution =
            CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
                .resolve_workspace_storage(&workspace.id)
                .await?;
        let storage_path = resolution.effective_storage_path;
        let metadata = self
            .persistence
            .list_session_metadata_including_internal(&storage_path)
            .await
            .map_err(runtime_port_error)?;
        let Some(snapshot) = build_session_lineage_snapshot(metadata, &request.anchor_session_id)
        else {
            return Ok(None);
        };
        let mut snapshot = runtime_lineage_snapshot(
            snapshot,
            resolution.remote_connection_id.as_deref(),
            resolution.remote_ssh_host.as_deref(),
        );
        let session_manager = self.coordinator.get_session_manager();
        for entry in &mut snapshot.sessions {
            entry.active_turn_id = session_manager
                .active_turn_id_in_storage_path(&storage_path, &entry.session_id)
                .await
                .map_err(runtime_port_error)?;
            if let Some(parent_session_id) = entry.parent_session_id.as_deref() {
                entry.agent_id = self
                    .coordinator
                    .existing_agent_id_for_subagent_session(parent_session_id, &entry.session_id)
                    .await
                    .map_err(runtime_port_error)?;
            }
        }
        Ok(Some(snapshot))
    }

    async fn read_lineage_session_transcript(
        &self,
        request: AgentSessionLineageTranscriptRequest,
    ) -> PortResult<AgentSessionLineageInspection> {
        validate_persisted_session_id(&request.root_session_id).map_err(runtime_port_error)?;
        validate_persisted_session_id(&request.session_id).map_err(runtime_port_error)?;
        let storage_path = self
            .resolve_session_storage_for_reference(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            )
            .await?;
        self.validate_lineage_descendant(
            &storage_path,
            &request.root_session_id,
            &request.session_id,
        )
        .await?;

        let session_manager = self.coordinator.get_session_manager();
        if let Some(inspection) = self
            .scheduler
            .inspect_loaded_lineage_session(
                &storage_path,
                SessionTranscriptRequest {
                    session_id: request.session_id.clone(),
                    turn_id: None,
                },
                &request.required_settled_turn_ids,
            )
            .await?
        {
            return Ok(inspection);
        }

        let (_, turns, _) = session_manager
            .restore_internal_session_view_from_storage_path_timed(
                &storage_path,
                &request.session_id,
            )
            .await
            .map_err(runtime_port_error)?;
        validate_required_lineage_turns_settled(&turns, &request.required_settled_turn_ids)?;
        Ok(AgentSessionLineageInspection {
            transcript: SessionTranscript {
                session_id: request.session_id,
                messages: runtime_transcript_messages_from_turns(&turns, None),
            },
            active_turn_id: None,
        })
    }

    async fn cancel_lineage_session(
        &self,
        request: AgentSessionLineageCancellationRequest,
    ) -> PortResult<AgentTurnCancellationResult> {
        let AgentSessionLineageCancellationRequest {
            workspace_id,
            workspace_path,
            root_session_id,
            session_id,
            expected_active_turn_id,
            wait_timeout_ms,
            remote_connection_id,
            remote_ssh_host,
            ..
        } = request;
        validate_persisted_session_id(&root_session_id).map_err(runtime_port_error)?;
        validate_persisted_session_id(&session_id).map_err(runtime_port_error)?;
        let wait_timeout = Duration::from_millis(wait_timeout_ms.unwrap_or(1500));
        let deadline = Instant::now() + wait_timeout;
        let storage_path = match tokio::time::timeout(wait_timeout, async {
            let storage_path = self
                .resolve_session_storage_for_reference(
                    workspace_id.as_deref(),
                    &workspace_path,
                    remote_connection_id,
                    remote_ssh_host,
                )
                .await?;
            self.validate_lineage_descendant(&storage_path, &root_session_id, &session_id)
                .await?;
            Ok(storage_path)
        })
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                return Err(PortError::new(
                    PortErrorKind::Timeout,
                    "Subagent Session cancellation validation exceeded its deadline",
                ))
            }
        };
        let cancelled_turn_id = self
            .scheduler
            .cancel_lineage_session_in_storage(
                &storage_path,
                &session_id,
                expected_active_turn_id.as_deref(),
                deadline.saturating_duration_since(Instant::now()),
            )
            .await
            .map_err(runtime_port_error)?;
        Ok(AgentTurnCancellationResult {
            session_id,
            requested: cancelled_turn_id.is_some(),
            turn_id: cancelled_turn_id,
        })
    }
}

#[async_trait::async_trait]
impl AgentSessionForkPort for CoreSessionOperationsPort {
    async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> PortResult<AgentSessionForkResult> {
        let workspace_id = self
            .resolve_fork_workspace_id(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.as_deref(),
                request.remote_ssh_host.as_deref(),
                &request.source_session_id,
            )
            .await?;
        let storage_path =
            CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
                .resolve_workspace_storage(&workspace_id)
                .await?
                .effective_storage_path;
        self.fork_at_persisted_turn(
            &storage_path,
            request.source_session_id,
            None,
            SessionBranchBoundary::ThroughTurn,
            &workspace_id,
        )
        .await
    }
    async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        let workspace_id = self
            .resolve_fork_workspace_id(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.as_deref(),
                request.remote_ssh_host.as_deref(),
                &request.source_session_id,
            )
            .await?;
        let storage_path =
            CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
                .resolve_workspace_storage(&workspace_id)
                .await?
                .effective_storage_path;
        self.fork_at_persisted_turn(
            &storage_path,
            request.source_session_id,
            Some(request.source_turn_id),
            SessionBranchBoundary::ThroughTurn,
            &workspace_id,
        )
        .await
    }
    async fn fork_session_before_turn(
        &self,
        request: AgentSessionForkBeforeTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        let workspace_id = self
            .resolve_fork_workspace_id(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.as_deref(),
                request.remote_ssh_host.as_deref(),
                &request.source_session_id,
            )
            .await?;
        let storage_path =
            CoreSessionStorePort::with_path_manager(self.persistence.path_manager().clone())
                .resolve_workspace_storage(&workspace_id)
                .await?
                .effective_storage_path;
        self.fork_at_persisted_turn(
            &storage_path,
            request.source_session_id,
            Some(request.source_turn_id),
            SessionBranchBoundary::BeforeTurn,
            &workspace_id,
        )
        .await
    }
}

#[async_trait::async_trait]
impl AgentSessionUsagePort for CoreSessionOperationsPort {
    async fn generate_session_usage(
        &self,
        request: AgentSessionUsageRequest,
    ) -> PortResult<SessionUsageReport> {
        if request.workspace_id.is_none() && request.workspace_path.is_none() {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Workspace ID is required for usage reports",
            ));
        }
        let storage_path = self
            .resolve_session_storage_for_reference(
                request.workspace_id.as_deref(),
                request.workspace_path.as_deref().unwrap_or_default(),
                request.remote_connection_id.clone(),
                request.remote_ssh_host.clone(),
            )
            .await?;
        let _read = begin_consistent_persisted_session_read(
            self.coordinator.as_ref(),
            self.persistence.as_ref(),
            &storage_path,
            &request.session_id,
            None,
        )
        .await
        .map_err(runtime_port_error)?;
        generate_core_session_usage_report(
            self.persistence.as_ref(),
            self.token_usage_service.as_ref(),
            &storage_path,
            request,
        )
        .await
        .map_err(runtime_port_error)
    }
}

#[async_trait::async_trait]
impl AgentTurnSettlementPort for CoreSessionOperationsPort {
    async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> PortResult<AgentTurnSettlementResult> {
        if request.wait_timeout_ms == 0 {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "turn settlement timeout must be greater than zero",
            ));
        }
        let wait_error = self
            .coordinator
            .wait_for_turn_settlement(
                &request.session_id,
                &request.turn_id,
                Duration::from_millis(request.wait_timeout_ms),
            )
            .await
            .err()
            .map(runtime_port_error);
        if let Some(error) = wait_error
            .as_ref()
            .filter(|error| error.kind != PortErrorKind::OutcomeUnknown)
        {
            return Err(error.clone());
        }

        let session_manager = self.coordinator.get_session_manager();
        let _mutation = session_manager
            .acquire_session_mutation(&request.session_id)
            .await
            .map_err(runtime_port_error)?;
        let turn_is_loaded = session_manager
            .get_session(&request.session_id)
            .is_some_and(|session| {
                session
                    .dialog_turn_ids
                    .iter()
                    .any(|turn_id| turn_id == &request.turn_id)
            });
        let persisted_turns = session_manager
            .load_persisted_transcript_turns_locked(&request.session_id)
            .await
            .map_err(runtime_port_error)?;
        let turn = persisted_turns
            .as_deref()
            .and_then(|turns| turns.iter().find(|turn| turn.turn_id == request.turn_id));

        if let Some(turn) = turn.filter(|turn| turn.status != TurnStatus::InProgress) {
            let persisted_result = persisted_turn_settlement_result(turn)?;
            if let Some(cached_result) = session_manager
                .turn_settlement_result(&request.session_id, &request.turn_id)
                .filter(|cached| cached.status == persisted_result.status)
            {
                return Ok(cached_result);
            }
            return Ok(persisted_result);
        }
        if persisted_turns.is_none() && turn_is_loaded {
            if let Some(cached_result) =
                session_manager.turn_settlement_result(&request.session_id, &request.turn_id)
            {
                return Ok(cached_result);
            }
        }
        if let Some(error) = wait_error {
            return Err(error);
        }

        Err(PortError::new(
            PortErrorKind::OutcomeUnknown,
            format!(
                "Authoritative turn result is unavailable: session_id={}, turn_id={}",
                request.session_id, request.turn_id
            ),
        ))
    }
}

fn persisted_turn_settlement_result(
    turn: &DialogTurnData,
) -> PortResult<AgentTurnSettlementResult> {
    let final_response = transcript_final_assistant_content(turn);
    let status = match turn.status {
        TurnStatus::Completed if turn.has_final_response != Some(false) => {
            AgentTurnSettlementStatus::Completed
        }
        TurnStatus::Completed | TurnStatus::Error => AgentTurnSettlementStatus::Failed,
        TurnStatus::Cancelled => AgentTurnSettlementStatus::Cancelled,
        TurnStatus::InProgress => {
            return Err(PortError::new(
                PortErrorKind::OutcomeUnknown,
                format!("Dialog turn is still in progress: {}", turn.turn_id),
            ));
        }
    };

    Ok(AgentTurnSettlementResult {
        final_response: (status == AgentTurnSettlementStatus::Completed)
            .then_some(final_response)
            .flatten(),
        finish_reason: turn.finish_reason.clone(),
        status,
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use crate::service::session::SessionTranscriptExportOptions;
    use openbitfun_agent_runtime::sdk::{
        AgentEventSource, AgentRuntime, AgentTurnSettlementPort, AgentTurnSettlementRequest,
        AgentTurnSettlementResult, AgentTurnSettlementStatus,
    };
    use openbitfun_runtime_ports::{
        AgentContextReloadRequest, AgentContextReloadTarget, LocalWorkspaceSnapshotSessionRequest,
        LocalWorkspaceSnapshotTurnRequest,
    };
    use openbitfun_runtime_services::RuntimeServices;
    use uuid::Uuid;

    #[allow(deprecated)]
    use super::CoreProductAgentEventSource;
    use super::{
        build_session_lineage_snapshot, generate_core_session_usage_report,
        get_snapshot_manager_for_workspace, latest_persisted_turn_id,
        merge_runtime_owned_turn_facts, projected_turn_save_would_overwrite_runtime_state,
        runtime_lineage_snapshot, runtime_port_error, validate_persisted_session_id,
        CoreAgentRuntimeCompatibility, CoreLocalWorkspaceSnapshot, CoreProductAgentRuntime,
        CoreProductEventQueueOwner, CoreSessionOperationsPort, SESSION_PROVIDER_ACP,
        SESSION_PROVIDER_METADATA_KEY,
    };
    #[cfg(feature = "product-search")]
    use super::{session_search_index_error, validated_session_content_search_query};
    use crate::agentic::coordination::{ConversationCoordinator, DialogScheduler};
    use crate::agentic::events::{EventQueue, EventQueueConfig, EventRouter};
    use crate::agentic::execution::{
        ExecutionEngine, ExecutionEngineConfig, RoundExecutor, StreamProcessor,
    };
    use crate::agentic::persistence::PersistenceManager;
    use crate::agentic::session::{
        compression::ContextCompressor, PromptCachePolicy, SessionContextStore, SessionManager,
        SessionManagerConfig, UserContextCacheIdentity,
    };
    use crate::agentic::tools::registry::ToolRegistry;
    use crate::agentic::tools::{ToolPipeline, ToolStateManager};
    use crate::infrastructure::PathManager;
    use crate::service::session::{
        DialogTurnData, DialogTurnRecoveryData, DialogTurnRecoveryStatus, SessionKind,
        SessionMetadata, TurnStatus, UserMessageData,
    };
    use crate::service::session_usage::UsageTokenSource;
    use crate::service::snapshot::manager::clear_snapshot_manager_for_test;
    use crate::service::token_usage::TokenUsageService;
    use crate::service::workspace_runtime::{
        set_workspace_runtime_service_for_current_test, WorkspaceRuntimeService,
    };
    use crate::util::errors::OpenBitFunError;
    use openbitfun_agent_runtime::sdk::{
        AgentSessionForkAtTurnRequest, AgentSessionForkBeforeTurnRequest, AgentSessionForkPort,
        AgentSessionForkRequest, AgentSessionUsagePort, AgentSessionUsageRequest, PortErrorKind,
    };
    use openbitfun_events::AgenticEvent;
    use tokio::sync::RwLock as TokioRwLock;

    #[cfg(feature = "product-search")]
    #[test]
    fn product_search_index_errors_do_not_cross_the_runtime_boundary() {
        let private_backend_detail = "C:\\Users\\private\\product-search-v1.sqlite";
        let error = session_search_index_error(
            openbitfun_services_core::session_search::SessionSearchIndexError::Backend(
                private_backend_detail.to_string(),
            ),
        );
        let visible = error.to_string();

        assert!(visible.contains("Session content search is temporarily unavailable"));
        assert!(!visible.contains(private_backend_detail));
    }

    #[cfg(feature = "product-search")]
    #[test]
    fn product_search_query_length_is_bounded_before_storage_access() {
        let oversized = "x".repeat(
            openbitfun_product_domains::product_search::MAX_SESSION_CONTENT_SEARCH_QUERY_CHARS + 1,
        );

        assert_eq!(
            validated_session_content_search_query("  roadmap  ").expect("valid query"),
            "roadmap"
        );
        assert!(matches!(
            validated_session_content_search_query(&oversized),
            Err(OpenBitFunError::Validation(_))
        ));
    }

    struct TestWorkspace {
        snapshot_id: std::sync::OnceLock<String>,
        path: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openbitfun-product-runtime-compatibility-test-{}",
                Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("test workspace should be created");
            // Sessions only exist inside registered workspaces; register the
            // fixture directory like a host that opened this folder. Keep the
            // canonical path so record-derived IO projections compare equal.
            let path = dunce::canonicalize(&path).expect("test workspace should canonicalize");
            crate::service::workspace::legacy_compat::register_local_fixture_blocking(&path);
            Self {
                path,
                snapshot_id: std::sync::OnceLock::new(),
            }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn path_manager(&self) -> Arc<PathManager> {
            Arc::new(PathManager::with_user_root_for_tests(
                self.path.join("user-root"),
            ))
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            if let Some(id) = self.snapshot_id.get() {
                clear_snapshot_manager_for_test(id);
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn stale_projected_turn_saves_cannot_overwrite_runtime_recovery_state() {
        let mut persisted = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            "session-1".to_string(),
            UserMessageData {
                id: "user-1".to_string(),
                content: "continue".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        let projected = persisted.clone();
        persisted.status = TurnStatus::Cancelled;
        persisted.recovery = Some(DialogTurnRecoveryData {
            status: DialogTurnRecoveryStatus::Interrupted,
            execution_generation: 0,
            resume_count: 0,
            interrupted_at: Some(2),
            model_id: Some("model-a".to_string()),
        });
        persisted.recovery_epoch = Some(0);
        assert!(projected_turn_save_would_overwrite_runtime_state(
            &persisted, &projected
        ));

        let mut completed = persisted.clone();
        completed.status = TurnStatus::Completed;
        completed.recovery = None;
        assert!(projected_turn_save_would_overwrite_runtime_state(
            &completed, &projected
        ));

        let mut projected_with_recovery = projected.clone();
        projected_with_recovery.recovery = persisted.recovery.clone();
        assert!(projected_turn_save_would_overwrite_runtime_state(
            &projected,
            &projected_with_recovery
        ));
        assert!(!projected_turn_save_would_overwrite_runtime_state(
            &projected, &projected
        ));

        // Exercise content-loss protection independently from the recovery
        // ownership guard above.
        completed.recovery_epoch = None;
        completed.model_rounds = serde_json::from_value(serde_json::json!([{
            "id": "round-1",
            "turnId": "turn-1",
            "roundIndex": 0,
            "timestamp": 2,
            "textItems": [{
                "id": "runtime-text",
                "content": "complete authoritative response",
                "isStreaming": false,
                "timestamp": 2
            }],
            "startTime": 2,
            "status": "completed"
        }]))
        .expect("runtime round");
        let mut terminal_prefix = completed.clone();
        terminal_prefix.model_rounds[0].text_items[0].content =
            "complete authoritative".to_string();
        assert!(projected_turn_save_would_overwrite_runtime_state(
            &completed,
            &terminal_prefix,
        ));

        terminal_prefix.model_rounds[0].text_items[0].content =
            "complete authoritative response with UI metadata".to_string();
        assert!(!projected_turn_save_would_overwrite_runtime_state(
            &completed,
            &terminal_prefix,
        ));
    }

    #[test]
    fn projected_turn_saves_preserve_runtime_execution_contract() {
        let mut persisted = DialogTurnData::new(
            "turn-1".to_string(),
            0,
            "session-1".to_string(),
            UserMessageData {
                id: "user-1".to_string(),
                content: "continue".to_string(),
                timestamp: 1,
                metadata: Some(serde_json::json!({
                    "runtime_resolved_model_id": "model-a",
                    "runtime_model_binding_fingerprint": "binding-a",
                    "runtime_reasoning_preset": "high",
                    "runtime_reasoning_selection": "high",
                    "runtime_reasoning_fingerprint": "reasoning-a",
                    "resolved_permission_mode": "ask",
                })),
            },
        );
        persisted.agent_type = Some("runtime-agent".to_string());
        let mut projected = persisted.clone();
        projected.agent_type = Some("stale-agent".to_string());
        projected.user_message.metadata = Some(serde_json::json!({
            "canvas_context": { "node": "selected" }
        }));

        let merged = merge_runtime_owned_turn_facts(&persisted, &projected);
        let metadata = merged
            .user_message
            .metadata
            .and_then(|value| value.as_object().cloned())
            .expect("merged metadata");
        assert_eq!(merged.agent_type.as_deref(), Some("runtime-agent"));
        assert_eq!(
            metadata.get("runtime_resolved_model_id"),
            Some(&serde_json::json!("model-a"))
        );
        assert_eq!(
            metadata.get("runtime_reasoning_fingerprint"),
            Some(&serde_json::json!("reasoning-a"))
        );
        assert_eq!(
            metadata.get("resolved_permission_mode"),
            Some(&serde_json::json!("ask"))
        );
        assert_eq!(
            metadata.get("canvas_context"),
            Some(&serde_json::json!({ "node": "selected" }))
        );
    }

    #[tokio::test]
    async fn product_event_queue_owner_broadcasts_while_draining_the_legacy_queue() {
        let queue = Arc::new(EventQueue::new(EventQueueConfig {
            max_queue_size: 4,
            batch_size: 2,
        }));
        let owner = CoreProductEventQueueOwner::new(queue.clone());
        let source = owner.runtime_source();
        let mut first = source.subscribe();
        let mut second = source.subscribe();

        for index in 0..32 {
            queue
                .enqueue(
                    AgenticEvent::SessionStateChanged {
                        session_id: "session-1".to_string(),
                        new_state: format!("state-{index}"),
                    },
                    None,
                )
                .await
                .expect("enqueue event");
        }

        let mut last_first = None;
        let mut last_second = None;
        for _ in 0..32 {
            last_first = Some(
                tokio::time::timeout(Duration::from_secs(1), first.recv())
                    .await
                    .expect("first subscriber must not stall")
                    .expect("first subscriber event"),
            );
            last_second = Some(
                tokio::time::timeout(Duration::from_secs(1), second.recv())
                    .await
                    .expect("second subscriber must not stall")
                    .expect("second subscriber event"),
            );
        }

        let last_first = last_first.expect("last first event");
        let last_second = last_second.expect("last second event");
        assert_eq!(last_first.id, last_second.id);
        assert!(matches!(
            last_first.event,
            AgenticEvent::SessionStateChanged { ref new_state, .. } if new_state == "state-31"
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !queue.is_empty().await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue drainer must keep the legacy queue bounded");
    }

    #[test]
    fn product_agent_runtime_exposes_reviewed_full_and_narrow_builders() {
        #[allow(deprecated)]
        fn legacy_build(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
            token_usage_service: Arc<TokenUsageService>,
            services: RuntimeServices,
        ) -> Result<AgentRuntime, String> {
            CoreProductAgentRuntime::build(coordinator, scheduler, token_usage_service, services)
        }

        fn build_with_event_source(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
            token_usage_service: Arc<TokenUsageService>,
            event_source: AgentEventSource,
            services: RuntimeServices,
        ) -> Result<AgentRuntime, String> {
            CoreProductAgentRuntime::build_with_event_source(
                coordinator,
                scheduler,
                token_usage_service,
                event_source,
                services,
            )
        }

        #[allow(deprecated)]
        fn legacy_event_source_methods_are_source_compatible() {
            let _ = CoreProductAgentEventSource::new;
            let _ = CoreProductAgentEventSource::subscribe;
            let _ = CoreProductAgentEventSource::runtime_source;
        }

        let _ = legacy_build;
        let _ = build_with_event_source;
        legacy_event_source_methods_are_source_compatible();
        let _ = CoreProductAgentRuntime::build_session_surface;
        let _ = CoreProductAgentRuntime::build_acp;
        let _ = CoreProductAgentRuntime::build_sdk_host;
    }

    #[test]
    fn sdk_session_operations_depend_directly_on_core_owners() {
        fn build(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
            token_usage_service: Arc<TokenUsageService>,
        ) -> CoreSessionOperationsPort {
            CoreSessionOperationsPort::new(coordinator, scheduler, token_usage_service)
        }

        let _ = build;
    }

    #[test]
    fn runtime_lineage_projection_reuses_normalized_legacy_relationships() {
        let root = SessionMetadata::new(
            "root".to_string(),
            "Root".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        );
        let mut child = SessionMetadata::new(
            "child".to_string(),
            "Explore".to_string(),
            "explore".to_string(),
            "model".to_string(),
        );
        child.created_at = 2;
        child.custom_metadata = Some(serde_json::json!({
            "kind": "subagent",
            "parentSessionId": "root",
            "parentDialogTurnId": "turn-1",
            "parentToolCallId": "tool-1",
            "subagentType": "explore"
        }));
        child.unread_completion = Some("interrupted".to_string());

        let snapshot =
            build_session_lineage_snapshot(vec![child, root], "child").expect("lineage snapshot");
        let projection = runtime_lineage_snapshot(snapshot, None, None);

        assert_eq!(projection.root_session_id, "root");
        assert_eq!(projection.sessions[1].session_id, "child");
        assert_eq!(
            projection.sessions[1].parent_session_id.as_deref(),
            Some("root")
        );
        assert_eq!(
            projection.sessions[1].parent_tool_call_id.as_deref(),
            Some("tool-1")
        );
        assert_eq!(
            projection.sessions[1].unread_completion.as_deref(),
            Some("interrupted")
        );
    }

    #[test]
    fn lineage_live_actions_use_scheduler_scoped_storage_operations() {
        let scheduler_source = include_str!("agentic/coordination/scheduler.rs");
        for (method, scoped_call) in [
            (
                "inspect_loaded_lineage_session",
                "inspect_loaded_lineage_session_in_storage",
            ),
            (
                "cancel_lineage_session_in_storage",
                "cancel_loaded_lineage_session_in_storage",
            ),
        ] {
            let body = scheduler_source
                .split(&format!("fn {method}"))
                .nth(1)
                .and_then(|source| source.split("\n    }").next())
                .expect("scoped lineage scheduler method");
            let lock = body
                .find("lock_session_operation")
                .expect("session operation lock");
            let scoped_operation = body.find(scoped_call).expect("scoped Session operation");
            assert!(
                lock < scoped_operation,
                "{method} must acquire the Session operation lock before the scoped lifecycle operation"
            );
        }

        let coordinator_source = include_str!("agentic/coordination/coordinator.rs");
        for method in [
            "inspect_loaded_lineage_session_in_storage",
            "cancel_loaded_lineage_session_in_storage",
        ] {
            let body = coordinator_source
                .split(&format!("fn {method}"))
                .nth(1)
                .and_then(|source| source.split("\n    }").next())
                .expect("storage-scoped lineage coordinator method");
            let mutation = body
                .find("acquire_session_mutation")
                .expect("Session lifecycle mutation lease");
            let binding = body
                .find("is_session_loaded_from_storage_path")
                .expect("storage binding check");
            assert!(
                mutation < binding,
                "{method} must hold the Session lifecycle lease while checking and acting on storage"
            );
        }

        let product_source = include_str!("product_runtime.rs");
        let lineage_impl = product_source
            .split("impl AgentSessionLineagePort for CoreSessionOperationsPort")
            .nth(1)
            .and_then(|source| source.split("impl AgentSessionForkPort").next())
            .expect("lineage port implementation");
        assert!(lineage_impl.contains("inspect_loaded_lineage_session"));
        assert!(lineage_impl.contains("cancel_lineage_session_in_storage"));
        assert!(lineage_impl.contains("active_turn_id_in_storage_path"));
        assert!(!lineage_impl.contains("SessionTranscriptReader::read_session_transcript"));
        let cancellation = lineage_impl
            .split("async fn cancel_lineage_session")
            .nth(1)
            .expect("lineage cancellation implementation");
        let (cancellation_preparation, admitted_cancellation) = cancellation
            .split_once("let cancelled_turn_id")
            .expect("lineage cancellation admission boundary");
        assert!(cancellation_preparation.contains("tokio::time::timeout(wait_timeout"));
        assert!(admitted_cancellation.contains("cancel_lineage_session_in_storage"));
        assert!(
            admitted_cancellation.contains("deadline.saturating_duration_since(Instant::now())")
        );
        assert!(!admitted_cancellation.contains("tokio::time::timeout"));
        assert!(
            cancellation_preparation
                .find("tokio::time::timeout")
                .unwrap()
                < cancellation_preparation
                    .find("validate_lineage_descendant")
                    .unwrap(),
            "the caller wait budget must include lineage validation"
        );
        let product_runtime_source = product_source
            .split("#[cfg(test)]")
            .next()
            .expect("production product runtime source");
        let lineage_validation = product_runtime_source
            .split("async fn validate_persisted_lineage_descendant")
            .nth(1)
            .and_then(|source| source.split("#[async_trait::async_trait]").next())
            .expect("targeted persisted lineage validation");
        assert!(lineage_validation.contains("load_session_metadata"));
        assert!(lineage_validation.contains("normalized_session_relationship"));
        assert!(!lineage_validation.contains("list_session_metadata_including_internal"));
        assert!(!product_runtime_source.contains("fn lineage_active_turn_id("));
        assert!(coordinator_source.contains("TurnStatus::InProgress"));
        assert!(coordinator_source
            .contains("Session turn settlement changed while its transcript was being inspected"));
        assert!(coordinator_source
            .contains("Session turn is still settling after its active state changed"));

        let inspect_body = coordinator_source
            .split("fn inspect_loaded_lineage_session_in_storage")
            .nth(1)
            .and_then(|source| source.split("\n    }").next())
            .expect("loaded lineage inspection body");
        let required_settlement_gate = inspect_body
            .find("required_settled_turn_ids")
            .expect("required settlement consistency gate");
        let transcript_read = inspect_body
            .find("read_session_transcript_with_turn_status_locked")
            .expect("authoritative transcript read");
        assert!(
            required_settlement_gate < transcript_read,
            "unsettled required Turns must return before transcript I/O"
        );

        let signal_body = coordinator_source
            .split("fn signal_active_subagent_cancellation")
            .nth(1)
            .and_then(|source| source.split("\n    }").next())
            .expect("subagent cancellation signal body");
        assert!(signal_body.contains("cancel_token.cancel()"));
        assert!(!signal_body.contains("abort_handle.abort()"));
        assert!(!signal_body.contains("persist_cancelled_dialog_turn"));
    }

    #[tokio::test]
    async fn targeted_lineage_validation_rejects_an_intermediate_root() {
        let workspace = TestWorkspace::new();
        let persistence =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let storage_path = workspace.path().join("sessions");
        std::fs::create_dir_all(&storage_path).expect("session storage");

        let root = SessionMetadata::new(
            "root".to_string(),
            "Root".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        );
        let mut child = SessionMetadata::new(
            "child".to_string(),
            "Child".to_string(),
            "explore".to_string(),
            "model".to_string(),
        );
        child.custom_metadata = Some(serde_json::json!({
            "kind": "subagent",
            "parentSessionId": "root"
        }));
        let mut grandchild = SessionMetadata::new(
            "grandchild".to_string(),
            "Grandchild".to_string(),
            "explore".to_string(),
            "model".to_string(),
        );
        grandchild.custom_metadata = Some(serde_json::json!({
            "kind": "subagent",
            "parentSessionId": "child"
        }));
        for metadata in [&root, &child, &grandchild] {
            persistence
                .save_session_metadata(&storage_path, metadata)
                .await
                .expect("save lineage metadata");
        }

        super::validate_persisted_lineage_descendant(
            &persistence,
            &storage_path,
            "root",
            "grandchild",
        )
        .await
        .expect("actual root should validate");
        let error = super::validate_persisted_lineage_descendant(
            &persistence,
            &storage_path,
            "child",
            "grandchild",
        )
        .await
        .expect_err("intermediate root must be rejected");
        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn runtime_lineage_active_turn_rejects_cross_workspace_session_ids() {
        let workspace = TestWorkspace::new();
        let persistence = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_manager = SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence,
            SessionManagerConfig {
                max_active_sessions: 4,
                session_idle_timeout: Duration::from_secs(60),
                auto_save_interval: Duration::from_secs(60),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        );
        let first_storage = workspace.path().join("first-sessions");
        let second_storage = workspace.path().join("second-sessions");
        std::fs::create_dir_all(&first_storage).expect("first storage");
        std::fs::create_dir_all(&second_storage).expect("second storage");
        session_manager
            .ensure_session_storage_path("duplicate-session", &first_storage)
            .expect("bind first workspace");

        let error = session_manager
            .active_turn_id_in_storage_path(&second_storage, "duplicate-session")
            .await
            .map_err(runtime_port_error)
            .expect_err("cross-workspace active state must be rejected");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert!(error.message.contains("another workspace"));
    }

    #[test]
    fn sdk_session_forks_reuse_the_coordinator_runtime_owner() {
        let source = include_str!("product_runtime.rs");
        let fork_impl = source
            .split("impl AgentSessionForkPort for CoreSessionOperationsPort")
            .nth(1)
            .and_then(|source| source.split("impl AgentSessionUsagePort").next())
            .expect("session fork implementation");

        // The three port entry points resolve the workspace record and hand
        // off to one shared fork path; that path owns the single Coordinator
        // ownership gate, evaluated on the resolved binding before restore.
        assert_eq!(
            fork_impl.matches("self.fork_at_persisted_turn(").count(),
            3,
            "latest-turn, explicit-turn, and before-turn forks must share the Coordinator ownership gate"
        );
        assert!(fork_impl.contains("fork_session_before_turn"));
        assert!(
            !fork_impl.contains("ensure_workspace_runtime_ownership"),
            "port entry points must not duplicate the shared ownership gate"
        );
        let shared_fork = source
            .split("async fn fork_at_persisted_turn(")
            .nth(1)
            .and_then(|source| source.split("fn runtime_port_error(").next())
            .expect("shared fork implementation");
        let ownership_gate = shared_fork
            .find("ensure_workspace_runtime_ownership")
            .expect("shared fork path must pass through the Coordinator ownership gate");
        let restore = shared_fork
            .find("restore_session_from_storage_path")
            .expect("shared fork path restores the source session");
        assert!(
            ownership_gate < restore,
            "ownership must be checked before the fork touches session state"
        );
        assert_eq!(
            shared_fork
                .matches("ensure_workspace_runtime_ownership")
                .count(),
            1
        );
        assert!(!fork_impl.contains("RuntimeOwnershipKey"));
        assert!(!fork_impl.contains("try_acquire"));
        assert!(!shared_fork.contains("RuntimeOwnershipKey"));
        assert!(!shared_fork.contains("try_acquire"));
    }

    #[test]
    fn remaining_compatibility_operations_have_one_core_owned_facade() {
        fn build(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
        ) -> CoreAgentRuntimeCompatibility {
            CoreAgentRuntimeCompatibility::build(coordinator, scheduler)
        }

        let _ = build;
        let _ = CoreAgentRuntimeCompatibility::list_persisted_sessions;
        let _ = CoreAgentRuntimeCompatibility::load_persisted_session_turns;
        let _ = CoreAgentRuntimeCompatibility::loaded_session_snapshot;
        let _ = CoreAgentRuntimeCompatibility::reload_session_context;
        let _ = CoreAgentRuntimeCompatibility::unload_persisted_session;
    }

    #[tokio::test]
    async fn context_reload_invalidates_loaded_instructions_and_rejects_missing_sessions() {
        let workspace = TestWorkspace::new();
        let persistence = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_manager = Arc::new(SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence,
            SessionManagerConfig {
                max_active_sessions: 4,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        ));
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let tool_pipeline = Arc::new(ToolPipeline::new(
            Arc::new(TokioRwLock::new(ToolRegistry::new())),
            Arc::new(ToolStateManager::new(event_queue.clone())),
            None,
        ));
        let execution_engine = Arc::new(ExecutionEngine::new(
            Arc::new(RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue.clone(),
                tool_pipeline.clone(),
            )),
            event_queue.clone(),
            session_manager.clone(),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ));
        let coordinator = Arc::new(ConversationCoordinator::new(
            session_manager.clone(),
            execution_engine,
            tool_pipeline,
            event_queue,
            Arc::new(EventRouter::new()),
            Arc::new(
                crate::runtime_ownership::CoreRuntimeOwnership::embedded_with_facts(
                    workspace.path().join("runtime-ownership"),
                    "openbitfun".to_string(),
                    "test",
                ),
            ),
        ));
        let scheduler = DialogScheduler::new(coordinator.clone(), session_manager.clone());
        let compatibility = CoreAgentRuntimeCompatibility::build(coordinator, scheduler);
        let session_id = "context-reload-session";
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Reload test".to_string(),
                "Standard".to_string(),
                crate::agentic::core::SessionConfig {
                    workspace_path: Some(workspace.path().to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("loaded session");
        let identity = UserContextCacheIdentity::new("workspace_instructions");
        session_manager
            .remember_user_context(session_id, identity.clone(), "cached context".to_string())
            .await;

        compatibility
            .reload_session_context(AgentContextReloadRequest {
                session_id: session_id.to_string(),
                target: AgentContextReloadTarget::Instructions,
            })
            .await
            .expect("reload loaded session");
        assert_eq!(
            session_manager
                .cached_user_context(session_id, &identity)
                .await,
            None
        );

        let missing_id = "missing-context-reload-session";
        let error = compatibility
            .reload_session_context(AgentContextReloadRequest {
                session_id: missing_id.to_string(),
                target: AgentContextReloadTarget::Skills,
            })
            .await
            .expect_err("missing session must be rejected before refreshing skills");
        assert!(error.to_string().contains(missing_id), "{error}");
    }

    #[test]
    fn persisted_session_compatibility_rejects_path_like_ids() {
        let error = validate_persisted_session_id("../../other-project/session")
            .expect_err("compatibility boundary must reject path-like session ids");

        assert!(error.to_string().contains("session_id"), "{error}");
    }

    #[tokio::test]
    async fn local_workspace_snapshot_port_concurrently_prepares_and_returns_typed_empty_facts() {
        let workspace = TestWorkspace::new();
        let record = crate::service::workspace::legacy_compat::register_local_fixture(
            workspace.path(),
            None,
        )
        .await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(workspace.path_manager()),
        ));
        let port = CoreLocalWorkspaceSnapshot::build();

        let first = port.prepare_local_workspace(record.id.clone());
        let second = port.prepare_local_workspace(record.id.clone());
        let (first, second) = tokio::join!(first, second);
        first.expect("first local snapshot preparation should succeed");
        second.expect("concurrent local snapshot preparation should reuse the owner");

        let request = LocalWorkspaceSnapshotSessionRequest {
            workspace_id: record.id.clone(),
            session_id: "session-empty".to_string(),
            max_turn_exclusive: None,
        };
        assert!(port
            .get_session_files(request.clone())
            .await
            .expect("session files should be available")
            .is_empty());
        let stats = port
            .get_session_stats(request)
            .await
            .expect("typed stats should be available");
        assert_eq!(stats.session_id, "session-empty");
        assert_eq!(stats.total_files, 0);
        assert_eq!(stats.total_turns, 0);
        assert_eq!(stats.total_changes, 0);
        assert!(port
            .rollback_workspace_files_to_turn(LocalWorkspaceSnapshotTurnRequest {
                workspace_id: record.id.clone(),
                session_id: "session-empty".to_string(),
                turn_index: 0,
            })
            .await
            .expect("an empty session rollback remains a no-op")
            .is_empty());
    }

    #[tokio::test]
    async fn local_workspace_snapshot_views_do_not_initialize_a_writer() {
        let workspace = TestWorkspace::new();
        let record = crate::service::workspace::legacy_compat::register_local_fixture(
            workspace.path(),
            None,
        )
        .await;
        workspace.snapshot_id.set(record.id.clone()).unwrap();
        let port = CoreLocalWorkspaceSnapshot::build();
        let request = LocalWorkspaceSnapshotSessionRequest {
            workspace_id: record.id.clone(),
            session_id: "session-view-only".to_string(),
            max_turn_exclusive: None,
        };

        assert!(get_snapshot_manager_for_workspace(&record.id).is_none());
        assert!(port
            .get_session_files(request.clone())
            .await
            .expect("view-only files")
            .is_empty());
        assert_eq!(
            port.get_session_stats(request)
                .await
                .expect("view-only stats")
                .total_changes,
            0
        );
        assert!(get_snapshot_manager_for_workspace(&record.id).is_none());
    }

    #[tokio::test]
    async fn local_workspace_snapshot_port_rejects_non_local_inputs_before_backend_access() {
        let workspace = TestWorkspace::new();
        let record = crate::service::workspace::legacy_compat::register_local_fixture(
            workspace.path(),
            None,
        )
        .await;
        workspace.snapshot_id.set(record.id.clone()).unwrap();
        let port = CoreLocalWorkspaceSnapshot::build();

        let invalid_session = port
            .get_session_files(LocalWorkspaceSnapshotSessionRequest {
                workspace_id: record.id.clone(),
                session_id: "../other-session".to_string(),
                max_turn_exclusive: None,
            })
            .await
            .expect_err("path-like session ids must be rejected");
        assert_eq!(invalid_session.kind, PortErrorKind::InvalidRequest);

        let remote = crate::service::workspace::legacy_compat::register_remote_fixture(
            &record.root_path.to_string_lossy(),
            "snapshot-test-connection",
            "snapshot.example",
        )
        .await;
        let remote_error = port
            .get_session_files(LocalWorkspaceSnapshotSessionRequest {
                workspace_id: remote.id,
                session_id: "session-empty".into(),
                max_turn_exclusive: None,
            })
            .await
            .expect_err("remote ID must not open a same-named local directory");
        assert!(remote_error
            .message
            .contains("not supported for remote workspace"));

        let missing_workspace = "missing-workspace-id".to_string();
        let invalid_workspace = port
            .prepare_local_workspace(missing_workspace)
            .await
            .expect_err("missing local workspaces must be rejected");
        assert_eq!(invalid_workspace.kind, PortErrorKind::InvalidRequest);
    }

    #[test]
    fn session_create_rollback_residual_remains_typed_across_the_runtime_port() {
        let error = runtime_port_error(OpenBitFunError::SessionCreateCleanupRequired {
            session_id: "session-1".to_string(),
            error: "metadata write failed".to_string(),
            cleanup_error: "session directory is locked".to_string(),
        });

        assert_eq!(error.kind, PortErrorKind::CleanupRequired);
        assert!(error.message.contains("session-1"), "{error}");
    }

    #[test]
    fn session_writer_conflict_remains_typed_across_the_runtime_port() {
        let error = runtime_port_error(OpenBitFunError::SessionInUse {
            session_id: "session-1".to_string(),
        });

        assert_eq!(error.kind, PortErrorKind::SessionInUse);
        assert!(error.message.contains("session-1"), "{error}");
    }

    #[test]
    fn local_session_fork_uses_latest_persisted_turn_and_preserves_empty_error() {
        let turns = [
            DialogTurnData::new(
                "turn-1".to_string(),
                0,
                "session-1".to_string(),
                UserMessageData {
                    id: "user-1".to_string(),
                    content: "first".to_string(),
                    timestamp: 1,
                    metadata: None,
                },
            ),
            DialogTurnData::new(
                "turn-2".to_string(),
                1,
                "session-1".to_string(),
                UserMessageData {
                    id: "user-2".to_string(),
                    content: "second".to_string(),
                    timestamp: 2,
                    metadata: None,
                },
            ),
        ];

        assert_eq!(
            latest_persisted_turn_id(&turns).expect("latest turn should be selected"),
            "turn-2"
        );

        let error = runtime_port_error(
            latest_persisted_turn_id(&[]).expect_err("empty sessions cannot be forked"),
        );
        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert_eq!(
            error.message,
            "Validation error: Session has no persisted turns to fork"
        );
    }

    #[tokio::test]
    async fn session_fork_uses_verified_remote_storage_and_preserves_execution_identity() {
        let workspace = TestWorkspace::new();
        let remote_path = format!("/workspace/remote-fork-{}", Uuid::new_v4());
        assert!(!Path::new(&remote_path).exists());
        let path_manager = workspace.path_manager();
        let runtime_service = WorkspaceRuntimeService::new(path_manager.clone());
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let session_manager = Arc::new(SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        ));
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let tool_pipeline = Arc::new(ToolPipeline::new(
            Arc::new(TokioRwLock::new(ToolRegistry::new())),
            Arc::new(ToolStateManager::new(event_queue.clone())),
            None,
        ));
        let execution_engine = Arc::new(ExecutionEngine::new(
            Arc::new(RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue.clone(),
                tool_pipeline.clone(),
            )),
            event_queue.clone(),
            session_manager.clone(),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ));
        let coordinator = Arc::new(ConversationCoordinator::new(
            session_manager.clone(),
            execution_engine,
            tool_pipeline,
            event_queue,
            Arc::new(EventRouter::new()),
            Arc::new(
                crate::runtime_ownership::CoreRuntimeOwnership::embedded_with_facts(
                    workspace.path().join("ownership"),
                    "openbitfun".to_string(),
                    "test",
                ),
            ),
        ));
        let scheduler = DialogScheduler::new(coordinator.clone(), session_manager.clone());
        let token_usage_service = Arc::new(
            TokenUsageService::new_in_base_dir(workspace.path().join("tokens"))
                .await
                .expect("token usage service"),
        );
        let port =
            CoreSessionOperationsPort::new(coordinator.clone(), scheduler, token_usage_service);

        // Two SSH hosts may use the same POSIX path. Forking is a Session-store
        // operation: no checkout, Git command, or controller path may be used.
        for (connection_id, host) in [("ssh-a", "host-a"), ("ssh-b", "host-b")] {
            let record = crate::service::workspace::legacy_compat::register_remote_fixture(
                &remote_path,
                connection_id,
                host,
            )
            .await;
            let storage_path = runtime_service
                .context_for_remote_workspace(host, &remote_path)
                .sessions_dir;
            let source_session_id = format!("session-{connection_id}");
            let source = crate::agentic::core::Session::new_with_id(
                source_session_id.clone(),
                format!("Remote fork {host}"),
                "Standard".to_string(),
                crate::agentic::core::SessionConfig {
                    workspace_path: Some(remote_path.clone()),
                    remote_connection_id: Some(connection_id.to_string()),
                    remote_ssh_host: Some(host.to_string()),
                    ..Default::default()
                },
            );
            persistence
                .save_session(&storage_path, &source)
                .await
                .expect("remote source session");
            for index in 0..2 {
                let mut turn = DialogTurnData::new(
                    format!("turn-{index}"),
                    index,
                    source_session_id.clone(),
                    UserMessageData {
                        id: format!("user-{index}"),
                        content: format!("{host} turn {index}"),
                        timestamp: index as u64,
                        metadata: None,
                    },
                );
                turn.mark_completed();
                persistence
                    .save_dialog_turn(&storage_path, &turn)
                    .await
                    .expect("remote source turn");
            }

            let identity =
                super::workspace_session_identity(&remote_path, Some(connection_id), Some(host))
                    .unwrap();
            let read = super::begin_consistent_persisted_session_read(
                coordinator.as_ref(),
                persistence.as_ref(),
                &storage_path,
                &source_session_id,
                Some(&identity),
            )
            .await
            .expect("offline recorded history validates persisted Session identity");
            drop(read);
            let other_profile = super::workspace_session_identity(
                &remote_path,
                Some("another-profile"),
                Some(host),
            )
            .unwrap();
            let error = super::begin_consistent_persisted_session_read(
                coordinator.as_ref(),
                persistence.as_ref(),
                &storage_path,
                &source_session_id,
                Some(&other_profile),
            )
            .await
            .err()
            .expect("same host and root cannot alias another profile's Session");
            assert!(error
                .to_string()
                .contains("workspace identity does not match"));
            assert!(session_manager.get_session(&source_session_id).is_none());

            let unverified_error = port
                .fork_session(AgentSessionForkRequest {
                    workspace_id: None,
                    workspace_path: remote_path.clone(),
                    source_session_id: source_session_id.clone(),
                    remote_connection_id: Some(connection_id.to_string()),
                    remote_ssh_host: Some(host.to_string()),
                })
                .await
                .expect_err("raw remote identity must not bypass Runtime ownership");
            assert!(unverified_error
                .message
                .contains("unverified_remote_workspace_scope"));
            assert!(session_manager.get_session(&source_session_id).is_none());

            coordinator
                .ensure_verified_remote_workspace_runtime_ownership(
                    Path::new(&remote_path),
                    connection_id,
                    Some(host),
                )
                .expect("Workspace owner has verified this remote binding");
            let wrong_host_error = port
                .fork_session_at_turn(AgentSessionForkAtTurnRequest {
                    workspace_id: None,
                    workspace_path: remote_path.clone(),
                    source_session_id: source_session_id.clone(),
                    source_turn_id: "turn-0".to_string(),
                    remote_connection_id: Some(connection_id.to_string()),
                    remote_ssh_host: Some("wrong-host".to_string()),
                })
                .await
                .expect_err("a mismatched host cannot use a verified connection");
            assert!(wrong_host_error
                .message
                .contains("Legacy fork workspace reference is unavailable"));

            let other_connection_id = format!("{connection_id}-other-profile");
            let other_record =
                crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
                    &remote_path,
                    &other_connection_id,
                    host,
                    Some(&Uuid::new_v4().to_string()),
                )
                .await;
            coordinator
                .ensure_verified_remote_workspace_runtime_ownership(
                    Path::new(&remote_path),
                    &other_connection_id,
                    Some(host),
                )
                .expect("second profile is independently verified for the same host and root");
            // Both profiles resolve to the same legacy Session mirror. None of
            // the three fork APIs may restore or branch the other profile's
            // Session merely because its storage path matches.
            for loaded in [false, true] {
                if loaded {
                    coordinator
                        .restore_session_from_storage_path(&storage_path, &source_session_id)
                        .await
                        .expect("load the source under its own identity");
                }
                for variant in 0..3 {
                    let result = match variant {
                        0 => {
                            port.fork_session(AgentSessionForkRequest {
                                workspace_id: None,
                                workspace_path: remote_path.clone(),
                                source_session_id: source_session_id.clone(),
                                remote_connection_id: Some(other_connection_id.clone()),
                                remote_ssh_host: Some(host.to_string()),
                            })
                            .await
                        }
                        1 => {
                            port.fork_session_at_turn(AgentSessionForkAtTurnRequest {
                                workspace_id: None,
                                workspace_path: remote_path.clone(),
                                source_session_id: source_session_id.clone(),
                                source_turn_id: "turn-0".to_string(),
                                remote_connection_id: Some(other_connection_id.clone()),
                                remote_ssh_host: Some(host.to_string()),
                            })
                            .await
                        }
                        _ => {
                            port.fork_session_before_turn(AgentSessionForkBeforeTurnRequest {
                                workspace_id: None,
                                workspace_path: remote_path.clone(),
                                source_session_id: source_session_id.clone(),
                                source_turn_id: "turn-0".to_string(),
                                remote_connection_id: Some(other_connection_id.clone()),
                                remote_ssh_host: Some(host.to_string()),
                            })
                            .await
                        }
                    };
                    let error = result.expect_err("another profile cannot fork the source Session");
                    assert_eq!(error.kind, PortErrorKind::InvalidRequest);
                    assert!(error.message.contains("workspace identity does not match"));
                    assert_eq!(
                        session_manager.get_session(&source_session_id).is_some(),
                        loaded
                    );
                    assert_eq!(
                        persistence
                            .list_session_metadata(&storage_path)
                            .await
                            .unwrap()
                            .len(),
                        1,
                        "scope rejection must not persist a fork",
                    );
                }
            }

            // A loaded Session cannot override contradictory durable identity.
            let persisted_source = persistence
                .load_session(&storage_path, &source_session_id)
                .await
                .unwrap();
            let mut changed_source = persisted_source.clone();
            changed_source.config.workspace_id = Some(other_record.id.clone());
            changed_source.config.project_workspace_id = Some(other_record.id.clone());
            persistence
                .save_session(&storage_path, &changed_source)
                .await
                .unwrap();
            let error = port
                .fork_session(AgentSessionForkRequest {
                    workspace_id: None,
                    workspace_path: remote_path.clone(),
                    source_session_id: source_session_id.clone(),
                    remote_connection_id: Some(other_connection_id),
                    remote_ssh_host: Some(host.to_string()),
                })
                .await
                .expect_err("loaded and persisted identities must both match");
            assert!(error.message.contains("workspace identity does not match"));
            persistence
                .save_session(&storage_path, &persisted_source)
                .await
                .unwrap();

            for variant in 0..3 {
                let result = match variant {
                    0 => {
                        port.fork_session_at_turn(AgentSessionForkAtTurnRequest {
                            workspace_id: Some(record.id.clone()),
                            workspace_path: String::new(),
                            source_session_id: source_session_id.clone(),
                            source_turn_id: "turn-0".to_string(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        })
                        .await
                    }
                    1 => {
                        port.fork_session(AgentSessionForkRequest {
                            workspace_id: Some(record.id.clone()),
                            workspace_path: String::new(),
                            source_session_id: source_session_id.clone(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        })
                        .await
                    }
                    _ => {
                        port.fork_session_before_turn(AgentSessionForkBeforeTurnRequest {
                            workspace_id: Some(record.id.clone()),
                            workspace_path: String::new(),
                            source_session_id: source_session_id.clone(),
                            source_turn_id: "turn-0".to_string(),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        })
                        .await
                    }
                }
                .expect("verified remote session can be forked");
                let restored = coordinator
                    .restore_session_from_storage_path(&storage_path, &result.session_id)
                    .await
                    .expect("fork restores from the same remote session store");
                assert_eq!(
                    restored.config.workspace_path.as_deref(),
                    Some(remote_path.as_str())
                );
                assert_eq!(
                    restored.config.remote_connection_id.as_deref(),
                    Some(connection_id)
                );
                assert_eq!(restored.config.remote_ssh_host.as_deref(), Some(host));
                let turns = persistence
                    .load_session_turns(&storage_path, &result.session_id)
                    .await
                    .expect("fork turns");
                assert_eq!(turns.len(), [1, 2, 0][variant]);
                assert!(turns.iter().all(|turn| {
                    turn.session_id == result.session_id
                        && turn.user_message.content.starts_with(host)
                }));
                assert!(!runtime_service
                    .context_for_local_workspace(Path::new(&remote_path))
                    .sessions_dir
                    .join(&result.session_id)
                    .exists());
            }
            let legacy_fork = port
                .fork_session(AgentSessionForkRequest {
                    workspace_id: None,
                    workspace_path: storage_path.to_string_lossy().into_owned(),
                    source_session_id: source_session_id.clone(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .expect("legacy callers may fork from a trusted resolved Session store");
            let legacy_fork = persistence
                .load_session(&storage_path, &legacy_fork.session_id)
                .await
                .unwrap();
            assert_eq!(
                legacy_fork.config.remote_connection_id.as_deref(),
                Some(connection_id)
            );
            assert_eq!(legacy_fork.config.remote_ssh_host.as_deref(), Some(host));
            assert_eq!(
                persistence
                    .load_session_turns(&storage_path, &source_session_id)
                    .await
                    .expect("source history is preserved")
                    .len(),
                2
            );
        }
        assert!(!Path::new(&remote_path).exists());
    }

    #[tokio::test]
    async fn session_fork_binding_uses_record_ids_and_ignores_stale_io_projections() {
        let directory = TestWorkspace::new();
        let local = crate::service::workspace::legacy_compat::register_local_fixture(
            directory.path(),
            None,
        )
        .await;
        // Remote roots are POSIX on every client OS; a host temp path (Windows
        // drive letters) is not a valid remote workspace path.
        let remote = crate::service::workspace::legacy_compat::register_remote_fixture(
            "/srv/fork/remote-project",
            "fork-ssh",
            "fork-host",
        )
        .await;
        let mut source = crate::agentic::core::Session::new_with_id(
            "source".into(),
            "Source".into(),
            "Standard".into(),
            crate::agentic::core::SessionConfig {
                workspace_id: Some(local.id.clone()),
                workspace_path: Some("/stale/controller/mirror/sessions".into()),
                remote_connection_id: Some("stale-ssh".into()),
                remote_ssh_host: Some("stale-host".into()),
                ..Default::default()
            },
        );
        let binding = super::fork_workspace_binding(&source, &local.id)
            .await
            .unwrap();
        assert!(!binding.is_remote());
        assert_eq!(binding.root_path, local.root_path);
        assert!(super::fork_workspace_binding(&source, &remote.id)
            .await
            .is_err());
        source.config.workspace_id = Some(remote.id.clone());
        source.config.remote_connection_id = None;
        let binding = super::fork_workspace_binding(&source, &remote.id)
            .await
            .unwrap();
        assert!(binding.is_remote());
        assert_eq!(
            binding.session_identity.remote_connection_id.as_deref(),
            Some("fork-ssh")
        );
        assert!(super::fork_workspace_binding(&source, &local.id)
            .await
            .is_err());
        source.config.workspace_id = Some("missing-id".into());
        source.config.workspace_path = Some(directory.path().to_string_lossy().into_owned());
        assert!(super::fork_workspace_binding(&source, &local.id)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn session_fork_reconciles_pending_revert_and_rejects_hidden_explicit_turns() {
        let workspace = TestWorkspace::new();
        let workspace_root = workspace.path().join("project");
        std::fs::create_dir_all(&workspace_root).expect("workspace root");
        let record =
            crate::service::workspace::legacy_compat::register_local_fixture(&workspace_root, None)
                .await;
        let path_manager = workspace.path_manager();
        let storage_path = WorkspaceRuntimeService::new(path_manager.clone())
            .context_for_local_workspace(&workspace_root)
            .sessions_dir;
        std::fs::create_dir_all(&storage_path).expect("resolved session storage");
        let persistence =
            Arc::new(PersistenceManager::new(path_manager).expect("persistence manager"));
        let session_manager = Arc::new(SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: true,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        ));
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let tool_pipeline = Arc::new(ToolPipeline::new(
            Arc::new(TokioRwLock::new(ToolRegistry::new())),
            Arc::new(ToolStateManager::new(event_queue.clone())),
            None,
        ));
        let execution_engine = Arc::new(ExecutionEngine::new(
            Arc::new(RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue.clone(),
                tool_pipeline.clone(),
            )),
            event_queue.clone(),
            session_manager.clone(),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ));
        let coordinator = Arc::new(ConversationCoordinator::new(
            session_manager.clone(),
            execution_engine,
            tool_pipeline,
            event_queue,
            Arc::new(EventRouter::new()),
            Arc::new(
                crate::runtime_ownership::CoreRuntimeOwnership::embedded_with_facts(
                    std::env::temp_dir().join(format!(
                        "openbitfun-product-runtime-ownership-test-{}",
                        uuid::Uuid::new_v4()
                    )),
                    "openbitfun".to_string(),
                    "test",
                ),
            ),
        ));
        let token_usage_service = Arc::new(
            TokenUsageService::new_in_base_dir(workspace.path().join("tokens"))
                .await
                .expect("token usage service"),
        );
        let scheduler = DialogScheduler::new(coordinator.clone(), session_manager.clone());
        let compatibility =
            CoreAgentRuntimeCompatibility::build(coordinator.clone(), scheduler.clone());
        let port =
            CoreSessionOperationsPort::new(coordinator.clone(), scheduler, token_usage_service);

        let session_id = "session-latest-fork";
        let mut metadata = SessionMetadata::new(
            session_id.to_string(),
            "Latest fork".to_string(),
            "Standard".to_string(),
            "model-a".to_string(),
        );
        metadata.workspace_path = Some(workspace_root.to_string_lossy().into_owned());
        persistence
            .save_session_metadata(&storage_path, &metadata)
            .await
            .expect("session metadata");
        let mut visible_turn = DialogTurnData::new(
            "turn-visible".to_string(),
            0,
            session_id.to_string(),
            UserMessageData {
                id: "user-latest".to_string(),
                content: "fork here".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        visible_turn.mark_completed();
        persistence
            .save_dialog_turn(&storage_path, &visible_turn)
            .await
            .expect("visible turn");
        let mut hidden_turn = DialogTurnData::new(
            "turn-hidden".to_string(),
            1,
            session_id.to_string(),
            UserMessageData {
                id: "user-hidden".to_string(),
                content: "hidden by undo".to_string(),
                timestamp: 2,
                metadata: None,
            },
        );
        hidden_turn.mark_completed();
        persistence
            .save_dialog_turn(&storage_path, &hidden_turn)
            .await
            .expect("hidden turn");
        persistence
            .save_session_revert_state(
                &storage_path,
                session_id,
                &crate::agentic::session::revert::SessionRevertState {
                    schema_version: crate::agentic::session::revert::SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: crate::agentic::session::revert::SessionRevertPhase::Applying,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("pending revert marker");

        let cold_read_error = coordinator
            .load_visible_persisted_session_turns(&storage_path, session_id)
            .await
            .expect_err("cold readers must fail closed on an unfinished undo transition");
        assert!(matches!(
            cold_read_error,
            OpenBitFunError::OutcomeUnknown(_)
        ));

        let result = port
            .fork_session(AgentSessionForkRequest {
                workspace_id: Some(record.id.clone()),
                workspace_path: String::new(),
                source_session_id: session_id.to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect("latest-turn fork should restore through the resolved storage path");

        let settlement = port
            .wait_for_turn_settlement(AgentTurnSettlementRequest {
                session_id: session_id.to_string(),
                turn_id: visible_turn.turn_id.clone(),
                wait_timeout_ms: 10,
            })
            .await
            .expect("a cold persisted turn should remain authoritative without a live tracker");
        assert_eq!(settlement.status, AgentTurnSettlementStatus::Completed);

        let transient = session_manager
            .create_transient_session_with_id_and_details(
                Some("session-transient-settlement".to_string()),
                "Transient settlement".to_string(),
                "Standard".to_string(),
                crate::agentic::core::SessionConfig {
                    workspace_path: Some(workspace_root.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                SessionKind::Standard,
            )
            .await
            .expect("transient session");
        let transient_turn_id = session_manager
            .start_dialog_turn(
                &transient.session_id,
                "Standard".to_string(),
                "finish transiently".to_string(),
                Some("turn-transient-settlement".to_string()),
                None,
                None,
            )
            .await
            .expect("transient turn");
        session_manager
            .reset_session_state_if_processing(&transient.session_id, &transient_turn_id);
        session_manager.record_turn_settlement_result(
            &transient.session_id,
            &transient_turn_id,
            AgentTurnSettlementResult {
                status: AgentTurnSettlementStatus::Completed,
                final_response: Some("transient final answer".to_string()),
                finish_reason: Some("complete".to_string()),
            },
        );

        let transient_settlement = port
            .wait_for_turn_settlement(AgentTurnSettlementRequest {
                session_id: transient.session_id,
                turn_id: transient_turn_id,
                wait_timeout_ms: 10,
            })
            .await
            .expect("transient settlement should use the Runtime-owned result cache");
        assert_eq!(
            transient_settlement.final_response.as_deref(),
            Some("transient final answer")
        );

        assert_ne!(result.session_id, session_id);
        assert_eq!(result.agent_type, "Standard");
        assert_eq!(
            persistence
                .load_session_turns(&storage_path, &result.session_id)
                .await
                .expect("fork turns")
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-visible"]
        );
        assert_eq!(
            persistence
                .load_session_revert_state(&storage_path, session_id)
                .await
                .expect("source marker")
                .expect("reconciled marker remains staged")
                .phase,
            crate::agentic::session::revert::SessionRevertPhase::Staged
        );
        let visible_tail = compatibility
            .load_persisted_session_turns(&storage_path, session_id, Some(1))
            .await
            .expect("staged undo must filter before applying the recent-turn limit");
        assert_eq!(
            visible_tail
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-visible"]
        );
        assert_eq!(
            persistence
                .load_visible_session_turns(&storage_path, session_id)
                .await
                .expect("passive consumers share the persisted visible history")
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-visible"]
        );
        let passive_read_mutation = session_manager
            .acquire_session_mutation(session_id)
            .await
            .expect("simulated concurrent Session mutation");
        let passive_reader = coordinator.clone();
        let passive_storage = storage_path.clone();
        let passive_read = tokio::spawn(async move {
            passive_reader
                .load_visible_persisted_session_turns(&passive_storage, session_id)
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !passive_read.is_finished(),
            "passive persisted readers must wait for Core's Session mutation owner"
        );
        drop(passive_read_mutation);
        assert_eq!(
            passive_read
                .await
                .expect("passive read task")
                .expect("passive visible history")
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-visible"]
        );
        let export_mutation = session_manager
            .acquire_session_mutation(session_id)
            .await
            .expect("simulated concurrent export mutation");
        let export_reader = coordinator.clone();
        let export_storage = storage_path.clone();
        let transcript_export = tokio::spawn(async move {
            export_reader
                .export_visible_persisted_session_transcript(
                    &export_storage,
                    session_id,
                    &SessionTranscriptExportOptions {
                        tools: false,
                        tool_inputs: false,
                        thinking: false,
                        turns: None,
                    },
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !transcript_export.is_finished(),
            "SessionHistory export must wait for Core's Session mutation owner"
        );
        drop(export_mutation);
        let transcript_export = transcript_export
            .await
            .expect("transcript export task")
            .expect("visible transcript export");
        let transcript_text = tokio::fs::read_to_string(&transcript_export.transcript_path)
            .await
            .expect("visible transcript artifact");
        assert!(transcript_text.contains("fork here"));
        assert!(!transcript_text.contains("hidden by undo"));

        let hidden_error = port
            .fork_session_at_turn(AgentSessionForkAtTurnRequest {
                workspace_id: Some(record.id.clone()),
                workspace_path: String::new(),
                source_session_id: session_id.to_string(),
                source_turn_id: "turn-hidden".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .expect_err("explicit fork cannot target a hidden turn");
        assert_eq!(hidden_error.kind, PortErrorKind::InvalidRequest);

        compatibility
            .ensure_session_loaded_from_storage_path(&storage_path, session_id, false)
            .await
            .expect("load source before branch validation");
        let commit_mutation = compatibility
            .begin_persisted_session_mutation(&storage_path, session_id)
            .await
            .expect("commit mutation");
        compatibility
            .commit_session_revert_before_snapshot_mutation(&commit_mutation)
            .await
            .expect("commit staged suffix");
        let stale_save = compatibility
            .save_persisted_dialog_turn(&commit_mutation, &hidden_turn)
            .await
            .expect_err("a delayed save cannot revive a committed suffix Turn");
        assert!(matches!(stale_save, OpenBitFunError::Validation(_)));
        drop(commit_mutation);
        assert_eq!(
            persistence
                .load_session_turns(&storage_path, session_id)
                .await
                .expect("turns after stale save rejection")
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-visible"]
        );

        persistence
            .delete_session_revert_state(&storage_path, session_id)
            .await
            .expect("clear marker before controlled usage interleaving");
        let mutation_guard = session_manager
            .acquire_session_mutation(session_id)
            .await
            .expect("simulated undo mutation");
        let usage_port = port.clone();
        let usage_workspace_path = workspace_root.to_string_lossy().into_owned();
        let usage_task = tokio::spawn(async move {
            usage_port
                .generate_session_usage(AgentSessionUsageRequest {
                    workspace_id: None,
                    session_id: session_id.to_string(),
                    workspace_path: Some(usage_workspace_path),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    include_hidden_subagents: false,
                })
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !usage_task.is_finished(),
            "usage must wait for the same mutation boundary as undo"
        );
        persistence
            .save_session_revert_state(
                &storage_path,
                session_id,
                &crate::agentic::session::revert::SessionRevertState {
                    schema_version: crate::agentic::session::revert::SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 1,
                    original_turn_end: 2,
                    phase: crate::agentic::session::revert::SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("stage marker while usage is blocked");
        drop(mutation_guard);
        let usage = usage_task
            .await
            .expect("usage task")
            .expect("usage after staged marker");
        assert_eq!(usage.scope.turn_count, 1);
    }

    #[tokio::test]
    async fn sdk_usage_provider_validates_ids_and_keeps_live_token_enrichment() {
        let workspace = TestWorkspace::new();
        let persistence =
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager");
        let token_usage_service = TokenUsageService::new_in_base_dir(workspace.path.join("tokens"))
            .await
            .expect("token usage service");

        let invalid = generate_core_session_usage_report(
            &persistence,
            &token_usage_service,
            workspace.path(),
            AgentSessionUsageRequest {
                session_id: "../other-session".to_string(),
                workspace_id: None,
                workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                remote_connection_id: None,
                remote_ssh_host: None,
                include_hidden_subagents: false,
            },
        )
        .await
        .expect_err("path-like session ids must be rejected before persistence access");
        assert_eq!(
            runtime_port_error(invalid).kind,
            PortErrorKind::InvalidRequest
        );

        let session_id = "session-usage";
        persistence
            .save_session_metadata(
                workspace.path(),
                &SessionMetadata::new(
                    session_id.to_string(),
                    "Usage session".to_string(),
                    "Standard".to_string(),
                    "model-a".to_string(),
                ),
            )
            .await
            .expect("session metadata should persist");
        let mut turn = DialogTurnData::new(
            "turn-usage".to_string(),
            0,
            session_id.to_string(),
            UserMessageData {
                id: "user-usage".to_string(),
                content: "measure this session".to_string(),
                timestamp: 1,
                metadata: None,
            },
        );
        turn.mark_completed();
        persistence
            .save_dialog_turn(workspace.path(), &turn)
            .await
            .expect("dialog turn should persist");
        token_usage_service
            .record_usage(
                "model-config-a".to_string(),
                "model-a".to_string(),
                session_id.to_string(),
                turn.turn_id.clone(),
                10,
                5,
                Some(2),
                None,
                false,
            )
            .await
            .expect("live token usage should persist");

        let report = generate_core_session_usage_report(
            &persistence,
            &token_usage_service,
            workspace.path(),
            AgentSessionUsageRequest {
                workspace_id: None,
                session_id: session_id.to_string(),
                workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                remote_connection_id: None,
                remote_ssh_host: None,
                include_hidden_subagents: false,
            },
        )
        .await
        .expect("usage provider should generate a report");

        assert_eq!(report.tokens.source, UsageTokenSource::TokenUsageRecords);
        assert_eq!(report.tokens.input_tokens, Some(10));
        assert_eq!(report.tokens.output_tokens, Some(5));
        assert_eq!(report.tokens.total_tokens, Some(15));
    }

    #[tokio::test]
    async fn externally_projected_turns_persist_without_a_runtime_history_branch() {
        let workspace = TestWorkspace::new();
        let storage_path = workspace.path().join("sessions");
        std::fs::create_dir_all(&storage_path).expect("session storage");
        let persistence = Arc::new(
            PersistenceManager::new(workspace.path_manager()).expect("persistence manager"),
        );
        let session_manager = Arc::new(SessionManager::new(
            Arc::new(SessionContextStore::new()),
            persistence.clone(),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        ));
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let tool_pipeline = Arc::new(ToolPipeline::new(
            Arc::new(TokioRwLock::new(ToolRegistry::new())),
            Arc::new(ToolStateManager::new(event_queue.clone())),
            None,
        ));
        let execution_engine = Arc::new(ExecutionEngine::new(
            Arc::new(RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue.clone(),
                tool_pipeline.clone(),
            )),
            event_queue.clone(),
            session_manager.clone(),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ));
        let coordinator = Arc::new(ConversationCoordinator::new(
            session_manager.clone(),
            execution_engine,
            tool_pipeline,
            event_queue,
            Arc::new(EventRouter::new()),
            Arc::new(
                crate::runtime_ownership::CoreRuntimeOwnership::embedded_with_facts(
                    std::env::temp_dir().join(format!(
                        "openbitfun-product-runtime-ownership-test-{}",
                        uuid::Uuid::new_v4()
                    )),
                    "openbitfun".to_string(),
                    "test",
                ),
            ),
        ));
        let scheduler = DialogScheduler::new(coordinator.clone(), session_manager.clone());
        let compatibility = CoreAgentRuntimeCompatibility::build(coordinator, scheduler);

        let save_first_turn = |session_id: &'static str| {
            let compatibility = compatibility.clone();
            let storage_path = storage_path.clone();
            async move {
                let turn = DialogTurnData::new(
                    format!("{session_id}-turn-0"),
                    0,
                    session_id.to_string(),
                    UserMessageData {
                        id: format!("{session_id}-user-0"),
                        content: "hello".to_string(),
                        timestamp: 1,
                        metadata: None,
                    },
                );
                let permit = compatibility
                    .begin_persisted_session_mutation(&storage_path, session_id)
                    .await
                    .expect("mutation permit");
                compatibility
                    .save_persisted_dialog_turn(&permit, &turn)
                    .await
            }
        };

        let acp_session_id = "acp_dsh_projected";
        let mut acp_metadata = SessionMetadata::new(
            acp_session_id.to_string(),
            "Projected".to_string(),
            "acp:dsh".to_string(),
            "deepseek".to_string(),
        );
        let mut custom_metadata = serde_json::Map::new();
        custom_metadata.insert(
            SESSION_PROVIDER_METADATA_KEY.to_string(),
            serde_json::Value::String(SESSION_PROVIDER_ACP.to_string()),
        );
        acp_metadata.custom_metadata = Some(serde_json::Value::Object(custom_metadata));
        persistence
            .save_session_metadata(&storage_path, &acp_metadata)
            .await
            .expect("acp metadata");

        save_first_turn(acp_session_id)
            .await
            .expect("a projected first turn has no branch to validate against");
        assert_eq!(
            persistence
                .load_session_turns(&storage_path, acp_session_id)
                .await
                .expect("projected turns")
                .len(),
            1
        );

        let runtime_session_id = "runtime-owned";
        persistence
            .save_session_metadata(
                &storage_path,
                &SessionMetadata::new(
                    runtime_session_id.to_string(),
                    "Runtime owned".to_string(),
                    "Standard".to_string(),
                    "model-a".to_string(),
                ),
            )
            .await
            .expect("runtime metadata");

        let error = save_first_turn(runtime_session_id)
            .await
            .expect_err("a Runtime-owned Session still needs its history branch");
        assert!(
            matches!(error, OpenBitFunError::OutcomeUnknown(_)),
            "unexpected error: {error}"
        );
    }
}
