//! Shared handling for oversized tool results.
//!
//! The model should not receive unbounded tool output. Large outputs are stored
//! under the session runtime directory and replaced, for the assistant only, by
//! a small preview plus a stable reference to the full content.

use crate::agentic::core::ToolResult;
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, warn};
use openbitfun_agent_tools::{
    build_persisted_tool_output_message, count_tool_result_lines, generate_tool_result_preview,
    sanitize_tool_result_file_component, select_tool_result_indices_for_persistence,
    tool_result_is_persisted_output, PersistedToolOutput, ToolResultPersistenceCandidate,
    ToolResultStoragePolicy, GET_TOOL_SPEC_TOOL_NAME,
};
#[cfg(test)]
use openbitfun_agent_tools::{DEFAULT_MAX_TOOL_RESULT_CHARS, PERSISTED_OUTPUT_TAG};
use std::collections::HashSet;
use std::path::Path;

/// Keep in sync with `FileReadTool::DEFAULT_READ_MAX_TOTAL_CHARS` plus wrapper overhead.
pub(crate) const READ_MAX_TOOL_RESULT_CHARS: usize = 72_000;

const READ_TOOL_NAME: &str = "Read";

fn effective_tool_name(result: &ToolResult) -> &str {
    result
        .effective_tool_name
        .as_deref()
        .unwrap_or(&result.tool_name)
}

#[cfg(test)]
pub(crate) async fn maybe_persist_large_tool_result(
    result: ToolResult,
    context: &ToolUseContext,
) -> ToolResult {
    let effective_tool_name = effective_tool_name(&result).to_string();
    maybe_persist_large_tool_result_for_tool(result, &effective_tool_name, context).await
}

pub(crate) async fn maybe_persist_large_tool_result_for_tool(
    mut result: ToolResult,
    effective_tool_name: &str,
    context: &ToolUseContext,
) -> ToolResult {
    let policy = ToolResultStoragePolicy::default();
    if should_skip_tool_result(&result, effective_tool_name)
        || visible_content_is_compacted(&result)
    {
        return result;
    }

    let per_tool_limit = effective_per_tool_limit(effective_tool_name, policy);
    let visible_chars = result_visible_content(&result).chars().count();
    if visible_chars <= per_tool_limit && !json_result_is_oversized(&result, per_tool_limit) {
        return result;
    }

    match persist_and_render_replacement(&result, context, policy, None).await {
        Ok(replacement) => {
            result.result_for_assistant = Some(replacement);
            result
        }
        Err(error) => {
            warn!(
                "Failed to persist oversized tool result: tool_name={}, tool_id={}, error={}",
                effective_tool_name, result.tool_id, error
            );
            result
        }
    }
}

pub(crate) async fn apply_round_tool_result_budget(
    mut results: Vec<ToolResult>,
    context: &ToolUseContext,
) -> Vec<ToolResult> {
    let policy = ToolResultStoragePolicy::default();
    let candidates = collect_round_budget_candidates(&results);
    let total_visible_chars = candidates
        .iter()
        .map(|candidate| candidate.visible_chars)
        .sum::<usize>();

    if total_visible_chars <= policy.per_round_limit_chars {
        return results;
    }

    let selected = select_tool_result_indices_for_persistence(
        &candidates,
        total_visible_chars,
        policy.per_round_limit_chars,
    );
    if selected.is_empty() {
        return results;
    }

    let selected_indices = selected.into_iter().collect::<HashSet<_>>();
    let mut replaced_count = 0usize;
    for (index, result) in results.iter_mut().enumerate() {
        if !selected_indices.contains(&index) {
            continue;
        }

        match persist_and_render_replacement(result, context, policy, None).await {
            Ok(replacement) => {
                result.result_for_assistant = Some(replacement);
                replaced_count += 1;
            }
            Err(error) => {
                warn!(
                    "Failed to persist round-budget tool result: tool_name={}, tool_id={}, error={}",
                    effective_tool_name(result), result.tool_id, error
                );
            }
        }
    }

    if replaced_count > 0 {
        debug!(
            "Round tool result budget enforced: replaced={}, total_visible_chars={}, limit={}",
            replaced_count, total_visible_chars, policy.per_round_limit_chars
        );
    }

    results
}

