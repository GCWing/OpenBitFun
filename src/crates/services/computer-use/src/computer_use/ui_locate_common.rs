//! Shared validation, filter matching, and global→native pixel mapping for UI locate tools.

use crate::computer_use::displays::DisplayInfo;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::{UiElementLocateQuery, UiElementLocateResult};

pub(super) fn validate_query(q: &UiElementLocateQuery) -> OpenBitFunResult<()> {
    // node_idx alone is enough: it short-circuits BFS via the per-pid AX cache.
    if q.node_idx.is_some() {
        return Ok(());
    }
    let t = q
        .title_contains
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let tx = q
        .text_contains
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let r = q
        .role_substring
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let i = q
        .identifier_contains
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !t && !tx && !r && !i {
        return Err(OpenBitFunError::tool(
            "Provide at least one of: node_idx, text_contains, title_contains, role_substring, identifier_contains (non-empty)."
                .to_string(),
        ));
    }
    Ok(())
}

/// All AX text-bearing attributes considered by `matches_filters_attrs` / ranking.
/// Pass `None` for anything the platform host can't read (e.g. AT-SPI lacks `help`).
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct NodeAttrs<'a> {
    pub role: Option<&'a str>,
    pub subrole: Option<&'a str>,
    pub title: Option<&'a str>,
    pub value: Option<&'a str>,
    pub description: Option<&'a str>,
    pub identifier: Option<&'a str>,
    pub help: Option<&'a str>,
}

fn global_xy_to_native_with_display(
    d: &DisplayInfo,
    gx: f64,
    gy: f64,
) -> OpenBitFunResult<(u32, u32)> {
    // Phase 1 fix: `DisplayInfo.width / height` are **logical** points, and
    // `scale_factor` is the device pixel ratio (2.0 on Retina, 1.5/1.75 on
    // Windows mixed-DPI, etc.). The screenshot we hand to the model is
    // captured in **native** pixels, so to translate a global logical point
    // into the same coordinate space we must scale by `scale_factor`.
    //
    // Previously this used `d.width` for the native pixel count, which
    // collapsed to a no-op transform: clicks landed at the logical
    // coordinate inside a 2x-resolution image, missing the target by half
    // the screen on Retina displays. This was the root cause of `locate +
    // click` falling on the wrong element on multi-display / mixed-DPI Macs.
    let disp_ox = d.x as f64;
    let disp_oy = d.y as f64;
    let disp_w = d.width as f64;
    let disp_h = d.height as f64;
    if disp_w <= 0.0 || disp_h <= 0.0 || d.width == 0 || d.height == 0 {
        return Err(OpenBitFunError::tool(
            "Invalid display geometry for UI locate mapping.".to_string(),
        ));
    }
    let scale = if d.scale_factor > 0.0 {
        d.scale_factor as f64
    } else {
        1.0
    };
    let px_w = disp_w * scale;
    let px_h = disp_h * scale;
    let cx = ((gx - disp_ox) / disp_w) * px_w;
    let cy = ((gy - disp_oy) / disp_h) * px_h;
    let nx = cx.round().clamp(0.0, px_w - 1.0) as u32;
    let ny = cy.round().clamp(0.0, px_h - 1.0) as u32;
    Ok((nx, ny))
}

fn global_to_native_center(gx: f64, gy: f64) -> OpenBitFunResult<(u32, u32)> {
    let d = DisplayInfo::from_point(gx.round() as i32, gy.round() as i32)
        .map_err(|e| OpenBitFunError::tool(format!("DisplayInfo::from_point: {}", e)))?;
    global_xy_to_native_with_display(&d, gx, gy)
}

fn global_bounds_to_native_minmax(
    center_gx: f64,
    center_gy: f64,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
) -> OpenBitFunResult<(u32, u32, u32, u32)> {
    let d = DisplayInfo::from_point(center_gx.round() as i32, center_gy.round() as i32)
        .map_err(|e| OpenBitFunError::tool(format!("DisplayInfo::from_point: {}", e)))?;
    let corners = [
        (left, top),
        (left + width, top),
        (left, top + height),
        (left + width, top + height),
    ];
    let mut min_x = u32::MAX;
    let mut min_y = u32::MAX;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    for (gx, gy) in corners {
        let (nx, ny) = global_xy_to_native_with_display(&d, gx, gy)?;
        min_x = min_x.min(nx);
        min_y = min_y.min(ny);
        max_x = max_x.max(nx);
        max_y = max_y.max(ny);
    }
    Ok((min_x, min_y, max_x, max_y))
}

