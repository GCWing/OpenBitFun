//! Terminal presentation adapter. PTYs and history belong to terminal services.
use crate::peer_host::{
    args::{get_string, optional_string, request_value},
    state::PeerHostState,
};
use openbitfun_core::service::{
    remote_connect::host_stream::HostStreamHub,
    remote_ssh::{get_remote_workspace_manager, RemoteTerminalManager},
    terminal::{
        session::{SessionStatus, TerminalSession},
        CloseSessionRequest, CreateSessionRequest, ResizeRequest, TerminalApi, WriteRequest,
    },
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

/// Lifecycle facts on `terminal-<id>`. Output stays in the replay log; these
/// tell a controller when no more of it will come.
const TERMINAL_EXIT_EVENT: &str = "terminal-exit";
const TERMINAL_CLOSED_EVENT: &str = "terminal-closed";
const TERMINAL_EXIT_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

async fn publish_lifecycle(hub: &HostStreamHub, id: &str, event: &str, mut payload: Value) {
    payload["terminal_id"] = json!(id);
    if let Err(error) = hub
        .append(format!("terminal-{id}"), event.into(), payload)
        .await
    {
        tracing::debug!(
            "Terminal lifecycle event was not published: terminal={id} event={event} error={error}"
        );
    }
}

/// `Some(code)` once the PTY has exited; the code itself may be unknown.
fn exited_code(session: Option<&TerminalSession>) -> Option<Option<i32>> {
    match session?.status {
        SessionStatus::Exited { exit_code } => Some(exit_code),
        _ => None,
    }
}

fn api() -> Result<TerminalApi, String> {
    TerminalApi::from_singleton().map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(request_value(args).clone()).map_err(|e| e.to_string())
}
fn response(session: openbitfun_core::service::remote_ssh::RemoteTerminalSession) -> Value {
    json!({"workspaceId":session.workspace_id,"id":session.id,"name":session.name,"cwd":session.cwd,"initialCwd":session.cwd,"shellType":"Remote","status":format!("{:?}",session.status),"cols":session.cols,"rows":session.rows,"connectionId":session.connection_id,"source":"user"})
}
async fn remote_session(id: &str) -> Option<RemoteTerminalManager> {
    let manager = get_remote_workspace_manager()?
        .get_terminal_manager()
        .await?;
    manager.get_session(id).await.map(|_| manager)
}

pub(crate) async fn create(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let id =
        optional_string(request, "sessionId").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut workspace_id = optional_string(request, "workspaceId");
    let explicit = optional_string(request, "connectionId");
    let mut cwd = optional_string(request, "workingDirectory");
    let connection = if workspace_id.is_some() || explicit.is_none() {
        let service = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or("Workspace service is unavailable")?;
        // Old-protocol ingress is the only place a path can be converted.
        let workspace = service
            .resolve_legacy_workspace_reference(
                workspace_id.as_deref(),
                cwd.as_deref().unwrap_or_default(),
                None,
                None,
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Terminal workspace ID is unavailable")?;
        workspace_id = Some(workspace.id.clone());
        cwd.get_or_insert_with(|| workspace.root_path.to_string_lossy().into_owned());
        match workspace.workspace_kind {
            openbitfun_core::service::workspace::WorkspaceKind::Remote => Some(
                workspace
                    .remote_ssh_connection_id()
                    .ok_or("Remote workspace is missing its saved SSH connection ID")?
                    .to_owned(),
            ),
            _ => None,
        }
    } else {
        // Explicit connection targets are used by the deployment wizard, which
        // can open a terminal before any workspace has been registered.
        explicit.filter(|id| !id.is_empty())
    };
    let hub = state
        .account_routing
        .host_stream_hub()
        .await
        .ok_or("Account host streams are unavailable")?;
    if let Some(connection) = connection {
        let services = openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services().await?;
        let ssh = services
            .get_ssh_manager()
            .await
            .ok_or("SSH manager is unavailable")?;
        if !ssh
            .get_saved_connections()
            .await
            .iter()
            .any(|profile| profile.id == connection)
        {
            return Err("Remote terminal requires a connection saved on this host".into());
        }
        let manager = services
            .get_terminal_manager()
            .await
            .ok_or("Remote terminal manager is unavailable")?;
        let cols = request
            .get("cols")
            .and_then(Value::as_u64)
            .unwrap_or(80)
            .try_into()
            .map_err(|_| "Invalid terminal width")?;
        let rows = request
            .get("rows")
            .and_then(Value::as_u64)
            .unwrap_or(24)
            .try_into()
            .map_err(|_| "Invalid terminal height")?;
        let created = manager
            .create_session(
                Some(id.clone()),
                optional_string(request, "name"),
                &connection,
                cols,
                rows,
                cwd.as_deref(),
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        hub.append(
            format!("terminal-{id}"),
            "terminal-created".into(),
            json!({"terminal_id":id}),
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut created = created;
        manager
            .set_workspace_id(&created.session.id, workspace_id.clone())
            .await;
        created.session.workspace_id = workspace_id.clone();
        let result = response(created.session);
        let mut rx = created.output_rx;
        tokio::spawn(async move {
            let mut closed = hub.subscribe_closed();
            loop {
                if *closed.borrow() {
                    break;
                }
                let output =
                    tokio::select! { output = rx.recv() => output, _ = closed.changed() => break };
                match output {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => {
                        publish_lifecycle(&hub, &id, TERMINAL_CLOSED_EVENT, json!({})).await;
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                if *closed.borrow() {
                    break;
                }
                while rx.try_recv().is_ok() {}
                let Some(cursor) = manager.replay_cursor(&id).await else {
                    publish_lifecycle(&hub, &id, TERMINAL_CLOSED_EVENT, json!({})).await;
                    break;
                };
                if hub
                    .append(
                        format!("terminal-{id}"),
                        "terminal-output".into(),
                        json!({"terminal_id":id,"cursor":cursor}),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        return Ok(result);
    }
    let terminal = api()?;
    let mut input = request.clone();
    input["sessionId"] = json!(id);
    input["workingDirectory"] = json!(cwd);
    if input.get("source").and_then(Value::as_str) == Some("user") {
        input["source"] = json!("manual");
    }
    let create: CreateSessionRequest = serde_json::from_value(input).map_err(|e| e.to_string())?;
    let mut rx = terminal.session_manager().subscribe_replay_cursor(&id);
    let session = terminal
        .create_session(create)
        .await
        .map_err(|e| e.to_string())?;
    let mut session = session;
    if let Some(workspace_id) = workspace_id {
        terminal
            .session_manager()
            .set_owner(
                &session.id,
                openbitfun_core::service::terminal::session::SessionOwner {
                    id: workspace_id.clone(),
                    owner_type: openbitfun_core::service::terminal::session::OwnerType::Workspace,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        session.workspace_id = Some(workspace_id);
    }
    hub.append(
        format!("terminal-{id}"),
        "terminal-created".into(),
        json!({"terminal_id":id}),
    )
    .await
    .map_err(|e| e.to_string())?;
    let manager = terminal.session_manager();
    tokio::spawn(async move {
        let mut closed = hub.subscribe_closed();
        // The replay watch only moves on output; a shell can exit without any.
        let mut exit_check = tokio::time::interval(TERMINAL_EXIT_CHECK_INTERVAL);
        exit_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut exit_published = false;
        loop {
            if *closed.borrow() {
                break;
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        publish_lifecycle(&hub, &id, TERMINAL_CLOSED_EVENT, json!({})).await;
                        break;
                    }
                }
                _ = exit_check.tick(), if !exit_published => {
                    if let Some(exit_code) = exited_code(manager.get_session(&id).await.as_ref()) {
                        exit_published = true;
                        publish_lifecycle(&hub, &id, TERMINAL_EXIT_EVENT, json!({"exit_code":exit_code})).await;
                    }
                    continue;
                }
                _ = closed.changed() => break,
            }
            tokio::time::sleep(std::time::Duration::from_millis(75)).await;
            if *closed.borrow() {
                break;
            }
            let cursor = *rx.borrow_and_update();
            if hub
                .append(
                    format!("terminal-{id}"),
                    "terminal-output".into(),
                    json!({"terminal_id":id,"cursor":cursor}),
                )
                .await
                .is_err()
            {
                break;
            }
        }
    });
    serde_json::to_value(session).map_err(|e| e.to_string())
}

pub(crate) async fn write(args: &Value) -> Result<Value, String> {
    let request: WriteRequest = decode(args)?;
    if let Some(manager) = remote_session(&request.session_id).await {
        manager
            .write(&request.session_id, request.data.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    } else {
        api()?.write(request).await.map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}
pub(crate) async fn resize(args: &Value) -> Result<Value, String> {
    let request: ResizeRequest = decode(args)?;
    if let Some(manager) = remote_session(&request.session_id).await {
        manager
            .resize(&request.session_id, request.cols, request.rows)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        api()?.resize(request).await.map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}
pub(crate) async fn close(args: &Value) -> Result<Value, String> {
    let request: CloseSessionRequest = decode(args)?;
    if let Some(manager) = remote_session(&request.session_id).await {
        manager
            .close_session(&request.session_id)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        api()?
            .close_session(request)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}
pub(crate) async fn history(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let id = get_string(request, "sessionId")?;
    let after = request
        .get("afterOffset")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let limit = if request.get("afterOffset").is_some() {
        64 * 1024
    } else {
        usize::MAX
    };
    let page = if let Some(manager) = remote_session(&id).await {
        manager.replay_page(&id, after, limit).await
    } else {
        api()?
            .session_manager()
            .replay_page(&id, after, limit)
            .await
    }
    .ok_or("Terminal is unavailable")?;
    let mut result = serde_json::to_value(page).map_err(|e| e.to_string())?;
    result["sessionId"] = json!(id);
    Ok(result)
}
pub(crate) async fn list() -> Result<Value, String> {
    let mut sessions: Vec<Value> = api()?
        .list_sessions()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
    if let Some(state) = get_remote_workspace_manager() {
        if let Some(manager) = state.get_terminal_manager().await {
            sessions.extend(manager.list_sessions().await.into_iter().map(response));
        }
    }
    Ok(json!(sessions))
}

pub(crate) async fn get(args: &Value) -> Result<Value, String> {
    let id = get_string(request_value(args), "sessionId")?;
    if let Some(manager) = remote_session(&id).await {
        return manager
            .get_session(&id)
            .await
            .map(response)
            .ok_or("Terminal is unavailable".into());
    }
    serde_json::to_value(api()?.get_session(&id).await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub(crate) async fn shells() -> Result<Value, String> {
    serde_json::to_value(api()?.get_available_shells()).map_err(|e| e.to_string())
}

pub(crate) async fn signal(args: &Value) -> Result<Value, String> {
    let request: openbitfun_core::service::terminal::SignalRequest = decode(args)?;
    if let Some(manager) = remote_session(&request.session_id).await {
        let bytes: &[u8] = match request.signal.trim().to_ascii_uppercase().as_str() {
            "SIGINT" | "INT" => &[3],
            "SIGTSTP" | "TSTP" => &[26],
            _ => {
                return Err(
                    "Remote PTY supports INT and TSTP; close the terminal to end the session"
                        .into(),
                )
            }
        };
        manager
            .write(&request.session_id, bytes)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        api()?.signal(request).await.map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

pub(crate) async fn acknowledge(args: &Value) -> Result<Value, String> {
    let request: openbitfun_core::service::terminal::AcknowledgeRequest = decode(args)?;
    if remote_session(&request.session_id).await.is_none() {
        api()?
            .acknowledge_data(request)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

pub(crate) async fn has_shell_integration(args: &Value) -> Result<Value, String> {
    let id = get_string(request_value(args), "sessionId")?;
    if remote_session(&id).await.is_some() {
        return Ok(Value::Bool(false));
    }
    api()?.get_session(&id).await.map_err(|e| e.to_string())?;
    Ok(Value::Bool(api()?.has_shell_integration(&id).await))
}

pub(crate) async fn send_command(args: &Value) -> Result<Value, String> {
    let request: openbitfun_core::service::terminal::SendCommandRequest = decode(args)?;
    if let Some(manager) = remote_session(&request.session_id).await {
        manager
            .write(
                &request.session_id,
                format!("{}\n", request.command).as_bytes(),
            )
            .await
            .map_err(|e| e.to_string())?;
    } else {
        api()?
            .send_command(request)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

pub(crate) async fn shutdown_all() -> Result<Value, String> {
    let mut errors = Vec::new();
    if let Some(state) = get_remote_workspace_manager() {
        if let Some(manager) = state.get_terminal_manager().await {
            for session in manager.list_sessions().await {
                if let Err(error) = manager.close_session(&session.id).await {
                    errors.push(error.to_string());
                }
            }
        }
    }
    api()?.shutdown_all().await;
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(Value::Null)
}

pub(crate) async fn execute(args: &Value) -> Result<Value, String> {
    let request: openbitfun_core::service::terminal::ExecuteCommandRequest = decode(args)?;
    let result = if let Some(manager) = remote_session(&request.session_id).await {
        manager
            .execute(&request.session_id, &request.command, request.timeout_ms)
            .await
            .map_err(|e| e.to_string())?
    } else {
        api()?
            .execute_command(request)
            .await
            .map_err(|e| e.to_string())?
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::terminal::{SessionSource, ShellType};

    #[test]
    fn exit_is_reported_only_for_an_exited_session() {
        let mut session = TerminalSession::new(
            "t1".into(),
            "Shell".into(),
            ShellType::Bash,
            "/repo".into(),
            80,
            24,
            SessionSource::Manual,
        );
        assert_eq!(exited_code(None), None);
        assert_eq!(exited_code(Some(&session)), None);
        session.set_exited(Some(7));
        assert_eq!(exited_code(Some(&session)), Some(Some(7)));
        session.set_exited(None);
        assert_eq!(exited_code(Some(&session)), Some(None));
    }
}
