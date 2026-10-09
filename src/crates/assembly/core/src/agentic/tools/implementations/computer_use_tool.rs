//! Desktop automation (Computer use).

use super::computer_use_locate::execute_computer_use_locate;
use super::control_hub::{coded_tool_error, ErrorCode};
use crate::agentic::tools::computer_use_capability::computer_use_desktop_available;
use crate::agentic::tools::computer_use_host::{
    AppSelector, ComputerScreenshot, ComputerUseHost, OcrRegionNative, UiElementLocateQuery,
};
use crate::agentic::tools::computer_use_optimizer::hash_screenshot_bytes;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolResult, ToolUseContext,
};
use crate::service::config::global::GlobalConfigManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::ToolImageAttachment;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use log::{debug, warn};
use openbitfun_agent_tools::computer_use::{
    coordinate_mode, ensure_pointer_move_uses_screen_coordinates_only, use_screen_coordinates,
};
use openbitfun_core_types::product_identity::hidden_data_directory;
use serde_json::{json, Value};

fn computer_use_permission_resource(input: &Value) -> String {
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    if action == "start_control" {
        return format!(
            "start_control:mode={}",
            input
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("background")
        );
    }
    let target = [
        "app_name",
        "url",
        "path",
        "title_contains",
        "identifier_contains",
    ]
    .into_iter()
    .find_map(|field| {
        input
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("{field}={value}"))
    });

    target.map_or_else(|| action.to_string(), |target| format!("{action}:{target}"))
}

