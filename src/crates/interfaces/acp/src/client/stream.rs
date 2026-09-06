use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, SessionConfigOption, SessionNotification, SessionUpdate, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::util::MatchDispatch;
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_events::ToolEventData;

use super::session_options::{AcpAvailableCommand, AcpPlanEntry, AcpSessionContextUsage};
use super::tool_card_bridge::{acp_tool_name, normalize_tool_params, normalize_tool_result};

#[derive(Debug, Clone)]
pub enum AcpClientStreamEvent {
    ModelRoundStarted {
        round_id: String,
        round_index: usize,
        disable_explore_grouping: bool,
    },
    AgentText(String),
    AgentThought(String),
    ToolEvent(ToolEventData),
    ContextUsageUpdated(AcpSessionContextUsage),
    AvailableCommandsUpdated(Vec<AcpAvailableCommand>),
    PlanUpdated(Vec<AcpPlanEntry>),
    ConfigOptionsUpdated(Vec<SessionConfigOption>),
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcpStreamItemKind {
    Text,
    Tool,
}

#[derive(Debug, Default)]
pub(super) struct AcpStreamRoundTracker {
    next_round_index: usize,
    last_item_kind: Option<AcpStreamItemKind>,
}

#[derive(Debug, Default)]
pub(super) struct AcpToolCallTracker {
    calls: HashMap<String, AcpToolCallSnapshot>,
}

#[derive(Debug, Clone)]
struct AcpToolCallSnapshot {
    title: String,
    tool_name: String,
    /// Shared to avoid deep-copying potentially large tool inputs (e.g. full
    /// Edit/Write payloads) on every ToolCall/ToolCallUpdate notification.
    raw_input: Option<Arc<serde_json::Value>>,
    kind: Option<agent_client_protocol::schema::ToolKind>,
}

/// Turns a shared raw_input into an owned Value, cloning only when the tracker
/// still holds another reference.
fn materialize_raw_input(raw_input: Arc<serde_json::Value>) -> serde_json::Value {
    Arc::try_unwrap(raw_input).unwrap_or_else(|shared| (*shared).clone())
}

impl AcpStreamRoundTracker {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn apply(&mut self, event: AcpClientStreamEvent) -> Vec<AcpClientStreamEvent> {
        match event {
            AcpClientStreamEvent::AgentText(_) | AcpClientStreamEvent::AgentThought(_) => {
                let mut events = Vec::new();
                if self.last_item_kind.is_none()
                    || self.last_item_kind == Some(AcpStreamItemKind::Tool)
                {
                    events.push(self.next_round_started_event());
                }
                self.last_item_kind = Some(AcpStreamItemKind::Text);
                events.push(event);
                events
            }
            AcpClientStreamEvent::ToolEvent(_) => {
                let mut events = Vec::new();
                if self.last_item_kind.is_none() {
                    events.push(self.next_round_started_event());
                }
                self.last_item_kind = Some(AcpStreamItemKind::Tool);
                events.push(event);
                events
            }
            AcpClientStreamEvent::ModelRoundStarted { .. }
            | AcpClientStreamEvent::ContextUsageUpdated(_)
            | AcpClientStreamEvent::AvailableCommandsUpdated(_)
            | AcpClientStreamEvent::PlanUpdated(_)
            | AcpClientStreamEvent::ConfigOptionsUpdated(_)
            | AcpClientStreamEvent::Completed
            | AcpClientStreamEvent::Cancelled => vec![event],
        }
    }

