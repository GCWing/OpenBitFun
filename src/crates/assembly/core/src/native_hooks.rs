//! Product wiring for native OpenBitFun agent hooks.
//!
//! This module connects the portable hook engine
//! (`openbitfun_agent_runtime::native_hooks`) to OpenBitFun configuration and the
//! agent runtime dispatch sites:
//!
//! - Settings discovery: user scope `~/.config/openbitfun/config/hooks.json`
//!   plus project scope `{project}/.openbitfun/config/hooks.json`, both using the
//!   Codex-compatible `hooks.json` document schema.
//! - Gating: `hooks.enabled` and `hooks.project_hooks_enabled` in the app
//!   settings document. Project hooks are disabled by default because they
//!   execute commands declared inside the checked-out repository.
//! - Dispatch: typed helpers per lifecycle event, called from the
//!   conversation coordinator, execution engine, and tool pipeline.
//!
//! Hooks always execute on the local host. Remote workspaces skip hook
//! dispatch because the payload `cwd` and the hook process would disagree
//! about the filesystem they describe.

use crate::infrastructure::try_get_path_manager_arc;
use crate::service::config::get_global_config_service;
pub use crate::service::config::types::AgentHooksConfig;
use async_trait::async_trait;
use dashmap::DashMap;
use log::{debug, info, warn};
#[cfg(feature = "opencode-plugin-host")]
use openbitfun_agent_runtime::native_hooks::PluginHookDispatchResult;
use openbitfun_agent_runtime::native_hooks::{
    AgentHookEngine, AgentHookEvent, AgentHookEventPayload, AgentHookMatcher, AgentHookOutcome,
    AgentHookPayload, AgentHookPayloadCommon, AgentHookPermissionMode, AgentHookPermissionOutcome,
    AgentHookScope, AgentHookSettings, AgentHookSettingsLayer, BuiltinHookExecutor, HookCall,
    HookCallPayload, HookHandler, HookHandlerResult, RuntimeHookKind, RuntimeHookPlan,
    RuntimeHookRegistration, RuntimeHookRegistry, RuntimeHookSource, MAX_HOOKS_FILE_BYTES,
};
use openbitfun_agent_runtime::post_call_hooks::{
    resolve_deep_review_shared_context_tool_use, DeepReviewSharedContextToolUseFacts,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

const MAX_CACHED_WORKSPACE_HOOK_SOURCES: usize = 32;
const MAX_PENDING_CONTEXT_SESSIONS: usize = 1024;

pub(crate) fn new_runtime_hook_registry() -> RuntimeHookRegistry {
    runtime_hook_registry()
}

pub(crate) fn runtime_hook_registry() -> RuntimeHookRegistry {
    static REGISTRY: OnceLock<RuntimeHookRegistry> = OnceLock::new();
    REGISTRY
        .get_or_init(|| {
            let registry = RuntimeHookRegistry::default();
            registry
                .register_batch(vec![deep_review_builtin_registration()])
                .expect("deep review builtin registration must be valid");
            registry
        })
        .clone()
}

#[cfg(feature = "opencode-plugin-host")]
pub(crate) fn plugin_hook_registry(_workspace_scope: &str) -> RuntimeHookRegistry {
    runtime_hook_registry()
}

#[cfg(feature = "opencode-plugin-host")]
pub(crate) async fn dispatch_plugin_hook(
    workspace_scope: &str,
    generation: Option<&openbitfun_agent_runtime::native_hooks::PluginHookGenerationIdentity>,
    hook_name: &str,
    input: Value,
    output: Value,
) -> openbitfun_agent_runtime::native_hooks::PluginHookDispatchResult {
    AgentHookEngine::with_registry(plugin_hook_registry(workspace_scope))
        .dispatch_plugin_hook_for_generation(
            Some(workspace_scope),
            generation,
            hook_name,
            input,
            output,
        )
        .await
}

#[cfg(feature = "opencode-plugin-host")]
fn plugin_tool_before_output(result: PluginHookDispatchResult) -> Result<Option<Value>, String> {
    if let Some(failure) = result.failure {
        return Err(failure);
    }
    if result.executed_handlers == 0 {
        return Ok(None);
    }
    Ok(result
        .output
        .get("args")
        .cloned()
        .filter(|updated| updated != &serde_json::Value::Null))
}

#[cfg(feature = "opencode-plugin-host")]
fn plugin_tool_after_output(
    result: PluginHookDispatchResult,
) -> Result<Option<PluginToolAfterOutput>, String> {
    if let Some(failure) = result.failure {
        return Err(failure);
    }
    if result.executed_handlers == 0 {
        return Ok(None);
    }
    serde_json::from_value::<PluginToolAfterOutput>(result.output)
        .map(Some)
        .map_err(|error| format!("Invalid tool.execute.after output: {error}"))
}

#[cfg(feature = "opencode-plugin-host")]
pub(crate) async fn dispatch_plugin_tool_before(
    workspace_scope: &str,
    tool_name: &str,
    session_id: Option<&str>,
    call_id: Option<&str>,
    runtime_agent_key: Option<&str>,
    args: Value,
) -> Result<Option<Value>, String> {
    let generation = match runtime_agent_key {
        Some(runtime_agent_key) => {
            let generation = crate::plugin_host::plugin_hook_generation_for_agent(
                workspace_scope,
                runtime_agent_key,
            )
            .await;
            if crate::plugin_host::is_opencode_plugin_agent_runtime_key(runtime_agent_key)
                && generation.is_none()
            {
                return Ok(None);
            }
            generation
        }
        None => None,
    };
    let result = dispatch_plugin_hook(
        workspace_scope,
        generation.as_ref(),
        "tool.execute.before",
        serde_json::json!({
            "tool": tool_name,
            "sessionID": session_id,
            "callID": call_id,
        }),
        serde_json::json!({ "args": args }),
    )
    .await;
    for warning in &result.warnings {
        warn!("OpenCode plugin hook warning (tool.execute.before): {warning}");
    }
    plugin_tool_before_output(result)
}

#[cfg(feature = "opencode-plugin-host")]
pub(crate) async fn dispatch_plugin_tool_after(
    workspace_scope: &str,
    tool_name: &str,
    session_id: Option<&str>,
    call_id: Option<&str>,
    runtime_agent_key: Option<&str>,
    args: Value,
    title: String,
    output: String,
    metadata: Value,
) -> Result<Option<PluginToolAfterOutput>, String> {
    let generation = match runtime_agent_key {
        Some(runtime_agent_key) => {
            let generation = crate::plugin_host::plugin_hook_generation_for_agent(
                workspace_scope,
                runtime_agent_key,
            )
            .await;
            if crate::plugin_host::is_opencode_plugin_agent_runtime_key(runtime_agent_key)
                && generation.is_none()
            {
                return Ok(None);
            }
            generation
        }
        None => None,
    };
    let result = dispatch_plugin_hook(
        workspace_scope,
        generation.as_ref(),
        "tool.execute.after",
        serde_json::json!({
            "tool": tool_name,
            "sessionID": session_id,
            "callID": call_id,
            "args": args,
        }),
        serde_json::json!({
            "title": title,
            "output": output,
            "metadata": metadata,
        }),
    )
    .await;
    for warning in &result.warnings {
        warn!("OpenCode plugin hook warning (tool.execute.after): {warning}");
    }
    plugin_tool_after_output(result)
}

#[cfg(feature = "opencode-plugin-host")]
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PluginToolAfterOutput {
    pub(crate) title: String,
    pub(crate) output: String,
    pub(crate) metadata: Value,
}

#[cfg(feature = "opencode-plugin-host")]
impl PluginToolAfterOutput {
    pub(crate) fn into_model_output(self) -> String {
        let Self {
            title,
            output,
            metadata,
        } = self;
        // The Host carries title and metadata through the complete ordered
        // OpenCode Hook chain. OpenBitFun's stable ToolResult contract currently
        // has one mutable presentation field: the model-visible output. Keep
        // the raw result immutable and avoid inventing a second persistence/UI
        // schema until a product consumer for these two presentation facts is
        // specified.
        drop((title, metadata));
        output
    }
}

#[cfg(all(test, feature = "opencode-plugin-host"))]
mod plugin_tool_output_tests {
    use super::{plugin_tool_after_output, plugin_tool_before_output};
    use openbitfun_agent_runtime::native_hooks::PluginHookDispatchResult;
    use serde_json::{json, Value};

    fn dispatch_result(output: Value, executed_handlers: usize) -> PluginHookDispatchResult {
        PluginHookDispatchResult {
            input: Value::Null,
            output,
            warnings: Vec::new(),
            failure: None,
            executed_handlers,
        }
    }

    #[test]
    fn zero_plugin_handlers_do_not_report_before_or_after_transformations() {
        let before =
            plugin_tool_before_output(dispatch_result(json!({"args": {"cmd": "cargo check"}}), 0));
        assert_eq!(before.expect("zero-handler before result"), None);

        let after = plugin_tool_after_output(dispatch_result(
            json!({
                "title": "ExecCommand",
                "output": "raw output",
                "metadata": {}
            }),
            0,
        ));
        assert!(after.expect("zero-handler after result").is_none());
    }

    #[test]
    fn executed_plugin_handlers_still_publish_their_transformations() {
        let before =
            plugin_tool_before_output(dispatch_result(json!({"args": {"cmd": "cargo test"}}), 1))
                .expect("before hook output")
                .expect("executed before hook transformation");
        assert_eq!(before["cmd"], "cargo test");

        let after = plugin_tool_after_output(dispatch_result(
            json!({
                "title": "ExecCommand",
                "output": "transformed for the model",
                "metadata": {"source": "test"}
            }),
            1,
        ))
        .expect("after hook output")
        .expect("executed after hook transformation");
        assert_eq!(after.output, "transformed for the model");
        assert_eq!(after.metadata["source"], "test");
    }

    #[test]
    fn plugin_dispatch_failure_is_not_hidden_by_a_zero_handler_count() {
        let result = PluginHookDispatchResult {
            input: Value::Null,
            output: Value::Null,
            warnings: Vec::new(),
            failure: Some("plugin registry unavailable".to_string()),
            executed_handlers: 0,
        };

        assert_eq!(
            plugin_tool_before_output(result).expect_err("failure must be preserved"),
            "plugin registry unavailable"
        );
    }
}

#[cfg(feature = "opencode-plugin-host")]
pub(crate) fn clear_plugin_hook_workspace(workspace_scope: &str) {
    runtime_hook_registry().clear_source_workspace(RuntimeHookSource::Plugin, workspace_scope);
}

/// Everything a dispatch site knows about the running session.
#[derive(Debug, Clone, Copy)]
pub struct NativeHookSessionFacts<'a> {
    pub workspace_id: Option<&'a str>,
    pub session_id: &'a str,
    /// Present for turn-scoped events.
    pub turn_id: Option<&'a str>,
    pub workspace_root: Option<&'a Path>,
    pub is_remote_workspace: bool,
    pub model: &'a str,
    /// Maps to payload `permission_mode`: `bypassPermissions` when the turn
    /// auto-approves permission asks, `default` otherwise.
    pub bypass_permissions: bool,
}

