//! Core-owned bindings for service and agent runtime ports.
//!
//! Owner crates keep portable contracts and orchestration policy. This module
//! centralizes the concrete core adapters that still own scheduler execution,
//! session restore, terminal pre-warm, remote image conversion, and runtime-port
//! implementations until a reviewed port/provider migration proves equivalence.

#[cfg(feature = "remote-connect")]
use log::{debug, info};
use openbitfun_agent_runtime::sdk::{
    AgentEventSource, AgentInteractionResponsePort, AgentModeCatalogEntry, AgentModeCatalogPort,
    AgentModeCatalogQuery, AgentRuntime, AgentRuntimeBuilder, AgentSessionCompactionPort,
    AgentSessionForkPort, AgentSessionLineagePort, AgentSessionModePort, AgentSessionModelPort,
    AgentSessionRestorePort, AgentSessionRestoreRequest, AgentSessionRestoreResult,
    AgentSessionRevertPort, AgentSessionUsagePort, AgentTurnSettlementPort, RuntimeError,
};
#[cfg(feature = "remote-connect")]
use openbitfun_agent_runtime::sdk::{
    AgentSessionModelSelection, AgentSessionModelSelectionUpdateRequest,
    AgentSessionModelUpdateRequest,
};
use openbitfun_events::AgenticEvent;
#[cfg(feature = "remote-connect")]
use openbitfun_runtime_ports::{
    AgentDialogSteerRequest, AgentInputAttachment, AgentSubmissionSource,
    AgentTurnCancellationRequest, DialogSteerOutcome, PermissionPolicyPreset,
    RemoteControlStatePort, RemoteControlStateRequest, RemoteControlStateSnapshot,
    RemoteSessionWorkspaceIdentity, RuntimeServiceCapability, RuntimeServicePort,
    ToolPermissionConfig,
};
use openbitfun_runtime_ports::{
    AgentDialogTurnPort, AgentDialogTurnRequest, AgentLifecycleDeliveryPort,
    AgentLocalCommandTurnPort, AgentSessionClosePort, AgentSessionCreateRequest,
    AgentSessionCreateResult, AgentSessionManagementPort, AgentSessionRevertRequest,
    AgentSessionRevertResult, AgentSessionRollbackToTurnOutcome, AgentSessionRollbackToTurnRequest,
    AgentSubmissionPort, AgentSubmissionRequest, AgentSubmissionResult,
    AgentThreadGoalManagementPort, AgentTurnCancellationPort, AgentUserShellCommandPort,
    AgentWorkspaceReferencePort, PortError, PortErrorKind, PortResult, SessionStorePort,
};
#[cfg(feature = "remote-connect")]
use openbitfun_services_integrations::remote_connect::{
    agent_input_attachment_from_remote_image_context, build_remote_chat_messages,
    build_remote_model_catalog,
    normalize_remote_model_selection as normalize_remote_model_selection_contract,
    normalize_remote_session_model_id, project_remote_chat_user,
    remote_dialog_submit_outcome_from_scheduler, remote_model_selection_needs_config, ChatMessage,
    RemoteAssistantWorkspaceFacts, RemoteCancelRuntimeHost, RemoteChatHistoryRound,
    RemoteChatHistoryTextItem, RemoteChatHistoryThinkingItem, RemoteChatHistoryToolCall,
    RemoteChatHistoryToolItem, RemoteChatHistoryTurn, RemoteConnectSubmissionSource,
    RemoteDefaultModelsConfig, RemoteDialogQueuePriority, RemoteDialogResolvedSubmission,
    RemoteDialogRuntimeHost, RemoteDialogSchedulerOutcomeFact, RemoteDialogSteerOutcome,
    RemoteDialogSteerRequest, RemoteDialogSubmissionPolicy, RemoteDialogSubmitOutcome,
    RemoteDialogWorkspaceBinding, RemoteImageContext, RemoteInitialSyncRuntimeHost,
    RemoteInteractionRuntimeHost, RemoteModelCapabilityFact, RemoteModelCatalog,
    RemoteModelCatalogFacts, RemoteModelFacts, RemotePermissionMode, RemotePollRuntimeHost,
    RemoteRecentWorkspaceFacts, RemoteSessionMetadata, RemoteSessionModelSelection,
    RemoteSessionRuntimeHost, RemoteSessionStateTracker, RemoteSessionTrackerHost,
    RemoteTerminalPrewarmRequest, RemoteWorkspaceFacts, RemoteWorkspaceFileRuntimeHost,
    RemoteWorkspaceKind as RemoteConnectWorkspaceKind, RemoteWorkspaceRuntimeHost,
    RemoteWorkspaceUpdate,
};
use std::sync::Arc;
use std::time::Duration;

use crate::agentic::coordination::{
    get_global_coordinator, get_global_scheduler, ConversationCoordinator, DialogScheduler,
    DialogSubmitOutcome,
};
#[cfg(feature = "remote-connect")]
use crate::agentic::coordination::{
    DialogQueuePriority, DialogSubmissionPolicy, DialogTriggerSource,
};
#[cfg(feature = "remote-connect")]
use crate::agentic::core::{Session, SessionKind};
#[cfg(feature = "remote-connect")]
use crate::agentic::image_analysis::ImageContextData;
use crate::agentic::session::session_store_port::CoreSessionStorePort;
use crate::agentic::workspace::WorkspaceBinding;
#[cfg(feature = "remote-connect")]
use crate::infrastructure::ai::provider_catalog::resolve_builtin_provider_catalog;
#[cfg(feature = "remote-connect")]
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog, project_model_reasoning_catalog, resolve_reasoning_preset,
};
#[cfg(feature = "remote-connect")]
use crate::service::remote_connect::remote_server::RemoteExecutionDispatcher;

#[cfg(feature = "remote-connect")]
use crate::service::config::types::{AIConfig, GlobalConfig, ModelCapability};
#[cfg(feature = "remote-connect")]
use crate::service::session::{DialogTurnData, ToolItemIdentityExt, TurnStatus};

#[cfg(feature = "opencode-plugin-host")]
#[derive(Clone)]
struct ConfiguredPluginSubmissionPort {
    inner: Arc<dyn AgentSubmissionPort>,
    coordinator: Arc<ConversationCoordinator>,
}

#[cfg(feature = "opencode-plugin-host")]
impl ConfiguredPluginSubmissionPort {
    async fn try_ensure_workspace(request: &AgentSessionCreateRequest) -> PortResult<()> {
        let Some(_execution_root) = configured_plugin_execution_root(request).await? else {
            return Ok(());
        };
        crate::plugin_host::ensure_configured_plugin_instance(
            crate::plugin_host::PluginHostLaunchPolicy::Enabled,
            request.workspace_id.as_deref().ok_or_else(|| {
                PortError::new(PortErrorKind::InvalidRequest, "Workspace ID is required")
            })?,
        )
        .await
        .map(|_| ())
        .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))
    }

    async fn ensure_workspace(request: &AgentSessionCreateRequest) {
        if let Err(error) = Self::try_ensure_workspace(request).await {
            crate::plugin_host::report_configured_plugin_activation_failure(
                "session creation",
                request.workspace_id.as_deref(),
                error,
            )
            .await;
        }
    }

    async fn try_ensure_session(&self, session_id: &str) -> PortResult<()> {
        let Some(session) = self
            .coordinator
            .get_session_manager()
            .get_session(session_id)
        else {
            return Ok(());
        };
        let Some(_execution_root) = configured_plugin_root_from_session_facts(
            session.config.workspace_path.as_deref(),
            session.config.execution_target.as_ref(),
            session.config.is_remote_workspace(),
        )?
        else {
            return Ok(());
        };
        crate::plugin_host::ensure_configured_plugin_instance(
            crate::plugin_host::PluginHostLaunchPolicy::Enabled,
            session.config.workspace_id.as_deref().ok_or_else(|| {
                PortError::new(PortErrorKind::InvalidRequest, "Workspace ID is required")
            })?,
        )
        .await
        .map(|_| ())
        .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))
    }

    async fn ensure_session(&self, session_id: &str) {
        if let Err(error) = self.try_ensure_session(session_id).await {
            crate::plugin_host::report_configured_plugin_activation_failure(
                "existing session",
                None,
                error,
            )
            .await;
        }
    }
}

#[cfg(feature = "opencode-plugin-host")]
async fn configured_plugin_execution_root(
    request: &AgentSessionCreateRequest,
) -> PortResult<Option<std::path::PathBuf>> {
    let mut config = crate::agentic::core::SessionConfig {
        workspace_id: request.workspace_id.clone(),
        workspace_path: request.workspace_path.clone(),
        project_workspace_path: request.project_workspace_path.clone(),
        remote_connection_id: request.remote_connection_id.clone(),
        remote_ssh_host: request.remote_ssh_host.clone(),
        ..Default::default()
    };
    crate::agentic::workspace::normalize_session_workspace(&mut config)
        .await
        .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error.to_string()))?;
    configured_plugin_root_from_session_facts(
        request.workspace_path.as_deref(),
        request.execution_target.as_ref(),
        config.is_remote_workspace(),
    )
}

#[cfg(feature = "opencode-plugin-host")]
fn configured_plugin_root_from_session_facts(
    workspace_path: Option<&str>,
    execution_target: Option<&openbitfun_core_types::SessionExecutionTarget>,
    is_remote: bool,
) -> PortResult<Option<std::path::PathBuf>> {
    if is_remote {
        return Ok(None);
    }
    execution_target
        .map(|target| target.root_path.as_str())
        .or(workspace_path)
        .map(std::path::PathBuf::from)
        .map(Some)
        .ok_or_else(|| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                "workspace_path is required to initialize configured plugins",
            )
        })
}

#[cfg(feature = "opencode-plugin-host")]
#[async_trait::async_trait]
impl AgentSubmissionPort for ConfiguredPluginSubmissionPort {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        Self::ensure_workspace(&request).await;
        self.inner.create_session(request).await
    }

    async fn create_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        Self::ensure_workspace(&request).await;
        self.inner.create_session_with_id(session_id, request).await
    }

    async fn create_transient_session_with_id(
        &self,
        session_id: String,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        Self::ensure_workspace(&request).await;
        self.inner
            .create_transient_session_with_id(session_id, request)
            .await
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        // Every existing-session turn is a recovery trigger. The ensure call
        // is idempotent while the Host is healthy and republishes the same
        // workspace generation after a process loss before execution resumes.
        self.ensure_session(&request.session_id).await;
        self.inner.submit_message(request).await
    }

    async fn resolve_session_agent_type(&self, session_id: &str) -> PortResult<Option<String>> {
        self.inner.resolve_session_agent_type(session_id).await
    }
}

fn configured_plugin_submission_port(
    coordinator: Arc<ConversationCoordinator>,
) -> Arc<dyn AgentSubmissionPort> {
    #[cfg(feature = "opencode-plugin-host")]
    {
        let inner: Arc<dyn AgentSubmissionPort> = coordinator.clone();
        Arc::new(ConfiguredPluginSubmissionPort { inner, coordinator })
    }
    #[cfg(not(feature = "opencode-plugin-host"))]
    {
        coordinator
    }
}

#[cfg(feature = "opencode-plugin-host")]
#[derive(Clone)]
struct ConfiguredPluginSessionRestorePort {
    inner: Arc<dyn AgentSessionRestorePort>,
    submission: ConfiguredPluginSubmissionPort,
}

#[cfg(feature = "opencode-plugin-host")]
#[async_trait::async_trait]
impl AgentSessionRestorePort for ConfiguredPluginSessionRestorePort {
    async fn restore_session(
        &self,
        request: AgentSessionRestoreRequest,
    ) -> PortResult<AgentSessionRestoreResult> {
        let restored = self.inner.restore_session(request).await?;
        // The restored Session owns the authoritative execution target,
        // including managed worktrees. Do not publish a plugin generation for
        // the storage-path hint before that target has been reconstructed.
        self.submission
            .ensure_session(&restored.session.session_id)
            .await;
        Ok(restored)
    }
}

fn configured_plugin_session_restore_port(
    coordinator: Arc<ConversationCoordinator>,
) -> Arc<dyn AgentSessionRestorePort> {
    #[cfg(feature = "opencode-plugin-host")]
    {
        let inner: Arc<dyn AgentSessionRestorePort> = coordinator.clone();
        let submission_inner: Arc<dyn AgentSubmissionPort> = coordinator.clone();
        Arc::new(ConfiguredPluginSessionRestorePort {
            inner,
            submission: ConfiguredPluginSubmissionPort {
                inner: submission_inner,
                coordinator,
            },
        })
    }
    #[cfg(not(feature = "opencode-plugin-host"))]
    {
        coordinator
    }
}

#[cfg(feature = "opencode-plugin-host")]
struct ConfiguredPluginDialogTurnPort {
    inner: Arc<dyn AgentDialogTurnPort>,
    submission: ConfiguredPluginSubmissionPort,
}

#[cfg(feature = "opencode-plugin-host")]
#[async_trait::async_trait]
impl AgentDialogTurnPort for ConfiguredPluginDialogTurnPort {
    async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> PortResult<DialogSubmitOutcome> {
        self.submission.ensure_session(&request.session_id).await;
        self.inner.submit_dialog_turn(request).await
    }

    async fn steer_dialog_turn(
        &self,
        request: openbitfun_runtime_ports::AgentDialogSteerRequest,
    ) -> PortResult<openbitfun_runtime_ports::DialogSteerOutcome> {
        self.inner.steer_dialog_turn(request).await
    }

    async fn recover_interrupted_turn(
        &self,
        request: openbitfun_runtime_ports::AgentDialogTurnRecoveryRequest,
    ) -> PortResult<openbitfun_runtime_ports::AgentDialogTurnRecoveryOutcome> {
        self.submission.ensure_session(&request.session_id).await;
        self.inner.recover_interrupted_turn(request).await
    }
}

fn configured_plugin_dialog_turn_port(
    coordinator: Arc<ConversationCoordinator>,
    inner: Arc<dyn AgentDialogTurnPort>,
) -> Arc<dyn AgentDialogTurnPort> {
    #[cfg(feature = "opencode-plugin-host")]
    {
        let submission_inner: Arc<dyn AgentSubmissionPort> = coordinator.clone();
        Arc::new(ConfiguredPluginDialogTurnPort {
            inner,
            submission: ConfiguredPluginSubmissionPort {
                inner: submission_inner,
                coordinator,
            },
        })
    }
    #[cfg(not(feature = "opencode-plugin-host"))]
    {
        let _ = coordinator;
        inner
    }
}

#[cfg(feature = "remote-connect")]
fn remote_workspace_kind(
    kind: crate::service::workspace::WorkspaceKind,
) -> RemoteConnectWorkspaceKind {
    match kind {
        crate::service::workspace::WorkspaceKind::Normal => RemoteConnectWorkspaceKind::Normal,
        crate::service::workspace::WorkspaceKind::Assistant => {
            RemoteConnectWorkspaceKind::Assistant
        }
        crate::service::workspace::WorkspaceKind::Remote => RemoteConnectWorkspaceKind::Remote,
    }
}

#[cfg(feature = "remote-connect")]
fn git_branch_for_workspace_path(path: &std::path::Path) -> Option<String> {
    let path_str = path.to_string_lossy();
    openbitfun_services_integrations::git::execute_git_command_sync(
        &path_str,
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty() && s != "HEAD")
}

#[cfg(feature = "remote-connect")]
fn workspace_metadata_string(
    metadata: &std::collections::HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    metadata
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(feature = "remote-connect")]
pub(crate) fn remote_workspace_metadata(
    kind: &crate::service::workspace::WorkspaceKind,
    metadata: &std::collections::HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    // Local persistence uses sshHost=localhost as an identity marker. It is
    // not an SSH routing hint; real SSH connections to localhost remain remote.
    if *kind != crate::service::workspace::WorkspaceKind::Remote {
        return None;
    }
    workspace_metadata_string(metadata, key)
}

