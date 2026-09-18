//! MCP server manager
//!
//! The manager is split into focused submodules so lifecycle, reconnect,
//! catalog, interaction, and tool-registration logic can evolve independently.

mod auth;
mod auth_callback;
mod catalog;
mod external_lifecycle;
mod interaction;
mod lifecycle;
mod reconnect;
#[cfg(test)]
mod tests;
mod tools;

use super::connection::MCPConnection;
use super::{MCPServerConfig, MCPServerStatus};
use crate::infrastructure::events::event_system::{get_global_event_system, BackendEvent};
use crate::service::mcp::adapter::{MCPToolAdapter, MCPToolContextPolicy, MCPWorkspaceToolRoute};
use crate::service::mcp::auth::MCPRemoteOAuthSessionSnapshot;
use crate::service::mcp::config::MCPConfigService;
use crate::service::mcp::protocol::{MCPError, MCPPrompt, MCPResource};
use crate::service::workspace::get_global_workspace_service;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, error, info, warn};
use openbitfun_services_integrations::mcp::server::MCPConnectionEvent;
use openbitfun_services_integrations::mcp::server::{MCPServerRuntimeState, MCPServerStartFailure};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::task::JoinHandle;

#[derive(Debug)]
enum MCPInteractionDecision {
    Accept { result: Value },
    Reject { error: MCPError },
}

#[derive(Debug)]
struct PendingMCPInteraction {
    sender: oneshot::Sender<MCPInteractionDecision>,
}

struct ActiveRemoteOAuthSession {
    snapshot: Arc<tokio::sync::RwLock<MCPRemoteOAuthSessionSnapshot>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

pub(super) struct PersistedServerOperationGuard {
    server_id: String,
    in_flight: Arc<StdMutex<HashSet<String>>>,
}

impl Drop for PersistedServerOperationGuard {
    fn drop(&mut self) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        in_flight.remove(&self.server_id);
    }
}

/// MCP server manager.
#[derive(Clone)]
pub struct MCPServerManager {
    config_service: Arc<MCPConfigService>,
    runtime: Arc<MCPServerRuntimeState>,
    oauth_data_dir: Option<PathBuf>,
    reconnect_monitor_started: Arc<AtomicBool>,
    connection_event_tasks: Arc<tokio::sync::RwLock<HashMap<String, JoinHandle<()>>>>,
    pending_interactions: Arc<tokio::sync::RwLock<HashMap<String, PendingMCPInteraction>>>,
    oauth_sessions: Arc<tokio::sync::RwLock<HashMap<String, Arc<ActiveRemoteOAuthSession>>>>,
    ephemeral_retirements: Arc<tokio::sync::RwLock<HashMap<String, Arc<AtomicBool>>>>,
    ephemeral_workspace_scopes: Arc<tokio::sync::RwLock<HashMap<String, String>>>,
    ephemeral_ready_servers: Arc<tokio::sync::RwLock<HashSet<String>>>,
    ephemeral_start_tokens: Arc<tokio::sync::RwLock<HashMap<String, Arc<()>>>>,
    tool_context_policy: Arc<MCPToolContextPolicy>,
    ephemeral_lifecycle: Arc<Mutex<()>>,
    persisted_lifecycle: Arc<RwLock<()>>,
    persisted_server_operations: Arc<StdMutex<HashSet<String>>>,
}

impl MCPServerManager {
    /// Creates a new server manager.
    pub fn new(config_service: Arc<MCPConfigService>) -> Self {
        Self::assemble(config_service, None)
    }

    pub(crate) fn assemble(
        config_service: Arc<MCPConfigService>,
        oauth_data_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            config_service,
            runtime: Arc::new(MCPServerRuntimeState::new()),
            oauth_data_dir,
            reconnect_monitor_started: Arc::new(AtomicBool::new(false)),
            connection_event_tasks: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            pending_interactions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            oauth_sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            ephemeral_retirements: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            ephemeral_workspace_scopes: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            ephemeral_ready_servers: Arc::new(tokio::sync::RwLock::new(HashSet::new())),
            ephemeral_start_tokens: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            tool_context_policy: Arc::new(MCPToolContextPolicy::default()),
            ephemeral_lifecycle: Arc::new(Mutex::new(())),
            persisted_lifecycle: Arc::new(RwLock::new(())),
            persisted_server_operations: Arc::new(StdMutex::new(HashSet::new())),
        }
    }

    pub async fn replace_external_workspace_tool_route(
        &self,
        workspace_key: String,
        active_external_server_ids: std::collections::BTreeSet<String>,
        suppressed_native_server_ids: std::collections::BTreeSet<String>,
    ) {
        self.tool_context_policy.replace_route(
            workspace_key,
            MCPWorkspaceToolRoute {
                active_external_server_ids,
                suppressed_native_server_ids,
            },
        );
    }

    /// Authorizes access to a server from a concrete execution context.
    /// Runtime-only external servers are workspace-scoped and never available
    /// to remote or unscoped host callers. Native servers remain available
    /// unless the current local workspace explicitly selected an external
    /// conflict candidate for the same server.
    pub async fn server_available_for_context(
        &self,
        server_id: &str,
        workspace_id: Option<&str>,
        remote: bool,
    ) -> bool {
        let external_workspace_scope = self
            .ephemeral_workspace_scopes
            .read()
            .await
            .get(server_id)
            .cloned();
        let workspace_key = crate::agentic::workspace::workspace_route_key(workspace_id);
        self.tool_context_policy.server_available_for_route(
            server_id,
            external_workspace_scope.as_deref(),
            workspace_id.map(|_| workspace_key.as_str()),
            remote,
        )
    }

    /// Returns `Some(true)` only after an external runtime has connected and
    /// completed its initial tool catalog publication. `None` means the server
    /// is not an external runtime.
    pub async fn external_server_readiness(&self, server_id: &str) -> Option<bool> {
        if !self
            .ephemeral_workspace_scopes
            .read()
            .await
            .contains_key(server_id)
        {
            return None;
        }
        Some(
            self.ephemeral_ready_servers
                .read()
                .await
                .contains(server_id),
        )
    }

    pub async fn external_server_start_failure(
        &self,
        server_id: &str,
    ) -> Option<MCPServerStartFailure> {
        self.runtime.start_failure(server_id).await
    }
}

fn should_finish_ephemeral_retirement(
    connection_references: usize,
    elapsed: Duration,
    grace: Duration,
) -> bool {
    connection_references <= 2 || elapsed >= grace
}

fn external_start_publication_allowed(external: bool, retiring: bool) -> bool {
    !external || !retiring
}

fn external_start_token_is_current(current: Option<&Arc<()>>, expected: &Arc<()>) -> bool {
    current.is_some_and(|current| Arc::ptr_eq(current, expected))
}
