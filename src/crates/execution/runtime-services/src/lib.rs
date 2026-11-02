//! Typed Runtime Services assembly.

use std::sync::Arc;

use openbitfun_runtime_ports::{
    ClockPort, FileSystemPort, GitPort, McpCatalogPort, NetworkPort, RemoteCapabilityPort,
    RemoteConnectionPort, RemoteExecPort, RemoteProjectionPort, RemoteWorkspacePort,
    RuntimeEventSink, RuntimeServiceCapability, RuntimeServicePort, SessionStorePort, TerminalPort,
    WorkspacePort,
};

pub mod backend_events;
#[cfg(test)]
mod runtime_services_contracts;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeServicesError {
    #[error("required runtime service {capability} is not registered")]
    MissingRequired {
        capability: RuntimeServiceCapability,
    },
    #[error("runtime service {capability} is not registered")]
    Unsupported {
        capability: RuntimeServiceCapability,
    },
    #[error("runtime service registered under {expected} reported {actual}")]
    CapabilityMismatch {
        expected: RuntimeServiceCapability,
        actual: RuntimeServiceCapability,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityAvailability {
    pub capability: RuntimeServiceCapability,
    pub available: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeServiceMarkerPort {
    capability: RuntimeServiceCapability,
}

impl RuntimeServiceMarkerPort {
    const fn new(capability: RuntimeServiceCapability) -> Self {
        Self { capability }
    }

    pub fn network_port() -> Arc<dyn NetworkPort> {
        Arc::new(Self::new(RuntimeServiceCapability::Network))
    }

    pub fn git_port() -> Arc<dyn GitPort> {
        Arc::new(Self::new(RuntimeServiceCapability::Git))
    }

    pub fn mcp_catalog_port() -> Arc<dyn McpCatalogPort> {
        Arc::new(Self::new(RuntimeServiceCapability::McpCatalog))
    }
}

impl RuntimeServicePort for RuntimeServiceMarkerPort {
    fn capability(&self) -> RuntimeServiceCapability {
        self.capability
    }
}

impl NetworkPort for RuntimeServiceMarkerPort {}
impl GitPort for RuntimeServiceMarkerPort {}
impl McpCatalogPort for RuntimeServiceMarkerPort {}

#[derive(Clone)]
pub struct RuntimeServices {
    pub filesystem: Arc<dyn FileSystemPort>,
    pub workspace: Arc<dyn WorkspacePort>,
    pub session_store: Arc<dyn SessionStorePort>,
    pub events: Arc<dyn RuntimeEventSink>,
    pub clock: Arc<dyn ClockPort>,
    pub terminal: Option<Arc<dyn TerminalPort>>,
    pub remote_exec: Option<Arc<dyn RemoteExecPort>>,
    pub network: Option<Arc<dyn NetworkPort>>,
    pub git: Option<Arc<dyn GitPort>>,
    pub mcp_catalog: Option<Arc<dyn McpCatalogPort>>,
    pub remote_connection: Option<Arc<dyn RemoteConnectionPort>>,
    pub remote_workspace: Option<Arc<dyn RemoteWorkspacePort>>,
    pub remote_projection: Option<Arc<dyn RemoteProjectionPort>>,
    pub remote_capabilities: Option<Arc<dyn RemoteCapabilityPort>>,
}

impl std::fmt::Debug for RuntimeServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeServices")
            .field("filesystem", &self.filesystem.capability())
            .field("workspace", &self.workspace.capability())
            .field("session_store", &self.session_store.capability())
            .field("events", &RuntimeServiceCapability::Events)
            .field("clock", &self.clock.capability())
            .field(
                "terminal",
                &self.terminal.as_ref().map(|port| port.capability()),
            )
            .field(
                "remote_exec",
                &self.remote_exec.as_ref().map(|port| port.capability()),
            )
            .field(
                "network",
                &self.network.as_ref().map(|port| port.capability()),
            )
            .field("git", &self.git.as_ref().map(|port| port.capability()))
            .field(
                "mcp_catalog",
                &self.mcp_catalog.as_ref().map(|port| port.capability()),
            )
            .field(
                "remote_connection",
                &self
                    .remote_connection
                    .as_ref()
                    .map(|port| port.capability()),
            )
            .field(
                "remote_workspace",
                &self.remote_workspace.as_ref().map(|port| port.capability()),
            )
            .field(
                "remote_projection",
                &self
                    .remote_projection
                    .as_ref()
                    .map(|port| port.capability()),
            )
            .field(
                "remote_capabilities",
                &self
                    .remote_capabilities
                    .as_ref()
                    .map(|port| port.capability()),
            )
            .finish()
    }
}

impl RuntimeServices {
    pub fn has_capability(&self, capability: RuntimeServiceCapability) -> bool {
        match capability {
            RuntimeServiceCapability::FileSystem
            | RuntimeServiceCapability::Workspace
            | RuntimeServiceCapability::SessionStore
            | RuntimeServiceCapability::Events
            | RuntimeServiceCapability::Clock => true,
            RuntimeServiceCapability::Permission => false,
            RuntimeServiceCapability::Terminal => self.terminal.is_some(),
            RuntimeServiceCapability::RemoteExec => self.remote_exec.is_some(),
            RuntimeServiceCapability::Network => self.network.is_some(),
            RuntimeServiceCapability::Git => self.git.is_some(),
            RuntimeServiceCapability::McpCatalog => self.mcp_catalog.is_some(),
            RuntimeServiceCapability::RemoteConnection => self.remote_connection.is_some(),
            RuntimeServiceCapability::RemoteWorkspace => self.remote_workspace.is_some(),
            RuntimeServiceCapability::RemoteProjection => self.remote_projection.is_some(),
            RuntimeServiceCapability::RemoteCapabilities => self.remote_capabilities.is_some(),
            RuntimeServiceCapability::PtcRuntime => false,
        }
    }

