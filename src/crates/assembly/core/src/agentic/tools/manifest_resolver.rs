//! Compatibility facade for product tool manifest resolution.

use crate::agentic::agents::AgentToolPolicyOverrides;
use crate::agentic::tools::product_runtime::{
    resolve_product_resolved_tool_manifest, resolve_product_resolved_visible_tools,
};
use crate::agentic::tools::tool_context_runtime::ToolUseContext;

pub use crate::agentic::tools::product_runtime::{ResolvedToolManifest, ResolvedVisibleTools};

pub async fn resolve_visible_tools(
    allowed_tools: &[String],
    exposure_overrides: &AgentToolPolicyOverrides,
    context: &ToolUseContext,
) -> ResolvedVisibleTools {
    resolve_product_resolved_visible_tools(allowed_tools, exposure_overrides, context).await
}

pub async fn resolve_tool_manifest(
    allowed_tools: &[String],
    exposure_overrides: &AgentToolPolicyOverrides,
    context: &ToolUseContext,
) -> ResolvedToolManifest {
    resolve_product_resolved_tool_manifest(allowed_tools, exposure_overrides, context).await
}

#[cfg(test)]
mod tests {
    use super::{resolve_tool_manifest, resolve_visible_tools};
    use crate::agentic::agents::AgentToolPolicyOverrides;
    use crate::agentic::tools::product_runtime::{
        resolve_product_resolved_tool_manifest, resolve_product_resolved_visible_tools,
    };
    use crate::agentic::tools::tool_context_runtime::ToolUseContext;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use openbitfun_agent_tools::GET_TOOL_SPEC_TOOL_NAME;
    use std::collections::HashMap;

    fn tool_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: Some("test-agent".to_string()),
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn manifest_resolver_facade_preserves_product_owner_output() {
        let allowed_tools = vec!["Read".to_string(), "SessionHistory".to_string()];
        let context = tool_context();

        let facade = resolve_tool_manifest(
            &allowed_tools,
            &AgentToolPolicyOverrides::default(),
            &context,
        )
        .await;
        let owner = resolve_product_resolved_tool_manifest(
            &allowed_tools,
            &AgentToolPolicyOverrides::default(),
            &context,
        )
        .await;

        assert_eq!(facade.allowed_tool_names, owner.allowed_tool_names);
        assert_eq!(facade.deferred_tool_names, owner.deferred_tool_names);
        assert_eq!(
            facade
                .tool_definitions
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            owner
                .tool_definitions
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
        );
        assert!(facade
            .allowed_tool_names
            .contains(&GET_TOOL_SPEC_TOOL_NAME.to_string()));
    }

    #[tokio::test]
    async fn visible_tools_facade_preserves_product_owner_output() {
        let allowed_tools = vec!["Read".to_string(), "SessionHistory".to_string()];
        let context = tool_context();

        let facade = resolve_visible_tools(
            &allowed_tools,
            &AgentToolPolicyOverrides::default(),
            &context,
        )
        .await;
        let owner = resolve_product_resolved_visible_tools(
            &allowed_tools,
            &AgentToolPolicyOverrides::default(),
            &context,
        )
        .await;

        assert_eq!(
            facade
                .direct_tools
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>(),
            owner
                .direct_tools
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            facade
                .deferred_tools
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>(),
            owner
                .deferred_tools
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>()
        );
    }
}
