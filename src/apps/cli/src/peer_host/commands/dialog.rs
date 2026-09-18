//! Dialog HostInvoke handlers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use openbitfun_agent_runtime::sdk::AgentUserAnswersRequest;
use openbitfun_runtime_ports::{
    AgentDialogTurnRequest, AgentInputAttachment, AgentSubmissionSource,
    AgentTurnCancellationRequest, DialogSubmissionPolicy, DialogTriggerSource,
};

use crate::peer_host::args::{get_string, optional_string, request_value};
use crate::peer_host::state::{PeerHostState, PeerTurnKey};

/// How long a settled submission stays replayable. The controller's own
/// bounded retry window is far shorter; this only has to outlive it.
const DIALOG_SUBMISSION_TTL: Duration = Duration::from_secs(120);
const MAX_CACHED_DIALOG_SUBMISSIONS: usize = 128;

type DialogSubmissionOutcome = Arc<AsyncMutex<Option<Result<Value, String>>>>;

struct CachedDialogSubmission {
    expires_at: Instant,
    outcome: DialogSubmissionOutcome,
}

fn dialog_submissions() -> &'static Mutex<HashMap<String, CachedDialogSubmission>> {
    static DIALOG_SUBMISSIONS: OnceLock<Mutex<HashMap<String, CachedDialogSubmission>>> =
        OnceLock::new();
    DIALOG_SUBMISSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reserve the slot that records the outcome of one `(sessionId, turnId)`
/// submission.
///
/// A Relay timeout leaves the controller unable to tell "never arrived" from
/// "already running". Holding the outcome behind a per-identity async lock
/// makes a replay wait for the original attempt and then observe its result,
/// instead of starting the prompt a second time. Desktop Peer Hosts get this
/// from the webview bridge's idempotency cache; a CLI Host has no webview, so
/// it owns the same contract here.
fn dialog_submission_slot(
    session_id: &str,
    turn_id: &str,
) -> Result<DialogSubmissionOutcome, String> {
    let mut submissions = dialog_submissions()
        .lock()
        .map_err(|_| "Peer dialog submission cache is unavailable".to_string())?;
    let now = Instant::now();
    submissions.retain(|_, entry| entry.expires_at > now);
    while submissions.len() >= MAX_CACHED_DIALOG_SUBMISSIONS {
        let Some(oldest) = submissions
            .iter()
            .min_by_key(|(_, entry)| entry.expires_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        submissions.remove(&oldest);
    }
    Ok(submissions
        .entry(format!("{session_id}:{turn_id}"))
        .or_insert_with(|| CachedDialogSubmission {
            expires_at: now + DIALOG_SUBMISSION_TTL,
            outcome: Arc::new(AsyncMutex::new(None)),
        })
        .outcome
        .clone())
}

fn peer_dialog_metadata(request: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let mut metadata = match request.get("userMessageMetadata") {
        Some(Value::Object(metadata)) => metadata.clone(),
        Some(Value::Null) | None => serde_json::Map::new(),
        Some(_) => return Err("userMessageMetadata must be an object".to_string()),
    };
    for reserved_key in [
        "acp_transport",
        "backgroundTaskId",
        "parentSessionId",
        "parentDialogTurnId",
        "subagentSessionId",
        "subagentDialogTurnId",
        "require_tool_confirmation",
    ] {
        metadata.remove(reserved_key);
    }
    Ok(metadata)
}

fn peer_image_attachments(request: &Value) -> Result<Vec<AgentInputAttachment>, String> {
    let images = match request.get("imageContexts") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(value) => serde_json::from_value::<
            Vec<openbitfun_core::agentic::image_analysis::ImageContextData>,
        >(value.clone())
        .map_err(|error| format!("Invalid imageContexts: {error}"))?,
    };
    images
        .into_iter()
        .map(|image| {
            if image.data_url.as_deref().is_none_or(str::is_empty)
                && image.image_path.as_deref().is_none_or(str::is_empty)
            {
                return Err("An image attachment requires data_url or image_path".to_string());
            }
            let mut metadata = serde_json::Map::new();
            if let Some(path) = image.image_path {
                metadata.insert("imagePath".into(), json!(path));
            }
            if let Some(data) = image.data_url {
                metadata.insert("dataUrl".into(), json!(data));
            }
            metadata.insert("mimeType".into(), json!(image.mime_type));
            if let Some(details) = image.metadata {
                metadata.insert("metadata".into(), details);
            }
            Ok(AgentInputAttachment {
                kind: "remote_image".into(),
                id: image.id,
                metadata,
            })
        })
        .collect()
}

