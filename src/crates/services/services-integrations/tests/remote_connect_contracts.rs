#![cfg(feature = "remote-connect")]

use openbitfun_core_types::{
    ModelsDevCatalogSource, ModelsDevReasoningCatalog, ModelsDevReasoningModel,
    ModelsDevReasoningProvider, ReasoningCapabilityStatus, ReasoningCatalogProjection,
    ReasoningPresetAction, ReasoningPresetDescriptor, ReasoningPresetSource,
};
use openbitfun_events::{AgenticEvent, ToolEventData};
use openbitfun_runtime_ports::{
    AgentSubmissionSource, RemoteControlSessionState, RemoteControlStateSnapshot,
};
use openbitfun_services_integrations::remote_connect::{
    agent_input_attachment_from_remote_image_context, build_lan_relay_url_with_ip,
    build_remote_chat_messages, build_remote_image_attachment, build_remote_image_contexts,
    build_remote_image_submission_request, build_remote_model_catalog,
    build_remote_session_create_request, build_remote_submission_request, cancel_remote_task,
    handle_remote_command, handle_remote_workspace_file_command, make_slim_tool_params,
    no_host_image_pixels, normalize_remote_model_selection, normalize_remote_session_model_id,
    project_remote_chat_user,
    project_remote_plan_tool, read_remote_workspace_file, read_remote_workspace_file_chunk,
    read_remote_workspace_file_info, remote_answer_question_response,
    remote_assistant_list_response, remote_assistant_updated_response,
    remote_dialog_steer_response, remote_dialog_submit_outcome_from_scheduler,
    remote_dialog_submit_response, remote_file_chunk_response, remote_file_content_response,
    remote_file_display_name, remote_file_info_response, remote_initial_sync_response,
    remote_interaction_accepted_response, remote_messages_response,
    remote_model_catalog_poll_delta, remote_model_selection_needs_config,
    remote_no_change_poll_response, remote_persisted_poll_response, remote_plan_build_content,
    remote_recent_workspaces_response, remote_session_created_response,
    remote_session_deleted_response, remote_session_info, remote_session_list_response,
    remote_session_model_updated_response, remote_session_restore_target,
    remote_snapshot_poll_response, remote_task_cancel_response, remote_workspace_info_response,
    remote_workspace_updated_response, resolve_remote_agent_type, resolve_remote_cancel_decision,
    resolve_remote_execution_image_contexts, resolve_remote_file_chunk_range,
    resolve_remote_workspace_path, should_send_remote_model_catalog, submit_remote_dialog,
    ActiveTurnSnapshot, ChatImageAttachment, ChatMessage, ChatMessageItem, ImageAttachment,
    QrGenerator, RemoteAssistantWorkspaceFacts, RemoteCancelDecision, RemoteCancelRuntimeHost,
    RemoteCancelTaskRequest, RemoteChatHistoryRound, RemoteChatHistoryTextItem,
    RemoteChatHistoryThinkingItem, RemoteChatHistoryToolCall, RemoteChatHistoryToolItem,
    RemoteChatHistoryTurn, RemoteCommand, RemoteCommandRuntimeHost, RemoteConnectSubmissionSource,
    RemoteDefaultModelsConfig, RemoteDialogQueuePriority, RemoteDialogResolvedSubmission,
    RemoteDialogRuntimeHost, RemoteDialogSchedulerOutcomeFact, RemoteDialogSteerOutcome,
    RemoteDialogSteerRequest, RemoteDialogSubmissionPolicy, RemoteDialogSubmissionRequest,
    RemoteDialogSubmitOutcome, RemoteDialogWorkspaceBinding, RemoteImageContext,
    RemoteImageContextAdapter, RemoteModelCapabilityFact, RemoteModelCatalog,
    RemoteModelCatalogFacts, RemoteModelConfig, RemoteModelFacts, RemoteRecentWorkspaceFacts,
    RemoteResponse, RemoteSessionMetadata, RemoteSessionModelSelection, RemoteSessionStateTracker,
    RemoteSessionTrackerHost, RemoteSessionTrackerRegistry, RemoteSessionWorkspaceIdentity,
    RemoteTerminalPrewarmRequest, RemoteToolStatus, RemoteWorkspaceFacts, RemoteWorkspaceFileChunk,
    RemoteWorkspaceFileContent, RemoteWorkspaceFileInfo, RemoteWorkspaceFileRuntimeHost,
    RemoteWorkspaceKind, RemoteWorkspaceUpdate, TrackerEvent, REMOTE_CAPABILITY_DIALOG_STEER_V1,
    REMOTE_CAPABILITY_HARNESS_PROFILES_V1, REMOTE_CAPABILITY_PLAN_BUILD_V1,
    REMOTE_FILE_MAX_CHUNK_BYTES, REMOTE_FILE_MAX_READ_BYTES,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[test]
fn relay_invitations_and_authentication_use_the_same_protocol_for_all_endpoints() {
    for endpoint in [
        "https://remote.openbitfun.com/v/1.0.1",
        "http://192.168.1.8:9700",
    ] {
        assert_eq!(
            QrGenerator::build_device_url(endpoint, "desktop-1").unwrap(),
            format!("{endpoint}/#/pair?did=desktop-1")
        );
    }
    use openbitfun_services_integrations::remote_connect::realtime_client::account_auth_payload;
    assert_eq!(
        account_auth_payload("test-token", true),
        serde_json::json!({"token":"test-token","clientType":"machine-scoped"})
    );
    assert_eq!(
        account_auth_payload("test-token", false),
        serde_json::json!({"token":"test-token","clientType":"user-scoped"})
    );
}

#[test]
fn remote_connect_lan_url_builder_lives_in_services_owner() {
    let url = build_lan_relay_url_with_ip(9700, "192.168.1.8").unwrap();

    assert_eq!(url, "http://192.168.1.8:9700");
}

#[test]
fn remote_connect_submission_contract_preserves_relay_source_and_turn_id() {
    let request = build_remote_submission_request(
        "session-1",
        "hello from phone",
        Some("turn-1".to_string()),
        RemoteConnectSubmissionSource::Relay,
    );

    assert_eq!(request.session_id, "session-1");
    assert_eq!(request.message, "hello from phone");
    assert_eq!(request.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(request.source, Some(AgentSubmissionSource::RemoteRelay));
    assert!(request.attachments.is_empty());
}

#[test]
fn remote_connect_submission_contract_preserves_bot_source() {
    let request = build_remote_submission_request(
        "session-2",
        "hello from bot",
        None,
        RemoteConnectSubmissionSource::Bot,
    );

    assert_eq!(request.source, Some(AgentSubmissionSource::Bot));
    assert!(request.turn_id.is_none());
}

#[test]
fn remote_connect_image_attachment_contract_preserves_portable_metadata() {
    let image = ImageAttachment {
        name: "clip.png".to_string(),
        data_url: "data:image/png;base64,abc".to_string(),
    };

    let attachment = build_remote_image_attachment(1, &image);
    let json = serde_json::to_value(attachment).expect("serialize image attachment");

    assert_eq!(json["kind"], "remote_image");
    assert_eq!(json["id"], "remote-image-2");
    assert_eq!(json["metadata"]["name"], "clip.png");
    assert_eq!(json["metadata"]["dataUrl"], "data:image/png;base64,abc");
}

#[test]
fn remote_connect_image_submission_request_preserves_existing_source_and_turn_shape() {
    let image = ImageAttachment {
        name: "clip.png".to_string(),
        data_url: "data:image/png;base64,abc".to_string(),
    };

    let request = build_remote_image_submission_request(
        "session-3",
        "hello with image",
        Some("turn-3".to_string()),
        RemoteConnectSubmissionSource::Relay,
        &[image],
    );

    assert_eq!(request.session_id, "session-3");
    assert_eq!(request.message, "hello with image");
    assert_eq!(request.turn_id.as_deref(), Some("turn-3"));
    assert_eq!(request.source, Some(AgentSubmissionSource::RemoteRelay));
    assert_eq!(request.attachments.len(), 1);
    assert_eq!(request.attachments[0].kind, "remote_image");
    assert_eq!(request.attachments[0].id, "remote-image-1");
    assert_eq!(
        request.attachments[0].metadata["dataUrl"],
        "data:image/png;base64,abc"
    );
}

#[test]
fn remote_connect_image_context_policy_preserves_legacy_fallback_shape() {
    let images = vec![
        ImageAttachment {
            name: "clip.png".to_string(),
            data_url: "data:image/png;base64,abc".to_string(),
        },
        ImageAttachment {
            name: "raw".to_string(),
            data_url: "not-a-data-url".to_string(),
        },
    ];

    let contexts = build_remote_image_contexts(Some(&images));

    assert_eq!(contexts.len(), 2);
    assert!(contexts[0].id.starts_with("remote_img_"));
    assert_eq!(contexts[0].image_path, None);
    assert_eq!(
        contexts[0].data_url.as_deref(),
        Some("data:image/png;base64,abc")
    );
    assert_eq!(contexts[0].mime_type, "image/png");
    assert_eq!(contexts[0].metadata.as_ref().unwrap()["name"], "clip.png");
    assert_eq!(contexts[0].metadata.as_ref().unwrap()["source"], "remote");
    assert_eq!(contexts[1].mime_type, "image/png");
}

#[test]
fn remote_connect_image_context_policy_prefers_explicit_contexts() {
    let legacy_images = vec![ImageAttachment {
        name: "legacy.png".to_string(),
        data_url: "data:image/png;base64,legacy".to_string(),
    }];
    let explicit = RemoteImageContext {
        id: "ctx-1".to_string(),
        image_path: Some("D:/workspace/project/screenshot.png".to_string()),
        data_url: None,
        mime_type: "image/png".to_string(),
        metadata: Some(serde_json::json!({ "source": "desktop" })),
    };

    let contexts = resolve_remote_execution_image_contexts(
        Some(&legacy_images),
        Some(vec![explicit.clone()]),
        build_remote_image_contexts,
    );

    assert_eq!(contexts, vec![explicit]);
}

#[derive(Debug, Clone, PartialEq)]
struct TestImageContext {
    id: String,
    image_path: Option<String>,
    data_url: Option<String>,
    mime_type: String,
    metadata: Option<serde_json::Value>,
}

impl RemoteImageContextAdapter for TestImageContext {
    fn from_remote_image_context(context: RemoteImageContext) -> Self {
        Self {
            id: context.id,
            image_path: context.image_path,
            data_url: context.data_url,
            mime_type: context.mime_type,
            metadata: context.metadata,
        }
    }
}

#[test]
fn remote_connect_image_context_adapter_owns_portable_conversion_shape() {
    let context = RemoteImageContext {
        id: "ctx-1".to_string(),
        image_path: Some("D:/workspace/project/screenshot.png".to_string()),
        data_url: Some("data:image/png;base64,abc".to_string()),
        mime_type: "image/png".to_string(),
        metadata: Some(serde_json::json!({ "source": "remote" })),
    };

    let adapted = TestImageContext::from_remote_image_context(context);

    assert_eq!(adapted.id, "ctx-1");
    assert_eq!(
        adapted.image_path.as_deref(),
        Some("D:/workspace/project/screenshot.png")
    );
    assert_eq!(
        adapted.data_url.as_deref(),
        Some("data:image/png;base64,abc")
    );
    assert_eq!(adapted.mime_type, "image/png");
    assert_eq!(adapted.metadata.as_ref().unwrap()["source"], "remote");
}

#[test]
fn remote_chat_projection_owner_extracts_images_and_display_text() {
    let metadata = serde_json::json!({
        "original_text": " original question ",
        "images": [
            {
                "name": "screenshot.png",
                "data_url": "data:image/png;base64,abcd"
            },
            {
                "name": "raw-image",
                "data_url": "not-a-data-url"
            },
            {
                "name": "dropped-on-the-desktop.png",
                "image_path": "/Users/dev/Pictures/dropped-on-the-desktop.png"
            },
            {
                "name": "",
                "ignored": true
            }
        ]
    });

    let projection =
        project_remote_chat_user(Some(&metadata), "fallback question", &no_host_image_pixels);

    assert_eq!(
        projection.images,
        vec![
            ChatImageAttachment {
                name: "screenshot.png".to_string(),
                data_url: "data:image/png;base64,abcd".to_string(),
            },
            ChatImageAttachment {
                name: "raw-image".to_string(),
                data_url: "not-a-data-url".to_string(),
            },
            // A path-only attachment keeps its place in the timeline so clients
            // can say the image did not arrive instead of showing nothing.
            ChatImageAttachment {
                name: "dropped-on-the-desktop.png".to_string(),
                data_url: String::new(),
            },
        ]
    );
    assert_eq!(projection.content, " original question ");
    assert_eq!(
        project_remote_chat_user(
            Some(&serde_json::json!({ "original_text": "  keep exact question text  " })),
            "fallback question",
            &no_host_image_pixels,
        )
        .content,
        "  keep exact question text  "
    );
    assert_eq!(
        project_remote_chat_user(
            None,
            "User uploaded a file.\nUser's question:\n  explain this  ",
            &no_host_image_pixels,
        )
        .content,
        "explain this"
    );
    assert_eq!(
        project_remote_chat_user(None, "  keep fallback spacing  ", &no_host_image_pixels).content,
        "  keep fallback spacing  "
    );
}

const TINY_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// A 1x1 PNG, small enough to travel within the mobile thumbnail budget.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0x50,
    0x0f, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xa9, 0x8c, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn remote_chat_projection_owner_recovers_pixels_behind_an_attachment_path() {
    let metadata = serde_json::json!({
        "original_text": "look at this",
        "images": [
            {
                "name": "dropped-on-the-desktop.png",
                "image_path": "/Users/dev/Pictures/dropped-on-the-desktop.png",
                "mime_type": "image/png"
            },
            {
                "name": "private-key",
                "image_path": "/Users/dev/.ssh/id_ed25519",
                "mime_type": "image/png"
            },
            {
                "name": "moved-away.png",
                "image_path": "/Users/dev/Pictures/moved-away.png",
                "mime_type": "image/png"
            }
        ]
    });

    let read_pixels = |image_path: &str| match image_path {
        "/Users/dev/Pictures/dropped-on-the-desktop.png" => Some(TINY_PNG.to_vec()),
        "/Users/dev/.ssh/id_ed25519" => Some(b"-----BEGIN OPENSSH PRIVATE KEY-----".to_vec()),
        _ => None,
    };
    let projection = project_remote_chat_user(Some(&metadata), "fallback", &read_pixels);

    assert_eq!(
        projection.images,
        vec![
            // The pixels behind the path travel, typed from the bytes rather
            // than from the recorded mime, so an old conversation shows its
            // image on a client that cannot reach this filesystem.
            ChatImageAttachment {
                name: "dropped-on-the-desktop.png".to_string(),
                data_url: format!("data:image/png;base64,{TINY_PNG_BASE64}"),
            },
            // A path aimed at something that is not an image never comes back
            // as base64, whatever the attachment claims its type is.
            ChatImageAttachment {
                name: "private-key".to_string(),
                data_url: String::new(),
            },
            // A path that no longer resolves still names the attachment.
            ChatImageAttachment {
                name: "moved-away.png".to_string(),
                data_url: String::new(),
            },
        ]
    );
}

#[test]
fn relay_records_carry_attachment_pixels_on_the_turn_record_alone() {
    let turn: openbitfun_services_core::session::DialogTurnData = serde_json::from_value(
        serde_json::json!({
            "turnId": "turn-1",
            "turnIndex": 0,
            "sessionId": "session-1",
            "timestamp": 1_700_000_000_u64,
            "startTime": 1_700_000_000_u64,
            "status": "completed",
            "userMessage": {
                "id": "message-user-1",
                "content": "look at this",
                "timestamp": 1_700_000_000_u64,
                "metadata": {
                    "original_text": "look at this",
                    "images": [
                        {"name": "dropped.png", "image_path": "/Users/dev/Pictures/dropped.png", "mime_type": "image/png"},
                        {"name": "already-inline.png", "image_path": "/Users/dev/Pictures/dropped.png", "data_url": "data:image/png;base64,recorded"}
                    ]
                }
            },
            "modelRounds": [{
                "id": "round-1",
                "turnId": "turn-1",
                "roundIndex": 0,
                "timestamp": 1_700_000_000_u64,
                "startTime": 1_700_000_000_u64,
                "status": "completed",
                "textItems": [{"id": "item-1", "roundId": "round-1", "turnId": "turn-1", "content": "on it", "timestamp": 1_700_000_000_u64, "orderIndex": 0, "status": "completed", "isStreaming": false}],
                "thinkingItems": [],
                "toolItems": []
            }]
        }),
    )
    .expect("turn fixture deserializes");

    let read_pixels = |image_path: &str| match image_path {
        "/Users/dev/Pictures/dropped.png" => Some(TINY_PNG.to_vec()),
        _ => None,
    };
    let records = openbitfun_services_integrations::remote_connect::session_records::records_from_turns(
        std::slice::from_ref(&turn),
        &read_pixels,
    )
    .expect("records build");

    let images_of = |record: &serde_json::Value| {
        record["turn"]["userMessage"]["metadata"]["images"]
            .as_array()
            .expect("attachments survive the record")
            .iter()
            .map(|image| image["data_url"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>()
    };

    // The turn record is what clients build the user message from, so the pixels
    // behind a recorded path join it there and a recorded data URL is left alone.
    let turn_record = records
        .iter()
        .find(|record| record["id"] == "turn/turn-1")
        .expect("turn record is published");
    assert_eq!(
        images_of(turn_record),
        vec![
            format!("data:image/png;base64,{TINY_PNG_BASE64}"),
            "data:image/png;base64,recorded".to_string(),
        ]
    );

    // Round and item records repeat the turn only as a parent header. Inlining
    // there would send the same image once per item, so they stay as recorded.
    for record in records.iter().filter(|record| record["id"] != "turn/turn-1") {
        assert_eq!(
            images_of(record),
            vec![String::new(), "data:image/png;base64,recorded".to_string()],
            "header of {} should not carry recovered pixels",
            record["id"]
        );
    }
}

#[test]
fn remote_image_context_to_agent_attachment_preserves_metadata_contract() {
    let attachment = agent_input_attachment_from_remote_image_context(RemoteImageContext {
        id: "remote-img-1".to_string(),
        image_path: Some("D:/workspace/image.png".to_string()),
        data_url: Some("data:image/png;base64,abc".to_string()),
        mime_type: "image/png".to_string(),
        metadata: Some(serde_json::json!({ "source": "remote" })),
    });

    assert_eq!(attachment.kind, "remote_image");
    assert_eq!(attachment.id, "remote-img-1");
    assert_eq!(
        attachment
            .metadata
            .get("imagePath")
            .and_then(|value| value.as_str()),
        Some("D:/workspace/image.png")
    );
    assert_eq!(
        attachment
            .metadata
            .get("dataUrl")
            .and_then(|value| value.as_str()),
        Some("data:image/png;base64,abc")
    );
    assert_eq!(
        attachment
            .metadata
            .get("mimeType")
            .and_then(|value| value.as_str()),
        Some("image/png")
    );
    assert_eq!(attachment.metadata["metadata"]["source"], "remote");
}

#[test]
fn remote_chat_history_assembly_preserves_message_shape_and_item_order() {
    let turn = remote_history_contract_turn(false);

    let messages = build_remote_chat_messages(vec![turn]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, "user-1");
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "original question");
    assert_eq!(messages[0].timestamp, "1");
    assert_eq!(
        messages[0].images.as_ref().unwrap()[0],
        ChatImageAttachment {
            name: "screenshot.png".to_string(),
            data_url: "data:image/png;base64,abcd".to_string(),
        }
    );

    assert_eq!(messages[1].id, "turn-1_assistant");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "visible text");
    assert_eq!(messages[1].timestamp, "1");
    assert_eq!(messages[1].thinking.as_deref(), Some("visible thought"));
    let items = messages[1].items.as_ref().expect("assistant items");
    assert_eq!(items.len(), 3);
    assert_eq!(items[0].item_type, "thinking");
    assert_eq!(items[1].item_type, "text");
    assert_eq!(items[2].item_type, "tool");
    let tool = items[2].tool.as_ref().expect("tool item");
    assert_eq!(tool.name, "AskUserQuestion");
    assert_eq!(tool.status, "running");
    assert_eq!(tool.duration_ms, Some(25));
    assert_eq!(
        tool.input_preview.as_deref(),
        Some(r#"{"question":"confirm?"}"#)
    );
    assert_eq!(tool.tool_input.as_ref().unwrap()["question"], "confirm?");
}

#[test]
fn remote_chat_history_assembly_preserves_in_progress_assistant_history() {
    let turn = remote_history_contract_turn(true);

    let messages = build_remote_chat_messages(vec![turn]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "visible text");
    assert_eq!(messages[1].status.as_deref(), Some("active"));
    assert_eq!(messages[1].tools.as_ref().unwrap()[0].status, "running");
}

#[test]
fn remote_chat_history_assembly_does_not_materialize_an_empty_assistant_shell() {
    let mut turn = remote_history_contract_turn(true);
    turn.rounds.clear();

    let messages = build_remote_chat_messages(vec![turn]);

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].turn_id.as_deref(), Some("turn-1"));
}

#[test]
fn remote_chat_history_assembly_keeps_an_error_only_assistant_message() {
    let mut turn = remote_history_contract_turn(false);
    turn.rounds.clear();
    turn.status = "failed".to_string();
    turn.error = Some("Model request failed".to_string());

    let messages = build_remote_chat_messages(vec![turn]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].status.as_deref(), Some("failed"));
    assert_eq!(messages[1].error.as_deref(), Some("Model request failed"));
}