fn should_skip_tool_result(result: &ToolResult, effective_tool_name: &str) -> bool {
    effective_tool_name == GET_TOOL_SPEC_TOOL_NAME
        || result
            .image_attachments
            .as_ref()
            .is_some_and(|v| !v.is_empty())
}

fn collect_round_budget_candidates(results: &[ToolResult]) -> Vec<ToolResultPersistenceCandidate> {
    results
        .iter()
        .enumerate()
        .filter(|(_, result)| !should_skip_tool_result(result, effective_tool_name(result)))
        .filter(|(_, result)| !visible_content_is_compacted(result))
        .map(|(index, result)| ToolResultPersistenceCandidate {
            index,
            visible_chars: result_visible_content(result).chars().count(),
        })
        .collect()
}

async fn persist_and_render_replacement(
    result: &ToolResult,
    context: &ToolUseContext,
    policy: ToolResultStoragePolicy,
    content_override: Option<String>,
) -> OpenBitFunResult<String> {
    let persisted =
        persist_tool_result(result, context, policy.preview_chars, content_override).await?;
    Ok(build_persisted_tool_output_message(
        &persisted,
        policy.preview_chars,
    ))
}

async fn persist_tool_result(
    result: &ToolResult,
    context: &ToolUseContext,
    preview_chars: usize,
    content_override: Option<String>,
) -> OpenBitFunResult<PersistedToolOutput> {
    let session_id = context.session_id.as_deref().ok_or_else(|| {
        OpenBitFunError::tool("A session id is required to persist tool results".to_string())
    })?;

    let (serialized, is_json) = if let Some(content) = content_override {
        (content, false)
    } else {
        serialize_tool_result_content(result)?
    };
    let file_name = tool_result_file_name(&result.tool_id, is_json);
    let path = context.current_workspace_session_tool_result_path(session_id, &file_name)?;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to create tool result directory {}: {}",
                parent.display(),
                error
            ))
        })?;
    }

    write_once(&path, &serialized).await?;

    let reference = context
        .build_session_runtime_artifact_reference(
            session_id,
            &format!("tool-results/{}", file_name),
        )
        .unwrap_or_else(|_| path.display().to_string());
    let (preview, has_more) = generate_tool_result_preview(&serialized, preview_chars);

    debug!(
        "Persisted oversized tool result: tool_name={}, tool_id={}, chars={}, path={}",
        effective_tool_name(result),
        result.tool_id,
        serialized.chars().count(),
        path.display()
    );

    Ok(PersistedToolOutput {
        reference,
        original_chars: serialized.chars().count(),
        line_count: count_tool_result_lines(&serialized),
        preview,
        has_more,
        metadata: tool_result_metadata(result),
    })
}

async fn write_once(path: &Path, content: &str) -> OpenBitFunResult<()> {
    match tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .await
    {
        Ok(mut file) => {
            use tokio::io::AsyncWriteExt;
            file.write_all(content.as_bytes()).await.map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to write tool result file {}: {}",
                    path.display(),
                    error
                ))
            })?;
            // tokio::fs::File buffers writes and does NOT guarantee a flush on
            // drop, so without an explicit flush a subsequent (possibly
            // synchronous) read can observe an empty or partial file. This was
            // an intermittent failure on macOS CI. flush() drains the buffer to
            // the OS so the persisted output is visible to later readers.
            file.flush().await.map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to flush tool result file {}: {}",
                    path.display(),
                    error
                ))
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(OpenBitFunError::io(format!(
            "Failed to create tool result file {}: {}",
            path.display(),
            error
        ))),
    }
}

