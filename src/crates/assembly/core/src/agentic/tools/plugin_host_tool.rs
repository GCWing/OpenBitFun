use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_events::ToolExecutionProgressInfo;
use openbitfun_runtime_ports::{
    HookFunctionCancelRequest, HookFunctionGeneration, HookFunctionReverseAsk,
    HookFunctionReverseMetadata, HookFunctionReverseReply, HookFunctionReverseSink,
    HookFunctionRuntime, HookFunctionToolContext, HookFunctionToolRequest, HookFunctionToolResult,
    PortError, PortErrorKind, PortResult,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

#[derive(Clone)]
struct PluginHostToolRoute {
    runtime: Arc<dyn HookFunctionRuntime>,
    host_generation: u64,
    instance_id: String,
    generation_key: String,
    revision: String,
    registration_id: String,
    description: String,
    parameters: Value,
    allowed_runtime_agent_keys: BTreeSet<String>,
}

#[derive(Clone)]
struct PluginToolExecutionRoute {
    session_id: String,
    dialog_turn_id: String,
    agent: String,
    tool_name: String,
    tool_call_id: Option<String>,
    generation_key: String,
    revision: String,
    cancelled: tokio::sync::watch::Receiver<bool>,
}

fn executions() -> &'static dashmap::DashMap<(String, String), PluginToolExecutionRoute> {
    static EXECUTIONS: OnceLock<dashmap::DashMap<(String, String), PluginToolExecutionRoute>> =
        OnceLock::new();
    EXECUTIONS.get_or_init(dashmap::DashMap::new)
}

struct PluginToolExecutionGuard {
    key: (String, String),
    cancel: tokio::sync::watch::Sender<bool>,
}

fn dispatched_tool_cancel_error(stopped: bool) -> OpenBitFunError {
    let detail = if stopped {
        "OpenCode plugin tool stopped after cancellation, but its side effects may already have committed"
    } else {
        "OpenCode plugin tool cancellation was not confirmed"
    };
    OpenBitFunError::OutcomeUnknown(detail.to_string())
}

impl Drop for PluginToolExecutionGuard {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        executions().remove(&self.key);
    }
}

struct PluginHostToolMux {
    id: String,
    hook_registry: openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry,
    routes: RwLock<BTreeMap<(String, String), PluginHostToolRoute>>,
}

impl PluginHostToolMux {
    fn new(
        id: String,
        hook_registry: openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry,
    ) -> Self {
        Self {
            id,
            hook_registry,
            routes: RwLock::new(BTreeMap::new()),
        }
    }
    fn set_route(&self, workspace_scope: String, route: PluginHostToolRoute) {
        let generation_key = route.generation_key.clone();
        self.routes
            .write()
            .expect("plugin tool route lock poisoned")
            .insert((workspace_scope, generation_key), route);
    }
    fn remove_route(&self, workspace_scope: &str, generation_key: &str) -> bool {
        self.routes
            .write()
            .expect("plugin tool route lock poisoned")
            .remove(&(workspace_scope.to_string(), generation_key.to_string()));
        self.routes
            .read()
            .expect("plugin tool route lock poisoned")
            .is_empty()
    }
    fn routes_for_scope(&self, workspace_scope: &str) -> Vec<PluginHostToolRoute> {
        if self.hook_registry.source_activation_for_workspace(
            openbitfun_agent_runtime::native_hooks::RuntimeHookSource::Plugin,
            Some(workspace_scope),
        ) != openbitfun_agent_runtime::native_hooks::RuntimeHookActivation::Ready
        {
            return Vec::new();
        }
        self.routes
            .read()
            .expect("plugin tool route lock poisoned")
            .iter()
            .filter(|((scope, _), _)| scope == workspace_scope)
            .map(|(_, route)| route)
            .cloned()
            .collect()
    }
    fn route_for(&self, context: Option<&ToolUseContext>) -> Option<PluginHostToolRoute> {
        let context = context?;
        if context.is_remote() {
            return None;
        }
        let runtime_agent_key = context.agent_type.as_deref()?;
        let scope = context.workspace_id()?;
        self.routes_for_scope(&scope).into_iter().find(|route| {
            route.allowed_runtime_agent_keys.is_empty()
                || route.allowed_runtime_agent_keys.contains(runtime_agent_key)
        })
    }
}

