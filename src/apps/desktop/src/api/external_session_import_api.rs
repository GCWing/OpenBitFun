use openbitfun_core::external_session_import::{
    list_removed_external_sessions as list_removed,
    restore_removed_external_session as restore_removed,
};
use openbitfun_product_domains::external_sources::ExternalSourceOperationResult;
use openbitfun_product_domains::session_import::{
    RemovedExternalSession, RestoreRemovedExternalSessionRequest,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRemovedExternalSessionsRequest {
    pub ecosystem_id: String,
}

#[tauri::command]
pub async fn list_removed_external_sessions(
    request: ListRemovedExternalSessionsRequest,
) -> ExternalSourceOperationResult<Vec<RemovedExternalSession>> {
    list_removed(&request.ecosystem_id).await
}

#[tauri::command]
pub async fn restore_removed_external_session(
    request: RestoreRemovedExternalSessionRequest,
) -> ExternalSourceOperationResult<()> {
    restore_removed(request).await
}
