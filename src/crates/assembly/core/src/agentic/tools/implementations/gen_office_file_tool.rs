//! GenOfficeFile: incremental Word, Excel, and PowerPoint generation.
//!
//! The document model and package writers live in
//! `openbitfun-office-documents`; this tool resolves paths, loads referenced
//! images, and moves bytes through the session's workspace file system so it
//! works the same for local and remote workspaces.
//! GenOffice reference attribution and licenses are kept beside the engine
//! in `src/crates/execution/office-documents/README.md`.

use crate::agentic::tools::file_permissions::file_permission_intents;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::ToolPathOperation;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_office_documents::{
    collect_image_sources, guide, Detail, ImageSources, OfficeDocument, OfficeError, OfficeFormat,
    OpenOptions, ReadRequest,
};
use serde_json::{json, Value};

const TOOL_NAME: &str = "GenOfficeFile";
const MAX_DOCUMENT_BYTES: usize = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Create,
    Edit,
    Read,
    Guide,
}

impl Action {
    fn parse(input: &Value) -> Result<Self, String> {
        match input.get("action").and_then(Value::as_str) {
            Some("create") => Ok(Self::Create),
            Some("edit") => Ok(Self::Edit),
            Some("read") => Ok(Self::Read),
            Some("guide") => Ok(Self::Guide),
            Some(other) => Err(format!(
                "unknown action `{other}`; use create, edit, read, or guide"
            )),
            None => Err("`action` is required: create, edit, read, or guide".to_string()),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Edit => "edit",
            Self::Read => "read",
            Self::Guide => "guide",
        }
    }

    const fn writes(self) -> bool {
        matches!(self, Self::Create | Self::Edit)
    }
}

pub struct GenOfficeFileTool;

impl Default for GenOfficeFileTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GenOfficeFileTool {
    pub fn new() -> Self {
        Self
    }

