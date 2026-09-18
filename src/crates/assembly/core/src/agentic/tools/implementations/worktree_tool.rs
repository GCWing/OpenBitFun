//! Deferred Agent tool for safe project-scoped worktree orchestration.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
    ValidationResult,
};
use crate::service::workspace::{
    get_global_workspace_service, WorkspaceActivityMode, WorkspaceCreateOptions, WorkspaceService,
};
use crate::service::worktree::{
    WorktreeCreateBranchRequest, WorktreeCreateRequest, WorktreeCreateResult, WorktreeListRequest,
    WorktreeRemoveRequest, WorktreeService,
};
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_runtime::session_control::session_control_creator_marker;
use openbitfun_runtime_ports::{
    AgentSessionCreateRequest, AgentSessionListRequest, AgentSessionWorkspaceRequest,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorktreeToolOperation {
    List,
    CreateSession,
    CreateBranch,
    Remove,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WorktreeToolInput {
    operation: WorktreeToolOperation,
    #[serde(default)]
    worktree_id: Option<String>,
    #[serde(default)]
    base_ref: Option<String>,
    #[serde(default)]
    copy_local_changes: bool,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    session_name: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
}

pub struct WorktreeTool;

impl WorktreeTool {
    pub fn new() -> Self {
        Self
    }

    fn project_path(context: &ToolUseContext) -> OpenBitFunResult<String> {
        let workspace = context.workspace.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("Worktree requires a workspace-bound session".to_string())
        })?;
        if workspace.is_remote() {
            return Err(OpenBitFunError::tool(
                "Managed worktrees are not supported for remote SSH workspaces yet".to_string(),
            ));
        }
        context
            .project_workspace_root()
            .map(|path| path.to_string_lossy().to_string())
            .ok_or_else(|| {
                OpenBitFunError::tool("Project workspace root is unavailable".to_string())
            })
    }

    fn request_id(context: &ToolUseContext, operation: &str) -> String {
        context
            .tool_call_id
            .as_deref()
            .map(|tool_call_id| format!("agent:{tool_call_id}:{operation}"))
            .unwrap_or_else(|| format!("agent:{}:{operation}", uuid::Uuid::new_v4()))
    }

    fn same_path(left: &Path, right: &Path) -> bool {
        let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
        let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
        left == right
    }

    async fn ensure_not_current_worktree(
        context: &ToolUseContext,
        project_workspace_path: &str,
        worktree_id: &str,
    ) -> OpenBitFunResult<()> {
        let current_root = context.workspace_root().ok_or_else(|| {
            OpenBitFunError::tool("Current workspace root is unavailable".to_string())
        })?;
        let worktree = WorktreeService::list(WorktreeListRequest {
            project_workspace_id: None,
            project_workspace_path: project_workspace_path.to_string(),
        })
        .await
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?
        .into_iter()
        .find(|worktree| worktree.worktree_id == worktree_id)
        .ok_or_else(|| OpenBitFunError::NotFound("Worktree was not found".to_string()))?;
        if Self::same_path(current_root, Path::new(&worktree.path)) {
            return Err(OpenBitFunError::tool(
                "Worktree cannot remove or rebind the worktree running this tool".to_string(),
            ));
        }
        Ok(())
    }

    async fn cleanup_failed_fresh_create(
        project_workspace_path: &str,
        created: &WorktreeCreateResult,
        workspace_service: &WorkspaceService,
        tracked_workspace_id: Option<&str>,
        failure: impl Into<String>,
    ) -> OpenBitFunError {
        let failure = failure.into();
        if !created.created {
            return OpenBitFunError::tool(failure);
        }

        let mut rollback_issues = Vec::new();
        if let Some(workspace_id) = tracked_workspace_id {
            if let Err(remove_error) = workspace_service.remove_workspace(workspace_id).await {
                rollback_issues.push(format!(
                    "workspace registration could not be removed: {remove_error}"
                ));
            }
        }
        if let Some(worktree_id) = created.execution_target.worktree_id.as_deref() {
            if let Err(rollback_error) =
                WorktreeService::rollback_created(project_workspace_path, worktree_id).await
            {
                rollback_issues.push(format!("worktree could not be removed: {rollback_error}"));
            }
        }
        if rollback_issues.is_empty() {
            OpenBitFunError::tool(failure)
        } else {
            OpenBitFunError::tool(format!(
                "rollback_incomplete: {failure}; {}; recovery_path={}",
                rollback_issues.join("; "),
                created.execution_target.root_path
            ))
        }
    }
}

