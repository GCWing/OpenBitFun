use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::{
    AgentCapabilities, CancelNotification, ClientCapabilities, CloseSessionRequest, Implementation,
    InitializeRequest, LoadSessionRequest, LoadSessionResponse, NewSessionRequest,
    NewSessionResponse, PermissionOption, PermissionOptionKind, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, ResumeSessionResponse, SelectedPermissionOutcome, SessionConfigOption,
    SessionConfigOptionValue, SessionModelState, SetSessionConfigOptionRequest,
    SetSessionModelRequest, StopReason,
};
use agent_client_protocol::{
    ActiveSession, Agent, ByteStreams, Client, ConnectionTo, Error, SessionMessage,
};
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures::io::{AsyncRead as FuturesAsyncRead, AsyncWrite as FuturesAsyncWrite};
use log::{debug, info, warn};
use openbitfun_agent_tools::ACP_TOOL_PREFIX;
use openbitfun_core::agentic::tools::registry::get_global_tool_registry;
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::infrastructure::PathManager;
use openbitfun_core::service::config::ConfigService;
use openbitfun_core::service::remote_ssh::workspace_state::get_remote_workspace_manager;
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::builtin_clients::{
    builtin_acp_client_preset, builtin_client_ids, default_config_for_builtin_client,
    migrate_legacy_builtin_client_configs,
};
use super::config::{
    AcpClientConfig, AcpClientConfigFile, AcpClientInfo, AcpClientPermissionMode,
    AcpClientRequirementProbe, AcpClientStatus, RemoteAcpClientRequirementSnapshot,
};
use super::dsh_profile::{ensure_bundled_profile, ensure_bundled_profile_remote};
use super::prompt::AcpPrompt;
use super::remote_capability_store::RemoteAcpCapabilityStore;
use super::remote_session::{preferred_resume_strategies, AcpRemoteSessionStrategy};
use super::remote_shell::{remote_user_shell_command, render_remote_env_assignments, shell_escape};
use super::requirements::{
    acp_requirement_spec, apply_command_environment, install_npm_cli_package,
    install_remote_npm_cli_package, predownload_npm_adapter, probe_executable, probe_npm_adapter,
    probe_remote_executable, probe_remote_npx_adapter, resolve_configured_command,
};
use super::session_options::{
    model_config_id, session_options_from_state, AcpAvailableCommand, AcpSessionContextUsage,
    AcpSessionOptions,
};
use super::session_persistence::AcpSessionPersistence;
pub use super::session_persistence::CreateAcpFlowSessionRecordResponse;
use super::stream::{
    acp_dispatch_to_stream_events_with_tracker, AcpClientStreamEvent, AcpStreamRoundTracker,
    AcpToolCallTracker,
};
use super::tool::AcpAgentTool;
use super::transport::{handle_transport_closed, AcpTransport};

const CONFIG_PATH: &str = "acp_clients";
const CLIENT_STARTUP_TIMEOUT_SECS: u64 = 60;
const CLIENT_STARTUP_TIMEOUT: Duration = Duration::from_secs(CLIENT_STARTUP_TIMEOUT_SECS);
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(600);
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const LOAD_REPLAY_DRAIN_QUIET_WINDOW: Duration = Duration::from_millis(250);
const LOAD_REPLAY_DRAIN_MAX_DURATION: Duration = Duration::from_secs(2);
const SESSION_METADATA_DRAIN_QUIET_WINDOW: Duration = Duration::from_millis(250);
const SESSION_METADATA_DRAIN_MAX_DURATION: Duration = Duration::from_secs(2);
const TURN_COMPLETION_DRAIN_QUIET_WINDOW: Duration = Duration::from_millis(250);
const TURN_COMPLETION_DRAIN_MAX_DURATION: Duration = Duration::from_secs(2);

