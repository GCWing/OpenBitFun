//! Core-owned runtime bindings for `ToolUseContext`.
//!
//! This module intentionally keeps service handles, workspace runtime lookup,
//! path enforcement, cancellation/post-call hooks, and checkpoint recording in
//! core. Provider-neutral context projection and custom-data materialization are
//! owned by `tool-runtime` while the runtime owner type stays here.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::deep_review::tool_context;
use crate::agentic::session::EvidenceLedgerCheckpoint;
use crate::agentic::tools::computer_use_host::ComputerUseHostRef;
use crate::agentic::tools::framework::{
    build_tool_path_policy_denial_message, build_tool_runtime_artifact_reference,
    build_tool_session_runtime_artifact_reference, is_tool_path_allowed_by_resolved_roots,
    resolve_tool_path_with_context, tool_path_is_effectively_absolute, Tool, ToolPathBackend,
    ToolPathResolution, ToolResult,
};
use crate::agentic::tools::pipeline::{ToolExecutionContext, ToolTask};
use crate::agentic::tools::post_call_hooks;
use crate::agentic::tools::restrictions::{
    is_local_path_within_root, is_remote_posix_path_within_root, ToolPathOperation,
};
use crate::agentic::tools::workspace_paths::{
    build_openbitfun_runtime_uri, is_openbitfun_tool_uri, normalize_runtime_relative_path,
};
use crate::agentic::tools::ToolRuntimeRestrictions;
use crate::agentic::workspace::WorkspaceServices;
use crate::agentic::WorkspaceBinding;
use crate::infrastructure::get_path_manager_arc;
#[cfg(feature = "git")]
use crate::service::git::{GitDiffParams, GitService};
use crate::service::remote_ssh::workspace_state::remote_workspace_runtime_root;
use crate::service::{get_workspace_runtime_service_arc, WorkspaceRuntimeContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
#[cfg(feature = "git")]
use log::warn;
#[cfg(feature = "git")]
use openbitfun_agent_runtime::checkpoint::GitStatusCheckpointFacts;
use openbitfun_agent_runtime::checkpoint::{
    build_light_checkpoint as build_runtime_light_checkpoint, LightCheckpointWorkspaceFacts,
};
use openbitfun_agent_runtime::permission::{
    AUTO_APPROVE_ASK_CONTEXT_KEY, PERMISSION_MODE_CONTEXT_KEY,
};
use openbitfun_agent_runtime::remote_file_delivery::TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY;
use openbitfun_agent_runtime::user_questions::{
    UserQuestionController, USER_INPUT_AVAILABLE_CONTEXT_KEY, USER_INPUT_MODEL_ROUND_CONTEXT_KEY,
    USER_INPUT_PARENT_CONTEXT_KEY,
};
use openbitfun_agent_tools::{
    LoadedDeferredToolSpec, PortableToolContextProvider, ToolContextFacts, ToolWorkspaceKind,
};
#[cfg(feature = "canvas-runtime")]
use openbitfun_product_domains::canvas::CanvasStoragePort;
use openbitfun_runtime_ports::{
    DelegationPolicy, PermissionMode, RemoteExecPort, TerminalPort, ToolRuntimeHandles,
};
#[cfg(feature = "canvas-runtime")]
use openbitfun_services_integrations::canvas::CanvasService;
use serde_json::Value;
#[cfg(feature = "git")]
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tool_runtime::context::{
    build_tool_runtime_custom_data, delegation_policy_from_custom_data, project_tool_context_facts,
    PrimaryModelFacts, ToolRuntimeContextFactsInput, ToolRuntimeCustomDataInput,
};

/// Core-owned tool use context.
#[derive(Debug, Clone)]
pub struct ToolUseContext {
    pub tool_call_id: Option<String>,
    pub agent_type: Option<String>,
    pub session_id: Option<String>,
    pub dialog_turn_id: Option<String>,
    pub workspace: Option<WorkspaceBinding>,
    pub loaded_deferred_tool_specs: Vec<LoadedDeferredToolSpec>,
    pub primary_model_facts: PrimaryModelFacts,
    /// Extended context data passed from execution layer to tools.
    pub custom_data: HashMap<String, Value>,
    /// Desktop automation (Computer use); only set in OpenBitFun desktop.
    pub computer_use_host: Option<crate::agentic::tools::computer_use_host::ComputerUseHostRef>,
    pub runtime_tool_restrictions: ToolRuntimeRestrictions,
    /// Runtime handles such as workspace I/O services and cancellation.
    pub runtime_handles: ToolRuntimeHandles,
}

impl ToolUseContext {
    pub(crate) fn delegation_policy(&self) -> DelegationPolicy {
        delegation_policy_from_custom_data(&self.custom_data)
    }

    pub fn workspace_id(&self) -> Option<&str> {
        self.workspace
            .as_ref()
            .and_then(|workspace| workspace.workspace_id.as_deref())
    }

    pub fn workspace_root(&self) -> Option<&Path> {
        self.workspace.as_ref().map(|binding| binding.root_path())
    }

    /// Main project root used by project-scoped orchestration tools. File and
    /// command tools must continue to use [`Self::workspace_root`].
    pub fn project_workspace_root(&self) -> Option<&Path> {
        self.workspace
            .as_ref()
            .map(|binding| binding.project_root_path())
    }

    pub fn is_remote(&self) -> bool {
        self.workspace
            .as_ref()
            .map(|ws| ws.is_remote())
            .unwrap_or(false)
    }

    pub fn to_tool_context_facts(&self) -> ToolContextFacts {
        let workspace_kind = self.workspace.as_ref().map(|workspace| {
            if workspace.is_remote() {
                ToolWorkspaceKind::Remote
            } else {
                ToolWorkspaceKind::Local
            }
        });

        project_tool_context_facts(ToolRuntimeContextFactsInput {
            tool_call_id: self.tool_call_id.clone(),
            agent_type: self.agent_type.clone(),
            session_id: self.session_id.clone(),
            dialog_turn_id: self.dialog_turn_id.clone(),
            workspace_kind,
            workspace_root: self.workspace.as_ref().map(|workspace| {
                workspace
                    .session_identity
                    .logical_workspace_path()
                    .to_string()
            }),
            runtime_tool_restrictions: self.runtime_tool_restrictions.clone(),
        })
    }

    /// Whether the session primary model accepts image inputs (from tool-definition / pipeline context).
    /// Defaults to **true** when unset (e.g. API listings without model metadata).
    pub fn primary_model_supports_image_understanding(&self) -> bool {
        self.primary_model_facts.supports_image_inputs
    }

    pub fn primary_model_facts(&self) -> &PrimaryModelFacts {
        &self.primary_model_facts
    }

    pub fn cancellation_token(&self) -> Option<&CancellationToken> {
        self.runtime_handles.cancellation_token()
    }

    pub fn round_injection_preemption_token(&self) -> Option<&CancellationToken> {
        self.runtime_handles.round_injection_preemption_token()
    }

    pub fn workspace_services(&self) -> Option<&WorkspaceServices> {
        self.runtime_handles.workspace_services()
    }

    pub fn terminal_port(&self) -> Option<&Arc<dyn TerminalPort>> {
        self.runtime_handles.terminal_port()
    }

    pub fn remote_exec_port(&self) -> Option<&Arc<dyn RemoteExecPort>> {
        self.runtime_handles.remote_exec_port()
    }

    #[cfg(feature = "canvas-runtime")]
    pub fn canvas_storage(&self) -> Option<Arc<dyn CanvasStoragePort>> {
        canvas_storage_for_workspace(self.workspace.as_ref())
    }

    pub fn for_tool_listing(
        workspace: Option<WorkspaceBinding>,
        workspace_services: Option<WorkspaceServices>,
    ) -> Self {
        Self::for_tool_listing_with_remote_exec_port(workspace, workspace_services, None)
    }

    pub fn for_tool_listing_with_remote_exec_port(
        workspace: Option<WorkspaceBinding>,
        workspace_services: Option<WorkspaceServices>,
        remote_exec_port: Option<Arc<dyn RemoteExecPort>>,
    ) -> Self {
        Self {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: core_tool_runtime_handles(
                workspace_services,
                None,
                None,
                None,
                remote_exec_port,
            ),
        }
    }
}

impl PortableToolContextProvider for ToolUseContext {
    fn tool_context_facts(&self) -> ToolContextFacts {
        self.to_tool_context_facts()
    }
}

pub(crate) async fn call_with_tool_runtime_hooks(
    tool_name: &str,
    input: &Value,
    context: &ToolUseContext,
    call_impl: impl Future<Output = OpenBitFunResult<Vec<ToolResult>>>,
) -> OpenBitFunResult<Vec<ToolResult>> {
    let result = if let Some(cancellation_token) = context.cancellation_token() {
        tokio::select! {
            result = call_impl => {
                result
            }

            _ = cancellation_token.cancelled() => {
                Err(OpenBitFunError::Cancelled("Tool execution cancelled".to_string()))
            }
        }
    } else {
        call_impl.await
    };

    if result.is_ok() {
        post_call_hooks::record_successful_tool_call(tool_name, input, context).await;
    }

    result
}

pub(crate) async fn call_tool_with_runtime_hooks<T: Tool + ?Sized>(
    tool: &T,
    input: &Value,
    context: &ToolUseContext,
) -> OpenBitFunResult<Vec<ToolResult>> {
    call_with_tool_runtime_hooks(tool.name(), input, context, tool.call_impl(input, context)).await
}

pub(crate) fn build_tool_use_context_for_task(
    task: &ToolTask,
    computer_use_host: Option<ComputerUseHostRef>,
    cancellation_token: CancellationToken,
) -> ToolUseContext {
    build_tool_use_context_for_execution_context(
        &task.context,
        Some(task.tool_call.tool_id.clone()),
        computer_use_host,
        cancellation_token,
        task.round_injection_preemption_token.clone(),
    )
}

pub(crate) fn build_tool_use_context_for_execution_context(
    context: &ToolExecutionContext,
    tool_call_id: Option<String>,
    computer_use_host: Option<ComputerUseHostRef>,
    cancellation_token: CancellationToken,
    round_injection_preemption_token: Option<CancellationToken>,
) -> ToolUseContext {
    ToolUseContext {
        tool_call_id,
        agent_type: Some(context.agent_type.clone()),
        session_id: Some(context.session_id.clone()),
        dialog_turn_id: Some(context.dialog_turn_id.clone()),
        workspace: context.workspace.clone(),
        loaded_deferred_tool_specs: context.loaded_deferred_tool_specs.clone(),
        primary_model_facts: context.primary_model_facts.clone(),
        custom_data: build_tool_context_custom_data(context),
        computer_use_host,
        runtime_handles: core_tool_runtime_handles(
            context.workspace_services.clone(),
            Some(cancellation_token),
            round_injection_preemption_token,
            context.terminal_port.clone(),
            context.remote_exec_port.clone(),
        ),
        runtime_tool_restrictions: context.runtime_tool_restrictions.clone(),
    }
}

pub(crate) fn build_tool_description_context(
    agent_type: &str,
    workspace: Option<&WorkspaceBinding>,
    workspace_services: Option<&WorkspaceServices>,
    session_id: Option<&str>,
    terminal_port: Option<&Arc<dyn TerminalPort>>,
    remote_exec_port: Option<&Arc<dyn RemoteExecPort>>,
    primary_model_facts: Option<&PrimaryModelFacts>,
    context_vars: &HashMap<String, String>,
    runtime_tool_restrictions: &ToolRuntimeRestrictions,
) -> ToolUseContext {
    let mut custom_data = HashMap::new();
    let primary_model_facts = primary_model_facts.cloned().unwrap_or_default();
    for (key, value) in context_vars {
        custom_data.insert(key.clone(), Value::String(value.clone()));
    }

    ToolUseContext {
        tool_call_id: None,
        agent_type: Some(agent_type.to_string()),
        session_id: session_id.map(str::to_string),
        dialog_turn_id: None,
        workspace: workspace.cloned(),
        loaded_deferred_tool_specs: Vec::new(),
        primary_model_facts,
        custom_data,
        computer_use_host: None,
        runtime_tool_restrictions: runtime_tool_restrictions.clone(),
        runtime_handles: core_tool_runtime_handles(
            workspace_services.cloned(),
            None,
            None,
            terminal_port.cloned(),
            remote_exec_port.cloned(),
        ),
    }
}

#[cfg(feature = "canvas-runtime")]
fn canvas_storage_for_workspace(
    workspace: Option<&WorkspaceBinding>,
) -> Option<Arc<dyn CanvasStoragePort>> {
    workspace
        .map(|workspace| Arc::new(CanvasService::persistent(workspace.session_storage_dir())) as _)
}

fn core_tool_runtime_handles(
    workspace_services: Option<WorkspaceServices>,
    cancellation_token: Option<CancellationToken>,
    round_injection_preemption_token: Option<CancellationToken>,
    terminal_port: Option<Arc<dyn TerminalPort>>,
    remote_exec_port: Option<Arc<dyn RemoteExecPort>>,
) -> ToolRuntimeHandles {
    let handles = ToolRuntimeHandles::new(workspace_services, cancellation_token)
        .with_round_injection_preemption_token(round_injection_preemption_token)
        .with_terminal_port(terminal_port)
        .with_remote_exec_port(remote_exec_port);
    #[cfg(feature = "web-tools")]
    let handles = handles
        .with_web_search_provider(Some(crate::service::web_search::global_web_search_runtime()));
    handles
}

fn build_tool_context_custom_data(context: &ToolExecutionContext) -> HashMap<String, Value> {
    let mut extension_custom_data = HashMap::new();
    // Blocking interactions retain their exact Runtime owner so a Surface
    // re-attaching after an event gap can reconstruct the request in the
    // correct model round.
    extension_custom_data.insert(
        USER_INPUT_MODEL_ROUND_CONTEXT_KEY.to_string(),
        Value::String(context.round_id.clone()),
    );
    let question_controller = context
        .subagent_parent_info
        .as_ref()
        .map(|parent| UserQuestionController {
            session_id: parent.session_id.clone(),
            dialog_turn_id: Some(parent.dialog_turn_id.clone()),
        })
        .or_else(|| {
            context
                .permission_delegation
                .as_ref()
                .map(|parent| UserQuestionController {
                    session_id: parent.parent_session_id.clone(),
                    dialog_turn_id: parent.parent_dialog_turn_id.clone(),
                })
        });
    if let Some(controller) = question_controller {
        extension_custom_data.insert(
            USER_INPUT_PARENT_CONTEXT_KEY.to_string(),
            serde_json::to_value(controller).expect("controller contains only strings"),
        );
    }
    let deep_review_parent = context.subagent_parent_info.as_ref().map(|parent_info| {
        tool_context::DeepReviewToolParentContext {
            tool_call_id: parent_info.tool_call_id.as_str(),
            session_id: parent_info.session_id.as_str(),
            dialog_turn_id: parent_info.dialog_turn_id.as_str(),
        }
    });
    tool_context::append_tool_use_context_data(
        &context.context_vars,
        deep_review_parent,
        &mut extension_custom_data,
    );
    // Preserve the turn's already-resolved permission mode for Task
    // delegation. Without this projection, Task sees only the global default
    // when it forwards permission context to a fresh subagent.
    if let Some(mode) = context
        .context_vars
        .get(PERMISSION_MODE_CONTEXT_KEY)
        .and_then(|value| PermissionMode::parse(value))
    {
        extension_custom_data.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            Value::String(mode.as_str().to_string()),
        );
    }
    for key in [
        USER_INPUT_AVAILABLE_CONTEXT_KEY,
        AUTO_APPROVE_ASK_CONTEXT_KEY,
    ] {
        let value = match context.context_vars.get(key).map(String::as_str) {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        };
        if let Some(value) = value {
            extension_custom_data.insert(key.to_string(), Value::Bool(value));
        }
    }
    build_tool_runtime_custom_data(ToolRuntimeCustomDataInput {
        context_vars: &context.context_vars,
        delegation_policy: context.delegation_policy,
        remote_file_delivery_key: TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY,
        extension_custom_data: Some(&extension_custom_data),
    })
}