#[test]
fn remote_chat_history_assembly_preserves_failed_turn_error() {
    let mut turn = remote_history_contract_turn(false);
    turn.status = "failed".to_string();
    turn.error = Some("Model request could not reach the configured proxy".to_string());

    let messages = build_remote_chat_messages(vec![turn]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].turn_id.as_deref(), Some("turn-1"));
    assert_eq!(messages[1].status.as_deref(), Some("failed"));
    assert_eq!(
        messages[1].error.as_deref(),
        Some("Model request could not reach the configured proxy")
    );
}

#[test]
fn remote_connect_cancel_and_restore_policy_preserve_runtime_decisions() {
    let binding = RemoteDialogWorkspaceBinding::local("D:/workspace/project");
    assert_eq!(
        remote_session_restore_target(false, Some(&binding)),
        Some(binding.clone())
    );
    assert_eq!(remote_session_restore_target(true, Some(&binding)), None);
    assert_eq!(remote_session_restore_target(false, None), None);

    assert_eq!(
        resolve_remote_cancel_decision(Some("turn-current"), Some("turn-current")),
        RemoteCancelDecision::CancelCurrent("turn-current".to_string())
    );
    assert_eq!(
        resolve_remote_cancel_decision(Some("turn-current"), None),
        RemoteCancelDecision::CancelCurrent("turn-current".to_string())
    );
    assert_eq!(
        resolve_remote_cancel_decision(Some("turn-current"), Some("turn-stale")),
        RemoteCancelDecision::StaleRequestedTurn
    );
    assert_eq!(
        resolve_remote_cancel_decision(None, Some("turn-finished")),
        RemoteCancelDecision::AlreadyFinished
    );
    assert_eq!(
        resolve_remote_cancel_decision(None, None),
        RemoteCancelDecision::NoRunningTask
    );
}

fn remote_history_contract_turn(is_in_progress: bool) -> RemoteChatHistoryTurn {
    RemoteChatHistoryTurn {
        turn_id: "turn-1".to_string(),
        user_message_id: "user-1".to_string(),
        user_display_content: "original question".to_string(),
        user_timestamp_ms: 1_000,
        user_images: vec![ChatImageAttachment {
            name: "screenshot.png".to_string(),
            data_url: "data:image/png;base64,abcd".to_string(),
        }],
        is_in_progress,
        status: if is_in_progress { "active" } else { "done" }.to_string(),
        error: None,
        start_time_ms: 1_000,
        rounds: vec![RemoteChatHistoryRound {
            start_time_ms: 1_100,
            end_time_ms: Some(1_200),
            text_items: vec![
                RemoteChatHistoryTextItem {
                    content: "hidden text".to_string(),
                    order_index: Some(1),
                    is_subagent: true,
                },
                RemoteChatHistoryTextItem {
                    content: "visible text".to_string(),
                    order_index: Some(1),
                    is_subagent: false,
                },
            ],
            thinking_items: vec![RemoteChatHistoryThinkingItem {
                content: "visible thought".to_string(),
                order_index: Some(0),
                is_subagent: false,
            }],
            tool_items: vec![RemoteChatHistoryToolItem {
                id: "tool-1".to_string(),
                name: "AskUserQuestion".to_string(),
                call: RemoteChatHistoryToolCall {
                    id: "call-1".to_string(),
                    input: serde_json::json!({ "question": "confirm?" }),
                },
                result: None,
                has_result: false,
                status: Some("running".to_string()),
                duration_ms: Some(25),
                start_ms: 1_130,
                order_index: Some(2),
                is_subagent: false,
            }],
        }],
    }
}

struct RecordingDialogHost {
    session_exists: bool,
    binding_workspace: Option<RemoteDialogWorkspaceBinding>,
    generated_turn_id: String,
    restore_error: bool,
    submit_outcome: RemoteDialogSubmitOutcome,
    events: Mutex<Vec<String>>,
    submitted: Mutex<Option<RemoteDialogResolvedSubmission<String>>>,
}

impl RecordingDialogHost {
    fn new(session_exists: bool, binding_workspace: Option<&str>) -> Self {
        Self {
            session_exists,
            binding_workspace: binding_workspace.map(RemoteDialogWorkspaceBinding::local),
            generated_turn_id: "turn-generated".to_string(),
            restore_error: false,
            submit_outcome: RemoteDialogSubmitOutcome::Started {
                session_id: "session-1".to_string(),
                turn_id: "turn-generated".to_string(),
            },
            events: Mutex::new(Vec::new()),
            submitted: Mutex::new(None),
        }
    }

    fn with_restore_error(mut self) -> Self {
        self.restore_error = true;
        self
    }

    fn with_submit_outcome(mut self, submit_outcome: RemoteDialogSubmitOutcome) -> Self {
        self.submit_outcome = submit_outcome;
        self
    }

    fn with_remote_binding(
        mut self,
        workspace_path: &str,
        remote_connection_id: &str,
        remote_ssh_host: &str,
    ) -> Self {
        self.binding_workspace = Some(RemoteDialogWorkspaceBinding {
            workspace_path: workspace_path.to_string(),
            remote_connection_id: Some(remote_connection_id.to_string()),
            remote_ssh_host: Some(remote_ssh_host.to_string()),
        });
        self
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn submitted(&self) -> RemoteDialogResolvedSubmission<String> {
        self.submitted
            .lock()
            .unwrap()
            .clone()
            .expect("dialog submitted")
    }
}

#[async_trait::async_trait]
impl RemoteDialogRuntimeHost for RecordingDialogHost {
    type ImageContext = String;

    fn ensure_tracker(&self, session_id: &str) {
        self.events
            .lock()
            .unwrap()
            .push(format!("ensure_tracker:{session_id}"));
    }

    async fn resolve_binding_workspace(
        &self,
        session_id: &str,
    ) -> Option<RemoteDialogWorkspaceBinding> {
        self.events
            .lock()
            .unwrap()
            .push(format!("resolve_workspace:{session_id}"));
        self.binding_workspace.clone()
    }

