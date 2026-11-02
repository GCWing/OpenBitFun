//! LS tool implementation
//!
//! Provides functionality similar to Unix ls command for listing files and subdirectories in a directory

use crate::agentic::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::{DateTime, Local};
use serde_json::{json, Value};
use std::path::Path;
use std::time::SystemTime;
use tool_runtime::fs::listing::{format_workspace_listing, list_workspace_directory};

/// LS tool - list directory tree
pub struct LSTool {
    /// Default maximum number of entries to return
    default_limit: usize,
}

impl Default for LSTool {
    fn default() -> Self {
        Self::new()
    }
}

impl LSTool {
    pub fn new() -> Self {
        Self { default_limit: 200 }
    }

    fn parse_limit(&self, input: &Value) -> Result<usize, &'static str> {
        let Some(value) = input.get("limit") else {
            return Ok(self.default_limit);
        };
        value
            .as_u64()
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| *limit > 0)
            .ok_or("limit must be a positive integer")
    }
}

/// Format system time as readable string
fn format_time(time: SystemTime) -> String {
    let datetime: DateTime<Local> = time.into();
    datetime.format("%Y-%m-%d %H:%M:%S").to_string()
}

#[async_trait]
impl Tool for LSTool {
    fn name(&self) -> &str {
        "LS"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Recursively lists files and directories in a given path.

Usage:
- The path parameter must be relative to the current workspace, an absolute path inside the current workspace, or an exact `openbitfun://...` URI returned by another tool
- Do not list host roots such as `/`, `/Users`, `/home`, or placeholder paths such as `/workspace`
- Hidden files (files starting with '.') are automatically excluded
- Results are sorted by modification time (newest first)"#
            .to_string())
    }

    fn short_description(&self) -> String {
        "List files and directories in a workspace path.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory to list. Use a workspace-relative path, an absolute path inside the current workspace, or an exact openbitfun:// URI returned by another tool."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The maximum number of entries to return. Defaults to 200."
                },
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "path": {"type": "string"},
                            "is_dir": {"type": "boolean"}
                        },
                        "required": ["name", "path", "is_dir"],
                        "additionalProperties": false
                    }
                },
                "total": {"type": "integer"},
                "limit": {"type": "integer"},
                "truncated": {"type": "boolean"}
            },
            "required": ["path", "entries", "total", "limit", "truncated"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Err(message) = self.parse_limit(input) {
            return ValidationResult {
                result: false,
                message: Some(message.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
            if path.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("path cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            let resolved = match context.map(|ctx| ctx.resolve_tool_path(path)) {
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
                    if is_openbitfun_tool_uri(path) {
                        return ValidationResult {
                            result: false,
                            message: Some(
                                "Tool context is required to resolve OpenBitFun URIs".to_string(),
                            ),
                            error_code: Some(400),
                            meta: None,
                        };
                    }

                    let local_path = Path::new(path);
                    if !local_path.is_absolute() {
                        return ValidationResult {
                            result: false,
                            message: Some(format!("path must be an absolute path, got: {}", path)),
                            error_code: Some(400),
                            meta: None,
                        };
                    }

                    if !local_path.exists() {
                        return ValidationResult {
                            result: false,
                            message: Some(format!("Directory does not exist: {}", path)),
                            error_code: Some(404),
                            meta: None,
                        };
                    }

                    if !local_path.is_dir() {
                        return ValidationResult {
                            result: false,
                            message: Some(format!("Path is not a directory: {}", path)),
                            error_code: Some(400),
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

            if let Some(context) = context {
                let validation = match context.file_system_for_path(&resolved) {
                    Ok(fs) => fs.path_kind_no_follow(&resolved.resolved_path).await,
                    Err(error) => {
                        return ValidationResult {
                            result: false,
                            message: Some(error.to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                };
                if !matches!(
                    validation,
                    Ok(Some(openbitfun_runtime_ports::WorkspacePathKind::Directory))
                ) {
                    return ValidationResult {
                        result: false,
                        message: Some(match validation {
                            Err(error) => error.to_string(),
                            Ok(None) => {
                                format!("Directory does not exist: {}", resolved.logical_path)
                            }
                            Ok(Some(_)) => {
                                format!("Path is not a directory: {}", resolved.logical_path)
                            }
                        }),
                        error_code: Some(400),
                        meta: None,
                    };
                }
            }
        } else {
            return ValidationResult {
                result: false,
                message: Some("path is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
            if options.verbose {
                format!("Listing directory: {}", path)
            } else {
                format!("List {}", path)
            }
        } else {
            "Listing directory".to_string()
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("path is required".to_string()))?;

        let limit = self.parse_limit(input).map_err(OpenBitFunError::tool)?;

        let resolved = context.resolve_tool_path(path)?;

        let fs = context.file_system_for_path(&resolved)?;
        let listing = list_workspace_directory(fs.as_ref(), &resolved.resolved_path, limit)
            .await
            .map_err(OpenBitFunError::tool)?;
        let entries_json = listing
            .entries
            .iter()
            .filter(|entry| entry.components.len() == 1)
            .map(|entry| {
                let entry_path = resolved
                    .logical_child_path(Path::new(&entry.path))
                    .unwrap_or_else(|| entry.path.clone());
                json!({
                    "name": entry.name,
                    "path": entry_path,
                    "is_dir": entry.is_dir,
                    "is_symlink": false,
                    "modified_time": entry.modified.map(format_time),
                })
            })
            .collect::<Vec<Value>>();
        let total_entries = listing.entries.len();
        let mut result_text = format_workspace_listing(&listing, &resolved.logical_path);
        if listing.truncated {
            result_text.push_str(&format!(
                "\n(listing truncated; showing up to {} entries)",
                limit
            ));
        } else if total_entries == 0 {
            result_text.push_str("\n(no entries found)");
        }
        let result = ToolResult::Result {
            data: json!({
                "path": resolved.logical_path,
                "entries": entries_json,
                "total": total_entries,
                "limit": limit,
                "truncated": listing.truncated,
            }),
            result_for_assistant: Some(result_text),
            image_attachments: None,
        };
        Ok(vec![result])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::WorkspaceBinding;
    use openbitfun_runtime_ports::{
        ToolRuntimeHandles, WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        WorkspaceFileSystem, WorkspacePathKind, WorkspaceServices, WorkspaceShell,
    };
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Default)]
    struct ListingFs {
        root: Option<String>,
        entries: Vec<WorkspaceDirEntry>,
        children: HashMap<String, Vec<WorkspaceDirEntry>>,
        files: HashMap<String, String>,
        error: Option<&'static str>,
        reads: AtomicUsize,
    }

    #[async_trait]
    impl WorkspaceFileSystem for ListingFs {
        async fn read_file(&self, _path: &str) -> anyhow::Result<Vec<u8>> {
            panic!("LS only reads text ignore files")
        }
        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            self.files
                .get(path)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Missing ignore fixture: {path}"))
        }
        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            panic!("LS must not mutate files")
        }
        async fn exists(&self, _path: &str) -> anyhow::Result<bool> {
            panic!("LS must retain the directory provider's error")
        }
        async fn is_file(&self, _path: &str) -> anyhow::Result<bool> {
            panic!("LS must retain the directory provider's error")
        }
        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            panic!("LS uses no-follow metadata")
        }
        async fn path_kind_no_follow(
            &self,
            _path: &str,
        ) -> anyhow::Result<Option<WorkspacePathKind>> {
            Ok(Some(WorkspacePathKind::Directory))
        }
        async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.error {
                anyhow::bail!(error);
            }
            if path == self.root.as_deref().unwrap_or("/remote/workspace") {
                Ok(self.entries.clone())
            } else {
                Ok(self.children.get(path).cloned().unwrap_or_default())
            }
        }
        async fn read_dir_bounded(
            &self,
            _path: &str,
            _limit: usize,
        ) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            panic!("A transport-order prefix cannot supply mtime ordering or a visible-entry limit")
        }
    }

    struct UnusedShell;
    #[async_trait]
    impl WorkspaceShell for UnusedShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            _options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            panic!("LS must not depend on shell commands or local fallback")
        }
    }

    fn context(fs: Arc<ListingFs>, remote: bool) -> ToolUseContext {
        let root = fs.root.as_deref().unwrap_or("/remote/workspace");
        let workspace = if remote {
            let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
                root,
                Some("ls-test-ssh"),
                Some("ls-test-host"),
            )
            .expect("remote identity");
            WorkspaceBinding::new_remote(
                None,
                PathBuf::from(root),
                "ls-test-ssh".to_string(),
                "ls-test-host".to_string(),
                identity,
            )
        } else {
            WorkspaceBinding::new(None, PathBuf::from(root))
        };
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(workspace),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: ToolRuntimeHandles::new(
                Some(WorkspaceServices {
                    fs,
                    shell: Arc::new(UnusedShell),
                }),
                None,
            ),
        }
    }

    fn entry(name: &str, is_dir: bool, modified: u64) -> WorkspaceDirEntry {
        WorkspaceDirEntry {
            name: name.rsplit('/').next().unwrap().to_string(),
            path: format!("/remote/workspace/{name}"),
            is_dir,
            is_symlink: false,
            modified: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(modified)),
        }
    }

    fn result_parts(results: &[ToolResult]) -> (&Value, &str) {
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected listing result")
        };
        (data, result_for_assistant.as_deref().unwrap())
    }

    #[tokio::test]
    async fn listing_uses_same_traversal_and_result_for_local_and_remote_providers() {
        let mut outcomes = Vec::new();
        for remote in [false, true] {
            let root = if remote {
                "/remote/workspace".to_string()
            } else {
                std::env::temp_dir()
                    .join("openbitfun-ls-fixture")
                    .to_string_lossy()
                    .into_owned()
            };
            let path = |name: &str| {
                if remote {
                    format!("{root}/{name}")
                } else {
                    Path::new(&root).join(name).to_string_lossy().into_owned()
                }
            };
            let fixture_entry = |name: &str, is_dir, modified| WorkspaceDirEntry {
                path: path(name),
                ..entry(name, is_dir, modified)
            };
            let fs = Arc::new(ListingFs {
                root: Some(root.clone()),
                entries: vec![
                    fixture_entry("file.txt", false, 1),
                    fixture_entry("目录", true, 2),
                    fixture_entry(".hidden", false, 3),
                ],
                children: HashMap::from([(
                    path("目录"),
                    vec![fixture_entry("目录/child.rs", false, 4)],
                )]),
                ..Default::default()
            });
            let result = LSTool::new()
                .call_impl(
                    &json!({"path": ".", "limit": 10}),
                    &context(fs.clone(), remote),
                )
                .await
                .unwrap();
            let (data, text) = result_parts(&result);
            assert_eq!(data["path"], root);
            assert_eq!(data["total"], 3);
            assert_eq!(data["truncated"], false);
            assert_eq!(data["entries"][0]["name"], "目录");
            assert_eq!(data["entries"][1]["name"], "file.txt");
            assert!(text.contains("child.rs"));
            assert_eq!(fs.reads.load(Ordering::SeqCst), 2);

            // Native and POSIX providers preserve their own absolute path spelling.
            // Compare the listing facts after checking those paths independently.
            let mut comparable = data.clone();
            comparable["path"] = json!("<workspace>");
            for item in comparable["entries"].as_array_mut().unwrap() {
                let name = item["name"].as_str().unwrap().to_string();
                assert_eq!(item["path"], path(&name));
                item["path"] = json!(name);
            }
            outcomes.push((comparable, text.strip_prefix(&root).unwrap().to_string()));
        }
        assert_eq!(outcomes[0], outcomes[1]);
    }

    #[tokio::test]
    async fn remote_listing_preserves_literal_backslashes_and_escapes_control_characters() {
        let fs = Arc::new(ListingFs {
            entries: vec![entry("line\nname\\file.txt", false, 1)],
            ..Default::default()
        });
        let results = LSTool::new()
            .call_impl(&json!({"path": "."}), &context(fs, true))
            .await
            .unwrap();
        let (data, text) = result_parts(&results);
        assert_eq!(data["total"], 1);
        assert_eq!(data["entries"][0]["name"], "line\nname\\file.txt");
        assert_eq!(
            data["entries"][0]["path"],
            "/remote/workspace/line\nname\\file.txt"
        );
        assert!(text.contains("line\\nname\\\\file.txt"));
    }

    #[tokio::test]
    async fn listing_sorts_before_limiting_and_hidden_entries_do_not_consume_budget() {
        let fs = Arc::new(ListingFs {
            entries: vec![
                entry(".a", false, 5),
                entry(".b", false, 5),
                entry("old", false, 1),
                entry("new", false, 4),
            ],
            ..Default::default()
        });
        let result = LSTool::new()
            .call_impl(
                &json!({"path": ".", "limit": 1}),
                &context(fs.clone(), true),
            )
            .await
            .unwrap();
        let (data, text) = result_parts(&result);
        assert_eq!(data["total"], 1);
        assert_eq!(data["entries"][0]["name"], "new");
        assert_eq!(data["truncated"], true);
        assert!(text.contains("listing truncated"));
        assert_eq!(fs.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn listing_exact_limit_is_not_reported_as_truncated() {
        let fs = Arc::new(ListingFs {
            entries: vec![entry(".hidden", false, 2), entry("visible", false, 1)],
            ..Default::default()
        });
        let result = LSTool::new()
            .call_impl(&json!({"path": ".", "limit": 1}), &context(fs, true))
            .await
            .unwrap();
        let (data, _) = result_parts(&result);
        assert_eq!(data["total"], 1);
        assert_eq!(data["truncated"], false);
    }

    #[tokio::test]
    async fn listing_applies_nested_ignore_rules_and_skips_links_without_following_them() {
        let mut link = entry("external-link", true, 10);
        link.is_symlink = true;
        let fs = Arc::new(ListingFs {
            entries: vec![
                entry(".gitignore", false, 0),
                entry("drop.tmp", false, 0),
                entry("keep.tmp", false, 0),
                entry("src", true, 0),
                entry("node_modules", true, 0),
                link,
            ],
            children: HashMap::from([(
                "/remote/workspace/src".to_string(),
                vec![
                    entry("src/.gitignore", false, 0),
                    entry("src/drop.rs", false, 0),
                    entry("src/keep.rs", false, 0),
                ],
            )]),
            files: HashMap::from([
                (
                    "/remote/workspace/.gitignore".to_string(),
                    "*.tmp\n!keep.tmp".to_string(),
                ),
                (
                    "/remote/workspace/src/.gitignore".to_string(),
                    "drop.rs".to_string(),
                ),
            ]),
            ..Default::default()
        });
        let result = LSTool::new()
            .call_impl(&json!({"path": "."}), &context(fs.clone(), true))
            .await
            .unwrap();
        let (data, text) = result_parts(&result);
        assert_eq!(data["total"], 3);
        assert!(text.contains("keep.tmp"));
        assert!(text.contains("keep.rs"));
        assert!(!text.contains("drop."));
        assert!(!text.contains("external-link"));
        assert_eq!(fs.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn listing_reports_errors_instead_of_empty_success() {
        for error in [
            "Permission denied",
            "SSH connection lost",
            "No such directory",
        ] {
            let fs = Arc::new(ListingFs {
                error: Some(error),
                ..Default::default()
            });
            let failure = LSTool::new()
                .call_impl(&json!({"path": "."}), &context(fs, true))
                .await
                .expect_err("provider failure");
            assert!(failure.to_string().contains(error));
        }
    }

    #[test]
    fn ls_rejects_invalid_limits_without_an_implicit_default() {
        for limit in [json!(0), json!(-1), json!(1.5), json!("10")] {
            assert!(LSTool::new().parse_limit(&json!({"limit": limit})).is_err());
        }
        assert_eq!(LSTool::new().parse_limit(&json!({})), Ok(200));
    }
}
