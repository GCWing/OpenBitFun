use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openbitfun_agent_runtime::native_hooks::{
    AgentHookMatcher, BuiltinHookExecutor, HookCall, HookHandler, HookHandlerResult,
    RuntimeHookRegistration, RuntimeHookSource,
};
use openbitfun_agent_runtime::sdk::{
    AgentEventStream, AgentModeCatalogEntry, AgentModeCatalogPort, AgentModeCatalogQuery,
    AgentRunRequest, AgentRuntimeBuilder, AgentRuntimeSdkCompatibility, AgentRuntimeSdkStability,
    AgentSessionClosePort, AgentSessionCreateRequest, AgentSessionCreateResult,
    AgentSubmissionPort, AgentSubmissionRequest, AgentSubmissionResult, AgentSubmissionSource,
    AgentTransientSessionDiscardRequest, ClockPort, FileSystemPort, GitPort, PortErrorKind,
    PortResult, RuntimeAgentRegistry, RuntimeAgentRegistryQuery, RuntimeError,
    RuntimeEventEnvelope, RuntimeEventSink, RuntimeEventType, RuntimeHookErrorPolicy,
    RuntimeHookKind, RuntimeHookPlan, RuntimeHookRegistry, RuntimeServiceCapability,
    RuntimeServicePort, RuntimeServices, RuntimeServicesBuilder, SessionSelector,
    SessionStorageKind, SessionStoragePathRequest, SessionStoragePathResolution, SessionStorePort,
    ToolRegistry, ToolRegistryItem, WorkspaceDiffContent, WorkspaceDiffFile,
    WorkspaceDiffFileStatus, WorkspaceDiffSnapshot, WorkspacePort,
};
use serde_json::{json, Value};

#[derive(Debug, Default)]
struct FakeSdkAgentProvider {
    created_sessions: Mutex<Vec<AgentSessionCreateRequest>>,
    submitted_turns: Mutex<Vec<AgentSubmissionRequest>>,
}

struct FakeSdkTool;

struct NoopHook;

#[async_trait]
impl BuiltinHookExecutor for NoopHook {
    async fn execute(&self, _call: &HookCall) -> HookHandlerResult {
        Default::default()
    }
}

#[derive(Debug)]
struct FakeSdkAgentRegistry {
    agent_ids: Vec<String>,
    workspace_agent_ids: Vec<String>,
}

#[derive(Debug)]
struct FakeSdkRuntimePort {
    capability: RuntimeServiceCapability,
}

#[derive(Debug)]
struct FakeSdkGitPort;

#[derive(Debug, Default)]
struct FakeSdkRuntimeEventSink;

#[derive(Debug, Default)]
struct FakeSessionClosePort {
    requests: Mutex<Vec<AgentTransientSessionDiscardRequest>>,
    persisted_requests: Mutex<Vec<AgentTransientSessionDiscardRequest>>,
}

#[derive(Debug, Default)]
struct FakeModeCatalog {
    queries: Mutex<Vec<AgentModeCatalogQuery>>,
}

#[async_trait]
impl AgentModeCatalogPort for FakeModeCatalog {
    async fn list_modes(
        &self,
        query: AgentModeCatalogQuery,
    ) -> PortResult<Vec<AgentModeCatalogEntry>> {
        self.queries.lock().unwrap().push(query);
        Ok(vec![AgentModeCatalogEntry {
            id: "Explore".to_string(),
            route_key: "Explore".to_string(),
            description: "Inspect the workspace".to_string(),
            model_id: Some("model-a".to_string()),
            is_external: false,
        }])
    }
}