    async fn remote_session_exists(&self, session_id: &str) -> Result<bool, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("session_exists:{session_id}"));
        Ok(self.session_exists)
    }

    async fn restore_remote_session(
        &self,
        session_id: &str,
        workspace: RemoteDialogWorkspaceBinding,
    ) -> Result<(), String> {
        self.events.lock().unwrap().push(format!(
            "restore:{}:{}:{}:{}",
            session_id,
            workspace.workspace_path,
            workspace
                .remote_connection_id
                .as_deref()
                .unwrap_or("<none>"),
            workspace.remote_ssh_host.as_deref().unwrap_or("<none>")
        ));
        if self.restore_error {
            Err("restore failed".to_string())
        } else {
            Ok(())
        }
    }

    fn prewarm_remote_terminal(&self, request: RemoteTerminalPrewarmRequest) {
        self.events.lock().unwrap().push(format!(
            "prewarm:{}:{}",
            request.session_id,
            request.binding_workspace.as_deref().unwrap_or("<none>")
        ));
    }

    fn generate_turn_id(&self) -> String {
        self.events
            .lock()
            .unwrap()
            .push("generate_turn".to_string());
        self.generated_turn_id.clone()
    }

    async fn submit_dialog(
        &self,
        submission: RemoteDialogResolvedSubmission<Self::ImageContext>,
    ) -> Result<RemoteDialogSubmitOutcome, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("submit:{}", submission.session_id));
        *self.submitted.lock().unwrap() = Some(submission);
        Ok(self.submit_outcome.clone())
    }
}

struct RecordingCancelHost {
    initial_state: Mutex<Option<RemoteControlStateSnapshot>>,
    restored_state: Mutex<Option<RemoteControlStateSnapshot>>,
    state_reads: Mutex<usize>,
    restore_workspace: Option<String>,
    restore_error: bool,
    cancel_error: Option<String>,
    events: Mutex<Vec<String>>,
}

impl RecordingCancelHost {
    fn new(
        initial_state: Option<RemoteControlStateSnapshot>,
        restored_state: Option<RemoteControlStateSnapshot>,
        restore_workspace: Option<&str>,
    ) -> Self {
        Self {
            initial_state: Mutex::new(initial_state),
            restored_state: Mutex::new(restored_state),
            state_reads: Mutex::new(0),
            restore_workspace: restore_workspace.map(ToOwned::to_owned),
            restore_error: false,
            cancel_error: None,
            events: Mutex::new(Vec::new()),
        }
    }

    fn with_restore_error(mut self) -> Self {
        self.restore_error = true;
        self
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

fn remote_state(
    session_id: &str,
    state: RemoteControlSessionState,
    active_turn_id: Option<&str>,
) -> RemoteControlStateSnapshot {
    RemoteControlStateSnapshot {
        session_id: session_id.to_string(),
        state,
        active_turn_id: active_turn_id.map(ToOwned::to_owned),
        queue_depth: 0,
        metadata: serde_json::Map::new(),
    }
}

#[async_trait::async_trait]
impl RemoteCancelRuntimeHost for RecordingCancelHost {
    async fn resolve_session_storage_dir(&self, session_id: &str) -> Option<String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("resolve_workspace:{session_id}"));
        self.restore_workspace.clone()
    }

