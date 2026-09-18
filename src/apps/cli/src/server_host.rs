//! Independent stdio Server Host behind the `openbitfun server` command.
//!
//! This module is the only assembly point in the CLI that may import the App
//! Server implementation (`openbitfun_app_server`). `openbitfun server` is not a TUI,
//! controller, or headless-CLI feature: it is a separate Host surface that
//! reuses the reviewed CLI product assembly, selected with
//! `DeliveryProfile::Cli` because the CLI assembly is the reviewed kernel
//! wiring for a cwd-scoped terminal-capable host, and then caps what the
//! shared App Server surface may do on that host.
//!
//! Host-owned guarantees enforced here, while the shared server stays
//! generic:
//! - an immutable identity, a canonical cwd workspace scope, and an explicit
//!   method allowlist injected through `AppServerHostPolicy`; every request
//!   outside the allowlist or workspace scope fails closed before any domain
//!   handler runs;
//! - transport limits advertised in `app/initialize` and enforced at the
//!   stdin reader, which fails closed on frames over the limit;
//! - stdin EOF becomes a loss-free disconnect signal; after `serve` returns,
//!   the Host cancels in-flight turns and exits deterministically.
//!
//! TUI, controller, and headless CLI code must keep App Server
//! implementation, client, and protocol imports forbidden; this module is the
//! reviewed exception. See docs/architecture/app-server-architecture.md for
//! the Host contract.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use anyhow::{Context as _, Result};
use futures_util::io::AsyncRead;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use openbitfun_app_server::{
    AppManagementService, AppServerDisconnect, AppServerHostLimits, AppServerHostPolicy,
    OpenBitFunAppRuntime, OpenBitFunAppServer,
};

/// Host identity injected into the connection policy.
const SERVER_HOST_IDENTITY: &str = "openbitfun-cli-server-host";

/// Explicit method allowlist for the stdio Host.
///
/// Read-only session, agent, permission, workspace, git, config, and i18n
/// methods plus the safe management catalog and snapshot methods. State
/// changing config, model, skill, subagent, MCP, account, settings-sync,
/// worktree, external-source control, and hook mutation methods are
/// intentionally absent: a cwd-scoped stdio Host must not mutate host-local
/// product state on behalf of a client.
const ALLOWED_METHODS: &[&str] = &[
    "app/initialize",
    "app/health",
    "app/syncEvents",
    "app/eventStreamState",
    "agent/createSession",
    "agent/listSessions",
    "agent/deleteSession",
    "agent/submitTurn",
    "agent/submitDialogTurn",
    "agent/steerTurn",
    "agent/runUserShellCommand",
    "agent/submitUserAnswers",
    "agent/cancelTurn",
    "agent/run",
    "agent/event",
    "agent/frontendEvent",
    "session/sync",
    "session/readTranscript",
    "session/resolveWorkspace",
    "session/rename",
    "session/setArchived",
    "session/updateModel",
    "session/updateMode",
    "session/fork",
    "session/forkAtTurn",
    "session/forkBeforeTurn",
    "session/restore",
    "session/compact",
    "session/undo",
    "session/redo",
    "session/reloadContext",
    "session/usage",
    "session/waitForSettlement",
    "session/lineage",
    "session/inspectLineage",
    "session/cancelLineage",
    "search/sessionContent",
    "agent/listModes",
    "agent/respondPermission",
    "agent/respondPermissionBatch",
    "agent/listPendingPermissionRequests",
    "agent/listProjectPermissionGrants",
    "agent/removeProjectPermissionGrant",
    "agent/clearProjectPermissionGrants",
    "agent/listProjectPermissionAudit",
    "workspace/diff",
    "workspace/searchReferences",
    "workspace/messageReferences",
    "git/isRepository",
    "git/getStatus",
    "git/getBranches",
    "config/event",
    "config/getAgentProfileConfigs",
    "config/getAgentProfileConfig",
    "config/getModelConfigs",
    "config/getTuiModelCatalog",
    "model/projectReasoningCatalog",
    "config/getConfig",
    "config/getConfigs",
    "config/validateConfig",
    "i18n/getCurrentLanguage",
    "i18n/getSupportedLanguages",
    "i18n/getConfig",
    "externalHook/snapshot",
    "nativeHook/overview",
    "skill/list",
    "subagent/list",
    "externalSource/snapshot",
];