type AcpOutgoingStream = Pin<Box<dyn FuturesAsyncWrite + Send>>;
type AcpIncomingStream = Pin<Box<dyn FuturesAsyncRead + Send>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitAcpPermissionResponseRequest {
    pub permission_id: String,
    pub approve: bool,
    #[serde(default)]
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpClientPermissionResponse {
    pub permission_id: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAcpSessionModelRequest {
    pub client_id: String,
    pub session_id: String,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAcpSessionConfigOptionRequest {
    pub client_id: String,
    pub session_id: String,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
    pub config_id: String,
    pub value: AcpSessionConfigValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AcpSessionConfigValue {
    Select { value: String },
    Boolean { value: bool },
}

impl AcpSessionConfigValue {
    fn into_protocol_value(self) -> SessionConfigOptionValue {
        match self {
            Self::Select { value } => SessionConfigOptionValue::value_id(value),
            Self::Boolean { value } => SessionConfigOptionValue::boolean(value),
        }
    }
}

pub struct AcpClientService {
    config_service: Arc<ConfigService>,
    session_persistence: AcpSessionPersistence,
    remote_capability_store: RemoteAcpCapabilityStore,
    clients: DashMap<String, Arc<AcpClientConnection>>,
    pending_permissions: DashMap<String, PendingPermission>,
    session_permission_modes: DashMap<String, AcpClientPermissionMode>,
}

struct PendingPermission {
    sender: oneshot::Sender<RequestPermissionResponse>,
    options: Vec<PermissionOption>,
}

struct AcpClientConnection {
    id: String,
    client_id: String,
    config: AcpClientConfig,
    status: RwLock<AcpClientStatus>,
    connection: RwLock<Option<ConnectionTo<Agent>>>,
    agent_capabilities: RwLock<Option<AgentCapabilities>>,
    sessions: DashMap<String, Arc<Mutex<AcpRemoteSession>>>,
    cancel_handles: DashMap<String, AcpCancelHandle>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    child: Mutex<Option<Child>>,
}

struct AcpRemoteSession {
    active: Option<ActiveSession<'static, Agent>>,
    models: Option<SessionModelState>,
    config_options: Vec<SessionConfigOption>,
    context_usage: Option<AcpSessionContextUsage>,
    available_commands: Vec<AcpAvailableCommand>,
    discard_pending_updates_before_next_prompt: bool,
}

struct ResolvedClientSession {
    client: Arc<AcpClientConnection>,
    cwd: PathBuf,
    session_key: String,
    session: Arc<Mutex<AcpRemoteSession>>,
}

struct StartClientConfig {
    remote_connection_id: Option<String>,
    config: AcpClientConfig,
}

#[derive(Clone)]
struct AcpCancelHandle {
    session_id: String,
    connection: ConnectionTo<Agent>,
}

impl AcpRemoteSession {
    fn new() -> Self {
        Self {
            active: None,
            models: None,
            config_options: Vec::new(),
            context_usage: None,
            available_commands: Vec::new(),
            discard_pending_updates_before_next_prompt: false,
        }
    }
}

impl AcpClientService {
    pub fn new(
        config_service: Arc<ConfigService>,
        path_manager: Arc<PathManager>,
    ) -> OpenBitFunResult<Arc<Self>> {
        Ok(Arc::new(Self {
            config_service,
            session_persistence: AcpSessionPersistence::new(path_manager.clone())?,
            remote_capability_store: RemoteAcpCapabilityStore::new(
                path_manager
                    .user_data_dir()
                    .join("ssh_acp_capabilities.json"),
            ),
            clients: DashMap::new(),
            pending_permissions: DashMap::new(),
            session_permission_modes: DashMap::new(),
        }))
    }

    /// `workspace_id` is the persisted identity of the owning workspace;
    /// `workspace_path` is its execution root recorded as an IO projection.
    pub async fn create_flow_session_record(
        &self,
        session_storage_path: &Path,
        workspace_id: &str,
        workspace_path: &str,
        client_id: &str,
        session_name: Option<String>,
    ) -> OpenBitFunResult<CreateAcpFlowSessionRecordResponse> {
        self.session_persistence
            .create_flow_session_record(
                session_storage_path,
                workspace_id,
                workspace_path,
                client_id,
                session_name,
            )
            .await
    }

    pub async fn initialize_all(self: &Arc<Self>) -> OpenBitFunResult<()> {
        let configs = self.load_configs().await?;
        self.register_configured_tools(&configs).await;

        let configured_ids = configs
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let running_connections = self
            .clients
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().client_id.clone()))
            .collect::<Vec<_>>();
        for (connection_id, client_id) in running_connections {
            let should_stop = !configured_ids.contains(&client_id)
                || configs
                    .get(&client_id)
                    .map(|config| !config.enabled)
                    .unwrap_or(true);
            if should_stop {
                let _ = self.stop_connection(&connection_id).await;
            }
        }

        Ok(())
    }

    pub async fn list_clients(self: &Arc<Self>) -> OpenBitFunResult<Vec<AcpClientInfo>> {
        let configs = self.load_configs().await?;
        let mut infos = Vec::with_capacity(configs.len());
        for (id, config) in configs {
            let clients = self
                .clients
                .iter()
                .filter(|entry| entry.value().client_id == id)
                .map(|entry| entry.value().clone())
                .collect::<Vec<_>>();
            let mut statuses = Vec::with_capacity(clients.len());
            let mut session_count = 0usize;
            for client in &clients {
                statuses.push(*client.status.read().await);
                session_count += client.sessions.len();
            }
            let status = aggregate_client_status(&statuses);
            infos.push(AcpClientInfo {
                tool_name: AcpAgentTool::tool_name_for(&id),
                name: config.name.clone().unwrap_or_else(|| id.clone()),
                command: config.command.clone(),
                args: config.args.clone(),
                enabled: config.enabled,
                readonly: config.readonly,
                subagent: config.subagent.clone(),
                permission_mode: config.permission_mode,
                id,
                status,
                session_count,
            });
        }
        infos.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(infos)
    }

    pub async fn probe_client_requirements(
        self: &Arc<Self>,
        remote_connection_id: Option<&str>,
        force_refresh: bool,
    ) -> OpenBitFunResult<Vec<AcpClientRequirementProbe>> {
        if let Some(remote_connection_id) = remote_connection_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return if force_refresh {
                self.refresh_remote_client_requirements(remote_connection_id)
                    .await
            } else {
                Ok(self
                    .remote_capability_store
                    .get(remote_connection_id)
                    .await
                    .map(|snapshot| snapshot.probes)
                    .unwrap_or_default())
            };
        }

        let configs = self.load_configs().await?;
        let mut ids = configs.keys().cloned().collect::<Vec<_>>();
        for id in builtin_client_ids() {
            if !ids.iter().any(|candidate| candidate == id) {
                ids.push(id.to_string());
            }
        }
        ids.sort();

        let mut probes = Vec::with_capacity(ids.len());
        for id in ids {
            let spec = acp_requirement_spec(&id, configs.get(&id));
            let tool = probe_executable(spec.tool_command).await;
            let adapter = match spec.adapter {
                Some(adapter) => Some(probe_npm_adapter(adapter.package, adapter.bin).await),
                None => None,
            };
            let runnable = tool.installed
                && adapter
                    .as_ref()
                    .map(|adapter| adapter.installed)
                    .unwrap_or(true);
            let mut notes = Vec::new();
            if !tool.installed {
                notes.push(format!("{} is not available on PATH", spec.tool_command));
            }
            if let Some(adapter) = adapter.as_ref() {
                if !adapter.installed {
                    notes.push(format!(
                        "{} is not installed in npm global or offline cache",
                        adapter.name
                    ));
                }
            }

            debug!(
                "ACP requirement probe: id={} tool_installed={} adapter_installed={} runnable={} notes={:?}",
                id,
                tool.installed,
                adapter.as_ref().map(|adapter| adapter.installed).unwrap_or(true),
                runnable,
                notes
            );

            probes.push(AcpClientRequirementProbe {
                id,
                tool,
                adapter,
                runnable,
                notes,
            });
        }

        Ok(probes)
    }

    pub async fn refresh_remote_client_requirements(
        &self,
        remote_connection_id: &str,
    ) -> OpenBitFunResult<Vec<AcpClientRequirementProbe>> {
        let probes = self
            .probe_remote_client_requirements(remote_connection_id)
            .await?;
        self.remote_capability_store
            .set(RemoteAcpClientRequirementSnapshot {
                connection_id: remote_connection_id.to_string(),
                last_probed_at: current_unix_timestamp_ms(),
                probes: probes.clone(),
            })
            .await?;
        Ok(probes)
    }

    async fn probe_remote_client_requirements(
        &self,
        remote_connection_id: &str,
    ) -> OpenBitFunResult<Vec<AcpClientRequirementProbe>> {
        let remote_manager = get_remote_workspace_manager().ok_or_else(|| {
            OpenBitFunError::service("Remote workspace manager is not initialized".to_string())
        })?;
        let ssh_manager = remote_manager.get_ssh_manager().await.ok_or_else(|| {
            OpenBitFunError::service("SSH manager is not available for remote ACP".to_string())
        })?;

        let config_file = self.load_config_file().await?;
        let mut ids = config_file.acp_clients.keys().cloned().collect::<Vec<_>>();
        for id in builtin_client_ids() {
            if !ids.iter().any(|candidate| candidate == id) {
                ids.push(id.to_string());
            }
        }
        ids.sort();

        let mut probes = Vec::with_capacity(ids.len());
        for id in ids {
            let config = resolve_config_for_client(&config_file, &id, Some(remote_connection_id));
            let spec = acp_requirement_spec(&id, config.as_ref());
            let tool = probe_remote_executable(
                &ssh_manager,
                remote_connection_id,
                spec.tool_command,
                config.as_ref().map(|config| &config.env),
            )
            .await;
            let adapter = match spec.adapter {
                Some(adapter) => Some(
                    probe_remote_npx_adapter(
                        &ssh_manager,
                        remote_connection_id,
                        adapter.package,
                        config.as_ref().map(|config| &config.env),
                    )
                    .await,
                ),
                None => None,
            };
            let runnable = tool.installed
                && adapter
                    .as_ref()
                    .map(|adapter| adapter.installed)
                    .unwrap_or(true);
            let mut notes = Vec::new();
            if !tool.installed {
                notes.push(format!(
                    "{} is not available on remote PATH",
                    spec.tool_command
                ));
            }
            if let Some(adapter) = adapter.as_ref() {
                if !adapter.installed {
                    notes.push("npx is not available on remote PATH".to_string());
                }
            }

            debug!(
                "Remote ACP requirement probe: id={} tool_installed={} adapter_installed={} runnable={} notes={:?}",
                id,
                tool.installed,
                adapter.as_ref().map(|adapter| adapter.installed).unwrap_or(true),
                runnable,
                notes
            );

            probes.push(AcpClientRequirementProbe {
                id,
                tool,
                adapter,
                runnable,
                notes,
            });
        }

        Ok(probes)
    }

    pub async fn predownload_client_adapter(
        self: &Arc<Self>,
        client_id: &str,
    ) -> OpenBitFunResult<()> {
        let configs = self.load_configs().await?;
        let spec = acp_requirement_spec(client_id, configs.get(client_id));
        let adapter = spec.adapter.ok_or_else(|| {
            OpenBitFunError::config(format!(
                "ACP client '{}' does not use a downloadable adapter",
                client_id
            ))
        })?;

        predownload_npm_adapter(adapter.package, adapter.bin).await
    }

    pub async fn install_client_cli(
        self: &Arc<Self>,
        client_id: &str,
        remote_connection_id: Option<&str>,
    ) -> OpenBitFunResult<()> {
        let remote_connection_id = remote_connection_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let config_file = self.load_config_file().await?;
        let config = resolve_config_for_client(&config_file, client_id, remote_connection_id);
        let spec = acp_requirement_spec(client_id, config.as_ref());
        let package = spec.install_package.ok_or_else(|| {
            OpenBitFunError::config(format!(
                "ACP client '{}' does not have a known CLI installer",
                client_id
            ))
        })?;

        if let Some(remote_connection_id) = remote_connection_id {
            let remote_manager = get_remote_workspace_manager().ok_or_else(|| {
                OpenBitFunError::service("Remote workspace manager is not initialized".to_string())
            })?;
            let ssh_manager = remote_manager.get_ssh_manager().await.ok_or_else(|| {
                OpenBitFunError::service("SSH manager is not available for remote ACP".to_string())
            })?;
            install_remote_npm_cli_package(&ssh_manager, remote_connection_id, package).await
        } else {
            install_npm_cli_package(package).await
        }
    }

    pub async fn start_client_for_session(
        self: &Arc<Self>,
        client_id: &str,
        openbitfun_session_id: &str,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> OpenBitFunResult<()> {
        let connection_id = session_client_connection_id(client_id, openbitfun_session_id);
        self.start_client_connection(
            &connection_id,
            client_id,
            workspace_path,
            remote_connection_id,
        )
        .await
    }

    async fn start_client_connection(
        self: &Arc<Self>,
        connection_id: &str,
        client_id: &str,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> OpenBitFunResult<()> {
        let (connection, remote_connection_id) = loop {
            if let Some(existing) = self.clients.get(connection_id).map(|entry| entry.clone()) {
                let status = *existing.status.read().await;
                match status {
                    AcpClientStatus::Running => return Ok(()),
                    AcpClientStatus::Starting => {
                        return wait_for_client_connection(existing, connection_id).await;
                    }
                    AcpClientStatus::Configured
                    | AcpClientStatus::Stopped
                    | AcpClientStatus::Failed => {
                        self.clients
                            .remove_if(connection_id, |_, current| Arc::ptr_eq(current, &existing));
                    }
                }
            }

            let StartClientConfig {
                remote_connection_id,
                config,
            } = self
                .resolve_start_client_config(client_id, workspace_path, remote_connection_id)
                .await?;
            let candidate = Arc::new(AcpClientConnection::new(
                connection_id.to_string(),
                client_id.to_string(),
                config,
            ));

            match claim_client_start(&self.clients, connection_id, candidate) {
                ClientStartClaim::Owned(connection) => {
                    break (connection, remote_connection_id);
                }
                ClientStartClaim::Existing(existing) => {
                    let status = *existing.status.read().await;
                    match status {
                        AcpClientStatus::Running => return Ok(()),
                        AcpClientStatus::Starting => {
                            return wait_for_client_connection(existing, connection_id).await;
                        }
                        AcpClientStatus::Configured
                        | AcpClientStatus::Stopped
                        | AcpClientStatus::Failed => {
                            self.clients.remove_if(connection_id, |_, current| {
                                Arc::ptr_eq(current, &existing)
                            });
                        }
                    }
                }
            }
        };

        let transport_result = match remote_connection_id {
            Some(ref remote_connection_id) => {
                self.open_transport_for_connection(
                    client_id,
                    connection_id,
                    &connection.config,
                    workspace_path,
                    Some(remote_connection_id.as_str()),
                )
                .await
            }
            None => {
                self.open_transport_for_connection(
                    client_id,
                    connection_id,
                    &connection.config,
                    workspace_path,
                    None,
                )
                .await
            }
        };
        let (transport, child, stderr_tail) = match transport_result {
            Ok(result) => result,
            Err(error) => {
                *connection.status.write().await = AcpClientStatus::Failed;
                self.clients.remove_if(connection_id, |_, current| {
                    Arc::ptr_eq(current, &connection)
                });
                return Err(error);
            }
        };
        let transport = AcpTransport::new(transport);
        *connection.child.lock().await = child;
        let service = self.clone();
        let connection_for_task = connection.clone();
        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *connection.shutdown_tx.lock().await = Some(shutdown_tx);

        let connect_task = tokio::spawn(async move {
            let result = Client
                .builder()
                .name("openbitfun-acp-client")
                .on_receive_notification(
                    handle_transport_closed,
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    {
                        let service = service.clone();
                        async move |request: RequestPermissionRequest, responder, cx| {
                            let service = service.clone();
                            cx.spawn(async move {
                                responder.respond_with_result(
                                    service.handle_permission_request(request).await,
                                )
                            })?;
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(transport, async move |cx| {
                    let init = InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(ClientCapabilities::new())
                        .client_info(Implementation::new(
                            "openbitfun-desktop",
                            env!("CARGO_PKG_VERSION"),
                        ));
                    let initialize_response = cx.send_request(init).block_task().await?;
                    let _ = cx_tx.send((cx, initialize_response.agent_capabilities));
                    let _ = shutdown_rx.await;
                    Ok(())
                })
                .await;

            if let Err(error) = result {
                warn!(
                    "ACP client connection ended with error: id={} error={:?}",
                    connection_for_task.id, error
                );
                *connection_for_task.status.write().await = AcpClientStatus::Failed;
            } else {
                *connection_for_task.status.write().await = AcpClientStatus::Stopped;
            }
            *connection_for_task.connection.write().await = None;
            *connection_for_task.agent_capabilities.write().await = None;
            connection_for_task.sessions.clear();
        });

        let (cx, agent_capabilities) = match tokio::time::timeout(CLIENT_STARTUP_TIMEOUT, cx_rx)
            .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                connect_task.abort();
                self.cleanup_failed_startup(connection_id).await;
                // The agent is gone; whatever it managed to say on the way out
                // is all anyone has to go on, so put it in front of the user
                // rather than only in the log.
                return Err(OpenBitFunError::service(startup_exit_error_message(
                    client_id,
                    &stderr_tail.drained_detail().await,
                )));
            }
            Err(_) => {
                warn!(
                        "ACP client startup timed out during initialize: id={} connection_id={} timeout_secs={}",
                        client_id,
                        connection_id,
                        CLIENT_STARTUP_TIMEOUT_SECS
                    );
                connect_task.abort();
                self.cleanup_failed_startup(connection_id).await;
                return Err(startup_timeout_error(client_id, "initialize"));
            }
        };
        *connection.connection.write().await = Some(cx);
        *connection.agent_capabilities.write().await = Some(agent_capabilities);
        *connection.status.write().await = AcpClientStatus::Running;
        info!(
            "ACP client started: id={} remote_connection_id={}",
            client_id,
            remote_connection_id.as_deref().unwrap_or("")
        );
        Ok(())
    }

    async fn cleanup_failed_startup(self: &Arc<Self>, connection_id: &str) {
        if let Err(error) = self.stop_connection(connection_id).await {
            warn!(
                "Failed to clean up ACP client after startup failure: connection_id={} error={}",
                connection_id, error
            );
        }
    }

    pub async fn stop_client(self: &Arc<Self>, client_id: &str) -> OpenBitFunResult<()> {
        let connection_ids = self
            .clients
            .iter()
            .filter(|entry| entry.value().client_id == client_id)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for connection_id in connection_ids {
            self.stop_connection(&connection_id).await?;
        }
        Ok(())
    }

    async fn stop_connection(self: &Arc<Self>, connection_id: &str) -> OpenBitFunResult<()> {
        let Some(client) = self.clients.get(connection_id).map(|entry| entry.clone()) else {
            return Ok(());
        };

        if let Some(tx) = client.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        if let Some(child) = client.child.lock().await.take() {
            terminate_child_process_tree(connection_id, child).await;
        }
        *client.connection.write().await = None;
        *client.agent_capabilities.write().await = None;
        client.sessions.clear();
        client.cancel_handles.clear();
        *client.status.write().await = AcpClientStatus::Stopped;
        self.clients.remove(connection_id);
        info!(
            "ACP client stopped: id={} client_id={}",
            connection_id, client.client_id
        );
        Ok(())
    }

    pub async fn release_openbitfun_session(self: &Arc<Self>, openbitfun_session_id: &str) -> bool {
        let session_key_prefix = format!("{}:", openbitfun_session_id);
        let clients = self
            .clients
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut released = false;
        let mut idle_client_ids = Vec::new();

        for client in clients {
            let session_keys = client
                .sessions
                .iter()
                .filter(|entry| entry.key().starts_with(&session_key_prefix))
                .map(|entry| entry.key().clone())
                .collect::<Vec<_>>();
            if session_keys.is_empty() {
                continue;
            }

            released = true;
            let supports_close = client
                .agent_capabilities
                .read()
                .await
                .as_ref()
                .and_then(|capabilities| capabilities.session_capabilities.close.as_ref())
                .is_some();

            for session_key in session_keys {
                let active_session_id =
                    if let Some((_, session)) = client.sessions.remove(&session_key) {
                        let mut session = session.lock().await;
                        let session_id = session
                            .active
                            .as_ref()
                            .map(|active| active.session_id().to_string());
                        session.active = None;
                        session_id
                    } else {
                        None
                    };
                let cancel_handle = client
                    .cancel_handles
                    .remove(&session_key)
                    .map(|(_, handle)| handle);
                let remote_session_id = cancel_handle
                    .as_ref()
                    .map(|handle| handle.session_id.clone())
                    .or(active_session_id);

                let Some(remote_session_id) = remote_session_id else {
                    continue;
                };

                self.session_permission_modes.remove(&remote_session_id);
                let connection = cancel_handle
                    .as_ref()
                    .map(|handle| handle.connection.clone());
                close_or_cancel_remote_session(
                    &client,
                    connection,
                    &remote_session_id,
                    supports_close,
                )
                .await;
            }

            if client.id != client.client_id
                && client.sessions.is_empty()
                && client.cancel_handles.is_empty()
            {
                idle_client_ids.push(client.id.clone());
            }
        }

        for connection_id in idle_client_ids {
            if let Err(error) = self.stop_connection(&connection_id).await {
                warn!(
                    "Failed to stop idle ACP client after session release: id={} error={}",
                    connection_id, error
                );
            }
        }

        released
    }

    pub async fn delete_flow_session_record(
        &self,
        session_storage_path: &Path,
        openbitfun_session_id: &str,
    ) -> OpenBitFunResult<()> {
        self.session_persistence
            .delete_flow_session_record(session_storage_path, openbitfun_session_id)
            .await
    }

    pub async fn load_json_config(&self) -> OpenBitFunResult<String> {
        let config = parse_config_value(self.load_config_value().await?)?;
        serde_json::to_string_pretty(&config).map_err(|error| {
            OpenBitFunError::config(format!("Failed to render ACP config: {}", error))
        })
    }

    pub async fn save_json_config(self: &Arc<Self>, json_config: &str) -> OpenBitFunResult<()> {
        let value: serde_json::Value = serde_json::from_str(json_config).map_err(|error| {
            OpenBitFunError::config(format!("Invalid ACP client JSON config: {}", error))
        })?;
        let config = parse_config_value(value)?;
        let canonical_value = serde_json::to_value(config).map_err(|error| {
            OpenBitFunError::config(format!("Failed to render ACP config: {}", error))
        })?;
        self.config_service
            .set_config(CONFIG_PATH, canonical_value)
            .await?;
        self.remote_capability_store.clear().await?;
        self.initialize_all().await
    }

    pub async fn submit_permission_response(
        &self,
        request: SubmitAcpPermissionResponseRequest,
    ) -> OpenBitFunResult<AcpClientPermissionResponse> {
        let Some((_, pending)) = self.pending_permissions.remove(&request.permission_id) else {
            return Err(OpenBitFunError::NotFound(format!(
                "ACP permission request not found: {}",
                request.permission_id
            )));
        };

        let option_id = request
            .option_id
            .unwrap_or_else(|| select_permission_option_id(&pending.options, request.approve));
        let response = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option_id),
        ));
        let _ = pending.sender.send(response);
        Ok(AcpClientPermissionResponse {
            permission_id: request.permission_id,
            resolved: true,
        })
    }

    pub async fn get_session_options(
        self: &Arc<Self>,
        client_id: &str,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        session_storage_path: Option<PathBuf>,
        openbitfun_session_id: String,
    ) -> OpenBitFunResult<AcpSessionOptions> {
        let resolved = self
            .resolve_or_create_client_session(
                client_id,
                workspace_path,
                remote_connection_id.as_deref(),
                &openbitfun_session_id,
            )
            .await?;

        let mut session = resolved.session.lock().await;
        self.ensure_remote_session(
            &resolved.client,
            &resolved.session_key,
            &resolved.cwd,
            &openbitfun_session_id,
            session_storage_path.as_deref(),
            &mut session,
        )
        .await?;
        drain_pending_session_metadata_updates(&mut session).await?;
        Ok(session_options_from_state(
            session.models.as_ref(),
            &session.config_options,
            session.context_usage.as_ref(),
        ))
    }

    pub async fn get_session_commands(
        self: &Arc<Self>,
        client_id: &str,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        session_storage_path: Option<PathBuf>,
        openbitfun_session_id: String,
    ) -> OpenBitFunResult<Vec<AcpAvailableCommand>> {
        let resolved = self
            .resolve_or_create_client_session(
                client_id,
                workspace_path,
                remote_connection_id.as_deref(),
                &openbitfun_session_id,
            )
            .await?;

        let mut session = resolved.session.lock().await;
        self.ensure_remote_session(
            &resolved.client,
            &resolved.session_key,
            &resolved.cwd,
            &openbitfun_session_id,
            session_storage_path.as_deref(),
            &mut session,
        )
        .await?;
        drain_pending_session_metadata_updates(&mut session).await?;
        Ok(session.available_commands.clone())
    }

    pub async fn set_session_model(
        self: &Arc<Self>,
        request: SetAcpSessionModelRequest,
        session_storage_path: Option<PathBuf>,
    ) -> OpenBitFunResult<AcpSessionOptions> {
        let resolved = self
            .resolve_or_create_client_session(
                &request.client_id,
                request.workspace_path,
                request.remote_connection_id.as_deref(),
                &request.session_id,
            )
            .await?;

        let mut session = resolved.session.lock().await;
        self.ensure_remote_session(
            &resolved.client,
            &resolved.session_key,
            &resolved.cwd,
            &request.session_id,
            session_storage_path.as_deref(),
            &mut session,
        )
        .await?;
        let active = session
            .active
            .as_ref()
            .ok_or_else(|| OpenBitFunError::service("ACP session was not initialized"))?;
        let remote_session_id = active.session_id().to_string();
        let connection = active.connection();

        let mut set_model_error = None;
        if session.models.is_some() {
            match connection
                .send_request(SetSessionModelRequest::new(
                    remote_session_id.clone(),
                    request.model_id.clone(),
                ))
                .block_task()
                .await
                .map_err(protocol_error)
            {
                Ok(_) => {
                    if let Some(models) = session.models.as_mut() {
                        models.current_model_id = request.model_id.clone().into();
                    }
                    if let Some(session_storage_path) = session_storage_path.as_deref() {
                        self.session_persistence
                            .update_model_id(
                                session_storage_path,
                                &request.session_id,
                                &request.model_id,
                            )
                            .await?;
                    }
                    return Ok(session_options_from_state(
                        session.models.as_ref(),
                        &session.config_options,
                        session.context_usage.as_ref(),
                    ));
                }
                Err(error) => {
                    set_model_error = Some(error);
                }
            }
        }

        if let Some(config_id) = model_config_id(&session.config_options) {
            let response = connection
                .send_request(SetSessionConfigOptionRequest::new(
                    remote_session_id,
                    config_id,
                    SessionConfigOptionValue::value_id(request.model_id.clone()),
                ))
                .block_task()
                .await
                .map_err(protocol_error)?;
            session.config_options = response.config_options;
            if let Some(session_storage_path) = session_storage_path.as_deref() {
                self.session_persistence
                    .update_model_id(session_storage_path, &request.session_id, &request.model_id)
                    .await?;
            }
            return Ok(session_options_from_state(
                session.models.as_ref(),
                &session.config_options,
                session.context_usage.as_ref(),
            ));
        }

        if let Some(error) = set_model_error {
            return Err(error);
        }
        Err(OpenBitFunError::NotFound(
            "ACP session does not expose selectable models".to_string(),
        ))
    }

    pub async fn set_session_config_option(
        self: &Arc<Self>,
        request: SetAcpSessionConfigOptionRequest,
        session_storage_path: Option<PathBuf>,
    ) -> OpenBitFunResult<AcpSessionOptions> {
        let resolved = self
            .resolve_or_create_client_session(
                &request.client_id,
                request.workspace_path,
                request.remote_connection_id.as_deref(),
                &request.session_id,
            )
            .await?;

        let mut session = resolved.session.lock().await;
        self.ensure_remote_session(
            &resolved.client,
            &resolved.session_key,
            &resolved.cwd,
            &request.session_id,
            session_storage_path.as_deref(),
            &mut session,
        )
        .await?;
        let active = session
            .active
            .as_ref()
            .ok_or_else(|| OpenBitFunError::service("ACP session was not initialized"))?;
        let remote_session_id = active.session_id().to_string();
        let connection = active.connection();

        if !session
            .config_options
            .iter()
            .any(|option| option.id.to_string() == request.config_id)
        {
            return Err(OpenBitFunError::NotFound(format!(
                "ACP session config option not found: {}",
                request.config_id
            )));
        }

        let response = connection
            .send_request(SetSessionConfigOptionRequest::new(
                remote_session_id,
                request.config_id,
                request.value.into_protocol_value(),
            ))
            .block_task()
            .await
            .map_err(protocol_error)?;
        session.config_options = response.config_options;

        Ok(session_options_from_state(
            session.models.as_ref(),
            &session.config_options,
            session.context_usage.as_ref(),
        ))
    }

    pub async fn prompt_agent(
        self: &Arc<Self>,
        client_id: &str,
        prompt: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        openbitfun_session_id: String,
        session_storage_path: Option<PathBuf>,
        timeout_seconds: Option<u64>,
    ) -> OpenBitFunResult<String> {
        let resolved = self
            .resolve_or_create_client_session(
                client_id,
                workspace_path,
                remote_connection_id.as_deref(),
                &openbitfun_session_id,
            )
            .await?;

        let run = async {
            let mut session = resolved.session.lock().await;
            self.ensure_remote_session(
                &resolved.client,
                &resolved.session_key,
                &resolved.cwd,
                &openbitfun_session_id,
                session_storage_path.as_deref(),
                &mut session,
            )
            .await?;

            discard_pending_session_updates_if_needed(&mut session).await;
            let active = session
                .active
                .as_mut()
                .ok_or_else(|| OpenBitFunError::service("ACP session was not initialized"))?;
            let mut prompt = AcpPrompt::start(active, prompt);
            read_turn_to_string(&mut session, &mut prompt).await
        };

        if let Some(seconds) = timeout_seconds.filter(|seconds| *seconds > 0) {
            tokio::time::timeout(Duration::from_secs(seconds), run)
                .await
                .map_err(|_| {
                    OpenBitFunError::tool(format!("ACP client timed out after {}s", seconds))
                })?
        } else {
            run.await
        }
    }

    pub async fn prompt_agent_stream<F>(
        self: &Arc<Self>,
        client_id: &str,
        prompt: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        openbitfun_session_id: String,
        session_storage_path: Option<PathBuf>,
        timeout_seconds: Option<u64>,
        mut on_event: F,
    ) -> OpenBitFunResult<()>
    where
        F: FnMut(AcpClientStreamEvent) -> OpenBitFunResult<()> + Send,
    {
        let resolved = self
            .resolve_or_create_client_session(
                client_id,
                workspace_path,
                remote_connection_id.as_deref(),
                &openbitfun_session_id,
            )
            .await?;

        let run = async {
            let mut session = resolved.session.lock().await;
            self.ensure_remote_session(
                &resolved.client,
                &resolved.session_key,
                &resolved.cwd,
                &openbitfun_session_id,
                session_storage_path.as_deref(),
                &mut session,
            )
            .await?;

            discard_pending_session_updates_if_needed(&mut session).await;
            let mut prompt = {
                let active = session
                    .active
                    .as_mut()
                    .ok_or_else(|| OpenBitFunError::service("ACP session was not initialized"))?;
                AcpPrompt::start(active, prompt)
            };
            let mut round_tracker = AcpStreamRoundTracker::new();
            let mut tool_call_tracker = AcpToolCallTracker::new();

            loop {
                let message = {
                    let active = session.active.as_mut().ok_or_else(|| {
                        OpenBitFunError::service("ACP session was not initialized")
                    })?;
                    prompt.read_update(active).await.map_err(protocol_error)?
                };

                match message {
                    SessionMessage::SessionMessage(dispatch) => {
                        let events = acp_dispatch_to_stream_events_with_tracker(
                            dispatch,
                            &mut tool_call_tracker,
                        )
                        .await?;
                        update_session_from_events(&mut session, &events);
                        for event in events {
                            for event in round_tracker.apply(event) {
                                on_event(event)?;
                            }
                        }
                    }
                    SessionMessage::StopReason(stop_reason) => {
                        drain_pending_turn_updates(
                            &mut session,
                            &mut tool_call_tracker,
                            &mut round_tracker,
                            &mut on_event,
                        )
                        .await?;
                        let event = if matches!(stop_reason, StopReason::Cancelled) {
                            AcpClientStreamEvent::Cancelled
                        } else {
                            AcpClientStreamEvent::Completed
                        };
                        on_event(event)?;
                        break;
                    }
                    _ => {}
                }
            }
            Ok(())
        };

        if let Some(seconds) = timeout_seconds.filter(|seconds| *seconds > 0) {
            tokio::time::timeout(Duration::from_secs(seconds), run)
                .await
                .map_err(|_| {
                    OpenBitFunError::tool(format!("ACP client timed out after {}s", seconds))
                })?
        } else {
            run.await
        }
    }

    pub async fn cancel_agent_session(
        self: &Arc<Self>,
        client_id: &str,
        workspace_path: Option<String>,
        openbitfun_session_id: String,
    ) -> OpenBitFunResult<()> {
        let connection_id = session_client_connection_id(client_id, &openbitfun_session_id);
        let client = self
            .clients
            .get(&connection_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| {
                OpenBitFunError::service(format!("ACP client is not running: {}", client_id))
            })?;

        let cwd = workspace_path
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| OpenBitFunError::validation("Workspace path is required".to_string()))?;
        let session_key = build_session_key(&openbitfun_session_id, client_id, &cwd);
        let handle = client.cancel_handles.get(&session_key).ok_or_else(|| {
            OpenBitFunError::NotFound(format!(
                "ACP session is not active for client '{}' in workspace '{}'",
                client_id,
                cwd.display()
            ))
        })?;

        handle
            .connection
            .send_notification(CancelNotification::new(handle.session_id.clone()))
            .map_err(protocol_error)?;
        Ok(())
    }

    pub async fn cancel_openbitfun_session(
        self: &Arc<Self>,
        openbitfun_session_id: &str,
    ) -> OpenBitFunResult<bool> {
        let session_key_prefix = format!("{}:", openbitfun_session_id);
        for client in self.clients.iter().map(|entry| entry.value().clone()) {
            let handle = client
                .cancel_handles
                .iter()
                .find(|entry| entry.key().starts_with(&session_key_prefix))
                .map(|entry| entry.value().clone());

            if let Some(handle) = handle {
                handle
                    .connection
                    .send_notification(CancelNotification::new(handle.session_id.clone()))
                    .map_err(protocol_error)?;
                return Ok(true);
            }
        }

        Ok(false)
    }

    async fn resolve_client_session(
        self: &Arc<Self>,
        client_id: &str,
        workspace_path: Option<String>,
        remote_connection_id: Option<&str>,
        openbitfun_session_id: &str,
    ) -> OpenBitFunResult<(Arc<AcpClientConnection>, PathBuf, String)> {
        let connection_id = session_client_connection_id(client_id, openbitfun_session_id);
        self.start_client_connection(
            &connection_id,
            client_id,
            workspace_path.as_deref(),
            remote_connection_id,
        )
        .await?;
        let client = self
            .clients
            .get(&connection_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| {
                OpenBitFunError::service(format!("ACP client is not running: {}", client_id))
            })?;

        let cwd = workspace_path
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| OpenBitFunError::validation("Workspace path is required".to_string()))?;
        let session_key = build_session_key(openbitfun_session_id, client_id, &cwd);
        Ok((client, cwd, session_key))
    }

    async fn resolve_or_create_client_session(
        self: &Arc<Self>,
        client_id: &str,
        workspace_path: Option<String>,
        remote_connection_id: Option<&str>,
        openbitfun_session_id: &str,
    ) -> OpenBitFunResult<ResolvedClientSession> {
        let (client, cwd, session_key) = self
            .resolve_client_session(
                client_id,
                workspace_path,
                remote_connection_id,
                openbitfun_session_id,
            )
            .await?;
        let session = client
            .sessions
            .entry(session_key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(AcpRemoteSession::new())))
            .clone();
        Ok(ResolvedClientSession {
            client,
            cwd,
            session_key,
            session,
        })
    }

    async fn ensure_remote_session(
        self: &Arc<Self>,
        client: &Arc<AcpClientConnection>,
        session_key: &str,
        cwd: &Path,
        openbitfun_session_id: &str,
        session_storage_path: Option<&Path>,
        session: &mut AcpRemoteSession,
    ) -> OpenBitFunResult<()> {
        if session.active.is_some() {
            return Ok(());
        }

        let cx = client.connection().await?;
        let persisted_remote_session_id = if let Some(session_storage_path) = session_storage_path {
            self.session_persistence
                .load_remote_session_id(session_storage_path, openbitfun_session_id)
                .await?
        } else {
            None
        };
        let capabilities = client.agent_capabilities.read().await.clone();
        let mut last_resume_error: Option<String> = None;

        for strategy in preferred_resume_strategies(
            capabilities.as_ref(),
            persisted_remote_session_id.as_deref(),
        ) {
            let response = match strategy {
                AcpRemoteSessionStrategy::Load => {
                    let Some(remote_session_id) = persisted_remote_session_id.as_deref() else {
                        continue;
                    };
                    match self
                        .run_startup_step(
                            client,
                            strategy.startup_phase_name(),
                            cx.send_request(LoadSessionRequest::new(
                                remote_session_id.to_string(),
                                cwd,
                            ))
                            .block_task(),
                        )
                        .await
                        .map_err(protocol_error)
                    {
                        Ok(response) => new_session_response_from_load(remote_session_id, response),
                        Err(error) => {
                            if is_startup_timeout_error(&error) {
                                return Err(error);
                            }
                            warn!(
                                "Failed to load ACP remote session, falling back: client_id={}, remote_session_id={}, error={}",
                                client.id, remote_session_id, error
                            );
                            last_resume_error = Some(error.to_string());
                            continue;
                        }
                    }
                }
                AcpRemoteSessionStrategy::Resume => {
                    let Some(remote_session_id) = persisted_remote_session_id.as_deref() else {
                        continue;
                    };
                    match self
                        .run_startup_step(
                            client,
                            strategy.startup_phase_name(),
                            cx.send_request(ResumeSessionRequest::new(
                                remote_session_id.to_string(),
                                cwd,
                            ))
                            .block_task(),
                        )
                        .await
                        .map_err(protocol_error)
                    {
                        Ok(response) => {
                            new_session_response_from_resume(remote_session_id, response)
                        }
                        Err(error) => {
                            if is_startup_timeout_error(&error) {
                                return Err(error);
                            }
                            warn!(
                                "Failed to resume ACP remote session, falling back: client_id={}, remote_session_id={}, error={}",
                                client.id, remote_session_id, error
                            );
                            last_resume_error = Some(error.to_string());
                            continue;
                        }
                    }
                }
                AcpRemoteSessionStrategy::New => self
                    .run_startup_step(
                        client,
                        strategy.startup_phase_name(),
                        cx.send_request(NewSessionRequest::new(cwd)).block_task(),
                    )
                    .await
                    .map_err(protocol_error)?,
            };

            self.attach_remote_session(
                client,
                session_key,
                openbitfun_session_id,
                session_storage_path,
                session,
                response,
                strategy,
                last_resume_error.clone(),
            )
            .await?;
            return Ok(());
        }

        Err(OpenBitFunError::service(
            "Failed to initialize ACP remote session".to_string(),
        ))
    }

    async fn run_startup_step<T, F>(
        self: &Arc<Self>,
        client: &Arc<AcpClientConnection>,
        phase: &'static str,
        future: F,
    ) -> Result<T, Error>
    where
        F: Future<Output = Result<T, Error>>,
    {
        match tokio::time::timeout(CLIENT_STARTUP_TIMEOUT, future).await {
            Ok(result) => result,
            Err(_) => {
                warn!(
                    "ACP client startup timed out: id={} connection_id={} phase={} timeout_secs={}",
                    client.client_id, client.id, phase, CLIENT_STARTUP_TIMEOUT_SECS
                );
                self.cleanup_failed_startup(&client.id).await;
                Err(agent_client_protocol::util::internal_error(
                    startup_timeout_error_message(&client.client_id, phase),
                ))
            }
        }
    }

    async fn attach_remote_session(
        &self,
        client: &Arc<AcpClientConnection>,
        session_key: &str,
        openbitfun_session_id: &str,
        session_storage_path: Option<&Path>,
        session: &mut AcpRemoteSession,
        response: NewSessionResponse,
        strategy: AcpRemoteSessionStrategy,
        last_resume_error: Option<String>,
    ) -> OpenBitFunResult<()> {
        let cx = client.connection().await?;
        let models = response.models.clone();
        let config_options = response.config_options.clone().unwrap_or_default();
        let active = cx
            .attach_session(response, Vec::new())
            .map_err(protocol_error)?;
        let remote_session_id = active.session_id().to_string();
        client.cancel_handles.insert(
            session_key.to_string(),
            AcpCancelHandle {
                session_id: remote_session_id.clone(),
                connection: active.connection(),
            },
        );
        self.session_permission_modes
            .insert(remote_session_id.clone(), client.config.permission_mode);
        if let Some(session_storage_path) = session_storage_path {
            self.session_persistence
                .update_remote_session_state(
                    session_storage_path,
                    openbitfun_session_id,
                    &remote_session_id,
                    strategy.as_str(),
                    last_resume_error,
                )
                .await?;
        }
        session.models = models;
        session.config_options = config_options;
        session.discard_pending_updates_before_next_prompt =
            matches!(strategy, AcpRemoteSessionStrategy::Load);
        session.active = Some(active);
        Ok(())
    }

    async fn load_configs(&self) -> OpenBitFunResult<HashMap<String, AcpClientConfig>> {
        Ok(self.load_config_file().await?.acp_clients)
    }

    async fn load_config_file(&self) -> OpenBitFunResult<AcpClientConfigFile> {
        parse_config_value(self.load_config_value().await?)
    }

    async fn load_config_value(&self) -> OpenBitFunResult<serde_json::Value> {
        Ok(self
            .config_service
            .get_config::<serde_json::Value>(Some(CONFIG_PATH))
            .await
            .unwrap_or_else(|_| json!({ "acpClients": {} })))
    }

    async fn register_configured_tools(
        self: &Arc<Self>,
        configs: &HashMap<String, AcpClientConfig>,
    ) {
        let registry = get_global_tool_registry();
        let mut registry = registry.write().await;
        registry.unregister_tools_by_prefix(ACP_TOOL_PREFIX);

        let tools = configs
            .iter()
            .filter(|(_, config)| config.enabled && config.subagent.enabled)
            .map(|(id, config)| {
                Arc::new(AcpAgentTool::new(id.clone(), config.clone(), self.clone()))
                    as Arc<dyn openbitfun_core::agentic::tools::framework::Tool>
            })
            .collect::<Vec<_>>();

        for tool in tools {
            debug!("Registering ACP client tool: name={}", tool.name());
            registry.register_tool(tool);
        }
    }

    async fn handle_permission_request(
        self: Arc<Self>,
        request: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, Error> {
        let session_id = request.session_id.to_string();
        let permission_mode = self.permission_mode_for_session(&session_id);
        match permission_mode {
            AcpClientPermissionMode::AllowOnce => {
                return Ok(select_permission_by_kind(
                    &request,
                    PermissionOptionKind::AllowOnce,
                    true,
                ));
            }
            AcpClientPermissionMode::RejectOnce => {
                return Ok(select_permission_by_kind(
                    &request,
                    PermissionOptionKind::RejectOnce,
                    false,
                ));
            }
            AcpClientPermissionMode::Ask => {}
        }

        let permission_id = format!("acp_permission_{}", uuid::Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        self.pending_permissions.insert(
            permission_id.clone(),
            PendingPermission {
                sender: tx,
                options: request.options.clone(),
            },
        );

        let payload = json!({
            "permissionId": permission_id,
            "sessionId": session_id,
            "toolCall": request.tool_call,
            "options": request.options,
        });

        if let Err(error) = emit_global_event(BackendEvent::Custom {
            event_name: "backend-event-acppermissionrequest".to_string(),
            payload,
        })
        .await
        {
            warn!("Failed to emit ACP permission request: {}", error);
        }

        match tokio::time::timeout(PERMISSION_TIMEOUT, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Ok(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            )),
            Err(_) => {
                self.pending_permissions.remove(&permission_id);
                Ok(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            }
        }
    }

    fn permission_mode_for_session(&self, session_id: &str) -> AcpClientPermissionMode {
        self.session_permission_modes
            .get(session_id)
            .map(|entry| *entry.value())
            .unwrap_or(AcpClientPermissionMode::Ask)
    }

    async fn start_local_transport(
        &self,
        client_id: &str,
        connection_id: &str,
        config: &AcpClientConfig,
    ) -> OpenBitFunResult<(
        ByteStreams<AcpOutgoingStream, AcpIncomingStream>,
        Child,
        StderrTail,
    )> {
        // An agent whose runtime OpenBitFun ships (dsh) needs it in place before the
        // command runs, because the command's only job is to boot it.
        if let Some(profile) = builtin_acp_client_preset(client_id).and_then(|p| p.bundled_profile)
        {
            ensure_bundled_profile(profile).await?;
        }

        let program = resolve_configured_command(&config.command, &config.env);
        let mut command = openbitfun_core::util::process_manager::create_tokio_command(&program);
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inheriting sent this to a terminal that a packaged app does not
            // have, so a local agent that died at startup was as silent as a
            // remote one. Read it instead: it goes to the log, and its tail
            // goes into the error the user is shown.
            .stderr(Stdio::piped());
        apply_command_environment(&mut command, Some(&config.env));
        configure_process_group(&mut command);

        let mut child = command.spawn().map_err(|error| {
            OpenBitFunError::service(format!(
                "Failed to spawn ACP client '{}': {}",
                client_id, error
            ))
        })?;

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                terminate_child_process_tree(connection_id, child).await;
                return Err(OpenBitFunError::service(format!(
                    "ACP client '{}' stdout is unavailable",
                    client_id
                )));
            }
        };
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                terminate_child_process_tree(connection_id, child).await;
                return Err(OpenBitFunError::service(format!(
                    "ACP client '{}' stdin is unavailable",
                    client_id
                )));
            }
        };

        let stderr_tail = match child.stderr.take() {
            Some(stderr) => spawn_stderr_reader(client_id, stderr),
            None => StderrTail::default(),
        };

        Ok((
            ByteStreams::new(Box::pin(stdin.compat_write()), Box::pin(stdout.compat())),
            child,
            stderr_tail,
        ))
    }

    async fn open_transport_for_connection(
        &self,
        client_id: &str,
        connection_id: &str,
        config: &AcpClientConfig,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> OpenBitFunResult<(
        ByteStreams<AcpOutgoingStream, AcpIncomingStream>,
        Option<Child>,
        StderrTail,
    )> {
        match remote_connection_id {
            Some(remote_connection_id) => self
                .start_remote_transport(client_id, config, workspace_path, remote_connection_id)
                .await
                .map(|(transport, stderr_tail)| (transport, None, stderr_tail)),
            None => self
                .start_local_transport(client_id, connection_id, config)
                .await
                .map(|(transport, child, stderr_tail)| (transport, Some(child), stderr_tail)),
        }
    }

    async fn start_remote_transport(
        &self,
        client_id: &str,
        config: &AcpClientConfig,
        workspace_path: Option<&str>,
        remote_connection_id: &str,
    ) -> OpenBitFunResult<(
        ByteStreams<AcpOutgoingStream, AcpIncomingStream>,
        StderrTail,
    )> {
        let command = render_remote_client_command(config, workspace_path)?;
        let remote_manager = get_remote_workspace_manager().ok_or_else(|| {
            OpenBitFunError::service("Remote workspace manager is not initialized".to_string())
        })?;
        let ssh_manager = remote_manager.get_ssh_manager().await.ok_or_else(|| {
            OpenBitFunError::service("SSH manager is not available for remote ACP".to_string())
        })?;
        // Same reason as `start_local_transport`: the command below only boots
        // the runtime OpenBitFun ships, so it has to be on that host first.
        if let Some(profile) = builtin_acp_client_preset(client_id).and_then(|p| p.bundled_profile)
        {
            ensure_bundled_profile_remote(
                profile,
                config.command.trim(),
                &config.env,
                &ssh_manager,
                remote_connection_id,
            )
            .await?;
        }
        let transport = ssh_manager
            .open_workspace_stdio(remote_connection_id, &command)
            .await
            .map_err(|error| {
                OpenBitFunError::service(format!(
                    "Failed to start remote ACP client '{}': {}",
                    client_id, error
                ))
            })?;
        let (writer, reader, stderr, _control, completion) = transport.into_parts();
        // Whatever the remote agent says on its way out is the only explanation
        // a user gets when it dies at startup; sinking it leaves nothing behind
        // but an unexplained broken pipe.
        let stderr_tail = spawn_stderr_reader(client_id, stderr);
        // An agent that dies mid-session leaves the same broken pipe behind as
        // one that never started, so record which it was.
        let exit_client_id = client_id.to_string();
        tokio::spawn(async move {
            let exit = completion.wait().await;
            log::info!(
                "Remote ACP client exited: id={exit_client_id} exit_code={:?}",
                exit.exit_code
            );
        });
        Ok((
            ByteStreams::new(Box::pin(writer.compat_write()), Box::pin(reader.compat())),
            stderr_tail,
        ))
    }

    async fn resolve_start_client_config(
        &self,
        client_id: &str,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
    ) -> OpenBitFunResult<StartClientConfig> {
        let remote_connection_id = remote_connection_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let is_remote = remote_connection_id.is_some();
        let config_file = self.load_config_file().await?;
        let config =
            resolve_config_for_client(&config_file, client_id, remote_connection_id.as_deref())
                .ok_or_else(|| {
                    OpenBitFunError::NotFound(format!("ACP client not found: {}", client_id))
                })?;

        if config.command.trim().is_empty() {
            return Err(OpenBitFunError::config(format!(
                "ACP client command is empty: {}",
                client_id
            )));
        }
        if !config.enabled {
            return Err(OpenBitFunError::config(format!(
                "ACP client is disabled: {}",
                client_id
            )));
        }

        if is_remote {
            ensure_remote_client_supported(client_id, workspace_path)?;
        }

        Ok(StartClientConfig {
            remote_connection_id,
            config,
        })
    }
}