impl ToolUseContext {
    /// Select IO once from the already-authorized path. Workspace tools share
    /// their algorithms; only this boundary knows whether bytes are local or
    /// supplied by the Session's SSH provider. Runtime artifact URIs continue
    /// to address controller-owned storage even in a remote Session.
    pub fn file_system_for_path(
        &self,
        resolved: &ToolPathResolution,
    ) -> OpenBitFunResult<Arc<dyn crate::agentic::workspace::WorkspaceFileSystem>> {
        match resolved.backend {
            ToolPathBackend::RemoteWorkspace if !self.is_remote() => Err(OpenBitFunError::tool(
                "Remote file access requires a remote Session workspace binding".to_string(),
            )),
            ToolPathBackend::RemoteWorkspace => self
                .workspace_services()
                .map(|services| Arc::clone(&services.fs))
                .ok_or_else(|| {
                    OpenBitFunError::tool("Remote workspace file system is unavailable".to_string())
                }),
            ToolPathBackend::Local if !self.is_remote() && !resolved.is_runtime_artifact() => {
                Ok(self
                    .workspace_services()
                    .map(|services| Arc::clone(&services.fs))
                    .unwrap_or_else(|| Arc::new(crate::agentic::workspace::LocalWorkspaceFs)))
            }
            ToolPathBackend::Local => Ok(Arc::new(crate::agentic::workspace::LocalWorkspaceFs)),
        }
    }