fn serialize_tool_result_content(result: &ToolResult) -> OpenBitFunResult<(String, bool)> {
    if let Some(text) = result.result_for_assistant.as_ref() {
        return Ok((text.clone(), false));
    }

    serde_json::to_string_pretty(&result.result)
        .or_else(|_| serde_json::to_string(&result.result))
        .map(|text| (text, true))
        .map_err(|error| {
            OpenBitFunError::serialization(format!("Failed to serialize tool result: {}", error))
        })
}

fn effective_per_tool_limit(tool_name: &str, policy: ToolResultStoragePolicy) -> usize {
    match tool_name {
        READ_TOOL_NAME => READ_MAX_TOOL_RESULT_CHARS,
        _ => policy.per_tool_limit_chars,
    }
}

fn json_result_is_oversized(result: &ToolResult, limit: usize) -> bool {
    if result.result_for_assistant.is_some() {
        return false;
    }

    serde_json::to_string_pretty(&result.result)
        .or_else(|_| serde_json::to_string(&result.result))
        .map(|text| text.chars().count() > limit)
        .unwrap_or(false)
}

fn result_visible_content(result: &ToolResult) -> String {
    if let Some(text) = result
        .result_for_assistant
        .as_ref()
        .filter(|text| !text.is_empty())
    {
        return text.clone();
    }

    serde_json::to_string_pretty(&result.result)
        .or_else(|_| serde_json::to_string(&result.result))
        .unwrap_or_else(|_| format!("Tool {} execution completed", result.tool_name))
}

fn visible_content_is_compacted(result: &ToolResult) -> bool {
    result
        .result_for_assistant
        .as_deref()
        .is_some_and(tool_result_is_persisted_output)
}

fn tool_result_file_name(tool_id: &str, is_json: bool) -> String {
    let fallback = uuid::Uuid::new_v4().to_string();
    let safe_id = sanitize_tool_result_file_component(tool_id, &fallback);
    let ext = if is_json { "json" } else { "txt" };
    format!("{}.{}", safe_id, ext)
}