fn resolve_config_for_client(
    config_file: &AcpClientConfigFile,
    client_id: &str,
    remote_connection_id: Option<&str>,
) -> Option<AcpClientConfig> {
    config_file
        .acp_clients
        .get(client_id)
        .cloned()
        .or_else(|| remote_connection_id.and_then(|_| default_config_for_builtin_client(client_id)))
}

fn ensure_remote_client_supported(
    _client_id: &str,
    workspace_path: Option<&str>,
) -> OpenBitFunResult<()> {
    if workspace_path
        .map(str::trim)
        .is_none_or(|workspace_path| workspace_path.is_empty())
    {
        return Err(OpenBitFunError::validation(
            "Workspace path is required for remote ACP sessions".to_string(),
        ));
    }

    Ok(())
}

fn render_remote_client_command(
    config: &AcpClientConfig,
    workspace_path: Option<&str>,
) -> OpenBitFunResult<String> {
    let command = config.command.trim();
    if command.is_empty() {
        return Err(OpenBitFunError::config(
            "ACP client command is empty".to_string(),
        ));
    }

    let mut command_parts = Vec::new();
    command_parts.push(shell_escape(command));
    command_parts.extend(config.args.iter().map(|arg| shell_escape(arg)));

    let mut parts = Vec::new();
    parts.push("exec".to_string());
    let env_assignments = render_remote_env_assignments(&config.env);
    if !env_assignments.is_empty() {
        parts.push("env".to_string());
        parts.extend(env_assignments);
    }
    parts.extend(command_parts);

    let command = parts.join(" ");
    let workspace_path = workspace_path.map(str::trim).unwrap_or_default();
    let body = if workspace_path.is_empty() {
        command
    } else {
        format!("cd {} && {}", shell_escape(workspace_path), command)
    };
    Ok(remote_user_shell_command(&body))
}

