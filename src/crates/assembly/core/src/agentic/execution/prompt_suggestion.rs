//! Background next-input suggestion after a completed interactive turn.
//!
//! The request retains the turn's model, tools, cache routing identity and
//! send-time message rendering. It overrides reasoning to the lowest supported
//! preset and requests plain text without the turn's output schema. A failed
//! attempt falls back once to the turn's original client. Both attempts share
//! the timeout and cancellation scope. Cache reuse is provider-dependent.

use super::execution_engine::ExecutionEngine;
use super::model_exchange_trace::{
    prepare_model_exchange_trace_for_workspace, ModelExchangeTraceOperation,
};
use crate::agentic::core::Message;
use crate::agentic::events::{AgenticEvent, EventQueue};
use crate::agentic::session::SessionManager;
use crate::agentic::workspace::WorkspaceServices;
use crate::agentic::WorkspaceBinding;
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog_without_refresh, project_model_reasoning_catalog,
};
use crate::infrastructure::ai::AIClient;
use crate::util::types::{Message as AIMessage, ToolDefinition};
use log::{debug, info, warn};
use openbitfun_agent_runtime::prompt_suggestion::{
    lowest_prompt_suggestion_reasoning_preset, prompt_suggestion_instruction,
    prompt_suggestion_text, PromptSuggestionRuntime,
};
use openbitfun_ai_adapters::ModelExchangeTraceConfig;
use openbitfun_core_types::{ModelRequestContext, ReasoningCatalogProjection};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

const PROMPT_SUGGESTION_TIMEOUT: Duration = Duration::from_secs(80);
const PROMPT_SUGGESTION_CONFIG_PATH: &str = "app.ai_experience.enable_prompt_suggestion";

/// Turn-constant request state captured when the turn completes.
pub(super) struct PromptSuggestionRequest {
    pub session_id: String,
    pub turn_id: String,
    pub messages: Vec<Message>,
    pub model_id: String,
    pub ai_client: Arc<AIClient>,
    pub tool_definitions: Option<Vec<ToolDefinition>>,
    pub model_request_context: ModelRequestContext,
    pub prepended_reminders: Vec<String>,
    pub workspace: Option<WorkspaceBinding>,
    pub workspace_services: Option<WorkspaceServices>,
    pub attach_images: bool,
}

fn suggestion_request_context(context: &ModelRequestContext) -> ModelRequestContext {
    ModelRequestContext {
        output_schema: None,
        ..context.clone()
    }
}

fn client_with_lowest_reasoning(
    client: &AIClient,
    projection: &ReasoningCatalogProjection,
) -> anyhow::Result<AIClient> {
    match lowest_prompt_suggestion_reasoning_preset(&projection.presets) {
        Some(preset) => {
            client.validate_reasoning_preset(preset)?;
            Ok(client.with_reasoning_preset(preset))
        }
        None => {
            if client.selected_reasoning_preset().is_some()
                || client.model_reasoning_preset().is_some()
            {
                anyhow::bail!(
                    "Cannot resolve the lowest supported reasoning preset for this model"
                );
            }
            debug!("Prompt suggestion model has no selectable reasoning presets");
            Ok(client.clone())
        }
    }
}

async fn suggestion_client(request: &PromptSuggestionRequest) -> anyhow::Result<AIClient> {
    let config = crate::service::config::get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    let model = config
        .models
        .iter()
        .find(|model| model.id == request.model_id)
        .ok_or_else(|| anyhow::anyhow!("Prompt suggestion model configuration is unavailable"))?;
    let catalog = load_models_dev_reasoning_catalog_without_refresh().await;
    let projection = project_model_reasoning_catalog(model, catalog.catalog.as_deref());
    client_with_lowest_reasoning(request.ai_client.as_ref(), &projection)
}

async fn prompt_suggestion_enabled() -> bool {
    match crate::service::config::get_global_config_service().await {
        Ok(service) => service
            .get_config::<bool>(Some(PROMPT_SUGGESTION_CONFIG_PATH))
            .await
            .unwrap_or(true),
        Err(_) => false,
    }
}

