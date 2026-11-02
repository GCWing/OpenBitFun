//! `/btw` side-question HostInvoke handlers.
//!
//! The turn runs on the Core coordinator as a child session and flows through
//! the normal agentic event pipeline, so a controller observes it exactly like
//! a side question on a Desktop host. Peer ownership follows the dialog turn
//! contract: it is registered before submission and released if that fails.

use std::future::Future;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use openbitfun_core::agentic::coordination::{
    btw_turn_id, get_global_coordinator, ConversationCoordinator, DialogSubmissionPolicy,
    DialogTriggerSource,
};
use openbitfun_core::agentic::core::SessionState;
use openbitfun_core::agentic::image_analysis::ImageContextData;
use openbitfun_core::agentic::side_question::SideQuestionRuntime;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, request_value};
use crate::peer_host::state::{PeerHostState, PeerTurnKey, PeerTurnTracker};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtwAskStreamRequest {
    request_id: String,
    session_id: String,
    question: String,
    child_session_id: String,
    child_session_name: Option<String>,
    parent_dialog_turn_id: Option<String>,
    parent_turn_index: Option<usize>,
    model_id: Option<String>,
    #[serde(default)]
    image_contexts: Option<Vec<ImageContextData>>,
    #[serde(default)]
    initial_model_selection: Option<openbitfun_runtime_ports::AgentSessionModelSelection>,
    #[serde(default)]
    initial_model_target: Option<openbitfun_runtime_ports::AgentSessionModelTargetSelection>,
}

fn side_questions() -> &'static Arc<SideQuestionRuntime> {
    static RUNTIME: OnceLock<Arc<SideQuestionRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Arc::new(SideQuestionRuntime::new()))
}

fn coordinator() -> Result<Arc<ConversationCoordinator>, String> {
    get_global_coordinator()
        .ok_or_else(|| "Side questions are unavailable: the agent runtime is not running".into())
}

fn parse_ask_request(request: &Value) -> Result<BtwAskStreamRequest, String> {
    let parsed: BtwAskStreamRequest = serde_json::from_value(request.clone())
        .map_err(|error| format!("Invalid side question request: {error}"))?;
    for (value, name) in [
        (&parsed.request_id, "requestId"),
        (&parsed.session_id, "sessionId"),
        (&parsed.child_session_id, "childSessionId"),
        (&parsed.question, "question"),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{name} is required"));
        }
    }
    Ok(parsed)
}

/// Own the turn for the duration of `start`, returning the stream generation it
/// was admitted under. A failed start releases the turn: it will never emit the
/// terminal event that would otherwise release it.
async fn start_owned_turn<F, Fut>(
    turns: &PeerTurnTracker,
    turn: &PeerTurnKey,
    start: F,
) -> Result<u64, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let generation = turns.register_root(turn.clone())?;
    if !turns.is_event_stream_generation_current(generation) {
        turns.finish_turn(turn);
        return Err("Peer event stream continuity was lost before side question start".to_string());
    }
    if let Err(error) = start().await {
        turns.finish_turn(turn);
        return Err(error);
    }
    Ok(generation)
}