fn tool_result_metadata(result: &ToolResult) -> Vec<(String, String)> {
    let Some(object) = result.result.as_object() else {
        return Vec::new();
    };

    [
        "success",
        "exit_code",
        "timed_out",
        "working_directory",
        "terminal_session_id",
    ]
    .into_iter()
    .filter_map(|key| {
        let value = object.get(key)?;
        let rendered = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        Some((key.to_string(), rendered))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn test_context(root: PathBuf) -> ToolUseContext {
        let mut custom_data = HashMap::new();
        custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            json!(root.join("runtime")),
        );

        ToolUseContext {
            tool_call_id: Some("call_1".to_string()),
            agent_type: Some("agent".to_string()),
            session_id: Some("session_1".to_string()),
            dialog_turn_id: Some("turn_1".to_string()),
            workspace: Some(WorkspaceBinding::new(None, root)),
            loaded_deferred_tool_specs: Vec::new(),
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data,
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    fn temp_workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "openbitfun-tool-result-storage-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ))
    }

    fn tool_result(tool_id: &str, tool_name: &str, text: String) -> ToolResult {
        ToolResult {
            tool_id: tool_id.to_string(),
            tool_name: tool_name.to_string(),
            effective_tool_name: None,
            result: json!({ "content": text }),
            result_for_assistant: Some(text),
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        }
    }

    #[tokio::test]
    async fn single_large_result_persists_and_replaces_assistant_text() {
        let root = temp_workspace("single");
        let context = test_context(root.clone());
        let result = tool_result(
            "tool/one",
            "WebFetch",
            "x".repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 1),
        );

        let processed = maybe_persist_large_tool_result(result, &context).await;
        let assistant = processed.result_for_assistant.unwrap_or_default();

        assert!(assistant.starts_with(PERSISTED_OUTPUT_TAG));
        assert!(assistant.contains("Full output saved to:"));
        assert!(assistant.contains("Preview"));
        assert!(assistant.len() < DEFAULT_MAX_TOOL_RESULT_CHARS);

        let session_dir = context
            .current_workspace_session_tool_results_dir("session_1")
            .expect("session tool-results dir");
        assert!(session_dir.join("tool_one.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn read_result_is_persisted_when_over_read_limit() {
        let root = temp_workspace("read");
        let context = test_context(root.clone());
        let text = "x".repeat(READ_MAX_TOOL_RESULT_CHARS + 1);
        let result = tool_result("read_1", "Read", text);

        let processed = maybe_persist_large_tool_result(result, &context).await;
        let assistant = processed.result_for_assistant.unwrap_or_default();

        assert!(assistant.starts_with(PERSISTED_OUTPUT_TAG));
        assert!(assistant.contains("Full output saved to:"));
        let session_dir = context
            .current_workspace_session_tool_results_dir("session_1")
            .expect("session tool-results dir");
        assert!(session_dir.join("read_1.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn read_result_stays_inline_when_under_read_limit() {
        let root = temp_workspace("read-inline");
        let context = test_context(root.clone());
        let text = "x".repeat(READ_MAX_TOOL_RESULT_CHARS);
        let result = tool_result("read_1", "Read", text.clone());

        let processed = maybe_persist_large_tool_result(result, &context).await;

        assert_eq!(
            processed.result_for_assistant.as_deref(),
            Some(text.as_str())
        );
        let session_dir = context
            .current_workspace_session_tool_results_dir("session_1")
            .expect("session tool-results dir");
        assert!(!session_dir.join("read_1.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn get_tool_spec_result_is_not_persisted_even_when_large() {
        let root = temp_workspace("get-tool-spec");
        let context = test_context(root.clone());
        let text = "x".repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 1);
        let result = tool_result("get_tool_spec_1", GET_TOOL_SPEC_TOOL_NAME, text.clone());

        let processed = maybe_persist_large_tool_result(result, &context).await;

        assert_eq!(
            processed.result_for_assistant.as_deref(),
            Some(text.as_str())
        );
        let session_dir = context
            .current_workspace_session_tool_results_dir("session_1")
            .expect("session tool-results dir");
        assert!(!session_dir.join("get_tool_spec_1.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn deferred_mcp_large_result_uses_effective_policy_and_keeps_wire_identity() {
        let root = temp_workspace("deferred-mcp");
        let context = test_context(root.clone());
        let result = tool_result(
            "mcp_call_1",
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
            "x".repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 1),
        );

        let processed =
            maybe_persist_large_tool_result_for_tool(result, "mcp__github__search_repos", &context)
                .await;

        assert_eq!(
            processed.tool_name,
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME
        );
        assert!(processed
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .starts_with(PERSISTED_OUTPUT_TAG));
        let output_path = context
            .current_workspace_session_tool_result_path("session_1", "mcp_call_1.txt")
            .expect("deferred MCP tool result path");
        assert!(output_path.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn round_budget_persists_largest_results_including_read() {
        let root = temp_workspace("round");
        let context = test_context(root.clone());
        let read = tool_result("read_1", "Read", "a".repeat(170_000));
        let medium = tool_result("medium_1", "WebFetch", "b".repeat(60_000));
        let small = tool_result("small_1", "OtherTool", "c".repeat(30_000));

        let processed = apply_round_tool_result_budget(vec![read, medium, small], &context).await;

        assert!(processed[0]
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .starts_with(PERSISTED_OUTPUT_TAG));
        assert!(!processed[1]
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .starts_with(PERSISTED_OUTPUT_TAG));
        assert!(!processed[2]
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .starts_with(PERSISTED_OUTPUT_TAG));

        let session_dir = context
            .current_workspace_session_tool_results_dir("session_1")
            .expect("session tool-results dir");
        assert!(session_dir.join("read_1.txt").exists());
        assert!(!session_dir.join("medium_1.txt").exists());
        assert!(!session_dir.join("small_1.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