    async fn remote_control_state(
        &self,
        session_id: &str,
    ) -> Result<Option<RemoteControlStateSnapshot>, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("read_state:{session_id}"));
        let mut reads = self.state_reads.lock().unwrap();
        let read_index = *reads;
        *reads += 1;
        drop(reads);

        if read_index == 0 {
            return Ok(self.initial_state.lock().unwrap().clone());
        }
        Ok(self.restored_state.lock().unwrap().clone())
    }

    async fn restore_remote_session(
        &self,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("restore:{session_id}:{workspace_path}"));
        if self.restore_error {
            Err("restore failed".to_string())
        } else {
            Ok(())
        }
    }

    async fn cancel_remote_turn(&self, session_id: &str, turn_id: &str) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("cancel:{session_id}:{turn_id}"));
        if let Some(error) = &self.cancel_error {
            Err(error.clone())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct RecordingCommandHost {
    events: Mutex<Vec<String>>,
    submitted_dialog: Mutex<Option<RemoteDialogSubmissionRequest<String>>>,
    steered_dialog: Mutex<Option<RemoteDialogSteerRequest<String>>>,
    cancel_request: Mutex<Option<RemoteCancelTaskRequest>>,
    explicit_context_ids: Mutex<Vec<String>>,
    legacy_image_names: Mutex<Vec<String>>,
}

impl RecordingCommandHost {
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn submitted_dialog(&self) -> RemoteDialogSubmissionRequest<String> {
        self.submitted_dialog
            .lock()
            .unwrap()
            .clone()
            .expect("dialog submitted")
    }

    fn cancel_request(&self) -> RemoteCancelTaskRequest {
        self.cancel_request
            .lock()
            .unwrap()
            .clone()
            .expect("cancel requested")
    }

    fn steered_dialog(&self) -> RemoteDialogSteerRequest<String> {
        self.steered_dialog
            .lock()
            .unwrap()
            .clone()
            .expect("dialog steered")
    }
}

#[async_trait::async_trait]
impl RemoteCommandRuntimeHost for RecordingCommandHost {
    type ImageContext = String;

    async fn handle_workspace_command(&self, _command: &RemoteCommand) -> RemoteResponse {
        self.events.lock().unwrap().push("workspace".to_string());
        RemoteResponse::WorkspaceInfo {
            has_workspace: false,
            path: None,
            project_name: None,
            git_branch: None,
            workspace_kind: None,
            assistant_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            capabilities: vec![REMOTE_CAPABILITY_HARNESS_PROFILES_V1.to_string()],
        }
    }

    async fn handle_session_command(&self, _command: &RemoteCommand) -> RemoteResponse {
        self.events.lock().unwrap().push("session".to_string());
        RemoteResponse::SessionCreated {
            session_id: "session-created".to_string(),
            workspace_path: None,
            remote_connection_id: None,
        }
    }

    async fn handle_poll_command(&self, _command: &RemoteCommand) -> RemoteResponse {
        self.events.lock().unwrap().push("poll".to_string());
        RemoteResponse::SessionPoll {
            version: 0,
            changed: false,
            session_state: None,
            title: None,
            new_messages: None,
            total_msg_count: None,
            message_snapshot: None,
            active_turn: None,
            model_catalog: Box::new(None),
        }
    }

    async fn handle_workspace_file_command(&self, _command: &RemoteCommand) -> RemoteResponse {
        self.events.lock().unwrap().push("file".to_string());
        RemoteResponse::FileInfo {
            name: "file.txt".to_string(),
            size: 1,
            mime_type: "text/plain".to_string(),
        }
    }

    async fn handle_interaction_command(&self, _command: &RemoteCommand) -> RemoteResponse {
        self.events.lock().unwrap().push("interaction".to_string());
        RemoteResponse::InteractionAccepted {
            action: "cancel_tool".to_string(),
            target_id: "tool-1".to_string(),
        }
    }

    async fn submit_dialog(
        &self,
        request: RemoteDialogSubmissionRequest<Self::ImageContext>,
    ) -> Result<RemoteDialogSubmitOutcome, String> {
        self.events.lock().unwrap().push("submit".to_string());
        *self.submitted_dialog.lock().unwrap() = Some(request.clone());
        Ok(RemoteDialogSubmitOutcome::Started {
            session_id: request.session_id,
            turn_id: "turn-command".to_string(),
        })
    }

    async fn steer_dialog(
        &self,
        request: RemoteDialogSteerRequest<Self::ImageContext>,
    ) -> Result<RemoteDialogSteerOutcome, String> {
        self.events.lock().unwrap().push("steer".to_string());
        *self.steered_dialog.lock().unwrap() = Some(request.clone());
        Ok(RemoteDialogSteerOutcome {
            session_id: request.session_id,
            turn_id: request.turn_id,
            steering_id: "steering-command".to_string(),
        })
    }

    async fn cancel_task(&self, request: RemoteCancelTaskRequest) -> Result<(), String> {
        self.events.lock().unwrap().push("cancel".to_string());
        *self.cancel_request.lock().unwrap() = Some(request);
        Ok(())
    }

    fn legacy_image_contexts(&self, images: Option<&[ImageAttachment]>) -> Vec<Self::ImageContext> {
        let names = images
            .unwrap_or_default()
            .iter()
            .map(|image| image.name.clone())
            .collect::<Vec<_>>();
        *self.legacy_image_names.lock().unwrap() = names.clone();
        names
            .into_iter()
            .map(|name| format!("legacy:{name}"))
            .collect()
    }

    fn explicit_image_contexts(
        &self,
        contexts: Vec<RemoteImageContext>,
    ) -> Vec<Self::ImageContext> {
        let ids = contexts
            .into_iter()
            .map(|context| context.id)
            .collect::<Vec<_>>();
        *self.explicit_context_ids.lock().unwrap() = ids.clone();
        ids.into_iter().map(|id| format!("explicit:{id}")).collect()
    }
}

#[tokio::test]
async fn remote_connect_command_owner_routes_send_message_and_prefers_explicit_images() {
    let host = RecordingCommandHost::default();

    let response = handle_remote_command(
        &host,
        &RemoteCommand::SendMessage {
            session_id: "session-1".to_string(),
            content: "hello".to_string(),
            display_content: None,
            turn_id: Some("harmony-turn-1".to_string()),
            agent_type: Some("code".to_string()),
            images: Some(vec![ImageAttachment {
                name: "legacy.png".to_string(),
                data_url: "data:image/png;base64,legacy".to_string(),
            }]),
            image_contexts: Some(vec![RemoteImageContext {
                id: "ctx-1".to_string(),
                image_path: Some("D:/workspace/project/screenshot.png".to_string()),
                data_url: None,
                mime_type: "image/png".to_string(),
                metadata: Some(serde_json::json!({ "source": "desktop" })),
            }]),
        },
        RemoteConnectSubmissionSource::Bot,
    )
    .await;

    assert_eq!(
        response,
        RemoteResponse::MessageSent {
            session_id: "session-1".to_string(),
            turn_id: "turn-command".to_string()
        }
    );
    assert_eq!(host.events(), vec!["submit"]);
    assert_eq!(
        host.explicit_context_ids.lock().unwrap().as_slice(),
        &["ctx-1".to_string()]
    );
    assert!(host.legacy_image_names.lock().unwrap().is_empty());

    let submitted = host.submitted_dialog();
    assert_eq!(submitted.session_id, "session-1");
    assert_eq!(submitted.content, "hello");
    assert_eq!(submitted.agent_type.as_deref(), Some("code"));
    assert_eq!(submitted.image_contexts, vec!["explicit:ctx-1".to_string()]);
    assert_eq!(submitted.policy.source, RemoteConnectSubmissionSource::Bot);
    assert_eq!(submitted.turn_id.as_deref(), Some("harmony-turn-1"));
}

#[tokio::test]
async fn remote_connect_command_owner_builds_a_projected_plan_with_hidden_execution_copy() {
    let host = RecordingCommandHost::default();
    let response = handle_remote_command(
        &host,
        &RemoteCommand::BuildPlan {
            session_id: "session-1".to_string(),
            plan_file_path: "/repo/.openbitfun/plans/mobile.plan.md".to_string(),
            plan_name: Some("Mobile plan".to_string()),
            agent_type: Some("code".to_string()),
        },
        RemoteConnectSubmissionSource::Relay,
    )
    .await;

    assert_eq!(
        response,
        RemoteResponse::MessageSent {
            session_id: "session-1".to_string(),
            turn_id: "turn-command".to_string()
        }
    );
    let submitted = host.submitted_dialog();
    assert_eq!(
        submitted.content,
        remote_plan_build_content("/repo/.openbitfun/plans/mobile.plan.md")
    );
    assert_eq!(
        submitted.display_content.as_deref(),
        Some("Build Plan: Mobile plan")
    );
    assert!(submitted.image_contexts.is_empty());
}

#[test]
fn remote_connect_plan_projection_covers_legacy_create_and_modern_write_tools() {
    let legacy = project_remote_plan_tool(
        "CreatePlan",
        Some(&serde_json::json!({ "name": "Legacy plan" })),
        Some(&serde_json::json!({
            "plan_file_path": "/repo/.openbitfun/plans/legacy.plan.md",
            "overview": "Ship the mobile flow"
        })),
    )
    .expect("legacy CreatePlan is projected");
    assert_eq!(legacy.name, "Legacy plan");
    assert_eq!(legacy.file_path, "/repo/.openbitfun/plans/legacy.plan.md");

    let modern = project_remote_plan_tool(
        "Write",
        Some(&serde_json::json!({
            "file_path": "/repo/.openbitfun/plans/modern.plan.md"
        })),
        None,
    )
    .expect("modern plan write is projected");
    assert_eq!(modern.name, "modern");
    assert!(project_remote_plan_tool(
        "Write",
        Some(&serde_json::json!({ "file_path": "/repo/README.md" })),
        None,
    )
    .is_none());
}

#[tokio::test]
async fn remote_connect_command_owner_routes_steering_without_starting_a_new_turn() {
    let host = RecordingCommandHost::default();
    let response = handle_remote_command(
        &host,
        &RemoteCommand::SteerTurn {
            session_id: "session-1".to_string(),
            turn_id: "turn-running".to_string(),
            content: "change direction".to_string(),
            display_content: Some("Change direction".to_string()),
            images: None,
            image_contexts: Some(vec![RemoteImageContext {
                id: "ctx-steer".to_string(),
                image_path: None,
                data_url: Some("data:image/png;base64,aGVsbG8=".to_string()),
                mime_type: "image/png".to_string(),
                metadata: None,
            }]),
            metadata: serde_json::Map::from_iter([(
                "source".to_string(),
                serde_json::json!("harmony"),
            )]),
        },
        RemoteConnectSubmissionSource::Relay,
    )
    .await;

    assert_eq!(
        response,
        RemoteResponse::SteeringAccepted {
            session_id: "session-1".to_string(),
            turn_id: "turn-running".to_string(),
            steering_id: "steering-command".to_string(),
        }
    );
    assert_eq!(host.events(), vec!["steer"]);
    let request = host.steered_dialog();
    assert_eq!(request.content, "change direction");
    assert_eq!(request.display_content.as_deref(), Some("Change direction"));
    assert_eq!(request.image_contexts, vec!["explicit:ctx-steer"]);
    assert_eq!(request.metadata["source"], "harmony");
}

#[tokio::test]
async fn remote_connect_command_owner_preserves_cancel_and_group_routing() {
    let host = RecordingCommandHost::default();

    assert_eq!(
        handle_remote_command(
            &host,
            &RemoteCommand::Ping { client: None },
            RemoteConnectSubmissionSource::Relay
        )
        .await,
        RemoteResponse::Pong
    );

    let workspace = handle_remote_command(
        &host,
        &RemoteCommand::GetWorkspaceInfo,
        RemoteConnectSubmissionSource::Relay,
    )
    .await;
    assert!(matches!(workspace, RemoteResponse::WorkspaceInfo { .. }));

    let file = handle_remote_command(
        &host,
        &RemoteCommand::GetFileInfo {
            path: "README.md".to_string(),
            session_id: None,
            workspace_path: None,
            remote_connection_id: None,
        },
        RemoteConnectSubmissionSource::Relay,
    )
    .await;
    assert!(matches!(file, RemoteResponse::FileInfo { .. }));

    let interaction = handle_remote_command(
        &host,
        &RemoteCommand::CancelTool {
            tool_id: "tool-1".to_string(),
            reason: None,
        },
        RemoteConnectSubmissionSource::Relay,
    )
    .await;
    assert!(matches!(
        interaction,
        RemoteResponse::InteractionAccepted { .. }
    ));

    let cancel = handle_remote_command(
        &host,
        &RemoteCommand::CancelTask {
            session_id: "session-1".to_string(),
            turn_id: Some("turn-1".to_string()),
        },
        RemoteConnectSubmissionSource::Relay,
    )
    .await;
    assert_eq!(
        cancel,
        RemoteResponse::TaskCancelled {
            session_id: "session-1".to_string()
        }
    );
    assert_eq!(
        host.events(),
        vec!["workspace", "file", "interaction", "cancel"]
    );
    assert_eq!(
        host.cancel_request(),
        RemoteCancelTaskRequest {
            session_id: "session-1".to_string(),
            requested_turn_id: Some("turn-1".to_string()),
        }
    );
}

#[tokio::test]
async fn remote_connect_dialog_runtime_owns_restore_prewarm_and_submit_order() {
    let host = RecordingDialogHost::new(false, Some("D:/workspace/project"));

    let outcome = submit_remote_dialog(
        &host,
        RemoteDialogSubmissionRequest {
            session_id: "session-1".to_string(),
            content: "hello".to_string(),
            display_content: None,
            agent_type: Some("code".to_string()),
            image_contexts: vec!["image-1".to_string()],
            policy: RemoteDialogSubmissionPolicy::for_source(RemoteConnectSubmissionSource::Relay),
            turn_id: None,
        },
    )
    .await
    .expect("dialog submit succeeds");

    assert_eq!(
        outcome,
        RemoteDialogSubmitOutcome::Started {
            session_id: "session-1".to_string(),
            turn_id: "turn-generated".to_string()
        }
    );
    assert_eq!(
        host.events(),
        vec![
            "ensure_tracker:session-1",
            "resolve_workspace:session-1",
            "session_exists:session-1",
            "restore:session-1:D:/workspace/project:<none>:<none>",
            "prewarm:session-1:D:/workspace/project",
            "generate_turn",
            "submit:session-1",
        ]
    );

    let submitted = host.submitted();
    assert_eq!(submitted.session_id, "session-1");
    assert_eq!(submitted.content, "hello");
    assert_eq!(submitted.resolved_agent_type, "Standard");
    assert_eq!(
        submitted
            .binding_workspace
            .as_ref()
            .map(|binding| binding.workspace_path.as_str()),
        Some("D:/workspace/project")
    );
    assert_eq!(submitted.image_contexts, vec!["image-1".to_string()]);
    assert_eq!(submitted.turn_id, "turn-generated");
    assert_eq!(
        submitted.policy.source,
        RemoteConnectSubmissionSource::Relay
    );
    assert_eq!(
        submitted.policy.queue_priority,
        RemoteDialogQueuePriority::Normal
    );
}

#[tokio::test]
async fn remote_connect_dialog_runtime_preserves_remote_workspace_identity() {
    let host = RecordingDialogHost::new(false, None).with_remote_binding(
        "/home/wsp/project",
        "ssh-1",
        "dev-host",
    );

    submit_remote_dialog(
        &host,
        RemoteDialogSubmissionRequest {
            session_id: "session-1".to_string(),
            content: "hello".to_string(),
            display_content: None,
            agent_type: Some("code".to_string()),
            image_contexts: Vec::<String>::new(),
            policy: RemoteDialogSubmissionPolicy::for_source(RemoteConnectSubmissionSource::Relay),
            turn_id: Some("turn-remote".to_string()),
        },
    )
    .await
    .expect("dialog submit succeeds");

    assert_eq!(
        host.events(),
        vec![
            "ensure_tracker:session-1",
            "resolve_workspace:session-1",
            "session_exists:session-1",
            "restore:session-1:/home/wsp/project:ssh-1:dev-host",
            "prewarm:session-1:/home/wsp/project",
            "submit:session-1",
        ]
    );

    let submitted = host.submitted();
    let binding = submitted
        .binding_workspace
        .as_ref()
        .expect("binding workspace should be preserved");
    assert_eq!(binding.workspace_path, "/home/wsp/project");
    assert_eq!(binding.remote_connection_id.as_deref(), Some("ssh-1"));
    assert_eq!(binding.remote_ssh_host.as_deref(), Some("dev-host"));
}

#[tokio::test]
async fn remote_connect_dialog_runtime_preserves_explicit_turn_without_restore() {
    let host = RecordingDialogHost::new(true, Some("D:/workspace/project")).with_submit_outcome(
        RemoteDialogSubmitOutcome::Queued {
            session_id: "session-1".to_string(),
            turn_id: "turn-bot".to_string(),
        },
    );

    let outcome = submit_remote_dialog(
        &host,
        RemoteDialogSubmissionRequest {
            session_id: "session-1".to_string(),
            content: "from bot".to_string(),
            display_content: None,
            agent_type: Some("Cowork".to_string()),
            image_contexts: Vec::new(),
            policy: RemoteDialogSubmissionPolicy::for_source(RemoteConnectSubmissionSource::Bot),
            turn_id: Some("turn-bot".to_string()),
        },
    )
    .await
    .expect("dialog submit succeeds");

    assert_eq!(
        outcome,
        RemoteDialogSubmitOutcome::Queued {
            session_id: "session-1".to_string(),
            turn_id: "turn-bot".to_string()
        }
    );
    assert_eq!(
        host.events(),
        vec![
            "ensure_tracker:session-1",
            "resolve_workspace:session-1",
            "session_exists:session-1",
            "prewarm:session-1:D:/workspace/project",
            "submit:session-1",
        ]
    );

    let submitted = host.submitted();
    assert_eq!(submitted.resolved_agent_type, "Cowork");
    assert_eq!(submitted.turn_id, "turn-bot");
    assert_eq!(submitted.policy.source, RemoteConnectSubmissionSource::Bot);
}

#[test]
fn remote_connect_dialog_submit_outcome_builder_preserves_scheduler_shape() {
    assert_eq!(
        remote_dialog_submit_outcome_from_scheduler(RemoteDialogSchedulerOutcomeFact::Started {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
        }),
        RemoteDialogSubmitOutcome::Started {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
        }
    );
    assert_eq!(
        remote_dialog_submit_outcome_from_scheduler(RemoteDialogSchedulerOutcomeFact::Queued {
            session_id: "session-2".to_string(),
            turn_id: "turn-2".to_string(),
        }),
        RemoteDialogSubmitOutcome::Queued {
            session_id: "session-2".to_string(),
            turn_id: "turn-2".to_string(),
        }
    );
}

#[tokio::test]
async fn remote_connect_dialog_runtime_stops_before_prewarm_when_restore_fails() {
    let host = RecordingDialogHost::new(false, Some("D:/workspace/project")).with_restore_error();

    let error = submit_remote_dialog(
        &host,
        RemoteDialogSubmissionRequest {
            session_id: "session-1".to_string(),
            content: "hello".to_string(),
            display_content: None,
            agent_type: None,
            image_contexts: Vec::new(),
            policy: RemoteDialogSubmissionPolicy::for_source(RemoteConnectSubmissionSource::Relay),
            turn_id: Some("turn-1".to_string()),
        },
    )
    .await
    .expect_err("restore failure must not submit against a partially restored session");
    assert_eq!(error, "restore failed");

    assert_eq!(
        host.events(),
        vec![
            "ensure_tracker:session-1",
            "resolve_workspace:session-1",
            "session_exists:session-1",
            "restore:session-1:D:/workspace/project:<none>:<none>",
        ]
    );
    assert!(host.submitted.lock().unwrap().is_none());
}

#[tokio::test]
async fn remote_connect_cancel_runtime_restores_missing_session_before_cancel() {
    let host = RecordingCancelHost::new(
        None,
        Some(remote_state(
            "session-1",
            RemoteControlSessionState::Processing,
            Some("turn-current"),
        )),
        Some("D:/workspace/project"),
    );

    cancel_remote_task(
        &host,
        RemoteCancelTaskRequest {
            session_id: "session-1".to_string(),
            requested_turn_id: None,
        },
    )
    .await
    .expect("cancel succeeds after restore");

    assert_eq!(
        host.events(),
        vec![
            "read_state:session-1",
            "resolve_workspace:session-1",
            "restore:session-1:D:/workspace/project",
            "read_state:session-1",
            "cancel:session-1:turn-current",
        ]
    );
}

#[tokio::test]
async fn remote_connect_cancel_runtime_preserves_stale_and_idle_errors_without_restore() {
    let stale_host = RecordingCancelHost::new(
        Some(remote_state(
            "session-1",
            RemoteControlSessionState::Processing,
            Some("turn-current"),
        )),
        None,
        Some("D:/workspace/project"),
    );
    let err = cancel_remote_task(
        &stale_host,
        RemoteCancelTaskRequest {
            session_id: "session-1".to_string(),
            requested_turn_id: Some("turn-stale".to_string()),
        },
    )
    .await
    .expect_err("stale turn is rejected");
    assert_eq!(err, "This task is no longer running.");
    assert_eq!(stale_host.events(), vec!["read_state:session-1"]);

    let idle_host = RecordingCancelHost::new(
        Some(remote_state(
            "session-2",
            RemoteControlSessionState::Idle,
            None,
        )),
        None,
        Some("D:/workspace/project"),
    );
    let err = cancel_remote_task(
        &idle_host,
        RemoteCancelTaskRequest {
            session_id: "session-2".to_string(),
            requested_turn_id: None,
        },
    )
    .await
    .expect_err("idle session has no running turn");
    assert_eq!(err, "No running task to cancel for session: session-2");
    assert_eq!(idle_host.events(), vec!["read_state:session-2"]);
}

#[tokio::test]
async fn remote_connect_cancel_runtime_preserves_restore_failure_error() {
    let host =
        RecordingCancelHost::new(None, None, Some("D:/workspace/project")).with_restore_error();

    let err = cancel_remote_task(
        &host,
        RemoteCancelTaskRequest {
            session_id: "session-1".to_string(),
            requested_turn_id: Some("turn-current".to_string()),
        },
    )
    .await
    .expect_err("restore error is propagated with legacy prefix");

    assert_eq!(err, "Session not found: restore failed");
    assert_eq!(
        host.events(),
        vec![
            "read_state:session-1",
            "resolve_workspace:session-1",
            "restore:session-1:D:/workspace/project",
        ]
    );
}

#[test]
fn remote_connect_file_transfer_policy_preserves_limits_and_chunk_ranges() {
    assert_eq!(REMOTE_FILE_MAX_READ_BYTES, 30 * 1024 * 1024);
    assert_eq!(REMOTE_FILE_MAX_CHUNK_BYTES, 3 * 1024 * 1024);
    assert_eq!(REMOTE_FILE_MAX_CHUNK_BYTES % 3, 0);

    let range = resolve_remote_file_chunk_range(10_000_000, 5, REMOTE_FILE_MAX_CHUNK_BYTES + 99);
    assert_eq!(range.start, 5);
    assert_eq!(range.end, 5 + REMOTE_FILE_MAX_CHUNK_BYTES as usize);
    assert_eq!(range.chunk_size, REMOTE_FILE_MAX_CHUNK_BYTES);

    let tail = resolve_remote_file_chunk_range(100, 95, 30);
    assert_eq!(tail.start, 95);
    assert_eq!(tail.end, 100);
    assert_eq!(tail.chunk_size, 5);

    let past_end = resolve_remote_file_chunk_range(100, 150, 30);
    assert_eq!(past_end.start, 100);
    assert_eq!(past_end.end, 100);
    assert_eq!(past_end.chunk_size, 0);
}

#[test]
fn remote_connect_file_transfer_policy_preserves_name_fallback() {
    assert_eq!(remote_file_display_name(Some("report.md")), "report.md");
    assert_eq!(remote_file_display_name(None), "file");
    assert_eq!(remote_file_display_name(Some("")), "file");
}

fn make_temp_remote_workspace() -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "openbitfun-remote-connect-contract-{}",
        uuid::Uuid::new_v4()
    ));
    let workspace = base.join("workspace");
    let artifacts = workspace.join("artifacts");
    std::fs::create_dir_all(&artifacts).expect("create remote workspace");
    let report = artifacts.join("report.md");
    std::fs::write(&report, b"hello remote file").expect("write remote file");
    (base, workspace, report)
}