    pub fn capability_availability(
        &self,
        capability: RuntimeServiceCapability,
    ) -> CapabilityAvailability {
        CapabilityAvailability {
            capability,
            available: self.has_capability(capability),
        }
    }

    pub fn require_capability(
        &self,
        capability: RuntimeServiceCapability,
    ) -> Result<(), RuntimeServicesError> {
        if self.has_capability(capability) {
            Ok(())
        } else {
            Err(RuntimeServicesError::Unsupported { capability })
        }
    }
}

#[derive(Default, Clone)]
pub struct RuntimeServicesBuilder {
    filesystem: Option<Arc<dyn FileSystemPort>>,
    workspace: Option<Arc<dyn WorkspacePort>>,
    session_store: Option<Arc<dyn SessionStorePort>>,
    events: Option<Arc<dyn RuntimeEventSink>>,
    clock: Option<Arc<dyn ClockPort>>,
    terminal: Option<Arc<dyn TerminalPort>>,
    remote_exec: Option<Arc<dyn RemoteExecPort>>,
    network: Option<Arc<dyn NetworkPort>>,
    git: Option<Arc<dyn GitPort>>,
    mcp_catalog: Option<Arc<dyn McpCatalogPort>>,
    remote_connection: Option<Arc<dyn RemoteConnectionPort>>,
    remote_workspace: Option<Arc<dyn RemoteWorkspacePort>>,
    remote_projection: Option<Arc<dyn RemoteProjectionPort>>,
    remote_capabilities: Option<Arc<dyn RemoteCapabilityPort>>,
}

impl RuntimeServicesBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_filesystem(mut self, port: Arc<dyn FileSystemPort>) -> Self {
        self.filesystem = Some(port);
        self
    }

    pub fn with_workspace(mut self, port: Arc<dyn WorkspacePort>) -> Self {
        self.workspace = Some(port);
        self
    }

    pub fn with_session_store(mut self, port: Arc<dyn SessionStorePort>) -> Self {
        self.session_store = Some(port);
        self
    }

    pub fn with_events(mut self, port: Arc<dyn RuntimeEventSink>) -> Self {
        self.events = Some(port);
        self
    }

    pub fn with_clock(mut self, port: Arc<dyn ClockPort>) -> Self {
        self.clock = Some(port);
        self
    }

    pub fn with_optional_terminal(mut self, port: Option<Arc<dyn TerminalPort>>) -> Self {
        self.terminal = port;
        self
    }

    pub fn with_optional_remote_exec(mut self, port: Option<Arc<dyn RemoteExecPort>>) -> Self {
        self.remote_exec = port;
        self
    }

    pub fn with_optional_network(mut self, port: Option<Arc<dyn NetworkPort>>) -> Self {
        self.network = port;
        self
    }

    pub fn with_optional_git(mut self, port: Option<Arc<dyn GitPort>>) -> Self {
        self.git = port;
        self
    }

    pub fn with_optional_mcp_catalog(mut self, port: Option<Arc<dyn McpCatalogPort>>) -> Self {
        self.mcp_catalog = port;
        self
    }

    pub fn with_optional_remote_connection(
        mut self,
        port: Option<Arc<dyn RemoteConnectionPort>>,
    ) -> Self {
        self.remote_connection = port;
        self
    }

