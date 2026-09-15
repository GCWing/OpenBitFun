use crate::stream::UnifiedResponse;
use crate::tool_call_accumulator::{PendingToolCalls, ToolCallBoundary, ToolCallStreamKey};
use crate::types::{GeminiResponse, GeminiUsage, ToolCall};
use anyhow::Result;
use futures::StreamExt;
use log::{debug, warn};

use super::StreamResponse;

pub(crate) async fn aggregate_stream_response(
    stream_response: StreamResponse,
) -> Result<GeminiResponse> {
    aggregate_stream_response_inner(stream_response, false).await
}

/// Preserve even malformed tool-call presence so summary callers cannot accept
/// text accompanied by tool deltas that the aggregator could not reconstruct.
pub(crate) async fn aggregate_stream_response_preserving_tool_presence(
    stream_response: StreamResponse,
) -> Result<GeminiResponse> {
    aggregate_stream_response_inner(stream_response, true).await
}

async fn aggregate_stream_response_inner(
    stream_response: StreamResponse,
    preserve_tool_presence: bool,
) -> Result<GeminiResponse> {
    let mut saw_tool_call = false;
    let mut stream = stream_response.stream;

    let mut full_text = String::new();
    let mut full_reasoning = String::new();
    let mut finish_reason = None;
    let mut usage = None;
    let mut provider_metadata: Option<serde_json::Value> = None;

    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut pending_tool_calls = PendingToolCalls::default();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                let UnifiedResponse {
                    text,
                    reasoning_content,
                    reasoning_content_kind: _,
                    thinking_signature: _,
                    tool_call,
                    usage: chunk_usage,
                    tool_call_completion: _,
                    finish_reason: chunk_finish_reason,
                    provider_metadata: chunk_provider_metadata,
                    model_response_replay: _,
                } = chunk;

                if let Some(text) = text {
                    full_text.push_str(&text);
                }

                if let Some(reasoning_content) = reasoning_content {
                    full_reasoning.push_str(&reasoning_content);
                }

                if let Some(tool_call) = tool_call {
                    saw_tool_call = true;
                    let crate::stream::UnifiedToolCall {
                        tool_call_index,
                        id,
                        name,
                        arguments,
                        arguments_is_snapshot,
                    } = tool_call;
                    let outcome = pending_tool_calls.apply_delta(
                        ToolCallStreamKey::from(tool_call_index),
                        id,
                        name,
                        arguments,
                        arguments_is_snapshot,
                    );

                    if let Some(finalized) = outcome.finalized_previous {
                        if finalized.is_error {
                            warn!(
                                "[send_message] Dropping invalid tool call at boundary=new_tool: tool_id={}, tool_name={}, raw_len={}",
                                finalized.tool_id,
                                finalized.tool_name,
                                finalized.raw_arguments.len()
                            );
                        } else {
                            tool_calls.push(ToolCall {
                                id: finalized.tool_id,
                                name: finalized.tool_name,
                                arguments: finalized.arguments,
                                raw_arguments: (!finalized.raw_arguments.is_empty())
                                    .then_some(finalized.raw_arguments),
                            });
                        }
                    }

                    if let Some(early_detected) = outcome.early_detected {
                        debug!(
                            "[send_message] Detected tool call: {}",
                            early_detected.tool_name
                        );
                    }
                }

                if let Some(finish_reason_) = chunk_finish_reason {
                    for finalized in pending_tool_calls.finalize_all(ToolCallBoundary::FinishReason)
                    {
                        if finalized.is_error {
                            warn!(
                                "[send_message] Dropping invalid tool call at boundary=finish_reason: tool_id={}, tool_name={}, raw_len={}",
                                finalized.tool_id,
                                finalized.tool_name,
                                finalized.raw_arguments.len()
                            );
                        } else {
                            tool_calls.push(ToolCall {
                                id: finalized.tool_id,
                                name: finalized.tool_name,
                                arguments: finalized.arguments,
                                raw_arguments: (!finalized.raw_arguments.is_empty())
                                    .then_some(finalized.raw_arguments),
                            });
                        }
                    }
                    finish_reason = Some(finish_reason_);
                }

                if let Some(chunk_usage) = chunk_usage {
                    usage = Some(unified_usage_to_gemini_usage(chunk_usage));
                }

                if let Some(chunk_provider_metadata) = chunk_provider_metadata {
                    match provider_metadata.as_mut() {
                        Some(existing) => {
                            crate::client::utils::merge_json_value(
                                existing,
                                chunk_provider_metadata,
                            );
                        }
                        None => provider_metadata = Some(chunk_provider_metadata),
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }

    for finalized in pending_tool_calls.finalize_all(ToolCallBoundary::EndOfAggregation) {
        if finalized.is_error {
            warn!(
                "[send_message] Dropping invalid tool call at boundary=end_of_aggregation: tool_id={}, tool_name={}, raw_len={}",
                finalized.tool_id,
                finalized.tool_name,
                finalized.raw_arguments.len()
            );
        } else {
            tool_calls.push(ToolCall {
                id: finalized.tool_id,
                name: finalized.tool_name,
                arguments: finalized.arguments,
                raw_arguments: (!finalized.raw_arguments.is_empty())
                    .then_some(finalized.raw_arguments),
            });
        }
    }

    Ok(GeminiResponse {
        text: full_text,
        reasoning_content: (!full_reasoning.is_empty()).then_some(full_reasoning),
        tool_calls: (!tool_calls.is_empty() || (preserve_tool_presence && saw_tool_call))
            .then_some(tool_calls),
        usage,
        finish_reason,
        provider_metadata,
    })
}

pub(crate) fn unified_usage_to_gemini_usage(
    usage: crate::stream::UnifiedTokenUsage,
) -> GeminiUsage {
    GeminiUsage {
        prompt_token_count: usage.prompt_token_count,
        candidates_token_count: usage.candidates_token_count,
        total_token_count: usage.total_token_count,
        reasoning_token_count: usage.reasoning_token_count,
        cached_content_token_count: usage.cached_content_token_count,
        cache_creation_token_count: usage.cache_creation_token_count,
    }
}
