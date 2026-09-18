//! Server-owned translations between behavior-light wire DTOs and runtime or
//! service-owner types.

use openbitfun_agent_runtime::sdk::{
    AgentRunHandle, AgentRunRequest, AgentSessionRestoreRequest, AgentSessionRestoreResult,
    DialogSubmitOutcome, SessionSelector,
};
use openbitfun_agent_runtime::session_state::{ProcessingPhase, SessionState};
use openbitfun_app_server_protocol::agent::{
    RunMessage, RunResponse, RunSessionSpec, SubmitDialogTurnBody, SubmitDialogTurnResponse,
};
use openbitfun_app_server_protocol::config::AgentProfileView;
use openbitfun_app_server_protocol::event::ConfigUpdate;
use openbitfun_app_server_protocol::git::{
    GitBranch, GitBranchStats, GitFileStatus, GitLinesChanged, GitStatus, GitTrustReport,
    GitTrustState,
};
use openbitfun_app_server_protocol::session::{
    RestoreSessionMessage, RestoreSessionResponse, SessionProcessingPhase, SessionRuntimeState,
};
use openbitfun_runtime_ports::{
    AgentDialogTurnRequest, AgentSubmissionSource, DialogSubmissionPolicy,
};

pub(super) fn submit_dialog_turn_request(body: SubmitDialogTurnBody) -> AgentDialogTurnRequest {
    body.to_request(DialogSubmissionPolicy::for_source(
        AgentSubmissionSource::DesktopUi,
    ))
}

pub(super) fn submit_dialog_turn_response(
    outcome: DialogSubmitOutcome,
) -> SubmitDialogTurnResponse {
    match outcome {
        DialogSubmitOutcome::Started {
            session_id,
            turn_id,
        } => SubmitDialogTurnResponse::Started {
            session_id,
            turn_id,
        },
        DialogSubmitOutcome::Queued {
            session_id,
            turn_id,
        } => SubmitDialogTurnResponse::Queued {
            session_id,
            turn_id,
        },
    }
}

pub(super) fn run_request(request: &RunMessage) -> AgentRunRequest {
    let session = match &request.session {
        RunSessionSpec::Existing { session_id } => SessionSelector::existing(session_id),
        RunSessionSpec::Create {
            session_name,
            agent_type,
            workspace_id,
            workspace_path,
        } => SessionSelector::create(session_name, agent_type, workspace_path.clone())
            .with_workspace_id(workspace_id.clone()),
    };
    let mut runtime_request = AgentRunRequest::new(session, &request.message);
    if let Some(turn_id) = &request.turn_id {
        runtime_request = runtime_request.with_turn_id(turn_id);
    }
    if let Some(source) = request.source {
        runtime_request = runtime_request.with_source(source);
    }
    runtime_request
}

pub(super) fn run_response(handle: AgentRunHandle) -> RunResponse {
    RunResponse {
        session_id: handle.session_id,
        turn_id: handle.turn_id,
        agent_type: handle.agent_type,
        accepted: handle.accepted,
    }
}

pub(super) fn restore_session_request(
    request: RestoreSessionMessage,
) -> AgentSessionRestoreRequest {
    AgentSessionRestoreRequest {
        workspace_id: request.workspace_id,
        workspace_path: request.workspace_path,
        session_id: request.session_id,
        include_internal: request.include_internal,
        remote_connection_id: request.remote_connection_id,
        remote_ssh_host: request.remote_ssh_host,
    }
}

pub(super) fn restore_session_response(
    result: AgentSessionRestoreResult,
) -> RestoreSessionResponse {
    RestoreSessionResponse {
        session: result.session,
        state: session_state(result.state),
    }
}

pub(super) fn session_state(value: SessionState) -> SessionRuntimeState {
    match value {
        SessionState::Idle => SessionRuntimeState::Idle,
        SessionState::Processing {
            current_turn_id,
            phase,
        } => SessionRuntimeState::Processing {
            current_turn_id,
            phase: session_processing_phase(phase),
        },
        SessionState::Error { error, recoverable } => {
            SessionRuntimeState::Error { error, recoverable }
        }
    }
}

fn session_processing_phase(value: ProcessingPhase) -> SessionProcessingPhase {
    match value {
        ProcessingPhase::Starting => SessionProcessingPhase::Starting,
        ProcessingPhase::Compacting => SessionProcessingPhase::Compacting,
        ProcessingPhase::Thinking => SessionProcessingPhase::Thinking,
        ProcessingPhase::Streaming => SessionProcessingPhase::Streaming,
        ProcessingPhase::ToolCalling => SessionProcessingPhase::ToolCalling,
        ProcessingPhase::ToolConfirming => SessionProcessingPhase::ToolConfirming,
    }
}

