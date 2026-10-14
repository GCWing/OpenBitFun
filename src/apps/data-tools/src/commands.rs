use crate::app_state::{CommandError, DataToolsCoordinator, DataToolsView, DiagnosticsExportView};
use openbitfun_legacy_migration::MigrationRoots;
use openbitfun_product_domains::legacy_migration::MigrationSelection;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RepairScanRequest {
    pub home: PathBuf,
    pub user_root: PathBuf,
}

#[tauri::command]
pub(crate) fn scan_session_repair(
    state: State<'_, DataToolsCoordinator>,
    request: RepairScanRequest,
) -> Result<DataToolsView, CommandError> {
    state.scan_repair(request.home, request.user_root)
}
#[tauri::command]
pub(crate) fn load_session_repair(
    state: State<'_, DataToolsCoordinator>,
    request: ResumeRequest,
) -> Result<DataToolsView, CommandError> {
    state.load_repair(&request.run_id)
}
#[tauri::command]
pub(crate) fn start_session_repair(
    state: State<'_, DataToolsCoordinator>,
    request: ResumeRequest,
) -> Result<DataToolsView, CommandError> {
    state.execute_repair(&request.run_id, false)
}
#[tauri::command]
pub(crate) fn rollback_session_repair(
    state: State<'_, DataToolsCoordinator>,
    request: ResumeRequest,
) -> Result<DataToolsView, CommandError> {
    state.execute_repair(&request.run_id, true)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct EmptyRequest {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SelectionRequest {
    pub selection: MigrationSelection,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ExecuteRequest {
    pub plan_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LocationsRequest {
    pub locations: MigrationRoots,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ResumeRequest {
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ResetRequest {
    pub confirmation_id: String,
    pub confirmation: String,
}

#[tauri::command]
pub(crate) fn preview_openbitfun_reset(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> Result<DataToolsView, CommandError> {
    let _ = request;
    state.preview_reset()
}

#[tauri::command]
pub(crate) fn reset_openbitfun_data(
    state: State<'_, DataToolsCoordinator>,
    request: ResetRequest,
) -> Result<DataToolsView, CommandError> {
    state.start_reset(request.confirmation_id, request.confirmation)
}

#[tauri::command]
pub(crate) fn set_data_tools_locations(
    state: State<'_, DataToolsCoordinator>,
    request: LocationsRequest,
) -> Result<DataToolsView, CommandError> {
    state.set_locations(request.locations)
}

#[tauri::command]
pub(crate) fn new_migration_task(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> Result<DataToolsView, CommandError> {
    let _ = request;
    state.new_task()
}

#[tauri::command]
pub(crate) fn resume_migration_task(
    state: State<'_, DataToolsCoordinator>,
    request: ResumeRequest,
) -> Result<DataToolsView, CommandError> {
    state.resume_task(&request.run_id)
}

#[tauri::command]
pub(crate) fn get_data_tools_bootstrap(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> DataToolsView {
    let _ = request;
    state.snapshot()
}

#[tauri::command]
pub(crate) fn scan_legacy_migration(
    state: State<'_, DataToolsCoordinator>,
    request: SelectionRequest,
) -> Result<DataToolsView, CommandError> {
    state.scan(request.selection)
}

#[tauri::command]
pub(crate) fn prepare_legacy_migration(
    state: State<'_, DataToolsCoordinator>,
    request: SelectionRequest,
) -> Result<DataToolsView, CommandError> {
    state.prepare(request.selection)
}

#[tauri::command]
pub(crate) fn retry_writer_check(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> Result<DataToolsView, CommandError> {
    let _ = request;
    state.refresh_blockers()
}

#[tauri::command]
pub(crate) fn start_legacy_migration(
    state: State<'_, DataToolsCoordinator>,
    request: ExecuteRequest,
) -> Result<DataToolsView, CommandError> {
    state.start(request.plan_hash)
}

#[tauri::command]
pub(crate) fn cancel_data_tools_operation(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> DataToolsView {
    let _ = request;
    state.cancel()
}

#[tauri::command]
pub(crate) fn export_migration_diagnostics(
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> Result<DiagnosticsExportView, CommandError> {
    let _ = request;
    state.export_diagnostics()
}

#[tauri::command]
pub(crate) fn finish_data_tools(
    app: AppHandle,
    state: State<'_, DataToolsCoordinator>,
    request: EmptyRequest,
) -> Result<(), CommandError> {
    let _ = request;
    state.finish()?;
    app.exit(0);
    Ok(())
}
