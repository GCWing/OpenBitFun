//! FinalizeMiniApp tool — compile direct MiniApp file edits and publish the
//! resulting runtime revision to every open product surface.

use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::miniapp::lifecycle::miniapp_runtime_event_payload;
use crate::miniapp::try_get_global_miniapp_manager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct FinalizeMiniAppTool;

impl FinalizeMiniAppTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FinalizeMiniAppTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for FinalizeMiniAppTool {
    fn name(&self) -> &str {
        "FinalizeMiniApp"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Finalize source files edited for an installed OpenBitFun MiniApp.

Call this after every successful Read/Write/Edit pass under a MiniApp root returned by InitMiniApp, and after modifying an existing MiniApp. It:
- reloads source files from disk;
- recompiles and persists compiled.html;
- increments the MiniApp version only when user-controlled content changed;
- emits runtime update events so an already-open MiniApp reloads.

Input: app_id and optional theme ('dark' or 'light').
Do not call this for a customization draft root; the customization host owns draft sync and apply.
Do not edit meta.json version fields manually; this tool owns version transitions.
Returns app_id, version, changed, and source_revision."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Finalize MiniApp file edits and refresh open runtimes.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["app_id"],
            "properties": {
                "app_id": {
                    "type": "string",
                    "description": "Installed MiniApp id returned by InitMiniApp."
                },
                "theme": {
                    "type": "string",
                    "enum": ["dark", "light"],
                    "description": "Theme used for the persisted compiled preview. Defaults to dark."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_id": {"type": "string"},
                "version": {"type": "string"},
                "changed": {"type": "boolean"}
            },
            "required": ["app_id", "version", "changed"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let app_id = input
            .get("app_id")
            .and_then(Value::as_str)
            .unwrap_or("<missing>")
            .trim();
        Ok(vec![PermissionIntent::new(
            "custom_tool",
            vec![format!("miniapp:FinalizeMiniApp:{app_id}")],
        )])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return Err(OpenBitFunError::tool(
                "FinalizeMiniApp reads product-host-local files and cannot be used in a remote workspace. Use OpenBitFunControl get feature.miniapps and its structured update-app operation instead".to_string(),
            ));
        }
        let manager = try_get_global_miniapp_manager()
            .ok_or_else(|| OpenBitFunError::tool("MiniAppManager not initialized".to_string()))?;
        let app_id = input
            .get("app_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| OpenBitFunError::validation("Missing required field: app_id"))?;
        let theme = input.get("theme").and_then(Value::as_str).unwrap_or("dark");

        let previous = manager
            .get_meta(app_id)
            .await
            .map_err(|error| OpenBitFunError::tool(format!("Failed to load MiniApp: {error}")))?;
        let app = manager
            .sync_from_fs(app_id, theme, context.workspace_root())
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!("Failed to finalize MiniApp: {error}"))
            })?;
        let changed = app.version != previous.version;
        let reason = if changed {
            "agent-finalize"
        } else {
            "agent-finalize-noop"
        };

        for event_name in ["miniapp-recompiled", "miniapp-updated"] {
            let _ = emit_global_event(BackendEvent::Custom {
                event_name: event_name.to_string(),
                payload: miniapp_runtime_event_payload(&app, reason),
            })
            .await;
        }

        let result_text = if changed {
            format!(
                "MiniApp '{}' finalized at version {}. Open runtimes were notified to reload.",
                app.name, app.version
            )
        } else {
            format!(
                "MiniApp '{}' was recompiled with no content change; version remains {}. Open runtimes were notified to reload.",
                app.name, app.version
            )
        };

        Ok(vec![ToolResult::Result {
            data: json!({
                "app_id": app.id,
                "version": app.version,
                "changed": changed,
                "source_revision": app.runtime.source_revision,
            }),
            result_for_assistant: Some(result_text),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::FinalizeMiniAppTool;
    use crate::agentic::tools::framework::{Tool, ToolExposure, ToolUseContext};
    use serde_json::json;

    #[test]
    fn finalize_miniapp_stays_expanded_for_assistant_updates() {
        let tool = FinalizeMiniAppTool::new();
        assert_eq!(tool.default_exposure(), ToolExposure::Direct);
    }

    #[test]
    fn finalize_miniapp_emits_stable_permission_identity() {
        let tool = FinalizeMiniAppTool::new();
        let context = ToolUseContext::for_tool_listing(None, None);
        let intents = tool
            .permission_intents(&json!({ "app_id": "demo-app" }), &context)
            .expect("permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "custom_tool");
        assert_eq!(
            intents[0].resources,
            ["miniapp:FinalizeMiniApp:demo-app".to_string()]
        );
    }
}
