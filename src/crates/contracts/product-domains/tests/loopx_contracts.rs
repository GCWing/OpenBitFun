#![cfg(feature = "miniapp")]

use openbitfun_product_domains::miniapp::loopx::{
    build_intake_fingerprint, decide_action_status, decide_events_page_status,
    decide_repository_recovery_candidate, decide_task_dedup, decide_task_restart,
    decide_task_transition, derive_environment_status, intake_scope_is_pregrantable,
    is_loopx_monitor_action, parse_loopx_intake, parse_structured_summary,
    project_host_task_from_goal, task_state_after_restart, task_summary_resolves_upstream,
    LoopxActionKind, LoopxActionRequest, LoopxActionStatus, LoopxAgentFinishRequest,
    LoopxAgentPort, LoopxAgentStartRequest, LoopxCliAnswerGateRequest, LoopxCliBuildTurnResult,
    LoopxCliGateDecision, LoopxCliGoalSnapshot, LoopxCliGoalState, LoopxCliHandshakeRequest,
    LoopxCliPort, LoopxCoreEnvironmentFacts, LoopxCreateTaskRequest, LoopxDedupDecision,
    LoopxEnvironmentFact, LoopxEnvironmentFactStatus, LoopxEnvironmentStatus,
    LoopxEventsPageStatus, LoopxExistingTask, LoopxIntakeCandidate, LoopxIntakeParseErrorKind,
    LoopxIntakePreview, LoopxIntakeTarget, LoopxIssueKey, LoopxItemKind,
    LoopxOptionalEnvironmentFacts, LoopxPermissionScope, LoopxPhase, LoopxRemoteItemState,
    LoopxRepositoryKey, LoopxResolveIntakeRequest, LoopxRestartDecision, LoopxSnapshot,
    LoopxTaskIdentity, LoopxTaskSnapshot, LoopxTaskState, LoopxTransitionDecision,
    LoopxWorkspacePort, LoopxWorkspacePrepareRequest, LOOPX_CLI_SCHEMA_VERSION,
    LOOPX_PINNED_VERSION, LOOPX_REQUIRED_PERMISSION_SCOPES,
};

fn issue(owner: &str, repository: &str, number: u64) -> LoopxIssueKey {
    LoopxIssueKey {
        repository: LoopxRepositoryKey {
            host: "github.com".to_string(),
            owner: owner.to_ascii_lowercase(),
            repository: repository.to_ascii_lowercase(),
        },
        kind: LoopxItemKind::Issue,
        number,
    }
}

fn existing(
    task_id: &str,
    key: LoopxIssueKey,
    attempt: u32,
    state: LoopxTaskState,
) -> LoopxExistingTask {
    LoopxExistingTask {
        task_id: task_id.to_string(),
        identity: LoopxTaskIdentity {
            item: key,
            attempt,
            ..Default::default()
        },
        state,
    }
}

