//! CLI/TUI Agent Runtime SDK client.
//!
//! Keeps CLI session state while product operations remain behind portable
//! Runtime SDK ports.
//! Event consumption is NOT done here — it's done in the chat/exec mode main loops.

use anyhow::Result;
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tokio::sync::{broadcast, Mutex};

use openbitfun_agent_runtime::sdk::{
    AgentContextReloadPort, AgentDialogSteerRequest, AgentDialogTurnExecution,
    AgentDialogTurnRequest, AgentEventReceiver, AgentInputAttachment,
    AgentMessageWorkspaceReferencesRequest, AgentRuntime, AgentSessionCompactionRequest,
    AgentSessionCreateRequest, AgentSessionDeleteRequest, AgentSessionForkBeforeTurnRequest,
    AgentSessionForkRequest, AgentSessionForkResult, AgentSessionLineageCancellationRequest,
    AgentSessionLineageInspection, AgentSessionLineageRequest, AgentSessionLineageSnapshot,
    AgentSessionLineageTranscriptRequest, AgentSessionListRequest, AgentSessionModeUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSessionRenameRequest, AgentSessionRestoreRequest,
    AgentSessionRevertRequest, AgentSessionRevertResult, AgentSessionUsageRequest,
    AgentTurnCancellationRequest, AgentTurnSettlementRequest, AgentUserAnswersRequest,
    AgentUserShellCommandRequest, AgentWorkspaceReference, AgentWorkspaceReferenceSearchRequest,
    AgentWorkspaceReferenceSearchResult, DialogSteerOutcome, PermissionReply, PermissionRequest,
    PermissionRequestEventReceiver, PortError, PortErrorKind, RuntimeError, SessionTranscript,
    SessionTranscriptRequest, SessionUsageReport, WorkspaceDiffSnapshot,
};
use openbitfun_agent_runtime_ipc::{
    RuntimeIpcClient, RuntimeIpcClientError, RuntimeIpcClientEvent, RuntimeIpcErrorCode,
    RuntimeIpcEvent, RuntimeIpcOperation, RuntimeIpcOperationResult,
    RuntimeIpcStreamInvalidationReason, RuntimeSessionForkRequest, RuntimeSessionRenameRequest,
    RuntimeSessionRestoreRequest, RuntimeUserAnswersRequest,
};
use openbitfun_events::{AgenticEvent, AgenticEventEnvelope};
use openbitfun_runtime_ports::{
    put_agent_workspace_references, AgentContextReloadRequest, AgentModeCatalogQuery,
    AgentSessionSummary, AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest,
    AgentSubmissionSource, DialogSubmissionPolicy, SessionExecutionTarget,
};

use crate::actions::SHARED_TUI_EMBEDDED_HANDOFF;
use crate::diagnostics::with_session_conflict_help;
use crate::runtime::approval::{approval_metadata, CliApprovalPolicy};
use crate::runtime::CliRuntimeContext;

async fn upgrade_shared_workspace_binding(
    binding: AgentSessionWorkspaceBinding,
) -> Result<AgentSessionWorkspaceBinding> {
    if binding.workspace_id.is_some()
        && binding.project_workspace_id.is_some()
        && binding.workspace_kind.is_some()
    {
        return Ok(binding);
    }
    let service =
        openbitfun_core::service::workspace::get_global_workspace_service().ok_or_else(|| {
            anyhow::anyhow!("Workspace service is unavailable for legacy Runtime binding upgrade")
        })?;
    service
        .upgrade_legacy_session_binding(binding)
        .await
        .map_err(Into::into)
}

fn shared_restore_error(error: RuntimeIpcClientError) -> anyhow::Error {
    let error = if matches!(&error, RuntimeIpcClientError::Remote(remote) if remote.code == RuntimeIpcErrorCode::FrameTooLarge)
    {
        anyhow::anyhow!(
            "Session history is too large for Shared TUI. {SHARED_TUI_EMBEDDED_HANDOFF}."
        )
    } else {
        anyhow::Error::new(error)
    };
    with_session_conflict_help(error)
}

fn runtime_error_from_ipc(error: RuntimeIpcClientError) -> RuntimeError {
    let kind = match &error {
        RuntimeIpcClientError::Remote(remote) => match remote.code {
            RuntimeIpcErrorCode::InvalidRequest => PortErrorKind::InvalidRequest,
            RuntimeIpcErrorCode::Unauthorized => PortErrorKind::PermissionDenied,
            RuntimeIpcErrorCode::NotFound => PortErrorKind::NotFound,
            RuntimeIpcErrorCode::SessionInUse
            | RuntimeIpcErrorCode::ControllerRequired
            | RuntimeIpcErrorCode::SessionMismatch => PortErrorKind::SessionInUse,
            RuntimeIpcErrorCode::OutcomeUnknown => PortErrorKind::OutcomeUnknown,
            RuntimeIpcErrorCode::OperationUnsupported
            | RuntimeIpcErrorCode::Unavailable
            | RuntimeIpcErrorCode::IncompatibleProtocol
            | RuntimeIpcErrorCode::WrongInstance => PortErrorKind::NotAvailable,
            RuntimeIpcErrorCode::FrameTooLarge | RuntimeIpcErrorCode::Internal => {
                PortErrorKind::Backend
            }
        },
        RuntimeIpcClientError::Timeout
        | RuntimeIpcClientError::Disconnected
        | RuntimeIpcClientError::UnexpectedResponse
        | RuntimeIpcClientError::Io(_) => PortErrorKind::OutcomeUnknown,
        RuntimeIpcClientError::InvalidClientIdentity
        | RuntimeIpcClientError::InvalidTimeout
        | RuntimeIpcClientError::RequestEncoding(_) => PortErrorKind::InvalidRequest,
        RuntimeIpcClientError::IncompatibleProtocol { .. } => PortErrorKind::NotAvailable,
        RuntimeIpcClientError::RequestIdExhausted | RuntimeIpcClientError::Transport(_) => {
            PortErrorKind::Backend
        }
    };
    RuntimeError::Port(PortError::new(kind, error.to_string()))
}

fn validated_session_summary(
    sessions: &[AgentSessionSummary],
    session_id: &str,
    workspace_path: &Path,
) -> Result<AgentSessionSummary> {
    sessions
        .iter()
        .find(|summary| summary.session_id == session_id)
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Session {session_id} was not found in the current workspace: {}",
                workspace_path.display()
            )
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionMigrationNotice {
    Mode {
        previous_id: String,
        restored_id: String,
    },
    Model {
        previous_id: String,
        restored_id: String,
    },
}

impl SessionMigrationNotice {
    pub(crate) fn user_message(&self) -> String {
        let (setting, previous_id, restored_id) = match self {
            Self::Mode {
                previous_id,
                restored_id,
            } => ("mode", previous_id, restored_id),
            Self::Model {
                previous_id,
                restored_id,
            } => ("model", previous_id, restored_id),
        };
        format!(
            "Session {setting} \"{previous_id}\" is unavailable. This session was restored with \"{restored_id}\". Review the {setting} before continuing."
        )
    }
}

fn session_migration_notices(
    previous: &AgentSessionSummary,
    restored: &AgentSessionSummary,
) -> Vec<SessionMigrationNotice> {
    let mut notices = Vec::with_capacity(2);
    if previous.agent_type != restored.agent_type {
        notices.push(SessionMigrationNotice::Mode {
            previous_id: previous.agent_type.clone(),
            restored_id: restored.agent_type.clone(),
        });
    }
    if let (Some(previous_id), Some(restored_id)) =
        (previous.model_id.as_ref(), restored.model_id.as_ref())
    {
        if previous_id != restored_id {
            notices.push(SessionMigrationNotice::Model {
                previous_id: previous_id.clone(),
                restored_id: restored_id.clone(),
            });
        }
    }
    notices
}

#[derive(Debug)]
pub(crate) struct SessionOperationError {
    message: String,
    outcome_unknown: bool,
}

impl fmt::Display for SessionOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionOperationError {}

impl SessionOperationError {
    fn runtime(error: RuntimeError) -> Self {
        let outcome_unknown = matches!(
            &error,
            RuntimeError::Port(port_error)
                if port_error.kind == PortErrorKind::OutcomeUnknown
        );
        Self {
            message: error.into_message(),
            outcome_unknown,
        }
    }

    fn shared(error: RuntimeIpcClientError) -> Self {
        let outcome_unknown = matches!(
            &error,
            RuntimeIpcClientError::Remote(remote)
                if remote.code == RuntimeIpcErrorCode::OutcomeUnknown
        ) || matches!(
            &error,
            RuntimeIpcClientError::Timeout
                | RuntimeIpcClientError::Disconnected
                | RuntimeIpcClientError::UnexpectedResponse
                | RuntimeIpcClientError::Io(_)
        );
        Self {
            message: error.to_string(),
            outcome_unknown,
        }
    }

    fn unexpected(error: anyhow::Error) -> Self {
        Self {
            message: error.to_string(),
            outcome_unknown: true,
        }
    }

    fn read_only_shared(error: RuntimeIpcClientError) -> Self {
        let outcome_unknown = matches!(
            &error,
            RuntimeIpcClientError::Remote(remote)
                if remote.code == RuntimeIpcErrorCode::OutcomeUnknown
        );
        Self {
            message: shared_restore_error(error).to_string(),
            outcome_unknown,
        }
    }

    fn read_only_unexpected(error: anyhow::Error) -> Self {
        Self {
            message: error.to_string(),
            outcome_unknown: false,
        }
    }

    pub(crate) fn outcome_unknown(&self) -> bool {
        self.outcome_unknown
    }
}

#[derive(Clone, Debug)]
struct CliWorkspacePaths {
    workspace_kind: Option<openbitfun_core::service::workspace::WorkspaceKind>,
    project_workspace_id: Option<String>,
    workspace_id: Option<String>,
    project: Option<PathBuf>,
    execution: Option<PathBuf>,
    execution_target: Option<SessionExecutionTarget>,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
}

impl CliWorkspacePaths {
    fn new(workspace_path: Option<PathBuf>) -> Self {
        Self {
            workspace_kind: None,
            project_workspace_id: None,
            workspace_id: None,
            project: workspace_path.clone(),
            execution: workspace_path,
            execution_target: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        }
    }

    fn execution(&self) -> PathBuf {
        self.execution
            .clone()
            .or_else(|| self.project.clone())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn project(&self) -> PathBuf {
        self.project
            .clone()
            .or_else(|| self.execution.clone())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn apply_binding(&mut self, binding: &AgentSessionWorkspaceBinding) {
        self.workspace_kind = binding.workspace_kind.clone();
        self.project_workspace_id = binding.project_workspace_id.clone();
        self.workspace_id = binding.workspace_id.clone();
        let execution = PathBuf::from(&binding.workspace_path);
        let project = binding
            .project_workspace_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.project());
        self.execution = Some(execution);
        self.project = Some(project);
        self.execution_target = binding.execution_target.clone();
        self.remote_connection_id = binding.remote_connection_id.clone();
        self.remote_ssh_host = binding.remote_ssh_host.clone();
    }

    fn binding(&self) -> AgentSessionWorkspaceBinding {
        let execution = self.execution();
        AgentSessionWorkspaceBinding {
            workspace_kind: self.workspace_kind.clone(),
            project_workspace_id: self.project_workspace_id.clone(),
            workspace_id: self.workspace_id.clone(),
            workspace_path: execution.to_string_lossy().to_string(),
            project_workspace_path: Some(self.project().to_string_lossy().to_string()),
            execution_target: self.execution_target.clone().or_else(|| {
                Some(SessionExecutionTarget::local(
                    execution.to_string_lossy().to_string(),
                ))
            }),
            remote_connection_id: self.remote_connection_id.clone(),
            remote_ssh_host: self.remote_ssh_host.clone(),
        }
    }

    fn reset_execution_to_project(&mut self) -> PathBuf {
        let project = self.project();
        self.execution = Some(project.clone());
        self.execution_target = Some(SessionExecutionTarget::local(
            project.to_string_lossy().to_string(),
        ));
        self.workspace_id = self.project_workspace_id.clone();
        self.remote_connection_id = None;
        self.remote_ssh_host = None;
        project
    }

    fn workspace_diff_unavailable_reason(&self) -> Option<&'static str> {
        if self.workspace_id.is_none()
            || self.project_workspace_id.is_none()
            || self.workspace_kind.is_none()
        {
            return Some("Workspace diff is unavailable until workspace identity is resolved");
        }
        if self.workspace_kind == Some(openbitfun_core::service::workspace::WorkspaceKind::Remote) {
            return Some("Workspace diff is unavailable for remote Sessions");
        }
        if self.workspace_id != self.project_workspace_id {
            return Some(
                "Workspace diff is unavailable when the Session uses a different worktree",
            );
        }
        None
    }
}

/// CLI-owned client for the portable Agent Runtime SDK.
/// Stateless regarding agent_type; callers pass it per call.
pub(crate) struct CliAgentRuntimeClient {
    backend: CliAgentRuntimeBackend,
    context_reload: Option<Arc<dyn AgentContextReloadPort>>,
    approval_policy: Arc<RwLock<CliApprovalPolicy>>,
    workspace_paths: Arc<RwLock<CliWorkspacePaths>>,
    /// Session ID — uses Mutex for interior mutability
    session_id: Arc<Mutex<Option<String>>>,
    /// Current turn ID (for cancellation)
    current_turn_id: Arc<Mutex<Option<String>>>,
    shared_agent_events: Option<SharedBroadcast<AgenticEventEnvelope>>,
    shared_permission_events:
        Option<SharedBroadcast<openbitfun_agent_runtime::sdk::PermissionRequestEvent>>,
    shared_pending_permissions: Arc<RwLock<HashMap<String, PermissionRequest>>>,
}

