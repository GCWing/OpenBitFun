//! PTY Process management
//!
//! This module handles the low-level PTY process spawning, input/output,
//! and lifecycle management.
//!
//! The design separates concerns into independent components:
//! - `PtyWriter`: For writing data to the PTY (can be cloned and shared)
//! - `PtyEventStream`: For receiving events (can be moved to a separate task)
//! - `PtyController`: For control operations (resize, signal, shutdown)
//! - `FlowControl`: For managing data flow (shared state for backpressure)
//!
//! Windows ConPTY optimizations:
//! - Delayed resize for early calls
//! - Special handling for Git Bash (longer delay needed)
//! - Resize confirmation events for frontend synchronization

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

#[cfg(windows)]
use log::debug;
use log::{error, warn};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, ExitStatus, PtySize};
use tokio::sync::{mpsc, oneshot};

use crate::config::ShellConfig;
use crate::shell::ShellType;
use crate::{TerminalError, TerminalResult};

use super::flow_control::{HIGH_WATER_MARK, LOW_WATER_MARK};

/// Shutdown constants
mod shutdown {
    /// Time to wait for data flush after exit is queued
    pub(super) const DATA_FLUSH_TIMEOUT_MS: u64 = 250;
    /// Maximum time to wait for the managed child to report termination.
    pub(super) const EXIT_CONFIRM_TIMEOUT_MS: u64 = 5_000;
    /// Match portable-pty's Unix Child::kill grace before escalating SIGHUP.
    #[cfg(unix)]
    pub(super) const HANGUP_GRACE_MS: u64 = 200;
}

/// Resize constants for Windows ConPTY
#[cfg(windows)]
mod resize_constants {
    /// Delay before executing resize on Windows ConPTY
    /// This helps avoid issues where early resize calls are not respected
    pub(super) const CONPTY_RESIZE_DELAY_MS: u64 = 50;

    /// Delay for Git Bash on ConPTY (longer delay needed)
    /// Git Bash requires more time to properly handle resize
    pub(super) const GIT_BASH_RESIZE_DELAY_MS: u64 = 100;

    /// Delay for initial resize when cols/rows are 0
    /// This is used for DelayedResizer mechanism
    pub(super) const DELAYED_RESIZE_TIMEOUT_MS: u64 = 1000;

    /// Minimum delay between consecutive resize calls to prevent flooding
    pub(super) const RESIZE_THROTTLE_MS: u64 = 16; // ~60fps
}

/// Non-Windows resize constants
#[cfg(not(windows))]
mod resize_constants {
    /// Minimum delay between consecutive resize calls
    pub(super) const RESIZE_THROTTLE_MS: u64 = 16;
}

/// Internal commands for controlling the PTY process
#[derive(Debug)]
enum InternalCommand {
    /// Write data to PTY
    Write(Vec<u8>),
    /// Resize the PTY
    Resize { cols: u16, rows: u16 },
    /// Send a signal to the process
    Signal(String),
    /// Shutdown the process
    Shutdown {
        immediate: bool,
        completion: oneshot::Sender<TerminalResult<()>>,
    },
}

/// Events emitted by the PTY process
#[derive(Debug, Clone)]
pub enum PtyEvent {
    /// Data received from the PTY
    Data(Vec<u8>),
    /// Process is ready
    Ready { pid: u32, cwd: String },
    /// Process exited
    Exit { exit_code: Option<u32> },
    /// Title changed
    TitleChanged(String),
    /// CWD changed
    CwdChanged(String),
    /// Resize completed (for frontend synchronization)
    ResizeCompleted { cols: u16, rows: u16 },
}

/// Static information about the PTY process
#[derive(Debug, Clone)]
pub struct PtyInfo {
    /// Unique process ID (internal)
    pub id: u32,
    /// OS process ID
    pub pid: u32,
    /// Initial working directory
    pub initial_cwd: String,
    /// Shell type
    pub shell_type: ShellType,
}

// ============================================================================
// PtyWriter - For writing data to the PTY
// ============================================================================

/// PTY writer for sending data to the terminal.
///
/// This is clone-able and can be shared across tasks safely.
/// All writes are sent through a channel to avoid blocking.
#[derive(Clone)]
pub struct PtyWriter {
    command_tx: mpsc::Sender<InternalCommand>,
}

