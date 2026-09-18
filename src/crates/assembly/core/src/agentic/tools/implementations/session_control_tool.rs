//! SessionControl manages persisted workspace-scoped sessions.
//!
//! The `cancel` action only cancels the target session's current running dialog turn.
//! It does not permanently stop the session itself, and it does not clear queued
//! messages that may still run later through the scheduler.

use super::util::normalize_path;
use crate::agentic::coordination::{get_global_coordinator, get_global_scheduler};
use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::AgentRuntime;
use openbitfun_agent_runtime::session_control::{
    render_session_control_tool_use_message, resolve_session_control_cancel_route,
    session_control_agent_type_or_default, session_control_cancel_result_message,
    session_control_cancel_status, session_control_created_result_message,
    session_control_creator_marker, session_control_deleted_result_message,
    session_control_renamed_result_message, session_control_session_name_or_default,
    validate_session_control_input, validate_session_id, SessionControlAction,
    SessionControlCancelRoute, SessionControlInput, SessionControlValidationContext,
    SessionControlValidationResult,
};
use openbitfun_core_types::SessionExecutionTarget;
use openbitfun_runtime_ports::{
    AgentSessionCreateRequest, AgentSessionDeleteRequest, AgentSessionListRequest,
    AgentSessionRenameRequest, AgentSessionSummary, AgentSessionWorkspaceBinding,
    AgentSessionWorkspaceRequest, AgentSubmissionSource, AgentTurnCancellationRequest,
};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// SessionControl tool - create, cancel, delete, rename, or list persisted sessions
pub struct SessionControlTool;

const CANCEL_WAIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
struct SessionControlWorkspaceTarget {
    display_workspace: String,
    project_workspace: String,
    execution_target: Option<SessionExecutionTarget>,
    workspace_id: Option<String>,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
}

impl Default for SessionControlTool {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionControlTool {
    pub fn new() -> Self {
        Self
    }

    fn current_workspace_session<'a>(
        &self,
        context: &'a ToolUseContext,
        workspace: &str,
    ) -> Option<&'a str> {
        let current_session_id = context.session_id.as_deref()?;
        let current_workspace = context.workspace_root()?;
        let normalized_current_workspace =
            normalize_path(current_workspace.to_string_lossy().as_ref());

