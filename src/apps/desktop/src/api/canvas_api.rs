//! Canvas artifact Tauri commands.

use crate::api::app_state::AppState;
use openbitfun_product_domains::canvas::{
    parse_canvas_artifact_ref, CanvasDiagnostic, CanvasDiagnosticCategory,
    CanvasDiagnosticSeverity, CanvasRevision, CanvasSnapshot, CanvasState, CanvasStoragePort,
};
use openbitfun_runtime_ports::SessionStorePort;
use openbitfun_services_integrations::canvas::CanvasService;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasStateRequest {
    pub artifact_reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCanvasStateRequest {
    pub artifact_reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision_seen: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
    #[serde(default)]
    pub value_versions: BTreeMap<String, u32>,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCanvasRuntimeErrorRequest {
    pub artifact_reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision_seen: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCanvasRuntimeReadyRequest {
    pub artifact_reference: String,
    pub source_revision_seen: String,
    pub runtime_version: String,
    pub sdk_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasStateResponse {
    pub state: Option<CanvasState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasArtifactResponse {
    pub canvas: CanvasSnapshot,
    pub artifact_reference: String,
}

#[tauri::command]
pub async fn load_canvas_artifact(
    state: State<'_, AppState>,
    request: CanvasStateRequest,
) -> Result<CanvasArtifactResponse, String> {
    let reference = parse_canvas_artifact_ref(&request.artifact_reference)
        .map_err(|error| format!("Invalid Canvas artifact reference: {:?}", error))?;
    let service = canvas_service_for_request(&state, request_workspace(&request), &request).await?;
    let snapshot = service
        .load_snapshot(reference.session_id, reference.canvas_id)
        .await
        .map_err(|error| error.message)?;
    Ok(CanvasArtifactResponse {
        canvas: snapshot,
        artifact_reference: request.artifact_reference,
    })
}

#[tauri::command]
pub async fn load_canvas_state(
    state: State<'_, AppState>,
    request: CanvasStateRequest,
) -> Result<CanvasStateResponse, String> {
    let reference = parse_canvas_artifact_ref(&request.artifact_reference)
        .map_err(|error| format!("Invalid Canvas artifact reference: {:?}", error))?;
    let service = canvas_service_for_request(&state, request_workspace(&request), &request).await?;
    let state = service
        .load_state(reference.session_id, reference.canvas_id)
        .await
        .map_err(|error| error.message)?;
    Ok(CanvasStateResponse { state })
}

#[tauri::command]
pub async fn save_canvas_state(
    state: State<'_, AppState>,
    request: SaveCanvasStateRequest,
) -> Result<CanvasStateResponse, String> {
    let reference = parse_canvas_artifact_ref(&request.artifact_reference)
        .map_err(|error| format!("Invalid Canvas artifact reference: {:?}", error))?;
    let service = canvas_service_for_save_request(&state, &request).await?;
    let canvas_state = CanvasState {
        canvas_id: reference.canvas_id,
        source_revision_seen: request.source_revision_seen.map(CanvasRevision::new),
        values: request.values,
        value_versions: request.value_versions,
        updated_at: request.updated_at,
        schema_version: openbitfun_product_domains::canvas::CANVAS_CURRENT_STATE_SCHEMA_VERSION,
    };
    let saved = service
        .save_state(reference.session_id, canvas_state)
        .await
        .map_err(|error| error.message)?;
    Ok(CanvasStateResponse { state: Some(saved) })
}

#[tauri::command]
pub async fn report_canvas_runtime_error(
    state: State<'_, AppState>,
    request: ReportCanvasRuntimeErrorRequest,
) -> Result<CanvasArtifactResponse, String> {
    let reference = parse_canvas_artifact_ref(&request.artifact_reference)
        .map_err(|error| format!("Invalid Canvas artifact reference: {:?}", error))?;
    let service = canvas_service_for_runtime_error_request(&state, &request).await?;
    let message = if let Some(name) = request.name.as_deref().filter(|value| !value.is_empty()) {
        format!("{}: {}", name, request.message)
    } else {
        request.message.clone()
    };
    let mut diagnostic = CanvasDiagnostic {
        severity: CanvasDiagnosticSeverity::Error,
        category: CanvasDiagnosticCategory::Runtime,
        message,
        code: Some("canvas.runtime.error".to_string()),
        line: request.line,
        column: request.column,
        suggested_fix: Some(
            "Open the Canvas source and fix the runtime exception, then update the Canvas."
                .to_string(),
        ),
    };
    if let Some(source_revision) = request.source_revision_seen.as_deref() {
        diagnostic
            .message
            .push_str(&format!(" (source revision: {})", source_revision));
    }
    if let Some(stack) = request.stack.as_deref().filter(|value| !value.is_empty()) {
        diagnostic.message.push('\n');
        diagnostic.message.push_str(stack);
    }
    if let Some(component_stack) = request
        .component_stack
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        diagnostic.message.push_str("\nReact component stack:");
        diagnostic.message.push_str(component_stack);
    }
    if let Some(filename) = request
        .filename
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        diagnostic.message.push_str("\nRuntime source: ");
        diagnostic.message.push_str(filename);
    }
    let snapshot = service
        .report_runtime_diagnostic(
            reference.session_id,
            reference.canvas_id,
            request.source_revision_seen.map(CanvasRevision::new),
            diagnostic,
        )
        .await
        .map_err(|error| error.message)?;
    Ok(CanvasArtifactResponse {
        canvas: snapshot,
        artifact_reference: request.artifact_reference,
    })
}

#[tauri::command]
pub async fn report_canvas_runtime_ready(
    state: State<'_, AppState>,
    request: ReportCanvasRuntimeReadyRequest,
) -> Result<CanvasArtifactResponse, String> {
    let reference = parse_canvas_artifact_ref(&request.artifact_reference)
        .map_err(|error| format!("Invalid Canvas artifact reference: {:?}", error))?;
    let service = canvas_service_for_workspace(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let snapshot = service
        .mark_runtime_ready(
            reference.session_id,
            reference.canvas_id,
            CanvasRevision::new(request.source_revision_seen),
            request.runtime_version,
            request.sdk_version,
        )
        .await
        .map_err(|error| error.message)?;
    Ok(CanvasArtifactResponse {
        canvas: snapshot,
        artifact_reference: request.artifact_reference,
    })
}

fn request_workspace(request: &CanvasStateRequest) -> Option<&str> {
    request.workspace_path.as_deref()
}

async fn canvas_service_for_runtime_error_request(
    state: &AppState,
    request: &ReportCanvasRuntimeErrorRequest,
) -> Result<CanvasService, String> {
    canvas_service_for_workspace(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await
}

async fn canvas_service_for_save_request(
    state: &AppState,
    request: &SaveCanvasStateRequest,
) -> Result<CanvasService, String> {
    canvas_service_for_workspace(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await
}

async fn canvas_service_for_request(
    state: &AppState,
    workspace_path: Option<&str>,
    request: &CanvasStateRequest,
) -> Result<CanvasService, String> {
    canvas_service_for_workspace(
        state,
        request.workspace_id.as_deref(),
        workspace_path,
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await
}

async fn canvas_service_for_workspace(
    state: &AppState,
    workspace_id: Option<&str>,
    legacy_workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<CanvasService, String> {
    let workspace = if let Some(id) = workspace_id {
        state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?
    } else if let Some(path) = legacy_workspace_path.filter(|path| !path.is_empty()) {
        state
            .workspace_service
            .resolve_legacy_workspace_reference(None, path, remote_connection_id, remote_ssh_host)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy Canvas workspace cannot be resolved")?
    } else {
        // Canvas state is keyed by the owning workspace. Falling through to the
        // active workspace would silently store a session's Canvas under the
        // wrong workspace, so reject requests that carry neither an ID nor a
        // legacy path.
        return Err("Canvas requests must identify the owning workspace".to_string());
    };
    let sessions_dir = openbitfun_core::agentic::session::CoreSessionStorePort::default()
        .resolve_workspace_storage(&workspace.id)
        .await
        .map_err(|e| e.to_string())?
        .effective_storage_path;
    Ok(CanvasService::persistent(sessions_dir))
}
