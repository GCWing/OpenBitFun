//! Native agent hook process-interface contracts.
//!
//! These tests spawn real hook commands to pin the Codex process contract:
//! the payload arrives on stdin, exit code 0 interprets stdout JSON, exit
//! code 2 blocks with stderr as the reason, other codes warn without
//! blocking, and timeouts kill the handler.
//!
//! Unix-only: the fixtures are `sh` one-liners.
#![cfg(unix)]
#![cfg(feature = "native-hook-runtime")]

use openbitfun_agent_runtime::native_hooks::{
    AgentHookEngine, AgentHookEventPayload, AgentHookOutcome, AgentHookPayload,
    AgentHookPayloadCommon, AgentHookPermissionMode, AgentHookPermissionOutcome, AgentHookScope,
    AgentHookSettings, AgentHookSettingsLayer, MAX_HOOK_MODEL_OUTPUT_BYTES,
};
use serde_json::json;
use std::path::Path;

fn engine(hooks_json: &str) -> AgentHookEngine {
    let (settings, issues) = AgentHookSettings::from_layers(&[AgentHookSettingsLayer {
        scope: AgentHookScope::User,
        source: "test hooks.json".to_string(),
        bytes: hooks_json.as_bytes().to_vec(),
    }]);
    assert!(issues.is_empty(), "unexpected settings issues: {issues:?}");
    AgentHookEngine::new(settings)
}

fn pre_tool_use_payload(tool_name: &str) -> AgentHookPayload {
    AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::PreToolUse {
            tool_name: tool_name.to_string(),
            tool_use_id: "call-1".to_string(),
            tool_input: json!({"command": "ls"}),
        },
    }
}

fn session_start_payload() -> AgentHookPayload {
    AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: None,
        },
        event: AgentHookEventPayload::SessionStart {
            source: "startup".to_string(),
        },
    }
}

async fn dispatch(engine: &AgentHookEngine, payload: &AgentHookPayload) -> AgentHookOutcome {
    engine.dispatch(payload, Path::new(".")).await
}

#[tokio::test]
async fn payload_is_delivered_on_stdin() {
    // `cat` echoes the payload JSON, which parses as a decision document with
    // no recognized fields, so nothing is blocked and no context is added.
    let echo_engine =
        engine(r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cat"}]}]}}"#);
    let outcome = dispatch(&echo_engine, &session_start_payload()).await;

    assert_eq!(outcome.executed_handlers, 1);
    assert!(!outcome.is_blocked());
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);

    // Now assert the payload content itself reached the process.
    let field_engine = engine(
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"python3 -c \"import json,sys; d=json.load(sys.stdin); print(d['hook_event_name'], d['session_id'], d['cwd'], d['model'], d['permission_mode'], d['source'], 'turn_id' in d)\""}]}]}}"#,
    );
    let outcome = dispatch(&field_engine, &session_start_payload()).await;
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
    assert_eq!(
        outcome.additional_context,
        vec!["SessionStart session-1 / model-x default startup False".to_string()]
    );
}

#[tokio::test]
async fn exit_code_zero_with_plain_stdout_becomes_context_for_context_events() {
    let engine = engine(
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo remember this"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &session_start_payload()).await;

    assert_eq!(
        outcome.additional_context,
        vec!["remember this".to_string()]
    );
    assert!(!outcome.is_blocked());
}

#[tokio::test]
async fn plain_stdout_is_ignored_for_non_context_events() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo chatter"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert!(outcome.additional_context.is_empty());
    assert!(!outcome.is_blocked());
    assert!(outcome.permission.is_none());
}

#[tokio::test]
async fn exit_code_two_blocks_with_stderr_as_the_reason() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo not allowed here >&2; exit 2"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(outcome.block_reason.as_deref(), Some("not allowed here"));
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
}

#[tokio::test]
async fn other_exit_codes_warn_without_blocking() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo broken >&2; exit 7"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert!(!outcome.is_blocked());
    assert_eq!(outcome.warnings.len(), 1);
    assert!(
        outcome.warnings[0].contains("non-blocking code 7"),
        "{:?}",
        outcome.warnings
    );
}

#[tokio::test]
async fn permission_decision_deny_is_honored() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"blocked by policy\"}}'"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(
        outcome.permission,
        Some(AgentHookPermissionOutcome::Deny {
            reason: Some("blocked by policy".to_string())
        })
    );
    assert!(outcome.permission_denied());
}