impl PtyWriter {
    /// Write data to the PTY
    pub async fn write(&self, data: &[u8]) -> TerminalResult<()> {
        self.command_tx
            .send(InternalCommand::Write(data.to_vec()))
            .await
            .map_err(|_| TerminalError::ProcessNotRunning)
    }

    /// Write data to the PTY (non-async version, may block briefly)
    pub fn write_blocking(&self, data: &[u8]) -> TerminalResult<()> {
        self.command_tx
            .blocking_send(InternalCommand::Write(data.to_vec()))
            .map_err(|_| TerminalError::ProcessNotRunning)
    }
}

// ============================================================================
// PtyEventStream - For receiving events from the PTY
// ============================================================================

/// PTY event stream for receiving events from the terminal.
///
/// This should be moved to a dedicated task for event processing.
/// It cannot be cloned - there is only one consumer of events.
pub struct PtyEventStream {
    event_rx: mpsc::Receiver<PtyEvent>,
}

impl PtyEventStream {
    /// Receive the next event from the PTY
    pub async fn recv(&mut self) -> Option<PtyEvent> {
        self.event_rx.recv().await
    }

    /// Try to receive an event without blocking
    pub fn try_recv(&mut self) -> Option<PtyEvent> {
        self.event_rx.try_recv().ok()
    }
}

// ============================================================================
// PtyController - For control operations
// ============================================================================

/// PTY controller for resize, signal, and shutdown operations.
///
/// This is clone-able and can be shared across tasks.
#[derive(Clone)]
pub struct PtyController {
    command_tx: mpsc::Sender<InternalCommand>,
    has_exited: Arc<AtomicBool>,
}

impl PtyController {
    /// Resize the PTY
    pub async fn resize(&self, cols: u16, rows: u16) -> TerminalResult<()> {
        self.command_tx
            .send(InternalCommand::Resize { cols, rows })
            .await
            .map_err(|_| TerminalError::ProcessNotRunning)
    }

    /// Send a signal to the process
    pub async fn signal(&self, signal: &str) -> TerminalResult<()> {
        self.command_tx
            .send(InternalCommand::Signal(signal.to_string()))
            .await
            .map_err(|_| TerminalError::ProcessNotRunning)
    }

    /// Shutdown the process
    pub async fn shutdown(&self, immediate: bool) -> TerminalResult<()> {
        if !self.is_running() {
            return Ok(());
        }
        let (completion, completed) = oneshot::channel();
        let sent = self
            .command_tx
            .send(InternalCommand::Shutdown {
                immediate,
                completion,
            })
            .await;
        if sent.is_err() {
            return if self.is_running() {
                Err(TerminalError::ProcessNotRunning)
            } else {
                Ok(())
            };
        }
        match completed.await {
            Ok(result) => result,
            // Natural exit can win the race with an already queued close.
            Err(_) if !self.is_running() => Ok(()),
            Err(_) => Err(TerminalError::ProcessNotRunning),
        }
    }

    /// Check if process is still running
    pub fn is_running(&self) -> bool {
        !self.has_exited.load(Ordering::Relaxed)
    }
}

// ============================================================================
// FlowControl - For managing data flow backpressure
// ============================================================================

/// Flow control state for managing backpressure.
///
/// This is used by the service layer to track unacknowledged data.
#[derive(Clone)]
pub struct FlowControl {
    /// Whether the process is paused (flow control)
    is_paused: Arc<AtomicBool>,
    /// Count of unacknowledged characters
    unacknowledged_chars: Arc<AtomicUsize>,
}

