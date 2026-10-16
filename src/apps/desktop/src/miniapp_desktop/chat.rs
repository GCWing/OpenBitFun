//! Read-only, instance-scoped chat projection for the lightweight Shell.
use super::*;
use crate::runtime::{DesktopRuntimeContext, DesktopSessionScopeRequest};
use openbitfun_core::agentic::coordination::ConversationCoordinator;
use openbitfun_core::miniapp::MiniAppPermissions;
use openbitfun_core::service::session::{DialogTurnData, TurnStatus};

pub(super) fn chat_allowed(permissions: &MiniAppPermissions, strict: bool) -> bool {
    permissions.agent.as_ref().is_some_and(|p| p.enabled)
        && (!strict || permissions.host.as_ref().is_some_and(|p| p.chat_composer))
}

pub(super) fn require_session(
    host: &DesktopMiniApps,
    instance_id: &str,
    session_id: &str,
) -> Result<(), String> {
    if !host
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(instance_id)
        .is_some_and(|sessions| sessions.contains(session_id))
    {
        return Err("MiniApp cannot access a session it does not own".into());
    }
    Ok(())
}

fn project_turn(turn: DialogTurnData) -> Value {
    let status = match turn.status {
        TurnStatus::InProgress => "running",
        TurnStatus::Completed => "completed",
        TurnStatus::Error => "failed",
        TurnStatus::Cancelled => "cancelled",
    };
    let rounds: Vec<_> = turn.model_rounds.into_iter().map(|round| {
        json!({"id":round.id,"text":round.text_items.into_iter().map(|item| item.content).collect::<Vec<_>>().join("\n\n")})
    }).collect();
    json!({"id":turn.turn_id,"user":turn.user_message.content,"rounds":rounds,"status":status,"error":turn.error})
}

pub(super) async fn snapshot(
    app: &tauri::AppHandle,
    instance: &MiniAppInstance,
    session_id: &str,
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
    if !chat_allowed(&miniapp.permissions, strict) {
        return Err("MiniApp lacks permission for chat history".into());
    }
    require_session(
        &app.state::<DesktopMiniApps>(),
        &instance.instance_id,
        session_id,
    )?;
    // ensureSession/agent.run already restored and validated this session. The
    // controller never supplies its filesystem path or another workspace ID.
    let coordinator = app.state::<Arc<ConversationCoordinator>>();
    let session = coordinator
        .get_session_manager()
        .get_session(session_id)
        .ok_or("MiniApp session is unavailable; rebind it through agent.ensureSession")?;
    let workspace_id = session
        .config
        .workspace_id
        .ok_or("MiniApp session has no owning workspace identity")?;
    let runtime = app.state::<DesktopRuntimeContext>();
    let restored = runtime
        .session_application()
        .restore_session_view(
            DesktopSessionScopeRequest {
                workspace_id: Some(workspace_id),
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
            session_id,
            true,
            Some(16),
            |_| {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let is_partial = restored.turns.len() < restored.total_turn_count;
    let turns: Vec<_> = restored
        .turns
        .into_iter()
        .filter(|turn| turn.kind.is_transcript_visible())
        .map(project_turn)
        .collect();
    let runtime = restored.runtime_event_snapshot.map(|snapshot| {
        let events: Vec<_> = snapshot.events.into_iter()
            .filter_map(openbitfun_events::project_agentic_frontend_event)
            .filter_map(|event| {
                let name = event.event_name.strip_prefix("agentic://")?;
                if !matches!(name, "dialog-turn-started" | "model-round-started" | "text-chunk"
                    | "tool-event" | "dialog-turn-completed" | "dialog-turn-failed" | "dialog-turn-cancelled") {
                    return None;
                }
                // Keep full tool arguments/results and other host internals out
                // of this compact presentation response.
                let mut payload = serde_json::Map::new();
                for key in ["sessionId", "turnId", "roundId", "attemptId", "text", "userInput", "originalUserInput", "success", "error", "message"] {
                    if let Some(value) = event.payload.get(key) { payload.insert(key.into(), value.clone()); }
                }
                payload.insert("sourceEvent".into(), json!(name));
                Some(Value::Object(payload))
            }).collect();
        json!({"streamId":snapshot.stream_id,"cursor":snapshot.cursor,"activeTurnId":snapshot.active_turn_id,"events":events})
    });
    Ok(json!({"sessionId":session_id,"turns":turns,"isPartial":is_partial,"runtime":runtime}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_permissions_keep_legacy_builtins_and_default_deny_market_apps() {
        let legacy: MiniAppPermissions =
            serde_json::from_value(json!({"agent":{"enabled":true}})).unwrap();
        assert!(chat_allowed(&legacy, false));
        assert!(!chat_allowed(&legacy, true));
        let market: MiniAppPermissions =
            serde_json::from_value(json!({"agent":{"enabled":true},"host":{"chat_composer":true}}))
                .unwrap();
        assert!(chat_allowed(&market, true));
        assert!(!chat_allowed(&MiniAppPermissions::default(), false));
    }

    #[test]
    fn session_scope_cannot_cross_instances_even_for_the_same_app() {
        let host = DesktopMiniApps::default();
        host.sessions
            .lock()
            .unwrap()
            .insert("first".into(), HashSet::from(["owned".into()]));
        assert!(require_session(&host, "first", "owned").is_ok());
        assert!(require_session(&host, "second", "owned").is_err());
        assert!(require_session(&host, "first", "other").is_err());
    }

    #[test]
    fn legacy_turn_projects_messages_without_tool_payloads() {
        let legacy = json!({
            "turn_id":"turn", "turn_index":0, "session_id":"session", "timestamp":1,
            "user_message":{"id":"user","content":"Make a slide","timestamp":1},
            "model_rounds":[{"id":"round","turn_id":"turn","round_index":0,"timestamp":1,"start_time":1,"status":"completed",
                "text_items":[{"id":"text","content":"Done","is_streaming":false,"timestamp":1}],
                "tool_items":[],"thinking_items":[]}], "start_time":1,"status":"completed"
        });
        let turn: DialogTurnData = serde_json::from_value(legacy).unwrap();
        let result = project_turn(turn);
        assert_eq!(result["user"], "Make a slide");
        assert_eq!(result["rounds"][0]["text"], "Done");
        assert_eq!(result["status"], "completed");
        assert!(result.get("modelRounds").is_none());
    }
}
