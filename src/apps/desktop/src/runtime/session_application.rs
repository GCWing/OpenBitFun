//! Framework-neutral Desktop session use cases.
//!
//! Tauri commands map their transport DTOs into this application boundary.
//! Rich Desktop persistence views remain on Core's compatibility facade while
//! stable lifecycle operations use the Agent Runtime SDK.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::{
    AgentLocalCommandTurnRecordRequest, AgentRuntime, AgentSessionArchiveStateRequest,
    AgentSessionDeleteRequest, AgentSessionForkAtTurnRequest, AgentSessionLineageRequest,
    AgentSessionLineageSnapshot, AgentSessionRenameRequest, AgentSessionUsageRequest,
    PortErrorKind, RuntimeError, SessionEventBackfill, SessionEventJournal,
    SessionEventProjectionSnapshot, SessionInteractionSnapshot,
};
use openbitfun_core::agentic::coordination::{ConversationCoordinator, DialogScheduler};
use openbitfun_core::agentic::core::Session;
use openbitfun_core::agentic::persistence::{SessionBranchResult, SessionMetadataPage};
use openbitfun_core::agentic::session::SessionViewRestoreTiming;
use openbitfun_core::product_runtime::{CoreAgentRuntimeCompatibility, CoreProductAgentRuntime};
#[cfg(test)]
use openbitfun_core::service::remote_ssh::workspace_state::get_effective_session_path;
use openbitfun_core::service::remote_ssh::SSHConnectionManager;
use openbitfun_core::service::session::{
    DialogTurnData, DialogTurnKind, SessionContextUsage, SessionMetadata, SessionStatus,
    SessionTranscriptExport, SessionTranscriptExportOptions, SessionTurnCatalog,
    SessionTurnWindowResponse,
};
use openbitfun_core::service::session_usage::SessionUsageReport;
use openbitfun_core::service::token_usage::TokenUsageService;
use openbitfun_core::service::workspace::WorkspaceService;
use openbitfun_core::util::errors::OpenBitFunError;
use openbitfun_product_domains::product_search::SessionContentSearchResponse;
use openbitfun_runtime_ports::{AgentContextReloadRequest, SessionTurnWindowRequest};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiSessionMetadataField {
    SessionName,
    Tags,
    Todos,
    ReviewActionState,
    UnreadCompletion,
    NeedsUserAttention,
    TitleMetadata,
}

#[derive(Debug, Clone)]
pub(crate) struct DesktopSessionScopeRequest {
    pub workspace_id: Option<String>,
    pub workspace_path: String,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DesktopSessionApplicationError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Core(String),
    #[error("{0}")]
    Runtime(String),
    #[error("{0}")]
    RestoreBeforeRename(String),
    #[error("outcome_unknown: {0}")]
    OutcomeUnknown(String),
    #[error("session_in_use: {0}")]
    SessionInUse(String),
}

pub(crate) type DesktopSessionApplicationResult<T> = Result<T, DesktopSessionApplicationError>;

fn desktop_core_session_error(error: OpenBitFunError) -> DesktopSessionApplicationError {
    match error {
        OpenBitFunError::SessionInUse { session_id } => {
            DesktopSessionApplicationError::SessionInUse(format!(
                "Session is already open for writing: {session_id}"
            ))
        }
        OpenBitFunError::OutcomeUnknown(message) => {
            DesktopSessionApplicationError::OutcomeUnknown(message)
        }
        error => DesktopSessionApplicationError::Core(error.to_string()),
    }
}

fn desktop_runtime_session_error(error: RuntimeError) -> DesktopSessionApplicationError {
    match error {
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::OutcomeUnknown => {
            DesktopSessionApplicationError::OutcomeUnknown(port_error.message)
        }
        error => DesktopSessionApplicationError::Runtime(error.into_message()),
    }
}

fn local_command_turn_record_request(
    turn: &DialogTurnData,
) -> DesktopSessionApplicationResult<Option<AgentLocalCommandTurnRecordRequest>> {
    if turn.kind != DialogTurnKind::LocalCommand {
        return Ok(None);
    }
    let metadata = match turn.user_message.metadata.clone() {
        None => serde_json::Map::new(),
        Some(serde_json::Value::Object(metadata)) => metadata,
        Some(_) => {
            return Err(DesktopSessionApplicationError::Validation(
                "Local command Turn metadata must be an object".to_string(),
            ));
        }
    };
    Ok(Some(AgentLocalCommandTurnRecordRequest {
        session_id: turn.session_id.clone(),
        content: turn.user_message.content.clone(),
        turn_id: Some(turn.turn_id.clone()),
        timestamp_ms: Some(turn.timestamp),
        metadata,
    }))
}

#[derive(Debug)]
pub(crate) struct DesktopSessionViewRestore {
    pub session: Session,
    pub turns: Vec<DialogTurnData>,
    pub interaction_snapshot: SessionInteractionSnapshot,
    pub runtime_event_snapshot: Option<SessionEventProjectionSnapshot>,
    pub current_context_usage: Option<SessionContextUsage>,
    pub total_turn_count: usize,
    pub turn_catalog: SessionTurnCatalog,
    pub timings: SessionViewRestoreTiming,
}

#[derive(Debug)]
pub(crate) struct DesktopSessionWithTurnsRestore {
    pub session: Session,
    pub turns: Vec<DialogTurnData>,
}