    fn file_path(input: &Value) -> Option<&str> {
        input
            .get("file_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
    }

    fn operations(input: &Value) -> Result<Vec<Value>, String> {
        match input.get("operations") {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => {
                if let Some(index) = items.iter().position(|item| !item.is_object()) {
                    return Err(format!(
                        "operations[{index}] must be an object with an `op` field"
                    ));
                }
                Ok(items.clone())
            }
            Some(_) => Err("`operations` must be an array of operation objects".to_string()),
        }
    }

    fn format_for(input: &Value, action: Action) -> Result<OfficeFormat, String> {
        if action == Action::Guide {
            if let Some(name) = input.get("format").and_then(Value::as_str) {
                return OfficeFormat::from_name(name)
                    .ok_or_else(|| format!("unknown format `{name}`; use docx, xlsx, or pptx"));
            }
        }
        let path = Self::file_path(input).ok_or_else(|| match action {
            Action::Guide => "guide needs `format` (docx, xlsx, pptx) or a `file_path`".to_string(),
            _ => "`file_path` is required".to_string(),
        })?;
        OfficeFormat::from_path(path)
            .ok_or_else(|| format!("`{path}` must end in .docx, .xlsx, or .pptx"))
    }

    /// Checks everything that does not need the file system.
    fn check_input(input: &Value) -> Result<(Action, OfficeFormat), String> {
        let action = Action::parse(input)?;
        let format = Self::format_for(input, action)?;
        let operations = Self::operations(input)?;
        if action == Action::Edit && operations.is_empty() {
            return Err("edit needs a non-empty `operations` array".to_string());
        }
        if !action.writes() && !operations.is_empty() {
            return Err(format!(
                "`operations` is only used by create and edit, not {}",
                action.as_str()
            ));
        }
        if input
            .get("settings")
            .is_some_and(|settings| !settings.is_null())
            && action != Action::Create
        {
            return Err("`settings` is only used by create; change settings later with operations such as set_page_setup, set_styles, or set_theme".to_string());
        }
        if let Some(detail) = input.get("detail").and_then(Value::as_str) {
            if !matches!(detail, "outline" | "full") {
                return Err("`detail` must be outline or full".to_string());
            }
        }
        if (input.get("sheet").is_some() || input.get("range").is_some())
            && format != OfficeFormat::Xlsx
        {
            return Err("`sheet` and `range` only apply to .xlsx files".to_string());
        }
        Ok((action, format))
    }

    fn read_request(input: &Value) -> ReadRequest {
        ReadRequest {
            offset: input
                .get("offset")
                .and_then(Value::as_u64)
                .map(|value| value as usize),
            limit: input
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize),
            detail: match input.get("detail").and_then(Value::as_str) {
                Some("full") => Detail::Full,
                _ => Detail::Outline,
            },
            sheet: input
                .get("sheet")
                .and_then(Value::as_str)
                .map(str::to_string),
            range: input
                .get("range")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }

    fn office_error(error: OfficeError) -> OpenBitFunError {
        OpenBitFunError::tool(format!(
            "{error}. Fix the reported problem and resend the whole batch; nothing was written. Use action=guide for the field reference."
        ))
    }

    /// Loads image files referenced by the operations through the workspace
    /// file system, keyed by the exact source string the operations use.
    async fn load_images(
        context: &ToolUseContext,
        operations: &[Value],
    ) -> OpenBitFunResult<ImageSources> {
        let mut images = ImageSources::new();
        for source in collect_image_sources(operations) {
            let lower = source.to_ascii_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") {
                return Err(OpenBitFunError::tool(format!(
                    "image `{source}` is a web URL; download it to a local file first (for example with ExecCommand) and pass the absolute file path"
                )));
            }
            let resolved = context.resolve_tool_path(&source)?;
            context.enforce_path_operation(ToolPathOperation::Read, &resolved)?;
            let bytes = context
                .file_system_for_path(&resolved)?
                .read_file_bounded(&resolved.resolved_path, MAX_IMAGE_BYTES)
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(format!(
                        "cannot read image {}: {error:#}",
                        resolved.logical_path
                    ))
                })?
                .ok_or_else(|| {
                    OpenBitFunError::tool(format!(
                        "image {} is larger than {} MB",
                        resolved.logical_path,
                        MAX_IMAGE_BYTES / 1024 / 1024
                    ))
                })?;
            images.insert(source, bytes);
        }
        Ok(images)
    }

    fn now() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    fn parent_directory(path: &str, remote: bool) -> Option<String> {
        if remote {
            return path
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .filter(|parent| !parent.is_empty());
        }
        std::path::Path::new(path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .filter(|parent| !parent.is_empty())
    }

    fn summary_text(
        action: Action,
        path: &str,
        document: &OfficeDocument,
        changes: &[String],
        warnings: &[String],
    ) -> String {
        let format = document.format();
        let counts = document.summary();
        let count = match format {
            OfficeFormat::Docx => format!("{} block(s)", counts["blocks"]),
            OfficeFormat::Xlsx => format!("{} sheet(s)", counts["sheets"]),
            OfficeFormat::Pptx => format!("{} slide(s)", counts["slides"]),
        };
        let verb = if action == Action::Create {
            "Created"
        } else {
            "Updated"
        };
        let mut text = format!(
            "{verb} {path} ({}, {count}, revision {}).",
            format.as_str(),
            document.revision()
        );
        if !changes.is_empty() {
            text.push_str("\nChanges:");
            for change in changes.iter().take(30) {
                text.push_str("\n- ");
                text.push_str(change);
            }
        }
        if !warnings.is_empty() {
            text.push_str("\nWarnings (fix them with a follow-up edit when they matter):");
            for warning in warnings {
                text.push_str("\n- ");
                text.push_str(warning);
            }
        }
        text
    }

    fn description_text() -> String {
        r#"Create and incrementally edit real Office files: Word (.docx), Excel (.xlsx), and PowerPoint (.pptx). The format comes from the file extension. Use this instead of writing scripts when the user wants an Office document, report, spreadsheet, workbook, slide deck, or presentation.

Build large documents over several calls instead of one: create the file with a first batch, then append or change content with `edit` (one section, a few slides, or a chunk of rows per call). Every call applies a batch of `operations` atomically (all or nothing) and rewrites the file. The editable source travels inside the file, so later calls can keep editing it.

Actions:
- `create`: new file at `file_path` (absolute). Optional `settings` (document-level defaults) and `operations`. Refuses to replace an existing file unless `overwrite: true`.
- `edit`: apply `operations` to a file this tool created.
- `read`: page through the structure with `offset`/`limit`; `detail: "full"` returns the stored model of each unit (with indexes and embedded image `asset` names) for precise edits. For .xlsx, pass `sheet` to page rows or `range` (A1:D20) to read cells.
- `guide`: the complete field and operation reference for `format` (docx | xlsx | pptx). Call it before the first create or edit of a format in a session.

Operations by format (each is `{"op": "...", ...}`):
- docx — blocks are 0-based: `insert_blocks` {index?, blocks | markdown}, `replace_blocks` {index, count?, blocks | markdown}, `delete_blocks` {index, count?}, `move_blocks` {index, count?, to}, `replace_text`, `set_page_setup`, `set_styles`, `set_header_footer` ({PAGE}/{NUMPAGES} fields), `set_properties`. Block types: heading, paragraph, list, table, image, code, quote, page_break, horizontal_rule, toc. Markdown (headings, lists, tables, code, quotes, links, images, [TOC]) is the fastest way to add content.
- xlsx — sheets by name: `add_sheet`, `delete_sheet`, `rename_sheet`, `move_sheet`, `set_cells` {sheet, start, rows}, `append_rows` {sheet, rows}, `insert_rows`/`delete_rows`/`insert_columns`/`delete_columns` (references shift), `clear_range`, `format_range` {range, style}, `set_column_widths`, `set_row_heights`, `merge_cells`, `unmerge_cells`, `freeze_panes`, `set_autofilter`, `set_sheet`, `set_properties`. Cell values: numbers, booleans, text, "=FORMULA", or {value, type: date|text|number, style}.
- pptx — slides are 0-based on a 1280×720 px canvas (16:9) with absolutely positioned elements (text, shape, image, table): `insert_slides` {index?, slides}, `replace_slide`, `update_slide` {index, update_elements/remove_elements/append_elements, background, notes}, `delete_slides`, `move_slides`, `duplicate_slide`, `set_theme`, `set_properties`. After each batch the touched slides are audited for text overflow and off-canvas elements.

Images (docx image blocks, pptx image elements, Markdown images) take an absolute local path or a data URL (PNG, JPEG, GIF, BMP). Download web images first.

Files this tool did not create cannot be edited; read them with the Read tool and create a new file. If another program changed a generated file, edit refuses unless `discard_external_changes: true` (which rebuilds from the last GenOfficeFile state and drops the outside changes)."#
            .to_string()
    }
}

