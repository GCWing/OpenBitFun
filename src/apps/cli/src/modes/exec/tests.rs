use super::lifecycle::{
    completed_turn_failure, drain_interrupted_turn_events, effective_event_invocation,
    event_belongs_to_exec_turn, event_turn_id, is_exec_terminal,
    permission_action_required_message, resolve_cancelled_turn_observation,
    serialize_stream_envelope, session_in_use_stream_envelope, settlement_failure,
    should_reject_permission_request, ExecApprovalMode, ExecJsonResult, ExecMode, ExecTokenUsage,
    TOOL_START_INPUT_PREVIEW_CHARS,
};
use super::patch::write_patch_to_path;
use super::patch::{git_diff_base, untracked_files};
use super::verification::{changed_files, detect_verify_command, needs_change_baseline};
use crate::diagnostics::ExitKind;
use openbitfun_agent_runtime::sdk::{
    PermissionDelegationContext, PermissionRequest, PermissionRequestSource,
    PermissionRequestSourceKind, PortError, PortErrorKind, RuntimeError,
};
use openbitfun_events::{
    AgenticEvent, AgenticEventEnvelope, AgenticEventPriority, ToolEventIdentity,
};
use serde_json::json;
use std::collections::BTreeSet;

fn delegated_permission_request() -> PermissionRequest {
    PermissionRequest {
        request_id: "request-1".to_string(),
        round_id: "synthetic:request-1".to_string(),
        order: 0,
        tool_call_id: Some("child-tool".to_string()),
        project_path: None,
        project_id: "project-1".to_string(),
        session_id: "child-session".to_string(),
        agent_id: "Explore".to_string(),
        action: "edit".to_string(),
        resources: vec!["src/main.rs".to_string()],
        save_resources: Vec::new(),
        source: PermissionRequestSource {
            kind: PermissionRequestSourceKind::ToolCall,
            identity: "Write".to_string(),
        },
        delegation: Some(PermissionDelegationContext {
            parent_session_id: "parent-session".to_string(),
            parent_dialog_turn_id: Some("parent-turn".to_string()),
            parent_tool_call_id: "parent-task".to_string(),
            subagent_type: "Explore".to_string(),
        }),
        display_metadata: serde_json::Map::new(),
    }
}

#[test]
fn permission_action_required_message_includes_subagent_lineage() {
    assert_eq!(
        permission_action_required_message(&delegated_permission_request()),
        "action-required: permission needed for edit by Explore subagent (child session child-session, parent session parent-session, parent task parent-task, request request-1)"
    );
}

#[test]
fn exec_rejects_owned_child_requests_without_event_driven_auto_approval() {
    let request = delegated_permission_request();

    assert!(should_reject_permission_request(
        &request,
        "parent-session",
        ExecApprovalMode::Reject
    ));
    assert!(!should_reject_permission_request(
        &request,
        "parent-session",
        ExecApprovalMode::Auto
    ));
    assert!(!should_reject_permission_request(
        &request,
        "unrelated-session",
        ExecApprovalMode::Reject
    ));
}

#[test]
fn write_patch_to_path_creates_nested_parent_directories() {
    let temp = tempfile::tempdir().expect("tempdir");
    let patch_path = temp.path().join("parent/child/out.patch");
    write_patch_to_path(patch_path.to_str().expect("utf8 path"), "diff content")
        .expect("write patch");

    let written = std::fs::read_to_string(&patch_path).expect("read patch");
    assert_eq!(written, "diff content");
}

#[test]
fn write_patch_to_path_creates_an_explicit_empty_patch_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    let patch_path = temp.path().join("empty.patch");

    write_patch_to_path(patch_path.to_str().expect("utf8 path"), "").expect("write empty patch");

    assert!(patch_path.is_file());
    assert_eq!(std::fs::read_to_string(patch_path).expect("read patch"), "");
}