fn overlay_live_session_state(restored: &mut Session, live: Option<Session>) {
    let Some(live) = live else {
        return;
    };
    if live.session_id != restored.session_id {
        return;
    }

    // Disk state deliberately stores Processing as Idle so a process restart
    // never revives work. A view served by the process that still owns the
    // runtime must expose its live state, otherwise a Peer controller treats
    // an executing turn as interrupted history and drops subsequent chunks.
    restored.state = live.state;
}

#[derive(Clone)]
struct ResolvedDesktopSessionScope {
    workspace_id: String,
    workspace_path: String,
    effective_storage_path: PathBuf,
    remote_connection_id: Option<String>,
    requested_remote_ssh_host: Option<String>,
    resolved_remote_ssh_host: Option<String>,
    remote_binding_verified: bool,
}

#[derive(Clone)]
struct DesktopSessionScopeResolver {
    workspace_service: Arc<WorkspaceService>,
}

impl DesktopSessionScopeResolver {
    async fn resolve(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<ResolvedDesktopSessionScope> {
        let workspace = if let Some(id) = request.workspace_id.as_deref() {
            self.workspace_service.require_workspace(id).await
        } else {
            // Upgrade-only ingress for existing 1.0.0 clients. Runtime and
            // persistence below this boundary consume the resolved object.
            self.workspace_service
                .resolve_legacy_workspace_reference(
                    None,
                    &request.workspace_path,
                    request.remote_connection_id.as_deref(),
                    request.remote_ssh_host.as_deref(),
                )
                .await
                .and_then(|record| {
                    record.ok_or_else(|| OpenBitFunError::service("Workspace ID is unavailable"))
                })
        }
        .map_err(desktop_core_session_error)?;
        use openbitfun_runtime_ports::SessionStorePort;
        let storage = openbitfun_core::agentic::session::CoreSessionStorePort::default()
            .resolve_workspace_storage(&workspace.id)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        let remote =
            workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        let remote_connection_id = if remote {
            workspace.remote_ssh_connection_id().map(str::to_owned)
        } else {
            None
        };
        let host = if remote {
            workspace
                .metadata
                .get("sshHost")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok(ResolvedDesktopSessionScope {
            workspace_id: workspace.id.clone(),
            workspace_path: workspace.root_path.to_string_lossy().into_owned(),
            effective_storage_path: storage.effective_storage_path,
            remote_connection_id,
            requested_remote_ssh_host: host.clone(),
            resolved_remote_ssh_host: host,
            remote_binding_verified: remote,
        })
    }
}

#[async_trait]
pub(crate) trait DesktopSessionHostEffects: Send + Sync {
    async fn release_session(&self, session_id: &str);
}

#[derive(Clone)]
pub(crate) struct DesktopSessionApplication {
    coordinator: Arc<ConversationCoordinator>,
    agent_runtime: AgentRuntime,
    compatibility: CoreAgentRuntimeCompatibility,
    scope_resolver: DesktopSessionScopeResolver,
    host_effects: Arc<dyn DesktopSessionHostEffects>,
}

impl DesktopSessionApplication {
    pub(crate) fn build(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        token_usage_service: Arc<TokenUsageService>,
        workspace_service: Arc<WorkspaceService>,
        _ssh_manager: Arc<RwLock<Option<SSHConnectionManager>>>,
        host_effects: Arc<dyn DesktopSessionHostEffects>,
        session_event_journal: Arc<SessionEventJournal>,
    ) -> Result<Self, String> {
        let agent_runtime = CoreProductAgentRuntime::build_session_surface_with_event_journal(
            coordinator.clone(),
            scheduler.clone(),
            token_usage_service,
            session_event_journal,
        )?;
        let compatibility = CoreAgentRuntimeCompatibility::build(coordinator.clone(), scheduler);

        Ok(Self {
            coordinator,
            agent_runtime,
            compatibility,
            scope_resolver: DesktopSessionScopeResolver { workspace_service },
            host_effects,
        })
    }

    pub(crate) fn agent_runtime(&self) -> &AgentRuntime {
        &self.agent_runtime
    }

    pub(crate) fn compatibility(&self) -> &CoreAgentRuntimeCompatibility {
        &self.compatibility
    }

    pub(crate) async fn reload_session_context(
        &self,
        request: AgentContextReloadRequest,
    ) -> DesktopSessionApplicationResult<()> {
        self.compatibility
            .reload_session_context(request)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn rollback_session_to_turn(
        &self,
        request: openbitfun_runtime_ports::AgentSessionRollbackToTurnRequest,
    ) -> DesktopSessionApplicationResult<openbitfun_runtime_ports::AgentSessionRollbackToTurnOutcome>
    {
        self.agent_runtime
            .rollback_session_to_turn(request)
            .await
            .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))
    }

    async fn resolved_scope(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<ResolvedDesktopSessionScope> {
        self.scope_resolver.resolve(request).await
    }

    fn storage_path(&self, scope: &ResolvedDesktopSessionScope) -> PathBuf {
        scope.effective_storage_path.clone()
    }

    fn ensure_runtime_ownership(
        &self,
        scope: &ResolvedDesktopSessionScope,
    ) -> DesktopSessionApplicationResult<()> {
        let result = if scope.remote_binding_verified {
            self.coordinator
                .ensure_verified_remote_workspace_runtime_ownership(
                    Path::new(&scope.workspace_path),
                    scope
                        .remote_connection_id
                        .as_deref()
                        .expect("verified Remote scope has a connection id"),
                    scope.resolved_remote_ssh_host.as_deref(),
                )
        } else {
            self.coordinator.ensure_workspace_runtime_ownership(
                Path::new(&scope.workspace_path),
                scope.remote_connection_id.as_deref(),
                scope.resolved_remote_ssh_host.as_deref(),
            )
        };
        result.map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn ensure_workspace_runtime_ownership(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)
    }

    pub(crate) async fn ensure_configured_plugin_instance(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        if scope.remote_connection_id.is_some() {
            if !openbitfun_core::plugin_host::configured_plugins_present()
                .await
                .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?
            {
                return Ok(());
            }
            return Err(DesktopSessionApplicationError::Core(format!(
                "OpenCode plugin hooks are unavailable for remote workspace {} because the remote execution domain does not provide a plugin host",
                scope.workspace_path
            )));
        }
        openbitfun_core::plugin_host::ensure_configured_plugin_instance(
            crate::PLUGIN_HOST_LAUNCH_POLICY,
            &scope.workspace_id,
        )
        .await
        .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn list_persisted_sessions(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<Vec<SessionMetadata>> {
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        let mut records = self
            .compatibility
            .list_persisted_sessions(&storage_path)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        for record in &mut records {
            record
                .workspace_id
                .get_or_insert_with(|| scope.workspace_id.clone());
        }
        Ok(records)
    }

    pub(crate) async fn list_persisted_sessions_page(
        &self,
        request: DesktopSessionScopeRequest,
        cursor: Option<&str>,
        limit: usize,
        session_ids: Option<&[String]>,
    ) -> DesktopSessionApplicationResult<SessionMetadataPage> {
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        let mut page = self
            .compatibility
            .list_persisted_sessions_page_with_activity(
                &self.agent_runtime,
                &storage_path,
                cursor,
                limit,
                session_ids,
            )
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        for record in &mut page.sessions {
            record
                .workspace_id
                .get_or_insert_with(|| scope.workspace_id.clone());
        }
        Ok(page)
    }

    pub(crate) async fn search_session_content(
        &self,
        request: DesktopSessionScopeRequest,
        query: &str,
        limit: usize,
        include_archived: bool,
    ) -> DesktopSessionApplicationResult<SessionContentSearchResponse> {
        let scope = self.resolved_scope(request).await?;
        self.compatibility
            .search_persisted_session_content(
                &self.storage_path(&scope),
                query,
                limit,
                include_archived,
            )
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn get_session_lineage(
        &self,
        request: DesktopSessionScopeRequest,
        anchor_session_id: &str,
    ) -> DesktopSessionApplicationResult<Option<AgentSessionLineageSnapshot>> {
        let scope = self.resolved_scope(request).await?;
        self.agent_runtime
            .get_session_lineage(AgentSessionLineageRequest {
                workspace_id: Some(scope.workspace_id),
                workspace_path: scope.workspace_path,
                anchor_session_id: anchor_session_id.to_string(),
                remote_connection_id: scope.remote_connection_id,
                remote_ssh_host: scope.resolved_remote_ssh_host,
            })
            .await
            .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))
    }

    pub(crate) async fn list_archived_sessions(
        &self,
        request: DesktopSessionScopeRequest,
    ) -> DesktopSessionApplicationResult<Vec<SessionMetadata>> {
        let sessions = self.list_persisted_sessions(request).await?;
        Ok(sessions
            .into_iter()
            .filter(|session| session.status == SessionStatus::Archived)
            .collect())
    }

    pub(crate) async fn export_session_transcript(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        options: &SessionTranscriptExportOptions,
    ) -> DesktopSessionApplicationResult<SessionTranscriptExport> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        self.compatibility
            .export_persisted_session_transcript(&self.storage_path(&scope), session_id, options)
            .await
            .map_err(desktop_core_session_error)
    }

    pub(crate) async fn load_session_turns(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        limit: Option<usize>,
    ) -> DesktopSessionApplicationResult<Vec<DialogTurnData>> {
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        self.compatibility
            .load_persisted_session_turns(&storage_path, session_id, limit)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn load_session_turn_window(
        &self,
        scope_request: DesktopSessionScopeRequest,
        mut request: SessionTurnWindowRequest,
    ) -> DesktopSessionApplicationResult<SessionTurnWindowResponse> {
        let scope = self.resolved_scope(scope_request).await?;
        let storage_path = self.storage_path(&scope);
        request.workspace_path = storage_path.clone();
        self.compatibility
            .load_session_turn_window_from_storage_path(&storage_path, request)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn load_session_metadata(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
    ) -> DesktopSessionApplicationResult<Option<SessionMetadata>> {
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        self.compatibility
            .load_persisted_session_metadata(&storage_path, session_id)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn save_session_turn(
        &self,
        request: DesktopSessionScopeRequest,
        turn: &DialogTurnData,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        // An externally projected Session has no Runtime state to restore, and
        // loading one would rewrite its persisted mode to a local fallback.
        if !self
            .compatibility
            .is_externally_projected_session(&storage_path, &turn.session_id)
            .await
            .map_err(desktop_core_session_error)?
        {
            self.compatibility
                .ensure_session_loaded_from_storage_path(&storage_path, &turn.session_id, false)
                .await
                .map_err(desktop_core_session_error)?;
        }
        if let Some(local_command) = local_command_turn_record_request(turn)? {
            return self
                .agent_runtime
                .record_completed_local_command_turn(local_command)
                .await
                .map(|_| ())
                .map_err(desktop_runtime_session_error);
        }
        let mutation = self
            .compatibility
            .begin_persisted_session_mutation(&storage_path, &turn.session_id)
            .await
            .map_err(desktop_core_session_error)?;
        self.compatibility
            .save_persisted_dialog_turn(&mutation, turn)
            .await
            .map_err(desktop_core_session_error)
    }

    pub(crate) async fn touch_session(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        self.compatibility
            .touch_persisted_session(&storage_path, session_id)
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))
    }

    pub(crate) async fn save_ui_metadata(
        &self,
        request: DesktopSessionScopeRequest,
        incoming: SessionMetadata,
        fields: Vec<UiSessionMetadataField>,
    ) -> DesktopSessionApplicationResult<()> {
        if fields.is_empty() {
            return Err(DesktopSessionApplicationError::Validation(
                "At least one session metadata field is required".to_string(),
            ));
        }
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        let session_id = incoming.session_id.clone();
        self.compatibility
            .update_persisted_session_metadata(&storage_path, &session_id, |current| {
                merge_ui_owned_session_metadata(current, &incoming, &fields);
            })
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        Ok(())
    }

    pub(crate) async fn generate_usage_report(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: String,
        include_hidden_subagents: bool,
    ) -> DesktopSessionApplicationResult<SessionUsageReport> {
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        let mut report = self
            .agent_runtime
            .generate_session_usage(AgentSessionUsageRequest {
                workspace_id: Some(scope.workspace_id.clone()),
                session_id,
                workspace_path: Some(storage_path.to_string_lossy().to_string()),
                remote_connection_id: scope.remote_connection_id.clone(),
                remote_ssh_host: scope.requested_remote_ssh_host.clone(),
                include_hidden_subagents,
            })
            .await
            .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))?;
        report.workspace.path_label = Some(scope.workspace_path);
        report.workspace.remote_connection_id = scope.remote_connection_id;
        report.workspace.remote_ssh_host = scope.requested_remote_ssh_host;
        Ok(report)
    }

    pub(crate) async fn fork_session(
        &self,
        request: DesktopSessionScopeRequest,
        source_session_id: String,
        source_turn_id: String,
    ) -> DesktopSessionApplicationResult<SessionBranchResult> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let result = self
            .agent_runtime
            .fork_session_at_turn(AgentSessionForkAtTurnRequest {
                workspace_id: Some(scope.workspace_id.clone()),
                workspace_path: String::new(),
                source_session_id,
                source_turn_id,
                remote_connection_id: scope.remote_connection_id,
                remote_ssh_host: scope.resolved_remote_ssh_host,
            })
            .await
            .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))?;
        Ok(SessionBranchResult {
            session_id: result.session_id,
            session_name: result.session_name,
            agent_type: result.agent_type,
        })
    }

    pub(crate) async fn set_session_archived(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: String,
        archived: bool,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        self.agent_runtime
            .set_session_archived(AgentSessionArchiveStateRequest {
                workspace_id: Some(scope.workspace_id.clone()),
                workspace_path: scope.workspace_path.clone(),
                session_id,
                archived,
                remote_connection_id: scope.remote_connection_id,
                remote_ssh_host: scope.resolved_remote_ssh_host,
            })
            .await
            .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))
    }

    pub(crate) async fn delete_session(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: String,
    ) -> DesktopSessionApplicationResult<()> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        delete_session_with_host_effects(
            &self.agent_runtime,
            self.host_effects.as_ref(),
            scope,
            session_id,
        )
        .await
    }

    pub(crate) async fn rename_session(
        &self,
        request: Option<DesktopSessionScopeRequest>,
        session_id: String,
        title: String,
    ) -> DesktopSessionApplicationResult<String> {
        let normalized_title = title.trim().to_string();
        if let Some(request) = request {
            let scope = self.resolved_scope(request).await?;
            self.ensure_runtime_ownership(&scope)?;
            if !self
                .compatibility
                .is_session_loaded_in_memory(&session_id)
                .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?
            {
                let storage_path = self.storage_path(&scope);
                self.compatibility
                    .restore_session_from_storage_path(&storage_path, &session_id, false)
                    .await
                    .map_err(|error| {
                        DesktopSessionApplicationError::RestoreBeforeRename(error.to_string())
                    })?;
            }
            self.agent_runtime
                .rename_session(AgentSessionRenameRequest {
                    workspace_id: Some(scope.workspace_id.clone()),
                    workspace_path: String::new(),
                    session_id: session_id.clone(),
                    session_name: title,
                    remote_connection_id: scope.remote_connection_id,
                    remote_ssh_host: scope.resolved_remote_ssh_host,
                })
                .await
                .map_err(desktop_runtime_session_error)?;
            return Ok(normalized_title);
        }

        if !self
            .compatibility
            .is_session_loaded_in_memory(&session_id)
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?
        {
            return Err(DesktopSessionApplicationError::Validation(
                "workspace_path is required when the session is not loaded".to_string(),
            ));
        }
        let updated_title = self
            .compatibility
            .update_loaded_session_title(&session_id, &title)
            .await
            .map_err(desktop_core_session_error)?;
        Ok(updated_title)
    }

    pub(crate) async fn ensure_session_loaded(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        include_internal: bool,
    ) -> DesktopSessionApplicationResult<()> {
        if self
            .compatibility
            .is_session_loaded_in_memory(session_id)
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?
        {
            return Ok(());
        }
        if request.workspace_id.is_none() && request.workspace_path.trim().is_empty() {
            return Err(DesktopSessionApplicationError::Validation(
                "workspace_id is required when the session is not loaded".to_string(),
            ));
        }
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        self.compatibility
            .ensure_session_loaded_from_storage_path(&storage_path, session_id, include_internal)
            .await
            .map_err(desktop_core_session_error)
    }

    pub(crate) async fn restore_session(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        include_internal: bool,
    ) -> DesktopSessionApplicationResult<Session> {
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        self.compatibility
            .restore_session_from_storage_path(&storage_path, session_id, include_internal)
            .await
            .map_err(desktop_core_session_error)
    }

    pub(crate) fn session_interaction_snapshot(
        &self,
        session_id: &str,
    ) -> SessionInteractionSnapshot {
        self.agent_runtime.session_interaction_snapshot(session_id)
    }

    /// Incremental catch-up for a client that already applied up to `cursor`.
    ///
    /// Workspace-agnostic: the journal belongs to this Runtime Host, not to any
    /// workspace filesystem, so no session scope is resolved here.
    pub(crate) fn session_events_since(
        &self,
        session_id: &str,
        stream_id: &str,
        cursor: u64,
    ) -> Option<SessionEventBackfill> {
        self.agent_runtime
            .session_events_since(session_id, stream_id, cursor)
    }

    pub(crate) async fn restore_session_view<F>(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        include_internal: bool,
        tail_turn_count: Option<usize>,
        on_storage_path_resolved: F,
    ) -> DesktopSessionApplicationResult<DesktopSessionViewRestore>
    where
        F: FnOnce(u64) + Send,
    {
        let path_started_at = Instant::now();
        let scope = self.resolved_scope(request).await?;
        let storage_path = self.storage_path(&scope);
        let resolve_storage_path_duration_ms =
            path_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        on_storage_path_resolved(resolve_storage_path_duration_ms);
        let (mut session, turns, total_turn_count, turn_catalog, mut timings) = self
            .compatibility
            .restore_session_view_from_storage_path(
                &storage_path,
                session_id,
                include_internal,
                tail_turn_count,
            )
            .await
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        let live_session = self
            .compatibility
            .loaded_session_snapshot(session_id)
            .map_err(|error| DesktopSessionApplicationError::Core(error.to_string()))?;
        overlay_live_session_state(&mut session, live_session);
        let interaction_snapshot = self.agent_runtime.session_interaction_snapshot(session_id);
        let runtime_event_snapshot = self
            .agent_runtime
            .session_event_projection_snapshot(session_id);
        let current_context_usage = self
            .compatibility
            .load_persisted_session_metadata(&storage_path, session_id)
            .await
            .map_err(desktop_core_session_error)?
            .and_then(|metadata| metadata.current_context_usage);
        timings.resolve_storage_path_duration_ms = resolve_storage_path_duration_ms;
        Ok(DesktopSessionViewRestore {
            session,
            turns,
            interaction_snapshot,
            runtime_event_snapshot,
            current_context_usage,
            total_turn_count,
            turn_catalog,
            timings,
        })
    }

    pub(crate) async fn restore_session_with_turns<F>(
        &self,
        request: DesktopSessionScopeRequest,
        session_id: &str,
        include_internal: bool,
        on_storage_path_resolved: F,
    ) -> DesktopSessionApplicationResult<DesktopSessionWithTurnsRestore>
    where
        F: FnOnce(u64) + Send,
    {
        let path_started_at = Instant::now();
        let scope = self.resolved_scope(request).await?;
        self.ensure_runtime_ownership(&scope)?;
        let storage_path = self.storage_path(&scope);
        let resolve_storage_path_duration_ms =
            path_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        on_storage_path_resolved(resolve_storage_path_duration_ms);
        let (session, turns) = self
            .compatibility
            .restore_session_with_turns_from_storage_path(
                &storage_path,
                session_id,
                include_internal,
            )
            .await
            .map_err(desktop_core_session_error)?;
        Ok(DesktopSessionWithTurnsRestore { session, turns })
    }
}

