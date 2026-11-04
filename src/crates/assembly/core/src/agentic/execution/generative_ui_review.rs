//! Lightweight coverage review for the current Harmony GenUI request.
use super::model_exchange_trace::{
    prepare_model_exchange_trace_for_workspace, ModelExchangeTraceOperation,
};
use crate::agentic::core::{Message, MessageContent};
use crate::agentic::tools::framework::ToolUseContext;
use crate::util::types::Message as AIMessage;
use serde_json::{json, Value};

const MAX_SOURCE_CHARS: usize = 14_000;
const REVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

#[derive(Clone, Debug)]
struct RequirementSource {
    id: String,
    text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReviewFailureKind {
    Candidate,
}

#[derive(Debug)]
pub(crate) struct ReviewFailure {
    kind: ReviewFailureKind,
    message: String,
}

impl ReviewFailure {
    fn candidate(message: impl Into<String>) -> Self {
        Self {
            kind: ReviewFailureKind::Candidate,
            message: message.into(),
        }
    }

    pub(crate) fn tool_feedback(&self) -> String {
        match self.kind {
            ReviewFailureKind::Candidate => format!(
                "GenUI candidate needs repair: {}. The candidate is saved but not accepted. Keep all existing parts and add the clearly missing requested parts, then submit the revised candidate.",
                self.message
            ),
        }
    }
}

fn current_request(messages: &[Message], turn_id: &str) -> Result<RequirementSource, String> {
    messages
        .iter()
        .rev()
        .find(|message| {
            message.is_actual_user_message() && message.metadata.turn_id.as_deref() == Some(turn_id)
        })
        .and_then(|message| {
            let text = match &message.content {
                MessageContent::Text(text) | MessageContent::Multimodal { text, .. } => text,
                _ => return None,
            };
            Some(RequirementSource {
                id: message.id.clone(),
                text: text.clone(),
            })
        })
        .filter(|source| !source.text.trim().is_empty())
        .ok_or_else(|| "Requirement review cannot find the originating user request".into())
}

fn strip_style_blocks(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(start) = lower.find("<style") else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..start]);
        let after_start = &rest[start..];
        let lower_after_start = after_start.to_ascii_lowercase();
        let Some(end_open) = lower_after_start.find('>') else {
            break;
        };
        let after_open = &after_start[end_open + 1..];
        let lower_after_open = after_open.to_ascii_lowercase();
        let Some(end_style) = lower_after_open.find("</style>") else {
            break;
        };
        rest = &after_open[end_style + "</style>".len()..];
    }
    result
}

fn capped_source(source: String) -> String {
    if source.chars().count() <= MAX_SOURCE_CHARS {
        return source;
    }
    let mut result = source.chars().take(MAX_SOURCE_CHARS).collect::<String>();
    result.push_str("\n/* trimmed */");
    result
}

fn candidate_source(app: &Value) -> String {
    let source = &app["source"];
    let kind = source["kind"].as_str().unwrap_or("unknown");
    let mut parts = match kind {
        "html-document" => vec![strip_style_blocks(source["html"].as_str().unwrap_or(""))],
        "openui-lang" => vec![source["content"].as_str().unwrap_or("").to_owned()],
        _ => vec![String::new()],
    };
    for field in ["jsFunctions", "jsExpressions"] {
        if let Some(value) = source.get(field) {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            if !text.is_empty() {
                parts.push(format!("/* {field} */\n{text}"));
            }
        }
    }
    capped_source(parts.join("\n\n"))
}

fn review_prompt(request: &str, source: &str) -> String {
    format!(
        "You check a generated app or page against the user's request before it is shown.\n\n\
         User request:\n{}\n\n\
         Generated UI (HTML or UI source, then JavaScript when present):\n{}\n\n\
         List each part the request explicitly names: sections, modules, views, content, \
         features, actions, and explicit quantities or periods. Then list only parts the UI \
         clearly fails to provide. A named section counts only when it has its own visible \
         block; a named action counts only when a control performs it; a quantity or period \
         counts only when all of it is shown or reachable; a requested summary or statistic \
         must be computed from the user's records. Do not add requirements the user did not \
         state, and do not judge style, wording or data accuracy. When unsure, treat it as \
         provided. Reply with JSON only: {{\"missing\":[\"short description\"]}}. Use an \
         empty array when nothing clearly requested is missing.",
        request.chars().take(2_000).collect::<String>(),
        source
    )
}

fn parse_missing(text: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    let missing = value.get("missing")?.as_array()?;
    Some(
        missing
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .take(6)
            .map(|item| item.chars().take(160).collect())
            .collect(),
    )
}

fn unavailable(reason: &str) -> Value {
    json!({"status":"skipped","method":"coverage_review","reason":reason})
}