    pub fn with_optional_remote_workspace(
        mut self,
        port: Option<Arc<dyn RemoteWorkspacePort>>,
    ) -> Self {
        self.remote_workspace = port;
        self
    }

    pub fn with_optional_remote_projection(
        mut self,
        port: Option<Arc<dyn RemoteProjectionPort>>,
    ) -> Self {
        self.remote_projection = port;
        self
    }

    pub fn with_optional_remote_capabilities(
        mut self,
        port: Option<Arc<dyn RemoteCapabilityPort>>,
    ) -> Self {
        self.remote_capabilities = port;
        self
    }

    pub fn build(self) -> Result<RuntimeServices, RuntimeServicesError> {
        Ok(RuntimeServices {
            filesystem: Self::required_service(
                self.filesystem,
                RuntimeServiceCapability::FileSystem,
            )?,
            workspace: Self::required_service(self.workspace, RuntimeServiceCapability::Workspace)?,
            session_store: Self::required_service(
                self.session_store,
                RuntimeServiceCapability::SessionStore,
            )?,
            events: Self::required(self.events, RuntimeServiceCapability::Events)?,
            clock: Self::required_service(self.clock, RuntimeServiceCapability::Clock)?,
            terminal: Self::optional_service(self.terminal, RuntimeServiceCapability::Terminal)?,
            remote_exec: Self::optional_service(
                self.remote_exec,
                RuntimeServiceCapability::RemoteExec,
            )?,
            network: Self::optional_service(self.network, RuntimeServiceCapability::Network)?,
            git: Self::optional_service(self.git, RuntimeServiceCapability::Git)?,
            mcp_catalog: Self::optional_service(
                self.mcp_catalog,
                RuntimeServiceCapability::McpCatalog,
            )?,
            remote_connection: Self::optional_service(
                self.remote_connection,
                RuntimeServiceCapability::RemoteConnection,
            )?,
            remote_workspace: Self::optional_service(
                self.remote_workspace,
                RuntimeServiceCapability::RemoteWorkspace,
            )?,
            remote_projection: Self::optional_service(
                self.remote_projection,
                RuntimeServiceCapability::RemoteProjection,
            )?,
            remote_capabilities: Self::optional_service(
                self.remote_capabilities,
                RuntimeServiceCapability::RemoteCapabilities,
            )?,
        })
    }

    fn required<T>(
        port: Option<Arc<T>>,
        capability: RuntimeServiceCapability,
    ) -> Result<Arc<T>, RuntimeServicesError>
    where
        T: ?Sized,
    {
        port.ok_or(RuntimeServicesError::MissingRequired { capability })
    }

    fn required_service<T>(
        port: Option<Arc<T>>,
        expected: RuntimeServiceCapability,
    ) -> Result<Arc<T>, RuntimeServicesError>
    where
        T: RuntimeServicePort + ?Sized,
    {
        let port = Self::required(port, expected)?;
        Self::validate_capability(&port, expected)?;
        Ok(port)
    }

    fn optional_service<T>(
        port: Option<Arc<T>>,
        expected: RuntimeServiceCapability,
    ) -> Result<Option<Arc<T>>, RuntimeServicesError>
    where
        T: RuntimeServicePort + ?Sized,
    {
        if let Some(port) = port {
            Self::validate_capability(&port, expected)?;
            Ok(Some(port))
        } else {
            Ok(None)
        }
    }

    fn validate_capability<T>(
        port: &Arc<T>,
        expected: RuntimeServiceCapability,
    ) -> Result<(), RuntimeServicesError>
    where
        T: RuntimeServicePort + ?Sized,
    {
        let actual = port.capability();
        if actual == expected {
            Ok(())
        } else {
            Err(RuntimeServicesError::CapabilityMismatch { expected, actual })
        }
    }
}

pub trait RuntimeServicesProvider: Send + Sync {
    fn register(&self, builder: RuntimeServicesBuilder) -> RuntimeServicesBuilder;
}

#[derive(Default)]
pub struct RuntimeServicesRegistry {
    providers: Vec<Box<dyn RuntimeServicesProvider>>,
}

impl RuntimeServicesRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_provider<P>(mut self, provider: P) -> Self
    where
        P: RuntimeServicesProvider + 'static,
    {
        self.providers.push(Box::new(provider));
        self
    }

    pub fn build(
        &self,
        mut builder: RuntimeServicesBuilder,
    ) -> Result<RuntimeServices, RuntimeServicesError> {
        for provider in &self.providers {
            builder = provider.register(builder);
        }
        builder.build()
    }
}
