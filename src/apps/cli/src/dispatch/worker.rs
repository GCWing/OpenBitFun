use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use openbitfun_agent_runtime::sdk::{
    AgentDialogSteerRequest, AgentDialogTurnRequest, AgentSessionCreateRequest,
    AgentSessionModelSelection, AgentSessionModelSelectionUpdateRequest,
    AgentSessionRestoreRequest, AgentTurnCancellationRequest, AgentTurnSettlementRequest,
    PermissionReply, PermissionReplySource, PermissionRequest, PermissionRequestEvent,
};
use openbitfun_events::{project_agentic_frontend_event, AgenticEvent};
use openbitfun_runtime_ports::{
    AgentSubmissionSource, DialogSubmissionPolicy, SessionExecutionTarget,
};

use crate::{shutdown_mcp_servers, BootstrapProfile};

use super::permissions::{self, REJECT_AND_REPORT_REASON};
use super::protocol::{DispatchApprovalPolicy, DispatchEvent, DispatchJobState, DispatchTurnKind};
use super::store::{DispatchStore, WorkspaceLock};

const TURN_SETTLEMENT_TIMEOUT_MS: u64 = 5_000;

pub(crate) async fn run(job_id: String) -> Result<()> {
    let store = DispatchStore::open_default()?;
    let Some(_worker_lease) = store.try_acquire_worker_lease(&job_id)? else {
        // A retry may briefly spawn a duplicate after its controller crashes.
        // Only the lease holder may publish a PID or execute the job.
        return Ok(());
    };
    let worker_pid = std::process::id();
    store.write_pid(&job_id, worker_pid)?;
    store.clear_preparing(&job_id);
    let result = run_inner(&store, &job_id).await;
    if let Err(error) = &result {
        let _ = store.mark_state(
            &job_id,
            DispatchJobState::Failed,
            None,
            Some(format!("{error:#}")),
        );
    }
    store.clear_pending_permissions(&job_id);
    store.clear_preparing(&job_id);
    store.remove_pid_if_matches(&job_id, worker_pid);
    shutdown_mcp_servers().await;
    result
}

