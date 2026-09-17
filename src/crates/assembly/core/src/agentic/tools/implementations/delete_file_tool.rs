use crate::agentic::tools::file_permissions::file_permission_intents;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri;
use crate::agentic::tools::ToolPathOperation;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;
use tool_runtime::fs::delete_path::{
    delete_path_success_message, delete_workspace_path, inspect_workspace_delete_target,
};

/// File deletion tool - provides safe file/directory deletion functionality
///
/// This tool records a lightweight checkpoint before deletion. Rollback is not automatic.
pub struct DeleteFileTool;

impl Default for DeleteFileTool {
    fn default() -> Self {
        Self::new()
    }
}

impl DeleteFileTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for DeleteFileTool {
    fn name(&self) -> &str {
        "Delete"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Deletes a file or directory from the filesystem. This operation records a lightweight checkpoint before deletion, but rollback is not automatic.

Usage guidelines:
1. **File Deletion**:
   - Provide the path to the file you want to delete (relative or absolute)
   - The file must exist and be accessible
   - Example: Delete a single file like `old_file.txt` or `/path/to/file.txt`

2. **Directory Deletion**:
   - For empty directories, just provide the path
   - For non-empty directories, you MUST set `recursive: true`
   - Be careful with recursive deletion as it will remove all contents

3. **Path Requirements**:
   - You can use either relative paths (e.g., "temp/data.txt"), absolute paths inside the current workspace, or exact `openbitfun://...` URIs returned by another tool
   - Relative paths will be automatically resolved relative to the workspace directory
   - The path must exist in the filesystem

4. **Safety Features**:
    - Deletions record a lightweight checkpoint when session context is available
    - The checkpoint captures Git branch/dirty-state metadata when cheap
    - The tool requires user confirmation for execution

5. **Best Practices**:
   - Before deleting, consider using the Read or LS tools to verify the target
   - For directories, use LS to check contents before recursive deletion
   - Prefer this tool over bash `rm` commands for better tracking and safety

Example usage:
```json
{
  "path": "old_file.txt"
}
```

Example for directory:
```json
{
  "path": "temp_folder",
  "recursive": true
}
```

Important notes:
 - NEVER use bash `rm` commands when this tool is available
 - This tool provides better safety through checkpoint metadata
 - Rollback is not automatic; use the recorded checkpoint metadata to guide recovery
 - The tool will fail gracefully if permissions are insufficient"#.to_string())
    }

