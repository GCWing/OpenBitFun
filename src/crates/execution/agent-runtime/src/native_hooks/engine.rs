//! Hook dispatch: run matching command handlers for one lifecycle event.
//!
//! Process interface (Codex-compatible):
//! - The JSON payload is written to the handler's stdin.
//! - Exit code 0: stdout is interpreted as a JSON decision document when it
//!   parses; otherwise, for events where plain stdout is context
//!   (SessionStart, UserPromptSubmit, SubagentStart), the text becomes
//!   model-visible context.
//! - Exit code 2: the event is blocked; stderr provides the blocking reason.
//! - Any other exit code, spawn failure, or timeout: a non-blocking warning.

use super::call::{HookCall, HookCallPayload};
use super::handler::{
    CommandHookOptions, HookHandler, HookHandlerResult, HookToolMapping, PluginHookCall,
};
use super::kind::RuntimeHookKind;
use super::output::{non_empty, AgentHookOutcome, RawHookOutput};
use super::payload::AgentHookPayload;
use super::registry::{RuntimeHookErrorPolicy, RuntimeHookRegistry};
use super::settings::{AgentHookEvent, AgentHookHandler, AgentHookSettings};
use log::{debug, warn};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Cap for a single model-visible hook text (reason or context). Larger
/// output is truncated with a marker, mirroring the Codex output budget.
pub const MAX_HOOK_MODEL_OUTPUT_BYTES: usize = 10_000;

/// Cap for captured process output retained in memory.
const MAX_CAPTURED_OUTPUT_BYTES: usize = 1024 * 1024;

/// Executes configured hooks for agent lifecycle events.
#[derive(Debug, Clone, Default)]
pub struct AgentHookEngine {
    registry: RuntimeHookRegistry,
    settings: Option<Arc<AgentHookSettings>>,
    project_hooks_disabled: bool,
}

impl AgentHookEngine {
    pub fn new(settings: AgentHookSettings) -> Self {
        let registry = RuntimeHookRegistry::default();
        registry
            .register_batch(settings.registrations())
            .expect("parsed hook settings must produce valid registrations");
        Self {
            registry,
            settings: Some(Arc::new(settings)),
            project_hooks_disabled: false,
        }
    }

    pub fn with_registry(registry: RuntimeHookRegistry) -> Self {
        Self {
            registry,
            settings: None,
            project_hooks_disabled: false,
        }
    }

    pub fn with_project_hooks_enabled(mut self, enabled: bool) -> Self {
        self.project_hooks_disabled = !enabled;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.registry.plans().is_empty()
    }

    pub fn has_rules(&self, event: AgentHookEvent) -> bool {
        self.has_rules_for_workspace(event, None)
    }

    pub fn has_rules_for_workspace(
        &self,
        event: AgentHookEvent,
        workspace_scope: Option<&str>,
    ) -> bool {
        !self
            .registry
            .registrations_for_workspace(RuntimeHookKind::Lifecycle(event), workspace_scope)
            .is_empty()
    }

    pub fn has_rules_for_session(
        &self,
        event: AgentHookEvent,
        workspace_scope: Option<&str>,
        session_id: &str,
    ) -> bool {
        !self
            .registry
            .registrations_for_session(
                RuntimeHookKind::Lifecycle(event),
                workspace_scope,
                session_id,
            )
            .is_empty()
    }

    pub fn settings(&self) -> &AgentHookSettings {
        self.settings
            .as_deref()
            .expect("engine was constructed from a runtime hook registry")
    }

    pub fn registry(&self) -> &RuntimeHookRegistry {
        &self.registry
    }

    /// Run every matching handler for the payload's event, sequentially in
    /// configuration order (user layers before project layers), and fold
    /// their results into one [`AgentHookOutcome`].
    pub async fn dispatch(&self, payload: &AgentHookPayload, cwd: &Path) -> AgentHookOutcome {
        self.dispatch_for_workspace(payload, cwd, None).await
    }

