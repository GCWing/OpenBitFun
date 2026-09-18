use std::collections::{HashMap, HashSet};

use crossterm::event::KeyEvent;
use openbitfun_agent_runtime::sdk::{
    AgentSessionLifecycleStatus, AgentSessionLineageEntry, AgentSessionLineageSnapshot,
};
use ratatui::{layout::Rect, Frame};

use crate::ui::{
    conversation_selector::{
        ConversationPoint, ConversationSelectorAction, ConversationSelectorState,
    },
    theme::Theme,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionLineageAction {
    None,
    Move(String),
    Select(String),
    Close,
}

pub(super) struct SessionLineageSelectorState {
    selector: ConversationSelectorState,
}

impl SessionLineageSelectorState {
    pub(super) fn new() -> Self {
        Self {
            selector: ConversationSelectorState::new("View subagents", "Inspect"),
        }
    }

    pub(super) fn show(&mut self, snapshot: &AgentSessionLineageSnapshot) {
        self.selector.show(lineage_points(snapshot));
    }

    pub(super) fn hide(&mut self) {
        self.selector.hide();
    }

    pub(super) fn reshow(&mut self) {
        self.selector.reshow();
    }

    pub(super) fn is_visible(&self) -> bool {
        self.selector.is_visible()
    }

    pub(super) fn handle_key_event(&mut self, key: KeyEvent) -> SessionLineageAction {
        match self.selector.handle_key_event(key) {
            ConversationSelectorAction::Move(id) => SessionLineageAction::Move(id),
            ConversationSelectorAction::Select(id) => SessionLineageAction::Select(id),
            ConversationSelectorAction::Close => SessionLineageAction::Close,
            ConversationSelectorAction::None => SessionLineageAction::None,
        }
    }

    pub(super) fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        self.selector.render(frame, area, theme);
    }
}

fn lineage_points(snapshot: &AgentSessionLineageSnapshot) -> Vec<ConversationPoint> {
    let parent_by_id = snapshot
        .sessions
        .iter()
        .map(|entry| {
            (
                entry.session_id.as_str(),
                entry.parent_session_id.as_deref(),
            )
        })
        .collect::<HashMap<_, _>>();
    snapshot
        .sessions
        .iter()
        .filter(|entry| entry.session_id != snapshot.root_session_id)
        .map(|entry| {
            let depth = lineage_depth(entry, &snapshot.root_session_id, &parent_by_id);
            let title = format!(
                "{}{}",
                "  ".repeat(depth.saturating_sub(1)),
                entry.agent_id.as_deref().unwrap_or(&entry.session_name)
            );
            let kind = entry
                .subagent_type
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&entry.agent_type);
            ConversationPoint::new(
                entry.session_id.clone(),
                title,
                format!("{} · {kind}", lineage_status_label(entry)),
            )
        })
        .collect()
}

fn lineage_depth<'a>(
    entry: &'a AgentSessionLineageEntry,
    root_session_id: &str,
    parent_by_id: &HashMap<&'a str, Option<&'a str>>,
) -> usize {
    let mut depth = 1usize;
    let mut current = entry.parent_session_id.as_deref();
    let mut visited = HashSet::from([entry.session_id.as_str()]);
    while let Some(parent) = current {
        if parent == root_session_id || !visited.insert(parent) {
            break;
        }
        depth = depth.saturating_add(1);
        current = parent_by_id.get(parent).copied().flatten();
    }
    depth
}

fn lineage_status_label(entry: &AgentSessionLineageEntry) -> &'static str {
    if entry.active_turn_id.is_some() {
        return "running";
    }
    match entry.status {
        AgentSessionLifecycleStatus::Active => "idle",
        AgentSessionLifecycleStatus::Archived => "archived",
        AgentSessionLifecycleStatus::Completed => "completed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, parent: Option<&str>, created_at_ms: u64) -> AgentSessionLineageEntry {
        AgentSessionLineageEntry {
            session_id: id.to_string(),
            session_name: id.to_string(),
            agent_type: "explore".to_string(),
            created_at_ms,
            status: AgentSessionLifecycleStatus::Completed,
            active_turn_id: None,
            parent_session_id: parent.map(str::to_string),
            parent_tool_call_id: None,
            subagent_type: Some("explore".to_string()),
            agent_id: Some(id.to_string()),
            workspace_id: None,
            workspace_path: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            unread_completion: None,
            needs_user_attention: None,
        }
    }

    #[test]
    fn active_turn_is_distinct_from_an_idle_active_session() {
        let mut idle = entry("idle", Some("root"), 1);
        idle.status = AgentSessionLifecycleStatus::Active;
        let mut running = idle.clone();
        running.active_turn_id = Some("turn-live".to_string());

        assert_eq!(lineage_status_label(&idle), "idle");
        assert_eq!(lineage_status_label(&running), "running");
    }

    #[test]
    fn selector_preserves_owner_order_and_indents_nested_descendants() {
        let snapshot = AgentSessionLineageSnapshot {
            root_session_id: "root".to_string(),
            sessions: vec![
                entry("root", None, 1),
                entry("child", Some("root"), 2),
                entry("grandchild", Some("child"), 3),
            ],
        };
        let points = lineage_points(&snapshot);

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].id, "child");
        assert_eq!(points[1].id, "grandchild");
        assert_eq!(points[1].title, "  grandchild");
    }

    #[test]
    fn selector_prefers_the_runtime_agent_id() {
        let mut child = entry("child", Some("root"), 2);
        child.session_name = "Generated session title".to_string();
        child.agent_id = Some("parser-review".to_string());
        let snapshot = AgentSessionLineageSnapshot {
            root_session_id: "root".to_string(),
            sessions: vec![entry("root", None, 1), child],
        };

        assert_eq!(lineage_points(&snapshot)[0].title, "parser-review");
    }

    #[test]
    fn cyclic_legacy_parentage_remains_bounded() {
        let snapshot = AgentSessionLineageSnapshot {
            root_session_id: "root".to_string(),
            sessions: vec![
                entry("root", None, 1),
                entry("first", Some("second"), 2),
                entry("second", Some("first"), 3),
            ],
        };

        assert_eq!(lineage_points(&snapshot).len(), 2);
    }
}
