use super::*;
use crate::agentic::core::{Session, SessionConfig};
use crate::agentic::session::revert::{
    SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION,
};
use crate::infrastructure::PathManager;
use crate::service::session::{DialogTurnKind, UserMessageData};
use openbitfun_services_core::session::SessionStorageLayout;

fn turn_fixture() -> DialogTurnData {
    let mut turn = DialogTurnData::new(
        "turn-0".into(),
        0,
        "session".into(),
        UserMessageData {
            id: "user-0".into(),
            content: "PRIVATE_SCAFFOLD".into(),
            timestamp: 0,
            metadata: Some(json!({
                "original_text": "Inspect the parser",
                "private_auth": "PRIVATE_AUTH",
                "images": [{"data_url": "PRIVATE_IMAGE"}],
            })),
        },
    );
    turn.model_rounds = vec![serde_json::from_value(json!({
        "id": "round-0", "turnId": "turn-0", "roundIndex": 0,
        "timestamp": 0, "startTime": 0, "status": "completed",
        "textItems": [{
            "id": "text-0", "content": "Found a failing parser test",
            "timestamp": 0, "isStreaming": false
        }],
        "thinkingItems": [{
            "id": "thinking-0", "content": "Inspect the lexer first",
            "timestamp": 0, "isStreaming": false, "isCollapsed": true
        }],
        "toolItems": [{
            "id": "tool-0", "toolName": "CallDeferredTool", "startTime": 0,
            "toolCall": {"id": "tool-0", "input": {
                "tool_name": "ExecCommand", "args": {"cmd": "cargo test parser"}
            }},
            "toolResult": {
                "success": false,
                "resultForAssistant": "parser::tests::parse failed",
                "result": {
                    "exit_code": 101, "timed_out": false, "file_path": "src/parser.rs",
                    "private_payload": "PRIVATE_RAW", "untrusted_array": ["PRIVATE_ARRAY"]
                }
            }
        }]
    }))
    .unwrap()];
    turn
}

fn snapshot(observations: &[HistoryObservation]) -> Vec<(String, String, Value)> {
    observations
        .iter()
        .map(|entry| {
            (
                entry.source_id.clone(),
                format!("{:?}", entry.kind),
                entry.content.clone(),
            )
        })
        .collect()
}

#[test]
fn source_projection_is_deterministic_and_keeps_user_and_round_identity() {
    let mut turn = turn_fixture();
    let first = project_turn(&turn).unwrap();
    let second = project_turn(&turn).unwrap();
    assert_eq!(snapshot(&first), snapshot(&second));
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].kind, RouterEntryKind::UserUpdate);
    assert_eq!(first[1].kind, RouterEntryKind::Round);
    assert_ne!(first[0].source_id, first[1].source_id);
    assert_eq!(first[1].content["round_id"], "round-0");
    turn.turn_id = "other-turn".into();
    turn.model_rounds[0].turn_id = turn.turn_id.clone();
    let other = project_turn(&turn).unwrap();
    assert_ne!(first[0].source_id, other[0].source_id);
    assert_ne!(first[1].source_id, other[1].source_id);
}

#[test]
fn source_projection_preserves_effective_tool_result_and_status_without_private_metadata() {
    let observations = project_turn(&turn_fixture()).unwrap();
    assert_eq!(observations[0].content, "Inspect the parser");
    let round = &observations[1].content;
    assert_eq!(
        round["assistant"]["tool_calls"][0]["tool_name"],
        "ExecCommand"
    );
    assert_eq!(
        round["assistant"]["tool_calls"][0]["arguments"]["cmd"],
        "cargo test parser"
    );
    assert_eq!(
        round["tool_results"][0]["result_for_assistant"],
        "parser::tests::parse failed"
    );
    assert_eq!(round["tool_results"][0]["is_error"], true);
    assert_eq!(round["tool_results"][0]["status"]["exit_code"], 101);
    assert_eq!(round["tool_results"][0]["status"]["timed_out"], false);
    assert_eq!(
        round["tool_results"][0]["status"]["file_path"],
        "src/parser.rs"
    );
    assert_eq!(
        round["assistant"]["reasoning_content"],
        "Inspect the lexer first"
    );
    let prompt = observations
        .iter()
        .map(|entry| entry.content.to_string())
        .collect::<String>();
    for private in [
        "PRIVATE_AUTH",
        "PRIVATE_IMAGE",
        "PRIVATE_SCAFFOLD",
        "PRIVATE_RAW",
        "PRIVATE_ARRAY",
    ] {
        assert!(!prompt.contains(private));
    }
}

