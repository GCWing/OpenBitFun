//! AI client implementation.
//!
//! The client module now acts as a small facade:
//! - `client/*` holds shared transport and aggregation utilities
//! - `providers/*` owns provider-specific request/response adaptation

pub(crate) mod format;
pub(crate) mod healthcheck;
pub(crate) mod http;
pub(crate) mod quirks;
mod request_capacity;
pub(crate) mod response_aggregator;
pub(crate) mod sse;
pub(crate) mod utils;

use crate::providers::{anthropic, gemini, openai};
use crate::trace::{
    ModelExchangeRequestTraceHandle, ModelExchangeResponseTrace, ModelExchangeTraceConfig,
};
use crate::types::ProxyConfig;
use crate::types::*;
use anyhow::Result;
use format::ApiFormat;
use log::warn;
use openbitfun_core_types::errors::AiProviderError;
use reqwest::Client;
use std::time::Duration;
use tokio::sync::mpsc;

const SEND_MESSAGE_STREAM_ATTEMPTS: usize = openbitfun_agent_stream::retry::MAX_MODEL_ATTEMPTS;
const TEST_CONNECTION_STREAM_ATTEMPTS: usize = 5;

/// Streamed response result with the parsed stream and optional raw SSE receiver.
pub struct StreamResponse {
    pub stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<crate::stream::UnifiedResponse>> + Send>,
    >,
    pub raw_sse_rx: Option<mpsc::UnboundedReceiver<String>>,
    pub trace_handle: Option<ModelExchangeRequestTraceHandle>,
}

/// Runtime stream behavior shared across provider implementations.
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    /// Maximum idle time between streamed chunks. `None` means wait indefinitely.
    pub idle_timeout: Option<Duration>,
    /// Maximum time to wait for the first effective streamed output (text,
    /// reasoning, or tool-call data) after a request starts. `None` means wait
    /// indefinitely.
    pub ttft_timeout: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct AIClient {
    pub(crate) client: Client,
    pub config: AIConfig,
    pub(crate) stream_options: StreamOptions,
    pub(crate) model_reasoning_preset: Option<ReasoningPresetDescriptor>,
    pub(crate) selected_reasoning_preset: Option<ReasoningPresetDescriptor>,
    #[cfg(feature = "subscription-auth")]
    subscription_provider: Option<crate::subscription_auth::SubscriptionProvider>,
}

impl AIClient {
    pub(crate) const TEST_IMAGE_EXPECTED_CODE: &'static str = "BYGR";
    pub(crate) const TEST_IMAGE_PNG_BASE64: &'static str =
        "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACBklEQVR42u3ZsREAIAwDMYf9dw4txwJupI7Wua+YZEPBfO91h4ZjAgQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABIAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAAAAAAAEDRZI3QGf7jDvEPAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAAAjABAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQALwuLkoG8OSfau4AAAAASUVORK5CYII=";
    pub(crate) const STREAM_CONNECT_TIMEOUT_SECS: u64 = 10;
    pub(crate) const HTTP_POOL_IDLE_TIMEOUT_SECS: u64 = 30;
    pub(crate) const HTTP_TCP_KEEPALIVE_SECS: u64 = 60;

    /// Create an AIClient without proxy.
    pub fn new(config: AIConfig) -> Self {
        Self::new_with_runtime_options(config, None, StreamOptions::default())
    }

    /// Create an AIClient with proxy configuration.
    pub fn new_with_proxy(config: AIConfig, proxy_config: Option<ProxyConfig>) -> Self {
        Self::new_with_runtime_options(config, proxy_config, StreamOptions::default())
    }

    /// Create an AIClient with proxy and runtime stream options.
    pub fn new_with_runtime_options(
        config: AIConfig,
        proxy_config: Option<ProxyConfig>,
        stream_options: StreamOptions,
    ) -> Self {
        let client = http::create_http_client(proxy_config, config.skip_ssl_verify);
        Self {
            client,
            config,
            stream_options,
            model_reasoning_preset: None,
            selected_reasoning_preset: None,
            #[cfg(feature = "subscription-auth")]
            subscription_provider: None,
        }
    }

    /// Enable provider policy only after resolving an explicit subscription login.
    /// This runtime identity is not inferred from URLs or serialized in AIConfig.
    #[cfg(feature = "subscription-auth")]
    pub fn with_subscription_provider(
        mut self,
        provider: crate::subscription_auth::SubscriptionProvider,
    ) -> Self {
        self.subscription_provider = Some(provider);
        self
    }

