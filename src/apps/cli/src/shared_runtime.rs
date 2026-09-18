use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::{
    AgentModeCatalogQuery, AgentRuntime, AgentSessionDeleteRequest,
    AgentSessionForkBeforeTurnRequest, AgentSessionForkRequest, AgentSessionRenameRequest,
    AgentSessionRestoreRequest, AgentUserAnswersRequest, DialogSubmitOutcome, PermissionRequest,
    PermissionRequestEvent, PortErrorKind, RuntimeError, SessionTranscriptRequest,
};
use openbitfun_agent_runtime_ipc::{
    DiscoveryStore, RuntimeAgentModeSummary, RuntimeInstanceIdentity, RuntimeIpcClient,
    RuntimeIpcError, RuntimeIpcErrorCode, RuntimeIpcEvent, RuntimeIpcOperation,
    RuntimeIpcOperationResult, RuntimeIpcRequestHandler, RuntimeIpcServer, RuntimeIpcServerConfig,
    RuntimeIpcStreamInvalidationReason, RuntimeSessionProcessingPhase, RuntimeSessionRenameRequest,
    RuntimeSessionState, PROTOCOL_VERSION,
};
use openbitfun_core::product_runtime::CoreAgentRuntimeCompatibility;
use openbitfun_core::runtime_ownership::CoreRuntimeOwnership;
use openbitfun_events::{AgenticEvent, ToolEventData};
use openbitfun_runtime_ports::{AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest};
use openbitfun_services_core::runtime_ownership::RuntimeDeployment;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch, Notify};

const RELEASE_CHANNEL: &str = "stable";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const SERVER_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const CLIENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(125);
const EVENT_BUFFER: usize = 256;
const SUBAGENT_ROUTE_TIMEOUT: Duration = Duration::from_secs(2);
type SessionEventSenders = Mutex<HashMap<String, broadcast::Sender<RuntimeIpcEvent>>>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct SubagentRoute {
    root_session_id: String,
    root_turn_id: String,
    root_tool_call_id: String,
    source_turn_id: String,
}

type SubagentRoutes = Mutex<HashMap<String, SubagentRoute>>;

pub(crate) struct SharedRuntimeHandler {
    workspace_id: Option<String>,
    runtime: AgentRuntime,
    compatibility: Option<CoreAgentRuntimeCompatibility>,
    workspace: PathBuf,
    events: Arc<SessionEventSenders>,
    question_sessions: Arc<Mutex<HashMap<String, String>>>,
    subagent_routes: Arc<SubagentRoutes>,
    event_stream_available: watch::Sender<bool>,
}

impl SharedRuntimeHandler {
    pub(crate) fn build(
        runtime: AgentRuntime,
        compatibility: CoreAgentRuntimeCompatibility,
        workspace: &openbitfun_core::service::workspace::WorkspaceInfo,
    ) -> Result<Self> {
        Self::build_optional(
            runtime,
            Some(compatibility),
            &workspace.root_path,
            Some(workspace.id.clone()),
        )
    }

    #[cfg(test)]
    pub(crate) fn build_for_test(
        runtime: AgentRuntime,
        workspace: &Path,
        workspace_id: &str,
    ) -> Result<Self> {
        Self::build_optional(runtime, None, workspace, Some(workspace_id.to_string()))
    }

    fn build_optional(
        runtime: AgentRuntime,
        compatibility: Option<CoreAgentRuntimeCompatibility>,
        workspace: &Path,
        workspace_id: Option<String>,
    ) -> Result<Self> {
        let mut agent_events = runtime
            .subscribe_events()
            .map_err(runtime_error_message)
            .context("subscribe Shared Runtime agent events")?;
        let mut permission_events = runtime
            .subscribe_permission_requests()
            .map_err(runtime_error_message)
            .context("subscribe Shared Runtime permission events")?;
        let events = Arc::new(Mutex::new(HashMap::new()));
        let permission_sessions = Arc::new(Mutex::new(HashMap::new()));
        let question_sessions = Arc::new(Mutex::new(HashMap::new()));
        let subagent_routes = Arc::new(SubagentRoutes::new(HashMap::new()));
        let route_updates = Arc::new(Notify::new());
        let (event_stream_available, _) = watch::channel(true);

        let agent_output = events.clone();
        let agent_questions = question_sessions.clone();
        let agent_routes = subagent_routes.clone();
        let agent_route_updates = route_updates.clone();
        let agent_stream_available = event_stream_available.clone();
        tokio::spawn(async move {
            loop {
                match agent_events.recv().await {
                    Ok(mut envelope) => {
                        let Some(source_session_id) =
                            envelope.event.session_id().map(ToOwned::to_owned)
                        else {
                            continue;
                        };
                        let (session_id, routed_turn_id, routed_tool_call_id) =
                            route_agent_event(&envelope.event, &source_session_id, &agent_routes);
                        project_subagent_link_route(
                            &mut envelope.event,
                            &session_id,
                            routed_turn_id.as_deref(),
                            routed_tool_call_id.as_deref(),
                        );
                        project_user_question_route(
                            &mut envelope.event,
                            &session_id,
                            routed_turn_id.as_deref(),
                        );
                        if matches!(envelope.event, AgenticEvent::SubagentSessionLinked { .. }) {
                            agent_route_updates.notify_waiters();
                        }
                        index_user_question(&envelope.event, &session_id, &agent_questions);
                        publish_event(
                            &agent_output,
                            &session_id,
                            RuntimeIpcEvent::Agent {
                                session_id: session_id.clone(),
                                envelope,
                            },
                        );
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        invalidate_event_stream(
                            &agent_stream_available,
                            &agent_output,
                            RuntimeIpcStreamInvalidationReason::Lagged,
                        );
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        invalidate_event_stream(
                            &agent_stream_available,
                            &agent_output,
                            RuntimeIpcStreamInvalidationReason::Closed,
                        );
                        break;
                    }
                }
            }
        });

        let permission_output = events.clone();
        let permission_index = permission_sessions.clone();
        let permission_routes = subagent_routes.clone();
        let permission_route_updates = route_updates.clone();
        let permission_stream_available = event_stream_available.clone();
        tokio::spawn(async move {
            loop {
                let event = match permission_events.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        invalidate_event_stream(
                            &permission_stream_available,
                            &permission_output,
                            RuntimeIpcStreamInvalidationReason::Lagged,
                        );
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        invalidate_event_stream(
                            &permission_stream_available,
                            &permission_output,
                            RuntimeIpcStreamInvalidationReason::Closed,
                        );
                        break;
                    }
                };
                if let PermissionRequestEvent::Asked { request } = &event {
                    if !await_permission_route(
                        request,
                        &permission_routes,
                        &permission_route_updates,
                    )
                    .await
                    {
                        invalidate_event_stream(
                            &permission_stream_available,
                            &permission_output,
                            RuntimeIpcStreamInvalidationReason::Closed,
                        );
                        break;
                    }
                }
                let session_id =
                    permission_event_session(&event, &permission_index, &permission_routes);
                if let Some(session_id) = session_id {
                    publish_event(
                        &permission_output,
                        &session_id,
                        RuntimeIpcEvent::Permission {
                            session_id: session_id.clone(),
                            event,
                        },
                    );
                }
            }
        });

        Ok(Self {
            workspace_id,
            runtime,
            compatibility,
            workspace: dunce::canonicalize(workspace)
                .context("canonicalize Shared Runtime workspace")?,
            events,
            question_sessions,
            subagent_routes,
            event_stream_available,
        })
    }
}

#[async_trait]
impl RuntimeIpcRequestHandler for SharedRuntimeHandler {
    fn ensure_available(&self) -> std::result::Result<(), RuntimeIpcError> {
        (*self.event_stream_available.borrow())
            .then_some(())
            .ok_or_else(event_stream_unavailable_error)
    }

    fn subscribe_availability(&self) -> Option<watch::Receiver<bool>> {
        Some(self.event_stream_available.subscribe())
    }