fn current_unix_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl AcpClientConnection {
    fn new(id: String, client_id: String, config: AcpClientConfig) -> Self {
        Self {
            id,
            client_id,
            config,
            status: RwLock::new(AcpClientStatus::Starting),
            connection: RwLock::new(None),
            agent_capabilities: RwLock::new(None),
            sessions: DashMap::new(),
            cancel_handles: DashMap::new(),
            shutdown_tx: Mutex::new(None),
            child: Mutex::new(None),
        }
    }

    async fn connection(&self) -> OpenBitFunResult<ConnectionTo<Agent>> {
        self.connection.read().await.clone().ok_or_else(|| {
            OpenBitFunError::service(format!("ACP client is not connected: {}", self.id))
        })
    }
}

enum ClientStartClaim {
    Owned(Arc<AcpClientConnection>),
    Existing(Arc<AcpClientConnection>),
}

fn claim_client_start(
    clients: &DashMap<String, Arc<AcpClientConnection>>,
    connection_id: &str,
    candidate: Arc<AcpClientConnection>,
) -> ClientStartClaim {
    match clients.entry(connection_id.to_string()) {
        Entry::Vacant(entry) => {
            entry.insert(candidate.clone());
            ClientStartClaim::Owned(candidate)
        }
        Entry::Occupied(entry) => ClientStartClaim::Existing(entry.get().clone()),
    }
}

