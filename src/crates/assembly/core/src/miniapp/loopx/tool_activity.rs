use openbitfun_events::ToolEventData;
use openbitfun_services_core::session_usage::redaction::redact_usage_input_summary;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_TOOL_SUMMARY_CHARS: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ToolActivityProjection {
    pub tool_name: String,
    pub state: &'static str,
    pub message: String,
    pub details: BTreeMap<String, String>,
    pub current_tool: Option<String>,
    pub important: bool,
}

pub(super) fn project_tool_activity(event: &ToolEventData) -> Option<ToolActivityProjection> {
    let tool_name = event.effective_tool_name().to_string();
    let mut details = BTreeMap::from([
        ("activity".to_string(), activity_state(event)?.to_string()),
        ("toolName".to_string(), tool_name.clone()),
    ]);
    let (message, current_tool, important) = match event {
        ToolEventData::Queued { position, .. } => {
            details.insert("queuePosition".to_string(), position.to_string());
            (
                format!("Tool queued: {tool_name}"),
                Some(tool_name.clone()),
                false,
            )
        }
        ToolEventData::Waiting { dependencies, .. } => {
            if !dependencies.is_empty() {
                details.insert("dependencies".to_string(), dependencies.join(", "));
            }
            (
                format!("Tool waiting: {tool_name}"),
                Some(tool_name.clone()),
                false,
            )
        }
        ToolEventData::Started { params, .. } => {
            if let Some(summary) = tool_input_summary(&tool_name, params) {
                details.insert("summary".to_string(), summary);
            }
            (
                format!("Tool started: {tool_name}"),
                Some(tool_name.clone()),
                false,
            )
        }
        ToolEventData::ConfirmationNeeded { params, .. } => {
            if let Some(summary) = tool_input_summary(&tool_name, params) {
                details.insert("summary".to_string(), summary);
            }
            (
                format!("Tool needs confirmation: {tool_name}"),
                Some(tool_name.clone()),
                false,
            )
        }
        ToolEventData::Confirmed { .. } => (
            format!("Tool confirmed: {tool_name}"),
            Some(tool_name.clone()),
            false,
        ),
        ToolEventData::Rejected { .. } => (format!("Tool rejected: {tool_name}"), None, true),
        ToolEventData::Completed {
            params,
            result,
            duration_ms,
            ..
        } => {
            details.insert("durationMs".to_string(), duration_ms.to_string());
            if let Some(summary) = params
                .as_ref()
                .and_then(|params| tool_input_summary(&tool_name, params))
            {
                details.insert("summary".to_string(), summary);
            }
            insert_result_facts(&tool_name, result, &mut details);
            (format!("Tool completed: {tool_name}"), None, false)
        }
        ToolEventData::Failed {
            params,
            error,
            duration_ms,
            ..
        } => {
            if let Some(params) = params {
                if let Some(summary) = tool_input_summary(&tool_name, params) {
                    details.insert("summary".to_string(), summary);
                }
            }
            if let Some(duration_ms) = duration_ms {
                details.insert("durationMs".to_string(), duration_ms.to_string());
            }
            let error_summary = redact_usage_input_summary(error, MAX_TOOL_SUMMARY_CHARS).value;
            let input_summary = params
                .as_ref()
                .and_then(|params| tool_input_summary(&tool_name, params));
            details.insert(
                "summary".to_string(),
                match input_summary {
                    Some(input) => format!("{input} — {error_summary}"),
                    None => error_summary,
                },
            );
            (format!("Tool failed: {tool_name}"), None, true)
        }
        ToolEventData::Cancelled {
            params,
            reason,
            duration_ms,
            ..
        } => {
            if let Some(params) = params {
                if let Some(summary) = tool_input_summary(&tool_name, params) {
                    details.insert("summary".to_string(), summary);
                }
            }
            if let Some(duration_ms) = duration_ms {
                details.insert("durationMs".to_string(), duration_ms.to_string());
            }
            let reason_summary = redact_usage_input_summary(reason, MAX_TOOL_SUMMARY_CHARS).value;
            let input_summary = params
                .as_ref()
                .and_then(|params| tool_input_summary(&tool_name, params));
            details.insert(
                "summary".to_string(),
                match input_summary {
                    Some(input) => format!("{input} — {reason_summary}"),
                    None => reason_summary,
                },
            );
            (format!("Tool cancelled: {tool_name}"), None, false)
        }
        ToolEventData::EarlyDetected { .. }
        | ToolEventData::ParamsPartial { .. }
        | ToolEventData::Progress { .. }
        | ToolEventData::Streaming { .. }
        | ToolEventData::StreamChunk { .. } => return None,
    };

    Some(ToolActivityProjection {
        tool_name,
        state: activity_state(event).expect("projected tool events have a stable state"),
        message,
        details,
        current_tool,
        important,
    })
}

fn activity_state(event: &ToolEventData) -> Option<&'static str> {
    match event {
        ToolEventData::Queued { .. } => Some("queued"),
        ToolEventData::Waiting { .. } => Some("waiting"),
        ToolEventData::Started { .. } => Some("started"),
        ToolEventData::ConfirmationNeeded { .. } => Some("confirmation"),
        ToolEventData::Confirmed { .. } => Some("confirmed"),
        ToolEventData::Rejected { .. } => Some("rejected"),
        ToolEventData::Completed { .. } => Some("completed"),
        ToolEventData::Failed { .. } => Some("failed"),
        ToolEventData::Cancelled { .. } => Some("cancelled"),
        ToolEventData::EarlyDetected { .. }
        | ToolEventData::ParamsPartial { .. }
        | ToolEventData::Progress { .. }
        | ToolEventData::Streaming { .. }
        | ToolEventData::StreamChunk { .. } => None,
    }
}

