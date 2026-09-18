use crate::service::config::{get_global_config_service, types::WorkspaceConfig, ConfigService};
use crate::service::remote_ssh::workspace_state::{
    get_remote_workspace_manager, RemoteWorkspaceEntry,
};
use crate::service::remote_ssh::{RemoteFileService, SSHConnectionManager};
use crate::service::search::{
    ContentSearchRequest, ContentSearchResult, GlobSearchRequest, GlobSearchResult,
    IndexTaskHandle, WorkspaceIndexStatus,
};
use async_trait::async_trait;
use openbitfun_services_integrations::remote_ssh::workspace_search::{
    RemoteCommandOutput, RemoteWorkspaceSearchProvider,
    RemoteWorkspaceSearchService as ServiceRemoteWorkspaceSearchService,
    RemoteWorkspaceSearchStdioProtocol,
};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const REMOTE_FLASHGREP_LOG_TARGET: &str = "flashgrep";

#[derive(Clone)]
pub struct RemoteWorkspaceSearchService {
    inner: ServiceRemoteWorkspaceSearchService,
}

impl RemoteWorkspaceSearchService {
    fn new(
        workspace: RemoteWorkspaceEntry,
        ssh_manager: SSHConnectionManager,
        remote_file_service: RemoteFileService,
        config_service: Arc<ConfigService>,
    ) -> Self {
        let provider = Arc::new(CoreRemoteWorkspaceSearchProvider {
            workspace,
            ssh_manager,
            remote_file_service,
            config_service,
        });
        Self {
            inner: ServiceRemoteWorkspaceSearchService::new(provider),
        }
    }

    pub fn with_preferred_connection_id(mut self, preferred_connection_id: Option<String>) -> Self {
        self.inner = self
            .inner
            .with_preferred_connection_id(preferred_connection_id);
        self
    }

    pub async fn get_index_status(&self, root_path: &str) -> Result<WorkspaceIndexStatus, String> {
        self.inner.get_index_status(root_path).await
    }

    pub async fn build_index(&self, root_path: &str) -> Result<IndexTaskHandle, String> {
        self.inner.build_index(root_path).await
    }

    pub async fn rebuild_index(&self, root_path: &str) -> Result<IndexTaskHandle, String> {
        self.inner.rebuild_index(root_path).await
    }

    pub async fn search_content(
        &self,
        request: ContentSearchRequest,
    ) -> Result<ContentSearchResult, String> {
        self.inner.search_content(request).await
    }

    pub async fn glob(&self, request: GlobSearchRequest) -> Result<GlobSearchResult, String> {
        self.inner.glob(request).await
    }

    pub async fn resolve_remote_workspace_entry(
        &self,
        root_path: &str,
    ) -> Result<RemoteWorkspaceEntry, String> {
        self.inner.resolve_remote_workspace_entry(root_path).await
    }
}

#[derive(Clone)]
struct CoreRemoteWorkspaceSearchProvider {
    workspace: RemoteWorkspaceEntry,
    ssh_manager: SSHConnectionManager,
    remote_file_service: RemoteFileService,
    config_service: Arc<ConfigService>,
}

async fn resolve_search_workspace(workspace_id: &str) -> Result<RemoteWorkspaceEntry, String> {
    let service = crate::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    let record = service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    let connection_id = record
        .filesystem_connection_id()?
        .ok_or("Remote search requires a remote workspace")?
        .to_owned();
    let ssh_host = record
        .metadata
        .get("sshHost")
        .and_then(|value| value.as_str())
        .filter(|host| !host.is_empty())
        .ok_or("Remote workspace is missing SSH host metadata")?
        .to_owned();
    Ok(RemoteWorkspaceEntry {
        connection_id,
        ssh_host,
        connection_name: record.name,
        remote_root: crate::service::remote_ssh::normalize_remote_workspace_path(
            &record.root_path.to_string_lossy(),
        ),
    })
}