impl FlowControl {
    /// Create a new flow control instance
    fn new() -> Self {
        Self {
            is_paused: Arc::new(AtomicBool::new(false)),
            unacknowledged_chars: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Acknowledge received data (for flow control)
    pub fn acknowledge_data(&self, char_count: usize) {
        self.unacknowledged_chars.fetch_sub(
            char_count.min(self.unacknowledged_chars.load(Ordering::Relaxed)),
            Ordering::Relaxed,
        );

        // Resume if we were paused and now below low water mark
        if self.is_paused.load(Ordering::Relaxed)
            && self.unacknowledged_chars.load(Ordering::Relaxed) < LOW_WATER_MARK
        {
            self.is_paused.store(false, Ordering::Relaxed);
        }
    }

    /// Track output data for flow control
    pub fn track_output(&self, char_count: usize) -> bool {
        let new_count = self
            .unacknowledged_chars
            .fetch_add(char_count, Ordering::Relaxed)
            + char_count;

        // Check if we should pause
        if !self.is_paused.load(Ordering::Relaxed) && new_count > HIGH_WATER_MARK {
            self.is_paused.store(true, Ordering::Relaxed);
            return true;
        }

        false
    }

    /// Check if PTY is paused due to flow control
    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::Relaxed)
    }

    /// Clear all unacknowledged chars (e.g., after replay)
    pub fn clear_unacknowledged(&self) {
        self.unacknowledged_chars.store(0, Ordering::Relaxed);
        if self.is_paused.load(Ordering::Relaxed) {
            self.is_paused.store(false, Ordering::Relaxed);
        }
    }
}

// ============================================================================
// Spawn function - Creates all components
// ============================================================================

/// Result of spawning a PTY process
pub struct SpawnResult {
    /// Static information about the process
    pub info: PtyInfo,
    /// Writer for sending data to the PTY
    pub writer: PtyWriter,
    /// Event stream for receiving events (move this to a dedicated task)
    pub events: PtyEventStream,
    /// Controller for resize, signal, and shutdown
    pub controller: PtyController,
    /// Flow control for backpressure management
    pub flow_control: FlowControl,
}

/// Check if the shell is Git Bash (needs special handling on Windows)
#[cfg(windows)]
fn is_git_bash(executable: &str) -> bool {
    let lower = executable.to_lowercase();
    lower.ends_with("git\\bin\\bash.exe")
        || lower.ends_with("git/bin/bash.exe")
        || lower.contains("git\\usr\\bin\\bash")
        || lower.contains("git/usr/bin/bash")
}

