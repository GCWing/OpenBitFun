//! Product deferred-tool loaded-spec state owner.

use crate::agentic::core::{Message, MessageContent};
use openbitfun_agent_tools::{
    collect_loaded_deferred_tool_specs, GetToolSpecLoadObservation, LoadedDeferredToolSpec,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProductLoadedDeferredToolSpecs {
    loaded_specs: Vec<LoadedDeferredToolSpec>,
}

impl ProductLoadedDeferredToolSpecs {
    pub(crate) fn from_messages(messages: &[Message], deferred_tools: &[String]) -> Self {
        let deferred_names = deferred_tools
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let mut loaded_by_name = BTreeMap::new();
        for message in messages {
            if let Some(observation) = get_tool_spec_load_observation(message) {
                for spec in collect_loaded_deferred_tool_specs(
                    &[observation],
                    deferred_tools,
                    crate::agentic::tools::registry::GET_TOOL_SPEC_TOOL_NAME,
                ) {
                    loaded_by_name.insert(spec.tool_name.clone(), spec);
                }
            }
            let is_ptc_run_code = matches!(
                &message.content,
                MessageContent::ToolResult { tool_name, .. } if tool_name == "RunCode"
            );
            if is_ptc_run_code {
                for spec in &message.metadata.ptc_loaded_deferred_tool_specs {
                    if deferred_names.contains(spec.tool_name.as_str()) {
                        loaded_by_name.insert(spec.tool_name.clone(), spec.clone());
                    }
                }
            }
            if let MessageContent::ToolResult {
                tool_name,
                result,
                is_error: false,
                ..
            } = &message.content
            {
                if tool_name != "RunCode" {
                    continue;
                }
                if let Some(specs) = result
                    .get("__ptc_loaded_deferred_tool_specs")
                    .cloned()
                    .and_then(|value| {
                        serde_json::from_value::<Vec<LoadedDeferredToolSpec>>(value).ok()
                    })
                {
                    for spec in specs {
                        if deferred_names.contains(spec.tool_name.as_str()) {
                            loaded_by_name.insert(spec.tool_name.clone(), spec);
                        }
                    }
                }
            }
        }

        Self {
            loaded_specs: loaded_by_name.into_values().collect(),
        }
    }

    #[cfg(test)]
    fn is_loaded(&self, tool_name: &str) -> bool {
        self.loaded_specs
            .iter()
            .any(|spec| spec.tool_name == tool_name)
    }

    pub(crate) fn into_loaded_specs(self) -> Vec<LoadedDeferredToolSpec> {
        self.loaded_specs
    }
}

pub(crate) fn collect_product_loaded_deferred_tool_specs(
    messages: &[Message],
    deferred_tools: &[String],
) -> Vec<LoadedDeferredToolSpec> {
    ProductLoadedDeferredToolSpecs::from_messages(messages, deferred_tools).into_loaded_specs()
}

fn get_tool_spec_load_observation(message: &Message) -> Option<GetToolSpecLoadObservation<'_>> {
    let MessageContent::ToolResult {
        tool_name,
        result,
        is_error,
        ..
    } = &message.content
    else {
        return None;
    };

    Some(GetToolSpecLoadObservation {
        tool_name,
        loaded_tool_name: result.get("tool_name").and_then(|v| v.as_str()),
        catalog_generation: result.get("catalog_generation").and_then(|v| v.as_u64()),
        is_error: *is_error,
    })
}

#[cfg(test)]
mod tests {
    use super::{collect_product_loaded_deferred_tool_specs, ProductLoadedDeferredToolSpecs};
    use crate::agentic::core::{Message, ToolCall, ToolResult};
    use crate::agentic::session::ContextCompressor;
    use openbitfun_agent_tools::{
        resolve_get_tool_spec_execution_plan, validate_deferred_tool_usage,
        GetToolSpecExecutionPlan, GET_TOOL_SPEC_TOOL_NAME,
    };
    use serde_json::json;

    fn loaded_spec(tool_name: &str) -> openbitfun_agent_tools::LoadedDeferredToolSpec {
        openbitfun_agent_tools::LoadedDeferredToolSpec {
            tool_name: tool_name.to_string(),
            catalog_generation: 42,
        }
    }