    pub fn ws_fs(&self) -> Option<&dyn crate::agentic::workspace::WorkspaceFileSystem> {
        self.workspace_services().map(|s| s.fs.as_ref())
    }

    pub fn ws_shell(&self) -> Option<&dyn crate::agentic::workspace::WorkspaceShell> {
        self.workspace_services().map(|s| s.shell.as_ref())
    }

    pub async fn record_light_checkpoint(
        &self,
        tool_name: &str,
        target: &str,
        touched_files: Vec<String>,
    ) -> OpenBitFunResult<()> {
        let Some(session_id) = self.session_id.as_deref() else {
            return Ok(());
        };
        let Some(turn_id) = self.dialog_turn_id.as_deref() else {
            return Ok(());
        };
        let Some(coordinator) = get_global_coordinator() else {
            return Ok(());
        };

        let checkpoint = self.build_light_checkpoint(touched_files).await;
        coordinator
            .get_session_manager()
            .record_checkpoint_created(session_id, turn_id, tool_name, target, checkpoint)
            .await?;
        Ok(())
    }

    async fn build_light_checkpoint(&self, touched_files: Vec<String>) -> EvidenceLedgerCheckpoint {
        if self.is_remote() {
            return build_runtime_light_checkpoint(
                touched_files,
                LightCheckpointWorkspaceFacts::RemoteWorkspace,
            )
            .into();
        }

        let Some(workspace_root) = self.workspace_root() else {
            return build_runtime_light_checkpoint(
                touched_files,
                LightCheckpointWorkspaceFacts::WorkspaceUnavailable,
            )
            .into();
        };

        #[cfg(feature = "git")]
        let git_status = GitService::get_status(workspace_root)
            .await
            .map(|status| GitStatusCheckpointFacts {
                current_branch: status.current_branch,
                staged_count: status.staged.len(),
                unstaged_count: status.unstaged.len(),
                untracked_count: status.untracked.len(),
            })
            .map_err(|error| error.to_string());
        #[cfg(not(feature = "git"))]
        let git_status = Err("Git capability is not compiled into this runtime".to_string());
        let diff_hash = self
            .checkpoint_diff_hash(workspace_root, &touched_files)
            .await;
        build_runtime_light_checkpoint(
            touched_files,
            LightCheckpointWorkspaceFacts::LocalWorkspace {
                git_status,
                diff_hash,
            },
        )
        .into()
    }

    async fn checkpoint_diff_hash(
        &self,
        workspace_root: &Path,
        touched_files: &[String],
    ) -> Option<String> {
        #[cfg(not(feature = "git"))]
        {
            let _ = (workspace_root, touched_files);
            return None;
        }

        #[cfg(feature = "git")]
        {
            let files = touched_files
                .iter()
                .filter_map(|file| git_relative_path(workspace_root, file))
                .collect::<Vec<_>>();

            if files.is_empty() {
                return None;
            }

            let mut diff = String::new();
            for staged in [false, true] {
                let params = GitDiffParams {
                    files: Some(files.clone()),
                    staged: Some(staged),
                    ..Default::default()
                };
                match GitService::get_diff(workspace_root, &params).await {
                    Ok(part) => diff.push_str(&part),
                    Err(error) => {
                        warn!(
                            "Failed to collect checkpoint diff hash: staged={}, error={}",
                            staged, error
                        );
                        return None;
                    }
                }
            }

            if diff.is_empty() {
                return None;
            }

            Some(hex::encode(Sha256::digest(diff.as_bytes())))
        }
    }

    pub fn enforce_tool_runtime_restrictions(&self, tool_name: &str) -> OpenBitFunResult<()> {
        self.runtime_tool_restrictions
            .ensure_tool_allowed(tool_name)
            .map_err(Into::into)
    }