async fn wait_for_client_connection(
    client: Arc<AcpClientConnection>,
    connection_id: &str,
) -> OpenBitFunResult<()> {
    let started_at = Instant::now();
    loop {
        if client.connection.read().await.is_some() {
            return Ok(());
        }

        let status = *client.status.read().await;
        if matches!(status, AcpClientStatus::Failed | AcpClientStatus::Stopped) {
            return Err(OpenBitFunError::service(format!(
                "ACP client '{}' is not running",
                connection_id
            )));
        }

        if started_at.elapsed() >= CLIENT_STARTUP_TIMEOUT {
            return Err(startup_timeout_error(&client.client_id, "initialize"));
        }

        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn parse_config_value(value: serde_json::Value) -> OpenBitFunResult<AcpClientConfigFile> {
    let mut config = if value.get("acpClients").is_some() {
        serde_json::from_value(value).map_err(|error| {
            OpenBitFunError::config(format!("Invalid ACP client config: {}", error))
        })
    } else if value.is_object() {
        serde_json::from_value(json!({ "acpClients": value })).map_err(|error| {
            OpenBitFunError::config(format!("Invalid ACP client config map: {}", error))
        })
    } else {
        Err(OpenBitFunError::config(
            "ACP client config must be an object".to_string(),
        ))
    }?;
    migrate_legacy_builtin_client_configs(&mut config);
    Ok(config)
}

fn build_session_key(openbitfun_session_id: &str, client_id: &str, cwd: &Path) -> String {
    format!(
        "{}:{}:{}",
        openbitfun_session_id,
        client_id,
        cwd.to_string_lossy()
    )
}

fn session_client_connection_id(client_id: &str, openbitfun_session_id: &str) -> String {
    format!("{}::session::{}", client_id, openbitfun_session_id)
}

fn aggregate_client_status(statuses: &[AcpClientStatus]) -> AcpClientStatus {
    if statuses.is_empty() {
        return AcpClientStatus::Configured;
    }
    if statuses
        .iter()
        .any(|status| matches!(status, AcpClientStatus::Running))
    {
        return AcpClientStatus::Running;
    }
    if statuses
        .iter()
        .any(|status| matches!(status, AcpClientStatus::Starting))
    {
        return AcpClientStatus::Starting;
    }
    if statuses
        .iter()
        .any(|status| matches!(status, AcpClientStatus::Failed))
    {
        return AcpClientStatus::Failed;
    }
    AcpClientStatus::Stopped
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

async fn terminate_child_process_tree(client_id: &str, mut child: Child) {
    let pid = child.id();

    #[cfg(unix)]
    if let Some(pid) = pid {
        let process_group = format!("-{}", pid);
        match openbitfun_core::util::process_manager::create_tokio_command("kill")
            .arg("-TERM")
            .arg(&process_group)
            .status()
            .await
        {
            Ok(status) if status.success() => {}
            Ok(status) => {
                warn!(
                    "ACP client process group terminate exited unsuccessfully: id={} pid={} status={}",
                    client_id, pid, status
                );
            }
            Err(error) => {
                warn!(
                    "Failed to terminate ACP client process group: id={} pid={} error={}",
                    client_id, pid, error
                );
            }
        }

        match tokio::time::timeout(Duration::from_millis(750), child.wait()).await {
            Ok(Ok(_)) => return,
            Ok(Err(error)) => {
                warn!(
                    "Failed to wait for ACP client process after terminate: id={} pid={} error={}",
                    client_id, pid, error
                );
            }
            Err(_) => {}
        }

        if let Err(error) = openbitfun_core::util::process_manager::create_tokio_command("kill")
            .arg("-KILL")
            .arg(&process_group)
            .status()
            .await
        {
            warn!(
                "Failed to kill ACP client process group: id={} pid={} error={}",
                client_id, pid, error
            );
        }
        let _ = child.wait().await;
        return;
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        match openbitfun_core::util::process_manager::create_tokio_command("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .status()
            .await
        {
            Ok(status) if status.success() => {
                let _ = child.wait().await;
                return;
            }
            Ok(status) => {
                warn!(
                    "ACP client process tree kill exited unsuccessfully: id={} pid={} status={}",
                    client_id, pid, status
                );
            }
            Err(error) => {
                warn!(
                    "Failed to kill ACP client process tree: id={} pid={} error={}",
                    client_id, pid, error
                );
            }
        }
    }

    if let Err(error) = child.start_kill() {
        warn!(
            "Failed to kill ACP client process: id={} error={}",
            client_id, error
        );
    }
    let _ = child.wait().await;
}

async fn close_or_cancel_remote_session(
    client: &AcpClientConnection,
    connection: Option<ConnectionTo<Agent>>,
    remote_session_id: &str,
    supports_close: bool,
) {
    let connection = match connection {
        Some(connection) => connection,
        None => match client.connection().await {
            Ok(connection) => connection,
            Err(error) => {
                warn!(
                    "Failed to release ACP session because client is disconnected: client_id={} remote_session_id={} error={}",
                    client.id, remote_session_id, error
                );
                return;
            }
        },
    };

    if supports_close {
        let close = connection
            .send_request(CloseSessionRequest::new(remote_session_id.to_string()))
            .block_task();
        match tokio::time::timeout(SESSION_CLOSE_TIMEOUT, close).await {
            Ok(Ok(_)) => {
                debug!(
                    "ACP remote session closed: client_id={} remote_session_id={}",
                    client.id, remote_session_id
                );
            }
            Ok(Err(error)) => {
                warn!(
                    "Failed to close ACP remote session: client_id={} remote_session_id={} error={}",
                    client.id, remote_session_id, error
                );
            }
            Err(_) => {
                warn!(
                    "Timed out closing ACP remote session: client_id={} remote_session_id={} timeout_ms={}",
                    client.id,
                    remote_session_id,
                    SESSION_CLOSE_TIMEOUT.as_millis()
                );
            }
        }
    } else if let Err(error) = connection
        .send_notification(CancelNotification::new(remote_session_id.to_string()))
        .map_err(protocol_error)
    {
        warn!(
            "Failed to cancel ACP remote session during release: client_id={} remote_session_id={} error={}",
            client.id, remote_session_id, error
        );
    }
}

fn new_session_response_from_load(
    remote_session_id: &str,
    response: LoadSessionResponse,
) -> NewSessionResponse {
    NewSessionResponse::new(remote_session_id.to_string())
        .modes(response.modes)
        .models(response.models)
        .config_options(response.config_options)
        .meta(response.meta)
}

fn new_session_response_from_resume(
    remote_session_id: &str,
    response: ResumeSessionResponse,
) -> NewSessionResponse {
    NewSessionResponse::new(remote_session_id.to_string())
        .modes(response.modes)
        .models(response.models)
        .config_options(response.config_options)
        .meta(response.meta)
}

async fn drain_pending_turn_updates<F>(
    session: &mut AcpRemoteSession,
    tool_call_tracker: &mut AcpToolCallTracker,
    round_tracker: &mut AcpStreamRoundTracker,
    on_event: &mut F,
) -> OpenBitFunResult<()>
where
    F: FnMut(AcpClientStreamEvent) -> OpenBitFunResult<()> + Send,
{
    let started_at = Instant::now();
    let mut drained_count = 0usize;
    while started_at.elapsed() < TURN_COMPLETION_DRAIN_MAX_DURATION {
        let update = {
            let Some(active) = session.active.as_mut() else {
                return Ok(());
            };
            tokio::time::timeout(TURN_COMPLETION_DRAIN_QUIET_WINDOW, active.read_update()).await
        };

        match update {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                let events =
                    acp_dispatch_to_stream_events_with_tracker(dispatch, tool_call_tracker).await?;
                update_session_from_events(session, &events);
                for event in events {
                    for event in round_tracker.apply(event) {
                        on_event(event)?;
                    }
                }
                drained_count += 1;
            }
            Ok(Ok(SessionMessage::StopReason(_))) => {
                drained_count += 1;
            }
            Ok(Ok(_)) => {
                drained_count += 1;
            }
            Ok(Err(error)) => return Err(protocol_error(error)),
            Err(_) => break,
        }
    }

    if drained_count > 0 {
        debug!(
            "Drained ACP turn updates after stop reason: count={}",
            drained_count
        );
    }

    Ok(())
}

async fn read_turn_to_string(
    session: &mut AcpRemoteSession,
    prompt: &mut AcpPrompt,
) -> OpenBitFunResult<String> {
    let mut output = String::new();
    let mut tool_call_tracker = AcpToolCallTracker::new();
    loop {
        let message = {
            let active = session
                .active
                .as_mut()
                .ok_or_else(|| OpenBitFunError::service("ACP session was not initialized"))?;
            prompt.read_update(active).await.map_err(protocol_error)?
        };

        match message {
            SessionMessage::SessionMessage(dispatch) => {
                let events =
                    acp_dispatch_to_stream_events_with_tracker(dispatch, &mut tool_call_tracker)
                        .await?;
                update_session_from_events(session, &events);
                append_agent_text(&mut output, events);
            }
            SessionMessage::StopReason(_) => {
                drain_pending_turn_text(session, &mut tool_call_tracker, &mut output).await?;
                break;
            }
            _ => {}
        }
    }
    Ok(output)
}

async fn drain_pending_turn_text(
    session: &mut AcpRemoteSession,
    tool_call_tracker: &mut AcpToolCallTracker,
    output: &mut String,
) -> OpenBitFunResult<()> {
    let started_at = Instant::now();
    let mut drained_count = 0usize;
    while started_at.elapsed() < TURN_COMPLETION_DRAIN_MAX_DURATION {
        let update = {
            let Some(active) = session.active.as_mut() else {
                return Ok(());
            };
            tokio::time::timeout(TURN_COMPLETION_DRAIN_QUIET_WINDOW, active.read_update()).await
        };

        match update {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                let events =
                    acp_dispatch_to_stream_events_with_tracker(dispatch, tool_call_tracker).await?;
                update_session_from_events(session, &events);
                append_agent_text(output, events);
                drained_count += 1;
            }
            Ok(Ok(SessionMessage::StopReason(_))) => {
                drained_count += 1;
            }
            Ok(Ok(_)) => {
                drained_count += 1;
            }
            Ok(Err(error)) => return Err(protocol_error(error)),
            Err(_) => break,
        }
    }

    if drained_count > 0 {
        debug!(
            "Drained ACP text updates after stop reason: count={}",
            drained_count
        );
    }

    Ok(())
}

fn append_agent_text(output: &mut String, events: Vec<AcpClientStreamEvent>) {
    for event in events {
        if let AcpClientStreamEvent::AgentText(text) = event {
            output.push_str(&text);
        }
    }
}

async fn drain_pending_session_metadata_updates(
    session: &mut AcpRemoteSession,
) -> OpenBitFunResult<()> {
    let started_at = Instant::now();
    let mut drained_count = 0usize;
    let mut tool_call_tracker = AcpToolCallTracker::new();

    while started_at.elapsed() < SESSION_METADATA_DRAIN_MAX_DURATION {
        let update = {
            let Some(active) = session.active.as_mut() else {
                return Ok(());
            };
            tokio::time::timeout(SESSION_METADATA_DRAIN_QUIET_WINDOW, active.read_update()).await
        };

        match update {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                let events =
                    acp_dispatch_to_stream_events_with_tracker(dispatch, &mut tool_call_tracker)
                        .await?;
                update_session_from_events(session, &events);
                drained_count += 1;
            }
            Ok(Ok(SessionMessage::StopReason(_))) => {
                drained_count += 1;
            }
            Ok(Ok(_)) => {
                drained_count += 1;
            }
            Ok(Err(error)) => return Err(protocol_error(error)),
            Err(_) => break,
        }
    }

    if drained_count > 0 {
        debug!(
            "Drained ACP session metadata updates: count={}",
            drained_count
        );
    }

    Ok(())
}

async fn discard_pending_session_updates_if_needed(session: &mut AcpRemoteSession) {
    if !session.discard_pending_updates_before_next_prompt {
        return;
    }

    session.discard_pending_updates_before_next_prompt = false;
    let started_at = Instant::now();
    let mut discarded_count = 0usize;
    while started_at.elapsed() < LOAD_REPLAY_DRAIN_MAX_DURATION {
        let update = {
            let Some(active) = session.active.as_mut() else {
                return;
            };
            tokio::time::timeout(LOAD_REPLAY_DRAIN_QUIET_WINDOW, active.read_update()).await
        };

        match update {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                let mut tracker = AcpToolCallTracker::new();
                if let Ok(events) =
                    acp_dispatch_to_stream_events_with_tracker(dispatch, &mut tracker).await
                {
                    update_session_from_events(session, &events);
                }
                discarded_count += 1;
            }
            Ok(Ok(SessionMessage::StopReason(_))) => {
                discarded_count += 1;
            }
            Ok(Ok(_)) => {
                discarded_count += 1;
            }
            Ok(Err(error)) => {
                warn!(
                    "Failed to discard ACP load replay update before prompt: error={}",
                    error
                );
                break;
            }
            Err(_) => break,
        }
    }

    if discarded_count > 0 {
        info!(
            "Discarded ACP load replay updates before prompt: count={}",
            discarded_count
        );
    }
}

