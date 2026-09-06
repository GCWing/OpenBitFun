use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol::schema::{
    PermissionOption, PermissionOptionKind, RequestPermissionRequest, SessionId,
    SessionNotification, SessionUpdate, ToolCall, ToolCallContent, ToolCallLocation,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::{Client, ConnectionTo, Result};
use openbitfun_core::service::session::{ToolItemData, ToolItemIdentityExt};
use openbitfun_events::ToolEventData;

pub(super) const PERMISSION_ALLOW_ONCE: &str = "allow_once";
pub(super) const PERMISSION_REJECT_ONCE: &str = "reject_once";
const ACP_LARGE_TEXT_PREVIEW_CHARS: usize = 2_000;

pub(super) fn send_update(
    connection: &ConnectionTo<Client>,
    session_id: &str,
    update: SessionUpdate,
) -> Result<()> {
    connection.send_notification(SessionNotification::new(
        SessionId::new(session_id.to_string()),
        update,
    ))
}

pub(super) fn tool_event_updates(
    tool_event: &ToolEventData,
    seen_tool_calls: &mut HashSet<String>,
) -> Vec<SessionUpdate> {
    let tool_id = tool_event.tool_id();
    let mut updates = Vec::new();

    if !seen_tool_calls.contains(tool_id) {
        seen_tool_calls.insert(tool_id.to_string());
        updates.push(SessionUpdate::ToolCall(initial_tool_call(tool_event)));
    }

    if let Some(update) = tool_call_update(tool_event) {
        updates.push(SessionUpdate::ToolCallUpdate(update));
    }

    updates
}

/// Build the `session/update` notifications needed to replay a persisted tool
/// call back to a client during `session/load`.
///
/// Mirrors the streaming shape produced by [`tool_event_updates`] for live
/// turns: an initial [`SessionUpdate::ToolCall`] that announces the tool call
/// (with its raw input), followed by a [`SessionUpdate::ToolCallUpdate`] that
/// carries the final status and raw output. Reusing the same shape lets clients
/// render restored history through the same code path they use for live turns.
///
/// When a persisted tool has no `tool_result` (it was interrupted, cancelled,
/// or still running when the turn was persisted), the replayed status is
/// derived from `ToolItemData.status` / `interruption_reason` instead of
/// defaulting to `InProgress`. Otherwise a tool that was cancelled or failed
/// without ever producing a result would be restored as perpetually
/// "in progress", leaving a stuck tool card in the client transcript.
pub(super) fn tool_call_replay_updates(tool_item: &ToolItemData) -> Vec<SessionUpdate> {
    let tool_id = tool_item.id.clone();
    let tool_name = tool_item.effective_name();
    let raw_input = sanitize_tool_input(tool_name, tool_item.effective_input().clone());

    let initial = ToolCall::new(tool_id.clone(), tool_title(tool_name))
        .kind(tool_kind(tool_name))
        .status(ToolCallStatus::InProgress)
        .locations(tool_locations(&raw_input))
        .raw_input(raw_input);

    let mut fields = ToolCallUpdateFields::new()
        .title(tool_title(tool_name))
        .kind(tool_kind(tool_name));

    let (status, raw_output, display) = match tool_item.tool_result.as_ref() {
        Some(result) if result.success => {
            let raw_output = sanitize_tool_payload(tool_name, result.result.clone());
            let display = result
                .result_for_assistant
                .clone()
                .unwrap_or_else(|| value_to_display_text(&raw_output));
            (ToolCallStatus::Completed, Some(raw_output), Some(display))
        }
        Some(result) => {
            let error = result
                .error
                .clone()
                .unwrap_or_else(|| value_to_display_text(&result.result));
            (
                ToolCallStatus::Failed,
                Some(serde_json::json!({ "error": error })),
                Some(format!("Error: {}", error)),
            )
        }
        None => match replayed_terminal_status(tool_item) {
            None => (ToolCallStatus::InProgress, None, None),
            Some(TerminalReplayStatus::Failed(reason)) => {
                let display = format!("Cancelled: {}", reason);
                (
                    ToolCallStatus::Failed,
                    Some(serde_json::json!({ "reason": reason })),
                    Some(display),
                )
            }
        },
    };

    fields = fields.status(status);
    if let Some(display) = display {
        fields = fields.content(vec![text_content(display)]);
    }
    if let Some(raw_output) = raw_output {
        fields = fields.raw_output(raw_output);
    }

    vec![
        SessionUpdate::ToolCall(initial),
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(tool_id, fields)),
    ]
}