#[cfg(feature = "remote-connect")]
pub(crate) fn remote_workspace_display_name(
    workspace: &crate::service::workspace::WorkspaceInfo,
) -> &str {
    if workspace.workspace_kind == crate::service::workspace::WorkspaceKind::Assistant {
        workspace
            .identity
            .as_ref()
            .and_then(|identity| identity.name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&workspace.name)
    } else {
        &workspace.name
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) async fn remote_opened_workspace_catalog(
    service: &crate::service::workspace::WorkspaceService,
) -> Vec<RemoteRecentWorkspaceFacts> {
    service
        .get_opened_workspaces()
        .await
        .into_iter()
        .map(|workspace| RemoteRecentWorkspaceFacts {
            workspace_id: workspace.id.clone(),
            name: remote_workspace_display_name(&workspace).to_string(),
            path: workspace.root_path.to_string_lossy().to_string(),
            last_opened: workspace.last_accessed.to_rfc3339(),
            kind: remote_workspace_kind(workspace.workspace_kind.clone()),
            remote_connection_id: remote_workspace_metadata(
                &workspace.workspace_kind,
                &workspace.metadata,
                "connectionId",
            ),
            remote_ssh_host: remote_workspace_metadata(
                &workspace.workspace_kind,
                &workspace.metadata,
                "sshHost",
            ),
        })
        .collect()
}

#[cfg(feature = "remote-connect")]
async fn current_remote_workspace_facts() -> Option<RemoteWorkspaceFacts> {
    let workspace_service = crate::service::workspace::get_global_workspace_service()?;
    workspace_service
        .get_current_workspace()
        .await
        .map(|workspace| {
            let root_path = workspace.root_path.clone();
            RemoteWorkspaceFacts {
                workspace_id: workspace.id.clone(),
                path: root_path.to_string_lossy().to_string(),
                name: workspace.name,
                git_branch: git_branch_for_workspace_path(&root_path),
                kind: remote_workspace_kind(workspace.workspace_kind.clone()),
                assistant_id: workspace.assistant_id,
                remote_connection_id: remote_workspace_metadata(
                    &workspace.workspace_kind,
                    &workspace.metadata,
                    "connectionId",
                ),
                remote_ssh_host: remote_workspace_metadata(
                    &workspace.workspace_kind,
                    &workspace.metadata,
                    "sshHost",
                ),
            }
        })
}

#[cfg(feature = "remote-connect")]
async fn open_workspace_with_snapshot(
    path: &str,
    snapshot_log_context: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<RemoteWorkspaceUpdate, String> {
    let coordinator = get_global_coordinator()
        .ok_or_else(|| "Conversation coordinator not initialized".to_string())?;
    let workspace_service = crate::service::workspace::get_global_workspace_service()
        .ok_or_else(|| "Workspace service not available".to_string())?;
    let info = coordinator
        .upgrade_legacy_workspace_with_runtime_ownership(
            workspace_service.as_ref(),
            std::path::PathBuf::from(path),
            remote_connection_id,
            remote_ssh_host,
            snapshot_log_context,
        )
        .await
        .map_err(|error| error.to_string())?;
    let remote_connection_id = info.remote_ssh_connection_id().map(str::to_string);
    let remote_ssh_host =
        remote_workspace_metadata(&info.workspace_kind, &info.metadata, "sshHost");
    Ok(RemoteWorkspaceUpdate {
        workspace_id: info.id.clone(),
        path: info.root_path.to_string_lossy().to_string(),
        name: info.name,
        remote_connection_id,
        remote_ssh_host,
    })
}

#[cfg(feature = "remote-connect")]
async fn ensure_remote_binding_runtime_ownership(
    coordinator: &ConversationCoordinator,
    binding: &WorkspaceBinding,
) -> Result<(), String> {
    // The persisted binding names its workspace by ID; the path and SSH
    // projection only serves sessions written before workspace IDs.
    coordinator
        .ensure_workspace_runtime_ownership_for_reference(
            binding.workspace_id.as_deref(),
            &binding.logical_workspace_path_string(),
            binding.connection_id(),
            binding
                .is_remote()
                .then_some(binding.session_identity.hostname.as_str()),
        )
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Project a workspace record into the remote wire facts. Only the ID
/// identifies the workspace; the path and SSH fields are IO projections.
#[cfg(feature = "remote-connect")]
fn remote_workspace_facts_from_record(
    workspace: &crate::service::workspace::WorkspaceInfo,
) -> RemoteWorkspaceFacts {
    RemoteWorkspaceFacts {
        workspace_id: workspace.id.clone(),
        path: workspace.root_path.to_string_lossy().into_owned(),
        name: workspace.name.clone(),
        git_branch: None,
        kind: remote_workspace_kind(workspace.workspace_kind.clone()),
        assistant_id: workspace.assistant_id.clone(),
        remote_connection_id: remote_workspace_metadata(
            &workspace.workspace_kind,
            &workspace.metadata,
            "connectionId",
        ),
        remote_ssh_host: remote_workspace_metadata(
            &workspace.workspace_kind,
            &workspace.metadata,
            "sshHost",
        ),
    }
}

#[cfg(feature = "remote-connect")]
async fn load_remote_session_metadata_for_workspace(
    workspace_path: &std::path::Path,
    workspace_identity: RemoteSessionWorkspaceIdentity,
) -> Result<Vec<RemoteSessionMetadata>, String> {
    let workspace_path_display = workspace_path.to_string_lossy().to_string();
    // Remote handlers translate pre-ID references before reaching this
    // loader, so the record ID is the only storage key accepted here; the
    // path is display data for diagnostics.
    let workspace_id = workspace_identity
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            format!("Workspace ID is required to list sessions for {workspace_path_display}")
        })?;
    let session_storage_dir = CoreSessionStorePort::default()
        .resolve_workspace_storage(&workspace_id)
        .await
        .map_err(|error| format!("Failed to resolve session storage for workspace: {error}"))?
        .effective_storage_path;
    let path_manager = crate::infrastructure::PathManager::new()
        .map_err(|_| "Failed to initialize path manager".to_string())?;
    let path_manager = std::sync::Arc::new(path_manager);
    let store =
        crate::agentic::persistence::PersistenceManager::new(path_manager).map_err(|error| {
            debug!("PersistenceManager init failed for {workspace_path_display}: {error}");
            format!("Failed to initialize session storage: {error}")
        })?;
    let metadata = store
        .list_session_metadata(&session_storage_dir)
        .await
        .map_err(|error| {
            debug!("Session list read failed for {workspace_path_display}: {error}");
            format!("Failed to list sessions for workspace: {error}")
        })?;

    use openbitfun_services_core::session::SessionRelationshipKind;

    Ok(metadata
        .into_iter()
        .map(|session| {
            // Legacy sessions keep their lineage in `custom_metadata`, so the
            // normalized view is the only source that sees every child session.
            let relationship =
                openbitfun_services_core::session::normalized_session_relationship(&session);
            let relationship_kind = relationship
                .as_ref()
                .and_then(|relationship| relationship.kind.as_ref())
                .map(|kind| {
                    match kind {
                        SessionRelationshipKind::Btw => "btw",
                        SessionRelationshipKind::Review => "review",
                        SessionRelationshipKind::DeepReview => "deep_review",
                        SessionRelationshipKind::Miniapp => "miniapp",
                        SessionRelationshipKind::Subagent => "subagent",
                    }
                    .to_string()
                });
            let parent_session_id =
                relationship.and_then(|relationship| relationship.parent_session_id);
            RemoteSessionMetadata {
                workspace_id: session
                    .workspace_id
                    .clone()
                    .or_else(|| Some(workspace_id.clone())),
                session_id: session.session_id,
                name: session.session_name,
                agent_type: session.agent_type,
                created_at_ms: session.created_at,
                last_active_at_ms: session.last_active_at,
                turn_count: session.turn_count,
                parent_session_id,
                relationship_kind,
            }
        })
        .collect())
}

#[cfg(feature = "remote-connect")]
fn normalize_remote_model_selection(
    requested_model_id: &str,
    ai_config: Option<&AIConfig>,
) -> Result<String, String> {
    if remote_model_selection_needs_config(requested_model_id) && ai_config.is_none() {
        return Err("Config service not available".to_string());
    }

    normalize_remote_model_selection_contract(requested_model_id, |model_id| {
        ai_config.and_then(|config| config.resolve_model_reference(model_id))
    })
}

#[cfg(feature = "remote-connect")]
fn session_uses_shared_mode_default(session: &Session) -> bool {
    session.kind == SessionKind::Standard
}

#[cfg(feature = "remote-connect")]
fn remote_model_capability_fact(capability: ModelCapability) -> RemoteModelCapabilityFact {
    match capability {
        ModelCapability::TextChat => RemoteModelCapabilityFact::TextChat,
        ModelCapability::ImageUnderstanding => RemoteModelCapabilityFact::ImageUnderstanding,
        ModelCapability::ImageGeneration => RemoteModelCapabilityFact::ImageGeneration,
        ModelCapability::Embedding => RemoteModelCapabilityFact::Embedding,
        ModelCapability::Search => RemoteModelCapabilityFact::Search,
        ModelCapability::CodeSpecialized => RemoteModelCapabilityFact::CodeSpecialized,
        ModelCapability::FunctionCalling => RemoteModelCapabilityFact::FunctionCalling,
        ModelCapability::SpeechRecognition => RemoteModelCapabilityFact::SpeechRecognition,
    }
}

/// An attachment recorded before pixels travelled inline holds a host path and
/// nothing else, and only this host can resolve it. Above this size the image is
/// left as a name: reading it would cost more than the thumbnail is worth.
#[cfg(feature = "remote-connect")]
const MAX_REMOTE_CHAT_IMAGE_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

/// Read the pixels behind an attachment path so clients that cannot reach this
/// filesystem still see the picture. A path that no longer resolves is not an
/// error here — the attachment simply keeps travelling as a name.
#[cfg(feature = "remote-connect")]
fn read_remote_chat_image_pixels(image_path: &str) -> Option<Vec<u8>> {
    let path = std::path::Path::new(image_path);
    // Turn metadata records where the user took the file from, always as an
    // absolute host path. A relative one would resolve against whatever
    // directory this process happens to be in, which is never what was meant.
    if !path.is_absolute() {
        return None;
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_REMOTE_CHAT_IMAGE_SOURCE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// Convert persisted turns into mobile ChatMessages.
/// This is the same data source the desktop frontend uses.
#[cfg(feature = "remote-connect")]
fn remote_chat_messages_from_turns(
    turns: &[DialogTurnData],
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Vec<ChatMessage> {
    let projected_turns = turns
        .iter()
        .filter(|turn| turn.kind.is_model_visible())
        .map(|turn| remote_chat_history_turn_from_core_turn(turn, read_image_pixels))
        .collect::<Vec<_>>();
    build_remote_chat_messages(projected_turns)
}

#[cfg(feature = "remote-connect")]
fn remote_chat_history_turn_from_core_turn(
    turn: &DialogTurnData,
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> RemoteChatHistoryTurn {
    let prompt_visible_content =
        crate::agentic::core::strip_prompt_markup(&turn.user_message.content);
    let user_projection = project_remote_chat_user(
        turn.user_message.metadata.as_ref(),
        &prompt_visible_content,
        read_image_pixels,
    );

    let rounds = turn
        .model_rounds
        .iter()
        .map(|round| RemoteChatHistoryRound {
            start_time_ms: round.start_time,
            end_time_ms: round.end_time,
            text_items: round
                .text_items
                .iter()
                .map(|item| RemoteChatHistoryTextItem {
                    content: item.content.clone(),
                    order_index: item.order_index,
                    is_subagent: item.is_subagent_item.unwrap_or(false),
                })
                .collect(),
            thinking_items: round
                .thinking_items
                .iter()
                .map(|item| RemoteChatHistoryThinkingItem {
                    content: item.content.clone(),
                    order_index: item.order_index,
                    is_subagent: item.is_subagent_item.unwrap_or(false),
                })
                .collect(),
            tool_items: round
                .tool_items
                .iter()
                .map(|item| RemoteChatHistoryToolItem {
                    id: item.id.clone(),
                    name: item.effective_name().to_string(),
                    call: RemoteChatHistoryToolCall {
                        id: item.tool_call.id.clone(),
                        input: item.effective_input().clone(),
                    },
                    result: item
                        .tool_result
                        .as_ref()
                        .map(|result| result.result.clone()),
                    has_result: item.tool_result.is_some(),
                    status: item.status.clone(),
                    duration_ms: item.duration_ms,
                    start_ms: item.start_time,
                    order_index: item.order_index,
                    is_subagent: item.is_subagent_item.unwrap_or(false),
                })
                .collect(),
        })
        .collect();

    RemoteChatHistoryTurn {
        turn_id: turn.turn_id.clone(),
        user_message_id: turn.user_message.id.clone(),
        user_display_content: user_projection.content,
        user_timestamp_ms: turn.user_message.timestamp,
        user_images: user_projection.images,
        is_in_progress: turn.status == TurnStatus::InProgress,
        status: match &turn.status {
            TurnStatus::InProgress => "active",
            TurnStatus::Completed => "done",
            TurnStatus::Error => "failed",
            TurnStatus::Cancelled => "cancelled",
        }
        .to_string(),
        error: turn.error.clone(),
        start_time_ms: turn.start_time,
        rounds,
    }
}

#[cfg(feature = "remote-connect")]
async fn resolve_session_model_selection(session_id: &str) -> (Option<String>, Option<String>) {
    let Some(coordinator) = get_global_coordinator() else {
        return (None, None);
    };
    let session_manager = coordinator.get_session_manager();

    if let Some(session) = session_manager.get_session(session_id) {
        return (
            normalize_remote_session_model_id(session.config.model_id.as_deref()),
            session.config.reasoning_preset.clone(),
        );
    }

    let Some(session_storage_dir) =
        CoreServiceAgentRuntime::resolve_session_storage_dir(session_id).await
    else {
        return (None, None);
    };
    coordinator
        .restore_session_view_from_storage_path_timed(&session_storage_dir, session_id)
        .await
        .ok()
        .map(|(session, _, _)| {
            (
                normalize_remote_session_model_id(session.config.model_id.as_deref()),
                session.config.reasoning_preset,
            )
        })
        .unwrap_or_default()
}

#[cfg(feature = "remote-connect")]
fn core_dialog_submission_policy(policy: RemoteDialogSubmissionPolicy) -> DialogSubmissionPolicy {
    let trigger_source = match policy.source {
        RemoteConnectSubmissionSource::Relay => DialogTriggerSource::RemoteRelay,
        RemoteConnectSubmissionSource::Bot => DialogTriggerSource::Bot,
    };
    let queue_priority = match policy.queue_priority {
        RemoteDialogQueuePriority::Low => DialogQueuePriority::Low,
        RemoteDialogQueuePriority::Normal => DialogQueuePriority::Normal,
        RemoteDialogQueuePriority::High => DialogQueuePriority::High,
    };

    DialogSubmissionPolicy::new(trigger_source, queue_priority)
}

#[cfg(feature = "remote-connect")]
fn remote_dialog_scheduler_outcome_fact(
    outcome: DialogSubmitOutcome,
) -> RemoteDialogSchedulerOutcomeFact {
    match outcome {
        DialogSubmitOutcome::Started {
            session_id,
            turn_id,
        } => RemoteDialogSchedulerOutcomeFact::Started {
            session_id,
            turn_id,
        },
        DialogSubmitOutcome::Queued {
            session_id,
            turn_id,
        } => RemoteDialogSchedulerOutcomeFact::Queued {
            session_id,
            turn_id,
        },
    }
}

#[cfg(feature = "remote-connect")]
fn remote_image_context_from_image_context(context: ImageContextData) -> RemoteImageContext {
    RemoteImageContext {
        id: context.id,
        image_path: context.image_path,
        data_url: context.data_url,
        mime_type: context.mime_type,
        metadata: context.metadata,
    }
}

#[cfg(feature = "remote-connect")]
fn image_context_from_remote_image_context(context: RemoteImageContext) -> ImageContextData {
    ImageContextData {
        id: context.id,
        image_path: context.image_path,
        data_url: context.data_url,
        mime_type: context.mime_type,
        metadata: context.metadata,
    }
}

#[cfg(feature = "remote-connect")]
fn agent_input_attachment_from_image_context(context: ImageContextData) -> AgentInputAttachment {
    agent_input_attachment_from_remote_image_context(remote_image_context_from_image_context(
        context,
    ))
}

fn core_agent_runtime_builder(
    submission: Arc<dyn AgentSubmissionPort>,
    session_management: Arc<dyn AgentSessionManagementPort>,
    workspace_references: Arc<dyn AgentWorkspaceReferencePort>,
    session_mode: Arc<dyn AgentSessionModePort>,
    session_model: Arc<dyn AgentSessionModelPort>,
    session_compaction: Arc<dyn AgentSessionCompactionPort>,
    session_restore: Arc<dyn AgentSessionRestorePort>,
    local_command_turn: Arc<dyn AgentLocalCommandTurnPort>,
    user_shell_command: Arc<dyn AgentUserShellCommandPort>,
    transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader>,
    thread_goal_management: Arc<dyn AgentThreadGoalManagementPort>,
    cancellation: Arc<dyn AgentTurnCancellationPort>,
    interaction_response: Arc<dyn AgentInteractionResponsePort>,
    hook_registry: openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry,
) -> Result<AgentRuntimeBuilder, String> {
    let agent_registry: Arc<dyn openbitfun_agent_runtime::sdk::RuntimeAgentRegistry> =
        crate::agentic::agents::get_agent_registry();
    let mode_catalog: Arc<dyn AgentModeCatalogPort> = Arc::new(CoreAgentModeCatalogPort);
    Ok(AgentRuntimeBuilder::new()
        .with_submission_port(submission)
        .with_session_management_port(session_management)
        .with_workspace_reference_port(workspace_references)
        .with_session_mode_port(session_mode)
        .with_session_model_port(session_model)
        .with_session_compaction_port(session_compaction)
        .with_session_restore_port(session_restore)
        .with_local_command_turn_port(local_command_turn)
        .with_user_shell_command_port(user_shell_command)
        .with_session_transcript_reader(transcript_reader)
        .with_thread_goal_management_port(thread_goal_management)
        .with_cancellation_port(cancellation)
        .with_interaction_response_port(interaction_response)
        .with_permission_request_manager(crate::product_runtime::core_permission_request_manager()?)
        .with_hook_registry(hook_registry)
        .with_agent_registry(agent_registry)
        .with_mode_catalog(mode_catalog))
}

struct CoreAgentModeCatalogPort;

#[async_trait::async_trait]
impl AgentModeCatalogPort for CoreAgentModeCatalogPort {
    async fn list_modes(
        &self,
        query: AgentModeCatalogQuery,
    ) -> openbitfun_runtime_ports::PortResult<Vec<AgentModeCatalogEntry>> {
        let record =
            crate::service::workspace::legacy_compat::upgrade_optional_workspace_reference(
                query.workspace_id.as_deref(),
                query.workspace_root.as_deref(),
            )
            .await
            .map_err(|error| {
                openbitfun_runtime_ports::PortError::new(
                    openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                    error,
                )
            })?;
        #[cfg(feature = "external-sources")]
        let external_supported = query.include_external
            && record.as_ref().is_some_and(|record| {
                record.workspace_kind != crate::service::workspace::WorkspaceKind::Remote
            });
        #[cfg(not(feature = "external-sources"))]
        let external_supported = false;
        #[cfg(feature = "external-sources")]
        if external_supported {
            if let Err(error) = crate::external_sources::ensure_external_source_workspace_snapshot(
                record.as_ref().map(|record| record.id.as_str()),
            )
            .await
            {
                log::warn!("Failed to initialize external agent sources for mode catalog: {error}");
            }
        }
        let modes = crate::agentic::agents::get_agent_registry()
            .get_modes_info_for_workspace(
                record.as_ref().map(|record| record.id.as_str()),
                external_supported,
            )
            .await;
        Ok(modes
            .into_iter()
            .map(|mode| AgentModeCatalogEntry {
                id: mode.id,
                route_key: mode.key,
                description: mode.description,
                model_id: mode.model,
                is_external: mode.source == crate::agentic::agents::AgentSource::External,
            })
            .collect())
    }
}

#[derive(Clone)]
struct ScheduledSessionManagementPort {
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
}

impl ScheduledSessionManagementPort {
    fn new(coordinator: Arc<ConversationCoordinator>, scheduler: Arc<DialogScheduler>) -> Self {
        Self {
            coordinator,
            scheduler,
        }
    }

    async fn apply_session_revert(
        &self,
        request: AgentSessionRevertRequest,
        undo: bool,
    ) -> openbitfun_runtime_ports::PortResult<AgentSessionRevertResult> {
        openbitfun_core_types::validate_session_id(&request.session_id).map_err(|message| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                message,
            )
        })?;
        let workspace = resolve_history_workspace(
            request.workspace_id.as_deref(),
            &request.workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
        .await?;
        if workspace.is_remote() {
            return Err(openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::NotAvailable,
                "Session undo and redo are unavailable for remote workspaces",
            ));
        }
        self.coordinator
            .local_revert_workspace(&request.session_id)
            .await
            .map_err(|error| {
                if matches!(&error, crate::util::errors::OpenBitFunError::Validation(message) if message == "Session undo and redo are unavailable for remote workspaces")
                {
                    openbitfun_runtime_ports::PortError::new(
                        openbitfun_runtime_ports::PortErrorKind::NotAvailable,
                        error.to_string(),
                    )
                } else {
                    map_session_close_error(error)
                }
            })?;
        let storage_path = CoreSessionStorePort::default()
            .resolve_workspace_storage(
                workspace
                    .workspace_id
                    .as_deref()
                    .expect("resolved workspace ID"),
            )
            .await
            .map(|resolution| resolution.effective_storage_path)?;
        let session_manager = self.coordinator.get_session_manager();
        session_manager
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(map_session_close_error)?;
        let maintenance = self
            .scheduler
            .begin_session_maintenance(&request.session_id, &storage_path, Duration::from_secs(30))
            .await
            .map_err(map_session_close_error)?;
        let _mutation = session_manager
            .acquire_session_mutation(&request.session_id)
            .await
            .map_err(map_session_close_error)?;
        session_manager
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(map_session_close_error)?;
        let (composer, changed, hidden_turn_count) = self
            .coordinator
            .apply_session_revert_locked(&storage_path, &request.session_id, undo)
            .await
            .map_err(map_session_close_error)?;
        if changed {
            self.coordinator
                .emit_event(AgenticEvent::SessionHistoryChanged {
                    session_id: request.session_id.clone(),
                    settled_turn_id: None,
                })
                .await;
        }
        let transcript = self
            .coordinator
            .read_session_transcript_locked(openbitfun_runtime_ports::SessionTranscriptRequest {
                session_id: request.session_id.clone(),
                turn_id: None,
            })
            .await
        .map_err(|error| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::OutcomeUnknown,
                format!(
                    "Session revert completed but the authoritative transcript could not be read: {error}"
                ),
            )
        })?;
        Ok(AgentSessionRevertResult {
            session_id: request.session_id,
            transcript,
            composer,
            retired_turn_ids: maintenance.retired_turn_ids().to_vec(),
            changed,
            hidden_turn_count,
            boundary_storage_turn_index: None,
            target_turn_id: None,
            restored_files: Vec::new(),
            reload_required: false,
            reload_reason: None,
        })
    }
}

#[async_trait::async_trait]
impl AgentSessionRevertPort for ScheduledSessionManagementPort {
    async fn undo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> openbitfun_runtime_ports::PortResult<AgentSessionRevertResult> {
        self.apply_session_revert(request, true).await
    }

    async fn redo_session(
        &self,
        request: AgentSessionRevertRequest,
    ) -> openbitfun_runtime_ports::PortResult<AgentSessionRevertResult> {
        self.apply_session_revert(request, false).await
    }

    async fn rollback_session_to_turn(
        &self,
        request: AgentSessionRollbackToTurnRequest,
    ) -> openbitfun_runtime_ports::PortResult<AgentSessionRollbackToTurnOutcome> {
        openbitfun_core_types::validate_session_id(&request.session_id).map_err(|message| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                message,
            )
        })?;
        let workspace = resolve_history_workspace(
            request.workspace_id.as_deref(),
            &request.workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
        .await?;
        if workspace.is_remote() {
            return Err(openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::NotAvailable,
                "Session rollback is unavailable for remote workspaces",
            ));
        }
        let storage_path = CoreSessionStorePort::default()
            .resolve_workspace_storage(
                workspace
                    .workspace_id
                    .as_deref()
                    .expect("resolved workspace ID"),
            )
            .await
            .map(|resolution| resolution.effective_storage_path)?;
        let session_manager = self.coordinator.get_session_manager();
        if !session_manager
            .is_session_loaded_from_storage_path(&storage_path, &request.session_id)
            .map_err(map_session_close_error)?
        {
            self.coordinator
                .restore_session_from_storage_path(&storage_path, &request.session_id)
                .await
                .map_err(map_session_close_error)?;
        }
        self.coordinator
            .local_revert_workspace(&request.session_id)
            .await
            .map_err(map_session_close_error)?;
        session_manager
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(map_session_close_error)?;
        let maintenance = self
            .scheduler
            .begin_session_maintenance(&request.session_id, &storage_path, Duration::from_secs(30))
            .await
            .map_err(map_session_close_error)?;
        let _mutation = session_manager
            .acquire_session_mutation(&request.session_id)
            .await
            .map_err(map_session_close_error)?;
        session_manager
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(map_session_close_error)?;
        let marker_before = session_manager
            .persistence_manager()
            .load_session_revert_state(&storage_path, &request.session_id)
            .await
            .map_err(map_session_close_error)?;

        let applied = self
            .coordinator
            .apply_targeted_session_revert_locked(
                &storage_path,
                &request.session_id,
                &request.target_turn_id,
                request.expected_storage_turn_index,
                request.expected_catalog_revision.as_deref(),
            )
            .await;
        let (composer, hidden_turn_count, boundary, restored_files, persisted_retired_turn_ids) =
            match applied {
                Ok(result) => result,
                Err(error) => {
                    let marker = session_manager
                        .persistence_manager()
                        .load_session_revert_state(&storage_path, &request.session_id)
                        .await
                        .map_err(map_session_close_error)?;
                    if let Some(marker) = marker {
                        if marker.phase
                            == crate::agentic::session::revert::SessionRevertPhase::Staged
                            && marker_before.as_ref() == Some(&marker)
                        {
                            return Err(map_session_close_error(error));
                        }
                        let mutation_id = marker.diagnostic_mutation_id(&request.session_id);
                        let affected_files = marker
                            .workspace_checkpoint
                            .into_iter()
                            .map(|checkpoint| checkpoint.display_path())
                            .collect();
                        return Ok(AgentSessionRollbackToTurnOutcome::RecoveryRequired {
                            session_id: request.session_id,
                            mutation_id,
                            affected_files,
                            reason: error.to_string(),
                        });
                    }
                    return Err(map_session_close_error(error));
                }
            };
        self.coordinator
            .emit_event(AgenticEvent::SessionHistoryChanged {
                session_id: request.session_id.clone(),
                settled_turn_id: None,
            })
            .await;
        let mut retired_turn_ids = maintenance.retired_turn_ids().to_vec();
        for turn_id in persisted_retired_turn_ids {
            if !retired_turn_ids.contains(&turn_id) {
                retired_turn_ids.push(turn_id);
            }
        }
        let (transcript, reload_reason) = match self
            .coordinator
            .read_session_transcript_locked(openbitfun_runtime_ports::SessionTranscriptRequest {
                session_id: request.session_id.clone(),
                turn_id: None,
            })
            .await
        {
            Ok(transcript) => (transcript, None),
            Err(error) => (
                openbitfun_runtime_ports::SessionTranscript {
                    session_id: request.session_id.clone(),
                    messages: Vec::new(),
                },
                Some(format!(
                    "Session rollback completed but the authoritative transcript could not be read: {error}"
                )),
            ),
        };
        Ok(AgentSessionRollbackToTurnOutcome::Completed {
            result: AgentSessionRevertResult {
                session_id: request.session_id,
                transcript,
                composer,
                retired_turn_ids,
                changed: true,
                hidden_turn_count,
                boundary_storage_turn_index: Some(boundary),
                target_turn_id: Some(request.target_turn_id),
                restored_files,
                reload_required: reload_reason.is_some(),
                reload_reason,
            },
        })
    }
}