#[derive(Debug, Default)]
pub struct UserPromptSubmitHookDecision {
    /// The prompt must not start; the reason is shown to the caller.
    pub block_reason: Option<String>,
    /// Model-visible context to prepend to the turn.
    pub additional_context: Vec<String>,
}

#[derive(Debug, Default)]
pub struct PreToolUseHookDecision {
    /// The tool call must not run; the reason is fed back to the model.
    pub deny_reason: Option<String>,
    /// The tool call bypasses the permission prompt for this invocation.
    pub allow: bool,
    /// Replacement tool arguments (`hookSpecificOutput.updatedInput`).
    pub updated_input: Option<Value>,
}

#[derive(Debug)]
pub struct PermissionRequestHookDecision {
    pub allow: bool,
    pub message: Option<String>,
}

#[derive(Debug, Default)]
pub struct PostToolUseHookDecision {
    /// Feedback the model must see (`decision: "block"` reason).
    pub block_reason: Option<String>,
    /// Extra model-visible context (`hookSpecificOutput.additionalContext`).
    pub additional_context: Vec<String>,
}

/// SessionStart hooks run when a session is created or restored.
/// Plain stdout context is buffered and injected into the next turn.
pub async fn dispatch_session_start(facts: NativeHookSessionFacts<'_>, source: &str) {
    let Some(dispatch) = prepare(facts, AgentHookEvent::SessionStart).await else {
        return;
    };
    let outcome = dispatch
        .run(AgentHookEventPayload::SessionStart {
            source: source.to_string(),
        })
        .await;
    let mut context = outcome.additional_context.clone();
    context.retain(|entry| !entry.trim().is_empty());
    if !context.is_empty() {
        let pending = pending_session_context();
        if pending.len() < MAX_PENDING_CONTEXT_SESSIONS {
            pending
                .entry(facts.session_id.to_string())
                .or_default()
                .extend(context);
        }
    }
}

