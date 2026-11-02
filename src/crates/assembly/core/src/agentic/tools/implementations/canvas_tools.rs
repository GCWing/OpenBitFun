//! Canvas artifact tools.

use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::Utc;
use openbitfun_product_domains::canvas::{
    parse_canvas_artifact_ref, CanvasArtifact, CanvasArtifactRef, CanvasId, CanvasRevision,
    CanvasScope, CanvasSessionId, CanvasSnapshot, CanvasSource, CanvasStatus, CanvasStoragePort,
    CanvasWorkspaceId, OPENBITFUN_CANVAS_SDK_VERSION,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct CreateCanvasTool;
pub struct ReadCanvasTool;
pub struct UpdateCanvasTool;
pub struct PatchCanvasTool;

struct CanvasReplacement {
    old: String,
    new: String,
}

impl CreateCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreateCanvasTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReadCanvasTool {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for UpdateCanvasTool {
    fn default() -> Self {
        Self::new()
    }
}

impl PatchCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PatchCanvasTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CreateCanvasTool {
    fn name(&self) -> &str {
        "CreateCanvas"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Create a session-scoped OpenBitFun Canvas artifact from a single TSX source file.

Use this for rich visual artifacts, dashboards, explainers, interactive summaries, charts, diagrams, and compact apps that should render beside the conversation instead of being written into the user's repository.

Rules:
- Provide one complete TSX source string.
- Import only from `openbitfun/canvas`.
- Do not use relative imports, dynamic imports, npm packages, network fetches, or helper files.
- The source must include `export default`.

Returns a stable `openbitfun-canvas://...` artifact reference for subsequent Canvas tool calls. The client presents the artifact as an openable card automatically; do not copy the internal reference into user-facing prose. Use ReadCanvas to inspect it, PatchCanvas for small targeted revisions, and UpdateCanvas for full-source rewrites."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Create a session-scoped OpenBitFun Canvas artifact.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "source"],
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short display title for the Canvas artifact."
                },
                "description": {
                    "type": "string",
                    "description": "Optional one-sentence description."
                },
                "source": {
                    "type": "string",
                    "description": "Complete single-file TSX source using imports from openbitfun/canvas only."
                },
                "filename": {
                    "type": "string",
                    "description": "Optional .tsx filename. Defaults to a sanitized title."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        canvas_output_schema()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let title = required_non_empty_string(input, "title")?;
        let source = normalize_canvas_source_input(required_non_empty_string(input, "source")?);
        let description = optional_non_empty_string(input, "description");
        let filename = input
            .get("filename")
            .and_then(|value| value.as_str())
            .map(sanitize_canvas_filename)
            .unwrap_or_else(|| sanitize_canvas_filename(title));
        let session_id = require_session_id(context)?;
        let workspace_id = workspace_id_for_context(context);
        let now = now_millis();
        let canvas_id = CanvasId::new(format!("canvas_{}", uuid_short()));
        let revision = CanvasRevision::new(format!("rev_{}", uuid_short()));
        let artifact = CanvasArtifact {
            id: canvas_id.clone(),
            scope: CanvasScope::Session,
            session_id: session_id.clone(),
            workspace_id,
            title: title.to_string(),
            description: description.map(str::to_string),
            source_revision: revision.clone(),
            latest_compiled_revision: None,
            latest_rendered_revision: None,
            last_known_good_revision: None,
            status: CanvasStatus::SourceSaved,
            created_at: now,
            updated_at: now,
        };
        let source = CanvasSource::new_tsx(
            canvas_id.clone(),
            revision,
            filename,
            source,
            OPENBITFUN_CANVAS_SDK_VERSION,
            now,
        );

        let service = canvas_storage_for_context(context)?;
        service
            .save_source(artifact, source, Vec::new())
            .await
            .map_err(canvas_port_error)?;
        let compile_result = service
            .compile_latest(session_id.clone(), canvas_id.clone(), now)
            .await
            .map_err(canvas_port_error)?;
        let snapshot = service
            .load_snapshot(session_id.clone(), canvas_id.clone())
            .await
            .map_err(canvas_port_error)?;

        Ok(vec![canvas_tool_result(
            "created",
            &snapshot,
            compile_result.compiled,
        )])
    }
}

#[async_trait]
impl Tool for ReadCanvasTool {
    fn name(&self) -> &str {
        "ReadCanvas"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Read a OpenBitFun Canvas artifact from the current session.

Provide either `artifact_reference` returned by CreateCanvas/PatchCanvas/UpdateCanvas or `canvas_id` for the current session. By default this returns metadata, status, diagnostics, and source. Set `include_source` to false when only status metadata is needed."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Read Canvas metadata, diagnostics, and source.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "artifact_reference": {
                    "type": "string",
                    "description": "Stable openbitfun-canvas:// artifact reference."
                },
                "canvas_id": {
                    "type": "string",
                    "description": "Canvas id in the current session."
                },
                "include_source": {
                    "type": "boolean",
                    "description": "Whether to include the TSX source. Defaults to true."
                },
                "include_compiled_payload": {
                    "type": "boolean",
                    "description": "Whether to include the compiled HTML payload. Defaults to false."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        canvas_output_schema()
    }

    fn is_readonly(&self) -> bool {
        true
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let (session_id, canvas_id) = resolve_canvas_target(input, context)?;
        let snapshot = canvas_storage_for_context(context)?
            .load_snapshot(session_id, canvas_id)
            .await
            .map_err(canvas_port_error)?;
        let include_source = input
            .get("include_source")
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        let include_compiled_payload = input
            .get("include_compiled_payload")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let mut data = snapshot_data(&snapshot, include_source);
        if include_compiled_payload {
            data["compiledPayload"] = serde_json::to_value(&snapshot.compiled_payload)
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        }

        let assistant_text = canvas_read_result_for_assistant(&snapshot, include_source);
        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }])
    }
}

