//! Model summary attempts for one fixed compression plan.

use crate::agentic::session::ContextCompressor;
use crate::infrastructure::ai::AIClient;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_stream::retry::{delay_ms, should_retry, MAX_MODEL_ATTEMPTS};
use openbitfun_ai_adapters::{
    Message, ModelExchangeTraceConfig, ModelRequestContext, ToolDefinition,
};
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use std::sync::Arc;

pub(super) async fn request_summary(
    client: Arc<AIClient>,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    context: &ModelRequestContext,
    trace: Option<ModelExchangeTraceConfig>,
) -> OpenBitFunResult<String> {
    request_summary_with(|| {
        client.send_message_once_with_trace_and_request_context(
            messages.clone(),
            tools.clone(),
            Some(context.clone()),
            trace.clone(),
        )
    })
    .await
}

async fn request_summary_with<F, Fut>(mut request: F) -> OpenBitFunResult<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<openbitfun_ai_adapters::GeminiResponse>>,
{
    for attempt in 0..MAX_MODEL_ATTEMPTS {
        let result = request().await;
        let mut error = match result {
            Ok(response) => {
                if response.tool_calls.is_some() {
                    AiProviderError::classified(
                        "Compression request returned tool calls instead of a summary".to_string(),
                        ErrorCategory::ModelError,
                    )
                } else if let Some(summary) =
                    ContextCompressor::normalize_model_summary_output(&response.text)
                {
                    return Ok(summary);
                } else {
                    AiProviderError::classified(
                        "Compression request returned an empty summary".to_string(),
                        ErrorCategory::ModelError,
                    )
                }
            }
            Err(error) => error
                .downcast_ref::<AiProviderError>()
                .cloned()
                .unwrap_or_else(|| {
                    AiProviderError::from_parts(format!("{error:#}"), None, None, None)
                }),
        };
        if !should_retry(&error.category) || attempt + 1 == MAX_MODEL_ATTEMPTS {
            error.message = format!(
                "Compression summary failed after {} attempts: {}",
                attempt + 1,
                error.message
            );
            return Err(if error.category == ErrorCategory::ContextOverflow {
                OpenBitFunError::RecoverableContextOverflow(error)
            } else {
                OpenBitFunError::AIProvider(error)
            });
        }
        let wait_ms = delay_ms(attempt, &error.message, Some(&error));
        log::warn!(
            "Retrying compression summary: attempt={}/{}, delay_ms={}, category={:?}, error={}",
            attempt + 1,
            MAX_MODEL_ATTEMPTS,
            wait_ms,
            error.category,
            error
        );
        // The entire preparation future, including aggregation and waits, is
        // cancelled by prepare_compression_cancellable before context commit.
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
    }
    unreachable!("summary attempts return success or a terminal error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::execution::round_executor::tests::{retry_test_success, RetryTestServer};
    use std::collections::VecDeque;

    fn empty() -> anyhow::Result<openbitfun_ai_adapters::GeminiResponse> {
        Ok(openbitfun_ai_adapters::GeminiResponse {
            text: " \n\t".into(),
            reasoning_content: None,
            tool_calls: None,
            usage: None,
            finish_reason: None,
            provider_metadata: None,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn compression_invalid_results_and_transport_errors_share_ten_attempts() {
        let mut responses = VecDeque::new();
        for _ in 0..3 {
            responses.push_back(empty());
        }
        for _ in 0..3 {
            responses.push_back(Err(AiProviderError::classified(
                "network failure".into(),
                ErrorCategory::Network,
            )
            .into()));
        }
        for _ in 0..4 {
            let mut response = empty().unwrap();
            response.text = "Text accompanying a tool call must not become a summary".into();
            response.tool_calls = Some(vec![]);
            responses.push_back(Ok(response));
        }
        let mut requests = 0;
        let error = request_summary_with(|| {
            requests += 1;
            std::future::ready(responses.pop_front().expect("must not exceed budget"))
        })
        .await
        .unwrap_err();
        assert_eq!(requests, 10);
        assert!(error.to_string().contains("10 attempts"));
        assert!(error.to_string().contains("tool calls"));
        assert_eq!(error.error_category(), ErrorCategory::ModelError);
    }

    #[tokio::test(start_paused = true)]
    async fn compression_overflow_on_last_attempt_allows_fresh_request_budget() {
        let mut requests = 0;
        let error = request_summary_with(|| {
            requests += 1;
            std::future::ready(if requests == 10 {
                Err(
                    AiProviderError::classified("too large".into(), ErrorCategory::ContextOverflow)
                        .into(),
                )
            } else {
                empty()
            })
        })
        .await
        .unwrap_err();
        assert!(error.is_recoverable_context_overflow());
        assert_eq!(requests, 10);

        let mut requests = 0;
        let summary = request_summary_with(|| {
            requests += 1;
            let mut response = empty().unwrap();
            if requests == 10 {
                response.text = "  Recovered  ".into();
            }
            std::future::ready(Ok(response))
        })
        .await
        .unwrap();
        assert_eq!(requests, 10);
        assert_eq!(summary, "Recovered");
    }

    #[tokio::test(start_paused = true)]
    async fn compression_cancellation_interrupts_backoff() {
        let token = tokio_util::sync::CancellationToken::new();
        let mut requests = 0;
        let preparation = request_summary_with(|| {
            requests += 1;
            std::future::ready(empty())
        });
        let work = crate::agentic::execution::execution_engine::prepare_compression_cancellable(
            &token,
            preparation,
        );
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            token.cancel();
        };
        let (result, _) = tokio::join!(work, cancel);
        assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
        assert_eq!(requests, 1);
    }

    #[tokio::test]
    async fn compression_http_rejections_and_overflow_do_not_retry_in_adapter() {
        for (status, code, category) in [
            (401, "invalid_api_key", ErrorCategory::Auth),
            (403, "permission_error", ErrorCategory::Permission),
            (413, "invalid_request_error", ErrorCategory::InvalidRequest),
            (402, "insufficient_quota", ErrorCategory::ProviderQuota),
            (
                400,
                "context_length_exceeded",
                ErrorCategory::ContextOverflow,
            ),
        ] {
            let server = RetryTestServer::new(vec![
                (
                    status,
                    serde_json::json!({"error": {"code": code, "message": code}}).to_string(),
                ),
                retry_test_success(),
            ]);
            let error = request_summary(
                server.client(),
                vec![Message::user("Summarize".into())],
                None,
                &ModelRequestContext::default(),
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(error.error_category(), category);
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn compression_http_retries_empty_and_malformed_tool_output() {
        let invalid_tool = (
            200,
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "id":"invalid", "object":"chat.completion.chunk", "created":1, "model":"retry-test-model",
                    "choices":[{"index":0,"delta":{"content":"Ignore this text", "tool_calls":[
                        {"index":0,"id":"call-1","type":"function","function":{"name":"Read","arguments":"{"}}
                    ]},"finish_reason":"tool_calls"}]
                })
            ),
        );
        let server = RetryTestServer::new(vec![
            (200, "data: [DONE]\n\n".into()),
            invalid_tool,
            retry_test_success(),
        ]);
        let summary = request_summary(
            server.client(),
            vec![Message::user("Summarize".into())],
            None,
            &ModelRequestContext::default(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(summary, "Recovered");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0], requests[1]);
        assert_eq!(requests[1], requests[2]);
    }
}