#[async_trait]
impl Tool for PluginHostToolMux {
    fn name(&self) -> &str {
        &self.id
    }
    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self
            .routes
            .read()
            .expect("plugin tool route lock poisoned")
            .values()
            .next()
            .map(|r| r.description.clone())
            .unwrap_or_default())
    }
    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        Ok(self
            .route_for(context)
            .map(|r| r.description)
            .unwrap_or_default())
    }
    fn short_description(&self) -> String {
        self.id.clone()
    }
    fn input_schema(&self) -> Value {
        self.routes
            .read()
            .expect("plugin tool route lock poisoned")
            .values()
            .next()
            .map(|r| r.parameters.clone())
            .unwrap_or_else(|| serde_json::json!({"type":"object"}))
    }
    async fn input_schema_for_model_with_context(&self, context: Option<&ToolUseContext>) -> Value {
        self.route_for(context)
            .map(|r| r.parameters)
            .unwrap_or_else(|| serde_json::json!({"type":"object"}))
    }
    fn dynamic_provider_id(&self) -> Option<&str> {
        Some("opencode-plugin")
    }
    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<crate::agentic::tools::framework::PermissionIntent>> {
        Ok(vec![
            crate::agentic::tools::framework::PermissionIntent::new(
                "custom_tool",
                vec![self.id.clone()],
            ),
        ])
    }
    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        self.route_for(context).is_some()
    }
    fn manages_own_execution_timeout(&self) -> bool {
        // Side-effecting plugin calls must reach the typed timeout/cancel path;
        // the generic pipeline timeout would drop the RPC future without a
        // confirmed terminal outcome.
        true
    }
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let route = self.route_for(Some(context)).ok_or_else(|| {
            OpenBitFunError::service("OpenCode plugin tool is not registered for this workspace")
        })?;
        // OpenCode execution IDs are Host-local operation identities. A model
        // tool-call ID is only a presentation correlation and can repeat across
        // sessions, so never use it as the reverse-RPC routing key.
        let execution_id = uuid::Uuid::new_v4().to_string();
        let generation = HookFunctionGeneration {
            instance_id: route.instance_id.clone(),
            generation_key: route.generation_key.clone(),
            revision: route.revision.clone(),
        };
        let execution_key = (route.instance_id.clone(), execution_id.clone());
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        executions().insert(
            execution_key.clone(),
            PluginToolExecutionRoute {
                session_id: context.session_id.clone().unwrap_or_default(),
                dialog_turn_id: context.dialog_turn_id.clone().unwrap_or_default(),
                agent: context.agent_type.clone().unwrap_or_default(),
                tool_name: self.id.clone(),
                tool_call_id: context.tool_call_id.clone(),
                generation_key: route.generation_key.clone(),
                revision: route.revision.clone(),
                cancelled,
            },
        );
        let _execution_guard = PluginToolExecutionGuard {
            key: execution_key.clone(),
            cancel,
        };
        let call = route.runtime.execute_tool(
            HookFunctionToolRequest {
                generation: generation.clone(),
                execution_id: execution_id.clone(),
                registration_id: route.registration_id.clone(),
                args: input.clone(),
                context: HookFunctionToolContext {
                    session_id: context.session_id.clone().unwrap_or_default(),
                    message_id: context.dialog_turn_id.clone().unwrap_or_default(),
                    agent: context.agent_type.clone().unwrap_or_default(),
                    call_id: context.tool_call_id.clone(),
                },
            },
            Duration::from_secs(120),
        );
        let result = if let Some(token) = context.cancellation_token() {
            tokio::select! {
                value = call => value,
                _ = token.cancelled() => {
                    let cancelled = match route.runtime.cancel(
                        HookFunctionCancelRequest {
                            generation: generation.clone(),
                            execution_id: execution_id.clone(),
                            reason: Some("cancelled".to_string()),
                        },
                        Duration::from_secs(5),
                    ).await {
                        Ok(cancelled) => cancelled,
                        Err(error) => {
                            crate::plugin_host::fault_configured_plugin_host_generation(
                                route.host_generation,
                                "plugin tool cancellation failed",
                            ).await;
                            return Err(OpenBitFunError::OutcomeUnknown(error.to_string()));
                        }
                    };
                    return if cancelled.stopped {
                        Err(dispatched_tool_cancel_error(true))
                    } else {
                        crate::plugin_host::fault_configured_plugin_host_generation(
                            route.host_generation,
                            "plugin tool cancellation was not confirmed",
                        )
                        .await;
                        Err(dispatched_tool_cancel_error(false))
                    };
                }
            }
        } else {
            call.await
        };
        let result = result.map_err(|error| match error.kind {
            // A timed-out/cancelled side-effecting plugin call may still have
            // completed in the Host. Preserve this distinction so the tool
            // pipeline never retries it as a transient service failure.
            PortErrorKind::OutcomeUnknown => OpenBitFunError::OutcomeUnknown(format!(
                "OpenCode plugin tool '{}' outcome is unknown: {}",
                self.id, error.message
            )),
            PortErrorKind::Cancelled => OpenBitFunError::Cancelled(error.message),
            PortErrorKind::Timeout => OpenBitFunError::Timeout(error.message),
            PortErrorKind::PermissionDenied => OpenBitFunError::Validation(error.message),
            _ => OpenBitFunError::service(format!(
                "OpenCode plugin tool '{}' failed: {error}",
                self.id
            )),
        });
        if matches!(result, Err(OpenBitFunError::OutcomeUnknown(_))) {
            crate::plugin_host::fault_configured_plugin_host_generation(
                route.host_generation,
                "plugin tool invocation outcome is unknown",
            )
            .await;
        }
        Ok(vec![map_plugin_tool_result(result?)])
    }
}