    pub async fn dispatch_for_workspace(
        &self,
        payload: &AgentHookPayload,
        cwd: &Path,
        workspace_scope: Option<&str>,
    ) -> AgentHookOutcome {
        let event = payload.event();
        let mut outcome = AgentHookOutcome::default();
        let registrations = self.registry.registrations_for_session(
            RuntimeHookKind::Lifecycle(event),
            workspace_scope,
            &payload.common.session_id,
        );
        if registrations.is_empty() {
            return outcome;
        }
        let matcher_value = payload.event.matcher_value();
        let payload_value = payload.to_json();
        let call = lifecycle_call(payload, cwd);
        for registration in registrations.iter() {
            if self.project_hooks_disabled && registration.requires_project_trust {
                continue;
            }
            let options = &registration.command_options;
            let mapping = options
                .tool_mappings
                .iter()
                .find(|mapping| Some(mapping.runtime_name.as_str()) == matcher_value);
            if !registration.matcher.matches(matcher_value)
                && !mapping
                    .is_some_and(|mapping| registration.matcher.matches(Some(&mapping.hook_name)))
            {
                continue;
            }
            let mut once = match &options.once {
                Some(state) => Some(state.lock().await),
                None => None,
            };
            if once.as_deref().copied().unwrap_or(false) || !registration.is_active() {
                continue;
            }
            outcome.executed_handlers += 1;
            let finalized = match &registration.handler {
                HookHandler::Command(handler) => {
                    let mut input = payload_value.clone();
                    if let Some(mapping) = mapping {
                        input["tool_name"] = Value::String(mapping.hook_name.clone());
                        if let Err(reason) =
                            translate_input_fields(&mut input["tool_input"], mapping, false)
                        {
                            outcome.block_reason = Some(reason);
                            break;
                        }
                    }
                    let input_json = input.to_string();
                    let (finalized, succeeded) = tokio::select! {
                        biased;
                        _ = registration.cancelled() => {
                            outcome.block_reason = Some("Session skill hooks were cleared during this event".into());
                            break;
                        },
                        result = self.run_and_apply(
                            event,
                            handler,
                            &input_json,
                            cwd,
                            options,
                            mapping,
                            &mut outcome,
                        ) => result,
                    };
                    if succeeded {
                        if let Some(state) = once.as_deref_mut() {
                            *state = true;
                        }
                    }
                    finalized
                }
                HookHandler::Builtin { executor } => {
                    apply_handler_result(executor.execute(&call).await, &mut outcome)
                }
                HookHandler::Plugin {
                    executor,
                    instance_id,
                    hook_name,
                    generation_key,
                    revision,
                    ..
                } => {
                    let result = tokio::time::timeout(
                        Duration::from_millis(registration.plan.timeout_millis()),
                        executor.execute(PluginHookCall {
                            instance_id: instance_id.clone(),
                            workspace_scope: registration
                                .workspace_scope
                                .clone()
                                .unwrap_or_default(),
                            generation_key: generation_key.clone(),
                            revision: revision.clone(),
                            hook_name: hook_name.clone(),
                            input: payload.to_json(),
                            output: Value::Object(Default::default()),
                        }),
                    )
                    .await;
                    if let Err(error) = result.unwrap_or_else(|_| Err("timed out".to_string())) {
                        outcome.warnings.push(format!(
                            "Plugin hook '{}' for {event} failed: {error}",
                            registration.plan.id()
                        ));
                    }
                    false
                }
            };
            if finalized {
                break;
            }
        }
        outcome
    }

    /// Execute one provider hook snapshot and carry input/output mutations
    /// forward in registry order.
    pub async fn dispatch_plugin_hook(
        &self,
        workspace_scope: Option<&str>,
        hook_name: &str,
        input: Value,
        output: Value,
    ) -> PluginHookDispatchResult {
        self.dispatch_plugin_hook_for_generation(workspace_scope, None, hook_name, input, output)
            .await
    }