/// Frame-limited stdin reader for the Host transport.
///
/// Counting is per line: bytes are reset on each newline and counted
/// otherwise. EOF becomes the loss-free disconnect signal shared with the
/// event forwarder, and a frame that exceeds the advertised Host limit fails
/// closed with a protocol error line and an `InvalidData` reader error.
struct StdioFrameReader {
    inner: tokio_util::compat::Compat<tokio::io::Stdin>,
    max_frame_bytes: u64,
    line_bytes: u64,
    disconnect: Arc<AppServerDisconnect>,
    error_reporter: StdioErrorReporter,
}

impl StdioFrameReader {
    fn new(
        inner: tokio_util::compat::Compat<tokio::io::Stdin>,
        max_frame_bytes: u64,
        disconnect: Arc<AppServerDisconnect>,
        error_reporter: StdioErrorReporter,
    ) -> Self {
        Self {
            inner,
            max_frame_bytes,
            line_bytes: 0,
            disconnect,
            error_reporter,
        }
    }

    fn account(&mut self, bytes: &[u8]) -> bool {
        for &byte in bytes {
            if byte == b'\n' {
                self.line_bytes = 0;
                continue;
            }
            self.line_bytes += 1;
            if self.line_bytes > self.max_frame_bytes {
                return true;
            }
        }
        false
    }
}

impl AsyncRead for StdioFrameReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let inner = Pin::new(&mut this.inner);
        match inner.poll_read(cx, buf) {
            Poll::Ready(Ok(0)) => {
                this.disconnect.signal();
                Poll::Ready(Ok(0))
            }
            Poll::Ready(Ok(read)) => {
                if this.account(&buf[..read]) {
                    this.disconnect.signal();
                    this.error_reporter
                        .report_frame_exceeds_limit(this.max_frame_bytes);
                    return Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "App-server frame exceeds the Host transport limit",
                    )));
                }
                Poll::Ready(Ok(read))
            }
            other => other,
        }
    }
}

/// Writes at most one protocol error line to stdout outside the normal
/// response path, used when the transport reader itself fails closed.
#[derive(Clone)]
struct StdioErrorReporter {
    stdout: Arc<tokio::sync::Mutex<tokio::io::Stdout>>,
    reported: Arc<AtomicBool>,
    written: Arc<tokio::sync::Notify>,
}

impl StdioErrorReporter {
    fn new(stdout: tokio::io::Stdout) -> Self {
        Self {
            stdout: Arc::new(tokio::sync::Mutex::new(stdout)),
            reported: Arc::new(AtomicBool::new(false)),
            written: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn report_frame_exceeds_limit(&self, max_frame_bytes: u64) {
        if self.reported.swap(true, Ordering::SeqCst) {
            return;
        }
        let stdout = self.stdout.clone();
        let written = self.written.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let message = serde_json::json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32602,
                    "message": "Frame exceeds Host transport limit",
                    "data": {
                        "reason": "frame_exceeds_host_limit",
                        "maxFrameBytes": max_frame_bytes,
                    },
                },
            });
            let mut line = serde_json::to_vec(&message).expect("serialize frame-limit error");
            line.push(b'\n');
            let mut stdout = stdout.lock().await;
            let _ = stdout.write_all(&line).await;
            let _ = stdout.flush().await;
            written.notify_one();
        });
    }

    /// Wait for a pending frame-limit error line to reach stdout before the
    /// Host exits, so the client always observes the failure before EOF.
    async fn flush_pending(&self) {
        if !self.reported.load(Ordering::SeqCst) {
            return;
        }
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(5), self.written.notified()).await;
    }
}