/// Drain SessionStart context buffered for this session.
pub fn take_pending_session_context(session_id: &str) -> Vec<String> {
    pending_session_context()
        .remove(session_id)
        .map(|(_, context)| context)
        .unwrap_or_default()
}

/// UserPromptSubmit hooks run before the user prompt becomes a turn. A
/// blocking decision rejects the prompt; plain stdout and
/// `additionalContext` become model-visible context for the turn.
pub async fn dispatch_user_prompt_submit(
    facts: NativeHookSessionFacts<'_>,
    prompt: &str,
) -> UserPromptSubmitHookDecision {
    let mut decision = UserPromptSubmitHookDecision::default();
    let Some(dispatch) = prepare(facts, AgentHookEvent::UserPromptSubmit).await else {
        return decision;
    };
    let outcome = dispatch
        .run(AgentHookEventPayload::UserPromptSubmit {
            prompt: prompt.to_string(),
        })
        .await;
    decision.block_reason = outcome.block_reason.clone().or(outcome.stop_reason.clone());
    decision.additional_context = outcome.additional_context.clone();
    decision
}

/// PreToolUse hooks run before final tool-input validation and permission
/// evaluation. They may deny the call, pre-approve it, or propose rewritten
/// input. The tool pipeline independently prevents a rewrite from relaxing
/// non-relaxable validation constraints.
pub async fn dispatch_pre_tool_use(
    facts: NativeHookSessionFacts<'_>,
    tool_name: &str,
    tool_use_id: &str,
    tool_input: &Value,
) -> PreToolUseHookDecision {
    let mut decision = PreToolUseHookDecision::default();
    let Some(dispatch) = prepare(facts, AgentHookEvent::PreToolUse).await else {
        return decision;
    };
    let outcome = dispatch
        .run(AgentHookEventPayload::PreToolUse {
            tool_name: tool_name.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_input: tool_input.clone(),
        })
        .await;
    decision.updated_input = outcome.updated_input.clone();
    match &outcome.permission {
        Some(AgentHookPermissionOutcome::Deny { reason }) => {
            decision.deny_reason = Some(reason.clone().unwrap_or_else(|| {
                format!("A PreToolUse hook denied the '{tool_name}' tool call.")
            }));
        }
        Some(AgentHookPermissionOutcome::Allow { .. }) => {
            decision.allow = true;
        }
        None => {}
    }
    if decision.deny_reason.is_none() {
        if let Some(reason) = outcome.block_reason.clone() {
            decision.deny_reason = Some(reason);
        } else if let Some(reason) = outcome.stop_reason.clone() {
            // `continue: false` asks to stop the turn; the closest safe
            // enforcement at this dispatch site is denying the tool call.
            warn!(
                "PreToolUse hook requested a full turn stop; denying the tool call instead: tool={}",
                tool_name
            );
            decision.deny_reason = Some(reason);
        }
    }
    if decision.deny_reason.is_some() {
        decision.allow = false;
        decision.updated_input = None;
    }
    decision
}

/// PermissionRequest hooks run when a tool call would prompt the user.
/// Returns a decision only when a hook explicitly allowed or denied.
pub async fn dispatch_permission_request(
    facts: NativeHookSessionFacts<'_>,
    tool_name: &str,
    tool_input: &Value,
) -> Option<PermissionRequestHookDecision> {
    let dispatch = prepare(facts, AgentHookEvent::PermissionRequest).await?;
    let outcome = dispatch
        .run(AgentHookEventPayload::PermissionRequest {
            tool_name: tool_name.to_string(),
            tool_input: tool_input.clone(),
        })
        .await;
    if let Some(reason) = outcome.block_reason.clone() {
        return Some(PermissionRequestHookDecision {
            allow: false,
            message: Some(reason),
        });
    }
    match outcome.permission {
        Some(AgentHookPermissionOutcome::Deny { reason }) => Some(PermissionRequestHookDecision {
            allow: false,
            message: reason,
        }),
        Some(AgentHookPermissionOutcome::Allow { reason }) => Some(PermissionRequestHookDecision {
            allow: true,
            message: reason,
        }),
        None => None,
    }
}

/// PostToolUse hooks run after a tool call completed. Blocking feedback and
/// `additionalContext` are appended to the tool result the model reads.
pub async fn dispatch_post_tool_use(
    facts: NativeHookSessionFacts<'_>,
    tool_name: &str,
    tool_use_id: &str,
    tool_input: &Value,
    tool_response: &Value,
) -> PostToolUseHookDecision {
    let mut decision = PostToolUseHookDecision::default();
    let Some(dispatch) = prepare(facts, AgentHookEvent::PostToolUse).await else {
        return decision;
    };
    let outcome = dispatch
        .run(AgentHookEventPayload::PostToolUse {
            tool_name: tool_name.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_input: tool_input.clone(),
            tool_response: tool_response.clone(),
        })
        .await;
    decision.block_reason = outcome.block_reason.clone();
    decision.additional_context = outcome.additional_context.clone();
    decision
}