    #[test]
    fn compaction_drops_receipt_without_blocking_deferred_execution() {
        let deferred_tools = vec!["Cron".to_string()];
        let input = json!({ "tool_name": "Cron" });
        let spec_result = Message::tool_result(ToolResult {
            tool_id: "load-cron".to_string(),
            tool_name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
            effective_tool_name: None,
            result: json!({
                "tool_name": "Cron",
                "catalog_generation": 42,
                "description": "Manage scheduled jobs.",
                "input_schema": { "type": "object", "properties": { "action": { "enum": ["list"] } } },
            }),
            result_for_assistant: None,
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        });
        let history = vec![
            Message::user("Check the scheduled jobs.".to_string()),
            Message::assistant_with_tools(
                String::new(),
                vec![ToolCall {
                    tool_id: "load-cron".to_string(),
                    tool_name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
                    arguments: input.clone(),
                    raw_arguments: None,
                    is_error: false,
                    parse_error: None,
                    recovered_from_truncation: false,
                    repair_kind: Default::default(),
                }],
            ),
            spec_result.clone(),
        ];
        let compressor = ContextCompressor::new();

        // The same summary may be generated with or without a retained tool
        // result. Only the actual retained result is an execution receipt.
        for (recent_tokens, retains_spec) in [(0, false), (10_000, true)] {
            let plan = compressor
                .plan_compression("session", &history, 128_000, recent_tokens)
                .unwrap()
                .unwrap();
            let mut compressed = compressor
                .compress_plan_with_contract(
                    "session",
                    plan,
                    None,
                    "The Cron definition was loaded with GetToolSpec earlier.".to_string(),
                )
                .unwrap()
                .messages;
            let loaded = collect_product_loaded_deferred_tool_specs(&compressed, &deferred_tools);
            let admission = validate_deferred_tool_usage(
                "Cron",
                &deferred_tools,
                &loaded,
                42,
                GET_TOOL_SPEC_TOOL_NAME,
            );
            let names = loaded
                .iter()
                .map(|spec| spec.tool_name.clone())
                .collect::<Vec<_>>();
            let reload_plan = resolve_get_tool_spec_execution_plan(&input, &names).unwrap();

            if retains_spec {
                assert_eq!(loaded, vec![loaded_spec("Cron")]);
                assert!(admission.is_ok());
                assert!(matches!(
                    reload_plan,
                    GetToolSpecExecutionPlan::DuplicateLoad(_)
                ));
            } else {
                assert!(loaded.is_empty());
                admission.expect("a missing loaded-spec receipt must not block deferred execution");
                assert!(matches!(
                    reload_plan,
                    GetToolSpecExecutionPlan::LoadDetail { tool_name: "Cron" }
                ));

                // Reading the definition again restores the receipt and avoids a
                // redundant load, while execution was already allowed above.
                compressed.push(spec_result.clone());
                let reloaded =
                    collect_product_loaded_deferred_tool_specs(&compressed, &deferred_tools);
                validate_deferred_tool_usage(
                    "Cron",
                    &deferred_tools,
                    &reloaded,
                    42,
                    GET_TOOL_SPEC_TOOL_NAME,
                )
                .expect("a fresh spec should remain valid after compaction");
            }
        }
    }

    #[test]
    fn product_loaded_spec_state_collects_visible_get_tool_spec_results() {
        let visible_get_tool_spec_result = Message::tool_result(ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: "GetToolSpec".to_string(),
            effective_tool_name: None,
            result: json!({
                "tool_name": "WebFetch",
                "catalog_generation": 42,
            }),
            result_for_assistant: None,
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        });
        let hidden_get_tool_spec_result = Message::tool_result(ToolResult {
            tool_id: "tool-2".to_string(),
            tool_name: "GetToolSpec".to_string(),
            effective_tool_name: None,
            result: json!({
                "tool_name": "Read",
                "catalog_generation": 42,
            }),
            result_for_assistant: None,
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        });
        let failed_get_tool_spec_result = Message::tool_result(ToolResult {
            tool_id: "tool-3".to_string(),
            tool_name: "GetToolSpec".to_string(),
            effective_tool_name: None,
            result: json!({
                "tool_name": "GetFileDiff",
                "catalog_generation": 42,
            }),
            result_for_assistant: None,
            is_error: true,
            duration_ms: Some(1),
            image_attachments: None,
        });