/// ACP accepts one prompt at a time per session. Keep that protocol-specific
/// admission rule in the product assembly instead of changing the shared
/// scheduler policy used by GUI, TUI, and remote-control surfaces.
struct RejectBusyAgentDialogTurnPort(Arc<DialogScheduler>);

#[async_trait::async_trait]
impl AgentDialogTurnPort for RejectBusyAgentDialogTurnPort {
    async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> openbitfun_runtime_ports::PortResult<DialogSubmitOutcome> {
        self.0
            .submit_agent_dialog_turn_reject_if_busy(request)
            .await
    }

    async fn steer_dialog_turn(
        &self,
        request: openbitfun_runtime_ports::AgentDialogSteerRequest,
    ) -> openbitfun_runtime_ports::PortResult<openbitfun_runtime_ports::DialogSteerOutcome> {
        AgentDialogTurnPort::steer_dialog_turn(self.0.as_ref(), request).await
    }
}

#[async_trait::async_trait]
impl AgentSessionManagementPort for ScheduledSessionManagementPort {
    async fn list_sessions(
        &self,
        request: openbitfun_runtime_ports::AgentSessionListRequest,
    ) -> openbitfun_runtime_ports::PortResult<Vec<openbitfun_runtime_ports::AgentSessionSummary>>
    {
        AgentSessionManagementPort::list_sessions(self.coordinator.as_ref(), request).await
    }

    async fn delete_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionDeleteRequest,
    ) -> openbitfun_runtime_ports::PortResult<()> {
        openbitfun_core_types::validate_session_id(&request.session_id).map_err(|message| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                message,
            )
        })?;
        let storage_path = CoreSessionStorePort::default()
            .resolve_storage_for_reference(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.clone(),
                request.remote_ssh_host.clone(),
            )
            .await
            .map(|resolution| resolution.effective_storage_path)
            .map_err(|error| {
                openbitfun_runtime_ports::PortError::new(
                    openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                    error.to_string(),
                )
            })?;
        self.coordinator
            .get_session_manager()
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(|error| {
                openbitfun_runtime_ports::PortError::new(
                    openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                    error.to_string(),
                )
            })?;
        let _maintenance = self
            .scheduler
            .begin_session_deletion(
                &request.session_id,
                &storage_path,
                Duration::from_millis(2_000),
            )
            .await
            .map_err(|error| {
                let kind = match error {
                    crate::util::errors::OpenBitFunError::Validation(_) => {
                        openbitfun_runtime_ports::PortErrorKind::InvalidRequest
                    }
                    crate::util::errors::OpenBitFunError::NotFound(_) => {
                        openbitfun_runtime_ports::PortErrorKind::NotFound
                    }
                    crate::util::errors::OpenBitFunError::Timeout(_) => {
                        openbitfun_runtime_ports::PortErrorKind::Timeout
                    }
                    crate::util::errors::OpenBitFunError::Cancelled(_) => {
                        openbitfun_runtime_ports::PortErrorKind::Cancelled
                    }
                    crate::util::errors::OpenBitFunError::SessionInUse { .. } => {
                        openbitfun_runtime_ports::PortErrorKind::SessionInUse
                    }
                    crate::util::errors::OpenBitFunError::OutcomeUnknown(_) => {
                        openbitfun_runtime_ports::PortErrorKind::OutcomeUnknown
                    }
                    _ => openbitfun_runtime_ports::PortErrorKind::Backend,
                };
                openbitfun_runtime_ports::PortError::new(kind, error.to_string())
            })?;
        AgentSessionManagementPort::delete_session(self.coordinator.as_ref(), request).await
    }

    async fn rename_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionRenameRequest,
    ) -> openbitfun_runtime_ports::PortResult<()> {
        AgentSessionManagementPort::rename_session(self.coordinator.as_ref(), request).await
    }

    async fn archive_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionArchiveRequest,
    ) -> openbitfun_runtime_ports::PortResult<()> {
        AgentSessionManagementPort::archive_session(self.coordinator.as_ref(), request).await
    }

    async fn set_session_archived(
        &self,
        request: openbitfun_runtime_ports::AgentSessionArchiveStateRequest,
    ) -> openbitfun_runtime_ports::PortResult<()> {
        AgentSessionManagementPort::set_session_archived(self.coordinator.as_ref(), request).await
    }

    async fn resolve_session_workspace_binding(
        &self,
        request: openbitfun_runtime_ports::AgentSessionWorkspaceRequest,
    ) -> openbitfun_runtime_ports::PortResult<
        Option<openbitfun_runtime_ports::AgentSessionWorkspaceBinding>,
    > {
        AgentSessionManagementPort::resolve_session_workspace_binding(
            self.coordinator.as_ref(),
            request,
        )
        .await
    }
}

#[derive(Clone, Copy)]
enum SessionReleaseKind {
    DiscardTransient,
    UnloadPersisted,
}

impl ScheduledSessionManagementPort {
    async fn release_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionReleaseRequest,
        kind: SessionReleaseKind,
    ) -> openbitfun_runtime_ports::PortResult<bool> {
        openbitfun_core_types::validate_session_id(&request.session_id).map_err(|message| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::InvalidRequest,
                message,
            )
        })?;
        let storage_path = CoreSessionStorePort::default()
            .resolve_storage_for_reference(
                request.workspace_id.as_deref(),
                &request.workspace_path,
                request.remote_connection_id.clone(),
                request.remote_ssh_host.clone(),
            )
            .await?
            .effective_storage_path;
        let session_manager = self.coordinator.get_session_manager();
        session_manager
            .validate_session_storage_path_binding(&request.session_id, &storage_path)
            .map_err(map_session_close_error)?;
        let close_deadline =
            tokio::time::Instant::now() + Duration::from_millis(request.wait_timeout_ms.max(1));
        let _maintenance = self
            .scheduler
            .begin_session_maintenance(
                &request.session_id,
                &storage_path,
                close_deadline.saturating_duration_since(tokio::time::Instant::now()),
            )
            .await
            .map_err(map_session_close_error)?;
        let cleanup_budget = close_deadline.saturating_duration_since(tokio::time::Instant::now());
        if cleanup_budget.is_zero() {
            return Err(openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::Timeout,
                "Session close deadline was exhausted before resource release",
            ));
        }
        tokio::time::timeout(cleanup_budget, async {
            match kind {
                SessionReleaseKind::DiscardTransient => {
                    self.coordinator
                        .discard_transient_session(
                            std::path::Path::new(&request.workspace_path),
                            request.remote_connection_id.as_deref(),
                            request.remote_ssh_host.as_deref(),
                            &request.session_id,
                        )
                        .await
                }
                SessionReleaseKind::UnloadPersisted => {
                    session_manager
                        .unload_session_from_memory(&request.session_id)
                        .await
                }
            }
        })
        .await
        .map_err(|_| {
            openbitfun_runtime_ports::PortError::new(
                openbitfun_runtime_ports::PortErrorKind::Timeout,
                "Session resource release exceeded the Session close deadline",
            )
        })?
        .map_err(map_session_close_error)
    }
}

#[async_trait::async_trait]
impl AgentSessionClosePort for ScheduledSessionManagementPort {
    async fn discard_transient_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionReleaseRequest,
    ) -> openbitfun_runtime_ports::PortResult<bool> {
        self.release_session(request, SessionReleaseKind::DiscardTransient)
            .await
    }

    async fn unload_persisted_session(
        &self,
        request: openbitfun_runtime_ports::AgentSessionReleaseRequest,
    ) -> openbitfun_runtime_ports::PortResult<bool> {
        self.release_session(request, SessionReleaseKind::UnloadPersisted)
            .await
    }
}

fn map_session_close_error(
    error: crate::util::errors::OpenBitFunError,
) -> openbitfun_runtime_ports::PortError {
    let kind = match &error {
        crate::util::errors::OpenBitFunError::Validation(_) => {
            openbitfun_runtime_ports::PortErrorKind::InvalidRequest
        }
        crate::util::errors::OpenBitFunError::NotFound(_) => {
            openbitfun_runtime_ports::PortErrorKind::NotFound
        }
        crate::util::errors::OpenBitFunError::Timeout(_) => {
            openbitfun_runtime_ports::PortErrorKind::Timeout
        }
        crate::util::errors::OpenBitFunError::Cancelled(_) => {
            openbitfun_runtime_ports::PortErrorKind::Cancelled
        }
        crate::util::errors::OpenBitFunError::SessionInUse { .. } => {
            openbitfun_runtime_ports::PortErrorKind::SessionInUse
        }
        crate::util::errors::OpenBitFunError::OutcomeUnknown(_) => {
            openbitfun_runtime_ports::PortErrorKind::OutcomeUnknown
        }
        _ => openbitfun_runtime_ports::PortErrorKind::Backend,
    };
    openbitfun_runtime_ports::PortError::new(kind, error.to_string())
}

fn scheduled_session_management_port(
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
) -> Arc<dyn AgentSessionManagementPort> {
    Arc::new(ScheduledSessionManagementPort::new(coordinator, scheduler))
}

fn scheduled_session_close_port(
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
) -> Arc<dyn AgentSessionClosePort> {
    Arc::new(ScheduledSessionManagementPort::new(coordinator, scheduler))
}

