//! Accessibility tree locate -- invoked as `ComputerUse` **`action: "locate"`** (same tool as screenshot / keys).

use crate::agentic::tools::computer_use_capability::computer_use_desktop_available;
use crate::agentic::tools::computer_use_host::{
    suggested_point_crop_half_extent_from_native_bounds, UiElementLocateQuery,
};
use crate::agentic::tools::framework::{ToolResult, ToolUseContext};
use crate::agentic::tools::implementations::computer_use_tool::computer_use_augment_result_json;
use crate::agentic::tools::parse_u64_value;
use crate::service::config::global::GlobalConfigManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde_json::{json, Value};

/// Runs native UI locate (AX / UIA / AT-SPI) for the foreground app -- `ComputerUse` `action: "locate"`.
pub(crate) async fn execute_computer_use_locate(
    input: &Value,
    context: &ToolUseContext,
) -> OpenBitFunResult<Vec<ToolResult>> {
    if context.is_remote() {
        return Err(OpenBitFunError::tool(
            "ComputerUse action locate cannot run while the session workspace is remote (SSH)."
                .to_string(),
        ));
    }
    if !computer_use_desktop_available() {
        return Err(OpenBitFunError::tool(
            "Computer use is not available on this host.".to_string(),
        ));
    }
    let Ok(service) = GlobalConfigManager::get_service().await else {
        return Err(OpenBitFunError::tool(
            "Computer use configuration is unavailable.".to_string(),
        ));
    };
    let ai: crate::service::config::types::AIConfig =
        service.get_config(Some("ai")).await.unwrap_or_default();
    if !ai.computer_use_enabled {
        return Err(OpenBitFunError::tool(
            "Computer use is disabled in OpenBitFun settings.".to_string(),
        ));
    }

    let host = context.computer_use_host.as_ref().ok_or_else(|| {
        OpenBitFunError::tool(
            "Computer use is only available in the OpenBitFun desktop app.".to_string(),
        )
    })?;

    let query = UiElementLocateQuery {
        title_contains: input
            .get("title_contains")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        role_substring: input
            .get("role_substring")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        identifier_contains: input
            .get("identifier_contains")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        max_depth: input
            .get("max_depth")
            .and_then(parse_u64_value)
            .map(|v| v as u32),
        filter_combine: input
            .get("filter_combine")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        text_contains: input
            .get("text_contains")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        node_idx: input
            .get("node_idx")
            .and_then(parse_u64_value)
            .map(|v| v as u32),
        app_state_digest: input
            .get("app_state_digest")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };

    let input_coords = json!({
        "kind": "locate",
        "title_contains": query.title_contains.clone(),
        "role_substring": query.role_substring.clone(),
        "identifier_contains": query.identifier_contains.clone(),
        "text_contains": query.text_contains.clone(),
        "node_idx": query.node_idx,
        "app_state_digest": query.app_state_digest.clone(),
        "max_depth": query.max_depth,
        "filter_combine": query.filter_combine.clone(),
    });

    let res = host.locate_ui_element_screen_center(query).await?;

    let native_w = res
        .native_bounds_max_x
        .saturating_sub(res.native_bounds_min_x)
        .saturating_add(1);
    let native_h = res
        .native_bounds_max_y
        .saturating_sub(res.native_bounds_min_y)
        .saturating_add(1);

    let gx = res.global_center_x.round() as i64;
    let gy = res.global_center_y.round() as i64;

    let suggested_half = suggested_point_crop_half_extent_from_native_bounds(native_w, native_h);

    let coordinate_hints = json!({
        "click_element": {
            "action": "click_element",
            "note": "Fastest path: use click_element with the same locate filters. No screenshot needed."
        },
        "mouse_move_screen": {
            "action": "mouse_move",
            "use_screen_coordinates": true,
            "x": gx,
            "y": gy,
            "note": "Global display coordinates (host native units). No prior screenshot required."
        },
        "screenshot_point_crop": {
            "action": "screenshot",
            "screenshot_crop_center_x": res.native_center_x,
            "screenshot_crop_center_y": res.native_center_y,
            "screenshot_crop_half_extent_native": suggested_half,
            "note": "Point-crop screenshot centered on the element for visual verification."
        },
        "native_extent_px": {
            "width": native_w,
            "height": native_h,
        }
    });

    let mut body = json!({
        "success": true,
        "action": "locate",
        "global_center_x": res.global_center_x,
        "global_center_y": res.global_center_y,
        "native_center_x": res.native_center_x,
        "native_center_y": res.native_center_y,
        "global_bounds_left": res.global_bounds_left,
        "global_bounds_top": res.global_bounds_top,
        "global_bounds_width": res.global_bounds_width,
        "global_bounds_height": res.global_bounds_height,
        "native_bounds_min_x": res.native_bounds_min_x,
        "native_bounds_min_y": res.native_bounds_min_y,
        "native_bounds_max_x": res.native_bounds_max_x,
        "native_bounds_max_y": res.native_bounds_max_y,
        "native_extent_width": native_w,
        "native_extent_height": native_h,
        "coordinate_hints": coordinate_hints,
        "matched_role": res.matched_role,
        "matched_title": res.matched_title,
        "matched_identifier": res.matched_identifier,
    });

    // Include disambiguation info when multiple matches were found
    if res.total_matches > 1 {
        body["total_matches"] = json!(res.total_matches);
        body["warning"] = json!(format!(
            "{} elements matched; returning the best-ranked one. See `other_matches` for alternatives.",
            res.total_matches
        ));
    }
    if let Some(ref pc) = res.parent_context {
        body["parent_context"] = json!(pc);
    }
    if !res.other_matches.is_empty() {
        body["other_matches"] = json!(res.other_matches);
    }

    let body = computer_use_augment_result_json(host.as_ref(), body, Some(input_coords)).await;

    let match_info = if res.total_matches > 1 {
        format!(" ({} matches, best ranked)", res.total_matches)
    } else {
        String::new()
    };
    let summary = format!(
        "AX match: role={} native_center=({}, {}) native_bounds=[{}..{}, {}..{}] global_center=({:.1}, {:.1}){}",
        res.matched_role,
        res.native_center_x,
        res.native_center_y,
        res.native_bounds_min_x,
        res.native_bounds_max_x,
        res.native_bounds_min_y,
        res.native_bounds_max_y,
        res.global_center_x,
        res.global_center_y,
        match_info,
    );

    Ok(vec![ToolResult::ok(body, Some(summary))])
}