/// PreCompact hooks observe context compaction (`trigger`: `auto`|`manual`).
pub async fn dispatch_pre_compact(facts: NativeHookSessionFacts<'_>, trigger: &str) {
    if let Some(dispatch) = prepare(facts, AgentHookEvent::PreCompact).await {
        dispatch
            .run(AgentHookEventPayload::PreCompact {
                trigger: trigger.to_string(),
            })
            .await;
    }
}

/// PostCompact hooks observe completed context compaction.
pub async fn dispatch_post_compact(facts: NativeHookSessionFacts<'_>, trigger: &str) {
    if let Some(dispatch) = prepare(facts, AgentHookEvent::PostCompact).await {
        dispatch
            .run(AgentHookEventPayload::PostCompact {
                trigger: trigger.to_string(),
            })
            .await;
    }
}

/// SubagentStart hooks run when a subagent turn begins; plain stdout is
/// returned as model-visible context for the subagent.
pub async fn dispatch_subagent_start(
    facts: NativeHookSessionFacts<'_>,
    agent_id: &str,
    agent_type: &str,
) -> Vec<String> {
    let Some(dispatch) = prepare(facts, AgentHookEvent::SubagentStart).await else {
        return Vec::new();
    };
    let outcome = dispatch
        .run(AgentHookEventPayload::SubagentStart {
            agent_id: agent_id.to_string(),
            agent_type: agent_type.to_string(),
        })
        .await;
    outcome.additional_context.clone()
}

/// SubagentStop hooks run when a subagent turn settles. A blocking decision
/// is recorded (returned) but does not force the subagent to continue.
pub async fn dispatch_subagent_stop(
    facts: NativeHookSessionFacts<'_>,
    agent_id: &str,
    agent_type: &str,
    last_assistant_message: Option<&str>,
) -> Option<String> {
    let dispatch = prepare(facts, AgentHookEvent::SubagentStop).await?;
    let outcome = dispatch
        .run(AgentHookEventPayload::SubagentStop {
            agent_id: agent_id.to_string(),
            agent_type: agent_type.to_string(),
            agent_transcript_path: None,
            stop_hook_active: false,
            last_assistant_message: last_assistant_message.map(str::to_string),
        })
        .await;
    outcome.block_reason.clone()
}

/// Stop hooks run when the agent is about to finish a turn with a final
/// answer. A blocking decision returns the reason; the execution engine
/// injects it and continues the turn.
pub async fn dispatch_stop(
    facts: NativeHookSessionFacts<'_>,
    stop_hook_active: bool,
    last_assistant_message: Option<&str>,
) -> Option<String> {
    let dispatch = prepare(facts, AgentHookEvent::Stop).await?;
    let outcome = dispatch
        .run(AgentHookEventPayload::Stop {
            stop_hook_active,
            last_assistant_message: last_assistant_message.map(str::to_string),
        })
        .await;
    outcome.block_reason.clone()
}

/// SessionEnd hooks run when a session is deleted (`reason: "other"`).
/// Timeouts are capped tightly so deletion never hangs.
pub async fn dispatch_session_end(facts: NativeHookSessionFacts<'_>, reason: &str) {
    pending_session_context().remove(facts.session_id);
    if let Some(dispatch) = prepare(facts, AgentHookEvent::SessionEnd).await {
        dispatch
            .run(AgentHookEventPayload::SessionEnd {
                reason: reason.to_string(),
            })
            .await;
    }
}

/// Drop per-session hook state without dispatching anything.
pub fn clear_session_hook_state(session_id: &str) {
    pending_session_context().remove(session_id);
}

/// Built-in DeepReview shared-context measurement hook.
///
/// Registered as a SuccessfulToolPostCall builtin so the shared hook
/// registry owns it alongside command hooks, instead of a hard-coded
/// function call in the tool pipeline.
struct DeepReviewSharedContextExecutor;

#[async_trait]
impl BuiltinHookExecutor for DeepReviewSharedContextExecutor {
    async fn execute(&self, call: &HookCall) -> HookHandlerResult {
        let HookCallPayload::ToolUse {
            name,
            input,
            custom_data,
            agent_type,
        } = &call.payload
        else {
            return HookHandlerResult::default();
        };
        let facts = DeepReviewSharedContextToolUseFacts {
            tool_name: name.as_str(),
            input,
            custom_data,
            workspace_root: call.workspace_root.as_deref(),
            is_remote: call.is_remote,
            agent_type: agent_type.as_deref(),
        };
        if let Some(record) = resolve_deep_review_shared_context_tool_use(facts) {
            crate::agentic::deep_review_policy::record_deep_review_shared_context_tool_use(
                &record.parent_turn_id,
                &record.subagent_type,
                &record.tool_name,
                &record.measured_path,
            );
        }
        HookHandlerResult::default()
    }
}

fn deep_review_builtin_registration() -> RuntimeHookRegistration {
    let plan = RuntimeHookPlan::new(
        "deep-review.shared-context",
        RuntimeHookKind::SuccessfulToolPostCall,
        RuntimeHookSource::Builtin { priority: 0 },
    );
    RuntimeHookRegistration::new(
        plan,
        HookHandler::Builtin {
            executor: Arc::new(DeepReviewSharedContextExecutor),
        },
        AgentHookMatcher::Any,
    )
}

fn command_registration_id(
    source: RuntimeHookSource,
    workspace_scope: Option<&str>,
    original_id: &str,
) -> String {
    let identity = format!(
        "{}\0{}\0{}",
        source,
        workspace_scope.unwrap_or("<global>"),
        original_id
    );
    format!(
        "command.{}.{}",
        source,
        hex::encode(Sha256::digest(identity.as_bytes()))
    )
}

