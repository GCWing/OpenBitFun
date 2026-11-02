use openbitfun_runtime_ports::{
    PtcExecutionRequest, PtcExecutionResponse, PtcNestedToolCall, PtcRuntimeAvailability,
    PtcToolBinding,
};
use serde_json::json;

#[test]
fn ptc_execution_wire_shape_is_additive_and_lossless_for_json_values() {
    let request = PtcExecutionRequest {
        operation_id: "op-1".to_string(),
        source: "return await tools.Read({ path: 'x' });".to_string(),
        bindings: vec![PtcToolBinding {
            name: "Read".to_string(),
        }],
        working_directory: "/workspace".to_string(),
        session_id: Some("session-1".to_string()),
        timeout_ms: Some(1000),
        max_output_bytes: Some(1024),
    };
    let encoded = serde_json::to_value(&request).expect("request serializes");
    let restored: PtcExecutionRequest = serde_json::from_value(encoded).expect("request restores");
    assert_eq!(restored, request);

    let response = PtcExecutionResponse {
        value: json!({"unicode": "中文", "nested": [true, null]}),
        logs: vec!["done".to_string()],
    };
    assert_eq!(
        serde_json::from_value::<PtcExecutionResponse>(
            serde_json::to_value(response.clone()).unwrap()
        )
        .unwrap(),
        response
    );
}

#[test]
fn ptc_nested_call_and_availability_have_stable_wire_names() {
    let call = PtcNestedToolCall {
        operation_id: "nested-1".to_string(),
        tool_name: "Read".to_string(),
        arguments: json!({"path": "README.md"}),
    };
    let value = serde_json::to_value(call).expect("nested call serializes");
    assert_eq!(value["operationId"], "nested-1");
    assert_eq!(value["toolName"], "Read");
    assert_eq!(
        serde_json::to_value(PtcRuntimeAvailability::Unavailable {
            reason: "missing node".to_string()
        })
        .unwrap()["state"],
        "unavailable"
    );
}
