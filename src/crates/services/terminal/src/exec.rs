//! Model-facing command execution runtime.
//!
//! This runtime is intentionally separate from terminal sessions. Each
//! `exec_command` starts a fresh local process; a session id is only retained
//! while that process is still running so later calls can poll or write stdin.

use crate::{shell::invalidate_cached_executable, TerminalError, TerminalResult};
mod output_decoder;
#[cfg(test)]
mod output_encoding_tests;

use output_decoder::OutputDecoder;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, SlavePty};
use rand::Rng;
use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::task::JoinHandle;
use uuid::Uuid;

const DEFAULT_YIELD_TIME_MS: u64 = 10_000;
pub(crate) const EXEC_TERMINAL_SIZE: openbitfun_runtime_ports::ExecTerminalSize =
    openbitfun_runtime_ports::ExecTerminalSize { cols: 80, rows: 24 };
const MAX_RETAINED_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EXEC_SESSIONS: usize = 64;
const MAX_COMPLETED_EXEC_SESSIONS: usize = 64;
#[cfg(unix)]
const PIPE_INTERRUPT_GRACE_TIMEOUT_MS: u64 = 2_000;
const PTY_EXIT_DRAIN_TIMEOUT_MS: u64 = 500;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const PIPE_JOB_CLOSE_WAIT_MS: u64 = 2_000;
#[cfg(windows)]
const PIPE_TASKKILL_WAIT_MS: u64 = 3_000;

static GLOBAL_EXEC_MANAGER: OnceLock<Arc<ExecProcessManager>> = OnceLock::new();

pub fn get_global_exec_process_manager() -> Arc<ExecProcessManager> {
    GLOBAL_EXEC_MANAGER
        .get_or_init(|| Arc::new(ExecProcessManager::default()))
        .clone()
}

#[derive(Debug, Clone)]
pub struct ExecCommandRequest {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub tty: bool,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
    pub lifecycle_tx: Option<mpsc::UnboundedSender<ExecProcessLifecycleEvent>>,
    pub output_capture_tx: Option<mpsc::UnboundedSender<String>>,
}