fn scheduled_session_revert_port(
    coordinator: Arc<ConversationCoordinator>,
    scheduler: Arc<DialogScheduler>,
) -> Arc<dyn AgentSessionRevertPort> {
    Arc::new(ScheduledSessionManagementPort::new(coordinator, scheduler))
}

pub(crate) struct CoreServiceAgentRuntime;

impl CoreServiceAgentRuntime {
    async fn resolve_session_workspace_binding(session_id: &str) -> Option<WorkspaceBinding> {
        let coordinator = get_global_coordinator()?;
        coordinator
            .get_session_manager()
            .resolve_session_workspace_binding(session_id)
            .await
    }

    pub(crate) async fn resolve_session_workspace_paths(
        session_id: &str,
    ) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
        Self::resolve_session_workspace_binding(session_id)
            .await
            .map(|binding| {
                (
                    binding.logical_workspace_path().to_path_buf(),
                    binding.session_storage_dir(),
                )
            })
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn resolve_session_storage_dir(
        session_id: &str,
    ) -> Option<std::path::PathBuf> {
        Self::resolve_session_workspace_paths(session_id)
            .await
            .map(|(_, storage_dir)| storage_dir)
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn resolve_remote_file_workspace_root(
        session_id: Option<&str>,
    ) -> Option<std::path::PathBuf> {
        if let Some(session_id) = session_id {
            // An explicit session never borrows the currently selected workspace.
            return Self::resolve_session_workspace_binding(session_id)
                .await
                .filter(|binding| !binding.is_remote())
                .map(|binding| binding.root_path);
        }
        let current = current_remote_workspace_facts().await?;
        if current.kind == RemoteConnectWorkspaceKind::Remote {
            return None;
        }
        Some(current.path.into())
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn remote_file_target(
        path: &str,
        session_id: Option<&str>,
    ) -> Result<
        openbitfun_services_integrations::remote_connect::file_projection::SessionFileTarget,
        String,
    > {
        Self::remote_file_target_with_identity(path, session_id)
            .await
            .map(|(target, _)| target)
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn remote_file_target_with_identity(
        path: &str,
        session_id: Option<&str>,
    ) -> Result<
        (
            openbitfun_services_integrations::remote_connect::file_projection::SessionFileTarget,
            String,
        ),
        String,
    > {
        let binding = if let Some(session_id) = session_id {
            Self::resolve_session_workspace_binding(session_id).await
                .ok_or_else(|| "The output session workspace is unavailable; no current-workspace fallback was attempted".to_string())?
        } else {
            let current = current_remote_workspace_facts()
                .await
                .ok_or_else(|| "No workspace selected for file access".to_string())?;
            if current.kind == RemoteConnectWorkspaceKind::Remote
                && current.remote_connection_id.is_none()
            {
                return Err("Remote workspace connection identity is unavailable".to_string());
            }
            let config = crate::agentic::core::SessionConfig {
                workspace_path: Some(current.path),
                remote_connection_id: current.remote_connection_id,
                remote_ssh_host: current.remote_ssh_host,
                ..Default::default()
            };
            ConversationCoordinator::build_workspace_binding(&config)
                .await
                .ok_or_else(|| {
                    "Cannot resolve the selected workspace for file access".to_string()
                })?
        };
        let connection_id = binding.connection_id().map(str::to_string);
        let target = Self::file_target_for_binding(path, session_id, binding).await?;
        let target_id = if target.remote {
            connection_id.ok_or("Remote file target has no connection identity")?
        } else {
            "local".to_string()
        };
        Ok((target, target_id))
    }

    #[cfg(feature = "remote-connect")]
    async fn scoped_remote_file_target(
        path: &str,
        session_id: Option<&str>,
        workspace_id: Option<&str>,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> Result<
        openbitfun_services_integrations::remote_connect::file_projection::SessionFileTarget,
        String,
    > {
        Self::scoped_remote_file_target_with_identity(
            path,
            session_id,
            workspace_id,
            workspace_path,
            remote_connection_id,
        )
        .await
        .map(|(target, _)| target)
    }

    /// Resolve an explicit file workspace. The workspace ID is authoritative:
    /// the record's kind and saved connection route the IO. `workspace_path`
    /// + `remote_connection_id` is the legacy projection for pre-ID
    /// controllers and is only consulted when no ID is supplied.
    #[cfg(feature = "remote-connect")]
    pub(crate) async fn scoped_remote_file_target_with_identity(
        path: &str,
        session_id: Option<&str>,
        workspace_id: Option<&str>,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> Result<
        (
            openbitfun_services_integrations::remote_connect::file_projection::SessionFileTarget,
            String,
        ),
        String,
    > {
        // An empty connection ID is the explicit local-provider marker shared
        // with directory/CRUD calls; absence is also local for scoped files.
        let remote_connection_id = remote_connection_id.filter(|id| !id.is_empty());
        let workspace_id = workspace_id.map(str::trim).filter(|id| !id.is_empty());
        if session_id.is_some() {
            if workspace_id.is_some() || workspace_path.is_some() || remote_connection_id.is_some()
            {
                return Err("Use either a session or an explicit file workspace".into());
            }
            return Self::remote_file_target_with_identity(path, session_id).await;
        }
        if let Some(workspace_id) = workspace_id {
            let config = crate::agentic::core::SessionConfig {
                workspace_id: Some(workspace_id.to_string()),
                ..Default::default()
            };
            let binding = ConversationCoordinator::build_workspace_binding(&config)
                .await
                .ok_or_else(|| format!("File workspace {} cannot be resolved", workspace_id))?;
            if let Some(expected) = remote_connection_id {
                if binding.connection_id() != Some(expected) {
                    return Err(
                        "Explicit file workspace provider does not match its connection identity"
                            .into(),
                    );
                }
            }
            #[cfg(feature = "ssh-remote")]
            if let Some(connection_id) = binding.connection_id() {
                let state =
                    crate::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                        .await?;
                let ssh = state
                    .get_ssh_manager()
                    .await
                    .ok_or("SSH connection manager is unavailable")?;
                ssh.ensure_connected(connection_id)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let target_id = binding
                .connection_id()
                .map(str::to_string)
                .unwrap_or_else(|| "local".to_string());
            let target = Self::file_target_for_binding(path, None, binding).await?;
            if target.remote && target_id == "local" {
                return Err("Remote file target has no connection identity".into());
            }
            return Ok((target, target_id));
        }
        let workspace_path = workspace_path
            .filter(|value| !value.trim().is_empty())
            .ok_or("File workspace identity is required when no session is supplied")?;
        if let Some(connection_id) = remote_connection_id {
            #[cfg(feature = "ssh-remote")]
            {
                let state =
                    crate::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                        .await?;
                let ssh = state
                    .get_ssh_manager()
                    .await
                    .ok_or("SSH connection manager is unavailable")?;
                if !ssh
                    .get_saved_connections()
                    .await
                    .iter()
                    .any(|profile| profile.id == connection_id)
                {
                    return Err("File workspace connection is not saved on this runtime".into());
                }
                ssh.ensure_connected(connection_id)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            #[cfg(not(feature = "ssh-remote"))]
            {
                let _ = connection_id;
                return Err("SSH file workspaces are unavailable on this runtime".into());
            }
        }
        let config = crate::agentic::core::SessionConfig {
            workspace_path: Some(workspace_path.into()),
            remote_connection_id: remote_connection_id.map(str::to_string),
            ..Default::default()
        };
        let binding = ConversationCoordinator::build_workspace_binding(&config)
            .await
            .ok_or("Explicit file workspace cannot be resolved")?;
        if binding.connection_id() != remote_connection_id {
            return Err(
                "Explicit file workspace provider does not match its connection identity".into(),
            );
        }
        let target = Self::file_target_for_binding(path, None, binding).await?;
        let target_id = if target.remote {
            remote_connection_id.ok_or("Remote file target has no connection identity")?
        } else {
            "local"
        };
        Ok((target, target_id.to_string()))
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn file_target_for_binding(
        path: &str,
        session_id: Option<&str>,
        binding: WorkspaceBinding,
    ) -> Result<
        openbitfun_services_integrations::remote_connect::file_projection::SessionFileTarget,
        String,
    > {
        use crate::agentic::tools::framework::ToolUseContext;
        use openbitfun_services_integrations::remote_connect::file_projection::{
            normalize_file_reference, SessionFileTarget,
        };
        let path = normalize_file_reference(path)?;
        let mut context = ToolUseContext::for_tool_listing(Some(binding.clone()), None);
        context.session_id = session_id.map(str::to_string);
        let resolved = context
            .resolve_tool_path(&path)
            .map_err(|e| e.to_string())?;
        let remote = resolved.uses_remote_workspace_backend();
        // Runtime artifacts belong to the executing host, even when its SSH
        // workspace is offline. Resolve these without requiring the SSH provider.
        if remote {
            let services =
                ConversationCoordinator::build_workspace_services(&Some(binding.clone()))
                    .await
                    .map_err(|e| e.to_string())?;
            context = ToolUseContext::for_tool_listing(Some(binding.clone()), services);
        }
        let fs = context
            .file_system_for_path(&resolved)
            .map_err(|e| e.to_string())?;
        let root = resolved
            .runtime_root
            .as_ref()
            .map(|root| root.to_string_lossy().into_owned())
            .unwrap_or_else(|| binding.root_path_string());
        Ok(SessionFileTarget {
            fs,
            path: resolved.resolved_path,
            root,
            remote,
        })
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_dialog_host(
        dispatcher: &RemoteExecutionDispatcher,
    ) -> Result<CoreRemoteDialogRuntimeHost<'_>, String> {
        CoreRemoteDialogRuntimeHost::new(dispatcher)
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_cancel_host() -> Result<CoreRemoteCancelRuntimeHost, String> {
        CoreRemoteCancelRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_workspace_file_host() -> CoreRemoteWorkspaceFileRuntimeHost {
        CoreRemoteWorkspaceFileRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_workspace_host() -> CoreRemoteWorkspaceRuntimeHost {
        CoreRemoteWorkspaceRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_initial_sync_host() -> CoreRemoteWorkspaceRuntimeHost {
        CoreRemoteWorkspaceRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_session_host() -> Result<CoreRemoteSessionRuntimeHost, String> {
        CoreRemoteSessionRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_poll_host(
        dispatcher: &RemoteExecutionDispatcher,
    ) -> CoreRemotePollRuntimeHost<'_> {
        CoreRemotePollRuntimeHost::new(dispatcher)
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_interaction_host() -> CoreRemoteInteractionRuntimeHost {
        CoreRemoteInteractionRuntimeHost::new()
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_image_context(context: RemoteImageContext) -> ImageContextData {
        image_context_from_remote_image_context(context)
    }

    /// One source read/commit owner for both migration and live block updates.
    #[cfg(feature = "remote-connect")]
    pub(crate) async fn synchronize_relay_session(
        publisher: &openbitfun_services_integrations::remote_connect::session_log::SessionPublisher,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        publisher.synchronize_records(session_id.to_owned(),turn_id.is_none(),||async {
            let directory=Self::resolve_session_storage_dir(session_id).await
                .ok_or_else(||anyhow::anyhow!("Session storage is unavailable on this host"))?;
            let coordinator=get_global_coordinator().ok_or_else(||anyhow::anyhow!("Runtime is unavailable"))?;
            let turns=coordinator.load_relay_session_turns(&directory,session_id,turn_id).await?;
            // Attachment paths are read and images re-encoded here, so the work
            // leaves the reactor rather than stalling the session's other events.
            tokio::task::spawn_blocking(move||{
                openbitfun_services_integrations::remote_connect::session_records::records_from_turns(&turns,&read_remote_chat_image_pixels)
            }).await?
        }).await.map_err(|error|error.to_string())
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn load_remote_chat_messages(
        session_storage_dir: &std::path::Path,
        session_id: &str,
    ) -> Result<(Vec<ChatMessage>, bool), String> {
        let coordinator = get_global_coordinator().ok_or_else(|| {
            "Core coordinator is unavailable for remote history reads".to_string()
        })?;
        let turns = coordinator
            .load_visible_persisted_session_turns(session_storage_dir, session_id)
            .await
            .map_err(|error| error.to_string())?;
        // Projecting a history decodes and re-encodes every attachment, and now
        // reads the ones stored as a path, so it does not belong on the thread
        // driving the remote-connect server.
        let messages = tokio::task::spawn_blocking(move || {
            remote_chat_messages_from_turns(&turns, &read_remote_chat_image_pixels)
        })
        .await
        .map_err(|error| format!("Remote history projection failed: {error}"))?;
        Ok((messages, false))
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn load_remote_model_catalog(
        session_id: Option<&str>,
    ) -> Result<RemoteModelCatalog, String> {
        let config_service = crate::service::config::get_global_config_service()
            .await
            .map_err(|e| format!("Config service not available: {e}"))?;
        let global_config: GlobalConfig = config_service
            .get_config(None)
            .await
            .map_err(|e| format!("Failed to load global config: {e}"))?;
        let ai_config: AIConfig = global_config.ai;
        let models_dev = load_models_dev_reasoning_catalog().await;
        let models_dev_reasoning_catalog = models_dev.catalog.as_deref().map(|catalog| {
            catalog.reasoning_binding_catalog(
                models_dev.sha256.clone(),
                match models_dev.source {
                    openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache => {
                        openbitfun_core_types::ModelsDevCatalogSource::Cache
                    }
                    openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Bundled => {
                        openbitfun_core_types::ModelsDevCatalogSource::Bundle
                    }
                    openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Empty => {
                        openbitfun_core_types::ModelsDevCatalogSource::Empty
                    }
                },
            )
        });
        let provider_catalog = resolve_builtin_provider_catalog(
            models_dev.catalog.as_deref(),
            models_dev.sha256.clone(),
            match models_dev.source {
                openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache => {
                    openbitfun_core_types::ProviderCatalogSource::Cache
                }
                openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Bundled => {
                    openbitfun_core_types::ProviderCatalogSource::Bundle
                }
                openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Empty => {
                    openbitfun_core_types::ProviderCatalogSource::OpenBitFun
                }
            },
        );

        let models: Vec<RemoteModelFacts> = ai_config
            .models
            .into_iter()
            .map(|model| {
                let reasoning =
                    project_model_reasoning_catalog(&model, models_dev.catalog.as_deref());
                RemoteModelFacts {
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    base_url: model.base_url,
                    model_name: model.model_name,
                    context_window: model.context_window,
                    enabled: model.enabled,
                    capabilities: model
                        .capabilities
                        .into_iter()
                        .map(remote_model_capability_fact)
                        .collect(),
                    reasoning: Some(reasoning),
                }
            })
            .collect();

        let (session_model_id, session_reasoning_preset) = if let Some(session_id) = session_id {
            resolve_session_model_selection(session_id).await
        } else {
            (None, None)
        };
        Ok(build_remote_model_catalog(RemoteModelCatalogFacts {
            last_modified_ms: global_config.last_modified.timestamp_millis(),
            source_version: Some(models_dev.version),
            models,
            provider_catalog,
            models_dev_reasoning_catalog,
            default_models: RemoteDefaultModelsConfig {
                primary: ai_config.default_models.primary,
                fast: ai_config.default_models.fast,
                search: ai_config.default_models.search,
                image_understanding: ai_config.default_models.image_understanding,
                image_generation: ai_config.default_models.image_generation,
                speech_recognition: ai_config.default_models.speech_recognition,
            },
            session_model_id,
            session_reasoning_preset,
        }))
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) async fn update_remote_session_model(
        coordinator: &ConversationCoordinator,
        runtime: &AgentRuntime,
        session_id: &str,
        model_id: &str,
        reasoning_preset: Option<Option<&str>>,
    ) -> Result<RemoteSessionModelSelection, String> {
        let ai_config = if remote_model_selection_needs_config(model_id)
            || reasoning_preset.is_some_and(|preset| preset.is_some())
        {
            let config_service = crate::service::config::get_global_config_service()
                .await
                .map_err(|_| "Config service not available".to_string())?;
            Some(
                config_service
                    .get_config::<AIConfig>(Some("ai"))
                    .await
                    .map_err(|e| format!("Failed to load AI config: {e}"))?,
            )
        } else {
            None
        };
        let normalized_model_id = normalize_remote_model_selection(model_id, ai_config.as_ref())?;
        let normalized_reasoning_preset = reasoning_preset.map(|preset| {
            preset
                .map(str::trim)
                .filter(|preset| !preset.is_empty() && !preset.eq_ignore_ascii_case("auto"))
                .map(ToOwned::to_owned)
        });

        if let Some(Some(preset_id)) = normalized_reasoning_preset.as_ref() {
            let ai_config = ai_config
                .as_ref()
                .ok_or_else(|| "Config service not available".to_string())?;
            let concrete_model_id = match normalized_model_id.as_str() {
                "primary" => ai_config.resolve_model_selection("primary"),
                "fast" => ai_config.resolve_model_selection("fast"),
                model_id => ai_config.resolve_model_reference(model_id),
            }
            .ok_or_else(|| {
                format!(
                    "Cannot resolve a concrete model for reasoning preset: {}",
                    normalized_model_id
                )
            })?;
            let model = ai_config
                .models
                .iter()
                .find(|model| model.enabled && model.id == concrete_model_id)
                .ok_or_else(|| format!("Model is unavailable: {concrete_model_id}"))?;
            let models_dev = load_models_dev_reasoning_catalog().await;
            let reasoning = project_model_reasoning_catalog(model, models_dev.catalog.as_deref());
            if resolve_reasoning_preset(&reasoning, preset_id).is_none() {
                return Err(format!(
                    "Reasoning preset '{preset_id}' is not available for model '{concrete_model_id}'"
                ));
            }
        }

        let binding = Self::resolve_session_workspace_binding(session_id)
            .await
            .ok_or_else(|| {
                format!("Session workspace binding not available for session: {session_id}")
            })?;
        ensure_remote_binding_runtime_ownership(coordinator, &binding).await?;
        if coordinator
            .get_session_manager()
            .get_session(session_id)
            .is_none()
        {
            coordinator
                .restore_session_for_workspace_binding(&binding, session_id)
                .await
                .map_err(|e| format!("Failed to restore session: {e}"))?;
        }

        let previous_model_id = coordinator
            .get_session_manager()
            .get_session(session_id)
            .and_then(|session| {
                normalize_remote_session_model_id(session.config.model_id.as_deref())
            });

        if reasoning_preset.is_none() {
            runtime
                .update_session_model(AgentSessionModelUpdateRequest {
                    session_id: session_id.to_string(),
                    model_id: normalized_model_id.clone(),
                })
                .await
                .map_err(Self::runtime_error_message)?;
        } else {
            runtime
                .update_session_model_selection(AgentSessionModelSelectionUpdateRequest {
                    session_id: session_id.to_string(),
                    selection: AgentSessionModelSelection {
                        model_id: normalized_model_id.clone(),
                        reasoning_preset: normalized_reasoning_preset.clone().flatten(),
                    },
                })
                .await
                .map_err(Self::runtime_error_message)?;
        }

        let model_changed =
            previous_model_id.as_deref().unwrap_or("primary") != normalized_model_id;
        if model_changed
            && coordinator
                .get_session_manager()
                .get_session(session_id)
                .is_some_and(|session| session_uses_shared_mode_default(&session))
        {
            // New sessions of every mode share one selector. Delegated
            // subagents intentionally keep their own defaults.
            Self::persist_mode_model(&normalized_model_id).await;
        }

        Ok(coordinator
            .get_session_manager()
            .get_session(session_id)
            .map(|session| RemoteSessionModelSelection {
                model_id: normalize_remote_session_model_id(session.config.model_id.as_deref())
                    .unwrap_or_else(|| normalized_model_id.clone()),
                reasoning_preset: session.config.reasoning_preset.clone(),
            })
            .unwrap_or(RemoteSessionModelSelection {
                model_id: normalized_model_id,
                reasoning_preset: normalized_reasoning_preset.flatten(),
            }))
    }

    /// Persist the shared selector used by future mode sessions.
    #[cfg(feature = "remote-connect")]
    async fn persist_mode_model(model_id: &str) {
        let Ok(config_service) = crate::service::config::get_global_config_service().await else {
            return;
        };
        let _ = config_service
            .set_config("ai.agent_model_defaults.mode", model_id)
            .await;
    }

    #[cfg(feature = "remote-connect")]
    pub(crate) fn remote_control_state_port(
        coordinator: &ConversationCoordinator,
    ) -> &(dyn RemoteControlStatePort + '_) {
        coordinator
    }

    pub(crate) fn agent_runtime(
        coordinator: Arc<ConversationCoordinator>,
    ) -> Result<AgentRuntime, String> {
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management: Arc<dyn AgentSessionManagementPort> = coordinator.clone();
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let user_shell_command: Arc<dyn AgentUserShellCommandPort> = coordinator.clone();
        let transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader> =
            coordinator.clone();
        let thread_goal_management: Arc<dyn AgentThreadGoalManagementPort> = coordinator.clone();
        let cancellation: Arc<dyn AgentTurnCancellationPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let hook_registry = coordinator.hook_registry().clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator;
        core_agent_runtime_builder(
            submission,
            session_management,
            workspace_references,
            session_mode,
            session_model,
            session_compaction,
            session_restore,
            local_command_turn,
            user_shell_command,
            transcript_reader,
            thread_goal_management,
            cancellation,
            interaction_response,
            hook_registry,
        )?
        .build()
        .map_err(|error| error.to_string())
    }

    pub(crate) fn agent_runtime_with_dialog_turns(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> Result<AgentRuntime, String> {
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management =
            scheduled_session_management_port(coordinator.clone(), scheduler.clone());
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_close = scheduled_session_close_port(coordinator.clone(), scheduler.clone());
        let session_revert = scheduled_session_revert_port(coordinator.clone(), scheduler.clone());
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let user_shell_command: Arc<dyn AgentUserShellCommandPort> = coordinator.clone();
        let transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader> =
            coordinator.clone();
        let thread_goal_management: Arc<dyn AgentThreadGoalManagementPort> = coordinator.clone();
        let cancellation: Arc<dyn AgentTurnCancellationPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let hook_registry = coordinator.hook_registry().clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator.clone();
        let dialog_turn =
            configured_plugin_dialog_turn_port(coordinator.clone(), scheduler.clone());
        let lifecycle_delivery: Arc<dyn AgentLifecycleDeliveryPort> = scheduler;
        core_agent_runtime_builder(
            submission,
            session_management,
            workspace_references,
            session_mode,
            session_model,
            session_compaction,
            session_restore,
            local_command_turn,
            user_shell_command,
            transcript_reader,
            thread_goal_management,
            cancellation,
            interaction_response,
            hook_registry,
        )?
        .with_session_close_port(session_close)
        .with_session_revert_port(session_revert)
        .with_dialog_turn_port(dialog_turn)
        .with_lifecycle_delivery_port(lifecycle_delivery)
        .build()
        .map_err(|error| error.to_string())
    }

    pub(crate) fn agent_runtime_with_lifecycle_delivery(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> Result<AgentRuntime, String> {
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management =
            scheduled_session_management_port(coordinator.clone(), scheduler.clone());
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_revert = scheduled_session_revert_port(coordinator.clone(), scheduler.clone());
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let user_shell_command: Arc<dyn AgentUserShellCommandPort> = coordinator.clone();
        let transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader> =
            coordinator.clone();
        let thread_goal_management: Arc<dyn AgentThreadGoalManagementPort> = coordinator.clone();
        let cancellation: Arc<dyn AgentTurnCancellationPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let hook_registry = coordinator.hook_registry().clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator;
        let lifecycle_delivery: Arc<dyn AgentLifecycleDeliveryPort> = scheduler;
        core_agent_runtime_builder(
            submission,
            session_management,
            workspace_references,
            session_mode,
            session_model,
            session_compaction,
            session_restore,
            local_command_turn,
            user_shell_command,
            transcript_reader,
            thread_goal_management,
            cancellation,
            interaction_response,
            hook_registry,
        )?
        .with_session_revert_port(session_revert)
        .with_lifecycle_delivery_port(lifecycle_delivery)
        .build()
        .map_err(|error| error.to_string())
    }

    /// Builds the narrow interaction and session-operation surface used by a
    /// product entrypoint without claiming a complete delivery profile.
    pub(crate) fn session_surface_agent_runtime(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        session_fork: Arc<dyn AgentSessionForkPort>,
        session_usage: Arc<dyn AgentSessionUsagePort>,
        session_lineage: Arc<dyn AgentSessionLineagePort>,
    ) -> Result<AgentRuntime, String> {
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management =
            scheduled_session_management_port(coordinator.clone(), scheduler.clone());
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_revert = scheduled_session_revert_port(coordinator.clone(), scheduler.clone());
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator.clone();
        let dialog_turn =
            configured_plugin_dialog_turn_port(coordinator.clone(), scheduler.clone());
        let cancellation: Arc<dyn AgentTurnCancellationPort> = scheduler;

        AgentRuntimeBuilder::new()
            .with_submission_port(submission)
            .with_session_management_port(session_management)
            .with_workspace_reference_port(workspace_references)
            .with_session_revert_port(session_revert)
            .with_session_mode_port(session_mode)
            .with_session_model_port(session_model)
            .with_session_compaction_port(session_compaction)
            .with_session_restore_port(session_restore)
            .with_local_command_turn_port(local_command_turn)
            .with_dialog_turn_port(dialog_turn)
            .with_cancellation_port(cancellation)
            .with_interaction_response_port(interaction_response)
            .with_session_fork_port(session_fork)
            .with_session_usage_port(session_usage)
            .with_session_lineage_port(session_lineage)
            .with_permission_request_manager(
                crate::product_runtime::core_permission_request_manager()?,
            )
            .build()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn agent_runtime_with_scheduler_ports(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> Result<AgentRuntime, String> {
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management =
            scheduled_session_management_port(coordinator.clone(), scheduler.clone());
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_revert = scheduled_session_revert_port(coordinator.clone(), scheduler.clone());
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let user_shell_command: Arc<dyn AgentUserShellCommandPort> = coordinator.clone();
        let transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader> =
            coordinator.clone();
        let thread_goal_management: Arc<dyn AgentThreadGoalManagementPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let hook_registry = coordinator.hook_registry().clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator.clone();
        let cancellation: Arc<dyn AgentTurnCancellationPort> = scheduler.clone();
        let dialog_turn =
            configured_plugin_dialog_turn_port(coordinator.clone(), scheduler.clone());
        let lifecycle_delivery: Arc<dyn AgentLifecycleDeliveryPort> = scheduler;
        core_agent_runtime_builder(
            submission,
            session_management,
            workspace_references,
            session_mode,
            session_model,
            session_compaction,
            session_restore,
            local_command_turn,
            user_shell_command,
            transcript_reader,
            thread_goal_management,
            cancellation,
            interaction_response,
            hook_registry,
        )?
        .with_session_revert_port(session_revert)
        .with_dialog_turn_port(dialog_turn)
        .with_lifecycle_delivery_port(lifecycle_delivery)
        .build()
        .map_err(|error| error.to_string())
    }

    pub(crate) fn product_agent_runtime(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        event_source: Option<AgentEventSource>,
        session_fork: Arc<dyn AgentSessionForkPort>,
        session_usage: Arc<dyn AgentSessionUsagePort>,
        turn_settlement: Arc<dyn AgentTurnSettlementPort>,
        session_lineage: Arc<dyn AgentSessionLineagePort>,
        services: openbitfun_runtime_services::RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let dialog_turn: Arc<dyn AgentDialogTurnPort> = scheduler.clone();
        Self::product_agent_runtime_with_dialog_turn(
            coordinator,
            scheduler,
            dialog_turn,
            event_source,
            Some(session_fork),
            Some(session_usage),
            Some(turn_settlement),
            Some(session_lineage),
            services,
        )
    }

    pub(crate) fn acp_product_agent_runtime(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        event_source: AgentEventSource,
        services: openbitfun_runtime_services::RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let dialog_turn: Arc<dyn AgentDialogTurnPort> =
            Arc::new(RejectBusyAgentDialogTurnPort(scheduler.clone()));
        Self::product_agent_runtime_with_dialog_turn(
            coordinator,
            scheduler,
            dialog_turn,
            Some(event_source),
            None,
            None,
            None,
            None,
            services,
        )
    }

    pub(crate) fn sdk_host_product_agent_runtime(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        event_source: AgentEventSource,
        session_fork: Arc<dyn AgentSessionForkPort>,
        session_usage: Arc<dyn AgentSessionUsagePort>,
        turn_settlement: Arc<dyn AgentTurnSettlementPort>,
        services: openbitfun_runtime_services::RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let dialog_turn: Arc<dyn AgentDialogTurnPort> = scheduler.clone();
        Self::product_agent_runtime_with_dialog_turn(
            coordinator,
            scheduler,
            dialog_turn,
            Some(event_source),
            Some(session_fork),
            Some(session_usage),
            Some(turn_settlement),
            None,
            services,
        )
    }

    fn product_agent_runtime_with_dialog_turn(
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
        dialog_turn: Arc<dyn AgentDialogTurnPort>,
        event_source: Option<AgentEventSource>,
        session_fork: Option<Arc<dyn AgentSessionForkPort>>,
        session_usage: Option<Arc<dyn AgentSessionUsagePort>>,
        turn_settlement: Option<Arc<dyn AgentTurnSettlementPort>>,
        session_lineage: Option<Arc<dyn AgentSessionLineagePort>>,
        services: openbitfun_runtime_services::RuntimeServices,
    ) -> Result<AgentRuntime, String> {
        let dialog_turn = configured_plugin_dialog_turn_port(coordinator.clone(), dialog_turn);
        let submission = configured_plugin_submission_port(coordinator.clone());
        let session_management =
            scheduled_session_management_port(coordinator.clone(), scheduler.clone());
        let workspace_references: Arc<dyn AgentWorkspaceReferencePort> = coordinator.clone();
        let session_close = scheduled_session_close_port(coordinator.clone(), scheduler.clone());
        let session_revert = scheduled_session_revert_port(coordinator.clone(), scheduler.clone());
        let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();
        let session_model: Arc<dyn AgentSessionModelPort> = coordinator.clone();
        let session_restore = configured_plugin_session_restore_port(coordinator.clone());
        let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();
        let user_shell_command: Arc<dyn AgentUserShellCommandPort> = coordinator.clone();
        let transcript_reader: Arc<dyn openbitfun_runtime_ports::SessionTranscriptReader> =
            coordinator.clone();
        let thread_goal_management: Arc<dyn AgentThreadGoalManagementPort> = coordinator.clone();
        let session_compaction: Arc<dyn AgentSessionCompactionPort> = coordinator.clone();
        let hook_registry = coordinator.hook_registry().clone();
        let interaction_response: Arc<dyn AgentInteractionResponsePort> = coordinator;
        let cancellation: Arc<dyn AgentTurnCancellationPort> = scheduler.clone();
        let lifecycle_delivery: Arc<dyn AgentLifecycleDeliveryPort> = scheduler;

        let builder = core_agent_runtime_builder(
            submission,
            session_management,
            workspace_references,
            session_mode,
            session_model,
            session_compaction,
            session_restore,
            local_command_turn,
            user_shell_command,
            transcript_reader,
            thread_goal_management,
            cancellation,
            interaction_response,
            hook_registry,
        )?
        .with_session_close_port(session_close)
        .with_session_revert_port(session_revert)
        .with_dialog_turn_port(dialog_turn)
        .with_lifecycle_delivery_port(lifecycle_delivery);
        let builder = match event_source {
            Some(event_source) => builder.with_event_source(event_source),
            None => builder,
        };
        let builder = match session_fork {
            Some(port) => builder.with_session_fork_port(port),
            None => builder,
        };
        let builder = match session_usage {
            Some(port) => builder.with_session_usage_port(port),
            None => builder,
        };
        let builder = match turn_settlement {
            Some(port) => builder.with_turn_settlement_port(port),
            None => builder,
        };
        let builder = match session_lineage {
            Some(port) => builder.with_session_lineage_port(port),
            None => builder,
        };
        builder
            .with_services(services)
            .build()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn global_agent_runtime_with_lifecycle_delivery() -> Result<AgentRuntime, String> {
        let coordinator = get_global_coordinator()
            .ok_or_else(|| "Desktop session system not ready".to_string())?;
        let scheduler = get_global_scheduler()
            .ok_or_else(|| "Dialog scheduler is not initialized".to_string())?;
        Self::agent_runtime_with_lifecycle_delivery(coordinator, scheduler)
    }

    pub(crate) fn runtime_error_message(error: RuntimeError) -> String {
        error.into_message()
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteSessionTrackerHost;

#[cfg(feature = "remote-connect")]
struct CoreRemoteSessionStateTrackerSubscriber(Arc<RemoteSessionStateTracker>);

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl crate::agentic::events::EventSubscriber for CoreRemoteSessionStateTrackerSubscriber {
    async fn on_event(
        &self,
        event: &crate::agentic::events::AgenticEvent,
    ) -> openbitfun_agent_runtime::event_bus::EventSubscriberResult {
        self.0.handle_agentic_event(event);
        Ok(())
    }
}

#[cfg(feature = "remote-connect")]
impl RemoteSessionTrackerHost for CoreRemoteSessionTrackerHost {
    fn subscribe_tracker(&self, session_id: &str, tracker: Arc<RemoteSessionStateTracker>) {
        if let Some(coordinator) = get_global_coordinator() {
            let sub_id = format!("remote_tracker_{}", session_id);
            coordinator
                .subscribe_internal(sub_id, CoreRemoteSessionStateTrackerSubscriber(tracker));
            info!("Registered state tracker for session {session_id}");
        }
    }

    fn unsubscribe_tracker(&self, session_id: &str) {
        if let Some(coordinator) = get_global_coordinator() {
            let sub_id = format!("remote_tracker_{}", session_id);
            coordinator.unsubscribe_internal(&sub_id);
        }
    }

    fn active_turn_id(&self, session_id: &str) -> Option<String> {
        let coordinator = get_global_coordinator()?;
        let session_mgr = coordinator.get_session_manager();
        let session = session_mgr.get_session(session_id)?;
        match &session.state {
            crate::agentic::core::SessionState::Processing {
                current_turn_id, ..
            } => {
                info!(
                    "Seeded tracker with existing active turn {} for session {}",
                    current_turn_id, session_id
                );
                Some(current_turn_id.clone())
            }
            _ => None,
        }
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteDialogRuntimeHost<'a> {
    dispatcher: &'a RemoteExecutionDispatcher,
    coordinator: Arc<ConversationCoordinator>,
    runtime: AgentRuntime,
}

#[cfg(feature = "remote-connect")]
impl<'a> CoreRemoteDialogRuntimeHost<'a> {
    pub(crate) fn new(dispatcher: &'a RemoteExecutionDispatcher) -> Result<Self, String> {
        let coordinator = get_global_coordinator()
            .ok_or_else(|| "Desktop session system not ready".to_string())?;
        let scheduler = get_global_scheduler()
            .ok_or_else(|| "Dialog scheduler is not initialized".to_string())?;
        let runtime = CoreServiceAgentRuntime::agent_runtime_with_dialog_turns(
            coordinator.clone(),
            scheduler,
        )?;

        Ok(Self {
            dispatcher,
            coordinator,
            runtime,
        })
    }

    pub(crate) async fn steer_dialog(
        &self,
        request: RemoteDialogSteerRequest<ImageContextData>,
    ) -> Result<RemoteDialogSteerOutcome, String> {
        let attachments = request
            .image_contexts
            .into_iter()
            .map(agent_input_attachment_from_image_context)
            .collect();
        self.runtime
            .steer_dialog_turn(AgentDialogSteerRequest {
                session_id: request.session_id,
                turn_id: request.turn_id,
                content: request.content,
                display_content: request.display_content,
                attachments,
                metadata: request.metadata,
            })
            .await
            .map(|outcome| match outcome {
                DialogSteerOutcome::Buffered {
                    session_id,
                    turn_id,
                    steering_id,
                } => RemoteDialogSteerOutcome {
                    session_id,
                    turn_id,
                    steering_id,
                },
            })
            .map_err(CoreServiceAgentRuntime::runtime_error_message)
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteCancelRuntimeHost {
    coordinator: Arc<ConversationCoordinator>,
    runtime: AgentRuntime,
}

#[cfg(feature = "remote-connect")]
impl CoreRemoteCancelRuntimeHost {
    pub(crate) fn new() -> Result<Self, String> {
        let coordinator = get_global_coordinator()
            .ok_or_else(|| "Desktop session system not ready".to_string())?;
        let runtime = CoreServiceAgentRuntime::agent_runtime(coordinator.clone())?;
        Ok(Self {
            coordinator,
            runtime,
        })
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteWorkspaceFileRuntimeHost;

#[cfg(feature = "remote-connect")]
impl CoreRemoteWorkspaceFileRuntimeHost {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteWorkspaceRuntimeHost;

#[cfg(feature = "remote-connect")]
impl CoreRemoteWorkspaceRuntimeHost {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[cfg(feature = "remote-connect")]
impl RuntimeServicePort for CoreRemoteWorkspaceFileRuntimeHost {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::RemoteProjection
    }
}

#[cfg(feature = "remote-connect")]
impl RuntimeServicePort for CoreRemoteWorkspaceRuntimeHost {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::RemoteWorkspace
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteSessionRuntimeHost {
    coordinator: Arc<ConversationCoordinator>,
    runtime: AgentRuntime,
}

#[cfg(feature = "remote-connect")]
impl CoreRemoteSessionRuntimeHost {
    pub(crate) fn new() -> Result<Self, String> {
        let coordinator = get_global_coordinator()
            .ok_or_else(|| "Desktop session system not ready".to_string())?;
        let runtime = CoreServiceAgentRuntime::agent_runtime(coordinator.clone())?;
        Ok(Self {
            coordinator,
            runtime,
        })
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemotePollRuntimeHost<'a> {
    dispatcher: &'a RemoteExecutionDispatcher,
}

#[cfg(feature = "remote-connect")]
impl<'a> CoreRemotePollRuntimeHost<'a> {
    pub(crate) fn new(dispatcher: &'a RemoteExecutionDispatcher) -> Self {
        Self { dispatcher }
    }
}

#[cfg(feature = "remote-connect")]
pub(crate) struct CoreRemoteInteractionRuntimeHost {
    coordinator: Option<Arc<ConversationCoordinator>>,
}

#[cfg(feature = "remote-connect")]
impl CoreRemoteInteractionRuntimeHost {
    pub(crate) fn new() -> Self {
        Self {
            coordinator: get_global_coordinator(),
        }
    }

    fn coordinator(&self) -> Result<&ConversationCoordinator, String> {
        self.coordinator
            .as_deref()
            .ok_or_else(|| "Desktop session system not ready".to_string())
    }
}

#[cfg(feature = "remote-connect")]
fn generate_remote_turn_id() -> String {
    format!("turn_{}", uuid::Uuid::new_v4())
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteDialogRuntimeHost for CoreRemoteDialogRuntimeHost<'_> {
    type ImageContext = ImageContextData;

    fn ensure_tracker(&self, session_id: &str) {
        self.dispatcher.ensure_tracker(session_id);
    }

    async fn resolve_binding_workspace(
        &self,
        session_id: &str,
    ) -> Option<RemoteDialogWorkspaceBinding> {
        self.coordinator
            .get_session_manager()
            .resolve_session_workspace_binding(session_id)
            .await
            .map(|binding| RemoteDialogWorkspaceBinding {
                workspace_id: binding.workspace_id.clone(),
                workspace_path: binding.logical_workspace_path_string(),
                remote_connection_id: binding.connection_id().map(ToOwned::to_owned),
                remote_ssh_host: if binding.is_remote() {
                    Some(binding.session_identity.hostname.clone())
                        .filter(|value| !value.trim().is_empty())
                } else {
                    None
                },
            })
    }

    async fn remote_session_exists(&self, session_id: &str) -> Result<bool, String> {
        Ok(self
            .coordinator
            .get_session_manager()
            .get_session(session_id)
            .is_some())
    }

    async fn restore_remote_session(
        &self,
        session_id: &str,
        workspace: RemoteDialogWorkspaceBinding,
    ) -> Result<(), String> {
        // The binding's workspace ID selects the record, its runtime scope, and
        // its storage; the legacy path fields only serve pre-ID bindings.
        self.coordinator
            .restore_session_for_workspace_reference(
                workspace.workspace_id.as_deref(),
                &workspace.workspace_path,
                workspace.remote_connection_id.as_deref(),
                workspace.remote_ssh_host.as_deref(),
                session_id,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn prewarm_remote_terminal(&self, request: RemoteTerminalPrewarmRequest) {
        use terminal_core::session::SessionSource;
        use terminal_core::{TerminalApi, TerminalBindingOptions};

        let Some(session) = self
            .coordinator
            .get_session_manager()
            .get_session(&request.session_id)
        else {
            return;
        };
        if session.config.is_remote_workspace() {
            // SSH execution prepares its terminal through RemoteExecPort. The
            // local terminal binding has no target identity and must not run here.
            return;
        }

        let workspace_id = session.config.workspace_id.clone();
        let sid = request.session_id;
        let binding_workspace_for_terminal = request.binding_workspace;
        tokio::spawn(async move {
            let Ok(api) = TerminalApi::from_singleton() else {
                return;
            };
            let binding = api.session_manager().binding();
            if binding.get(&sid).is_some() {
                return;
            }
            let workspace = binding_workspace_for_terminal;
            let name = format!("Chat-{}", &sid[..8.min(sid.len())]);
            match binding
                .get_or_create(
                    &sid,
                    TerminalBindingOptions {
                        owner: workspace_id.map(|id| terminal_core::session::SessionOwner {
                            id,
                            owner_type: terminal_core::session::OwnerType::Workspace,
                        }),
                        working_directory: workspace,
                        session_id: Some(sid.clone()),
                        session_name: Some(name),
                        env: Some(tool_runtime::shell::noninteractive_terminal_env()),
                        source: Some(SessionSource::Agent),
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(_) => info!("Terminal pre-warmed for remote session {sid}"),
                Err(e) => debug!("Terminal pre-warm skipped for {sid}: {e}"),
            }
        });
    }

    fn generate_turn_id(&self) -> String {
        generate_remote_turn_id()
    }

    async fn submit_dialog(
        &self,
        submission: RemoteDialogResolvedSubmission<Self::ImageContext>,
    ) -> Result<RemoteDialogSubmitOutcome, String> {
        let policy = core_dialog_submission_policy(submission.policy);
        let attachments = submission
            .image_contexts
            .into_iter()
            .map(agent_input_attachment_from_image_context)
            .collect();

        let binding_workspace = submission.binding_workspace;
        let workspace_id = binding_workspace
            .as_ref()
            .and_then(|binding| binding.workspace_id.clone());
        let workspace_path = binding_workspace
            .as_ref()
            .map(|binding| binding.workspace_path.clone());
        let remote_connection_id = binding_workspace
            .as_ref()
            .and_then(|binding| binding.remote_connection_id.clone());
        let remote_ssh_host = binding_workspace
            .as_ref()
            .and_then(|binding| binding.remote_ssh_host.clone());
        if let Some(path) = workspace_path.as_deref() {
            self.coordinator
                .ensure_workspace_runtime_ownership_for_reference(
                    workspace_id.as_deref(),
                    path,
                    remote_connection_id.as_deref(),
                    remote_ssh_host.as_deref(),
                )
                .await
                .map_err(|error| error.to_string())?;
        }

        self.runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: submission.session_id,
                message: submission.content,
                output_schema: None,
                original_message: submission.display_content,
                turn_id: Some(submission.turn_id),
                execution: Default::default(),
                agent_type: submission.resolved_agent_type,
                workspace_path,
                workspace_id,
                remote_connection_id,
                remote_ssh_host,
                policy,
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments,
                metadata: serde_json::Map::new(),
            })
            .await
            .map(remote_dialog_scheduler_outcome_fact)
            .map(remote_dialog_submit_outcome_from_scheduler)
            .map_err(CoreServiceAgentRuntime::runtime_error_message)
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteWorkspaceFileRuntimeHost for CoreRemoteWorkspaceFileRuntimeHost {
    async fn resolve_remote_file_workspace_root(
        &self,
        session_id: Option<&str>,
    ) -> Option<std::path::PathBuf> {
        CoreServiceAgentRuntime::resolve_remote_file_workspace_root(session_id).await
    }

    async fn read_remote_file(
        &self,
        path: &str,
        session_id: Option<&str>,
        max_bytes: u64,
    ) -> Result<Option<openbitfun_runtime_ports::RemoteWorkspaceFileContent>, String> {
        CoreServiceAgentRuntime::remote_file_target(path, session_id)
            .await?
            .read(max_bytes)
            .await
            .map(Some)
    }

    async fn read_remote_file_chunk(
        &self,
        path: &str,
        session_id: Option<&str>,
        workspace_id: Option<&str>,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> Result<Option<openbitfun_runtime_ports::RemoteWorkspaceFileChunk>, String> {
        CoreServiceAgentRuntime::scoped_remote_file_target(
            path,
            session_id,
            workspace_id,
            workspace_path,
            remote_connection_id,
        )
        .await?
        .read_chunk(offset, limit)
        .await
        .map(Some)
    }

    async fn remote_file_info(
        &self,
        path: &str,
        session_id: Option<&str>,
        workspace_id: Option<&str>,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> Result<Option<openbitfun_runtime_ports::RemoteWorkspaceFileInfo>, String> {
        CoreServiceAgentRuntime::scoped_remote_file_target(
            path,
            session_id,
            workspace_id,
            workspace_path,
            remote_connection_id,
        )
        .await?
        .info()
        .await
        .map(Some)
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteWorkspaceRuntimeHost for CoreRemoteWorkspaceRuntimeHost {
    async fn current_workspace(&self) -> Option<RemoteWorkspaceFacts> {
        current_remote_workspace_facts().await
    }

    async fn recent_workspaces(&self) -> Vec<RemoteRecentWorkspaceFacts> {
        let Some(workspace_service) = crate::service::workspace::get_global_workspace_service()
        else {
            return Vec::new();
        };
        workspace_service
            .get_recent_workspaces()
            .await
            .into_iter()
            .map(|workspace| RemoteRecentWorkspaceFacts {
                workspace_id: workspace.id.clone(),
                path: workspace.root_path.to_string_lossy().to_string(),
                name: workspace.name.clone(),
                last_opened: workspace.last_accessed.to_rfc3339(),
                kind: remote_workspace_kind(workspace.workspace_kind.clone()),
                remote_connection_id: remote_workspace_metadata(
                    &workspace.workspace_kind,
                    &workspace.metadata,
                    "connectionId",
                ),
                remote_ssh_host: remote_workspace_metadata(
                    &workspace.workspace_kind,
                    &workspace.metadata,
                    "sshHost",
                ),
            })
            .collect()
    }

    async fn opened_workspaces(&self) -> Result<Option<Vec<RemoteRecentWorkspaceFacts>>, String> {
        let workspace_service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service not available".to_string())?;
        Ok(Some(
            remote_opened_workspace_catalog(&workspace_service).await,
        ))
    }

    async fn select_workspace(&self, workspace_id: &str) -> Result<RemoteWorkspaceUpdate, String> {
        let service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service not available".to_string())?;
        let coordinator = get_global_coordinator()
            .ok_or_else(|| "Conversation coordinator not initialized".to_string())?;
        let workspace = coordinator
            .select_workspace_with_runtime_ownership(&service, workspace_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(RemoteWorkspaceUpdate {
            workspace_id: workspace.id.clone(),
            path: workspace.root_path.to_string_lossy().into_owned(),
            name: workspace.name.clone(),
            remote_connection_id: remote_workspace_metadata(
                &workspace.workspace_kind,
                &workspace.metadata,
                "connectionId",
            ),
            remote_ssh_host: remote_workspace_metadata(
                &workspace.workspace_kind,
                &workspace.metadata,
                "sshHost",
            ),
        })
    }

    async fn open_workspace(
        &self,
        path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Result<RemoteWorkspaceUpdate, String> {
        open_workspace_with_snapshot(
            path,
            "remote workspace set",
            remote_connection_id,
            remote_ssh_host,
        )
        .await
    }

    async fn select_assistant_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<RemoteWorkspaceUpdate, String> {
        let service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service is unavailable".to_string())?;
        let record = service
            .require_workspace(workspace_id)
            .await
            .map_err(|error| error.to_string())?;
        if record.workspace_kind != crate::service::workspace::WorkspaceKind::Assistant {
            return Err("Selected workspace is not an assistant workspace".to_string());
        }
        self.select_workspace(workspace_id).await
    }

    async fn assistant_workspaces(&self) -> Vec<RemoteAssistantWorkspaceFacts> {
        let Some(workspace_service) = crate::service::workspace::get_global_workspace_service()
        else {
            return Vec::new();
        };
        workspace_service
            .get_assistant_workspaces()
            .await
            .into_iter()
            .map(|workspace| RemoteAssistantWorkspaceFacts {
                workspace_id: workspace.id.clone(),
                path: workspace.root_path.to_string_lossy().to_string(),
                name: workspace.name,
                assistant_id: workspace.assistant_id,
            })
            .collect()
    }

    async fn open_assistant_workspace(&self, path: &str) -> Result<RemoteWorkspaceUpdate, String> {
        open_workspace_with_snapshot(path, "remote assistant set", None, None).await
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteInitialSyncRuntimeHost for CoreRemoteWorkspaceRuntimeHost {
    async fn current_workspace(&self) -> Option<RemoteWorkspaceFacts> {
        current_remote_workspace_facts().await
    }

    async fn list_session_metadata(
        &self,
        workspace_path: &std::path::Path,
        workspace_identity: RemoteSessionWorkspaceIdentity,
    ) -> Result<Vec<RemoteSessionMetadata>, String> {
        load_remote_session_metadata_for_workspace(workspace_path, workspace_identity).await
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteSessionRuntimeHost for CoreRemoteSessionRuntimeHost {
    async fn workspace_by_id(&self, workspace_id: &str) -> Result<RemoteWorkspaceFacts, String> {
        let service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service not available".to_string())?;
        let workspace = service
            .require_workspace(workspace_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(remote_workspace_facts_from_record(&workspace))
    }

    async fn list_session_metadata(
        &self,
        workspace_path: &std::path::Path,
        workspace_identity: RemoteSessionWorkspaceIdentity,
    ) -> Result<Vec<RemoteSessionMetadata>, String> {
        load_remote_session_metadata_for_workspace(workspace_path, workspace_identity).await
    }

    async fn resolve_legacy_workspace(
        &self,
        workspace_path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Result<Option<RemoteWorkspaceFacts>, String> {
        let service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service not available".to_string())?;
        let workspace = service
            .resolve_legacy_workspace_reference(
                None,
                workspace_path,
                remote_connection_id,
                remote_ssh_host,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(workspace.as_ref().map(remote_workspace_facts_from_record))
    }

    async fn resolve_default_assistant_workspace(&self) -> Result<RemoteWorkspaceFacts, String> {
        let workspace_service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service not available".to_string())?;
        let workspace = match workspace_service.get_primary_assistant_workspace().await {
            Some(primary_workspace) => primary_workspace,
            None => workspace_service
                .create_assistant_workspace(None)
                .await
                .map_err(|error| format!("Failed to create assistant workspace: {}", error))?,
        };
        Ok(remote_workspace_facts_from_record(&workspace))
    }

    async fn create_session(&self, request: AgentSessionCreateRequest) -> Result<String, String> {
        self.runtime
            .create_session(request)
            .await
            .map(|session| session.session_id)
            .map_err(CoreServiceAgentRuntime::runtime_error_message)
    }

    async fn load_model_catalog(
        &self,
        session_id: Option<&str>,
    ) -> Result<RemoteModelCatalog, String> {
        CoreServiceAgentRuntime::load_remote_model_catalog(session_id).await
    }

    async fn update_session_model_selection(
        &self,
        session_id: &str,
        model_id: &str,
        reasoning_preset: Option<Option<&str>>,
    ) -> Result<RemoteSessionModelSelection, String> {
        CoreServiceAgentRuntime::update_remote_session_model(
            self.coordinator.as_ref(),
            &self.runtime,
            session_id,
            model_id,
            reasoning_preset,
        )
        .await
    }

    async fn ensure_session_loaded(&self, session_id: &str) -> Result<(), String> {
        let binding = CoreServiceAgentRuntime::resolve_session_workspace_binding(session_id)
            .await
            .ok_or_else(|| {
                format!("Session workspace binding not available for session: {session_id}")
            })?;
        ensure_remote_binding_runtime_ownership(self.coordinator.as_ref(), &binding).await?;
        if self
            .coordinator
            .get_session_manager()
            .get_session(session_id)
            .is_some()
        {
            return Ok(());
        }

        self.coordinator
            .restore_session_for_workspace_binding(&binding, session_id)
            .await
            .map(|_| ())
            .map_err(|error| format!("Failed to restore session: {error}"))
    }

    async fn update_session_title(&self, session_id: &str, title: &str) -> Result<String, String> {
        self.coordinator
            .update_session_title(session_id, title)
            .await
            .map_err(|error| error.to_string())
    }

    async fn resolve_session_storage_dir(&self, session_id: &str) -> Option<std::path::PathBuf> {
        CoreServiceAgentRuntime::resolve_session_storage_dir(session_id).await
    }

    async fn load_remote_chat_messages(
        &self,
        session_storage_dir: &std::path::Path,
        session_id: &str,
    ) -> Result<(Vec<ChatMessage>, bool), String> {
        CoreServiceAgentRuntime::load_remote_chat_messages(session_storage_dir, session_id).await
    }

    async fn delete_session(
        &self,
        session_storage_dir: &std::path::Path,
        session_id: &str,
    ) -> Result<(), String> {
        let binding = CoreServiceAgentRuntime::resolve_session_workspace_binding(session_id)
            .await
            .ok_or_else(|| {
                format!("Session workspace binding not available for session: {session_id}")
            })?;
        ensure_remote_binding_runtime_ownership(self.coordinator.as_ref(), &binding).await?;
        self.coordinator
            .delete_session(session_storage_dir, session_id)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn remove_tracker(&self, session_id: &str) {
        crate::service::remote_connect::remote_server::get_or_init_global_dispatcher()
            .remove_tracker(session_id);
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemotePollRuntimeHost for CoreRemotePollRuntimeHost<'_> {
    fn ensure_tracker(&self, session_id: &str) -> Arc<RemoteSessionStateTracker> {
        self.dispatcher.ensure_tracker(session_id)
    }

    fn sync_pending_permissions(&self, session_id: &str, tracker: &RemoteSessionStateTracker) {
        let Ok(manager) = crate::product_runtime::core_permission_request_manager() else {
            return;
        };
        for request in manager
            .pending_requests()
            .into_iter()
            .filter(|request| request.session_id == session_id)
        {
            let tool_id = request
                .tool_call_id
                .clone()
                .unwrap_or_else(|| request.request_id.clone());
            let tool_name = request.source.identity.clone();
            let tool_input = Some(serde_json::json!({
                "action": request.action,
                "resources": request.resources,
            }));
            let input_preview = tool_input
                .as_ref()
                .and_then(|input| serde_json::to_string(input).ok());
            tracker.sync_pending_permission(tool_id, tool_name, input_preview, tool_input);
        }
    }

    async fn load_model_catalog(&self, session_id: &str) -> Option<RemoteModelCatalog> {
        CoreServiceAgentRuntime::load_remote_model_catalog(Some(session_id))
            .await
            .ok()
    }

    async fn resolve_session_storage_dir(&self, session_id: &str) -> Option<std::path::PathBuf> {
        CoreServiceAgentRuntime::resolve_session_storage_dir(session_id).await
    }

    async fn load_remote_chat_messages(
        &self,
        session_storage_dir: &std::path::Path,
        session_id: &str,
    ) -> Result<(Vec<ChatMessage>, bool), String> {
        CoreServiceAgentRuntime::load_remote_chat_messages(session_storage_dir, session_id).await
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteInteractionRuntimeHost for CoreRemoteInteractionRuntimeHost {
    async fn confirm_tool(
        &self,
        tool_id: &str,
        updated_input: Option<serde_json::Value>,
    ) -> Result<(), String> {
        self.coordinator()?
            .reply_to_tool(
                tool_id,
                match updated_input {
                    Some(updated_input) => {
                        openbitfun_agent_runtime::sdk::PermissionReply::OnceWithInput {
                            updated_input,
                        }
                    }
                    None => openbitfun_agent_runtime::sdk::PermissionReply::Once,
                },
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn reject_tool(&self, tool_id: &str, reason: String) -> Result<(), String> {
        self.coordinator()?
            .reply_to_tool(
                tool_id,
                openbitfun_agent_runtime::sdk::PermissionReply::Reject {
                    feedback: Some(reason),
                },
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn get_permission_mode(&self) -> Result<RemotePermissionMode, String> {
        let service = crate::service::config::global::GlobalConfigManager::get_service()
            .await
            .map_err(|error| error.to_string())?;
        let config: ToolPermissionConfig = service
            .get_config(Some("tool_permissions"))
            .await
            .map_err(|error| error.to_string())?;
        Ok(match config.policy.preset {
            PermissionPolicyPreset::FullAccess => RemotePermissionMode::FullAccess,
            PermissionPolicyPreset::Ask if config.interaction.auto_approve_ask => {
                RemotePermissionMode::Auto
            }
            PermissionPolicyPreset::Ask => RemotePermissionMode::Ask,
        })
    }

    async fn set_permission_mode(
        &self,
        mode: RemotePermissionMode,
    ) -> Result<RemotePermissionMode, String> {
        let service = crate::service::config::global::GlobalConfigManager::get_service()
            .await
            .map_err(|error| error.to_string())?;
        let mut config: ToolPermissionConfig = service
            .get_config(Some("tool_permissions"))
            .await
            .map_err(|error| error.to_string())?;
        match mode {
            RemotePermissionMode::Ask => {
                config.policy.preset = PermissionPolicyPreset::Ask;
                config.interaction.auto_approve_ask = false;
            }
            RemotePermissionMode::Auto => {
                config.policy.preset = PermissionPolicyPreset::Ask;
                config.interaction.auto_approve_ask = true;
            }
            RemotePermissionMode::FullAccess => {
                config.policy.preset = PermissionPolicyPreset::FullAccess;
                config.interaction.auto_approve_ask = false;
            }
        }
        service
            .set_config("tool_permissions", &config)
            .await
            .map_err(|error| error.to_string())?;
        Ok(mode)
    }

    async fn cancel_tool(&self, tool_id: &str, reason: String) -> Result<(), String> {
        self.coordinator()?
            .cancel_tool(tool_id, reason)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn start_question_interaction(&self, session_id: &str, tool_id: &str) -> Result<(), String> {
        crate::agentic::tools::user_input_manager::get_user_input_manager()
            .start_interaction(session_id, tool_id)
            .map_err(|error| error.to_string())
    }

    fn answer_question(&self, tool_id: &str, answers: serde_json::Value) -> Result<(), String> {
        crate::agentic::tools::user_input_manager::get_user_input_manager()
            .send_answer(tool_id, answers)
            .map_err(|error| error.to_string())
    }
}

#[cfg(feature = "remote-connect")]
#[async_trait::async_trait]
impl RemoteCancelRuntimeHost for CoreRemoteCancelRuntimeHost {
    async fn resolve_session_storage_dir(&self, session_id: &str) -> Option<String> {
        CoreServiceAgentRuntime::resolve_session_storage_dir(session_id)
            .await
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn remote_control_state(
        &self,
        session_id: &str,
    ) -> Result<Option<RemoteControlStateSnapshot>, String> {
        let state_port =
            CoreServiceAgentRuntime::remote_control_state_port(self.coordinator.as_ref());
        state_port
            .read_remote_control_state(RemoteControlStateRequest {
                session_id: session_id.to_string(),
            })
            .await
            .map_err(|error| error.message)
    }

    async fn restore_remote_session(
        &self,
        session_id: &str,
        _restore_path_hint: &str,
    ) -> Result<(), String> {
        let binding = CoreServiceAgentRuntime::resolve_session_workspace_binding(session_id)
            .await
            .ok_or_else(|| {
                format!("Session workspace binding not available for session: {session_id}")
            })?;
        ensure_remote_binding_runtime_ownership(self.coordinator.as_ref(), &binding).await?;
        self.coordinator
            .restore_session_for_workspace_binding(&binding, session_id)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn cancel_remote_turn(&self, session_id: &str, turn_id: &str) -> Result<(), String> {
        self.runtime
            .cancel_turn(AgentTurnCancellationRequest {
                session_id: session_id.to_string(),
                turn_id: Some(turn_id.to_string()),
                source: Some(AgentSubmissionSource::RemoteRelay),
                requester_session_id: None,
                reason: None,
                wait_timeout_ms: None,
                cancel_descendants: true,
            })
            .await
            .map(|_| ())
            .map_err(CoreServiceAgentRuntime::runtime_error_message)
    }
}

#[cfg(all(test, feature = "remote-connect"))]
mod tests {
    use std::collections::HashSet;

    use openbitfun_runtime_ports::SessionTranscriptReader;
    use openbitfun_services_integrations::remote_connect::no_host_image_pixels;

    use super::*;
    use crate::service::session::{
        DialogTurnData, DialogTurnKind, ModelRoundData, TextItemData, ThinkingItemData,
        ToolCallData, ToolItemData, TurnStatus, UserMessageData,
    };
    use crate::OpenBitFunError;

    #[test]
    fn local_workspace_marker_is_not_remote_routing_authority() {
        use crate::service::workspace::WorkspaceKind;
        let metadata = std::collections::HashMap::from([
            ("sshHost".to_string(), serde_json::json!("localhost")),
            (
                "connectionId".to_string(),
                serde_json::json!("saved-localhost-ssh"),
            ),
        ]);
        for kind in [WorkspaceKind::Normal, WorkspaceKind::Assistant] {
            assert_eq!(remote_workspace_metadata(&kind, &metadata, "sshHost"), None);
            assert_eq!(
                remote_workspace_metadata(&kind, &metadata, "connectionId"),
                None
            );
        }
        assert_eq!(
            remote_workspace_metadata(&WorkspaceKind::Remote, &metadata, "sshHost"),
            Some("localhost".into())
        );
        assert_eq!(
            remote_workspace_metadata(&WorkspaceKind::Remote, &metadata, "connectionId"),
            Some("saved-localhost-ssh".into())
        );
    }

    #[tokio::test]
    async fn missing_output_session_cannot_borrow_the_selected_workspace() {
        let missing = "missing-output-session-route-test";
        assert!(
            CoreServiceAgentRuntime::resolve_remote_file_workspace_root(Some(missing))
                .await
                .is_none()
        );
        let result =
            CoreServiceAgentRuntime::remote_file_target("preview.png", Some(missing)).await;
        assert!(
            matches!(result, Err(error) if error.contains("output session workspace is unavailable"))
        );
    }

    #[tokio::test]
    async fn remote_workspace_catalog_tracks_opened_rows_and_assistant_identity() {
        use crate::service::workspace::{WorkspaceCreateOptions, WorkspaceKind, WorkspaceService};
        let root = tempfile::tempdir().unwrap();
        let paths = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(
                root.path().join("user-root"),
            ),
        );
        let service = WorkspaceService::new_for_test_path_manager(paths).await;
        let project_root = root.path().join("project");
        let assistant_root = root.path().join("workspace");
        std::fs::create_dir_all(&project_root).unwrap();
        std::fs::create_dir_all(&assistant_root).unwrap();
        std::fs::write(assistant_root.join("IDENTITY.md"), "---\nname: Mina\n---\n").unwrap();
        let project = service.open_workspace(project_root).await.unwrap();
        let assistant = service
            .open_workspace_with_options(
                assistant_root.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Assistant,
                    display_name: Some("workspace".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // Older records can retain the directory name alongside an up-to-date identity.
        let mut export = service.export_workspaces().await.unwrap();
        export
            .workspaces
            .iter_mut()
            .find(|row| row.id == assistant.id)
            .unwrap()
            .name = "workspace".into();
        service.import_workspaces(export, true).await.unwrap();

        let opened = remote_opened_workspace_catalog(&service).await;
        assert_eq!(opened.len(), 2);
        assert!(opened
            .iter()
            .all(|row| row.remote_connection_id.is_none() && row.remote_ssh_host.is_none()));
        let assistant_row = opened
            .iter()
            .find(|row| row.path == assistant.root_path.to_string_lossy())
            .unwrap();
        assert_eq!(assistant_row.name, "Mina");
        assert_eq!(assistant_row.kind, RemoteConnectWorkspaceKind::Assistant);

        service.close_workspace(&project.id).await.unwrap();
        assert!(service
            .get_recent_workspaces()
            .await
            .iter()
            .any(|row| row.id == project.id));
        let refreshed = remote_opened_workspace_catalog(&service).await;
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].name, "Mina");
        service.close_workspace(&assistant.id).await.unwrap();
        assert!(remote_opened_workspace_catalog(&service).await.is_empty());
    }

    /// Builds a session create request bound to a registered workspace record.
    /// The record is authoritative for local/remote; paths are IO projections.
    #[cfg(feature = "opencode-plugin-host")]
    fn plugin_session_request(
        workspace: &crate::service::workspace::WorkspaceInfo,
    ) -> AgentSessionCreateRequest {
        AgentSessionCreateRequest {
            session_name: "session".to_string(),
            agent_type: "Code".to_string(),
            agent_route_key: None,
            workspace_path: Some(workspace.root_path.to_string_lossy().into_owned()),
            project_workspace_path: None,
            execution_target: Some(openbitfun_core_types::SessionExecutionTarget::local(
                "project-worktree",
            )),
            workspace_id: Some(workspace.id.clone()),
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            metadata: serde_json::Map::new(),
        }
    }

    /// Registers a temporary local workspace; the guard keeps its directory
    /// alive for the calling test.
    #[cfg(feature = "opencode-plugin-host")]
    async fn local_plugin_workspace(
    ) -> (tempfile::TempDir, crate::service::workspace::WorkspaceInfo) {
        let directory = tempfile::tempdir().expect("plugin workspace");
        let record = crate::service::workspace::legacy_compat::register_local_fixture(
            directory.path(),
            None,
        )
        .await;
        (directory, record)
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[tokio::test]
    async fn configured_plugins_bind_to_the_session_execution_root() {
        let (_workspace_dir, workspace) = local_plugin_workspace().await;
        let request = plugin_session_request(&workspace);

        assert_eq!(
            configured_plugin_execution_root(&request)
                .await
                .expect("local execution root"),
            Some(std::path::PathBuf::from("project-worktree"))
        );
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[tokio::test]
    async fn configured_plugins_do_not_execute_for_remote_sessions() {
        let remote = crate::service::workspace::legacy_compat::register_remote_fixture(
            &format!("/srv/plugin-remote/{}", uuid::Uuid::new_v4()),
            "remote-a",
            "remote.example",
        )
        .await;
        let request = plugin_session_request(&remote);

        assert_eq!(
            configured_plugin_execution_root(&request)
                .await
                .expect("remote session is supported"),
            None
        );
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[tokio::test]
    async fn configured_plugins_ignore_stale_transport_hints_on_a_local_record() {
        let (_workspace_dir, workspace) = local_plugin_workspace().await;
        let mut request = plugin_session_request(&workspace);
        request.remote_connection_id = Some("stale-remote".to_string());

        assert_eq!(
            configured_plugin_execution_root(&request)
                .await
                .expect("the workspace record decides local vs remote"),
            Some(std::path::PathBuf::from("project-worktree"))
        );
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn configured_plugins_recover_from_the_persisted_session_execution_root() {
        let target = openbitfun_core_types::SessionExecutionTarget::local("restored-worktree");

        assert_eq!(
            configured_plugin_root_from_session_facts(Some("project"), Some(&target), false,)
                .expect("restored local execution root"),
            Some(std::path::PathBuf::from("restored-worktree"))
        );
        assert_eq!(
            configured_plugin_root_from_session_facts(Some("/remote/project"), None, true,)
                .expect("remote session remains outside the local Host"),
            None
        );
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[tokio::test]
    async fn configured_plugin_failure_does_not_block_native_session_creation() {
        let (_workspace_dir, workspace) = local_plugin_workspace().await;
        let mut request = plugin_session_request(&workspace);
        request.workspace_path = None;
        request.execution_target = None;

        let outcome: () = ConfiguredPluginSubmissionPort::ensure_workspace(&request).await;
        assert_eq!(outcome, ());
    }

    #[test]
    fn session_close_preserves_writer_conflicts() {
        let error = map_session_close_error(OpenBitFunError::SessionInUse {
            session_id: "session-1".to_string(),
        });

        assert_eq!(
            error.kind,
            openbitfun_runtime_ports::PortErrorKind::SessionInUse
        );
    }

    #[test]
    fn targeted_rollback_restores_before_requiring_an_in_memory_session() {
        let source = include_str!("service_agent_runtime.rs");
        let body = source
            .split("async fn rollback_session_to_turn")
            .nth(1)
            .and_then(|source| source.split("impl AgentSessionManagementPort").next())
            .expect("targeted rollback implementation");
        // Storage is resolved from the owning workspace ID, never from a path.
        assert!(!body.contains("resolve_session_storage_path"));
        let resolve_storage = body
            .find("resolve_workspace_storage")
            .expect("storage resolution by workspace ID");
        let restore_session = body
            .find("restore_session_from_storage_path")
            .expect("disk Session restore");
        let local_workspace = body
            .find("local_revert_workspace")
            .expect("local workspace validation");
        let maintenance = body
            .find("begin_session_maintenance")
            .expect("maintenance admission");

        assert!(resolve_storage < restore_session);
        assert!(restore_session < local_workspace);
        assert!(local_workspace < maintenance);
    }

    #[test]
    fn core_service_agent_runtime_owner_keeps_coordinator_port_contracts() {
        fn assert_runtime_ports<T>()
        where
            T: AgentSubmissionPort
                + AgentInteractionResponsePort
                + AgentSessionCompactionPort
                + AgentSessionManagementPort
                + AgentThreadGoalManagementPort
                + AgentTurnCancellationPort
                + RemoteControlStatePort
                + SessionTranscriptReader,
        {
        }

        assert_runtime_ports::<ConversationCoordinator>();
    }

    #[test]
    fn remote_attach_and_mutation_paths_preserve_workspace_ownership_facts() {
        let source = include_str!("service_agent_runtime.rs");
        let open_workspace = source
            .split("async fn open_workspace_with_snapshot")
            .nth(1)
            .and_then(|source| {
                source
                    .split("async fn load_remote_session_metadata_for_workspace")
                    .next()
            })
            .expect("remote workspace open helper");
        assert!(open_workspace.contains("upgrade_legacy_workspace_with_runtime_ownership"));
        assert!(!open_workspace.contains("upgrade_legacy_workspace_open"));
        assert!(!open_workspace.contains("initialize_snapshot_manager_for_workspace"));

        for (start, end) in [
            ("pub(crate) async fn update_remote_session_model", "/// Persist the shared selector"),
            ("async fn restore_remote_session(\n        &self,\n        session_id: &str,\n        workspace: RemoteDialogWorkspaceBinding", "fn prewarm_remote_terminal"),
            ("async fn ensure_session_loaded(&self, session_id: &str)", "async fn update_session_title"),
            ("async fn restore_remote_session(\n        &self,\n        session_id: &str,\n        _restore_path_hint: &str", "async fn cancel_remote_turn"),
        ] {
            let body = source
                .split(start)
                .nth(1)
                .and_then(|source| source.split(end).next())
                .expect("reviewed remote runtime method");
            assert!(
                body.contains("restore_session_for_workspace"),
                "remote attach or mutation must use structured workspace facts"
            );
            assert!(
                !body.contains("restore_session_from_storage_path"),
                "remote attach or mutation must not bypass the Coordinator ownership gate"
            );
        }

        let remote_session_host = source
            .split("impl RemoteSessionRuntimeHost for CoreRemoteSessionRuntimeHost")
            .nth(1)
            .and_then(|source| source.split("impl RemotePollRuntimeHost").next())
            .expect("remote session host implementation");
        let delete = remote_session_host
            .split("async fn delete_session")
            .nth(1)
            .and_then(|source| source.split("fn remove_tracker").next())
            .expect("remote session delete");
        assert!(delete.contains("ensure_remote_binding_runtime_ownership"));
    }

    #[test]
    fn remote_model_lookup_keeps_read_only_restore_lock_free() {
        let source = include_str!("service_agent_runtime.rs");
        let body = source
            .split("async fn resolve_session_model_selection")
            .nth(1)
            .and_then(|source| source.split("fn core_dialog_submission_policy").next())
            .expect("remote model lookup");

        assert!(body.contains("restore_session_view_from_storage_path_timed"));
        assert!(!body.contains("restore_session_from_storage_path"));
    }

    #[test]
    fn remote_generated_turn_ids_are_uuid_unique() {
        let ids = (0..1_024)
            .map(|_| generate_remote_turn_id())
            .collect::<HashSet<_>>();

        assert_eq!(ids.len(), 1_024);
        assert!(ids.iter().all(|id| {
            id.strip_prefix("turn_")
                .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
        }));
    }

    #[test]
    fn core_service_agent_runtime_owner_keeps_scheduler_lifecycle_port_contracts() {
        fn assert_scheduler_ports<T>()
        where
            T: AgentDialogTurnPort + AgentLifecycleDeliveryPort + AgentTurnCancellationPort,
        {
        }

        fn assert_session_lifecycle_port<T: AgentSessionClosePort>() {}

        assert_scheduler_ports::<DialogScheduler>();
        assert_session_lifecycle_port::<ScheduledSessionManagementPort>();
    }

    #[test]
    fn core_service_agent_runtime_owner_exposes_agent_runtime_and_remote_control_port() {
        fn assert_agent_runtime(
            coordinator: Arc<ConversationCoordinator>,
        ) -> Result<AgentRuntime, String> {
            CoreServiceAgentRuntime::agent_runtime(coordinator)
        }

        fn assert_agent_runtime_with_dialog_turns(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
        ) -> Result<AgentRuntime, String> {
            CoreServiceAgentRuntime::agent_runtime_with_dialog_turns(coordinator, scheduler)
        }

        fn assert_agent_runtime_with_lifecycle_delivery(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
        ) -> Result<AgentRuntime, String> {
            CoreServiceAgentRuntime::agent_runtime_with_lifecycle_delivery(coordinator, scheduler)
        }

        fn assert_agent_runtime_with_scheduler_ports(
            coordinator: Arc<ConversationCoordinator>,
            scheduler: Arc<DialogScheduler>,
        ) -> Result<AgentRuntime, String> {
            CoreServiceAgentRuntime::agent_runtime_with_scheduler_ports(coordinator, scheduler)
        }

        fn assert_remote_control_port(
            coordinator: &ConversationCoordinator,
        ) -> &(dyn RemoteControlStatePort + '_) {
            CoreServiceAgentRuntime::remote_control_state_port(coordinator)
        }

        let _ = assert_agent_runtime;
        let _ = assert_agent_runtime_with_dialog_turns;
        let _ = assert_agent_runtime_with_lifecycle_delivery;
        let _ = assert_agent_runtime_with_scheduler_ports;
        let _ = assert_remote_control_port;
    }

    #[test]
    fn session_surface_runtime_registers_explicit_session_mutation_ports() {
        let source = include_str!("service_agent_runtime.rs");
        let builder = source
            .split("pub(crate) fn session_surface_agent_runtime")
            .nth(1)
            .and_then(|source| {
                source
                    .split("pub(crate) fn agent_runtime_with_scheduler_ports")
                    .next()
            })
            .expect("session surface runtime builder");

        assert!(builder.contains(
            "let local_command_turn: Arc<dyn AgentLocalCommandTurnPort> = coordinator.clone();"
        ));
        assert!(builder.contains(".with_local_command_turn_port(local_command_turn)"));
        assert!(builder
            .contains("let session_mode: Arc<dyn AgentSessionModePort> = coordinator.clone();"));
        assert!(builder.contains(".with_session_mode_port(session_mode)"));
        assert!(builder.contains(
            "let session_restore = configured_plugin_session_restore_port(coordinator.clone());"
        ));
        assert!(builder.contains(".with_session_restore_port(session_restore)"));
        assert!(builder.contains("configured_plugin_dialog_turn_port("));
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn configured_dialog_turn_port_recovers_plugins_before_session_execution() {
        let source = include_str!("service_agent_runtime.rs");
        let body = source
            .split("impl AgentDialogTurnPort for ConfiguredPluginDialogTurnPort")
            .nth(1)
            .and_then(|source| source.split("fn configured_plugin_dialog_turn_port").next())
            .expect("configured plugin dialog turn port");

        for method in ["submit_dialog_turn", "recover_interrupted_turn"] {
            let method_body = body
                .split(&format!("async fn {method}"))
                .nth(1)
                .expect("dialog method implementation");
            let ensure = method_body
                .find("self.submission.ensure_session")
                .expect("plugin recovery gate");
            let delegate = method_body
                .find(&format!("self.inner.{method}"))
                .expect("dialog delegate");
            assert!(ensure < delegate, "{method} must recover plugins first");
        }
    }

    #[test]
    fn core_service_agent_runtime_owner_maps_remote_dialog_policy() {
        let relay = core_dialog_submission_policy(RemoteDialogSubmissionPolicy {
            source: RemoteConnectSubmissionSource::Relay,
            queue_priority: RemoteDialogQueuePriority::High,
        });
        assert_eq!(relay.trigger_source, DialogTriggerSource::RemoteRelay);
        assert_eq!(relay.queue_priority, DialogQueuePriority::High);

        let bot = core_dialog_submission_policy(RemoteDialogSubmissionPolicy {
            source: RemoteConnectSubmissionSource::Bot,
            queue_priority: RemoteDialogQueuePriority::Low,
        });
        assert_eq!(bot.trigger_source, DialogTriggerSource::Bot);
        assert_eq!(bot.queue_priority, DialogQueuePriority::Low);
    }

    #[test]
    fn core_service_agent_runtime_owner_maps_image_context_to_lifecycle_attachment() {
        let attachment = agent_input_attachment_from_image_context(ImageContextData {
            id: "ctx-1".to_string(),
            image_path: Some("/workspace/clip.png".to_string()),
            data_url: Some("data:image/png;base64,abc".to_string()),
            mime_type: "image/png".to_string(),
            metadata: Some(serde_json::json!({ "name": "clip.png" })),
        });

        assert_eq!(attachment.kind, "remote_image");
        assert_eq!(attachment.id, "ctx-1");
        assert_eq!(
            attachment.metadata.get("imagePath"),
            Some(&serde_json::json!("/workspace/clip.png"))
        );
        assert_eq!(
            attachment.metadata.get("dataUrl"),
            Some(&serde_json::json!("data:image/png;base64,abc"))
        );
        assert_eq!(
            attachment.metadata.get("mimeType"),
            Some(&serde_json::json!("image/png"))
        );
        assert_eq!(
            attachment
                .metadata
                .get("metadata")
                .and_then(|value| value.get("name")),
            Some(&serde_json::json!("clip.png"))
        );
    }

    #[test]
    fn core_service_agent_runtime_owner_normalizes_remote_session_model_ids() {
        assert_eq!(
            normalize_remote_session_model_id(None),
            Some("primary".to_string())
        );
        assert_eq!(
            normalize_remote_session_model_id(Some("")),
            Some("primary".to_string())
        );
        assert_eq!(
            normalize_remote_session_model_id(Some("  default  ")),
            Some("primary".to_string())
        );
        assert_eq!(
            normalize_remote_session_model_id(Some(" model-1 ")),
            Some("model-1".to_string())
        );
    }

    #[test]
    fn core_service_agent_runtime_owner_normalizes_remote_model_selection_aliases() {
        assert_eq!(
            normalize_remote_model_selection("default", None).unwrap(),
            "primary"
        );
        assert_eq!(
            normalize_remote_model_selection("primary", None).unwrap(),
            "primary"
        );
        assert_eq!(
            normalize_remote_model_selection("fast", None).unwrap(),
            "fast"
        );
        assert_eq!(
            normalize_remote_model_selection("   ", None).unwrap_err(),
            "model_id is required"
        );
        assert_eq!(
            normalize_remote_model_selection("custom-alias", None).unwrap_err(),
            "Config service not available"
        );
    }

    #[test]
    fn core_service_agent_runtime_only_shares_model_defaults_for_standard_sessions() {
        let mut session = Session::new_with_id(
            "session-model-scope".to_string(),
            "Model scope".to_string(),
            "Standard".to_string(),
            Default::default(),
        );

        assert!(session_uses_shared_mode_default(&session));

        session.kind = SessionKind::Subagent;
        assert!(!session_uses_shared_mode_default(&session));

        session.kind = SessionKind::EphemeralChild;
        assert!(!session_uses_shared_mode_default(&session));
    }

    #[test]
    fn core_service_agent_runtime_owner_preserves_remote_chat_history_shape() {
        let turn = remote_history_test_turn(
            TurnStatus::Completed,
            Some(serde_json::json!({
                "original_text": "original question",
                "images": [
                    {
                        "name": "screenshot.png",
                        "data_url": "data:image/png;base64,abcd"
                    }
                ]
            })),
        );

        let messages = remote_chat_messages_from_turns(&[turn], &no_host_image_pixels);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "original question");
        assert_eq!(
            messages[0].images.as_ref().unwrap()[0].name,
            "screenshot.png"
        );

        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "visible text");
        assert_eq!(messages[1].status.as_deref(), Some("done"));
        assert_eq!(messages[1].thinking.as_deref(), Some("visible thought"));
        let items = messages[1].items.as_ref().expect("assistant items");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].item_type, "thinking");
        assert_eq!(items[1].item_type, "text");
        assert_eq!(items[2].item_type, "tool");
        assert_eq!(
            messages[1].tools.as_ref().unwrap()[0].name,
            "AskUserQuestion"
        );
    }

    #[test]
    fn core_service_agent_runtime_owner_preserves_in_progress_remote_assistant_history() {
        let turn = remote_history_test_turn(TurnStatus::InProgress, None);

        let messages = remote_chat_messages_from_turns(&[turn], &no_host_image_pixels);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "visible text");
        assert_eq!(messages[1].status.as_deref(), Some("active"));
        assert_eq!(messages[1].tools.as_ref().unwrap()[0].status, "running");
    }

    #[test]
    fn core_service_agent_runtime_owner_does_not_project_an_empty_assistant_shell() {
        let mut turn = remote_history_test_turn(TurnStatus::InProgress, None);
        turn.model_rounds.clear();

        let messages = remote_chat_messages_from_turns(&[turn], &no_host_image_pixels);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn core_service_agent_runtime_owner_preserves_failed_remote_turn_error() {
        let mut turn = remote_history_test_turn(TurnStatus::Error, None);
        turn.error = Some("AI client could not reach the configured proxy".to_string());

        let messages = remote_chat_messages_from_turns(&[turn], &no_host_image_pixels);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(messages[1].status.as_deref(), Some("failed"));
        assert_eq!(
            messages[1].error.as_deref(),
            Some("AI client could not reach the configured proxy")
        );
    }

    #[test]
    fn core_service_agent_runtime_owner_strips_enhanced_remote_user_input() {
        let mut turn = remote_history_test_turn(TurnStatus::Completed, None);
        turn.user_message.content =
            "User uploaded a file.\nUser's question:\n  explain this  ".to_string();

        let messages = remote_chat_messages_from_turns(&[turn], &no_host_image_pixels);

        assert_eq!(messages[0].content, "explain this");
    }

    fn remote_history_test_turn(
        status: TurnStatus,
        metadata: Option<serde_json::Value>,
    ) -> DialogTurnData {
        DialogTurnData {
            turn_id: "turn-1".to_string(),
            turn_index: 0,
            session_id: "session-1".to_string(),
            timestamp: 1_000,
            kind: DialogTurnKind::UserDialog,
            agent_type: None,
            user_message: UserMessageData {
                id: "user-1".to_string(),
                content: "fallback text".to_string(),
                timestamp: 1_000,
                metadata,
            },
            model_rounds: vec![ModelRoundData {
                id: "round-1".to_string(),
                turn_id: "turn-1".to_string(),
                round_index: 0,
                round_group_id: None,
                timestamp: 1_100,
                text_items: vec![
                    TextItemData {
                        id: "text-hidden".to_string(),
                        content: "hidden text".to_string(),
                        is_streaming: false,
                        timestamp: 1_111,
                        is_markdown: true,
                        order_index: Some(1),
                        is_subagent_item: Some(true),
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        status: None,
                        attempt_id: None,
                        attempt_index: None,
                    },
                    TextItemData {
                        id: "text-1".to_string(),
                        content: "visible text".to_string(),
                        is_streaming: false,
                        timestamp: 1_112,
                        is_markdown: true,
                        order_index: Some(1),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        status: None,
                        attempt_id: None,
                        attempt_index: None,
                    },
                ],
                tool_items: vec![ToolItemData {
                    id: "tool-1".to_string(),
                    tool_name: "AskUserQuestion".to_string(),
                    tool_call: ToolCallData {
                        input: serde_json::json!({ "question": "confirm?" }),
                        id: "call-1".to_string(),
                    },
                    tool_result: None,
                    ai_intent: None,
                    start_time: 1_130,
                    end_time: None,
                    duration_ms: Some(25),
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                    order_index: Some(2),
                    is_subagent_item: None,
                    parent_task_tool_id: None,
                    subagent_session_id: None,
                    subagent_dialog_turn_id: None,
                    attempt_id: None,
                    attempt_index: None,
                    subagent_model_id: None,
                    subagent_model_display_name: None,
                    status: Some("running".to_string()),
                    interruption_reason: None,
                }],
                thinking_items: vec![ThinkingItemData {
                    id: "thinking-1".to_string(),
                    content: "visible thought".to_string(),
                    reasoning_kind: None,
                    is_streaming: false,
                    is_collapsed: false,
                    timestamp: 1_105,
                    order_index: Some(0),
                    status: None,
                    is_subagent_item: None,
                    parent_task_tool_id: None,
                    subagent_session_id: None,
                    attempt_id: None,
                    attempt_index: None,
                }],
                start_time: 1_100,
                end_time: Some(1_200),
                duration_ms: Some(100),
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
            }],
            start_time: 1_000,
            end_time: Some(1_250),
            duration_ms: Some(250),
            token_usage: None,
            finish_reason: None,
            has_final_response: None,
            error: None,
            error_detail: None,
            recovery: None,
            recovery_epoch: None,
            status,
        }
    }
}

async fn resolve_history_workspace(
    workspace_id: Option<&str>,
    path: &str,
    connection_id: Option<&str>,
    ssh_host: Option<&str>,
) -> PortResult<WorkspaceBinding> {
    let mut config = crate::agentic::core::SessionConfig {
        workspace_id: workspace_id.map(str::to_owned),
        workspace_path: Some(path.to_owned()),
        remote_connection_id: connection_id.map(str::to_owned),
        remote_ssh_host: ssh_host.map(str::to_owned),
        ..Default::default()
    };
    crate::agentic::workspace::normalize_session_workspace(&mut config)
        .await
        .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error.to_string()))?;
    WorkspaceBinding::resolve(
        config.workspace_id.as_deref().ok_or_else(|| {
            PortError::new(PortErrorKind::InvalidRequest, "Workspace ID is required")
        })?,
    )
    .await
    .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error.to_string()))
}

#[cfg(test)]
mod history_workspace_identity_tests {
    use super::resolve_history_workspace;
    use crate::service::workspace::legacy_compat::{
        register_local_fixture, register_remote_fixture,
    };

    #[tokio::test]
    async fn history_routing_uses_ids_even_with_colliding_roots_and_stale_transport_fields() {
        let temp = tempfile::tempdir().unwrap();
        let local = register_local_fixture(temp.path(), None).await;
        let remote = register_remote_fixture(
            &local.root_path.to_string_lossy(),
            "history-test-ssh",
            "history.example",
        )
        .await;
        let binding = resolve_history_workspace(
            Some(&local.id),
            "/obsolete/path",
            Some("history-test-ssh"),
            Some("history.example"),
        )
        .await
        .unwrap();
        assert!(!binding.is_remote());
        assert_eq!(binding.root_path, local.root_path);
        assert_eq!(binding.workspace_id.as_deref(), Some(local.id.as_str()));
        let binding = resolve_history_workspace(Some(&remote.id), "/obsolete/path", None, None)
            .await
            .unwrap();
        assert!(binding.is_remote());
        assert_eq!(binding.connection_id(), Some("history-test-ssh"));
        assert!(resolve_history_workspace(
            Some("unavailable-id"),
            &local.root_path.to_string_lossy(),
            None,
            None
        )
        .await
        .is_err());
    }
}
