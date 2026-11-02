//! Skill discovery HostInvoke handlers.
//!
//! Discovery is owned by the Core `SkillRegistry`; this adapter only resolves
//! the workspace the controller selected and picks its local or SSH provider.
//! Installed-source markers are SkillHub market metadata, and the CLI host has
//! no market surface, so reports leave `installationSource` unset.

use std::time::Duration;

use openbitfun_core::agentic::tools::implementations::skills::mode_overrides::SkillPolicyWorkspace;
use openbitfun_core::agentic::tools::implementations::skills::{SkillRegistry, SkillScanReport};
use openbitfun_core::agentic::workspace::RemoteWorkspaceFs;
use openbitfun_core::service::workspace::{get_global_workspace_service, WorkspaceInfo};
use serde::Serialize;
use serde_json::Value;

use crate::peer_host::args::{get_string, optional_bool, optional_string, request_value};

const REMOTE_SKILL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

async fn resolve_workspace(request: &Value) -> Result<Option<WorkspaceInfo>, String> {
    let id = optional_string(request, "workspaceId");
    let legacy_path = optional_string(request, "workspacePath");
    if id.is_none() && legacy_path.is_none() {
        return Ok(None);
    }
    let service = get_global_workspace_service().ok_or("Workspace service is unavailable")?;
    if let Some(id) = id {
        return service
            .require_workspace(&id)
            .await
            .map(Some)
            .map_err(|error| error.to_string());
    }
    // Pre-ID controllers still send a path; normal callers select a catalog ID.
    service
        .resolve_legacy_workspace_reference(
            None,
            legacy_path.as_deref().unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())?
        .map(Some)
        .ok_or_else(|| "Legacy Skill workspace cannot be resolved".to_string())
}

async fn remote_workspace_fs(
    workspace: Option<&WorkspaceInfo>,
) -> Result<Option<(String, RemoteWorkspaceFs)>, String> {
    let Some(record) = workspace else {
        return Ok(None);
    };
    let Some(connection) = record.filesystem_connection_id()? else {
        return Ok(None);
    };
    let connection = connection.to_owned();
    let services =
        openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
            .await?;
    let file_service = services
        .get_file_service()
        .await
        .ok_or("Remote file service is unavailable")?;
    Ok(Some((
        record.root_path.to_string_lossy().into_owned(),
        RemoteWorkspaceFs::new(connection, file_service),
    )))
}

async fn within_remote_deadline<T>(
    discovery: impl std::future::Future<Output = T>,
) -> Result<T, String> {
    tokio::time::timeout(REMOTE_SKILL_DISCOVERY_TIMEOUT, discovery)
        .await
        .map_err(|_| {
            format!(
                "Remote Skill discovery timed out after {} seconds. Check the SSH/SFTP connection and retry.",
                REMOTE_SKILL_DISCOVERY_TIMEOUT.as_secs()
            )
        })
}

/// Older controllers expect a bare array unless they asked for diagnostics.
fn scan_response<T: Serialize>(
    report: SkillScanReport<T>,
    include_diagnostics: bool,
) -> Result<Value, String> {
    let value = if include_diagnostics {
        serde_json::to_value(report)
    } else {
        serde_json::to_value(report.skills)
    };
    value.map_err(|error| format!("Failed to serialize skill configs: {error}"))
}

pub(crate) async fn get_skill_configs(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_workspace(request).await?;
    let registry = SkillRegistry::global();
    if optional_bool(request, "forceRefresh").unwrap_or(false) {
        registry.refresh().await;
    }
    let report = if let Some((root, fs)) = remote_workspace_fs(workspace.as_ref()).await? {
        within_remote_deadline(registry.get_skill_scan_report_for_remote_workspace(&fs, &root))
            .await?
    } else {
        let root = workspace.as_ref().map(|record| record.root_path.as_path());
        registry.get_skill_scan_report_for_workspace(root).await
    };
    let mut response = scan_response(
        report,
        optional_bool(request, "includeDiagnostics").unwrap_or(false),
    )?;
    if let Some(object) = response.as_object_mut() {
        // The import operations are not peer commands on this host; version 0
        // tells the controller not to offer them.
        object.insert("importOperationsVersion".into(), Value::from(0));
    }
    Ok(response)
}

pub(crate) async fn get_mode_skill_configs(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let mode_id = get_string(request, "modeId")?;
    let workspace = resolve_workspace(request).await?;
    let registry = SkillRegistry::global();
    if optional_bool(request, "forceRefresh").unwrap_or(false) {
        registry.refresh().await;
    }
    let report = if let Some((root, fs)) = remote_workspace_fs(workspace.as_ref()).await? {
        within_remote_deadline(
            registry.get_mode_skill_scan_report_for_remote_workspace(&fs, &root, &mode_id),
        )
        .await?
    } else {
        registry
            .get_mode_skill_scan_report_for_workspace(
                workspace.as_ref().map(SkillPolicyWorkspace::from_record),
                &mode_id,
            )
            .await
    };
    scan_response(
        report,
        optional_bool(request, "includeDiagnostics").unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn mode_skill_configs_require_a_mode() {
        let error = get_mode_skill_configs(&json!({})).await.unwrap_err();
        assert!(error.contains("modeId"), "{error}");
    }

    #[tokio::test]
    async fn no_workspace_reference_needs_no_workspace_service() {
        assert!(resolve_workspace(&json!({})).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_host_invoke_without_a_workspace_lists_host_level_skills() {
        let bare = get_skill_configs(&json!({})).await.unwrap();
        assert!(bare.is_array(), "legacy controllers read an array");
        let report = get_skill_configs(&json!({ "includeDiagnostics": true }))
            .await
            .unwrap();
        assert!(report["skills"].is_array());
        assert_eq!(report["importOperationsVersion"], 0);
    }
}
