use super::plan_artifact_diagnostics::{
    diagnose_plan_artifact, is_plan_artifact_path, PlanArtifactIssue,
};
use crate::agentic::tools::file_permissions::file_permission_intents_allowing_managed_plan_edits;
use crate::agentic::tools::file_tool_guidance::is_file_tool_guidance_message;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolPathResolution, ToolRenderOptions, ToolResult, ToolUseContext,
    ValidationResult,
};
use crate::agentic::tools::ToolPathOperation;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_tools::strip_invalid_windows_drive_path_prefix;
use openbitfun_core_types::product_identity::hidden_data_directory;
use serde_json::{json, Value};
use tool_runtime::fs::{
    write_file_success_outcome, write_same_content_outcome, WriteLocalFileOutcome,
};

pub struct FileWriteTool;

#[derive(Debug, PartialEq, Eq)]
enum ParsedWritePayload<'a> {
    Target {
        file_path: &'a str,
        content: &'a str,
    },
    MissingPath {
        content: &'a str,
    },
}

impl<'a> ParsedWritePayload<'a> {
    fn content(&self) -> &'a str {
        match self {
            Self::Target { content, .. } | Self::MissingPath { content } => content,
        }
    }
}

const WRITE_PAYLOAD_PATH_PREFIX: &str = "+++ ";
const WRITE_FALLBACK_DIRECTORY_PLACEHOLDER: &str = "__OPENBITFUN_WRITE_FALLBACK_DIRECTORY__";
const LARGE_WRITE_SOFT_LINE_LIMIT: usize = 200;
const LARGE_WRITE_SOFT_BYTE_LIMIT: usize = 20 * 1024;

fn write_fallback_directory() -> String {
    format!("{}/tmp", hidden_data_directory())
}

impl Default for FileWriteTool {
    fn default() -> Self {
        Self::new()
    }
}

impl FileWriteTool {
    pub fn new() -> Self {
        Self
    }