#[derive(Debug, Clone)]
pub struct WriteStdinRequest {
    pub session_id: i32,
    pub chars: String,
    pub append_enter: bool,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct SendStdinRequest {
    pub session_id: i32,
    pub chars: String,
    pub append_enter: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlAction {
    Interrupt,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlOrigin {
    ModelTool,
    OutOfBand,
}

#[derive(Debug, Clone)]
pub struct ExecControlRequest {
    pub session_id: i32,
    pub action: ExecControlAction,
    pub origin: ExecControlOrigin,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecSessionCompletionStatus {
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecSessionCompletionSource {
    Process,
    OutOfBandControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecSessionCompletion {
    pub status: ExecSessionCompletionStatus,
    pub source: ExecSessionCompletionSource,
}

#[derive(Debug, Clone)]
pub struct ExecCommandResponse {
    pub chunk_id: String,
    pub wall_time_seconds: f64,
    pub output: String,
    pub session_id: Option<i32>,
    pub exit_code: Option<i32>,
    pub original_output_chars: usize,
    pub completion: Option<ExecSessionCompletion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecProcessLifecycleStatus {
    Running,
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone)]
pub struct ExecProcessLifecycleEvent {
    pub session_id: i32,
    pub status: ExecProcessLifecycleStatus,
    pub exit_code: Option<i32>,
}

pub struct ExecProcessManager {
    sessions: Mutex<HashMap<i32, ExecSessionEntry>>,
    completed_sessions: Mutex<HashMap<i32, CompletedExecSession>>,
}

impl Default for ExecProcessManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            completed_sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct ExecSessionEntry {
    process: Arc<ExecProcess>,
    tty: bool,
    cursor: OutputCursor,
    last_used: tokio::time::Instant,
    lifecycle_tx: Option<mpsc::UnboundedSender<ExecProcessLifecycleEvent>>,
}

#[derive(Clone)]
struct CompletedExecSession {
    output: String,
    exit_code: Option<i32>,
    original_output_chars: usize,
    completion: ExecSessionCompletion,
    completed_at: tokio::time::Instant,
}

struct ExecProcess {
    output: Arc<OutputState>,
    writer: Option<mpsc::Sender<Vec<u8>>>,
    terminator: StdMutex<Option<Terminator>>,
    out_of_band_control_action: StdMutex<Option<ExecControlAction>>,
    helper_tasks: StdMutex<Vec<JoinHandle<()>>>,
    pty_handles: Arc<StdMutex<Option<PtyKeepAlive>>>,
    #[cfg(windows)]
    pipe_job: Option<WindowsPipeJobHandle>,
}

enum Terminator {
    Pty(Box<dyn portable_pty::ChildKiller + Send + Sync>),
    Pipe(mpsc::Sender<ExecControlAction>),
}

struct PtyKeepAlive {
    _master: Box<dyn MasterPty + Send>,
    _slave: Option<Box<dyn SlavePty + Send>>,
}

#[cfg(windows)]
type WindowsPipeJobHandle = Arc<StdMutex<Option<WindowsPipeJob>>>;

#[cfg(windows)]
struct WindowsPipeJob {
    _job: win32job::Job,
    _pid: u32,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
enum LocalPipeControlState {
    InterruptGrace { deadline: tokio::time::Instant },
}

#[cfg(unix)]
impl LocalPipeControlState {
    fn deadline(self) -> tokio::time::Instant {
        match self {
            Self::InterruptGrace { deadline } => deadline,
        }
    }
}

struct OutputState {
    inner: Mutex<OutputInner>,
    notify: Notify,
    output_capture_tx: Option<mpsc::UnboundedSender<String>>,
}

struct OutputInner {
    chunks: VecDeque<(u64, String)>,
    next_seq: u64,
    retained_bytes: usize,
    total_output_chars: usize,
    closed: bool,
    exit_code: Option<i32>,
}

#[derive(Clone)]
struct OutputCursor {
    next_seq: u64,
    observed_output_chars: usize,
}

struct HeadTailText {
    max_chars: usize,
    head_budget: usize,
    tail_budget: usize,
    head: String,
    /// UTF-8 bytes of the tail window; whole chars only (boundary-aligned).
    tail: VecDeque<u8>,
    head_chars: usize,
    tail_chars: usize,
    omitted_chars: usize,
    total_chars: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecOutputCapture {
    Combined,
    StdoutOnly,
}

impl ExecProcessManager {
    pub async fn is_session_active(&self, session_id: i32) -> bool {
        let process = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|entry| Arc::clone(&entry.process));

        match process {
            Some(process) => !process.output.is_closed().await,
            None => false,
        }
    }

    pub async fn exec_command(
        &self,
        request: ExecCommandRequest,
    ) -> TerminalResult<ExecCommandResponse> {
        self.exec_command_inner(request, None, ExecOutputCapture::Combined)
            .await
    }

    /// Runs a non-TTY command while draining stderr without adding it to the
    /// returned model-facing output.
    pub async fn exec_command_stdout(
        &self,
        request: ExecCommandRequest,
    ) -> TerminalResult<ExecCommandResponse> {
        if request.tty {
            return Err(TerminalError::InvalidConfig(
                "stdout-only capture does not support tty execution".to_string(),
            ));
        }
        self.exec_command_inner(request, None, ExecOutputCapture::StdoutOnly)
            .await
    }

    pub async fn exec_command_streaming(
        &self,
        request: ExecCommandRequest,
        output_tx: mpsc::Sender<String>,
    ) -> TerminalResult<ExecCommandResponse> {
        self.exec_command_inner(request, Some(output_tx), ExecOutputCapture::Combined)
            .await
    }

    async fn exec_command_inner(
        &self,
        request: ExecCommandRequest,
        output_tx: Option<mpsc::Sender<String>>,
        capture: ExecOutputCapture,
    ) -> TerminalResult<ExecCommandResponse> {
        let process = Arc::new(spawn_exec_process(&request, capture).await?);
        let cursor = OutputCursor {
            next_seq: 0,
            observed_output_chars: 0,
        };
        let session_id = self
            .store_session(
                Arc::clone(&process),
                request.tty,
                cursor.clone(),
                request.lifecycle_tx,
            )
            .await;
        let started_at = tokio::time::Instant::now();
        let collected = process
            .output
            .collect_until(
                cursor,
                deadline_from_now(request.yield_time_ms),
                request.max_output_chars.unwrap_or(usize::MAX),
                output_tx.as_ref(),
            )
            .await;

        let exit_code = process.output.exit_code().await;
        let closed = process.output.is_closed().await;
        let completion = if closed {
            Some(completion_for_closed_process(
                process.out_of_band_control_action(),
            ))
        } else {
            None
        };
        if closed {
            self.remove_session(session_id).await;
        } else {
            self.update_session_cursor(session_id, collected.cursor.clone())
                .await;
        }

        Ok(ExecCommandResponse {
            chunk_id: new_chunk_id(),
            wall_time_seconds: started_at.elapsed().as_secs_f64(),
            output: collected.output,
            session_id: (!closed).then_some(session_id),
            exit_code,
            original_output_chars: collected.original_output_chars,
            completion,
        })
    }

    pub async fn write_stdin(
        &self,
        request: WriteStdinRequest,
    ) -> TerminalResult<ExecCommandResponse> {
        self.write_stdin_inner(request, None).await
    }

    pub async fn write_stdin_streaming(
        &self,
        request: WriteStdinRequest,
        output_tx: mpsc::Sender<String>,
    ) -> TerminalResult<ExecCommandResponse> {
        self.write_stdin_inner(request, Some(output_tx)).await
    }

    pub async fn send_stdin(&self, request: SendStdinRequest) -> TerminalResult<()> {
        let (process, tty) = {
            let mut sessions = self.sessions.lock().await;
            let entry = sessions
                .get_mut(&request.session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(request.session_id.to_string()))?;
            entry.last_used = tokio::time::Instant::now();
            (Arc::clone(&entry.process), entry.tty)
        };

        let input = input_bytes_for_write(&request.chars, request.append_enter);
        if input.is_empty() {
            return Ok(());
        }
        if !tty {
            return Err(TerminalError::InvalidConfig(
                "stdin input requires a tty session".to_string(),
            ));
        }

        process.write_input_bytes(input).await
    }

    async fn write_stdin_inner(
        &self,
        request: WriteStdinRequest,
        output_tx: Option<mpsc::Sender<String>>,
    ) -> TerminalResult<ExecCommandResponse> {
        let (process, tty, cursor, lifecycle_tx) = {
            let mut sessions = self.sessions.lock().await;
            let Some(entry) = sessions.get_mut(&request.session_id) else {
                drop(sessions);
                if request.chars.is_empty() {
                    if let Some(completed) = self.take_completed_session(request.session_id).await {
                        return Ok(ExecCommandResponse {
                            chunk_id: new_chunk_id(),
                            wall_time_seconds: 0.0,
                            output: completed.output,
                            session_id: None,
                            exit_code: completed.exit_code,
                            original_output_chars: completed.original_output_chars,
                            completion: Some(completed.completion),
                        });
                    }
                }
                return Err(TerminalError::SessionNotFound(
                    request.session_id.to_string(),
                ));
            };
            entry.last_used = tokio::time::Instant::now();
            (
                Arc::clone(&entry.process),
                entry.tty,
                entry.cursor.clone(),
                entry.lifecycle_tx.clone(),
            )
        };

        let input = input_bytes_for_write(&request.chars, request.append_enter);
        if !input.is_empty() && tty {
            let writer = process
                .writer
                .as_ref()
                .ok_or(TerminalError::ProcessNotRunning)?;
            writer
                .send(input)
                .await
                .map_err(|_| TerminalError::ProcessNotRunning)?;
        }

        let started_at = tokio::time::Instant::now();
        let collected = process
            .output
            .collect_until(
                cursor,
                deadline_from_now(request.yield_time_ms),
                request.max_output_chars.unwrap_or(usize::MAX),
                output_tx.as_ref(),
            )
            .await;

        let closed = process.output.is_closed().await;
        let exit_code = process.output.exit_code().await;
        let completion = if closed {
            Some(completion_for_closed_process(
                process.out_of_band_control_action(),
            ))
        } else {
            None
        };
        if closed {
            emit_lifecycle(
                lifecycle_tx,
                ExecProcessLifecycleEvent {
                    session_id: request.session_id,
                    status: lifecycle_status_for_completion(
                        completion
                            .expect("closed process should have completion")
                            .status,
                    ),
                    exit_code,
                },
            );
            self.remove_session(request.session_id).await;
        } else {
            let mut sessions = self.sessions.lock().await;
            if let Some(entry) = sessions.get_mut(&request.session_id) {
                entry.cursor = collected.cursor.clone();
            }
        }

        Ok(ExecCommandResponse {
            chunk_id: new_chunk_id(),
            wall_time_seconds: started_at.elapsed().as_secs_f64(),
            output: collected.output,
            session_id: (!closed).then_some(request.session_id),
            exit_code,
            original_output_chars: collected.original_output_chars,
            completion,
        })
    }

    pub async fn control_session(
        &self,
        request: ExecControlRequest,
    ) -> TerminalResult<ExecCommandResponse> {
        let (process, tty, cursor, lifecycle_tx) = {
            let mut sessions = self.sessions.lock().await;
            let entry = sessions
                .get_mut(&request.session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(request.session_id.to_string()))?;
            entry.last_used = tokio::time::Instant::now();
            if request.origin == ExecControlOrigin::OutOfBand {
                entry.process.mark_out_of_band_control(request.action);
            }
            (
                Arc::clone(&entry.process),
                entry.tty,
                entry.cursor.clone(),
                entry.lifecycle_tx.clone(),
            )
        };

        match request.action {
            ExecControlAction::Interrupt if tty => {
                process.write_input_bytes(vec![0x03]).await?;
            }
            ExecControlAction::Interrupt | ExecControlAction::Kill => {
                process.request_control(request.action);
            }
        }

        let started_at = tokio::time::Instant::now();
        let collected = process
            .output
            .collect_until(
                cursor,
                deadline_from_now(request.yield_time_ms),
                request.max_output_chars.unwrap_or(usize::MAX),
                None,
            )
            .await;

        let closed = process.output.is_closed().await;
        let exit_code = process.output.exit_code().await;
        let completion = closed.then_some(ExecSessionCompletion {
            status: completion_status_for_control_action(request.action),
            source: match request.origin {
                ExecControlOrigin::ModelTool => ExecSessionCompletionSource::Process,
                ExecControlOrigin::OutOfBand => ExecSessionCompletionSource::OutOfBandControl,
            },
        });
        if closed {
            let status = lifecycle_status_for_completion(
                completion
                    .expect("closed process should have completion")
                    .status,
            );
            emit_lifecycle(
                lifecycle_tx,
                ExecProcessLifecycleEvent {
                    session_id: request.session_id,
                    status,
                    exit_code,
                },
            );
            self.remove_session(request.session_id).await;
            if request.origin == ExecControlOrigin::OutOfBand {
                self.store_completed_session(
                    request.session_id,
                    CompletedExecSession {
                        output: collected.output.clone(),
                        exit_code,
                        original_output_chars: collected.original_output_chars,
                        completion: completion.expect("closed process should have completion"),
                        completed_at: tokio::time::Instant::now(),
                    },
                )
                .await;
            }
        } else {
            if request.origin == ExecControlOrigin::ModelTool {
                let mut sessions = self.sessions.lock().await;
                if let Some(entry) = sessions.get_mut(&request.session_id) {
                    entry.cursor = collected.cursor.clone();
                }
            }
        }

        Ok(ExecCommandResponse {
            chunk_id: new_chunk_id(),
            wall_time_seconds: started_at.elapsed().as_secs_f64(),
            output: collected.output,
            session_id: (!closed).then_some(request.session_id),
            exit_code,
            original_output_chars: collected.original_output_chars,
            completion,
        })
    }

    async fn store_session(
        &self,
        process: Arc<ExecProcess>,
        tty: bool,
        cursor: OutputCursor,
        lifecycle_tx: Option<mpsc::UnboundedSender<ExecProcessLifecycleEvent>>,
    ) -> i32 {
        let (session_id, pruned_entry) = {
            let mut sessions = self.sessions.lock().await;
            let pruned = if sessions.len() >= MAX_EXEC_SESSIONS {
                sessions
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(id, _)| *id)
                    .and_then(|id| sessions.remove(&id).map(|entry| (id, entry)))
            } else {
                None
            };
            let session_id = new_session_id(&sessions);
            sessions.insert(
                session_id,
                ExecSessionEntry {
                    process: Arc::clone(&process),
                    tty,
                    cursor,
                    last_used: tokio::time::Instant::now(),
                    lifecycle_tx: lifecycle_tx.clone(),
                },
            );
            (session_id, pruned)
        };

        if let Some((pruned_session_id, entry)) = pruned_entry {
            emit_lifecycle(
                entry.lifecycle_tx.clone(),
                ExecProcessLifecycleEvent {
                    session_id: pruned_session_id,
                    status: ExecProcessLifecycleStatus::Pruned,
                    exit_code: None,
                },
            );
            entry.process.terminate();
        }

        emit_lifecycle(
            lifecycle_tx.clone(),
            ExecProcessLifecycleEvent {
                session_id,
                status: ExecProcessLifecycleStatus::Running,
                exit_code: None,
            },
        );
        spawn_lifecycle_exit_watcher(session_id, process, lifecycle_tx);

        session_id
    }

    async fn remove_session(&self, session_id: i32) {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(&session_id);
    }

    async fn update_session_cursor(&self, session_id: i32, cursor: OutputCursor) {
        let mut sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get_mut(&session_id) {
            entry.cursor = cursor;
        }
    }

    async fn store_completed_session(&self, session_id: i32, completed: CompletedExecSession) {
        let mut completed_sessions = self.completed_sessions.lock().await;
        if completed_sessions.len() >= MAX_COMPLETED_EXEC_SESSIONS {
            if let Some(oldest_session_id) = completed_sessions
                .iter()
                .min_by_key(|(_, session)| session.completed_at)
                .map(|(id, _)| *id)
            {
                completed_sessions.remove(&oldest_session_id);
            }
        }
        completed_sessions.insert(session_id, completed);
    }

    async fn take_completed_session(&self, session_id: i32) -> Option<CompletedExecSession> {
        self.completed_sessions.lock().await.remove(&session_id)
    }
}

impl Drop for ExecProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl ExecProcess {
    fn mark_out_of_band_control(&self, action: ExecControlAction) {
        if let Ok(mut out_of_band_action) = self.out_of_band_control_action.lock() {
            *out_of_band_action = Some(action);
        }
    }

    fn out_of_band_control_action(&self) -> Option<ExecControlAction> {
        self.out_of_band_control_action
            .lock()
            .ok()
            .and_then(|action| *action)
    }

    async fn write_input_bytes(&self, bytes: Vec<u8>) -> TerminalResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let writer = self
            .writer
            .as_ref()
            .ok_or(TerminalError::ProcessNotRunning)?;
        writer
            .send(bytes)
            .await
            .map_err(|_| TerminalError::ProcessNotRunning)
    }

    fn request_control(&self, action: ExecControlAction) {
        if let Ok(mut terminator) = self.terminator.lock() {
            if let Some(terminator) = terminator.take() {
                match terminator {
                    Terminator::Pty(mut killer) => {
                        let _ = killer.kill();
                    }
                    Terminator::Pipe(tx) => {
                        // Preserve the root for tree termination before closing its job.
                        let _ = tx.try_send(action);
                    }
                }
            }
        }
    }

    fn request_terminate(&self) {
        self.request_control(ExecControlAction::Kill);
    }

    fn terminate(&self) {
        self.request_terminate();
        self.close_windows_pipe_job("terminate");

        if let Ok(mut tasks) = self.helper_tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }

        if let Ok(mut handles) = self.pty_handles.lock() {
            handles.take();
        }
    }

    #[cfg(windows)]
    fn close_windows_pipe_job(&self, reason: &str) {
        if let Some(pipe_job) = &self.pipe_job {
            let _ = close_windows_pipe_job_handle(pipe_job, reason);
        }
    }

    #[cfg(not(windows))]
    fn close_windows_pipe_job(&self, _reason: &str) {}
}

impl OutputState {
    fn new(output_capture_tx: Option<mpsc::UnboundedSender<String>>) -> Self {
        Self {
            inner: Mutex::new(OutputInner {
                chunks: VecDeque::new(),
                next_seq: 0,
                retained_bytes: 0,
                total_output_chars: 0,
                closed: false,
                exit_code: None,
            }),
            notify: Notify::new(),
            output_capture_tx,
        }
    }

    async fn push_text(&self, chunk: String) {
        if chunk.is_empty() {
            return;
        }
        let decoded_chars = chunk.chars().count();
        let capture_text = self.output_capture_tx.as_ref().map(|_| chunk.clone());
        {
            let mut inner = self.inner.lock().await;
            let seq = inner.next_seq;
            inner.next_seq = inner.next_seq.saturating_add(1);
            inner.retained_bytes = inner.retained_bytes.saturating_add(chunk.len());
            inner.total_output_chars = inner.total_output_chars.saturating_add(decoded_chars);
            inner.chunks.push_back((seq, chunk));
            while inner.retained_bytes > MAX_RETAINED_OUTPUT_BYTES {
                if let Some((_, dropped)) = inner.chunks.pop_front() {
                    inner.retained_bytes = inner.retained_bytes.saturating_sub(dropped.len());
                } else {
                    break;
                }
            }
        }
        if let (Some(tx), Some(text)) = (&self.output_capture_tx, capture_text) {
            let _ = tx.send(text);
        }
        self.notify.notify_waiters();
    }

    async fn close(&self, exit_code: Option<i32>) {
        {
            let mut inner = self.inner.lock().await;
            inner.closed = true;
            inner.exit_code = exit_code;
        }
        self.notify.notify_waiters();
    }

    async fn is_closed(&self) -> bool {
        self.inner.lock().await.closed
    }

    async fn exit_code(&self) -> Option<i32> {
        self.inner.lock().await.exit_code
    }

    async fn wait_closed(&self) -> Option<i32> {
        loop {
            let notified = self.notify.notified();
            {
                let inner = self.inner.lock().await;
                if inner.closed {
                    return inner.exit_code;
                }
            }
            notified.await;
        }
    }

    async fn drain_since_with_output(
        &self,
        cursor: &mut OutputCursor,
        sink: &mut HeadTailText,
        output_tx: Option<&mpsc::Sender<String>>,
    ) -> bool {
        let inner = self.inner.lock().await;
        for (seq, chunk) in inner.chunks.iter() {
            if *seq >= cursor.next_seq {
                sink.push_str(chunk);
                if let Some(tx) = output_tx {
                    let _ = tx.try_send(chunk.clone());
                }
            }
        }
        cursor.next_seq = inner.next_seq;
        cursor.observed_output_chars = inner.total_output_chars;
        inner.closed
    }

    async fn collect_until(
        &self,
        mut cursor: OutputCursor,
        deadline: tokio::time::Instant,
        max_output_chars: usize,
        output_tx: Option<&mpsc::Sender<String>>,
    ) -> CollectedOutput {
        let mut sink = HeadTailText::new(max_output_chars);
        let initial_output_chars = cursor.observed_output_chars;

        loop {
            let closed = self
                .drain_since_with_output(&mut cursor, &mut sink, output_tx)
                .await;
            if closed || tokio::time::Instant::now() >= deadline {
                break;
            }

            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }

        let original_output_chars = cursor
            .observed_output_chars
            .saturating_sub(initial_output_chars);
        CollectedOutput {
            output: sink.render(),
            original_output_chars,
            cursor,
        }
    }
}

fn emit_lifecycle(
    lifecycle_tx: Option<mpsc::UnboundedSender<ExecProcessLifecycleEvent>>,
    event: ExecProcessLifecycleEvent,
) {
    if let Some(tx) = lifecycle_tx {
        let _ = tx.send(event);
    }
}

fn completion_status_for_control_action(action: ExecControlAction) -> ExecSessionCompletionStatus {
    match action {
        ExecControlAction::Interrupt => ExecSessionCompletionStatus::Interrupted,
        ExecControlAction::Kill => ExecSessionCompletionStatus::Killed,
    }
}

fn completion_for_closed_process(
    out_of_band_control_action: Option<ExecControlAction>,
) -> ExecSessionCompletion {
    if let Some(action) = out_of_band_control_action {
        return ExecSessionCompletion {
            status: completion_status_for_control_action(action),
            source: ExecSessionCompletionSource::OutOfBandControl,
        };
    }

    ExecSessionCompletion {
        status: ExecSessionCompletionStatus::Exited,
        source: ExecSessionCompletionSource::Process,
    }
}

fn lifecycle_status_for_completion(
    status: ExecSessionCompletionStatus,
) -> ExecProcessLifecycleStatus {
    match status {
        ExecSessionCompletionStatus::Exited => ExecProcessLifecycleStatus::Exited,
        ExecSessionCompletionStatus::Interrupted => ExecProcessLifecycleStatus::Interrupted,
        ExecSessionCompletionStatus::Killed => ExecProcessLifecycleStatus::Killed,
        ExecSessionCompletionStatus::Pruned => ExecProcessLifecycleStatus::Pruned,
    }
}

fn spawn_lifecycle_exit_watcher(
    session_id: i32,
    process: Arc<ExecProcess>,
    lifecycle_tx: Option<mpsc::UnboundedSender<ExecProcessLifecycleEvent>>,
) {
    if lifecycle_tx.is_none() {
        return;
    }

    tokio::spawn(async move {
        let exit_code = process.output.wait_closed().await;
        let completion = completion_for_closed_process(process.out_of_band_control_action());
        emit_lifecycle(
            lifecycle_tx,
            ExecProcessLifecycleEvent {
                session_id,
                status: lifecycle_status_for_completion(completion.status),
                exit_code,
            },
        );
    });
}

struct CollectedOutput {
    output: String,
    original_output_chars: usize,
    cursor: OutputCursor,
}

impl HeadTailText {
    fn new(max_chars: usize) -> Self {
        let head_budget = max_chars / 2;
        let tail_budget = max_chars.saturating_sub(head_budget);
        Self {
            max_chars,
            head_budget,
            tail_budget,
            head: String::with_capacity(head_budget.min(64 * 1024)),
            tail: VecDeque::new(),
            head_chars: 0,
            tail_chars: 0,
            omitted_chars: 0,
            total_chars: 0,
        }
    }

    fn push_str(&mut self, text: &str) {
        let incoming_chars = text.chars().count();
        self.total_chars = self.total_chars.saturating_add(incoming_chars);

        if self.max_chars == 0 {
            self.omitted_chars = self.omitted_chars.saturating_add(incoming_chars);
            return;
        }

        let mut remainder = text;
        let mut remainder_chars = incoming_chars;

        // Fill the head budget with one bulk copy.
        if self.head_chars < self.head_budget {
            let head_room = self.head_budget - self.head_chars;
            if remainder_chars <= head_room {
                self.head.push_str(remainder);
                self.head_chars += remainder_chars;
                return;
            }
            let split = remainder
                .char_indices()
                .nth(head_room)
                .map(|(index, _)| index)
                .unwrap_or(remainder.len());
            self.head.push_str(&remainder[..split]);
            self.head_chars += head_room;
            remainder = &remainder[split..];
            remainder_chars -= head_room;
        }

        if remainder.is_empty() {
            return;
        }

        if self.tail_budget == 0 {
            self.omitted_chars = self.omitted_chars.saturating_add(remainder_chars);
            return;
        }

        if remainder_chars >= self.tail_budget {
            // The new text alone fills the whole tail window: drop the current
            // tail and keep only the last `tail_budget` chars.
            self.omitted_chars = self
                .omitted_chars
                .saturating_add(self.tail_chars)
                .saturating_add(remainder_chars - self.tail_budget);
            self.tail.clear();
            let skip = remainder_chars - self.tail_budget;
            let start = remainder
                .char_indices()
                .nth(skip)
                .map(|(index, _)| index)
                .unwrap_or(0);
            self.tail.extend(remainder[start..].bytes());
            self.tail_chars = self.tail_budget;
            return;
        }

        self.tail.extend(remainder.bytes());
        self.tail_chars += remainder_chars;
        while self.tail_chars > self.tail_budget {
            self.pop_front_char();
            self.tail_chars -= 1;
            self.omitted_chars = self.omitted_chars.saturating_add(1);
        }
    }

    /// Removes one whole UTF-8 char from the front of the tail ring buffer.
    fn pop_front_char(&mut self) {
        if self.tail.pop_front().is_none() {
            return;
        }
        while matches!(self.tail.front(), Some(byte) if byte & 0b1100_0000 == 0b1000_0000) {
            self.tail.pop_front();
        }
    }

    fn render(self) -> String {
        let mut tail = self.tail;
        let tail_text = String::from_utf8_lossy(tail.make_contiguous());

        let mut output = self.head;
        if self.omitted_chars != 0 {
            output.push_str("\n... [truncated, middle omitted] ...\n");
        }
        output.push_str(&tail_text);
        output
    }
}

async fn spawn_exec_process(
    request: &ExecCommandRequest,
    capture: ExecOutputCapture,
) -> TerminalResult<ExecProcess> {
    if request.argv.is_empty() || request.argv[0].is_empty() {
        return Err(TerminalError::InvalidConfig(
            "missing command executable".to_string(),
        ));
    }
    if !request.cwd.is_dir() {
        return Err(TerminalError::InvalidConfig(format!(
            "working directory does not exist: {}",
            request.cwd.display()
        )));
    }

    if request.tty {
        spawn_pty_process(request).await
    } else {
        spawn_pipe_process(request, capture).await
    }
}

async fn spawn_pty_process(request: &ExecCommandRequest) -> TerminalResult<ExecProcess> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: EXEC_TERMINAL_SIZE.rows,
        cols: EXEC_TERMINAL_SIZE.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(&request.argv[0]);
    command.cwd(&request.cwd);
    apply_sanitized_environment_to_pty(&mut command, &request.env);
    for arg in request.argv.iter().skip(1) {
        command.arg(arg);
    }

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            invalidate_cached_executable(Path::new(&request.argv[0]));
            return Err(error.into());
        }
    };
    let killer = child.clone_killer();
    let output = Arc::new(OutputState::new(request.output_capture_tx.clone()));
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let writer = Arc::new(StdMutex::new(writer));
    let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(128);

    let reader_task = tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buffer[..n].to_vec();
                    if output_tx.blocking_send(chunk).is_err() {
                        break;
                    }
                }
                Err(ref error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    let output_task = tokio::spawn({
        let output = Arc::clone(&output);
        async move {
            let mut decoder = OutputDecoder::default();
            while let Some(chunk) = output_rx.recv().await {
                output.push_text(decoder.push(&chunk)).await;
            }
            output.push_text(decoder.finish()).await;
        }
    });

    let writer_task = tokio::spawn({
        let writer = Arc::clone(&writer);
        async move {
            while let Some(bytes) = writer_rx.recv().await {
                if let Ok(mut guard) = writer.lock() {
                    let _ = guard.write_all(&bytes);
                    let _ = guard.flush();
                }
            }
        }
    });

    let wait_blocking = tokio::task::spawn_blocking(move || {
        child.wait().ok().map(|status| status.exit_code() as i32)
    });
    let wait_output = Arc::clone(&output);
    let pty_handles = Arc::new(StdMutex::new(Some(PtyKeepAlive {
        _master: pair.master,
        _slave: if cfg!(windows) {
            Some(pair.slave)
        } else {
            None
        },
    })));
    let close_pty_handles = Arc::clone(&pty_handles);
    let close_task = tokio::spawn(async move {
        let code = wait_blocking.await.ok().flatten();
        writer_task.abort();
        if let Ok(mut handles) = close_pty_handles.lock() {
            handles.take();
        }

        let mut reader_task = reader_task;
        if tokio::time::timeout(
            Duration::from_millis(PTY_EXIT_DRAIN_TIMEOUT_MS),
            &mut reader_task,
        )
        .await
        .is_err()
        {
            reader_task.abort();
        }

        let mut output_task = output_task;
        if tokio::time::timeout(
            Duration::from_millis(PTY_EXIT_DRAIN_TIMEOUT_MS),
            &mut output_task,
        )
        .await
        .is_err()
        {
            output_task.abort();
        }
        wait_output.close(code).await;
    });

    Ok(ExecProcess {
        output,
        writer: Some(writer_tx),
        terminator: StdMutex::new(Some(Terminator::Pty(killer))),
        out_of_band_control_action: StdMutex::new(None),
        helper_tasks: StdMutex::new(vec![close_task]),
        pty_handles,
        #[cfg(windows)]
        pipe_job: None,
    })
}

async fn spawn_pipe_process(
    request: &ExecCommandRequest,
    capture: ExecOutputCapture,
) -> TerminalResult<ExecProcess> {
    let mut command = Command::new(&request.argv[0]);
    command.args(request.argv.iter().skip(1));
    command.current_dir(&request.cwd);
    command.env_clear();
    for (key, value) in sanitized_environment(&request.env) {
        command.env(key, value);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    configure_pipe_process_group(&mut command);
    configure_pipe_window_visibility(&mut command);
    command.kill_on_drop(true);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            invalidate_cached_executable(Path::new(&request.argv[0]));
            return Err(error.into());
        }
    };
    #[cfg(windows)]
    let pipe_job = create_windows_pipe_job(&child)?;

