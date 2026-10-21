//! Lightweight App Server client used by Rich Client surfaces.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::{ConnectTo, ConnectionTo, JsonRpcResponse, SentRequest};
use openbitfun_app_server_protocol::account::*;
use openbitfun_app_server_protocol::agent::*;
use openbitfun_app_server_protocol::app::{
    HealthRequest, HealthResponse, InitializeRequest, InitializeResponse,
};
use openbitfun_app_server_protocol::config::{
    SaveCloudSpeechConfigMessage, SaveCloudSpeechConfigRequest, SaveCloudSpeechConfigResponse,
    SaveCloudSpeechConfigResult, ValidateConfigMessage, ValidateConfigResponse,
};
use openbitfun_app_server_protocol::error::{AppServerErrorData, AppServerErrorKind};
use openbitfun_app_server_protocol::event::{
    AgentEventNotification, ConfigEventNotification, EventStreamStateNotification,
    PermissionEventNotification, SyncEventsRequest, SyncEventsResponse,
};
use openbitfun_app_server_protocol::external_source::*;
use openbitfun_app_server_protocol::hook::*;
use openbitfun_app_server_protocol::mcp::*;
use openbitfun_app_server_protocol::model::*;
use openbitfun_app_server_protocol::search::*;
use openbitfun_app_server_protocol::session::*;
use openbitfun_app_server_protocol::skill::*;
use openbitfun_app_server_protocol::subagent::*;
use openbitfun_app_server_protocol::workspace::*;
use openbitfun_app_server_protocol::worktree::*;
use openbitfun_app_server_protocol::{AppClient, AppServer};
use tokio::sync::{broadcast, oneshot};

pub use agent_client_protocol::Error as ProtocolError;

const CLIENT_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const SIDE_EFFECT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub enum AppServerEvent {
    Agent(AgentEventNotification),
    Permission(PermissionEventNotification),
    Config(ConfigEventNotification),
    ExternalSource(ExternalSourceEventNotification),
    StreamState(EventStreamStateNotification),
    ConnectionClosed,
}

#[derive(Debug)]
pub enum ClientError {
    Protocol(agent_client_protocol::Error),
    Timeout(AppServerErrorData),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::Timeout(data) => write!(
                formatter,
                "App Server request {} timed out with unknown outcome",
                data.request_id.as_deref().unwrap_or("unknown")
            ),
        }
    }
}

impl std::error::Error for ClientError {}

#[derive(Clone)]
pub struct AppServerClient {
    connection: Arc<ConnectionTo<AppServer>>,
    event_tx: broadcast::Sender<AppServerEvent>,
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    local_context_truncation: Arc<Mutex<bool>>,
}

impl AppServerClient {
    pub async fn search_session_content(
        &self,
        request: SearchSessionContentMessage,
    ) -> agent_client_protocol::Result<SearchSessionContentResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn account_snapshot(
        &self,
        request: AccountSnapshotRequest,
    ) -> agent_client_protocol::Result<AccountSnapshotResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn account_github_start(
        &self,
        request: AccountGitHubStartRequest,
    ) -> Result<AccountGitHubStartResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn account_github_poll(
        &self,
        request: AccountGitHubPollRequest,
    ) -> Result<AccountGitHubPollResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn account_login(
        &self,
        request: AccountLoginRequest,
    ) -> Result<AccountLoginResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn account_logout(
        &self,
        request: AccountLogoutRequest,
    ) -> Result<AccountSnapshotResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn initialize(
        &self,
        request: InitializeRequest,
    ) -> agent_client_protocol::Result<InitializeResponse> {
        let response: InitializeResponse = self.rpc(|cx| Ok(cx.send_request(request))).await?;
        let supported = response.capabilities.iter().any(|capability| {
            capability.id == LOCAL_CONTEXT_TRUNCATION_CAPABILITY
                && matches!(
                    capability.availability,
                    openbitfun_app_server_protocol::app::CapabilityAvailability::Available
                )
        });
        *self
            .local_context_truncation
            .lock()
            .expect("capability lock") = supported;
        Ok(response)
    }

    pub async fn health(&self) -> agent_client_protocol::Result<HealthResponse> {
        self.rpc(|cx| Ok(cx.send_request(HealthRequest {}))).await
    }

    pub async fn save_cloud_speech_config(
        &self,
        request: SaveCloudSpeechConfigRequest,
    ) -> Result<SaveCloudSpeechConfigResult, ClientError> {
        let SaveCloudSpeechConfigResponse(result) = self
            .request_with_timeout(
                |cx| Ok(cx.send_request(SaveCloudSpeechConfigMessage { request })),
                SIDE_EFFECT_TIMEOUT,
            )
            .await?;
        Ok(result)
    }