/// The terminal status to replay for a persisted tool that never produced a
/// `tool_result`.
///
/// Returns `None` when the stored state is genuinely indeterminate (no status
/// recorded, or a status that implies the tool may still be running) — in that
/// case the caller leaves the tool as `InProgress`, which matches the live
/// streaming shape for a tool whose result has not landed yet. Returns
/// `Failed(reason)` when the stored state proves the tool will never produce a
/// result (it was cancelled, interrupted, or errored), so the replayed card
/// settles on a terminal state instead of spinning forever.
enum TerminalReplayStatus {
    Failed(String),
}

fn replayed_terminal_status(tool_item: &ToolItemData) -> Option<TerminalReplayStatus> {
    // An explicit interruption reason is the strongest signal: the tool was
    // cancelled or aborted before it could produce output.
    if let Some(reason) = tool_item.interruption_reason.as_ref() {
        let reason = reason.trim();
        if !reason.is_empty() {
            return Some(TerminalReplayStatus::Failed(reason.to_string()));
        }
    }

    // Fall back to the coarse-grained `status` field the persistence layer
    // stamps on tool items. Only treat it as terminal when it names a
    // non-recoverable outcome; "running"/"in_progress" stay `InProgress`.
    let status = tool_item.status.as_deref()?.trim().to_ascii_lowercase();
    let reason = match status.as_str() {
        "cancelled" | "canceled" | "aborted" | "interrupted" => "cancelled".to_string(),
        "failed" | "error" | "errored" => "failed".to_string(),
        _ => return None,
    };
    Some(TerminalReplayStatus::Failed(reason))
}

pub(super) fn permission_request(
    session_id: &str,
    tool_id: &str,
    tool_name: &str,
    params: &serde_json::Value,
) -> RequestPermissionRequest {
    RequestPermissionRequest::new(
        SessionId::new(session_id.to_string()),
        ToolCallUpdate::new(
            tool_id.to_string(),
            ToolCallUpdateFields::new()
                .title(format!("Allow {}?", tool_name))
                .status(ToolCallStatus::Pending)
                .kind(tool_kind(tool_name))
                .locations(tool_locations(params))
                .raw_input(sanitize_tool_input(tool_name, params.clone()))
                .content(vec![text_content(format!(
                    "Permission required to run {}.",
                    tool_name
                ))]),
        ),
        vec![
            PermissionOption::new(
                PERMISSION_ALLOW_ONCE,
                "Allow once",
                PermissionOptionKind::AllowOnce,
            ),
            PermissionOption::new(
                PERMISSION_REJECT_ONCE,
                "Reject once",
                PermissionOptionKind::RejectOnce,
            ),
        ],
    )
}

fn initial_tool_call(tool_event: &ToolEventData) -> ToolCall {
    let tool_id = tool_event.tool_id().to_string();
    let tool_name = tool_event.effective_tool_name();
    ToolCall::new(tool_id, tool_title(tool_name))
        .kind(tool_kind(tool_name))
        .status(ToolCallStatus::Pending)
        .raw_input(serde_json::json!({}))
}