fn registrations_for_source(
    settings: AgentHookSettings,
    source: RuntimeHookSource,
    workspace_scope: Option<&str>,
) -> Vec<RuntimeHookRegistration> {
    settings
        .registrations()
        .into_iter()
        .filter(|entry| match source {
            RuntimeHookSource::UserCommand => entry.plan.source() == RuntimeHookSource::UserCommand,
            RuntimeHookSource::ProjectCommand => {
                entry.plan.source() == RuntimeHookSource::ProjectCommand
            }
            RuntimeHookSource::ImportedCommand => true,
            _ => false,
        })
        .map(|mut entry| {
            let original_id = entry.plan.id().to_string();
            entry.plan = entry
                .plan
                .with_source(source)
                .with_id(command_registration_id(
                    source,
                    workspace_scope,
                    &original_id,
                ));
            entry.workspace_scope = workspace_scope.map(str::to_string);
            entry
        })
        .collect()
}

fn publish_command_registrations(
    registry: &RuntimeHookRegistry,
    workspace_scope: Option<&str>,
    manual_settings: AgentHookSettings,
    imported_settings: AgentHookSettings,
) -> Result<(), openbitfun_agent_runtime::native_hooks::RuntimeHookRegistryError> {
    let manual = manual_settings.registrations();
    let user_entries = manual
        .iter()
        .filter(|entry| entry.plan.source() == RuntimeHookSource::UserCommand)
        .cloned()
        .map(|mut entry| {
            let original_id = entry.plan.id().to_string();
            entry.plan = entry.plan.with_id(command_registration_id(
                RuntimeHookSource::UserCommand,
                None,
                &original_id,
            ));
            entry
        })
        .collect();
    let project_entries = manual
        .into_iter()
        .filter(|entry| entry.plan.source() == RuntimeHookSource::ProjectCommand)
        .map(|mut entry| {
            let original_id = entry.plan.id().to_string();
            entry.plan = entry.plan.with_id(command_registration_id(
                RuntimeHookSource::ProjectCommand,
                workspace_scope,
                &original_id,
            ));
            entry.workspace_scope = workspace_scope.map(str::to_string);
            entry
        })
        .collect();
    let imported_entries = registrations_for_source(
        imported_settings,
        RuntimeHookSource::ImportedCommand,
        workspace_scope,
    );

    registry.replace_command_source(RuntimeHookSource::UserCommand, None, user_entries)?;
    registry.replace_command_source(
        RuntimeHookSource::ProjectCommand,
        workspace_scope,
        project_entries,
    )?;
    registry.replace_command_source(
        RuntimeHookSource::ImportedCommand,
        workspace_scope,
        imported_entries,
    )
}

/// Dispatch SuccessfulToolPostCall builtin hooks (currently the DeepReview
/// shared-context measurement) for one successful tool call. Command hooks
/// are not dispatched here because the tool pipeline owns post-call context.
pub async fn dispatch_successful_tool_post_call(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    is_remote: bool,
    tool_name: &str,
    input: &Value,
    custom_data: &HashMap<String, Value>,
    agent_type: Option<&str>,
) {
    let config = hooks_config().await;
    let Some(engine) = engine_for(workspace_id, workspace_root, config.project_hooks_enabled).await
    else {
        return;
    };
    let call = HookCall {
        kind: RuntimeHookKind::SuccessfulToolPostCall,
        cwd: workspace_root.map(Path::to_path_buf).unwrap_or_default(),
        session_id: None,
        turn_id: None,
        workspace_root: workspace_root.map(Path::to_path_buf),
        is_remote,
        model: None,
        bypass_permissions: false,
        payload: HookCallPayload::ToolUse {
            name: tool_name.to_string(),
            input: input.clone(),
            custom_data: custom_data.clone(),
            agent_type: agent_type.map(str::to_string),
        },
    };
    let _ = engine.dispatch_call(workspace_id, &call).await;
}

struct PreparedDispatch<'a> {
    engine: AgentHookEngine,
    facts: NativeHookSessionFacts<'a>,
    cwd: PathBuf,
    workspace_scope: Option<String>,
}

impl PreparedDispatch<'_> {
    async fn run(&self, event: AgentHookEventPayload) -> AgentHookOutcome {
        let payload = AgentHookPayload {
            common: AgentHookPayloadCommon {
                session_id: self.facts.session_id.to_string(),
                transcript_path: None,
                cwd: self.cwd.to_string_lossy().to_string(),
                model: self.facts.model.to_string(),
                permission_mode: if self.facts.bypass_permissions {
                    AgentHookPermissionMode::BypassPermissions
                } else {
                    AgentHookPermissionMode::Default
                },
                turn_id: self.facts.turn_id.map(str::to_string),
            },
            event,
        };
        let event_name = payload.event();
        let outcome = self
            .engine
            .dispatch_for_workspace(&payload, &self.cwd, self.workspace_scope.as_deref())
            .await;
        for warning in &outcome.warnings {
            warn!("Agent hook warning ({event_name}): {warning}");
        }
        for message in &outcome.system_messages {
            info!("Agent hook message ({event_name}): {message}");
        }
        outcome
    }
}

/// Resolve the hook engine for this event, or `None` when hooks are
/// disabled, unavailable for this workspace, or have no matching rules.
async fn prepare<'a>(
    facts: NativeHookSessionFacts<'a>,
    event: AgentHookEvent,
) -> Option<PreparedDispatch<'a>> {
    let config = hooks_config().await;
    if !config.enabled {
        return None;
    }
    if facts.is_remote_workspace {
        report_remote_workspace_skip(&facts, event).await;
        return None;
    }
    let engine = engine_for(
        facts.workspace_id,
        facts.workspace_root,
        config.project_hooks_enabled,
    )
    .await?;
    let workspace_scope = facts.workspace_id.map(str::to_owned);
    if !engine.has_rules_for_workspace(event, workspace_scope.as_deref()) {
        return None;
    }
    let cwd = facts
        .workspace_root
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    Some(PreparedDispatch {
        engine,
        facts,
        cwd,
        workspace_scope,
    })
}

/// Dot-path of the hook gates inside the settings document. Config paths
/// resolve against the serialized `GlobalConfig`, where `AppConfig` lives
/// under `app`.
pub(crate) const HOOKS_CONFIG_PATH: &str = "app.hooks";

