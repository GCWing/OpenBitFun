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
#[cfg(feature = "document-read")]
use tool_runtime::fs::document::{
    convert_document_pages_to_markdown, DocumentConversionError, MAX_DOCUMENT_INPUT_BYTES,
    MAX_DOCUMENT_MARKDOWN_BYTES, TEXT_CHUNK_CHARS,
};
use tool_runtime::fs::document::{
    is_supported_document_path, DocumentPageSelection, DocumentPagination, PdfTextCoverage,
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
// Coverage metadata remains complete; a tiny line window must not emit an unbounded gap list.
const MAX_PDF_OCR_PAGE_RANGES: usize = 32;
#[cfg(feature = "document-read")]
// anydoc is synchronous, so this bounds the caller's wait rather than terminating the parser.
// The worker retains the global conversion permit until it actually exits, keeping failures closed.
const DOCUMENT_CONVERSION_TIMEOUT: Duration = Duration::from_secs(30);

struct DocumentReadMetadata {
    source_format: &'static str,
    source_size_bytes: usize,
    pdf_coverage: Option<PdfTextCoverage>,
    pagination: DocumentPagination,
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

    fn read_page_selection(input: &Value) -> Result<Option<DocumentPageSelection>, String> {
        let Some(value) = input.get("pages") else {
            return Ok(None);
        };
        #[cfg(not(feature = "document-read"))]
        {
            let _ = value;
            Err("Document page selection is not available in this product build".to_string())
        }
        #[cfg(feature = "document-read")]
        {
            if Self::read_render_mode(input)? == ReadRenderMode::Source {
                return Err(
                    "pages selects extracted document units and cannot be used with render=source"
                        .to_string(),
                );
            }
            let value = value
                .as_str()
                .ok_or_else(|| "pages must be a string such as '1-3,7'".to_string())?;
            DocumentPageSelection::parse(value).map(Some)
        }
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
        pages: Option<DocumentPageSelection>,
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
                    "Document {} is larger than the {} MiB Read limit. Use a smaller document or a specialized extraction workflow; pages/offset/limit do not reduce source file transfer.",
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
            convert_document_pages_to_markdown(bytes, resolved_path.to_string(), pages),
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
                Self::document_conversion_error(logical_path, error)
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
                pdf_coverage: converted.pdf_coverage,
                pagination: converted.pagination,
            },
        ))
    }

    #[cfg(feature = "document-read")]
    fn document_conversion_error(
        logical_path: &str,
        error: DocumentConversionError,
    ) -> OpenBitFunError {
        let recovery = match error.code() {
            "encrypted" => " Use an unlocked copy of the document.",
            "unsupported" => " For a text file, use render=source; otherwise use a format-specific extraction tool.",
            "resourceLimit" => " For an extracted-output limit, request fewer pages; this does not bypass source-size or parser limits. Otherwise use a smaller document or specialized extraction workflow.",
            _ => "",
        };
        OpenBitFunError::tool(format!(
            "Failed to convert document {} to Markdown ({}): {}.{}",
            logical_path,
            error.code(),
            error,
            recovery
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
        let document_guidance = format!(
            r#"
Documents: Word, PowerPoint, Excel, OpenDocument, RTF, EPUB and PDF are extracted offline as Markdown. PDF page markers identify source pages; extraction status and missing-page warnings describe coverage. Use available text, and seek OCR or visual inspection only if missing pages matter to the task. Read itself does not perform OCR. Other embedded images/objects may be represented only by available text.
Use pages to select units after inspecting page_kind/page_count, especially when a large document is truncated. PDF units are original pages; PPTX slides and XLSX visible sheets follow source order. DOCX and other formats use {}-character text chunks, not printed pages. offset/limit/tail then address Markdown lines within that selection; keep the same pages when following next_offset. Extracted text is not exact source for Edit. Input limit: {} MiB; selected Markdown limit: {} MiB. Selection does not bypass source transfer limits; parsing may still process the full document.
"#,
            TEXT_CHUNK_CHARS,
            MAX_DOCUMENT_INPUT_BYTES / (1024 * 1024),
            MAX_DOCUMENT_MARKDOWN_BYTES / (1024 * 1024),
        );
        #[cfg(not(feature = "document-read"))]
        let document_guidance = "";

        Ok(format!(
            r#"Read a file from the active workspace, including a remote workspace. Use LS/Glob for directories and an image tool for images.
Returns numbered lines (line number, tab, text). Choose the window needed for the task; the default is up to {} lines. File content is capped at {} characters per line and {} characters per call. Follow next_offset for additional lines when useful. A truncated line needs another inspection method; rereading the same line window cannot recover its omitted characters. Use only complete source text for Edit.
{document_guidance}"#,
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
                    "description": "1-based line to start at (default 1; legacy 0 also means 1). For documents these are extracted Markdown lines."
                },
                "tail": {
                    "type": "boolean",
                    "description": "Read the last N lines of the file, where N is limit. Do not provide offset when tail is true."
                },
                "limit": {
                    "type": "number",
                    "description": "Positive integer number of lines to return. Choose a window that covers the relevant context."
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
                "description": "auto (default): extract known documents, preserve CSV source. source: read text without conversion. markdown: extract a document by content, including misnamed files, or convert CSV to a table."
            });
            schema["properties"]["pages"] = json!({
                "type": "string",
                "description": "Optional 1-based document units, e.g. '1-3,7', in source order. See returned page_kind and page_count. Omit for the full extraction. Requires document rendering; offset/limit/tail apply within the selected units."
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
            .and_then(|_| Self::read_page_selection(input))
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
        let pages = Self::read_page_selection(input).map_err(OpenBitFunError::tool)?;
        let start_line = Self::read_window_start_line(input).map_err(OpenBitFunError::tool)?;

        let limit = input
            .get("limit")
            .and_then(parse_u64_value)
            .unwrap_or(self.default_max_lines_to_read as u64) as usize;

        let resolved = context.resolve_tool_path(file_path)?;
        context.enforce_path_operation(ToolPathOperation::Read, &resolved)?;
        #[cfg(feature = "tools-miniapp")]
        if is_virtual_context_path(context, &resolved) {
            if pages.is_some() {
                return Err(OpenBitFunError::tool(
                    "pages cannot select a MiniApp text context; use offset/limit".to_string(),
                ));
            }
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
                    "content_truncated": read_file_result.content_truncated,
                    "truncated_lines": read_file_result.truncated_lines,
                    "next_offset": presentation.next_offset,
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
        if pages.is_some() && !reads_document_representation {
            return Err(OpenBitFunError::tool("pages requires a document. For a misnamed document or CSV use render=markdown; for ordinary text use offset/limit".to_string()));
        }
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
                    pages,
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
            "content_truncated": read_file_result.content_truncated,
            "truncated_lines": read_file_result.truncated_lines,
            "next_offset": presentation.next_offset
        });
        if let Some(metadata) = document_metadata {
            data["representation"] = json!("extracted_markdown");
            data["source_format"] = json!(metadata.source_format);
            data["source_size_bytes"] = json!(metadata.source_size_bytes);
            let pagination = metadata.pagination;
            data["page_kind"] = json!(pagination.page_kind);
            data["page_count"] = json!(pagination.page_count);
            data["selected_pages"] = json!(pagination.selected_pages);
            data["selected_page_count"] = json!(pagination.selected_page_count);
            data["next_page"] = json!(pagination.next_page);
            let warnings = if let Some(coverage) = metadata.pdf_coverage {
                data["conversion_engine"] = json!("pdf-inspector");
                data["extraction_status"] = json!(coverage.status());
                data["page_count"] = json!(coverage.page_count);
                data["extracted_pages"] = json!(coverage.extracted_pages);
                data["pages_needing_ocr"] = json!(coverage.pages_needing_ocr);
                let mut warnings = vec![
                    "Coverage describes native text extraction; images and diagrams may require visual inspection."
                        .to_string(),
                ];
                if !coverage.pages_needing_ocr.is_empty() {
                    warnings.push(format!(
                        "{} of {} PDF pages have reliable text in this selection. Pages {} need OCR or visual inspection; their contents are missing from this extraction. Use the available text, and inspect missing pages if the task requires them. Repeating Read will not perform OCR.",
                        coverage.extracted_pages.len(),
                        pagination.selected_page_count,
                        coverage.ocr_page_ranges(MAX_PDF_OCR_PAGE_RANGES),
                    ));
                }
                result_for_assistant = format!(
                    "PDF text extraction: {} for the selected pages ({} source pages total). Page markers refer to the PDF; offset/limit refer to Markdown lines.\n{}\n{}",
                    coverage.status(),
                    coverage.page_count,
                    warnings.join("\n"),
                    result_for_assistant,
                );
                warnings
            } else {
                data["conversion_engine"] = json!("anydoc");
                let warning =
                    "Embedded images and objects are represented by their available text.";
                let mut warnings = vec![warning.to_string()];
                if read_file_result.total_lines == 0 {
                    let warning = "No text was extracted. This does not mean the source document is empty; use a format-specific or visual inspection tool if its contents are needed.";
                    result_for_assistant = warning.to_string();
                    warnings.push(warning.to_string());
                }
                result_for_assistant = format!(
                    "Extracted {} as Markdown; offset/limit refer to Markdown lines. {}\n{}",
                    metadata.source_format.to_ascii_uppercase(),
                    warning,
                    result_for_assistant,
                );
                warnings
            };
            data["extraction_warnings"] = json!(warnings);
            let unit_hint = match pagination.page_kind {
                "pdf_page" => "original PDF pages",
                "slide" => "slides in presentation order",
                "sheet" => {
                    "visible sheets in workbook order; hidden sheets/rows/columns are not extracted"
                }
                _ => "text chunks, not printed pages",
            };
            let continuation = if let Some(next_offset) = presentation.next_offset {
                let same_selection = if input.get("pages").is_some() {
                    format!("keep pages=\"{}\"", pagination.selected_pages)
                } else {
                    "keep pages omitted".to_string()
                };
                format!("To continue this extraction, {same_selection} and use offset={next_offset}; or choose a narrower pages range starting at offset=1.")
            } else {
                "Choose another pages range if more context is needed.".to_string()
            };
            result_for_assistant = format!(
                "Document pages: kind={}, count={}, selected=\"{}\" ({unit_hint}). Selection metadata does not mean every selected unit is in this line window. {continuation}\n{result_for_assistant}",
                pagination.page_kind, pagination.page_count, pagination.selected_pages,
            );
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

    #[cfg(feature = "document-read")]
    const PDF_TEXT_PAGE: &str =
        "BT /F1 16 Tf 72 700 Td (First document paragraph.) Tj 0 -40 Td (Second document paragraph.) Tj ET";
    #[cfg(feature = "document-read")]
    const PDF_SCANNED_PAGE: &str = "q 468 0 0 648 72 72 cm /Im1 Do Q";

    /// Minimal PDFs with real text/image content streams and a valid cross-reference table.
    #[cfg(feature = "document-read")]
    fn pdf_document(pages: &[&str]) -> Vec<u8> {
        let page_refs = (0..pages.len())
            .map(|index| format!("{} 0 R", 5 + index * 2))
            .collect::<Vec<_>>()
            .join(" ");
        let mut objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            format!("<< /Type /Pages /Kids [{page_refs}] /Count {} >>", pages.len())
                .into_bytes(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream".to_vec(),
        ];
        for (index, content) in pages.iter().enumerate() {
            // Shared resources deliberately include an unused image on text pages.
            // Document-wide classification used to reject these short text PDFs.
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents {} 0 R >>",
                6 + index * 2,
            ).into_bytes());
            objects.push(
                format!(
                    "<< /Length {} >>\nstream\n{content}\nendstream",
                    content.len(),
                )
                .into_bytes(),
            );
        }
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            pdf.extend_from_slice(object);
            pdf.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1,
            )
            .as_bytes(),
        );
        pdf
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
        assert!(!properties.contains_key("pages"));
        assert!(FileReadTool::read_page_selection(&json!({"pages":"1"})).is_err());
        assert!(!properties["render"]["description"]
            .as_str()
            .expect("render description")
            .contains("Markdown"));
        assert!(!tool
            .description()
            .await
            .expect("description")
            .contains("Documents:"));
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
            .is_some_and(|result| result.contains("Extracted RTF as Markdown")));
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
        assert!(!error.to_string().contains("OCR workflow"));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn empty_extraction_is_not_reported_as_an_empty_source_document() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("empty.rtf"), br"{\rtf1\ansi}").expect("write RTF");
        let results = FileReadTool::new()
            .call_impl(
                &json!({ "file_path": "empty.rtf" }),
                &local_context(dir.path().to_path_buf()),
            )
            .await
            .expect("empty extraction should report its limits");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected extraction result");
        };
        assert_eq!(data["total_lines"], 0);
        assert_eq!(data["next_offset"], Value::Null);
        assert_eq!(data["content"], "");
        let message = result_for_assistant.as_deref().unwrap();
        assert!(message.contains("No text was extracted"));
        assert!(!message.contains("empty.rtf is empty"));
        assert!(data["extraction_warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .unwrap()
                .contains("source document is empty")));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn read_text_pdf_preserves_result_fields_and_markdown_paging() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = pdf_document(&[PDF_TEXT_PAGE]);
        fs::write(dir.path().join("document.pdf"), &source).expect("write PDF");
        let context = local_context(dir.path().to_path_buf());
        let tool = FileReadTool::new();
        // The legacy request shape without render continues to select document conversion.
        let full = tool
            .call_impl(&json!({ "file_path": "document.pdf" }), &context)
            .await
            .expect("text PDF read");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &full[0]
        else {
            panic!("expected PDF result");
        };
        assert_eq!(data["representation"], "extracted_markdown");
        assert_eq!(data["source_format"], "pdf");
        assert_eq!(data["conversion_engine"], "pdf-inspector");
        assert_eq!(data["source_size_bytes"], source.len());
        assert!(data["extraction_warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("native text extraction")));
        assert_eq!(data["extraction_status"], "complete");
        assert_eq!(data["page_count"], 1);
        assert_eq!(data["extracted_pages"], json!([1]));
        assert_eq!(data["pages_needing_ocr"], json!([]));
        let content = data["content"].as_str().expect("content");
        assert!(content.contains("First document paragraph."), "{content}");
        assert!(content.contains("Second document paragraph."), "{content}");
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("PDF text extraction: complete"));
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("images and diagrams may require visual inspection"));
        let total_lines = data["total_lines"].as_u64().expect("line count");
        assert!(total_lines > 1, "{content}");
        let expected_last_line = content.lines().last().expect("last line");

        for input in [
            json!({ "file_path": "document.pdf", "offset": total_lines, "limit": 1 }),
            json!({ "file_path": "document.pdf", "tail": true, "limit": 1 }),
        ] {
            let window = tool.call_impl(&input, &context).await.expect("PDF window");
            let ToolResult::Result { data, .. } = &window[0] else {
                panic!("expected PDF window");
            };
            assert_eq!(data["content"], expected_last_line);
            assert_eq!(data["offset"], total_lines);
            assert_eq!(data["total_lines"], total_lines);
            assert_eq!(data["lines_read"], 1);
            assert_eq!(data["representation"], "extracted_markdown");
            assert_eq!(data["next_offset"], Value::Null);
            assert_eq!(data["extracted_pages"], json!([1]));
        }
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn read_preserves_pdf_text_around_scanned_pages_and_reports_gaps_in_every_window() {
        let dir = tempfile::tempdir().expect("tempdir");
        let context = local_context(dir.path().to_path_buf());
        let tool = FileReadTool::new();
        fs::write(
            dir.path().join("document.bin"),
            pdf_document(&[PDF_TEXT_PAGE, PDF_SCANNED_PAGE, PDF_TEXT_PAGE]),
        )
        .expect("write mixed PDF");
        for input in [
            json!({ "file_path": "document.bin", "render": "markdown" }),
            json!({ "file_path": "document.bin", "render": "markdown", "limit": 1 }),
            json!({ "file_path": "document.bin", "render": "markdown", "tail": true, "limit": 2 }),
        ] {
            let results = tool
                .call_impl(&input, &context)
                .await
                .expect("readable pages should remain available");
            let ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } = &results[0]
            else {
                panic!("expected partial extraction");
            };
            assert_eq!(data["source_format"], "pdf");
            assert_eq!(data["extraction_status"], "partial");
            assert_eq!(data["page_count"], 3);
            assert_eq!(data["extracted_pages"], json!([1, 3]));
            assert_eq!(data["pages_needing_ocr"], json!([2]));
            let message = result_for_assistant.as_deref().expect("model response");
            assert!(
                message.contains("2 of 3 PDF pages have reliable text"),
                "{message}"
            );
            assert!(
                message.contains("Pages 2 need OCR or visual inspection"),
                "{message}"
            );
            if input.get("limit").is_none() {
                let content = data["content"].as_str().unwrap();
                assert_eq!(content.matches("First document paragraph.").count(), 2);
                assert!(content.contains("## PDF page 2"));
                assert!(content.contains("No reliable text extracted"));
                assert!(content.contains("## PDF page 3"));
            }
        }
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn scanned_pdf_returns_actionable_coverage_without_fabricating_text() {
        let context = remote_context(
            pdf_document(&[PDF_SCANNED_PAGE, PDF_SCANNED_PAGE]),
            Arc::new(AtomicUsize::new(0)),
        );
        let results = FileReadTool::new()
            .call_impl(&json!({ "file_path": "scanned.pdf" }), &context)
            .await
            .expect("scanned PDF should report its coverage");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected scan status");
        };
        assert_eq!(data["extraction_status"], "needs_ocr");
        assert_eq!(data["extracted_pages"], json!([]));
        assert_eq!(data["pages_needing_ocr"], json!([1, 2]));
        let message = result_for_assistant.as_deref().unwrap();
        assert!(message.contains("0 of 2 PDF pages have reliable text"));
        assert!(message.contains("Pages 1-2 need OCR or visual inspection"));
        assert!(message.contains("Repeating Read will not perform OCR"));
        assert!(!data["content"]
            .as_str()
            .unwrap()
            .contains("First document paragraph"));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn remote_pdf_keeps_available_text_and_coverage_without_shell() {
        let bounded_limit = Arc::new(AtomicUsize::new(0));
        let context = remote_context(
            pdf_document(&[PDF_TEXT_PAGE, PDF_SCANNED_PAGE]),
            Arc::clone(&bounded_limit),
        );
        let results = FileReadTool::new()
            .call_impl(&json!({ "file_path": "mixed.pdf" }), &context)
            .await
            .expect("remote readable pages should be available");

        assert_eq!(
            bounded_limit.load(Ordering::Relaxed),
            MAX_DOCUMENT_INPUT_BYTES
        );
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected partial remote result");
        };
        assert_eq!(data["extraction_status"], "partial");
        assert_eq!(data["extracted_pages"], json!([1]));
        assert_eq!(data["pages_needing_ocr"], json!([2]));
        assert!(data["content"]
            .as_str()
            .unwrap()
            .contains("First document paragraph."));
        let mut disconnected = context;
        disconnected.runtime_handles = ToolRuntimeHandles::default();
        let error = FileReadTool::new()
            .call_impl(&json!({ "file_path": "mixed.pdf" }), &disconnected)
            .await
            .expect_err("missing remote provider must not use local files");
        assert!(error.to_string().contains("unavailable"), "{error}");
    }

    #[tokio::test]
    async fn remote_read_distinguishes_line_clipping_from_next_window() {
        let context = remote_context(
            b"abcdefghij\nnext\n".to_vec(),
            Arc::new(AtomicUsize::new(0)),
        );
        let tool = FileReadTool::with_config(2000, 4, 100);
        let first = tool
            .call_impl(&json!({"file_path": "long.txt", "limit": 1}), &context)
            .await
            .unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &first[0]
        else {
            panic!("expected source result");
        };
        assert_eq!(data["next_offset"], 2);
        assert_eq!(data["truncated_lines"], json!([1]));
        assert_eq!(data["content_truncated"], true);
        assert!(!data["hit_total_char_limit"].as_bool().unwrap());
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("cannot restore"));
        let next = tool
            .call_impl(
                &json!({"file_path": "long.txt", "offset": data["next_offset"]}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &next[0] else {
            panic!("expected next window");
        };
        assert_eq!(data["content"], "     2\tnext");
        assert_eq!(data["truncated_lines"], json!([]));
        assert_eq!(data["next_offset"], Value::Null);
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

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn pdf_page_selection_preserves_source_numbers_and_scopes_ocr_for_local_and_remote() {
        let dir = tempfile::tempdir().unwrap();
        let source = pdf_document(&[PDF_TEXT_PAGE, PDF_SCANNED_PAGE, PDF_TEXT_PAGE]);
        fs::write(dir.path().join("document.pdf"), &source).unwrap();
        let bounded_limit = Arc::new(AtomicUsize::new(0));
        let contexts = [
            local_context(dir.path().to_path_buf()),
            remote_context(source, Arc::clone(&bounded_limit)),
        ];
        let tool = FileReadTool::new();
        for context in contexts {
            for (pages, status, extracted, missing) in [
                ("3,1", "complete", json!([1, 3]), json!([])),
                ("2", "needs_ocr", json!([]), json!([2])),
                ("3", "complete", json!([3]), json!([])),
            ] {
                let results = tool
                    .call_impl(
                        &json!({"file_path":"document.pdf", "pages":pages}),
                        &context,
                    )
                    .await
                    .unwrap();
                let ToolResult::Result {
                    data,
                    result_for_assistant,
                    ..
                } = &results[0]
                else {
                    panic!("result");
                };
                assert_eq!(data["page_kind"], "pdf_page");
                assert_eq!(data["page_count"], 3);
                assert_eq!(data["extraction_status"], status);
                assert_eq!(data["extracted_pages"], extracted);
                assert_eq!(data["pages_needing_ocr"], missing);
                assert!(result_for_assistant
                    .as_deref()
                    .unwrap()
                    .contains("for the selected pages"));
                if pages == "3" {
                    let content = data["content"].as_str().unwrap();
                    assert!(content.contains("## PDF page 3"));
                    assert!(!content.contains("## PDF page 1"));
                    assert_eq!(data["selected_pages"], "3");
                    assert_eq!(data["selected_page_count"], 1);
                }
            }
            let error = tool
                .call_impl(&json!({"file_path":"document.pdf", "pages":"4"}), &context)
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("has 3 selectable pages"),
                "{error}"
            );
        }
        assert_eq!(
            bounded_limit.load(Ordering::Relaxed),
            MAX_DOCUMENT_INPUT_BYTES
        );
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn document_chunk_windows_continue_with_the_same_selection_and_recover_long_lines() {
        let source = format!("{{\\rtf1\\ansi {}Final paragraph}}", "x".repeat(4000)).into_bytes();
        let context = remote_context(source, Arc::new(AtomicUsize::new(0)));
        let tool = FileReadTool::new();
        let initial = tool
            .call_impl(&json!({"file_path":"report.rtf"}), &context)
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &initial[0] else {
            panic!("result");
        };
        assert_eq!(data["page_kind"], "text_chunk");
        assert_eq!(data["page_count"], 3);
        assert!(!data["truncated_lines"].as_array().unwrap().is_empty());
        let selected = tool
            .call_impl(
                &json!({"file_path":"report.rtf", "pages":"3", "limit":2}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &selected[0]
        else {
            panic!("result");
        };
        assert_eq!(data["next_offset"], 3);
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("keep pages=\"3\""));
        let continued = tool
            .call_impl(
                &json!({"file_path":"report.rtf", "pages":"3", "offset":data["next_offset"]}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &continued[0] else {
            panic!("result");
        };
        assert!(data["content"]
            .as_str()
            .unwrap()
            .contains("Final paragraph"));
        assert_eq!(data["truncated_lines"], json!([]));
        let tail = tool
            .call_impl(
                &json!({"file_path":"report.rtf", "pages":"3", "tail":true, "limit":2}),
                &context,
            )
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &tail[0] else {
            panic!("result");
        };
        assert!(data["content"]
            .as_str()
            .unwrap()
            .contains("Final paragraph"));
    }

    #[cfg(feature = "document-read")]
    #[tokio::test]
    async fn page_arguments_fail_explicitly_instead_of_falling_back_to_text() {
        let context = remote_context(b"plain text".to_vec(), Arc::new(AtomicUsize::new(0)));
        let tool = FileReadTool::new();
        for input in [
            json!({"file_path":"report.pdf", "pages":3}),
            json!({"file_path":"report.pdf", "pages":"0"}),
            json!({"file_path":"report.pdf", "pages":"3-1"}),
            json!({"file_path":"report.pdf", "pages":"1", "render":"source"}),
            json!({"file_path":"plain.txt", "pages":"1"}),
        ] {
            let error = tool.call_impl(&input, &context).await.unwrap_err();
            assert!(error.to_string().contains("pages"), "{error}");
        }
        assert_eq!(tool.input_schema()["properties"]["pages"]["type"], "string");
    }
}
