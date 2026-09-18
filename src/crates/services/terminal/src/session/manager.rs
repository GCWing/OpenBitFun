//! Session Manager - Manages terminal sessions lifecycle

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures::{Stream, StreamExt};
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch, RwLock};

use crate::config::{ShellConfig, TerminalConfig};
use crate::events::{TerminalEvent, TerminalEventEmitter};
use crate::pty::{ProcessProperty, PtyService, PtyServiceEvent};
use crate::shell::{
    CommandState, ScriptsManager, ShellDetector, ShellIntegration, ShellIntegrationEvent,
    ShellIntegrationManager, ShellType,
};
use crate::transcript::TranscriptRecorder;
use crate::{TerminalError, TerminalResult};

use super::{SessionSource, SessionStatus, TerminalSession};

const COMMAND_TIMEOUT_INTERRUPT_GRACE_MS: Duration = Duration::from_millis(500);

async fn prepare_shell_integration_input(
    session_integrations: &Arc<RwLock<HashMap<String, ShellIntegration>>>,
    session_id: &str,
    clear_output: bool,
) {
    let mut integrations = session_integrations.write().await;
    if let Some(integration) = integrations.get_mut(session_id) {
        integration.notify_input_written();
        if clear_output {
            integration.clear_output();
        }
    }
}

/// Why a command stream reached completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandCompletionReason {
    /// Command finished normally, including signal-driven exits not caused by timeout.
    Completed,
    /// Command hit the configured timeout and terminal attempted to interrupt it.
    TimedOut,
}

/// Result of executing a command
#[derive(Debug, Clone)]
pub struct CommandExecuteResult {
    /// The command that was executed
    pub command: String,
    /// Unique command ID
    pub command_id: String,
    /// Command output
    pub output: String,
    /// Exit code (if available)
    pub exit_code: Option<i32>,
    /// Why command execution stopped.
    pub completion_reason: CommandCompletionReason,
}

/// Options for command execution
#[derive(Debug, Clone)]
pub struct ExecuteOptions {
    /// Timeout for command execution (None = no timeout)
    pub timeout: Option<Duration>,
    /// Whether to prevent the command from being added to shell history
    pub prevent_history: bool,
}

impl Default for ExecuteOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            prevent_history: true,
        }
    }
}

/// Events emitted during streaming command execution
#[derive(Debug, Clone)]
pub enum CommandStreamEvent {
    /// Command has started executing
    Started { command_id: String },
    /// Output data received
    Output { data: String },
    /// Command reached a terminal state.
    Completed {
        exit_code: Option<i32>,
        total_output: String,
        completion_reason: CommandCompletionReason,
        /// Post-command terminal state: the most recent terminal output that
        /// was NOT part of the command's own output. This includes the shell
        /// prompt (e.g., `$ `, `dquote> `) and any other text the shell
        /// displayed after the command finished. AI agents can use this to
        /// understand the full terminal context and avoid misjudgments.
        shell_state: Option<String>,
    },
    /// Command execution failed
    Error { message: String },
}

/// A stream of command execution events
pub type CommandStream = Pin<Box<dyn Stream<Item = CommandStreamEvent> + Send>>;

fn compute_stream_output_delta(last_sent_output: &mut String, output: &str) -> Option<String> {
    if output.len() < last_sent_output.len() || !output.starts_with(last_sent_output.as_str()) {
        last_sent_output.clear();
    }

    let new_data = output
        .strip_prefix(last_sent_output.as_str())
        .filter(|data| !data.is_empty())
        .map(|data| data.to_string());

    last_sent_output.clear();
    last_sent_output.push_str(output);

    new_data
}

async fn get_integration_output_snapshot(
    session_integrations: &Arc<RwLock<HashMap<String, ShellIntegration>>>,
    session_id: &str,
) -> String {
    let integrations = session_integrations.read().await;
    integrations
        .get(session_id)
        .map(|i| i.get_output().to_string())
        .unwrap_or_default()
}

/// Get the post-command terminal state from shell integration.
/// Returns the most recent terminal output that was NOT part of the command's
/// own output — typically the shell prompt (e.g., `$ `, `dquote> `) or any
/// other text the shell displayed after the command finished.
async fn get_post_command_terminal_state(
    session_integrations: &Arc<RwLock<HashMap<String, ShellIntegration>>>,
    session_id: &str,
) -> Option<String> {
    let integrations = session_integrations.read().await;
    integrations.get(session_id).and_then(|i| {
        let recent = i.get_recent_plain_output().trim().to_string();
        if recent.is_empty() {
            None
        } else {
            Some(recent)
        }
    })
}

/// Session manager for terminal sessions
pub struct SessionManager {
    /// Configuration
    config: TerminalConfig,

    /// Active sessions
    sessions: Arc<RwLock<HashMap<String, TerminalSession>>>,

    /// PTY service
    pty_service: Arc<PtyService>,

    /// Event emitter
    event_emitter: Arc<TerminalEventEmitter>,

    /// Mapping from PTY ID to session ID
    pty_to_session: Arc<RwLock<HashMap<u32, String>>>,

    /// Shell integration manager
    integration_manager: Arc<ShellIntegrationManager>,

    /// Per-session shell integration instances
    session_integrations: Arc<RwLock<HashMap<String, ShellIntegration>>>,

    /// Session binding manager for external entity bindings
    binding: Arc<super::TerminalSessionBinding>,

    /// Shell integration scripts manager
    scripts_manager: ScriptsManager,

    /// Per-session output taps for real-time output streaming
    output_taps: Arc<DashMap<String, Vec<mpsc::Sender<Arc<str>>>>>,
    replay_watchers: Arc<DashMap<String, watch::Sender<u64>>>,

    /// Persistent plain-text transcripts for manually created terminal sessions.
    transcript_recorder: Option<TranscriptRecorder>,
}

