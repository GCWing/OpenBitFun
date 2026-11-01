//! Product-control orchestration over the existing MCP configuration/lifecycle owners.

use serde_json::{json, Map, Value};

use super::{ConfigLocation, MCPServerStatus, MCPService};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MCPControlOperation {
    List,
    Configure,
    Delete,
    Start,
    Stop,
    Restart,
}

pub fn operation(id: &str) -> Option<MCPControlOperation> {
    match id {
        "list" => Some(MCPControlOperation::List),
        "configure" => Some(MCPControlOperation::Configure),
        "delete" => Some(MCPControlOperation::Delete),
        "start" => Some(MCPControlOperation::Start),
        "stop" => Some(MCPControlOperation::Stop),
        "restart" => Some(MCPControlOperation::Restart),
        _ => None,
    }
}

impl MCPService {
    /// GUI JSON editing and Agent edits share persistence and runtime reconciliation.
    pub async fn save_json_config_and_reconcile(
        &self,
        json_config: &str,
        expected_fingerprint: &str,
    ) -> Result<(), String> {
        let _mutation = self.configuration_mutation.lock().await;
        let previous = self
            .config_service
            .load_all_configs()
            .await
            .map_err(|error| error.to_string())?;
        self.config_service
            .save_mcp_json_config(json_config, expected_fingerprint)
            .await
            .map_err(|error| error.to_string())?;
        // Keep the existing post-persistence acknowledgement intact on the
        // wire: older clients use it to retain the saved state without retrying.
        let saved_error =
            |error| format!("MCP config was saved, but runtime reconciliation failed: {error}");
        let current = self
            .config_service
            .load_all_configs()
            .await
            .map_err(saved_error)?;
        self.server_manager
            .reconcile_persisted_configs(previous, current)
            .await
            .map_err(saved_error)
    }

    pub async fn inspect_user_servers(&self) -> Result<Value, String> {
        let snapshot = self.config_service.user_control_snapshot().await
            .map_err(|_| "MCP user configuration is unreadable; it has been preserved. Inspect MCP settings before editing.".to_string())?;
        let statuses = self.server_manager.get_all_server_statuses().await;
        let effective = self
            .config_service
            .load_all_configs()
            .await
            .map_err(|_| "MCP effective configuration could not be read".to_string())?;
        let mut result = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
        for server in result["servers"]
            .as_array_mut()
            .expect("serialized snapshot")
        {
            let id = server["serverId"].as_str().expect("server id");
            let shadowed = effective
                .iter()
                .any(|config| config.id == id && config.location != ConfigLocation::User);
            let status = statuses
                .iter()
                .find(|(candidate, _)| candidate == id && !shadowed)
                .map(|(_, status)| *status)
                .unwrap_or(MCPServerStatus::Uninitialized);
            server["status"] = json!(status);
            server["shadowedByProject"] = json!(shadowed);
        }
        result["scope"] = json!("product-host-user");
        result["readBack"] = json!(true);
        Ok(result)
    }

