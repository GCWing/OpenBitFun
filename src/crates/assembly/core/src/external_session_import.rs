//! Import and local continuation of external Agent sessions.

pub mod auto_discovery;
pub(crate) mod deferred;
mod lifecycle;
pub use lifecycle::{list_removed_external_sessions, restore_removed_external_session};

use openbitfun_claude_code_adapter::session::ClaudeCodeSessionReader;
use openbitfun_codex_adapter::session::CodexSessionReader;
use openbitfun_cursor_adapter::session::CursorSessionReader;
use openbitfun_dsh_adapter::session::DshSessionReader;
use openbitfun_opencode_adapter::session::OpenCodeSessionReader;
use openbitfun_pi_adapter::session::PiSessionReader;
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourceOperationErrorCode, ExternalSourceOperationResult,
};
use openbitfun_product_domains::session_import::{
    ExternalSessionCandidate, ExternalSessionDocument, ExternalSessionImportMode,
};
use openbitfun_runtime_ports::SessionStorePort;
use openbitfun_services_core::session::{
    DialogTurnData, ModelRoundData, OfflineSessionBundle, OfflineSessionImportStore,
    SessionMemoryMode, SessionMetadata, SessionStatus, TextItemData, ThinkingItemData,
    ToolCallData, ToolItemData, ToolResultData, TurnStatus, UserMessageData,
};
use openbitfun_zcode_adapter::session::ZcodeSessionReader;
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::Duration;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Instant,
};
#[cfg(test)]
use uuid::Uuid;

fn codex_reader() -> &'static CodexSessionReader {
    static READER: LazyLock<CodexSessionReader> = LazyLock::new(CodexSessionReader::default);
    &READER
}

#[derive(Clone, Copy)]
enum ImportSource {
    Codex,
    Cursor,
    Zcode,
    ClaudeCode,
    OpenCode,
    Pi,
    Dsh,
}

impl ImportSource {
    fn from_ecosystem(id: &str) -> ExternalSourceOperationResult<Self> {
        match id {
            "codex" => Ok(Self::Codex),
            "cursor" => Ok(Self::Cursor),
            "zcode" => Ok(Self::Zcode),
            "claude-code" => Ok(Self::ClaudeCode),
            "opencode" => Ok(Self::OpenCode),
            "pi" => Ok(Self::Pi),
            "deepseek-harness" => Ok(Self::Dsh),
            _ => Err(operation(
                ExternalSourceOperationErrorCode::Unsupported,
                "This external agent does not support session import",
                false,
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Zcode => "Zcode",
            Self::ClaudeCode => "Claude Code",
            Self::OpenCode => "OpenCode",
            Self::Pi => "Pi",
            Self::Dsh => "DeepSeek Harness",
        }
    }

    fn format(self) -> &'static str {
        match self {
            Self::Codex => "codex-rollout-jsonl",
            Self::Cursor => "cursor-session-history",
            Self::Zcode => "zcode-session-sqlite",
            Self::ClaudeCode => "claude-code-transcript-jsonl",
            Self::OpenCode => "opencode-session-sqlite",
            Self::Pi => "pi-session-jsonl",
            Self::Dsh => "dsh-session-jsonl",
        }
    }

    fn revision(self) -> &'static str {
        match self {
            Self::Codex => openbitfun_codex_adapter::session::SOURCE_REVISION,
            Self::Cursor => openbitfun_cursor_adapter::session::SOURCE_REVISION,
            Self::Zcode => openbitfun_zcode_adapter::session::SOURCE_REVISION,
            Self::ClaudeCode => openbitfun_claude_code_adapter::session::SOURCE_REVISION,
            Self::OpenCode => openbitfun_opencode_adapter::session::SOURCE_REVISION,
            Self::Pi => openbitfun_pi_adapter::session::SOURCE_REVISION,
            Self::Dsh => openbitfun_dsh_adapter::session::SOURCE_REVISION,
        }
    }

