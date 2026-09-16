//! AskUserQuestion tool
//!
//! Allows AI to ask questions to users during execution and wait for answers

use async_trait::async_trait;
use log::{debug, warn};
use openbitfun_agent_runtime::user_questions::{
    ask_user_question_available_in_context, build_answered_user_question_result,
    build_cancelled_user_question_result, build_timed_out_user_question_result,
    validate_ask_user_question_input, wait_for_user_question_response_until, AskUserQuestionInput,
    PendingUserQuestion, UserQuestionController, UserQuestionWaitOutcome,
    USER_INPUT_AVAILABLE_CONTEXT_KEY, USER_INPUT_MODEL_ROUND_CONTEXT_KEY,
    USER_INPUT_PARENT_CONTEXT_KEY,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::agentic::tools::user_input_manager::get_user_input_manager;
use crate::infrastructure::events::event_system::{get_global_event_system, BackendEvent};
use crate::util::errors::OpenBitFunResult;

/// AskUserQuestion tool
pub struct AskUserQuestionTool;

impl Default for AskUserQuestionTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AskUserQuestionTool {
    async fn question_controllers(context: &ToolUseContext) -> Vec<UserQuestionController> {
        let Some(parent) = context
            .custom_data
            .get(USER_INPUT_PARENT_CONTEXT_KEY)
            .and_then(|value| serde_json::from_value::<UserQuestionController>(value.clone()).ok())
        else {
            return Vec::new();
        };
        let mut controllers = vec![parent];
        let Some(coordinator) = crate::agentic::coordination::get_global_coordinator() else {
            return controllers;
        };
        let manager = coordinator.get_session_manager();
        let mut visited = std::collections::HashSet::new();
        if let Some(session_id) = context.session_id.as_ref() {
            visited.insert(session_id.clone());
        }
        while let Some(current) = controllers.last() {
            let session_id = current.session_id.clone();
            if !visited.insert(session_id.clone()) {
                controllers.pop();
                break;
            }
            let Some(storage) = manager.effective_session_storage_path(&session_id).await else {
                break;
            };
            let metadata = match manager.load_session_metadata(&storage, &session_id).await {
                Ok(Some(metadata)) => metadata,
                Ok(None) => break,
                Err(error) => {
                    warn!(
                        "Failed to resolve question controller lineage: session_id={}, error={}",
                        session_id, error
                    );
                    break;
                }
            };
            let Some(relationship) =
                openbitfun_services_core::session::normalized_session_relationship(&metadata)
            else {
                break;
            };
            if relationship.kind != Some(crate::service::session::SessionRelationshipKind::Subagent)
            {
                break;
            }
            let Some(parent_session_id) = relationship.parent_session_id else {
                break;
            };
            controllers.push(UserQuestionController {
                session_id: parent_session_id,
                dialog_turn_id: relationship.parent_dialog_turn_id,
            });
        }
        controllers
    }

    pub fn new() -> Self {
        Self
    }

    fn is_available_for_tool_context(context: Option<&ToolUseContext>) -> bool {
        ask_user_question_available_in_context(
            context.and_then(|ctx| ctx.custom_data.get("acp_transport")),
            context.and_then(|ctx| ctx.custom_data.get(USER_INPUT_AVAILABLE_CONTEXT_KEY)),
        )
    }

    /// Generate tool ID
    fn generate_tool_id(context: &ToolUseContext) -> String {
        // Prefer tool_call_id
        if let Some(tool_call_id) = &context.tool_call_id {
            return tool_call_id.clone();
        }

        // Only generate UUID as last resort (shouldn't reach here)
        warn!("Unable to get tool_call_id, using UUID for AskUserQuestion tool");
        format!("ask_user_{}", Uuid::new_v4())
    }
}

#[async_trait]
impl Tool for AskUserQuestionTool {
    fn name(&self) -> &str {
        "AskUserQuestion"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

WHEN TO USE:
- The request is ambiguous or could be interpreted in multiple ways
- Multiple valid approaches exist with different trade-offs
- The change affects critical files or has significant impact
- You are unsure about the user's intent or preferences
- The decision has security, performance, or architectural implications

WHEN NOT TO USE:
- The request is clear and specific
- You are following an already-approved plan exactly
- The change is trivial and clearly correct

RECOMMENDATION GUIDELINES:
- Always state your recommendation and reasoning
- Make your recommended option the first option in the list
- Add "(Recommended)" at the end of the recommended option's label
- Provide 2-4 clear options with descriptions of trade-offs

Usage notes:
- Put all questions you need into a single AskUserQuestion call instead of calling it repeatedly in one response
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question"#.to_string())
    }

    fn short_description(&self) -> String {
        "Ask the user focused follow-up questions during execution.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\""
                            },
                            "header": {
                                "type": "string",
                                "maxLength": 20,
                                "description": "Very short label displayed as a chip/tag (max 20 characters). Examples: \"Auth method\", \"Library\", \"Approach\"."
                            },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."
                                        }
                                    },
                                    "required": [
                                        "label",
                                        "description"
                                    ],
                                    "additionalProperties": false
                                },
                                "minItems": 2,
                                "maxItems": 10,
                                "description": "The available choices for this question. Must have 2-10 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically."
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "default": false,
                                "description": "Optional. Defaults to false. Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive."
                            }
                        },
                        "required": [
                            "question",
                            "header",
                            "options"
                        ],
                        "additionalProperties": false
                    },
                    "minItems": 1,
                    "maxItems": 4,
                    "description": "Questions to ask the user (1-4 questions)"
                }
            },
            "required": [
                "questions"
            ],
            "additionalProperties": false,
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        Self::is_available_for_tool_context(context)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let service = crate::service::config::global::GlobalConfigManager::get_service().await?;
        let ai_config: crate::service::config::types::AIConfig =
            service.get_config(Some("ai")).await?;
        let timeout = ai_config
            .user_question_timeout_secs
            .filter(|seconds| *seconds > 0)
            .map(|seconds| std::time::Duration::from_secs(u64::from(seconds)));
        self.call_with_timeout(input, context, timeout).await
    }
}