/// Spawn a new PTY process and return independent components.
///
/// This function creates a PTY process and returns four independent components:
/// - `PtyWriter`: For writing data (can be cloned and shared)
/// - `PtyEventStream`: For receiving events (move to a dedicated task)
/// - `PtyController`: For control operations (can be cloned and shared)
/// - `FlowControl`: For backpressure management (can be cloned and shared)
///
/// # Example
///
/// ```ignore
/// let result = spawn_pty(id, &config, shell_type, 80, 24)?;
///
/// // Move event stream to a dedicated task
/// tokio::spawn(async move {
///     let mut events = result.events;
///     while let Some(event) = events.recv().await {
///         // Handle event
///     }
/// });
///
/// // Write to PTY (no locks needed!)
/// result.writer.write(b"ls\n").await?;
///
/// // Resize (no locks needed!)
/// result.controller.resize(100, 30).await?;
/// ```
pub fn spawn_pty(
    id: u32,
    shell_config: &ShellConfig,
    shell_type: ShellType,
    cols: u16,
    rows: u16,
) -> TerminalResult<SpawnResult> {
    // Create PTY system
    let pty_system = native_pty_system();

    // Create PTY pair with specified size
    let pty_pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Build command
    let mut cmd = CommandBuilder::new(&shell_config.executable);

    // Add arguments
    for arg in &shell_config.args {
        cmd.arg(arg);
    }

    // Set working directory
    let cwd = shell_config.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });
    cmd.cwd(&cwd);

    // Sanitize inherited host environment to avoid leaking Tauri dev/build
    // configuration into user terminals, then overlay terminal-specific env.
    apply_sanitized_environment(&mut cmd, &shell_config.env);

    // Set terminal type
    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
    }

    // Spawn the child process
    let mut child = pty_pair.slave.spawn_command(cmd)?;

    let pid = child.process_id().unwrap_or(0);
    let mut killer = child.clone_killer();

    // Create channels for communication
    let (command_tx, mut command_rx) = mpsc::channel::<InternalCommand>(256);
    let (event_tx, event_rx) = mpsc::channel::<PtyEvent>(1024);

    let has_exited = Arc::new(AtomicBool::new(false));

    // Get reader from PTY master
    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| TerminalError::Pty(format!("Failed to clone reader: {}", e)))?;

    // Take the writer from the master
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| TerminalError::Pty(format!("Failed to take writer: {}", e)))?;
    let writer = std::sync::Mutex::new(writer);

    // Keep master for resize operations
    let master = std::sync::Mutex::new(pty_pair.master);

    // Clone for read thread
    let has_exited_read = has_exited.clone();
    let event_tx_read = event_tx.clone();
    let (read_done_tx, mut read_done_rx) = oneshot::channel();

    // Start the read thread (native thread, not tokio)
    thread::spawn(move || {
        let mut buffer = vec![0u8; 8192];

        loop {
            if has_exited_read.load(Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buffer) {
                Ok(0) => {
                    // EOF
                    break;
                }
                Ok(n) => {
                    let data = buffer[..n].to_vec();

                    // Use try_send to avoid blocking
                    if event_tx_read.try_send(PtyEvent::Data(data)).is_err() {
                        // Channel full or closed
                        if event_tx_read.is_closed() {
                            break;
                        }
                        thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::WouldBlock
                        && e.kind() != std::io::ErrorKind::Interrupted
                    {
                        error!("PTY read error: {}", e);
                        break;
                    }
                    // WouldBlock/Interrupted - wait a bit and try again
                    thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
        let _ = read_done_tx.send(());
    });

    // Reap natural exits even while no commands arrive. A blocking waiter
    // sleeps in the OS; it adds no per-terminal polling timer or idle wakeups.
    let (exit_tx, mut exit_rx) = oneshot::channel();
    thread::spawn(move || {
        let _ = exit_tx.send(child.wait());
    });

    // Send ready event
    let _ = event_tx.try_send(PtyEvent::Ready {
        pid,
        cwd: cwd.clone(),
    });

    // Clone for command processing task
    let has_exited_cmd = has_exited.clone();

    // Check if this is Git Bash for special resize handling
    #[cfg(windows)]
    let is_git_bash_shell = is_git_bash(&shell_config.executable);

    // Track last resize time for throttling (use AtomicU64 to avoid lock issues with async)
    let last_resize_time = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // Start the command processing task
    tokio::spawn(async move {
        // For Windows with initial size 0x0, use delayed resize
        #[cfg(windows)]
        let mut delayed_resize: Option<(u16, u16)> = None;
        #[cfg(windows)]
        let mut delayed_resize_triggered = false;

        loop {
            let cmd = tokio::select! {
                biased;
                exited = receive_child_exit(&mut exit_rx) => {
                    match exited {
                        Ok(exit_code) => publish_child_exit(exit_code, &has_exited_cmd, &event_tx, &mut read_done_rx).await,
                        Err(error) => error!("Failed to observe PTY process exit: {}", error),
                    }
                    break;
                }
                command = command_rx.recv() => match command {
                    Some(command) => command,
                    None => break,
                }
            };
            match cmd {
                InternalCommand::Write(data) => {
                    if let Ok(mut writer_guard) = writer.lock() {
                        if let Err(e) = writer_guard.write_all(&data) {
                            error!("Failed to write to PTY: {}", e);
                        }
                        let _ = writer_guard.flush();
                    }
                }
                InternalCommand::Resize { cols, rows } => {
                    // Throttle resize calls to prevent flooding
                    // Use AtomicU64 to store timestamp as millis since UNIX_EPOCH
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let last_ms = last_resize_time.load(Ordering::Relaxed);
                    let elapsed = now_ms.saturating_sub(last_ms);

                    if elapsed < resize_constants::RESIZE_THROTTLE_MS {
                        let wait_time = resize_constants::RESIZE_THROTTLE_MS - elapsed;
                        tokio::time::sleep(tokio::time::Duration::from_millis(wait_time)).await;
                    }

                    // Update last resize time
                    let new_now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    last_resize_time.store(new_now_ms, Ordering::Relaxed);

                    // Windows ConPTY: special handling for resize
                    #[cfg(windows)]
                    {
                        // Handle delayed resize for Git Bash with initial 0x0 size
                        if is_git_bash_shell && cols == 0 && rows == 0 && !delayed_resize_triggered
                        {
                            debug!(
                                "Git Bash with 0x0 size detected, using delayed resize mechanism"
                            );
                            delayed_resize = Some((cols, rows));
                            // Schedule delayed resize trigger
                            let event_tx_delayed = event_tx.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(tokio::time::Duration::from_millis(
                                    resize_constants::DELAYED_RESIZE_TIMEOUT_MS,
                                ))
                                .await;
                                // Send a resize completed event to trigger frontend re-sync
                                let _ = event_tx_delayed
                                    .try_send(PtyEvent::ResizeCompleted { cols: 80, rows: 24 });
                            });
                            continue;
                        }

                        // Determine the appropriate delay based on shell type
                        let delay_ms = if is_git_bash_shell {
                            resize_constants::GIT_BASH_RESIZE_DELAY_MS
                        } else {
                            resize_constants::CONPTY_RESIZE_DELAY_MS
                        };

                        // Add delay before resize to avoid issues where early resize calls are not respected
                        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;

                        // Check if we have a pending delayed resize to apply
                        if let Some((pending_cols, pending_rows)) = delayed_resize.take() {
                            if pending_cols != cols || pending_rows != rows {
                                delayed_resize_triggered = true;
                            }
                        }
                    }

                    // Ensure cols and rows are at least 1 (prevents native exceptions)
                    let cols = cols.max(1);
                    let rows = rows.max(1);

                    if let Ok(master_guard) = master.lock() {
                        if let Err(e) = master_guard.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        }) {
                            warn!("Failed to resize PTY: {}", e);
                        } else {
                            // Send resize completed event for frontend synchronization
                            let _ = event_tx.try_send(PtyEvent::ResizeCompleted { cols, rows });
                        }
                    }
                }
                InternalCommand::Signal(signal) => {
                    // For now, we only support SIGINT via Ctrl+C
                    if signal == "SIGINT" || signal == "INT" {
                        if let Ok(mut writer_guard) = writer.lock() {
                            // Send Ctrl+C (ASCII 0x03)
                            let _ = writer_guard.write_all(&[0x03]);
                            let _ = writer_guard.flush();
                        }
                    }
                }
                InternalCommand::Shutdown {
                    immediate,
                    completion,
                } => match confirm_child_shutdown(killer.as_mut(), pid, &mut exit_rx, immediate)
                    .await
                {
                    Ok(exit_code) => {
                        publish_child_exit(
                            exit_code,
                            &has_exited_cmd,
                            &event_tx,
                            &mut read_done_rx,
                        )
                        .await;
                        let _ = completion.send(Ok(()));
                        break;
                    }
                    Err(error) => {
                        let can_still_wait = matches!(error, TerminalError::Timeout(_));
                        let _ = completion.send(Err(error));
                        if !can_still_wait {
                            // The exit result was consumed (or its sender
                            // failed); never poll that one-shot receiver again.
                            break;
                        }
                    }
                },
            }
        }
    });

    // Create the result components
    let info = PtyInfo {
        id,
        pid,
        initial_cwd: cwd,
        shell_type,
    };

    let pty_writer = PtyWriter {
        command_tx: command_tx.clone(),
    };

    let events = PtyEventStream { event_rx };

    let controller = PtyController {
        command_tx,
        has_exited,
    };

    let flow_control = FlowControl::new();

    Ok(SpawnResult {
        info,
        writer: pty_writer,
        events,
        controller,
        flow_control,
    })
}