    fn short_description(&self) -> String {
        "Delete a file or directory from the filesystem.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file or directory to delete. Use a workspace-relative path, an absolute path inside the current workspace, or an exact openbitfun:// URI returned by another tool."
                },
                "recursive": {
                    "type": "boolean",
                    "description": "If true, recursively delete directories and their contents. Required when deleting non-empty directories. Default: false"
                }
            },
            "required": ["path"]
        })
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
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("path parameter is required".to_string()))?;
        file_permission_intents("edit", [path], context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let path_str = match input.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return ValidationResult {
                    result: false,
                    message: Some("path parameter is required".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        if path_str.is_empty() {
            return ValidationResult {
                result: false,
                message: Some("path cannot be empty".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        let force = input
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let recursive = input
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let rejection = if recursive {
            crate::agentic::execution::edit_constraint_guard::check_recursive_delete(
                context, path_str, force,
            )
            .await
        } else {
            crate::agentic::execution::edit_constraint_guard::check_delete(
                context, "Delete", "delete", path_str, force,
            )
            .await
        };
        if let Some(rejection) = rejection {
            return rejection;
        }

        let resolved = match context.map(|ctx| ctx.resolve_tool_path(path_str)) {
            Some(Ok(value)) => value,
            Some(Err(err)) => {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
            None => {
                if is_openbitfun_tool_uri(path_str) {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "Tool context is required to resolve OpenBitFun URIs".to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                let local_path = Path::new(path_str);
                if !local_path.is_absolute() {
                    return ValidationResult {
                        result: false,
                        message: Some("path must be an absolute path".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                if !local_path.exists() {
                    return ValidationResult {
                        result: false,
                        message: Some(format!("Path does not exist: {}", path_str)),
                        error_code: Some(404),
                        meta: None,
                    };
                }

                return ValidationResult {
                    result: true,
                    message: None,
                    error_code: None,
                    meta: None,
                };
            }
        };

        if let Some(ctx) = context {
            if let Err(err) = ctx.enforce_path_operation(ToolPathOperation::Delete, &resolved) {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        }

        if let Some(context) = context {
            let target = match context.file_system_for_path(&resolved) {
                Ok(fs) => {
                    inspect_workspace_delete_target(fs.as_ref(), &resolved.resolved_path).await
                }
                Err(error) => Err(error.to_string()),
            };
            let target = match target {
                Ok(target) => target,
                Err(error) => {
                    return ValidationResult {
                        result: false,
                        message: Some(error),
                        error_code: Some(400),
                        meta: None,
                    }
                }
            };
            if !target.exists {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Path does not exist: {}", resolved.logical_path)),
                    error_code: Some(404),
                    meta: None,
                };
            }
            if target.is_directory && !target.is_empty && !recursive {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Directory is not empty: {}. Set recursive=true to delete non-empty directories", resolved.logical_path)),
                    error_code: Some(400),
                    meta: Some(json!({
                        "is_directory": true,
                        "is_empty": false,
                        "requires_recursive": true,
                    })),
                };
            }
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
            let recursive = input
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if recursive {
                format!("Deleting directory and contents: {}", path)
            } else {
                format!("Deleting: {}", path)
            }
        } else {
            "Deleting file or directory".to_string()
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if let Some(path) = output.get("path").and_then(|v| v.as_str()) {
            let is_directory = output
                .get("is_directory")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            delete_path_success_message(path, is_directory)
        } else {
            "Deletion completed".to_string()
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let path_str = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("path is required".to_string()))?;

        let recursive = input
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved = context.resolve_tool_path(path_str)?;
        context.enforce_path_operation(ToolPathOperation::Delete, &resolved)?;
        context
            .record_light_checkpoint(
                "Delete",
                &resolved.logical_path,
                vec![resolved.logical_path.clone()],
            )
            .await?;

        let fs = context.file_system_for_path(&resolved)?;
        let outcome = delete_workspace_path(
            fs.as_ref(),
            &resolved.logical_path,
            &resolved.resolved_path,
            recursive,
        )
        .await
        .map_err(OpenBitFunError::tool)?;

        let result_data = json!({
            "success": true,
            "path": outcome.logical_path,
            "is_directory": outcome.is_directory,
            "recursive": outcome.recursive
        });

        let result_text = self.render_result_for_assistant(&result_data);
        crate::agentic::execution::edit_constraint_guard::record_mutation_applied(
            context,
            "Delete",
            if recursive {
                "recursive_delete"
            } else {
                "delete"
            },
            &resolved.logical_path,
        )
        .await;
        crate::agentic::execution::edit_constraint_guard::forget_agent_created_file(
            context,
            &resolved.logical_path,
        )
        .await;

        Ok(vec![ToolResult::Result {
            data: result_data,
            result_for_assistant: Some(result_text),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::DeleteFileTool;
    use crate::agentic::tools::framework::Tool;

    #[cfg(unix)]
    #[tokio::test]
    async fn local_and_remote_delete_use_the_same_filesystem_contract() {
        use crate::agentic::{tools::framework::ToolUseContext, WorkspaceBinding};
        use openbitfun_runtime_ports::ToolRuntimeHandles;
        use serde_json::json;
        use std::os::unix::fs::symlink;
        use std::path::PathBuf;

        // Run the real provider against separate fixture roots through both Session bindings.
        // These are routing/behavior tests, not evidence of a live SSH connection.
        for remote in [false, true] {
            let root =
                std::env::temp_dir().join(format!("openbitfun-delete-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("empty")).unwrap();
            std::fs::create_dir_all(root.join("nonempty")).unwrap();
            std::fs::write(root.join("nonempty/keep.txt"), "keep").unwrap();
            symlink(root.join("nonempty"), root.join("link")).unwrap();
            symlink(root.join("missing"), root.join("dangling")).unwrap();
            let root_str = root.to_string_lossy().to_string();
            let workspace = if remote {
                let identity =
                    crate::service::remote_ssh::workspace_state::workspace_session_identity(
                        &root_str,
                        Some("delete-fixture"),
                        Some("delete-host"),
                    )
                    .unwrap();
                WorkspaceBinding::new_remote(
                    None,
                    PathBuf::from(&root_str),
                    "delete-fixture".into(),
                    "delete-host".into(),
                    identity,
                )
            } else {
                WorkspaceBinding::new(None, root.clone())
            };
            let context = ToolUseContext {
                tool_call_id: None,
                agent_type: None,
                session_id: None,
                dialog_turn_id: None,
                workspace: Some(workspace),
                loaded_deferred_tool_specs: Vec::new(),
                primary_model_facts: Default::default(),
                custom_data: Default::default(),
                computer_use_host: None,
                runtime_tool_restrictions: Default::default(),
                runtime_handles: ToolRuntimeHandles::new(
                    Some(crate::agentic::workspace::local_workspace_services(
                        root_str,
                    )),
                    None,
                ),
            };
            let tool = DeleteFileTool::new();
            let result = tool
                .call_impl(&json!({"path":"empty"}), &context)
                .await
                .unwrap();
            assert_eq!(result[0].content()["is_directory"], true);
            assert!(!root.join("empty").exists());
            let nonempty = json!({"path":"nonempty"});
            assert!(!tool.validate_input(&nonempty, Some(&context)).await.result);
            assert!(tool.call_impl(&nonempty, &context).await.is_err());
            assert_eq!(
                std::fs::read_to_string(root.join("nonempty/keep.txt")).unwrap(),
                "keep"
            );
            for path in ["link", "dangling"] {
                let result = tool
                    .call_impl(&json!({"path":path,"recursive":true}), &context)
                    .await
                    .unwrap();
                assert_eq!(result[0].content()["is_directory"], false);
                assert!(std::fs::symlink_metadata(root.join(path)).is_err());
            }
            assert!(root.join("nonempty/keep.txt").exists());
            tool.call_impl(&json!({"path":"nonempty","recursive":true}), &context)
                .await
                .unwrap();
            assert!(!root.join("nonempty").exists());
            assert!(tool
                .call_impl(&json!({"path":"missing"}), &context)
                .await
                .is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn schema_does_not_expose_force_override() {
        let schema = DeleteFileTool::new().input_schema();
        assert!(schema["properties"].get("force").is_none());
    }
}