fn tool_call_update(tool_event: &ToolEventData) -> Option<ToolCallUpdate> {
    let tool_id = tool_event.tool_id().to_string();
    let fields = match tool_event {
        ToolEventData::EarlyDetected { identity } => ToolCallUpdateFields::new()
            .title(tool_title(identity.effective_name()))
            .kind(tool_kind(identity.effective_name()))
            .status(ToolCallStatus::Pending),
        ToolEventData::ParamsPartial {
            identity, params, ..
        } => {
            let fields = ToolCallUpdateFields::new().status(ToolCallStatus::Pending);
            if let Ok(wire_input) = serde_json::from_str::<serde_json::Value>(params) {
                let (tool_name, effective_input) =
                    openbitfun_agent_tools::effective_tool_invocation(
                        &identity.tool_name,
                        &wire_input,
                    );
                if is_write_like_tool(tool_name) {
                    fields
                        .raw_input(sanitize_tool_input(tool_name, effective_input.clone()))
                        .content(vec![text_content(write_input_status_text(effective_input))])
                } else {
                    fields.content(vec![text_content(format!("Input: {}", effective_input))])
                }
            } else if is_write_like_tool(identity.effective_name()) {
                fields.content(vec![text_content(format!(
                    "Writing file ({} bytes received so far).",
                    params.len()
                ))])
            } else {
                fields.content(vec![text_content(format!("Input: {}", params))])
            }
        }
        ToolEventData::Queued { position, .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::Pending)
            .content(vec![text_content(format!(
                "Queued at position {}.",
                position
            ))]),
        ToolEventData::Waiting { dependencies, .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::Pending)
            .content(vec![text_content(format!(
                "Waiting for dependencies: {}.",
                dependencies.join(", ")
            ))]),
        ToolEventData::Started {
            identity, params, ..
        } => {
            let (tool_name, effective_input) =
                openbitfun_agent_tools::effective_tool_invocation(&identity.tool_name, params);
            ToolCallUpdateFields::new()
                .title(tool_title(tool_name))
                .kind(tool_kind(tool_name))
                .status(ToolCallStatus::InProgress)
                .locations(tool_locations(effective_input))
                .raw_input(sanitize_tool_input(tool_name, effective_input.clone()))
        }
        ToolEventData::Progress {
            message,
            percentage,
            ..
        } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::InProgress)
            .content(vec![text_content(format!(
                "{} ({:.0}%)",
                message, percentage
            ))]),
        ToolEventData::Streaming {
            chunks_received, ..
        } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::InProgress)
            .content(vec![text_content(format!(
                "Received {} streaming chunks.",
                chunks_received
            ))]),
        ToolEventData::StreamChunk { data, .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::InProgress)
            .content(vec![text_content(value_to_display_text(data))]),
        ToolEventData::ConfirmationNeeded {
            identity, params, ..
        } => {
            let (tool_name, effective_input) =
                openbitfun_agent_tools::effective_tool_invocation(&identity.tool_name, params);
            ToolCallUpdateFields::new()
                .title(format!("Allow {}?", tool_name))
                .status(ToolCallStatus::Pending)
                .locations(tool_locations(effective_input))
                .raw_input(sanitize_tool_input(tool_name, effective_input.clone()))
                .content(vec![text_content("Waiting for permission.")])
        }
        ToolEventData::Confirmed { .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::InProgress)
            .content(vec![text_content("Permission granted.")]),
        ToolEventData::Rejected { .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::Failed)
            .content(vec![text_content("Permission rejected.")]),
        ToolEventData::Completed {
            identity,
            result,
            result_for_assistant,
            duration_ms,
            ..
        } => {
            let tool_name = identity.effective_name();
            let raw_output = sanitize_tool_payload(tool_name, result.clone());
            let display = result_for_assistant
                .clone()
                .unwrap_or_else(|| value_to_display_text(&raw_output));
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .locations(tool_locations(&raw_output))
                .raw_output(raw_output)
                .content(vec![text_content(format!(
                    "{}\nCompleted in {} ms.",
                    display, duration_ms
                ))])
        }
        ToolEventData::Failed { error, .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::Failed)
            .raw_output(serde_json::json!({ "error": error }))
            .content(vec![text_content(format!("Error: {}", error))]),
        ToolEventData::Cancelled { reason, .. } => ToolCallUpdateFields::new()
            .status(ToolCallStatus::Failed)
            .raw_output(serde_json::json!({ "reason": reason }))
            .content(vec![text_content(format!("Cancelled: {}", reason))]),
    };

    Some(ToolCallUpdate::new(tool_id, fields))
}