    #[cfg(windows)]
    let wait_task_pipe_job = Arc::clone(&pipe_job);
    #[cfg(unix)]
    let pipe_pgid = process_group_id(&child).ok_or(TerminalError::ProcessNotRunning)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = Arc::new(OutputState::new(request.output_capture_tx.clone()));

    let mut reader_tasks = Vec::new();
    #[cfg(unix)]
    let (reader_done_tx, mut reader_done_rx) = mpsc::channel::<()>(2);
    if let Some(stdout) = stdout {
        #[cfg(unix)]
        reader_tasks.push(spawn_pipe_reader_with_done(
            stdout,
            Arc::clone(&output),
            reader_done_tx.clone(),
        ));
        #[cfg(not(unix))]
        reader_tasks.push(spawn_pipe_reader(stdout, Arc::clone(&output)));
    }
    if let Some(stderr) = stderr {
        #[cfg(unix)]
        reader_tasks.push(match capture {
            ExecOutputCapture::Combined => {
                spawn_pipe_reader_with_done(stderr, Arc::clone(&output), reader_done_tx.clone())
            }
            ExecOutputCapture::StdoutOnly => {
                spawn_pipe_discard_reader_with_done(stderr, reader_done_tx.clone())
            }
        });
        #[cfg(not(unix))]
        reader_tasks.push(match capture {
            ExecOutputCapture::Combined => spawn_pipe_reader(stderr, Arc::clone(&output)),
            ExecOutputCapture::StdoutOnly => spawn_pipe_discard_reader(stderr),
        });
    }

