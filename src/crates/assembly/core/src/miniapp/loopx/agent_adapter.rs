use super::tool_activity::project_tool_activity;
use crate::agentic::coordination::ConversationCoordinator;
use openbitfun_agent_runtime::permission::PERMISSION_MODE_CONTEXT_KEY;
use openbitfun_events::AgenticEvent;
use openbitfun_product_domains::miniapp::loopx::{
    required_permission_scopes_are_granted, LoopxAgentCancelRequest, LoopxAgentCancelResult,
    LoopxAgentFinishRequest, LoopxAgentFinishResult, LoopxAgentOutputSinceRequest,
    LoopxAgentOutputSinceResult, LoopxAgentPort, LoopxAgentProbeRequest, LoopxAgentProbeResult,
    LoopxAgentResetRequest, LoopxAgentResetResult, LoopxAgentStartRequest, LoopxAgentStartResult,
    LoopxHostFuture, LoopxHostPortError, LoopxHostPortErrorKind, LoopxTurnOutputEvent,
    LoopxTurnOutputEventKind, LOOPX_BUILTIN_APP_ID,
};
use openbitfun_runtime_ports::{
    AgentSessionCreateRequest, AgentSubmissionPort, AgentSubmissionRequest, AgentSubmissionSource,
    AgentTurnCancellationPort, AgentTurnCancellationRequest, PermissionMode,
};
use std::path::Path;
use std::sync::Arc;

const LOOPX_AGENT_TYPE: &str = "agentic";
const LOOPX_AGENT_CAPABILITIES: &[&str] = &[
    "filesystem_read",
    "filesystem_write",
    "shell",
    "network",
    "external_evidence_poll",
];

pub struct CoreLoopxAgentPort {
    coordinator: Arc<ConversationCoordinator>,
}

impl CoreLoopxAgentPort {
    pub fn new(coordinator: Arc<ConversationCoordinator>) -> Self {
        Self { coordinator }
    }
}