    pub async fn dispatch_plugin_hook_for_generation(
        &self,
        workspace_scope: Option<&str>,
        generation: Option<&super::handler::PluginHookGenerationIdentity>,
        hook_name: &str,
        mut input: Value,
        mut output: Value,
    ) -> PluginHookDispatchResult {
        let kind = RuntimeHookKind::PluginHook(hook_name.to_string());
        let registrations = match (workspace_scope, generation) {
            (Some(workspace_scope), Some(generation)) => self
                .registry
                .registrations_for_plugin_generation(kind.clone(), workspace_scope, generation),
            _ => self
                .registry
                .registrations_for_workspace(kind.clone(), workspace_scope),
        };
        let mut result = PluginHookDispatchResult::default();
        for registration in registrations.iter() {
            let HookHandler::Plugin {
                executor,
                instance_id,
                hook_name,
                generation_key,
                revision,
                ..
            } = &registration.handler
            else {
                continue;
            };
            result.executed_handlers += 1;
            let invocation = executor.execute(PluginHookCall {
                instance_id: instance_id.clone(),
                workspace_scope: registration.workspace_scope.clone().unwrap_or_default(),
                generation_key: generation_key.clone(),
                revision: revision.clone(),
                hook_name: hook_name.clone(),
                input: input.clone(),
                output: output.clone(),
            });
            match tokio::time::timeout(
                Duration::from_millis(registration.plan.timeout_millis()),
                invocation,
            )
            .await
            {
                Ok(Ok(transformed)) => {
                    if transformed.instance_id != *instance_id
                        || transformed.generation_key != *generation_key
                        || transformed.revision != *revision
                        || transformed.hook_name != *hook_name
                    {
                        let failure = format!(
                            "Plugin hook '{}' returned a mismatched generation lease",
                            registration.plan.id()
                        );
                        if plugin_error_stops_dispatch(registration.plan.error_policy()) {
                            result.failure = Some(failure);
                            break;
                        }
                        result.warnings.push(failure);
                        continue;
                    }
                    let generation_still_dispatchable = match (workspace_scope, generation) {
                        (Some(scope), Some(requested)) => self
                            .registry
                            .registrations_for_plugin_generation(kind.clone(), scope, requested)
                            .iter()
                            .any(|current| current.plan.id() == registration.plan.id()),
                        (Some(scope), None) => self
                            .registry
                            .registrations_for_workspace(kind.clone(), Some(scope))
                            .iter()
                            .any(|current| current.plan.id() == registration.plan.id()),
                        _ => true,
                    };
                    if !generation_still_dispatchable {
                        let failure = format!(
                            "Plugin hook '{}' generation is no longer active",
                            registration.plan.id()
                        );
                        if plugin_error_stops_dispatch(registration.plan.error_policy()) {
                            result.failure = Some(failure);
                            break;
                        }
                        result.warnings.push(failure);
                        continue;
                    }
                    input = transformed.input;
                    output = transformed.output;
                }
                Ok(Err(error)) => {
                    let failure =
                        format!("Plugin hook '{}' failed: {error}", registration.plan.id());
                    if plugin_error_stops_dispatch(registration.plan.error_policy()) {
                        result.failure = Some(failure);
                        break;
                    }
                    result.warnings.push(failure);
                }
                Err(_) => {
                    let failure = format!(
                        "Plugin hook '{}' timed out after {}ms",
                        registration.plan.id(),
                        registration.plan.timeout_millis()
                    );
                    if plugin_error_stops_dispatch(registration.plan.error_policy()) {
                        result.failure = Some(failure);
                        break;
                    }
                    result.warnings.push(failure);
                }
            }
        }
        result.input = input;
        result.output = output;
        result
    }

    pub async fn dispatch_call(
        &self,
        workspace_scope: Option<&str>,
        call: &HookCall,
    ) -> HookHandlerResult {
        let registrations = self
            .registry
            .registrations_for_workspace(call.kind.clone(), workspace_scope);
        let mut result = HookHandlerResult::default();
        for registration in registrations.iter() {
            if let HookHandler::Builtin { executor } = &registration.handler {
                merge_handler_result(executor.execute(call).await, &mut result);
            }
        }
        result
    }