fn validate_search_io_scope(
    workspace: &RemoteWorkspaceEntry,
    root_path: &str,
    requested_connection: Option<&str>,
) -> Result<RemoteWorkspaceEntry, String> {
    if requested_connection.is_some_and(|connection| connection != workspace.connection_id)
        || crate::service::remote_ssh::normalize_remote_workspace_path(root_path)
            != workspace.remote_root
    {
        return Err("Remote search IO scope differs from the workspace selected by ID".into());
    }
    Ok(workspace.clone())
}

#[async_trait]
impl RemoteWorkspaceSearchProvider for CoreRemoteWorkspaceSearchProvider {
    async fn resolve_workspace_entry(
        &self,
        root_path: &str,
        preferred_connection_id: Option<&str>,
    ) -> Result<RemoteWorkspaceEntry, String> {
        validate_search_io_scope(&self.workspace, root_path, preferred_connection_id)
    }

    async fn cached_server_os_type(&self, connection_id: &str) -> Option<String> {
        self.ssh_manager
            .get_server_info(connection_id)
            .await
            .map(|info| info.os_type)
    }

    async fn execute_command(
        &self,
        connection_id: &str,
        command: &str,
    ) -> Result<RemoteCommandOutput, String> {
        self.ssh_manager
            .execute_command(connection_id, command)
            .await
            .map(|(stdout, stderr, exit_code)| RemoteCommandOutput {
                stdout,
                stderr,
                exit_code,
            })
            .map_err(|error| error.to_string())
    }

    async fn create_dir_all(&self, connection_id: &str, path: &str) -> Result<(), String> {
        self.remote_file_service
            .create_dir_all(connection_id, path)
            .await
            .map_err(|error| error.to_string())
    }

    async fn write_file(
        &self,
        connection_id: &str,
        path: &str,
        contents: &[u8],
    ) -> Result<(), String> {
        self.remote_file_service
            .write_file(connection_id, path, contents)
            .await
            .map_err(|error| error.to_string())
    }

    async fn repo_max_file_size(&self) -> u64 {
        match self
            .config_service
            .get_config::<WorkspaceConfig>(Some("workspace"))
            .await
        {
            Ok(workspace_config) => workspace_config.max_file_size,
            Err(error) => {
                log::warn!(
                    target: REMOTE_FLASHGREP_LOG_TARGET,
                    "Failed to read workspace config for remote flashgrep repo open, using default max_file_size: {}",
                    error
                );
                WorkspaceConfig::default().max_file_size
            }
        }
    }

    async fn spawn_stdio_daemon(
        &self,
        connection_id: &str,
        command: &str,
        write_rx: mpsc::Receiver<Vec<u8>>,
        protocol: RemoteWorkspaceSearchStdioProtocol,
    ) -> Result<(), String> {
        let transport = self
            .ssh_manager
            .open_workspace_stdio(connection_id, command)
            .await
            .map_err(|error| format!("Failed to start remote flashgrep stdio daemon: {error}"))?;
        spawn_remote_stdio_owner(connection_id.to_string(), transport, write_rx, protocol);
        Ok(())
    }
}

pub async fn remote_workspace_search_service_for_workspace(
    workspace_id: &str,
) -> Result<RemoteWorkspaceSearchService, String> {
    let workspace = resolve_search_workspace(workspace_id).await?;
    let connection_id = workspace.connection_id.clone();
    let manager = get_remote_workspace_manager()
        .ok_or_else(|| "Remote workspace manager is unavailable".to_string())?;

    Ok(RemoteWorkspaceSearchService::new(
        workspace,
        manager
            .get_ssh_manager()
            .await
            .ok_or_else(|| "SSH manager unavailable".to_string())?,
        manager
            .get_file_service()
            .await
            .ok_or_else(|| "Remote file service unavailable".to_string())?,
        get_global_config_service()
            .await
            .map_err(|error| format!("Config service unavailable: {error}"))?,
    )
    .with_preferred_connection_id(Some(connection_id)))
}