impl LoopxAgentPort for CoreLoopxAgentPort {
    fn available_capabilities(&self) -> Vec<String> {
        LOOPX_AGENT_CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_string())
            .collect()
    }

    fn probe(&self, request: LoopxAgentProbeRequest) -> LoopxHostFuture<'_, LoopxAgentProbeResult> {
        Box::pin(async move {
            let config_service = crate::service::config::get_global_config_service()
                .await
                .map_err(|error| {
                    host_error(
                        LoopxHostPortErrorKind::Backend,
                        format!("LoopX Agent model configuration is unavailable: {error}"),
                        &request.operation_id,
                    )
                })?;
            let global_config: crate::service::config::types::GlobalConfig =
                config_service.get_config(None).await.map_err(|error| {
                    host_error(
                        LoopxHostPortErrorKind::Backend,
                        format!("LoopX Agent model configuration could not be read: {error}"),
                        &request.operation_id,
                    )
                })?;
            let requested = request.model_id.as_deref().unwrap_or("auto").trim();
            let selector = if requested.is_empty() || matches!(requested, "auto" | "primary") {
                "primary"
            } else {
                requested
            };
            let model_id = global_config
                .ai
                .resolve_model_selection(selector)
                .ok_or_else(|| {
                    host_error(
                        LoopxHostPortErrorKind::NotFound,
                        format!("LoopX Agent model '{selector}' is not configured or enabled"),
                        &request.operation_id,
                    )
                })?;
            let model = global_config
                .ai
                .models
                .iter()
                .find(|model| model.id == model_id && model.enabled)
                .ok_or_else(|| {
                    host_error(
                        LoopxHostPortErrorKind::NotFound,
                        format!("LoopX Agent model '{model_id}' is unavailable"),
                        &request.operation_id,
                    )
                })?;
            if !model.supports_text_generation() {
                return Err(host_error(
                    LoopxHostPortErrorKind::Unsupported,
                    format!("LoopX Agent model '{model_id}' does not support text chat"),
                    &request.operation_id,
                ));
            }
            let supports_images = model.supports_image_understanding();
            Ok(LoopxAgentProbeResult {
                model_id,
                supports_images,
            })
        })
    }

    fn start(&self, request: LoopxAgentStartRequest) -> LoopxHostFuture<'_, LoopxAgentStartResult> {
        Box::pin(async move {
            if request.worktree_path.trim().is_empty() {
                return Err(host_error(
                    LoopxHostPortErrorKind::InvalidInput,
                    "LoopX Agent worktree path is required",
                    &request.operation_id,
                ));
            }
            if !required_permission_scopes_are_granted(&request.granted_scopes) {
                return Err(host_error(
                    LoopxHostPortErrorKind::InvalidInput,
                    "LoopX Agent cannot run headlessly without every required intake permission scope",
                    &request.operation_id,
                ));
            }
            let session_id = format!("loopx-{}", uuid::Uuid::new_v4());
            let turn_id = format!("loopx-turn-{}", uuid::Uuid::new_v4());
            let task_id = request.task_id.clone();
            let metadata = loopx_session_metadata(&request);
            let created = AgentSubmissionPort::create_transient_session_with_id(
                self.coordinator.as_ref(),
                session_id.clone(),
                AgentSessionCreateRequest {
                    session_name: format!("LoopX #{}", request.metadata.item.number),
                    agent_type: LOOPX_AGENT_TYPE.to_string(),
                    agent_route_key: None,
                    workspace_path: Some(request.worktree_path),
                    project_workspace_path: None,
                    execution_target: None,
                    workspace_id: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: (!request.model_id.trim().is_empty() && request.model_id != "auto")
                        .then_some(request.model_id),
                    metadata: metadata.clone(),
                },
            )
            .await
            .map_err(|error| map_port_error(error, &request.operation_id))?;
            log::info!(
                "LoopX transient Agent session created: task_id={}, session_id={}, requested_turn_id={}",
                task_id,
                created.session_id,
                turn_id
            );
            let submitted = AgentSubmissionPort::submit_message(
                self.coordinator.as_ref(),
                AgentSubmissionRequest {
                    session_id: created.session_id.clone(),
                    message: request.instruction,
                    turn_id: Some(turn_id.clone()),
                    source: Some(AgentSubmissionSource::DesktopApi),
                    attachments: Vec::new(),
                    metadata,
                },
            )
            .await
            .map_err(|error| map_port_error(error, &request.operation_id))?;
            if !submitted.accepted {
                let _ = self
                    .coordinator
                    .discard_transient_session(
                        Path::new(&created.workspace_path.unwrap_or_default()),
                        None,
                        None,
                        &created.session_id,
                    )
                    .await;
                return Err(host_error(
                    LoopxHostPortErrorKind::Conflict,
                    "LoopX Agent turn was not accepted",
                    &request.operation_id,
                ));
            }
            log::info!(
                "LoopX Agent turn accepted: task_id={}, session_id={}, turn_id={}",
                task_id,
                created.session_id,
                submitted.turn_id
            );
            Ok(LoopxAgentStartResult {
                session_id: created.session_id,
                turn_id: submitted.turn_id,
            })
        })
    }

    fn cancel(
        &self,
        request: LoopxAgentCancelRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentCancelResult> {
        Box::pin(async move {
            let result = AgentTurnCancellationPort::cancel_turn(
                self.coordinator.as_ref(),
                AgentTurnCancellationRequest {
                    session_id: request.session_id,
                    turn_id: Some(request.turn_id),
                    source: Some(AgentSubmissionSource::DesktopApi),
                    requester_session_id: None,
                    reason: Some("LoopX task paused by the user".to_string()),
                    wait_timeout_ms: Some(5_000),
                    cancel_descendants: true,
                },
            )
            .await
            .map_err(|error| map_port_error(error, &request.operation_id))?;
            Ok(LoopxAgentCancelResult {
                target_operation_id: request.target_operation_id,
                cancelled: result.requested,
            })
        })
    }

    fn finish(
        &self,
        request: LoopxAgentFinishRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentFinishResult> {
        Box::pin(async move {
            let discarded = self
                .coordinator
                .discard_transient_session(
                    Path::new(&request.worktree_path),
                    None,
                    None,
                    &request.session_id,
                )
                .await
                .map_err(|error| {
                    host_error(
                        LoopxHostPortErrorKind::Backend,
                        error.to_string(),
                        &request.operation_id,
                    )
                })?;
            log::info!(
                "LoopX transient Agent session discarded: task_id={}, session_id={}, discarded={}",
                request.task_id,
                request.session_id,
                discarded
            );
            Ok(LoopxAgentFinishResult {
                session_id: request.session_id,
                discarded,
            })
        })
    }

    fn reset(&self, request: LoopxAgentResetRequest) -> LoopxHostFuture<'_, LoopxAgentResetResult> {
        Box::pin(async move {
            let path_manager =
                crate::infrastructure::try_get_path_manager_arc().map_err(|error| {
                    host_error(
                        LoopxHostPortErrorKind::Backend,
                        error.to_string(),
                        &request.operation_id,
                    )
                })?;
            let root = crate::service::session_projection_store::runtime_event_log_dir(
                path_manager.as_ref(),
            );
            let mut entries = match tokio::fs::read_dir(&root).await {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(LoopxAgentResetResult::default())
                }
                Err(error) => {
                    return Err(host_error(
                        LoopxHostPortErrorKind::Io,
                        format!("Failed to read LoopX runtime event directory: {error}"),
                        &request.operation_id,
                    ))
                }
            };
            let mut removed = 0_u32;
            while let Some(entry) = entries.next_entry().await.map_err(|error| {
                host_error(
                    LoopxHostPortErrorKind::Io,
                    format!("Failed to enumerate LoopX runtime event logs: {error}"),
                    &request.operation_id,
                )
            })? {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("loopx-") || !name.ends_with(".jsonl") {
                    continue;
                }
                if !entry
                    .file_type()
                    .await
                    .map_err(|error| {
                        host_error(
                            LoopxHostPortErrorKind::Io,
                            format!("Failed to inspect LoopX runtime event log: {error}"),
                            &request.operation_id,
                        )
                    })?
                    .is_file()
                {
                    continue;
                }
                tokio::fs::remove_file(entry.path())
                    .await
                    .map_err(|error| {
                        host_error(
                            LoopxHostPortErrorKind::Io,
                            format!("Failed to remove LoopX runtime event log: {error}"),
                            &request.operation_id,
                        )
                    })?;
                removed = removed.saturating_add(1);
            }
            Ok(LoopxAgentResetResult {
                removed_runtime_event_logs: removed,
            })
        })
    }

    fn output_since(
        &self,
        request: LoopxAgentOutputSinceRequest,
    ) -> LoopxHostFuture<'_, LoopxAgentOutputSinceResult> {
        Box::pin(async move {
            let path_manager =
                crate::infrastructure::try_get_path_manager_arc().map_err(|error| {
                    host_error(
                        LoopxHostPortErrorKind::Backend,
                        error.to_string(),
                        &request.operation_id,
                    )
                })?;
            let root = crate::service::session_projection_store::runtime_event_log_dir(
                path_manager.as_ref(),
            );
            let page = crate::service::session_projection_store::read_runtime_events_since(
                &root,
                &request.session_id,
                request.stream_id.as_deref(),
                request.after_cursor,
                request.limit,
            )
            .map_err(|error| {
                host_error(LoopxHostPortErrorKind::Io, error, &request.operation_id)
            })?;
            let Some(page) = page else {
                return Ok(LoopxAgentOutputSinceResult {
                    next_cursor: request.after_cursor,
                    ..LoopxAgentOutputSinceResult::default()
                });
            };
            let events = page
                .events
                .into_iter()
                .filter_map(|record| {
                    turn_output_event(record.cursor, &request.turn_id, record.event)
                })
                .collect();
            Ok(LoopxAgentOutputSinceResult {
                stream_id: Some(page.stream_id),
                events,
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
        })
    }
}

