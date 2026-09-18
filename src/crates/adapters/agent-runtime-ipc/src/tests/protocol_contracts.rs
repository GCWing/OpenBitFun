use crate::operation::RuntimeIpcSessionRequirement;
use crate::{
    serialize_frame_with_limit, InitializeRequest, RuntimeAgentModeSummary, RuntimeIpcError,
    RuntimeIpcErrorCode, RuntimeIpcFrame, RuntimeIpcOperation, RuntimeIpcOperationResult,
    RuntimeSessionForkRequest, RuntimeSessionRenameRequest, RuntimeUserAnswersRequest,
    MAX_REQUEST_FRAME_BYTES, PROTOCOL_VERSION,
};

use openbitfun_product_domains::tool_permissions::PermissionReply;
use openbitfun_runtime_ports::{
    AgentContextReloadRequest, AgentContextReloadTarget, AgentDialogSteerRequest,
    AgentDialogTurnRequest, AgentMessageWorkspaceReferencesRequest, AgentSessionCompactionRequest,
    AgentSessionLineageCancellationRequest, AgentSessionLineageRequest,
    AgentSessionLineageTranscriptRequest, AgentSessionModeUpdateRequest,
    AgentSessionModelUpdateRequest, AgentSessionRevertRequest, AgentSubmissionSource,
    AgentWorkspaceReferenceSearchRequest, DialogSubmissionPolicy, WorkspaceDiffContent,
    WorkspaceDiffFile, WorkspaceDiffFileStatus, WorkspaceDiffSnapshot,
};
use serde_json::{json, Map};

#[test]
fn shared_runtime_protocol_supports_workspace_ids_at_version_19() {
    assert_eq!(PROTOCOL_VERSION, 19);
}

#[test]
fn protocol_rejects_unknown_fields_and_operations() {
    let unknown_field =
        r#"{"type":"request","request_id":1,"operation":{"operation":"health"},"metadata":{}}"#
            .to_string();
    assert!(serde_json::from_str::<RuntimeIpcFrame>(&unknown_field).is_err());

    let unknown_operation =
        r#"{"type":"request","request_id":1,"operation":{"operation":"list_sessions"}}"#;
    assert!(serde_json::from_str::<RuntimeIpcFrame>(unknown_operation).is_err());
}

#[test]
fn initialize_debug_redacts_the_bearer_token() {
    let request = InitializeRequest {
        protocol_version: PROTOCOL_VERSION,
        instance_identity: "a".repeat(64),
        token: "top-secret-token".to_string(),
        client_id: "foundation-test".to_string(),
        client_version: "0.1.0".to_string(),
    };

    let debug = format!("{request:?}");
    assert!(!debug.contains("top-secret-token"));
    assert!(debug.contains("[REDACTED]"));
}

#[test]
fn protocol_round_trips_reviewed_permission_and_user_input_operations() {
    let operations = vec![
        RuntimeIpcOperation::PendingPermissions {
            session_id: "session-1".to_string(),
        },
        RuntimeIpcOperation::RespondPermission {
            session_id: "session-1".to_string(),
            request_id: "permission-1".to_string(),
            reply: PermissionReply::Once,
        },
        RuntimeIpcOperation::SubmitUserAnswers {
            request: RuntimeUserAnswersRequest {
                session_id: "session-1".to_string(),
                tool_id: "question-1".to_string(),
                answers: json!({"choice": "yes"}),
            },
        },
    ];

    for operation in operations {
        let encoded = serde_json::to_value(&operation).expect("serialize operation");
        let decoded: RuntimeIpcOperation =
            serde_json::from_value(encoded).expect("deserialize operation");
        assert_eq!(decoded, operation);
    }
}