    /// Returns (dispatch finalized, command exited successfully). A failed or
    /// cancelled once handler stays eligible for a later matching event.
    async fn run_and_apply(
        &self,
        event: AgentHookEvent,
        handler: &AgentHookHandler,
        payload_json: &str,
        cwd: &Path,
        options: &CommandHookOptions,
        mapping: Option<&HookToolMapping>,
        outcome: &mut AgentHookOutcome,
    ) -> (bool, bool) {
        let command = handler.effective_command();
        let timeout = handler.effective_timeout(event);
        debug!(
            "Running agent hook: event={}, command={}, timeout_ms={}",
            event,
            command,
            timeout.as_millis()
        );
        let run = run_hook_command(command, payload_json, cwd, timeout, &options.environment).await;
        let mut succeeded = false;
        let finalized = match run {
            HookCommandRun::SpawnFailed(error) => {
                outcome.warnings.push(format!(
                    "Hook '{command}' for {event} could not be started: {error}"
                ));
                false
            }
            HookCommandRun::TimedOut => {
                outcome.warnings.push(format!(
                    "Hook '{command}' for {event} timed out after {}s and was killed",
                    timeout.as_secs()
                ));
                false
            }
            HookCommandRun::Completed {
                exit_code,
                stdout,
                stderr,
            } => match exit_code {
                Some(0) => {
                    succeeded = true;
                    match serde_json::from_str::<RawHookOutput>(stdout.trim()) {
                        Ok(mut output) => {
                            if let Some(updated) = output
                                .hook_specific_output
                                .as_mut()
                                .and_then(|specific| specific.updated_input.as_mut())
                            {
                                if let Some(mapping) = mapping {
                                    if let Err(reason) =
                                        translate_input_fields(updated, mapping, true)
                                    {
                                        outcome.block_reason = Some(reason);
                                        return (true, succeeded);
                                    }
                                }
                            }
                            outcome.apply_output_with_ask(output, options.supports_ask)
                        }
                        Err(_) => {
                            let text = stdout.trim();
                            if !text.is_empty() && event.plain_stdout_is_context() {
                                outcome.additional_context.push(truncate_model_output(text));
                            }
                            false
                        }
                    }
                }
                Some(2) => {
                    let reason = non_empty(Some(stderr)).unwrap_or_else(|| {
                        format!("Hook '{command}' blocked this {event} event (exit code 2).")
                    });
                    if outcome.block_reason.is_none() {
                        outcome.block_reason = Some(truncate_model_output(&reason));
                    }
                    true
                }
                Some(code) => {
                    outcome.warnings.push(format!(
                        "Hook '{command}' for {event} exited with non-blocking code {code}"
                    ));
                    false
                }
                None => {
                    outcome.warnings.push(format!(
                        "Hook '{command}' for {event} was terminated by a signal"
                    ));
                    false
                }
            },
        };
        (finalized, succeeded)
    }
}