#[test]
fn remote_connect_file_path_resolution_stays_within_workspace_root() {
    let (base, workspace, report) = make_temp_remote_workspace();
    let secret = base.join("secret.md");
    std::fs::write(&secret, b"outside workspace").expect("write outside file");

    let resolved =
        resolve_remote_workspace_path("computer://artifacts/report.md", Some(&workspace))
            .expect("workspace-relative file resolves");
    assert_eq!(resolved, report.canonicalize().expect("canonical report"));

    let absolute_resolved =
        resolve_remote_workspace_path(report.to_str().expect("UTF-8 test path"), Some(&workspace))
            .expect("absolute path within workspace resolves");
    assert_eq!(
        absolute_resolved,
        report.canonicalize().expect("canonical report")
    );

    assert!(resolve_remote_workspace_path("../secret.md", Some(&workspace)).is_none());
    assert!(resolve_remote_workspace_path(
        secret.to_str().expect("UTF-8 test path"),
        Some(&workspace)
    )
    .is_none());
    assert!(resolve_remote_workspace_path("artifacts/report.md", None).is_none());

    std::fs::remove_dir_all(base).expect("cleanup remote workspace");
}

#[tokio::test]
async fn remote_connect_file_read_helpers_preserve_current_wire_inputs() {
    let (base, workspace, report) = make_temp_remote_workspace();

    let content = read_remote_workspace_file(
        "computer://artifacts/report.md",
        REMOTE_FILE_MAX_READ_BYTES,
        Some(&workspace),
    )
    .await
    .expect("read remote file");

    assert_eq!(content.name, "report.md");
    assert_eq!(content.bytes, b"hello remote file");
    assert_eq!(content.mime_type, "text/markdown");
    assert_eq!(content.size, 17);

    let err = read_remote_workspace_file("computer://artifacts/report.md", 3, Some(&workspace))
        .await
        .expect_err("size limit rejects large file");
    assert!(err.contains("File too large"));
    assert!(err.contains(&report.display().to_string()));

    std::fs::remove_dir_all(base).expect("cleanup remote workspace");
}

#[tokio::test]
async fn remote_connect_file_chunk_and_info_helpers_preserve_response_facts() {
    let (base, workspace, _report) = make_temp_remote_workspace();

    let chunk =
        read_remote_workspace_file_chunk("computer://artifacts/report.md", Some(&workspace), 6, 99)
            .await
            .expect("read remote file chunk");

    assert_eq!(chunk.name, "report.md");
    assert_eq!(chunk.bytes, b"remote file");
    assert_eq!(chunk.offset, 6);
    assert_eq!(chunk.chunk_size, 11);
    assert_eq!(chunk.total_size, 17);
    assert_eq!(chunk.mime_type, "text/markdown");

    let info = read_remote_workspace_file_info("computer://artifacts/report.md", Some(&workspace))
        .await
        .expect("read remote file info");

    assert_eq!(info.name, "report.md");
    assert_eq!(info.size, 17);
    assert_eq!(info.mime_type, "text/markdown");

    std::fs::remove_dir_all(base).expect("cleanup remote workspace");
}

#[test]
fn remote_connect_file_response_assembly_owns_base64_wire_shape() {
    let content_response = remote_file_content_response(Ok(RemoteWorkspaceFileContent {
        name: "report.md".to_string(),
        bytes: b"hello remote file".to_vec(),
        mime_type: "text/markdown",
        size: 17,
    }));
    let content_json = serde_json::to_value(content_response).expect("serialize file content");

    assert_eq!(content_json["resp"], "file_content");
    assert_eq!(content_json["name"], "report.md");
    assert_eq!(content_json["content_base64"], "aGVsbG8gcmVtb3RlIGZpbGU=");
    assert_eq!(content_json["mime_type"], "text/markdown");
    assert_eq!(content_json["size"], 17);

    let chunk_response = remote_file_chunk_response(Ok(RemoteWorkspaceFileChunk {
        revision: String::new(),
        name: "report.md".to_string(),
        bytes: b"remote file".to_vec(),
        offset: 6,
        chunk_size: 11,
        total_size: 17,
        mime_type: "text/markdown",
    }));
    let chunk_json = serde_json::to_value(chunk_response).expect("serialize file chunk");

    assert_eq!(chunk_json["resp"], "file_chunk");
    assert_eq!(chunk_json["chunk_base64"], "cmVtb3RlIGZpbGU=");
    assert_eq!(chunk_json["offset"], 6);
    assert_eq!(chunk_json["chunk_size"], 11);
    assert_eq!(chunk_json["total_size"], 17);

    let info_response = remote_file_info_response(Ok(RemoteWorkspaceFileInfo {
        name: "report.md".to_string(),
        size: 17,
        mime_type: "text/markdown",
    }));
    let info_json = serde_json::to_value(info_response).expect("serialize file info");

    assert_eq!(info_json["resp"], "file_info");
    assert_eq!(info_json["name"], "report.md");
    assert_eq!(info_json["mime_type"], "text/markdown");

    let err_json = serde_json::to_value(remote_file_info_response(Err("missing file".to_string())))
        .expect("serialize file error");
    assert_eq!(err_json["resp"], "error");
    assert_eq!(err_json["message"], "missing file");
}

#[derive(Default)]
struct RecordingFileHost {
    workspace_root: PathBuf,
    seen_sessions: Mutex<Vec<Option<String>>>,
}

#[async_trait::async_trait]
impl RemoteWorkspaceFileRuntimeHost for RecordingFileHost {
    async fn resolve_remote_file_workspace_root(
        &self,
        session_id: Option<&str>,
    ) -> Option<PathBuf> {
        self.seen_sessions
            .lock()
            .unwrap()
            .push(session_id.map(ToOwned::to_owned));
        Some(self.workspace_root.clone())
    }
}

#[tokio::test]
async fn remote_connect_file_command_handler_owns_owner_flow_and_uses_host_root() {
    let (base, workspace, _report) = make_temp_remote_workspace();
    let host = RecordingFileHost {
        workspace_root: workspace,
        seen_sessions: Mutex::new(Vec::new()),
    };

    let response = handle_remote_workspace_file_command(
        &host,
        &RemoteCommand::ReadFile {
            path: "computer://artifacts/report.md".to_string(),
            session_id: Some("session-1".to_string()),
        },
    )
    .await;
    let json = serde_json::to_value(response).expect("serialize read response");

    assert_eq!(json["resp"], "file_content");
    assert_eq!(json["content_base64"], "aGVsbG8gcmVtb3RlIGZpbGU=");
    assert_eq!(
        host.seen_sessions.lock().unwrap().as_slice(),
        &[Some("session-1".to_string())]
    );

    let error =
        handle_remote_workspace_file_command(&host, &RemoteCommand::Ping { client: None }).await;
    assert_eq!(
        error,
        RemoteResponse::Error {
            message: "Unsupported remote workspace file command".to_string()
        }
    );

    std::fs::remove_dir_all(base).expect("cleanup remote workspace");
}

struct UnavailableSessionFileHost;

#[async_trait::async_trait]
impl RemoteWorkspaceFileRuntimeHost for UnavailableSessionFileHost {
    async fn resolve_remote_file_workspace_root(&self, _: Option<&str>) -> Option<PathBuf> {
        panic!("A session provider error must never access the legacy local root")
    }

    async fn read_remote_file(
        &self,
        _: &str,
        session: Option<&str>,
        _: u64,
    ) -> Result<Option<RemoteWorkspaceFileContent>, String> {
        assert_eq!(session, Some("remote-session"));
        Err("Session host is offline".into())
    }

    async fn read_remote_file_chunk(
        &self,
        _: &str,
        session: Option<&str>,
        _: Option<&str>,
        _: Option<&str>,
        _: u64,
        _: u64,
    ) -> Result<Option<RemoteWorkspaceFileChunk>, String> {
        assert_eq!(session, Some("remote-session"));
        Err("Session host is offline".into())
    }

    async fn remote_file_info(
        &self,
        _: &str,
        session: Option<&str>,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<Option<RemoteWorkspaceFileInfo>, String> {
        assert_eq!(session, Some("remote-session"));
        Err("Session host is offline".into())
    }
}

#[tokio::test]
async fn remote_connect_file_provider_errors_never_fall_back_to_local_files() {
    let path = "computer://output.png".to_string();
    let session_id = Some("remote-session".to_string());
    for command in [
        RemoteCommand::ReadFile {
            path: path.clone(),
            session_id: session_id.clone(),
        },
        RemoteCommand::ReadFileChunk {
            path: path.clone(),
            session_id: session_id.clone(),
            offset: 0,
            limit: 3,
            workspace_path: None,
            remote_connection_id: None,
        },
        RemoteCommand::GetFileInfo {
            path,
            session_id,
            workspace_path: None,
            remote_connection_id: None,
        },
    ] {
        assert_eq!(
            handle_remote_workspace_file_command(&UnavailableSessionFileHost, &command).await,
            RemoteResponse::Error {
                message: "Session host is offline".into()
            }
        );
    }
}

struct ExplicitFileWorkspaceHost;

#[async_trait::async_trait]
impl RemoteWorkspaceFileRuntimeHost for ExplicitFileWorkspaceHost {
    async fn resolve_remote_file_workspace_root(&self, _: Option<&str>) -> Option<PathBuf> {
        panic!("Explicit remote identity must never fall back to the selected local workspace")
    }
    async fn read_remote_file_chunk(
        &self,
        _: &str,
        session: Option<&str>,
        workspace: Option<&str>,
        connection: Option<&str>,
        _: u64,
        _: u64,
    ) -> Result<Option<RemoteWorkspaceFileChunk>, String> {
        assert_eq!(session, None);
        assert_eq!(workspace, Some("/captured/workspace"));
        assert_eq!(connection, Some("saved-runtime-profile"));
        Ok(None)
    }
    async fn remote_file_info(
        &self,
        _: &str,
        session: Option<&str>,
        workspace: Option<&str>,
        connection: Option<&str>,
    ) -> Result<Option<RemoteWorkspaceFileInfo>, String> {
        assert_eq!(session, None);
        assert_eq!(workspace, Some("/captured/workspace"));
        assert_eq!(connection, Some("saved-runtime-profile"));
        Ok(None)
    }
}

#[tokio::test]
async fn remote_connect_explicit_file_workspace_is_forwarded_without_local_fallback() {
    for name in ["read_file_chunk", "get_file_info"] {
        let command: RemoteCommand = serde_json::from_value(serde_json::json!({
            "cmd": name, "path": "file.bin", "workspace_path": "/captured/workspace",
            "remote_connection_id": "saved-runtime-profile", "offset": 0, "limit": 3
        }))
        .unwrap();
        assert_eq!(
            handle_remote_workspace_file_command(&ExplicitFileWorkspaceHost, &command).await,
            RemoteResponse::Error {
                message: "This host cannot resolve an explicit file workspace".into()
            }
        );
    }
}

#[test]
fn remote_connect_execution_response_helpers_preserve_wire_shape() {
    let started = remote_dialog_submit_response(Ok(RemoteDialogSubmitOutcome::Started {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
    }));
    assert_eq!(
        started,
        RemoteResponse::MessageSent {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
        }
    );

    let queued = remote_dialog_submit_response(Ok(RemoteDialogSubmitOutcome::Queued {
        session_id: "session-1".to_string(),
        turn_id: "turn-2".to_string(),
    }));
    assert_eq!(
        queued,
        RemoteResponse::MessageSent {
            session_id: "session-1".to_string(),
            turn_id: "turn-2".to_string(),
        }
    );

    assert_eq!(
        remote_dialog_steer_response(Ok(RemoteDialogSteerOutcome {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            steering_id: "steering-1".to_string(),
        })),
        RemoteResponse::SteeringAccepted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            steering_id: "steering-1".to_string(),
        }
    );

    assert_eq!(
        remote_task_cancel_response("session-1", Ok(())),
        RemoteResponse::TaskCancelled {
            session_id: "session-1".to_string(),
        }
    );
    assert_eq!(
        remote_interaction_accepted_response("cancel_tool", "tool-1", Ok(())),
        RemoteResponse::InteractionAccepted {
            action: "cancel_tool".to_string(),
            target_id: "tool-1".to_string(),
        }
    );
    assert_eq!(
        remote_answer_question_response(Ok(())),
        RemoteResponse::AnswerAccepted
    );
    assert_eq!(
        remote_answer_question_response(Err("question closed".to_string())),
        RemoteResponse::Error {
            message: "question closed".to_string(),
        }
    );
}