impl SessionManager {
    /// Create a new session manager
    pub fn new(config: TerminalConfig) -> Self {
        // Initialize scripts manager and ensure scripts are up-to-date
        let scripts_manager = ScriptsManager::new(config.shell_integration.scripts_dir.clone());
        if let Err(e) = scripts_manager.ensure_scripts() {
            warn!("Failed to ensure shell integration scripts: {}", e);
        }

        let pty_service = Arc::new(PtyService::new(config.clone()));
        let event_emitter = Arc::new(TerminalEventEmitter::new(1024));
        let integration_manager = Arc::new(ShellIntegrationManager::new());
        let binding = Arc::new(super::TerminalSessionBinding::new());
        let output_taps = Arc::new(DashMap::new());
        let transcript_recorder = TranscriptRecorder::from_config(&config.transcript);

        let manager = Self {
            config,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pty_service,
            event_emitter,
            pty_to_session: Arc::new(RwLock::new(HashMap::new())),
            integration_manager,
            session_integrations: Arc::new(RwLock::new(HashMap::new())),
            binding,
            scripts_manager,
            output_taps,
            replay_watchers: Arc::new(DashMap::new()),
            transcript_recorder,
        };

        // Start event forwarding
        manager.start_event_forwarding();

        manager
    }

    /// Get the session binding manager
    ///
    /// Use this to manage bindings between external entities (e.g., chat sessions)
    /// and terminal sessions.
    pub fn binding(&self) -> Arc<super::TerminalSessionBinding> {
        self.binding.clone()
    }

    /// Start forwarding PTY service events to terminal events
    fn start_event_forwarding(&self) {
        let pty_service = self.pty_service.clone();
        let event_emitter = self.event_emitter.clone();
        let sessions = self.sessions.clone();
        let pty_to_session = self.pty_to_session.clone();
        let session_integrations = self.session_integrations.clone();
        let output_taps = self.output_taps.clone();
        let replay_watchers = self.replay_watchers.clone();
        let transcript_recorder = self.transcript_recorder.clone();

        tokio::spawn(async move {
            loop {
                if let Some(event) = pty_service.recv_event().await {
                    let pty_id = match &event {
                        PtyServiceEvent::ProcessData { id, .. } => *id,
                        PtyServiceEvent::ProcessReady { id, .. } => *id,
                        PtyServiceEvent::ProcessExit { id, .. } => *id,
                        PtyServiceEvent::ProcessProperty { id, .. } => *id,
                        PtyServiceEvent::ResizeCompleted { id, .. } => *id,
                    };

                    // `create_session` can receive PTY output before it has stored the
                    // PTY-to-session mapping. Retry every event type so initial shell output
                    // reaches both terminal consumers and the durable transcript. The mapping is
                    // inserted only after transcript setup has completed.
                    let session_id = {
                        let mapping = pty_to_session.read().await;
                        match mapping.get(&pty_id).cloned() {
                            Some(sid) => Some(sid),
                            None => {
                                drop(mapping);
                                let mut found = None;
                                for _ in 0..50 {
                                    tokio::time::sleep(Duration::from_millis(10)).await;
                                    let m = pty_to_session.read().await;
                                    if let Some(sid) = m.get(&pty_id).cloned() {
                                        found = Some(sid);
                                        break;
                                    }
                                }
                                found
                            }
                        }
                    };

                    if let Some(session_id) = session_id {
                        let terminal_event = match event {
                            PtyServiceEvent::ProcessData { data, .. } => {
                                // Zero-copy for valid UTF-8 (the common case);
                                // fall back to lossy conversion otherwise.
                                let data_str = match String::from_utf8(data) {
                                    Ok(text) => text,
                                    Err(error) => {
                                        String::from_utf8_lossy(error.as_bytes()).into_owned()
                                    }
                                };

                                // Update last activity and record to history.
                                let is_manual_session = if let Some(session) =
                                    sessions.write().await.get_mut(&session_id)
                                {
                                    session.touch();
                                    // Record output to history for frontend recovery
                                    session.add_output(&data_str);
                                    if let Some(watch) = replay_watchers.get(&session_id) {
                                        watch.send_replace(session.replay_history.cursor());
                                    }
                                    session.source == SessionSource::Manual
                                } else {
                                    false
                                };

                                // Process through shell integration.
                                let (has_shell_integration, si_events) = {
                                    let mut integrations = session_integrations.write().await;
                                    if let Some(integration) = integrations.get_mut(&session_id) {
                                        (true, integration.process_data(&data_str))
                                    } else {
                                        (false, Vec::new())
                                    }
                                };

                                if is_manual_session {
                                    if let Some(recorder) = &transcript_recorder {
                                        if has_shell_integration {
                                            for event in &si_events {
                                                match event {
                                                    ShellIntegrationEvent::CommandStarted {
                                                        command,
                                                        ..
                                                    } => match recorder
                                                        .record_command(&session_id, command)
                                                    {
                                                        Ok(()) => {}
                                                        Err(error) => {
                                                            warn!(
                                                                "Failed to record terminal transcript command: session_id={} error={}",
                                                                session_id, error
                                                            );
                                                        }
                                                    },
                                                    ShellIntegrationEvent::OutputData {
                                                        data,
                                                        ..
                                                    } => match recorder
                                                        .record_output(&session_id, data)
                                                    {
                                                        Ok(()) => {}
                                                        Err(error) => {
                                                            warn!(
                                                                "Failed to record terminal transcript output: session_id={} error={}",
                                                                session_id, error
                                                            );
                                                        }
                                                    },
                                                    _ => {}
                                                }
                                            }
                                        } else if let Err(error) =
                                            recorder.record_output(&session_id, &data_str)
                                        {
                                            warn!(
                                                "Failed to record terminal transcript output: session_id={} error={}",
                                                session_id, error
                                            );
                                        }
                                    }
                                }

                                // Emit shell integration events as terminal events after
                                // releasing the integration map lock.
                                for si_event in si_events {
                                    match si_event {
                                        ShellIntegrationEvent::CommandStarted {
                                            command,
                                            command_id,
                                        } => {
                                            let _ = event_emitter
                                                .emit(TerminalEvent::CommandStarted {
                                                    session_id: session_id.clone(),
                                                    command,
                                                    command_id,
                                                })
                                                .await;
                                        }
                                        ShellIntegrationEvent::CommandFinished {
                                            command_id,
                                            exit_code,
                                        } => {
                                            if is_manual_session {
                                                if let (Some(recorder), Some(exit_code)) =
                                                    (&transcript_recorder, exit_code)
                                                {
                                                    if let Err(error) = recorder
                                                        .record_exit_code(&session_id, exit_code)
                                                    {
                                                        warn!(
                                                            "Failed to record terminal transcript exit code: session_id={} error={}",
                                                            session_id, error
                                                        );
                                                    }
                                                }
                                            }
                                            let _ = event_emitter
                                                .emit(TerminalEvent::CommandFinished {
                                                    session_id: session_id.clone(),
                                                    command_id,
                                                    exit_code: exit_code.unwrap_or(0),
                                                })
                                                .await;
                                        }
                                        ShellIntegrationEvent::CwdChanged { cwd } => {
                                            if is_manual_session {
                                                if let Some(recorder) = &transcript_recorder {
                                                    if let Err(error) = recorder
                                                        .record_cwd_changed(&session_id, &cwd)
                                                    {
                                                        warn!(
                                                            "Failed to record terminal transcript cwd change: session_id={} error={}",
                                                            session_id, error
                                                        );
                                                    }
                                                }
                                            }
                                            if let Some(session) =
                                                sessions.write().await.get_mut(&session_id)
                                            {
                                                session.update_cwd(cwd.clone());
                                            }
                                            let _ = event_emitter
                                                .emit(TerminalEvent::CwdChanged {
                                                    session_id: session_id.clone(),
                                                    cwd,
                                                })
                                                .await;
                                        }
                                        _ => {}
                                    }
                                }

                                // Fan out raw data to output taps (e.g. background session file loggers).
                                // Share one Arc<str> allocation across all taps.
                                if let Some(mut senders) = output_taps.get_mut(&session_id) {
                                    if !senders.is_empty() {
                                        let shared: Arc<str> = Arc::from(data_str.as_str());
                                        senders.retain(|tx| tx.try_send(shared.clone()).is_ok());
                                    }
                                }

                                TerminalEvent::Data {
                                    session_id,
                                    data: data_str,
                                }
                            }
                            PtyServiceEvent::ProcessReady { pid, cwd, .. } => {
                                // Update session
                                if let Some(session) = sessions.write().await.get_mut(&session_id) {
                                    session.pid = Some(pid);
                                    session.cwd = cwd.clone();
                                    session.status = SessionStatus::Active;
                                    session.touch();
                                }

                                TerminalEvent::Ready {
                                    session_id,
                                    pid,
                                    cwd,
                                }
                            }
                            PtyServiceEvent::ProcessExit { exit_code, .. } => {
                                // Update session.
                                let is_manual_session = if let Some(session) =
                                    sessions.write().await.get_mut(&session_id)
                                {
                                    session.set_exited(exit_code.map(|code| code as i32));
                                    session.source == SessionSource::Manual
                                } else {
                                    false
                                };
                                if is_manual_session {
                                    if let Some(recorder) = &transcript_recorder {
                                        if let Err(error) = recorder.finish_session(
                                            &session_id,
                                            exit_code.map(|code| code as i32),
                                        ) {
                                            warn!(
                                                "Failed to finish terminal transcript: session_id={} error={}",
                                                session_id, error
                                            );
                                        }
                                    }
                                }

                                TerminalEvent::Exit {
                                    session_id,
                                    exit_code: exit_code.map(|c| c as i32),
                                }
                            }
                            PtyServiceEvent::ProcessProperty { property, .. } => match property {
                                ProcessProperty::Title(title) => {
                                    TerminalEvent::TitleChanged { session_id, title }
                                }
                                ProcessProperty::Cwd(cwd) => {
                                    if let Some(session) =
                                        sessions.write().await.get_mut(&session_id)
                                    {
                                        session.update_cwd(cwd.clone());
                                    }
                                    TerminalEvent::CwdChanged { session_id, cwd }
                                }
                                ProcessProperty::ShellType(shell_type) => {
                                    TerminalEvent::ShellTypeChanged {
                                        session_id,
                                        shell_type,
                                    }
                                }
                                _ => continue,
                            },
                            PtyServiceEvent::ResizeCompleted { cols, rows, .. } => {
                                // Update session dimensions
                                if let Some(session) = sessions.write().await.get_mut(&session_id) {
                                    session.cols = cols;
                                    session.rows = rows;
                                }
                                TerminalEvent::Resized {
                                    session_id,
                                    cols,
                                    rows,
                                }
                            }
                        };

                        let _ = event_emitter.emit(terminal_event).await;
                    }
                }
            }
        });
    }