fn spawn_remote_stdio_owner(
    connection_id: String,
    transport: openbitfun_services_integrations::remote_ssh::WorkspaceStdio,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
    protocol: RemoteWorkspaceSearchStdioProtocol,
) {
    tokio::spawn(async move {
        let (mut writer, mut stdout, mut stderr, _control, _completion) = transport.into_parts();
        let mut read_buffer = Vec::<u8>::new();
        let stderr_protocol = protocol.clone();
        let stderr_connection_id = connection_id.clone();
        let stderr_task = tokio::spawn(async move {
            let mut buffer = vec![0u8; 16 * 1024];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let text = String::from_utf8_lossy(&buffer[..read]);
                        let log_context = format!("connection_id={stderr_connection_id}");
                        for line in text.lines() {
                            stderr_protocol.log_stderr_line_with_context(Some(&log_context), line);
                        }
                    }
                }
            }
        });
        let mut stdout_chunk = vec![0u8; 16 * 1024];

        loop {
            tokio::select! {
                outbound = write_rx.recv() => {
                    let Some(outbound) = outbound else {
                        let _ = writer.shutdown().await;
                        break;
                    };
                    if let Err(error) = writer.write_all(&outbound).await {
                        log::warn!(
                            target: REMOTE_FLASHGREP_LOG_TARGET,
                            "Failed to write remote flashgrep stdio request: connection_id={}, error={}",
                            connection_id,
                            error
                        );
                        protocol
                            .close_with_message("remote flashgrep stdio daemon write failed")
                            .await;
                        break;
                    }
                    if let Err(error) = writer.flush().await {
                        log::warn!(
                            target: REMOTE_FLASHGREP_LOG_TARGET,
                            "Failed to flush remote flashgrep stdio request: connection_id={}, error={}",
                            connection_id,
                            error
                        );
                        protocol
                            .close_with_message("remote flashgrep stdio daemon flush failed")
                            .await;
                        break;
                    }
                }

                read = stdout.read(&mut stdout_chunk) => {
                    match read {
                        Ok(0) => break,
                        Ok(read) => {
                            if let Err(error) = protocol.handle_stdout_chunk(&mut read_buffer, &stdout_chunk[..read]).await {
                                log::warn!(
                                    target: REMOTE_FLASHGREP_LOG_TARGET,
                                    "Failed to decode remote flashgrep stdio message: connection_id={}, error={}",
                                    connection_id,
                                    error
                                );
                                protocol
                                    .close_with_message(format!(
                                        "remote flashgrep stdio daemon decode failed: {error}"
                                    ))
                                    .await;
                                break;
                            }
                        }
                        Err(error) => {
                            log::warn!(
                                target: REMOTE_FLASHGREP_LOG_TARGET,
                                "Failed to read remote flashgrep stdio response: connection_id={}, error={}",
                                connection_id,
                                error
                            );
                            break;
                        }
                    }
                }
            }
        }

        stderr_task.abort();
        protocol
            .close_with_message("remote flashgrep stdio daemon closed before sending a response")
            .await;
    });
}

#[cfg(test)]
mod identity_tests {
    #[tokio::test]
    async fn search_selects_id_without_a_path_registry_or_active_connection() {
        let root = format!("/search-id-test/{}", uuid::Uuid::new_v4());
        let first = crate::service::workspace::legacy_compat::register_remote_fixture(
            &root,
            "search-a",
            "search.example",
        )
        .await;
        let second = crate::service::workspace::legacy_compat::register_remote_fixture_with_id(
            &root,
            "search-b",
            "search.example",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .await;
        let entry = super::resolve_search_workspace(&first.id).await.unwrap();
        let other = super::resolve_search_workspace(&second.id).await.unwrap();
        assert_eq!(entry.connection_id, "search-a");
        assert_eq!(other.connection_id, "search-b");
        assert!(super::resolve_search_workspace(&root).await.is_err());
        assert!(super::validate_search_io_scope(&entry, &root, Some("search-b")).is_err());
        assert!(super::validate_search_io_scope(&entry, "/different/project", None).is_err());
        assert_eq!(
            super::validate_search_io_scope(&entry, &root, None)
                .unwrap()
                .connection_id,
            "search-a"
        );
        let local = tempfile::tempdir().unwrap();
        let local =
            crate::service::workspace::legacy_compat::register_local_fixture(local.path(), None)
                .await;
        assert!(super::resolve_search_workspace(&local.id).await.is_err());
    }
}