pub(super) fn agent_profile_view(
    value: openbitfun_core::service::config::AgentProfileView,
) -> AgentProfileView {
    AgentProfileView {
        profile_id: value.profile_id,
        enabled_tools: value.enabled_tools,
        default_tools: value.default_tools,
        disabled_user_skills: value.disabled_user_skills,
        enabled_user_skills: value.enabled_user_skills,
    }
}

pub(super) fn model_config(
    value: openbitfun_core::service::config::AIModelConfig,
) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(value)
}

pub(super) fn git_status(value: openbitfun_core::service::git::GitStatus) -> GitStatus {
    GitStatus {
        staged: value.staged.into_iter().map(git_file_status).collect(),
        unstaged: value.unstaged.into_iter().map(git_file_status).collect(),
        untracked: value.untracked,
        conflicts: value.conflicts,
        current_branch: value.current_branch,
        ahead: value.ahead,
        behind: value.behind,
    }
}

pub(super) fn git_trust_report(
    value: openbitfun_core::service::git::GitTrustReport,
) -> GitTrustReport {
    GitTrustReport {
        state: git_trust_state(value.state),
        repository_path: value.repository_path,
        detail: value.detail,
        manual_command: value.manual_command,
    }
}

fn git_trust_state(value: openbitfun_core::service::git::GitTrustState) -> GitTrustState {
    match value {
        openbitfun_core::service::git::GitTrustState::Trusted => GitTrustState::Trusted,
        openbitfun_core::service::git::GitTrustState::TrustRequired => GitTrustState::TrustRequired,
        openbitfun_core::service::git::GitTrustState::NotARepository => {
            GitTrustState::NotARepository
        }
    }
}

fn git_file_status(value: openbitfun_core::service::git::GitFileStatus) -> GitFileStatus {
    GitFileStatus {
        path: value.path,
        status: value.status,
        index_status: value.index_status,
        workdir_status: value.workdir_status,
    }
}

pub(super) fn git_branch(value: openbitfun_core::service::git::GitBranch) -> GitBranch {
    GitBranch {
        name: value.name,
        current: value.current,
        remote: value.remote,
        upstream: value.upstream,
        ahead: value.ahead,
        behind: value.behind,
        last_commit: value.last_commit,
        last_commit_date: value.last_commit_date,
        base_branch: value.base_branch,
        child_branches: value.child_branches,
        merged_branches: value.merged_branches,
        branch_type: value.branch_type,
        has_conflicts: value.has_conflicts,
        can_merge: value.can_merge,
        is_stale: value.is_stale,
        merge_status: value.merge_status,
        stats: value.stats.map(|stats| GitBranchStats {
            commit_count: stats.commit_count,
            contributor_count: stats.contributor_count,
            file_changes: stats.file_changes,
            lines_changed: GitLinesChanged {
                additions: stats.lines_changed.additions,
                deletions: stats.lines_changed.deletions,
            },
            activity_score: stats.activity_score,
        }),
        created_at: value.created_at,
        last_activity_at: value.last_activity_at,
        tags: value.tags,
        description: value.description,
        linked_issues: value.linked_issues,
    }
}

pub(super) fn config_update(
    value: openbitfun_core::service::config::ConfigUpdateEvent,
) -> ConfigUpdate {
    use openbitfun_core::service::config::ConfigUpdateEvent;

    match value {
        ConfigUpdateEvent::ModelConfigurationUpdated => ConfigUpdate::ModelConfigurationUpdated,
        ConfigUpdateEvent::AIModelUpdated {
            model_id,
            model_name,
        } => ConfigUpdate::AiModelUpdated {
            model_id,
            model_name,
        },
        ConfigUpdateEvent::DefaultAIModelUpdated {
            model_id,
            model_name,
        } => ConfigUpdate::DefaultAiModelUpdated {
            model_id,
            model_name,
        },
        ConfigUpdateEvent::AppearanceUpdated { appearance_id } => {
            ConfigUpdate::AppearanceUpdated { appearance_id }
        }
        ConfigUpdateEvent::EditorUpdated => ConfigUpdate::EditorUpdated,
        ConfigUpdateEvent::TerminalUpdated => ConfigUpdate::TerminalUpdated,
        ConfigUpdateEvent::WorkspaceUpdated => ConfigUpdate::WorkspaceUpdated,
        ConfigUpdateEvent::AppUpdated => ConfigUpdate::AppUpdated,
        ConfigUpdateEvent::ConfigReloaded => ConfigUpdate::ConfigReloaded,
        ConfigUpdateEvent::ReasoningCatalogUpdated => ConfigUpdate::ReasoningCatalogUpdated,
        ConfigUpdateEvent::LogLevelUpdated { new_level } => {
            ConfigUpdate::LogLevelUpdated { new_level }
        }
        ConfigUpdateEvent::LoggingSensitiveDiagnosticsUpdated {
            include_sensitive_diagnostics,
        } => ConfigUpdate::LoggingSensitiveDiagnosticsUpdated {
            include_sensitive_diagnostics,
        },
        ConfigUpdateEvent::ModelsReconciled {
            invalidated_model_ids,
            default_models_changed,
            task_models_changed,
            agent_model_defaults_changed,
        } => ConfigUpdate::ModelsReconciled {
            invalidated_model_ids,
            default_models_changed,
            task_models_changed,
            agent_model_defaults_changed,
        },
    }
}

