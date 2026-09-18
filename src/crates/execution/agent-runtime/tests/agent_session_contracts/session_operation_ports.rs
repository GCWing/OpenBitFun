use std::sync::{Arc, Mutex};

use openbitfun_agent_runtime::sdk::{
    AgentRuntimeBuilder, AgentSessionForkAtTurnRequest, AgentSessionForkPort,
    AgentSessionForkRequest, AgentSessionForkResult, AgentSessionUsagePort,
    AgentSessionUsageRequest, AgentSubmissionPort, AgentSubmissionRequest, AgentSubmissionResult,
    AgentTurnSettlementPort, AgentTurnSettlementRequest, AgentTurnSettlementResult,
    AgentTurnSettlementStatus, PortErrorKind, PortResult, SessionUsageReport,
};
use openbitfun_agent_runtime::sdk::{AgentSessionCreateRequest, AgentSessionCreateResult};

#[derive(Default)]
struct FakeSubmissionPort;

#[async_trait::async_trait]
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
struct RecordingSessionOperations {
    settlement_requests: Mutex<Vec<AgentTurnSettlementRequest>>,
}

#[async_trait::async_trait]
impl AgentSessionForkPort for RecordingSessionOperations {
    async fn fork_session(
        &self,
        request: AgentSessionForkRequest,
    ) -> PortResult<AgentSessionForkResult> {
        assert_eq!(request.workspace_path, "D:/workspace/project");
        assert_eq!(request.source_session_id, "session-1");
        assert_eq!(request.remote_connection_id, None);
        assert_eq!(request.remote_ssh_host, None);
        Ok(AgentSessionForkResult {
            session_id: "session-2".to_string(),
            session_name: "Main (fork)".to_string(),
            agent_type: "Standard".to_string(),
        })
    }

    async fn fork_session_at_turn(
        &self,
        request: AgentSessionForkAtTurnRequest,
    ) -> PortResult<AgentSessionForkResult> {
        assert_eq!(request.workspace_path, "D:/workspace/project");
        assert_eq!(request.source_session_id, "session-1");
        assert_eq!(request.source_turn_id, "turn-1");
        assert_eq!(request.remote_connection_id, None);
        assert_eq!(request.remote_ssh_host, None);
        Ok(AgentSessionForkResult {
            session_id: "session-2".to_string(),
            session_name: "Main (fork)".to_string(),
            agent_type: "Standard".to_string(),
        })
    }
}

#[async_trait::async_trait]
impl AgentSessionUsagePort for RecordingSessionOperations {
    async fn generate_session_usage(
        &self,
        request: AgentSessionUsageRequest,
    ) -> PortResult<SessionUsageReport> {
        Ok(SessionUsageReport::partial_unavailable(
            request.session_id,
            1_778_347_200_000,
        ))
    }
}

#[async_trait::async_trait]
impl AgentTurnSettlementPort for RecordingSessionOperations {
    async fn wait_for_turn_settlement(
        &self,
        request: AgentTurnSettlementRequest,
    ) -> PortResult<AgentTurnSettlementResult> {
        self.settlement_requests.lock().unwrap().push(request);
        Ok(AgentTurnSettlementResult {
            status: AgentTurnSettlementStatus::Completed,
            final_response: Some("authoritative response".to_string()),
            finish_reason: Some("complete".to_string()),
        })
    }
}

#[tokio::test]
async fn runtime_delegates_narrow_session_operations_to_registered_ports() {
    let operations = Arc::new(RecordingSessionOperations::default());
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSubmissionPort))
        .with_session_fork_port(operations.clone())
        .with_session_usage_port(operations.clone())
        .with_turn_settlement_port(operations.clone())
        .build()
        .expect("runtime");

    let fork = runtime
        .fork_session_at_turn(AgentSessionForkAtTurnRequest {
            workspace_id: None,
            workspace_path: "D:/workspace/project".to_string(),
            source_session_id: "session-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .expect("fork session");
    assert_eq!(fork.session_id, "session-2");

    let latest_turn_fork = runtime
        .fork_session(AgentSessionForkRequest {
            workspace_id: None,
            workspace_path: "D:/workspace/project".to_string(),
            source_session_id: "session-1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .expect("latest-turn fork session");
    assert_eq!(latest_turn_fork.session_id, "session-2");

    let report = runtime
        .generate_session_usage(AgentSessionUsageRequest {
            workspace_id: None,
            session_id: "session-1".to_string(),
            workspace_path: Some("D:/workspace/project".to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
            include_hidden_subagents: true,
        })
        .await
        .expect("generate usage");
    assert_eq!(report.session_id, "session-1");
    let settlement = runtime
        .wait_for_turn_settlement(AgentTurnSettlementRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            wait_timeout_ms: 5_000,
        })
        .await
        .expect("wait for turn settlement");

    assert_eq!(settlement.status, AgentTurnSettlementStatus::Completed);
    assert_eq!(
        settlement.final_response.as_deref(),
        Some("authoritative response")
    );
    assert_eq!(settlement.finish_reason.as_deref(), Some("complete"));
    assert_eq!(operations.settlement_requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn missing_new_ports_preserve_the_v1_runtime_error_shape() {
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(Arc::new(FakeSubmissionPort))
        .build()
        .expect("runtime");

    let error = runtime
        .wait_for_turn_settlement(AgentTurnSettlementRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            wait_timeout_ms: 5_000,
        })
        .await
        .expect_err("missing port must fail");

    assert!(matches!(
        error,
        openbitfun_agent_runtime::sdk::RuntimeError::Port(ref port_error)
            if port_error.kind == PortErrorKind::NotAvailable
    ));
}
