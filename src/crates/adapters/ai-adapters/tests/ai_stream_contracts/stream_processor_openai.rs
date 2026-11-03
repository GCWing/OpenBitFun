use crate::common::sse_fixture_server::FixtureSseServerOptions;
use crate::common::stream_test_harness::{
    run_stream_fixture, run_stream_fixture_with_options, StreamFixtureProvider,
    StreamFixtureRunOptions,
};
use openbitfun_events::{AgenticEvent, ToolEventData};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_keeps_collecting_tool_args_across_usage_chunks() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_args_split_with_usage.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_a");
    assert_eq!(result.tool_calls[0].arguments, json!({ "a": 1 }));
    assert!(!result.tool_calls[0].is_error);
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(7)
    );

    let early_detected = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } if round_id == "round_fixture" && identity.tool_id == "call_1" && identity.tool_name == "tool_a"
        )
    });
    assert!(early_detected, "expected early tool detection event");

    let partial_params: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::ParamsPartial { params, .. },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(params.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(partial_params.len(), 2);
    assert!(partial_params.contains(&"{\"a\":"));
    assert!(partial_params.contains(&"1}"));

    let failed_or_cancelled = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::DialogTurnFailed { .. } | AgenticEvent::DialogTurnCancelled { .. }
        )
    });
    assert!(
        !failed_or_cancelled,
        "successful fixture should not emit failure or cancellation events"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_ignores_blank_finish_reason_until_tool_call_completion() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_args_blank_finish_reason.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "Read");
    assert_eq!(
        result.tool_calls[0].arguments,
        json!({ "path": "src/main.rs" })
    );
    assert!(!result.tool_calls[0].is_error);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_keeps_malformed_tool_arguments_invalid() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/thinking_text_three_tools_with_empty_toolcall_anomaly.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.full_thinking, "Need to think first. ");
    assert_eq!(result.full_text, "Answer before tools. ");
    assert_eq!(result.tool_calls.len(), 3);

    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_one");
    assert_eq!(result.tool_calls[0].arguments, json!({ "x": 1 }));
    assert!(!result.tool_calls[0].is_error);

    assert_eq!(result.tool_calls[1].tool_id, "call_2");
    assert_eq!(result.tool_calls[1].tool_name, "tool_two");
    assert_eq!(result.tool_calls[1].arguments, json!({ "y": 2 }));
    assert!(!result.tool_calls[1].is_error);

    assert_eq!(result.tool_calls[2].tool_id, "call_3");
    assert_eq!(result.tool_calls[2].tool_name, "tool_three");
    assert_eq!(result.tool_calls[2].arguments, json!({}));
    assert!(
        result.tool_calls[2].is_error,
        "malformed JSON must be reported back to the model, not repaired"
    );

    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(12)
    );
    let thinking_end_count = output
        .events
        .iter()
        .filter(|event| matches!(event, AgenticEvent::ThinkingChunk { is_end: true, .. }))
        .count();
    assert_eq!(thinking_end_count, 1);

    let early_detected_ids: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(identity.tool_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(early_detected_ids, vec!["call_1", "call_2", "call_3"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_parses_reasoning_alias_into_thinking() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/reasoning_alias_text.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.full_thinking, "First reason. Then answer.");
    assert!(result.reasoning_content_present);
    assert_eq!(result.full_text, "Final answer.");
    assert!(result.tool_calls.is_empty());
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(8)
    );

    let thinking_chunks: Vec<(&str, bool)> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ThinkingChunk {
                content, is_end, ..
            } => Some((content.as_str(), *is_end)),
            _ => None,
        })
        .collect();
    assert_eq!(
        thinking_chunks,
        vec![
            ("First reason. ", false),
            ("Then answer.", false),
            ("", true)
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_parses_inline_think_tags_into_reasoning_content() {
    let output = run_stream_fixture_with_options(
        StreamFixtureProvider::OpenAi,
        "stream/openai/inline_think_text.sse",
        StreamFixtureRunOptions {
            openai_inline_think_in_text: true,
            ..Default::default()
        },
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(
        result.full_thinking,
        "I should inspect the data. Then answer carefully."
    );
    assert_eq!(result.full_text, "Final answer.");
    assert!(result.tool_calls.is_empty());
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(10)
    );

    let thinking_chunks: Vec<(&str, bool)> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ThinkingChunk {
                content, is_end, ..
            } => Some((content.as_str(), *is_end)),
            _ => None,
        })
        .collect();
    assert_eq!(
        thinking_chunks,
        vec![
            ("I should inspect the data.", false),
            (" Then answer carefully.", false),
            ("", true),
        ]
    );

    let text_chunks: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::TextChunk { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text_chunks, vec!["Final answer."]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_reattaches_id_only_prelude_to_following_payload_chunk() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_id_prelude_then_payload_without_id.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_a");
    assert_eq!(result.tool_calls[0].arguments, json!({ "city": "Beijing" }));
    assert!(!result.tool_calls[0].is_error);
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(9)
    );

    let early_detected = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } if round_id == "round_fixture" && identity.tool_id == "call_1" && identity.tool_name == "tool_a"
        )
    });
    assert!(
        early_detected,
        "expected reattached tool id to trigger early detection"
    );

    let partial_params: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::ParamsPartial { params, .. },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(params.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(partial_params, vec!["{\"city\":\"Beijing\"}"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_keeps_appending_tool_args_after_stop_reason_chunk() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_args_snapshot_stop_reason.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_a");
    assert_eq!(result.tool_calls[0].arguments, json!({ "city": "Beijing" }));
    assert!(!result.tool_calls[0].is_error);
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(9)
    );

    let partial_params: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                tool_event: ToolEventData::ParamsPartial { params, .. },
                ..
            } => Some(params.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(partial_params, vec!["{\"city\":\"Bei", "jing\"}"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_filters_unseen_id_only_orphan_tool_chunk() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_id_only_orphan_filtered.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert!(result.full_thinking.is_empty());
    assert!(result.full_text.is_empty());
    assert!(result.tool_calls.is_empty());
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(9)
    );

    let tool_events = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::ToolEvent {
                tool_event: ToolEventData::EarlyDetected { .. }
                    | ToolEventData::ParamsPartial { .. },
                ..
            }
        )
    });
    assert!(
        !tool_events,
        "id-only orphan chunk should not emit any tool lifecycle events"
    );

    let failed_or_cancelled = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::DialogTurnFailed { .. } | AgenticEvent::DialogTurnCancelled { .. }
        )
    });
    assert!(
        !failed_or_cancelled,
        "filtered orphan chunk should still complete the stream normally"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_filters_orphan_id_only_block_when_it_shares_chunk_with_first_tool_tail() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/two_tools_first_final_chunk_contains_orphan_id_only.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 2);

    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_one");
    assert_eq!(result.tool_calls[0].arguments, json!({ "x": 1 }));
    assert!(!result.tool_calls[0].is_error);

    assert_eq!(result.tool_calls[1].tool_id, "call_2");
    assert_eq!(result.tool_calls[1].tool_name, "tool_two");
    assert_eq!(result.tool_calls[1].arguments, json!({ "y": 2 }));
    assert!(!result.tool_calls[1].is_error);

    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(11)
    );

    let early_detected_ids: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(identity.tool_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(early_detected_ids, vec!["call_1", "call_2"]);

    let partial_params: Vec<(&str, &str)> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event:
                    ToolEventData::ParamsPartial {
                        identity, params, ..
                    },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some((identity.tool_id.as_str(), params.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        partial_params,
        vec![
            ("call_1", "{\"x\":"),
            ("call_1", "1}"),
            ("call_2", "{\"y\":2}"),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_routes_interleaved_tool_args_by_index() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/interleaved_parallel_tool_args_by_index.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 2);

    assert_eq!(result.tool_calls[0].tool_id, "call_1");
    assert_eq!(result.tool_calls[0].tool_name, "tool_one");
    assert_eq!(result.tool_calls[0].arguments, json!({ "x": 1 }));
    assert!(!result.tool_calls[0].is_error);

    assert_eq!(result.tool_calls[1].tool_id, "call_2");
    assert_eq!(result.tool_calls[1].tool_name, "tool_two");
    assert_eq!(result.tool_calls[1].arguments, json!({ "y": 2 }));
    assert!(!result.tool_calls[1].is_error);

    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(10)
    );

    let early_detected_ids: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(identity.tool_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(early_detected_ids, vec!["call_1", "call_2"]);

    let partial_params: Vec<(&str, &str)> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event:
                    ToolEventData::ParamsPartial {
                        identity, params, ..
                    },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some((identity.tool_id.as_str(), params.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        partial_params,
        vec![("call_1", "{\"x\":1}"), ("call_2", "{\"y\":2}")]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_accepts_tool_call_without_type_field() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_call_missing_type_field.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_abc123");
    assert_eq!(result.tool_calls[0].tool_name, "test_tool");
    assert_eq!(result.tool_calls[0].arguments, json!({ "value": "hello" }));
    assert!(!result.tool_calls[0].is_error);
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(15)
    );

    let early_detected = output.events.iter().any(|event| {
        matches!(
            event,
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } if round_id == "round_fixture" && identity.tool_id == "call_abc123" && identity.tool_name == "test_tool"
        )
    });
    assert!(
        early_detected,
        "missing type field should still trigger tool early detection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_fixture_ignores_trailing_empty_tool_args_finish_chunk() {
    let output = run_stream_fixture(
        StreamFixtureProvider::OpenAi,
        "stream/openai/tool_call_trailing_empty_args_finish_chunk.sse",
        FixtureSseServerOptions::default(),
    )
    .await;

    let result = output.result.expect("stream result");

    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tool_id, "call_tail_1");
    assert_eq!(result.tool_calls[0].tool_name, "search_google");
    assert_eq!(
        result.tool_calls[0].arguments,
        json!({ "query": "latest news on ai" })
    );
    assert!(!result.tool_calls[0].is_error);
    assert_eq!(
        result.usage.as_ref().map(|usage| usage.total_token_count),
        Some(246)
    );

    let early_detected_ids: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::EarlyDetected { identity },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(identity.tool_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(early_detected_ids, vec!["call_tail_1"]);

    let partial_params: Vec<&str> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgenticEvent::ToolEvent {
                round_id,
                tool_event: ToolEventData::ParamsPartial { params, .. },
                ..
            } => {
                assert_eq!(round_id, "round_fixture");
                Some(params.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        partial_params,
        vec!["{\"query\":\"latest", " news", " on ai\"}"]
    );
}
