/// Exec mode implementation
///
/// Single command execution mode (non-interactive).
/// Observes core events through an independent runtime broadcast subscription.
use anyhow::Result;
use clap::ValueEnum;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use openbitfun_agent_runtime::sdk::{
    PermissionReply, PermissionReplySource, PermissionRequest, PermissionRequestEvent,
    PortErrorKind, RuntimeError, TurnTokenUsage,
};
use openbitfun_agent_tools::effective_tool_invocation;
use openbitfun_events::{AgenticEvent, ToolEventIdentity};
use tokio::time::Instant;

use crate::agent::runtime_client::CliAgentRuntimeClient;
use crate::config::CliConfig;
use crate::diagnostics::{
    cli_error_code, emit_exit_diagnostic, user_facing_error_message, ExitContext, ExitKind,
    SESSION_IN_USE_ERROR_CODE,
};
use crate::runtime::CliRuntimeContext;

pub(super) const TOOL_START_INPUT_PREVIEW_CHARS: usize = 4_000;
const TURN_SETTLEMENT_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn effective_event_invocation<'a>(
    identity: &'a ToolEventIdentity,
    params: &'a serde_json::Value,
) -> (&'a str, &'a serde_json::Value) {
    let (derived_name, effective_input) = effective_tool_invocation(&identity.tool_name, params);
    debug_assert_eq!(identity.effective_name(), derived_name);
    (derived_name, effective_input)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub(crate) enum ExecOutputFormat {
    Text,
    Json,
    StreamJson,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ExecApprovalMode {
    #[default]
    Reject,
    Auto,
}

pub(super) type ExecTokenUsage = TurnTokenUsage;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct ExecJsonResult {
    #[serde(rename = "type")]
    kind: &'static str,
    subtype: &'static str,
    is_error: bool,
    result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<ExecTokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    patch: Option<ExecPatchOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<super::verification::VerifyOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct ExecPatchOutput {
    pub(super) target: String,
    pub(super) status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) bytes: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExecTerminalStatus {
    Success,
    Error,
    Cancelled,
}

struct ExecTerminalDecision {
    status: ExecTerminalStatus,
    message: Option<String>,
    exit_kind: Option<ExitKind>,
}

pub(super) fn event_turn_id(event: &AgenticEvent) -> Option<&str> {
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

pub(super) fn event_belongs_to_exec_turn(
    event: &AgenticEvent,
    session_id: &str,
    turn_id: &str,
) -> bool {
    if event.session_id() != Some(session_id) {
        return false;
    }
    match event_turn_id(event) {
        Some(event_turn_id) => event_turn_id == turn_id,
        None => true,
    }
}

pub(super) fn completed_turn_failure(
    success: Option<bool>,
    finish_reason: Option<&str>,
    has_final_response: Option<bool>,
) -> Option<String> {
    if success != Some(false) {
        return None;
    }

    let reason = finish_reason
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unsuccessful_completion");
    Some(match has_final_response {
        Some(false) => format!("Execution completed without a successful final response: {reason}"),
        _ => format!("Execution completed unsuccessfully: {reason}"),
    })
}

pub(super) fn permission_action_required_message(request: &PermissionRequest) -> String {
    match request.delegation.as_ref() {
        Some(delegation) => format!(
            "action-required: permission needed for {} by {} subagent (child session {}, parent session {}, parent task {}, request {})",
            request.action,
            delegation.subagent_type,
            request.session_id,
            delegation.parent_session_id,
            delegation.parent_tool_call_id,
            request.request_id
        ),
        None => format!(
            "action-required: permission needed for {} ({})",
            request.action, request.request_id
        ),
    }
}

pub(super) fn should_reject_permission_request(
    request: &PermissionRequest,
    session_id: &str,
    approval_mode: ExecApprovalMode,
) -> bool {
    approval_mode == ExecApprovalMode::Reject
        && crate::runtime::approval::permission_request_targets_session(request, session_id)
}

fn exec_terminal_decision(event: &AgenticEvent, turn_id: &str) -> Option<ExecTerminalDecision> {
    match event {
        AgenticEvent::DialogTurnCompleted {
            turn_id: event_turn_id,
            success,
            finish_reason,
            has_final_response,
            ..
        } if event_turn_id == turn_id => {
            match completed_turn_failure(*success, finish_reason.as_deref(), *has_final_response) {
                Some(message) => Some(ExecTerminalDecision {
                    status: ExecTerminalStatus::Error,
                    message: Some(message),
                    exit_kind: Some(ExitKind::DialogTurnFailed),
                }),
                None => Some(ExecTerminalDecision {
                    status: ExecTerminalStatus::Success,
                    message: None,
                    exit_kind: None,
                }),
            }
        }
        AgenticEvent::DialogTurnFailed {
            turn_id: event_turn_id,
            error,
            ..
        } if event_turn_id == turn_id => Some(ExecTerminalDecision {
            status: ExecTerminalStatus::Error,
            message: Some(error.clone()),
            exit_kind: Some(ExitKind::DialogTurnFailed),
        }),
        AgenticEvent::DialogTurnCancelled {
            turn_id: event_turn_id,
            ..
        } if event_turn_id == turn_id => Some(ExecTerminalDecision {
            status: ExecTerminalStatus::Cancelled,
            message: Some("Execution cancelled".to_string()),
            exit_kind: Some(ExitKind::Cancelled),
        }),
        AgenticEvent::SystemError { error, .. } => Some(ExecTerminalDecision {
            status: ExecTerminalStatus::Error,
            message: Some(error.clone()),
            exit_kind: Some(ExitKind::SystemError),
        }),
        _ => None,
    }
}

pub(super) fn is_exec_terminal(event: &AgenticEvent, turn_id: &str) -> bool {
    exec_terminal_decision(event, turn_id).is_some()
}

pub(super) fn settlement_failure(
    error: RuntimeError,
    session_id: &str,
    turn_id: &str,
) -> (ExitKind, String) {
    let is_timeout = matches!(
        &error,
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::Timeout
    );
    let detail = error.into_message();
    if is_timeout {
        (
            ExitKind::SettlementTimedOut,
            format!(
                "Timed out waiting for exec turn settlement: session_id={session_id}, turn_id={turn_id}: {detail}"
            ),
        )
    } else {
        (
            ExitKind::SystemError,
            format!(
                "Failed to wait for exec turn settlement: session_id={session_id}, turn_id={turn_id}: {detail}"
            ),
        )
    }
}

pub(super) fn resolve_cancelled_turn_observation(
    observed_terminal: Result<openbitfun_events::AgenticEventEnvelope>,
    settlement: std::result::Result<(), RuntimeError>,
    session_id: &str,
    turn_id: &str,
) -> std::result::Result<openbitfun_events::AgenticEventEnvelope, (ExitKind, String)> {
    match settlement {
        Err(error) => Err(settlement_failure(error, session_id, turn_id)),
        Ok(()) => observed_terminal.map_err(|error| {
            (
                ExitKind::SystemError,
                format!("Failed to observe cancelled turn terminal event: {error}"),
            )
        }),
    }
}

impl ExecJsonResult {
    pub(super) fn success(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        result: impl Into<String>,
        usage: Option<ExecTokenUsage>,
    ) -> Self {
        Self::new(
            "success",
            false,
            Some(session_id.into()),
            Some(turn_id.into()),
            result,
            usage,
        )
    }

    fn error(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        result: impl Into<String>,
        usage: Option<ExecTokenUsage>,
    ) -> Self {
        Self::new(
            "error",
            true,
            Some(session_id.into()),
            Some(turn_id.into()),
            result,
            usage,
        )
    }

    fn session_error(session_id: impl Into<String>, result: impl Into<String>) -> Self {
        Self::new("error", true, Some(session_id.into()), None, result, None)
    }

    pub(super) fn preflight_error(result: impl Into<String>) -> Self {
        Self::new("error", true, None, None, result, None)
    }

    pub(super) fn cancelled(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        result: impl Into<String>,
        usage: Option<ExecTokenUsage>,
    ) -> Self {
        Self::new(
            "cancelled",
            true,
            Some(session_id.into()),
            Some(turn_id.into()),
            result,
            usage,
        )
    }

    fn new(
        subtype: &'static str,
        is_error: bool,
        session_id: Option<String>,
        turn_id: Option<String>,
        result: impl Into<String>,
        usage: Option<ExecTokenUsage>,
    ) -> Self {
        Self {
            kind: "result",
            subtype,
            is_error,
            result: result.into(),
            error_code: None,
            session_id,
            turn_id,
            usage,
            patch: None,
            verification: None,
        }
    }

    fn with_patch(mut self, patch: Option<ExecPatchOutput>) -> Self {
        self.patch = patch;
        self
    }

    pub(super) fn with_error_code(mut self, error_code: &'static str) -> Self {
        self.error_code = Some(error_code);
        self
    }

    fn with_verification(
        mut self,
        verification: Option<super::verification::VerifyOutcome>,
    ) -> Self {
        self.verification = verification;
        self
    }
}

pub(crate) fn emit_preflight_json_error(
    output_format: ExecOutputFormat,
    error: &anyhow::Error,
) -> Result<()> {
    if output_format == ExecOutputFormat::Json {
        let result = ExecJsonResult::preflight_error(error.to_string());
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}

pub(super) fn serialize_stream_envelope(
    envelope: &openbitfun_events::AgenticEventEnvelope,
) -> Result<String> {
    Ok(serde_json::to_string(envelope)?)
}

pub(super) fn session_in_use_stream_envelope() -> openbitfun_events::AgenticEventEnvelope {
    openbitfun_events::AgenticEventEnvelope::new(
        AgenticEvent::SystemError {
            session_id: None,
            error: SESSION_IN_USE_ERROR_CODE.to_string(),
            recoverable: true,
        },
        openbitfun_events::AgenticEventPriority::Critical,
    )
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ExecSessionOptions {
    pub resume: Option<String>,
    pub continue_last: bool,
    pub session_id: Option<String>,
    pub fork_session: bool,
}

pub(crate) struct ExecMode {
    #[allow(dead_code)]
    config: CliConfig,
    message: String,
    agent_type: String,
    agent: Arc<CliAgentRuntimeClient>,
    runtime: Arc<CliRuntimeContext>,
    pub(super) workspace_path: Option<PathBuf>,
    /// Git tree captured before execution so committed agent changes remain
    /// visible to patch export and final verification.
    pub(super) initial_diff_base: Option<String>,
    /// Untracked files that predate execution belong to the caller, not the
    /// agent, and must not leak into its patch or verification scope.
    pub(super) initial_untracked_files: std::collections::BTreeSet<String>,
    /// None: no patch output, Some("-"): output to stdout, Some(path): save to file
    pub(super) output_patch: Option<String>,
    pub(super) verify_final_changes: bool,
    pub(super) verification_retries_used: u32,
    pub(super) latest_verification: Option<super::verification::VerifyOutcome>,
    pub(super) output_format: ExecOutputFormat,
    approval_mode: ExecApprovalMode,
    session_options: ExecSessionOptions,
}

impl ExecMode {
    pub(crate) fn new(
        config: CliConfig,
        message: String,
        agent_type: String,
        runtime: Arc<CliRuntimeContext>,
        workspace_path: Option<PathBuf>,
        output_patch: Option<String>,
        verify_final_changes: bool,
        output_format: ExecOutputFormat,
        session_options: ExecSessionOptions,
    ) -> Self {
        let approval_mode = match runtime.approval_policy() {
            crate::runtime::approval::CliApprovalPolicy::Auto => ExecApprovalMode::Auto,
            crate::runtime::approval::CliApprovalPolicy::Ask
            | crate::runtime::approval::CliApprovalPolicy::DisableAuto
            | crate::runtime::approval::CliApprovalPolicy::Reject => ExecApprovalMode::Reject,
        };
        let agent = Arc::new(CliAgentRuntimeClient::new(runtime.as_ref()));
        let (initial_diff_base, initial_untracked_files) =
            if super::verification::needs_change_baseline(
                output_patch.as_deref(),
                verify_final_changes,
            ) {
                workspace_path
                    .as_deref()
                    .map(super::patch::capture_change_baseline)
                    .unwrap_or_default()
            } else {
                Default::default()
            };

        Self {
            config,
            message,
            agent_type,
            agent,
            runtime,
            workspace_path,
            initial_diff_base,
            initial_untracked_files,
            output_patch,
            verify_final_changes,
            verification_retries_used: 0,
            latest_verification: None,
            output_format,
            approval_mode,
            session_options,
        }
    }

    pub(super) fn exit_context<'a>(
        &'a self,
        session_id: Option<&'a str>,
        turn_id: Option<&'a str>,
    ) -> ExitContext<'a> {
        ExitContext {
            session_id,
            turn_id,
            agent_type: Some(self.agent_type.as_str()),
            workspace: self.workspace_path.as_deref(),
        }
    }

    fn workspace_display(&self) -> String {
        self.workspace_path
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| ".".to_string())
            })
    }

    fn redact_large_inline_data(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                if map.remove("data_url").is_some() {
                    map.insert("has_data_url".to_string(), serde_json::json!(true));
                }
                for child in map.values_mut() {
                    Self::redact_large_inline_data(child);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    Self::redact_large_inline_data(child);
                }
            }
            _ => {}
        }
    }

    pub(super) fn tool_input_preview(params: &serde_json::Value) -> String {
        let mut redacted = params.clone();
        Self::redact_large_inline_data(&mut redacted);
        let raw =
            serde_json::to_string(&redacted).unwrap_or_else(|_| "<unserializable>".to_string());
        if raw.chars().count() <= TOOL_START_INPUT_PREVIEW_CHARS {
            return raw;
        }

        let preview: String = raw.chars().take(TOOL_START_INPUT_PREVIEW_CHARS).collect();
        format!("{preview}... [truncated]")
    }

    fn print_tool_start_details(&self, tool_name: &str, tool_id: &str, params: &serde_json::Value) {
        let started_at = chrono::Utc::now().to_rfc3339();
        let cwd = self.workspace_display();
        let input_preview = Self::tool_input_preview(params);

        self.print_text(|| {
            eprintln!("\nTool call: {}", tool_name);
            eprintln!("   Started at: {}", started_at);
            eprintln!("   Tool ID: {}", tool_id);
            eprintln!("   CWD: {}", cwd);
            eprintln!("   Input: {}", input_preview);
        });
    }

    pub(crate) async fn run(&mut self) -> Result<()> {
        tracing::info!(
            agent_type = %self.agent_type,
            message_len = self.message.len(),
            workspace = ?self.workspace_path,
            "Executing command"
        );

        let session_id = match self.prepare_session().await {
            Ok(session_id) => session_id,
            Err(error) => {
                let error_code = cli_error_code(&error);
                let detail = user_facing_error_message(&error);
                emit_exit_diagnostic(
                    ExitKind::SessionCreateFailed,
                    &detail,
                    &self.exit_context(None, None),
                );
                if self.output_format == ExecOutputFormat::Json {
                    let mut result = ExecJsonResult::preflight_error(detail);
                    if let Some(error_code) = error_code {
                        result = result.with_error_code(error_code);
                    }
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else if self.output_format == ExecOutputFormat::StreamJson
                    && error_code == Some(SESSION_IN_USE_ERROR_CODE)
                {
                    self.emit_stream_envelope(&session_in_use_stream_envelope())?;
                }
                return Err(error);
            }
        };
        tracing::info!(session_id = %session_id, "Session ready");
        let mut event_rx = self
            .agent
            .subscribe_events()
            .map_err(|error| anyhow::anyhow!(error.into_message()))?;

        self.print_text(|| {
            eprintln!("Executing: {}", self.message);
            eprintln!();
            eprintln!("Session: {}", session_id);
            eprintln!("Thinking...");
        });

        let turn_id = match self
            .agent
            .send_message(self.message.clone(), &self.agent_type)
            .await
        {
            Ok(turn_id) => turn_id,
            Err(error) => {
                emit_exit_diagnostic(
                    ExitKind::SendMessageFailed,
                    &error.to_string(),
                    &self.exit_context(Some(&session_id), None),
                );
                if self.output_format == ExecOutputFormat::Json {
                    let result = ExecJsonResult::session_error(&session_id, error.to_string());
                    println!("{}", serde_json::to_string_pretty(&result)?);
                }
                return Err(error);
            }
        };
        tracing::info!(session_id = %session_id, turn_id = %turn_id, "Message sent");

        let mut permission_rx = self
            .runtime
            .agent_runtime()
            .subscribe_permission_requests()
            .map_err(|error| anyhow::anyhow!(error.into_message()))?;
        let permission_runtime = self.runtime.agent_runtime().clone();
        let permission_session_id = session_id.clone();
        let permission_mode = self.approval_mode;
        let (permission_action_tx, mut permission_action_rx) = tokio::sync::mpsc::channel(1);
        let permission_task = tokio::spawn(async move {
            let mut initial_requests = permission_runtime
                .pending_permission_requests()
                .unwrap_or_default()
                .into_iter()
                .collect::<VecDeque<_>>();
            let mut handled_request_ids = HashSet::new();
            loop {
                let request = if let Some(request) = initial_requests.pop_front() {
                    request
                } else {
                    let Ok(event) = permission_rx.recv().await else {
                        break;
                    };
                    let PermissionRequestEvent::Asked { request } = event else {
                        continue;
                    };
                    request
                };
                if !should_reject_permission_request(
                    &request,
                    &permission_session_id,
                    permission_mode,
                ) {
                    continue;
                }
                if !handled_request_ids.insert(request.request_id.clone()) {
                    continue;
                }
                let reply = PermissionReply::Reject {
                    feedback: Some(
                        "Non-interactive execution requires an explicit permission policy"
                            .to_string(),
                    ),
                };
                if let Err(error) = permission_runtime
                    .respond_permission_with_source(
                        &request.request_id,
                        reply,
                        PermissionReplySource::System,
                    )
                    .await
                {
                    let _ = permission_action_tx
                        .send(format!("Failed to respond to permission request: {error}"))
                        .await;
                    break;
                }
                let _ = permission_action_tx
                    .send(permission_action_required_message(&request))
                    .await;
                break;
            }
        });

        // Observe the shared Agentic event stream without consuming other clients' events.
        let mut total_tool_calls = 0usize;
        let mut subagent_parent_turns: HashMap<String, (String, String)> = HashMap::new();
        let mut terminal_outcome: Option<Result<()>> = None;
        let mut terminal_status: Option<ExecTerminalStatus> = None;
        let mut terminal_message: Option<String> = None;
        let mut assistant_text = String::new();
        let mut usage: Option<ExecTokenUsage> = None;
        let mut deferred_terminal_envelope: Option<openbitfun_events::AgenticEventEnvelope> = None;
        let mut terminal_exit_kind: Option<ExitKind> = None;
        let mut final_stream_error: Option<String> = None;
        let mut cancellation_observation: Option<
            Result<(
                Vec<openbitfun_events::AgenticEventEnvelope>,
                openbitfun_events::AgenticEventEnvelope,
            )>,
        > = None;
        let mut cancellation_settlement: Option<std::result::Result<(), RuntimeError>> = None;
        let mut cancelled_terminal_override: Option<(ExecTerminalStatus, ExitKind, String)> = None;

        'event_loop: loop {
            let envelope = tokio::select! {
                result = event_rx.recv() => match result {
                Ok(envelope) => envelope,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    let mut message = format!(
                        "Agentic event stream lost {skipped} events; execution state is no longer reliable"
                    );
                    if let Err(error) = self.agent.cancel_current_turn().await {
                        message.push_str(&format!("; failed to cancel active turn: {error}"));
                    }
                    terminal_exit_kind = Some(ExitKind::EventStreamFailed);
                    final_stream_error = Some(message.clone());
                    terminal_status = Some(ExecTerminalStatus::Error);
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message)));
                    break 'event_loop;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    let mut message =
                        "Agentic event stream closed before execution settled".to_string();
                    if let Err(error) = self.agent.cancel_current_turn().await {
                        message.push_str(&format!("; failed to cancel active turn: {error}"));
                    }
                    terminal_exit_kind = Some(ExitKind::EventStreamFailed);
                    final_stream_error = Some(message.clone());
                    terminal_status = Some(ExecTerminalStatus::Error);
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message)));
                    break 'event_loop;
                }
                },
                permission = permission_action_rx.recv() => {
                    let message = permission.unwrap_or_else(|| {
                        "Permission response channel closed before execution settled".to_string()
                    });
                    if let Err(error) = self.agent.cancel_current_turn().await {
                        tracing::error!("Failed to cancel after permission action: {error}");
                    }
                    emit_exit_diagnostic(
                        ExitKind::PermissionRejected,
                        &message,
                        &self.exit_context(Some(&session_id), Some(&turn_id)),
                    );
                    terminal_status = Some(ExecTerminalStatus::Error);
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message)));
                    break 'event_loop;
                }
                signal = tokio::signal::ctrl_c() => {
                    let interrupted = signal.is_ok();
                    let mut message = match signal {
                        Ok(()) => "Execution cancelled by interrupt".to_string(),
                        Err(error) => format!("Failed to listen for execution interrupt: {error}"),
                    };
                    if let Err(error) = self.agent.cancel_current_turn().await {
                        message.push_str(&format!("; failed to cancel active turn: {error}"));
                    }
                    if interrupted {
                        self.print_text(|| eprintln!("\nCancelling execution..."));
                        let (drain_result, settlement_result) = self
                            .observe_cancelled_turn_settlement(
                                &mut event_rx,
                                &session_id,
                                &turn_id,
                            )
                            .await;
                        cancellation_observation = Some(drain_result);
                        cancellation_settlement = Some(settlement_result);
                        cancelled_terminal_override = Some((
                            ExecTerminalStatus::Cancelled,
                            ExitKind::Cancelled,
                            message.clone(),
                        ));
                    } else {
                        final_stream_error = Some(message.clone());
                    }
                    terminal_exit_kind = Some(if interrupted {
                        ExitKind::Cancelled
                    } else {
                        ExitKind::ExecError
                    });
                    terminal_status = Some(if interrupted {
                        ExecTerminalStatus::Cancelled
                    } else {
                        ExecTerminalStatus::Error
                    });
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message)));
                    break 'event_loop;
                }
            };
            let events = [envelope];

            for envelope in events {
                let event = &envelope.event;

                if let AgenticEvent::SubagentSessionLinked {
                    session_id: subagent_session_id,
                    subagent_dialog_turn_id,
                    parent_session_id,
                    parent_dialog_turn_id,
                    ..
                } = event
                {
                    if parent_session_id == &session_id && parent_dialog_turn_id == &turn_id {
                        subagent_parent_turns.insert(
                            subagent_session_id.clone(),
                            (parent_session_id.clone(), subagent_dialog_turn_id.clone()),
                        );
                        self.emit_stream_envelope(&envelope)?;
                    }
                    continue;
                }

                // Only process events for our session
                if event.session_id() != Some(&session_id) {
                    // Check if this is a subagent event whose parent is in our session
                    if let AgenticEvent::ToolEvent {
                        turn_id: event_turn_id,
                        tool_event,
                        ..
                    } = event
                    {
                        let parent_turn = event.session_id().and_then(|event_session_id| {
                            subagent_parent_turns.get(event_session_id)
                        });
                        if parent_turn.is_some_and(|(parent_session_id, subagent_turn_id)| {
                            parent_session_id == &session_id && subagent_turn_id == event_turn_id
                        }) {
                            self.emit_stream_envelope(&envelope)?;
                            use openbitfun_events::ToolEventData;
                            match tool_event {
                                ToolEventData::Started {
                                    identity, params, ..
                                } => {
                                    let (tool_name, input) =
                                        effective_event_invocation(identity, params);
                                    self.print_text(|| {
                                        let started_at = chrono::Utc::now().to_rfc3339();
                                        let input_preview = Self::tool_input_preview(input);
                                        eprintln!("   [subagent] {}", tool_name);
                                        eprintln!("      Started at: {}", started_at);
                                        eprintln!("      Tool ID: {}", identity.tool_id);
                                        eprintln!("      CWD: {}", self.workspace_display());
                                        eprintln!("      Input: {}", input_preview);
                                    });
                                }
                                ToolEventData::Completed {
                                    identity,
                                    result_for_assistant,
                                    result,
                                    ..
                                } => {
                                    let tool_name = identity.effective_name();
                                    let summary = result_for_assistant
                                        .clone()
                                        .unwrap_or_else(|| result.to_string());
                                    self.print_text(|| {
                                        eprintln!(
                                            "   [subagent] {} completed: {}",
                                            tool_name, summary
                                        )
                                    });
                                }
                                ToolEventData::Failed {
                                    identity, error, ..
                                } => {
                                    let tool_name = identity.effective_name();
                                    self.print_text(|| {
                                        eprintln!("   [subagent] {} failed: {}", tool_name, error)
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    continue;
                }

                if !event_belongs_to_exec_turn(event, &session_id, &turn_id) {
                    continue;
                }

                if let Some(decision) = exec_terminal_decision(event, &turn_id) {
                    deferred_terminal_envelope = Some(envelope.clone());
                    self.print_exec_terminal(event, &decision, total_tool_calls);
                    terminal_status = Some(decision.status);
                    terminal_exit_kind = decision.exit_kind;
                    terminal_message = decision.message;
                    terminal_outcome = Some(match decision.status {
                        ExecTerminalStatus::Success => Ok(()),
                        ExecTerminalStatus::Error | ExecTerminalStatus::Cancelled => {
                            Err(anyhow::anyhow!(terminal_message.clone().unwrap_or_else(
                                || { "Execution ended unsuccessfully".to_string() }
                            )))
                        }
                    });
                    break;
                }

                self.project_exec_nonterminal_event(
                    &envelope,
                    &session_id,
                    &turn_id,
                    &mut assistant_text,
                    &mut usage,
                    &mut total_tool_calls,
                )
                .await?;
            }

            if terminal_outcome.is_some() {
                break;
            }
        }

        permission_task.abort();

        let turn_settled = if let Some(settlement_result) = cancellation_settlement.take() {
            let settled = settlement_result.is_ok();
            let observation = cancellation_observation.take().unwrap_or_else(|| {
                Err(anyhow::anyhow!(
                    "cancelled turn observation ended without a terminal event"
                ))
            });
            let (buffered_events, observed_terminal) = match observation {
                Ok((buffered_events, terminal)) => (buffered_events, Ok(terminal)),
                Err(error) => (Vec::new(), Err(error)),
            };
            for envelope in buffered_events {
                self.project_exec_nonterminal_event(
                    &envelope,
                    &session_id,
                    &turn_id,
                    &mut assistant_text,
                    &mut usage,
                    &mut total_tool_calls,
                )
                .await?;
            }
            match resolve_cancelled_turn_observation(
                observed_terminal,
                settlement_result,
                &session_id,
                &turn_id,
            ) {
                Ok(envelope) => {
                    let mut decision = exec_terminal_decision(&envelope.event, &turn_id)
                        .expect("cancelled turn observation only returns terminal events");
                    if decision.status == ExecTerminalStatus::Cancelled {
                        if let Some((status, exit_kind, message)) =
                            cancelled_terminal_override.take()
                        {
                            decision.status = status;
                            decision.exit_kind = Some(exit_kind);
                            decision.message = Some(message);
                        }
                    }
                    self.print_exec_terminal(&envelope.event, &decision, total_tool_calls);
                    terminal_status = Some(decision.status);
                    terminal_exit_kind = decision.exit_kind;
                    terminal_message = decision.message;
                    terminal_outcome = Some(match decision.status {
                        ExecTerminalStatus::Success => Ok(()),
                        ExecTerminalStatus::Error | ExecTerminalStatus::Cancelled => {
                            Err(anyhow::anyhow!(terminal_message.clone().unwrap_or_else(
                                || { "Execution ended unsuccessfully".to_string() }
                            )))
                        }
                    });
                    deferred_terminal_envelope = Some(envelope);
                }
                Err((exit_kind, observation_message)) => {
                    let local_message = cancelled_terminal_override
                        .take()
                        .map(|(_, _, message)| message)
                        .or_else(|| terminal_message.take());
                    let message = match local_message {
                        Some(existing) => format!("{existing}; {observation_message}"),
                        None => observation_message,
                    };
                    terminal_status = Some(ExecTerminalStatus::Error);
                    terminal_exit_kind = Some(exit_kind);
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message.clone())));
                    final_stream_error = Some(message);
                }
            }
            settled
        } else {
            match self.wait_for_turn_settlement(&session_id, &turn_id).await {
                Ok(()) => true,
                Err(error) => {
                    let (exit_kind, settlement_message) =
                        settlement_failure(error, &session_id, &turn_id);
                    let message = match terminal_message.take() {
                        Some(existing) => format!("{existing}; {settlement_message}"),
                        None => settlement_message,
                    };
                    terminal_status = Some(ExecTerminalStatus::Error);
                    terminal_exit_kind = Some(exit_kind);
                    terminal_message = Some(message.clone());
                    terminal_outcome = Some(Err(anyhow::anyhow!(message.clone())));
                    final_stream_error = Some(message);
                    false
                }
            }
        };

        if turn_settled
            && terminal_outcome
                .as_ref()
                .is_some_and(|outcome| outcome.is_ok())
            && self.verify_final_changes
        {
            let workspace = self
                .workspace_path
                .clone()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            let verification_workspace =
                super::patch::repository_root(&workspace).unwrap_or(workspace);
            if let Some(command) = super::verification::detect_verify_command(
                &verification_workspace,
                self.initial_diff_base.as_deref(),
                &self.initial_untracked_files,
            ) {
                let config = super::verification::VerifyConfig::from_env();
                let verification = super::verification::run_verifier(
                    &verification_workspace,
                    &command,
                    &config,
                    self.verification_retries_used,
                )
                .await;
                self.latest_verification = Some(verification.clone());

                if self.output_format == ExecOutputFormat::StreamJson {
                    println!(
                        "{}",
                        serde_json::to_string(&serde_json::json!({
                            "type": "verify_result",
                            "session_id": &session_id,
                            "attempt": self.verification_retries_used + 1,
                            "status": verification.status,
                            "command": &verification.command,
                            "exit_code": verification.exit_code,
                            "duration_ms": verification.duration_ms,
                            "output_tail": &verification.output_tail,
                        }))?
                    );
                }

                if verification.status == super::verification::VerifyStatus::Passed {
                    self.print_text(|| {
                        eprintln!(
                            "\nFinal-change verification passed: {}",
                            verification.command
                        )
                    });
                } else if self.verification_retries_used < config.max_retries {
                    self.print_text(|| {
                        eprintln!(
                            "\nFinal-change verification failed (attempt {}, exit {:?}): {}",
                            self.verification_retries_used + 1,
                            verification.exit_code,
                            verification.command
                        );
                        eprintln!("Asking the agent to repair the verified changes.");
                    });

                    let mut retry = ExecMode::new(
                        self.config.clone(),
                        super::verification::build_retry_message(&verification),
                        self.agent_type.clone(),
                        self.runtime.clone(),
                        self.workspace_path.clone(),
                        self.output_patch.clone(),
                        self.verify_final_changes,
                        self.output_format,
                        ExecSessionOptions {
                            resume: Some(session_id.clone()),
                            ..Default::default()
                        },
                    );
                    retry.initial_diff_base = self.initial_diff_base.clone();
                    retry.initial_untracked_files = self.initial_untracked_files.clone();
                    retry.verification_retries_used = self.verification_retries_used + 1;
                    return Box::pin(retry.run()).await;
                } else {
                    self.print_text(|| {
                        eprintln!(
                            "\nFinal-change verification is still failing after {} attempt(s); \
                             finishing with unverified changes: {}",
                            self.verification_retries_used + 1,
                            verification.command
                        )
                    });
                }
            } else if self.output_format == ExecOutputFormat::StreamJson {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "type": "verify_skipped",
                        "session_id": &session_id,
                        "reason": "no_applicable_changed_files",
                    }))?
                );
            }
        }

        let (patch, patch_error) = if turn_settled {
            self.output_patch_if_needed()
        } else {
            (None, None)
        };
        if let Some((exit_kind, error)) = patch_error {
            let message = match terminal_message.take() {
                Some(existing) => format!("{existing}; {error}"),
                None => error.to_string(),
            };
            terminal_status = Some(ExecTerminalStatus::Error);
            terminal_exit_kind = Some(exit_kind);
            terminal_message = Some(message.clone());
            terminal_outcome = Some(Err(anyhow::anyhow!(message.clone())));
            final_stream_error = Some(message);
        }
        if terminal_outcome.is_none() {
            let message = "Execution ended without a terminal event".to_string();
            terminal_status = Some(ExecTerminalStatus::Error);
            terminal_exit_kind = Some(ExitKind::ExecError);
            terminal_message = Some(message.clone());
            terminal_outcome = Some(Err(anyhow::anyhow!(message.clone())));
            final_stream_error = Some(message);
        }
        if let Some(message) = final_stream_error.as_deref() {
            self.emit_stream_error(&session_id, message)?;
        } else if let Some(envelope) = deferred_terminal_envelope.as_ref() {
            self.emit_stream_envelope(envelope)?;
        }
        if let (Some(exit_kind), Some(message)) = (terminal_exit_kind, terminal_message.as_deref())
        {
            emit_exit_diagnostic(
                exit_kind,
                message,
                &self.exit_context(Some(&session_id), Some(&turn_id)),
            );
        }
        if self.output_format == ExecOutputFormat::Json {
            let result_text = terminal_message.unwrap_or(assistant_text);
            let result = match terminal_status.unwrap_or(ExecTerminalStatus::Error) {
                ExecTerminalStatus::Success => {
                    ExecJsonResult::success(&session_id, &turn_id, result_text, usage)
                }
                ExecTerminalStatus::Error => {
                    ExecJsonResult::error(&session_id, &turn_id, result_text, usage)
                }
                ExecTerminalStatus::Cancelled => {
                    ExecJsonResult::cancelled(&session_id, &turn_id, result_text, usage)
                }
            }
            .with_patch(patch);
            let result = result.with_verification(self.latest_verification.clone());
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        terminal_outcome
            .unwrap_or_else(|| Err(anyhow::anyhow!("Execution ended without a terminal event")))
    }

    fn print_exec_terminal(
        &self,
        event: &AgenticEvent,
        decision: &ExecTerminalDecision,
        tools: usize,
    ) {
        match event {
            AgenticEvent::DialogTurnCompleted { .. }
                if decision.status == ExecTerminalStatus::Success =>
            {
                self.print_text(|| {
                    eprintln!("\n");
                    eprintln!("Execution complete");
                    if tools > 0 {
                        eprintln!("\nTool call statistics: {} tools invoked", tools);
                    }
                });
            }
            AgenticEvent::DialogTurnCompleted { .. } | AgenticEvent::DialogTurnFailed { .. } => {
                if let Some(message) = decision.message.as_deref() {
                    self.print_text(|| eprintln!("\nExecution failed: {message}"));
                }
            }
            AgenticEvent::DialogTurnCancelled { .. } => {
                self.print_text(|| eprintln!("\nExecution cancelled"));
            }
            AgenticEvent::SystemError { .. } => {
                if let Some(message) = decision.message.as_deref() {
                    self.print_text(|| eprintln!("\nSystem error: {message}"));
                }
            }
            _ => {}
        }
    }

    async fn project_exec_nonterminal_event(
        &self,
        envelope: &openbitfun_events::AgenticEventEnvelope,
        session_id: &str,
        turn_id: &str,
        assistant_text: &mut String,
        usage: &mut Option<ExecTokenUsage>,
        total_tool_calls: &mut usize,
    ) -> Result<()> {
        self.emit_stream_envelope(envelope)?;
        let event = &envelope.event;
        if let Some(model_config_id) = ExecTokenUsage::accumulate_event(usage, event, turn_id) {
            self.record_resolved_model_config_id(session_id, model_config_id)
                .await;
        }

        match event {
            AgenticEvent::ModelRoundStarted {
                turn_id: event_turn_id,
                model_config_id,
                ..
            }
            | AgenticEvent::ModelRoundCompleted {
                turn_id: event_turn_id,
                model_config_id,
                ..
            } if event_turn_id == turn_id => {
                self.record_resolved_model_config_id(session_id, model_config_id)
                    .await;
            }
            AgenticEvent::TextChunk {
                turn_id: event_turn_id,
                text,
                ..
            } if event_turn_id == turn_id => {
                assistant_text.push_str(text);
                self.print_text(|| {
                    print!("{}", text);
                    std::io::stdout().flush().ok();
                });
            }
            AgenticEvent::ThinkingChunk {
                turn_id: event_turn_id,
                content,
                ..
            } if event_turn_id == turn_id => {
                self.print_text(|| {
                    eprint!("\x1b[2m{}\x1b[0m", content);
                    std::io::stderr().flush().ok();
                });
            }
            AgenticEvent::ToolEvent {
                turn_id: event_turn_id,
                tool_event,
                ..
            } if event_turn_id == turn_id => {
                use openbitfun_events::ToolEventData;
                match tool_event {
                    ToolEventData::ConfirmationNeeded { .. } => {}
                    ToolEventData::Started {
                        identity, params, ..
                    } => {
                        let (tool_name, input) = effective_event_invocation(identity, params);
                        self.print_tool_start_details(tool_name, &identity.tool_id, input);
                        *total_tool_calls += 1;
                    }
                    ToolEventData::Progress { message, .. } => {
                        self.print_text(|| eprintln!("   In progress: {}", message));
                    }
                    ToolEventData::Completed {
                        identity,
                        result_for_assistant,
                        result,
                        duration_ms,
                        ..
                    } => {
                        let tool_name = identity.effective_name();
                        let summary = result_for_assistant
                            .clone()
                            .unwrap_or_else(|| result.to_string());
                        self.print_text(|| {
                            eprintln!("   [+] {} ({}ms): {}", tool_name, duration_ms, summary)
                        });
                    }
                    ToolEventData::Failed {
                        identity, error, ..
                    } => {
                        let tool_name = identity.effective_name();
                        self.print_text(|| eprintln!("   [x] {}: {}", tool_name, error));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn record_resolved_model_config_id(&self, session_id: &str, model_config_id: &str) {
        let trimmed = model_config_id.trim();
        if trimmed.is_empty() || matches!(trimmed, "default" | "primary" | "fast") {
            return;
        }

        if let Err(error) = self.agent.update_session_model(session_id, trimmed).await {
            tracing::debug!(
                "Failed to persist resolved CLI model config id: session_id={}, model_config_id={}, error={}",
                session_id,
                trimmed,
                error
            );
        }
    }

    async fn prepare_session(&self) -> Result<String> {
        let resume_id = self.session_options.resume.as_deref();

        let resolved_resume = if self.session_options.continue_last || resume_id == Some("last") {
            let sessions = self.agent.list_sessions().await?;
            Some(
                sessions
                    .first()
                    .map(|session| session.session_id.clone())
                    .ok_or_else(|| anyhow::anyhow!("No history sessions for current project"))?,
            )
        } else {
            resume_id.map(ToString::to_string)
        };

        if self.session_options.fork_session {
            let source_session_id = resolved_resume
                .clone()
                .or_else(|| self.session_options.session_id.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!("--fork-session requires --continue, --resume, or --session")
                })?;
            let result = self
                .agent
                .branch_session_at_latest_turn(&source_session_id)
                .await?;
            self.agent.restore_session(&result.session_id).await?;
            return Ok(result.session_id);
        }

        if let Some(session_id) = resolved_resume.as_deref() {
            self.agent.restore_session(session_id).await?;
            return Ok(session_id.to_string());
        }

        if let Some(session_id) = &self.session_options.session_id {
            let session_id = self
                .agent
                .create_session_with_id(session_id.clone(), &self.agent_type)
                .await?;
            return Ok(session_id);
        }

        let session_id = self.agent.ensure_session(&self.agent_type).await?;
        Ok(session_id)
    }

    fn emit_stream_envelope(
        &self,
        envelope: &openbitfun_events::AgenticEventEnvelope,
    ) -> Result<()> {
        if self.output_format == ExecOutputFormat::StreamJson {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            writeln!(stdout, "{}", serialize_stream_envelope(envelope)?)?;
            stdout.flush()?;
        }
        Ok(())
    }

    fn emit_stream_error(&self, session_id: &str, message: &str) -> Result<()> {
        let envelope = openbitfun_events::AgenticEventEnvelope::new(
            AgenticEvent::SystemError {
                session_id: Some(session_id.to_string()),
                error: message.to_string(),
                recoverable: false,
            },
            openbitfun_events::AgenticEventPriority::Critical,
        );
        self.emit_stream_envelope(&envelope)
    }

    pub(super) fn print_text(&self, f: impl FnOnce()) {
        if self.output_format == ExecOutputFormat::Text {
            f();
        }
    }

    async fn wait_for_turn_settlement(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> std::result::Result<(), RuntimeError> {
        self.agent
            .wait_for_turn_settlement(
                session_id,
                turn_id,
                TURN_SETTLEMENT_TIMEOUT.as_millis() as u64,
            )
            .await
    }

    async fn observe_cancelled_turn_settlement(
        &self,
        event_rx: &mut tokio::sync::broadcast::Receiver<openbitfun_events::AgenticEventEnvelope>,
        session_id: &str,
        turn_id: &str,
    ) -> (
        Result<(
            Vec<openbitfun_events::AgenticEventEnvelope>,
            openbitfun_events::AgenticEventEnvelope,
        )>,
        std::result::Result<(), RuntimeError>,
    ) {
        tokio::join!(
            drain_interrupted_turn_events(event_rx, session_id, turn_id),
            self.wait_for_turn_settlement(session_id, turn_id),
        )
    }
}

pub(super) async fn drain_interrupted_turn_events(
    event_rx: &mut tokio::sync::broadcast::Receiver<openbitfun_events::AgenticEventEnvelope>,
    session_id: &str,
    turn_id: &str,
) -> Result<(
    Vec<openbitfun_events::AgenticEventEnvelope>,
    openbitfun_events::AgenticEventEnvelope,
)> {
    let deadline = Instant::now() + TURN_SETTLEMENT_TIMEOUT;
    let mut buffered = Vec::new();
    loop {
        let envelope = tokio::time::timeout_at(deadline, event_rx.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timed out draining the cancelled turn event"))?
            .map_err(|error| {
                anyhow::anyhow!("failed to drain the cancelled turn event: {error}")
            })?;
        if !event_belongs_to_exec_turn(&envelope.event, session_id, turn_id) {
            continue;
        }
        if is_exec_terminal(&envelope.event, turn_id) {
            return Ok((buffered, envelope));
        }
        buffered.push(envelope);
    }
}