    async fn execute(
        &self,
        operation: RuntimeIpcOperation,
    ) -> std::result::Result<RuntimeIpcOperationResult, RuntimeIpcError> {
        self.validate_workspace(&operation)?;
        match operation {
            RuntimeIpcOperation::Health => unreachable!("Health is owned by the IPC server"),
            RuntimeIpcOperation::ListAgentModes { session_id } => {
                let binding = match session_id {
                    Some(session_id) => self.session_workspace_binding(&session_id).await?,
                    None => AgentSessionWorkspaceBinding {
                        workspace_kind: Some(
                            openbitfun_core::service::workspace::WorkspaceKind::Normal,
                        ),
                        project_workspace_id: self.workspace_id.clone(),
                        workspace_id: self.workspace_id.clone(),
                        workspace_path: self.workspace.to_string_lossy().to_string(),
                        project_workspace_path: Some(self.workspace.to_string_lossy().to_string()),
                        execution_target: Some(
                            openbitfun_runtime_ports::SessionExecutionTarget::local(
                                self.workspace.to_string_lossy().to_string(),
                            ),
                        ),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    },
                };
                if let Err(error) = self.ensure_plugin_workspace_ready(&binding).await {
                    tracing::warn!(
                        "Configured plugin activation failed while loading Shared Runtime agent modes; continuing with native agents: {:?}",
                        error
                    );
                }
                if let Err(error) =
                    openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(
                        binding.workspace_id.as_deref(),
                    )
                    .await
                {
                    tracing::warn!(
                        "Failed to initialize external agent sources for Shared TUI mode catalog: {}",
                        error
                    );
                }
                let modes = self
                    .runtime
                    .list_agent_modes(AgentModeCatalogQuery {
                        workspace_id: binding.workspace_id.clone(),
                        workspace_root: None,
                        include_external: true,
                    })
                    .await
                    .map_err(runtime_ipc_error)?
                    .into_iter()
                    .map(|mode| RuntimeAgentModeSummary {
                        id: mode.id,
                        route_key: mode.route_key,
                        description: mode.description,
                        model_id: mode.model_id,
                        is_external: mode.is_external,
                    })
                    .collect();
                Ok(RuntimeIpcOperationResult::AgentModes { modes })
            }
            RuntimeIpcOperation::ListSessions { request } => self
                .runtime
                .list_sessions(request)
                .await
                .map(|sessions| RuntimeIpcOperationResult::Sessions { sessions })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::CreateSession { request } => {
                let session = self
                    .runtime
                    .create_session(request)
                    .await
                    .map_err(runtime_ipc_error)?;
                let workspace_binding = self.session_workspace_binding(&session.session_id).await?;
                self.ensure_plugin_workspace_ready(&workspace_binding)
                    .await?;
                Ok(RuntimeIpcOperationResult::SessionCreated { session })
            }
            RuntimeIpcOperation::RestoreSession { request } => {
                let restored = self
                    .runtime
                    .restore_session(AgentSessionRestoreRequest {
                        workspace_id: request.workspace_id,
                        workspace_path: request.workspace_path,
                        session_id: request.session_id,
                        include_internal: false,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    })
                    .await
                    .map_err(runtime_ipc_error)?;
                let transcript = self
                    .runtime
                    .read_session_transcript(SessionTranscriptRequest {
                        session_id: restored.session.session_id.clone(),
                        turn_id: None,
                    })
                    .await
                    .map_err(runtime_ipc_error)?;
                let pending_permissions = self
                    .runtime
                    .pending_permission_requests()
                    .map_err(runtime_ipc_error)?
                    .into_iter()
                    .filter(|request| {
                        permission_targets_session(
                            request,
                            &restored.session.session_id,
                            &self.subagent_routes,
                        )
                    })
                    .collect();
                let workspace_binding = self
                    .session_workspace_binding(&restored.session.session_id)
                    .await?;
                self.ensure_plugin_workspace_ready(&workspace_binding)
                    .await?;
                Ok(RuntimeIpcOperationResult::SessionRestored {
                    session: restored.session,
                    state: runtime_session_state(restored.state),
                    workspace_binding,
                    transcript,
                    pending_permissions,
                })
            }
            RuntimeIpcOperation::ForkSession { request } => {
                let forked = match request.before_turn_id {
                    Some(source_turn_id) => {
                        self.runtime
                            .fork_session_before_turn(AgentSessionForkBeforeTurnRequest {
                                workspace_id: self.workspace_id.clone(),
                                workspace_path: String::new(),
                                source_session_id: request.session_id,
                                source_turn_id,
                                remote_connection_id: None,
                                remote_ssh_host: None,
                            })
                            .await
                    }
                    None => {
                        self.runtime
                            .fork_session(AgentSessionForkRequest {
                                workspace_id: self.workspace_id.clone(),
                                workspace_path: String::new(),
                                source_session_id: request.session_id,
                                remote_connection_id: None,
                                remote_ssh_host: None,
                            })
                            .await
                    }
                }
                .map_err(runtime_ipc_error)?;
                let restored = self
                    .runtime
                    .restore_session(AgentSessionRestoreRequest {
                        workspace_id: self.workspace_id.clone(),
                        workspace_path: String::new(),
                        session_id: forked.session_id.clone(),
                        include_internal: false,
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    })
                    .await
                    .map_err(runtime_ipc_error)?;
                let transcript = self
                    .runtime
                    .read_session_transcript(SessionTranscriptRequest {
                        session_id: forked.session_id,
                        turn_id: None,
                    })
                    .await
                    .map_err(runtime_ipc_error)?;
                let workspace_binding = self
                    .session_workspace_binding(&restored.session.session_id)
                    .await?;
                self.ensure_plugin_workspace_ready(&workspace_binding)
                    .await?;
                Ok(RuntimeIpcOperationResult::SessionForked {
                    session: restored.session,
                    workspace_binding,
                    transcript,
                })
            }
            RuntimeIpcOperation::DeleteSession { session_id } => {
                delete_owned_session(
                    &self.runtime,
                    self.workspace_id
                        .as_deref()
                        .ok_or_else(workspace_mismatch_error)?,
                    session_id,
                )
                .await?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::UpdateSessionMode { request } => {
                self.runtime
                    .update_session_mode(request)
                    .await
                    .map_err(runtime_ipc_error)?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::UpdateSessionModel { request } => {
                self.runtime
                    .update_session_model(request)
                    .await
                    .map_err(runtime_ipc_error)?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::RenameSession { request } => {
                rename_owned_session(
                    &self.runtime,
                    self.workspace_id
                        .as_deref()
                        .ok_or_else(workspace_mismatch_error)?,
                    request,
                )
                .await?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::ReloadSessionContext { request } => {
                self.compatibility
                    .as_ref()
                    .ok_or_else(|| RuntimeIpcError {
                        code: RuntimeIpcErrorCode::Unavailable,
                        message: "Shared Runtime context reload is unavailable".to_string(),
                    })?
                    .reload_session_context(request)
                    .await
                    .map_err(core_ipc_error)?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::CompactSession { request } => self
                .runtime
                .start_session_compaction(request)
                .await
                .map(|result| RuntimeIpcOperationResult::TurnAccepted {
                    session_id: result.session_id,
                    turn_id: result.turn_id,
                })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::UndoSession { request } => self
                .runtime
                .undo_session(request)
                .await
                .map(|revert| RuntimeIpcOperationResult::SessionReverted { revert })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::RedoSession { request } => self
                .runtime
                .redo_session(request)
                .await
                .map(|revert| RuntimeIpcOperationResult::SessionReverted { revert })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::SessionUsage { request } => self
                .runtime
                .generate_session_usage(request)
                .await
                .map(|usage| RuntimeIpcOperationResult::SessionUsage { usage })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::WaitForSettlement { request } => {
                self.runtime
                    .wait_for_turn_settlement(request)
                    .await
                    .map_err(runtime_ipc_error)?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::SearchWorkspaceReferences { request } => self
                .runtime
                .search_workspace_references(request)
                .await
                .map(|search| RuntimeIpcOperationResult::WorkspaceReferenceSearch { search })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::WorkspaceReferencesForMessage { request } => self
                .runtime
                .workspace_references_for_message(request)
                .await
                .map(|references| RuntimeIpcOperationResult::WorkspaceReferences { references })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::GetSessionLineage { request } => self
                .runtime
                .get_session_lineage(request)
                .await
                .map(|snapshot| RuntimeIpcOperationResult::SessionLineage { snapshot })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::InspectLineageSession { request } => self
                .runtime
                .read_lineage_session_transcript(request)
                .await
                .map(
                    |inspection| RuntimeIpcOperationResult::LineageSessionInspection { inspection },
                )
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::CancelLineageSession { request } => self
                .runtime
                .cancel_lineage_session(request)
                .await
                .map(|cancellation| RuntimeIpcOperationResult::TurnCancelled { cancellation })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::WorkspaceDiff => self
                .runtime
                .workspace_diff()
                .await
                .map(|snapshot| RuntimeIpcOperationResult::WorkspaceDiff { snapshot })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::SubmitTurn { request } => {
                let workspace_binding = self.session_workspace_binding(&request.session_id).await?;
                self.ensure_plugin_workspace_ready(&workspace_binding)
                    .await?;
                let outcome = self
                    .runtime
                    .submit_dialog_turn(request)
                    .await
                    .map_err(runtime_ipc_error)?;
                let (session_id, turn_id) = match outcome {
                    DialogSubmitOutcome::Started {
                        session_id,
                        turn_id,
                    }
                    | DialogSubmitOutcome::Queued {
                        session_id,
                        turn_id,
                    } => (session_id, turn_id),
                };
                Ok(RuntimeIpcOperationResult::TurnAccepted {
                    session_id,
                    turn_id,
                })
            }
            RuntimeIpcOperation::SteerTurn { request } => self
                .runtime
                .steer_dialog_turn(request)
                .await
                .map(|outcome| match outcome {
                    openbitfun_agent_runtime::sdk::DialogSteerOutcome::Buffered {
                        session_id,
                        turn_id,
                        steering_id,
                    } => RuntimeIpcOperationResult::TurnSteered {
                        session_id,
                        turn_id,
                        steering_id,
                    },
                })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::RunUserShellCommand { request } => {
                let workspace_binding = self.session_workspace_binding(&request.session_id).await?;
                self.ensure_plugin_workspace_ready(&workspace_binding)
                    .await?;
                self.runtime
                    .run_user_shell_command(request)
                    .await
                    .map(|result| RuntimeIpcOperationResult::TurnAccepted {
                        session_id: result.session_id,
                        turn_id: result.turn_id,
                    })
                    .map_err(runtime_ipc_error)
            }
            RuntimeIpcOperation::CancelTurn { request } => self
                .runtime
                .cancel_turn(request)
                .await
                .map(|cancellation| RuntimeIpcOperationResult::TurnCancelled { cancellation })
                .map_err(runtime_ipc_error),
            RuntimeIpcOperation::PendingPermissions { session_id } => {
                let requests = self
                    .runtime
                    .pending_permission_requests()
                    .map_err(runtime_ipc_error)?
                    .into_iter()
                    .filter(|request| {
                        permission_targets_session(request, &session_id, &self.subagent_routes)
                    })
                    .collect();
                Ok(RuntimeIpcOperationResult::PendingPermissions { requests })
            }
            RuntimeIpcOperation::RespondPermission {
                session_id,
                request_id,
                reply,
            } => {
                let permitted = self
                    .runtime
                    .pending_permission_requests()
                    .map_err(runtime_ipc_error)?
                    .iter()
                    .any(|request| {
                        request.request_id == request_id
                            && permission_targets_session(
                                request,
                                &session_id,
                                &self.subagent_routes,
                            )
                    });
                if !permitted {
                    return Err(RuntimeIpcError {
                        code: RuntimeIpcErrorCode::SessionMismatch,
                        message: "permission request does not belong to the controlled session"
                            .to_string(),
                    });
                }
                self.runtime
                    .respond_permission(&request_id, reply)
                    .await
                    .map_err(runtime_ipc_error)?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::CancelUserQuestion {
                session_id,
                tool_id,
            } => {
                self.runtime
                    .cancel_user_question(&session_id, &tool_id)
                    .map_err(|error| RuntimeIpcError {
                        code: RuntimeIpcErrorCode::SessionMismatch,
                        message: error.to_string(),
                    })?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::StartQuestionInteraction {
                session_id,
                tool_id,
            } => {
                self.runtime
                    .start_user_question_interaction(&session_id, &tool_id)
                    .map_err(|error| RuntimeIpcError {
                        code: RuntimeIpcErrorCode::SessionMismatch,
                        message: error.to_string(),
                    })?;
                Ok(RuntimeIpcOperationResult::Unit)
            }
            RuntimeIpcOperation::SubmitUserAnswers { request } => {
                let permitted = self
                    .question_sessions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(&request.tool_id)
                    .is_some_and(|session_id| session_id == &request.session_id);
                if !permitted {
                    return Err(RuntimeIpcError {
                        code: RuntimeIpcErrorCode::SessionMismatch,
                        message: "user-input request does not belong to the controlled session"
                            .to_string(),
                    });
                }
                self.runtime
                    .submit_user_answers(AgentUserAnswersRequest {
                        tool_id: request.tool_id.clone(),
                        answers: request.answers,
                    })
                    .await
                    .map_err(runtime_ipc_error)?;
                self.question_sessions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&request.tool_id);
                Ok(RuntimeIpcOperationResult::Unit)
            }
        }
    }

    fn subscribe_events(
        &self,
        session_id: &str,
    ) -> std::result::Result<broadcast::Receiver<RuntimeIpcEvent>, RuntimeIpcError> {
        subscribe_session_events(&self.events, &self.event_stream_available, session_id)
    }
}

fn runtime_session_state(
    state: openbitfun_agent_runtime::sdk::SessionState,
) -> RuntimeSessionState {
    use openbitfun_agent_runtime::sdk::{ProcessingPhase, SessionState};

    match state {
        SessionState::Idle => RuntimeSessionState::Idle,
        SessionState::Processing {
            current_turn_id,
            phase,
        } => RuntimeSessionState::Processing {
            current_turn_id,
            phase: match phase {
                ProcessingPhase::Starting => RuntimeSessionProcessingPhase::Starting,
                ProcessingPhase::Compacting => RuntimeSessionProcessingPhase::Compacting,
                ProcessingPhase::Thinking => RuntimeSessionProcessingPhase::Thinking,
                ProcessingPhase::Streaming => RuntimeSessionProcessingPhase::Streaming,
                ProcessingPhase::ToolCalling => RuntimeSessionProcessingPhase::ToolCalling,
                ProcessingPhase::ToolConfirming => RuntimeSessionProcessingPhase::ToolConfirming,
            },
        },
        SessionState::Error { error, recoverable } => {
            RuntimeSessionState::Error { error, recoverable }
        }
    }
}

fn owned_session_rename_request(
    workspace_id: &str,
    request: RuntimeSessionRenameRequest,
) -> AgentSessionRenameRequest {
    AgentSessionRenameRequest {
        workspace_id: Some(workspace_id.to_owned()),
        workspace_path: String::new(),
        session_id: request.session_id,
        session_name: request.session_name,
        remote_connection_id: None,
        remote_ssh_host: None,
    }
}

async fn rename_owned_session(
    runtime: &AgentRuntime,
    workspace_id: &str,
    request: RuntimeSessionRenameRequest,
) -> std::result::Result<(), RuntimeIpcError> {
    runtime
        .rename_session(owned_session_rename_request(workspace_id, request))
        .await
        .map_err(runtime_ipc_error)
}

async fn delete_owned_session(
    runtime: &AgentRuntime,
    workspace_id: &str,
    session_id: String,
) -> std::result::Result<(), RuntimeIpcError> {
    runtime
        .delete_session(AgentSessionDeleteRequest {
            workspace_id: Some(workspace_id.to_owned()),
            workspace_path: String::new(),
            session_id,
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .map_err(runtime_ipc_error)
}

fn subscribe_session_events(
    events: &SessionEventSenders,
    available: &watch::Sender<bool>,
    session_id: &str,
) -> std::result::Result<broadcast::Receiver<RuntimeIpcEvent>, RuntimeIpcError> {
    let mut events = events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !*available.borrow() {
        return Err(event_stream_unavailable_error());
    }
    events.retain(|_, sender| sender.receiver_count() > 0);
    Ok(events
        .entry(session_id.to_string())
        .or_insert_with(|| broadcast::channel(EVENT_BUFFER).0)
        .subscribe())
}

fn event_stream_unavailable_error() -> RuntimeIpcError {
    RuntimeIpcError {
        code: RuntimeIpcErrorCode::Unavailable,
        message: "Shared Runtime event stream is unavailable; restart Shared TUI".to_string(),
    }
}

fn publish_event(events: &SessionEventSenders, session_id: &str, event: RuntimeIpcEvent) {
    if let Some(sender) = events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
    {
        let _ = sender.send(event);
    }
}

fn invalidate_event_stream(
    available: &watch::Sender<bool>,
    events: &SessionEventSenders,
    reason: RuntimeIpcStreamInvalidationReason,
) {
    if available.send_replace(false) {
        for sender in events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            let _ = sender.send(RuntimeIpcEvent::StreamInvalidated { reason });
        }
    }
}

async fn await_permission_route(
    request: &PermissionRequest,
    routes: &SubagentRoutes,
    updates: &Notify,
) -> bool {
    if request.delegation.is_none() {
        return true;
    }
    let deadline = tokio::time::Instant::now() + SUBAGENT_ROUTE_TIMEOUT;
    loop {
        let updated = updates.notified();
        if routes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(&request.session_id)
        {
            return true;
        }
        if tokio::time::timeout_at(deadline, updated).await.is_err() {
            return false;
        }
    }
}

impl SharedRuntimeHandler {
    async fn ensure_plugin_workspace_ready(
        &self,
        binding: &AgentSessionWorkspaceBinding,
    ) -> std::result::Result<(), RuntimeIpcError> {
        crate::plugin_host_activation::ensure_plugin_workspace_ready(binding)
            .await
            .map_err(core_ipc_error)
    }

    async fn session_workspace_binding(
        &self,
        session_id: &str,
    ) -> std::result::Result<AgentSessionWorkspaceBinding, RuntimeIpcError> {
        self.runtime
            .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                session_id: session_id.to_string(),
            })
            .await
            .map_err(runtime_ipc_error)?
            .ok_or_else(workspace_mismatch_error)
    }

    fn validate_workspace(
        &self,
        operation: &RuntimeIpcOperation,
    ) -> std::result::Result<(), RuntimeIpcError> {
        let requested = match operation {
            RuntimeIpcOperation::ListSessions { request } => {
                if let Some(id) = request.workspace_id.as_deref() {
                    return if self.workspace_id.as_deref() == Some(id) {
                        Ok(())
                    } else {
                        Err(workspace_mismatch_error())
                    };
                }
                // Pre-ID IPC compatibility; current clients send an ID.
                Some(request.workspace_path.as_str())
            }
            RuntimeIpcOperation::CreateSession { request } => Some(
                request
                    .workspace_path
                    .as_deref()
                    .ok_or_else(workspace_mismatch_error)?,
            ),
            RuntimeIpcOperation::RestoreSession { request } => {
                if let Some(id) = request.workspace_id.as_deref() {
                    return if self.workspace_id.as_deref() == Some(id) {
                        Ok(())
                    } else {
                        Err(workspace_mismatch_error())
                    };
                }
                Some(request.workspace_path.as_str())
            }
            RuntimeIpcOperation::SubmitTurn { request } => Some(
                request
                    .workspace_path
                    .as_deref()
                    .ok_or_else(workspace_mismatch_error)?,
            ),
            RuntimeIpcOperation::UndoSession { request }
            | RuntimeIpcOperation::RedoSession { request } => Some(request.workspace_path.as_str()),
            RuntimeIpcOperation::GetSessionLineage { request } => {
                reject_remote_lineage_scope(
                    request.remote_connection_id.as_deref(),
                    request.remote_ssh_host.as_deref(),
                )?;
                Some(request.workspace_path.as_str())
            }
            RuntimeIpcOperation::InspectLineageSession { request } => {
                reject_remote_lineage_scope(
                    request.remote_connection_id.as_deref(),
                    request.remote_ssh_host.as_deref(),
                )?;
                Some(request.workspace_path.as_str())
            }
            RuntimeIpcOperation::CancelLineageSession { request } => {
                reject_remote_lineage_scope(
                    request.remote_connection_id.as_deref(),
                    request.remote_ssh_host.as_deref(),
                )?;
                Some(request.workspace_path.as_str())
            }
            _ => None,
        };
        let Some(requested) = requested else {
            return Ok(());
        };
        let matches = dunce::canonicalize(Path::new(requested))
            .is_ok_and(|requested| requested == self.workspace);
        if matches {
            Ok(())
        } else {
            Err(workspace_mismatch_error())
        }
    }
}

fn reject_remote_lineage_scope(
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> std::result::Result<(), RuntimeIpcError> {
    if remote_connection_id.is_some() || remote_ssh_host.is_some() {
        return Err(workspace_mismatch_error());
    }
    Ok(())
}

fn workspace_mismatch_error() -> RuntimeIpcError {
    RuntimeIpcError {
        code: RuntimeIpcErrorCode::SessionMismatch,
        message: "Shared TUI operation targets a different workspace".to_string(),
    }
}

fn route_agent_event(
    event: &AgenticEvent,
    source_session_id: &str,
    routes: &SubagentRoutes,
) -> (String, Option<String>, Option<String>) {
    let mut routes = routes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let AgenticEvent::SubagentSessionLinked {
        session_id,
        subagent_dialog_turn_id,
        parent_session_id,
        parent_dialog_turn_id,
        parent_tool_call_id,
        ..
    } = event
    {
        let (root_session_id, root_turn_id, root_tool_call_id) = routes
            .get(parent_session_id)
            .map(|route| {
                (
                    route.root_session_id.clone(),
                    route.root_turn_id.clone(),
                    route.root_tool_call_id.clone(),
                )
            })
            .unwrap_or_else(|| {
                (
                    parent_session_id.clone(),
                    parent_dialog_turn_id.clone(),
                    parent_tool_call_id.clone(),
                )
            });
        routes.insert(
            session_id.clone(),
            SubagentRoute {
                root_session_id,
                root_turn_id,
                root_tool_call_id,
                source_turn_id: subagent_dialog_turn_id.clone(),
            },
        );
    }
    let routed = routes
        .get(source_session_id)
        .cloned()
        .map(|route| {
            (
                route.root_session_id,
                Some(route.root_turn_id),
                Some(route.root_tool_call_id),
            )
        })
        .unwrap_or_else(|| (source_session_id.to_string(), None, None));
    if let AgenticEvent::DialogTurnCompleted {
        session_id,
        turn_id,
        ..
    }
    | AgenticEvent::DialogTurnCancelled {
        session_id,
        turn_id,
    }
    | AgenticEvent::DialogTurnFailed {
        session_id,
        turn_id,
        ..
    } = event
    {
        // A root Turn may finish while a background descendant is still active.
        // Remove only the route for the exact descendant Turn that settled; a
        // stale terminal event must not erase a newer Turn's route.
        if routes
            .get(session_id)
            .is_some_and(|route| route.source_turn_id == *turn_id)
        {
            routes.remove(session_id);
        }
    }
    routed
}

fn project_subagent_link_route(
    event: &mut AgenticEvent,
    routed_session_id: &str,
    routed_turn_id: Option<&str>,
    routed_tool_call_id: Option<&str>,
) {
    let AgenticEvent::SubagentSessionLinked {
        parent_session_id,
        parent_dialog_turn_id,
        parent_tool_call_id,
        ..
    } = event
    else {
        return;
    };
    *parent_session_id = routed_session_id.to_string();
    if let Some(routed_turn_id) = routed_turn_id {
        *parent_dialog_turn_id = routed_turn_id.to_string();
    }
    if let Some(routed_tool_call_id) = routed_tool_call_id {
        *parent_tool_call_id = routed_tool_call_id.to_string();
    }
}

fn project_user_question_route(
    event: &mut AgenticEvent,
    routed_session_id: &str,
    routed_turn_id: Option<&str>,
) {
    let AgenticEvent::ToolEvent {
        session_id,
        turn_id,
        tool_event,
        ..
    } = event
    else {
        return;
    };
    if tool_event.effective_tool_name() == "AskUserQuestion" {
        *session_id = routed_session_id.to_string();
        if let Some(routed_turn_id) = routed_turn_id {
            *turn_id = routed_turn_id.to_string();
        }
    }
}

fn index_user_question(
    event: &AgenticEvent,
    routed_session_id: &str,
    questions: &Mutex<HashMap<String, String>>,
) {
    let AgenticEvent::ToolEvent { tool_event, .. } = event else {
        return;
    };
    let mut questions = questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match tool_event {
        ToolEventData::Started { .. } if tool_event.effective_tool_name() == "AskUserQuestion" => {
            questions.insert(
                tool_event.tool_id().to_string(),
                routed_session_id.to_string(),
            );
        }
        ToolEventData::Completed { .. }
        | ToolEventData::Failed { .. }
        | ToolEventData::Cancelled { .. } => {
            questions.remove(tool_event.tool_id());
        }
        _ => {}
    }
}

pub(crate) async fn run_service(workspace: PathBuf, expected_identity: String) -> Result<()> {
    openbitfun_services_core::process_manager::contain_current_process_tree()
        .context("contain Shared Runtime process tree")?;
    prepare_client_environment().await?;
    let identity = instance_identity(&workspace)?;
    if identity.as_str() != expected_identity {
        return Err(anyhow!(
            "Shared Runtime identity does not match its workspace"
        ));
    }
    let runtime = crate::initialize_core_services_for_deployment(
        &workspace,
        crate::runtime::approval::CliApprovalPolicy::Ask,
        crate::BootstrapProfile::Interactive,
        RuntimeDeployment::Shared,
    )
    .await?;
    let handler = Arc::new(SharedRuntimeHandler::build(
        runtime.agent_runtime().clone(),
        runtime.compatibility().clone(),
        runtime.workspace(),
    )?);
    let server = RuntimeIpcServer::bind_with_handler(
        &ipc_root()?,
        identity,
        RuntimeIpcServerConfig {
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            idle_timeout: IDLE_TIMEOUT,
            handshake_timeout: CONNECT_TIMEOUT,
            request_timeout: SERVER_OPERATION_TIMEOUT,
            max_connections: 64,
        },
        handler,
    )
    .await
    .context("bind Shared Runtime IPC")?;
    let result = server.serve().await.context("serve Shared Runtime IPC");
    crate::shutdown_mcp_servers().await;
    result
}

pub(crate) async fn connect_or_start(workspace: &Path) -> Result<RuntimeIpcClient> {
    prepare_client_environment().await?;
    let identity = instance_identity(workspace)?;
    let runtime_root = ipc_root()?;
    let store = DiscoveryStore::new(&runtime_root, identity.clone());
    let client_id = uuid::Uuid::new_v4().to_string();
    let mut last_connect_error = None;
    match connect_existing(&store, &runtime_root, &client_id).await {
        Ok(Some(client)) => return require_interactive_tui(client),
        Ok(None) => {}
        Err(error) => last_connect_error = Some(error),
    }

    let mut child = StartupChild::spawn(workspace, identity.as_str())?;
    let mut started = Instant::now();
    let mut respawned = false;
    loop {
        match connect_existing(&store, &runtime_root, &client_id).await {
            Ok(Some(client)) => {
                let client = require_interactive_tui(client)?;
                child.disarm();
                return Ok(client);
            }
            Ok(None) => {}
            Err(error) => last_connect_error = Some(error),
        }
        if let Some(status) = child.try_wait().context("poll Shared Runtime startup")? {
            if embedded_runtime_owner_present(workspace)? {
                return Err(anyhow!(
                    "Agent Runtime ownership failed (runtime_ownership_unavailable): an Embedded Runtime owns this workspace; close it before starting Shared TUI ({status})"
                ));
            }
            if runtime_owner_present(workspace)? {
                // Another Shared child may still be initializing and has not
                // published discovery yet. Keep connecting until the normal
                // bounded startup timeout instead of mislabeling it Embedded.
            } else {
                if respawned {
                    return Err(anyhow!(
                        "Shared Runtime exited before becoming ready ({status})"
                    ));
                }
                child = StartupChild::spawn(workspace, identity.as_str())?;
                respawned = true;
                started = Instant::now();
            }
        }
        if started.elapsed() >= STARTUP_TIMEOUT {
            let owner_guidance = if runtime_owner_present(workspace)? {
                "; Agent Runtime ownership failed (runtime_ownership_unavailable): another local Runtime still owns this workspace, so close its clients and wait up to 30 seconds"
            } else {
                ""
            };
            let connection_detail = last_connect_error
                .as_ref()
                .map(|error| format!("; last connection error: {error}"))
                .unwrap_or_default();
            return Err(anyhow!(
                "Shared Runtime did not become ready within {} seconds{owner_guidance}{connection_detail}",
                STARTUP_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn runtime_owner_present(workspace: &Path) -> Result<bool> {
    CoreRuntimeOwnership::runtime_owner_present(path_manager()?.as_ref(), workspace)
        .map_err(anyhow::Error::from)
}

fn embedded_runtime_owner_present(workspace: &Path) -> Result<bool> {
    CoreRuntimeOwnership::embedded_runtime_owner_present(path_manager()?.as_ref(), workspace)
        .map_err(anyhow::Error::from)
}

fn require_interactive_tui(client: RuntimeIpcClient) -> Result<RuntimeIpcClient> {
    if client.capabilities().interactive_tui {
        Ok(client)
    } else {
        Err(anyhow!(
            "local Runtime does not support Shared TUI operations"
        ))
    }
}

async fn prepare_client_environment() -> Result<()> {
    crate::agent::agentic_system::select_agentic_system_profile(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
    )?;
    openbitfun_core::service::config::initialize_global_config()
        .await
        .map_err(|error| anyhow!("Failed to initialize Shared TUI configuration: {error}"))
}

async fn connect_existing(
    store: &DiscoveryStore,
    runtime_root: &Path,
    client_id: &str,
) -> Result<Option<RuntimeIpcClient>> {
    let Some(discovery) = store.read().context("read Shared Runtime discovery")? else {
        return Ok(None);
    };
    RuntimeIpcClient::connect(
        runtime_root,
        &discovery,
        client_id,
        env!("CARGO_PKG_VERSION"),
        CONNECT_TIMEOUT,
        CLIENT_REQUEST_TIMEOUT,
    )
    .await
    .context("connect existing Shared Runtime")
    .map(Some)
}

struct StartupChild {
    child: Option<Child>,
}

impl StartupChild {
    fn spawn(workspace: &Path, identity: &str) -> Result<Self> {
        let executable = std::env::current_exe().context("resolve OpenBitFun executable")?;
        let mut command = openbitfun_services_core::process_manager::create_command(executable);
        command
            .arg("__shared-runtime")
            .arg("--workspace")
            .arg(workspace)
            .arg("--instance-identity")
            .arg(identity)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_detached_process(&mut command);
        let child = command.spawn().context("start Shared Runtime process")?;
        Ok(Self { child: Some(child) })
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child
            .as_mut()
            .expect("startup child is armed")
            .try_wait()
    }

    fn disarm(mut self) {
        self.child.take();
    }
}

impl Drop for StartupChild {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        if let Ok(process_id) = i32::try_from(child.id()) {
            // SAFETY: the child calls setsid before exec, so its PID is the
            // process-group ID owned by this startup attempt.
            let _ = unsafe { libc::kill(-process_id, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn configure_detached_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    let _ = command;
}

fn instance_identity(workspace: &Path) -> Result<RuntimeInstanceIdentity> {
    let user_root = path_manager()?.user_data_dir();
    RuntimeInstanceIdentity::for_workspace(
        workspace,
        CoreRuntimeOwnership::distribution_identity(),
        RELEASE_CHANNEL,
        &user_root.to_string_lossy(),
        PROTOCOL_VERSION,
    )
    .context("resolve Shared Runtime identity")
}

fn ipc_root() -> Result<PathBuf> {
    Ok(path_manager()?
        .user_data_dir()
        .join("agent-runtime")
        .join(format!("ipc-v{PROTOCOL_VERSION}")))
}

fn path_manager() -> Result<Arc<openbitfun_core::infrastructure::PathManager>> {
    openbitfun_core::infrastructure::try_get_path_manager_arc()
        .map_err(|error| anyhow!(error.to_string()))
}

fn permission_targets_session(
    request: &PermissionRequest,
    session_id: &str,
    routes: &SubagentRoutes,
) -> bool {
    permission_request_session(request, routes) == session_id
}

fn permission_event_session(
    event: &PermissionRequestEvent,
    index: &Mutex<HashMap<String, String>>,
    routes: &SubagentRoutes,
) -> Option<String> {
    let mut index = index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match event {
        PermissionRequestEvent::Asked { request } => {
            let session_id = permission_request_session(request, routes);
            index.insert(request.request_id.clone(), session_id.clone());
            Some(session_id)
        }
        PermissionRequestEvent::Replied { request_id, .. }
        | PermissionRequestEvent::Cancelled { request_id, .. } => index.remove(request_id),
    }
}

fn permission_request_session(request: &PermissionRequest, routes: &SubagentRoutes) -> String {
    let routes = routes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    routes
        .get(&request.session_id)
        .or_else(|| {
            request
                .delegation
                .as_ref()
                .and_then(|delegation| routes.get(&delegation.parent_session_id))
        })
        .map(|route| route.root_session_id.clone())
        .or_else(|| {
            request
                .delegation
                .as_ref()
                .map(|delegation| delegation.parent_session_id.clone())
        })
        .unwrap_or_else(|| request.session_id.clone())
}

fn runtime_error_message(error: RuntimeError) -> anyhow::Error {
    anyhow!(error.into_message())
}

fn runtime_ipc_error(error: RuntimeError) -> RuntimeIpcError {
    let code = match &error {
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::SessionInUse => {
            RuntimeIpcErrorCode::SessionInUse
        }
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::InvalidRequest => {
            RuntimeIpcErrorCode::InvalidRequest
        }
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::OutcomeUnknown => {
            RuntimeIpcErrorCode::OutcomeUnknown
        }
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::NotFound => {
            RuntimeIpcErrorCode::NotFound
        }
        _ => RuntimeIpcErrorCode::Unavailable,
    };
    RuntimeIpcError {
        code,
        message: error.into_message(),
    }
}

fn core_ipc_error(error: openbitfun_core::util::errors::OpenBitFunError) -> RuntimeIpcError {
    let code = match &error {
        openbitfun_core::util::errors::OpenBitFunError::Validation(_)
        | openbitfun_core::util::errors::OpenBitFunError::NotFound(_) => {
            RuntimeIpcErrorCode::InvalidRequest
        }
        openbitfun_core::util::errors::OpenBitFunError::SessionInUse { .. } => {
            RuntimeIpcErrorCode::SessionInUse
        }
        _ => RuntimeIpcErrorCode::Unavailable,
    };
    RuntimeIpcError {
        code,
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        await_permission_route, connect_existing, delete_owned_session, index_user_question,
        invalidate_event_stream, owned_session_rename_request, permission_event_session,
        permission_targets_session, project_subagent_link_route, project_user_question_route,
        publish_event, reject_remote_lineage_scope, rename_owned_session, route_agent_event,
        runtime_ipc_error, subscribe_session_events, SessionEventSenders, SubagentRoute,
        SubagentRoutes, EVENT_BUFFER,
    };
    use openbitfun_agent_runtime::sdk::{
        AgentRuntimeBuilder, AgentSessionCreateRequest, AgentSessionCreateResult,
        AgentSessionDeleteRequest, AgentSessionListRequest, AgentSessionManagementPort,
        AgentSessionRenameRequest, AgentSessionSummary, AgentSessionWorkspaceBinding,
        AgentSessionWorkspaceRequest, AgentSubmissionPort, AgentSubmissionRequest,
        AgentSubmissionResult, PermissionDelegationContext, PermissionReplySource,
        PermissionRequest, PermissionRequestEvent, PermissionRequestSource,
        PermissionRequestSourceKind, PortError, PortErrorKind, PortResult, RuntimeError,
    };
    use openbitfun_agent_runtime_ipc::{RuntimeIpcErrorCode, RuntimeSessionRenameRequest};
    use openbitfun_events::{AgenticEvent, ToolEventData, ToolEventIdentity};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::{watch, Notify};

    #[test]
    fn shared_lineage_scope_rejects_remote_identity() {
        assert!(reject_remote_lineage_scope(None, None).is_ok());
        let error = reject_remote_lineage_scope(Some("connection-1"), None)
            .expect_err("Shared Runtime must stay workspace-local");
        assert_eq!(error.code, RuntimeIpcErrorCode::SessionMismatch);
        let error = reject_remote_lineage_scope(None, Some("host-1"))
            .expect_err("Shared Runtime must stay workspace-local");
        assert_eq!(error.code, RuntimeIpcErrorCode::SessionMismatch);
    }

    #[test]
    fn shared_handler_steering_delegates_to_the_runtime_sdk() {
        let source = include_str!("shared_runtime.rs").replace("\r\n", "\n");
        let execute = source
            .split_once("impl RuntimeIpcRequestHandler for SharedRuntimeHandler")
            .expect("shared handler")
            .1
            .split_once("fn subscribe_events(")
            .expect("shared handler boundary")
            .0;

        assert!(execute.contains("RuntimeIpcOperation::SteerTurn { request }"));
        assert!(execute.contains(".steer_dialog_turn(request)"));
        assert!(execute.contains("RuntimeIpcOperationResult::TurnSteered"));
        assert!(!execute.contains("submit_steering"));
    }

    #[derive(Default)]
    struct RecordingSessionPort {
        delete_requests: Mutex<Vec<AgentSessionDeleteRequest>>,
        rename_requests: Mutex<Vec<AgentSessionRenameRequest>>,
    }

    #[async_trait::async_trait]
    impl AgentSubmissionPort for RecordingSessionPort {
        async fn create_session(
            &self,
            request: AgentSessionCreateRequest,
        ) -> PortResult<AgentSessionCreateResult> {
            Ok(AgentSessionCreateResult::new(
                "session-1",
                request.session_name,
                request.agent_type,
            ))
        }

        async fn submit_message(
            &self,
            request: AgentSubmissionRequest,
        ) -> PortResult<AgentSubmissionResult> {
            Ok(AgentSubmissionResult {
                turn_id: request.turn_id.unwrap_or_else(|| "turn-1".to_string()),
                accepted: true,
            })
        }

        async fn resolve_session_agent_type(
            &self,
            _session_id: &str,
        ) -> PortResult<Option<String>> {
            Ok(Some("Standard".to_string()))
        }
    }

    #[async_trait::async_trait]
    impl AgentSessionManagementPort for RecordingSessionPort {
        async fn list_sessions(
            &self,
            _request: AgentSessionListRequest,
        ) -> PortResult<Vec<AgentSessionSummary>> {
            Ok(Vec::new())
        }

        async fn delete_session(&self, request: AgentSessionDeleteRequest) -> PortResult<()> {
            self.delete_requests.lock().unwrap().push(request);
            Ok(())
        }

        async fn rename_session(&self, request: AgentSessionRenameRequest) -> PortResult<()> {
            self.rename_requests.lock().unwrap().push(request);
            Ok(())
        }

        async fn resolve_session_workspace_binding(
            &self,
            _request: AgentSessionWorkspaceRequest,
        ) -> PortResult<Option<AgentSessionWorkspaceBinding>> {
            Ok(None)
        }
    }

    #[test]
    fn session_writer_conflict_reuses_the_existing_ipc_error() {
        let error = runtime_ipc_error(RuntimeError::Port(PortError::new(
            PortErrorKind::SessionInUse,
            "Session is already open for writing: session-1",
        )));

        assert_eq!(
            error.code,
            openbitfun_agent_runtime_ipc::RuntimeIpcErrorCode::SessionInUse
        );
    }

    #[test]
    fn invalid_runtime_requests_keep_their_ipc_error_category() {
        let error = runtime_ipc_error(RuntimeError::Port(PortError::new(
            PortErrorKind::InvalidRequest,
            "Unknown agent mode: missing",
        )));

        assert_eq!(
            error.code,
            openbitfun_agent_runtime_ipc::RuntimeIpcErrorCode::InvalidRequest
        );
    }

    #[test]
    fn unknown_runtime_outcomes_keep_their_ipc_error_category() {
        let error = runtime_ipc_error(RuntimeError::Port(PortError::new(
            PortErrorKind::OutcomeUnknown,
            "inspect authoritative state",
        )));

        assert_eq!(error.code, RuntimeIpcErrorCode::OutcomeUnknown);
    }

    #[test]
    fn missing_runtime_sessions_keep_their_ipc_error_category() {
        let error = runtime_ipc_error(RuntimeError::Port(PortError::new(
            PortErrorKind::NotFound,
            "Session not found: session-1",
        )));

        assert_eq!(error.code, RuntimeIpcErrorCode::NotFound);
    }

    #[test]
    fn shared_rename_uses_the_server_workspace_and_no_remote_identity() {
        let request = owned_session_rename_request(
            "workspace-1",
            RuntimeSessionRenameRequest {
                session_id: "session-1".to_string(),
                session_name: "Auth refactor".to_string(),
            },
        );

        assert_eq!(request.workspace_id.as_deref(), Some("workspace-1"));
        assert!(request.workspace_path.is_empty());
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.session_name, "Auth refactor");
        assert!(request.remote_connection_id.is_none());
        assert!(request.remote_ssh_host.is_none());
    }

    #[tokio::test]
    async fn shared_question_interaction_and_dismissal_use_the_runtime_mailbox() {
        use openbitfun_agent_runtime::user_questions::{
            get_user_input_manager, PendingUserQuestion,
        };
        use openbitfun_agent_runtime_ipc::{RuntimeIpcOperation, RuntimeIpcRequestHandler};
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(Arc::new(RecordingSessionPort::default()))
            .build()
            .unwrap();
        let (available, _) = watch::channel(true);
        let handler = super::SharedRuntimeHandler {
            workspace_id: Some("test-shared-workspace".into()),
            runtime,
            compatibility: None,
            workspace: std::env::temp_dir(),
            events: Arc::new(Mutex::new(HashMap::new())),
            question_sessions: Arc::new(Mutex::new(HashMap::new())),
            subagent_routes: Arc::new(SubagentRoutes::new(HashMap::new())),
            event_stream_available: available,
        };
        let manager = get_user_input_manager();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        let _registration = manager.register_question(
            PendingUserQuestion::new(
                "shared-timeout-tool",
                "shared-timeout-session",
                None,
                None,
                serde_json::json!({}),
            ),
            sender,
        );
        assert!(handler
            .execute(RuntimeIpcOperation::StartQuestionInteraction {
                session_id: "other".into(),
                tool_id: "shared-timeout-tool".into(),
            })
            .await
            .is_err());
        handler
            .execute(RuntimeIpcOperation::StartQuestionInteraction {
                session_id: "shared-timeout-session".into(),
                tool_id: "shared-timeout-tool".into(),
            })
            .await
            .unwrap();
        assert!(
            manager
                .pending_question_snapshot("shared-timeout-session")
                .questions[0]
                .interaction_started
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        handler
            .execute(RuntimeIpcOperation::CancelUserQuestion {
                session_id: "shared-timeout-session".into(),
                tool_id: "shared-timeout-tool".into(),
            })
            .await
            .unwrap();
        assert!(receiver.await.is_err());
        assert!(!manager.has_pending("shared-timeout-tool"));
    }

    #[tokio::test]
    async fn embedded_and_shared_rename_reach_the_same_runtime_owner() {
        let port = Arc::new(RecordingSessionPort::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(port.clone())
            .with_session_management_port(port.clone())
            .build()
            .expect("runtime");
        let expected = AgentSessionRenameRequest {
            workspace_id: Some("workspace-1".into()),
            workspace_path: String::new(),
            session_id: "session-1".to_string(),
            session_name: "Auth refactor".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        runtime
            .rename_session(expected.clone())
            .await
            .expect("embedded rename");

        rename_owned_session(
            &runtime,
            "workspace-1",
            RuntimeSessionRenameRequest {
                session_id: "session-1".to_string(),
                session_name: "Auth refactor".to_string(),
            },
        )
        .await
        .expect("shared rename");

        assert_eq!(
            port.rename_requests.lock().unwrap().as_slice(),
            &[expected.clone(), expected]
        );
    }

    #[tokio::test]
    async fn embedded_and_shared_delete_reach_the_same_runtime_owner() {
        let port = Arc::new(RecordingSessionPort::default());
        let runtime = AgentRuntimeBuilder::new()
            .with_submission_port(port.clone())
            .with_session_management_port(port.clone())
            .build()
            .expect("runtime");
        let expected = AgentSessionDeleteRequest {
            workspace_id: Some("workspace-1".into()),
            workspace_path: String::new(),
            session_id: "session-2".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        runtime
            .delete_session(expected.clone())
            .await
            .expect("embedded delete");

        delete_owned_session(&runtime, "workspace-1", "session-2".to_string())
            .await
            .expect("shared delete");

        assert_eq!(
            port.delete_requests.lock().unwrap().as_slice(),
            &[expected.clone(), expected]
        );
    }

    #[tokio::test]
    async fn existing_runtime_connection_errors_are_not_hidden_as_absence() {
        let root = tempfile::tempdir().unwrap();
        let identity = openbitfun_agent_runtime_ipc::RuntimeInstanceIdentity::for_workspace(
            root.path(),
            "openbitfun",
            "stable",
            "fixture-user",
            openbitfun_agent_runtime_ipc::PROTOCOL_VERSION,
        )
        .unwrap();
        let store =
            openbitfun_agent_runtime_ipc::DiscoveryStore::new(root.path(), identity.clone());
        store
            .write(&openbitfun_agent_runtime_ipc::DiscoveryRecord::new(
                identity,
                "invalid-endpoint".to_string(),
                1,
                "token".to_string(),
                "owner".to_string(),
            ))
            .unwrap();
        assert!(connect_existing(&store, root.path(), "client")
            .await
            .is_err());
    }

    #[test]
    fn exited_shared_child_reports_embedded_owner_without_waiting_for_timeout() {
        let source = include_str!("shared_runtime.rs");
        let exited_child = source
            .split_once("if let Some(status) = child.try_wait()")
            .expect("Shared Runtime child exit branch")
            .1
            .split_once("if started.elapsed() >= STARTUP_TIMEOUT")
            .expect("startup timeout boundary")
            .0;

        assert!(exited_child.contains("embedded_runtime_owner_present"));
        assert!(exited_child.contains("runtime_ownership_unavailable"));
        assert!(exited_child.contains("Embedded Runtime owns this workspace"));
        assert!(exited_child.contains("return Err"));
    }

    fn delegated_permission(session_id: &str, parent_session_id: &str) -> PermissionRequest {
        PermissionRequest {
            request_id: "permission-1".to_string(),
            round_id: "round-1".to_string(),
            order: 0,
            tool_call_id: Some("tool-1".to_string()),
            project_path: None,
            project_id: "project-1".to_string(),
            session_id: session_id.to_string(),
            agent_id: "Standard".to_string(),
            action: "run command".to_string(),
            resources: Vec::new(),
            save_resources: Vec::new(),
            source: PermissionRequestSource {
                kind: PermissionRequestSourceKind::ToolCall,
                identity: "shell".to_string(),
            },
            delegation: Some(PermissionDelegationContext {
                parent_session_id: parent_session_id.to_string(),
                parent_dialog_turn_id: Some("parent-turn".to_string()),
                parent_tool_call_id: "task-1".to_string(),
                subagent_type: "general".to_string(),
            }),
            display_metadata: serde_json::Map::new(),
        }
    }

    #[test]
    fn unrelated_session_events_do_not_consume_a_clients_lag_budget() {
        let events = SessionEventSenders::new(HashMap::new());
        let (available, _) = watch::channel(true);
        let _noisy = subscribe_session_events(&events, &available, "noisy").unwrap();
        let mut quiet = subscribe_session_events(&events, &available, "quiet").unwrap();
        for _ in 0..=EVENT_BUFFER {
            publish_event(
                &events,
                "noisy",
                openbitfun_agent_runtime_ipc::RuntimeIpcEvent::StreamInvalidated {
                    reason:
                        openbitfun_agent_runtime_ipc::RuntimeIpcStreamInvalidationReason::Lagged,
                },
            );
        }
        assert!(matches!(
            quiet.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        invalidate_event_stream(
            &available,
            &events,
            openbitfun_agent_runtime_ipc::RuntimeIpcStreamInvalidationReason::Lagged,
        );
        assert!(quiet.try_recv().is_ok());
        assert!(subscribe_session_events(&events, &available, "late").is_err());
    }

    #[test]
    fn descendant_routes_outlive_the_root_turn_and_end_with_each_descendant() {
        let routes = Mutex::new(HashMap::new());
        let root_route = (
            "parent-session".to_string(),
            Some("parent-turn".to_string()),
            Some("delegate-tool".to_string()),
        );
        let linked = AgenticEvent::SubagentSessionLinked {
            session_id: "child-session".to_string(),
            subagent_dialog_turn_id: "child-turn".to_string(),
            parent_session_id: "parent-session".to_string(),
            parent_dialog_turn_id: "parent-turn".to_string(),
            parent_tool_call_id: "delegate-tool".to_string(),
            agent_type: None,
            model_id: None,
            focused_review_display_label: None,
        };
        assert_eq!(
            route_agent_event(&linked, "child-session", &routes),
            root_route
        );

        let mut nested = AgenticEvent::SubagentSessionLinked {
            session_id: "grandchild-session".to_string(),
            subagent_dialog_turn_id: "grandchild-turn".to_string(),
            parent_session_id: "child-session".to_string(),
            parent_dialog_turn_id: "child-turn".to_string(),
            parent_tool_call_id: "nested-tool".to_string(),
            agent_type: None,
            model_id: None,
            focused_review_display_label: None,
        };
        let nested_route = route_agent_event(&nested, "grandchild-session", &routes);
        assert_eq!(nested_route, root_route);
        project_subagent_link_route(
            &mut nested,
            &nested_route.0,
            nested_route.1.as_deref(),
            nested_route.2.as_deref(),
        );
        assert!(matches!(
            nested,
            AgenticEvent::SubagentSessionLinked {
                parent_session_id,
                parent_dialog_turn_id,
                parent_tool_call_id,
                ..
            } if parent_session_id == "parent-session"
                && parent_dialog_turn_id == "parent-turn"
                && parent_tool_call_id == "delegate-tool"
        ));
        let grandchild_output = AgenticEvent::TextChunk {
            session_id: "grandchild-session".to_string(),
            turn_id: "grandchild-turn".to_string(),
            round_id: "round-2".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: "nested output".to_string(),
        };
        assert_eq!(
            route_agent_event(&grandchild_output, "grandchild-session", &routes),
            root_route
        );

        let completed = AgenticEvent::DialogTurnCompleted {
            session_id: "parent-session".to_string(),
            turn_id: "parent-turn".to_string(),
            total_rounds: 1,
            total_tools: 1,
            duration_ms: 1,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: None,
            has_final_response: Some(true),
        };
        route_agent_event(&completed, "parent-session", &routes);
        assert_eq!(routes.lock().expect("routes").len(), 2);
        assert_eq!(
            route_agent_event(&grandchild_output, "grandchild-session", &routes),
            root_route
        );

        let child_completed = AgenticEvent::DialogTurnCancelled {
            session_id: "child-session".to_string(),
            turn_id: "child-turn".to_string(),
        };
        route_agent_event(&child_completed, "child-session", &routes);
        assert_eq!(routes.lock().expect("routes").len(), 1);

        let grandchild_completed = AgenticEvent::DialogTurnCancelled {
            session_id: "grandchild-session".to_string(),
            turn_id: "grandchild-turn".to_string(),
        };
        route_agent_event(&grandchild_completed, "grandchild-session", &routes);
        assert!(routes.lock().expect("routes").is_empty());
    }

    #[test]
    fn stale_descendant_terminal_does_not_remove_a_new_turn_route() {
        let routes = SubagentRoutes::new(HashMap::new());
        for turn_id in ["child-turn-old", "child-turn-new"] {
            let linked = AgenticEvent::SubagentSessionLinked {
                session_id: "child-session".to_string(),
                subagent_dialog_turn_id: turn_id.to_string(),
                parent_session_id: "root-session".to_string(),
                parent_dialog_turn_id: "root-turn".to_string(),
                parent_tool_call_id: "root-tool".to_string(),
                agent_type: None,
                model_id: None,
                focused_review_display_label: None,
            };
            route_agent_event(&linked, "child-session", &routes);
        }

        let stale = AgenticEvent::DialogTurnCancelled {
            session_id: "child-session".to_string(),
            turn_id: "child-turn-old".to_string(),
        };
        route_agent_event(&stale, "child-session", &routes);

        assert_eq!(
            routes
                .lock()
                .expect("routes")
                .get("child-session")
                .map(|route| route.source_turn_id.as_str()),
            Some("child-turn-new")
        );
    }

    #[test]
    fn nested_subagent_permissions_route_to_the_root_controller() {
        let root_route = (
            "root-session".to_string(),
            "root-turn".to_string(),
            "root-tool".to_string(),
        );
        let routes = SubagentRoutes::new(HashMap::from([
            (
                "child-session".to_string(),
                SubagentRoute {
                    root_session_id: root_route.0.clone(),
                    root_turn_id: root_route.1.clone(),
                    root_tool_call_id: root_route.2.clone(),
                    source_turn_id: "child-turn".to_string(),
                },
            ),
            (
                "nested-session".to_string(),
                SubagentRoute {
                    root_session_id: root_route.0,
                    root_turn_id: root_route.1,
                    root_tool_call_id: root_route.2,
                    source_turn_id: "nested-turn".to_string(),
                },
            ),
        ]));
        let index = Mutex::new(HashMap::new());
        let request = delegated_permission("nested-session", "child-session");

        assert!(permission_targets_session(
            &request,
            "root-session",
            &routes
        ));
        let events = [
            PermissionRequestEvent::Asked {
                request: request.clone(),
            },
            PermissionRequestEvent::Replied {
                request_id: request.request_id,
                reply: openbitfun_agent_runtime::sdk::PermissionReply::Once,
                source: PermissionReplySource::User,
            },
        ];
        for event in events {
            assert_eq!(
                permission_event_session(&event, &index, &routes).as_deref(),
                Some("root-session")
            );
        }
    }

    #[tokio::test]
    async fn delegated_permission_waits_for_its_authoritative_subagent_route() {
        let routes = Arc::new(SubagentRoutes::new(HashMap::new()));
        let updates = Arc::new(Notify::new());
        let request = delegated_permission("child-session", "root-session");
        let waiting_routes = routes.clone();
        let waiting_updates = updates.clone();
        let waiting_request = request.clone();
        let waiting = tokio::spawn(async move {
            await_permission_route(&waiting_request, &waiting_routes, &waiting_updates).await
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        routes.lock().expect("routes").insert(
            "child-session".to_string(),
            SubagentRoute {
                root_session_id: "root-session".to_string(),
                root_turn_id: "root-turn".to_string(),
                root_tool_call_id: "root-tool".to_string(),
                source_turn_id: "child-turn".to_string(),
            },
        );
        updates.notify_waiters();

        assert!(waiting.await.expect("route waiter"));
        assert!(permission_targets_session(
            &request,
            "root-session",
            &routes
        ));
    }

    #[test]
    fn user_question_answers_remain_scoped_to_the_routed_parent_session() {
        let questions = Mutex::new(HashMap::new());
        let mut started = AgenticEvent::ToolEvent {
            session_id: "child-session".to_string(),
            turn_id: "child-turn".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            tool_event: ToolEventData::Started {
                identity: ToolEventIdentity::direct("question-1", "AskUserQuestion"),
                params: serde_json::json!({}),
                timeout_seconds: None,
            },
        };
        project_user_question_route(&mut started, "parent-session", Some("parent-turn"));
        assert!(matches!(
            &started,
            AgenticEvent::ToolEvent { session_id, turn_id, .. }
                if session_id == "parent-session" && turn_id == "parent-turn"
        ));
        index_user_question(&started, "parent-session", &questions);
        assert_eq!(
            questions
                .lock()
                .expect("question index")
                .get("question-1")
                .map(String::as_str),
            Some("parent-session")
        );
    }
}