#[test]
fn sdk_facade_exposes_versioned_preview_compatibility_contract() {
    let compatibility = AgentRuntimeSdkCompatibility::current();

    assert_eq!(compatibility.api_version, 10);
    assert_eq!(compatibility.crate_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(compatibility.stability, AgentRuntimeSdkStability::Preview);
}

impl RuntimeAgentRegistry for FakeSdkAgentRegistry {
    fn agent_ids(&self, query: RuntimeAgentRegistryQuery<'_>) -> Vec<String> {
        if query.workspace_id.is_some() {
            self.workspace_agent_ids.clone()
        } else {
            self.agent_ids.clone()
        }
    }
}

impl FakeSdkRuntimePort {
    fn new(capability: RuntimeServiceCapability) -> Self {
        Self { capability }
    }
}

impl RuntimeServicePort for FakeSdkRuntimePort {
    fn capability(&self) -> RuntimeServiceCapability {
        self.capability
    }
}

impl FileSystemPort for FakeSdkRuntimePort {}
impl WorkspacePort for FakeSdkRuntimePort {}

#[async_trait]
impl GitPort for FakeSdkGitPort {
    async fn workspace_diff(&self) -> PortResult<WorkspaceDiffSnapshot> {
        Ok(WorkspaceDiffSnapshot {
            files: vec![WorkspaceDiffFile {
                path: "src/lib.rs".to_string(),
                old_path: None,
                status: WorkspaceDiffFileStatus::Modified,
                staged: false,
                unstaged: true,
                untracked: false,
                additions: 1,
                deletions: 1,
                content: WorkspaceDiffContent::Text {
                    patch: "@@ -1 +1 @@\n-old\n+new\n".to_string(),
                },
            }],
            truncated: false,
        })
    }
}

impl RuntimeServicePort for FakeSdkGitPort {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::Git
    }
}

#[async_trait]
impl AgentSessionClosePort for FakeSessionClosePort {
    async fn discard_transient_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> PortResult<bool> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(true)
    }

    async fn unload_persisted_session(
        &self,
        request: AgentTransientSessionDiscardRequest,
    ) -> PortResult<bool> {
        self.persisted_requests
            .lock()
            .unwrap()
            .push(request.clone());
        Ok(true)
    }
}

#[async_trait]
impl SessionStorePort for FakeSdkRuntimePort {
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

impl ClockPort for FakeSdkRuntimePort {
    fn now_unix_millis(&self) -> i64 {
        0
    }
}

#[async_trait]
impl RuntimeEventSink for FakeSdkRuntimeEventSink {
    async fn publish_runtime_event(&self, _event: RuntimeEventEnvelope) -> PortResult<()> {
        Ok(())
    }
}

fn fake_sdk_services() -> RuntimeServices {
    RuntimeServicesBuilder::new()
        .with_filesystem(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::FileSystem,
        )))
        .with_workspace(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::Workspace,
        )))
        .with_session_store(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::SessionStore,
        )))
        .with_events(Arc::new(FakeSdkRuntimeEventSink))
        .with_clock(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::Clock,
        )))
        .build()
        .expect("fake SDK services")
}

fn fake_sdk_services_with_git() -> RuntimeServices {
    RuntimeServicesBuilder::new()
        .with_filesystem(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::FileSystem,
        )))
        .with_workspace(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::Workspace,
        )))
        .with_session_store(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::SessionStore,
        )))
        .with_events(Arc::new(FakeSdkRuntimeEventSink))
        .with_clock(Arc::new(FakeSdkRuntimePort::new(
            RuntimeServiceCapability::Clock,
        )))
        .with_optional_git(Some(Arc::new(FakeSdkGitPort)))
        .build()
        .expect("fake SDK services with Git")
}

#[async_trait]
impl ToolRegistryItem for FakeSdkTool {
    fn name(&self) -> &str {
        "sdk_echo"
    }

    async fn description(&self) -> Result<String, String> {
        Ok("Echo input for SDK smoke coverage".to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" }
            }
        })
    }
}