/// A remote workspace never dispatches hooks: a local hook process and a
/// remote workspace path do not describe the same filesystem. The skip must
/// still be visible, so when the host-level hook configuration has rules for
/// this event the first skip per session is logged as a warning.
///
/// Only the host-owned user layer is consulted. The project layer of a remote
/// workspace lives on the remote host; deriving a controller-local path from
/// the remote root to look for it would be exactly the local read this skip
/// exists to prevent.
async fn report_remote_workspace_skip(facts: &NativeHookSessionFacts<'_>, event: AgentHookEvent) {
    let configured = match engine_for(None, None, false).await {
        Some(engine) => engine.has_rules_for_workspace(event, None),
        None => false,
    };
    if !configured {
        debug!(
            "Skipping agent hook dispatch for remote workspace: event={}, session_id={}",
            event, facts.session_id
        );
        return;
    }
    if remote_skip_already_reported(facts.session_id) {
        debug!(
            "Skipping configured agent hooks for remote workspace: event={}, session_id={}",
            event, facts.session_id
        );
        return;
    }
    warn!(
        "Configured agent hooks are not executed for a remote workspace: event={}, session_id={}, workspace_root={}; hooks run only where the workspace filesystem lives, and this host did not run them locally",
        event,
        facts.session_id,
        facts
            .workspace_root
            .map(|root| root.to_string_lossy().to_string())
            .unwrap_or_default()
    );
}

/// One warning per session keeps the skip visible without repeating it for
/// every tool call of a long remote turn. The set is bounded so a long-lived
/// host does not accumulate ids forever.
fn remote_skip_already_reported(session_id: &str) -> bool {
    const MAX_TRACKED_SESSIONS: usize = 1024;
    static REPORTED: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        OnceLock::new();
    let reported = REPORTED.get_or_init(Default::default);
    let Ok(mut reported) = reported.lock() else {
        return false;
    };
    if reported.contains(session_id) {
        return true;
    }
    if reported.len() >= MAX_TRACKED_SESSIONS {
        reported.clear();
    }
    reported.insert(session_id.to_string());
    false
}

async fn hooks_config() -> AgentHooksConfig {
    match get_global_config_service().await {
        Ok(service) => service
            .get_config::<AgentHooksConfig>(Some(HOOKS_CONFIG_PATH))
            .await
            .unwrap_or_default(),
        // Hosts without an initialized config service keep the defaults:
        // user hooks on, project hooks off.
        Err(_) => AgentHooksConfig::default(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HookFileFingerprint {
    path: PathBuf,
    modified: Option<std::time::SystemTime>,
    len: Option<u64>,
}

fn fingerprint(path: PathBuf) -> HookFileFingerprint {
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => HookFileFingerprint {
            modified: metadata.modified().ok(),
            len: Some(metadata.len()),
            path,
        },
        _ => HookFileFingerprint {
            modified: None,
            len: None,
            path,
        },
    }
}

struct CachedHookSourceState {
    workspace_scope: Option<String>,
    fingerprints: Vec<HookFileFingerprint>,
    project_hooks_enabled: bool,
    imported_generation: u64,
}

type HookSourceCache = tokio::sync::Mutex<BTreeMap<Option<String>, CachedHookSourceState>>;

fn hook_source_cache() -> &'static HookSourceCache {
    static CACHE: OnceLock<HookSourceCache> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(BTreeMap::new()))
}

fn pending_session_context() -> &'static DashMap<String, Vec<String>> {
    static PENDING: OnceLock<DashMap<String, Vec<String>>> = OnceLock::new();
    PENDING.get_or_init(DashMap::new)
}

/// Hook settings file paths for a workspace, in layer order (user first).
pub(crate) fn hook_settings_paths(
    workspace_root: Option<&Path>,
    project_hooks_enabled: bool,
) -> Vec<(AgentHookScope, PathBuf)> {
    let mut paths = Vec::new();
    if let Ok(path_manager) = try_get_path_manager_arc() {
        paths.push((AgentHookScope::User, path_manager.user_hooks_file()));
        if project_hooks_enabled {
            if let Some(workspace_root) = workspace_root {
                paths.push((
                    AgentHookScope::Project,
                    path_manager.project_hooks_file(workspace_root),
                ));
            }
        }
    }
    paths
}

/// Read each existing hook settings file, in the given layer order. Unreadable
/// or oversized files are skipped and reported so one bad layer cannot disable
/// the rest.
fn read_layers(paths: &[(AgentHookScope, PathBuf)]) -> (Vec<AgentHookSettingsLayer>, Vec<String>) {
    let mut layers = Vec::new();
    let mut skipped = Vec::new();
    for (scope, path) in paths {
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {
                if metadata.len() > MAX_HOOKS_FILE_BYTES as u64 {
                    skipped.push(format!(
                        "Ignoring hook configuration over the {} byte limit: {}",
                        MAX_HOOKS_FILE_BYTES,
                        path.display()
                    ));
                    continue;
                }
                match std::fs::read(path) {
                    Ok(bytes) => layers.push(AgentHookSettingsLayer {
                        scope: *scope,
                        source: path.to_string_lossy().to_string(),
                        bytes,
                    }),
                    Err(error) => skipped.push(format!(
                        "Failed to read hook configuration: path={}, error={}",
                        path.display(),
                        error
                    )),
                }
            }
            _ => {}
        }
    }
    (layers, skipped)
}

/// Read each existing hook settings file, in the given layer order, and parse
/// them into one engine. Unreadable or oversized files are skipped with a
/// warning so one bad layer cannot disable the rest.
#[cfg(test)]
pub(crate) fn build_engine(paths: &[(AgentHookScope, PathBuf)]) -> AgentHookEngine {
    let (layers, skipped) = read_layers(paths);
    for message in &skipped {
        warn!("{message}");
    }
    let (settings, issues) = AgentHookSettings::from_layers(&layers);
    for issue in &issues {
        warn!("Agent hook configuration issue: {issue}");
    }
    AgentHookEngine::new(settings)
}