fn map_plugin_tool_result(result: HookFunctionToolResult) -> ToolResult {
    let mut output = result.output;
    if !result.attachments.is_empty() {
        let attachments = serde_json::to_value(result.attachments).unwrap_or(Value::Null);
        match &mut output {
            Value::Object(object) => {
                object.insert("attachments".to_string(), attachments);
            }
            other => {
                output = serde_json::json!({
                    "output": std::mem::take(other),
                    "attachments": attachments,
                });
            }
        }
    }
    let (data, assistant) = match output {
        Value::String(value) => (Value::String(value.clone()), Some(value)),
        Value::Object(object) => {
            let output = object.get("output").cloned().unwrap_or(Value::Null);
            let assistant = object
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_string);
            (
                Value::Object(object),
                assistant.or_else(|| Some(output.to_string())),
            )
        }
        other => (other.clone(), Some(other.to_string())),
    };
    ToolResult::ok(data, assistant)
}

struct PluginToolReverseSink;

pub(crate) fn reverse_sink() -> Arc<dyn HookFunctionReverseSink> {
    Arc::new(PluginToolReverseSink)
}

#[async_trait]
impl HookFunctionReverseSink for PluginToolReverseSink {
    async fn metadata(&self, params: HookFunctionReverseMetadata) -> PortResult<()> {
        handle_tool_metadata(params).await
    }

    async fn ask(&self, params: HookFunctionReverseAsk) -> PortResult<HookFunctionReverseReply> {
        handle_tool_ask(params).await
    }
}

async fn handle_tool_metadata(params: HookFunctionReverseMetadata) -> PortResult<()> {
    let route = executions()
        .get(&(
            params.generation.instance_id.clone(),
            params.execution_id.clone(),
        ))
        .map(|entry| entry.clone())
        .ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                "plugin tool execution is no longer active",
            )
        })?;
    validate_reverse_generation(&params.generation, &route)?;
    let progress_message = if params.title.is_empty() {
        Value::Object(params.metadata).to_string()
    } else {
        params.title
    };
    crate::infrastructure::events::emit_global_event(
        crate::infrastructure::events::BackendEvent::ToolExecutionProgress(
            ToolExecutionProgressInfo {
                tool_use_id: route.tool_call_id.clone().unwrap_or(params.execution_id),
                tool_name: route.tool_name,
                progress_message,
                percentage: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            },
        ),
    )
    .await
    .map_err(|error| {
        PortError::new(
            PortErrorKind::Backend,
            format!("failed to publish plugin tool metadata: {error}"),
        )
    })?;
    Ok(())
}