pub(crate) async fn start_dialog_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    // Only a client-supplied turn id gives the submission a stable identity.
    // Without one there is nothing to deduplicate against — and the controller
    // stays single-shot for exactly that reason.
    let Some(turn_id) = optional_string(request, "turnId") else {
        return submit_dialog_turn(state, args).await;
    };
    let outcome_slot = dialog_submission_slot(&session_id, &turn_id)?;
    let mut outcome = outcome_slot.lock().await;
    if let Some(settled) = outcome.as_ref() {
        return settled.clone();
    }
    let result = submit_dialog_turn(state, args).await;
    *outcome = Some(result.clone());
    result
}

async fn submit_dialog_turn(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let user_input = get_string(request, "userInput")?;
    let original_user_input = optional_string(request, "originalUserInput");
    let agent_type = get_string(request, "agentType")?;
    // The session's workspace ID is authoritative; the project/workspace paths
    // are the legacy storage projection for pre-ID controllers.
    let workspace_id = optional_string(request, "workspaceId")
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let workspace_path = optional_string(request, "projectWorkspacePath")
        .or_else(|| optional_string(request, "workspacePath"));
    let remote_connection_id = optional_string(request, "remoteConnectionId");
    let remote_ssh_host = optional_string(request, "remoteSshHost");
    let turn_id =
        optional_string(request, "turnId").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let metadata = peer_dialog_metadata(request)?;
    let attachments = peer_image_attachments(request)?;
    let turn = PeerTurnKey::new(session_id.clone(), turn_id.clone());
    let stream_generation = state.turns.register_root(turn.clone())?;
    // Controller presence is not an admission requirement. This host owns and
    // keeps executing the Turn whether or not a controller is watching, exactly
    // like a Turn submitted in its own TUI; a controller that leaves and comes
    // back re-attaches to the same Runtime projection. Only this host's own
    // event-stream continuity still gates submission, because a Turn nobody can
    // observe is a Turn nobody can attach to.
    if !state
        .turns
        .is_event_stream_generation_current(stream_generation)
    {
        state.turns.finish_turn(&turn);
        return Err("Peer event stream continuity was lost before dialog submission".to_string());
    }

    let policy = DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi);
    let submit_result = state
        .agent_runtime
        .submit_dialog_turn(AgentDialogTurnRequest {
            session_id: session_id.clone(),
            message: user_input,
            output_schema: None,
            original_message: original_user_input,
            turn_id: Some(turn_id.clone()),
            execution: Default::default(),
            agent_type,
            workspace_path,
            workspace_id,
            remote_connection_id,
            remote_ssh_host,
            policy,
            reply_route: None,
            prepended_reminders: Vec::new(),
            attachments,
            metadata,
        })
        .await;
    if let Err(error) = submit_result {
        state.turns.finish_turn(&turn);
        return Err(format!(
            "Failed to start dialog turn: {}",
            error.into_message()
        ));
    }
    if !state
        .turns
        .is_event_stream_generation_current(stream_generation)
    {
        let cancellation = state
            .agent_runtime
            .cancel_turn(AgentTurnCancellationRequest {
                session_id: session_id.clone(),
                turn_id: Some(turn_id.clone()),
                source: Some(AgentSubmissionSource::Cli),
                requester_session_id: None,
                reason: Some("Peer event stream lost continuity".to_string()),
                wait_timeout_ms: Some(1_500),
                cancel_descendants: true,
            })
            .await;
        if let Err(error) = cancellation {
            let error = error.into_message();
            return Err(format!(
                "Peer continuity was lost after dialog submission and cancellation could not be confirmed: session_id={session_id}, turn_id={turn_id}, error={error}"
            ));
        }
        return Err("Peer event stream lost continuity while starting the dialog turn".to_string());
    }

    Ok(json!({ "success": true, "message": "Dialog turn started" }))
}

