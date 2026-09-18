//! Product-owned activation and contextual routing for external standalone tools.

use crate::agentic::tools::framework::{
    DynamicToolInfo, PermissionIntent, Tool, ToolExposure, ToolResult, ToolUseContext,
    ValidationResult,
};
use crate::agentic::tools::registry::get_global_tool_registry;
use crate::agentic::workspace::workspace_route_key;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_external_sources::{ExternalSourceControlPlane, ExternalToolCoordinatorSnapshot};
use openbitfun_product_domains::external_sources::{
    external_tool_approval_key, external_tool_conflict_key, external_tool_decision_key,
    EcosystemId, ExternalSourceAssetKind, ExternalSourceDiagnostic,
    ExternalSourceDiagnosticSeverity, ExternalSourceScope, ExternalToolActivationState,
    ExternalToolApprovalRequest, ExternalToolCatalogEntry, ExternalToolConflict,
    ExternalToolConflictCandidate, ExternalToolConflictCandidateKind, ExternalToolDefinition,
    ExternalToolStaticStatus, PreparedExternalToolTarget, SourceQualifiedToolTargetId,
};
use openbitfun_runtime_ports::{
    PortErrorKind, ScriptToolDescriptor, ScriptToolExpectedExport, ScriptToolInvokeRequest,
    ScriptToolLoadRequest, ScriptToolRuntime, ScriptToolRuntimeAvailability,
};
use openbitfun_services_integrations::script_tool::NodeScriptToolRuntime;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
#[cfg(all(test, feature = "opencode-plugin-host"))]
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, RwLock as StdRwLock};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default)]
pub(super) struct ExternalToolProductState {
    pub tools: Vec<ExternalToolCatalogEntry>,
    pub approval_requests: Vec<ExternalToolApprovalRequest>,
    pub conflicts: Vec<ExternalToolConflict>,
    pub diagnostics: Vec<ExternalSourceDiagnostic>,
}

pub(super) struct ExternalToolDecisions<'a> {
    pub active_ecosystems: &'a BTreeSet<EcosystemId>,
    pub approved_targets: &'a BTreeSet<String>,
    pub declined_decisions_by_approval: &'a BTreeMap<String, String>,
    pub conflict_choices: &'a BTreeMap<String, String>,
}

