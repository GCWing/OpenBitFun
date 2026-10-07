use super::*;

pub struct LaunchReviewAgentTool;

#[derive(Debug, Clone)]
struct LaunchReviewAgentInvocation {
    description: String,
    prompt: String,
    subagent_type: String,
    packet_id: Option<String>,
    model_id: Option<String>,
    timeout_seconds: Option<u64>,
    is_retry: bool,
    requested_auto_retry: bool,
    focused_assignment: Option<Value>,
}

impl Default for LaunchReviewAgentTool {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchReviewAgentTool {
    pub fn new() -> Self {
        Self
    }

    fn launch_input_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "A short (3-5 word) description of the review agent launch."
                },
                "prompt": {
                    "type": "string",
                    "description": "The bounded review assignment. For ReviewWorker, state the exact review lens, concrete question, file or packet scope, and evidence expected. Do not include top-level LaunchReviewAgent arguments inside this string."
                },
                "subagent_type": {
                    "type": "string",
                    "description": "Required DeepReview team member agent type."
                },
                "packet_id": {
                    "type": "string",
                    "description": "Exact packet_id from active_packets. Required for every managed Review packet so runtime batch ordering and packet identity can be enforced."
                },
                "model_id": {
                    "type": "string",
                    "description": "Optional model or model slot for this reviewer or judge. Use the configured team manifest's preferred model_id for the matching review agent when one is provided; omit it to use the agent default."
                },
                "timeout_seconds": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Optional timeout for this reviewer or judge in seconds. When omitted, the DeepReview execution policy timeout for the role is used. When provided, the effective timeout is capped by the DeepReview execution policy for that role."
                },
                "retry": {
                    "type": "boolean",
                    "description": "True when re-dispatching a reviewer after that same reviewer returned partial_timeout or an explicit transient capacity failure in the current turn."
                },
                "auto_retry": {
                    "type": "boolean",
                    "description": "True only for backend-owned bounded automatic retries. Requires Review Team auto retry opt-in and retry=true. User/model-issued retry actions must omit this field or set it to false."
                },
                "focused_assignment": {
                    "type": "object",
                    "description": "A target-bound question for ReviewWorker. Required for adaptive non-packet checks; managed packets may attach a question without repeating their packet file scope. A safe display_label may be shown after runtime validation.",
                    "properties": {
                        "display_label": {
                            "type": "string",
                            "maxLength": 80,
                            "description": "Optional short plain-language label for the concern, using at most eight words. Do not include internal coordination values such as agent or skill names, packet IDs, file paths, or model IDs. Unsafe labels are ignored and never block the check."
                        },
                        "question": { "type": "string" },
                        "independent_value": { "type": "string" },
                        "target_fingerprint": { "type": "string" },
                        "allowed_changed_paths": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "expected_evidence": { "type": "string" },
                        "capability_key": { "type": "string" },
                        "capability_fingerprint": { "type": "string" }
                    },
                    "required": [
                        "question",
                        "independent_value",
                        "target_fingerprint",
                        "expected_evidence",
                        "capability_key",
                        "capability_fingerprint"
                    ],
                    "additionalProperties": false
                },
                "retry_coverage": {
                    "type": "object",
                    "description": "Retry only: structured coverage metadata proving the retry is bounded. Required when retry=true.",
                    "properties": {
                        "source_packet_id": {
                            "type": "string",
                            "description": "The original reviewer packet_id being retried."
                        },
                        "source_status": {
                            "type": "string",
                            "enum": ["partial_timeout", "capacity_skipped"],
                            "description": "The retryable source status."
                        },
                        "capacity_reason": {
                            "type": "string",
                            "description": "Required for capacity_skipped; must be a transient capacity reason such as local_concurrency_cap, launch_batch_blocked, provider_rate_limit, provider_concurrency_limit, retry_after, or temporary_overload."
                        },
                        "covered_files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Files already covered by the source attempt."
                        },
                        "retry_scope_files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Smaller file list to retry. Every entry must belong to the source packet and must not overlap covered_files."
                        }
                    },
                    "required": [
                        "source_packet_id",
                        "source_status",
                        "covered_files",
                        "retry_scope_files"
                    ]
                }
            },
            "required": [
                "description",
                "prompt",
                "subagent_type"
            ],
            "additionalProperties": false
        })
    }

    fn parse_invocation(input: &Value) -> OpenBitFunResult<LaunchReviewAgentInvocation> {
        for field in ["action", "fork_context", "agent_id", "run_in_background"] {
            if input.get(field).is_some() {
                return Err(OpenBitFunError::tool(format!(
                    "{field} is not supported for LaunchReviewAgent"
                )));
            }
        }

        let required_string = |field: &str| -> OpenBitFunResult<String> {
            let value = input
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    OpenBitFunError::tool(format!("{field} is required for LaunchReviewAgent"))
                })?;
            Ok(value.to_string())
        };
        let timeout_seconds = match input.get("timeout_seconds") {
            Some(value) => {
                let parsed = value.as_u64().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "timeout_seconds must be a non-negative integer".to_string(),
                    )
                })?;
                (parsed > 0).then_some(parsed)
            }
            None => None,
        };
        let model_id = match input.get("model_id") {
            Some(value) => {
                let value = value
                    .as_str()
                    .ok_or_else(|| OpenBitFunError::tool("model_id must be a string".to_string()))?
                    .trim();
                (!value.is_empty()).then(|| value.to_string())
            }
            None => None,
        };
        let packet_id = match input.get("packet_id") {
            Some(value) => {
                let value = value
                    .as_str()
                    .ok_or_else(|| OpenBitFunError::tool("packet_id must be a string".to_string()))?
                    .trim();
                (!value.is_empty()).then(|| value.to_string())
            }
            None => None,
        };

        Ok(LaunchReviewAgentInvocation {
            description: required_string("description")?,
            prompt: required_string("prompt")?,
            subagent_type: required_string("subagent_type")?,
            packet_id,
            model_id,
            timeout_seconds,
            is_retry: input.get("retry").and_then(Value::as_bool).unwrap_or(false),
            requested_auto_retry: input
                .get("auto_retry")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            focused_assignment: input.get("focused_assignment").cloned(),
        })
    }

    fn render_description() -> String {
        r#"Launch one foreground-waited DeepReview worker.

When the prepared manifest contains active work packets, launch only those packets in declared batch order. Manifest-declared managed Review packets may use bounded same-role file shards; every call blocks the owning Review turn until its result, timeout, or cancellation is recorded. Never convert a packet to a background AgentSpawn.

When active work packets are empty, the owning Review agent is the primary reviewer. Use this tool only when a concrete unresolved question has independent value, or when a high-severity, conflicting, or low-confidence conclusion needs ReviewJudge validation. Adaptive ordinary runs allow at most two focused checks. Adaptive strict runs allow at most three spawned calls total, including ReviewJudge.

Built-in review agent types:
- `ReviewWorker`: one read-only worker whose bounded prompt supplies the dynamic review lens, concrete question, file or packet scope, and expected evidence. It may cover a narrow specialist uncertainty or a managed file packet, but must not widen its assignment.
- `ReviewJudge`: final quality-inspector pass after reviewer outputs are available.

The capability catalog below contains short descriptions only. For an adaptive ReviewWorker call, copy the selected key and fingerprint into `focused_assignment`; full guidance is loaded only after runtime admission. When possible, give each focused assignment a short plain-language `display_label` that describes the user-visible concern without internal coordination values such as agent or skill names, packet IDs, file paths, or model IDs. The runtime ignores an unsafe label without blocking the check. Outside a manifest-declared work-packet plan, do not split files, launch routine parallel coverage, or repeat the primary review.

For a managed packet, pass its exact manifest `packet_id` in the top-level `packet_id` field. Runtime rejects missing or unknown managed packet ids.

Do not put `subagent_type`, `packet_id`, `description`, `model_id`, `timeout_seconds`, `retry`, `auto_retry`, `retry_coverage`, or `focused_assignment` inside the prompt string.

Retry rules:
- Set `retry=true` only when re-dispatching the same reviewer after `partial_timeout` or a transient capacity skip in the current turn.
- Retry calls must include `retry_coverage` with `source_packet_id`, `source_status`, `covered_files`, and a smaller `retry_scope_files` list.
- Do not set `auto_retry=true` unless this is a backend-owned bounded automatic retry admitted by Review Team settings."#
            .to_string()
    }

    fn render_tool_use_message(input: &Value, options: &ToolRenderOptions) -> String {
        input
            .get("description")
            .and_then(Value::as_str)
            .map(|description| {
                if options.verbose {
                    format!("Launching review agent: {}", description)
                } else {
                    format!("Review agent: {}", description)
                }
            })
            .unwrap_or_else(|| "Launching review agent".to_string())
    }

    pub(super) async fn call_launch_review_agent_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if Self::is_unsupported_adaptive_remote_context(context) {
            return Err(OpenBitFunError::tool(
                "Focused Review checks are unavailable for remote workspaces; continue with the primary review"
                    .to_string(),
            ));
        }
        if !AgentExecutionTool::is_deep_review_context(Some(context)) {
            return Err(OpenBitFunError::tool(
                "LaunchReviewAgent requires a prepared Review run manifest".to_string(),
            ));
        }
        let invocation = Self::parse_invocation(input)?;
        if context.is_remote() && invocation.focused_assignment.is_some() {
            return Err(OpenBitFunError::tool(
                "Focused Review checks are unavailable for remote workspaces; continue with the primary review"
                    .to_string(),
            ));
        }
        let description = Self::bound_packet_description(&invocation, context)?;
        let mut launch_context = context.clone();
        if let Some(manifest) = context.custom_data.get("deep_review_run_manifest") {
            let managed = manifest
                .get("managedReviewPlan")
                .or_else(|| manifest.get("managed_review_plan"))
                .is_some();
            let adaptive = is_adaptive_review_manifest(manifest);
            let is_worker = is_review_worker_agent_type(&invocation.subagent_type);
            if invocation.focused_assignment.is_some() && !is_worker {
                return Err(OpenBitFunError::tool(
                    "focused_assignment may only launch ReviewWorker".to_string(),
                ));
            }
            if adaptive && is_worker && !managed && invocation.focused_assignment.is_none() {
                return Err(OpenBitFunError::tool(
                    "focused_assignment is required for adaptive ReviewWorker checks".to_string(),
                ));
            }
            if let Some(raw_assignment) = invocation.focused_assignment.as_ref() {
                if invocation.is_retry || invocation.requested_auto_retry {
                    return Err(OpenBitFunError::tool(
                        "Focused Review checks do not retry automatically".to_string(),
                    ));
                }
                let assignment = FocusedReviewAssignment::from_input(
                    manifest,
                    raw_assignment,
                    invocation.packet_id.as_deref(),
                )
                .map_err(|violation| OpenBitFunError::tool(violation.to_tool_error_message()))?;
                let mut child_manifest = manifest.clone();
                if let Some(object) = child_manifest.as_object_mut() {
                    object.insert("focusedAssignment".to_string(), assignment.to_value());
                }
                launch_context
                    .custom_data
                    .insert("deep_review_run_manifest".to_string(), child_manifest);
            }
        }
        let task_input = json!({
            "description": description,
            "prompt": invocation.prompt,
            "subagent_type": invocation.subagent_type,
            "model_id": invocation.model_id,
            "timeout_seconds": invocation.timeout_seconds,
            "retry": invocation.is_retry,
            "auto_retry": invocation.requested_auto_retry,
            "retry_coverage": input.get("retry_coverage").cloned().unwrap_or(Value::Null),
        });
        let mut task_input = task_input;
        if task_input.get("timeout_seconds") == Some(&Value::Null) {
            task_input
                .as_object_mut()
                .unwrap()
                .remove("timeout_seconds");
        }
        if task_input.get("model_id") == Some(&Value::Null) {
            task_input.as_object_mut().unwrap().remove("model_id");
        }
        if task_input.get("retry_coverage") == Some(&Value::Null) {
            task_input.as_object_mut().unwrap().remove("retry_coverage");
        }
        if task_input.get("retry") == Some(&Value::Bool(false)) {
            task_input.as_object_mut().unwrap().remove("retry");
        }
        if task_input.get("auto_retry") == Some(&Value::Bool(false)) {
            task_input.as_object_mut().unwrap().remove("auto_retry");
        }

        AgentExecutionTool::new()
            .call_deep_review_task_impl(&task_input, &launch_context)
            .await
    }

    fn bound_packet_description(
        invocation: &LaunchReviewAgentInvocation,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<String> {
        let run_manifest = context.custom_data.get("deep_review_run_manifest");
        let managed_plan = run_manifest.and_then(|manifest| {
            manifest
                .get("managedReviewPlan")
                .or_else(|| manifest.get("managed_review_plan"))
        });
        let Some(packet_id) = invocation.packet_id.as_deref() else {
            if managed_plan.is_some() {
                return Err(OpenBitFunError::tool(
                    "packet_id is required for managed Review packets".to_string(),
                ));
            }
            return Ok(invocation.description.clone());
        };
        if managed_plan.is_none() {
            return Err(OpenBitFunError::tool(
                "packet_id is only valid for managed Review packets declared by the run manifest"
                    .to_string(),
            ));
        }
        let description = format!("[packet {packet_id}] {}", invocation.description);
        if Self::deep_review_launch_batch_for_task(
            &invocation.subagent_type,
            Some(&description),
            run_manifest,
        )
        .is_none()
        {
            return Err(OpenBitFunError::tool(format!(
                "packet_id '{packet_id}' is not active for managed reviewer '{}'",
                invocation.subagent_type
            )));
        }
        Ok(description)
    }

    fn is_unsupported_adaptive_remote_context(context: &ToolUseContext) -> bool {
        context.is_remote()
            && context
                .custom_data
                .get("deep_review_run_manifest")
                .is_some_and(|manifest| {
                    is_adaptive_review_manifest(manifest)
                        && manifest
                            .get("managedReviewPlan")
                            .or_else(|| manifest.get("managed_review_plan"))
                            .is_none()
                })
    }
}