#[test]
fn protocol_round_trips_read_only_main_agent_catalog() {
    assert_eq!(PROTOCOL_VERSION, 19);
    let operation = RuntimeIpcOperation::ListAgentModes {
        session_id: Some("session-1".to_string()),
    };
    let result = RuntimeIpcOperationResult::AgentModes {
        modes: vec![RuntimeAgentModeSummary {
            id: "review".to_string(),
            route_key: "opencode:review".to_string(),
            description: "Review the current workspace".to_string(),
            model_id: Some("provider/model".to_string()),
            is_external: true,
        }],
    };

    let operation_json =
        serde_json::to_value(&operation).expect("serialize mode catalog operation");
    assert_eq!(
        operation_json,
        json!({"operation": "list_agent_modes", "sessionId": "session-1"})
    );
    let decoded_operation: RuntimeIpcOperation =
        serde_json::from_value(operation_json).expect("deserialize mode catalog operation");
    assert_eq!(decoded_operation, operation);
    assert_eq!(decoded_operation.session_id(), Some("session-1"));
    let rules = decoded_operation.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(!rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(!rules.side_effecting);

    let result_json = serde_json::to_value(&result).expect("serialize mode catalog result");
    assert_eq!(result_json["result"], "agent_modes");
    assert_eq!(result_json["modes"][0]["id"], "review");
    assert_eq!(result_json["modes"][0]["modelId"], "provider/model");
    assert_eq!(result_json["modes"][0]["isExternal"], true);
    let decoded_result: RuntimeIpcOperationResult =
        serde_json::from_value(result_json).expect("deserialize mode catalog result");
    assert_eq!(decoded_result, result);

    let startup_operation = RuntimeIpcOperation::ListAgentModes { session_id: None };
    assert_eq!(startup_operation.session_id(), None);
    assert_eq!(
        startup_operation.rules().session_requirement,
        RuntimeIpcSessionRequirement::None
    );
    assert_eq!(
        serde_json::to_value(startup_operation).expect("serialize startup mode catalog"),
        json!({"operation": "list_agent_modes"})
    );
}

#[test]
fn protocol_round_trips_exact_turn_steering_without_replacing_turn_admission() {
    assert_eq!(PROTOCOL_VERSION, 19);
    let operation = RuntimeIpcOperation::SteerTurn {
        request: AgentDialogSteerRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            content: "check tests".to_string(),
            display_content: Some("Check tests".to_string()),
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        },
    };
    let result = RuntimeIpcOperationResult::TurnSteered {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        steering_id: "steer-1".to_string(),
    };

    let operation_json = serde_json::to_value(&operation).expect("serialize steer operation");
    let result_json = serde_json::to_value(&result).expect("serialize steer result");

    assert_eq!(operation_json["operation"], "steer_turn");
    assert_eq!(operation_json["request"]["turnId"], "turn-1");
    assert_eq!(result_json["result"], "turn_steered");
    assert_eq!(result_json["steeringId"], "steer-1");
    assert_eq!(
        serde_json::from_value::<RuntimeIpcOperation>(operation_json)
            .expect("deserialize steer operation"),
        operation
    );
    assert_eq!(
        serde_json::from_value::<RuntimeIpcOperationResult>(result_json)
            .expect("deserialize steer result"),
        result
    );
}

#[test]
fn protocol_round_trips_read_only_workspace_reference_operations() {
    let operations = vec![
        RuntimeIpcOperation::SearchWorkspaceReferences {
            request: AgentWorkspaceReferenceSearchRequest {
                session_id: "session-1".to_string(),
                query: "src/ma".to_string(),
                limit: 20,
            },
        },
        RuntimeIpcOperation::WorkspaceReferencesForMessage {
            request: AgentMessageWorkspaceReferencesRequest {
                session_id: "session-1".to_string(),
                message_id: "message-1".to_string(),
            },
        },
    ];

    for operation in operations {
        let encoded = serde_json::to_value(&operation).expect("serialize workspace operation");
        let decoded: RuntimeIpcOperation =
            serde_json::from_value(encoded).expect("deserialize workspace operation");
        assert_eq!(decoded, operation);
        assert_eq!(decoded.session_id(), Some("session-1"));
        let rules = decoded.rules();
        assert_eq!(
            rules.session_requirement,
            RuntimeIpcSessionRequirement::CurrentController
        );
        assert!(!rules.requires_idle);
        assert!(!rules.serializes_session_selection);
        assert!(!rules.side_effecting);
    }
}

