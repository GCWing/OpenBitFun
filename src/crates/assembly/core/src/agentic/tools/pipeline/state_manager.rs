//! Tool state manager
//!
//! Manages the status and lifecycle of tool execution tasks

use super::types::ToolTask;
use crate::agentic::core::ToolExecutionState;
use crate::agentic::events::AgenticEvent;
use dashmap::DashMap;
use log::debug;
use openbitfun_agent_stream::StreamEventSink;
use openbitfun_agent_tools::ValidationResult;
use std::sync::Arc;
use tool_runtime::pipeline::{
    count_tool_states, tool_state_event_data, ToolStateEventFacts, ToolStateEventKind,
    ToolTaskStateKind,
};

pub(crate) fn tool_task_state_kind(state: &ToolExecutionState) -> ToolTaskStateKind {
    match state {
        ToolExecutionState::Queued { .. } => ToolTaskStateKind::Queued,
        ToolExecutionState::Waiting { .. } => ToolTaskStateKind::Waiting,
        ToolExecutionState::Running { .. } => ToolTaskStateKind::Running,
        ToolExecutionState::Streaming { .. } => ToolTaskStateKind::Streaming,
        ToolExecutionState::Completed { .. } => ToolTaskStateKind::Completed,
        ToolExecutionState::Failed { .. } => ToolTaskStateKind::Failed,
        ToolExecutionState::Rejected { .. } => ToolTaskStateKind::Rejected,
        ToolExecutionState::Cancelled { .. } => ToolTaskStateKind::Cancelled,
    }
}

/// Tool state manager
pub struct ToolStateManager {
    /// Tool task status (by tool ID)
    tasks: Arc<DashMap<String, ToolTask>>,

    /// Event sink
    event_sink: Arc<dyn StreamEventSink>,
}

impl ToolStateManager {
    pub fn new<E>(event_sink: Arc<E>) -> Self
    where
        E: StreamEventSink + 'static,
    {
        Self {
            tasks: Arc::new(DashMap::new()),
            event_sink,
        }
    }

    /// Create task
    pub async fn create_task(&self, task: ToolTask) -> String {
        let tool_id = task.tool_call.tool_id.clone();
        self.tasks.insert(tool_id.clone(), task);
        tool_id
    }

    /// Update task state
    pub async fn update_state(&self, tool_id: &str, new_state: ToolExecutionState) {
        let task_for_event = if let Some(mut task) = self.tasks.get_mut(tool_id) {
            let old_state = task.state.clone();
            task.state = new_state.clone();

            // Update timestamp
            let new_state_kind = tool_task_state_kind(&new_state);
            if new_state_kind.starts_execution_timer() {
                task.started_at = Some(std::time::SystemTime::now());
            }
            if new_state_kind.completes_execution_timer() {
                task.completed_at = Some(std::time::SystemTime::now());
            }

            debug!(
                "Tool state changed: tool_id={}, old_state={:?}, new_state={:?}",
                tool_id,
                format!("{:?}", old_state).split('{').next().unwrap_or(""),
                format!("{:?}", new_state).split('{').next().unwrap_or("")
            );

            Some(task.clone())
        } else {
            None
        };

        if let Some(task) = task_for_event {
            self.emit_state_change_event(task).await;
        }
    }

    /// Get task
    pub fn get_task(&self, tool_id: &str) -> Option<ToolTask> {
        self.tasks.get(tool_id).map(|t| t.clone())
    }

    /// Apply a PreToolUse `updatedInput` proposal and preserve any rejection
    /// raised by non-relaxable validation of the original effective input.
    pub fn apply_hook_input_rewrite(
        &self,
        tool_id: &str,
        arguments: serde_json::Value,
        rejection: Option<ValidationResult>,
    ) -> bool {
        if let Some(mut task) = self.tasks.get_mut(tool_id) {
            task.invocation.effective_arguments = arguments;
            task.input_rewrite_rejection = rejection;
            true
        } else {
            false
        }
    }

    /// Update the tool-owned cooperative preemption token after final hook
    /// arguments have determined the execution traits.
    pub fn set_round_injection_preemption_token(
        &self,
        tool_id: &str,
        token: Option<tokio_util::sync::CancellationToken>,
    ) -> bool {
        if let Some(mut task) = self.tasks.get_mut(tool_id) {
            task.round_injection_preemption_token = token;
            true
        } else {
            false
        }
    }

