//! Session metadata construction, counters, and visible-index mutation rules.

use super::types::{
    DialogTurnData, DialogTurnKind, SessionLastTurn, SessionMemoryMode, SessionMetadata,
    SessionRelationship, SessionRelationshipKind, StoredSessionIndexFile, TurnStatus,
};
use openbitfun_core_types::{SessionExecutionTarget, SessionKind};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct SessionMetadataBuildFacts<'a> {
    pub session_id: &'a str,
    pub session_name: &'a str,
    pub agent_type: &'a str,
    pub last_user_dialog_agent_type: Option<&'a str>,
    pub last_submitted_agent_type: Option<&'a str>,
    pub created_by: Option<&'a str>,
    pub session_kind: SessionKind,
    pub model_name: Option<&'a str>,
    pub created_at_ms: u64,
    pub last_active_at_ms: u64,
    pub turn_count: usize,
    pub snapshot_session_id: Option<&'a str>,
    pub workspace_path: &'a str,
    pub project_workspace_path: Option<&'a str>,
    pub execution_target: Option<&'a SessionExecutionTarget>,
    pub workspace_hostname: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub project_workspace_id: Option<&'a str>,
    pub new_session_memory_mode: SessionMemoryMode,
    pub existing: Option<&'a SessionMetadata>,
}

pub fn build_session_metadata(facts: SessionMetadataBuildFacts<'_>) -> SessionMetadata {
    let existing = facts.existing;
    let created_at = existing
        .map(|value| value.created_at)
        .unwrap_or(facts.created_at_ms);
    let model_name = facts
        .model_name
        .map(str::to_string)
        .or_else(|| existing.map(|value| value.model_name.clone()))
        .unwrap_or_else(|| "default".to_string());

    SessionMetadata {
        session_id: facts.session_id.to_string(),
        session_name: facts.session_name.to_string(),
        agent_type: facts.agent_type.to_string(),
        last_user_dialog_agent_type: facts.last_user_dialog_agent_type.map(str::to_string),
        last_submitted_agent_type: facts.last_submitted_agent_type.map(str::to_string),
        created_by: facts
            .created_by
            .map(str::to_string)
            .or_else(|| existing.and_then(|value| value.created_by.clone())),
        session_kind: facts.session_kind,
        memory_mode: existing
            .map(|value| value.memory_mode)
            .unwrap_or(facts.new_session_memory_mode),
        model_name,
        created_at,
        last_active_at: facts.last_active_at_ms,
        last_finished_at: existing.and_then(|value| value.last_finished_at),
        last_turn: existing.and_then(|value| value.last_turn.clone()),
        turn_count: facts.turn_count,
        message_count: existing.map(|value| value.message_count).unwrap_or(0),
        tool_call_count: existing.map(|value| value.tool_call_count).unwrap_or(0),
        status: existing
            .map(|value| value.status.clone())
            .unwrap_or(super::types::SessionStatus::Active),
        terminal_session_id: existing.and_then(|value| value.terminal_session_id.clone()),
        snapshot_session_id: facts
            .snapshot_session_id
            .map(str::to_string)
            .or_else(|| existing.and_then(|value| value.snapshot_session_id.clone())),
        tags: existing.map(|value| value.tags.clone()).unwrap_or_default(),
        custom_metadata: existing.and_then(|value| value.custom_metadata.clone()),
        current_context_usage: existing.and_then(|value| value.current_context_usage.clone()),
        relationship: build_session_relationship(facts.session_kind, existing),
        todos: existing.and_then(|value| value.todos.clone()),
        review_action_state: existing.and_then(|value| value.review_action_state.clone()),
        deep_review_run_manifest: existing.and_then(|value| value.deep_review_run_manifest.clone()),
        review_target_evidence: existing.and_then(|value| value.review_target_evidence.clone()),
        deep_review_cache: existing.and_then(|value| value.deep_review_cache.clone()),
        workspace_path: Some(facts.workspace_path.to_string()),
        project_workspace_path: facts
            .project_workspace_path
            .map(str::to_string)
            .or_else(|| existing.and_then(|value| value.project_workspace_path.clone())),
        execution_target: facts
            .execution_target
            .cloned()
            .or_else(|| existing.and_then(|value| value.execution_target.clone())),
        workspace_hostname: facts.workspace_hostname.map(str::to_string),
        project_workspace_id: facts
            .project_workspace_id
            .map(str::to_owned)
            .or_else(|| existing.and_then(|value| value.project_workspace_id.clone())),
        workspace_id: facts
            .workspace_id
            .map(str::to_owned)
            .or_else(|| existing.and_then(|value| value.workspace_id.clone())),
        unread_completion: existing.and_then(|value| value.unread_completion.clone()),
        needs_user_attention: existing.and_then(|value| value.needs_user_attention.clone()),
    }
}

