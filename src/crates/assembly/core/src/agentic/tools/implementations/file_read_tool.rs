use crate::agentic::tools::file_permissions::file_permission_intents;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
#[cfg(feature = "tools-miniapp")]
use crate::agentic::tools::miniapp_context_runtime::{
    is_virtual_context_path, requires_virtual_context_path, virtual_context_file,
};
use crate::agentic::tools::parse_u64_value;
use crate::agentic::tools::review_read_receipt_runtime::{
    file_revision, get_review_read_coverage, record_review_read_receipt,
    review_read_receipts_enabled,
};
use crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri;
use crate::agentic::tools::ToolPathOperation;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::timing::elapsed_ms_u64;
use async_trait::async_trait;
use log::{debug, warn};
use serde_json::{json, Value};
use std::convert::TryFrom;
use std::path::Path;
#[cfg(feature = "document-read")]
use std::time::Duration;
use std::time::Instant;
use tool_runtime::fs::document::is_supported_document_path;
#[cfg(feature = "document-read")]
use tool_runtime::fs::document::{
    convert_document_to_markdown, DocumentConversionError, MAX_DOCUMENT_INPUT_BYTES,
    MAX_DOCUMENT_MARKDOWN_BYTES,
};
use tool_runtime::fs::read_file::{
    build_read_file_presentation, read_file_from_reader, read_file_tail_from_reader, ReadFileResult,
};
#[cfg(any(feature = "document-read", feature = "tools-miniapp"))]
use tool_runtime::fs::read_file::{read_text, read_text_tail};

pub struct FileReadTool {
    default_max_lines_to_read: usize,
    max_line_chars: usize,
    max_total_chars: usize,
}

/// Default cap on characters returned by a single Read call (excluding wrapper text).
pub const DEFAULT_READ_MAX_TOTAL_CHARS: usize = 64_000;
#[cfg(feature = "document-read")]
// anydoc is synchronous, so this bounds the caller's wait rather than terminating the parser.
// The worker retains the global conversion permit until it actually exits, keeping failures closed.
const DOCUMENT_CONVERSION_TIMEOUT: Duration = Duration::from_secs(30);

struct DocumentReadMetadata {
    source_format: &'static str,
    source_size_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadRenderMode {
    Auto,
    Source,
    Markdown,
}

impl Default for FileReadTool {
    fn default() -> Self {
        Self::new()
    }
}

impl FileReadTool {
    pub fn new() -> Self {
        Self {
            default_max_lines_to_read: 2000,
            max_line_chars: 2000,
            max_total_chars: DEFAULT_READ_MAX_TOTAL_CHARS,
        }
    }

    pub fn with_config(
        default_max_lines_to_read: usize,
        max_line_chars: usize,
        max_total_chars: usize,
    ) -> Self {
        Self {
            default_max_lines_to_read,
            max_line_chars,
            max_total_chars,
        }
    }

    fn already_served_result(
        logical_path: &str,
        coverage: crate::agentic::session::ReviewReadCoverage,
    ) -> ToolResult {
        ToolResult::Result {
            data: json!({
                "file_path": logical_path,
                "status": "already_served",
                "start_line": coverage.start_line,
                "end_line": coverage.end_line,
                "total_lines": coverage.total_lines,
            }),
            result_for_assistant: Some(format!(
                "{} lines {}-{} were already returned earlier in this review and the file revision is unchanged. Reuse the prior Read output; request only an unread range if more context is needed.",
                logical_path, coverage.start_line, coverage.end_line
            )),
            image_attachments: None,
        }
    }

    fn read_window_start_line(input: &Value) -> Result<usize, String> {
        Self::optional_line_number(input, "offset")?.map_or(Ok(1), |offset| Ok(offset.max(1)))
    }

    fn read_tail_mode(input: &Value) -> Result<bool, String> {
        let tail = match input.get("tail") {
            Some(value) => value
                .as_bool()
                .ok_or_else(|| "tail must be a boolean".to_string())?,
            None => false,
        };

        if tail && input.get("offset").is_some() {
            return Err("Do not provide offset when tail is true".to_string());
        }

        Ok(tail)
    }

    fn read_render_mode(input: &Value) -> Result<ReadRenderMode, String> {
        match input.get("render") {
            None => Ok(ReadRenderMode::Auto),
            Some(Value::String(value)) if value == "auto" => Ok(ReadRenderMode::Auto),
            Some(Value::String(value)) if value == "source" => Ok(ReadRenderMode::Source),
            Some(Value::String(value)) if value == "markdown" => Ok(ReadRenderMode::Markdown),
            Some(_) => Err("render must be one of: auto, source, markdown".to_string()),
        }
    }

    fn path_has_csv_extension(path: &str) -> bool {
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
    }

    fn optional_line_number(input: &Value, key: &str) -> Result<Option<usize>, String> {
        match input.get(key) {
            Some(value) => Self::line_number_from_value(value)
                .map(Some)
                .map_err(|message| format!("{} {}", key, message)),
            None => Ok(None),
        }
    }

