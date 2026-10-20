//! Filter a Codex-style [`AxNode`] tree into a Set-of-Mark
//! [`InteractiveElement`] list (TuriX-CUA inspired).
//!
//! The model's job is "pick a number" — to make that work we need:
//!   1. Drop non-interactive containers (groups, scroll areas, generic AXGroup).
//!   2. Drop nodes with zero / off-screen frames.
//!   3. Sort deterministically so the same UI always yields the same `i`.
//!   4. Assign dense `i` indices (0, 1, 2, …).
//!   5. Project each global frame to JPEG image pixel coordinates so the
//!      overlay renderer knows where to paint the numbered box.
//!
//! Image projection uses [`ComputerScreenshot::image_global_bounds`] when
//! present (the host fills it for both full-display and crop-around-window
//! captures), falling back to a conservative "skip the box" when bounds
//! are unknown — better to omit a label than to paint it on the wrong
//! widget.

#![allow(dead_code)]

use openbitfun_core::agentic::tools::computer_use_host::{
    AxNode, ComputerScreenshot, InteractiveElement,
};

/// Per-host filter knobs.
#[derive(Debug, Clone)]
pub(crate) struct FilterOpts {
    /// Hard cap on emitted elements. Keep focused controls first, then the
    /// largest-area elements when exceeded so the overlay stays legible.
    pub max_elements: usize,
    /// When `true`, only elements whose frame intersects the focused
    /// window's image rectangle are kept. The host passes the rectangle
    /// via `image_global_bounds`; when bounds are missing we keep
    /// everything.
    pub clip_to_image_bounds: bool,
}

impl Default for FilterOpts {
    fn default() -> Self {
        Self {
            max_elements: 80,
            clip_to_image_bounds: true,
        }
    }
}

/// Build the SoM element list from a raw AX dump + the focused-window
/// screenshot the host already captured. The returned vector is sorted
/// deterministically and densely indexed (`elements[k].i == k as u32`).
pub(crate) fn build_interactive_elements(
    nodes: &[AxNode],
    screenshot: Option<&ComputerScreenshot>,
    opts: &FilterOpts,
) -> Vec<InteractiveElement> {
    build_interactive_elements_with_count(nodes, screenshot, opts).0
}