#[test]
fn remote_connect_workspace_response_helpers_own_wire_shape() {
    let workspace = RemoteWorkspaceFacts {
        path: "D:/workspace/project".to_string(),
        name: "project".to_string(),
        git_branch: Some("main".to_string()),
        kind: RemoteWorkspaceKind::Remote,
        assistant_id: Some("assistant-1".to_string()),
        remote_connection_id: Some("ssh-1".to_string()),
        remote_ssh_host: Some("dev-host".to_string()),
    };

    let info_json = serde_json::to_value(remote_workspace_info_response(Some(workspace.clone())))
        .expect("serialize workspace info");
    assert_eq!(info_json["resp"], "workspace_info");
    assert_eq!(info_json["has_workspace"], true);
    assert_eq!(info_json["path"], "D:/workspace/project");
    assert_eq!(info_json["project_name"], "project");
    assert_eq!(info_json["git_branch"], "main");
    assert_eq!(info_json["workspace_kind"], "remote");
    assert_eq!(info_json["assistant_id"], "assistant-1");
    assert_eq!(info_json["remote_connection_id"], "ssh-1");
    assert_eq!(info_json["remote_ssh_host"], "dev-host");
    assert_eq!(
        info_json["capabilities"],
        serde_json::json!([
            REMOTE_CAPABILITY_HARNESS_PROFILES_V1,
            REMOTE_CAPABILITY_DIALOG_STEER_V1,
            REMOTE_CAPABILITY_PLAN_BUILD_V1,
            "user_question_interaction_v1"
        ])
    );
    let mut legacy_info_json = info_json.clone();
    legacy_info_json
        .as_object_mut()
        .expect("workspace info is an object")
        .remove("capabilities");
    assert!(matches!(
        serde_json::from_value::<RemoteResponse>(legacy_info_json)
            .expect("legacy workspace info remains readable"),
        RemoteResponse::WorkspaceInfo { capabilities, .. } if capabilities.is_empty()
    ));

    let empty_json =
        serde_json::to_value(remote_workspace_info_response(None)).expect("serialize empty info");
    assert_eq!(empty_json["resp"], "workspace_info");
    assert_eq!(empty_json["has_workspace"], false);
    assert!(empty_json.get("workspace_kind").is_none());

    let recent_json = serde_json::to_value(remote_recent_workspaces_response(vec![
        RemoteRecentWorkspaceFacts {
            path: workspace.path.clone(),
            name: workspace.name.clone(),
            last_opened: "2026-05-25T00:00:00Z".to_string(),
            kind: workspace.kind,
            remote_connection_id: workspace.remote_connection_id.clone(),
            remote_ssh_host: workspace.remote_ssh_host.clone(),
        },
    ]))
    .expect("serialize recent workspaces");
    assert_eq!(recent_json["resp"], "recent_workspaces");
    assert_eq!(recent_json["workspaces"][0]["workspace_kind"], "remote");
    assert_eq!(
        recent_json["workspaces"][0]["last_opened"],
        "2026-05-25T00:00:00Z"
    );
    assert_eq!(
        recent_json["workspaces"][0]["remote_connection_id"],
        "ssh-1"
    );
    assert_eq!(recent_json["workspaces"][0]["remote_ssh_host"], "dev-host");

    let assistant_json = serde_json::to_value(remote_assistant_list_response(vec![
        RemoteAssistantWorkspaceFacts {
            path: "D:/workspace/assistant".to_string(),
            name: "assistant".to_string(),
            assistant_id: Some("assistant-2".to_string()),
        },
    ]))
    .expect("serialize assistant list");
    assert_eq!(assistant_json["resp"], "assistant_list");
    assert_eq!(
        assistant_json["assistants"][0]["assistant_id"],
        "assistant-2"
    );

    assert_eq!(
        remote_workspace_updated_response(Ok(RemoteWorkspaceUpdate {
            path: "D:/workspace/project".to_string(),
            name: "project".to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })),
        RemoteResponse::WorkspaceUpdated {
            success: true,
            path: Some("D:/workspace/project".to_string()),
            project_name: Some("project".to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
            error: None,
        }
    );
    assert_eq!(
        remote_assistant_updated_response(Err("open failed".to_string())),
        RemoteResponse::AssistantUpdated {
            success: false,
            path: None,
            name: None,
            error: Some("open failed".to_string()),
        }
    );
}

#[test]
fn remote_connect_session_list_hides_child_sessions_and_counts_only_what_it_sends() {
    // Desktop nests btw/review/miniapp children under their parent. The remote
    // command path is flat, so a child would read as a standalone conversation.
    let metadata = vec![
        RemoteSessionMetadata {
            session_id: "parent".to_string(),
            name: "iOS sidebar spacing".to_string(),
            agent_type: "Standard".to_string(),
            created_at_ms: 1_700_000_000_000,
            last_active_at_ms: 1_700_000_001_000,
            turn_count: 2,
            parent_session_id: None,
            relationship_kind: None,
        },
        RemoteSessionMetadata {
            session_id: "btw".to_string(),
            name: "why did it grep with bash".to_string(),
            agent_type: "Standard".to_string(),
            created_at_ms: 1_700_000_002_000,
            last_active_at_ms: 1_700_000_003_000,
            turn_count: 1,
            parent_session_id: Some("parent".to_string()),
            relationship_kind: Some("btw".to_string()),
        },
    ];

    let list = remote_session_list_response(metadata, Some("/workspace/project"), Some("project"), 1, 0);
    let list_json = serde_json::to_value(list).expect("serialize session list");
    assert_eq!(list_json["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["sessions"][0]["session_id"], "parent");
    // The child is gone before pagination, so the page is the whole list.
    assert_eq!(list_json["has_more"], false);
    assert!(list_json["sessions"][0].get("parent_session_id").is_none());
}

#[test]
fn remote_connect_session_info_carries_child_lineage_to_clients() {
    let child = RemoteSessionMetadata {
        session_id: "btw".to_string(),
        name: "why did it grep with bash".to_string(),
        agent_type: "Standard".to_string(),
        created_at_ms: 1_700_000_002_000,
        last_active_at_ms: 1_700_000_003_000,
        turn_count: 1,
        parent_session_id: Some("parent".to_string()),
        relationship_kind: Some("btw".to_string()),
    };
    assert!(child.is_child_session());

    let info = remote_session_info(&child, None, None);
    let json = serde_json::to_value(info).expect("serialize session info");
    assert_eq!(json["parent_session_id"], "parent");
    assert_eq!(json["relationship_kind"], "btw");
}

#[test]
fn remote_connect_session_response_helpers_own_pagination_and_timestamps() {
    let metadata = vec![
        RemoteSessionMetadata {
            session_id: "session-1".to_string(),
            name: "first".to_string(),
            agent_type: "Standard".to_string(),
            created_at_ms: 1_700_000_000_000,
            last_active_at_ms: 1_700_000_001_000,
            turn_count: 3,
            parent_session_id: None,
            relationship_kind: None,
        },
        RemoteSessionMetadata {
            session_id: "session-2".to_string(),
            name: "second".to_string(),
            agent_type: "Cowork".to_string(),
            created_at_ms: 1_700_000_002_000,
            last_active_at_ms: 1_700_000_003_000,
            turn_count: 5,
            parent_session_id: None,
            relationship_kind: None,
        },
        RemoteSessionMetadata {
            session_id: "session-3".to_string(),
            name: "third".to_string(),
            agent_type: "Cowork".to_string(),
            created_at_ms: 1_700_000_004_000,
            last_active_at_ms: 1_700_000_005_000,
            turn_count: 8,
            parent_session_id: None,
            relationship_kind: None,
        },
    ];

    let session = remote_session_info(&metadata[0], Some("D:/workspace/project"), Some("project"));
    assert_eq!(session.session_id, "session-1");
    assert_eq!(session.created_at, "1700000000");
    assert_eq!(session.updated_at, "1700000001");
    assert_eq!(session.message_count, 3);
    assert_eq!(
        session.workspace_path.as_deref(),
        Some("D:/workspace/project")
    );
    assert_eq!(session.workspace_name.as_deref(), Some("project"));

    let list = remote_session_list_response(
        metadata.clone(),
        Some("D:/workspace/project"),
        Some("project"),
        1,
        1,
    );
    let list_json = serde_json::to_value(list).expect("serialize session list");
    assert_eq!(list_json["resp"], "session_list");
    assert_eq!(list_json["has_more"], true);
    assert_eq!(list_json["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["sessions"][0]["session_id"], "session-2");
    assert_eq!(list_json["sessions"][0]["created_at"], "1700000002");

    let initial = remote_initial_sync_response(
        Some(RemoteWorkspaceFacts {
            path: "D:/workspace/project".to_string(),
            name: "project".to_string(),
            git_branch: Some("main".to_string()),
            kind: RemoteWorkspaceKind::Normal,
            assistant_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        }),
        metadata,
        Some("project"),
        true,
        Some("user-1".to_string()),
    );
    let initial_json = serde_json::to_value(initial).expect("serialize initial sync");
    assert_eq!(initial_json["resp"], "initial_sync");
    assert_eq!(initial_json["has_workspace"], true);
    assert_eq!(initial_json["workspace_kind"], "normal");
    assert!(initial_json.get("remote_connection_id").is_none());
    assert!(initial_json.get("remote_ssh_host").is_none());
    assert_eq!(initial_json["has_more_sessions"], true);
    assert_eq!(initial_json["sessions"].as_array().unwrap().len(), 3);
    assert_eq!(initial_json["authenticated_user_id"], "user-1");
    assert_eq!(
        initial_json["capabilities"],
        serde_json::json!([
            REMOTE_CAPABILITY_HARNESS_PROFILES_V1,
            REMOTE_CAPABILITY_DIALOG_STEER_V1,
            REMOTE_CAPABILITY_PLAN_BUILD_V1,
            "user_question_interaction_v1"
        ])
    );
    let mut legacy_initial_json = initial_json;
    legacy_initial_json
        .as_object_mut()
        .expect("initial sync is an object")
        .remove("capabilities");
    assert!(matches!(
        serde_json::from_value::<RemoteResponse>(legacy_initial_json)
            .expect("legacy initial sync remains readable"),
        RemoteResponse::InitialSync { capabilities, .. } if capabilities.is_empty()
    ));

    assert_eq!(
        remote_session_created_response("session-new"),
        RemoteResponse::SessionCreated {
            session_id: "session-new".to_string(),
            workspace_path: None,
            remote_connection_id: None,
        }
    );
    assert_eq!(
        remote_session_model_updated_response(
            "session-1",
            RemoteSessionModelSelection {
                model_id: "model-1".to_string(),
                reasoning_preset: None,
            },
        ),
        RemoteResponse::SessionModelUpdated {
            session_id: "session-1".to_string(),
            model_id: "model-1".to_string(),
            reasoning_preset: None,
        }
    );
    assert_eq!(
        remote_messages_response("session-1", vec![], false),
        RemoteResponse::Messages {
            session_id: "session-1".to_string(),
            messages: vec![],
            has_more: false,
        }
    );
    assert_eq!(
        remote_session_deleted_response("session-1"),
        RemoteResponse::SessionDeleted {
            session_id: "session-1".to_string(),
        }
    );
}

#[test]
fn remote_connect_session_create_contract_preserves_workspace_binding() {
    let request = build_remote_session_create_request(
        "Remote Session",
        "Standard",
        Some("D:/workspace/project"),
        RemoteSessionWorkspaceIdentity::new(
            Some("ssh-1".to_string()),
            Some("dev-host".to_string()),
        ),
        RemoteConnectSubmissionSource::Relay,
    );

    assert_eq!(request.session_name, "Remote Session");
    assert_eq!(request.agent_type, "Standard");
    assert_eq!(
        request.workspace_path.as_deref(),
        Some("D:/workspace/project")
    );
    assert_eq!(request.metadata["source"], "remote_relay");
    assert_eq!(request.remote_connection_id.as_deref(), Some("ssh-1"));
    assert_eq!(request.remote_ssh_host.as_deref(), Some("dev-host"));
}

#[test]
fn remote_connect_agent_type_mapping_preserves_current_mobile_aliases() {
    assert_eq!(resolve_remote_agent_type(Some("code")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("Standard")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("Standard")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("balanced")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("standard")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("minimal")), "Minimal");
    assert_eq!(resolve_remote_agent_type(Some("MINIMAL")), "Minimal");
    assert_eq!(resolve_remote_agent_type(Some("ultimate")), "Ultimate");
    assert_eq!(resolve_remote_agent_type(Some("Ultimate")), "Ultimate");
    assert_eq!(resolve_remote_agent_type(Some("cowork")), "Cowork");
    assert_eq!(resolve_remote_agent_type(Some("Cowork")), "Cowork");
    assert_eq!(resolve_remote_agent_type(Some("plan")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("Plan")), "Standard");
    assert_eq!(resolve_remote_agent_type(Some("unknown")), "Standard");
    assert_eq!(resolve_remote_agent_type(None), "Standard");
}

#[test]
fn remote_connect_message_dtos_keep_current_wire_shape() {
    let image = ImageAttachment {
        name: "clip.png".to_string(),
        data_url: "data:image/png;base64,abc".to_string(),
    };
    let chat = ChatMessage {
        id: "msg-1".to_string(),
        role: "assistant".to_string(),
        content: "done".to_string(),
        timestamp: "1".to_string(),
        metadata: None,
        turn_id: Some("turn-1".to_string()),
        status: Some("done".to_string()),
        error: None,
        tools: Some(vec![RemoteToolStatus {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            status: "running".to_string(),
            duration_ms: None,
            start_ms: Some(42),
            input_preview: Some("{\"cmd\":\"git status\"}".to_string()),
            tool_input: None,
            plan: None,
        }]),
        thinking: None,
        items: Some(vec![ChatMessageItem {
            item_type: "tool".to_string(),
            steering_id: None,
            round_index: None,
            content: None,
            tool: None,
            is_subagent: Some(false),
        }]),
        images: Some(vec![ChatImageAttachment {
            name: image.name.clone(),
            data_url: image.data_url.clone(),
        }]),
    };

    let json = serde_json::to_value(chat).expect("serialize chat message");

    assert_eq!(json["id"], "msg-1");
    assert_eq!(json["turn_id"], "turn-1");
    assert_eq!(json["status"], "done");
    assert!(json.get("error").is_none());
    assert_eq!(json["tools"][0]["start_ms"], 42);
    assert_eq!(json["items"][0]["type"], "tool");
    assert_eq!(json["images"][0]["data_url"], "data:image/png;base64,abc");
}

#[test]
fn remote_connect_command_wire_shape_lives_in_owner_contract() {
    let command = RemoteCommand::SendMessage {
        session_id: "session-1".to_string(),
        content: "hello".to_string(),
        display_content: None,
        turn_id: Some("harmony-turn-1".to_string()),
        agent_type: Some("code".to_string()),
        images: Some(vec![ImageAttachment {
            name: "clip.png".to_string(),
            data_url: "data:image/png;base64,abc".to_string(),
        }]),
        image_contexts: Some(vec![RemoteImageContext {
            id: "ctx-1".to_string(),
            image_path: Some("D:/workspace/project/screenshot.png".to_string()),
            data_url: None,
            mime_type: "image/png".to_string(),
            metadata: Some(serde_json::json!({ "source": "remote" })),
        }]),
    };
    let json = serde_json::to_value(command).expect("serialize send command");

    assert_eq!(json["cmd"], "send_message");
    assert_eq!(json["session_id"], "session-1");
    assert_eq!(json["turn_id"], "harmony-turn-1");
    assert_eq!(json["agent_type"], "code");
    assert_eq!(json["images"][0]["name"], "clip.png");
    assert_eq!(json["image_contexts"][0]["id"], "ctx-1");
    assert_eq!(
        json["image_contexts"][0]["image_path"],
        "D:/workspace/project/screenshot.png"
    );
    assert!(json.get("imageContexts").is_none());

    let legacy: RemoteCommand = serde_json::from_value(serde_json::json!({
        "cmd": "send_message",
        "session_id": "session-legacy",
        "content": "hello",
        "agent_type": "code"
    }))
    .expect("deserialize legacy send command");
    match legacy {
        RemoteCommand::SendMessage { turn_id, .. } => assert!(turn_id.is_none()),
        other => panic!("unexpected legacy command: {other:?}"),
    }

    let cancel = serde_json::to_value(RemoteCommand::CancelTask {
        session_id: "session-1".to_string(),
        turn_id: Some("turn-1".to_string()),
    })
    .expect("serialize cancel command");
    assert_eq!(cancel["cmd"], "cancel_task");
    assert_eq!(cancel["turn_id"], "turn-1");

    let list = serde_json::to_value(RemoteCommand::ListSessions {
        workspace_path: Some("/workspace/project".to_string()),
        remote_connection_id: Some("conn-1".to_string()),
        remote_ssh_host: Some("host-1".to_string()),
        limit: Some(30),
        offset: Some(0),
        query: Some("alpha".to_string()),
    })
    .expect("serialize list command");
    assert_eq!(list["cmd"], "list_sessions");
    assert_eq!(list["remote_connection_id"], "conn-1");
    assert_eq!(list["remote_ssh_host"], "host-1");
    assert_eq!(list["query"], "alpha");

    let rename = serde_json::to_value(RemoteCommand::UpdateSessionTitle {
        session_id: "session-1".to_string(),
        title: "Renamed session".to_string(),
    })
    .expect("serialize rename command");
    assert_eq!(rename["cmd"], "update_session_title");
    assert_eq!(rename["title"], "Renamed session");

    let poll = serde_json::to_value(RemoteCommand::PollSession {
        session_id: "session-1".to_string(),
        since_version: 7,
        known_msg_count: 3,
        known_model_catalog_version: Some(11),
    })
    .expect("serialize poll command");
    assert_eq!(poll["cmd"], "poll_session");
    assert_eq!(poll["since_version"], 7);
    assert_eq!(poll["known_msg_count"], 3);
    assert_eq!(poll["known_model_catalog_version"], 11);
}

#[test]
fn remote_model_selection_command_preserves_present_nullable_preset() {
    let omitted: RemoteCommand = serde_json::from_value(serde_json::json!({
        "cmd": "set_session_model",
        "session_id": "session-1",
        "model_id": "model-1"
    }))
    .expect("deserialize legacy model-only command");
    let explicit_auto: RemoteCommand = serde_json::from_value(serde_json::json!({
        "cmd": "set_session_model",
        "session_id": "session-1",
        "model_id": "model-1",
        "reasoning_preset": null
    }))
    .expect("deserialize explicit auto preset");
    let explicit_high: RemoteCommand = serde_json::from_value(serde_json::json!({
        "cmd": "set_session_model",
        "session_id": "session-1",
        "model_id": "model-1",
        "reasoning_preset": "high"
    }))
    .expect("deserialize explicit reasoning preset");

    assert!(matches!(
        omitted,
        RemoteCommand::SetSessionModel {
            reasoning_preset: None,
            ..
        }
    ));
    assert!(matches!(
        explicit_auto,
        RemoteCommand::SetSessionModel {
            reasoning_preset: Some(None),
            ..
        }
    ));
    assert!(matches!(
        explicit_high,
        RemoteCommand::SetSessionModel {
            reasoning_preset: Some(Some(ref preset)),
            ..
        } if preset == "high"
    ));
}

#[test]
fn remote_connect_response_wire_shape_lives_in_owner_contract() {
    let active_turn = ActiveTurnSnapshot {
        turn_id: "turn-1".to_string(),
        status: "active".to_string(),
        error: None,
        text: String::new(),
        thinking: String::new(),
        tools: vec![RemoteToolStatus {
            id: "tool-1".to_string(),
            name: "Read".to_string(),
            status: "running".to_string(),
            duration_ms: None,
            start_ms: Some(42),
            input_preview: Some("{\"path\":\"README.md\"}".to_string()),
            tool_input: None,
            plan: None,
        }],
        round_index: 2,
        items: Some(vec![ChatMessageItem {
            item_type: "tool".to_string(),
            steering_id: None,
            round_index: None,
            content: None,
            tool: None,
            is_subagent: None,
        }]),
    };

    let poll = serde_json::to_value(RemoteResponse::SessionPoll {
        version: 8,
        changed: true,
        session_state: Some("running".to_string()),
        title: Some("session title".to_string()),
        new_messages: None,
        total_msg_count: None,
        message_snapshot: None,
        active_turn: Some(active_turn),
        model_catalog: Box::new(Some(sample_remote_model_catalog(11))),
    })
    .expect("serialize poll response");

    assert_eq!(poll["resp"], "session_poll");
    assert_eq!(poll["version"], 8);
    assert_eq!(poll["active_turn"]["turn_id"], "turn-1");
    assert_eq!(
        poll["active_turn"]["tools"][0]["input_preview"],
        "{\"path\":\"README.md\"}"
    );
    assert_eq!(poll["model_catalog"]["version"], 11);
    assert_eq!(
        poll["model_catalog"]["default_models"]["primary"],
        "model-1"
    );
    assert!(poll.get("new_messages").is_none());

    let sent = serde_json::to_value(RemoteResponse::MessageSent {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
    })
    .expect("serialize sent response");
    assert_eq!(sent["resp"], "message_sent");
    assert_eq!(sent["turn_id"], "turn-1");

    let title_updated = serde_json::to_value(RemoteResponse::SessionTitleUpdated {
        session_id: "session-1".to_string(),
        title: "Renamed session".to_string(),
    })
    .expect("serialize title response");
    assert_eq!(title_updated["resp"], "session_title_updated");
    assert_eq!(title_updated["title"], "Renamed session");
}

fn sample_remote_model_catalog(version: u64) -> RemoteModelCatalog {
    RemoteModelCatalog {
        version,
        models: vec![RemoteModelConfig {
            id: "model-1".to_string(),
            name: "Model One".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            model_name: "gpt-test".to_string(),
            context_window: Some(128_000),
            enabled: true,
            capabilities: vec!["text_chat".to_string()],
            reasoning: None,
        }],
        provider_catalog: Default::default(),
        models_dev_reasoning_catalog: None,
        default_models: RemoteDefaultModelsConfig {
            primary: Some("model-1".to_string()),
            ..RemoteDefaultModelsConfig::default()
        },
        reasoning_preset_selection_supported: true,
        session_model_id: Some("model-1".to_string()),
        session_reasoning_preset: None,
    }
}

#[test]
fn remote_connect_model_catalog_builder_preserves_config_shape() {
    let catalog = build_remote_model_catalog(RemoteModelCatalogFacts {
        last_modified_ms: -7,
        source_version: Some(7),
        models: vec![RemoteModelFacts {
            id: "model-1".to_string(),
            name: "Model One".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.example.com".to_string(),
            model_name: "gpt-test".to_string(),
            context_window: Some(128_000),
            enabled: true,
            capabilities: vec![
                RemoteModelCapabilityFact::TextChat,
                RemoteModelCapabilityFact::ImageUnderstanding,
                RemoteModelCapabilityFact::FunctionCalling,
            ],
            reasoning: Some(ReasoningCatalogProjection {
                status: ReasoningCapabilityStatus::Known,
                default_preset: Some("high".to_string()),
                presets: vec![ReasoningPresetDescriptor {
                    id: "high".to_string(),
                    label: "High".to_string(),
                    order: 10,
                    actions: vec![ReasoningPresetAction::Effort {
                        value: "high".to_string(),
                    }],
                    source: ReasoningPresetSource::ModelsDev,
                    execution_provider: None,
                    execution_model: None,
                }],
                unavailable_presets: Vec::new(),
            }),
        }],
        provider_catalog: Default::default(),
        models_dev_reasoning_catalog: Some(ModelsDevReasoningCatalog {
            revision: "models-dev-revision".to_string(),
            source: ModelsDevCatalogSource::Cache,
            providers: vec![ModelsDevReasoningProvider {
                id: "github-copilot".to_string(),
                name: "GitHub Copilot".to_string(),
                models: vec![ModelsDevReasoningModel {
                    id: "gpt-5.1-codex".to_string(),
                    display_name: Some("GPT-5.1 Codex".to_string()),
                }],
            }],
        }),
        default_models: RemoteDefaultModelsConfig {
            primary: Some("model-1".to_string()),
            fast: Some("fast-model".to_string()),
            search: Some("search-model".to_string()),
            ..RemoteDefaultModelsConfig::default()
        },
        session_model_id: Some("session-model".to_string()),
        session_reasoning_preset: Some("high".to_string()),
    });

    assert!(catalog.reasoning_preset_selection_supported);
    assert_eq!(catalog.session_model_id.as_deref(), Some("session-model"));
    assert_eq!(catalog.session_reasoning_preset.as_deref(), Some("high"));
    assert_eq!(catalog.default_models.fast.as_deref(), Some("fast-model"));
    assert_eq!(
        catalog
            .models_dev_reasoning_catalog
            .as_ref()
            .expect("models.dev reasoning catalog")
            .providers[0]
            .id,
        "github-copilot"
    );
    let model = catalog.models.first().expect("model config");
    assert_eq!(model.id, "model-1");
    assert_eq!(model.context_window, Some(128_000));
    assert_eq!(
        model.capabilities,
        vec![
            "text_chat".to_string(),
            "image_understanding".to_string(),
            "function_calling".to_string(),
        ]
    );
    let reasoning = model.reasoning.as_ref().expect("reasoning projection");
    assert_eq!(reasoning.status, ReasoningCapabilityStatus::Known);
    assert_eq!(reasoning.default_preset.as_deref(), Some("high"));
    assert_eq!(reasoning.presets[0].id, "high");
}

#[test]
fn remote_model_catalog_version_fits_javascript_number_precision() {
    let catalog = build_remote_model_catalog(RemoteModelCatalogFacts {
        last_modified_ms: 0,
        source_version: Some(u64::MAX),
        models: Vec::new(),
        provider_catalog: Default::default(),
        models_dev_reasoning_catalog: None,
        default_models: RemoteDefaultModelsConfig::default(),
        session_model_id: None,
        session_reasoning_preset: None,
    });

    assert!(catalog.version <= (1_u64 << 53) - 1);
}

#[test]
fn remote_model_catalog_version_tracks_session_selection() {
    let facts = RemoteModelCatalogFacts {
        last_modified_ms: 42,
        source_version: Some(7),
        models: Vec::new(),
        provider_catalog: Default::default(),
        models_dev_reasoning_catalog: None,
        default_models: RemoteDefaultModelsConfig::default(),
        session_model_id: Some("model-1".to_string()),
        session_reasoning_preset: None,
    };
    let model_one = build_remote_model_catalog(facts.clone());
    let high = build_remote_model_catalog(RemoteModelCatalogFacts {
        session_reasoning_preset: Some("high".to_string()),
        ..facts.clone()
    });
    let model_two = build_remote_model_catalog(RemoteModelCatalogFacts {
        session_model_id: Some("model-2".to_string()),
        ..facts
    });

    assert_ne!(model_one.version, high.version);
    assert_ne!(model_one.version, model_two.version);
}

#[test]
fn remote_model_catalog_version_tracks_provider_catalog_revision() {
    let mut facts = RemoteModelCatalogFacts {
        last_modified_ms: 42,
        source_version: Some(7),
        models: Vec::new(),
        provider_catalog: Default::default(),
        models_dev_reasoning_catalog: None,
        default_models: RemoteDefaultModelsConfig::default(),
        session_model_id: None,
        session_reasoning_preset: None,
    };
    facts.provider_catalog.revision = "catalog-a".to_string();
    let catalog_a = build_remote_model_catalog(facts.clone());
    facts.provider_catalog.revision = "catalog-b".to_string();
    let catalog_b = build_remote_model_catalog(facts);

    assert_ne!(catalog_a.version, catalog_b.version);
}

#[derive(Default)]
struct RecordingTrackerHost {
    subscribed: Mutex<Vec<String>>,
    unsubscribed: Mutex<Vec<String>>,
    active_turn_id: Mutex<Option<String>>,
}

impl RecordingTrackerHost {
    fn with_active_turn(turn_id: impl Into<String>) -> Self {
        Self {
            active_turn_id: Mutex::new(Some(turn_id.into())),
            ..Self::default()
        }
    }
}

impl RemoteSessionTrackerHost for RecordingTrackerHost {
    fn subscribe_tracker(&self, session_id: &str, _tracker: Arc<RemoteSessionStateTracker>) {
        self.subscribed.lock().unwrap().push(session_id.to_string());
    }

    fn unsubscribe_tracker(&self, session_id: &str) {
        self.unsubscribed
            .lock()
            .unwrap()
            .push(session_id.to_string());
    }

    fn active_turn_id(&self, _session_id: &str) -> Option<String> {
        self.active_turn_id.lock().unwrap().clone()
    }
}

#[test]
fn remote_connect_tracker_registry_owns_lifecycle_without_core_state() {
    let registry = RemoteSessionTrackerRegistry::new();
    let host = RecordingTrackerHost::with_active_turn("turn-1");

    let tracker = registry.ensure_tracker_with_host("session-1", &host);
    assert_eq!(
        host.subscribed.lock().unwrap().as_slice(),
        &["session-1".to_string()]
    );
    assert_eq!(
        tracker
            .snapshot_active_turn()
            .expect("active turn seeded")
            .turn_id,
        "turn-1"
    );

    let reused = registry.ensure_tracker_with_host("session-1", &host);
    assert!(Arc::ptr_eq(&tracker, &reused));
    assert_eq!(host.subscribed.lock().unwrap().len(), 1);
    assert!(registry.get_tracker("session-1").is_some());

    let removed = registry.remove_tracker_with_host("session-1", &host);
    assert!(removed.is_some());
    assert!(registry.get_tracker("session-1").is_none());
    assert_eq!(
        host.unsubscribed.lock().unwrap().as_slice(),
        &["session-1".to_string()]
    );
}

#[test]
fn remote_connect_tracker_preserves_streaming_snapshot_contract() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::ModelRoundStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        round_group_id: None,
        round_index: 3,
        model_config_id: "model-config".to_string(),
        effective_model_name: "provider-model".to_string(),
    });
    tracker.handle_agentic_event(&AgenticEvent::ThinkingChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        content: "<thinking>plan".to_string(),
        reasoning_kind: None,
        is_end: false,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "answer".to_string(),
    });

    let snapshot = tracker
        .snapshot_active_turn()
        .expect("active turn snapshot");

    assert_eq!(tracker.session_state(), "running");
    assert_eq!(snapshot.turn_id, "turn-1");
    assert_eq!(snapshot.status, "active");
    assert_eq!(snapshot.round_index, 3);
    assert_eq!(snapshot.text, "");
    assert_eq!(snapshot.thinking, "");
    let items = snapshot.items.expect("ordered streaming items");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].item_type, "thinking");
    assert_eq!(items[0].content.as_deref(), Some("plan"));
    assert_eq!(items[1].item_type, "text");
    assert_eq!(items[1].content.as_deref(), Some("answer"));
}

