//! MiniApp API — Tauri commands for MiniApp CRUD, JS Worker, and dialog.

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use futures::StreamExt;
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::miniapp::ai_bridge::{
    ai_stream_chunk_payload, ai_stream_done_payload, ai_stream_error_payload,
    available_models_for_permissions, plan_ai_chat_request, plan_ai_complete_request,
    require_enabled_ai_permissions, require_non_empty_ai_messages, require_non_empty_stream_id,
    MiniAppAiMessagePlan, MiniAppAiMessageRole, MiniAppAiModelDescriptor, MiniAppAiModelInfo,
    MiniAppAiUsage,
};
use openbitfun_core::miniapp::lifecycle::{
    draft_worker_key, miniapp_runtime_event_payload, miniapp_worker_stopped_payload,
    should_emit_worker_restarted, should_stop_worker_for_runtime_update, worker_restart_reason,
    workspace_root_from_input, MiniAppCreateInput, MiniAppUpdatePatch,
};
use openbitfun_core::miniapp::rate_limit::{MiniAppRateLimitState, MiniAppRateLimitSubject};
use openbitfun_core::miniapp::{
    dispatch_host, is_host_primitive, InstallResult as CoreInstallResult, MiniApp,
    MiniAppAiContext, MiniAppCustomizationMetadata, MiniAppDraft, MiniAppMeta,
    MiniAppPermissionDiff, MiniAppPermissions, MiniAppSource,
};
use openbitfun_core::service::config::types::GlobalConfig;
use openbitfun_core::util::types::Message;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub(crate) async fn miniapp_presentation(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request: crate::miniapp_desktop::PresentationRequest,
) -> Result<Value, String> {
    crate::miniapp_desktop::miniapp_presentation(app, window, request).await
}

#[tauri::command]
pub(crate) fn miniapp_shell_call(request: Value) -> Result<Value, String> {
    crate::miniapp_desktop::miniapp_shell_call(request)
}

// ============== Request/Response DTOs ==============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMiniAppRequest {
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source: MiniAppSourceDto,
    #[serde(default)]
    pub permissions: MiniAppPermissions,
    pub ai_context: Option<MiniAppAiContext>,
    #[serde(default)]
    pub chrome: Option<openbitfun_product_domains::miniapp::chrome::MiniAppChrome>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppSourceDto {
    pub html: String,
    pub css: String,
    #[serde(default)]
    pub ui_js: String,
    #[serde(default)]
    pub esm_dependencies: Vec<EsmDepDto>,
    #[serde(default)]
    pub worker_js: String,
    #[serde(default)]
    pub npm_dependencies: Vec<NpmDepDto>,
}