#[tokio::test]
async fn permission_decision_allow_and_updated_input_are_honored() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"updatedInput\":{\"command\":\"ls -la\"}}}'"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(
        outcome.permission,
        Some(AgentHookPermissionOutcome::Allow { reason: None })
    );
    assert_eq!(outcome.updated_input, Some(json!({"command": "ls -la"})));
}

#[tokio::test]
async fn legacy_block_decision_is_honored() {
    let engine = engine(
        r#"{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"printf '{\"decision\":\"block\",\"reason\":\"fix the lint errors\"}'"}]}]}}"#,
    );
    let payload = AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::PostToolUse {
            tool_name: "Edit".to_string(),
            tool_use_id: "call-1".to_string(),
            tool_input: json!({}),
            tool_response: json!({}),
        },
    };
    let outcome = dispatch(&engine, &payload).await;

    assert_eq!(outcome.block_reason.as_deref(), Some("fix the lint errors"));
}

#[tokio::test]
async fn additional_context_and_system_message_are_collected() {
    let engine = engine(
        r#"{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"printf '{\"systemMessage\":\"ran the checker\",\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"2 files changed\"}}'"}]}]}}"#,
    );
    let payload = AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::PostToolUse {
            tool_name: "Edit".to_string(),
            tool_use_id: "call-1".to_string(),
            tool_input: json!({}),
            tool_response: json!({}),
        },
    };
    let outcome = dispatch(&engine, &payload).await;

    assert_eq!(
        outcome.additional_context,
        vec!["2 files changed".to_string()]
    );
    assert_eq!(outcome.system_messages, vec!["ran the checker".to_string()]);
    assert!(!outcome.is_blocked());
}

#[tokio::test]
async fn continue_false_sets_a_stop_reason() {
    let engine = engine(
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"printf '{\"continue\":false,\"stopReason\":\"budget exhausted\"}'"}]}]}}"#,
    );
    let payload = AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::Stop {
            stop_hook_active: false,
            last_assistant_message: None,
        },
    };
    let outcome = dispatch(&engine, &payload).await;

    assert_eq!(outcome.stop_reason.as_deref(), Some("budget exhausted"));
}

#[tokio::test]
async fn permission_request_decision_behavior_is_honored() {
    let engine = engine(
        r#"{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\",\"message\":\"trusted path\"}}}'"}]}]}}"#,
    );
    let payload = AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::PermissionRequest {
            tool_name: "Write".to_string(),
            tool_input: json!({"file_path": "/tmp/x"}),
        },
    };
    let outcome = dispatch(&engine, &payload).await;

    assert_eq!(
        outcome.permission,
        Some(AgentHookPermissionOutcome::Allow {
            reason: Some("trusted path".to_string())
        })
    );
}

#[tokio::test]
async fn matchers_select_which_handlers_run() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[
            {"matcher":"Bash","hooks":[{"type":"command","command":"echo bash >&2; exit 2"}]},
            {"matcher":"Write","hooks":[{"type":"command","command":"echo write >&2; exit 2"}]}
        ]}}"#,
    );

    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;
    assert_eq!(outcome.block_reason.as_deref(), Some("bash"));
    assert_eq!(outcome.executed_handlers, 1);

    let outcome = dispatch(&engine, &pre_tool_use_payload("Read")).await;
    assert_eq!(outcome.executed_handlers, 0);
    assert!(!outcome.is_blocked());
}

#[tokio::test]
async fn first_blocking_handler_stops_later_handlers() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[
            {"type":"command","command":"echo first blocks >&2; exit 2"},
            {"type":"command","command":"echo second should not run >&2; exit 2"}
        ]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(outcome.block_reason.as_deref(), Some("first blocks"));
    assert_eq!(outcome.executed_handlers, 1);
}

#[tokio::test]
async fn handlers_run_in_configuration_order_and_outcomes_merge() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[
            {"type":"command","command":"printf '{\"systemMessage\":\"first\"}'"},
            {"type":"command","command":"printf '{\"systemMessage\":\"second\",\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"safe\"}}}'"}
        ]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(outcome.executed_handlers, 2);
    assert_eq!(
        outcome.system_messages,
        vec!["first".to_string(), "second".to_string()]
    );
    assert_eq!(outcome.updated_input, Some(json!({"command": "safe"})));
}

#[tokio::test]
async fn a_deny_after_an_allow_wins() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[
            {"type":"command","command":"printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'"},
            {"type":"command","command":"printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"second says no\"}}'"}
        ]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(
        outcome.permission,
        Some(AgentHookPermissionOutcome::Deny {
            reason: Some("second says no".to_string())
        })
    );
}