fn tool_input_summary(tool_name: &str, params: &Value) -> Option<String> {
    let fields = params.as_object()?;
    let value = match tool_name {
        "ExecCommand" => string_field(fields, &["cmd", "command"]),
        "Read" => string_field(fields, &["file_path", "path"]),
        "Write" => string_field(
            fields,
            &["file_path", "filePath", "path", "target_path", "targetPath"],
        )
        .or_else(|| {
            string_field(fields, &["payload"]).and_then(|value| write_payload_path(&value))
        }),
        "Edit" => string_field(
            fields,
            &["file_path", "filePath", "path", "target_path", "targetPath"],
        ),
        "LS" => string_field(fields, &["path"]),
        "WebFetch" => string_field(fields, &["url", "request_url"]),
        "Grep" => {
            let pattern = string_field(fields, &["pattern"])?;
            match string_field(fields, &["path"]) {
                Some(path) => Some(format!("{pattern} in {path}")),
                None => Some(pattern),
            }
        }
        _ => None,
    }?;
    Some(redact_usage_input_summary(&value, MAX_TOOL_SUMMARY_CHARS).value)
}

fn write_payload_path(payload: &str) -> Option<String> {
    payload
        .lines()
        .next()?
        .trim()
        .strip_prefix("+++")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_matches(|ch| ch == '{' || ch == '}').to_string())
}

fn string_field(fields: &serde_json::Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| fields.get(*name).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn insert_result_facts(tool_name: &str, result: &Value, details: &mut BTreeMap<String, String>) {
    let Some(fields) = result.as_object() else {
        return;
    };
    let facts: &[(&str, &[&str])] = match tool_name {
        "ExecCommand" => &[("exitCode", &["exit_code", "exitCode"])],
        "Grep" => &[
            ("matchCount", &["total_matches", "totalMatches"]),
            ("fileCount", &["file_count", "fileCount"]),
        ],
        "LS" => &[("entryCount", &["total"])],
        "Read" => &[("lineCount", &["lines_read", "linesRead"])],
        "WebFetch" => &[("contentLength", &["content_length", "contentLength"])],
        _ => &[],
    };
    for (detail_name, field_names) in facts {
        if let Some(value) = field_names
            .iter()
            .find_map(|field_name| fields.get(*field_name))
            .and_then(json_scalar_label)
        {
            details.insert((*detail_name).to_string(), value);
        }
    }
    if tool_name == "WebFetch" {
        if let Some(title) = string_field(fields, &["title"]) {
            details.insert(
                "title".to_string(),
                redact_usage_input_summary(&title, MAX_TOOL_SUMMARY_CHARS).value,
            );
        }
    }
}

fn json_scalar_label(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_events::ToolEventIdentity;

    #[test]
    fn partial_parameters_are_not_projected_as_user_log_events() {
        let event = ToolEventData::ParamsPartial {
            identity: ToolEventIdentity::direct("tool-1", "ExecCommand"),
            params: "{\"cmd\":\"cargo".to_string(),
        };

        assert!(project_tool_activity(&event).is_none());
    }

    #[test]
    fn command_summary_is_bounded_and_redacts_secrets() {
        let event = ToolEventData::Started {
            identity: ToolEventIdentity::direct("tool-1", "ExecCommand"),
            params: serde_json::json!({
                "cmd": "curl --api-key secret-value https://example.test"
            }),
            timeout_seconds: None,
        };

        let projection = project_tool_activity(&event).expect("started tool is projected");
        let summary = projection.details.get("summary").expect("summary");
        assert!(summary.contains("--api-key [redacted]"));
        assert!(!summary.contains("secret-value"));
    }

    #[test]
    fn completed_tool_projects_small_result_facts() {
        let event = ToolEventData::Completed {
            identity: ToolEventIdentity::direct("tool-1", "Grep"),
            params: None,
            result: serde_json::json!({ "total_matches": 12, "file_count": 3 }),
            result_for_assistant: None,
            image_attachments: None,
            duration_ms: 42,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: Some(42),
        };

        let projection = project_tool_activity(&event).expect("completed tool is projected");
        assert_eq!(
            projection.details.get("matchCount").map(String::as_str),
            Some("12")
        );
        assert_eq!(
            projection.details.get("fileCount").map(String::as_str),
            Some("3")
        );
        assert_eq!(
            projection.details.get("durationMs").map(String::as_str),
            Some("42")
        );
    }

    #[test]
    fn write_activity_projects_only_the_target_path() {
        let event = ToolEventData::Started {
            identity: ToolEventIdentity::direct("tool-1", "Write"),
            params: serde_json::json!({
                "payload": "+++ src/window/focus.ts\nprivate implementation details"
            }),
            timeout_seconds: None,
        };

        let projection = project_tool_activity(&event).expect("started write is projected");
        assert_eq!(
            projection.details.get("summary").map(String::as_str),
            Some("src/window/focus.ts")
        );
        assert!(!projection
            .details
            .values()
            .any(|value| value.contains("private implementation details")));
    }
}