    let (control_tx, mut control_rx) = mpsc::channel::<ExecControlAction>(1);
    let wait_output = Arc::clone(&output);
    #[cfg(unix)]
    let (child_exit_tx, mut child_exit_rx) = mpsc::channel::<Option<i32>>(1);
    #[cfg(unix)]
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(local_pipe_exit_code);
        let _ = child_exit_tx.send(code).await;
    });
    #[cfg(unix)]
    let wait_task = tokio::spawn(async move {
        let mut exit_code = None;
        let mut child_exited = false;
        let mut remaining_readers = reader_tasks.len();
        let mut control_state: Option<LocalPipeControlState> = None;
        // `request_control` takes the terminator, so the control sender is
        // dropped as soon as the first interrupt or kill is queued. Once that
        // happens `recv()` resolves to `None` instantly and forever, so the
        // branch has to be disarmed: leaving it armed starves the reader-done
        // branch, the loop never reaches its exit condition, and the session is
        // left open with no exit code (while re-signalling a dead process group
        // in a hot loop).
        let mut control_closed = false;

        loop {
            if let Some(state) = control_state {
                if tokio::time::Instant::now() >= state.deadline() {
                    signal_pipe_process_group_id(pipe_pgid, libc::SIGKILL);
                    control_state = None;
                }
            }

            if child_exited && remaining_readers == 0 {
                break;
            }

            let wait_budget = control_state
                .map(LocalPipeControlState::deadline)
                .map(|deadline| deadline.saturating_duration_since(tokio::time::Instant::now()))
                .filter(|duration| !duration.is_zero())
                .unwrap_or_else(|| Duration::from_millis(100));

            tokio::select! {
                biased;

                status = child_exit_rx.recv(), if !child_exited => {
                    exit_code = status.flatten();
                    child_exited = true;
                }

                action = control_rx.recv(), if !control_closed => {
                    match action {
                        Some(action) => {
                            control_state = request_unix_pipe_control(pipe_pgid, action);
                        }
                        None => control_closed = true,
                    }
                }

                done = reader_done_rx.recv(), if remaining_readers > 0 => {
                    if done.is_some() {
                        remaining_readers = remaining_readers.saturating_sub(1);
                    } else {
                        remaining_readers = 0;
                    }
                }

                _ = tokio::time::sleep(wait_budget), if control_state.is_some() => {}
            }
        }

        for task in reader_tasks {
            let _ = task.await;
        }
        wait_output.close(exit_code).await;
    });
    #[cfg(not(unix))]
    let wait_task = tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|status| status.code()),
            action = control_rx.recv() => {
                #[cfg(windows)]
                {
                    control_pipe_child(
                        &mut child,
                        &wait_task_pipe_job,
                        action.unwrap_or(ExecControlAction::Kill),
                    ).await
                }
                #[cfg(not(windows))]
                {
                    control_pipe_child(&mut child, action.unwrap_or(ExecControlAction::Kill)).await
                }
            }
        };
        #[cfg(windows)]
        let _ = close_windows_pipe_job_handle(&wait_task_pipe_job, "wait_task_complete");
        for task in reader_tasks {
            let _ = task.await;
        }
        wait_output.close(code).await;
    });

    Ok(ExecProcess {
        output,
        writer: None,
        terminator: StdMutex::new(Some(Terminator::Pipe(control_tx))),
        out_of_band_control_action: StdMutex::new(None),
        helper_tasks: StdMutex::new(vec![wait_task]),
        pty_handles: Arc::new(StdMutex::new(None)),
        #[cfg(windows)]
        pipe_job: Some(Arc::clone(&pipe_job)),
    })
}