    pub async fn execute_control(
        &self,
        operation: MCPControlOperation,
        arguments: Option<&Value>,
    ) -> Result<Value, String> {
        if operation == MCPControlOperation::List {
            return self.inspect_user_servers().await;
        }
        let arguments = arguments
            .and_then(Value::as_object)
            .ok_or_else(|| "MCP control requires an arguments object".to_string())?;
        let server_id = required_string(arguments, "serverId")?;
        let _mutation = self.configuration_mutation.lock().await;

        // Never manage external workspace-scoped servers through host controls.
        if !self
            .server_manager
            .server_available_for_context(server_id, None, false)
            .await
        {
            return Err("This MCP server is workspace-scoped and cannot be managed through product-host controls".into());
        }
        let effective = self.config_service.load_all_configs().await.map_err(|_| {
            "MCP effective configuration could not be read; no changes were made".to_string()
        })?;
        if effective
            .iter()
            .any(|config| config.id == server_id && config.location != ConfigLocation::User)
        {
            return Err("This MCP server ID is owned or overridden by project configuration; product-host user controls cannot modify it".into());
        }
        if matches!(
            operation,
            MCPControlOperation::Configure | MCPControlOperation::Delete
        ) {
            let fingerprint = required_string(arguments, "expectedFingerprint")?;
            let patch = if operation == MCPControlOperation::Configure {
                let mut patch = arguments
                    .get("config")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "config must be an object".to_string())?
                    .clone();
                if let Some(directory) = arguments.get("workingDirectory") {
                    patch.insert("workingDirectory".into(), directory.clone());
                }
                Some(patch)
            } else {
                None
            };
            let previous = effective;
            self.config_service
                .edit_user_server(fingerprint, server_id, patch.as_ref())
                .await
                .map_err(|error| match error {
                    openbitfun_services_integrations::mcp::config::MCPImportError::Store(_) => {
                        "MCP configuration could not be saved; inspect MCP settings".to_string()
                    }
                    _ => error.to_string(),
                })?;
            let runtime_result = match self.config_service.load_all_configs().await {
                Ok(current) => {
                    self.server_manager
                        .reconcile_persisted_configs(previous, current)
                        .await
                }
                Err(error) => Err(error),
            };
            // A failed handshake must not cause the Agent to repeat a committed
            // mutation, or be reported as a successful connection.
            let mut result = self.inspect_user_servers().await.unwrap_or_else(|_| json!({
                "readBack": false,
                "message": "Configuration was saved, but read-back failed. Do not repeat the mutation; inspect MCP settings."
            }));
            result["serverId"] = json!(server_id);
            result["configured"] = json!(true);
            result["runtimeReconciled"] = json!(runtime_result.is_ok());
            result["success"] = json!(runtime_result.is_ok() && result["readBack"] == true);
            if runtime_result.is_err() {
                result["message"] = json!("Configuration was saved, but runtime reconciliation failed. Do not repeat the configuration write. Inspect server status and MCP settings for connection or authorization recovery.");
            }
            return Ok(result);
        }

        let snapshot = self
            .config_service
            .user_control_snapshot()
            .await
            .map_err(|_| {
                "MCP user configuration is unreadable and has been preserved".to_string()
            })?;
        if !snapshot
            .servers
            .iter()
            .any(|server| server.server_id == server_id && server.config_valid)
        {
            return Err(
                "No valid user MCP server has that ID; list servers before controlling one".into(),
            );
        }
        let result = match operation {
            MCPControlOperation::Start => self.server_manager.start_server(server_id).await,
            MCPControlOperation::Stop => self.server_manager.stop_server(server_id).await,
            MCPControlOperation::Restart => self.server_manager.restart_server(server_id).await,
            _ => unreachable!("configuration operations handled above"),
        };
        let mut snapshot = self.inspect_user_servers().await?;
        snapshot["serverId"] = json!(server_id);
        snapshot["success"] = json!(result.is_ok());
        if result.is_err() {
            snapshot["message"] = json!("MCP lifecycle operation failed. Inspect the returned status and MCP settings; authorization may require user interaction. Configuration has been preserved.");
        }
        Ok(snapshot)
    }
}