#[async_trait]
impl Tool for UpdateCanvasTool {
    fn name(&self) -> &str {
        "UpdateCanvas"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Replace the TSX source for an existing OpenBitFun Canvas artifact.

Provide either `artifact_reference` or `canvas_id`, plus one complete replacement `source` string. The Canvas remains session-scoped and keeps its stable artifact reference. The previous compiled payload is retained as last-known-good if the new source fails policy or compile validation."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Update an existing OpenBitFun Canvas artifact.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["source"],
            "properties": {
                "artifact_reference": {
                    "type": "string",
                    "description": "Stable openbitfun-canvas:// artifact reference."
                },
                "canvas_id": {
                    "type": "string",
                    "description": "Canvas id in the current session."
                },
                "source": {
                    "type": "string",
                    "description": "Complete replacement TSX source using imports from openbitfun/canvas only."
                },
                "title": {
                    "type": "string",
                    "description": "Optional replacement display title."
                },
                "description": {
                    "type": "string",
                    "description": "Optional replacement description. Omit to preserve the current value."
                },
                "filename": {
                    "type": "string",
                    "description": "Optional replacement .tsx filename. Omit to preserve the current value."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        canvas_output_schema()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let source_text =
            normalize_canvas_source_input(required_non_empty_string(input, "source")?);
        let (session_id, canvas_id) = resolve_canvas_target(input, context)?;
        let service = canvas_storage_for_context(context)?;
        let existing = service
            .load_snapshot(session_id.clone(), canvas_id.clone())
            .await
            .map_err(canvas_port_error)?;
        let (snapshot, compiled) = save_canvas_source_revision(
            &service,
            session_id,
            canvas_id,
            existing,
            source_text,
            input,
        )
        .await?;

        Ok(vec![canvas_tool_result("updated", &snapshot, compiled)])
    }
}

#[async_trait]
impl Tool for PatchCanvasTool {
    fn name(&self) -> &str {
        "PatchCanvas"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Patch an existing OpenBitFun Canvas artifact by applying exact text replacements to the latest TSX source.

Use this for small, targeted edits such as changing a label, number, style prop, component prop, or a short JSX block. Provide either `artifact_reference` or `canvas_id`, plus one or more replacements. Each `old` text must match the current source exactly once; the tool fails without saving if a replacement is missing or ambiguous. For large rewrites, use UpdateCanvas with a complete replacement source."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Patch an existing OpenBitFun Canvas artifact.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["replacements"],
            "properties": {
                "artifact_reference": {
                    "type": "string",
                    "description": "Stable openbitfun-canvas:// artifact reference."
                },
                "canvas_id": {
                    "type": "string",
                    "description": "Canvas id in the current session."
                },
                "replacements": {
                    "type": "array",
                    "minItems": 1,
                    "description": "Exact source replacements applied in order. Each old text must match exactly once in the current TSX source.",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["old", "new"],
                        "properties": {
                            "old": {
                                "type": "string",
                                "description": "Exact source text to replace. Must occur exactly once."
                            },
                            "new": {
                                "type": "string",
                                "description": "Replacement source text."
                            }
                        }
                    }
                },
                "title": {
                    "type": "string",
                    "description": "Optional replacement display title."
                },
                "description": {
                    "type": "string",
                    "description": "Optional replacement description. Omit to preserve the current value."
                },
                "filename": {
                    "type": "string",
                    "description": "Optional replacement .tsx filename. Omit to preserve the current value."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        canvas_output_schema()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let replacements = parse_canvas_replacements(input)?;
        let (session_id, canvas_id) = resolve_canvas_target(input, context)?;
        let service = canvas_storage_for_context(context)?;
        let existing = service
            .load_snapshot(session_id.clone(), canvas_id.clone())
            .await
            .map_err(canvas_port_error)?;
        let patched_source = apply_canvas_replacements(&existing.source.source, &replacements)?;
        let (snapshot, compiled) = save_canvas_source_revision(
            &service,
            session_id,
            canvas_id,
            existing,
            patched_source,
            input,
        )
        .await?;

        Ok(vec![canvas_tool_result("patched", &snapshot, compiled)])
    }
}

async fn save_canvas_source_revision(
    service: &Arc<dyn CanvasStoragePort>,
    session_id: CanvasSessionId,
    canvas_id: CanvasId,
    existing: CanvasSnapshot,
    source_text: String,
    input: &Value,
) -> OpenBitFunResult<(CanvasSnapshot, bool)> {
    let now = now_millis();
    let revision = CanvasRevision::new(format!("rev_{}", uuid_short()));
    let mut artifact = existing.artifact.clone();
    artifact.title = optional_non_empty_string(input, "title")
        .map(str::to_string)
        .unwrap_or(artifact.title);
    if let Some(description) = optional_non_empty_string(input, "description") {
        artifact.description = Some(description.to_string());
    }
    artifact.source_revision = revision.clone();
    artifact.status = CanvasStatus::SourceSaved;
    artifact.updated_at = now;

    let filename = input
        .get("filename")
        .and_then(|value| value.as_str())
        .map(sanitize_canvas_filename)
        .unwrap_or(existing.source.filename);
    let source = CanvasSource::new_tsx(
        canvas_id.clone(),
        revision,
        filename,
        source_text,
        OPENBITFUN_CANVAS_SDK_VERSION,
        now,
    );

    service
        .save_source(artifact, source, Vec::new())
        .await
        .map_err(canvas_port_error)?;
    let compile_result = service
        .compile_latest(session_id.clone(), canvas_id.clone(), now)
        .await
        .map_err(canvas_port_error)?;
    let snapshot = service
        .load_snapshot(session_id, canvas_id)
        .await
        .map_err(canvas_port_error)?;

    Ok((snapshot, compile_result.compiled))
}

fn canvas_tool_result(action: &str, snapshot: &CanvasSnapshot, compiled: bool) -> ToolResult {
    let reference = artifact_reference(snapshot).to_uri();
    let compiled_payload = snapshot.compiled_payload.as_ref().map(|payload| {
        json!({
            "sourceRevision": payload.source_revision,
            "sdkVersion": payload.sdk_version,
            "runtimeVersion": payload.runtime_version,
            "contentHash": payload.content_hash,
            "compiledAt": payload.compiled_at,
        })
    });
    let data = json!({
        "success": compiled,
        "action": action,
        "artifactReference": reference,
        "compiled": compiled,
        "renderValidated": snapshot.artifact.last_known_good_revision.as_ref()
            == Some(&snapshot.artifact.source_revision),
        "diagnosticCount": snapshot.diagnostics.len(),
        "compiledPayload": compiled_payload,
        "canvas": snapshot_data(snapshot, true),
    });
    let assistant_text = canvas_result_for_assistant(action, &reference, snapshot, compiled);
    ToolResult::Result {
        data,
        result_for_assistant: Some(assistant_text),
        image_attachments: None,
    }
}

fn canvas_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "success": {"type": "boolean"},
            "action": {"type": "string", "enum": ["created", "read", "updated", "patched"]},
            "artifactReference": {"type": "string"},
            "compiled": {"type": "boolean"},
            "renderValidated": {"type": "boolean"},
            "diagnosticCount": {"type": "integer"},
            "status": {"type": "string"},
            "diagnostics": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
            "source": {"type": "object", "additionalProperties": true}
        },
        "additionalProperties": true
    })
}