fn turn_output_event(
    cursor: u64,
    expected_turn_id: &str,
    event: AgenticEvent,
) -> Option<LoopxTurnOutputEvent> {
    if event.turn_id() != Some(expected_turn_id) {
        return None;
    }
    match event {
        AgenticEvent::TextChunk {
            turn_id,
            round_id,
            text,
            ..
        } => Some(LoopxTurnOutputEvent {
            cursor,
            turn_id,
            round_id: Some(round_id),
            kind: LoopxTurnOutputEventKind::Text,
            text: Some(text),
            ..LoopxTurnOutputEvent::default()
        }),
        AgenticEvent::ThinkingChunk {
            turn_id,
            round_id,
            content,
            is_end,
            ..
        } => Some(LoopxTurnOutputEvent {
            cursor,
            turn_id,
            round_id: Some(round_id),
            kind: LoopxTurnOutputEventKind::Thinking,
            text: Some(content),
            is_end,
            ..LoopxTurnOutputEvent::default()
        }),
        AgenticEvent::ModelRoundStarted {
            turn_id,
            round_id,
            effective_model_name,
            ..
        } => Some(LoopxTurnOutputEvent {
            cursor,
            turn_id,
            round_id: Some(round_id),
            kind: LoopxTurnOutputEventKind::ModelRoundStarted,
            text: Some(format!("Model round started: {effective_model_name}")),
            ..LoopxTurnOutputEvent::default()
        }),
        AgenticEvent::ModelRoundCompleted {
            turn_id,
            round_id,
            duration_ms,
            ..
        } => Some(LoopxTurnOutputEvent {
            cursor,
            turn_id,
            round_id: Some(round_id),
            kind: LoopxTurnOutputEventKind::ModelRoundCompleted,
            text: Some(match duration_ms {
                Some(value) => format!("Model round completed in {value} ms"),
                None => "Model round completed".to_string(),
            }),
            ..LoopxTurnOutputEvent::default()
        }),
        AgenticEvent::ToolEvent {
            turn_id,
            round_id,
            tool_event,
            ..
        } => {
            let activity = project_tool_activity(&tool_event)?;
            let text = activity
                .details
                .get("summary")
                .cloned()
                .unwrap_or(activity.message);
            Some(LoopxTurnOutputEvent {
                cursor,
                turn_id,
                round_id: Some(round_id),
                kind: LoopxTurnOutputEventKind::Tool,
                text: Some(text),
                tool_name: Some(activity.tool_name),
                tool_state: Some(activity.state.to_string()),
                ..LoopxTurnOutputEvent::default()
            })
        }
        _ => None,
    }
}