/// Merges [`ComputerUseHost::computer_use_session_snapshot`] + optional `input_coordinates` into tool JSON.
/// Also records the action for loop detection and adds loop warnings if detected.
pub(crate) async fn computer_use_augment_result_json(
    host: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
    mut body: Value,
    input_coordinates: Option<Value>,
) -> Value {
    let snap = host.computer_use_session_snapshot().await;
    let interaction = host.computer_use_interaction_state();
    let control = host.control_snapshot();

    // Record action for loop detection
    let action_type = body
        .get("action")
        .or_else(|| body.get("tool"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let action_params = input_coordinates
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let success = body
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    host.record_action(&action_type, &action_params, success);

    // Check for action loops
    let loop_result = host.detect_action_loop();

    if let Value::Object(map) = &mut body {
        map.insert(
            "computer_use_context".to_string(),
            json!({
                "foreground_application": snap.foreground_application,
                "pointer_global": snap.pointer_global,
                "input_coordinates": input_coordinates,
                "capture_scope": host.capture_scope(),
                "capture_target": control.target,
                "control_supported": control.supported,
                "control_mode": control.supported.then_some(control.mode),
                "virtual_pointer": control.pointer,
                "pointer_note": "pointer_global belongs to the human desktop; virtual_pointer belongs to the controlled surface. Neither changes the selected target.",
            }),
        );
        map.insert("interaction_state".to_string(), json!(interaction));

        // Loop hint surfaced to the model as a warning only — it never forces the
        // agent loop to stop. The model decides on its own whether to switch tactic.
        if loop_result.is_loop {
            map.insert(
                "loop_warning".to_string(),
                json!({
                    "detected": true,
                    "pattern_length": loop_result.pattern_length,
                    "repetitions": loop_result.repetitions,
                    "suggestion": loop_result.suggestion,
                }),
            );
        }
    }
    body
}

/// Optional on-disk copy of the exact authorized capture for debugging.
/// Opt-in: only written when [`COMPUTER_USE_DEBUG_SCREENSHOTS_ENV`] is set to `1`;
/// the directory is pruned to the newest [`COMPUTER_USE_DEBUG_MAX_FILES`] files after each write.
/// Filenames: `cu_<ms>_full.jpg` (whole display) or `cu_<ms>_crop_<x>_<y>.jpg` when a point crop was requested.
const COMPUTER_USE_DEBUG_DIRECTORY_NAME: &str = "computer_use_debug";
/// Set to `1` to enable on-disk debug copies of Computer use screenshots.
const COMPUTER_USE_DEBUG_SCREENSHOTS_ENV: &str = "OPENBITFUN_COMPUTER_USE_DEBUG_SCREENSHOTS";
/// Newest debug screenshots retained in the product debug directory; older files are deleted.
const COMPUTER_USE_DEBUG_MAX_FILES: usize = 20;

fn computer_use_debug_subdir() -> String {
    format!(
        "{}/{}",
        hidden_data_directory(),
        COMPUTER_USE_DEBUG_DIRECTORY_NAME
    )
}

/// AX depth `describe_screen` walks into the focused window.
///
/// This was 8, which is fine for a native Cocoa app but far too shallow for
/// Electron / WebView clients — the ones agents are most often asked to drive.
/// Measured against a real Electron window (focused window only):
///
/// | depth | nodes | actionable | tree_text |
/// |------:|------:|-----------:|----------:|
/// |     8 |    17 |          7 |      1 KB |
/// |    12 |    25 |         15 |      2 KB |
/// |    16 |    50 |         40 |      5 KB |
/// |    20 |   207 |        197 |     27 KB |
/// |    24 |   233 |        223 |     31 KB |
/// |    32 |  1289 |       1279 |    206 KB |
///
/// At 8 the agent could see seven actionable elements in an entire app — not
/// enough to find a search field or a send button, which reads as "this app has
/// no AX tree" and pushes it onto OCR or screenshot guessing. The actionable
/// layer appears around 20; past that the payload grows far faster than the
/// number of things worth clicking.
const DESCRIBE_SCREEN_AX_DEPTH: u32 = 20;

/// Byte ceiling on the AX tree `describe_screen` returns.
///
/// The depth above is tuned against a typical rich window (~27 KB), but depth
/// is a poor proxy for size: a document, a long list or a deeply nested canvas
/// can multiply that. `describe_screen` is the action an agent calls most, so
/// it needs a bound that does not depend on the app behaving reasonably.
const DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES: usize = 60_000;

/// Byte ceiling on the AX tree carried by `get_app_state` and every `app_*`
/// action result.
///
/// Higher than the `describe_screen` cap because these are explicit requests
/// for an app's tree rather than a routine observation — but still a ceiling.
/// Measured unbounded output on a real Electron app was 390 KB from a single
/// `get_app_state`, roughly 100k tokens, which is most of a context window
/// spent on one look at one app.
pub(crate) const APP_STATE_TREE_TEXT_MAX_BYTES: usize = 120_000;

/// A routine observation must never be allowed a bigger tree than an explicit
/// query for one. Checked at compile time so reordering the two constants is a
/// build error rather than something a test has to notice.
const _: () = assert!(DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES < APP_STATE_TREE_TEXT_MAX_BYTES);

/// Trim an AX tree to `max_bytes` on a line boundary, appending a note that
/// says what was dropped and how to get it.
///
/// Silent truncation would be worse than the problem it solves: the agent would
/// read a partial tree as the whole UI and conclude a control does not exist.
pub(crate) fn clip_tree_text(text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    // Walk back to a char boundary before slicing. The cap is a byte count, and
    // slicing a `str` at a byte index inside a multi-byte character panics —
    // which CJK app trees (the ones most likely to be large) would hit
    // constantly.
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    // A newline is single-byte, so its index is always a valid boundary too.
    let cut = text[..end].rfind('\n').unwrap_or(end);
    let kept_lines = text[..cut].lines().count();
    let total_lines = text.lines().count();
    format!(
        "{}\n[truncated] showing the first {} of {} AX nodes ({} of {} bytes). \
This is a size limit, not the end of the UI — a control you cannot find here may still exist. \
Narrow the view with `get_app_state` (`focus_window_only`, a smaller `max_depth`) or target it \
directly with `locate` / `move_to_text`.\n",
        &text[..cut],
        kept_lines,
        total_lines,
        cut,
        text.len(),
    )
}

pub struct ComputerUseTool;

impl Default for ComputerUseTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerUseTool {
    pub fn new() -> Self {
        Self
    }

    /// Tool description when the primary model is **text-only** (no `screenshot` / JPEG workflow).
    fn description_text_only() -> String {
        let os = Self::host_os_label();
        let keys = Self::key_chord_os_hint();
        format!(
            "Desktop application control on {}. {} \
The primary model cannot consume image attachments: use describe_screen and get_app_state to read accessibility and OCR observations; do not call screenshot or infer pixels from unseen images. \
Start with start_control mode=background, identify the application with list_apps, then use its app selector consistently. Keep the session active across observations and actions; stop_control when finished. \
An empty app selector follows the bound target, or the current app when no target is bound yet. control_status reports the owner, mode and target. Its capabilities describe backend routes, not support for every control or arbitrary background pointer input. A system stop requires an explicit new start. \
For GUI tasks use ComputerUse's observation and app-scoped input interfaces. Do not replace failed observations with ad hoc AppleScript, capture or OCR programs in ExecCommand. \
Read the complete returned data, including application identities, tree_text, node indices, OCR text, target geometry, limitations and errors. \
Prefer app_batch for already-decided app_click/app_type_text/app_scroll/app_key_chord steps using observed node_idx or ocr_text targets; it returns one final observation. Stop before choosing a target that depends on new information, and never replay completed receipts after a partial failure. Consult get_app_shortcuts when a shortcut is unknown. When the accessibility tree is sparse, use returned OCR facts with an app-scoped ocr_text target. \
Global click, key_chord, type_text, mouse_move and paste require foreground mode. Use that mode only when the user explicitly requests taking over the visible desktop; do not activate an app or change modes to repair an observation error. \
Observe, act once, and verify the intended change in the next observation. Event submission or a changed digest alone does not prove task success, and an unchanged digest is not a reason to repeat a mutation. \
Before sending a message or another irreversible action, verify the intended target and content from the current observation, then verify the result. \
If neither accessibility nor built-in OCR exposes the required content, report that specific limitation instead of guessing coordinates or claiming success. Prefer ControlHub's browser interface for web content; ComputerUse can operate native browser chrome and dialogs.",
            os, keys
        )
    }

    /// Whether `action` is implemented by the shared `ComputerUseActions::handle_desktop`
    /// dispatcher instead of inline in [`Self::call_impl`]. These actions used to live on
    /// the (now-removed) `ControlHub` desktop domain before it was folded into `ComputerUse`.
    fn routes_to_desktop_action_dispatcher(action: &str) -> bool {
        matches!(
            action,
            "list_displays"
                | "focus_display"
                | "paste"
                | "list_apps"
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
                | "visual_click"
        )
    }

    /// Property definitions that are byte-identical between the full
    /// (`input_schema`) and text-only (`input_schema_text_only`) variants.
    /// Kept in one place so fields that are NOT model-capability-specific
    /// cannot silently drift between the two hand-authored schemas.
    ///
    /// Fields that differ by design (richer guidance for the multimodal
    /// model, or `screenshot`-only fields) stay inline in each schema.
    /// Tagged unions mirror the serde host contracts. Keep each variant's
    /// fields and example together so model hints cannot drift to guessed keys.
    fn tagged_action_variant(
        kind: &str,
        properties: Value,
        required: &[&str],
        example: Value,
    ) -> Value {
        let mut fields = properties.as_object().unwrap().clone();
        fields.insert("kind".into(), json!({"type":"string","enum":[kind]}));
        let mut required_fields = vec!["kind"];
        required_fields.extend_from_slice(required);
        json!({"type":"object","properties":fields,"required":required_fields,
            "additionalProperties":false,"examples":[example]})
    }

    fn app_program_schema() -> Value {
        let target = Self::app_target_schema(false);
        let mut variants = Vec::new();
        for (name, fields, required) in [
            (
                "app_click",
                json!({"target":target,"wait_ms_after":{"type":"integer","minimum":0,"description":"Optional explicit post-click settle time; omitted means no fixed delay."},"click_count":{"type":"integer","minimum":1,"maximum":3},"mouse_button":{"type":"string","enum":["left","right","middle"]},"modifier_keys":{"type":"array","items":{"type":"string"}}}),
                vec!["target"],
            ),
            (
                "app_type_text",
                json!({"text":{"type":"string"},"focus":Self::app_target_schema(true)}),
                vec!["text"],
            ),
            (
                "app_key_chord",
                json!({"keys":{"type":"array","minItems":1,"items":{"type":"string"}},"focus_idx":{"type":"integer","minimum":0}}),
                vec!["keys"],
            ),
            (
                "app_scroll",
                json!({"dx":{"type":"integer"},"dy":{"type":"integer"},"focus":Self::app_target_schema(true)}),
                vec![],
            ),
            (
                "app_drag",
                json!({"from":Self::image_endpoint_schema(),"to":Self::image_endpoint_schema(),"duration_ms":{"type":"integer","minimum":1},"mouse_button":{"type":"string","enum":["left","right","middle"]}}),
                vec!["from", "to"],
            ),
            (
                "wait",
                json!({"ms":{"type":"integer","minimum":0}}),
                vec!["ms"],
            ),
        ] {
            let mut fields = fields.as_object().unwrap().clone();
            fields.insert("action".into(), json!({"type":"string","enum":[name]}));
            let mut required = required;
            required.push("action");
            variants.push(json!({"type":"object","properties":fields,"required":required,"additionalProperties":false}));
        }
        json!({"type":"array","minItems":1,"items":{"oneOf":variants},"description":"Ordered app-scoped inputs, executed in one call with one final observation. Batch already-known actions (for example click/type/key/scroll). End the batch before choosing a target that depends on an unseen result. Stops on first failure and returns partial receipts; never replay completed steps."})
    }

    fn image_endpoint_schema() -> Value {
        Self::tagged_action_variant(
            "image_xy",
            json!({"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"screenshot_id":{"type":"string","minLength":1}}),
            &["x", "y", "screenshot_id"],
            json!({"kind":"image_xy","x":120,"y":80,"screenshot_id":"capture-1"}),
        )
    }

    fn app_target_schema(nullable: bool) -> Value {
        let mut variants = vec![
            Self::tagged_action_variant(
                "node_idx",
                json!({"idx":{"type":"integer","minimum":0}}),
                &["idx"],
                json!({"kind":"node_idx","idx":3}),
            ),
            Self::tagged_action_variant(
                "ocr_text",
                json!({"needle":{"type":"string","minLength":1}}),
                &["needle"],
                json!({"kind":"ocr_text","needle":"Search"}),
            ),
            Self::tagged_action_variant(
                "image_xy",
                json!({
                    "x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},
                    "screenshot_id":{"type":"string","minLength":1}
                }),
                &["x", "y", "screenshot_id"],
                json!({"kind":"image_xy","x":120,"y":80,"screenshot_id":"capture-1"}),
            ),
            Self::tagged_action_variant(
                "screen_xy",
                json!({"x":{"type":"number"},"y":{"type":"number"}}),
                &["x", "y"],
                json!({"kind":"screen_xy","x":150.5,"y":220.0}),
            ),
            Self::tagged_action_variant(
                "image_grid",
                json!({
                    "x0":{"type":"integer","minimum":0},"y0":{"type":"integer","minimum":0},
                    "width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1},
                    "rows":{"type":"integer","minimum":1},"cols":{"type":"integer","minimum":1},
                    "row":{"type":"integer","minimum":0},"col":{"type":"integer","minimum":0},
                    "intersections":{"type":"boolean"},"screenshot_id":{"type":"string","minLength":1}
                }),
                &[
                    "x0",
                    "y0",
                    "width",
                    "height",
                    "rows",
                    "cols",
                    "row",
                    "col",
                    "screenshot_id",
                ],
                json!({"kind":"image_grid","x0":0,"y0":0,"width":300,"height":300,"rows":15,"cols":15,"row":7,"col":7,"intersections":true,"screenshot_id":"capture-1"}),
            ),
            Self::tagged_action_variant(
                "visual_grid",
                json!({
                    "rows":{"type":"integer","minimum":1},"cols":{"type":"integer","minimum":1},
                    "row":{"type":"integer","minimum":0},"col":{"type":"integer","minimum":0},
                    "intersections":{"type":"boolean"},"wait_ms_after_detection":{"type":"integer","minimum":0}
                }),
                &["rows", "cols", "row", "col"],
                json!({"kind":"visual_grid","rows":15,"cols":15,"row":7,"col":7}),
            ),
        ];
        if nullable {
            variants.push(json!({"type":"null"}));
        }
        json!({"oneOf":variants,"description": if nullable {
            "Optional focus target for app_type_text/app_scroll. Use a fresh target from the same application's observation, e.g. {\"kind\":\"node_idx\",\"idx\":3} or {\"kind\":\"ocr_text\",\"needle\":\"Search\"}. Omit/null to use the app's current focus when supported; this does not activate the application."
        } else {
            "Required for app_click. Use {\"kind\":\"node_idx\",\"idx\":3}, {\"kind\":\"ocr_text\",\"needle\":\"Search\"}, or {\"kind\":\"image_xy\",\"x\":120,\"y\":80,\"screenshot_id\":\"capture-1\"}. Node indices and screenshot_id must come from the same target application's latest observation. Image targets need a model-visible image; screen_xy uses observed global coordinates. Grid row/col are zero-based and must be less than rows/cols."
        }})
    }

    fn app_wait_predicate_schema() -> Value {
        json!({"description":"Required for app_wait_for. A condition on the selected application's observed state; a digest change alone is not proof of successful delivery.", "oneOf":[
            Self::tagged_action_variant("digest_changed", json!({"prev_digest":{"type":"string"}}), &["prev_digest"], json!({"kind":"digest_changed","prev_digest":"observed-digest"})),
            Self::tagged_action_variant("title_contains", json!({"needle":{"type":"string"}}), &["needle"], json!({"kind":"title_contains","needle":"Sent"})),
            Self::tagged_action_variant("role_enabled", json!({"role":{"type":"string"}}), &["role"], json!({"kind":"role_enabled","role":"AXButton"})),
            Self::tagged_action_variant("node_enabled", json!({"idx":{"type":"integer","minimum":0}}), &["idx"], json!({"kind":"node_enabled","idx":3}))
        ]})
    }

    fn shared_action_properties() -> Value {
        json!({
            "x": { "type": "integer", "description": "For `mouse_move` and `drag`: X in **global display** units when **`use_screen_coordinates`: true** (required). **Not** for `click`." },
            "y": { "type": "integer", "description": "For `mouse_move` and `drag`: Y in **global display** units when **`use_screen_coordinates`: true** (required). **Not** for `click`." },
            "mode": { "type": "string", "enum": ["observe", "background", "foreground"], "description": "For start_control. Use background for app tasks. Foreground is only for an explicitly requested takeover of the visible desktop, not error recovery. Keep the session until the task is done." },
            "coordinate_mode": { "type": "string", "enum": ["image", "normalized"], "description": "Ignored for `mouse_move` / `drag` — host rejects image/normalized positioning; always set **`use_screen_coordinates`: true**." },
            "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "For `click`, `click_element`, `drag`: mouse button (default left)." },
            "num_clicks": { "type": "integer", "minimum": 1, "maximum": 3, "description": "For `click`, `click_element`: 1=single (default), 2=double, 3=triple click." },
            "start_x": { "type": "integer", "description": "For `drag`: start X coordinate." },
            "start_y": { "type": "integer", "description": "For `drag`: start Y coordinate." },
            "end_x": { "type": "integer", "description": "For `drag`: end X coordinate." },
            "end_y": { "type": "integer", "description": "For `drag`: end Y coordinate." },
            "text": { "type": "string", "description": "Required for app_type_text/type_text/paste: the exact text to insert. For background tasks use app_type_text with the app selector and optional focus; do not substitute global clipboard shortcuts." },
            "ms": { "type": "integer", "description": "For `wait`: duration in milliseconds." },
            "text_query": { "type": "string", "description": "For `move_to_text`, `move_to_target`, `click_target`: visible text to OCR-match on screen (case-insensitive substring)." },
            "identifier_contains": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring on AXIdentifier." },
            "node_idx": { "type": "integer", "minimum": 0, "description": "For `locate`, `click_element`: jump straight to a node returned by the most recent `get_app_state` (field `idx`). Bypasses BFS. macOS only; other platforms return AX_IDX_NOT_SUPPORTED." },
            "app_state_digest": { "type": "string", "description": "For `locate`, `click_element`: optional `state_digest` from the same `get_app_state` call that produced `node_idx`. Stale digest yields AX_IDX_STALE so you re-snapshot." },
            "max_depth": { "type": "integer", "minimum": 1, "maximum": 200, "description": "For get_app_state: AX depth (default 32). For locate/click_element: max BFS depth (default 48), ignored with node_idx." },
            "filter_combine": { "type": "string", "enum": ["all", "any"], "description": "For `locate`, `click_element`: `all` (default, AND) or `any` (OR) for filter combination. Priority: `node_idx` > `text_contains` > `title_contains`+`role_substring`." },
            "url": { "type": "string", "description": "For `open_url`: URL to open with the system/default browser." },
            "path": { "type": "string", "description": "For `open_file`: local file path to open with its default handler." },
            "app": {"description":"Required object for get_app_state/get_app_shortcuts and app_* actions: select a running application by pid, bundle_id or name from list_apps. Example: {\"pid\":421}. A string is accepted only by open_file to choose its handler.", "anyOf":[
                {"type":"object","properties":{"pid":{"type":"integer","minimum":1},"bundle_id":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}},"minProperties":1,"additionalProperties":false},
                {"type":"string","minLength":1}
            ]},
            "script_type": { "type": "string", "enum": ["applescript", "shell", "bash", "powershell", "cmd"], "description": "For `run_script`: script interpreter/type." },
            "timeout_ms": { "type": "integer", "description": "For run_script/app_wait_for: timeout in milliseconds; app_wait_for defaults to 8000." },
            "max_output_bytes": { "type": "integer", "description": "For `run_script` / `clipboard_get`: maximum bytes to return." },
            "clear_first": { "type": "boolean", "description": "For `paste`: select all before pasting." },
            "submit": { "type": "boolean", "description": "For `paste`: press submit keys after pasting." },
            "submit_keys": { "type": "array", "items": { "type": "string" }, "description": "For `paste`: key chord to submit, default `[\"return\"]`." },
            "display_id": { "type": ["integer", "null"], "description": "For `focus_display` or display-pinned desktop actions: display id, or null to clear the pin." },
            "include_hidden": { "type": "boolean", "description": "For `list_apps`: include hidden/background apps." },
            "focus_window_only": {"type":"boolean","description":"For get_app_state: restrict the AX tree to the target application window (default true). Does not activate the application."},
            "only_visible": { "type": "boolean", "description": "For `list_apps`: list only visible apps when true." },
            "target": Self::app_target_schema(false),
            "focus": Self::app_target_schema(true),
            "predicate": Self::app_wait_predicate_schema(),
            "dx": { "type": "integer", "description": "For app_scroll/interactive_scroll: horizontal delta; defaults to 0. Specify a nonzero dx or dy for a scroll action." },
            "dy": { "type": "integer", "description": "For app_scroll/interactive_scroll: vertical delta; defaults to 0. Specify a nonzero dx or dy for a scroll action." },
            "mouse_button": { "type": "string", "enum": ["left", "right", "middle"], "description": "For app/interactive/visual click actions." },
            "click_count": { "type": "integer", "minimum": 1, "maximum": 3, "description": "For app click actions." },
            "modifier_keys": { "type": "array", "items": { "type": "string" }, "description": "For app click actions: modifier keys to hold." },
            "wait_ms_after": { "type": "integer", "description": "For app click actions: post-click wait in milliseconds." },
            "focus_idx": { "type": "integer", "minimum": 0, "description": "For `app_key_chord`: optional node index to focus first." },
            "poll_ms": { "type": "integer", "description": "For `app_wait_for`: polling interval." }
        })
    }

    /// Builds a schema's `properties` object from action-specific overrides plus
    /// the fields shared with the other model-capability variant (see
    /// [`Self::shared_action_properties`]). The two sets never overlap.
    fn merge_with_shared_properties(specific: Value) -> Value {
        let mut properties = match Self::shared_action_properties() {
            Value::Object(map) => map,
            other => unreachable!("shared_action_properties must return an object, got {other:?}"),
        };
        properties.insert("steps".into(), Self::app_program_schema());
        properties.insert("from".into(), Self::image_endpoint_schema());
        properties.insert("to".into(), Self::image_endpoint_schema());
        properties.insert("duration_ms".into(), json!({"type":"integer","minimum":1,"description":"App drag duration in milliseconds (default 400)"}));
        match specific {
            Value::Object(specific_map) => properties.extend(specific_map),
            other => unreachable!("schema-specific properties must be an object, got {other:?}"),
        }
        Value::Object(properties)
    }

    /// Keep the compatibility schema complete; publish only the current app
    /// workflow to models. This projection never changes runtime dispatch.
    fn model_input_schema(&self, vision: bool) -> Value {
        fn compact(value: &mut Value, vision: bool) {
            match value {
                Value::Object(map) => {
                    map.remove("description");
                    map.remove("examples");
                    if let Some(variants) = map.get_mut("oneOf").and_then(Value::as_array_mut) {
                        variants.retain(|variant| {
                            let kind = variant
                                .pointer("/properties/kind/enum/0")
                                .and_then(Value::as_str);
                            let action = variant
                                .pointer("/properties/action/enum/0")
                                .and_then(Value::as_str);
                            let allowed_target = match kind {
                                Some("image_xy") => vision,
                                Some("screen_xy" | "image_grid" | "visual_grid") => false,
                                _ => true,
                            };
                            allowed_target && (vision || action != Some("app_drag"))
                        });
                    }
                    for child in map.values_mut() {
                        compact(child, vision);
                    }
                }
                Value::Array(values) => {
                    for child in values {
                        compact(child, vision);
                    }
                }
                _ => {}
            }
        }
        let mut schema = self.input_schema();
        let properties = schema["properties"].as_object_mut().expect("object schema");
        properties.retain(|key, _| {
            matches!(
                key.as_str(),
                "action"
                    | "app"
                    | "mode"
                    | "include_hidden"
                    | "only_visible"
                    | "focus_window_only"
                    | "steps"
                    | "target"
                    | "focus"
                    | "text"
                    | "keys"
                    | "focus_idx"
                    | "dx"
                    | "dy"
                    | "app_name"
                    | "mouse_button"
                    | "click_count"
                    | "modifier_keys"
                    | "wait_ms_after"
                    | "from"
                    | "to"
                    | "duration_ms"
                    | "predicate"
                    | "timeout_ms"
                    | "poll_ms"
                    | "ms"
                    | "x"
                    | "y"
                    | "use_screen_coordinates"
                    | "delta_x"
                    | "delta_y"
                    | "scroll_x"
                    | "scroll_y"
                    | "button"
                    | "num_clicks"
                    | "start_x"
                    | "start_y"
                    | "end_x"
                    | "end_y"
            )
        });
        properties["app"] = properties["app"]["anyOf"][0].clone();
        let mut actions = vec![
            "start_control",
            "stop_control",
            "control_status",
            "list_apps",
            "get_app_state",
            "describe_screen",
            "get_app_shortcuts",
            "app_batch",
            "app_click",
            "app_type_text",
            "app_key_chord",
            "app_scroll",
            "app_wait_for",
            "wait",
            "get_os_info",
            "open_app",
            "click",
            "key_chord",
            "type_text",
            "scroll",
        ];
        if vision {
            actions.extend(["screenshot", "app_drag", "mouse_move", "drag"]);
        } else {
            for key in [
                "from",
                "to",
                "duration_ms",
                "x",
                "y",
                "use_screen_coordinates",
                "scroll_x",
                "scroll_y",
                "start_x",
                "start_y",
                "end_x",
                "end_y",
            ] {
                properties.remove(key);
            }
        }
        properties["action"] = json!({"type":"string", "enum":actions});
        compact(&mut schema, vision);
        let properties = schema["properties"].as_object_mut().unwrap();
        properties["app"]["description"] =
            json!("Target from list_apps. Omit to keep the bound application.");
        properties["mode"]["description"] =
            json!("Default background. Foreground only for a user-requested takeover.");
        properties["app_name"]["description"] = json!("Application name for open_app; launching may activate it and requires foreground control.");
        properties["steps"]["description"] = json!("Use app_batch when multiple inputs are already decided. One app, ordered steps, one final observation. Example assumes an observed search field where Return submits the query. Stop before selecting unseen results; batch changes neither input capability nor authorization. Never replay completed steps.");
        let observed_focus = if vision {
            json!({"kind":"image_xy","x":120,"y":80,"screenshot_id":"observed-frame"})
        } else {
            json!({"kind":"node_idx","idx":3})
        };
        properties["steps"]["examples"] = json!([[
            {"action":"app_type_text","focus":observed_focus,"text":"search query"},
            {"action":"app_key_chord","keys":["return"]}
        ]]);
        if let Some(variants) = properties["steps"]["items"]["oneOf"].as_array_mut() {
            for variant in variants {
                match variant.pointer("/properties/action/enum/0").and_then(Value::as_str) {
                    Some("app_type_text") => variant["properties"]["focus"]["description"] = json!("Focus and type in one step; no preceding click needed. Omit to keep current app focus."),
                    Some("app_key_chord") => variant["properties"]["keys"]["description"] = json!("One simultaneous chord using observed app behavior. Separate sequential chords into steps."),
                    Some("app_scroll") => variant["properties"]["focus"]["description"] = json!("Scroll location only; does not click or focus a control."),
                    _ => {}
                }
            }
        }
        properties["target"]["description"] = json!(if vision {
            "Observed image_xy pixels require their screenshot_id; node_idx and ocr_text are optional precision targets."
        } else {
            "Observed node_idx or ocr_text only; this model cannot see pixels."
        });
        properties["focus"]["description"] =
            json!("Text: focus and type together. Scroll: anchor only, never click. Omit to preserve current app focus.");
        properties["action"]["description"] = json!("Prefer app_batch/app_* for application tasks. Global click/key_chord/type_text/scroll and mouse_move/drag require explicitly authorized foreground control. click acts at the current pointer and takes no coordinates.");
        properties["delta_x"]["description"] =
            json!("Global scroll horizontal wheel delta; app_scroll uses dx instead.");
        properties["delta_y"]["description"] =
            json!("Global scroll vertical wheel delta; app_scroll uses dy instead.");
        if vision {
            properties["use_screen_coordinates"]["description"] = json!("Required true for global mouse_move/drag: x,y are observed global display coordinates, never raw screenshot pixels. drag requires start_x/start_y/end_x/end_y. app_* image_xy uses screenshot pixels and screenshot_id instead.");
            properties["x"]["description"] =
                json!("Global mouse_move X in display coordinates. drag uses start_x/start_y/end_x/end_y.");
            properties["y"]["description"] =
                json!("Global mouse_move Y in display coordinates. drag uses start_x/start_y/end_x/end_y.");
        }
        schema
    }

    /// JSON Schema without `screenshot` or screenshot-only fields.
    #[cfg(test)]
    fn input_schema_text_only() -> Value {
        let properties = Self::merge_with_shared_properties(json!({
            "action": {
                "type": "string",
                "enum": ["start_control", "stop_control", "control_status", "click_target", "move_to_target", "click_element", "move_to_text", "click", "mouse_move", "scroll", "drag", "locate", "key_chord", "type_text", "pointer_move_rel", "wait", "list_displays", "focus_display", "paste", "list_apps", "get_app_state", "get_app_shortcuts", "describe_screen", "app_batch", "app_drag", "app_click", "app_type_text", "app_scroll", "app_key_chord", "app_wait_for", "open_app", "open_url", "open_file", "clipboard_get", "clipboard_set", "run_script", "run_apple_script", "get_os_info"],
                "description": "Select a ComputerUse action. This model is text-only: observe through describe_screen/get_app_state and read returned AX/OCR facts; screenshot and image-based targeting require image support. Start background control, identify the app with list_apps, then prefer app_click/app_type_text/app_scroll/app_key_chord with that app and fresh node_idx or observed ocr_text targets. Consult get_app_shortcuts for unknown shortcuts. Keep the session active until the task is finished; control_status reports its scope and stop_control releases it. Foreground mode and global input require an explicit user request to take over the visible desktop. Never activate the target or switch modes just to fix an observation error. Do not replace missing GUI observations with ad hoc scripts in ExecCommand. Reuse the returned after-action observation; app_type_text with focus combines known targeting and exact Unicode input. Observe, act once, then verify the intended result; do not repeat a mutation merely because its digest is unchanged. Prefer ControlHub domain=\"browser\" for web content; ComputerUse supports native browser chrome and dialogs."
            },
            "use_screen_coordinates": { "type": "boolean", "description": "For `mouse_move`, `drag`: **must be true** — global display coordinates from `move_to_text`, `locate`, AX, or `pointer_global`. **Not** for `click`." },
            "delta_x": { "type": "integer", "description": "For `pointer_move_rel`: horizontal delta (negative=left); also accepted as `dx`. For `scroll`: horizontal wheel delta." },
            "delta_y": { "type": "integer", "description": "For `pointer_move_rel`: vertical delta (negative=up); also accepted as `dy`. For `scroll`: vertical wheel delta." },
            "keys": { "type": "array", "items": { "type": "string" }, "description": "For `key_chord`: keys in order — modifiers first, then the main key. Desktop host waits after pressing modifiers so shortcuts register (important on macOS with IME)." },
            "target_text": { "type": "string", "description": "For `move_to_target` / `click_target`: visible or accessible text. The resolver tries AX first, then OCR." },
            "target_match_index": { "type": "integer", "minimum": 1, "description": "For `move_to_target` / `click_target`: optional 1-based OCR match index when you want a specific candidate." },
            "move_to_text_match_index": { "type": "integer", "minimum": 1, "description": "For `move_to_text` and unified target actions: **1-based** OCR match index." },
            "ocr_region_native": {
                "type": "object",
                "description": "For `move_to_text`: optional global logical rectangle intersected with the authorized target capture. If omitted, OCR uses that capture. The rectangle does not authorize observing another window or the desktop.",
                "properties": {
                    "x0": { "type": "integer", "description": "Top-left X in global screen coordinates." },
                    "y0": { "type": "integer", "description": "Top-left Y in global screen coordinates." },
                    "width": { "type": "integer", "minimum": 1, "description": "Width in the same coordinate unit as x0/y0." },
                    "height": { "type": "integer", "minimum": 1, "description": "Height in the same coordinate unit as x0/y0." }
                }
            },
            "title_contains": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring on AXTitle ONLY. Prefer `text_contains` (also covers AXValue/AXDescription/AXHelp)." },
            "role_substring": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring on AXRole **or AXSubrole** (e.g. \"Button\", \"SearchField\")." },
            "text_contains": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring matched against ANY of AXTitle / AXValue / AXDescription / AXHelp. Prefer this when the visible text is shown via value/description (e.g. AXStaticText cards) instead of title." },
            "app_name": { "type": "string", "description": "For `open_app`: the application name to launch." },
            "script": { "type": "string", "description": "For `run_apple_script`: the AppleScript code to execute. macOS only." },
            "scroll_x": { "type": "integer", "description": "For `scroll`: optional global X coordinate to scroll at. Use with `scroll_y`." },
            "scroll_y": { "type": "integer", "description": "For `scroll`: optional global Y coordinate to scroll at. Use with `scroll_x`." }
        }));
        json!({
            "type": "object",
            "properties": properties,
            "required": ["action"],
            "additionalProperties": false
        })
    }

    /// Max OCR hits to attach as preview crops + AX (multimodal disambiguation).
    const MOVE_TO_TEXT_DISAMBIGUATION_MAX: usize = 8;
    /// Half-size in native screen pixels for each candidate preview (~400×400 logical crop).
    const MOVE_TO_TEXT_PREVIEW_HALF_NATIVE: u32 = 200;

    async fn move_to_text_disambiguation_response(
        host_ref: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
        context: &ToolUseContext,
        text_query: &str,
        ocr_region_native: Option<OcrRegionNative>,
        matches: &[ScreenOcrTextMatch],
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Self::require_multimodal_tool_output_for_screenshot(context)?;
        let take = matches.len().min(Self::MOVE_TO_TEXT_DISAMBIGUATION_MAX);
        let mut attachments: Vec<ToolImageAttachment> = Vec::with_capacity(take);
        let mut candidates: Vec<Value> = Vec::with_capacity(take);
        for (i, m) in matches.iter().take(take).enumerate() {
            let idx_1based = i + 1;
            let ax = host_ref
                .accessibility_hit_at_global_point(m.center_x, m.center_y)
                .await?;
            let jpeg = host_ref
                .ocr_preview_crop_jpeg(
                    m.center_x,
                    m.center_y,
                    Self::MOVE_TO_TEXT_PREVIEW_HALF_NATIVE,
                )
                .await?;
            attachments.push(ToolImageAttachment {
                mime_type: "image/jpeg".to_string(),
                data_base64: B64.encode(&jpeg),
            });
            candidates.push(json!({
                "match_index": idx_1based,
                "ocr_text": m.text,
                "confidence": m.confidence,
                "global_center_x": m.center_x,
                "global_center_y": m.center_y,
                "bounds_left": m.bounds_left,
                "bounds_top": m.bounds_top,
                "bounds_width": m.bounds_width,
                "bounds_height": m.bounds_height,
                "accessibility": ax,
                "preview_image_attachment_index": i,
            }));
        }
        let input_coords = json!({
            "kind": "move_to_text",
            "text_query": text_query,
            "ocr_region_native": ocr_region_native,
            "move_to_text_phase": "disambiguation",
        });
        let mut body = json!({
            "success": true,
            "action": "move_to_text",
            "move_to_text_phase": "disambiguation",
            "text_query": text_query,
            "ocr_region_native": ocr_region_native,
            "disambiguation_required": true,
            "instruction": "Several OCR hits for this substring. Each candidate has a **preview JPEG** (same order as `candidates`) and **accessibility** metadata at the OCR center. **Do not** derive `mouse_move` from JPEG pixels. Pick `match_index`, then call **`move_to_text` again** with the same `text_query`, same `ocr_region_native`, and **`move_to_text_match_index`** = that index. Pointer was not moved.",
            "candidates": candidates,
            "total_ocr_matches": matches.len(),
            "candidates_previewed": take,
        });
        if take < matches.len() {
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "truncation_note".to_string(),
                    json!(format!(
                        "Only the first {} of {} OCR matches are previewed; narrow `ocr_region_native` or `text_query` if needed.",
                        take, matches.len()
                    )),
                );
            }
        }
        let body = computer_use_augment_result_json(host_ref, body, Some(input_coords)).await;
        let hint = format!(
            "move_to_text: {} OCR matches — set move_to_text_match_index after viewing {} preview JPEGs + AX. Pointer not moved.",
            matches.len(),
            take
        );
        Ok(vec![ToolResult::ok_with_images(
            body,
            Some(hint),
            attachments,
        )])
    }

    /// Same as [`Self::move_to_text_disambiguation_response`] but **no image attachments** (primary model is text-only).
    async fn move_to_text_disambiguation_text_only(
        host_ref: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
        text_query: &str,
        ocr_region_native: Option<OcrRegionNative>,
        matches: &[ScreenOcrTextMatch],
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let take = matches.len().min(Self::MOVE_TO_TEXT_DISAMBIGUATION_MAX);
        let mut candidates: Vec<Value> = Vec::with_capacity(take);
        for (i, m) in matches.iter().take(take).enumerate() {
            let idx_1based = i + 1;
            let ax = host_ref
                .accessibility_hit_at_global_point(m.center_x, m.center_y)
                .await?;
            candidates.push(json!({
                "match_index": idx_1based,
                "ocr_text": m.text,
                "confidence": m.confidence,
                "global_center_x": m.center_x,
                "global_center_y": m.center_y,
                "bounds_left": m.bounds_left,
                "bounds_top": m.bounds_top,
                "bounds_width": m.bounds_width,
                "bounds_height": m.bounds_height,
                "accessibility": ax,
            }));
        }
        let input_coords = json!({
            "kind": "move_to_text",
            "text_query": text_query,
            "ocr_region_native": ocr_region_native,
            "move_to_text_phase": "disambiguation",
        });
        let mut body = json!({
            "success": true,
            "action": "move_to_text",
            "move_to_text_phase": "disambiguation",
            "text_query": text_query,
            "ocr_region_native": ocr_region_native,
            "disambiguation_required": true,
            "instruction": "Several OCR hits for this substring. The primary model **cannot** view screenshots — pick **`move_to_text_match_index`** using **`candidates`** (global_center_* + accessibility) only. Call **`move_to_text` again** with the same `text_query`, same `ocr_region_native`, and **`move_to_text_match_index`** = that index. Pointer was not moved.",
            "candidates": candidates,
            "total_ocr_matches": matches.len(),
            "candidates_previewed": take,
        });
        if take < matches.len() {
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "truncation_note".to_string(),
                    json!(format!(
                        "Only the first {} of {} OCR matches are listed; narrow `ocr_region_native` or `text_query` if needed.",
                        take, matches.len()
                    )),
                );
            }
        }
        let body = computer_use_augment_result_json(host_ref, body, Some(input_coords)).await;
        let hint = format!(
            "move_to_text: {} OCR matches — set move_to_text_match_index using text candidates (no image previews). Pointer not moved.",
            matches.len(),
        );
        Ok(vec![ToolResult::ok(body, Some(hint))])
    }

    /// Text-only observation action: returns a structured text snapshot of
    /// the desktop (frontmost app + AX tree + condensed UI tree text +
    /// pointer + displays) with **no image bytes**. This is the observe and
    /// verify step that closes the cowork loop for text-only primary models
    /// that cannot consume `screenshot` JPEGs.
    async fn describe_screen(
        host: &dyn ComputerUseHost,
        input: &Value,
        text_only: bool,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let session_snap = host.computer_use_session_snapshot().await;
        let interaction = host.computer_use_interaction_state();
        // The human's foreground application is metadata, never the source of
        // an observation after a control target has been selected.
        let selector = if let Some(app) = input.get("app").filter(|v| v.is_object()) {
            Some(
                serde_json::from_value::<AppSelector>(app.clone())
                    .map_err(|e| OpenBitFunError::tool(format!("Invalid app selector: {e}")))?,
            )
        } else if host.control_snapshot().supported {
            Some(AppSelector::default())
        } else {
            session_snap
                .foreground_application
                .as_ref()
                .map(|fg| AppSelector {
                    name: fg.name.clone(),
                    bundle_id: fg.bundle_id.clone(),
                    pid: fg.process_id,
                })
        };
        let mut target_application = None;
        let mut ax_tree_text = None;
        let mut ax_nodes_count = None;
        let mut ax_digest = None;
        let mut window_title = None;
        let mut ax_error = None;
        let ax_tree_status = match selector {
            None => "no_foreground_app",
            Some(app) => match host
                .get_app_state(app, DESCRIBE_SCREEN_AX_DEPTH, true)
                .await
            {
                Ok(snap) => {
                    target_application = Some(snap.app);
                    window_title = snap.window_title;
                    ax_nodes_count = Some(snap.nodes.len());
                    ax_digest = Some(snap.digest);
                    let limited = snap.tree_text.contains("AX_WINDOW_CONTENT_UNAVAILABLE");
                    ax_tree_text = Some(clip_tree_text(
                        snap.tree_text,
                        DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES,
                    ))
                    .filter(|t| !t.trim().is_empty());
                    if limited {
                        "content_unavailable"
                    } else if ax_tree_text.is_some() {
                        "ok"
                    } else {
                        "empty_tree"
                    }
                }
                Err(e) => {
                    ax_error = Some(e.to_string());
                    "query_failed"
                }
            },
        };
        // Read pixels through the native capture provider, even for text-only
        // models. No JPEG is sent to a model that cannot consume images.
        let (ocr_text, ocr_status, ocr_error) = if text_only || ax_tree_status != "ok" {
            match host.read_screen_text().await {
                Ok(text) => {
                    let status = if text.is_empty() {
                        "no_text_detected"
                    } else {
                        "ok"
                    };
                    (text, status, None)
                }
                Err(e) => (Vec::new(), "unavailable", Some(e.to_string())),
            }
        } else {
            (Vec::new(), "not_requested", None)
        };
        if text_only && (ax_tree_status == "ok" || ocr_status == "ok") {
            host.computer_use_waive_fresh_capture_guard();
        }
        let ui_tree_text = host.enumerate_ui_tree_text().await;
        let ax_tree_note = match ax_tree_status {
            "ok" => None,
            "no_foreground_app" => Some("No target application is selected. Use list_apps, then get_app_state with an explicit app selector."),
            "content_unavailable" | "empty_tree" => Some("The target does not expose accessible content controls. Read ocr_text or the same target's screenshot. An unchanged accessibility tree does not prove an input action failed."),
            _ => Some("Read ax_error for the failed target query. Use the available OCR facts; do not activate another application or repeat a mutation to repair an observation failure."),
        };
        let body = json!({
            "success": true, "action": "describe_screen", "image_bytes": false,
            "foreground_application": session_snap.foreground_application,
            "target_application": target_application,
            "pointer_global": session_snap.pointer_global, "displays": interaction.displays,
            "window_title": window_title, "ax_tree_text": ax_tree_text,
            "ax_tree_status": ax_tree_status, "ax_tree_note": ax_tree_note,
            "ax_error": ax_error, "ax_nodes_count": ax_nodes_count,
            "ax_state_digest": ax_digest, "ui_tree_text": ui_tree_text,
            "ocr_text": ocr_text, "ocr_status": ocr_status, "ocr_error": ocr_error,
            "output_is_complete": true,
        });
        let body =
            computer_use_augment_result_json(host, body, Some(json!({"kind": "describe_screen"})))
                .await;
        Ok(vec![ToolResult::ok(body, Some(format!(
            "describe_screen: target observation returned (AX: {ax_tree_status}, OCR: {ocr_status}). Read the full observation, select app-scoped actions, and verify the resulting content."
        )))])
    }

    /// Screenshot tool results attach JPEGs via `tool_image_attachments`; only providers whose
    /// request converters emit multimodal tool output are supported.
    fn require_multimodal_tool_output_for_screenshot(ctx: &ToolUseContext) -> OpenBitFunResult<()> {
        if !ctx.primary_model_supports_image_understanding() {
            return Err(OpenBitFunError::tool(
                "The primary model does not accept images; do not use ComputerUse action `screenshot` or other image-producing steps. Use get_app_state/describe_screen and observed node_idx or ocr_text app-scoped targets.".to_string(),
            ));
        }
        if ctx.primary_model_facts().multimodal_tool_output_supported() {
            return Ok(());
        }
        Err(OpenBitFunError::tool(
            "Screenshot results include images in tool results; set the primary model to an image-capable model using Anthropic, OpenAI Chat/Responses, or Gemini API format.".to_string(),
        ))
    }

    fn resolve_xy_f64(
        host: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
        input: &Value,
        x: i32,
        y: i32,
    ) -> OpenBitFunResult<(f64, f64)> {
        if use_screen_coordinates(input) {
            return Ok((x as f64, y as f64));
        }
        if coordinate_mode(input) == "normalized" {
            host.map_normalized_coords_to_pointer_f64(x, y)
        } else {
            host.map_image_coords_to_pointer_f64(x, y)
        }
    }

    /// `click` must not carry coordinate fields — use `mouse_move` (or `move_to_text`, etc.) separately.
    fn ensure_click_has_no_coordinate_fields(input: &Value) -> OpenBitFunResult<()> {
        if input.get("x").is_some() || input.get("y").is_some() {
            return Err(OpenBitFunError::tool(
                "click does not accept x or y. Position with move_to_text, click_element, or `mouse_move` with use_screen_coordinates: true (globals from tool results), then `click` with only button and num_clicks.".to_string(),
            ));
        }
        if input.get("coordinate_mode").is_some() {
            return Err(OpenBitFunError::tool(
                "click does not accept coordinate_mode. Use `mouse_move` with use_screen_coordinates: true, then `click`.".to_string(),
            ));
        }
        if input.get("use_screen_coordinates").is_some() {
            return Err(OpenBitFunError::tool(
                "click does not accept use_screen_coordinates. Use `mouse_move` with use_screen_coordinates, then `click`.".to_string(),
            ));
        }
        Ok(())
    }

    /// Runtime host OS label for tool description (desktop session matches this process).
    fn host_os_label() -> &'static str {
        match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        }
    }

    fn key_chord_os_hint() -> &'static str {
        match std::env::consts::OS {
            "macos" => "macOS app_key_chord uses command/option/control/shift. Clipboard and global key_chord operate on desktop focus and require foreground mode.",
            "windows" => "Windows background typing supports validated native editable controls selected by observed node, image point or the bound window thread’s current focus; scrolling requires an observed scrollable node. App-scoped keyboard chords are unavailable; global key_chord requires foreground mode and uses meta, alt, control, shift.",
            "linux" => "Linux background actions use AT-SPI semantic nodes; text insertion requires an observed EditableText node in focus. Arbitrary background coordinates and app_key_chord are unavailable. Portal keyboard input requires foreground mode and uses control, alt, shift, meta/super.",
            _ => "Match modifiers to the host OS. Use app-scoped capabilities where available; desktop clipboard and seat input require foreground mode.",
        }
    }

    async fn find_text_on_screen(
        host_ref: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
        text_query: &str,
        region_native: Option<crate::agentic::tools::computer_use_host::OcrRegionNative>,
    ) -> OpenBitFunResult<Vec<ScreenOcrTextMatch>> {
        let matches = host_ref
            .ocr_find_text_matches(text_query, region_native)
            .await?;
        Ok(matches
            .into_iter()
            .map(|m| ScreenOcrTextMatch {
                text: m.text,
                confidence: m.confidence,
                center_x: m.center_x,
                center_y: m.center_y,
                bounds_left: m.bounds_left,
                bounds_top: m.bounds_top,
                bounds_width: m.bounds_width,
                bounds_height: m.bounds_height,
            })
            .collect())
    }

    fn locate_query_has_any_target(query: &UiElementLocateQuery) -> bool {
        query.node_idx.is_some()
            || query.text_contains.is_some()
            || query.title_contains.is_some()
            || query.role_substring.is_some()
            || query.identifier_contains.is_some()
    }

    fn target_text_query<'a>(input: &'a Value, query: &'a UiElementLocateQuery) -> Option<&'a str> {
        input
            .get("target_text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                input
                    .get("text_query")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                query
                    .text_contains
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                query
                    .title_contains
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
    }

    async fn resolve_target_point(
        host_ref: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
        input: &Value,
    ) -> OpenBitFunResult<ResolvedDesktopTarget> {
        let mut query = parse_locate_query(input);
        if query.text_contains.is_none() {
            if let Some(target_text) = input
                .get("target_text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                query.text_contains = Some(target_text.to_string());
            }
        }

        let mut ax_error: Option<String> = None;
        if Self::locate_query_has_any_target(&query) {
            match host_ref
                .locate_ui_element_screen_center(query.clone())
                .await
            {
                Ok(res) => {
                    return Ok(ResolvedDesktopTarget {
                        source: "ax".to_string(),
                        x: res.global_center_x,
                        y: res.global_center_y,
                        matched_text: res.matched_title.clone(),
                        matched_role: Some(res.matched_role),
                        matched_identifier: res.matched_identifier,
                        total_matches: Some(res.total_matches.max(1)),
                        selected_match_index: Some(1),
                        warning: (res.total_matches > 1).then(|| {
                            format!(
                                "{} AX elements matched; selected the host-ranked best match.",
                                res.total_matches
                            )
                        }),
                        ax_error: None,
                    });
                }
                Err(err) => {
                    ax_error = Some(err.to_string());
                }
            }
        }

        if let Some(text_query) = Self::target_text_query(input, &query) {
            let ocr_region_native = parse_ocr_region_native(input)?;
            let matches =
                Self::find_text_on_screen(host_ref, text_query, ocr_region_native).await?;
            if !matches.is_empty() {
                let requested_index = input
                    .get("move_to_text_match_index")
                    .or_else(|| input.get("target_match_index"))
                    .and_then(|v| v.as_u64())
                    .map(|u| u as usize);
                let selected = match requested_index {
                    Some(idx) if idx >= 1 && idx <= matches.len() => idx - 1,
                    Some(idx) => {
                        return Err(OpenBitFunError::tool(format!(
                            "target_match_index/move_to_text_match_index must be between 1 and {} (got {}).",
                            matches.len(),
                            idx
                        )));
                    }
                    None => matches
                        .iter()
                        .enumerate()
                        .max_by(|(_, a), (_, b)| {
                            a.confidence
                                .partial_cmp(&b.confidence)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .map(|(idx, _)| idx)
                        .unwrap_or(0),
                };
                let m = &matches[selected];
                return Ok(ResolvedDesktopTarget {
                    source: "ocr".to_string(),
                    x: m.center_x,
                    y: m.center_y,
                    matched_text: Some(m.text.clone()),
                    matched_role: None,
                    matched_identifier: None,
                    total_matches: Some(matches.len() as u32),
                    selected_match_index: Some((selected + 1) as u32),
                    warning: (matches.len() > 1 && requested_index.is_none()).then(|| {
                        format!(
                            "{} OCR matches found for {:?}; selected the highest-confidence match. Pass target_match_index to pin another candidate.",
                            matches.len(),
                            text_query
                        )
                    }),
                    ax_error,
                });
            }
        }

        if input.get("x").is_some() || input.get("y").is_some() {
            ensure_pointer_move_uses_screen_coordinates_only(input)?;
            let x = req_i32(input, "x")?;
            let y = req_i32(input, "y")?;
            let (sx64, sy64) = Self::resolve_xy_f64(host_ref, input, x, y)?;
            if use_screen_coordinates(input) {
                ensure_global_xy_on_display(host_ref, sx64, sy64).await?;
            }
            return Ok(ResolvedDesktopTarget {
                source: "screen_xy".to_string(),
                x: sx64,
                y: sy64,
                matched_text: None,
                matched_role: None,
                matched_identifier: None,
                total_matches: None,
                selected_match_index: None,
                warning: None,
                ax_error,
            });
        }

        Err(OpenBitFunError::tool(
            "move_to_target/click_target requires a target: node_idx, target_text/text_query/text_contains/title_contains, role_substring, identifier_contains, or x/y with use_screen_coordinates: true.".to_string(),
        ))
    }

    /// Writes the exact host capture sent to the model under the workspace for debugging.
    /// No-op unless [`COMPUTER_USE_DEBUG_SCREENSHOTS_ENV`] is set to `1`.
    async fn try_save_screenshot_for_debug(
        bytes: &[u8],
        context: &ToolUseContext,
    ) -> Option<String> {
        if std::env::var(COMPUTER_USE_DEBUG_SCREENSHOTS_ENV).as_deref() != Ok("1") {
            return None;
        }
        let root = context.workspace_root()?;
        let debug_subdir = computer_use_debug_subdir();
        let dir = root.join(&debug_subdir);
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            warn!("computer_use debug screenshot mkdir: {}", e);
            return None;
        }
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let fname = format!("cu_{ms}_authorized_capture.jpg");
        let path = dir.join(&fname);
        if let Err(e) = tokio::fs::write(&path, bytes).await {
            warn!(
                "computer_use debug screenshot write {}: {}",
                path.display(),
                e
            );
            return None;
        }
        debug!(
            "computer_use debug: wrote authorized capture -> {}",
            path.display()
        );
        Self::prune_debug_screenshots(&dir).await;
        Some(format!("{}/{}", debug_subdir.replace('\\', "/"), fname))
    }

    /// Keeps only the newest [`COMPUTER_USE_DEBUG_MAX_FILES`] files (by mtime) in the debug dir.
    async fn prune_debug_screenshots(dir: &std::path::Path) {
        let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            files.push((modified, entry.path()));
        }
        if files.len() <= COMPUTER_USE_DEBUG_MAX_FILES {
            return;
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in files.into_iter().skip(COMPUTER_USE_DEBUG_MAX_FILES) {
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!(
                    "computer_use debug screenshot prune {}: {}",
                    path.display(),
                    e
                );
            }
        }
    }

    /// Build tool JSON + one JPEG attachment + assistant hint from an already-captured [`ComputerScreenshot`].
    async fn pack_screenshot_tool_output(
        shot: &ComputerScreenshot,
        debug_rel: Option<String>,
        input: &Value,
    ) -> OpenBitFunResult<(Value, ToolImageAttachment, String)> {
        let b64 = B64.encode(&shot.bytes);
        let ignored: Vec<&str> = [
            "screenshot_crop_center_x",
            "screenshot_crop_center_y",
            "screenshot_crop_half_extent_native",
            "screenshot_navigate_quadrant",
            "screenshot_reset_navigation",
            "screenshot_implicit_center",
            "window",
            "screenshot_window",
            "crop_to_focused_window",
        ]
        .into_iter()
        .filter(|field| input.get(*field).is_some())
        .collect();
        let hint = format!("Authorized capture {}x{}; screenshot_id={}. Use image_xy with this screenshot_id and the returned coordinate geometry. Capture parameters never select or authorize another surface.", shot.image_width, shot.image_height, shot.screenshot_id.as_deref().unwrap_or("unavailable"));
        let mut data = json!({
            "success": true, "action": "screenshot", "screenshot_id": shot.screenshot_id,
            "mime_type": shot.mime_type, "image_width": shot.image_width,
            "image_height": shot.image_height, "native_width": shot.native_width,
            "native_height": shot.native_height, "display_origin_x": shot.display_origin_x,
            "display_origin_y": shot.display_origin_y, "vision_scale": shot.vision_scale,
            "image_content_rect": shot.image_content_rect,
            "image_global_bounds": shot.image_global_bounds,
            "debug_screenshot_path": debug_rel,
        });
        if !ignored.is_empty() {
            data["compatibility"] = json!({"ignored_fields": ignored,
                "note": "Legacy crop, quadrant, navigation and window hints are accepted but ignored. The image is the current authorized capture, with no additional crop, display navigation or target change."});
        }
        let attach = ToolImageAttachment {
            mime_type: shot.mime_type.clone(),
            data_base64: b64,
        };
        Ok((data, attach, hint))
    }
}

