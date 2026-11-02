//! Computer Use observations must reach the model, not just the tool card.
//!
//! The framework's `result_for_assistant` replaces `data` in provider messages.
//! A count such as "16 apps listed" is therefore not a usable observation.
//! Keep action hints while including every structured observation field. Image
//! bytes remain in the separate typed attachments; Computer Use data contains
//! their geometry and references, not base64 image bodies.

use crate::agentic::tools::framework::ToolResult;
use openbitfun_agent_tools::render_tool_result_for_assistant;
use serde_json::{json, Value};

/// Legacy display-navigation enums stay in persisted/wire data for old clients.
/// Present the native adapter's actual capture scope to the model instead.
fn model_observation(data: &Value) -> Value {
    let mut observation = data.clone();
    let scope = data
        .pointer("/computer_use_context/capture_scope")
        .and_then(Value::as_str);
    if matches!(scope, Some("window" | "authorized_portal_stream")) {
        if observation.get("hierarchical_navigation").is_some() {
            observation["hierarchical_navigation"] = json!({
                "phase": scope,
                "instruction": "This image shows the authorized capture surface. Use app-scoped observed nodes, OCR targets, or image_xy with this screenshot_id. Image pixels are not global desktop coordinates; the human foreground app is not the capture target."
            });
        }
        if let Some(state) = observation
            .get_mut("interaction_state")
            .and_then(Value::as_object_mut)
        {
            state.remove("last_screenshot_kind");
        }
        if let Some(fields) = observation.as_object_mut() {
            fields.remove("recommended_next_for_click_targeting");
        }
    }
    observation
}

pub(crate) fn complete_model_results(results: &mut [ToolResult]) {
    for result in results {
        if let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = result
        {
            let projected = model_observation(data);
            let observation = render_tool_result_for_assistant("ComputerUse", &projected);
            // Screenshot hints were built by the legacy display mapper. The
            // projected observation contains the complete, accurate instruction.
            if data.get("hierarchical_navigation").is_some() && projected != *data {
                *result_for_assistant = Some(observation);
                continue;
            }
            let text = match result_for_assistant.take() {
                Some(hint) if !hint.trim().is_empty() && hint != observation => {
                    format!("{hint}\n\n{observation}")
                }
                _ => observation,
            };
            *result_for_assistant = Some(text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_use_window_scope_corrects_model_without_changing_legacy_payload() {
        let data = json!({
            "screenshot_id": "capture-12",
            "tree_text": "7 Search",
            "image_content_rect": {"width": 800, "height": 600},
            "computer_use_context": {"capture_scope": "window", "capture_target": "opaque-window"},
            "hierarchical_navigation": {"phase": "full_display"},
            "recommended_next_for_click_targeting": "mouse_move_screen_globals_then_click",
            "interaction_state": {"last_screenshot_kind": "full_display", "sequence": 12}
        });
        let mut results = vec![ToolResult::ok(
            data.clone(),
            Some("Full screenshot. Use mouse_move global coordinates".into()),
        )];
        complete_model_results(&mut results);
        let ToolResult::Result {
            data: actual,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("result")
        };
        assert_eq!(actual, &data);
        let text = result_for_assistant.as_deref().unwrap();
        for fact in ["capture-12", "7 Search", "opaque-window", "800", "sequence"] {
            assert!(text.contains(fact));
        }
        assert!(!text.contains("full_display"));
        assert!(!text.contains("Full screenshot"));
        assert!(!text.contains("mouse_move_screen_globals_then_click"));
    }

    #[test]
    fn computer_use_unknown_scope_preserves_legacy_observation() {
        let data = json!({"hierarchical_navigation": {"phase": "full_display"}});
        assert_eq!(model_observation(&data), data);
    }
}