    pub async fn validate_config(&self) -> agent_client_protocol::Result<serde_json::Value> {
        let ValidateConfigResponse(result) = self
            .rpc(|cx| Ok(cx.send_request(ValidateConfigMessage {})))
            .await?;
        Ok(result)
    }

    pub async fn tui_model_catalog(
        &self,
    ) -> agent_client_protocol::Result<TuiModelCatalogResponse> {
        self.rpc(|cx| Ok(cx.send_request(TuiModelCatalogRequest {})))
            .await
    }

    pub async fn project_reasoning_catalog(
        &self,
        request: ProjectReasoningCatalogRequest,
    ) -> agent_client_protocol::Result<ProjectReasoningCatalogResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn worktree_repository_status(
        &self,
        request: WorktreeRepositoryStatusRequest,
    ) -> agent_client_protocol::Result<WorktreeRepositoryStatusResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn worktree_bind_session(
        &self,
        request: WorktreeBindSessionRequest,
    ) -> Result<WorktreeBindingResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn worktree_release_session(
        &self,
        request: WorktreeReleaseSessionRequest,
    ) -> Result<WorktreeBindingResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<AppServerEvent> {
        self.event_tx.subscribe()
    }

    pub async fn sync_events(
        &self,
        request: SyncEventsRequest,
    ) -> agent_client_protocol::Result<SyncEventsResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn external_source_snapshot(
        &self,
        request: ExternalSourceSnapshotRequest,
    ) -> agent_client_protocol::Result<ExternalSourceSnapshotResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn external_source_control(
        &self,
        request: ExternalSourceControlRequest,
    ) -> Result<ExternalSourceControlResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn external_source_review(
        &self,
        request: ExternalSourceReviewRequest,
    ) -> Result<ExternalSourceReviewResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn set_native_command_choice(
        &self,
        request: SetNativeCommandChoiceRequest,
    ) -> Result<SetNativeCommandChoiceResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn expand_external_command(
        &self,
        request: ExpandExternalCommandRequest,
    ) -> Result<ExpandExternalCommandResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn native_hook_overview(
        &self,
        request: NativeHookOverviewRequest,
    ) -> agent_client_protocol::Result<NativeHookOverviewResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn external_hook_snapshot(
        &self,
        request: ExternalHookSnapshotRequest,
    ) -> agent_client_protocol::Result<ExternalHookSnapshotResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn external_hook_plan(
        &self,
        request: ExternalHookPlanRequest,
    ) -> agent_client_protocol::Result<ExternalHookPlanResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn external_hook_apply(
        &self,
        request: ExternalHookApplyRequest,
    ) -> Result<ExternalHookApplyResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn external_hook_mutate(
        &self,
        request: ExternalHookMutationRequest,
    ) -> Result<ExternalHookMutationResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> agent_client_protocol::Result<ListSessionsResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn sync_session(
        &self,
        request: SyncSessionRequest,
    ) -> agent_client_protocol::Result<SyncSessionResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn read_transcript(
        &self,
        request: ReadTranscriptRequest,
    ) -> agent_client_protocol::Result<ReadTranscriptResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn resolve_workspace(
        &self,
        request: ResolveWorkspaceRequest,
    ) -> agent_client_protocol::Result<ResolveWorkspaceResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<CreateSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn delete_session(
        &self,
        request: DeleteSessionRequest,
    ) -> Result<DeleteSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn rename_session(
        &self,
        request: RenameSessionRequest,
    ) -> Result<RenameSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn submit_dialog_turn(
        &self,
        request: SubmitDialogTurnRequest,
    ) -> Result<SubmitDialogTurnResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn cancel_turn(
        &self,
        request: CancelTurnRequest,
    ) -> Result<CancelTurnResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn steer_turn(
        &self,
        request: SteerTurnRequest,
    ) -> Result<SteerTurnResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn run_user_shell_command(
        &self,
        request: RunUserShellCommandRequest,
    ) -> Result<RunUserShellCommandResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn submit_user_answers(
        &self,
        request: SubmitUserAnswersRequest,
    ) -> Result<SubmitUserAnswersResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn respond_permission(
        &self,
        request: RespondPermissionRequest,
    ) -> Result<RespondPermissionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn pending_permissions(
        &self,
    ) -> agent_client_protocol::Result<PendingPermissionsResponse> {
        self.rpc(|cx| Ok(cx.send_request(PendingPermissionsRequest {})))
            .await
    }