fn build_session_relationship(
    session_kind: SessionKind,
    existing: Option<&SessionMetadata>,
) -> Option<SessionRelationship> {
    let mut relationship = existing.and_then(normalized_session_relationship);
    let kind = match session_kind {
        SessionKind::Subagent => SessionRelationshipKind::Subagent,
        SessionKind::EphemeralChild => SessionRelationshipKind::Btw,
        SessionKind::Standard => return relationship,
    };
    relationship
        .get_or_insert_with(SessionRelationship::default)
        .kind = Some(kind);
    relationship
}

/// Resolves structured and legacy relationship metadata through the single
/// Services-owned compatibility path.
pub fn normalized_session_relationship(metadata: &SessionMetadata) -> Option<SessionRelationship> {
    let existing_relationship = metadata.relationship.clone();
    let existing_custom_metadata = metadata.custom_metadata.as_ref();

    let kind = existing_relationship
        .as_ref()
        .and_then(|value| value.kind.clone())
        .or_else(|| {
            legacy_custom_metadata_string(existing_custom_metadata, "kind").and_then(|value| {
                match value.as_str() {
                    "subagent" => Some(SessionRelationshipKind::Subagent),
                    "btw" => Some(SessionRelationshipKind::Btw),
                    "review" => Some(SessionRelationshipKind::Review),
                    "deep_review" => Some(SessionRelationshipKind::DeepReview),
                    "miniapp" => Some(SessionRelationshipKind::Miniapp),
                    _ => None,
                }
            })
        });

    let parent_session_id = existing_relationship
        .as_ref()
        .and_then(|value| value.parent_session_id.clone())
        .or_else(|| legacy_custom_metadata_string(existing_custom_metadata, "parentSessionId"));
    let parent_request_id = existing_relationship
        .as_ref()
        .and_then(|value| value.parent_request_id.clone())
        .or_else(|| legacy_custom_metadata_string(existing_custom_metadata, "parentRequestId"));
    let parent_dialog_turn_id = existing_relationship
        .as_ref()
        .and_then(|value| value.parent_dialog_turn_id.clone())
        .or_else(|| legacy_custom_metadata_string(existing_custom_metadata, "parentDialogTurnId"));
    let parent_turn_index = existing_relationship
        .as_ref()
        .and_then(|value| value.parent_turn_index)
        .or_else(|| {
            existing_custom_metadata
                .and_then(|value| value.get("parentTurnIndex"))
                .and_then(|value| value.as_u64())
                .map(|value| value as usize)
        });
    let parent_tool_call_id = existing_relationship
        .as_ref()
        .and_then(|value| value.parent_tool_call_id.clone())
        .or_else(|| legacy_custom_metadata_string(existing_custom_metadata, "parentToolCallId"));
    let subagent_type = existing_relationship
        .as_ref()
        .and_then(|value| value.subagent_type.clone())
        .or_else(|| legacy_custom_metadata_string(existing_custom_metadata, "subagentType"));
    let continuation_policy = existing_relationship
        .as_ref()
        .and_then(|value| value.continuation_policy);

    if kind.is_none()
        && parent_session_id.is_none()
        && parent_request_id.is_none()
        && parent_dialog_turn_id.is_none()
        && parent_turn_index.is_none()
        && parent_tool_call_id.is_none()
        && subagent_type.is_none()
        && continuation_policy.is_none()
    {
        return None;
    }

    Some(SessionRelationship {
        kind,
        parent_session_id,
        parent_request_id,
        parent_dialog_turn_id,
        parent_turn_index,
        parent_tool_call_id,
        subagent_type,
        continuation_policy,
    })
}

