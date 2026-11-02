use crate::stream::types::unified::{UnifiedResponse, UnifiedTokenUsage};
use openbitfun_agent_stream::ToolCallCompletion;
use serde_json::Value;
use std::mem;

const INLINE_THINK_OPEN_TAG: &str = "<think>";
const INLINE_THINK_CLOSE_TAG: &str = "</think>";

#[derive(Debug, Default)]
struct DeferredResponseMeta {
    usage: Option<UnifiedTokenUsage>,
    tool_call_completion: Option<ToolCallCompletion>,
    finish_reason: Option<String>,
    provider_metadata: Option<Value>,
}

impl DeferredResponseMeta {
    fn from_response(response: &mut UnifiedResponse) -> Self {
        Self {
            usage: response.usage.take(),
            tool_call_completion: response.tool_call_completion.take(),
            finish_reason: response.finish_reason.take(),
            provider_metadata: response.provider_metadata.take(),
        }
    }

    fn merge(&mut self, other: Self) {
        if other.usage.is_some() {
            self.usage = other.usage;
        }
        if other.tool_call_completion.is_some() {
            self.tool_call_completion = other.tool_call_completion;
        }
        if other.finish_reason.is_some() {
            self.finish_reason = other.finish_reason;
        }
        if other.provider_metadata.is_some() {
            self.provider_metadata = other.provider_metadata;
        }
    }

    fn apply_to(self, response: &mut UnifiedResponse) {
        if response.usage.is_none() {
            response.usage = self.usage;
        }
        if response.tool_call_completion.is_none() {
            response.tool_call_completion = self.tool_call_completion;
        }
        if response.finish_reason.is_none() {
            response.finish_reason = self.finish_reason;
        }
        if response.provider_metadata.is_none() {
            response.provider_metadata = self.provider_metadata;
        }
    }

