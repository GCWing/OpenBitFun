//! Session lineage and branch metadata mutation rules.

use super::normalized_session_relationship;
use super::types::{
    DialogTurnData, SessionMetadata, SessionRelationship, SessionRelationshipKind, SessionStatus,
};
use openbitfun_core_types::SessionKind;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};

const LINEAGE_CUSTOM_METADATA_KEYS: &[&str] = &[
    "kind",
    "parentSessionId",
    "parentRequestId",
    "parentDialogTurnId",
    "parentTurnIndex",
    "parentToolCallId",
    "subagentType",
];

const BRANCH_EXCLUDED_TAGS: &[&str] = &["btw", "review", "deep_review", "miniapp", "subagent"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubagentRelationshipFacts {
    kind: SessionRelationshipKind,
    parent_session_id: String,
    parent_dialog_turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLineageSnapshot {
    pub root_session_id: String,
    pub sessions: Vec<SessionMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBranchRequest {
    pub source_session_id: String,
    pub source_turn_id: String,
    #[serde(
        default,
        skip_serializing_if = "SessionBranchBoundary::is_through_turn"
    )]
    pub boundary: SessionBranchBoundary,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionBranchBoundary {
    #[default]
    ThroughTurn,
    BeforeTurn,
}

impl SessionBranchBoundary {
    pub const fn is_through_turn(&self) -> bool {
        matches!(self, Self::ThroughTurn)
    }

    pub const fn copied_turn_count(self, source_turn_index: usize) -> usize {
        match self {
            Self::ThroughTurn => source_turn_index + 1,
            Self::BeforeTurn => source_turn_index,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBranchResult {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchSessionLineage {
    pub base_session_name: String,
    /// Positive ordinal allocated in the base session-title namespace.
    pub ordinal: usize,
}

#[derive(Debug, Clone)]
pub struct BranchSessionMetadataFacts<'a> {
    pub source_metadata: &'a SessionMetadata,
    pub target_session_id: String,
    pub target_session_name: String,
    pub target_agent_type: String,
    pub source_session_id: &'a str,
    pub source_turn_id: &'a str,
    pub source_turn_index: usize,
    pub boundary: SessionBranchBoundary,
    pub branched_turns: &'a [DialogTurnData],
    pub branch_lineage: &'a BranchSessionLineage,
    pub now_ms: u64,
}

/// Resolves the title namespace and the next compact branch title.
///
/// A title matching the inherited `base title (N)` keeps that title namespace,
/// even when a user changed `N`; any other renamed title becomes a new base.
/// The next ordinal is allocated from matching titles across the workspace, not
/// from the fork root, so nested forks do not accumulate suffixes.
pub fn resolve_branch_session_lineage(
    source_metadata: &SessionMetadata,
    source_session_name: &str,
    metadata_list: &[SessionMetadata],
) -> BranchSessionLineage {
    let source_session_name = source_session_name.trim();
    let base_session_name = fork_base_session_name(source_metadata)
        .filter(|base_session_name| {
            branch_session_name_ordinal(source_session_name, base_session_name).is_some()
        })
        .unwrap_or_else(|| source_session_name.to_string());

    let max_ordinal = std::iter::once(source_session_name)
        .chain(
            metadata_list
                .iter()
                .map(|metadata| metadata.session_name.as_str()),
        )
        .filter_map(|session_name| branch_session_name_ordinal(session_name, &base_session_name))
        .max()
        .unwrap_or_default();

    BranchSessionLineage {
        base_session_name,
        ordinal: max_ordinal.saturating_add(1),
    }
}

pub fn format_branch_session_name(base_session_name: &str, ordinal: usize) -> String {
    format!("{base_session_name} ({ordinal})")
}

fn branch_session_name_ordinal(session_name: &str, base_session_name: &str) -> Option<usize> {
    let suffix = session_name
        .trim()
        .strip_prefix(base_session_name)?
        .strip_prefix(" (")?
        .strip_suffix(')')?;
    suffix.parse::<usize>().ok().filter(|value| *value > 0)
}

pub fn apply_session_lineage(metadata: &mut SessionMetadata, relationship: SessionRelationship) {
    metadata.relationship = Some(relationship);
    metadata.custom_metadata = strip_lineage_custom_metadata(metadata.custom_metadata.take());
}

fn strip_lineage_custom_metadata(value: Option<JsonValue>) -> Option<JsonValue> {
    let Some(JsonValue::Object(mut metadata)) = value else {
        return None;
    };

    for key in LINEAGE_CUSTOM_METADATA_KEYS {
        metadata.remove(*key);
    }

    (!metadata.is_empty()).then_some(JsonValue::Object(metadata))
}

fn extract_subagent_relationship(metadata: &SessionMetadata) -> Option<SubagentRelationshipFacts> {
    let relationship = normalized_session_relationship(metadata)?;
    let kind = relationship.kind?;
    let parent_session_id = relationship.parent_session_id?;
    let parent_dialog_turn_id = relationship.parent_dialog_turn_id?;

    Some(SubagentRelationshipFacts {
        kind,
        parent_session_id,
        parent_dialog_turn_id,
    })
}

pub fn collect_hidden_subagent_cascade(
    metadata_list: impl IntoIterator<Item = SessionMetadata>,
    parent_session_id: &str,
    parent_dialog_turn_ids: &HashSet<String>,
) -> Vec<String> {
    if parent_session_id.trim().is_empty() || parent_dialog_turn_ids.is_empty() {
        return Vec::new();
    }

    let mut child_session_ids_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut root_session_ids = Vec::new();

    for metadata in metadata_list {
        let Some(relationship) = extract_subagent_relationship(&metadata) else {
            continue;
        };

        if relationship.kind != SessionRelationshipKind::Subagent {
            continue;
        }

        child_session_ids_by_parent
            .entry(relationship.parent_session_id.clone())
            .or_default()
            .push(metadata.session_id.clone());

        if relationship.parent_session_id == parent_session_id
            && parent_dialog_turn_ids.contains(&relationship.parent_dialog_turn_id)
        {
            root_session_ids.push(metadata.session_id);
        }
    }

    let mut visited = HashSet::new();
    let mut ordered_session_ids = Vec::new();

    for root_session_id in root_session_ids {
        collect_subagent_post_order(
            &root_session_id,
            &child_session_ids_by_parent,
            &mut visited,
            &mut ordered_session_ids,
        );
    }

    ordered_session_ids
}

/// Builds the complete subagent Session tree containing `anchor_session_id`.
///
/// The snapshot stays flat so callers can project it for their own surface
/// without making recursive serialization depth part of the contract.
pub fn build_session_lineage_snapshot(
    metadata_list: impl IntoIterator<Item = SessionMetadata>,
    anchor_session_id: &str,
) -> Option<SessionLineageSnapshot> {
    let anchor_session_id = anchor_session_id.trim();
    if anchor_session_id.is_empty() {
        return None;
    }

    let metadata_by_id = metadata_list
        .into_iter()
        .map(|metadata| (metadata.session_id.clone(), metadata))
        .collect::<HashMap<_, _>>();
    if !metadata_by_id.contains_key(anchor_session_id) {
        return None;
    }

    let mut root_session_id = anchor_session_id.to_string();
    let mut ancestor_ids = HashSet::from([root_session_id.clone()]);
    while let Some(parent_session_id) = metadata_by_id
        .get(&root_session_id)
        .and_then(subagent_parent_session_id)
        .filter(|parent_session_id| metadata_by_id.contains_key(parent_session_id))
    {
        if !ancestor_ids.insert(parent_session_id.clone()) {
            root_session_id = anchor_session_id.to_string();
            break;
        }
        root_session_id = parent_session_id;
    }

    let mut children_by_parent = HashMap::<String, Vec<String>>::new();
    for metadata in metadata_by_id.values() {
        let Some(parent_session_id) = subagent_parent_session_id(metadata) else {
            continue;
        };
        if metadata_by_id.contains_key(&parent_session_id) {
            children_by_parent
                .entry(parent_session_id)
                .or_default()
                .push(metadata.session_id.clone());
        }
    }
    for child_session_ids in children_by_parent.values_mut() {
        child_session_ids.sort_by(|left, right| {
            let left_metadata = metadata_by_id
                .get(left)
                .expect("lineage child metadata should exist");
            let right_metadata = metadata_by_id
                .get(right)
                .expect("lineage child metadata should exist");
            left_metadata
                .created_at
                .cmp(&right_metadata.created_at)
                .then_with(|| left.cmp(right))
        });
    }

    let mut visited = HashSet::new();
    let mut ordered_session_ids = Vec::new();
    collect_subagent_pre_order(
        &root_session_id,
        &children_by_parent,
        &mut visited,
        &mut ordered_session_ids,
    );

    Some(SessionLineageSnapshot {
        root_session_id,
        sessions: ordered_session_ids
            .into_iter()
            .filter_map(|session_id| metadata_by_id.get(&session_id).cloned())
            .collect(),
    })
}

fn subagent_parent_session_id(metadata: &SessionMetadata) -> Option<String> {
    let relationship = normalized_session_relationship(metadata)?;
    if relationship.kind != Some(SessionRelationshipKind::Subagent) {
        return None;
    }

    relationship
        .parent_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn collect_subagent_pre_order(
    session_id: &str,
    child_session_ids_by_parent: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    ordered_session_ids: &mut Vec<String>,
) {
    if !visited.insert(session_id.to_string()) {
        return;
    }

    ordered_session_ids.push(session_id.to_string());
    if let Some(child_session_ids) = child_session_ids_by_parent.get(session_id) {
        for child_session_id in child_session_ids {
            collect_subagent_pre_order(
                child_session_id,
                child_session_ids_by_parent,
                visited,
                ordered_session_ids,
            );
        }
    }
}

fn collect_subagent_post_order(
    session_id: &str,
    child_session_ids_by_parent: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    ordered_session_ids: &mut Vec<String>,
) {
    if !visited.insert(session_id.to_string()) {
        return;
    }

    if let Some(child_session_ids) = child_session_ids_by_parent.get(session_id) {
        for child_session_id in child_session_ids {
            collect_subagent_post_order(
                child_session_id,
                child_session_ids_by_parent,
                visited,
                ordered_session_ids,
            );
        }
    }

    ordered_session_ids.push(session_id.to_string());
}

pub fn build_branched_session_metadata(facts: BranchSessionMetadataFacts<'_>) -> SessionMetadata {
    let mut metadata = facts.source_metadata.clone();
    metadata.session_id = facts.target_session_id;
    metadata.session_name = facts.target_session_name;
    metadata.agent_type = facts.target_agent_type;
    metadata.created_by = None;
    metadata.session_kind = SessionKind::Standard;
    metadata.created_at = facts.now_ms;
    metadata.last_active_at = facts.now_ms;
    metadata.last_finished_at = None;
    metadata.turn_count = facts.branched_turns.len();
    metadata.message_count = facts
        .branched_turns
        .iter()
        .map(estimate_turn_message_count)
        .sum();
    metadata.tool_call_count = facts
        .branched_turns
        .iter()
        .map(DialogTurnData::count_tool_calls)
        .sum();
    metadata.status = SessionStatus::Active;
    metadata.snapshot_session_id = None;
    metadata
        .tags
        .retain(|tag| !BRANCH_EXCLUDED_TAGS.contains(&tag.as_str()));
    metadata.custom_metadata = build_branch_custom_metadata(
        facts.source_metadata.custom_metadata.as_ref(),
        facts.source_session_id,
        facts.source_turn_id,
        facts.source_turn_index,
        facts.boundary,
        facts.branch_lineage,
    );
    if metadata
        .current_context_usage
        .as_ref()
        .is_some_and(|usage| {
            !facts
                .branched_turns
                .iter()
                .any(|turn| turn.turn_id == usage.turn_id)
        })
    {
        metadata.current_context_usage = None;
    }
    metadata.relationship = None;
    metadata.todos = None;
    metadata.review_action_state = None;
    metadata.deep_review_run_manifest = None;
    metadata.review_target_evidence = None;
    metadata.unread_completion = None;
    metadata.needs_user_attention = None;
    metadata
}

fn estimate_turn_message_count(turn: &DialogTurnData) -> usize {
    1 + turn
        .model_rounds
        .iter()
        .map(|round| round.text_items.len())
        .sum::<usize>()
}

fn strip_child_session_metadata(value: Option<&JsonValue>) -> Option<JsonValue> {
    let Some(JsonValue::Object(existing)) = value else {
        return None;
    };

    let mut next = existing.clone();
    for key in [
        "kind",
        "parentSessionId",
        "parentRequestId",
        "parentDialogTurnId",
        "parentTurnIndex",
    ] {
        next.remove(key);
    }
    Some(JsonValue::Object(next))
}

fn build_branch_custom_metadata(
    source_metadata: Option<&JsonValue>,
    source_session_id: &str,
    source_turn_id: &str,
    source_turn_index: usize,
    boundary: SessionBranchBoundary,
    branch_lineage: &BranchSessionLineage,
) -> Option<JsonValue> {
    let mut base = match strip_child_session_metadata(source_metadata) {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };

    let mut fork_origin = serde_json::json!({
        "sessionId": source_session_id,
        "turnId": source_turn_id,
        "turnIndex": boundary.copied_turn_count(source_turn_index),
        "baseTitle": branch_lineage.base_session_name,
    });
    if boundary == SessionBranchBoundary::BeforeTurn {
        fork_origin["boundary"] = JsonValue::String("before_turn".to_string());
    }
    base.insert("forkOrigin".to_string(), fork_origin);

    Some(JsonValue::Object(base))
}

fn fork_base_session_name(metadata: &SessionMetadata) -> Option<String> {
    metadata
        .custom_metadata
        .as_ref()?
        .get("forkOrigin")?
        .get("baseTitle")?
        .as_str()
        .and_then(normalize_nonempty)
}

fn normalize_nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        ModelRoundData, SessionContextUsage, SessionContextUsageSource, SessionMetadata,
        SessionRelationship, SessionRelationshipKind, TextItemData, ToolCallData, ToolItemData,
        UserMessageData,
    };
    use serde_json::json;

    fn metadata(session_id: &str) -> SessionMetadata {
        SessionMetadata::new(
            session_id.to_string(),
            format!("Session {session_id}"),
            "Standard".to_string(),
            "model".to_string(),
        )
    }

    fn turn(session_id: &str, turn_id: &str, turn_index: usize) -> DialogTurnData {
        let mut turn = DialogTurnData::new(
            turn_id.to_string(),
            turn_index,
            session_id.to_string(),
            UserMessageData {
                id: format!("user-{turn_id}"),
                content: format!("prompt {turn_id}"),
                timestamp: 1,
                metadata: None,
            },
        );
        turn.model_rounds.push(ModelRoundData {
            id: format!("round-{turn_id}"),
            turn_id: turn_id.to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 1,
            text_items: vec![
                TextItemData {
                    id: "text-1".to_string(),
                    content: "answer".to_string(),
                    is_streaming: false,
                    timestamp: 1,
                    is_markdown: true,
                    order_index: None,
                    is_subagent_item: None,
                    parent_task_tool_id: None,
                    subagent_session_id: None,
                    status: None,
                    attempt_id: None,
                    attempt_index: None,
                },
                TextItemData {
                    id: "text-2".to_string(),
                    content: "details".to_string(),
                    is_streaming: false,
                    timestamp: 1,
                    is_markdown: true,
                    order_index: None,
                    is_subagent_item: None,
                    parent_task_tool_id: None,
                    subagent_session_id: None,
                    status: None,
                    attempt_id: None,
                    attempt_index: None,
                },
            ],
            tool_items: vec![ToolItemData {
                id: "tool-1".to_string(),
                tool_name: "Read".to_string(),
                tool_call: ToolCallData {
                    id: "call-1".to_string(),
                    input: json!({ "file_path": "src/lib.rs" }),
                },
                tool_result: None,
                ai_intent: None,
                start_time: 1,
                end_time: Some(2),
                duration_ms: Some(1),
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
                order_index: None,
                is_subagent_item: None,
                parent_task_tool_id: None,
                subagent_session_id: None,
                subagent_dialog_turn_id: None,
                attempt_id: None,
                attempt_index: None,
                subagent_model_id: None,
                subagent_model_display_name: None,
                status: Some("completed".to_string()),
                interruption_reason: None,
            }],
            thinking_items: Vec::new(),
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            routing: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            ttft_ms: None,
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        });
        turn.mark_completed();
        turn
    }

    #[test]
    fn apply_session_lineage_sets_relationship_and_removes_legacy_projection() {
        let mut value = metadata("child");
        value.custom_metadata = Some(json!({
            "kind": "subagent",
            "parentSessionId": "old-parent",
            "parentRequestId": "old-request",
            "parentDialogTurnId": "old-turn",
            "parentTurnIndex": 1,
            "parentToolCallId": "old-tool",
            "subagentType": "Explore",
            "preserved": "kept"
        }));

        apply_session_lineage(
            &mut value,
            SessionRelationship {
                kind: Some(SessionRelationshipKind::DeepReview),
                parent_session_id: Some("parent".to_string()),
                parent_request_id: Some("request".to_string()),
                parent_dialog_turn_id: Some("turn".to_string()),
                parent_turn_index: Some(2),
                parent_tool_call_id: None,
                subagent_type: None,
                continuation_policy: None,
            },
        );

        assert_eq!(
            value
                .relationship
                .as_ref()
                .and_then(|value| value.kind.clone()),
            Some(SessionRelationshipKind::DeepReview)
        );
        let custom_metadata = value
            .custom_metadata
            .expect("preserved metadata should remain");
        assert_eq!(custom_metadata["preserved"], "kept");
        assert!(custom_metadata.get("kind").is_none());
        assert!(custom_metadata.get("parentSessionId").is_none());
        assert!(custom_metadata.get("subagentType").is_none());
    }

    #[test]
    fn collect_hidden_subagent_cascade_returns_post_order_matches() {
        let mut root = metadata("child-root");
        root.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn-2".to_string()),
            parent_turn_index: Some(2),
            parent_tool_call_id: None,
            subagent_type: None,
            continuation_policy: None,
        });

        let mut grandchild = metadata("grandchild");
        grandchild.custom_metadata = Some(json!({
            "kind": "subagent",
            "parentSessionId": "child-root",
            "parentDialogTurnId": "turn-3"
        }));

        let unrelated = metadata("other");
        let parent_turns = HashSet::from(["turn-2".to_string()]);

        let cascade = collect_hidden_subagent_cascade(
            vec![root, grandchild, unrelated],
            "parent",
            &parent_turns,
        );

        assert_eq!(
            cascade,
            vec!["grandchild".to_string(), "child-root".to_string()]
        );
    }

    #[test]
    fn session_lineage_snapshot_resolves_root_and_orders_descendants() {
        let root = metadata("root");
        let mut later_child = metadata("child-b");
        later_child.created_at = 30;
        later_child.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("root".to_string()),
            ..Default::default()
        });
        let mut earlier_child = metadata("child-a");
        earlier_child.created_at = 20;
        earlier_child.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("root".to_string()),
            ..Default::default()
        });
        let mut grandchild = metadata("grandchild");
        grandchild.created_at = 40;
        grandchild.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("child-a".to_string()),
            ..Default::default()
        });

        let snapshot = build_session_lineage_snapshot(
            vec![later_child, grandchild, root, earlier_child],
            "grandchild",
        )
        .expect("lineage should exist");

        assert_eq!(snapshot.root_session_id, "root");
        assert_eq!(
            snapshot
                .sessions
                .iter()
                .map(|metadata| metadata.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "child-a", "grandchild", "child-b"]
        );
    }

    #[test]
    fn session_lineage_snapshot_keeps_non_subagent_children_out() {
        let root = metadata("root");
        let mut review = metadata("review");
        review.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Review),
            parent_session_id: Some("root".to_string()),
            ..Default::default()
        });

        let snapshot =
            build_session_lineage_snapshot(vec![root, review], "root").expect("root should exist");

        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].session_id, "root");
    }

    #[test]
    fn session_lineage_snapshot_tolerates_cycles() {
        let mut first = metadata("first");
        first.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("second".to_string()),
            ..Default::default()
        });
        let mut second = metadata("second");
        second.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("first".to_string()),
            ..Default::default()
        });

        let snapshot = build_session_lineage_snapshot(vec![first, second], "first")
            .expect("cyclic lineage should remain inspectable");

        assert_eq!(snapshot.root_session_id, "first");
        assert_eq!(snapshot.sessions.len(), 2);
    }

    #[test]
    fn build_branched_session_metadata_resets_child_state_and_counts_turns() {
        let mut source = metadata("source");
        source.created_by = Some("creator".to_string());
        source.session_kind = SessionKind::Subagent;
        source.status = SessionStatus::Completed;
        source.snapshot_session_id = Some("snapshot".to_string());
        source.tags = vec![
            "btw".to_string(),
            "kept".to_string(),
            "deep_review".to_string(),
        ];
        source.custom_metadata = Some(json!({
            "parentSessionId": "legacy-parent",
            "parentDialogTurnId": "legacy-turn",
            "preserved": "value"
        }));
        source.current_context_usage = Some(SessionContextUsage {
            turn_id: "turn-3".to_string(),
            input_tokens: 50_000,
            output_tokens: Some(500),
            total_tokens: 50_500,
            timestamp: 40,
            source: SessionContextUsageSource::ModelRequest,
        });
        source.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn".to_string()),
            parent_turn_index: Some(1),
            parent_tool_call_id: None,
            subagent_type: None,
            continuation_policy: None,
        });
        source.todos = Some(json!([{ "id": "todo" }]));
        source.deep_review_run_manifest = Some(json!({ "run": "manifest" }));
        source.unread_completion = Some("completed".to_string());
        source.needs_user_attention = Some("ask_user".to_string());
        let turns = vec![turn("target", "turn-1", 0), turn("target", "turn-2", 1)];
        let branch_lineage = BranchSessionLineage {
            base_session_name: "Source".to_string(),
            ordinal: 1,
        };

        let branched = build_branched_session_metadata(BranchSessionMetadataFacts {
            source_metadata: &source,
            target_session_id: "target".to_string(),
            target_session_name: "Target".to_string(),
            target_agent_type: "coding".to_string(),
            source_session_id: "source",
            source_turn_id: "turn-2",
            source_turn_index: 1,
            boundary: SessionBranchBoundary::ThroughTurn,
            branched_turns: &turns,
            branch_lineage: &branch_lineage,
            now_ms: 42,
        });

        assert_eq!(branched.session_id, "target");
        assert_eq!(branched.session_name, "Target");
        assert_eq!(branched.agent_type, "coding");
        assert_eq!(branched.session_kind, SessionKind::Standard);
        assert_eq!(branched.created_at, 42);
        assert_eq!(branched.last_active_at, 42);
        assert_eq!(branched.turn_count, 2);
        assert_eq!(branched.message_count, 6);
        assert_eq!(branched.tool_call_count, 2);
        assert_eq!(branched.status, SessionStatus::Active);
        assert_eq!(branched.tags, vec!["kept".to_string()]);
        assert!(branched.relationship.is_none());
        assert!(branched.todos.is_none());
        assert!(branched.deep_review_run_manifest.is_none());
        assert!(branched.unread_completion.is_none());
        assert!(branched.needs_user_attention.is_none());
        assert!(branched.current_context_usage.is_none());

        let custom_metadata = branched
            .custom_metadata
            .expect("fork metadata should exist");
        assert_eq!(custom_metadata["preserved"], "value");
        assert!(custom_metadata.get("parentSessionId").is_none());
        assert_eq!(
            custom_metadata["forkOrigin"],
            json!({
                "sessionId": "source",
                "turnId": "turn-2",
                "turnIndex": 2,
                "baseTitle": "Source"
            })
        );
    }

    #[test]
    fn build_branched_session_metadata_keeps_usage_for_a_copied_turn() {
        let mut source = metadata("source");
        source.current_context_usage = Some(SessionContextUsage {
            turn_id: "turn-2".to_string(),
            input_tokens: 2_000,
            output_tokens: Some(200),
            total_tokens: 2_200,
            timestamp: 40,
            source: SessionContextUsageSource::ModelRequest,
        });
        let turns = vec![turn("target", "turn-1", 0), turn("target", "turn-2", 1)];
        let branch_lineage = BranchSessionLineage {
            base_session_name: "Source".to_string(),
            ordinal: 1,
        };

        let branched = build_branched_session_metadata(BranchSessionMetadataFacts {
            source_metadata: &source,
            target_session_id: "target".to_string(),
            target_session_name: "Target".to_string(),
            target_agent_type: "Standard".to_string(),
            source_session_id: "source",
            source_turn_id: "turn-2",
            source_turn_index: 1,
            boundary: SessionBranchBoundary::ThroughTurn,
            branched_turns: &turns,
            branch_lineage: &branch_lineage,
            now_ms: 42,
        });

        assert_eq!(branched.current_context_usage, source.current_context_usage);
    }

    #[test]
    fn branch_lineage_uses_the_inherited_title_namespace_for_renamed_suffixes() {
        let mut root = metadata("root");
        root.session_name = "Title".to_string();

        let mut first_branch = metadata("first-branch");
        first_branch.session_name = "Title (2)".to_string();
        first_branch.custom_metadata = Some(json!({
            "forkOrigin": {
                "sessionId": "root",
                "turnId": "turn-0",
                "turnIndex": 1,
                "baseTitle": "Title"
            }
        }));

        let nested_lineage = resolve_branch_session_lineage(
            &first_branch,
            &first_branch.session_name,
            &[root.clone(), first_branch.clone()],
        );
        assert_eq!(nested_lineage.base_session_name, "Title");
        assert_eq!(nested_lineage.ordinal, 3);
        assert_eq!(
            format_branch_session_name(&nested_lineage.base_session_name, nested_lineage.ordinal),
            "Title (3)"
        );

        let mut second_branch = metadata("second-branch");
        second_branch.session_name = "Title (3)".to_string();
        second_branch.custom_metadata = Some(json!({
            "forkOrigin": {
                "sessionId": "first-branch",
                "turnId": "turn-0",
                "turnIndex": 1,
                "baseTitle": "Title"
            }
        }));

        let sibling_lineage = resolve_branch_session_lineage(
            &root,
            &root.session_name,
            &[root.clone(), first_branch, second_branch],
        );
        assert_eq!(sibling_lineage.base_session_name, "Title");
        assert_eq!(sibling_lineage.ordinal, 4);
    }

    #[test]
    fn branch_lineage_treats_an_unrelated_suffix_as_a_new_title_base() {
        let mut root = metadata("root");
        root.session_name = "Title".to_string();
        let mut branch = metadata("branch");
        branch.session_name = "Another title (2)".to_string();
        branch.custom_metadata = Some(json!({
            "forkOrigin": {
                "sessionId": "root",
                "turnId": "turn-0",
                "turnIndex": 1,
                "baseTitle": "Title"
            }
        }));

        let lineage =
            resolve_branch_session_lineage(&branch, &branch.session_name, &[root, branch.clone()]);
        assert_eq!(lineage.base_session_name, "Another title (2)");
        assert_eq!(lineage.ordinal, 1);
        assert_eq!(
            format_branch_session_name(&lineage.base_session_name, lineage.ordinal),
            "Another title (2) (1)"
        );
    }
}