/// Map a waited child status to an exit code the model can act on.
///
/// `ExitStatus::code()` is `None` when a process dies from a signal, which is
/// how every interrupt and kill ends a pipe-backed command. Reporting the
/// conventional `128 + signal` status keeps that case distinguishable from
/// "status unknown" and matches what a shell would report for the same death.
#[cfg(unix)]
fn local_pipe_exit_code(status: std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;

    status.code().or_else(|| status.signal().map(|s| 128 + s))
}

#[cfg(unix)]
fn configure_pipe_process_group(command: &mut Command) {
    // SAFETY: `pre_exec` runs between fork and exec, where only async-signal-safe
    // work is allowed. The closure calls nothing but `setsid`/`setpgid` and reads
    // `errno`; it allocates nothing and touches no shared state.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::EPERM) || libc::setpgid(0, 0) == -1 {
                    return Err(err);
                }
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_pipe_process_group(_command: &mut Command) {}

#[cfg(windows)]
fn configure_pipe_window_visibility(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_pipe_window_visibility(_command: &mut Command) {}

#[cfg(not(any(unix, windows)))]
async fn control_pipe_child(
    child: &mut tokio::process::Child,
    action: ExecControlAction,
) -> Option<i32> {
    match action {
        ExecControlAction::Interrupt => interrupt_pipe_child(child).await,
        ExecControlAction::Kill => kill_pipe_child(child).await,
    }
}

#[cfg(windows)]
async fn control_pipe_child(
    child: &mut tokio::process::Child,
    pipe_job: &WindowsPipeJobHandle,
    action: ExecControlAction,
) -> Option<i32> {
    match action {
        ExecControlAction::Interrupt => interrupt_pipe_child(child, pipe_job).await,
        ExecControlAction::Kill => kill_pipe_child(child, pipe_job).await,
    }
}

#[cfg(windows)]
async fn interrupt_pipe_child(
    child: &mut tokio::process::Child,
    pipe_job: &WindowsPipeJobHandle,
) -> Option<i32> {
    kill_pipe_child(child, pipe_job).await
}

#[cfg(windows)]
async fn wait_for_tree_killer(
    helper: &mut tokio::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    match tokio::time::timeout(timeout, helper.wait()).await {
        Ok(result) => result,
        Err(_) => {
            // Bound cleanup too: a stuck helper must not prevent job fallback.
            let _ = helper.start_kill();
            let _ =
                tokio::time::timeout(Duration::from_millis(PIPE_JOB_CLOSE_WAIT_MS), helper.wait())
                    .await;
            Err(std::io::Error::new(
                ErrorKind::TimedOut,
                "process-tree termination helper timed out",
            ))
        }
    }
}

#[cfg(windows)]
async fn kill_pipe_child(
    child: &mut tokio::process::Child,
    pipe_job: &WindowsPipeJobHandle,
) -> Option<i32> {
    // App Execution Alias descendants can live outside the job. Terminate
    // the process tree while its shell root is still alive.
    if let Some(pid) = child.id() {
        let pid = pid.to_string();
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid, "/T", "/F"]);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        {
            command.creation_flags(CREATE_NO_WINDOW);
        }

        command.kill_on_drop(true);
        let taskkill_result = match command.spawn() {
            Ok(mut helper) => {
                wait_for_tree_killer(&mut helper, Duration::from_millis(PIPE_TASKKILL_WAIT_MS))
                    .await
            }
            Err(error) => Err(error),
        };
        if let Err(error) = &taskkill_result {
            log::warn!("Process-tree termination failed; falling back to job termination: pid={}, error={}", pid, error);
        }

        if taskkill_result.is_ok_and(|status| status.success()) {
            if let Ok(wait_result) =
                tokio::time::timeout(Duration::from_millis(PIPE_JOB_CLOSE_WAIT_MS), child.wait())
                    .await
            {
                let _ = close_windows_pipe_job_handle(pipe_job, "kill_after_taskkill");
                return wait_result.ok().and_then(|status| status.code());
            }
        }
    }

    let _ = close_windows_pipe_job_handle(pipe_job, "kill_pipe_child");
    if let Ok(wait_result) =
        tokio::time::timeout(Duration::from_millis(PIPE_JOB_CLOSE_WAIT_MS), child.wait()).await
    {
        return wait_result.ok().and_then(|status| status.code());
    }

    let _ = child.kill().await;
    child.wait().await.ok().and_then(|status| status.code())
}

#[cfg(windows)]
fn create_windows_pipe_job(child: &tokio::process::Child) -> TerminalResult<WindowsPipeJobHandle> {
    let pid = child.id().ok_or(TerminalError::ProcessNotRunning)?;
    let raw_handle = child.raw_handle().ok_or(TerminalError::ProcessNotRunning)?;
    let job = win32job::Job::create().map_err(|error| {
        TerminalError::Io(std::io::Error::other(format!(
            "failed to create pipe job for pid {pid}: {error}"
        )))
    })?;
    let mut info = win32job::ExtendedLimitInfo::new();
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).map_err(|error| {
        TerminalError::Io(std::io::Error::other(format!(
            "failed to configure pipe job for pid {pid}: {error}"
        )))
    })?;
    job.assign_process(raw_handle as isize).map_err(|error| {
        TerminalError::Io(std::io::Error::other(format!(
            "failed to assign pid {pid} to pipe job: {error}"
        )))
    })?;
    Ok(Arc::new(StdMutex::new(Some(WindowsPipeJob {
        _job: job,
        _pid: pid,
    }))))
}

#[cfg(windows)]
fn close_windows_pipe_job_handle(pipe_job: &WindowsPipeJobHandle, reason: &str) -> bool {
    let Ok(mut guard) = pipe_job.lock() else {
        return false;
    };
    let Some(job) = guard.take() else {
        return false;
    };
    let _ = reason;
    drop(job);
    true
}

#[cfg(unix)]
fn process_group_id(child: &tokio::process::Child) -> Option<libc::pid_t> {
    child.id().map(|pid| pid as libc::pid_t)
}

#[cfg(unix)]
fn request_unix_pipe_control(
    pgid: libc::pid_t,
    action: ExecControlAction,
) -> Option<LocalPipeControlState> {
    match action {
        ExecControlAction::Interrupt => {
            signal_pipe_process_group_id(pgid, libc::SIGINT);
            Some(LocalPipeControlState::InterruptGrace {
                deadline: tokio::time::Instant::now()
                    + Duration::from_millis(PIPE_INTERRUPT_GRACE_TIMEOUT_MS),
            })
        }
        ExecControlAction::Kill => {
            signal_pipe_process_group_id(pgid, libc::SIGKILL);
            None
        }
    }
}

#[cfg(unix)]
fn signal_pipe_process_group_id(pgid: libc::pid_t, signal: libc::c_int) {
    // SAFETY: `killpg` is a plain syscall with no memory-safety contract. A
    // stale or already-reaped group id fails with ESRCH, which is ignored here
    // because a group that is already gone needs no signal.
    unsafe {
        libc::killpg(pgid, signal);
    }
}

#[cfg(not(any(unix, windows)))]
async fn interrupt_pipe_child(child: &mut tokio::process::Child) -> Option<i32> {
    kill_pipe_child(child).await
}

#[cfg(not(any(unix, windows)))]
async fn kill_pipe_child(child: &mut tokio::process::Child) -> Option<i32> {
    let _ = child.kill().await;
    child.wait().await.ok().and_then(|status| status.code())
}