    async fn file_exists(
        context: &ToolUseContext,
        resolved: &ToolPathResolution,
    ) -> OpenBitFunResult<bool> {
        context
            .file_system_for_path(resolved)?
            .exists(&resolved.resolved_path)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!("Failed to check whether file exists: {:#}", error))
            })
    }

    async fn existing_file_matches_content(
        context: &ToolUseContext,
        resolved: &ToolPathResolution,
        content: &str,
    ) -> OpenBitFunResult<bool> {
        let existing = context
            .file_system_for_path(resolved)?
            .read_file(&resolved.resolved_path)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to read existing file {} before writing: {:#}",
                    resolved.logical_path, error
                ))
            })?;
        Ok(existing == content.as_bytes())
    }

    pub(crate) async fn preflight_write_error(
        context: &ToolUseContext,
        file_path: &str,
    ) -> Option<String> {
        let resolved = match context.resolve_tool_path(file_path) {
            Ok(resolved) => resolved,
            Err(err) => return Some(err.to_string()),
        };

        if let Err(err) = context.enforce_path_operation(ToolPathOperation::Write, &resolved) {
            return Some(err.to_string());
        }

        Self::file_exists(context, &resolved)
            .await
            .err()
            .map(|error| error.to_string())
    }

    fn parse_payload(input: &Value) -> Result<ParsedWritePayload<'_>, String> {
        let value = input
            .get("payload")
            .and_then(Value::as_str)
            .ok_or_else(|| "payload is required".to_string())?;
        let (first_line, content) = value.split_once('\n').unwrap_or((value, ""));
        let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
        let Some(file_path) = first_line.strip_prefix(WRITE_PAYLOAD_PATH_PREFIX) else {
            return Ok(ParsedWritePayload::MissingPath { content: value });
        };
        if file_path.trim().is_empty() {
            return Ok(ParsedWritePayload::MissingPath { content: value });
        }

        Ok(ParsedWritePayload::Target { file_path, content })
    }

    fn fallback_file_path(context: &ToolUseContext) -> String {
        let stable_id = context
            .tool_call_id
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .rev()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(12)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        let stable_id = if stable_id.is_empty() {
            "unknown"
        } else {
            stable_id.as_str()
        };
        format!("{}/write_{stable_id}.tmp", write_fallback_directory())
    }

    fn ignored_top_level_parameter_names(input: &Value) -> Vec<String> {
        let mut parameter_names = input
            .as_object()
            .into_iter()
            .flat_map(|object| object.keys())
            .filter(|name| !matches!(name.as_str(), "payload" | "force"))
            .cloned()
            .collect::<Vec<_>>();
        parameter_names.sort();
        parameter_names
    }

    fn write_success_result(
        logical_path: &str,
        outcome: WriteLocalFileOutcome,
        missing_path_fallback: bool,
        path_format_warning: Option<&str>,
        ignored_parameter_names: &[String],
        plan_artifact_issues: Option<&[PlanArtifactIssue]>,
    ) -> ToolResult {
        let mut assistant_message = if missing_path_fallback {
            format!(
                "The entire payload was saved to {}. Use your shell tool to move this file to the intended path. Do not call Write to resubmit the same content because doing so wastes tokens and time. This happened because the Write payload did not start with the required '+++ {{file_path}}' marker. Future Write calls must follow the required payload format.",
                logical_path
            )
        } else {
            outcome.assistant_message
        };
        if let Some(warning) = path_format_warning {
            assistant_message.push(' ');
            assistant_message.push_str(warning);
        }
        if !ignored_parameter_names.is_empty() {
            let formatted_names = ignored_parameter_names
                .iter()
                .map(|name| format!("`{}`", name))
                .collect::<Vec<_>>()
                .join(", ");
            assistant_message.push_str(&format!(
                " The Write tool accepts only the `payload` parameter; these additional parameters were ignored and should not be passed again: {}.",
                formatted_names
            ));
        }
        if let Some(issues) = plan_artifact_issues.filter(|issues| !issues.is_empty()) {
            assistant_message.push_str("\nThe `.plan.md` artifact does not match the plan format:");
            for issue in issues {
                assistant_message.push_str("\n- ");
                assistant_message.push_str(&issue.message);
            }
            assistant_message
                .push_str("\nUse Edit on the written file to fix these issues before finishing.");
        }
        let mut data = json!({
            "file_path": logical_path,
            "bytes_written": outcome.bytes_written,
            "lines_written": outcome.lines_written,
            "success": true,
            "status": outcome.status.as_str(),
            "missing_path_fallback": missing_path_fallback,
            "rename_required": missing_path_fallback,
            "path_format_corrected": path_format_warning.is_some(),
            "path_format_warning": path_format_warning,
            "message": assistant_message,
        });
        if let Some(issues) = plan_artifact_issues {
            data["plan_format"] = json!({
                "valid": issues.is_empty(),
                "issues": issues
                    .iter()
                    .map(|issue| json!({
                        "code": issue.code,
                        "message": issue.message.as_str(),
                    }))
                    .collect::<Vec<_>>(),
            });
        }
        ToolResult::Result {
            data,
            result_for_assistant: Some(assistant_message),
            image_attachments: None,
        }
    }

    fn path_format_correction_warning(resolved: &ToolPathResolution) -> Option<String> {
        strip_invalid_windows_drive_path_prefix(&resolved.requested_path)?;
        Some(format!(
            "The provided Windows path '{}' had an invalid leading '/'. It was normalized to '{}'. Use a drive-letter path without the leading '/' in future Write calls.",
            resolved.requested_path, resolved.logical_path
        ))
    }

    fn input_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "payload": {
                    "type": "string",
                    "description": "A path-first Write payload in the format `+++ {absolute_file_path_or_openbitfun_uri}\n{file_content}`. Content lines do not need a leading `+`."
                }
            },
            "required": ["payload"],
            "additionalProperties": false
        })
    }

    fn description() -> String {
        r#"Create or overwrite a file.

Parameter: `payload` (a single string)
- Format: `+++ {file_path}\n{file_content}`
- This is a path-first Write payload format: the first line uses Git's `+++` marker to specify the target file, but content lines do NOT need a leading `+`. Do not include `---`, `@@`, or other Git diff headers.
- `{file_path}` must be an absolute path or an exact `openbitfun://...` URI. Everything after the first newline is the complete content to write to that file.
- The `+++ ` marker is required. If it is missing or has no file path, the tool saves the entire `payload` unchanged to `__OPENBITFUN_WRITE_FALLBACK_DIRECTORY__/write_{suffix}.tmp` in the workspace.
- Do NOT pass `path`, `file_path`, or `content`, etc. They are not valid parameters for this tool. Only `payload` is accepted.

Usage:
- This tool creates the file if it does not exist; otherwise, it overwrites the existing file.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.

Examples:
<good-example platform="macos-linux">
`{"payload":"+++ /example/main.py\ndef main():\n\tprint(\"Hello world\")\n\nmain()"}`

This call creates or overwrites `/example/main.py` with the following content:
```
def main():
	print("Hello world")

main()
```
</good-example>

<good-example platform="windows">
`{"payload":"+++ C:/foo/main.py\ndef main():\n\tprint(\"Hello world\")\n\nmain()"}`
</good-example>

<bad-example>
`{"file_path":"/example/main.py","content":"print(\"Hello world\")"}`

This call is invalid because Write requires the single `payload` parameter. Do not pass `file_path` and `content` separately.
</bad-example>

<bad-example>
`{"payload":"+++ /example/main.py\nprint(\"Hello world\")","file_path":"/example/main.py"}`

This call includes an unnecessary `file_path` parameter. Write only uses `payload`; specify the target path in the first `+++ {file_path}` line and do not pass additional parameters.
</bad-example>
"#
            .replace(
                WRITE_FALLBACK_DIRECTORY_PLACEHOLDER,
                &write_fallback_directory(),
            )
    }
}