#[derive(Debug, Deserialize)]
pub struct EsmDepDto {
    pub name: String,
    pub version: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NpmDepDto {
    pub name: String,
    pub version: String,
}

impl From<MiniAppSourceDto> for MiniAppSource {
    fn from(d: MiniAppSourceDto) -> Self {
        MiniAppSource {
            html: d.html,
            css: d.css,
            ui_js: d.ui_js,
            esm_dependencies: d
                .esm_dependencies
                .into_iter()
                .map(|x| openbitfun_core::miniapp::EsmDep {
                    name: x.name,
                    version: x.version,
                    url: x.url,
                })
                .collect(),
            worker_js: d.worker_js,
            npm_dependencies: d
                .npm_dependencies
                .into_iter()
                .map(|x| openbitfun_core::miniapp::NpmDep {
                    name: x.name,
                    version: x.version,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMiniAppRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub source: Option<MiniAppSourceDto>,
    pub permissions: Option<MiniAppPermissions>,
    pub ai_context: Option<MiniAppAiContext>,
    #[serde(default)]
    pub chrome: Option<openbitfun_product_domains::miniapp::chrome::MiniAppChrome>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMiniAppRequest {
    pub app_id: String,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppWorkerCallRequest {
    pub app_id: String,
    pub method: String,
    pub params: Value,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppHostCallRequest {
    pub app_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppRecompileRequest {
    pub app_id: String,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppImportFromPathRequest {
    pub path: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppSyncFromFsRequest {
    pub app_id: String,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftCreateRequest {
    pub app_id: String,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftRequest {
    pub app_id: String,
    pub draft_id: String,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftPermissionsRequest {
    pub app_id: String,
    pub draft_id: String,
    pub permissions: MiniAppPermissions,
    pub appearance_mode: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftWorkerCallRequest {
    pub app_id: String,
    pub draft_id: String,
    pub method: String,
    pub params: Value,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftHostCallRequest {
    pub app_id: String,
    pub draft_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftStorageRequest {
    pub app_id: String,
    pub draft_id: String,
    pub key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDraftStorageSetRequest {
    pub app_id: String,
    pub draft_id: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppDeclineBuiltinUpdateRequest {
    pub app_id: String,
    pub builtin_version: u32,
    pub source_hash: String,
}

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub available: bool,
    pub kind: Option<String>,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RecompileResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

async fn emit_miniapp_event(event_name: &str, payload: Value) {
    let _ = emit_global_event(BackendEvent::Custom {
        event_name: event_name.to_string(),
        payload,
    })
    .await;
}

async fn maybe_stop_worker(state: &State<'_, AppState>, app: &MiniApp) {
    if should_stop_worker_for_runtime_update(app) {
        if let Some(ref pool) = state.js_worker_pool {
            pool.stop(&app.id).await;
        }
        emit_miniapp_event(
            "miniapp-worker-stopped",
            miniapp_worker_stopped_payload(&app.id, "pending-restart"),
        )
        .await;
    }
}

async fn ensure_worker_dependencies(
    state: &State<'_, AppState>,
    app_id: &str,
    app: &mut MiniApp,
) -> Result<bool, String> {
    let pool = state
        .js_worker_pool
        .as_ref()
        .ok_or_else(|| "JS Worker pool not initialized".to_string())?;

    let needs_install = !app.source.npm_dependencies.is_empty()
        && (app.runtime.deps_dirty || !pool.has_installed_deps(app_id));
    if !needs_install {
        return Ok(false);
    }

    let install = pool
        .install_deps(app_id, &app.source.npm_dependencies)
        .await
        .map_err(|e| e.to_string())?;
    if !install.success {
        let details = if !install.stderr.trim().is_empty() {
            install.stderr
        } else {
            install.stdout
        };
        return Err(format!(
            "MiniApp dependencies install failed for {app_id}: {}",
            details.trim()
        ));
    }

    pool.stop(app_id).await;
    *app = state
        .miniapp_manager
        .mark_deps_installed(app_id)
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(app, "deps-installed"),
    )
    .await;
    Ok(true)
}

// ============== App management commands ==============

#[tauri::command]
pub async fn list_miniapps(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Vec<MiniAppMeta>, String> {
    let trace_started = Instant::now();
    let result = state
        .miniapp_manager
        .list()
        .await
        .map_err(|e| e.to_string());
    startup_trace.record_tauri_command_elapsed("list_miniapps", None, trace_started);
    result
}

#[tauri::command]
pub async fn get_miniapp(
    state: State<'_, AppState>,
    request: GetMiniAppRequest,
) -> Result<MiniApp, String> {
    let mut app = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;

    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    match state.miniapp_manager.compile_source(
        &request.app_id,
        &app.source,
        &app.permissions,
        appearance_mode,
        workspace_root.as_deref(),
    ) {
        Ok(html) => app.compiled_html = html,
        Err(e) => log::warn!("get_miniapp: recompile failed, using cached: {}", e),
    }
    Ok(app)
}

#[tauri::command]
pub async fn create_miniapp(
    state: State<'_, AppState>,
    request: CreateMiniAppRequest,
) -> Result<MiniApp, String> {
    let source: MiniAppSource = request.source.into();
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .create_with_input(
            MiniAppCreateInput {
                name: request.name,
                description: request.description,
                icon: request.icon,
                category: request.category,
                tags: request.tags,
                source,
                permissions: request.permissions,
                ai_context: request.ai_context,
                chrome: request.chrome,
            },
            workspace_root.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-created",
        miniapp_runtime_event_payload(&app, "create"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn update_miniapp(
    state: State<'_, AppState>,
    app_id: String,
    request: UpdateMiniAppRequest,
) -> Result<MiniApp, String> {
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .update_with_patch(
            &app_id,
            MiniAppUpdatePatch {
                name: request.name,
                description: request.description,
                icon: request.icon,
                category: request.category,
                tags: request.tags,
                source: request.source.map(Into::into),
                permissions: request.permissions,
                ai_context: request.ai_context,
                chrome: request.chrome,
            },
            workspace_root.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    maybe_stop_worker(&state, &app).await;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(&app, "update"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn delete_miniapp(state: State<'_, AppState>, app_id: String) -> Result<(), String> {
    if let Some(ref pool) = state.js_worker_pool {
        pool.stop(app_id.as_str()).await;
    }
    state
        .miniapp_manager
        .delete(&app_id)
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-deleted",
        json!({ "id": app_id, "reason": "delete" }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_miniapp_versions(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<Vec<u32>, String> {
    state
        .miniapp_manager
        .list_versions(&app_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rollback_miniapp(
    state: State<'_, AppState>,
    app_id: String,
    version: u32,
) -> Result<MiniApp, String> {
    let app = state
        .miniapp_manager
        .rollback(&app_id, version)
        .await
        .map_err(|e| e.to_string())?;
    maybe_stop_worker(&state, &app).await;
    emit_miniapp_event(
        "miniapp-rolled-back",
        miniapp_runtime_event_payload(&app, "rollback"),
    )
    .await;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(&app, "rollback"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn get_miniapp_storage(
    state: State<'_, AppState>,
    app_id: String,
    key: String,
) -> Result<Value, String> {
    state
        .miniapp_manager
        .get_storage(&app_id, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_miniapp_storage(
    state: State<'_, AppState>,
    app_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    state
        .miniapp_manager
        .set_storage(&app_id, &key, value)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn grant_miniapp_workspace(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<(), String> {
    state.miniapp_manager.grant_workspace(&app_id).await;
    Ok(())
}

#[tauri::command]
pub async fn grant_miniapp_path(
    state: State<'_, AppState>,
    app_id: String,
    path: String,
) -> Result<(), String> {
    state
        .miniapp_manager
        .grant_path(&app_id, PathBuf::from(path))
        .await;
    Ok(())
}

// ============== JS Worker & Runtime ==============

#[tauri::command]
pub async fn miniapp_runtime_status(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let Some(ref pool) = state.js_worker_pool else {
        return Ok(RuntimeStatus {
            available: false,
            kind: None,
            version: None,
            path: None,
        });
    };
    let info = pool.runtime_info();
    Ok(RuntimeStatus {
        available: true,
        kind: Some(match info.kind {
            openbitfun_core::miniapp::RuntimeKind::Bun => "bun".to_string(),
            openbitfun_core::miniapp::RuntimeKind::Node => "node".to_string(),
        }),
        version: Some(info.version.clone()),
        path: Some(info.path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn miniapp_worker_call(
    state: State<'_, AppState>,
    request: MiniAppWorkerCallRequest,
) -> Result<Value, String> {
    if state
        .miniapp_manager
        .uses_market_strict_runtime(&request.app_id)
        .await
    {
        return Err("Marketplace MiniApps cannot start a Node/Bun worker.".to_string());
    }
    let pool = state
        .js_worker_pool
        .as_ref()
        .ok_or_else(|| "JS Worker pool not initialized".to_string())?;
    let was_running = pool.is_running(&request.app_id).await;
    let mut app = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;
    let deps_installed = ensure_worker_dependencies(&state, &request.app_id, &mut app).await?;
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let policy = state
        .miniapp_manager
        .resolve_policy_for_app(&request.app_id, &app.permissions, workspace_root.as_deref())
        .await;
    let policy_json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    let worker_revision = state
        .miniapp_manager
        .build_worker_revision(&app, &policy_json);
    let should_emit_restart = should_emit_worker_restarted(
        was_running,
        deps_installed,
        app.runtime.worker_restart_required,
    );
    let result = pool
        .call(
            &request.app_id,
            &worker_revision,
            &policy_json,
            app.permissions.node.as_ref(),
            &request.method,
            request.params,
        )
        .await
        .map_err(|e| e.to_string())?;
    if should_emit_restart {
        let app = state
            .miniapp_manager
            .clear_worker_restart_required(&request.app_id)
            .await
            .map_err(|e| e.to_string())?;
        emit_miniapp_event(
            "miniapp-worker-restarted",
            miniapp_runtime_event_payload(&app, worker_restart_reason(deps_installed)),
        )
        .await;
    }
    Ok(result)
}

/// Host-side framework primitive RPC.
///
/// Routes `fs.*` / `shell.*` / `os.*` / `net.*` calls directly to the Rust
/// implementation in `openbitfun_core::miniapp::host_dispatch`, no Bun/Node Worker
/// required. Used for MiniApps with `permissions.node.enabled = false` (and as
/// the future migration target for everyone, since these calls don't actually
/// need a JS sandbox).
#[tauri::command]
pub async fn miniapp_host_call(
    state: State<'_, AppState>,
    request: MiniAppHostCallRequest,
) -> Result<Value, String> {
    if !is_host_primitive(&request.method) {
        return Err(format!(
            "method '{}' is not a host primitive (only fs.*/shell.*/os.*/net.* are supported)",
            request.method
        ));
    }
    let app = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;
    if state
        .miniapp_manager
        .uses_market_strict_runtime(&request.app_id)
        .await
    {
        validate_market_host_call(&request.method, &request.params)?;
    }
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app_data_dir = state
        .miniapp_manager
        .path_manager()
        .miniapp_dir(&request.app_id);
    let granted = state
        .miniapp_manager
        .granted_paths_for_app(&request.app_id)
        .await;
    dispatch_host(
        &app.permissions,
        &request.app_id,
        &app_data_dir,
        workspace_root.as_deref(),
        &granted,
        &request.method,
        request.params,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_worker_stop(state: State<'_, AppState>, app_id: String) -> Result<(), String> {
    if let Some(ref pool) = state.js_worker_pool {
        pool.stop(&app_id).await;
    }
    emit_miniapp_event(
        "miniapp-worker-stopped",
        miniapp_worker_stopped_payload(&app_id, "manual-stop"),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn miniapp_worker_list_running(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Vec<String>, String> {
    let trace_started = Instant::now();
    let result = if let Some(ref pool) = state.js_worker_pool {
        Ok(pool.list_running().await)
    } else {
        Ok(vec![])
    };
    startup_trace.record_tauri_command_elapsed("miniapp_worker_list_running", None, trace_started);
    result
}

#[tauri::command]
pub async fn miniapp_install_deps(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<CoreInstallResult, String> {
    let pool = state
        .js_worker_pool
        .as_ref()
        .ok_or_else(|| "JS Worker pool not initialized".to_string())?;
    let app = state
        .miniapp_manager
        .get(&app_id)
        .await
        .map_err(|e| e.to_string())?;
    let install = pool
        .install_deps(&app_id, &app.source.npm_dependencies)
        .await
        .map_err(|e| e.to_string())?;
    if install.success {
        pool.stop(&app_id).await;
        let app = state
            .miniapp_manager
            .mark_deps_installed(&app_id)
            .await
            .map_err(|e| e.to_string())?;
        emit_miniapp_event(
            "miniapp-updated",
            miniapp_runtime_event_payload(&app, "deps-installed"),
        )
        .await;
    }
    Ok(install)
}

#[tauri::command]
pub async fn miniapp_recompile(
    state: State<'_, AppState>,
    request: MiniAppRecompileRequest,
) -> Result<RecompileResult, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .recompile(&request.app_id, appearance_mode, workspace_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-recompiled",
        miniapp_runtime_event_payload(&app, "recompile"),
    )
    .await;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(&app, "recompile"),
    )
    .await;
    Ok(RecompileResult {
        success: true,
        warnings: None,
    })
}

#[tauri::command]
pub async fn miniapp_dialog_message(
    _state: State<'_, AppState>,
    _app_id: String,
    _options: Value,
) -> Result<Value, String> {
    // Tauri dialog is handled by frontend useMiniAppBridge via @tauri-apps/plugin-dialog.
    // This command can be used if we want backend to show message box; for now return not implemented.
    Err("Use dialog from frontend bridge".to_string())
}

#[tauri::command]
pub async fn miniapp_import_from_path(
    state: State<'_, AppState>,
    request: MiniAppImportFromPathRequest,
) -> Result<MiniApp, String> {
    let path_buf = PathBuf::from(&request.path);
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .import_from_path(path_buf, workspace_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    maybe_stop_worker(&state, &app).await;
    emit_miniapp_event(
        "miniapp-created",
        miniapp_runtime_event_payload(&app, "import"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn miniapp_sync_from_fs(
    state: State<'_, AppState>,
    request: MiniAppSyncFromFsRequest,
) -> Result<MiniApp, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .sync_from_fs(&request.app_id, appearance_mode, workspace_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    maybe_stop_worker(&state, &app).await;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(&app, "sync-from-fs"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn miniapp_create_draft(
    state: State<'_, AppState>,
    request: MiniAppDraftCreateRequest,
) -> Result<MiniAppDraft, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let draft = state
        .miniapp_manager
        .create_draft(&request.app_id, appearance_mode, workspace_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-draft-created",
        json!({
            "id": request.app_id,
            "draftId": draft.draft_id,
            "sourceVersion": draft.source_version,
            "reason": "draft-create",
        }),
    )
    .await;
    Ok(draft)
}

#[tauri::command]
pub async fn miniapp_get_draft(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<MiniAppDraft, String> {
    state
        .miniapp_manager
        .get_draft(&request.app_id, &request.draft_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_sync_draft_from_fs(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<MiniAppDraft, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    state
        .miniapp_manager
        .sync_draft_from_fs(
            &request.app_id,
            &request.draft_id,
            appearance_mode,
            workspace_root.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_set_draft_permissions(
    state: State<'_, AppState>,
    request: MiniAppDraftPermissionsRequest,
) -> Result<MiniAppDraft, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    state
        .miniapp_manager
        .set_draft_permissions(
            &request.app_id,
            &request.draft_id,
            request.permissions,
            appearance_mode,
            workspace_root.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_permission_diff_for_draft(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<MiniAppPermissionDiff, String> {
    state
        .miniapp_manager
        .permission_diff_for_draft(&request.app_id, &request.draft_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_apply_draft(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<MiniApp, String> {
    let appearance_mode = request.appearance_mode.as_deref().unwrap_or("dark");
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app = state
        .miniapp_manager
        .apply_draft(
            &request.app_id,
            &request.draft_id,
            appearance_mode,
            workspace_root.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Some(ref pool) = state.js_worker_pool {
        pool.stop(&request.app_id).await;
        pool.stop(&draft_worker_key(&request.app_id, &request.draft_id))
            .await;
    }
    emit_miniapp_event(
        "miniapp-draft-applied",
        miniapp_runtime_event_payload(&app, "draft-apply"),
    )
    .await;
    emit_miniapp_event(
        "miniapp-updated",
        miniapp_runtime_event_payload(&app, "draft-apply"),
    )
    .await;
    Ok(app)
}

#[tauri::command]
pub async fn miniapp_discard_draft(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<(), String> {
    if let Some(ref pool) = state.js_worker_pool {
        pool.stop(&draft_worker_key(&request.app_id, &request.draft_id))
            .await;
    }
    state
        .miniapp_manager
        .discard_draft(&request.app_id, &request.draft_id)
        .await
        .map_err(|e| e.to_string())?;
    emit_miniapp_event(
        "miniapp-draft-discarded",
        json!({ "id": request.app_id, "draftId": request.draft_id, "reason": "draft-discard" }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_miniapp_draft_storage(
    state: State<'_, AppState>,
    request: MiniAppDraftStorageRequest,
) -> Result<Value, String> {
    state
        .miniapp_manager
        .get_draft_storage(&request.app_id, &request.draft_id, &request.key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_miniapp_draft_storage(
    state: State<'_, AppState>,
    request: MiniAppDraftStorageSetRequest,
) -> Result<(), String> {
    state
        .miniapp_manager
        .set_draft_storage(
            &request.app_id,
            &request.draft_id,
            &request.key,
            request.value,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_draft_worker_call(
    state: State<'_, AppState>,
    request: MiniAppDraftWorkerCallRequest,
) -> Result<Value, String> {
    if state
        .miniapp_manager
        .uses_market_strict_runtime(&request.app_id)
        .await
    {
        return Err("Marketplace MiniApp drafts cannot start a Node/Bun worker.".to_string());
    }
    let pool = state
        .js_worker_pool
        .as_ref()
        .ok_or_else(|| "JS Worker pool not initialized".to_string())?;
    let draft = state
        .miniapp_manager
        .get_draft(&request.app_id, &request.draft_id)
        .await
        .map_err(|e| e.to_string())?;
    if state
        .miniapp_manager
        .uses_market_strict_runtime(&request.app_id)
        .await
    {
        validate_market_host_call(&request.method, &request.params)?;
    }
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let policy = state
        .miniapp_manager
        .resolve_policy_for_draft(
            &request.app_id,
            &request.draft_id,
            &draft.app.permissions,
            workspace_root.as_deref(),
        )
        .await;
    let policy_json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    let worker_revision = state
        .miniapp_manager
        .build_worker_revision(&draft.app, &policy_json);
    let worker_key = draft_worker_key(&request.app_id, &request.draft_id);
    let draft_dir = state
        .miniapp_manager
        .draft_dir(&request.app_id, &request.draft_id);
    let needs_install = !draft.app.source.npm_dependencies.is_empty()
        && !pool.has_installed_deps_in_dir(&draft_dir);
    if needs_install {
        let install = pool
            .install_deps_in_dir(&draft_dir, &draft.app.source.npm_dependencies)
            .await
            .map_err(|e| e.to_string())?;
        if !install.success {
            let details = if !install.stderr.trim().is_empty() {
                install.stderr
            } else {
                install.stdout
            };
            return Err(format!(
                "MiniApp draft dependencies install failed for {}/{}: {}",
                request.app_id,
                request.draft_id,
                details.trim()
            ));
        }
        pool.stop(&worker_key).await;
    }
    pool.call_with_app_dir(
        &worker_key,
        &request.app_id,
        &draft_dir,
        &worker_revision,
        &policy_json,
        draft.app.permissions.node.as_ref(),
        &request.method,
        request.params,
    )
    .await
    .map_err(|e| e.to_string())
}

fn validate_market_host_call(method: &str, params: &Value) -> Result<(), String> {
    if method != "shell.exec" {
        return Ok(());
    }
    if params
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| !command.trim().is_empty())
    {
        return Err(
            "Marketplace MiniApps must use shell.exec args and cannot execute command strings."
                .to_string(),
        );
    }
    let args = params
        .get("args")
        .and_then(Value::as_array)
        .filter(|args| !args.is_empty())
        .ok_or_else(|| {
            "Marketplace MiniApps must use a non-empty shell.exec args array.".to_string()
        })?;
    if args.iter().any(|value| value.as_str().is_none()) {
        return Err("Marketplace shell.exec args must all be strings.".to_string());
    }
    let program = args[0]
        .as_str()
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    if matches!(
        program.as_str(),
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "python"
            | "python3"
            | "node"
            | "bun"
            | "deno"
            | "ruby"
            | "perl"
    ) {
        return Err(
            "Shells and general-purpose interpreters are forbidden for marketplace MiniApps."
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn miniapp_draft_host_call(
    state: State<'_, AppState>,
    request: MiniAppDraftHostCallRequest,
) -> Result<Value, String> {
    if !is_host_primitive(&request.method) {
        return Err(format!(
            "method '{}' is not a host primitive (only fs.*/shell.*/os.*/net.* are supported)",
            request.method
        ));
    }
    let draft = state
        .miniapp_manager
        .get_draft(&request.app_id, &request.draft_id)
        .await
        .map_err(|e| e.to_string())?;
    let workspace_root = workspace_root_from_input(request.workspace_path.as_deref());
    let app_data_dir = state
        .miniapp_manager
        .draft_dir(&request.app_id, &request.draft_id);
    let granted = state
        .miniapp_manager
        .granted_paths_for_app(&request.app_id)
        .await;
    dispatch_host(
        &draft.app.permissions,
        &request.app_id,
        &app_data_dir,
        workspace_root.as_deref(),
        &granted,
        &request.method,
        request.params,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_draft_worker_stop(
    state: State<'_, AppState>,
    request: MiniAppDraftRequest,
) -> Result<(), String> {
    if let Some(ref pool) = state.js_worker_pool {
        pool.stop(&draft_worker_key(&request.app_id, &request.draft_id))
            .await;
    }
    emit_miniapp_event(
        "miniapp-worker-stopped",
        json!({
            "id": request.app_id,
            "draftId": request.draft_id,
            "reason": "draft-manual-stop",
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn miniapp_get_customization_metadata(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<Option<MiniAppCustomizationMetadata>, String> {
    state
        .miniapp_manager
        .load_customization_metadata(&app_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn miniapp_decline_builtin_update(
    state: State<'_, AppState>,
    request: MiniAppDeclineBuiltinUpdateRequest,
) -> Result<Option<MiniAppCustomizationMetadata>, String> {
    state
        .miniapp_manager
        .decline_builtin_update(
            &request.app_id,
            request.builtin_version,
            &request.source_hash,
            now_ms() as i64,
        )
        .await
        .map_err(|e| e.to_string())
}

// ============== AI commands ==============

/// Active AI stream cancellation flags: (app_id, stream_id) → cancel flag.
static AI_STREAM_REGISTRY: OnceLock<Mutex<HashMap<(String, String), Arc<AtomicBool>>>> =
    OnceLock::new();

/// Per-app rate limiter state: app_id → (request_count, window_start_ms).
static AI_RATE_LIMITER: OnceLock<Mutex<MiniAppRateLimitState>> = OnceLock::new();

fn ai_stream_registry() -> &'static Mutex<HashMap<(String, String), Arc<AtomicBool>>> {
    AI_STREAM_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ai_rate_limiter() -> &'static Mutex<MiniAppRateLimitState> {
    AI_RATE_LIMITER.get_or_init(|| Mutex::new(MiniAppRateLimitState::default()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---- Request/Response DTOs for AI commands ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiCompleteRequest {
    pub app_id: String,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiCompleteResponse {
    pub text: String,
    pub usage: Option<MiniAppAiUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiChatRequest {
    pub app_id: String,
    pub messages: Vec<MiniAppAiChatMessage>,
    pub stream_id: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiChatStartedResponse {
    pub stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiCancelRequest {
    pub app_id: String,
    pub stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAiListModelsRequest {
    pub app_id: String,
}

fn build_messages_for_ai_plan(messages: Vec<MiniAppAiMessagePlan>) -> Vec<Message> {
    messages
        .into_iter()
        .map(|message| match message.role {
            MiniAppAiMessageRole::System => Message::system(message.content),
            MiniAppAiMessageRole::Assistant => Message::assistant(message.content),
            MiniAppAiMessageRole::User => Message::user(message.content),
        })
        .collect()
}

// ---- Commands ----

/// Non-streaming AI completion — waits for the full response before returning.
#[tauri::command]
pub async fn miniapp_ai_complete(
    state: State<'_, AppState>,
    request: MiniAppAiCompleteRequest,
) -> Result<MiniAppAiCompleteResponse, String> {
    let app = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;

    let ai_perms = require_enabled_ai_permissions(app.permissions.ai.as_ref())?;

    let rate_limit = ai_perms.rate_limit_per_minute.unwrap_or(0);
    ai_rate_limiter()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .check(
            &request.app_id,
            rate_limit,
            now_ms(),
            MiniAppRateLimitSubject::Ai,
        )?;

    let ai_plan = plan_ai_complete_request(
        ai_perms,
        request.model.as_deref(),
        request.system_prompt.as_deref(),
        &request.prompt,
    )?;

    let ai_client = state
        .ai_client_factory
        .get_client_resolved(&ai_plan.model_ref)
        .await
        .map_err(|e| format!("Failed to get AI client: {}", e))?;

    let messages = build_messages_for_ai_plan(ai_plan.messages);

    let stream_response = ai_client
        .send_message_stream(messages, None, None)
        .await
        .map_err(|e| format!("AI request failed: {}", e))?;

    let mut stream = stream_response.stream;
    let mut full_text = String::new();
    let mut usage: Option<MiniAppAiUsage> = None;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Some(text) = chunk.text {
                    full_text.push_str(&text);
                }
                if let Some(u) = chunk.usage {
                    usage = Some(MiniAppAiUsage {
                        prompt_tokens: u.prompt_token_count,
                        completion_tokens: u.candidates_token_count,
                        total_tokens: u.total_token_count,
                    });
                }
            }
            Err(e) => {
                return Err(format!("AI stream error: {}", e));
            }
        }
    }

    Ok(MiniAppAiCompleteResponse {
        text: full_text,
        usage,
    })
}

/// Streaming AI chat — returns immediately, emits chunks via "miniapp://ai-stream" events.
#[tauri::command]
pub async fn miniapp_ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request: MiniAppAiChatRequest,
) -> Result<MiniAppAiChatStartedResponse, String> {
    let stream_id = require_non_empty_stream_id(&request.stream_id)?;
    require_non_empty_ai_messages(request.messages.len())?;

    let miniapp = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;

    let ai_perms = require_enabled_ai_permissions(miniapp.permissions.ai.as_ref())?;

    let rate_limit = ai_perms.rate_limit_per_minute.unwrap_or(0);
    ai_rate_limiter()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .check(
            &request.app_id,
            rate_limit,
            now_ms(),
            MiniAppRateLimitSubject::Ai,
        )?;

    let ai_plan = plan_ai_chat_request(
        ai_perms,
        request.model.as_deref(),
        request.system_prompt.as_deref(),
        request
            .messages
            .iter()
            .map(|message| (message.role.as_str(), message.content.as_str())),
    )?;

    let ai_client = state
        .ai_client_factory
        .get_client_resolved(&ai_plan.model_ref)
        .await
        .map_err(|e| format!("Failed to get AI client: {}", e))?;

    let messages = build_messages_for_ai_plan(ai_plan.messages);

    let stream_response = ai_client
        .send_message_stream(messages, None, None)
        .await
        .map_err(|e| format!("AI request failed: {}", e))?;

    // Register a cancellation flag for this stream
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut registry = ai_stream_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        registry.insert(
            (request.app_id.clone(), stream_id.clone()),
            cancel_flag.clone(),
        );
    }

    let response_stream_id = stream_id.clone();
    let app_id = request.app_id.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let mut stream = stream_response.stream;
        let mut full_text = String::new();
        let mut last_usage: Option<MiniAppAiUsage> = None;

        while let Some(chunk_result) = stream.next().await {
            // Check cancellation
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }

            match chunk_result {
                Ok(chunk) => {
                    let has_text = chunk.text.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
                    let has_reasoning = chunk
                        .reasoning_content
                        .as_ref()
                        .map(|t| !t.is_empty())
                        .unwrap_or(false);

                    if has_text || has_reasoning {
                        if let Some(ref t) = chunk.text {
                            full_text.push_str(t);
                        }
                        let payload = ai_stream_chunk_payload(
                            &app_id,
                            &stream_id,
                            chunk.text,
                            chunk.reasoning_content,
                        );
                        if let Err(e) = app_handle.emit("miniapp://ai-stream", &payload) {
                            log::warn!("Failed to emit AI stream chunk: {}", e);
                        }
                    }

                    if let Some(u) = chunk.usage {
                        last_usage = Some(MiniAppAiUsage {
                            prompt_tokens: u.prompt_token_count,
                            completion_tokens: u.candidates_token_count,
                            total_tokens: u.total_token_count,
                        });
                    }

                    if let Some(ref reason) = chunk.finish_reason {
                        if !reason.is_empty() && reason != "null" {
                            break;
                        }
                    }
                }
                Err(e) => {
                    let payload = ai_stream_error_payload(&app_id, &stream_id, e.to_string());
                    let _ = app_handle.emit("miniapp://ai-stream", &payload);
                    // Clean up registry
                    let mut registry = ai_stream_registry()
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    registry.remove(&(app_id.clone(), stream_id.clone()));
                    return;
                }
            }
        }

        // Emit done
        let done_payload = ai_stream_done_payload(&app_id, &stream_id, full_text, last_usage);
        let _ = app_handle.emit("miniapp://ai-stream", &done_payload);

        // Clean up registry
        let mut registry = ai_stream_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        registry.remove(&(app_id.clone(), stream_id.clone()));
    });

    Ok(MiniAppAiChatStartedResponse {
        stream_id: response_stream_id,
    })
}

/// Explicit instance shutdown also owns streams whose presentation was closed.
pub(crate) fn cancel_miniapp_streams(app_id: &str) {
    ai_stream_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|(owner, _), flag| {
            if owner == app_id {
                flag.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
}

/// Cancel an ongoing AI stream.
#[tauri::command]
pub async fn miniapp_ai_cancel(
    _state: State<'_, AppState>,
    request: MiniAppAiCancelRequest,
) -> Result<(), String> {
    let mut registry = ai_stream_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(flag) = registry.get(&(request.app_id.clone(), request.stream_id.clone())) {
        flag.store(true, Ordering::SeqCst);
    }
    // Remove from registry so it gets GC'd
    registry.remove(&(request.app_id, request.stream_id));
    Ok(())
}

/// List AI models available to a MiniApp (no sensitive fields).
#[tauri::command]
pub async fn miniapp_ai_list_models(
    state: State<'_, AppState>,
    request: MiniAppAiListModelsRequest,
) -> Result<Vec<MiniAppAiModelInfo>, String> {
    let miniapp = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|e| e.to_string())?;

    let ai_perms = require_enabled_ai_permissions(miniapp.permissions.ai.as_ref())?;

    let global_config = state
        .config_service
        .get_config::<GlobalConfig>(None)
        .await
        .map_err(|e| e.to_string())?;

    let primary_id = global_config
        .ai
        .resolve_model_selection("primary")
        .unwrap_or_default();
    let fast_id = global_config
        .ai
        .resolve_model_selection("fast")
        .unwrap_or_default();

    let models = available_models_for_permissions(
        global_config
            .ai
            .models
            .iter()
            .map(|model| MiniAppAiModelDescriptor {
                id: model.id.clone(),
                name: model.name.clone(),
                model_name: model.model_name.clone(),
                provider: model.provider.clone(),
                enabled: model.enabled,
                supports_text_chat: model.capabilities.iter().any(|capability| {
                    matches!(
                        capability,
                        openbitfun_core::service::config::types::ModelCapability::TextChat
                    )
                }),
            }),
        ai_perms.allowed_models.as_deref().unwrap_or(&[]),
        &primary_id,
        &fast_id,
    );

    Ok(models)
}

#[cfg(test)]
mod miniapp_desktop_stream_tests {
    use super::*;
    #[test]
    fn stopping_one_instance_cancels_its_streams_without_touching_another_app() {
        let own = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        let a = Arc::new(AtomicBool::new(false));
        let b = Arc::new(AtomicBool::new(false));
        {
            let mut registry = ai_stream_registry().lock().unwrap();
            registry.insert((own.clone(), "same-id".into()), a.clone());
            registry.insert((other.clone(), "same-id".into()), b.clone());
        }
        cancel_miniapp_streams(&own);
        assert!(a.load(Ordering::SeqCst));
        assert!(!b.load(Ordering::SeqCst));
        assert!(ai_stream_registry()
            .lock()
            .unwrap()
            .contains_key(&(other.clone(), "same-id".into())));
        cancel_miniapp_streams(&other);
    }
}