enum CliAgentRuntimeBackend {
    Embedded(AgentRuntime),
    Shared(RuntimeIpcClient),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliAgentMode {
    pub(crate) id: String,
    pub(crate) route_key: String,
    pub(crate) description: String,
    pub(crate) model_id: Option<String>,
    pub(crate) is_external: bool,
}

type SharedBroadcast<T> = Arc<RwLock<Option<broadcast::Sender<T>>>>;

impl CliAgentRuntimeClient {
    /// The runtime's activated workspace record is the only workspace
    /// identity; its root path is read from that record, never passed in.
    pub(crate) fn new(runtime: &CliRuntimeContext) -> Self {
        let mut paths = CliWorkspacePaths::new(Some(runtime.workspace().root_path.clone()));
        paths.workspace_id = Some(runtime.workspace().id.clone());
        paths.project_workspace_id = Some(runtime.workspace().id.clone());
        paths.workspace_kind = Some(runtime.workspace().workspace_kind.clone());
        Self {
            backend: CliAgentRuntimeBackend::Embedded(runtime.agent_runtime().clone()),
            context_reload: Some(Arc::new(runtime.compatibility().clone())),
            approval_policy: Arc::new(RwLock::new(runtime.approval_policy())),
            workspace_paths: Arc::new(RwLock::new(paths)),
            session_id: Arc::new(Mutex::new(None)),
            current_turn_id: Arc::new(Mutex::new(None)),
            shared_agent_events: None,
            shared_permission_events: None,
            shared_pending_permissions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) fn new_shared(
        client: RuntimeIpcClient,
        workspace: &openbitfun_core::service::workspace::WorkspaceInfo,
    ) -> Self {
        let mut paths = CliWorkspacePaths::new(Some(workspace.root_path.clone()));
        paths.workspace_id = Some(workspace.id.clone());
        paths.project_workspace_id = Some(workspace.id.clone());
        paths.workspace_kind = Some(workspace.workspace_kind.clone());
        let (agent_sender, _) = broadcast::channel(256);
        let (permission_sender, _) = broadcast::channel(64);
        let shared_agent_events = Arc::new(RwLock::new(Some(agent_sender.clone())));
        let shared_permission_events = Arc::new(RwLock::new(Some(permission_sender.clone())));
        let shared_pending_permissions = Arc::new(RwLock::new(HashMap::new()));
        let session_id = Arc::new(Mutex::new(None));
        spawn_shared_event_bridge(
            client.subscribe_events(),
            agent_sender,
            permission_sender,
            shared_agent_events.clone(),
            shared_permission_events.clone(),
            shared_pending_permissions.clone(),
        );
        Self {
            backend: CliAgentRuntimeBackend::Shared(client),
            context_reload: None,
            approval_policy: Arc::new(RwLock::new(CliApprovalPolicy::Ask)),
            workspace_paths: Arc::new(RwLock::new(paths)),
            session_id,
            current_turn_id: Arc::new(Mutex::new(None)),
            shared_agent_events: Some(shared_agent_events),
            shared_permission_events: Some(shared_permission_events),
            shared_pending_permissions,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_embedded_for_test(
        runtime: AgentRuntime,
        workspace_path: Option<PathBuf>,
        workspace_id: Option<String>,
    ) -> Self {
        let mut paths = CliWorkspacePaths::new(workspace_path);
        paths.workspace_id = workspace_id.clone();
        paths.project_workspace_id = workspace_id;
        paths.workspace_kind = paths
            .workspace_id
            .is_some()
            .then_some(openbitfun_core::service::workspace::WorkspaceKind::Normal);
        Self {
            backend: CliAgentRuntimeBackend::Embedded(runtime),
            context_reload: None,
            approval_policy: Arc::new(RwLock::new(CliApprovalPolicy::Ask)),
            workspace_paths: Arc::new(RwLock::new(paths)),
            session_id: Arc::new(Mutex::new(None)),
            current_turn_id: Arc::new(Mutex::new(None)),
            shared_agent_events: None,
            shared_permission_events: None,
            shared_pending_permissions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) fn is_shared(&self) -> bool {
        matches!(self.backend, CliAgentRuntimeBackend::Shared(_))
    }

    /// Read the main-agent catalog from the execution owner. Embedded and
    /// Shared TUI expose the same small presentation projection; Shared never
    /// consults the controller process's local registry.
    pub(crate) async fn available_agent_modes(&self) -> Result<Vec<CliAgentMode>> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => {
                let binding = self.current_workspace_binding();
                if let Err(error) = self.ensure_embedded_plugin_workspace_ready(&binding).await {
                    tracing::warn!(
                        "Configured plugin activation failed while loading agent modes; continuing with native agents: {}",
                        error
                    );
                }
                if let Err(error) =
                    openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(
                        binding.workspace_id.as_deref(),
                    )
                    .await
                {
                    tracing::warn!("Failed to initialize external agent sources: {error}");
                }
                runtime
                    .list_agent_modes(AgentModeCatalogQuery {
                        workspace_id: binding.workspace_id.clone(),
                        workspace_root: None,
                        include_external: true,
                    })
                    .await
                    .map(|modes| {
                        modes
                            .into_iter()
                            .map(|mode| CliAgentMode {
                                id: mode.id,
                                route_key: mode.route_key,
                                description: mode.description,
                                model_id: mode.model_id,
                                is_external: mode.is_external,
                            })
                            .collect()
                    })
                    .map_err(|error| anyhow::anyhow!(error.into_message()))
            }
            CliAgentRuntimeBackend::Shared(client) => {
                let session_id = self.session_id.lock().await.clone();
                match client
                    .request(RuntimeIpcOperation::ListAgentModes { session_id })
                    .await?
                {
                    RuntimeIpcOperationResult::AgentModes { modes } => Ok(modes
                        .into_iter()
                        .map(|mode| CliAgentMode {
                            id: mode.id,
                            route_key: mode.route_key,
                            description: mode.description,
                            model_id: mode.model_id,
                            is_external: mode.is_external,
                        })
                        .collect()),
                    other => Err(anyhow::anyhow!(
                    "Shared Runtime returned an unexpected result for list_agent_modes: {other:?}"
                )),
                }
            }
        }
    }

    fn embedded_runtime(&self, operation: &str) -> Result<&AgentRuntime> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => Ok(runtime),
            CliAgentRuntimeBackend::Shared(_) => Err(anyhow::anyhow!(
                "{operation} is not available in the first Shared TUI slice; use default Embedded `openbitfun chat`"
            )),
        }
    }