async fn run_inner(store: &DispatchStore, job_id: &str) -> Result<()> {
    let job = store.load_job(job_id)?;
    let state = store.load_state(job_id)?;
    if state.state.is_terminal() {
        return Ok(());
    }
    if state.cancel_requested() {
        store.mark_state(
            job_id,
            DispatchJobState::Cancelled,
            state.turn_id.as_deref(),
            Some("Dispatch worker observed a cancellation request".to_string()),
        )?;
        return Ok(());
    }
    if state.turn_id.is_some() {
        bail!(
            "dispatch worker cannot replay an already-submitted turn after process loss; session {} remains available on the target",
            job.request.session_id
        );
    }

    let workspace = Path::new(&job.request.workspace_path);
    if !workspace.is_absolute() {
        bail!("dispatch workspacePath must be absolute");
    }
    if !workspace.is_dir() {
        bail!(
            "dispatch workspace does not exist or is not a directory: {}",
            workspace.display()
        );
    }
    // Per-turn overrides are read before runtime bootstrap because the
    // approval policy is baked into initialize_core_services. Nothing can
    // enqueue another turn between this peek and the claim below: queueing
    // requires a terminal state and the job is already non-terminal here.
    let pending_turn = store.peek_follow_up_turn(job_id)?;
    let effective_model = pending_turn
        .as_ref()
        .and_then(|turn| turn.model.clone())
        .or_else(|| job.request.model.clone());
    let effective_reasoning_preset = pending_turn
        .as_ref()
        .and_then(|turn| turn.reasoning_preset.clone())
        .or_else(|| job.request.reasoning_preset.clone());
    let effective_policy = pending_turn
        .as_ref()
        .and_then(|turn| turn.approval_policy)
        .unwrap_or(job.request.approval_policy);
    super::ensure_selected_model_ready(effective_model.as_deref()).await?;
    if let Some(model) = effective_model.as_deref() {
        super::validate_reasoning_preset(model, effective_reasoning_preset.as_deref()).await?;
    }

    // Every detached worker takes the same stable lock for a canonical target
    // workspace. Waiting workers remain Queued and are visible/cancellable.
    let lock_path = store.workspace_lock_path(&job.request.workspace_path);
    let _workspace_lock = WorkspaceLock::acquire(&lock_path)?;
    let state = store.load_state(job_id)?;
    if state.state.is_terminal() {
        return Ok(());
    }
    if state.cancel_requested() {
        store.mark_state(
            job_id,
            DispatchJobState::Cancelled,
            state.turn_id.as_deref(),
            Some("Dispatch worker observed a cancellation request".to_string()),
        )?;
        return Ok(());
    }
    store.mark_state(job_id, DispatchJobState::Running, None, None)?;

    // Persist the effective options before execution so `list`/`status` and
    // any replacement worker observe the same choices this turn runs with.
    let (model_changed, _, policy_changed) = store.update_job_request_options(
        job_id,
        effective_model.as_deref(),
        effective_reasoning_preset.as_deref(),
        effective_policy,
    )?;
    if policy_changed {
        store.append_event(
            job_id,
            &DispatchEvent::approval_policy_selected(effective_policy),
        )?;
    }
    if model_changed {
        store.append_event(
            job_id,
            &DispatchEvent::model_selected(effective_model.as_deref()),
        )?;
    }

    let runtime = crate::initialize_core_services(
        workspace,
        permissions::cli_policy(effective_policy),
        BootstrapProfile::Execution,
    )
    .await?;
    let agent_runtime = runtime.agent_runtime().clone();
    let compatibility = runtime.compatibility().clone();
    let mut event_rx = agent_runtime
        .subscribe_events()
        .map_err(|error| anyhow!(error.into_message()))?;
    let mut permission_rx = agent_runtime
        .subscribe_permission_requests()
        .map_err(|error| anyhow!(error.into_message()))?;

    let workspace_path = job.request.workspace_path.clone();
    // A follow-up turn runs against the session the previous turn built, so its
    // history is the agent's context. Restoring first is what makes a dispatch
    // session a conversation; creating unconditionally would fail on the second
    // turn because the persisted id already exists.
    let restore_error = agent_runtime
        .restore_session(AgentSessionRestoreRequest {
            workspace_id: Some(runtime.workspace().id.clone()),
            workspace_path: String::new(),
            session_id: job.request.session_id.clone(),
            include_internal: false,
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .err();
    if let Some(error) = restore_error.as_ref() {
        // Expected on the first turn — there is nothing to restore yet.
        tracing::debug!("Dispatch session restore did not apply: {error}");
    }
    if restore_error.is_some() {
        agent_runtime
            .create_session_with_id(
                job.request.session_id.clone(),
                AgentSessionCreateRequest {
                    session_name: job.title.clone(),
                    agent_type: job.request.agent_type.clone(),
                    agent_route_key: None,
                    workspace_path: Some(workspace_path.clone()),
                    project_workspace_path: Some(workspace_path.clone()),
                    execution_target: Some(SessionExecutionTarget::local(workspace_path.clone())),
                    workspace_id: Some(runtime.workspace().id.clone()),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    model_id: effective_model.clone(),
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .map_err(|error| anyhow!(error.into_message()))
            // A follow-up turn reaches this only when its restore failed, and
            // creating then fails on the existing persisted id. Carry the
            // restore error so the report names the real cause instead of the
            // "already exists" symptom.
            .with_context(|| match restore_error {
                Some(restore) => {
                    format!("create target-owned dispatch session after restore failed: {restore}")
                }
                None => "create target-owned dispatch session".to_string(),
            })?;
    }
    if let Some(model) = effective_model.clone() {
        let reasoning_preset = effective_reasoning_preset
            .as_deref()
            .filter(|preset| *preset != "auto")
            .map(str::to_string);
        agent_runtime
            .update_session_model_selection(AgentSessionModelSelectionUpdateRequest {
                session_id: job.request.session_id.clone(),
                selection: AgentSessionModelSelection {
                    model_id: model,
                    reasoning_preset,
                },
            })
            .await
            .map_err(|error| anyhow!(error.into_message()))
            .context("apply dispatch turn model and reasoning preset")?;
    }

    let turn_id = uuid::Uuid::new_v4().to_string();
    // Claim the queued follow-up and persist the turn id in one step. A crash
    // after the Runtime accepts the turn must never make a replacement worker
    // submit the prompt a second time.
    let follow_up = store.claim_follow_up_turn(job_id, &turn_id)?;
    let turn_kind = follow_up.as_ref().map(|turn| turn.kind).unwrap_or_default();
    match turn_kind {
        DispatchTurnKind::Prompt => {
            let prompt = follow_up
                .as_ref()
                .map(|turn| turn.prompt.clone())
                .unwrap_or_else(|| job.request.prompt.clone());
            let turn_attachments = follow_up
                .as_ref()
                .map(|turn| runtime_attachments(&turn.attachments))
                .unwrap_or_else(|| runtime_attachments(&job.request.attachments));
            agent_runtime
                .submit_dialog_turn(AgentDialogTurnRequest {
                    session_id: job.request.session_id.clone(),
                    message: prompt,
                    output_schema: None,
                    original_message: None,
                    turn_id: Some(turn_id.clone()),
                    execution: Default::default(),
                    agent_type: job.request.agent_type.clone(),
                    workspace_path: Some(workspace_path),
                    workspace_id: Some(runtime.workspace().id.clone()),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                    policy: DialogSubmissionPolicy::for_source(AgentSubmissionSource::Cli),
                    reply_route: None,
                    prepended_reminders: Vec::new(),
                    attachments: turn_attachments,
                    metadata: permissions::metadata(effective_policy),
                })
                .await
                .map_err(|error| anyhow!(error.into_message()))
                .context("submit dispatch dialog turn")?;
        }
        DispatchTurnKind::Compact => {
            // The compaction runs as a turn with this worker's turn id, so
            // its DialogTurn/ContextCompression events flow through the same
            // event loop and settle the job like any other turn.
            compatibility
                .start_manual_compaction(job.request.session_id.clone(), turn_id.clone())
                .await
                .map_err(anyhow::Error::msg)
                .context("start dispatch manual compaction")?;
        }
    }

    let mut event_scope = JobEventScope::new(job.request.session_id.clone(), turn_id.clone());
    let mut initial_permissions = agent_runtime
        .pending_permission_requests()
        .unwrap_or_default()
        .into_iter()
        .collect::<VecDeque<_>>();
    let mut handled_permissions = HashSet::new();
    let mut mailbox_tick = tokio::time::interval(Duration::from_millis(200));
    mailbox_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let (terminal_state, terminal_error) = loop {
        if let Some(request) = initial_permissions.pop_front() {
            if event_scope.permission_targets_job(&request)
                && handled_permissions.insert(request.request_id.clone())
            {
                if let Some(reason) = handle_permission(
                    store,
                    job_id,
                    &agent_runtime,
                    &job.request.session_id,
                    &turn_id,
                    request,
                    effective_policy,
                )
                .await?
                {
                    break (DispatchJobState::Failed, Some(reason));
                }
            }
            continue;
        }

        tokio::select! {
            received = event_rx.recv() => {
                let envelope = match received {
                    Ok(envelope) => envelope,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        cancel_turn(&agent_runtime, &job.request.session_id, &turn_id, "dispatch_event_stream_lagged").await;
                        break (
                            DispatchJobState::Failed,
                            Some(format!("dispatch event stream lost {skipped} events; the turn was cancelled")),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        cancel_turn(&agent_runtime, &job.request.session_id, &turn_id, "dispatch_event_stream_closed").await;
                        break (
                            DispatchJobState::Failed,
                            Some("dispatch event stream closed before the turn settled".to_string()),
                        );
                    }
                };
                if !event_scope.admit(&envelope.event) {
                    continue;
                }
                let projection = project_agentic_frontend_event(envelope.event.clone())
                    .map(|projected| (projected.event_name, projected.payload));
                let raw = serde_json::to_value(&envelope)
                    .context("serialize dispatch Agent event")?;
                store.append_event(
                    job_id,
                    &DispatchEvent::agent_event(raw, projection),
                )?;
                if let Some(outcome) = terminal_outcome(&envelope.event, &turn_id) {
                    break outcome;
                }
            }
            received = permission_rx.recv() => {
                let event = match received {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        cancel_turn(&agent_runtime, &job.request.session_id, &turn_id, "dispatch_permission_stream_lagged").await;
                        break (
                            DispatchJobState::Failed,
                            Some(format!("dispatch permission stream lost {skipped} requests; the turn was cancelled")),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        cancel_turn(&agent_runtime, &job.request.session_id, &turn_id, "dispatch_permission_stream_closed").await;
                        break (
                            DispatchJobState::Failed,
                            Some("dispatch permission stream closed before the turn settled".to_string()),
                        );
                    }
                };
                let PermissionRequestEvent::Asked { request } = event else {
                    continue;
                };
                if !event_scope.permission_targets_job(&request)
                    || !handled_permissions.insert(request.request_id.clone())
                {
                    continue;
                }
                if let Some(reason) = handle_permission(
                    store,
                    job_id,
                    &agent_runtime,
                    &job.request.session_id,
                    &turn_id,
                    request,
                    effective_policy,
                )
                .await?
                {
                    break (DispatchJobState::Failed, Some(reason));
                }
            }
            _ = mailbox_tick.tick() => {
                if let Some(outcome) = process_mailboxes(
                    store,
                    job_id,
                    &agent_runtime,
                    &job.request.session_id,
                    &turn_id,
                ).await? {
                    break outcome;
                }
            }
        }
    };

    let settlement = agent_runtime
        .wait_for_turn_settlement(AgentTurnSettlementRequest {
            session_id: job.request.session_id.clone(),
            turn_id: turn_id.clone(),
            wait_timeout_ms: TURN_SETTLEMENT_TIMEOUT_MS,
        })
        .await;
    let (terminal_state, terminal_error) = match settlement {
        Ok(_) => (terminal_state, terminal_error),
        Err(error) => (
            DispatchJobState::Failed,
            Some(format!(
                "dispatch turn reached a terminal event but did not settle: {}",
                error.into_message()
            )),
        ),
    };
    store.mark_state(job_id, terminal_state, Some(&turn_id), terminal_error)?;
    store.clear_pending_permissions(job_id);
    Ok(())
}

async fn handle_permission(
    store: &DispatchStore,
    job_id: &str,
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    session_id: &str,
    turn_id: &str,
    request: PermissionRequest,
    policy: DispatchApprovalPolicy,
) -> Result<Option<String>> {
    if policy == DispatchApprovalPolicy::Remote {
        store.save_pending_permission(job_id, &request)?;
        store.append_event(
            job_id,
            &DispatchEvent::permission_pending(&request.request_id),
        )?;
        return Ok(None);
    }
    let reason = match policy {
        DispatchApprovalPolicy::RejectAndReport => REJECT_AND_REPORT_REASON.to_string(),
        DispatchApprovalPolicy::Auto => format!(
            "Dispatch Auto policy could not safely auto-approve permission request {}",
            request.request_id
        ),
        DispatchApprovalPolicy::Remote => unreachable!("remote handled above"),
    };
    store.append_event(
        job_id,
        &DispatchEvent::permission_rejected(
            serde_json::to_value(&request).context("serialize permission request")?,
            reason.clone(),
        ),
    )?;
    runtime
        .respond_permission_with_source(
            &request.request_id,
            PermissionReply::Reject {
                feedback: Some(reason.clone()),
            },
            PermissionReplySource::System,
        )
        .await
        .map_err(|error| anyhow!(error.into_message()))
        .context("reject unattended dispatch permission")?;
    cancel_turn(runtime, session_id, turn_id, "dispatch_permission_rejected").await;
    Ok(Some(reason))
}

async fn process_mailboxes(
    store: &DispatchStore,
    job_id: &str,
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<(DispatchJobState, Option<String>)>> {
    let state = store.load_state(job_id)?;
    if state.cancel_requested() {
        cancel_turn(runtime, session_id, turn_id, "dispatch_cancel_requested").await;
        return Ok(Some((
            DispatchJobState::Cancelled,
            Some("Dispatch worker observed a cancellation request".to_string()),
        )));
    }

    for answer in store.list_permission_answers(job_id)? {
        runtime
            .respond_permission_with_source(
                &answer.request_id,
                answer.reply.clone(),
                PermissionReplySource::User,
            )
            .await
            .map_err(|error| anyhow!(error.into_message()))
            .with_context(|| {
                format!(
                    "apply remote dispatch permission response {}",
                    answer.request_id
                )
            })?;
        store.mark_permission_resolved(job_id, &answer)?;
        store.append_event(
            job_id,
            &DispatchEvent::permission_resolved(&answer.request_id),
        )?;
    }

    for request in store.list_pending_append_messages(job_id)? {
        runtime
            .steer_dialog_turn(AgentDialogSteerRequest {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                content: request.content.clone(),
                display_content: request.display_content.clone(),
                attachments: runtime_attachments(&request.attachments),
                metadata: serde_json::Map::new(),
            })
            .await
            .map_err(|error| anyhow!(error.into_message()))
            .with_context(|| {
                format!(
                    "append message {} to running dispatch turn",
                    request.message_id
                )
            })?;
        store.mark_append_message_consumed(job_id, &request)?;
        store.append_event(
            job_id,
            &DispatchEvent::message_appended(&request.message_id),
        )?;
    }
    Ok(None)
}

async fn cancel_turn(
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    session_id: &str,
    turn_id: &str,
    reason: &str,
) {
    if let Err(error) = runtime
        .cancel_turn(AgentTurnCancellationRequest {
            session_id: session_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            source: Some(AgentSubmissionSource::Cli),
            requester_session_id: None,
            reason: Some(reason.to_string()),
            wait_timeout_ms: None,
            cancel_descendants: true,
        })
        .await
    {
        tracing::error!("Failed to cancel dispatch turn: {}", error.into_message());
    }
}

fn runtime_attachments(
    attachments: &[super::protocol::DispatchAttachment],
) -> Vec<openbitfun_runtime_ports::AgentInputAttachment> {
    attachments
        .iter()
        .map(|attachment| {
            openbitfun_runtime_ports::AgentInputAttachment::remote_image(
                attachment.id.clone(),
                attachment
                    .name
                    .clone()
                    .unwrap_or_else(|| attachment.id.clone()),
                attachment.data_url.clone(),
            )
        })
        .collect()
}

/// Which sessions' events belong in this job's log.
///
/// The job session's turn-scoped events must match the worker's turn, and any
/// subagent session linked under it (recursively) is admitted wholesale so
/// the controller can project child transcripts.
struct JobEventScope {
    session_id: String,
    turn_id: String,
    children: std::collections::HashSet<String>,
}

impl JobEventScope {
    fn new(session_id: String, turn_id: String) -> Self {
        Self {
            session_id,
            turn_id,
            children: std::collections::HashSet::new(),
        }
    }

    fn admit(&mut self, event: &AgenticEvent) -> bool {
        if let AgenticEvent::SubagentSessionLinked {
            session_id: child_session,
            parent_session_id,
            ..
        } = event
        {
            if parent_session_id == &self.session_id || self.children.contains(parent_session_id) {
                self.children.insert(child_session.clone());
                return true;
            }
            return false;
        }
        match event.session_id() {
            Some(event_session) if event_session == self.session_id => {
                event_turn_id(event).is_none_or(|event_turn| event_turn == self.turn_id)
            }
            Some(event_session) => self.children.contains(event_session),
            None => true,
        }
    }

    fn permission_targets_job(&self, request: &PermissionRequest) -> bool {
        if crate::runtime::approval::permission_request_targets_session(request, &self.session_id) {
            return true;
        }
        self.children.iter().any(|child| {
            crate::runtime::approval::permission_request_targets_session(request, child)
        })
    }
}

fn event_turn_id(event: &AgenticEvent) -> Option<&str> {
    match event {
        AgenticEvent::DialogTurnStarted { turn_id, .. }
        | AgenticEvent::DialogTurnCompleted { turn_id, .. }
        | AgenticEvent::DialogTurnCancelled { turn_id, .. }
        | AgenticEvent::DialogTurnFailed { turn_id, .. }
        | AgenticEvent::TokenUsageUpdated { turn_id, .. }
        | AgenticEvent::ContextCompressionStarted { turn_id, .. }
        | AgenticEvent::ContextCompressionCompleted { turn_id, .. }
        | AgenticEvent::ContextCompressionFailed { turn_id, .. }
        | AgenticEvent::ModelRoundStarted { turn_id, .. }
        | AgenticEvent::ModelRoundCompleted { turn_id, .. }
        | AgenticEvent::TextChunk { turn_id, .. }
        | AgenticEvent::ThinkingChunk { turn_id, .. }
        | AgenticEvent::ToolEvent { turn_id, .. }
        | AgenticEvent::DeepReviewQueueStateChanged { turn_id, .. }
        | AgenticEvent::UserSteeringInjected { turn_id, .. } => Some(turn_id),
        _ => None,
    }
}

fn terminal_outcome(
    event: &AgenticEvent,
    turn_id: &str,
) -> Option<(DispatchJobState, Option<String>)> {
    match event {
        AgenticEvent::DialogTurnCompleted {
            turn_id: event_turn,
            success,
            finish_reason,
            has_final_response,
            ..
        } if event_turn == turn_id => {
            if *success == Some(false) {
                let reason = finish_reason
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("unsuccessful_completion");
                let detail = if *has_final_response == Some(false) {
                    format!("Dispatch completed without a successful final response: {reason}")
                } else {
                    format!("Dispatch completed unsuccessfully: {reason}")
                };
                Some((DispatchJobState::Failed, Some(detail)))
            } else {
                Some((DispatchJobState::Succeeded, None))
            }
        }
        AgenticEvent::DialogTurnFailed {
            turn_id: event_turn,
            error,
            ..
        } if event_turn == turn_id => Some((DispatchJobState::Failed, Some(error.clone()))),
        AgenticEvent::DialogTurnCancelled {
            turn_id: event_turn,
            ..
        } if event_turn == turn_id => Some((
            DispatchJobState::Cancelled,
            Some("Dispatch turn was cancelled".to_string()),
        )),
        AgenticEvent::SystemError { error, .. } => {
            Some((DispatchJobState::Failed, Some(error.clone())))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_append_reuses_the_runtime_steering_port() {
        let source = include_str!("worker.rs").replace("\r\n", "\n");
        let mailboxes = source
            .split_once("async fn process_mailboxes(")
            .expect("mailbox processor")
            .1
            .split_once("async fn cancel_turn(")
            .expect("mailbox processor boundary")
            .0;

        assert!(mailboxes.contains(".steer_dialog_turn(AgentDialogSteerRequest"));
        assert!(!mailboxes.contains("compatibility.submit_steering"));
    }

    #[test]
    fn terminal_events_map_to_persistent_job_states() {
        let completed = AgenticEvent::DialogTurnCompleted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            total_rounds: 1,
            total_tools: 0,
            duration_ms: 10,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: Some("stop".to_string()),
            has_final_response: Some(true),
        };
        assert_eq!(
            terminal_outcome(&completed, "turn-1"),
            Some((DispatchJobState::Succeeded, None))
        );

        let failed = AgenticEvent::DialogTurnFailed {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            error: "model failed".to_string(),
            error_category: None,
            error_detail: None,
        };
        assert_eq!(
            terminal_outcome(&failed, "turn-1"),
            Some((DispatchJobState::Failed, Some("model failed".to_string())))
        );
    }

    #[test]
    fn linked_subagent_sessions_flow_into_the_job_event_scope() {
        let mut scope = JobEventScope::new("session-1".to_string(), "turn-1".to_string());

        let child_chunk = AgenticEvent::TextChunk {
            session_id: "child-session".to_string(),
            turn_id: "child-turn".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: "child output".to_string(),
        };
        // A child that was never linked stays outside the scope.
        assert!(!scope.admit(&child_chunk));

        let linked = AgenticEvent::SubagentSessionLinked {
            session_id: "child-session".to_string(),
            subagent_dialog_turn_id: "child-turn".to_string(),
            parent_session_id: "session-1".to_string(),
            parent_dialog_turn_id: "turn-1".to_string(),
            parent_tool_call_id: "tool-1".to_string(),
            agent_type: Some("GeneralPurpose".to_string()),
            model_id: None,
            focused_review_display_label: None,
        };
        assert!(scope.admit(&linked));
        assert!(scope.admit(&child_chunk));

        // Grandchildren link recursively through an admitted child.
        let grandchild_link = AgenticEvent::SubagentSessionLinked {
            session_id: "grandchild-session".to_string(),
            subagent_dialog_turn_id: "grandchild-turn".to_string(),
            parent_session_id: "child-session".to_string(),
            parent_dialog_turn_id: "child-turn".to_string(),
            parent_tool_call_id: "tool-2".to_string(),
            agent_type: None,
            model_id: None,
            focused_review_display_label: None,
        };
        assert!(scope.admit(&grandchild_link));

        // A link from an unrelated parent is refused.
        let foreign_link = AgenticEvent::SubagentSessionLinked {
            session_id: "other-child".to_string(),
            subagent_dialog_turn_id: "t".to_string(),
            parent_session_id: "unrelated-session".to_string(),
            parent_dialog_turn_id: "t".to_string(),
            parent_tool_call_id: "tool-3".to_string(),
            agent_type: None,
            model_id: None,
            focused_review_display_label: None,
        };
        assert!(!scope.admit(&foreign_link));

        // Parent turn discipline is unchanged.
        let parent_chunk = AgenticEvent::TextChunk {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: "parent output".to_string(),
        };
        assert!(scope.admit(&parent_chunk));
        let stale_parent_chunk = AgenticEvent::TextChunk {
            session_id: "session-1".to_string(),
            turn_id: "turn-0".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: "stale output".to_string(),
        };
        assert!(!scope.admit(&stale_parent_chunk));
    }
}