pub(crate) async fn btw_ask_stream(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let raw = request_value(args);
    let request = parse_ask_request(raw)?;
    // Same reserved-key policy as a Peer dialog turn: routing metadata belongs
    // to this host and a controller's copy of it is dropped.
    let metadata = match raw.get("userMessageMetadata") {
        None | Some(Value::Null) => None,
        Some(_) => Some(Value::Object(super::dialog::peer_dialog_metadata(raw)?)),
    };
    let coordinator = coordinator()?;
    let child_session_id = request.child_session_id.trim().to_string();
    let turn_id = btw_turn_id(&request.request_id);
    let turn = PeerTurnKey::new(child_session_id.clone(), turn_id.clone());
    let submit = coordinator.clone();
    let child = child_session_id.clone();
    let request_id = request.request_id.clone();
    let parent_session_id = request.session_id.clone();
    let generation = start_owned_turn(&state.turns, &turn, || async move {
        submit
            .start_btw_turn(
                &request_id,
                &parent_session_id,
                &child,
                request.child_session_name.as_deref(),
                &request.question,
                DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
                request.model_id.as_deref(),
                request.image_contexts,
                request.parent_dialog_turn_id.as_deref(),
                request.parent_turn_index,
                metadata,
                request.initial_model_selection,
                request.initial_model_target,
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await?;
    if !state.turns.is_event_stream_generation_current(generation) {
        coordinator
            .cancel_dialog_turn(&child_session_id, &turn_id)
            .await
            .map_err(|error| {
                format!(
                    "Peer continuity was lost after side question start and cancellation could not be confirmed: session_id={child_session_id}, turn_id={turn_id}, error={error}"
                )
            })?;
        return Err("Peer event stream lost continuity while starting the side question".into());
    }

    let runtime = side_questions().clone();
    let request_id = request.request_id;
    runtime
        .register_btw_turn(
            request_id.clone(),
            child_session_id.clone(),
            turn_id.clone(),
        )
        .await;
    tokio::spawn(async move {
        // The registration only serves cancellation; release it once the turn settles.
        loop {
            let processing = coordinator
                .get_session_manager()
                .get_session(&child_session_id)
                .is_some_and(|session| {
                    matches!(
                        session.state,
                        SessionState::Processing { current_turn_id, .. }
                            if current_turn_id == turn_id
                    )
                });
            if !processing {
                runtime.remove(&request_id).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
    Ok(json!({ "ok": true }))
}

pub(crate) async fn btw_cancel(args: &Value) -> Result<Value, String> {
    let request_id = get_string(request_value(args), "requestId")?;
    if request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }
    let runtime = side_questions();
    runtime.cancel(&request_id).await;
    if let Some(active) = runtime.get_btw_turn(&request_id).await {
        coordinator()?
            .cancel_dialog_turn(&active.session_id, &active.turn_id)
            .await
            .map_err(|error| error.to_string())?;
        runtime.remove(&request_id).await;
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn() -> PeerTurnKey {
        PeerTurnKey::new("child-1", btw_turn_id("request-1"))
    }

    #[test]
    fn the_registered_turn_id_is_the_one_the_coordinator_assigns() {
        assert_eq!(btw_turn_id(" request-1 "), "btw-turn-request-1");
    }

    #[tokio::test]
    async fn a_started_turn_stays_owned_until_its_terminal_event() {
        let turns = PeerTurnTracker::new();
        turns.mark_event_stream_ready();
        start_owned_turn(&turns, &turn(), || async { Ok(()) })
            .await
            .unwrap();
        assert!(turns.owns("child-1", Some(&turn().turn_id)));
    }

    #[tokio::test]
    async fn the_turn_is_owned_while_it_starts_and_released_when_that_fails() {
        let turns = PeerTurnTracker::new();
        turns.mark_event_stream_ready();
        let observer = turns.clone();
        let error = start_owned_turn(&turns, &turn(), || async move {
            assert!(observer.owns("child-1", Some(&turn().turn_id)));
            Err("model unavailable".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(error, "model unavailable");
        assert!(!turns.owns("child-1", Some(&turn().turn_id)));
    }

    #[tokio::test]
    async fn a_turn_cannot_start_before_the_event_stream_is_ready() {
        let turns = PeerTurnTracker::new();
        let result = start_owned_turn(&turns, &turn(), || async {
            panic!("must not start an unobservable turn")
        })
        .await;
        assert!(result.is_err());
        assert!(!turns.owns("child-1", Some(&turn().turn_id)));
    }

    #[test]
    fn ask_request_reads_legacy_payloads_and_ignores_future_fields() {
        let request = parse_ask_request(&json!({
            "requestId": "request-1",
            "sessionId": "parent-1",
            "childSessionId": "child-1",
            "question": "Why?",
            "futureField": true,
        }))
        .unwrap();
        assert!(request.initial_model_selection.is_none());
        assert!(request.initial_model_target.is_none());
        assert!(request.image_contexts.is_none());
    }

    #[test]
    fn ask_request_accepts_typed_model_targets() {
        let request = parse_ask_request(&json!({
            "requestId": "request-1",
            "sessionId": "parent-1",
            "childSessionId": "child-1",
            "question": "Why?",
            "initialModelTarget": { "selection": { "kind": "pool", "pool_id": "pool-a" } },
        }))
        .unwrap();
        assert!(request.initial_model_target.is_some());
    }

    #[test]
    fn ask_request_rejects_blank_identity_fields() {
        for field in ["requestId", "sessionId", "childSessionId", "question"] {
            let mut payload = json!({
                "requestId": "request-1",
                "sessionId": "parent-1",
                "childSessionId": "child-1",
                "question": "Why?",
            });
            payload[field] = json!("  ");
            let error = parse_ask_request(&payload).unwrap_err();
            assert_eq!(error, format!("{field} is required"));
        }
    }

    #[tokio::test]
    async fn cancel_of_an_unknown_request_is_a_no_op() {
        assert_eq!(
            btw_cancel(&json!({ "request": { "requestId": "unknown-request" } }))
                .await
                .unwrap(),
            Value::Null
        );
    }
}