fn contains_ci(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    hay.to_lowercase().contains(&needle.to_lowercase())
}

/// `role_substring` match with macOS AX aliases: chat apps often expose compose as **`AXTextField`**
/// while models ask for `TextArea`; treat those as overlapping for locate/click_element.
fn role_substring_matches_ax_role(ax_role: &str, want: &str) -> bool {
    let w = want.trim();
    if w.is_empty() {
        return true;
    }
    if contains_ci(ax_role, w) {
        return true;
    }
    let wl = w.to_lowercase();
    match wl.as_str() {
        "textarea" | "text area" | "text_area" | "axtextarea" => {
            contains_ci(ax_role, "TextArea") || contains_ci(ax_role, "TextField")
        }
        "textfield" | "text field" | "text_field" | "axtextfield" => {
            contains_ci(ax_role, "TextField") || contains_ci(ax_role, "TextArea")
        }
        _ => false,
    }
}

fn combine_is_any(query: &UiElementLocateQuery) -> bool {
    matches!(query.filter_combine.as_deref(), Some("any") | Some("or"))
}

/// `role_substring` evaluator that also considers `subrole` (macOS often distinguishes
/// "search field" from "plain text field" only via `AXSubrole`).
fn role_or_subrole_matches(role: Option<&str>, subrole: Option<&str>, want: &str) -> bool {
    if role_substring_matches_ax_role(role.unwrap_or(""), want) {
        return true;
    }
    if let Some(sr) = subrole {
        if !sr.is_empty() && contains_ci(sr, want) {
            return true;
        }
    }
    false
}

/// `text_contains` semantics: case-insensitive substring match against any of
/// `title | value | description | help`.
fn text_contains_matches(n: &NodeAttrs<'_>, want: &str) -> bool {
    let w = want.trim();
    if w.is_empty() {
        return true;
    }
    if contains_ci(n.title.unwrap_or(""), w) {
        return true;
    }
    if contains_ci(n.value.unwrap_or(""), w) {
        return true;
    }
    if contains_ci(n.description.unwrap_or(""), w) {
        return true;
    }
    if contains_ci(n.help.unwrap_or(""), w) {
        return true;
    }
    false
}

/// OR semantics: element matches if **at least one** non-empty filter matches.
fn matches_filters_any_attrs(query: &UiElementLocateQuery, n: &NodeAttrs<'_>) -> bool {
    let mut has_filter = false;
    let mut matched = false;
    if let Some(ref want) = query.role_substring {
        let w = want.trim();
        if !w.is_empty() {
            has_filter = true;
            if role_or_subrole_matches(n.role, n.subrole, w) {
                matched = true;
            }
        }
    }
    if let Some(ref want) = query.title_contains {
        let w = want.trim();
        if !w.is_empty() {
            has_filter = true;
            if contains_ci(n.title.unwrap_or(""), w) {
                matched = true;
            }
        }
    }
    if let Some(ref want) = query.text_contains {
        let w = want.trim();
        if !w.is_empty() {
            has_filter = true;
            if text_contains_matches(n, w) {
                matched = true;
            }
        }
    }
    if let Some(ref want) = query.identifier_contains {
        let w = want.trim();
        if !w.is_empty() {
            has_filter = true;
            if contains_ci(n.identifier.unwrap_or(""), w) {
                matched = true;
            }
        }
    }
    has_filter && matched
}

/// AND semantics (default): **every** non-empty filter must match the same element.
fn matches_filters_all_attrs(query: &UiElementLocateQuery, n: &NodeAttrs<'_>) -> bool {
    if let Some(ref want) = query.role_substring {
        let w = want.trim();
        if !w.is_empty() && !role_or_subrole_matches(n.role, n.subrole, w) {
            return false;
        }
    }
    if let Some(ref want) = query.title_contains {
        let w = want.trim();
        if !w.is_empty() && !contains_ci(n.title.unwrap_or(""), w) {
            return false;
        }
    }
    if let Some(ref want) = query.text_contains {
        let w = want.trim();
        if !w.is_empty() && !text_contains_matches(n, w) {
            return false;
        }
    }
    if let Some(ref want) = query.identifier_contains {
        let w = want.trim();
        if !w.is_empty() && !contains_ci(n.identifier.unwrap_or(""), w) {
            return false;
        }
    }
    true
}