/// Serve the app-server surface over stdio for the `server` command.
///
/// stdout is reserved for JSON-RPC traffic (run_cli routes logs to stderr for
/// non-interactive commands). The workspace scope is the canonical current
/// directory only, and stdin EOF ends the connection, cancels in-flight
/// turns, and exits the process.
pub(crate) async fn serve() -> Result<()> {
    crate::setup_workspace();
    let workspace_root = std::env::current_dir().context("Failed to resolve server workspace")?;

    crate::agent::agentic_system::select_agentic_system_profile(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
    )?;
    openbitfun_core::service::config::initialize_global_config()
        .await
        .context("Failed to initialize global config service")?;
    tracing::info!("Global config service initialized");
    let workspace = crate::create_cli_local_workspace(&workspace_root).await?;

    use openbitfun_core::infrastructure::ai::AIClientFactory;
    AIClientFactory::initialize_global()
        .await
        .context("Failed to initialize global AIClientFactory")?;
    tracing::info!("Global AI client factory initialized");

    crate::initialize_terminal_service().await;

    let path_manager = openbitfun_core::infrastructure::try_get_path_manager_arc()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let deployment = openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded;
    let runtime_ownership =
        openbitfun_core::runtime_ownership::CoreRuntimeOwnership::fixed_workspace(
            path_manager.as_ref(),
            "server",
            &workspace_root,
            deployment,
        )
        .map_err(|error| anyhow::anyhow!(error.startup_message(deployment, "server")))?;

    let agentic_system = crate::agent::agentic_system::init_agentic_system(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
        std::sync::Arc::new(runtime_ownership),
    )
    .await
    .context("Failed to initialize agentic system")?;
    tracing::info!("Agentic system initialized");

    let context = crate::runtime::AppServerRuntimeContext::build(agentic_system, &workspace_root)?;
    let (agent_runtime, event_source, compatibility) = context.parts();
    let disconnect_runtime = agent_runtime.clone();
    let compatibility = std::sync::Arc::new(compatibility);
    let app_runtime = OpenBitFunAppRuntime::new(agent_runtime, event_source)
        .with_context_reload(compatibility.clone())
        .with_product_search(compatibility);
    let management = std::sync::Arc::new(
        AppManagementService::load()
            .await
            .context("Failed to load app-server management service")?,
    );

    let limits = AppServerHostLimits::local_stdio();
    let policy = AppServerHostPolicy::new(
        SERVER_HOST_IDENTITY,
        &workspace_root,
        ALLOWED_METHODS.iter().copied(),
    )
    .map_err(anyhow::Error::new)
    .context("Failed to build the server Host policy")?;
    let disconnect = std::sync::Arc::new(AppServerDisconnect::default());
    let server = OpenBitFunAppServer::new(app_runtime)
        .with_management(management)
        .with_host_limits(limits)
        .with_host_policy(policy.clone())
        .with_disconnect(disconnect.clone());

    let error_reporter = StdioErrorReporter::new(tokio::io::stdout());
    let stdout = tokio::io::stdout().compat_write();
    let stdin = StdioFrameReader::new(
        tokio::io::stdin().compat(),
        limits.max_frame_bytes,
        disconnect.clone(),
        error_reporter.clone(),
    );

    let served = server
        .serve(openbitfun_app_server::protocol::ByteStreams::new(
            stdout, stdin,
        ))
        .await;

    cancel_active_turns(&disconnect_runtime, &workspace.id).await;

    match served {
        Ok(()) => {
            tracing::info!("App-server stdio connection ended, exiting the server Host");
            std::process::exit(0);
        }
        Err(error) => {
            tracing::error!(error = ?error, "App-server stdio serving failed");
            error_reporter.flush_pending().await;
            std::process::exit(1);
        }
    }
}

/// Cancel every in-flight turn in the Host workspace after the connection
/// ends, so a client that disconnected mid-turn cannot leave work running.
async fn cancel_active_turns(
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    workspace_id: &str,
) {
    use openbitfun_agent_runtime::sdk::{AgentSessionListRequest, AgentTurnCancellationRequest};
    let request = AgentSessionListRequest {
        workspace_id: Some(workspace_id.to_owned()),
        workspace_path: String::new(),
        remote_connection_id: None,
        remote_ssh_host: None,
    };
    let sessions = match runtime.list_sessions(request).await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(%error, "Failed to list Host sessions for disconnect cancellation");
            return;
        }
    };
    for session in sessions {
        let request = AgentTurnCancellationRequest {
            session_id: session.session_id,
            turn_id: None,
            source: None,
            requester_session_id: None,
            reason: Some("host transport disconnect".to_string()),
            wait_timeout_ms: Some(1000),
            cancel_descendants: true,
        };
        if let Err(error) = runtime.cancel_turn(request).await {
            tracing::warn!(%error, "Failed to cancel a Host turn after disconnect");
        }
    }
}
