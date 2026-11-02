//! Bounded read-only projections of persisted conversation windows. Bodies stay
//! in the existing history reader; this response never transports tool results.
use super::{DialogTurnData, SessionTurnCatalog, SessionTurnWindowResponse};
use serde::{Deserialize, Serialize};

pub const TRAJECTORY_PAGE_SIZE: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryNode {
    pub id: String,
    pub turn_id: String,
    pub turn_ordinal: usize,
    pub kind: String,
    pub round_id: Option<String>,
    pub focus_item_id: Option<String>,
    pub label: String,
    pub preview: String,
    pub status: String,
    pub timestamp: u64,
    pub duration_ms: Option<u64>,
    pub matched: bool,
    pub match_field: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionTrajectoryPage {
    Ready {
        catalog_revision: String,
        start_ordinal: usize,
        end_ordinal_exclusive: usize,
        total_turn_count: usize,
        nodes: Vec<TrajectoryNode>,
        next_node_offset: Option<usize>,
    },
    Catalog {
        catalog: SessionTurnCatalog,
    },
    Stale {
        catalog: SessionTurnCatalog,
    },
    NotFound {
        catalog: SessionTurnCatalog,
    },
}

fn preview(value: &str) -> String {
    value.chars().take(160).collect()
}
fn contains(value: &str, query: &str) -> bool {
    !query.is_empty() && value.to_lowercase().contains(query)
}
fn json_contains(value: &serde_json::Value, query: &str) -> bool {
    if query.is_empty() {
        return false;
    }
    match value {
        serde_json::Value::String(value) => contains(value, query),
        serde_json::Value::Array(values) => values.iter().any(|v| json_contains(v, query)),
        serde_json::Value::Object(values) => values
            .iter()
            .any(|(k, v)| contains(k, query) || json_contains(v, query)),
        value => contains(&value.to_string(), query),
    }
}

fn project_turn(
    turn: &DialogTurnData,
    ordinal: usize,
    query: &str,
    accept: &mut impl FnMut() -> bool,
    emit: &mut impl FnMut(TrajectoryNode),
) {
    if !turn.kind.is_transcript_visible() {
        return;
    }
    if accept() {
        emit(TrajectoryNode {
            id: turn.user_message.id.clone(),
            turn_id: turn.turn_id.clone(),
            turn_ordinal: ordinal,
            kind: "user".into(),
            round_id: None,
            focus_item_id: None,
            label: String::new(),
            preview: preview(&turn.user_message.content),
            status: "completed".into(),
            timestamp: turn.user_message.timestamp,
            duration_ms: None,
            matched: contains(&turn.user_message.content, query),
            match_field: Some("content".into()),
        });
    }
    for round in &turn.model_rounds {
        if accept() {
            let label = round
                .effective_model_name
                .as_deref()
                .or(round.model_config_id.as_deref())
                .unwrap_or("");
            let text = round
                .text_items
                .iter()
                .find(|item| contains(&item.content, query));
            let thinking = round
                .thinking_items
                .iter()
                .find(|item| contains(&item.content, query));
            let focus = text
                .map(|item| item.id.clone())
                .or_else(|| thinking.map(|item| item.id.clone()))
                .or_else(|| round.text_items.first().map(|item| item.id.clone()))
                .or_else(|| round.thinking_items.first().map(|item| item.id.clone()))
                .or_else(|| round.tool_items.first().map(|item| item.id.clone()));
            emit(TrajectoryNode {
                id: round.id.clone(),
                turn_id: turn.turn_id.clone(),
                turn_ordinal: ordinal,
                kind: "model".into(),
                round_id: Some(round.id.clone()),
                focus_item_id: focus,
                label: preview(label),
                preview: preview(
                    text.map(|item| item.content.as_str())
                        .or_else(|| round.text_items.first().map(|item| item.content.as_str()))
                        .unwrap_or(""),
                ),
                status: round.status.clone(),
                timestamp: round.start_time,
                duration_ms: round.duration_ms,
                matched: contains(label, query) || text.is_some() || thinking.is_some(),
                match_field: if text.is_some() || thinking.is_some() {
                    Some("content".into())
                } else {
                    None
                },
            });
        }
        for tool in &round.tool_items {
            if !accept() {
                continue;
            }
            let field = if contains(&tool.tool_name, query) {
                Some("name")
            } else if json_contains(&tool.tool_call.input, query) {
                Some("parameters")
            } else if tool.tool_result.as_ref().is_some_and(|result| {
                json_contains(&result.result, query)
                    || result
                        .result_for_assistant
                        .as_ref()
                        .is_some_and(|s| contains(s, query))
                    || result.error.as_ref().is_some_and(|s| contains(s, query))
            }) {
                Some("result")
            } else {
                None
            };
            emit(TrajectoryNode {
                id: tool.id.clone(),
                turn_id: turn.turn_id.clone(),
                turn_ordinal: ordinal,
                kind: "tool".into(),
                round_id: Some(round.id.clone()),
                focus_item_id: Some(tool.id.clone()),
                label: preview(&tool.tool_name),
                preview: String::new(),
                status: tool.status.clone().unwrap_or_else(|| {
                    if tool.tool_result.as_ref().is_some_and(|r| r.success) {
                        "completed"
                    } else {
                        "unknown"
                    }
                    .into()
                }),
                timestamp: tool.start_time,
                duration_ms: tool.duration_ms,
                matched: field.is_some(),
                match_field: field.map(str::to_owned),
            });
        }
    }
}

pub fn project_session_trajectory(
    window: SessionTurnWindowResponse,
    query: &str,
    offset: usize,
) -> SessionTrajectoryPage {
    match window {
        SessionTurnWindowResponse::Ready {
            catalog_revision,
            start_ordinal,
            end_ordinal_exclusive,
            total_turn_count,
            turns,
            ..
        } => {
            let query = query.trim().to_lowercase();
            let mut nodes = Vec::with_capacity(TRAJECTORY_PAGE_SIZE);
            let mut count = 0usize;
            for (index, turn) in turns.iter().enumerate() {
                project_turn(
                    turn,
                    start_ordinal + index,
                    &query,
                    &mut || {
                        let include = count >= offset && count - offset < TRAJECTORY_PAGE_SIZE;
                        count += 1;
                        include
                    },
                    &mut |node| nodes.push(node),
                );
            }
            SessionTrajectoryPage::Ready {
                catalog_revision,
                start_ordinal,
                end_ordinal_exclusive,
                total_turn_count,
                next_node_offset: (count > offset.saturating_add(nodes.len()))
                    .then_some(offset.saturating_add(nodes.len())),
                nodes,
            }
        }
        SessionTurnWindowResponse::Stale { catalog } => SessionTrajectoryPage::Stale { catalog },
        SessionTurnWindowResponse::NotFound { catalog } => {
            SessionTrajectoryPage::NotFound { catalog }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn() -> DialogTurnData {
        serde_json::from_value(json!({
            "turnId":"turn", "turnIndex":7, "sessionId":"session", "timestamp":100,
            "userMessage":{"id":"user","content":"Find the needle","timestamp":100},
            "modelRounds":[{"id":"round","turnId":"turn","roundIndex":0,"timestamp":100,
                "startTime":100,"status":"completed",
                "textItems":[{"id":"text","content":"A needle","isStreaming":false,"timestamp":110}],
                "toolItems":[{"id":"tool","toolName":"Read","startTime":120,
                    "toolCall":{"id":"call","input":{"path":"/NEEDLE"}},
                    "toolResult":{"result":{"output":"FOUND"},"success":true}}]}],
            "startTime":100,"status":"completed"
        })).unwrap()
    }
    fn page(turns: Vec<DialogTurnData>, query: &str, offset: usize) -> SessionTrajectoryPage {
        project_session_trajectory(
            SessionTurnWindowResponse::Ready {
                catalog_revision: "revision".into(),
                total_turn_count: turns.len(),
                start_ordinal: 4,
                end_ordinal_exclusive: 4 + turns.len(),
                target_turn_id: "turn".into(),
                turns,
            },
            query,
            offset,
        )
    }
    #[test]
    fn legacy_records_keep_unknown_timing_and_search_concrete_sources() {
        let original = turn();
        let serialized = serde_json::to_value(&original).unwrap();
        let restored: DialogTurnData = serde_json::from_value(serialized).unwrap();
        let SessionTrajectoryPage::Ready { nodes, .. } = page(vec![restored], "needle", 0) else {
            panic!()
        };
        assert_eq!(nodes.len(), 3);
        assert!(nodes
            .iter()
            .all(|node| node.matched && node.turn_ordinal == 4));
        assert_eq!(nodes[1].focus_item_id.as_deref(), Some("text"));
        assert_eq!(nodes[2].match_field.as_deref(), Some("parameters"));
        assert!(nodes[2].duration_ms.is_none());
        let wire = serde_json::to_string(&nodes).unwrap();
        assert!(!wire.contains("/NEEDLE"));
        assert!(!wire.contains("FOUND"));
        let SessionTrajectoryPage::Ready { nodes, .. } = page(vec![original], "found", 0) else {
            panic!()
        };
        assert_eq!(nodes[2].match_field.as_deref(), Some("result"));
    }
    #[test]
    fn large_single_turn_is_bounded_and_cursor_continues_without_dropping_nodes() {
        let mut turn = turn();
        let template = turn.model_rounds[0].tool_items[0].clone();
        turn.model_rounds[0].tool_items = (0..600)
            .map(|i| {
                let mut tool = template.clone();
                tool.id = format!("tool-{i}");
                tool
            })
            .collect();
        let mut offset = 0;
        let mut ids = Vec::new();
        loop {
            let SessionTrajectoryPage::Ready {
                nodes,
                next_node_offset,
                ..
            } = page(vec![turn.clone()], "", offset)
            else {
                panic!()
            };
            assert!(nodes.len() <= TRAJECTORY_PAGE_SIZE);
            ids.extend(nodes.into_iter().map(|node| node.id));
            match next_node_offset {
                Some(next) => {
                    assert!(next > offset);
                    offset = next;
                }
                None => break,
            }
        }
        assert_eq!(ids.len(), 602);
        assert_eq!(
            ids.into_iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            602
        );
    }
    #[test]
    fn stale_catalog_is_preserved_instead_of_returning_empty_success() {
        let catalog = SessionTurnCatalog {
            schema_version: 1,
            session_id: "session".into(),
            revision: "new".into(),
            total_turn_count: 0,
            complete: true,
            entries: vec![],
        };
        let response =
            project_session_trajectory(SessionTurnWindowResponse::Stale { catalog }, "", 0);
        assert!(
            matches!(response, SessionTrajectoryPage::Stale { catalog } if catalog.revision == "new")
        );
    }
}