fn canvas_result_for_assistant(
    action: &str,
    reference: &str,
    snapshot: &CanvasSnapshot,
    compiled: bool,
) -> String {
    let mut message = format!(
        "Canvas {}: {}. Status: {:?}. Source compiled: {}. First-render validation: {}. Diagnostics: {}.",
        action,
        reference,
        snapshot.artifact.status,
        compiled,
        snapshot.artifact.last_known_good_revision.as_ref()
            == Some(&snapshot.artifact.source_revision),
        snapshot.diagnostics.len()
    );

    if !snapshot.diagnostics.is_empty() {
        message.push_str("\nDiagnostics:");
        for (index, diagnostic) in snapshot.diagnostics.iter().take(5).enumerate() {
            message.push_str(&format!("\n{}. {}", index + 1, diagnostic.message));
            if let Some(code) = diagnostic.code.as_deref() {
                message.push_str(&format!(" [{}]", code));
            }
            if let (Some(line), Some(column)) = (diagnostic.line, diagnostic.column) {
                message.push_str(&format!(" at line {}, column {}", line, column));
            }
            if let Some(fix) = diagnostic.suggested_fix.as_deref() {
                message.push_str(&format!(". Suggested fix: {}", fix));
            }
        }
    }

    if !compiled {
        let preview = canvas_source_preview(&snapshot.source.source);
        if !preview.is_empty() {
            message.push_str("\nSource starts with:\n");
            message.push_str(&preview);
        }
    }

    message
}

