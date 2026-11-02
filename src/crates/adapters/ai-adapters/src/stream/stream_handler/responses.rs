use super::stream_stats::StreamStats;
use super::{next_stream_item, StreamTimeoutController, StreamTimeoutStage, TimedStreamItem};
use crate::stream::types::responses::{
    parse_responses_output_item, parse_responses_replay_capture, ResponsesCompleted, ResponsesDone,
    ResponsesStreamEvent,
};
use crate::stream::types::unified::UnifiedResponse;
use anyhow::{anyhow, Result};
use eventsource_stream::Eventsource;
use log::{debug, error, trace};
use openbitfun_agent_stream::ToolCallCompletion;
use openbitfun_core_types::errors::AiProviderError;
use openbitfun_core_types::ReasoningContentKind;
use reqwest::Response;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;
use tokio::sync::mpsc;

const AI_STREAM_RESPONSE_TARGET: &str = "ai::responses_stream_response";

fn extract_response_prompt_cache_key_hash(response: Option<&Value>) -> Option<String> {
    response
        .and_then(|response| response.get("prompt_cache_key"))
        .and_then(Value::as_str)
        .map(|cache_key| hex::encode(Sha256::digest(cache_key.as_bytes())))
}

fn log_cache_stream_diagnostics(
    response_created_count: usize,
    completed_response_id: Option<&str>,
    expected_prompt_cache_key_hash: Option<&str>,
    response_prompt_cache_key_hash: Option<&str>,
) {
    debug!(
        target: "ai::responses_cache",
        "Responses cache stream diagnostics: response_created_count={}, completed_response_id={}, request_cache_key_hash={}, response_cache_key_hash={}, cache_key_matches={:?}",
        response_created_count,
        completed_response_id.unwrap_or("none"),
        expected_prompt_cache_key_hash
            .and_then(|value| value.get(..12))
            .unwrap_or("none"),
        response_prompt_cache_key_hash
            .and_then(|value| value.get(..12))
            .unwrap_or("none"),
        expected_prompt_cache_key_hash
            .zip(response_prompt_cache_key_hash)
            .map(|(expected, actual)| expected == actual),
    );
}

fn completed_replay_capture(
    response: Option<&Value>,
    done_items: &BTreeMap<usize, Value>,
    done_items_complete: bool,
) -> Option<openbitfun_agent_stream::ModelResponseReplayCapture> {
    let terminal_output = response
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)
        .filter(|output| !output.is_empty());
    if let Some(capture) = terminal_output.and_then(|output| parse_responses_replay_capture(output))
    {
        return Some(capture);
    }

    if !done_items_complete || done_items.is_empty() {
        return None;
    }
    if terminal_output.is_some_and(|output| output.len() != done_items.len()) {
        return None;
    }
    if done_items
        .keys()
        .copied()
        .enumerate()
        .any(|(expected, actual)| expected != actual)
    {
        return None;
    }

    let output = done_items.values().cloned().collect::<Vec<_>>();
    parse_responses_replay_capture(&output)
}

#[derive(Debug, Default, Clone)]
struct InProgressToolCall {
    call_id: Option<String>,
    name: Option<String>,
    args_so_far: String,
    saw_any_delta: bool,
    sent_header: bool,
}

impl InProgressToolCall {
    fn from_item_value(item: &Value) -> Option<Self> {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return None;
        }
        Some(Self {
            call_id: item
                .get("call_id")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            args_so_far: String::new(),
            saw_any_delta: false,
            sent_header: false,
        })
    }
}

fn responses_completed_tool_call_completion(saw_function_call: bool) -> ToolCallCompletion {
    if saw_function_call {
        ToolCallCompletion::NormalToolUse
    } else {
        ToolCallCompletion::NormalNoToolUse
    }
}

