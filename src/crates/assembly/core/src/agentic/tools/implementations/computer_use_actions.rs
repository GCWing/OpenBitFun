//! Computer Use desktop and OS/system action implementations.
//!
//! This module owns the action logic that used to live behind ControlHub's
//! desktop/system domains. ControlHub may still share the common error envelope
//! types, but it no longer owns these Computer Use behaviors.

use crate::agentic::tools::computer_use_host::{
    AppSelector, AppWaitPredicate, ClickTarget, ComputerUseHostRef, InteractiveClickParams,
    InteractiveScrollParams, InteractiveTypeTextParams, InteractiveViewOpts, VisualClickParams,
    VisualMarkViewOpts,
};
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_services_core::system::{
    LocalSystemActionError, LocalSystemProvider, RunScriptRequest,
};
use serde_json::{json, Value};

use super::control_hub::{coded_tool_error, err_response, ControlHubError, ErrorCode};

/// Opening a URL gives no observation; page tools are preferred, while native
/// browser chrome and dialogs remain available through desktop control.
const OPEN_URL_ROUTING_NOTE: &str = "The page opened in the user's default browser; this result gives no observation. Prefer ControlHub domain=\"browser\" for page content (browser.connect, then snapshot). For native browser chrome or dialogs, use ComputerUse with the intended application and a fresh observation.";

/// Routing note attached to successful `system.open_file` results. The file
/// opens in an external application window the agent cannot see from this
/// result alone.
const OPEN_FILE_ROUTING_NOTE: &str = "The file is now open in an external application window; \
     this result gives no view into it. To interact with that window, use ComputerUse desktop \
     actions (take a screenshot first to observe it).";

pub(crate) struct ComputerUseActions;

fn clipboard_output_limit(params: &Value) -> OpenBitFunResult<usize> {
    match params
        .get("max_output_bytes")
        .or_else(|| params.get("max_bytes"))
    {
        None => Ok(64 * 1024),
        Some(value) => {
            value
                .as_u64()
                .filter(|value| *value > 0)
                .map(|value| value.min(1024 * 1024) as usize)
                .ok_or_else(|| {
                    coded_tool_error(ErrorCode::InvalidParams,
                "clipboard_get max_output_bytes (legacy max_bytes) must be a positive integer")
                })
        }
    }
}

const APP_BATCH_SHAPE: &str = r#"{"action":"app_batch","app":{"pid":123},"steps":[{"action":"app_type_text","text":"query"},{"action":"app_key_chord","keys":["return"]}]}"#;

/// Top-level keys the dispatcher still reads as compatibility aliases even
/// though the published schema no longer lists them.
const LEGACY_TOP_LEVEL_FIELDS: &[&str] = &["post_click_wait_ms", "key", "before_digest"];