fn canvas_read_result_for_assistant(snapshot: &CanvasSnapshot, include_source: bool) -> String {
    let reference = artifact_reference(snapshot).to_uri();
    let mut message = format!(
        "Canvas read: {}. Status: {:?}. Diagnostics: {}.",
        reference,
        snapshot.artifact.status,
        snapshot.diagnostics.len()
    );

    if include_source {
        message.push_str(&format!(
            "\nSource revision: {}\nFilename: {}\nSource:\n```tsx\n{}\n```",
            snapshot.source.revision.as_str(),
            snapshot.source.filename,
            snapshot.source.source
        ));
    }

    message
}

fn normalize_canvas_source_input(source: &str) -> String {
    let trimmed = source.trim();
    let Some(after_start) = trimmed.strip_prefix("<![CDATA[") else {
        return source.to_string();
    };
    let Some(inner) = after_start.strip_suffix("]]>") else {
        return source.to_string();
    };
    inner.trim().to_string()
}

fn parse_canvas_replacements(input: &Value) -> OpenBitFunResult<Vec<CanvasReplacement>> {
    let values = input
        .get("replacements")
        .and_then(|value| value.as_array())
        .filter(|values| !values.is_empty())
        .ok_or_else(|| OpenBitFunError::validation("Missing required field: replacements"))?;

    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let old = value
                .get("old")
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Missing required field: replacements[{}].old",
                        index
                    ))
                })?;
            if old.is_empty() {
                return Err(OpenBitFunError::validation(format!(
                    "replacements[{}].old must not be empty",
                    index
                )));
            }
            let new = value
                .get("new")
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Missing required field: replacements[{}].new",
                        index
                    ))
                })?;
            Ok(CanvasReplacement {
                old: normalize_canvas_source_input(old),
                new: normalize_canvas_source_input(new),
            })
        })
        .collect()
}