fn tool_title(tool_name: &str) -> String {
    format!("Run {}", tool_name)
}

fn tool_kind(tool_name: &str) -> ToolKind {
    let name = tool_name.to_ascii_lowercase();
    if name.contains("delete") || name.contains("remove") {
        ToolKind::Delete
    } else if name.contains("write")
        || name.contains("edit")
        || name.contains("patch")
        || name.contains("replace")
    {
        ToolKind::Edit
    } else if name.contains("move") || name.contains("rename") {
        ToolKind::Move
    } else if name.contains("grep")
        || name.contains("glob")
        || name.contains("search")
        || name.contains("find")
    {
        ToolKind::Search
    } else if name.contains("bash")
        || name.contains("terminal")
        || name.contains("command")
        || name.contains("execute")
    {
        ToolKind::Execute
    } else if name.contains("web") || name.contains("fetch") || name.contains("http") {
        ToolKind::Fetch
    } else if name.contains("think") || name.contains("plan") {
        ToolKind::Think
    } else if name.contains("read") || name == "ls" {
        ToolKind::Read
    } else {
        ToolKind::Other
    }
}

fn split_write_payload(input: &serde_json::Value) -> Option<(&str, &str)> {
    let value = input.get("payload")?.as_str()?;
    let (first_line, content) = value.split_once('\n').unwrap_or((value, ""));
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let file_path = first_line.strip_prefix("+++ ")?;
    (!file_path.trim().is_empty()).then_some((file_path, content))
}

fn tool_locations(input: &serde_json::Value) -> Vec<ToolCallLocation> {
    split_write_payload(input)
        .map(|(file_path, _)| file_path)
        .or_else(|| {
            input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(|value| value.as_str())
        })
        .filter(|path| !path.trim().is_empty())
        .map(|path| vec![ToolCallLocation::new(PathBuf::from(path))])
        .unwrap_or_default()
}

fn is_write_like_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "write" | "file_write" | "write_file" | "write_notebook"
    )
}

fn sanitize_tool_input(tool_name: &str, mut input: serde_json::Value) -> serde_json::Value {
    if !is_large_text_payload_tool(tool_name) {
        return input;
    }

    let Some(object) = input.as_object_mut() else {
        return input;
    };

    sanitize_large_text_fields(object);

    input
}

fn sanitize_tool_payload(tool_name: &str, mut payload: serde_json::Value) -> serde_json::Value {
    if !is_large_text_payload_tool(tool_name) {
        return payload;
    }

    let Some(object) = payload.as_object_mut() else {
        return payload;
    };

    sanitize_large_text_fields(object);

    payload
}

fn is_large_text_payload_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "write"
            | "file_write"
            | "write_file"
            | "write_notebook"
            | "edit"
            | "file_edit"
            | "search_replace"
    )
}

fn sanitize_large_text_fields(object: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(value) = object.get_mut("payload") {
        if let Some(combined) = value.as_str() {
            let combined_len = combined.len();
            if let Some((file_path, content)) = combined.split_once('\n') {
                if let Some(preview) = large_text_preview(content) {
                    *value = serde_json::Value::String(format!("{}\n{}", file_path, preview));
                    object.insert("payload_bytes".to_string(), serde_json::json!(combined_len));
                    object.insert("payload_truncated".to_string(), serde_json::json!(true));
                }
            }
        }
    }

    for key in ["content", "contents", "old_string", "new_string"] {
        let Some(value) = object.get_mut(key) else {
            continue;
        };
        let Some(content) = value.as_str() else {
            continue;
        };

        let content_len = content.len();
        let Some(preview) = large_text_preview(content) else {
            continue;
        };
        *value = serde_json::Value::String(preview);
        object.insert(format!("{}_bytes", key), serde_json::json!(content_len));
        object.insert(format!("{}_truncated", key), serde_json::json!(true));
    }
}