fn legacy_custom_metadata_string(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

pub fn estimate_turn_message_count(turn: &DialogTurnData) -> usize {
    let assistant_text_count: usize = turn
        .model_rounds
        .iter()
        .map(|round| round.text_items.len())
        .sum();
    1 + assistant_text_count
}

fn dialog_turn_finished_at(turn: &DialogTurnData) -> Option<u64> {
    if turn.kind != DialogTurnKind::UserDialog {
        return None;
    }
    if !matches!(
        turn.status,
        TurnStatus::Completed | TurnStatus::Error | TurnStatus::Cancelled
    ) {
        return None;
    }

    turn.end_time
}

pub fn refresh_session_metadata_from_turns(
    metadata: &mut SessionMetadata,
    workspace_path: &str,
    turns: &[DialogTurnData],
    last_active_at: u64,
) {
    metadata.turn_count = turns.len();
    metadata.message_count = turns.iter().map(estimate_turn_message_count).sum();
    metadata.tool_call_count = turns.iter().map(DialogTurnData::count_tool_calls).sum();
    metadata.last_finished_at = turns.iter().filter_map(dialog_turn_finished_at).max();
    // Rebuilds (including rollback) select by storage position, never wall time.
    let latest = turns
        .iter()
        .filter(|turn| turn.kind == DialogTurnKind::UserDialog)
        .max_by_key(|turn| turn.turn_index);
    if let Some(turn) = latest {
        refresh_latest_turn(metadata, turn);
    } else {
        metadata.last_turn = None;
    }
    if metadata
        .current_context_usage
        .as_ref()
        .is_some_and(|usage| !turns.iter().any(|turn| turn.turn_id == usage.turn_id))
    {
        metadata.current_context_usage = None;
    }
    metadata.last_active_at = last_active_at;
    fill_workspace_path_if_missing(metadata, workspace_path);
}

pub fn try_refresh_session_metadata_for_saved_turn(
    metadata: &mut SessionMetadata,
    workspace_path: &str,
    previous_turn: Option<&DialogTurnData>,
    turn: &DialogTurnData,
    last_active_at: u64,
) -> bool {
    let new_message_count = estimate_turn_message_count(turn);
    let new_tool_call_count = turn.count_tool_calls();

    match previous_turn {
        Some(previous)
            if previous.session_id == turn.session_id
                && previous.turn_index == turn.turn_index
                && turn.turn_index < metadata.turn_count =>
        {
            metadata.message_count = metadata
                .message_count
                .saturating_sub(estimate_turn_message_count(previous))
                .saturating_add(new_message_count);
            metadata.tool_call_count = metadata
                .tool_call_count
                .saturating_sub(previous.count_tool_calls())
                .saturating_add(new_tool_call_count);
        }
        None if turn.turn_index == metadata.turn_count => {
            metadata.turn_count += 1;
            metadata.message_count = metadata.message_count.saturating_add(new_message_count);
            metadata.tool_call_count = metadata.tool_call_count.saturating_add(new_tool_call_count);
        }
        _ => return false,
    }

    metadata.last_active_at = last_active_at;
    if let Some(finished_at) = dialog_turn_finished_at(turn) {
        metadata.last_finished_at = Some(
            metadata
                .last_finished_at
                .map_or(finished_at, |current| current.max(finished_at)),
        );
    }
    if turn.kind == DialogTurnKind::UserDialog
        && metadata
            .last_turn
            .as_ref()
            .is_none_or(|last| turn.turn_index >= last.turn_index)
    {
        refresh_latest_turn(metadata, turn);
    }
    fill_workspace_path_if_missing(metadata, workspace_path);
    true
}

fn refresh_latest_turn(metadata: &mut SessionMetadata, turn: &DialogTurnData) {
    let next = SessionLastTurn {
        turn_id: turn.turn_id.clone(),
        turn_index: turn.turn_index,
        status: turn.status.clone(),
        end_time: turn.end_time,
        execution_generation: turn.recovery_epoch.or_else(|| {
            turn.recovery
                .as_ref()
                .map(|recovery| recovery.execution_generation)
        }),
        recovery_pending: Some(
            turn.status == TurnStatus::Cancelled
                && turn.finish_reason.as_deref() == Some("interrupted")
                && turn.recovery.as_ref().is_some_and(|recovery| {
                    recovery.status == super::types::DialogTurnRecoveryStatus::Interrupted
                }),
        ),
    };
    // Checkpoint re-saves must not resurrect an already acknowledged result.
    let same_outcome = metadata.last_turn.as_ref().is_some_and(|last| {
        last.turn_id == next.turn_id
            && last.status == next.status
            && last.execution_generation == next.execution_generation
            && last
                .recovery_pending
                .is_none_or(|pending| next.recovery_pending == Some(pending))
    });
    if !same_outcome {
        if let Some(outcome) = match turn.status {
            TurnStatus::Completed => Some("completed"),
            TurnStatus::Error => Some("error"),
            TurnStatus::Cancelled => Some("interrupted"),
            TurnStatus::InProgress => None,
        } {
            metadata.unread_completion = Some(outcome.to_string());
            metadata.needs_user_attention = None;
        }
    }
    metadata.last_turn = Some(next);
}

/// A delayed UI acknowledgement must not clear a newer completion. New clients
/// name the rendered Turn/generation; old clients retain the finish-time guard.
pub fn apply_session_unread_completion(current: &mut SessionMetadata, incoming: &SessionMetadata) {
    let matches_result = match (&current.last_turn, &incoming.last_turn) {
        (Some(current), Some(incoming)) => {
            current.turn_id == incoming.turn_id
                && current.execution_generation == incoming.execution_generation
                && current.status == incoming.status
                && current
                    .recovery_pending
                    .zip(incoming.recovery_pending)
                    .is_none_or(|(current, incoming)| current == incoming)
        }
        (Some(current), None) => current
            .end_time
            .is_some_and(|end| incoming.last_finished_at.is_some_and(|seen| seen >= end)),
        (None, _) => true,
    };
    if matches_result {
        current.unread_completion = incoming.unread_completion.clone();
    }
}

/// Apply the UI-owned title descriptor without changing host-owned metadata,
/// including the workspace session display slot.
pub fn apply_session_title_metadata(current: &mut SessionMetadata, incoming: &SessionMetadata) {
    let mut custom = current
        .custom_metadata
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let incoming_custom = incoming.custom_metadata.as_ref().and_then(Value::as_object);
    for key in ["titleSource", "titleKey", "titleParams"] {
        custom.remove(key);
        if let Some(value) = incoming_custom.and_then(|metadata| metadata.get(key)) {
            custom.insert(key.to_string(), value.clone());
        }
    }
    current.custom_metadata = (!custom.is_empty()).then_some(Value::Object(custom));
}

pub fn build_session_index_snapshot(
    metadata_list: Vec<SessionMetadata>,
    updated_at: u64,
) -> (StoredSessionIndexFile, Vec<SessionMetadata>) {
    let metadata_file_count = metadata_list.len();
    let mut visible_sessions = metadata_list
        .into_iter()
        .filter(|metadata| !metadata.should_hide_from_user_lists())
        .collect::<Vec<_>>();
    visible_sessions.sort_by_key(|metadata| std::cmp::Reverse(metadata.last_active_at));

    let index = StoredSessionIndexFile::with_metadata_file_count(
        updated_at,
        visible_sessions.clone(),
        metadata_file_count,
    );
    (index, visible_sessions)
}

pub fn upsert_session_index_entry(
    existing_index: Option<StoredSessionIndexFile>,
    metadata: &SessionMetadata,
    metadata_file_created: bool,
    disk_metadata_file_count: usize,
    updated_at: u64,
) -> StoredSessionIndexFile {
    let had_index = existing_index.is_some();
    let mut index = existing_index.unwrap_or_else(|| StoredSessionIndexFile {
        schema_version: super::types::SESSION_STORAGE_SCHEMA_VERSION,
        updated_at: 0,
        metadata_file_count: disk_metadata_file_count,
        sessions: Vec::new(),
    });

    if let Some(existing) = index
        .sessions
        .iter_mut()
        .find(|value| value.session_id == metadata.session_id)
    {
        *existing = metadata.clone();
    } else {
        index.sessions.push(metadata.clone());
    }

    index
        .sessions
        .sort_by_key(|metadata| std::cmp::Reverse(metadata.last_active_at));
    if had_index && metadata_file_created {
        index.metadata_file_count = index.metadata_file_count.saturating_add(1);
    }
    index.updated_at = updated_at;
    index.schema_version = super::types::SESSION_STORAGE_SCHEMA_VERSION;
    index
}

pub fn remove_session_index_entry(
    existing_index: Option<StoredSessionIndexFile>,
    session_id: &str,
    metadata_file_count_delta: isize,
    updated_at: u64,
) -> Option<StoredSessionIndexFile> {
    let mut index = existing_index?;

    index
        .sessions
        .retain(|value| value.session_id != session_id);
    if metadata_file_count_delta > 0 {
        index.metadata_file_count = index
            .metadata_file_count
            .saturating_add(metadata_file_count_delta as usize);
    } else if metadata_file_count_delta < 0 {
        index.metadata_file_count = index
            .metadata_file_count
            .saturating_sub(metadata_file_count_delta.unsigned_abs());
    }
    index.updated_at = updated_at;
    index.schema_version = super::types::SESSION_STORAGE_SCHEMA_VERSION;
    Some(index)
}

pub fn merge_session_custom_metadata(metadata: &mut SessionMetadata, patch: Value) {
    metadata.custom_metadata = Some(match (metadata.custom_metadata.take(), patch) {
        (Some(Value::Object(mut existing)), Value::Object(patch_obj)) => {
            for (key, value) in patch_obj {
                existing.insert(key, value);
            }
            Value::Object(existing)
        }
        (_, value) => value,
    });
}

pub fn set_session_relationship(metadata: &mut SessionMetadata, relationship: SessionRelationship) {
    metadata.relationship = Some(relationship);
}

pub fn set_deep_review_run_manifest(
    metadata: &mut SessionMetadata,
    deep_review_run_manifest: Option<Value>,
) {
    metadata.deep_review_run_manifest = deep_review_run_manifest;
}

pub fn set_review_target_evidence(
    metadata: &mut SessionMetadata,
    review_target_evidence: Option<Value>,
) {
    metadata.review_target_evidence = review_target_evidence;
}

pub fn set_deep_review_cache(metadata: &mut SessionMetadata, cache: Value) {
    metadata.deep_review_cache = Some(cache);
}

fn fill_workspace_path_if_missing(metadata: &mut SessionMetadata, workspace_path: &str) {
    if metadata.workspace_path.is_none() {
        metadata.workspace_path = Some(workspace_path.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{SessionRelationship, SessionRelationshipKind};
    use openbitfun_core_types::{
        SessionContinuationPolicy, SessionExecutionTarget, SessionExecutionTargetKind,
        WorktreeLifecycle,
    };
    use serde_json::json;

    fn metadata() -> SessionMetadata {
        SessionMetadata::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        )
    }

    #[test]
    fn title_updates_preserve_host_metadata_and_can_clear_the_default_descriptor() {
        let mut current = metadata();
        current.custom_metadata = Some(json!({
            "workspaceSessionNumber": 12, "runtimeOwned": true,
            "titleSource": "i18n", "titleKey": "flow-chat:session.new",
            "titleParams": { "defaultTitleText": "New Session" }
        }));
        let mut incoming = metadata();
        incoming.custom_metadata = Some(json!({
            "workspaceSessionNumber": 99, "runtimeOwned": false,
            "titleSource": "i18n", "titleKey": "flow-chat:session.new",
            "titleParams": { "defaultTitleText": "New Session" }
        }));
        apply_session_title_metadata(&mut current, &incoming);
        assert_eq!(
            current.custom_metadata.as_ref().unwrap()["workspaceSessionNumber"],
            12
        );
        assert_eq!(
            current.custom_metadata.as_ref().unwrap()["runtimeOwned"],
            true
        );
        assert_eq!(
            current.custom_metadata.as_ref().unwrap()["titleParams"],
            incoming.custom_metadata.as_ref().unwrap()["titleParams"]
        );

        incoming.custom_metadata = None;
        apply_session_title_metadata(&mut current, &incoming);
        assert_eq!(
            current.custom_metadata,
            Some(json!({ "workspaceSessionNumber": 12, "runtimeOwned": true }))
        );
    }

    #[test]
    fn merge_custom_metadata_shallow_merges_object_patch() {
        let mut metadata = metadata();
        metadata.custom_metadata = Some(json!({
            "existing": true,
            "replace": "old"
        }));

        merge_session_custom_metadata(
            &mut metadata,
            json!({
                "replace": "new",
                "added": 1
            }),
        );

        assert_eq!(
            metadata.custom_metadata,
            Some(json!({
                "existing": true,
                "replace": "new",
                "added": 1
            }))
        );
    }

    #[test]
    fn merge_custom_metadata_replaces_non_object_patch() {
        let mut metadata = metadata();
        metadata.custom_metadata = Some(json!({ "existing": true }));

        merge_session_custom_metadata(&mut metadata, json!("replacement"));

        assert_eq!(metadata.custom_metadata, Some(json!("replacement")));
    }

    #[test]
    fn relationship_and_manifest_mutations_preserve_other_metadata() {
        let mut metadata = metadata();
        metadata.custom_metadata = Some(json!({ "existing": true }));
        let relationship = SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent".to_string()),
            parent_request_id: Some("request".to_string()),
            parent_dialog_turn_id: Some("turn".to_string()),
            parent_turn_index: Some(3),
            parent_tool_call_id: Some("tool".to_string()),
            subagent_type: Some("ReviewSecurity".to_string()),
            continuation_policy: Some(SessionContinuationPolicy::FreshOnly),
        };

        set_session_relationship(&mut metadata, relationship.clone());
        set_deep_review_run_manifest(&mut metadata, Some(json!({ "run": "manifest" })));
        set_review_target_evidence(&mut metadata, Some(json!({ "target": "evidence" })));

        assert_eq!(metadata.relationship, Some(relationship));
        assert_eq!(
            metadata.deep_review_run_manifest,
            Some(json!({ "run": "manifest" }))
        );
        assert_eq!(
            metadata.review_target_evidence,
            Some(json!({ "target": "evidence" }))
        );
        assert_eq!(metadata.custom_metadata, Some(json!({ "existing": true })));
    }

    #[test]
    fn deep_review_cache_mutation_preserves_manifest_and_relationship() {
        let mut metadata = metadata();
        metadata.deep_review_run_manifest = Some(json!({ "run": "manifest" }));
        metadata.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::DeepReview),
            parent_session_id: Some("parent".to_string()),
            ..Default::default()
        });

        set_deep_review_cache(&mut metadata, json!({ "packet": "review output" }));

        assert_eq!(
            metadata.deep_review_cache,
            Some(json!({ "packet": "review output" }))
        );
        assert_eq!(
            metadata.deep_review_run_manifest,
            Some(json!({ "run": "manifest" }))
        );
        assert_eq!(
            metadata
                .relationship
                .as_ref()
                .and_then(|value| value.kind.clone()),
            Some(SessionRelationshipKind::DeepReview)
        );
    }

    #[test]
    fn build_session_metadata_preserves_existing_fields_and_legacy_relationship() {
        let mut existing = metadata();
        existing.created_at = 10;
        existing.message_count = 7;
        existing.tool_call_count = 3;
        existing.memory_mode = crate::session::SessionMemoryMode::Disabled;
        existing.custom_metadata = Some(json!({
            "parentSessionId": "parent-session",
            "parentRequestId": "parent-request",
            "parentDialogTurnId": "turn-1",
            "parentTurnIndex": 2,
            "parentToolCallId": "tool-1",
            "subagentType": "review",
            "preserved": true
        }));
        existing.deep_review_run_manifest = Some(json!({ "run": "manifest" }));
        existing.deep_review_cache = Some(json!({ "cache": true }));

        let built = build_session_metadata(SessionMetadataBuildFacts {
            session_id: "session-1",
            session_name: "Updated session",
            agent_type: "Standard",
            last_user_dialog_agent_type: Some("plan"),
            last_submitted_agent_type: Some("code"),
            created_by: Some("creator"),
            session_kind: crate::session::SessionKind::Subagent,
            model_name: Some("gpt-test"),
            created_at_ms: 100,
            last_active_at_ms: 200,
            turn_count: 4,
            snapshot_session_id: Some("snapshot-1"),
            workspace_path: "/workspace",
            project_workspace_path: None,
            execution_target: None,
            workspace_hostname: Some("host"),
            workspace_id: Some("workspace-1"),
            project_workspace_id: Some("workspace-1"),
            new_session_memory_mode: crate::session::SessionMemoryMode::Enabled,
            existing: Some(&existing),
        });

        assert_eq!(built.created_at, 10);
        assert_eq!(built.last_active_at, 200);
        assert_eq!(built.message_count, 7);
        assert_eq!(built.tool_call_count, 3);
        assert_eq!(built.turn_count, 4);
        assert_eq!(built.session_name, "Updated session");
        assert_eq!(built.last_user_dialog_agent_type.as_deref(), Some("plan"));
        assert_eq!(built.last_submitted_agent_type.as_deref(), Some("code"));
        assert_eq!(built.created_by.as_deref(), Some("creator"));
        assert_eq!(built.memory_mode, existing.memory_mode);
        assert_eq!(built.snapshot_session_id.as_deref(), Some("snapshot-1"));
        assert_eq!(built.workspace_path.as_deref(), Some("/workspace"));
        assert_eq!(built.workspace_hostname.as_deref(), Some("host"));
        assert_eq!(
            built.deep_review_run_manifest,
            Some(json!({ "run": "manifest" }))
        );
        assert_eq!(built.deep_review_cache, Some(json!({ "cache": true })));
        assert_eq!(built.custom_metadata, existing.custom_metadata);
        assert_eq!(
            built.relationship,
            Some(SessionRelationship {
                kind: Some(SessionRelationshipKind::Subagent),
                parent_session_id: Some("parent-session".to_string()),
                parent_request_id: Some("parent-request".to_string()),
                parent_dialog_turn_id: Some("turn-1".to_string()),
                parent_turn_index: Some(2),
                parent_tool_call_id: Some("tool-1".to_string()),
                subagent_type: Some("review".to_string()),
                continuation_policy: None,
            })
        );
    }

    #[test]
    fn build_session_metadata_uses_supplied_memory_mode_for_new_sessions() {
        let built = build_session_metadata(SessionMetadataBuildFacts {
            session_id: "session-1",
            session_name: "New session",
            agent_type: "Standard",
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            created_by: None,
            session_kind: crate::session::SessionKind::Standard,
            model_name: Some("gpt-test"),
            created_at_ms: 100,
            last_active_at_ms: 200,
            turn_count: 0,
            snapshot_session_id: None,
            workspace_path: "/workspace",
            project_workspace_path: None,
            execution_target: None,
            workspace_hostname: None,
            workspace_id: None,
            project_workspace_id: None,
            new_session_memory_mode: crate::session::SessionMemoryMode::Disabled,
            existing: None,
        });

        assert_eq!(
            built.memory_mode,
            crate::session::SessionMemoryMode::Disabled
        );
    }

    #[test]
    fn build_session_metadata_persists_dual_roots_and_execution_target() {
        let execution_target = SessionExecutionTarget {
            kind: SessionExecutionTargetKind::ManagedWorktree,
            worktree_id: Some("wt-1".to_string()),
            root_path: "/worktrees/wt-1".to_string(),
            base_ref: Some("main".to_string()),
            base_commit: Some("0123456789abcdef".to_string()),
            branch: None,
            lifecycle: Some(WorktreeLifecycle::Managed),
        };
        let built = build_session_metadata(SessionMetadataBuildFacts {
            session_id: "session-worktree",
            session_name: "Isolated session",
            agent_type: "Standard",
            last_user_dialog_agent_type: None,
            last_submitted_agent_type: None,
            created_by: None,
            session_kind: crate::session::SessionKind::Standard,
            model_name: Some("gpt-test"),
            created_at_ms: 100,
            last_active_at_ms: 200,
            turn_count: 0,
            snapshot_session_id: None,
            workspace_path: "/worktrees/wt-1",
            project_workspace_path: Some("/repo"),
            execution_target: Some(&execution_target),
            workspace_hostname: None,
            workspace_id: None,
            project_workspace_id: None,
            new_session_memory_mode: crate::session::SessionMemoryMode::Enabled,
            existing: None,
        });

        assert_eq!(built.workspace_path.as_deref(), Some("/worktrees/wt-1"));
        assert_eq!(built.project_workspace_path.as_deref(), Some("/repo"));
        assert_eq!(built.execution_target, Some(execution_target));
    }
}