/// Verify a global (gx, gy) coordinate falls within at least one display reported by
/// the host. Returns a structured `DESKTOP_COORD_OUT_OF_DISPLAY` error otherwise.
///
/// This is the guard rail that prevents models from passing image-pixel coordinates
/// (taken from a screenshot crop) straight into `mouse_move(use_screen_coordinates=true)`.
pub(crate) async fn ensure_global_xy_on_display(
    host: &dyn crate::agentic::tools::computer_use_host::ComputerUseHost,
    gx: f64,
    gy: f64,
) -> OpenBitFunResult<()> {
    let displays = host.list_displays().await.unwrap_or_default();
    if displays.is_empty() {
        // Host can't enumerate displays (non-desktop runtime) — skip the guard.
        return Ok(());
    }
    let on_any = displays.iter().any(|d| {
        let x0 = d.origin_x as f64;
        let y0 = d.origin_y as f64;
        let x1 = x0 + d.width_logical as f64;
        let y1 = y0 + d.height_logical as f64;
        gx >= x0 && gx < x1 && gy >= y0 && gy < y1
    });
    if on_any {
        return Ok(());
    }
    let bounds: Vec<String> = displays
        .iter()
        .map(|d| {
            format!(
                "display_id={} bounds=({},{})-({},{}) scale={:.2}",
                d.display_id,
                d.origin_x,
                d.origin_y,
                d.origin_x + d.width_logical as i32,
                d.origin_y + d.height_logical as i32,
                d.scale_factor
            )
        })
        .collect();
    Err(coded_tool_error(ErrorCode::DesktopCoordOutOfDisplay, format!("global=({:.1},{:.1}) does not lie on any visible display. \
         Visible displays: [{}]. Hint: image-pixel coordinates are NOT screen coordinates. \
         Use screenshot.pointer_global, click_element/locate result.global_center_x/y, or move_to_text. \
         To convert image→global, use the screenshot's display_id + scale_factor.", gx,
        gy,
        bounds.join("; "))))
}