fn loopx_session_metadata(
    request: &LoopxAgentStartRequest,
) -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::from_iter([
        ("surface".to_string(), serde_json::json!("miniapp_agent")),
        ("appId".to_string(), serde_json::json!(LOOPX_BUILTIN_APP_ID)),
        (
            "loopxTaskId".to_string(),
            serde_json::json!(request.task_id.clone()),
        ),
        (
            "generation".to_string(),
            serde_json::json!(request.generation),
        ),
        (
            "goalId".to_string(),
            serde_json::json!(request.metadata.goal_id.clone()),
        ),
        (
            "loopxTurnId".to_string(),
            serde_json::json!(request.metadata.loopx_turn_id.clone()),
        ),
        (
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            serde_json::json!(PermissionMode::AutoApprove.as_str()),
        ),
    ])
}

fn map_port_error(
    error: openbitfun_runtime_ports::PortError,
    operation_id: &str,
) -> LoopxHostPortError {
    host_error(
        LoopxHostPortErrorKind::Backend,
        error.to_string(),
        operation_id,
    )
}

fn host_error(
    kind: LoopxHostPortErrorKind,
    message: impl Into<String>,
    operation_id: &str,
) -> LoopxHostPortError {
    LoopxHostPortError {
        kind,
        message: message.into(),
        operation_id: Some(operation_id.to_string()),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_events::{ToolEventData, ToolEventIdentity};
    use openbitfun_product_domains::miniapp::loopx::{
        LoopxAgentTurnMetadata, LoopxIssueKey, LoopxItemKind, LoopxRepositoryKey,
        LOOPX_REQUIRED_PERMISSION_SCOPES,
    };

    #[test]
    fn loopx_sessions_use_the_transient_miniapp_surface_contract() {
        let request = LoopxAgentStartRequest {
            task_id: "task-1".to_string(),
            generation: 2,
            granted_scopes: LOOPX_REQUIRED_PERMISSION_SCOPES.to_vec(),
            metadata: LoopxAgentTurnMetadata {
                goal_id: "goal-1".to_string(),
                loopx_turn_id: "turn-1".to_string(),
                item: LoopxIssueKey {
                    repository: LoopxRepositoryKey {
                        host: "github.com".to_string(),
                        owner: "owner".to_string(),
                        repository: "repo".to_string(),
                    },
                    kind: LoopxItemKind::Issue,
                    number: 42,
                },
                attempt: 1,
            },
            ..LoopxAgentStartRequest::default()
        };

        let metadata = loopx_session_metadata(&request);
        assert_eq!(metadata["surface"], serde_json::json!("miniapp_agent"));
        assert_eq!(metadata["appId"], serde_json::json!(LOOPX_BUILTIN_APP_ID));
        assert_eq!(
            metadata[PERMISSION_MODE_CONTEXT_KEY],
            serde_json::json!(PermissionMode::AutoApprove.as_str())
        );
    }

    #[test]
    fn live_output_omits_partial_tool_parameters() {
        let event = AgenticEvent::ToolEvent {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            tool_event: ToolEventData::ParamsPartial {
                identity: ToolEventIdentity::direct("tool-1", "ExecCommand"),
                params: "{\"cmd\":\"cargo".to_string(),
            },
        };

        assert!(turn_output_event(1, "turn-1", event).is_none());
    }
}