#[cfg(not(unix))]
fn spawn_pipe_reader<R>(reader: R, output: Arc<OutputState>) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(read_pipe_output(reader, output))
}

async fn read_pipe_output<R>(mut reader: R, output: Arc<OutputState>)
where
    R: AsyncRead + Unpin,
{
    let mut decoder = OutputDecoder::default();
    let mut buffer = vec![0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => output.push_text(decoder.push(&buffer[..n])).await,
            Err(ref error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    output.push_text(decoder.finish()).await;
}

#[cfg(not(unix))]
fn spawn_pipe_discard_reader<R>(mut reader: R) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(ref error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}

#[cfg(unix)]
fn spawn_pipe_reader_with_done<R>(
    reader: R,
    output: Arc<OutputState>,
    done_tx: mpsc::Sender<()>,
) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        read_pipe_output(reader, output).await;
        let _ = done_tx.send(()).await;
    })
}

#[cfg(unix)]
fn spawn_pipe_discard_reader_with_done<R>(
    mut reader: R,
    done_tx: mpsc::Sender<()>,
) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(ref error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = done_tx.send(()).await;
    })
}

fn apply_sanitized_environment_to_pty(
    command: &mut CommandBuilder,
    overlay: &HashMap<String, String>,
) {
    command.env_clear();
    for (key, value) in sanitized_environment(overlay) {
        command.env(key, value);
    }
}

fn sanitized_environment(overlay: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (key, value) in std::env::vars() {
        if !is_tauri_host_env(&key) {
            env.insert(key, value);
        }
    }
    for (key, value) in overlay {
        env.insert(key.clone(), value.clone());
    }
    env
}

fn is_tauri_host_env(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key == "TAURI_CONFIG"
        || key.starts_with("TAURI_ENV_")
        || key.starts_with("TAURI_ANDROID_PACKAGE_NAME_")
}

fn deadline_from_now(yield_time_ms: Option<u64>) -> tokio::time::Instant {
    tokio::time::Instant::now()
        + Duration::from_millis(yield_time_ms.unwrap_or(DEFAULT_YIELD_TIME_MS))
}

fn new_session_id(sessions: &HashMap<i32, ExecSessionEntry>) -> i32 {
    loop {
        let session_id = if cfg!(test) {
            sessions
                .keys()
                .copied()
                .max()
                .map(|max| std::cmp::max(max, 999) + 1)
                .unwrap_or(1000)
        } else {
            rand::thread_rng().gen_range(1_000..100_000)
        };

        if !sessions.contains_key(&session_id) {
            return session_id;
        }
    }
}

fn new_chunk_id() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

