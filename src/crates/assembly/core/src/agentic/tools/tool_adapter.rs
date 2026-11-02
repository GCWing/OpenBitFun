//! Core product tool adapter for provider-neutral tool contracts.
//!
//! Keep these adapters in core until `ToolUseContext` and concrete tools have a
//! reviewed owner migration. Generic contracts live in `openbitfun-agent-tools`;
//! this module only projects core-owned `Tool` behavior into those contracts.

use crate::agentic::tools::framework::{DynamicToolInfo, Tool, ToolExposure};
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use openbitfun_agent_runtime::deep_review::{ReviewTargetEvidence, ReviewTargetEvidenceSource};
use openbitfun_agent_tools::{ContextualToolManifestItem, ToolRegistryItem};
use serde_json::Value;

fn live_repository_context_allowed(context: &ToolUseContext) -> bool {
    let Some(manifest) = context.custom_data.get("deep_review_run_manifest") else {
        return true;
    };
    match ReviewTargetEvidence::from_context_value(manifest) {
        Ok(Some(evidence)) => {
            evidence.source() == ReviewTargetEvidenceSource::Workspace
                || evidence.allows_live_repository_context()
        }
        Ok(None) => true,
        Err(_) => false,
    }
}

#[async_trait::async_trait]
impl ToolRegistryItem for dyn Tool {
    fn name(&self) -> &str {
        Tool::name(self)
    }

    async fn description(&self) -> Result<String, String> {
        Tool::description(self)
            .await
            .map_err(|error| error.to_string())
    }

    fn input_schema(&self) -> Value {
        Tool::input_schema(self)
    }

    fn output_schema(&self) -> Value {
        Tool::output_schema(self)
    }

    fn short_description(&self) -> String {
        Tool::short_description(self)
    }

    fn default_exposure(&self) -> ToolExposure {
        Tool::default_exposure(self)
    }

    fn is_readonly(&self) -> bool {
        Tool::is_readonly(self)
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        Tool::is_concurrency_safe(self, input)
    }

    fn manages_own_execution_timeout(&self) -> bool {
        Tool::manages_own_execution_timeout(self)
    }

    async fn is_enabled(&self) -> bool {
        Tool::is_enabled(self).await
    }

    async fn input_schema_for_model(&self) -> Value {
        Tool::input_schema_for_model(self).await
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        Tool::dynamic_provider_id(self)
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        Tool::dynamic_tool_info(self)
    }
}

#[async_trait::async_trait]
impl ContextualToolManifestItem<ToolUseContext> for dyn Tool {
    async fn is_available_in_context(&self, context: &ToolUseContext) -> bool {
        if matches!(Tool::name(self), "Read" | "Grep" | "Glob" | "LS")
            && !live_repository_context_allowed(context)
        {
            return false;
        }
        Tool::is_available_in_context(self, Some(context)).await
    }

    async fn description_with_context(&self, context: &ToolUseContext) -> Result<String, String> {
        Tool::description_with_context(self, Some(context))
            .await
            .map_err(|error| error.to_string())
    }

    async fn input_schema_for_model_with_context(
        &self,
        context: &ToolUseContext,
    ) -> serde_json::Value {
        Tool::input_schema_for_model_with_context(self, Some(context)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prepared_non_workspace_target_requires_clean_binding_for_live_context() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "git_range",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": "1111111111111111111111111111111111111111",
                    "headRevision": "2222222222222222222222222222222222222222",
                    "completeness": "complete",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "src/lib.rs",
                        "status": "modified",
                        "completeness": "complete"
                    }],
                    "diffRefs": [],
                    "limitations": ["workspace_has_local_changes"]
                }
            }),
        );

        assert!(!live_repository_context_allowed(&context));
        context
            .custom_data
            .get_mut("deep_review_run_manifest")
            .unwrap()["reviewTargetEvidence"]["workspaceBinding"] = json!("matching_clean");
        assert!(live_repository_context_allowed(&context));
        context
            .custom_data
            .get_mut("deep_review_run_manifest")
            .unwrap()["reviewTargetEvidence"]["source"] = json!("workspace");
        context
            .custom_data
            .get_mut("deep_review_run_manifest")
            .unwrap()["reviewTargetEvidence"]["workspaceBinding"] = json!("matching_dirty");
        assert!(live_repository_context_allowed(&context));
    }
}
