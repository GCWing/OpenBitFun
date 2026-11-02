//! MiniAppBrowser tool — control the live MiniApp using knowledge of its source.
//!
//! Source inspection and edits use the existing MiniApp authoring owner; this
//! tool operates and verifies the user-visible instance. Layering:
//!
//! - [`crate::agentic::tools::miniapp_surface`] owns the host
//!   port, sessions, target handles, capability facts, and the method whitelist.
//! - [`actions`] owns what each Agent action means and forwards it.
//! - [`result`] owns the model-facing envelopes and node rendering.
//! - this module owns only the `Tool` contract surface.

mod actions;
mod result;

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::miniapp_surface::miniapp_web_host_available;
use crate::util::errors::OpenBitFunResult;
use actions::{action_from_input, dispatch, Action, ACTIONS};
use async_trait::async_trait;
use openbitfun_product_domains::miniapp::web_surface::{
    MINIAPP_WEB_DEFAULT_CAPTURE_EDGE, MINIAPP_WEB_DEFAULT_WAIT_MS, MINIAPP_WEB_MAX_CAPTURE_EDGE,
    MINIAPP_WEB_MAX_DEPTH, MINIAPP_WEB_MAX_NODES, MINIAPP_WEB_MAX_WAIT_MS,
    MINIAPP_WEB_MAX_WATCH_MS,
};
use serde_json::{json, Value};

const TOOL_NAME: &str = "MiniAppBrowser";

pub struct MiniAppBrowserTool;

