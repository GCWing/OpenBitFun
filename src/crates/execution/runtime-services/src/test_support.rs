use std::sync::Arc;

use openbitfun_runtime_ports::{
    ClockPort, FileSystemPort, GitPort, McpCatalogPort, NetworkPort, PortError, PortErrorKind,
    PortResult, RemoteAssistantWorkspaceFacts, RemoteCapabilityPort, RemoteConnectionPort,
    RemoteExecCommandRequest, RemoteExecCommandResponse, RemoteExecControlRequest,
    RemoteExecOneShotCommandRequest, RemoteExecOneShotCommandResponse, RemoteExecPort,
    RemoteExecStreamingOutputSink, RemoteProjectionPort, RemoteRecentWorkspaceFacts,
    RemoteSendStdinRequest, RemoteWorkspaceFacts, RemoteWorkspaceFileRuntimeHost,
    RemoteWorkspaceKind, RemoteWorkspacePort, RemoteWorkspaceRuntimeHost, RemoteWorkspaceUpdate,
    RemoteWriteStdinRequest, RuntimeEventEnvelope, RuntimeEventSink, RuntimeServiceCapability,
    RuntimeServicePort, SessionStorageKind, SessionStoragePathRequest,
    SessionStoragePathResolution, SessionStorePort, TerminalExecCommandRequest,
    TerminalExecCommandResponse, TerminalExecControlRequest, TerminalExecStreamingOutputSink,
    TerminalPort, TerminalSendStdinRequest, TerminalWriteStdinRequest, WorkspacePort,
};

use crate::{
    RuntimeServices, RuntimeServicesBuilder, RuntimeServicesError, RuntimeServicesProvider,
};

#[derive(Debug)]
pub struct FakeRuntimePort {
    capability: RuntimeServiceCapability,
}

impl FakeRuntimePort {
    pub fn new(capability: RuntimeServiceCapability) -> Self {
        Self { capability }
    }
}

impl RuntimeServicePort for FakeRuntimePort {
    fn capability(&self) -> RuntimeServiceCapability {
        self.capability
    }
}

impl FileSystemPort for FakeRuntimePort {}
impl WorkspacePort for FakeRuntimePort {}
#[async_trait::async_trait]
impl SessionStorePort for FakeRuntimePort {
    async fn resolve_session_storage_path(
        &self,
        request: SessionStoragePathRequest,
    ) -> PortResult<SessionStoragePathResolution> {
        Ok(SessionStoragePathResolution::new(
            request.workspace_path.clone(),
            request.workspace_path,
            SessionStorageKind::Local,
            request.remote_connection_id,
            request.remote_ssh_host,
        ))
    }
}
#[async_trait::async_trait]
impl TerminalPort for FakeRuntimePort {
    async fn exec_command(
        &self,
        _request: TerminalExecCommandRequest,
    ) -> PortResult<TerminalExecCommandResponse> {
        fake_terminal_not_available()
    }

    async fn exec_command_streaming(
        &self,
        _request: TerminalExecCommandRequest,
        _output_sink: TerminalExecStreamingOutputSink,
    ) -> PortResult<TerminalExecCommandResponse> {
        fake_terminal_not_available()
    }

    async fn write_stdin(
        &self,
        _request: TerminalWriteStdinRequest,
    ) -> PortResult<TerminalExecCommandResponse> {
        fake_terminal_not_available()
    }

    async fn write_stdin_streaming(
        &self,
        _request: TerminalWriteStdinRequest,
        _output_sink: TerminalExecStreamingOutputSink,
    ) -> PortResult<TerminalExecCommandResponse> {
        fake_terminal_not_available()
    }

    async fn send_stdin(&self, _request: TerminalSendStdinRequest) -> PortResult<()> {
        Err(fake_terminal_error())
    }

    async fn control_session(
        &self,
        _request: TerminalExecControlRequest,
    ) -> PortResult<TerminalExecCommandResponse> {
        fake_terminal_not_available()
    }
}

fn fake_terminal_not_available<T>() -> PortResult<T> {
    Err(fake_terminal_error())
}

fn fake_terminal_error() -> PortError {
    PortError::new(
        PortErrorKind::NotAvailable,
        "fake terminal port does not implement terminal execution",
    )
}
impl NetworkPort for FakeRuntimePort {}
impl GitPort for FakeRuntimePort {}
impl McpCatalogPort for FakeRuntimePort {}
impl RemoteConnectionPort for FakeRuntimePort {}
impl RemoteCapabilityPort for FakeRuntimePort {}

#[async_trait::async_trait]
impl RemoteExecPort for FakeRuntimePort {
    async fn exec_command_once(
        &self,
        _request: RemoteExecOneShotCommandRequest,
    ) -> PortResult<RemoteExecOneShotCommandResponse> {
        fake_remote_exec_not_available()
    }

    async fn exec_command(
        &self,
        _request: RemoteExecCommandRequest,
    ) -> PortResult<RemoteExecCommandResponse> {
        fake_remote_exec_not_available()
    }

    async fn exec_command_streaming(
        &self,
        _request: RemoteExecCommandRequest,
        _output_sink: RemoteExecStreamingOutputSink,
    ) -> PortResult<RemoteExecCommandResponse> {
        fake_remote_exec_not_available()
    }

    async fn write_stdin(
        &self,
        _request: RemoteWriteStdinRequest,
    ) -> PortResult<RemoteExecCommandResponse> {
        fake_remote_exec_not_available()
    }

    async fn write_stdin_streaming(
        &self,
        _request: RemoteWriteStdinRequest,
        _output_sink: RemoteExecStreamingOutputSink,
    ) -> PortResult<RemoteExecCommandResponse> {
        fake_remote_exec_not_available()
    }

