use std::sync::Arc;

use async_trait::async_trait;
use openbitfun_agent_tools::{
    acp_external_agent_tool_input_schema, build_acp_external_agent_tool_definition,
    build_acp_external_agent_tool_name, build_acp_external_agent_tool_result,
    render_acp_external_agent_rejected_message, render_acp_external_agent_result_for_assistant,
    render_acp_external_agent_result_message, render_acp_external_agent_use_message,
    validate_acp_external_agent_tool_input, AcpExternalAgentToolDefinition,
    AcpExternalAgentToolDefinitionInput, ToolResult, ValidationResult,
};
use openbitfun_core::agentic::tools::framework::{Tool, ToolRenderOptions, ToolUseContext};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde_json::Value;

use super::config::AcpClientConfig;
use super::manager::AcpClientService;

pub(super) struct AcpAgentTool {
    client_id: String,
    service: Arc<AcpClientService>,
    definition: AcpExternalAgentToolDefinition,
}

impl AcpAgentTool {
    pub(super) fn new(
        client_id: String,
        config: AcpClientConfig,
        service: Arc<AcpClientService>,
    ) -> Self {
        let definition = acp_external_agent_definition_for_config(&client_id, &config);
        Self {
            client_id,
            service,
            definition,
        }
    }

    pub(super) fn tool_name_for(client_id: &str) -> String {
        build_acp_external_agent_tool_name(client_id)
    }

    fn display_name(&self) -> &str {
        &self.definition.display_name
    }
}

fn acp_external_agent_definition_for_config(
    client_id: &str,
    config: &AcpClientConfig,
) -> AcpExternalAgentToolDefinition {
    build_acp_external_agent_tool_definition(AcpExternalAgentToolDefinitionInput {
        client_id,
        display_name: config.name.as_deref(),
        subagent_description: config.subagent.description.as_deref(),
        best_for: config.subagent.best_for.as_deref(),
        read_only: config.readonly,
    })
}

#[async_trait]
impl Tool for AcpAgentTool {
    fn name(&self) -> &str {
        &self.definition.tool_name
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.definition.description.clone())
    }

    fn short_description(&self) -> String {
        self.definition.short_description.clone()
    }

    fn input_schema(&self) -> Value {
        acp_external_agent_tool_input_schema()
    }

    fn user_facing_name(&self) -> String {
        self.definition.user_facing_name.clone()
    }

    fn is_readonly(&self) -> bool {
        self.definition.read_only
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    /// ACP clients are spawned on the host that runs this process and
    /// `call_impl` never forwards a remote connection id, so the tool cannot
    /// serve a remote workspace session.
    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        context.is_none_or(|context| !context.is_remote())
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_acp_external_agent_tool_input(input)
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        render_acp_external_agent_use_message(self.display_name(), input)
    }

    fn render_tool_use_rejected_message(&self) -> String {
        render_acp_external_agent_rejected_message(self.display_name())
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        render_acp_external_agent_result_message(self.display_name(), output)
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        render_acp_external_agent_result_for_assistant(output)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let openbitfun_session_id = context.session_id.clone().ok_or_else(|| {
            OpenBitFunError::tool("ACP tool requires an active OpenBitFun session".to_string())
        })?;
        let prompt = input
            .get("prompt")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| OpenBitFunError::tool("prompt is required".to_string()))?
            .to_string();

        let workspace_path = input
            .get("workspace_path")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| {
                context
                    .workspace_root()
                    .map(|path| path.to_string_lossy().to_string())
            });
        let timeout_seconds = input
            .get("timeout_seconds")
            .and_then(|value| value.as_u64());

        let response = self
            .service
            .prompt_agent(
                &self.client_id,
                prompt,
                workspace_path,
                None,
                openbitfun_session_id,
                None,
                timeout_seconds,
            )
            .await?;

        Ok(vec![build_acp_external_agent_tool_result(
            &self.client_id,
            response,
        )])
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::client::config::AcpClientPermissionMode;

    #[test]
    fn acp_agent_tool_name_preserves_current_prompt_visible_shape() {
        assert_eq!(
            AcpAgentTool::tool_name_for("Claude Code"),
            "acp__Claude_Code__prompt"
        );
    }

    #[test]
    fn acp_agent_definition_for_config_preserves_tool_contract() {
        let config = AcpClientConfig {
            name: Some("Codex".to_string()),
            command: "codex".to_string(),
            args: Vec::new(),
            env: HashMap::new(),
            enabled: true,
            readonly: true,
            subagent: crate::client::config::AcpClientSubagentConfig {
                enabled: true,
                description: Some("Implements complex code changes".to_string()),
                best_for: Some("Cross-file refactors".to_string()),
            },
            permission_mode: AcpClientPermissionMode::Ask,
        };

        let definition = acp_external_agent_definition_for_config("codex", &config);

        assert_eq!(definition.tool_name, "acp__codex__prompt");
        assert_eq!(definition.display_name, "Codex");
        assert_eq!(definition.user_facing_name, "Codex (ACP)");
        assert!(definition
            .description
            .contains("Role: Implements complex code changes."));
        assert!(definition.read_only);
    }
}