    /// Create a new terminal session with shell integration
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session(
        &self,
        session_id: Option<String>,
        name: Option<String>,
        shell_type: Option<ShellType>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        source: Option<SessionSource>,
    ) -> TerminalResult<TerminalSession> {
        self.create_session_with_options(
            session_id, name, shell_type, cwd, env, cols, rows, true, source,
        )
        .await
    }

    /// Create a session with shell integration using a stable discovered shell ID.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session_with_shell_id(
        &self,
        session_id: Option<String>,
        name: Option<String>,
        shell_type: Option<ShellType>,
        shell_id: Option<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        source: Option<SessionSource>,
    ) -> TerminalResult<TerminalSession> {
        self.create_session_with_options_and_shell_id(
            session_id, name, shell_type, shell_id, cwd, env, cols, rows, true, source,
        )
        .await
    }

    /// Create a new terminal session with optional shell integration.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session_with_options(
        &self,
        session_id: Option<String>,
        name: Option<String>,
        shell_type: Option<ShellType>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        enable_integration: bool,
        source: Option<SessionSource>,
    ) -> TerminalResult<TerminalSession> {
        self.create_session_with_options_and_shell_id(
            session_id,
            name,
            shell_type,
            None,
            cwd,
            env,
            cols,
            rows,
            enable_integration,
            source,
        )
        .await
    }

    /// Create a session using an exact discovered shell when `shell_id` is supplied.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session_with_options_and_shell_id(
        &self,
        session_id: Option<String>,
        name: Option<String>,
        shell_type: Option<ShellType>,
        shell_id: Option<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        enable_integration: bool,
        source: Option<SessionSource>,
    ) -> TerminalResult<TerminalSession> {
        // Use provided session ID or generate a new one
        let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Check if session ID already exists
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(&session_id) {
                return Err(TerminalError::Session(format!(
                    "Session with ID '{}' already exists",
                    session_id
                )));
            }
        }

        // Resolve the executable before deriving the session shell type. This
        // preserves user PATH ordering and lets callers select a specific
        // discovered version by stable ID instead of falling back to a bare
        // command name such as `pwsh`.
        let requested_shell_type = shell_type.clone();
        let shell_from_id = match shell_id.as_deref() {
            Some(id) => Some(ShellDetector::find_shell_by_id(id).ok_or_else(|| {
                TerminalError::InvalidConfig(format!("Configured shell ID '{id}' is unavailable"))
            })?),
            None => None,
        };

        if let (Some(requested), Some(selected)) = (&requested_shell_type, &shell_from_id) {
            if requested != &selected.shell_type {
                return Err(TerminalError::InvalidConfig(format!(
                    "Configured shell ID '{}' does not match requested shell type '{}'",
                    selected.id, requested
                )));
            }
        }

        let configured_default = if requested_shell_type.is_none() && shell_from_id.is_none() {
            self.config
                .default_shell
                .as_deref()
                .and_then(ShellDetector::resolve_configured_shell)
        } else {
            None
        };
        let detected_for_type = requested_shell_type
            .as_ref()
            .and_then(ShellDetector::find_shell);
        let selected_shell = shell_from_id
            .or(configured_default)
            .or(detected_for_type)
            .or_else(|| {
                requested_shell_type
                    .is_none()
                    .then(ShellDetector::get_default_shell)
            });
        let shell_type = requested_shell_type.unwrap_or_else(|| {
            selected_shell
                .as_ref()
                .map(|shell| shell.shell_type.clone())
                .unwrap_or_else(|| ShellDetector::get_default_shell().shell_type)
        });

        // Determine working directory
        let cwd = cwd.unwrap_or_else(|| {
            self.config.default_cwd.clone().unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| ".".to_string())
            })
        });

        // Generate name
        let name = name.unwrap_or_else(|| format!("Terminal {}", &session_id[..8]));

        // Generate nonce for shell integration
        let nonce = uuid::Uuid::new_v4().to_string();

        // Launch the verified discovery result whenever one is available. This
        // avoids resolving a second, potentially different executable at PTY
        // spawn time and also keeps Git Bash away from the WSL compatibility
        // bash.exe.
        let shell_config_base = selected_shell
            .map(|shell| shell.to_config())
            .unwrap_or_else(|| ShellConfig {
                executable: shell_type.default_executable().to_string(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: None,
                login: false,
            });

        let mut shell_config = ShellConfig {
            executable: shell_config_base.executable,
            args: shell_config_base.args,
            env: self.config.env.clone(),
            cwd: Some(cwd.clone()),
            login: shell_config_base.login,
        };

        // Add custom environment
        if let Some(custom_env) = env {
            shell_config.env.extend(custom_env);
        }

        // Inject shell integration if enabled and supported
        if enable_integration && shell_type.supports_integration() {
            self.inject_shell_integration(&mut shell_config, &shell_type, &nonce);
        }

        // Use provided dimensions or fall back to config defaults
        let cols = cols.unwrap_or(self.config.default_cols);
        let rows = rows.unwrap_or(self.config.default_rows);

        // Create the session record
        let session = TerminalSession::new(
            session_id.clone(),
            name,
            shell_type.clone(),
            cwd,
            cols,
            rows,
            source.unwrap_or_default(),
        );

        // Store the session
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session.clone());
        }

        // Create shell integration instance
        if enable_integration && shell_type.supports_integration() {
            let mut integration = ShellIntegration::new();
            integration.set_nonce(nonce.clone());

            let mut integrations = self.session_integrations.write().await;
            integrations.insert(session_id.clone(), integration);

            self.integration_manager
                .register_session(&session_id, Some(nonce))
                .await;
        }

        // Create the PTY process
        let pty_id = self
            .pty_service
            .create_process(shell_config, shell_type, cols, rows)
            .await?;

        // Update session with PTY ID
        {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                session.pty_id = Some(pty_id);
            }
        }

        // Initialize durable capture before exposing this PTY to event forwarding, so a
        // fast shell's initial prompt cannot be recorded before its transcript exists.
        if let Some(recorder) = &self.transcript_recorder {
            if let Err(error) = recorder.start_session(&session) {
                warn!(
                    "Failed to start terminal transcript: session_id={} error={}",
                    session_id, error
                );
            }
        }

        // Store PTY to session mapping after transcript setup. Event forwarding retries early
        // PTY events until this mapping is available.
        {
            let mut mapping = self.pty_to_session.write().await;
            mapping.insert(pty_id, session_id.clone());
        }

        // Emit creation event
        let _ = self
            .event_emitter
            .emit(TerminalEvent::SessionCreated {
                session_id: session_id.clone(),
                pid: None,
                cwd: session.cwd.clone(),
            })
            .await;

        // Return the session
        let sessions = self.sessions.read().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| TerminalError::Session("Session was removed".to_string()))
    }

    /// Inject shell integration scripts and environment variables
    fn inject_shell_integration(
        &self,
        shell_config: &mut ShellConfig,
        shell_type: &ShellType,
        nonce: &str,
    ) {
        // Set environment variables for shell integration
        // NOTE: Do NOT set TERMINAL_SHELL_INTEGRATION here! The script checks this
        // variable and returns early if it's set. The script sets it itself.
        shell_config
            .env
            .insert("TERM_PROGRAM".to_string(), "terminal".to_string());
        shell_config
            .env
            .insert("TERMINAL_INJECTION".to_string(), "1".to_string());
        shell_config
            .env
            .insert("TERMINAL_NONCE".to_string(), nonce.to_string());

        // Get the script path from scripts manager
        let script_path = match self.scripts_manager.get_script_path(shell_type) {
            Some(p) => p,
            None => return,
        };

        match shell_type {
            ShellType::Bash => {
                // Check if original args had --login
                let had_login = shell_config
                    .args
                    .iter()
                    .any(|arg| arg == "--login" || arg == "-l");
                if had_login {
                    // Set env var for login shell handling (script will source profiles)
                    shell_config
                        .env
                        .insert("TERMINAL_SHELL_LOGIN".to_string(), "1".to_string());
                }
                // Clear all args and use --init-file with -i (interactive mode)
                // --init-file only works for interactive shells, so -i is required!
                shell_config.args.clear();
                shell_config.args.push("--init-file".to_string());
                // Convert path: use forward slashes but keep Windows format (C:/...)
                let path_str = script_path.to_string_lossy().to_string();
                #[cfg(windows)]
                let path_str = path_str.replace('\\', "/");
                shell_config.args.push(path_str);
                // IMPORTANT: Add -i to ensure bash runs in interactive mode
                // Without -i, --init-file won't be executed!
                shell_config.args.push("-i".to_string());
            }
            ShellType::Zsh => {
                // script_path is the ZDOTDIR (directory containing .zshrc)
                // Store original ZDOTDIR
                if let Ok(home) = std::env::var("HOME") {
                    shell_config.env.insert("USER_ZDOTDIR".to_string(), home);
                }
                shell_config.env.insert(
                    "ZDOTDIR".to_string(),
                    script_path.to_string_lossy().to_string(),
                );
            }
            ShellType::Fish => {
                // For fish, use source command to load the script file
                shell_config.args.push("--init-command".to_string());
                shell_config
                    .args
                    .push(format!("source '{}'", script_path.display()));
            }
            ShellType::PowerShell | ShellType::PowerShellCore => {
                // For PowerShell, use -ExecutionPolicy Bypass to avoid security errors
                // and -NoExit to keep the shell running after script execution
                shell_config.args.push("-ExecutionPolicy".to_string());
                shell_config.args.push("Bypass".to_string());
                shell_config.args.push("-NoLogo".to_string());
                shell_config.args.push("-NoExit".to_string());
                shell_config.args.push("-File".to_string());
                shell_config
                    .args
                    .push(script_path.to_string_lossy().to_string());
            }
            _ => {}
        }
    }

    /// Wait for a session to be ready for command execution
    ///
    /// This ensures both the session is active and shell integration is initialized.
    /// For new sessions, it waits for the shell integration to transition from Idle
    /// to Prompt/Input state, indicating the shell is ready to accept commands.
    #[allow(dead_code)]
    async fn wait_for_session_ready(&self, session_id: &str) -> TerminalResult<()> {
        Self::wait_for_session_ready_static(&self.sessions, &self.session_integrations, session_id)
            .await
    }

    /// Static version of wait_for_session_ready that takes explicit parameters
    async fn wait_for_session_ready_static(
        sessions: &Arc<RwLock<HashMap<String, TerminalSession>>>,
        session_integrations: &Arc<RwLock<HashMap<String, ShellIntegration>>>,
        session_id: &str,
    ) -> TerminalResult<()> {
        let ready_timeout = Duration::from_secs(30);
        let ready_start = std::time::Instant::now();
        let mut initial_integration_state = None;
        while ready_start.elapsed() < ready_timeout {
            // Check session status
            let session_status = {
                let sessions_guard = sessions.read().await;
                sessions_guard.get(session_id).map(|s| s.status.clone())
            };

            // Check shell integration state
            let integration_state = {
                let integrations = session_integrations.read().await;
                integrations.get(session_id).map(|i| i.state().clone())
            };

            // Remember the initial integration state
            if initial_integration_state.is_none() {
                initial_integration_state = integration_state.clone();
            }

            match (session_status, integration_state) {
                // Session active or starting with integration info available.
                // Accept Starting here because ProcessReady can be delayed by the
                // pty_to_session mapping race; the shell is functional once
                // integration reaches Prompt/Input regardless of session status.
                (Some(SessionStatus::Active), Some(int_state))
                | (Some(SessionStatus::Starting), Some(int_state)) => {
                    if initial_integration_state == Some(CommandState::Idle) {
                        match int_state {
                            CommandState::Prompt | CommandState::Input => {
                                return Ok(());
                            }
                            CommandState::Idle => {
                                if ready_start.elapsed() >= ready_timeout {
                                    return Ok(());
                                }
                                tokio::time::sleep(Duration::from_millis(500)).await;
                            }
                            _ => {
                                return Ok(());
                            }
                        }
                    } else {
                        return Ok(());
                    }
                }
                (Some(SessionStatus::Terminating), _) | (Some(SessionStatus::Exited { .. }), _) => {
                    return Err(TerminalError::Session(format!(
                        "Session {} is terminated",
                        session_id
                    )));
                }
                _ => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }

        Err(TerminalError::Session(format!(
            "Session {} did not become ready in {:?}. \
            Shell integration may have failed. This can happen if your shell config \
            (~/.bashrc, ~/.bash_profile, etc.) contains 'exec', 'exit', or 'return' statements \
            that interrupt the shell integration script. Please check your shell configuration.",
            session_id, ready_timeout
        )))
    }

    /// Execute a command in a session and wait for completion
    ///
    /// This function sends a command to the terminal, waits for it to complete
    /// using shell integration, and returns the output and exit code.
    pub async fn execute_command(
        &self,
        session_id: &str,
        command: &str,
    ) -> TerminalResult<CommandExecuteResult> {
        self.execute_command_with_options(session_id, command, ExecuteOptions::default())
            .await
    }

    /// Execute a command with custom options
    pub async fn execute_command_with_options(
        &self,
        session_id: &str,
        command: &str,
        options: ExecuteOptions,
    ) -> TerminalResult<CommandExecuteResult> {
        let mut stream = self.execute_command_stream_with_options(
            session_id.to_string(),
            command.to_string(),
            options,
        );
        let mut command_id = uuid::Uuid::new_v4().to_string();
        let mut output = String::new();

        while let Some(event) = stream.next().await {
            match event {
                CommandStreamEvent::Started {
                    command_id: started_command_id,
                } => {
                    command_id = started_command_id;
                }
                CommandStreamEvent::Output { data } => {
                    output.push_str(&data);
                }
                CommandStreamEvent::Completed {
                    exit_code,
                    total_output,
                    completion_reason,
                    shell_state: _,
                } => {
                    if !total_output.is_empty() {
                        output = total_output;
                    }

                    return Ok(CommandExecuteResult {
                        command: command.to_string(),
                        command_id,
                        output,
                        exit_code,
                        completion_reason,
                    });
                }
                CommandStreamEvent::Error { message } => {
                    return Err(TerminalError::Session(message));
                }
            }
        }

        Err(TerminalError::Session(format!(
            "Command stream ended unexpectedly for session {}",
            session_id
        )))
    }

    /// Execute a command and return a stream of events
    ///
    /// This function provides real-time streaming of command output,
    /// allowing callers to process output as it arrives.
    pub fn execute_command_stream(&self, session_id: String, command: String) -> CommandStream {
        self.execute_command_stream_with_options(session_id, command, ExecuteOptions::default())
    }

    /// Execute a command with options and return a stream of events
    pub fn execute_command_stream_with_options(
        &self,
        session_id: String,
        command: String,
        options: ExecuteOptions,
    ) -> CommandStream {
        let sessions = self.sessions.clone();
        let session_integrations = self.session_integrations.clone();
        let pty_service = self.pty_service.clone();
        let timeout_duration = options.timeout; // None means no timeout
        let prevent_history = options.prevent_history;

        let (tx, rx) = mpsc::channel::<CommandStreamEvent>(256);

        // Spawn the execution task
        tokio::spawn(async move {
            // Helper to send events
            let send = |event: CommandStreamEvent| {
                let tx = tx.clone();
                async move {
                    let _ = tx.send(event).await;
                }
            };

            // Wait for session to be ready before executing command
            if let Err(e) =
                Self::wait_for_session_ready_static(&sessions, &session_integrations, &session_id)
                    .await
            {
                send(CommandStreamEvent::Error {
                    message: format!("Session not ready: {}", e),
                })
                .await;
                return;
            }

            // Check if session exists
            let pty_id = {
                let sessions_guard = sessions.read().await;
                match sessions_guard.get(&session_id) {
                    Some(session) => session.pty_id,
                    None => {
                        send(CommandStreamEvent::Error {
                            message: format!("Session not found: {}", session_id),
                        })
                        .await;
                        return;
                    }
                }
            };

            let pty_id = match pty_id {
                Some(id) => id,
                None => {
                    send(CommandStreamEvent::Error {
                        message: "Session has no PTY".to_string(),
                    })
                    .await;
                    return;
                }
            };

            // Generate command ID
            let command_id = uuid::Uuid::new_v4().to_string();

            // Send started event
            send(CommandStreamEvent::Started {
                command_id: command_id.clone(),
            })
            .await;

            // Prepare the command
            let cmd_to_send = if prevent_history {
                format!(" {}\r", command)
            } else {
                format!("{}\r", command)
            };

            // End any previous command's late-output attribution before the PTY can
            // echo or render this new input.
            prepare_shell_integration_input(&session_integrations, &session_id, true).await;

            // Send the command
            if let Err(e) = pty_service.write(pty_id, cmd_to_send.as_bytes()).await {
                send(CommandStreamEvent::Error {
                    message: format!("Failed to send command: {}", e),
                })
                .await;
                return;
            }

            // Poll for output and completion
            let poll_interval = Duration::from_millis(50);
            let max_idle_checks = 20;
            let mut idle_count = 0;
            let mut last_output_len = 0;
            let mut last_sent_output = String::new();
            let start_time = std::time::Instant::now();
            let mut finished_exit_code: Option<Option<i32>> = None;
            let mut post_finish_idle_count = 0;
            let post_finish_idle_required = 4; // 200ms of idle after finish
            let mut timed_out = false;
            let mut timeout_interrupt_deadline: Option<tokio::time::Instant> = None;

            loop {
                if !timed_out {
                    if let Some(timeout_dur) = timeout_duration {
                        if start_time.elapsed() > timeout_dur {
                            timed_out = true;
                            timeout_interrupt_deadline = Some(
                                tokio::time::Instant::now() + COMMAND_TIMEOUT_INTERRUPT_GRACE_MS,
                            );

                            debug!(
                                "Command timed out in session {}, sending SIGINT",
                                session_id
                            );
                            if let Err(err) = pty_service.signal(pty_id, "SIGINT").await {
                                warn!(
                                    "Failed to interrupt timed out command in session {}: {}",
                                    session_id, err
                                );
                            }
                        }
                    }
                } else if let Some(deadline) = timeout_interrupt_deadline {
                    if tokio::time::Instant::now() >= deadline {
                        let output =
                            get_integration_output_snapshot(&session_integrations, &session_id)
                                .await;
                        let shell_state =
                            get_post_command_terminal_state(&session_integrations, &session_id)
                                .await;
                        send(CommandStreamEvent::Completed {
                            exit_code: finished_exit_code.flatten(),
                            total_output: output,
                            completion_reason: CommandCompletionReason::TimedOut,
                            shell_state,
                        })
                        .await;
                        return;
                    }
                }

                tokio::time::sleep(poll_interval).await;

                // Get current state, output, and command finished flag
                let (state, output, cmd_finished, last_exit) = {
                    let integrations = session_integrations.read().await;
                    if let Some(integration) = integrations.get(&session_id) {
                        let output = integration.get_output().to_string();
                        let cmd_finished = integration.command_just_finished();
                        let last_exit = integration.last_exit_code();
                        (integration.state().clone(), output, cmd_finished, last_exit)
                    } else {
                        send(CommandStreamEvent::Error {
                            message: "Integration not found".to_string(),
                        })
                        .await;
                        return;
                    }
                };

                // If command just finished, record it even if state already changed
                if cmd_finished && finished_exit_code.is_none() {
                    finished_exit_code = Some(last_exit);
                    post_finish_idle_count = 0;
                    last_output_len = output.len();
                    // Clear the flag
                    let mut integrations = session_integrations.write().await;
                    if let Some(integration) = integrations.get_mut(&session_id) {
                        integration.clear_command_finished();
                    }
                }

                let output_len = output.len();

                if let Some(new_data) =
                    compute_stream_output_delta(&mut last_sent_output, output.as_str())
                {
                    send(CommandStreamEvent::Output { data: new_data }).await;
                }

                // Check if command finished
                match state {
                    CommandState::Finished { exit_code } => {
                        // First time seeing Finished state - record it
                        if finished_exit_code.is_none() {
                            finished_exit_code = Some(exit_code);
                            post_finish_idle_count = 0;
                            last_output_len = output_len;
                        } else {
                            // Wait for output to stabilize after finish
                            if output_len == last_output_len {
                                post_finish_idle_count += 1;
                                if post_finish_idle_count >= post_finish_idle_required {
                                    let shell_state = get_post_command_terminal_state(
                                        &session_integrations,
                                        &session_id,
                                    )
                                    .await;
                                    send(CommandStreamEvent::Completed {
                                        exit_code: finished_exit_code.flatten(),
                                        total_output: output,
                                        completion_reason: if timed_out {
                                            CommandCompletionReason::TimedOut
                                        } else {
                                            CommandCompletionReason::Completed
                                        },
                                        shell_state,
                                    })
                                    .await;
                                    return;
                                }
                            } else {
                                post_finish_idle_count = 0;
                                last_output_len = output_len;
                            }
                        }
                    }
                    CommandState::Idle | CommandState::Prompt | CommandState::Input => {
                        // If we previously saw Finished and now see Prompt, we're done
                        // But wait for output to stabilize first (fix for intermittent output loss)
                        if finished_exit_code.is_some() {
                            if output_len == last_output_len {
                                post_finish_idle_count += 1;
                                // Wait at least 10 poll cycles (500ms) after seeing Prompt to ensure all output arrived
                                if post_finish_idle_count >= 10 {
                                    let shell_state = get_post_command_terminal_state(
                                        &session_integrations,
                                        &session_id,
                                    )
                                    .await;
                                    send(CommandStreamEvent::Completed {
                                        exit_code: finished_exit_code.flatten(),
                                        total_output: output,
                                        completion_reason: if timed_out {
                                            CommandCompletionReason::TimedOut
                                        } else {
                                            CommandCompletionReason::Completed
                                        },
                                        shell_state,
                                    })
                                    .await;
                                    return;
                                }
                            } else {
                                // New output arrived, reset counter
                                post_finish_idle_count = 0;
                                last_output_len = output_len;
                            }
                        } else {
                            // No finished_exit_code yet, use idle detection as fallback
                            if output_len == last_output_len {
                                idle_count += 1;
                                if idle_count >= max_idle_checks {
                                    let shell_state = get_post_command_terminal_state(
                                        &session_integrations,
                                        &session_id,
                                    )
                                    .await;
                                    send(CommandStreamEvent::Completed {
                                        exit_code: None,
                                        total_output: output,
                                        completion_reason: if timed_out {
                                            CommandCompletionReason::TimedOut
                                        } else {
                                            CommandCompletionReason::Completed
                                        },
                                        shell_state,
                                    })
                                    .await;
                                    return;
                                }
                            } else {
                                idle_count = 0;
                                last_output_len = output_len;
                            }
                        }
                    }

                    CommandState::Executing => {
                        idle_count = 0;
                        finished_exit_code = None;
                        last_output_len = output_len;
                    }
                }
            }
        });

        // Convert receiver to stream
        Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx))
    }

    /// Send a command to a session without waiting for completion
    ///
    /// This function waits for the session to be active, then sends a command
    /// to the terminal. Unlike `execute_command`, it does NOT require shell
    /// integration and does NOT wait for command completion or capture output.
    ///
    /// This is useful for:
    /// - Shells that don't support shell integration (e.g., cmd)
    /// - Startup commands where you don't need the result
    /// - Fire-and-forget command execution
    pub async fn send_command(&self, session_id: &str, command: &str) -> TerminalResult<()> {
        // Wait for session to be active
        self.wait_for_session_active(session_id).await?;

        // Format the command with carriage return
        let cmd_to_send = format!("{}\r", command);

        // Send the command
        self.write(session_id, cmd_to_send.as_bytes()).await
    }

    /// Wait for a session to become active (simpler than wait_for_session_ready)
    ///
    /// This only checks that the session exists and is in Active status.
    /// It does NOT require shell integration.
    async fn wait_for_session_active(&self, session_id: &str) -> TerminalResult<()> {
        let ready_timeout = Duration::from_secs(30);
        let ready_start = std::time::Instant::now();

        while ready_start.elapsed() < ready_timeout {
            let session_status = {
                let sessions = self.sessions.read().await;
                sessions.get(session_id).map(|s| s.status.clone())
            };

            match session_status {
                Some(SessionStatus::Active) => {
                    return Ok(());
                }
                Some(SessionStatus::Terminating) | Some(SessionStatus::Exited { .. }) => {
                    return Err(TerminalError::Session(format!(
                        "Session {} is terminated",
                        session_id
                    )));
                }
                Some(SessionStatus::Starting)
                | Some(SessionStatus::Orphaned)
                | Some(SessionStatus::Restoring)
                | None => {
                    // Still starting, restoring, or not found yet, wait
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }

        Err(TerminalError::Session(format!(
            "Session {} did not become active in {:?}",
            session_id, ready_timeout
        )))
    }

    /// Attach an explicit owner; cwd never establishes ownership.
    pub async fn set_owner(
        &self,
        session_id: &str,
        owner: super::SessionOwner,
    ) -> TerminalResult<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_owned()))?;
        session.metadata.owner = Some(owner);
        Ok(())
    }

    /// Get a session by ID
    pub async fn get_session(&self, session_id: &str) -> Option<TerminalSession> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }

    /// Cursor notifications must not clone the retained PTY history.
    pub async fn replay_cursor(&self, session_id: &str) -> Option<u64> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|session| session.replay_history.cursor())
    }

    pub async fn replay_page(
        &self,
        session_id: &str,
        after: u64,
        max_bytes: usize,
    ) -> Option<super::TerminalReplayPage> {
        self.sessions.read().await.get(session_id).map(|session| {
            session
                .replay_history
                .page(after, max_bytes, session.cols, session.rows)
        })
    }

    /// List all sessions
    pub async fn list_sessions(&self) -> Vec<TerminalSession> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    /// Write data to a session
    pub async fn write(&self, session_id: &str, data: &[u8]) -> TerminalResult<()> {
        let pty_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .and_then(|s| s.pty_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?
        };

        if !data.is_empty() {
            // Clear post-command attribution before the PTY can emit input echo,
            // PSReadLine predictions, or other rendering caused by this input.
            prepare_shell_integration_input(&self.session_integrations, session_id, false).await;
        }

        self.pty_service.write(pty_id, data).await
    }

    /// Resize a session
    ///
    /// This method:
    /// 1. Updates session dimensions
    /// 2. Flushes any buffered data in PTY service
    /// 3. Resizes the PTY
    /// 4. Emits a Resized event for frontend confirmation
    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> TerminalResult<()> {
        // Update session dimensions
        {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.resize(cols, rows);
            }
        }

        let pty_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .and_then(|s| s.pty_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?
        };

        // Resize PTY (this also flushes buffered data)
        // Do not send Resized event here because Windows ConPTY has a delay
        // PTY sends ResizeCompleted event after resize is completed,
        // This event is forwarded to TerminalEvent::Resized in start_event_forwarding()
        self.pty_service.resize(pty_id, cols, rows).await?;

        Ok(())
    }

    /// Send a signal to a session
    pub async fn signal(&self, session_id: &str, signal: &str) -> TerminalResult<()> {
        let pty_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .and_then(|s| s.pty_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?
        };

        self.pty_service.signal(pty_id, signal).await
    }

    /// Close a session
    pub async fn close_session(&self, session_id: &str, immediate: bool) -> TerminalResult<()> {
        let (pty_id, is_manual_session) = {
            let mut sessions = self.sessions.write().await;
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;

            session.status = SessionStatus::Terminating;
            (session.pty_id, session.source == SessionSource::Manual)
        };

        // Shutdown PTY if exists
        if let Some(pty_id) = pty_id {
            self.pty_service.shutdown(pty_id, immediate).await?;

            // Keep the mapping available for retry until shutdown is confirmed.
            let mut mapping = self.pty_to_session.write().await;
            mapping.remove(&pty_id);
        }

        if is_manual_session {
            if let Some(recorder) = &self.transcript_recorder {
                if let Err(error) = recorder.finish_session(session_id, None) {
                    warn!(
                        "Failed to finish terminal transcript: session_id={} error={}",
                        session_id, error
                    );
                }
            }
        }

        // Remove shell integration
        {
            let mut integrations = self.session_integrations.write().await;
            integrations.remove(session_id);
        }
        self.integration_manager
            .unregister_session(session_id)
            .await;

        // Drop output taps so file-writing tasks can detect session end
        self.output_taps.remove(session_id);
        self.replay_watchers.remove(session_id);

        // Remove session
        {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id);
        }

        // Remove any binding pointing to this session so the next get_or_create
        // creates a fresh session rather than returning a stale ID.
        // For primary sessions owner_id == session_id, so unbind(session_id) is sufficient.
        self.binding.unbind(session_id);

        // Emit session destroyed event for frontend
        let _ = self
            .event_emitter
            .emit(TerminalEvent::SessionDestroyed {
                session_id: session_id.to_string(),
            })
            .await;

        Ok(())
    }

    /// Acknowledge data received by frontend
    pub async fn acknowledge_data(
        &self,
        session_id: &str,
        char_count: usize,
    ) -> TerminalResult<()> {
        let pty_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .and_then(|s| s.pty_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?
        };

        self.pty_service.acknowledge_data(pty_id, char_count).await
    }

    /// Get the event emitter for subscribing to events
    pub fn event_emitter(&self) -> Arc<TerminalEventEmitter> {
        self.event_emitter.clone()
    }

    /// Get the shell integration manager
    pub fn integration_manager(&self) -> Arc<ShellIntegrationManager> {
        self.integration_manager.clone()
    }

    /// Check if a session has shell integration enabled
    pub async fn has_shell_integration(&self, session_id: &str) -> bool {
        let integrations = self.session_integrations.read().await;
        integrations.contains_key(session_id)
    }

    /// Get the current command state for a session
    pub async fn get_command_state(&self, session_id: &str) -> Option<CommandState> {
        let integrations = self.session_integrations.read().await;
        integrations.get(session_id).map(|i| i.state().clone())
    }

    /// Shutdown all sessions
    pub async fn shutdown_all(&self) {
        let session_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions.keys().cloned().collect()
        };

        for session_id in session_ids {
            if let Err(e) = self.close_session(&session_id, true).await {
                warn!("Failed to close session {}: {}", session_id, e);
            }
        }

        self.pty_service.shutdown_all().await;
    }

    /// A slow replay observer retains the newest cursor without buffering PTY
    /// bytes or dropping its subscription. Subscribe before creating a session.
    pub fn subscribe_replay_cursor(&self, session_id: &str) -> watch::Receiver<u64> {
        self.replay_watchers
            .entry(session_id.to_string())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    /// Subscribe to the raw PTY output of a specific session.
    ///
    /// Returns a receiver that yields raw output strings as they arrive from the PTY.
    /// The receiver will return `None` (channel closed) when the session is destroyed.
    /// Multiple subscriptions to the same session are supported.
    pub fn subscribe_session_output(&self, session_id: &str) -> mpsc::Receiver<Arc<str>> {
        let (tx, rx) = mpsc::channel(256);
        self.output_taps
            .entry(session_id.to_string())
            .or_default()
            .push(tx);
        rx
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::{compute_stream_output_delta, CommandCompletionReason};

    #[test]
    fn stream_output_delta_returns_utf8_suffix_without_cutting_chars() {
        let mut last_sent_output = "你好！我是 OpenBitFun，".to_string();
        let output = "你好！我是 OpenBitFun，可以帮助你完成软件工程任务。".to_string();

        let delta = compute_stream_output_delta(&mut last_sent_output, &output);

        assert_eq!(delta.as_deref(), Some("可以帮助你完成软件工程任务。"));
        assert_eq!(last_sent_output, output);
    }

    #[test]
    fn stream_output_delta_resets_when_previous_snapshot_is_not_prefix() {
        let mut last_sent_output = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxx".to_string();
        let output = "你好！我是 OpenBitFun，可以帮助你完成软件工程任务。有什么我可以帮你的吗？";

        let delta = compute_stream_output_delta(&mut last_sent_output, output);

        assert_eq!(delta.as_deref(), Some(output));
        assert_eq!(last_sent_output, output);
    }

    #[test]
    fn stream_output_delta_returns_none_when_output_is_unchanged() {
        let mut last_sent_output = "hello 你好".to_string();

        let delta = compute_stream_output_delta(&mut last_sent_output, "hello 你好");

        assert_eq!(delta, None);
        assert_eq!(last_sent_output, "hello 你好");
    }

    #[test]
    fn completion_reason_serializes_with_camel_case_contract() {
        assert_eq!(
            serde_json::to_string(&CommandCompletionReason::Completed).unwrap(),
            "\"completed\""
        );
        assert_eq!(
            serde_json::to_string(&CommandCompletionReason::TimedOut).unwrap(),
            "\"timedOut\""
        );
    }
}
