//! Prepare host-owned MiniApp Agent workspaces before session creation/restore.

use std::path::Path;

use super::agent_bridge::{plan_agent_workspace, MiniAppAgentWorkspacePlan};
use crate::service::workspace::WorkspaceService;

pub async fn prepare_agent_workspace(
    workspace_service: &WorkspaceService,
    explicit_workspace_path: Option<&str>,
    app_data_workspace: Option<&str>,
    app_data_dir: &Path,
) -> Result<MiniAppAgentWorkspacePlan, String> {
    let plan = plan_agent_workspace(explicit_workspace_path, app_data_workspace, app_data_dir)?;
    if plan.create_if_missing {
        tokio::fs::create_dir_all(&plan.path)
            .await
            .map_err(|e| format!("Failed to create MiniApp agent workspace: {e}"))?;
        // Appdata topics predate workspace IDs and were never opened in the
        // workspace catalog. Register their host-owned directory before either
        // creating a session or restoring its legacy path-only config. Keep
        // the original session/history and the user's desktop selection.
        // Explicit workspace operands do not establish local ownership and
        // must continue through the existing workspace/remote admission path.
        workspace_service
            .register_local_workspace_record(plan.path.clone())
            .await
            .map_err(|e| format!("Failed to register MiniApp agent workspace: {e}"))?;
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::SessionConfig;
    use crate::service::workspace::legacy_compat::upgrade_session_workspace_reference;

    #[tokio::test]
    async fn appdata_registration_upgrades_legacy_sessions_without_changing_selection() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().join("user")).await;
        let project = root.path().join("project");
        tokio::fs::create_dir_all(&project).await.unwrap();
        let opened = service.open_workspace(project).await.unwrap();
        let appdata = root.path().join("miniapps/legacy-app");
        let chat = appdata.join("chat");
        tokio::fs::create_dir_all(&chat).await.unwrap();
        let chat = dunce::canonicalize(chat).unwrap();
        let legacy_payload = serde_json::json!({
            "max_context_tokens": 128000,
            "auto_compact": true,
            "enable_tools": true,
            "safe_mode": true,
            "max_turns": 100,
            "enable_context_compression": true,
            "workspace_path": chat,
            "model_id": "saved-model",
        });
        let mut config: SessionConfig = serde_json::from_value(legacy_payload.clone()).unwrap();
        let error = upgrade_session_workspace_reference(&mut config, &service)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Legacy session workspace is unavailable"));

        let plan = prepare_agent_workspace(&service, None, Some("chat"), &appdata)
            .await
            .unwrap();
        upgrade_session_workspace_reference(&mut config, &service)
            .await
            .unwrap();
        let id = config.workspace_id.clone().unwrap();
        assert_eq!(config.project_workspace_id.as_deref(), Some(id.as_str()));
        assert_eq!(config.workspace_path.as_deref(), chat.to_str());
        assert_eq!(config.model_id.as_deref(), Some("saved-model"));
        assert_eq!(dunce::canonicalize(plan.path).unwrap(), chat);

        // Old readers still receive the original path and model; the additive
        // IDs survive a persisted-config round trip for upgraded readers.
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(saved["workspace_path"], legacy_payload["workspace_path"]);
        assert_eq!(saved["model_id"], legacy_payload["model_id"]);
        let mut restored: SessionConfig = serde_json::from_value(saved).unwrap();
        prepare_agent_workspace(&service, None, Some("chat"), &appdata)
            .await
            .unwrap();
        upgrade_session_workspace_reference(&mut restored, &service)
            .await
            .unwrap();
        assert_eq!(restored.workspace_id.as_deref(), Some(id.as_str()));

        assert_eq!(service.get_current_workspace().await.unwrap().id, opened.id);
        assert_eq!(service.get_opened_workspaces().await.len(), 1);
        assert!(service
            .get_recent_workspaces()
            .await
            .iter()
            .all(|w| w.id != id));
    }

    #[tokio::test]
    async fn new_appdata_topics_are_registered_but_explicit_operands_are_not() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().join("user")).await;
        let appdata = root.path().join("miniapps/app");
        let plan = prepare_agent_workspace(
            &service,
            Some("/remote/project"),
            Some("topics/new"),
            &appdata,
        )
        .await
        .unwrap();
        assert!(plan.path.is_dir());
        let records = service.list_workspace_infos().await;
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].root_path,
            dunce::canonicalize(&plan.path).unwrap()
        );
        assert!(service.get_opened_workspaces().await.is_empty());
        assert!(service.get_recent_workspaces().await.is_empty());
        assert!(service.get_current_workspace().await.is_none());

        // A remote POSIX operand (or an unknown local folder) must not be
        // registered locally just because a MiniApp supplied its path.
        let explicit = prepare_agent_workspace(&service, Some("/remote/project"), None, &appdata)
            .await
            .unwrap();
        assert!(!explicit.create_if_missing);
        assert_eq!(service.list_workspace_infos().await.len(), 1);
        assert!(
            prepare_agent_workspace(&service, None, Some("../outside"), &appdata)
                .await
                .is_err()
        );
        assert!(!appdata.join("../outside").exists());
        assert_eq!(service.list_workspace_infos().await.len(), 1);
    }
}