    pub fn enforce_path_operation(
        &self,
        operation: ToolPathOperation,
        resolution: &ToolPathResolution,
    ) -> OpenBitFunResult<()> {
        let allowed_roots = self
            .runtime_tool_restrictions
            .path_policy
            .roots_for(operation);
        if allowed_roots.is_empty() {
            return Ok(());
        }

        let mut resolved_roots = Vec::with_capacity(allowed_roots.len());
        for root in allowed_roots {
            resolved_roots.push(self.resolve_tool_path(root)?);
        }

        let is_allowed = is_tool_path_allowed_by_resolved_roots(
            resolution,
            &resolved_roots,
            |resolution, root| -> OpenBitFunResult<bool> {
                match resolution.backend {
                    ToolPathBackend::Local => is_local_path_within_root(
                        Path::new(&resolution.resolved_path),
                        Path::new(&root.resolved_path),
                    ),
                    ToolPathBackend::RemoteWorkspace => Ok(is_remote_posix_path_within_root(
                        &resolution.resolved_path,
                        &root.resolved_path,
                    )),
                }
            },
        )?;

        if is_allowed {
            return Ok(());
        }

        Err(OpenBitFunError::validation(
            build_tool_path_policy_denial_message(
                &resolution.logical_path,
                operation,
                allowed_roots,
            ),
        ))
    }