fn response_model_observation(event: &Value) -> Option<String> {
    match event.get("type")?.as_str()? {
        "response.created"
        | "response.in_progress"
        | "response.completed"
        | "response.done"
        | "response.incomplete"
        | "response.failed" => event
            .get("response")?
            .get("model")?
            .as_str()
            .filter(|model| !model.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn emit_unified_response(
    timeout_controller: &mut StreamTimeoutController,
    tx_event: &mpsc::UnboundedSender<Result<UnifiedResponse>>,
    stats: &mut StreamStats,
    unified_response: UnifiedResponse,
) {
    timeout_controller.observe_unified_response(&unified_response);
    trace!(
        target: AI_STREAM_RESPONSE_TARGET,
        "Responses unified response: {:?}",
        unified_response
    );
    stats.record_unified_response(&unified_response);
    let _ = tx_event.send(Ok(unified_response));
}

fn emit_tool_call_item(
    timeout_controller: &mut StreamTimeoutController,
    tx_event: &mpsc::UnboundedSender<Result<UnifiedResponse>>,
    stats: &mut StreamStats,
    output_index: Option<usize>,
    item_value: Value,
) {
    if let Some(unified_response) = parse_responses_output_item(item_value, output_index) {
        if unified_response.tool_call.is_some() {
            emit_unified_response(timeout_controller, tx_event, stats, unified_response);
        }
    }
}

fn cleanup_tool_call_tracking(
    output_index: usize,
    tool_calls_by_output_index: &mut HashMap<usize, InProgressToolCall>,
    tool_call_index_by_id: &mut HashMap<String, usize>,
) {
    if let Some(tc) = tool_calls_by_output_index.remove(&output_index) {
        if let Some(call_id) = tc.call_id {
            tool_call_index_by_id.remove(&call_id);
        }
    }
}

fn handle_function_call_arguments_delta(
    timeout_controller: &mut StreamTimeoutController,
    tx_event: &mpsc::UnboundedSender<Result<UnifiedResponse>>,
    stats: &mut StreamStats,
    output_index: Option<usize>,
    delta: Option<String>,
    tool_calls_by_output_index: &mut HashMap<usize, InProgressToolCall>,
) -> Result<()> {
    let Some(delta) = delta.filter(|delta| !delta.is_empty()) else {
        return Ok(());
    };
    let Some(output_index) = output_index else {
        return Err(anyhow!(
            "Responses function_call_arguments.delta missing output_index"
        ));
    };
    let Some(tc) = tool_calls_by_output_index.get_mut(&output_index) else {
        return Err(anyhow!(
            "Responses function_call_arguments.delta for untracked output_index {}",
            output_index
        ));
    };

    tc.saw_any_delta = true;
    tc.args_so_far.push_str(&delta);

    // Some consumers treat `id` as a "new tool call" marker and reset buffers when it repeats.
    // Only send id/name once per tool call; deltas that follow carry arguments only.
    let (id, name) = if tc.sent_header {
        (None, None)
    } else {
        tc.sent_header = true;
        (tc.call_id.clone(), tc.name.clone())
    };

    let unified_response = UnifiedResponse {
        tool_call: Some(crate::stream::types::unified::UnifiedToolCall {
            tool_call_index: Some(output_index),
            id,
            name,
            arguments: Some(delta),
            arguments_is_snapshot: false,
        }),
        ..Default::default()
    };
    emit_unified_response(timeout_controller, tx_event, stats, unified_response);
    Ok(())
}

fn handle_function_call_output_item_done(
    timeout_controller: &mut StreamTimeoutController,
    tx_event: &mpsc::UnboundedSender<Result<UnifiedResponse>>,
    stats: &mut StreamStats,
    event_output_index: Option<usize>,
    item_value: Value,
    tool_calls_by_output_index: &mut HashMap<usize, InProgressToolCall>,
    tool_call_index_by_id: &mut HashMap<String, usize>,
) {
    // Resolve output_index either directly or via call_id mapping.
    let output_index = event_output_index.or_else(|| {
        item_value
            .get("call_id")
            .and_then(Value::as_str)
            .and_then(|id| tool_call_index_by_id.get(id).copied())
    });

    let Some(output_index) = output_index else {
        emit_tool_call_item(
            timeout_controller,
            tx_event,
            stats,
            event_output_index,
            item_value,
        );
        return;
    };

    let Some(tc) = tool_calls_by_output_index.get_mut(&output_index) else {
        // The provider may send `output_item.done` with an output_index even when the
        // earlier `output_item.added` event was omitted or missed. Fall back to the full item.
        emit_tool_call_item(
            timeout_controller,
            tx_event,
            stats,
            Some(output_index),
            item_value,
        );
        return;
    };

    let full_args = item_value
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let need_fallback_full = !tc.saw_any_delta;
    let need_tail = tc.saw_any_delta
        && tc.args_so_far.len() < full_args.len()
        && full_args.starts_with(&tc.args_so_far);

    if need_fallback_full || need_tail {
        let delta = if need_fallback_full {
            full_args.to_string()
        } else {
            full_args[tc.args_so_far.len()..].to_string()
        };

        if !delta.is_empty() {
            tc.args_so_far.push_str(&delta);
            let (id, name) = if tc.sent_header {
                (None, None)
            } else {
                tc.sent_header = true;
                (tc.call_id.clone(), tc.name.clone())
            };
            let unified_response = UnifiedResponse {
                tool_call: Some(crate::stream::types::unified::UnifiedToolCall {
                    tool_call_index: Some(output_index),
                    id,
                    name,
                    arguments: Some(delta),
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            };
            emit_unified_response(timeout_controller, tx_event, stats, unified_response);
        }
    }

    cleanup_tool_call_tracking(
        output_index,
        tool_calls_by_output_index,
        tool_call_index_by_id,
    );
}

fn extract_api_error_message(event_json: &Value) -> Option<String> {
    let error = event_json
        .get("response")
        .and_then(|response| response.get("error"))
        .or_else(|| event_json.get("error"))?;

    if error.is_null() {
        return None;
    }

    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }

    Some("An error occurred during responses streaming".to_string())
}

fn extract_api_error(event_json: &Value) -> Option<AiProviderError> {
    let error = event_json
        .get("response")
        .and_then(|response| response.get("error"))
        .or_else(|| event_json.get("error"));
    let code = event_json
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| {
            error.and_then(|error| {
                error
                    .get("code")
                    .or_else(|| error.get("type"))
                    .and_then(Value::as_str)
            })
        })
        .map(str::to_string);
    if error.is_none() && code.is_none() {
        return None;
    }
    let message = event_json
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| extract_api_error_message(event_json))?;
    Some(
        AiProviderError::from_parts(message, Some("openai_responses".to_string()), code, None)
            .with_retry_after_ms(error.and_then(stream_recovery_hint_ms)),
    )
}

/// `response.failed` usage-limit errors carry the allowance reset in the same
/// fields as the HTTP body; routing uses it as the account cooldown.
fn stream_recovery_hint_ms(error: &Value) -> Option<u64> {
    const MAX_HINT_SECONDS: u64 = 8 * 24 * 60 * 60;
    let seconds = match error.get("resets_at").and_then(Value::as_i64) {
        Some(at) => u64::try_from(at - chrono::Utc::now().timestamp()).ok()?,
        None => error.get("resets_in_seconds").and_then(Value::as_u64)?,
    };
    (seconds > 0).then(|| seconds.min(MAX_HINT_SECONDS).saturating_mul(1000))
}

pub async fn handle_responses_stream(
    response: Response,
    tx_event: mpsc::UnboundedSender<Result<UnifiedResponse>>,
    tx_raw_sse: Option<mpsc::UnboundedSender<String>>,
    ttft_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
    expected_prompt_cache_key_hash: Option<String>,
) {
    let mut stream = response.bytes_stream().eventsource();
    // Some providers close the stream after emitting the terminal event and may not send `[DONE]`.
    let mut received_finish_reason = false;
    let mut received_text_delta = false;
    let mut saw_function_call = false;
    let mut tool_calls_by_output_index: HashMap<usize, InProgressToolCall> = HashMap::new();
    let mut tool_call_index_by_id: HashMap<String, usize> = HashMap::new();
    let mut done_items_by_output_index: BTreeMap<usize, Value> = BTreeMap::new();
    let mut done_items_complete = true;
    let mut stats = StreamStats::new("Responses");
    let mut timeout_controller = StreamTimeoutController::new(ttft_timeout, idle_timeout);
    let mut response_created_count = 0usize;
    let mut response_prompt_cache_key_hash: Option<String> = None;
    let mut last_reasoning_summary_part: Option<(Option<usize>, usize)> = None;

    loop {
        let sse = match next_stream_item(&mut stream, &timeout_controller).await {
            TimedStreamItem::Item(Ok(sse)) => sse,
            TimedStreamItem::End => {
                if received_finish_reason {
                    stats.log_summary("stream_closed_after_finish_reason");
                    return;
                }
                let error_msg = "Responses SSE stream closed before response completed";
                stats.log_summary("stream_closed_before_completion");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::Item(Err(e)) => {
                let error_msg = format!("Responses SSE stream error: {}", e);
                stats.log_summary("sse_stream_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::TimedOut(StreamTimeoutStage::Ttft) => {
                let timeout_secs = ttft_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
                let error_msg = format!(
                    "Responses stream TTFT timeout after {}s waiting for first effective output",
                    timeout_secs
                );
                stats.log_summary("ttft_timeout");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::TimedOut(StreamTimeoutStage::Idle) => {
                let timeout_secs = idle_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
                let error_msg = format!("Responses SSE stream timeout after {}s", timeout_secs);
                stats.log_summary("sse_stream_timeout");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        let raw = sse.data;
        stats.record_sse_event("data");
        trace!(target: AI_STREAM_RESPONSE_TARGET, "Responses SSE: {:?}", raw);
        if let Some(ref tx) = tx_raw_sse {
            let _ = tx.send(raw.clone());
        }
        if raw == "[DONE]" {
            stats.increment("marker:done");
            stats.log_summary("done_marker_received");
            return;
        }

        let event_json: Value = match serde_json::from_str(&raw) {
            Ok(json) => json,
            Err(e) => {
                let error_msg = format!("Responses SSE parsing error: {}, data: {}", e, &raw);
                stats.increment("error:sse_parsing");
                stats.log_summary("sse_parsing_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        // Model metadata is observational, never effective output. Emit it
        // before a possible provider error so failed attempts retain the fact.
        if let Some(model) = response_model_observation(&event_json) {
            emit_unified_response(
                &mut timeout_controller,
                &tx_event,
                &mut stats,
                UnifiedResponse {
                    response_model: Some(model),
                    ..Default::default()
                },
            );
        }

        if let Some(mut provider_error) = extract_api_error(&event_json) {
            provider_error.message = format!(
                "Responses SSE API error: {}, data: {}",
                provider_error.message, raw
            );
            stats.increment("error:api");
            stats.log_summary("sse_api_error");
            error!("{}", provider_error);
            let _ = tx_event.send(Err(anyhow!(provider_error)));
            return;
        }

        let event: ResponsesStreamEvent = match serde_json::from_value(event_json) {
            Ok(event) => event,
            Err(e) => {
                let error_msg = format!("Responses SSE schema error: {}, data: {}", e, &raw);
                stats.increment("error:schema");
                stats.log_summary("sse_schema_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };
        stats.increment(format!("event:{}", event.kind));

        match event.kind.as_str() {
            "response.created" => {
                response_created_count += 1;
                if let Some(response) = event.response.as_ref() {
                    if let Some(response_id) = response.get("id").and_then(Value::as_str) {
                        debug!(
                            target: "ai::responses_cache",
                            "Responses response.created observed: count={}, response_id={}",
                            response_created_count,
                            response_id
                        );
                    }
                    if let Some(cache_key_hash) =
                        extract_response_prompt_cache_key_hash(Some(response))
                    {
                        response_prompt_cache_key_hash = Some(cache_key_hash);
                    }
                }
            }
            "response.output_item.added" => {
                // Track tool calls so we can stream arguments via `response.function_call_arguments.delta`.
                if let Some(item) = event.item.as_ref() {
                    if let Some(tc) = InProgressToolCall::from_item_value(item) {
                        let Some(output_index) = event.output_index else {
                            let error_msg =
                                "Responses function_call output_item.added missing output_index";
                            stats.increment("error:missing_output_index");
                            stats.log_summary("responses_tool_call_missing_output_index");
                            error!("{}", error_msg);
                            let _ = tx_event.send(Err(anyhow!(error_msg)));
                            return;
                        };
                        if let Some(ref call_id) = tc.call_id {
                            tool_call_index_by_id.insert(call_id.clone(), output_index);
                        }
                        saw_function_call = true;
                        tool_calls_by_output_index.insert(output_index, tc);
                    }
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = event.delta.filter(|delta| !delta.is_empty()) {
                    received_text_delta = true;
                    let unified_response = UnifiedResponse {
                        text: Some(delta),
                        ..Default::default()
                    };
                    emit_unified_response(
                        &mut timeout_controller,
                        &tx_event,
                        &mut stats,
                        unified_response,
                    );
                }
            }
            "response.reasoning_text.delta" => {
                if let Some(delta) = event.delta.filter(|delta| !delta.is_empty()) {
                    let unified_response = UnifiedResponse {
                        reasoning_content: Some(delta),
                        reasoning_content_kind: Some(ReasoningContentKind::Reasoning),
                        ..Default::default()
                    };
                    emit_unified_response(
                        &mut timeout_controller,
                        &tx_event,
                        &mut stats,
                        unified_response,
                    );
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = event.delta.filter(|delta| !delta.is_empty()) {
                    let delta = separate_reasoning_summary_part(
                        &mut last_reasoning_summary_part,
                        event.output_index,
                        event.summary_index,
                        delta,
                    );
                    let unified_response = UnifiedResponse {
                        reasoning_content: Some(delta),
                        reasoning_content_kind: Some(ReasoningContentKind::Summary),
                        ..Default::default()
                    };
                    emit_unified_response(
                        &mut timeout_controller,
                        &tx_event,
                        &mut stats,
                        unified_response,
                    );
                }
            }
            "response.function_call_arguments.delta" => {
                if let Err(err) = handle_function_call_arguments_delta(
                    &mut timeout_controller,
                    &tx_event,
                    &mut stats,
                    event.output_index,
                    event.delta,
                    &mut tool_calls_by_output_index,
                ) {
                    let error_msg = err.to_string();
                    stats.increment("error:function_call_arguments_delta");
                    stats.log_summary("responses_function_call_arguments_delta_error");
                    error!("{}", error_msg);
                    let _ = tx_event.send(Err(anyhow!(error_msg)));
                    return;
                }
            }
            "response.output_item.done" => {
                let Some(item_value) = event.item else {
                    continue;
                };
                if let Some(output_index) = event.output_index {
                    done_items_by_output_index.insert(output_index, item_value.clone());
                } else {
                    done_items_complete = false;
                }

                // For tool calls, prefer streaming deltas and only use item.done as a tail-filler / fallback.
                if item_value.get("type").and_then(Value::as_str) == Some("function_call") {
                    saw_function_call = true;
                    handle_function_call_output_item_done(
                        &mut timeout_controller,
                        &tx_event,
                        &mut stats,
                        event.output_index,
                        item_value,
                        &mut tool_calls_by_output_index,
                        &mut tool_call_index_by_id,
                    );
                    continue;
                }

                if let Some(mut unified_response) =
                    parse_responses_output_item(item_value, event.output_index)
                {
                    if received_text_delta && unified_response.text.is_some() {
                        unified_response.text = None;
                    }
                    if unified_response.text.is_some() || unified_response.tool_call.is_some() {
                        emit_unified_response(
                            &mut timeout_controller,
                            &tx_event,
                            &mut stats,
                            unified_response,
                        );
                    }
                }
            }
            "response.completed" => {
                if received_finish_reason {
                    continue;
                }
                let model_response_replay = completed_replay_capture(
                    event.response.as_ref(),
                    &done_items_by_output_index,
                    done_items_complete,
                );
                // Best-effort: use the final response object to fill any missing tool-call argument tail.
                if let Some(response_val) = event.response.as_ref() {
                    if let Some(cache_key_hash) =
                        extract_response_prompt_cache_key_hash(Some(response_val))
                    {
                        response_prompt_cache_key_hash = Some(cache_key_hash);
                    }
                    if let Some(output) = response_val.get("output").and_then(Value::as_array) {
                        for (idx, item) in output.iter().enumerate() {
                            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                                continue;
                            }
                            saw_function_call = true;
                            let Some(tc) = tool_calls_by_output_index.get_mut(&idx) else {
                                continue;
                            };
                            let full_args = item
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if tc.args_so_far.len() < full_args.len()
                                && full_args.starts_with(&tc.args_so_far)
                            {
                                let delta = full_args[tc.args_so_far.len()..].to_string();
                                if !delta.is_empty() {
                                    tc.args_so_far.push_str(&delta);
                                    let (id, name) = if tc.sent_header {
                                        (None, None)
                                    } else {
                                        tc.sent_header = true;
                                        (tc.call_id.clone(), tc.name.clone())
                                    };
                                    let unified_response = UnifiedResponse {
                                        tool_call: Some(
                                            crate::stream::types::unified::UnifiedToolCall {
                                                tool_call_index: Some(idx),
                                                id,
                                                name,
                                                arguments: Some(delta),
                                                arguments_is_snapshot: false,
                                            },
                                        ),
                                        ..Default::default()
                                    };
                                    emit_unified_response(
                                        &mut timeout_controller,
                                        &tx_event,
                                        &mut stats,
                                        unified_response,
                                    );
                                }
                            }
                        }
                    }
                }
                match event
                    .response
                    .map(serde_json::from_value::<ResponsesCompleted>)
                {
                    Some(Ok(response)) => {
                        received_finish_reason = true;
                        let unified_response = UnifiedResponse {
                            usage: response.usage.map(Into::into),
                            tool_call_completion: Some(responses_completed_tool_call_completion(
                                saw_function_call,
                            )),
                            finish_reason: Some("stop".to_string()),
                            model_response_replay,
                            ..Default::default()
                        };
                        emit_unified_response(
                            &mut timeout_controller,
                            &tx_event,
                            &mut stats,
                            unified_response,
                        );
                        log_cache_stream_diagnostics(
                            response_created_count,
                            Some(response.id.as_str()),
                            expected_prompt_cache_key_hash.as_deref(),
                            response_prompt_cache_key_hash.as_deref(),
                        );
                        continue;
                    }
                    Some(Err(e)) => {
                        let error_msg =
                            format!("Failed to parse response.completed payload: {}", e);
                        stats.increment("error:completed_payload");
                        stats.log_summary("response_completed_parse_error");
                        error!("{}", error_msg);
                        let _ = tx_event.send(Err(anyhow!(error_msg)));
                        return;
                    }
                    None => {
                        received_finish_reason = true;
                        let unified_response = UnifiedResponse {
                            tool_call_completion: Some(responses_completed_tool_call_completion(
                                saw_function_call,
                            )),
                            finish_reason: Some("stop".to_string()),
                            model_response_replay,
                            ..Default::default()
                        };
                        emit_unified_response(
                            &mut timeout_controller,
                            &tx_event,
                            &mut stats,
                            unified_response,
                        );
                        continue;
                    }
                }
            }
            "response.done" => {
                if received_finish_reason {
                    continue;
                }
                let model_response_replay = completed_replay_capture(
                    event.response.as_ref(),
                    &done_items_by_output_index,
                    done_items_complete,
                );
                if let Some(cache_key_hash) =
                    extract_response_prompt_cache_key_hash(event.response.as_ref())
                {
                    response_prompt_cache_key_hash = Some(cache_key_hash);
                }
                match event.response.map(serde_json::from_value::<ResponsesDone>) {
                    Some(Ok(response)) => {
                        received_finish_reason = true;
                        let unified_response = UnifiedResponse {
                            usage: response.usage.map(Into::into),
                            tool_call_completion: Some(responses_completed_tool_call_completion(
                                saw_function_call,
                            )),
                            finish_reason: Some("stop".to_string()),
                            model_response_replay,
                            ..Default::default()
                        };
                        emit_unified_response(
                            &mut timeout_controller,
                            &tx_event,
                            &mut stats,
                            unified_response,
                        );
                        log_cache_stream_diagnostics(
                            response_created_count,
                            response.id.as_deref(),
                            expected_prompt_cache_key_hash.as_deref(),
                            response_prompt_cache_key_hash.as_deref(),
                        );
                        continue;
                    }
                    Some(Err(e)) => {
                        let error_msg = format!("Failed to parse response.done payload: {}", e);
                        stats.increment("error:done_payload");
                        stats.log_summary("response_done_parse_error");
                        error!("{}", error_msg);
                        let _ = tx_event.send(Err(anyhow!(error_msg)));
                        return;
                    }
                    None => {
                        received_finish_reason = true;
                        let unified_response = UnifiedResponse {
                            tool_call_completion: Some(responses_completed_tool_call_completion(
                                saw_function_call,
                            )),
                            finish_reason: Some("stop".to_string()),
                            model_response_replay,
                            ..Default::default()
                        };
                        emit_unified_response(
                            &mut timeout_controller,
                            &tx_event,
                            &mut stats,
                            unified_response,
                        );
                        continue;
                    }
                }
            }
            "response.failed" => {
                let error_msg = event
                    .response
                    .as_ref()
                    .and_then(|response| response.get("error"))
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Responses API returned response.failed")
                    .to_string();
                stats.increment("error:failed");
                stats.log_summary("response_failed");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            "response.incomplete" => {
                // Prefer returning partial output (rust-genai behavior) instead of hard-failing the round.
                // Still mark finish_reason so the caller can decide how to handle it.
                if received_finish_reason {
                    continue;
                }
                let reason = event
                    .response
                    .as_ref()
                    .and_then(|response| response.get("incomplete_details"))
                    .and_then(|details| details.get("reason"))
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());

                let finish_reason = reason
                    .as_deref()
                    .map(|r| format!("incomplete:{r}"))
                    .unwrap_or_else(|| "incomplete".to_string());
                let completion = match reason.as_deref().map(str::to_ascii_lowercase).as_deref() {
                    Some("max_output_tokens") | Some("max_tokens") => {
                        ToolCallCompletion::OutputLimit
                    }
                    Some("content_filter") => ToolCallCompletion::ContentFiltered,
                    _ => ToolCallCompletion::Unknown,
                };

                let usage = event
                    .response
                    .clone()
                    .and_then(|v| serde_json::from_value::<ResponsesDone>(v).ok())
                    .and_then(|r| r.usage)
                    .map(Into::into);

                received_finish_reason = true;
                let unified_response = UnifiedResponse {
                    usage,
                    tool_call_completion: Some(completion),
                    finish_reason: Some(finish_reason),
                    ..Default::default()
                };
                emit_unified_response(
                    &mut timeout_controller,
                    &tx_event,
                    &mut stats,
                    unified_response,
                );
                continue;
            }
            _ => {}
        }
    }
}

fn separate_reasoning_summary_part(
    last_part: &mut Option<(Option<usize>, usize)>,
    output_index: Option<usize>,
    summary_index: Option<usize>,
    delta: String,
) -> String {
    let Some(summary_index) = summary_index else {
        return delta;
    };
    let current_part = (output_index, summary_index);
    let starts_new_part = last_part.is_some_and(|previous| previous != current_part);
    *last_part = Some(current_part);

    if starts_new_part {
        format!("\n\n{delta}")
    } else {
        delta
    }
}

#[cfg(test)]
mod tests {
    use super::{
        super::stream_stats::StreamStats, completed_replay_capture, extract_api_error,
        extract_api_error_message, handle_function_call_arguments_delta,
        handle_function_call_output_item_done, responses_completed_tool_call_completion,
        separate_reasoning_summary_part, InProgressToolCall, StreamTimeoutController,
    };
    use openbitfun_agent_stream::ToolCallCompletion;
    use openbitfun_core_types::errors::ErrorCategory;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use tokio::sync::mpsc;

    #[test]
    fn response_model_is_an_explicit_lifecycle_observation_including_failures() {
        for kind in [
            "response.created",
            "response.in_progress",
            "response.completed",
            "response.done",
            "response.incomplete",
            "response.failed",
        ] {
            assert_eq!(
                super::response_model_observation(
                    &json!({"type":kind,"response":{"model":"reported-snapshot"}})
                )
                .as_deref(),
                Some("reported-snapshot")
            );
            for response in [
                json!({}),
                json!({"model":null}),
                json!({"model":" "}),
                json!({"model":42}),
            ] {
                assert_eq!(
                    super::response_model_observation(&json!({"type":kind,"response":response})),
                    None
                );
            }
        }
        assert_eq!(
            super::response_model_observation(
                &json!({"type":"response.output_text.delta", "model":"requested-model", "response":{"model":"not-a-response-lifecycle"}})
            ),
            None
        );
    }

    #[test]
    fn extracts_api_error_message_from_response_error() {
        let event = json!({
            "type": "response.failed",
            "response": {
                "error": {
                    "message": "provider error"
                }
            }
        });

        assert_eq!(
            extract_api_error_message(&event).as_deref(),
            Some("provider error")
        );
    }

    #[test]
    fn preserves_context_overflow_code_from_failed_response() {
        let event = json!({
            "type": "response.failed",
            "response": {
                "error": {
                    "code": "context_length_exceeded",
                    "message": "Request failed"
                }
            }
        });

        let error = extract_api_error(&event).expect("provider error");
        assert_eq!(error.category, ErrorCategory::ContextOverflow);
        assert_eq!(
            error.provider_code.as_deref(),
            Some("context_length_exceeded")
        );
    }

    #[test]
    fn streamed_usage_limit_is_quota_with_its_reset_hint() {
        let event = json!({
            "type": "response.failed",
            "response": {
                "error": {
                    "type": "usage_limit_reached",
                    "message": "The usage limit has been reached",
                    "resets_in_seconds": 120
                }
            }
        });

        let error = extract_api_error(&event).expect("provider error");
        assert_eq!(error.category, ErrorCategory::ProviderQuota);
        assert_eq!(error.retry_after_ms, Some(120_000));
    }

    #[test]
    fn returns_none_when_no_response_error_exists() {
        let event = json!({
            "type": "response.created",
            "response": {
                "id": "resp_1"
            }
        });

        assert!(extract_api_error_message(&event).is_none());
    }

    #[test]
    fn returns_none_when_response_error_is_null() {
        let event = json!({
            "type": "response.created",
            "response": {
                "id": "resp_1",
                "error": null
            }
        });

        assert!(extract_api_error_message(&event).is_none());
    }

    #[test]
    fn completed_responses_stream_marks_tool_use_only_when_a_function_call_was_seen() {
        assert_eq!(
            responses_completed_tool_call_completion(true),
            ToolCallCompletion::NormalToolUse
        );
        assert_eq!(
            responses_completed_tool_call_completion(false),
            ToolCallCompletion::NormalNoToolUse
        );
    }

    #[test]
    fn reasoning_summary_deltas_in_the_same_part_stay_contiguous() {
        let mut last_part = None;

        assert_eq!(
            separate_reasoning_summary_part(&mut last_part, Some(0), Some(0), "**First".into()),
            "**First"
        );
        assert_eq!(
            separate_reasoning_summary_part(&mut last_part, Some(0), Some(0), " part**".into()),
            " part**"
        );
    }

    #[test]
    fn reasoning_summary_inserts_a_paragraph_boundary_between_parts() {
        let mut last_part = None;
        let first = separate_reasoning_summary_part(
            &mut last_part,
            Some(0),
            Some(0),
            "**First part**".into(),
        );
        let second = separate_reasoning_summary_part(
            &mut last_part,
            Some(0),
            Some(1),
            "**Second part**".into(),
        );

        assert_eq!(
            format!("{first}{second}"),
            "**First part**\n\n**Second part**"
        );
    }

    #[test]
    fn reasoning_summary_without_an_index_keeps_gateway_compatibility() {
        let mut last_part = Some((Some(0), 0));

        assert_eq!(
            separate_reasoning_summary_part(&mut last_part, Some(0), None, "delta".into()),
            "delta"
        );
    }

    #[test]
    fn output_item_done_falls_back_when_output_index_is_untracked() {
        let (tx_event, mut rx_event) = mpsc::unbounded_channel();
        let mut tool_calls_by_output_index: HashMap<usize, InProgressToolCall> = HashMap::new();
        let mut tool_call_index_by_id: HashMap<String, usize> = HashMap::new();
        let mut stats = StreamStats::new("Responses");
        let mut timeout_controller = StreamTimeoutController::new(None, None);

        handle_function_call_output_item_done(
            &mut timeout_controller,
            &tx_event,
            &mut stats,
            Some(3),
            json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "get_weather",
                "arguments": "{\"city\":\"Beijing\"}"
            }),
            &mut tool_calls_by_output_index,
            &mut tool_call_index_by_id,
        );

        let response = rx_event
            .try_recv()
            .expect("tool call event")
            .expect("ok response");
        let tool_call = response.tool_call.expect("tool call");
        assert_eq!(tool_call.tool_call_index, Some(3));
        assert_eq!(tool_call.id.as_deref(), Some("call_1"));
        assert_eq!(tool_call.name.as_deref(), Some("get_weather"));
        assert_eq!(
            tool_call.arguments.as_deref(),
            Some("{\"city\":\"Beijing\"}")
        );
    }

    #[test]
    fn function_call_delta_requires_output_index() {
        let (tx_event, _rx_event) = mpsc::unbounded_channel();
        let mut tool_calls_by_output_index: HashMap<usize, InProgressToolCall> = HashMap::new();
        let mut stats = StreamStats::new("Responses");
        let mut timeout_controller = StreamTimeoutController::new(None, None);

        let err = handle_function_call_arguments_delta(
            &mut timeout_controller,
            &tx_event,
            &mut stats,
            None,
            Some("{\"city\"".to_string()),
            &mut tool_calls_by_output_index,
        )
        .expect_err("missing output_index should fail");

        assert!(err.to_string().contains("missing output_index"));
    }

    #[test]
    fn function_call_delta_requires_tracked_output_item() {
        let (tx_event, _rx_event) = mpsc::unbounded_channel();
        let mut tool_calls_by_output_index: HashMap<usize, InProgressToolCall> = HashMap::new();
        let mut stats = StreamStats::new("Responses");
        let mut timeout_controller = StreamTimeoutController::new(None, None);

        let err = handle_function_call_arguments_delta(
            &mut timeout_controller,
            &tx_event,
            &mut stats,
            Some(2),
            Some("{\"city\"".to_string()),
            &mut tool_calls_by_output_index,
        )
        .expect_err("untracked output_index should fail");

        assert!(err.to_string().contains("untracked output_index 2"));
    }

    #[test]
    fn completed_output_is_authoritative_for_replay_layout() {
        let done_items = BTreeMap::from([(
            0,
            json!({ "type": "reasoning", "encrypted_content": "stale", "summary": [] }),
        )]);
        let response = json!({
            "output": [
                { "type": "reasoning", "encrypted_content": "final", "summary": [] },
                { "type": "message", "role": "assistant", "content": [] }
            ]
        });

        let capture =
            completed_replay_capture(Some(&response), &done_items, true).expect("terminal capture");
        assert_eq!(capture.items.len(), 2);
        assert!(matches!(
            &capture.items[0],
            openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { opaque_state, .. }
                if opaque_state == "final"
        ));
    }

    #[test]
    fn completed_empty_output_falls_back_to_ordered_done_items() {
        let done_items = BTreeMap::from([
            (
                0,
                json!({ "type": "reasoning", "encrypted_content": "opaque", "summary": [] }),
            ),
            (1, json!({ "type": "function_call", "call_id": "call_1" })),
        ]);
        let response = json!({ "output": [] });

        let capture = completed_replay_capture(Some(&response), &done_items, true)
            .expect("done-item fallback");
        assert_eq!(capture.items.len(), 2);
    }

    #[test]
    fn completed_output_without_opaque_state_falls_back_to_equivalent_done_items() {
        let done_items = BTreeMap::from([
            (
                0,
                json!({ "type": "reasoning", "encrypted_content": "opaque", "summary": [] }),
            ),
            (
                1,
                json!({ "type": "message", "role": "assistant", "content": [] }),
            ),
        ]);
        let response = json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "message", "role": "assistant", "content": [] }
            ]
        });

        let capture = completed_replay_capture(Some(&response), &done_items, true)
            .expect("equivalent done-item fallback");
        assert!(matches!(
            &capture.items[0],
            openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { opaque_state, .. }
                if opaque_state == "opaque"
        ));
    }

    #[test]
    fn completed_output_does_not_fall_back_to_a_shorter_done_item_subset() {
        let done_items = BTreeMap::from([(
            0,
            json!({ "type": "reasoning", "encrypted_content": "opaque", "summary": [] }),
        )]);
        let response = json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "message", "role": "assistant", "content": [] }
            ]
        });

        assert!(completed_replay_capture(Some(&response), &done_items, true).is_none());
    }

    #[test]
    fn incomplete_done_item_sequence_is_not_persisted() {
        let done_items = BTreeMap::from([
            (
                0,
                json!({ "type": "reasoning", "encrypted_content": "opaque", "summary": [] }),
            ),
            (
                2,
                json!({ "type": "message", "role": "assistant", "content": [] }),
            ),
        ]);

        assert!(completed_replay_capture(None, &done_items, true).is_none());
        assert!(completed_replay_capture(None, &done_items, false).is_none());
    }
}
