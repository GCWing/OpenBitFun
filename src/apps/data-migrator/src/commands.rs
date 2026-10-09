use crate::app_state::{CommandError, DiagnosticsExportView, MigratorCoordinator, MigratorView};
use openbitfun_legacy_migration::MigrationRoots;
use openbitfun_product_domains::legacy_migration::MigrationSelection;
use serde::Deserialize;
use tauri::{AppHandle, State};

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
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> Result<MigratorView, CommandError> {
    let _ = request;
    state.preview_reset()
}

#[tauri::command]
pub(crate) fn reset_openbitfun_data(
    state: State<'_, MigratorCoordinator>,
    request: ResetRequest,
) -> Result<MigratorView, CommandError> {
    state.start_reset(request.confirmation_id, request.confirmation)
}

#[tauri::command]
pub(crate) fn set_migration_locations(
    state: State<'_, MigratorCoordinator>,
    request: LocationsRequest,
) -> Result<MigratorView, CommandError> {
    state.set_locations(request.locations)
}

#[tauri::command]
pub(crate) fn new_migration_task(
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> Result<MigratorView, CommandError> {
    let _ = request;
    state.new_task()
}

#[tauri::command]
pub(crate) fn resume_migration_task(
    state: State<'_, MigratorCoordinator>,
    request: ResumeRequest,
) -> Result<MigratorView, CommandError> {
    state.resume_task(&request.run_id)
}

#[tauri::command]
pub(crate) fn get_migrator_bootstrap(
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> MigratorView {
    let _ = request;
    state.snapshot()
}

#[tauri::command]
pub(crate) fn scan_legacy_migration(
    state: State<'_, MigratorCoordinator>,
    request: SelectionRequest,
) -> Result<MigratorView, CommandError> {
    state.scan(request.selection)
}

#[tauri::command]
pub(crate) fn prepare_legacy_migration(
    state: State<'_, MigratorCoordinator>,
    request: SelectionRequest,
) -> Result<MigratorView, CommandError> {
    state.prepare(request.selection)
}

#[tauri::command]
pub(crate) fn retry_writer_check(
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> Result<MigratorView, CommandError> {
    let _ = request;
    state.refresh_blockers()
}

#[tauri::command]
pub(crate) fn start_legacy_migration(
    state: State<'_, MigratorCoordinator>,
    request: ExecuteRequest,
) -> Result<MigratorView, CommandError> {
    state.start(request.plan_hash)
}

#[tauri::command]
pub(crate) fn cancel_legacy_migration(
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> MigratorView {
    let _ = request;
    state.cancel()
}

#[tauri::command]
pub(crate) fn export_migration_diagnostics(
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> Result<DiagnosticsExportView, CommandError> {
    let _ = request;
    state.export_diagnostics()
}

#[tauri::command]
pub(crate) fn finish_legacy_migration(
    app: AppHandle,
    state: State<'_, MigratorCoordinator>,
    request: EmptyRequest,
) -> Result<(), CommandError> {
    let _ = request;
    state.finish()?;
    app.exit(0);
    Ok(())
}
