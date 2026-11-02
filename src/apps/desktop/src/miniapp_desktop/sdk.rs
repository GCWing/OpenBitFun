//! Closed SDK dispatch. Shell requests cannot invoke arbitrary Desktop commands.
use super::*;
use crate::api::{miniapp_agent_api as agent, miniapp_export_api};

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
fn encode(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

pub(crate) async fn call(
    app: &tauri::AppHandle,
    instance: &MiniAppInstance,
    view_id: &str,
    method: String,
    mut params: Value,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let miniapp = state
        .miniapp_manager
        .get(&instance.app_id)
        .await
        .map_err(|e| e.to_string())?;
    let strict = state
        .miniapp_manager
        .uses_market_strict_runtime(&instance.app_id)
        .await;
    let object = params
        .as_object_mut()
        .ok_or("MiniApp SDK params must be an object")?;
    // Identity and execution context always come from the authenticated instance.
    object.insert("appId".into(), json!(instance.app_id));
    object.insert("workspacePath".into(), json!(instance.workspace_path));
    let host = app.state::<DesktopMiniApps>();
    let result = match method.as_str() {
        "worker.call" => {
            let inner_method = string(&params, "method")?;
            let inner_params = params.get("params").cloned().unwrap_or(json!({}));
            if miniapp
                .permissions
                .node
                .as_ref()
                .is_some_and(|node| !node.enabled)
                || strict
            {
                match inner_method.as_str() {
                    "storage.get" => {
                        miniapp_api::get_miniapp_storage(
                            state,
                            instance.app_id.clone(),
                            string(&inner_params, "key")?,
                        )
                        .await
                    }
                    "storage.set" => {
                        miniapp_api::set_miniapp_storage(
                            state,
                            instance.app_id.clone(),
                            string(&inner_params, "key")?,
                            inner_params.get("value").cloned().unwrap_or(Value::Null),
                        )
                        .await?;
                        Ok(Value::Null)
                    }
                    _ => {
                        miniapp_api::miniapp_host_call(
                            state,
                            miniapp_api::MiniAppHostCallRequest {
                                app_id: instance.app_id.clone(),
                                method: inner_method,
                                params: inner_params,
                                workspace_path: instance.workspace_path.clone(),
                            },
                        )
                        .await
                    }
                }
            } else {
                miniapp_api::miniapp_worker_call(
                    state,
                    miniapp_api::MiniAppWorkerCallRequest {
                        app_id: instance.app_id.clone(),
                        method: inner_method,
                        params: inner_params,
                        workspace_path: instance.workspace_path.clone(),
                    },
                )
                .await
            }
        }
        "ai.complete" => encode(miniapp_api::miniapp_ai_complete(state, decode(params)?).await?),
        "ai.getModels" => {
            encode(miniapp_api::miniapp_ai_list_models(state, decode(params)?).await?)
        }
        "ai.chat" => {
            let stream_id = string(&params, "streamId")?;
            // Namespace the stream to this instance, so cancellation cannot reach another app.
            params["streamId"] = json!(format!("{}:{}", instance.instance_id, stream_id));
            if let Some(lease) = host
                .shells
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get_mut(view_id)
            {
                lease
                    .streams
                    .insert(params["streamId"].as_str().unwrap().into());
            }
            miniapp_api::miniapp_ai_chat(app.clone(), state, decode(params)?).await?;
            Ok(json!({"streamId":stream_id}))
        }
        "ai.cancel" => {
            let stream_id = string(&params, "streamId")?;
            params["streamId"] = json!(format!("{}:{}", instance.instance_id, stream_id));
            miniapp_api::miniapp_ai_cancel(state, decode(params)?).await?;
            Ok(Value::Null)
        }
        "agent.ensureSession" => {
            if params.get("appDataWorkspace").is_none() {
                params["appDataWorkspace"] = json!("");
            }
            let result =
                agent::miniapp_agent_ensure_session(state, app.state(), decode(params)?).await?;
            host.sessions.lock().unwrap_or_else(|p| p.into_inner())
                .entry(instance.instance_id.clone()).or_default().insert(result.session_id.clone());
            encode(result)
        }
        "agent.run" => {
            if strict {
                let session_id = string(&params, "sessionId")?;
                if !host
                    .sessions
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&instance.instance_id)
                    .is_some_and(|sessions| sessions.contains(&session_id))
                {
                    return Err("Marketplace MiniApps must call agent.ensureSession first".into());
                }
            }
            let result =
                agent::miniapp_agent_run(state, app.state(), app.state(), decode(params)?).await?;
            host.sessions.lock().unwrap_or_else(|p| p.into_inner())
                .entry(instance.instance_id.clone()).or_default().insert(result.session_id.clone());
            encode(result)
        }
        "agent.cancel" => {
            agent::miniapp_agent_cancel(state, app.state(), decode(params)?).await?;
            Ok(Value::Null)
        }
        "agent.turnText" => {
            encode(agent::miniapp_agent_turn_text(state, app.state(), decode(params)?).await?)
        }
        // Reloading a view does not revoke accepted work. Explicit cancellation
        // remains available by the session/turn identity owned by the application.
        "agent.cancelStaleRuns" => Err("This instance survives view reloads. Cancel a specific Agent turn, or stop the instance explicitly in OpenBitFun.".into()),
        "deck.renderPage" => {
            if strict
                && !miniapp
                    .permissions
                    .host
                    .as_ref()
                    .is_some_and(|p| p.deck_render)
            {
                return Err("MiniApp lacks host.deck_render permission".into());
            }
            encode(
                miniapp_export_api::miniapp_render_slide_page(app.clone(), decode(params)?).await?,
            )
        }
        "authorizeLocal" => {
            let action = string(&params, "action")?;
            let permissions = miniapp.permissions.host.as_ref();
            let granted = match action.as_str() {
                "dialog.open" | "dialog.save" | "dialog.message" => {
                    !strict || permissions.is_some_and(|p| p.dialog)
                }
                "clipboard.readText" => !strict || permissions.is_some_and(|p| p.clipboard_read),
                "clipboard.writeText" => !strict || permissions.is_some_and(|p| p.clipboard_write),
                "system.openExternal" => !strict || permissions.is_some_and(|p| p.open_external),
                "system.revealInFolder" => {
                    !strict || permissions.is_some_and(|p| p.reveal_in_folder)
                }
                "notifications.system" => miniapp
                    .permissions
                    .notifications
                    .as_ref()
                    .is_some_and(|p| p.system),
                "chat.claimComposer" | "chat.focusSession" => {
                    super::chat::chat_allowed(&miniapp.permissions, strict)
                }
                _ => false,
            };
            if action == "chat.focusSession" {
                let session_id = string(&params, "sessionId")?;
                super::chat::require_session(&host, &instance.instance_id, &session_id)?;
            }
            if !granted {
                return Err(format!("MiniApp lacks permission for {action}"));
            }
            Ok(Value::Null)
        }
        "grantSelectedPath" => {
            miniapp_api::grant_miniapp_path(
                state,
                instance.app_id.clone(),
                string(&params, "path")?,
            )
            .await?;
            Ok(Value::Null)
        }
        _ => Err(format!(
            "MiniApp SDK method is unsupported in an independent window: {method}"
        )),
    };
    result
}