    async fn send_stdin(&self, _request: RemoteSendStdinRequest) -> PortResult<()> {
        Err(fake_remote_exec_error())
    }

    async fn control_session(
        &self,
        _request: RemoteExecControlRequest,
    ) -> PortResult<RemoteExecCommandResponse> {
        fake_remote_exec_not_available()
    }
}

fn fake_remote_exec_not_available<T>() -> PortResult<T> {
    Err(fake_remote_exec_error())
}

fn fake_remote_exec_error() -> PortError {
    PortError::new(
        PortErrorKind::NotAvailable,
        "fake remote exec port does not implement remote execution",
    )
}

#[async_trait::async_trait]
impl RemoteWorkspaceRuntimeHost for FakeRuntimePort {
    async fn current_workspace(&self) -> Option<RemoteWorkspaceFacts> {
        Some(RemoteWorkspaceFacts {
            workspace_id: "test-workspace".to_string(),
            path: "/remote/project".to_string(),
            name: "project".to_string(),
            git_branch: Some("main".to_string()),
            kind: RemoteWorkspaceKind::Remote,
            assistant_id: None,
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        })
    }

    async fn recent_workspaces(&self) -> Vec<RemoteRecentWorkspaceFacts> {
        Vec::new()
    }

    async fn open_workspace(
        &self,
        path: &str,
        _remote_connection_id: Option<&str>,
        _remote_ssh_host: Option<&str>,
    ) -> Result<RemoteWorkspaceUpdate, String> {
        Ok(RemoteWorkspaceUpdate {
            workspace_id: "test-workspace".to_string(),
            path: path.to_string(),
            name: "project".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
    }

    async fn assistant_workspaces(&self) -> Vec<RemoteAssistantWorkspaceFacts> {
        Vec::new()
    }

    async fn open_assistant_workspace(&self, path: &str) -> Result<RemoteWorkspaceUpdate, String> {
        Ok(RemoteWorkspaceUpdate {
            workspace_id: "test-workspace".to_string(),
            path: path.to_string(),
            name: "assistant".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
    }
}

#[async_trait::async_trait]
impl RemoteWorkspaceFileRuntimeHost for FakeRuntimePort {
    async fn resolve_remote_file_workspace_root(
        &self,
        _session_id: Option<&str>,
    ) -> Option<std::path::PathBuf> {
        Some(std::path::PathBuf::from("/remote/project"))
    }
}

impl ClockPort for FakeRuntimePort {
    fn now_unix_millis(&self) -> i64 {
        0
    }
}

#[derive(Debug, Default)]
pub struct FakeRuntimeEventSink;

#[async_trait::async_trait]
impl RuntimeEventSink for FakeRuntimeEventSink {
    async fn publish_runtime_event(&self, _event: RuntimeEventEnvelope) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct FakeRuntimeServicesProvider {
    include_remote: bool,
}

impl FakeRuntimeServicesProvider {
    pub fn with_all_required() -> Self {
        Self {
            include_remote: false,
        }
    }

    pub fn terminal_port() -> Arc<dyn TerminalPort> {
        Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::Terminal))
    }

    pub fn remote_exec_port() -> Arc<dyn RemoteExecPort> {
        Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::RemoteExec))
    }

    pub fn with_all_remote(mut self) -> Self {
        self.include_remote = true;
        self
    }

    pub fn build_services(self) -> Result<RuntimeServices, RuntimeServicesError> {
        self.register(RuntimeServicesBuilder::new()).build()
    }
}

impl RuntimeServicesProvider for FakeRuntimeServicesProvider {
    fn register(&self, builder: RuntimeServicesBuilder) -> RuntimeServicesBuilder {
        let filesystem: Arc<dyn FileSystemPort> =
            Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::FileSystem));
        let workspace: Arc<dyn WorkspacePort> =
            Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::Workspace));
        let session_store: Arc<dyn SessionStorePort> =
            Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::SessionStore));
        let events: Arc<dyn RuntimeEventSink> = Arc::new(FakeRuntimeEventSink);
        let clock: Arc<dyn ClockPort> =
            Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::Clock));

        let builder = builder
            .with_filesystem(filesystem)
            .with_workspace(workspace)
            .with_session_store(session_store)
            .with_events(events)
            .with_clock(clock);

        if !self.include_remote {
            return builder;
        }

        let remote_connection: Arc<dyn RemoteConnectionPort> = Arc::new(FakeRuntimePort::new(
            RuntimeServiceCapability::RemoteConnection,
        ));
        let remote_exec: Arc<dyn RemoteExecPort> =
            Arc::new(FakeRuntimePort::new(RuntimeServiceCapability::RemoteExec));
        let remote_workspace: Arc<dyn RemoteWorkspacePort> = Arc::new(FakeRuntimePort::new(
            RuntimeServiceCapability::RemoteWorkspace,
        ));
        let remote_projection: Arc<dyn RemoteProjectionPort> = Arc::new(FakeRuntimePort::new(
            RuntimeServiceCapability::RemoteProjection,
        ));
        let remote_capabilities: Arc<dyn RemoteCapabilityPort> = Arc::new(FakeRuntimePort::new(
            RuntimeServiceCapability::RemoteCapabilities,
        ));

        builder
            .with_optional_remote_connection(Some(remote_connection))
            .with_optional_remote_exec(Some(remote_exec))
            .with_optional_remote_workspace(Some(remote_workspace))
            .with_optional_remote_projection(Some(remote_projection))
            .with_optional_remote_capabilities(Some(remote_capabilities))
    }
}