/// Helper: build `UiElementLocateQuery` from tool input JSON.
fn parse_locate_query(input: &Value) -> UiElementLocateQuery {
    UiElementLocateQuery {
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
            .and_then(|v| v.as_u64())
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
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        app_state_digest: input
            .get("app_state_digest")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

fn parse_ocr_region_native(
    input: &Value,
) -> OpenBitFunResult<Option<crate::agentic::tools::computer_use_host::OcrRegionNative>> {
    let v = input
        .get("ocr_region_native")
        .or_else(|| input.get("ocr_region"));
    let Some(val) = v else {
        return Ok(None);
    };
    if val.is_null() {
        return Ok(None);
    }
    let o = val.as_object().ok_or_else(|| {
        OpenBitFunError::tool(
            "ocr_region_native must be an object { x0, y0, width, height } in global native pixels."
                .to_string(),
        )
    })?;
    let x0 = o.get("x0").and_then(|x| x.as_i64()).ok_or_else(|| {
        OpenBitFunError::tool("ocr_region_native.x0 (integer) is required.".to_string())
    })? as i32;
    let y0 = o.get("y0").and_then(|x| x.as_i64()).ok_or_else(|| {
        OpenBitFunError::tool("ocr_region_native.y0 (integer) is required.".to_string())
    })? as i32;
    let width = o.get("width").and_then(|x| x.as_u64()).ok_or_else(|| {
        OpenBitFunError::tool("ocr_region_native.width (positive integer) is required.".to_string())
    })? as u32;
    let height = o.get("height").and_then(|x| x.as_u64()).ok_or_else(|| {
        OpenBitFunError::tool(
            "ocr_region_native.height (positive integer) is required.".to_string(),
        )
    })? as u32;
    if width == 0 || height == 0 {
        return Err(OpenBitFunError::tool(
            "ocr_region_native width and height must be greater than zero.".to_string(),
        ));
    }
    Ok(Some(
        crate::agentic::tools::computer_use_host::OcrRegionNative {
            x0,
            y0,
            width,
            height,
        },
    ))
}

#[async_trait]
impl Tool for ComputerUseTool {
    fn name(&self) -> &str {
        "ComputerUse"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        let os = Self::host_os_label();
        let keys = Self::key_chord_os_hint();
        Ok(format!(
            "Desktop application control on {}. {} \
Start with start_control mode=background and reuse that session across observations and actions. \
Use foreground only when the user explicitly requests taking over the visible desktop; do not switch modes or activate an app merely to repair an observation error. \
Use list_apps once to identify the target, then get_app_state with its app selector (pid, bundle_id, or name). \
An empty app selector follows the bound target, or the current app when no target is bound yet. \
For GUI tasks, use this tool's capture, accessibility and input interfaces. Do not replace failed observations with ad hoc AppleScript, screen-capture, or OCR programs in ExecCommand. \
Read the returned structured data: application identities, tree_text, node indices, screenshot_id, coordinate bounds, and errors. \
Prefer app_batch for already-decided app_click, app_type_text, app_key_chord, app_scroll or app_drag steps; it returns one final observation. Stop before choosing a target that depends on new pixels. Never replay completed receipts after a partial failure. \
Use observed image_xy coordinates with the matching screenshot_id; node_idx and ocr_text are optional precision aids, not prerequisites for graphical controls. \
Screenshot image coordinates are valid only with that screenshot identity and its image_content_rect/image_global_bounds; never reinterpret them as screen coordinates. \
Execute an action or batch once, then verify the intended change. A submitted event is not evidence of successful delivery; do not repeat a mutation merely because the AX digest is unchanged. \
If the app exposes only window chrome, use the authorized window screenshot and built-in OCR targeting instead of guessing controls from a sparse tree. \
For text-only models use describe_screen and the returned accessibility/OCR facts; screenshot requires image support. \
When the host cannot observe the necessary content, report the specific missing capability instead of inventing a successful state. \
Keep the capture session active during the task. control_status reports its owner, mode and target; capabilities describe backend routes, not support for every control or arbitrary background pointer input. stop_control releases it when finished. \
A system stop requires an explicit new start. Prefer ControlHub's browser interface for web content; ComputerUse can operate native browser chrome and dialogs. \
Before sending a message or another irreversible action, verify the intended target and content using the current observation; verify the resulting state afterward.",
            os, keys,
        ))
    }

    fn short_description(&self) -> String {
        "Inspect the screen and control desktop input for computer-use tasks.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let vision = context
            .map(|c| c.primary_model_supports_image_understanding())
            .unwrap_or(true);
        if vision {
            self.description().await
        } else {
            Ok(Self::description_text_only())
        }
    }

    fn input_schema(&self) -> Value {
        let properties = Self::merge_with_shared_properties(json!({
            "action": {
                "type": "string",
                "enum": ["start_control", "stop_control", "control_status", "screenshot", "describe_screen", "click_target", "move_to_target", "click_element", "move_to_text", "click", "mouse_move", "scroll", "drag", "locate", "key_chord", "type_text", "pointer_move_rel", "wait", "list_displays", "focus_display", "paste", "list_apps", "get_app_state", "get_app_shortcuts", "app_batch", "app_drag", "app_click", "app_type_text", "app_scroll", "app_key_chord", "app_wait_for", "build_interactive_view", "interactive_click", "interactive_type_text", "interactive_scroll", "build_visual_mark_view", "visual_click", "open_app", "open_url", "open_file", "clipboard_get", "clipboard_set", "run_script", "run_apple_script", "get_os_info"],
                "description": "Select a ComputerUse action. Start background control, identify the app with list_apps, then observe it with get_app_state/describe_screen/screenshot and prefer app_click/app_type_text/app_scroll/app_key_chord. For app_click use a fresh node_idx, observed ocr_text, or image_xy/image_grid with the screenshot_id from that same app observation. Screenshot pixels are valid for these app-scoped targets; do not reinterpret them as global screen coordinates. Consult get_app_shortcuts for unknown shortcuts. Keep the session active across observations and actions; control_status reports its scope and stop_control releases it. Global click (at the current pointer), mouse_move, key_chord, type_text and paste require foreground mode and an explicit user request to take over the visible desktop. A parent-generated task plan is not user approval for foreground takeover; ordinary app tasks and confirmation of message content keep background mode. Never activate the target or switch modes merely to repair an observation error. Do not replace failed GUI observations with ad hoc scripts in ExecCommand. Reuse the returned after-action observation; app_type_text with focus combines known targeting and exact Unicode input. Observe, act once, then verify the intended result; do not repeat a mutation merely because its digest is unchanged. Prefer ControlHub domain=\"browser\" for web content; ComputerUse supports native browser chrome and dialogs."
            },
            "use_screen_coordinates": { "type": "boolean", "description": "For `mouse_move`, `drag`: **must be true** — global display coordinates (e.g. macOS points) from `move_to_text`, `locate`, AX, or `pointer_global`. **Not** for `click`." },
            "delta_x": { "type": "integer", "description": "For `pointer_move_rel`: horizontal delta (negative=left); also accepted as `dx`. **Not** allowed as the first move after `screenshot` (host). For `scroll`: horizontal wheel delta." },
            "delta_y": { "type": "integer", "description": "For `pointer_move_rel`: vertical delta (negative=up); also accepted as `dy`. **Not** allowed as the first move after `screenshot` (host). For `scroll`: vertical wheel delta." },
            "keys": { "type": "array", "items": { "type": "string" }, "description": "For `key_chord`: keys in order — **modifiers first**, then the main key (e.g. `[\"command\",\"f\"]`). Desktop host waits after pressing modifiers so shortcuts register (important on macOS with IME). Modifiers: command, control, shift, alt/option. Arrows: `up`, `down`, … Host may require a fresh screenshot before Return/Enter when the pointer is stale." },
            "target_text": { "type": "string", "description": "For `move_to_target` / `click_target`: visible or accessible text. The resolver tries AX text first, then OCR text, without requiring a prior screenshot." },
            "target_match_index": { "type": "integer", "minimum": 1, "description": "For `move_to_target` / `click_target`: optional 1-based OCR match index when you want a specific candidate. Alias of `move_to_text_match_index` for the unified target actions." },
            "move_to_text_match_index": { "type": "integer", "minimum": 1, "description": "For `move_to_text` and unified target actions: **1-based** OCR match index. For `move_to_text`, use after a disambiguation response; for `click_target`, use to pin a candidate." },
            "ocr_region_native": {
                "type": "object",
                "description": "For `move_to_text`: optional global native rectangle within the authorized target capture. Omit to read that target window. This never expands capture to another window or display. Requires x0, y0, width, height.",
                "properties": {
                    "x0": { "type": "integer", "description": "Top-left X in global screen coordinates (macOS: same logical space as CGDisplayBounds / pointer; not physical Retina pixels)." },
                    "y0": { "type": "integer", "description": "Top-left Y in global screen coordinates (macOS: logical, Y-down)." },
                    "width": { "type": "integer", "minimum": 1, "description": "Width in the same coordinate unit as x0/y0 (logical on macOS)." },
                    "height": { "type": "integer", "minimum": 1, "description": "Height in the same coordinate unit as x0/y0 (logical on macOS)." }
                }
            },
            "title_contains": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring on AXTitle ONLY. Use same language as the app UI. Prefer `text_contains` (also covers AXValue/AXDescription/AXHelp) when in doubt." },
            "role_substring": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring on AXRole **or AXSubrole** (e.g. \"Button\", \"TextField\", \"SearchField\")." },
            "text_contains": { "type": "string", "description": "For `locate`, `click_element`: case-insensitive substring matched against ANY of AXTitle / AXValue / AXDescription / AXHelp. Best default when the visible label lives in value/description (e.g. AXStaticText cards)." },
            "app_name": { "type": "string", "description": "For `open_app`: the application name to launch (e.g. \"Safari\", \"WeChat\", \"Visual Studio Code\")." },
            "script": { "type": "string", "description": "For `run_apple_script`: the AppleScript code to execute via `osascript`. macOS only." },
            "opts": { "type": "object", "description": "For `build_interactive_view` / `build_visual_mark_view`: optional view options." },
            "i": { "type": ["integer", "null"], "description": "For interactive/visual actions: element or mark index from the latest view." },
            "scroll_x": { "type": "integer", "description": "For `scroll`: optional global X coordinate to move pointer before scrolling. Use with `scroll_y`. Requires `use_screen_coordinates`: true." },
            "scroll_y": { "type": "integer", "description": "For `scroll`: optional global Y coordinate to move pointer before scrolling. Use with `scroll_x`. Requires `use_screen_coordinates`: true." }
        }));
        json!({
            "type": "object",
            "properties": properties,
            "required": ["action"],
            "additionalProperties": false
        })
    }

    async fn input_schema_for_model_with_context(&self, context: Option<&ToolUseContext>) -> Value {
        let vision = context
            .map(|c| c.primary_model_supports_image_understanding())
            .unwrap_or(true);
        self.model_input_schema(vision)
    }

    async fn input_schema_for_model(&self) -> Value {
        self.model_input_schema(true)
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(vec![PermissionIntent::new(
            "computer_use",
            vec![computer_use_permission_resource(input)],
        )])
    }

    async fn is_enabled(&self) -> bool {
        if !computer_use_desktop_available() {
            return false;
        }
        let Ok(service) = GlobalConfigManager::get_service().await else {
            return false;
        };
        let ai: crate::service::config::types::AIConfig =
            service.get_config(Some("ai")).await.unwrap_or_default();
        ai.computer_use_enabled
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.map(|ctx| ctx.is_remote()).unwrap_or(false) {
            return false;
        }
        self.is_enabled().await
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let mut results = self.call_with_control(input, context).await?;
        super::computer_use_presentation::complete_model_results(&mut results);
        Ok(results)
    }
}

impl ComputerUseTool {
    fn capture_failure_allows_ax_observation(error: &OpenBitFunError) -> bool {
        // Native capture adapters expose a leading machine code, not a prose
        // classifier. Unknown errors and control/authorization revocations stay
        // fail-closed even when their human text mentions an unavailable frame.
        let OpenBitFunError::Tool(message) = error else {
            return false;
        };
        let code = if let Some(rest) = message.strip_prefix('[') {
            rest.split_once(']').map(|(code, _)| code)
        } else {
            message.split_once(':').map(|(code, _)| code)
        };
        matches!(
            code,
            Some(
                "CAPTURE_TIMEOUT"
                    | "CAPTURE_FRAME_UNAVAILABLE"
                    | "TARGET_APP_HIDDEN"
                    | "TARGET_SURFACE_UNAVAILABLE"
                    | "TARGET_NOT_VISIBLE"
                    | "TARGET_WINDOW_UNAVAILABLE"
                    | "SCREEN_CAPTURE_PERMISSION_REQUIRED"
            )
        )
    }

    async fn call_with_control(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return Err(OpenBitFunError::tool(
                "ComputerUse cannot run while the session workspace is remote (SSH).",
            ));
        }
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::tool("action is required"))?;
        let host = context
            .computer_use_host
            .as_ref()
            .ok_or_else(|| OpenBitFunError::tool("Desktop control provider unavailable"))?;
        let owner = match context.session_id.as_deref() {
            Some(owner) => owner,
            None if !host.control_snapshot().supported => "legacy-local-tool-context",
            None => {
                return Err(OpenBitFunError::tool(
                    "[CONTROL_OWNER_REQUIRED] Desktop control requires a runtime session",
                ))
            }
        };
        match action {
            "control_status" => {
                return Ok(vec![ToolResult::ok(
                    serde_json::to_value(host.control_snapshot())?,
                    None,
                )])
            }
            "stop_control" => {
                return Ok(vec![ToolResult::ok(
                    serde_json::to_value(host.stop_control(owner).await?)?,
                    None,
                )])
            }
            "start_control" => {
                let request = serde_json::from_value::<
                    crate::agentic::tools::computer_use_host::ControlStartRequest,
                >(input.clone())
                .map_err(|e| OpenBitFunError::tool(format!("Invalid control request: {e}")))?;
                let snapshot = host.start_control(owner, request).await?;
                Self::watch_control_cancellation(host.clone(), context, snapshot.generation);
                return Ok(vec![ToolResult::ok(serde_json::to_value(snapshot)?, None)]);
            }
            _ => {}
        }
        let previous_generation = host.control_snapshot().generation;
        let mut lease = host.acquire_control_action(owner, action).await?;
        let current_generation = host.control_snapshot().generation;
        if current_generation != previous_generation {
            Self::watch_control_cancellation(host.clone(), context, current_generation);
        }
        let result = async {
            let mut capture_preparation_error = None;
            if !matches!(
                action,
                "list_apps"
                    | "list_displays"
                    | "wait"
                    | "get_os_info"
                    | "clipboard_get"
                    | "clipboard_set"
                    | "open_app"
                    | "open_url"
                    | "open_file"
                    | "run_script"
                    | "run_apple_script"
            ) {
                let app: crate::agentic::tools::computer_use_host::AppSelector = match input.get("app").filter(|v| v.is_object()) {
                    Some(app) => serde_json::from_value(app.clone())
                        .map_err(|e| OpenBitFunError::tool(format!("Invalid app selector: {e}")))?,
                    None => crate::agentic::tools::computer_use_host::AppSelector::default(),
                };
                let explicit_target = !app.is_empty();
                if let Err(error) = host.prepare_control_target(app).await {
                    // These reads resolve their own explicit selector and never
                    // consult the old capture's pixels, OCR or pointer map. An
                    // empty selector is deliberately not eligible: after failed
                    // preparation it could otherwise resolve the wrong app.
                    if explicit_target
                        && matches!(action, "get_app_state" | "get_app_shortcuts")
                        && Self::capture_failure_allows_ax_observation(&error)
                    {
                        capture_preparation_error = Some(error.to_string());
                    } else {
                        return Err(error);
                    }
                }
            }
            let mut results = self.call_controlled(input, context).await?;
            if let Some(error) = capture_preparation_error {
                for result in &mut results {
                    if let ToolResult::Result { data, .. } = result {
                        data["capture_preparation_error"] = json!(error);
                        data["control_target_available"] = json!(false);
                        data["capture_status"] = json!("unavailable");
                        data["background_input"] = json!(false);
                        data["control_guidance"] = json!("Accessibility facts describe the explicitly requested app. Capture preparation failed; these facts do not establish a control binding or authorize input. Do not use a previously bound app's pixels or coordinates.");
                    }
                }
            }
            Ok(results)
        }
        .await;
        if let Some(lease) = lease.as_mut() {
            lease.complete();
        }
        result
    }

    fn watch_control_cancellation(
        host: crate::agentic::tools::computer_use_host::ComputerUseHostRef,
        context: &ToolUseContext,
        generation: u64,
    ) {
        let Some(token) = context.cancellation_token().cloned() else {
            return;
        };
        let owner = context
            .session_id
            .clone()
            .unwrap_or_else(|| "legacy-local-tool-context".into());
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = token.cancelled() => {
                        if host.control_snapshot().generation == generation { let _ = host.stop_control_generation(&owner, generation).await; }
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                        let state = host.control_snapshot();
                        if state.generation != generation || state.state == "stopped" { break; }
                    }
                }
            }
        });
    }
    async fn call_controlled(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return Err(OpenBitFunError::tool(
                "ComputerUse cannot run while the session workspace is remote (SSH).".to_string(),
            ));
        }

        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("action is required".to_string()))?;

        // Browser process identity does not determine input authority. The
        // session owner, selected target and host control scope govern input;
        // page automation is a preferred route, not a desktop capability gate.
        match action {
            "open_url" | "open_file" | "clipboard_get" | "clipboard_set" | "run_script"
            | "get_os_info" => {
                return super::computer_use_actions::ComputerUseActions::new()
                    .handle_system(action, input, context)
                    .await;
            }
            _ => {}
        }

        if Self::routes_to_desktop_action_dispatcher(action) {
            return super::computer_use_actions::ComputerUseActions::new()
                .handle_desktop(action, input, context)
                .await;
        }

        let host = context.computer_use_host.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "Computer use is only available in the OpenBitFun desktop app.".to_string(),
            )
        })?;

        let host_ref = host.as_ref();

        match action {
            "locate" => execute_computer_use_locate(input, context).await,

            // Text-only observation: the "eyes" of the desktop loop when the
            // primary model cannot consume screenshot images. Returns a
            // structured text snapshot (frontmost app + AX tree + UI tree text
            // + pointer + displays) with NO image bytes. This is the observe and
            // verify step that closes the cowork loop for text-only models.
            "describe_screen" => {
                let text_only = !context.primary_model_supports_image_understanding();
                return Self::describe_screen(host_ref, input, text_only).await;
            }

            // Unified target resolver: AX first, OCR second, explicit screen
            // coordinates last. This is the preferred mouse path for common
            // "move/click the visible thing" requests because it avoids
            // spreading one intent across locate -> move -> click tool calls.
            "move_to_target" | "click_target" => {
                let should_click = action == "click_target";
                let target = Self::resolve_target_point(host_ref, input).await?;
                host_ref.mouse_move_global_f64(target.x, target.y).await?;
                if target.source == "ocr" {
                    ComputerUseHost::computer_use_trust_pointer_after_ocr_move(host_ref);
                }

                let button = input
                    .get("button")
                    .and_then(|v| v.as_str())
                    .unwrap_or("left");
                let num_clicks = input
                    .get("num_clicks")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1)
                    .clamp(1, 3) as u32;

                if should_click {
                    for _ in 0..num_clicks {
                        host_ref.mouse_click_authoritative(button).await?;
                    }
                }

                let target_source = target.source.clone();
                let input_coords = json!({
                    "kind": action,
                    "source": target_source,
                    "resolved_global": { "x": target.x, "y": target.y },
                    "button": if should_click { Some(button) } else { None },
                    "num_clicks": if should_click { Some(num_clicks) } else { None },
                });
                let mut result_json = json!({
                    "success": true,
                    "action": action,
                    "target_resolution_source": target.source,
                    "global_center_x": target.x,
                    "global_center_y": target.y,
                    "matched_text": target.matched_text,
                    "matched_role": target.matched_role,
                    "matched_identifier": target.matched_identifier,
                    "total_matches": target.total_matches,
                    "selected_match_index": target.selected_match_index,
                    "clicked": should_click,
                    "button": if should_click { Some(button) } else { None },
                    "num_clicks": if should_click { Some(num_clicks) } else { None },
                });
                if let Some(warning) = target.warning {
                    result_json["warning"] = json!(warning);
                }
                if let Some(ax_error) = target.ax_error {
                    result_json["ax_fallback_error"] = json!(ax_error);
                }
                let body =
                    computer_use_augment_result_json(host_ref, result_json, Some(input_coords))
                        .await;
                let summary = if should_click {
                    format!(
                        "Resolved target via {} and clicked at ({:.0}, {:.0}).",
                        body.get("target_resolution_source")
                            .and_then(|v| v.as_str())
                            .unwrap_or("target"),
                        target.x,
                        target.y
                    )
                } else {
                    format!(
                        "Resolved target via {} and moved pointer to ({:.0}, {:.0}).",
                        body.get("target_resolution_source")
                            .and_then(|v| v.as_str())
                            .unwrap_or("target"),
                        target.x,
                        target.y
                    )
                };
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            // ---- NEW: click_element (locate + move + click in one call) ----
            "click_element" => {
                let query = parse_locate_query(input);
                // Accept ANY locator that can plausibly identify a node:
                // - text_contains: wide needle over title|value|description|help
                // - node_idx: direct AX-snapshot pin (zero-ambiguity)
                // - title_contains / role_substring / identifier_contains: legacy filters
                // The previous restriction (title/role/identifier only) blocked
                // the most useful path — clicking by visible label that lives
                // in AXValue/AXDescription — and forced models into brittle
                // role guessing.
                if query.title_contains.is_none()
                    && query.text_contains.is_none()
                    && query.role_substring.is_none()
                    && query.identifier_contains.is_none()
                    && query.node_idx.is_none()
                {
                    return Err(OpenBitFunError::tool(
                        "click_element requires at least one of text_contains, title_contains, role_substring, identifier_contains, or node_idx.".to_string(),
                    ));
                }
                let button = input
                    .get("button")
                    .and_then(|v| v.as_str())
                    .unwrap_or("left");
                let num_clicks = input
                    .get("num_clicks")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1)
                    .clamp(1, 3) as u32;

                let res = host_ref
                    .locate_ui_element_screen_center(query.clone())
                    .await?;

                // Move pointer to AX center using global screen coordinates (authoritative).
                host_ref
                    .mouse_move_global_f64(res.global_center_x, res.global_center_y)
                    .await?;

                // Relaxed guard: AX coordinates are authoritative, no fine-screenshot needed.
                host_ref.computer_use_guard_click_allowed_relaxed()?;

                for _ in 0..num_clicks {
                    host_ref.mouse_click_authoritative(button).await?;
                }

                let click_label = match num_clicks {
                    2 => "double",
                    3 => "triple",
                    _ => "single",
                };
                let input_coords = json!({
                    "kind": "click_element",
                    "query": {
                        "title_contains": query.title_contains,
                        "role_substring": query.role_substring,
                        "identifier_contains": query.identifier_contains,
                        "filter_combine": query.filter_combine,
                    },
                    "button": button,
                    "num_clicks": num_clicks,
                });
                let mut result_json = json!({
                    "success": true,
                    "action": "click_element",
                    "matched_role": res.matched_role,
                    "matched_title": res.matched_title,
                    "matched_identifier": res.matched_identifier,
                    "global_center_x": res.global_center_x,
                    "global_center_y": res.global_center_y,
                    "button": button,
                    "num_clicks": num_clicks,
                });
                if let Some(ref pc) = res.parent_context {
                    result_json["parent_context"] = json!(pc);
                }
                if res.total_matches > 1 {
                    result_json["total_matches"] = json!(res.total_matches);
                    result_json["warning"] = json!(format!(
                        "{} elements matched; clicked the best-ranked one. See other_matches if wrong.",
                        res.total_matches
                    ));
                }
                if !res.other_matches.is_empty() {
                    result_json["other_matches"] = json!(res.other_matches);
                }
                let body =
                    computer_use_augment_result_json(host_ref, result_json, Some(input_coords))
                        .await;
                let match_info = if res.total_matches > 1 {
                    format!(" ({} matches)", res.total_matches)
                } else {
                    String::new()
                };
                let summary = format!(
                    "AX click_element: {} {} click on role={} at ({:.0}, {:.0}).{}",
                    button,
                    click_label,
                    res.matched_role,
                    res.global_center_x,
                    res.global_center_y,
                    match_info,
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            "move_to_text" => {
                let text_query = input
                    .get("text_query")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        OpenBitFunError::tool(
                            "move_to_text requires non-empty string field `text_query`."
                                .to_string(),
                        )
                    })?;
                let ocr_region_native = parse_ocr_region_native(input)?;
                let move_to_text_match_index = input
                    .get("move_to_text_match_index")
                    .and_then(|v| v.as_u64())
                    .map(|u| u as u32);

                {
                    let matches =
                        Self::find_text_on_screen(host_ref, text_query, ocr_region_native.clone())
                            .await?;
                    if matches.is_empty() {
                        return Err(OpenBitFunError::tool(format!(
                            "move_to_text found no visible OCR match for {:?}. Take a fresh screenshot and try a shorter or more distinctive substring, or use click_element.",
                            text_query
                        )));
                    }

                    let n = matches.len();
                    if n > 1 && move_to_text_match_index.is_none() {
                        if context.primary_model_supports_image_understanding() {
                            return Self::move_to_text_disambiguation_response(
                                host_ref,
                                context,
                                text_query,
                                ocr_region_native.clone(),
                                &matches,
                            )
                            .await;
                        }
                        return Self::move_to_text_disambiguation_text_only(
                            host_ref,
                            text_query,
                            ocr_region_native.clone(),
                            &matches,
                        )
                        .await;
                    }

                    let sel: usize = match move_to_text_match_index {
                        None => 0,
                        Some(idx) => {
                            if idx < 1 || idx > n as u32 {
                                return Err(OpenBitFunError::tool(format!(
                                    "move_to_text_match_index must be between 1 and {} ({} OCR matches for {:?}).",
                                    n, n, text_query
                                )));
                            }
                            (idx - 1) as usize
                        }
                    };

                    let matched = &matches[sel];
                    host_ref
                        .mouse_move_global_f64(matched.center_x, matched.center_y)
                        .await?;
                    ComputerUseHost::computer_use_trust_pointer_after_ocr_move(host_ref);

                    let other_matches = matches
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i != sel)
                        .take(4)
                        .map(|(_, m)| {
                            json!({
                                "text": m.text,
                                "confidence": m.confidence,
                                "center_x": m.center_x,
                                "center_y": m.center_y,
                            })
                        })
                        .collect::<Vec<_>>();

                    let input_coords = json!({
                        "kind": "move_to_text",
                        "text_query": text_query,
                        "ocr_region_native": &ocr_region_native,
                        "move_to_text_match_index": move_to_text_match_index,
                    });
                    let body = computer_use_augment_result_json(
                        host_ref,
                        json!({
                            "success": true,
                            "action": "move_to_text",
                            "move_to_text_phase": "move",
                            "text_query": text_query,
                            "ocr_region_native": ocr_region_native,
                            "matched_text": matched.text,
                            "confidence": matched.confidence,
                            "global_center_x": matched.center_x,
                            "global_center_y": matched.center_y,
                            "bounds_left": matched.bounds_left,
                            "bounds_top": matched.bounds_top,
                            "bounds_width": matched.bounds_width,
                            "bounds_height": matched.bounds_height,
                            "total_matches": matches.len(),
                            "move_to_text_match_index": move_to_text_match_index.unwrap_or(1),
                            "other_matches": other_matches,
                        }),
                        Some(input_coords),
                    )
                    .await;
                    let summary = format!(
                        "OCR move_to_text: matched {:?} at ({:.0}, {:.0}) [index {} of {}]. Pointer is from trusted global OCR — you may **`click`** next without a separate **`screenshot`** (host clears stale-capture guard).",
                        matched.text,
                        matched.center_x,
                        matched.center_y,
                        sel + 1,
                        matches.len()
                    );
                    Ok(vec![ToolResult::ok(body, Some(summary))])
                }
            }

            // ---- click: current pointer only; use `mouse_move` / `move_to_text` separately ----
            "click" => {
                Self::ensure_click_has_no_coordinate_fields(input)?;

                let button = input
                    .get("button")
                    .and_then(|v| v.as_str())
                    .unwrap_or("left");
                let num_clicks = input
                    .get("num_clicks")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1)
                    .clamp(1, 3) as u32;

                host_ref.computer_use_guard_click_allowed()?;

                for _ in 0..num_clicks {
                    host_ref.mouse_click_authoritative(button).await?;
                }

                let click_label = match num_clicks {
                    2 => "double",
                    3 => "triple",
                    _ => "single",
                };
                let input_coords = json!({
                    "kind": "click",
                    "button": button,
                    "num_clicks": num_clicks,
                    "at_current_pointer_only": true,
                });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({
                        "success": true,
                        "action": "click",
                        "button": button,
                        "num_clicks": num_clicks,
                    }),
                    Some(input_coords),
                )
                .await;
                let summary = format!(
                    "{} {} click at current pointer only (no move).",
                    button, click_label
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            // ---- mouse_move (absolute pointer move in global screen coordinates) ----
            "mouse_move" => {
                ensure_pointer_move_uses_screen_coordinates_only(input)?;
                let x = req_i32(input, "x")?;
                let y = req_i32(input, "y")?;
                let (sx64, sy64) = Self::resolve_xy_f64(host_ref, input, x, y)?;
                if use_screen_coordinates(input) {
                    ensure_global_xy_on_display(host_ref, sx64, sy64).await?;
                }
                host_ref.mouse_move_global_f64(sx64, sy64).await?;
                let mode = coordinate_mode(input);
                let use_screen = use_screen_coordinates(input);
                let input_coords = json!({
                    "kind": "mouse_move",
                    "raw": { "x": x, "y": y, "coordinate_mode": mode, "use_screen_coordinates": use_screen },
                    "resolved_global": { "x": sx64, "y": sy64 },
                });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({
                        "success": true,
                        "action": "mouse_move",
                        "x": x, "y": y,
                        "pointer_x": sx64.round() as i32,
                        "pointer_y": sy64.round() as i32,
                        "coordinate_mode": mode,
                        "use_screen_coordinates": use_screen,
                    }),
                    Some(input_coords),
                )
                .await;
                let summary = format!(
                    "Moved pointer to (~{}, ~{}).",
                    sx64.round() as i32,
                    sy64.round() as i32
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            // ---- scroll (mouse wheel; optional scroll_x/scroll_y move the pointer first) ----
            "scroll" => {
                let dx = input.get("delta_x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let dy = input.get("delta_y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                if dx == 0 && dy == 0 {
                    return Err(OpenBitFunError::tool(
                        "scroll requires non-zero delta_x and/or delta_y".to_string(),
                    ));
                }
                // Positional scroll: move pointer to target before scrolling.
                let scroll_pos_x = input.get("scroll_x").and_then(|v| v.as_i64());
                let scroll_pos_y = input.get("scroll_y").and_then(|v| v.as_i64());
                if let (Some(sx), Some(sy)) = (scroll_pos_x, scroll_pos_y) {
                    let (gx, gy) = (sx as f64, sy as f64);
                    // Same display-bounds guard as mouse_move/drag: reject
                    // image-pixel coordinates passed as globals.
                    ensure_global_xy_on_display(host_ref, gx, gy).await?;
                    host_ref.mouse_move_global_f64(gx, gy).await?;
                    host_ref.wait_ms(30).await?;
                }
                host_ref.scroll(dx, dy).await?;
                let input_coords = json!({ "kind": "scroll", "delta_x": dx, "delta_y": dy });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({ "success": true, "action": "scroll", "delta_x": dx, "delta_y": dy }),
                    Some(input_coords),
                )
                .await;
                let summary = format!("Scrolled ({}, {}).", dx, dy);
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            // ---- NEW: drag (mouse_down at start + move to end + mouse_up) ----
            "drag" => {
                ensure_pointer_move_uses_screen_coordinates_only(input)?;
                let start_x = req_i32(input, "start_x")?;
                let start_y = req_i32(input, "start_y")?;
                let end_x = req_i32(input, "end_x")?;
                let end_y = req_i32(input, "end_y")?;
                let button = input
                    .get("button")
                    .and_then(|v| v.as_str())
                    .unwrap_or("left");

                let (sx0, sy0) = Self::resolve_xy_f64(host_ref, input, start_x, start_y)?;
                let (sx1, sy1) = Self::resolve_xy_f64(host_ref, input, end_x, end_y)?;

                // Delegate to the host `drag` gesture. The default trait impl
                // composes foreground mouse_down/move/up; desktop hosts override
                // it with background (non-disruptive) drag on macOS/Windows.
                let duration_ms = input
                    .get("duration_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(100);
                host_ref
                    .drag((sx0, sy0), (sx1, sy1), button, duration_ms)
                    .await?;
                ComputerUseHost::computer_use_after_committed_ui_action(host_ref);

                let input_coords = json!({
                    "kind": "drag",
                    "start": { "x": start_x, "y": start_y },
                    "end": { "x": end_x, "y": end_y },
                    "button": button,
                });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({
                        "success": true,
                        "action": "drag",
                        "start_global": { "x": sx0.round() as i32, "y": sy0.round() as i32 },
                        "end_global": { "x": sx1.round() as i32, "y": sy1.round() as i32 },
                        "button": button,
                    }),
                    Some(input_coords),
                )
                .await;
                let summary = format!(
                    "Dragged from (~{}, ~{}) to (~{}, ~{}).",
                    sx0.round() as i32,
                    sy0.round() as i32,
                    sx1.round() as i32,
                    sy1.round() as i32,
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            "screenshot" => {
                // A stale catalog or model can still request an image. Perform
                // a real text observation instead of claiming an empty capture
                // succeeded and waiving verification without any evidence.
                if !context.primary_model_supports_image_understanding() {
                    return Self::describe_screen(host_ref, input, true).await;
                }
                Self::require_multimodal_tool_output_for_screenshot(context)?;
                let control = host_ref.control_snapshot();
                if !control.supported
                    || control
                        .target
                        .as_deref()
                        .is_none_or(|target| target.trim().is_empty())
                {
                    return Err(OpenBitFunError::tool("CAPTURE_REQUIRED: Screenshot requires an authorized capture target. Select an application through the control session; display, crop and navigation hints do not grant capture authority."));
                }
                // The host owns capture authority and the exact pixel/coordinate
                // basis. Presentation neither navigates displays nor fabricates crops.
                let shot = host_ref.screenshot_display(Default::default()).await?;
                host_ref.update_screenshot_hash(hash_screenshot_bytes(&shot.bytes));
                let debug_rel = Self::try_save_screenshot_for_debug(&shot.bytes, context).await;
                let input_coords = json!({"kind":"screenshot", "screenshot_id":shot.screenshot_id});
                let (data, attach, hint) =
                    Self::pack_screenshot_tool_output(&shot, debug_rel, input).await?;
                let data =
                    computer_use_augment_result_json(host_ref, data, Some(input_coords)).await;
                Ok(vec![ToolResult::ok_with_images(
                    data,
                    Some(hint),
                    vec![attach],
                )])
            }

            "pointer_move_rel" => {
                // Accept both `delta_x`/`delta_y` (canonical) and `dx`/`dy` (alias) so that
                // models which guess the natural form do not crash on the schema.
                let dx_alias_used = input.get("delta_x").is_none() && input.get("dx").is_some();
                let dy_alias_used = input.get("delta_y").is_none() && input.get("dy").is_some();
                let dx = input
                    .get("delta_x")
                    .or_else(|| input.get("dx"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let dy = input
                    .get("delta_y")
                    .or_else(|| input.get("dy"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                if dx == 0 && dy == 0 {
                    return Err(OpenBitFunError::tool(
                        "pointer_move_rel requires a non-zero delta. Accepts `delta_x`|`dx` and `delta_y`|`dy` (screen pixels); at least one must be non-zero.".to_string(),
                    ));
                }
                host_ref.pointer_move_relative(dx, dy).await?;
                let alias_note = match (dx_alias_used, dy_alias_used) {
                    (true, true) => Some("dx|dy"),
                    (true, false) => Some("dx"),
                    (false, true) => Some("dy"),
                    (false, false) => None,
                };
                let mut input_coords = json!({
                    "kind": "pointer_move_rel",
                    "delta_x": dx,
                    "delta_y": dy,
                });
                if let Some(a) = alias_note {
                    input_coords["deprecated_alias_used"] = json!(a);
                }
                let mut payload = json!({
                    "success": true,
                    "action": "pointer_move_rel",
                    "delta_x": dx,
                    "delta_y": dy,
                });
                if let Some(a) = alias_note {
                    payload["deprecated_alias_used"] = json!(a);
                }
                let body =
                    computer_use_augment_result_json(host_ref, payload, Some(input_coords)).await;
                let summary = format!(
                    "Moved pointer relatively by ({}, {}) screen pixels.",
                    dx, dy
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }
            "key_chord" => {
                // UX: accept BOTH `keys: ["escape"]` (canonical) AND
                // `keys: "escape"` / `key: "escape"` (common mistakes from
                // the model). The wrong-shape variants are silently
                // coerced — in practice every regression caused by being
                // strict here costs a full round-trip to fix. Genuine
                // missing-keys is reported with an explicit example so
                // the model recovers in one shot.
                let keys: Vec<String> = match input.get("keys") {
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect(),
                    Some(Value::String(s)) => vec![s.to_string()],
                    None => match input.get("key").and_then(|v| v.as_str()) {
                        Some(s) => vec![s.to_string()],
                        None => {
                            return Err(coded_tool_error(ErrorCode::InvalidParams, "key_chord requires `keys` as a JSON array of key names\nHints: example { \"keys\": [\"command\", \"v\"] } | for a single key { \"keys\": [\"return\"] } | use lowercase canonical names: command, control, option, shift, return, escape, tab, space, delete, arrow_up/down/left/right, f1..f12"));
                        }
                    },
                    _ => {
                        return Err(coded_tool_error(ErrorCode::InvalidParams, "key_chord `keys` must be a string or array of strings\nHints: example { \"keys\": [\"command\", \"v\"] }"));
                    }
                };
                if keys.is_empty() {
                    return Err(coded_tool_error(ErrorCode::InvalidParams, "key_chord `keys` must not be empty\nHints: example { \"keys\": [\"return\"] }"));
                }
                host_ref.key_chord(keys.clone()).await?;
                let input_coords = json!({ "kind": "key_chord", "keys": keys });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({ "success": true, "action": "key_chord", "keys": keys }),
                    Some(input_coords),
                )
                .await;
                let summary = "Key chord sent.".to_string();
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }
            "type_text" => {
                let text = input
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| OpenBitFunError::tool("text is required".to_string()))?;
                host_ref.type_text(text).await?;
                let input_coords =
                    json!({ "kind": "type_text", "char_count": text.chars().count() });
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({ "success": true, "action": "type_text", "chars": text.chars().count() }),
                    Some(input_coords),
                )
                .await;
                let summary = format!(
                    "Typed {} character(s) into the focused target.",
                    text.chars().count()
                );
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }
            "wait" => {
                let ms = input
                    .get("ms")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| OpenBitFunError::tool("ms is required".to_string()))?;
                host_ref.wait_ms(ms).await?;
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({ "success": true, "action": "wait", "ms": ms }),
                    None,
                )
                .await;
                Ok(vec![ToolResult::ok(
                    body,
                    Some(format!("Waited {} ms.", ms)),
                )])
            }
            "open_app" => {
                let app_name = input
                    .get("app_name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        OpenBitFunError::tool("open_app requires `app_name` parameter.".to_string())
                    })?;
                let result = host_ref.open_app(app_name).await?;
                // A live process with zero windows is the one launch outcome
                // that looks like success but leaves nothing to act on. Name it
                // explicitly and say what to do, rather than letting the agent
                // rediscover it through a chain of failing AX queries.
                let windowless = result.success && result.window_count == Some(0);
                let next_step = if windowless {
                    Some(format!(
                        "'{}' is running (PID {}) but owns no window, so there is nothing on screen to click. \
The host already retried via `open -b`. Re-run `open_app`, or ask the user to open the app's main window (e.g. from its Dock icon). \
Do not fall back to screen-coordinate clicks — there is no window to hit.",
                        result.app_name,
                        result
                            .process_id
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| "?".to_string()),
                    ))
                } else {
                    None
                };
                let body = computer_use_augment_result_json(
                    host_ref,
                    json!({
                        "success": result.success,
                        "action": "open_app",
                        "app_name": result.app_name,
                        "process_id": result.process_id,
                        "error_message": result.error_message,
                        // Address the app by `bundle_id` from here on: the name
                        // used to launch it, its executable name and its bundle
                        // id are often three different strings.
                        "bundle_id": result.bundle_id,
                        "process_name": result.process_name,
                        "window_count": result.window_count,
                        "launch_path": result.launch_path,
                        "windowless": windowless,
                        "next_step": next_step,
                    }),
                    None,
                )
                .await;
                let summary = if !result.success {
                    format!(
                        "Failed to open '{}': {}",
                        result.app_name,
                        result.error_message.as_deref().unwrap_or("unknown error")
                    )
                } else if windowless {
                    format!(
                        "Opened '{}'{} but it has NO window — nothing is on screen to act on.",
                        result.app_name,
                        result
                            .process_id
                            .map(|p| format!(" (PID {})", p))
                            .unwrap_or_default()
                    )
                } else {
                    format!(
                        "Opened app '{}'{}{}.",
                        result.app_name,
                        result
                            .process_id
                            .map(|p| format!(" (PID {})", p))
                            .unwrap_or_default(),
                        result
                            .window_count
                            .map(|n| format!(", {} window(s)", n))
                            .unwrap_or_default()
                    )
                };
                Ok(vec![ToolResult::ok(body, Some(summary))])
            }

            "run_apple_script" => {
                let script = input
                    .get("script")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        OpenBitFunError::tool(
                            "run_apple_script requires `script` parameter.".to_string(),
                        )
                    })?;
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = script;
                    return Err(OpenBitFunError::tool(
                        "run_apple_script is only available on macOS.".to_string(),
                    ));
                }
                #[cfg(target_os = "macos")]
                {
                    let script_owned = script.to_string();
                    let output = tokio::task::spawn_blocking(move || {
                        std::process::Command::new("/usr/bin/osascript")
                            .args(["-e", &script_owned])
                            .output()
                    })
                    .await
                    .map_err(|e| OpenBitFunError::tool(format!("spawn: {}", e)))?
                    .map_err(|e| OpenBitFunError::tool(format!("osascript: {}", e)))?;

                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let success = output.status.success();

                    let body = computer_use_augment_result_json(
                        host_ref,
                        json!({
                            "success": success,
                            "action": "run_apple_script",
                            "stdout": stdout,
                            "stderr": stderr,
                        }),
                        None,
                    )
                    .await;
                    let summary = if success {
                        format!(
                            "AppleScript executed.{}",
                            if stdout.is_empty() {
                                String::new()
                            } else {
                                format!(
                                    " Output: {}",
                                    crate::util::truncate_at_char_boundary(&stdout, 200)
                                )
                            }
                        )
                    } else {
                        format!(
                            "AppleScript error: {}",
                            crate::util::truncate_at_char_boundary(&stderr, 200)
                        )
                    };
                    Ok(vec![ToolResult::ok(body, Some(summary))])
                }
            }

            _ => Err(OpenBitFunError::tool(format!("Unknown action: {}", action))),
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedDesktopTarget {
    source: String,
    x: f64,
    y: f64,
    matched_text: Option<String>,
    matched_role: Option<String>,
    matched_identifier: Option<String>,
    total_matches: Option<u32>,
    selected_match_index: Option<u32>,
    warning: Option<String>,
    ax_error: Option<String>,
}