    /// Get all tasks of a session
    pub fn get_session_tasks(&self, session_id: &str) -> Vec<ToolTask> {
        self.tasks
            .iter()
            .filter(|entry| entry.value().context.session_id == session_id)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Get all tasks of a dialog turn
    pub fn get_dialog_turn_tasks(&self, dialog_turn_id: &str) -> Vec<ToolTask> {
        self.tasks
            .iter()
            .filter(|entry| entry.value().context.dialog_turn_id == dialog_turn_id)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Delete task
    pub fn remove_task(&self, tool_id: &str) {
        self.tasks.remove(tool_id);
    }

    /// Clear all tasks of a session
    pub fn clear_session(&self, session_id: &str) {
        let to_remove: Vec<_> = self
            .tasks
            .iter()
            .filter(|entry| entry.value().context.session_id == session_id)
            .map(|entry| entry.key().clone())
            .collect();

        for tool_id in to_remove {
            self.tasks.remove(&tool_id);
        }

        debug!("Cleared session tool tasks: session_id={}", session_id);
    }

    /// Send state change event (full version)
    async fn emit_state_change_event(&self, task: ToolTask) {
        let state = match &task.state {
            ToolExecutionState::Queued { position } => ToolStateEventKind::Queued {
                position: *position,
            },
            ToolExecutionState::Waiting { dependencies } => ToolStateEventKind::Waiting {
                dependencies: dependencies.clone(),
            },
            ToolExecutionState::Running { .. } => ToolStateEventKind::Running {
                params: task.invocation.wire_arguments.clone(),
                timeout_seconds: task.options.timeout_secs,
            },
            ToolExecutionState::Streaming {
                chunks_received, ..
            } => ToolStateEventKind::Streaming {
                chunks_received: *chunks_received,
            },
            ToolExecutionState::Completed {
                result,
                duration_ms,
                queue_wait_ms,
                preflight_ms,
                confirmation_wait_ms,
                execution_ms,
            } => ToolStateEventKind::Completed {
                params: Some(task.invocation.wire_arguments.clone()),
                result: result.content(),
                result_for_assistant: match result {
                    crate::agentic::tools::framework::ToolResult::Result {
                        result_for_assistant,
                        ..
                    } => result_for_assistant.clone(),
                    _ => None,
                },
                image_attachments: match result {
                    crate::agentic::tools::framework::ToolResult::Result {
                        image_attachments,
                        ..
                    } => image_attachments.clone(),
                    _ => None,
                },
                duration_ms: *duration_ms,
                queue_wait_ms: *queue_wait_ms,
                preflight_ms: *preflight_ms,
                confirmation_wait_ms: *confirmation_wait_ms,
                execution_ms: *execution_ms,
            },
            ToolExecutionState::Failed {
                error,
                is_retryable: _,
                duration_ms,
                queue_wait_ms,
                preflight_ms,
                confirmation_wait_ms,
                execution_ms,
            } => ToolStateEventKind::Failed {
                params: Some(task.invocation.wire_arguments.clone()),
                error: error.clone(),
                duration_ms: *duration_ms,
                queue_wait_ms: *queue_wait_ms,
                preflight_ms: *preflight_ms,
                confirmation_wait_ms: *confirmation_wait_ms,
                execution_ms: *execution_ms,
            },
            ToolExecutionState::Rejected { .. } => ToolStateEventKind::Rejected,
            ToolExecutionState::Cancelled {
                reason,
                duration_ms,
                queue_wait_ms,
                preflight_ms,
                confirmation_wait_ms,
                execution_ms,
            } => ToolStateEventKind::Cancelled {
                params: Some(task.invocation.wire_arguments.clone()),
                reason: reason.clone(),
                duration_ms: *duration_ms,
                queue_wait_ms: *queue_wait_ms,
                preflight_ms: *preflight_ms,
                confirmation_wait_ms: *confirmation_wait_ms,
                execution_ms: *execution_ms,
            },
        };
        let tool_event = tool_state_event_data(ToolStateEventFacts {
            identity: openbitfun_events::ToolEventIdentity::resolved(
                task.tool_call.tool_id.clone(),
                task.invocation.wire_tool_name.clone(),
                task.effective_tool_name().to_string(),
            ),
            state,
        });

        let event = AgenticEvent::ToolEvent {
            session_id: task.context.session_id,
            turn_id: task.context.dialog_turn_id,
            round_id: task.context.round_id,
            attempt_id: task.context.attempt_id,
            attempt_index: task.context.attempt_index,
            tool_event,
        };

        self.event_sink.enqueue(event, None).await;
    }

    /// Get statistics
    pub fn get_stats(&self) -> ToolStats {
        let tasks: Vec<_> = self.tasks.iter().map(|e| e.value().clone()).collect();
        let counts = count_tool_states(tasks.iter().map(|task| tool_task_state_kind(&task.state)));

        ToolStats {
            total: counts.total,
            queued: counts.queued,
            waiting: counts.waiting,
            running: counts.running,
            streaming: counts.streaming,
            completed: counts.completed,
            failed: counts.failed,
            rejected: counts.rejected,
            cancelled: counts.cancelled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::{ToolExecutionContext, ToolExecutionOptions, ToolTask};
    use super::*;
    use crate::agentic::core::ToolCall;
    use std::collections::HashMap;
    use std::time::Duration;
    use tokio::time::timeout;

    #[derive(Default)]
    struct CapturingEventSink {
        events: tokio::sync::Mutex<Vec<AgenticEvent>>,
    }

    #[async_trait::async_trait]
    impl StreamEventSink for CapturingEventSink {
        async fn enqueue(
            &self,
            event: AgenticEvent,
            _priority: Option<openbitfun_events::AgenticEventPriority>,
        ) {
            self.events.lock().await.push(event);
        }
    }

    struct BlockingEventSink {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl StreamEventSink for BlockingEventSink {
        async fn enqueue(
            &self,
            _event: AgenticEvent,
            _priority: Option<openbitfun_events::AgenticEventPriority>,
        ) {
            self.started.notify_one();
            self.release.notified().await;
        }
    }

    fn test_task(tool_id: &str) -> ToolTask {
        ToolTask::new(
            ToolCall {
                tool_id: tool_id.to_string(),
                tool_name: "test_tool".to_string(),
                arguments: serde_json::json!({}),
                raw_arguments: None,
                is_error: false,
                parse_error: None,
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            },
            ToolExecutionContext {
                session_id: "session-1".to_string(),
                dialog_turn_id: "turn-1".to_string(),
                round_id: "round-1".to_string(),
                attempt_id: None,
                attempt_index: None,
                agent_type: "Standard".to_string(),
                workspace: None,
                primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
                context_vars: HashMap::new(),
                subagent_parent_info: None,
                permission_delegation: None,
                delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level(),
                deferred_tools: Vec::new(),
                loaded_deferred_tool_specs: Vec::new(),
                allowed_tools: Vec::new(),
                runtime_tool_restrictions: Default::default(),
                steering_interrupt: None,
                workspace_services: None,
                terminal_port: None,
                remote_exec_port: None,
            },
            ToolExecutionOptions::default(),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_state_does_not_hold_task_lock_while_emitting_event() {
        let event_sink = Arc::new(BlockingEventSink {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let manager = Arc::new(ToolStateManager::new(event_sink.clone()));
        let tool_id = manager.create_task(test_task("tool-1")).await;

        let update_manager = manager.clone();
        let update_tool_id = tool_id.clone();
        let update_handle = tokio::spawn(async move {
            update_manager
                .update_state(
                    &update_tool_id,
                    ToolExecutionState::Running {
                        started_at: std::time::SystemTime::now(),
                        progress: None,
                    },
                )
                .await;
        });

        event_sink.started.notified().await;

        let read_manager = manager.clone();
        let read_tool_id = tool_id.clone();
        let read_handle = tokio::task::spawn_blocking(move || read_manager.get_task(&read_tool_id));

        let task = timeout(Duration::from_millis(100), read_handle)
            .await
            .expect("reading task state should not wait for event emission")
            .expect("blocking task should complete");
        assert!(task.is_some());

        event_sink.release.notify_one();
        timeout(Duration::from_secs(1), update_handle)
            .await
            .expect("state update should finish after event queue is released")
            .expect("state update task should not panic");
    }

    #[tokio::test]
    async fn deferred_started_event_keeps_wire_input_and_effective_name() {
        let wire_arguments = serde_json::json!({
            "tool_name": "CreatePlan",
            "args": { "name": "Plan" }
        });
        let mut task = test_task("tool-1");
        task.tool_call.tool_name = openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string();
        task.tool_call.arguments = wire_arguments.clone();
        task.invocation = openbitfun_agent_tools::ResolvedToolInvocation::from_wire_call(
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
            wire_arguments.clone(),
        )
        .expect("valid deferred invocation");

        let sink = Arc::new(CapturingEventSink::default());
        let manager = ToolStateManager::new(sink.clone());
        let tool_id = manager.create_task(task).await;
        manager
            .update_state(
                &tool_id,
                ToolExecutionState::Running {
                    started_at: std::time::SystemTime::now(),
                    progress: None,
                },
            )
            .await;

        let events = sink.events.lock().await;
        let AgenticEvent::ToolEvent {
            tool_event:
                openbitfun_events::ToolEventData::Started {
                    identity, params, ..
                },
            ..
        } = &events[0]
        else {
            panic!("expected started event");
        };
        assert_eq!(
            identity.tool_name,
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME
        );
        assert_eq!(identity.effective_name(), "CreatePlan");
        assert_eq!(params, &wire_arguments);
    }
}

/// Tool statistics
#[derive(Debug, Clone, Default)]
pub struct ToolStats {
    pub total: usize,
    pub queued: usize,
    pub waiting: usize,
    pub running: usize,
    pub streaming: usize,
    pub completed: usize,
    pub failed: usize,
    pub rejected: usize,
    pub cancelled: usize,
}
