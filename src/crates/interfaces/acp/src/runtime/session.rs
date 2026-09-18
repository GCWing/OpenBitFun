use std::path::Path;

use agent_client_protocol::schema::{
    CloseSessionRequest, CloseSessionResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, SessionId,
    SessionInfo, SessionMode, SessionModeState, SetSessionModeRequest, SetSessionModeResponse,
};
use agent_client_protocol::{Client, ConnectionTo, Error, Result};
use chrono::{DateTime, Utc};
use dashmap::mapref::entry::Entry;
use openbitfun_agent_runtime::sdk::{
    AgentSessionCreateRequest, AgentSessionDeleteRequest, AgentSessionListRequest,
    AgentSessionModeUpdateRequest, SessionStoragePathRequest,
};
use openbitfun_core::agentic::agents::get_agent_registry;
use openbitfun_core::service::workspace::{get_global_workspace_service, WorkspaceInfo};

use super::model::{
    build_session_config_options, build_session_model_state, normalize_session_model_id,
};
use super::replay::replay_session_history;
use super::{AcpSessionState, OpenBitFunAcpRuntime};

impl OpenBitFunAcpRuntime {
    fn validate_session_target(session_id: &str, cwd: &Path) -> Result<()> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(|message| Error::invalid_params().data(message))?;
        if !cwd.is_absolute() {
            return Err(Error::invalid_params().data("cwd must be an absolute path"));
        }
        Ok(())
    }

    /// ACP names a workspace by its `cwd` directory operand. This is the one
    /// place that external reference is translated into the owning workspace
    /// record; every later runtime call carries the record ID.
    ///
    /// The record is registered hidden: an ACP client's `cwd` must not become
    /// an opened, recent, or current workspace of the desktop that shares the
    /// same catalog.
    async fn open_cwd_workspace(cwd: &str) -> Result<WorkspaceInfo> {
        let service = get_global_workspace_service()
            .ok_or_else(|| Error::internal_error().data("Workspace service is unavailable"))?;
        service
            .register_local_workspace_record(Path::new(cwd).to_path_buf())
            .await
            .map_err(|error| Error::invalid_params().data(error.to_string()))
    }

    /// Read-only translation for listing: a directory no record owns has no
    /// sessions, so it answers `None` instead of opening a workspace.
    async fn resolve_cwd_workspace(cwd: &str) -> Result<Option<WorkspaceInfo>> {
        let service = get_global_workspace_service()
            .ok_or_else(|| Error::internal_error().data("Workspace service is unavailable"))?;
        service
            .resolve_legacy_workspace_reference(None, cwd, None, None)
            .await
            .map_err(|error| Error::invalid_params().data(error.to_string()))
    }

    pub(super) async fn create_session(
        &self,
        request: NewSessionRequest,
        connection: ConnectionTo<Client>,
    ) -> Result<NewSessionResponse> {
        let cwd = request.cwd.to_string_lossy().to_string();
        let mcp_servers = request.mcp_servers;
        self.validate_mcp_servers(&mcp_servers)?;
        let modes = build_session_modes(Some("Standard")).await;
        let models = build_session_model_state(None).await?;
        let config_options = build_session_config_options(None, Some("Standard")).await?;
        let session_id = uuid::Uuid::new_v4().to_string();
        Self::validate_session_target(&session_id, Path::new(&cwd))?;
        let workspace = Self::open_cwd_workspace(&cwd).await?;
        let _session_transition = self.claim_session_transition(&session_id)?;
        let mcp_server_ids = self
            .provision_mcp_servers(
                &session_id,
                mcp_servers,
                "Restart the ACP process before retrying session/new; no persisted Core session was created",
            )
            .await?;
        let create_request = AgentSessionCreateRequest {
            session_name: format!(
                "ACP Session - {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            ),
            agent_type: "Standard".to_string(),
            agent_route_key: None,
            workspace_path: Some(cwd.clone()),
            project_workspace_path: None,
            execution_target: None,
            workspace_id: Some(workspace.id.clone()),
            remote_connection_id: None,
            remote_ssh_host: None,
            model_id: None,
            metadata: serde_json::Map::new(),
        };
        let session = match self
            .agent_runtime
            .create_session_with_id(session_id.clone(), create_request)
            .await
        {
            Ok(session) => session,
            Err(error) => {
                let core_cleanup_required = matches!(
                    &error,
                    openbitfun_agent_runtime::sdk::RuntimeError::Port(port_error)
                        if port_error.kind == openbitfun_agent_runtime::sdk::PortErrorKind::CleanupRequired
                );
                let mcp_cleaned = self.release_mcp_servers(&mcp_server_ids).await.is_ok();
                let core_cleaned = if core_cleanup_required {
                    self.delete_failed_new_core_session(
                        &session_id,
                        &workspace.id,
                        &cwd,
                        "Core session creation rollback",
                    )
                    .await
                } else {
                    true
                };
                if !mcp_cleaned || !core_cleaned {
                    let mut cleanup_kinds = Vec::with_capacity(2);
                    if !mcp_cleaned {
                        cleanup_kinds.push("ephemeralMcp");
                    }
                    if !core_cleaned {
                        cleanup_kinds.push("coreSession");
                    }
                    return Err(Self::cleanup_required_error(
                        &session_id,
                        "Core session creation",
                        &cleanup_kinds,
                        core_cleanup_required,
                        "Restart the ACP process, inspect session/list for the returned sessionId, and remove only that failed session through a supported session manager before retrying",
                    ));
                }
                return Err(Self::runtime_error(error));
            }
        };
        let acp_session = AcpSessionState {
            acp_session_id: session.session_id.clone(),
            openbitfun_session_id: session.session_id.clone(),
            workspace_id: workspace.id,
            cwd,
            mode_id: session.agent_type.clone(),
            model_id: normalize_session_model_id(None),
            mcp_server_ids,
            lifecycle: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        let response = NewSessionResponse::new(SessionId::new(acp_session.acp_session_id.clone()))
            .modes(modes)
            .models(models)
            .config_options(config_options);

        if let Err(error) = self.publish_active_session(&acp_session, connection).await {
            let (mcp_cleaned, core_cleaned) = self
                .cleanup_failed_new_session_setup(&acp_session, "session publication")
                .await;
            if !mcp_cleaned || !core_cleaned {
                let mut cleanup_kinds = Vec::with_capacity(2);
                if !mcp_cleaned {
                    cleanup_kinds.push("ephemeralMcp");
                }
                if !core_cleaned {
                    cleanup_kinds.push("coreSession");
                }
                return Err(Self::cleanup_required_error(
                    &acp_session.acp_session_id,
                    "session publication",
                    &cleanup_kinds,
                    true,
                    "Restart the ACP process, inspect session/list for the returned sessionId, and remove only that newly created session through a supported session manager before retrying",
                ));
            }
            return Err(error);
        }
        Ok(response)
    }

    pub(super) async fn restore_session(
        &self,
        request: LoadSessionRequest,
        connection: ConnectionTo<Client>,
    ) -> Result<LoadSessionResponse> {
        let cwd = request.cwd.to_string_lossy().to_string();
        let session_id = request.session_id.to_string();
        let mcp_servers = request.mcp_servers;
        self.validate_mcp_servers(&mcp_servers)?;
        Self::validate_session_target(&session_id, Path::new(&cwd))?;
        let workspace = Self::open_cwd_workspace(&cwd).await?;
        let _session_transition = self.claim_session_transition(&session_id)?;
        if self.sessions.contains_key(&session_id) {
            return Err(Error::invalid_params().data("session is already active"));
        }
        let mcp_server_ids = self
            .provision_mcp_servers(
                &session_id,
                mcp_servers,
                "Restart the ACP process, then retry session/load with the same sessionId and cwd; preserve the existing persisted Core session",
            )
            .await?;
        // ACP history replay and model selection must come from one persisted
        // snapshot. Keep this compatibility path until the runtime contract can
        // return the rich turn data ACP actually projects.
        let restore = self
            .compatibility
            .restore_session_with_turns_for_workspace(
                SessionStoragePathRequest {
                    workspace_path: workspace.root_path.clone(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
                &session_id,
                false,
            )
            .await;
        let (session, turns) = match restore {
            Ok(restored) => restored,
            Err(error) => {
                if self.release_mcp_servers(&mcp_server_ids).await.is_err() {
                    return Err(Self::cleanup_required_error(
                        &session_id,
                        "Core session restore",
                        &["ephemeralMcp"],
                        false,
                        "Restart the ACP process, then retry session/load with the same sessionId and cwd; preserve the existing persisted Core session",
                    ));
                }
                return Err(Self::session_core_error(&session_id, error));
            }
        };
        let acp_session = AcpSessionState {
            acp_session_id: session.session_id.clone(),
            openbitfun_session_id: session.session_id.clone(),
            workspace_id: workspace.id,
            cwd,
            mode_id: session.agent_type.clone(),
            model_id: normalize_session_model_id(session.config.model_id.as_deref()),
            mcp_server_ids,
            lifecycle: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        let response = async {
            let modes = build_session_modes(Some(session.agent_type.as_str())).await;
            let models = build_session_model_state(Some(&acp_session.model_id)).await?;
            let config_options = build_session_config_options(
                Some(&acp_session.model_id),
                Some(&acp_session.mode_id),
            )
            .await?;
            Ok(LoadSessionResponse::new()
                .modes(modes)
                .models(models)
                .config_options(config_options))
        }
        .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if let Some(cleanup_error) = self
                    .cleanup_failed_loaded_session_setup(&acp_session, "load session response")
                    .await
                {
                    return Err(cleanup_error);
                }
                return Err(error);
            }
        };

        if let Err(error) = replay_session_history(&connection, &acp_session.acp_session_id, &turns)
        {
            if let Some(cleanup_error) = self
                .cleanup_failed_loaded_session_setup(&acp_session, "history replay")
                .await
            {
                return Err(cleanup_error);
            }
            return Err(error);
        }

        if let Err(error) = self.publish_active_session(&acp_session, connection).await {
            if let Some(cleanup_error) = self
                .cleanup_failed_loaded_session_setup(&acp_session, "session publication")
                .await
            {
                return Err(cleanup_error);
            }
            return Err(error);
        }
        Ok(response)
    }

    async fn publish_active_session(
        &self,
        session: &AcpSessionState,
        connection: ConnectionTo<Client>,
    ) -> Result<()> {
        let _lifecycle_guard = session.lifecycle.lock().await;
        match self.sessions.entry(session.acp_session_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(session.clone());
            }
            Entry::Occupied(_) => {
                return Err(Error::invalid_params().data("session is already active"));
            }
        }
        self.connections
            .insert(session.acp_session_id.clone(), connection);
        Ok(())
    }

    async fn cleanup_failed_session_setup(&self, session: &AcpSessionState, stage: &str) -> bool {
        if let Err(error) = self.release_mcp_servers(&session.mcp_server_ids).await {
            log::warn!(
                "Failed to clean up ACP session setup: session_id={}, stage={}, error={}",
                session.acp_session_id,
                stage,
                error
            );
            return false;
        }
        true
    }

    async fn cleanup_failed_loaded_session_setup(
        &self,
        session: &AcpSessionState,
        stage: &str,
    ) -> Option<Error> {
        let mcp_cleaned = self.cleanup_failed_session_setup(session, stage).await;
        let core_unloaded = match self
            .compatibility
            .unload_persisted_session(&session.openbitfun_session_id)
            .await
        {
            Ok(_) => true,
            Err(error) => {
                log::warn!(
                    "Failed to unload Core session after ACP load error: session_id={}, stage={}, error={}",
                    session.openbitfun_session_id,
                    stage,
                    error
                );
                false
            }
        };
        if mcp_cleaned && core_unloaded {
            return None;
        }

        let mut cleanup_kinds = Vec::with_capacity(2);
        if !mcp_cleaned {
            cleanup_kinds.push("ephemeralMcp");
        }
        if !core_unloaded {
            cleanup_kinds.push("coreRuntime");
        }
        Some(Self::cleanup_required_error(
            &session.acp_session_id,
            stage,
            &cleanup_kinds,
            false,
            "Restart the ACP process, then retry session/load with the same sessionId and cwd; preserve the existing persisted Core session",
        ))
    }

    async fn cleanup_failed_new_session_setup(
        &self,
        session: &AcpSessionState,
        stage: &str,
    ) -> (bool, bool) {
        let mcp_cleaned = self.cleanup_failed_session_setup(session, stage).await;
        let core_cleaned = self
            .delete_failed_new_core_session(
                &session.openbitfun_session_id,
                &session.workspace_id,
                &session.cwd,
                stage,
            )
            .await;
        (mcp_cleaned, core_cleaned)
    }

    async fn delete_failed_new_core_session(
        &self,
        session_id: &str,
        workspace_id: &str,
        cwd: &str,
        stage: &str,
    ) -> bool {
        if let Err(error) = self
            .agent_runtime
            .delete_session(AgentSessionDeleteRequest {
                workspace_id: Some(workspace_id.to_string()),
                workspace_path: cwd.to_string(),
                session_id: session_id.to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
        {
            log::warn!(
                "Failed to delete Core session after ACP setup error: session_id={}, stage={}, error={}",
                session_id,
                stage,
                error
            );
            return false;
        }
        true
    }

    pub(super) async fn close_active_session(
        &self,
        request: CloseSessionRequest,
    ) -> Result<CloseSessionResponse> {
        let session_id = request.session_id.to_string();
        let _session_transition = self.claim_session_transition(&session_id)?;
        let (active_session, _lifecycle_guard) = self.lock_active_session(&session_id).await?;
        let storage_path = self
            .compatibility
            .resolve_persisted_session_storage_path(SessionStoragePathRequest {
                workspace_path: Path::new(&active_session.cwd).to_path_buf(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .map_err(|error| {
                Self::session_close_incomplete_error(
                    &session_id,
                    "storage path resolution",
                    error,
                    &[],
                )
            })?;
        let _maintenance = self
            .compatibility
            .begin_session_maintenance(&storage_path, &active_session.openbitfun_session_id, 5_000)
            .await
            .map_err(|error| {
                Self::session_close_incomplete_error(&session_id, "active work drain", error, &[])
            })?;
        self.compatibility
            .unload_persisted_session(&active_session.openbitfun_session_id)
            .await
            .map_err(|error| {
                Self::session_close_incomplete_error(&session_id, "Core runtime unload", error, &[])
            })?;

        if let Err(error) = self
            .release_mcp_servers(&active_session.mcp_server_ids)
            .await
        {
            log::warn!(
                "Failed to release ACP MCP servers after Core session close; retaining ACP ownership for retry: session_id={}, error={}",
                session_id,
                error
            );
            return Err(Self::session_close_incomplete_error(
                &session_id,
                "ephemeral MCP cleanup",
                error,
                &["ephemeralMcp"],
            ));
        }

        self.sessions.remove(&session_id);
        self.connections.remove(&session_id);
        Ok(CloseSessionResponse::new())
    }

    pub(super) async fn list_sessions_for_cwd(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse> {
        let cwd = request
            .cwd
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| Error::invalid_params().data("cwd is required"))?;
        let cursor = request
            .cursor
            .as_deref()
            .and_then(|value| value.parse::<u128>().ok());

        // A directory that no workspace record owns has no sessions yet;
        // `session/new` is what opens it. Answer with an empty page instead of
        // an error so clients can list before their first session.
        let Some(workspace) = Self::resolve_cwd_workspace(&cwd.to_string_lossy()).await? else {
            return Ok(ListSessionsResponse::new(Vec::new()));
        };

        let mut summaries = self
            .agent_runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: Some(workspace.id),
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .map_err(Self::runtime_error)?;
        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.last_active_at_ms));

        let limit = 100usize;
        let filtered = summaries
            .into_iter()
            .filter(|summary| {
                cursor
                    .map(|cursor| u128::from(summary.last_active_at_ms) < cursor)
                    .unwrap_or(true)
            })
            .collect::<Vec<_>>();

        let sessions = filtered
            .iter()
            .take(limit)
            .map(|summary| {
                SessionInfo::new(
                    SessionId::new(summary.session_id.clone()),
                    Path::new(&cwd).to_path_buf(),
                )
                .title(summary.session_name.clone())
                .updated_at(unix_ms_to_rfc3339(summary.last_active_at_ms))
            })
            .collect::<Vec<_>>();

        let next_cursor = if filtered.len() > limit {
            filtered
                .get(limit - 1)
                .map(|summary| summary.last_active_at_ms.to_string())
        } else {
            None
        };

        Ok(ListSessionsResponse::new(sessions).next_cursor(next_cursor))
    }

    pub(super) async fn update_session_mode(
        &self,
        request: SetSessionModeRequest,
    ) -> Result<SetSessionModeResponse> {
        let session_id = request.session_id.to_string();
        let mode_id = request.mode_id.to_string();
        let (session, _lifecycle_guard) = self.lock_active_session(&session_id).await?;
        self.update_session_mode_for_active(&session, &mode_id)
            .await?;

        Ok(SetSessionModeResponse::new())
    }

    pub(super) async fn update_session_mode_for_active(
        &self,
        session: &AcpSessionState,
        mode_id: &str,
    ) -> Result<()> {
        let mode_id = mode_id.trim();
        self.agent_runtime
            .update_session_mode(AgentSessionModeUpdateRequest {
                session_id: session.openbitfun_session_id.clone(),
                mode_id: mode_id.to_string(),
                agent_route_key: None,
            })
            .await
            .map_err(|error| Self::session_runtime_error(&session.acp_session_id, error))?;

        let mut state = self
            .sessions
            .get_mut(&session.acp_session_id)
            .ok_or_else(|| Error::resource_not_found(Some(session.acp_session_id.clone())))?;
        state.mode_id = mode_id.to_string();
        drop(state);

        Ok(())
    }
}

async fn build_session_modes(preferred_mode_id: Option<&str>) -> SessionModeState {
    let available_modes = get_agent_registry()
        .get_modes_info()
        .await
        .into_iter()
        .map(|info| SessionMode::new(info.id, info.name).description(info.description))
        .collect::<Vec<_>>();

    let current_mode_id = preferred_mode_id
        .and_then(|preferred| {
            available_modes
                .iter()
                .find(|mode| mode.id.to_string() == preferred)
                .map(|mode| mode.id.clone())
        })
        .or_else(|| {
            available_modes
                .iter()
                .find(|mode| mode.id.to_string() == "Standard")
                .or_else(|| available_modes.first())
                .map(|mode| mode.id.clone())
        })
        .unwrap_or_else(|| "Standard".into());

    SessionModeState::new(current_mode_id, available_modes)
}

fn unix_ms_to_rfc3339(time_ms: u64) -> String {
    let time_ms = i64::try_from(time_ms).unwrap_or(i64::MAX);
    DateTime::<Utc>::from_timestamp_millis(time_ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::unix_ms_to_rfc3339;

    #[test]
    fn session_timestamps_remain_rfc3339_after_runtime_projection() {
        assert_eq!(unix_ms_to_rfc3339(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(
            unix_ms_to_rfc3339(1_700_000_000_000),
            "2023-11-14T22:13:20+00:00"
        );
    }
}
