//! BTW (side question) API
//!
//! Desktop adapter for the core `/btw` feature.
//!
//! `/btw` runs as an ephemeral child session that reuses the parent session's
//! full context snapshot while still flowing through the normal agentic event
//! pipeline.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::api::app_state::AppState;

use openbitfun_core::agentic::coordination::{
    ConversationCoordinator, DialogSubmissionPolicy, DialogTriggerSource,
};
use openbitfun_core::agentic::image_analysis::ImageContextData;

fn desktop_btw_submission_policy() -> DialogSubmissionPolicy {
    DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskStreamRequest {
    pub request_id: String,
    pub session_id: String,
    pub question: String,
    pub child_session_id: String,
    pub child_session_name: Option<String>,
    pub parent_dialog_turn_id: Option<String>,
    pub parent_turn_index: Option<usize>,
    /// Optional model id override. Supports "fast"/"primary" aliases.
    pub model_id: Option<String>,
    #[serde(default)]
    pub image_contexts: Option<Vec<ImageContextData>>,
    /// Optional presentation metadata. The question remains readable by older hosts.
    #[serde(default)]
    pub user_message_metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub initial_model_selection: Option<openbitfun_runtime_ports::AgentSessionModelSelection>,
    /// Requires btw_model_pool_selection_v1; omitted means inherit the parent binding.
    #[serde(default)]
    pub initial_model_target: Option<openbitfun_runtime_ports::AgentSessionModelTargetSelection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskStreamResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwCancelRequest {
    pub request_id: String,
}

#[tauri::command]
pub async fn btw_cancel(
    state: State<'_, AppState>,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: BtwCancelRequest,
) -> Result<(), String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }

    state
        .side_question_runtime
        .cancel(&request.request_id)
        .await;
    if let Some(active_turn) = state
        .side_question_runtime
        .get_btw_turn(&request.request_id)
        .await
    {
        coordinator
            .cancel_dialog_turn(&active_turn.session_id, &active_turn.turn_id)
            .await
            .map_err(|e| e.to_string())?;
        state
            .side_question_runtime
            .remove(&request.request_id)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn btw_ask_stream(
    state: State<'_, AppState>,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: BtwAskStreamRequest,
) -> Result<BtwAskStreamResponse, String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }
    if request.session_id.trim().is_empty() {
        return Err("sessionId is required".to_string());
    }
    if request.question.trim().is_empty() {
        return Err("question is required".to_string());
    }
    let child_session_id = request.child_session_id.trim();
    if child_session_id.is_empty() {
        return Err("childSessionId is required".to_string());
    }
    let child_session_id = child_session_id.to_string();
    let child_session_name = request.child_session_name.clone();
    let model_id = request.model_id.clone();
    let image_contexts = request.image_contexts;

    let turn_id = coordinator
        .start_btw_turn(
            &request.request_id,
            &request.session_id,
            &child_session_id,
            child_session_name.as_deref(),
            &request.question,
            desktop_btw_submission_policy(),
            model_id.as_deref(),
            image_contexts,
            request.parent_dialog_turn_id.as_deref(),
            request.parent_turn_index,
            request.user_message_metadata,
            request.initial_model_selection,
            request.initial_model_target,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .side_question_runtime
        .register_btw_turn(
            request.request_id.clone(),
            child_session_id.clone(),
            turn_id.clone(),
        )
        .await;
    let runtime = state.side_question_runtime.clone();
    let request_id = request.request_id.clone();
    let coordinator = coordinator.inner().clone();
    tokio::spawn(async move {
        loop {
            let Some(session) = coordinator
                .get_session_manager()
                .get_session(&child_session_id)
            else {
                runtime.remove(&request_id).await;
                break;
            };

            match session.state {
                openbitfun_core::agentic::core::SessionState::Processing {
                    current_turn_id,
                    ..
                } if current_turn_id == turn_id => {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                _ => {
                    runtime.remove(&request_id).await;
                    break;
                }
            }
        }
    });

    Ok(BtwAskStreamResponse { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn btw_request_reads_legacy_payloads_and_round_trips_optional_metadata() {
        let legacy = serde_json::json!({
            "requestId": "request-1",
            "sessionId": "parent-1",
            "childSessionId": "child-1",
            "question": "A readable quote and question"
        });
        let request: BtwAskStreamRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert!(request.user_message_metadata.is_none());
        assert!(request.initial_model_selection.is_none());
        assert!(request.initial_model_target.is_none());
        let round_trip: BtwAskStreamRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(round_trip.question, legacy["question"]);

        let metadata = serde_json::json!({
            "composerPresentation": { "version": 1, "segments": [] },
            "sessionReferences": [{ "sessionId": "reference-1" }],
            "permission_mode": "default"
        });
        let mut current = legacy;
        current["userMessageMetadata"] = metadata.clone();
        current["initialModelSelection"] = serde_json::json!({
            "modelId": "primary", "reasoningPreset": "high"
        });
        current["futureField"] = serde_json::json!(true);
        let request: BtwAskStreamRequest = serde_json::from_value(current).unwrap();
        let round_trip: BtwAskStreamRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(round_trip.user_message_metadata, Some(metadata));
        assert_eq!(
            round_trip
                .initial_model_selection
                .unwrap()
                .reasoning_preset
                .as_deref(),
            Some("high")
        );
        let auto: openbitfun_runtime_ports::AgentSessionModelSelection =
            serde_json::from_value(serde_json::json!({ "modelId": "primary" })).unwrap();
        assert!(auto.reasoning_preset.is_none());
    }

    #[test]
    fn btw_request_round_trips_typed_pool_and_model_choices() {
        for target in [
            serde_json::json!({ "selection": { "kind": "pool", "pool_id": "pool-a" } }),
            serde_json::json!({ "selection": { "kind": "model", "model_ref": "model-b" }, "reasoningPreset": "high" }),
        ] {
            let request: BtwAskStreamRequest = serde_json::from_value(serde_json::json!({
                "requestId": "request-1", "sessionId": "parent", "childSessionId": "child",
                "question": "Why?", "initialModelTarget": target,
            }))
            .unwrap();
            assert!(request.model_id.is_none());
            assert!(request.initial_model_selection.is_none());
            assert_eq!(
                serde_json::to_value(request).unwrap()["initialModelTarget"],
                target
            );
        }
    }

    #[test]
    fn btw_turns_use_the_desktop_chat_output_surface() {
        assert_eq!(
            desktop_btw_submission_policy(),
            DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi)
        );
    }
}