#[async_trait]
impl Tool for FileWriteTool {
    fn name(&self) -> &str {
        "Write"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(FileWriteTool::description())
    }

    fn short_description(&self) -> String {
        "Write or overwrite a file.".to_string()
    }

    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        Ok(FileWriteTool::description())
    }

    fn input_schema(&self) -> Value {
        FileWriteTool::input_schema()
    }

    async fn input_schema_for_model(&self) -> Value {
        FileWriteTool::input_schema()
    }

    async fn input_schema_for_model_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> Value {
        FileWriteTool::input_schema()
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
        let parsed = Self::parse_payload(input).map_err(OpenBitFunError::validation)?;
        let file_path = match parsed {
            ParsedWritePayload::Target { file_path, .. } => file_path.to_string(),
            ParsedWritePayload::MissingPath { .. } => Self::fallback_file_path(context),
        };
        file_permission_intents_allowing_managed_plan_edits("edit", [file_path.as_str()], context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let parsed = match Self::parse_payload(input) {
            Ok(parsed) => parsed,
            Err(message) => {
                return ValidationResult {
                    result: false,
                    message: Some(message),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        let content = parsed.content();
        let line_count = content.lines().count();
        let byte_count = content.len();
        let large_write_warning = if line_count > LARGE_WRITE_SOFT_LINE_LIMIT
            || byte_count > LARGE_WRITE_SOFT_BYTE_LIMIT
        {
            Some((line_count, byte_count))
        } else {
            None
        };

        if let ParsedWritePayload::Target { file_path, .. } = &parsed {
            let force_requested = input.get("force").and_then(Value::as_bool).unwrap_or(false);
            if let Some(rejection) = crate::agentic::execution::edit_constraint_guard::check_write(
                context,
                "Write",
                "write",
                file_path,
                force_requested,
            )
            .await
            {
                return rejection;
            }
        }

        if let Some(ctx) = context {
            let preflight_error = match &parsed {
                ParsedWritePayload::Target { file_path, .. } => {
                    Self::preflight_write_error(ctx, file_path).await
                }
                ParsedWritePayload::MissingPath { .. } => {
                    let fallback_path = Self::fallback_file_path(ctx);
                    match ctx.resolve_tool_path(&fallback_path) {
                        Ok(resolved) => ctx
                            .enforce_path_operation(ToolPathOperation::Write, &resolved)
                            .err()
                            .map(|error| error.to_string()),
                        Err(error) => Some(error.to_string()),
                    }
                }
            };
            if let Some(message) = preflight_error {
                let is_guidance = is_file_tool_guidance_message(&message);
                return ValidationResult {
                    result: false,
                    message: Some(message),
                    error_code: Some(400),
                    meta: is_guidance.then(|| json!({ "failure_kind": "guidance" })),
                };
            }
        }

        if let Some((line_count, byte_count)) = large_write_warning {
            return ValidationResult {
                result: true,
                message: Some(format!(
                    "Large Write payload: {} lines, {} bytes. This is allowed when necessary, but prefer a staged approach: for existing files use Read + focused Edit calls; for large new files write a stable scaffold first, then add sections in follow-up edits unless a complete initial body is required.",
                    line_count, byte_count
                )),
                error_code: None,
                meta: Some(json!({
                    "large_write": true,
                    "line_count": line_count,
                    "byte_count": byte_count,
                    "soft_line_limit": LARGE_WRITE_SOFT_LINE_LIMIT,
                    "soft_byte_limit": LARGE_WRITE_SOFT_BYTE_LIMIT
                })),
            };
        }

        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        match Self::parse_payload(input) {
            Ok(ParsedWritePayload::Target { file_path, content }) => {
                if options.verbose {
                    format!("Writing {} characters to {}", content.len(), file_path)
                } else {
                    format!("Write {}", file_path)
                }
            }
            Ok(ParsedWritePayload::MissingPath { content }) => {
                if options.verbose {
                    format!(
                        "Writing {} characters to a workspace temporary file",
                        content.len()
                    )
                } else {
                    "Write workspace temporary file".to_string()
                }
            }
            Err(_) => "Writing file".to_string(),
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let ignored_parameter_names = Self::ignored_top_level_parameter_names(input);
        let parsed = Self::parse_payload(input).map_err(OpenBitFunError::tool)?;
        let (file_path, content, missing_path_fallback) = match parsed {
            ParsedWritePayload::Target { file_path, content } => {
                (file_path.to_string(), content.to_string(), false)
            }
            ParsedWritePayload::MissingPath { content } => {
                (Self::fallback_file_path(context), content.to_string(), true)
            }
        };

        let resolved = context.resolve_tool_path(&file_path)?;
        let path_format_warning = Self::path_format_correction_warning(&resolved);
        let plan_artifact_issues =
            is_plan_artifact_path(&resolved.logical_path).then(|| diagnose_plan_artifact(&content));
        context.enforce_path_operation(ToolPathOperation::Write, &resolved)?;
        context
            .record_light_checkpoint(
                "Write",
                &resolved.logical_path,
                vec![resolved.logical_path.clone()],
            )
            .await?;

        let file_already_exists = Self::file_exists(context, &resolved).await?;
        if file_already_exists
            && Self::existing_file_matches_content(context, &resolved, &content).await?
        {
            let result = Self::write_success_result(
                &resolved.logical_path,
                write_same_content_outcome(&resolved.logical_path),
                missing_path_fallback,
                path_format_warning.as_deref(),
                &ignored_parameter_names,
                plan_artifact_issues.as_deref(),
            );
            return Ok(vec![result]);
        }

        context
            .file_system_for_path(&resolved)?
            .write_file(&resolved.resolved_path, content.as_bytes())
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to write file {}: {:#}",
                    resolved.logical_path, error
                ))
            })?;
        let outcome =
            write_file_success_outcome(&resolved.logical_path, file_already_exists, &content);

        crate::agentic::execution::edit_constraint_guard::record_mutation_applied(
            context,
            "Write",
            "write",
            &resolved.logical_path,
        )
        .await;
        if !file_already_exists {
            crate::agentic::execution::edit_constraint_guard::remember_agent_created_file(
                context,
                &resolved.logical_path,
            )
            .await;
        }

        let result = Self::write_success_result(
            &resolved.logical_path,
            outcome,
            missing_path_fallback,
            path_format_warning.as_deref(),
            &ignored_parameter_names,
            plan_artifact_issues.as_deref(),
        );

        Ok(vec![result])
    }
}

#[cfg(test)]
mod tests {
    use super::{diagnose_plan_artifact, FileWriteTool};
    use crate::agentic::tools::file_tool_guidance::{
        file_tool_guidance_message, is_file_tool_guidance_message, FILE_TOOL_GUIDANCE_PREFIX,
    };
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use async_trait::async_trait;
    use openbitfun_runtime_ports::{
        ToolRuntimeHandles, WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        WorkspaceFileSystem, WorkspaceServices, WorkspaceShell,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn local_context(root: PathBuf) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(None, root)),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    struct RemoteWriteFs {
        expected_path: String,
        read_error: Option<&'static str>,
        exists: Result<bool, &'static str>,
        writes: AtomicUsize,
    }

    #[async_trait]
    impl WorkspaceFileSystem for RemoteWriteFs {
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            assert_eq!(path, self.expected_path);
            if let Some(error) = self.read_error {
                anyhow::bail!(error);
            }
            Ok(b"original content".to_vec())
        }

        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            assert_eq!(path, self.expected_path);
            Ok("original content".to_string())
        }

        async fn write_file(&self, path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            assert_eq!(path, self.expected_path);
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn exists(&self, path: &str) -> anyhow::Result<bool> {
            assert_eq!(path, self.expected_path);
            self.exists.map_err(anyhow::Error::msg)
        }

        async fn is_file(&self, _path: &str) -> anyhow::Result<bool> {
            panic!("Write must use its existence probe")
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            panic!("Write must use its existence probe")
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            panic!("Write must not list directories")
        }
    }

    struct UnusedRemoteShell;

    #[async_trait]
    impl WorkspaceShell for UnusedRemoteShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            _options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            panic!("Write must not fall back to a shell")
        }
    }

    fn remote_context(fs: Arc<RemoteWriteFs>) -> ToolUseContext {
        let root = "/remote/workspace";
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            root,
            Some("write-test-ssh"),
            Some("write-test-host"),
        )
        .expect("remote identity");
        let mut context = local_context(PathBuf::from(root));
        context.workspace = Some(WorkspaceBinding::new_remote(
            None,
            PathBuf::from(root),
            "write-test-ssh".to_string(),
            "write-test-host".to_string(),
            identity,
        ));
        context.runtime_handles = ToolRuntimeHandles::new(
            Some(WorkspaceServices {
                fs,
                shell: Arc::new(UnusedRemoteShell),
            }),
            None,
        );
        context
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_and_remote_write_edit_share_the_bound_filesystem_and_results() {
        use crate::agentic::tools::implementations::file_edit_tool::FileEditTool;
        let mut outcomes = Vec::new();
        for remote in [false, true] {
            let fs = Arc::new(RemoteWriteFs {
                expected_path: "/remote/workspace/result.txt".into(),
                read_error: None,
                exists: Ok(false),
                writes: AtomicUsize::new(0),
            });
            let mut context = remote_context(fs.clone());
            if !remote {
                context.workspace = Some(WorkspaceBinding::new(
                    None,
                    PathBuf::from("/remote/workspace"),
                ));
            }
            let write = FileWriteTool::new()
                .call_impl(&json!({"payload": "+++ result.txt\nnew content"}), &context)
                .await
                .expect("Write must use the injected provider for either workspace kind");
            let edit = FileEditTool::new().call_impl(
                &json!({"file_path": "result.txt", "old_string": "original", "new_string": "updated"}),
                &context,
            ).await.expect("Edit must use the injected provider for either workspace kind");
            assert_eq!(fs.writes.load(Ordering::SeqCst), 2);
            outcomes.push((write[0].content(), edit[0].content()));
        }
        assert_eq!(outcomes[0], outcomes[1]);
    }

    #[tokio::test]
    async fn write_never_overwrites_an_unreadable_existing_file() {
        for remote in [false, true] {
            let root = if remote {
                PathBuf::from("/remote/workspace")
            } else {
                std::env::temp_dir().join("openbitfun-write-unreadable-fixture")
            };
            let expected_path = if remote {
                "/remote/workspace/result.txt".to_string()
            } else {
                root.join("result.txt").to_string_lossy().into_owned()
            };
            let fs = Arc::new(RemoteWriteFs {
                expected_path,
                exists: Ok(true),
                read_error: Some("Permission denied"),
                writes: AtomicUsize::new(0),
            });
            let mut context = remote_context(fs.clone());
            if !remote {
                context.workspace = Some(WorkspaceBinding::new(None, root));
            }
            let result = FileWriteTool::new()
                .call_impl(&json!({"payload":"+++ result.txt\nreplacement"}), &context)
                .await;
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("Permission denied"));
            assert_eq!(fs.writes.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn remote_write_does_not_treat_probe_failures_as_new_files() {
        for error in ["Permission denied", "SSH connection lost"] {
            let fs = Arc::new(RemoteWriteFs {
                expected_path: "/remote/workspace/result.txt".into(),
                read_error: None,
                exists: Err(error),
                writes: AtomicUsize::new(0),
            });
            let context = remote_context(fs.clone());
            let input = json!({"payload": "+++ result.txt\nreplacement"});
            let tool = FileWriteTool::new();
            let validation = tool.validate_input(&input, Some(&context)).await;
            assert!(!validation.result);
            assert!(validation.message.unwrap().contains(error));
            let failure = tool
                .call_impl(&input, &context)
                .await
                .expect_err("failed metadata must prevent write even without preflight");
            assert!(failure.to_string().contains(error));
            assert_eq!(fs.writes.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn remote_write_preserves_new_file_and_identical_retry_behavior() {
        for (exists, content, expected_writes) in
            [(false, "new content", 1), (true, "original content", 0)]
        {
            let fs = Arc::new(RemoteWriteFs {
                expected_path: "/remote/workspace/result.txt".into(),
                read_error: None,
                exists: Ok(exists),
                writes: AtomicUsize::new(0),
            });
            let context = remote_context(fs.clone());
            FileWriteTool::new()
                .call_impl(
                    &json!({"payload": format!("+++ result.txt\n{content}")}),
                    &context,
                )
                .await
                .expect("successful existence probe should retain Write behavior");
            assert_eq!(fs.writes.load(Ordering::SeqCst), expected_writes);
        }
    }

    #[tokio::test]
    async fn remote_write_requires_its_workspace_filesystem() {
        let mut context = remote_context(Arc::new(RemoteWriteFs {
            expected_path: "/remote/workspace/result.txt".into(),
            read_error: None,
            exists: Ok(false),
            writes: AtomicUsize::new(0),
        }));
        context.runtime_handles = ToolRuntimeHandles::default();
        let failure = FileWriteTool::preflight_write_error(&context, "result.txt")
            .await
            .expect("missing remote provider must fail preflight");
        assert!(failure.contains("Remote workspace file system is unavailable"));
    }

    #[test]
    fn guidance_prefix_helpers_round_trip() {
        let message = file_tool_guidance_message("Use Read first.");
        assert!(is_file_tool_guidance_message(&message));
        assert_eq!(
            message.strip_prefix(FILE_TOOL_GUIDANCE_PREFIX).unwrap(),
            "Use Read first."
        );
    }

    #[tokio::test]
    async fn preflight_write_error_allows_new_file_target() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");

        let error =
            FileWriteTool::preflight_write_error(&local_context(root.clone()), "new.txt").await;

        let _ = std::fs::remove_dir_all(&root);

        assert!(error.is_none());
    }

    #[tokio::test]
    async fn preflight_write_error_allows_existing_file() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");
        std::fs::write(root.join("existing.md"), "already here").expect("create existing file");

        let error =
            FileWriteTool::preflight_write_error(&local_context(root.clone()), "existing.md").await;

        let _ = std::fs::remove_dir_all(&root);

        assert!(error.is_none());
    }

    #[tokio::test]
    async fn call_impl_treats_identical_existing_content_as_success() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");
        std::fs::write(root.join("existing.md"), "same content").expect("create existing file");

        let tool = FileWriteTool::new();
        let results = tool
            .call(
                &json!({ "payload": "+++ existing.md\nsame content" }),
                &local_context(root.clone()),
            )
            .await
            .expect("identical retry should be idempotent");

        let _ = std::fs::remove_dir_all(&root);

        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["success"], true);
        assert_eq!(data["bytes_written"], 0);
        assert_eq!(data["lines_written"], 0);
        assert_eq!(data["status"], "already_exists_same_content");
        assert!(result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("identical content"));
    }

    #[tokio::test]
    async fn call_impl_overwrites_different_existing_content() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");
        std::fs::write(root.join("existing.md"), "old content").expect("create existing file");

        let tool = FileWriteTool::new();
        let results = tool
            .call(
                &json!({ "payload": "+++ existing.md\nnew content" }),
                &local_context(root.clone()),
            )
            .await
            .expect("write should overwrite existing files");

        let written = std::fs::read_to_string(root.join("existing.md")).expect("read file");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(written, "new content");

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected result");
        };
        assert_eq!(data["status"], "overwritten");
        assert_eq!(data["bytes_written"], "new content".len());
        assert_eq!(data["lines_written"], 1);
    }

    #[tokio::test]
    async fn call_impl_appends_warning_for_ignored_top_level_parameters() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");

        let tool = FileWriteTool::new();
        let input = json!({
            "payload": "+++ new.txt\nalpha",
            "content": "ignored content",
            "file_path": "ignored.txt"
        });
        let validation = tool.validate_input(&input, None).await;
        assert!(validation.result);

        let results = tool
            .call(&input, &local_context(root.clone()))
            .await
            .expect("extra parameters should be ignored");

        let _ = std::fs::remove_dir_all(&root);

        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        let result_path = data["file_path"].as_str().expect("result file path");
        let expected = format!(
            "Successfully created {} (1 lines, 5 bytes). The Write tool accepts only the `payload` parameter; these additional parameters were ignored and should not be passed again: `content`, `file_path`.",
            result_path
        );
        assert_eq!(result_for_assistant.as_deref(), Some(expected.as_str()));
        assert_eq!(data["message"], expected);
    }

    #[tokio::test]
    async fn validate_input_stale_force_without_runtime_context_respects_guard_gate() {
        let tool = FileWriteTool::new();
        let input = json!({
            "payload": "+++ new.txt\nalpha",
            "force": true
        });
        for enabled in [false, true, false] {
            let validation = crate::agentic::execution::edit_constraint_guard::TEST_ENABLED
                .scope(enabled, tool.validate_input(&input, None))
                .await;

            assert_eq!(validation.result, !enabled);
            if enabled {
                assert_eq!(validation.error_code, Some(403));
                assert!(validation.blocks_input_rewrite());
                assert_eq!(
                    validation
                        .meta
                        .as_ref()
                        .and_then(|meta| meta["guard_decision"].as_str()),
                    Some("force_denied")
                );
            } else {
                assert!(!validation.blocks_input_rewrite());
            }
        }
    }

    #[tokio::test]
    async fn call_impl_accepts_path_only_for_empty_file() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");

        let tool = FileWriteTool::new();
        let results = tool
            .call(
                &json!({ "payload": "+++ empty.txt" }),
                &local_context(root.clone()),
            )
            .await
            .expect("path-only input should create an empty file");

        let written = std::fs::read(root.join("empty.txt")).expect("read empty file");
        let _ = std::fs::remove_dir_all(&root);

        assert!(written.is_empty());
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected result");
        };
        assert_eq!(data["bytes_written"], 0);
        assert_eq!(data["lines_written"], 0);
    }

    #[tokio::test]
    async fn schema_requires_single_payload_parameter() {
        let tool = FileWriteTool::new();

        let schema = tool.input_schema_for_model().await;

        assert_eq!(schema["required"], serde_json::json!(["payload"]));
        assert_eq!(
            schema["properties"].as_object().map(|value| value.len()),
            Some(1)
        );
        assert!(schema["properties"].get("payload").is_some());
        assert!(schema["properties"].get("mode").is_none());
    }

    #[tokio::test]
    async fn validate_input_requires_payload() {
        let tool = FileWriteTool::new();

        let validation = tool.validate_input(&json!({}), None).await;

        assert!(!validation.result);
        assert_eq!(validation.message.as_deref(), Some("payload is required"));
    }

    #[tokio::test]
    async fn validate_input_accepts_path_only_for_empty_file() {
        let tool = FileWriteTool::new();

        let validation = tool
            .validate_input(&json!({ "payload": "+++ C:/workspace/empty.txt" }), None)
            .await;

        assert!(validation.result);
        assert!(validation.message.is_none());
    }

    #[test]
    fn write_success_result_reports_non_blocking_plan_issues() {
        let logical_path = ".openbitfun/plans/example.plan.md";
        let content = "---\nname: Example\noverview: Overview\ntodos: []\n---\n";
        let issues = diagnose_plan_artifact(content);

        let result = FileWriteTool::write_success_result(
            logical_path,
            super::write_file_success_outcome(logical_path, false, content),
            false,
            None,
            &[],
            Some(&issues),
        );
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = result
        else {
            panic!("expected result");
        };

        assert_eq!(data["success"], true);
        assert_eq!(data["plan_format"]["valid"], false);
        assert_eq!(
            data["plan_format"]["issues"][0]["code"],
            "missing_markdown_body"
        );
        let assistant_message = result_for_assistant.as_deref().unwrap_or_default();
        assert!(assistant_message.contains("does not match the plan format"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn write_result_reports_normalized_windows_drive_path() {
        let tool = FileWriteTool::new();
        let context = local_context(PathBuf::from(r"E:\workspace"));
        let requested_path = "/E:/workspace/project/example.txt";

        let validation = tool
            .validate_input(
                &json!({
                    "payload": format!("+++ {requested_path}\ncontent")
                }),
                Some(&context),
            )
            .await;
        assert!(validation.result);
        assert!(validation.message.is_none());

        let resolved = context
            .resolve_tool_path(requested_path)
            .expect("mixed Windows path should be normalized");
        assert_eq!(
            PathBuf::from(&resolved.logical_path),
            PathBuf::from(r"E:\workspace\project\example.txt")
        );

        let warning = FileWriteTool::path_format_correction_warning(&resolved)
            .expect("normalization should produce a warning");
        let result = FileWriteTool::write_success_result(
            &resolved.logical_path,
            super::write_file_success_outcome(&resolved.logical_path, false, "content"),
            false,
            Some(&warning),
            &[],
            None,
        );
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = result
        else {
            panic!("expected result");
        };

        assert_eq!(data["path_format_corrected"], true);
        assert_eq!(data["path_format_warning"], warning);
        assert!(warning.contains(requested_path));
        assert!(warning.contains(r"E:\workspace\project\example.txt"));
        assert!(result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains(&warning));
    }

    #[test]
    fn parse_payload_recognizes_marked_path_with_lf_or_crlf() {
        for value in [
            "+++ C:/workspace/main.rs\nfn main() {}",
            "+++ C:/workspace/main.rs\r\nfn main() {}",
        ] {
            let input = json!({ "payload": value });
            let parsed = FileWriteTool::parse_payload(&input).expect("valid payload");

            assert_eq!(
                parsed,
                super::ParsedWritePayload::Target {
                    file_path: "C:/workspace/main.rs",
                    content: "fn main() {}",
                }
            );
        }
    }

    #[test]
    fn parse_payload_treats_missing_or_empty_marker_path_as_fallback_content() {
        for value in ["content", "\ncontent", "+++", "+++ \ncontent"] {
            let input = json!({ "payload": value });
            let parsed = FileWriteTool::parse_payload(&input).expect("fallback payload");

            assert_eq!(
                parsed,
                super::ParsedWritePayload::MissingPath { content: value }
            );
        }
    }

    #[test]
    fn fallback_file_path_uses_workspace_tmp_directory_and_tool_call_id_suffix() {
        let mut context = local_context(PathBuf::from("C:/workspace"));
        context.tool_call_id = Some("toolcall-0123456789abcdef".to_string());

        assert_eq!(
            FileWriteTool::fallback_file_path(&context),
            ".openbitfun/tmp/write_456789abcdef.tmp"
        );
    }

    #[tokio::test]
    async fn call_impl_preserves_malformed_payload_in_workspace_temp_file() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-write-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp workspace");
        let original_payload = "def main():\n    print(\"Hello world\")";

        let mut context = local_context(root.clone());
        context.tool_call_id = Some("fallback123".to_string());
        let results = FileWriteTool::new()
            .call(&json!({ "payload": original_payload }), &context)
            .await
            .expect("malformed payload should be preserved");

        let fallback_directory = root.join(".openbitfun").join("tmp");
        let entries = std::fs::read_dir(&fallback_directory)
            .expect("read workspace fallback directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect workspace entries");
        assert_eq!(entries.len(), 1);
        let file_name = entries[0].file_name().to_string_lossy().into_owned();
        assert_eq!(file_name, "write_fallback123.tmp");
        assert_eq!(
            std::fs::read_to_string(entries[0].path()).expect("read fallback file"),
            original_payload
        );

        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        let result_path = data["file_path"].as_str().expect("result file path");
        assert_eq!(
            Path::new(result_path)
                .file_name()
                .and_then(|value| value.to_str()),
            Some(file_name.as_str())
        );
        assert_eq!(data["missing_path_fallback"], true);
        assert_eq!(data["rename_required"], true);
        let assistant_message = result_for_assistant.as_deref().unwrap_or_default();
        assert!(assistant_message
            .contains("Use your shell tool to move this file to the intended path"));
        assert!(assistant_message.contains(
            "Do not call Write to resubmit the same content because doing so wastes tokens and time"
        ));
        assert!(assistant_message.contains(
            "the Write payload did not start with the required '+++ {file_path}' marker"
        ));
        assert!(assistant_message
            .contains("Future Write calls must follow the required payload format"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