#[cfg(test)]
mod tests {
    use openbitfun_app_server_protocol::agent::SubmitDialogTurnBody;
    use openbitfun_app_server_protocol::session::{SessionProcessingPhase, SessionRuntimeState};
    use openbitfun_runtime_ports::{AgentDialogTurnExecution, AgentSubmissionSource};

    #[test]
    fn missing_dialog_policy_defaults_only_at_the_server_boundary() {
        let request = super::submit_dialog_turn_request(SubmitDialogTurnBody {
            session_id: "session-1".to_string(),
            message: "hello".to_string(),
            original_message: None,
            turn_id: None,
            execution: AgentDialogTurnExecution::Standard,
            agent_type: "general".to_string(),
            workspace_id: None,
            workspace_path: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            policy: None,
            attachments: Vec::new(),
            metadata: serde_json::Map::new(),
        });

        assert_eq!(
            request.policy.trigger_source,
            AgentSubmissionSource::DesktopUi
        );
        assert!(request.reply_route.is_none());
        assert!(request.prepended_reminders.is_empty());
    }

    #[test]
    fn runtime_session_state_maps_without_changing_wire_phase_names() {
        let state = super::session_state(
            openbitfun_agent_runtime::session_state::SessionState::Processing {
                current_turn_id: "turn-1".to_string(),
                phase: openbitfun_agent_runtime::session_state::ProcessingPhase::ToolCalling,
            },
        );

        assert!(matches!(
            state,
            SessionRuntimeState::Processing {
                phase: SessionProcessingPhase::ToolCalling,
                ..
            }
        ));
    }

    #[test]
    fn legacy_model_config_wire_document_is_the_owner_serialization() {
        let owner = openbitfun_core::service::config::AIModelConfig::default();
        let expected = serde_json::to_value(&owner).expect("owner config should serialize");

        assert_eq!(
            super::model_config(owner).expect("wire projection should serialize"),
            expected
        );
    }

    #[test]
    fn legacy_git_wire_projections_preserve_owner_json() {
        let status_json = serde_json::json!({
            "staged": [{
                "path": "src/main.rs",
                "status": "modified",
                "index_status": "M",
                "workdir_status": null
            }],
            "unstaged": [],
            "untracked": ["notes.txt"],
            "conflicts": ["Cargo.toml"],
            "current_branch": "main",
            "ahead": 2,
            "behind": 1
        });
        let status = serde_json::from_value(status_json.clone())
            .expect("owner Git status fixture should deserialize");
        assert_eq!(
            serde_json::to_value(super::git_status(status))
                .expect("wire Git status should serialize"),
            status_json
        );

        let branch_json = serde_json::json!({
            "name": "feature/schema-owner",
            "current": true,
            "remote": false,
            "upstream": "origin/feature/schema-owner",
            "ahead": 3,
            "behind": 0,
            "last_commit": "abc123",
            "last_commit_date": "2026-08-14T00:00:00Z",
            "base_branch": "main",
            "child_branches": ["feature/child"],
            "merged_branches": [],
            "branch_type": "feature",
            "has_conflicts": false,
            "can_merge": true,
            "is_stale": false,
            "merge_status": "clean",
            "stats": {
                "commit_count": 3,
                "contributor_count": 1,
                "file_changes": 4,
                "lines_changed": { "additions": 20, "deletions": 5 },
                "activity_score": 8
            },
            "created_at": "2026-08-13T00:00:00Z",
            "last_activity_at": "2026-08-14T00:00:00Z",
            "tags": ["schema"],
            "description": "schema owner migration",
            "linked_issues": ["#123"]
        });
        let branch = serde_json::from_value(branch_json.clone())
            .expect("owner Git branch fixture should deserialize");
        assert_eq!(
            serde_json::to_value(super::git_branch(branch))
                .expect("wire Git branch should serialize"),
            branch_json
        );
    }
}