#[test]
fn github_url_matrix_accepts_only_supported_intake_targets() {
    let cases = [
        (
            "https://github.com/OpenAI/Codex/issues/123?utm_source=test#issuecomment-1",
            "github.com/openai/codex/issues/123",
        ),
        (
            "https://www.github.com/OpenAI/Codex/pull/456/",
            "github.com/openai/codex/pull/456",
        ),
        ("https://github.com/OpenAI/Codex", "github.com/openai/codex"),
        (
            "https://github.com/OpenAI/Codex/issues?q=is%3Aopen",
            "github.com/openai/codex",
        ),
        ("git@github.com:OpenAI/Codex.git", "github.com/openai/codex"),
        ("OpenAI/Codex", "github.com/openai/codex"),
    ];

    for (input, expected) in cases {
        let parsed = parse_loopx_intake(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        let actual = match parsed {
            LoopxIntakeTarget::Repository { repository } => repository.canonical_id(),
            LoopxIntakeTarget::Item { item } => item.canonical_id(),
        };
        assert_eq!(actual, expected, "{input}");
    }

    let unsupported = parse_loopx_intake("https://gitlab.com/openai/codex/issues/1").unwrap_err();
    assert_eq!(unsupported.kind, LoopxIntakeParseErrorKind::UnsupportedHost);
    let unsupported_path =
        parse_loopx_intake("https://github.com/openai/codex/actions").unwrap_err();
    assert_eq!(
        unsupported_path.kind,
        LoopxIntakeParseErrorKind::UnsupportedPath
    );
    let zero = parse_loopx_intake("https://github.com/openai/codex/issues/0").unwrap_err();
    assert_eq!(zero.kind, LoopxIntakeParseErrorKind::InvalidItemNumber);
}

#[test]
fn canonical_item_identity_collapses_case_and_url_noise() {
    let first = parse_loopx_intake("https://github.com/OpenAI/Codex/issues/42").unwrap();
    let second = parse_loopx_intake("http://github.com/openai/codex/issues/42?x=1").unwrap();
    assert_eq!(first, second);

    let LoopxIntakeTarget::Item { item } = first else {
        panic!("expected item target");
    };
    assert_eq!(item.canonical_id(), "github.com/openai/codex/issues/42");
    assert_eq!(
        item.canonical_url(),
        "https://github.com/openai/codex/issues/42"
    );

    let pr = parse_loopx_intake("https://github.com/openai/codex/pull/42").unwrap();
    assert_ne!(LoopxIntakeTarget::Item { item }, pr);
}

#[test]
fn nonterminal_duplicate_opens_the_existing_task() {
    let key = issue("openai", "codex", 7);
    let tasks = vec![existing(
        "task-running",
        key.clone(),
        1,
        LoopxTaskState::Running,
    )];

    assert_eq!(
        decide_task_dedup(&key, LoopxRemoteItemState::Open, &tasks, false),
        LoopxDedupDecision::OpenExisting {
            task_id: "task-running".to_string()
        }
    );
}

#[test]
fn terminal_duplicate_requires_an_explicit_new_attempt() {
    let key = issue("openai", "codex", 8);
    let tasks = vec![
        existing("attempt-1", key.clone(), 1, LoopxTaskState::Failed),
        existing("attempt-2", key.clone(), 2, LoopxTaskState::Completed),
    ];

    assert_eq!(
        decide_task_dedup(&key, LoopxRemoteItemState::Open, &tasks, false),
        LoopxDedupDecision::RequireExplicitRetry {
            previous_task_id: "attempt-2".to_string(),
            next_attempt: 3,
        }
    );
    assert_eq!(
        decide_task_dedup(&key, LoopxRemoteItemState::Open, &tasks, true),
        LoopxDedupDecision::CreateAttempt { attempt: 3 }
    );
}

#[test]
fn resolved_remote_item_is_a_successful_noop() {
    let key = issue("openai", "codex", 9);
    assert_eq!(
        decide_task_dedup(&key, LoopxRemoteItemState::Closed, &[], false),
        LoopxDedupDecision::ClosedNoop
    );

    let mut pr = key;
    pr.kind = LoopxItemKind::PullRequest;
    assert_eq!(
        decide_task_dedup(&pr, LoopxRemoteItemState::Merged, &[], false),
        LoopxDedupDecision::ClosedNoop
    );
}

#[test]
fn restart_requeues_safe_pending_work_and_recovers_inflight_work() {
    for state in [LoopxTaskState::Preparing, LoopxTaskState::RetryWait] {
        assert_eq!(
            decide_task_restart(state),
            LoopxRestartDecision::Preserve {
                state: LoopxTaskState::Queued
            }
        );
        assert_eq!(task_state_after_restart(state), LoopxTaskState::Queued);
    }

    for state in [LoopxTaskState::Running, LoopxTaskState::Cancelling] {
        assert_eq!(
            decide_task_restart(state),
            LoopxRestartDecision::RequireRecovery
        );
        assert_eq!(
            task_state_after_restart(state),
            LoopxTaskState::RecoveryRequired
        );
    }

    for state in [
        LoopxTaskState::Queued,
        LoopxTaskState::WaitingForUser,
        LoopxTaskState::RecoveryRequired,
        LoopxTaskState::Stopped,
        LoopxTaskState::Completed,
        LoopxTaskState::Failed,
        LoopxTaskState::Archived,
    ] {
        assert_eq!(
            decide_task_restart(state),
            LoopxRestartDecision::Preserve { state }
        );
        assert_eq!(task_state_after_restart(state), state);
    }
}

#[test]
fn authoritative_goal_projection_preserves_explicit_host_stops() {
    let stopped = project_host_task_from_goal(
        LoopxTaskState::Stopped,
        LoopxPhase::Finished,
        LoopxCliGoalState::Completed,
    );
    assert_eq!(stopped.state, LoopxTaskState::Stopped);

    let completed = project_host_task_from_goal(
        LoopxTaskState::RecoveryRequired,
        LoopxPhase::Recovering,
        LoopxCliGoalState::Completed,
    );
    assert_eq!(completed.state, LoopxTaskState::Completed);
    assert_eq!(completed.phase, LoopxPhase::Finished);

    let reopened = project_host_task_from_goal(
        LoopxTaskState::Completed,
        LoopxPhase::Finished,
        LoopxCliGoalState::Active,
    );
    assert_eq!(reopened.state, LoopxTaskState::RecoveryRequired);
    assert_eq!(reopened.phase, LoopxPhase::Recovering);

    let pending_approval = project_host_task_from_goal(
        LoopxTaskState::WaitingForUser,
        LoopxPhase::WaitingForApproval,
        LoopxCliGoalState::Active,
    );
    assert_eq!(pending_approval.state, LoopxTaskState::WaitingForUser);
    assert_eq!(pending_approval.phase, LoopxPhase::WaitingForApproval);
}

#[test]
fn transition_policy_separates_turn_completion_from_task_completion() {
    assert_eq!(
        decide_task_transition(LoopxTaskState::Running, LoopxTaskState::Queued),
        LoopxTransitionDecision::Allowed {
            next: LoopxTaskState::Queued
        }
    );
    assert_eq!(
        decide_task_transition(LoopxTaskState::Running, LoopxTaskState::Completed),
        LoopxTransitionDecision::Allowed {
            next: LoopxTaskState::Completed
        }
    );
    assert_eq!(
        decide_task_transition(LoopxTaskState::Completed, LoopxTaskState::Running),
        LoopxTransitionDecision::Rejected
    );
}

#[test]
fn additive_snapshot_fields_deserialize_with_safe_legacy_defaults() {
    let snapshot: LoopxSnapshot = serde_json::from_value(serde_json::json!({
        "streamId": "legacy-stream",
        "tasks": [{
            "id": "legacy-task",
            "status": "legacy_active",
            "identity": {
                "item": {
                    "repository": {
                        "host": "github.com",
                        "owner": "openai",
                        "repository": "codex"
                    },
                    "kind": "issue",
                    "number": 10
                },
                "attempt": 1
            }
        }]
    }))
    .unwrap();

    assert_eq!(snapshot.schema_version, LOOPX_CLI_SCHEMA_VERSION);
    assert_eq!(snapshot.tasks[0].state, LoopxTaskState::RecoveryRequired);
    assert_eq!(snapshot.tasks[0].task_id, "legacy-task");
    assert_eq!(
        snapshot.environment.core.sidecar.status,
        LoopxEnvironmentFactStatus::Unknown
    );
    assert_eq!(
        snapshot.execution_support.to_string(),
        "unsupported_execution_domain"
    );

    let encoded = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(encoded["tasks"][0]["state"], "recovery_required");
    assert_eq!(encoded["executionSupport"], "unsupported_execution_domain");

    let preview: LoopxIntakePreview = serde_json::from_value(serde_json::json!({
        "fingerprint": "legacy-preview",
        "workspace": {
            "disposition": "clone_required",
            "repositoryVerified": false
        },
        "model": {
            "modelId": "auto",
            "available": true,
            "supportsImages": false
        }
    }))
    .unwrap();
    assert_eq!(preview.workspace.detail, None);
    assert_eq!(preview.model.detail, None);

    let goal: LoopxCliGoalSnapshot = serde_json::from_value(serde_json::json!({
        "goalId": "legacy-goal",
        "state": "waiting_for_user",
        "runDecision": "waiting_for_user"
    }))
    .unwrap();
    assert_eq!(goal.pending_user_gate, None);
}

#[test]
fn action_and_create_requests_use_idempotency_and_revision_fields() {
    let resolve: LoopxResolveIntakeRequest = serde_json::from_value(serde_json::json!({
        "input": "https://github.com/openai/codex/issues/1"
    }))
    .unwrap();
    assert_eq!(resolve.model_id, "auto");

    let action: LoopxActionRequest = serde_json::from_value(serde_json::json!({
        "taskId": "task-1",
        "action": "retry_environment",
        "clientRequestId": "request-1",
        "expectedRevision": 17
    }))
    .unwrap();
    assert_eq!(action.action, LoopxActionKind::RetryEnvironment);
    assert_eq!(action.client_request_id, "request-1");
    assert_eq!(action.expected_revision, 17);

    let reset: LoopxActionRequest = serde_json::from_value(serde_json::json!({
        "action": "reset_all",
        "clientRequestId": "request-reset",
        "expectedRevision": 18
    }))
    .unwrap();
    assert_eq!(reset.action, LoopxActionKind::ResetAll);
    assert_eq!(reset.task_id, None);

    let install: LoopxActionRequest = serde_json::from_value(serde_json::json!({
        "action": "install_loopx",
        "clientRequestId": "request-install",
        "expectedRevision": 19
    }))
    .unwrap();
    assert_eq!(install.action, LoopxActionKind::InstallLoopx);
    assert_eq!(install.task_id, None);

    let retired_action: LoopxActionRequest = serde_json::from_value(serde_json::json!({
        "action": "install_open_viking",
        "clientRequestId": "request-install-open-viking",
        "expectedRevision": 20
    }))
    .unwrap();
    assert_eq!(retired_action.action, LoopxActionKind::Unsupported);
    assert_eq!(retired_action.task_id, None);

    let create: LoopxCreateTaskRequest = serde_json::from_value(serde_json::json!({
        "clientRequestId": "request-2",
        "previewFingerprint": "sha256:abc",
        "selectedItems": [],
        "modelId": "primary",
        "grantedScopes": ["workspace_read"],
        "retryTerminal": false
    }))
    .unwrap();
    assert_eq!(create.client_request_id, "request-2");
    assert_eq!(
        create.granted_scopes,
        vec![LoopxPermissionScope::WorkspaceRead]
    );

    let page_status = serde_json::to_value(LoopxEventsPageStatus::SnapshotRequired).unwrap();
    assert_eq!(page_status, "snapshot_required");
}

#[test]
fn intake_fingerprint_is_order_independent_but_state_sensitive() {
    let target = parse_loopx_intake("https://github.com/openai/codex/issues").unwrap();
    let candidate = |number, state| LoopxIntakeCandidate {
        key: issue("openai", "codex", number),
        url: format!("https://github.com/openai/codex/issues/{number}"),
        title: format!("Issue {number}"),
        state,
        ..LoopxIntakeCandidate::default()
    };
    let first = vec![
        candidate(1, LoopxRemoteItemState::Open),
        candidate(2, LoopxRemoteItemState::Open),
    ];
    let reversed = vec![first[1].clone(), first[0].clone()];
    let scopes = [
        LoopxPermissionScope::AgentExecution,
        LoopxPermissionScope::WorkspaceWrite,
    ];

    let fingerprint =
        build_intake_fingerprint(&target, &first, Some("/work/codex"), "primary", &scopes);
    assert_eq!(
        fingerprint,
        build_intake_fingerprint(&target, &reversed, Some("/work/codex"), "primary", &scopes)
    );

    let changed = vec![
        candidate(1, LoopxRemoteItemState::Closed),
        candidate(2, LoopxRemoteItemState::Open),
    ];
    assert_ne!(
        fingerprint,
        build_intake_fingerprint(&target, &changed, Some("/work/codex"), "primary", &scopes)
    );
}

#[test]
fn handshake_defaults_pin_the_supported_loopx_contract() {
    let request: LoopxCliHandshakeRequest = serde_json::from_value(serde_json::json!({
        "operationId": "probe-1"
    }))
    .unwrap();
    assert_eq!(request.required_loopx_version, LOOPX_PINNED_VERSION);
    assert_eq!(request.required_schema_version, LOOPX_CLI_SCHEMA_VERSION);

    fn assert_object_safe(_: &dyn LoopxCliPort) {}
    let _ = assert_object_safe;
}

#[test]
fn workspace_agent_and_gate_ports_keep_routes_typed() {
    let key = issue("openai", "codex", 11);
    let workspace = LoopxWorkspacePrepareRequest {
        operation_id: "workspace-1".to_string(),
        task_id: "task-1".to_string(),
        item: key.clone(),
    };
    let workspace_json = serde_json::to_value(workspace).unwrap();
    assert_eq!(workspace_json["operationId"], "workspace-1");
    assert_eq!(workspace_json["item"]["number"], 11);
    assert!(workspace_json.get("worktreePath").is_none());

    let agent = LoopxAgentStartRequest {
        operation_id: "agent-1".to_string(),
        task_id: "task-1".to_string(),
        generation: 3,
        worktree_path: "/worktrees/task-1".to_string(),
        instruction: "Fix the selected issue".to_string(),
        model_id: "primary".to_string(),
        granted_scopes: LOOPX_REQUIRED_PERMISSION_SCOPES.to_vec(),
        metadata: Default::default(),
        reuse_session_id: None,
    };
    let agent_json = serde_json::to_value(agent).unwrap();
    assert_eq!(agent_json["generation"], 3);
    assert_eq!(agent_json["worktreePath"], "/worktrees/task-1");
    assert_eq!(agent_json["instruction"], "Fix the selected issue");
    assert_eq!(agent_json["grantedScopes"].as_array().unwrap().len(), 5);

    let legacy_agent: LoopxAgentStartRequest = serde_json::from_value(serde_json::json!({
        "prompt": "Legacy LoopX prompt"
    }))
    .unwrap();
    assert_eq!(legacy_agent.instruction, "Legacy LoopX prompt");

    let legacy_turn: LoopxCliBuildTurnResult = serde_json::from_value(serde_json::json!({
        "prompt": "Legacy turn prompt"
    }))
    .unwrap();
    assert_eq!(legacy_turn.agent_instruction, "Legacy turn prompt");

    let finish = LoopxAgentFinishRequest {
        operation_id: "finish-1".to_string(),
        task_id: "task-1".to_string(),
        generation: 3,
        worktree_path: "/worktrees/task-1".to_string(),
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
    };
    let finish_json = serde_json::to_value(finish).unwrap();
    assert_eq!(finish_json["worktreePath"], "/worktrees/task-1");
    assert_eq!(finish_json["sessionId"], "session-1");
    assert_eq!(finish_json["turnId"], "turn-1");
    let finish_roundtrip: LoopxAgentFinishRequest = serde_json::from_value(finish_json).unwrap();
    assert_eq!(finish_roundtrip.worktree_path, "/worktrees/task-1");
    assert_eq!(LoopxAgentFinishRequest::default().worktree_path, "");

    let gate: LoopxCliAnswerGateRequest = serde_json::from_value(serde_json::json!({
        "operationId": "gate-1",
        "taskId": "task-1",
        "generation": 3,
        "worktreePath": "/worktrees/task-1",
        "registryPath": "/worktrees/task-1/.loopx/registry.json",
        "goalId": "goal-1",
        "agentId": "agent-1",
        "gateId": "gate-publish",
        "decision": "reject",
        "note": "Do not publish",
        "grantedScope": null
    }))
    .unwrap();
    assert_eq!(gate.decision, LoopxCliGateDecision::Reject);
    assert_eq!(gate.agent_id, "agent-1");
    assert_eq!(gate.gate_id, "gate-publish");

    fn assert_workspace_object_safe(_: &dyn LoopxWorkspacePort) {}
    fn assert_agent_object_safe(_: &dyn LoopxAgentPort) {}
    let _ = (assert_workspace_object_safe, assert_agent_object_safe);
}

#[test]
fn optional_environment_failures_degrade_without_blocking_core_readiness() {
    let available = LoopxEnvironmentFact {
        status: LoopxEnvironmentFactStatus::Available,
        ..LoopxEnvironmentFact::default()
    };
    let core = LoopxCoreEnvironmentFacts {
        sidecar: available.clone(),
        git_worktree: available.clone(),
        agent_model: available.clone(),
        // Node is a core fact on the v1.0.x pin (bootstrap fail-closes
        // without it); the test's intent is "all core facts available",
        // so it must not leave the Node fact at its legacy Unknown default.
        node_runtime: available,
    };
    let optional = LoopxOptionalEnvironmentFacts {
        python_fallback: LoopxEnvironmentFact {
            status: LoopxEnvironmentFactStatus::Unavailable,
            ..LoopxEnvironmentFact::default()
        },
        ..LoopxOptionalEnvironmentFacts::default()
    };
    assert_eq!(
        derive_environment_status(&core, &optional),
        LoopxEnvironmentStatus::Degraded
    );

    let disabled_optional = LoopxOptionalEnvironmentFacts::default();
    assert_eq!(
        derive_environment_status(&core, &disabled_optional),
        LoopxEnvironmentStatus::Ready
    );

    let mut blocked_core = core;
    blocked_core.sidecar.status = LoopxEnvironmentFactStatus::Unavailable;
    assert_eq!(
        derive_environment_status(&blocked_core, &optional),
        LoopxEnvironmentStatus::Blocked
    );
    assert!(intake_scope_is_pregrantable(
        LoopxPermissionScope::WorkspaceWrite
    ));
    assert!(!intake_scope_is_pregrantable(
        LoopxPermissionScope::PullRequest
    ));
}

#[test]
fn action_idempotency_precedes_revision_conflict() {
    assert_eq!(
        decide_action_status(true, 4, 5),
        LoopxActionStatus::Duplicate
    );
    assert_eq!(
        decide_action_status(false, 4, 5),
        LoopxActionStatus::RevisionConflict
    );
    assert_eq!(
        decide_action_status(false, 5, 5),
        LoopxActionStatus::Applied
    );
}

#[test]
fn event_cursor_gaps_and_stream_changes_require_a_snapshot() {
    assert_eq!(
        decide_events_page_status("stream-2", "stream-1", 10, Some(5), 20),
        LoopxEventsPageStatus::SnapshotRequired
    );
    assert_eq!(
        decide_events_page_status("stream-2", "stream-2", 3, Some(5), 20),
        LoopxEventsPageStatus::SnapshotRequired
    );
    assert_eq!(
        decide_events_page_status("stream-2", "stream-2", 4, Some(5), 20),
        LoopxEventsPageStatus::Current
    );
    assert_eq!(
        decide_events_page_status("stream-2", "stream-2", 21, Some(5), 20),
        LoopxEventsPageStatus::SnapshotRequired
    );
}

trait EnumString {
    fn to_string(self) -> String;
}

impl EnumString for openbitfun_product_domains::miniapp::loopx::LoopxExecutionSupport {
    fn to_string(self) -> String {
        serde_json::to_value(self)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }
}

#[test]
fn resolved_upstream_summaries_are_detected_in_both_locales() {
    assert!(task_summary_resolves_upstream(Some(
        "Issue covered-upstream by #618 (merged 2026-08-25); no follow-up required."
    )));
    assert!(task_summary_resolves_upstream(Some(
        "原始故障路径在 v2.0.3 中已消失，不开 PR，无需继续修复。"
    )));
    assert!(!task_summary_resolves_upstream(Some(
        "Candidate evidence collected; implementation requires parent write approval."
    )));
    assert!(!task_summary_resolves_upstream(Some("  ")));
    assert!(!task_summary_resolves_upstream(None));
}

#[test]
fn repository_recovery_candidates_exclude_resolved_upstream_tasks() {
    let repository = "github.com/owner/repo";
    let mut task = LoopxTaskSnapshot {
        task_id: "task-1".to_string(),
        identity: LoopxTaskIdentity {
            item: issue("owner", "repo", 515),
            attempt: 1,
            title: "t".to_string(),
            description: String::new(),
            state: LoopxRemoteItemState::Open,
            labels: Vec::new(),
        },
        state: LoopxTaskState::RecoveryRequired,
        ..LoopxTaskSnapshot::default()
    };
    assert!(decide_repository_recovery_candidate(&task, repository));

    task.last_agent_summary =
        Some("Issue covered_upstream by #618; no follow-up required.".to_string());
    assert!(!decide_repository_recovery_candidate(&task, repository));

    task.state = LoopxTaskState::Running;
    task.last_agent_summary = None;
    assert!(!decide_repository_recovery_candidate(&task, repository));

    task.state = LoopxTaskState::RecoveryRequired;
    assert!(!decide_repository_recovery_candidate(
        &task,
        "github.com/owner/other"
    ));
}

#[test]
fn recovery_reason_survives_a_persist_round_trip() {
    let mut task = LoopxTaskSnapshot {
        task_id: "task-1".to_string(),
        state: LoopxTaskState::RecoveryRequired,
        recovery_reason: Some("settlement_unverified".to_string()),
        ..LoopxTaskSnapshot::default()
    };
    let json = serde_json::to_string(&task).expect("serialize");
    assert!(json.contains("recoveryReason"));
    let parsed: LoopxTaskSnapshot = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(
        parsed.recovery_reason.as_deref(),
        Some("settlement_unverified")
    );

    // Legacy payloads without the field deserialize with a None reason.
    task.recovery_reason = None;
    let legacy = serde_json::to_string(&LoopxTaskSnapshot {
        task_id: "legacy".to_string(),
        state: LoopxTaskState::Failed,
        ..LoopxTaskSnapshot::default()
    })
    .expect("serialize legacy");
    let parsed_legacy: LoopxTaskSnapshot =
        serde_json::from_str(&legacy).expect("deserialize legacy");
    assert_eq!(parsed_legacy.recovery_reason, None);
}

#[test]
fn structured_summary_parses_valid_block_and_rejects_contract_violations() {
    let valid = "本段完成。\n\n```loopx_summary_v1\n{\"issue_verdict\":\"needs_fix\",\"reproduction\":\"reproduced\",\"reproduction_evidence\":\"evidence/rep.md\",\"segment_kind\":\"evidence\",\"completed\":[\"收集完成\"],\"next_step\":\"实现修复\"}\n```\n";
    let parsed = parse_structured_summary(Some(valid)).expect("valid block parses");
    assert_eq!(
        parsed.get("issue_verdict").and_then(|v| v.as_str()),
        Some("needs_fix")
    );

    // already_fixed_upstream without fixed_by is a contract violation.
    let missing_link = "```loopx_summary_v1\n{\"issue_verdict\":\"already_fixed_upstream\"}\n```";
    assert_eq!(parse_structured_summary(Some(missing_link)), None);

    // wont_fix without a reason is rejected.
    let missing_reason = "```loopx_summary_v1\n{\"issue_verdict\":\"wont_fix\"}\n```";
    assert_eq!(parse_structured_summary(Some(missing_reason)), None);

    // reproduced without evidence is rejected.
    let missing_evidence = "```loopx_summary_v1\n{\"issue_verdict\":\"needs_fix\",\"reproduction\":\"reproduced\"}\n```";
    assert_eq!(parse_structured_summary(Some(missing_evidence)), None);

    // Unknown enum values are rejected.
    let unknown = "```loopx_summary_v1\n{\"issue_verdict\":\"maybe\",\"fixed_by\":\"x\"}\n```";
    assert_eq!(parse_structured_summary(Some(unknown)), None);

    // No block at all falls back to None.
    assert_eq!(parse_structured_summary(Some("plain text only")), None);
    assert_eq!(parse_structured_summary(None), None);
}

#[test]
fn monitor_action_classification_covers_track_and_monitor_kinds() {
    // The pinned issue-fix workflow emits the merge-readiness tracker as
    // `issue_fix_track_pr_merge_readiness`; the watch family uses the
    // `_monitor` suffix. Both are monitor-class for the UI "PR monitor
    // waiting" projection.
    assert!(is_loopx_monitor_action(
        "issue_fix_track_pr_merge_readiness"
    ));
    assert!(is_loopx_monitor_action("issue_fix_pr_state_open_monitor"));
    assert!(is_loopx_monitor_action("continuous_monitor"));
    // Real work segments never classify as monitor-class.
    assert!(!is_loopx_monitor_action(
        "issue_fix_collect_candidate_evidence"
    ));
    assert!(!is_loopx_monitor_action("issue_fix_reuse_existing_pr"));
    assert!(!is_loopx_monitor_action("issue_fix_implementation"));
    assert!(!is_loopx_monitor_action(""));
    assert!(!is_loopx_monitor_action("   "));
}