fn unknown_top_level_fields(params: &Value) -> Vec<String> {
    let schema = super::ComputerUseTool::new().input_schema();
    let known = schema["properties"].as_object();
    params
        .as_object()
        .map(|fields| {
            fields
                .keys()
                .filter(|key| {
                    !known.is_some_and(|known| known.contains_key(key.as_str()))
                        && !LEGACY_TOP_LEVEL_FIELDS.contains(&key.as_str())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn app_batch_missing_steps_error(params: &Value) -> OpenBitFunError {
    let unknown = unknown_top_level_fields(params);
    let received = if unknown.is_empty() {
        String::new()
    } else {
        format!(
            " Unrecognized top-level field(s): {}; app_batch reads only `steps`.",
            unknown.join(", ")
        )
    };
    coded_tool_error(
        ErrorCode::InvalidParams,
        format!(
            "app_batch requires a top-level `steps` array of app input objects.{received} Shape: {APP_BATCH_SHAPE}. No step was executed."
        ),
    )
}

/// Steps are decoded one by one so a schema mismatch names the failing step
/// instead of a position inside the whole program.
fn parse_app_program(
    raw: Value,
) -> OpenBitFunResult<Vec<crate::agentic::tools::computer_use_host::AppInputAction>> {
    let Value::Array(values) = raw else {
        return Err(coded_tool_error(
            ErrorCode::InvalidParams,
            format!(
                "Invalid app program: `steps` must be an array of app input objects. Shape: {APP_BATCH_SHAPE}. No step was executed."
            ),
        ));
    };
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            let step_action = value
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("<missing>")
                .to_string();
            serde_json::from_value(value).map_err(|e| {
                coded_tool_error(
                    ErrorCode::InvalidParams,
                    format!(
                        "Invalid app program: steps[{index}] (action {step_action}): {e}. Each step uses one of app_click, app_type_text, app_key_chord, app_scroll, app_drag or wait with that action's fields. No step was executed."
                    ),
                )
            })
        })
        .collect()
}

fn clipboard_text_result(text: &str, max_bytes: usize) -> Value {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!({"text": &text[..end], "byte_length": text.len(), "truncated": end < text.len()})
}

fn include_app_state_image(params: &Value) -> OpenBitFunResult<bool> {
    match params.get("include_image") {
        None => Ok(true),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(coded_tool_error(
            ErrorCode::InvalidParams,
            "include_image must be a boolean",
        )),
    }
}

impl Default for ComputerUseActions {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerUseActions {
    pub(crate) fn new() -> Self {
        Self
    }

    // ── Desktop domain ─────────────────────────────────────────────────

    pub(crate) async fn handle_desktop(
        &self,
        action: &str,
        params: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let host = context.computer_use_host.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "Desktop control is only available in the OpenBitFun desktop app".to_string(),
            )
        })?;

        // Legacy desktop implementation shared by the dedicated ComputerUse
        // tool while ControlHub's public desktop domain remains disabled.
        match action {
            "list_displays" => {
                let displays = host.list_displays().await?;
                let active = host.focused_display_id();
                let count = displays.len();
                return Ok(vec![ToolResult::ok(
                    json!({
                        "displays": displays,
                        "active_display_id": active,
                    }),
                    Some(format!("{} display(s) detected", count)),
                )]);
            }
            // High-leverage UX primitive: paste arbitrary text into the
            // currently focused input via the system clipboard, optionally
            // clearing first and submitting after. This collapses the
            // canonical IM/search flow:
            //
            //   clipboard_set + key_chord(cmd+v) + key_chord(return)
            //
            // ...into a single tool call. It is also the **only** robust way
            // to enter CJK / emoji / multi-line text — `type_text` goes
            // through the per-character key path and is at the mercy of
            // every IME on the host. This is exactly the pattern Codex
            // uses (`pbcopy` + cmd+v) to keep WeChat / iMessage flows
            // smooth.
            //
            // Params:
            //   - text          (required) — text to paste
            //   - clear_first   (bool, default false) — cmd+a before paste,
            //                   so the new text REPLACES whatever was there
            //   - submit        (bool, default false) — press Return after
            //                   paste; switches to "send the message" mode
            //   - submit_keys   (array, default ["return"]) — override the
            //                   submit chord (e.g. ["command","return"] for
            //                   Slack / multi-line apps)
            //
            // Returns the same envelope as a `key_chord` so the model can
            // chain a verification screenshot exactly as before.
            "paste" => {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        coded_tool_error(ErrorCode::InvalidParams, "desktop.paste requires 'text'\nHints: example { \"action\":\"paste\", \"text\":\"hello\", \"submit\":true }")
                    })?;
                let clear_first = params
                    .get("clear_first")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let submit = params
                    .get("submit")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let submit_keys: Vec<String> = match params.get("submit_keys") {
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect(),
                    Some(Value::String(s)) => vec![s.to_string()],
                    _ => vec!["return".to_string()],
                };

                if let Err(e) = LocalSystemProvider::new().clipboard_write_text(text).await {
                    return Ok(local_system_error_response("desktop", "paste", e));
                }

                let paste_chord = match std::env::consts::OS {
                    "macos" => vec!["command".to_string(), "v".to_string()],
                    _ => vec!["control".to_string(), "v".to_string()],
                };

                if clear_first {
                    let select_all = match std::env::consts::OS {
                        "macos" => vec!["command".to_string(), "a".to_string()],
                        _ => vec!["control".to_string(), "a".to_string()],
                    };
                    host.key_chord(select_all).await?;
                }
                host.key_chord(paste_chord).await?;
                // A paste lands in whatever already had focus and never moves
                // the pointer, so it is not a reason to demand a fresh capture.
                // This must run for *every* paste, not just `submit: true`:
                // pasting and then sending a separate Enter `key_chord` is the
                // common shape, and leaving the guard armed refuses that Enter
                // with advice ("call `screenshot` first") that a text-only model
                // cannot act on.
                host.computer_use_trust_pointer_after_text_input();
                if submit {
                    host.key_chord(submit_keys.clone()).await?;
                }

                let summary = match (clear_first, submit) {
                    (false, false) => format!("Pasted {} chars", text.chars().count()),
                    (true, false) => {
                        format!("Replaced focused field with {} chars", text.chars().count())
                    }
                    (false, true) => format!("Pasted {} chars and submitted", text.chars().count()),
                    (true, true) => {
                        format!("Replaced + submitted ({} chars)", text.chars().count())
                    }
                };
                return Ok(vec![ToolResult::ok(
                    json!({
                        "success": true,
                        "action": "paste",
                        "char_count": text.chars().count(),
                        "byte_length": text.len(),
                        "clear_first": clear_first,
                        "submitted": submit,
                        "submit_keys": if submit { Some(submit_keys) } else { None },
                    }),
                    Some(summary),
                )]);
            }

            // ── AX-first actions (Codex parity) ───────────────────────
            // These operate on the typed AppSelector / AxNode envelope.
            "list_apps"
            | "list_windows"
            | "get_app_state"
            | "get_app_shortcuts"
            | "app_batch"
            | "app_drag"
            | "app_click"
            | "app_type_text"
            | "app_scroll"
            | "app_key_chord"
            | "app_wait_for"
            | "build_interactive_view"
            | "interactive_click"
            | "interactive_type_text"
            | "interactive_scroll"
            | "build_visual_mark_view"
            | "visual_click" => {
                let text_only = !context.primary_model_supports_image_understanding();
                return self
                    .handle_desktop_ax(host, action, params, text_only, Some(context))
                    .await;
            }
            "focus_display" => {
                // Accept `null` (or omitted `display_id`) to clear the pin
                // and fall back to "screen under the pointer". An explicit
                // numeric id pins that display until cleared.
                let display_id = match params.get("display_id") {
                    Some(Value::Null) | None => None,
                    Some(v) => Some(v.as_u64().ok_or_else(|| {
                        OpenBitFunError::tool(
                            "focus_display: 'display_id' must be a non-negative integer or null"
                                .to_string(),
                        )
                    })? as u32),
                };
                host.focus_display(display_id).await?;
                let displays = host.list_displays().await?;
                let summary = match display_id {
                    Some(id) => format!("Pinned display {}", id),
                    None => "Cleared display pin (will follow mouse)".to_string(),
                };
                return Ok(vec![ToolResult::ok(
                    json!({
                        "active_display_id": display_id,
                        "displays": displays,
                    }),
                    Some(summary),
                )]);
            }
            _ => {}
        }

        // UX shortcut: every screen-coordinate action accepts an optional
        // `display_id`. If present (and different from the currently pinned
        // display), pin it BEFORE forwarding so the model doesn't need a
        // separate `focus_display` round-trip. Pin is sticky — subsequent
        // actions on the same screen don't need to re-specify. Pass
        // `display_id: null` to clear the pin in the same call.
        if let Some(v) = params.get("display_id") {
            let target = match v {
                Value::Null => None,
                v => Some(v.as_u64().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "display_id must be a non-negative integer or null".to_string(),
                    )
                })? as u32),
            };
            if host.focused_display_id() != target {
                host.focus_display(target).await?;
            }
        }

        let mut cu_input = params.clone();
        if let Value::Object(ref mut map) = cu_input {
            map.insert("action".to_string(), json!(action));
            // Strip the ControlHub-only field so the legacy ComputerUseTool
            // doesn't trip on an unrecognised parameter.
            map.remove("display_id");
        }

        let cu_tool = super::computer_use_tool::ComputerUseTool::new();
        cu_tool.call_impl(&cu_input, context).await
    }

    // ── Desktop AX-first dispatch (Codex parity) ──────────────────────
    // Routes the seven new app-targeted actions through the typed
    // `ComputerUseHost` API. Every successful response carries a
    // unified envelope: `target_app`, `background_input`, `before_digest`
    // and (for state queries) `app_state`, whose `tree_text` is the single
    // rendering of the AX tree — so the model can reason about state
    // before/after each action without re-querying.
    async fn handle_desktop_ax(
        &self,
        host: &ComputerUseHostRef,
        action: &str,
        params: &Value,
        text_only: bool,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        // ── Helpers ─────────────────────────────────────────────────
        fn parse_selector(v: &Value) -> OpenBitFunResult<AppSelector> {
            let obj = v.get("app").ok_or_else(|| {
                coded_tool_error(
                    ErrorCode::InvalidParams,
                    "missing 'app' selector (pid|bundle_id|name)",
                )
            })?;
            let sel: AppSelector = serde_json::from_value(obj.clone()).map_err(|e| {
                coded_tool_error(
                    ErrorCode::InvalidParams,
                    format!("bad 'app' selector: {} (expect {{pid|bundle_id|name}})", e),
                )
            })?;
            sel.validate_window_target()
                .map_err(OpenBitFunError::tool)?;
            if sel.is_empty() {
                return Err(coded_tool_error(
                    ErrorCode::InvalidParams,
                    "'app' must include at least one of pid|bundle_id|name",
                ));
            }
            Ok(sel)
        }

        fn parse_click_target(v: &Value) -> OpenBitFunResult<ClickTarget> {
            if v.get("kind").is_some() {
                return serde_json::from_value(v.clone()).map_err(|e| {
                    coded_tool_error(ErrorCode::InvalidParams, format!("bad ClickTarget: {} (expected {{\"kind\":\"node_idx\", \"idx\":N}}, {{\"kind\":\"image_xy\",\"x\":0,\"y\":0}}, {{\"kind\":\"image_grid\",\"x0\":0,\"y0\":0,\"width\":300,\"height\":300,\"rows\":15,\"cols\":15,\"row\":7,\"col\":7,\"intersections\":true}}, {{\"kind\":\"visual_grid\",\"rows\":15,\"cols\":15,\"row\":7,\"col\":7,\"intersections\":true}}, {{\"kind\":\"screen_xy\",\"x\":0,\"y\":0}}, or {{\"kind\":\"ocr_text\",\"needle\":\"...\"}})",
                        e))
                });
            }
            if let Some(idx) = v.get("node_idx").and_then(|x| x.as_u64()) {
                return Ok(ClickTarget::NodeIdx {
                    idx: u32::try_from(idx).map_err(|_| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            "node_idx exceeds the supported index range",
                        )
                    })?,
                });
            }
            if let Some(obj) = v.get("screen_xy") {
                let x = obj.get("x").and_then(|x| x.as_f64()).ok_or_else(|| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        "screen_xy target requires numeric x",
                    )
                })?;
                let y = obj.get("y").and_then(|y| y.as_f64()).ok_or_else(|| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        "screen_xy target requires numeric y",
                    )
                })?;
                return Ok(ClickTarget::ScreenXy { x, y });
            }
            if let Some(obj) = v.get("image_xy") {
                let x = obj.get("x").and_then(|x| x.as_i64()).ok_or_else(|| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        "image_xy target requires integer x",
                    )
                })?;
                let y = obj.get("y").and_then(|y| y.as_i64()).ok_or_else(|| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        "image_xy target requires integer y",
                    )
                })?;
                return Ok(ClickTarget::ImageXy {
                    x: i32::try_from(x).map_err(|_| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            "image_xy x exceeds the supported coordinate range",
                        )
                    })?,
                    y: i32::try_from(y).map_err(|_| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            "image_xy y exceeds the supported coordinate range",
                        )
                    })?,
                    screenshot_id: obj
                        .get("screenshot_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
            if let Some(obj) = v.get("image_grid") {
                let target = json!({
                    "kind": "image_grid",
                    "x0": obj.get("x0").cloned().unwrap_or(Value::Null),
                    "y0": obj.get("y0").cloned().unwrap_or(Value::Null),
                    "width": obj.get("width").cloned().unwrap_or(Value::Null),
                    "height": obj.get("height").cloned().unwrap_or(Value::Null),
                    "rows": obj.get("rows").cloned().unwrap_or(Value::Null),
                    "cols": obj.get("cols").cloned().unwrap_or(Value::Null),
                    "row": obj.get("row").cloned().unwrap_or(Value::Null),
                    "col": obj.get("col").cloned().unwrap_or(Value::Null),
                    "intersections": obj.get("intersections").cloned().unwrap_or(json!(false)),
                    "screenshot_id": obj.get("screenshot_id").cloned().unwrap_or(Value::Null),
                });
                return serde_json::from_value(target).map_err(|e| {
                    coded_tool_error(ErrorCode::InvalidParams, format!("bad image_grid target: {} (need x0,y0,width,height,rows,cols,row,col; optional intersections)", e))
                });
            }
            if let Some(obj) = v.get("visual_grid") {
                let target = json!({
                    "kind": "visual_grid",
                    "rows": obj.get("rows").cloned().unwrap_or(Value::Null),
                    "cols": obj.get("cols").cloned().unwrap_or(Value::Null),
                    "row": obj.get("row").cloned().unwrap_or(Value::Null),
                    "col": obj.get("col").cloned().unwrap_or(Value::Null),
                    "intersections": obj.get("intersections").cloned().unwrap_or(json!(false)),
                    "wait_ms_after_detection": obj.get("wait_ms_after_detection").cloned().unwrap_or(Value::Null),
                });
                return serde_json::from_value(target).map_err(|e| {
                    coded_tool_error(ErrorCode::InvalidParams, format!("bad visual_grid target: {} (need rows,cols,row,col; optional intersections)", e))
                });
            }
            if v.get("x").is_some() || v.get("y").is_some() {
                let x = v.get("x").and_then(|x| x.as_f64()).ok_or_else(|| {
                    coded_tool_error(ErrorCode::InvalidParams, "screen target requires numeric x")
                })?;
                let y = v.get("y").and_then(|y| y.as_f64()).ok_or_else(|| {
                    coded_tool_error(ErrorCode::InvalidParams, "screen target requires numeric y")
                })?;
                return Ok(ClickTarget::ScreenXy { x, y });
            }
            if let Some(ocr) = v.get("ocr_text") {
                let needle = ocr
                    .get("needle")
                    .or_else(|| ocr.get("text"))
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            "ocr_text target requires needle",
                        )
                    })?;
                return Ok(ClickTarget::OcrText {
                    needle: needle.to_string(),
                });
            }
            Err(coded_tool_error(ErrorCode::InvalidParams, "unsupported ClickTarget. Use {\"kind\":\"node_idx\",\"idx\":N}, {\"node_idx\":N}, {\"kind\":\"image_xy\",\"x\":0,\"y\":0}, {\"image_xy\":{\"x\":0,\"y\":0}}, {\"kind\":\"image_grid\",\"x0\":0,\"y0\":0,\"width\":300,\"height\":300,\"rows\":15,\"cols\":15,\"row\":7,\"col\":7,\"intersections\":true}, {\"kind\":\"visual_grid\",\"rows\":15,\"cols\":15,\"row\":7,\"col\":7,\"intersections\":true}, {\"kind\":\"screen_xy\",\"x\":0,\"y\":0}, or {\"ocr_text\":{\"needle\":\"...\"}}."))
        }

        fn parse_wait_predicate(v: &Value) -> OpenBitFunResult<AppWaitPredicate> {
            if v.get("kind").is_some() {
                return serde_json::from_value(v.clone()).map_err(|e| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        format!("bad app_wait_for predicate: {}", e),
                    )
                });
            }
            if let Some(obj) = v.get("digest_changed") {
                let prev_digest = obj
                    .get("prev_digest")
                    .or_else(|| obj.get("from"))
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            "digest_changed requires prev_digest",
                        )
                    })?;
                return Ok(AppWaitPredicate::DigestChanged {
                    prev_digest: prev_digest.to_string(),
                });
            }
            if let Some(obj) = v.get("title_contains") {
                let needle = obj
                    .get("needle")
                    .or_else(|| obj.get("title"))
                    .and_then(|x| x.as_str())
                    .or_else(|| obj.as_str())
                    .ok_or_else(|| {
                        coded_tool_error(ErrorCode::InvalidParams, "title_contains requires needle")
                    })?;
                return Ok(AppWaitPredicate::TitleContains {
                    needle: needle.to_string(),
                });
            }
            if let Some(obj) = v.get("role_enabled") {
                let role = obj.get("role").and_then(|x| x.as_str()).ok_or_else(|| {
                    coded_tool_error(ErrorCode::InvalidParams, "role_enabled requires role")
                })?;
                return Ok(AppWaitPredicate::RoleEnabled {
                    role: role.to_string(),
                });
            }
            if let Some(obj) = v.get("node_enabled") {
                let idx = obj
                    .get("idx")
                    .and_then(|x| x.as_u64())
                    .or_else(|| obj.as_u64())
                    .ok_or_else(|| {
                        coded_tool_error(ErrorCode::InvalidParams, "node_enabled requires idx")
                    })?;
                return Ok(AppWaitPredicate::NodeEnabled { idx: idx as u32 });
            }
            Err(coded_tool_error(ErrorCode::InvalidParams, "unsupported app_wait_for predicate. Use {\"kind\":\"digest_changed\",\"prev_digest\":\"...\"} or shorthand {\"digest_changed\":{\"prev_digest\":\"...\"}}."))
        }

        // Build the JSON view of an AppStateSnapshot for the model. Excludes
        // the heavy `screenshot` payload (it is attached out-of-band as a
        // multimodal image, not as base64 inside the JSON tree, to keep token
        // budgets under control and let the provider deliver it as `image_url`).
        //
        // `tree_text` is the **only** rendering of the AX tree we send. Results
        // used to carry a sibling `app_state_nodes` array holding the same
        // nodes as verbose JSON — one object per node, ~15 lines each. It was
        // strictly redundant (`render_tree_text` already emits idx, role,
        // title, value, identifier, description, help, url, frame and the
        // enabled/focused/selected/expanded flags, with parentage implied by
        // indentation) and nothing consumed it, yet it accounted for ~78% of a
        // `get_app_state` result: a single observation of a windowless app
        // measured 107 KB, of which 82 KB was that duplicate.
        fn snap_state_json(
            snap: &crate::agentic::tools::computer_use_host::AppStateSnapshot,
        ) -> serde_json::Value {
            // Bounded here rather than at the `get_app_state` call site: every
            // `app_click` / `app_type_text` / `app_scroll` / `app_key_chord` /
            // `app_wait_for` result carries this same post-action tree, so they
            // all shared the same unbounded-payload risk.
            let tree_text = super::computer_use_tool::clip_tree_text(
                snap.tree_text.clone(),
                super::computer_use_tool::APP_STATE_TREE_TEXT_MAX_BYTES,
            );
            let mut v = json!({
                "app": snap.app,
                "window_title": snap.window_title,
                "digest": snap.digest,
                "observation_id": snap.observation_id,
                "captured_at_ms": snap.captured_at_ms,
                "tree_text": tree_text,
                "node_count": snap.nodes.len(),
                "has_screenshot": snap.screenshot.is_some(),
            });
            if let Some(shot) = snap.screenshot.as_ref() {
                if let Some(obj) = v.as_object_mut() {
                    let meta: serde_json::Value = json!({
                    "image_width": shot.image_width,
                    "image_height": shot.image_height,
                    "screenshot_id": shot.screenshot_id, "capture_frame": shot.capture_frame,
                    "native_width": shot.native_width,
                    "native_height": shot.native_height,
                    "vision_scale": shot.vision_scale,
                    "mime_type": shot.mime_type,
                    "image_content_rect": shot.image_content_rect,
                    "image_global_bounds": shot.image_global_bounds,
                        "coordinate_hint": "Use pixels in this image with image_xy {x,y,screenshot_id}. Coordinates are relative to this image, not the desktop. Use the active mode and supported input route. A reused capture_frame is not proof that the last input was processed.",
                    });
                    let mut meta = meta;
                    if !shot.auxiliary_windows.is_empty() {
                        meta["auxiliary_windows"] = json!(shot.auxiliary_windows);
                        meta["auxiliary_hint"] = json!("auxiliary_windows are this app's open menus, popups or suggestion lists drawn over its window. image_xy input inside an image_rect goes to that popup, as a physical click would. If composited is false its pixels are missing from the image: use keyboard navigation or the AX tree instead of clicking that area.");
                    }
                    obj.insert("screenshot_meta".to_string(), meta);
                }
            }
            v
        }

        // Every ComputerUse action result that may carry a screenshot follows the same
        // shape: attach it as a multimodal image when present, otherwise fall back to a
        // text-only `ToolResult::ok`. `snap_result` / `interactive_view_result` /
        // `visual_mark_view_result` / `interactive_action_result` / `visual_action_result`
        // below all delegate to this single helper instead of re-implementing the
        // base64-encode-and-attach dance for each result type.
        fn result_with_optional_screenshot(
            data: serde_json::Value,
            summary: Option<String>,
            screenshot: Option<&crate::agentic::tools::computer_use_host::ComputerScreenshot>,
        ) -> ToolResult {
            use base64::Engine as _;
            match screenshot {
                Some(shot) => {
                    let attach = crate::util::types::ToolImageAttachment {
                        mime_type: shot.mime_type.clone(),
                        data_base64: base64::engine::general_purpose::STANDARD.encode(&shot.bytes),
                    };
                    ToolResult::ok_with_images(data, summary, vec![attach])
                }
                None => ToolResult::ok(data, summary),
            }
        }

        // Helper: build a `ToolResult` that *also* carries the focused-window
        // screenshot as an Anthropic-style multimodal image attachment. When
        // the host couldn't (or chose not to) capture, fall back to a regular
        // text-only `ToolResult::ok`.
        fn snap_result(
            data: serde_json::Value,
            summary: Option<String>,
            snap: &crate::agentic::tools::computer_use_host::AppStateSnapshot,
        ) -> ToolResult {
            result_with_optional_screenshot(data, summary, snap.screenshot.as_ref())
        }

        // Build a JSON view of an InteractiveView that excludes the heavy
        // `screenshot.bytes` payload (the JPEG is attached out-of-band as a
        // multimodal image attachment, not as base64 inside the tree).
        fn build_interactive_view_json(
            view: &crate::agentic::tools::computer_use_host::InteractiveView,
        ) -> serde_json::Value {
            let mut v = json!({
                "app": view.app,
                "window_title": view.window_title,
                "digest": view.digest,
                "observation_id": view.observation_id,
                "captured_at_ms": view.captured_at_ms,
                "elements": view.elements,
                "omitted_element_count": view.omitted_element_count,
                "tree_text": view.tree_text,
                "loop_warning": view.loop_warning,
                "has_screenshot": view.screenshot.is_some(),
            });
            if let Some(shot) = view.screenshot.as_ref() {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "screenshot_meta".to_string(),
                        json!({
                            "image_width": shot.image_width,
                            "image_height": shot.image_height,
                            "screenshot_id": shot.screenshot_id, "capture_frame": shot.capture_frame,
                            "native_width": shot.native_width,
                            "native_height": shot.native_height,
                            "vision_scale": shot.vision_scale,
                            "mime_type": shot.mime_type,
                            "image_content_rect": shot.image_content_rect,
                            "image_global_bounds": shot.image_global_bounds,
                            "coordinate_hint": "Numbered overlays are in JPEG image-pixel space. Reference elements via their `i` index using interactive_click / interactive_type_text / interactive_scroll. For pointer-only fallback, pass screenshot_id with image_xy/image_grid.",
                        }),
                    );
                }
            }
            v
        }

        fn build_visual_mark_view_json(
            view: &crate::agentic::tools::computer_use_host::VisualMarkView,
        ) -> serde_json::Value {
            let mut v = json!({
                "app": view.app,
                "window_title": view.window_title,
                "digest": view.digest,
                "observation_id": view.observation_id,
                "captured_at_ms": view.captured_at_ms,
                "marks": view.marks,
                "has_screenshot": view.screenshot.is_some(),
            });
            if let Some(shot) = view.screenshot.as_ref() {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "screenshot_meta".to_string(),
                        json!({
                            "image_width": shot.image_width,
                            "image_height": shot.image_height,
                            "screenshot_id": shot.screenshot_id, "capture_frame": shot.capture_frame,
                            "native_width": shot.native_width,
                            "native_height": shot.native_height,
                            "vision_scale": shot.vision_scale,
                            "mime_type": shot.mime_type,
                            "image_content_rect": shot.image_content_rect,
                            "image_global_bounds": shot.image_global_bounds,
                            "coordinate_hint": "Numbered visual marks are in JPEG image-pixel space. Reference marks via their `i` index using visual_click. To refine a dense area, call build_visual_mark_view again with opts.region in these screenshot pixels.",
                        }),
                    );
                }
            }
            v
        }

        // Build a JSON envelope for interactive_* action results. Includes
        // the post-action AppStateSnapshot (without screenshot bytes) and,
        // when present, the rebuilt InteractiveView.
        fn build_interactive_action_json(
            app: &crate::agentic::tools::computer_use_host::AppSelector,
            res: &crate::agentic::tools::computer_use_host::InteractiveActionResult,
            extras: serde_json::Value,
        ) -> serde_json::Value {
            let mut v = json!({
                "target_app": app,
                "app_state": snap_state_json(&res.snapshot),
                "loop_warning": res.snapshot.loop_warning,
                "execution_note": res.execution_note,
                "interactive_view": res.view.as_ref().map(build_interactive_view_json),
            });
            if let (Some(obj), Some(extras_obj)) = (v.as_object_mut(), extras.as_object()) {
                for (k, val) in extras_obj {
                    obj.insert(k.clone(), val.clone());
                }
            }
            v
        }

        fn build_visual_action_json(
            app: &crate::agentic::tools::computer_use_host::AppSelector,
            res: &crate::agentic::tools::computer_use_host::VisualActionResult,
            extras: serde_json::Value,
        ) -> serde_json::Value {
            let mut v = json!({
                "target_app": app,
                "app_state": snap_state_json(&res.snapshot),
                "loop_warning": res.snapshot.loop_warning,
                "execution_note": res.execution_note,
                "visual_mark_view": res.view.as_ref().map(build_visual_mark_view_json),
            });
            if let (Some(obj), Some(extras_obj)) = (v.as_object_mut(), extras.as_object()) {
                for (k, val) in extras_obj {
                    obj.insert(k.clone(), val.clone());
                }
            }
            v
        }

        // Attach the InteractiveView's annotated screenshot (if present)
        // as a multimodal image; otherwise fall back to text-only ok.
        fn interactive_view_result(
            data: serde_json::Value,
            summary: Option<String>,
            view: &crate::agentic::tools::computer_use_host::InteractiveView,
        ) -> ToolResult {
            result_with_optional_screenshot(data, summary, view.screenshot.as_ref())
        }

        fn visual_mark_view_result(
            data: serde_json::Value,
            summary: Option<String>,
            view: &crate::agentic::tools::computer_use_host::VisualMarkView,
        ) -> ToolResult {
            result_with_optional_screenshot(data, summary, view.screenshot.as_ref())
        }

        // Prefer attaching the rebuilt interactive view's screenshot when
        // available; otherwise fall back to the post-action snapshot's.
        fn interactive_action_result(
            data: serde_json::Value,
            summary: Option<String>,
            res: &crate::agentic::tools::computer_use_host::InteractiveActionResult,
        ) -> ToolResult {
            let shot_opt = res
                .view
                .as_ref()
                .and_then(|v| v.screenshot.as_ref())
                .or(res.snapshot.screenshot.as_ref());
            result_with_optional_screenshot(data, summary, shot_opt)
        }

        fn visual_action_result(
            data: serde_json::Value,
            summary: Option<String>,
            res: &crate::agentic::tools::computer_use_host::VisualActionResult,
        ) -> ToolResult {
            let shot_opt = res
                .view
                .as_ref()
                .and_then(|v| v.screenshot.as_ref())
                .or(res.snapshot.screenshot.as_ref());
            result_with_optional_screenshot(data, summary, shot_opt)
        }

        // These actions only make sense with a marked-up screenshot the model
        // can look at; text-only models are steered to the AX/OCR text paths.
        if text_only
            && matches!(
                action,
                "build_interactive_view"
                    | "interactive_click"
                    | "build_visual_mark_view"
                    | "visual_click"
            )
        {
            return Err(coded_tool_error(
                ErrorCode::NotAvailable,
                format!(
                    "`{}` requires a vision-capable primary model (its result is a marked-up screenshot). Use `describe_screen` or `get_app_state` to observe as text, then act with `app_click`, `click_target`, `move_to_text`, or `key_chord`.",
                    action
                ),
            ));
        }
        // Same gate, different reason: these two act on the `i` index of an
        // interactive view, and building that view is itself vision-only.
        if text_only && matches!(action, "interactive_type_text" | "interactive_scroll") {
            let replacement = if action == "interactive_scroll" {
                "app_scroll"
            } else {
                "app_type_text"
            };
            return Err(coded_tool_error(
                ErrorCode::NotAvailable,
                format!(
                    "`{action}` addresses elements by the `i` index of an interactive view, which requires a vision-capable primary model. Use `{replacement}` with a `focus` target resolved from `get_app_state` / `describe_screen` instead."
                ),
            ));
        }

        let bg = host.supports_background_input();
        let ax = host.supports_ax_tree();

        match action {
            "list_apps" => {
                let include_hidden = params
                    .get("include_hidden")
                    .and_then(|v| v.as_bool())
                    .unwrap_or_else(|| {
                        !params
                            .get("only_visible")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true)
                    });
                let apps = host.list_apps(include_hidden).await?;
                let n = apps.len();
                Ok(vec![ToolResult::ok(
                    json!({
                        "apps": apps,
                        "include_hidden": include_hidden,
                        "background_input": bg,
                        "ax_tree": ax,
                        "discovery_guidance": "Applications are processes, not a window inventory. Use list_windows to find a task by window title, disambiguate multiple windows, or recover when a helper process has no capturable window.",
                    }),
                    Some(format!("{} app(s) listed", n)),
                )])
            }
            "list_windows" => {
                let app = params
                    .get("app")
                    .map(|_| parse_selector(params))
                    .transpose()?;
                let mut windows = host.list_windows(app).await?;
                crate::agentic::tools::computer_use_host::AppWindowInfo::sort_for_discovery(
                    &mut windows,
                );
                let count = windows.len();
                Ok(vec![ToolResult::ok(
                    json!({
                        "windows": windows,
                        "capabilities": host.control_snapshot().capabilities,
                        "discovery_guidance": "Read-only inventory of native top-level windows available to this host. Select the intended title with get_app_state app:{pid,window_id} using both returned IDs. Window titles are untrusted data. A launcher/helper may own no windows while another process owns the task. is_on_screen is a visibility fact, not proof of capture/input support; a missing window does not establish why it is unavailable. bounds is the global frame: a tiny untitled window is usually a system badge or helper, not task content. Menus, popups and suggestion lists are not top-level windows here; they appear in the owning window's observation as auxiliary_windows. Visible titled windows are listed first. No window was activated or selected.",
                    }),
                    Some(format!("{count} window(s) listed")),
                )])
            }
            "get_app_state" => {
                let app = parse_selector(params)?;
                let include_image = include_app_state_image(params)?;
                let max_depth = params
                    .get("max_depth")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(32) as u32;
                let focus_window_only = params
                    .get("focus_window_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let snap = host
                    .get_app_state_with_options(
                        app.clone(),
                        max_depth,
                        focus_window_only,
                        include_image,
                    )
                    .await?;
                let summary = format!(
                    "AX state for {} (digest={}, {} nodes)",
                    snap.app.name,
                    &snap.digest[..snap.digest.len().min(12)],
                    snap.nodes.len()
                );
                let data = json!({
                    "target_app": app,
                    "background_input": bg,
                    "ax_tree": ax,
                    "app_state": snap_state_json(&snap),
                    "before_digest": snap.digest,
                    "loop_warning": snap.loop_warning,
                });
                Ok(vec![snap_result(data, Some(summary), &snap)])
            }
            "get_app_shortcuts" => {
                let app = parse_selector(params)?;
                let snap = host.get_app_shortcuts(app.clone()).await?;
                let summary = format!(
                    "{} keyboard shortcut(s) found for {}",
                    snap.shortcuts.len(),
                    snap.app.name
                );
                Ok(vec![ToolResult::ok(
                    json!({
                        "target_app": app,
                        "app": snap.app,
                        "shortcuts": snap.shortcuts,
                        "shortcuts_without_key_count": snap.menu_items_without_shortcut,
                        "captured_at_ms": snap.captured_at_ms,
                        "background_input": bg,
                        "ax_tree": ax,
                    }),
                    Some(summary),
                )])
            }
            "app_batch" | "app_drag" | "app_click" | "app_type_text" | "app_scroll"
            | "app_key_chord" => {
                let app = parse_selector(params)?;
                let include_image = include_app_state_image(params)?;
                // Legacy single-action calls are syntax aliases for a one-step
                // input program. No separate input+capture execution path exists.
                let raw = if action == "app_batch" {
                    params
                        .get("steps")
                        .cloned()
                        .ok_or_else(|| app_batch_missing_steps_error(params))?
                } else {
                    let fields: &[&str] = match action {
                        "app_click" => &[
                            "target",
                            "click_count",
                            "mouse_button",
                            "modifier_keys",
                            "wait_ms_after",
                        ],
                        "app_type_text" => &["text", "focus"],
                        "app_scroll" => &["dx", "dy", "focus"],
                        "app_key_chord" => &["keys", "focus_idx"],
                        "app_drag" => &["from", "to", "mouse_button", "duration_ms"],
                        _ => unreachable!(),
                    };
                    let mut step = json!({"action":action});
                    for field in fields {
                        if let Some(value) = params.get(*field) {
                            step[*field] = if matches!(*field, "target" | "focus" | "from" | "to")
                                && !value.is_null()
                            {
                                serde_json::to_value(parse_click_target(value)?)?
                            } else {
                                value.clone()
                            };
                        }
                    }
                    if action == "app_click" && step.get("wait_ms_after").is_none() {
                        if let Some(value) = params.get("post_click_wait_ms") {
                            step["wait_ms_after"] = value.clone();
                        }
                    }
                    if action == "app_key_chord" {
                        if step.get("keys").is_none() {
                            if let Some(value) = params.get("key") {
                                step["keys"] = value.clone();
                            }
                        }
                        if let Some(value) =
                            step.get("keys").and_then(Value::as_str).map(str::to_owned)
                        {
                            step["keys"] = json!([value]);
                        }
                    }
                    json!([step])
                };
                // Validate every step before any mutation, including single-action
                // aliases. Integer overflow and malformed key arrays are errors.
                let steps = parse_app_program(raw)?;
                if steps.is_empty() {
                    return Err(coded_tool_error(
                        ErrorCode::InvalidParams,
                        "steps must not be empty",
                    ));
                }
                for step in &steps {
                    super::computer_use_program::validate_step(step)
                        .map_err(|e| coded_tool_error(ErrorCode::InvalidParams, e))?;
                }
                let result = super::computer_use_program::execute(
                    host.as_ref(),
                    app,
                    steps,
                    context,
                    include_image,
                )
                .await;
                let mut data = result.receipt;
                data["action"] = json!(action);
                data["background_input"] = json!(bg);
                if action != "app_batch" {
                    let step = data["steps"]
                        .as_array()
                        .and_then(|steps| steps.first())
                        .cloned()
                        .unwrap_or(Value::Null);
                    data["action_status"] = step
                        .get("status")
                        .cloned()
                        .unwrap_or_else(|| data["status"].clone());
                    for key in ["error", "input_may_have_been_submitted"] {
                        if let Some(value) = step.get(key) {
                            data[key] = value.clone();
                        }
                    }
                    data["before_digest"] = params
                        .get("app_state_digest")
                        .or_else(|| params.get("before_digest"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                if let Some(snapshot) = result.snapshot.as_ref() {
                    data["app_state"] = snap_state_json(snapshot);
                    Ok(vec![snap_result(data, None, snapshot)])
                } else {
                    Ok(vec![ToolResult::ok(data, None)])
                }
            }
            "app_wait_for" => {
                let app = parse_selector(params)?;
                let predicate_v = params.get("predicate").cloned().ok_or_else(|| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        "app_wait_for requires 'predicate'",
                    )
                })?;
                let predicate = parse_wait_predicate(&predicate_v)?;
                let timeout_ms = params
                    .get("timeout_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(8000) as u32;
                let poll_ms = params
                    .get("poll_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(150) as u32;
                let after = host
                    .app_wait_for(app.clone(), predicate.clone(), timeout_ms, poll_ms)
                    .await?;
                let data = json!({
                    "target_app": app,
                    "background_input": bg,
                    "predicate": predicate,
                    "app_state": snap_state_json(&after),
                    "loop_warning": after.loop_warning,
                });
                Ok(vec![snap_result(
                    data,
                    Some("predicate satisfied".to_string()),
                    &after,
                )])
            }
            "build_interactive_view" => {
                let app = parse_selector(params)?;
                let opts: InteractiveViewOpts = match params.get("opts") {
                    Some(v) if !v.is_null() => serde_json::from_value(v.clone()).map_err(|e| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            format!("build_interactive_view 'opts' invalid: {}", e),
                        )
                    })?,
                    _ => InteractiveViewOpts::default(),
                };
                let view = host.build_interactive_view(app.clone(), opts).await?;
                let view_json = build_interactive_view_json(&view);
                let summary = format!(
                    "interactive view for {} ({} elements, digest={})",
                    view.app.name,
                    view.elements.len(),
                    &view.digest[..view.digest.len().min(12)]
                );
                Ok(vec![interactive_view_result(
                    view_json,
                    Some(summary),
                    &view,
                )])
            }
            "interactive_click" => {
                let app = parse_selector(params)?;
                let p: InteractiveClickParams =
                    serde_json::from_value(params.clone()).map_err(|e| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            format!("interactive_click params invalid: {}", e),
                        )
                    })?;
                let i = p.i;
                let res = host.interactive_click(app.clone(), p).await?;
                let data = build_interactive_action_json(
                    &app,
                    &res,
                    json!({ "i": i, "action": "interactive_click" }),
                );
                let summary = format!("interactive_click i={}", i);
                Ok(vec![interactive_action_result(data, Some(summary), &res)])
            }
            "build_visual_mark_view" => {
                let app = parse_selector(params)?;
                let opts: VisualMarkViewOpts = match params.get("opts") {
                    Some(v) if !v.is_null() => serde_json::from_value(v.clone()).map_err(|e| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            format!("build_visual_mark_view 'opts' invalid: {}", e),
                        )
                    })?,
                    _ => VisualMarkViewOpts::default(),
                };
                let view = host.build_visual_mark_view(app.clone(), opts).await?;
                let view_json = build_visual_mark_view_json(&view);
                let summary = format!(
                    "visual mark view for {} ({} marks, digest={})",
                    view.app.name,
                    view.marks.len(),
                    &view.digest[..view.digest.len().min(12)]
                );
                Ok(vec![visual_mark_view_result(
                    view_json,
                    Some(summary),
                    &view,
                )])
            }
            "visual_click" => {
                let app = parse_selector(params)?;
                let p: VisualClickParams = serde_json::from_value(params.clone()).map_err(|e| {
                    coded_tool_error(
                        ErrorCode::InvalidParams,
                        format!("visual_click params invalid: {}", e),
                    )
                })?;
                let i = p.i;
                let res = host.visual_click(app.clone(), p).await?;
                let data = build_visual_action_json(
                    &app,
                    &res,
                    json!({ "i": i, "action": "visual_click" }),
                );
                let summary = format!("visual_click i={}", i);
                Ok(vec![visual_action_result(data, Some(summary), &res)])
            }
            "interactive_type_text" => {
                let app = parse_selector(params)?;
                let p: InteractiveTypeTextParams =
                    serde_json::from_value(params.clone()).map_err(|e| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            format!("interactive_type_text params invalid: {}", e),
                        )
                    })?;
                let i = p.i;
                let text_len = p.text.chars().count();
                let res = host.interactive_type_text(app.clone(), p).await?;
                let data = build_interactive_action_json(
                    &app,
                    &res,
                    json!({
                        "i": i,
                        "action": "interactive_type_text",
                        "text_chars": text_len,
                    }),
                );
                let summary = match i {
                    Some(idx) => format!("interactive_type_text i={} ({} chars)", idx, text_len),
                    None => format!("interactive_type_text focused ({} chars)", text_len),
                };
                Ok(vec![interactive_action_result(data, Some(summary), &res)])
            }
            "interactive_scroll" => {
                let app = parse_selector(params)?;
                let p: InteractiveScrollParams =
                    serde_json::from_value(params.clone()).map_err(|e| {
                        coded_tool_error(
                            ErrorCode::InvalidParams,
                            format!("interactive_scroll params invalid: {}", e),
                        )
                    })?;
                let (i, dx, dy) = (p.i, p.dx, p.dy);
                let res = host.interactive_scroll(app.clone(), p).await?;
                let data = build_interactive_action_json(
                    &app,
                    &res,
                    json!({
                        "i": i,
                        "dx": dx,
                        "dy": dy,
                        "action": "interactive_scroll",
                    }),
                );
                let summary = format!("interactive_scroll i={:?} dx={} dy={}", i, dx, dy);
                Ok(vec![interactive_action_result(data, Some(summary), &res)])
            }
            other => Err(coded_tool_error(
                ErrorCode::Internal,
                format!("handle_desktop_ax called with unknown action: {}", other),
            )),
        }
    }

    // ── Browser domain ─────────────────────────────────────────────────

    // ── System domain ──────────────────────────────────────────────────

    pub(crate) async fn handle_system(
        &self,
        action: &str,
        params: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        match action {
            "open_app" => {
                let app_name = params
                    .get("app_name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| OpenBitFunError::tool("open_app requires 'app_name'".to_string()))?;

                // Phase 4 (p4_open_app_unify): consolidate the two historical
                // launch paths (ComputerUse host vs. raw shell `open`/`start`)
                // into one flow: prefer the host (it knows about
                // accessibility / focus-after-launch), fall back to the
                // platform shell, and *always* return the same envelope so
                // callers don't have to special-case the two paths.
                let mut host_attempted = false;
                let mut host_error: Option<String> = None;
                let method = "shell";

                // Only macOS has a working ComputerUseHost.open_app pathway today
                // (Accessibility-driven). On Windows / Linux the host either
                // doesn't exist or returns a NotImplemented stub, so we save a
                // round-trip by going straight to the platform shell. On macOS
                // we still prefer the host because it knows about
                // focus-after-launch and AX permission state.
                let prefer_host = cfg!(target_os = "macos") && context.computer_use_host.is_some();
                if prefer_host {
                    host_attempted = true;
                    let cu_input = json!({ "action": "open_app", "app_name": app_name });
                    match self.handle_desktop("open_app", &cu_input, context).await {
                        Ok(results) => {
                            // Re-wrap to the unified system-domain envelope so
                            // models see the same shape regardless of which
                            // backend serviced the call.
                            let host_payload = results
                                .first()
                                .map(|r| r.content())
                                .unwrap_or(Value::Null);
                            return Ok(vec![ToolResult::ok(
                                json!({
                                    "launched": true,
                                    "app": app_name,
                                    "method": "computer_use_host",
                                    "host_payload": host_payload,
                                }),
                                Some(format!("Opened {} via host", app_name)),
                            )]);
                        }
                        Err(e) => {
                            // Don't fail yet — try the shell fallback. Many
                            // hosts return error for sandboxed apps that
                            // launch fine via `open -a`.
                            host_error = Some(e.to_string());
                        }
                    }
                }

                let provider = LocalSystemProvider::new();
                let outcome = provider.open_app_shell(app_name).map_err(|e| {
                    OpenBitFunError::tool(format!("{} (host_error: {:?})", e.message(), host_error))
                })?;
                let warning = host_error.map(|e| {
                    format!("computer_use_host open_app failed; shell fallback succeeded: {}", e)
                });
                Ok(vec![ToolResult::ok(
                    json!({
                        "launched": true,
                        "app": app_name,
                        "method": method,
                        "via_command": outcome.via_command,
                        "host_attempted": host_attempted,
                        "warning": warning,
                    }),
                    Some(format!("Opened {} via {}", app_name, outcome.via_command)),
                )])
            }
            "run_script" => {
                let script = params
                    .get("script")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| OpenBitFunError::tool("run_script requires 'script'".to_string()))?;
                let script_type = params
                    .get("script_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("applescript");
                // Optional caller-provided runtime bound. Omit or set to 0 to wait
                // for script completion without an internal cap.
                let timeout_ms = params
                    .get("timeout_ms")
                    .and_then(|v| v.as_u64())
                    .filter(|value| *value > 0);
                let max_output_bytes = params.get("max_output_bytes").and_then(|v| v.as_u64());
                let provider = LocalSystemProvider::new();
                let output = match provider
                    .run_script(RunScriptRequest {
                        script,
                        script_type,
                        timeout_ms,
                        max_output_bytes,
                    })
                    .await
                {
                    Ok(output) => output,
                    Err(error) => return map_run_script_error(error),
                };

                if output.success {
                    Ok(vec![ToolResult::ok(
                        json!({
                            "success": true,
                            "output": output.stdout,
                            "stderr": output.stderr,
                            "stdout_truncated": output.stdout_truncated,
                            "stderr_truncated": output.stderr_truncated,
                            "exit_code": output.exit_code,
                            "elapsed_ms": output.elapsed_ms,
                            "script_type": script_type,
                        }),
                        Some(if output.stdout.is_empty() {
                            format!("Script executed in {} ms", output.elapsed_ms)
                        } else {
                            output.stdout.lines().take(1).collect::<String>()
                        }),
                    )])
                } else {
                    Ok(err_response(
                        "system",
                        "run_script",
                        ControlHubError::new(
                            ErrorCode::Internal,
                            format!(
                                "Script exited with {:?}: {}",
                                output.exit_code,
                                output.stderr.lines().next().unwrap_or("(no stderr)")
                            ),
                        )
                        .with_hints([
                            format!("stderr={}", output.stderr),
                            format!("elapsed_ms={}", output.elapsed_ms),
                        ]),
                    ))
                }
            }
            "get_os_info" => {
                let local = LocalSystemProvider::new().system_info();
                let mut info = json!({
                    "os": local.os,
                    "arch": local.arch,
                    "rust_target_family": local.rust_target_family,
                });
                if let Some(v) = local.os_version {
                    info["os_version"] = json!(v);
                }
                if let Some(host) = local.hostname {
                    info["hostname"] = json!(host);
                }
                if let Some(s) = local.display_server {
                    info["display_server"] = json!(s);
                }
                if let Some(d) = local.desktop_environment {
                    info["desktop_environment"] = json!(d);
                }
                info["script_types"] = json!(local.script_types);
                Ok(vec![ToolResult::ok(
                    info.clone(),
                    Some(format!(
                        "{} {} ({})",
                        local.os,
                        info.get("os_version").and_then(|v| v.as_str()).unwrap_or(""),
                        local.arch
                    )),
                )])
            }
            // Cross-context primitive: read the system clipboard. Used by
            // models to pick up "what the user just copied" (verification
            // codes, selected text, generated SQL, etc.) without driving
            // the GUI. Returns text only — binary clipboard payloads are
            // out of scope.
            "clipboard_get" => {
                let max_bytes = clipboard_output_limit(params)?;

                match LocalSystemProvider::new().clipboard_read_text().await {
                    Ok(text) => {
                        let len = text.len();
                        Ok(vec![ToolResult::ok(
                            clipboard_text_result(&text, max_bytes),
                            Some(format!("{} bytes on clipboard", len)),
                        )])
                    }
                    Err(e) => Ok(local_system_error_response("system", "clipboard_get", e)),
                }
            }

            // Cross-context primitive: place text on the system clipboard.
            // The user can then paste it into ANY app with cmd+v / ctrl+v —
            // dramatically simpler than driving each target GUI by hand.
            "clipboard_set" => {
                let text = params.get("text").and_then(|v| v.as_str()).ok_or_else(|| {
                    OpenBitFunError::tool("clipboard_set requires 'text'".to_string())
                })?;
                match LocalSystemProvider::new().clipboard_write_text(text).await {
                    Ok(()) => Ok(vec![ToolResult::ok(
                        json!({
                            "success": true,
                            "byte_length": text.len(),
                        }),
                        Some(format!("Wrote {} bytes to clipboard", text.len())),
                    )]),
                    Err(e) => Ok(local_system_error_response("system", "clipboard_set", e)),
                }
            }

            // Cross-context primitive: open a URL in the user's default
            // browser WITHOUT going through CDP. Use this when the goal is
            // "show this URL to the user" rather than "drive this page".
            // Avoids the CDP launch round-trip and works even when the
            // browser was started without --remote-debugging-port.
            "open_url" => {
                let url = params
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| OpenBitFunError::tool("open_url requires 'url'".to_string()))?;
                match LocalSystemProvider::new().open_url(url) {
                    Ok(outcome) => Ok(vec![ToolResult::ok(
                        json!({
                            "opened": true,
                            "url": url,
                            "method": outcome.method,
                            "note": OPEN_URL_ROUTING_NOTE,
                        }),
                        Some(format!(
                            "Opened {} in default handler. {}",
                            url, OPEN_URL_ROUTING_NOTE
                        )),
                    )]),
                    Err(e) => Ok(local_system_error_response("system", "open_url", e)),
                }
            }

            // Cross-context primitive: open a local file with its default
            // handler (or an explicitly named app on macOS). High-frequency
            // for "open this PDF / picture / spreadsheet for me".
            "open_file" => {
                let path_str = params.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
                    OpenBitFunError::tool("open_file requires 'path'".to_string())
                })?;
                let app_name = params.get("app").and_then(|v| v.as_str());

                match LocalSystemProvider::new().open_file(path_str, app_name) {
                    Ok(outcome) => Ok(vec![ToolResult::ok(
                        json!({
                            "opened": true,
                            "path": path_str,
                            "with_app": app_name,
                            "method": outcome.method,
                            "note": OPEN_FILE_ROUTING_NOTE,
                        }),
                        Some(format!(
                            "{}. {}",
                            match app_name {
                                Some(a) => format!("Opened {} with {}", path_str, a),
                                None => format!("Opened {} with default handler", path_str),
                            },
                            OPEN_FILE_ROUTING_NOTE
                        )),
                    )]),
                    Err(e) => Ok(local_system_error_response("system", "open_file", e)),
                }
            }

            other => Err(OpenBitFunError::tool(format!(
                "Unknown system action: '{}'. Valid: open_app, run_script, get_os_info, open_url, open_file, clipboard_get, clipboard_set",
                other
            ))),
        }
    }
}
fn local_system_error_response(
    domain: &'static str,
    action: &'static str,
    error: LocalSystemActionError,
) -> Vec<ToolResult> {
    let mut control_error =
        ControlHubError::new(error_code_from_local(error.stable_code()), error.message());
    if !error.hints().is_empty() {
        control_error = control_error.with_hints(error.hints().to_vec());
    }
    err_response(domain, action, control_error)
}

