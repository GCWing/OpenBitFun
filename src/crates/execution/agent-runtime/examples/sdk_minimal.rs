use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::{
    AgentEventStream, AgentRunRequest, AgentRuntimeBuilder, AgentRuntimeSdkCompatibility,
    AgentSessionCreateRequest, AgentSessionCreateResult, AgentSubmissionPort,
    AgentSubmissionRequest, AgentSubmissionResult, AgentSubmissionSource, PortResult,
    RuntimeEventEnvelope, RuntimeEventType, SessionSelector,
};

#[derive(Debug, Default)]
struct ExampleAgentProvider {
    created_sessions: Mutex<Vec<AgentSessionCreateRequest>>,
    submitted_turns: Mutex<Vec<AgentSubmissionRequest>>,
}

#[async_trait]
impl AgentSubmissionPort for ExampleAgentProvider {
    async fn create_session(
        &self,
        request: AgentSessionCreateRequest,
    ) -> PortResult<AgentSessionCreateResult> {
        self.created_sessions.lock().unwrap().push(request.clone());
        Ok(AgentSessionCreateResult::new(
            "example-session",
            request.session_name,
            request.agent_type,
        ))
    }

    async fn submit_message(
        &self,
        request: AgentSubmissionRequest,
    ) -> PortResult<AgentSubmissionResult> {
        self.submitted_turns.lock().unwrap().push(request.clone());
        Ok(AgentSubmissionResult {
            turn_id: request
                .turn_id
                .unwrap_or_else(|| "example-turn".to_string()),
            accepted: true,
        })
    }

    async fn resolve_session_agent_type(&self, _session_id: &str) -> PortResult<Option<String>> {
        Ok(Some("Standard".to_string()))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let compatibility = AgentRuntimeSdkCompatibility::current();
    assert_eq!(compatibility.api_version, 11);

    let provider = Arc::new(ExampleAgentProvider::default());
    let events = AgentEventStream::new();
    let runtime = AgentRuntimeBuilder::new()
        .with_submission_port(provider)
        .with_event_stream(events.clone())
        .build()?;

    let handle = runtime
        .run(
            AgentRunRequest::new(
                SessionSelector::create("Example SDK Session", "Standard", None),
                "hello from an SDK embedder",
            )
            .with_source(AgentSubmissionSource::Cli),
        )
        .await?;

    runtime
        .publish_event(RuntimeEventEnvelope {
            session_id: handle.session_id.clone(),
            turn_id: Some(handle.turn_id.clone()),
            source: Some(AgentSubmissionSource::Cli),
            event_type: RuntimeEventType::TurnStarted,
            payload: serde_json::json!({ "example": "sdk_minimal" }),
        })
        .await?;

    assert_eq!(events.len(), 1);
    Ok(())
}