pub(crate) async fn review_candidate(
    context: &ToolUseContext,
    app: &Value,
    _state: &Value,
    _evidence: &Value,
) -> Result<Value, ReviewFailure> {
    let Some(session_id) = context.session_id.as_deref() else {
        return Ok(unavailable("missing_session"));
    };
    let Some(turn_id) = context.dialog_turn_id.as_deref() else {
        return Ok(unavailable("missing_user_turn"));
    };
    let Some(client) = context.model_client.as_ref() else {
        return Ok(unavailable("review_model_unavailable"));
    };
    let coordinator = match crate::agentic::coordination::get_global_coordinator() {
        Some(coordinator) => coordinator,
        None => return Ok(unavailable("session_owner_unavailable")),
    };
    let manager = coordinator.get_session_manager();
    let messages = match manager.get_messages(session_id).await {
        Ok(messages) => messages,
        Err(_) => return Ok(unavailable("conversation_unavailable")),
    };
    let request = match current_request(&messages, turn_id) {
        Ok(source) => source,
        Err(_) => return Ok(unavailable("user_request_unavailable")),
    };
    let source = candidate_source(app);
    let prompt = review_prompt(&request.text, &source);
    let trace_dir = manager
        .persistent_model_exchange_trace_dir(session_id)
        .await;
    let trace = prepare_model_exchange_trace_for_workspace(
        session_id,
        turn_id,
        context.workspace.as_ref(),
        trace_dir.as_deref(),
        ModelExchangeTraceOperation {
            kind: "genui_requirement_review",
            id: context.tool_call_id.as_deref().unwrap_or(turn_id),
            trigger: None,
        },
        client,
    )
    .await;
    let response = tokio::time::timeout(
        REVIEW_TIMEOUT,
        client.send_message_once_with_trace_and_request_context(
            vec![AIMessage::user(prompt)],
            None,
            None,
            trace,
        ),
    )
    .await;
    let response = match response {
        Ok(Ok(response)) if response.tool_calls.is_none() => response,
        Ok(Ok(_)) => return Ok(unavailable("review_returned_tool_call")),
        Ok(Err(_)) => return Ok(unavailable("review_request_failed")),
        Err(_) => return Ok(unavailable("review_timed_out")),
    };
    let Some(missing) = parse_missing(&response.text) else {
        return Ok(unavailable("review_response_unreadable"));
    };
    if !missing.is_empty() {
        return Err(ReviewFailure::candidate(format!(
            "The coverage review found clearly missing requested parts: {}",
            missing.join("; ")
        )));
    }
    let mut result = json!({
        "status":"passed",
        "method":"coverage_review",
        "sourceIds":[request.id],
        "modelId":context.primary_model_facts.model_id,
        "missing":[]
    });
    if let Some(usage) = response.usage {
        result["usage"] = json!(usage);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_review_source_excludes_css_and_caps_input() {
        let app = json!({"source":{"kind":"html-document","html":"<style>.card { color:red }</style><main>Today</main>","jsFunctions":"function refresh() {}"}});
        let source = candidate_source(&app);
        assert!(!source.contains("color:red"));
        assert!(source.contains("<main>Today</main>"));
        assert!(source.contains("function refresh()"));

        let large = json!({"source":{"kind":"html-document","html":format!("<main>{}</main>", "x".repeat(20_000))}});
        assert!(
            candidate_source(&large).chars().count()
                <= MAX_SOURCE_CHARS + "\n/* trimmed */".chars().count()
        );
    }

    #[test]
    fn request_contains_only_the_current_user_message_and_candidate_source() {
        let messages = vec![
            Message::user("Earlier request".into()).with_turn_id("old".into()),
            Message::user("Today outfit".into()).with_turn_id("current".into()),
            Message::user("Future request".into()).with_turn_id("next".into()),
        ];
        let request = current_request(&messages, "current").unwrap();
        assert_eq!(request.text, "Today outfit");
        let prompt = review_prompt(&request.text, "<main>Outfit</main>");
        assert!(prompt.contains("Today outfit"));
        assert!(prompt.contains("<main>Outfit</main>"));
        assert!(!prompt.contains("Earlier request"));
        assert!(!prompt.contains("Future request"));
    }

    #[test]
    fn simple_missing_list_parser_tolerates_invalid_responses() {
        assert_eq!(
            parse_missing(r#"{"missing":["budget","",3]}"#).unwrap(),
            vec!["budget"]
        );
        assert_eq!(
            parse_missing(r#"{"missing":[]}"#).unwrap(),
            Vec::<String>::new()
        );
        assert!(parse_missing("not JSON").is_none());
        assert!(parse_missing(r#"{"requirements":[]}"#).is_none());
    }

    #[test]
    fn unavailable_review_is_recorded_as_skipped() {
        assert_eq!(unavailable("review_timed_out")["status"], "skipped");
    }
}