pub(crate) async fn cancel_dialog_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let dialog_turn_id = get_string(request, "dialogTurnId")?;
    // Cancellation follows visibility: a controller renders every Turn in the
    // Session, including ones this host started, so it must be able to stop
    // them. A Desktop Peer Host reaches the same handler the local UI does and
    // has never had an ownership gate here.
    state
        .agent_runtime
        .cancel_turn(AgentTurnCancellationRequest {
            session_id,
            turn_id: Some(dialog_turn_id),
            source: Some(AgentSubmissionSource::Cli),
            requester_session_id: None,
            reason: Some("Peer controller requested cancellation".to_string()),
            wait_timeout_ms: Some(1_500),
            cancel_descendants: true,
        })
        .await
        .map_err(|error| format!("Failed to cancel dialog turn: {}", error.into_message()))?;
    Ok(json!({ "success": true }))
}

/// Cancel a single running tool execution on this host.
///
/// The controller renders Terminal cards for Turns this host owns, including
/// the Interrupt button. Without this handler the `cancel_tool` HostInvoke
/// command fell into the unsupported dispatch branch: the controller restored
/// the button and logged an error while the target command kept running here.
/// This reaches the Core-owned coordinator via the same compatibility surface
/// the Desktop `cancel_tool` Tauri command uses — one level finer than
/// `cancel_dialog_turn`.
pub(crate) async fn cancel_tool(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let tool_use_id = get_string(request, "toolUseId")?;
    let reason = optional_string(request, "reason").unwrap_or_else(|| "User cancelled".to_string());
    state
        .compatibility
        .cancel_tool(&tool_use_id, reason)
        .await?;
    Ok(json!({ "success": true }))
}

fn parse_user_answer_submission(
    args: &Value,
) -> Result<(Option<String>, AgentUserAnswersRequest), String> {
    let request = request_value(args);
    let session_id = optional_string(request, "sessionId");
    let tool_id = get_string(request, "toolId")?;
    let answers = request
        .get("answers")
        .cloned()
        .ok_or_else(|| "Missing 'answers' field".to_string())?;
    Ok((session_id, AgentUserAnswersRequest { tool_id, answers }))
}