        if normalized_current_workspace == workspace {
            Some(current_session_id)
        } else {
            None
        }
    }

    fn escape_markdown_table_cell(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('|', "\\|")
            .replace('\n', "<br>")
    }

    fn format_system_time(time: SystemTime) -> String {
        let datetime: chrono::DateTime<chrono::Local> = time.into();
        datetime.format("%Y-%m-%dT%H:%M:%S").to_string()
    }

    fn creator_session_marker(&self, context: &ToolUseContext) -> OpenBitFunResult<String> {
        let creator_session_id = context.session_id.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("create requires a creator session in tool context".to_string())
        })?;
        Ok(session_control_creator_marker(creator_session_id))
    }

    async fn resolve_effective_workspace(
        &self,
        action: SessionControlAction,
        session_id: Option<&str>,
        context: &ToolUseContext,
        runtime: &AgentRuntime,
    ) -> OpenBitFunResult<SessionControlWorkspaceTarget> {
        match action {
            SessionControlAction::Cancel
            | SessionControlAction::Delete
            | SessionControlAction::Rename => {
                let session_id = session_id.ok_or_else(|| {
                    OpenBitFunError::tool(format!("session_id is required for {}", action.as_str()))
                })?;
                if let Some(binding) = runtime
                    .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                        session_id: session_id.to_string(),
                    })
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                    })?
                {
                    return Ok(Self::workspace_target_from_binding(binding));
                }
                Err(OpenBitFunError::NotFound(format!(
                    "Workspace for session '{}' could not be resolved",
                    session_id
                )))
            }
            SessionControlAction::Create | SessionControlAction::List => {
                let workspace = context.workspace.as_ref().ok_or_else(|| {
                    OpenBitFunError::tool(format!(
                        "workspace is required for {} when the current workspace is unavailable",
                        action.as_str()
                    ))
                })?;
                Ok(Self::workspace_target_from_context(workspace))
            }
        }
    }

    fn workspace_target_from_context(
        workspace: &crate::agentic::WorkspaceBinding,
    ) -> SessionControlWorkspaceTarget {
        SessionControlWorkspaceTarget {
            display_workspace: normalize_path(&workspace.root_path_string()),
            project_workspace: normalize_path(&workspace.project_root_path_string()),
            execution_target: workspace.execution_target.clone(),
            workspace_id: workspace.workspace_id.clone(),
            remote_connection_id: workspace.connection_id().map(ToOwned::to_owned),
            remote_ssh_host: if workspace.is_remote() {
                Some(workspace.session_identity.hostname.clone())
                    .filter(|value| !value.trim().is_empty())
            } else {
                None
            },
        }
    }

    fn workspace_target_from_binding(
        binding: AgentSessionWorkspaceBinding,
    ) -> SessionControlWorkspaceTarget {
        let project_workspace = binding
            .project_workspace_path
            .clone()
            .unwrap_or_else(|| binding.workspace_path.clone());
        SessionControlWorkspaceTarget {
            display_workspace: binding.workspace_path,
            project_workspace,
            execution_target: binding.execution_target,
            workspace_id: binding.workspace_id,
            remote_connection_id: binding.remote_connection_id,
            remote_ssh_host: binding.remote_ssh_host,
        }
    }

    fn rename_request(
        workspace: &SessionControlWorkspaceTarget,
        session_id: &str,
        session_name: &str,
    ) -> AgentSessionRenameRequest {
        AgentSessionRenameRequest {
            workspace_id: workspace.workspace_id.clone(),
            workspace_path: workspace.project_workspace.clone(),
            session_id: session_id.to_string(),
            session_name: session_name.to_string(),
            remote_connection_id: workspace.remote_connection_id.clone(),
            remote_ssh_host: workspace.remote_ssh_host.clone(),
        }
    }

    fn validation_context(context: Option<&ToolUseContext>) -> SessionControlValidationContext<'_> {
        SessionControlValidationContext {
            current_session_id: context.and_then(|value| value.session_id.as_deref()),
            has_workspace_root: context.and_then(|value| value.workspace_root()).is_some(),
        }
    }

    fn into_validation_result(result: SessionControlValidationResult) -> ValidationResult {
        ValidationResult {
            result: result.result,
            message: result.message,
            error_code: result.error_code,
            meta: result.meta,
        }
    }

    async fn ensure_session_exists(
        &self,
        runtime: &AgentRuntime,
        workspace: &SessionControlWorkspaceTarget,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        let existing_sessions = runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: workspace.workspace_id.clone(),
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .map_err(|error| {
                OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
            })?;
        if existing_sessions
            .iter()
            .any(|session| session.session_id == session_id)
        {
            Ok(())
        } else {
            Err(OpenBitFunError::NotFound(format!(
                "Session '{}' not found in workspace '{}'",
                session_id, workspace.display_workspace
            )))
        }
    }

    fn system_time_from_epoch_ms(epoch_ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(epoch_ms)
    }

    fn build_list_result_for_assistant(
        &self,
        workspace: &str,
        sessions: &[AgentSessionSummary],
        current_session_id: Option<&str>,
    ) -> String {
        if sessions.is_empty() {
            return format!("No sessions found in workspace '{}'.", workspace);
        }

        let mut lines = vec![format!(
            "Found {} session(s) in workspace '{}'",
            sessions.len(),
            workspace
        )];
        lines.push(String::new());
        if let Some(current_session_id) = current_session_id {
            lines.push(format!("Note: '{}' is your session_id", current_session_id));
            lines.push(String::new());
        }
        lines.push(
            "| session_id | session_name | agent_type | created_at | last_active_at |".to_string(),
        );
        lines.push("| --- | --- | --- | --- | --- |".to_string());
        for session in sessions {
            lines.push(format!(
                "| {} | {} | {} | {} | {} |",
                Self::escape_markdown_table_cell(&session.session_id),
                Self::escape_markdown_table_cell(&session.session_name),
                Self::escape_markdown_table_cell(&session.agent_type),
                Self::format_system_time(Self::system_time_from_epoch_ms(session.created_at_ms)),
                Self::format_system_time(Self::system_time_from_epoch_ms(
                    session.last_active_at_ms
                )),
            ));
        }
        lines.join("\n")
    }
}