/// Structured matcher (preferred, used by macOS host).
pub(super) fn matches_filters_attrs(query: &UiElementLocateQuery, n: &NodeAttrs<'_>) -> bool {
    if combine_is_any(query) {
        matches_filters_any_attrs(query, n)
    } else {
        matches_filters_all_attrs(query, n)
    }
}

#[allow(dead_code)] // Used by windows_ax_ui / linux_ax_ui (not compiled on macOS)
#[allow(clippy::too_many_arguments)]
pub(super) fn ok_result(
    gx: f64,
    gy: f64,
    bounds_left: f64,
    bounds_top: f64,
    bounds_width: f64,
    bounds_height: f64,
    matched_role: String,
    matched_title: Option<String>,
    matched_identifier: Option<String>,
) -> OpenBitFunResult<UiElementLocateResult> {
    ok_result_with_context(
        gx,
        gy,
        bounds_left,
        bounds_top,
        bounds_width,
        bounds_height,
        matched_role,
        matched_title,
        matched_identifier,
        None,
        1,
        vec![],
    )
}

#[allow(clippy::too_many_arguments)]
fn ok_result_with_context(
    gx: f64,
    gy: f64,
    bounds_left: f64,
    bounds_top: f64,
    bounds_width: f64,
    bounds_height: f64,
    matched_role: String,
    matched_title: Option<String>,
    matched_identifier: Option<String>,
    parent_context: Option<String>,
    total_matches: u32,
    other_matches: Vec<String>,
) -> OpenBitFunResult<UiElementLocateResult> {
    let (nx, ny) = global_to_native_center(gx, gy)?;
    let (nminx, nminy, nmaxx, nmaxy) = if bounds_width > 0.0 && bounds_height > 0.0 {
        global_bounds_to_native_minmax(
            gx,
            gy,
            bounds_left,
            bounds_top,
            bounds_width,
            bounds_height,
        )?
    } else {
        (nx, ny, nx, ny)
    };
    Ok(UiElementLocateResult {
        global_center_x: gx,
        global_center_y: gy,
        native_center_x: nx,
        native_center_y: ny,
        global_bounds_left: bounds_left,
        global_bounds_top: bounds_top,
        global_bounds_width: bounds_width,
        global_bounds_height: bounds_height,
        native_bounds_min_x: nminx,
        native_bounds_min_y: nminy,
        native_bounds_max_x: nmaxx,
        native_bounds_max_y: nmaxy,
        matched_role,
        matched_title,
        matched_identifier,
        parent_context,
        total_matches,
        other_matches,
        matched_node_idx: None,
        matched_via: None,
    })
}

/// Same as [`ok_result_with_context`] plus traceability fields for `matched_node_idx` /
/// `matched_via`. New code should prefer this entry point.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub(super) fn ok_result_with_context_full(
    gx: f64,
    gy: f64,
    bounds_left: f64,
    bounds_top: f64,
    bounds_width: f64,
    bounds_height: f64,
    matched_role: String,
    matched_title: Option<String>,
    matched_identifier: Option<String>,
    parent_context: Option<String>,
    total_matches: u32,
    other_matches: Vec<String>,
    matched_node_idx: Option<u32>,
    matched_via: Option<String>,
) -> OpenBitFunResult<UiElementLocateResult> {
    let mut r = ok_result_with_context(
        gx,
        gy,
        bounds_left,
        bounds_top,
        bounds_width,
        bounds_height,
        matched_role,
        matched_title,
        matched_identifier,
        parent_context,
        total_matches,
        other_matches,
    )?;
    r.matched_node_idx = matched_node_idx;
    r.matched_via = matched_via;
    Ok(r)
}

