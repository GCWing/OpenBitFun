use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
#[cfg(feature = "tools-miniapp")]
use crate::agentic::tools::miniapp_context_runtime::{
    is_virtual_context_path, requires_virtual_context_path, virtual_context_files_for_search,
};
use crate::agentic::tools::parse_u64_value;
use crate::agentic::tools::ToolPathOperation;
use crate::service::search::{
    get_global_workspace_search_service, remote_workspace_search_service_for_workspace,
    workspace_search_feature_enabled, workspace_search_runtime_available, ContentSearchOutputMode,
    ContentSearchRequest, WorkspaceSearchHit, WorkspaceSearchLine,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;
#[cfg(feature = "tools-miniapp")]
use tool_runtime::search::grep_search::grep_search_virtual_files;
use tool_runtime::search::grep_search::{
    apply_offset_and_limit, grep_search, grep_search_workspace, relativize_result_text,
    GrepOptions, GrepSearchResult, OutputMode, ProgressCallback,
};

const DEFAULT_HEAD_LIMIT: usize = 250;

/// Prefixed to workspace-search output when the daemon's worktree view is behind.
///
/// No search path waits for the daemon to reconcile the worktree: on a large repository that wait is
/// seconds, and it would land on whichever query happened to come first. The staleness is stated
/// instead. That keeps the failure mode legible — a caller that just edited a file can reconcile the
/// difference itself, but only if it is told the view may predate the edit.
pub(crate) const WORKSPACE_PROBE_PENDING_NOTE: &str = "Note: the workspace index is still folding in recent worktree changes, so these results describe the repository as of a moment ago. Very recent edits may be missing; re-run the search if a match you expect is absent.";

/// Prepends [`WORKSPACE_PROBE_PENDING_NOTE`] to `body` when the daemon reported a pending probe.
pub(crate) fn annotate_workspace_probe_pending(
    body: String,
    workspace_probe_pending: bool,
) -> String {
    if !workspace_probe_pending {
        return body;
    }
    if body.is_empty() {
        return WORKSPACE_PROBE_PENDING_NOTE.to_string();
    }
    format!("{WORKSPACE_PROBE_PENDING_NOTE}\n\n{body}")
}

pub struct GrepTool;

impl Default for GrepTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GrepTool {
    pub fn new() -> Self {
        Self
    }

    fn explicit_head_limit(input: &Value) -> Option<Option<usize>> {
        input
            .get("head_limit")
            .and_then(parse_u64_value)
            .map(|value| {
                if value == 0 {
                    None
                } else {
                    Some(value as usize)
                }
            })
    }

    fn resolve_head_limit(input: &Value) -> Option<usize> {
        Self::explicit_head_limit(input).unwrap_or(Some(DEFAULT_HEAD_LIMIT))
    }

    fn backend_max_results(
        input: &Value,
        offset: usize,
        _display_head_limit: Option<usize>,
    ) -> Option<usize> {
        Self::explicit_head_limit(input)
            .flatten()
            .map(|limit| limit.saturating_add(offset))
    }

    fn parse_glob_patterns(glob: Option<&str>) -> Vec<String> {
        let Some(glob) = glob else {
            return Vec::new();
        };

        let mut patterns = Vec::new();
        for raw_pattern in glob.split_whitespace() {
            if raw_pattern.contains('{') && raw_pattern.contains('}') {
                patterns.push(raw_pattern.to_string());
            } else {
                patterns.extend(
                    raw_pattern
                        .split(',')
                        .filter(|pattern| !pattern.is_empty())
                        .map(|pattern| pattern.to_string()),
                );
            }
        }
        patterns
    }

    fn resolve_offset(input: &Value) -> usize {
        input
            .get("offset")
            .and_then(parse_u64_value)
            .map(|value| value as usize)
            .unwrap_or(0)
    }

    fn display_base(context: &ToolUseContext) -> Option<String> {
        context
            .workspace
            .as_ref()
            .map(|workspace| workspace.root_path_string())
    }

    async fn call_workspace_io(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let resolved =
            context.resolve_tool_path(input.get("path").and_then(Value::as_str).unwrap_or("."))?;
        let fs = context.file_system_for_path(&resolved)?;
        let options = self.build_grep_options(input, context)?;
        let pattern = options.pattern.clone();
        let output_mode = options.output_mode.to_string();
        let search = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            grep_search_workspace(options, fs.as_ref(), context.ws_shell()),
        )
        .await
        .map_err(|_| {
            OpenBitFunError::tool(
                "Workspace search timed out after 30000ms; narrow the search path".to_string(),
            )
        })?
        .map_err(OpenBitFunError::tool)?;
        let result = search.result;
        let mut assistant_text = result.result_text.clone();
        if !search.used_rg_candidates && !search.used_grep_candidates {
            assistant_text.push_str(&format!(
                "\nSearch used workspace file streams without a compatible target prefilter ({} files, {} bytes read).",
                search.scanned_file_count, search.scanned_bytes,
            ));
        }
        assistant_text.push_str("\nIgnore rules are limited to .gitignore/.ignore files under the search path; other target Git/global excludes are not applied.");
        Ok(vec![ToolResult::Result {
            data: json!({
                "pattern": pattern,
                "path": resolved.logical_path,
                "output_mode": output_mode,
                "file_count": result.file_count,
                "total_matches": result.total_matches,
                "applied_limit": result.applied_limit,
                "applied_offset": result.applied_offset,
                "result": result.result_text,
                "search_backend": if search.used_rg_candidates { "rg_candidates_workspace_io" } else if search.used_grep_candidates { "grep_candidates_workspace_io" } else { "workspace_io" },
                "scanned_file_count": search.scanned_file_count,
                "scanned_bytes": search.scanned_bytes,
                "ignore_scope": "search_path",
            }),
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }])
    }

    fn build_grep_options(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<GrepOptions> {
        let pattern = input
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("pattern is required".to_string()))?;

        let search_path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let resolved = context.resolve_tool_path(search_path)?;
        let resolved_path = resolved.resolved_path.clone();

        let case_insensitive = input.get("-i").and_then(|v| v.as_bool()).unwrap_or(false);
        let multiline = input
            .get("multiline")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let output_mode_str = input
            .get("output_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("files_with_matches");
        let output_mode = OutputMode::from_str(output_mode_str)
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        let show_line_numbers = input
            .get("-n")
            .and_then(|v| v.as_bool())
            .unwrap_or(output_mode_str == "content");
        let context_c = input
            .get("context")
            .or_else(|| input.get("-C"))
            .and_then(parse_u64_value)
            .map(|v| v as usize);
        let before_context = input
            .get("-B")
            .and_then(parse_u64_value)
            .map(|v| v as usize);
        let after_context = input
            .get("-A")
            .and_then(parse_u64_value)
            .map(|v| v as usize);
        let head_limit = Self::resolve_head_limit(input);
        let offset = Self::resolve_offset(input);
        let glob_patterns = Self::parse_glob_patterns(input.get("glob").and_then(|v| v.as_str()));
        let file_type = input
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut options = GrepOptions::new(pattern, resolved_path)
            .case_insensitive(case_insensitive)
            .multiline(multiline)
            .output_mode(output_mode)
            .show_line_numbers(show_line_numbers);

        if resolved.is_runtime_artifact() {
            if let Some(runtime_root) = &resolved.runtime_root {
                options = options.display_base(runtime_root.to_string_lossy().to_string());
            }
        } else if let Some(display_base) = Self::display_base(context) {
            options = options.display_base(display_base);
        }

        if let Some(c) = context_c {
            options = options.context(c);
        }
        if let Some(b) = before_context {
            options = options.before_context(b);
        }
        if let Some(a) = after_context {
            options = options.after_context(a);
        }
        if let Some(h) = head_limit {
            options = options.head_limit(h);
        }
        if offset > 0 {
            options = options.offset(offset);
        }
        if !glob_patterns.is_empty() {
            options = options.globs(glob_patterns);
        }
        if let Some(t) = file_type {
            options = options.file_type(t);
        }

        Ok(options)
    }

    /// Whether the caller asked for surrounding context lines (`-A` / `-B` / `-C` / `context`).
    ///
    /// The flashgrep daemon protocol has no context-line concept, so these requests must be
    /// served by the ripgrep path instead of workspace search.
    fn context_lines_requested(input: &Value) -> bool {
        ["-A", "-B", "-C", "context"]
            .iter()
            .filter_map(|key| input.get(*key))
            .filter_map(parse_u64_value)
            .any(|lines| lines > 0)
    }

    fn build_workspace_search_request(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<(ContentSearchRequest, String, bool, usize, Option<usize>)> {
        let workspace_root = context
            .workspace
            .as_ref()
            .map(|workspace| PathBuf::from(workspace.root_path_string()))
            .ok_or_else(|| OpenBitFunError::tool("Workspace is required for Grep".to_string()))?;

        let pattern = input
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("pattern is required".to_string()))?;
        let search_path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let resolved_path = context.resolve_workspace_tool_path(search_path)?;
        let resolved_path_buf = PathBuf::from(&resolved_path);
        let output_mode = input
            .get("output_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("files_with_matches")
            .to_string();
        let show_line_numbers = input
            .get("-n")
            .and_then(|v| v.as_bool())
            .unwrap_or(output_mode == "content");
        let offset = Self::resolve_offset(input);
        let head_limit = Self::resolve_head_limit(input);
        let max_results = Self::backend_max_results(input, offset, head_limit);
        let globs = Self::parse_glob_patterns(input.get("glob").and_then(|v| v.as_str()));
        let file_types = input
            .get("type")
            .and_then(|v| v.as_str())
            .map(|value| vec![value.to_string()])
            .unwrap_or_default();
        let output_mode_enum = match output_mode.as_str() {
            "content" => ContentSearchOutputMode::Content,
            "count" => ContentSearchOutputMode::Count,
            _ => ContentSearchOutputMode::FilesWithMatches,
        };
        let request = ContentSearchRequest {
            repo_root: workspace_root.clone(),
            search_path: (resolved_path_buf != workspace_root).then_some(resolved_path_buf),
            pattern: pattern.to_string(),
            output_mode: output_mode_enum,
            case_sensitive: !input.get("-i").and_then(|v| v.as_bool()).unwrap_or(false),
            use_regex: true,
            whole_word: false,
            multiline: input
                .get("multiline")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            max_results,
            globs,
            file_types,
            exclude_file_types: Vec::new(),
        };

        Ok((request, output_mode, show_line_numbers, offset, head_limit))
    }

    fn format_workspace_search_output(
        &self,
        output_mode: &str,
        show_line_numbers: bool,
        offset: usize,
        head_limit: Option<usize>,
        result: &crate::service::search::ContentSearchResult,
        display_base: Option<&str>,
    ) -> (String, usize, usize) {
        match output_mode {
            "content" => {
                let mut lines =
                    render_workspace_search_content_lines(&result.hits, show_line_numbers);
                if lines.is_empty() {
                    lines = render_workspace_search_result_lines(
                        &result.outcome.results,
                        show_line_numbers,
                    );
                }
                apply_offset_and_limit(&mut lines, offset, head_limit);
                let rendered = relativize_result_text(&lines.join("\n"), display_base);
                let file_count = if result.hits.is_empty() {
                    result
                        .outcome
                        .results
                        .iter()
                        .map(|item| item.path.as_str())
                        .collect::<HashSet<_>>()
                        .len()
                } else {
                    result
                        .hits
                        .iter()
                        .map(|hit| hit.path.as_str())
                        .collect::<HashSet<_>>()
                        .len()
                };
                (rendered, file_count, result.matched_occurrences)
            }
            "count" => {
                let mut lines = result
                    .file_counts
                    .iter()
                    .map(|count| format!("{}:{}", count.path, count.matched_lines))
                    .collect::<Vec<_>>();
                lines.sort();
                let mut lines = lines.into_iter().collect::<Vec<_>>();
                apply_offset_and_limit(&mut lines, offset, head_limit);
                let rendered = relativize_result_text(&lines.join("\n"), display_base);
                (rendered, result.file_counts.len(), result.matched_lines)
            }
            _ => {
                let mut files = result
                    .outcome
                    .results
                    .iter()
                    .map(|item| item.path.clone())
                    .collect::<Vec<_>>();
                files.sort();
                files.dedup();
                apply_offset_and_limit(&mut files, offset, head_limit);
                let rendered = relativize_result_text(&files.join("\n"), display_base);
                let total_matches = files.len();
                (rendered, total_matches, total_matches)
            }
        }
    }
}

/// Renders one line per content match.
///
/// Matches hydrated from disk carry their text. Transports that cannot read the
/// matched files (remote SSH) surface positions only, because the flashgrep
/// daemon never sends line text on the wire; those render as a bare
/// `path:line:` locator rather than being dropped, so the caller still learns
/// where the matches are. A match with neither text nor a line number carries no
/// usable information and is skipped.
fn render_workspace_search_result_lines(
    results: &[crate::infrastructure::FileSearchResult],
    show_line_numbers: bool,
) -> Vec<String> {
    let mut lines: Vec<String> = Vec::with_capacity(results.len());

    for result in results {
        let content = result
            .matched_content
            .as_deref()
            .map(str::trim_end)
            .filter(|content| !content.is_empty());

        let rendered = match (content, result.line_number) {
            (Some(content), Some(line)) if show_line_numbers => {
                format!("{}:{}:{}", result.path, line, content)
            }
            (Some(content), _) => format!("{}:{}", result.path, content),
            (None, Some(line)) if show_line_numbers => format!("{}:{}:", result.path, line),
            // Without line numbers a text-less match collapses to its path, so
            // avoid repeating the same path once per match in the same file.
            (None, Some(_)) => result.path.clone(),
            (None, None) => continue,
        };

        if lines.last().is_some_and(|last| last == &rendered) {
            continue;
        }
        lines.push(rendered);
    }

    lines
}

fn render_workspace_search_content_lines(
    hits: &[WorkspaceSearchHit],
    show_line_numbers: bool,
) -> Vec<String> {
    let mut lines = Vec::new();
    for hit in hits {
        for line in &hit.lines {
            match line {
                WorkspaceSearchLine::Match { value } => {
                    let snippet = value.snippet.trim_end();
                    if show_line_numbers {
                        lines.push(format!("{}:{}:{}", hit.path, value.location.line, snippet));
                    } else {
                        lines.push(format!("{}:{}", hit.path, snippet));
                    }
                }
                WorkspaceSearchLine::Context { value } => {
                    let snippet = value.snippet.trim_end();
                    if show_line_numbers {
                        lines.push(format!("{}-{}:{}", hit.path, value.line_number, snippet));
                    } else {
                        lines.push(format!("{}-{}", hit.path, snippet));
                    }
                }
                WorkspaceSearchLine::ContextBreak => lines.push("--".to_string()),
            }
        }
    }
    lines
}

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Search file contents in the active workspace with OpenBitFun's built-in structured search.

Usage:
- Use Grep by default for codebase content search because it preserves workspace-aware permissions and consistent output.
- Grep is a tool API, not the shell command `grep` or `rg`. It does not require `rg` to be installed on the workspace host. Use ExecCommand for shell-specific workflows or an explicitly requested shell command.
- For simple literal names or symbols, start with the literal text before trying broad regexes.
- Narrow searches with `path`, `glob`, or `type` when you know the likely area or language, and use `head_limit` to keep exploratory searches readable.
- A common workflow is `output_mode: "files_with_matches"` to locate candidate files, followed by `output_mode: "content"` with `-n` and small context when exact lines are needed.
- Uses Rust regex syntax (e.g., "log.*Error", "function\s+\w+"); look-around and backreferences are not supported.
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- The path parameter may be workspace-relative, an absolute path inside the current workspace, or an exact `openbitfun://...` URI returned by another tool
- Omit path to search the current workspace. Do not search host roots or placeholder paths such as `/workspace`.
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Task tool for open-ended searches requiring multiple rounds
- Escape regex metacharacters when matching literal text (use `interface\{\}` to find `interface{}` in Go code).
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \{[\s\S]*?field`, use `multiline: true`"#.to_string())
    }

    fn short_description(&self) -> String {
        "Search workspace file contents with built-in structured pattern matching.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Rust regular expression to search for in file contents. Escape literal regex metacharacters. Look-around and backreferences are not supported."
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search in. Omit to search the current workspace. If provided, use a workspace-relative path, an absolute path inside the current workspace, or an exact openbitfun:// URI."
                },
                "glob": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\")."
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."
                },
                "-B": { "type": "number", "description": "Number of lines to show before each match. Requires output_mode: \"content\", ignored otherwise." },
                "-A": { "type": "number", "description": "Number of lines to show after each match. Requires output_mode: \"content\", ignored otherwise." },
                "-C": { "type": "number", "description": "Number of lines to show before and after each match. Requires output_mode: \"content\", ignored otherwise." },
                "context": { "type": "number", "description": "Alias for -C. Number of lines to show before and after each match." },
                "-n": { "type": "boolean", "description": "Show line numbers in output. Requires output_mode: \"content\", ignored otherwise." },
                "-i": { "type": "boolean", "description": "Case insensitive search." },
                "type": { "type": "string", "description": "File-type filter. Common types: js, py, rust, go, java, etc." },
                "head_limit": { "type": "number", "description": "Limit output to first N lines/entries." },
                "offset": { "type": "number", "description": "Skip the first N lines/entries before applying head_limit." },
                "multiline": { "type": "boolean", "description": "Enable multiline mode where . matches newlines and patterns can span lines. Default: false." }
            },
            "required": ["pattern"],
            "additionalProperties": false,
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn render_tool_use_message(
        &self,
        input: &Value,
        _options: &crate::agentic::tools::framework::ToolRenderOptions,
    ) -> String {
        let pattern = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        let search_path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let file_type = input.get("type").and_then(|v| v.as_str());
        let glob_pattern = input.get("glob").and_then(|v| v.as_str());
        let output_mode = input
            .get("output_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("files_with_matches");

        let scope = if search_path == "." {
            "Current workspace".to_string()
        } else {
            search_path.to_string()
        };
        let scope_with_filter = if let Some(ft) = file_type {
            format!("{} (*.{})", scope, ft)
        } else if let Some(gp) = glob_pattern {
            format!("{} ({})", scope, gp)
        } else {
            scope
        };
        let mode_desc = match output_mode {
            "content" => "Show matching content",
            "count" => "Count matches",
            _ => "List matching files",
        };

        format!(
            "Search \"{}\" | {} | {}",
            pattern, scope_with_filter, mode_desc
        )
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        // Resolve and authorize the workspace path before selecting IO.
        let search_path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let resolved = context.resolve_tool_path(search_path)?;
        context.enforce_path_operation(ToolPathOperation::Read, &resolved)?;
        #[cfg(feature = "tools-miniapp")]
        if is_virtual_context_path(context, &resolved) {
            let files = virtual_context_files_for_search(context, &resolved).ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "MiniApp context path is unavailable: {}",
                    resolved.logical_path
                ))
            })?;
            let options = self.build_grep_options(input, context)?;
            let pattern = options.pattern.clone();
            let path = resolved.logical_path.clone();
            let output_mode = options.output_mode.to_string();
            let result =
                tokio::task::spawn_blocking(move || grep_search_virtual_files(options, &files))
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(format!("virtual grep task failed: {error}"))
                    })?
                    .map_err(OpenBitFunError::tool)?;
            return Ok(vec![ToolResult::Result {
                data: json!({
                    "pattern": pattern,
                    "path": path,
                    "output_mode": output_mode,
                    "file_count": result.file_count,
                    "total_matches": result.total_matches,
                    "applied_limit": result.applied_limit,
                    "applied_offset": result.applied_offset,
                    "result": result.result_text,
                    "representation": "miniapp_context"
                }),
                result_for_assistant: Some(result.result_text),
                image_attachments: None,
            }]);
        }
        #[cfg(feature = "tools-miniapp")]
        if requires_virtual_context_path(context) {
            return Err(OpenBitFunError::tool(format!(
                "MiniApp context path is unavailable: {}",
                resolved.logical_path
            )));
        }
        crate::agentic::deep_review::scope::ensure_focused_review_resolved_path_allowed(
            context,
            &resolved.resolved_path,
        )?;
        let focused_excluded_paths =
            crate::agentic::deep_review::scope::focused_review_excluded_changed_paths(context)?;

        // The flashgrep daemon has no context-line support, so `-A`/`-B`/`-C` must go
        // through the ripgrep path to produce surrounding lines.
        let context_lines_requested = Self::context_lines_requested(input);

        if resolved.uses_remote_workspace_backend() {
            if !context_lines_requested && workspace_search_feature_enabled().await {
                let remote_workspace_search_result = async {
                    let (request, output_mode, show_line_numbers, offset, head_limit) =
                        self.build_workspace_search_request(input, context)?;
                    let pattern = request.pattern.clone();
                    let path = request
                        .search_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string())
                        .unwrap_or_else(|| request.repo_root.to_string_lossy().to_string());
                    let workspace_id = context.workspace.as_ref()
                        .and_then(|workspace| workspace.workspace_id.as_deref())
                        .ok_or_else(|| OpenBitFunError::tool("Remote search requires a workspace ID"))?;
                    let search_service = remote_workspace_search_service_for_workspace(workspace_id)
                        .await.map_err(OpenBitFunError::tool)?;
                    let search_started_at = Instant::now();
                    let search_result = search_service
                        .search_content(request)
                        .await
                        .map_err(OpenBitFunError::tool)?;
                    let display_base = Self::display_base(context);
                    let (result_text, file_count, total_matches) =
                        self.format_workspace_search_output(
                            &output_mode,
                            show_line_numbers,
                            offset,
                            head_limit,
                            &search_result,
                            display_base.as_deref(),
                        );
                    let workspace_search_elapsed_ms = search_started_at.elapsed().as_millis();

                    log::info!(
                        "Grep tool remote workspace-search result: pattern={}, path={}, output_mode={}, file_count={}, total_matches={}, backend={:?}, repo_phase={:?}, base_advance_in_progress={}, dirty_modified={}, dirty_deleted={}, dirty_new={}, candidate_docs={}, matched_lines={}, matched_occurrences={}, workspace_search_ms={}",
                        pattern,
                        path,
                        output_mode,
                        file_count,
                        total_matches,
                        search_result.backend,
                        search_result.repo_status.phase,
                        search_result.repo_status.base_advance_in_progress,
                        search_result.repo_status.dirty_files.modified,
                        search_result.repo_status.dirty_files.deleted,
                        search_result.repo_status.dirty_files.new,
                        search_result.candidate_docs,
                        search_result.matched_lines,
                        search_result.matched_occurrences,
                        workspace_search_elapsed_ms,
                    );

                    Ok::<Vec<ToolResult>, OpenBitFunError>(vec![ToolResult::Result {
                        data: json!({
                            "pattern": pattern,
                            "path": path,
                            "output_mode": output_mode,
                            "file_count": file_count,
                            "total_matches": total_matches,
                            "backend": search_result.backend,
                            "repo_phase": search_result.repo_status.phase,
                            "base_advance_in_progress": search_result.repo_status.base_advance_in_progress,
                            "workspace_probe_pending": search_result.repo_status.workspace_probe_pending,
                            "applied_limit": head_limit,
                            "applied_offset": if offset > 0 { Some(offset) } else { None::<usize> },
                            "result": result_text,
                        }),
                        result_for_assistant: Some(annotate_workspace_probe_pending(
                            result_text,
                            search_result.repo_status.workspace_probe_pending,
                        )),
                        image_attachments: None,
                    }])
                }
                .await;

                match remote_workspace_search_result {
                    Ok(results) => return Ok(results),
                    Err(error) => {
                        log::warn!(
                            "Grep tool remote workspace-search failed; falling back to workspace IO: {}",
                            error
                        );
                    }
                }
            }
            return self.call_workspace_io(input, context).await;
        }

        if focused_excluded_paths.is_none()
            && !context_lines_requested
            && workspace_search_runtime_available().await
        {
            if let Some(search_service) = get_global_workspace_search_service() {
                let (request, output_mode, show_line_numbers, offset, head_limit) =
                    self.build_workspace_search_request(input, context)?;
                let pattern = request.pattern.clone();
                let path = request
                    .search_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| request.repo_root.to_string_lossy().to_string());
                let search_started_at = Instant::now();
                match search_service.search_content(request).await {
                    Ok(search_result) => {
                        let display_base = Self::display_base(context);
                        let (result_text, file_count, total_matches) = self
                            .format_workspace_search_output(
                                &output_mode,
                                show_line_numbers,
                                offset,
                                head_limit,
                                &search_result,
                                display_base.as_deref(),
                            );
                        let workspace_search_elapsed_ms = search_started_at.elapsed().as_millis();

                        log::info!(
                            "Grep tool workspace-search result: pattern={}, path={}, output_mode={}, file_count={}, total_matches={}, backend={:?}, repo_phase={:?}, base_advance_in_progress={}, dirty_modified={}, dirty_deleted={}, dirty_new={}, candidate_docs={}, matched_lines={}, matched_occurrences={}, workspace_search_ms={}",
                            pattern,
                            path,
                            output_mode,
                            file_count,
                            total_matches,
                            search_result.backend,
                            search_result.repo_status.phase,
                            search_result.repo_status.base_advance_in_progress,
                            search_result.repo_status.dirty_files.modified,
                            search_result.repo_status.dirty_files.deleted,
                            search_result.repo_status.dirty_files.new,
                            search_result.candidate_docs,
                            search_result.matched_lines,
                            search_result.matched_occurrences,
                            workspace_search_elapsed_ms,
                        );

                        return Ok(vec![ToolResult::Result {
                            data: json!({
                                "pattern": pattern,
                                "path": path,
                                "output_mode": output_mode,
                                "file_count": file_count,
                                "total_matches": total_matches,
                                "backend": search_result.backend,
                                "repo_phase": search_result.repo_status.phase,
                                "base_advance_in_progress": search_result.repo_status.base_advance_in_progress,
                                "workspace_probe_pending": search_result.repo_status.workspace_probe_pending,
                                "applied_limit": head_limit,
                                "applied_offset": if offset > 0 { Some(offset) } else { None::<usize> },
                                "result": result_text,
                            }),
                            result_for_assistant: Some(annotate_workspace_probe_pending(
                                result_text,
                                search_result.repo_status.workspace_probe_pending,
                            )),
                            image_attachments: None,
                        }]);
                    }
                    Err(error) => {
                        log::warn!(
                            "Grep tool workspace-search failed; falling back to local rg: {}",
                            error
                        );
                    }
                }
            }
        }

        let mut grep_options = self.build_grep_options(input, context)?;
        if let Some(excluded_paths) = focused_excluded_paths {
            grep_options = grep_options
                .excluded_paths(
                    excluded_paths
                        .into_iter()
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect(),
                )
                .reject_linked_files(true);
        }
        let pattern = grep_options.pattern.clone();
        let path = resolved.logical_path.clone();
        let output_mode = grep_options.output_mode.to_string();

        let event_system = crate::infrastructure::events::event_system::get_global_event_system();
        let tool_use_id = context
            .tool_call_id
            .clone()
            .unwrap_or_else(|| format!("grep_{}", uuid::Uuid::new_v4()));
        let tool_name = self.name().to_string();

        let tool_use_id_clone = tool_use_id.clone();
        let tool_name_clone = tool_name.clone();
        let event_system_clone = event_system.clone();
        let progress_callback: ProgressCallback = Arc::new(
            move |files_processed, file_count, total_matches| {
                let progress_message = format!(
                    "Scanned {} files | Found {} matching files ({} matches)",
                    files_processed, file_count, total_matches
                );

                let event = crate::infrastructure::events::event_system::BackendEvent::ToolExecutionProgress(
                    crate::util::types::event::ToolExecutionProgressInfo {
                        tool_use_id: tool_use_id_clone.clone(),
                        tool_name: tool_name_clone.clone(),
                        progress_message,
                        percentage: None,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    }
                );

                let event_system = event_system_clone.clone();
                tokio::spawn(async move {
                    let _ = event_system.emit(event).await;
                });
            },
        );

        let search_result = tokio::task::spawn_blocking(move || {
            grep_search(grep_options, Some(progress_callback), Some(500))
        })
        .await;

        let GrepSearchResult {
            file_count,
            total_matches,
            result_text,
            applied_limit,
            applied_offset,
            // Always false here: this call site supplies no cancellation token, so the search has
            // no way to stop early.
            cancelled: _,
        } = match search_result {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => return Err(OpenBitFunError::tool(e)),
            Err(e) => return Err(OpenBitFunError::tool(format!("grep search failed: {}", e))),
        };

        Ok(vec![ToolResult::Result {
            data: json!({
                "pattern": pattern,
                "path": path,
                "output_mode": output_mode,
                "file_count": file_count,
                "total_matches": total_matches,
                "applied_limit": applied_limit,
                "applied_offset": applied_offset,
                "result": result_text,
            }),
            result_for_assistant: Some(result_text),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::{
        annotate_workspace_probe_pending, render_workspace_search_content_lines,
        render_workspace_search_result_lines, GrepTool, DEFAULT_HEAD_LIMIT,
        WORKSPACE_PROBE_PENDING_NOTE,
    };
    #[cfg(feature = "tools-miniapp")]
    use crate::agentic::tools::framework::ToolResult;
    use crate::agentic::tools::framework::{Tool, ToolUseContext};
    use crate::agentic::tools::{ToolPathPolicy, ToolRuntimeRestrictions};
    use crate::agentic::WorkspaceBinding;
    use crate::infrastructure::{FileSearchOutcome, FileSearchResult, SearchMatchType};
    #[cfg(feature = "tools-miniapp")]
    use crate::miniapp::agent_context::{
        publish_agent_context_snapshot, remove_agent_context_snapshot, MiniAppAgentContextInput,
    };
    use crate::service::search::{
        ContentSearchResult, WorkspaceSearchBackend, WorkspaceSearchHit, WorkspaceSearchLine,
        WorkspaceSearchMatch, WorkspaceSearchMatchLocation, WorkspaceSearchRepoPhase,
        WorkspaceSearchRepoStatus,
    };
    use openbitfun_runtime_ports::ToolRuntimeHandles;
    use serde_json::json;
    use std::collections::HashMap;
    use tool_runtime::search::grep_search::relativize_result_text;

    #[tokio::test]
    async fn grep_tool_enforces_runtime_read_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scope = "0123456789abcdef0123456789abcdef";
        let allowed_root = dir.path().join(".miniapp-context").join(scope);
        std::fs::create_dir_all(&allowed_root).expect("create context root");
        std::fs::write(allowed_root.join("stocks.ndjson"), "allowed market row")
            .expect("write allowed file");
        std::fs::write(dir.path().join("storage.json"), "blocked").expect("write blocked file");
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Agent".to_string()),
            session_id: None,
            dialog_turn_id: Some("turn-1".to_string()),
            workspace: Some(WorkspaceBinding::new(
                Some("grep-context-workspace".to_string()),
                dir.path().to_path_buf(),
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                path_policy: ToolPathPolicy {
                    read_roots: vec![format!(".miniapp-context/{scope}")],
                    ..Default::default()
                },
                ..Default::default()
            },
            runtime_handles: ToolRuntimeHandles::default(),
        };

        GrepTool::new()
            .call_impl(
                &json!({
                    "pattern": "allowed market row",
                    "path": format!(".miniapp-context/{scope}")
                }),
                &context,
            )
            .await
            .expect("Grep should search the exact context snapshot root");
        let error = GrepTool::new()
            .call_impl(
                &json!({ "pattern": "blocked", "path": "storage.json" }),
                &context,
            )
            .await
            .expect_err("Grep must not search app storage outside reserved context");
        assert!(error.to_string().contains("is not allowed for read"));
    }

    #[cfg(feature = "tools-miniapp")]
    #[tokio::test]
    async fn grep_tool_searches_virtual_context_without_filesystem_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = publish_agent_context_snapshot(
            "grep-virtual-app",
            "grep-virtual-session",
            "grep-virtual-turn",
            vec![MiniAppAgentContextInput {
                name: "stocks.ndjson".to_string(),
                content: format!(
                    "{}host-owned market sentinel row",
                    "summary-only row\n".repeat(2_000)
                ),
            }],
        )
        .unwrap()
        .unwrap();
        let physical_root = dir.path().join(&snapshot.relative_root);
        std::fs::create_dir_all(&physical_root).unwrap();
        std::fs::write(physical_root.join("stocks.ndjson"), "attacker market row").unwrap();
        std::fs::create_dir_all(physical_root.join("nested")).unwrap();
        std::fs::write(
            physical_root.join("nested/stocks.ndjson"),
            "nested attacker market row",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&physical_root, dir.path().join("context-alias")).unwrap();
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Agent".to_string()),
            session_id: Some("grep-virtual-session".to_string()),
            dialog_turn_id: Some("grep-virtual-turn".to_string()),
            workspace: Some(WorkspaceBinding::new(
                Some("grep-virtual-workspace".to_string()),
                dir.path().to_path_buf(),
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                path_policy: ToolPathPolicy {
                    read_roots: vec![snapshot.relative_root.clone()],
                    ..Default::default()
                },
                miniapp_context_scope: Some(snapshot.scope.clone()),
                ..Default::default()
            },
            runtime_handles: ToolRuntimeHandles::default(),
        };

        let results = GrepTool::new()
            .call_impl(
                &json!({
                    "pattern": "host-owned market sentinel",
                    "path": snapshot.relative_root,
                    "output_mode": "content"
                }),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result {
            result_for_assistant: Some(result),
            ..
        } = &results[0]
        else {
            panic!("Grep should return an assistant result");
        };
        assert!(result.contains("host-owned market sentinel row"));
        assert!(!result.contains("attacker market row"));

        let nested_error = GrepTool::new()
            .call_impl(
                &json!({
                    "pattern": "attacker",
                    "path": format!("{}/nested", snapshot.relative_root)
                }),
                &context,
            )
            .await
            .expect_err("the entire virtual scope must reject nested physical paths");
        assert!(nested_error
            .to_string()
            .contains("context path is unavailable"));

        #[cfg(unix)]
        {
            let alias_error = GrepTool::new()
                .call_impl(
                    &json!({ "pattern": "attacker", "path": "context-alias" }),
                    &context,
                )
                .await
                .expect_err("a physical alias into the virtual root must fail closed");
            assert!(alias_error
                .to_string()
                .contains("context path is unavailable"));
        }

        assert!(remove_agent_context_snapshot(
            "grep-virtual-session",
            "grep-virtual-turn"
        ));
        let error = GrepTool::new()
            .call_impl(
                &json!({
                    "pattern": "attacker",
                    "path": format!(".miniapp-context/{}", snapshot.scope)
                }),
                &context,
            )
            .await
            .expect_err("expired virtual context must not fall back to the physical tree");
        assert!(error.to_string().contains("context path is unavailable"));
    }

    #[test]
    fn head_limit_defaults_and_zero_escape_hatch() {
        assert_eq!(
            GrepTool::resolve_head_limit(&json!({})),
            Some(DEFAULT_HEAD_LIMIT)
        );
        assert_eq!(
            GrepTool::resolve_head_limit(&json!({ "head_limit": 25 })),
            Some(25)
        );
        assert_eq!(
            GrepTool::resolve_head_limit(&json!({ "head_limit": 0 })),
            None
        );
    }

    #[test]
    fn context_lines_requested_detects_every_context_flag() {
        assert!(!GrepTool::context_lines_requested(&json!({})));
        assert!(!GrepTool::context_lines_requested(
            &json!({ "pattern": "foo", "-A": 0, "-B": 0, "-C": 0 })
        ));

        for key in ["-A", "-B", "-C", "context"] {
            assert!(
                GrepTool::context_lines_requested(&json!({ "pattern": "foo", key: 2 })),
                "expected {key} to route the request to ripgrep"
            );
        }
    }

    #[test]
    fn backend_max_results_only_uses_explicit_limit() {
        assert_eq!(
            GrepTool::backend_max_results(&json!({}), 0, Some(DEFAULT_HEAD_LIMIT)),
            None
        );
        assert_eq!(
            GrepTool::backend_max_results(&json!({ "head_limit": 25 }), 3, Some(25)),
            Some(28)
        );
        assert_eq!(
            GrepTool::backend_max_results(&json!({ "head_limit": 0 }), 7, None),
            None
        );
    }

    #[test]
    fn relativizes_prefixed_result_lines() {
        let text = "/repo/src/main.rs:12:fn main()\n/repo/src/lib.rs:3:pub fn lib()";
        let relativized = relativize_result_text(text, Some("/repo"));

        assert_eq!(
            relativized,
            "src/main.rs:12:fn main()\nsrc/lib.rs:3:pub fn lib()"
        );
    }

    #[test]
    fn renders_workspace_search_context_lines_in_rg_style() {
        let lines = render_workspace_search_content_lines(
            &[WorkspaceSearchHit {
                path: "/repo/src/main.rs".to_string(),
                matches: vec![WorkspaceSearchMatch {
                    location: WorkspaceSearchMatchLocation {
                        line: 12,
                        column: 5,
                    },
                    snippet: "panic!(\"x\")".to_string(),
                    matched_text: "panic".to_string(),
                }],
                lines: vec![
                    WorkspaceSearchLine::Context {
                        value: crate::service::search::WorkspaceSearchContextLine {
                            line_number: 10,
                            snippet: "let a = 1".to_string(),
                        },
                    },
                    WorkspaceSearchLine::Context {
                        value: crate::service::search::WorkspaceSearchContextLine {
                            line_number: 11,
                            snippet: "let b = 2".to_string(),
                        },
                    },
                    WorkspaceSearchLine::Match {
                        value: WorkspaceSearchMatch {
                            location: WorkspaceSearchMatchLocation {
                                line: 12,
                                column: 5,
                            },
                            snippet: "panic!(\"x\")".to_string(),
                            matched_text: "panic".to_string(),
                        },
                    },
                    WorkspaceSearchLine::Context {
                        value: crate::service::search::WorkspaceSearchContextLine {
                            line_number: 13,
                            snippet: "cleanup()".to_string(),
                        },
                    },
                    WorkspaceSearchLine::ContextBreak,
                    WorkspaceSearchLine::Context {
                        value: crate::service::search::WorkspaceSearchContextLine {
                            line_number: 20,
                            snippet: "return".to_string(),
                        },
                    },
                ],
            }],
            true,
        );

        assert_eq!(
            lines,
            vec![
                "/repo/src/main.rs-10:let a = 1",
                "/repo/src/main.rs-11:let b = 2",
                "/repo/src/main.rs:12:panic!(\"x\")",
                "/repo/src/main.rs-13:cleanup()",
                "--",
                "/repo/src/main.rs-20:return",
            ]
        );
    }

    #[test]
    fn content_workspace_output_uses_hits_for_context_lines() {
        let tool = GrepTool::new();
        let result = ContentSearchResult {
            outcome: FileSearchOutcome {
                results: Vec::new(),
                truncated: false,
            },
            file_counts: Vec::new(),
            hits: vec![WorkspaceSearchHit {
                path: "/repo/src/main.rs".to_string(),
                matches: vec![WorkspaceSearchMatch {
                    location: WorkspaceSearchMatchLocation {
                        line: 12,
                        column: 5,
                    },
                    snippet: "panic!(\"x\")".to_string(),
                    matched_text: "panic".to_string(),
                }],
                lines: vec![
                    WorkspaceSearchLine::Context {
                        value: crate::service::search::WorkspaceSearchContextLine {
                            line_number: 11,
                            snippet: "let b = 2".to_string(),
                        },
                    },
                    WorkspaceSearchLine::Match {
                        value: WorkspaceSearchMatch {
                            location: WorkspaceSearchMatchLocation {
                                line: 12,
                                column: 5,
                            },
                            snippet: "panic!(\"x\")".to_string(),
                            matched_text: "panic".to_string(),
                        },
                    },
                ],
            }],
            backend: WorkspaceSearchBackend::Indexed,
            repo_status: WorkspaceSearchRepoStatus {
                repo_id: "repo".to_string(),
                repo_path: "/repo".to_string(),
                storage_root: "/repo/.openbitfun/search/flashgrep-index".to_string(),
                base_snapshot_root: "/repo/.openbitfun/search/flashgrep-index/base-snapshot"
                    .to_string(),
                workspace_overlay_root:
                    "/repo/.openbitfun/search/flashgrep-index/workspace-overlay".to_string(),
                phase: WorkspaceSearchRepoPhase::Ready,
                snapshot_key: None,
                base_head_commit: None,
                workspace_head_commit: None,
                base_advance_in_progress: false,
                base_advance_target_head: None,
                base_delta_depth: 0,
                base_compaction_recommended: false,
                last_probe_unix_secs: None,
                last_rebuild_unix_secs: None,
                dirty_files: crate::service::search::WorkspaceSearchDirtyFiles {
                    modified: 0,
                    deleted: 0,
                    new: 0,
                },
                active_task_id: None,
                probe_healthy: true,
                workspace_probe_pending: false,
                last_error: None,
                last_maintenance_error: None,
                overlay: None,
            },
            candidate_docs: 1,
            matched_lines: 1,
            matched_occurrences: 1,
        };

        let (rendered, file_count, total_matches) =
            tool.format_workspace_search_output("content", true, 0, None, &result, Some("/repo"));

        assert_eq!(
            rendered,
            "src/main.rs-11:let b = 2\nsrc/main.rs:12:panic!(\"x\")"
        );
        assert_eq!(file_count, 1);
        assert_eq!(total_matches, 1);
    }

    #[test]
    fn content_workspace_output_falls_back_to_converted_line_results() {
        let tool = GrepTool::new();
        let result = ContentSearchResult {
            outcome: FileSearchOutcome {
                results: vec![
                    FileSearchResult {
                        path: "/repo/src/main.rs".to_string(),
                        name: "main.rs".to_string(),
                        is_directory: false,
                        match_type: SearchMatchType::Content,
                        line_number: Some(12),
                        matched_content: Some("panic!(\"x\")".to_string()),
                        preview_before: None,
                        preview_inside: Some("panic!(\"x\")".to_string()),
                        preview_after: None,
                    },
                    FileSearchResult {
                        path: "/repo/src/lib.rs".to_string(),
                        name: "lib.rs".to_string(),
                        is_directory: false,
                        match_type: SearchMatchType::Content,
                        line_number: Some(3),
                        matched_content: Some("pub fn lib() {}".to_string()),
                        preview_before: None,
                        preview_inside: Some("pub fn lib() {}".to_string()),
                        preview_after: None,
                    },
                ],
                truncated: false,
            },
            file_counts: Vec::new(),
            hits: Vec::new(),
            backend: WorkspaceSearchBackend::Indexed,
            repo_status: WorkspaceSearchRepoStatus {
                repo_id: "repo".to_string(),
                repo_path: "/repo".to_string(),
                storage_root: "/repo/.openbitfun/search/flashgrep-index".to_string(),
                base_snapshot_root: "/repo/.openbitfun/search/flashgrep-index/base-snapshot"
                    .to_string(),
                workspace_overlay_root:
                    "/repo/.openbitfun/search/flashgrep-index/workspace-overlay".to_string(),
                phase: WorkspaceSearchRepoPhase::Ready,
                snapshot_key: None,
                base_head_commit: None,
                workspace_head_commit: None,
                base_advance_in_progress: false,
                base_advance_target_head: None,
                base_delta_depth: 0,
                base_compaction_recommended: false,
                last_probe_unix_secs: None,
                last_rebuild_unix_secs: None,
                dirty_files: crate::service::search::WorkspaceSearchDirtyFiles {
                    modified: 0,
                    deleted: 0,
                    new: 0,
                },
                active_task_id: None,
                probe_healthy: true,
                workspace_probe_pending: false,
                last_error: None,
                last_maintenance_error: None,
                overlay: None,
            },
            candidate_docs: 2,
            matched_lines: 2,
            matched_occurrences: 2,
        };

        let (rendered, file_count, total_matches) =
            tool.format_workspace_search_output("content", true, 0, None, &result, Some("/repo"));

        assert_eq!(
            rendered,
            "src/main.rs:12:panic!(\"x\")\nsrc/lib.rs:3:pub fn lib() {}"
        );
        assert_eq!(file_count, 2);
        assert_eq!(total_matches, 2);
    }

    #[test]
    fn renders_workspace_search_result_lines_without_line_numbers() {
        let lines = render_workspace_search_result_lines(
            &[FileSearchResult {
                path: "/repo/src/main.rs".to_string(),
                name: "main.rs".to_string(),
                is_directory: false,
                match_type: SearchMatchType::Content,
                line_number: Some(12),
                matched_content: Some("panic!(\"x\")".to_string()),
                preview_before: None,
                preview_inside: Some("panic!(\"x\")".to_string()),
                preview_after: None,
            }],
            false,
        );

        assert_eq!(lines, vec!["/repo/src/main.rs:panic!(\"x\")"]);
    }

    #[test]
    fn renders_locators_for_matches_without_line_text() {
        let positions_only = |line: usize| FileSearchResult {
            path: "/repo/src/main.rs".to_string(),
            name: "main.rs".to_string(),
            is_directory: false,
            match_type: SearchMatchType::Content,
            line_number: Some(line),
            matched_content: None,
            preview_before: None,
            preview_inside: None,
            preview_after: None,
        };

        let lines =
            render_workspace_search_result_lines(&[positions_only(12), positions_only(73)], true);
        assert_eq!(
            lines,
            vec!["/repo/src/main.rs:12:", "/repo/src/main.rs:73:"]
        );

        // Without line numbers there is nothing left but the path, so repeated
        // matches in one file collapse to a single line.
        let lines =
            render_workspace_search_result_lines(&[positions_only(12), positions_only(73)], false);
        assert_eq!(lines, vec!["/repo/src/main.rs"]);
    }

    #[test]
    fn skips_matches_without_text_or_line_number() {
        let lines = render_workspace_search_result_lines(
            &[FileSearchResult {
                path: "/repo/src/main.rs".to_string(),
                name: "main.rs".to_string(),
                is_directory: false,
                match_type: SearchMatchType::Content,
                line_number: None,
                matched_content: None,
                preview_before: None,
                preview_inside: None,
                preview_after: None,
            }],
            true,
        );

        assert!(lines.is_empty());
    }

    #[test]
    fn stale_workspace_view_is_stated_in_the_output_the_model_reads() {
        // No search path waits for the daemon to reconcile, so the only thing that keeps a stale
        // result from silently misleading the caller is saying so in the text it reads.
        let annotated = annotate_workspace_probe_pending("src/lib.rs:1:hit".to_string(), true);
        assert!(annotated.starts_with(WORKSPACE_PROBE_PENDING_NOTE));
        assert!(annotated.ends_with("src/lib.rs:1:hit"));
    }

    #[test]
    fn a_current_workspace_view_adds_nothing_to_the_output() {
        // The pending case is the exception; the common case must stay byte-identical so the note
        // never becomes background noise the model learns to skip.
        let body = "src/lib.rs:1:hit".to_string();
        assert_eq!(annotate_workspace_probe_pending(body.clone(), false), body);
    }

    #[test]
    fn a_stale_empty_result_still_says_why_it_may_be_empty() {
        // "No matches" plus a stale index is exactly the case where the caller needs the note most.
        assert_eq!(
            annotate_workspace_probe_pending(String::new(), true),
            WORKSPACE_PROBE_PENDING_NOTE
        );
    }

    mod workspace_io {
        use crate::agentic::workspace::{LocalWorkspaceFs, LocalWorkspaceShell};
        use openbitfun_runtime_ports::{
            WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
            WorkspaceFileSystem, WorkspaceMetadata, WorkspaceReader, WorkspaceShell,
        };
        use std::sync::{Arc, Mutex};
        use tool_runtime::search::grep_search::{
            grep_search, grep_search_workspace, GrepOptions, GrepSearchResult, OutputMode,
            SearchCancellation,
        };

        fn assert_same(actual: &GrepSearchResult, expected: &GrepSearchResult) {
            assert_eq!(actual.file_count, expected.file_count);
            assert_eq!(actual.total_matches, expected.total_matches);
            assert_eq!(actual.result_text, expected.result_text);
            assert_eq!(actual.applied_limit, expected.applied_limit);
            assert_eq!(actual.applied_offset, expected.applied_offset);
            assert_eq!(actual.cancelled, expected.cancelled);
        }

        async fn compare_native_and_io(options: GrepOptions) -> GrepSearchResult {
            let native_options = options.clone();
            let native =
                tokio::task::spawn_blocking(move || grep_search(native_options, None, None))
                    .await
                    .unwrap()
                    .unwrap();
            let portable = grep_search_workspace(options, &LocalWorkspaceFs, None)
                .await
                .unwrap();
            assert!(!portable.used_rg_candidates);
            assert_same(&portable.result, &native);
            portable.result
        }

        fn fixture() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join(".git")).unwrap();
            std::fs::create_dir(dir.path().join("sub")).unwrap();
            for (name, content) in [
                (
                    "a.py",
                    "before\nALL_REDUCE(value)\nbetween\nvalue 12\nend\n",
                ),
                ("b.py", "before\nall_reduce(value)\nend\n"),
                (".hidden.py", "value 34\n"),
                ("ignored.py", "all_reduce(ignored)\n"),
                (".gitignore", "ignored.py\n"),
                ("sub/.ignore", "skip.py\n"),
                ("sub/skip.py", "all_reduce(skipped)\n"),
                ("sub/c.py", "all_reduce(included)\n"),
                ("view.ets", "all_reduce(arkts)\n"),
                ("settings.json5", "all_reduce(json5)\n"),
                ("custom.testtype", "all_reduce(custom)\n"),
            ] {
                std::fs::write(dir.path().join(name), content).unwrap();
            }
            dir
        }

        const UNFILTERED_FILES: &[&str] = &[
            "known.py",
            "custom.openbitfun_custom_ext",
            "opaque_workspace_notes",
            "src/lib.rs",
            "other.rs",
            "src/log.txt",
        ];

        fn unfiltered_fixture() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join(".git")).unwrap();
            std::fs::create_dir(dir.path().join("src")).unwrap();
            for name in UNFILTERED_FILES {
                std::fs::write(dir.path().join(name), "needle\n").unwrap();
            }
            dir
        }

        fn unfiltered_cases(root: &str) -> Vec<(GrepOptions, Vec<&'static str>)> {
            let options = GrepOptions::new("needle", root)
                .display_base(root)
                .output_mode(OutputMode::FilesWithMatches);
            vec![
                (options.clone(), UNFILTERED_FILES.to_vec()),
                (
                    options.clone().globs(vec!["src/*.rs".to_string()]),
                    vec!["src/lib.rs"],
                ),
                (
                    options.clone().globs(vec!["src/**".to_string()]),
                    vec!["src/lib.rs", "src/log.txt"],
                ),
                (
                    options.clone().globs(vec!["*.rs".to_string()]),
                    vec!["other.rs", "src/lib.rs"],
                ),
                (
                    options
                        .clone()
                        .globs(vec![format!("{}/src/*.rs", root.replace('\\', "/"))]),
                    vec!["src/lib.rs"],
                ),
                (
                    options.globs(vec!["lib.rs".to_string()]),
                    vec!["src/lib.rs"],
                ),
            ]
        }

        fn assert_expected_files(result: &GrepSearchResult, expected: &[&str]) {
            let expected: std::collections::BTreeSet<_> = expected.iter().copied().collect();
            let actual: std::collections::BTreeSet<_> = result.result_text.lines().collect();
            assert_eq!(actual, expected);
            assert_eq!(result.file_count, expected.len());
            assert_eq!(result.total_matches, expected.len());
            assert!(!result.cancelled);
        }

        #[tokio::test]
        async fn default_type_and_relative_globs_match_expected_files_across_workspace_paths() {
            let dir = unfiltered_fixture();
            let root = dir.path().to_string_lossy().into_owned();
            let mut candidates = "OPENBITFUN_RG_CANDIDATES_BEGIN\0".to_string();
            for name in UNFILTERED_FILES {
                candidates.push_str(&LocalWorkspaceFs.join_path(&root, &[*name]));
                candidates.push('\0');
            }
            candidates.push_str("OPENBITFUN_RG_CANDIDATES_END\0");
            let shell = ResponseShell {
                status: 0,
                stdout: candidates,
                timed_out: false,
            };
            for (options, expected) in unfiltered_cases(&root) {
                let native_options = options.clone();
                let native =
                    tokio::task::spawn_blocking(move || grep_search(native_options, None, None))
                        .await
                        .unwrap()
                        .unwrap();
                assert_expected_files(&native, &expected);
                let portable = grep_search_workspace(options.clone(), &LocalWorkspaceFs, None)
                    .await
                    .unwrap();
                assert!(!portable.used_rg_candidates && !portable.used_grep_candidates);
                assert_expected_files(&portable.result, &expected);
                let candidates = grep_search_workspace(options, &LocalWorkspaceFs, Some(&shell))
                    .await
                    .unwrap();
                assert!(candidates.used_rg_candidates);
                assert_expected_files(&candidates.result, &expected);
            }
        }

        #[tokio::test]
        async fn shared_regex_context_modes_windows_and_type_catalog_match_native() {
            let dir = fixture();
            let root = dir.path().to_string_lossy().into_owned();
            for mode in [
                OutputMode::Content,
                OutputMode::Count,
                OutputMode::FilesWithMatches,
            ] {
                for (offset, limit) in [(0, 0), (1, 2), (100, 2)] {
                    compare_native_and_io(
                        GrepOptions::new(r"(?i:all_reduce)|\d+", &root)
                            .display_base(&root)
                            .output_mode(mode)
                            .context(1)
                            .offset(offset)
                            .head_limit(limit)
                            .file_type("py"),
                    )
                    .await;
                }
            }
            for file_type in ["arkts", "json", "testtype"] {
                let result = compare_native_and_io(
                    GrepOptions::new("all_reduce", &root)
                        .file_type(file_type)
                        .display_base(&root),
                )
                .await;
                assert_eq!(result.file_count, 1, "shared type {file_type}");
            }
            compare_native_and_io(
                GrepOptions::new("all_reduce", &root)
                    .case_insensitive(true)
                    .globs(vec!["**/*.py".to_string()])
                    .display_base(&root),
            )
            .await;
        }

        #[tokio::test]
        async fn shared_multiline_explicit_file_and_invalid_scope_match_native() {
            let dir = fixture();
            let root = dir.path().to_string_lossy().into_owned();
            compare_native_and_io(
                GrepOptions::new(r"before\nALL_REDUCE.*?\n", &root)
                    .multiline(true)
                    .display_base(&root)
                    .offset(1)
                    .head_limit(2),
            )
            .await;
            let file = dir.path().join("extensionless");
            std::fs::write(&file, "all_reduce(explicit)\n").unwrap();
            let result = compare_native_and_io(
                GrepOptions::new("all_reduce", file.to_string_lossy())
                    .file_type("rust")
                    .display_base(&root),
            )
            .await;
            assert_eq!(
                result.file_count, 1,
                "an explicit file is not removed by directory type filters"
            );
            for options in [
                GrepOptions::new("[", &root),
                GrepOptions::new("needle", format!("{root}/missing")),
            ] {
                assert!(grep_search(options.clone(), None, None).is_err());
                assert!(grep_search_workspace(options, &LocalWorkspaceFs, None)
                    .await
                    .is_err());
            }
        }

        struct ResponseShell {
            status: i32,
            stdout: String,
            timed_out: bool,
        }
        #[async_trait::async_trait]
        impl WorkspaceShell for ResponseShell {
            async fn exec_with_options(
                &self,
                command: &str,
                options: WorkspaceCommandOptions,
            ) -> anyhow::Result<WorkspaceCommandResult> {
                if command.contains("command -v grep") {
                    return Ok(WorkspaceCommandResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: 127,
                        interrupted: false,
                        timed_out: false,
                    });
                }
                assert!(command.contains("--files-with-matches --null"));
                assert!(!command.contains("grep -"));
                assert!(options.cancellation_token.is_some());
                Ok(WorkspaceCommandResult {
                    stdout: self.stdout.clone(),
                    stderr: "target search failed".to_string(),
                    exit_code: self.status,
                    interrupted: false,
                    timed_out: self.timed_out,
                })
            }
        }

        #[derive(Default)]
        struct ObservedFs {
            opened: Mutex<Vec<String>>,
            pending_read: bool,
            pending_operation: Option<&'static str>,
            opened_signal: tokio::sync::Notify,
            reader_pending_signal: Arc<tokio::sync::Notify>,
            reader_drops: Arc<std::sync::atomic::AtomicUsize>,
        }
        struct PendingReader {
            pending_signal: Arc<tokio::sync::Notify>,
            drops: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl Drop for PendingReader {
            fn drop(&mut self) {
                self.drops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        impl tokio::io::AsyncRead for PendingReader {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                self.pending_signal.notify_one();
                std::task::Poll::Pending
            }
        }
        impl tokio::io::AsyncSeek for PendingReader {
            fn start_seek(
                self: std::pin::Pin<&mut Self>,
                _: std::io::SeekFrom,
            ) -> std::io::Result<()> {
                Ok(())
            }
            fn poll_complete(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<std::io::Result<u64>> {
                std::task::Poll::Ready(Ok(0))
            }
        }
        #[async_trait::async_trait]
        impl WorkspaceFileSystem for ObservedFs {
            async fn open_read(&self, path: &str) -> anyhow::Result<WorkspaceReader> {
                self.opened.lock().unwrap().push(path.to_string());
                self.opened_signal.notify_one();
                if self.pending_operation == Some("open") {
                    return std::future::pending().await;
                }
                if self.pending_read {
                    Ok(Box::new(PendingReader {
                        pending_signal: self.reader_pending_signal.clone(),
                        drops: self.reader_drops.clone(),
                    }))
                } else {
                    LocalWorkspaceFs.open_read(path).await
                }
            }
            async fn metadata(
                &self,
                path: &str,
                follow: bool,
            ) -> anyhow::Result<Option<WorkspaceMetadata>> {
                if self.pending_operation == Some("metadata") {
                    self.opened_signal.notify_one();
                    return std::future::pending().await;
                }
                LocalWorkspaceFs.metadata(path, follow).await
            }
            async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
                LocalWorkspaceFs.read_file(path).await
            }
            async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
                LocalWorkspaceFs.read_file_text(path).await
            }
            async fn write_file(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
                panic!("search cannot write")
            }
            async fn exists(&self, path: &str) -> anyhow::Result<bool> {
                LocalWorkspaceFs.exists(path).await
            }
            async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
                LocalWorkspaceFs.is_file(path).await
            }
            async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
                LocalWorkspaceFs.is_dir(path).await
            }
            async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
                if self.pending_operation == Some("read_dir") {
                    self.opened_signal.notify_one();
                    return std::future::pending().await;
                }
                LocalWorkspaceFs.read_dir(path).await
            }
        }

        #[cfg(unix)]
        struct WithoutRgShell {
            local: LocalWorkspaceShell,
            batches: std::sync::atomic::AtomicUsize,
            malformed_batch: bool,
        }

        #[cfg(unix)]
        #[async_trait::async_trait]
        impl WorkspaceShell for WithoutRgShell {
            async fn exec_with_options(
                &self,
                command: &str,
                options: WorkspaceCommandOptions,
            ) -> anyhow::Result<WorkspaceCommandResult> {
                if command.contains("OPENBITFUN_RG_CANDIDATES_BEGIN") {
                    return Ok(WorkspaceCommandResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: 127,
                        interrupted: false,
                        timed_out: false,
                    });
                }
                if command.contains("OPENBITFUN_GREP_BATCH_END") {
                    self.batches
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if self.malformed_batch {
                        return Ok(WorkspaceCommandResult {
                            stdout: "0".to_string(),
                            stderr: String::new(),
                            exit_code: 0,
                            interrupted: false,
                            timed_out: false,
                        });
                    }
                }
                self.local.exec_with_options(command, options).await
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn default_type_and_relative_globs_match_expected_files_with_real_candidates() {
            let dir = unfiltered_fixture();
            let root = dir.path().to_string_lossy().into_owned();
            let shell = LocalWorkspaceShell::new(root.clone());
            let has_rg = shell
                .exec("command -v rg >/dev/null 2>&1", Some(1000))
                .await
                .unwrap()
                .2
                == 0;
            let without_rg = WithoutRgShell {
                local: LocalWorkspaceShell::new(root.clone()),
                batches: Default::default(),
                malformed_batch: false,
            };
            for (options, expected) in unfiltered_cases(&root) {
                let accelerated =
                    grep_search_workspace(options.clone(), &LocalWorkspaceFs, Some(&shell))
                        .await
                        .unwrap();
                assert_eq!(accelerated.used_rg_candidates, has_rg);
                assert!(accelerated.used_rg_candidates || accelerated.used_grep_candidates);
                assert_expected_files(&accelerated.result, &expected);
                let system_grep =
                    grep_search_workspace(options, &LocalWorkspaceFs, Some(&without_rg))
                        .await
                        .unwrap();
                assert!(!system_grep.used_rg_candidates);
                assert!(system_grep.used_grep_candidates);
                assert_expected_files(&system_grep.result, &expected);
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn no_rg_uses_batched_system_grep_without_losing_bom_binary_or_filename_matches() {
            let dir = fixture();
            std::fs::write(
                dir.path().join("large-unmatched.py"),
                "unrelated bytes\n".repeat(262_144),
            )
            .unwrap();
            for index in 0..130 {
                std::fs::write(
                    dir.path().join(format!("unmatched-{index}.py")),
                    "no candidate\n",
                )
                .unwrap();
            }
            std::fs::write(
                dir.path().join("quote'\n\\.py"),
                b"prefix\0needle after nul\n",
            )
            .unwrap();
            for (name, bom, little_endian) in [
                ("utf16-le.py", [0xff, 0xfe], true),
                ("utf16-be.py", [0xfe, 0xff], false),
            ] {
                let mut bytes = bom.to_vec();
                for unit in "needle in utf16\n".encode_utf16() {
                    bytes.extend_from_slice(&if little_endian {
                        unit.to_le_bytes()
                    } else {
                        unit.to_be_bytes()
                    });
                }
                std::fs::write(dir.path().join(name), bytes).unwrap();
            }
            let root = dir.path().to_string_lossy().into_owned();
            let shell = WithoutRgShell {
                local: LocalWorkspaceShell::new(root.clone()),
                batches: Default::default(),
                malformed_batch: false,
            };
            let options = GrepOptions::new("needle|all_reduce", &root)
                .file_type("py")
                .display_base(&root)
                .head_limit(2)
                .offset(1)
                .context(1);
            let expected = grep_search_workspace(options.clone(), &LocalWorkspaceFs, None)
                .await
                .unwrap();
            let fs = ObservedFs::default();
            let actual = grep_search_workspace(options, &fs, Some(&shell))
                .await
                .unwrap();
            assert!(actual.used_grep_candidates);
            assert!(!actual.used_rg_candidates);
            assert_same(&actual.result, &expected.result);
            assert_eq!(shell.batches.load(std::sync::atomic::Ordering::Relaxed), 2);
            assert!(actual.scanned_bytes < expected.scanned_bytes / 100);
            let opened = fs.opened.lock().unwrap();
            assert!(opened.iter().any(|path| path.ends_with("utf16-le.py")));
            assert!(opened.iter().any(|path| path.ends_with("utf16-be.py")));
            assert!(!opened.iter().any(|path| path.contains("unmatched")));
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn a_truncated_grep_batch_is_an_error_not_an_empty_search() {
            let dir = fixture();
            let root = dir.path().to_string_lossy().into_owned();
            let shell = WithoutRgShell {
                local: LocalWorkspaceShell::new(root.clone()),
                batches: Default::default(),
                malformed_batch: true,
            };
            let fs = ObservedFs::default();
            let error =
                grep_search_workspace(GrepOptions::new("all_reduce", &root), &fs, Some(&shell))
                    .await
                    .err()
                    .expect("truncated output must fail");
            assert!(error.contains("completion marker"));
            assert!(fs.opened.lock().unwrap().is_empty());
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn no_match_is_success_with_an_errexit_target_shell() {
            struct ErrexitShell(LocalWorkspaceShell);
            #[async_trait::async_trait]
            impl WorkspaceShell for ErrexitShell {
                async fn exec_with_options(
                    &self,
                    command: &str,
                    options: WorkspaceCommandOptions,
                ) -> anyhow::Result<WorkspaceCommandResult> {
                    self.0
                        .exec_with_options(&format!("set -e\n{command}"), options)
                        .await
                }
            }
            let dir = fixture();
            let root = dir.path().to_string_lossy().into_owned();
            let shell = ErrexitShell(LocalWorkspaceShell::new(root.clone()));
            let result = grep_search_workspace(
                GrepOptions::new("absent_unique_literal", &root),
                &LocalWorkspaceFs,
                Some(&shell),
            )
            .await
            .unwrap();
            assert_eq!(result.result.total_matches, 0);
        }

        #[tokio::test]
        async fn target_regex_versions_cannot_prune_complex_or_case_folded_matches() {
            struct UnexpectedShell;
            #[async_trait::async_trait]
            impl WorkspaceShell for UnexpectedShell {
                async fn exec_with_options(
                    &self,
                    _: &str,
                    _: WorkspaceCommandOptions,
                ) -> anyhow::Result<WorkspaceCommandResult> {
                    panic!("complex regex must stay in the Runtime matcher")
                }
            }
            let dir = fixture();
            std::fs::write(dir.path().join("unicode.py"), "\u{1c89}\n").unwrap();
            let root = dir.path().to_string_lossy().into_owned();
            for options in [
                GrepOptions::new(r"\p{L}+", &root),
                GrepOptions::new(r"all_reduce|\d+", &root),
                GrepOptions::new("all_reduce", &root).case_insensitive(true),
            ] {
                let expected = grep_search_workspace(options.clone(), &LocalWorkspaceFs, None)
                    .await
                    .unwrap();
                let actual =
                    grep_search_workspace(options, &LocalWorkspaceFs, Some(&UnexpectedShell))
                        .await
                        .unwrap();
                assert_same(&actual.result, &expected.result);
                assert!(actual.result.total_matches > 0);
            }
        }

        #[tokio::test]
        async fn bounded_workspace_output_keeps_single_file_counts_and_truncation_facts() {
            let dir = fixture();
            let path = dir.path().join("large-match.py");
            std::fs::write(&path, "needle\n".repeat(10_000)).unwrap();
            for (offset, limit) in [(0, 2), (1, 2), (9_999, 2), (0, 0)] {
                let options = GrepOptions::new("needle", path.to_string_lossy())
                    .output_mode(OutputMode::Content)
                    .offset(offset)
                    .head_limit(limit);
                let result = compare_native_and_io(options).await;
                assert_eq!(result.total_matches, 10_000);
            }
        }

        #[tokio::test]
        async fn cancelling_pending_metadata_directory_or_open_returns_promptly() {
            let dir = fixture();
            for operation in ["metadata", "read_dir", "open"] {
                let fs = Arc::new(ObservedFs {
                    pending_operation: Some(operation),
                    ..Default::default()
                });
                let cancellation = SearchCancellation::default();
                let options = GrepOptions::new("all_reduce", dir.path().to_string_lossy())
                    .cancellation(cancellation.clone());
                let worker_fs = fs.clone();
                let task = tokio::spawn(async move {
                    grep_search_workspace(options, worker_fs.as_ref(), None).await
                });
                tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    fs.opened_signal.notified(),
                )
                .await
                .unwrap();
                cancellation.cancel();
                let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(result.result.cancelled, "{operation}");
            }
        }

        #[tokio::test]
        async fn candidate_status_errors_are_not_empty_success_or_posix_fallback() {
            let dir = fixture();
            let options =
                GrepOptions::new("all_reduce", dir.path().to_string_lossy()).file_type("py");
            let fs = ObservedFs::default();
            let absent = ResponseShell {
                status: 127,
                stdout: String::new(),
                timed_out: false,
            };
            let fallback = grep_search_workspace(options.clone(), &fs, Some(&absent))
                .await
                .unwrap();
            assert!(!fallback.used_rg_candidates);
            assert!(fallback.result.total_matches > 0);
            fs.opened.lock().unwrap().clear();
            let empty = ResponseShell {
                status: 1,
                stdout: "OPENBITFUN_RG_CANDIDATES_BEGIN\0OPENBITFUN_RG_CANDIDATES_END\0"
                    .to_string(),
                timed_out: false,
            };
            let result = grep_search_workspace(options.clone(), &fs, Some(&empty))
                .await
                .unwrap();
            assert!(result.used_rg_candidates);
            assert_eq!(result.result.total_matches, 0);
            assert!(fs.opened.lock().unwrap().is_empty());
            for (status, stdout, timed_out) in [
                (2, "", false),
                (0, "incomplete filename", false),
                (0, "", true),
            ] {
                let shell = ResponseShell {
                    status,
                    stdout: stdout.to_string(),
                    timed_out,
                };
                assert!(grep_search_workspace(options.clone(), &fs, Some(&shell))
                    .await
                    .is_err());
                assert!(fs.opened.lock().unwrap().is_empty());
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn real_rg_candidate_acceleration_keeps_rust_results_and_transfers_only_matches() {
            let dir = fixture();
            // Candidate selection must not stop at binary NULs, hidden files,
            // apostrophes or multiline input, and must leave type/glob semantics to Rust.
            std::fs::write(
                dir.path().join("binary.py"),
                b"prefix\0binary\nneedle after nul\n",
            )
            .unwrap();
            std::fs::write(dir.path().join("quote'name.py"), "needle 'quoted'\n").unwrap();
            std::fs::write(
                dir.path().join("unmatched.py"),
                "no candidate in this file\n",
            )
            .unwrap();
            let root = dir.path().to_string_lossy().into_owned();
            let shell = LocalWorkspaceShell::new(root.clone());
            let has_rg = shell
                .exec("command -v rg >/dev/null 2>&1", Some(1000))
                .await
                .unwrap()
                .2
                == 0;
            for (pattern, multiline, eligible) in [
                (r"(?i:all_reduce)|\d+", false, false),
                (r"before\nALL_REDUCE.*?\n", true, false),
                ("needle", false, true),
                ("needle 'quoted'", false, true),
            ] {
                let options = GrepOptions::new(pattern, &root)
                    .file_type("py")
                    .multiline(multiline)
                    .display_base(&root)
                    .head_limit(2)
                    .context(1);
                let expected = grep_search_workspace(options.clone(), &LocalWorkspaceFs, None)
                    .await
                    .unwrap();
                let fs = ObservedFs::default();
                let actual = grep_search_workspace(options, &fs, Some(&shell))
                    .await
                    .unwrap();
                assert_eq!(actual.used_rg_candidates, has_rg && eligible);
                assert_same(&actual.result, &expected.result);
                if actual.used_rg_candidates || actual.used_grep_candidates {
                    assert!(!fs
                        .opened
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|path| path.ends_with("/unmatched.py")));
                }
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn file_symlinks_are_searched_without_recursive_links_or_rg_false_negatives() {
            let dir = fixture();
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("source.py"), "linked sentinel\n").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("source.py"),
                dir.path().join("alias.py"),
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join("linked-directory"))
                .unwrap();
            let root = dir.path().to_string_lossy().into_owned();
            let options = GrepOptions::new("linked sentinel", &root).display_base(&root);
            let expected = compare_native_and_io(options.clone()).await;
            assert_eq!(expected.file_count, 1);
            let shell = LocalWorkspaceShell::new(root.clone());
            let actual = grep_search_workspace(options, &LocalWorkspaceFs, Some(&shell))
                .await
                .unwrap();
            assert_same(&actual.result, &expected);
            let explicit = GrepOptions::new(
                "linked sentinel",
                dir.path().join("alias.py").to_string_lossy(),
            )
            .display_base(&root);
            compare_native_and_io(explicit).await;
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn posix_filename_characters_survive_native_io_and_candidate_display() {
            let dir = fixture();
            for name in ["a\\b.py", "line\nbreak.py", "quote'name.py"] {
                std::fs::write(dir.path().join(name), "filename sentinel\n").unwrap();
            }
            let root = dir.path().to_string_lossy().into_owned();
            let options = GrepOptions::new("filename sentinel", &root).display_base(&root);
            let expected = compare_native_and_io(options.clone()).await;
            assert_eq!(expected.file_count, 3);
            assert!(expected.result_text.contains(r#""a\\b.py":1:"#));
            assert!(expected.result_text.contains(r#""line\nbreak.py":1:"#));
            let shell = LocalWorkspaceShell::new(root);
            let actual = grep_search_workspace(options, &LocalWorkspaceFs, Some(&shell))
                .await
                .unwrap();
            assert_same(&actual.result, &expected);
        }

        #[tokio::test]
        async fn remote_tool_uses_shared_options_results_and_no_rg_io_provider() {
            use super::*;
            use openbitfun_runtime_ports::WorkspaceServices;
            let dir = fixture();
            let root = dir.path().to_string_lossy().into_owned();
            let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
                &root,
                Some("search-test"),
                Some("test.invalid"),
            )
            .unwrap();
            let context = ToolUseContext {
                tool_call_id: None,
                agent_type: None,
                session_id: None,
                dialog_turn_id: None,
                workspace: Some(WorkspaceBinding::new_remote(
                    None,
                    dir.path().to_path_buf(),
                    "search-test".to_string(),
                    "Search test".to_string(),
                    identity,
                )),
                loaded_deferred_tool_specs: Vec::new(),
                primary_model_facts: Default::default(),
                custom_data: HashMap::new(),
                computer_use_host: None,
                runtime_tool_restrictions: Default::default(),
                runtime_handles: ToolRuntimeHandles::new(
                    Some(WorkspaceServices {
                        fs: Arc::new(LocalWorkspaceFs),
                        shell: Arc::new(ResponseShell {
                            status: 127,
                            stdout: String::new(),
                            timed_out: false,
                        }),
                    }),
                    None,
                ),
            };
            let input = json!({"pattern": "all_reduce|\\d+", "type": "py", "output_mode": "content", "-i": true, "context": 1, "offset": 1, "head_limit": 2});
            let tool = GrepTool::new();
            let expected = grep_search_workspace(
                tool.build_grep_options(&input, &context).unwrap(),
                &LocalWorkspaceFs,
                None,
            )
            .await
            .unwrap();
            let results = tool.call_impl(&input, &context).await.unwrap();
            let crate::agentic::tools::framework::ToolResult::Result { data, .. } = &results[0]
            else {
                panic!("expected result");
            };
            assert_eq!(data["result"], expected.result.result_text);
            assert_eq!(data["total_matches"], expected.result.total_matches);
            assert_eq!(data["search_backend"], "workspace_io");
        }

        #[tokio::test]
        async fn dropping_a_search_cancels_pending_io_without_cancelling_its_parent() {
            let dir = fixture();
            let parent = SearchCancellation::new();
            let options = GrepOptions::new("needle", dir.path().join("a.py").to_string_lossy())
                .cancellation(parent.clone());
            grep_search_workspace(options.clone(), &LocalWorkspaceFs, None)
                .await
                .unwrap();
            assert!(
                !parent.is_cancelled(),
                "normal completion must not cancel the turn token"
            );
            let fs = Arc::new(ObservedFs {
                pending_read: true,
                ..Default::default()
            });
            let worker_fs = fs.clone();
            let task = tokio::spawn(async move {
                grep_search_workspace(options, worker_fs.as_ref(), None).await
            });
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                fs.reader_pending_signal.notified(),
            )
            .await
            .unwrap();
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while fs.reader_drops.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            assert!(
                !parent.is_cancelled(),
                "dropping one search must not cancel its caller"
            );
        }

        #[tokio::test]
        async fn cancelling_a_pending_workspace_read_releases_the_reader_and_worker() {
            let dir = fixture();
            let fs = Arc::new(ObservedFs {
                pending_read: true,
                ..Default::default()
            });
            let cancellation = SearchCancellation::new();
            let mut options = GrepOptions::new("needle", dir.path().join("a.py").to_string_lossy());
            options.cancellation = Some(cancellation.clone());
            let worker_fs = fs.clone();
            let task = tokio::spawn(async move {
                grep_search_workspace(options, worker_fs.as_ref(), None).await
            });
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                fs.reader_pending_signal.notified(),
            )
            .await
            .unwrap();
            cancellation.cancel();
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(result.result.cancelled);
            assert_eq!(fs.reader_drops.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }
}