fn update_session_from_events(session: &mut AcpRemoteSession, events: &[AcpClientStreamEvent]) {
    update_session_context_usage(session, events);
    update_session_available_commands(session, events);
    update_session_config_options(session, events);
}

fn update_session_context_usage(session: &mut AcpRemoteSession, events: &[AcpClientStreamEvent]) {
    let Some(usage) = events.iter().rev().find_map(|event| match event {
        AcpClientStreamEvent::ContextUsageUpdated(usage) => Some(usage.clone()),
        _ => None,
    }) else {
        return;
    };

    session.context_usage = Some(usage);
}

fn update_session_available_commands(
    session: &mut AcpRemoteSession,
    events: &[AcpClientStreamEvent],
) {
    let Some(commands) = events.iter().rev().find_map(|event| match event {
        AcpClientStreamEvent::AvailableCommandsUpdated(commands) => Some(commands.clone()),
        _ => None,
    }) else {
        return;
    };

    session.available_commands = commands;
}

fn update_session_config_options(session: &mut AcpRemoteSession, events: &[AcpClientStreamEvent]) {
    let Some(options) = events.iter().rev().find_map(|event| match event {
        AcpClientStreamEvent::ConfigOptionsUpdated(options) => Some(options.clone()),
        _ => None,
    }) else {
        return;
    };

    session.config_options = options;
}