/// Whether an element's global bounds fall within any visible display.
#[allow(dead_code)]
pub(super) fn is_element_on_screen(gx: f64, gy: f64, width: f64, height: f64) -> bool {
    // Element must have reasonable size (not a giant container)
    if width > 3000.0 || height > 2000.0 {
        return false;
    }
    // Center must be resolvable to a display
    DisplayInfo::from_point(gx.round() as i32, gy.round() as i32).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_textarea_alias_matches_axtextfield() {
        assert!(role_substring_matches_ax_role("AXTextField", "TextArea"));
        assert!(role_substring_matches_ax_role("AXTextField", "textarea"));
        assert!(!role_substring_matches_ax_role("AXButton", "TextArea"));
    }

    #[test]
    fn role_textfield_alias_matches_axtextarea() {
        assert!(role_substring_matches_ax_role("AXTextArea", "TextField"));
    }

    /// Build a synthetic `DisplayInfo` for unit tests without going through
    /// the platform-specific constructors. We only need the fields the
    /// mapping function reads.
    fn fake_display(x: i32, y: i32, w: u32, h: u32, scale: f32) -> DisplayInfo {
        let mut d: DisplayInfo = unsafe { std::mem::zeroed() };
        d.x = x;
        d.y = y;
        d.width = w;
        d.height = h;
        d.scale_factor = scale;
        d
    }

    #[test]
    fn maps_global_to_native_on_retina_display() {
        // 1440×900 logical, 2.0 scale ⇒ 2880×1800 native.
        let d = fake_display(0, 0, 1440, 900, 2.0);
        // Center: logical (720, 450) ⇒ native (1440, 900)
        let (nx, ny) = global_xy_to_native_with_display(&d, 720.0, 450.0).unwrap();
        assert_eq!((nx, ny), (1440, 900));
        // Bottom-right corner clamped to last native pixel.
        let (nx, ny) = global_xy_to_native_with_display(&d, 1440.0, 900.0).unwrap();
        assert_eq!((nx, ny), (2879, 1799));
    }

    #[test]
    fn maps_global_to_native_on_secondary_offset_display_with_fractional_scale() {
        // Secondary monitor placed to the right of a primary, 1920×1080
        // logical with 1.5 scale (common Windows config) ⇒ 2880×1620 native.
        let d = fake_display(1440, 0, 1920, 1080, 1.5);
        // A point at logical (1440 + 960, 540) = display center.
        let (nx, ny) = global_xy_to_native_with_display(&d, 2400.0, 540.0).unwrap();
        assert_eq!((nx, ny), (1440, 810));
    }

    fn q_text(needle: &str) -> UiElementLocateQuery {
        UiElementLocateQuery {
            text_contains: Some(needle.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn text_contains_matches_value_or_description() {
        let q = q_text("五子棋");
        let n_value = NodeAttrs {
            role: Some("AXStaticText"),
            value: Some("五子棋 - 经典对战"),
            ..Default::default()
        };
        assert!(matches_filters_attrs(&q, &n_value));

        let n_desc = NodeAttrs {
            role: Some("AXButton"),
            description: Some("打开五子棋"),
            ..Default::default()
        };
        assert!(matches_filters_attrs(&q, &n_desc));

        let n_help = NodeAttrs {
            role: Some("AXImage"),
            help: Some("Five In A Row 五子棋"),
            ..Default::default()
        };
        assert!(matches_filters_attrs(&q, &n_help));
    }

    #[test]
    fn text_contains_does_not_change_title_only_semantic() {
        // title_contains MUST still only inspect AXTitle; value/description should be ignored.
        let q = UiElementLocateQuery {
            title_contains: Some("Send".to_string()),
            ..Default::default()
        };
        let n = NodeAttrs {
            role: Some("AXButton"),
            title: None,
            value: Some("Send"),
            description: Some("Send message"),
            ..Default::default()
        };
        assert!(!matches_filters_attrs(&q, &n));

        let n2 = NodeAttrs {
            role: Some("AXButton"),
            title: Some("Send"),
            ..Default::default()
        };
        assert!(matches_filters_attrs(&q, &n2));
    }

    #[test]
    fn role_substring_matches_subrole() {
        let q = UiElementLocateQuery {
            role_substring: Some("SearchField".to_string()),
            ..Default::default()
        };
        // Real role is generic AXTextField, but subrole carries AXSearchField.
        let n = NodeAttrs {
            role: Some("AXTextField"),
            subrole: Some("AXSearchField"),
            ..Default::default()
        };
        assert!(matches_filters_attrs(&q, &n));
    }

    #[test]
    fn validate_query_accepts_node_idx_alone() {
        let q = UiElementLocateQuery {
            node_idx: Some(7),
            ..Default::default()
        };
        assert!(validate_query(&q).is_ok());
    }

    #[test]
    fn validate_query_accepts_text_contains_alone() {
        let q = UiElementLocateQuery {
            text_contains: Some("OK".to_string()),
            ..Default::default()
        };
        assert!(validate_query(&q).is_ok());
    }

    #[test]
    fn maps_global_to_native_with_unit_scale_is_identity() {
        let d = fake_display(0, 0, 800, 600, 1.0);
        let (nx, ny) = global_xy_to_native_with_display(&d, 100.0, 200.0).unwrap();
        assert_eq!((nx, ny), (100, 200));
    }
}