#[test]
fn protocol_round_trips_root_scoped_lineage_operations() {
    let operations = vec![
        RuntimeIpcOperation::GetSessionLineage {
            request: AgentSessionLineageRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                anchor_session_id: "root-1".to_string(),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        },
        RuntimeIpcOperation::InspectLineageSession {
            request: AgentSessionLineageTranscriptRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                root_session_id: "root-1".to_string(),
                session_id: "child-1".to_string(),
                required_settled_turn_ids: vec!["turn-terminal".to_string()],
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        },
        RuntimeIpcOperation::CancelLineageSession {
            request: AgentSessionLineageCancellationRequest {
                workspace_id: None,
                workspace_path: "D:/workspace/project".to_string(),
                root_session_id: "root-1".to_string(),
                session_id: "child-1".to_string(),
                expected_active_turn_id: Some("turn-child".to_string()),
                source: Some(AgentSubmissionSource::Cli),
                reason: Some("user_cancelled".to_string()),
                wait_timeout_ms: Some(5_000),
                remote_connection_id: None,
                remote_ssh_host: None,
            },
        },
    ];

    for operation in operations {
        let encoded = serde_json::to_value(&operation).expect("serialize lineage operation");
        let decoded: RuntimeIpcOperation =
            serde_json::from_value(encoded).expect("deserialize lineage operation");
        assert_eq!(decoded, operation);
        assert_eq!(decoded.session_id(), Some("root-1"));
    }
}

#[test]
fn protocol_round_trips_workspace_diff_as_a_read_only_workspace_operation() {
    assert_eq!(PROTOCOL_VERSION, 19);

    let operation = RuntimeIpcOperation::WorkspaceDiff;
    let encoded = serde_json::to_value(&operation).expect("serialize workspace diff operation");
    assert_eq!(encoded, json!({"operation": "workspace_diff"}));
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize workspace diff operation");
    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), None);
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::None
    );
    assert!(rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(!rules.side_effecting);

    let result = RuntimeIpcOperationResult::WorkspaceDiff {
        snapshot: WorkspaceDiffSnapshot {
            files: vec![WorkspaceDiffFile {
                path: "src/main.rs".to_string(),
                old_path: None,
                status: WorkspaceDiffFileStatus::Modified,
                staged: false,
                unstaged: true,
                untracked: false,
                additions: 1,
                deletions: 1,
                content: WorkspaceDiffContent::Text {
                    patch: "@@ -1 +1 @@\n-old\n+new\n".to_string(),
                },
            }],
            truncated: false,
        },
    };
    let encoded = serde_json::to_value(&result).expect("serialize workspace diff result");
    let decoded: RuntimeIpcOperationResult =
        serde_json::from_value(encoded).expect("deserialize workspace diff result");
    assert_eq!(decoded, result);
}