fn protocol_error(error: impl std::fmt::Display) -> OpenBitFunError {
    OpenBitFunError::service(format!("ACP protocol error: {}", error))
}

/// The last lines an agent wrote to stderr, kept so a startup failure can say
/// why it failed rather than only that it did.
///
/// An agent that dies before answering `initialize` leaves nothing behind but a
/// closed pipe. Its stderr is the whole account of what went wrong — a missing
/// runtime, a Node too old for it, a config it refused — and a log file is not
/// where the user is looking when the dialog says the session did not start.
#[derive(Clone)]
struct StderrTail {
    lines: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    /// Turns true once the reader reaches EOF.
    drained: tokio::sync::watch::Receiver<bool>,
}

impl Default for StderrTail {
    fn default() -> Self {
        // Nothing will ever be written to this one, so it starts drained: the
        // wait below sees a value that already satisfies it and returns at once.
        let (_sender, drained) = tokio::sync::watch::channel(true);
        Self {
            lines: Arc::default(),
            drained,
        }
    }
}

/// How many lines to keep, and how many of those to put in an error message.
/// A stack trace is worth keeping whole in the log and worth quoting only in
/// part in a dialog.
const STDERR_TAIL_LINES: usize = 20;
const STDERR_DETAIL_LINES: usize = 8;
/// How long to let stderr finish arriving after the agent's pipes close.
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(500);