    pub(crate) fn subscribe_events(&self) -> std::result::Result<AgentEventReceiver, RuntimeError> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime.subscribe_events(),
            CliAgentRuntimeBackend::Shared(_) => shared_receiver(
                self.shared_agent_events.as_ref(),
                "Shared Runtime agent event stream is unavailable",
            ),
        }
    }

    pub(crate) fn subscribe_permission_requests(
        &self,
    ) -> std::result::Result<PermissionRequestEventReceiver, RuntimeError> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime.subscribe_permission_requests(),
            CliAgentRuntimeBackend::Shared(_) => shared_receiver(
                self.shared_permission_events.as_ref(),
                "Shared Runtime permission event stream is unavailable",
            ),
        }
    }

    pub(crate) fn pending_permission_requests(
        &self,
    ) -> std::result::Result<Vec<PermissionRequest>, RuntimeError> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime.pending_permission_requests(),
            CliAgentRuntimeBackend::Shared(_) => Ok(self
                .shared_pending_permissions
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .values()
                .cloned()
                .collect()),
        }
    }

    pub(crate) async fn respond_permission(
        &self,
        request_id: &str,
        reply: PermissionReply,
    ) -> Result<()> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .respond_permission(request_id, reply)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => {
                let session_id = self.require_session_id().await?;
                expect_unit(
                    client
                        .request(RuntimeIpcOperation::RespondPermission {
                            session_id,
                            request_id: request_id.to_string(),
                            reply,
                        })
                        .await?,
                    "respond_permission",
                )
            }
        }
    }

    pub(crate) fn set_approval_policy(&self, policy: CliApprovalPolicy) {
        *self
            .approval_policy
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = policy;
    }

    pub(crate) fn approval_policy(&self) -> CliApprovalPolicy {
        *self
            .approval_policy
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn workspace_path_buf(&self) -> PathBuf {
        self.workspace_paths
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execution()
    }

    pub(crate) fn workspace_id(&self) -> Option<String> {
        self.current_workspace_binding().workspace_id
    }

    pub(crate) fn workspace_path_string(&self) -> String {
        self.workspace_path_buf().to_string_lossy().to_string()
    }

    pub(crate) fn project_workspace_path_buf(&self) -> PathBuf {
        self.workspace_paths
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .project()
    }

    pub(crate) fn project_workspace_path_string(&self) -> String {
        self.project_workspace_path_buf()
            .to_string_lossy()
            .to_string()
    }

    pub(crate) fn set_workspace_binding(&self, binding: &AgentSessionWorkspaceBinding) {
        self.workspace_paths
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .apply_binding(binding);
    }

    fn current_workspace_binding(&self) -> AgentSessionWorkspaceBinding {
        self.workspace_paths
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .binding()
    }

    pub(crate) fn is_remote_workspace(&self) -> bool {
        self.current_workspace_binding().workspace_kind
            == Some(openbitfun_core::service::workspace::WorkspaceKind::Remote)
    }

    fn execution_target(&self) -> Option<SessionExecutionTarget> {
        self.workspace_paths
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execution_target
            .clone()
    }

    fn reset_execution_to_project_workspace(&self) -> PathBuf {
        self.workspace_paths
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset_execution_to_project()
    }

    fn current_workspace_path(&self) -> PathBuf {
        self.project_workspace_path_buf()
    }

    async fn list_sessions_in_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AgentSessionSummary>> {
        let request = AgentSessionListRequest {
            workspace_id: Some(workspace_id.to_owned()),
            workspace_path: String::new(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .list_sessions(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(if client.capabilities().workspace_id_references {
                    RuntimeIpcOperation::ListSessions { request }
                } else {
                    openbitfun_agent_runtime_ipc::legacy_workspace_operation(
                        RuntimeIpcOperation::ListSessions { request },
                        &self.project_workspace_path_buf().to_string_lossy(),
                    )
                })
                .await?
            {
                RuntimeIpcOperationResult::Sessions { sessions } => Ok(sessions),
                _ => Err(unexpected_shared_result("list_sessions")),
            },
        }
    }

    pub(crate) async fn list_sessions(&self) -> Result<Vec<AgentSessionSummary>> {
        let id = self
            .current_workspace_binding()
            .project_workspace_id
            .ok_or_else(|| anyhow::anyhow!("Project workspace ID is unavailable"))?;
        self.list_sessions_in_workspace(&id).await
    }

    pub(crate) async fn session_lineage(
        &self,
        root_session_id: &str,
    ) -> Result<Option<AgentSessionLineageSnapshot>> {
        let request = AgentSessionLineageRequest {
            workspace_id: self
                .workspace_paths
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .workspace_id
                .clone(),
            workspace_path: self.current_workspace_path().to_string_lossy().into_owned(),
            anchor_session_id: root_session_id.to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .get_session_lineage(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::GetSessionLineage { request })
                .await?
            {
                RuntimeIpcOperationResult::SessionLineage { snapshot } => Ok(snapshot),
                _ => Err(unexpected_shared_result("get_session_lineage")),
            },
        }
    }

    pub(crate) async fn inspect_lineage_session(
        &self,
        root_session_id: &str,
        session_id: &str,
        required_settled_turn_ids: &[String],
    ) -> std::result::Result<AgentSessionLineageInspection, SessionOperationError> {
        let request = AgentSessionLineageTranscriptRequest {
            workspace_id: self.workspace_id(),
            workspace_path: self.current_workspace_path().to_string_lossy().into_owned(),
            root_session_id: root_session_id.to_string(),
            session_id: session_id.to_string(),
            required_settled_turn_ids: required_settled_turn_ids.to_vec(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .read_lineage_session_transcript(request)
                .await
                .map_err(SessionOperationError::runtime),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::InspectLineageSession { request })
                .await
                .map_err(SessionOperationError::read_only_shared)?
            {
                RuntimeIpcOperationResult::LineageSessionInspection { inspection } => {
                    Ok(inspection)
                }
                _ => Err(SessionOperationError::read_only_unexpected(
                    unexpected_shared_result("inspect_lineage_session"),
                )),
            },
        }
    }

    pub(crate) async fn cancel_lineage_session(
        &self,
        root_session_id: &str,
        session_id: &str,
        expected_active_turn_id: &str,
    ) -> Result<openbitfun_agent_runtime::sdk::AgentTurnCancellationResult> {
        let request = AgentSessionLineageCancellationRequest {
            workspace_id: self.workspace_id(),
            workspace_path: self.current_workspace_path().to_string_lossy().into_owned(),
            root_session_id: root_session_id.to_string(),
            session_id: session_id.to_string(),
            expected_active_turn_id: Some(expected_active_turn_id.to_string()),
            source: Some(AgentSubmissionSource::Cli),
            reason: Some("user_cancelled".to_string()),
            wait_timeout_ms: Some(5_000),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .cancel_lineage_session(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::CancelLineageSession { request })
                .await?
            {
                RuntimeIpcOperationResult::TurnCancelled { cancellation } => Ok(cancellation),
                _ => Err(unexpected_shared_result("cancel_lineage_session")),
            },
        }
    }

    pub(crate) async fn restore_session_in_current_workspace(
        &self,
        session_id: &str,
    ) -> Result<(
        AgentSessionSummary,
        AgentSessionWorkspaceBinding,
        Vec<SessionMigrationNotice>,
        SessionTranscript,
    )> {
        tracing::info!("Restoring session: {}", session_id);

        let project_workspace = self.current_workspace_path();
        let sessions = self.list_sessions().await?;
        let previous_summary =
            validated_session_summary(&sessions, session_id, &project_workspace)?;

        let (restored, transcript, restored_turn_id, shared_pending, shared_workspace_binding) =
            match &self.backend {
                CliAgentRuntimeBackend::Embedded(runtime) => {
                    let restored = runtime
                        .restore_session(AgentSessionRestoreRequest {
                            workspace_id: self.workspace_id(),
                            workspace_path: project_workspace.to_string_lossy().to_string(),
                            session_id: session_id.to_string(),
                            include_internal: false,
                            remote_connection_id: None,
                            remote_ssh_host: None,
                        })
                        .await
                        .map_err(anyhow::Error::new)
                        .map_err(with_session_conflict_help)?;
                    let restored_turn_id = match &restored.state {
                        openbitfun_agent_runtime::sdk::SessionState::Processing {
                            current_turn_id,
                            ..
                        } => Some(current_turn_id.clone()),
                        openbitfun_agent_runtime::sdk::SessionState::Idle
                        | openbitfun_agent_runtime::sdk::SessionState::Error { .. } => None,
                    };
                    let transcript = runtime
                        .read_session_transcript(SessionTranscriptRequest {
                            session_id: session_id.to_string(),
                            turn_id: None,
                        })
                        .await
                        .unwrap_or_else(|error| {
                            tracing::warn!(
                                "Failed to read Embedded session transcript: {}",
                                error.into_message()
                            );
                            SessionTranscript {
                                session_id: session_id.to_string(),
                                messages: Vec::new(),
                            }
                        });
                    (restored.session, transcript, restored_turn_id, None, None)
                }
                CliAgentRuntimeBackend::Shared(client) => match client
                    .request({
                        let operation = RuntimeIpcOperation::RestoreSession {
                            request: RuntimeSessionRestoreRequest {
                                workspace_id: self.workspace_id(),
                                workspace_path: String::new(),
                                session_id: session_id.to_string(),
                            },
                        };
                        if client.capabilities().workspace_id_references {
                            operation
                        } else {
                            openbitfun_agent_runtime_ipc::legacy_workspace_operation(
                                operation,
                                &project_workspace.to_string_lossy(),
                            )
                        }
                    })
                    .await
                    .map_err(shared_restore_error)?
                {
                    RuntimeIpcOperationResult::SessionRestored {
                        session,
                        state,
                        workspace_binding,
                        transcript,
                        pending_permissions,
                        ..
                    } => {
                        let restored_turn_id = match state {
                            openbitfun_agent_runtime_ipc::RuntimeSessionState::Processing {
                                current_turn_id,
                                ..
                            } => Some(current_turn_id),
                            openbitfun_agent_runtime_ipc::RuntimeSessionState::Idle
                            | openbitfun_agent_runtime_ipc::RuntimeSessionState::Error { .. } => {
                                None
                            }
                        };
                        (
                            session,
                            transcript,
                            restored_turn_id,
                            Some(pending_permissions),
                            Some(workspace_binding),
                        )
                    }
                    _ => return Err(unexpected_shared_result("restore_session")),
                },
            };

        let binding = if let Some(binding) = shared_workspace_binding {
            let binding = upgrade_shared_workspace_binding(binding).await?;
            self.set_workspace_binding(&binding);
            binding
        } else {
            self.resolve_session_workspace_binding(session_id).await?
        };
        self.ensure_embedded_plugin_workspace_ready(&binding)
            .await?;
        let mut session_id_guard = self.session_id.lock().await;
        let mut turn_id_guard = self.current_turn_id.lock().await;
        *session_id_guard = Some(session_id.to_string());
        *turn_id_guard = restored_turn_id;
        drop(session_id_guard);
        drop(turn_id_guard);
        if let Some(requests) = shared_pending {
            let mut pending = self
                .shared_pending_permissions
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.clear();
            pending.extend(
                requests
                    .into_iter()
                    .map(|request| (request.request_id.clone(), request)),
            );
        }

        let migration_notices = session_migration_notices(&previous_summary, &restored);
        Ok((restored, binding, migration_notices, transcript))
    }

    async fn resolve_session_workspace_binding(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionWorkspaceBinding> {
        let resolved = match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                    session_id: session_id.to_string(),
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?,
            CliAgentRuntimeBackend::Shared(_) => None,
        };
        let binding = resolved.ok_or_else(|| {
            anyhow::anyhow!("Session {session_id} has no resolved workspace binding")
        })?;

        self.set_workspace_binding(&binding);
        Ok(binding)
    }

    pub(crate) async fn session_workspace_binding(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionWorkspaceBinding> {
        if self.session_id.lock().await.as_deref() == Some(session_id) {
            return Ok(self
                .workspace_paths
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .binding());
        }
        if self.is_shared() {
            return Err(anyhow::anyhow!("Session {session_id} is not attached"));
        }
        self.resolve_session_workspace_binding(session_id).await
    }

    pub(crate) async fn reload_context(&self, request: AgentContextReloadRequest) -> Result<()> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(_) => {
                let context_reload = self
                    .context_reload
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("session context reload is unavailable"))?;
                context_reload
                    .reload_session_context(request)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))
            }
            CliAgentRuntimeBackend::Shared(client) => expect_unit(
                client
                    .request(RuntimeIpcOperation::ReloadSessionContext { request })
                    .await?,
                "reload_session_context",
            ),
        }
    }

    async fn ensure_embedded_plugin_workspace_ready(
        &self,
        binding: &AgentSessionWorkspaceBinding,
    ) -> Result<()> {
        if matches!(&self.backend, CliAgentRuntimeBackend::Shared(_)) {
            return Ok(());
        }
        crate::plugin_host_activation::ensure_plugin_workspace_ready(binding)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }

    async fn ensure_embedded_plugin_session_ready(&self, session_id: &str) -> Result<()> {
        if matches!(&self.backend, CliAgentRuntimeBackend::Shared(_)) {
            return Ok(());
        }
        // Session creation holds session_id until activation has completed.
        // Resolve directly instead of re-locking that non-reentrant mutex.
        let binding = self.resolve_session_workspace_binding(session_id).await?;
        self.ensure_embedded_plugin_workspace_ready(&binding).await
    }

    pub(crate) async fn delete_session(
        &self,
        session_id: &str,
    ) -> std::result::Result<(), SessionOperationError> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .delete_session(AgentSessionDeleteRequest {
                    workspace_id: self.workspace_id(),
                    workspace_path: self.project_workspace_path_string(),
                    session_id: session_id.to_string(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .map_err(SessionOperationError::runtime),
            CliAgentRuntimeBackend::Shared(client) => {
                let result = client
                    .request(RuntimeIpcOperation::DeleteSession {
                        session_id: session_id.to_string(),
                    })
                    .await
                    .map_err(SessionOperationError::shared)?;
                expect_unit(result, "delete_session").map_err(SessionOperationError::unexpected)
            }
        }
    }

    pub(crate) async fn update_session_model(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> std::result::Result<(), SessionOperationError> {
        let request = AgentSessionModelUpdateRequest {
            session_id: session_id.to_string(),
            model_id: model_id.to_string(),
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .update_session_model(request)
                .await
                .map_err(SessionOperationError::runtime),
            CliAgentRuntimeBackend::Shared(client) => {
                let result = client
                    .request(RuntimeIpcOperation::UpdateSessionModel { request })
                    .await
                    .map_err(SessionOperationError::shared)?;
                expect_unit(result, "update_session_model")
                    .map_err(SessionOperationError::unexpected)
            }
        }
    }

    pub(crate) async fn rename_session(
        &self,
        session_id: &str,
        session_name: &str,
    ) -> std::result::Result<(), SessionOperationError> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => {
                let request = AgentSessionRenameRequest {
                    workspace_id: self.workspace_id(),
                    workspace_path: self.project_workspace_path_string(),
                    session_id: session_id.to_string(),
                    session_name: session_name.to_string(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                };
                runtime
                    .rename_session(request)
                    .await
                    .map_err(SessionOperationError::runtime)
            }
            CliAgentRuntimeBackend::Shared(client) => {
                let result = client
                    .request(RuntimeIpcOperation::RenameSession {
                        request: RuntimeSessionRenameRequest {
                            session_id: session_id.to_string(),
                            session_name: session_name.to_string(),
                        },
                    })
                    .await
                    .map_err(SessionOperationError::shared)?;
                expect_unit(result, "rename_session").map_err(SessionOperationError::unexpected)
            }
        }
    }

    pub(crate) async fn update_session_mode(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> std::result::Result<(), SessionOperationError> {
        self.update_session_mode_with_route(session_id, mode_id, None)
            .await
    }

    pub(crate) async fn update_session_mode_with_route(
        &self,
        session_id: &str,
        mode_id: &str,
        route_key: Option<&str>,
    ) -> std::result::Result<(), SessionOperationError> {
        let request = AgentSessionModeUpdateRequest {
            session_id: session_id.to_string(),
            mode_id: mode_id.to_string(),
            agent_route_key: route_key.map(str::to_string),
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .update_session_mode(request)
                .await
                .map_err(SessionOperationError::runtime),
            CliAgentRuntimeBackend::Shared(client) => {
                let result = client
                    .request(RuntimeIpcOperation::UpdateSessionMode { request })
                    .await
                    .map_err(SessionOperationError::shared)?;
                expect_unit(result, "update_session_mode")
                    .map_err(SessionOperationError::unexpected)
            }
        }
    }

    pub(crate) async fn branch_session_at_latest_turn(
        &self,
        source_session_id: &str,
    ) -> Result<AgentSessionForkResult> {
        self.embedded_runtime("forking sessions")?
            .fork_session(AgentSessionForkRequest {
                workspace_id: self.workspace_id(),
                workspace_path: String::new(),
                source_session_id: source_session_id.to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.into_message()))
    }

    pub(crate) async fn fork_current_session(
        &self,
        before_turn_id: Option<&str>,
    ) -> Result<(
        AgentSessionSummary,
        AgentSessionWorkspaceBinding,
        SessionTranscript,
    )> {
        let source_session_id = self.require_session_id().await?;
        let workspace_path = self.project_workspace_path_string();
        let (session, transcript, shared_workspace_binding) = match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => {
                let forked = match before_turn_id {
                    Some(source_turn_id) => {
                        runtime
                            .fork_session_before_turn(AgentSessionForkBeforeTurnRequest {
                                workspace_id: self.workspace_id(),
                                workspace_path: String::new(),
                                source_session_id,
                                source_turn_id: source_turn_id.to_string(),
                                remote_connection_id: None,
                                remote_ssh_host: None,
                            })
                            .await
                    }
                    None => {
                        runtime
                            .fork_session(AgentSessionForkRequest {
                                workspace_id: self.workspace_id(),
                                workspace_path: String::new(),
                                source_session_id,
                                remote_connection_id: None,
                                remote_ssh_host: None,
                            })
                            .await
                    }
                }
                .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                let restored = runtime
                    .restore_session(AgentSessionRestoreRequest {
                        workspace_id: self.workspace_id(),
                        workspace_path: workspace_path.clone(),
                        session_id: forked.session_id.clone(),
                        include_internal: false,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                let transcript = runtime
                    .read_session_transcript(SessionTranscriptRequest {
                        session_id: forked.session_id,
                        turn_id: None,
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                (restored.session, transcript, None)
            }
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::ForkSession {
                    request: RuntimeSessionForkRequest {
                        session_id: source_session_id,
                        before_turn_id: before_turn_id.map(str::to_string),
                    },
                })
                .await?
            {
                RuntimeIpcOperationResult::SessionForked {
                    session,
                    workspace_binding,
                    transcript,
                } => (session, transcript, Some(workspace_binding)),
                _ => return Err(unexpected_shared_result("fork_session")),
            },
        };

        let binding = if let Some(binding) = shared_workspace_binding {
            let binding = upgrade_shared_workspace_binding(binding).await?;
            self.set_workspace_binding(&binding);
            binding
        } else {
            self.resolve_session_workspace_binding(&session.session_id)
                .await?
        };
        self.ensure_embedded_plugin_workspace_ready(&binding)
            .await?;
        *self.session_id.lock().await = Some(session.session_id.clone());
        *self.current_turn_id.lock().await = None;
        self.shared_pending_permissions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        Ok((session, binding, transcript))
    }

    pub(crate) async fn revert_current_session(
        &self,
        undo: bool,
    ) -> Result<AgentSessionRevertResult> {
        let session_id = self.require_session_id().await?;
        let request = AgentSessionRevertRequest {
            workspace_id: self.workspace_id(),
            workspace_path: self.project_workspace_path_string(),
            session_id: session_id.clone(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let locally_active_turn_id = self.current_turn_id.lock().await.clone();
        let mut reverted = match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => if undo {
                runtime.undo_session(request).await
            } else {
                runtime.redo_session(request).await
            }
            .map_err(|error| anyhow::anyhow!(error.into_message()))?,
            CliAgentRuntimeBackend::Shared(client) => {
                let operation = if undo {
                    RuntimeIpcOperation::UndoSession { request }
                } else {
                    RuntimeIpcOperation::RedoSession { request }
                };
                match client.request(operation).await? {
                    RuntimeIpcOperationResult::SessionReverted { revert }
                        if revert.session_id == session_id =>
                    {
                        revert
                    }
                    _ => return Err(unexpected_shared_result("revert_session")),
                }
            }
        };
        if reverted.session_id != session_id {
            return Err(anyhow::anyhow!(
                "Runtime reverted an unexpected session identity"
            ));
        }
        if let Some(turn_id) = locally_active_turn_id {
            if !reverted.retired_turn_ids.contains(&turn_id) {
                reverted.retired_turn_ids.push(turn_id);
            }
        }
        *self.current_turn_id.lock().await = None;
        Ok(reverted)
    }

    pub(crate) async fn workspace_diff(&self) -> Result<WorkspaceDiffSnapshot> {
        if let Some(reason) = self
            .workspace_paths
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .workspace_diff_unavailable_reason()
        {
            return Err(anyhow::anyhow!(reason));
        }
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .workspace_diff()
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => {
                match client.request(RuntimeIpcOperation::WorkspaceDiff).await? {
                    RuntimeIpcOperationResult::WorkspaceDiff { snapshot } => Ok(snapshot),
                    _ => Err(unexpected_shared_result("workspace_diff")),
                }
            }
        }
    }

    pub(crate) async fn generate_session_usage_report(
        &self,
        request: AgentSessionUsageRequest,
    ) -> Result<SessionUsageReport> {
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .generate_session_usage(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::SessionUsage { request })
                .await?
            {
                RuntimeIpcOperationResult::SessionUsage { usage } => Ok(usage),
                _ => Err(unexpected_shared_result("session_usage")),
            },
        }
    }

    pub(crate) async fn wait_for_turn_settlement(
        &self,
        session_id: &str,
        turn_id: &str,
        wait_timeout_ms: u64,
    ) -> std::result::Result<(), RuntimeError> {
        let request = AgentTurnSettlementRequest {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            wait_timeout_ms,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => {
                runtime.wait_for_turn_settlement(request).await.map(|_| ())
            }
            CliAgentRuntimeBackend::Shared(client) => {
                let result = client
                    .request(RuntimeIpcOperation::WaitForSettlement { request })
                    .await
                    .map_err(runtime_error_from_ipc)?;
                expect_unit(result, "wait_for_settlement").map_err(|error| {
                    RuntimeError::Port(PortError::new(PortErrorKind::Backend, error.to_string()))
                })
            }
        }
    }

    fn build_default_session_name() -> String {
        format!(
            "CLI Session - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        )
    }

    fn is_session_not_found_error(error: &RuntimeError) -> bool {
        matches!(
            error,
            RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::NotFound
        )
    }

    async fn recreate_session_with_id(&self, session_id: &str, agent_type: &str) -> Result<()> {
        let runtime = self.embedded_runtime("recreating sessions with fixed identifiers")?;
        let mut session_name = Self::build_default_session_name();
        let mut effective_agent_type = agent_type.to_string();

        let workspace = self.workspace_path_buf();
        let project_workspace = self.project_workspace_path_buf();
        if let Ok(sessions) = runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: self.current_workspace_binding().project_workspace_id,
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
        {
            if let Some(summary) = sessions.iter().find(|s| s.session_id == session_id) {
                session_name = summary.session_name.clone();
                effective_agent_type = summary.agent_type.clone();
            }
        }

        runtime
            .create_session_with_id(
                session_id.to_string(),
                AgentSessionCreateRequest {
                    session_name,
                    agent_type: effective_agent_type,
                    agent_route_key: None,
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    project_workspace_path: Some(project_workspace.to_string_lossy().to_string()),
                    execution_target: self.execution_target(),
                    workspace_id: self.workspace_id(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: None,
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .map_err(anyhow::Error::new)
            .map_err(with_session_conflict_help)?;

        tracing::info!("Recreated backend session with existing id: {}", session_id);
        Ok(())
    }

    async fn ensure_backend_session_alive(&self, session_id: &str, agent_type: &str) -> Result<()> {
        let runtime = self.embedded_runtime("recovering Embedded sessions")?;
        let project_workspace = self.project_workspace_path_buf();
        match runtime
            .restore_session(AgentSessionRestoreRequest {
                workspace_id: self.workspace_id(),
                workspace_path: project_workspace.to_string_lossy().to_string(),
                session_id: session_id.to_string(),
                include_internal: false,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
        {
            Ok(_) => {
                let binding = self.resolve_session_workspace_binding(session_id).await?;
                self.ensure_embedded_plugin_workspace_ready(&binding)
                    .await?;
                tracing::info!("Backend session restored: {}", session_id);
                Ok(())
            }
            Err(error) => {
                let session_not_found = Self::is_session_not_found_error(&error);
                if session_not_found {
                    tracing::warn!(
                        "Session is unavailable, recreating backend session: {}",
                        session_id
                    );
                    self.recreate_session_with_id(session_id, agent_type)
                        .await?;
                    self.ensure_embedded_plugin_session_ready(session_id).await
                } else {
                    Err(with_session_conflict_help(anyhow::Error::new(error)))
                }
            }
        }
    }

    pub(crate) async fn create_session_with_id(
        &self,
        session_id: String,
        agent_type: &str,
    ) -> Result<String> {
        let runtime = self.embedded_runtime("creating sessions with fixed identifiers")?;
        let mut session_id_guard = self.session_id.lock().await;
        let workspace_path = self.workspace_path_string();
        let project_workspace_path = self.project_workspace_path_string();

        let session = runtime
            .create_session_with_id(
                session_id,
                AgentSessionCreateRequest {
                    session_name: Self::build_default_session_name(),
                    agent_type: agent_type.to_string(),
                    agent_route_key: None,
                    workspace_path: Some(workspace_path),
                    project_workspace_path: Some(project_workspace_path),
                    execution_target: self.execution_target(),
                    workspace_id: self.workspace_id(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: None,
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .map_err(anyhow::Error::new)
            .map_err(with_session_conflict_help)?;

        let id = session.session_id.clone();
        self.ensure_embedded_plugin_session_ready(&id).await?;
        *session_id_guard = Some(id.clone());
        tracing::info!("Created runtime session with fixed id: {}", id);

        Ok(id)
    }
}

impl CliAgentRuntimeClient {
    pub(crate) async fn ensure_session(&self, agent_type: &str) -> Result<String> {
        self.ensure_session_with_model(agent_type, None).await
    }

    /// Ensure the startup Session exists, preserving an explicit user model
    /// selection in the authoritative creation request.
    pub(crate) async fn ensure_session_with_model(
        &self,
        agent_type: &str,
        model_id: Option<String>,
    ) -> Result<String> {
        let mut session_id_guard = self.session_id.lock().await;

        if let Some(ref id) = *session_id_guard {
            return Ok(id.clone());
        }

        let request = AgentSessionCreateRequest {
            session_name: Self::build_default_session_name(),
            agent_type: agent_type.to_string(),
            agent_route_key: None,
            workspace_path: Some(self.workspace_path_string()),
            project_workspace_path: None,
            execution_target: None,
            workspace_id: self.workspace_id(),
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id,
            metadata: serde_json::Map::new(),
        };
        let session = match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .create_session(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?,
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::CreateSession { request })
                .await?
            {
                RuntimeIpcOperationResult::SessionCreated { session } => session,
                _ => return Err(unexpected_shared_result("create_session")),
            },
        };

        let id = session.session_id.clone();

        self.ensure_embedded_plugin_session_ready(&id).await?;
        *session_id_guard = Some(id.clone());
        drop(session_id_guard);
        self.refresh_shared_pending_permissions().await?;
        tracing::info!("Created core session: {}", id);

        Ok(id)
    }

    pub(crate) async fn start_session_compaction(&self, session_id: &str) -> Result<String> {
        let turn_id = uuid::Uuid::new_v4().to_string();
        let request = AgentSessionCompactionRequest {
            session_id: session_id.to_string(),
            turn_id: turn_id.clone(),
        };
        *self.current_turn_id.lock().await = Some(turn_id.clone());

        let submission: Result<String> = async {
            match &self.backend {
                CliAgentRuntimeBackend::Embedded(runtime) => {
                    let accepted = runtime
                        .start_session_compaction(request)
                        .await
                        .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                    if accepted.session_id != session_id || accepted.turn_id != turn_id {
                        return Err(anyhow::anyhow!(
                            "Runtime accepted manual compaction with an unexpected identity"
                        ));
                    }
                    Ok(accepted.turn_id)
                }
                CliAgentRuntimeBackend::Shared(client) => match client
                    .request(RuntimeIpcOperation::CompactSession { request })
                    .await?
                {
                    RuntimeIpcOperationResult::TurnAccepted {
                        session_id: accepted_session,
                        turn_id: accepted_turn,
                    } if accepted_session == session_id && accepted_turn == turn_id => {
                        Ok(accepted_turn)
                    }
                    _ => return Err(unexpected_shared_result("compact_session")),
                },
            }
        }
        .await;
        if submission.is_err() {
            *self.current_turn_id.lock().await = None;
        }
        submission
    }

    pub(crate) async fn send_message(&self, message: String, agent_type: &str) -> Result<String> {
        self.send_message_with_context(message, Vec::new(), Vec::new(), agent_type)
            .await
    }

    pub(crate) async fn send_message_with_context(
        &self,
        message: String,
        workspace_references: Vec<AgentWorkspaceReference>,
        attachments: Vec<AgentInputAttachment>,
        agent_type: &str,
    ) -> Result<String> {
        if !attachments.is_empty() && self.is_shared() {
            return Err(anyhow::anyhow!(
                crate::actions::shared_tui_image_attachment_error()
            ));
        }
        let session_id = self.ensure_session(agent_type).await?;
        self.submit_dialog_turn_request(
            session_id,
            message,
            None,
            workspace_references,
            attachments,
            AgentDialogTurnExecution::Standard,
            agent_type,
        )
        .await
    }

    pub(crate) async fn send_external_subagent_command(
        &self,
        prompt: String,
        original_command: String,
        ecosystem_id: String,
        logical_id: String,
        agent_type: &str,
    ) -> Result<String> {
        if self.is_shared() {
            return Err(anyhow::anyhow!(
                "External subagent commands require Embedded TUI; Shared TUI does not transport delegated command submissions"
            ));
        }
        let session_id = self.ensure_session(agent_type).await?;
        self.submit_dialog_turn_request(
            session_id,
            prompt,
            Some(original_command),
            Vec::new(),
            Vec::new(),
            AgentDialogTurnExecution::FreshExternalSubagent {
                ecosystem_id,
                logical_id,
            },
            agent_type,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn submit_dialog_turn_request(
        &self,
        session_id: String,
        message: String,
        original_message: Option<String>,
        workspace_references: Vec<AgentWorkspaceReference>,
        attachments: Vec<AgentInputAttachment>,
        execution: AgentDialogTurnExecution,
        agent_type: &str,
    ) -> Result<String> {
        tracing::info!("Sending message to session {}: {}", session_id, message);
        self.ensure_embedded_plugin_session_ready(&session_id)
            .await?;

        // Generate a turn_id
        let turn_id = uuid::Uuid::new_v4().to_string();

        // Store current turn_id for cancellation
        {
            let mut turn_guard = self.current_turn_id.lock().await;
            *turn_guard = Some(turn_id.clone());
        }

        // Start the dialog turn; events arrive through the shared broadcast source.
        let mut metadata = approval_metadata(self.approval_policy());
        put_agent_workspace_references(&mut metadata, &workspace_references)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let request = AgentDialogTurnRequest {
            session_id: session_id.clone(),
            message: message.clone(),
            output_schema: None,
            original_message,
            turn_id: Some(turn_id.clone()),
            execution,
            agent_type: agent_type.to_string(),
            // Dialog submission locates persisted session state through the
            // owning project workspace ID; the path is only its IO projection.
            // Execution still comes from the session's resolved binding.
            workspace_path: Some(self.project_workspace_path_string()),
            workspace_id: self.current_workspace_binding().project_workspace_id,
            remote_connection_id: None,
            remote_ssh_host: None,
            policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::Cli),
            reply_route: None,
            prepended_reminders: Vec::new(),
            attachments,
            metadata,
        };
        let submission: Result<String> = async {
            match &self.backend {
                CliAgentRuntimeBackend::Embedded(runtime) => {
                    let start_result = runtime.submit_dialog_turn(request.clone()).await;
                    if let Err(err) = start_result {
                        let session_not_found = Self::is_session_not_found_error(&err);
                        let error_message = err.into_message();
                        if session_not_found {
                            tracing::warn!(
                                "Session missing when starting turn, attempting recovery and retry: session_id={}, error={}",
                                session_id,
                                error_message
                            );
                            self.ensure_backend_session_alive(&session_id, agent_type)
                                .await?;
                            runtime
                                .submit_dialog_turn(request)
                                .await
                                .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                        } else {
                            return Err(anyhow::anyhow!(error_message));
                        }
                    }
                    Ok(turn_id)
                }
                CliAgentRuntimeBackend::Shared(client) => match client
                    .request(RuntimeIpcOperation::SubmitTurn { request })
                    .await?
                {
                    RuntimeIpcOperationResult::TurnAccepted {
                        session_id: accepted_session,
                        turn_id: accepted_turn,
                    } if accepted_session == session_id => {
                        *self.current_turn_id.lock().await = Some(accepted_turn.clone());
                        Ok(accepted_turn)
                    }
                    _ => Err(unexpected_shared_result("submit_turn")),
                },
            }
        }
        .await;
        if submission.is_err() {
            *self.current_turn_id.lock().await = None;
        }
        submission
    }

    pub(crate) async fn steer_current_turn(
        &self,
        content: String,
        display_content: Option<String>,
    ) -> Result<String> {
        if content.trim().is_empty() {
            return Err(anyhow::anyhow!("Steering content cannot be empty"));
        }
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active session is available for steering"))?;
        let turn_id = self
            .current_turn_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active turn is available for steering"))?;
        let request = AgentDialogSteerRequest {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            content,
            display_content,
            // The CLI steer prompt is text; attachments ride turn submissions.
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        };

        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => match runtime
                .steer_dialog_turn(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?
            {
                DialogSteerOutcome::Buffered { steering_id, .. } => Ok(steering_id),
            },
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::SteerTurn { request })
                .await?
            {
                RuntimeIpcOperationResult::TurnSteered {
                    session_id: steered_session,
                    turn_id: steered_turn,
                    steering_id,
                } if steered_session == session_id && steered_turn == turn_id => Ok(steering_id),
                _ => Err(unexpected_shared_result("steer_turn")),
            },
        }
    }

    pub(crate) async fn run_user_shell_command(
        &self,
        command: String,
        agent_type: &str,
    ) -> Result<String> {
        let session_id = self.ensure_session(agent_type).await?;
        self.ensure_embedded_plugin_session_ready(&session_id)
            .await?;
        let turn_id = uuid::Uuid::new_v4().to_string();
        let request = AgentUserShellCommandRequest {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            command,
        };
        *self.current_turn_id.lock().await = Some(turn_id.clone());

        let submission: Result<String> = async {
            match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => {
                let accepted = match runtime.run_user_shell_command(request.clone()).await {
                    Ok(accepted) => accepted,
                    Err(error) if Self::is_session_not_found_error(&error) => {
                        tracing::warn!(
                            "Session missing when starting Shell turn, attempting recovery and retry: session_id={}",
                            session_id
                        );
                        self.ensure_backend_session_alive(&session_id, agent_type)
                            .await?;
                        runtime
                            .run_user_shell_command(request)
                            .await
                            .map_err(|error| anyhow::anyhow!(error.into_message()))?
                    }
                    Err(error) => return Err(anyhow::anyhow!(error.into_message())),
                };
                if accepted.session_id == session_id && accepted.turn_id == turn_id {
                    Ok(accepted.turn_id)
                } else {
                    Err(anyhow::anyhow!(
                        "Runtime accepted a Shell command with an unexpected identity"
                    ))
                }
            }
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::RunUserShellCommand { request })
                .await
            {
                Ok(RuntimeIpcOperationResult::TurnAccepted {
                    session_id: accepted_session,
                    turn_id: accepted_turn,
                }) if accepted_session == session_id && accepted_turn == turn_id => {
                    Ok(accepted_turn)
                }
                Ok(_) => Err(unexpected_shared_result("run_user_shell_command")),
                Err(error) => Err(anyhow::Error::new(error)),
            },
            }
        }
        .await;
        if submission.is_err() {
            *self.current_turn_id.lock().await = None;
        }
        submission
    }

    pub(crate) async fn search_workspace_references(
        &self,
        query: String,
    ) -> Result<AgentWorkspaceReferenceSearchResult> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active session"))?;
        let request = AgentWorkspaceReferenceSearchRequest {
            session_id,
            query,
            limit: 20,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .search_workspace_references(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::SearchWorkspaceReferences { request })
                .await?
            {
                RuntimeIpcOperationResult::WorkspaceReferenceSearch { search } => Ok(search),
                _ => Err(unexpected_shared_result("search_workspace_references")),
            },
        }
    }

    pub(crate) async fn workspace_references_for_message(
        &self,
        session_id: String,
        message_id: String,
    ) -> Result<Vec<AgentWorkspaceReference>> {
        let request = AgentMessageWorkspaceReferencesRequest {
            session_id,
            message_id,
        };
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .workspace_references_for_message(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message())),
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::WorkspaceReferencesForMessage { request })
                .await?
            {
                RuntimeIpcOperationResult::WorkspaceReferences { references } => Ok(references),
                _ => Err(unexpected_shared_result("workspace_references_for_message")),
            },
        }
    }

    pub(crate) async fn cancel_current_turn(&self) -> Result<()> {
        let session_id = self.session_id.lock().await.clone();
        let turn_id = self.current_turn_id.lock().await.clone();

        if let (Some(session_id), Some(turn_id)) = (session_id, turn_id) {
            tracing::info!("Cancelling turn: session={}, turn={}", session_id, turn_id);
            let request = AgentTurnCancellationRequest {
                session_id,
                turn_id: Some(turn_id.clone()),
                source: Some(AgentSubmissionSource::Cli),
                requester_session_id: None,
                reason: Some("user_cancelled".to_string()),
                wait_timeout_ms: None,
                cancel_descendants: true,
            };
            match &self.backend {
                CliAgentRuntimeBackend::Embedded(runtime) => {
                    runtime
                        .cancel_turn(request)
                        .await
                        .map_err(|error| anyhow::anyhow!(error.into_message()))?;
                }
                CliAgentRuntimeBackend::Shared(client) => match client
                    .request(RuntimeIpcOperation::CancelTurn { request })
                    .await?
                {
                    RuntimeIpcOperationResult::TurnCancelled { .. } => {}
                    _ => return Err(unexpected_shared_result("cancel_turn")),
                },
            }

            let mut turn_id_guard = self.current_turn_id.lock().await;
            if turn_id_guard.as_deref() == Some(turn_id.as_str()) {
                *turn_id_guard = None;
            }
        }

        Ok(())
    }

    pub(crate) async fn create_new_session(&self, agent_type: &str) -> Result<String> {
        let project_workspace = self.reset_execution_to_project_workspace();
        let project_workspace_path = project_workspace.to_string_lossy().to_string();
        let request = AgentSessionCreateRequest {
            session_name: Self::build_default_session_name(),
            agent_type: agent_type.to_string(),
            agent_route_key: None,
            workspace_path: Some(project_workspace_path.clone()),
            project_workspace_path: Some(project_workspace_path.clone()),
            execution_target: Some(SessionExecutionTarget::local(project_workspace_path)),
            workspace_id: self.workspace_id(),
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            metadata: serde_json::Map::new(),
        };
        let session = match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .create_session(request)
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?,
            CliAgentRuntimeBackend::Shared(client) => match client
                .request(RuntimeIpcOperation::CreateSession { request })
                .await?
            {
                RuntimeIpcOperationResult::SessionCreated { session } => session,
                _ => return Err(unexpected_shared_result("create_session")),
            },
        };

        let id = session.session_id.clone();

        self.ensure_embedded_plugin_session_ready(&id).await?;
        *self.session_id.lock().await = Some(id.clone());
        *self.current_turn_id.lock().await = None;
        self.shared_pending_permissions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        tracing::info!("Created new core session: {}", id);

        Ok(id)
    }

    pub(crate) async fn restore_session(&self, session_id: &str) -> Result<()> {
        self.restore_session_in_current_workspace(session_id)
            .await?;
        Ok(())
    }

    pub(crate) async fn cancel_user_question(&self, tool_id: &str) -> Result<()> {
        let session_id = self.require_session_id().await?;
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .cancel_user_question(&session_id, tool_id)
                .map_err(anyhow::Error::new),
            CliAgentRuntimeBackend::Shared(client) => expect_unit(
                client
                    .request(RuntimeIpcOperation::CancelUserQuestion {
                        session_id,
                        tool_id: tool_id.to_string(),
                    })
                    .await?,
                "cancel_user_question",
            ),
        }
    }

    pub(crate) async fn start_question_interaction(&self, tool_id: &str) -> Result<()> {
        let session_id = self.require_session_id().await?;
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .start_user_question_interaction(&session_id, tool_id)
                .map_err(anyhow::Error::new),
            CliAgentRuntimeBackend::Shared(client) => expect_unit(
                client
                    .request(RuntimeIpcOperation::StartQuestionInteraction {
                        session_id,
                        tool_id: tool_id.to_string(),
                    })
                    .await?,
                "start_question_interaction",
            ),
        }
    }

    pub(crate) async fn submit_user_answers(
        &self,
        tool_id: &str,
        answers: serde_json::Value,
    ) -> Result<()> {
        tracing::info!("Submitting user answers for tool: {}", tool_id);
        match &self.backend {
            CliAgentRuntimeBackend::Embedded(runtime) => runtime
                .submit_user_answers(AgentUserAnswersRequest {
                    tool_id: tool_id.to_string(),
                    answers,
                })
                .await
                .map_err(|e| anyhow::anyhow!("Submit user answers failed: {}", e.into_message())),
            CliAgentRuntimeBackend::Shared(client) => {
                let session_id = self.require_session_id().await?;
                expect_unit(
                    client
                        .request(RuntimeIpcOperation::SubmitUserAnswers {
                            request: RuntimeUserAnswersRequest {
                                session_id,
                                tool_id: tool_id.to_string(),
                                answers,
                            },
                        })
                        .await?,
                    "submit_user_answers",
                )
            }
        }
    }

    async fn require_session_id(&self) -> Result<String> {
        self.session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Shared TUI has no attached session"))
    }

    async fn refresh_shared_pending_permissions(&self) -> Result<()> {
        let CliAgentRuntimeBackend::Shared(client) = &self.backend else {
            return Ok(());
        };
        let session_id = self.require_session_id().await?;
        let RuntimeIpcOperationResult::PendingPermissions { requests } = client
            .request(RuntimeIpcOperation::PendingPermissions { session_id })
            .await?
        else {
            return Err(unexpected_shared_result("pending_permissions"));
        };
        let mut pending = self
            .shared_pending_permissions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.clear();
        pending.extend(
            requests
                .into_iter()
                .map(|request| (request.request_id.clone(), request)),
        );
        Ok(())
    }
}

fn shared_receiver<T: Clone>(
    source: Option<&SharedBroadcast<T>>,
    message: &str,
) -> std::result::Result<broadcast::Receiver<T>, RuntimeError> {
    source
        .and_then(|source| {
            source
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .map(broadcast::Sender::subscribe)
        })
        .ok_or_else(|| RuntimeError::Port(PortError::new(PortErrorKind::NotAvailable, message)))
}

fn spawn_shared_event_bridge(
    mut source: broadcast::Receiver<RuntimeIpcClientEvent>,
    agent_sender: broadcast::Sender<AgenticEventEnvelope>,
    permission_sender: broadcast::Sender<openbitfun_agent_runtime::sdk::PermissionRequestEvent>,
    agent_owner: SharedBroadcast<AgenticEventEnvelope>,
    permission_owner: SharedBroadcast<openbitfun_agent_runtime::sdk::PermissionRequestEvent>,
    pending: Arc<RwLock<HashMap<String, PermissionRequest>>>,
) {
    tokio::spawn(async move {
        loop {
            match source.recv().await {
                Ok(RuntimeIpcClientEvent::Runtime(RuntimeIpcEvent::Agent { envelope, .. })) => {
                    let _ = agent_sender.send(envelope);
                }
                Ok(RuntimeIpcClientEvent::Runtime(RuntimeIpcEvent::Permission {
                    session_id,
                    mut event,
                })) => {
                    project_routed_permission_event(&mut event, &session_id);
                    match &event {
                        openbitfun_agent_runtime::sdk::PermissionRequestEvent::Asked {
                            request,
                        } => {
                            pending
                                .write()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .insert(request.request_id.clone(), request.clone());
                        }
                        openbitfun_agent_runtime::sdk::PermissionRequestEvent::Replied {
                            request_id,
                            ..
                        }
                        | openbitfun_agent_runtime::sdk::PermissionRequestEvent::Cancelled {
                            request_id,
                            ..
                        } => {
                            pending
                                .write()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .remove(request_id);
                        }
                    }
                    let _ = permission_sender.send(event);
                }
                Ok(RuntimeIpcClientEvent::Runtime(RuntimeIpcEvent::StreamInvalidated {
                    reason,
                })) => {
                    let event = AgenticEvent::SystemError {
                        session_id: None,
                        error: shared_disconnect_message(Some(reason)),
                        recoverable: false,
                    };
                    let _ = agent_sender.send(AgenticEventEnvelope::new(
                        event,
                        openbitfun_events::AgenticEventPriority::Critical,
                    ));
                    break;
                }
                Ok(RuntimeIpcClientEvent::Disconnected)
                | Err(broadcast::error::RecvError::Closed)
                | Err(broadcast::error::RecvError::Lagged(_)) => {
                    let event = AgenticEvent::SystemError {
                        session_id: None,
                        error: shared_disconnect_message(None),
                        recoverable: false,
                    };
                    let _ = agent_sender.send(AgenticEventEnvelope::new(
                        event,
                        openbitfun_events::AgenticEventPriority::Critical,
                    ));
                    break;
                }
            }
        }
        *agent_owner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *permission_owner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    });
}

fn shared_disconnect_message(reason: Option<RuntimeIpcStreamInvalidationReason>) -> String {
    if reason == Some(RuntimeIpcStreamInvalidationReason::FrameTooLarge) {
        format!(
            "Shared Runtime event exceeded the supported size; active-turn cancellation was requested. {SHARED_TUI_EMBEDDED_HANDOFF}."
        )
    } else {
        "Shared Runtime connection was lost; this view is no longer authoritative".to_string()
    }
}

fn project_routed_permission_event(
    event: &mut openbitfun_agent_runtime::sdk::PermissionRequestEvent,
    routed_session_id: &str,
) {
    let openbitfun_agent_runtime::sdk::PermissionRequestEvent::Asked { request } = event else {
        return;
    };
    if request.session_id == routed_session_id {
        return;
    }
    if let Some(delegation) = request.delegation.as_mut() {
        delegation.parent_session_id = routed_session_id.to_string();
    }
}

pub(super) fn expect_unit(result: RuntimeIpcOperationResult, operation: &str) -> Result<()> {
    match result {
        RuntimeIpcOperationResult::Unit => Ok(()),
        _ => Err(unexpected_shared_result(operation)),
    }
}

fn unexpected_shared_result(operation: &str) -> anyhow::Error {
    anyhow::anyhow!("Shared Runtime returned an unexpected result for {operation}")
}

#[cfg(test)]
mod recovery_tests {
    use openbitfun_agent_runtime::sdk::{PortError, PortErrorKind, RuntimeError};

    use super::CliAgentRuntimeClient;

    #[test]
    fn session_recovery_requires_structured_not_found_error() {
        let missing_session =
            RuntimeError::Port(PortError::new(PortErrorKind::NotFound, "session not found"));
        let unrelated_backend_error =
            RuntimeError::Port(PortError::new(PortErrorKind::Backend, "model not found"));

        assert!(CliAgentRuntimeClient::is_session_not_found_error(
            &missing_session
        ));
        assert!(!CliAgentRuntimeClient::is_session_not_found_error(
            &unrelated_backend_error
        ));
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use openbitfun_runtime_ports::{
        AgentSessionSummary, AgentSessionWorkspaceBinding, SessionExecutionTarget,
        SessionExecutionTargetKind, WorktreeLifecycle,
    };

    use openbitfun_agent_runtime::sdk::{
        PermissionDelegationContext, PermissionRequest, PermissionRequestEvent,
        PermissionRequestSource, PermissionRequestSourceKind, PortError, PortErrorKind,
        RuntimeError,
    };
    use openbitfun_agent_runtime_ipc::{
        RuntimeIpcClientError, RuntimeIpcError, RuntimeIpcErrorCode,
    };

    use super::{
        project_routed_permission_event, session_migration_notices, shared_disconnect_message,
        shared_restore_error, validated_session_summary, CliWorkspacePaths, SessionMigrationNotice,
        SessionOperationError,
    };
    use openbitfun_agent_runtime_ipc::RuntimeIpcStreamInvalidationReason;

    #[test]
    fn oversized_shared_restore_explains_the_embedded_handoff() {
        let error = shared_restore_error(RuntimeIpcClientError::Remote(RuntimeIpcError {
            code: RuntimeIpcErrorCode::FrameTooLarge,
            message: "response too large".to_string(),
        }));
        let message = error.to_string();
        assert!(message.contains("history is too large"));
        assert!(message.contains("default Embedded `openbitfun chat`"));
    }

    #[test]
    fn shared_session_update_preserves_unknown_outcome_as_a_typed_fact() {
        let error = SessionOperationError::shared(RuntimeIpcClientError::Remote(RuntimeIpcError {
            code: RuntimeIpcErrorCode::OutcomeUnknown,
            message: "inspect authoritative state before retrying".to_string(),
        }));

        assert!(error.outcome_unknown());
        assert!(error.to_string().contains("OutcomeUnknown"));

        for transport_error in [
            RuntimeIpcClientError::Timeout,
            RuntimeIpcClientError::Disconnected,
            RuntimeIpcClientError::UnexpectedResponse,
        ] {
            assert!(SessionOperationError::shared(transport_error).outcome_unknown());
        }
        assert!(
            SessionOperationError::unexpected(anyhow::anyhow!("unexpected response shape"))
                .outcome_unknown()
        );
        assert!(
            !SessionOperationError::shared(RuntimeIpcClientError::Remote(RuntimeIpcError {
                code: RuntimeIpcErrorCode::InvalidRequest,
                message: "unknown mode".to_string(),
            },))
            .outcome_unknown()
        );
        assert!(
            !SessionOperationError::shared(RuntimeIpcClientError::RequestEncoding(
                openbitfun_agent_runtime_ipc::RuntimeIpcIoError::FrameTooLarge {
                    size: 129,
                    max_bytes: 128,
                },
            ))
            .outcome_unknown()
        );
    }

    #[test]
    fn embedded_runtime_unknown_outcome_is_preserved() {
        let error = SessionOperationError::runtime(RuntimeError::Port(PortError::new(
            PortErrorKind::OutcomeUnknown,
            "inspect authoritative state",
        )));

        assert!(error.outcome_unknown());
    }

    #[test]
    fn read_only_lineage_retry_requires_typed_remote_outcome_unknown() {
        let settling = SessionOperationError::read_only_shared(RuntimeIpcClientError::Remote(
            RuntimeIpcError {
                code: RuntimeIpcErrorCode::OutcomeUnknown,
                message: "turn is settling".to_string(),
            },
        ));
        let permanent = SessionOperationError::read_only_shared(RuntimeIpcClientError::Remote(
            RuntimeIpcError {
                code: RuntimeIpcErrorCode::NotFound,
                message: "session missing".to_string(),
            },
        ));

        assert!(settling.outcome_unknown());
        assert!(!permanent.outcome_unknown());
        assert!(
            !SessionOperationError::read_only_shared(RuntimeIpcClientError::Timeout)
                .outcome_unknown()
        );
        assert!(
            !SessionOperationError::read_only_unexpected(anyhow::anyhow!("unexpected response"))
                .outcome_unknown()
        );
    }

    #[test]
    fn oversized_shared_event_explains_cancellation_and_handoff() {
        let message =
            shared_disconnect_message(Some(RuntimeIpcStreamInvalidationReason::FrameTooLarge));
        assert!(message.contains("cancellation was requested"));
        assert!(message.contains("default Embedded `openbitfun chat`"));
    }

    #[test]
    fn workspace_paths_keep_project_and_execution_roots_separate() {
        let mut paths = CliWorkspacePaths::new(Some("/project".into()));
        let binding = AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
            project_workspace_id: Some("project-1".into()),
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "/managed-worktree".to_string(),
            project_workspace_path: Some("/project".to_string()),
            execution_target: Some(SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some("worktree-1".to_string()),
                root_path: "/managed-worktree".to_string(),
                base_ref: Some("main".to_string()),
                base_commit: Some("123456789abcdef".to_string()),
                branch: None,
                lifecycle: Some(WorktreeLifecycle::Managed),
            }),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        paths.apply_binding(&binding);

        assert_eq!(paths.project(), Path::new("/project"));
        assert_eq!(paths.execution(), Path::new("/managed-worktree"));
        assert_eq!(
            paths
                .execution_target
                .as_ref()
                .and_then(|target| target.worktree_id.as_deref()),
            Some("worktree-1")
        );

        assert_eq!(
            paths.reset_execution_to_project(),
            Path::new("/project").to_path_buf()
        );
        assert_eq!(paths.execution(), Path::new("/project"));
        assert_eq!(paths.workspace_id.as_deref(), Some("project-1"));
        assert!(paths
            .execution_target
            .as_ref()
            .and_then(|target| target.worktree_id.as_ref())
            .is_none());
    }

    #[test]
    fn workspace_diff_fails_closed_for_other_worktrees_and_remote_sessions() {
        let mut paths = CliWorkspacePaths::new(Some("/project".into()));
        assert!(paths.workspace_diff_unavailable_reason().is_some());
        paths.workspace_id = Some("project-1".into());
        paths.project_workspace_id = Some("project-1".into());
        paths.workspace_kind = Some(openbitfun_core::service::workspace::WorkspaceKind::Normal);
        assert_eq!(paths.workspace_diff_unavailable_reason(), None);

        paths.apply_binding(&AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
            project_workspace_id: Some("project-1".into()),
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "/managed-worktree".to_string(),
            project_workspace_path: Some("/project".to_string()),
            execution_target: Some(SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some("worktree-1".to_string()),
                root_path: "/managed-worktree".to_string(),
                base_ref: Some("main".to_string()),
                base_commit: Some("123456789abcdef".to_string()),
                branch: None,
                lifecycle: Some(WorktreeLifecycle::Managed),
            }),
            remote_connection_id: None,
            remote_ssh_host: None,
        });
        assert!(paths
            .workspace_diff_unavailable_reason()
            .is_some_and(|reason| reason.contains("different worktree")));

        paths.apply_binding(&AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Remote),
            project_workspace_id: Some("remote-workspace".into()),
            workspace_id: Some("remote-workspace".into()),
            workspace_path: "/project".to_string(),
            project_workspace_path: Some("/project".to_string()),
            execution_target: Some(SessionExecutionTarget::local("/project")),
            remote_connection_id: Some("remote-1".to_string()),
            remote_ssh_host: Some("example.test".to_string()),
        });
        assert!(paths
            .workspace_diff_unavailable_reason()
            .is_some_and(|reason| reason.contains("remote Sessions")));
    }

    #[test]
    fn model_updates_use_the_runtime_sdk_without_the_core_compatibility_facade() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let compatibility_update =
            ["self.compatibility", "\n            .update_session_model"].concat();

        assert!(source.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(source.contains("runtime.update_session_model(request)"));
        assert!(source.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(source.contains("RuntimeIpcOperation::UpdateSessionModel { request }"));
        assert!(!source.contains(&compatibility_update));
    }

    #[test]
    fn startup_model_selection_is_sent_in_the_session_creation_request() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let creation = source
            .split_once("pub(crate) async fn ensure_session_with_model(")
            .expect("explicit startup session creation method")
            .1
            .split_once("pub(crate) async fn start_session_compaction(")
            .expect("explicit startup session creation boundary")
            .0;

        assert!(creation.contains("model_id: Option<String>"));
        assert!(creation.contains("AgentSessionCreateRequest"));
        assert!(creation.contains("model_id,"));
        assert!(creation.contains("RuntimeIpcOperation::CreateSession { request }"));
    }

    #[test]
    fn session_rename_uses_direct_runtime_or_private_shared_ipc() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let rename = source
            .split_once("pub(crate) async fn rename_session(")
            .expect("rename method")
            .1
            .split_once("pub(crate) async fn update_session_mode(")
            .expect("rename method boundary")
            .0;

        assert!(source.contains("pub(crate) async fn rename_session("));
        assert!(rename.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(rename.contains(".rename_session(request)"));
        assert!(rename.contains("RuntimeIpcOperation::RenameSession"));
        assert!(!rename.contains("serde_json::to_value"));
        assert!(!rename.contains("serde_json::from_value"));
    }

    #[test]
    fn session_compaction_uses_direct_runtime_or_private_shared_ipc() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let compact = source
            .split_once("pub(crate) async fn start_session_compaction(")
            .expect("compaction method")
            .1
            .split_once("pub(crate) async fn send_message(")
            .expect("compaction method boundary")
            .0;

        assert!(compact.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(compact.contains(".start_session_compaction(request)"));
        assert!(compact.contains("RuntimeIpcOperation::CompactSession { request }"));
        assert!(compact.contains("RuntimeIpcOperationResult::TurnAccepted"));
        assert!(!compact.contains("serde_json::to_value"));
        assert!(!compact.contains("serde_json::from_value"));
    }

    #[test]
    fn steering_uses_the_existing_runtime_contract_in_both_deployments() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let steering = source
            .split_once("pub(crate) async fn steer_current_turn(")
            .expect("steering method")
            .1
            .split_once("pub(crate) async fn run_user_shell_command(")
            .expect("steering method boundary")
            .0;

        assert!(steering.contains("AgentDialogSteerRequest"));
        assert!(steering.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(steering.contains(".steer_dialog_turn(request)"));
        assert!(steering.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(steering.contains("RuntimeIpcOperation::SteerTurn { request }"));
        assert!(steering.contains("RuntimeIpcOperationResult::TurnSteered"));
        assert!(!steering.contains("RuntimeIpcOperation::SubmitTurn"));
        assert!(!steering.contains("Uuid::new_v4"));
    }

    #[test]
    fn image_attachments_use_the_runtime_contract_and_fail_before_shared_ipc() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let submission = source
            .split_once("pub(crate) async fn send_message_with_context(")
            .expect("context submission method")
            .1
            .split_once("pub(crate) async fn search_workspace_references(")
            .expect("context submission method boundary")
            .0;

        let shared_rejection = submission
            .find("if !attachments.is_empty() && self.is_shared()")
            .expect("shared attachment rejection");
        let session_creation = submission
            .find("let session_id = self.ensure_session")
            .expect("session creation");
        assert!(shared_rejection < session_creation);
        assert!(submission.contains("attachments,"));
        assert!(!submission.contains("imagePath"));
    }

    #[test]
    fn delegated_external_commands_fail_before_shared_ipc() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let submission = source
            .split_once("pub(crate) async fn send_external_subagent_command(")
            .expect("delegated command submission method")
            .1
            .split_once("async fn submit_dialog_turn_request(")
            .expect("delegated command submission boundary")
            .0;

        let shared_rejection = submission
            .find("if self.is_shared()")
            .expect("shared runtime rejection");
        let session_creation = submission
            .find("let session_id = self.ensure_session")
            .expect("session creation");
        assert!(shared_rejection < session_creation);
        assert!(submission.contains("AgentDialogTurnExecution::FreshExternalSubagent"));
        assert!(!submission.contains("RuntimeIpcOperation::SubmitTurn"));
    }

    #[test]
    fn interactive_session_fork_uses_the_same_runtime_boundary_in_both_deployments() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let fork = source
            .split_once("pub(crate) async fn fork_current_session(")
            .expect("interactive fork method")
            .1
            .split_once("pub(crate) async fn generate_session_usage_report(")
            .expect("interactive fork method boundary")
            .0;

        assert!(fork.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(fork.contains(".fork_session_before_turn("));
        assert!(fork.contains(".fork_session(AgentSessionForkRequest"));
        assert!(fork.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(fork.contains("RuntimeIpcOperation::ForkSession"));
        assert!(fork.contains("RuntimeIpcOperationResult::SessionForked"));
    }

    #[test]
    fn workspace_diff_uses_the_same_runtime_boundary_in_both_deployments() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let workspace_diff = source
            .split_once("pub(crate) async fn workspace_diff(")
            .expect("workspace diff method")
            .1
            .split_once("pub(crate) async fn generate_session_usage_report(")
            .expect("workspace diff method boundary")
            .0;

        assert!(workspace_diff.contains("workspace_diff_unavailable_reason"));
        assert!(workspace_diff.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(workspace_diff.contains(".workspace_diff()"));
        assert!(workspace_diff.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(workspace_diff.contains("RuntimeIpcOperation::WorkspaceDiff"));
        assert!(workspace_diff.contains("RuntimeIpcOperationResult::WorkspaceDiff"));
    }

    #[test]
    fn session_revert_uses_the_same_authoritative_result_in_both_deployments() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let revert = source
            .split_once("pub(crate) async fn revert_current_session(")
            .expect("session revert method")
            .1
            .split_once("pub(crate) async fn generate_session_usage_report(")
            .expect("session revert method boundary")
            .0;

        assert!(revert.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(revert.contains("runtime.undo_session(request)"));
        assert!(revert.contains("runtime.redo_session(request)"));
        assert!(revert.contains("RuntimeIpcOperation::UndoSession"));
        assert!(revert.contains("RuntimeIpcOperation::RedoSession"));
        assert!(revert.contains("RuntimeIpcOperationResult::SessionReverted"));
    }

    #[test]
    fn session_delete_uses_direct_runtime_or_private_shared_ipc() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let delete = source
            .split_once("pub(crate) async fn delete_session(")
            .expect("delete method")
            .1
            .split_once("pub(crate) async fn update_session_model(")
            .expect("delete method boundary")
            .0;

        assert!(delete.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(delete.contains(".delete_session(AgentSessionDeleteRequest {"));
        assert!(delete.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(delete.contains("RuntimeIpcOperation::DeleteSession"));
        assert!(!delete.contains("embedded_runtime"));
        assert!(!delete.contains("serde_json::to_value"));
        assert!(!delete.contains("serde_json::from_value"));
    }

    #[test]
    fn mode_updates_use_the_runtime_sdk_without_the_core_compatibility_facade() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let compatibility_update = [
            "self.compatibility",
            "\n            .update_session_agent_type",
        ]
        .concat();

        assert!(source.contains("CliAgentRuntimeBackend::Embedded(runtime)"));
        assert!(source.contains("runtime.update_session_mode(request)"));
        assert!(source.contains("CliAgentRuntimeBackend::Shared(client)"));
        assert!(source.contains("RuntimeIpcOperation::UpdateSessionMode { request }"));
        assert!(!source.contains(&compatibility_update));
    }

    #[test]
    fn agent_events_use_the_runtime_sdk_without_a_core_event_source() {
        let source = include_str!("runtime_client.rs").replace("\r\n", "\n");
        let runtime_subscription = ["runtime", ".subscribe_events()"].concat();
        let core_event_field = ["event_source", ": CliAgent", "EventSource"].concat();
        let core_event_method = ["pub(crate) fn event", "_source("].concat();

        assert!(source.contains(&runtime_subscription));
        assert!(!source.contains(&core_event_field));
        assert!(!source.contains(&core_event_method));
    }

    fn session_summary(session_id: &str) -> AgentSessionSummary {
        AgentSessionSummary {
            session_id: session_id.to_string(),
            session_name: "Workspace session".to_string(),
            agent_type: "Standard".to_string(),
            model_id: None,
            reasoning_preset: None,
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            turn_count: 1,
            created_at_ms: 1,
            last_active_at_ms: 2,
        }
    }

    #[test]
    fn workspace_restore_validation_accepts_listed_session() {
        let sessions = vec![session_summary("session-in-workspace")];

        let summary = validated_session_summary(
            &sessions,
            "session-in-workspace",
            Path::new("D:/workspace/current"),
        )
        .expect("listed session should be restorable");

        assert_eq!(summary.session_id, "session-in-workspace");
    }

    #[test]
    fn workspace_restore_validation_rejects_session_outside_current_workspace() {
        let sessions = vec![session_summary("different-session")];

        let error = validated_session_summary(
            &sessions,
            "session-from-another-workspace",
            Path::new("D:/workspace/current"),
        )
        .expect_err("a session absent from the workspace-scoped list must be rejected");

        let message = error.to_string();
        assert!(message.contains("session-from-another-workspace"));
        assert!(message.contains("D:/workspace/current"));
    }

    #[test]
    fn restore_reports_a_cli_local_notice_when_core_migrates_the_mode() {
        let previous = AgentSessionSummary {
            agent_type: "removed-mode".to_string(),
            ..session_summary("mode-migration")
        };
        let restored = session_summary("mode-migration");

        let notices = session_migration_notices(&previous, &restored);

        assert_eq!(
            notices,
            vec![SessionMigrationNotice::Mode {
                previous_id: "removed-mode".to_string(),
                restored_id: "Standard".to_string(),
            }]
        );
    }

    #[test]
    fn restore_reports_a_cli_local_notice_when_core_migrates_the_model() {
        let previous = AgentSessionSummary {
            model_id: Some("removed-model".to_string()),
            ..session_summary("model-migration")
        };
        let restored = AgentSessionSummary {
            model_id: Some("primary".to_string()),
            ..session_summary("model-migration")
        };

        let notices = session_migration_notices(&previous, &restored);

        assert_eq!(
            notices,
            vec![SessionMigrationNotice::Model {
                previous_id: "removed-model".to_string(),
                restored_id: "primary".to_string(),
            }]
        );
        assert!(notices[0].user_message().contains("unavailable"));
    }

    #[test]
    fn restore_does_not_report_notices_when_session_settings_are_unchanged() {
        let summary = session_summary("unchanged-mode");

        assert!(session_migration_notices(&summary, &summary).is_empty());
    }

    #[test]
    fn nested_permission_projects_to_the_routed_controller_session() {
        let mut permission = PermissionRequestEvent::Asked {
            request: PermissionRequest {
                request_id: "permission".to_string(),
                round_id: "round".to_string(),
                order: 0,
                tool_call_id: None,
                project_path: None,
                project_id: "project".to_string(),
                session_id: "child".to_string(),
                agent_id: "Standard".to_string(),
                action: "run command".to_string(),
                resources: Vec::new(),
                save_resources: Vec::new(),
                source: PermissionRequestSource {
                    kind: PermissionRequestSourceKind::ToolCall,
                    identity: "shell".to_string(),
                },
                delegation: Some(PermissionDelegationContext {
                    parent_session_id: "child".to_string(),
                    parent_dialog_turn_id: None,
                    parent_tool_call_id: "delegate".to_string(),
                    subagent_type: "general".to_string(),
                }),
                display_metadata: serde_json::Map::new(),
            },
        };
        project_routed_permission_event(&mut permission, "root");
        assert!(
            matches!(permission, PermissionRequestEvent::Asked { request } if request.delegation.as_ref().is_some_and(|delegation| delegation.parent_session_id == "root"))
        );
    }
}

#[cfg(test)]
mod dual_backend_behavior_tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use openbitfun_agent_runtime::event_queue::{EventQueue, EventQueueConfig};
    use openbitfun_agent_runtime::sdk::{
        AgentDialogTurnPort, AgentDialogTurnRequest, AgentEventSource, AgentModeCatalogEntry,
        AgentModeCatalogPort, AgentModeCatalogQuery, AgentRuntime, AgentRuntimeBuilder,
        AgentSessionCreateRequest, AgentSessionCreateResult, AgentSessionDeleteRequest,
        AgentSessionListRequest, AgentSessionManagementPort, AgentSessionRestorePort,
        AgentSessionRestoreRequest, AgentSessionRestoreResult, AgentSessionWorkspaceBinding,
        AgentSessionWorkspaceRequest, AgentSubmissionPort, AgentSubmissionRequest,
        AgentSubmissionResult, AgentTurnCancellationPort, AgentTurnCancellationRequest,
        AgentTurnCancellationResult, AgentTurnSettlementPort, AgentTurnSettlementRequest,
        AgentTurnSettlementResult, AgentTurnSettlementStatus, AgenticEvent, DialogSubmitOutcome,
        PermissionReply, PermissionRequest, PermissionRequestManager, PermissionRequestSource,
        PermissionRequestSourceKind, PortError, PortErrorKind, PortResult, RuntimeError,
        SessionState, SessionTranscript, SessionTranscriptReader, SessionTranscriptRequest,
    };
    use openbitfun_agent_runtime_ipc::{
        RuntimeInstanceIdentity, RuntimeIpcClient, RuntimeIpcClientError, RuntimeIpcErrorCode,
        RuntimeIpcOperation, RuntimeIpcOperationResult, RuntimeIpcServer, RuntimeIpcServerConfig,
    };
    use openbitfun_runtime_ports::{
        ClockPort, PermissionAuditRecord, PermissionAuditStorePort, PermissionReplyStorePort,
        RuntimeServiceCapability, RuntimeServicePort, SessionExecutionTarget,
        SessionExecutionTargetKind, WorktreeLifecycle,
    };

    use crate::shared_runtime::SharedRuntimeHandler;

    use super::CliAgentRuntimeClient;

    /// User root of the isolated workspace catalog every test in this binary
    /// shares. It lives under the process temp directory and is never the
    /// developer's real data directory.
    static ISOLATED_USER_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

    /// Install an isolated global workspace service before any fixture creates
    /// a record. The production code under test resolves the global service,
    /// so without this the fixtures' temp folders would be persisted into the
    /// developer's real `workspace_data.json` as opened, current workspaces.
    async fn ensure_isolated_workspace_catalog() -> PathBuf {
        use openbitfun_core::service::workspace::{
            get_global_workspace_service, set_global_workspace_service, WorkspaceService,
        };

        let user_root = ISOLATED_USER_ROOT
            .get_or_init(|| {
                std::env::temp_dir()
                    .join("openbitfun-cli-runtime-client-tests")
                    .join(uuid::Uuid::new_v4().simple().to_string())
                    .join("user-root")
            })
            .clone();
        if get_global_workspace_service().is_none() {
            let service = WorkspaceService::new_isolated_for_tests(user_root.clone()).await;
            set_global_workspace_service(Arc::new(service));
        }
        let installed = get_global_workspace_service()
            .expect("global workspace service installed")
            .path_manager()
            .user_root_dir()
            .to_path_buf();
        assert_eq!(
            installed, user_root,
            "CLI runtime client tests must run against an isolated workspace catalog, not the real user data directory"
        );
        user_root
    }

    /// Open the fixture directory as a real local workspace record. The
    /// embedded client, the fixture runtime, and the shared handler all
    /// address that workspace by this ID, exactly as production hosts do.
    async fn open_fixture_workspace(workspace: &Path) -> String {
        ensure_isolated_workspace_catalog().await;
        crate::create_cli_local_workspace(workspace)
            .await
            .expect("fixture workspace record")
            .id
    }

    fn fixture_identity() -> RuntimeInstanceIdentity {
        let identity = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        RuntimeInstanceIdentity::parse(&identity).expect("valid instance identity")
    }
    #[derive(Clone)]
    struct FixtureState {
        workspace: PathBuf,
        workspace_id: String,
        event_queue: Arc<EventQueue>,
        sessions:
            Arc<StdMutex<HashMap<String, openbitfun_agent_runtime::sdk::AgentSessionSummary>>>,
        transcripts: Arc<StdMutex<HashMap<String, SessionTranscript>>>,
        cancellation_requests: Arc<StdMutex<Vec<AgentTurnCancellationRequest>>>,
        settlement_outcomes: Arc<StdMutex<HashMap<String, Option<PortError>>>>,
    }

    impl FixtureState {
        fn new(workspace: PathBuf, workspace_id: String) -> Self {
            Self {
                workspace,
                workspace_id,
                event_queue: Arc::new(EventQueue::new(EventQueueConfig::default())),
                sessions: Arc::new(StdMutex::new(HashMap::new())),
                transcripts: Arc::new(StdMutex::new(HashMap::new())),
                cancellation_requests: Arc::new(StdMutex::new(Vec::new())),
                settlement_outcomes: Arc::new(StdMutex::new(HashMap::new())),
            }
        }

        fn summary(
            session_id: impl Into<String>,
            session_name: impl Into<String>,
            agent_type: impl Into<String>,
        ) -> openbitfun_agent_runtime::sdk::AgentSessionSummary {
            openbitfun_agent_runtime::sdk::AgentSessionSummary {
                session_id: session_id.into(),
                session_name: session_name.into(),
                agent_type: agent_type.into(),
                model_id: None,
                reasoning_preset: None,
                last_user_dialog_agent_type: None,
                last_submitted_agent_type: None,
                turn_count: 0,
                created_at_ms: 1,
                last_active_at_ms: 1,
            }
        }

        fn insert_session(&self, session_id: String, session_name: String, agent_type: String) {
            self.sessions.lock().unwrap().insert(
                session_id.clone(),
                Self::summary(session_id, session_name, agent_type),
            );
        }

        /// The fixture runtime answers like the production owner: a session's
        /// binding names its workspace by ID, and the path is a projection.
        fn workspace_binding(&self) -> AgentSessionWorkspaceBinding {
            let workspace = self.workspace.to_string_lossy().into_owned();
            AgentSessionWorkspaceBinding {
                workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
                project_workspace_id: Some(self.workspace_id.clone()),
                workspace_id: Some(self.workspace_id.clone()),
                workspace_path: workspace.clone(),
                project_workspace_path: Some(workspace.clone()),
                execution_target: Some(SessionExecutionTarget::local(workspace)),
                remote_connection_id: None,
                remote_ssh_host: None,
            }
        }
    }

    fn embedded_modes() -> Vec<AgentModeCatalogEntry> {
        vec![
            AgentModeCatalogEntry {
                id: "Standard".to_string(),
                route_key: "Standard".to_string(),
                description: "Primary workspace agent".to_string(),
                model_id: Some("primary-model".to_string()),
                is_external: false,
            },
            AgentModeCatalogEntry {
                id: "workspace-plan".to_string(),
                route_key: "external::workspace-plan".to_string(),
                description: "Workspace plan agent".to_string(),
                model_id: Some("plan-model".to_string()),
                is_external: true,
            },
        ]
    }

    #[derive(Clone)]
    struct FixtureSubmission {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentSubmissionPort for FixtureSubmission {
        async fn create_session(
            &self,
            request: AgentSessionCreateRequest,
        ) -> PortResult<AgentSessionCreateResult> {
            let session_id = format!("session-{}", uuid::Uuid::new_v4());
            self.state.insert_session(
                session_id.clone(),
                request.session_name.clone(),
                request.agent_type.clone(),
            );
            Ok(AgentSessionCreateResult::new(
                session_id,
                request.session_name,
                request.agent_type,
            ))
        }

        async fn submit_message(
            &self,
            request: AgentSubmissionRequest,
        ) -> PortResult<AgentSubmissionResult> {
            Ok(AgentSubmissionResult {
                turn_id: request
                    .turn_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                accepted: true,
            })
        }

        async fn resolve_session_agent_type(&self, session_id: &str) -> PortResult<Option<String>> {
            Ok(self
                .state
                .sessions
                .lock()
                .unwrap()
                .get(session_id)
                .map(|session| session.agent_type.clone()))
        }
    }

    #[derive(Clone)]
    struct FixtureSessionManagement {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentSessionManagementPort for FixtureSessionManagement {
        async fn list_sessions(
            &self,
            _request: AgentSessionListRequest,
        ) -> PortResult<Vec<openbitfun_agent_runtime::sdk::AgentSessionSummary>> {
            Ok(self
                .state
                .sessions
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect())
        }

        async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()> {
            self.state
                .sessions
                .lock()
                .unwrap()
                .remove(&request.session_id);
            self.state
                .transcripts
                .lock()
                .unwrap()
                .remove(&request.session_id);
            Ok(())
        }

        async fn rename_session(
            &self,
            request: openbitfun_agent_runtime::sdk::AgentSessionRenameRequest,
        ) -> PortResult<()> {
            let mut sessions = self.state.sessions.lock().unwrap();
            let session = sessions.get_mut(&request.session_id).ok_or_else(|| {
                PortError::new(PortErrorKind::NotFound, "fixture session not found")
            })?;
            session.session_name = request.session_name;
            Ok(())
        }

        async fn resolve_session_workspace_binding(
            &self,
            request: AgentSessionWorkspaceRequest,
        ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
            Ok(self
                .state
                .sessions
                .lock()
                .unwrap()
                .contains_key(&request.session_id)
                .then(|| self.state.workspace_binding()))
        }
    }

    #[derive(Clone)]
    struct FixtureRestore {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentSessionRestorePort for FixtureRestore {
        async fn restore_session(
            &self,
            request: AgentSessionRestoreRequest,
        ) -> PortResult<AgentSessionRestoreResult> {
            let session = self
                .state
                .sessions
                .lock()
                .unwrap()
                .get(&request.session_id)
                .cloned()
                .ok_or_else(|| {
                    PortError::new(PortErrorKind::NotFound, "fixture session not found")
                })?;
            Ok(AgentSessionRestoreResult {
                session,
                state: SessionState::Idle,
            })
        }
    }

    #[derive(Clone)]
    struct FixtureTranscript {
        state: FixtureState,
    }

    #[async_trait]
    impl SessionTranscriptReader for FixtureTranscript {
        async fn read_session_transcript(
            &self,
            request: SessionTranscriptRequest,
        ) -> PortResult<SessionTranscript> {
            Ok(self
                .state
                .transcripts
                .lock()
                .unwrap()
                .get(&request.session_id)
                .cloned()
                .unwrap_or_else(|| SessionTranscript {
                    session_id: request.session_id,
                    messages: Vec::new(),
                }))
        }
    }

    #[derive(Clone)]
    struct FixtureDialogTurn {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentDialogTurnPort for FixtureDialogTurn {
        async fn submit_dialog_turn(
            &self,
            request: AgentDialogTurnRequest,
        ) -> PortResult<DialogSubmitOutcome> {
            let session_id = request.session_id.clone();
            let turn_id = request
                .turn_id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            self.state
                .event_queue
                .enqueue(
                    AgenticEvent::DialogTurnCompleted {
                        session_id: session_id.clone(),
                        turn_id: turn_id.clone(),
                        total_rounds: 1,
                        total_tools: 0,
                        duration_ms: 1,
                        partial_recovery_reason: None,
                        success: Some(true),
                        finish_reason: Some("fixture-complete".to_string()),
                        has_final_response: Some(true),
                    },
                    None,
                )
                .await
                .expect("fixture turn completion event should enqueue");
            Ok(DialogSubmitOutcome::Started {
                session_id,
                turn_id,
            })
        }
    }

    #[derive(Clone)]
    struct FixtureCancellation {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentTurnCancellationPort for FixtureCancellation {
        async fn cancel_turn(
            &self,
            request: AgentTurnCancellationRequest,
        ) -> PortResult<AgentTurnCancellationResult> {
            self.state
                .cancellation_requests
                .lock()
                .unwrap()
                .push(request.clone());
            Ok(AgentTurnCancellationResult {
                session_id: request.session_id,
                turn_id: request.turn_id,
                requested: true,
            })
        }
    }

    #[derive(Clone)]
    struct FixtureSettlement {
        state: FixtureState,
    }

    #[async_trait]
    impl AgentTurnSettlementPort for FixtureSettlement {
        async fn wait_for_turn_settlement(
            &self,
            request: AgentTurnSettlementRequest,
        ) -> PortResult<AgentTurnSettlementResult> {
            match self
                .state
                .settlement_outcomes
                .lock()
                .unwrap()
                .get(&request.turn_id)
                .cloned()
            {
                Some(Some(error)) => Err(error),
                _ => Ok(AgentTurnSettlementResult {
                    status: AgentTurnSettlementStatus::Completed,
                    final_response: Some("fixture result".to_string()),
                    finish_reason: Some("stop".to_string()),
                }),
            }
        }
    }

    #[derive(Clone)]
    struct FixtureModeCatalog(Vec<AgentModeCatalogEntry>);

    #[async_trait]
    impl AgentModeCatalogPort for FixtureModeCatalog {
        async fn list_modes(
            &self,
            _query: AgentModeCatalogQuery,
        ) -> PortResult<Vec<AgentModeCatalogEntry>> {
            Ok(self.0.clone())
        }
    }

    #[derive(Default)]
    struct MemoryPermissionStore {
        audit: StdMutex<Vec<PermissionAuditRecord>>,
    }

    impl RuntimeServicePort for MemoryPermissionStore {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Permission
        }
    }

    #[async_trait]
    impl PermissionAuditStorePort for MemoryPermissionStore {
        async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()> {
            self.audit.lock().unwrap().push(record);
            Ok(())
        }

        async fn list_project_permission_audit(
            &self,
            project_id: &str,
        ) -> PortResult<Vec<PermissionAuditRecord>> {
            Ok(self
                .audit
                .lock()
                .unwrap()
                .iter()
                .filter(|record| record.request.project_id == project_id)
                .cloned()
                .collect())
        }
    }

    #[async_trait]
    impl PermissionReplyStorePort for MemoryPermissionStore {
        async fn commit_permission_reply(
            &self,
            _grants: Vec<openbitfun_agent_runtime::sdk::PermissionGrant>,
            audit: Vec<PermissionAuditRecord>,
        ) -> PortResult<()> {
            self.audit.lock().unwrap().extend(audit);
            Ok(())
        }
    }

    #[derive(Debug)]
    struct FixedClock;

    impl RuntimeServicePort for FixedClock {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Clock
        }
    }

    impl ClockPort for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            42
        }
    }

    struct Fixture {
        state: FixtureState,
        runtime: AgentRuntime,
        workspace: PathBuf,
        queue: Arc<EventQueue>,
        permission_manager: Arc<PermissionRequestManager>,
    }

    impl Fixture {
        fn new(workspace: &Path, workspace_id: &str) -> Self {
            let workspace = dunce::canonicalize(workspace).expect("canonical workspace");
            let state = FixtureState::new(workspace.clone(), workspace_id.to_string());
            let queue = state.event_queue.clone();
            let event_source = AgentEventSource::new(queue.clone());
            let store = Arc::new(MemoryPermissionStore::default());
            let permission_manager = Arc::new(PermissionRequestManager::new(
                store.clone(),
                store,
                Arc::new(FixedClock),
            ));
            let runtime = AgentRuntimeBuilder::new()
                .with_submission_port(Arc::new(FixtureSubmission {
                    state: state.clone(),
                }))
                .with_session_management_port(Arc::new(FixtureSessionManagement {
                    state: state.clone(),
                }))
                .with_session_restore_port(Arc::new(FixtureRestore {
                    state: state.clone(),
                }))
                .with_session_transcript_reader(Arc::new(FixtureTranscript {
                    state: state.clone(),
                }))
                .with_dialog_turn_port(Arc::new(FixtureDialogTurn {
                    state: state.clone(),
                }))
                .with_cancellation_port(Arc::new(FixtureCancellation {
                    state: state.clone(),
                }))
                .with_turn_settlement_port(Arc::new(FixtureSettlement {
                    state: state.clone(),
                }))
                .with_mode_catalog(Arc::new(FixtureModeCatalog(embedded_modes())))
                .with_permission_request_manager(permission_manager.clone())
                .with_event_source(event_source)
                .build()
                .expect("fixture runtime should build");
            Self {
                state,
                runtime,
                workspace,
                queue,
                permission_manager,
            }
        }

        fn embedded_client(&self) -> CliAgentRuntimeClient {
            CliAgentRuntimeClient::new_embedded_for_test(
                self.runtime.clone(),
                Some(self.workspace.clone()),
                Some(self.state.workspace_id.clone()),
            )
        }
    }

    #[test]
    fn embedded_client_preserves_managed_workspace_binding() {
        let root = tempfile::tempdir().expect("workspace root");
        let workspace = dunce::canonicalize(root.path()).expect("canonical workspace");
        let fixture = Fixture::new(&workspace, "workspace-1");
        let client = fixture.embedded_client();
        let binding = AgentSessionWorkspaceBinding {
            workspace_kind: None,
            project_workspace_id: None,
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: workspace.join("managed-worktree").display().to_string(),
            project_workspace_path: Some(workspace.display().to_string()),
            execution_target: Some(SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some("worktree-1".to_string()),
                root_path: workspace.join("managed-worktree").display().to_string(),
                base_ref: Some("main".to_string()),
                base_commit: Some("123456789abcdef".to_string()),
                branch: None,
                lifecycle: Some(WorktreeLifecycle::Managed),
            }),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        client.set_workspace_binding(&binding);

        assert_eq!(client.current_workspace_binding(), binding);
    }

    async fn shared_backend(
        fixture: &Fixture,
    ) -> (
        tempfile::TempDir,
        RuntimeIpcClient,
        tokio::task::JoinHandle<()>,
    ) {
        let root = tempfile::tempdir().expect("runtime root");
        let identity = fixture_identity();

        let handler = Arc::new(
            SharedRuntimeHandler::build_for_test(
                fixture.runtime.clone(),
                &fixture.workspace,
                &fixture.state.workspace_id,
            )
            .expect("shared runtime handler"),
        );
        let server = RuntimeIpcServer::bind_with_handler(
            root.path(),
            identity,
            RuntimeIpcServerConfig {
                server_version: "fixture".to_string(),
                idle_timeout: Duration::from_secs(5),
                handshake_timeout: Duration::from_secs(2),
                request_timeout: Duration::from_secs(2),
                max_connections: 8,
            },
            handler,
        )
        .await
        .expect("shared runtime server");
        let discovery = server.discovery_record().clone();
        let server_task = tokio::spawn(async move {
            let _ = server.serve().await;
        });
        let client = RuntimeIpcClient::connect(
            root.path(),
            &discovery,
            "fixture-client",
            "1",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .await
        .expect("shared runtime client");
        (root, client, server_task)
    }

    async fn shared_client(
        fixture: &Fixture,
    ) -> (
        tempfile::TempDir,
        CliAgentRuntimeClient,
        tokio::task::JoinHandle<()>,
    ) {
        let (root, client, server_task) = shared_backend(fixture).await;
        ensure_isolated_workspace_catalog().await;
        (
            root,
            CliAgentRuntimeClient::new_shared(
                client,
                &crate::create_cli_local_workspace(&fixture.workspace)
                    .await
                    .unwrap(),
            ),
            server_task,
        )
    }

    #[derive(Debug, PartialEq)]
    struct ScenarioSnapshot {
        mode_ids: Vec<String>,
        created_session_agent_type: String,
        listed_session_count: usize,
        renamed_session_name: Option<String>,
        turn_has_id: bool,
        settlement_ok: bool,
        cancellation_requested: bool,
        permission_seen: bool,
        permission_cleared: bool,
        restore_session_agent_type: Option<String>,
        restore_transcript_messages: usize,
        event_states: Vec<String>,
        remaining_session_count: usize,
    }

    async fn wait_until<F>(mut predicate: F)
    where
        F: FnMut() -> bool,
    {
        for _ in 0..50 {
            if predicate() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("condition was not satisfied before timeout");
    }

    fn fixture_permission_request(session_id: &str) -> PermissionRequest {
        PermissionRequest {
            request_id: "permission-1".to_string(),
            round_id: "round-1".to_string(),
            order: 0,
            tool_call_id: None,
            project_path: None,
            project_id: "project-1".to_string(),
            session_id: session_id.to_string(),
            agent_id: "Standard".to_string(),
            action: "edit".to_string(),
            resources: vec!["src/main.rs".to_string()],
            save_resources: vec!["src/main.rs".to_string()],
            source: PermissionRequestSource {
                kind: PermissionRequestSourceKind::ToolCall,
                identity: "write_file".to_string(),
            },
            delegation: None,
            display_metadata: serde_json::Map::new(),
        }
    }

    async fn observe_backend(
        client: &CliAgentRuntimeClient,
        fixture: &Fixture,
    ) -> ScenarioSnapshot {
        let modes = client.available_agent_modes().await.expect("modes");
        let created_id = client
            .create_new_session("Standard")
            .await
            .expect("create session");
        let listed = client.list_sessions().await.expect("list sessions");
        let created_session = listed
            .iter()
            .find(|session| session.session_id == created_id)
            .expect("created session should be listed");
        client
            .rename_session(&created_id, "renamed-session")
            .await
            .expect("rename session");
        let renamed_session = client
            .list_sessions()
            .await
            .expect("list renamed sessions")
            .into_iter()
            .find(|session| session.session_id == created_id);

        let turn_id = client
            .send_message("hello".to_string(), "Standard")
            .await
            .expect("send message");
        client
            .wait_for_turn_settlement(&created_id, &turn_id, 100)
            .await
            .expect("turn settlement");
        client.cancel_current_turn().await.expect("cancel turn");
        let cancellation_requested = fixture
            .state
            .cancellation_requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| {
                request.session_id == created_id && request.turn_id.as_deref() == Some(&turn_id)
            });

        let mut events = client.subscribe_events().expect("agent events");
        fixture
            .queue
            .enqueue(
                AgenticEvent::SessionStateChanged {
                    session_id: created_id.clone(),
                    new_state: "first".to_string(),
                },
                None,
            )
            .await
            .expect("enqueue first event");
        fixture
            .queue
            .enqueue(
                AgenticEvent::SessionStateChanged {
                    session_id: created_id.clone(),
                    new_state: "second".to_string(),
                },
                None,
            )
            .await
            .expect("enqueue second event");
        let mut event_states = Vec::new();
        for _ in 0..2 {
            let envelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("event timeout")
                .expect("event received");
            match envelope.event {
                AgenticEvent::SessionStateChanged { new_state, .. } => event_states.push(new_state),
                _ => panic!("unexpected event kind"),
            }
        }

        let request = fixture_permission_request(&created_id);
        fixture
            .permission_manager
            .register(request.clone())
            .await
            .expect("register permission");
        wait_until(|| {
            client
                .pending_permission_requests()
                .expect("pending permissions")
                .iter()
                .any(|pending| pending.request_id == request.request_id)
        })
        .await;
        let permission_seen = true;
        client
            .respond_permission(&request.request_id, PermissionReply::Once)
            .await
            .expect("respond permission");
        wait_until(|| {
            client
                .pending_permission_requests()
                .expect("pending permissions")
                .iter()
                .all(|pending| pending.request_id != request.request_id)
        })
        .await;
        let permission_cleared = true;

        let (restored, _binding, _notices, transcript) = client
            .restore_session_in_current_workspace(&created_id)
            .await
            .expect("restore session");

        fixture.state.insert_session(
            "orphan-session".to_string(),
            "orphan".to_string(),
            "Standard".to_string(),
        );
        client
            .delete_session("orphan-session")
            .await
            .expect("delete uncontrolled session");
        let remaining_session_count = client
            .list_sessions()
            .await
            .expect("list after delete")
            .len();

        ScenarioSnapshot {
            mode_ids: modes.into_iter().map(|mode| mode.id).collect(),
            created_session_agent_type: created_session.agent_type.clone(),
            listed_session_count: 1,
            renamed_session_name: renamed_session.map(|session| session.session_name),
            turn_has_id: !turn_id.is_empty(),
            settlement_ok: true,
            cancellation_requested,
            permission_seen,
            permission_cleared,
            restore_session_agent_type: Some(restored.agent_type),
            restore_transcript_messages: transcript.messages.len(),
            event_states,
            remaining_session_count,
        }
    }

    #[tokio::test]
    async fn embedded_and_shared_questions_stop_timeout_and_cancel_without_an_answer() {
        use openbitfun_agent_runtime::user_questions::{
            get_user_input_manager, PendingUserQuestion,
        };
        let root = tempfile::tempdir().unwrap();
        let workspace = dunce::canonicalize(root.path()).unwrap();
        let workspace_id = open_fixture_workspace(&workspace).await;
        for shared in [false, true] {
            let fixture = Fixture::new(&workspace, &workspace_id);
            let shared_backend = if shared {
                Some(shared_client(&fixture).await)
            } else {
                None
            };
            let embedded = fixture.embedded_client();
            let client = shared_backend
                .as_ref()
                .map(|(_, client, _)| client)
                .unwrap_or(&embedded);
            let session_id = client.create_new_session("Standard").await.unwrap();
            let tool_id = format!("question-interaction-{shared}");
            let manager = get_user_input_manager();
            let (sender, mut receiver) = tokio::sync::oneshot::channel();
            let _registration = manager.register_question(
                PendingUserQuestion::new(
                    tool_id.clone(),
                    session_id.clone(),
                    None,
                    None,
                    serde_json::json!({}),
                ),
                sender,
            );
            client.start_question_interaction(&tool_id).await.unwrap();
            assert!(
                manager.pending_question_snapshot(&session_id).questions[0].interaction_started
            );
            assert!(matches!(
                receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ));
            client.cancel_user_question(&tool_id).await.unwrap();
            assert!(receiver.await.is_err());
            assert!(!manager.has_pending(&tool_id));
            if let Some((_, _, server)) = shared_backend {
                server.abort();
            }
        }
    }

    #[tokio::test]
    async fn embedded_and_shared_clients_are_behaviorally_equivalent() {
        let root = tempfile::tempdir().expect("workspace root");
        let workspace = dunce::canonicalize(root.path()).expect("canonical workspace");
        let workspace_id = open_fixture_workspace(&workspace).await;

        let embedded_fixture = Fixture::new(&workspace, &workspace_id);
        let embedded_client = embedded_fixture.embedded_client();
        let embedded = observe_backend(&embedded_client, &embedded_fixture).await;

        let shared_fixture = Fixture::new(&workspace, &workspace_id);
        let (_root, shared_client, _server_task) = shared_client(&shared_fixture).await;
        let shared = observe_backend(&shared_client, &shared_fixture).await;

        assert_eq!(embedded, shared);
        assert_eq!(
            embedded.mode_ids,
            ["Standard".to_string(), "workspace-plan".to_string()]
        );
        assert_eq!(embedded.created_session_agent_type, "Standard");
        assert_eq!(embedded.listed_session_count, 1);
        assert_eq!(
            embedded.renamed_session_name.as_deref(),
            Some("renamed-session")
        );
        assert!(embedded.turn_has_id);
        assert!(embedded.settlement_ok);
        assert!(embedded.cancellation_requested);
        assert!(embedded.permission_seen);
        assert!(embedded.permission_cleared);
        assert_eq!(
            embedded.restore_session_agent_type.as_deref(),
            Some("Standard")
        );
        assert_eq!(embedded.restore_transcript_messages, 0);
        assert_eq!(embedded.event_states, ["first", "second"]);
        assert_eq!(embedded.remaining_session_count, 1);
    }

    #[tokio::test]
    async fn embedded_and_shared_clients_preserve_outcome_unknown() {
        let root = tempfile::tempdir().expect("workspace root");
        let workspace = dunce::canonicalize(root.path()).expect("canonical workspace");
        let workspace_id = open_fixture_workspace(&workspace).await;

        for shared in [false, true] {
            let fixture = Fixture::new(&workspace, &workspace_id);
            let (_root, client, _server_task);
            if shared {
                let tuple = shared_client(&fixture).await;
                _root = tuple.0;
                client = tuple.1;
                _server_task = tuple.2;
            } else {
                _root = tempfile::tempdir().expect("unused root");
                client = fixture.embedded_client();
                _server_task = tokio::spawn(async {});
            }

            let session_id = client
                .create_new_session("Standard")
                .await
                .expect("create session");
            let turn_id = client
                .send_message("hello".to_string(), "Standard")
                .await
                .expect("send message");
            fixture.state.settlement_outcomes.lock().unwrap().insert(
                turn_id.clone(),
                Some(PortError::new(
                    PortErrorKind::OutcomeUnknown,
                    "fixture settlement outcome is unknown",
                )),
            );

            let error = client
                .wait_for_turn_settlement(&session_id, &turn_id, 100)
                .await
                .expect_err("unknown settlement must surface");
            assert!(matches!(
                error,
                RuntimeError::Port(PortError {
                    kind: PortErrorKind::OutcomeUnknown,
                    ..
                })
            ));
        }
    }

    #[tokio::test]
    async fn shared_handler_rejects_remote_lineage_scope() {
        let root = tempfile::tempdir().expect("workspace root");
        let workspace = dunce::canonicalize(root.path()).expect("canonical workspace");
        let workspace_id = open_fixture_workspace(&workspace).await;
        let fixture = Fixture::new(&workspace, &workspace_id);
        let (_root, client, _server_task) = shared_backend(&fixture).await;

        let create_request = AgentSessionCreateRequest {
            session_name: "remote-unsupported-session".to_string(),
            agent_type: "Standard".to_string(),
            agent_route_key: None,
            workspace_path: Some(fixture.workspace.to_string_lossy().into_owned()),
            project_workspace_path: Some(fixture.workspace.to_string_lossy().into_owned()),
            execution_target: Some(SessionExecutionTarget::local(
                fixture.workspace.to_string_lossy().into_owned(),
            )),
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            metadata: serde_json::Map::new(),
        };
        let created = client
            .request(RuntimeIpcOperation::CreateSession {
                request: create_request,
            })
            .await
            .expect("create session over shared handler");
        let RuntimeIpcOperationResult::SessionCreated { session } = created else {
            panic!("unexpected create session result");
        };

        let response = client
            .request(RuntimeIpcOperation::GetSessionLineage {
                request: openbitfun_agent_runtime::sdk::AgentSessionLineageRequest {
                    workspace_id: None,
                    workspace_path: fixture.workspace.to_string_lossy().into_owned(),
                    anchor_session_id: session.session_id,
                    remote_connection_id: Some("remote-connection".to_string()),
                    remote_ssh_host: None,
                },
            })
            .await;
        match response {
            Err(RuntimeIpcClientError::Remote(error))
                if error.code == RuntimeIpcErrorCode::SessionMismatch => {}
            other => panic!("remote lineage scope must fail closed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn shared_disconnect_projects_system_error_event() {
        let root = tempfile::tempdir().expect("workspace root");
        let workspace = dunce::canonicalize(root.path()).expect("canonical workspace");
        let workspace_id = open_fixture_workspace(&workspace).await;
        let fixture = Fixture::new(&workspace, &workspace_id);
        let (_root, client, server_task) = shared_client(&fixture).await;
        let mut events = client
            .subscribe_events()
            .expect("shared event subscription");

        server_task.abort();

        let envelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("disconnect event timeout")
            .expect("disconnect event received");
        assert!(matches!(
            envelope.event,
            AgenticEvent::SystemError {
                recoverable: false,
                ..
            }
        ));
    }
}