        let loaded_specs = collect_product_loaded_deferred_tool_specs(
            &[
                visible_get_tool_spec_result,
                hidden_get_tool_spec_result,
                failed_get_tool_spec_result,
            ],
            &["WebFetch".to_string(), "GetFileDiff".to_string()],
        );

        assert_eq!(loaded_specs, vec![loaded_spec("WebFetch")]);
    }

    #[test]
    fn product_loaded_spec_state_dedupes_and_filters_results() {
        let loaded_specs = collect_product_loaded_deferred_tool_specs(
            &[
                Message::tool_result(ToolResult {
                    tool_id: "tool-1".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "WebFetch",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-2".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "WebFetch",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-3".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "Worktree",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-4".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "Read",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-5".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "GetFileDiff",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: true,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-6".to_string(),
                    tool_name: "GetToolSpec".to_string(),
                    effective_tool_name: None,
                    result: json!({
                        "tool_name": 42,
                    }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
                Message::tool_result(ToolResult {
                    tool_id: "tool-7".to_string(),
                    tool_name: "Read".to_string(),
                    effective_tool_name: None,
                    result: json!({
                            "tool_name": "GetFileDiff",
                    "catalog_generation": 42,
                        }),
                    result_for_assistant: None,
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                }),
            ],
            &[
                "WebFetch".to_string(),
                "GetFileDiff".to_string(),
                "Worktree".to_string(),
            ],
        );

        assert_eq!(
            loaded_specs,
            vec![loaded_spec("WebFetch"), loaded_spec("Worktree")]
        );
    }

    #[test]
    fn product_deferred_loaded_spec_state_preserves_message_derived_lifecycle() {
        let state = ProductLoadedDeferredToolSpecs::from_messages(
            &[Message::tool_result(ToolResult {
                tool_id: "tool-1".to_string(),
                tool_name: "GetToolSpec".to_string(),
                effective_tool_name: None,
                result: json!({
                    "tool_name": "Worktree",
                "catalog_generation": 42,
                }),
                result_for_assistant: None,
                is_error: false,
                duration_ms: Some(1),
                image_attachments: None,
            })],
            &["Worktree".to_string(), "WebFetch".to_string()],
        );

        assert!(state.is_loaded("Worktree"));
        assert!(!state.is_loaded("WebFetch"));
        assert_eq!(state.into_loaded_specs(), vec![loaded_spec("Worktree")]);
    }

    #[test]
    fn product_loaded_spec_state_collects_ptc_run_code_receipts() {
        let run_code_result = Message::tool_result(ToolResult {
            tool_id: "run-code-1".to_string(),
            tool_name: "RunCode".to_string(),
            effective_tool_name: None,
            result: json!({
                "value": {"ok": true},
                "__ptc_loaded_deferred_tool_specs": [{
                    "tool_name": "mcp__threejs__show_threejs_scene",
                    "catalog_generation": 42,
                }],
            }),
            result_for_assistant: Some("{\"ok\":true}".to_string()),
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        });

        let loaded = collect_product_loaded_deferred_tool_specs(
            &[run_code_result.clone()],
            &["mcp__threejs__show_threejs_scene".to_string()],
        );

        assert_eq!(
            loaded,
            vec![loaded_spec("mcp__threejs__show_threejs_scene")]
        );

        let native_result = Message::tool_result(ToolResult {
            tool_id: "native-spec-1".to_string(),
            tool_name: "GetToolSpec".to_string(),
            effective_tool_name: None,
            result: json!({
                "tool_name": "mcp__threejs__show_threejs_scene",
                "catalog_generation": 43,
            }),
            result_for_assistant: None,
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        });
        // Native and PTC receipts must retain message order when refreshing
        // the same tool's catalog generation.
        for (messages, expected_generation) in [
            (vec![run_code_result.clone(), native_result.clone()], 43),
            (vec![native_result, run_code_result], 42),
        ] {
            let loaded = collect_product_loaded_deferred_tool_specs(
                &messages,
                &["mcp__threejs__show_threejs_scene".to_string()],
            );
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].catalog_generation, expected_generation);
        }
    }
}