fn input_bytes_for_write(chars: &str, append_enter: bool) -> Vec<u8> {
    let mut bytes = chars.as_bytes().to_vec();
    if append_enter {
        #[cfg(windows)]
        bytes.push(b'\r');
        #[cfg(not(windows))]
        bytes.push(b'\n');
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::{
        input_bytes_for_write, ExecCommandRequest, ExecControlAction, ExecControlOrigin,
        ExecControlRequest, ExecProcessLifecycleStatus, ExecProcessManager,
        ExecSessionCompletionSource, ExecSessionCompletionStatus, HeadTailText, OutputCursor,
        OutputState, SendStdinRequest, WriteStdinRequest,
    };
    #[cfg(windows)]
    use crate::shell::{ShellDetector, ShellType};
    use std::collections::HashMap;
    #[cfg(windows)]
    use std::path::PathBuf;
    use std::sync::Arc;

    #[cfg(windows)]
    fn shell_argv(script: &str) -> Vec<String> {
        vec![
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            "/C".to_string(),
            script.to_string(),
        ]
    }

    #[cfg(not(windows))]
    fn shell_argv(script: &str) -> Vec<String> {
        vec!["sh".to_string(), "-lc".to_string(), script.to_string()]
    }

    #[cfg(windows)]
    fn default_windows_shell_argv(script: &str) -> Vec<String> {
        let shell = ShellDetector::get_default_shell();
        match shell.shell_type {
            ShellType::PowerShell | ShellType::PowerShellCore => {
                vec![
                    shell.path.to_string_lossy().to_string(),
                    "-Command".to_string(),
                    script.to_string(),
                ]
            }
            ShellType::Cmd => {
                vec![
                    shell.path.to_string_lossy().to_string(),
                    "/C".to_string(),
                    script.to_string(),
                ]
            }
            _ => vec![
                shell.path.to_string_lossy().to_string(),
                "-lc".to_string(),
                script.to_string(),
            ],
        }
    }

    #[tokio::test]
    async fn pipe_exec_returns_output_and_exit_code() {
        let manager = ExecProcessManager::default();
        let response = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv("echo openbitfun_exec_test"),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should run");

        assert_eq!(response.exit_code, Some(0));
        assert!(response.session_id.is_none());
        assert!(response.output.contains("openbitfun_exec_test"));
    }

    #[tokio::test]
    async fn pipe_exec_stdout_only_drains_but_does_not_return_stderr() {
        let manager = ExecProcessManager::default();
        #[cfg(windows)]
        let script = "echo captured_stdout & echo ignored_stderr 1>&2";
        #[cfg(not(windows))]
        let script = "printf captured_stdout; printf ignored_stderr >&2";

        let response = manager
            .exec_command_stdout(ExecCommandRequest {
                argv: shell_argv(script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("stdout-only command should run");

        assert_eq!(response.exit_code, Some(0));
        assert!(response.output.contains("captured_stdout"));
        assert!(!response.output.contains("ignored_stderr"));
    }

    #[tokio::test]
    async fn original_output_chars_survives_multibyte_retention_eviction() {
        let output = OutputState::new(None);
        let chunk = "🦀".repeat(32 * 1024);
        for _ in 0..10 {
            output.push_text(chunk.clone()).await;
        }
        output.close(Some(0)).await;

        let collected = output
            .collect_until(
                OutputCursor {
                    next_seq: 0,
                    observed_output_chars: 0,
                },
                tokio::time::Instant::now() + std::time::Duration::from_secs(1),
                256 * 1024,
                None,
            )
            .await;

        assert_eq!(collected.original_output_chars, 320 * 1024);
        assert_eq!(collected.output.chars().count(), 256 * 1024);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pipe_exec_reports_signal_death_as_a_conventional_status() {
        let manager = ExecProcessManager::default();
        let response = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv("kill -TERM $$"),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should run");

        assert!(response.session_id.is_none());
        assert_eq!(
            response.exit_code,
            Some(143),
            "a signal death is a known status, not an unknown one"
        );
    }

    #[tokio::test]
    async fn delayed_poll_returns_unread_output_after_process_exit() {
        let manager = ExecProcessManager::default();
        #[cfg(windows)]
        let script = "echo first & powershell -NoProfile -Command \"Start-Sleep -Milliseconds 250\" & echo second";
        #[cfg(not(windows))]
        let script = "echo first; sleep 0.25; echo second";

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv(script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should start");

        let session_id = first
            .session_id
            .expect("process should still be running after first yield");
        assert!(first.output.contains("first"));

        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        let second = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("poll should return unread output");

        assert_eq!(second.exit_code, Some(0));
        assert!(second.session_id.is_none());
        assert!(second.output.contains("second"));
    }

    #[tokio::test]
    async fn lifecycle_reports_running_and_natural_exit() {
        let manager = ExecProcessManager::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        #[cfg(windows)]
        let script = "echo lifecycle_first & powershell -NoProfile -Command \"Start-Sleep -Milliseconds 250\" & echo lifecycle_second";
        #[cfg(not(windows))]
        let script = "echo lifecycle_first; sleep 0.25; echo lifecycle_second";

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv(script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
                lifecycle_tx: Some(tx),
                output_capture_tx: None,
            })
            .await
            .expect("exec command should start");

        let session_id = first
            .session_id
            .expect("process should still be running after first yield");
        let running = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("running lifecycle event should arrive")
            .expect("lifecycle channel should stay open");
        assert_eq!(running.session_id, session_id);
        assert_eq!(running.status, ExecProcessLifecycleStatus::Running);

        let exited = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .expect("exit lifecycle event should arrive")
            .expect("lifecycle channel should stay open until exit");
        assert_eq!(exited.session_id, session_id);
        assert_eq!(exited.status, ExecProcessLifecycleStatus::Exited);
        assert_eq!(exited.exit_code, Some(0));
    }

    #[tokio::test]
    async fn out_of_band_kill_during_initial_wait_is_reported_to_exec_command() {
        let manager = Arc::new(ExecProcessManager::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let exec_manager = Arc::clone(&manager);
        let exec_task = tokio::spawn(async move {
            exec_manager
                .exec_command(ExecCommandRequest {
                    argv: vec![
                        "python".to_string(),
                        "-c".to_string(),
                        "import time\nprint('initial_wait_start', flush=True)\ntime.sleep(30)"
                            .to_string(),
                    ],
                    cwd: std::env::current_dir().expect("current dir"),
                    env: HashMap::new(),
                    tty: false,
                    yield_time_ms: Some(30_000),
                    max_output_chars: Some(10_000),
                    lifecycle_tx: Some(tx),
                    output_capture_tx: None,
                })
                .await
        });

        let running = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("running lifecycle event should arrive before initial wait ends")
            .expect("lifecycle channel should stay open");
        assert_eq!(running.status, ExecProcessLifecycleStatus::Running);
        assert!(
            !exec_task.is_finished(),
            "ExecCommand should still be in its initial wait window"
        );

        let control = manager
            .control_session(ExecControlRequest {
                session_id: running.session_id,
                action: ExecControlAction::Kill,
                origin: ExecControlOrigin::OutOfBand,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("out-of-band kill should return process state");
        assert!(control.session_id.is_none());

        let initial = exec_task
            .await
            .expect("exec task should not panic")
            .expect("exec command should return process state");
        assert!(initial.session_id.is_none());
        let completion = initial
            .completion
            .expect("externally killed process should include completion metadata");
        assert_eq!(completion.status, ExecSessionCompletionStatus::Killed);
        assert_eq!(
            completion.source,
            ExecSessionCompletionSource::OutOfBandControl
        );
    }

    #[tokio::test]
    async fn tty_poll_after_process_exit_returns_exit_code() {
        let manager = ExecProcessManager::default();
        #[cfg(windows)]
        let script = "echo tty_first & powershell -NoProfile -Command \"Start-Sleep -Milliseconds 250\" & echo tty_second";
        #[cfg(not(windows))]
        let script = "echo tty_first; sleep 0.25; echo tty_second";

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv(script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: true,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("tty command should start");

        let session_id = first
            .session_id
            .expect("tty process should still be running after first yield");

        tokio::time::sleep(std::time::Duration::from_millis(900)).await;

        let second = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("tty poll should return final process state");

        assert_eq!(second.exit_code, Some(0));
        assert!(second.session_id.is_none());
        assert!(second.output.contains("tty_second"));

        let missing = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
            })
            .await
            .expect_err("finished tty session should be removed");
        assert!(missing.to_string().contains("Session not found"));
    }

    #[tokio::test]
    async fn tty_append_enter_completes_line_input() {
        let manager = ExecProcessManager::default();
        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "s=input(); print('got:'+s)".to_string(),
                ],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: true,
                yield_time_ms: Some(500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("tty command should start");

        let session_id = first
            .session_id
            .expect("python input should still be waiting");

        let second = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: "hello".to_string(),
                append_enter: true,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("append_enter should submit the line");

        assert_eq!(second.exit_code, Some(0));
        assert!(second.output.contains("got:hello"));
    }

    #[tokio::test]
    async fn send_stdin_writes_without_advancing_output_cursor() {
        let manager = ExecProcessManager::default();
        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "print('ready', flush=True); s=input(); print('got:'+s)".to_string(),
                ],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: true,
                yield_time_ms: Some(500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("tty command should start");

        let session_id = first
            .session_id
            .expect("python input should still be waiting");
        assert!(first.output.contains("ready"));

        manager
            .send_stdin(SendStdinRequest {
                session_id,
                chars: "from_user".to_string(),
                append_enter: true,
            })
            .await
            .expect("stdin-only write should succeed");

        let poll = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("next poll should still collect command output");

        assert_eq!(poll.exit_code, Some(0));
        assert!(poll.session_id.is_none());
        assert!(poll.output.contains("got:from_user"));
    }

    #[tokio::test]
    async fn control_kill_terminates_running_pipe_session() {
        let manager = ExecProcessManager::default();
        #[cfg(windows)]
        let script =
            "echo before_kill & powershell -NoProfile -Command \"Start-Sleep -Seconds 30\"";
        #[cfg(not(windows))]
        let script = "echo before_kill; sleep 30";

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv(script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should start");

        let session_id = first
            .session_id
            .expect("long-running process should still be active");
        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action: ExecControlAction::Kill,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("kill should return process state");

        assert!(second.session_id.is_none());
        assert!(second.exit_code.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_interrupt_kills_running_pipe_process_group_after_grace() {
        let manager = ExecProcessManager::default();
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let pid_file = std::env::temp_dir().join(format!("openbitfun-exec-child-{unique}.pid"));
        let tick_file = std::env::temp_dir().join(format!("openbitfun-exec-child-{unique}.tick"));
        let pid_path = pid_file.to_string_lossy();
        let tick_path = tick_file.to_string_lossy();
        let script = format!(
            "rm -f '{pid_path}' '{tick_path}'; \
             (trap '' INT TERM HUP; echo $$ > '{pid_path}'; i=0; while :; do echo $i >> '{tick_path}'; i=$((i+1)); sleep 1; done) & \
             wait $!"
        );

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: shell_argv(&script),
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should start");

        let session_id = first
            .session_id
            .expect("background child should keep shell waiting");
        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action: ExecControlAction::Interrupt,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("interrupt should return process state");

        assert!(second.session_id.is_none());

        let ticks_after_interrupt = line_count(&tick_file);
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let ticks_later = line_count(&tick_file);
        assert_eq!(
            ticks_after_interrupt, ticks_later,
            "background child should stop writing ticks after interrupt cleanup"
        );

        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", pid.trim()])
                .status();
        }
        let _ = std::fs::remove_file(pid_file);
        let _ = std::fs::remove_file(tick_file);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_kill_closes_pipe_session_after_parent_exit_with_descendant_pipes() {
        assert_unix_pipe_descendant_control(ExecControlAction::Kill).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_interrupt_closes_pipe_session_after_parent_exit_with_descendant_pipes() {
        assert_unix_pipe_descendant_control(ExecControlAction::Interrupt).await;
    }

    #[cfg(unix)]
    async fn assert_unix_pipe_descendant_control(action: ExecControlAction) {
        let manager = ExecProcessManager::default();
        let script = r#"import subprocess, sys
subprocess.Popen(
    [
        sys.executable,
        "-c",
        "import time; [print(i, flush=True) or time.sleep(1) for i in range(30)]",
    ],
    stdin=subprocess.DEVNULL,
    stdout=sys.stdout,
    stderr=sys.stderr,
)
print("parent_exit", flush=True)"#;

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec!["python3".to_string(), "-c".to_string(), script.to_string()],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(700),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("unix descendant pipe fixture should start");

        let session_id = first
            .session_id
            .expect("descendant-held pipes should keep the session active");
        assert!(
            first.output.contains("parent_exit"),
            "initial output should show the parent exited, got: {}",
            first.output
        );

        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("control action should close the descendant-held pipe session");

        assert!(
            second.session_id.is_none(),
            "control action should close the session after parent exit, got output: {}",
            second.output
        );
        assert!(second.exit_code.is_some());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn control_kill_terminates_python_child_started_by_default_windows_shell() {
        assert_default_windows_shell_python_child_control(ExecControlAction::Kill).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn control_interrupt_terminates_python_child_started_by_default_windows_shell() {
        assert_default_windows_shell_python_child_control(ExecControlAction::Interrupt).await;
    }

    #[cfg(windows)]
    async fn assert_default_windows_shell_python_child_control(action: ExecControlAction) {
        let script = r#"python -c "import time; [print(i, flush=True) or time.sleep(1) for i in range(30)]""#;
        assert_windows_python_control(default_windows_shell_argv(script), action).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires a working Python Install Manager App Execution Alias"]
    async fn control_terminates_python_app_execution_alias() {
        use std::os::windows::fs::MetadataExt;
        let alias = std::env::var("OPENBITFUN_TEST_PYTHON_ALIAS")
            .expect("set OPENBITFUN_TEST_PYTHON_ALIAS to the WindowsApps python.exe alias");
        let metadata = std::fs::metadata(&alias).expect("alias metadata");
        assert_eq!(metadata.len(), 0, "must use an application execution alias");
        assert_ne!(metadata.file_attributes() & 0x400, 0);
        for action in [ExecControlAction::Kill, ExecControlAction::Interrupt] {
            let script = format!(
                "& '{}' -u -c \"import time; print('ALIAS_READY', flush=True); time.sleep(30)\"",
                alias.replace('\'', "''")
            );
            assert_windows_python_control(
                vec![
                    "powershell.exe".into(),
                    "-NoProfile".into(),
                    "-Command".into(),
                    script,
                ],
                action,
            )
            .await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn tree_killer_timeout_reaps_helper() {
        use super::{wait_for_tree_killer, CREATE_NO_WINDOW};
        use std::{io::ErrorKind, process::Stdio, time::Duration};
        use tokio::process::Command;
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.kill_on_drop(true);
        let mut helper = command.spawn().expect("start slow helper");
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_tree_killer(&mut helper, Duration::from_millis(100)),
        )
        .await
        .expect("helper timeout and cleanup must be bounded");
        assert_eq!(
            result.expect_err("slow helper must time out").kind(),
            ErrorKind::TimedOut
        );
        assert!(
            helper.try_wait().expect("query helper").is_some(),
            "timed-out helper must be reaped"
        );
    }

    #[cfg(windows)]
    async fn assert_windows_python_control(argv: Vec<String>, action: ExecControlAction) {
        let manager = ExecProcessManager::default();

        let first = manager
            .exec_command(ExecCommandRequest {
                argv,
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(1_500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("exec command should start");

        let session_id = first
            .session_id
            .expect("python loop should still be active");
        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(3_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("control action should return process state");

        assert!(
            second.session_id.is_none(),
            "control action should close the shell child process tree, got output: {}",
            second.output
        );
        assert!(second.exit_code.is_some());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn control_kill_closes_pipe_session_after_parent_exits_and_descendant_holds_pipes() {
        assert_git_bash_npm_dev_control(ExecControlAction::Kill).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn control_interrupt_closes_pipe_session_after_parent_exits_and_descendant_holds_pipes() {
        assert_git_bash_npm_dev_control(ExecControlAction::Interrupt).await;
    }

    #[cfg(windows)]
    async fn assert_git_bash_npm_dev_control(action: ExecControlAction) {
        let Ok(bash_path) = std::env::var("OPENBITFUN_TEST_WINDOWS_GIT_BASH") else {
            eprintln!(
                "skipping git bash exec regression: OPENBITFUN_TEST_WINDOWS_GIT_BASH is unset"
            );
            return;
        };
        let Ok(fixture_dir) = std::env::var("OPENBITFUN_TEST_WINDOWS_NPM_FIXTURE") else {
            eprintln!(
                "skipping git bash exec regression: OPENBITFUN_TEST_WINDOWS_NPM_FIXTURE is unset"
            );
            return;
        };

        let manager = ExecProcessManager::default();

        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec![bash_path, "-lc".to_string(), "npm run dev".to_string()],
                cwd: PathBuf::from(&fixture_dir),
                env: HashMap::new(),
                tty: false,
                yield_time_ms: Some(1_500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("git bash fixture command should start");

        let session_id = first
            .session_id
            .expect("npm dev fixture should still be active after initial yield");

        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(4_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("control action should close git bash npm dev session");

        assert!(
            second.session_id.is_none(),
            "control action should close the git bash npm dev session, got output: {}",
            second.output
        );
        assert!(second.exit_code.is_some());
    }

    #[tokio::test]
    async fn control_interrupt_writes_ctrl_c_for_tty_session() {
        let manager = ExecProcessManager::default();
        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "import time\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('interrupted')"
                        .to_string(),
                ],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: true,
                yield_time_ms: Some(500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("tty command should start");

        let session_id = first
            .session_id
            .expect("sleeping process should still be active");
        let second = manager
            .control_session(ExecControlRequest {
                session_id,
                action: ExecControlAction::Interrupt,
                origin: ExecControlOrigin::ModelTool,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("interrupt should return process state");

        assert!(second.session_id.is_none());
        assert!(second.output.contains("interrupted"));
    }

    #[tokio::test]
    async fn out_of_band_interrupt_preserves_final_output_for_next_empty_poll() {
        let manager = ExecProcessManager::default();
        let first = manager
            .exec_command(ExecCommandRequest {
                argv: vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "import time\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('external_interrupted')"
                        .to_string(),
                ],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                tty: true,
                yield_time_ms: Some(500),
                max_output_chars: Some(10_000),
                lifecycle_tx: None,
                output_capture_tx: None,
            })
            .await
            .expect("tty command should start");

        let session_id = first
            .session_id
            .expect("sleeping process should still be active");
        let control = manager
            .control_session(ExecControlRequest {
                session_id,
                action: ExecControlAction::Interrupt,
                origin: ExecControlOrigin::OutOfBand,
                yield_time_ms: Some(5_000),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("out-of-band interrupt should return process state");

        assert!(control.session_id.is_none());
        assert!(control.output.contains("external_interrupted"));

        let poll = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
            })
            .await
            .expect("empty poll should claim preserved out-of-band result");

        assert!(poll.session_id.is_none());
        assert!(poll.output.contains("external_interrupted"));
        let completion = poll
            .completion
            .expect("preserved result should include completion metadata");
        assert_eq!(completion.status, ExecSessionCompletionStatus::Interrupted);
        assert_eq!(
            completion.source,
            ExecSessionCompletionSource::OutOfBandControl
        );

        let missing = manager
            .write_stdin(WriteStdinRequest {
                session_id,
                chars: String::new(),
                append_enter: false,
                yield_time_ms: Some(100),
                max_output_chars: Some(10_000),
            })
            .await
            .expect_err("preserved result should be consumed once");
        assert!(missing.to_string().contains("Session not found"));
    }

    #[test]
    fn append_enter_uses_platform_line_submit_byte() {
        let bytes = input_bytes_for_write("hello", true);
        #[cfg(windows)]
        assert_eq!(bytes, b"hello\r");
        #[cfg(not(windows))]
        assert_eq!(bytes, b"hello\n");
    }

    #[test]
    fn head_tail_text_preserves_head_and_tail() {
        let mut buffer = HeadTailText::new(10);
        buffer.push_str("abcdefghijklmnop");
        assert_eq!(buffer.total_chars, 16);

        let rendered = buffer.render();
        assert!(rendered.starts_with("abcde"));
        assert!(rendered.ends_with("lmnop"));
        assert!(rendered.contains("truncated"));
    }

    #[test]
    fn head_tail_text_keeps_full_output_when_unbounded() {
        let mut buffer = HeadTailText::new(usize::MAX);
        buffer.push_str("abcdefghijklmnop");

        assert_eq!(buffer.total_chars, 16);
        assert_eq!(buffer.render(), "abcdefghijklmnop");
    }

    /// Char-by-char reference implementation, mirroring the original
    /// `VecDeque<char>` ring buffer. The byte-based ring buffer must stay
    /// observationally identical to it.
    fn head_tail_reference(max_chars: usize, chunks: &[&str]) -> (String, usize, usize) {
        let head_budget = max_chars / 2;
        let tail_budget = max_chars.saturating_sub(head_budget);
        let mut head = String::new();
        let mut tail: std::collections::VecDeque<char> = std::collections::VecDeque::new();
        let mut head_chars = 0usize;
        let mut tail_chars = 0usize;
        let mut omitted_chars = 0usize;
        let mut total_chars = 0usize;

        for text in chunks {
            for ch in text.chars() {
                total_chars += 1;
                if max_chars == 0 {
                    omitted_chars += 1;
                    continue;
                }
                if head_chars < head_budget {
                    head.push(ch);
                    head_chars += 1;
                    continue;
                }
                if tail_budget == 0 {
                    omitted_chars += 1;
                    continue;
                }
                tail.push_back(ch);
                tail_chars += 1;
                if tail_chars > tail_budget {
                    tail.pop_front();
                    tail_chars -= 1;
                    omitted_chars += 1;
                }
            }
        }

        let mut output = head;
        if omitted_chars != 0 {
            output.push_str("\n... [truncated, middle omitted] ...\n");
        }
        output.extend(tail);
        (output, total_chars, omitted_chars)
    }

    #[test]
    fn head_tail_text_matches_char_reference_for_multibyte_input() {
        let chunk_sets: &[&[&str]] = &[
            &["abcdefghijklmnop"],
            &["小游戏平台推荐给所有人"],
            &["ab", "小游戏", "cd", "平台推荐", "ef"],
            &["🎮🎲🎯🎰🎳", "🚀🛰️🌌", "end"],
            &["混合ascii与🎮emoji以及中文字符的长文本内容"],
            &["a", "", "中", "🎮", "z"],
        ];

        for max_chars in [0usize, 1, 2, 3, 5, 8, 10, 17, 64, 1024] {
            for chunks in chunk_sets {
                let mut buffer = HeadTailText::new(max_chars);
                for chunk in *chunks {
                    buffer.push_str(chunk);
                }
                let total = buffer.total_chars;
                let omitted = buffer.omitted_chars;
                let rendered = buffer.render();

                let (expected, expected_total, expected_omitted) =
                    head_tail_reference(max_chars, chunks);

                assert_eq!(
                    rendered, expected,
                    "render mismatch: max_chars={max_chars} chunks={chunks:?}"
                );
                assert_eq!(
                    total, expected_total,
                    "total_chars mismatch: max_chars={max_chars} chunks={chunks:?}"
                );
                assert_eq!(
                    omitted, expected_omitted,
                    "omitted_chars mismatch: max_chars={max_chars} chunks={chunks:?}"
                );
                assert!(
                    !rendered.contains('\u{FFFD}'),
                    "tail ring buffer split a multi-byte char: max_chars={max_chars} chunks={chunks:?}"
                );
            }
        }
    }

    #[test]
    fn head_tail_text_keeps_multibyte_chars_intact_under_pressure() {
        // Every char is 3 bytes; a byte-granular ring buffer would corrupt them.
        let text: String = "中".repeat(500);
        let mut buffer = HeadTailText::new(10);
        for chunk in text.as_bytes().chunks(3) {
            buffer.push_str(std::str::from_utf8(chunk).expect("aligned chunk"));
        }

        assert_eq!(buffer.total_chars, 500);
        let rendered = buffer.render();
        assert!(!rendered.contains('\u{FFFD}'));
        assert!(rendered.starts_with("中中中中中"));
        assert!(rendered.ends_with("中中中中中"));
        assert!(rendered.contains("truncated"));
        // 5 head + 5 tail chars plus the truncation marker.
        assert_eq!(
            rendered.chars().count(),
            10 + "\n... [truncated, middle omitted] ...\n".chars().count()
        );
    }

    #[cfg(unix)]
    fn line_count(path: &std::path::Path) -> usize {
        std::fs::read_to_string(path)
            .map(|contents| contents.lines().count())
            .unwrap_or(0)
    }
}
