//! Session metadata pagination and cursor shaping.

use super::types::{SessionMetadata, SessionStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadataPage {
    pub sessions: Vec<SessionMetadata>,
    pub total_top_level_count: usize,
    pub loaded_top_level_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub has_more: bool,
    /// Optional read-only extension. Absence identifies older hosts; an empty
    /// array is an authoritative empty status batch, not a missing capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activities: Option<Vec<SessionActivitySummary>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivitySummary {
    pub session_id: String,
    /// Runtime-owned execution fact; unknown external owners remain explicit.
    pub execution: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    pub pending_approvals: usize,
    pub pending_questions: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<super::types::SessionLastTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_completion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_turn: Option<super::types::SessionLastTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadataPageCursor {
    last_active_at: u64,
    session_id: String,
}

pub fn empty_session_metadata_page() -> SessionMetadataPage {
    SessionMetadataPage {
        sessions: Vec::new(),
        total_top_level_count: 0,
        loaded_top_level_count: 0,
        next_cursor: None,
        has_more: false,
        activities: None,
    }
}

pub fn build_session_metadata_page(
    indexed_sessions: Vec<SessionMetadata>,
    cursor: Option<&str>,
    limit: usize,
) -> SessionMetadataPage {
    let visible_sessions = indexed_sessions
        .into_iter()
        .filter(|metadata| {
            !metadata.should_hide_from_user_lists() && metadata.status != SessionStatus::Archived
        })
        .collect::<Vec<_>>();
    let visible_ids = visible_sessions
        .iter()
        .map(|metadata| metadata.session_id.clone())
        .collect::<HashSet<_>>();

    let mut top_level_sessions = Vec::new();
    let mut children_by_parent: HashMap<String, Vec<SessionMetadata>> = HashMap::new();
    for metadata in visible_sessions {
        if let Some(parent_id) = session_parent_id(&metadata) {
            if visible_ids.contains(&parent_id) {
                children_by_parent
                    .entry(parent_id)
                    .or_default()
                    .push(metadata);
                continue;
            }
        }

        top_level_sessions.push(metadata);
    }

    let total_top_level_count = top_level_sessions.len();
    let limit = limit.max(1);
    let offset = session_metadata_page_offset(cursor, &top_level_sessions);
    let offset = offset.min(total_top_level_count);
    let next_offset = offset.saturating_add(limit).min(total_top_level_count);
    let selected_top_level = top_level_sessions
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let loaded_top_level_count = selected_top_level.len();
    let has_more = next_offset < total_top_level_count;
    let next_cursor = has_more
        .then(|| selected_top_level.last().map(session_metadata_page_cursor))
        .flatten();

    let mut sessions = Vec::new();
    for metadata in selected_top_level {
        let session_id = metadata.session_id.clone();
        sessions.push(metadata);

        if let Some(mut children) = children_by_parent.remove(&session_id) {
            children.sort_by_key(|metadata| std::cmp::Reverse(metadata.last_active_at));
            sessions.extend(children);
        }
    }

    SessionMetadataPage {
        sessions,
        total_top_level_count,
        loaded_top_level_count,
        next_cursor,
        has_more,
        activities: None,
    }
}

fn session_parent_id(metadata: &SessionMetadata) -> Option<String> {
    if let Some(parent_id) = metadata
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.parent_session_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(parent_id.to_string());
    }

    metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| {
            custom
                .get("parentSessionId")
                .or_else(|| custom.get("parent_session_id"))
        })
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn session_metadata_page_offset(
    cursor: Option<&str>,
    top_level_sessions: &[SessionMetadata],
) -> usize {
    let Some(cursor) = cursor else {
        return 0;
    };

    if let Ok(parsed) = serde_json::from_str::<SessionMetadataPageCursor>(cursor) {
        if let Some(index) = top_level_sessions.iter().position(|metadata| {
            metadata.session_id == parsed.session_id
                && metadata.last_active_at == parsed.last_active_at
        }) {
            return index + 1;
        }

        if let Some(index) = top_level_sessions
            .iter()
            .position(|metadata| metadata.session_id == parsed.session_id)
        {
            return index + 1;
        }
    }

    cursor.parse::<usize>().unwrap_or(0)
}

fn session_metadata_page_cursor(metadata: &SessionMetadata) -> String {
    serde_json::to_string(&SessionMetadataPageCursor {
        last_active_at: metadata.last_active_at,
        session_id: metadata.session_id.clone(),
    })
    .unwrap_or_else(|_| metadata.session_id.clone())
}