    fn next_round_started_event(&mut self) -> AcpClientStreamEvent {
        let round_index = self.next_round_index;
        self.next_round_index += 1;
        AcpClientStreamEvent::ModelRoundStarted {
            round_id: format!(
                "round_{}_{}",
                chrono::Utc::now().timestamp_millis(),
                uuid::Uuid::new_v4()
            ),
            round_index,
            disable_explore_grouping: true,
        }
    }
}

pub(super) async fn acp_dispatch_to_stream_events_with_tracker(
    dispatch: agent_client_protocol::Dispatch,
    tracker: &mut AcpToolCallTracker,
) -> OpenBitFunResult<Vec<AcpClientStreamEvent>> {
    let mut events = Vec::new();
    MatchDispatch::new(dispatch)
        .if_notification(async |notification: SessionNotification| {
            match notification.update {
                SessionUpdate::AgentMessageChunk(chunk) => {
                    if let Some(text) = content_chunk_text(chunk) {
                        events.push(AcpClientStreamEvent::AgentText(text));
                    }
                }
                SessionUpdate::AgentThoughtChunk(chunk) => {
                    if let Some(text) = content_chunk_text(chunk) {
                        events.push(AcpClientStreamEvent::AgentThought(text));
                    }
                }
                SessionUpdate::ToolCall(tool_call) => {
                    events.extend(acp_tool_call_events(tool_call, tracker));
                }
                SessionUpdate::ToolCallUpdate(tool_call_update) => {
                    events.extend(acp_tool_call_update_events(tool_call_update, tracker));
                }
                SessionUpdate::UsageUpdate(usage_update) => {
                    events.push(AcpClientStreamEvent::ContextUsageUpdated(
                        AcpSessionContextUsage::from(usage_update),
                    ));
                }
                SessionUpdate::AvailableCommandsUpdate(update) => {
                    events.push(AcpClientStreamEvent::AvailableCommandsUpdated(
                        update
                            .available_commands
                            .into_iter()
                            .map(AcpAvailableCommand::from)
                            .collect(),
                    ));
                }
                SessionUpdate::Plan(plan) => {
                    events.push(AcpClientStreamEvent::PlanUpdated(
                        plan.entries.into_iter().map(AcpPlanEntry::from).collect(),
                    ));
                }
                SessionUpdate::ConfigOptionUpdate(update) => {
                    events.push(AcpClientStreamEvent::ConfigOptionsUpdated(
                        update.config_options,
                    ));
                }
                _ => {}
            }
            Ok(())
        })
        .await
        .otherwise_ignore()
        .map_err(protocol_error)?;
    Ok(events)
}

fn content_chunk_text(chunk: ContentChunk) -> Option<String> {
    match chunk.content {
        ContentBlock::Text(text) => Some(text.text),
        _ => None,
    }
}

impl AcpToolCallTracker {
    pub(super) fn new() -> Self {
        Self::default()
    }

    fn upsert_from_call(
        &mut self,
        tool_id: String,
        title: String,
        raw_input: Option<serde_json::Value>,
        kind: Option<agent_client_protocol::schema::ToolKind>,
    ) -> AcpToolCallSnapshot {
        let raw_input = raw_input.map(Arc::new);
        let tool_name = acp_tool_name(&title, raw_input.as_deref(), kind.as_ref());
        let snapshot = AcpToolCallSnapshot {
            title,
            tool_name,
            raw_input,
            kind,
        };
        self.calls.insert(tool_id, snapshot.clone());
        snapshot
    }

    fn update_from_fields(
        &mut self,
        tool_id: &str,
        title: Option<String>,
        raw_input: Option<serde_json::Value>,
        kind: Option<agent_client_protocol::schema::ToolKind>,
    ) -> AcpToolCallSnapshot {
        let previous = self.calls.get(tool_id);
        let title = title
            .or_else(|| previous.map(|snapshot| snapshot.title.clone()))
            .unwrap_or_else(|| tool_id.to_string());
        let raw_input = raw_input
            .map(Arc::new)
            .or_else(|| previous.and_then(|snapshot| snapshot.raw_input.clone()));
        let kind = kind.or_else(|| previous.and_then(|snapshot| snapshot.kind));
        let tool_name = acp_tool_name(&title, raw_input.as_deref(), kind.as_ref());
        let snapshot = AcpToolCallSnapshot {
            title,
            tool_name,
            raw_input,
            kind,
        };
        self.calls.insert(tool_id.to_string(), snapshot.clone());
        snapshot
    }
}

fn acp_tool_call_events(
    tool_call: ToolCall,
    tracker: &mut AcpToolCallTracker,
) -> Vec<AcpClientStreamEvent> {
    let tool_id = tool_call.tool_call_id.to_string();
    let snapshot = tracker.upsert_from_call(
        tool_id.clone(),
        tool_call.title.clone(),
        tool_call.raw_input,
        Some(tool_call.kind),
    );
    let tool_name = snapshot.tool_name;
    let params = normalize_tool_params(
        &tool_name,
        snapshot
            .raw_input
            .map(materialize_raw_input)
            .unwrap_or_else(|| {
                serde_json::json!({
                    "title": tool_call.title,
                    "kind": format!("{:?}", tool_call.kind),
                })
            }),
    );

    let mut events = vec![AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
        identity: openbitfun_events::ToolEventIdentity::direct(tool_id.clone(), tool_name.clone()),
        params,
        timeout_seconds: None,
    })];

    match tool_call.status {
        ToolCallStatus::Completed => {
            let result = acp_tool_result_value(
                &tool_name,
                tool_call.raw_output,
                Some(tool_call.content),
                Some(tool_call.locations),
            );
            events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Completed {
                params: None,
                identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                result,
                result_for_assistant: None,
                image_attachments: None,
                duration_ms: 0,
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
            }));
        }
        ToolCallStatus::Failed => {
            events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Failed {
                params: None,
                identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                error: acp_tool_error_text(tool_call.raw_output, tool_call.content),
                duration_ms: None,
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
            }));
        }
        ToolCallStatus::Pending | ToolCallStatus::InProgress => {}
        _ => {}
    }

    events
}