fn map_run_script_error(error: LocalSystemActionError) -> OpenBitFunResult<Vec<ToolResult>> {
    match error.stable_code() {
        "NOT_AVAILABLE" | "TIMEOUT" => {
            Ok(local_system_error_response("system", "run_script", error))
        }
        _ => Err(OpenBitFunError::tool(error.message().to_string())),
    }
}

fn error_code_from_local(code: &str) -> ErrorCode {
    match code {
        "INVALID_PARAMS" => ErrorCode::InvalidParams,
        "NOT_AVAILABLE" => ErrorCode::NotAvailable,
        "NOT_FOUND" => ErrorCode::NotFound,
        "TIMEOUT" => ErrorCode::Timeout,
        _ => ErrorCode::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::{ComputerUseActions, OpenBitFunError, ToolResult};
    use super::{OPEN_FILE_ROUTING_NOTE, OPEN_URL_ROUTING_NOTE};
    use serde_json::json;

    use crate::agentic::tools::computer_use_host as h;
    use crate::util::errors::OpenBitFunResult;
    use std::sync::{Arc, Mutex};

    #[test]
    fn clipboard_read_limit_honors_schema_and_legacy_payloads() {
        assert_eq!(
            super::clipboard_output_limit(&json!({})).unwrap(),
            64 * 1024
        );
        assert_eq!(
            super::clipboard_output_limit(&json!({"max_bytes": 7})).unwrap(),
            7
        );
        assert_eq!(
            super::clipboard_output_limit(&json!({"max_output_bytes": 9, "max_bytes": 7})).unwrap(),
            9
        );
        assert_eq!(
            super::clipboard_output_limit(&json!({"max_output_bytes": u64::MAX})).unwrap(),
            1024 * 1024
        );
        for value in [json!(0), json!(-1), json!("9"), json!(null), json!(1.5)] {
            assert!(super::clipboard_output_limit(&json!({"max_output_bytes": value})).is_err());
        }
    }

    #[test]
    fn clipboard_read_truncates_at_utf8_boundaries_without_adding_text() {
        let text = "a中文🦀\r\n";
        assert_eq!(
            super::clipboard_text_result(text, 5),
            json!({"text":"a中", "byte_length":13, "truncated":true})
        );
        assert_eq!(
            super::clipboard_text_result(text, 13),
            json!({"text":text, "byte_length":13, "truncated":false})
        );
        assert_eq!(
            super::clipboard_text_result("", 1),
            json!({"text":"", "byte_length":0, "truncated":false})
        );
    }

    #[derive(Debug, Default)]
    struct CachedTargetHost {
        calls: Mutex<Vec<String>>,
        fail_input: bool,
        fail_observation: bool,
        stopped: bool,
    }

    fn unchanged_snapshot() -> h::AppStateSnapshot {
        serde_json::from_value(json!({
            "app": {"name":"Fixture","pid":73,"running":true},
            "window_title":"Fixture", "tree_text":"window chrome", "digest":"observed-digest", "captured_at_ms":1
        })).unwrap()
    }

    #[async_trait::async_trait]
    impl h::ComputerUseHost for CachedTargetHost {
        fn control_snapshot(&self) -> h::ControlSnapshot {
            let mut snapshot = h::ControlSnapshot::default();
            if self.stopped && !self.calls.lock().unwrap().is_empty() {
                snapshot.supported = true;
                snapshot.state = "stopped".into();
            }
            snapshot
        }
        async fn permission_snapshot(&self) -> OpenBitFunResult<h::ComputerUsePermissionSnapshot> {
            panic!("unexpected permission request")
        }
        async fn request_accessibility_permission(&self) -> OpenBitFunResult<()> {
            panic!("unexpected permission request")
        }
        async fn request_screen_capture_permission(&self) -> OpenBitFunResult<()> {
            panic!("unexpected permission request")
        }
        async fn screenshot_display(
            &self,
            _: h::ComputerUseScreenshotParams,
        ) -> OpenBitFunResult<h::ComputerScreenshot> {
            panic!("unexpected capture")
        }
        fn map_image_coords_to_pointer(&self, _: i32, _: i32) -> OpenBitFunResult<(i32, i32)> {
            panic!("unexpected coordinate conversion")
        }
        fn map_normalized_coords_to_pointer(&self, _: i32, _: i32) -> OpenBitFunResult<(i32, i32)> {
            panic!("unexpected coordinate conversion")
        }
        async fn mouse_move(&self, _: i32, _: i32) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn pointer_move_relative(&self, _: i32, _: i32) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn mouse_click(&self, _: &str) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn scroll(&self, _: i32, _: i32) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn key_chord(&self, _: Vec<String>) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn type_text(&self, _: &str) -> OpenBitFunResult<()> {
            panic!("unexpected global input")
        }
        async fn wait_ms(&self, _: u64) -> OpenBitFunResult<()> {
            panic!("unexpected wait")
        }
        async fn list_apps(&self, _: bool) -> OpenBitFunResult<Vec<h::AppInfo>> {
            Ok(serde_json::from_value(json!([
                {"name":"Fixture","pid":73,"bundle_id":"example.fixture","running":true},
                {"name":"Google Chrome","pid":74,"bundle_id":"com.google.Chrome","running":true}
            ]))
            .unwrap())
        }
        async fn computer_use_session_snapshot(&self) -> h::ComputerUseSessionSnapshot {
            h::ComputerUseSessionSnapshot {
                foreground_application: Some(foreground("Google Chrome", "com.google.Chrome")),
                pointer_global: None,
            }
        }
        async fn get_app_state(
            &self,
            _: h::AppSelector,
            _: u32,
            _: bool,
        ) -> OpenBitFunResult<h::AppStateSnapshot> {
            assert!(
                self.calls
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|event| event.starts_with("input:")),
                "observation must follow input and never rebuild a target before it is consumed"
            );
            self.calls
                .lock()
                .unwrap()
                .push("recover observation".into());
            if self.fail_observation {
                return Err(OpenBitFunError::tool("FIXTURE_OBSERVATION_FAILED"));
            }
            let mut snapshot = unchanged_snapshot();
            snapshot.screenshot = Some(serde_json::from_value(json!({
                "bytes":[137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 10, 8, 6, 0, 0, 0, 180, 85, 126, 230, 0, 0, 0, 23, 73, 68, 65, 84, 120, 156, 99, 48, 78, 155, 249, 159, 154, 152, 97, 212, 192, 81, 3, 135, 163, 129, 0, 136, 162, 182, 88, 58, 123, 198, 249, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], "mime_type":"image/png", "screenshot_id":"recovered-frame",
                "image_width":20,"image_height":10,"native_width":20,"native_height":10,
                "display_origin_x":0,"display_origin_y":0,"vision_scale":1.0
            })).unwrap());
            Ok(snapshot)
        }
        async fn dispatch_app_input(
            &self,
            app: h::AppSelector,
            action: h::AppInputAction,
        ) -> OpenBitFunResult<()> {
            assert_eq!(app.pid, Some(73));
            match &action {
                h::AppInputAction::Click { target, .. } => {
                    assert!(matches!(target, h::ClickTarget::NodeIdx { idx: 17 }))
                }
                h::AppInputAction::TypeText { text, focus } => {
                    assert_eq!(text, "fixture text");
                    assert!(matches!(focus, Some(h::ClickTarget::NodeIdx { idx: 17 })));
                }
                _ => {}
            }
            self.calls
                .lock()
                .unwrap()
                .push(format!("input:{}", action.name()));
            if self.fail_input {
                return Err(OpenBitFunError::tool("FIXTURE_POST_INPUT_FAILED"));
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn failed_app_input_preserves_receipt_and_recovers_pixels_without_replaying() {
        for action in ["app_click", "app_type_text", "app_scroll", "app_key_chord"] {
            for (fail_observation, stopped) in [(false, false), (true, false), (false, true)] {
                let recorded = Arc::new(CachedTargetHost {
                    fail_input: true,
                    fail_observation,
                    stopped,
                    ..Default::default()
                });
                let host: h::ComputerUseHostRef = recorded.clone();
                let result = ComputerUseActions::new().handle_desktop_ax(&host, action,
                    &json!({"app":{"pid":73},"target":{"node_idx":17},"focus":{"node_idx":17},"text":"fixture text","keys":["return"],"dy":80}), true, None).await.unwrap();
                let data = result[0].content();
                assert_eq!(data["action_status"], "failed");
                assert_eq!(data["input_may_have_been_submitted"], true);
                assert!(data["error"]
                    .as_str()
                    .unwrap()
                    .contains("FIXTURE_POST_INPUT_FAILED"));
                assert!(data.get("success").is_none());
                let calls = recorded.calls.lock().unwrap();
                assert_eq!(calls.len(), if stopped { 1 } else { 2 });
                if !stopped {
                    assert_eq!(calls[1], "recover observation");
                }
                let ToolResult::Result {
                    image_attachments, ..
                } = &result[0]
                else {
                    panic!("result")
                };
                if fail_observation || stopped {
                    assert!(data["app_state"].is_null());
                    assert!(data["observation_error"].is_string());
                    assert!(image_attachments.is_none());
                } else {
                    assert_eq!(
                        data["app_state"]["screenshot_meta"]["screenshot_id"],
                        "recovered-frame"
                    );
                    assert_eq!(data["app_state"]["screenshot_meta"]["image_width"], 20);
                    assert_eq!(image_attachments.as_ref().unwrap()[0].data_base64, "iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGMwTpv5n5qYYdTAUQOHo4EAiKK2WDp7xvkAAAAASUVORK5CYII=");
                    assert!(data["observation_error"].is_null());
                }
            }
        }
    }

    #[tokio::test]
    async fn dispatcher_preserves_cached_targets_and_does_not_infer_failure_from_unchanged_ax() {
        let recorded = Arc::new(CachedTargetHost::default());
        let host: h::ComputerUseHostRef = recorded.clone();
        let dispatcher = ComputerUseActions::new();
        for action in ["app_click", "app_type_text"] {
            for supplied in [
                json!(null),
                json!({"app_state_digest":"caller-observation"}),
                json!({"before_digest":"legacy-observation"}),
            ] {
                let mut params = json!({"app":{"pid":73}, "target":{"node_idx":17}, "focus":{"node_idx":17}, "text":"fixture text"});
                if let Some(fields) = supplied.as_object() {
                    params.as_object_mut().unwrap().extend(fields.clone());
                }
                // Repeated identical AX digests are legitimate for custom-rendered apps.
                for _ in 0..3 {
                    let result = dispatcher
                        .handle_desktop_ax(&host, action, &params, true, None)
                        .await
                        .unwrap();
                    let data = result[0].content();
                    let expected = params
                        .get("app_state_digest")
                        .or_else(|| params.get("before_digest"))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    assert_eq!(data["before_digest"], expected);
                    assert_eq!(data["app_state"]["digest"], "observed-digest");
                    assert_eq!(data["action_status"], "submitted");
                    assert!(data["loop_warning"].is_null());
                }
            }
        }
        let calls = recorded.calls.lock().unwrap();
        assert_eq!(calls.len(), 36);
        for pair in calls.chunks_exact(2) {
            assert!(pair[0].starts_with("input:"));
            assert_eq!(pair[1], "recover observation");
        }
    }

    #[tokio::test]
    async fn single_input_rejects_malformed_arguments_before_any_native_work() {
        let recorded = Arc::new(CachedTargetHost::default());
        let host: h::ComputerUseHostRef = recorded.clone();
        for (action, params) in [
            (
                "app_click",
                json!({"app":{"pid":73},"target":{"node_idx":17},"click_count":4294967296u64}),
            ),
            (
                "app_key_chord",
                json!({"app":{"pid":73},"keys":["return",42]}),
            ),
            ("app_scroll", json!({"app":{"pid":73},"dy":2147483648u64})),
            ("app_type_text", json!({"app":{"pid":73},"text":42})),
        ] {
            assert!(
                ComputerUseActions::new()
                    .handle_desktop_ax(&host, action, &params, true, None)
                    .await
                    .is_err(),
                "{action}"
            );
        }
        assert!(recorded.calls.lock().unwrap().is_empty());
    }

    fn foreground(name: &str, bundle_id: &str) -> h::ComputerUseForegroundApplication {
        h::ComputerUseForegroundApplication {
            name: Some(name.to_string()),
            bundle_id: Some(bundle_id.to_string()),
            process_name: None,
            process_id: Some(1),
        }
    }

    #[test]
    fn open_url_routing_note_points_at_browser_domain() {
        assert!(OPEN_URL_ROUTING_NOTE.contains("no observation"));
        assert!(OPEN_URL_ROUTING_NOTE.contains("ComputerUse"));
        assert!(OPEN_URL_ROUTING_NOTE.contains("ControlHub domain=\"browser\""));
        assert!(OPEN_URL_ROUTING_NOTE.contains("browser.connect"));
        assert!(OPEN_URL_ROUTING_NOTE.contains("snapshot"));
    }

    /// `open_file` opens an external app window; follow-up interaction goes
    /// through ComputerUse desktop actions (screenshot first), NOT the
    /// browser domain.
    #[test]
    fn open_file_routing_note_points_at_desktop_actions() {
        assert!(OPEN_FILE_ROUTING_NOTE.contains("external application window"));
        assert!(OPEN_FILE_ROUTING_NOTE.contains("ComputerUse desktop"));
        assert!(OPEN_FILE_ROUTING_NOTE.contains("screenshot"));
        assert!(!OPEN_FILE_ROUTING_NOTE.contains("browser"));
    }
}