#[test]
fn remote_connect_tracker_keeps_steering_between_assistant_text_segments() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());
    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "before".to_string(),
    });
    tracker.handle_agentic_event(&AgenticEvent::UserSteeringInjected {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_index: 1,
        steering_id: "steering-1".to_string(),
        content: "raw direction".to_string(),
        display_content: "New direction".to_string(),
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-2".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "after".to_string(),
    });

    let items = tracker
        .snapshot_active_turn()
        .expect("active turn")
        .items
        .expect("ordered items");
    assert_eq!(items.len(), 3);
    assert_eq!(items[0].content.as_deref(), Some("before"));
    assert_eq!(items[1].item_type, "user-steering");
    assert_eq!(items[1].steering_id.as_deref(), Some("steering-1"));
    assert_eq!(items[1].round_index, Some(1));
    assert_eq!(items[1].content.as_deref(), Some("New direction"));
    assert_eq!(items[2].content.as_deref(), Some("after"));
}

#[test]
fn remote_connect_tracker_keeps_subagent_items_out_of_parent_accumulators() {
    let tracker = RemoteSessionStateTracker::new("parent-session".to_string());

    tracker.initialize_active_turn("parent-turn".to_string());
    tracker.handle_agentic_event(&AgenticEvent::SubagentSessionLinked {
        session_id: "child-session".to_string(),
        subagent_dialog_turn_id: "child-turn".to_string(),
        parent_session_id: "parent-session".to_string(),
        parent_dialog_turn_id: "parent-turn".to_string(),
        parent_tool_call_id: "task-1".to_string(),
        agent_type: None,
        model_id: None,
        focused_review_display_label: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "child-session".to_string(),
        turn_id: "child-turn".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "child text".to_string(),
    });

    assert_eq!(tracker.accumulated_text(), "");
    let snapshot = tracker
        .snapshot_active_turn()
        .expect("active turn snapshot");
    let items = snapshot.items.expect("subagent item");
    assert_eq!(items[0].content.as_deref(), Some("child text"));
    assert_eq!(items[0].is_subagent, Some(true));
}

