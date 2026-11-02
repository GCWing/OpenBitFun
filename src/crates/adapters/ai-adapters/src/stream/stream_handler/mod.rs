mod anthropic;
mod gemini;
mod inline_think;
mod openai;
mod responses;
mod stream_stats;

use futures::{Stream, StreamExt};
use std::time::{Duration, Instant};

use crate::stream::types::unified::UnifiedResponse;

pub use anthropic::handle_anthropic_stream;
pub use gemini::{handle_gemini_code_assist_stream, handle_gemini_stream};
pub use openai::handle_openai_stream;
pub use responses::handle_responses_stream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StreamTimeoutStage {
    Ttft,
    Idle,
}

pub(super) enum TimedStreamItem<T> {
    Item(T),
    End,
    TimedOut(StreamTimeoutStage),
}

pub(super) struct StreamTimeoutController {
    first_effective_output_deadline: Option<Instant>,
    idle_timeout: Option<Duration>,
    first_effective_output_seen: bool,
}

impl StreamTimeoutController {
    pub(super) fn new(ttft_timeout: Option<Duration>, idle_timeout: Option<Duration>) -> Self {
        Self {
            first_effective_output_deadline: ttft_timeout.map(|timeout| Instant::now() + timeout),
            idle_timeout,
            first_effective_output_seen: false,
        }
    }

    pub(super) fn observe_unified_response(&mut self, response: &UnifiedResponse) {
        if is_effective_stream_output(response) {
            self.first_effective_output_seen = true;
        }
    }

    pub(super) fn timeout_for_wait(&self) -> (Option<Duration>, StreamTimeoutStage) {
        if !self.first_effective_output_seen {
            return (
                self.first_effective_output_deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now())),
                StreamTimeoutStage::Ttft,
            );
        }

        (self.idle_timeout, StreamTimeoutStage::Idle)
    }
}

fn is_effective_stream_output(response: &UnifiedResponse) -> bool {
    response.text.as_ref().is_some_and(|text| !text.is_empty())
        || response
            .reasoning_content
            .as_ref()
            .is_some_and(|reasoning| !reasoning.is_empty())
        || response.tool_call.as_ref().is_some_and(|tool_call| {
            tool_call.id.is_some()
                || tool_call.name.is_some()
                || tool_call
                    .arguments
                    .as_ref()
                    .is_some_and(|arguments| !arguments.is_empty())
        })
}

pub(super) async fn next_stream_item<S>(
    stream: &mut S,
    timeout_controller: &StreamTimeoutController,
) -> TimedStreamItem<S::Item>
where
    S: Stream + Unpin,
{
    let (timeout, stage) = timeout_controller.timeout_for_wait();
    match timeout {
        Some(timeout) => match tokio::time::timeout(timeout, stream.next()).await {
            Ok(Some(item)) => TimedStreamItem::Item(item),
            Ok(None) => TimedStreamItem::End,
            Err(_) => TimedStreamItem::TimedOut(stage),
        },
        None => match stream.next().await {
            Some(item) => TimedStreamItem::Item(item),
            None => TimedStreamItem::End,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::types::unified::UnifiedToolCall;

    #[test]
    fn effective_output_includes_text_reasoning_and_tool_calls() {
        assert!(is_effective_stream_output(&UnifiedResponse {
            text: Some("hello".to_string()),
            ..Default::default()
        }));
        assert!(is_effective_stream_output(&UnifiedResponse {
            reasoning_content: Some("thinking".to_string()),
            ..Default::default()
        }));
        assert!(is_effective_stream_output(&UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: Some(0),
                id: Some("call_1".to_string()),
                name: Some("search".to_string()),
                arguments: None,
                arguments_is_snapshot: false,
            }),
            ..Default::default()
        }));
    }

    #[test]
    fn empty_control_only_response_is_not_effective_output() {
        assert!(!is_effective_stream_output(&UnifiedResponse {
            response_model: Some("reported-model".into()),
            ..Default::default()
        }));
        assert!(!is_effective_stream_output(&UnifiedResponse {
            finish_reason: Some("stop".to_string()),
            ..Default::default()
        }));
        assert!(!is_effective_stream_output(&UnifiedResponse {
            provider_metadata: Some(serde_json::json!({ "status": "ok" })),
            ..Default::default()
        }));
    }
}
