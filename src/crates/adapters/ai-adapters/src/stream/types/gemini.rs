use crate::stream::types::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use openbitfun_agent_stream::ToolCallCompletion;
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) fn map_gemini_finish_reason(reason: &str) -> ToolCallCompletion {
    match reason.trim().to_ascii_uppercase().as_str() {
        "STOP" => ToolCallCompletion::NormalNoToolUse,
        "MAX_TOKENS" => ToolCallCompletion::OutputLimit,
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
            ToolCallCompletion::ContentFiltered
        }
        _ => ToolCallCompletion::Unknown,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSSEData {
    #[serde(default)]
    pub candidates: Vec<GeminiCandidate>,
    #[serde(default)]
    pub usage_metadata: Option<GeminiUsageMetadata>,
    #[serde(default)]
    pub prompt_feedback: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiCandidate {
    #[serde(default)]
    pub content: Option<GeminiContent>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub grounding_metadata: Option<Value>,
    #[serde(default)]
    pub safety_ratings: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiContent {
    #[serde(default)]
    pub parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPart {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub thought: Option<bool>,
    #[serde(default)]
    pub thought_signature: Option<String>,
    #[serde(default)]
    pub function_call: Option<GeminiFunctionCall>,
    #[serde(default)]
    pub executable_code: Option<GeminiExecutableCode>,
    #[serde(default)]
    pub code_execution_result: Option<GeminiCodeExecutionResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionCall {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub args: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiExecutableCode {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiCodeExecutionResult {
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiUsageMetadata {
    #[serde(default)]
    pub prompt_token_count: u32,
    #[serde(default)]
    pub candidates_token_count: u32,
    #[serde(default)]
    pub total_token_count: u32,
    #[serde(default)]
    pub thoughts_token_count: Option<u32>,
    #[serde(default)]
    pub cached_content_token_count: Option<u32>,
}

impl From<GeminiUsageMetadata> for UnifiedTokenUsage {
    fn from(usage: GeminiUsageMetadata) -> Self {
        let reasoning_token_count = usage.thoughts_token_count;
        let candidates_token_count = usage
            .candidates_token_count
            .saturating_add(reasoning_token_count.unwrap_or(0));
        Self {
            prompt_token_count: usage.prompt_token_count,
            candidates_token_count,
            total_token_count: usage.total_token_count,
            reasoning_token_count,
            cached_content_token_count: usage.cached_content_token_count,
            cache_creation_token_count: None,
        }
    }
}

impl GeminiSSEData {
    fn render_executable_code(executable_code: &GeminiExecutableCode) -> Option<String> {
        let code = executable_code.code.as_deref()?.trim();
        if code.is_empty() {
            return None;
        }

        let language = executable_code
            .language
            .as_deref()
            .map(|language| language.to_ascii_lowercase())
            .unwrap_or_else(|| "text".to_string());

        Some(format!(
            "Gemini code execution generated code:\n```{}\n{}\n```",
            language, code
        ))
    }

    fn render_code_execution_result(result: &GeminiCodeExecutionResult) -> Option<String> {
        let output = result.output.as_deref()?.trim();
        if output.is_empty() {
            return None;
        }

        let outcome = result.outcome.as_deref().unwrap_or("OUTCOME_UNKNOWN");
        Some(format!(
            "Gemini code execution result ({}):\n{}",
            outcome, output
        ))
    }

    fn grounding_summary(metadata: &Value) -> Option<String> {
        let mut lines = Vec::new();

        let queries = metadata
            .get("webSearchQueries")
            .and_then(Value::as_array)
            .map(|queries| {
                queries
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|query| !query.trim().is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !queries.is_empty() {
            lines.push(format!("Search queries: {}", queries.join(" | ")));
        }

        let sources = metadata
            .get("groundingChunks")
            .and_then(Value::as_array)
            .map(|chunks| {
                chunks
                    .iter()
                    .filter_map(|chunk| {
                        let web = chunk.get("web")?;
                        let uri = web.get("uri").and_then(Value::as_str)?.trim();
                        if uri.is_empty() {
                            return None;
                        }
                        let title = web
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|title| !title.is_empty())
                            .unwrap_or(uri);
                        Some((title.to_string(), uri.to_string()))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !sources.is_empty() {
            lines.push("Sources:".to_string());
            for (index, (title, uri)) in sources.into_iter().enumerate() {
                lines.push(format!("{}. {} - {}", index + 1, title, uri));
            }
        }

        let supports = metadata
            .get("groundingSupports")
            .and_then(Value::as_array)
            .map(|supports| {
                supports
                    .iter()
                    .filter_map(|support| {
                        let segment_text = support
                            .get("segment")
                            .and_then(Value::as_object)
                            .and_then(|segment| segment.get("text"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|text| !text.is_empty())?;

                        let chunk_indices = support
                            .get("groundingChunkIndices")
                            .and_then(Value::as_array)
                            .map(|indices| {
                                indices
                                    .iter()
                                    .filter_map(Value::as_u64)
                                    .map(|index| (index + 1).to_string())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();

                        if chunk_indices.is_empty() {
                            None
                        } else {
                            Some((segment_text.to_string(), chunk_indices.join(", ")))
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !supports.is_empty() {
            lines.push("Citations:".to_string());
            for (segment, indices) in supports.into_iter().take(5) {
                lines.push(format!("- \"{}\" -> [{}]", segment, indices));
            }
        }

        if lines.is_empty() {
            None
        } else {
            Some(lines.join("\n"))
        }
    }

    fn safety_summary(
        prompt_feedback: Option<&Value>,
        safety_ratings: Option<&Value>,
    ) -> Option<String> {
        let mut lines = Vec::new();

        if let Some(prompt_feedback) = prompt_feedback {
            if let Some(blocked_reason) = prompt_feedback
                .get("blockReason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.trim().is_empty())
            {
                lines.push(format!("Prompt blocked reason: {}", blocked_reason));
            }

            if let Some(block_reason_message) = prompt_feedback
                .get("blockReasonMessage")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
            {
                lines.push(format!("Prompt block message: {}", block_reason_message));
            }
        }

        let ratings = safety_ratings
            .and_then(Value::as_array)
            .map(|ratings| {
                ratings
                    .iter()
                    .filter_map(|rating| {
                        let category = rating.get("category").and_then(Value::as_str)?;
                        let probability = rating
                            .get("probability")
                            .and_then(Value::as_str)
                            .unwrap_or("UNKNOWN");
                        let blocked = rating
                            .get("blocked")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);

                        if blocked || probability != "NEGLIGIBLE" {
                            Some(format!(
                                "{} (probability={}, blocked={})",
                                category, probability, blocked
                            ))
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !ratings.is_empty() {
            lines.push("Safety ratings:".to_string());
            lines.extend(ratings.into_iter().map(|rating| format!("- {}", rating)));
        }

        if lines.is_empty() {
            None
        } else {
            Some(lines.join("\n"))
        }
    }

    fn provider_metadata_summary(metadata: &Value) -> Option<String> {
        let prompt_feedback = metadata.get("promptFeedback");
        let grounding_metadata = metadata.get("groundingMetadata");
        let safety_ratings = metadata.get("safetyRatings");

        let mut sections = Vec::new();
        if let Some(safety) = Self::safety_summary(prompt_feedback, safety_ratings) {
            sections.push(safety);
        }
        if let Some(grounding) = grounding_metadata.and_then(Self::grounding_summary) {
            sections.push(grounding);
        }

        if sections.is_empty() {
            None
        } else {
            Some(sections.join("\n\n"))
        }
    }

    pub fn into_unified_responses(self) -> Vec<UnifiedResponse> {
        let mut usage = self.usage_metadata.map(Into::into);
        let prompt_feedback = self.prompt_feedback;
        let Some(candidate) = self.candidates.into_iter().next() else {
            return usage
                .take()
                .map(|usage| {
                    vec![UnifiedResponse {
                        usage: Some(usage),
                        ..Default::default()
                    }]
                })
                .unwrap_or_default();
        };

        let mut responses = Vec::new();
        let finish_reason = candidate.finish_reason;
        let grounding_metadata = candidate.grounding_metadata;
        let safety_ratings = candidate.safety_ratings;

        if let Some(content) = candidate.content {
            for (part_index, part) in content.parts.into_iter().enumerate() {
                let has_function_call = part.function_call.is_some();
                let text = part.text.filter(|text| !text.is_empty());
                let is_thought = part.thought.unwrap_or(false);
                let thinking_signature = part.thought_signature.filter(|value| !value.is_empty());

                if let Some(function_call) = part.function_call {
                    let arguments = function_call.args.unwrap_or_else(|| json!({}));
                    responses.push(UnifiedResponse {
                        text: None,
                        reasoning_content: None,
                        reasoning_content_kind: None,
                        thinking_signature,
                        tool_call: Some(UnifiedToolCall {
                            tool_call_index: Some(part_index),
                            id: None,
                            name: function_call.name,
                            arguments: serde_json::to_string(&arguments).ok(),
                            arguments_is_snapshot: true,
                        }),
                        usage: usage.take(),
                        tool_call_completion: None,
                        finish_reason: None,
                        provider_metadata: None,
                        response_model: None,
                        model_response_replay: None,
                    });
                    continue;
                }

                if let Some(executable_code) = part.executable_code.as_ref() {
                    if let Some(reasoning_content) = Self::render_executable_code(executable_code) {
                        responses.push(UnifiedResponse {
                            text: None,
                            reasoning_content: Some(reasoning_content),
                            reasoning_content_kind: None,
                            thinking_signature,
                            tool_call: None,
                            usage: usage.take(),
                            tool_call_completion: None,
                            finish_reason: None,
                            provider_metadata: None,
                            response_model: None,
                            model_response_replay: None,
                        });
                        continue;
                    }
                }

                if let Some(code_execution_result) = part.code_execution_result.as_ref() {
                    if let Some(reasoning_content) =
                        Self::render_code_execution_result(code_execution_result)
                    {
                        responses.push(UnifiedResponse {
                            text: None,
                            reasoning_content: Some(reasoning_content),
                            reasoning_content_kind: None,
                            thinking_signature,
                            tool_call: None,
                            usage: usage.take(),
                            tool_call_completion: None,
                            finish_reason: None,
                            provider_metadata: None,
                            response_model: None,
                            model_response_replay: None,
                        });
                        continue;
                    }
                }

                if let Some(text) = text {
                    responses.push(UnifiedResponse {
                        text: if is_thought { None } else { Some(text.clone()) },
                        reasoning_content: if is_thought { Some(text) } else { None },
                        reasoning_content_kind: None,
                        thinking_signature,
                        tool_call: None,
                        usage: usage.take(),
                        tool_call_completion: None,
                        finish_reason: None,
                        provider_metadata: None,
                        response_model: None,
                        model_response_replay: None,
                    });
                    continue;
                }

                if thinking_signature.is_some() && !has_function_call {
                    responses.push(UnifiedResponse {
                        text: None,
                        reasoning_content: None,
                        reasoning_content_kind: None,
                        thinking_signature,
                        tool_call: None,
                        usage: usage.take(),
                        tool_call_completion: None,
                        finish_reason: None,
                        provider_metadata: None,
                        response_model: None,
                        model_response_replay: None,
                    });
                }
            }
        }

        let provider_metadata = {
            let mut metadata = serde_json::Map::new();
            if let Some(prompt_feedback) = prompt_feedback {
                metadata.insert("promptFeedback".to_string(), prompt_feedback);
            }
            if let Some(grounding_metadata) = grounding_metadata {
                metadata.insert("groundingMetadata".to_string(), grounding_metadata);
            }
            if let Some(safety_ratings) = safety_ratings {
                metadata.insert("safetyRatings".to_string(), safety_ratings);
            }

            if metadata.is_empty() {
                None
            } else {
                Some(Value::Object(metadata))
            }
        };

        if let Some(provider_metadata) = provider_metadata {
            let summary = Self::provider_metadata_summary(&provider_metadata);
            responses.push(UnifiedResponse {
                text: summary,
                reasoning_content: None,
                reasoning_content_kind: None,
                thinking_signature: None,
                tool_call: None,
                usage: usage.take(),
                tool_call_completion: None,
                finish_reason: None,
                provider_metadata: Some(provider_metadata),
                response_model: None,
                model_response_replay: None,
            });
        }

        if let Some(finish_reason) = finish_reason {
            if let Some(last_response) = responses.last_mut() {
                last_response.tool_call_completion = Some(map_gemini_finish_reason(&finish_reason));
                last_response.finish_reason = Some(finish_reason);
                return responses;
            }

            responses.push(UnifiedResponse {
                usage,
                tool_call_completion: Some(map_gemini_finish_reason(&finish_reason)),
                finish_reason: Some(finish_reason),
                ..Default::default()
            });
            return responses;
        }

        if responses.is_empty() {
            responses.push(UnifiedResponse {
                usage,
                finish_reason,
                ..Default::default()
            });
        }

        responses
    }
}

#[cfg(test)]
mod tests {
    use super::{map_gemini_finish_reason, GeminiSSEData};
    use openbitfun_agent_stream::ToolCallCompletion;

    #[test]
    fn maps_gemini_output_limit_and_safety_finishes() {
        assert_eq!(
            map_gemini_finish_reason("MAX_TOKENS"),
            ToolCallCompletion::OutputLimit
        );
        assert_eq!(
            map_gemini_finish_reason("SAFETY"),
            ToolCallCompletion::ContentFiltered
        );
        assert_eq!(
            map_gemini_finish_reason("unexpected"),
            ToolCallCompletion::Unknown
        );
    }

    #[test]
    fn converts_text_thought_and_usage() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "thinking", "thought": true, "thoughtSignature": "sig_1" },
                        { "text": "answer" }
                    ]
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 4,
                "thoughtsTokenCount": 2,
                "totalTokenCount": 14
            }
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].reasoning_content.as_deref(), Some("thinking"));
        assert_eq!(responses[0].thinking_signature.as_deref(), Some("sig_1"));
        assert_eq!(
            responses[0]
                .usage
                .as_ref()
                .and_then(|usage| usage.reasoning_token_count),
            Some(2)
        );
        assert_eq!(
            responses[0]
                .usage
                .as_ref()
                .map(|usage| usage.candidates_token_count),
            Some(6)
        );
        assert_eq!(
            responses[0]
                .usage
                .as_ref()
                .map(|usage| usage.total_token_count),
            Some(14)
        );
        assert_eq!(responses[1].text.as_deref(), Some("answer"));
    }

    #[test]
    fn keeps_thought_signature_on_function_call_parts() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {
                            "thoughtSignature": "sig_tool",
                            "functionCall": {
                                "name": "get_weather",
                                "args": { "city": "Paris" }
                            }
                        }
                    ]
                }
            }]
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].thinking_signature.as_deref(), Some("sig_tool"));
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool_call| tool_call.name.as_deref()),
            Some("get_weather")
        );
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool_call| tool_call.tool_call_index),
            Some(0)
        );
        assert!(responses[0]
            .tool_call
            .as_ref()
            .is_some_and(|tool_call| tool_call.arguments_is_snapshot));
    }

    #[test]
    fn indexes_parallel_function_call_parts_and_finishes_after_all_tools() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {
                            "functionCall": {
                                "name": "read_file",
                                "args": { "path": "a.rs" }
                            }
                        },
                        {
                            "functionCall": {
                                "name": "read_file",
                                "args": { "path": "b.rs" }
                            }
                        }
                    ]
                },
                "finishReason": "STOP"
            }]
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool_call| tool_call.tool_call_index),
            Some(0)
        );
        assert_eq!(
            responses[1]
                .tool_call
                .as_ref()
                .and_then(|tool_call| tool_call.tool_call_index),
            Some(1)
        );
        assert!(responses[0].finish_reason.is_none());
        assert_eq!(responses[1].finish_reason.as_deref(), Some("STOP"));
    }

    #[test]
    fn keeps_standalone_thought_signature_parts() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "thoughtSignature": "sig_only" }
                    ]
                }
            }]
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].thinking_signature.as_deref(), Some("sig_only"));
        assert!(responses[0].tool_call.is_none());
        assert!(responses[0].text.is_none());
        assert!(responses[0].reasoning_content.is_none());
    }

    #[test]
    fn converts_code_execution_parts_to_reasoning_chunks() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {
                            "executableCode": {
                                "language": "PYTHON",
                                "code": "print(1 + 1)"
                            }
                        },
                        {
                            "codeExecutionResult": {
                                "outcome": "OUTCOME_OK",
                                "output": "2"
                            }
                        }
                    ]
                }
            }]
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert!(responses[0]
            .reasoning_content
            .as_deref()
            .is_some_and(|text| text.contains("print(1 + 1)")));
        assert!(responses[1]
            .reasoning_content
            .as_deref()
            .is_some_and(|text| text.contains("OUTCOME_OK") && text.contains("2")));
    }

    #[test]
    fn emits_grounding_summary_and_provider_metadata() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "answer" }
                    ]
                },
                "groundingMetadata": {
                    "webSearchQueries": ["latest rust release"],
                    "groundingChunks": [
                        {
                            "web": {
                                "uri": "https://www.rust-lang.org",
                                "title": "Rust"
                            }
                        }
                    ]
                }
            }]
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].text.as_deref(), Some("answer"));
        assert!(responses[1]
            .text
            .as_deref()
            .is_some_and(|text| text.contains("Sources:") && text.contains("rust-lang.org")));
        assert!(responses[1]
            .provider_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("groundingMetadata"))
            .is_some());
    }

    #[test]
    fn emits_prompt_feedback_and_safety_summary() {
        let payload = serde_json::json!({
            "candidates": [{
                "content": { "parts": [] },
                "finishReason": "SAFETY",
                "safetyRatings": [
                    {
                        "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                        "probability": "MEDIUM",
                        "blocked": true
                    }
                ]
            }],
            "promptFeedback": {
                "blockReason": "SAFETY",
                "blockReasonMessage": "Blocked by safety system"
            }
        });

        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].finish_reason.as_deref(), Some("SAFETY"));
        assert!(responses[0]
            .text
            .as_deref()
            .is_some_and(|text| text.contains("Prompt blocked reason: SAFETY")));
        assert!(responses[0]
            .text
            .as_deref()
            .is_some_and(|text| text.contains("HARM_CATEGORY_DANGEROUS_CONTENT")));
        assert!(responses[0]
            .provider_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("promptFeedback"))
            .is_some());
    }

    #[test]
    fn gemini_cache_creation_is_always_none() {
        let payload = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "answer" }] } }],
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 20,
                "totalTokenCount": 120,
                "cachedContentTokenCount": 35
            }
        });
        let data: GeminiSSEData = serde_json::from_value(payload).expect("gemini payload");
        let usage = data.into_unified_responses()[0]
            .usage
            .as_ref()
            .expect("usage")
            .clone();
        assert_eq!(usage.cached_content_token_count, Some(35));
        assert_eq!(usage.cache_creation_token_count, None);
    }
}