#[tokio::test]
async fn remote_connect_tracker_broadcasts_tool_and_turn_events() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());
    let mut events = tracker.subscribe();

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::ToolEvent {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        tool_event: ToolEventData::Started {
            identity: openbitfun_events::ToolEventIdentity::resolved(
                "tool-1",
                openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
                "AskUserQuestion",
            ),
            params: serde_json::json!({
                "tool_name": "AskUserQuestion",
                "args": { "questions": [] }
            }),
            timeout_seconds: None,
        },
    });
    tracker.handle_agentic_event(&AgenticEvent::DialogTurnCancelled {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
    });

    match events.recv().await.expect("tool started event") {
        TrackerEvent::ToolStarted {
            tool_id,
            tool_name,
            params,
        } => {
            assert_eq!(tool_id, "tool-1");
            assert_eq!(tool_name, "AskUserQuestion");
            assert_eq!(params, Some(serde_json::json!({ "questions": [] })));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    match events.recv().await.expect("turn cancelled event") {
        TrackerEvent::TurnCancelled { turn_id } => assert_eq!(turn_id, "turn-1"),
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn remote_connect_tracker_keeps_finished_turn_snapshot_until_persistence_finalizes() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "answer".to_string(),
    });
    tracker.mark_persistence_clean();

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnCompleted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        total_rounds: 1,
        total_tools: 0,
        duration_ms: 42,
        partial_recovery_reason: None,
        success: Some(true),
        finish_reason: Some("stop".to_string()),
        has_final_response: Some(true),
    });

    assert_eq!(tracker.session_state(), "idle");
    assert!(tracker.is_turn_finished());
    assert!(tracker.is_persistence_dirty());
    let snapshot = tracker
        .snapshot_active_turn()
        .expect("finished snapshot remains until persistence catches up");
    assert_eq!(snapshot.status, "completed");
    assert_eq!(snapshot.turn_id, "turn-1");

    tracker.finalize_completed_turn();
    assert!(tracker.snapshot_active_turn().is_none());
    assert_eq!(tracker.accumulated_text(), "");
}

#[test]
fn remote_connect_model_catalog_delta_preserves_poll_invalidation_policy() {
    let unchanged =
        remote_model_catalog_poll_delta(Some(sample_remote_model_catalog(11)), Some(11));
    assert!(!unchanged.changed);
    assert!(unchanged.catalog.is_none());

    let changed = remote_model_catalog_poll_delta(Some(sample_remote_model_catalog(12)), Some(11));
    assert!(changed.changed);
    assert_eq!(changed.catalog.expect("changed catalog").version, 12);

    let initial_catalog =
        remote_model_catalog_poll_delta(Some(sample_remote_model_catalog(13)), None);
    assert!(initial_catalog.changed);
    assert_eq!(
        initial_catalog.catalog.expect("initial catalog").version,
        13
    );

    let unavailable_after_known_version = remote_model_catalog_poll_delta(None, Some(11));
    assert!(unavailable_after_known_version.changed);
    assert!(unavailable_after_known_version.catalog.is_none());

    let unavailable_initial = remote_model_catalog_poll_delta(None, None);
    assert!(!unavailable_initial.changed);
    assert!(unavailable_initial.catalog.is_none());
}

#[test]
fn remote_connect_model_selection_policy_owns_alias_and_config_reference_rules() {
    assert_eq!(
        normalize_remote_session_model_id(None),
        Some("primary".to_string())
    );
    assert_eq!(
        normalize_remote_session_model_id(Some("  default  ")),
        Some("primary".to_string())
    );
    assert_eq!(
        normalize_remote_session_model_id(Some("  auto  ")),
        Some("primary".to_string())
    );
    assert_eq!(
        normalize_remote_session_model_id(Some(" model-1 ")),
        Some("model-1".to_string())
    );

    assert!(!remote_model_selection_needs_config("default"));
    assert!(!remote_model_selection_needs_config("primary"));
    assert!(!remote_model_selection_needs_config("fast"));
    assert!(!remote_model_selection_needs_config("auto"));
    assert!(remote_model_selection_needs_config("custom-alias"));

    assert_eq!(
        normalize_remote_model_selection("default", |_| None).unwrap(),
        "primary"
    );
    assert_eq!(
        normalize_remote_model_selection("primary", |_| None).unwrap(),
        "primary"
    );
    assert_eq!(
        normalize_remote_model_selection("custom-alias", |id| {
            (id == "custom-alias").then(|| "model-1".to_string())
        })
        .unwrap(),
        "model-1"
    );
    assert_eq!(
        normalize_remote_model_selection("auto", |_| None).unwrap(),
        "primary"
    );
    assert_eq!(
        normalize_remote_model_selection("unknown", |_| None).unwrap_err(),
        "Unknown model selection: unknown"
    );
    assert_eq!(
        normalize_remote_model_selection("   ", |_| None).unwrap_err(),
        "model_id is required"
    );
}

#[test]
fn remote_connect_poll_helpers_preserve_delta_and_completion_policy() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());

    assert!(!should_send_remote_model_catalog(
        Some(&sample_remote_model_catalog(11)),
        Some(11)
    ));
    assert!(should_send_remote_model_catalog(
        Some(&sample_remote_model_catalog(12)),
        Some(11)
    ));

    let no_change =
        serde_json::to_value(remote_no_change_poll_response(7)).expect("serialize no-change poll");
    assert_eq!(no_change["resp"], "session_poll");
    assert_eq!(no_change["changed"], false);
    assert!(no_change.get("active_turn").is_none());

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "answer".to_string(),
    });
    tracker.mark_persistence_clean();

    let snapshot = serde_json::to_value(remote_snapshot_poll_response(
        &tracker,
        tracker.version(),
        Some(sample_remote_model_catalog(13)),
    ))
    .expect("serialize snapshot poll");
    assert_eq!(snapshot["changed"], true);
    assert_eq!(snapshot["active_turn"]["turn_id"], "turn-1");
    assert!(snapshot.get("new_messages").is_none());
    assert_eq!(snapshot["model_catalog"]["version"], 13);

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnCompleted {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        total_rounds: 1,
        total_tools: 0,
        duration_ms: 42,
        partial_recovery_reason: None,
        success: Some(true),
        finish_reason: Some("stop".to_string()),
        has_final_response: Some(true),
    });

    let waiting_for_persistence = serde_json::to_value(remote_persisted_poll_response(
        &tracker,
        tracker.version(),
        Vec::new(),
        0,
        None,
        None,
    ))
    .expect("serialize completed poll without assistant message");
    assert!(waiting_for_persistence.get("new_messages").is_none());
    assert_eq!(
        waiting_for_persistence["active_turn"]["status"],
        "completed"
    );
    assert!(tracker.snapshot_active_turn().is_some());

    let assistant_message = ChatMessage {
        id: "msg-2".to_string(),
        role: "assistant".to_string(),
        content: "answer".to_string(),
        timestamp: "2".to_string(),
        metadata: None,
        turn_id: Some("turn-1".to_string()),
        status: Some("done".to_string()),
        error: None,
        tools: None,
        thinking: None,
        items: None,
        images: None,
    };
    let with_persisted_message = serde_json::to_value(remote_persisted_poll_response(
        &tracker,
        tracker.version(),
        vec![assistant_message],
        2,
        None,
        None,
    ))
    .expect("serialize completed poll with assistant message");
    assert_eq!(
        with_persisted_message["new_messages"][0]["role"],
        "assistant"
    );
    assert_eq!(with_persisted_message["total_msg_count"], 2);
    assert!(with_persisted_message.get("active_turn").is_none());
    assert!(tracker.snapshot_active_turn().is_none());
}

#[test]
fn remote_connect_tracker_ignores_unrelated_direct_session_events() {
    let tracker = RemoteSessionStateTracker::new("session-1".to_string());

    tracker.handle_agentic_event(&AgenticEvent::DialogTurnStarted {
        session_id: "session-2".to_string(),
        turn_id: "turn-2".to_string(),
        turn_index: 0,
        user_input: "hello".to_string(),
        original_user_input: None,
        user_message_metadata: None,
    });
    tracker.handle_agentic_event(&AgenticEvent::TextChunk {
        session_id: "session-2".to_string(),
        turn_id: "turn-2".to_string(),
        round_id: "round-1".to_string(),
        attempt_id: None,
        attempt_index: None,
        text: "other answer".to_string(),
    });

    assert_eq!(tracker.version(), 0);
    assert_eq!(tracker.session_state(), "idle");
    assert!(tracker.snapshot_active_turn().is_none());
    assert_eq!(tracker.accumulated_text(), "");
}

#[test]
fn remote_connect_tool_preview_slimming_keeps_short_fields_and_drops_large_strings() {
    let preview = make_slim_tool_params(&serde_json::json!({
        "path": "README.md",
        "content": "x".repeat(201),
        "line": 12
    }))
    .expect("object preview");
    let preview_json: serde_json::Value =
        serde_json::from_str(&preview).expect("preview remains json object");

    assert_eq!(preview_json["path"], "README.md");
    assert_eq!(preview_json["line"], 12);
    assert!(preview_json.get("content").is_none());

    let long_text = "a".repeat(260);
    let text_preview =
        make_slim_tool_params(&serde_json::Value::String(long_text)).expect("string preview");
    assert_eq!(text_preview.len(), 200);

    assert!(make_slim_tool_params(&serde_json::json!(42)).is_none());
}

#[test]
fn control_ping_accepts_legacy_and_additive_client_identity() {
    use openbitfun_services_integrations::remote_connect::RemoteCommand;
    let legacy = serde_json::json!({ "cmd": "ping" });
    let old: RemoteCommand = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(old, RemoteCommand::Ping { client: None });
    assert_eq!(serde_json::to_value(old).unwrap(), legacy);
    let current =
        serde_json::json!({ "cmd": "ping", "client": { "id": "page-1", "name": "Safari · iOS" } });
    let decoded: RemoteCommand = serde_json::from_value(current.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), current);
    // Previous hosts use an internally tagged unit variant and ignore additive fields.
    #[derive(serde::Deserialize)]
    #[serde(tag = "cmd", rename_all = "snake_case")]
    enum LegacyCommand {
        Ping,
    }
    assert!(matches!(
        serde_json::from_value::<LegacyCommand>(current).unwrap(),
        LegacyCommand::Ping
    ));
}

#[test]
fn file_chunk_revision_is_additive_for_legacy_peers() {
    let legacy = serde_json::json!({"resp":"file_chunk","name":"a.png","chunk_base64":"AQ==",
        "offset":0,"chunk_size":1,"total_size":1,"mime_type":"image/png"});
    let response: RemoteResponse = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), legacy);
    let mut current = legacy;
    current["revision"] = serde_json::json!("1:123");
    let response: RemoteResponse = serde_json::from_value(current.clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), current);
}
