//! Scheduled jobs API.

use log::{debug, error};
use openbitfun_core::service::cron::{
    get_global_cron_service, CreateCronJobRequest, CronJob, CronJobTargetKind, UpdateCronJobRequest,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCronJobsRequest {
    pub workspace_path: Option<String>,
    pub workspace_id: Option<String>,
    pub remote_connection_id: Option<String>,
    pub session_id: Option<String>,
    pub target_kind: Option<CronJobTargetKind>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCronJobCommandRequest {
    pub job_id: String,
    #[serde(flatten)]
    pub changes: UpdateCronJobRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCronJobRequest {
    pub job_id: String,
}

fn cron_service() -> Result<std::sync::Arc<openbitfun_core::service::cron::CronService>, String> {
    get_global_cron_service().ok_or_else(|| "Cron service is not initialized".to_string())
}

#[tauri::command]
pub async fn list_cron_jobs(request: ListCronJobsRequest) -> Result<Vec<CronJob>, String> {
    debug!(
        "Listing scheduled jobs: workspace_path={:?}, workspace_id={:?}, remote_connection_id={:?}, session_id={:?}, target_kind={:?}",
        request.workspace_path,
        request.workspace_id,
        request.remote_connection_id,
        request.session_id,
        request.target_kind
    );

    let service = cron_service()?;
    // Legacy wire ingress only. Filtering below has no path-based API.
    let workspace_id = if request.workspace_id.is_some()
        || request.workspace_path.is_some()
        || request.remote_connection_id.is_some()
    {
        let workspaces = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service is unavailable".to_string())?;
        Some(
            workspaces
                .resolve_legacy_workspace_reference(
                    request.workspace_id.as_deref(),
                    request.workspace_path.as_deref().unwrap_or_default(),
                    request.remote_connection_id.as_deref(),
                    None,
                )
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Scheduled job workspace is unavailable".to_string())?
                .id,
        )
    } else {
        None
    };
    Ok(service
        .list_jobs_filtered(
            workspace_id.as_deref(),
            request.session_id.as_deref(),
            request.target_kind,
        )
        .await)
}

#[tauri::command]
pub async fn create_cron_job(request: CreateCronJobRequest) -> Result<CronJob, String> {
    debug!(
        "Creating scheduled job: name={}, target={:?}",
        request.name, request.target
    );

    let service = cron_service()?;
    service.create_job(request).await.map_err(|error| {
        error!("Failed to create scheduled job: {}", error);
        format!("Failed to create scheduled job: {}", error)
    })
}

#[tauri::command]
pub async fn update_cron_job(request: UpdateCronJobCommandRequest) -> Result<CronJob, String> {
    debug!("Updating scheduled job: job_id={}", request.job_id);

    let service = cron_service()?;
    service
        .update_job(&request.job_id, request.changes)
        .await
        .map_err(|error| {
            error!(
                "Failed to update scheduled job {}: {}",
                request.job_id, error
            );
            format!("Failed to update scheduled job: {}", error)
        })
}

#[tauri::command]
pub async fn delete_cron_job(request: DeleteCronJobRequest) -> Result<bool, String> {
    debug!("Deleting scheduled job: job_id={}", request.job_id);

    let service = cron_service()?;
    service.delete_job(&request.job_id).await.map_err(|error| {
        error!(
            "Failed to delete scheduled job {}: {}",
            request.job_id, error
        );
        format!("Failed to delete scheduled job: {}", error)
    })
}

#[tauri::command]
pub async fn notify_cron_host_ready() -> Result<(), String> {
    debug!("Received scheduled job host ready signal");

    let service = cron_service()?;
    // `start` is idempotent, so the frontend readiness signal can safely race
    // with the desktop fallback timer.
    service.start();
    Ok(())
}
