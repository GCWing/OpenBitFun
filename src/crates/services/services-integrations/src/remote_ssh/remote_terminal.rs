//! Remote Terminal Session Management with PTY support
//!
//! Architecture:
//! - Each PTY has a single owner task that exclusively holds the russh Channel
//! - Reading: owner task calls `channel.wait()` and broadcasts output via `broadcast::Sender`
//! - Writing: callers send `PtyCommand::Write` via `mpsc::Sender` → owner task → `channel.data()`
//! - This eliminates Mutex deadlock between read and write operations

use crate::remote_ssh::manager::SSHConnectionManager;
use crate::remote_ssh::shell;
use anyhow::Context;
use std::collections::HashMap;
use std::sync::Arc;
use terminal_core::{spawn_pty, PtyEvent, SessionSource, ShellConfig, ShellType};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::time::{timeout, Duration};

/// `pwd` can hang on some hosts (e.g. path resolution touching an unreachable `/`) while the shell still works;
/// treat timeout the same as error and fall back to `~` for the initial `cd`.
const REMOTE_PWD_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct RemoteTerminalSession {
    pub workspace_id: Option<String>,
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: SessionStatus,
    pub cols: u16,
    pub rows: u16,
    pub source: SessionSource,
    pub replay: terminal_core::session::TerminalReplayHistory,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Inactive,
    Closed,
}

enum PtyCommand {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct ActiveHandle {
    output_tx: broadcast::Sender<Vec<u8>>,
    cmd_tx: mpsc::Sender<PtyCommand>,
}

pub struct CreateSessionResult {
    pub session: RemoteTerminalSession,
    pub output_rx: broadcast::Receiver<Vec<u8>>,
}

pub struct RemoteTerminalManager {
    sessions: Arc<RwLock<HashMap<String, RemoteTerminalSession>>>,
    ssh_manager: Arc<tokio::sync::RwLock<Option<SSHConnectionManager>>>,
    handles: Arc<RwLock<HashMap<String, ActiveHandle>>>,
}

impl RemoteTerminalManager {
    pub fn new(ssh_manager: SSHConnectionManager) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            ssh_manager: Arc::new(tokio::sync::RwLock::new(Some(ssh_manager))),
            handles: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn set_ssh_manager(&self, manager: SSHConnectionManager) {
        *self.ssh_manager.write().await = Some(manager);
    }