pub(crate) fn install_events(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen("miniapp://ai-stream", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let Some(stream) = payload["streamId"].as_str() else {
            return;
        };
        let host = handle.state::<DesktopMiniApps>();
        for lease in host
            .shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values_mut()
        {
            if lease.streams.contains(stream) {
                let mut payload = payload.clone();
                payload["streamId"] =
                    json!(stream.split_once(':').map(|(_, id)| id).unwrap_or(stream));
                lease.push("ai:stream", payload);
            }
        }
    });
    for event_name in [
        "dialog-turn-started",
        "model-round-started",
        "model-round-completed",
        "text-chunk",
        "tool-event",
        "dialog-turn-completed",
        "dialog-turn-failed",
        "dialog-turn-cancelled",
        "token-usage-updated",
        "subagent-session-linked",
    ] {
        let handle = app.clone();
        app.listen(format!("agentic://{event_name}"), move |event| {
            let Ok(mut payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let Some(session) = payload["sessionId"].as_str().map(str::to_owned) else {
                return;
            };
            let parent = payload["parentSessionId"].as_str().map(str::to_owned);
            payload["sourceEvent"] = json!(event_name);
            let host = handle.state::<DesktopMiniApps>();
            let mut owners = host.sessions.lock().unwrap_or_else(|p| p.into_inner());
            for lease in host
                .shells
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values_mut()
            {
                let sessions = owners.entry(lease.instance_id.clone()).or_default();
                if sessions.contains(&session)
                    || (event_name == "subagent-session-linked"
                        && parent
                            .as_ref()
                            .is_some_and(|parent| sessions.contains(parent)))
                {
                    sessions.insert(session.clone());
                    lease.push("agent:event", payload.clone());
                }
            }
        });
    }
}

pub(crate) fn install_worker_events(app: &tauri::AppHandle, app_id: &str) {
    let handle = app.clone();
    let app_id = app_id.to_string();
    for name in [
        "miniapp-updated",
        "miniapp-recompiled",
        "miniapp-rolled-back",
    ] {
        let handle = app.clone();
        let id = app_id.clone();
        app.listen(name, move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            if payload["id"].as_str() != Some(id.as_str()) {
                return;
            }
            let host = handle.state::<DesktopMiniApps>();
            let instances = host.instances.snapshot();
            for lease in host
                .shells
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values_mut()
            {
                if instances.instances.iter().any(|instance| {
                    instance.instance_id == lease.instance_id && instance.app_id == id
                }) {
                    lease.push("reload", Value::Null);
                }
            }
        });
    }
    app.listen(format!("miniapp://worker-event:{app_id}"), move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let host = handle.state::<DesktopMiniApps>();
        let instances = host.instances.snapshot();
        for lease in host
            .shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values_mut()
        {
            if instances.instances.iter().any(|instance| {
                instance.instance_id == lease.instance_id && instance.app_id == app_id
            }) {
                lease.push(
                    "worker:event",
                    json!({"event":payload["event"],"data":payload["data"]}),
                );
            }
        }
    });
}