#[tokio::test]
async fn timeouts_kill_the_handler_and_warn() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"sleep 30","timeout":1}]}]}}"#,
    );
    let started = std::time::Instant::now();
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "timeout was not enforced"
    );
    assert!(!outcome.is_blocked());
    assert_eq!(outcome.warnings.len(), 1);
    assert!(
        outcome.warnings[0].contains("timed out"),
        "{:?}",
        outcome.warnings
    );
}

#[tokio::test]
async fn a_hook_that_never_reads_a_large_payload_still_times_out() {
    // The payload must exceed the OS pipe buffer so the stdin write blocks
    // until the handler drains it — which this handler never does.
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"sleep 30","timeout":1}]}]}}"#,
    );
    let mut payload = pre_tool_use_payload("Bash");
    payload.event = AgentHookEventPayload::PreToolUse {
        tool_name: "Bash".to_string(),
        tool_use_id: "call-1".to_string(),
        tool_input: json!({ "command": "x".repeat(512 * 1024) }),
    };

    let started = std::time::Instant::now();
    let outcome = dispatch(&engine, &payload).await;

    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "dispatch hung on the stdin write instead of timing out"
    );
    assert!(!outcome.is_blocked());
    assert_eq!(outcome.warnings.len(), 1);
    assert!(
        outcome.warnings[0].contains("timed out"),
        "{:?}",
        outcome.warnings
    );
}

#[tokio::test]
async fn a_hook_that_echoes_a_large_payload_does_not_deadlock() {
    // `cat` reads stdin and writes it straight back. With a payload larger
    // than the pipe buffer in both directions, a sequential write-then-wait
    // would deadlock: the parent blocks writing stdin while the child blocks
    // writing stdout. The write and the wait must be driven concurrently.
    let engine = engine(
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cat","timeout":20}]}]}}"#,
    );
    let mut payload = session_start_payload();
    payload.event = AgentHookEventPayload::SessionStart {
        source: "x".repeat(512 * 1024),
    };

    let started = std::time::Instant::now();
    let outcome = dispatch(&engine, &payload).await;

    assert!(
        started.elapsed() < std::time::Duration::from_secs(15),
        "dispatch deadlocked between the stdin write and the child's stdout"
    );
    assert_eq!(outcome.executed_handlers, 1);
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
}

#[tokio::test]
async fn a_hook_that_exits_without_reading_stdin_still_succeeds() {
    // The write fails with EPIPE; that must not turn into a warning or block.
    let engine = engine(
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"exec echo done"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &session_start_payload()).await;

    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
    assert_eq!(outcome.additional_context, vec!["done".to_string()]);
}

#[tokio::test]
async fn model_visible_text_from_json_output_is_capped() {
    // The budget must apply to JSON decision fields, not just plain stdout.
    let engine = engine(
        r#"{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"python3 -c \"import json;print(json.dumps({'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':'x'*50000}}))\""}]}]}}"#,
    );
    let payload = AgentHookPayload {
        common: AgentHookPayloadCommon {
            session_id: "session-1".to_string(),
            transcript_path: None,
            cwd: "/".to_string(),
            model: "model-x".to_string(),
            permission_mode: AgentHookPermissionMode::Default,
            turn_id: Some("turn-1".to_string()),
        },
        event: AgentHookEventPayload::PostToolUse {
            tool_name: "Edit".to_string(),
            tool_use_id: "call-1".to_string(),
            tool_input: json!({}),
            tool_response: json!({}),
        },
    };
    let outcome = dispatch(&engine, &payload).await;

    assert_eq!(outcome.additional_context.len(), 1);
    let context = &outcome.additional_context[0];
    assert!(
        context.len() <= MAX_HOOK_MODEL_OUTPUT_BYTES + 32,
        "context was not capped: {} bytes",
        context.len()
    );
    assert!(
        context.ends_with("[hook output truncated]"),
        "{context:.80}"
    );
}

#[tokio::test]
async fn missing_command_warns_without_blocking() {
    let engine = engine(
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"definitely-not-an-installed-binary-xyz"}]}]}}"#,
    );
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    // `sh -c` reports a missing binary as exit code 127, a non-blocking error.
    assert!(!outcome.is_blocked());
    assert_eq!(outcome.warnings.len(), 1);
}