#[test]
fn protocol_round_trips_user_shell_as_an_idle_controller_turn() {
    let operation = RuntimeIpcOperation::RunUserShellCommand {
        request: openbitfun_runtime_ports::AgentUserShellCommandRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-shell".to_string(),
            command: "git status --short".to_string(),
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize user shell operation");
    assert_eq!(encoded["operation"], "run_user_shell_command");
    assert_eq!(encoded["request"]["sessionId"], "session-1");
    assert_eq!(encoded["request"]["turnId"], "turn-shell");
    assert_eq!(encoded["request"]["command"], "git status --short");
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize user shell operation");
    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(rules.side_effecting);
}

#[test]
fn protocol_round_trips_the_reviewed_session_mode_operation() {
    let operation = RuntimeIpcOperation::UpdateSessionMode {
        request: AgentSessionModeUpdateRequest {
            session_id: "session-1".to_string(),
            mode_id: "ask".to_string(),
            agent_route_key: None,
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize mode update");
    assert_eq!(encoded["operation"], "update_session_mode");
    assert_eq!(encoded["request"]["sessionId"], "session-1");
    assert_eq!(encoded["request"]["modeId"], "ask");
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize mode update");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    assert_eq!(
        decoded.rules().session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
}

#[test]
fn protocol_round_trips_the_reviewed_session_model_operation() {
    let operation = RuntimeIpcOperation::UpdateSessionModel {
        request: AgentSessionModelUpdateRequest {
            session_id: "session-1".to_string(),
            model_id: "provider/model".to_string(),
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize model update");
    assert_eq!(encoded["operation"], "update_session_model");
    assert_eq!(encoded["request"]["sessionId"], "session-1");
    assert_eq!(encoded["request"]["modelId"], "provider/model");
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize model update");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    assert_eq!(
        decoded.rules().session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
}

#[test]
fn protocol_round_trips_the_current_session_rename_operation() {
    assert_eq!(PROTOCOL_VERSION, 19);

    let operation = RuntimeIpcOperation::RenameSession {
        request: RuntimeSessionRenameRequest {
            session_id: "session-1".to_string(),
            session_name: "Auth refactor".to_string(),
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize session rename");
    assert_eq!(
        encoded,
        json!({
            "operation": "rename_session",
            "request": {
                "sessionId": "session-1",
                "sessionName": "Auth refactor"
            }
        })
    );
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize session rename");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    assert_eq!(
        decoded.rules().session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
}

#[test]
fn protocol_round_trips_fork_as_an_atomic_idle_controller_transition() {
    let operation = RuntimeIpcOperation::ForkSession {
        request: RuntimeSessionForkRequest {
            session_id: "session-1".to_string(),
            before_turn_id: Some("turn-2".to_string()),
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize session fork");
    assert_eq!(
        encoded,
        json!({
            "operation": "fork_session",
            "request": {
                "sessionId": "session-1",
                "beforeTurnId": "turn-2"
            }
        })
    );
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize session fork");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(rules.requires_idle);
    assert!(rules.serializes_session_selection);
    assert!(rules.side_effecting);
}

#[test]
fn protocol_round_trips_manual_compaction_as_an_idle_controller_turn() {
    let operation = RuntimeIpcOperation::CompactSession {
        request: AgentSessionCompactionRequest {
            session_id: "session-1".to_string(),
            turn_id: "turn-compact-1".to_string(),
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize compaction");
    assert_eq!(
        encoded,
        json!({
            "operation": "compact_session",
            "request": {
                "sessionId": "session-1",
                "turnId": "turn-compact-1"
            }
        })
    );
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize compaction");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(rules.side_effecting);
}

#[test]
fn protocol_round_trips_undo_as_an_active_controller_operation() {
    let operation = RuntimeIpcOperation::UndoSession {
        request: AgentSessionRevertRequest {
            workspace_id: None,
            workspace_path: "D:/workspace/project".to_string(),
            session_id: "session-1".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize session undo");
    assert_eq!(encoded["operation"], "undo_session");
    assert_eq!(encoded["request"]["sessionId"], "session-1");
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize session undo");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(!rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(rules.side_effecting);
}

#[test]
fn protocol_round_trips_session_delete_and_not_found() {
    let operation = RuntimeIpcOperation::DeleteSession {
        session_id: "session-2".to_string(),
    };
    let encoded = serde_json::to_value(&operation).expect("serialize session delete");
    assert_eq!(
        encoded,
        json!({
            "operation": "delete_session",
            "sessionId": "session-2"
        })
    );
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize session delete");
    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-2"));

    let frame = RuntimeIpcFrame::Error {
        request_id: Some(7),
        error: RuntimeIpcError {
            code: RuntimeIpcErrorCode::NotFound,
            message: "session not found".to_string(),
        },
    };
    let encoded = serde_json::to_value(&frame).expect("serialize not-found error");
    assert_eq!(encoded["error"]["code"], "not_found");
    let decoded: RuntimeIpcFrame =
        serde_json::from_value(encoded).expect("deserialize not-found error");
    assert_eq!(decoded, frame);
}

#[test]
fn protocol_round_trips_context_reload_as_a_controller_operation() {
    let operation = RuntimeIpcOperation::ReloadSessionContext {
        request: AgentContextReloadRequest {
            session_id: "session-1".to_string(),
            target: AgentContextReloadTarget::Instructions,
        },
    };

    let encoded = serde_json::to_value(&operation).expect("serialize context reload");
    assert_eq!(encoded["operation"], "reload_session_context");
    assert_eq!(encoded["request"]["sessionId"], "session-1");
    assert_eq!(encoded["request"]["target"], "instructions");
    let decoded: RuntimeIpcOperation =
        serde_json::from_value(encoded).expect("deserialize context reload");

    assert_eq!(decoded, operation);
    assert_eq!(decoded.session_id(), Some("session-1"));
    let rules = decoded.rules();
    assert_eq!(
        rules.session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
    assert!(!rules.requires_idle);
    assert!(!rules.serializes_session_selection);
    assert!(rules.side_effecting);
}

#[test]
fn session_mode_operation_rejects_unknown_envelope_fields() {
    let unknown_field = json!({
        "operation": "update_session_mode",
        "request": {
            "sessionId": "session-1",
            "modeId": "ask"
        },
        "metadata": {}
    });

    assert!(serde_json::from_value::<RuntimeIpcOperation>(unknown_field).is_err());
}

#[test]
fn submit_turn_accepts_the_existing_64_kib_tui_paste_contract() {
    let frame = RuntimeIpcFrame::Request {
        request_id: 1,
        operation: RuntimeIpcOperation::SubmitTurn {
            request: AgentDialogTurnRequest {
                session_id: "session-1".to_string(),
                message: "x".repeat(64 * 1024),
                output_schema: None,
                original_message: None,
                turn_id: Some("turn-1".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some("D:/workspace/project".to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: Map::new(),
            },
        },
    };

    serialize_frame_with_limit(&frame, MAX_REQUEST_FRAME_BYTES)
        .expect("64 KiB TUI input plus its typed envelope must fit the request frame");
}

#[test]
fn question_interaction_requires_current_session_controller() {
    let operation = RuntimeIpcOperation::StartQuestionInteraction {
        session_id: "session".into(),
        tool_id: "tool".into(),
    };
    assert_eq!(operation.session_id(), Some("session"));
    let encoded = serde_json::to_value(&operation).unwrap();
    assert_eq!(
        serde_json::from_value::<RuntimeIpcOperation>(encoded).unwrap(),
        operation
    );
    assert_eq!(
        operation.rules().session_requirement,
        RuntimeIpcSessionRequirement::CurrentController
    );
}

#[test]
fn workspace_identity_capability_and_legacy_serializer_are_explicit() {
    let legacy: crate::RuntimeIpcCapabilities = serde_json::from_value(json!({
        "health": true, "interactive_tui": true
    }))
    .unwrap();
    assert!(!legacy.workspace_id_references);
    let current = RuntimeIpcOperation::RestoreSession {
        request: crate::RuntimeSessionRestoreRequest {
            workspace_id: Some("workspace-1".into()),
            workspace_path: String::new(),
            session_id: "session-1".into(),
        },
    };
    let json = serde_json::to_value(&current).unwrap();
    assert_eq!(json["request"]["workspaceId"], "workspace-1");
    assert!(json["request"].get("workspacePath").is_none());
    let projected = crate::legacy_workspace_operation(current, "/legacy-project");
    let json = serde_json::to_value(&projected).unwrap();
    assert!(json["request"].get("workspaceId").is_none());
    assert_eq!(json["request"]["workspacePath"], "/legacy-project");
    assert_eq!(
        serde_json::from_value::<RuntimeIpcOperation>(json).unwrap(),
        projected
    );
}