#[async_trait]
impl Tool for LaunchReviewAgentTool {
    fn name(&self) -> &str {
        "LaunchReviewAgent"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(Self::render_description())
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let mut description = Self::render_description();
        if let Some(context) = context.filter(|context| {
            !context.is_remote()
                && context
                    .custom_data
                    .get("deep_review_run_manifest")
                    .is_some_and(is_adaptive_review_manifest)
        }) {
            description.push_str("\n\n");
            description.push_str(
                &crate::agentic::deep_review::capabilities::review_capability_catalog_for_context(
                    context,
                )
                .await,
            );
        }
        Ok(description)
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        AgentExecutionTool::is_deep_review_context(context)
            && !context.is_some_and(Self::is_unsupported_adaptive_remote_context)
    }

    fn short_description(&self) -> String {
        "Launch one foreground-waited Review worker.".to_string()
    }

    fn input_schema(&self) -> Value {
        Self::launch_input_schema()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        let Some(input) = input else {
            return false;
        };
        let has_parallel_reviewer_packet = input
            .get("packet_id")
            .and_then(Value::as_str)
            .is_some_and(|packet_id| {
                let packet_id = packet_id.trim().to_ascii_lowercase();
                packet_id.starts_with("reviewer:") || packet_id.starts_with("managed-review:")
            });
        let has_focused_scope = input
            .get("focused_assignment")
            .is_some_and(Value::is_object);
        if !has_parallel_reviewer_packet && !has_focused_scope {
            return false;
        }
        let subagent_type = input.get("subagent_type").and_then(Value::as_str);
        match subagent_type {
            Some(id) => {
                (!has_focused_scope || is_review_worker_agent_type(id))
                    && get_agent_registry()
                        .get_subagent_is_readonly(id)
                        .unwrap_or(false)
            }
            None => false,
        }
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<crate::agentic::tools::framework::PermissionIntent>> {
        let subagent_type = input
            .get("subagent_type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|subagent_type| !subagent_type.is_empty())
            .ok_or_else(|| OpenBitFunError::validation("subagent_type is required".to_string()))?;
        Ok(vec![
            crate::agentic::tools::framework::PermissionIntent::new(
                "task",
                vec![subagent_type.to_string()],
            ),
        ])
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match Self::parse_invocation(input) {
            Ok(invocation) => {
                if let Some(context) = context {
                    if Self::is_unsupported_adaptive_remote_context(context) {
                        return AgentExecutionTool::invalid_input(
                            "Focused Review checks are unavailable for remote workspaces; continue with the primary review",
                        );
                    }
                    if context.is_remote() && invocation.focused_assignment.is_some() {
                        return AgentExecutionTool::invalid_input(
                            "Focused Review checks are unavailable for remote workspaces; continue with the primary review",
                        );
                    }
                    if let Err(error) = Self::bound_packet_description(&invocation, context) {
                        return AgentExecutionTool::invalid_input(error.to_string());
                    }
                    if let Some(manifest) = context.custom_data.get("deep_review_run_manifest") {
                        let managed = manifest
                            .get("managedReviewPlan")
                            .or_else(|| manifest.get("managed_review_plan"))
                            .is_some();
                        let is_worker = is_review_worker_agent_type(&invocation.subagent_type);
                        if invocation.focused_assignment.is_some() && !is_worker {
                            return AgentExecutionTool::invalid_input(
                                "focused_assignment may only launch ReviewWorker",
                            );
                        }
                        if is_adaptive_review_manifest(manifest)
                            && is_worker
                            && !managed
                            && invocation.focused_assignment.is_none()
                        {
                            return AgentExecutionTool::invalid_input(
                                "focused_assignment is required for adaptive ReviewWorker checks",
                            );
                        }
                        if let Some(raw_assignment) = invocation.focused_assignment.as_ref() {
                            if let Err(violation) = FocusedReviewAssignment::from_input(
                                manifest,
                                raw_assignment,
                                invocation.packet_id.as_deref(),
                            ) {
                                return AgentExecutionTool::invalid_input(
                                    violation.to_tool_error_message(),
                                );
                            }
                        }
                    }
                }
                if let Some(result) = AgentExecutionTool::validate_prompt_size(input) {
                    return result;
                }
                ValidationResult {
                    result: true,
                    message: None,
                    error_code: None,
                    meta: None,
                }
            }
            Err(error) => AgentExecutionTool::invalid_input(error.to_string()),
        }
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        Self::render_tool_use_message(input, options)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        self.call_launch_review_agent_impl(input, context).await
    }
}