    fn line_number_from_value(value: &Value) -> Result<usize, &'static str> {
        if let Some(number) = value.as_u64() {
            return usize::try_from(number).map_err(|_| "is too large");
        }

        if let Some(number) = value.as_i64() {
            if number < 0 {
                return Err("must be a non-negative integer");
            }
            return usize::try_from(number as u64).map_err(|_| "is too large");
        }

        if let Some(number) = value.as_f64() {
            if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
                return Err("must be a non-negative integer");
            }
            if number > usize::MAX as f64 {
                return Err("is too large");
            }
            return Ok(number as usize);
        }

        Err("must be a non-negative integer")
    }

    #[cfg(feature = "document-read")]
    async fn read_document_window(
        &self,
        resolved_path: &str,
        logical_path: &str,
        start_line: usize,
        limit: usize,
        tail: bool,
        filesystem: &dyn crate::agentic::workspace::WorkspaceFileSystem,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<(ReadFileResult, DocumentReadMetadata)> {
        let bytes = filesystem
            .read_file_bounded(resolved_path, MAX_DOCUMENT_INPUT_BYTES)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to read document {}: {:#}",
                    logical_path, error
                ))
            })?
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "Document {} is larger than the {} MiB Read limit",
                    logical_path,
                    MAX_DOCUMENT_INPUT_BYTES / (1024 * 1024)
                ))
            })?;

        let source_size_bytes = bytes.len();
        let conversion_started_at = Instant::now();
        debug!(
            "Document conversion started: path={}, source_size_bytes={}, session_id={:?}, dialog_turn_id={:?}",
            logical_path,
            source_size_bytes,
            context.session_id,
            context.dialog_turn_id
        );
        let conversion = tokio::time::timeout(
            DOCUMENT_CONVERSION_TIMEOUT,
            convert_document_to_markdown(bytes, resolved_path.to_string()),
        )
        .await
        .map_err(|_| {
            warn!(
                "Document conversion timed out: path={}, source_size_bytes={}, timeout_ms={}, duration_ms={}",
                logical_path,
                source_size_bytes,
                DOCUMENT_CONVERSION_TIMEOUT.as_millis(),
                elapsed_ms_u64(conversion_started_at)
            );
            OpenBitFunError::tool(format!(
                "Document conversion did not finish within {} seconds: {}",
                DOCUMENT_CONVERSION_TIMEOUT.as_secs(),
                logical_path
            ))
        })?;
        let converted = conversion.map_err(|error| {
                warn!(
                    "Document conversion failed: path={}, source_size_bytes={}, duration_ms={}, error_code={}, error={}",
                    logical_path,
                    source_size_bytes,
                    elapsed_ms_u64(conversion_started_at),
                    error.code(),
                    error
                );
                Self::document_conversion_error(logical_path, resolved_path, error)
            })?;
        debug!(
            "Document conversion completed: path={}, source_format={}, source_size_bytes={}, markdown_size_bytes={}, duration_ms={}",
            logical_path,
            converted.source_format,
            source_size_bytes,
            converted.markdown.len(),
            elapsed_ms_u64(conversion_started_at)
        );

        let read_result = if tail {
            read_text_tail(
                &converted.markdown,
                limit,
                self.max_line_chars,
                self.max_total_chars,
            )
        } else {
            read_text(
                &converted.markdown,
                start_line,
                limit,
                self.max_line_chars,
                self.max_total_chars,
            )
        }
        .map_err(OpenBitFunError::tool)?;

        Ok((
            read_result,
            DocumentReadMetadata {
                source_format: converted.source_format,
                source_size_bytes,
            },
        ))
    }

    #[cfg(feature = "document-read")]
    fn document_conversion_error(
        logical_path: &str,
        resolved_path: &str,
        error: DocumentConversionError,
    ) -> OpenBitFunError {
        let ocr_hint = (error.code() == "unsupported"
            && Path::new(resolved_path)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")))
        .then_some(
            " Text PDFs are supported, but scanned or image-only PDFs require an OCR workflow.",
        )
        .unwrap_or_default();
        OpenBitFunError::tool(format!(
            "Failed to convert document {} to Markdown ({}): {}.{}",
            logical_path,
            error.code(),
            error,
            ocr_hint
        ))
    }
}