    /// Explicit subscription identity; ordinary API-key clients return None.
    pub fn subscription_provider_key(&self) -> Option<&'static str> {
        #[cfg(feature = "subscription-auth")]
        {
            self.subscription_provider.map(|provider| provider.key())
        }
        #[cfg(not(feature = "subscription-auth"))]
        {
            None
        }
    }

    /// Returns the configured idle timeout between streamed chunks, if any.
    pub fn stream_idle_timeout(&self) -> Option<Duration> {
        self.stream_options.idle_timeout
    }

    /// Returns the configured timeout for the first effective streamed output, if any.
    pub fn stream_ttft_timeout(&self) -> Option<Duration> {
        self.stream_options.ttft_timeout
    }

    /// Clone this client with the model-level default preset attached.
    ///
    /// The preset remains below `custom_request_body` in request precedence.
    pub fn with_model_reasoning_preset(&self, preset: &ReasoningPresetDescriptor) -> Self {
        let mut cloned = self.clone();
        cloned.model_reasoning_preset = Some(preset.clone());
        cloned
    }

    /// Clone this client with a session-selected preset while reusing the HTTP client.
    ///
    /// Provider builders apply this overlay after the model custom request body.
    pub fn with_reasoning_preset(&self, preset: &ReasoningPresetDescriptor) -> Self {
        let mut cloned = self.clone();
        cloned.selected_reasoning_preset = Some(preset.clone());
        cloned
    }

    pub fn model_reasoning_preset(&self) -> Option<&ReasoningPresetDescriptor> {
        self.model_reasoning_preset.as_ref()
    }

    pub fn selected_reasoning_preset(&self) -> Option<&ReasoningPresetDescriptor> {
        self.selected_reasoning_preset.as_ref()
    }

    /// Validate that one resolved preset can be compiled for this exact
    /// provider, endpoint, model, and output-token limit without performing an
    /// HTTP request.
    pub fn validate_reasoning_preset(&self, preset: &ReasoningPresetDescriptor) -> Result<()> {
        let client = self.with_reasoning_preset(preset);
        let extra_body = client.config.custom_request_body.clone();
        match ApiFormat::parse(&client.config.format)? {
            ApiFormat::OpenAIChat => {
                openai::chat::try_build_request_body(
                    &client,
                    &client.config.request_url,
                    Vec::new(),
                    None,
                    extra_body,
                )?;
            }
            ApiFormat::OpenAIResponses
                if openai::codex_chatgpt::is_codex_chatgpt_endpoint(&client.config.request_url) =>
            {
                openai::codex_chatgpt::try_build_request_body(
                    &client,
                    None,
                    Vec::new(),
                    None,
                    extra_body,
                )?;
            }
            ApiFormat::OpenAIResponses => {
                openai::responses::try_build_request_body(
                    &client,
                    None,
                    Vec::new(),
                    None,
                    extra_body,
                )?;
            }
            ApiFormat::Anthropic => {
                anthropic::request::try_build_request_body(
                    &client,
                    &client.config.request_url,
                    None,
                    Vec::new(),
                    None,
                    extra_body,
                )?;
            }
            ApiFormat::Gemini | ApiFormat::GeminiCodeAssist => {
                gemini::request::try_build_request_body(
                    &client,
                    None,
                    Vec::new(),
                    None,
                    extra_body,
                )?;
            }
        }
        Ok(())
    }

    /// Clone this client with a different max output token limit while
    /// reusing the HTTP client.
    pub fn with_max_tokens(&self, max_tokens: Option<u32>) -> Self {
        let mut cloned = self.clone();
        cloned.config.max_tokens = max_tokens;
        cloned
    }

    pub async fn send_message_stream(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<StreamResponse> {
        let custom_body = self.config.custom_request_body.clone();
        self.send_message_stream_with_extra_body(messages, tools, custom_body, trace)
            .await
    }

    pub async fn send_message_stream_with_extra_body(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        extra_body: Option<serde_json::Value>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<StreamResponse> {
        self.send_message_stream_with_extra_body_and_max_attempts(
            messages,
            tools,
            extra_body,
            SEND_MESSAGE_STREAM_ATTEMPTS,
            trace,
            None,
        )
        .await
    }

    /// Open one model stream without an adapter-owned retry loop.
    ///
    /// Runtime owners with a broader attempt lifecycle use this entry point so
    /// connection, HTTP, TTFT, parsing, and in-stream failures all consume one
    /// shared retry budget instead of multiplying nested retry loops.
    pub async fn send_message_stream_once(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<StreamResponse> {
        self.send_message_stream_once_with_request_context(messages, tools, None, trace)
            .await
    }

    /// Open one model stream without an adapter-owned retry loop, carrying
    /// provider-neutral request-scoped facts to adapters that support them.
    pub async fn send_message_stream_once_with_request_context(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        request_context: Option<ModelRequestContext>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<StreamResponse> {
        let custom_body = self.config.custom_request_body.clone();
        if matches!(
            ApiFormat::parse(&self.config.format)?,
            ApiFormat::OpenAIResponses
        ) {
            return openai::responses::send_stream(
                self,
                messages,
                tools,
                custom_body,
                1,
                trace,
                request_context,
            )
            .await;
        }

        self.send_message_stream_with_extra_body_and_max_attempts(
            messages,
            tools,
            custom_body,
            1,
            trace,
            request_context,
        )
        .await
    }

    pub async fn send_message(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
    ) -> Result<GeminiResponse> {
        let custom_body = self.config.custom_request_body.clone();
        self.send_message_with_extra_body(messages, tools, custom_body)
            .await
    }

    pub async fn send_message_with_extra_body(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        extra_body: Option<serde_json::Value>,
    ) -> Result<GeminiResponse> {
        self.send_message_with_extra_body_and_trace(messages, tools, extra_body, None)
            .await
    }

    pub async fn send_message_with_trace(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<GeminiResponse> {
        self.send_message_with_trace_and_request_context(messages, tools, None, trace)
            .await
    }

    /// Aggregate one model response while carrying provider-neutral
    /// request-scoped facts to adapters that support them.
    pub async fn send_message_with_trace_and_request_context(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        request_context: Option<ModelRequestContext>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<GeminiResponse> {
        let custom_body = self.config.custom_request_body.clone();
        self.send_message_with_extra_body_trace_and_max_attempts(
            messages,
            tools,
            custom_body,
            request_context,
            trace,
            SEND_MESSAGE_STREAM_ATTEMPTS,
        )
        .await
    }

    /// Aggregate exactly one provider attempt; the caller owns retries and validation.
    pub async fn send_message_once_with_trace_and_request_context(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        request_context: Option<ModelRequestContext>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<GeminiResponse> {
        let response = self
            .send_message_stream_once_with_request_context(
                messages,
                tools,
                request_context,
                trace.clone(),
            )
            .await?;
        let handle = response.trace_handle.clone();
        match response_aggregator::aggregate_stream_response_preserving_tool_presence(response)
            .await
        {
            Ok(response) => {
                complete_aggregated_trace(trace.as_ref(), handle.as_ref(), &response).await;
                Ok(response)
            }
            Err(error) => {
                fail_aggregated_trace(trace.as_ref(), handle.as_ref(), &error.to_string()).await;
                Err(error)
            }
        }
    }

    pub async fn send_message_with_extra_body_and_trace(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        extra_body: Option<serde_json::Value>,
        trace: Option<ModelExchangeTraceConfig>,
    ) -> Result<GeminiResponse> {
        self.send_message_with_extra_body_trace_and_max_attempts(
            messages,
            tools,
            extra_body,
            None,
            trace,
            SEND_MESSAGE_STREAM_ATTEMPTS,
        )
        .await
    }

    async fn send_message_with_extra_body_trace_and_max_attempts(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        extra_body: Option<serde_json::Value>,
        request_context: Option<ModelRequestContext>,
        trace: Option<ModelExchangeTraceConfig>,
        max_attempts: usize,
    ) -> Result<GeminiResponse> {
        let request_context =
            crate::providers::shared::prepare_request_context(self, request_context);
        for attempt in 0..max_attempts {
            let stream_response = match self
                .send_message_stream_with_extra_body_and_max_attempts(
                    messages.clone(),
                    tools.clone(),
                    extra_body.clone(),
                    1,
                    trace.clone(),
                    request_context.clone(),
                )
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    if attempt == max_attempts - 1 {
                        return Err(error);
                    }
                    let delay_ms = send_message_retry_delay_ms_for_error(attempt, &error);
                    warn!(
                        "Retrying AI stream request after error: attempt={}/{}, delay_ms={}, error={}",
                        attempt + 1,
                        max_attempts,
                        delay_ms,
                        error
                    );
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    continue;
                }
            };
            let trace_handle = stream_response.trace_handle.clone();

            match response_aggregator::aggregate_stream_response(stream_response).await {
                Ok(response) => {
                    complete_aggregated_trace(trace.as_ref(), trace_handle.as_ref(), &response)
                        .await;
                    return Ok(response);
                }
                Err(error) => {
                    fail_aggregated_trace(
                        trace.as_ref(),
                        trace_handle.as_ref(),
                        &error.to_string(),
                    )
                    .await;
                    if attempt == max_attempts - 1 {
                        return Err(error);
                    }
                    let delay_ms = send_message_retry_delay_ms_for_error(attempt, &error);
                    warn!(
                        "Retrying aggregated AI stream after error: attempt={}/{}, delay_ms={}, error={}",
                        attempt + 1,
                        max_attempts,
                        delay_ms,
                        error
                    );
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
            }
        }

        unreachable!("send_message retry loop always returns")
    }

    async fn send_message_stream_with_extra_body_and_max_attempts(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        extra_body: Option<serde_json::Value>,
        max_tries: usize,
        trace: Option<ModelExchangeTraceConfig>,
        request_context: Option<ModelRequestContext>,
    ) -> Result<StreamResponse> {
        match ApiFormat::parse(&self.config.format)? {
            ApiFormat::OpenAIChat => {
                openai::chat::send_stream(
                    self,
                    messages,
                    tools,
                    extra_body,
                    max_tries,
                    trace,
                    request_context,
                )
                .await
            }
            ApiFormat::OpenAIResponses => {
                openai::responses::send_stream(
                    self,
                    messages,
                    tools,
                    extra_body,
                    max_tries,
                    trace,
                    request_context,
                )
                .await
            }
            ApiFormat::Anthropic => {
                anthropic::request::send_stream(
                    self,
                    messages,
                    tools,
                    extra_body,
                    max_tries,
                    trace,
                    request_context,
                )
                .await
            }
            ApiFormat::Gemini => {
                gemini::request::send_stream(
                    self,
                    messages,
                    tools,
                    extra_body,
                    max_tries,
                    trace,
                    request_context,
                )
                .await
            }
            ApiFormat::GeminiCodeAssist => {
                gemini::code_assist::send_stream(
                    self, messages, tools, extra_body, max_tries, trace,
                )
                .await
            }
        }
    }

    pub async fn test_connection(&self) -> Result<ConnectionTestResult> {
        healthcheck::test_connection(self, TEST_CONNECTION_STREAM_ATTEMPTS).await
    }

    pub async fn test_image_input_connection(&self) -> Result<ConnectionTestResult> {
        healthcheck::test_image_input_connection(self, TEST_CONNECTION_STREAM_ATTEMPTS).await
    }

    pub(crate) async fn send_test_message(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<ToolDefinition>>,
        max_attempts: usize,
    ) -> Result<GeminiResponse> {
        let custom_body = self.config.custom_request_body.clone();
        self.send_message_with_extra_body_trace_and_max_attempts(
            messages,
            tools,
            custom_body,
            None,
            None,
            max_attempts,
        )
        .await
    }

    pub async fn list_models(&self) -> Result<Vec<RemoteModelInfo>> {
        if let Some(plan) = crate::opencode_catalog::api_key_plan(&self.config.base_url) {
            return crate::opencode_catalog::api_key_models(&self.client, plan).await;
        }
        match ApiFormat::parse(&self.config.format)? {
            ApiFormat::OpenAIChat | ApiFormat::OpenAIResponses => {
                openai::common::list_models(self).await
            }
            ApiFormat::Anthropic => anthropic::discovery::list_models(self).await,
            ApiFormat::Gemini => gemini::discovery::list_models(self).await,
            ApiFormat::GeminiCodeAssist => gemini::code_assist::list_models(self).await,
        }
    }
}

#[cfg(test)]
fn send_message_retry_delay_ms(attempt_index: usize, error_message: &str) -> u64 {
    send_message_retry_delay_ms_with_provider(attempt_index, error_message, None)
}

fn send_message_retry_delay_ms_for_error(attempt_index: usize, error: &anyhow::Error) -> u64 {
    send_message_retry_delay_ms_with_provider(
        attempt_index,
        &error.to_string(),
        error.downcast_ref::<AiProviderError>(),
    )
}

fn send_message_retry_delay_ms_with_provider(
    attempt_index: usize,
    error_message: &str,
    provider_error: Option<&AiProviderError>,
) -> u64 {
    openbitfun_agent_stream::retry::delay_ms(attempt_index, error_message, provider_error)
}

async fn complete_aggregated_trace(
    trace_config: Option<&ModelExchangeTraceConfig>,
    trace_handle: Option<&ModelExchangeRequestTraceHandle>,
    response: &GeminiResponse,
) {
    let (Some(trace_config), Some(trace_handle)) = (trace_config, trace_handle) else {
        return;
    };

    trace_config
        .sink
        .request_attempt_completed(trace_handle, &gemini_response_to_trace(response))
        .await;
}

async fn fail_aggregated_trace(
    trace_config: Option<&ModelExchangeTraceConfig>,
    trace_handle: Option<&ModelExchangeRequestTraceHandle>,
    error: &str,
) {
    let Some(trace_config) = trace_config else {
        return;
    };

    trace_config
        .sink
        .request_attempt_failed(trace_handle, error)
        .await;
}

fn gemini_response_to_trace(response: &GeminiResponse) -> ModelExchangeResponseTrace {
    ModelExchangeResponseTrace {
        kind: "completed".to_string(),
        assistant_text: Some(response.text.clone()),
        thinking: response.reasoning_content.clone(),
        tool_calls: response
            .tool_calls
            .as_ref()
            .and_then(|tool_calls| serde_json::to_value(tool_calls).ok()),
        usage: response
            .usage
            .as_ref()
            .and_then(|usage| serde_json::to_value(usage).ok()),
        provider_metadata: response.provider_metadata.clone(),
        partial_recovery_reason: None,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{send_message_retry_delay_ms, AIClient};
    use crate::providers::shared::GENERIC_REASONING_PROVIDER_ID;
    use crate::providers::{anthropic, gemini, gemini::GeminiMessageConverter, openai};
    use crate::types::{AIConfig, ModelRequestContext, ToolDefinition};
    use crate::types::{ReasoningPresetAction, ReasoningPresetDescriptor};
    use axum::extract::State;
    use axum::http::header::CONTENT_TYPE;
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::Router;
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[derive(Clone)]
    struct StreamRetryFixtureState {
        attempts: Arc<AtomicUsize>,
    }

    async fn malformed_stream_then_success(
        State(state): State<StreamRetryFixtureState>,
    ) -> impl IntoResponse {
        let payload = if state.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            "data: not-json\n\n"
        } else {
            concat!(
                "data: {\"id\":\"chatcmpl_test\",\"object\":\"chat.completion.chunk\",",
                "\"created\":1,\"model\":\"test-model\",\"choices\":[{\"index\":0,",
                "\"delta\":{\"content\":\"Recovered\"},\"finish_reason\":\"stop\"}],",
                "\"usage\":null}\n\n",
                "data: [DONE]\n\n"
            )
        };

        ([(CONTENT_TYPE, "text/event-stream")], payload)
    }

    fn make_test_client(format: &str, custom_request_body: Option<Value>) -> AIClient {
        AIClient::new(AIConfig {
            name: format!("{}-test", format),
            base_url: "https://example.com/v1".to_string(),
            request_url: "https://example.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            format: format.to_string(),
            context_window: 128000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body,
            custom_request_body_mode: None,
        })
    }

    fn make_trim_test_client(format: &str) -> AIClient {
        let mut client = make_test_client(format, None);
        client.config.custom_request_body_mode = Some("trim".to_string());
        client
    }

    fn structured_output_context() -> ModelRequestContext {
        ModelRequestContext {
            prompt_cache_route_key: None,
            output_schema: Some(json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } }
            })),
        }
    }

    #[test]
    fn provider_request_bodies_map_turn_output_schema() {
        let context = structured_output_context();
        let chat = openai::chat::build_request_body_with_context(
            &make_test_client("openai", None),
            "https://example.com/v1/chat/completions",
            Vec::new(),
            None,
            Some(json!({ "response_format": { "type": "text" } })),
            Some(&context),
        );
        assert_eq!(chat["response_format"]["type"], "json_schema");
        assert_eq!(
            chat["response_format"]["json_schema"]["schema"],
            context.output_schema.clone().unwrap()
        );

        let anthropic = anthropic::request::build_request_body_with_context(
            &make_test_client("anthropic", None),
            "https://api.anthropic.com/v1/messages",
            None,
            Vec::new(),
            None,
            Some(json!({ "output_config": { "effort": "high" } })),
            Some(&context),
        );
        assert_eq!(anthropic["output_config"]["effort"], "high");
        assert_eq!(
            anthropic["output_config"]["format"]["schema"],
            context.output_schema.clone().unwrap()
        );

        let gemini = gemini::request::build_request_body_with_context(
            &make_test_client("gemini", None),
            None,
            Vec::new(),
            None,
            Some(json!({
                "responseMimeType": "text/plain",
                "responseJsonSchema": { "type": "string" }
            })),
            Some(&context),
        );
        assert_eq!(
            gemini["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            gemini["generationConfig"]["responseJsonSchema"],
            context.output_schema.unwrap()
        );
    }

    fn reasoning_preset(
        id: &str,
        actions: Vec<ReasoningPresetAction>,
    ) -> ReasoningPresetDescriptor {
        ReasoningPresetDescriptor {
            id: id.to_string(),
            label: id.to_string(),
            order: 0,
            actions,
            source: openbitfun_core_types::ReasoningPresetSource::ModelConfig,
            execution_provider: None,
            execution_model: None,
        }
    }

    fn relayed_reasoning_preset(
        id: &str,
        execution_provider: &str,
        execution_model: &str,
        actions: Vec<ReasoningPresetAction>,
    ) -> ReasoningPresetDescriptor {
        ReasoningPresetDescriptor {
            id: id.to_string(),
            label: id.to_string(),
            order: 0,
            actions,
            source: openbitfun_core_types::ReasoningPresetSource::ModelsDev,
            execution_provider: Some(execution_provider.to_string()),
            execution_model: Some(execution_model.to_string()),
        }
    }

    fn generic_reasoning_preset(
        id: &str,
        actions: Vec<ReasoningPresetAction>,
    ) -> ReasoningPresetDescriptor {
        ReasoningPresetDescriptor {
            id: id.to_string(),
            label: id.to_string(),
            order: 0,
            actions,
            source: openbitfun_core_types::ReasoningPresetSource::AdapterFallback,
            execution_provider: Some(GENERIC_REASONING_PROVIDER_ID.to_string()),
            execution_model: Some("unlisted-model".to_string()),
        }
    }

    #[test]
    fn selected_reasoning_effort_overrides_model_custom_body() {
        let client = make_test_client(
            "responses",
            Some(json!({
                "reasoning": { "effort": "low" }
            })),
        )
        .with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
        ));

        let body = openai::responses::build_request_body(
            &client,
            None,
            vec![json!({"role": "user", "content": "hello"})],
            None,
            client.config.custom_request_body.clone(),
        );

        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["model"], "test-model");
    }

    #[test]
    fn generic_openai_reasoning_defaults_compile_for_unlisted_models() {
        let high =
            make_test_client("openai", None).with_reasoning_preset(&generic_reasoning_preset(
                "high",
                vec![ReasoningPresetAction::Effort {
                    value: "high".to_string(),
                }],
            ));
        let high_body = openai::chat::build_request_body(
            &high,
            &high.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );
        assert_eq!(high_body["reasoning_effort"], "high");

        for (enabled, expected) in [(true, "enabled"), (false, "disabled")] {
            let client =
                make_test_client("openai", None).with_reasoning_preset(&generic_reasoning_preset(
                    if enabled { "on" } else { "off" },
                    vec![ReasoningPresetAction::Toggle { enabled }],
                ));
            let body = openai::chat::build_request_body(
                &client,
                &client.config.request_url,
                vec![json!({ "role": "user", "content": "hello" })],
                None,
                None,
            );
            assert_eq!(body["thinking"]["type"], expected);
            assert!(body.get("reasoning_effort").is_none());
        }
    }

    #[test]
    fn generic_responses_toggle_uses_medium_and_none_defaults() {
        for (enabled, expected) in [(true, "medium"), (false, "none")] {
            let client = make_test_client("responses", None).with_reasoning_preset(
                &generic_reasoning_preset(
                    if enabled { "on" } else { "off" },
                    vec![ReasoningPresetAction::Toggle { enabled }],
                ),
            );
            let body = openai::responses::build_request_body(
                &client,
                None,
                vec![json!({"role": "user", "content": "hello"})],
                None,
                None,
            );
            assert_eq!(body["reasoning"]["effort"], expected);
        }
    }

    #[test]
    fn generic_anthropic_and_gemini_reasoning_defaults_compile() {
        let anthropic_client =
            make_test_client("anthropic", None).with_reasoning_preset(&generic_reasoning_preset(
                "low",
                vec![ReasoningPresetAction::Effort {
                    value: "low".to_string(),
                }],
            ));
        let anthropic_body = anthropic::request::build_request_body(
            &anthropic_client,
            &anthropic_client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );
        assert_eq!(anthropic_body["thinking"]["type"], "adaptive");
        assert_eq!(anthropic_body["output_config"]["effort"], "low");

        let gemini_client = make_test_client("gemini", None).with_reasoning_preset(
            &generic_reasoning_preset("on", vec![ReasoningPresetAction::Toggle { enabled: true }]),
        );
        let gemini_body = gemini::request::build_request_body(
            &gemini_client,
            None,
            vec![json!({ "role": "user", "parts": [{ "text": "hello" }] })],
            None,
            None,
        );
        assert_eq!(
            gemini_body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "MEDIUM"
        );
    }

    #[test]
    fn selected_none_effort_overrides_custom_reasoning_fields() {
        let client = make_test_client(
            "responses",
            Some(json!({ "reasoning": { "effort": "low" } })),
        )
        .with_reasoning_preset(&reasoning_preset(
            "none",
            vec![ReasoningPresetAction::Effort {
                value: "none".to_string(),
            }],
        ));

        let body = openai::responses::build_request_body(
            &client,
            None,
            vec![json!({"role": "user", "content": "hello"})],
            None,
            client.config.custom_request_body.clone(),
        );

        assert_eq!(body["reasoning"]["effort"], "none");
    }

    #[test]
    fn selected_request_patch_is_applied_after_custom_body_and_cannot_replace_model() {
        let client = make_test_client(
            "responses",
            Some(json!({
                "reasoning": { "effort": "low" }
            })),
        )
        .with_reasoning_preset(&reasoning_preset(
            "patched",
            vec![ReasoningPresetAction::RequestPatch {
                body: json!({
                    "reasoning": { "effort": "xhigh" },
                    "model": "attacker-model"
                }),
            }],
        ));

        let body = openai::responses::build_request_body(
            &client,
            None,
            vec![json!({"role": "user", "content": "hello"})],
            None,
            client.config.custom_request_body.clone(),
        );

        assert_eq!(body["reasoning"]["effort"], "xhigh");
        assert_eq!(body["model"], "test-model");
    }

    #[test]
    fn direct_non_object_request_patch_fails_closed() {
        let client = make_test_client("responses", None).with_reasoning_preset(&reasoning_preset(
            "invalid-patch",
            vec![ReasoningPresetAction::RequestPatch {
                body: json!(["not", "an", "object"]),
            }],
        ));

        let error =
            openai::responses::try_build_request_body(&client, None, Vec::new(), None, None)
                .expect_err("non-object request patches must fail before an HTTP request");

        assert!(error.to_string().contains("must be a JSON object"));
    }

    #[test]
    fn gemini_selected_request_patch_preserves_nested_runtime_fields() {
        for replacement in [json!(null), json!("invalid"), json!(["invalid"])] {
            let mut client = make_test_client("gemini", None);
            client.config.max_tokens = Some(4096);
            client.config.temperature = Some(0.2);
            let client = client.with_reasoning_preset(&reasoning_preset(
                "patch",
                vec![ReasoningPresetAction::RequestPatch {
                    body: json!({ "generationConfig": replacement }),
                }],
            ));

            let body = gemini::request::build_request_body(
                &client,
                None,
                vec![json!({
                    "role": "user",
                    "parts": [{ "text": "hello" }]
                })],
                None,
                None,
            );

            assert_eq!(body["generationConfig"]["maxOutputTokens"], 4096);
            assert!(body["generationConfig"].get("temperature").is_none());
        }
    }

    #[test]
    fn gemini_model_request_patch_preserves_nested_runtime_fields() {
        let mut client = make_test_client("gemini", None);
        client.config.max_tokens = Some(4096);
        let client = client.with_model_reasoning_preset(&reasoning_preset(
            "patch",
            vec![ReasoningPresetAction::RequestPatch {
                body: json!({ "generationConfig": null }),
            }],
        ));

        let body = gemini::request::build_request_body(
            &client,
            None,
            vec![json!({
                "role": "user",
                "parts": [{ "text": "hello" }]
            })],
            None,
            None,
        );

        assert_eq!(body["generationConfig"]["maxOutputTokens"], 4096);
    }

    #[test]
    fn gemini_request_patch_sequence_restores_nested_fields_after_each_patch() {
        let mut client = make_test_client("gemini", None);
        client.config.max_tokens = Some(4096);
        let client = client.with_reasoning_preset(&reasoning_preset(
            "patches",
            vec![
                ReasoningPresetAction::RequestPatch {
                    body: json!({ "generationConfig": [] }),
                },
                ReasoningPresetAction::RequestPatch {
                    body: json!({
                        "generationConfig": {
                            "candidateCount": 2,
                            "maxOutputTokens": 1
                        }
                    }),
                },
            ],
        ));

        let body = gemini::request::build_request_body(
            &client,
            None,
            vec![json!({
                "role": "user",
                "parts": [{ "text": "hello" }]
            })],
            None,
            None,
        );

        assert_eq!(body["generationConfig"]["maxOutputTokens"], 4096);
        assert_eq!(body["generationConfig"]["candidateCount"], 2);
    }

    #[test]
    fn resolves_openai_models_url_from_completion_endpoint() {
        let client = AIClient::new(AIConfig {
            name: "test".to_string(),
            base_url: "https://api.openai.com/v1/chat/completions".to_string(),
            request_url: "https://api.openai.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "gpt-4.1".to_string(),
            format: "openai".to_string(),
            context_window: 128000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "max",
            vec![ReasoningPresetAction::Effort {
                value: "xhigh".to_string(),
            }],
        ));

        assert_eq!(
            openai::common::resolve_models_url(&client),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn resolves_anthropic_models_url_from_messages_endpoint() {
        let client = AIClient::new(AIConfig {
            name: "test".to_string(),
            base_url: "https://api.anthropic.com/v1/messages".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        assert_eq!(
            anthropic::discovery::resolve_models_url(&client),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn build_gemini_request_body_translates_response_format_and_merges_generation_config() {
        let client = AIClient::new(AIConfig {
            name: "gemini".to_string(),
            base_url: "https://example.com".to_string(),
            request_url: "https://example.com/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
                .to_string(),
            api_key: "test-key".to_string(),
            model: "gemini-2.5-pro".to_string(),
            format: "gemini".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: Some(0.2),
            top_p: Some(0.8),
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "budget",
            vec![ReasoningPresetAction::BudgetTokens { value: 2048 }],
        ));

        let request_body = gemini::request::build_request_body(
            &client,
            None,
            vec![json!({
                "role": "user",
                "parts": [{ "text": "hello" }]
            })],
            None,
            Some(json!({
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "answer": { "type": "string" }
                            },
                            "required": ["answer"],
                            "additionalProperties": false
                        }
                    }
                },
                "stop": ["END"],
                "generationConfig": {
                    "candidateCount": 1
                }
            })),
        );

        assert_eq!(request_body["generationConfig"]["maxOutputTokens"], 4096);
        assert_eq!(request_body["generationConfig"]["temperature"], 0.2);
        assert_eq!(request_body["generationConfig"]["topP"], 0.8);
        assert_eq!(
            request_body["generationConfig"]["thinkingConfig"]["includeThoughts"],
            true
        );
        assert_eq!(
            request_body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(request_body["generationConfig"]["candidateCount"], 1);
        assert_eq!(
            request_body["generationConfig"]["stopSequences"],
            json!(["END"])
        );
        assert_eq!(
            request_body["generationConfig"]["responseJsonSchema"]["required"],
            json!(["answer"])
        );
        assert!(request_body["generationConfig"]["responseJsonSchema"]
            .get("additionalProperties")
            .is_none());
        assert!(request_body.get("response_format").is_none());
        assert!(request_body.get("stop").is_none());
    }

    #[test]
    fn build_gemini_request_body_omits_function_calling_config_for_native_only_tools() {
        let client = AIClient::new(AIConfig {
            name: "gemini".to_string(),
            base_url: "https://example.com".to_string(),
            request_url: "https://example.com/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
                .to_string(),
            api_key: "test-key".to_string(),
            model: "gemini-2.5-pro".to_string(),
            format: "gemini".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        });

        let gemini_tools = GeminiMessageConverter::convert_tools(Some(vec![ToolDefinition {
            name: "WebSearch".to_string(),
            description: "Search the web".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                }
            }),
        }]));

        let request_body = gemini::request::build_request_body(
            &client,
            None,
            vec![json!({
                "role": "user",
                "parts": [{ "text": "hello" }]
            })],
            gemini_tools,
            None,
        );

        assert_eq!(request_body["tools"][0]["googleSearch"], json!({}));
        assert!(request_body.get("toolConfig").is_none());
    }

    #[test]
    fn openai_chat_rejects_unmapped_model_config_toggle_for_an_unverified_endpoint() {
        let client = AIClient::new(AIConfig {
            name: "openai-compatible".to_string(),
            base_url: "https://example.com/v1".to_string(),
            request_url: "https://example.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            format: "openai".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        let error = openai::chat::try_build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        )
        .expect_err("an unverified compatible endpoint must reject generic toggle");

        assert!(error.to_string().contains("unsupported"));
    }

    #[test]
    fn build_openai_request_body_adds_deepseek_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            request_url: "https://api.deepseek.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-pro".to_string(),
            format: "openai".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "max",
            vec![ReasoningPresetAction::Effort {
                value: "xhigh".to_string(),
            }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "max");
    }

    #[test]
    fn build_openai_request_body_omits_deepseek_reasoning_effort_when_disabled() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            request_url: "https://api.deepseek.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            format: "openai".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "off",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn build_zhipu_openai_request_body_adds_glm_52_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "zhipu".to_string(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
            request_url: "https://open.bigmodel.cn/api/paas/v4/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "openai".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&relayed_reasoning_preset(
            "max",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Effort {
                value: "xhigh".to_string(),
            }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "max");
    }

    #[test]
    fn build_zhipu_openai_request_body_disables_glm_52_reasoning() {
        let client = AIClient::new(AIConfig {
            name: "zhipu".to_string(),
            base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
            request_url: "https://open.bigmodel.cn/api/paas/v4/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "openai".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&relayed_reasoning_preset(
            "off",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn build_openbitfun_openai_request_body_adds_glm_52_reasoning_effort() {
        let mut client = make_test_client("openai", None);
        client.config.name = "openbitfun".to_string();
        client.config.base_url = "https://api.openbitfun.com/v1".to_string();
        client.config.request_url = "https://api.openbitfun.com/v1/chat/completions".to_string();
        client.config.model = "glm-5.2".to_string();
        client.config.context_window = 1_000_000;
        let client = client.with_reasoning_preset(&relayed_reasoning_preset(
            "max",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Effort {
                value: "max".to_string(),
            }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "max");
    }

    #[test]
    fn build_openbitfun_openai_request_body_disables_glm_52_reasoning() {
        let mut client = make_test_client("openai", None);
        client.config.name = "openbitfun".to_string();
        client.config.base_url = "https://api.openbitfun.com/v1".to_string();
        client.config.request_url = "https://api.openbitfun.com/v1/chat/completions".to_string();
        client.config.model = "glm-5.2".to_string();
        client.config.context_window = 1_000_000;
        let client = client.with_reasoning_preset(&relayed_reasoning_preset(
            "off",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn build_openbitfun_openai_request_body_preserves_deepseek_flash_low_effort() {
        let mut client = make_test_client("openai", None);
        client.config.name = "openbitfun".to_string();
        client.config.base_url = "https://api.openbitfun.com/v1".to_string();
        client.config.request_url = "https://api.openbitfun.com/v1/chat/completions".to_string();
        client.config.model = "deepseek-v4-flash".to_string();
        let client = client.with_reasoning_preset(&relayed_reasoning_preset(
            "low",
            "deepseek",
            "deepseek-v4-flash",
            vec![ReasoningPresetAction::Effort {
                value: "low".to_string(),
            }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "low");
    }

    #[test]
    fn build_openbitfun_openai_request_body_maps_deepseek_pro_xhigh_to_max() {
        let mut client = make_test_client("openai", None);
        client.config.name = "openbitfun".to_string();
        client.config.base_url = "https://api.openbitfun.com/v1".to_string();
        client.config.request_url = "https://api.openbitfun.com/v1/chat/completions".to_string();
        client.config.model = "deepseek-v4-pro".to_string();
        let client = client.with_reasoning_preset(&relayed_reasoning_preset(
            "max",
            "deepseek",
            "deepseek-v4-pro",
            vec![ReasoningPresetAction::Effort {
                value: "xhigh".to_string(),
            }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "max");
    }

    #[test]
    fn build_openbitfun_openai_request_body_disables_deepseek_reasoning() {
        let mut client = make_test_client("openai", None);
        client.config.name = "openbitfun".to_string();
        client.config.base_url = "https://api.openbitfun.com/v1".to_string();
        client.config.request_url = "https://api.openbitfun.com/v1/chat/completions".to_string();
        client.config.model = "deepseek-v4-pro".to_string();
        let client = client.with_reasoning_preset(&relayed_reasoning_preset(
            "off",
            "deepseek",
            "deepseek-v4-pro",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("reasoning_effort").is_none());
    }

    #[test]
    fn openai_request_rejects_unknown_deepseek_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            request_url: "https://api.deepseek.com/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-pro".to_string(),
            format: "openai".to_string(),
            context_window: 128_000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "invalid",
            vec![ReasoningPresetAction::Effort {
                value: "ultra".to_string(),
            }],
        ));

        let error = openai::chat::try_build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        )
        .expect_err("unknown DeepSeek effort must be rejected");

        assert!(error.to_string().contains("unsupported"));
    }

    #[test]
    fn build_openai_request_body_uses_enable_thinking_for_siliconflow() {
        let client = AIClient::new(AIConfig {
            name: "siliconflow".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            request_url: "https://api.siliconflow.cn/v1/chat/completions".to_string(),
            api_key: "test-key".to_string(),
            model: "Qwen/Qwen3-Coder-480B-A35B-Instruct".to_string(),
            format: "openai".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            vec![json!({ "role": "user", "content": "hello" })],
            None,
            None,
        );

        assert_eq!(request_body["enable_thinking"], true);
        assert!(request_body.get("thinking").is_none());
    }

    #[test]
    fn build_responses_request_body_applies_explicit_none_effort() {
        let client = AIClient::new(AIConfig {
            name: "responses".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            request_url: "https://api.openai.com/v1/responses".to_string(),
            api_key: "test-key".to_string(),
            model: "gpt-5".to_string(),
            format: "responses".to_string(),
            context_window: 128000,
            max_tokens: Some(4096),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "none",
            vec![ReasoningPresetAction::Effort {
                value: "none".to_string(),
            }],
        ));

        let request_body = openai::responses::build_request_body(
            &client,
            Some("Be concise".to_string()),
            vec![json!({
                "role": "user",
                "content": [{ "type": "input_text", "text": "hello" }]
            })],
            None,
            None,
        );

        assert_eq!(request_body["reasoning"]["effort"], "none");
    }

    #[test]
    fn build_anthropic_request_body_uses_adaptive_reasoning_and_effort() {
        let client = AIClient::new(AIConfig {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "adaptive");
        assert_eq!(request_body["output_config"]["effort"], "high");
    }

    #[test]
    fn build_anthropic_request_body_maps_enabled_to_adaptive_for_adaptive_models() {
        let client = AIClient::new(AIConfig {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "adaptive");
        assert!(request_body["thinking"].get("budget_tokens").is_none());
        assert_eq!(request_body["output_config"]["effort"], "medium");
    }

    #[test]
    fn build_anthropic_request_body_keeps_manual_thinking_for_pre_adaptive_models() {
        let client = AIClient::new(AIConfig {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["thinking"]["budget_tokens"], 6144);
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_anthropic_request_body_uses_adaptive_for_opus_4_7_and_newer() {
        let client = AIClient::new(AIConfig {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-opus-4-8".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "adaptive");
        assert!(request_body["thinking"].get("budget_tokens").is_none());
        assert_eq!(request_body["output_config"]["effort"], "high");
    }

    #[test]
    fn build_anthropic_request_body_omits_disabled_for_mythos() {
        let client = AIClient::new(AIConfig {
            name: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            request_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "claude-mythos-preview".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        });

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert!(request_body.get("thinking").is_none());
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_anthropic_request_body_adds_deepseek_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            request_url: "https://api.deepseek.com/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-pro".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "max",
            vec![ReasoningPresetAction::Effort {
                value: "xhigh".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert!(request_body["thinking"].get("budget_tokens").is_none());
        assert_eq!(request_body["output_config"]["effort"], "max");
    }

    #[test]
    fn build_openbitfun_anthropic_request_body_adds_glm_52_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "openbitfun".to_string(),
            base_url: "https://api.openbitfun.com".to_string(),
            request_url: "https://api.openbitfun.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "anthropic".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&relayed_reasoning_preset(
            "max",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Effort {
                value: "max".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["output_config"]["effort"], "max");
        assert_eq!(request_body["thinking"]["type"], "adaptive");
    }

    #[test]
    fn build_openbitfun_anthropic_request_body_disables_glm_52_reasoning() {
        let client = AIClient::new(AIConfig {
            name: "openbitfun".to_string(),
            base_url: "https://api.openbitfun.com".to_string(),
            request_url: "https://api.openbitfun.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "anthropic".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&relayed_reasoning_preset(
            "off",
            "zhipuai",
            "glm-5.2",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_zhipu_anthropic_request_body_disables_glm_52_reasoning() {
        let client = AIClient::new(AIConfig {
            name: "zhipu".to_string(),
            base_url: "https://open.bigmodel.cn/api/anthropic".to_string(),
            request_url: "https://open.bigmodel.cn/api/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "anthropic".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "off",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_zhipu_anthropic_request_body_adds_glm_52_reasoning_effort() {
        let client = AIClient::new(AIConfig {
            name: "zhipu".to_string(),
            base_url: "https://open.bigmodel.cn/api/anthropic".to_string(),
            request_url: "https://open.bigmodel.cn/api/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "glm-5.2".to_string(),
            format: "anthropic".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "medium".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "adaptive");
        assert_eq!(request_body["output_config"]["effort"], "high");
    }

    #[test]
    fn build_openbitfun_anthropic_request_body_preserves_deepseek_flash_low_effort() {
        let client = AIClient::new(AIConfig {
            name: "openbitfun".to_string(),
            base_url: "https://api.openbitfun.com".to_string(),
            request_url: "https://api.openbitfun.com/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            format: "anthropic".to_string(),
            context_window: 1_000_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&relayed_reasoning_preset(
            "low",
            "deepseek",
            "deepseek-v4-flash",
            vec![ReasoningPresetAction::Effort {
                value: "low".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["output_config"]["effort"], "low");
    }

    #[test]
    fn build_anthropic_request_body_toggle_on_has_default_budget() {
        let client = AIClient::new(AIConfig {
            name: "anthropic-proxy".to_string(),
            base_url: "https://proxy.example.com/anthropic".to_string(),
            request_url: "https://proxy.example.com/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "vendor-model-alias".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(4000),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "on",
            vec![ReasoningPresetAction::Toggle { enabled: true }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["thinking"]["budget_tokens"], 3000);
    }

    #[test]
    fn build_anthropic_request_body_default_deepseek_reasoning_omits_thinking_fields() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            request_url: "https://api.deepseek.com/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        });

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert!(request_body.get("thinking").is_none());
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_anthropic_request_body_disabled_deepseek_reasoning_omits_effort() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            request_url: "https://api.deepseek.com/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "off",
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "disabled");
        assert!(request_body.get("output_config").is_none());
    }

    #[test]
    fn build_anthropic_request_body_deepseek_effort_enables_reasoning() {
        let client = AIClient::new(AIConfig {
            name: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            request_url: "https://api.deepseek.com/anthropic/v1/messages".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            format: "anthropic".to_string(),
            context_window: 200000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
        .with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
        ));

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })],
            None,
            None,
        );

        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert!(request_body["thinking"].get("budget_tokens").is_none());
        assert_eq!(request_body["output_config"]["effort"], "high");
    }

    #[test]
    fn build_openai_request_body_trim_mode_preserves_essential_fields() {
        let mut client = make_trim_test_client("openai");
        client.config.base_url = "https://api.deepseek.com/v1".to_string();
        client.config.request_url = "https://api.deepseek.com/v1/chat/completions".to_string();
        client.config.model = "deepseek-v4-pro".to_string();
        client.config.max_tokens = Some(8192);
        let client = client.with_reasoning_preset(&reasoning_preset(
            "high",
            vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
        ));
        let messages = vec![json!({ "role": "user", "content": "hello" })];

        let request_body = openai::chat::build_request_body(
            &client,
            &client.config.request_url,
            messages.clone(),
            None,
            Some(json!({
                "model": "override-model",
                "messages": [{ "role": "user", "content": "override" }],
                "stream": false,
                "max_tokens": 1,
                "temperature": 0.7,
                "response_format": { "type": "json_object" }
            })),
        );

        assert_eq!(request_body["model"], "deepseek-v4-pro");
        assert_eq!(request_body["messages"], json!(messages));
        assert_eq!(request_body["stream"], true);
        assert_eq!(request_body["max_tokens"], 8192);
        assert_eq!(request_body["temperature"], 0.7);
        assert_eq!(request_body["response_format"]["type"], "json_object");
        assert_eq!(request_body["thinking"]["type"], "enabled");
        assert_eq!(request_body["reasoning_effort"], "high");
    }

    #[test]
    fn build_responses_request_body_trim_mode_preserves_essential_fields() {
        let mut client = make_trim_test_client("responses");
        client.config.max_tokens = Some(4096);
        let input = vec![json!({
            "role": "user",
            "content": [{ "type": "input_text", "text": "hello" }]
        })];

        let request_body = openai::responses::build_request_body(
            &client,
            Some("Be concise".to_string()),
            input.clone(),
            None,
            Some(json!({
                "instructions": "override me",
                "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "override" }] }],
                "stream": false,
                "max_output_tokens": 1,
                "temperature": 0.1
            })),
        );

        assert_eq!(request_body["model"], "test-model");
        assert_eq!(request_body["input"], json!(input));
        assert_eq!(request_body["instructions"], "Be concise");
        assert_eq!(request_body["stream"], true);
        assert_eq!(request_body["max_output_tokens"], 4096);
        assert_eq!(request_body["temperature"], 0.1);
        assert!(request_body.get("reasoning").is_none());
    }

    #[test]
    fn with_max_tokens_overrides_output_limit() {
        let client = make_test_client("responses", None);

        let overridden = client.with_max_tokens(Some(2048));

        assert_eq!(client.config.max_tokens, Some(8192));
        assert_eq!(overridden.config.max_tokens, Some(2048));
        assert_eq!(overridden.config.model, client.config.model);
    }

    #[test]
    fn build_anthropic_request_body_trim_mode_preserves_essential_fields() {
        let mut client = make_trim_test_client("anthropic");
        client.config.max_tokens = Some(8192);
        let messages = vec![json!({
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }]
        })];

        let request_body = anthropic::request::build_request_body(
            &client,
            &client.config.request_url,
            Some("Use the system prompt".to_string()),
            messages.clone(),
            None,
            Some(json!({
                "system": "override me",
                "messages": [{ "role": "user", "content": [{ "type": "text", "text": "override" }] }],
                "max_tokens": 1,
                "stream": false,
                "metadata": { "tag": "kept" }
            })),
        );

        assert_eq!(request_body["model"], "test-model");
        assert_eq!(request_body["messages"], json!(messages));
        assert_eq!(request_body["system"], "Use the system prompt");
        assert_eq!(request_body["stream"], true);
        assert_eq!(request_body["max_tokens"], 8192);
        assert_eq!(request_body["metadata"]["tag"], "kept");
        assert!(request_body.get("thinking").is_none());
    }

    #[test]
    fn build_gemini_request_body_trim_mode_preserves_essential_fields() {
        let mut client = make_trim_test_client("gemini");
        client.config.model = "gemini-2.5-pro".to_string();
        client.config.max_tokens = Some(4096);

        let contents = vec![json!({
            "role": "user",
            "parts": [{ "text": "hello" }]
        })];
        let system_instruction = json!({
            "parts": [{ "text": "system" }]
        });
        let gemini_tools = GeminiMessageConverter::convert_tools(Some(vec![ToolDefinition {
            name: "lookup".to_string(),
            description: "Look up data".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"]
            }),
        }]));

        let request_body = gemini::request::build_request_body(
            &client,
            Some(system_instruction.clone()),
            contents.clone(),
            gemini_tools,
            Some(json!({
                "contents": [{ "role": "user", "parts": [{ "text": "override" }] }],
                "systemInstruction": { "parts": [{ "text": "override system" }] },
                "generationConfig": {
                    "maxOutputTokens": 1,
                    "candidateCount": 2
                },
                "tools": [],
                "toolConfig": {
                    "functionCallingConfig": {
                        "mode": "NONE"
                    }
                },
                "temperature": 0.3
            })),
        );

        assert_eq!(request_body["contents"], json!(contents));
        assert_eq!(request_body["systemInstruction"], system_instruction);
        assert_eq!(request_body["generationConfig"]["maxOutputTokens"], 4096);
        assert_eq!(request_body["generationConfig"]["candidateCount"], 2);
        assert_eq!(request_body["generationConfig"]["temperature"], 0.3);
        assert_eq!(
            request_body["toolConfig"]["functionCallingConfig"]["mode"],
            "AUTO"
        );
        assert_eq!(
            request_body["tools"][0]["functionDeclarations"][0]["name"],
            "lookup"
        );
    }

    #[test]
    fn streaming_http_client_does_not_apply_global_request_timeout() {
        let client = make_test_client("openai", None);
        let request = client
            .client
            .get("https://example.com/stream")
            .build()
            .expect("request should build");

        assert_eq!(request.timeout(), None);
    }

    #[tokio::test]
    async fn aggregated_send_message_retries_every_stream_error() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/chat/completions", post(malformed_stream_then_success))
            .with_state(StreamRetryFixtureState {
                attempts: Arc::clone(&attempts),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stream retry fixture");
        let address = listener.local_addr().expect("stream retry fixture address");
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("stream retry fixture should run");
        });
        let mut client = make_test_client("openai", None);
        client.config.request_url = format!("http://{address}/chat/completions");

        let result = client.send_test_message(Vec::new(), None, 2).await;

        server_task.abort();
        let response = result.expect("the second stream attempt should succeed");
        assert_eq!(response.text, "Recovered");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn aggregated_retry_delay_grows_beyond_previous_four_second_cap() {
        assert_eq!(send_message_retry_delay_ms(0, "connection reset"), 500);
        assert_eq!(send_message_retry_delay_ms(3, "connection reset"), 4_000);
        assert_eq!(send_message_retry_delay_ms(5, "connection reset"), 16_000);
        assert_eq!(send_message_retry_delay_ms(6, "connection reset"), 30_000);
        assert_eq!(send_message_retry_delay_ms(9, "connection reset"), 30_000);
    }

    #[test]
    fn aggregated_rate_limit_retry_delay_uses_longer_ladder() {
        assert_eq!(
            send_message_retry_delay_ms(0, "Anthropic Streaming API error 429"),
            2_000
        );
        assert_eq!(
            send_message_retry_delay_ms(3, "rate limit exceeded"),
            16_000
        );
        assert_eq!(send_message_retry_delay_ms(5, "too many requests"), 60_000);
    }
}