async fn handle_tool_ask(params: HookFunctionReverseAsk) -> PortResult<HookFunctionReverseReply> {
    let instance_id = &params.generation.instance_id;
    let execution_id = &params.execution_id;
    let route = executions()
        .get(&(instance_id.to_string(), execution_id.to_string()))
        .map(|entry| entry.clone())
        .ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                "plugin tool execution is no longer active",
            )
        })?;
    let mut cancelled = route.cancelled.clone();
    validate_reverse_generation(&params.generation, &route)?;
    let instance = crate::plugin_host::plugin_host_instance_by_id(instance_id)
        .await
        .ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotAvailable,
                "plugin instance is unavailable",
            )
        })?;
    if instance.generation_key != route.generation_key || instance.revision != route.revision {
        return Err(PortError::new(
            PortErrorKind::NotAvailable,
            "plugin tool generation is no longer active",
        ));
    }
    let mut patterns = params.patterns;
    let permission_action = if params.permission == route.tool_name {
        if patterns.is_empty() {
            patterns.push(route.tool_name.clone());
        }
        "custom_tool"
    } else {
        &params.permission
    };
    let policy = crate::agentic::agents::get_agent_registry()
        .get_agent_tool_policy(&route.agent, Some(&instance.workspace_id))
        .await;
    let evaluator = openbitfun_runtime_ports::PermissionEvaluator::case_sensitive();
    if patterns.iter().any(|resource| {
        evaluator.evaluate_constraint_resource(
            permission_action,
            resource,
            &policy.permission_constraints,
        ) == openbitfun_runtime_ports::PermissionEffect::Deny
    }) {
        return Err(PortError::new(
            PortErrorKind::PermissionDenied,
            "plugin tool permission denied by the active agent policy",
        ));
    }
    // The pipeline already admitted the exact plugin Tool through the same
    // custom_tool intent before entering the Host. Do not ask twice when the
    // plugin repeats that declaration through context.ask().
    if permission_action == "custom_tool"
        && patterns.iter().all(|resource| resource == &route.tool_name)
    {
        return Ok(HookFunctionReverseReply::Once);
    }
    let manager = crate::product_runtime::core_permission_request_manager()
        .map_err(|error| PortError::new(PortErrorKind::Backend, error))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut pending = manager
        .register_batch_for_turn(
            vec![openbitfun_runtime_ports::PermissionRequest {
                request_id: request_id.clone(),
                round_id: route.dialog_turn_id.clone(),
                order: 0,
                tool_call_id: route
                    .tool_call_id
                    .clone()
                    .or_else(|| Some(execution_id.to_string())),
                project_path: Some(instance.canonical_directory.clone()),
                project_id: instance.project_id,
                session_id: route.session_id,
                agent_id: route.agent,
                action: permission_action.to_string(),
                resources: patterns,
                save_resources: params.always,
                source: openbitfun_runtime_ports::PermissionRequestSource {
                    kind: openbitfun_runtime_ports::PermissionRequestSourceKind::Extension,
                    identity: instance_id.to_string(),
                },
                delegation: None,
                display_metadata: params.metadata,
            }],
            route.dialog_turn_id,
        )
        .await
        .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))?;
    let pending = pending
        .pop()
        .expect("single permission batch must return one receiver");
    let outcome = tokio::select! {
        outcome = pending.wait() => outcome,
        changed = cancelled.changed() => {
            let reason = if changed.is_ok() && *cancelled.borrow() {
                "Plugin tool execution ended while permission was pending"
            } else {
                "Plugin tool execution route closed while permission was pending"
            };
            manager
                .cancel_request(&request_id, reason)
                .await
                .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))?;
            return Err(PortError::new(PortErrorKind::Cancelled, reason));
        }
    };
    match outcome {
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_runtime_ports::PermissionReply::OnceWithInput { .. },
        ) => Err(PortError::new(
            PortErrorKind::Backend,
            "Plugin-owned permission requests do not support edited input",
        )),
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_runtime_ports::PermissionReply::Once,
        ) => Ok(HookFunctionReverseReply::Once),
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_runtime_ports::PermissionReply::Always,
        ) => Ok(HookFunctionReverseReply::Always),
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Replied(
            openbitfun_runtime_ports::PermissionReply::Reject { feedback },
        ) => Ok(HookFunctionReverseReply::Reject { feedback }),
        openbitfun_agent_runtime::permission::PermissionWaitOutcome::Cancelled { reason } => {
            Ok(HookFunctionReverseReply::Reject {
                feedback: Some(reason),
            })
        }
    }
}