fn acp_tool_call_update_events(
    update: ToolCallUpdate,
    tracker: &mut AcpToolCallTracker,
) -> Vec<AcpClientStreamEvent> {
    let tool_id = update.tool_call_id.to_string();
    let snapshot = tracker.update_from_fields(
        &tool_id,
        update.fields.title.clone(),
        update.fields.raw_input,
        update.fields.kind,
    );
    let tool_name = snapshot.tool_name.clone();

    match update.fields.status {
        Some(ToolCallStatus::Completed) => {
            let mut events = Vec::new();
            let input_params = snapshot
                .raw_input
                .as_ref()
                .map(|raw| normalize_tool_params(&tool_name, materialize_raw_input(raw.clone())));
            if let Some(params) = input_params.clone() {
                events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
                    identity: openbitfun_events::ToolEventIdentity::direct(
                        tool_id.clone(),
                        tool_name.clone(),
                    ),
                    params,
                    timeout_seconds: None,
                }));
            }
            let result = acp_tool_result_value(
                &tool_name,
                update.fields.raw_output,
                update.fields.content,
                update.fields.locations,
            );
            events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Completed {
                params: input_params,
                identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                result,
                result_for_assistant: None,
                image_attachments: None,
                duration_ms: 0,
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
            }));
            events
        }
        Some(ToolCallStatus::Failed) => {
            let mut events = Vec::new();
            if let Some(raw_input) = snapshot.raw_input {
                events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
                    identity: openbitfun_events::ToolEventIdentity::direct(
                        tool_id.clone(),
                        tool_name.clone(),
                    ),
                    params: normalize_tool_params(&tool_name, materialize_raw_input(raw_input)),
                    timeout_seconds: None,
                }));
            }
            events.push(AcpClientStreamEvent::ToolEvent(ToolEventData::Failed {
                params: None,
                identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                error: acp_tool_error_text(
                    update.fields.raw_output,
                    update.fields.content.unwrap_or_default(),
                ),
                duration_ms: None,
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
            }));
            events
        }
        Some(ToolCallStatus::InProgress) | Some(ToolCallStatus::Pending) | Some(_) => {
            let params = normalize_tool_params(
                &tool_name,
                snapshot
                    .raw_input
                    .map(materialize_raw_input)
                    .unwrap_or_else(|| {
                        serde_json::json!({
                            "title": snapshot.title,
                        })
                    }),
            );
            vec![AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
                identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                params,
                timeout_seconds: None,
            })]
        }
        None => snapshot
            .raw_input
            .map(|params| {
                let params = normalize_tool_params(&tool_name, materialize_raw_input(params));
                vec![AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
                    identity: openbitfun_events::ToolEventIdentity::direct(tool_id, tool_name),
                    params,
                    timeout_seconds: None,
                })]
            })
            .unwrap_or_default(),
    }
}

fn acp_tool_result_value(
    tool_name: &str,
    raw_output: Option<serde_json::Value>,
    content: Option<Vec<ToolCallContent>>,
    locations: Option<Vec<agent_client_protocol::schema::ToolCallLocation>>,
) -> serde_json::Value {
    let value = match raw_output {
        Some(raw_output) => raw_output,
        None => {
            let content = content.unwrap_or_default();
            let locations = locations.unwrap_or_default();
            if content.is_empty() && locations.is_empty() {
                return serde_json::Value::Null;
            }
            serde_json::json!({
                "content": content,
                "locations": locations,
            })
        }
    };

    normalize_tool_result(tool_name, value)
}