    pub async fn compact_session(
        &self,
        request: CompactSessionRequest,
    ) -> Result<CompactSessionResponse, ClientError> {
        if request.0.force
            && !*self
                .local_context_truncation
                .lock()
                .expect("capability lock")
        {
            return Err(ClientError::Protocol(agent_client_protocol::Error::new(
                AppServerErrorKind::Unsupported.json_rpc_code() as i32,
                "The App Server does not support local context truncation",
            )));
        }
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn undo_session(
        &self,
        request: UndoSessionRequest,
    ) -> Result<RevertSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn redo_session(
        &self,
        request: RedoSessionRequest,
    ) -> Result<RevertSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn reload_context(
        &self,
        request: ReloadContextRequest,
    ) -> Result<ReloadContextResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn session_usage(
        &self,
        request: SessionUsageRequest,
    ) -> agent_client_protocol::Result<SessionUsageResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn wait_for_settlement(
        &self,
        request: WaitForSettlementRequest,
    ) -> agent_client_protocol::Result<WaitForSettlementResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn workspace_diff(&self) -> agent_client_protocol::Result<WorkspaceDiffResponse> {
        self.rpc(|cx| Ok(cx.send_request(WorkspaceDiffRequest {})))
            .await
    }

    pub async fn search_workspace_references(
        &self,
        request: SearchWorkspaceReferencesRequest,
    ) -> agent_client_protocol::Result<SearchWorkspaceReferencesResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn message_references(
        &self,
        request: MessageReferencesRequest,
    ) -> agent_client_protocol::Result<MessageReferencesResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn session_lineage(
        &self,
        request: SessionLineageRequest,
    ) -> agent_client_protocol::Result<SessionLineageResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn inspect_lineage(
        &self,
        request: InspectLineageRequest,
    ) -> agent_client_protocol::Result<InspectLineageResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn cancel_lineage(
        &self,
        request: CancelLineageRequest,
    ) -> Result<CancelLineageResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn fork_session(
        &self,
        request: ForkSessionRequest,
    ) -> Result<ForkSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn fork_session_before_turn(
        &self,
        request: ForkSessionBeforeTurnRequest,
    ) -> Result<ForkSessionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn update_session_model(
        &self,
        request: UpdateSessionModelRequest,
    ) -> Result<UpdateSessionModelResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn update_session_mode(
        &self,
        request: UpdateSessionModeRequest,
    ) -> Result<UpdateSessionModeResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn list_agent_modes(
        &self,
        request: ListAgentModesRequest,
    ) -> agent_client_protocol::Result<ListAgentModesResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn list_models(&self) -> agent_client_protocol::Result<ListModelsResponse> {
        self.rpc(|cx| Ok(cx.send_request(ListModelsRequest {})))
            .await
    }

    pub async fn get_model(
        &self,
        request: GetModelRequest,
    ) -> agent_client_protocol::Result<GetModelResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn add_model(
        &self,
        request: AddModelRequest,
    ) -> Result<AddModelResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn update_model(
        &self,
        request: UpdateModelRequest,
    ) -> Result<UpdateModelResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn delete_model(
        &self,
        request: DeleteModelRequest,
    ) -> Result<DeleteModelResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn set_model_default(
        &self,
        request: SetModelDefaultRequest,
    ) -> Result<SetModelDefaultResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn list_skills(
        &self,
        request: ListSkillsRequest,
    ) -> agent_client_protocol::Result<ListSkillsResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn set_skill_enabled(
        &self,
        request: SetSkillEnabledRequest,
    ) -> Result<SetSkillEnabledResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn list_subagents(
        &self,
        request: ListSubagentsRequest,
    ) -> agent_client_protocol::Result<ListSubagentsResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn set_subagent_enabled(
        &self,
        request: SetSubagentEnabledRequest,
    ) -> Result<SetSubagentEnabledResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn list_mcp_servers(
        &self,
        request: ListMcpServersRequest,
    ) -> agent_client_protocol::Result<ListMcpServersResponse> {
        self.rpc(|cx| Ok(cx.send_request(request))).await
    }

    pub async fn toggle_mcp_server(
        &self,
        request: ToggleMcpServerRequest,
    ) -> Result<ToggleMcpServerResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn add_mcp_server(
        &self,
        request: AddMcpServerRequest,
    ) -> Result<AddMcpServerResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn delete_mcp_server(
        &self,
        request: DeleteMcpServerRequest,
    ) -> Result<DeleteMcpServerResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn external_mcp_decision(
        &self,
        request: ExternalMcpDecisionRequest,
    ) -> Result<ExternalMcpDecisionResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn mcp_conflict_choice(
        &self,
        request: McpConflictChoiceRequest,
    ) -> Result<McpConflictChoiceResponse, ClientError> {
        self.request_with_timeout(|cx| Ok(cx.send_request(request)), SIDE_EFFECT_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout<R: JsonRpcResponse>(
        &self,
        send: impl FnOnce(&ConnectionTo<AppServer>) -> agent_client_protocol::Result<SentRequest<R>>,
        timeout: Duration,
    ) -> Result<R, ClientError> {
        let sent = send(&self.connection).map_err(ClientError::Protocol)?;
        let request_id = sent.id().to_string();
        let (tx, rx) = oneshot::channel();
        sent.on_receiving_result(async move |result| {
            tx.send(result)
                .map_err(|_| agent_client_protocol::Error::internal_error())
        })
        .map_err(ClientError::Protocol)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result.map_err(ClientError::Protocol),
            Ok(Err(_)) => Err(ClientError::Protocol(
                agent_client_protocol::Error::internal_error(),
            )),
            Err(_) => Err(ClientError::Timeout(AppServerErrorData {
                kind: AppServerErrorKind::OutcomeUnknown,
                retryable: false,
                outcome_unknown: true,
                capability: None,
                request_id: Some(request_id),
            })),
        }
    }

    pub async fn shutdown(&self) {
        if let Some(tx) = self
            .shutdown_tx
            .lock()
            .ok()
            .and_then(|mut guard| guard.take())
        {
            let _ = tx.send(());
        }
    }

    async fn rpc<R: JsonRpcResponse>(
        &self,
        send: impl FnOnce(&ConnectionTo<AppServer>) -> agent_client_protocol::Result<SentRequest<R>>,
    ) -> agent_client_protocol::Result<R> {
        let sent = send(&self.connection)?;
        let (tx, rx) = oneshot::channel();
        sent.on_receiving_result(async move |result| {
            tx.send(result)
                .map_err(|_| agent_client_protocol::Error::internal_error())
        })?;
        rx.await
            .map_err(|_| agent_client_protocol::Error::internal_error())?
    }
}

pub async fn connect(
    transport: impl ConnectTo<AppClient> + 'static,
) -> Result<AppServerClient, anyhow::Error> {
    let (event_tx, _) = broadcast::channel(1024);
    let event_tx_for_task = event_tx.clone();
    let (cx_tx, cx_rx) = oneshot::channel::<ConnectionTo<AppServer>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let connect_task = tokio::spawn(async move {
        let result = AppClient
            .builder()
            .name("openbitfun-rich-client")
            .on_receive_notification(
                {
                    let event_tx = event_tx_for_task.clone();
                    async move |notification: AgentEventNotification, _cx| {
                        let _ = event_tx.send(AppServerEvent::Agent(notification));
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                {
                    let event_tx = event_tx_for_task.clone();
                    async move |notification: ExternalSourceEventNotification, _cx| {
                        let _ = event_tx.send(AppServerEvent::ExternalSource(notification));
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                {
                    let event_tx = event_tx_for_task.clone();
                    async move |notification: PermissionEventNotification, _cx| {
                        let _ = event_tx.send(AppServerEvent::Permission(notification));
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                {
                    let event_tx = event_tx_for_task.clone();
                    async move |notification: ConfigEventNotification, _cx| {
                        let _ = event_tx.send(AppServerEvent::Config(notification));
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                {
                    let event_tx = event_tx_for_task.clone();
                    async move |notification: EventStreamStateNotification, _cx| {
                        let _ = event_tx.send(AppServerEvent::StreamState(notification));
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(transport, async |cx: ConnectionTo<AppServer>| {
                let _ = cx_tx.send(cx);
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;
        let _ = event_tx_for_task.send(AppServerEvent::ConnectionClosed);
        result
    });

    let connection = match tokio::time::timeout(CLIENT_STARTUP_TIMEOUT, cx_rx).await {
        Ok(Ok(cx)) => cx,
        Ok(Err(_)) => {
            connect_task.abort();
            anyhow::bail!("App Server connection closed before startup completed");
        }
        Err(_) => {
            connect_task.abort();
            anyhow::bail!("App Server connection startup timed out");
        }
    };

    Ok(AppServerClient {
        connection: Arc::new(connection),
        event_tx,
        shutdown_tx: Arc::new(Mutex::new(Some(shutdown_tx))),
        local_context_truncation: Arc::new(Mutex::new(false)),
    })
}