impl Default for WorktreeTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for WorktreeTool {
    fn name(&self) -> &str {
        "Worktree"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Manage isolated Git worktrees for the current main project.

Actions:
- "list": Read worktrees and associated sessions.
- "create_session": Create a managed detached worktree and a new persisted session.
- "create_branch": Create a branch for a detached managed worktree.
- "remove": Safely remove a managed worktree. This never forces removal.

The tool cannot remove or rebind the worktree in which it is running. Use SessionMessage after create_session to delegate work to the returned session_id."#
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "List worktrees or safely create isolated sessions, branches, and removals.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        context
            .and_then(|context| context.workspace.as_ref())
            .is_some_and(|workspace| !workspace.is_remote())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["list", "create_session", "create_branch", "remove"]
                },
                "worktree_id": {
                    "type": "string",
                    "description": "Required for create_branch and remove. Arbitrary paths are not accepted."
                },
                "base_ref": {
                    "type": "string",
                    "description": "Optional Git ref for create_session. Defaults to HEAD."
                },
                "copy_local_changes": {
                    "type": "boolean",
                    "default": false,
                    "description": "Copy staged, unstaged, untracked, and .worktreeinclude-selected ignored files when the base equals source HEAD."
                },
                "branch": {
                    "type": "string",
                    "description": "Required for create_branch."
                },
                "session_name": {
                    "type": "string",
                    "description": "Optional display name for create_session."
                },
                "agent_type": {
                    "type": "string",
                    "enum": ["Standard", "Cowork"],
                    "description": "Optional mode for create_session. Defaults to agentic."
                }
            },
            "required": ["operation"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let input: WorktreeToolInput = serde_json::from_value(input.clone())
            .map_err(|error| OpenBitFunError::validation(format!("Invalid input: {error}")))?;
        let project = Self::project_path(context)?;
        let intent = match input.operation {
            WorktreeToolOperation::List => return Ok(Vec::new()),
            WorktreeToolOperation::CreateSession => {
                PermissionIntent::new("worktree.create", vec![project])
            }
            WorktreeToolOperation::CreateBranch => PermissionIntent::new(
                "worktree.branch",
                vec![format!(
                    "{}:{}",
                    project,
                    input.worktree_id.as_deref().unwrap_or_default()
                )],
            ),
            WorktreeToolOperation::Remove => PermissionIntent::new(
                "worktree.remove",
                vec![format!(
                    "{}:{}",
                    project,
                    input.worktree_id.as_deref().unwrap_or_default()
                )],
            ),
        };
        Ok(vec![intent])
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let parsed: WorktreeToolInput = match serde_json::from_value(input.clone()) {
            Ok(parsed) => parsed,
            Err(error) => {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Invalid input: {error}")),
                    error_code: Some(400),
                    meta: None,
                }
            }
        };
        let Some(context) = context else {
            return ValidationResult {
                result: false,
                message: Some("Worktree requires tool context".to_string()),
                error_code: Some(400),
                meta: None,
            };
        };
        if let Err(error) = Self::project_path(context) {
            return ValidationResult {
                result: false,
                message: Some(error.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        let missing = match parsed.operation {
            WorktreeToolOperation::CreateBranch => {
                parsed.worktree_id.as_deref().is_none_or(str::is_empty)
                    || parsed.branch.as_deref().is_none_or(str::is_empty)
            }
            WorktreeToolOperation::Remove => {
                parsed.worktree_id.as_deref().is_none_or(str::is_empty)
            }
            WorktreeToolOperation::List | WorktreeToolOperation::CreateSession => false,
        };
        if missing {
            return ValidationResult {
                result: false,
                message: Some(
                    "worktree_id is required for remove; worktree_id and branch are required for create_branch"
                        .to_string(),
                ),
                error_code: Some(400),
                meta: None,
            };
        }
        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let operation = input
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("manage");
        format!("Worktree {operation}")
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let input: WorktreeToolInput = serde_json::from_value(input.clone())
            .map_err(|error| OpenBitFunError::tool(format!("Invalid input: {error}")))?;
        let project_workspace_path = Self::project_path(context)?;

        let data = match input.operation {
            WorktreeToolOperation::List => {
                let worktrees = WorktreeService::list(WorktreeListRequest {
                    project_workspace_id: None,
                    project_workspace_path: project_workspace_path.clone(),
                })
                .await
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
                json!({
                    "success": true,
                    "operation": "list",
                    "project_workspace_path": project_workspace_path,
                    "count": worktrees.len(),
                    "worktrees": worktrees,
                })
            }
            WorktreeToolOperation::CreateSession => {
                let operation_request_id = Self::request_id(context, "create_session");
                let stable_session_id =
                    WorktreeService::session_id_for_request(&operation_request_id)
                        .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
                let source_workspace_path = context
                    .workspace_root()
                    .ok_or_else(|| {
                        OpenBitFunError::tool(
                            "Current execution workspace is unavailable".to_string(),
                        )
                    })?
                    .to_string_lossy()
                    .to_string();
                let created = WorktreeService::create(WorktreeCreateRequest {
                    request_id: operation_request_id,
                    project_workspace_id: None,
                    project_workspace_path: project_workspace_path.clone(),
                    source_workspace_path: Some(source_workspace_path),
                    base_ref: input.base_ref,
                    copy_local_changes: input.copy_local_changes,
                    // The session this operation creates is the claim.
                    claimed_by: None,
                })
                .await
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?;

                let workspace_service = get_global_workspace_service().ok_or_else(|| {
                    OpenBitFunError::tool("Workspace service is not initialized".to_string())
                })?;
                let tracked_workspace = match workspace_service
                    .track_workspace_activity(
                        PathBuf::from(&created.execution_target.root_path),
                        WorkspaceCreateOptions::default(),
                        WorkspaceActivityMode::RefreshMetadata,
                    )
                    .await
                {
                    Ok(workspace) => workspace,
                    Err(track_error) => {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            None,
                            format!("Failed to register worktree workspace: {track_error}"),
                        )
                        .await);
                    }
                };

                let coordinator = match get_global_coordinator() {
                    Some(coordinator) => coordinator,
                    None => {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            Some(&tracked_workspace.id),
                            "Coordinator is not initialized",
                        )
                        .await);
                    }
                };
                let runtime = match CoreServiceAgentRuntime::agent_runtime(coordinator) {
                    Ok(runtime) => runtime,
                    Err(runtime_error) => {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            Some(&tracked_workspace.id),
                            runtime_error,
                        )
                        .await);
                    }
                };
                let existing = match runtime
                    .list_sessions(AgentSessionListRequest {
                        workspace_id: context
                            .workspace
                            .as_ref()
                            .and_then(|workspace| workspace.project_workspace_id.clone()),
                        workspace_path: String::new(),
                        remote_connection_id: None,
                        remote_ssh_host: None,
                    })
                    .await
                {
                    Ok(sessions) => sessions,
                    Err(list_error) => {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            Some(&tracked_workspace.id),
                            list_error.into_message(),
                        )
                        .await);
                    }
                }
                .into_iter()
                .find(|session| session.session_id == stable_session_id);
                if let Some(existing) = existing {
                    let binding = match runtime
                        .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                            session_id: stable_session_id.clone(),
                        })
                        .await
                    {
                        Ok(binding) => binding,
                        Err(binding_error) => {
                            return Err(Self::cleanup_failed_fresh_create(
                                &project_workspace_path,
                                &created,
                                workspace_service.as_ref(),
                                Some(&tracked_workspace.id),
                                binding_error.into_message(),
                            )
                            .await);
                        }
                    };
                    if binding
                        .as_ref()
                        .map(|binding| binding.workspace_path.as_str())
                        != Some(created.execution_target.root_path.as_str())
                    {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            Some(&tracked_workspace.id),
                            "Idempotent worktree request resolved to a session with a different execution target",
                        )
                        .await);
                    }
                    let replay_data = json!({
                        "success": true,
                        "operation": "create_session",
                        "worktree_id": created.execution_target.worktree_id,
                        "path": created.execution_target.root_path,
                        "session_id": existing.session_id,
                        "session_name": existing.session_name,
                        "idempotent_replay": true,
                        "next": "Use SessionMessage with session_id to delegate work.",
                    });
                    return Ok(vec![ToolResult::Result {
                        result_for_assistant: Some(replay_data.to_string()),
                        data: replay_data,
                        image_attachments: None,
                    }]);
                }
                let mut metadata = serde_json::Map::new();
                if let Some(session_id) = context.session_id.as_deref() {
                    metadata.insert(
                        "createdBy".to_string(),
                        json!(session_control_creator_marker(session_id)),
                    );
                }
                let session = match runtime
                    .create_session_with_id(
                        stable_session_id,
                        AgentSessionCreateRequest {
                            session_name: input
                                .session_name
                                .unwrap_or_else(|| "New Worktree Session".to_string()),
                            agent_type: input.agent_type.unwrap_or_else(|| "Standard".to_string()),
                            agent_route_key: None,
                            workspace_path: Some(created.execution_target.root_path.clone()),
                            project_workspace_path: Some(project_workspace_path.clone()),
                            execution_target: Some(created.execution_target.clone()),
                            workspace_id: Some(tracked_workspace.id.clone()),
                            remote_connection_id: None,
                            remote_ssh_host: None,
                            model_id: None,
                            metadata,
                        },
                    )
                    .await
                {
                    Ok(session) => session,
                    Err(create_error) => {
                        return Err(Self::cleanup_failed_fresh_create(
                            &project_workspace_path,
                            &created,
                            workspace_service.as_ref(),
                            Some(&tracked_workspace.id),
                            format!("Failed to create worktree session: {create_error}"),
                        )
                        .await);
                    }
                };
                json!({
                    "success": true,
                    "operation": "create_session",
                    "worktree_id": created.execution_target.worktree_id,
                    "path": created.execution_target.root_path,
                    "session_id": session.session_id,
                    "session_name": session.session_name,
                    "next": "Use SessionMessage with session_id to delegate work.",
                })
            }
            WorktreeToolOperation::CreateBranch => {
                let worktree_id = input.worktree_id.as_deref().unwrap_or_default();
                Self::ensure_not_current_worktree(context, &project_workspace_path, worktree_id)
                    .await?;
                let result = WorktreeService::create_branch(WorktreeCreateBranchRequest {
                    request_id: Self::request_id(context, "create_branch"),
                    project_workspace_id: None,
                    project_workspace_path,
                    worktree_id: worktree_id.to_string(),
                    branch: input.branch.unwrap_or_default(),
                })
                .await
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
                json!({
                    "success": true,
                    "operation": "create_branch",
                    "worktree": result.worktree,
                })
            }
            WorktreeToolOperation::Remove => {
                let worktree_id = input.worktree_id.as_deref().unwrap_or_default();
                Self::ensure_not_current_worktree(context, &project_workspace_path, worktree_id)
                    .await?;
                let result = WorktreeService::remove(WorktreeRemoveRequest {
                    request_id: Self::request_id(context, "remove"),
                    project_workspace_id: None,
                    project_workspace_path,
                    worktree_id: worktree_id.to_string(),
                    force: false,
                })
                .await
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
                json!({
                    "success": result.removed,
                    "operation": "remove",
                    "worktree_id": result.worktree_id,
                })
            }
        };

        Ok(vec![ToolResult::Result {
            result_for_assistant: Some(data.to_string()),
            data,
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::WorktreeTool;
    use crate::agentic::tools::framework::Tool;
    use serde_json::json;

    #[test]
    fn worktree_tool_is_deferred_and_does_not_accept_force_or_paths() {
        let tool = WorktreeTool::new();
        let schema = tool.input_schema();
        let properties = schema["properties"]
            .as_object()
            .expect("properties should be an object");
        assert!(!properties.contains_key("force"));
        assert!(!properties.contains_key("path"));
        assert_eq!(format!("{:?}", tool.default_exposure()), "Deferred");
        assert!(schema["properties"]["operation"]["enum"]
            .as_array()
            .expect("operation enum")
            .contains(&json!("remove")));
    }
}
