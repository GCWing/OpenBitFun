#[cfg(feature = "rpc")]
use agent_client_protocol::JsonRpcMessage;
use openbitfun_app_server_protocol::{
    agent::{RunResponse, SubmitDialogTurnMessage, SubmitDialogTurnRequest},
    config::GetAgentProfileConfigMessage,
    permission::RespondPermissionMessage,
    session::{RestoreSessionMessage, SessionProcessingPhase, SessionRuntimeState},
};
use serde_json::json;

#[test]
fn legacy_submit_dialog_contract_keeps_optional_policy() {
    let request: SubmitDialogTurnRequest = serde_json::from_value(json!({
        "sessionId": "session-1",
        "message": "hello",
        "agentType": "general"
    }))
    .expect("legacy dialog payload should accept a missing policy");
    let body = request.0;

    assert!(body.policy.is_none());
    assert!(body.attachments.is_empty());
    assert!(body.metadata.is_empty());
    assert_eq!(
        std::any::TypeId::of::<SubmitDialogTurnMessage>(),
        std::any::TypeId::of::<SubmitDialogTurnRequest>()
    );
}

#[cfg(feature = "rpc")]
#[test]
fn legacy_submit_dialog_method_stays_compatible() {
    assert!(SubmitDialogTurnMessage::matches_method(
        "agent/submitDialogTurn"
    ));
}

#[test]
fn legacy_restore_and_session_state_keep_their_wire_shape() {
    let request: RestoreSessionMessage = serde_json::from_value(json!({
        "workspacePath": "/workspace",
        "sessionId": "session-1"
    }))
    .expect("restore request should accept omitted includeInternal");
    assert!(!request.include_internal);

    let state = SessionRuntimeState::Processing {
        current_turn_id: "turn-1".to_string(),
        phase: SessionProcessingPhase::ToolCalling,
    };
    assert_eq!(
        serde_json::to_value(state).expect("state should serialize"),
        json!({
            "kind": "processing",
            "currentTurnId": "turn-1",
            "phase": "toolCalling"
        })
    );
}

#[test]
fn legacy_mixed_case_fields_and_response_defaults_remain_compatible() {
    let profile: GetAgentProfileConfigMessage = serde_json::from_value(json!({
        "agent_id": "general"
    }))
    .expect("legacy get-profile request should keep snake_case");
    assert_eq!(profile.agent_id, "general");

    let permission: RespondPermissionMessage = serde_json::from_value(json!({
        "request_id": "permission-1",
        "reply": { "reply": "once" }
    }))
    .expect("legacy permission request should keep snake_case");
    assert_eq!(permission.request_id, "permission-1");

    let response: RunResponse = serde_json::from_value(json!({
        "sessionId": "session-1",
        "turnId": "turn-1"
    }))
    .expect("accepted should default to false");
    assert!(!response.accepted);
    assert_eq!(
        serde_json::to_value(response).expect("response should serialize"),
        json!({
            "sessionId": "session-1",
            "turnId": "turn-1",
            "accepted": false
        })
    );
}

#[test]
fn legacy_compact_request_keeps_omitted_force_wire_shape() {
    use openbitfun_app_server_protocol::session::CompactSessionRequest;
    let legacy = json!({"sessionId": "session", "turnId": "turn"});
    let request: CompactSessionRequest = serde_json::from_value(legacy.clone()).unwrap();
    assert!(!request.0.force);
    assert_eq!(serde_json::to_value(request).unwrap(), legacy);
    let forced = json!({"sessionId": "session", "turnId": "turn", "force": true});
    let request: CompactSessionRequest = serde_json::from_value(forced.clone()).unwrap();
    assert!(request.0.force);
    assert_eq!(serde_json::to_value(request).unwrap(), forced);
}