fn apply_sanitized_environment(
    cmd: &mut CommandBuilder,
    overlay_env: &std::collections::HashMap<String, String>,
) {
    cmd.env_clear();

    for (key, value) in std::env::vars_os() {
        if should_preserve_parent_env(&key) {
            cmd.env(&key, &value);
        }
    }

    for (key, value) in overlay_env {
        cmd.env(key, value);
    }
}

fn should_preserve_parent_env(key: &OsStr) -> bool {
    !is_tauri_host_env(key)
}

fn is_tauri_host_env(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key == "TAURI_CONFIG"
        || key.starts_with("TAURI_ENV_")
        || key.starts_with("TAURI_ANDROID_PACKAGE_NAME_")
}

type ChildExitReceiver = oneshot::Receiver<std::io::Result<ExitStatus>>;

async fn receive_child_exit(exited: &mut ChildExitReceiver) -> TerminalResult<Option<u32>> {
    let status = exited
        .await
        .map_err(|_| TerminalError::ProcessNotRunning)??;
    Ok(Some(status.exit_code()))
}

async fn publish_child_exit(
    exit_code: Option<u32>,
    has_exited: &AtomicBool,
    events: &mpsc::Sender<PtyEvent>,
    read_done: &mut oneshot::Receiver<()>,
) {
    // Normally EOF immediately follows child exit. Retain the existing bounded
    // drain for a descendant that still holds a slave descriptor open.
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(shutdown::DATA_FLUSH_TIMEOUT_MS),
        read_done,
    )
    .await;
    has_exited.store(true, Ordering::Relaxed);
    // Exit is a lifecycle event: a temporarily full output queue must not drop it.
    let _ = events.send(PtyEvent::Exit { exit_code }).await;
}

