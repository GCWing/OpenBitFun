//! Bootstrap WorkspaceService / FileSystemService / DialogScheduler for Peer Host.

use std::sync::Arc;

use anyhow::{Context, Result};
use openbitfun_agent_runtime::sdk::SessionEventJournal;
use openbitfun_core::service::filesystem::FileSystemServiceFactory;
use openbitfun_core::service::session_projection_store::{
    runtime_event_log_dir, FileSessionProjectionStore,
};
use openbitfun_core::service::workspace::{self, WorkspaceService};

use crate::runtime::CliRuntimeContext;

use super::fanout::{start_peer_event_fanout, PeerControllerEventEmitter};
use super::state::{set_peer_host_state, try_peer_host_state, PeerHostState, PeerTurnTracker};

/// Ensure Peer Host services are ready. Idempotent.
pub(crate) async fn ensure_peer_host_ready(runtime: &CliRuntimeContext) -> Result<()> {
    if try_peer_host_state().is_some() {
        return Ok(());
    }

    let workspace_service = if let Some(existing) = workspace::get_global_workspace_service() {
        existing
    } else {
        let service = Arc::new(
            WorkspaceService::new()
                .await
                .context("WorkspaceService::new")?,
        );
        workspace::set_global_workspace_service(service.clone());
        service
    };

    let filesystem_service = Arc::new(FileSystemServiceFactory::create_default());
    // Same log the Desktop Host uses: either can own this Session at different
    // times, and a Turn left running by one must be replayable by the other.
    let session_event_journal = Arc::new(
        match openbitfun_core::infrastructure::try_get_path_manager_arc() {
            Ok(path_manager) => SessionEventJournal::new().with_store(Arc::new(
                FileSessionProjectionStore::new(runtime_event_log_dir(&path_manager)),
            )),
            Err(error) => {
                tracing::warn!(
                    "Runtime event log disabled: application paths unavailable: {error}"
                );
                SessionEventJournal::new()
            }
        },
    );
    let agent_runtime = runtime
        .agent_runtime()
        .clone()
        .with_session_event_journal(session_event_journal.clone());
    let agent_events = agent_runtime
        .subscribe_events()
        .map_err(|error| anyhow::anyhow!(error.into_message()))
        .context("Peer Host agent event stream is unavailable")?;

    let state = PeerHostState {
        agent_runtime,
        session_event_journal,
        local_workspace_snapshot: runtime.local_workspace_snapshot().clone(),
        compatibility: runtime.compatibility().clone(),
        account_runtime: runtime.account_runtime().clone(),
        account_routing: runtime.account_routing().clone(),
        turns: PeerTurnTracker::new(),
        workspace_service,
        filesystem_service,
        token_usage_service: runtime.token_usage_service().clone(),
    };

    if set_peer_host_state(state.clone()).is_err() {
        // Another task won the race; treat as success.
        return Ok(());
    }

    start_peer_event_fanout(state, agent_events);
    // A mobile controller or IM bot that opens a workspace on this host changes
    // the catalog an attached Desktop controller renders; mirror the hint.
    workspace::start_workspace_catalog_publication(Arc::new(PeerControllerEventEmitter));
    tracing::info!("CLI peer host services ready");
    Ok(())
}
