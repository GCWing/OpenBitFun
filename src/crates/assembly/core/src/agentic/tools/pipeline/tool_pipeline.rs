//! Tool pipeline
//!
//! Manages the complete lifecycle of tools:
//! permission authorization, execution, caching, retries, etc.

use super::state_manager::{tool_task_state_kind, ToolStateManager};
use super::types::*;
use crate::agentic::core::{ToolCall, ToolExecutionState, ToolResult as ModelToolResult};
use crate::agentic::events::types::ToolEventData;
use crate::agentic::tools::computer_use_host::ComputerUseHostRef;
use crate::agentic::tools::framework::ToolResult as FrameworkToolResult;
use crate::agentic::tools::registry::ToolRegistry;
use crate::agentic::tools::tool_context_runtime;
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use crate::agentic::tools::tool_result_storage;
#[cfg(feature = "opencode-plugin-host")]
use crate::agentic::WorkspaceBinding;
use crate::native_hooks::{self, NativeHookSessionFacts};
use crate::util::elapsed_ms_u64;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use futures::future::join_all;
use log::{debug, error, info, warn};
use openbitfun_agent_runtime::permission::{
    plan_permission_intents, PendingPermissionReceiver, PermissionIntentPlan,
    PermissionRequestManager, PermissionWaitOutcome,
};
use openbitfun_agent_runtime::sdk::PermissionReplySource;
use openbitfun_agent_stream::ToolArgumentRepairKind;
use openbitfun_agent_tools::{
    build_invalid_tool_call_error_message, build_normal_tool_json_repair_notice,
    build_permission_denied_tool_presentation, build_tool_execution_error_presentation,
    build_tool_execution_timeout_presentation,
    build_user_rejected_tool_presentation_with_instruction,
    build_user_steering_interrupted_presentation, build_write_tail_closure_notice,
    render_tool_result_for_assistant, validate_tool_execution_admission, PermissionIntent,
    ResolvedToolInvocation, ToolExecutionAdmissionRejection, ToolExecutionAdmissionRequest,
    ToolExecutionErrorPresentation, GET_TOOL_SPEC_TOOL_NAME, USER_STEERING_INTERRUPTED_MESSAGE,
};
use openbitfun_runtime_ports::{
    PermissionReply, PermissionRequest, PermissionRequestSource, PermissionRequestSourceKind,
    PermissionResourceCaseSensitivity, RoundInjectionToolPreemption,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use tokio::sync::{Mutex as TokioMutex, RwLock as TokioRwLock};
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use tool_runtime::pipeline::{
    partition_tool_batches, retry_delay_ms, should_cancel_tool_state, should_retry_tool_attempt,
    summarize_dialog_turn_cancellation, tool_call_concurrency_safe_for_batch,
    ToolCancellationTokenStore, ToolExecutionErrorClass, ToolRetryAttemptFacts,
};

fn resolve_contextual_tool(
    tool: Arc<dyn crate::agentic::tools::framework::Tool>,
    context: &ToolUseContext,
) -> Option<Arc<dyn crate::agentic::tools::framework::Tool>> {
    #[cfg(feature = "external-sources")]
    {
        return crate::external_tools::resolve_external_tool_for_context(tool, context);
    }
    #[cfg(not(feature = "external-sources"))]
    {
        let _ = context;
        Some(tool)
    }
}

fn persisted_effective_tool_name(
    wire_tool_name: &str,
    effective_tool_name: &str,
) -> Option<String> {
    (wire_tool_name != effective_tool_name).then(|| effective_tool_name.to_string())
}

#[cfg(feature = "opencode-plugin-host")]
struct PluginAfterPresentation {
    title: String,
    output: String,
    metadata: serde_json::Value,
}

#[cfg(feature = "opencode-plugin-host")]
fn plugin_after_presentation(
    tool_name: &str,
    tool_result: &ModelToolResult,
) -> PluginAfterPresentation {
    let object = tool_result.result.as_object();
    let title = object
        .and_then(|value| value.get("title"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(tool_name)
        .to_string();
    let output = tool_result
        .result_for_assistant
        .clone()
        .or_else(|| {
            object
                .and_then(|value| value.get("output"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| tool_result.result.to_string());
    let metadata = object
        .and_then(|value| value.get("metadata"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"isError": tool_result.is_error}));
    PluginAfterPresentation {
        title,
        output,
        metadata,
    }
}

#[cfg(feature = "opencode-plugin-host")]
fn local_plugin_workspace_scope(workspace: &WorkspaceBinding) -> Option<String> {
    (!workspace.is_remote())
        .then(|| crate::plugin_host::canonical_plugin_workspace_scope(workspace.root_path()))
        .flatten()
}

/// Convert framework::ToolResult to core::ToolResult
///
/// Ensure always has result_for_assistant, avoid tool message content being empty
fn convert_tool_result(
    framework_result: FrameworkToolResult,
    tool_id: &str,
    wire_tool_name: &str,
    effective_tool_name: &str,
) -> ModelToolResult {
    match framework_result {
        FrameworkToolResult::Result {
            data,
            result_for_assistant,
            image_attachments,
        } => {
            // If the tool does not provide result_for_assistant, pass the full
            // structured result through to the model. Summaries like
            // "completed successfully" can hide fields the model needs for the
            // next decision.
            let assistant_text = result_for_assistant
                .or_else(|| Some(render_tool_result_for_assistant(effective_tool_name, &data)));
            // Tools with a typed response envelope can report a recoverable
            // domain failure without throwing away their structured error and
            // hints. Preserve that payload, but propagate its semantic status
            // so the tool card, hooks, persistence, and model all agree that
            // `{ ok: false }` is a failure rather than a completed operation.
            let is_error = data.get("ok").and_then(|value| value.as_bool()) == Some(false);

            ModelToolResult {
                tool_id: tool_id.to_string(),
                tool_name: wire_tool_name.to_string(),
                effective_tool_name: persisted_effective_tool_name(
                    wire_tool_name,
                    effective_tool_name,
                ),
                result: data,
                result_for_assistant: assistant_text,
                is_error,
                duration_ms: None,
                image_attachments,
            }
        }
        FrameworkToolResult::Progress { content, .. } => {
            let assistant_text = Some(render_tool_result_for_assistant(
                effective_tool_name,
                &content,
            ));

            ModelToolResult {
                tool_id: tool_id.to_string(),
                tool_name: wire_tool_name.to_string(),
                effective_tool_name: persisted_effective_tool_name(
                    wire_tool_name,
                    effective_tool_name,
                ),
                result: content,
                result_for_assistant: assistant_text,
                is_error: false,
                duration_ms: None,
                image_attachments: None,
            }
        }
        FrameworkToolResult::StreamChunk { data, .. } => {
            let assistant_text = Some(render_tool_result_for_assistant(effective_tool_name, &data));

            ModelToolResult {
                tool_id: tool_id.to_string(),
                tool_name: wire_tool_name.to_string(),
                effective_tool_name: persisted_effective_tool_name(
                    wire_tool_name,
                    effective_tool_name,
                ),
                result: data,
                result_for_assistant: assistant_text,
                is_error: false,
                duration_ms: None,
                image_attachments: None,
            }
        }
    }
}

fn resolve_pipeline_invocation(
    tool_call: &ToolCall,
    context: &ToolExecutionContext,
) -> (ResolvedToolInvocation, Option<String>) {
    let invocation = match ResolvedToolInvocation::from_wire_call(
        tool_call.tool_name.clone(),
        tool_call.arguments.clone(),
    ) {
        Ok(invocation) => invocation,
        Err(error) => {
            return (
                ResolvedToolInvocation::direct(
                    tool_call.tool_name.clone(),
                    tool_call.arguments.clone(),
                ),
                Some(error.to_string()),
            );
        }
    };

    if invocation.is_deferred()
        && !context
            .deferred_tools
            .iter()
            .any(|tool_name| tool_name == &invocation.effective_tool_name)
    {
        let effective_tool_name = invocation.effective_tool_name.clone();
        return (
            invocation,
            Some(format!(
                "Tool '{effective_tool_name}' is not an available deferred tool in the current context"
            )),
        );
    }

    (invocation, None)
}

/// Convert core::ToolResult to framework::ToolResult
fn convert_to_framework_result(model_result: &ModelToolResult) -> FrameworkToolResult {
    FrameworkToolResult::Result {
        data: model_result.result.clone(),
        result_for_assistant: model_result.result_for_assistant.clone(),
        image_attachments: model_result.image_attachments.clone(),
    }
}

fn elapsed_ms_since(time: SystemTime) -> u64 {
    time.elapsed()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn classify_tool_error(error: &OpenBitFunError) -> &'static str {
    match error {
        OpenBitFunError::Validation(_) => "invalid_arguments",
        OpenBitFunError::Cancelled(_) => "cancelled",
        OpenBitFunError::Timeout(_) => "timeout",
        OpenBitFunError::NotFound(_) => "not_found",
        _ => "execution_error",
    }
}

fn build_error_execution_result(
    task_id: &str,
    task: Option<ToolTask>,
    error: &OpenBitFunError,
) -> ToolExecutionResult {
    let error_message = error.to_string();
    let category = classify_tool_error(error);
    let (tool_id, wire_tool_name, effective_tool_name, execution_time_ms, provided_arguments) =
        if let Some(task) = task {
            // Parsed arguments are already present on the preceding tool call.
            // Preserve the complete provider output only when it could not be
            // parsed into that structured call.
            let provided_arguments = task
                .tool_call
                .is_error
                .then(|| task.tool_call.raw_arguments.clone())
                .flatten();
            (
                task.tool_call.tool_id,
                task.tool_call.tool_name,
                task.invocation.effective_tool_name,
                elapsed_ms_since(task.created_at),
                provided_arguments,
            )
        } else {
            warn!("Task not found in state manager: {}", task_id);
            (
                task_id.to_string(),
                "unknown".to_string(),
                "unknown".to_string(),
                0,
                None,
            )
        };
    let mut presentation = build_tool_execution_error_presentation(
        &effective_tool_name,
        category,
        &error_message,
        provided_arguments,
    );
    if let Some(detail) = error.tool_error_detail() {
        presentation.result_json["error_detail"] = serde_json::json!(detail);
    }
    let persisted_effective_tool_name =
        persisted_effective_tool_name(&wire_tool_name, &effective_tool_name);

    ToolExecutionResult {
        tool_id: tool_id.clone(),
        tool_name: wire_tool_name.clone(),
        effective_tool_name,
        result: ModelToolResult {
            tool_id,
            tool_name: wire_tool_name,
            effective_tool_name: persisted_effective_tool_name,
            result: presentation.result_json,
            result_for_assistant: Some(presentation.result_for_assistant),
            is_error: true,
            duration_ms: Some(execution_time_ms),
            image_attachments: None,
        },
        execution_time_ms,
    }
}

fn build_user_steering_interrupted_result(
    task_id: &str,
    task: Option<ToolTask>,
) -> ToolExecutionResult {
    let (tool_id, wire_tool_name, effective_tool_name, execution_time_ms) = if let Some(task) = task
    {
        (
            task.tool_call.tool_id,
            task.tool_call.tool_name,
            task.invocation.effective_tool_name,
            elapsed_ms_since(task.created_at),
        )
    } else {
        warn!(
            "Task not found while building steering-interrupted result: {}",
            task_id
        );
        (
            task_id.to_string(),
            "unknown".to_string(),
            "unknown".to_string(),
            0,
        )
    };

    let presentation = build_user_steering_interrupted_presentation(&effective_tool_name);
    let persisted_effective_tool_name =
        persisted_effective_tool_name(&wire_tool_name, &effective_tool_name);

    ToolExecutionResult {
        tool_id: tool_id.clone(),
        tool_name: wire_tool_name.clone(),
        effective_tool_name,
        result: ModelToolResult {
            tool_id,
            tool_name: wire_tool_name,
            effective_tool_name: persisted_effective_tool_name,
            result: presentation.result_json,
            result_for_assistant: Some(presentation.result_for_assistant),
            is_error: true,
            duration_ms: Some(execution_time_ms),
            image_attachments: None,
        },
        execution_time_ms,
    }
}

fn build_user_rejected_tool_result(
    task_id: &str,
    task: Option<ToolTask>,
    feedback: Option<&str>,
) -> ToolExecutionResult {
    build_permission_rejected_tool_result(task_id, task, |tool_name| {
        build_user_rejected_tool_presentation_with_instruction(tool_name, feedback)
    })
}

fn build_permission_denied_tool_result(
    task_id: &str,
    task: Option<ToolTask>,
    reason: &str,
) -> ToolExecutionResult {
    build_permission_rejected_tool_result(task_id, task, |tool_name| {
        build_permission_denied_tool_presentation(tool_name, reason)
    })
}

fn build_permission_rejected_tool_result(
    task_id: &str,
    task: Option<ToolTask>,
    presentation_for: impl FnOnce(&str) -> ToolExecutionErrorPresentation,
) -> ToolExecutionResult {
    let (tool_id, wire_tool_name, effective_tool_name, execution_time_ms) = if let Some(task) = task
    {
        (
            task.tool_call.tool_id,
            task.tool_call.tool_name,
            task.invocation.effective_tool_name,
            elapsed_ms_since(task.created_at),
        )
    } else {
        warn!(
            "Task not found while building user-rejected result: {}",
            task_id
        );
        (
            task_id.to_string(),
            "unknown".to_string(),
            "unknown".to_string(),
            0,
        )
    };

    let presentation = presentation_for(&effective_tool_name);
    let persisted_effective_tool_name =
        persisted_effective_tool_name(&wire_tool_name, &effective_tool_name);

    ToolExecutionResult {
        tool_id: tool_id.clone(),
        tool_name: wire_tool_name.clone(),
        effective_tool_name,
        result: ModelToolResult {
            tool_id,
            tool_name: wire_tool_name,
            effective_tool_name: persisted_effective_tool_name,
            result: presentation.result_json,
            result_for_assistant: Some(presentation.result_for_assistant),
            is_error: false,
            duration_ms: Some(execution_time_ms),
            image_attachments: None,
        },
        execution_time_ms,
    }
}

const ROUND_INJECTION_RUNNING_TOOL_CANCELLED_MESSAGE: &str =
    "Tool execution cancelled because a pending round injection requested running-tool preemption for this turn.";

fn should_retry_tool_error(error: &OpenBitFunError) -> bool {
    if matches!(error, OpenBitFunError::OutcomeUnknown(_)) {
        return false;
    }
    matches!(
        error,
        OpenBitFunError::Timeout(_)
            | OpenBitFunError::Io(_)
            | OpenBitFunError::Http(_)
            | OpenBitFunError::Service(_)
            | OpenBitFunError::MCPError(_)
            | OpenBitFunError::ProcessError(_)
            | OpenBitFunError::Other(_)
    )
}

fn classify_tool_retry_error(error: &OpenBitFunError) -> ToolExecutionErrorClass {
    if should_retry_tool_error(error) {
        ToolExecutionErrorClass::Retryable
    } else {
        ToolExecutionErrorClass::Terminal
    }
}

fn map_tool_execution_admission_rejection(
    error: ToolExecutionAdmissionRejection,
) -> OpenBitFunError {
    match error {
        ToolExecutionAdmissionRejection::RuntimeRestriction(error) => error.into(),
        ToolExecutionAdmissionRejection::AllowedList(error) => {
            OpenBitFunError::Validation(error.to_string())
        }
        ToolExecutionAdmissionRejection::Deferred(error) => {
            OpenBitFunError::Validation(error.to_string())
        }
    }
}

fn recovered_write_has_potentially_truncated_marked_path(
    tool_name: &str,
    arguments: &serde_json::Value,
    repair_kind: ToolArgumentRepairKind,
    recovered_from_truncation: bool,
) -> bool {
    (repair_kind.is_write_tail_closure() || recovered_from_truncation)
        && tool_name == "Write"
        && arguments
            .get("payload")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.starts_with("+++ ") && !value.contains('\n'))
}

enum PermissionAuthorization {
    Allowed,
    AllowedWithInput { updated_input: serde_json::Value },
    UserRejected { feedback: Option<String> },
    PolicyDenied { reason: String },
}

fn user_rejection_audit_reason(tool_name: &str, feedback: Option<&str>) -> String {
    match feedback {
        Some(feedback) => {
            format!("User rejected permission for tool '{tool_name}' with feedback: {feedback}")
        }
        None => format!("User rejected permission for tool '{tool_name}'"),
    }
}

#[derive(Debug)]
enum PermissionExecutionPlan {
    Allowed,
    Rejected { reason: String },
    Awaiting(Vec<PendingPermissionReceiver>),
}

#[derive(Debug, Clone)]
enum PermissionPlanDraft {
    Allowed,
    Rejected { reason: String },
    Requests(Vec<PermissionRequest>),
}

pub fn permission_project_id_for_workspace_identity(
    identity: &openbitfun_services_core::workspace_identity::WorkspaceSessionIdentity,
    is_remote: bool,
) -> OpenBitFunResult<String> {
    if !is_remote {
        return Ok(
            openbitfun_services_core::workspace_identity::local_workspace_stable_storage_id(
                identity.logical_workspace_path(),
            ),
        );
    }

    if identity.hostname == "_unresolved" {
        let connection_id = identity.remote_connection_id.as_deref().ok_or_else(|| {
            OpenBitFunError::validation(
                "Unresolved remote workspace permission identity has no connection id".to_string(),
            )
        })?;
        let key =
            openbitfun_services_core::workspace_identity::unresolved_remote_session_storage_key(
                connection_id,
                identity.logical_workspace_path(),
            );
        return Ok(format!("remote_unresolved_{key}"));
    }

    Ok(
        openbitfun_services_core::workspace_identity::remote_workspace_stable_id(
            &identity.hostname,
            identity.logical_workspace_path(),
        ),
    )
}

fn permission_project_id(context: &ToolUseContext) -> OpenBitFunResult<String> {
    let workspace = context.workspace.as_ref().ok_or_else(|| {
        OpenBitFunError::validation("A workspace is required for file permissions".to_string())
    })?;
    permission_project_id_for_workspace_identity(&workspace.session_identity, workspace.is_remote())
}

fn permission_project_path(context: &ToolUseContext) -> OpenBitFunResult<String> {
    let workspace = context.workspace.as_ref().ok_or_else(|| {
        OpenBitFunError::validation("A workspace is required for file permissions".to_string())
    })?;
    Ok(workspace
        .session_identity
        .logical_workspace_path()
        .to_string())
}

const ACCOUNT_PERMISSION_SCOPE: &str = "account";
const ACCOUNT_PERMISSION_PROJECT_ID: &str = "__openbitfun_account_actions__";
const ACCOUNT_PERMISSION_PROJECT_PATH: &str = "GitHub account";

fn permission_scope(
    context: &ToolUseContext,
    intents: &[PermissionIntent],
) -> OpenBitFunResult<(String, String)> {
    if context.workspace.is_some() {
        return Ok((
            permission_project_id(context)?,
            permission_project_path(context)?,
        ));
    }

    let account_scoped = intents.iter().all(|intent| {
        intent
            .display_metadata
            .get("permissionScope")
            .and_then(serde_json::Value::as_str)
            == Some(ACCOUNT_PERMISSION_SCOPE)
    });
    if account_scoped {
        return Ok((
            ACCOUNT_PERMISSION_PROJECT_ID.to_string(),
            ACCOUNT_PERMISSION_PROJECT_PATH.to_string(),
        ));
    }

    Err(OpenBitFunError::validation(
        "A workspace is required for file permissions".to_string(),
    ))
}

fn permission_resource_case_sensitivity(
    context: &ToolUseContext,
) -> PermissionResourceCaseSensitivity {
    if context.is_remote() || !cfg!(windows) {
        PermissionResourceCaseSensitivity::Sensitive
    } else {
        PermissionResourceCaseSensitivity::Insensitive
    }
}

const SUBAGENT_LAUNCH_TOOL_NAMES: &[&str] = &["Task", "AgentSpawn"];

/// Native hook session facts derived from one tool task.
fn native_hook_session_facts<'a>(
    context: &'a ToolExecutionContext,
    options: &ToolExecutionOptions,
) -> NativeHookSessionFacts<'a> {
    NativeHookSessionFacts {
        session_id: &context.session_id,
        turn_id: Some(&context.dialog_turn_id),
        workspace_root: context
            .workspace
            .as_ref()
            .map(|workspace| workspace.root_path()),
        is_remote_workspace: context
            .workspace
            .as_ref()
            .is_some_and(|workspace| workspace.is_remote()),
        model: &context.primary_model_facts.model_id,
        bypass_permissions: options.auto_approve_ask,
    }
}

/// Tool pipeline
#[derive(Clone)]
pub struct ToolPipeline {
    tool_registry: Arc<TokioRwLock<ToolRegistry>>,
    state_manager: Arc<ToolStateManager>,
    cancellation_tokens: ToolCancellationTokenStore,
    computer_use_host: Option<ComputerUseHostRef>,
    permission_request_manager: Option<Arc<PermissionRequestManager>>,
    permission_plans: Arc<TokioMutex<HashMap<String, PermissionExecutionPlan>>>,
    /// Tool task ids a PreToolUse hook approved. The approval waives the
    /// interactive permission prompt only; policy denials still apply.
    hook_preapprovals: Arc<TokioMutex<HashSet<String>>>,
}

impl ToolPipeline {
    pub fn new(
        tool_registry: Arc<TokioRwLock<ToolRegistry>>,
        state_manager: Arc<ToolStateManager>,
        computer_use_host: Option<ComputerUseHostRef>,
    ) -> Self {
        Self {
            tool_registry,
            state_manager,
            cancellation_tokens: ToolCancellationTokenStore::new(),
            computer_use_host,
            permission_request_manager: None,
            permission_plans: Arc::new(TokioMutex::new(HashMap::new())),
            hook_preapprovals: Arc::new(TokioMutex::new(HashSet::new())),
        }
    }

    pub fn with_permission_request_manager(
        mut self,
        permission_request_manager: Arc<PermissionRequestManager>,
    ) -> Self {
        self.permission_request_manager = Some(permission_request_manager);
        self
    }

    pub fn computer_use_host(&self) -> Option<ComputerUseHostRef> {
        self.computer_use_host.clone()
    }

    async fn draft_permission_plan(
        &self,
        task: ToolTask,
        tool_name: String,
        intents: Vec<PermissionIntent>,
        context: ToolUseContext,
    ) -> OpenBitFunResult<PermissionPlanDraft> {
        if intents.is_empty() {
            return Ok(PermissionPlanDraft::Allowed);
        }

        let (project_id, project_path) = permission_scope(&context, &intents)?;
        let permission_policy = task.options.permission_policy.clone();
        let case_sensitivity = permission_resource_case_sensitivity(&context);
        let round_id = task.context.round_id.clone();
        let tool_call_id = task.tool_call.tool_id.clone();
        let session_id = task.context.session_id.clone();
        let agent_type = task.context.agent_type.clone();
        let permission_delegation = task.context.permission_delegation.clone().or_else(|| {
            task.context
                .subagent_parent_info
                .as_ref()
                .map(|parent| parent.permission_delegation_context(&agent_type))
        });
        let manager = self.permission_request_manager.clone();
        let grants = match manager {
            Some(ref manager) => manager
                .list_project_grants(&project_id)
                .await
                .map_err(|error| OpenBitFunError::service(error.to_string()))?,
            None => Vec::new(),
        };
        let asks =
            match plan_permission_intents(intents, &permission_policy, &grants, case_sensitivity) {
                PermissionIntentPlan::Allowed => return Ok(PermissionPlanDraft::Allowed),
                PermissionIntentPlan::Denied(intent) => {
                    return Ok(PermissionPlanDraft::Rejected {
                        reason: format!(
                            "Permission policy denied '{}' for {}",
                            intent.action,
                            intent.resources.join(", ")
                        ),
                    });
                }
                PermissionIntentPlan::RequiresApproval(intents) => intents,
            };

        // A PreToolUse hook already approved this call. The approval reaches
        // here — after policy evaluation — precisely so that it waives only
        // the interactive prompt: a policy Deny above has already returned.
        if self.hook_preapprovals.lock().await.contains(&tool_call_id) {
            return Ok(PermissionPlanDraft::Allowed);
        }

        // The tool call would prompt the user: give PermissionRequest hooks
        // a chance to decide first. An explicit hook decision replaces the
        // interactive prompt for this invocation.
        if let Some(hook_decision) = native_hooks::dispatch_permission_request(
            native_hook_session_facts(&task.context, &task.options),
            &tool_name,
            &task.invocation.effective_arguments,
        )
        .await
        {
            if hook_decision.allow {
                info!(
                    "PermissionRequest hook allowed tool call without prompting: tool_name={}",
                    tool_name
                );
                return Ok(PermissionPlanDraft::Allowed);
            }
            let reason = hook_decision.message.unwrap_or_else(|| {
                format!("A PermissionRequest hook denied the '{tool_name}' tool call.")
            });
            info!(
                "PermissionRequest hook denied tool call: tool_name={}",
                tool_name
            );
            return Ok(PermissionPlanDraft::Rejected { reason });
        }

        if manager.is_none() {
            return Err(OpenBitFunError::service(
                "Permission request manager is unavailable for a file tool request".to_string(),
            ));
        }

        let requests = asks
            .into_iter()
            .map(|intent| PermissionRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                round_id: round_id.clone(),
                order: task.tool_call_order,
                tool_call_id: Some(tool_call_id.clone()),
                project_path: Some(project_path.clone()),
                project_id: project_id.clone(),
                session_id: session_id.clone(),
                agent_id: agent_type.clone(),
                action: intent.action,
                resources: intent.resources,
                save_resources: intent.save_resources,
                source: PermissionRequestSource {
                    kind: PermissionRequestSourceKind::ToolCall,
                    identity: tool_name.clone(),
                },
                delegation: permission_delegation.clone(),
                display_metadata: intent.display_metadata,
            })
            .collect();

        Ok(PermissionPlanDraft::Requests(requests))
    }

    async fn register_permission_requests(
        &self,
        requests: Vec<PermissionRequest>,
        dialog_turn_id: &str,
        auto_approve: bool,
    ) -> OpenBitFunResult<Vec<PendingPermissionReceiver>> {
        let manager = self.permission_request_manager.as_ref().ok_or_else(|| {
            OpenBitFunError::service(
                "Permission request manager is unavailable for a file tool request".to_string(),
            )
        })?;

        let receivers = if auto_approve {
            manager
                .register_batch_non_interactive_for_turn(
                    requests.clone(),
                    dialog_turn_id.to_string(),
                )
                .await
        } else {
            manager
                .register_batch_for_turn(requests.clone(), dialog_turn_id.to_string())
                .await
        }
        .map_err(|error| OpenBitFunError::service(error.to_string()))?;

        if auto_approve {
            for request in &requests {
                if let Err(error) = manager
                    .reply(
                        &request.request_id,
                        PermissionReply::Once,
                        openbitfun_runtime_ports::PermissionReplySource::AutoApprove,
                    )
                    .await
                {
                    self.cancel_permission_request_ids(
                        requests
                            .iter()
                            .map(|request| request.request_id.clone())
                            .collect(),
                        "Automatic permission approval failed".to_string(),
                    )
                    .await;
                    return Err(OpenBitFunError::service(error.to_string()));
                }
            }
        }

        Ok(receivers)
    }

    async fn non_relaxable_original_input_rejection(
        &self,
        task: &ToolTask,
        updated_input: &serde_json::Value,
    ) -> Option<openbitfun_agent_tools::ValidationResult> {
        if updated_input == &task.original_effective_arguments {
            return None;
        }

        let tool_context = self.build_tool_use_context(task, CancellationToken::new());
        let tool = {
            let registry = self.tool_registry.read().await;
            registry
                .get_tool(task.effective_tool_name())
                .and_then(|tool| resolve_contextual_tool(tool, &tool_context))
        }?;
        let validation = tool
            .validate_input_rewrite_invariants(
                &task.original_effective_arguments,
                Some(&tool_context),
            )
            .await;
        validation.blocks_input_rewrite().then_some(validation)
    }

    async fn apply_hook_input_rewrite(
        &self,
        task: &ToolTask,
        updated_input: serde_json::Value,
    ) -> bool {
        let rejection = self
            .non_relaxable_original_input_rejection(task, &updated_input)
            .await;
        let blocked = rejection.is_some();
        if self.state_manager.apply_hook_input_rewrite(
            &task.tool_call.tool_id,
            updated_input,
            rejection,
        ) {
            info!(
                "PreToolUse hook rewrote tool arguments: tool_name={}, tool_id={}, blocked_by_original_input={}",
                task.effective_tool_name(),
                task.tool_call.tool_id,
                blocked
            );
        }
        blocked
    }

    /// Run PreToolUse hooks for every valid task and record their decisions
    /// as pre-seeded permission plans. `updatedInput` becomes the final input,
    /// but cannot relax non-relaxable validation of the original input.
    async fn apply_pre_tool_use_hooks(&self, task_ids: &[String]) {
        for task_id in task_ids {
            let Some(mut task) = self.state_manager.get_task(task_id) else {
                continue;
            };
            if task.invocation_resolution_error.is_some()
                || task.tool_call.tool_name.is_empty()
                || task.tool_call.is_error
            {
                continue;
            }
            let tool_name = task.invocation.effective_tool_name.clone();
            #[cfg(feature = "opencode-plugin-host")]
            if let Some(workspace_scope) = task
                .context
                .workspace
                .as_ref()
                .and_then(local_plugin_workspace_scope)
            {
                match native_hooks::dispatch_plugin_tool_before(
                    &workspace_scope,
                    &tool_name,
                    Some(&task.context.session_id),
                    Some(&task.tool_call.tool_id),
                    Some(&task.context.agent_type),
                    task.invocation.effective_arguments.clone(),
                )
                .await
                {
                    Ok(Some(updated_input)) => {
                        if self.apply_hook_input_rewrite(&task, updated_input).await {
                            info!(
                                "OpenCode plugin hook rewrite was rejected by original-input constraints: tool_name={}, tool_id={}",
                                tool_name, task_id
                            );
                            continue;
                        }
                        let Some(updated_task) = self.state_manager.get_task(task_id) else {
                            continue;
                        };
                        task = updated_task;
                    }
                    Ok(None) => {}
                    Err(reason) => {
                        error!(
                            "OpenCode plugin before hook rejected tool execution: tool_name={}, tool_id={}, error={}",
                            tool_name, task_id, reason
                        );
                        self.permission_plans.lock().await.insert(
                            task_id.clone(),
                            PermissionExecutionPlan::Rejected {
                                reason: format!("OpenCode plugin before hook failed: {reason}"),
                            },
                        );
                        continue;
                    }
                }
            }
            let decision = native_hooks::dispatch_pre_tool_use(
                native_hook_session_facts(&task.context, &task.options),
                &tool_name,
                &task.tool_call.tool_id,
                &task.invocation.effective_arguments,
            )
            .await;
            if let Some(updated_input) = decision.updated_input {
                if self.apply_hook_input_rewrite(&task, updated_input).await {
                    info!(
                        "PreToolUse hook rewrite was rejected by original-input constraints: tool_name={}, tool_id={}",
                        tool_name, task_id
                    );
                    // A hook allow decision cannot override this internal
                    // rejection. Execution reports the stored validation
                    // reason without invoking the tool.
                    continue;
                }
            }
            if let Some(reason) = decision.deny_reason {
                // A hook denial is strictly more restrictive than the
                // permission policy, so it can short-circuit planning.
                info!(
                    "PreToolUse hook denied tool call: tool_name={}, tool_id={}",
                    tool_name, task_id
                );
                self.permission_plans.lock().await.insert(
                    task_id.clone(),
                    PermissionExecutionPlan::Rejected { reason },
                );
            } else if decision.allow {
                // A hook approval only waives the interactive prompt. It is
                // recorded for the planner rather than short-circuiting it,
                // so a policy Deny still rejects the call.
                info!(
                    "PreToolUse hook approved tool call without prompting: tool_name={}, tool_id={}",
                    tool_name, task_id
                );
                self.hook_preapprovals.lock().await.insert(task_id.clone());
            }
        }
    }

    async fn execution_traits_for_final_inputs(
        &self,
        task_ids: &[String],
        subagent_call_count: usize,
        subagent_batch_execution_policy: SubagentBatchExecutionPolicy,
    ) -> Vec<(bool, bool)> {
        let registry = self.tool_registry.read().await;
        task_ids
            .iter()
            .map(|task_id| {
                let Some(task) = self.state_manager.get_task(task_id) else {
                    return (false, false);
                };
                if task.invocation_resolution_error.is_some() {
                    return (false, false);
                }
                let tool_context = self.build_tool_use_context(&task, CancellationToken::new());
                let tool = registry
                    .get_tool(task.effective_tool_name())
                    .and_then(|tool| resolve_contextual_tool(tool, &tool_context));
                let tool_is_concurrency_safe = tool
                    .as_ref()
                    .map(|tool| tool.is_concurrency_safe(Some(task.effective_arguments())))
                    .unwrap_or(false);
                let concurrency_safe = tool_call_concurrency_safe_for_batch(
                    task.effective_tool_name(),
                    tool_is_concurrency_safe,
                    subagent_call_count,
                    subagent_batch_execution_policy,
                );
                let round_injection_yieldable = tool
                    .as_ref()
                    .is_some_and(|tool| tool.round_injection_yieldable());
                (concurrency_safe, round_injection_yieldable)
            })
            .collect()
    }

    /// Give the OpenCode after-hook the complete model-visible output before
    /// large-result storage replaces it with a file reference.
    async fn apply_plugin_post_tool_use_hook(
        &self,
        task: &ToolTask,
        tool_name: &str,
        tool_id: &str,
        tool_result: &mut ModelToolResult,
    ) {
        #[cfg(feature = "opencode-plugin-host")]
        if let Some(workspace_scope) = task
            .context
            .workspace
            .as_ref()
            .and_then(local_plugin_workspace_scope)
        {
            let presentation = plugin_after_presentation(tool_name, tool_result);
            match native_hooks::dispatch_plugin_tool_after(
                &workspace_scope,
                tool_name,
                Some(&task.context.session_id),
                Some(tool_id),
                Some(&task.context.agent_type),
                task.invocation.effective_arguments.clone(),
                presentation.title,
                presentation.output,
                presentation.metadata,
            )
            .await
            {
                Ok(Some(transformed)) => {
                    // Keep the canonical raw tool result immutable for audit
                    // and persistence. OpenCode's presentation output is the
                    // model-visible result consumed by the rest of the turn.
                    tool_result.result_for_assistant = Some(transformed.into_model_output());
                }
                Ok(None) => {}
                Err(reason) => {
                    // The tool has already executed. Surface the hook failure
                    // on this result without returning to the retry loop.
                    error!(
                        "OpenCode plugin after hook failed after tool execution: tool_name={}, tool_id={}, error={}",
                        tool_name, tool_id, reason
                    );
                    let original = tool_result.result_for_assistant.take().unwrap_or_default();
                    let failure = format!("OpenCode plugin after hook failed: {reason}");
                    tool_result.result_for_assistant = Some(if original.is_empty() {
                        failure
                    } else {
                        format!("{original}\n\n{failure}")
                    });
                    tool_result.is_error = true;
                }
            }
        }
    }

    /// Run native PostToolUse hooks after storage compaction and fold blocking
    /// feedback and additional context into the model-visible result text.
    async fn apply_native_post_tool_use_hooks(
        &self,
        task: &ToolTask,
        tool_name: &str,
        tool_id: &str,
        tool_result: &mut ModelToolResult,
    ) {
        let tool_response = serde_json::json!({
            "result": match &tool_result.result_for_assistant {
                Some(text) => serde_json::Value::String(text.clone()),
                None => tool_result.result.clone(),
            },
            "is_error": tool_result.is_error,
        });
        let decision = native_hooks::dispatch_post_tool_use(
            native_hook_session_facts(&task.context, &task.options),
            tool_name,
            tool_id,
            &task.invocation.effective_arguments,
            &tool_response,
        )
        .await;
        let mut hook_sections = Vec::new();
        if let Some(reason) = decision.block_reason {
            info!(
                "PostToolUse hook returned blocking feedback: tool_name={}, tool_id={}",
                tool_name, tool_id
            );
            hook_sections.push(format!("PostToolUse hook feedback (blocking): {reason}"));
        }
        for context in decision.additional_context {
            hook_sections.push(format!("PostToolUse hook context: {context}"));
        }
        if hook_sections.is_empty() {
            return;
        }
        let original = tool_result.result_for_assistant.take().unwrap_or_default();
        let appended = hook_sections.join("\n");
        tool_result.result_for_assistant = Some(if original.is_empty() {
            appended
        } else {
            format!("{original}\n\n{appended}")
        });
    }

    async fn prepare_permission_plans(&self, task_ids: &[String]) -> OpenBitFunResult<()> {
        let mut drafts = Vec::with_capacity(task_ids.len());
        let mut ordered_requests = Vec::new();

        for task_id in task_ids {
            // A PreToolUse hook decision already produced a plan for this
            // task; keep it instead of drafting (and possibly prompting).
            if self.permission_plans.lock().await.contains_key(task_id) {
                continue;
            }
            let Some(task) = self.state_manager.get_task(task_id) else {
                continue;
            };
            if task.input_rewrite_rejection.is_some() {
                continue;
            }
            let tool_name = task.invocation.effective_tool_name.clone();
            if task.invocation_resolution_error.is_some()
                || task.tool_call.tool_name.is_empty()
                || task.tool_call.is_error
                || recovered_write_has_potentially_truncated_marked_path(
                    &tool_name,
                    &task.invocation.effective_arguments,
                    task.tool_call.repair_kind,
                    task.tool_call.recovered_from_truncation,
                )
            {
                continue;
            }
            let tool = {
                let registry = self.tool_registry.read().await;
                if validate_tool_execution_admission(ToolExecutionAdmissionRequest {
                    tool_name: &tool_name,
                    allowed_tools: &task.context.allowed_tools,
                    runtime_tool_restrictions: &task.context.runtime_tool_restrictions,
                    deferred_tools: &task.context.deferred_tools,
                    loaded_deferred_tool_specs: &task.context.loaded_deferred_tool_specs,
                    current_catalog_generation: registry.current_snapshot_generation(),
                    get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
                })
                .is_err()
                {
                    continue;
                }
                registry.get_tool(&tool_name)
            };
            let Some(tool) = tool else {
                continue;
            };
            let tool_context = self.build_tool_use_context(&task, CancellationToken::new());
            let validation = tool
                .validate_input(&task.invocation.effective_arguments, Some(&tool_context))
                .await;
            if !validation.result {
                continue;
            }
            let intents =
                tool.permission_intents(&task.invocation.effective_arguments, &tool_context)?;
            let draft = self
                .draft_permission_plan(
                    task.clone(),
                    tool_name.clone(),
                    intents,
                    tool_context.clone(),
                )
                .await?;
            if let PermissionPlanDraft::Requests(requests) = &draft {
                ordered_requests.extend(
                    requests
                        .iter()
                        .cloned()
                        .map(|request| (task_id.clone(), request)),
                );
            }
            drafts.push((task_id.clone(), draft));
        }

        if !ordered_requests.is_empty() {
            let batch_requests = ordered_requests
                .iter()
                .map(|(_, request)| request.clone())
                .collect::<Vec<_>>();
            let auto_approve = task_ids
                .first()
                .and_then(|task_id| self.state_manager.get_task(task_id))
                .is_some_and(|task| task.options.auto_approve_ask);
            let dialog_turn_id = task_ids
                .first()
                .and_then(|task_id| self.state_manager.get_task(task_id))
                .map(|task| task.context.dialog_turn_id)
                .ok_or_else(|| {
                    OpenBitFunError::service(
                        "Permission batch lost its owning Dialog Turn".to_string(),
                    )
                })?;
            let receivers = self
                .register_permission_requests(batch_requests, &dialog_turn_id, auto_approve)
                .await?;

            let mut receivers_by_task = HashMap::<String, Vec<PendingPermissionReceiver>>::new();
            for ((task_id, _), receiver) in ordered_requests.into_iter().zip(receivers) {
                receivers_by_task.entry(task_id).or_default().push(receiver);
            }
            for (task_id, draft) in &drafts {
                if let PermissionPlanDraft::Requests(_) = draft {
                    let receivers = receivers_by_task.remove(task_id).ok_or_else(|| {
                        OpenBitFunError::service(format!(
                            "Permission plan lost its pending receivers for tool task '{task_id}'"
                        ))
                    })?;
                    self.permission_plans.lock().await.insert(
                        task_id.clone(),
                        PermissionExecutionPlan::Awaiting(receivers),
                    );
                }
            }
        }

        for (task_id, draft) in drafts {
            match draft {
                PermissionPlanDraft::Allowed => {
                    self.permission_plans
                        .lock()
                        .await
                        .insert(task_id, PermissionExecutionPlan::Allowed);
                }
                PermissionPlanDraft::Rejected { reason } => {
                    self.permission_plans
                        .lock()
                        .await
                        .insert(task_id, PermissionExecutionPlan::Rejected { reason });
                }
                PermissionPlanDraft::Requests(_) => {}
            }
        }

        Ok(())
    }

    async fn await_prepared_permission_plan(
        &self,
        task_id: &str,
        cancellation_token: &CancellationToken,
    ) -> OpenBitFunResult<PermissionAuthorization> {
        let Some(plan) = self.permission_plans.lock().await.remove(task_id) else {
            return Ok(PermissionAuthorization::Allowed);
        };

        self.await_permission_execution_plan(plan, cancellation_token)
            .await
    }

    async fn await_permission_execution_plan(
        &self,
        plan: PermissionExecutionPlan,
        cancellation_token: &CancellationToken,
    ) -> OpenBitFunResult<PermissionAuthorization> {
        let receivers = match plan {
            PermissionExecutionPlan::Allowed => return Ok(PermissionAuthorization::Allowed),
            PermissionExecutionPlan::Rejected { reason } => {
                return Ok(PermissionAuthorization::PolicyDenied { reason });
            }
            PermissionExecutionPlan::Awaiting(receivers) => receivers,
        };

        let mut updated_input = serde_json::Map::new();
        let mut receivers = receivers.into_iter();
        while let Some(pending) = receivers.next() {
            let request_id = pending.request_id().to_string();
            let outcome = tokio::select! {
                outcome = pending.wait() => outcome,
                _ = cancellation_token.cancelled() => {
                    let remaining = std::iter::once(request_id.clone())
                        .chain(receivers.map(|pending| pending.request_id().to_string()));
                    self.cancel_permission_request_ids(
                        remaining.collect(),
                        "Tool execution was cancelled".to_string(),
                    )
                    .await;
                    return Err(OpenBitFunError::Cancelled(
                        "Tool execution was cancelled while awaiting permission".to_string(),
                    ));
                }
            };

            match outcome {
                PermissionWaitOutcome::Replied(PermissionReply::Once | PermissionReply::Always) => {
                }
                PermissionWaitOutcome::Replied(PermissionReply::OnceWithInput {
                    updated_input: patch,
                }) => {
                    let patch = patch.as_object().ok_or_else(|| {
                        OpenBitFunError::Validation(
                            "Edited approval input must be an object".to_string(),
                        )
                    })?;
                    updated_input.extend(patch.clone());
                }
                PermissionWaitOutcome::Replied(PermissionReply::Reject { feedback }) => {
                    self.cancel_permission_request_ids(
                        receivers
                            .map(|pending| pending.request_id().to_string())
                            .collect(),
                        "Another permission request for this tool was rejected".to_string(),
                    )
                    .await;
                    let feedback = feedback
                        .map(|feedback| feedback.trim().to_string())
                        .filter(|feedback| !feedback.is_empty());
                    return Ok(PermissionAuthorization::UserRejected { feedback });
                }
                PermissionWaitOutcome::Cancelled { reason } => {
                    self.cancel_permission_request_ids(
                        receivers
                            .map(|pending| pending.request_id().to_string())
                            .collect(),
                        "Another permission request for this tool was cancelled".to_string(),
                    )
                    .await;
                    return Err(OpenBitFunError::Cancelled(reason));
                }
            }

            if cancellation_token.is_cancelled() {
                self.cancel_permission_request_ids(
                    receivers
                        .map(|pending| pending.request_id().to_string())
                        .collect(),
                    "Tool execution was cancelled".to_string(),
                )
                .await;
                return Err(OpenBitFunError::Cancelled(
                    "Tool execution was cancelled after permission reply".to_string(),
                ));
            }
        }

        Ok(if updated_input.is_empty() {
            PermissionAuthorization::Allowed
        } else {
            PermissionAuthorization::AllowedWithInput {
                updated_input: serde_json::Value::Object(updated_input),
            }
        })
    }

    async fn cancel_permission_request_ids(&self, request_ids: Vec<String>, reason: String) {
        let Some(manager) = self.permission_request_manager.as_ref() else {
            return;
        };
        for request_id in request_ids {
            if let Err(error) = manager.cancel_request(&request_id, reason.clone()).await {
                warn!(
                    "Failed to cancel prepared permission request: request_id={}, error={}",
                    request_id, error
                );
            }
        }
    }

    async fn cleanup_permission_plans(&self, task_ids: &[String], reason: String) {
        {
            // Hook approvals are scoped to the batch that produced them; a
            // later call must be evaluated on its own merits.
            let mut preapprovals = self.hook_preapprovals.lock().await;
            for task_id in task_ids {
                preapprovals.remove(task_id);
            }
        }
        for task_id in task_ids {
            let Some(plan) = self.permission_plans.lock().await.remove(task_id) else {
                continue;
            };
            if let PermissionExecutionPlan::Awaiting(receivers) = plan {
                self.cancel_permission_request_ids(
                    receivers
                        .into_iter()
                        .map(|pending| pending.request_id().to_string())
                        .collect(),
                    reason.clone(),
                )
                .await;
            }
        }
    }

    async fn authorize_permission_intents(
        &self,
        task: &ToolTask,
        tool_name: &str,
        intents: Vec<PermissionIntent>,
        context: &ToolUseContext,
        cancellation_token: &CancellationToken,
    ) -> OpenBitFunResult<PermissionAuthorization> {
        let draft = self
            .draft_permission_plan(
                task.clone(),
                tool_name.to_string(),
                intents,
                context.clone(),
            )
            .await?;
        let plan = match draft {
            PermissionPlanDraft::Allowed => PermissionExecutionPlan::Allowed,
            PermissionPlanDraft::Rejected { reason } => {
                PermissionExecutionPlan::Rejected { reason }
            }
            PermissionPlanDraft::Requests(requests) => PermissionExecutionPlan::Awaiting(
                self.register_permission_requests(
                    requests,
                    &task.context.dialog_turn_id,
                    task.options.auto_approve_ask,
                )
                .await?,
            ),
        };

        self.await_permission_execution_plan(plan, cancellation_token)
            .await
    }

    fn pending_round_injection_tool_preemption(
        &self,
        context: &ToolExecutionContext,
    ) -> RoundInjectionToolPreemption {
        context
            .steering_interrupt
            .as_ref()
            .map(|interrupt| interrupt.pending_tool_preemption())
            .unwrap_or(RoundInjectionToolPreemption::None)
    }

    fn should_interrupt_for_round_injection(&self, context: &ToolExecutionContext) -> bool {
        self.pending_round_injection_tool_preemption(context)
            .should_interrupt_after_current_atomic_unit()
    }

    async fn build_steering_interrupted_results(
        &self,
        task_ids: impl IntoIterator<Item = String>,
    ) -> Vec<ToolExecutionResult> {
        let mut results = Vec::new();
        for task_id in task_ids {
            let task = self.state_manager.get_task(&task_id);
            self.state_manager
                .update_state(
                    &task_id,
                    ToolExecutionState::Cancelled {
                        reason: USER_STEERING_INTERRUPTED_MESSAGE.to_string(),
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                )
                .await;
            results.push(build_user_steering_interrupted_result(&task_id, task));
        }
        results
    }

    fn append_execution_result(
        &self,
        task_id: &str,
        result: OpenBitFunResult<ToolExecutionResult>,
        all_results: &mut Vec<ToolExecutionResult>,
    ) {
        match result {
            Ok(execution_result) => all_results.push(execution_result),
            Err(error) => {
                error!("Tool execution failed: error={}", error);
                let error_result = build_error_execution_result(
                    task_id,
                    self.state_manager.get_task(task_id),
                    &error,
                );
                all_results.push(error_result);
            }
        }
    }

    async fn preempt_tools_for_round_injection(
        &self,
        task_ids: impl IntoIterator<Item = String>,
        preemption: RoundInjectionToolPreemption,
    ) -> OpenBitFunResult<()> {
        for task_id in task_ids {
            let Some(task) = self.state_manager.get_task(&task_id) else {
                continue;
            };
            if tool_task_state_kind(&task.state).is_terminal() {
                continue;
            }

            if let Some(token) = task.round_injection_preemption_token {
                token.cancel();
            } else if preemption.should_cancel_running_tools() {
                self.cancel_tool(
                    &task_id,
                    ROUND_INJECTION_RUNNING_TOOL_CANCELLED_MESSAGE.to_string(),
                )
                .await?;
            }
        }
        Ok(())
    }

    fn spawn_round_injection_preemption_watch(
        &self,
        task_ids: Vec<String>,
        interrupt: Option<crate::agentic::round_preempt::DialogRoundInjectionInterrupt>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        interrupt.as_ref()?;

        let pipeline = self.clone();
        Some(tokio::spawn(async move {
            let Some(interrupt) = interrupt else {
                return;
            };

            loop {
                let preemption = interrupt.pending_tool_preemption();
                if preemption.should_interrupt_after_current_atomic_unit() {
                    let _ = pipeline
                        .preempt_tools_for_round_injection(task_ids, preemption)
                        .await;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }))
    }

    /// Execute multiple tool calls using partitioned mixed scheduling.
    ///
    /// Consecutive concurrency-safe calls are grouped into a single batch and
    /// run in parallel; each non-safe call forms its own batch and runs serially.
    /// Batches are executed in order so that write-after-read dependencies are
    /// respected while reads still benefit from parallelism.
    pub async fn execute_tools(
        &self,
        tool_calls: Vec<ToolCall>,
        context: ToolExecutionContext,
        options: ToolExecutionOptions,
    ) -> OpenBitFunResult<Vec<ToolExecutionResult>> {
        if tool_calls.is_empty() {
            return Ok(vec![]);
        }

        info!("Executing tools: count={}", tool_calls.len());
        let resolved_tool_calls = tool_calls
            .iter()
            .map(|tool_call| {
                let (invocation, resolution_error) =
                    resolve_pipeline_invocation(tool_call, &context);
                (tool_call.clone(), invocation, resolution_error)
            })
            .collect::<Vec<_>>();
        let tool_names = resolved_tool_calls
            .iter()
            .map(|(_, invocation, _)| invocation.effective_tool_name.clone())
            .collect::<Vec<_>>();

        let subagent_call_count = resolved_tool_calls
            .iter()
            .filter(|(_, invocation, _)| {
                SUBAGENT_LAUNCH_TOOL_NAMES.contains(&invocation.effective_tool_name.as_str())
            })
            .count();

        // Create tasks for all tool calls
        let mut task_ids = Vec::with_capacity(resolved_tool_calls.len());
        for (tool_call_order, (tool_call, invocation, resolution_error)) in
            resolved_tool_calls.into_iter().enumerate()
        {
            let mut task = ToolTask::new_resolved(
                tool_call,
                invocation,
                resolution_error,
                context.clone(),
                options.clone(),
            );
            task.tool_call_order = tool_call_order as u32;
            let tool_id = self.state_manager.create_task(task).await;
            task_ids.push(tool_id);
        }

        // PreToolUse hooks run before permission planning so a hook decision
        // (deny / pre-approve / rewritten input) is visible to the planner
        // and no permission prompt is raised for calls a hook already decided.
        self.apply_pre_tool_use_hooks(&task_ids).await;

        // Hook rewrites can change whether a command is concurrency-safe.
        // Resolve all execution traits from the final arguments, then attach
        // cooperative preemption tokens before scheduling starts.
        let execution_traits = self
            .execution_traits_for_final_inputs(
                &task_ids,
                subagent_call_count,
                options.subagent_batch_execution_policy,
            )
            .await;
        for (task_id, (_, round_injection_yieldable)) in
            task_ids.iter().zip(execution_traits.iter())
        {
            if *round_injection_yieldable {
                self.state_manager
                    .set_round_injection_preemption_token(task_id, Some(CancellationToken::new()));
            }
        }
        let concurrency_flags = execution_traits
            .iter()
            .map(|(concurrency_safe, _)| *concurrency_safe)
            .collect::<Vec<_>>();
        let concurrency_safe_count = concurrency_flags.iter().filter(|&&flag| flag).count();

        if let Err(error) = self.prepare_permission_plans(&task_ids).await {
            self.cleanup_permission_plans(&task_ids, "Permission planning failed".to_string())
                .await;
            return Err(error);
        }

        if !options.allow_parallel {
            debug!(
                "Tool execution plan: total_tools={}, batches=1, concurrency_safe={}, non_concurrency_safe={}, allow_parallel=false, tools={}",
                task_ids.len(),
                concurrency_safe_count,
                task_ids.len().saturating_sub(concurrency_safe_count),
                tool_names.join(", ")
            );
            let result = self.execute_sequential(task_ids.clone()).await;
            self.cleanup_permission_plans(&task_ids, "Tool execution finished".to_string())
                .await;
            return result;
        }

        // Partition into batches of consecutive same-safety tool calls
        let batches = partition_tool_batches(&task_ids, &concurrency_flags);
        debug!(
            "Tool execution plan: total_tools={}, batches={}, concurrency_safe={}, non_concurrency_safe={}, allow_parallel=true, tools={}",
            task_ids.len(),
            batches.len(),
            concurrency_safe_count,
            task_ids.len().saturating_sub(concurrency_safe_count),
            tool_names.join(", ")
        );

        debug!(
            "Partitioned {} tools into {} batches for mixed execution",
            task_ids.len(),
            batches.len()
        );

        let mut all_results = Vec::with_capacity(task_ids.len());
        let mut batch_iter = batches.into_iter().enumerate().peekable();
        while let Some((batch_idx, batch)) = batch_iter.next() {
            let batch_context = batch
                .task_ids
                .first()
                .and_then(|task_id| self.state_manager.get_task(task_id))
                .map(|task| task.context);
            if batch_context
                .as_ref()
                .is_some_and(|context| self.should_interrupt_for_round_injection(context))
            {
                let remaining_task_ids = batch
                    .task_ids
                    .into_iter()
                    .chain(batch_iter.flat_map(|(_, batch)| batch.task_ids.into_iter()));
                all_results.extend(
                    self.build_steering_interrupted_results(remaining_task_ids)
                        .await,
                );
                break;
            }

            debug!(
                "Executing batch {}: {} tool(s), concurrent={}",
                batch_idx,
                batch.task_ids.len(),
                batch.is_concurrent
            );
            let batch_results = if batch.is_concurrent {
                self.execute_parallel(batch.task_ids).await?
            } else {
                self.execute_sequential(batch.task_ids).await?
            };
            all_results.extend(batch_results);
        }

        self.cleanup_permission_plans(&task_ids, "Tool execution finished".to_string())
            .await;
        Ok(all_results)
    }

    /// Execute tools in parallel
    async fn execute_parallel(
        &self,
        task_ids: Vec<String>,
    ) -> OpenBitFunResult<Vec<ToolExecutionResult>> {
        let batch_interrupt = task_ids
            .first()
            .and_then(|task_id| self.state_manager.get_task(task_id))
            .and_then(|task| task.context.steering_interrupt.clone());
        let watch_handle =
            self.spawn_round_injection_preemption_watch(task_ids.clone(), batch_interrupt);

        let futures: Vec<_> = task_ids
            .iter()
            .map(|id| self.execute_single_tool(id.clone()))
            .collect();

        let results = join_all(futures).await;
        if let Some(handle) = watch_handle {
            handle.abort();
            let _ = handle.await;
        }

        // Collect results, including failed results
        let mut all_results = Vec::new();
        for (idx, result) in results.into_iter().enumerate() {
            let task_id = &task_ids[idx];
            self.append_execution_result(task_id, result, &mut all_results);
        }

        Ok(all_results)
    }

    /// Execute tools sequentially
    async fn execute_sequential(
        &self,
        task_ids: Vec<String>,
    ) -> OpenBitFunResult<Vec<ToolExecutionResult>> {
        let mut results = Vec::new();

        let mut task_iter = task_ids.into_iter().peekable();
        while let Some(task_id) = task_iter.next() {
            let task = self.state_manager.get_task(&task_id);
            if task
                .as_ref()
                .is_some_and(|task| self.should_interrupt_for_round_injection(&task.context))
            {
                let remaining_task_ids = std::iter::once(task_id).chain(task_iter);
                results.extend(
                    self.build_steering_interrupted_results(remaining_task_ids)
                        .await,
                );
                break;
            }

            let interrupt = task.and_then(|task| task.context.steering_interrupt.clone());
            let watch_handle =
                self.spawn_round_injection_preemption_watch(vec![task_id.clone()], interrupt);
            let result = self.execute_single_tool(task_id.clone()).await;
            if let Some(handle) = watch_handle {
                handle.abort();
                let _ = handle.await;
            }
            self.append_execution_result(&task_id, result, &mut results);
        }

        Ok(results)
    }

    /// Execute single tool
    async fn execute_single_tool(&self, tool_id: String) -> OpenBitFunResult<ToolExecutionResult> {
        let start_time = Instant::now();

        debug!("Starting tool execution: tool_id={}", tool_id);

        // Get task
        let mut task = self.state_manager.get_task(&tool_id).ok_or_else(|| {
            OpenBitFunError::NotFound(format!("Tool task not found: {}", tool_id))
        })?;

        let wire_tool_name = task.tool_call.tool_name.clone();
        let tool_name = task.invocation.effective_tool_name.clone();
        let tool_args = task.invocation.effective_arguments.clone();
        let tool_is_error = task.tool_call.is_error;
        let repair_kind = task.tool_call.repair_kind;
        let recovered_from_truncation =
            repair_kind.is_write_tail_closure() || task.tool_call.recovered_from_truncation;
        let queue_wait_ms = elapsed_ms_since(task.created_at);
        let confirmation_wait_ms = 0;

        debug!(
            "Tool task details: tool_name={}, wire_tool_name={}, tool_id={}, queue_wait_ms={}",
            tool_name, wire_tool_name, tool_id, queue_wait_ms
        );

        let invalid_call_error = if let Some(error) = task.invocation_resolution_error.clone() {
            Some(error)
        } else if wire_tool_name.is_empty() || tool_is_error {
            Some(build_invalid_tool_call_error_message(
                &wire_tool_name,
                tool_is_error,
                recovered_from_truncation,
                None,
            ))
        } else if recovered_write_has_potentially_truncated_marked_path(
            &tool_name,
            &tool_args,
            repair_kind,
            recovered_from_truncation,
        ) {
            Some(
                "Recovered Write arguments are missing the newline separator between the path and content; refusing to execute because the path may be truncated."
                    .to_string(),
            )
        } else {
            None
        };

        if let Some(error_msg) = invalid_call_error {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Failed {
                        error_detail: None,
                        error: error_msg.clone(),
                        is_retryable: false,
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                )
                .await;

            return Err(OpenBitFunError::Validation(error_msg));
        }

        if let Some(rejection) = task.input_rewrite_rejection.as_ref() {
            let error_msg = rejection.message.clone().unwrap_or_else(|| {
                format!(
                    "PreToolUse input rewrite cannot relax validation constraints for tool '{}'",
                    tool_name
                )
            });
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Failed {
                        error_detail: None,
                        error: error_msg.clone(),
                        is_retryable: false,
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                )
                .await;
            return Err(OpenBitFunError::Validation(error_msg));
        }

        match repair_kind {
            ToolArgumentRepairKind::WriteTailClosure => warn!(
                "Tool arguments recovered with Write close-only repair: tool_name={}, tool_id={}, session_id={}",
                tool_name, tool_id, task.context.session_id
            ),
            ToolArgumentRepairKind::PermissiveNormalToolJsonRepair => warn!(
                "Tool arguments repaired after normal tool-use completion: tool_name={}, tool_id={}, session_id={}",
                tool_name, tool_id, task.context.session_id
            ),
            ToolArgumentRepairKind::None if recovered_from_truncation => warn!(
                "Executing legacy recovered Write tool call without repair provenance: tool_name={}, tool_id={}, session_id={}",
                tool_name, tool_id, task.context.session_id
            ),
            ToolArgumentRepairKind::None => {}
        }

        // Repetition alone is not execution failure: polling and status checks
        // may legitimately reuse identical arguments. The execution engine
        // evaluates repeated patterns only after observing actual tool results.
        let (admission, tool) = {
            let registry = self.tool_registry.read().await;
            let admission = validate_tool_execution_admission(ToolExecutionAdmissionRequest {
                tool_name: &tool_name,
                allowed_tools: &task.context.allowed_tools,
                runtime_tool_restrictions: &task.context.runtime_tool_restrictions,
                deferred_tools: &task.context.deferred_tools,
                loaded_deferred_tool_specs: &task.context.loaded_deferred_tool_specs,
                current_catalog_generation: registry.current_snapshot_generation(),
                get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
            });
            (admission, registry.get_tool(&tool_name))
        };

        if let Err(err) = admission {
            let error_msg = err.to_string();
            if task.invocation.is_deferred() {
                warn!("Deferred tool gateway admission rejected: {}", error_msg);
            } else {
                warn!("Tool execution admission rejected: {}", error_msg);
            }

            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Failed {
                        error_detail: None,
                        error: error_msg,
                        is_retryable: false,
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                )
                .await;

            return Err(map_tool_execution_admission_rejection(err));
        }

        let registered_tool = tool.ok_or_else(|| {
            let error_msg = format!("Tool '{}' is not registered or enabled.", tool_name);
            error!("{}", error_msg);
            OpenBitFunError::tool(error_msg)
        })?;

        let cancellation_token = task
            .options
            .parent_cancellation_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        if cancellation_token.is_cancelled() {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Cancelled {
                        reason: "Tool was cancelled before validation".to_string(),
                        duration_ms: Some(elapsed_ms_u64(start_time)),
                        queue_wait_ms: Some(queue_wait_ms),
                        preflight_ms: Some(elapsed_ms_u64(start_time)),
                        confirmation_wait_ms: Some(0),
                        execution_ms: None,
                    },
                )
                .await;
            return Err(OpenBitFunError::Cancelled(
                "Tool was cancelled before validation".to_string(),
            ));
        }
        let tool_context = self.build_tool_use_context(&task, cancellation_token.clone());
        // Keep the registered mux in the execution path. It rechecks the
        // persisted conflict choice immediately before dispatch and applies
        // remote fail-closed routing from the full ToolUseContext.
        let tool = registered_tool;
        let validation = tool.validate_input(&tool_args, Some(&tool_context)).await;
        if !validation.result {
            let error_msg = validation
                .message
                .unwrap_or_else(|| format!("Invalid input for tool '{}'", tool_name));
            let error_detail = validation
                .meta
                .as_ref()
                .and_then(|meta| meta.get("error_detail"))
                .and_then(|detail| serde_json::from_value(detail.clone()).ok());
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Failed {
                        error_detail: error_detail.clone(),
                        error: error_msg.clone(),
                        is_retryable: false,
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                )
                .await;
            return Err(match error_detail {
                Some(detail) => OpenBitFunError::ClassifiedTool {
                    message: error_msg,
                    detail,
                },
                None => OpenBitFunError::Validation(error_msg),
            });
        }
        if let Some(message) = validation
            .message
            .filter(|message| !message.trim().is_empty())
        {
            warn!(
                "Tool input validation warning: tool_name={}, warning={}",
                tool_name, message
            );
        }

        // Register cancellation only after deterministic validation and registry lookup succeed.
        self.cancellation_tokens
            .insert(tool_id.clone(), cancellation_token.clone());

        if cancellation_token.is_cancelled() {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Cancelled {
                        reason: "Tool was cancelled during validation".to_string(),
                        duration_ms: Some(elapsed_ms_u64(start_time)),
                        queue_wait_ms: Some(queue_wait_ms),
                        preflight_ms: Some(elapsed_ms_u64(start_time)),
                        confirmation_wait_ms: Some(0),
                        execution_ms: None,
                    },
                )
                .await;
            self.cancellation_tokens.remove(&tool_id);
            return Err(OpenBitFunError::Cancelled(
                "Tool was cancelled during validation".to_string(),
            ));
        }

        let has_prepared_plan = self.permission_plans.lock().await.contains_key(&tool_id);
        let permission_authorization = if has_prepared_plan {
            self.await_prepared_permission_plan(&tool_id, &cancellation_token)
                .await
        } else {
            let permission_intents = tool.permission_intents(&tool_args, &tool_context)?;
            self.authorize_permission_intents(
                &task,
                &tool_name,
                permission_intents,
                &tool_context,
                &cancellation_token,
            )
            .await
        };

        let rejected = match permission_authorization {
            Ok(PermissionAuthorization::Allowed) => None,
            Ok(PermissionAuthorization::AllowedWithInput { updated_input }) => {
                let arguments = match self.validate_approval_input(&task, updated_input).await {
                    Ok(arguments) => arguments,
                    Err(error) => {
                        self.cancellation_tokens.remove(&tool_id);
                        return Err(error);
                    }
                };
                task.invocation.effective_arguments = arguments.clone();
                self.state_manager
                    .apply_hook_input_rewrite(&tool_id, arguments, None);
                None
            }
            Ok(PermissionAuthorization::UserRejected { feedback }) => {
                let reason = user_rejection_audit_reason(&tool_name, feedback.as_deref());
                let result = build_user_rejected_tool_result(
                    &tool_id,
                    self.state_manager.get_task(&tool_id),
                    feedback.as_deref(),
                );
                Some((reason, result))
            }
            Ok(PermissionAuthorization::PolicyDenied { reason }) => {
                let result = build_permission_denied_tool_result(
                    &tool_id,
                    self.state_manager.get_task(&tool_id),
                    &reason,
                );
                Some((reason, result))
            }
            Err(error) => {
                self.cancellation_tokens.remove(&tool_id);
                return Err(error);
            }
        };

        if let Some((reason, result)) = rejected {
            let preflight_ms = elapsed_ms_u64(start_time);
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Rejected {
                        reason,
                        duration_ms: Some(preflight_ms),
                        queue_wait_ms: Some(queue_wait_ms),
                        preflight_ms: Some(preflight_ms),
                        confirmation_wait_ms: Some(0),
                        execution_ms: None,
                    },
                )
                .await;
            self.cancellation_tokens.remove(&tool_id);
            return Ok(result);
        }

        debug!("Executing tool: tool_name={}", tool_name);

        let is_streaming = tool.supports_streaming();
        let preflight_ms = elapsed_ms_u64(start_time);

        if cancellation_token.is_cancelled() {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Cancelled {
                        reason: "Tool was cancelled before execution".to_string(),
                        duration_ms: Some(elapsed_ms_u64(start_time)),
                        queue_wait_ms: Some(queue_wait_ms),
                        preflight_ms: Some(preflight_ms),
                        confirmation_wait_ms: Some(confirmation_wait_ms),
                        execution_ms: None,
                    },
                )
                .await;
            self.cancellation_tokens.remove(&tool_id);
            return Err(OpenBitFunError::Cancelled(
                "Tool was cancelled before execution".to_string(),
            ));
        }

        // Set initial state
        if is_streaming {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Streaming {
                        started_at: std::time::SystemTime::now(),
                        chunks_received: 0,
                    },
                )
                .await;
        } else {
            self.state_manager
                .update_state(
                    &tool_id,
                    ToolExecutionState::Running {
                        started_at: std::time::SystemTime::now(),
                        progress: None,
                    },
                )
                .await;
        }

        let execution_started_at = Instant::now();
        let tool_context = self.build_tool_use_context(&task, cancellation_token.clone());
        let result = self
            .execute_with_retry(&task, cancellation_token.clone(), tool)
            .await;
        let execution_ms = elapsed_ms_u64(execution_started_at);

        self.cancellation_tokens.remove(&tool_id);

        match result {
            Ok(tool_result) => {
                let duration_ms = elapsed_ms_u64(start_time);
                let mut tool_result = tool_result;
                tool_result.duration_ms = Some(duration_ms);

                self.apply_plugin_post_tool_use_hook(&task, &tool_name, &tool_id, &mut tool_result)
                    .await;

                let mut tool_result =
                    tool_result_storage::maybe_persist_large_tool_result_for_tool(
                        tool_result,
                        &tool_name,
                        &tool_context,
                    )
                    .await;

                if !matches!(repair_kind, ToolArgumentRepairKind::None) || recovered_from_truncation
                {
                    let original = tool_result.result_for_assistant.unwrap_or_default();
                    let notice = match repair_kind {
                        ToolArgumentRepairKind::WriteTailClosure => {
                            build_write_tail_closure_notice(&tool_name)
                        }
                        ToolArgumentRepairKind::PermissiveNormalToolJsonRepair => {
                            build_normal_tool_json_repair_notice(&tool_name)
                        }
                        // Old persisted calls carry only the legacy boolean.
                        ToolArgumentRepairKind::None => build_write_tail_closure_notice(&tool_name),
                    };
                    tool_result.result_for_assistant = Some(if original.is_empty() {
                        notice.trim_end().to_string()
                    } else {
                        format!("{notice}{original}")
                    });
                }

                self.apply_native_post_tool_use_hooks(
                    &task,
                    &tool_name,
                    &tool_id,
                    &mut tool_result,
                )
                .await;

                self.state_manager
                    .update_state(
                        &tool_id,
                        ToolExecutionState::Completed {
                            result: convert_to_framework_result(&tool_result),
                            duration_ms,
                            queue_wait_ms: Some(queue_wait_ms),
                            preflight_ms: Some(preflight_ms),
                            confirmation_wait_ms: Some(confirmation_wait_ms),
                            execution_ms: Some(execution_ms),
                        },
                    )
                    .await;

                info!(
                    "Tool completed: tool_name={}, duration_ms={}, queue_wait_ms={}, preflight_ms={}, confirmation_wait_ms={}, execution_ms={}, streaming={}",
                    tool_name,
                    duration_ms,
                    queue_wait_ms,
                    preflight_ms,
                    confirmation_wait_ms,
                    execution_ms,
                    is_streaming
                );

                Ok(ToolExecutionResult {
                    tool_id,
                    tool_name: wire_tool_name,
                    effective_tool_name: tool_name,
                    result: tool_result,
                    execution_time_ms: duration_ms,
                })
            }
            Err(e) => {
                // Cancellation is a first-class terminal state, not a failure.
                // Preserve Cancelled here so a late cancel cannot be overwritten
                // by the generic Failed branch below.
                if let OpenBitFunError::Cancelled(reason) = &e {
                    self.state_manager
                        .update_state(
                            &tool_id,
                            ToolExecutionState::Cancelled {
                                reason: reason.clone(),
                                duration_ms: Some(elapsed_ms_u64(start_time)),
                                queue_wait_ms: Some(queue_wait_ms),
                                preflight_ms: Some(preflight_ms),
                                confirmation_wait_ms: Some(confirmation_wait_ms),
                                execution_ms: Some(execution_ms),
                            },
                        )
                        .await;

                    info!(
                        "Tool cancelled during execution: tool_name={}, reason={}, duration_ms={}, queue_wait_ms={}, preflight_ms={}, confirmation_wait_ms={}, execution_ms={}",
                        tool_name,
                        reason,
                        elapsed_ms_u64(start_time),
                        queue_wait_ms,
                        preflight_ms,
                        confirmation_wait_ms,
                        execution_ms
                    );

                    return Err(e);
                }

                if matches!(e, OpenBitFunError::Timeout(_)) {
                    let duration_ms = elapsed_ms_u64(start_time);
                    let presentation = build_tool_execution_timeout_presentation(
                        &tool_name,
                        task.options.timeout_secs,
                    );
                    let timed_out_tool_id = tool_id.clone();
                    let timed_out_tool_name = tool_name.clone();

                    self.state_manager
                        .update_state(
                            &tool_id,
                            ToolExecutionState::Cancelled {
                                reason: presentation.result_for_assistant.clone(),
                                duration_ms: Some(duration_ms),
                                queue_wait_ms: Some(queue_wait_ms),
                                preflight_ms: Some(preflight_ms),
                                confirmation_wait_ms: Some(confirmation_wait_ms),
                                execution_ms: Some(execution_ms),
                            },
                        )
                        .await;

                    warn!(
                        "Tool execution timed out: tool_name={}, duration_ms={}, queue_wait_ms={}, preflight_ms={}, confirmation_wait_ms={}, execution_ms={}",
                        tool_name,
                        duration_ms,
                        queue_wait_ms,
                        preflight_ms,
                        confirmation_wait_ms,
                        execution_ms
                    );

                    return Ok(ToolExecutionResult {
                        tool_id: timed_out_tool_id.clone(),
                        tool_name: wire_tool_name.clone(),
                        effective_tool_name: timed_out_tool_name.clone(),
                        result: ModelToolResult {
                            tool_id: timed_out_tool_id,
                            effective_tool_name: persisted_effective_tool_name(
                                &wire_tool_name,
                                &timed_out_tool_name,
                            ),
                            tool_name: wire_tool_name,
                            result: presentation.result_json,
                            result_for_assistant: Some(presentation.result_for_assistant),
                            is_error: false,
                            duration_ms: Some(duration_ms),
                            image_attachments: None,
                        },
                        execution_time_ms: duration_ms,
                    });
                }

                let error_msg = e.to_string();
                let is_retryable = task.options.max_retries > 0;

                self.state_manager
                    .update_state(
                        &tool_id,
                        ToolExecutionState::Failed {
                            error_detail: e.tool_error_detail().cloned(),
                            error: error_msg.clone(),
                            is_retryable,
                            duration_ms: Some(elapsed_ms_u64(start_time)),
                            queue_wait_ms: Some(queue_wait_ms),
                            preflight_ms: Some(preflight_ms),
                            confirmation_wait_ms: Some(confirmation_wait_ms),
                            execution_ms: Some(execution_ms),
                        },
                    )
                    .await;

                error!(
                    "Tool failed: tool_name={}, error={}, duration_ms={}, queue_wait_ms={}, preflight_ms={}, confirmation_wait_ms={}, execution_ms={}",
                    tool_name,
                    error_msg,
                    elapsed_ms_u64(start_time),
                    queue_wait_ms,
                    preflight_ms,
                    confirmation_wait_ms,
                    execution_ms
                );

                Err(e)
            }
        }
    }

    /// Execute with retry
    async fn execute_with_retry(
        &self,
        task: &ToolTask,
        cancellation_token: CancellationToken,
        tool: Arc<dyn crate::agentic::tools::framework::Tool>,
    ) -> OpenBitFunResult<ModelToolResult> {
        let mut attempts = 0;
        let max_attempts = task.options.max_retries + 1;

        loop {
            // Check cancellation token
            if cancellation_token.is_cancelled() {
                return Err(OpenBitFunError::Cancelled(
                    "Tool execution was cancelled".to_string(),
                ));
            }

            attempts += 1;

            let result = self
                .execute_tool_impl(task, cancellation_token.clone(), tool.clone())
                .await;

            match result {
                Ok(r) => return Ok(r),
                Err(e) => {
                    if !should_retry_tool_attempt(ToolRetryAttemptFacts {
                        attempts,
                        max_attempts,
                        error_class: classify_tool_retry_error(&e),
                    }) {
                        return Err(e);
                    }

                    debug!(
                        "Retrying tool execution: attempt={}/{}, error={}",
                        attempts, max_attempts, e
                    );

                    // Wait for a period of time and retry
                    tokio::time::sleep(Duration::from_millis(retry_delay_ms(attempts))).await;
                }
            }
        }
    }

    /// Actual execution of tool
    async fn execute_tool_impl(
        &self,
        task: &ToolTask,
        cancellation_token: CancellationToken,
        tool: Arc<dyn crate::agentic::tools::framework::Tool>,
    ) -> OpenBitFunResult<ModelToolResult> {
        // Check cancellation token
        if cancellation_token.is_cancelled() {
            return Err(OpenBitFunError::Cancelled(
                "Tool execution was cancelled".to_string(),
            ));
        }

        let tool_context = self.build_tool_use_context(task, cancellation_token);

        let execution_future = tool.call(task.effective_arguments(), &tool_context);

        let timeout_owner = resolve_contextual_tool(Arc::clone(&tool), &tool_context);
        let pipeline_timeout_secs = if timeout_owner
            .as_ref()
            .is_some_and(|selected| selected.manages_own_execution_timeout())
        {
            None
        } else {
            task.options.timeout_secs
        };

        let tool_results = match pipeline_timeout_secs {
            Some(timeout_secs) => {
                let timeout_duration = Duration::from_secs(timeout_secs);
                let result = timeout(timeout_duration, execution_future)
                    .await
                    .map_err(|_| {
                        OpenBitFunError::Timeout(format!(
                            "Tool execution timeout: {}",
                            task.effective_tool_name()
                        ))
                    })?;
                result?
            }
            None => execution_future.await?,
        };

        if tool.supports_streaming() && tool_results.len() > 1 {
            self.handle_streaming_results(task, &tool_results).await?;
        }

        tool_results
            .into_iter()
            .last()
            .map(|r| {
                convert_tool_result(
                    r,
                    &task.tool_call.tool_id,
                    &task.tool_call.tool_name,
                    task.effective_tool_name(),
                )
            })
            .ok_or_else(|| {
                OpenBitFunError::Tool(format!(
                    "Tool did not return result: {}",
                    task.effective_tool_name()
                ))
            })
    }

    fn build_tool_use_context(
        &self,
        task: &ToolTask,
        cancellation_token: CancellationToken,
    ) -> ToolUseContext {
        tool_context_runtime::build_tool_use_context_for_task(
            task,
            self.computer_use_host.clone(),
            cancellation_token,
        )
    }

    /// Handle streaming results
    async fn handle_streaming_results(
        &self,
        task: &ToolTask,
        results: &[FrameworkToolResult],
    ) -> OpenBitFunResult<()> {
        let mut chunks_received = 0;

        for result in results {
            if let FrameworkToolResult::StreamChunk {
                data,
                chunk_index: _,
                is_final: _,
            } = result
            {
                chunks_received += 1;

                // Update state
                self.state_manager
                    .update_state(
                        &task.tool_call.tool_id,
                        ToolExecutionState::Streaming {
                            started_at: std::time::SystemTime::now(),
                            chunks_received,
                        },
                    )
                    .await;

                // Send StreamChunk event
                let _event_data = ToolEventData::StreamChunk {
                    identity: openbitfun_events::ToolEventIdentity::resolved(
                        task.tool_call.tool_id.clone(),
                        task.invocation.wire_tool_name.clone(),
                        task.effective_tool_name().to_string(),
                    ),
                    data: data.clone(),
                };
            }
        }

        Ok(())
    }

    /// Cancel tool execution
    pub async fn cancel_tool(&self, tool_id: &str, reason: String) -> OpenBitFunResult<()> {
        let Some(task) = self.state_manager.get_task(tool_id) else {
            debug!(
                "Ignoring cancel request for unknown tool: tool_id={}",
                tool_id
            );
            return Ok(());
        };

        if tool_task_state_kind(&task.state).is_terminal() {
            debug!(
                    "Ignoring duplicate cancel request for tool in terminal state: tool_id={}, state={:?}",
                    tool_id, task.state
                );
            return Ok(());
        }

        // 1. Trigger cancellation token
        if self.cancellation_tokens.cancel(tool_id) {
            debug!("Cancellation token triggered: tool_id={}", tool_id);
        } else {
            debug!(
                "Cancellation token not found (tool may have completed): tool_id={}",
                tool_id
            );
        }

        // 2. Update state to cancelled
        self.state_manager
            .update_state(
                tool_id,
                ToolExecutionState::Cancelled {
                    reason: reason.clone(),
                    duration_ms: None,
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                },
            )
            .await;

        info!(
            "Tool execution cancelled: tool_id={}, reason={}",
            tool_id, reason
        );
        Ok(())
    }

    /// User approval edits reuse the tool's validation and policy owner before execution.
    async fn validate_approval_input(
        &self,
        task: &ToolTask,
        patch: serde_json::Value,
    ) -> OpenBitFunResult<serde_json::Value> {
        let mut arguments = task
            .invocation
            .effective_arguments
            .as_object()
            .cloned()
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "This tool does not support object input edits".to_string(),
                )
            })?;
        arguments.extend(patch.as_object().cloned().ok_or_else(|| {
            OpenBitFunError::Validation("Edited approval input must be an object".to_string())
        })?);
        let arguments = serde_json::Value::Object(arguments);
        if let Some(rejection) = self
            .non_relaxable_original_input_rejection(task, &arguments)
            .await
        {
            return Err(OpenBitFunError::Validation(
                rejection
                    .message
                    .unwrap_or_else(|| "This tool input is immutable".to_string()),
            ));
        }
        let context = self.build_tool_use_context(task, CancellationToken::new());
        let tool = self
            .tool_registry
            .read()
            .await
            .get_tool(task.effective_tool_name())
            .ok_or_else(|| OpenBitFunError::NotFound("Approval tool is unavailable".to_string()))?;
        if tool.is_concurrency_safe(Some(task.effective_arguments()))
            && !tool.is_concurrency_safe(Some(&arguments))
        {
            return Err(OpenBitFunError::Validation(
                "Edited input changes the admitted concurrency class; submit it as a new tool call"
                    .to_string(),
            ));
        }
        let validation = tool.validate_input(&arguments, Some(&context)).await;
        if !validation.result {
            return Err(OpenBitFunError::Validation(
                validation
                    .message
                    .unwrap_or_else(|| "Invalid edited tool input".to_string()),
            ));
        }
        let intents = tool.permission_intents(&arguments, &context)?;
        if let PermissionPlanDraft::Rejected { reason } = self
            .draft_permission_plan(
                task.clone(),
                task.effective_tool_name().to_string(),
                intents,
                context,
            )
            .await?
        {
            return Err(OpenBitFunError::Validation(reason));
        }
        Ok(arguments)
    }

    pub async fn reply_to_tool(
        &self,
        tool_id: &str,
        reply: PermissionReply,
    ) -> OpenBitFunResult<()> {
        let manager = self.permission_request_manager.as_ref().ok_or_else(|| {
            OpenBitFunError::service("Permission request manager is unavailable".to_string())
        })?;
        let request = manager
            .pending_requests()
            .into_iter()
            .find(|request| {
                request.tool_call_id.as_deref() == Some(tool_id) || request.request_id == tool_id
            })
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!(
                    "Permission request not found for tool: {tool_id}"
                ))
            })?;
        if let PermissionReply::OnceWithInput { updated_input } = &reply {
            let task = request
                .tool_call_id
                .as_deref()
                .and_then(|id| self.state_manager.get_task(id))
                .ok_or_else(|| {
                    OpenBitFunError::Validation(
                        "This permission request does not own editable tool input".to_string(),
                    )
                })?;
            self.validate_approval_input(&task, updated_input.clone())
                .await?;
        }
        manager
            .reply(&request.request_id, reply, PermissionReplySource::User)
            .await
            .map(|_| ())
            .map_err(|error| OpenBitFunError::service(error.to_string()))
    }

    /// Cancel all tools for a dialog turn
    pub async fn cancel_dialog_turn_tools(&self, dialog_turn_id: &str) -> OpenBitFunResult<()> {
        info!(
            "Cancelling all tools for dialog turn: dialog_turn_id={}",
            dialog_turn_id
        );

        let tasks = self.state_manager.get_dialog_turn_tasks(dialog_turn_id);
        debug!("Found {} tool tasks for dialog turn", tasks.len());

        let summary = summarize_dialog_turn_cancellation(
            tasks.iter().map(|task| tool_task_state_kind(&task.state)),
        );

        for task in tasks {
            if should_cancel_tool_state(tool_task_state_kind(&task.state)) {
                debug!(
                    "Cancelling tool: tool_id={}, state={:?}",
                    task.tool_call.tool_id, task.state
                );
                self.cancel_tool(&task.tool_call.tool_id, "Dialog turn cancelled".to_string())
                    .await?;
            } else {
                debug!(
                    "Skipping tool (state not cancellable): tool_id={}, state={:?}",
                    task.tool_call.tool_id, task.state
                );
            }
        }

        info!(
            "Tool cancellation completed: cancelled={}, skipped={}",
            summary.cancelled, summary.skipped
        );
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn insert_tool_task_for_test(&self, task: ToolTask) {
        self.state_manager.create_task(task).await;
    }

    #[cfg(test)]
    pub(crate) fn tool_task_is_cancelled_for_test(&self, tool_id: &str) -> bool {
        self.state_manager
            .get_task(tool_id)
            .is_some_and(|task| matches!(task.state, ToolExecutionState::Cancelled { .. }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::ToolExecutionState;
    use crate::agentic::events::{EventQueue, EventQueueConfig};
    use crate::agentic::round_preempt::{
        DialogRoundInjectionInterrupt, SessionRoundInjectionBuffer,
    };
    use crate::agentic::tools::framework::{Tool, ToolResult, ValidationResult};
    use crate::agentic::tools::implementations::task::TaskTool;
    use crate::agentic::tools::tool_context_runtime::ToolUseContext;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use async_trait::async_trait;
    use openbitfun_agent_tools::{
        LoadedDeferredToolSpec, CALL_DEFERRED_TOOL_NAME, USER_REJECTED_TOOL_MESSAGE,
    };
    use openbitfun_runtime_ports::{
        ClockPort, PermissionAuditEvent, PermissionAuditRecord, PermissionAuditStorePort,
        PermissionConstraintLayer, PermissionEffect, PermissionGrant, PermissionGrantKey,
        PermissionGrantStorePort, PermissionReplyStorePort, PermissionRule, PortResult,
        ResolvedPermissionPolicy, RoundInjection, RoundInjectionExecutionPolicy,
        RoundInjectionKind, RoundInjectionTarget, RoundInjectionToolPreemption,
        RuntimeServiceCapability, RuntimeServicePort,
    };
    use serde_json::json;
    use std::collections::HashMap;
    #[cfg(feature = "external-sources")]
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;
    use tokio::time::{sleep, Duration};

    fn loaded_spec(tool_name: &str, catalog_generation: u64) -> LoadedDeferredToolSpec {
        LoadedDeferredToolSpec {
            tool_name: tool_name.to_string(),
            catalog_generation,
        }
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn plugin_after_presentation_prefers_model_visible_output_over_structured_output() {
        let result = ModelToolResult {
            tool_id: "call-a".to_string(),
            tool_name: "ExecCommand".to_string(),
            effective_tool_name: None,
            result: json!({
                "title": "ExecCommand",
                "output": "raw terminal output",
                "metadata": {"tty": true},
                "session_id": 42
            }),
            result_for_assistant: Some("Process is still running with session ID 42.".to_string()),
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        };

        let presentation = plugin_after_presentation("ExecCommand", &result);
        assert_eq!(presentation.title, "ExecCommand");
        assert_eq!(
            presentation.output,
            "Process is still running with session ID 42."
        );
        assert_eq!(presentation.metadata["tty"], true);
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn plugin_after_presentation_preserves_specialized_exec_and_stdin_results() {
        let cases = [
            (
                "ExecCommand",
                json!({"output": "", "tty": false}),
                "Command completed successfully.",
            ),
            (
                "ExecCommand",
                json!({"output": "\u{1b}[?25l", "tty": true, "session_id": 73}),
                "Process is still running with session ID 73.",
            ),
            (
                "WriteStdin",
                json!({"output": "done", "session_id": 73}),
                "Wrote input to session 73.",
            ),
            (
                "WriteStdin",
                json!({"output": "", "requested_session_id": 999}),
                "Session 999 was not found.",
            ),
        ];

        for (tool_name, structured_result, assistant_result) in cases {
            let result = ModelToolResult {
                tool_id: "call-a".to_string(),
                tool_name: tool_name.to_string(),
                effective_tool_name: None,
                result: structured_result,
                result_for_assistant: Some(assistant_result.to_string()),
                is_error: false,
                duration_ms: None,
                image_attachments: None,
            };

            assert_eq!(
                plugin_after_presentation(tool_name, &result).output,
                assistant_result
            );
        }
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn plugin_after_presentation_falls_back_to_plugin_output_without_assistant_text() {
        let result = ModelToolResult {
            tool_id: "call-a".to_string(),
            tool_name: "report".to_string(),
            effective_tool_name: None,
            result: json!({
                "title": "Generated report",
                "output": "report ready",
                "metadata": {"path": "report.md"}
            }),
            result_for_assistant: None,
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        };

        assert_eq!(
            plugin_after_presentation("report", &result).output,
            "report ready"
        );
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn plugin_after_presentation_normalizes_non_object_metadata() {
        let result = ModelToolResult {
            tool_id: "call-a".to_string(),
            tool_name: "report".to_string(),
            effective_tool_name: None,
            result: json!({
                "title": "Generated report",
                "output": "report ready",
                "metadata": ["legacy"]
            }),
            result_for_assistant: Some("report ready".to_string()),
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        };

        let presentation = plugin_after_presentation("report", &result);
        assert_eq!(presentation.metadata, json!({"isError": false}));
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn remote_workspace_never_resolves_a_local_plugin_hook_scope() {
        let workspace = tempfile::tempdir().expect("workspace");
        let local = WorkspaceBinding::new(None, workspace.path().to_path_buf());
        let mut remote = local.clone();
        remote.backend = crate::agentic::workspace::WorkspaceBackend::Remote {
            connection_id: "remote-a".to_string(),
            connection_name: "Remote A".to_string(),
        };

        assert!(local_plugin_workspace_scope(&local).is_some());
        assert!(local_plugin_workspace_scope(&remote).is_none());
    }

    #[test]
    fn recovered_write_without_separator_is_rejected_as_potentially_truncated_path() {
        assert!(recovered_write_has_potentially_truncated_marked_path(
            "Write",
            &json!({ "payload": "+++ C:/workspace/truncated" }),
            Default::default(),
            true,
        ));
    }

    #[test]
    fn complete_path_only_write_is_not_treated_as_truncation_recovery() {
        assert!(!recovered_write_has_potentially_truncated_marked_path(
            "Write",
            &json!({ "payload": "+++ C:/workspace/empty.txt" }),
            Default::default(),
            false,
        ));
        assert!(!recovered_write_has_potentially_truncated_marked_path(
            "Write",
            &json!({ "payload": "+++ C:/workspace/empty.txt\n" }),
            Default::default(),
            true,
        ));
    }

    #[test]
    fn recovered_write_without_marker_can_fall_back_safely() {
        assert!(!recovered_write_has_potentially_truncated_marked_path(
            "Write",
            &json!({ "payload": "partial content without a path" }),
            Default::default(),
            true,
        ));
        assert!(!recovered_write_has_potentially_truncated_marked_path(
            "Write",
            &json!({ "payload": "+++ C:/workspace/main.rs\npartial content" }),
            Default::default(),
            true,
        ));
    }

    #[test]
    fn account_scoped_permission_works_without_a_workspace() {
        let mut intent = PermissionIntent::new(
            "page_publish",
            vec!["page:demo; visibility=private; deploy=saved-version-only".to_string()],
        );
        intent.display_metadata.insert(
            "permissionScope".to_string(),
            json!(ACCOUNT_PERMISSION_SCOPE),
        );
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), json!(true));
        let context = ToolUseContext::for_tool_listing(None, None);
        assert_eq!(
            permission_scope(&context, &[intent.clone()]).expect("account scope"),
            (
                ACCOUNT_PERMISSION_PROJECT_ID.to_string(),
                ACCOUNT_PERMISSION_PROJECT_PATH.to_string(),
            )
        );
    }

    #[test]
    fn ordinary_permission_intents_still_require_a_workspace() {
        let context = ToolUseContext::for_tool_listing(None, None);
        let intent = PermissionIntent::new("edit", vec!["src/main.rs".to_string()]);
        assert!(permission_scope(&context, &[intent]).is_err());
    }

    struct StaticTestTool {
        name: String,
        response: serde_json::Value,
        delay_ms: u64,
        readonly: bool,
        round_injection_yieldable: bool,
    }

    struct CapturingTestTool {
        name: String,
        received_arguments: Arc<Mutex<Option<serde_json::Value>>>,
    }

    struct V2FileTestTool {
        intents: Vec<PermissionIntent>,
        call_count: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Tool for V2FileTestTool {
        fn name(&self) -> &str {
            "Write"
        }

        fn is_readonly(&self) -> bool {
            // Keep the test tool eligible for the parallel batch scheduler
            // while its explicit permission intent still exercises permission prompts.
            true
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("File permission test tool".to_string())
        }

        fn short_description(&self) -> String {
            "File permission test tool".to_string()
        }

        fn input_schema(&self) -> serde_json::Value {
            json!({ "type": "object" })
        }

        fn permission_intents(
            &self,
            _input: &serde_json::Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<PermissionIntent>> {
            Ok(self.intents.clone())
        }

        async fn call_impl(
            &self,
            input: &serde_json::Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            Ok(vec![ToolResult::Result {
                data: json!({ "written": true, "input": input }),
                result_for_assistant: None,
                image_attachments: None,
            }])
        }
    }

    #[derive(Default)]
    struct MemoryPermissionStore {
        grants: Mutex<Vec<PermissionGrant>>,
        audit: Mutex<Vec<PermissionAuditRecord>>,
    }

    impl RuntimeServicePort for MemoryPermissionStore {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Permission
        }
    }

    #[async_trait]
    impl PermissionGrantStorePort for MemoryPermissionStore {
        async fn list_project_grants(&self, project_id: &str) -> PortResult<Vec<PermissionGrant>> {
            Ok(self
                .grants
                .lock()
                .expect("permission grant lock")
                .iter()
                .filter(|grant| grant.project_id == project_id)
                .cloned()
                .collect())
        }

        async fn add_project_grants(&self, grants: Vec<PermissionGrant>) -> PortResult<()> {
            self.grants
                .lock()
                .expect("permission grant lock")
                .extend(grants);
            Ok(())
        }

        async fn remove_project_grant(&self, key: PermissionGrantKey) -> PortResult<bool> {
            let mut grants = self.grants.lock().expect("permission grant lock");
            let original_len = grants.len();
            grants.retain(|grant| grant.key() != key);
            Ok(grants.len() != original_len)
        }

        async fn clear_project_grants(&self, project_id: &str) -> PortResult<usize> {
            let mut grants = self.grants.lock().expect("permission grant lock");
            let original_len = grants.len();
            grants.retain(|grant| grant.project_id != project_id);
            Ok(original_len - grants.len())
        }
    }

    #[async_trait]
    impl PermissionAuditStorePort for MemoryPermissionStore {
        async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()> {
            self.audit
                .lock()
                .expect("permission audit lock")
                .push(record);
            Ok(())
        }

        async fn list_project_permission_audit(
            &self,
            project_id: &str,
        ) -> PortResult<Vec<PermissionAuditRecord>> {
            Ok(self
                .audit
                .lock()
                .expect("permission audit lock")
                .iter()
                .filter(|record| record.request.project_id == project_id)
                .cloned()
                .collect())
        }
    }

    #[async_trait]
    impl PermissionReplyStorePort for MemoryPermissionStore {
        async fn commit_permission_reply(
            &self,
            grants: Vec<PermissionGrant>,
            audit: Vec<PermissionAuditRecord>,
        ) -> PortResult<()> {
            self.grants
                .lock()
                .expect("permission grant lock")
                .extend(grants);
            self.audit
                .lock()
                .expect("permission audit lock")
                .extend(audit);
            Ok(())
        }
    }

    struct FixedPermissionClock;

    impl RuntimeServicePort for FixedPermissionClock {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Clock
        }
    }

    impl ClockPort for FixedPermissionClock {
        fn now_unix_millis(&self) -> i64 {
            42
        }
    }

    #[async_trait]
    impl Tool for CapturingTestTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("capturing test tool".to_string())
        }

        fn short_description(&self) -> String {
            "capturing test tool".to_string()
        }

        fn is_readonly(&self) -> bool {
            true
        }

        fn is_concurrency_safe(&self, input: Option<&serde_json::Value>) -> bool {
            input
                .and_then(|input| input.get("city"))
                .and_then(serde_json::Value::as_str)
                != Some("unsafe")
        }

        fn input_schema(&self) -> serde_json::Value {
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["city"],
                "properties": {
                    "city": { "type": "string" }
                }
            })
        }

        async fn validate_input(
            &self,
            input: &serde_json::Value,
            _context: Option<&ToolUseContext>,
        ) -> ValidationResult {
            let valid = input
                .get("city")
                .and_then(serde_json::Value::as_str)
                .is_some()
                && input.as_object().is_some_and(|object| object.len() == 1);
            if !valid {
                return ValidationResult {
                    result: false,
                    message: Some("city must be the only target argument".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
            if input.get("city").and_then(serde_json::Value::as_str) == Some("protected") {
                return ValidationResult {
                    result: false,
                    message: Some("the original target is protected".to_string()),
                    error_code: Some(403),
                    meta: Some(json!({ "blocks_input_rewrite": true })),
                };
            }
            ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            }
        }

        async fn validate_input_rewrite_invariants(
            &self,
            input: &serde_json::Value,
            _context: Option<&ToolUseContext>,
        ) -> ValidationResult {
            if input.get("city").and_then(serde_json::Value::as_str) == Some("protected") {
                ValidationResult {
                    result: false,
                    message: Some("the original target is protected".to_string()),
                    error_code: Some(403),
                    meta: Some(json!({ "blocks_input_rewrite": true })),
                }
            } else {
                ValidationResult::default()
            }
        }

        async fn call_impl(
            &self,
            input: &serde_json::Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            *self
                .received_arguments
                .lock()
                .expect("capturing tool argument lock") = Some(input.clone());
            Ok(vec![ToolResult::Result {
                data: json!({ "received": input }),
                result_for_assistant: None,
                image_attachments: None,
            }])
        }
    }

    #[async_trait]
    impl Tool for StaticTestTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("static test tool".to_string())
        }

        fn short_description(&self) -> String {
            "static test tool".to_string()
        }

        fn is_readonly(&self) -> bool {
            self.readonly
        }

        fn round_injection_yieldable(&self) -> bool {
            self.round_injection_yieldable
        }

        fn input_schema(&self) -> serde_json::Value {
            json!({ "type": "object" })
        }

        async fn validate_input(
            &self,
            _input: &serde_json::Value,
            _context: Option<&ToolUseContext>,
        ) -> ValidationResult {
            ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            }
        }

        async fn call_impl(
            &self,
            _input: &serde_json::Value,
            context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            if self.delay_ms > 0 {
                if let Some(token) = context
                    .round_injection_preemption_token()
                    .filter(|_| self.round_injection_yieldable)
                {
                    tokio::select! {
                        _ = sleep(Duration::from_millis(self.delay_ms)) => {}
                        _ = token.cancelled() => {}
                    }
                } else {
                    sleep(Duration::from_millis(self.delay_ms)).await;
                }
            }
            Ok(vec![ToolResult::Result {
                data: self.response.clone(),
                result_for_assistant: Some(render_tool_result_for_assistant(
                    &self.name,
                    &self.response,
                )),
                image_attachments: None,
            }])
        }
    }

    fn test_tool_pipeline() -> ToolPipeline {
        let registry = Arc::new(TokioRwLock::new(ToolRegistry::new()));
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let state_manager = Arc::new(ToolStateManager::new(event_queue));
        ToolPipeline::new(registry, state_manager, None)
    }

    fn test_tool_call(tool_id: &str, tool_name: &str) -> ToolCall {
        ToolCall {
            tool_id: tool_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments: json!({ "path": "src/main.rs" }),
            raw_arguments: None,
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }
    }

    fn test_tool_execution_context() -> ToolExecutionContext {
        ToolExecutionContext {
            session_id: "session_1".to_string(),
            dialog_turn_id: "turn_1".to_string(),
            round_id: "round_1".to_string(),
            attempt_id: None,
            attempt_index: None,
            agent_type: "agent".to_string(),
            workspace: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            context_vars: HashMap::new(),
            subagent_parent_info: None,
            permission_delegation: None,
            delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level(),
            deferred_tools: Vec::new(),
            loaded_deferred_tool_specs: Vec::new(),
            allowed_tools: Vec::new(),
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            steering_interrupt: None,
            workspace_services: None,
            terminal_port: None,
            remote_exec_port: None,
        }
    }

    fn test_tool_task(tool_id: &str, tool_name: &str) -> ToolTask {
        ToolTask::new(
            test_tool_call(tool_id, tool_name),
            test_tool_execution_context(),
            ToolExecutionOptions::default(),
        )
    }

    fn test_tool_task_with_arguments(
        tool_id: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> ToolTask {
        let mut tool_call = test_tool_call(tool_id, tool_name);
        tool_call.arguments = arguments;
        ToolTask::new(
            tool_call,
            test_tool_execution_context(),
            ToolExecutionOptions::default(),
        )
    }

    #[cfg(feature = "external-sources")]
    #[test]
    fn remote_workspace_route_root_isolated_from_same_local_path() {
        let pipeline = test_tool_pipeline();
        let root = std::env::current_dir().expect("absolute test workspace root");

        let mut local_task = test_tool_task("local-route", "Read");
        local_task.context.workspace = Some(WorkspaceBinding::new(None, root.clone()));
        let local = pipeline.build_tool_use_context(&local_task, CancellationToken::new());

        let session_identity =
            crate::service::remote_ssh::workspace_state::workspace_session_identity(
                root.to_string_lossy().as_ref(),
                Some("remote-connection"),
                Some("remote.example"),
            )
            .expect("remote workspace identity");
        let mut remote_task = test_tool_task("remote-route", "Read");
        remote_task.context.workspace = Some(WorkspaceBinding::new_remote(
            None,
            PathBuf::from(&root),
            "remote-connection".to_string(),
            "Remote".to_string(),
            session_identity,
        ));
        let remote = pipeline.build_tool_use_context(&remote_task, CancellationToken::new());

        assert_eq!(
            crate::external_tools::external_tool_route_root(
                local.workspace_root(),
                local.is_remote(),
            ),
            Some(root.as_path())
        );
        let remote_route_root = crate::external_tools::external_tool_route_root(
            remote.workspace_root(),
            remote.is_remote(),
        );
        assert_eq!(remote_route_root, Some(std::path::Path::new("\0")));
        assert!(dunce::canonicalize(remote_route_root.expect("remote sentinel")).is_err());
    }

    async fn register_static_test_tool(
        pipeline: &ToolPipeline,
        name: &str,
        response: serde_json::Value,
        delay_ms: u64,
    ) {
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(StaticTestTool {
                name: name.to_string(),
                response,
                delay_ms,
                readonly: true,
                round_injection_yieldable: false,
            }));
    }

    async fn register_yieldable_test_tool(
        pipeline: &ToolPipeline,
        name: &str,
        response: serde_json::Value,
    ) {
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(StaticTestTool {
                name: name.to_string(),
                response,
                delay_ms: 30_000,
                readonly: true,
                round_injection_yieldable: true,
            }));
    }

    async fn register_capturing_test_tool(
        pipeline: &ToolPipeline,
        name: &str,
        received_arguments: Arc<Mutex<Option<serde_json::Value>>>,
    ) {
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(CapturingTestTool {
                name: name.to_string(),
                received_arguments,
            }));
    }

    async fn current_registry_generation(pipeline: &ToolPipeline) -> u64 {
        pipeline
            .tool_registry
            .read()
            .await
            .current_snapshot_generation()
    }

    async fn register_v2_file_test_tool(
        pipeline: &ToolPipeline,
        intents: Vec<PermissionIntent>,
        call_count: Arc<AtomicUsize>,
    ) {
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(V2FileTestTool {
                intents,
                call_count,
            }));
    }

    fn permission_test_context() -> ToolExecutionContext {
        let mut context = test_tool_execution_context();
        context.workspace = Some(WorkspaceBinding::new(
            None,
            std::env::temp_dir().join("openbitfun-permission-test"),
        ));
        context
    }

    fn subagent_permission_test_context(parent_tool_call_id: &str) -> ToolExecutionContext {
        let mut context = permission_test_context();
        context.session_id = "subagent-session".to_string();
        context.dialog_turn_id = "subagent-turn".to_string();
        context.agent_type = "Explore".to_string();
        context.subagent_parent_info = Some(SubagentParentInfo {
            session_id: "parent-session".to_string(),
            dialog_turn_id: "parent-turn".to_string(),
            tool_call_id: parent_tool_call_id.to_string(),
        });
        context
    }

    #[tokio::test]
    async fn non_readonly_tools_use_v2_custom_tool_fallback() {
        let pipeline = test_tool_pipeline();
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(StaticTestTool {
                name: "UnclassifiedMutation".to_string(),
                response: json!({ "unexpected": true }),
                delay_ms: 0,
                readonly: false,
                round_injection_yieldable: false,
            }));
        let mut options = ToolExecutionOptions::default();
        options.permission_policy = ResolvedPermissionPolicy::new(
            vec![PermissionRule::new(
                "custom_tool",
                "UnclassifiedMutation",
                PermissionEffect::Deny,
            )],
            Vec::new(),
        );

        let results = pipeline
            .execute_tools(
                vec![test_tool_call("fallback-deny", "UnclassifiedMutation")],
                permission_test_context(),
                options,
            )
            .await
            .expect("fallback policy denial");

        assert!(matches!(
            pipeline
                .state_manager
                .get_task("fallback-deny")
                .map(|task| task.state),
            Some(ToolExecutionState::Rejected { .. })
        ));
        assert_eq!(results[0].result.result["category"], "permission_denied");
        assert!(results[0]
            .result
            .result_for_assistant
            .as_deref()
            .is_some_and(|message| message.contains("current permission policy")));
    }

    fn permission_test_manager(store: Arc<MemoryPermissionStore>) -> Arc<PermissionRequestManager> {
        Arc::new(
            PermissionRequestManager::new(
                store.clone(),
                store.clone(),
                Arc::new(FixedPermissionClock),
            )
            .with_grant_store(store),
        )
    }

    async fn wait_for_permission_request(
        manager: &PermissionRequestManager,
    ) -> openbitfun_runtime_ports::PermissionRequest {
        for _ in 0..100 {
            if let Some(request) = manager.pending_requests().into_iter().next() {
                return request;
            }
            sleep(Duration::from_millis(5)).await;
        }
        panic!("permission request was not registered");
    }

    async fn wait_for_permission_request_count(
        manager: &PermissionRequestManager,
        expected: usize,
    ) -> Vec<openbitfun_runtime_ports::PermissionRequest> {
        for _ in 0..100 {
            let requests = manager.pending_requests();
            if requests.len() >= expected {
                return requests;
            }
            sleep(Duration::from_millis(5)).await;
        }
        panic!("expected {expected} permission requests to be registered");
    }

    #[tokio::test]
    async fn v2_allow_and_deny_are_enforced_before_tool_side_effects() {
        let pipeline = test_tool_pipeline();
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string(), "src/private/key.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let mut allow_options = ToolExecutionOptions::default();
        allow_options.permission_policy = ResolvedPermissionPolicy::new(
            vec![PermissionRule::new(
                "edit",
                "src/*",
                PermissionEffect::Allow,
            )],
            Vec::new(),
        );
        let results = pipeline
            .execute_tools(
                vec![test_tool_call("allow", "Write")],
                permission_test_context(),
                allow_options,
            )
            .await
            .expect("allowed tool should execute");
        assert!(!results[0].result.is_error);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let mut deny_options = ToolExecutionOptions::default();
        deny_options.auto_approve_ask = true;
        deny_options.permission_policy = ResolvedPermissionPolicy::new(
            vec![
                PermissionRule::new("edit", "src/*", PermissionEffect::Allow),
                PermissionRule::new("edit", "src/private/*", PermissionEffect::Deny),
            ],
            Vec::new(),
        );
        let results = pipeline
            .execute_tools(
                vec![test_tool_call("deny", "Write")],
                permission_test_context(),
                deny_options,
            )
            .await
            .expect("denied tool should return a structured rejection");
        assert!(!results[0].result.is_error);
        assert!(matches!(
            pipeline
                .state_manager
                .get_task("deny")
                .map(|task| task.state),
            Some(ToolExecutionState::Rejected { .. })
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(results[0].result.result["category"], "permission_denied");
    }

    #[tokio::test]
    async fn independent_permission_constraints_tighten_but_never_widen_host_policy() {
        let pipeline = test_tool_pipeline();
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/generated/output.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let mut host_deny = ToolExecutionOptions::default();
        host_deny.auto_approve_ask = true;
        host_deny.permission_policy = ResolvedPermissionPolicy::new(
            vec![PermissionRule::new(
                "edit",
                "src/generated/*",
                PermissionEffect::Deny,
            )],
            vec![PermissionConstraintLayer::new(vec![PermissionRule::new(
                "edit",
                "*",
                PermissionEffect::Allow,
            )])],
        );
        pipeline
            .execute_tools(
                vec![test_tool_call("host-deny", "Write")],
                permission_test_context(),
                host_deny,
            )
            .await
            .expect("constraint allow must not widen host denial");

        let mut external_deny = ToolExecutionOptions::default();
        external_deny.auto_approve_ask = true;
        external_deny.permission_policy = ResolvedPermissionPolicy::new(
            vec![PermissionRule::new("edit", "*", PermissionEffect::Allow)],
            vec![PermissionConstraintLayer::new(vec![PermissionRule::new(
                "edit",
                "src/generated/*",
                PermissionEffect::Deny,
            )])],
        );
        pipeline
            .execute_tools(
                vec![test_tool_call("external-deny", "Write")],
                permission_test_context(),
                external_deny,
            )
            .await
            .expect("constraint denial should tighten host allow");

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        for tool_id in ["host-deny", "external-deny"] {
            assert!(matches!(
                pipeline
                    .state_manager
                    .get_task(tool_id)
                    .map(|task| task.state),
                Some(ToolExecutionState::Rejected { .. })
            ));
        }
    }

    /// A PreToolUse hook approval waives the interactive permission prompt.
    /// It must never widen the policy: a rule that denies the call still
    /// rejects it, and the tool never runs.
    #[tokio::test]
    async fn hook_approval_does_not_override_a_permission_deny_rule() {
        let pipeline = test_tool_pipeline();
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/private/key.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        // Stand in for a hook that returned permissionDecision: "allow".
        pipeline
            .hook_preapprovals
            .lock()
            .await
            .insert("hook-approved".to_string());

        let mut deny_options = ToolExecutionOptions::default();
        deny_options.permission_policy = ResolvedPermissionPolicy::new(
            vec![PermissionRule::new(
                "edit",
                "src/private/*",
                PermissionEffect::Deny,
            )],
            Vec::new(),
        );
        let results = pipeline
            .execute_tools(
                vec![test_tool_call("hook-approved", "Write")],
                permission_test_context(),
                deny_options,
            )
            .await
            .expect("denied tool should return a structured rejection");

        assert!(matches!(
            pipeline
                .state_manager
                .get_task("hook-approved")
                .map(|task| task.state),
            Some(ToolExecutionState::Rejected { .. })
        ));
        assert_eq!(results[0].result.result["category"], "permission_denied");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a denied tool must not execute even when a hook approved it"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn complete_shell_hook_workdir_rewrites_preserve_guard_and_model_observation() {
        use crate::agentic::execution::edit_constraint_guard::{
            ConstraintMatcher, ConstraintOperationScope, ConstraintSource, EditConstraintState,
            ExtractedConstraint,
        };
        use crate::agentic::tools::implementations::exec_command::ExecCommandTool;
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let scratch = temp.path().join("scratch");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        let state = EditConstraintState {
            constraints: vec![ExtractedConstraint {
                id: "fixture:protected".into(),
                description: "Do not modify protected fixtures".into(),
                operation_scope: ConstraintOperationScope::All,
                matcher: ConstraintMatcher::PathUnderDir {
                    dirs: vec![repo.to_string_lossy().into_owned()],
                },
                source: ConstraintSource::Legacy,
                source_text: None,
            }],
            ..Default::default()
        };
        let protected_cmd = format!("printf x > '{}'", repo.join("victim").display());
        let allowed_cmd = format!("printf x > '{}'", scratch.join("victim").display());
        for (case, original_cwd, final_cwd, original_cmd, final_cmd) in [
            (
                "original-cwd",
                &repo,
                &scratch,
                "printf x > victim",
                "printf x > victim",
            ),
            (
                "final-cwd",
                &scratch,
                &repo,
                "printf x > victim",
                "printf x > victim",
            ),
            (
                "original-cmd",
                &repo,
                &repo,
                protected_cmd.as_str(),
                allowed_cmd.as_str(),
            ),
            (
                "final-cmd",
                &repo,
                &repo,
                allowed_cmd.as_str(),
                protected_cmd.as_str(),
            ),
        ] {
            let pipeline = test_tool_pipeline();
            let mut tool = ExecCommandTool::new();
            tool.guard_fixture_state = Some(state.clone());
            pipeline
                .tool_registry
                .write()
                .await
                .register_tool(Arc::new(tool));
            let mut task = test_tool_task_with_arguments(
                case,
                "ExecCommand",
                json!({"cmd":original_cmd, "workdir":original_cwd}),
            );
            task.context.workspace = Some(WorkspaceBinding::new(None, repo.clone()));
            let id = pipeline.state_manager.create_task(task.clone()).await;
            assert_eq!(
                pipeline
                    .apply_hook_input_rewrite(&task, json!({"cmd":final_cmd, "workdir":final_cwd}))
                    .await,
                case.starts_with("original")
            );
            let persisted = pipeline.state_manager.get_task(&id).unwrap();
            assert_eq!(
                persisted.input_rewrite_rejection.is_some(),
                case.starts_with("original")
            );
            let error = pipeline
                .execute_single_tool(id.clone())
                .await
                .expect_err("guard must reject before execution");
            assert!(error.to_string().contains("Command was not executed"));
            let observation = build_error_execution_result(&id, Some(persisted), &error);
            let text = observation.result.result_for_assistant.unwrap();
            assert!(
                text.contains("executed") && text.contains("false"),
                "{text}"
            );
            assert!(
                text.contains("deny_constraint") && text.contains("fixture:protected"),
                "{text}"
            );
            assert!(!text.contains("your own implementation"));
            assert!(!repo.join("victim").exists());
            assert!(!scratch.join("victim").exists());
        }
    }

    #[tokio::test]
    async fn hook_rewrite_cannot_hide_a_non_relaxable_original_input_rejection() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;
        let task = test_tool_task_with_arguments(
            "rewrite-protected-original",
            "get_weather",
            json!({ "city": "protected" }),
        );
        let tool_id = pipeline.state_manager.create_task(task.clone()).await;

        assert!(
            pipeline
                .apply_hook_input_rewrite(&task, json!({ "city": "copy" }))
                .await
        );
        let persisted = pipeline
            .state_manager
            .get_task(&tool_id)
            .expect("rewritten task");
        assert_eq!(
            persisted.original_effective_arguments,
            json!({ "city": "protected" })
        );
        assert_eq!(persisted.effective_arguments(), &json!({ "city": "copy" }));
        assert!(persisted
            .input_rewrite_rejection
            .as_ref()
            .is_some_and(ValidationResult::blocks_input_rewrite));

        let error = pipeline
            .execute_single_tool(tool_id)
            .await
            .expect_err("protected original input must block execution");
        assert!(matches!(error, OpenBitFunError::Validation(_)));
        assert!(received_arguments
            .lock()
            .expect("capturing tool argument lock")
            .is_none());
    }

    #[tokio::test]
    async fn hook_rewrite_cannot_hide_a_protected_target_behind_a_repairable_error() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;
        let task = test_tool_task_with_arguments(
            "rewrite-malformed-protected-original",
            "get_weather",
            json!({ "city": "protected", "unexpected": true }),
        );
        let tool_id = pipeline.state_manager.create_task(task.clone()).await;

        assert!(
            pipeline
                .apply_hook_input_rewrite(&task, json!({ "city": "Paris" }))
                .await,
            "a repairable schema error must not hide a protected original target"
        );
        let persisted = pipeline
            .state_manager
            .get_task(&tool_id)
            .expect("rewritten task");
        assert!(persisted
            .input_rewrite_rejection
            .as_ref()
            .is_some_and(ValidationResult::blocks_input_rewrite));

        let error = pipeline
            .execute_single_tool(tool_id)
            .await
            .expect_err("protected original target must block execution");
        assert!(matches!(error, OpenBitFunError::Validation(_)));
        assert!(received_arguments
            .lock()
            .expect("capturing tool argument lock")
            .is_none());
    }

    #[tokio::test]
    async fn hook_rewrite_can_repair_an_ordinary_validation_failure() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;
        let task = test_tool_task_with_arguments(
            "rewrite-repairable-original",
            "get_weather",
            json!({ "legacy_city": "Paris" }),
        );
        let tool_id = pipeline.state_manager.create_task(task.clone()).await;

        assert!(
            !pipeline
                .apply_hook_input_rewrite(&task, json!({ "city": "Paris" }))
                .await
        );
        let persisted = pipeline
            .state_manager
            .get_task(&tool_id)
            .expect("rewritten task");
        assert_eq!(
            persisted.original_effective_arguments,
            json!({ "legacy_city": "Paris" })
        );
        assert_eq!(persisted.effective_arguments(), &json!({ "city": "Paris" }));
        assert!(persisted.input_rewrite_rejection.is_none());

        pipeline
            .execute_single_tool(tool_id)
            .await
            .expect("repaired input should execute");
        assert_eq!(
            *received_arguments
                .lock()
                .expect("capturing tool argument lock"),
            Some(json!({ "city": "Paris" }))
        );
    }

    #[tokio::test]
    async fn final_validation_rejects_a_hook_rewrite_into_a_protected_input() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;
        let task = test_tool_task_with_arguments(
            "rewrite-protected-final",
            "get_weather",
            json!({ "city": "Paris" }),
        );
        let tool_id = pipeline.state_manager.create_task(task.clone()).await;

        assert!(
            !pipeline
                .apply_hook_input_rewrite(&task, json!({ "city": "protected" }))
                .await
        );
        assert!(pipeline
            .state_manager
            .get_task(&tool_id)
            .expect("rewritten task")
            .input_rewrite_rejection
            .is_none());

        let error = pipeline
            .execute_single_tool(tool_id)
            .await
            .expect_err("protected final input must fail final validation");
        assert!(matches!(error, OpenBitFunError::Validation(_)));
        assert!(received_arguments
            .lock()
            .expect("capturing tool argument lock")
            .is_none());
    }

    #[tokio::test]
    async fn hook_rewrite_recomputes_concurrency_from_final_input() {
        let pipeline = test_tool_pipeline();
        register_capturing_test_tool(&pipeline, "get_weather", Arc::new(Mutex::new(None))).await;
        let task = test_tool_task_with_arguments(
            "rewrite-concurrency",
            "get_weather",
            json!({ "city": "Paris" }),
        );
        let tool_id = pipeline.state_manager.create_task(task.clone()).await;

        assert!(
            pipeline
                .execution_traits_for_final_inputs(
                    std::slice::from_ref(&tool_id),
                    0,
                    SubagentBatchExecutionPolicy::SafeOnly,
                )
                .await[0]
                .0
        );
        assert!(
            !pipeline
                .apply_hook_input_rewrite(&task, json!({ "city": "unsafe" }))
                .await
        );
        assert!(
            !pipeline
                .execution_traits_for_final_inputs(
                    std::slice::from_ref(&tool_id),
                    0,
                    SubagentBatchExecutionPolicy::SafeOnly,
                )
                .await[0]
                .0
        );
    }

    /// The same approval does waive an interactive prompt when the policy
    /// only asks, so the call proceeds without a permission request.
    #[tokio::test]
    async fn hook_approval_waives_the_permission_prompt() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        pipeline
            .hook_preapprovals
            .lock()
            .await
            .insert("hook-approved".to_string());

        // No rule matches, so the policy would ask; nobody answers the prompt
        // in this test, so completing at all proves the prompt was waived.
        let results = pipeline
            .execute_tools(
                vec![test_tool_call("hook-approved", "Write")],
                permission_test_context(),
                ToolExecutionOptions::default(),
            )
            .await
            .expect("hook-approved tool should execute");

        assert!(!results[0].result.is_error);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edited_approval_executes_merged_input_and_rejection_never_executes() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(store);
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;
        let running = pipeline.clone();
        let execution = tokio::spawn(async move {
            running
                .execute_tools(
                    vec![
                        test_tool_call("edited", "Write"),
                        test_tool_call("denied", "Write"),
                    ],
                    permission_test_context(),
                    ToolExecutionOptions::default(),
                )
                .await
        });
        wait_for_permission_request_count(&manager, 2).await;
        pipeline
            .reply_to_tool(
                "edited",
                PermissionReply::OnceWithInput {
                    updated_input: json!({"content":"approved replacement"}),
                },
            )
            .await
            .expect("edited approval");
        pipeline
            .reply_to_tool("denied", PermissionReply::Reject { feedback: None })
            .await
            .expect("reject");
        let results = execution.await.unwrap().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            results[0].result.result["input"]["content"],
            "approved replacement"
        );
        assert_eq!(results[1].result.result["category"], "user_rejected");
        assert_eq!(
            pipeline
                .state_manager
                .get_task("edited")
                .unwrap()
                .effective_arguments()["content"],
            "approved replacement"
        );
    }

    #[tokio::test]
    async fn edited_approval_rejects_immutable_invalid_and_changed_concurrency_inputs() {
        let pipeline = test_tool_pipeline();
        let received = Arc::new(Mutex::new(None));
        pipeline
            .tool_registry
            .write()
            .await
            .register_tool(Arc::new(CapturingTestTool {
                name: "Capture".to_string(),
                received_arguments: received.clone(),
            }));
        let protected =
            test_tool_task_with_arguments("protected", "Capture", json!({"city":"protected"}));
        assert!(pipeline
            .validate_approval_input(&protected, json!({"city":"safe"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("protected"));
        let ordinary = test_tool_task_with_arguments("ordinary", "Capture", json!({"city":"safe"}));
        assert!(pipeline
            .validate_approval_input(&ordinary, json!({"city":42}))
            .await
            .is_err());
        assert!(pipeline
            .validate_approval_input(&ordinary, json!({"city":"unsafe"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("concurrency"));
        assert!(pipeline
            .validate_approval_input(&ordinary, json!([]))
            .await
            .is_err());
        assert!(received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn v2_rejecting_one_parallel_tool_does_not_reject_sibling() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let mut permission_events = manager.subscribe();
        let running_pipeline = pipeline.clone();
        let execution = tokio::spawn(async move {
            running_pipeline
                .execute_tools(
                    vec![
                        test_tool_call("reject-me", "Write"),
                        test_tool_call("keep-going", "Write"),
                    ],
                    permission_test_context(),
                    ToolExecutionOptions::default(),
                )
                .await
        });

        let requests = wait_for_permission_request_count(&manager, 2).await;
        assert_eq!(requests.len(), 2);
        let expected_project_path = std::env::temp_dir()
            .join("openbitfun-permission-test")
            .to_string_lossy()
            .to_string();
        assert_eq!(
            requests[0].project_path.as_deref(),
            Some(expected_project_path.as_str())
        );
        assert_eq!(requests[0].tool_call_id.as_deref(), Some("reject-me"));
        assert_eq!(requests[0].order, 0);
        assert_eq!(requests[1].tool_call_id.as_deref(), Some("keep-going"));
        assert_eq!(requests[1].order, 1);
        for (event, expected_request) in [
            permission_events.recv().await.expect("first asked event"),
            permission_events.recv().await.expect("second asked event"),
        ]
        .into_iter()
        .zip(requests.iter())
        {
            match event {
                openbitfun_runtime_ports::PermissionRequestEvent::Asked { request } => {
                    assert_eq!(request.request_id, expected_request.request_id);
                }
                other => panic!("expected asked event, got {other:?}"),
            }
        }
        let rejected_request = requests
            .iter()
            .find(|request| request.tool_call_id.as_deref() == Some("reject-me"))
            .expect("rejected tool permission request");
        let sibling_request = requests
            .iter()
            .find(|request| request.tool_call_id.as_deref() == Some("keep-going"))
            .expect("sibling tool permission request");

        manager
            .reply(
                &rejected_request.request_id,
                PermissionReply::Reject { feedback: None },
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("reject one tool");
        assert_eq!(
            manager
                .pending_requests()
                .iter()
                .map(|request| request.request_id.as_str())
                .collect::<Vec<_>>(),
            vec![sibling_request.request_id.as_str()]
        );

        manager
            .reply(
                &sibling_request.request_id,
                PermissionReply::Once,
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("allow sibling tool");

        let results = execution
            .await
            .expect("parallel tool execution join")
            .expect("parallel tool execution");
        assert_eq!(results.len(), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(results[0].result.result["category"], "user_rejected");
        assert!(results[0].result.result["instruction"].is_null());
        assert_eq!(
            results[0].result.result_for_assistant.as_deref(),
            Some(USER_REJECTED_TOOL_MESSAGE)
        );
        assert!(!results[1].result.is_error);
    }

    #[tokio::test]
    async fn v2_rejection_feedback_is_preserved_for_the_assistant() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let running_pipeline = pipeline.clone();
        let execution = tokio::spawn(async move {
            running_pipeline
                .execute_tools(
                    vec![test_tool_call("reject-with-feedback", "Write")],
                    permission_test_context(),
                    ToolExecutionOptions::default(),
                )
                .await
        });

        let request = wait_for_permission_request(&manager).await;
        manager
            .reply(
                &request.request_id,
                PermissionReply::Reject {
                    feedback: Some("Use a read-only path".to_string()),
                },
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("reject request with feedback");

        let results = execution
            .await
            .expect("feedback rejection task join")
            .expect("feedback rejection should return a structured result");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(results[0].result.result["category"], "user_rejected");
        assert_eq!(
            results[0].result.result["instruction"],
            "Use a read-only path"
        );
        assert_eq!(
            results[0].result.result_for_assistant.as_deref(),
            Some(
                "The user rejected this tool call with the following instruction: \"Use a read-only path\". Do not retry it unless the user explicitly asks you to. If you cannot complete the task without running this tool call, stop and ask the user how to proceed."
            )
        );
    }

    #[tokio::test]
    async fn v2_subagent_request_projects_exact_parent_task_context() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let running_pipeline = pipeline.clone();
        let execution = tokio::spawn(async move {
            running_pipeline
                .execute_tools(
                    vec![test_tool_call("child-write", "Write")],
                    subagent_permission_test_context("parent-task-call"),
                    ToolExecutionOptions::default(),
                )
                .await
        });

        let request = wait_for_permission_request(&manager).await;
        assert_eq!(request.session_id, "subagent-session");
        assert_eq!(request.tool_call_id.as_deref(), Some("child-write"));
        let delegation = request
            .delegation
            .as_ref()
            .expect("subagent request should project delegation context");
        assert_eq!(delegation.parent_session_id, "parent-session");
        assert_eq!(
            delegation.parent_dialog_turn_id.as_deref(),
            Some("parent-turn")
        );
        assert_eq!(delegation.parent_tool_call_id, "parent-task-call");
        assert_eq!(delegation.subagent_type, "Explore");

        manager
            .reply(
                &request.request_id,
                PermissionReply::Once,
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("allow child request");
        execution
            .await
            .expect("child task join")
            .expect("child execution");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn v2_request_routes_partial_persisted_subagent_delegation() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let mut context = permission_test_context();
        context.session_id = "subagent-session".to_string();
        context.agent_type = "Explore".to_string();
        context.permission_delegation =
            Some(openbitfun_runtime_ports::PermissionDelegationContext {
                parent_session_id: "parent-session".to_string(),
                parent_dialog_turn_id: None,
                parent_tool_call_id: "parent-task-call".to_string(),
                subagent_type: "Explore".to_string(),
            });

        let running_pipeline = pipeline.clone();
        let execution = tokio::spawn(async move {
            running_pipeline
                .execute_tools(
                    vec![test_tool_call("child-write", "Write")],
                    context,
                    ToolExecutionOptions::default(),
                )
                .await
        });

        let request = wait_for_permission_request(&manager).await;
        let delegation = request
            .delegation
            .as_ref()
            .expect("partial subagent lineage should route permission requests");
        assert_eq!(delegation.parent_session_id, "parent-session");
        assert_eq!(delegation.parent_dialog_turn_id, None);
        assert_eq!(delegation.parent_tool_call_id, "parent-task-call");

        manager
            .reply(
                &request.request_id,
                PermissionReply::Once,
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("allow child request");
        execution
            .await
            .expect("child task join")
            .expect("child execution");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn once_and_always_replies_control_execution_and_remembered_grants() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string(), "src/private/key.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let once_pipeline = pipeline.clone();
        let once = tokio::spawn(async move {
            once_pipeline
                .execute_tools(
                    vec![test_tool_call("once", "Write")],
                    permission_test_context(),
                    ToolExecutionOptions::default(),
                )
                .await
        });
        let request = wait_for_permission_request(&manager).await;
        assert_eq!(request.tool_call_id.as_deref(), Some("once"));
        assert!(request.delegation.is_none());
        manager
            .reply(
                &request.request_id,
                PermissionReply::Once,
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("once reply");
        once.await.expect("once task join").expect("once execution");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let always_pipeline = pipeline.clone();
        let always = tokio::spawn(async move {
            always_pipeline
                .execute_tools(
                    vec![test_tool_call("always", "Write")],
                    permission_test_context(),
                    ToolExecutionOptions::default(),
                )
                .await
        });
        let request = wait_for_permission_request(&manager).await;
        manager
            .reply(
                &request.request_id,
                PermissionReply::Always,
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("always reply");
        always
            .await
            .expect("always task join")
            .expect("always execution");
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        pipeline
            .execute_tools(
                vec![test_tool_call("remembered", "Write")],
                permission_test_context(),
                ToolExecutionOptions::default(),
            )
            .await
            .expect("remembered grant should allow the same project");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        assert_eq!(
            store.audit.lock().expect("permission audit lock").len(),
            4,
            "once and always should each persist requested and replied audit facts"
        );

        let mut other_project_context = permission_test_context();
        other_project_context.workspace = Some(WorkspaceBinding::new(
            None,
            std::env::temp_dir().join("openbitfun-permission-other-project"),
        ));
        let other_pipeline = pipeline.clone();
        let other_project = tokio::spawn(async move {
            other_pipeline
                .execute_tools(
                    vec![test_tool_call("other-project", "Write")],
                    other_project_context,
                    ToolExecutionOptions::default(),
                )
                .await
        });
        let other_request = wait_for_permission_request(&manager).await;
        let remembered_project_id = store
            .grants
            .lock()
            .expect("permission grant lock")
            .first()
            .expect("remembered grant")
            .project_id
            .clone();
        assert_ne!(other_request.project_id, remembered_project_id);
        manager
            .reply(
                &other_request.request_id,
                PermissionReply::Reject { feedback: None },
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("reject other project request");
        other_project
            .await
            .expect("other project task join")
            .expect("other project rejection");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let mut remote_context = permission_test_context();
        let local_root = remote_context
            .workspace
            .as_ref()
            .expect("local permission workspace")
            .root_path()
            .to_path_buf();
        let remote_identity =
            crate::service::remote_ssh::workspace_state::workspace_session_identity(
                local_root.to_string_lossy().as_ref(),
                Some("permission-remote-connection"),
                Some("remote.example"),
            )
            .expect("remote permission identity");
        remote_context.workspace = Some(WorkspaceBinding::new_remote(
            None,
            local_root,
            "permission-remote-connection".to_string(),
            "Remote permission test".to_string(),
            remote_identity,
        ));
        let remote_pipeline = pipeline.clone();
        let remote_execution = tokio::spawn(async move {
            remote_pipeline
                .execute_tools(
                    vec![test_tool_call("remote-project", "Write")],
                    remote_context,
                    ToolExecutionOptions::default(),
                )
                .await
        });
        let remote_request = wait_for_permission_request(&manager).await;
        assert_ne!(remote_request.project_id, remembered_project_id);
        assert!(remote_request.project_id.starts_with("remote_"));
        manager
            .reply(
                &remote_request.request_id,
                PermissionReply::Reject { feedback: None },
                openbitfun_runtime_ports::PermissionReplySource::User,
            )
            .await
            .expect("reject remote project request");
        remote_execution
            .await
            .expect("remote project task join")
            .expect("remote project rejection");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let mut deny_options = ToolExecutionOptions::default();
        deny_options.permission_policy = ResolvedPermissionPolicy::new(
            vec![
                PermissionRule::new("edit", "src/*", PermissionEffect::Allow),
                PermissionRule::new("edit", "src/private/*", PermissionEffect::Deny),
            ],
            Vec::new(),
        );
        pipeline
            .execute_tools(
                vec![test_tool_call("deny-after-grant", "Write")],
                permission_test_context(),
                deny_options,
            )
            .await
            .expect("policy denial should be structured");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn v2_auto_approve_subagent_ask_preserves_lineage_without_interactive_event() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let mut events = manager.subscribe();
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let mut options = ToolExecutionOptions::default();
        options.auto_approve_ask = true;
        pipeline
            .execute_tools(
                vec![test_tool_call("auto", "Write")],
                subagent_permission_test_context("background-task-call"),
                options,
            )
            .await
            .expect("auto-approved tool should execute");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(store
            .grants
            .lock()
            .expect("permission grant lock")
            .is_empty());
        let audit = store.audit.lock().expect("permission audit lock");
        assert_eq!(audit.len(), 2);
        assert!(audit.iter().all(|record| {
            record
                .request
                .delegation
                .as_ref()
                .is_some_and(|delegation| {
                    delegation.parent_tool_call_id == "background-task-call"
                        && delegation.subagent_type == "Explore"
                })
        }));
        assert!(matches!(audit[0].event, PermissionAuditEvent::Requested));
        assert!(matches!(
            audit[1].event,
            PermissionAuditEvent::Replied {
                reply: PermissionReply::Once,
                source: openbitfun_runtime_ports::PermissionReplySource::AutoApprove,
            }
        ));
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(manager.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn v2_cancellation_clears_pending_request_without_side_effect() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = permission_test_manager(Arc::clone(&store));
        let pipeline = test_tool_pipeline().with_permission_request_manager(Arc::clone(&manager));
        let calls = Arc::new(AtomicUsize::new(0));
        register_v2_file_test_tool(
            &pipeline,
            vec![PermissionIntent::new(
                "edit",
                vec!["src/main.rs".to_string()],
            )],
            Arc::clone(&calls),
        )
        .await;

        let running_pipeline = pipeline.clone();
        let task = tokio::spawn(async move {
            running_pipeline
                .execute_tools(
                    vec![test_tool_call("cancel", "Write")],
                    subagent_permission_test_context("cancelled-parent-task"),
                    ToolExecutionOptions::default(),
                )
                .await
        });
        let request = wait_for_permission_request(&manager).await;
        assert_eq!(
            request
                .delegation
                .as_ref()
                .map(|delegation| delegation.parent_tool_call_id.as_str()),
            Some("cancelled-parent-task")
        );
        pipeline
            .cancel_tool("cancel", "test cancellation".to_string())
            .await
            .expect("cancel tool");
        task.await
            .expect("cancel task join")
            .expect("cancel result");
        assert!(manager.pending_requests().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(store
            .audit
            .lock()
            .expect("permission audit lock")
            .iter()
            .any(|record| matches!(record.event, PermissionAuditEvent::Cancelled { .. })));
    }

    #[tokio::test]
    async fn deferred_gateway_normalizes_arguments_and_executes_effective_target() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;

        let mut context = test_tool_execution_context();
        context.allowed_tools = vec![
            CALL_DEFERRED_TOOL_NAME.to_string(),
            "get_weather".to_string(),
        ];
        context.deferred_tools = vec!["get_weather".to_string()];
        context.loaded_deferred_tool_specs = vec![loaded_spec(
            "get_weather",
            current_registry_generation(&pipeline).await,
        )];

        let mut call = test_tool_call("deferred_1", CALL_DEFERRED_TOOL_NAME);
        call.arguments = json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" },
            "city": "Beijing"
        });

        let results = pipeline
            .execute_tools(vec![call], context, ToolExecutionOptions::default())
            .await
            .expect("deferred tool execution");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_name, CALL_DEFERRED_TOOL_NAME);
        assert_eq!(results[0].effective_tool_name, "get_weather");
        assert_eq!(results[0].result.tool_name, CALL_DEFERRED_TOOL_NAME);
        assert_eq!(results[0].result.result["received"]["city"], "Shanghai");
        assert_eq!(
            *received_arguments
                .lock()
                .expect("capturing tool argument lock"),
            Some(json!({ "city": "Shanghai" }))
        );

        let task = pipeline
            .state_manager
            .get_task("deferred_1")
            .expect("deferred tool task");
        assert_eq!(task.tool_call.tool_name, CALL_DEFERRED_TOOL_NAME);
        assert_eq!(task.effective_tool_name(), "get_weather");
        assert_eq!(task.effective_arguments(), &json!({ "city": "Shanghai" }));
        assert_eq!(
            task.invocation.wire_arguments,
            json!({
                "tool_name": "get_weather",
                "args": {
                    "city": "Shanghai"
                }
            })
        );
    }

    #[tokio::test]
    async fn deferred_gateway_rejects_registry_refresh_before_execution() {
        let pipeline = test_tool_pipeline();
        let old_received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(
            &pipeline,
            "get_weather",
            Arc::clone(&old_received_arguments),
        )
        .await;
        let loaded_generation = current_registry_generation(&pipeline).await;

        let new_received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(
            &pipeline,
            "get_weather",
            Arc::clone(&new_received_arguments),
        )
        .await;

        let mut context = test_tool_execution_context();
        context.allowed_tools = vec![
            CALL_DEFERRED_TOOL_NAME.to_string(),
            "get_weather".to_string(),
        ];
        context.deferred_tools = vec!["get_weather".to_string()];
        context.loaded_deferred_tool_specs = vec![loaded_spec("get_weather", loaded_generation)];

        let mut call = test_tool_call("deferred_stale", CALL_DEFERRED_TOOL_NAME);
        call.arguments = json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" }
        });

        let results = pipeline
            .execute_tools(vec![call], context, ToolExecutionOptions::default())
            .await
            .expect("stale deferred call should become a per-tool error result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert_eq!(
            results[0].result.effective_tool_name.as_deref(),
            Some("get_weather")
        );
        assert!(results[0]
            .result
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("is stale"));
        assert_eq!(
            *old_received_arguments
                .lock()
                .expect("old capturing tool argument lock"),
            None
        );
        assert_eq!(
            *new_received_arguments
                .lock()
                .expect("new capturing tool argument lock"),
            None
        );
    }

    #[tokio::test]
    async fn deferred_gateway_requires_loaded_get_tool_spec_result() {
        let pipeline = test_tool_pipeline();
        register_capturing_test_tool(&pipeline, "get_weather", Arc::new(Mutex::new(None))).await;

        let mut context = test_tool_execution_context();
        context.allowed_tools = vec![
            CALL_DEFERRED_TOOL_NAME.to_string(),
            "get_weather".to_string(),
        ];
        context.deferred_tools = vec!["get_weather".to_string()];

        let mut call = test_tool_call("deferred_locked", CALL_DEFERRED_TOOL_NAME);
        call.arguments = json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" }
        });

        let results = pipeline
            .execute_tools(vec![call], context, ToolExecutionOptions::default())
            .await
            .expect("pipeline should return a per-tool error result");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_name, CALL_DEFERRED_TOOL_NAME);
        assert_eq!(results[0].effective_tool_name, "get_weather");
        assert!(results[0].result.is_error);
        assert!(results[0]
            .result
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("Call GetToolSpec first"));
    }

    #[tokio::test]
    async fn deferred_gateway_does_not_dispatch_direct_tools() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;

        let mut context = test_tool_execution_context();
        context.allowed_tools = vec![
            CALL_DEFERRED_TOOL_NAME.to_string(),
            "get_weather".to_string(),
        ];

        let mut call = test_tool_call("deferred_direct", CALL_DEFERRED_TOOL_NAME);
        call.arguments = json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" }
        });

        let results = pipeline
            .execute_tools(vec![call], context, ToolExecutionOptions::default())
            .await
            .expect("pipeline should return a per-tool error result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert!(results[0]
            .result
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("not an available deferred tool"));
        assert_eq!(
            *received_arguments
                .lock()
                .expect("capturing tool argument lock"),
            None
        );
    }

    fn test_round_injection(
        kind: RoundInjectionKind,
        tool_preemption: RoundInjectionToolPreemption,
    ) -> RoundInjection {
        RoundInjection {
            id: format!("injection-{:?}-{:?}", kind, tool_preemption),
            kind,
            execution_policy: RoundInjectionExecutionPolicy::new(tool_preemption),
            target: RoundInjectionTarget::CurrentRunningTurn,
            content: "test injection".to_string(),
            display_content: "test injection".to_string(),
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
            created_at: SystemTime::now(),
        }
    }

    fn assert_failed_task_contains(pipeline: &ToolPipeline, tool_id: &str, expected: &str) {
        let task = pipeline
            .state_manager
            .get_task(tool_id)
            .unwrap_or_else(|| panic!("{tool_id} task should be retained"));
        match task.state {
            ToolExecutionState::Failed { error, .. } => assert!(
                error.contains(expected),
                "failed task error should contain '{expected}', got '{error}'"
            ),
            state => panic!("expected failed task state, got {state:?}"),
        }
    }

    #[test]
    fn steering_interrupted_result_preserves_tool_call_identity() {
        let task = test_tool_task("tool_1", "Read");
        let result = build_user_steering_interrupted_result("tool_1", Some(task));

        assert_eq!(result.tool_id, "tool_1");
        assert_eq!(result.tool_name, "Read");
        assert!(result.result.is_error);
        assert_eq!(
            result.result.result["category"],
            serde_json::Value::String("user_steering_interrupted".to_string())
        );
        assert_eq!(
            result.result.result_for_assistant.as_deref(),
            Some(USER_STEERING_INTERRUPTED_MESSAGE)
        );
    }

    #[test]
    fn classified_edit_failure_preserves_model_error_and_persisted_detail() {
        let error = OpenBitFunError::ClassifiedTool {
            message: "[guidance] new_string must be different from old_string".into(),
            detail: openbitfun_core_types::errors::ToolErrorDetail {
                code: "edit_no_change".into(),
                kind: "guidance".into(),
            },
        };
        let result = build_error_execution_result("edit-1", None, &error);
        assert!(result.result.is_error);
        assert_eq!(
            result.result.result["error_detail"]["code"],
            "edit_no_change"
        );
        assert!(result
            .result
            .result_for_assistant
            .unwrap()
            .contains("new_string must be different"));
        assert!(!should_retry_tool_error(&error));
    }

    #[test]
    fn error_result_preserves_full_raw_arguments_for_unparseable_calls() {
        let mut task = test_tool_task("tool_1", "Worktree");
        task.tool_call.arguments = json!({});
        task.tool_call.is_error = true;
        let raw_arguments = format!("{{\"operation\":\"{}", "log".repeat(512));
        task.tool_call.raw_arguments = Some(raw_arguments.clone());

        let result = build_error_execution_result(
            "tool_1",
            Some(task),
            &OpenBitFunError::Validation("Arguments are invalid JSON.".to_string()),
        );

        assert_eq!(
            result.result.result["provided_arguments"],
            serde_json::Value::String(raw_arguments.clone())
        );
        assert!(result
            .result
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .ends_with(&raw_arguments));
        assert!(!result
            .result
            .result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("[truncated"));
    }

    #[test]
    fn error_result_omits_arguments_for_parsed_validation_errors() {
        let mut task = test_tool_task("tool_1", "Worktree");
        task.tool_call.raw_arguments = Some(r#"{\"operation\":\"log\"}"#.to_string());

        let result = build_error_execution_result(
            "tool_1",
            Some(task),
            &OpenBitFunError::Validation("operation is not supported".to_string()),
        );

        assert!(result.result.result["provided_arguments"].is_null());
        assert_eq!(
            result.result.result_for_assistant.as_deref(),
            Some(
                "Tool 'Worktree' failed (invalid_arguments): Validation error: operation is not supported"
            )
        );
    }

    #[tokio::test]
    async fn pipeline_admission_allowed_list_rejection_updates_failed_state_before_registry_lookup()
    {
        let pipeline = test_tool_pipeline();
        let mut context = test_tool_execution_context();
        context.allowed_tools = vec!["Read".to_string()];

        let results = pipeline
            .execute_tools(
                vec![test_tool_call("tool_1", "UnregisteredBlockedTool")],
                context,
                ToolExecutionOptions::default(),
            )
            .await
            .expect("admission rejection should be returned as an error result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert_failed_task_contains(
            &pipeline,
            "tool_1",
            "Tool 'UnregisteredBlockedTool' is not in the allowed list",
        );
        assert!(
            results[0]
                .result
                .result_for_assistant
                .as_deref()
                .unwrap_or_default()
                .contains("UnregisteredBlockedTool"),
            "error result should preserve rejected tool identity"
        );
    }

    #[tokio::test]
    async fn pipeline_admission_runtime_restriction_rejection_updates_failed_state() {
        let pipeline = test_tool_pipeline();
        let mut context = test_tool_execution_context();
        context
            .runtime_tool_restrictions
            .denied_tool_names
            .insert("Read".to_string());

        let results = pipeline
            .execute_tools(
                vec![test_tool_call("tool_1", "Read")],
                context,
                ToolExecutionOptions::default(),
            )
            .await
            .expect("admission rejection should be returned as an error result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert_failed_task_contains(
            &pipeline,
            "tool_1",
            "Tool 'Read' is denied by runtime restrictions",
        );
    }

    #[tokio::test]
    async fn pipeline_admission_direct_deferred_tool_requires_get_tool_spec() {
        let pipeline = test_tool_pipeline();
        let mut context = test_tool_execution_context();
        context.deferred_tools = vec!["WebFetch".to_string()];

        let results = pipeline
            .execute_tools(
                vec![test_tool_call("tool_1", "WebFetch")],
                context,
                ToolExecutionOptions::default(),
            )
            .await
            .expect("admission rejection should be returned as an error result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert_failed_task_contains(
            &pipeline,
            "tool_1",
            "Call GetToolSpec first with {\"tool_name\":\"WebFetch\"}",
        );
    }

    #[tokio::test]
    async fn pipeline_admission_allows_direct_deferred_tool_after_get_tool_spec() {
        let pipeline = test_tool_pipeline();
        let received_arguments = Arc::new(Mutex::new(None));
        register_capturing_test_tool(&pipeline, "get_weather", Arc::clone(&received_arguments))
            .await;

        let mut context = test_tool_execution_context();
        context.allowed_tools = vec!["get_weather".to_string()];
        context.deferred_tools = vec!["get_weather".to_string()];
        context.loaded_deferred_tool_specs = vec![loaded_spec(
            "get_weather",
            current_registry_generation(&pipeline).await,
        )];

        let mut call = test_tool_call("direct_deferred", "get_weather");
        call.arguments = json!({ "city": "Shanghai" });

        let results = pipeline
            .execute_tools(vec![call], context, ToolExecutionOptions::default())
            .await
            .expect("loaded deferred tool should support direct invocation");

        assert_eq!(results.len(), 1);
        assert!(!results[0].result.is_error);
        assert_eq!(
            received_arguments
                .lock()
                .expect("captured arguments lock")
                .as_ref(),
            Some(&json!({ "city": "Shanghai" }))
        );
    }

    #[tokio::test]
    async fn background_result_pending_does_not_skip_tool_execution() {
        let pipeline = test_tool_pipeline();
        register_static_test_tool(&pipeline, "Read", json!({ "ok": true }), 0).await;

        let buffer = Arc::new(SessionRoundInjectionBuffer::default());
        buffer.push(
            "session_1",
            test_round_injection(
                RoundInjectionKind::BackgroundResult,
                RoundInjectionKind::BackgroundResult
                    .default_execution_policy()
                    .tool_preemption,
            ),
        );

        let mut context = test_tool_execution_context();
        context.steering_interrupt = Some(DialogRoundInjectionInterrupt::new(
            "session_1".to_string(),
            "turn_1".to_string(),
            buffer,
        ));

        let results = pipeline
            .execute_tools(
                vec![test_tool_call("tool_1", "Read")],
                context,
                ToolExecutionOptions::default(),
            )
            .await
            .expect("background result should not skip tool execution");

        assert_eq!(results.len(), 1);
        assert!(!results[0].result.is_error);
        assert_eq!(results[0].result.result["ok"], json!(true));
    }

    #[tokio::test]
    async fn user_steering_pending_still_skips_remaining_tool_plan() {
        let pipeline = test_tool_pipeline();
        let buffer = Arc::new(SessionRoundInjectionBuffer::default());
        buffer.push(
            "session_1",
            test_round_injection(
                RoundInjectionKind::UserSteering,
                RoundInjectionKind::UserSteering
                    .default_execution_policy()
                    .tool_preemption,
            ),
        );

        let mut context = test_tool_execution_context();
        context.steering_interrupt = Some(DialogRoundInjectionInterrupt::new(
            "session_1".to_string(),
            "turn_1".to_string(),
            buffer,
        ));

        let results = pipeline
            .execute_tools(
                vec![
                    test_tool_call("tool_1", "Read"),
                    test_tool_call("tool_2", "Write"),
                ],
                context,
                ToolExecutionOptions::default(),
            )
            .await
            .expect("user steering skip should be surfaced as tool results");

        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].result.result["category"],
            json!("user_steering_interrupted")
        );
        assert_eq!(
            results[1].result.result["category"],
            json!("user_steering_interrupted")
        );
    }

    #[tokio::test]
    async fn custom_round_injection_can_cancel_running_tool_cooperatively() {
        let pipeline = test_tool_pipeline();
        register_static_test_tool(&pipeline, "Read", json!({ "ok": true }), 30_000).await;

        let buffer = Arc::new(SessionRoundInjectionBuffer::default());
        let buffer_for_injection = buffer.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(50)).await;
            buffer_for_injection.push(
                "session_1",
                test_round_injection(
                    RoundInjectionKind::UserSteering,
                    RoundInjectionToolPreemption::CancelRunningCooperatively,
                ),
            );
        });

        let mut context = test_tool_execution_context();
        context.steering_interrupt = Some(DialogRoundInjectionInterrupt::new(
            "session_1".to_string(),
            "turn_1".to_string(),
            buffer,
        ));
        let options = ToolExecutionOptions {
            allow_parallel: false,
            ..Default::default()
        };

        let results = pipeline
            .execute_tools(vec![test_tool_call("tool_1", "Read")], context, options)
            .await
            .expect("cooperative cancel should still return a tool result");

        assert_eq!(results.len(), 1);
        assert!(results[0].result.is_error);
        assert_eq!(results[0].result.result["category"], json!("cancelled"));
    }

    #[tokio::test]
    async fn yieldable_tools_end_normally_for_every_non_none_round_injection_policy() {
        for policy in [
            RoundInjectionToolPreemption::InterruptAfterCurrentAtomicUnit,
            RoundInjectionToolPreemption::CancelRunningCooperatively,
            RoundInjectionToolPreemption::CancelRunningForcefully,
        ] {
            let pipeline = test_tool_pipeline();
            register_yieldable_test_tool(&pipeline, "AgentWait", json!({ "status": "steered" }))
                .await;

            let buffer = Arc::new(SessionRoundInjectionBuffer::default());
            let buffer_for_injection = buffer.clone();
            tokio::spawn(async move {
                sleep(Duration::from_millis(50)).await;
                buffer_for_injection.push(
                    "session_1",
                    test_round_injection(RoundInjectionKind::UserSteering, policy),
                );
            });

            let mut context = test_tool_execution_context();
            context.steering_interrupt = Some(DialogRoundInjectionInterrupt::new(
                "session_1".to_string(),
                "turn_1".to_string(),
                buffer,
            ));
            let results = pipeline
                .execute_tools(
                    vec![test_tool_call("agent_wait", "AgentWait")],
                    context,
                    ToolExecutionOptions::default(),
                )
                .await
                .expect("yieldable tool should finish normally");

            assert_eq!(results.len(), 1, "policy: {policy:?}");
            assert!(!results[0].result.is_error, "policy: {policy:?}");
            assert_eq!(
                results[0].result.result["status"],
                json!("steered"),
                "policy: {policy:?}"
            );
            assert!(
                matches!(
                    pipeline
                        .state_manager
                        .get_task("agent_wait")
                        .map(|task| task.state),
                    Some(ToolExecutionState::Completed { .. })
                ),
                "policy: {policy:?}"
            );
        }
    }

    #[test]
    fn fallback_assistant_text_preserves_full_structured_result() {
        let result = convert_tool_result(
            FrameworkToolResult::Result {
                data: json!({
                    "success": false,
                    "exit_code": 1,
                    "working_directory": "/private/tmp",
                    "output": "ERR_PNPM_NO_PKG_MANIFEST"
                }),
                result_for_assistant: None,
                image_attachments: None,
            },
            "tool_1",
            "ExecCommand",
            "ExecCommand",
        );

        let assistant_text = result.result_for_assistant.unwrap_or_default();
        assert!(assistant_text.contains("\"success\": false"));
        assert!(assistant_text.contains("\"exit_code\": 1"));
        assert!(assistant_text.contains("\"working_directory\": \"/private/tmp\""));
        assert!(!assistant_text.contains("completed with error"));
    }

    #[test]
    fn typed_ok_false_result_is_a_semantic_tool_error() {
        let result = convert_tool_result(
            FrameworkToolResult::Result {
                data: json!({
                    "ok": false,
                    "domain": "browser",
                    "action": "open_builtin",
                    "error": {
                        "code": "TIMEOUT",
                        "message": "target did not become ready",
                    },
                }),
                result_for_assistant: Some("TIMEOUT: target did not become ready".to_string()),
                image_attachments: None,
            },
            "tool_1",
            "ControlHub",
            "ControlHub",
        );

        assert!(result.is_error);
        assert_eq!(result.result["ok"], false);
        assert_eq!(result.result["error"]["code"], "TIMEOUT");
        assert_eq!(
            result.result_for_assistant.as_deref(),
            Some("TIMEOUT: target did not become ready")
        );
    }

    #[test]
    fn normal_json_repair_notice_for_interactive_tools_does_not_claim_file_write() {
        let notice = build_normal_tool_json_repair_notice("AskUserQuestion");

        assert!(notice.contains("AskUserQuestion call contained malformed JSON"));
        assert!(notice.contains("fresh complete AskUserQuestion call"));
        assert!(!notice.contains("file was written"));
        assert!(!notice.contains("max_tokens"));
    }

    #[test]
    fn write_tail_closure_notice_keeps_write_continuation_guidance() {
        let notice = build_write_tail_closure_notice("Write");

        assert!(notice.contains("file may have been written with partial content"));
        assert!(notice.contains("latest Read result"));
        assert!(notice.contains("use Edit to add only the missing continuation"));
        assert!(!notice.contains("max_tokens"));
    }

    #[test]
    fn pipeline_preserves_core_owned_tool_context_without_portable_runtime_leak() {
        let pipeline = test_tool_pipeline();
        let mut task = test_tool_task("tool_context_1", "WebFetch");
        task.context
            .context_vars
            .insert("turn_index".to_string(), "7".to_string());
        task.context
            .context_vars
            .insert("acp_transport".to_string(), "true".to_string());
        task.context.deferred_tools = vec!["WebFetch".to_string()];
        task.context.loaded_deferred_tool_specs = vec![loaded_spec("WebFetch", 0)];
        task.context.runtime_tool_restrictions = ToolRuntimeRestrictions {
            allowed_tool_names: ["WebFetch"].into_iter().map(str::to_string).collect(),
            denied_tool_names: ["ExecCommand"].into_iter().map(str::to_string).collect(),
            denied_tool_messages: Default::default(),
            path_policy: Default::default(),
            miniapp_context_scope: None,
        };

        let context = pipeline.build_tool_use_context(&task, CancellationToken::new());

        assert_eq!(context.tool_call_id.as_deref(), Some("tool_context_1"));
        assert_eq!(context.agent_type.as_deref(), Some("agent"));
        assert_eq!(context.session_id.as_deref(), Some("session_1"));
        assert_eq!(context.dialog_turn_id.as_deref(), Some("turn_1"));
        assert_eq!(
            context.loaded_deferred_tool_specs,
            vec![loaded_spec("WebFetch", 0)]
        );
        assert!(context.cancellation_token().is_some());
        assert!(context
            .runtime_tool_restrictions
            .is_tool_allowed("WebFetch"));
        assert!(!context
            .runtime_tool_restrictions
            .is_tool_allowed("ExecCommand"));
        assert_eq!(context.custom_data["turn_index"], json!(7));
        assert!(!context.custom_data.contains_key("primary_model_provider"));
        assert!(!context
            .custom_data
            .contains_key("primary_model_supports_image_understanding"));
        assert_eq!(context.custom_data["acp_transport"], json!(true));

        let facts = context.to_tool_context_facts();
        let value = serde_json::to_value(&facts).expect("serialize context facts");
        assert_eq!(value["toolCallId"], "tool_context_1");
        assert_eq!(value["sessionId"], "session_1");
        assert!(value.get("unlockedCollapsedTools").is_none());
        assert!(value.get("customData").is_none());
        assert!(value.get("cancellationToken").is_none());
        assert!(value.get("workspaceServices").is_none());
    }

    #[test]
    fn deferred_tool_requires_loaded_catalog_spec() {
        let mut task = test_tool_task("tool_1", "WebFetch");
        task.context.deferred_tools = vec!["WebFetch".to_string()];

        let err = validate_tool_execution_admission(ToolExecutionAdmissionRequest {
            tool_name: &task.tool_call.tool_name,
            allowed_tools: &task.context.allowed_tools,
            runtime_tool_restrictions: &task.context.runtime_tool_restrictions,
            deferred_tools: &task.context.deferred_tools,
            loaded_deferred_tool_specs: &task.context.loaded_deferred_tool_specs,
            current_catalog_generation: 0,
            get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
        })
        .expect_err("deferred tool should require a loaded GetToolSpec result");

        assert!(err
            .to_string()
            .contains("Call GetToolSpec first with {\"tool_name\":\"WebFetch\"}"));
    }

    #[test]
    fn tool_catalog_rejects_reloading_already_loaded_tool() {
        let mut task = test_tool_task("tool_1", "GetToolSpec");
        task.tool_call.arguments = json!({ "tool_name": "WebFetch" });
        task.context.loaded_deferred_tool_specs = vec![loaded_spec("WebFetch", 0)];

        let result = validate_tool_execution_admission(ToolExecutionAdmissionRequest {
            tool_name: &task.tool_call.tool_name,
            allowed_tools: &task.context.allowed_tools,
            runtime_tool_restrictions: &task.context.runtime_tool_restrictions,
            deferred_tools: &task.context.deferred_tools,
            loaded_deferred_tool_specs: &task.context.loaded_deferred_tool_specs,
            current_catalog_generation: 0,
            get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
        });

        assert!(
            result.is_ok(),
            "GetToolSpec duplicate-load validation moved into GetToolSpec itself"
        );
    }

    #[test]
    fn task_tool_manages_its_own_execution_timeout() {
        let task_tool = TaskTool::new();
        assert!(task_tool.manages_own_execution_timeout());
    }
}