    fn read(self, candidate: &str) -> Result<ExternalSessionDocument, String> {
        match self {
            Self::Codex => {
                codex_reader().read_candidate(candidate, ExternalSessionImportMode::Full)
            }
            Self::Zcode => ZcodeSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
            Self::Cursor => CursorSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
            Self::ClaudeCode => ClaudeCodeSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
            Self::OpenCode => OpenCodeSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
            Self::Pi => PiSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
            Self::Dsh => DshSessionReader::default()
                .read_candidate(candidate, ExternalSessionImportMode::Full),
        }
    }

    fn discover_all(
        self,
    ) -> Result<openbitfun_product_domains::session_import::ExternalSessionCatalog, String> {
        match self {
            Self::Codex => codex_reader().discover_all(),
            Self::Cursor => CursorSessionReader::default().discover_all(),
            Self::Zcode => ZcodeSessionReader::default().discover_all(),
            Self::ClaudeCode => ClaudeCodeSessionReader::default().discover_all(),
            Self::OpenCode => OpenCodeSessionReader::default().discover_all(),
            Self::Pi => PiSessionReader::default().discover_all(),
            Self::Dsh => DshSessionReader::default().discover_all(),
        }
    }
}

async fn import_storage(
    workspace: &crate::service::workspace::WorkspaceInfo,
) -> ExternalSourceOperationResult<(
    OfflineSessionImportStore,
    crate::service::workspace::WorkspaceInfo,
)> {
    let resolution = crate::agentic::session::CoreSessionStorePort::default()
        .resolve_workspace_storage(&workspace.id)
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Unavailable,
                error.to_string(),
                true,
            )
        })?;
    let project_id = workspace.project_workspace_id().map_err(|error| {
        operation(
            ExternalSourceOperationErrorCode::InvalidRequest,
            error,
            false,
        )
    })?;
    let project = if project_id == workspace.id {
        workspace.clone()
    } else {
        let service =
            crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
                operation(
                    ExternalSourceOperationErrorCode::Unavailable,
                    "Workspace service is unavailable",
                    true,
                )
            })?;
        service
            .require_workspace(project_id)
            .await
            .map_err(|error| {
                operation(
                    ExternalSourceOperationErrorCode::Unavailable,
                    error.to_string(),
                    true,
                )
            })?
    };
    Ok((
        OfflineSessionImportStore::new(resolution.effective_storage_path),
        project,
    ))
}

fn matching_workspace<'a>(
    workspaces: &'a [crate::service::workspace::WorkspaceInfo],
    source: &Path,
) -> Option<&'a crate::service::workspace::WorkspaceInfo> {
    let source = normalized_path(source);
    workspaces
        .iter()
        .filter(|workspace| {
            workspace.workspace_kind != crate::service::workspace::WorkspaceKind::Remote
        })
        .filter_map(|workspace| {
            let root = normalized_path(&workspace.root_path);
            let matches = source == root || source.starts_with(&(root.clone() + "/"));
            matches.then_some((root.len(), workspace))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, workspace)| workspace)
}

fn normalized_path(path: &Path) -> String {
    let path = dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        path.to_ascii_lowercase()
    } else {
        path
    }
}

fn convert_document(
    session_id: &str,
    workspace: &crate::service::workspace::WorkspaceInfo,
    project: &crate::service::workspace::WorkspaceInfo,
    agent_id: &str,
    session_name: &str,
    document: &ExternalSessionDocument,
    include_tool_history: bool,
    include_thinking: bool,
) -> ExternalSourceOperationResult<OfflineSessionBundle> {
    let mut metadata = document_metadata(
        session_id,
        workspace,
        project,
        agent_id,
        session_name,
        document,
    )?;
    let turns = convert_document_turns(
        session_id,
        agent_id,
        document,
        include_tool_history,
        include_thinking,
    );
    finish_document_metadata(&mut metadata, &turns);
    Ok(OfflineSessionBundle { metadata, turns })
}

