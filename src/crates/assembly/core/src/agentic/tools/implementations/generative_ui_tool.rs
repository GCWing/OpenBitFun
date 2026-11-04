//! GenerativeUI streams a component application into the owning FlowChat
//! surface. Rendering is immediately previewable; delivery and persistence
//! are verified by the owning host after the model stream finishes.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct GenerativeUITool;
impl GenerativeUITool {
    pub fn new() -> Self {
        Self
    }
    async fn selected_profile() -> OpenBitFunResult<String> {
        crate::service::config::get_global_config_service()
            .await?
            .get_config(Some("ai.generative_ui_library"))
            .await
    }
}
impl Default for GenerativeUITool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GenerativeUITool {
    fn name(&self) -> &str {
        "GenerativeUI"
    }
    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "Stream an OpenUI Lang answer using the selected component collection. The selected profile renders the source in FlowChat as it arrives, with local state and actions. Never generate TSX, React source or a per-app compilation artifact. Keep the same app ID when revising an application. Preserve requested features and user state when repairing errors. Query and Mutation calls are allowed only through explicitly registered host providers; never invent a network or storage fallback.".into()
        )
    }
    fn short_description(&self) -> String {
        "Create a streaming OpenUI Lang component answer.".into()
    }
    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }
    fn input_schema(&self) -> Value {
        let catalog = openbitfun_product_domains::generative_ui::catalog();
        let mut schema = catalog["generation"].clone();
        schema["$defs"] = catalog["$defs"].clone();
        if let Some(messages) = schema["properties"]["messages"]["items"]["anyOf"].as_array_mut() {
            messages.retain(|branch| {
                branch["properties"].get("createSurface").is_some()
                    || branch["properties"].get("updateDataModel").is_some()
            });
            if let Some(required) =
                messages[0]["properties"]["createSurface"]["required"].as_array_mut()
            {
                if !required.iter().any(|field| field == "source") {
                    required.push(Value::String("source".into()));
                }
            }
        }
        schema["description"] = json!("Stream an OpenUI Lang or HTML document in createSurface.source. Keep messages as a JSON array of message objects; never serialize the array into a string. OpenUI statements may render before the enclosing arguments close; updateDataModel is only for initial values. Source is the only accepted application representation and final delivery still requires validation. The active profile's official OpenUI authoring prompt is supplied as a scoped system instruction.");
        schema
    }
    async fn input_schema_for_model(&self) -> Value {
        let selected = Self::selected_profile()
            .await
            .map_err(|error| error.to_string());
        match selected.and_then(|profile| {
            openbitfun_product_domains::generative_ui::generation_schema_for_profile(&profile)
        }) {
            Ok(schema) => schema,
            Err(error) => {
                json!({"type":"object","properties":{},"additionalProperties":false,"description":format!("GenUI component settings unavailable: {error}")})
            }
        }
    }
    fn output_schema(&self) -> Value {
        json!({
            "type": "object", "additionalProperties": false,
            "required": ["success", "widget_id", "title", "app", "verification"],
            "properties": {
                "success": {"type": "boolean"}, "widget_id": {"type": "string"},
                "title": {"type": "string"}, "app": {"type": "object"},
                "app_state": {"type": "object"}, "verification": {"type": "object"},
                "owner_revision": {"type": "string"}
            }
        })
    }
    fn user_facing_name(&self) -> String {
        "Generative UI".into()
    }
    fn is_readonly(&self) -> bool {
        false
    }
    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }
    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let mut result = openbitfun_product_domains::generative_ui_protocol::assemble(input);
        if let (Some(context), Ok((app, _))) = (context, &result) {
            let validation = async {
                let profile = Self::selected_profile()
                    .await
                    .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
                if app.get("source").is_none() {
                    Err(OpenBitFunError::tool("GenUI requires createSurface.source"))
                } else {
                    openbitfun_product_domains::generative_ui::validate_profile(&profile, app)
                        .and_then(|_| openbitfun_product_domains::generative_ui::design_spec_for_profile(&profile)
                            .and_then(|expected| if app.get("designSpec").is_some_and(|actual| actual != &expected) {
                                Err(format!("app.designSpec must match the selected UI specification: {expected}"))
                            } else { Ok(()) }))
                        .map_err(OpenBitFunError::tool)
                }
            }.await;
            if let Err(error) = validation {
                result = Err(error.to_string());
            }
        }
        match result {
            Ok(_) => ValidationResult::default(),
            Err(message) => ValidationResult {
                result: false,
                message: Some(format!("{message}. Repair the description while preserving all requested features and state.")),
                error_code: Some(400), meta: None,
            },
        }
    }
    fn render_result_for_assistant(&self, output: &Value) -> String {
        format!(
            "GenUI answer '{}' is live in FlowChat. The source is rendered as it arrives and local interactions stay in the current answer.",
            output["app"]["title"].as_str().unwrap_or("GenUI")
        )
    }
    fn render_tool_use_message(
        &self,
        input: &Value,
        _options: &crate::agentic::tools::framework::ToolRenderOptions,
    ) -> String {
        format!(
            "Creating GenUI application: {}",
            input["messages"][0]["createSurface"]["title"]
                .as_str()
                .unwrap_or("GenUI")
        )
    }
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let session_id = context
            .session_id
            .as_deref()
            .ok_or_else(|| OpenBitFunError::tool("GenUI requires an owning session"))?;
        openbitfun_core_types::validate_session_id(session_id).map_err(OpenBitFunError::tool)?;
        let (app, state) = openbitfun_product_domains::generative_ui_protocol::assemble(input)
            .map_err(OpenBitFunError::tool)?;
        let profile = Self::selected_profile().await?;
        openbitfun_product_domains::generative_ui::validate_profile(&profile, &app)
            .map_err(OpenBitFunError::tool)?;
        let expected_spec =
            openbitfun_product_domains::generative_ui::design_spec_for_profile(&profile)
                .map_err(OpenBitFunError::tool)?;
        if app.get("designSpec") != Some(&expected_spec) {
            return Err(OpenBitFunError::tool(format!(
                "GenUI app.designSpec must match the selected profile: {expected_spec}"
            )));
        }
        let widget_id = context
            .tool_call_id
            .clone()
            .unwrap_or_else(|| format!("genui_{}", uuid::Uuid::new_v4()));
        let data = json!({
            "success": true,
            "widget_id": widget_id,
            "title": app["title"],
            "app": app,
            "verification": {
                "mode": "transient",
                "persistence": "skipped",
                "checks": "skipped",
                "render": "streamed",
                "reopen": "skipped",
                "requirementCoverage": "skipped",
                "visual": "skipped",
                "sourceKind": app["source"]["kind"],
                "profile": profile,
            },
            "app_state": state
        });
        let message = self.render_result_for_assistant(&data);
        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(message),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn component_app() -> Value {
        let examples: Value = serde_json::from_str(include_str!(
            "../../../../../../../shared/generative-ui/examples.json"
        ))
        .unwrap();
        let mut app = examples["ledger"].clone();
        app["source"] = json!({"kind":"openui-lang","content":"root = Col([])"});
        app
    }
    fn generation(app: Value) -> Value {
        let mut create = json!({"id":app["id"],"title":app["title"],"template":app["template"],"libraryId":app["libraryId"],"libraryRevision":app["libraryRevision"],"source":app["source"]});
        if let Some(design_spec) = app.get("designSpec") {
            create["designSpec"] = design_spec.clone();
        }
        json!({"protocol":"openbitfun.genui.v1","messages":[
            {"createSurface":create},
            {"updateDataModel":{"state":app["state"],"values":{"future":false}}}
        ]})
    }
    #[tokio::test]
    async fn accepts_component_app_and_preserved_state() {
        let result = GenerativeUITool::new()
            .validate_input(&generation(component_app()), None)
            .await;
        assert!(result.result, "{:?}", result.message);
    }
    #[tokio::test]
    async fn accepts_source_generation_without_graph_checks() {
        let mut app = component_app();
        app["source"] = json!({"kind":"openui-lang","content":"root = Col([])"});
        let result = GenerativeUITool::new()
            .validate_input(&generation(app), None)
            .await;
        assert!(result.result, "{:?}", result.message);
    }
    #[tokio::test]
    async fn rejects_legacy_parts_without_claiming_success() {
        let result = GenerativeUITool::new()
            .validate_input(
                &json!({"app":{"schemaVersion":1,"id":"old","title":"Old","parts":[]}}),
                None,
            )
            .await;
        assert!(!result.result);
    }
    #[tokio::test]
    async fn rejects_html_payloads_even_with_a_valid_app() {
        let tool = GenerativeUITool::new();
        for payload in [
            json!({"widget_code":"<div>old</div>"}),
            json!({"app":component_app(),"widget_code":"<div>old</div>"}),
        ] {
            assert!(!tool.validate_input(&payload, None).await.result);
        }
        assert_eq!(
            tool.input_schema()["required"],
            json!(["protocol", "messages"])
        );
    }
}