fn apply_canvas_replacements(
    source: &str,
    replacements: &[CanvasReplacement],
) -> OpenBitFunResult<String> {
    let mut patched = source.to_string();
    for (index, replacement) in replacements.iter().enumerate() {
        let matches = patched.match_indices(&replacement.old).count();
        match matches {
            0 => {
                return Err(OpenBitFunError::validation(format!(
                    "Canvas patch replacement {} did not match the current source",
                    index + 1
                )));
            }
            1 => {
                patched = patched.replacen(&replacement.old, &replacement.new, 1);
            }
            count => {
                return Err(OpenBitFunError::validation(format!(
                    "Canvas patch replacement {} matched {} locations; provide a more specific old text",
                    index + 1,
                    count
                )));
            }
        }
    }
    Ok(patched)
}

fn canvas_source_preview(source: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 320;
    source
        .chars()
        .take(MAX_PREVIEW_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn canvas_storage_for_context(
    context: &ToolUseContext,
) -> OpenBitFunResult<Arc<dyn CanvasStoragePort>> {
    context.canvas_storage().ok_or_else(|| {
        OpenBitFunError::tool(
            "Canvas storage is unavailable for this execution context; use a workspace-backed session",
        )
    })
}

fn snapshot_data(snapshot: &CanvasSnapshot, include_source: bool) -> Value {
    let reference = artifact_reference(snapshot).to_uri();
    let mut data = json!({
        "artifact": &snapshot.artifact,
        "artifactReference": reference,
        "status": snapshot.artifact.status,
        "diagnostics": &snapshot.diagnostics,
        "compiled": snapshot.compiled_payload.is_some(),
        "latestCompiledRevision": snapshot.artifact.latest_compiled_revision,
        "latestRenderedRevision": snapshot.artifact.latest_rendered_revision,
        "lastKnownGoodRevision": snapshot.artifact.last_known_good_revision,
        "state": &snapshot.state,
    });
    if include_source {
        data["source"] = serde_json::to_value(&snapshot.source).unwrap_or(Value::Null);
    }
    data
}

fn artifact_reference(snapshot: &CanvasSnapshot) -> CanvasArtifactRef {
    CanvasArtifactRef::new(
        snapshot.artifact.session_id.clone(),
        snapshot.artifact.id.clone(),
    )
}

fn resolve_canvas_target(
    input: &Value,
    context: &ToolUseContext,
) -> OpenBitFunResult<(CanvasSessionId, CanvasId)> {
    if let Some(reference) = optional_non_empty_string(input, "artifact_reference") {
        let parsed = parse_canvas_artifact_ref(reference).map_err(|error| {
            OpenBitFunError::validation(format!("Invalid artifact_reference: {error}"))
        })?;
        return Ok((parsed.session_id, parsed.canvas_id));
    }

    let session_id = require_session_id(context)?;
    let canvas_id = optional_non_empty_string(input, "canvas_id")
        .ok_or_else(|| {
            OpenBitFunError::validation(
                "Provide either artifact_reference or canvas_id for the Canvas artifact",
            )
        })
        .map(CanvasId::new)?;
    Ok((session_id, canvas_id))
}

fn require_session_id(context: &ToolUseContext) -> OpenBitFunResult<CanvasSessionId> {
    context
        .session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(CanvasSessionId::new)
        .ok_or_else(|| OpenBitFunError::tool("session_id is required to use Canvas tools"))
}

fn workspace_id_for_context(context: &ToolUseContext) -> CanvasWorkspaceId {
    CanvasWorkspaceId::new(
        context
            .current_workspace_scope()
            .unwrap_or_else(|| "current".to_string()),
    )
}

fn required_non_empty_string<'a>(input: &'a Value, key: &str) -> OpenBitFunResult<&'a str> {
    input
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OpenBitFunError::validation(format!("Missing required field: {key}")))
}