    /// Resolve a user or model-supplied path for file/shell tools. Uses POSIX semantics when the
    /// workspace is remote SSH so Windows-hosted clients still resolve `/home/...` correctly.
    pub fn resolve_workspace_tool_path(&self, path: &str) -> OpenBitFunResult<String> {
        let workspace_root_owned = self
            .workspace
            .as_ref()
            .map(|w| w.root_path_string())
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "A workspace path is required to resolve tool path: {}",
                    path
                ))
            })?;
        let resolved_path = crate::agentic::tools::workspace_paths::resolve_workspace_tool_path(
            path,
            Some(workspace_root_owned.as_str()),
            self.is_remote(),
        )?;

        // Remote SSH workspaces stay contained to the opened project tree. Local desktop
        // sessions may use any host path the OS user can access (ExecCommand already has the
        // same reach); optional `path_policy` roots still apply via `enforce_path_operation`.
        if self.is_remote()
            && !is_remote_posix_path_within_root(&resolved_path, &workspace_root_owned)
        {
            return Err(OpenBitFunError::tool(format!(
                "Path '{}' resolves outside current workspace '{}': {}",
                path, workspace_root_owned, resolved_path
            )));
        }

        Ok(resolved_path)
    }

    pub fn current_workspace_runtime_root(&self) -> OpenBitFunResult<PathBuf> {
        #[cfg(test)]
        if let Some(path) = self
            .custom_data
            .get("__openbitfun_test_runtime_root")
            .and_then(|value| value.as_str())
            .filter(|path| !path.trim().is_empty())
        {
            return Ok(PathBuf::from(path));
        }

        let workspace = self.workspace.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "A workspace is required to resolve runtime artifacts".to_string(),
            )
        })?;

        if workspace.is_remote() {
            let identity = &workspace.session_identity;
            Ok(remote_workspace_runtime_root(
                &identity.hostname,
                identity.logical_workspace_path(),
            ))
        } else {
            Ok(get_path_manager_arc().project_runtime_root(workspace.root_path()))
        }
    }

    pub fn current_workspace_scope(&self) -> Option<String> {
        self.workspace
            .as_ref()
            .and_then(|workspace| workspace.workspace_id.clone())
    }

    pub async fn ensure_current_workspace_runtime(
        &self,
    ) -> OpenBitFunResult<WorkspaceRuntimeContext> {
        let workspace = self.workspace.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("A workspace is required to ensure runtime artifacts".to_string())
        })?;

        let runtime_service = get_workspace_runtime_service_arc();
        Ok(runtime_service
            .ensure_runtime_for_workspace_binding(workspace)
            .await?
            .context)
    }

    pub fn should_emit_runtime_uri(&self) -> bool {
        self.is_remote()
    }

    pub fn build_runtime_uri(&self, relative_path: &str) -> OpenBitFunResult<String> {
        let scope = self
            .current_workspace_scope()
            .unwrap_or_else(|| "current".to_string());
        build_openbitfun_runtime_uri(&scope, &normalize_runtime_relative_path(relative_path)?)
    }

    pub fn build_runtime_artifact_reference(
        &self,
        relative_path: &str,
    ) -> OpenBitFunResult<String> {
        let runtime_root = if self.should_emit_runtime_uri() {
            None
        } else {
            Some(self.current_workspace_runtime_root()?)
        };
        build_tool_runtime_artifact_reference(
            relative_path,
            runtime_root.as_deref(),
            self.current_workspace_scope().as_deref(),
            self.should_emit_runtime_uri(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    pub fn build_session_runtime_artifact_reference(
        &self,
        session_id: &str,
        relative_path: &str,
    ) -> OpenBitFunResult<String> {
        let runtime_root = if self.should_emit_runtime_uri() {
            None
        } else {
            Some(self.current_workspace_runtime_root()?)
        };
        build_tool_session_runtime_artifact_reference(
            session_id,
            relative_path,
            runtime_root.as_deref(),
            self.current_workspace_scope().as_deref(),
            self.should_emit_runtime_uri(),
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    pub fn current_workspace_session_dir(&self, session_id: &str) -> OpenBitFunResult<PathBuf> {
        Ok(self
            .current_workspace_runtime_root()?
            .join("sessions")
            .join(session_id))
    }

    pub fn current_workspace_session_tool_results_dir(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<PathBuf> {
        Ok(self
            .current_workspace_session_dir(session_id)?
            .join("tool-results"))
    }

    pub fn current_workspace_session_tool_result_path(
        &self,
        session_id: &str,
        file_name: &str,
    ) -> OpenBitFunResult<PathBuf> {
        Ok(self
            .current_workspace_session_tool_results_dir(session_id)?
            .join(file_name))
    }

    pub fn resolve_tool_path(&self, path: &str) -> OpenBitFunResult<ToolPathResolution> {
        if is_openbitfun_tool_uri(path) {
            let workspace_scope = self.current_workspace_scope();
            let runtime_root = if self.workspace.is_some() {
                Some(self.current_workspace_runtime_root()?)
            } else {
                None
            };
            let current_session_root = self
                .session_id
                .as_deref()
                .map(|session_id| self.current_workspace_session_dir(session_id))
                .transpose()?;
            return crate::agentic::tools::framework::resolve_tool_path_with_context_roots(
                path,
                None,
                self.is_remote(),
                workspace_scope.as_deref(),
                runtime_root,
                current_session_root,
            )
            .map_err(|error| OpenBitFunError::tool(error.to_string()));
        }

        let workspace_root_owned = self
            .workspace
            .as_ref()
            .map(|w| w.root_path_string())
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "A workspace path is required to resolve tool path: {}",
                    path
                ))
            })?;

        resolve_tool_path_with_context(
            path,
            Some(workspace_root_owned.as_str()),
            self.is_remote(),
            self.current_workspace_scope().as_deref(),
            None,
        )
        .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    /// Whether `path` is absolute for the active workspace (POSIX `/` for remote SSH).
    pub fn workspace_path_is_effectively_absolute(&self, path: &str) -> bool {
        tool_path_is_effectively_absolute(path, self.is_remote())
    }
}

#[cfg(feature = "git")]
fn git_relative_path(workspace_root: &Path, path: &str) -> Option<String> {
    if is_openbitfun_tool_uri(path) {
        return None;
    }

    let path = Path::new(path);
    let relative = if path.is_absolute() {
        path.strip_prefix(workspace_root).ok()?
    } else {
        path
    };

    Some(relative.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod context_facts_tests {
    use super::ToolUseContext;
    use crate::agentic::tools::{
        PortableToolContextProvider, ToolRuntimeRestrictions, ToolWorkspaceKind,
    };
    use crate::agentic::WorkspaceBinding;
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use openbitfun_agent_tools::LoadedDeferredToolSpec;
    use std::collections::{BTreeSet, HashMap};
    use std::path::PathBuf;
    use tool_runtime::context::PrimaryModelFacts;

    fn loaded_spec(tool_name: &str) -> LoadedDeferredToolSpec {
        LoadedDeferredToolSpec {
            tool_name: tool_name.to_string(),
            catalog_generation: 0,
        }
    }

    fn local_context(root: &str) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(None, PathBuf::from(root))),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[test]
    fn tool_context_facts_preserve_portable_fields_without_runtime_handles() {
        let context = ToolUseContext {
            tool_call_id: Some("call-1".to_string()),
            agent_type: Some("Standard".to_string()),
            session_id: Some("session-1".to_string()),
            dialog_turn_id: Some("turn-1".to_string()),
            workspace: Some(WorkspaceBinding::new(None, PathBuf::from("/repo/project"))),
            loaded_deferred_tool_specs: vec![loaded_spec("WebFetch")],
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                allowed_tool_names: BTreeSet::from(["Read".to_string()]),
                denied_tool_names: BTreeSet::from(["ExecCommand".to_string()]),
                denied_tool_messages: Default::default(),
                path_policy: Default::default(),
                miniapp_context_scope: None,
            },
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };

        let facts = context.to_tool_context_facts();

        assert_eq!(facts.tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(facts.agent_type.as_deref(), Some("Standard"));
        assert_eq!(facts.session_id.as_deref(), Some("session-1"));
        assert_eq!(facts.dialog_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(facts.workspace_kind, Some(ToolWorkspaceKind::Local));
        assert_eq!(facts.workspace_root.as_deref(), Some("/repo/project"));
        assert!(facts.runtime_tool_restrictions.is_tool_allowed("Read"));
        assert!(!facts
            .runtime_tool_restrictions
            .is_tool_allowed("ExecCommand"));

        let value = serde_json::to_value(&facts).expect("serialize context facts");
        assert!(value.get("unlockedCollapsedTools").is_none());
        assert!(value.get("computer_use_host").is_none());
        assert!(value.get("workspace_services").is_none());
        assert!(value.get("cancellation_token").is_none());
    }

    #[test]
    fn tool_context_facts_omit_runtime_owner_fields_even_when_context_is_populated() {
        let mut custom_data = HashMap::new();
        custom_data.insert(
            "checkpoint".to_string(),
            serde_json::json!({ "kind": "runtime-only" }),
        );

        let context = ToolUseContext {
            tool_call_id: Some("call-runtime".to_string()),
            agent_type: Some("Standard".to_string()),
            session_id: Some("session-runtime".to_string()),
            dialog_turn_id: Some("turn-runtime".to_string()),
            workspace: Some(WorkspaceBinding::new(None, PathBuf::from("/repo/runtime"))),
            loaded_deferred_tool_specs: vec![loaded_spec("WebFetch"), loaded_spec("Worktree")],
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data,
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                allowed_tool_names: BTreeSet::from(["Read".to_string(), "GetToolSpec".to_string()]),
                denied_tool_names: BTreeSet::from(["ExecCommand".to_string()]),
                denied_tool_messages: Default::default(),
                path_policy: Default::default(),
                miniapp_context_scope: None,
            },
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::new(
                None,
                Some(tokio_util::sync::CancellationToken::new()),
            ),
        };

        let facts = PortableToolContextProvider::tool_context_facts(&context);

        assert_eq!(facts.tool_call_id.as_deref(), Some("call-runtime"));
        assert_eq!(facts.workspace_kind, Some(ToolWorkspaceKind::Local));
        assert_eq!(facts.workspace_root.as_deref(), Some("/repo/runtime"));
        assert!(facts.runtime_tool_restrictions.is_tool_allowed("Read"));
        assert!(facts
            .runtime_tool_restrictions
            .is_tool_allowed("GetToolSpec"));
        assert!(!facts
            .runtime_tool_restrictions
            .is_tool_allowed("ExecCommand"));

        let value = serde_json::to_value(&facts).expect("serialize runtime context facts");
        for runtime_only_field in [
            "unlockedCollapsedTools",
            "customData",
            "computerUseHost",
            "cancellationToken",
            "workspaceServices",
        ] {
            assert!(
                value.get(runtime_only_field).is_none(),
                "{runtime_only_field} must remain outside portable facts"
            );
        }
    }

    #[test]
    fn tool_context_facts_use_normalized_remote_workspace_identity() {
        let session_identity = workspace_session_identity(
            "/home/wsp//projects/test/",
            Some("conn-1"),
            Some("ssh.dev"),
        )
        .expect("remote identity");
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: Some("session-remote".to_string()),
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new_remote(
                Some("workspace-remote".to_string()),
                PathBuf::from("/home/wsp//projects/test/"),
                "conn-1".to_string(),
                "Dev SSH".to_string(),
                session_identity,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };

        let facts = context.to_tool_context_facts();

        assert_eq!(facts.workspace_kind, Some(ToolWorkspaceKind::Remote));
        assert_eq!(
            facts.workspace_root.as_deref(),
            Some("/home/wsp/projects/test")
        );

        let value = serde_json::to_value(&facts).expect("serialize remote context facts");
        assert!(value.get("connectionId").is_none());
        assert!(value.get("connectionName").is_none());
        assert!(value.get("workspace_services").is_none());
    }

    #[test]
    fn tool_use_context_implements_portable_context_provider() {
        fn assert_provider<T: PortableToolContextProvider>() {}
        assert_provider::<ToolUseContext>();

        let context = local_context("/repo/project");

        let facts = PortableToolContextProvider::tool_context_facts(&context);

        assert_eq!(facts.workspace_kind, Some(ToolWorkspaceKind::Local));
        assert_eq!(facts.workspace_root.as_deref(), Some("/repo/project"));
    }
}

#[cfg(test)]
mod path_resolution_tests {
    use super::ToolUseContext;
    use crate::agentic::tools::{ToolPathOperation, ToolPathPolicy, ToolRuntimeRestrictions};
    use crate::agentic::WorkspaceBinding;
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use tool_runtime::context::PrimaryModelFacts;

    fn local_context(root: &str) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(None, PathBuf::from(root))),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    fn remote_context(root: &str, workspace_id: Option<String>) -> ToolUseContext {
        let session_identity = workspace_session_identity(root, Some("conn-1"), Some("ssh.dev"))
            .expect("remote identity");
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new_remote(
                workspace_id,
                PathBuf::from(root),
                "conn-1".to_string(),
                "Dev SSH".to_string(),
                session_identity,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_system_selection_never_reads_local_files_for_unavailable_remote_workspace() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-fs-route-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("sentinel.txt");
        std::fs::write(&file, "controller-only").unwrap();
        let path = file.to_string_lossy();
        let local = local_context(root.to_string_lossy().as_ref());
        let local_path = local.resolve_tool_path(&path).unwrap();
        assert_eq!(
            local
                .file_system_for_path(&local_path)
                .unwrap()
                .read_file(&local_path.resolved_path)
                .await
                .unwrap(),
            b"controller-only"
        );
        let remote = remote_context("/remote/workspace", None);
        let remote_path = remote.resolve_tool_path(&path).unwrap();
        let error = remote.file_system_for_path(&remote_path).err().unwrap();
        assert!(error
            .to_string()
            .contains("Remote workspace file system is unavailable"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "controller-only");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_system_selection_preserves_session_provider_and_local_artifact_boundary() {
        use std::sync::Arc;
        let mut context = remote_context("/remote/workspace", None);
        let services = crate::agentic::workspace::local_workspace_services("/unused".into());
        let provider = Arc::clone(&services.fs);
        context.runtime_handles =
            openbitfun_runtime_ports::ToolRuntimeHandles::new(Some(services), None);
        let workspace_file = context.resolve_tool_path("source.txt").unwrap();
        assert!(Arc::ptr_eq(
            &provider,
            &context.file_system_for_path(&workspace_file).unwrap()
        ));

        context.session_id = Some("route-test".into());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".into(),
            serde_json::json!(std::env::temp_dir().join("openbitfun-route-artifacts")),
        );
        let artifact = context
            .resolve_tool_path("openbitfun://current-session/artifacts/output.txt")
            .unwrap();
        assert!(!Arc::ptr_eq(
            &provider,
            &context.file_system_for_path(&artifact).unwrap()
        ));
    }

    fn context_with_restrictions(
        root: &str,
        runtime_tool_restrictions: ToolRuntimeRestrictions,
    ) -> ToolUseContext {
        ToolUseContext {
            runtime_tool_restrictions,
            ..local_context(root)
        }
    }

    fn context_without_workspace() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[test]
    fn workspace_path_resolution_allows_absolute_paths_outside_local_workspace() {
        let context = local_context("/repo/project");

        let resolved = context
            .resolve_workspace_tool_path("/tmp/pr_body.md")
            .expect("local sessions may resolve paths outside the workspace root");

        assert_eq!(PathBuf::from(resolved), PathBuf::from("/tmp/pr_body.md"));
    }

    #[test]
    fn workspace_path_resolution_rejects_absolute_paths_outside_remote_workspace() {
        let context = remote_context("/home/wsp/projects/test", None);

        let err = context
            .resolve_workspace_tool_path("/tmp/pr_body.md")
            .expect_err("remote sessions must stay within the workspace root");

        assert!(err.to_string().contains("outside current workspace"));
    }

    #[test]
    fn workspace_path_resolution_rejects_root_without_workspace() {
        let context = context_without_workspace();

        let err = context
            .resolve_workspace_tool_path("/")
            .expect_err("workspace tools must not scan the host root without a workspace");

        assert!(err.to_string().contains("workspace path is required"));
    }

    #[test]
    fn workspace_path_resolution_allows_paths_inside_local_workspace() {
        let context = local_context("/repo/project");

        let resolved = context
            .resolve_workspace_tool_path("/repo/project/src/main.rs")
            .expect("absolute paths inside the workspace remain valid");

        assert_eq!(
            PathBuf::from(resolved),
            PathBuf::from("/repo/project/src/main.rs")
        );
    }

    #[test]
    fn current_session_uri_resolves_against_local_session_runtime_root() {
        let runtime_root = PathBuf::from("/runtime/project");
        let mut context = local_context("/repo/project");
        context.session_id = Some("session-1".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            serde_json::Value::String(runtime_root.to_string_lossy().to_string()),
        );

        let resolved = context
            .resolve_tool_path(
                "openbitfun://current-session/artifacts/compression-transcripts/12-a3f9.txt",
            )
            .expect("current-session URI should resolve");

        let expected_session_root = runtime_root.join("sessions").join("session-1");
        assert_eq!(
            PathBuf::from(&resolved.resolved_path),
            expected_session_root
                .join("artifacts")
                .join("compression-transcripts")
                .join("12-a3f9.txt")
        );
        assert_eq!(
            resolved.logical_child_path(&expected_session_root.join("artifacts/other.txt")),
            Some("openbitfun://current-session/artifacts/other.txt".to_string())
        );
    }

    #[test]
    fn current_session_uri_resolves_against_remote_mirror_session_root() {
        let runtime_root = PathBuf::from("/runtime/remote-mirror");
        let mut context =
            remote_context("/home/wsp/projects/test", Some("workspace-123".to_string()));
        context.session_id = Some("session-remote".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            serde_json::Value::String(runtime_root.to_string_lossy().to_string()),
        );

        let resolved = context
            .resolve_tool_path("openbitfun://current-session/artifacts/transcript.txt")
            .expect("remote current-session URI should resolve to the local mirror");

        assert!(!resolved.uses_remote_workspace_backend());
        assert_eq!(
            PathBuf::from(resolved.resolved_path),
            runtime_root
                .join("sessions")
                .join("session-remote")
                .join("artifacts")
                .join("transcript.txt")
        );
    }

    #[test]
    fn current_session_uri_requires_session_context() {
        let runtime_root = PathBuf::from("/runtime/project");
        let mut context = local_context("/repo/project");
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            serde_json::Value::String(runtime_root.to_string_lossy().to_string()),
        );

        let err = context
            .resolve_tool_path("openbitfun://current-session/artifacts/transcript.txt")
            .expect_err("current-session URI should require a session id");

        assert!(err.to_string().contains("current session"));
    }

    #[test]
    fn remote_runtime_artifact_reference_uses_runtime_uri_scope() {
        let context = remote_context("/home/wsp/projects/test", Some("workspace-123".to_string()));

        let reference = context
            .build_runtime_artifact_reference(r"plans\demo.plan.md")
            .expect("remote runtime artifacts should use URI references");

        assert_eq!(
            reference,
            "openbitfun://runtime/workspace-123/plans/demo.plan.md"
        );
    }

    #[test]
    fn runtime_uri_resolution_rejects_different_workspace_scope() {
        let context = remote_context("/home/wsp/projects/test", Some("workspace-123".to_string()));

        let err = context
            .resolve_tool_path("openbitfun://runtime/workspace-456/plans/demo.plan.md")
            .expect_err("runtime artifact scopes must match the active workspace");

        assert!(err
            .to_string()
            .contains("does not match the current workspace"));
    }

    #[test]
    fn runtime_uri_scope_error_takes_precedence_without_workspace() {
        let context = context_without_workspace();

        let err = context
            .resolve_tool_path("openbitfun://runtime/workspace-456/plans/demo.plan.md")
            .expect_err("runtime URI scope should be validated before runtime root lookup");

        assert!(err
            .to_string()
            .contains("does not match the current workspace"));
    }

    #[test]
    fn workspace_absolute_detection_uses_remote_posix_semantics() {
        let context = remote_context("/home/wsp/projects/test", None);

        assert!(
            context.workspace_path_is_effectively_absolute("/home/wsp/projects/test/src/lib.rs")
        );
        assert!(!context.workspace_path_is_effectively_absolute("src/lib.rs"));
    }

    #[test]
    fn path_policy_allows_only_configured_local_roots() {
        let temp_root = std::env::temp_dir().join(format!(
            "openbitfun-tool-context-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let allowed_root = temp_root.join("allowed");
        std::fs::create_dir_all(&allowed_root).expect("create allowed root");
        let context = context_with_restrictions(
            temp_root.to_string_lossy().as_ref(),
            ToolRuntimeRestrictions {
                path_policy: ToolPathPolicy {
                    read_roots: vec![allowed_root.to_string_lossy().to_string()],
                    write_roots: vec![allowed_root.to_string_lossy().to_string()],
                    ..Default::default()
                },
                ..Default::default()
            },
        );

        let allowed = context
            .resolve_tool_path(&allowed_root.join("file.txt").to_string_lossy())
            .expect("allowed path should resolve");
        context
            .enforce_path_operation(ToolPathOperation::Write, &allowed)
            .expect("path within configured root should be allowed");
        context
            .enforce_path_operation(ToolPathOperation::Read, &allowed)
            .expect("read path within configured root should be allowed");

        let blocked = context
            .resolve_tool_path(&temp_root.join("blocked/file.txt").to_string_lossy())
            .expect("blocked path should still resolve before policy enforcement");
        let err = context
            .enforce_path_operation(ToolPathOperation::Write, &blocked)
            .expect_err("path outside configured root should be blocked");

        assert!(err.to_string().contains("is not allowed for write"));
        let err = context
            .enforce_path_operation(ToolPathOperation::Read, &blocked)
            .expect_err("read path outside configured root should be blocked");
        assert!(err.to_string().contains("is not allowed for read"));

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}

#[cfg(test)]
mod call_runtime_tests {
    use super::call_tool_with_runtime_hooks;
    use super::call_with_tool_runtime_hooks;
    use super::ToolUseContext;
    use crate::agentic::deep_review_policy::deep_review_shared_context_measurement_snapshot;
    use crate::agentic::tools::framework::Tool;
    use crate::agentic::tools::framework::ToolResult;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
    use async_trait::async_trait;
    use serde_json::json;
    use serde_json::Value;
    use std::collections::HashMap;
    use tokio::time::{sleep, Duration};
    use tokio_util::sync::CancellationToken;
    use tool_runtime::context::PrimaryModelFacts;

    struct MeasurementReadTool;

    #[async_trait]
    impl Tool for MeasurementReadTool {
        fn name(&self) -> &str {
            "Read"
        }

        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("Read file".to_string())
        }

        fn short_description(&self) -> String {
            "Read file".to_string()
        }

        fn input_schema(&self) -> Value {
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string" }
                }
            })
        }

        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            Ok(vec![ToolResult::ok(
                json!({ "ok": true }),
                Some("ok".to_string()),
            )])
        }
    }

    fn context_with_cancellation(cancellation_token: CancellationToken) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::new(
                None,
                Some(cancellation_token),
            ),
        }
    }

    #[tokio::test]
    async fn tool_call_runtime_hook_returns_cancelled_before_impl_completes() {
        let cancellation_token = CancellationToken::new();
        cancellation_token.cancel();
        let context = context_with_cancellation(cancellation_token);

        let result = call_with_tool_runtime_hooks("Read", &json!({}), &context, async {
            sleep(Duration::from_secs(30)).await;
            Ok(vec![ToolResult::ok(json!({ "unexpected": true }), None)])
        })
        .await;

        assert!(
            matches!(result, Err(OpenBitFunError::Cancelled(message)) if message == "Tool execution cancelled")
        );
    }

    #[tokio::test]
    async fn tool_call_runtime_hook_preserves_success_result_without_cancellation() {
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };

        let result: OpenBitFunResult<Vec<ToolResult>> =
            call_with_tool_runtime_hooks("Read", &json!({}), &context, async {
                Ok(vec![ToolResult::ok(
                    json!({ "ok": true }),
                    Some("ok".to_string()),
                )])
            })
            .await;

        let result = result.expect("tool result should pass through");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content()["ok"], true);
    }

    #[tokio::test]
    async fn call_records_deep_review_read_file_measurement_without_touching_result() {
        let parent_turn_id = format!("turn-runtime-measure-{}", uuid::Uuid::new_v4());
        let mut custom_data = HashMap::new();
        custom_data.insert(
            "deep_review_parent_dialog_turn_id".to_string(),
            json!(parent_turn_id.clone()),
        );
        custom_data.insert("deep_review_subagent_role".to_string(), json!("reviewer"));
        custom_data.insert(
            "deep_review_subagent_type".to_string(),
            json!("ReviewSecurity"),
        );
        let context = ToolUseContext {
            tool_call_id: Some("tool-read".to_string()),
            agent_type: Some("ReviewSecurity".to_string()),
            session_id: Some("subagent-session".to_string()),
            dialog_turn_id: Some("subagent-turn".to_string()),
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: PrimaryModelFacts::default(),
            custom_data,
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };
        let tool = MeasurementReadTool;

        let result = call_tool_with_runtime_hooks(
            &tool,
            &json!({ "file_path": ".\\src\\lib.rs" }),
            &context,
        )
        .await
        .expect("read tool call should succeed");
        call_tool_with_runtime_hooks(&tool, &json!({ "file_path": "src/lib.rs" }), &context)
            .await
            .expect("read tool call should succeed");

        assert_eq!(result.len(), 1);
        let snapshot = deep_review_shared_context_measurement_snapshot(&parent_turn_id);
        assert_eq!(snapshot.total_calls, 2);
        assert_eq!(snapshot.duplicate_calls, 1);
        assert_eq!(snapshot.repeated_contexts[0].tool_name, "Read");
        assert_eq!(snapshot.repeated_contexts[0].file_path, "src/lib.rs");
    }
}

