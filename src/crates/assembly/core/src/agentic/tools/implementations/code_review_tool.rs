//! Code review result submission tool
//!
//! Used to get structured code review results.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::core::CompressionContract;
use crate::agentic::deep_review::report as deep_review_report;
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::service::config::get_app_language_code;
use crate::service::i18n::code_review_copy_for_language;
use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
use log::warn;
use openbitfun_agent_runtime::deep_review::{
    review_diff_budget_exhausted, review_diff_limited, review_target_stale,
};
use serde_json::{json, Value};

/// Code review tool definition
pub struct CodeReviewTool;

impl CodeReviewTool {
    pub fn new() -> Self {
        Self
    }

    pub fn name_str() -> &'static str {
        "submit_code_review"
    }

    /// Sync schema fallback (e.g. tests); prefers zh-CN wording. For model calls use [`input_schema_for_model`].
    pub fn input_schema_value() -> Value {
        Self::input_schema_value_for_language("zh-CN")
    }

    pub fn description_for_language(lang_code: &str) -> String {
        code_review_copy_for_language(lang_code)
            .description
            .to_string()
    }

    pub fn input_schema_value_for_language(lang_code: &str) -> Value {
        Self::input_schema_value_for_language_with_mode(lang_code, false)
    }

    fn input_schema_value_for_language_with_mode(
        lang_code: &str,
        require_deep_fields: bool,
    ) -> Value {
        let copy = code_review_copy_for_language(lang_code);
        let (
            scope_desc,
            reviewer_summary_desc,
            source_reviewer_desc,
            validation_note_desc,
            plan_desc,
        ) = match lang_code {
            "en-US" => (
                "Human-readable review scope (optional, in English)",
                "Reviewer summary (in English)",
                "Reviewer source / role (optional, in English)",
                "Validation or triage note (optional, in English)",
                "Concrete remediation / follow-up plan items (in English)",
            ),
            "zh-TW" => (
                "Human-readable review scope (optional, in Traditional Chinese)",
                "Reviewer summary (in Traditional Chinese)",
                "Reviewer source / role (optional, in Traditional Chinese)",
                "Validation or triage note (optional, in Traditional Chinese)",
                "Concrete remediation / follow-up plan items (in Traditional Chinese)",
            ),
            _ => (
                "Human-readable review scope (optional, in Simplified Chinese)",
                "Reviewer summary (in Simplified Chinese)",
                "Reviewer source / role (optional, in Simplified Chinese)",
                "Validation or triage note (optional, in Simplified Chinese)",
                "Concrete remediation / follow-up plan items (in Simplified Chinese)",
            ),
        };
        let mut required = vec!["summary", "issues", "positive_points"];
        if require_deep_fields {
            required.extend([
                "review_mode",
                "review_scope",
                "reviewers",
                "remediation_plan",
            ]);
        }

        json!({
            "type": "object",
            "properties": {
                "schema_version": {
                    "type": "integer",
                    "description": "Schema version for forward compatibility",
                    "default": 1
                },
                "summary": {
                    "type": "object",
                    "description": "Review summary",
                    "properties": {
                        "overall_assessment": {
                            "type": "string",
                            "description": copy.overall_assessment
                        },
                        "risk_level": {
                            "type": "string",
                            "enum": ["low", "medium", "high", "critical"],
                            "description": "Risk level"
                        },
                        "recommended_action": {
                            "type": "string",
                            "enum": ["approve", "approve_with_suggestions", "request_changes", "block"],
                            "description": "Recommended action"
                        },
                        "confidence_note": {
                            "type": "string",
                            "description": copy.confidence_note
                        }
                    },
                    "required": ["overall_assessment", "risk_level", "recommended_action"]
                },
                "issues": {
                    "type": "array",
                    "description": "List of issues found",
                    "items": {
                        "type": "object",
                        "properties": {
                            "severity": {
                                "type": "string",
                                "enum": ["critical", "high", "medium", "low", "info"],
                                "description": "Severity level"
                            },
                            "certainty": {
                                "type": "string",
                                "enum": ["confirmed", "likely", "possible"],
                                "description": "Certainty level"
                            },
                            "category": {
                                "type": "string",
                                "description": "Issue category (e.g., security, logic correctness, performance, etc.)"
                            },
                            "file": {
                                "type": "string",
                                "description": "File path"
                            },
                            "line": {
                                "type": ["integer", "null"],
                                "description": "Line number (null if uncertain)"
                            },
                            "title": {
                                "type": "string",
                                "description": copy.issue_title
                            },
                            "description": {
                                "type": "string",
                                "description": copy.issue_description
                            },
                            "suggestion": {
                                "type": ["string", "null"],
                                "description": copy.issue_suggestion
                            },
                            "source_reviewer": {
                                "type": "string",
                                "description": source_reviewer_desc
                            },
                            "validation_note": {
                                "type": "string",
                                "description": validation_note_desc
                            }
                        },
                        "required": ["severity", "certainty", "category", "file", "title", "description"]
                    }
                },
                "positive_points": {
                    "type": "array",
                    "description": copy.positive_points,
                    "items": {
                        "type": "string"
                    }
                },
                "review_mode": {
                    "type": "string",
                    "enum": ["standard", "deep"],
                    "description": "Review mode"
                },
                "review_scope": {
                    "type": "string",
                    "description": scope_desc
                },
                "reviewers": {
                    "type": "array",
                    "description": "Reviewer summaries",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "Reviewer display name"
                            },
                            "specialty": {
                                "type": "string",
                                "description": "Reviewer specialty / role"
                            },
                            "status": {
                                "type": "string",
                                "description": "Reviewer result status"
                            },
                            "summary": {
                                "type": "string",
                                "description": reviewer_summary_desc
                            },
                            "partial_output": {
                                "type": "string",
                                "description": "Partial reviewer output captured before timeout or cancellation"
                            },
                            "packet_id": {
                                "type": "string",
                                "description": "Deep Review work packet id associated with this reviewer output"
                            },
                            "packet_status_source": {
                                "type": "string",
                                "enum": ["reported", "inferred", "missing"],
                                "description": "Whether packet_id/status was reported by the reviewer, inferred from scheduling metadata, or missing"
                            },
                            "issue_count": {
                                "type": "integer",
                                "description": "Validated issue count for this reviewer"
                            }
                        },
                        "required": ["name", "specialty", "status", "summary"],
                        "additionalProperties": false
                    }
                },
                "remediation_plan": {
                    "type": "array",
                    "description": plan_desc,
                    "items": {
                        "type": "string"
                    }
                },
                "report_sections": {
                    "type": "object",
                    "description": "Optional structured sections for richer review report presentation",
                    "properties": {
                        "executive_summary": {
                            "type": "array",
                            "description": "Short user-facing conclusion bullets",
                            "items": {
                                "type": "string"
                            }
                        },
                        "remediation_groups": {
                            "type": "object",
                            "description": "Grouped remediation and follow-up plan items",
                            "properties": {
                                "must_fix": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "should_improve": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "needs_decision": {
                                    "type": "array",
                                    "description": "Items needing user/product judgment. Each item should be an object with a 'question' and 'plan'.",
                                    "items": {
                                        "oneOf": [
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "question": {
                                                        "type": "string",
                                                        "description": "The specific decision the user needs to make"
                                                    },
                                                    "plan": {
                                                        "type": "string",
                                                        "description": "The remediation plan text to execute if the user approves"
                                                    },
                                                    "options": {
                                                        "type": "array",
                                                        "description": "2-4 possible choices or approaches",
                                                        "items": { "type": "string" }
                                                    },
                                                    "tradeoffs": {
                                                        "type": "string",
                                                        "description": "Brief explanation of trade-offs between options"
                                                    },
                                                    "recommendation": {
                                                        "type": "integer",
                                                        "description": "Index of the recommended option (0-based), if any"
                                                    }
                                                },
                                                "required": ["question", "plan"]
                                            },
                                            {
                                                "type": "string"
                                            }
                                        ]
                                    }
                                },
                                "verification": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                }
                            },
                            "additionalProperties": false
                        },
                        "strength_groups": {
                            "type": "object",
                            "description": "Grouped positive observations",
                            "properties": {
                                "architecture": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "maintainability": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "tests": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "security": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "performance": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "user_experience": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "other": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                }
                            },
                            "additionalProperties": false
                        },
                        "coverage_notes": {
                            "type": "array",
                            "description": "Review coverage, confidence, timeout, cancellation, or manual follow-up notes",
                            "items": {
                                "type": "string"
                            }
                        }
                    },
                    "additionalProperties": false
                },
                "reliability_signals": {
                    "type": "array",
                    "description": "Structured reliability/status signals for Deep Review report UI and export",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": [
                                    "context_pressure",
                                    "compression_preserved",
                                    "cache_hit",
                                    "cache_miss",
                                    "concurrency_limited",
                                    "partial_reviewer",
                                    "target_evidence_limited",
                                    "reduced_scope",
                                    "retry_guidance",
                                    "skipped_reviewers",
                                    "token_budget_limited",
                                    "user_decision"
                                ],
                                "description": "Reliability signal category"
                            },
                            "severity": {
                                "type": "string",
                                "enum": ["info", "warning", "action"],
                                "description": "User-facing severity of this signal"
                            },
                            "count": {
                                "type": "integer",
                                "minimum": 0,
                                "description": "Optional affected item count"
                            },
                            "source": {
                                "type": "string",
                                "enum": ["runtime", "manifest", "report", "inferred"],
                                "description": "Where this reliability signal came from"
                            },
                            "detail": {
                                "type": "string",
                                "description": "Short user-facing detail for this signal"
                            }
                        },
                        "required": ["kind", "severity"],
                        "additionalProperties": false
                    }
                },
                "schema_version": {
                    "type": "integer",
                    "description": "Schema version for forward compatibility",
                    "minimum": 1
                }
            },
            "required": required,
            "additionalProperties": false
        })
    }

    fn is_deep_review_context(context: Option<&ToolUseContext>) -> bool {
        deep_review_report::is_deep_review_context(context)
    }

    fn fill_deep_review_packet_metadata(input: &mut Value, run_manifest: Option<&Value>) {
        deep_review_report::fill_deep_review_packet_metadata(input, run_manifest);
    }

    fn compression_contract_for_context(context: &ToolUseContext) -> Option<CompressionContract> {
        deep_review_report::compression_contract_for_context(context)
    }

    #[cfg(test)]
    fn reliability_contract_limit(agent_type: Option<&str>, model_id: Option<&str>) -> usize {
        deep_review_report::reliability_contract_limit(agent_type, model_id)
    }

    #[cfg(test)]
    fn should_report_compression_preserved(
        compression_count: usize,
        compression_contract: Option<&CompressionContract>,
    ) -> bool {
        deep_review_report::should_report_compression_preserved(
            compression_count,
            compression_contract,
        )
    }

    fn fill_deep_review_reliability_signals(
        input: &mut Value,
        run_manifest: Option<&Value>,
        compression_contract: Option<&CompressionContract>,
    ) {
        deep_review_report::fill_deep_review_reliability_signals(
            input,
            run_manifest,
            compression_contract,
        );
    }

    fn fill_deep_review_runtime_tracker_signals(input: &mut Value, dialog_turn_id: Option<&str>) {
        deep_review_report::fill_deep_review_runtime_tracker_signals(input, dialog_turn_id);
    }

    fn log_deep_review_runtime_diagnostics(dialog_turn_id: Option<&str>) {
        deep_review_report::log_deep_review_runtime_diagnostics(dialog_turn_id);
    }

    async fn persist_deep_review_cache(
        context: &ToolUseContext,
        cache_value: Value,
    ) -> OpenBitFunResult<()> {
        deep_review_report::persist_deep_review_cache(context, cache_value).await
    }
    /// Validate and fill missing fields with default values
    ///
    /// When AI-returned data is missing certain fields, fill with default values to avoid entire review failure
    fn validate_and_fill_defaults(
        input: &mut Value,
        deep_review: bool,
        run_manifest: Option<&Value>,
        compression_contract: Option<&CompressionContract>,
    ) {
        let summary_is_valid =
            input
                .get("summary")
                .and_then(Value::as_object)
                .is_some_and(|summary| {
                    summary
                        .get("overall_assessment")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                        && summary
                            .get("risk_level")
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                matches!(value, "low" | "medium" | "high" | "critical")
                            })
                        && summary
                            .get("recommended_action")
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                matches!(
                                    value,
                                    "approve"
                                        | "approve_with_suggestions"
                                        | "request_changes"
                                        | "block"
                                )
                            })
                });
        if !summary_is_valid {
            warn!("CodeReview tool received a missing or invalid summary, failing closed");
            input["summary"] = json!({
                "overall_assessment": "Review result is incomplete or invalid",
                "risk_level": "high",
                "recommended_action": "request_changes",
                "confidence_note": "AI did not return a valid review summary"
            });
            input["evidence_status"] = json!("failed");
        }

        // Fill issues default values
        if input.get("issues").is_none() {
            warn!("CodeReview tool missing issues field, using default values");
            input["issues"] = json!([]);
        }

        // Fill positive_points default values
        if input.get("positive_points").is_none() {
            warn!("CodeReview tool missing positive_points field, using default values");
            input["positive_points"] = json!(["None"]);
        }

        if deep_review {
            let managed_review = run_manifest.is_some_and(|manifest| {
                manifest.get("managedReviewPlan").is_some()
                    || manifest.get("managed_review_plan").is_some()
            });
            input["review_mode"] = json!(if managed_review { "standard" } else { "deep" });
            if input.get("review_scope").is_none() {
                input["review_scope"] = json!(if managed_review {
                    "Managed Review scope was not provided"
                } else {
                    "Deep review scope was not provided"
                });
            }
        } else if input.get("review_mode").is_none() {
            input["review_mode"] = json!("standard");
        }

        if input.get("reviewers").is_none() {
            input["reviewers"] = json!([]);
        }
        if deep_review {
            Self::fill_deep_review_packet_metadata(input, run_manifest);
        }
        if deep_review || run_manifest.is_some() {
            Self::fill_deep_review_reliability_signals(input, run_manifest, compression_contract);
        }
        if run_manifest.is_some() || !summary_is_valid {
            deep_review_report::apply_review_evidence_guardrail(input, run_manifest);
        }

        if input.get("remediation_plan").is_none() {
            input["remediation_plan"] = json!([]);
        }

        if input.get("schema_version").is_none() {
            input["schema_version"] = json!(1);
        }
    }

    /// Generate review result using all default values
    ///
    /// Used when retries fail multiple times
    pub fn create_default_result() -> Value {
        json!({
            "schema_version": 1,
            "evidence_status": "failed",
            "summary": {
                "overall_assessment": "Review result is unavailable",
                "risk_level": "high",
                "recommended_action": "request_changes",
                "confidence_note": "AI review failed; a clean result is not allowed"
            },
            "issues": [],
            "positive_points": ["None"],
            "review_mode": "standard",
            "reviewers": [],
            "remediation_plan": [],
            "schema_version": 1
        })
    }
}

