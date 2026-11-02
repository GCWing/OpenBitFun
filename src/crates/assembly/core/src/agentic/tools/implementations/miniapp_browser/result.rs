//! Model-facing envelopes and node rendering for the MiniAppBrowser tool.
//!
//! Every response keeps the same shape the rest of the Agent tools use
//! (`ok` / `action` / `data`, or `ok: false` with a typed `error`), and every
//! failure carries a stable code from [`MiniAppWebErrorCode`] so the model can
//! branch on it instead of on English text.

use crate::agentic::tools::framework::ToolResult;
use crate::agentic::tools::miniapp_surface::{classify_surface_error, mint_target};
use openbitfun_product_domains::miniapp::web_surface::{MiniAppWebErrorCode, MiniAppWebNode};
use serde_json::{json, Value};

/// Cap on how many node lines a single summary carries, so an `inspect` of a
/// dense page still reads as an outline instead of flooding the transcript.
const MAX_SUMMARY_LINES: usize = 40;

pub(super) fn ok_response(action: &str, data: Value, summary: String) -> Vec<ToolResult> {
    let body = json!({
        "ok": true,
        "action": action,
        "data": data,
    });
    vec![ToolResult::ok(body, Some(summary))]
}

/// Success that also carries one image the model can look at. Used by `screenshot`,
/// where the pixels *are* the observation.
pub(super) fn ok_response_with_image(
    action: &str,
    data: Value,
    summary: String,
    image: crate::util::types::ToolImageAttachment,
) -> Vec<ToolResult> {
    let body = json!({
        "ok": true,
        "action": action,
        "data": data,
    });
    vec![ToolResult::ok_with_images(body, Some(summary), vec![image])]
}

pub(super) fn err_response(
    action: &str,
    code: MiniAppWebErrorCode,
    message: impl Into<String>,
    hints: &[&str],
) -> Vec<ToolResult> {
    let message = message.into();
    let mut summary = format!("{}: {message}", code.as_str());
    for hint in hints {
        summary.push_str("\n- ");
        summary.push_str(hint);
    }
    let body = json!({
        "ok": false,
        "action": action,
        "error": {
            "code": code.as_str(),
            "message": message,
            "hints": hints,
        },
    });
    vec![ToolResult::ok(body, Some(summary))]
}

pub(super) fn missing_param(action: &str, param: &str) -> Vec<ToolResult> {
    err_response(
        action,
        MiniAppWebErrorCode::InvalidParams,
        format!("{action} requires '{param}'."),
        &[],
    )
}

/// A target handle the surface runtime no longer knows about: reloaded,
/// re-rendered, expired, or minted by another MiniApp.
pub(super) fn target_error(action: &str, code: MiniAppWebErrorCode) -> Vec<ToolResult> {
    err_response(
        action,
        code,
        "The target handle is no longer valid for this MiniApp surface.",
        &["Call inspect or find again: targets die on reload, re-render, expiry, or app change."],
    )
}

/// Translate a surface-runtime failure into a typed, actionable response.
pub(super) fn surface_error(action: &str, message: String) -> Vec<ToolResult> {
    let code = classify_surface_error(&message);
    let hints: &[&str] = match code {
        MiniAppWebErrorCode::StaleTarget | MiniAppWebErrorCode::UnknownTarget => &[
            "Call inspect or find again: the MiniApp reloaded or re-rendered and earlier targetIds are stale.",
        ],
        MiniAppWebErrorCode::CapabilityMissing => &[
            "Check the current MiniApp's advertised capabilities. Use supported bridge/input controls or report the specific gap; do not reload or transfer presentation merely to obtain controls.",
        ],
        MiniAppWebErrorCode::BridgeUnavailable => &[
            "The MiniApp does not declare this bridge capability, so the host cannot read its internal state. Do not guess internal state.",
            "If the surface advertises dom/input, call inspect and use its available element controls. A missing bridge alone does not justify ComputerUse.",
        ],
        MiniAppWebErrorCode::BridgeTimeout | MiniAppWebErrorCode::Timeout => &[
            "The MiniApp did not answer in time. Re-observe before acting again.",
        ],
        _ => &["Re-run inspect to resynchronize with the current page state."],
    };
    err_response(action, code, message, hints)
}