fn document_metadata(
    session_id: &str,
    workspace: &crate::service::workspace::WorkspaceInfo,
    project: &crate::service::workspace::WorkspaceInfo,
    agent_id: &str,
    session_name: &str,
    document: &ExternalSessionDocument,
) -> ExternalSourceOperationResult<SessionMetadata> {
    // The source model is retained on the imported rounds and provenance
    // metadata, while continuation uses the target host's configured primary
    // model instead of assuming the source model exists locally.
    let model_name = "primary".to_string();
    let mut metadata = SessionMetadata::new(
        session_id.to_string(),
        session_name.to_string(),
        agent_id.to_string(),
        model_name,
    );
    metadata.workspace_id = Some(workspace.id.clone());
    metadata.workspace_path = Some(workspace.root_path.to_string_lossy().to_string());
    metadata.project_workspace_id = Some(project.id.clone());
    metadata.project_workspace_path = Some(project.root_path.to_string_lossy().to_string());
    metadata.memory_mode = SessionMemoryMode::Disabled;
    metadata.status = SessionStatus::Completed;
    let source = ImportSource::from_ecosystem(&document.candidate.ecosystem_id)?;
    metadata.custom_metadata = Some(json!({
        "importedFrom": document.candidate.ecosystem_id,
        "sourceSessionId": document.candidate.source_session_id,
        "sourceSessionTitle": document.candidate.title,
        "sourceFingerprint": document.candidate.fingerprint,
        "sourceFormat": source.format(),
        "sourceRevision": source.revision(),
        "importWarningCodes": document.warnings.iter().map(|warning| &warning.code).collect::<Vec<_>>(),
        "sourceCwd": document.candidate.cwd,
        "sourceModelProvider": document.candidate.model_provider,
        "sourceModel": document.candidate.model_name,
        "continuationMode": "openbitfun_local"
    }));
    Ok(metadata)
}