fn acp_tool_error_text(
    raw_output: Option<serde_json::Value>,
    content: Vec<ToolCallContent>,
) -> String {
    if let Some(raw_output) = raw_output {
        return value_to_display_text(&raw_output);
    }
    if !content.is_empty() {
        return serde_json::to_string_pretty(&content).unwrap_or_else(|_| {
            serde_json::to_string(&content).unwrap_or_else(|_| "ACP tool failed".to_string())
        });
    }
    "ACP tool failed".to_string()
}

fn value_to_display_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn protocol_error(error: impl std::fmt::Display) -> OpenBitFunError {
    OpenBitFunError::service(format!("ACP protocol error: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::{ToolCallUpdateFields, ToolKind};
    use serde_json::json;

    fn tool_event(id: &str) -> AcpClientStreamEvent {
        AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
            identity: openbitfun_events::ToolEventIdentity::direct(id, "ExecCommand"),
            params: json!({ "cmd": "echo ok" }),
            timeout_seconds: None,
        })
    }

    fn event_kinds(events: &[AcpClientStreamEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|event| match event {
                AcpClientStreamEvent::ModelRoundStarted { .. } => "round",
                AcpClientStreamEvent::AgentText(_) => "text",
                AcpClientStreamEvent::AgentThought(_) => "thought",
                AcpClientStreamEvent::ToolEvent(_) => "tool",
                AcpClientStreamEvent::ContextUsageUpdated(_) => "usage",
                AcpClientStreamEvent::AvailableCommandsUpdated(_) => "commands",
                AcpClientStreamEvent::PlanUpdated(_) => "plan",
                AcpClientStreamEvent::ConfigOptionsUpdated(_) => "config_options",
                AcpClientStreamEvent::Completed => "completed",
                AcpClientStreamEvent::Cancelled => "cancelled",
            })
            .collect()
    }

    #[test]
    fn exposes_context_usage_updates() {
        use agent_client_protocol::JsonRpcMessage;

        let mut tracker = AcpToolCallTracker::new();
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::UsageUpdate(agent_client_protocol::schema::UsageUpdate::new(
                1_000, 4_000,
            )),
        )
        .to_untyped_message()
        .expect("notification");
        let dispatch = agent_client_protocol::Dispatch::Notification(notification);

        let events = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_dispatch_to_stream_events_with_tracker(
                dispatch,
                &mut tracker,
            ))
            .expect("dispatch");

        assert!(matches!(
            events.as_slice(),
            [AcpClientStreamEvent::ContextUsageUpdated(usage)] if usage.used == 1_000 && usage.size == 4_000
        ));
    }

    #[test]
    fn exposes_available_commands_updates() {
        use agent_client_protocol::schema::{AvailableCommand, AvailableCommandsUpdate};
        use agent_client_protocol::JsonRpcMessage;

        let mut tracker = AcpToolCallTracker::new();
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(vec![
                AvailableCommand::new("compact", "Compact the context"),
                AvailableCommand::new("init", "Initialize the project"),
            ])),
        )
        .to_untyped_message()
        .expect("notification");
        let dispatch = agent_client_protocol::Dispatch::Notification(notification);

        let events = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_dispatch_to_stream_events_with_tracker(
                dispatch,
                &mut tracker,
            ))
            .expect("dispatch");

        match events.as_slice() {
            [AcpClientStreamEvent::AvailableCommandsUpdated(commands)] => {
                assert_eq!(commands.len(), 2);
                assert_eq!(commands[0].name, "compact");
                assert_eq!(commands[1].name, "init");
            }
            other => panic!("expected AvailableCommandsUpdated, got {other:?}"),
        }
    }

    #[test]
    fn exposes_plan_updates() {
        use agent_client_protocol::schema::{Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus};
        use agent_client_protocol::JsonRpcMessage;

        let mut tracker = AcpToolCallTracker::new();
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::Plan(Plan::new(vec![
                PlanEntry::new(
                    "Explore",
                    PlanEntryPriority::High,
                    PlanEntryStatus::Completed,
                ),
                PlanEntry::new(
                    "Implement",
                    PlanEntryPriority::Medium,
                    PlanEntryStatus::InProgress,
                ),
            ])),
        )
        .to_untyped_message()
        .expect("notification");
        let dispatch = agent_client_protocol::Dispatch::Notification(notification);

        let events = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_dispatch_to_stream_events_with_tracker(
                dispatch,
                &mut tracker,
            ))
            .expect("dispatch");

        match events.as_slice() {
            [AcpClientStreamEvent::PlanUpdated(entries)] => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].content, "Explore");
                assert_eq!(entries[0].priority, "high");
                assert_eq!(entries[0].status, "completed");
                assert_eq!(entries[1].status, "in_progress");
            }
            other => panic!("expected PlanUpdated, got {other:?}"),
        }
    }

    #[test]
    fn exposes_config_option_updates() {
        use agent_client_protocol::schema::{ConfigOptionUpdate, SessionConfigOption};
        use agent_client_protocol::JsonRpcMessage;

        let mut tracker = AcpToolCallTracker::new();
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "fast",
                    vec![
                        agent_client_protocol::schema::SessionConfigSelectOption::new(
                            "fast", "Fast",
                        ),
                    ],
                ),
            ])),
        )
        .to_untyped_message()
        .expect("notification");
        let dispatch = agent_client_protocol::Dispatch::Notification(notification);

        let events = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_dispatch_to_stream_events_with_tracker(
                dispatch,
                &mut tracker,
            ))
            .expect("dispatch");

        assert!(matches!(
            events.as_slice(),
            [AcpClientStreamEvent::ConfigOptionsUpdated(options)] if options.len() == 1
        ));
    }

    #[test]
    fn starts_new_round_for_text_after_tool() {
        let mut tracker = AcpStreamRoundTracker::new();
        let mut events = Vec::new();
        events.extend(tracker.apply(AcpClientStreamEvent::AgentText("before".to_string())));
        events.extend(tracker.apply(tool_event("tool-1")));
        events.extend(tracker.apply(AcpClientStreamEvent::AgentText("after".to_string())));

        assert_eq!(
            event_kinds(&events),
            vec!["round", "text", "tool", "round", "text"]
        );
        assert!(matches!(
            events[0],
            AcpClientStreamEvent::ModelRoundStarted { round_index: 0, .. }
        ));
        assert!(matches!(
            events[3],
            AcpClientStreamEvent::ModelRoundStarted { round_index: 1, .. }
        ));
    }

    #[test]
    fn keeps_consecutive_tools_in_one_round_before_text() {
        let mut tracker = AcpStreamRoundTracker::new();
        let mut events = Vec::new();
        events.extend(tracker.apply(tool_event("tool-1")));
        events.extend(tracker.apply(tool_event("tool-2")));
        events.extend(tracker.apply(AcpClientStreamEvent::AgentText("done".to_string())));

        assert_eq!(
            event_kinds(&events),
            vec!["round", "tool", "tool", "round", "text"]
        );
    }

    #[test]
    fn keeps_consecutive_text_in_one_round() {
        let mut tracker = AcpStreamRoundTracker::new();
        let mut events = Vec::new();
        events.extend(tracker.apply(AcpClientStreamEvent::AgentText("a".to_string())));
        events.extend(tracker.apply(AcpClientStreamEvent::AgentText("b".to_string())));

        assert_eq!(event_kinds(&events), vec!["round", "text", "text"]);
    }

    #[test]
    fn tool_call_tracker_replays_cached_input_before_completed_update() {
        let mut tracker = AcpToolCallTracker::new();
        let in_progress = ToolCallUpdate::new(
            "tool-1",
            ToolCallUpdateFields::new()
                .title("Edit file")
                .kind(ToolKind::Edit)
                .status(ToolCallStatus::InProgress)
                .raw_input(json!({
                    "path": "src/lib.rs",
                    "oldString": "before",
                    "newString": "after"
                })),
        );
        let completed = ToolCallUpdate::new(
            "tool-1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .raw_output(json!({ "success": true })),
        );

        let first = acp_tool_call_update_events(in_progress, &mut tracker);
        assert!(matches!(
            first.first(),
            Some(AcpClientStreamEvent::ToolEvent(
                ToolEventData::Started { .. }
            ))
        ));

        let second = acp_tool_call_update_events(completed, &mut tracker);
        assert_eq!(second.len(), 2);
        match &second[0] {
            AcpClientStreamEvent::ToolEvent(ToolEventData::Started {
                identity, params, ..
            }) => {
                assert_eq!(identity.effective_name(), "Edit");
                assert_eq!(params["file_path"], "src/lib.rs");
                assert_eq!(params["old_string"], "before");
                assert_eq!(params["new_string"], "after");
            }
            other => panic!("expected cached Started event, got {other:?}"),
        }
        assert!(matches!(
            second[1],
            AcpClientStreamEvent::ToolEvent(ToolEventData::Completed { .. })
        ));
    }
}
