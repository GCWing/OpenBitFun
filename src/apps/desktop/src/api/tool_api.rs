//! Tool API

use log::error;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

use openbitfun_agent_runtime::sdk::AgentUserAnswersRequest;
use openbitfun_core::agentic::tools::product_runtime::{build_tool_info, ToolInfoDto};
use openbitfun_core::agentic::{
    tools::framework::ToolUseContext,
    tools::{get_all_tools, get_readonly_tools},
    workspace::{local_workspace_services, remote_workspace_services},
    WorkspaceBinding,
};
use openbitfun_core::product_runtime::CoreRuntimeServicesProvider;
use openbitfun_core::service::remote_ssh::workspace_state::{
    get_remote_workspace_manager, lookup_remote_connection, workspace_session_identity,
};
use openbitfun_core::util::elapsed_ms_u64;

use crate::runtime::DesktopRuntimeContext;

/// Re-export the shared tool catalog DTO so callers see one `ToolInfo` type
/// across the Desktop Tauri command and the CLI Peer Host handler. Core owns
/// the shape; both hosts must answer `get_all_tools_info` with it so a
/// controller cannot tell "unsupported" from "empty".
pub type ToolInfo = ToolInfoDto;

#[tauri::command]
pub async fn get_chat_mcp_catalog(
    request: openbitfun_core::agentic::tools::product_runtime::ChatMcpCatalogRequest,
) -> Result<openbitfun_core::agentic::tools::product_runtime::ChatMcpCatalog, String> {
    openbitfun_core::agentic::tools::product_runtime::build_chat_mcp_catalog(request).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionRequest {
    pub tool_name: String,
    pub input: serde_json::Value,
    pub workspace_path: Option<String>,
    pub context: Option<HashMap<String, String>>,
    pub safe_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetToolInfoRequest {
    pub tool_name: String,
}

// Re-export the shared dynamic tool DTOs (Core already owns them under
// `openbitfun_core::agentic::tools::framework`); Desktop used to carry byte-for-byte
// duplicates. Keeping the names re-exported preserves downstream `use ...::*`
// imports in lib.rs.
pub use openbitfun_core::agentic::tools::framework::{DynamicMcpToolInfo, DynamicToolInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionResponse {
    pub tool_name: String,
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub validation_error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolValidationRequest {
    pub tool_name: String,
    pub input: serde_json::Value,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolValidationResponse {
    pub tool_name: String,
    pub valid: bool,
    pub message: Option<String>,
    pub error_code: Option<i32>,
    pub meta: Option<serde_json::Value>,
}

/// Builds the tool context for a direct tool call. A remote workspace whose
/// SSH provider cannot be built is an error: a context without workspace
/// services would otherwise resolve remote paths against this machine.
async fn build_tool_context(workspace_path: Option<&str>) -> Result<ToolUseContext, String> {
    let normalized_workspace_path = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty());

    let workspace = match normalized_workspace_path {
        Some(path) => {
            if let Some(entry) = lookup_remote_connection(path).await {
                let identity = workspace_session_identity(
                    path,
                    Some(&entry.connection_id),
                    Some(&entry.ssh_host),
                )
                .unwrap_or_else(|| {
                    openbitfun_core::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                        hostname: entry.ssh_host.clone(),
                        logical_workspace_path: entry.remote_root.clone(),
                        remote_connection_id: Some(entry.connection_id.clone()),
                    }
                });
                Some(WorkspaceBinding::new_remote(
                    None,
                    PathBuf::from(path),
                    entry.connection_id,
                    entry.connection_name,
                    identity,
                ))
            } else {
                Some(WorkspaceBinding::new(None, PathBuf::from(path)))
            }
        }
        None => None,
    };

    let workspace_services = match workspace.as_ref() {
        Some(binding) if binding.is_remote() => {
            let root = binding.root_path_string();
            let unavailable = |reason: &str| {
                format!(
                    "Remote workspace services are unavailable for {root}: {reason}; no controller-local fallback was attempted"
                )
            };
            let connection_id = binding
                .connection_id()
                .map(str::to_string)
                .ok_or_else(|| unavailable("the workspace binding has no connection id"))?;
            let manager = get_remote_workspace_manager()
                .ok_or_else(|| unavailable("remote workspace state is not initialized"))?;
            let file_service = manager
                .get_file_service()
                .await
                .ok_or_else(|| unavailable("the remote file service is not available"))?;
            let ssh_manager = manager
                .get_ssh_manager()
                .await
                .ok_or_else(|| unavailable("the SSH connection manager is not available"))?;
            Some(remote_workspace_services(
                connection_id,
                file_service,
                ssh_manager,
                root,
            ))
        }
        Some(binding) => Some(local_workspace_services(binding.root_path_string())),
        None => None,
    };

    let remote_exec_port = workspace
        .as_ref()
        .is_some_and(WorkspaceBinding::is_remote)
        .then(CoreRuntimeServicesProvider::remote_exec_port);

    Ok(ToolUseContext::for_tool_listing_with_remote_exec_port(
        workspace,
        workspace_services,
        remote_exec_port,
    ))
}

fn has_explicit_workspace_path(workspace_path: Option<&str>) -> bool {
    workspace_path.is_some_and(|path| !path.trim().is_empty())
}

fn is_relative_path(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(|v| v.as_str())
        .is_some_and(|path| !path.is_empty() && !PathBuf::from(path).is_absolute())
}

fn write_file_path(input: &serde_json::Value) -> Option<&str> {
    let value = input.get("payload")?.as_str()?;
    let first_line = value
        .split_once('\n')
        .map_or(value, |(file_path, _)| file_path);
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let file_path = first_line.strip_prefix("+++ ")?;
    (!file_path.trim().is_empty()).then_some(file_path)
}

fn tool_requires_workspace_path(tool_name: &str, input: &serde_json::Value) -> bool {
    match tool_name {
        "ExecCommand" => true,
        "Glob" | "Grep" => input.get("path").is_none() || is_relative_path(input.get("path")),
        "Write" => write_file_path(input).map_or_else(
            || input.get("payload").is_some(),
            |path| !PathBuf::from(path).is_absolute(),
        ),
        "Read" | "Edit" | "GetFileDiff" => is_relative_path(input.get("file_path")),
        _ => false,
    }
}

fn ensure_workspace_requirement(
    tool_name: &str,
    input: &serde_json::Value,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    if tool_requires_workspace_path(tool_name, input)
        && !has_explicit_workspace_path(workspace_path)
    {
        return Err(format!(
            "workspacePath is required to execute tool '{}' with workspace-relative input",
            tool_name
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn get_all_tools_info() -> Result<Vec<ToolInfo>, String> {
    let tools = get_all_tools().await;

    let mut tool_infos = Vec::new();

    for tool in tools {
        tool_infos.push(build_tool_info(&tool).await);
    }

    Ok(tool_infos)
}

#[tauri::command]
pub async fn get_readonly_tools_info() -> Result<Vec<ToolInfo>, String> {
    let tools = get_readonly_tools()
        .await
        .map_err(|e| format!("Failed to get readonly tools: {}", e))?;

    let mut tool_infos = Vec::new();

    for tool in tools {
        tool_infos.push(build_tool_info(&tool).await);
    }

    Ok(tool_infos)
}

#[tauri::command]
pub async fn get_tool_info(request: GetToolInfoRequest) -> Result<Option<ToolInfo>, String> {
    let tools = get_all_tools().await;

    for tool in tools {
        if tool.name() == request.tool_name {
            return Ok(Some(build_tool_info(&tool).await));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn validate_tool_input(
    request: ToolValidationRequest,
) -> Result<ToolValidationResponse, String> {
    let tools = get_all_tools().await;

    for tool in tools {
        if tool.name() == request.tool_name {
            ensure_workspace_requirement(
                &request.tool_name,
                &request.input,
                request.workspace_path.as_deref(),
            )?;

            let context = build_tool_context(request.workspace_path.as_deref()).await?;

            let validation_result = tool.validate_input(&request.input, Some(&context)).await;

            return Ok(ToolValidationResponse {
                tool_name: request.tool_name,
                valid: validation_result.result,
                message: validation_result.message,
                error_code: validation_result.error_code,
                meta: validation_result.meta,
            });
        }
    }

    Err(format!("Tool '{}' not found", request.tool_name))
}

#[tauri::command]
pub async fn execute_tool(request: ToolExecutionRequest) -> Result<ToolExecutionResponse, String> {
    let start_time = std::time::Instant::now();

    let tools = get_all_tools().await;

    for tool in tools {
        if tool.name() == request.tool_name {
            ensure_workspace_requirement(
                &request.tool_name,
                &request.input,
                request.workspace_path.as_deref(),
            )?;

            let context = build_tool_context(request.workspace_path.as_deref()).await?;

            let validation_result = tool.validate_input(&request.input, Some(&context)).await;
            if !validation_result.result {
                return Ok(ToolExecutionResponse {
                    tool_name: request.tool_name,
                    success: false,
                    result: None,
                    error: None,
                    validation_error: validation_result.message,
                    duration_ms: elapsed_ms_u64(start_time),
                });
            }

            match tool.call(&request.input, &context).await {
                Ok(results) => {
                    let combined_result = if results.len() == 1 {
                        match &results[0] {
                            openbitfun_core::agentic::tools::framework::ToolResult::Result {
                                data,
                                ..
                            } => Some(data.clone()),
                            openbitfun_core::agentic::tools::framework::ToolResult::Progress {
                                content,
                                ..
                            } => Some(content.clone()),
                            openbitfun_core::agentic::tools::framework::ToolResult::StreamChunk {
                                data,
                                ..
                            } => Some(data.clone()),
                        }
                    } else {
                        Some(serde_json::json!({
                                        "results": results.iter().map(|r| match r {
                        openbitfun_core::agentic::tools::framework::ToolResult::Result { data, .. } => {
                            data.clone()
                        }
                        openbitfun_core::agentic::tools::framework::ToolResult::Progress { content, .. } => content.clone(),
                        openbitfun_core::agentic::tools::framework::ToolResult::StreamChunk { data, .. } => data.clone(),
                                        }).collect::<Vec<_>>()
                                    }))
                    };

                    return Ok(ToolExecutionResponse {
                        tool_name: request.tool_name,
                        success: true,
                        result: combined_result,
                        error: None,
                        validation_error: None,
                        duration_ms: elapsed_ms_u64(start_time),
                    });
                }
                Err(e) => {
                    return Ok(ToolExecutionResponse {
                        tool_name: request.tool_name,
                        success: false,
                        result: None,
                        error: Some(format!("Tool execution failed: {}", e)),
                        validation_error: None,
                        duration_ms: elapsed_ms_u64(start_time),
                    });
                }
            }
        }
    }

    Err(format!("Tool '{}' not found", request.tool_name))
}

#[tauri::command]
pub async fn submit_user_answers(
    runtime: State<'_, DesktopRuntimeContext>,
    tool_id: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    runtime
        .agent_runtime()
        .submit_user_answers(AgentUserAnswersRequest {
            tool_id: tool_id.clone(),
            answers,
        })
        .await
        .map_err(|error| {
            let error = desktop_user_answers_error_message(error.into_message());
            error!(
                "Failed to send user answer: tool_id={}, error={}",
                tool_id, error
            );
            error
        })
}

fn desktop_user_answers_error_message(message: String) -> String {
    message
        .strip_prefix("Tool error: ")
        .unwrap_or(&message)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::desktop_user_answers_error_message;

    #[test]
    fn user_answers_errors_keep_the_existing_desktop_text() {
        assert_eq!(
            desktop_user_answers_error_message(
                "Tool error: Waiting channel not found: tool-1".to_string(),
            ),
            "Waiting channel not found: tool-1"
        );
        assert_eq!(
            desktop_user_answers_error_message("Runtime unavailable".to_string()),
            "Runtime unavailable"
        );
    }
}