fn required_string<'a>(arguments: &'a Map<String, Value>, field: &str) -> Result<&'a str, String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::PathManager;
    use crate::service::config::{ConfigManagerSettings, ConfigService};
    use std::sync::Arc;

    async fn fixture() -> (tempfile::TempDir, Arc<ConfigService>, MCPService) {
        let root = tempfile::tempdir().unwrap();
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    root.path().join("user"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let service = MCPService::new(config.clone()).unwrap();
        (root, config, service)
    }

    #[tokio::test]
    async fn mcp_control_gui_and_agent_share_saved_config_and_runtime() {
        let (_root, config, service) = fixture().await;
        let initial = service.inspect_user_servers().await.unwrap();
        service
            .save_json_config_and_reconcile(
                &json!({"mcpServers":{"docs":{"command":"unused-test-server", "autoStart":false,
                "env":{"TOKEN":"saved-secret"}, "futureOption":{"v":2}}}})
                .to_string(),
                initial["fingerprint"].as_str().unwrap(),
            )
            .await
            .unwrap();
        let listed = service
            .execute_control(MCPControlOperation::List, None)
            .await
            .unwrap();
        assert_eq!(listed["servers"][0]["serverId"], "docs");
        assert!(!listed.to_string().contains("saved-secret"));
        let result = service.execute_control(MCPControlOperation::Configure, Some(&json!({
            "serverId":"docs", "expectedFingerprint":listed["fingerprint"], "config":{"enabled":false}
        }))).await.unwrap();
        assert_eq!(result["configured"], true);
        assert_eq!(result["runtimeReconciled"], true);
        assert_eq!(result["servers"][0]["enabled"], false);
        config.reload().await.unwrap();
        let persisted: Value = config.get_config(Some("mcp_servers")).await.unwrap();
        assert_eq!(
            persisted["mcpServers"]["docs"]["env"]["TOKEN"],
            "saved-secret"
        );
        assert_eq!(
            persisted["mcpServers"]["docs"]["futureOption"],
            json!({"v":2})
        );
        assert_eq!(persisted["mcpServers"]["docs"]["enabled"], false);

        let stale = service
            .execute_control(
                MCPControlOperation::Delete,
                Some(&json!({
                    "serverId":"docs", "expectedFingerprint":listed["fingerprint"]
                })),
            )
            .await
            .unwrap_err();
        assert!(stale.contains("changed before write"));
        service
            .execute_control(
                MCPControlOperation::Delete,
                Some(&json!({
                    "serverId":"docs", "expectedFingerprint":result["fingerprint"]
                })),
            )
            .await
            .unwrap();
        assert!(service.inspect_user_servers().await.unwrap()["servers"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn mcp_control_gui_preserves_saved_but_runtime_failed_acknowledgement() {
        let (root, _config, service) = fixture().await;
        let initial = service.inspect_user_servers().await.unwrap();
        let error = service.save_json_config_and_reconcile(
            &json!({"mcpServers":{"broken":{"command":root.path().join("missing-command"), "autoStart":true}}}).to_string(),
            initial["fingerprint"].as_str().unwrap(),
        ).await.unwrap_err();
        assert!(error.starts_with("MCP config was saved, but runtime reconciliation failed:"));
        assert_eq!(
            service.inspect_user_servers().await.unwrap()["servers"][0]["serverId"],
            "broken"
        );
    }

    #[tokio::test]
    async fn mcp_control_saved_configuration_is_not_connection_success() {
        let (root, _config, service) = fixture().await;
        let snapshot = service.inspect_user_servers().await.unwrap();
        let missing = root.path().join("missing-mcp-command");
        let result = service
            .execute_control(
                MCPControlOperation::Configure,
                Some(&json!({
                    "serverId":"broken", "expectedFingerprint":snapshot["fingerprint"],
                    "config":{"command":missing, "args":["private-argument"], "autoStart":true}
                })),
            )
            .await
            .unwrap();
        assert_eq!(result["configured"], true);
        assert_eq!(result["runtimeReconciled"], false);
        assert_eq!(result["success"], false);
        assert!(!result.to_string().contains("private-argument"));
        assert!(!result.to_string().contains("missing-mcp-command"));
        assert_eq!(
            service.inspect_user_servers().await.unwrap()["servers"][0]["serverId"],
            "broken"
        );
    }

    #[tokio::test]
    async fn mcp_control_does_not_manage_workspace_scoped_or_unknown_servers() {
        let (_root, _config, service) = fixture().await;
        let external = serde_json::from_value(json!({
            "id":"external", "name":"External", "type":"local", "command":"unused-test-command",
            "location":"user", "autoStart":false
        }))
        .unwrap();
        service
            .server_manager
            .install_external_ephemeral_server(external, "another-workspace".into())
            .await
            .unwrap();
        let listed = service.inspect_user_servers().await.unwrap();
        assert!(listed["servers"].as_array().unwrap().is_empty());
        for operation in [
            MCPControlOperation::Start,
            MCPControlOperation::Stop,
            MCPControlOperation::Configure,
        ] {
            let error = service.execute_control(operation, Some(&json!({
                "serverId":"external", "expectedFingerprint":listed["fingerprint"], "config":{"enabled":false}
            }))).await.unwrap_err();
            assert!(error.contains("workspace-scoped"));
        }
        assert!(service
            .server_manager
            .get_all_server_ids()
            .await
            .contains(&"external".to_string()));
        assert!(service
            .execute_control(
                MCPControlOperation::Start,
                Some(&json!({"serverId":"unknown"}))
            )
            .await
            .is_err());
        service
            .server_manager
            .remove_ephemeral_server("external")
            .await
            .unwrap();
    }
}