fn convert_document_turns(
    session_id: &str,
    agent_id: &str,
    document: &ExternalSessionDocument,
    include_tool_history: bool,
    include_thinking: bool,
) -> Vec<DialogTurnData> {
    let mut turns = Vec::with_capacity(document.turns.len());
    for (turn_index, source) in document.turns.iter().enumerate() {
        let turn_id = format!("{session_id}-turn-{turn_index}");
        let timestamp = if source.timestamp == 0 {
            current_time_ms()
        } else {
            source.timestamp
        };
        let mut turn = DialogTurnData::new_with_kind(
            openbitfun_services_core::session::DialogTurnKind::UserDialog,
            turn_id.clone(),
            turn_index,
            session_id.to_string(),
            Some(agent_id.to_string()),
            UserMessageData {
                id: format!("{turn_id}-user"),
                content: source.user_text.clone(),
                timestamp,
                metadata: Some(
                    json!({"importedFrom":document.candidate.ecosystem_id,"sourceTurnId":source.source_turn_id}),
                ),
            },
        );
        turn.timestamp = timestamp;
        turn.start_time = timestamp;
        let mut round = ModelRoundData {
            id: format!("{turn_id}-round-0"),
            turn_id: turn_id.clone(),
            round_index: 0,
            round_group_id: None,
            timestamp,
            text_items: Vec::new(),
            tool_items: Vec::new(),
            thinking_items: Vec::new(),
            start_time: timestamp,
            end_time: Some(timestamp),
            duration_ms: Some(0),
            provider_id: document.candidate.model_provider.clone(),
            model_config_id: None,
            effective_model_name: document.candidate.model_name.clone(),
            routing: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            ttft_ms: None,
            attempt_count: None,
            attempt_diagnostics: Vec::new(),
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        };
        let mut order = 0usize;
        for item in &source.items {
            match item {
                openbitfun_product_domains::session_import::ExternalSessionItem::Text { text } => {
                    round.text_items.push(TextItemData {
                        id: format!("{turn_id}-text-{order}"),
                        content: text.clone(),
                        is_streaming: false,
                        timestamp,
                        is_markdown: true,
                        order_index: Some(order),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        status: Some("completed".to_string()),
                        attempt_id: None,
                        attempt_index: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Thinking {
                    text,
                } if include_thinking => {
                    round.thinking_items.push(ThinkingItemData {
                        id: format!("{turn_id}-thinking-{order}"),
                        content: text.clone(),
                        reasoning_kind: None,
                        is_streaming: false,
                        is_collapsed: true,
                        timestamp,
                        order_index: Some(order),
                        status: Some("completed".to_string()),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        attempt_id: None,
                        attempt_index: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Thinking {
                    ..
                } => {}
                openbitfun_product_domains::session_import::ExternalSessionItem::Tool {
                    id,
                    name,
                    input,
                    result,
                    success,
                } if include_tool_history => {
                    round.tool_items.push(ToolItemData {
                        id: format!("{turn_id}-tool-{order}"),
                        tool_name: name.clone(),
                        tool_call: ToolCallData {
                            input: input.clone(),
                            id: id.clone(),
                        },
                        tool_result: result.clone().map(|result| ToolResultData {
                            result,
                            success: success.unwrap_or(true),
                            result_for_assistant: None,
                            image_attachments: None,
                            error: None,
                            duration_ms: None,
                        }),
                        ai_intent: None,
                        start_time: timestamp,
                        end_time: Some(timestamp),
                        duration_ms: Some(0),
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                        order_index: Some(order),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        subagent_dialog_turn_id: None,
                        attempt_id: None,
                        attempt_index: None,
                        subagent_model_id: None,
                        subagent_model_display_name: None,
                        status: Some(
                            match success {
                                Some(true) => "completed",
                                Some(false) => "error",
                                None => "cancelled",
                            }
                            .to_string(),
                        ),
                        interruption_reason: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Tool {
                    ..
                } => {}
            }
            order += 1;
        }
        turn.model_rounds.push(round);
        turn.end_time = Some(timestamp);
        turn.duration_ms = Some(0);
        turn.has_final_response = Some(source.items.iter().any(|item| {
            matches!(
                item,
                openbitfun_product_domains::session_import::ExternalSessionItem::Text { .. }
            )
        }));
        turn.status = match source.status {
            openbitfun_product_domains::session_import::ExternalSessionStatus::Interrupted => {
                TurnStatus::Cancelled
            }
            openbitfun_product_domains::session_import::ExternalSessionStatus::Corrupt => {
                TurnStatus::Error
            }
            _ => TurnStatus::Completed,
        };
        turns.push(turn);
    }
    turns
}

fn finish_document_metadata(metadata: &mut SessionMetadata, turns: &[DialogTurnData]) {
    metadata.turn_count = turns.len();
    metadata.message_count = turns.len()
        + turns
            .iter()
            .map(|turn| {
                turn.model_rounds
                    .iter()
                    .map(|round| round.text_items.len())
                    .sum::<usize>()
            })
            .sum::<usize>();
    metadata.tool_call_count = turns.iter().map(DialogTurnData::count_tool_calls).sum();
    metadata.last_active_at = turns
        .last()
        .and_then(|turn| turn.end_time)
        .unwrap_or_else(current_time_ms);
    metadata.last_finished_at = Some(metadata.last_active_at);
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn operation(
    code: ExternalSourceOperationErrorCode,
    detail: impl Into<String>,
    retryable: bool,
) -> ExternalSourceOperationError {
    ExternalSourceOperationError::new(code, detail, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::workspace::{WorkspaceInfo, WorkspaceKind};

    #[test]
    fn source_selection_never_falls_back_to_codex_for_an_unknown_ecosystem() {
        assert!(matches!(
            ImportSource::from_ecosystem("codex").unwrap(),
            ImportSource::Codex
        ));
        assert!(matches!(
            ImportSource::from_ecosystem("zcode").unwrap(),
            ImportSource::Zcode
        ));
        assert!(ImportSource::from_ecosystem("unregistered").is_err());
        assert!(ImportSource::from_ecosystem("").is_err());
    }

    #[tokio::test]
    async fn zcode_history_round_trips_through_native_storage_with_its_own_provenance() {
        use openbitfun_product_domains::session_import::{
            ExternalSessionItem, ExternalSessionStatus, ExternalSessionTurn,
        };
        let root = tempfile::tempdir().unwrap();
        let workspace = workspace("source", root.path(), WorkspaceKind::Normal);
        let document = ExternalSessionDocument {
            candidate: serde_json::from_value(json!({
                "candidateId":"zcode:source", "ecosystemId":"zcode", "sourceSessionId":"source",
                "fileSizeBytes":42, "status":"interrupted", "fingerprint":"sha256:fixture",
                "modelName":"glm-source", "modelProvider":"zcode-source"
            }))
            .unwrap(),
            turns: vec![ExternalSessionTurn {
                source_turn_id: "source-user".into(),
                timestamp: 1000,
                user_text: "Continue this task".into(),
                items: vec![
                    ExternalSessionItem::Text {
                        text: "A saved answer".into(),
                    },
                    ExternalSessionItem::Tool {
                        id: "failed".into(),
                        name: "Read".into(),
                        input: json!({"path":"missing"}),
                        result: Some(json!("Not found")),
                        success: Some(false),
                    },
                    ExternalSessionItem::Tool {
                        id: "pending".into(),
                        name: "Bash".into(),
                        input: json!({"command":"pending"}),
                        result: None,
                        success: None,
                    },
                ],
                source_event_count: 4,
                status: ExternalSessionStatus::Interrupted,
            }],
            warnings: Vec::new(),
        };
        let bundle = convert_document(
            "zcode-import-fixture",
            &workspace,
            &workspace,
            "primary",
            "Imported task",
            &document,
            true,
            false,
        )
        .unwrap();
        let store = OfflineSessionImportStore::new(root.path().join("native-sessions"));
        store.write_bundle_atomic(&bundle).await.unwrap();
        let saved = store
            .load_bundle("zcode-import-fixture")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.metadata.custom_metadata.as_ref().unwrap()["importedFrom"],
            "zcode"
        );
        assert_eq!(
            saved.metadata.custom_metadata.as_ref().unwrap()["sourceFormat"],
            "zcode-session-sqlite"
        );
        assert_eq!(
            saved.turns[0].user_message.metadata.as_ref().unwrap()["importedFrom"],
            "zcode"
        );
        assert_eq!(saved.turns[0].user_message.content, "Continue this task");
        assert_eq!(
            saved.turns[0].model_rounds[0]
                .effective_model_name
                .as_deref(),
            Some("glm-source")
        );
        assert_eq!(
            saved.turns[0].model_rounds[0].tool_items[0]
                .tool_result
                .as_ref()
                .unwrap()
                .success,
            false
        );
        assert_eq!(
            saved.turns[0].model_rounds[0].tool_items[1]
                .status
                .as_deref(),
            Some("cancelled")
        );
    }

    #[tokio::test]
    #[ignore = "Reads installed Zcode history and writes only to a temporary native store"]
    async fn inspect_installed_zcode_native_import() {
        let reader = ZcodeSessionReader::default();
        let catalog = reader.discover(0, 5, "").unwrap();
        assert!(
            !catalog.candidates.is_empty(),
            "No installed Zcode sessions found"
        );
        let root = tempfile::tempdir().unwrap();
        let store = OfflineSessionImportStore::new(root.path().join("sessions"));
        for candidate in catalog.candidates {
            let document = reader
                .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
                .unwrap();
            let workspace = workspace("fixture-workspace", root.path(), WorkspaceKind::Normal);
            let id = format!("zcode-import-{}", Uuid::new_v4());
            let bundle = convert_document(
                &id,
                &workspace,
                &workspace,
                "primary",
                "Zcode verification",
                &document,
                true,
                false,
            )
            .unwrap();
            store.write_bundle_atomic(&bundle).await.unwrap();
            let saved = store.load_bundle(&id).await.unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(&saved.turns).unwrap(),
                serde_json::to_value(&bundle.turns).unwrap()
            );
            assert_eq!(saved.metadata.turn_count, document.turns.len());
            assert_eq!(
                saved.metadata.custom_metadata.as_ref().unwrap()["importedFrom"],
                "zcode"
            );
            println!(
                "Zcode native storage round trip: {} turns, {} tools",
                saved.turns.len(),
                saved.metadata.tool_call_count
            );
        }
    }

    fn workspace(id: &str, root: &Path, kind: WorkspaceKind) -> WorkspaceInfo {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "rootPath": root,
            "workspaceType": "Other",
            "workspaceKind": kind,
            "status": "Inactive",
            "languages": [],
            "openedAt": "2026-01-01T00:00:00Z",
            "lastAccessed": "2026-01-01T00:00:00Z",
            "tags": [],
            "metadata": {}
        }))
        .unwrap()
    }

    #[test]
    fn source_directory_selects_the_nearest_registered_workspace() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let nested = project.join("nested");
        let source = nested.join("src");
        std::fs::create_dir_all(&source).unwrap();
        let workspaces = vec![
            workspace(
                "unrelated",
                &root.path().join("other"),
                WorkspaceKind::Normal,
            ),
            workspace("project", &project, WorkspaceKind::Normal),
            workspace("nested", &nested, WorkspaceKind::Normal),
        ];

        assert_eq!(
            matching_workspace(&workspaces, &source).unwrap().id,
            "nested"
        );
    }

    #[test]
    fn similarly_named_directory_does_not_reuse_an_unrelated_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspaces = vec![workspace(
            "project",
            &root.path().join("project"),
            WorkspaceKind::Normal,
        )];

        assert!(matching_workspace(&workspaces, &root.path().join("project-other")).is_none());
    }

    #[test]
    fn remote_workspace_path_never_claims_a_local_codex_session() {
        let root = tempfile::tempdir().unwrap();
        let workspaces = vec![workspace("remote", root.path(), WorkspaceKind::Remote)];

        assert!(matching_workspace(&workspaces, root.path()).is_none());
    }

    #[test]
    fn imported_worktree_session_preserves_execution_and_project_ownership() {
        let root = tempfile::tempdir().unwrap();
        let project = workspace(
            "project",
            &root.path().join("project"),
            WorkspaceKind::Normal,
        );
        let execution = workspace(
            "worktree",
            &root.path().join("worktree"),
            WorkspaceKind::Normal,
        );
        let document = ExternalSessionDocument {
            candidate: serde_json::from_value(json!({
                "candidateId": "source", "ecosystemId": "codex", "sourceSessionId": "source",
                "fileSizeBytes": 1, "status": "complete", "fingerprint": "test"
            }))
            .unwrap(),
            turns: Vec::new(),
            warnings: Vec::new(),
        };

        let bundle = convert_document(
            "imported", &execution, &project, "primary", "Imported", &document, true, false,
        )
        .unwrap();

        assert_eq!(bundle.metadata.workspace_id.as_deref(), Some("worktree"));
        assert_eq!(
            bundle.metadata.project_workspace_id.as_deref(),
            Some("project")
        );
        assert_eq!(
            bundle.metadata.workspace_path,
            Some(execution.root_path.to_string_lossy().into_owned())
        );
        assert_eq!(
            bundle.metadata.project_workspace_path,
            Some(project.root_path.to_string_lossy().into_owned())
        );
    }
}