async fn engine_for(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    project_hooks_enabled: bool,
) -> Option<AgentHookEngine> {
    let key = workspace_id.map(str::to_owned);
    let paths = hook_settings_paths(workspace_root, project_hooks_enabled);
    let fingerprints = paths
        .iter()
        .map(|(_, path)| fingerprint(path.clone()))
        .collect::<Vec<_>>();
    let imported_generation = {
        #[cfg(feature = "external-sources")]
        {
            match crate::external_hook_import::imported_hook_generation(workspace_id).await {
                Ok(generation) => generation,
                Err(error) => {
                    warn!("Imported Hook state is unavailable: {error}");
                    0
                }
            }
        }
        #[cfg(not(feature = "external-sources"))]
        {
            0
        }
    };
    {
        let cache = hook_source_cache().lock().await;
        if let Some(cached) = cache.get(&key) {
            if reusable_cached_hook_source(
                cached,
                &fingerprints,
                project_hooks_enabled,
                imported_generation,
            ) {
                return Some(AgentHookEngine::with_registry(runtime_hook_registry()));
            }
        }
    }

    let imported_layers = {
        #[cfg(feature = "external-sources")]
        {
            match crate::external_hook_import::enabled_imported_hook_layers(workspace_id).await {
                Ok(layers) => layers,
                Err(error) => {
                    warn!("Imported Hook layers are unavailable: {error}");
                    Vec::new()
                }
            }
        }
        #[cfg(not(feature = "external-sources"))]
        {
            Vec::new()
        }
    };
    let (manual_layers, skipped) = read_layers(&paths);
    for message in &skipped {
        warn!("{message}");
    }
    let (manual_settings, manual_issues) = AgentHookSettings::from_layers(&manual_layers);
    let (imported_settings, imported_issues) = AgentHookSettings::from_layers(&imported_layers);
    for issue in manual_issues.iter().chain(imported_issues.iter()) {
        warn!("Agent hook configuration issue: {issue}");
    }
    let workspace_scope = workspace_id.map(str::to_owned);
    if let Err(error) = publish_command_registrations(
        &runtime_hook_registry(),
        workspace_scope.as_deref(),
        manual_settings,
        imported_settings,
    ) {
        warn!("Failed to publish agent hook registrations: {error}");
        return None;
    }
    let mut cache = hook_source_cache().lock().await;
    if cache.len() >= MAX_CACHED_WORKSPACE_HOOK_SOURCES && !cache.contains_key(&key) {
        let oldest = cache.keys().next().cloned();
        if let Some(oldest) = oldest {
            if let Some(scope) = cache
                .remove(&oldest)
                .and_then(|entry| entry.workspace_scope)
            {
                let registry = runtime_hook_registry();
                registry.clear_source_workspace(RuntimeHookSource::ProjectCommand, &scope);
                registry.clear_source_workspace(RuntimeHookSource::ImportedCommand, &scope);
            }
        }
    }
    cache.insert(
        key,
        CachedHookSourceState {
            workspace_scope,
            fingerprints,
            project_hooks_enabled,
            imported_generation,
        },
    );
    Some(AgentHookEngine::with_registry(runtime_hook_registry()))
}

fn reusable_cached_hook_source(
    cached: &CachedHookSourceState,
    fingerprints: &[HookFileFingerprint],
    project_hooks_enabled: bool,
    imported_generation: u64,
) -> bool {
    cached.fingerprints == fingerprints
        && cached.project_hooks_enabled == project_hooks_enabled
        && cached.imported_generation == imported_generation
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn runtime_hook_registry_handles_share_the_process_runtime_owner() {
        let workspace_scope = format!("runtime-hook-registry-test-{}", uuid::Uuid::new_v4());
        let first = new_runtime_hook_registry();
        let second = runtime_hook_registry();

        first.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some(&workspace_scope),
            openbitfun_agent_runtime::native_hooks::RuntimeHookActivation::Ready,
        );

        assert_eq!(
            second
                .source_activation_for_workspace(RuntimeHookSource::Plugin, Some(&workspace_scope)),
            openbitfun_agent_runtime::native_hooks::RuntimeHookActivation::Ready
        );
        second.clear_source_workspace(RuntimeHookSource::Plugin, &workspace_scope);
    }

    #[test]
    fn imported_generation_invalidates_the_cached_hook_source_state() {
        let cached = CachedHookSourceState {
            workspace_scope: None,
            fingerprints: Vec::new(),
            project_hooks_enabled: false,
            imported_generation: 7,
        };

        assert!(reusable_cached_hook_source(&cached, &[], false, 7));
        assert!(!reusable_cached_hook_source(&cached, &[], false, 8));
    }
}

/// One `type: "command"` handler as configured, for read-only display.
#[derive(Debug, Clone)]
pub struct NativeHookHandlerView {
    /// The command this host would run (`commandWindows` already applied).
    pub command: String,
    /// Timeout actually applied, after the per-event default and cap.
    pub timeout_seconds: u64,
    pub status_message: Option<String>,
}

/// One matcher group as configured, for read-only display.
#[derive(Debug, Clone)]
pub struct NativeHookRuleView {
    pub event: &'static str,
    /// Matcher as written; `*` when the group matches everything.
    pub matcher: String,
    /// `false` when the pattern is malformed, which never matches anything.
    pub matcher_is_valid: bool,
    pub scope: &'static str,
    /// The file this group came from.
    pub source: String,
    pub handlers: Vec<NativeHookHandlerView>,
}

/// One configuration layer, whether or not it currently contributes.
#[derive(Debug, Clone)]
pub struct NativeHookFileView {
    pub scope: &'static str,
    pub path: PathBuf,
    pub exists: bool,
    /// `false` when the layer is gated off, so its rules are not loaded.
    pub loaded: bool,
}

/// Everything the hook configuration would contribute to a session in this
/// workspace. Nothing here executes a handler.
#[derive(Debug, Clone)]
pub struct NativeHookOverview {
    pub enabled: bool,
    pub project_hooks_enabled: bool,
    pub files: Vec<NativeHookFileView>,
    /// Matcher groups in dispatch order, grouped by event.
    pub rules: Vec<NativeHookRuleView>,
    pub total_handlers: usize,
    /// Configuration problems, in the wording used for the backend log.
    pub issues: Vec<String>,
    /// `true` when the workspace is remote: the rules above describe what is
    /// configured on this host, but none of them run for that workspace.
    pub remote_workspace_unsupported: bool,
}