impl MiniAppBrowserTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MiniAppBrowserTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for MiniAppBrowserTool {
    fn name(&self) -> &str {
        TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            r#"Control a MiniApp at the source level and through its live interface. This is the preferred tool for OpenBitFun MiniApps, before ComputerUse. Read its source to understand business functions and action parameters, then observe live business state and invoke semantic actions on the current instance. MiniAppBrowser operates and verifies the user-visible instance.

Source-aware workflow:
1. Use `OpenBitFunControl` to `get` `feature.miniapps`, then follow its schema for `list-apps` and `inspect-app`. Inspection returns HTML, CSS, UI/worker JavaScript, dependencies, and version without a workspace checkout. Read the relevant implementation and derive the shortest reliable sequence for the task; source access does not require an edit.
2. `open` the user's current instance, then `observe_bridge` for current business state and declared actions. Use `act_bridge` with parameters derived from source to call the app's business functions. Prefer an action's returned business state for verification; observe again for genuinely dynamic or uncertain steps. Source explains implementation, not current runtime state. Omitted fields should preserve the user's draft and selection.
3. Routine operation must not use `update-app`, `FinalizeMiniApp`, reload, or presentation transfer to obtain controls: these can discard unsaved runtime state. If semantic controls are missing, use available DOM/input controls or report the specific gap. Do not guess action names. Treat adding controls as an app enhancement, separate from operating the current state.
4. For an app enhancement, use `update-app` with `appId` and the inspected version as `expectedVersion`, sending only changed fields, or `FinalizeMiniApp` for managed local file edits. Before updating an active app, establish how its current draft/state will be preserved and restored; otherwise explain the interruption and obtain the user's agreement. Preserve unrelated source, permissions, and user data; never delete/recreate an app. Explicit customization drafts stay in their draft directory and are applied by the customization panel instead.
Do not assume installed-app source is present in the workspace. Remote workspaces/controllers use the owning host's structured operations, not local file tools on host paths. If source access is unavailable, report the limitation and use available live controls.

Opening and identity:
- Call `apps` when the app id is unknown. `open` accepts `appId` or `name`: exact matches win, unique partial names are accepted, and ambiguous names return candidates.
- `open` prefers an existing app window, then an existing tab, then launches its exported desktop app when available, otherwise opens a tab. Never use a separate/headless browser copy as evidence about the user's live instance.
- A sessionId is bound to one appId; reopening replaces the prior control session. `close` releases control only, leaving the app open.
- targetIds expire after 10 minutes and become stale on reload or node replacement. After a source update, STALE_TARGET, or UNKNOWN_TARGET, run `inspect` again.

Fallback live controls (when no suitable semantic action exists):
- DOM loop: open -> inspect -> find (or reuse targetIds) -> click/type/read/key/scroll -> wait -> inspect. `inspect` returns at most {MINIAPP_WEB_MAX_NODES} nodes and depth {MINIAPP_WEB_MAX_DEPTH}. Locator priority: testId, role+name, name/text, then CSS selector.
- For SVG/Canvas or other position-sensitive elements, `click` accepts `position: {{x, y}}` as fractions of the target's bounding box (0 inclusive, 1 exclusive), gated by `element-position-click-v1`. Derive positions from the observed element/source geometry, not desktop coordinates. Omit position for an element-center click. Read element attributes or DOM changes to verify the result. Missing semantic actions alone do not justify switching to ComputerUse; establish a specific unsupported operation first.
- `wait` gives animations/network/game loops an interval ({MINIAPP_WEB_DEFAULT_WAIT_MS}ms default, {MINIAPP_WEB_MAX_WAIT_MS}ms maximum); re-observe afterwards.
- `watch_state` samples and deduplicates bridge state within one call (up to {MINIAPP_WEB_MAX_WATCH_MS}ms). Prefer it to repeated observation calls or an external harness when following change over time.
- `screenshot` captures the largest canvas, not the full page ({MINIAPP_WEB_DEFAULT_CAPTURE_EDGE}px longest side by default, {MINIAPP_WEB_MAX_CAPTURE_EDGE}px maximum). It is a turn-paced image fallback, not continuous vision or access to app variables.

Surface capabilities:
- Readable tabs support DOM, accessibility, input, and bridge. Canvas contents have no DOM structure; use bridge state or the screenshot fallback.
- Strict opaque-origin tabs expose no DOM/pixels. Their bridge works, including automatic activity observations; the tab key path still requires a readable document.
- Independent windows (`surface.kind: window`) support `observe_bridge`, `watch_state`, `act_bridge`, and `key`. DOM actions and screenshots return CAPABILITY_MISSING; use bridge/key. Moving to a tab may reopen the document and lose unsaved state; do not do it merely to gain DOM/pixels.

Bridge state and actions:
- Without app changes, `observe_bridge` reports animation activity (`frames`, `frameAgeMs`), input delivery (`input`, `inputCount`), viewport and canvas sizes. `state` is null and `canvasTextUnavailable` is true: activity does not reveal scores, lives, game phase, or current Canvas text.
- For authoritative state and semantic control, the app can call `window.app.agent.expose({{ observe: () => ({{ score, lives }}), actions: ['restart'], act: (action) => ... }})`. This SDK is injected in all frames, including strict runtime. New apps should provide these controls from creation. Let the app handle timing internally; adding handlers to an existing app is an enhancement that may reload it.
- `observe_bridge` returns the app's JSON under `state` and its action vocabulary under `declaredActions`; use those names with `act_bridge`. An empty action list is not proof that no actions are accepted: consult the source. Keep actions bounded and verify outcomes without a mandatory observation after every input.
- A newly opened window may report `bridgeAnnounced: false` and empty capabilities; call `observe_bridge` before concluding it is inert. Without useful state, use small inputs with observation and acknowledge turn-paced limits.

This tool has no host-path access or arbitrary JavaScript `evaluate` action. Source inspection and modification belong to the authoring workflow above."#
        ))
    }

    fn short_description(&self) -> String {
        "Preferred control for OpenBitFun MiniApps: open the live app, then use bridge or DOM/input before desktop automation."
            .to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "appId": { "type": "string", "description": "open: installed MiniApp id. Call apps when the id is unknown." },
                "name": { "type": "string", "description": "open: installed MiniApp display name, used when the id is unknown. An exact name wins; a partial name must match exactly one app." },
                "sessionId": { "type": "string", "description": "Session returned by open. Required by every action except open, sessions, and apps." },
                "targetId": { "type": "string", "description": "Short-lived target returned by inspect or find." },
                "position": {
                    "type": "object",
                    "description": "click: optional position within the target's bounding box as fractions; requires element-position-click-v1. Omit for center.",
                    "properties": {
                        "x": { "type": "number", "minimum": 0, "exclusiveMaximum": 1 },
                        "y": { "type": "number", "minimum": 0, "exclusiveMaximum": 1 }
                    },
                    "required": ["x", "y"],
                    "additionalProperties": false
                },
                "locator": {
                    "type": "object",
                    "description": "find: highest-priority axis first. Provide testId, or role with name, or text, or a selector fallback.",
                    "properties": {
                        "testId": { "type": "string" },
                        "role": { "type": "string" },
                        "name": { "type": "string" },
                        "text": { "type": "string" },
                        "selector": { "type": "string", "description": "Compatibility fallback only." },
                        "exact": { "type": "boolean", "description": "Require exact name/text matches instead of substrings." }
                    },
                    "additionalProperties": false
                },
                "attribute": { "type": "string", "description": "read: optional attribute name to return alongside text and value." },
                "text": { "type": "string", "description": "type: text to enter into the target." },
                "clear": { "type": "boolean", "description": "type: replace the existing value (default true)." },
                "key": { "type": "string", "description": "key: DOM key name such as Enter, Escape, ArrowLeft, Space, or a single character." },
                "modifiers": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["Alt", "Control", "Meta", "Shift"] },
                    "description": "key: modifiers held while the key is sent."
                },
                "holdMs": { "type": "number", "description": "key: keep the key down this long (0-2000ms) before releasing it. Game loops read held input, so a movement key usually needs a hold." },
                "maxEdge": { "type": "number", "description": "screenshot: longest side of the returned image in pixels (320-1024, default 900)." },
                "deltaX": { "type": "number", "description": "scroll: horizontal delta in pixels." },
                "deltaY": { "type": "number", "description": "scroll: vertical delta in pixels." },
                "durationMs": { "type": "number", "description": "wait: observation interval in milliseconds. watch_state: length of the sampling window (250-120000ms, default 20000)." },
                "pollMs": { "type": "number", "description": "watch_state: sampling interval inside the window (250ms-120000ms, default 1000). Samples are deduplicated by state, so a quiet app returns few." },
                "bridgeAction": {
                    "type": "object",
                    "description": "act_bridge: MiniApp-declared semantic action, for example {\"type\":\"restart\"}.",
                    "properties": { "type": { "type": "string" } },
                    "required": ["type"],
                    "additionalProperties": true
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ok": { "type": "boolean" },
                "action": { "type": "string" },
                "data": { "type": "object", "additionalProperties": true },
                "error": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string" },
                        "message": { "type": "string" },
                        "hints": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["code", "message", "hints"],
                    "additionalProperties": false
                }
            },
            "required": ["ok", "action"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn is_enabled(&self) -> bool {
        miniapp_web_host_available()
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let mut description = self.description().await?;
        if !miniapp_web_host_available() {
            description.push_str(
                "\n\nNo MiniApp Web surface host is installed in this runtime. Controlling a MiniApp requires an active Desktop product surface; do not attempt it from this session.",
            );
        } else if context.map(ToolUseContext::is_remote).unwrap_or(false) {
            description.push_str(
                "\n\n**Remote workspace:** the MiniApp surface belongs to the controller window. This tool drives that controller-local surface and never proxies a remote app.",
            );
        }
        Ok(description)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if action_from_input(input).is_some() {
            return ValidationResult::default();
        }
        ValidationResult {
            result: false,
            message: Some(format!(
                "Missing or unsupported action. Supported actions: {}.",
                ACTIONS.join(", ")
            )),
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match action_from_input(input) {
            Some(action) => format!("{TOOL_NAME}: {}", action.as_str()),
            None => TOOL_NAME.to_string(),
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if output.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return output
                .get("data")
                .map(Value::to_string)
                .unwrap_or_else(|| output.to_string());
        }
        let error = &output["error"];
        let mut summary = format!(
            "{}: {}",
            error["code"].as_str().unwrap_or("HOST_ERROR"),
            error["message"].as_str().unwrap_or_default()
        );
        if let Some(hints) = error["hints"].as_array() {
            for hint in hints.iter().filter_map(Value::as_str) {
                summary.push_str("\n- ");
                summary.push_str(hint);
            }
        }
        summary
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let Some(action) = action_from_input(input) else {
            return Ok(result::err_response(
                "?",
                openbitfun_product_domains::miniapp::web_surface::MiniAppWebErrorCode::InvalidParams,
                "Missing or unsupported action.",
                &[ACTIONS.join(", ").as_str()],
            ));
        };
        // Same gate the browser-use loop applies to page screenshots: a capture
        // the model cannot see is not an observation, so refuse it up front
        // instead of spending a round trip on pixels that get dropped.
        if action == Action::Screenshot {
            if let Some(reason) = context.image_observation_unavailable_reason() {
                return Ok(result::ok_response(
                    action.as_str(),
                    json!({
                        "sessionId": input.get("sessionId").cloned().unwrap_or(Value::Null),
                        "screenshotUnavailable": true,
                        "reason": reason,
                    }),
                    format!(
                        "Screenshots cannot reach this session's model ({reason}). Observe a readable MiniApp with inspect and read, or ask the app for bridge state via observe_bridge. Do not retry screenshot."
                    ),
                ));
            }
        }
        Ok(dispatch(action, input, context.session_id.as_deref()).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::implementations::miniapp_browser::actions::Action;

    #[test]
    fn output_schema_covers_live_state_and_typed_failures_without_product_full_registration() {
        use openbitfun_product_domains::product_control::validate_operation_arguments;

        let schema = MiniAppBrowserTool::new().output_schema();
        assert_eq!(schema["type"], "object");
        for envelope in [
            json!({ "ok": true, "action": "observe_bridge", "data": {
                "sessionId": "miniapp-session-1", "state": { "board": [[0, 1]], "turn": "white" }
            } }),
            json!({ "ok": false, "action": "click", "error": {
                "code": "STALE_TARGET", "message": "The document changed", "hints": ["Inspect again"]
            } }),
        ] {
            validate_operation_arguments(&schema, Some(&envelope)).expect("real result envelope");
        }
        assert!(validate_operation_arguments(
            &schema,
            Some(&json!({
                "ok": false, "action": "click", "error": { "code": 5 }
            }))
        )
        .is_err());
    }

    #[test]
    fn schema_and_dispatcher_agree_on_the_action_set() {
        let schema = MiniAppBrowserTool::new().input_schema();
        let published = schema["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            published,
            ACTIONS
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn document_actions_are_behind_the_readable_surface_gate_but_key_is_not() {
        for action in [
            Action::Inspect,
            Action::Find,
            Action::Read,
            Action::Click,
            Action::Type,
            Action::Scroll,
            // Pixels can only be read from a frame this window may inspect, so a
            // strict-runtime MiniApp cannot be screenshotted either.
            Action::Screenshot,
        ] {
            assert!(
                action.requires_dom(),
                "{action:?} must require a readable DOM"
            );
        }
        for action in [
            Action::Key,
            Action::Wait,
            Action::ObserveBridge,
            Action::ActBridge,
        ] {
            assert!(!action.requires_dom(), "{action:?} must not require a DOM");
        }
    }

    #[tokio::test]
    async fn unknown_actions_are_rejected_during_validation() {
        let tool = MiniAppBrowserTool::new();
        let validation = tool.validate_input(&json!({}), None).await;
        assert!(!validation.result);
        assert!(validation
            .message
            .unwrap_or_default()
            .contains("observe_bridge"));

        let accepted = tool
            .validate_input(&json!({ "action": "inspect" }), None)
            .await;
        assert!(accepted.result);
    }

    #[tokio::test]
    async fn description_connects_source_control_to_existing_authoring_owner() {
        let description = MiniAppBrowserTool::new()
            .description()
            .await
            .expect("tool description");
        assert!(description.contains("Control a MiniApp at the source level"));
        assert!(description.contains("OpenBitFunControl"));
        assert!(description.contains("inspect-app"));
        assert!(description.contains("update-app"));
        assert!(description.contains("expectedVersion"));
        assert!(description.contains("FinalizeMiniApp"));
        assert!(description.contains("derive the shortest reliable sequence"));
        assert!(description.contains("genuinely dynamic or uncertain steps"));
        assert!(description.contains("Do not assume installed-app source is present"));
    }
}
