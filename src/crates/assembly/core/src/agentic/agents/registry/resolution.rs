use super::builtin::default_model_id_for_builtin_agent;
use super::types::AgentCategory;
use super::AgentRegistry;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::GlobalConfig;
use crate::service::config::SubagentModelSelection;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, error, warn};

impl AgentRegistry {
    /// Returns a source-neutral explicit model selection for a delegated
    /// subagent. Callers apply product defaults only when this returns `None`.
    pub fn get_explicit_subagent_model_selection(
        &self,
        agent_type: &str,
        workspace_id: Option<&str>,
    ) -> Option<SubagentModelSelection> {
        let config = self
            .find_agent_entry(agent_type, workspace_id)?
            .custom_config?;
        if !config.model_is_explicit {
            return None;
        }
        let model = config.model.trim();
        if model.is_empty() {
            None
        } else if model == "inherit" {
            Some(SubagentModelSelection::Inherit)
        } else {
            Some(SubagentModelSelection::fixed(model))
        }
    }

    /// Resolves an execution fallback for an agent whose session has no model.
    ///
    /// Delegated subagents receive an explicit resolved model from the
    /// coordinator. Modes use the shared future-session selector, while custom
    /// agents retain their portable Markdown model default.
    pub async fn get_model_id_for_agent(
        &self,
        agent_type: &str,
        workspace_id: Option<&str>,
    ) -> OpenBitFunResult<String> {
        let externally_owned = workspace_id
            .is_some_and(|workspace| self.is_external_subagent_route(agent_type, Some(workspace)));
        let entry = if externally_owned {
            workspace_id.and_then(|workspace| self.find_external_route_entry(agent_type, workspace))
        } else {
            self.find_agent_entry(agent_type, workspace_id)
        };
        let entry = entry.ok_or_else(|| {
            error!("[AgentRegistry] Agent not found: {}", agent_type);
            OpenBitFunError::agent(format!("[AgentRegistry] Agent not found: {}", agent_type))
        })?;

        if let Some(config) = entry.custom_config {
            let model = config.model.trim();
            if !model.is_empty() && model != "inherit" {
                debug!(
                    "[AgentRegistry] Custom agent '{}' using model from cache: {}",
                    agent_type, model
                );
                return Ok(model.to_string());
            }

            debug!(
                "[AgentRegistry] Custom agent '{}' has no standalone model, using fallback default",
                agent_type
            );
            return Ok("fast".to_string());
        }

        if entry.category == AgentCategory::Mode {
            if let Ok(config_service) = GlobalConfigManager::get_service().await {
                let global_config: GlobalConfig = config_service.get_config(None).await?;
                let model_id = global_config.ai.agent_model_defaults.mode.trim();
                if !model_id.is_empty() {
                    return Ok(model_id.to_string());
                }
            } else {
                error!(
                "[AgentRegistry] Config service not available, cannot get model config for Agent '{}'",
                agent_type
            );
            }
        }

        let default_model_id = default_model_id_for_builtin_agent(agent_type);
        warn!(
            "[AgentRegistry] Agent '{}' has no model configured, using default model '{}'",
            agent_type, default_model_id
        );
        Ok(default_model_id.to_string())
    }

    pub fn default_agent_type(&self) -> &str {
        "Standard"
    }
}