#[cfg(test)]
mod context_builder_tests {
    use super::build_tool_description_context;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use std::collections::HashMap;
    use tool_runtime::context::PrimaryModelFacts;

    #[test]
    fn tool_description_context_preserves_manifest_custom_data_shape() {
        let context_vars = HashMap::new();
        let mut runtime_tool_restrictions = ToolRuntimeRestrictions::default();
        runtime_tool_restrictions
            .denied_tool_names
            .insert("Write".to_string());

        let context = build_tool_description_context(
            "coding",
            None,
            None,
            None,
            None,
            None,
            Some(&PrimaryModelFacts::new(
                "model_1",
                "vision-model",
                "anthropic",
                true,
            )),
            &context_vars,
            &runtime_tool_restrictions,
        );

        assert_eq!(context.agent_type.as_deref(), Some("coding"));
        assert!(context.tool_call_id.is_none());
        assert!(context.session_id.is_none());
        assert!(context.dialog_turn_id.is_none());
        assert!(context.workspace.is_none());
        assert!(context.loaded_deferred_tool_specs.is_empty());
        assert!(context.cancellation_token().is_none());
        assert!(context.workspace_services().is_none());
        assert!(!context.runtime_tool_restrictions.is_tool_allowed("Write"));
        assert!(context.primary_model_supports_image_understanding());
        assert_eq!(context.primary_model_facts().model_id, "model_1");
        assert_eq!(context.primary_model_facts().model_name, "vision-model");
        assert_eq!(context.primary_model_facts().api_format, "anthropic");
        assert!(!context.custom_data.contains_key("primary_model_id"));
        assert!(!context.custom_data.contains_key("primary_model_name"));
        assert!(!context.custom_data.contains_key("primary_model_provider"));
        assert!(!context
            .custom_data
            .contains_key("primary_model_supports_image_understanding"));
    }
}