fn validate_reverse_generation(
    generation: &HookFunctionGeneration,
    route: &PluginToolExecutionRoute,
) -> PortResult<()> {
    if generation.generation_key == route.generation_key && generation.revision == route.revision {
        Ok(())
    } else {
        Err(PortError::new(
            PortErrorKind::NotAvailable,
            "plugin tool reverse RPC generation lease does not match the active execution",
        ))
    }
}

fn muxes() -> &'static RwLock<BTreeMap<String, Arc<PluginHostToolMux>>> {
    static MUXES: OnceLock<RwLock<BTreeMap<String, Arc<PluginHostToolMux>>>> = OnceLock::new();
    MUXES.get_or_init(|| RwLock::new(BTreeMap::new()))
}

pub(crate) async fn register_workspace_tool(
    workspace_scope: &str,
    workspace_id: &str,
    runtime: Arc<dyn HookFunctionRuntime>,
    host_generation: u64,
    instance_id: &str,
    generation_key: &str,
    revision: &str,
    registration_id: &str,
    id: &str,
    description: &str,
    parameters: Value,
    config_fingerprint: &str,
    allowed_runtime_agent_keys: BTreeSet<String>,
) {
    let mux = {
        let mut muxes = muxes().write().expect("plugin tool mux lock poisoned");
        if let Some(mux) = muxes.get(id) {
            mux.clone()
        } else {
            let mux = Arc::new(PluginHostToolMux::new(
                id.to_string(),
                crate::native_hooks::runtime_hook_registry(),
            ));
            muxes.insert(id.to_string(), mux.clone());
            mux
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update([0]);
    hasher.update(description.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(&parameters).unwrap_or_default());
    hasher.update([0]);
    hasher.update(config_fingerprint.as_bytes());
    let content_version = format!("sha256:{}", hex::encode(hasher.finalize()));
    let native_agent_visible = allowed_runtime_agent_keys.is_empty();
    mux.set_route(
        workspace_scope.to_string(),
        PluginHostToolRoute {
            runtime,
            host_generation,
            instance_id: instance_id.to_string(),
            generation_key: generation_key.to_string(),
            revision: revision.to_string(),
            registration_id: registration_id.to_string(),
            description: description.to_string(),
            parameters,
            allowed_runtime_agent_keys,
        },
    );
    crate::external_tools::register_live_external_tool_candidate(
        workspace_id,
        mux,
        "opencode-plugin",
        content_version,
        native_agent_visible,
    )
    .await;
}

pub(crate) async fn unregister_workspace_tools(
    workspace_scope: &str,
    workspace_id: &str,
    names: &[String],
    generation_key: &str,
) {
    for name in names {
        let mux = muxes()
            .read()
            .expect("plugin tool mux lock poisoned")
            .get(name)
            .cloned();
        let Some(mux) = mux else {
            continue;
        };
        if mux.remove_route(workspace_scope, generation_key) {
            muxes()
                .write()
                .expect("plugin tool mux lock poisoned")
                .remove(name);
        }
        if mux.routes_for_scope(workspace_scope).is_empty() {
            crate::external_tools::unregister_live_external_tool_candidate(
                workspace_id,
                name,
                "opencode-plugin",
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dispatched_tool_cancel_error, executions, handle_tool_ask, handle_tool_metadata,
        map_plugin_tool_result, PluginHostToolMux, PluginHostToolRoute, PluginToolExecutionGuard,
        PluginToolExecutionRoute,
    };
    use crate::agentic::tools::framework::{Tool, ToolUseContext};
    use openbitfun_opencode_plugin_host::JsonRpcPeer;
    use openbitfun_runtime_ports::{
        HookFunctionGeneration, HookFunctionReverseAsk, HookFunctionReverseMetadata,
        HookFunctionToolAttachment, HookFunctionToolResult, PortErrorKind,
    };
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use tokio::net::{TcpListener, TcpStream};

    async fn client() -> openbitfun_opencode_plugin_host::PluginHostClient {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let host = tokio::spawn(async move { TcpStream::connect(address).await.unwrap() });
        let (backend, _) = listener.accept().await.unwrap();
        let _host = host.await.unwrap();
        JsonRpcPeer::start_with_capabilities(
            backend,
            1,
            1024 * 1024,
            openbitfun_opencode_plugin_host::PluginHostCapabilities::all_supported(),
        )
        .client()
    }

    fn route(
        client: openbitfun_opencode_plugin_host::PluginHostClient,
        instance_id: &str,
    ) -> PluginHostToolRoute {
        let instance_id = instance_id.to_string();
        PluginHostToolRoute {
            runtime: openbitfun_opencode_plugin_host::hook_function_runtime(client),
            host_generation: 1,
            instance_id: instance_id.clone(),
            generation_key: "generation-test".to_string(),
            revision: "revision-test".to_string(),
            registration_id: format!("registration-{instance_id}"),
            description: format!("description-{instance_id}"),
            parameters: json!({"type": "object", "title": instance_id}),
            allowed_runtime_agent_keys: BTreeSet::from(["plugin-agent".to_string()]),
        }
    }

    fn context(workspace_root: &str, runtime_agent_key: &str) -> ToolUseContext {
        crate::agentic::tools::tool_context_runtime::build_tool_description_context(
            runtime_agent_key,
            Some(&crate::agentic::WorkspaceBinding::new(
                Some("plugin-tool-workspace".into()),
                PathBuf::from(workspace_root),
            )),
            None,
            None,
            None,
            None,
            None,
            &Default::default(),
            &Default::default(),
        )
    }

    #[test]
    fn plugin_tools_own_their_side_effecting_timeout_path() {
        let mux = PluginHostToolMux::new(
            "timeout-tool".to_string(),
            openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default(),
        );

        assert!(mux.manages_own_execution_timeout());
    }

    #[test]
    fn dispatched_tool_abort_is_not_reported_as_a_definite_cancellation() {
        let error = dispatched_tool_cancel_error(true);

        assert!(matches!(error, crate::OpenBitFunError::OutcomeUnknown(_)));
    }

    #[test]
    fn dropping_an_execution_route_cancels_reverse_permission_waits() {
        let key = ("drop-instance".to_string(), "drop-execution".to_string());
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        executions().insert(
            key.clone(),
            PluginToolExecutionRoute {
                session_id: "session-a".to_string(),
                dialog_turn_id: "turn-a".to_string(),
                agent: "Standard".to_string(),
                tool_name: "plugin-tool".to_string(),
                tool_call_id: Some("tool-call-a".to_string()),
                generation_key: "generation-a".to_string(),
                revision: "revision-a".to_string(),
                cancelled: cancelled.clone(),
            },
        );

        drop(PluginToolExecutionGuard {
            key: key.clone(),
            cancel,
        });

        assert!(*cancelled.borrow_and_update());
        assert!(!executions().contains_key(&key));
    }

    #[test]
    fn plugin_tool_result_preserves_presentation_fields_and_attachments() {
        let result = map_plugin_tool_result(HookFunctionToolResult {
            output: json!({
                "title": "Generated report",
                "output": "report ready",
                "metadata": {"path": "report.md"}
            }),
            attachments: vec![HookFunctionToolAttachment {
                mime: "text/markdown".to_string(),
                url: "file:///workspace/report.md".to_string(),
                filename: Some("report.md".to_string()),
            }],
        });

        let crate::agentic::tools::framework::ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = result
        else {
            panic!("plugin result should be terminal");
        };
        assert_eq!(data["title"], "Generated report");
        assert_eq!(data["metadata"]["path"], "report.md");
        assert_eq!(data["attachments"][0]["filename"], "report.md");
        assert_eq!(result_for_assistant.as_deref(), Some("report ready"));
    }

    #[tokio::test]
    async fn same_named_tool_routes_are_isolated_by_workspace() {
        let client = client().await;
        let registry = openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default();
        for scope in ["C:/workspace-a", "D:/workspace-b"] {
            registry.set_source_activation_for_workspace(
                openbitfun_agent_runtime::native_hooks::RuntimeHookSource::Plugin,
                Some(scope),
                openbitfun_agent_runtime::native_hooks::RuntimeHookActivation::Ready,
            );
        }
        let mux = PluginHostToolMux::new("shared-tool".to_string(), registry);
        mux.set_route(
            "C:/workspace-a".to_string(),
            route(client.clone(), "instance-a"),
        );
        mux.set_route("D:/workspace-b".to_string(), route(client, "instance-b"));

        assert_eq!(
            mux.routes_for_scope("C:/workspace-a")
                .pop()
                .unwrap()
                .instance_id,
            "instance-a"
        );
        assert_eq!(
            mux.routes_for_scope("D:/workspace-b")
                .pop()
                .unwrap()
                .instance_id,
            "instance-b"
        );
        assert!(!mux.remove_route("C:/workspace-a", "generation-test"));
        assert!(mux.routes_for_scope("C:/workspace-a").is_empty());
        assert_eq!(
            mux.routes_for_scope("D:/workspace-b")
                .pop()
                .unwrap()
                .instance_id,
            "instance-b"
        );
        assert!(mux.remove_route("D:/workspace-b", "generation-test"));
    }

    #[tokio::test]
    async fn tool_route_honors_the_shared_workspace_activation_gate() {
        use openbitfun_agent_runtime::native_hooks::{RuntimeHookActivation, RuntimeHookSource};

        let registry = openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default();
        let mux = PluginHostToolMux::new("gated-tool".to_string(), registry.clone());
        mux.set_route(
            "C:/workspace-gated".to_string(),
            route(client().await, "instance-gated"),
        );
        registry.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some("C:/workspace-gated"),
            RuntimeHookActivation::Unavailable,
        );

        assert!(mux.routes_for_scope("C:/workspace-gated").is_empty());

        registry.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some("C:/workspace-gated"),
            RuntimeHookActivation::Ready,
        );
        assert!(!mux.routes_for_scope("C:/workspace-gated").is_empty());
        registry.clear_source_workspace(RuntimeHookSource::Plugin, "C:/workspace-gated");
    }

    #[tokio::test]
    async fn tool_route_requires_the_exact_generation_agent_key() {
        use openbitfun_agent_runtime::native_hooks::{RuntimeHookActivation, RuntimeHookSource};

        let workspace = std::env::current_dir().expect("absolute workspace");
        let scope = "plugin-tool-workspace".to_string();
        let generation_a_agent = "external_subagent_runtime:opencode-plugin:generation-a-agent";
        let generation_b_agent = "external_subagent_runtime:opencode-plugin:generation-b-agent";
        let registry = openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default();
        registry.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some(&scope),
            RuntimeHookActivation::Ready,
        );
        let mux = PluginHostToolMux::new("generation-tool".to_string(), registry.clone());
        let client = client().await;
        let mut route_a = route(client.clone(), "instance-a");
        route_a.generation_key = "generation-a".to_string();
        route_a.allowed_runtime_agent_keys = BTreeSet::from([generation_a_agent.to_string()]);
        let mut route_b = route(client, "instance-b");
        route_b.generation_key = "generation-b".to_string();
        route_b.allowed_runtime_agent_keys = BTreeSet::from([generation_b_agent.to_string()]);
        mux.set_route(scope.clone(), route_a);
        mux.set_route(scope.clone(), route_b);

        let workspace_text = workspace.to_string_lossy();
        assert_eq!(
            mux.route_for(Some(&context(&workspace_text, generation_a_agent)))
                .expect("generation A route")
                .instance_id,
            "instance-a"
        );
        assert_eq!(
            mux.route_for(Some(&context(&workspace_text, generation_b_agent)))
                .expect("generation B route")
                .instance_id,
            "instance-b"
        );
        assert!(mux
            .route_for(Some(&context(
                &workspace_text,
                "external_subagent_runtime:other-provider:agent"
            )))
            .is_none());
        assert!(mux
            .route_for(Some(&context(&workspace_text, "Standard")))
            .is_none());

        registry.clear_source_workspace(RuntimeHookSource::Plugin, &scope);
    }

    #[tokio::test]
    async fn tool_only_plugin_route_is_available_to_native_agents() {
        use openbitfun_agent_runtime::native_hooks::{RuntimeHookActivation, RuntimeHookSource};

        let workspace = std::env::current_dir().expect("absolute workspace");
        let scope = "plugin-tool-workspace".to_string();
        let registry = openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default();
        registry.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some(&scope),
            RuntimeHookActivation::Ready,
        );
        let mux = PluginHostToolMux::new("tool-only".to_string(), registry.clone());
        let mut route = route(client().await, "tool-only-instance");
        route.allowed_runtime_agent_keys.clear();
        mux.set_route(scope.clone(), route);

        let workspace_text = workspace.to_string_lossy();
        let context = context(&workspace_text, "Standard");
        assert!(mux.route_for(Some(&context)).is_some());

        registry.clear_source_workspace(RuntimeHookSource::Plugin, &scope);
    }

    #[tokio::test]
    async fn remote_workspace_cannot_match_a_local_plugin_tool_route() {
        use openbitfun_agent_runtime::native_hooks::{RuntimeHookActivation, RuntimeHookSource};

        let workspace = std::env::current_dir().expect("absolute workspace");
        let scope = "plugin-tool-workspace".to_string();
        let registry = openbitfun_agent_runtime::native_hooks::RuntimeHookRegistry::default();
        registry.set_source_activation_for_workspace(
            RuntimeHookSource::Plugin,
            Some(&scope),
            RuntimeHookActivation::Ready,
        );
        let mux = PluginHostToolMux::new("remote-collision".to_string(), registry.clone());
        let mut route = route(client().await, "local-instance");
        route.allowed_runtime_agent_keys.clear();
        mux.set_route(scope.clone(), route);

        let workspace_text = workspace.to_string_lossy();
        let mut remote = context(&workspace_text, "Standard");
        remote.workspace.as_mut().expect("workspace").backend =
            crate::agentic::workspace::WorkspaceBackend::Remote {
                connection_id: "remote-a".to_string(),
                connection_name: "Remote A".to_string(),
            };

        assert!(mux.route_for(Some(&remote)).is_none());
        registry.clear_source_workspace(RuntimeHookSource::Plugin, &scope);
    }

    #[tokio::test]
    async fn ask_for_missing_execution_route_is_rejected() {
        let error = handle_tool_ask(HookFunctionReverseAsk {
            generation: HookFunctionGeneration {
                instance_id: "missing-instance".to_string(),
                generation_key: "missing-generation".to_string(),
                revision: "missing-revision".to_string(),
            },
            execution_id: "missing-execution".to_string(),
            permission: "custom_tool".to_string(),
            patterns: Vec::new(),
            always: Vec::new(),
            metadata: Default::default(),
        })
        .await
        .unwrap_err();

        assert_eq!(error.kind, PortErrorKind::NotAvailable);
    }

    #[tokio::test]
    async fn metadata_for_missing_execution_route_is_rejected() {
        let error = handle_tool_metadata(HookFunctionReverseMetadata {
            generation: HookFunctionGeneration {
                instance_id: "missing-instance".to_string(),
                generation_key: "missing-generation".to_string(),
                revision: "missing-revision".to_string(),
            },
            execution_id: "missing-execution".to_string(),
            title: "progress".to_string(),
            metadata: Default::default(),
        })
        .await
        .unwrap_err();

        assert_eq!(error.kind, PortErrorKind::NotAvailable);
    }

    #[tokio::test]
    async fn metadata_for_active_execution_is_published_as_progress() {
        let instance_id = format!("metadata-instance-{}", std::process::id());
        let execution_id = format!("metadata-execution-{}", std::process::id());
        let key = (instance_id.clone(), execution_id.clone());
        executions().insert(
            key.clone(),
            PluginToolExecutionRoute {
                session_id: "session-a".to_string(),
                dialog_turn_id: "turn-a".to_string(),
                agent: "Standard".to_string(),
                tool_name: "plugin-tool".to_string(),
                tool_call_id: Some("tool-call-a".to_string()),
                generation_key: "generation-a".to_string(),
                revision: "revision-a".to_string(),
                cancelled: tokio::sync::watch::channel(false).1,
            },
        );

        let result = handle_tool_metadata(HookFunctionReverseMetadata {
            generation: HookFunctionGeneration {
                instance_id,
                generation_key: "generation-a".to_string(),
                revision: "revision-a".to_string(),
            },
            execution_id,
            title: "Reading README.md".to_string(),
            metadata: serde_json::from_value(json!({"path": "README.md"})).unwrap(),
        })
        .await;
        executions().remove(&key);

        result.unwrap();
    }
}