/// Build the suggestion request messages: the final round's send-time messages
/// unchanged, then the suggestion instruction as the only appended message.
pub(super) async fn build_prompt_suggestion_messages(
    request: &PromptSuggestionRequest,
) -> crate::util::errors::OpenBitFunResult<Vec<AIMessage>> {
    let reminders = request
        .prepended_reminders
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut ai_messages = ExecutionEngine::build_ai_messages_for_send(
        &request.messages,
        &request.ai_client.config.format,
        request.workspace.as_ref(),
        request.workspace_services.as_ref(),
        &request.turn_id,
        request.attach_images,
        &reminders,
    )
    .await?;
    ai_messages.push(AIMessage::user(prompt_suggestion_instruction().to_string()));
    Ok(ai_messages)
}

async fn generate_prompt_suggestion(
    request: PromptSuggestionRequest,
    session_manager: Arc<SessionManager>,
) -> anyhow::Result<Option<String>> {
    if !prompt_suggestion_enabled().await {
        debug!(
            "Prompt suggestion disabled by configuration: session_id={}, turn_id={}",
            request.session_id, request.turn_id
        );
        return Ok(None);
    }

    let ai_client = suggestion_client(&request).await;
    let ai_messages = build_prompt_suggestion_messages(&request).await?;

    let trace_dir = session_manager
        .persistent_model_exchange_trace_dir(&request.session_id)
        .await;
    let trace = prepare_model_exchange_trace_for_workspace(
        &request.session_id,
        &request.turn_id,
        request.workspace.as_ref(),
        trace_dir.as_deref(),
        ModelExchangeTraceOperation {
            kind: "prompt_suggestion",
            id: &request.turn_id,
            trigger: None,
        },
        request.ai_client.as_ref(),
    )
    .await;

    request_prompt_suggestion_response(&request, ai_client, ai_messages, trace).await
}

async fn request_prompt_suggestion_response(
    request: &PromptSuggestionRequest,
    lowest_reasoning_client: anyhow::Result<AIClient>,
    ai_messages: Vec<AIMessage>,
    trace: Option<ModelExchangeTraceConfig>,
) -> anyhow::Result<Option<String>> {
    let context = suggestion_request_context(&request.model_request_context);
    let response = match lowest_reasoning_client {
        Ok(client) => {
            client
                .send_message_once_with_trace_and_request_context(
                    ai_messages.clone(),
                    request.tool_definitions.clone(),
                    Some(context.clone()),
                    trace.clone(),
                )
                .await
        }
        Err(error) => Err(error),
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            debug!(
                "Prompt suggestion falling back to original session model settings: session_id={}, turn_id={}, error={:#}",
                request.session_id, request.turn_id, error
            );
            request
                .ai_client
                .send_message_once_with_trace_and_request_context(
                    ai_messages,
                    request.tool_definitions.clone(),
                    Some(context),
                    trace,
                )
                .await?
        }
    };

    if let Some(usage) = response.usage.as_ref() {
        info!(
            "Prompt suggestion usage: session_id={}, turn_id={}, prompt_tokens={}, cached_tokens={}, completion_tokens={}",
            request.session_id,
            request.turn_id,
            usage.prompt_token_count,
            usage.cached_content_token_count.unwrap_or(0),
            usage.candidates_token_count
        );
    }
    if response.tool_calls.is_some() || response.finish_reason.as_deref() == Some("content_filter")
    {
        debug!(
            "Prompt suggestion discarded: session_id={}, turn_id={}, tool_call={}, finish_reason={:?}",
            request.session_id, request.turn_id, response.tool_calls.is_some(), response.finish_reason
        );
        return Ok(None);
    }
    Ok(prompt_suggestion_text(response.text))
}

/// Start the suggestion request in the background. A newer turn or
/// suggestion on the same session cancels it through `runtime`.
pub(super) fn spawn_prompt_suggestion(
    runtime: &PromptSuggestionRuntime,
    event_queue: Arc<EventQueue>,
    session_manager: Arc<SessionManager>,
    request: PromptSuggestionRequest,
) {
    spawn_prompt_suggestion_generation(
        runtime,
        event_queue,
        request.session_id.clone(),
        request.turn_id.clone(),
        generate_prompt_suggestion(request, session_manager),
    );
}