#[async_trait]
impl Tool for FileReadTool {
    fn name(&self) -> &str {
        "Read"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        #[cfg(feature = "document-read")]
        let document_summary = " Office documents, OpenDocument files, RTF, EPUB, and PDFs are converted locally to GitHub-Flavored Markdown before reading.";
        #[cfg(not(feature = "document-read"))]
        let document_summary = "";
        #[cfg(feature = "document-read")]
        let document_guidance = format!(
            r#"- Supported document extensions are .doc, .docx, .docm, .ppt, .pps, .pot, .pptx, .pptm, .ppsx, .ppsm, .xls, .xlsx, .xlsm, .xlsb, .odt, .ods, .odp, .rtf, .epub, .csv, and .pdf. Document input is capped at {} MiB and extracted Markdown at {} MiB. Conversion is offline and never fetches linked resources.
- render defaults to auto. auto converts supported documents but preserves CSV as exact source text for editing compatibility. Use render=markdown to turn CSV into a Markdown table or to content-detect a document with a missing/wrong extension. Use render=source to bypass conversion for a textual document such as CSV or RTF.
- For converted documents, offset, limit, tail, line numbers, and total_lines refer to the extracted Markdown, not source pages or rows. The Markdown is a read-only representation; do not use it as exact source text for Edit. Embedded objects are represented by text, and scanned/image-only PDF pages require OCR.
"#,
            MAX_DOCUMENT_INPUT_BYTES / (1024 * 1024),
            MAX_DOCUMENT_MARKDOWN_BYTES / (1024 * 1024),
        );
        #[cfg(not(feature = "document-read"))]
        let document_guidance = "";

        Ok(format!(
            r#"Reads a file from the current workspace filesystem.{document_summary} If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be workspace-relative, an absolute path inside the current workspace, or an exact `openbitfun://...` URI returned by another tool.
- Do not read host roots or placeholder paths such as `/workspace`.
{document_guidance}- By default, it reads up to {} lines starting from the beginning of the file. When you plan to Edit a file, prefer this default full read so you see the exact bytes you will need to match.
- You can optionally specify an offset and limit. offset is a 1-based line number. Use a range only when you already know the target lines; the range must include every line you will copy into Edit `old_string`.
- You can set tail=true with limit to read the last N lines. This is useful for command output and logs. Do not combine tail=true with offset.
- Any lines longer than {} characters will be truncated.
- Total output is capped at {} characters. If that limit is hit, continue with offset/limit, until the target lines are fully visible, then Edit using only text from those Read results.
- Results are returned using cat -n format, with line numbers starting at 1.
- This tool can only read files, not directories.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- Avoid tiny repeated slices (e.g. 30-100 line chunks). If you need more context, read a larger window that covers the whole block you will edit.
- Do not use `limit` with a small value (e.g. < 50) to probe file type or structure. Source files typically begin with copyright headers — a probe read returns no useful code.
"#,
            self.default_max_lines_to_read, self.max_line_chars, self.max_total_chars
        ))
    }

    fn short_description(&self) -> String {
        #[cfg(feature = "document-read")]
        return "Read text files and extract documents.".to_string();
        #[cfg(not(feature = "document-read"))]
        return "Read text files.".to_string();
    }