/// Read the hook configuration for a workspace without dispatching anything.
///
/// This is the read-only view behind the CLI `/hooks` command and any other
/// surface that needs to show what is configured. It re-reads the files rather
/// than consulting the dispatch cache, so it always reflects what is on disk.
pub async fn overview(workspace_id: Option<&str>) -> Result<NativeHookOverview, String> {
    let record = match workspace_id {
        Some(id) => Some(
            crate::service::workspace::get_global_workspace_service()
                .ok_or("Workspace service is unavailable")?
                .require_workspace(id)
                .await
                .map_err(|error| error.to_string())?,
        ),
        None => None,
    };
    Ok(overview_with_facts(
        workspace_id,
        record.as_ref().map(|record| record.root_path.as_path()),
        record.as_ref().is_some_and(|record| {
            record.workspace_kind == crate::service::workspace::WorkspaceKind::Remote
        }),
    )
    .await)
}

/// [`overview`] with the session's remote fact. For a remote workspace only
/// the host-owned user layer is inspected (the project layer lives on the
/// remote host and no controller-local path is derived from the remote root),
/// and the result is flagged so surfaces can say the hooks will not run.
pub(crate) async fn overview_with_facts(
    workspace_id: Option<&str>,
    workspace_root: Option<&Path>,
    is_remote_workspace: bool,
) -> NativeHookOverview {
    // Ask for every candidate path, then mark which layers a dispatch would
    // actually load, so the view can show a gated-off project file.
    let config = hooks_config().await;
    let local_root = if is_remote_workspace {
        None
    } else {
        workspace_root
    };
    let imported_layers = if config.enabled {
        #[cfg(feature = "external-sources")]
        {
            crate::external_hook_import::enabled_imported_hook_layers(if is_remote_workspace {
                None
            } else {
                workspace_id
            })
            .await
            .unwrap_or_default()
        }
        #[cfg(not(feature = "external-sources"))]
        {
            let _ = workspace_id;
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let mut overview = build_overview_with_imports(
        config,
        hook_settings_paths(local_root, true),
        imported_layers,
    );
    overview.remote_workspace_unsupported = is_remote_workspace;
    overview
}

#[cfg(test)]
pub(crate) fn build_overview(
    config: AgentHooksConfig,
    candidates: Vec<(AgentHookScope, PathBuf)>,
) -> NativeHookOverview {
    build_overview_with_imports(config, candidates, Vec::new())
}

pub(crate) fn build_overview_with_imports(
    config: AgentHooksConfig,
    candidates: Vec<(AgentHookScope, PathBuf)>,
    imported_layers: Vec<AgentHookSettingsLayer>,
) -> NativeHookOverview {
    let mut files = candidates
        .iter()
        .map(|(scope, path)| NativeHookFileView {
            scope: scope.as_str(),
            path: path.clone(),
            exists: path.is_file(),
            loaded: config.enabled
                && (*scope == AgentHookScope::User || config.project_hooks_enabled),
        })
        .collect::<Vec<_>>();

    let loaded_paths = candidates
        .into_iter()
        .zip(files.iter())
        .filter(|(_, file)| file.loaded)
        .map(|(candidate, _)| candidate)
        .collect::<Vec<_>>();
    let (manual_layers, skipped) = read_layers(&loaded_paths);
    files.extend(imported_layers.iter().map(|layer| NativeHookFileView {
        scope: layer.scope.as_str(),
        path: PathBuf::from(&layer.source),
        exists: true,
        loaded: config.enabled,
    }));
    let layers = ordered_layers(manual_layers, imported_layers);
    let (settings, issues) = AgentHookSettings::from_layers(&layers);

    let mut rules = Vec::new();
    for event in AgentHookEvent::ALL {
        for rule in settings.rules_for(event) {
            rules.push(NativeHookRuleView {
                event: event.as_str(),
                matcher: rule.matcher.display().to_string(),
                // A malformed pattern parses into `Pattern` with no compiled
                // regex, which never matches — same practical outcome as an
                // outright invalid matcher, so both report as invalid here.
                matcher_is_valid: match &rule.matcher {
                    AgentHookMatcher::Any => true,
                    AgentHookMatcher::Pattern { regex, .. } => regex.is_some(),
                    AgentHookMatcher::Invalid { .. } => false,
                },
                scope: rule.scope.as_str(),
                source: rule.source.clone(),
                handlers: rule
                    .handlers
                    .iter()
                    .map(|handler| NativeHookHandlerView {
                        command: handler.effective_command().to_string(),
                        timeout_seconds: handler.effective_timeout(event).as_secs(),
                        status_message: handler.status_message.clone(),
                    })
                    .collect(),
            });
        }
    }

    NativeHookOverview {
        enabled: config.enabled,
        project_hooks_enabled: config.project_hooks_enabled,
        files,
        total_handlers: settings.total_handlers(),
        rules,
        issues: skipped
            .into_iter()
            .chain(issues.iter().map(ToString::to_string))
            .collect(),
        remote_workspace_unsupported: false,
    }
}

pub(crate) fn ordered_layers(
    manual: Vec<AgentHookSettingsLayer>,
    imported: Vec<AgentHookSettingsLayer>,
) -> Vec<AgentHookSettingsLayer> {
    let mut layers = Vec::with_capacity(manual.len() + imported.len());
    layers.extend(
        manual
            .iter()
            .filter(|layer| layer.scope == AgentHookScope::User)
            .cloned(),
    );
    layers.extend(
        imported
            .iter()
            .filter(|layer| layer.scope == AgentHookScope::User)
            .cloned(),
    );
    layers.extend(
        manual
            .into_iter()
            .filter(|layer| layer.scope == AgentHookScope::Project),
    );
    layers.extend(
        imported
            .into_iter()
            .filter(|layer| layer.scope == AgentHookScope::Project),
    );
    layers
}