fn translate_input_fields(
    input: &mut Value,
    mapping: &HookToolMapping,
    reverse: bool,
) -> Result<(), String> {
    if let Some(adapter) = &mapping.input_adapter {
        if reverse {
            adapter.to_runtime(input)?;
        } else {
            adapter.to_hook(input)?;
        }
    }
    let Some(fields) = input.as_object_mut() else {
        return Ok(());
    };
    for (runtime, hook) in &mapping.input_fields {
        let (from, to) = if reverse {
            (hook, runtime)
        } else {
            (runtime, hook)
        };
        if let Some(value) = fields.remove(from) {
            fields.insert(to.clone(), value);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct PluginHookDispatchResult {
    pub input: Value,
    pub output: Value,
    pub warnings: Vec<String>,
    pub failure: Option<String>,
    pub executed_handlers: usize,
}

impl Default for PluginHookDispatchResult {
    fn default() -> Self {
        Self {
            input: Value::Null,
            output: Value::Null,
            warnings: Vec::new(),
            failure: None,
            executed_handlers: 0,
        }
    }
}

fn plugin_error_stops_dispatch(policy: RuntimeHookErrorPolicy) -> bool {
    matches!(
        policy,
        RuntimeHookErrorPolicy::FailTurn | RuntimeHookErrorPolicy::DenyTool
    )
}

fn lifecycle_call(payload: &AgentHookPayload, cwd: &Path) -> HookCall {
    HookCall {
        kind: RuntimeHookKind::Lifecycle(payload.event()),
        cwd: cwd.to_path_buf(),
        session_id: Some(payload.common.session_id.clone()),
        turn_id: payload.common.turn_id.clone(),
        workspace_root: Some(cwd.to_path_buf()),
        is_remote: false,
        model: Some(payload.common.model.clone()),
        bypass_permissions: matches!(
            payload.common.permission_mode,
            super::payload::AgentHookPermissionMode::BypassPermissions
        ),
        payload: HookCallPayload::Lifecycle(payload.event.clone()),
    }
}

fn apply_handler_result(result: HookHandlerResult, outcome: &mut AgentHookOutcome) -> bool {
    outcome.warnings.extend(result.warnings);
    outcome.additional_context.extend(result.additional_context);
    if outcome.block_reason.is_none() {
        outcome.block_reason = result.block_reason;
    }
    outcome.is_blocked()
}

fn merge_handler_result(result: HookHandlerResult, outcome: &mut HookHandlerResult) {
    outcome.warnings.extend(result.warnings);
    outcome.additional_context.extend(result.additional_context);
    if outcome.block_reason.is_none() {
        outcome.block_reason = result.block_reason;
    }
}

enum HookCommandRun {
    Completed {
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    TimedOut,
    SpawnFailed(String),
}

async fn run_hook_command(
    command: &str,
    payload_json: &str,
    cwd: &Path,
    timeout: Duration,
    environment: &std::collections::BTreeMap<String, String>,
) -> HookCommandRun {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = Command::new("sh");
        process.arg("-c").arg(command);
        process
    };
    process.envs(environment);
    if let Some(cwd) = existing_dir(cwd) {
        process.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return HookCommandRun::SpawnFailed(error.to_string()),
    };
    let mut stdin = child.stdin.take();

    // The stdin write must be inside the timeout and must not be awaited to
    // completion before the child is reaped: a handler that never reads stdin
    // blocks the write once the payload exceeds the pipe buffer, and a
    // handler that exits early makes the write fail with EPIPE. Driving the
    // write concurrently with `wait_with_output` covers both, and the whole
    // interaction is bounded by one timeout.
    let interaction = async {
        let write = async {
            if let Some(mut stdin) = stdin.take() {
                let _ = stdin.write_all(payload_json.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        };
        let (_, output) = tokio::join!(write, child.wait_with_output());
        output
    };

    match tokio::time::timeout(timeout, interaction).await {
        Ok(Ok(output)) => HookCommandRun::Completed {
            exit_code: output.status.code(),
            stdout: bounded_lossy_string(output.stdout),
            stderr: bounded_lossy_string(output.stderr),
        },
        Ok(Err(error)) => HookCommandRun::SpawnFailed(error.to_string()),
        // `kill_on_drop` reaps the child when the timeout drops the future.
        Err(_) => HookCommandRun::TimedOut,
    }
}

fn existing_dir(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    if path.is_dir() {
        Some(path.to_path_buf())
    } else {
        warn!(
            "Hook working directory does not exist; running without it: {}",
            path.display()
        );
        None
    }
}

fn bounded_lossy_string(mut bytes: Vec<u8>) -> String {
    if bytes.len() > MAX_CAPTURED_OUTPUT_BYTES {
        bytes.truncate(MAX_CAPTURED_OUTPUT_BYTES);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Truncate model-visible hook text to the output budget, preserving UTF-8.
pub(crate) fn truncate_model_output(text: &str) -> String {
    if text.len() <= MAX_HOOK_MODEL_OUTPUT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_HOOK_MODEL_OUTPUT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[hook output truncated]", &text[..end])
}

#[cfg(test)]
mod plugin_dispatch_tests {
    use super::AgentHookEngine;
    use crate::native_hooks::{
        AgentHookMatcher, PluginHookCall, PluginHookExecutor, PluginHookResult,
        RuntimeHookErrorPolicy, RuntimeHookKind, RuntimeHookPlan, RuntimeHookRegistration,
        RuntimeHookRegistry, RuntimeHookSource,
    };
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct FailingExecutor;

    #[async_trait]
    impl PluginHookExecutor for FailingExecutor {
        async fn execute(&self, _call: PluginHookCall) -> Result<PluginHookResult, String> {
            Err("before hook failed".to_string())
        }
    }

    struct CountingExecutor(Arc<AtomicUsize>);

    #[async_trait]
    impl PluginHookExecutor for CountingExecutor {
        async fn execute(&self, call: PluginHookCall) -> Result<PluginHookResult, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(PluginHookResult {
                instance_id: call.instance_id,
                generation_key: call.generation_key,
                revision: call.revision,
                hook_name: call.hook_name,
                input: call.input,
                output: call.output,
            })
        }
    }

    struct BlockingExecutor {
        started: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
    }

    #[async_trait]
    impl PluginHookExecutor for BlockingExecutor {
        async fn execute(&self, call: PluginHookCall) -> Result<PluginHookResult, String> {
            self.started.store(true, Ordering::SeqCst);
            while !self.release.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            Ok(PluginHookResult {
                instance_id: call.instance_id,
                generation_key: call.generation_key,
                revision: call.revision,
                hook_name: call.hook_name,
                input: call.input,
                output: json!({"args": {"stale": true}}),
            })
        }
    }

    #[tokio::test]
    async fn deny_tool_plugin_hook_failure_stops_the_ordered_chain() {
        let registry = RuntimeHookRegistry::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let registration = |id: &str, order, executor: Arc<dyn PluginHookExecutor>| {
            RuntimeHookRegistration::plugin(
                RuntimeHookPlan::new(
                    id,
                    RuntimeHookKind::PluginHook("tool.execute.before".to_string()),
                    RuntimeHookSource::Plugin,
                )
                .with_order(order)
                .with_error_policy(RuntimeHookErrorPolicy::DenyTool),
                "tool.execute.before",
                "instance-a",
                "generation-a",
                "revision-a",
                executor,
                AgentHookMatcher::Any,
            )
            .with_workspace_scope("workspace-a")
        };
        let token = registry
            .register_plugin_batch(vec![
                registration("first", 1, Arc::new(FailingExecutor)),
                registration("second", 2, Arc::new(CountingExecutor(calls.clone()))),
            ])
            .expect("plugin hooks register");
        registry.activate_plugin_batch("workspace-a", Some(&token));

        let result = AgentHookEngine::with_registry(registry)
            .dispatch_plugin_hook(
                Some("workspace-a"),
                "tool.execute.before",
                json!({}),
                json!({"args": {}}),
            )
            .await;

        assert_eq!(
            result.failure.as_deref(),
            Some("Plugin hook 'first' failed: before hook failed")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(result.executed_handlers, 1);
    }

    #[tokio::test]
    async fn retired_plugin_generation_cannot_publish_a_late_hook_result() {
        let registry = RuntimeHookRegistry::default();
        let started = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let registration = RuntimeHookRegistration::plugin(
            RuntimeHookPlan::new(
                "stale",
                RuntimeHookKind::PluginHook("tool.execute.before".to_string()),
                RuntimeHookSource::Plugin,
            )
            .with_timeout_millis(5_000)
            .with_error_policy(RuntimeHookErrorPolicy::DenyTool),
            "tool.execute.before",
            "instance-a",
            "generation-a",
            "revision-a",
            Arc::new(BlockingExecutor {
                started: started.clone(),
                release: release.clone(),
            }),
            AgentHookMatcher::Any,
        )
        .with_workspace_scope("workspace-a");
        let token = registry
            .register_plugin_batch(vec![registration])
            .expect("plugin hook registers");
        registry.activate_plugin_batch("workspace-a", Some(&token));
        let engine = AgentHookEngine::with_registry(registry.clone());
        let dispatch = tokio::spawn(async move {
            engine
                .dispatch_plugin_hook(
                    Some("workspace-a"),
                    "tool.execute.before",
                    json!({}),
                    json!({"args": {}}),
                )
                .await
        });
        while !started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        registry.withdraw_plugin_workspace("workspace-a");
        release.store(true, Ordering::SeqCst);

        let result = dispatch.await.expect("dispatch joins");
        assert_eq!(
            result.failure.as_deref(),
            Some("Plugin hook 'stale' generation is no longer active")
        );
        assert_eq!(result.output, json!({"args": {}}));
    }
}