#[async_trait]
impl AgentSubmissionPort for FakeSdkAgentProvider {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        self.created_sessions.lock().unwrap().push(request.clone());
        Ok(AgentSessionCreateResult::new(
            "sdk-session-1",
            request.session_name,
            request.agent_type,
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        self.submitted_turns.lock().unwrap().push(request.clone());
        Ok(AgentSubmissionResult {
            turn_id: request.turn_id.unwrap_or_else(|| "sdk-turn-1".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, _session_id: &str) -> PortResult<Option<String>> {
        Ok(Some("Standard".to_string()))
    }
}

#[tokio::test]
async fn sdk_facade_runs_with_fake_provider_and_local_event_stream() {
    let provider = Arc::new(FakeSdkAgentProvider::default());
    let events = AgentEventStream::new();
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider.clone())
        .with_event_stream(events.clone())
        .build()
        .expect("sdk runtime");

    let handle = runtime
        .run(
            AgentRunRequest::new(
                SessionSelector::create(
                    "SDK smoke",
                    "Standard",
                    Some("/workspace/project".to_string()),
                ),
                "hello from sdk",
            )
            .with_turn_id("sdk-turn-1")
            .with_source(AgentSubmissionSource::Cli),
        )
        .await
        .expect("sdk run");

    assert_eq!(handle.session_id, "sdk-session-1");
    assert_eq!(handle.turn_id, "sdk-turn-1");
    assert_eq!(handle.agent_type.as_deref(), Some("Standard"));
    assert!(handle.accepted);

    runtime
        .publish_event(RuntimeEventEnvelope {
            session_id: handle.session_id.clone(),
            turn_id: Some(handle.turn_id.clone()),
            source: Some(AgentSubmissionSource::Cli),
            event_type: RuntimeEventType::TurnStarted,
            payload: serde_json::json!({ "source": "sdk-smoke" }),
        })
        .await
        .expect("publish sdk event");

    assert_eq!(provider.created_sessions.lock().unwrap().len(), 1);
    assert_eq!(provider.submitted_turns.lock().unwrap().len(), 1);
    assert_eq!(
        handle.events.expect("event stream").snapshot(),
        events.snapshot()
    );
    assert_eq!(events.len(), 1);
}

#[tokio::test]
async fn sdk_facade_delegates_mode_catalog_queries_to_the_injected_owner() {
    let catalog = Arc::new(FakeModeCatalog::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSdkAgentProvider::default()))
        .with_mode_catalog(catalog.clone())
        .build()
        .expect("sdk runtime");

    let query = AgentModeCatalogQuery {
        workspace_id: None,
        workspace_root: Some("/workspace/project".to_string()),
        include_external: true,
    };
    let modes = runtime
        .list_agent_modes(query.clone())
        .await
        .expect("mode catalog");

    assert_eq!(modes.len(), 1);
    assert_eq!(modes[0].id, "Explore");
    assert_eq!(catalog.queries.lock().unwrap().as_slice(), &[query]);
}

#[tokio::test]
async fn sdk_facade_fails_closed_without_a_mode_catalog_owner() {
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSdkAgentProvider::default()))
        .build()
        .expect("sdk runtime");

    let error = runtime
        .list_agent_modes(AgentModeCatalogQuery {
            workspace_id: None,
            workspace_root: None,
            include_external: false,
        })
        .await
        .expect_err("missing mode catalog must fail closed");

    assert!(matches!(
        error,
        RuntimeError::Port(port) if port.kind == PortErrorKind::NotAvailable
    ));
}