    /// Create a new remote terminal session.
    /// Returns a `CreateSessionResult` with a pre-subscribed output receiver.
    /// The owner task is spawned immediately — the output_rx is guaranteed to
    /// receive all data including the initial shell prompt.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session(
        &self,
        session_id: Option<String>,
        name: Option<String>,
        connection_id: &str,
        cols: u16,
        rows: u16,
        initial_cwd: Option<&str>,
        source: Option<SessionSource>,
    ) -> anyhow::Result<CreateSessionResult> {
        let manager = self
            .ssh_manager
            .read()
            .await
            .clone()
            .context("SSH manager not initialized")?;

        let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if session_id.is_empty() || self.sessions.read().await.contains_key(&session_id) {
            anyhow::bail!("Terminal session ID is empty or already exists");
        }
        if cols == 0 || rows == 0 {
            anyhow::bail!("Terminal dimensions must be positive");
        }
        let name = name.unwrap_or_else(|| {
            format!(
                "Remote Terminal {}",
                session_id.chars().take(8).collect::<String>()
            )
        });

        manager.ensure_connected(connection_id).await?;
        if manager.is_local_process_connection(connection_id).await {
            let cwd = if let Some(dir) = initial_cwd {
                dir.to_string()
            } else {
                match timeout(
                    REMOTE_PWD_PROBE_TIMEOUT,
                    manager.execute_command(connection_id, "pwd"),
                )
                .await
                {
                    Ok(Ok((output, _, 0))) if !output.trim().is_empty() => {
                        output.trim().to_string()
                    }
                    _ => "~".to_string(),
                }
            };
            let spec = manager
                .local_process_shell_spec(connection_id, (cwd != "~").then_some(cwd.as_str()))
                .await?
                .ok_or_else(|| anyhow::anyhow!("Local workspace shell is unavailable"))?;
            return self
                .create_local_workspace_session(
                    session_id,
                    name,
                    connection_id,
                    cols,
                    rows,
                    cwd,
                    source.unwrap_or_default(),
                    spec,
                )
                .await;
        }

        // Open PTY via manager, then extract the raw Channel
        let pty = manager
            .open_pty(connection_id, cols as u32, rows as u32)
            .await?;
        let mut channel = pty.into_channel().await.ok_or_else(|| {
            anyhow::anyhow!("Failed to extract channel from PTYSession — multiple references exist")
        })?;

        let cwd = if let Some(dir) = initial_cwd {
            dir.to_string()
        } else {
            match timeout(
                REMOTE_PWD_PROBE_TIMEOUT,
                manager.execute_command(connection_id, "pwd"),
            )
            .await
            {
                Ok(Ok((output, _, status))) => {
                    let out = output.trim();
                    if status == 0 && !out.is_empty() {
                        out.to_string()
                    } else {
                        log::debug!(
                            "remote_terminal: pwd empty or non-zero exit (status={}); using ~, connection_id={}",
                            status,
                            connection_id
                        );
                        "~".to_string()
                    }
                }
                Ok(Err(e)) => {
                    log::debug!(
                        "remote_terminal: pwd error: {}; using ~, connection_id={}",
                        e,
                        connection_id
                    );
                    "~".to_string()
                }
                Err(_elapsed) => {
                    log::debug!(
                        "remote_terminal: pwd timed out after {:?}; using ~, connection_id={}",
                        REMOTE_PWD_PROBE_TIMEOUT,
                        connection_id
                    );
                    "~".to_string()
                }
            }
        };

        // broadcast for output, mpsc for commands to the owner task
        let (output_tx, output_rx) = broadcast::channel::<Vec<u8>>(1000);
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<PtyCommand>(100);

        let initial_cd = cwd.clone();

        let session = RemoteTerminalSession {
            workspace_id: None,
            id: session_id.clone(),
            name,
            connection_id: connection_id.to_string(),
            cwd,
            pid: None,
            status: SessionStatus::Active,
            cols,
            rows,
            source: source.unwrap_or_default(),
            replay: Default::default(),
        };

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session.clone());
        }
        {
            let mut handles = self.handles.write().await;
            handles.insert(
                session_id.clone(),
                ActiveHandle {
                    output_tx: output_tx.clone(),
                    cmd_tx,
                },
            );
        }

        let mut writer = channel.make_writer();

        let task_session_id = session_id.clone();
        let task_handles = self.handles.clone();
        let task_sessions = self.sessions.clone();

        tokio::spawn(async move {
            log::info!(
                "Remote PTY owner task started: session_id={}",
                task_session_id
            );

            // cd to workspace directory silently (avoid `/` default — some hosts block listing `/`)
            if initial_cd != "/" && !initial_cd.is_empty() {
                let cd_arg = if initial_cd == "~" || initial_cd.starts_with("~/") {
                    initial_cd.clone()
                } else {
                    shell::escape_terminal_cwd(&initial_cd)
                };
                let cd_cmd = format!("cd {} && clear\n", cd_arg);
                if let Err(e) = writer.write_all(cd_cmd.as_bytes()).await {
                    log::warn!("Failed to cd to initial directory: {}", e);
                }
                let _ = writer.flush().await;
            }

            loop {
                tokio::select! {
                    biased; // prioritize commands over reads to avoid write starvation

                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(PtyCommand::Write(data)) => {
                                if let Err(e) = writer.write_all(&data).await {
                                    log::warn!("PTY write failed: session_id={}, error={}", task_session_id, e);
                                }
                                // flush to ensure data is sent immediately
                                let _ = writer.flush().await;
                            }
                            Some(PtyCommand::Resize(cols, rows)) => {
                                if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                    log::warn!("PTY resize failed: session_id={}, error={}", task_session_id, e);
                                }
                            }
                            Some(PtyCommand::Close) | None => {
                                log::info!("PTY close requested: session_id={}", task_session_id);
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }

                    msg = channel.wait() => {
                        match msg {
                            Some(russh::ChannelMsg::Data { data }) => {
                                if let Some(session) = task_sessions.write().await.get_mut(&task_session_id) {
                                    session.replay.record_output(session.cols, session.rows, &String::from_utf8_lossy(&data));
                                }
                                let _ = output_tx.send(data.to_vec());
                            }
                            Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                                if let Some(session) = task_sessions.write().await.get_mut(&task_session_id) {
                                    session.replay.record_output(session.cols, session.rows, &String::from_utf8_lossy(&data));
                                }
                                let _ = output_tx.send(data.to_vec());
                            }
                            Some(russh::ChannelMsg::Eof)
                            | Some(russh::ChannelMsg::Close)
                            | Some(russh::ChannelMsg::ExitStatus { .. }) => {
                                log::info!("Remote PTY closed: session_id={}", task_session_id);
                                break;
                            }
                            Some(_) => continue, // WindowAdjust, Success, etc.
                            None => {
                                log::info!("Remote PTY channel ended: session_id={}", task_session_id);
                                break;
                            }
                        }
                    }
                }
            }

            // Clean up
            {
                let mut handles = task_handles.write().await;
                handles.remove(&task_session_id);
            }
            {
                let mut sessions = task_sessions.write().await;
                if let Some(s) = sessions.get_mut(&task_session_id) {
                    s.status = SessionStatus::Closed;
                }
            }
            log::info!(
                "Remote PTY owner task exited: session_id={}",
                task_session_id
            );
        });

        Ok(CreateSessionResult { session, output_rx })
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_local_workspace_session(
        &self,
        session_id: String,
        name: String,
        connection_id: &str,
        cols: u16,
        rows: u16,
        cwd: String,
        source: SessionSource,
        (executable, args): (String, Vec<String>),
    ) -> anyhow::Result<CreateSessionResult> {
        let shell_type = ShellType::Custom(
            if executable == super::wsl::EXECUTABLE {
                "WSL"
            } else {
                "Docker"
            }
            .to_string(),
        );
        let shell_config = ShellConfig {
            executable,
            args,
            env: HashMap::new(),
            cwd: None,
            login: false,
        };
        let process_id = u32::from_le_bytes(
            uuid::Uuid::new_v4().as_bytes()[..4]
                .try_into()
                .expect("UUID prefix is four bytes"),
        );
        let spawned =
            spawn_pty(process_id, &shell_config, shell_type, cols, rows).map_err(|error| {
                anyhow::anyhow!("Failed to start local workspace terminal: {}", error)
            })?;

        let (output_tx, output_rx) = broadcast::channel::<Vec<u8>>(1000);
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<PtyCommand>(100);
        let pid = Some(spawned.info.pid);
        let mut events = spawned.events;
        let writer = spawned.writer;
        let controller = spawned.controller;
        let session = RemoteTerminalSession {
            workspace_id: None,
            id: session_id.clone(),
            name,
            connection_id: connection_id.to_string(),
            cwd,
            pid,
            status: SessionStatus::Active,
            cols,
            rows,
            source,
            replay: Default::default(),
        };
        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session.clone());
        self.handles.write().await.insert(
            session_id.clone(),
            ActiveHandle {
                output_tx: output_tx.clone(),
                cmd_tx,
            },
        );

        let task_handles = self.handles.clone();
        let task_sessions = self.sessions.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    command = cmd_rx.recv() => {
                        match command {
                            Some(PtyCommand::Write(data)) => {
                                if writer.write(&data).await.is_err() {
                                    break;
                                }
                            }
                            Some(PtyCommand::Resize(cols, rows)) => {
                                let _ = controller.resize(cols as u16, rows as u16).await;
                            }
                            Some(PtyCommand::Close) | None => {
                                let _ = controller.shutdown(true).await;
                                break;
                            }
                        }
                    }
                    event = events.recv() => {
                        match event {
                            Some(PtyEvent::Data(data)) => {
                                if let Some(session) = task_sessions.write().await.get_mut(&session_id) {
                                    session.replay.record_output(session.cols, session.rows, &String::from_utf8_lossy(&data));
                                }
                                let _ = output_tx.send(data);
                            }
                            Some(PtyEvent::Exit { .. }) | None => break,
                            Some(_) => {}
                        }
                    }
                }
            }
            task_handles.write().await.remove(&session_id);
            if let Some(session) = task_sessions.write().await.get_mut(&session_id) {
                session.status = SessionStatus::Closed;
            }
        });

        Ok(CreateSessionResult { session, output_rx })
    }

    pub async fn set_workspace_id(&self, session_id: &str, workspace_id: Option<String>) {
        if let Some(session) = self.sessions.write().await.get_mut(session_id) {
            session.workspace_id = workspace_id;
        }
    }

    pub async fn get_session(&self, session_id: &str) -> Option<RemoteTerminalSession> {
        self.sessions.read().await.get(session_id).cloned()
    }

    pub async fn replay_cursor(&self, session_id: &str) -> Option<u64> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|session| session.replay.cursor())
    }

    pub async fn replay_page(
        &self,
        session_id: &str,
        after: u64,
        max_bytes: usize,
    ) -> Option<terminal_core::session::TerminalReplayPage> {
        self.sessions.read().await.get(session_id).map(|session| {
            session
                .replay
                .page(after, max_bytes, session.cols, session.rows)
        })
    }

    pub async fn list_sessions(&self) -> Vec<RemoteTerminalSession> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.status != SessionStatus::Closed)
            .cloned()
            .collect()
    }

    pub async fn write(&self, session_id: &str, data: &[u8]) -> anyhow::Result<()> {
        let cmd_tx = {
            let handles = self.handles.read().await;
            handles
                .get(session_id)
                .map(|handle| handle.cmd_tx.clone())
                .context("Session not found or PTY not active")?
        };
        cmd_tx
            .send(PtyCommand::Write(data.to_vec()))
            .await
            .map_err(|_| anyhow::anyhow!("PTY task has exited"))
    }

    /// Run a captured command on the session's SSH target and initial directory.
    /// Interactive shell state is accessed through `write`, not a separate exec channel.
    pub async fn execute(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<terminal_core::ExecuteCommandResponse> {
        let session = self
            .get_session(session_id)
            .await
            .context("Terminal session is unavailable")?;
        let ssh = self
            .ssh_manager
            .read()
            .await
            .clone()
            .context("SSH manager is unavailable")?;
        let script = if session.cwd == "~" {
            command.to_string()
        } else {
            format!(
                "cd -- {} && {}",
                crate::remote_ssh::shell_quote_posix(&session.cwd),
                command
            )
        };
        let result = ssh
            .execute_command_with_options(
                &session.connection_id,
                &script,
                crate::remote_ssh::types::SSHCommandOptions {
                    timeout_ms,
                    cancellation_token: None,
                },
            )
            .await?;
        if result.interrupted {
            anyhow::bail!("Remote terminal command was interrupted; its effects may have occurred");
        }
        Ok(terminal_core::ExecuteCommandResponse {
            command: command.to_string(),
            command_id: uuid::Uuid::new_v4().to_string(),
            output: if result.stderr.is_empty() {
                result.stdout
            } else {
                format!("{}\n{}", result.stdout, result.stderr)
            },
            exit_code: (!result.timed_out).then_some(result.exit_code),
            completion_reason: if result.timed_out {
                terminal_core::CommandCompletionReason::TimedOut
            } else {
                terminal_core::CommandCompletionReason::Completed
            },
        })
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        if cols == 0 || rows == 0 {
            anyhow::bail!("Terminal dimensions must be positive");
        }
        let sender = self
            .handles
            .read()
            .await
            .get(session_id)
            .map(|handle| handle.cmd_tx.clone())
            .context("Session not found or PTY not active")?;
        sender
            .send(PtyCommand::Resize(cols as u32, rows as u32))
            .await
            .map_err(|_| anyhow::anyhow!("PTY task has exited"))?;
        if let Some(session) = self.sessions.write().await.get_mut(session_id) {
            session.cols = cols;
            session.rows = rows;
            session.replay.record_resize(cols, rows);
        }
        Ok(())
    }

    pub async fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        // Send close command to owner task
        let cmd_tx = {
            let handles = self.handles.read().await;
            handles.get(session_id).map(|handle| handle.cmd_tx.clone())
        };
        if let Some(cmd_tx) = cmd_tx {
            let _ = cmd_tx.send(PtyCommand::Close).await;
        }
        // Also remove from sessions map immediately so it disappears from list
        {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id);
        }
        Ok(())
    }

    pub async fn is_pty_active(&self, session_id: &str) -> bool {
        self.handles.read().await.contains_key(session_id)
    }

    pub async fn subscribe_output(
        &self,
        session_id: &str,
    ) -> anyhow::Result<broadcast::Receiver<Vec<u8>>> {
        let handles = self.handles.read().await;
        let handle = handles
            .get(session_id)
            .context("Session not found or PTY not active")?;
        Ok(handle.output_tx.subscribe())
    }
}

impl Clone for RemoteTerminalManager {
    fn clone(&self) -> Self {
        Self {
            sessions: self.sessions.clone(),
            ssh_manager: self.ssh_manager.clone(),
            handles: self.handles.clone(),
        }
    }
}