async fn confirm_child_shutdown(
    killer: &mut (dyn ChildKiller + Send + Sync),
    _pid: u32,
    exited: &mut ChildExitReceiver,
    immediate: bool,
) -> TerminalResult<Option<u32>> {
    if !immediate {
        if let Ok(result) = tokio::time::timeout(
            std::time::Duration::from_millis(shutdown::DATA_FLUSH_TIMEOUT_MS),
            receive_child_exit(exited),
        )
        .await
        {
            return result;
        }
    }

    match exited.try_recv() {
        Ok(status) => return Ok(Some(status?.exit_code())),
        Err(oneshot::error::TryRecvError::Empty) => {}
        Err(oneshot::error::TryRecvError::Closed) => return Err(TerminalError::ProcessNotRunning),
    }

    let kill_error = killer.kill().err().map(|error| error.to_string());
    #[cfg(unix)]
    {
        // clone_killer sends only SIGHUP on Unix. Preserve Child::kill's
        // escalation for shells that ignore it, while the waiter owns reaping.
        if let Ok(result) = tokio::time::timeout(
            std::time::Duration::from_millis(shutdown::HANGUP_GRACE_MS),
            receive_child_exit(exited),
        )
        .await
        {
            return result;
        }
        if let Ok(pid) = i32::try_from(_pid) {
            if pid > 0 {
                // SAFETY: signal only the child PID returned by portable-pty.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
    tokio::time::timeout(
        std::time::Duration::from_millis(shutdown::EXIT_CONFIRM_TIMEOUT_MS),
        receive_child_exit(exited),
    )
    .await
    .unwrap_or_else(|_| {
        let detail = kill_error
            .as_deref()
            .map(|error| format!("; kill request failed: {error}"))
            .unwrap_or_default();
        Err(TerminalError::Timeout(format!(
            "PTY process did not exit after shutdown request{detail}"
        )))
    })
}

// ============================================================================
// Legacy compatibility - PtyCommand enum (for external use if needed)
// ============================================================================

/// Messages that can be sent to the PTY process (legacy compatibility)
#[derive(Debug, Clone)]
pub enum PtyCommand {
    /// Write data to PTY
    Write(Vec<u8>),
    /// Resize the PTY
    Resize { cols: u16, rows: u16 },
    /// Send a signal to the process
    Signal(String),
    /// Shutdown the process
    Shutdown { immediate: bool },
}

#[cfg(test)]
mod tests {
    use super::{is_tauri_host_env, spawn_pty, PtyEvent};
    use crate::config::ShellConfig;
    use crate::shell::ShellType;

    #[test]
    fn strips_tauri_host_configuration_from_parent_env() {
        assert!(is_tauri_host_env("TAURI_CONFIG".as_ref()));
        assert!(is_tauri_host_env("TAURI_ENV_TARGET_TRIPLE".as_ref()));
        assert!(is_tauri_host_env(
            "TAURI_ANDROID_PACKAGE_NAME_PREFIX".as_ref()
        ));
    }

    #[test]
    fn keeps_non_host_tauri_and_normal_env_vars() {
        assert!(!is_tauri_host_env("TAURI_PRIVATE_KEY".as_ref()));
        assert!(!is_tauri_host_env("PATH".as_ref()));
        assert!(!is_tauri_host_env("TERMINAL_NONCE".as_ref()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_returns_only_after_process_exit_is_confirmed() {
        let shell = if cfg!(windows) {
            ("cmd.exe", ShellType::Cmd)
        } else {
            ("/bin/sh", ShellType::Sh)
        };
        let mut spawned = spawn_pty(
            1,
            &ShellConfig {
                executable: shell.0.to_string(),
                ..ShellConfig::default()
            },
            shell.1,
            80,
            24,
        )
        .expect("spawn test PTY");

        spawned
            .controller
            .shutdown(true)
            .await
            .expect("shutdown test PTY");

        assert!(!spawned.controller.is_running());
        assert!(std::iter::from_fn(|| spawned.events.try_recv())
            .any(|event| matches!(event, PtyEvent::Exit { .. })));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn natural_exit_is_reaped_and_reports_final_output_without_a_close_request() {
        let (executable, args, shell_type) = if cfg!(windows) {
            (
                "cmd.exe",
                vec!["/d", "/c", "echo terminal-final-output & exit /b 7"],
                ShellType::Cmd,
            )
        } else {
            (
                "/bin/sh",
                vec!["-c", "printf 'terminal-final-output\\n'; exit 7"],
                ShellType::Sh,
            )
        };
        let mut spawned = spawn_pty(
            2,
            &ShellConfig {
                executable: executable.into(),
                args: args.into_iter().map(str::to_string).collect(),
                ..ShellConfig::default()
            },
            shell_type,
            80,
            24,
        )
        .expect("spawn naturally exiting PTY");
        let mut output = Vec::new();
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while let Some(event) = spawned.events.recv().await {
                match event {
                    PtyEvent::Data(data) => output.extend(data),
                    PtyEvent::Exit { exit_code } => return exit_code,
                    _ => {}
                }
            }
            panic!("PTY event stream ended without an exit status");
        })
        .await;
        if result.is_err() {
            spawned
                .controller
                .shutdown(true)
                .await
                .expect("clean up failed fixture");
        }
        assert_eq!(result.expect("natural exit notification"), Some(7));
        assert!(String::from_utf8_lossy(&output).contains("terminal-final-output"));
        assert!(!spawned.controller.is_running());
        spawned
            .controller
            .shutdown(true)
            .await
            .expect("close already exited PTY");
        assert!(!std::iter::from_fn(|| spawned.events.try_recv())
            .any(|event| matches!(event, PtyEvent::Exit { .. })));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_still_terminates_a_shell_ignoring_hangup() {
        let mut spawned = spawn_pty(
            3,
            &ShellConfig {
                executable: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    "trap '' HUP; printf 'hangup-ignored\\n'; read value".into(),
                ],
                ..ShellConfig::default()
            },
            ShellType::Sh,
            80,
            24,
        )
        .expect("spawn hangup-ignoring PTY");
        let mut output = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !String::from_utf8_lossy(&output).contains("hangup-ignored") {
                if let Some(PtyEvent::Data(data)) = spawned.events.recv().await {
                    output.extend(data);
                }
            }
        })
        .await
        .expect("shell installed hangup handler");
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            spawned.controller.shutdown(true),
        )
        .await
        .expect("shutdown deadline")
        .expect("confirmed shutdown");
        assert!(!spawned.controller.is_running());
        let exits: Vec<_> = std::iter::from_fn(|| spawned.events.try_recv())
            .filter_map(|event| match event {
                PtyEvent::Exit { exit_code } => Some(exit_code),
                _ => None,
            })
            .collect();
        assert_eq!(exits.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn closed_output_does_not_report_exit_before_the_child_finishes() {
        let mut spawned = spawn_pty(
            4,
            &ShellConfig {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "exec 0<&- 1>&- 2>&-; sleep 0.2; exit 9".into()],
                ..ShellConfig::default()
            },
            ShellType::Sh,
            80,
            24,
        )
        .expect("spawn early-EOF PTY");
        let started = std::time::Instant::now();
        let exit_code = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(PtyEvent::Exit { exit_code }) = spawned.events.recv().await {
                    break exit_code;
                }
            }
        })
        .await
        .expect("child exit notification");
        assert_eq!(exit_code, Some(9));
        assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        assert!(!spawned.controller.is_running());
    }
}
