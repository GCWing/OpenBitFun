//! Desktop transport for the runtime-free external Hook catalog.

use openbitfun_core::external_hooks::{
    local_external_hook_catalog_snapshot, ExternalHookCatalogSnapshotV1,
};
use openbitfun_core::external_sources::ExternalSourceOperationResult;
use openbitfun_product_domains::external_hook_import::{
    ExternalHookImportApplyRequestV1, ExternalHookImportApplyResultV1,
    ExternalHookImportMutationRequestV1, ExternalHookImportPlanV1, ExternalHookImportSnapshotV1,
};
use openbitfun_product_domains::external_sources::SourceKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookCatalogRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference from pre-ID clients.
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub force_refresh: bool,
}

pub type ExternalHookCatalogResponse = ExternalHookCatalogSnapshotV1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookImportSnapshotRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference from pre-ID clients.
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub refresh_updates: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanExternalHookImportRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference from pre-ID clients.
    pub workspace_path: Option<String>,
    pub source: SourceKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyExternalHookImportRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference from pre-ID clients.
    pub workspace_path: Option<String>,
    pub import_request: ExternalHookImportApplyRequestV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutateExternalHookImportRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference from pre-ID clients.
    pub workspace_path: Option<String>,
    pub mutation: ExternalHookImportMutationRequestV1,
}

#[tauri::command]
pub async fn get_external_hook_catalog(
    request: ExternalHookCatalogRequest,
) -> ExternalSourceOperationResult<ExternalHookCatalogResponse> {
    let workspace_id = super::external_sources_api::require_local_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace = workspace_id.as_deref();
    local_external_hook_catalog_snapshot(workspace, request.force_refresh).await
}

#[tauri::command]
pub async fn get_external_hook_import_snapshot(
    request: ExternalHookImportSnapshotRequest,
) -> ExternalSourceOperationResult<ExternalHookImportSnapshotV1> {
    let workspace_id = super::external_sources_api::require_local_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace = workspace_id.as_deref();
    openbitfun_core::external_hook_import::external_hook_import_snapshot(
        workspace,
        request.refresh_updates,
    )
    .await
}

#[tauri::command]
pub async fn plan_external_hook_import_command(
    request: PlanExternalHookImportRequest,
) -> ExternalSourceOperationResult<ExternalHookImportPlanV1> {
    let workspace_id = super::external_sources_api::require_local_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace = workspace_id.as_deref();
    openbitfun_core::external_hook_import::plan_external_hook_import(workspace, request.source)
        .await
}

#[tauri::command]
pub async fn apply_external_hook_import_command(
    request: ApplyExternalHookImportRequest,
) -> ExternalSourceOperationResult<ExternalHookImportApplyResultV1> {
    let workspace_id = super::external_sources_api::require_local_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace = workspace_id.as_deref();
    openbitfun_core::external_hook_import::apply_external_hook_import(
        workspace,
        request.import_request,
    )
    .await
}

#[tauri::command]
pub async fn mutate_external_hook_import_command(
    request: MutateExternalHookImportRequest,
) -> ExternalSourceOperationResult<ExternalHookImportSnapshotV1> {
    let workspace_id = super::external_sources_api::require_local_workspace(
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let workspace = workspace_id.as_deref();
    openbitfun_core::external_hook_import::mutate_external_hook_import(workspace, request.mutation)
        .await
}

#[cfg(test)]
mod tests {
    use super::{
        ApplyExternalHookImportRequest, ExternalHookCatalogRequest,
        ExternalHookImportSnapshotRequest, MutateExternalHookImportRequest,
        PlanExternalHookImportRequest,
    };

    #[test]
    fn request_uses_the_structured_camel_case_desktop_contract() {
        let request: ExternalHookCatalogRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "D:/workspace/project",
            "forceRefresh": true
        }))
        .unwrap();
        assert_eq!(
            request.workspace_path.as_deref(),
            Some("D:/workspace/project")
        );
        assert!(request.force_refresh);

        assert!(
            serde_json::from_value::<ExternalHookCatalogRequest>(serde_json::json!({
                "workspacePath": "D:/workspace/project",
                "forceRefresh": true,
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn import_requests_reject_unknown_fields_and_keep_core_requests_nested() {
        let snapshot: ExternalHookImportSnapshotRequest = serde_json::from_value(
            serde_json::json!({ "workspacePath": "D:/workspace/project", "refreshUpdates": true }),
        )
        .unwrap();
        assert!(snapshot.refresh_updates);

        let plan: PlanExternalHookImportRequest = serde_json::from_value(serde_json::json!({
            "workspacePath": "D:/workspace/project",
            "source": { "providerId": "codex.hooks", "sourceId": "user" }
        }))
        .unwrap();
        assert_eq!(plan.source.source_id.as_str(), "user");

        let apply = serde_json::json!({
            "workspacePath": "D:/workspace/project",
            "importRequest": {
                "schemaVersion": 1,
                "source": { "providerId": "codex.hooks", "sourceId": "user" },
                "planFingerprint": "sha256:abc"
            }
        });
        assert!(serde_json::from_value::<ApplyExternalHookImportRequest>(apply.clone()).is_ok());
        let mut invalid_apply = apply;
        invalid_apply["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ApplyExternalHookImportRequest>(invalid_apply).is_err());

        let mutation = serde_json::json!({
            "workspacePath": null,
            "mutation": {
                "schemaVersion": 1,
                "expectedRevision": "sha256:abc",
                "action": { "kind": "set_enabled", "importId": "hook-source", "enabled": false }
            }
        });
        assert!(serde_json::from_value::<MutateExternalHookImportRequest>(mutation).is_ok());
    }
}