/// Deliver an answer to the Runtime-owned AskUserQuestion mailbox.
///
/// Restoring a Peer session already exposes the pending question snapshot. The
/// response must terminate on the same host as the waiting Tool future; before
/// this handler existed a CLI peer could render that snapshot but every click
/// fell through to the unsupported-command branch.
pub(crate) async fn start_user_question_interaction(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = args.get("request").ok_or("Missing request")?;
    let session_id = get_string(request, "sessionId")?;
    let tool_id = get_string(request, "toolId")?;
    state
        .agent_runtime
        .start_user_question_interaction(&session_id, &tool_id)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

pub(crate) async fn submit_user_answers(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let (session_id, submission) = parse_user_answer_submission(args)?;
    let tool_id = submission.tool_id.clone();

    if let Some(session_id) = session_id.as_deref() {
        // Tool ids are process-wide, but current controllers scope the Peer
        // request to a Session. Keep a stale card from one Session from
        // answering an interaction rendered from another Session; the Runtime
        // remains the final arbiter for concurrent answers after this check.
        let interaction_snapshot = state.agent_runtime.session_interaction_snapshot(session_id);
        if !interaction_snapshot
            .user_questions
            .questions
            .iter()
            .any(|question| question.tool_id == tool_id)
        {
            return Err(format!(
                "No pending user question '{tool_id}' exists for session '{session_id}'"
            ));
        }
    }

    // Legacy controllers did not send `sessionId`. Keep their process-wide
    // Tool-id path working against this newer host, matching Desktop's
    // long-standing command shape; the Runtime still consumes each answer at
    // most once.
    state
        .agent_runtime
        .submit_user_answers(submission)
        .await
        .map_err(|error| {
            format!(
                "Failed to submit user answers for tool '{tool_id}': {}",
                error.into_message()
            )
        })?;

    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{dialog_submission_slot, parse_user_answer_submission, peer_dialog_metadata};

    #[test]
    fn user_answer_submission_accepts_legacy_and_session_scoped_payloads() {
        let (legacy_session, legacy) = parse_user_answer_submission(&json!({
            "toolId": "ask-legacy",
            "answers": { "0": "Yes" }
        }))
        .expect("legacy answer payload");
        assert_eq!(legacy_session, None);
        assert_eq!(legacy.tool_id, "ask-legacy");
        assert_eq!(legacy.answers, json!({ "0": "Yes" }));

        let (session, current) = parse_user_answer_submission(&json!({
            "request": {
                "sessionId": "session-1",
                "toolId": "ask-current",
                "answers": { "0": ["A", "B"] }
            }
        }))
        .expect("session-scoped answer payload");
        assert_eq!(session.as_deref(), Some("session-1"));
        assert_eq!(current.tool_id, "ask-current");
        assert_eq!(current.answers, json!({ "0": ["A", "B"] }));
    }

    #[test]
    fn peer_metadata_removes_reserved_runtime_fields() {
        let metadata = peer_dialog_metadata(&json!({
            "userMessageMetadata": {
                "acp_transport": true,
                "kind": "background_result",
                "sourceKind": "subagent",
                "backgroundTaskId": "background-task",
                "parentSessionId": "parent-session",
                "parentDialogTurnId": "parent-turn",
                "subagentSessionId": "subagent-session",
                "subagentDialogTurnId": "subagent-turn",
                "require_tool_confirmation": false,
                "caller": "desktop",
            }
        }))
        .expect("metadata");

        assert!(!metadata.contains_key("require_tool_confirmation"));
        assert!(!metadata.contains_key("acp_transport"));
        for reserved_key in [
            "backgroundTaskId",
            "parentSessionId",
            "parentDialogTurnId",
            "subagentSessionId",
            "subagentDialogTurnId",
        ] {
            assert!(!metadata.contains_key(reserved_key));
        }
        assert_eq!(metadata.get("kind"), Some(&json!("background_result")));
        assert_eq!(metadata.get("sourceKind"), Some(&json!("subagent")));
        assert_eq!(metadata.get("caller"), Some(&json!("desktop")));
    }

    #[test]
    fn peer_metadata_preserves_non_lineage_classification() {
        let metadata = peer_dialog_metadata(&json!({
            "userMessageMetadata": {
                "kind": "manual_compaction",
                "sourceKind": "user",
            }
        }))
        .expect("metadata");

        assert_eq!(metadata.get("kind"), Some(&json!("manual_compaction")));
        assert_eq!(metadata.get("sourceKind"), Some(&json!("user")));
    }

    #[tokio::test]
    async fn a_replayed_submission_observes_the_first_attempt_instead_of_running_twice() {
        let first = dialog_submission_slot("session-1", "turn-1").expect("first slot");
        let mut outcome = first.lock().await;
        assert!(outcome.is_none(), "a fresh identity has nothing to replay");
        *outcome = Some(Ok(json!({ "success": true })));
        drop(outcome);

        // The Relay timed out, so the controller replays the exact payload. It
        // must observe the recorded outcome, not submit the prompt again.
        let replay = dialog_submission_slot("session-1", "turn-1").expect("replay slot");
        assert_eq!(
            replay.lock().await.clone(),
            Some(Ok(json!({ "success": true }))),
        );

        // A different turn in the same Session is a different submission.
        let other_turn = dialog_submission_slot("session-1", "turn-2").expect("other turn slot");
        assert!(other_turn.lock().await.is_none());

        // As is the same turn id under a different Session.
        let other_session =
            dialog_submission_slot("session-2", "turn-1").expect("other session slot");
        assert!(other_session.lock().await.is_none());
    }
}

#[cfg(test)]
mod image_attachment_tests {
    use super::*;

    #[test]
    fn peer_image_attachments_preserve_inline_pixels_paths_and_legacy_text_requests() {
        for request in [
            json!({}),
            json!({"imageContexts": null}),
            json!({"imageContexts": []}),
        ] {
            assert!(peer_image_attachments(&request).unwrap().is_empty());
        }
        let request = json!({"imageContexts": [{
            "id": "phone-image", "data_url": "data:image/png;base64,cGl4ZWxz",
            "image_path": "/controller/image.png", "mime_type": "image/png",
            "metadata": {"name": "screenshot.png"}
        }]});
        let attachments = peer_image_attachments(&request).unwrap();
        let restored: Vec<AgentInputAttachment> =
            serde_json::from_value(serde_json::to_value(&attachments).unwrap()).unwrap();
        assert_eq!(restored[0].kind, "remote_image");
        assert_eq!(
            restored[0].metadata["dataUrl"],
            request["imageContexts"][0]["data_url"]
        );
        assert_eq!(restored[0].metadata["imagePath"], "/controller/image.png");
        assert_eq!(restored[0].metadata["metadata"]["name"], "screenshot.png");
        assert!(peer_image_attachments(&json!({"imageContexts": [{}]})).is_err());
        assert!(peer_image_attachments(&json!({"imageContexts": "bad"})).is_err());
    }
}
