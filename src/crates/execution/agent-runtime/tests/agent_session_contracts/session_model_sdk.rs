use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::{
    AgentRuntimeBuilder, AgentSessionCreateRequest, AgentSessionCreateResult,
    AgentSessionModelPort, AgentSessionModelSelection, AgentSessionModelSelectionUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSubmissionPort, AgentSubmissionRequest,
    AgentSubmissionResult, PortError, PortResult, RuntimeError,
};
use openbitfun_runtime_ports::PortErrorKind;

#[derive(Default)]
struct FakeSubmissionPort;

#[async_trait]
impl AgentSubmissionPort for FakeSubmissionPort {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        Ok(AgentSessionCreateResult::new(
            "session-1",
            request.session_name,
            request.agent_type,
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        Ok(AgentSubmissionResult {
            turn_id: request.turn_id.unwrap_or_else(|| "turn-1".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, _session_id: &str) -> PortResult<Option<String>> {
        Ok(Some("Standard".to_string()))
    }
}

#[derive(Default)]
struct RecordingSessionModelPort {
    requests: Mutex<Vec<AgentSessionModelUpdateRequest>>,
    selection_requests: Mutex<Vec<AgentSessionModelSelectionUpdateRequest>>,
}

#[async_trait]
impl AgentSessionModelPort for RecordingSessionModelPort {
    async fn update_session_model(
        &self,
        request: AgentSessionModelUpdateRequest,
    ) -> PortResult<()> {
        self.requests.lock().unwrap().push(request);
        Ok(())
    }

    async fn update_session_model_selection(
        &self,
        request: AgentSessionModelSelectionUpdateRequest,
    ) -> PortResult<()> {
        self.selection_requests.lock().unwrap().push(request);
        Ok(())
    }
}

#[tokio::test]
async fn session_model_update_forwards_the_exact_typed_request() {
    let model_port = Arc::new(RecordingSessionModelPort::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSubmissionPort))
        .with_session_model_port(model_port.clone())
        .build()
        .expect("runtime");
    let request = AgentSessionModelUpdateRequest {
        session_id: "session-1".to_string(),
        model_id: "provider/model".to_string(),
    };

    runtime
        .update_session_model(request.clone())
        .await
        .expect("model update");

    assert_eq!(model_port.requests.lock().unwrap().as_slice(), &[request]);
}

#[tokio::test]
async fn session_model_update_reports_a_missing_port_without_fallback() {
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSubmissionPort))
        .build()
        .expect("runtime");

    let error = runtime
        .update_session_model(AgentSessionModelUpdateRequest {
            session_id: "session-1".to_string(),
            model_id: "provider/model".to_string(),
        })
        .await
        .expect_err("a missing model port must not silently fall back");

    assert_eq!(
        error,
        RuntimeError::Port(PortError::new(
            PortErrorKind::NotAvailable,
            "agent session model port is not registered",
        ))
    );
}

#[tokio::test]
async fn session_model_selection_forwards_model_and_reasoning_preset_atomically() {
    let model_port = Arc::new(RecordingSessionModelPort::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSubmissionPort))
        .with_session_model_port(model_port.clone())
        .build()
        .expect("runtime");
    let request = AgentSessionModelSelectionUpdateRequest {
        session_id: "session-1".to_string(),
        selection: AgentSessionModelSelection {
            model_id: "provider/model".to_string(),
            reasoning_preset: Some("high".to_string()),
            routing_mode: None,
        },
    };

    runtime
        .update_session_model_selection(request.clone())
        .await
        .expect("model selection update");

    assert_eq!(
        model_port.selection_requests.lock().unwrap().as_slice(),
        &[request]
    );
}