fn large_text_preview(content: &str) -> Option<String> {
    if content.chars().count() <= ACP_LARGE_TEXT_PREVIEW_CHARS {
        return None;
    }

    Some(truncate_chars(content, ACP_LARGE_TEXT_PREVIEW_CHARS))
}

fn write_input_status_text(input: &serde_json::Value) -> String {
    let combined = split_write_payload(input);
    let raw_payload = input.get("payload").and_then(serde_json::Value::as_str);
    let path = combined
        .map(|(file_path, _)| file_path)
        .or_else(|| {
            input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(|value| value.as_str())
        })
        .unwrap_or_else(|| {
            if raw_payload.is_some() {
                "workspace temporary file"
            } else {
                "file"
            }
        });
    let content_len = combined
        .map(|(_, content)| content.len())
        .or_else(|| raw_payload.map(str::len))
        .or_else(|| {
            input
                .get("content")
                // Legacy alias kept for replaying older Write tool-call transcripts.
                .or_else(|| input.get("contents"))
                .and_then(|value| value.as_str())
                .map(str::len)
        })
        .unwrap_or(0);

    format!("Writing {} ({} bytes).", path, content_len)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect()
}

fn text_content(text: impl Into<String>) -> ToolCallContent {
    ToolCallContent::from(text.into())
}