fn optional_non_empty_string<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn sanitize_canvas_filename(value: &str) -> String {
    let trimmed = value.trim();
    let without_extension = trimmed
        .strip_suffix(".tsx")
        .or_else(|| trimmed.strip_suffix(".TSX"))
        .unwrap_or(trimmed);
    let mut filename = without_extension
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    while filename.contains("--") {
        filename = filename.replace("--", "-");
    }
    filename = filename.trim_matches('-').to_string();
    if filename.is_empty() {
        filename = "canvas".to_string();
    }
    format!("{filename}.tsx")
}

fn uuid_short() -> String {
    uuid::Uuid::new_v4()
        .to_string()
        .split('-')
        .next()
        .unwrap_or("00000000")
        .to_string()
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn canvas_port_error(
    error: openbitfun_product_domains::canvas::CanvasPortError,
) -> OpenBitFunError {
    OpenBitFunError::tool(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::Tool;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use openbitfun_runtime_ports::ToolRuntimeHandles;
    use std::collections::HashMap;

    fn test_context(session_id: &str) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Agent".to_string()),
            session_id: Some(session_id.to_string()),
            dialog_turn_id: Some("turn_1".to_string()),
            workspace: Some(WorkspaceBinding::new(
                Some(format!("workspace_{session_id}")),
                std::env::temp_dir().join(format!("openbitfun-canvas-tool-test-{}", uuid_short())),
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: ToolRuntimeHandles::new(None, None),
        }
    }

    fn test_context_without_workspace(session_id: &str) -> ToolUseContext {
        let mut context = test_context(session_id);
        context.workspace = None;
        context
    }

    fn valid_source() -> &'static str {
        "import { Stack } from 'openbitfun/canvas'; export default function Canvas() { return <Stack />; }"
    }

    #[tokio::test]
    async fn create_read_and_update_canvas_round_trip() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Build Health",
                    "source": valid_source(),
                }),
                &context,
            )
            .await
            .expect("canvas should create");
        let ToolResult::Result { data, .. } = &created[0] else {
            panic!("expected result");
        };
        let reference = data["artifactReference"]
            .as_str()
            .expect("reference should be returned");
        assert!(reference.starts_with("openbitfun-canvas://session/"));
        assert_eq!(
            data["compiledPayload"]["html"],
            Value::Null,
            "write tool results should not persist full compiled HTML"
        );
        assert!(data["compiledPayload"]["contentHash"].is_string());

        let read = ReadCanvasTool::new();
        let read_result = read
            .call_impl(&json!({ "artifact_reference": reference }), &context)
            .await
            .expect("canvas should read");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &read_result[0]
        else {
            panic!("expected result");
        };
        assert_eq!(data["artifact"]["title"], "Build Health");
        assert_eq!(data["source"]["filename"], "build-health.tsx");
        let assistant = result_for_assistant.as_deref().unwrap_or_default();
        assert!(assistant.contains("Source revision:"), "{assistant}");
        assert!(
            assistant.contains("Filename: build-health.tsx"),
            "{assistant}"
        );
        assert!(assistant.contains("```tsx"), "{assistant}");
        assert!(assistant.contains(valid_source()), "{assistant}");

        let update = UpdateCanvasTool::new();
        let updated = update
            .call_impl(
                &json!({
                    "artifact_reference": reference,
                    "source": "import helper from './helper'; export default function Canvas() { return null; }",
                }),
                &context,
            )
            .await
            .expect("canvas should update even when compile policy fails");
        let ToolResult::Result { data, .. } = &updated[0] else {
            panic!("expected result");
        };
        assert_eq!(data["compiled"], false);
        assert_eq!(data["success"], false);
        assert_eq!(data["canvas"]["status"], "compile_failed");
        assert!(data["canvas"]["lastKnownGoodRevision"].is_null());
        assert!(!data["canvas"]["latestCompiledRevision"].is_null());
    }

    #[tokio::test]
    async fn create_canvas_requires_workspace_backed_storage() {
        let context = test_context_without_workspace(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();

        let error = create
            .call_impl(
                &json!({
                    "title": "No Workspace",
                    "source": valid_source(),
                }),
                &context,
            )
            .await
            .expect_err("canvas tool must require injected storage");

        assert!(
            error.to_string().contains("Canvas storage is unavailable"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn read_canvas_can_omit_source_from_assistant_result() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Summary Only",
                    "source": valid_source(),
                }),
                &context,
            )
            .await
            .expect("canvas should create");
        let ToolResult::Result { data, .. } = &created[0] else {
            panic!("expected result");
        };
        let reference = data["artifactReference"]
            .as_str()
            .expect("reference should be returned");

        let read = ReadCanvasTool::new();
        let read_result = read
            .call_impl(
                &json!({
                    "artifact_reference": reference,
                    "include_source": false,
                }),
                &context,
            )
            .await
            .expect("canvas should read");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &read_result[0]
        else {
            panic!("expected result");
        };
        let assistant = result_for_assistant.as_deref().unwrap_or_default();

        assert!(data.get("source").is_none());
        assert!(assistant.contains("Canvas read:"), "{assistant}");
        assert!(!assistant.contains("```tsx"), "{assistant}");
        assert!(!assistant.contains(valid_source()), "{assistant}");
    }

    #[tokio::test]
    async fn patch_canvas_applies_unique_text_replacements() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Stats",
                    "source": "import { Stat } from 'openbitfun/canvas'; export default function Canvas() { return <Stat value=\"+191\" label=\"Added\" />; }",
                }),
                &context,
            )
            .await
            .expect("canvas should create");
        let ToolResult::Result { data, .. } = &created[0] else {
            panic!("expected result");
        };
        let reference = data["artifactReference"]
            .as_str()
            .expect("reference should be returned");

        let patch = PatchCanvasTool::new();
        let patched = patch
            .call_impl(
                &json!({
                    "artifact_reference": reference,
                    "replacements": [
                        {
                            "old": "value=\"+191\"",
                            "new": "value=\"-191\""
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect("canvas should patch");
        let ToolResult::Result { data, .. } = &patched[0] else {
            panic!("expected result");
        };

        assert_eq!(data["action"], "patched");
        assert_eq!(data["compiled"], true);
        assert!(data["canvas"]["source"]["source"]
            .as_str()
            .unwrap_or_default()
            .contains("value=\"-191\""));
    }

    #[tokio::test]
    async fn patch_canvas_rejects_ambiguous_replacements_without_saving() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Duplicate",
                    "source": "import { Text } from 'openbitfun/canvas'; export default function Canvas() { return <><Text>same</Text><Text>same</Text></>; }",
                }),
                &context,
            )
            .await
            .expect("canvas should create");
        let ToolResult::Result { data, .. } = &created[0] else {
            panic!("expected result");
        };
        let reference = data["artifactReference"]
            .as_str()
            .expect("reference should be returned");

        let patch = PatchCanvasTool::new();
        let error = patch
            .call_impl(
                &json!({
                    "artifact_reference": reference,
                    "replacements": [
                        {
                            "old": "same",
                            "new": "changed"
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect_err("ambiguous patch should fail");
        assert!(error.to_string().contains("matched 2 locations"), "{error}");

        let read = ReadCanvasTool::new();
        let read_result = read
            .call_impl(&json!({ "artifact_reference": reference }), &context)
            .await
            .expect("canvas should read");
        let ToolResult::Result { data, .. } = &read_result[0] else {
            panic!("expected result");
        };
        assert!(!data["source"]["source"]
            .as_str()
            .unwrap_or_default()
            .contains("changed"));
    }

    #[tokio::test]
    async fn patch_canvas_rejects_missing_replacements_without_saving() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Missing",
                    "source": valid_source(),
                }),
                &context,
            )
            .await
            .expect("canvas should create");
        let ToolResult::Result { data, .. } = &created[0] else {
            panic!("expected result");
        };
        let reference = data["artifactReference"]
            .as_str()
            .expect("reference should be returned");

        let patch = PatchCanvasTool::new();
        let error = patch
            .call_impl(
                &json!({
                    "artifact_reference": reference,
                    "replacements": [
                        {
                            "old": "does not exist",
                            "new": "replacement"
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect_err("missing patch should fail");
        assert!(error.to_string().contains("did not match"), "{error}");

        let read = ReadCanvasTool::new();
        let read_result = read
            .call_impl(&json!({ "artifact_reference": reference }), &context)
            .await
            .expect("canvas should read");
        let ToolResult::Result { data, .. } = &read_result[0] else {
            panic!("expected result");
        };
        assert_eq!(data["source"]["source"], valid_source());
    }

    #[tokio::test]
    async fn create_canvas_strips_cdata_source_wrapper() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Wrapped",
                    "source": format!("<![CDATA[{}]]>", valid_source()),
                }),
                &context,
            )
            .await
            .expect("canvas should create from wrapped source");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &created[0]
        else {
            panic!("expected result");
        };

        assert_eq!(data["compiled"], true);
        assert_eq!(data["canvas"]["status"], "compiled");
        assert_eq!(data["canvas"]["source"]["source"], valid_source());
        assert!(!result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("CDATA"));
    }

    #[tokio::test]
    async fn canvas_compile_failure_result_includes_diagnostic_details() {
        let context = test_context(&format!("session_{}", uuid_short()));
        let create = CreateCanvasTool::new();
        let created = create
            .call_impl(
                &json!({
                    "title": "Broken",
                    "source": "<not tsx>\nexport default function Canvas() { return null; }",
                }),
                &context,
            )
            .await
            .expect("canvas should return diagnostics");
        let ToolResult::Result {
            result_for_assistant,
            ..
        } = &created[0]
        else {
            panic!("expected result");
        };
        let assistant = result_for_assistant.as_deref().unwrap_or_default();

        assert!(assistant.contains("Unexpected token"), "{assistant}");
        assert!(assistant.contains(" at line "), "{assistant}");
        assert!(assistant.contains(", column "), "{assistant}");
        assert!(assistant.contains("Source starts with"), "{assistant}");
    }

    #[test]
    fn sanitize_canvas_filename_keeps_tsx_extension() {
        assert_eq!(sanitize_canvas_filename("Build Health"), "build-health.tsx");
        assert_eq!(
            sanitize_canvas_filename("Chart.canvas.tsx"),
            "chart-canvas.tsx"
        );
    }

    #[test]
    fn normalize_canvas_source_input_strips_only_complete_cdata_wrapper() {
        assert_eq!(
            normalize_canvas_source_input(
                "<![CDATA[\nimport { Text } from 'openbitfun/canvas';\n]]>"
            ),
            "import { Text } from 'openbitfun/canvas';"
        );
        assert_eq!(
            normalize_canvas_source_input("<![CDATA[incomplete"),
            "<![CDATA[incomplete"
        );
        assert_eq!(
            normalize_canvas_source_input("import { Text } from 'openbitfun/canvas';"),
            "import { Text } from 'openbitfun/canvas';"
        );
    }
}
