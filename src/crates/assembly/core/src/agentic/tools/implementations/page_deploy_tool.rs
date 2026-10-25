//! PageDeploy tool — deploy a saved OpenBitFun Page version to production.

use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::agentic::tools::page_deploy_host::invoke_page_deploy;
use crate::agentic::tools::page_publish_host::page_account_available;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct PageDeployTool;

impl PageDeployTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PageDeployTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PageDeployTool {
    fn name(&self) -> &str {
        "PageDeploy"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Switch the production pointer of an existing OpenBitFun Page to a previously saved version_id (rollback or promote a prior version).

Requires a logged-in GitHub account. This tool is only available after account login. To create or update page content and publish, use PagePublish instead. Existing versions can also be reviewed from the Pages scene.

Input: slug (page path id), version_id (immutable saved version from a prior PagePublish). Returns absolute `url` plus url_path / deployed_version_id. Public links can be shared directly. Private and relay links must be opened or copied through the Pages scene/tool card so the browser receives a scoped one-time access handoff.

When telling the user the link: paste the full absolute URL and put a trailing space after it (before any punctuation or newline).

Preview a version at /p/{username}/{slug}/@v/{version_id}."#
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Deploy a saved OpenBitFun Page version to production.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["slug", "version_id"],
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Page slug (lowercase letters, digits, hyphens)."
                },
                "version_id": {
                    "type": "string",
                    "description": "Immutable version id to deploy (from a prior Save version)."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "version_id": {"type": "string"},
                "visibility": {"type": "string"},
                "deployed": {"type": "boolean"},
                "url": {"type": "string"}
            },
            "required": ["slug", "version_id", "visibility", "deployed"],
            "additionalProperties": true
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let slug = input
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<missing-slug>");
        let version_id = input
            .get("version_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<missing-version>");
        let resource = format!("page:{slug}; production-version={version_id}");
        let mut intent = PermissionIntent::new("page_deploy", vec![resource]);
        intent.save_resources.clear();
        intent.display_metadata.insert(
            "permissionScope".to_string(),
            Value::String("account".to_string()),
        );
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), Value::Bool(true));
        intent.display_metadata.insert(
            "pageOperation".to_string(),
            Value::String("deploy".to_string()),
        );
        intent
            .display_metadata
            .insert("pageSlug".to_string(), Value::String(slug.to_string()));
        intent.display_metadata.insert(
            "pageVersion".to_string(),
            Value::String(version_id.to_string()),
        );
        Ok(vec![intent])
    }

    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        page_account_available().await
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if !page_account_available().await {
            return Err(OpenBitFunError::tool(
                "PageDeploy requires a logged-in GitHub account".to_string(),
            ));
        }

        let slug = input
            .get("slug")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| OpenBitFunError::tool("slug is required".to_string()))?
            .to_string();
        let version_id = input
            .get("version_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| OpenBitFunError::tool("version_id is required".to_string()))?
            .to_string();

        let result = invoke_page_deploy(slug.clone(), version_id.clone())
            .await
            .map_err(OpenBitFunError::tool)?;

        let url = result
            .get("url")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| result.get("url_path").and_then(|v| v.as_str()))
            .unwrap_or("");
        let visibility = result
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("private");
        let assistant = deploy_result_for_assistant(&slug, &version_id, visibility, url);

        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(assistant),
            image_attachments: None,
        }])
    }
}

fn deploy_result_for_assistant(
    slug: &str,
    version_id: &str,
    visibility: &str,
    url: &str,
) -> String {
    if visibility != "public" {
        return format!(
            "Deployed OpenBitFun Page '{slug}' version '{version_id}' with {visibility} visibility. Open or copy it from the Pages scene/tool card so OpenBitFun can create a scoped browser-access link; do not share the raw Page URL."
        );
    }
    // Trailing space after URL keeps chat linkifiers from eating the next char.
    if url.is_empty() {
        format!("Deployed public OpenBitFun Page '{slug}' version '{version_id}' to production.")
    } else {
        format!(
            "Deployed public OpenBitFun Page '{slug}' version '{version_id}'. Production URL: {url} \n\
             Share this full absolute URL with the user, and keep a trailing space after the URL."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::account_login_capability::{
        lock_account_login_for_test, set_account_login_available,
    };
    use std::collections::HashMap;

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn login_gate_controls_availability_and_execution() {
        let _guard = lock_account_login_for_test();
        let tool = PageDeployTool::new();

        set_account_login_available(false);
        assert!(!tool.is_available_in_context(None).await);

        set_account_login_available(true);
        assert!(tool.is_available_in_context(None).await);

        set_account_login_available(false);
        let err = tool
            .call_impl(
                &json!({ "slug": "demo", "version_id": "v1" }),
                &empty_context(),
            )
            .await
            .expect_err("should reject without login");
        assert!(err.to_string().contains("logged-in"));
    }

    #[test]
    fn permission_intent_names_page_and_target_version() {
        let tool = PageDeployTool::new();
        let intents = tool
            .permission_intents(
                &json!({ "slug": "demo", "version_id": "v2026" }),
                &empty_context(),
            )
            .expect("permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "page_deploy");
        assert_eq!(
            intents[0].resources,
            vec!["page:demo; production-version=v2026"]
        );
        assert!(intents[0].save_resources.is_empty());
        assert_eq!(
            intents[0].display_metadata.get("permissionScope"),
            Some(&Value::String("account".to_string()))
        );
        assert_eq!(
            intents[0].display_metadata.get("requiresFreshApproval"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            intents[0].display_metadata.get("pageOperation"),
            Some(&Value::String("deploy".to_string()))
        );
    }

    #[test]
    fn private_deploy_result_never_advertises_the_raw_url() {
        let message = deploy_result_for_assistant(
            "demo",
            "v1",
            "private",
            "https://relay.example/p/alice/demo",
        );
        assert!(!message.contains("https://"));
        assert!(message.contains("scoped browser-access link"));
    }
}