/// Also return the eligible count before the caller's display budget, so
/// truncation can be disclosed without confusing it with absent controls.
pub(crate) fn build_interactive_elements_with_count(
    nodes: &[AxNode],
    screenshot: Option<&ComputerScreenshot>,
    opts: &FilterOpts,
) -> (Vec<InteractiveElement>, usize) {
    let mut staged: Vec<Staged> = Vec::with_capacity(nodes.len() / 4);

    for n in nodes {
        if !is_interactive(n) {
            continue;
        }
        let Some(frame) = n.frame_global else {
            continue;
        };
        let (gx, gy, gw, gh) = frame;
        if ![gx, gy, gw, gh].iter().all(|v| v.is_finite()) || gw < 4.0 || gh < 4.0 {
            continue;
        }

        let frame_image = screenshot.and_then(|s| project_global_to_image(s, gx, gy, gw, gh));

        // When clipping is requested and the host provided bounds, drop
        // anything that falls entirely outside the captured rectangle.
        if opts.clip_to_image_bounds {
            if let Some(s) = screenshot {
                if s.image_global_bounds.is_some() && frame_image.is_none() {
                    continue;
                }
            }
        }

        staged.push(Staged {
            node_idx: n.idx,
            role: n.role.clone(),
            subrole: n.subrole.clone(),
            label: best_label(n),
            frame_global: frame,
            frame_image,
            enabled: n.enabled,
            focused: n.focused,
            ax_actionable: n.actions.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "AXPress" | "AXConfirm" | "AXOpen" | "AXShowMenu" | "AXPick"
                )
            }),
            area: gw * gh,
        });
    }

    // Overlapping bounds do not imply equivalent actions. In particular,
    // cards can contain independent buttons and editable fields; retain them.

    // Stable deterministic sort: top-to-bottom, then left-to-right.
    // Buckets of 16pt eliminate jitter from baseline differences between
    // controls on the same row.
    staged.sort_by(|a, b| {
        let (ax, ay, _, _) = a.frame_global;
        let (bx, by, _, _) = b.frame_global;
        let ay_b = (ay / 16.0).floor() as i64;
        let by_b = (by / 16.0).floor() as i64;
        ay_b.cmp(&by_b)
            .then_with(|| ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.node_idx.cmp(&b.node_idx))
    });

    let eligible_count = staged.len();
    if staged.len() > opts.max_elements {
        // Keep the largest-area elements so the overlay stays readable on
        // dense pages. We still preserve the deterministic display order
        // afterwards by re-sorting the kept slice.
        let mut by_area = staged;
        by_area.sort_by(|a, b| {
            b.focused.cmp(&a.focused).then_with(|| {
                b.area
                    .partial_cmp(&a.area)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        by_area.truncate(opts.max_elements);
        by_area.sort_by(|a, b| {
            let (ax, ay, _, _) = a.frame_global;
            let (bx, by, _, _) = b.frame_global;
            let ay_b = (ay / 16.0).floor() as i64;
            let by_b = (by / 16.0).floor() as i64;
            ay_b.cmp(&by_b)
                .then_with(|| ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.node_idx.cmp(&b.node_idx))
        });
        staged = by_area;
    }

    let elements = staged
        .into_iter()
        .enumerate()
        .map(|(i, s)| InteractiveElement {
            i: i as u32,
            node_idx: s.node_idx,
            role: s.role,
            subrole: s.subrole,
            label: s.label,
            frame_image: s.frame_image,
            frame_global: Some(s.frame_global),
            enabled: s.enabled,
            focused: s.focused,
            ax_actionable: s.ax_actionable,
        })
        .collect();
    (elements, eligible_count)
}

/// Render a compact one-line-per-element text rendering used in the model
/// prompt alongside the annotated screenshot.
pub(crate) fn render_element_tree_text(elements: &[InteractiveElement]) -> String {
    let mut out = String::with_capacity(elements.len() * 64);
    for e in elements {
        let label = e.label.as_deref().unwrap_or("");
        let role = display_role(&e.role, e.subrole.as_deref());
        let mut line = format!(
            "[{}] {} {}",
            e.i,
            role,
            serde_json::to_string(label).expect("string serialization")
        );
        if e.focused {
            line.push_str(" [focused]");
        }
        if !e.enabled {
            line.push_str(" [disabled]");
        }
        if !e.ax_actionable {
            line.push_str(" [pointer-only]");
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

#[derive(Clone)]
struct Staged {
    node_idx: u32,
    role: String,
    subrole: Option<String>,
    label: Option<String>,
    frame_global: (f64, f64, f64, f64),
    frame_image: Option<(u32, u32, u32, u32)>,
    enabled: bool,
    focused: bool,
    ax_actionable: bool,
    area: f64,
}

/// Heuristic — keep elements a sighted user would consider "clickable" /
/// "fillable" / "selectable", and explicit text containers that are large
/// enough to be primary targets (so the model can disambiguate "the
/// button labelled X" from "the row labelled X" when both exist).
fn is_interactive(n: &AxNode) -> bool {
    if !n.enabled {
        return false;
    }
    let role = n.role.as_str();

    // Always interactive roles.
    matches!(
        role,
        "AXButton"
            | "AXMenuButton"
            | "AXPopUpButton"
            | "AXCheckBox"
            | "AXRadioButton"
            | "AXSwitch"
            | "AXToggle"
            | "AXTextField"
            | "AXSecureTextField"
            | "AXSearchField"
            | "AXTextArea"
            | "AXComboBox"
            | "AXLink"
            | "AXTab"
            | "AXTabGroup"
            | "AXSlider"
            | "AXIncrementor"
            | "AXStepper"
            | "AXMenu"
            | "AXMenuItem"
            | "AXMenuBarItem"
            | "AXDisclosureTriangle"
            | "AXRow"
            | "AXOutlineRow"
            | "AXCell"
    ) ||
    // Or: any node that exposes an actionable AX action.
    n.actions.iter().any(|a| {
        matches!(
            a.as_str(),
            "AXPress" | "AXConfirm" | "AXOpen" | "AXShowMenu" | "AXPick" | "AXIncrement" | "AXDecrement"
        )
    })
}

fn best_label(n: &AxNode) -> Option<String> {
    for s in [&n.title, &n.description, &n.help, &n.value, &n.identifier]
        .into_iter()
        .flatten()
    {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(clip(trimmed, 80));
        }
    }
    None
}

fn clip(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn display_role(role: &str, subrole: Option<&str>) -> String {
    let stripped = role.strip_prefix("AX").unwrap_or(role);
    match subrole {
        Some(sr) if !sr.is_empty() => {
            let sr_stripped = sr.strip_prefix("AX").unwrap_or(sr);
            format!("{}({})", stripped, sr_stripped)
        }
        _ => stripped.to_string(),
    }
}

/// Project a global pointer-space rectangle onto the JPEG image pixel
/// grid. Returns `None` when the screenshot has no `image_global_bounds`
/// (host could not resolve the mapping), or the rectangle falls entirely
/// outside the captured area.
fn project_global_to_image(
    shot: &ComputerScreenshot,
    gx: f64,
    gy: f64,
    gw: f64,
    gh: f64,
) -> Option<(u32, u32, u32, u32)> {
    let bounds = shot.image_global_bounds.as_ref()?;
    if ![
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        gx,
        gy,
        gw,
        gh,
    ]
    .iter()
    .all(|v| v.is_finite())
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || gw <= 0.0
        || gh <= 0.0
    {
        return None;
    }

    let (left, top, width, height) = shot
        .image_content_rect
        .as_ref()
        .map(|r| (r.left, r.top, r.width, r.height))
        .unwrap_or((0, 0, shot.image_width, shot.image_height));
    if width == 0
        || height == 0
        || left.checked_add(width)? > shot.image_width
        || top.checked_add(height)? > shot.image_height
    {
        return None;
    }
    let scale_x = width as f64 / bounds.width;
    let scale_y = height as f64 / bounds.height;

    // Clip the global rectangle to the image rectangle.
    let lx = gx.max(bounds.left);
    let ty = gy.max(bounds.top);
    let rx = (gx + gw).min(bounds.left + bounds.width);
    let by = (gy + gh).min(bounds.top + bounds.height);
    if rx <= lx || by <= ty {
        // The caller can retain the global target when clipping is disabled,
        // but there is no corresponding overlay rectangle in this image.
        return None;
    }

    let ix = left + (((lx - bounds.left) * scale_x).floor() as u32).min(width - 1);
    let iy = top + (((ty - bounds.top) * scale_y).floor() as u32).min(height - 1);
    let right = left + (((rx - bounds.left) * scale_x).ceil() as u32).min(width);
    let bottom = top + (((by - bounds.top) * scale_y).ceil() as u32).min(height);
    Some((
        ix,
        iy,
        right.saturating_sub(ix).max(1),
        bottom.saturating_sub(iy).max(1),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::agentic::tools::computer_use_host::ComputerUseImageGlobalBounds;

    fn node(idx: u32, role: &str, frame: Option<(f64, f64, f64, f64)>) -> AxNode {
        AxNode {
            idx,
            parent_idx: None,
            role: role.to_string(),
            title: Some(format!("label-{idx}")),
            value: None,
            description: None,
            identifier: None,
            enabled: true,
            focused: false,
            selected: None,
            frame_global: frame,
            actions: vec!["AXPress".into()],
            role_description: None,
            subrole: None,
            help: None,
            url: None,
            expanded: None,
        }
    }

    fn screenshot() -> ComputerScreenshot {
        ComputerScreenshot {
            capture_frame: None,
            screenshot_id: Some("test-shot".to_string()),
            bytes: vec![],
            mime_type: "image/jpeg".to_string(),
            image_width: 1000,
            image_height: 800,
            native_width: 2000,
            native_height: 1600,
            display_origin_x: 0,
            display_origin_y: 0,
            vision_scale: 0.5,
            pointer_image_x: None,
            pointer_image_y: None,
            screenshot_crop_center: None,
            point_crop_half_extent_native: None,
            navigation_native_rect: None,
            quadrant_navigation_click_ready: false,
            image_content_rect: None,
            image_global_bounds: Some(ComputerUseImageGlobalBounds {
                left: 0.0,
                top: 0.0,
                width: 500.0,
                height: 400.0,
            }),
            ui_tree_text: None,
            implicit_confirmation_crop_applied: false,
        }
    }

    #[test]
    fn drops_non_interactive_and_off_screen_nodes() {
        let mut group = node(0, "AXGroup", Some((0.0, 0.0, 100.0, 100.0)));
        group.actions.clear();
        let nodes = vec![
            group,
            node(1, "AXButton", Some((10.0, 10.0, 50.0, 30.0))),
            node(2, "AXButton", None),
            node(3, "AXButton", Some((1.0, 1.0, 2.0, 2.0))),
        ];
        let opts = FilterOpts::default();
        let out = build_interactive_elements(&nodes, Some(&screenshot()), &opts);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].i, 0);
        assert_eq!(out[0].node_idx, 1);
    }

    #[test]
    fn projects_frame_to_image_pixels_with_scale() {
        let nodes = vec![node(0, "AXButton", Some((100.0, 80.0, 50.0, 40.0)))];
        let out = build_interactive_elements(&nodes, Some(&screenshot()), &FilterOpts::default());
        let (ix, iy, iw, ih) = out[0].frame_image.expect("frame_image present");
        // bounds 500x400 → image 1000x800 → 2x scale on both axes.
        assert_eq!(ix, 200);
        assert_eq!(iy, 160);
        assert_eq!(iw, 100);
        assert_eq!(ih, 80);
    }

    #[test]
    fn dense_indices_in_top_to_bottom_order() {
        let nodes = vec![
            node(0, "AXButton", Some((400.0, 200.0, 30.0, 20.0))),
            node(1, "AXButton", Some((100.0, 100.0, 30.0, 20.0))),
            node(2, "AXButton", Some((50.0, 200.0, 30.0, 20.0))),
        ];
        let out = build_interactive_elements(&nodes, Some(&screenshot()), &FilterOpts::default());
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].node_idx, 1); // top row
        assert_eq!(out[1].node_idx, 2); // bottom-left
        assert_eq!(out[2].node_idx, 0); // bottom-right
        for (k, e) in out.iter().enumerate() {
            assert_eq!(e.i, k as u32);
        }
    }

    #[test]
    fn caps_at_max_elements() {
        let mut nodes: Vec<_> = (0..10)
            .map(|k| node(k, "AXButton", Some((k as f64 * 50.0, 10.0, 30.0, 20.0))))
            .collect();
        nodes[9].focused = true;
        let opts = FilterOpts {
            max_elements: 4,
            ..FilterOpts::default()
        };
        let (out, eligible) =
            build_interactive_elements_with_count(&nodes, Some(&screenshot()), &opts);
        assert_eq!(out.len(), 4);
        assert_eq!(eligible - out.len(), 6);
        assert!(
            out.iter().any(|e| e.node_idx == 9),
            "focused control must survive truncation"
        );
    }

    #[test]
    fn render_text_lists_one_per_line() {
        let nodes = vec![
            node(0, "AXButton", Some((10.0, 10.0, 30.0, 20.0))),
            node(1, "AXTextField", Some((10.0, 50.0, 100.0, 20.0))),
        ];
        let elements =
            build_interactive_elements(&nodes, Some(&screenshot()), &FilterOpts::default());
        let text = render_element_tree_text(&elements);
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("[0] Button \"label-0\""));
        assert_eq!(lines.next(), Some("[1] TextField \"label-1\""));
    }

    #[test]
    fn preserves_independent_controls_inside_cards_and_overlapping_siblings() {
        let mut button = node(11, "AXButton", Some((10.0, 10.0, 60.0, 30.0)));
        button.parent_idx = Some(10);
        let mut field = node(12, "AXTextField", Some((100.0, 20.0, 100.0, 30.0)));
        field.parent_idx = Some(10);
        let nodes = vec![
            node(10, "AXCell", Some((0.0, 0.0, 300.0, 80.0))),
            button,
            field,
            node(13, "AXLink", Some((200.0, 50.0, 50.0, 20.0))),
        ];
        let out = build_interactive_elements(&nodes, Some(&screenshot()), &FilterOpts::default());
        assert_eq!(
            out.len(),
            4,
            "geometry does not establish equivalent actions"
        );
    }

    #[test]
    fn projection_respects_padding_negative_origin_and_partial_intersection() {
        let mut shot = screenshot();
        shot.image_content_rect = Some(
            openbitfun_core::agentic::tools::computer_use_host::ComputerUseImageContentRect {
                left: 100,
                top: 80,
                width: 800,
                height: 640,
            },
        );
        shot.image_global_bounds.as_mut().unwrap().left = -500.0;
        assert_eq!(
            project_global_to_image(&shot, -550.0, 50.0, 100.0, 50.0),
            Some((100, 160, 80, 80))
        );
    }

    #[test]
    fn rejects_nonfinite_geometry_and_escapes_multiline_labels() {
        let mut valid = node(1, "AXButton", Some((10.0, 10.0, 30.0, 20.0)));
        valid.title = Some("Save\n[99] \"Delete\"".into());
        let nodes = vec![
            valid,
            node(2, "AXButton", Some((f64::NAN, 10.0, 30.0, 20.0))),
        ];
        let out = build_interactive_elements(&nodes, None, &FilterOpts::default());
        assert_eq!(out.len(), 1);
        let text = render_element_tree_text(&out);
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("Save\\n[99] \\\"Delete\\\""));
    }

    #[test]
    fn unclipped_context_does_not_paint_offscreen_targets_on_image_edges() {
        let nodes = [node(1, "AXButton", Some((-100.0, 10.0, 30.0, 20.0)))];
        let out = build_interactive_elements(
            &nodes,
            Some(&screenshot()),
            &FilterOpts {
                clip_to_image_bounds: false,
                ..FilterOpts::default()
            },
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].frame_image.is_none());
        assert_eq!(out[0].frame_global, nodes[0].frame_global);
    }
}