#[async_trait]
impl Tool for SessionControlTool {
    fn name(&self) -> &str {
        "SessionControl"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Manage persisted workspace-scoped agent sessions.

Actions:
- "create": Create a new session. You may optionally provide session_name and agent_type.
- "cancel": Cancel the target session's currently running dialog turn. This does not delete the session or clear any queued messages that may still run later.
- "delete": Delete an existing session by session_id.
- "rename": Rename an existing session by session_id using session_name as the new title.
- "list": List all sessions.

Arguments:
- "workspace": Absolute workspace path. Required for create and list. Ignored for cancel, delete, and rename.
- "session_name": Used by create (defaults to "New Session") and required as the new title for rename.
- "agent_type": Only used by create. Defaults to "Standard".
  - "Standard": Coding-focused agent for implementation, debugging, and code changes.
  - "Cowork": Collaborative agent for office-style work such as research, documentation, presentations, etc.
  - "DeepResearch": Research agent for systematic investigation and evidence-driven reports.
- "session_id": Required for cancel, delete, and rename."#
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Create, list, rename, cancel, and delete persisted agent sessions.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "cancel", "delete", "rename", "list"],
                    "description": "The session action to perform."
                },
                "workspace": {
                    "type": "string",
                    "description": "Required absolute workspace path for create and list. Ignored for cancel, delete, and rename."
                },
                "session_id": {
                    "type": "string",
                    "description": "Required for cancel, delete, and rename."
                },
                "session_name": {
                    "type": "string",
                    "description": "Optional display name when creating a session; required as the new title when renaming."
                },
                "agent_type": {
                    "type": "string",
                    "enum": ["Standard", "Cowork", "DeepResearch"],
                    "description": "Optional agent type when creating a session. Defaults to agentic."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let parsed: SessionControlInput = match serde_json::from_value(input.clone()) {
            Ok(value) => value,
            Err(err) => {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Invalid input: {}", err)),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        Self::into_validation_result(validate_session_control_input(
            &parsed,
            Self::validation_context(context),
        ))
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        render_session_control_tool_use_message(input)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let params: SessionControlInput = serde_json::from_value(input.clone())
            .map_err(|e| OpenBitFunError::tool(format!("Invalid input: {}", e)))?;
        let coordinator = get_global_coordinator()
            .ok_or_else(|| OpenBitFunError::tool("coordinator not initialized".to_string()))?;
        let runtime = CoreServiceAgentRuntime::agent_runtime(coordinator.clone())
            .map_err(OpenBitFunError::tool)?;

        match params.action {
            SessionControlAction::Create => {
                let workspace = self
                    .resolve_effective_workspace(
                        SessionControlAction::Create,
                        None,
                        context,
                        &runtime,
                    )
                    .await?;
                let session_name =
                    session_control_session_name_or_default(params.session_name.as_deref());
                let agent_type = session_control_agent_type_or_default(params.agent_type.as_ref());
                let created_by = self.creator_session_marker(context)?;
                let mut metadata = serde_json::Map::new();
                metadata.insert("createdBy".to_string(), json!(created_by));
                let session = runtime
                    .create_session(AgentSessionCreateRequest {
                        session_name,
                        agent_type,
                        agent_route_key: None,
                        workspace_path: Some(workspace.display_workspace.clone()),
                        project_workspace_path: Some(workspace.project_workspace.clone()),
                        execution_target: workspace.execution_target.clone(),
                        workspace_id: workspace.workspace_id.clone(),
                        remote_connection_id: workspace.remote_connection_id.clone(),
                        remote_ssh_host: workspace.remote_ssh_host.clone(),
                        model_id: None,
                        metadata,
                    })
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                    })?;
                let created_session_id = session.session_id.clone();
                let created_session_name = session.session_name.clone();
                let created_agent_type = session.agent_type.clone();
                let result_for_assistant = session_control_created_result_message(
                    &created_session_id,
                    &workspace.display_workspace,
                    &created_agent_type,
                );

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "create",
                        "workspace": workspace.display_workspace.clone(),
                        "session": {
                            "session_id": created_session_id,
                            "session_name": created_session_name,
                            "agent_type": created_agent_type,
                        }
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            SessionControlAction::Cancel => {
                let session_id = params.session_id.as_deref().ok_or_else(|| {
                    OpenBitFunError::tool("session_id is required for cancel".to_string())
                })?;
                validate_session_id(session_id).map_err(OpenBitFunError::tool)?;
                let workspace = self
                    .resolve_effective_workspace(
                        SessionControlAction::Cancel,
                        Some(session_id),
                        context,
                        &runtime,
                    )
                    .await?;
                if self.current_workspace_session(context, &workspace.display_workspace)
                    == Some(session_id)
                {
                    return Err(OpenBitFunError::tool(
                        "cannot cancel the current session from SessionControl".to_string(),
                    ));
                }

                self.ensure_session_exists(&runtime, &workspace, session_id)
                    .await?;

                let scheduler = get_global_scheduler();
                let cancel_route = resolve_session_control_cancel_route(
                    context.session_id.as_deref(),
                    scheduler.is_some(),
                );
                let (runtime, requester_session_id) = match (cancel_route, scheduler) {
                    (
                        SessionControlCancelRoute::RequesterViaScheduler {
                            requester_session_id,
                        },
                        Some(scheduler),
                    ) => {
                        let runtime = CoreServiceAgentRuntime::agent_runtime_with_scheduler_ports(
                            coordinator.clone(),
                            scheduler,
                        )
                        .map_err(OpenBitFunError::tool)?;
                        (runtime, Some(requester_session_id))
                    }
                    _ => {
                        // Fallback covers unusual tool contexts and startup states where the
                        // global scheduler is not available; concrete cancellation still works.
                        (runtime.clone(), None)
                    }
                };
                let cancelled_turn_id = runtime
                    .cancel_turn(AgentTurnCancellationRequest {
                        session_id: session_id.to_string(),
                        turn_id: None,
                        source: Some(AgentSubmissionSource::AgentSession),
                        requester_session_id,
                        reason: None,
                        wait_timeout_ms: Some(CANCEL_WAIT_TIMEOUT.as_millis() as u64),
                        cancel_descendants: true,
                    })
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                    })?
                    .turn_id;
                let had_active_turn = cancelled_turn_id.is_some();
                let status = session_control_cancel_status(cancelled_turn_id.as_deref());
                let result_for_assistant = session_control_cancel_result_message(
                    session_id,
                    &workspace.display_workspace,
                    cancelled_turn_id.as_deref(),
                );

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "cancel",
                        "workspace": workspace.display_workspace.clone(),
                        "session_id": session_id,
                        "had_active_turn": had_active_turn,
                        "cancelled_turn_id": cancelled_turn_id,
                        "status": status,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            SessionControlAction::Delete => {
                let session_id = params.session_id.as_deref().ok_or_else(|| {
                    OpenBitFunError::tool("session_id is required for delete".to_string())
                })?;
                validate_session_id(session_id).map_err(OpenBitFunError::tool)?;
                let workspace = self
                    .resolve_effective_workspace(
                        SessionControlAction::Delete,
                        Some(session_id),
                        context,
                        &runtime,
                    )
                    .await?;
                if self.current_workspace_session(context, &workspace.display_workspace)
                    == Some(session_id)
                {
                    return Err(OpenBitFunError::tool(
                        "cannot delete the current session from SessionControl".to_string(),
                    ));
                }

                self.ensure_session_exists(&runtime, &workspace, session_id)
                    .await?;

                let scheduler = get_global_scheduler().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "scheduler not initialized for session deletion".to_string(),
                    )
                })?;
                let deletion_runtime = CoreServiceAgentRuntime::agent_runtime_with_scheduler_ports(
                    coordinator.clone(),
                    scheduler,
                )
                .map_err(OpenBitFunError::tool)?;

                deletion_runtime
                    .delete_session(AgentSessionDeleteRequest {
                        workspace_id: workspace.workspace_id.clone(),
                        workspace_path: workspace.project_workspace.clone(),
                        session_id: session_id.to_string(),
                        remote_connection_id: workspace.remote_connection_id.clone(),
                        remote_ssh_host: workspace.remote_ssh_host.clone(),
                    })
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                    })?;

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "delete",
                        "workspace": workspace.display_workspace.clone(),
                        "session_id": session_id,
                    }),
                    result_for_assistant: Some(session_control_deleted_result_message(
                        session_id,
                        &workspace.display_workspace,
                    )),
                    image_attachments: None,
                }])
            }
            SessionControlAction::Rename => {
                let session_id = params.session_id.as_deref().ok_or_else(|| {
                    OpenBitFunError::tool("session_id is required for rename".to_string())
                })?;
                validate_session_id(session_id).map_err(OpenBitFunError::tool)?;
                let session_name = params
                    .session_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        OpenBitFunError::tool(
                            "session_name is required and must not be empty for rename".to_string(),
                        )
                    })?;
                let workspace = self
                    .resolve_effective_workspace(
                        SessionControlAction::Rename,
                        Some(session_id),
                        context,
                        &runtime,
                    )
                    .await?;
                if self.current_workspace_session(context, &workspace.display_workspace)
                    == Some(session_id)
                {
                    return Err(OpenBitFunError::tool(
                        "cannot rename the current session from SessionControl".to_string(),
                    ));
                }

                // Reuse the same rename channel as the frontend
                // renameChatSessionTitle (AgentSessionManagementPort::rename_session)
                // so the persisted title stays consistent with the desktop/frontend.
                runtime
                    .rename_session(Self::rename_request(&workspace, session_id, session_name))
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(format!(
                            "cannot rename session '{session_id}': {}",
                            CoreServiceAgentRuntime::runtime_error_message(error)
                        ))
                    })?;

                let result_for_assistant = session_control_renamed_result_message(
                    session_id,
                    &workspace.display_workspace,
                    session_name,
                );
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "rename",
                        "workspace": workspace.display_workspace.clone(),
                        "session_id": session_id,
                        "session_name": session_name,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            SessionControlAction::List => {
                let workspace = self
                    .resolve_effective_workspace(
                        SessionControlAction::List,
                        None,
                        context,
                        &runtime,
                    )
                    .await?;
                let sessions = runtime
                    .list_sessions(AgentSessionListRequest {
                        workspace_id: workspace.workspace_id.clone(),
                        workspace_path: String::new(),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    })
                    .await
                    .map_err(|error| {
                        OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                    })?;
                let current_session_id =
                    self.current_workspace_session(context, &workspace.display_workspace);
                let result_for_assistant = self.build_list_result_for_assistant(
                    &workspace.display_workspace,
                    &sessions,
                    current_session_id,
                );

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "list",
                        "workspace": workspace.display_workspace.clone(),
                        "current_session_id": current_session_id,
                        "count": sessions.len(),
                        "sessions": sessions,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::ToolUseContext;
    use crate::agentic::WorkspaceBinding;
    use openbitfun_core_types::{
        SessionExecutionTarget, SessionExecutionTargetKind, WorktreeLifecycle,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
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

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("temp workspace should be created");
            Self { path }
        }

        fn as_string(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn worktree_context_keeps_project_scope_for_session_operations() {
        let worktree_path = PathBuf::from("/worktrees/wt-1");
        let project_path = PathBuf::from("/repo");
        let execution_target = SessionExecutionTarget {
            kind: SessionExecutionTargetKind::ManagedWorktree,
            worktree_id: Some("wt-1".to_string()),
            root_path: "/worktrees/wt-1".to_string(),
            base_ref: Some("HEAD".to_string()),
            base_commit: Some("0123456789abcdef".to_string()),
            branch: None,
            lifecycle: Some(WorktreeLifecycle::Managed),
        };
        let binding = WorkspaceBinding::new(None, worktree_path.clone())
            .with_project_root_path(project_path.clone())
            .with_execution_target(Some(execution_target.clone()));

        let target = SessionControlTool::workspace_target_from_context(&binding);

        assert_eq!(PathBuf::from(target.display_workspace), worktree_path);
        assert_eq!(PathBuf::from(target.project_workspace), project_path);
        assert_eq!(target.execution_target, Some(execution_target));
    }

    #[test]
    fn worktree_rename_uses_project_scope_for_persistence() {
        let target = SessionControlWorkspaceTarget {
            display_workspace: "/worktrees/wt-1".to_string(),
            project_workspace: "/repo".to_string(),
            execution_target: None,
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        let request = SessionControlTool::rename_request(&target, "session-1", "Renamed");

        assert_eq!(request.workspace_path, "/repo");
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.session_name, "Renamed");
    }

    #[tokio::test]
    async fn validate_cancel_requires_session_id() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "cancel",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("session_id is required for cancel")
        );
    }

    #[tokio::test]
    async fn validate_cancel_rejects_session_name() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "cancel",
                    "session_id": "worker_1",
                    "session_name": "should-not-be-here",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("session_name is only allowed for create")
        );
    }

    #[tokio::test]
    async fn validate_cancel_allows_missing_workspace() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "cancel",
                    "session_id": "worker_1",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }

    #[tokio::test]
    async fn validate_cancel_ignores_workspace_when_provided() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "cancel",
                    "session_id": "worker_1",
                    "workspace": "not-an-absolute-path",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }

    #[tokio::test]
    async fn validate_list_rejects_session_id() {
        let tool = SessionControlTool::new();
        let workspace = TestTempDir::new("openbitfun-session-control-tool-test");

        let validation = tool
            .validate_input(
                &json!({
                    "action": "list",
                    "workspace": workspace.as_string(),
                    "session_id": "worker_1",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("session_id is not allowed for list")
        );
    }

    #[tokio::test]
    async fn validate_list_requires_workspace() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "list",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("workspace is required for list")
        );
    }

    #[test]
    fn render_message_for_cancel_is_specific() {
        let tool = SessionControlTool::new();
        let message = tool.render_tool_use_message(
            &json!({
                "action": "cancel",
                "workspace": "/repo",
                "session_id": "worker_1",
            }),
            &ToolRenderOptions { verbose: false },
        );

        assert_eq!(message, "Cancel active turn for session worker_1");
    }

    #[tokio::test]
    async fn validate_rename_requires_session_name() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "rename",
                    "session_id": "worker_1",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("session_name is required for rename")
        );
    }

    #[tokio::test]
    async fn validate_rename_requires_session_id() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "rename",
                    "session_name": "new-title",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert_eq!(
            validation.message.as_deref(),
            Some("session_id is required for rename")
        );
    }

    #[tokio::test]
    async fn validate_rename_accepts_session_id_and_name() {
        let tool = SessionControlTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "rename",
                    "session_id": "worker_1",
                    "session_name": "new-title",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }
}