#[tokio::test]
async fn events_without_configured_rules_execute_nothing() {
    let engine =
        engine(r#"{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"echo x"}]}]}}"#);
    let outcome = dispatch(&engine, &pre_tool_use_payload("Bash")).await;

    assert_eq!(outcome.executed_handlers, 0);
    assert!(outcome.additional_context.is_empty());
}

#[cfg(feature = "agent-runtime")]
mod skill_hooks {
    use super::*;
    use openbitfun_agent_runtime::native_hooks::{
        AgentHookEvent, RuntimeHookKind, RuntimeHookRegistry,
    };
    use openbitfun_agent_runtime::skills::SkillHooks;

    fn install(
        registry: &RuntimeHookRegistry,
        command: &str,
        once: bool,
        matcher: &str,
        workspace: Option<&str>,
    ) -> SkillHooks {
        let hooks = SkillHooks::from_yaml(
            &serde_yaml::to_value(json!({"PreToolUse":[{
                "matcher": matcher, "hooks":[{"type":"command", "command":command, "once":once}]
            }]}))
            .unwrap(),
        )
        .unwrap();
        registry
            .register_session_skill(
                "session-1",
                "guard",
                hooks.fingerprint(),
                hooks.registrations("session-1", "guard", "/skills/guard", workspace, "/"),
            )
            .unwrap();
        hooks
    }

    #[tokio::test]
    async fn invocation_is_idempotent_isolated_and_cleanup_invalidates_snapshots() {
        let registry = RuntimeHookRegistry::default();
        let hooks = install(
            &registry,
            "echo blocked >&2; exit 2",
            false,
            "Bash",
            Some("w1"),
        );
        assert_eq!(
            registry
                .register_session_skill(
                    "session-1",
                    "guard",
                    hooks.fingerprint(),
                    hooks.registrations("session-1", "guard", "/skills/guard", Some("w1"), "/")
                )
                .unwrap(),
            1
        );
        assert!(registry
            .register_session_skill(
                "session-1",
                "guard",
                "changed",
                hooks.registrations("session-1", "guard", "/skills/guard", Some("w1"), "/")
            )
            .is_err());
        let engine = AgentHookEngine::with_registry(registry.clone());
        let payload = pre_tool_use_payload("ExecCommand");
        assert_eq!(
            engine
                .dispatch_for_workspace(&payload, Path::new("."), Some("w1"))
                .await
                .block_reason
                .as_deref(),
            Some("blocked")
        );
        assert_eq!(
            engine
                .dispatch_for_workspace(&payload, Path::new("."), Some("w2"))
                .await
                .executed_handlers,
            0
        );
        let mut other = payload.clone();
        other.common.session_id = "session-2".into();
        assert_eq!(
            engine
                .dispatch_for_workspace(&other, Path::new("."), Some("w1"))
                .await
                .executed_handlers,
            0
        );
        let snapshot = registry.registrations_for_session(
            RuntimeHookKind::Lifecycle(AgentHookEvent::PreToolUse),
            Some("w1"),
            "session-1",
        );
        registry.clear_session("session-1");
        let detached = RuntimeHookRegistry::default();
        detached.register_batch(snapshot.to_vec()).unwrap();
        assert_eq!(
            AgentHookEngine::with_registry(detached)
                .dispatch_for_workspace(&payload, Path::new("."), Some("w1"))
                .await
                .executed_handlers,
            0
        );
        assert!(!engine.has_rules_for_session(AgentHookEvent::PreToolUse, Some("w1"), "session-1"));
    }

    #[tokio::test]
    async fn bash_input_environment_and_updated_input_round_trip() {
        let registry = RuntimeHookRegistry::default();
        install(
            &registry,
            r#"python3 -c 'import json,sys,os; d=json.load(sys.stdin); assert d["tool_name"]=="Bash"; assert d["tool_input"]["command"]=="echo before"; assert "cmd" not in d["tool_input"]; assert os.environ["CLAUDE_SESSION_ID"]=="session-1"; assert os.environ["CLAUDE_SKILL_DIR"]=="/skills/guard"; print(json.dumps({"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"review command","updatedInput":{"command":"echo after","yield_time_ms":1000}}}))'"#,
            false,
            "Bash",
            None,
        );
        let engine = AgentHookEngine::with_registry(registry);
        let mut payload = pre_tool_use_payload("ExecCommand");
        if let AgentHookEventPayload::PreToolUse { tool_input, .. } = &mut payload.event {
            *tool_input = json!({"cmd":"echo before"});
        }
        let result = dispatch(&engine, &payload).await;
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(
            result.permission,
            Some(AgentHookPermissionOutcome::Ask {
                reason: Some("review command".into())
            })
        );
        assert_eq!(
            result.updated_input,
            Some(json!({"cmd":"echo after","yield_time_ms":1000}))
        );
    }

    #[tokio::test]
    async fn write_input_round_trip_and_ambiguous_destination_blocks() {
        let registry = RuntimeHookRegistry::default();
        install(
            &registry,
            r#"python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["tool_input"]=={"file_path":"/tmp/a","content":"before"}; print(json.dumps({"hookSpecificOutput":{"updatedInput":{"file_path":"/tmp/b","content":"after"}}}))'"#,
            false,
            "Write",
            None,
        );
        let engine = AgentHookEngine::with_registry(registry);
        let mut payload = pre_tool_use_payload("Write");
        if let AgentHookEventPayload::PreToolUse { tool_input, .. } = &mut payload.event {
            *tool_input = json!({"payload":"+++ /tmp/a\r\nbefore"});
        }
        let result = dispatch(&engine, &payload).await;
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(
            result.updated_input,
            Some(json!({"payload":"+++ /tmp/b\nafter"}))
        );
        if let AgentHookEventPayload::PreToolUse { tool_input, .. } = &mut payload.event {
            *tool_input = json!({"payload":"no path"});
        }
        assert!(dispatch(&engine, &payload).await.is_blocked());
    }

    #[tokio::test]
    async fn once_is_atomic_and_failed_commands_remain_eligible() {
        for command in ["exit 2", "exit 7"] {
            let registry = RuntimeHookRegistry::default();
            install(&registry, command, true, "Read", None);
            let engine = AgentHookEngine::with_registry(registry);
            let payload = pre_tool_use_payload("Read");
            assert_eq!(dispatch(&engine, &payload).await.executed_handlers, 1);
            assert_eq!(dispatch(&engine, &payload).await.executed_handlers, 1);
        }
        let registry = RuntimeHookRegistry::default();
        let hooks = install(&registry, "sleep 0.02; exit 0", true, "Read", None);
        let engine = AgentHookEngine::with_registry(registry.clone());
        let payload = pre_tool_use_payload("Read");
        let (a, b) = tokio::join!(dispatch(&engine, &payload), dispatch(&engine, &payload));
        assert_eq!(a.executed_handlers + b.executed_handlers, 1);
        registry
            .register_session_skill(
                "session-1",
                "guard",
                hooks.fingerprint(),
                hooks.registrations("session-1", "guard", "/skills/guard", None, "/"),
            )
            .unwrap();
        assert_eq!(dispatch(&engine, &payload).await.executed_handlers, 0);
    }

    #[tokio::test]
    async fn project_gate_applies_to_already_registered_skills() {
        let registry = RuntimeHookRegistry::default();
        let hooks = SkillHooks::from_yaml(
            &serde_yaml::from_str("PreToolUse: [{hooks: [{type: command, command: 'exit 2'}]}]")
                .unwrap(),
        )
        .unwrap();
        let mut entries = hooks.registrations("session-1", "project", "/", None, "/");
        entries[0].requires_project_trust = true;
        registry
            .register_session_skill("session-1", "project", hooks.fingerprint(), entries)
            .unwrap();
        let engine = AgentHookEngine::with_registry(registry);
        assert!(dispatch(&engine, &pre_tool_use_payload("Read"))
            .await
            .is_blocked());
        assert_eq!(
            dispatch(
                &engine.with_project_hooks_enabled(false),
                &pre_tool_use_payload("Read")
            )
            .await
            .executed_handlers,
            0
        );
    }

    #[tokio::test]
    async fn clearing_a_session_cancels_an_in_flight_handler() {
        struct Scratch(std::path::PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root =
            Scratch(std::env::temp_dir().join(format!("skill-hook-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir(&root.0).unwrap();
        let registry = RuntimeHookRegistry::default();
        install(
            &registry,
            "touch started; exec sleep 10",
            false,
            "Read",
            None,
        );
        let engine = AgentHookEngine::with_registry(registry.clone());
        let cwd = root.0.clone();
        let running =
            tokio::spawn(async move { engine.dispatch(&pre_tool_use_payload("Read"), &cwd).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !root.0.join("started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        registry.clear_session("session-1");
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), running)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_blocked());
        assert!(
            !AgentHookEngine::with_registry(registry).has_rules_for_session(
                AgentHookEvent::PreToolUse,
                None,
                "session-1"
            )
        );
    }

    #[tokio::test]
    async fn native_settings_do_not_acquire_skill_ask_semantics() {
        let native = engine(
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"printf '%s' '{\"hookSpecificOutput\":{\"permissionDecision\":\"ask\"}}'"}]}]}}"#,
        );
        assert!(dispatch(&native, &pre_tool_use_payload("Read"))
            .await
            .permission
            .is_none());
    }
}