#[test]
fn git_patch_includes_staged_and_untracked_files_from_a_repo_subdirectory() {
    let temp = tempfile::tempdir().expect("tempdir");
    let repo = temp.path();
    let run_git = |args: &[&str]| {
        let output = openbitfun_core::util::process_manager::create_command("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run_git(&["init", "--quiet"]);
    run_git(&["config", "user.email", "cli-tests@example.invalid"]);
    run_git(&["config", "user.name", "CLI Tests"]);
    std::fs::write(repo.join("tracked.txt"), "before\n").expect("tracked file");
    run_git(&["add", "tracked.txt"]);
    run_git(&["commit", "--quiet", "-m", "initial"]);

    std::fs::write(repo.join("tracked.txt"), "after\n").expect("modify tracked file");
    run_git(&["add", "tracked.txt"]);
    std::fs::write(repo.join("untracked.txt"), "new\n").expect("untracked file");
    std::fs::create_dir_all(repo.join("nested")).expect("nested directory");

    let patch =
        ExecMode::get_git_diff_for_workspace(&repo.join("nested"), None).expect("workspace patch");

    assert!(patch.contains("tracked.txt"), "{patch}");
    assert!(patch.contains("untracked.txt"), "{patch}");
    assert!(patch.contains("+after"), "{patch}");
    assert!(patch.contains("+new"), "{patch}");
}

#[test]
fn git_patch_excludes_a_preexisting_output_artifact_inside_the_repository() {
    let temp = tempfile::tempdir().expect("tempdir");
    let repo = temp.path();
    let run_git = |args: &[&str]| {
        let output = openbitfun_core::util::process_manager::create_command("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run_git(&["init", "--quiet"]);
    run_git(&["config", "user.email", "cli-tests@example.invalid"]);
    run_git(&["config", "user.name", "CLI Tests"]);
    std::fs::write(repo.join("tracked.txt"), "before\n").expect("tracked file");
    run_git(&["add", "tracked.txt"]);
    run_git(&["commit", "--quiet", "-m", "initial"]);

    std::fs::write(repo.join("tracked.txt"), "after\n").expect("modify tracked file");
    let output_artifact = repo.join("result.patch");
    std::fs::write(&output_artifact, "old recursive patch payload\n")
        .expect("preexisting output artifact");

    let patch = ExecMode::get_git_diff_for_workspace(
        repo,
        Some(output_artifact.to_str().expect("utf8 artifact path")),
    )
    .expect("workspace patch");

    assert!(patch.contains("tracked.txt"), "{patch}");
    assert!(!patch.contains("result.patch"), "{patch}");
    assert!(!patch.contains("old recursive patch payload"), "{patch}");
}

#[test]
fn git_patch_excludes_a_tracked_output_artifact_inside_the_repository() {
    let temp = tempfile::tempdir().expect("tempdir");
    let repo = temp.path();
    let run_git = |args: &[&str]| {
        let output = openbitfun_core::util::process_manager::create_command("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run_git(&["init", "--quiet"]);
    run_git(&["config", "user.email", "cli-tests@example.invalid"]);
    run_git(&["config", "user.name", "CLI Tests"]);
    std::fs::write(repo.join("tracked.txt"), "before\n").expect("tracked file");
    std::fs::write(repo.join("result.patch"), "old patch\n").expect("tracked artifact");
    run_git(&["add", "tracked.txt", "result.patch"]);
    run_git(&["commit", "--quiet", "-m", "initial"]);

    std::fs::write(repo.join("tracked.txt"), "after\n").expect("modify tracked file");
    let output_artifact = repo.join("result.patch");
    std::fs::write(&output_artifact, "new recursive patch payload\n")
        .expect("modify tracked artifact");

    let patch = ExecMode::get_git_diff_for_workspace(
        repo,
        Some(output_artifact.to_str().expect("utf8 artifact path")),
    )
    .expect("workspace patch");

    assert!(patch.contains("tracked.txt"), "{patch}");
    assert!(!patch.contains("result.patch"), "{patch}");
    assert!(!patch.contains("recursive patch payload"), "{patch}");
}

#[test]
fn tool_input_preview_redacts_data_urls() {
    let preview = ExecMode::tool_input_preview(&json!({
        "image": {
            "data_url": "data:image/png;base64,abc",
            "name": "sample"
        }
    }));

    assert!(!preview.contains("data:image/png"));
    assert!(preview.contains("\"has_data_url\":true"));
    assert!(preview.contains("\"name\":\"sample\""));
}

#[test]
fn tool_input_preview_truncates_large_inputs() {
    let preview = ExecMode::tool_input_preview(&json!({
        "content": "x".repeat(TOOL_START_INPUT_PREVIEW_CHARS + 100)
    }));

    assert!(preview.ends_with("... [truncated]"));
    assert!(preview.len() < TOOL_START_INPUT_PREVIEW_CHARS + 100);
}

#[test]
fn json_output_is_one_competitor_aligned_result_object() {
    let result = ExecJsonResult::success(
        "session-1",
        "turn-1",
        "completed work",
        Some(ExecTokenUsage {
            input_tokens: 10,
            output_tokens: Some(5),
            total_tokens: 15,
            cached_tokens: Some(3),
        }),
    );

    let encoded = serde_json::to_string(&result).expect("serialize result");
    let value: serde_json::Value = serde_json::from_str(&encoded).expect("one JSON object");

    assert_eq!(value["type"], "result");
    assert_eq!(value["subtype"], "success");
    assert_eq!(value["is_error"], false);
    assert_eq!(value["result"], "completed work");
    assert_eq!(value["session_id"], "session-1");
    assert_eq!(value["turn_id"], "turn-1");
    assert_eq!(value["usage"]["total_tokens"], 15);
}

#[test]
fn json_usage_accumulates_all_model_round_updates_for_the_turn() {
    let events = [
        AgenticEvent::TokenUsageUpdated {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            input_tokens: 100,
            output_tokens: Some(25),
            total_tokens: 125,
            max_context_tokens: Some(200_000),
            is_subagent: false,
            cached_tokens: Some(40),
            token_details: None,
        },
        AgenticEvent::TokenUsageUpdated {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            input_tokens: 200,
            output_tokens: Some(50),
            total_tokens: 250,
            max_context_tokens: Some(200_000),
            is_subagent: false,
            cached_tokens: Some(80),
            token_details: None,
        },
    ];
    let mut usage = None;

    for event in &events {
        assert_eq!(
            ExecTokenUsage::accumulate_event(&mut usage, event, "turn-1"),
            Some("model-config")
        );
    }

    let value = serde_json::to_value(ExecJsonResult::success(
        "session-1",
        "turn-1",
        "done",
        usage,
    ))
    .expect("serialize result");
    assert_eq!(value["usage"]["input_tokens"], 300);
    assert_eq!(value["usage"]["output_tokens"], 75);
    assert_eq!(value["usage"]["total_tokens"], 375);
    assert_eq!(value["usage"]["cached_tokens"], 120);
}

#[test]
fn json_usage_omits_optional_totals_when_any_round_does_not_report_them() {
    let events = [
        AgenticEvent::TokenUsageUpdated {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            input_tokens: 100,
            output_tokens: None,
            total_tokens: 100,
            max_context_tokens: None,
            is_subagent: false,
            cached_tokens: Some(20),
            token_details: None,
        },
        AgenticEvent::TokenUsageUpdated {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            input_tokens: 50,
            output_tokens: Some(10),
            total_tokens: 60,
            max_context_tokens: None,
            is_subagent: false,
            cached_tokens: None,
            token_details: None,
        },
    ];
    let mut usage = None;

    for event in &events {
        ExecTokenUsage::accumulate_event(&mut usage, event, "turn-1");
    }

    let value = serde_json::to_value(ExecJsonResult::success(
        "session-1",
        "turn-1",
        "done",
        usage,
    ))
    .expect("serialize result");
    assert_eq!(value["usage"]["input_tokens"], 150);
    assert_eq!(value["usage"]["total_tokens"], 160);
    assert!(value["usage"].get("output_tokens").is_none());
    assert!(value["usage"].get("cached_tokens").is_none());
}

#[test]
fn preflight_json_error_omits_unknown_runtime_ids() {
    let result = ExecJsonResult::preflight_error("invalid arguments");
    let value = serde_json::to_value(result).expect("serialize result");

    assert_eq!(value["subtype"], "error");
    assert_eq!(value["is_error"], true);
    assert!(value.get("session_id").is_none());
    assert!(value.get("turn_id").is_none());
    assert!(value.get("error_code").is_none());
}

#[test]
fn session_conflict_json_error_exposes_the_existing_runtime_code() {
    let result = ExecJsonResult::preflight_error("close the other instance")
        .with_error_code("session_in_use");
    let value = serde_json::to_value(result).expect("serialize result");

    assert_eq!(value["error_code"], "session_in_use");
    assert_eq!(value["result"], "close the other instance");
}

#[test]
fn cancelled_json_result_is_an_error_outcome() {
    let result = ExecJsonResult::cancelled("session-1", "turn-1", "cancelled", None);
    let value = serde_json::to_value(result).expect("serialize result");

    assert_eq!(value["subtype"], "cancelled");
    assert_eq!(value["is_error"], true);
}

#[test]
fn stream_json_reuses_the_existing_agentic_envelope() {
    let envelope = AgenticEventEnvelope::new(
        AgenticEvent::SessionStateChanged {
            session_id: "session-1".to_string(),
            new_state: "idle".to_string(),
        },
        AgenticEventPriority::Normal,
    );

    let encoded = serialize_stream_envelope(&envelope).expect("serialize envelope");
    let value: serde_json::Value = serde_json::from_str(&encoded).expect("JSONL record");

    assert_eq!(value["id"], envelope.id);
    assert_eq!(value["event"]["type"], "SessionStateChanged");
    assert!(value.get("schema_version").is_none());
    assert!(value.get("sequence").is_none());
}

#[test]
fn session_conflict_stream_json_reuses_system_error_without_a_new_event_schema() {
    let envelope = session_in_use_stream_envelope();
    let encoded = serialize_stream_envelope(&envelope).expect("serialize envelope");
    let value: serde_json::Value = serde_json::from_str(&encoded).expect("JSONL record");

    assert_eq!(value["event"]["type"], "SystemError");
    assert_eq!(value["event"]["error"], "session_in_use");
    assert_eq!(value["event"]["recoverable"], true);
    assert!(value["event"]["session_id"].is_null());
    assert!(value.get("error_code").is_none());
}

#[test]
fn unsuccessful_completed_turn_is_an_error_outcome() {
    assert_eq!(
        completed_turn_failure(Some(false), Some("empty_round"), Some(false)).as_deref(),
        Some("Execution completed without a successful final response: empty_round")
    );
    assert!(completed_turn_failure(Some(true), Some("stop"), Some(true)).is_none());
    assert!(completed_turn_failure(None, None, None).is_none());
}

#[test]
fn every_exec_terminal_event_is_deferred_until_exec_settlement() {
    let completed = AgenticEvent::DialogTurnCompleted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        total_rounds: 1,
        total_tools: 0,
        duration_ms: 10,
        partial_recovery_reason: None,
        success: Some(true),
        finish_reason: Some("complete".to_string()),
        has_final_response: Some(true),
        background_delivery: None,
    };
    let failed = AgenticEvent::DialogTurnFailed {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        error: "provider failed".to_string(),
        error_category: None,
        error_detail: None,
    };
    let system_error = AgenticEvent::SystemError {
        session_id: Some("session-1".to_string()),
        error: "runtime failed".to_string(),
        recoverable: false,
    };

    assert!(is_exec_terminal(&completed, "turn-1"));
    assert!(!is_exec_terminal(&completed, "turn-other"));
    assert!(is_exec_terminal(&failed, "turn-1"));
    assert!(is_exec_terminal(&system_error, "turn-1"));
}

#[test]
fn settlement_failure_preserves_timeout_and_runtime_error_kinds() {
    let timeout = RuntimeError::Port(PortError::new(
        PortErrorKind::Timeout,
        "turn did not settle",
    ));
    let backend = RuntimeError::Port(PortError::new(
        PortErrorKind::Backend,
        "settlement provider failed",
    ));

    let (timeout_kind, timeout_message) = settlement_failure(timeout, "session-1", "turn-1");
    let (backend_kind, backend_message) = settlement_failure(backend, "session-1", "turn-1");

    assert_eq!(timeout_kind, ExitKind::SettlementTimedOut);
    assert!(timeout_message.starts_with("Timed out waiting"));
    assert_eq!(backend_kind, ExitKind::SystemError);
    assert!(backend_message.starts_with("Failed to wait"));
}

#[test]
fn exec_turn_filter_rejects_other_turn_events_in_the_same_session() {
    let event = AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-other".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "unrelated".to_string(),
    };

    assert_eq!(event_turn_id(&event), Some("turn-other"));
    assert!(!event_belongs_to_exec_turn(
        &event,
        "session-1",
        "turn-current"
    ));
}

#[test]
fn exec_turn_filter_accepts_session_correlated_system_errors() {
    let event = AgenticEvent::SystemError {
        session_id: Some("session-1".to_string()),
        error: "another turn failed".to_string(),
        recoverable: false,
    };

    assert!(event_belongs_to_exec_turn(
        &event,
        "session-1",
        "turn-current"
    ));
    assert!(!event_belongs_to_exec_turn(
        &event,
        "session-other",
        "turn-current"
    ));
}

#[tokio::test]
async fn interrupted_turn_returns_a_delayed_terminal_without_emitting_it() {
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    let sender = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
        event_tx
            .send(AgenticEventEnvelope::new(
                AgenticEvent::DialogTurnCancelled {
                    session_id: "session-1".to_string(),
                    turn_id: "turn-1".to_string(),
                },
                AgenticEventPriority::Critical,
            ))
            .expect("send delayed cancellation terminal");
    });
    let (buffered, terminal) = drain_interrupted_turn_events(&mut event_rx, "session-1", "turn-1")
        .await
        .expect("delayed cancellation terminal must remain observable");
    sender.await.expect("join delayed terminal sender");

    assert!(
        buffered.is_empty(),
        "terminal must be deferred until settlement"
    );
    assert!(matches!(
        terminal.event,
        AgenticEvent::DialogTurnCancelled { .. }
    ));
}

#[tokio::test]
async fn interrupted_turn_treats_system_error_as_a_deferred_terminal() {
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    event_tx
        .send(AgenticEventEnvelope::new(
            AgenticEvent::SystemError {
                session_id: Some("session-1".to_string()),
                error: "runtime cancellation failed".to_string(),
                recoverable: false,
            },
            AgenticEventPriority::Critical,
        ))
        .expect("send system error terminal");
    let (buffered, terminal) = drain_interrupted_turn_events(&mut event_rx, "session-1", "turn-1")
        .await
        .expect("system error must settle cancellation observation");

    assert!(buffered.is_empty(), "terminal must not be emitted early");
    assert!(matches!(terminal.event, AgenticEvent::SystemError { .. }));
}

#[tokio::test]
async fn interrupted_turn_buffers_tail_projection_before_a_completed_race() {
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    event_tx
        .send(AgenticEventEnvelope::new(
            AgenticEvent::TextChunk {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                round_id: "round-1".to_string(),
                attempt_id: None,
                attempt_index: None,
                text: "final answer".to_string(),
            },
            AgenticEventPriority::Normal,
        ))
        .expect("send final text");
    event_tx
        .send(AgenticEventEnvelope::new(
            AgenticEvent::TokenUsageUpdated {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                model_config_id: "model-config".to_string(),
                effective_model_name: "provider-model".to_string(),
                input_tokens: 10,
                output_tokens: Some(5),
                total_tokens: 15,
                max_context_tokens: Some(200_000),
                is_subagent: false,
                cached_tokens: Some(3),
                token_details: None,
            },
            AgenticEventPriority::Normal,
        ))
        .expect("send final usage");
    event_tx
        .send(AgenticEventEnvelope::new(
            AgenticEvent::DialogTurnCompleted {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                total_rounds: 1,
                total_tools: 0,
                duration_ms: 10,
                partial_recovery_reason: None,
                success: Some(true),
                finish_reason: Some("complete".to_string()),
                has_final_response: Some(true),
                background_delivery: None,
            },
            AgenticEventPriority::Critical,
        ))
        .expect("send completed terminal");

    let (buffered, terminal) = drain_interrupted_turn_events(&mut event_rx, "session-1", "turn-1")
        .await
        .expect("completed race must remain observable");

    let mut assistant_text = String::new();
    let mut usage = None;
    for envelope in &buffered {
        if let AgenticEvent::TextChunk { text, .. } = &envelope.event {
            assistant_text.push_str(text);
        }
        ExecTokenUsage::accumulate_event(&mut usage, &envelope.event, "turn-1");
    }

    assert_eq!(assistant_text, "final answer");
    assert_eq!(usage.expect("buffered final usage").total_tokens, 15);
    assert!(matches!(
        terminal.event,
        AgenticEvent::DialogTurnCompleted {
            success: Some(true),
            ..
        }
    ));
}

#[test]
fn settlement_failure_overrides_an_observed_cancellation_terminal() {
    let terminal = AgenticEventEnvelope::new(
        AgenticEvent::DialogTurnCancelled {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
        },
        AgenticEventPriority::Critical,
    );
    let settlement = Err(RuntimeError::Port(PortError::new(
        PortErrorKind::Timeout,
        "turn did not settle",
    )));

    let result =
        resolve_cancelled_turn_observation(Ok(terminal), settlement, "session-1", "turn-1");

    let Err((kind, message)) = result else {
        panic!("settlement failure must replace the observed terminal");
    };
    assert_eq!(kind, ExitKind::SettlementTimedOut);
    assert!(message.contains("turn did not settle"), "{message}");
}

#[test]
fn deferred_exec_event_projects_effective_name_and_input() {
    let identity = ToolEventIdentity::resolved(
        "tool-1",
        openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
        "CreatePlan",
    );
    let wire_input = json!({
        "tool_name": "CreatePlan",
        "args": { "title": "Ship deferred tools" }
    });

    let (tool_name, input) = effective_event_invocation(&identity, &wire_input);

    assert_eq!(tool_name, "CreatePlan");
    assert_eq!(input, &json!({ "title": "Ship deferred tools" }));
    assert_eq!(wire_input["tool_name"], "CreatePlan");
}

fn run_git(workspace: &std::path::Path, args: &[&str]) {
    let output = openbitfun_core::util::process_manager::create_command("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn commit_verification_fixture(workspace: &std::path::Path) {
    run_git(workspace, &["init", "--quiet"]);
    run_git(workspace, &["add", "."]);
    run_git(
        workspace,
        &[
            "-c",
            "user.name=OpenBitFun Test",
            "-c",
            "user.email=openbitfun-test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
}

#[test]
fn final_verification_captures_a_baseline_without_patch_output() {
    assert!(needs_change_baseline(None, true));
    assert!(needs_change_baseline(Some("result.patch"), false));
    assert!(!needs_change_baseline(None, false));
}

#[test]
fn patch_and_verifier_keep_agent_commits_and_exclude_preexisting_untracked_files() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path();
    std::fs::write(workspace.join("tracked.py"), "value = 1\n").expect("tracked file");
    commit_verification_fixture(workspace);
    std::fs::write(workspace.join("private.py"), "private = True\n")
        .expect("preexisting untracked");

    let base = git_diff_base(workspace).expect("execution base");
    let initial_untracked = untracked_files(workspace);
    std::fs::write(workspace.join("tracked.py"), "value = 2\n").expect("agent edit");
    std::fs::write(workspace.join("created.py"), "created = True\n").expect("agent file");
    run_git(workspace, &["add", "tracked.py"]);
    run_git(
        workspace,
        &[
            "-c",
            "user.name=OpenBitFun Test",
            "-c",
            "user.email=openbitfun-test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "agent commit",
        ],
    );

    let changed = changed_files(workspace, Some(&base), &initial_untracked);
    let patch =
        ExecMode::get_git_diff_from_baseline(workspace, Some(&base), &initial_untracked, None)
            .expect("patch");

    assert_eq!(
        changed,
        vec!["created.py".to_string(), "tracked.py".to_string()]
    );
    assert!(patch.contains("value = 2"), "{patch}");
    assert!(patch.contains("created = True"), "{patch}");
    assert!(!patch.contains("private = True"), "{patch}");
}

#[test]
fn automatic_verifier_composes_scoped_go_and_typescript_checks() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path();
    std::fs::write(workspace.join("go.mod"), "module example.com/fixture\n").expect("go.mod");
    std::fs::write(
        workspace.join("tsconfig.json"),
        r#"{"compilerOptions":{"noEmit":true},"include":["web"]}"#,
    )
    .expect("tsconfig");
    std::fs::create_dir_all(workspace.join("pkg")).expect("go package");
    std::fs::create_dir_all(workspace.join("web")).expect("web package");
    let go_source = workspace.join("pkg/example.go");
    let ts_source = workspace.join("web/example.ts");
    std::fs::write(&go_source, "package pkg\n\nconst Value = 1\n").expect("go source");
    std::fs::write(&ts_source, "export const value: number = 1;\n").expect("ts source");
    commit_verification_fixture(workspace);
    std::fs::write(&go_source, "package pkg\n\nconst Value = 2\n").expect("modify go");
    std::fs::write(&ts_source, "export const value: number = 2;\n").expect("modify ts");

    let command =
        detect_verify_command(workspace, Some("HEAD"), &BTreeSet::new()).expect("verifier");
    assert!(command.contains("go vet -printf=false -composites=false -stdmethods=false './pkg'"));
    assert!(command.contains("npx --no-install tsc --noEmit -p 'tsconfig.json'"));
}

#[test]
fn automatic_verifier_checks_the_nearest_cargo_package_and_test_target() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path();
    std::fs::write(
        workspace.join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .expect("Cargo.toml");
    std::fs::create_dir_all(workspace.join("src")).expect("src");
    std::fs::create_dir_all(workspace.join("tests")).expect("tests");
    std::fs::write(workspace.join("src/lib.rs"), "pub fn value() {}\n").expect("lib");
    let test = workspace.join("tests/integration.rs");
    std::fs::write(&test, "#[test]\nfn works() {}\n").expect("test");
    commit_verification_fixture(workspace);
    std::fs::write(&test, "#[test]\nfn still_works() {}\n").expect("modify test");

    let command =
        detect_verify_command(workspace, Some("HEAD"), &BTreeSet::new()).expect("verifier");
    assert!(command
        .contains("cargo check --manifest-path 'Cargo.toml' -p 'fixture' --message-format=short"));
    assert!(command.contains(
        "cargo check --manifest-path 'Cargo.toml' -p 'fixture' --test 'integration' --message-format=short"
    ));
}