fn value_to_display_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::ContentBlock;
    use openbitfun_core::service::session::ToolCallData;
    use openbitfun_events::ToolEventIdentity;

    fn identity(tool_name: &str) -> ToolEventIdentity {
        ToolEventIdentity::direct("tool-1", tool_name)
    }

    #[test]
    fn early_detected_creates_tool_call_once() {
        let mut seen = HashSet::new();
        let event = ToolEventData::EarlyDetected {
            identity: identity("Read"),
        };

        let first = tool_event_updates(&event, &mut seen);
        assert_eq!(first.len(), 2);
        assert!(matches!(first[0], SessionUpdate::ToolCall(_)));
        assert!(matches!(first[1], SessionUpdate::ToolCallUpdate(_)));

        let second = tool_event_updates(&event, &mut seen);
        assert_eq!(second.len(), 1);
        assert!(matches!(second[0], SessionUpdate::ToolCallUpdate(_)));
    }

    #[test]
    fn completed_event_maps_to_completed_update_with_output() {
        let mut seen = HashSet::new();
        let event = ToolEventData::Completed {
            params: None,
            identity: identity("ExecCommand"),
            result: serde_json::json!({ "stdout": "ok" }),
            result_for_assistant: Some("done".to_string()),
            image_attachments: None,
            duration_ms: 42,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };

        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        assert_eq!(
            update.fields.raw_output,
            Some(serde_json::json!({ "stdout": "ok" }))
        );
    }

    #[test]
    fn write_started_supports_combined_payload_input() {
        let mut seen = HashSet::new();
        let event = ToolEventData::Started {
            identity: identity("Write"),
            params: serde_json::json!({
                "payload": "+++ src/lib.rs\nhello\n",
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };

        assert_eq!(
            update.fields.locations.as_ref().unwrap()[0].path,
            PathBuf::from("src/lib.rs")
        );
        assert_eq!(
            update.fields.raw_input,
            Some(serde_json::json!({
                "payload": "+++ src/lib.rs\nhello\n",
            }))
        );
    }

    #[test]
    fn deferred_write_started_projects_effective_identity_and_input() {
        let mut seen = HashSet::new();
        let event = ToolEventData::Started {
            identity: ToolEventIdentity::resolved(
                "tool-1",
                openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
                "Write",
            ),
            params: serde_json::json!({
                "tool_name": "Write",
                "args": {
                    "file_path": "src/lib.rs",
                    "content": "updated"
                }
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        assert_eq!(update.fields.title.as_deref(), Some("Run Write"));
        assert_eq!(
            update.fields.raw_input,
            Some(serde_json::json!({
                "file_path": "src/lib.rs",
                "content": "updated"
            }))
        );
    }

    #[test]
    fn write_started_supports_path_only_empty_file_input() {
        let mut seen = HashSet::new();
        let event = ToolEventData::Started {
            identity: identity("Write"),
            params: serde_json::json!({
                "payload": "+++ src/empty.rs",
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };

        assert_eq!(
            update.fields.locations.as_ref().unwrap()[0].path,
            PathBuf::from("src/empty.rs")
        );
        assert_eq!(
            write_input_status_text(&serde_json::json!({
                "payload": "+++ src/empty.rs",
            })),
            "Writing src/empty.rs (0 bytes)."
        );
    }

    #[test]
    fn combined_write_sanitization_preserves_path_and_truncates_only_content() {
        let file_path = "src/generated.rs";
        let content = "x".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS + 10);
        let combined = format!("+++ {}\n{}", file_path, content);

        let sanitized = sanitize_tool_input("Write", serde_json::json!({ "payload": combined }));
        let sanitized_combined = sanitized["payload"]
            .as_str()
            .expect("combined input should remain a string");
        let (sanitized_path, sanitized_content) = sanitized_combined
            .split_once('\n')
            .expect("sanitized combined input should retain its separator");

        assert_eq!(sanitized_path, format!("+++ {}", file_path));
        assert_eq!(sanitized_content.len(), ACP_LARGE_TEXT_PREVIEW_CHARS);
        assert_eq!(sanitized["payload_bytes"], combined.len());
        assert_eq!(sanitized["payload_truncated"], true);
    }

    #[test]
    fn write_started_redacts_large_content_from_raw_input() {
        let mut seen = HashSet::new();
        let content = "x".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS + 10);
        let event = ToolEventData::Started {
            identity: identity("Write"),
            params: serde_json::json!({
                "file_path": "src/lib.rs",
                "content": content,
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCall(tool_call) = &updates[0] else {
            panic!("expected initial tool call");
        };
        assert_eq!(tool_call.status, ToolCallStatus::Pending);
        assert_eq!(tool_call.raw_input, Some(serde_json::json!({})));

        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        assert_eq!(
            update.fields.locations.as_ref().unwrap()[0].path,
            PathBuf::from("src/lib.rs")
        );

        let raw_input = update
            .fields
            .raw_input
            .as_ref()
            .expect("raw input should be present");

        assert_eq!(raw_input["file_path"], "src/lib.rs");
        assert_eq!(
            raw_input["content_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS + 10
        );
        assert_eq!(
            raw_input["content"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(raw_input["content_truncated"], true);
    }

    #[test]
    fn write_params_partial_sends_bounded_raw_input() {
        let mut seen = HashSet::new();
        let content = "a".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS + 25);
        let event = ToolEventData::ParamsPartial {
            identity: identity("Write"),
            params: serde_json::json!({
                "file_path": "src/main.rs",
                "content": content,
            })
            .to_string(),
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        let raw_input = update
            .fields
            .raw_input
            .as_ref()
            .expect("raw input should be present");

        assert_eq!(raw_input["file_path"], "src/main.rs");
        assert_eq!(
            raw_input["content_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS + 25
        );
        assert_eq!(
            raw_input["content"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(raw_input["content_truncated"], true);
    }

    #[test]
    fn write_started_sends_small_content_on_in_progress_update() {
        let mut seen = HashSet::new();
        let event = ToolEventData::Started {
            identity: identity("Write"),
            params: serde_json::json!({
                "file_path": "tiny.txt",
                "content": "hello\n",
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCall(tool_call) = &updates[0] else {
            panic!("expected initial tool call");
        };
        assert_eq!(tool_call.status, ToolCallStatus::Pending);
        assert_eq!(tool_call.raw_input, Some(serde_json::json!({})));

        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        let raw_input = update
            .fields
            .raw_input
            .as_ref()
            .expect("raw input should be present");

        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        assert_eq!(
            update.fields.locations.as_ref().unwrap()[0].path,
            PathBuf::from("tiny.txt")
        );
        assert_eq!(raw_input["file_path"], "tiny.txt");
        assert_eq!(raw_input["content"], "hello\n");
        assert!(raw_input.get("content_bytes").is_none());
        assert!(raw_input.get("content_truncated").is_none());
    }

    #[test]
    fn edit_started_redacts_large_strings_from_raw_input() {
        let mut seen = HashSet::new();
        let old_string = "old".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS);
        let new_string = "new".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS);
        let event = ToolEventData::Started {
            identity: identity("Edit"),
            params: serde_json::json!({
                "file_path": "src/lib.rs",
                "old_string": old_string,
                "new_string": new_string,
            }),
            timeout_seconds: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        let raw_input = update
            .fields
            .raw_input
            .as_ref()
            .expect("raw input should be present");

        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        assert_eq!(
            update.fields.locations.as_ref().unwrap()[0].path,
            PathBuf::from("src/lib.rs")
        );
        assert_eq!(raw_input["file_path"], "src/lib.rs");
        assert_eq!(
            raw_input["old_string_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS * 3
        );
        assert_eq!(
            raw_input["new_string_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS * 3
        );
        assert_eq!(
            raw_input["old_string"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(
            raw_input["new_string"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(raw_input["old_string_truncated"], true);
        assert_eq!(raw_input["new_string_truncated"], true);
    }

    #[test]
    fn edit_completed_redacts_large_strings_from_raw_output() {
        let mut seen = HashSet::new();
        let old_string = "old".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS);
        let new_string = "new".repeat(ACP_LARGE_TEXT_PREVIEW_CHARS);
        let event = ToolEventData::Completed {
            params: None,
            identity: identity("Edit"),
            result: serde_json::json!({
                "file_path": "src/lib.rs",
                "old_string": old_string,
                "new_string": new_string,
                "success": true,
            }),
            result_for_assistant: None,
            image_attachments: None,
            duration_ms: 15,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
        };

        let updates = tool_event_updates(&event, &mut seen);
        let SessionUpdate::ToolCallUpdate(update) = &updates[1] else {
            panic!("expected tool call update");
        };
        let raw_output = update
            .fields
            .raw_output
            .as_ref()
            .expect("raw output should be present");

        assert_eq!(raw_output["file_path"], "src/lib.rs");
        assert_eq!(
            raw_output["old_string_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS * 3
        );
        assert_eq!(
            raw_output["new_string_bytes"],
            ACP_LARGE_TEXT_PREVIEW_CHARS * 3
        );
        assert_eq!(
            raw_output["old_string"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(
            raw_output["new_string"].as_str().unwrap().len(),
            ACP_LARGE_TEXT_PREVIEW_CHARS
        );
        assert_eq!(raw_output["old_string_truncated"], true);
        assert_eq!(raw_output["new_string_truncated"], true);
    }

    #[test]
    fn permission_request_exposes_allow_and_reject_once() {
        let request = permission_request(
            "session-1",
            "tool-1",
            "FileWrite",
            &serde_json::json!({ "path": "a.txt" }),
        );

        assert_eq!(request.options.len(), 2);
        assert_eq!(
            request.options[0].option_id.to_string(),
            PERMISSION_ALLOW_ONCE
        );
        assert_eq!(request.options[0].kind, PermissionOptionKind::AllowOnce);
        assert_eq!(
            request.options[1].option_id.to_string(),
            PERMISSION_REJECT_ONCE
        );
        assert_eq!(request.options[1].kind, PermissionOptionKind::RejectOnce);
    }

    fn replay_tool_item(
        id: &str,
        tool_name: &str,
        status: Option<&str>,
        interruption_reason: Option<&str>,
    ) -> ToolItemData {
        ToolItemData {
            id: id.to_string(),
            tool_name: tool_name.to_string(),
            tool_call: ToolCallData {
                input: serde_json::json!({ "path": "a.txt" }),
                id: id.to_string(),
            },
            tool_result: None,
            ai_intent: None,
            start_time: 0,
            end_time: None,
            duration_ms: None,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            subagent_dialog_turn_id: None,
            attempt_id: None,
            attempt_index: None,
            subagent_model_id: None,
            subagent_model_display_name: None,
            status: status.map(|s| s.to_string()),
            interruption_reason: interruption_reason.map(|s| s.to_string()),
        }
    }

    fn replay_update(tool_item: &ToolItemData) -> ToolCallUpdate {
        let updates = tool_call_replay_updates(tool_item);
        let mut iter = updates.into_iter();
        let _ = iter.next();
        let Some(SessionUpdate::ToolCallUpdate(update)) = iter.next() else {
            panic!("expected tool call update");
        };
        update
    }

    #[test]
    fn replay_projects_deferred_wire_call_to_effective_tool() {
        let mut item = replay_tool_item("tool-1", "CallDeferredTool", Some("completed"), None);
        item.tool_call.input = serde_json::json!({
            "tool_name": "WebFetch",
            "args": { "url": "https://example.test" }
        });
        let updates = tool_call_replay_updates(&item);
        let SessionUpdate::ToolCall(tool_call) = &updates[0] else {
            panic!("expected initial tool call");
        };
        assert_eq!(tool_call.title, tool_title("WebFetch"));
        assert_eq!(
            tool_call.raw_input,
            Some(serde_json::json!({ "url": "https://example.test" }))
        );
    }

    #[test]
    fn replay_without_result_defaults_to_in_progress() {
        // No status, no interruption reason: the stored state is indeterminate,
        // so the replayed card stays InProgress (matches live streaming shape).
        let item = replay_tool_item("tool-1", "ExecCommand", None, None);
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        assert!(update.fields.raw_output.is_none());
        assert!(update.fields.content.is_none());
    }

    #[test]
    fn replay_with_running_status_stays_in_progress() {
        let item = replay_tool_item("tool-1", "ExecCommand", Some("running"), None);
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
    }

    #[test]
    fn replay_with_completed_status_but_no_result_stays_in_progress() {
        // `build_model_rounds_from_messages` stamps `completed` on tool items
        // whose results live in separate tool_result messages; that is not a
        // terminal-without-result signal, so we must not flip it to Failed.
        let item = replay_tool_item("tool-1", "ExecCommand", Some("completed"), None);
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
    }

    #[test]
    fn replay_with_interruption_reason_settles_to_failed() {
        let item = replay_tool_item("tool-1", "ExecCommand", None, Some("cancelled"));
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert_eq!(
            update.fields.raw_output.as_ref().unwrap()["reason"],
            "cancelled"
        );
        let content = update.fields.content.as_ref().expect("content present");
        assert_eq!(content.len(), 1);
        let ToolCallContent::Content(block) = &content[0] else {
            panic!("expected content block");
        };
        let ContentBlock::Text(text) = &block.content else {
            panic!("expected text content block");
        };
        assert!(text.text.contains("Cancelled: cancelled"));
    }

    #[test]
    fn replay_with_cancelled_status_settles_to_failed() {
        let item = replay_tool_item("tool-1", "ExecCommand", Some("cancelled"), None);
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert_eq!(
            update.fields.raw_output.as_ref().unwrap()["reason"],
            "cancelled"
        );
    }

    #[test]
    fn replay_with_error_status_settles_to_failed() {
        let item = replay_tool_item("tool-1", "ExecCommand", Some("error"), None);
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert_eq!(
            update.fields.raw_output.as_ref().unwrap()["reason"],
            "failed"
        );
    }

    #[test]
    fn replay_interruption_reason_takes_precedence_over_running_status() {
        let item = replay_tool_item("tool-1", "ExecCommand", Some("running"), Some("aborted"));
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert_eq!(
            update.fields.raw_output.as_ref().unwrap()["reason"],
            "aborted"
        );
    }

    #[test]
    fn replay_with_blank_interruption_reason_falls_back_to_status() {
        let item = replay_tool_item("tool-1", "ExecCommand", Some("cancelled"), Some("   "));
        let update = replay_update(&item);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert_eq!(
            update.fields.raw_output.as_ref().unwrap()["reason"],
            "cancelled"
        );
    }
}