/// Suggestions are best-effort: every expected failure stays inside this task.
/// Only a successful suggestion may enqueue an event; failures never alter the
/// completed dialog turn or emit an error to local/remote consumers.
fn spawn_prompt_suggestion_generation(
    runtime: &PromptSuggestionRuntime,
    event_queue: Arc<EventQueue>,
    session_id: String,
    turn_id: String,
    generation: impl Future<Output = anyhow::Result<Option<String>>> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let token = runtime.begin(&session_id, &turn_id);
    let runtime = runtime.clone();
    tokio::spawn(async move {
        let generation = tokio::time::timeout(PROMPT_SUGGESTION_TIMEOUT, generation);
        let outcome = tokio::select! {
            _ = token.cancelled() => None,
            outcome = generation => Some(outcome),
        };
        match outcome {
            None => debug!(
                "Prompt suggestion cancelled by a newer turn: session_id={}, turn_id={}",
                session_id, turn_id
            ),
            Some(Err(_)) => warn!(
                "Prompt suggestion timed out: session_id={}, turn_id={}, timeout_secs={}",
                session_id,
                turn_id,
                PROMPT_SUGGESTION_TIMEOUT.as_secs()
            ),
            Some(Ok(Err(error))) => warn!(
                "Prompt suggestion skipped after background generation failed: session_id={}, turn_id={}, error={:#}",
                session_id, turn_id, error
            ),
            Some(Ok(Ok(None))) => {}
            Some(Ok(Ok(Some(suggestion)))) if !token.is_cancelled() => {
                debug!(
                    "Prompt suggestion generated: session_id={}, turn_id={}, chars={}",
                    session_id,
                    turn_id,
                    suggestion.chars().count()
                );
                if let Err(error) = event_queue
                    .enqueue(
                        AgenticEvent::PromptSuggestionGenerated {
                            session_id: session_id.clone(),
                            turn_id: turn_id.clone(),
                            suggestion,
                        },
                        None,
                    )
                    .await
                {
                    warn!(
                        "Failed to enqueue prompt suggestion: session_id={}, turn_id={}, error={}",
                        session_id, turn_id, error
                    );
                }
            }
            Some(Ok(Ok(Some(_)))) => {}
        }
        runtime.finish(&session_id, &turn_id);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::events::EventQueueConfig;
    use crate::agentic::execution::round_executor::tests::RetryTestServer;
    use crate::service::config::types::AIModelConfig;
    use openbitfun_core_types::{
        ReasoningCatalogBinding, ReasoningConfig, ReasoningPreset, ReasoningPresetAction,
    };

    async fn assert_silent_completion(
        runtime: &PromptSuggestionRuntime,
        queue: &EventQueue,
        task: tokio::task::JoinHandle<()>,
    ) {
        task.await
            .expect("suggestion failure must not panic the background task");
        assert!(!runtime.is_inflight("session-1"));
        // The same queue feeds desktop, peer and relay consumers: no error,
        // lifecycle change, or partial suggestion may escape this task.
        assert_eq!(queue.stats().await.total_enqueued, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_at_eighty_seconds_drops_generation_and_emits_nothing() {
        use std::sync::atomic::{AtomicBool, Ordering};

        struct DropWitness(Arc<AtomicBool>);
        impl Drop for DropWitness {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let runtime = PromptSuggestionRuntime::new();
        let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let dropped = Arc::new(AtomicBool::new(false));
        let witness = DropWitness(dropped.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = spawn_prompt_suggestion_generation(
            &runtime,
            queue.clone(),
            "session-1".into(),
            "turn-1".into(),
            async move {
                let _witness = witness;
                started.send(()).unwrap();
                std::future::pending().await
            },
        );
        ready.await.unwrap();
        tokio::time::advance(Duration::from_secs(79)).await;
        assert!(runtime.is_inflight("session-1"));
        assert!(!task.is_finished());
        assert!(!dropped.load(Ordering::SeqCst));
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_silent_completion(&runtime, &queue, task).await;
        assert!(dropped.load(Ordering::SeqCst));

        spawn_prompt_suggestion_generation(
            &runtime,
            queue.clone(),
            "session-1".into(),
            "turn-2".into(),
            async { Ok(Some("Run the tests".into())) },
        )
        .await
        .unwrap();
        assert!(!runtime.is_inflight("session-1"));
        let events = queue.dequeue_batch(10).await;
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0].event, AgenticEvent::PromptSuggestionGenerated { turn_id, .. } if turn_id == "turn-2")
        );
    }

    #[tokio::test]
    async fn unsupported_reasoning_validation_uses_the_original_client_once() {
        let server = RetryTestServer::new(vec![suggestion_response("Run the tests")]);
        let projection = project_model_reasoning_catalog(
            &AIModelConfig {
                provider: "openai".into(),
                reasoning: Some(ReasoningConfig {
                    catalog: ReasoningCatalogBinding::Disabled,
                    presets: vec![ReasoningPreset {
                        id: "lowest".into(),
                        actions: vec![ReasoningPresetAction::BudgetTokens { value: 1_024 }],
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
            None,
        );
        let request = test_suggestion_request(server.client());
        let lowest = client_with_lowest_reasoning(&request.ai_client, &projection);
        assert!(lowest.is_err());
        let messages = build_prompt_suggestion_messages(&request).await.unwrap();
        assert_eq!(
            request_prompt_suggestion_response(&request, lowest, messages, None)
                .await
                .unwrap(),
            Some("Run the tests".into())
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].get("reasoning_effort").is_none());
        assert!(requests[0].get("response_format").is_none());
    }

    #[tokio::test]
    async fn provider_rejection_of_low_reasoning_retries_the_original_session_call() {
        for original_effort in [None, Some("high")] {
            let text = "  Run the tests.  ";
            let server = RetryTestServer::new(vec![
                (
                    400,
                    serde_json::json!({
                        "error": { "code": "unsupported_value", "param": "reasoning_effort",
                            "message": "This model does not support reasoning_effort low" }
                    })
                    .to_string(),
                ),
                suggestion_response(text),
            ]);
            let client = server.client();
            let mut projection = project_model_reasoning_catalog(
                &AIModelConfig {
                    provider: "openai".into(),
                    model_name: client.config.model.clone(),
                    base_url: client.config.base_url.clone(),
                    ..Default::default()
                },
                None,
            );
            let session_client = match original_effort {
                Some(effort) => Arc::new(
                    client.with_reasoning_preset(
                        projection
                            .presets
                            .iter()
                            .find(|preset| preset.id == effort)
                            .unwrap(),
                    ),
                ),
                None => client,
            };
            projection.presets.retain(|preset| preset.id == "low");
            assert_eq!(projection.presets.len(), 1);
            let lowest = client_with_lowest_reasoning(&session_client, &projection);
            let mut request = test_suggestion_request(session_client.clone());
            request.model_request_context.output_schema = Some(serde_json::json!({
                "type": "object", "properties": {"report": {"type": "string"}}
            }));
            let runtime = PromptSuggestionRuntime::new();
            let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
            spawn_prompt_suggestion_generation(
                &runtime,
                queue.clone(),
                "session-1".into(),
                "turn-1".into(),
                async move {
                    let messages = build_prompt_suggestion_messages(&request).await?;
                    request_prompt_suggestion_response(&request, lowest, messages, None).await
                },
            )
            .await
            .unwrap();
            assert!(!runtime.is_inflight("session-1"));
            let events = queue.dequeue_batch(10).await;
            assert_eq!(events.len(), 1);
            assert!(
                matches!(&events[0].event, AgenticEvent::PromptSuggestionGenerated { suggestion, .. } if suggestion == text)
            );
            assert_eq!(
                session_client
                    .selected_reasoning_preset()
                    .map(|preset| preset.id.as_str()),
                original_effort
            );
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0]["reasoning_effort"], "low");
            assert_eq!(
                requests[1]
                    .get("reasoning_effort")
                    .and_then(|value| value.as_str()),
                original_effort
            );
            for body in requests.iter() {
                assert!(body.get("response_format").is_none());
            }
            let mut first = requests[0].clone();
            let mut second = requests[1].clone();
            first.as_object_mut().unwrap().remove("reasoning_effort");
            second.as_object_mut().unwrap().remove("reasoning_effort");
            assert_eq!(
                first, second,
                "fallback must retain all other request parameters"
            );
        }
    }

    fn suggestion_response(text: &str) -> (u16, String) {
        suggestion_delta(serde_json::json!({"content": text}), "stop")
    }

    fn suggestion_delta(delta: serde_json::Value, finish: &str) -> (u16, String) {
        (
            200,
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "id": "suggestion-response", "object": "chat.completion.chunk",
                    "created": 1, "model": "retry-test-model",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]
                })
            ),
        )
    }

    fn test_suggestion_request(ai_client: Arc<AIClient>) -> PromptSuggestionRequest {
        PromptSuggestionRequest {
            session_id: "session-1".into(),
            turn_id: "turn-1".into(),
            model_id: "test-model".into(),
            messages: vec![
                Message::system("Follow the user's instructions".into()),
                Message::user("Fix the build".into()),
                Message::assistant("The build is fixed.".into()),
            ],
            ai_client,
            tool_definitions: Some(vec![ToolDefinition {
                name: "Read".into(),
                description: "Read a file".into(),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            }]),
            model_request_context: ModelRequestContext {
                prompt_cache_route_key: Some("same-conversation".into()),
                ..Default::default()
            },
            prepended_reminders: Vec::new(),
            workspace: None,
            workspace_services: None,
            attach_images: false,
        }
    }

    async fn run_test_suggestion(
        request: PromptSuggestionRequest,
    ) -> anyhow::Result<Option<String>> {
        let messages = build_prompt_suggestion_messages(&request).await?;
        request_prompt_suggestion_response(
            &request,
            Ok(request.ai_client.as_ref().clone()),
            messages,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn plain_text_response_emits_one_unchanged_candidate_without_output_schema() {
        let text = "  运行测试，保留原文。  ";
        let server = RetryTestServer::new(vec![suggestion_response(text)]);
        let mut request = test_suggestion_request(server.client());
        request.model_request_context.output_schema = Some(serde_json::json!({
            "type": "object", "properties": {"report": {"type": "string"}}
        }));
        let runtime = PromptSuggestionRuntime::new();
        let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        spawn_prompt_suggestion_generation(
            &runtime,
            queue.clone(),
            "session-1".into(),
            "turn-1".into(),
            run_test_suggestion(request),
        )
        .await
        .unwrap();
        assert!(!runtime.is_inflight("session-1"));
        let events = queue.dequeue_batch(10).await;
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0].event, AgenticEvent::PromptSuggestionGenerated { suggestion, .. } if suggestion == text)
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let body = &requests[0];
        assert!(body.get("response_format").is_none());
        assert_eq!(body["model"], server.client().config.model);
        assert_eq!(body["tools"][0]["function"]["name"], "Read");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[1]["content"], "Fix the build");
        assert_eq!(messages[2]["content"], "The build is fixed.");
        assert_eq!(messages[3]["content"], prompt_suggestion_instruction());
    }

    #[tokio::test]
    async fn repeated_provider_failure_stays_silent_after_one_original_client_retry() {
        let server = RetryTestServer::new(vec![(
            400,
            serde_json::json!({"error": {
                "message": "This response_format type is unavailable now",
                "type": "invalid_request_error"
            }})
            .to_string(),
        )]);
        let runtime = PromptSuggestionRuntime::new();
        let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let task = spawn_prompt_suggestion_generation(
            &runtime,
            queue.clone(),
            "session-1".into(),
            "turn-1".into(),
            run_test_suggestion(test_suggestion_request(server.client())),
        );
        assert_silent_completion(&runtime, &queue, task).await;
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
    }

    #[tokio::test]
    async fn empty_null_tool_calls_and_content_filter_stay_silent_without_retry() {
        for reply in [
            suggestion_response(""),
            suggestion_response("  "),
            suggestion_response("null"),
            suggestion_delta(serde_json::json!({"content": ""}), "content_filter"),
            suggestion_delta(
                serde_json::json!({"tool_calls": [{
                    "index": 0, "id": "read-1", "type": "function",
                    "function": {"name": "Read", "arguments": "{}"}
                }]}),
                "tool_calls",
            ),
        ] {
            let server = RetryTestServer::new(vec![reply]);
            let runtime = PromptSuggestionRuntime::new();
            let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
            let task = spawn_prompt_suggestion_generation(
                &runtime,
                queue.clone(),
                "session-1".into(),
                "turn-1".into(),
                run_test_suggestion(test_suggestion_request(server.client())),
            );
            assert_silent_completion(&runtime, &queue, task).await;
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }

    #[test]
    fn suggestion_context_clears_turn_schema_but_preserves_cache_routing() {
        let context = ModelRequestContext {
            prompt_cache_route_key: Some("lineage-1".to_string()),
            output_schema: Some(
                serde_json::json!({"type": "object", "properties": {"report": {"type": "string"}}}),
            ),
        };
        let suggestion = suggestion_request_context(&context);
        assert_eq!(
            suggestion.prompt_cache_route_key,
            context.prompt_cache_route_key
        );
        assert!(suggestion.output_schema.is_none());
        assert!(context.output_schema.is_some());
    }

    #[test]
    fn suggestion_uses_lowest_supported_reasoning_without_mutating_turn_client() {
        let model = AIModelConfig {
            provider: "responses".to_string(),
            model_name: "gpt-5.4".to_string(),
            base_url: "https://api.openai.com/v1/responses".to_string(),
            reasoning: Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Disabled,
                default_preset: Some("high".to_string()),
                presets: ["high", "low"]
                    .into_iter()
                    .enumerate()
                    .map(|(order, effort)| ReasoningPreset {
                        id: effort.to_string(),
                        order: Some(order as i32),
                        actions: vec![ReasoningPresetAction::Effort {
                            value: effort.to_string(),
                        }],
                        ..Default::default()
                    })
                    .collect(),
            }),
            ..Default::default()
        };
        let projection = project_model_reasoning_catalog(&model, None);
        let high = projection
            .presets
            .iter()
            .find(|preset| preset.id == "high")
            .unwrap();
        let mut client = test_client().with_reasoning_preset(high);
        client.config.format = "responses".to_string();
        client.config.model = model.model_name;
        client.config.base_url = model.base_url.clone();
        client.config.request_url = model.base_url;
        let suggestion = client_with_lowest_reasoning(&client, &projection).unwrap();
        assert_eq!(suggestion.selected_reasoning_preset().unwrap().id, "low");
        assert_eq!(client.selected_reasoning_preset().unwrap().id, "high");
        assert_eq!(suggestion.config.model, client.config.model);
        assert_eq!(suggestion.config.max_tokens, client.config.max_tokens);

        let unsupported = project_model_reasoning_catalog(
            &AIModelConfig {
                reasoning: Some(ReasoningConfig {
                    catalog: ReasoningCatalogBinding::Disabled,
                    ..Default::default()
                }),
                ..Default::default()
            },
            None,
        );
        assert!(client_with_lowest_reasoning(&test_client(), &unsupported)
            .unwrap()
            .selected_reasoning_preset()
            .is_none());
        assert!(client_with_lowest_reasoning(&client, &unsupported).is_err());
    }

    fn test_client() -> Arc<AIClient> {
        Arc::new(AIClient::new(openbitfun_core_types::AIConfig {
            name: "prompt-suggestion-test".to_string(),
            base_url: "http://127.0.0.1:9".to_string(),
            request_url: "http://127.0.0.1:9/v1/chat/completions".to_string(),
            api_key: "prompt-suggestion-test-key".to_string(),
            model: "prompt-suggestion-test-model".to_string(),
            format: "openai".to_string(),
            context_window: 4096,
            max_tokens: Some(128),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        }))
    }

    #[tokio::test]
    async fn suggestion_request_extends_the_final_round_prefix_with_one_instruction() {
        let ai_client = test_client();
        let messages = vec![
            Message::system("system prompt".to_string()),
            Message::user("Fix the failing build".to_string()).with_turn_id("turn-1".to_string()),
            Message::assistant("The build is fixed.".to_string())
                .with_turn_id("turn-1".to_string()),
        ];
        let reminders = vec!["skill listing".to_string()];
        let reminder_refs = reminders.iter().map(String::as_str).collect::<Vec<_>>();
        let round_messages = ExecutionEngine::build_ai_messages_for_send(
            &messages,
            &ai_client.config.format,
            None,
            None,
            "turn-1",
            false,
            &reminder_refs,
        )
        .await
        .expect("round messages");

        let request = PromptSuggestionRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            messages,
            model_id: "test-model".to_string(),
            ai_client,
            tool_definitions: None,
            model_request_context: ModelRequestContext::default(),
            prepended_reminders: reminders,
            workspace: None,
            workspace_services: None,
            attach_images: false,
        };
        let suggestion_messages = build_prompt_suggestion_messages(&request)
            .await
            .expect("suggestion messages");

        assert_eq!(suggestion_messages.len(), round_messages.len() + 1);
        assert_eq!(
            serde_json::to_value(&suggestion_messages[..round_messages.len()]).unwrap(),
            serde_json::to_value(&round_messages).unwrap()
        );
        let instruction = suggestion_messages.last().expect("instruction");
        assert_eq!(instruction.role, "user");
        assert_eq!(
            instruction.content.as_deref(),
            Some(prompt_suggestion_instruction())
        );
    }
}