impl StderrTail {
    fn record(&self, line: &str) {
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        if lines.len() == STDERR_TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line.to_string());
    }

    /// Wait for the reader to reach EOF, then quote the tail.
    ///
    /// The pipe closing is what tells the connect task the agent is gone, and
    /// the last lines it wrote can still be in flight when that happens — a
    /// stack trace quoted without its final line is the one line that mattered.
    async fn drained_detail(&self) -> String {
        let mut drained = self.drained.clone();
        let _ =
            tokio::time::timeout(STDERR_DRAIN_GRACE, drained.wait_for(|drained| *drained)).await;
        self.detail()
    }

    fn detail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };
        let start = lines.len().saturating_sub(STDERR_DETAIL_LINES);
        lines
            .iter()
            .skip(start)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Drain an agent's stderr into the log, keeping the tail for the error message.
fn spawn_stderr_reader<R>(client_id: &str, stderr: R) -> StderrTail
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let (drained_tx, drained_rx) = tokio::sync::watch::channel(false);
    let tail = StderrTail {
        lines: Arc::default(),
        drained: drained_rx,
    };
    let client_id = client_id.to_string();
    let sink = tail.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;

        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end();
            if line.trim().is_empty() {
                continue;
            }
            warn!("ACP client stderr: id={client_id} {line}");
            sink.record(line);
        }
        let _ = drained_tx.send(true);
    });
    tail
}

fn startup_exit_error_message(client_id: &str, stderr_detail: &str) -> String {
    let base = format!("ACP client '{client_id}' exited before initialization completed");
    if stderr_detail.trim().is_empty() {
        return base;
    }
    format!("{base}. It said:\n{stderr_detail}")
}

const STARTUP_TIMEOUT_ERROR_PREFIX: &str = "ACP startup timed out:";

fn startup_timeout_error(client_id: &str, phase: &str) -> OpenBitFunError {
    OpenBitFunError::service(startup_timeout_error_message(client_id, phase))
}

fn startup_timeout_error_message(client_id: &str, phase: &str) -> String {
    format!(
        "{} client '{}' exceeded {}s during {} and was terminated. Please try again after the client is ready.",
        STARTUP_TIMEOUT_ERROR_PREFIX,
        client_id,
        CLIENT_STARTUP_TIMEOUT_SECS,
        phase
    )
}

fn is_startup_timeout_error(error: &OpenBitFunError) -> bool {
    error.to_string().contains(STARTUP_TIMEOUT_ERROR_PREFIX)
}

fn select_permission_by_kind(
    request: &RequestPermissionRequest,
    preferred: PermissionOptionKind,
    approve: bool,
) -> RequestPermissionResponse {
    let fallback_kind = if approve {
        PermissionOptionKind::AllowAlways
    } else {
        PermissionOptionKind::RejectAlways
    };
    let option_id = request
        .options
        .iter()
        .find(|option| option.kind == preferred)
        .or_else(|| {
            request
                .options
                .iter()
                .find(|option| option.kind == fallback_kind)
        })
        .map(|option| option.option_id.to_string())
        .unwrap_or_else(|| select_permission_option_id(&request.options, approve));
    RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
        SelectedPermissionOutcome::new(option_id),
    ))
}

fn select_permission_option_id(options: &[PermissionOption], approve: bool) -> String {
    let preferred_kinds = if approve {
        [
            PermissionOptionKind::AllowOnce,
            PermissionOptionKind::AllowAlways,
        ]
    } else {
        [
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ]
    };

    options
        .iter()
        .find(|option| preferred_kinds.contains(&option.kind))
        .or_else(|| options.first())
        .map(|option| option.option_id.to_string())
        .unwrap_or_else(|| {
            if approve {
                "allow_once".to_string()
            } else {
                "reject_once".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client_connection(id: &str) -> Arc<AcpClientConnection> {
        Arc::new(AcpClientConnection::new(
            id.to_string(),
            "opencode".to_string(),
            AcpClientConfig {
                name: Some("OpenCode".to_string()),
                command: "opencode".to_string(),
                args: Vec::new(),
                env: HashMap::new(),
                enabled: true,
                readonly: false,
                subagent: Default::default(),
                permission_mode: AcpClientPermissionMode::Ask,
            },
        ))
    }

    #[test]
    fn claims_only_one_client_start_for_a_connection() {
        let clients = DashMap::new();
        let first = test_client_connection("opencode::session::s1");
        let second = test_client_connection("opencode::session::s1");

        let ClientStartClaim::Owned(owned) =
            claim_client_start(&clients, "opencode::session::s1", first.clone())
        else {
            panic!("first claimant should own startup");
        };
        let ClientStartClaim::Existing(existing) =
            claim_client_start(&clients, "opencode::session::s1", second)
        else {
            panic!("second claimant should reuse startup");
        };

        assert!(Arc::ptr_eq(&owned, &first));
        assert!(Arc::ptr_eq(&existing, &first));
        assert_eq!(clients.len(), 1);
    }

    #[test]
    fn selects_actual_permission_option_id_for_approval() {
        let options = vec![
            PermissionOption::new("deny", "Deny", PermissionOptionKind::RejectOnce),
            PermissionOption::new("yes-once", "Allow", PermissionOptionKind::AllowOnce),
        ];

        assert_eq!(select_permission_option_id(&options, true), "yes-once");
    }

    #[test]
    fn selects_actual_permission_option_id_for_rejection() {
        let options = vec![
            PermissionOption::new("allow-always", "Allow", PermissionOptionKind::AllowAlways),
            PermissionOption::new("no-once", "Reject", PermissionOptionKind::RejectOnce),
        ];

        assert_eq!(select_permission_option_id(&options, false), "no-once");
    }

    #[test]
    fn formats_startup_timeout_error_message() {
        assert_eq!(
            startup_timeout_error_message("codex", "initialize"),
            "ACP startup timed out: client 'codex' exceeded 60s during initialize and was terminated. Please try again after the client is ready."
        );
    }

    #[test]
    fn a_startup_failure_quotes_what_the_agent_said() {
        // Verbatim from a remote host whose Node was too old for the harness.
        // Without these lines the message is "it exited", which is the one
        // thing the user already knows.
        let said = "SyntaxError: The requested module 'node:util' does not provide an export named 'parseEnv'\nNode.js v18.19.1";
        assert_eq!(
            startup_exit_error_message("dsh", said),
            format!("ACP client 'dsh' exited before initialization completed. It said:\n{said}")
        );

        // An agent that died silently gets the plain sentence, not a dangling
        // colon over an empty quote.
        assert_eq!(
            startup_exit_error_message("dsh", "   "),
            "ACP client 'dsh' exited before initialization completed"
        );
    }

    #[tokio::test]
    async fn the_stderr_tail_keeps_the_last_lines_and_waits_for_eof() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let tail = spawn_stderr_reader("dsh", reader);

        let mut written = String::new();
        for line in 0..STDERR_TAIL_LINES + 4 {
            written.push_str(&format!("line {line}\n"));
        }
        tokio::io::AsyncWriteExt::write_all(&mut writer, written.as_bytes())
            .await
            .unwrap();
        drop(writer);

        // The wait is what makes this deterministic: the reader is still
        // draining when a dead agent's pipes close.
        let detail = tail.drained_detail().await;
        let lines = detail.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), STDERR_DETAIL_LINES);
        assert_eq!(
            lines.last().copied(),
            Some(format!("line {}", STDERR_TAIL_LINES + 3).as_str())
        );
    }

    #[test]
    fn maps_session_config_values_to_acp_protocol_values() {
        let select = AcpSessionConfigValue::Select {
            value: "on".to_string(),
        }
        .into_protocol_value();
        assert_eq!(
            select.as_value_id().map(ToString::to_string).as_deref(),
            Some("on")
        );

        let boolean = AcpSessionConfigValue::Boolean { value: true }.into_protocol_value();
        assert_eq!(boolean.as_bool(), Some(true));
    }

    #[test]
    fn renders_remote_client_command_from_config() {
        let config = AcpClientConfig {
            name: Some("Custom".to_string()),
            command: "custom-acp".to_string(),
            args: vec!["--stdio".to_string(), "with space".to_string()],
            env: HashMap::from([
                ("PATH".to_string(), "/remote/bin:/usr/bin".to_string()),
                ("INVALID-NAME".to_string(), "ignored".to_string()),
            ]),
            enabled: true,
            readonly: false,
            subagent: Default::default(),
            permission_mode: AcpClientPermissionMode::Ask,
        };

        let command = render_remote_client_command(&config, Some("/srv/my repo")).expect("command");
        assert!(command.starts_with("bash -lc "));
        assert!(command.contains(".nvm/nvm.sh"));
        assert!(command.contains(
            "cd '\\''/srv/my repo'\\'' && exec env PATH=/remote/bin:/usr/bin custom-acp --stdio '\\''with space'\\''"
        ));
    }

    #[test]
    fn resolves_remote_client_config_from_global_config() {
        let config_file = AcpClientConfigFile {
            acp_clients: HashMap::from([(
                "codex".to_string(),
                AcpClientConfig {
                    name: Some("Codex".to_string()),
                    command: "npx".to_string(),
                    args: vec![
                        "--yes".to_string(),
                        "@agentclientprotocol/codex-acp@latest".to_string(),
                    ],
                    env: HashMap::from([("BASE".to_string(), "1".to_string())]),
                    enabled: true,
                    readonly: false,
                    subagent: Default::default(),
                    permission_mode: AcpClientPermissionMode::Ask,
                },
            )]),
        };

        let resolved = resolve_config_for_client(&config_file, "codex", Some("huawei-server"))
            .expect("config");

        assert_eq!(resolved.command, "npx");
        assert_eq!(
            resolved.args,
            vec!["--yes", "@agentclientprotocol/codex-acp@latest"]
        );
        assert_eq!(resolved.env.get("BASE").map(String::as_str), Some("1"));
        assert!(resolved.enabled);
    }

    #[test]
    fn resolves_builtin_dsh_config_for_remote_workspace() {
        let resolved =
            resolve_config_for_client(&AcpClientConfigFile::default(), "dsh", Some("remote-host"))
                .expect("built-in DSH config");

        assert_eq!(resolved.command, "dsh");
        // A remote workspace resolves the same launch as a local one, and both
        // transports materialize the profile first, so the command finds it
        // there either way.
        assert_eq!(resolved.args, vec!["--profile", "openbitfun-acp"]);
        assert!(resolved.enabled);
    }
}