async fn delete_session_with_host_effects(
    agent_runtime: &AgentRuntime,
    host_effects: &dyn DesktopSessionHostEffects,
    scope: ResolvedDesktopSessionScope,
    session_id: String,
) -> DesktopSessionApplicationResult<()> {
    host_effects.release_session(&session_id).await;
    agent_runtime
        .delete_session(AgentSessionDeleteRequest {
            workspace_id: Some(scope.workspace_id.clone()),
            workspace_path: scope.workspace_path.clone(),
            session_id: session_id.clone(),
            remote_connection_id: scope.remote_connection_id,
            remote_ssh_host: scope.resolved_remote_ssh_host,
        })
        .await
        .map_err(|error| DesktopSessionApplicationError::Runtime(error.into_message()))?;
    Ok(())
}

fn merge_ui_owned_session_metadata(
    current: &mut SessionMetadata,
    incoming: &SessionMetadata,
    fields: &[UiSessionMetadataField],
) {
    if fields.contains(&UiSessionMetadataField::SessionName) {
        current.session_name = incoming.session_name.clone();
    }
    if fields.contains(&UiSessionMetadataField::Tags) {
        current.tags = incoming.tags.clone();
    }
    if fields.contains(&UiSessionMetadataField::Todos) {
        current.todos = incoming.todos.clone();
    }
    if fields.contains(&UiSessionMetadataField::ReviewActionState) {
        current.review_action_state = incoming.review_action_state.clone();
    }
    if fields.contains(&UiSessionMetadataField::UnreadCompletion) {
        openbitfun_core::service::session::apply_session_unread_completion(current, incoming);
    }
    if fields.contains(&UiSessionMetadataField::NeedsUserAttention) {
        current.needs_user_attention = incoming.needs_user_attention.clone();
    }
    if fields.contains(&UiSessionMetadataField::TitleMetadata) {
        openbitfun_core::service::session::apply_session_title_metadata(current, incoming);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_agent_runtime::sdk::{
        AgentRuntimeBuilder, AgentSessionCreateRequest, AgentSessionCreateResult,
        AgentSessionListRequest, AgentSessionManagementPort, AgentSessionSummary,
        AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest, AgentSubmissionPort,
        AgentSubmissionRequest, AgentSubmissionResult, PortError, PortErrorKind, PortResult,
    };
    use openbitfun_core::service::session::{
        SessionContextUsage, SessionContextUsageSource, SessionKind, SessionMemoryMode,
    };
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn session_writer_conflict_keeps_a_stable_desktop_transport_code() {
        let error = desktop_core_session_error(
            openbitfun_core::util::errors::OpenBitFunError::SessionInUse {
                session_id: "session-1".to_string(),
            },
        );

        assert!(matches!(
            error,
            DesktopSessionApplicationError::SessionInUse(_)
        ));
        assert_eq!(
            error.to_string(),
            "session_in_use: Session is already open for writing: session-1"
        );
    }

    #[test]
    fn unknown_rename_outcomes_keep_a_stable_desktop_transport_code() {
        let error = desktop_runtime_session_error(RuntimeError::Port(PortError::new(
            PortErrorKind::OutcomeUnknown,
            "inspect authoritative state",
        )));

        assert!(matches!(
            error,
            DesktopSessionApplicationError::OutcomeUnknown(_)
        ));
        assert_eq!(
            error.to_string(),
            "outcome_unknown: inspect authoritative state"
        );
    }

    #[test]
    fn compatibility_rename_unknown_outcomes_keep_the_same_transport_code() {
        let error = desktop_core_session_error(OpenBitFunError::OutcomeUnknown(
            "inspect authoritative state".to_string(),
        ));

        assert_eq!(
            error.to_string(),
            "outcome_unknown: inspect authoritative state"
        );
    }

    #[test]
    fn desktop_local_usage_turn_maps_to_the_fixed_runtime_append_contract() {
        let mut turn = DialogTurnData::new_with_kind(
            DialogTurnKind::LocalCommand,
            "local-usage-report-1".to_string(),
            2,
            "session-1".to_string(),
            None,
            openbitfun_core::service::session::UserMessageData {
                id: "local-usage-user-report-1".to_string(),
                content: "# Usage".to_string(),
                timestamp: 42,
                metadata: Some(json!({
                    "localCommandKind": "usage_report",
                    "reportId": "report-1"
                })),
            },
        );
        turn.timestamp = 42;

        let request = local_command_turn_record_request(&turn)
            .expect("valid local command")
            .expect("local command request");
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.turn_id.as_deref(), Some("local-usage-report-1"));
        assert_eq!(request.content, "# Usage");
        assert_eq!(request.timestamp_ms, Some(42));
        assert_eq!(request.metadata["localCommandKind"], "usage_report");

        let source = include_str!("session_application.rs");
        assert!(source.contains("record_completed_local_command_turn(local_command)"));
    }

    struct RecordingDeletePort {
        events: Arc<Mutex<Vec<&'static str>>>,
        workspace_path: Arc<Mutex<Option<String>>>,
        fail_delete: bool,
    }

    struct NoopSubmissionPort;

    #[async_trait]
    impl AgentSubmissionPort for NoopSubmissionPort {
        async fn create_session(
            &self,
            request: AgentSessionCreateRequest,
        ) -> PortResult<AgentSessionCreateResult> {
            Ok(AgentSessionCreateResult::new(
                "unused",
                request.session_name,
                request.agent_type,
            ))
        }

        async fn submit_message(
            &self,
            _request: AgentSubmissionRequest,
        ) -> PortResult<AgentSubmissionResult> {
            Ok(AgentSubmissionResult {
                turn_id: "unused".to_string(),
                accepted: true,
            })
        }

        async fn resolve_session_agent_type(
            &self,
            _session_id: &str,
        ) -> PortResult<Option<String>> {
            Ok(None)
        }
    }

    #[async_trait]
    impl AgentSessionManagementPort for RecordingDeletePort {
        async fn list_sessions(
            &self,
            _request: AgentSessionListRequest,
        ) -> PortResult<Vec<AgentSessionSummary>> {
            Ok(Vec::new())
        }

        async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()> {
            self.events.lock().unwrap().push("durable_delete");
            *self.workspace_path.lock().unwrap() = Some(request.workspace_path);
            if self.fail_delete {
                return Err(PortError::new(PortErrorKind::Backend, "delete failed"));
            }
            Ok(())
        }

        async fn resolve_session_workspace_binding(
            &self,
            _request: AgentSessionWorkspaceRequest,
        ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
            Ok(None)
        }
    }

    struct RecordingHostEffects {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    #[async_trait]
    impl DesktopSessionHostEffects for RecordingHostEffects {
        async fn release_session(&self, _session_id: &str) {
            self.events.lock().unwrap().push("release");
        }
    }

    fn delete_test_scope() -> ResolvedDesktopSessionScope {
        ResolvedDesktopSessionScope {
            workspace_id: "test-workspace".to_string(),
            workspace_path: "D:/workspace/project".to_string(),
            effective_storage_path: PathBuf::from("D:/managed/project/sessions"),
            remote_connection_id: None,
            requested_remote_ssh_host: None,
            resolved_remote_ssh_host: None,
            remote_binding_verified: false,
        }
    }

    fn delete_test_runtime(
        events: Arc<Mutex<Vec<&'static str>>>,
        workspace_path: Arc<Mutex<Option<String>>>,
        fail_delete: bool,
    ) -> AgentRuntime {
        AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(NoopSubmissionPort))
            .with_session_management_port(Arc::new(RecordingDeletePort {
                events,
                workspace_path,
                fail_delete,
            }))
            .build()
            .expect("delete test runtime")
    }

    #[test]
    fn live_processing_state_overlays_sanitized_view_state() {
        let mut restored = Session::new_with_id(
            "session-1".to_string(),
            "Restored".to_string(),
            "Standard".to_string(),
            Default::default(),
        );
        let mut live = restored.clone();
        live.state = openbitfun_core::agentic::core::SessionState::Processing {
            current_turn_id: "turn-1".to_string(),
            phase: openbitfun_core::agentic::core::ProcessingPhase::Streaming,
        };

        overlay_live_session_state(&mut restored, Some(live));

        assert!(matches!(
            restored.state,
            openbitfun_core::agentic::core::SessionState::Processing {
                ref current_turn_id,
                ..
            } if current_turn_id == "turn-1"
        ));
    }

    #[test]
    fn missing_live_session_keeps_persisted_view_state() {
        let mut restored = Session::new_with_id(
            "session-1".to_string(),
            "Restored".to_string(),
            "Standard".to_string(),
            Default::default(),
        );

        overlay_live_session_state(&mut restored, None);

        assert!(matches!(
            restored.state,
            openbitfun_core::agentic::core::SessionState::Idle
        ));
    }

    #[tokio::test]
    async fn local_session_storage_identity_survives_workspace_removal() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-desktop-session-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace_path = root.join("project");
        std::fs::create_dir_all(&workspace_path).expect("workspace directory");
        let workspace_path = workspace_path
            .canonicalize()
            .expect("canonical workspace path")
            .to_string_lossy()
            .into_owned();

        let before_removal = get_effective_session_path(&workspace_path, None, None).await;
        std::fs::remove_dir_all(&workspace_path).expect("remove workspace directory");
        let after_removal = get_effective_session_path(&workspace_path, None, None).await;

        assert_eq!(after_removal, before_removal);
        assert_eq!(
            after_removal.file_name().and_then(|value| value.to_str()),
            Some("sessions")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn offline_saved_ssh_host_resolves_to_the_same_remote_session_tree() {
        let connection_id = "offline-saved-host-test";
        let workspace_path = "/srv/offline-project";
        let saved_host = "saved.example";

        let resolved =
            get_effective_session_path(workspace_path, Some(connection_id), Some(saved_host)).await;
        let unresolved =
            get_effective_session_path(workspace_path, Some(connection_id), None).await;

        assert_ne!(resolved, unresolved);
        assert_eq!(
            resolved.file_name().and_then(|value| value.to_str()),
            Some("sessions")
        );
        assert!(!resolved
            .components()
            .any(|component| component.as_os_str() == std::ffi::OsStr::new("_unresolved")));
    }

    #[test]
    fn application_boundary_stays_framework_neutral() {
        let source = include_str!("session_application.rs");
        let tauri_namespace = ["tauri", "::"].concat();
        let tauri_state = ["tauri", "::", "State"].concat();
        assert!(!source.contains(&tauri_namespace));
        assert!(!source.contains(&tauri_state));
        for forbidden in [
            ["crate", "::", "api"].concat(),
            ["openbitfun", "_acp"].concat(),
        ] {
            assert!(!source.contains(&forbidden), "unexpected {forbidden}");
        }
        for forbidden in [
            ["Product", "Assembler"].concat(),
            ["Runtime", "Services"].concat(),
            ["Harness", "Registry"].concat(),
        ] {
            assert!(!source.contains(&forbidden), "unexpected {forbidden}");
        }
    }

    #[tokio::test]
    async fn delete_orders_host_release_durable_delete_and_relay_tombstone() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let workspace_path = Arc::new(Mutex::new(None));
        let runtime = delete_test_runtime(events.clone(), workspace_path.clone(), false);
        let host_effects = RecordingHostEffects {
            events: events.clone(),
        };

        delete_session_with_host_effects(
            &runtime,
            &host_effects,
            delete_test_scope(),
            "session-1".to_string(),
        )
        .await
        .expect("delete should succeed");

        assert_eq!(
            events.lock().unwrap().as_slice(),
            ["release", "durable_delete"]
        );
        assert_eq!(
            workspace_path.lock().unwrap().as_deref(),
            Some("D:/workspace/project")
        );
    }

    #[tokio::test]
    async fn delete_failure_does_not_publish_relay_tombstone() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = delete_test_runtime(events.clone(), Arc::new(Mutex::new(None)), true);
        let host_effects = RecordingHostEffects {
            events: events.clone(),
        };

        let error = delete_session_with_host_effects(
            &runtime,
            &host_effects,
            delete_test_scope(),
            "session-1".to_string(),
        )
        .await
        .expect_err("durable delete should fail");

        assert!(matches!(error, DesktopSessionApplicationError::Runtime(_)));
        assert_eq!(
            events.lock().unwrap().as_slice(),
            ["release", "durable_delete"]
        );
    }

    #[test]
    fn ui_metadata_merge_preserves_core_authoritative_fields_and_custom_keys() {
        let mut current = SessionMetadata::new(
            "session".to_string(),
            "Current".to_string(),
            "plan".to_string(),
            "model-a".to_string(),
        );
        current.last_submitted_agent_type = Some("plan".to_string());
        current.memory_mode = SessionMemoryMode::Polluted;
        current.session_kind = SessionKind::Standard;
        current.status = SessionStatus::Archived;
        current.turn_count = 7;
        current.custom_metadata = Some(json!({
            "threadGoal": { "objective": "preserve" },
            "titleSource": "i18n",
            "titleKey": "old"
        }));
        current.current_context_usage = Some(SessionContextUsage {
            turn_id: "turn-7".to_string(),
            input_tokens: 42_000,
            output_tokens: Some(1_500),
            total_tokens: 43_500,
            timestamp: 123,
            source: SessionContextUsageSource::ModelRequest,
        });

        let mut incoming = current.clone();
        incoming.session_name = "Renamed".to_string();
        incoming.agent_type = "Standard".to_string();
        incoming.model_name = "stale-model".to_string();
        incoming.memory_mode = SessionMemoryMode::Enabled;
        incoming.status = SessionStatus::Active;
        incoming.turn_count = 1;
        incoming.review_action_state = Some(json!({ "phase": "fixing" }));
        incoming.current_context_usage = Some(SessionContextUsage {
            turn_id: "stale-turn".to_string(),
            input_tokens: 1,
            output_tokens: None,
            total_tokens: 1,
            timestamp: 1,
            source: SessionContextUsageSource::ContextCompression,
        });
        incoming.custom_metadata = Some(json!({
            "titleSource": "i18n",
            "titleKey": "new",
            "untrustedCoreKey": "drop"
        }));

        merge_ui_owned_session_metadata(
            &mut current,
            &incoming,
            &[
                UiSessionMetadataField::SessionName,
                UiSessionMetadataField::Tags,
                UiSessionMetadataField::Todos,
                UiSessionMetadataField::ReviewActionState,
                UiSessionMetadataField::UnreadCompletion,
                UiSessionMetadataField::NeedsUserAttention,
                UiSessionMetadataField::TitleMetadata,
            ],
        );

        assert_eq!(current.session_name, "Renamed");
        assert_eq!(current.agent_type, "plan");
        assert_eq!(current.model_name, "model-a");
        assert_eq!(current.memory_mode, SessionMemoryMode::Polluted);
        assert_eq!(current.status, SessionStatus::Archived);
        assert_eq!(current.turn_count, 7);
        assert_eq!(current.review_action_state, incoming.review_action_state);
        assert_eq!(
            current.current_context_usage,
            Some(SessionContextUsage {
                turn_id: "turn-7".to_string(),
                input_tokens: 42_000,
                output_tokens: Some(1_500),
                total_tokens: 43_500,
                timestamp: 123,
                source: SessionContextUsageSource::ModelRequest,
            })
        );
        let custom = current.custom_metadata.unwrap();
        assert_eq!(custom["threadGoal"]["objective"], "preserve");
        assert_eq!(custom["titleKey"], "new");
        assert!(custom.get("untrustedCoreKey").is_none());
    }

    #[test]
    fn ui_metadata_field_mask_keeps_independent_writers_isolated() {
        let mut current = SessionMetadata::new(
            "session".to_string(),
            "Current".to_string(),
            "Standard".to_string(),
            "primary".to_string(),
        );
        current.review_action_state = Some(json!({ "phase": "review_completed" }));
        current.unread_completion = Some("completed".to_string());
        current.needs_user_attention = Some("ask_user".to_string());

        let mut stale_general_update = current.clone();
        stale_general_update.session_name = "Renamed".to_string();
        stale_general_update.review_action_state = None;
        merge_ui_owned_session_metadata(
            &mut current,
            &stale_general_update,
            &[UiSessionMetadataField::SessionName],
        );
        assert_eq!(current.session_name, "Renamed");
        assert_eq!(
            current.review_action_state,
            Some(json!({ "phase": "review_completed" }))
        );
        assert_eq!(current.unread_completion.as_deref(), Some("completed"));
        assert_eq!(current.needs_user_attention.as_deref(), Some("ask_user"));

        let mut review_update = current.clone();
        review_update.review_action_state = Some(json!({ "phase": "fixing" }));
        review_update.unread_completion = None;
        review_update.needs_user_attention = None;
        merge_ui_owned_session_metadata(
            &mut current,
            &review_update,
            &[UiSessionMetadataField::ReviewActionState],
        );
        assert_eq!(
            current.review_action_state,
            Some(json!({ "phase": "fixing" }))
        );
        assert_eq!(current.unread_completion.as_deref(), Some("completed"));
        assert_eq!(current.needs_user_attention.as_deref(), Some("ask_user"));
    }
}