#[derive(Debug, Clone)]
struct ScreenOcrTextMatch {
    text: String,
    confidence: f32,
    center_x: f64,
    center_y: f64,
    bounds_left: f64,
    bounds_top: f64,
    bounds_width: f64,
    bounds_height: f64,
}

fn req_i32(input: &Value, key: &str) -> OpenBitFunResult<i32> {
    input
        .get(key)
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .ok_or_else(|| OpenBitFunError::tool(format!("{} is required (integer)", key)))
}

#[cfg(test)]
mod tests {
    use super::{
        clip_tree_text, ComputerUseTool, APP_STATE_TREE_TEXT_MAX_BYTES,
        DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES,
    };
    use crate::agentic::tools::computer_use_host::{
        ComputerScreenshot, ComputerUseForegroundApplication, ComputerUseHost,
        ComputerUsePermissionSnapshot, ComputerUseScreenshotParams, ComputerUseSessionSnapshot,
    };
    use crate::agentic::tools::framework::{Tool, ToolExposure, ToolResult, ToolUseContext};
    use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
    use serde_json::{json, Value};

    #[test]
    fn computer_use_is_direct_by_default() {
        assert_eq!(
            ComputerUseTool::new().default_exposure(),
            ToolExposure::Direct
        );
    }

    #[test]
    fn computer_use_permission_resource_identifies_action_and_safe_target() {
        let tool = ComputerUseTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        let intents = tool
            .permission_intents(
                &json!({
                    "action": "open_app",
                    "app_name": "Visual Studio Code",
                    "text": "secret text must not be projected",
                    "script": "secret script must not be projected"
                }),
                &context,
            )
            .expect("permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "computer_use");
        assert_eq!(
            intents[0].resources,
            ["open_app:app_name=Visual Studio Code".to_string()]
        );
        assert!(!intents[0].resources[0].contains("secret"));
    }

    fn action_enum(schema: &Value) -> Vec<String> {
        schema
            .get("properties")
            .and_then(|p| p.get("action"))
            .and_then(|a| a.get("enum"))
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Text-only schema must NOT advertise `screenshot` (hard-rejected at runtime)
    /// but MUST advertise `describe_screen` (the text-only observe action).
    #[test]
    fn text_only_schema_omits_screenshot_and_offers_describe_screen() {
        let schema = ComputerUseTool::input_schema_text_only();
        let actions = action_enum(&schema);
        assert!(
            !actions.iter().any(|a| a == "screenshot"),
            "text-only schema must not list `screenshot` — it is rejected for text-only models. Got: {:?}",
            actions
        );
        assert!(
            actions.iter().any(|a| a == "describe_screen"),
            "text-only schema must list `describe_screen` as the observe action. Got: {:?}",
            actions
        );
    }

    /// Full (visual) schema keeps `screenshot` and also offers `describe_screen`.
    #[test]
    fn full_schema_keeps_screenshot_and_offers_describe_screen() {
        let schema = ComputerUseTool::new().input_schema();
        let actions = action_enum(&schema);
        assert!(actions.iter().any(|a| a == "screenshot"));
        assert!(actions.iter().any(|a| a == "describe_screen"));
    }

    #[test]
    fn screenshot_admission_includes_gemini_and_rejects_nonvisual_models() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        for (format, vision, allowed) in [
            ("gemini", true, true),
            ("gemini", false, false),
            ("unknown", true, false),
        ] {
            context.primary_model_facts =
                tool_runtime::context::PrimaryModelFacts::new("m", "m", format, vision);
            assert_eq!(
                ComputerUseTool::require_multimodal_tool_output_for_screenshot(&context).is_ok(),
                allowed
            );
        }
    }

    #[tokio::test]
    async fn model_schema_is_compact_and_capability_scoped_without_removing_legacy_calls() {
        let tool = ComputerUseTool::new();
        let legacy = tool.input_schema();
        let visual = tool.input_schema_for_model_with_context(None).await;
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.primary_model_facts =
            tool_runtime::context::PrimaryModelFacts::new("m", "m", "anthropic", false);
        let textual = tool
            .input_schema_for_model_with_context(Some(&context))
            .await;
        assert!(visual.to_string().len() < legacy.to_string().len() / 2);
        for schema in [&visual, &textual] {
            let actions = action_enum(schema);
            for current in [
                "app_batch",
                "open_app",
                "click",
                "key_chord",
                "type_text",
                "scroll",
            ] {
                assert!(actions.iter().any(|action| action == current));
            }
            for legacy_action in [
                "run_script",
                "run_apple_script",
                "paste",
                "interactive_click",
            ] {
                assert!(!actions.iter().any(|action| action == legacy_action));
                assert!(action_enum(&legacy)
                    .iter()
                    .any(|action| action == legacy_action));
            }
            assert_eq!(schema["additionalProperties"], false);
            assert_eq!(schema["properties"]["app"]["type"], "object");
            assert!(schema["properties"].get("script").is_none());
        }
        for hidden in [
            "image_xy",
            "image_grid",
            "visual_grid",
            "screen_xy",
            "screenshot_id",
            "app_drag",
        ] {
            assert!(
                !textual.to_string().contains(hidden),
                "text-only leaked {hidden}"
            );
        }
        // Every required global drag argument must survive the compact schema;
        // additionalProperties=false otherwise makes valid runtime calls impossible.
        for key in ["start_x", "start_y", "end_x", "end_y"] {
            assert_eq!(visual["properties"][key]["type"], "integer");
            assert!(textual["properties"].get(key).is_none());
        }
        assert_eq!(visual["properties"]["num_clicks"]["maximum"], 3);
        let click = &visual["properties"]["steps"]["items"]["oneOf"][0];
        assert!(click["required"]
            .as_array()
            .unwrap()
            .contains(&json!("target")));
        let targets = click["properties"]["target"]["oneOf"].as_array().unwrap();
        let image = targets
            .iter()
            .find(|target| target["properties"]["kind"]["enum"][0] == "image_xy")
            .unwrap();
        assert_eq!(
            image["required"],
            json!(["kind", "x", "y", "screenshot_id"])
        );
        // Optional export permits a real Draft 2020-12 validator in focused QA
        // without adding a schema-validation dependency to the runtime.
        if let Ok(directory) = std::env::var("OPENBITFUN_SCHEMA_TEST_OUTPUT") {
            std::fs::write(
                std::path::Path::new(&directory).join("legacy.json"),
                legacy.to_string(),
            )
            .unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join("visual.json"),
                visual.to_string(),
            )
            .unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join("text.json"),
                textual.to_string(),
            )
            .unwrap();
        }
    }

    /// Text-only tool description must steer the model to `describe_screen` and
    /// away from `screenshot`.
    #[test]
    fn text_only_description_steers_to_describe_screen() {
        let desc = ComputerUseTool::description_text_only();
        assert!(desc.contains("describe_screen"));
        assert!(desc.to_lowercase().contains("do not"));
    }

    fn property_keys(schema: &Value) -> std::collections::BTreeSet<String> {
        schema
            .get("properties")
            .and_then(|p| p.as_object())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Every field in [`ComputerUseTool::shared_action_properties`] must appear,
    /// byte-identical, in both the full and text-only schemas. This is the
    /// invariant the shared-properties extraction exists to protect: if someone
    /// edits a "shared" field only in one schema override block, it stops being
    /// shared and this test should fail loudly instead of the drift going
    /// unnoticed.
    #[test]
    fn shared_action_properties_are_identical_in_both_schemas() {
        let shared = ComputerUseTool::shared_action_properties();
        let shared_map = shared.as_object().expect("shared properties is an object");
        assert!(
            !shared_map.is_empty(),
            "shared_action_properties should not be empty"
        );

        let full = ComputerUseTool::new().input_schema();
        let text_only = ComputerUseTool::input_schema_text_only();

        for (key, expected) in shared_map {
            assert_eq!(
                full.get("properties").and_then(|p| p.get(key)),
                Some(expected),
                "shared property `{key}` diverged in the full schema"
            );
            assert_eq!(
                text_only.get("properties").and_then(|p| p.get(key)),
                Some(expected),
                "shared property `{key}` diverged in the text-only schema"
            );
        }
    }

    #[tokio::test]
    async fn screenshot_rejects_unauthorized_host_before_capture() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.computer_use_host = Some(Arc::new(GuardRecordingHost::default()));
        context.primary_model_facts.supports_image_inputs = true;
        context.primary_model_facts.api_format = "anthropic".into();
        let error = ComputerUseTool::new()
            .call_controlled(
                &json!({
                    "action":"screenshot", "window":false, "screenshot_reset_navigation":true
                }),
                &context,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("CAPTURE_REQUIRED"), "{error}");
    }

    #[tokio::test]
    async fn screenshot_projection_preserves_native_frame_without_navigation() {
        use super::B64;
        use base64::Engine as _;
        // Legacy DTO fields remain readable, but cannot turn a window frame
        // into a full-display/quadrant instruction or modify its pixels.
        let shot: ComputerScreenshot = serde_json::from_value(json!({
            "screenshot_id":"window-frame-17", "bytes":[1,2,3,4], "mime_type":"image/png",
            "image_width":640,"image_height":480,"native_width":1280,"native_height":960,
            "display_origin_x":-1440,"display_origin_y":40,"vision_scale":0.5,
            "image_content_rect":{"left":0,"top":0,"width":640,"height":480},
            "image_global_bounds":{"left":-1200.0,"top":120.0,"width":640.0,"height":480.0},
            "quadrant_navigation_click_ready":true,
            "navigation_native_rect":{"x0":0,"y0":0,"width":1280,"height":960}
        }))
        .unwrap();
        let (body, attachment, hint) = ComputerUseTool::pack_screenshot_tool_output(
            &shot,
            None,
            &json!({"action":"screenshot"}),
        )
        .await
        .unwrap();
        assert_eq!(B64.decode(attachment.data_base64).unwrap(), shot.bytes);
        assert_eq!(attachment.mime_type, "image/png");
        assert_eq!(body["screenshot_id"], "window-frame-17");
        assert_eq!(body["native_width"], 1280);
        assert_eq!(body["image_width"], 640);
        assert_eq!(body["image_global_bounds"]["left"], -1200.0);
        for removed in [
            "hierarchical_navigation",
            "navigation_native_rect",
            "quadrant_navigation_click_ready",
            "recommended_next_for_click_targeting",
            "display_width_px",
        ] {
            assert!(body.get(removed).is_none(), "obsolete field {removed}");
        }
        assert!(body.get("compatibility").is_none());
        assert!(!hint.contains("full display") && !hint.contains("quadrant"));
        let (legacy, legacy_attachment, _) = ComputerUseTool::pack_screenshot_tool_output(
            &shot,
            None,
            &json!({
                "screenshot_navigate_quadrant":"top_left", "screenshot_crop_center_x":999999,
                "screenshot_crop_center_y":-1, "screenshot_reset_navigation":true, "window":false
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            legacy["compatibility"]["ignored_fields"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(legacy["image_global_bounds"], body["image_global_bounds"]);
        assert_eq!(
            B64.decode(legacy_attachment.data_base64).unwrap(),
            shot.bytes
        );
    }

    #[test]
    fn schemas_do_not_advertise_ignored_screenshot_inputs() {
        let full = property_keys(&ComputerUseTool::new().input_schema());
        let text = property_keys(&ComputerUseTool::input_schema_text_only());
        for field in [
            "screenshot_window",
            "window",
            "screenshot_crop_center_x",
            "screenshot_crop_center_y",
            "screenshot_crop_half_extent_native",
            "screenshot_navigate_quadrant",
            "screenshot_reset_navigation",
            "screenshot_implicit_center",
        ] {
            assert!(
                !full.contains(field) && !text.contains(field),
                "ignored field {field}"
            );
        }
    }

    /// Visual-only actions must not be advertised to text-only models: their
    /// results are marked-up screenshots, and `interactive_type_text` /
    /// `interactive_scroll` address elements by the `i` index of a view only a
    /// vision-capable model can build. Their parameters go with them.
    #[test]
    fn visual_only_actions_are_absent_from_text_only_schema() {
        let full_actions = action_enum(&ComputerUseTool::new().input_schema());
        let text_only_actions = action_enum(&ComputerUseTool::input_schema_text_only());
        for action in [
            "build_interactive_view",
            "interactive_click",
            "build_visual_mark_view",
            "visual_click",
            "interactive_type_text",
            "interactive_scroll",
        ] {
            assert!(
                full_actions.iter().any(|a| a == action),
                "full schema should list `{action}`"
            );
            assert!(
                !text_only_actions.iter().any(|a| a == action),
                "text-only schema should NOT list `{action}`"
            );
        }
        let text_only_keys = property_keys(&ComputerUseTool::input_schema_text_only());
        assert!(
            !text_only_keys.contains("opts"),
            "`opts` only configures the removed view-building actions"
        );
        assert!(
            !text_only_keys.contains("i"),
            "`i` indexes a view no text-only action can build"
        );
        let full_keys = property_keys(&ComputerUseTool::new().input_schema());
        assert!(full_keys.contains("opts"));
        assert!(full_keys.contains("i"));
    }

    #[test]
    fn app_target_and_wait_schema_examples_deserialize_into_host_contracts() {
        use crate::agentic::tools::computer_use_host::{AppWaitPredicate, ClickTarget};
        let shared = ComputerUseTool::shared_action_properties();
        for key in ["target", "focus", "predicate"] {
            let variants = shared[key]["oneOf"]
                .as_array()
                .expect("tagged alternatives");
            let mut kinds = std::collections::BTreeSet::new();
            for variant in variants {
                if variant["type"] == "null" {
                    continue;
                }
                let example = &variant["examples"][0];
                let kind = example["kind"].as_str().unwrap();
                assert!(kinds.insert(kind), "each tag must select one schema branch");
                assert_eq!(variant["properties"]["kind"]["enum"][0], kind);
                for required in variant["required"].as_array().unwrap() {
                    assert!(example.get(required.as_str().unwrap()).is_some());
                }
                for field in example.as_object().unwrap().keys() {
                    assert!(variant["properties"].get(field).is_some());
                }
                if key == "predicate" {
                    serde_json::from_value::<AppWaitPredicate>(example.clone())
                        .expect("predicate example matches serde");
                } else {
                    serde_json::from_value::<ClickTarget>(example.clone())
                        .expect("target example matches serde");
                }
            }
            assert_eq!(kinds.len(), if key == "predicate" { 4 } else { 6 });
        }
        assert!(
            serde_json::from_value::<ClickTarget>(json!({"kind":"node_idx","node_idx":3})).is_err()
        );
        assert!(
            serde_json::from_value::<ClickTarget>(json!({"kind":"ocr_text","text":"Search"}))
                .is_err()
        );
        assert!(serde_json::from_value::<AppWaitPredicate>(
            json!({"kind":"title_contains","text":"Sent"})
        )
        .is_err());
        for schema in [
            ComputerUseTool::new().input_schema(),
            ComputerUseTool::input_schema_text_only(),
        ] {
            let fields = schema["properties"].as_object().unwrap();
            for key in [
                "app",
                "target",
                "text",
                "focus",
                "dx",
                "dy",
                "predicate",
                "timeout_ms",
                "poll_ms",
                "focus_window_only",
            ] {
                assert!(fields.contains_key(key), "missing app action field: {key}");
            }
        }
    }

    /// Descriptions and schema hints are both model-visible. A background
    /// workflow must not be contradicted by scripts-first or focus-switching
    /// advice in the action property, including for text-only models.
    #[tokio::test]
    async fn descriptions_and_schemas_preserve_background_observation_workflow() {
        let tool = ComputerUseTool::new();
        let full_description = tool.description().await.expect("description");
        let text_only_description = ComputerUseTool::description_text_only();
        let full_schema = tool.input_schema();
        let text_only_schema = ComputerUseTool::input_schema_text_only();
        let full_action = full_schema["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        let text_only_action = text_only_schema["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        for blob in [
            full_description.as_str(),
            text_only_description.as_str(),
            full_action,
            text_only_action,
        ] {
            assert!(blob.contains("background"));
            assert!(blob.contains("get_app_state"));
            assert!(blob.contains("app_click"));
            assert!(blob.contains("stop_control"));
            assert!(blob.contains("ExecCommand"));
            for obsolete in [
                "Bash",
                "commands first",
                "first**",
                "always allowed",
                "Only when above fail",
                "never derive mouse coordinates from screenshots",
            ] {
                assert!(!blob.contains(obsolete), "obsolete instruction: {obsolete}");
            }
        }
        assert!(full_action.contains("image_xy/image_grid"));
        assert!(full_action.contains("screenshot_id"));
        assert!(text_only_action.contains("AX/OCR facts"));
        assert!(!text_only_schema["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "screenshot"));
    }

    /// Chromium foreground fixture whose native input always reports failure.
    #[derive(Debug)]
    struct ChromeForegroundHost;

    fn not_expected<T>() -> OpenBitFunResult<T> {
        Err(OpenBitFunError::tool(
            "not expected to be called in this test".to_string(),
        ))
    }

    #[async_trait::async_trait]
    impl ComputerUseHost for ChromeForegroundHost {
        async fn permission_snapshot(&self) -> OpenBitFunResult<ComputerUsePermissionSnapshot> {
            not_expected()
        }
        async fn request_accessibility_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn request_screen_capture_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn screenshot_display(
            &self,
            _params: ComputerUseScreenshotParams,
        ) -> OpenBitFunResult<ComputerScreenshot> {
            not_expected()
        }
        fn map_image_coords_to_pointer(&self, _x: i32, _y: i32) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        fn map_normalized_coords_to_pointer(
            &self,
            _x: i32,
            _y: i32,
        ) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        async fn mouse_move(&self, _x: i32, _y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn pointer_move_relative(&self, _dx: i32, _dy: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn mouse_click(&self, _button: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn scroll(&self, _delta_x: i32, _delta_y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn key_chord(&self, _keys: Vec<String>) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn type_text(&self, _text: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn wait_ms(&self, _ms: u64) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn computer_use_session_snapshot(&self) -> ComputerUseSessionSnapshot {
            ComputerUseSessionSnapshot {
                foreground_application: Some(ComputerUseForegroundApplication {
                    name: Some("Google Chrome".to_string()),
                    bundle_id: Some("com.google.Chrome".to_string()),
                    process_name: Some("Google Chrome".to_string()),
                    process_id: Some(4242),
                }),
                pointer_global: None,
            }
        }
    }

    /// Host that records whether the stale-capture guard was waived, and
    /// reports no frontmost app so `describe_screen` exercises its
    /// nothing-to-observe branch.
    #[derive(Debug, Default)]
    struct GuardRecordingHost {
        waived: std::sync::atomic::AtomicBool,
        observing: bool,
        control_supported: bool,
        human_foreground: bool,
        observed_selectors:
            std::sync::Mutex<Vec<crate::agentic::tools::computer_use_host::AppSelector>>,
    }

    #[async_trait::async_trait]
    impl ComputerUseHost for GuardRecordingHost {
        async fn permission_snapshot(&self) -> OpenBitFunResult<ComputerUsePermissionSnapshot> {
            not_expected()
        }
        async fn request_accessibility_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn request_screen_capture_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn screenshot_display(
            &self,
            _params: ComputerUseScreenshotParams,
        ) -> OpenBitFunResult<ComputerScreenshot> {
            not_expected()
        }
        fn map_image_coords_to_pointer(&self, _x: i32, _y: i32) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        fn map_normalized_coords_to_pointer(
            &self,
            _x: i32,
            _y: i32,
        ) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        async fn mouse_move(&self, _x: i32, _y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn pointer_move_relative(&self, _dx: i32, _dy: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn mouse_click(&self, _button: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn scroll(&self, _delta_x: i32, _delta_y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn key_chord(&self, _keys: Vec<String>) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn type_text(&self, _text: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn wait_ms(&self, _ms: u64) -> OpenBitFunResult<()> {
            not_expected()
        }
        fn control_snapshot(&self) -> crate::agentic::tools::computer_use_host::ControlSnapshot {
            crate::agentic::tools::computer_use_host::ControlSnapshot {
                supported: self.control_supported,
                target: self.control_supported.then(|| "pid:421/window:22".into()),
                ..Default::default()
            }
        }
        async fn computer_use_session_snapshot(&self) -> ComputerUseSessionSnapshot {
            ComputerUseSessionSnapshot {
                foreground_application: self.human_foreground.then(|| {
                    ComputerUseForegroundApplication {
                        name: Some("Human Editor".into()),
                        bundle_id: Some("example.human-editor".into()),
                        process_name: Some("Human Editor".into()),
                        process_id: Some(999),
                    }
                }),
                pointer_global: None,
            }
        }
        async fn get_app_state(
            &self,
            app: crate::agentic::tools::computer_use_host::AppSelector,
            _max_depth: u32,
            _focus_window_only: bool,
        ) -> OpenBitFunResult<crate::agentic::tools::computer_use_host::AppStateSnapshot> {
            self.observed_selectors.lock().unwrap().push(app);
            if !self.observing {
                return not_expected();
            }
            Ok(serde_json::from_value(json!({
                "app": {"name":"Target Chat","pid":421,"running":true},
                "window_title":"Target conversation",
                "tree_text":"AX_WINDOW_CONTENT_UNAVAILABLE: window chrome only",
                "digest":"fixture-target-digest","captured_at_ms":1
            }))
            .unwrap())
        }
        async fn read_screen_text(
            &self,
        ) -> OpenBitFunResult<Vec<crate::agentic::tools::computer_use_host::OcrTextMatch>> {
            if !self.observing {
                return not_expected();
            }
            Ok(vec![
                crate::agentic::tools::computer_use_host::OcrTextMatch {
                    text: "已发送测试消息".into(),
                    confidence: 0.98,
                    center_x: 150.0,
                    center_y: 210.0,
                    bounds_left: 100.0,
                    bounds_top: 200.0,
                    bounds_width: 100.0,
                    bounds_height: 20.0,
                },
            ])
        }
        fn computer_use_waive_fresh_capture_guard(&self) {
            self.waived.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn text_only_context(
        host: std::sync::Arc<GuardRecordingHost>,
    ) -> (ToolUseContext, std::sync::Arc<GuardRecordingHost>) {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.primary_model_facts =
            tool_runtime::context::PrimaryModelFacts::new("m", "m", "anthropic", false);
        context.computer_use_host = Some(host.clone());
        (context, host)
    }

    #[tokio::test]
    async fn text_only_observation_does_not_waive_guard_without_ax_or_ocr_content() {
        for action in ["screenshot", "describe_screen"] {
            let (context, host) =
                text_only_context(std::sync::Arc::new(GuardRecordingHost::default()));
            let results = ComputerUseTool::new()
                .call_impl(&json!({"action":action}), &context)
                .await
                .expect("observation reports its unavailable content");
            assert!(
                !host.waived.load(std::sync::atomic::Ordering::SeqCst),
                "{action} must not waive the guard without observing content"
            );
            let body = results[0].content();
            assert_eq!(body["ax_tree_status"], "no_foreground_app");
            assert_ne!(body["ocr_status"], "ok");
        }
    }

    #[tokio::test]
    async fn describe_screen_uses_explicit_or_bound_target_and_delivers_ocr_to_model() {
        for explicit in [true, false] {
            for action in ["describe_screen", "screenshot"] {
                let (mut context, host) =
                    text_only_context(std::sync::Arc::new(GuardRecordingHost {
                        observing: true,
                        control_supported: !explicit,
                        human_foreground: true,
                        ..Default::default()
                    }));
                context.session_id = Some("observation-test".into());
                let mut input = json!({"action":action});
                if explicit {
                    input["app"] = json!({"pid":421});
                }
                let results = ComputerUseTool::new()
                    .call_impl(&input, &context)
                    .await
                    .expect("target observation");
                let selectors = host.observed_selectors.lock().unwrap();
                assert_eq!(selectors.len(), 1);
                assert_eq!(selectors[0].pid, explicit.then_some(421));
                assert!(selectors[0].name.is_none());
                assert!(selectors[0].bundle_id.is_none());
                assert!(
                    host.waived.load(std::sync::atomic::Ordering::SeqCst),
                    "real OCR observation can satisfy the text-only guard"
                );
                let crate::agentic::tools::framework::ToolResult::Result {
                    data,
                    result_for_assistant: Some(text),
                    image_attachments,
                } = &results[0]
                else {
                    panic!("complete model observation expected");
                };
                assert_eq!(data["target_application"]["pid"], 421);
                assert_eq!(data["ax_tree_status"], "content_unavailable");
                assert_eq!(data["ocr_status"], "ok");
                assert!(text.contains("已发送测试消息"));
                assert!(text.contains("bounds_left"));
                assert!(text.contains("Target Chat"));
                assert!(
                    image_attachments
                        .as_ref()
                        .is_none_or(|images| images.is_empty()),
                    "text-only observation must not send image bytes"
                );
            }
        }
    }

    #[test]
    fn tree_text_under_the_cap_is_returned_verbatim() {
        let small = "[0] AXApplication\n  [1] AXWindow\n".to_string();
        assert_eq!(
            clip_tree_text(small.clone(), DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES),
            small
        );
    }

    /// Both caps must actually bound the payload. `get_app_state` is allowed a
    /// larger tree than a routine `describe_screen` because it is an explicit
    /// request for one, but "larger" is not "unbounded" — an uncapped
    /// `get_app_state` measured 390 KB on a real Electron app, roughly 100k
    /// tokens for a single look.
    #[test]
    fn both_ax_tree_caps_bound_the_payload() {
        let line = "[0] AXButton title=\"x\" frame=(0,0,10x10)\n";
        let huge = line.repeat(APP_STATE_TREE_TEXT_MAX_BYTES / line.len() + 5_000);
        for cap in [
            DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES,
            APP_STATE_TREE_TEXT_MAX_BYTES,
        ] {
            let out = clip_tree_text(huge.clone(), cap);
            assert!(out.contains("[truncated]"), "cap={cap}");
            let body = out.split("\n[truncated]").next().unwrap();
            assert!(
                body.len() <= cap,
                "cap={cap} but kept {} bytes of tree",
                body.len()
            );
        }
    }

    /// Truncation must announce itself. An agent that reads a clipped tree as
    /// the whole UI concludes a control does not exist and gives up on it.
    #[test]
    fn oversized_tree_text_is_clipped_on_a_line_boundary_and_says_so() {
        let line = "[0] AXButton title=\"x\" frame=(0,0,10x10)\n";
        let big = line.repeat(DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES / line.len() + 500);
        let out = clip_tree_text(big.clone(), DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES);

        assert!(out.len() < big.len(), "must actually shrink");
        assert!(
            out.contains("[truncated]"),
            "must announce the clip: {out:.200}"
        );
        assert!(
            out.contains("not the end of the UI"),
            "must warn that a missing control may still exist"
        );
        // Cutting mid-line would hand the model a malformed node.
        let body = out.split("\n[truncated]").next().unwrap();
        assert!(
            body.lines()
                .all(|l| l.is_empty() || l.starts_with("[0] AXButton")),
            "clip must land on a line boundary"
        );
    }

    /// The cap is a byte count but the tree is a `str`, so the clip has to land
    /// on a char boundary. A CJK app — exactly the kind whose tree gets large —
    /// would otherwise panic the whole tool call on a mid-character slice.
    #[test]
    fn oversized_cjk_tree_text_clips_without_panicking() {
        for label in ["范明裕", "飞书 · 消息", "🙂 emoji", "混合 mixed 内容"] {
            let line = format!("[0] AXStaticText title=\"{label}\"\n");
            let big = line.repeat(DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES / line.len() + 500);
            assert!(big.len() > DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES);

            let out = clip_tree_text(big.clone(), DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES);
            assert!(out.contains("[truncated]"), "must announce the clip");
            assert!(out.len() < big.len(), "must actually shrink");
        }
    }

    /// The cut offset must be safe for *every* alignment, not the one a given
    /// repeated line happens to produce.
    ///
    /// Shifting the content by one and two bytes is what makes this bite: a
    /// 3-byte character misaligns against the byte cap at two of every three
    /// offsets, and only those two panic. An unshifted string of `范` lands
    /// exactly on 60_000 and sails through a completely broken implementation —
    /// which is how the first version of this test passed without the fix.
    #[test]
    fn clip_lands_on_a_char_boundary_at_every_alignment() {
        for pad in 0..3 {
            // No newline anywhere, so the cut falls back to the boundary walk
            // rather than being rescued by `rfind('\n')`.
            let mut s = "a".repeat(pad);
            s.push_str(&"范".repeat(DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES / 3 + 10));
            assert!(s.len() > DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES);

            let out = clip_tree_text(s.clone(), DESCRIBE_SCREEN_TREE_TEXT_MAX_BYTES);
            assert!(out.contains("[truncated]"), "pad={pad}");
            let body = out.split("\n[truncated]").next().unwrap();
            assert!(
                body.chars().all(|c| c == 'a' || c == '范'),
                "clip split a character at pad={pad}"
            );
        }
    }

    /// An empty snapshot must say *why* it is empty. A bare `ax_tree_text:
    /// null` reads as truncated tool output, and an agent that believes its
    /// results are being cut off re-issues the same call instead of changing
    /// tactic.
    #[tokio::test]
    async fn describe_screen_explains_an_empty_ax_tree_instead_of_returning_bare_nulls() {
        let (context, _host) =
            text_only_context(std::sync::Arc::new(GuardRecordingHost::default()));
        let results = ComputerUseTool::new()
            .call_impl(&json!({ "action": "describe_screen" }), &context)
            .await
            .expect("describe_screen should succeed");
        let body = results[0].content();
        let data = body.get("data").unwrap_or(&body);
        let crate::agentic::tools::framework::ToolResult::Result {
            result_for_assistant: Some(model_text),
            ..
        } = &results[0]
        else {
            panic!("ComputerUse must provide its complete model observation");
        };
        assert!(model_text.contains("ax_tree_status"));
        assert!(model_text.contains("no_foreground_app"));
        assert!(model_text.contains("output_is_complete"));
        assert!(model_text.contains("ax_tree_note"));
        assert_eq!(
            data.get("ax_tree_status").and_then(Value::as_str),
            Some("no_foreground_app"),
            "status must name the reason the tree is empty: {body}"
        );
        assert_eq!(
            data.get("output_is_complete").and_then(Value::as_bool),
            Some(true),
            "result must assert it is not truncated: {body}"
        );
        let note = data
            .get("ax_tree_note")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            note.contains("list_apps") || note.contains("open_app"),
            "note must offer a concrete next action: {note}"
        );
    }

    /// Chromium foreground presence must not reject a selected native app or
    /// native browser chrome before the actual host dispatch.
    #[tokio::test]
    async fn chromium_identity_does_not_override_desktop_input_scope() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.computer_use_host = Some(Arc::new(ChromeForegroundHost));
        for input in [
            json!({"action":"click"}),
            json!({"action":"app_type_text","app":{"name":"Google Chrome"},"text":"fixture"}),
            json!({"action":"app_type_text","app":{"name":"WeChat"},"text":"fixture"}),
            json!({"action":"app_type_text","text":"fixture"}),
        ] {
            let result = ComputerUseTool::new().call_impl(&input, &context).await;
            // This host refuses native calls. Reaching its error proves the
            // obsolete process-name guard no longer short-circuits dispatch.
            let error = if input["action"] == "click" {
                result
                    .expect_err("fixture host rejects global input")
                    .to_string()
            } else if input.get("app").is_none() {
                let error = result
                    .expect_err("unbound host requires a target selector")
                    .to_string();
                assert!(error.contains("INVALID_PARAMS"), "{error}");
                error
            } else {
                let results = result.expect("app input failure keeps its receipt");
                let ToolResult::Result { data, .. } = &results[0] else {
                    panic!("expected receipt")
                };
                assert_eq!(data["action_status"], "failed");
                assert_eq!(data["input_may_have_been_submitted"], true);
                let error = data["error"].as_str().expect("native error").to_string();
                assert!(error.contains("APP_INPUT_UNSUPPORTED"), "{error}");
                error
            };
            assert!(
                !error.contains("Chromium-family") && !error.contains("browser domain"),
                "{error}"
            );
        }
    }

    /// The `action` enum, description, and a handful of other fields are
    /// deliberately different (richer guidance) between the two schemas. This
    /// test documents that the shared/override split does not silently
    /// collapse them into one shared copy.
    #[test]
    fn capability_specific_fields_may_differ_between_schemas() {
        let full = ComputerUseTool::new().input_schema();
        let text_only = ComputerUseTool::input_schema_text_only();
        assert_ne!(
            full.get("properties").and_then(|p| p.get("action")),
            text_only.get("properties").and_then(|p| p.get("action")),
            "`action` is expected to differ (screenshot presence, tailored guidance)"
        );
    }
    use crate::agentic::tools::computer_use_host::{
        ComputerUseActionLease, ControlMode, ControlSnapshot, ControlStartRequest,
    };
    use std::sync::{Arc, Mutex};

    #[derive(Debug)]
    struct ControlRecordingHost {
        state: Mutex<ControlSnapshot>,
        events: Arc<Mutex<Vec<String>>>,
        wait_started: tokio::sync::Notify,
        fail_capture: bool,
        fail_observation: bool,
        replace_control_during_observation: Option<ControlSnapshot>,
        replace_control_during_input: Option<ControlSnapshot>,
        capture_error: &'static str,
    }
    impl Default for ControlRecordingHost {
        fn default() -> Self {
            Self {
                state: Mutex::new(ControlSnapshot {
                    supported: true,
                    state: "idle".into(),
                    ..Default::default()
                }),
                events: Arc::default(),
                wait_started: tokio::sync::Notify::new(),
                fail_capture: false,
                fail_observation: false,
                replace_control_during_observation: None,
                replace_control_during_input: None,
                capture_error: "TARGET_APP_HIDDEN: no live surface",
            }
        }
    }
    struct RecordingLease {
        events: Arc<Mutex<Vec<String>>>,
        complete: bool,
    }
    impl ComputerUseActionLease for RecordingLease {
        fn complete(&mut self) {
            self.complete = true;
            self.events.lock().unwrap().push("complete".into());
        }
    }
    impl Drop for RecordingLease {
        fn drop(&mut self) {
            self.events.lock().unwrap().push(
                if self.complete {
                    "released"
                } else {
                    "cancelled"
                }
                .into(),
            );
        }
    }
    #[async_trait::async_trait]
    impl ComputerUseHost for ControlRecordingHost {
        async fn dispatch_app_input(
            &self,
            app: crate::agentic::tools::computer_use_host::AppSelector,
            action: crate::agentic::tools::computer_use_host::AppInputAction,
        ) -> OpenBitFunResult<()> {
            assert_eq!(app.pid, Some(421));
            if let crate::agentic::tools::computer_use_host::AppInputAction::Wait { ms } = action {
                return self.wait_ms(ms).await;
            }
            let mut events = self.events.lock().unwrap();
            events.push(format!("input:{}", action.name()));
            if let Some(replacement) = &self.replace_control_during_input {
                *self.state.lock().unwrap() = replacement.clone();
            }
            if matches!(action, crate::agentic::tools::computer_use_host::AppInputAction::TypeText {ref text, ..} if text == "fixture-failure")
            {
                return Err(OpenBitFunError::tool(
                    "FIXTURE_INPUT_FAILURE: target rejected input",
                ));
            }
            Ok(())
        }
        async fn prepare_control_target(
            &self,
            app: crate::agentic::tools::computer_use_host::AppSelector,
        ) -> OpenBitFunResult<()> {
            if self.fail_capture {
                self.events
                    .lock()
                    .unwrap()
                    .push(format!("prepare:{:?}", app.pid));
                return Err(OpenBitFunError::tool(self.capture_error));
            }
            Ok(())
        }
        async fn get_app_state(
            &self,
            app: crate::agentic::tools::computer_use_host::AppSelector,
            _max_depth: u32,
            _focus_window_only: bool,
        ) -> OpenBitFunResult<crate::agentic::tools::computer_use_host::AppStateSnapshot> {
            self.events
                .lock()
                .unwrap()
                .push(format!("observe:{:?}", app.pid));
            assert_eq!(app.pid, Some(421));
            if self.fail_observation {
                return Err(OpenBitFunError::tool("FIXTURE_OBSERVATION_FAILURE"));
            }
            if let Some(replacement) = &self.replace_control_during_observation {
                *self.state.lock().unwrap() = replacement.clone();
            }
            Ok(serde_json::from_value(json!({
                "app":{"name":"Requested target","pid":421,"running":true},
                "tree_text":"AXMenuBar target menu", "digest":"target-ax", "captured_at_ms":1
            }))?)
        }
        async fn get_app_shortcuts(
            &self,
            app: crate::agentic::tools::computer_use_host::AppSelector,
        ) -> OpenBitFunResult<crate::agentic::tools::computer_use_host::AppShortcutsSnapshot>
        {
            self.events
                .lock()
                .unwrap()
                .push(format!("shortcuts:{:?}", app.pid));
            assert_eq!(app.pid, Some(421));
            Ok(serde_json::from_value(json!({
                "app":{"name":"Requested target","pid":421,"running":true},
                "shortcuts":[],"captured_at_ms":1
            }))?)
        }
        fn control_snapshot(&self) -> ControlSnapshot {
            self.state.lock().unwrap().clone()
        }
        async fn start_control(
            &self,
            owner: &str,
            request: ControlStartRequest,
        ) -> OpenBitFunResult<ControlSnapshot> {
            self.events
                .lock()
                .unwrap()
                .push(format!("start:{owner}:{:?}", request.mode));
            let mut state = self.state.lock().unwrap();
            state.generation += 1;
            state.owner = Some(owner.into());
            state.mode = request.mode;
            state.state = "active".into();
            Ok(state.clone())
        }
        async fn stop_control(&self, owner: &str) -> OpenBitFunResult<ControlSnapshot> {
            self.events.lock().unwrap().push(format!("stop:{owner}"));
            let mut state = self.state.lock().unwrap();
            state.generation += 1;
            state.state = "stopped".into();
            Ok(state.clone())
        }
        async fn acquire_control_action(
            &self,
            owner: &str,
            action: &str,
        ) -> OpenBitFunResult<Option<Box<dyn ComputerUseActionLease>>> {
            self.events
                .lock()
                .unwrap()
                .push(format!("acquire:{owner}:{action}"));
            Ok(Some(Box::new(RecordingLease {
                events: self.events.clone(),
                complete: false,
            })))
        }
        async fn permission_snapshot(&self) -> OpenBitFunResult<ComputerUsePermissionSnapshot> {
            not_expected()
        }
        async fn request_accessibility_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn request_screen_capture_permission(&self) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn screenshot_display(
            &self,
            _params: ComputerUseScreenshotParams,
        ) -> OpenBitFunResult<ComputerScreenshot> {
            not_expected()
        }
        fn map_image_coords_to_pointer(&self, _x: i32, _y: i32) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        fn map_normalized_coords_to_pointer(
            &self,
            _x: i32,
            _y: i32,
        ) -> OpenBitFunResult<(i32, i32)> {
            not_expected()
        }
        async fn mouse_move(&self, _x: i32, _y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn pointer_move_relative(&self, _dx: i32, _dy: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn mouse_click(&self, _button: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn scroll(&self, _delta_x: i32, _delta_y: i32) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn key_chord(&self, _keys: Vec<String>) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn type_text(&self, _text: &str) -> OpenBitFunResult<()> {
            not_expected()
        }
        async fn wait_ms(&self, ms: u64) -> OpenBitFunResult<()> {
            self.events.lock().unwrap().push("wait".into());
            self.wait_started.notify_one();
            if ms > 0 {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
        async fn computer_use_session_snapshot(&self) -> ComputerUseSessionSnapshot {
            ComputerUseSessionSnapshot::default()
        }
    }

    fn control_context(host: Arc<ControlRecordingHost>) -> ToolUseContext {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.session_id = Some("control-task".into());
        context.computer_use_host = Some(host);
        context
    }

    #[tokio::test]
    async fn control_entrypoints_route_owner_mode_and_do_not_take_action_leases() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        let tool = ComputerUseTool::new();
        let started = tool
            .call_impl(
                &json!({"action":"start_control","mode":"observe"}),
                &context,
            )
            .await
            .unwrap();
        assert_eq!(started[0].content()["mode"], "observe");
        assert_eq!(host.control_snapshot().mode, ControlMode::Observe);
        let status = tool
            .call_impl(&json!({"action":"control_status"}), &context)
            .await
            .unwrap();
        assert_eq!(status[0].content()["owner"], "control-task");
        let stopped = tool
            .call_impl(&json!({"action":"stop_control"}), &context)
            .await
            .unwrap();
        assert_eq!(stopped[0].content()["state"], "stopped");
        assert_eq!(
            *host.events.lock().unwrap(),
            ["start:control-task:Observe", "stop:control-task"]
        );
    }

    #[tokio::test]
    async fn control_provider_requires_owner_before_any_native_work() {
        let host = Arc::new(ControlRecordingHost::default());
        let mut context = control_context(host.clone());
        context.session_id = None;
        let result = ComputerUseTool::new()
            .call_impl(&json!({"action":"start_control"}), &context)
            .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("CONTROL_OWNER_REQUIRED"));
        assert!(host.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unsupported_host_defaults_never_claim_control_or_stop_success() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.computer_use_host = Some(Arc::new(GuardRecordingHost::default()));
        let tool = ComputerUseTool::new();
        let status = tool
            .call_impl(&json!({"action":"control_status"}), &context)
            .await
            .unwrap();
        assert_eq!(status[0].content()["supported"], false);
        for action in ["start_control", "stop_control"] {
            assert!(tool
                .call_impl(&json!({"action":action}), &context)
                .await
                .unwrap_err()
                .to_string()
                .contains("CONTROL_UNSUPPORTED"));
        }
    }

    #[tokio::test]
    async fn completed_action_releases_lease_without_cancelling_control() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        ComputerUseTool::new()
            .call_impl(&json!({"action":"wait","ms":0}), &context)
            .await
            .unwrap();
        assert_eq!(
            *host.events.lock().unwrap(),
            ["acquire:control-task:wait", "wait", "complete", "released"]
        );
    }

    #[tokio::test]
    async fn dropped_tool_future_drops_unfinished_lease_as_cancellation() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        let tool = ComputerUseTool::new();
        let input = json!({"action":"wait","ms":1});
        let mut future = Box::pin(tool.call_impl(&input, &context));
        tokio::select! {
            _ = host.wait_started.notified() => {},
            result = &mut future => panic!("fixture wait returned unexpectedly: {result:?}"),
        }
        drop(future);
        assert_eq!(
            *host.events.lock().unwrap(),
            ["acquire:control-task:wait", "wait", "cancelled"]
        );
    }

    #[test]
    fn control_permission_exposes_mode_but_never_input_text_or_script() {
        let tool = ComputerUseTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        for (mode, expected) in [
            (Some("foreground"), "start_control:mode=foreground"),
            (None, "start_control:mode=background"),
        ] {
            let mut input =
                json!({"action":"start_control", "text":"private text", "script":"private script"});
            if let Some(mode) = mode {
                input["mode"] = json!(mode);
            }
            let intents = tool.permission_intents(&input, &context).unwrap();
            assert_eq!(intents[0].resources, [expected]);
            assert!(!format!("{:?}", intents[0].resources).contains("private"));
        }
    }
    #[tokio::test]
    async fn capture_failure_preserves_explicit_target_ax_without_claiming_binding() {
        let host = Arc::new(ControlRecordingHost {
            fail_capture: true,
            ..Default::default()
        });
        host.state.lock().unwrap().target = Some("pid:999/window:8".into());
        let context = control_context(host.clone());
        for action in ["get_app_state", "get_app_shortcuts"] {
            let result = ComputerUseTool::new()
                .call_impl(&json!({"action":action,"app":{"pid":421}}), &context)
                .await
                .unwrap();
            let data = result[0].content();
            assert_eq!(data["target_app"]["pid"], 421);
            assert_eq!(data["control_target_available"], false);
            assert_eq!(data["capture_status"], "unavailable");
            assert!(data["capture_preparation_error"]
                .as_str()
                .unwrap()
                .contains("TARGET_APP_HIDDEN"));
            assert_eq!(
                host.control_snapshot().target.as_deref(),
                Some("pid:999/window:8")
            );
        }
        let events = host.events.lock().unwrap();
        assert!(events.iter().any(|e| e == "observe:Some(421)"));
        assert!(events.iter().any(|e| e == "shortcuts:Some(421)"));
    }

    #[tokio::test]
    async fn capture_failure_blocks_input_implicit_target_and_cross_target_observers() {
        let host = Arc::new(ControlRecordingHost {
            fail_capture: true,
            ..Default::default()
        });
        host.state.lock().unwrap().target = Some("pid:999/window:8".into());
        let context = control_context(host.clone());
        for input in [
            json!({"action":"get_app_state","app":{}}),
            json!({"action":"describe_screen","app":{"pid":421}}),
            json!({"action":"app_click","app":{"pid":421},"target":{"kind":"node_idx","node_idx":1}}),
        ] {
            let error = ComputerUseTool::new()
                .call_impl(&input, &context)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("TARGET_APP_HIDDEN"));
        }
        assert!(!host
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.starts_with("observe:") || e.starts_with("shortcuts:")));
        assert_eq!(
            host.control_snapshot().target.as_deref(),
            Some("pid:999/window:8")
        );
    }
    #[tokio::test]
    async fn locked_or_revoked_capture_never_falls_through_to_ax() {
        for capture_error in [
            "SESSION_LOCKED: execution host is locked",
            "[CONTROL_STOPPED] observe cannot continue",
            "CONTROL_OWNER_MISMATCH: another owner",
            "CAPTURE_GENERATION_CHANGED: obsolete generation",
            "CAPTURE_STOPPED: permission revoked",
            "unexpected error containing CAPTURE_TIMEOUT: is not a code",
        ] {
            let host = Arc::new(ControlRecordingHost {
                fail_capture: true,
                capture_error,
                ..Default::default()
            });
            let context = control_context(host.clone());
            for action in ["get_app_state", "get_app_shortcuts"] {
                assert!(ComputerUseTool::new()
                    .call_impl(&json!({"action":action,"app":{"pid":421}}), &context)
                    .await
                    .is_err());
            }
            assert!(!host
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.starts_with("observe:") || e.starts_with("shortcuts:")));
        }
    }

    #[test]
    fn ax_fallback_recognizes_only_explicit_surface_error_codes() {
        for code in [
            "CAPTURE_TIMEOUT",
            "CAPTURE_FRAME_UNAVAILABLE",
            "TARGET_APP_HIDDEN",
            "TARGET_SURFACE_UNAVAILABLE",
            "SCREEN_CAPTURE_PERMISSION_REQUIRED",
        ] {
            assert!(ComputerUseTool::capture_failure_allows_ax_observation(
                &OpenBitFunError::tool(format!("{code}: details"))
            ));
        }
        assert!(!ComputerUseTool::capture_failure_allows_ax_observation(
            &OpenBitFunError::tool("LOCAL_AUTHORIZATION_REQUIRED: approve access")
        ));
    }
    #[tokio::test]
    async fn computer_use_model_combo_example_runs_two_inputs_and_one_final_observation() {
        for vision in [true, false] {
            let tool = ComputerUseTool::new();
            let schema = tool.model_input_schema(vision);
            let steps = schema["properties"]["steps"]["examples"][0].clone();
            let typed: Vec<crate::agentic::tools::computer_use_host::AppInputAction> =
                serde_json::from_value(steps.clone()).unwrap();
            for step in &typed {
                super::super::computer_use_program::validate_step(step).unwrap();
            }
            assert_eq!(typed.len(), 2);
            assert_eq!(steps[0]["action"], "app_type_text");
            assert_eq!(
                steps[0]["focus"]["kind"],
                if vision { "image_xy" } else { "node_idx" }
            );
            let host = Arc::new(ControlRecordingHost::default());
            let context = control_context(host.clone());
            tool.call_impl(
                &json!({"action":"start_control","mode":"background"}),
                &context,
            )
            .await
            .unwrap();
            host.events.lock().unwrap().clear();
            let result = tool
                .call_impl(
                    &json!({"action":"app_batch","app":{"pid":421},"steps":steps}),
                    &context,
                )
                .await
                .unwrap();
            assert_eq!(result[0].content()["completed_steps"], 2);
            let events = host.events.lock().unwrap();
            let inputs: Vec<_> = events
                .iter()
                .filter(|event| event.starts_with("input:"))
                .collect();
            assert_eq!(inputs, vec!["input:app_type_text", "input:app_key_chord"]);
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.starts_with("observe:"))
                    .count(),
                1
            );
            assert!(!events.iter().any(|event| event.contains("foreground")));
        }
    }

    #[tokio::test]
    async fn computer_use_batch_runs_five_inputs_with_one_observation() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        let tool = ComputerUseTool::new();
        tool.call_impl(
            &json!({"action":"start_control","mode":"background"}),
            &context,
        )
        .await
        .unwrap();
        host.events.lock().unwrap().clear();
        let result = tool.call_impl(&json!({"action":"app_batch","app":{"pid":421},"steps":[
            {"action":"app_click","target":{"kind":"image_xy","x":20,"y":30,"screenshot_id":"observed-canvas"}},
            {"action":"app_type_text","text":"exact Unicode 内容"},
            {"action":"app_key_chord","keys":["tab"]},
            {"action":"app_scroll","dy":20},
            {"action":"app_key_chord","keys":["escape"]}
        ]}), &context).await.unwrap();
        let body = result[0].content();
        assert_eq!(body["completed_steps"], 5);
        assert_eq!(body["status"], "submitted");
        let events = host.events.lock().unwrap();
        assert_eq!(events.iter().filter(|e| e.starts_with("input:")).count(), 5);
        assert_eq!(
            events.iter().filter(|e| e.starts_with("observe:")).count(),
            1
        );
        assert!(
            events
                .iter()
                .position(|e| e.starts_with("observe:"))
                .unwrap()
                > events
                    .iter()
                    .rposition(|e| e.starts_with("input:"))
                    .unwrap()
        );
    }

    #[tokio::test]
    async fn computer_use_batch_failure_returns_receipts_without_replay() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        let tool = ComputerUseTool::new();
        tool.call_impl(&json!({"action":"start_control"}), &context)
            .await
            .unwrap();
        let result = tool
            .call_impl(
                &json!({"action":"app_batch","app":{"pid":421},"steps":[
                    {"action":"app_key_chord","keys":["tab"]},
                    {"action":"app_type_text","text":"fixture-failure"},
                    {"action":"app_key_chord","keys":["return"]}
                ]}),
                &context,
            )
            .await
            .unwrap();
        let body = result[0].content();
        assert_eq!(body["status"], "partial");
        assert_eq!(body["completed_steps"], 1);
        assert_eq!(body["steps"].as_array().unwrap().len(), 2);
        assert_eq!(body["steps"][1]["input_may_have_been_submitted"], true);
        assert_eq!(
            host.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| *e == "input:app_key_chord")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn computer_use_batch_validates_all_steps_before_first_input() {
        let host = Arc::new(ControlRecordingHost::default());
        let context = control_context(host.clone());
        let result = ComputerUseTool::new()
            .call_impl(
                &json!({"action":"app_batch","app":{"pid":421},"steps":[
                    {"action":"app_type_text","text":"must not be sent"},
                    {"action":"app_key_chord","keys":[]}
                ]}),
                &context,
            )
            .await;
        assert!(result.is_err());
        assert!(!host
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.starts_with("input:")));
    }

    #[tokio::test]
    async fn computer_use_batch_rejects_invalid_late_visual_targets_before_any_input() {
        for target in [
            json!({"kind":"image_xy","x":4,"y":8}),
            json!({"kind":"image_xy","x":-1,"y":8,"screenshot_id":"seen"}),
            json!({"kind":"image_grid","x0":0,"y0":0,"width":100,"height":100,"rows":2,"cols":2,"row":2,"col":0,"screenshot_id":"seen"}),
            json!({"kind":"ocr_text","needle":"   "}),
        ] {
            for action in ["app_click", "app_type_text", "app_scroll"] {
                let host = Arc::new(ControlRecordingHost::default());
                let context = control_context(host.clone());
                let mut step = json!({"action":action});
                if action == "app_click" {
                    step["target"] = target.clone();
                } else {
                    step["focus"] = target.clone();
                }
                if action == "app_type_text" {
                    step["text"] = json!("must not type");
                }
                let result = ComputerUseTool::new()
                    .call_impl(
                        &json!({"action":"app_batch","app":{"pid":421},"steps":[
                            {"action":"app_key_chord","keys":["return"]}, step
                        ]}),
                        &context,
                    )
                    .await;
                assert!(
                    result.is_err(),
                    "invalid target accepted: {action} {target}"
                );
                assert!(
                    !host
                        .events
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|event| event.starts_with("input:")),
                    "an earlier irreversible action must not run before structural validation"
                );
            }
        }
    }

    #[tokio::test]
    async fn computer_use_legacy_target_overflow_never_wraps_to_another_control() {
        for target in [
            json!({"node_idx":4294967296_u64}),
            json!({"image_xy":{"x":4294967297_i64,"y":2,"screenshot_id":"seen"}}),
            json!({"image_xy":{"x":1,"y":4294967298_i64,"screenshot_id":"seen"}}),
        ] {
            let host = Arc::new(ControlRecordingHost::default());
            let context = control_context(host.clone());
            let result = ComputerUseTool::new()
                .call_impl(
                    &json!({"action":"app_click","app":{"pid":421},"target":target}),
                    &context,
                )
                .await;
            assert!(result.is_err());
            assert!(!host
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event.starts_with("input:")));
        }
    }

    #[test]
    fn computer_use_batch_schema_exposes_explicit_click_settle() {
        let schema = ComputerUseTool::app_program_schema();
        let click = &schema["items"]["oneOf"][0];
        assert_eq!(click["properties"]["wait_ms_after"]["type"], "integer");
        assert_eq!(click["properties"]["wait_ms_after"]["minimum"], 0);
        let step = serde_json::from_value(json!({"action":"app_click","target":{"kind":"image_xy","x":1,"y":2,"screenshot_id":"seen"},"wait_ms_after":25})).unwrap();
        super::super::computer_use_program::validate_step(&step).unwrap();
    }

    #[tokio::test]
    async fn computer_use_program_stops_after_input_changes_control_scope() {
        use crate::agentic::tools::computer_use_host::{AppInputAction, AppSelector};
        let initial = ControlSnapshot {
            supported: true,
            state: "active".into(),
            generation: 17,
            owner: Some("session-a".into()),
            target: Some("window-a".into()),
            mode: ControlMode::Background,
            ..Default::default()
        };
        for change in [
            "stopped",
            "generation",
            "owner",
            "target",
            "mode",
            "unsupported",
        ] {
            let mut replacement = initial.clone();
            match change {
                "stopped" => replacement.state = "stopped".into(),
                "generation" => replacement.generation += 1,
                "owner" => replacement.owner = Some("session-b".into()),
                "target" => replacement.target = Some("window-b".into()),
                "mode" => replacement.mode = ControlMode::Observe,
                "unsupported" => replacement.supported = false,
                _ => unreachable!(),
            }
            // One step isolates the pre-observation guard; two steps also
            // prove a changed scope never executes the next queued mutation.
            for count in [1, 2] {
                let host = ControlRecordingHost {
                    state: Mutex::new(initial.clone()),
                    replace_control_during_input: Some(replacement.clone()),
                    ..Default::default()
                };
                let steps: Vec<AppInputAction> = (0..count)
                    .map(|index| AppInputAction::TypeText {
                        text: format!("fixture-{index}"),
                        focus: None,
                    })
                    .collect();
                let result = super::super::computer_use_program::execute(
                    &host,
                    AppSelector::by_pid(421),
                    steps,
                    None,
                )
                .await;
                assert_eq!(
                    *host.events.lock().unwrap(),
                    ["input:app_type_text"],
                    "{change}/{count}"
                );
                assert!(result.snapshot.is_none(), "{change}/{count}");
                assert_eq!(result.receipt["status"], "cancelled", "{change}/{count}");
                assert_eq!(result.receipt["completed_steps"], 1);
                assert_eq!(result.receipt["requested_steps"], count);
                assert_eq!(result.receipt["steps"].as_array().unwrap().len(), 1);
                assert_eq!(result.receipt["steps"][0]["status"], "submitted");
                assert!(result.receipt["observation_error"]
                    .as_str()
                    .unwrap()
                    .contains("CONTROL_CHANGED_DURING_INPUT"));
            }
        }
        for initially_stopped in [false, true] {
            let mut state = initial.clone();
            if initially_stopped {
                state.state = "stopped".into();
            }
            let host = ControlRecordingHost {
                state: Mutex::new(state),
                ..Default::default()
            };
            let steps = vec![
                AppInputAction::TypeText {
                    text: "first".into(),
                    focus: None,
                },
                AppInputAction::TypeText {
                    text: "second".into(),
                    focus: None,
                },
            ];
            let result = super::super::computer_use_program::execute(
                &host,
                AppSelector::by_pid(421),
                steps,
                None,
            )
            .await;
            if initially_stopped {
                assert!(host.events.lock().unwrap().is_empty());
                assert_eq!(result.receipt["status"], "cancelled");
                assert_eq!(result.receipt["completed_steps"], 0);
                assert!(result.receipt["steps"].as_array().unwrap().is_empty());
                assert!(result.snapshot.is_none());
            } else {
                assert_eq!(
                    *host.events.lock().unwrap(),
                    [
                        "input:app_type_text",
                        "input:app_type_text",
                        "observe:Some(421)"
                    ]
                );
                assert_eq!(result.receipt["status"], "submitted");
                assert_eq!(result.receipt["completed_steps"], 2);
                assert!(result.receipt["observation_error"].is_null());
                assert!(result.snapshot.is_some());
            }
        }
    }

    #[tokio::test]
    async fn computer_use_recovery_discards_observation_after_control_scope_changes() {
        let initial = ControlSnapshot {
            supported: true,
            state: "active".into(),
            generation: 17,
            owner: Some("session-a".into()),
            target: Some("window-a".into()),
            ..Default::default()
        };
        for change in ["stopped", "generation", "owner", "target", "mode"] {
            let mut replacement = initial.clone();
            match change {
                "stopped" => replacement.state = "stopped".into(),
                "generation" => replacement.generation += 1,
                "owner" => replacement.owner = Some("session-b".into()),
                "target" => replacement.target = Some("window-b".into()),
                "mode" => replacement.mode = ControlMode::Observe,
                _ => unreachable!(),
            }
            let host = ControlRecordingHost {
                state: Mutex::new(initial.clone()),
                replace_control_during_observation: Some(replacement),
                ..Default::default()
            };
            let (snapshot, error) = super::super::computer_use_program::observe_after_input(
                &host,
                crate::agentic::tools::computer_use_host::AppSelector {
                    pid: Some(421),
                    ..Default::default()
                },
                None,
            )
            .await;
            assert!(
                snapshot.is_none(),
                "{change} must discard the old observation"
            );
            assert!(error
                .unwrap()
                .contains("CONTROL_CHANGED_DURING_OBSERVATION"));
            assert_eq!(*host.events.lock().unwrap(), ["observe:Some(421)"]);
        }
    }

    #[tokio::test]
    async fn computer_use_batch_preserves_receipts_when_final_observation_fails() {
        let host = Arc::new(ControlRecordingHost {
            fail_observation: true,
            ..Default::default()
        });
        let context = control_context(host.clone());
        let tool = ComputerUseTool::new();
        tool.call_impl(
            &json!({"action":"start_control","mode":"background"}),
            &context,
        )
        .await
        .unwrap();
        let results = tool
            .call_impl(
                &json!({"action":"app_batch","app":{"pid":421},"steps":[
                    {"action":"app_type_text","text":"already submitted"},
                    {"action":"app_key_chord","keys":["return"]}
                ]}),
                &context,
            )
            .await
            .unwrap();
        let receipt = results[0].content();
        assert_eq!(receipt["status"], "submitted");
        assert_eq!(receipt["completed_steps"], 2);
        assert!(receipt["observation_error"]
            .as_str()
            .unwrap()
            .contains("FIXTURE_OBSERVATION_FAILURE"));
        assert_eq!(
            host.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.starts_with("input:"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn computer_use_cancelled_batch_submits_no_steps() {
        use crate::agentic::tools::computer_use_host::{AppInputAction, AppSelector};
        let host = Arc::new(ControlRecordingHost::default());
        let mut context = control_context(host.clone());
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        context.runtime_handles =
            openbitfun_runtime_ports::ToolRuntimeHandles::new(None, Some(token));
        let outcome = super::super::computer_use_program::execute(
            host.as_ref(),
            AppSelector {
                pid: Some(421),
                ..Default::default()
            },
            vec![AppInputAction::TypeText {
                text: "must not submit".into(),
                focus: None,
            }],
            Some(&context),
        )
        .await;
        assert_eq!(outcome.receipt["status"], "cancelled");
        assert_eq!(outcome.receipt["completed_steps"], 0);
        assert!(outcome.snapshot.is_none());
        assert!(host.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn computer_use_batch_cancel_interrupts_wait_and_skips_remaining_input() {
        use crate::agentic::tools::computer_use_host::{AppInputAction, AppSelector};
        let host = Arc::new(ControlRecordingHost::default());
        host.state.lock().unwrap().state = "active".into();
        let mut context = control_context(host.clone());
        let token = tokio_util::sync::CancellationToken::new();
        context.runtime_handles =
            openbitfun_runtime_ports::ToolRuntimeHandles::new(None, Some(token.clone()));
        let execution = super::super::computer_use_program::execute(
            host.as_ref(),
            AppSelector {
                pid: Some(421),
                ..Default::default()
            },
            vec![
                AppInputAction::Wait { ms: 60_000 },
                AppInputAction::TypeText {
                    text: "must not submit".into(),
                    focus: None,
                },
            ],
            Some(&context),
        );
        let cancel = async {
            host.wait_started.notified().await;
            token.cancel();
        };
        let (outcome, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(execution, cancel)
        })
        .await
        .unwrap();
        assert_eq!(outcome.receipt["status"], "cancelled");
        assert_eq!(outcome.receipt["completed_steps"], 0);
        assert_eq!(
            outcome.receipt["steps"][0]["input_may_have_been_submitted"],
            false
        );
        assert!(outcome.snapshot.is_none());
        assert_eq!(*host.events.lock().unwrap(), vec!["wait"]);
    }
}