#[test]
fn source_projection_keeps_only_the_effective_parent_attempt() {
    let mut turn = turn_fixture();
    let round = &mut turn.model_rounds[0];
    round.text_items[0].attempt_index = Some(1);
    round.thinking_items[0].attempt_index = Some(1);
    round.tool_items[0].attempt_index = Some(1);
    let mut superseded = round.text_items[0].clone();
    superseded.id = "old-text".into();
    superseded.content = "SUPERSEDED_TEXT".into();
    superseded.attempt_index = Some(0);
    round.text_items.insert(0, superseded);
    let mut child = round.text_items[1].clone();
    child.id = "private-child".into();
    child.content = "PRIVATE_CHILD_TEXT".into();
    child.is_subagent_item = Some(true);
    child.attempt_index = Some(9);
    round.text_items.push(child);
    let mut child_tool = round.tool_items[0].clone();
    child_tool.id = "private-child-tool".into();
    child_tool.is_subagent_item = Some(true);
    child_tool.tool_call.input = json!({"secret": "PRIVATE_CHILD_TOOL"});
    child_tool.attempt_index = Some(9);
    round.tool_items.push(child_tool);
    let projected = project_turn(&turn).unwrap();
    let prompt = projected[1].content.to_string();
    assert!(prompt.contains("Found a failing parser test"));
    for hidden in [
        "SUPERSEDED_TEXT",
        "PRIVATE_CHILD_TEXT",
        "PRIVATE_CHILD_TOOL",
    ] {
        assert!(!prompt.contains(hidden));
    }
    assert_eq!(
        projected[1].content["assistant"]["tool_calls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn source_projection_skips_maintenance_turns_and_rejects_ambiguous_rounds() {
    let mut turn = turn_fixture();
    turn.kind = DialogTurnKind::ManualCompaction;
    assert!(project_turn(&turn).unwrap().is_empty());
    turn.kind = DialogTurnKind::LocalCommand;
    assert!(project_turn(&turn).unwrap().is_empty());
    turn.kind = DialogTurnKind::UserDialog;
    turn.model_rounds[0].turn_id = "different-turn".into();
    assert!(project_turn(&turn).is_err());
    turn.model_rounds[0].turn_id = turn.turn_id.clone();
    turn.model_rounds.push(turn.model_rounds[0].clone());
    assert!(project_turn(&turn).is_err());
}

#[tokio::test]
async fn source_recovers_missing_catalog_and_respects_new_undo_and_missing_turns() {
    let workspace = tempfile::tempdir().unwrap();
    let workspace_path = dunce::canonicalize(workspace.path()).unwrap();
    crate::service::workspace::legacy_compat::register_local_fixture_blocking(&workspace_path);
    let paths = Arc::new(PathManager::with_user_root_for_tests(
        workspace_path.join("user-root"),
    ));
    let persistence = Arc::new(PersistenceManager::new(paths.clone()).unwrap());
    let session = Session::new_with_id(
        "session".into(),
        "Router history fixture".into(),
        "Standard".into(),
        SessionConfig {
            workspace_path: Some(workspace_path.to_string_lossy().into_owned()),
            ..Default::default()
        },
    );
    persistence
        .save_session(&workspace_path, &session)
        .await
        .unwrap();
    let first = turn_fixture();
    let mut second = first.clone();
    second.turn_id = "turn-1".into();
    second.turn_index = 1;
    second.user_message.id = "user-1".into();
    second.model_rounds[0].id = "round-1".into();
    second.model_rounds[0].turn_id = second.turn_id.clone();
    for turn in [&first, &second] {
        persistence
            .save_dialog_turn(&workspace_path, turn)
            .await
            .unwrap();
    }
    let layout = SessionStorageLayout::new(paths.project_sessions_dir(&workspace_path));
    tokio::fs::remove_file(layout.turn_catalog_path("session"))
        .await
        .unwrap();
    let source = PersistentRouterHistorySource::new(
        persistence.clone(),
        workspace_path.clone(),
        "session".into(),
    );
    assert_eq!(source.observations("turn-0").await.unwrap().len(), 2);
    assert_eq!(source.indices.lock().await.as_ref().unwrap().len(), 2);
    assert_eq!(source.observations("turn-1").await.unwrap().len(), 2);
    assert!(source.observations("unknown-turn").await.is_err());
    persistence
        .save_session_revert_state(
            &workspace_path,
            "session",
            &SessionRevertState {
                schema_version: SESSION_REVERT_SCHEMA_VERSION,
                boundary_turn: 1,
                original_turn_end: 2,
                phase: SessionRevertPhase::Staged,
                workspace_checkpoint: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert!(source.observations("turn-1").await.is_err());
    assert_eq!(source.observations("turn-0").await.unwrap().len(), 2);
    tokio::fs::remove_file(layout.turn_path("session", 0))
        .await
        .unwrap();
    assert!(source.observations("turn-0").await.is_err());
}
