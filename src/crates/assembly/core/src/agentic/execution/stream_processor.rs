//! Compatibility wrapper for the extracted agent stream processor.

use crate::agentic::core::ToolCall;
use crate::agentic::events::EventQueue;
use crate::util::errors::OpenBitFunError;
use crate::util::types::ai::GeminiUsage;
use futures::stream::BoxStream;
use openbitfun_core_types::ReasoningContentKind;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub use openbitfun_agent_stream::{
    HiddenTextBlock, HiddenTextTag, ModelResponseReplayCapture, StreamProcessOptions,
    StreamProcessorError, ToolCall as StreamToolCall,
};

const MEMORY_CITATION_HIDDEN_TEXT_TAG: &str = "memory_citation";

/// Stream processing result exposed through openbitfun-core compatibility types.
#[derive(Debug, Clone)]
pub struct StreamResult {
    pub full_thinking: String,
    pub reasoning_content_kind: Option<ReasoningContentKind>,
    pub reasoning_content_present: bool,
    pub thinking_signature: Option<String>,
    pub full_text: String,
    pub hidden_text_blocks: Vec<HiddenTextBlock>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<GeminiUsage>,
    pub response_model: Option<String>,
    pub provider_metadata: Option<Value>,
    pub model_response_replay: Option<ModelResponseReplayCapture>,
    pub has_effective_output: bool,
    pub first_chunk_ms: Option<u64>,
    pub first_visible_output_ms: Option<u64>,
    pub partial_recovery_reason: Option<String>,
}

impl From<openbitfun_agent_stream::StreamResult> for StreamResult {
    fn from(result: openbitfun_agent_stream::StreamResult) -> Self {
        Self {
            full_thinking: result.full_thinking,
            reasoning_content_kind: result.reasoning_content_kind,
            reasoning_content_present: result.reasoning_content_present,
            thinking_signature: result.thinking_signature,
            full_text: result.full_text,
            hidden_text_blocks: result.hidden_text_blocks,
            tool_calls: result.tool_calls.into_iter().map(Into::into).collect(),
            usage: result.usage.map(Into::into),
            response_model: result.response_model,
            provider_metadata: result.provider_metadata,
            model_response_replay: result.model_response_replay,
            has_effective_output: result.has_effective_output,
            first_chunk_ms: result.first_chunk_ms,
            first_visible_output_ms: result.first_visible_output_ms,
            partial_recovery_reason: result.partial_recovery_reason,
        }
    }
}

/// Stream processing error exposed through openbitfun-core compatibility errors.
#[derive(Debug)]
pub struct StreamProcessError {
    pub error: OpenBitFunError,
    pub has_effective_output: bool,
    pub usage: Option<GeminiUsage>,
    pub response_model: Option<String>,
}

impl From<openbitfun_agent_stream::StreamProcessError> for StreamProcessError {
    fn from(error: openbitfun_agent_stream::StreamProcessError) -> Self {
        Self {
            error: error.error.into(),
            has_effective_output: error.has_effective_output,
            usage: error.usage.map(Into::into),
            response_model: error.response_model,
        }
    }
}

/// Core-facing stream processor wrapper.
pub struct StreamProcessor {
    inner: openbitfun_agent_stream::StreamProcessor,
}

impl StreamProcessor {
    pub fn new(event_queue: Arc<EventQueue>) -> Self {
        Self {
            inner: openbitfun_agent_stream::StreamProcessor::new(event_queue),
        }
    }

    pub fn derive_watchdog_timeout(stream_idle_timeout: Option<Duration>) -> Option<Duration> {
        openbitfun_agent_stream::StreamProcessor::derive_watchdog_timeout(stream_idle_timeout)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn process_stream(
        &self,
        stream: BoxStream<'static, Result<openbitfun_ai_adapters::UnifiedResponse, anyhow::Error>>,
        watchdog_timeout: Option<Duration>,
        raw_sse_rx: Option<mpsc::UnboundedReceiver<String>>,
        session_id: String,
        dialog_turn_id: String,
        round_id: String,
        attempt_id: String,
        attempt_index: u32,
        cancellation_token: &CancellationToken,
    ) -> Result<StreamResult, StreamProcessError> {
        self.process_stream_with_options(
            stream,
            watchdog_timeout,
            raw_sse_rx,
            session_id,
            dialog_turn_id,
            round_id,
            attempt_id,
            attempt_index,
            cancellation_token,
            StreamProcessOptions::default(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn process_stream_with_options(
        &self,
        stream: BoxStream<'static, Result<openbitfun_ai_adapters::UnifiedResponse, anyhow::Error>>,
        watchdog_timeout: Option<Duration>,
        raw_sse_rx: Option<mpsc::UnboundedReceiver<String>>,
        session_id: String,
        dialog_turn_id: String,
        round_id: String,
        attempt_id: String,
        attempt_index: u32,
        cancellation_token: &CancellationToken,
        options: StreamProcessOptions,
    ) -> Result<StreamResult, StreamProcessError> {
        let options = with_default_hidden_text_tags(options);
        self.inner
            .process_stream_with_options(
                stream,
                watchdog_timeout,
                raw_sse_rx,
                session_id,
                dialog_turn_id,
                round_id,
                attempt_id,
                attempt_index,
                cancellation_token,
                options,
            )
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

fn with_default_hidden_text_tags(mut options: StreamProcessOptions) -> StreamProcessOptions {
    if options.hidden_text_tags.is_empty() {
        options.hidden_text_tags.push(HiddenTextTag::new(
            MEMORY_CITATION_HIDDEN_TEXT_TAG,
            "<openbitfun-mem-citation>",
            "</openbitfun-mem-citation>",
        ));
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hidden_text_tags_adds_memory_citation_tag() {
        let options = with_default_hidden_text_tags(StreamProcessOptions::default());

        assert_eq!(options.hidden_text_tags.len(), 1);
        assert_eq!(options.hidden_text_tags[0].name, "memory_citation");
        assert_eq!(
            options.hidden_text_tags[0].open,
            "<openbitfun-mem-citation>"
        );
        assert_eq!(
            options.hidden_text_tags[0].close,
            "</openbitfun-mem-citation>"
        );
    }

    #[test]
    fn default_hidden_text_tags_preserves_explicit_tags() {
        let options = with_default_hidden_text_tags(StreamProcessOptions {
            hidden_text_tags: vec![HiddenTextTag::new("custom", "<x>", "</x>")],
            ..Default::default()
        });

        assert_eq!(options.hidden_text_tags.len(), 1);
        assert_eq!(options.hidden_text_tags[0].name, "custom");
    }
}
