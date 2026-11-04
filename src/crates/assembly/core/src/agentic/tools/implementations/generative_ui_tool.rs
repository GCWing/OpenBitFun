//! GenerativeUI streams a component application into the owning FlowChat
//! surface. Rendering is immediately previewable; delivery and persistence
//! are verified by the owning host after the model stream finishes.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_services_integrations::generative_ui::GenUIStore;
use serde_json::{json, Value};

fn genui_checker_failure_feedback(error: &str) -> String {
    if error.contains("OpenUI action did not reach the owning host") {
        return format!(
            "GenUI acceptance infrastructure failure: {error}. The current checker can mis-target its generic button probe when validating @ToAssistant actions. The candidate is saved but not accepted; do not rewrite the application to satisfy this unreliable probe. Report that acceptance could not be completed."
        );
    }
    format!(
        "GenUI acceptance checker failed before producing reviewable evidence: {error}. The candidate is saved but not accepted. Do not rewrite or regenerate the application solely to clear this checker error. Treat a missing checker, host, transport, timeout, invalid evidence, or unsupported/mis-targeted probe as an acceptance infrastructure failure. Repair the source only when the diagnostic demonstrates a concrete defect in the candidate's source, rendered output, or behavior."
    )
}

fn genui_acceptance_infrastructure_feedback(
    stage: &str,
    error: &(impl std::fmt::Display + ?Sized),
) -> String {
    format!(
        "GenUI acceptance infrastructure failed during {stage}: {error}. The candidate is not accepted. Do not edit or regenerate the application to address this failure; report that acceptance could not be completed."
    )
}

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

    /// Harmony GenUI is the explicit delivery-oriented mode. The default
    /// OpenUI mode intentionally returns the assembled source immediately;
    /// checker, review, persistence and owner acceptance are not part of the
    /// first response lifecycle.
    fn requires_delivery(profile: &str) -> bool {
        profile == "harmony"
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
            "Stream an OpenUI Lang answer using the selected component collection. The default OpenUI profile renders the source in FlowChat as it arrives, keeps local state and actions live, and returns without checker, visual review or persistence gating. Use the Harmony profile only when an explicitly durable Harmony GenUI delivery is requested; that mode runs the owning host's persistence, target-viewport checks, reopening, CAS acceptance and requirement review. Never generate TSX, React source or a per-app compilation artifact. Keep the same app ID when revising an application. Preserve requested features and user state when repairing errors. Query and Mutation calls are allowed only through explicitly registered host providers; never invent a network or storage fallback.".into()
        )
    }
    fn short_description(&self) -> String {
        "Create an OpenUI Lang component answer, or explicitly deliver a checked Harmony GenUI application.".into()
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
                if Self::requires_delivery(&profile) {
                    let session_id = context
                        .session_id
                        .as_deref()
                        .ok_or_else(|| OpenBitFunError::tool("Harmony GenUI requires an owning session"))?;
                    let workspace = context
                        .workspace
                        .as_ref()
                        .ok_or_else(|| OpenBitFunError::tool("Harmony GenUI requires an owning workspace"))?;
                    let store = GenUIStore::new(
                        workspace
                            .session_storage_dir()
                            .join(session_id)
                            .join("artifacts")
                            .join("genui"),
                    );
                    let app_id = app["id"]
                        .as_str()
                        .ok_or_else(|| OpenBitFunError::tool("Missing application ID"))?;
                    match store.accepted(app_id).await {
                        Ok(Some(_)) => Ok(()),
                        Ok(None) => {
                            if app.get("source").is_none() {
                                Err(OpenBitFunError::tool(
                                    "New Harmony GenUI applications require createSurface.source",
                                ))
                            } else {
                                openbitfun_product_domains::generative_ui::validate_profile(&profile, app)
                                    .and_then(|_| openbitfun_product_domains::generative_ui::design_spec_for_profile(&profile)
                                        .and_then(|expected| if app.get("designSpec").is_some_and(|actual| actual != &expected) {
                                            Err(format!("app.designSpec must match the selected UI specification: {expected}"))
                                        } else { Ok(()) }))
                                    .map_err(OpenBitFunError::tool)
                            }
                        }
                        Err(error) => Err(OpenBitFunError::tool(error)),
                    }
                } else if app.get("source").is_none() {
                    Err(OpenBitFunError::tool(
                        "OpenUI GenUI requires createSurface.source",
                    ))
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
        if output["verification"]["mode"] == "transient" {
            return format!(
                "OpenUI answer '{}' is live in FlowChat. The source is rendered as it arrives and local interactions stay in the current answer; no delivery checker or persistence gate was run.",
                output["app"]["title"].as_str().unwrap_or("GenUI")
            );
        }
        let coverage = output["verification"]["requirementCoverage"]["status"]
            .as_str()
            .unwrap_or("skipped");
        let review_note = if coverage == "passed" {
            "A model coverage review found no clearly missing requested parts."
        } else {
            "The model coverage review was unavailable; host checks passed."
        };
        format!("Harmony GenUI answer '{}' finished delivery. Mounted component, declared interaction and layout checks passed; the candidate was saved and reopened. {}", output["app"]["title"].as_str().unwrap_or("GenUI"), review_note)
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
        let (mut app, state) = openbitfun_product_domains::generative_ui_protocol::assemble(input)
            .map_err(OpenBitFunError::tool)?;
        let profile = Self::selected_profile().await?;
        let app_id = app["id"]
            .as_str()
            .ok_or_else(|| OpenBitFunError::tool("Missing application ID"))?;

        if !Self::requires_delivery(&profile) {
            openbitfun_product_domains::generative_ui::validate_profile(&profile, &app)
                .map_err(OpenBitFunError::tool)?;
            let expected_spec =
                openbitfun_product_domains::generative_ui::design_spec_for_profile(&profile)
                    .map_err(OpenBitFunError::tool)?;
            if app.get("designSpec") != Some(&expected_spec) {
                return Err(OpenBitFunError::tool(format!(
                    "OpenUI GenUI app.designSpec must match the selected profile: {expected_spec}"
                )));
            }
            let widget_id = context
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("genui_{}", uuid::Uuid::new_v4()));
            let evidence = json!({
                "mode": "transient",
                "persistence": "skipped",
                "checks": "skipped",
                "render": "streamed",
                "reopen": "skipped",
                "requirementCoverage": "skipped",
                "visual": "skipped",
                "sourceKind": app["source"]["kind"],
                "profile": profile,
            });
            let data = json!({
                "success": true,
                "widget_id": widget_id,
                "title": app["title"],
                "app": app,
                "verification": evidence,
                "app_state": state
            });
            let message = self.render_result_for_assistant(&data);
            return Ok(vec![ToolResult::Result {
                data,
                result_for_assistant: Some(message),
                image_attachments: None,
            }]);
        }

        let workspace = context
            .workspace
            .as_ref()
            .ok_or_else(|| OpenBitFunError::tool("Harmony GenUI requires an owning workspace"))?;
        let store = GenUIStore::new(
            workspace
                .session_storage_dir()
                .join(session_id)
                .join("artifacts")
                .join("genui"),
        );
        if store
            .accepted(app_id)
            .await
            .map_err(OpenBitFunError::tool)?
            .is_none()
        {
            if app.get("source").is_none() {
                return Err(OpenBitFunError::tool(
                    "New GenUI applications require createSurface.source",
                ));
            }
            openbitfun_product_domains::generative_ui::validate_profile(&profile, &app)
                .map_err(OpenBitFunError::tool)?;
            app["designSpec"] =
                openbitfun_product_domains::generative_ui::design_spec_for_profile(&profile)
                    .map_err(OpenBitFunError::tool)?;
        }
        let candidate = store
            .begin(app, Some(state))
            .await
            .map_err(OpenBitFunError::tool)?;
        let request = json!({ "candidate": candidate, "sessionId": session_id });
        let mut evidence = crate::agentic::tools::generative_ui_host::check_generative_ui(request)
            .await
            .map_err(|error| OpenBitFunError::tool(genui_checker_failure_feedback(&error)))?;
        evidence.as_object_mut().ok_or_else(|| {
            OpenBitFunError::tool(genui_acceptance_infrastructure_feedback(
                "evidence validation",
                "the checker returned a non-object payload",
            ))
        })?;
        // This value is part of the evidence committed atomically by
        // `accept`; it is exposed only when that CAS succeeds.
        evidence["persistence"] = json!("saved");
        evidence["requirementCoverage"] =
            crate::agentic::execution::generative_ui_review::review_candidate(
                context,
                &candidate.value.app,
                &candidate.value.state,
                &evidence,
            )
            .await
            .map_err(|error| OpenBitFunError::tool(error.tool_feedback()))?;
        if evidence["requirementCoverage"]["status"] == "skipped" {
            evidence["visual"] = json!("unverified");
        }
        evidence.as_object_mut().unwrap().remove("screenshot");
        let accepted = store
            .accept(&candidate, evidence.clone())
            .await
            .map_err(OpenBitFunError::tool)?;
        evidence["mode"] = json!("delivery");
        let widget_id = context
            .tool_call_id
            .clone()
            .unwrap_or_else(|| format!("genui_{}", uuid::Uuid::new_v4()));
        let data = json!({
            "success": true, "widget_id": widget_id, "title": accepted.app["title"], "app": accepted.app,
            "verification": evidence, "owner_revision": accepted.revision, "app_state": accepted.state
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

    #[test]
    fn checker_failures_do_not_automatically_request_source_rewrites() {
        let feedback = genui_checker_failure_feedback("renderer checker unavailable");
        assert!(feedback.contains("saved but not accepted"));
        assert!(feedback.contains("Do not rewrite or regenerate"));
        assert!(feedback.contains("mis-targeted probe"));
        assert!(!feedback.contains("repair the source"));
        let action_feedback =
            genui_checker_failure_feedback("OpenUI action did not reach the owning host");
        assert!(action_feedback.contains("generic button probe"));
        assert!(action_feedback.contains("do not rewrite the application"));
    }

    #[test]
    fn only_explicit_harmony_uses_delivery_pipeline() {
        assert!(!GenerativeUITool::requires_delivery("openui"));
        assert!(!GenerativeUITool::requires_delivery("openbitfun"));
        assert!(GenerativeUITool::requires_delivery("harmony"));
    }

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
    async fn refuses_delivery_without_an_owning_session() {
        let context = ToolUseContext::for_tool_listing(None, None);
        let error = GenerativeUITool::new()
            .call_impl(&json!({"app":component_app()}), &context)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("owning session"));
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

    #[tokio::test]
    async fn accepts_free_html_document_payloads_with_the_selected_specification() {
        let mut app = component_app();
        app["template"] = json!("openbitfun.harmony.app");
        app["libraryId"] = json!("openbitfun.harmony.v1");
        app["libraryRevision"] = json!(3);
        app["designSpec"] = json!({"id":"harmony.phone.v1","revision":1});
        app["source"] = json!({"kind":"html-document","html":"<section><svg viewBox=\"0 0 10 10\"></svg></section>","css":"section{width:100%;}"});
        app["state"] = json!({});
        let result = GenerativeUITool::new()
            .validate_input(&generation(app), None)
            .await;
        assert!(result.result, "{:?}", result.message);
    }

    #[tokio::test]
    async fn accepts_openui_lang_document_payloads_with_the_selected_specification() {
        let mut app = component_app();
        app["template"] = json!("openbitfun.harmony.app");
        app["libraryId"] = json!("openbitfun.harmony.v1");
        app["libraryRevision"] = json!(3);
        app["designSpec"] = json!({"id":"harmony.phone.v1","revision":1});
        app["source"] = json!({"kind":"openui-lang","content":"root = Col([Text(\"Hello\")])"});
        app["state"] = json!({});
        let result = GenerativeUITool::new()
            .validate_input(&generation(app), None)
            .await;
        assert!(result.result, "{:?}", result.message);
    }
}