#[tokio::test]
async fn sdk_facade_accepts_fake_services_tools_and_hooks_without_core() {
    let provider = Arc::new(FakeSdkAgentProvider::default());
    let services = fake_sdk_services();
    let mut tools = ToolRegistry::new();
    tools.register_tool(Arc::new(FakeSdkTool));
    let hooks = RuntimeHookRegistry::builder()
        .register(RuntimeHookRegistration::new(
            RuntimeHookPlan::new(
                "sdk.post_call",
                RuntimeHookKind::SuccessfulToolPostCall,
                RuntimeHookSource::Builtin { priority: 0 },
            )
            .with_timeout_millis(250)
            .with_error_policy(RuntimeHookErrorPolicy::RecordWarning),
            HookHandler::Builtin {
                executor: Arc::new(NoopHook),
            },
            AgentHookMatcher::Any,
        ))
        .build()
        .expect("hook registry should build");

    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider)
        .with_services(services)
        .with_tool_registry(Arc::new(tools))
        .with_hook_registry(hooks)
        .with_agent_registry(Arc::new(FakeSdkAgentRegistry {
            agent_ids: vec!["Standard".to_string(), "Explore".to_string()],
            workspace_agent_ids: vec![
                "Standard".to_string(),
                "Explore".to_string(),
                "ProjectReviewer".to_string(),
            ],
        }))
        .build()
        .expect("sdk runtime");

    assert_eq!(runtime.registered_tool_names(), vec!["sdk_echo"]);
    assert_eq!(runtime.hook_registry().hooks()[0].id(), "sdk.post_call");
    assert_eq!(
        runtime.registered_agent_ids(RuntimeAgentRegistryQuery::default()),
        vec!["Standard".to_string(), "Explore".to_string()]
    );
    assert_eq!(
        runtime.registered_agent_ids(RuntimeAgentRegistryQuery {
            workspace_id: Some("workspace-project"),
        }),
        vec![
            "Standard".to_string(),
            "Explore".to_string(),
            "ProjectReviewer".to_string()
        ]
    );
    assert!(runtime
        .services()
        .expect("services should be injected")
        .has_capability(RuntimeServiceCapability::SessionStore));
}

#[tokio::test]
async fn sdk_facade_delegates_workspace_diff_to_runtime_services() {
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSdkAgentProvider::default()))
        .with_services(fake_sdk_services_with_git())
        .build()
        .expect("sdk runtime");

    let snapshot = runtime.workspace_diff().await.expect("workspace diff");

    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "src/lib.rs");
}

#[tokio::test]
async fn sdk_facade_delegates_connection_scoped_session_discard() {
    let provider = Arc::new(FakeSdkAgentProvider::default());
    let close_port = Arc::new(FakeSessionClosePort::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider)
        .with_session_close_port(close_port.clone())
        .build()
        .expect("sdk runtime");
    let request = AgentTransientSessionDiscardRequest {
        workspace_id: None,
        workspace_path: "/workspace/project".to_string(),
        session_id: "sdk-session-1".to_string(),
        remote_connection_id: None,
        remote_ssh_host: None,
        wait_timeout_ms: 5_000,
    };

    let result = runtime
        .discard_transient_session(request.clone())
        .await
        .expect("discard transient session through SDK facade");

    assert_eq!(close_port.requests.lock().unwrap().as_slice(), &[request]);
    assert!(result);
}

#[tokio::test]
async fn sdk_facade_delegates_persisted_session_unload() {
    let provider = Arc::new(FakeSdkAgentProvider::default());
    let close_port = Arc::new(FakeSessionClosePort::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider)
        .with_session_close_port(close_port.clone())
        .build()
        .expect("sdk runtime");
    let request = AgentTransientSessionDiscardRequest {
        workspace_id: None,
        workspace_path: "/workspace/project".to_string(),
        session_id: "sdk-session-1".to_string(),
        remote_connection_id: None,
        remote_ssh_host: None,
        wait_timeout_ms: 5_000,
    };

    let result = runtime
        .unload_persisted_session(request.clone())
        .await
        .expect("unload persisted session through SDK facade");

    assert_eq!(
        close_port.persisted_requests.lock().unwrap().as_slice(),
        &[request]
    );
    assert!(result);
}

#[tokio::test]
async fn sdk_facade_reports_missing_session_close_capability() {
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSdkAgentProvider::default()))
        .build()
        .expect("sdk runtime");

    let error = runtime
        .discard_transient_session(AgentTransientSessionDiscardRequest {
            workspace_id: None,
            workspace_path: "/workspace/project".to_string(),
            session_id: "sdk-session-1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
            wait_timeout_ms: 5_000,
        })
        .await
        .expect_err("missing transient cleanup port must fail closed");

    assert!(matches!(
        &error,
        RuntimeError::Port(port) if port.kind == PortErrorKind::NotAvailable
    ));
    assert_eq!(
        error.into_message(),
        "agent session close port is not registered"
    );
}