    fn is_empty(&self) -> bool {
        self.usage.is_none()
            && self.tool_call_completion.is_none()
            && self.finish_reason.is_none()
            && self.provider_metadata.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InlineThinkActivation {
    Unknown,
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InlineThinkMode {
    Text,
    Thinking,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InlineThinkSegment {
    Text(String),
    Thinking(String),
}

#[derive(Debug)]
pub(crate) struct InlineThinkParser {
    enabled: bool,
    activation: InlineThinkActivation,
    mode: InlineThinkMode,
    pending_tail: String,
    initial_probe: String,
    deferred_meta: DeferredResponseMeta,
}

impl InlineThinkParser {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            activation: InlineThinkActivation::Unknown,
            mode: InlineThinkMode::Text,
            pending_tail: String::new(),
            initial_probe: String::new(),
            deferred_meta: DeferredResponseMeta::default(),
        }
    }

    pub(crate) fn normalize_response(
        &mut self,
        mut response: UnifiedResponse,
    ) -> Vec<UnifiedResponse> {
        let observed_model = response.response_model.take();
        let mut normalized = self.normalize_content(response);
        if let Some(model) = observed_model {
            if let Some(first) = normalized.first_mut() {
                first.response_model = Some(model);
            } else {
                // An observation must survive a failure while text is still buffered.
                normalized.push(UnifiedResponse {
                    response_model: Some(model),
                    ..Default::default()
                });
            }
        }
        normalized
    }

    fn normalize_content(&mut self, mut response: UnifiedResponse) -> Vec<UnifiedResponse> {
        if !self.enabled {
            return vec![response];
        }

        let Some(text) = response.text.take() else {
            return vec![response];
        };

        // Respect providers that already emit native reasoning chunks.
        if response.reasoning_content.is_some()
            || response.tool_call.is_some()
            || response.thinking_signature.is_some()
        {
            response.text = Some(text);
            return vec![response];
        }

        let current_meta = DeferredResponseMeta::from_response(&mut response);
        let segments = match self.activation {
            InlineThinkActivation::Unknown => self.consume_unknown_text(text),
            InlineThinkActivation::Enabled => self.parse_enabled_text(text),
            InlineThinkActivation::Disabled => vec![InlineThinkSegment::Text(text)],
        };

        self.attach_meta_to_segments(segments, current_meta)
    }

    pub(crate) fn flush(&mut self) -> Vec<UnifiedResponse> {
        if !self.enabled {
            return Vec::new();
        }

        let segments = match self.activation {
            InlineThinkActivation::Unknown => {
                let pending = mem::take(&mut self.initial_probe);
                if pending.is_empty() {
                    Vec::new()
                } else {
                    vec![InlineThinkSegment::Text(pending)]
                }
            }
            InlineThinkActivation::Enabled => {
                let pending = mem::take(&mut self.pending_tail);
                if pending.is_empty() {
                    Vec::new()
                } else if self.mode == InlineThinkMode::Thinking {
                    vec![InlineThinkSegment::Thinking(pending)]
                } else {
                    vec![InlineThinkSegment::Text(pending)]
                }
            }
            InlineThinkActivation::Disabled => Vec::new(),
        };

        self.attach_meta_to_segments(segments, DeferredResponseMeta::default())
    }

    fn consume_unknown_text(&mut self, text: String) -> Vec<InlineThinkSegment> {
        self.initial_probe.push_str(&text);

        let trimmed = self.initial_probe.trim_start_matches(char::is_whitespace);
        if trimmed.is_empty() {
            return Vec::new();
        }

        if trimmed.starts_with(INLINE_THINK_OPEN_TAG) {
            self.activation = InlineThinkActivation::Enabled;
            let buffered = mem::take(&mut self.initial_probe);
            return self.parse_enabled_text(buffered);
        }

        if INLINE_THINK_OPEN_TAG.starts_with(trimmed) {
            return Vec::new();
        }

        self.activation = InlineThinkActivation::Disabled;
        vec![InlineThinkSegment::Text(mem::take(&mut self.initial_probe))]
    }

    fn parse_enabled_text(&mut self, text: String) -> Vec<InlineThinkSegment> {
        let mut data = mem::take(&mut self.pending_tail);
        data.push_str(&text);

        let mut segments = Vec::new();

        loop {
            let marker = match self.mode {
                InlineThinkMode::Text => INLINE_THINK_OPEN_TAG,
                InlineThinkMode::Thinking => INLINE_THINK_CLOSE_TAG,
            };

            if let Some(marker_idx) = data.find(marker) {
                let before_marker = data[..marker_idx].to_string();
                self.push_segment(&mut segments, before_marker);

                data = data[marker_idx + marker.len()..].to_string();
                self.mode = match self.mode {
                    InlineThinkMode::Text => InlineThinkMode::Thinking,
                    InlineThinkMode::Thinking => InlineThinkMode::Text,
                };
                continue;
            }

            let tail_len = longest_suffix_prefix_len(&data, marker);
            let flush_len = data.len() - tail_len;
            let ready = data[..flush_len].to_string();
            self.push_segment(&mut segments, ready);
            self.pending_tail = data[flush_len..].to_string();
            break;
        }

        segments
    }

    fn push_segment(&self, segments: &mut Vec<InlineThinkSegment>, content: String) {
        if content.is_empty() {
            return;
        }

        match self.mode {
            InlineThinkMode::Text => segments.push(InlineThinkSegment::Text(content)),
            InlineThinkMode::Thinking => segments.push(InlineThinkSegment::Thinking(content)),
        }
    }

    fn attach_meta_to_segments(
        &mut self,
        segments: Vec<InlineThinkSegment>,
        current_meta: DeferredResponseMeta,
    ) -> Vec<UnifiedResponse> {
        let mut merged_meta = mem::take(&mut self.deferred_meta);
        merged_meta.merge(current_meta);

        let mut responses: Vec<UnifiedResponse> = segments
            .into_iter()
            .map(|segment| match segment {
                InlineThinkSegment::Text(text) => UnifiedResponse {
                    text: Some(text),
                    ..Default::default()
                },
                InlineThinkSegment::Thinking(reasoning_content) => UnifiedResponse {
                    reasoning_content: Some(reasoning_content),
                    ..Default::default()
                },
            })
            .collect();

        if let Some(last_response) = responses.last_mut() {
            merged_meta.apply_to(last_response);
        } else if !merged_meta.is_empty() {
            self.deferred_meta = merged_meta;
        }

        responses
    }
}

fn longest_suffix_prefix_len(value: &str, marker: &str) -> usize {
    let max_len = value.len().min(marker.len().saturating_sub(1));
    (1..=max_len)
        .rev()
        .find(|&len| value.ends_with(&marker[..len]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        longest_suffix_prefix_len, InlineThinkActivation, InlineThinkMode, InlineThinkParser,
    };
    use crate::stream::types::unified::UnifiedResponse;

    #[test]
    fn model_observation_is_not_held_behind_a_buffered_think_tag() {
        let mut parser = InlineThinkParser::new(true);
        let responses = parser.normalize_response(UnifiedResponse {
            text: Some("<thi".into()),
            response_model: Some("reported-snapshot".into()),
            ..Default::default()
        });
        assert_eq!(responses.len(), 1);
        assert_eq!(
            responses[0].response_model.as_deref(),
            Some("reported-snapshot")
        );
        assert!(responses[0].text.is_none());
        assert!(responses[0].reasoning_content.is_none());
        assert!(responses[0].tool_call.is_none());
    }

    #[test]
    fn longest_suffix_prefix_len_detects_partial_tag_boundary() {
        assert_eq!(longest_suffix_prefix_len("<thi", "<think>"), 4);
        assert_eq!(longest_suffix_prefix_len("answer", "<think>"), 0);
    }

    #[test]
    fn inline_think_parser_streams_thinking_and_text_per_chunk() {
        let mut parser = InlineThinkParser::new(true);

        let chunk1 = parser.normalize_response(UnifiedResponse {
            text: Some("<think>abc".to_string()),
            ..Default::default()
        });
        let chunk2 = parser.normalize_response(UnifiedResponse {
            text: Some("def</think>ghi".to_string()),
            ..Default::default()
        });

        assert_eq!(chunk1.len(), 1);
        assert_eq!(chunk1[0].reasoning_content.as_deref(), Some("abc"));
        assert_eq!(chunk2.len(), 2);
        assert_eq!(chunk2[0].reasoning_content.as_deref(), Some("def"));
        assert_eq!(chunk2[1].text.as_deref(), Some("ghi"));
    }

    #[test]
    fn inline_think_parser_handles_split_opening_tag() {
        let mut parser = InlineThinkParser::new(true);

        let first = parser.normalize_response(UnifiedResponse {
            text: Some("<thi".to_string()),
            ..Default::default()
        });
        let second = parser.normalize_response(UnifiedResponse {
            text: Some("nk>hello".to_string()),
            ..Default::default()
        });

        assert!(first.is_empty());
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].reasoning_content.as_deref(), Some("hello"));
    }

    #[test]
    fn inline_think_parser_disables_when_first_text_is_not_think_tag() {
        let mut parser = InlineThinkParser::new(true);

        let first = parser.normalize_response(UnifiedResponse {
            text: Some("hello <think>literal".to_string()),
            ..Default::default()
        });
        let second = parser.normalize_response(UnifiedResponse {
            text: Some("</think> world".to_string()),
            ..Default::default()
        });

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].text.as_deref(), Some("hello <think>literal"));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].text.as_deref(), Some("</think> world"));
        assert_eq!(parser.activation, InlineThinkActivation::Disabled);
        assert_eq!(parser.mode, InlineThinkMode::Text);
    }

    #[test]
    fn inline_think_parser_preserves_finish_reason_on_last_segment() {
        let mut parser = InlineThinkParser::new(true);

        let responses = parser.normalize_response(UnifiedResponse {
            text: Some("<think>abc</think>done".to_string()),
            tool_call_completion: Some(openbitfun_agent_stream::ToolCallCompletion::NormalToolUse),
            finish_reason: Some("stop".to_string()),
            ..Default::default()
        });

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].reasoning_content.as_deref(), Some("abc"));
        assert_eq!(responses[1].text.as_deref(), Some("done"));
        assert_eq!(
            responses[1].tool_call_completion,
            Some(openbitfun_agent_stream::ToolCallCompletion::NormalToolUse)
        );
        assert_eq!(responses[1].finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn inline_think_parser_flushes_unclosed_thinking_at_stream_end() {
        let mut parser = InlineThinkParser::new(true);

        let first = parser.normalize_response(UnifiedResponse {
            text: Some("<think>abc".to_string()),
            ..Default::default()
        });
        let flushed = parser.flush();

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].reasoning_content.as_deref(), Some("abc"));
        assert!(flushed.is_empty());
    }

    #[test]
    fn inline_think_parser_passthrough_when_feature_disabled() {
        let mut parser = InlineThinkParser::new(false);

        let responses = parser.normalize_response(UnifiedResponse {
            text: Some("<think>abc</think>done".to_string()),
            ..Default::default()
        });

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].text.as_deref(), Some("<think>abc</think>done"));
        assert!(responses[0].reasoning_content.is_none());
    }

    #[test]
    fn inline_think_parser_respects_native_reasoning_chunks() {
        let mut parser = InlineThinkParser::new(true);

        let responses = parser.normalize_response(UnifiedResponse {
            text: Some("<think>literal text".to_string()),
            reasoning_content: Some("native reasoning".to_string()),
            ..Default::default()
        });

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].text.as_deref(), Some("<think>literal text"));
        assert_eq!(
            responses[0].reasoning_content.as_deref(),
            Some("native reasoning")
        );
    }
}