impl Default for CodeReviewTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CodeReviewTool {
    fn name(&self) -> &str {
        Self::name_str()
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        let lang = get_app_language_code().await;
        Ok(Self::description_for_language(lang.as_str()))
    }

    fn short_description(&self) -> String {
        "Submit a structured code review result.".to_string()
    }

    fn input_schema(&self) -> Value {
        Self::input_schema_value()
    }

    fn output_schema(&self) -> Value {
        // The normalized review packet is an internal/UI payload and the
        // assistant-facing result is a fixed acknowledgement, so no
        // canonical fields are projected into the PTC SDK here.
        json!({
            "type": "object",
            "additionalProperties": true
        })
    }

    async fn input_schema_for_model(&self) -> Value {
        let lang = get_app_language_code().await;
        Self::input_schema_value_for_language(lang.as_str())
    }

    async fn input_schema_for_model_with_context(
        &self,
        context: Option<&crate::agentic::tools::framework::ToolUseContext>,
    ) -> Value {
        let lang = get_app_language_code().await;
        Self::input_schema_value_for_language_with_mode(
            lang.as_str(),
            Self::is_deep_review_context(context),
        )
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let mut filled_input = input.clone();
        let deep_review = Self::is_deep_review_context(Some(context));
        let compression_contract = deep_review
            .then(|| Self::compression_contract_for_context(context))
            .flatten();
        let mut run_manifest = context.custom_data.get("deep_review_run_manifest").cloned();
        let mut existing_cache = run_manifest
            .as_ref()
            .and_then(|manifest| manifest.get("deepReviewCache"))
            .cloned();
        if deep_review && (run_manifest.is_none() || existing_cache.is_none()) {
            if let (Some(session_id), Some(workspace), Some(coordinator)) = (
                context.session_id.as_deref(),
                context.workspace.as_ref(),
                get_global_coordinator(),
            ) {
                let session_storage_dir = workspace.session_storage_dir();
                match coordinator
                    .get_session_manager()
                    .load_session_metadata(&session_storage_dir, session_id)
                    .await
                {
                    Ok(Some(metadata)) => {
                        if run_manifest.is_none() {
                            run_manifest = metadata.deep_review_run_manifest;
                        }
                        if existing_cache.is_none() {
                            existing_cache = metadata.deep_review_cache;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        warn!(
                            "Failed to load DeepReview session metadata for review cache: session_id={}, error={}",
                            session_id, error
                        );
                    }
                }
            }
        }
        Self::validate_and_fill_defaults(
            &mut filled_input,
            deep_review,
            run_manifest.as_ref(),
            compression_contract.as_ref(),
        );
        let review_parent_turn_id = context
            .custom_data
            .get("deep_review_parent_dialog_turn_id")
            .and_then(Value::as_str)
            .or(context.dialog_turn_id.as_deref());
        if review_parent_turn_id.is_some_and(review_diff_budget_exhausted) {
            deep_review_report::apply_review_runtime_limitation(
                &mut filled_input,
                "Review diff allowance was exhausted; uncovered files remain limited.",
            );
        }
        if review_parent_turn_id.is_some_and(review_diff_limited) {
            deep_review_report::apply_review_runtime_limitation(
                &mut filled_input,
                "One or more prepared Review diffs were unavailable or truncated; uncovered scope remains limited.",
            );
        }
        if review_parent_turn_id.is_some_and(review_target_stale) {
            deep_review_report::apply_review_runtime_stale(&mut filled_input);
        }
        if deep_review {
            Self::fill_deep_review_runtime_tracker_signals(
                &mut filled_input,
                context.dialog_turn_id.as_deref(),
            );
            Self::log_deep_review_runtime_diagnostics(context.dialog_turn_id.as_deref());
            if let Some(cache_update) =
                deep_review_report::deep_review_cache_from_completed_reviewers(
                    &filled_input,
                    run_manifest.as_ref(),
                    existing_cache.as_ref(),
                )
            {
                deep_review_report::fill_deep_review_cache_update_signals(
                    &mut filled_input,
                    &cache_update,
                );
                if let Err(error) =
                    Self::persist_deep_review_cache(context, cache_update.value).await
                {
                    warn!(
                        "Failed to persist DeepReview incremental cache: error={}",
                        error
                    );
                }
            }
        }

        Ok(vec![ToolResult::Result {
            data: filled_input,
            result_for_assistant: Some("Code review results submitted successfully".to_string()),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::CodeReviewTool;
    use crate::agentic::core::{CompressionContract, CompressionContractItem};
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use serde_json::json;
    use std::collections::HashMap;

    fn tool_context(agent_type: Option<&str>) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: agent_type.map(str::to_string),
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

    #[test]
    fn missing_summary_fails_closed() {
        let mut input = json!({
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, false, None, None);

        assert_eq!(input["summary"]["risk_level"], "high");
        assert_eq!(input["summary"]["recommended_action"], "request_changes");
        assert_eq!(input["evidence_status"], "failed");
    }

    #[test]
    fn partially_invalid_summary_is_replaced_as_a_unit() {
        let mut input = json!({
            "summary": {
                "overall_assessment": "Looks good",
                "risk_level": "unknown",
                "recommended_action": "approve",
                "confidence_note": "high confidence"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, false, None, None);

        assert_eq!(
            input["summary"],
            json!({
                "overall_assessment": "Review result is incomplete or invalid",
                "risk_level": "high",
                "recommended_action": "request_changes",
                "confidence_note": "AI did not return a valid review summary"
            })
        );
        assert_eq!(input["evidence_status"], "failed");
    }

    #[tokio::test]
    async fn deep_review_schema_requires_deep_review_fields() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let schema = tool
            .input_schema_for_model_with_context(Some(&context))
            .await;
        let required = schema["required"].as_array().expect("required fields");

        for field in [
            "review_mode",
            "review_scope",
            "reviewers",
            "remediation_plan",
        ] {
            assert!(
                required.iter().any(|value| value.as_str() == Some(field)),
                "DeepReview schema should require {field}"
            );
        }
    }

    #[tokio::test]
    async fn deep_review_schema_accepts_reviewer_partial_output() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let schema = tool
            .input_schema_for_model_with_context(Some(&context))
            .await;
        let reviewer_properties = &schema["properties"]["reviewers"]["items"]["properties"];

        assert_eq!(reviewer_properties["partial_output"]["type"], "string");
    }

    #[test]
    fn standard_review_surfaces_prepared_target_evidence_limits() {
        let manifest = json!({
            "reviewTargetEvidence": {
                "version": 1,
                "source": "workspace",
                "fingerprint": "0123456789abcdef",
                "baseRevision": "1111111111111111111111111111111111111111",
                "headRevision": "worktree:0123456789abcdef",
                "completeness": "partial",
                "workspaceBinding": "matching_dirty",
                "files": [{
                    "path": "src/lib.rs",
                    "status": "modified",
                    "completeness": "complete"
                }],
                "limitations": ["mutable_workspace_evidence"]
            }
        });
        let mut input = json!({});

        CodeReviewTool::validate_and_fill_defaults(&mut input, false, Some(&manifest), None);

        assert_eq!(
            input["reliability_signals"][0]["kind"],
            "target_evidence_limited"
        );
    }

    #[tokio::test]
    async fn deep_review_schema_accepts_reviewer_packet_fallback_metadata() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let schema = tool
            .input_schema_for_model_with_context(Some(&context))
            .await;
        let reviewer_properties = &schema["properties"]["reviewers"]["items"]["properties"];

        assert_eq!(reviewer_properties["packet_id"]["type"], "string");
        assert_eq!(
            reviewer_properties["packet_status_source"]["enum"],
            json!(["reported", "inferred", "missing"])
        );
    }

    #[tokio::test]
    async fn deep_review_schema_accepts_structured_reliability_signals() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let schema = tool
            .input_schema_for_model_with_context(Some(&context))
            .await;
        let reliability_properties =
            &schema["properties"]["reliability_signals"]["items"]["properties"];

        assert_eq!(
            reliability_properties["kind"]["enum"],
            json!([
                "context_pressure",
                "compression_preserved",
                "cache_hit",
                "cache_miss",
                "concurrency_limited",
                "partial_reviewer",
                "target_evidence_limited",
                "reduced_scope",
                "retry_guidance",
                "skipped_reviewers",
                "token_budget_limited",
                "user_decision"
            ])
        );
        assert_eq!(
            reliability_properties["source"]["enum"],
            json!(["runtime", "manifest", "report", "inferred"])
        );
    }

    #[tokio::test]
    async fn deep_review_submission_defaults_missing_mode_to_deep() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "No blocking issues",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": []
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert_eq!(data["review_mode"], "deep");
        assert!(data["reviewers"].as_array().is_some());
        assert!(data["remediation_plan"].as_array().is_some());
    }

    #[tokio::test]
    async fn managed_review_submission_uses_standard_product_mode() {
        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewMode": "deep",
                "managedReviewPlan": {
                    "version": 1,
                    "totalFileCount": 120,
                    "plannedFileCount": 120,
                    "deferredFileCount": 0
                }
            }),
        );

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "No blocking issues",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": []
                }),
                &context,
            )
            .await
            .expect("submit managed review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert_eq!(data["review_mode"], "standard");
    }

    #[tokio::test]
    async fn deep_review_submission_infers_unique_reviewer_packet_from_manifest() {
        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "workPackets": [
                    {
                        "packetId": "reviewer:ReviewSecurity",
                        "phase": "reviewer",
                        "subagentId": "ReviewSecurity",
                        "displayName": "Security Reviewer",
                        "roleName": "Security Reviewer"
                    }
                ]
            }),
        );

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "No blocking issues",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": [],
                    "reviewers": [
                        {
                            "name": "Security Reviewer",
                            "specialty": "security",
                            "status": "completed",
                            "summary": "Checked the security packet."
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert_eq!(data["reviewers"][0]["packet_id"], "reviewer:ReviewSecurity");
        assert_eq!(data["reviewers"][0]["packet_status_source"], "inferred");
    }

    #[tokio::test]
    async fn deep_review_submission_marks_uninferable_packet_metadata_as_missing() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "No blocking issues",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": [],
                    "reviewers": [
                        {
                            "name": "Unknown Reviewer",
                            "specialty": "unknown",
                            "status": "completed",
                            "summary": "Packet was omitted."
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert!(data["reviewers"][0].get("packet_id").is_none());
        assert_eq!(data["reviewers"][0]["packet_status_source"], "missing");
    }

    #[tokio::test]
    async fn deep_review_submission_marks_existing_packet_metadata_as_reported() {
        let tool = CodeReviewTool::new();
        let context = tool_context(Some("DeepReview"));
        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "No blocking issues",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": [],
                    "reviewers": [
                        {
                            "name": "Security Reviewer",
                            "specialty": "security",
                            "status": "completed",
                            "summary": "Packet was reported.",
                            "packet_id": "reviewer:ReviewSecurity"
                        }
                    ]
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert_eq!(data["reviewers"][0]["packet_id"], "reviewer:ReviewSecurity");
        assert_eq!(data["reviewers"][0]["packet_status_source"], "reported");
    }

    #[tokio::test]
    async fn deep_review_submission_fills_runtime_reliability_signals() {
        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "tokenBudget": {
                    "largeDiffSummaryFirst": true,
                    "warnings": [],
                    "estimatedReviewerCalls": 7,
                    "skippedReviewerIds": ["CustomPerf"]
                },
                "skippedReviewers": [
                    {
                        "subagentId": "ReviewFrontend",
                        "reason": "not_applicable"
                    },
                    {
                        "subagentId": "CustomPerf",
                        "reason": "budget_limited"
                    }
                ]
            }),
        );

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "Review completed with reduced confidence",
                        "risk_level": "medium",
                        "recommended_action": "request_changes"
                    },
                    "issues": [],
                    "positive_points": [],
                    "reviewers": [
                        {
                            "name": "Security Reviewer",
                            "specialty": "security",
                            "status": "partial_timeout",
                            "summary": "Timed out after partial evidence.",
                            "partial_output": "Found one likely issue before timeout."
                        }
                    ],
                    "report_sections": {
                        "remediation_groups": {
                            "needs_decision": [
                                "Decide whether to block the release."
                            ]
                        }
                    }
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        let kinds = data["reliability_signals"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|signal| signal["kind"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                "context_pressure",
                "skipped_reviewers",
                "token_budget_limited",
                "partial_reviewer",
                "retry_guidance",
                "user_decision",
            ]
        );
    }

    #[tokio::test]
    async fn deep_review_submission_fills_concurrency_limited_from_runtime_tracker() {
        use crate::agentic::deep_review_policy::record_deep_review_concurrency_cap_rejection;

        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.dialog_turn_id = Some("turn-code-review-cap-signal".to_string());
        record_deep_review_concurrency_cap_rejection("turn-code-review-cap-signal");

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "Review completed with launch backpressure",
                        "risk_level": "medium",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": []
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert_eq!(
            data["reliability_signals"],
            json!([
                {
                    "kind": "concurrency_limited",
                    "severity": "warning",
                    "count": 1,
                    "source": "runtime"
                }
            ])
        );
    }

    #[tokio::test]
    async fn deep_review_shared_context_diagnostics_stays_out_of_report() {
        use crate::agentic::deep_review_policy::{
            deep_review_runtime_diagnostics_snapshot, record_deep_review_shared_context_tool_use,
        };

        let turn_id = "turn-code-review-shared-context-diagnostics";
        record_deep_review_shared_context_tool_use(turn_id, "ReviewSecurity", "Read", "src/lib.rs");
        record_deep_review_shared_context_tool_use(
            turn_id,
            "ReviewPerformance",
            "Read",
            "src/lib.rs",
        );
        record_deep_review_shared_context_tool_use(
            turn_id,
            "ReviewArchitecture",
            "GetFileDiff",
            "src/lib.rs",
        );

        let diagnostics = deep_review_runtime_diagnostics_snapshot(turn_id)
            .expect("diagnostics should be available for measured turn");
        assert_eq!(diagnostics.shared_context_total_calls, 3);
        assert_eq!(diagnostics.shared_context_duplicate_calls, 1);
        assert_eq!(diagnostics.shared_context_duplicate_context_count, 1);
        assert_eq!(
            diagnostics.shared_context_duplicate_savings_candidate_count,
            1
        );

        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.dialog_turn_id = Some(turn_id.to_string());

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "Review completed",
                        "risk_level": "low",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": []
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };
        assert!(data.get("shared_context_measurement").is_none());
        assert!(data.get("runtime_diagnostics").is_none());
        assert!(data.get("reliability_signals").is_none());
    }

    #[tokio::test]
    async fn deep_review_submission_folds_capacity_skips_into_concurrency_limited_signal() {
        use crate::agentic::deep_review_policy::record_deep_review_capacity_skip;

        record_deep_review_capacity_skip("turn-code-review-capacity-skip");

        let tool = CodeReviewTool::new();
        let mut context = tool_context(Some("DeepReview"));
        context.dialog_turn_id = Some("turn-code-review-capacity-skip".to_string());

        let result = tool
            .call_impl(
                &json!({
                    "summary": {
                        "overall_assessment": "Review completed after queue skip",
                        "risk_level": "medium",
                        "recommended_action": "approve"
                    },
                    "issues": [],
                    "positive_points": []
                }),
                &context,
            )
            .await
            .expect("submit review result");

        let ToolResult::Result { data, .. } = &result[0] else {
            panic!("expected tool result");
        };

        assert_eq!(
            data["reliability_signals"],
            json!([
                {
                    "kind": "concurrency_limited",
                    "severity": "warning",
                    "count": 1,
                    "source": "runtime"
                }
            ])
        );
    }

    #[test]
    fn deep_review_defaults_include_compression_contract_reliability_signal() {
        let contract = CompressionContract {
            touched_files: vec!["src/web-ui/src/flow_chat/utils/codeReviewReport.ts".to_string()],
            verification_commands: vec![CompressionContractItem {
                target: "pnpm --dir src/web-ui run test:run".to_string(),
                status: "succeeded".to_string(),
                summary: "Frontend report tests passed.".to_string(),
                error_kind: None,
            }],
            blocking_failures: vec![],
            subagent_statuses: vec![],
        };
        let mut input = json!({
            "summary": {
                "overall_assessment": "No blocking issues",
                "risk_level": "low",
                "recommended_action": "approve"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, true, None, Some(&contract));

        assert_eq!(
            input["reliability_signals"],
            json!([
                {
                    "kind": "compression_preserved",
                    "severity": "info",
                    "count": 2,
                    "source": "runtime"
                }
            ])
        );
    }

    #[test]
    fn deep_review_reliability_contract_limit_uses_context_profile_policy() {
        assert_eq!(
            CodeReviewTool::reliability_contract_limit(Some("DeepReview"), Some("gpt-5")),
            8
        );
        assert_eq!(
            CodeReviewTool::reliability_contract_limit(Some("DeepReview"), Some("gpt-5-mini")),
            4
        );
    }

    #[test]
    fn deep_review_defaults_include_reduced_scope_reliability_signal() {
        let manifest = json!({
            "reviewMode": "deep",
            "scopeProfile": {
                "reviewDepth": "high_risk_only",
                "riskFocusTags": ["security"],
                "maxDependencyHops": 0,
                "optionalReviewerPolicy": "risk_matched_only",
                "allowBroadToolExploration": false,
                "coverageExpectation": "High-risk-only pass; changed files stay visible."
            }
        });
        let mut input = json!({
            "summary": {
                "overall_assessment": "No blocking issues",
                "risk_level": "low",
                "recommended_action": "approve"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, true, Some(&manifest), None);

        let kinds = input["reliability_signals"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|signal| signal["kind"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(kinds, vec!["reduced_scope"]);
        assert!(input.get("evidence_status").is_none());
    }

    #[test]
    fn deep_review_legacy_manifest_without_scope_profile_has_no_reduced_scope_signal() {
        let manifest = json!({
            "reviewMode": "deep",
            "workPackets": []
        });
        let mut input = json!({
            "summary": {
                "overall_assessment": "No blocking issues",
                "risk_level": "low",
                "recommended_action": "approve"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, true, Some(&manifest), None);

        assert!(input
            .get("reliability_signals")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .all(|signal| signal["kind"] != "reduced_scope"));
        assert!(input.get("evidence_status").is_none());
    }

    #[test]
    fn deep_review_invalid_evidence_pack_becomes_manifest_reliability_signal() {
        let manifest = json!({
            "reviewMode": "deep",
            "evidencePack": {
                "version": 1,
                "source": "target_manifest",
                "changedFiles": ["src/lib.rs"],
                "diffStat": {
                    "fileCount": 1,
                    "lineCountSource": "diff_stat"
                },
                "domainTags": ["core"],
                "riskFocusTags": ["security"],
                "packetIds": ["reviewer:ReviewSecurity"],
                "hunkHints": [],
                "contractHints": [],
                "budget": {
                    "maxChangedFiles": 80,
                    "maxHunkHints": 80,
                    "maxContractHints": 40,
                    "omittedChangedFileCount": 0,
                    "omittedHunkHintCount": 0,
                    "omittedContractHintCount": 0
                },
                "privacy": {
                    "content": "full_diff",
                    "excludes": [
                        "source_text",
                        "full_diff",
                        "model_output",
                        "provider_raw_body",
                        "full_file_contents"
                    ]
                }
            }
        });
        let mut input = json!({
            "summary": {
                "overall_assessment": "No blocking issues",
                "risk_level": "low",
                "recommended_action": "approve"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, true, Some(&manifest), None);

        let signals = input["reliability_signals"]
            .as_array()
            .expect("invalid evidence pack should emit a reliability signal");
        assert_eq!(signals[0]["kind"], "context_pressure");
        assert_eq!(signals[0]["severity"], "warning");
        assert_eq!(signals[0]["source"], "manifest");
        assert!(signals[0]["detail"]
            .as_str()
            .expect("signal should include detail")
            .contains("privacy.content"));
    }

    #[test]
    fn deep_review_full_depth_manifest_has_no_reduced_scope_signal() {
        let manifest = json!({
            "reviewMode": "deep",
            "scopeProfile": {
                "reviewDepth": "full_depth",
                "riskFocusTags": ["security"],
                "maxDependencyHops": "policy_limited",
                "optionalReviewerPolicy": "full",
                "allowBroadToolExploration": true,
                "coverageExpectation": "Full-depth pass."
            }
        });
        let mut input = json!({
            "summary": {
                "overall_assessment": "No blocking issues",
                "risk_level": "low",
                "recommended_action": "approve"
            },
            "issues": [],
            "positive_points": []
        });

        CodeReviewTool::validate_and_fill_defaults(&mut input, true, Some(&manifest), None);

        assert!(input
            .get("reliability_signals")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .all(|signal| signal["kind"] != "reduced_scope"));
        assert!(input.get("evidence_status").is_none());
    }

    #[test]
    fn deep_review_compression_signal_requires_completed_compression() {
        let contract = CompressionContract {
            touched_files: vec!["src/main.rs".to_string()],
            verification_commands: vec![],
            blocking_failures: vec![],
            subagent_statuses: vec![],
        };

        assert!(!CodeReviewTool::should_report_compression_preserved(
            0,
            Some(&contract)
        ));
        assert!(CodeReviewTool::should_report_compression_preserved(
            1,
            Some(&contract)
        ));
        assert!(!CodeReviewTool::should_report_compression_preserved(
            1,
            Some(&CompressionContract::default())
        ));
    }
}
