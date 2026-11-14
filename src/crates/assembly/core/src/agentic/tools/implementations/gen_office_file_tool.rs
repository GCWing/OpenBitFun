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
    collect_image_sources, guide, operation_recovery_hint, operation_schema, settings_schema,
    validate_font_input, validate_operation_headers, Detail, ImageSources, OfficeDocument,
    OfficeError, OfficeErrorKind, OfficeFormat, OpenOptions, ReadRequest,
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
        validate_operation_headers(format, &operations).map_err(Self::office_error_message)?;
        if let Some(settings) = input.get("settings") {
            validate_font_input(settings, "settings").map_err(Self::office_error_message)?;
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

    fn office_error_message(error: OfficeError) -> String {
        match error.operation.as_deref() {
            Some(op) => format!(
                "{error}. Nothing was written: the entire batch was rolled back (operation numbers are 0-based). {} Correct the input before retrying; use a smaller batch if indexes are uncertain.",
                operation_recovery_hint(op)
            ),
            None => match error.kind {
                // The file has no GenOfficeFile source model, so no GenOfficeFile
                // action can open it; pointing at guide or retrying cannot help.
                OfficeErrorKind::NotGenerated => format!(
                    "{error}. The file was not changed. Do not retry GenOfficeFile on this file (discard_external_changes does not apply): use the Read tool to read or analyze it, and only use action=create with a new path if the user wants a new Office file."
                ),
                OfficeErrorKind::ExternallyModified => {
                    format!("{error}. The file was not changed.")
                }
                _ => format!("{error}. The file was not changed. Use action=guide for the format's contract."),
            },
        }
    }

    fn office_error(error: OfficeError) -> OpenBitFunError {
        OpenBitFunError::tool(Self::office_error_message(error))
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
        text.push_str("\nGeneration complete. Font names were written as supplied; fonts were not embedded or verified in the target viewer. Use read to verify changed content and references. Visual rendering is optional and was not performed; do not probe/install/repair an Office package or build a renderer to complete this tool workflow.");
        if format == OfficeFormat::Pptx {
            text.push_str(" Layout warnings are geometric/text-size estimates.");
        }
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
        r#"Create and incrementally edit Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) files directly, without scripts or an installed Office application. The extension selects the format.

Scope: use this tool only when the user wants an Office file produced or changed. It is not a document reader: read and edit open only files this tool generated earlier, because they carry its embedded editable model. To read, summarize, or analyze any other Office file (user attachments, uploads, files from Office or other programs), use the Read tool, which extracts all of these formats; do not call GenOfficeFile first to check.

Workflow: call guide once for the format, create a first batch, then edit in small sections/slides/row chunks. Send text as ordinary Unicode strings; the tool writes UTF-8 XML. Do not manually re-encode, HTML-escape, or replace non-Latin characters.

Fonts: omit font choices unless the user or template requires a particular family; a request for a professional appearance alone does not require custom fonts. Names must match the intended viewer, not the generation host's OS. Fonts are neither embedded nor verified. DOCX/PPTX separate global Latin/East Asian defaults; local font overrides all scripts; use local latin_font/east_asia_font/complex_script_font for one script. XLSX uses style.font_name. Read the guide for inheritance and resetting overrides. lang is a language hint, not encoding or a font repair.

Actions:
- guide: pass format (docx | xlsx | pptx) for fields, defaults and examples.
- create: absolute file_path, optional settings and operations. Existing files require explicit overwrite:true.
- edit: file_path and non-empty operations. For content corrections, replace/update in place; do not insert/delete/move just to replace content.
- read: only for a file this tool generated, to verify output or get current indexes before edit. file_path, offset/limit, detail:"full" for exact content and current indexes. XLSX accepts sheet and range (A1:D20); use next_offset to continue.

Each operation is {op, ...fields}. Operations run in array order against the result of earlier operations. Block/slide/element indexes are 0-based and shift after insert/delete; move `to` is the position after removing the source. A failed batch writes nothing. Use the error's field/index guidance, read the target if uncertain, and send corrected input; do not repeat an unchanged failed call or replay a successful batch.

Common edits:
- DOCX: insert_blocks {markdown} to append; replace_blocks {index, count?, markdown} to replace. Markdown math becomes editable Word equations; read the guide for paper and formula inputs.
- XLSX: add_sheet {name, rows}; set_cells {sheet, start, rows}; format_range {sheet, range, style}; add_chart {sheet, chart} for native column/bar/line/pie charts; replace_chart {sheet, index, chart} / delete_chart {sheet, index}.
- PPTX: insert_slides {slides} to append; replace_slide {index, slide} to replace one complete slide; update_slide {index, update_elements:[{index, ...changed fields}]} for element patches (no nested op); update_slide {index, elements} to replace all elements while keeping slide metadata. Use set_theme for deck defaults. Canvas: 1280×720 px, or 960×720 for 4:3.

Completion for ALL formats: finish edits, inspect warnings, then read back changed content and references. This is structural verification, not visual rendering; PPTX layout warnings are estimates. External rendering is optional, not a generation dependency. Do not automatically probe/install/repair LibreOffice/soffice or other Office packages, or build a substitute renderer. When visual inspection is required, use a known available viewer on the file-owning machine; otherwise deliver and state the unverified scope. Never infer compatibility with one viewer from another. Choose fonts for the target environment; DOCX/PPTX language can be overridden with lang.

Images accept absolute workspace paths or data URLs (PNG/JPEG/GIF/BMP); download web images first. Reuse embedded asset names from read. Only files created by this tool can be read or edited here. External modifications are preserved by refusing edits; discard_external_changes:true explicitly rebuilds from the last embedded model and drops those modifications."#
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
        "Create and incrementally edit Word, Excel, and PowerPoint files; use Read to read existing documents.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "edit", "read", "guide"],
                    "description": "create a new file, edit a file this tool generated, read the structure of a file this tool generated, or get the field reference for a format. Never use read for user-provided or other existing Office files; use the Read tool for those."
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
                    "description": "create/edit: ordered atomic batch. Each item needs op AND that operation's fields. Indexes refer to the state after preceding operations. Prefer in-place replacement for content edits.",
                    "items": operation_schema()
                },
                "settings": settings_schema(),
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
                "visual_rendered": { "type": "boolean" },
                "fonts_verified": { "type": "boolean", "description":"Whether this tool verified fonts in the target viewer. Always false for structural generation/read." },
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
            let text = format!("{}\nStructural read only; fonts and visual rendering were not verified in the target viewer.", serde_json::to_string_pretty(&view).unwrap_or_default());
            return Ok(vec![ToolResult::ok(
                json!({
                    "action": "read",
                    "format": format.as_str(),
                    "file_path": resolved.logical_path,
                    "view": view,
                    "visual_rendered": false,
                    "fonts_verified": false,
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
                "visual_rendered": false,
                "fonts_verified": false,
            }),
            Some(text),
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::{GenOfficeFileTool, OfficeError, OfficeErrorKind};
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
            json!({"action":"create","file_path":"/a/b.docx","settings":{"styles":{"east_asia_font":" "}}}),
            json!({"action":"edit","file_path":"/a/b.xlsx","operations":[{"op":"format_range","range":"A1","style":{"font_name":42}}]}),
            json!({"action":"create","file_path":"/a/b.pptx","operations":[{"op":"insert_slides","slides":[{"elements":[{"type":"text","text":"中文","latin_font":"bad\nfont"}]}]}]}),
        ];
        for case in cases {
            assert!(GenOfficeFileTool::check_input(&case).is_err(), "{case}");
        }
    }

    #[tokio::test]
    async fn contract_routes_reading_existing_office_files_to_read_tool() {
        let tool = GenOfficeFileTool::new();
        let description = tool.description().await.unwrap();
        assert!(description.contains("It is not a document reader"));
        assert!(description.contains("use the Read tool"));
        assert!(tool.short_description().contains("use Read"));
        let action = &tool.input_schema()["properties"]["action"]["description"];
        assert!(action.as_str().unwrap().contains("use the Read tool"));

        // A file without the embedded source (an attachment, an Office-saved
        // file) must steer to Read and away from retries or the guide.
        let not_generated = GenOfficeFileTool::office_error_message(OfficeError::new(
            OfficeErrorKind::NotGenerated,
            "this file was not created by GenOfficeFile",
        ));
        assert!(
            not_generated.contains("use the Read tool"),
            "{not_generated}"
        );
        assert!(not_generated.contains("Do not retry"), "{not_generated}");
        assert!(!not_generated.contains("action=guide"), "{not_generated}");

        let modified = GenOfficeFileTool::office_error_message(OfficeError::new(
            OfficeErrorKind::ExternallyModified,
            "changed by another program",
        ));
        assert!(!modified.contains("action=guide"), "{modified}");
        let corrupt = GenOfficeFileTool::office_error_message(OfficeError::new(
            OfficeErrorKind::CorruptPackage,
            "bad zip",
        ));
        assert!(corrupt.contains("action=guide"), "{corrupt}");
    }

    #[test]
    fn remote_parent_directories_use_posix_paths() {
        assert_eq!(
            GenOfficeFileTool::parent_directory("/home/u/docs/a.pptx", true).as_deref(),
            Some("/home/u/docs")
        );
        assert_eq!(GenOfficeFileTool::parent_directory("a.pptx", true), None);
    }

    #[tokio::test]
    async fn malformed_edits_return_actionable_feedback_before_workspace_access() {
        // No workspace services: these failures must come from input validation,
        // with enough information to repair the call without touching any file.
        let tool = GenOfficeFileTool::new();
        let mut no_workspace = context(Arc::new(MemoryFs::default()), false);
        no_workspace.workspace = None;
        no_workspace.runtime_handles = ToolRuntimeHandles::new(None, None);
        for (operation, expected) in [
            (json!({"op":"replace_slide"}), "index, slide"),
            (
                json!({"op":"replace_slide","index":0,"slide":3}),
                "complete slide object",
            ),
            (
                json!({"op":"update_slide","index":0,"update_elements":[{"index":0,"op":"replace","text":"New"}]}),
                "no op",
            ),
            (
                json!({"op":"move_slides","index":-1,"to":0}),
                "integer >= 0",
            ),
        ] {
            let input =
                json!({"action":"edit","file_path":"/docs/deck.pptx","operations":[operation]});
            let validation = tool.validate_input(&input, None).await;
            assert!(!validation.result);
            let message = validation.message.unwrap();
            assert!(message.contains(expected), "{message}");
            assert!(message.contains("Nothing was written"), "{message}");
            assert!(message.contains("Correct the input"), "{message}");
            let error = tool.call_impl(&input, &no_workspace).await.unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_slide_replacement_can_be_repaired_through_the_tool_on_local_and_remote_workspaces(
    ) {
        for remote in [false, true] {
            let fs = Arc::new(MemoryFs::default());
            let context = context(fs.clone(), remote);
            let tool = GenOfficeFileTool::new();
            let path = "/remote/workspace/out/recovery.pptx";
            let guide = data(
                tool.call_impl(&json!({"action":"guide","format":"pptx"}), &context)
                    .await
                    .unwrap(),
            );
            assert!(guide["guide"].as_str().unwrap().contains("replace_slide"));
            let slide = |title: &str| {
                json!({"title":title,"notes":"Keep notes","elements":[
                    {"type":"text","x":40,"y":40,"w":900,"h":90,"size_pt":30,"text":title}
                ]})
            };
            let created = data(tool.call_impl(&json!({"action":"create","file_path":path,"operations":[
                {"op":"insert_slides","slides":(0..9).map(|i|slide(&format!("Page {i}"))).collect::<Vec<_>>()}
            ]}), &context).await.unwrap());
            assert_eq!(created["visual_rendered"], false);
            let saved = fs.files.lock().unwrap()[path].clone();
            for index in [4, 6] {
                let failed = tool
                    .call_impl(
                        &json!({"action":"edit","file_path":path,"operations":[
                            {"op":"insert_slides","slides":[slide("Replacement")]},
                            {"op":"delete_slides","index":index},
                            {"op":"move_slides","index":9,"to":index}
                        ]}),
                        &context,
                    )
                    .await
                    .unwrap_err();
                let message = failed.to_string();
                assert!(message.contains("move_slides"), "{message}");
                assert!(message.contains("indexes 0..=8"), "{message}");
                assert!(message.contains("recalculate selectors"), "{message}");
                assert!(message.contains("replace_slide"), "{message}");
                assert_eq!(fs.files.lock().unwrap()[path], saved);
            }
            let repaired = data(tool.call_impl(&json!({"action":"edit","file_path":path,"operations":[
                {"op":"replace_slide","index":4,"slide":slide("待更新")},
                {"op":"update_slide","index":4,"update_elements":[{"index":0,"text":"四种模式，按任务选择协作方式"}]}
            ]}), &context).await.unwrap());
            assert_eq!(repaired["revision"], 2);
            assert_eq!(repaired["counts"]["slides"], 9);
            assert_eq!(repaired["visual_rendered"], false);
            let read = data(
                tool.call_impl(
                    &json!({"action":"read","file_path":path,"offset":4,"limit":1,"detail":"full"}),
                    &context,
                )
                .await
                .unwrap(),
            );
            let element = &read["view"]["slides"][0]["elements"][0];
            assert_eq!(
                element["paragraphs"][0]["runs"][0]["text"],
                "四种模式，按任务选择协作方式"
            );
            assert_eq!(element["size_pt"], 30.0);
            assert_eq!(read["view"]["slides"][0]["notes"], "Keep notes");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn all_formats_complete_through_workspace_io_without_an_office_installation() {
        for remote in [false, true] {
            let fs = Arc::new(MemoryFs::default());
            let context = context(fs.clone(), remote);
            let tool = GenOfficeFileTool::new();
            for (format, initial, edit, bad) in [
                (
                    "docx",
                    json!([
                        {"op":"insert_blocks","blocks":[{"type":"paragraph","runs":[{"text":"旧","bold":true,"latin_font":"Arial"},{"text":"项目"}]}]},
                        {"op":"insert_blocks","markdown":"论文公式 $E=mc^2$"}
                    ]),
                    json!([
                        {"op":"replace_text","find":"旧项目","replace":"新产品"}
                    ]),
                    json!({"op":"replace_blocks","index":99,"markdown":"invalid"}),
                ),
                (
                    "xlsx",
                    json!([
                        {"op":"add_sheet","name":"数据","rows":[["项目","数量"],["中文",10],["日本語",20]]},
                        {"op":"format_range","range":"A1:B3","style":{"font_name":"Required Font"}},
                        {"op":"add_chart","chart":{"type":"column","anchor":"D1","series":[{"categories":{"range":"A2:A3"},"values":{"range":"B2:B3"}}]}}
                    ]),
                    json!([
                        {"op":"set_cells","start":"B2","rows":[[{"style":{"bold":true}}]]},
                        {"op":"format_range","range":"A1:B3","reset_font":true,"style":{}},
                        {"op":"rename_sheet","name":"新产品"}
                    ]),
                    json!({"op":"add_chart","chart":{"type":"column","anchor":"D1","series":[{"categories":{"range":"A1:A3"},"values":{"range":"B1:B2"}}]}}),
                ),
                (
                    "pptx",
                    json!([
                        {"op":"insert_slides","slides":[{"title":"旧项目","elements":[]}]}
                    ]),
                    json!([
                        {"op":"replace_slide","index":0,"slide":{"title":"新产品","elements":[{"type":"text","x":40,"y":40,"w":900,"h":100,"text":"新产品 中文","latin_font":"Arial"}]}}
                    ]),
                    json!({"op":"delete_slides","index":99}),
                ),
            ] {
                let path = format!("/remote/workspace/out/workflow.{format}");
                let guide = data(
                    tool.call_impl(&json!({"action":"guide","format":format}), &context)
                        .await
                        .unwrap(),
                );
                let guide = guide["guide"].as_str().unwrap();
                assert!(guide.contains("default completion path"));
                assert!(guide.contains("Do not automatically probe, install or repair"));
                for (action, operations) in [("create", initial), ("edit", edit)] {
                    let results = tool
                        .call_impl(
                            &json!({"action":action,"file_path":path,"operations":operations}),
                            &context,
                        )
                        .await
                        .unwrap();
                    match &results[0] {
                        ToolResult::Result {
                            data,
                            result_for_assistant: Some(text),
                            ..
                        } => {
                            assert_eq!(data["visual_rendered"], false);
                            assert_eq!(data["fonts_verified"], false);
                            assert!(text.contains("Generation complete"));
                            assert!(text.contains("Use read"));
                        }
                        other => panic!("missing completion evidence: {other:?}"),
                    }
                }
                let saved = fs.files.lock().unwrap()[&path].clone();
                let failure = tool
                    .call_impl(
                        &json!({"action":"edit","file_path":path,"operations":[bad]}),
                        &context,
                    )
                    .await
                    .unwrap_err();
                assert!(failure.to_string().contains("Nothing was written"));
                assert_eq!(fs.files.lock().unwrap()[&path], saved);
                let mut input = json!({"action":"read","file_path":path,"detail":"full"});
                if format == "xlsx" {
                    input["sheet"] = json!("新产品");
                }
                let read = data(tool.call_impl(&input, &context).await.unwrap());
                assert_eq!(read["fonts_verified"], false);
                assert_eq!(read["visual_rendered"], false);
                assert!(read["view"].to_string().contains("新产品"));
                if format == "docx" {
                    assert_eq!(read["view"]["blocks"][0]["runs"][0]["bold"], true);
                    assert_eq!(read["view"]["blocks"][0]["runs"][0]["latin_font"], "Arial");
                    assert_eq!(read["view"]["blocks"][1]["runs"][1]["math"], "inline");
                    assert_eq!(read["view"]["blocks"][1]["runs"][1]["text"], "E=mc^2");
                    let invalid = tool.call_impl(
                        &json!({"action":"edit","file_path":path,"operations":[{"op":"insert_blocks","markdown":r"$\unknownCommand{x}$"}]}),
                        &context,
                    ).await.unwrap_err();
                    assert!(invalid.to_string().contains("Nothing was written"));
                    assert_eq!(fs.files.lock().unwrap()[&path], saved);
                } else if format == "xlsx" {
                    assert_eq!(read["view"]["rows"][1]["cells"][1], 10);
                    assert_eq!(
                        read["view"]["charts"][0]["series"][0]["values"]["sheet"],
                        "新产品"
                    );
                }
            }
        }
    }
}