#[async_trait]
impl Tool for GenOfficeFileTool {
    fn name(&self) -> &str {
        TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(Self::description_text())
    }

    fn short_description(&self) -> String {
        "Create and incrementally edit Word, Excel, and PowerPoint files.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "edit", "read", "guide"],
                    "description": "create a new file, edit a generated file, read its structure page by page, or get the field reference for a format."
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute path of the .docx, .xlsx, or .pptx file. Required except for guide with `format`."
                },
                "format": {
                    "type": "string",
                    "enum": ["docx", "xlsx", "pptx"],
                    "description": "guide only: which format's reference to return."
                },
                "operations": {
                    "type": "array",
                    "description": "create/edit: ordered batch of operations, applied atomically. Each item is an object with `op` plus that operation's fields (see action=guide).",
                    "items": {
                        "type": "object",
                        "properties": { "op": { "type": "string" } },
                        "required": ["op"],
                        "additionalProperties": true
                    }
                },
                "settings": {
                    "type": "object",
                    "description": "create only: document-level defaults. docx: page, styles, header, footer, properties. pptx: slide_size (\"16:9\" | \"4:3\"), theme {font, east_asia_font, text_color}, properties. xlsx: properties.",
                    "additionalProperties": true
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "create only: replace an existing file at file_path."
                },
                "discard_external_changes": {
                    "type": "boolean",
                    "description": "edit/read: proceed even though another program changed the file; edits rebuild from the last GenOfficeFile state."
                },
                "offset": { "type": "integer", "minimum": 0, "description": "read: first unit (block, slide, sheet, or row) to return." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "read: number of units to return." },
                "detail": { "type": "string", "enum": ["outline", "full"], "description": "read: outline (default) or the full stored model of each unit." },
                "sheet": { "type": "string", "description": "read, xlsx: sheet whose rows to return." },
                "range": { "type": "string", "description": "read, xlsx: A1 range of `sheet` to return, such as A1:F40." }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string" },
                "format": { "type": "string" },
                "file_path": { "type": "string" },
                "revision": { "type": "integer" },
                "bytes": { "type": "integer" },
                "counts": { "type": "object" },
                "changes": { "type": "array", "items": { "type": "string" } },
                "warnings": { "type": "array", "items": { "type": "string" } },
                "view": { "type": "object" },
                "guide": { "type": "string" }
            },
            "required": ["action", "format"],
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|input| Action::parse(input).ok())
            .is_some_and(|action| !action.writes())
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let action = Action::parse(input).map_err(OpenBitFunError::validation)?;
        let Some(file_path) = Self::file_path(input) else {
            return Ok(Vec::new());
        };
        if action == Action::Guide {
            return Ok(Vec::new());
        }
        if !action.writes() {
            return file_permission_intents("read", [file_path], context);
        }
        let mut intents = file_permission_intents("edit", [file_path], context)?;
        let operations = Self::operations(input).unwrap_or_default();
        let images: Vec<String> = collect_image_sources(&operations)
            .into_iter()
            .filter(|source| {
                let lower = source.to_ascii_lowercase();
                !lower.starts_with("http://") && !lower.starts_with("https://")
            })
            .collect();
        if !images.is_empty() {
            intents.extend(file_permission_intents(
                "read",
                images.iter().map(String::as_str),
                context,
            )?);
        }
        Ok(intents)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let reject = |message: String| ValidationResult {
            result: false,
            message: Some(message),
            error_code: Some(400),
            meta: None,
        };
        let (action, _) = match Self::check_input(input) {
            Ok(parsed) => parsed,
            Err(message) => return reject(message),
        };
        if !action.writes() {
            return ValidationResult::default();
        }
        let Some(file_path) = Self::file_path(input) else {
            return reject("`file_path` is required".to_string());
        };
        if let Some(rejection) = crate::agentic::execution::edit_constraint_guard::check_write(
            context, TOOL_NAME, "write", file_path, false,
        )
        .await
        {
            return rejection;
        }
        if let Some(context) = context {
            let resolved = match context.resolve_tool_path(file_path) {
                Ok(resolved) => resolved,
                Err(error) => return reject(error.to_string()),
            };
            if let Err(error) = context.enforce_path_operation(ToolPathOperation::Write, &resolved)
            {
                return reject(error.to_string());
            }
        }
        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let action = Action::parse(input).map(Action::as_str).unwrap_or("use");
        let operations = Self::operations(input).map(|ops| ops.len()).unwrap_or(0);
        match (Self::file_path(input), operations) {
            (Some(path), 0) => format!("GenOfficeFile {action} {path}"),
            (Some(path), count) => format!("GenOfficeFile {action} {path} ({count} operation(s))"),
            (None, _) => format!(
                "GenOfficeFile {action} {}",
                input.get("format").and_then(Value::as_str).unwrap_or("")
            ),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        let action = output.get("action").and_then(Value::as_str).unwrap_or("");
        let path = output
            .get("file_path")
            .and_then(Value::as_str)
            .unwrap_or("");
        match action {
            "create" => format!("Created {path}"),
            "edit" => format!("Updated {path}"),
            "read" => format!("Read {path}"),
            _ => "Returned the GenOfficeFile guide".to_string(),
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let (action, format) = Self::check_input(input).map_err(OpenBitFunError::tool)?;
        if action == Action::Guide {
            let text = guide(format);
            return Ok(vec![ToolResult::ok(
                json!({ "action": "guide", "format": format.as_str(), "guide": text }),
                Some(text.to_string()),
            )]);
        }

        let file_path = Self::file_path(input)
            .ok_or_else(|| OpenBitFunError::tool("`file_path` is required".to_string()))?;
        let resolved = context.resolve_tool_path(file_path)?;
        let operation = if action.writes() {
            ToolPathOperation::Write
        } else {
            ToolPathOperation::Read
        };
        context.enforce_path_operation(operation, &resolved)?;
        let fs = context.file_system_for_path(&resolved)?;
        let exists = fs.exists(&resolved.resolved_path).await.map_err(|error| {
            OpenBitFunError::tool(format!("cannot check {}: {error:#}", resolved.logical_path))
        })?;
        let open_options = OpenOptions {
            discard_external_changes: input
                .get("discard_external_changes")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };

        let existing = if action == Action::Create {
            if exists
                && !input
                    .get("overwrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                return Err(OpenBitFunError::tool(format!(
                    "{} already exists. Use action=edit to change a file this tool created, pick another path, or pass overwrite=true to replace it.",
                    resolved.logical_path
                )));
            }
            None
        } else {
            if !exists {
                return Err(OpenBitFunError::tool(format!(
                    "{} does not exist; use action=create first",
                    resolved.logical_path
                )));
            }
            let bytes = fs
                .read_file_bounded(&resolved.resolved_path, MAX_DOCUMENT_BYTES)
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(format!(
                        "cannot read {}: {error:#}",
                        resolved.logical_path
                    ))
                })?
                .ok_or_else(|| {
                    OpenBitFunError::tool(format!("{} is too large to edit", resolved.logical_path))
                })?;
            Some(OfficeDocument::open(&bytes, &open_options).map_err(Self::office_error)?)
        };

        if action == Action::Read {
            let document = existing.expect("read opens the existing document");
            let mut view = document
                .read(&Self::read_request(input))
                .map_err(Self::office_error)?;
            if document.format() == OfficeFormat::Pptx
                && input.get("offset").and_then(Value::as_u64).unwrap_or(0) == 0
            {
                let findings = document.audit();
                if !findings.is_empty() {
                    view["audit"] = json!(findings);
                }
            }
            let text = serde_json::to_string_pretty(&view).unwrap_or_default();
            return Ok(vec![ToolResult::ok(
                json!({
                    "action": "read",
                    "format": format.as_str(),
                    "file_path": resolved.logical_path,
                    "view": view,
                }),
                Some(text),
            )]);
        }

        let mut document = match existing {
            Some(document) => document,
            None => {
                OfficeDocument::new(format, input.get("settings")).map_err(Self::office_error)?
            }
        };
        if document.format() != format {
            return Err(OpenBitFunError::tool(format!(
                "{} holds a {} document; keep its original extension",
                resolved.logical_path,
                document.format().as_str()
            )));
        }
        let operations = Self::operations(input).map_err(OpenBitFunError::tool)?;
        let images = Self::load_images(context, &operations).await?;
        let report = document
            .apply(&operations, &images)
            .map_err(Self::office_error)?;
        document.touch(&Self::now());
        let bytes = document.to_bytes().map_err(Self::office_error)?;

        context
            .record_light_checkpoint(
                TOOL_NAME,
                &resolved.logical_path,
                vec![resolved.logical_path.clone()],
            )
            .await?;
        if !exists {
            if let Some(parent) = Self::parent_directory(
                &resolved.resolved_path,
                resolved.uses_remote_workspace_backend(),
            ) {
                // Providers without directory creation still create parents on write.
                let _ = fs.create_dir_all(&parent).await;
            }
        }
        fs.write_file(&resolved.resolved_path, &bytes)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!("cannot write {}: {error:#}", resolved.logical_path))
            })?;
        crate::agentic::execution::edit_constraint_guard::record_mutation_applied(
            context,
            TOOL_NAME,
            "write",
            &resolved.logical_path,
        )
        .await;
        if !exists {
            crate::agentic::execution::edit_constraint_guard::remember_agent_created_file(
                context,
                &resolved.logical_path,
            )
            .await;
        }

        let text = Self::summary_text(
            action,
            &resolved.logical_path,
            &document,
            &report.changes,
            &report.warnings,
        );
        Ok(vec![ToolResult::ok(
            json!({
                "action": action.as_str(),
                "format": format.as_str(),
                "file_path": resolved.logical_path,
                "revision": document.revision(),
                "bytes": bytes.len(),
                "counts": document.summary(),
                "changes": report.changes,
                "warnings": report.warnings,
            }),
            Some(text),
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::GenOfficeFileTool;
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use async_trait::async_trait;
    use openbitfun_runtime_ports::{
        ToolRuntimeHandles, WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        WorkspaceFileSystem, WorkspaceServices, WorkspaceShell,
    };
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    /// Workspace file system backed by a map, standing in for a local or SSH provider.
    #[derive(Default)]
    struct MemoryFs {
        files: Mutex<HashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl WorkspaceFileSystem for MemoryFs {
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no such file: {path}"))
        }

        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            Ok(String::from_utf8(self.read_file(path).await?)?)
        }

        async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), contents.to_vec());
            Ok(())
        }

        async fn exists(&self, path: &str) -> anyhow::Result<bool> {
            Ok(self.files.lock().unwrap().contains_key(path))
        }

        async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
            self.exists(path).await
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(Vec::new())
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
            panic!("GenOfficeFile must not run shell commands")
        }
    }

    fn context(fs: Arc<MemoryFs>, remote: bool) -> ToolUseContext {
        let root = "/remote/workspace";
        let workspace = if remote {
            let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
                root,
                Some("office-test-ssh"),
                Some("office-test-host"),
            )
            .expect("remote identity");
            WorkspaceBinding::new_remote(
                None,
                PathBuf::from(root),
                "office-test-ssh".to_string(),
                "office-test-host".to_string(),
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
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: ToolRuntimeHandles::new(
                Some(WorkspaceServices {
                    fs,
                    shell: Arc::new(UnusedShell),
                }),
                None,
            ),
        }
    }

    fn data(results: Vec<ToolResult>) -> Value {
        match results.into_iter().next().expect("one result") {
            ToolResult::Result { data, .. } => data,
            other => panic!("unexpected result {other:?}"),
        }
    }

    fn png() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&64u32.to_be_bytes());
        bytes.extend_from_slice(&48u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn builds_a_deck_over_several_calls_through_the_workspace_file_system() {
        for remote in [false, true] {
            let fs = Arc::new(MemoryFs::default());
            fs.files
                .lock()
                .unwrap()
                .insert("/remote/workspace/assets/logo.png".to_string(), png());
            let context = context(fs.clone(), remote);
            let tool = GenOfficeFileTool::new();
            let path = "/remote/workspace/out/deck.pptx";

            let created = data(
                tool.call_impl(
                    &json!({"action": "create", "file_path": path, "operations": [
                        {"op": "insert_slides", "slides": [{"title": "Cover", "elements": [
                            {"type": "text", "x": 80, "y": 80, "w": 800, "h": 80, "text": "Hello", "size_pt": 36},
                            {"type": "image", "src": "/remote/workspace/assets/logo.png", "x": 900, "y": 80, "w": 128, "h": 96}
                        ]}]}
                    ]}),
                    &context,
                )
                .await
                .expect("create"),
            );
            assert_eq!(created["counts"]["slides"], json!(1));
            assert!(fs.files.lock().unwrap().contains_key(path));

            let duplicate = tool
                .call_impl(&json!({"action": "create", "file_path": path}), &context)
                .await
                .unwrap_err();
            assert!(duplicate.to_string().contains("already exists"));

            // The image file is gone; the embedded picture must still carry over.
            fs.files
                .lock()
                .unwrap()
                .remove("/remote/workspace/assets/logo.png");
            let edited = data(
                tool.call_impl(
                    &json!({"action": "edit", "file_path": path, "operations": [
                        {"op": "insert_slides", "slides": [{"title": "Agenda", "elements": [
                            {"type": "text", "x": 80, "y": 80, "w": 800, "h": 300, "paragraphs": ["One", "Two"]}
                        ]}]}
                    ]}),
                    &context,
                )
                .await
                .expect("edit"),
            );
            assert_eq!(edited["revision"], json!(2));

            let read = data(
                tool.call_impl(
                    &json!({"action": "read", "file_path": path, "offset": 1, "limit": 1}),
                    &context,
                )
                .await
                .expect("read"),
            );
            assert_eq!(read["view"]["total_slides"], json!(2));
            assert_eq!(read["view"]["slides"][0]["label"], json!("Agenda"));

            let failed = tool
                .call_impl(
                    &json!({"action": "edit", "file_path": path, "operations": [{"op": "delete_slides", "index": 7}]}),
                    &context,
                )
                .await
                .unwrap_err();
            assert!(failed.to_string().contains("delete_slides"), "{failed}");
        }
    }

    #[test]
    fn input_checks_catch_misuse_before_any_io() {
        assert!(GenOfficeFileTool::check_input(
            &json!({"action": "create", "file_path": "/a/b.docx"})
        )
        .is_ok());
        assert!(
            GenOfficeFileTool::check_input(&json!({"action": "guide", "format": "pptx"})).is_ok()
        );
        let cases = [
            json!({"action": "create", "file_path": "/a/b.doc"}),
            json!({"action": "edit", "file_path": "/a/b.docx"}),
            json!({"action": "edit", "file_path": "/a/b.docx", "operations": [{"op": "insert_blocks"}], "settings": {}}),
            json!({"action": "read", "file_path": "/a/b.docx", "sheet": "S"}),
            json!({"action": "read", "file_path": "/a/b.docx", "operations": [{"op": "x"}]}),
            json!({"action": "write", "file_path": "/a/b.docx"}),
            json!({"action": "guide"}),
        ];
        for case in cases {
            assert!(GenOfficeFileTool::check_input(&case).is_err(), "{case}");
        }
    }

    #[test]
    fn remote_parent_directories_use_posix_paths() {
        assert_eq!(
            GenOfficeFileTool::parent_directory("/home/u/docs/a.pptx", true).as_deref(),
            Some("/home/u/docs")
        );
        assert_eq!(GenOfficeFileTool::parent_directory("a.pptx", true), None);
    }
}