impl AskUserQuestionTool {
    async fn call_with_timeout(
        &self,
        input: &Value,
        context: &ToolUseContext,
        timeout: Option<std::time::Duration>,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if !Self::is_available_for_tool_context(Some(context)) {
            return Err(crate::util::errors::OpenBitFunError::tool(
                "AskUserQuestion is unavailable because this execution surface cannot accept interactive user input",
            ));
        }

        // 1. Parse input parameters
        let tool_input: AskUserQuestionInput =
            serde_json::from_value(input.clone()).map_err(|e| {
                crate::util::errors::OpenBitFunError::Validation(format!(
                    "Failed to parse input parameters: {}",
                    e
                ))
            })?;

        // 2. Validate question format
        if let Err(error) = validate_ask_user_question_input(&tool_input) {
            return Err(crate::util::errors::OpenBitFunError::Validation(error));
        }

        let question_count = tool_input.questions.len();
        debug!(
            "AskUserQuestion tool called with {} question(s)",
            question_count
        );

        // 3. Generate tool ID
        let tool_id = Self::generate_tool_id(context);

        let session_id = context
            .session_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let model_round_id = context
            .custom_data
            .get(USER_INPUT_MODEL_ROUND_CONTEXT_KEY)
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut questions = serde_json::to_value(&tool_input).unwrap_or_else(|_| json!({}));
        let controllers = Self::question_controllers(context).await;
        let wait_deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
        let registered_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        questions["responseHostNowMs"] = json!(registered_at);
        questions["responseDeadlineMs"] = timeout
            .map(|duration| json!(registered_at.saturating_add(duration.as_millis() as u64)))
            .unwrap_or(Value::Null);

        // 4. Create oneshot channel
        let (tx, rx) = tokio::sync::oneshot::channel();

        // 5. Register the channel together with the replayable request before
        // emitting. The guard removes it if cancellation drops this Tool
        // future, so later Surface snapshots cannot revive stale questions.
        let manager = get_user_input_manager();
        let registration = manager.register_question_with_controllers(
            PendingUserQuestion::new(
                tool_id.clone(),
                session_id.clone(),
                context.dialog_turn_id.clone(),
                model_round_id,
                questions.clone(),
            ),
            tx,
            controllers,
        );

        // 6. Send backend event to notify frontend to display question card
        let event_system = get_global_event_system();

        // Send complete questions array to frontend
        let event = BackendEvent::ToolAwaitingUserInput {
            tool_id: tool_id.clone(),
            session_id,
            questions,
        };

        let _ = event_system.emit(event).await;
        debug!(
            "AskUserQuestion tool event emitted, waiting for user input, tool_id: {}",
            tool_id
        );

        // 7. Bound the wait in the runtime host, including for remote driving surfaces.
        // The registration guard clears replay state on timeout or turn cancellation.
        match wait_for_user_question_response_until(&registration, rx, wait_deadline).await {
            UserQuestionWaitOutcome::Answered(response) => {
                debug!(
                    "AskUserQuestion tool received user response, tool_id: {}",
                    tool_id
                );
                let result = build_answered_user_question_result(&tool_input, response.answers);

                Ok(vec![ToolResult::Result {
                    data: result.data,
                    result_for_assistant: Some(result.result_for_assistant),
                    image_attachments: None,
                }])
            }
            UserQuestionWaitOutcome::TimedOut => {
                debug!("AskUserQuestion timed out, tool_id: {}", tool_id);
                let result = build_timed_out_user_question_result(&tool_input);
                Ok(vec![ToolResult::Result {
                    data: result.data,
                    result_for_assistant: Some(result.result_for_assistant),
                    image_attachments: None,
                }])
            }
            UserQuestionWaitOutcome::Cancelled => {
                warn!("AskUserQuestion tool channel closed, tool_id: {}", tool_id);
                let result = build_cancelled_user_question_result(&tool_input);
                Ok(vec![ToolResult::Result {
                    data: result.data,
                    result_for_assistant: Some(result.result_for_assistant),
                    image_attachments: None,
                }])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AskUserQuestionTool;
    use crate::agentic::tools::framework::{Tool, ToolUseContext};
    use crate::agentic::tools::user_input_manager::get_user_input_manager;
    use openbitfun_agent_runtime::user_questions::USER_INPUT_MODEL_ROUND_CONTEXT_KEY;
    use std::collections::HashMap;

    fn context_with_custom_data(custom_data: HashMap<String, serde_json::Value>) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data,
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn ask_user_question_is_hidden_for_acp_transport() {
        let tool = AskUserQuestionTool::new();
        let mut custom_data = HashMap::new();
        custom_data.insert(
            "acp_transport".to_string(),
            serde_json::Value::String("true".to_string()),
        );
        let context = context_with_custom_data(custom_data);

        assert!(!tool.is_available_in_context(Some(&context)).await);
    }

    #[tokio::test]
    async fn ask_user_question_remains_available_without_acp_transport() {
        let tool = AskUserQuestionTool::new();
        let context = context_with_custom_data(HashMap::new());

        assert!(tool.is_available_in_context(Some(&context)).await);
    }

    #[tokio::test]
    async fn ask_user_question_is_hidden_when_human_input_is_unavailable() {
        let tool = AskUserQuestionTool::new();
        let context = context_with_custom_data(HashMap::from([(
            "user_input_available".to_string(),
            serde_json::Value::Bool(false),
        )]));

        assert!(!tool.is_available_in_context(Some(&context)).await);
    }

    #[tokio::test]
    async fn ask_user_question_fails_without_waiting_when_human_input_is_unavailable() {
        let tool = AskUserQuestionTool::new();
        let context = context_with_custom_data(HashMap::from([(
            "user_input_available".to_string(),
            serde_json::Value::Bool(false),
        )]));
        let input = serde_json::json!({
            "questions": [{
                "question": "Continue?",
                "header": "Continue",
                "options": [
                    { "label": "Yes", "description": "Continue" },
                    { "label": "No", "description": "Stop" }
                ]
            }]
        });

        let error = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            tool.call_with_timeout(&input, &context, Some(std::time::Duration::from_secs(180))),
        )
        .await
        .expect("non-interactive question must not wait")
        .expect_err("non-interactive question must fail");

        assert!(error.to_string().contains("cannot accept interactive"));
    }

    #[test]
    fn ask_user_question_schema_defaults_multi_select_to_false() {
        let schema = AskUserQuestionTool::new().input_schema();
        let question_schema = &schema["properties"]["questions"]["items"];

        assert_eq!(
            question_schema["properties"]["multiSelect"]["default"],
            false
        );
        assert!(!question_schema["required"]
            .as_array()
            .expect("required array")
            .iter()
            .any(|value| value == "multiSelect"));
    }

    #[tokio::test]
    async fn pending_question_remains_replayable_until_the_tool_receives_an_answer() {
        let tool = AskUserQuestionTool::new();
        let unique = uuid::Uuid::new_v4().to_string();
        let session_id = format!("session-{unique}");
        let turn_id = format!("turn-{unique}");
        let round_id = format!("round-{unique}");
        let tool_id = format!("tool-{unique}");
        let mut context = context_with_custom_data(HashMap::from([(
            USER_INPUT_MODEL_ROUND_CONTEXT_KEY.to_string(),
            serde_json::json!(round_id),
        )]));
        context.session_id = Some(session_id.clone());
        context.dialog_turn_id = Some(turn_id.clone());
        context.tool_call_id = Some(tool_id.clone());
        let input = serde_json::json!({
            "questions": [{
                "question": "Continue?",
                "header": "Continue",
                "options": [
                    { "label": "Yes", "description": "Continue" },
                    { "label": "No", "description": "Stop" }
                ]
            }]
        });

        let call =
            tool.call_with_timeout(&input, &context, Some(std::time::Duration::from_secs(180)));
        tokio::pin!(call);
        let mailbox_registration = async {
            loop {
                let snapshot = get_user_input_manager().pending_question_snapshot(&session_id);
                if let Some(question) = snapshot.questions.first() {
                    assert_eq!(question.tool_id, tool_id);
                    assert_eq!(question.dialog_turn_id.as_deref(), Some(turn_id.as_str()));
                    assert_eq!(question.model_round_id.as_deref(), Some(round_id.as_str()));
                    assert_eq!(
                        {
                            let mut payload = question.questions.clone();
                            payload.as_object_mut().unwrap().remove("responseHostNowMs");
                            assert!(payload["responseDeadlineMs"].is_u64());
                            payload
                                .as_object_mut()
                                .unwrap()
                                .remove("responseDeadlineMs");
                            payload
                        },
                        serde_json::json!({
                            "questions": [{
                                "question": "Continue?",
                                "header": "Continue",
                                "options": [
                                    { "label": "Yes", "description": "Continue" },
                                    { "label": "No", "description": "Stop" }
                                ],
                                "multiSelect": false
                            }]
                        })
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        };
        tokio::pin!(mailbox_registration);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::select! {
                _ = &mut call => panic!("question Tool completed before receiving an answer"),
                _ = &mut mailbox_registration => {}
            }
        })
        .await
        .expect("question should enter the Runtime mailbox");

        get_user_input_manager()
            .send_answer(&tool_id, serde_json::json!({ "0": "Yes" }))
            .expect("answer should reach the waiting Tool");
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut call)
            .await
            .expect("answered Tool should resume")
            .expect("answered Tool should succeed");

        assert!(get_user_input_manager()
            .pending_question_snapshot(&session_id)
            .questions
            .is_empty());
    }
    #[tokio::test]
    async fn parent_controller_can_stop_and_cancel_child_question() {
        let unique = uuid::Uuid::new_v4().to_string();
        let child = format!("child-{unique}");
        let parent = format!("parent-{unique}");
        let mut context = context_with_custom_data(HashMap::from([(
            openbitfun_agent_runtime::user_questions::USER_INPUT_PARENT_CONTEXT_KEY.to_string(),
            serde_json::json!({ "session_id": parent, "dialog_turn_id": "parent-turn" }),
        )]));
        context.session_id = Some(child.clone());
        context.tool_call_id = Some(unique.clone());
        let input = serde_json::json!({"questions": [{
            "question": "Continue?", "header": "Continue", "options": [
                {"label": "Yes", "description": "Continue"}, {"label": "No", "description": "Stop"}
            ]
        }]});
        let task = tokio::spawn(async move {
            AskUserQuestionTool::new()
                .call_with_timeout(&input, &context, Some(std::time::Duration::from_secs(180)))
                .await
        });
        let manager = get_user_input_manager();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !manager.has_pending(&unique) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager.start_interaction(&parent, &unique).unwrap();
        assert_eq!(
            manager.pending_question_snapshot(&parent).questions[0]
                .dialog_turn_id
                .as_deref(),
            Some("parent-turn")
        );
        assert!(manager.start_interaction("unrelated", &unique).is_err());
        manager.cancel_for_session(&parent, &unique).unwrap();
        let result = task.await.unwrap().unwrap();
        match &result[0] {
            crate::agentic::tools::framework::ToolResult::Result { data, .. } => {
                assert_eq!(data["status"], "cancelled")
            }
            _ => panic!("expected cancellation result"),
        }
        assert!(manager
            .pending_question_snapshot(&child)
            .questions
            .is_empty());
    }

    #[test]
    fn timeout_is_configured_outside_the_tool_schema() {
        let tool = AskUserQuestionTool::new();
        let schema = tool.input_schema();
        assert!(schema["properties"].get("timeout_seconds").is_none());
        assert_eq!(schema["required"], serde_json::json!(["questions"]));
        assert!(tool.manages_own_execution_timeout());
    }
    async fn assert_question_times_out(timeout_seconds: Option<u32>) {
        let unique = uuid::Uuid::new_v4().to_string();
        let mut context = context_with_custom_data(HashMap::new());
        context.session_id = Some(unique.clone());
        context.tool_call_id = Some(unique.clone());
        let input = serde_json::json!({
            "questions": [{
                "question": "Continue?", "header": "Continue",
                "options": [
                    { "label": "Yes", "description": "Continue" },
                    { "label": "No", "description": "Stop" }
                ]
            }]
        });
        let expected = std::time::Duration::from_secs(u64::from(timeout_seconds.unwrap_or(180)));
        let started = tokio::time::Instant::now();
        let result = tokio::time::timeout(
            expected + std::time::Duration::from_secs(5),
            AskUserQuestionTool::new().call_with_timeout(&input, &context, Some(expected)),
        )
        .await
        .expect("question must finish without a user response")
        .unwrap();
        assert!(started.elapsed() >= expected);
        match &result[0] {
            crate::agentic::tools::framework::ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } => {
                assert_eq!(data["status"], "timeout");
                assert_eq!(
                    result_for_assistant.as_deref(),
                    Some("The user did not respond before the timeout. Skip the questions and continue execution.")
                );
            }
            _ => panic!("timeout must return a normal tool result"),
        }
        let manager = get_user_input_manager();
        assert!(manager
            .pending_question_snapshot(&unique)
            .questions
            .is_empty());
        assert!(!manager.has_pending(&unique));
        assert!(manager
            .send_answer(&unique, serde_json::json!({ "0": "Yes" }))
            .is_err());
    }

    #[tokio::test]
    async fn unanswered_question_times_out_and_rejects_late_answers() {
        assert_question_times_out(Some(1)).await;
    }

    #[tokio::test]
    async fn unanswered_question_honors_shorter_timeout() {
        assert_question_times_out(Some(1)).await;
    }
    #[tokio::test]
    async fn unanswered_question_honors_longer_timeout() {
        assert_question_times_out(Some(2)).await;
    }
}