#[cfg(test)]
mod task_context_tests {
    use super::build_tool_use_context_for_task;
    use crate::agentic::core::ToolCall;
    use crate::agentic::tools::pipeline::{
        SubagentParentInfo, ToolExecutionContext, ToolExecutionOptions, ToolTask,
    };
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use openbitfun_agent_runtime::permission::AUTO_APPROVE_ASK_CONTEXT_KEY;
    use openbitfun_agent_runtime::permission::PERMISSION_MODE_CONTEXT_KEY;
    use openbitfun_agent_runtime::user_questions::{
        USER_INPUT_AVAILABLE_CONTEXT_KEY, USER_INPUT_MODEL_ROUND_CONTEXT_KEY,
    };
    use openbitfun_agent_tools::LoadedDeferredToolSpec;
    use openbitfun_runtime_ports::DelegationPolicy;
    use serde_json::json;
    use std::collections::{BTreeSet, HashMap};
    use tokio_util::sync::CancellationToken;
    use tool_runtime::context::PrimaryModelFacts;

    fn loaded_spec(tool_name: &str) -> LoadedDeferredToolSpec {
        LoadedDeferredToolSpec {
            tool_name: tool_name.to_string(),
            catalog_generation: 0,
        }
    }

    fn task_with_context_vars() -> ToolTask {
        let mut context_vars = HashMap::new();
        context_vars.insert("turn_index".to_string(), "7".to_string());
        context_vars.insert("acp_transport".to_string(), "true".to_string());
        context_vars.insert(
            USER_INPUT_AVAILABLE_CONTEXT_KEY.to_string(),
            "false".to_string(),
        );
        context_vars.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            "false".to_string(),
        );
        context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            "auto_approve".to_string(),
        );
        context_vars.insert(
            "deep_review_run_manifest".to_string(),
            r#"{"run_id":"run-1"}"#.to_string(),
        );
        context_vars.insert(
            "deep_review_subagent_role".to_string(),
            "reviewer".to_string(),
        );
        context_vars.insert(
            "deep_review_subagent_type".to_string(),
            "ReviewSecurity".to_string(),
        );

        ToolTask::new(
            ToolCall {
                tool_id: "tool_context_1".to_string(),
                tool_name: "WebFetch".to_string(),
                arguments: json!({ "url": "https://example.com" }),
                raw_arguments: None,
                is_error: false,
                parse_error: None,
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            },
            ToolExecutionContext {
                session_id: "session_1".to_string(),
                dialog_turn_id: "turn_1".to_string(),
                round_id: "round_1".to_string(),
                attempt_id: None,
                attempt_index: None,
                agent_type: "agent".to_string(),
                workspace: None,
                primary_model_facts: PrimaryModelFacts::new(
                    "primary-model",
                    "vision-model",
                    "openai",
                    true,
                ),
                context_vars,
                subagent_parent_info: Some(SubagentParentInfo {
                    tool_call_id: "parent_tool".to_string(),
                    session_id: "parent_session".to_string(),
                    dialog_turn_id: "parent_turn".to_string(),
                }),
                permission_delegation: None,
                delegation_policy: DelegationPolicy::top_level().spawn_child(),
                deferred_tools: vec!["WebFetch".to_string()],
                loaded_deferred_tool_specs: vec![loaded_spec("WebFetch")],
                allowed_tools: vec!["WebFetch".to_string()],
                runtime_tool_restrictions: ToolRuntimeRestrictions {
                    allowed_tool_names: BTreeSet::from(["WebFetch".to_string()]),
                    denied_tool_names: BTreeSet::from(["ExecCommand".to_string()]),
                    denied_tool_messages: Default::default(),
                    path_policy: Default::default(),
                    miniapp_context_scope: None,
                },
                steering_interrupt: None,
                workspace_services: None,
                terminal_port: None,
                remote_exec_port: None,
            },
            ToolExecutionOptions::default(),
        )
    }

    #[test]
    fn restored_question_delegation_without_parent_turn_still_identifies_controller() {
        let mut task = task_with_context_vars();
        task.context.subagent_parent_info = None;
        task.context.permission_delegation =
            Some(openbitfun_agent_runtime::sdk::PermissionDelegationContext {
                parent_session_id: "restored-parent".into(),
                parent_dialog_turn_id: None,
                parent_tool_call_id: "parent-tool".into(),
                subagent_type: "ComputerUse".into(),
            });
        let context = build_tool_use_context_for_task(&task, None, CancellationToken::new());
        assert_eq!(
            context.custom_data
                [openbitfun_agent_runtime::user_questions::USER_INPUT_PARENT_CONTEXT_KEY],
            json!({
                "session_id": "restored-parent", "dialog_turn_id": null,
            })
        );
    }

    #[test]
    fn tool_task_context_materialization_preserves_runtime_fields() {
        let task = task_with_context_vars();

        let context = build_tool_use_context_for_task(&task, None, CancellationToken::new());

        assert_eq!(context.tool_call_id.as_deref(), Some("tool_context_1"));
        assert_eq!(context.agent_type.as_deref(), Some("agent"));
        assert_eq!(context.session_id.as_deref(), Some("session_1"));
        assert_eq!(context.dialog_turn_id.as_deref(), Some("turn_1"));
        assert_eq!(
            context.loaded_deferred_tool_specs,
            vec![loaded_spec("WebFetch")]
        );
        assert!(context.cancellation_token().is_some());
        assert!(context
            .runtime_tool_restrictions
            .is_tool_allowed("WebFetch"));
        assert!(!context
            .runtime_tool_restrictions
            .is_tool_allowed("ExecCommand"));
        assert_eq!(context.custom_data["turn_index"], json!(7));
        assert_eq!(context.primary_model_facts().model_id, "primary-model");
        assert_eq!(context.primary_model_facts().api_format, "openai");
        assert!(context.primary_model_facts().supports_image_inputs);
        assert!(!context.custom_data.contains_key("primary_model_provider"));
        assert!(!context
            .custom_data
            .contains_key("primary_model_supports_image_understanding"));
        assert_eq!(context.custom_data["acp_transport"], json!(true));
        assert_eq!(
            context.custom_data[USER_INPUT_MODEL_ROUND_CONTEXT_KEY],
            json!("round_1")
        );
        assert_eq!(
            context.custom_data[USER_INPUT_AVAILABLE_CONTEXT_KEY],
            json!(false)
        );
        assert_eq!(
            context.custom_data[AUTO_APPROVE_ASK_CONTEXT_KEY],
            json!(false)
        );
        assert_eq!(
            context.custom_data[PERMISSION_MODE_CONTEXT_KEY],
            json!("auto_approve")
        );
        assert_eq!(
            context.custom_data["deep_review_run_manifest"],
            json!({ "run_id": "run-1" })
        );
        assert_eq!(
            context.custom_data["deep_review_parent_tool_call_id"],
            json!("parent_tool")
        );
        assert_eq!(
            context.custom_data
                [openbitfun_agent_runtime::user_questions::USER_INPUT_PARENT_CONTEXT_KEY],
            json!({
                "session_id": "parent_session", "dialog_turn_id": "parent_turn"
            })
        );
        assert_eq!(
            context.custom_data["deep_review_parent_session_id"],
            json!("parent_session")
        );
        assert_eq!(
            context.custom_data["deep_review_parent_dialog_turn_id"],
            json!("parent_turn")
        );

        let facts = context.to_tool_context_facts();
        let value = serde_json::to_value(&facts).expect("serialize context facts");
        assert_eq!(value["toolCallId"], "tool_context_1");
        assert_eq!(value["sessionId"], "session_1");
        assert!(value.get("unlockedCollapsedTools").is_none());
        assert!(value.get("customData").is_none());
        assert!(value.get("cancellationToken").is_none());
    }
}