/// Builds the catalog visible from a Host that may discover external files but
/// is not allowed to load code or mutate runtime routes. This intentionally
/// does not consult the tool registry or the script runtime.
pub(super) fn project_external_tools_read_only(
    execution_domain_id: &str,
    snapshot: &ExternalToolCoordinatorSnapshot,
    decisions: ExternalToolDecisions<'_>,
) -> ExternalToolProductState {
    let source_by_key = snapshot
        .sources
        .iter()
        .map(|source| (source.record.key.clone(), source.record.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut target_groups =
        BTreeMap::<SourceQualifiedToolTargetId, Vec<ExternalToolDefinition>>::new();
    for tool in &snapshot.tools {
        target_groups
            .entry(tool.id.target.clone())
            .or_default()
            .push(tool.clone());
    }
    let mut state = ExternalToolProductState::default();
    for (target_id, definitions) in target_groups {
        let first = &definitions[0];
        let approval_key = external_tool_approval_key(
            execution_domain_id,
            &target_id,
            first.runtime_kind,
            first.capabilities.iter().copied(),
        );
        let decision_key = external_tool_decision_key(&approval_key, &first.content_version);
        let source = source_by_key.get(&target_id.source);
        let ecosystem_active =
            source.is_some_and(|source| decisions.active_ecosystems.contains(&source.ecosystem_id));
        let unsupported_reason = definitions
            .iter()
            .find_map(|tool| match &tool.static_status {
                ExternalToolStaticStatus::Ready => None,
                ExternalToolStaticStatus::Unsupported { reason }
                | ExternalToolStaticStatus::Invalid { reason } => Some(reason.clone()),
                _ => Some("tool uses a static format not supported by this version".to_string()),
            });
        let activation = if let Some(reason) = unsupported_reason {
            ExternalToolActivationState::Unsupported { reason }
        } else if !ecosystem_active {
            ExternalToolActivationState::Disabled
        } else if decisions.approved_targets.contains(&approval_key) {
            ExternalToolActivationState::RuntimeUnavailable {
                reason: "This Host exposes discovery only; use Desktop or an authenticated Peer Host to run external tools".to_string(),
            }
        } else if decisions
            .declined_decisions_by_approval
            .get(&approval_key)
            .is_some_and(|declined| declined == &decision_key)
        {
            ExternalToolActivationState::Declined
        } else {
            state.approval_requests.push(ExternalToolApprovalRequest {
                approval_key: approval_key.clone(),
                decision_key: decision_key.clone(),
                target_id: target_id.clone(),
                source_display_name: source
                    .map(|source| source.display_name.clone())
                    .unwrap_or_else(|| "External tools".to_string()),
                source_scope: source
                    .map(|source| source.scope)
                    .unwrap_or(ExternalSourceScope::WorkspaceLocal),
                source_location: source
                    .map(|source| source.location.clone())
                    .unwrap_or_else(|| first.module_path.clone()),
                working_directory: first.working_directory.clone(),
                runtime_kind: first.runtime_kind,
                capabilities: first.capabilities.clone(),
                content_version: first.content_version.clone(),
                tool_names: definitions.iter().map(|tool| tool.name.clone()).collect(),
            });
            ExternalToolActivationState::ApprovalRequired
        };
        state.tools.extend(
            definitions
                .into_iter()
                .map(|definition| ExternalToolCatalogEntry {
                    definition,
                    approval_key: approval_key.clone(),
                    decision_key: decision_key.clone(),
                    activation: activation.clone(),
                }),
        );
    }
    state.tools.sort_by(|left, right| {
        left.definition.name.cmp(&right.definition.name).then(
            left.definition
                .id
                .stable_key()
                .cmp(&right.definition.id.stable_key()),
        )
    });
    state.approval_requests.sort_by(|left, right| {
        left.target_id
            .stable_key()
            .cmp(&right.target_id.stable_key())
    });
    state
}

pub(super) const UNRESOLVED_TOOL_CONFLICT_CHOICE: &str = "__openbitfun_unresolved__";
pub(super) const TOOL_CONFLICT_RESELECTION_REQUIRED: &str = "__openbitfun_reselection_required__";

fn external_tool_permission_intent(provider_id: &str, tool_name: &str) -> PermissionIntent {
    PermissionIntent::new("custom_tool", vec![format!("{provider_id}:{tool_name}")])
}

#[derive(Clone)]
struct LoadedExternalTool {
    descriptor: ScriptToolDescriptor,
    ecosystem_id: String,
    provider_id: String,
    runtime_target_id: String,
    load_generation: u64,
    revision: String,
    approval_key: String,
    source_preference_key: String,
    workspace_key: String,
    target_tool_names: Arc<Vec<String>>,
    worktree_root: Option<String>,
    runtime: Arc<dyn ScriptToolRuntime>,
}

#[async_trait]
impl Tool for LoadedExternalTool {
    fn name(&self) -> &str {
        &self.descriptor.name
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.descriptor.description.clone())
    }

    fn short_description(&self) -> String {
        self.descriptor.description.clone()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn input_schema(&self) -> Value {
        self.descriptor.input_schema.clone()
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        Some(&self.provider_id)
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        Some(DynamicToolInfo {
            provider_id: self.provider_id.clone(),
            provider_kind: Some("external_source".to_string()),
            mcp: None,
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(vec![external_tool_permission_intent(
            &self.provider_id,
            &self.descriptor.name,
        )])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if !crate::external_sources::external_tool_invocation_is_authorized(
            &self.ecosystem_id,
            &self.approval_key,
            &self.source_preference_key,
            &self.workspace_key,
        )
        .await
        .map_err(OpenBitFunError::tool)?
        {
            return Err(OpenBitFunError::tool(format!(
                "external tool '{}' was disabled in another OpenBitFun process; refresh external tools before retrying",
                self.name()
            )));
        }
        static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);
        let operation_id = format!(
            "external-tool-operation-{}",
            NEXT_OPERATION.fetch_add(1, Ordering::Relaxed)
        );
        let request = ScriptToolInvokeRequest {
            target_id: self.runtime_target_id.clone(),
            revision: self.revision.clone(),
            export_name: self.descriptor.export_name.clone(),
            operation_id: operation_id.clone(),
            arguments: input.clone(),
            workspace_root: context
                .workspace_root()
                .map(|path| path.to_string_lossy().into_owned()),
            worktree_root: self.worktree_root.clone(),
            session_id: context.session_id.clone(),
        };
        let mut invocation = Box::pin(self.runtime.invoke(request));
        let response = if let Some(cancellation) = context.cancellation_token() {
            tokio::select! {
                result = &mut invocation => result,
                _ = cancellation.cancelled() => {
                    let cancel_result = self.runtime.cancel(&self.runtime_target_id, &operation_id).await;
                    // The Node cancel acknowledgement is sent only after the
                    // operation leaves the worker's active set. Drain the
                    // pinned invocation so its cancellation-safe drop guard
                    // is disarmed instead of racing a second cancellation.
                    let _ = invocation.await;
                    if !self.runtime.is_loaded(&self.runtime_target_id).await {
                        report_external_tool_worker_lost(
                            &self.workspace_key,
                            &self.runtime_target_id,
                            self.load_generation,
                            self.target_tool_names.as_ref(),
                            cancel_result
                                .err()
                                .map(|error| error.to_string())
                                .unwrap_or_else(|| "tool process stopped while cancelling the invocation".to_string()),
                        )
                        .await;
                    }
                    return Err(OpenBitFunError::Cancelled(format!("external tool '{}' was cancelled", self.name())));
                }
            }
        } else {
            invocation.await
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if matches!(
                    error.kind,
                    PortErrorKind::Timeout | PortErrorKind::NotAvailable | PortErrorKind::NotFound
                ) && !self.runtime.is_loaded(&self.runtime_target_id).await
                {
                    report_external_tool_worker_lost(
                        &self.workspace_key,
                        &self.runtime_target_id,
                        self.load_generation,
                        self.target_tool_names.as_ref(),
                        error.to_string(),
                    )
                    .await;
                }
                return Err(OpenBitFunError::tool(error.to_string()));
            }
        };
        Ok(vec![ToolResult::ok(
            Value::String(response.output.clone()),
            Some(response.output),
        )])
    }
}

#[derive(Clone)]
struct ConflictExpectation {
    key: String,
    selected_candidate_id: Option<String>,
}

#[derive(Clone)]
enum WorkspaceRoute {
    Original {
        conflict: Option<ConflictExpectation>,
    },
    External {
        tool: Arc<LoadedExternalTool>,
        conflict: Option<ConflictExpectation>,
    },
    Live {
        tool: Arc<dyn Tool>,
        native_agent_visible: bool,
        conflict: Option<ConflictExpectation>,
    },
    Unavailable {
        conflict: Option<ConflictExpectation>,
    },
}

impl WorkspaceRoute {
    fn conflict(&self) -> Option<&ConflictExpectation> {
        match self {
            Self::Original { conflict }
            | Self::External { conflict, .. }
            | Self::Live { conflict, .. }
            | Self::Unavailable { conflict } => conflict.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConflictRouteChoice {
    Original,
    External(String),
    Unavailable,
}

fn resolve_conflict_route_choice(
    conflict_key: &str,
    candidates: &[ExternalToolConflictCandidate],
    external_candidate_ids: &BTreeSet<String>,
    has_original: bool,
    choices: &BTreeMap<String, String>,
) -> (Option<String>, ConflictRouteChoice) {
    let selected = choices
        .get(conflict_key)
        .filter(|selected| {
            candidates
                .iter()
                .any(|candidate| &candidate.candidate_id == *selected)
        })
        .cloned();
    let prior_requires_fail_closed = choices.iter().any(|(key, choice)| {
        tool_conflict_lineage(key) == tool_conflict_lineage(conflict_key)
            && (choice.starts_with("external:") || choice == TOOL_CONFLICT_RESELECTION_REQUIRED)
    });
    let route = match selected.as_deref() {
        Some(selected) if external_candidate_ids.contains(selected) => {
            ConflictRouteChoice::External(selected.to_string())
        }
        Some(_) if has_original => ConflictRouteChoice::Original,
        None if prior_requires_fail_closed => ConflictRouteChoice::Unavailable,
        None if has_original => ConflictRouteChoice::Original,
        _ => ConflictRouteChoice::Unavailable,
    };
    (selected, route)
}

fn tool_conflict_lineage(conflict_key: &str) -> &str {
    conflict_key
        .rsplit_once(':')
        .map_or(conflict_key, |(lineage, _)| lineage)
}

fn tool_conflict_lineage_for_name(execution_domain_id: &str, tool_name: &str) -> String {
    format!("external_tool:{}:{}", execution_domain_id, tool_name)
}

fn has_tool_conflict_history(
    choices: &BTreeMap<String, String>,
    conflict_domain: &str,
    tool_name: &str,
) -> bool {
    let lineage = tool_conflict_lineage_for_name(conflict_domain, tool_name);
    choices
        .keys()
        .any(|conflict_key| tool_conflict_lineage(conflict_key) == lineage)
}

fn tool_conflict_history_requires_fail_closed(
    choices: &BTreeMap<String, String>,
    conflict_domain: &str,
    tool_name: &str,
) -> bool {
    let lineage = tool_conflict_lineage_for_name(conflict_domain, tool_name);
    choices.iter().any(|(conflict_key, choice)| {
        tool_conflict_lineage(conflict_key) == lineage
            && (choice.starts_with("external:") || choice == TOOL_CONFLICT_RESELECTION_REQUIRED)
    })
}

fn retain_fail_closed_routes_during_reconcile(
    routes: &mut BTreeMap<String, WorkspaceRoute>,
    discovered_names: &BTreeSet<String>,
) {
    routes.retain(|name, route| {
        discovered_names.contains(name)
            || matches!(
                route,
                WorkspaceRoute::External {
                    conflict: Some(_),
                    ..
                } | WorkspaceRoute::Live {
                    conflict: Some(_),
                    ..
                } | WorkspaceRoute::Unavailable { conflict: Some(_) }
            )
    });
    for (name, route) in routes {
        if discovered_names.contains(name) {
            continue;
        }
        match route {
            WorkspaceRoute::External { conflict, .. } | WorkspaceRoute::Live { conflict, .. } => {
                *route = WorkspaceRoute::Unavailable {
                    conflict: conflict.clone(),
                };
            }
            _ => {}
        }
    }
}

struct ExternalToolMux {
    name: String,
    original: StdRwLock<Option<Arc<dyn Tool>>>,
    routes: StdRwLock<HashMap<String, WorkspaceRoute>>,
}

impl ExternalToolMux {
    fn new(name: String, original: Option<Arc<dyn Tool>>) -> Self {
        Self {
            name,
            original: StdRwLock::new(original),
            routes: StdRwLock::new(HashMap::new()),
        }
    }

    fn original(&self) -> Option<Arc<dyn Tool>> {
        self.original
            .read()
            .expect("external tool original lock poisoned")
            .clone()
    }

    fn replace_original(&self, original: Option<Arc<dyn Tool>>) {
        *self
            .original
            .write()
            .expect("external tool original lock poisoned") = original;
    }

    fn set_route(&self, workspace_key: String, route: WorkspaceRoute) {
        self.routes
            .write()
            .expect("external tool route lock poisoned")
            .insert(workspace_key, route);
    }

    fn remove_route(&self, workspace_key: &str) {
        self.routes
            .write()
            .expect("external tool route lock poisoned")
            .remove(workspace_key);
    }

    fn route_count(&self) -> usize {
        self.routes
            .read()
            .expect("external tool route lock poisoned")
            .len()
    }

    fn selected(&self, context: Option<&ToolUseContext>) -> Option<Arc<dyn Tool>> {
        if context.is_some_and(ToolUseContext::is_remote) {
            // Remote external-source ownership is not implemented. Never use
            // a local route solely because the remote path text matches.
            return self.original();
        }
        let workspace_key = workspace_route_key(context.and_then(ToolUseContext::workspace_id));
        match self
            .routes
            .read()
            .expect("external tool route lock poisoned")
            .get(&workspace_key)
            .cloned()
        {
            #[cfg(feature = "opencode-plugin-host")]
            Some(WorkspaceRoute::Live {
                tool,
                native_agent_visible,
                ..
            }) if tool.dynamic_provider_id() == Some("opencode-plugin") => {
                let uses_plugin_agent = context
                    .and_then(|context| context.agent_type.as_deref())
                    .is_some_and(crate::plugin_host::is_opencode_plugin_agent_runtime_key);
                let original = self.original();
                if uses_plugin_agent || native_agent_visible || original.is_none() {
                    Some(tool)
                } else {
                    original
                }
            }
            Some(WorkspaceRoute::External { tool, .. }) => Some(tool),
            Some(WorkspaceRoute::Live { tool, .. }) => Some(tool),
            Some(WorkspaceRoute::Unavailable { .. }) => None,
            Some(WorkspaceRoute::Original { .. }) | None => self.original(),
        }
    }

    fn selected_for_workspace(&self, workspace_id: Option<&str>) -> Option<Arc<dyn Tool>> {
        let workspace_key = workspace_route_key(workspace_id);
        match self
            .routes
            .read()
            .expect("external tool route lock poisoned")
            .get(&workspace_key)
            .cloned()
        {
            Some(WorkspaceRoute::External { tool, .. }) => Some(tool),
            Some(WorkspaceRoute::Live { tool, .. }) => Some(tool),
            Some(WorkspaceRoute::Unavailable { .. }) => None,
            Some(WorkspaceRoute::Original { .. }) | None => self.original(),
        }
    }
}

#[async_trait]
impl Tool for ExternalToolMux {
    fn name(&self) -> &str {
        &self.name
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        match self.original() {
            Some(tool) => tool.description().await,
            None => Ok(format!("External tool: {}", self.name)),
        }
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        match self.selected(context) {
            Some(tool) => tool.description_with_context(context).await,
            None => Err(OpenBitFunError::tool(format!(
                "tool '{}' is waiting for an external-source decision",
                self.name
            ))),
        }
    }

    fn short_description(&self) -> String {
        self.original()
            .map(|tool| tool.short_description())
            .unwrap_or_else(|| format!("External tool: {}", self.name))
    }

    fn default_exposure(&self) -> ToolExposure {
        self.original()
            .map(|tool| tool.default_exposure())
            .unwrap_or(ToolExposure::Direct)
    }

    fn input_schema(&self) -> Value {
        self.original()
            .map(|tool| tool.input_schema())
            .unwrap_or_else(|| serde_json::json!({ "type": "object" }))
    }

    async fn input_schema_for_model_with_context(&self, context: Option<&ToolUseContext>) -> Value {
        match self.selected(context) {
            Some(tool) => tool.input_schema_for_model_with_context(context).await,
            None => self.input_schema(),
        }
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        Some("external-source-router")
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        self.original()
            .and_then(|tool| tool.dynamic_tool_info())
            .or_else(|| {
                Some(DynamicToolInfo {
                    provider_id: "external-source-router".to_string(),
                    provider_kind: Some("contextual_router".to_string()),
                    mcp: None,
                })
            })
    }

    async fn is_enabled(&self) -> bool {
        self.original().is_some() || self.route_count() > 0
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        match self.selected(context) {
            Some(tool) => tool.is_available_in_context(context).await,
            None => false,
        }
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        self.selected(Some(context))
            .ok_or_else(|| OpenBitFunError::tool(format!("tool '{}' is unavailable", self.name)))?
            .permission_intents(input, context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match self.selected(context) {
            Some(tool) => tool.validate_input(input, context).await,
            None => ValidationResult {
                result: false,
                message: Some(format!(
                    "tool '{}' is waiting for an external-source decision",
                    self.name
                )),
                error_code: None,
                meta: None,
            },
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let selected = self.selected(Some(context)).ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "tool '{}' is waiting for an external-source decision",
                self.name
            ))
        })?;
        selected.call(input, context).await
    }

    async fn call(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return self
                .original()
                .ok_or_else(|| {
                    OpenBitFunError::tool(format!(
                        "tool '{}' is unavailable in remote workspaces",
                        self.name
                    ))
                })?
                .call(input, context)
                .await;
        }
        let workspace_key = workspace_route_key(context.workspace_id());
        let route = self
            .routes
            .read()
            .expect("external tool route lock poisoned")
            .get(&workspace_key)
            .cloned();
        if let Some(expectation) = route.as_ref().and_then(WorkspaceRoute::conflict) {
            if !crate::external_sources::external_tool_conflict_selection_is_current(
                &expectation.key,
                expectation.selected_candidate_id.as_deref(),
            )
            .await
            .map_err(OpenBitFunError::tool)?
            {
                return Err(OpenBitFunError::tool(format!(
                    "tool conflict choice for '{}' changed in another OpenBitFun process; refresh before retrying",
                    self.name
                )));
            }
        }
        match route {
            Some(WorkspaceRoute::External { tool, .. }) => tool.call(input, context).await,
            Some(WorkspaceRoute::Live { .. }) => {
                self.selected(Some(context))
                    .ok_or_else(|| {
                        OpenBitFunError::tool(format!("tool '{}' is unavailable", self.name))
                    })?
                    .call(input, context)
                    .await
            }
            Some(WorkspaceRoute::Original { .. }) | None => {
                self.original()
                    .ok_or_else(|| {
                        OpenBitFunError::tool(format!(
                            "tool '{}' is waiting for an external-source decision",
                            self.name
                        ))
                    })?
                    .call(input, context)
                    .await
            }
            Some(WorkspaceRoute::Unavailable { .. }) => Err(OpenBitFunError::tool(format!(
                "tool '{}' is waiting for an external-source decision",
                self.name
            ))),
        }
    }
}

struct ExternalToolRouter {
    muxes: StdMutex<BTreeMap<String, Arc<ExternalToolMux>>>,
    live_candidates:
        StdMutex<HashMap<String, BTreeMap<String, BTreeMap<String, LiveExternalToolCandidate>>>>,
    mutation_gate: Mutex<()>,
}

#[derive(Clone)]
struct LiveExternalToolCandidate {
    tool: Arc<dyn Tool>,
    native_agent_visible: bool,
    candidate: ExternalToolConflictCandidate,
}

impl Default for ExternalToolRouter {
    fn default() -> Self {
        Self {
            muxes: StdMutex::new(BTreeMap::new()),
            live_candidates: StdMutex::new(HashMap::new()),
            mutation_gate: Mutex::new(()),
        }
    }
}

impl ExternalToolRouter {
    fn register_live_candidate(
        &self,
        workspace_key: &str,
        tool: Arc<dyn Tool>,
        provider_id: &str,
        content_version: String,
        native_agent_visible: bool,
    ) {
        let name = tool.name().to_string();
        let candidate_id = format!("external:live:{provider_id}:{name}");
        let candidate = ExternalToolConflictCandidate {
            candidate_id: candidate_id.clone(),
            display_name: name.clone(),
            kind: ExternalToolConflictCandidateKind::External,
            provider_id: provider_id.to_string(),
            content_version,
            source: None,
            source_location: None,
        };
        self.live_candidates
            .lock()
            .expect("external live tool candidate lock poisoned")
            .entry(workspace_key.to_string())
            .or_default()
            .entry(name)
            .or_default()
            .insert(
                candidate_id,
                LiveExternalToolCandidate {
                    tool,
                    native_agent_visible,
                    candidate,
                },
            );
    }

    fn unregister_live_candidate(&self, workspace_key: &str, name: &str, provider_id: &str) {
        let candidate_id = format!("external:live:{provider_id}:{name}");
        let mut by_workspace = self
            .live_candidates
            .lock()
            .expect("external live tool candidate lock poisoned");
        let Some(by_name) = by_workspace.get_mut(workspace_key) else {
            return;
        };
        if let Some(candidates) = by_name.get_mut(name) {
            candidates.remove(&candidate_id);
            if candidates.is_empty() {
                by_name.remove(name);
            }
        }
        if by_name.is_empty() {
            by_workspace.remove(workspace_key);
        }
    }

    fn live_candidates(
        &self,
        workspace_key: &str,
    ) -> BTreeMap<String, Vec<LiveExternalToolCandidate>> {
        self.live_candidates
            .lock()
            .expect("external live tool candidate lock poisoned")
            .get(workspace_key)
            .map(|by_name| {
                by_name
                    .iter()
                    .map(|(name, candidates)| {
                        (name.clone(), candidates.values().cloned().collect())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn apply_initial_live_candidate_route(
        &self,
        workspace_key: &str,
        name: &str,
        tool: Arc<dyn Tool>,
        native_agent_visible: bool,
    ) {
        let mut routes = self.workspace_routes(workspace_key);
        if let Some(existing) = routes.get(name).cloned() {
            match existing {
                WorkspaceRoute::External { conflict, .. } => {
                    routes.insert(name.to_string(), WorkspaceRoute::Unavailable { conflict });
                    self.apply_routes(workspace_key, routes).await;
                }
                WorkspaceRoute::Live {
                    conflict: Some(conflict),
                    ..
                } => {
                    routes.insert(
                        name.to_string(),
                        WorkspaceRoute::Unavailable {
                            conflict: Some(conflict),
                        },
                    );
                    self.apply_routes(workspace_key, routes).await;
                }
                WorkspaceRoute::Live { conflict: None, .. } => {
                    routes.insert(
                        name.to_string(),
                        WorkspaceRoute::Live {
                            tool,
                            native_agent_visible,
                            conflict: None,
                        },
                    );
                    self.apply_routes(workspace_key, routes).await;
                }
                _ => {}
            }
            return;
        }
        let has_original = self.original_tool(name).await.is_some();
        let route = if tool.dynamic_provider_id() == Some("opencode-plugin")
            && (!native_agent_visible || !has_original)
        {
            WorkspaceRoute::Live {
                tool,
                native_agent_visible,
                conflict: None,
            }
        } else if has_original {
            WorkspaceRoute::Original { conflict: None }
        } else {
            WorkspaceRoute::Live {
                tool,
                native_agent_visible,
                conflict: None,
            }
        };
        routes.insert(name.to_string(), route);
        self.apply_routes(workspace_key, routes).await;
    }

    async fn withdraw_live_candidate_route(&self, workspace_key: &str, name: &str) {
        let mut routes = self.workspace_routes(workspace_key);
        let Some(route) = routes.remove(name) else {
            return;
        };
        match route {
            WorkspaceRoute::Live {
                conflict: Some(conflict),
                ..
            } => {
                routes.insert(
                    name.to_string(),
                    WorkspaceRoute::Unavailable {
                        conflict: Some(conflict),
                    },
                );
            }
            WorkspaceRoute::Live { conflict: None, .. } => {
                if self.original_tool(name).await.is_some() {
                    routes.insert(
                        name.to_string(),
                        WorkspaceRoute::Original { conflict: None },
                    );
                }
            }
            other => {
                routes.insert(name.to_string(), other);
            }
        }
        self.apply_routes(workspace_key, routes).await;
    }

    fn known_name(&self, tool_name: &str) -> Option<String> {
        self.muxes
            .lock()
            .expect("external tool router lock poisoned")
            .keys()
            .find(|name| name.as_str() == tool_name)
            .cloned()
    }

    async fn original_tool(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if let Some(mux) = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .get(name)
        {
            return mux.original();
        }
        get_global_tool_registry().read().await.get_tool(name)
    }

    async fn apply_routes(&self, workspace_key: &str, routes: BTreeMap<String, WorkspaceRoute>) {
        let _mutation_guard = self.mutation_gate.lock().await;
        let current_muxes = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for mux in current_muxes {
            if !routes.contains_key(&mux.name) {
                mux.remove_route(workspace_key);
            }
        }
        for (name, route) in routes {
            let existing = self
                .muxes
                .lock()
                .expect("external tool router lock poisoned")
                .get(&name)
                .cloned();
            let mux = if let Some(mux) = existing {
                mux
            } else {
                let registry = get_global_tool_registry();
                let mut registry = registry.write().await;
                let original = registry.unregister_tool(&name);
                let mux = Arc::new(ExternalToolMux::new(name.clone(), original));
                self.muxes
                    .lock()
                    .expect("external tool router lock poisoned")
                    .insert(name.clone(), mux.clone());
                registry.register_tool(mux.clone());
                mux
            };
            mux.set_route(workspace_key.to_string(), route);
        }

        // Keep zero-route muxes installed as the stable interception point for future
        // registry registrations. Uninstalling a mux would require an atomic swap across
        // the router and registry, which their independent locks cannot provide.
    }

    async fn withdraw_failed_target(
        &self,
        workspace_key: &str,
        runtime_target_id: &str,
        load_generation: u64,
        tool_names: &[String],
    ) {
        let _mutation_guard = self.mutation_gate.lock().await;
        for name in tool_names {
            let mux = self
                .muxes
                .lock()
                .expect("external tool router lock poisoned")
                .get(name)
                .cloned();
            let Some(mux) = mux else {
                continue;
            };
            let mut routes = mux
                .routes
                .write()
                .expect("external tool route lock poisoned");
            let Some(WorkspaceRoute::External { tool, conflict }) = routes.get(workspace_key)
            else {
                continue;
            };
            if tool.runtime_target_id != runtime_target_id
                || tool.load_generation != load_generation
            {
                continue;
            }
            // Never silently fall back to a built-in/MCP implementation after
            // the user explicitly selected an external conflict candidate.
            let conflict = conflict.clone();
            routes.insert(
                workspace_key.to_string(),
                WorkspaceRoute::Unavailable { conflict },
            );
        }
    }

    fn intercept_registration(&self, tool: Arc<dyn Tool>) -> Arc<dyn Tool> {
        let mux = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .get(tool.name())
            .cloned();
        let Some(mux) = mux else {
            return tool;
        };
        let routed: Arc<dyn Tool> = mux.clone();
        if Arc::ptr_eq(&routed, &tool) {
            return tool;
        }
        mux.replace_original(Some(tool));
        let mut routes = mux
            .routes
            .write()
            .expect("external tool route lock poisoned");
        for route in routes.values_mut() {
            match route {
                WorkspaceRoute::Live { conflict: None, .. } => {
                    *route = WorkspaceRoute::Original { conflict: None };
                }
                WorkspaceRoute::Live {
                    conflict: Some(conflict),
                    ..
                } => {
                    *route = WorkspaceRoute::Unavailable {
                        conflict: Some(conflict.clone()),
                    };
                }
                _ => {}
            }
        }
        routed
    }

    fn detach_mcp_server(&self, server_id: &str) -> Vec<Arc<dyn Tool>> {
        let muxes = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut retained_muxes = Vec::new();
        for mux in muxes {
            let matches_server = mux
                .original()
                .and_then(|tool| tool.dynamic_tool_info())
                .and_then(|info| info.mcp)
                .is_some_and(|mcp| mcp.server_id == server_id);
            if matches_server {
                mux.replace_original(None);
                let routed: Arc<dyn Tool> = mux;
                retained_muxes.push(routed);
            }
        }
        retained_muxes
    }

    fn retain_muxes_for_prefix(&self, prefix: &str) -> Vec<Arc<dyn Tool>> {
        self.muxes
            .lock()
            .expect("external tool router lock poisoned")
            .iter()
            .filter(|(name, _)| name.starts_with(prefix))
            .map(|(_, mux)| {
                mux.replace_original(None);
                let routed: Arc<dyn Tool> = mux.clone();
                routed
            })
            .collect()
    }

    fn resolve_registered_tool(
        &self,
        tool: Arc<dyn Tool>,
        workspace_id: Option<&str>,
    ) -> Option<Arc<dyn Tool>> {
        let mux = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .get(tool.name())
            .cloned();
        match mux {
            Some(mux) => mux.selected_for_workspace(workspace_id),
            None => Some(tool),
        }
    }

    fn resolve_registered_tool_for_context(
        &self,
        tool: Arc<dyn Tool>,
        context: &ToolUseContext,
    ) -> Option<Arc<dyn Tool>> {
        let mux = self
            .muxes
            .lock()
            .expect("external tool router lock poisoned")
            .get(tool.name())
            .cloned();
        match mux {
            Some(mux) => mux.selected(Some(context)),
            None => Some(tool),
        }
    }

    fn workspace_routes(&self, workspace_key: &str) -> BTreeMap<String, WorkspaceRoute> {
        self.muxes
            .lock()
            .expect("external tool router lock poisoned")
            .iter()
            .filter_map(|(name, mux)| {
                mux.routes
                    .read()
                    .expect("external tool route lock poisoned")
                    .get(workspace_key)
                    .cloned()
                    .map(|route| (name.clone(), route))
            })
            .collect()
    }
}

pub(crate) fn intercept_external_tool_registry_registration(tool: Arc<dyn Tool>) -> Arc<dyn Tool> {
    router().intercept_registration(tool)
}

pub(crate) async fn register_live_external_tool_candidate(
    workspace_id: &str,
    tool: Arc<dyn Tool>,
    provider_id: &str,
    content_version: String,
    native_agent_visible: bool,
) {
    let workspace_key = workspace_route_key(Some(workspace_id));
    router().register_live_candidate(
        &workspace_key,
        tool.clone(),
        provider_id,
        content_version,
        native_agent_visible,
    );
    let name = tool.name().to_string();
    router()
        .apply_initial_live_candidate_route(&workspace_key, &name, tool, native_agent_visible)
        .await;
    crate::external_sources::notify_external_tool_registry_changed();
}

pub(crate) async fn unregister_live_external_tool_candidate(
    workspace_id: &str,
    name: &str,
    provider_id: &str,
) {
    let workspace_key = workspace_route_key(Some(workspace_id));
    router().unregister_live_candidate(&workspace_key, name, provider_id);
    router()
        .withdraw_live_candidate_route(&workspace_key, name)
        .await;
    crate::external_sources::notify_external_tool_registry_changed();
}

pub(crate) fn detach_external_tool_mcp_server(server_id: &str) -> Vec<Arc<dyn Tool>> {
    router().detach_mcp_server(server_id)
}

pub(crate) fn retain_external_tool_muxes_for_prefix(prefix: &str) -> Vec<Arc<dyn Tool>> {
    router().retain_muxes_for_prefix(prefix)
}

pub(crate) fn resolve_external_tool_for_workspace(
    tool: Arc<dyn Tool>,
    workspace_id: Option<&str>,
) -> Option<Arc<dyn Tool>> {
    router().resolve_registered_tool(tool, workspace_id)
}

pub(crate) fn resolve_external_tool_for_context(
    tool: Arc<dyn Tool>,
    context: &ToolUseContext,
) -> Option<Arc<dyn Tool>> {
    router().resolve_registered_tool_for_context(tool, context)
}

#[cfg(test)]
pub(crate) fn external_tool_route_root(
    workspace_id: Option<&str>,
    is_remote: bool,
) -> Option<&str> {
    if is_remote {
        // External-source workspace roots must be absolute. This deliberately
        // non-routable key selects only the displaced local implementation
        // while remote Tool Runtime ownership is unavailable.
        Some("<unsupported-remote>")
    } else {
        workspace_id
    }
}

struct LoadedTarget {
    revision: String,
    load_generation: u64,
    tools: Vec<Arc<LoadedExternalTool>>,
}

struct ExternalToolRuntimeManager {
    runtime: Arc<dyn ScriptToolRuntime>,
    loaded: Mutex<HashMap<String, LoadedTarget>>,
    workspace_targets: Mutex<HashMap<String, BTreeSet<String>>>,
    lost_targets: Mutex<HashMap<String, LostExternalToolTarget>>,
}

struct LostExternalToolTarget {
    workspace_key: String,
    reason: String,
    recovery_state: WorkerRecoveryState,
}

#[derive(Clone, Debug)]
struct LostExternalToolStatus {
    reason: String,
    recovery_state: WorkerRecoveryState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkerRecoveryState {
    Pending,
    Attempted,
}

impl Default for ExternalToolRuntimeManager {
    fn default() -> Self {
        Self {
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
            loaded: Mutex::new(HashMap::new()),
            workspace_targets: Mutex::new(HashMap::new()),
            lost_targets: Mutex::new(HashMap::new()),
        }
    }
}

impl ExternalToolRuntimeManager {
    async fn availability(&self) -> ScriptToolRuntimeAvailability {
        self.runtime.availability().await
    }

    async fn invalidate_availability(&self) {
        self.runtime.invalidate_availability().await;
    }

    async fn mark_worker_lost(
        &self,
        workspace_key: &str,
        runtime_target_id: &str,
        load_generation: u64,
        reason: &str,
    ) -> bool {
        let mut loaded = self.loaded.lock().await;
        if loaded
            .get(runtime_target_id)
            .is_none_or(|target| target.load_generation != load_generation)
        {
            return false;
        }
        loaded.remove(runtime_target_id);
        self.lost_targets
            .lock()
            .await
            .entry(runtime_target_id.to_string())
            .and_modify(|lost| {
                // The stdout monitor and an in-flight invocation can observe
                // the same process exit. Preserve an already consumed budget
                // so duplicate reports cannot create another auto-retry.
                lost.reason = reason.to_string();
            })
            .or_insert_with(|| LostExternalToolTarget {
                workspace_key: workspace_key.to_string(),
                reason: reason.to_string(),
                recovery_state: WorkerRecoveryState::Pending,
            });
        drop(loaded);
        true
    }

    async fn lost_status(
        &self,
        runtime_target_id: &str,
        worker_recovery_targets: &BTreeSet<String>,
    ) -> Option<LostExternalToolStatus> {
        self.lost_targets
            .lock()
            .await
            .get(runtime_target_id)
            .filter(|_| !worker_recovery_targets.contains(runtime_target_id))
            .map(|lost| LostExternalToolStatus {
                reason: lost.reason.clone(),
                recovery_state: lost.recovery_state,
            })
    }

    async fn workspace_requires_recovery(&self, workspace_key: &str) -> bool {
        self.lost_targets.lock().await.values().any(|lost| {
            lost.workspace_key == workspace_key
                && lost.recovery_state == WorkerRecoveryState::Pending
        })
    }

    async fn begin_workspace_recovery(&self, workspace_key: &str) -> BTreeSet<String> {
        let mut lost_targets = self.lost_targets.lock().await;
        let mut claimed = BTreeSet::new();
        for (runtime_target_id, lost) in lost_targets.iter_mut() {
            if lost.workspace_key == workspace_key
                && lost.recovery_state == WorkerRecoveryState::Pending
            {
                // Consume the automatic budget before any fallible await in
                // the caller. Cancellation therefore remains fail-closed and
                // cannot strand a target in an in-between recovery state.
                lost.recovery_state = WorkerRecoveryState::Attempted;
                claimed.insert(runtime_target_id.clone());
            }
        }
        claimed
    }

    async fn reset_workspace_recovery_budget(&self, workspace_key: &str) {
        for lost in self.lost_targets.lock().await.values_mut() {
            if lost.workspace_key == workspace_key
                && lost.recovery_state == WorkerRecoveryState::Attempted
            {
                lost.recovery_state = WorkerRecoveryState::Pending;
            }
        }
    }

    async fn ensure_loaded(
        &self,
        workspace_key: &str,
        ecosystem_id: &str,
        provider_id: &str,
        approval_key: &str,
        source_preference_key: &str,
        prepared: PreparedExternalToolTarget,
    ) -> Result<Vec<Arc<LoadedExternalTool>>, String> {
        let runtime_target_id = runtime_target_id(workspace_key, &prepared.target_id);
        static NEXT_LOAD_GENERATION: AtomicU64 = AtomicU64::new(1);
        let worktree_root = prepared.worktree_root.clone();
        let cached = self
            .loaded
            .lock()
            .await
            .get(&runtime_target_id)
            .map(|target| (target.revision.clone(), target.tools.clone()));
        if let Some((revision, tools)) = cached {
            if revision == prepared.content_version
                && self.runtime.is_loaded(&runtime_target_id).await
            {
                return Ok(tools);
            }
        }
        self.loaded.lock().await.remove(&runtime_target_id);
        let request = ScriptToolLoadRequest {
            target_id: runtime_target_id.clone(),
            revision: prepared.content_version.clone(),
            module_source: prepared.module_source,
            module_url: prepared.module_url,
            working_directory: prepared.working_directory,
            expected_tools: prepared
                .expected_tools
                .into_iter()
                .map(|tool| ScriptToolExpectedExport {
                    export_name: tool.export_name,
                    tool_name: tool.tool_name,
                })
                .collect(),
        };
        let loaded = match self.runtime.load(request).await {
            Ok(loaded) => loaded,
            Err(error) => {
                self.loaded.lock().await.remove(&runtime_target_id);
                return Err(error.to_string());
            }
        };
        let load_generation = NEXT_LOAD_GENERATION.fetch_add(1, Ordering::Relaxed);
        let target_tool_names = Arc::new(
            loaded
                .tools
                .iter()
                .map(|descriptor| descriptor.name.clone())
                .collect::<Vec<_>>(),
        );
        let tools = loaded
            .tools
            .into_iter()
            .map(|descriptor| {
                Arc::new(LoadedExternalTool {
                    descriptor,
                    ecosystem_id: ecosystem_id.to_string(),
                    provider_id: provider_id.to_string(),
                    runtime_target_id: runtime_target_id.clone(),
                    load_generation,
                    revision: loaded.revision.clone(),
                    approval_key: approval_key.to_string(),
                    source_preference_key: source_preference_key.to_string(),
                    workspace_key: workspace_key.to_string(),
                    target_tool_names: Arc::clone(&target_tool_names),
                    worktree_root: worktree_root.clone(),
                    runtime: self.runtime.clone(),
                })
            })
            .collect::<Vec<_>>();
        self.loaded.lock().await.insert(
            runtime_target_id.clone(),
            LoadedTarget {
                revision: loaded.revision.clone(),
                load_generation,
                tools: tools.clone(),
            },
        );
        self.lost_targets.lock().await.remove(&runtime_target_id);
        let monitor_runtime = Arc::clone(&self.runtime);
        let monitor_runtime_target_id = runtime_target_id.clone();
        let monitor_revision = loaded.revision;
        let monitor_load_generation = load_generation;
        let monitor_workspace_key = workspace_key.to_string();
        let monitor_tool_names = Arc::clone(&target_tool_names);
        tokio::spawn(async move {
            if monitor_runtime
                .wait_until_unloaded(&monitor_runtime_target_id)
                .await
                .is_err()
            {
                return;
            }
            let is_current = runtime_manager()
                .loaded
                .lock()
                .await
                .get(&monitor_runtime_target_id)
                .is_some_and(|target| {
                    target.revision == monitor_revision
                        && target.load_generation == monitor_load_generation
                });
            if is_current {
                report_external_tool_worker_lost(
                    &monitor_workspace_key,
                    &monitor_runtime_target_id,
                    monitor_load_generation,
                    monitor_tool_names.as_ref(),
                    "tool process exited while idle".to_string(),
                )
                .await;
            }
        });
        Ok(tools)
    }

    async fn target_matches(&self, runtime_target_id: &str, revision: &str) -> bool {
        let matches_revision = self
            .loaded
            .lock()
            .await
            .get(runtime_target_id)
            .is_some_and(|target| target.revision == revision);
        matches_revision && self.runtime.is_loaded(runtime_target_id).await
    }

    async fn withdraw_target(&self, runtime_target_id: &str) {
        self.loaded.lock().await.remove(runtime_target_id);
        let _ = self.runtime.dispose(runtime_target_id).await;
    }

    async fn reconcile_workspace_targets(
        &self,
        workspace_key: &str,
        desired_targets: BTreeSet<String>,
    ) {
        let previous = self
            .workspace_targets
            .lock()
            .await
            .insert(workspace_key.to_string(), desired_targets.clone())
            .unwrap_or_default();
        for target in previous.difference(&desired_targets) {
            self.loaded.lock().await.remove(target);
            let _ = self.runtime.dispose(target).await;
        }
    }

    async fn release_workspace(&self, workspace_key: &str) {
        let targets = self
            .workspace_targets
            .lock()
            .await
            .remove(workspace_key)
            .unwrap_or_default();
        for target in targets {
            self.loaded.lock().await.remove(&target);
            let _ = self.runtime.dispose(&target).await;
        }
        self.lost_targets
            .lock()
            .await
            .retain(|_, lost| lost.workspace_key != workspace_key);
    }
}

fn router() -> &'static ExternalToolRouter {
    static ROUTER: OnceLock<ExternalToolRouter> = OnceLock::new();
    ROUTER.get_or_init(ExternalToolRouter::default)
}

fn runtime_manager() -> &'static ExternalToolRuntimeManager {
    static MANAGER: OnceLock<ExternalToolRuntimeManager> = OnceLock::new();
    MANAGER.get_or_init(ExternalToolRuntimeManager::default)
}

async fn report_external_tool_worker_lost(
    workspace_key: &str,
    runtime_target_id: &str,
    load_generation: u64,
    tool_names: &[String],
    reason: String,
) {
    if !runtime_manager()
        .mark_worker_lost(workspace_key, runtime_target_id, load_generation, &reason)
        .await
    {
        return;
    }
    router()
        .withdraw_failed_target(
            workspace_key,
            runtime_target_id,
            load_generation,
            tool_names,
        )
        .await;
    crate::external_sources::notify_external_tool_registry_changed();
}

pub(super) async fn external_tool_workspace_requires_recovery(workspace_id: Option<&str>) -> bool {
    runtime_manager()
        .workspace_requires_recovery(&workspace_route_key(workspace_id))
        .await
}

pub(super) async fn begin_external_tool_workspace_recovery(
    workspace_id: Option<&str>,
) -> BTreeSet<String> {
    runtime_manager()
        .begin_workspace_recovery(&workspace_route_key(workspace_id))
        .await
}

pub(super) async fn reset_external_tool_workspace_recovery_budget(workspace_id: Option<&str>) {
    runtime_manager()
        .reset_workspace_recovery_budget(&workspace_route_key(workspace_id))
        .await;
}

pub(super) async fn invalidate_external_tool_runtime_availability() {
    runtime_manager().invalidate_availability().await;
}

pub(super) async fn release_external_tool_workspace(workspace_id: Option<&str>) {
    let workspace_key = workspace_route_key(workspace_id);
    router().apply_routes(&workspace_key, BTreeMap::new()).await;
    runtime_manager().release_workspace(&workspace_key).await;
}

pub(super) async fn reconcile_external_tools(
    workspace_id: Option<&str>,
    execution_domain_id: &str,
    control_plane: &Arc<ExternalSourceControlPlane>,
    decisions: ExternalToolDecisions<'_>,
    worker_recovery_targets: &BTreeSet<String>,
) -> ExternalToolProductState {
    let workspace_key = workspace_route_key(workspace_id);
    let snapshot = control_plane.tools(|coordinator| coordinator.snapshot());
    let mut state = ExternalToolProductState::default();
    let mut live_candidates_by_name = router().live_candidates(&workspace_key);
    let source_by_key = snapshot
        .sources
        .iter()
        .map(|source| (source.record.key.clone(), source.record.clone()))
        .collect::<BTreeMap<_, _>>();
    let runtime_availability = runtime_manager().availability().await;
    let mut target_groups =
        BTreeMap::<SourceQualifiedToolTargetId, Vec<ExternalToolDefinition>>::new();
    for tool in snapshot.tools {
        target_groups
            .entry(tool.id.target.clone())
            .or_default()
            .push(tool);
    }
    let mut discovered_names = target_groups
        .values()
        .flatten()
        .map(|tool| tool.name.clone())
        .collect::<BTreeSet<_>>();
    discovered_names.extend(live_candidates_by_name.keys().cloned());
    let mut names_to_quiesce = BTreeSet::new();
    let mut preapproved_runtime_targets = BTreeSet::new();
    for (target_id, definitions) in &target_groups {
        let first = &definitions[0];
        let approval_key = external_tool_approval_key(
            execution_domain_id,
            target_id,
            first.runtime_kind,
            first.capabilities.iter().copied(),
        );
        let statically_ready = definitions
            .iter()
            .all(|tool| matches!(&tool.static_status, ExternalToolStaticStatus::Ready));
        let ecosystem_active = source_by_key
            .get(&target_id.source)
            .is_some_and(|source| decisions.active_ecosystems.contains(&source.ecosystem_id));
        let can_load = ecosystem_active
            && statically_ready
            && matches!(
                &runtime_availability,
                ScriptToolRuntimeAvailability::Available { .. }
            )
            && decisions.approved_targets.contains(&approval_key);
        let runtime_target = runtime_target_id(&workspace_key, target_id);
        let matches_loaded = can_load
            && runtime_manager()
                .target_matches(&runtime_target, &first.content_version)
                .await;
        if can_load {
            preapproved_runtime_targets.insert(runtime_target.clone());
        }
        if !matches_loaded {
            names_to_quiesce.extend(definitions.iter().map(|tool| tool.name.clone()));
            runtime_manager().withdraw_target(&runtime_target).await;
        }
    }
    // Preserve healthy, byte-identical routes while other targets prepare.
    // Removed, disabled and changed targets are withdrawn before slow work.
    let mut preliminary_routes = router().workspace_routes(&workspace_key);
    retain_fail_closed_routes_during_reconcile(&mut preliminary_routes, &discovered_names);
    for name in names_to_quiesce {
        if !preliminary_routes.contains_key(&name) {
            continue;
        }
        let route = match preliminary_routes.get(&name) {
            Some(WorkspaceRoute::External { conflict, .. }) => WorkspaceRoute::Unavailable {
                conflict: conflict.clone(),
            },
            _ if router().original_tool(&name).await.is_some() => {
                WorkspaceRoute::Original { conflict: None }
            }
            _ => WorkspaceRoute::Unavailable { conflict: None },
        };
        preliminary_routes.insert(name, route);
    }
    router()
        .apply_routes(&workspace_key, preliminary_routes)
        .await;
    runtime_manager()
        .reconcile_workspace_targets(&workspace_key, preapproved_runtime_targets)
        .await;

    let mut conflict_candidates_by_name = BTreeMap::<String, Vec<ExternalToolDefinition>>::new();
    let mut loaded_by_candidate_id = BTreeMap::<String, Arc<LoadedExternalTool>>::new();
    let mut desired_runtime_targets = BTreeSet::new();
    let mut entries = BTreeMap::<String, ExternalToolCatalogEntry>::new();

    for (target_id, definitions) in target_groups {
        let first = &definitions[0];
        let approval_key = external_tool_approval_key(
            execution_domain_id,
            &target_id,
            first.runtime_kind,
            first.capabilities.iter().copied(),
        );
        let decision_key = external_tool_decision_key(&approval_key, &first.content_version);
        let ecosystem_active = source_by_key
            .get(&target_id.source)
            .is_some_and(|source| decisions.active_ecosystems.contains(&source.ecosystem_id));
        let unsupported_reason = definitions
            .iter()
            .find_map(|tool| match &tool.static_status {
                ExternalToolStaticStatus::Ready => None,
                ExternalToolStaticStatus::Unsupported { reason }
                | ExternalToolStaticStatus::Invalid { reason } => Some(reason.clone()),
                _ => Some("tool uses a static format not supported by this version".to_string()),
            });
        let base_activation = if let Some(reason) = unsupported_reason {
            Some(ExternalToolActivationState::Unsupported { reason })
        } else if !ecosystem_active {
            Some(ExternalToolActivationState::Disabled)
        } else if let ScriptToolRuntimeAvailability::Unavailable { reason } = &runtime_availability
        {
            Some(ExternalToolActivationState::RuntimeUnavailable {
                reason: reason.clone(),
            })
        } else if !decisions.approved_targets.contains(&approval_key) {
            let activation = if decisions
                .declined_decisions_by_approval
                .get(&approval_key)
                .is_some_and(|declined| declined == &decision_key)
            {
                ExternalToolActivationState::Declined
            } else {
                let source = source_by_key.get(&target_id.source);
                state.approval_requests.push(ExternalToolApprovalRequest {
                    approval_key: approval_key.clone(),
                    decision_key: decision_key.clone(),
                    target_id: target_id.clone(),
                    source_display_name: source
                        .map(|source| source.display_name.clone())
                        .unwrap_or_else(|| "External tools".to_string()),
                    source_scope: source
                        .map(|source| source.scope)
                        .unwrap_or(ExternalSourceScope::WorkspaceLocal),
                    source_location: source
                        .map(|source| source.location.clone())
                        .unwrap_or_else(|| first.module_path.clone()),
                    working_directory: first.working_directory.clone(),
                    runtime_kind: first.runtime_kind,
                    capabilities: first.capabilities.clone(),
                    content_version: first.content_version.clone(),
                    tool_names: definitions.iter().map(|tool| tool.name.clone()).collect(),
                });
                ExternalToolActivationState::ApprovalRequired
            };
            Some(activation)
        } else {
            None
        };

        if let Some(activation) = base_activation {
            if matches!(
                activation,
                ExternalToolActivationState::RuntimeUnavailable { .. }
            ) && decisions.approved_targets.contains(&approval_key)
            {
                if let Some(source) = source_by_key.get(&target_id.source) {
                    if crate::external_sources::external_tool_invocation_is_authorized(
                        source.ecosystem_id.as_str(),
                        &approval_key,
                        &source.preference_key(),
                        &workspace_key,
                    )
                    .await
                    .unwrap_or(false)
                    {
                        for definition in &definitions {
                            conflict_candidates_by_name
                                .entry(definition.name.clone())
                                .or_default()
                                .push(definition.clone());
                        }
                    }
                }
            }
            for definition in definitions {
                entries.insert(
                    definition.id.stable_key(),
                    ExternalToolCatalogEntry {
                        definition,
                        approval_key: approval_key.clone(),
                        decision_key: decision_key.clone(),
                        activation: activation.clone(),
                    },
                );
            }
            continue;
        }

        let Some(source_record) = source_by_key.get(&target_id.source) else {
            state.diagnostics.push(tool_diagnostic(
                "external_tool.source_record_missing",
                "External tool source metadata is missing; the target was not loaded.",
                Some(target_id.source.clone()),
            ));
            for definition in definitions {
                entries.insert(
                    definition.id.stable_key(),
                    ExternalToolCatalogEntry {
                        definition,
                        approval_key: approval_key.clone(),
                        decision_key: decision_key.clone(),
                        activation: ExternalToolActivationState::LoadFailed {
                            reason: "source metadata is unavailable".to_string(),
                        },
                    },
                );
            }
            continue;
        };
        let source_preference_key = source_record.preference_key();
        match crate::external_sources::external_tool_invocation_is_authorized(
            source_record.ecosystem_id.as_str(),
            &approval_key,
            &source_preference_key,
            &workspace_key,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => {
                runtime_manager()
                    .withdraw_target(&runtime_target_id(&workspace_key, &target_id))
                    .await;
                for definition in definitions {
                    entries.insert(
                        definition.id.stable_key(),
                        ExternalToolCatalogEntry {
                            definition,
                            approval_key: approval_key.clone(),
                            decision_key: decision_key.clone(),
                            activation: ExternalToolActivationState::Disabled,
                        },
                    );
                }
                continue;
            }
            Err(error) => {
                state.diagnostics.push(tool_diagnostic(
                    "external_tool.preference_read_failed",
                    format!("Could not verify the current external tool decision: {error}"),
                    Some(target_id.source.clone()),
                ));
                for definition in definitions {
                    entries.insert(
                        definition.id.stable_key(),
                        ExternalToolCatalogEntry {
                            definition,
                            approval_key: approval_key.clone(),
                            decision_key: decision_key.clone(),
                            activation: ExternalToolActivationState::LoadFailed {
                                reason: "current approval could not be verified".to_string(),
                            },
                        },
                    );
                }
                continue;
            }
        }

        for definition in &definitions {
            conflict_candidates_by_name
                .entry(definition.name.clone())
                .or_default()
                .push(definition.clone());
        }

        let runtime_target = runtime_target_id(&workspace_key, &target_id);
        if let Some(loss) = runtime_manager()
            .lost_status(&runtime_target, worker_recovery_targets)
            .await
        {
            state.diagnostics.push(tool_diagnostic(
                "external_tool.worker_lost",
                "External tool process stopped and its route was withdrawn.",
                Some(target_id.source.clone()),
            ));
            log::warn!(
                "External tool process stopped for target '{}': {}",
                runtime_target,
                loss.reason
            );
            let retry_guidance = match loss.recovery_state {
                WorkerRecoveryState::Pending => {
                    "tool process stopped; one automatic recovery will run before the next catalog is exposed"
                }
                WorkerRecoveryState::Attempted => {
                    "automatic recovery did not restore the tool; refresh external tools or update the source to retry"
                }
            };
            for definition in definitions {
                entries.insert(
                    definition.id.stable_key(),
                    ExternalToolCatalogEntry {
                        definition,
                        approval_key: approval_key.clone(),
                        decision_key: decision_key.clone(),
                        activation: ExternalToolActivationState::LoadFailed {
                            reason: retry_guidance.to_string(),
                        },
                    },
                );
            }
            continue;
        }

        let preparation_control_plane = Arc::clone(control_plane);
        let preparation_target = target_id.clone();
        let preparation_revision = first.content_version.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            preparation_control_plane.tools_mut(|coordinator| {
                coordinator.prepare_target_guarded(&preparation_target, &preparation_revision)
            })
        })
        .await
        .map_err(|error| format!("tool preparation task failed: {error}"))
        .and_then(|result| result.map_err(|error| error.to_string()));
        match prepared {
            Ok(prepared) => {
                let authorization_failure =
                    match crate::external_sources::external_tool_invocation_is_authorized(
                        source_record.ecosystem_id.as_str(),
                        &approval_key,
                        &source_preference_key,
                        &workspace_key,
                    )
                    .await
                    {
                        Ok(true) => None,
                        Ok(false) => Some(ExternalToolActivationState::Disabled),
                        Err(error) => {
                            state.diagnostics.push(tool_diagnostic(
                            "external_tool.preference_read_failed",
                            format!(
                                "Could not verify approval immediately before importing the external tool: {error}"
                            ),
                            Some(target_id.source.clone()),
                        ));
                            Some(ExternalToolActivationState::LoadFailed {
                                reason: "current approval could not be verified".to_string(),
                            })
                        }
                    };
                if let Some(activation) = authorization_failure {
                    runtime_manager()
                        .withdraw_target(&runtime_target_id(&workspace_key, &target_id))
                        .await;
                    for definition in definitions {
                        entries.insert(
                            definition.id.stable_key(),
                            ExternalToolCatalogEntry {
                                definition,
                                approval_key: approval_key.clone(),
                                decision_key: decision_key.clone(),
                                activation: activation.clone(),
                            },
                        );
                    }
                    continue;
                }
                match runtime_manager()
                    .ensure_loaded(
                        &workspace_key,
                        source_record.ecosystem_id.as_str(),
                        target_id.source.provider_id.as_str(),
                        &approval_key,
                        &source_preference_key,
                        prepared,
                    )
                    .await
                {
                    Ok(loaded) => {
                        match crate::external_sources::external_tool_invocation_is_authorized(
                            source_record.ecosystem_id.as_str(),
                            &approval_key,
                            &source_preference_key,
                            &workspace_key,
                        )
                        .await
                        {
                            Ok(true) => {}
                            Ok(false) => {
                                runtime_manager()
                                    .withdraw_target(&runtime_target_id(&workspace_key, &target_id))
                                    .await;
                                for definition in definitions {
                                    entries.insert(
                                        definition.id.stable_key(),
                                        ExternalToolCatalogEntry {
                                            definition,
                                            approval_key: approval_key.clone(),
                                            decision_key: decision_key.clone(),
                                            activation: ExternalToolActivationState::Disabled,
                                        },
                                    );
                                }
                                continue;
                            }
                            Err(error) => {
                                runtime_manager()
                                    .withdraw_target(&runtime_target_id(&workspace_key, &target_id))
                                    .await;
                                state.diagnostics.push(tool_diagnostic(
                                "external_tool.preference_read_failed",
                                format!(
                                    "Could not verify approval after loading the external tool: {error}"
                                ),
                                Some(target_id.source.clone()),
                            ));
                                for definition in definitions {
                                    entries.insert(
                                        definition.id.stable_key(),
                                        ExternalToolCatalogEntry {
                                            definition,
                                            approval_key: approval_key.clone(),
                                            decision_key: decision_key.clone(),
                                            activation: ExternalToolActivationState::LoadFailed {
                                                reason: "current approval could not be verified"
                                                    .to_string(),
                                            },
                                        },
                                    );
                                }
                                continue;
                            }
                        }
                        desired_runtime_targets
                            .insert(runtime_target_id(&workspace_key, &target_id));
                        let loaded_by_export = loaded
                            .into_iter()
                            .map(|tool| (tool.descriptor.export_name.clone(), tool))
                            .collect::<BTreeMap<_, _>>();
                        for definition in definitions {
                            let Some(loaded) = loaded_by_export
                                .get(definition.id.export_id.as_str())
                                .cloned()
                            else {
                                entries.insert(
                                    definition.id.stable_key(),
                                    ExternalToolCatalogEntry {
                                        definition,
                                        approval_key: approval_key.clone(),
                                        decision_key: decision_key.clone(),
                                        activation: ExternalToolActivationState::LoadFailed {
                                            reason:
                                                "worker did not return the expected tool export"
                                                    .to_string(),
                                        },
                                    },
                                );
                                continue;
                            };
                            loaded_by_candidate_id.insert(definition.candidate_id(), loaded);
                            entries.insert(
                                definition.id.stable_key(),
                                ExternalToolCatalogEntry {
                                    definition,
                                    approval_key: approval_key.clone(),
                                    decision_key: decision_key.clone(),
                                    activation: ExternalToolActivationState::Active,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        state.diagnostics.push(tool_diagnostic(
                            "external_tool.load_failed",
                            format!("Failed to load the external tool module: {error}"),
                            Some(target_id.source.clone()),
                        ));
                        for definition in definitions {
                            entries.insert(
                                definition.id.stable_key(),
                                ExternalToolCatalogEntry {
                                    definition,
                                    approval_key: approval_key.clone(),
                                    decision_key: decision_key.clone(),
                                    activation: ExternalToolActivationState::LoadFailed {
                                        reason: error.clone(),
                                    },
                                },
                            );
                        }
                    }
                }
            }
            Err(error) => {
                state.diagnostics.push(tool_diagnostic(
                    "external_tool.prepare_failed",
                    error.to_string(),
                    Some(target_id.source.clone()),
                ));
                for definition in definitions {
                    entries.insert(
                        definition.id.stable_key(),
                        ExternalToolCatalogEntry {
                            definition,
                            approval_key: approval_key.clone(),
                            decision_key: decision_key.clone(),
                            activation: ExternalToolActivationState::LoadFailed {
                                reason: error.to_string(),
                            },
                        },
                    );
                }
            }
        }
    }

    runtime_manager()
        .reconcile_workspace_targets(&workspace_key, desired_runtime_targets)
        .await;

    let conflict_domain = workspace_conflict_domain(execution_domain_id, &workspace_key);
    let mut names_by_normalized = BTreeMap::<String, BTreeSet<String>>::new();
    for name in conflict_candidates_by_name.keys() {
        names_by_normalized
            .entry(name.clone())
            .or_default()
            .insert(name.clone());
    }
    for name in live_candidates_by_name.keys() {
        names_by_normalized
            .entry(name.clone())
            .or_default()
            .insert(name.clone());
    }
    let conflict_prefix = format!("external_tool:{conflict_domain}:");
    for conflict_key in decisions.conflict_choices.keys() {
        let Some(rest) = conflict_key.strip_prefix(&conflict_prefix) else {
            continue;
        };
        let Some((normalized_name, _)) = rest.rsplit_once(':') else {
            continue;
        };
        let names = names_by_normalized
            .entry(normalized_name.to_string())
            .or_default();
        if names.is_empty() {
            names.insert(
                router()
                    .known_name(normalized_name)
                    .unwrap_or_else(|| normalized_name.to_string()),
            );
        }
    }

    let mut routes = BTreeMap::new();
    for name in names_by_normalized.into_values().flatten() {
        let external_candidates = conflict_candidates_by_name
            .remove(&name)
            .unwrap_or_default();
        let live_candidates = live_candidates_by_name.remove(&name).unwrap_or_default();
        let original = router().original_tool(&name).await;
        if external_candidates.is_empty() && live_candidates.is_empty() && original.is_none() {
            continue;
        }
        let mut candidates = Vec::new();
        if let Some(original) = &original {
            candidates.push(local_candidate(original).await);
        }
        for definition in &external_candidates {
            let candidate_id = definition.candidate_id();
            candidates.push(ExternalToolConflictCandidate {
                candidate_id,
                display_name: definition.name.clone(),
                kind: ExternalToolConflictCandidateKind::External,
                provider_id: definition.id.target.source.provider_id.to_string(),
                content_version: definition.content_version.clone(),
                source: Some(definition.id.target.source.clone()),
                source_location: Some(definition.module_path.clone()),
            });
        }
        candidates.extend(
            live_candidates
                .iter()
                .map(|candidate| candidate.candidate.clone()),
        );

        let has_conflict_history = if external_candidates.is_empty() {
            tool_conflict_history_requires_fail_closed(
                decisions.conflict_choices,
                &conflict_domain,
                &name,
            )
        } else {
            has_tool_conflict_history(decisions.conflict_choices, &conflict_domain, &name)
        };
        if candidates.len() == 1 && !has_conflict_history {
            if let Some(definition) = external_candidates.first() {
                let route = loaded_by_candidate_id
                    .get(&definition.candidate_id())
                    .cloned()
                    .map_or(WorkspaceRoute::Unavailable { conflict: None }, |tool| {
                        WorkspaceRoute::External {
                            tool,
                            conflict: None,
                        }
                    });
                routes.insert(name, route);
            } else if let Some(candidate) = live_candidates.first() {
                routes.insert(
                    name,
                    WorkspaceRoute::Live {
                        tool: candidate.tool.clone(),
                        native_agent_visible: candidate.native_agent_visible,
                        conflict: None,
                    },
                );
            }
            continue;
        }

        let conflict_key = external_tool_conflict_key(
            &conflict_domain,
            &name,
            candidates.iter().map(|candidate| {
                (
                    candidate.candidate_id.as_str(),
                    candidate.content_version.as_str(),
                )
            }),
        );
        let mut external_candidate_ids = external_candidates
            .iter()
            .map(ExternalToolDefinition::candidate_id)
            .collect::<BTreeSet<_>>();
        external_candidate_ids.extend(
            live_candidates
                .iter()
                .map(|candidate| candidate.candidate.candidate_id.clone()),
        );
        let (selected, route_choice) = resolve_conflict_route_choice(
            &conflict_key,
            &candidates,
            &external_candidate_ids,
            original.is_some(),
            decisions.conflict_choices,
        );
        let conflict = Some(ConflictExpectation {
            key: conflict_key.clone(),
            selected_candidate_id: selected.clone(),
        });
        let route = match route_choice {
            ConflictRouteChoice::External(candidate_id) => {
                if let Some(tool) = loaded_by_candidate_id.get(&candidate_id).cloned() {
                    WorkspaceRoute::External {
                        tool,
                        conflict: conflict.clone(),
                    }
                } else if let Some(candidate) = live_candidates
                    .iter()
                    .find(|candidate| candidate.candidate.candidate_id == candidate_id)
                {
                    WorkspaceRoute::Live {
                        tool: candidate.tool.clone(),
                        native_agent_visible: candidate.native_agent_visible,
                        conflict: conflict.clone(),
                    }
                } else {
                    WorkspaceRoute::Unavailable {
                        conflict: conflict.clone(),
                    }
                }
            }
            ConflictRouteChoice::Original => WorkspaceRoute::Original {
                conflict: conflict.clone(),
            },
            ConflictRouteChoice::Unavailable => WorkspaceRoute::Unavailable { conflict },
        };
        routes.insert(name.clone(), route);
        for definition in external_candidates {
            let selected_external = selected
                .as_deref()
                .is_some_and(|selected| selected == definition.candidate_id());
            if let Some(entry) = entries.get_mut(&definition.id.stable_key()) {
                entry.activation = if selected_external
                    && loaded_by_candidate_id.contains_key(&definition.candidate_id())
                {
                    ExternalToolActivationState::Active
                } else if selected_external {
                    entry.activation.clone()
                } else {
                    ExternalToolActivationState::Conflict
                };
            }
        }
        state.conflicts.push(ExternalToolConflict {
            conflict_key,
            tool_name: name,
            candidates,
            selected_candidate_id: selected,
        });
    }
    router().apply_routes(&workspace_key, routes).await;

    state.tools = entries.into_values().collect();
    state
        .tools
        .sort_by(|left, right| left.definition.name.cmp(&right.definition.name));
    state
        .approval_requests
        .sort_by(|left, right| left.source_location.cmp(&right.source_location));
    state
        .conflicts
        .sort_by(|left, right| left.tool_name.cmp(&right.tool_name));
    state
}

async fn local_candidate(tool: &Arc<dyn Tool>) -> ExternalToolConflictCandidate {
    let dynamic = tool.dynamic_tool_info();
    let kind = if dynamic
        .as_ref()
        .and_then(|info| info.mcp.as_ref())
        .is_some()
    {
        ExternalToolConflictCandidateKind::Mcp
    } else {
        ExternalToolConflictCandidateKind::BuiltIn
    };
    let provider_id = dynamic
        .as_ref()
        .map(|info| info.provider_id.clone())
        .unwrap_or_else(|| "openbitfun.builtin".to_string());
    let candidate_id = format!("registry:{provider_id}:{}", tool.name());
    let description = tool.description().await.unwrap_or_default();
    let schema = serde_json::to_vec(&tool.input_schema()).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(tool.name().as_bytes());
    hasher.update([0]);
    hasher.update(provider_id.as_bytes());
    hasher.update([0]);
    hasher.update(description.as_bytes());
    hasher.update([0]);
    hasher.update(schema);
    ExternalToolConflictCandidate {
        candidate_id,
        display_name: tool.name().to_string(),
        kind,
        provider_id,
        content_version: format!("sha256:{}", hex::encode(hasher.finalize())),
        source: None,
        source_location: None,
    }
}

fn workspace_conflict_domain(execution_domain_id: &str, workspace_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_key.as_bytes());
    format!(
        "{}-workspace-{}",
        execution_domain_id,
        hex::encode(&hasher.finalize()[..12])
    )
}

fn runtime_target_id(workspace_key: &str, target: &SourceQualifiedToolTargetId) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_key.as_bytes());
    hasher.update([0]);
    hasher.update(target.stable_key().as_bytes());
    format!("external-tool-{}", hex::encode(hasher.finalize()))
}

fn tool_diagnostic(
    code: impl Into<String>,
    message: impl Into<String>,
    source: Option<openbitfun_product_domains::external_sources::SourceKey>,
) -> ExternalSourceDiagnostic {
    ExternalSourceDiagnostic {
        severity: ExternalSourceDiagnosticSeverity::Warning,
        asset_kind: ExternalSourceAssetKind::Tool,
        code: code.into(),
        message: message.into(),
        source,
    }
}

pub(super) fn merge_tool_state(
    mut snapshot: openbitfun_product_domains::external_sources::ExternalSourceCatalogSnapshot,
    tool_snapshot: &ExternalToolCoordinatorSnapshot,
    state: ExternalToolProductState,
) -> openbitfun_product_domains::external_sources::ExternalSourceCatalogSnapshot {
    snapshot.generation = snapshot.generation.max(tool_snapshot.generation);
    snapshot.discovery_pending |= tool_snapshot.discovery_pending;
    snapshot.sources.extend(tool_snapshot.sources.clone());
    snapshot
        .sources
        .sort_by(|left, right| left.stable_key.cmp(&right.stable_key));
    snapshot.tools = state.tools;
    snapshot.tool_approval_requests = state.approval_requests;
    snapshot.tool_conflicts = state.conflicts;
    snapshot
        .diagnostics
        .extend(tool_snapshot.diagnostics.clone());
    snapshot.diagnostics.extend(state.diagnostics);
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_tools_use_provider_qualified_v2_identity() {
        let intent = external_tool_permission_intent("opencode", "release_notes");

        assert_eq!(intent.action, "custom_tool");
        assert_eq!(intent.resources, ["opencode:release_notes".to_string()]);
    }

    struct TestTool {
        name: String,
    }

    #[async_trait]
    impl Tool for TestTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("test tool".to_string())
        }

        fn short_description(&self) -> String {
            "test tool".to_string()
        }

        fn input_schema(&self) -> Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            Ok(Vec::new())
        }
    }

    #[cfg(feature = "opencode-plugin-host")]
    struct PluginTestTool {
        name: String,
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[async_trait]
    impl Tool for PluginTestTool {
        fn name(&self) -> &str {
            &self.name
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("plugin test tool".to_string())
        }

        fn short_description(&self) -> String {
            "plugin test tool".to_string()
        }

        fn input_schema(&self) -> Value {
            serde_json::json!({ "type": "object" })
        }

        fn dynamic_provider_id(&self) -> Option<&str> {
            Some("opencode-plugin")
        }

        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            Ok(Vec::new())
        }
    }

    #[cfg(feature = "opencode-plugin-host")]
    fn local_tool_context(workspace_root: &Path, runtime_agent_key: &str) -> ToolUseContext {
        crate::agentic::tools::tool_context_runtime::build_tool_description_context(
            runtime_agent_key,
            Some(&crate::agentic::WorkspaceBinding::new(
                Some("test-workspace".into()),
                workspace_root.to_path_buf(),
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

    fn candidate(
        id: &str,
        kind: ExternalToolConflictCandidateKind,
    ) -> ExternalToolConflictCandidate {
        ExternalToolConflictCandidate {
            candidate_id: id.to_string(),
            display_name: id.to_string(),
            kind,
            provider_id: id.to_string(),
            content_version: "v1".to_string(),
            source: None,
            source_location: None,
        }
    }

    async fn seed_loaded_generation(
        manager: &ExternalToolRuntimeManager,
        runtime_target_id: &str,
        load_generation: u64,
    ) {
        manager.loaded.lock().await.insert(
            runtime_target_id.to_string(),
            LoadedTarget {
                revision: "v1".to_string(),
                load_generation,
                tools: Vec::new(),
            },
        );
    }

    #[test]
    fn unresolved_conflict_preserves_an_existing_local_tool() {
        let candidates = vec![
            candidate("builtin", ExternalToolConflictCandidateKind::BuiltIn),
            candidate("external", ExternalToolConflictCandidateKind::External),
        ];
        let (selected, route) = resolve_conflict_route_choice(
            "conflict-v1",
            &candidates,
            &BTreeSet::from(["external".to_string()]),
            true,
            &BTreeMap::new(),
        );

        assert_eq!(selected, None);
        assert_eq!(route, ConflictRouteChoice::Original);
    }

    #[test]
    fn unresolved_external_only_conflict_is_unavailable_until_the_user_chooses() {
        let candidates = vec![
            candidate("external-a", ExternalToolConflictCandidateKind::External),
            candidate("external-b", ExternalToolConflictCandidateKind::External),
        ];
        let external_ids = BTreeSet::from(["external-a".to_string(), "external-b".to_string()]);
        let (selected, route) = resolve_conflict_route_choice(
            "conflict-v1",
            &candidates,
            &external_ids,
            false,
            &BTreeMap::new(),
        );

        assert_eq!(selected, None);
        assert_eq!(route, ConflictRouteChoice::Unavailable);
    }

    #[test]
    fn conflict_choice_accepts_only_a_candidate_from_the_current_fingerprint() {
        let candidates = vec![
            candidate("builtin", ExternalToolConflictCandidateKind::BuiltIn),
            candidate("external", ExternalToolConflictCandidateKind::External),
        ];
        let external_ids = BTreeSet::from(["external".to_string()]);
        let choices = BTreeMap::from([
            ("conflict-v1".to_string(), "external".to_string()),
            ("conflict-v2".to_string(), "deleted".to_string()),
        ]);

        let (selected, route) = resolve_conflict_route_choice(
            "conflict-v1",
            &candidates,
            &external_ids,
            true,
            &choices,
        );
        assert_eq!(selected.as_deref(), Some("external"));
        assert_eq!(route, ConflictRouteChoice::External("external".to_string()));

        let (selected, route) = resolve_conflict_route_choice(
            "conflict-v2",
            &candidates,
            &external_ids,
            true,
            &choices,
        );
        assert_eq!(selected, None);
        assert_eq!(route, ConflictRouteChoice::Original);
    }

    #[test]
    fn changed_conflict_stays_unavailable_after_an_external_choice() {
        let candidates = vec![candidate(
            "registry:openbitfun.builtin:read",
            ExternalToolConflictCandidateKind::BuiltIn,
        )];
        let choices = BTreeMap::from([(
            "external_tool:domain:read:old".to_string(),
            "external:source-a".to_string(),
        )]);

        let (selected, route) = resolve_conflict_route_choice(
            "external_tool:domain:read:new",
            &candidates,
            &BTreeSet::new(),
            true,
            &choices,
        );

        assert_eq!(selected, None);
        assert_eq!(route, ConflictRouteChoice::Unavailable);
        assert!(has_tool_conflict_history(&choices, "domain", "read"));
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn live_plugin_route_is_visible_only_to_opencode_plugin_agents() {
        let workspace = std::env::current_dir().expect("absolute workspace");
        let tool_name = "plugin_agent_scope_contract".to_string();
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let plugin: Arc<dyn Tool> = Arc::new(PluginTestTool {
            name: tool_name.clone(),
        });
        let mux = ExternalToolMux::new(tool_name, Some(original.clone()));
        mux.set_route(
            workspace_route_key(Some("test-workspace")),
            WorkspaceRoute::Live {
                tool: plugin.clone(),
                native_agent_visible: false,
                conflict: None,
            },
        );
        let router = ExternalToolRouter::default();
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(mux.name.clone(), Arc::new(mux));

        let plugin_context = local_tool_context(
            &workspace,
            "external_subagent_runtime:opencode-plugin:generation-agent",
        );
        assert!(Arc::ptr_eq(
            &router
                .resolve_registered_tool_for_context(original.clone(), &plugin_context)
                .expect("plugin route"),
            &plugin
        ));

        for runtime_agent_key in [
            "Standard",
            "Plan",
            "external_subagent_runtime:other-provider:agent",
            "external_subagent_runtime:opencode:agent",
        ] {
            let context = local_tool_context(&workspace, runtime_agent_key);
            assert!(Arc::ptr_eq(
                &router
                    .resolve_registered_tool_for_context(original.clone(), &context)
                    .expect("native fallback"),
                &original
            ));
        }
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn plugin_only_live_route_is_visible_to_native_agents() {
        let workspace = std::env::current_dir().expect("absolute workspace");
        let tool_name = "plugin_only_native_scope_contract".to_string();
        let plugin: Arc<dyn Tool> = Arc::new(PluginTestTool {
            name: tool_name.clone(),
        });
        let mux = Arc::new(ExternalToolMux::new(tool_name, None));
        mux.set_route(
            workspace_route_key(Some("test-workspace")),
            WorkspaceRoute::Live {
                tool: plugin.clone(),
                native_agent_visible: true,
                conflict: None,
            },
        );
        let router = ExternalToolRouter::default();
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(mux.name.clone(), mux.clone());
        let registered: Arc<dyn Tool> = mux;

        let context = local_tool_context(&workspace, "Standard");
        assert!(Arc::ptr_eq(
            &router
                .resolve_registered_tool_for_context(registered, &context)
                .expect("plugin-only route"),
            &plugin
        ));
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[test]
    fn selected_tool_only_plugin_route_overrides_native_tool() {
        let workspace = std::env::current_dir().expect("absolute workspace");
        let tool_name = "selected_plugin_tool_only_conflict_contract".to_string();
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let plugin: Arc<dyn Tool> = Arc::new(PluginTestTool {
            name: tool_name.clone(),
        });
        let mux = ExternalToolMux::new(tool_name, Some(original.clone()));
        mux.set_route(
            workspace_route_key(Some("test-workspace")),
            WorkspaceRoute::Live {
                tool: plugin.clone(),
                native_agent_visible: true,
                conflict: None,
            },
        );
        let router = ExternalToolRouter::default();
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(mux.name.clone(), Arc::new(mux));

        let context = local_tool_context(&workspace, "Standard");
        assert!(Arc::ptr_eq(
            &router
                .resolve_registered_tool_for_context(original, &context)
                .expect("selected plugin route"),
            &plugin
        ));
    }

    #[cfg(feature = "opencode-plugin-host")]
    #[tokio::test]
    async fn initial_tool_only_plugin_collision_keeps_native_tool() {
        let workspace = std::env::current_dir().expect("absolute workspace");
        let workspace_key = workspace_route_key(Some("test-workspace"));
        let tool_name = "initial_plugin_tool_only_conflict_contract".to_string();
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let plugin: Arc<dyn Tool> = Arc::new(PluginTestTool {
            name: tool_name.clone(),
        });
        let mux = Arc::new(ExternalToolMux::new(
            tool_name.clone(),
            Some(original.clone()),
        ));
        let router = ExternalToolRouter::default();
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(tool_name.clone(), mux.clone());

        router
            .apply_initial_live_candidate_route(&workspace_key, &tool_name, plugin, true)
            .await;

        assert!(matches!(
            router.workspace_routes(&workspace_key).get(&tool_name),
            Some(WorkspaceRoute::Original { conflict: None })
        ));
        let context = local_tool_context(&workspace, "Standard");
        assert!(Arc::ptr_eq(
            &mux.selected(Some(&context)).expect("native route"),
            &original
        ));
    }

    #[tokio::test]
    async fn concurrent_workspace_routes_install_one_shared_mux() {
        let router = Arc::new(ExternalToolRouter::default());
        let tool_name = "external_router_concurrent_install_contract".to_string();
        let route = || {
            BTreeMap::from([(
                tool_name.clone(),
                WorkspaceRoute::Unavailable { conflict: None },
            )])
        };
        tokio::join!(
            router.apply_routes("workspace-a", route()),
            router.apply_routes("workspace-b", route())
        );

        let mux = router
            .muxes
            .lock()
            .expect("router lock")
            .get(&tool_name)
            .cloned()
            .expect("shared mux");
        assert_eq!(mux.route_count(), 2);
        assert!(mux.original().is_none(), "a mux was nested as the original");

        router.apply_routes("workspace-a", BTreeMap::new()).await;
        router.apply_routes("workspace-b", BTreeMap::new()).await;
        router.muxes.lock().expect("router lock").remove(&tool_name);
        get_global_tool_registry()
            .write()
            .await
            .unregister_tool(&tool_name);
    }

    #[tokio::test]
    async fn live_plugin_conflict_preserves_builtin_until_selected() {
        use openbitfun_product_domains::external_sources::{
            ExecutionDomainId, ExternalMcpRevisionKey, ExternalSourceContext,
        };

        let directory = tempfile::tempdir().expect("temporary workspace");
        let workspace_key = workspace_route_key(Some("test-workspace"));
        let tool_name = format!("live_plugin_conflict_{}", std::process::id());
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        get_global_tool_registry()
            .write()
            .await
            .register_tool_without_external_source_notification(original.clone());
        let live: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let candidate_id = format!("external:live:opencode-plugin:{tool_name}");
        let control_plane = Arc::new(
            ExternalSourceControlPlane::new(
                ExternalSourceContext {
                    workspace_root: Some(directory.path().to_path_buf()),
                    execution_domain_id: ExecutionDomainId::new("test-domain").unwrap(),
                },
                ExternalMcpRevisionKey::new([3; 32]),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .unwrap(),
        );
        router().register_live_candidate(
            &workspace_key,
            live.clone(),
            "opencode-plugin",
            "plugin-v1".to_string(),
            true,
        );
        let empty_ecosystems = BTreeSet::new();
        let empty_strings = BTreeSet::new();
        let empty_map = BTreeMap::new();

        let unresolved = reconcile_external_tools(
            Some("test-workspace"),
            "test-domain",
            &control_plane,
            ExternalToolDecisions {
                active_ecosystems: &empty_ecosystems,
                approved_targets: &empty_strings,
                declined_decisions_by_approval: &empty_map,
                conflict_choices: &empty_map,
            },
            &empty_strings,
        )
        .await;
        assert_eq!(unresolved.conflicts.len(), 1);
        assert!(unresolved.conflicts[0]
            .candidates
            .iter()
            .any(|candidate| candidate.candidate_id == candidate_id));
        let mux = router()
            .muxes
            .lock()
            .expect("router lock")
            .get(&tool_name)
            .cloned()
            .expect("installed mux");
        assert!(Arc::ptr_eq(
            &mux.selected_for_workspace(Some("test-workspace")).unwrap(),
            &original
        ));

        let choices =
            BTreeMap::from([(unresolved.conflicts[0].conflict_key.clone(), candidate_id)]);
        let selected = reconcile_external_tools(
            Some("test-workspace"),
            "test-domain",
            &control_plane,
            ExternalToolDecisions {
                active_ecosystems: &empty_ecosystems,
                approved_targets: &empty_strings,
                declined_decisions_by_approval: &empty_map,
                conflict_choices: &choices,
            },
            &empty_strings,
        )
        .await;
        assert_eq!(
            selected.conflicts[0].selected_candidate_id,
            Some(format!("external:live:opencode-plugin:{tool_name}"))
        );
        assert!(Arc::ptr_eq(
            &mux.selected_for_workspace(Some("test-workspace")).unwrap(),
            &live
        ));

        router().unregister_live_candidate(&workspace_key, &tool_name, "opencode-plugin");
        let withdrawn = reconcile_external_tools(
            Some("test-workspace"),
            "test-domain",
            &control_plane,
            ExternalToolDecisions {
                active_ecosystems: &empty_ecosystems,
                approved_targets: &empty_strings,
                declined_decisions_by_approval: &empty_map,
                conflict_choices: &choices,
            },
            &empty_strings,
        )
        .await;
        assert_eq!(withdrawn.conflicts.len(), 1);
        assert_eq!(withdrawn.conflicts[0].selected_candidate_id, None);
        assert!(mux.selected_for_workspace(Some("test-workspace")).is_none());

        router().apply_routes(&workspace_key, BTreeMap::new()).await;
        router()
            .muxes
            .lock()
            .expect("router lock")
            .remove(&tool_name);
        get_global_tool_registry()
            .write()
            .await
            .unregister_tool(&tool_name);
    }

    #[tokio::test]
    async fn late_local_registration_pauses_an_active_live_plugin_route() {
        let router = ExternalToolRouter::default();
        let tool_name = "late_local_plugin_conflict".to_string();
        let live: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let mux = Arc::new(ExternalToolMux::new(tool_name.clone(), None));
        mux.set_route(
            "workspace".to_string(),
            WorkspaceRoute::Live {
                tool: live,
                native_agent_visible: true,
                conflict: None,
            },
        );
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(tool_name.clone(), mux.clone());

        let local: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let routed = router.intercept_registration(local.clone());

        let expected_mux: Arc<dyn Tool> = mux;
        assert!(Arc::ptr_eq(&routed, &expected_mux));
        assert!(Arc::ptr_eq(
            &router
                .original_tool(&tool_name)
                .await
                .expect("local candidate"),
            &local
        ));
        assert!(matches!(
            router.workspace_routes("workspace").get(&tool_name),
            Some(WorkspaceRoute::Original { conflict: None })
        ));
    }

    #[tokio::test]
    async fn late_live_registration_pauses_an_active_external_route() {
        let router = ExternalToolRouter::default();
        let tool_name = "late_plugin_external_conflict".to_string();
        let external = Arc::new(LoadedExternalTool {
            descriptor: ScriptToolDescriptor {
                export_name: "run".to_string(),
                name: tool_name.clone(),
                description: "external".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            },
            ecosystem_id: "test".to_string(),
            provider_id: "test-provider".to_string(),
            runtime_target_id: "target".to_string(),
            load_generation: 1,
            revision: "v1".to_string(),
            approval_key: "approval".to_string(),
            source_preference_key: "test:source".to_string(),
            workspace_key: "workspace".to_string(),
            target_tool_names: Arc::new(vec![tool_name.clone()]),
            worktree_root: None,
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
        });
        let mux = Arc::new(ExternalToolMux::new(tool_name.clone(), None));
        mux.set_route(
            "workspace".to_string(),
            WorkspaceRoute::External {
                tool: external,
                conflict: None,
            },
        );
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(tool_name.clone(), mux);

        let live: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        router
            .apply_initial_live_candidate_route("workspace", &tool_name, live, true)
            .await;

        assert!(matches!(
            router.workspace_routes("workspace").get(&tool_name),
            Some(WorkspaceRoute::Unavailable { conflict: None })
        ));
    }

    #[tokio::test]
    async fn last_route_removal_keeps_concurrent_registration_behind_the_mux() {
        let tool_name = "external_router_last_route_registration_contract".to_string();
        let workspace_key = "external-router-last-route-workspace";
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        get_global_tool_registry()
            .write()
            .await
            .register_tool_without_external_source_notification(original);
        router()
            .apply_routes(
                workspace_key,
                BTreeMap::from([(
                    tool_name.clone(),
                    WorkspaceRoute::Unavailable { conflict: None },
                )]),
            )
            .await;

        let replacement: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let replacement_for_registration = replacement.clone();
        let start = Arc::new(tokio::sync::Barrier::new(3));
        let removal_start = start.clone();
        let removal = tokio::spawn(async move {
            removal_start.wait().await;
            router().apply_routes(workspace_key, BTreeMap::new()).await;
        });
        let registration_start = start.clone();
        let registration = tokio::spawn(async move {
            registration_start.wait().await;
            get_global_tool_registry()
                .write()
                .await
                .register_tool(replacement_for_registration);
        });
        start.wait().await;
        removal.await.expect("route removal task");
        registration.await.expect("tool registration task");

        let mux = router()
            .muxes
            .lock()
            .expect("router lock")
            .get(&tool_name)
            .cloned()
            .expect("zero-route mux remains installed");
        let registered = get_global_tool_registry()
            .read()
            .await
            .get_tool(&tool_name)
            .expect("registered mux");
        let routed: Arc<dyn Tool> = mux.clone();
        assert!(Arc::ptr_eq(&registered, &routed));
        assert!(Arc::ptr_eq(
            &mux.original().expect("replacement original"),
            &replacement
        ));

        router()
            .muxes
            .lock()
            .expect("router lock")
            .remove(&tool_name);
        get_global_tool_registry()
            .write()
            .await
            .unregister_tool(&tool_name);
    }

    #[tokio::test]
    async fn worker_loss_withdraws_the_external_route_without_falling_back() {
        let router = ExternalToolRouter::default();
        let tool_name = "external_worker_loss_route_contract".to_string();
        let workspace_key = "worker-loss-workspace";
        let runtime_target_id = "worker-loss-target";
        let tool = Arc::new(LoadedExternalTool {
            descriptor: ScriptToolDescriptor {
                export_name: "run".to_string(),
                name: tool_name.clone(),
                description: "test".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            },
            ecosystem_id: "test".to_string(),
            provider_id: "test-provider".to_string(),
            runtime_target_id: runtime_target_id.to_string(),
            load_generation: 7,
            revision: "v1".to_string(),
            approval_key: "approval".to_string(),
            source_preference_key: "test:source".to_string(),
            workspace_key: workspace_key.to_string(),
            target_tool_names: Arc::new(vec![tool_name.clone()]),
            worktree_root: None,
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
        });
        let mux = Arc::new(ExternalToolMux::new(tool_name.clone(), None));
        mux.set_route(
            workspace_key.to_string(),
            WorkspaceRoute::External {
                tool,
                conflict: None,
            },
        );
        router
            .muxes
            .lock()
            .expect("router lock")
            .insert(tool_name.clone(), mux.clone());

        router
            .withdraw_failed_target(workspace_key, runtime_target_id, 7, &[tool_name.clone()])
            .await;

        assert!(matches!(
            router.workspace_routes(workspace_key).get(&tool_name),
            Some(WorkspaceRoute::Unavailable { .. })
        ));

        let replacement = Arc::new(LoadedExternalTool {
            descriptor: ScriptToolDescriptor {
                export_name: "run".to_string(),
                name: tool_name.clone(),
                description: "replacement".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            },
            ecosystem_id: "test".to_string(),
            provider_id: "test-provider".to_string(),
            runtime_target_id: runtime_target_id.to_string(),
            load_generation: 8,
            revision: "v1".to_string(),
            approval_key: "approval".to_string(),
            source_preference_key: "test:source".to_string(),
            workspace_key: workspace_key.to_string(),
            target_tool_names: Arc::new(vec![tool_name.clone()]),
            worktree_root: None,
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
        });
        mux.set_route(
            workspace_key.to_string(),
            WorkspaceRoute::External {
                tool: replacement,
                conflict: None,
            },
        );
        router
            .withdraw_failed_target(workspace_key, runtime_target_id, 7, &[tool_name.clone()])
            .await;
        assert!(matches!(
            router.workspace_routes(workspace_key).get(&tool_name),
            Some(WorkspaceRoute::External { tool, .. }) if tool.load_generation == 8
        ));
    }

    #[test]
    fn source_removal_quiesces_a_selected_external_conflict_without_original_fallback() {
        let tool_name = "removed_external_conflict_contract".to_string();
        let tool = Arc::new(LoadedExternalTool {
            descriptor: ScriptToolDescriptor {
                export_name: "run".to_string(),
                name: tool_name.clone(),
                description: "test".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            },
            ecosystem_id: "test".to_string(),
            provider_id: "test-provider".to_string(),
            runtime_target_id: "target".to_string(),
            load_generation: 8,
            revision: "v1".to_string(),
            approval_key: "approval".to_string(),
            source_preference_key: "test:source".to_string(),
            workspace_key: "workspace".to_string(),
            target_tool_names: Arc::new(vec![tool_name.clone()]),
            worktree_root: None,
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
        });
        let expectation = ConflictExpectation {
            key: "external_tool:domain:removed_external_conflict_contract:v1".to_string(),
            selected_candidate_id: Some("external:target".to_string()),
        };
        let mut routes = BTreeMap::from([(
            tool_name.clone(),
            WorkspaceRoute::External {
                tool,
                conflict: Some(expectation),
            },
        )]);

        retain_fail_closed_routes_during_reconcile(&mut routes, &BTreeSet::new());

        assert!(matches!(
            routes.get(&tool_name),
            Some(WorkspaceRoute::Unavailable { conflict: Some(_) })
        ));
    }

    #[tokio::test]
    async fn remote_same_path_call_uses_original_instead_of_the_local_external_route() {
        use crate::agentic::tools::restrictions::ToolRuntimeRestrictions;
        use crate::agentic::WorkspaceBinding;
        use std::collections::HashMap;

        let root = std::env::current_dir().expect("absolute test root");
        let tool_name = "remote_same_path_external_route_contract".to_string();
        let original: Arc<dyn Tool> = Arc::new(TestTool {
            name: tool_name.clone(),
        });
        let external = Arc::new(LoadedExternalTool {
            descriptor: ScriptToolDescriptor {
                export_name: "run".to_string(),
                name: tool_name.clone(),
                description: "external".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            },
            ecosystem_id: "test".to_string(),
            provider_id: "test-provider".to_string(),
            runtime_target_id: "not-loaded".to_string(),
            load_generation: 9,
            revision: "v1".to_string(),
            approval_key: "approval".to_string(),
            source_preference_key: "test:source".to_string(),
            workspace_key: workspace_route_key(Some("test-workspace")),
            target_tool_names: Arc::new(vec![tool_name.clone()]),
            worktree_root: None,
            runtime: Arc::new(NodeScriptToolRuntime::discover()),
        });
        assert!(!external.manages_own_execution_timeout());
        let mux = ExternalToolMux::new(tool_name, Some(original));
        assert!(!mux.manages_own_execution_timeout());
        mux.set_route(
            workspace_route_key(Some("test-workspace")),
            WorkspaceRoute::External {
                tool: external,
                conflict: None,
            },
        );
        let session_identity =
            crate::service::remote_ssh::workspace_state::workspace_session_identity(
                root.to_string_lossy().as_ref(),
                Some("remote-connection"),
                Some("remote.example"),
            )
            .expect("remote session identity");
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new_remote(
                None,
                root,
                "remote-connection".to_string(),
                "Remote".to_string(),
                session_identity,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };

        assert!(!mux
            .selected(Some(&context))
            .expect("remote original")
            .manages_own_execution_timeout());
        assert!(mux.call(&serde_json::json!({}), &context).await.is_ok());
    }

    #[tokio::test]
    async fn worker_loss_allows_exactly_one_catalog_recovery_attempt() {
        let manager = ExternalToolRuntimeManager::default();
        seed_loaded_generation(&manager, "worker-loss-target", 10).await;
        assert!(
            manager
                .mark_worker_lost(
                    "worker-loss-workspace",
                    "worker-loss-target",
                    10,
                    "worker exited",
                )
                .await
        );

        assert!(
            manager
                .workspace_requires_recovery("worker-loss-workspace")
                .await
        );
        let claimed = manager
            .begin_workspace_recovery("worker-loss-workspace")
            .await;
        assert_eq!(claimed, BTreeSet::from(["worker-loss-target".to_string()]));
        assert!(
            !manager
                .workspace_requires_recovery("worker-loss-workspace")
                .await
        );
        assert!(manager
            .begin_workspace_recovery("worker-loss-workspace")
            .await
            .is_empty());
        let attempted = manager
            .lost_status("worker-loss-target", &BTreeSet::new())
            .await
            .expect("loss remains fail-closed after the automatic budget is consumed");
        assert_eq!(attempted.recovery_state, WorkerRecoveryState::Attempted);
        assert!(
            !manager
                .mark_worker_lost(
                    "worker-loss-workspace",
                    "worker-loss-target",
                    10,
                    "duplicate exit report",
                )
                .await
        );
        assert!(
            !manager
                .workspace_requires_recovery("worker-loss-workspace")
                .await
        );

        manager
            .reset_workspace_recovery_budget("worker-loss-workspace")
            .await;
        assert!(
            manager
                .workspace_requires_recovery("worker-loss-workspace")
                .await
        );
        assert_eq!(
            manager
                .begin_workspace_recovery("worker-loss-workspace")
                .await,
            BTreeSet::from(["worker-loss-target".to_string()])
        );
    }

    #[tokio::test]
    async fn concurrent_catalog_recovery_claims_a_lost_target_once() {
        let manager = Arc::new(ExternalToolRuntimeManager::default());
        seed_loaded_generation(&manager, "worker-loss-target", 11).await;
        assert!(
            manager
                .mark_worker_lost("worker-loss-workspace", "worker-loss-target", 11, "exited",)
                .await
        );
        let claims = futures::future::join_all((0..8).map(|_| {
            let manager = Arc::clone(&manager);
            async move {
                manager
                    .begin_workspace_recovery("worker-loss-workspace")
                    .await
            }
        }))
        .await;

        assert_eq!(claims.iter().filter(|claim| !claim.is_empty()).count(), 1);
        assert_eq!(
            claims.into_iter().flatten().collect::<Vec<_>>(),
            vec!["worker-loss-target".to_string()]
        );
    }

    #[tokio::test]
    async fn stale_generation_exit_cannot_withdraw_or_mark_a_reloaded_target() {
        let manager = ExternalToolRuntimeManager::default();
        seed_loaded_generation(&manager, "reloaded-target", 22).await;

        assert!(
            !manager
                .mark_worker_lost("workspace", "reloaded-target", 21, "old worker exited")
                .await
        );
        assert_eq!(
            manager
                .loaded
                .lock()
                .await
                .get("reloaded-target")
                .map(|target| target.load_generation),
            Some(22)
        );
        assert!(manager.lost_targets.lock().await.is_empty());
    }
}