/// A rendered observation: the model-facing tree plus the outline lines used as
/// the assistant summary.
pub(super) struct RenderedNodes {
    pub tree: Value,
    pub lines: Vec<String>,
}

/// Mint one target handle per node and strip the host-only node keys.
///
/// Target handles are minted in pre-order (sequentially, so handle numbering
/// follows reading order), then the tree is rebuilt. Depth is bounded by the
/// contract limits, so the rebuild recursion is safe.
pub(super) async fn render_nodes(session_id: &str, nodes: Vec<MiniAppWebNode>) -> RenderedNodes {
    let mut flattened = Vec::new();
    flatten(nodes.clone(), &mut flattened);

    let mut target_ids = Vec::with_capacity(flattened.len());
    for node in &flattened {
        let target_id = match node.node_key.as_deref() {
            Some(node_key) => mint_target(session_id, node_key, node.summary_line(""))
                .await
                .ok(),
            None => None,
        };
        target_ids.push(target_id);
    }

    let mut cursor = 0;
    let mut lines = Vec::new();
    let tree = build(nodes, &target_ids, &mut cursor, &mut lines);
    RenderedNodes { tree, lines }
}

fn flatten(nodes: Vec<MiniAppWebNode>, out: &mut Vec<MiniAppWebNode>) {
    for node in nodes {
        out.push(node.clone());
        flatten(node.children, out);
    }
}

fn build(
    nodes: Vec<MiniAppWebNode>,
    target_ids: &[Option<String>],
    cursor: &mut usize,
    lines: &mut Vec<String>,
) -> Value {
    let mut rendered = Vec::with_capacity(nodes.len());
    for node in nodes {
        let index = *cursor;
        *cursor += 1;
        let target_id = target_ids.get(index).and_then(|value| value.clone());
        if let Some(target_id) = target_id.as_deref() {
            if lines.len() < MAX_SUMMARY_LINES {
                lines.push(node.summary_line(target_id));
            }
        }
        let children = node.children;
        let mut value = json!({
            "targetId": target_id,
            "role": node.role,
            "name": node.name,
            "tag": node.tag,
            "testId": node.test_id,
            "value": node.value,
            "text": node.text,
            "enabled": node.enabled,
            "checked": node.checked,
        });
        if !children.is_empty() {
            value["children"] = build(children, target_ids, cursor, lines);
        }
        rendered.push(value);
    }
    Value::Array(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_envelopes_carry_a_code_and_never_read_as_success() {
        let response = err_response(
            "click",
            MiniAppWebErrorCode::StaleTarget,
            "target is stale",
            &["call inspect again"],
        );
        let body = response[0].content();
        assert_eq!(body["ok"], false);
        assert_eq!(body["action"], "click");
        assert_eq!(body["error"]["code"], "STALE_TARGET");

        let summary = match &response[0] {
            ToolResult::Result {
                result_for_assistant,
                ..
            } => result_for_assistant.clone().unwrap_or_default(),
            other => panic!("unexpected tool result: {other:?}"),
        };
        assert!(summary.starts_with("STALE_TARGET: target is stale"));
        assert!(summary.contains("- call inspect again"));
    }

    #[test]
    fn ok_envelopes_carry_action_and_summary() {
        let response = ok_response("sessions", json!({}), "no sessions".to_string());
        let body = response[0].content();
        assert_eq!(body["ok"], true);
        assert_eq!(body["action"], "sessions");
    }

    #[test]
    fn surface_errors_become_typed_codes() {
        let body = surface_error("click", "STALE_TARGET: frame reloaded".to_string())[0].content();
        assert_eq!(body["error"]["code"], "STALE_TARGET");
        let body = surface_error("click", "everything is on fire".to_string())[0].content();
        assert_eq!(body["error"]["code"], "HOST_ERROR");
    }

    #[test]
    fn target_errors_are_reported_as_invalid_handles() {
        let body = target_error("read", MiniAppWebErrorCode::UnknownTarget)[0].content();
        assert_eq!(body["error"]["code"], "UNKNOWN_TARGET");
        assert!(body["error"]["hints"][0]
            .as_str()
            .unwrap_or_default()
            .contains("inspect"));
    }
}