    fn input_schema(&self) -> Value {
        let schema = json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "The file to read. Use a workspace-relative path, an absolute path inside the current workspace, or an exact openbitfun:// URI returned by another tool."
                },
                "offset": {
                    "type": "number",
                    "description": "The 1-based line number to start reading from. offset=0 is accepted as offset=1. Only provide if the file is too large to read at once."
                },
                "tail": {
                    "type": "boolean",
                    "description": "Read the last N lines of the file, where N is limit. Do not provide offset when tail is true."
                },
                "limit": {
                    "type": "number",
                    "description": "The number of lines to read. Only provide if the file is too large to read at once."
                }
            },
            "required": ["file_path"],
            "additionalProperties": false
        });
        #[cfg(feature = "document-read")]
        let schema = {
            let mut schema = schema;
            schema["properties"]["render"] = json!({
                "type": "string",
                "enum": ["auto", "source", "markdown"],
                "description": "How to represent the file. auto converts supported documents but preserves CSV source text; source bypasses conversion; markdown forces local anydoc conversion and enables content detection. Defaults to auto."
            });
            schema
        };
        #[cfg(not(feature = "document-read"))]
        let schema = {
            let mut schema = schema;
            schema["properties"]["render"] = json!({
                "type": "string",
                "enum": ["auto", "source"],
                "description": "How to read the file. auto reads ordinary text and reports known document formats as unavailable; source bypasses document detection for text-based formats. Defaults to auto."
            });
            schema
        };
        schema
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let file_path = input
            .get("file_path")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("file_path is required".to_string()))?;
        file_permission_intents("read", [file_path], context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let file_path = match input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) if !p.is_empty() => p,
            Some(_) => {
                return ValidationResult {
                    result: false,
                    message: Some("file_path cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
            None => {
                return ValidationResult {
                    result: false,
                    message: Some("file_path is required".to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
        };

        if let Err(message) = Self::read_tail_mode(input)
            .and_then(|_| Self::read_window_start_line(input))
            .and_then(|_| Self::read_render_mode(input))
        {
            return ValidationResult {
                result: false,
                message: Some(message),
                error_code: Some(400),
                meta: None,
            };
        }

        let resolved = match context.map(|ctx| ctx.resolve_tool_path(file_path)) {
            Some(Ok(path)) => path,
            Some(Err(err)) => {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
            None => {
                if is_openbitfun_tool_uri(file_path) {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "Tool context is required to resolve OpenBitFun URIs".to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                let path = Path::new(file_path);
                if !path.is_absolute() {
                    return ValidationResult {
                        result: false,
                        message: Some("file_path must be absolute".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                if !path.exists() {
                    return ValidationResult {
                        result: false,
                        message: Some(format!("File does not exist: {}", file_path)),
                        error_code: Some(404),
                        meta: None,
                    };
                }

                if !path.is_file() {
                    return ValidationResult {
                        result: false,
                        message: Some(format!("Path is not a file: {}", file_path)),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                return ValidationResult::default();
            }
        };

        #[cfg(feature = "tools-miniapp")]
        if let Some(context) = context.filter(|context| is_virtual_context_path(context, &resolved))
        {
            return if virtual_context_file(context, &resolved).is_some() {
                ValidationResult::default()
            } else {
                ValidationResult {
                    result: false,
                    message: Some(format!(
                        "MiniApp context file is unavailable: {}",
                        resolved.logical_path
                    )),
                    error_code: Some(404),
                    meta: None,
                }
            };
        }
        #[cfg(feature = "tools-miniapp")]
        if context.is_some_and(requires_virtual_context_path) {
            return ValidationResult {
                result: false,
                message: Some(format!(
                    "MiniApp context file is unavailable: {}",
                    resolved.logical_path
                )),
                error_code: Some(404),
                meta: None,
            };
        }

        if let Some(context) = context {
            let metadata = match context.file_system_for_path(&resolved) {
                Ok(filesystem) => filesystem.metadata(&resolved.resolved_path, true).await,
                Err(error) => Err(anyhow::anyhow!(error.to_string())),
            };
            let metadata = match metadata {
                Ok(metadata) => metadata,
                Err(error) => {
                    return ValidationResult {
                        result: false,
                        message: Some(format!(
                            "Failed to inspect file {}: {:#}",
                            resolved.logical_path, error
                        )),
                        error_code: Some(400),
                        meta: None,
                    }
                }
            };
            let Some(metadata) = metadata else {
                return ValidationResult {
                    result: false,
                    message: Some(format!("File does not exist: {}", resolved.logical_path)),
                    error_code: Some(404),
                    meta: None,
                };
            };
            if metadata.kind != openbitfun_runtime_ports::WorkspacePathKind::File {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Path is not a file: {}", resolved.logical_path)),
                    error_code: Some(400),
                    meta: None,
                };
            }
        }

        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
            if options.verbose {
                format!("Reading file: {}", file_path)
            } else {
                format!("Read {}", file_path)
            }
        } else {
            "Reading file".to_string()
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let file_path = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("file_path is required".to_string()))?;

        let tail = Self::read_tail_mode(input).map_err(OpenBitFunError::tool)?;
        let render_mode = Self::read_render_mode(input).map_err(OpenBitFunError::tool)?;
        let start_line = Self::read_window_start_line(input).map_err(OpenBitFunError::tool)?;

        let limit = input
            .get("limit")
            .and_then(parse_u64_value)
            .unwrap_or(self.default_max_lines_to_read as u64) as usize;

        let resolved = context.resolve_tool_path(file_path)?;
        context.enforce_path_operation(ToolPathOperation::Read, &resolved)?;
        #[cfg(feature = "tools-miniapp")]
        if is_virtual_context_path(context, &resolved) {
            let content = virtual_context_file(context, &resolved).ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "MiniApp context file is unavailable: {}",
                    resolved.logical_path
                ))
            })?;
            let read_file_result = if tail {
                read_text_tail(&content, limit, self.max_line_chars, self.max_total_chars)
            } else {
                read_text(
                    &content,
                    start_line,
                    limit,
                    self.max_line_chars,
                    self.max_total_chars,
                )
            }
            .map_err(OpenBitFunError::tool)?;
            let presentation =
                build_read_file_presentation(&resolved.logical_path, &read_file_result);
            return Ok(vec![ToolResult::Result {
                data: json!({
                    "file_path": resolved.logical_path,
                    "content": read_file_result.content,
                    "total_lines": read_file_result.total_lines,
                    "lines_read": presentation.lines_read,
                    "offset": read_file_result.start_line,
                    "tail": tail,
                    "start_line": read_file_result.start_line,
                    "size": read_file_result.content.len(),
                    "hit_total_char_limit": read_file_result.hit_total_char_limit,
                    "representation": "miniapp_context"
                }),
                result_for_assistant: Some(presentation.result_for_assistant),
                image_attachments: None,
            }]);
        }
        #[cfg(feature = "tools-miniapp")]
        if requires_virtual_context_path(context) {
            return Err(OpenBitFunError::tool(format!(
                "MiniApp context file is unavailable: {}",
                resolved.logical_path
            )));
        }
        crate::agentic::deep_review::scope::ensure_focused_review_resolved_path_allowed(
            context,
            &resolved.resolved_path,
        )?;
        let filesystem = context.file_system_for_path(&resolved)?;
        let supported_document_path = is_supported_document_path(&resolved.logical_path)
            || is_supported_document_path(&resolved.resolved_path);
        let csv_path = Self::path_has_csv_extension(&resolved.logical_path)
            || Self::path_has_csv_extension(&resolved.resolved_path);
        let reads_document_representation = match render_mode {
            ReadRenderMode::Auto => supported_document_path && !csv_path,
            ReadRenderMode::Source => false,
            ReadRenderMode::Markdown => true,
        };
        #[cfg(not(feature = "document-read"))]
        if reads_document_representation {
            return Err(OpenBitFunError::tool(format!(
                "Document Markdown conversion is not available in this product build: {}. Use a product that includes document-read, or render=source for text-based formats.",
                resolved.logical_path
            )));
        }
        let revision_before_read =
            if reads_document_representation || tail || !review_read_receipts_enabled(context) {
                None
            } else {
                file_revision(context, &resolved).await
            };
        if let Some(coverage) = revision_before_read.and_then(|revision| {
            get_review_read_coverage(context, &resolved, revision, start_line, limit)
        }) {
            return Ok(vec![Self::already_served_result(
                &resolved.logical_path,
                coverage,
            )]);
        }

        #[cfg(feature = "document-read")]
        let document_read = if reads_document_representation {
            Some(
                self.read_document_window(
                    &resolved.resolved_path,
                    &resolved.logical_path,
                    start_line,
                    limit,
                    tail,
                    filesystem.as_ref(),
                    context,
                )
                .await?,
            )
        } else {
            None
        };
        #[cfg(not(feature = "document-read"))]
        let document_read: Option<(ReadFileResult, DocumentReadMetadata)> = None;

        let (read_file_result, document_metadata) = if let Some((result, metadata)) = document_read
        {
            (result, Some(metadata))
        } else {
            let read_started_at = Instant::now();
            let reader = filesystem
                .open_read(&resolved.resolved_path)
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(format!(
                        "Failed to open file {}: {:#}",
                        resolved.logical_path, error
                    ))
                })?;
            let result = if tail {
                read_file_tail_from_reader(
                    reader,
                    &resolved.logical_path,
                    limit,
                    self.max_line_chars,
                    self.max_total_chars,
                )
                .await
            } else {
                read_file_from_reader(
                    reader,
                    &resolved.logical_path,
                    start_line,
                    limit,
                    self.max_line_chars,
                    self.max_total_chars,
                )
                .await
            }
            .map_err(|error| {
                warn!(
                    "Workspace file stream read failed: path={} duration_ms={} error={}",
                    resolved.logical_path,
                    elapsed_ms_u64(read_started_at),
                    error
                );
                OpenBitFunError::tool(error)
            })?;
            debug!("Workspace file stream read completed: path={} start_line={} end_line={} total_lines={} hit_total_char_limit={} duration_ms={}",
                resolved.logical_path, result.start_line, result.end_line, result.total_lines,
                result.hit_total_char_limit, elapsed_ms_u64(read_started_at));
            (result, None)
        };

        if let Some(revision_before) = revision_before_read {
            if let Some(revision_after) = file_revision(context, &resolved).await {
                if revision_before == revision_after {
                    record_review_read_receipt(
                        context,
                        &resolved,
                        revision_after,
                        &read_file_result,
                    );
                }
            }
        }

        let presentation = build_read_file_presentation(&resolved.logical_path, &read_file_result);
        let mut result_for_assistant = presentation.result_for_assistant;
        if let Some(metadata) = document_metadata.as_ref() {
            let extraction_note = if metadata.source_format == "pdf" {
                " OCR is not performed, so scanned or image-only pages may be omitted."
            } else {
                " Embedded images and objects are represented by their available text."
            };
            result_for_assistant = format!(
                "Converted {} from {} to GitHub-Flavored Markdown with anydoc. offset and limit refer to converted Markdown lines.{}\n\n{}",
                resolved.logical_path,
                metadata.source_format.to_ascii_uppercase(),
                extraction_note,
                result_for_assistant
            );
        }

        let mut data = json!({
            "file_path": resolved.logical_path,
            "content": read_file_result.content,
            "total_lines": read_file_result.total_lines,
            "lines_read": presentation.lines_read,
            "offset": read_file_result.start_line,
            "tail": tail,
            "start_line": read_file_result.start_line,
            "size": read_file_result.content.len(),
            "hit_total_char_limit": read_file_result.hit_total_char_limit,
            "content_truncated": read_file_result.content_truncated
        });
        if let Some(metadata) = document_metadata {
            data["representation"] = json!("extracted_markdown");
            data["source_format"] = json!(metadata.source_format);
            data["source_size_bytes"] = json!(metadata.source_size_bytes);
            data["conversion_engine"] = json!("anydoc");
            data["extraction_warnings"] = if metadata.source_format == "pdf" {
                json!(["OCR is not performed; scanned or image-only pages may be omitted."])
            } else {
                json!(["Embedded images and objects are represented by their available text."])
            };
        }

        let result = ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        };

        Ok(vec![result])
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "document-read")]
    use super::MAX_DOCUMENT_INPUT_BYTES;
    use super::{FileReadTool, ReadRenderMode};
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use crate::agentic::tools::{ToolPathPolicy, ToolRuntimeRestrictions};
    use crate::agentic::WorkspaceBinding;
    #[cfg(feature = "tools-miniapp")]
    use crate::miniapp::agent_context::{
        publish_agent_context_snapshot, remove_agent_context_snapshot, MiniAppAgentContextInput,
    };
    use async_trait::async_trait;
    use openbitfun_runtime_ports::ToolRuntimeHandles;
    use openbitfun_runtime_ports::{
        WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
        WorkspaceServices, WorkspaceShell,
    };
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn local_context(root: PathBuf) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Agent".to_string()),
            session_id: None,
            dialog_turn_id: Some("turn-1".to_string()),
            workspace: Some(WorkspaceBinding::new(
                Some("read-document-workspace".to_string()),
                root,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: ToolRuntimeHandles::default(),
        }
    }

    struct FakeRemoteFs {
        bytes: Vec<u8>,
        bounded_limit: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl WorkspaceFileSystem for FakeRemoteFs {
        async fn open_read(
            &self,
            _path: &str,
        ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
            Ok(Box::new(std::io::Cursor::new(self.bytes.clone())))
        }

        async fn metadata(
            &self,
            _path: &str,
            _follow_symlinks: bool,
        ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
            Ok(Some(openbitfun_runtime_ports::WorkspaceMetadata {
                kind: openbitfun_runtime_ports::WorkspacePathKind::File,
                size: Some(self.bytes.len() as u64),
                modified: None,
                permissions: None,
            }))
        }

        async fn read_file(&self, _path: &str) -> anyhow::Result<Vec<u8>> {
            Ok(self.bytes.clone())
        }

        async fn read_file_bounded(
            &self,
            _path: &str,
            max_bytes: usize,
        ) -> anyhow::Result<Option<Vec<u8>>> {
            self.bounded_limit.store(max_bytes, Ordering::Relaxed);
            Ok((self.bytes.len() <= max_bytes).then(|| self.bytes.clone()))
        }

        async fn read_file_text(&self, _path: &str) -> anyhow::Result<String> {
            Ok(String::from_utf8_lossy(&self.bytes).to_string())
        }

        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            Ok(())
        }

        async fn exists(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }

        async fn is_file(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(Vec::new())
        }
    }

    struct PanicRemoteShell;

    #[async_trait]
    impl WorkspaceShell for PanicRemoteShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            _options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            panic!("file reads must not require a remote shell or remote anydoc install")
        }
    }

    fn remote_context(bytes: Vec<u8>, bounded_limit: Arc<AtomicUsize>) -> ToolUseContext {
        let root = "/remote/workspace";
        let session_identity =
            crate::service::remote_ssh::workspace_state::workspace_session_identity(
                root,
                Some("conn-1"),
                Some("remote-host"),
            )
            .expect("remote workspace identity");
        let mut context = local_context(PathBuf::from(root));
        context.workspace = Some(WorkspaceBinding::new_remote(
            Some("read-document-remote".to_string()),
            PathBuf::from(root),
            "conn-1".to_string(),
            "remote-host".to_string(),
            session_identity,
        ));
        context.runtime_handles = ToolRuntimeHandles::new(
            Some(WorkspaceServices {
                fs: Arc::new(FakeRemoteFs {
                    bytes,
                    bounded_limit,
                }),
                shell: Arc::new(PanicRemoteShell),
            }),
            None,
        );
        context
    }

    #[tokio::test]
    async fn remote_text_read_uses_the_shared_stream_parser_without_shell() {
        let bytes = "first\r\n中😀文\r\nlast".as_bytes().to_vec();
        let context = remote_context(bytes, Arc::new(AtomicUsize::new(0)));
        let tool = FileReadTool::new();
        let results = tool
            .call(
                &json!({"file_path":"source.txt", "offset":2, "limit":1}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("result");
        };
        assert_eq!(data["content"], "     2\t中😀文");
        assert_eq!(data["total_lines"], 3);
        let results = tool
            .call(
                &json!({"file_path":"source.txt", "tail":true, "limit":2}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("result");
        };
        assert_eq!(data["content"], "     2\t中😀文\n     3\tlast");
        assert_eq!(data["offset"], 2);
    }

    #[tokio::test]
    async fn remote_text_read_rejects_invalid_utf8_and_missing_provider() {
        let mut context = remote_context(
            b"valid\n\xffinvalid".to_vec(),
            Arc::new(AtomicUsize::new(0)),
        );
        let tool = FileReadTool::new();
        let input = json!({"file_path":"source.txt", "limit":1});
        let error = tool.call(&input, &context).await.unwrap_err();
        assert!(error.to_string().contains("Failed to read"), "{error}");
        context.runtime_handles = ToolRuntimeHandles::default();
        let error = tool.call(&input, &context).await.unwrap_err();
        assert!(error.to_string().contains("unavailable"), "{error}");
    }

    #[test]
    fn read_tool_schema_prefers_offset() {
        let schema = FileReadTool::new().input_schema();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("properties");

        assert!(properties.contains_key("offset"));
        assert!(properties.contains_key("tail"));
        #[cfg(feature = "document-read")]
        assert_eq!(
            properties["render"]["enum"],
            json!(["auto", "source", "markdown"])
        );
    }

    #[tokio::test]
    async fn read_tool_enforces_runtime_read_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scope = "0123456789abcdef0123456789abcdef";
        let allowed_root = dir.path().join(".miniapp-context").join(scope);
        fs::create_dir_all(&allowed_root).expect("create context root");
        fs::write(allowed_root.join("stocks.ndjson"), "allowed").expect("write allowed file");
        fs::write(dir.path().join("storage.json"), "blocked").expect("write blocked file");

        let mut context = local_context(dir.path().to_path_buf());
        context.runtime_tool_restrictions.path_policy = ToolPathPolicy {
            read_roots: vec![format!(".miniapp-context/{scope}")],
            ..Default::default()
        };
        let tool = FileReadTool::new();

        tool.call_impl(
            &json!({ "file_path": format!(".miniapp-context/{scope}/stocks.ndjson") }),
            &context,
        )
        .await
        .expect("reserved context file should be readable");
        let error = tool
            .call_impl(&json!({ "file_path": "storage.json" }), &context)
            .await
            .expect_err("app storage outside reserved context must stay blocked");
        assert!(error.to_string().contains("is not allowed for read"));
    }

    #[cfg(feature = "tools-miniapp")]
    #[tokio::test]
    async fn read_tool_uses_virtual_context_without_filesystem_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = publish_agent_context_snapshot(
            "read-virtual-app",
            "read-virtual-session",
            "read-virtual-turn",
            vec![MiniAppAgentContextInput {
                name: "stocks.ndjson".to_string(),
                content: "host-owned row".to_string(),
            }],
        )
        .unwrap()
        .unwrap();
        let physical_root = dir.path().join(&snapshot.relative_root);
        fs::create_dir_all(&physical_root).unwrap();
        fs::write(physical_root.join("stocks.ndjson"), "attacker row").unwrap();
        fs::create_dir_all(physical_root.join("nested")).unwrap();
        fs::write(
            physical_root.join("nested/stocks.ndjson"),
            "nested attacker row",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&physical_root, dir.path().join("context-alias")).unwrap();

        let mut context = local_context(dir.path().to_path_buf());
        context.runtime_tool_restrictions = ToolRuntimeRestrictions {
            path_policy: ToolPathPolicy {
                read_roots: vec![snapshot.relative_root.clone()],
                ..Default::default()
            },
            miniapp_context_scope: Some(snapshot.scope.clone()),
            ..Default::default()
        };
        let input = json!({
            "file_path": format!("{}/stocks.ndjson", snapshot.relative_root)
        });
        let results = FileReadTool::new()
            .call_impl(&input, &context)
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("Read should return a normal result");
        };
        assert!(data["content"]
            .as_str()
            .is_some_and(|content| content.contains("host-owned row")));
        assert!(!data["content"]
            .as_str()
            .is_some_and(|content| content.contains("attacker row")));

        let nested_error = FileReadTool::new()
            .call_impl(
                &json!({
                    "file_path": format!("{}/nested/stocks.ndjson", snapshot.relative_root)
                }),
                &context,
            )
            .await
            .expect_err("the entire virtual scope must reject nested physical paths");
        assert!(nested_error
            .to_string()
            .contains("context file is unavailable"));

        #[cfg(unix)]
        {
            let alias_error = FileReadTool::new()
                .call_impl(
                    &json!({ "file_path": "context-alias/stocks.ndjson" }),
                    &context,
                )
                .await
                .expect_err("a physical alias into the virtual root must fail closed");
            assert!(alias_error
                .to_string()
                .contains("context file is unavailable"));
        }

        assert!(remove_agent_context_snapshot(
            "read-virtual-session",
            "read-virtual-turn"
        ));
        let error = FileReadTool::new()
            .call_impl(&input, &context)
            .await
            .expect_err("expired virtual context must not fall back to the physical file");
        assert!(error.to_string().contains("context file is unavailable"));
    }

    #[cfg(not(feature = "document-read"))]
    #[tokio::test]
    async fn read_tool_without_document_support_does_not_advertise_conversion() {
        let tool = FileReadTool::new();
        let schema = tool.input_schema();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("properties");

        assert_eq!(properties["render"]["enum"], json!(["auto", "source"]));
        assert!(!properties["render"]["description"]
            .as_str()
            .expect("render description")
            .contains("Markdown"));
        assert!(!tool
            .description()
            .await
            .expect("description")
            .contains("converted locally"));
        assert_eq!(tool.short_description(), "Read text files.");
    }

    #[cfg(not(feature = "document-read"))]
    #[tokio::test]
    async fn read_tool_without_document_support_fails_closed_for_document_rendering() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("notes.rtf"), br"{\rtf1\ansi Hello}").expect("write RTF");
        fs::write(dir.path().join("notes.txt"), "plain text").expect("write text");
        let context = local_context(dir.path().to_path_buf());
        let tool = FileReadTool::new();

        let auto_error = tool
            .call_impl(&json!({ "file_path": "notes.rtf" }), &context)
            .await
            .expect_err("known document path must not fall back to source text");
        assert!(auto_error
            .to_string()
            .contains("Document Markdown conversion is not available"));

        let markdown_error = tool
            .call_impl(
                &json!({ "file_path": "notes.txt", "render": "markdown" }),
                &context,
            )
            .await
            .expect_err("forced Markdown conversion must be unavailable");
        assert!(markdown_error
            .to_string()
            .contains("Document Markdown conversion is not available"));

        let source = tool
            .call_impl(
                &json!({ "file_path": "notes.rtf", "render": "source" }),
                &context,
            )
            .await
            .expect("explicit source reads remain available");
        let ToolResult::Result { data, .. } = &source[0] else {
            panic!("expected result");
        };
        assert!(data["content"]
            .as_str()
            .is_some_and(|content| content.contains("Hello")));
    }

    #[test]
    fn read_window_start_line_prefers_offset_and_normalizes_zero() {
        assert_eq!(
            FileReadTool::read_window_start_line(&json!({ "offset": 0 })).expect("offset"),
            1
        );
        assert_eq!(
            FileReadTool::read_window_start_line(&json!({ "offset": 42 })).expect("offset"),
            42
        );
        assert_eq!(
            FileReadTool::read_window_start_line(&json!({})).expect("default offset"),
            1
        );
    }

    #[test]
    fn read_tail_mode_rejects_offset() {
        let error = FileReadTool::read_tail_mode(&json!({
            "tail": true,
            "offset": 3
        }))
        .expect_err("tail and offset should not coexist");

        assert_eq!(error, "Do not provide offset when tail is true");
    }

    #[test]
    fn read_render_mode_defaults_to_auto_and_rejects_unknown_values() {
        assert_eq!(
            FileReadTool::read_render_mode(&json!({})).expect("default render"),
            ReadRenderMode::Auto
        );
        assert_eq!(
            FileReadTool::read_render_mode(&json!({ "render": "source" })).expect("source render"),
            ReadRenderMode::Source
        );
        assert!(FileReadTool::read_render_mode(&json!({ "render": "html" })).is_err());
        assert!(FileReadTool::read_render_mode(&json!({ "render": 1 })).is_err());
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn read_converts_rtf_to_a_markdown_representation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = br"{\rtf1\ansi Hello from the document}";
        fs::write(dir.path().join("notes.rtf"), source).expect("write RTF");

        let results = FileReadTool::new()
            .call_impl(
                &json!({ "file_path": "notes.rtf" }),
                &local_context(dir.path().to_path_buf()),
            )
            .await
            .expect("document read should succeed");

        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["representation"], "extracted_markdown");
        assert_eq!(data["source_format"], "rtf");
        assert_eq!(data["conversion_engine"], "anydoc");
        assert_eq!(data["source_size_bytes"], source.len());
        assert!(data["content"]
            .as_str()
            .is_some_and(|content| content.contains("Hello from the document")));
        assert!(result_for_assistant
            .as_deref()
            .is_some_and(|result| result.contains("from RTF to GitHub-Flavored Markdown")));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn document_conversion_failure_does_not_fallback_to_source_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("broken.pdf"), b"not a PDF").expect("write invalid PDF");
        let context = local_context(dir.path().to_path_buf());

        let error = FileReadTool::new()
            .call_impl(&json!({ "file_path": "broken.pdf" }), &context)
            .await
            .expect_err("invalid document must not be returned as source text");

        assert!(error.to_string().contains("Failed to convert document"));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn csv_auto_preserves_source_while_markdown_render_extracts_a_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("table.csv"),
            "name,value\nalpha,1\nbeta,2\n",
        )
        .expect("write CSV");
        let context = local_context(dir.path().to_path_buf());
        let tool = FileReadTool::new();

        let auto = tool
            .call_impl(&json!({ "file_path": "table.csv" }), &context)
            .await
            .expect("source read should succeed");
        let markdown = tool
            .call_impl(
                &json!({ "file_path": "table.csv", "render": "markdown" }),
                &context,
            )
            .await
            .expect("Markdown read should succeed");

        let ToolResult::Result {
            data: auto_data, ..
        } = &auto[0]
        else {
            panic!("expected source result");
        };
        let ToolResult::Result {
            data: markdown_data,
            ..
        } = &markdown[0]
        else {
            panic!("expected Markdown result");
        };
        assert!(auto_data.get("representation").is_none());
        assert!(auto_data["content"]
            .as_str()
            .is_some_and(|content| content.contains("name,value")));
        assert_eq!(markdown_data["representation"], "extracted_markdown");
        assert_eq!(markdown_data["source_format"], "csv");
        assert!(markdown_data["content"]
            .as_str()
            .is_some_and(|content| content.contains("| name | value |")));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn remote_document_uses_bounded_file_transfer_and_host_side_conversion() {
        let bounded_limit = Arc::new(AtomicUsize::new(0));
        let context = remote_context(
            br"{\rtf1\ansi Hello from remote RTF}".to_vec(),
            Arc::clone(&bounded_limit),
        );

        let results = FileReadTool::new()
            .call_impl(&json!({ "file_path": "notes.rtf" }), &context)
            .await
            .expect("remote document read should succeed");

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected result");
        };
        assert_eq!(
            bounded_limit.load(Ordering::Relaxed),
            MAX_DOCUMENT_INPUT_BYTES
        );
        assert_eq!(data["representation"], "extracted_markdown");
        assert!(data["content"]
            .as_str()
            .is_some_and(|content| content.contains("Hello from remote RTF")));
    }
}
