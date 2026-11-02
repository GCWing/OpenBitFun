//! Workspace process transport shared by SSH and local Docker targets.
//!
//! Callers should not need to know whether a long-lived stdio process is backed
//! by a russh channel or a local `docker exec` child. This module normalizes
//! stdin, stdout, stderr, exit status, and interrupt/kill control.

use anyhow::{anyhow, Context};
use openbitfun_services_core::process_manager;
#[cfg(feature = "remote-ssh-concrete")]
use russh::client::Msg;
#[cfg(feature = "remote-ssh-concrete")]
use russh::{Channel, ChannelMsg, Sig};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

const WORKSPACE_STDIO_BUFFER_SIZE: usize = 256 * 1024;

/// How long to keep an SSH channel open after `SSH_MSG_CHANNEL_EOF` while the
/// exit status is still missing.
///
/// EOF only says the peer will send no more data. RFC 4254 §6.10 leaves the
/// ordering of the `exit-status` request free, and OpenSSH in practice flushes
/// EOF from its channel loop before it reaps the child and reports the status.
/// Closing on EOF therefore threw away the exit code of nearly every
/// short-lived command. Waiting for `SSH_MSG_CHANNEL_CLOSE` costs nothing in
/// the normal case because it follows immediately; the grace only bounds
/// servers that go quiet without closing.
pub(crate) const SSH_EXIT_STATUS_AFTER_EOF_GRACE: Duration = Duration::from_secs(5);

/// Map an SSH `exit-signal` to the conventional `128 + signal` wait status.
///
/// Returns `None` for signals with no portable number so callers can report an
/// unknown status instead of inventing a misleading exit code.
#[cfg(feature = "remote-ssh-concrete")]
pub(crate) fn ssh_exit_code_for_signal(signal: &Sig) -> Option<i32> {
    let number = match signal {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        Sig::USR1 => 10,
        Sig::Custom(_) => return None,
    };
    Some(128 + number)
}

/// Map a locally waited child status to an exit code.
///
/// `ExitStatus::code()` is `None` when a process dies from a signal, which is
/// exactly how interrupt and kill end a supervised workspace command. Report
/// the conventional `128 + signal` status for those instead of losing it.
fn local_process_exit_code(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
    }
    #[cfg(not(unix))]
    {
        status.code()
    }
}

pub type WorkspaceReader = Pin<Box<dyn AsyncRead + Send>>;
pub type WorkspaceWriter = Pin<Box<dyn AsyncWrite + Send>>;
pub(crate) type WorkspaceSignalHook = Arc<
    dyn Fn(
            WorkspaceProcessSignal,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'static>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceProcessSignal {
    Interrupt,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceProcessExit {
    pub exit_code: Option<i32>,
}

#[derive(Clone)]
pub struct WorkspaceProcessControl {
    sender: mpsc::Sender<WorkspaceProcessSignal>,
    signal_hook: Option<WorkspaceSignalHook>,
}

impl WorkspaceProcessControl {
    pub async fn interrupt(&self) -> anyhow::Result<()> {
        self.send(WorkspaceProcessSignal::Interrupt).await
    }

    pub async fn kill(&self) -> anyhow::Result<()> {
        self.send(WorkspaceProcessSignal::Kill).await
    }

    async fn send(&self, signal: WorkspaceProcessSignal) -> anyhow::Result<()> {
        let hook_result = match &self.signal_hook {
            Some(hook) => hook(signal).await,
            None => Ok(()),
        };
        if self.signal_hook.is_some()
            && matches!(signal, WorkspaceProcessSignal::Interrupt)
            && hook_result.is_ok()
        {
            // A target-aware hook (for example Docker process-group control)
            // handled the soft interrupt. Keep the owning transport open so
            // the caller can drain output and escalate to Kill after grace.
            return Ok(());
        }
        let send_result = self
            .sender
            .send(signal)
            .await
            .map_err(|_| anyhow!("Workspace process has already exited"));
        if send_result.is_err() && self.signal_hook.is_some() && hook_result.is_ok() {
            // A target-aware hook delivers the signal itself, and the local
            // supervisor ends as soon as the target does, which closes this
            // channel. Reporting a failure here would tell the caller a signal
            // failed although it arrived: the child this handle refers to is
            // already gone, which is what a kill or interrupt asks for.
            return Ok(());
        }
        hook_result.and(send_result)
    }
}

#[derive(Clone)]
pub struct WorkspaceProcessCompletion {
    receiver: watch::Receiver<Option<WorkspaceProcessExit>>,
}

impl WorkspaceProcessCompletion {
    pub async fn wait(mut self) -> WorkspaceProcessExit {
        loop {
            if let Some(exit) = *self.receiver.borrow() {
                return exit;
            }
            if self.receiver.changed().await.is_err() {
                return WorkspaceProcessExit { exit_code: None };
            }
        }
    }
}

/// A transport-neutral, full-duplex workspace process.
///
/// The underlying SSH channel or Docker child is cancelled once all three IO
/// streams are dropped. `completion` and `control` do not keep the process
/// alive by themselves.
pub struct WorkspaceStdio {
    stdin: WorkspaceWriter,
    stdout: WorkspaceReader,
    stderr: WorkspaceReader,
    control: WorkspaceProcessControl,
    completion: WorkspaceProcessCompletion,
}

impl WorkspaceStdio {
    #[cfg(feature = "remote-ssh-concrete")]
    pub(crate) fn from_ssh_channel(channel: Channel<Msg>) -> Self {
        Self::from_ssh_channel_with_signal_hook(channel, None)
    }

    #[cfg(feature = "remote-ssh-concrete")]
    pub(crate) fn from_ssh_channel_with_signal_hook(
        channel: Channel<Msg>,
        signal_hook: Option<WorkspaceSignalHook>,
    ) -> Self {
        let pipes = WorkspacePipes::new(signal_hook);
        let control = pipes.control.clone();
        let completion = pipes.completion.clone();
        tokio::spawn(run_ssh_channel(channel, pipes.owner));
        Self {
            stdin: pipes.stdin,
            stdout: pipes.stdout,
            stderr: pipes.stderr,
            control,
            completion,
        }
    }

    #[cfg(test)]
    pub(crate) fn spawn_local_process(executable: &str, args: &[String]) -> anyhow::Result<Self> {
        Self::spawn_local_process_with_signal_hook(executable, args, None)
    }

    pub(crate) fn spawn_local_process_with_signal_hook(
        executable: &str,
        args: &[String],
        signal_hook: Option<WorkspaceSignalHook>,
    ) -> anyhow::Result<Self> {
        let mut child = process_manager::create_tokio_command(executable)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("Failed to start local executable '{}'", executable))?;
        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Local workspace process stdin is unavailable"))?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Local workspace process stdout is unavailable"))?;
        let child_stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Local workspace process stderr is unavailable"))?;

        let pipes = WorkspacePipes::new(signal_hook);
        let control = pipes.control.clone();
        let completion = pipes.completion.clone();
        tokio::spawn(run_local_process(
            child,
            child_stdin,
            child_stdout,
            child_stderr,
            pipes.owner,
        ));
        Ok(Self {
            stdin: pipes.stdin,
            stdout: pipes.stdout,
            stderr: pipes.stderr,
            control,
            completion,
        })
    }

    /// Rewrite the stderr stream of an already spawned workspace process.
    ///
    /// Targets that interleave transport-level noise into the command's stderr
    /// use this to hand consumers clean diagnostics without changing stdin,
    /// stdout, or process lifetime.
    pub(crate) fn map_stderr(
        self,
        filter: impl FnOnce(WorkspaceReader) -> WorkspaceReader,
    ) -> Self {
        let Self {
            stdin,
            stdout,
            stderr,
            control,
            completion,
        } = self;
        Self {
            stdin,
            stdout,
            stderr: filter(stderr),
            control,
            completion,
        }
    }

    pub fn into_parts(
        self,
    ) -> (
        WorkspaceWriter,
        WorkspaceReader,
        WorkspaceReader,
        WorkspaceProcessControl,
        WorkspaceProcessCompletion,
    ) {
        (
            self.stdin,
            self.stdout,
            self.stderr,
            self.control,
            self.completion,
        )
    }
}

struct WorkspaceLease {
    cancellation: CancellationToken,
    signal_hook: Option<WorkspaceSignalHook>,
    finished: Arc<AtomicBool>,
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        if let (Some(signal_hook), Ok(runtime)) = (
            self.signal_hook.clone(),
            tokio::runtime::Handle::try_current(),
        ) {
            let cancellation = self.cancellation.clone();
            runtime.spawn(async move {
                let _ = signal_hook(WorkspaceProcessSignal::Kill).await;
                cancellation.cancel();
            });
            return;
        }
        self.cancellation.cancel();
    }
}

struct LeasedIo {
    inner: DuplexStream,
    _lease: Arc<WorkspaceLease>,
}

impl AsyncRead for LeasedIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for LeasedIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

struct WorkspacePipeOwner {
    stdin: DuplexStream,
    stdout: DuplexStream,
    stderr: DuplexStream,
    control_rx: mpsc::Receiver<WorkspaceProcessSignal>,
    completion_tx: watch::Sender<Option<WorkspaceProcessExit>>,
    cancellation: CancellationToken,
    finished: Arc<AtomicBool>,
}

struct WorkspacePipes {
    stdin: WorkspaceWriter,
    stdout: WorkspaceReader,
    stderr: WorkspaceReader,
    control: WorkspaceProcessControl,
    completion: WorkspaceProcessCompletion,
    owner: WorkspacePipeOwner,
}

impl WorkspacePipes {
    fn new(signal_hook: Option<WorkspaceSignalHook>) -> Self {
        let cancellation = CancellationToken::new();
        let finished = Arc::new(AtomicBool::new(false));
        let lease = Arc::new(WorkspaceLease {
            cancellation: cancellation.clone(),
            signal_hook: signal_hook.clone(),
            finished: finished.clone(),
        });
        let (public_stdin, owner_stdin) = tokio::io::duplex(WORKSPACE_STDIO_BUFFER_SIZE);
        let (owner_stdout, public_stdout) = tokio::io::duplex(WORKSPACE_STDIO_BUFFER_SIZE);
        let (owner_stderr, public_stderr) = tokio::io::duplex(WORKSPACE_STDIO_BUFFER_SIZE);
        let (control_tx, control_rx) = mpsc::channel(8);
        let (completion_tx, completion_rx) = watch::channel(None);

        Self {
            stdin: Box::pin(LeasedIo {
                inner: public_stdin,
                _lease: lease.clone(),
            }),
            stdout: Box::pin(LeasedIo {
                inner: public_stdout,
                _lease: lease.clone(),
            }),
            stderr: Box::pin(LeasedIo {
                inner: public_stderr,
                _lease: lease,
            }),
            control: WorkspaceProcessControl {
                sender: control_tx,
                signal_hook,
            },
            completion: WorkspaceProcessCompletion {
                receiver: completion_rx,
            },
            owner: WorkspacePipeOwner {
                stdin: owner_stdin,
                stdout: owner_stdout,
                stderr: owner_stderr,
                control_rx,
                completion_tx,
                cancellation,
                finished,
            },
        }
    }
}

/// Resolve on the next real signal, and never on the channel closing.
///
/// A caller that keeps no `WorkspaceProcessControl` — because it drives the
/// process purely over its IO streams — closes this channel the moment the
/// handle it was given falls out of scope. That is not a request to kill
/// anything: what leases the process is the three IO streams, as
/// [`WorkspaceStdio`] documents. Reading the close as a `Kill` killed such a
/// process microseconds after it started, before it could say a word.
async fn next_control_signal(
    control_rx: &mut mpsc::Receiver<WorkspaceProcessSignal>,
) -> WorkspaceProcessSignal {
    match control_rx.recv().await {
        Some(signal) => signal,
        None => std::future::pending().await,
    }
}

#[cfg(feature = "remote-ssh-concrete")]
async fn run_ssh_channel(mut channel: Channel<Msg>, mut pipes: WorkspacePipeOwner) {
    let mut stdin_buffer = vec![0u8; 16 * 1024];
    let mut stdin_closed = false;
    let mut exit_code = None;
    // Set once the peer sends EOF while the exit status is still missing, so a
    // server that never follows up cannot hold the channel open forever.
    let mut exit_status_deadline: Option<tokio::time::Instant> = None;

    loop {
        let wait_budget = exit_status_deadline
            .map(|deadline| deadline.saturating_duration_since(tokio::time::Instant::now()));
        if wait_budget.is_some_and(|budget| budget.is_zero()) {
            break;
        }

        tokio::select! {
            biased;

            signal = next_control_signal(&mut pipes.control_rx) => {
                match signal {
                    WorkspaceProcessSignal::Interrupt => {
                        let _ = channel.signal(Sig::INT).await;
                    }
                    WorkspaceProcessSignal::Kill => {
                        let _ = channel.signal(Sig::KILL).await;
                        let _ = channel.close().await;
                        exit_code.get_or_insert(137);
                        break;
                    }
                }
            }

            read = pipes.stdin.read(&mut stdin_buffer), if !stdin_closed => {
                match read {
                    Ok(0) | Err(_) => {
                        stdin_closed = true;
                        let _ = channel.eof().await;
                    }
                    Ok(read) => {
                        if channel.data(&stdin_buffer[..read]).await.is_err() {
                            break;
                        }
                    }
                }
            }

            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) => {
                        if pipes.stdout.write_all(data.as_ref()).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if pipes.stderr.write_all(data.as_ref()).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                        // EOF already arrived, so the status was the last thing
                        // worth waiting for. Do not linger for CHANNEL_CLOSE.
                        if exit_status_deadline.is_some() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitSignal { ref signal_name, .. }) => {
                        // A server sends either exit-status or exit-signal. Keep
                        // whichever arrived first rather than letting an
                        // unmappable signal erase a known code.
                        if exit_code.is_none() {
                            exit_code = ssh_exit_code_for_signal(signal_name);
                        }
                        if exit_status_deadline.is_some() && exit_code.is_some() {
                            break;
                        }
                    }
                    // EOF is not the end of the channel: the exit status is
                    // still allowed to follow, and OpenSSH usually sends it
                    // afterwards. Keep draining until CLOSE, or until the grace
                    // window expires, so the status is not silently dropped.
                    Some(ChannelMsg::Eof) => {
                        if exit_code.is_some() {
                            break;
                        }
                        exit_status_deadline
                            .get_or_insert_with(|| {
                                tokio::time::Instant::now() + SSH_EXIT_STATUS_AFTER_EOF_GRACE
                            });
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }

            _ = pipes.cancellation.cancelled() => {
                let _ = channel.signal(Sig::KILL).await;
                let _ = channel.close().await;
                exit_code.get_or_insert(137);
                break;
            }

            _ = tokio::time::sleep(wait_budget.unwrap_or_default()), if wait_budget.is_some() => {
                break;
            }
        }
    }

    pipes.finished.store(true, Ordering::Release);
    let _ = pipes.stdout.shutdown().await;
    let _ = pipes.stderr.shutdown().await;
    let _ = pipes
        .completion_tx
        .send(Some(WorkspaceProcessExit { exit_code }));
}

async fn copy_to_duplex<R>(mut reader: R, mut writer: DuplexStream)
where
    R: AsyncRead + Unpin,
{
    let _ = tokio::io::copy(&mut reader, &mut writer).await;
    let _ = writer.shutdown().await;
}

async fn run_local_process(
    mut child: tokio::process::Child,
    mut child_stdin: tokio::process::ChildStdin,
    child_stdout: tokio::process::ChildStdout,
    child_stderr: tokio::process::ChildStderr,
    mut pipes: WorkspacePipeOwner,
) {
    let mut owner_stdin = pipes.stdin;
    let stdin_task = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut owner_stdin, &mut child_stdin).await;
        let _ = child_stdin.shutdown().await;
    });
    let stdout_task = tokio::spawn(copy_to_duplex(child_stdout, pipes.stdout));
    let stderr_task = tokio::spawn(copy_to_duplex(child_stderr, pipes.stderr));

    // Whichever arm wins settles the exit code; none of them can resume
    // waiting, so this is a single-shot select rather than a loop.
    let exit_code = tokio::select! {
        status = child.wait() => {
            status.ok().and_then(local_process_exit_code)
        }
        // We are the ones ending the process here, so a signal death says
        // nothing the caller does not already know. Prefer a status the
        // child chose for itself and otherwise report the requested intent.
        signal = next_control_signal(&mut pipes.control_rx) => {
            let fallback = match signal {
                WorkspaceProcessSignal::Interrupt => 130,
                WorkspaceProcessSignal::Kill => 137,
            };
            let _ = child.start_kill();
            child.wait().await.ok().and_then(|status| status.code()).or(Some(fallback))
        }
        _ = pipes.cancellation.cancelled() => {
            let _ = child.start_kill();
            child.wait().await.ok().and_then(|status| status.code()).or(Some(137))
        }
    };

    pipes.finished.store(true, Ordering::Release);
    stdin_task.abort();
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let _ = pipes
        .completion_tx
        .send(Some(WorkspaceProcessExit { exit_code }));
}

/// In-process SSH server that lets the channel-owner loop be tested against the
/// message orderings real servers use, without needing a live host.
#[cfg(test)]
mod ssh_channel_tests {
    use super::*;
    use russh::server::{Auth, Msg as ServerMsg, Server as _, Session};
    use russh::{Channel as RusshChannel, ChannelId, CryptoVec};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    /// What the fake server sends once the client asks it to run something.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ExitReport {
        /// EOF first, exit status afterwards — what OpenSSH does for a
        /// short-lived command, because its channel loop flushes EOF before it
        /// reaps the child and reports the status.
        EofBeforeExitStatus,
        /// Exit status first, then EOF.
        ExitStatusBeforeEof,
        /// EOF, then a signal death, then close.
        EofBeforeExitSignal,
        /// EOF and close with no status at all.
        NoStatus,
    }

    #[derive(Clone)]
    struct TestServer {
        report: ExitReport,
    }

    impl russh::server::Server for TestServer {
        type Handler = Self;

        fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self {
            self.clone()
        }
    }

    #[async_trait::async_trait]
    impl russh::server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: RusshChannel<ServerMsg>,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            _data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            let handle = session.handle();
            let report = self.report;
            tokio::spawn(async move {
                let _ = handle
                    .data(channel, CryptoVec::from_slice(b"workspace output\n"))
                    .await;
                let settle = || tokio::time::sleep(Duration::from_millis(30));
                match report {
                    ExitReport::EofBeforeExitStatus => {
                        let _ = handle.eof(channel).await;
                        settle().await;
                        let _ = handle.exit_status_request(channel, 7).await;
                        let _ = handle.close(channel).await;
                    }
                    ExitReport::ExitStatusBeforeEof => {
                        let _ = handle.exit_status_request(channel, 7).await;
                        settle().await;
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                    }
                    ExitReport::EofBeforeExitSignal => {
                        let _ = handle.eof(channel).await;
                        settle().await;
                        let _ = handle
                            .exit_signal_request(
                                channel,
                                russh::Sig::TERM,
                                false,
                                String::new(),
                                String::new(),
                            )
                            .await;
                        let _ = handle.close(channel).await;
                    }
                    ExitReport::NoStatus => {
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                    }
                }
            });
            Ok(())
        }
    }

    struct TestClient;

    #[async_trait::async_trait]
    impl russh::client::Handler for TestClient {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _key: &russh_keys::key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn workspace_exit_for(report: ExitReport) -> WorkspaceProcessExit {
        let transport = workspace_stdio_for(report).await;
        let (_stdin, mut stdout, _stderr, _control, completion) = transport.into_parts();
        let mut stdout_bytes = Vec::new();
        let _ = stdout.read_to_end(&mut stdout_bytes).await;
        assert_eq!(stdout_bytes, b"workspace output\n");

        tokio::time::timeout(Duration::from_secs(20), completion.wait())
            .await
            .expect("channel owner should report completion")
    }

    async fn workspace_stdio_for(report: ExitReport) -> WorkspaceStdio {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test SSH listener should bind");
        let address = listener
            .local_addr()
            .expect("test SSH listener should report its address");
        let server_config = Arc::new(russh::server::Config {
            keys: vec![russh_keys::key::KeyPair::generate_ed25519()
                .expect("test host key should generate")],
            ..Default::default()
        });
        tokio::spawn(async move {
            let mut server = TestServer { report };
            let _ = server.run_on_socket(server_config, &listener).await;
        });

        let client_config = Arc::new(russh::client::Config::default());
        let mut handle = russh::client::connect(client_config, address, TestClient)
            .await
            .expect("test client should connect");
        assert!(
            handle
                .authenticate_password("tester", "tester")
                .await
                .expect("test authentication should complete"),
            "test server should accept the password"
        );
        let channel = handle
            .channel_open_session()
            .await
            .expect("test channel should open");
        channel
            .exec(true, "df -h")
            .await
            .expect("test exec should start");

        WorkspaceStdio::from_ssh_channel(channel)
    }

    #[tokio::test]
    async fn exit_status_sent_after_eof_is_still_reported() {
        let exit = workspace_exit_for(ExitReport::EofBeforeExitStatus).await;

        assert_eq!(
            exit.exit_code,
            Some(7),
            "EOF does not end an SSH channel; the exit status may follow it"
        );
    }

    #[tokio::test]
    async fn exit_status_sent_before_eof_is_reported() {
        let exit = workspace_exit_for(ExitReport::ExitStatusBeforeEof).await;

        assert_eq!(exit.exit_code, Some(7));
    }

    #[tokio::test]
    async fn exit_signal_sent_after_eof_maps_to_a_conventional_status() {
        let exit = workspace_exit_for(ExitReport::EofBeforeExitSignal).await;

        assert_eq!(exit.exit_code, Some(143));
    }

    #[tokio::test]
    async fn dropping_the_control_handle_does_not_end_the_channel() {
        let transport = workspace_stdio_for(ExitReport::EofBeforeExitStatus).await;
        let (_stdin, mut stdout, _stderr, control, completion) = transport.into_parts();
        // A caller that drives the process over its IO streams alone has no use
        // for this handle, and every ACP client is such a caller. Letting it go
        // says nothing about whether the process should keep running.
        drop(control);

        let mut stdout_bytes = Vec::new();
        let _ = stdout.read_to_end(&mut stdout_bytes).await;
        let exit = tokio::time::timeout(Duration::from_secs(20), completion.wait())
            .await
            .expect("channel owner should report completion");

        assert_eq!(
            stdout_bytes, b"workspace output\n",
            "the remote process must still get to say what it had to say"
        );
        assert_eq!(
            exit.exit_code,
            Some(7),
            "a dropped control handle is not a kill request"
        );
    }

    #[tokio::test]
    async fn missing_exit_status_stays_unknown() {
        let exit = workspace_exit_for(ExitReport::NoStatus).await;

        assert_eq!(
            exit.exit_code, None,
            "an unreported status must not be turned into a synthetic failure code"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_exit_signals_map_to_conventional_wait_statuses() {
        assert_eq!(ssh_exit_code_for_signal(&Sig::INT), Some(130));
        assert_eq!(ssh_exit_code_for_signal(&Sig::KILL), Some(137));
        assert_eq!(ssh_exit_code_for_signal(&Sig::TERM), Some(143));
        assert_eq!(
            ssh_exit_code_for_signal(&Sig::Custom("WEIRD".to_string())),
            None,
            "an unmappable signal must stay unknown rather than become -1"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn local_process_signal_death_reports_a_conventional_status() {
        let transport = WorkspaceStdio::spawn_local_process(
            "sh",
            &["-lc".to_string(), "kill -TERM $$".to_string()],
        )
        .unwrap();
        let (_stdin, _stdout, _stderr, _control, completion) = transport.into_parts();

        let exit = tokio::time::timeout(Duration::from_secs(5), completion.wait())
            .await
            .expect("signal death should complete the supervised process");

        assert_eq!(exit.exit_code, Some(143));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn local_process_round_trips_stdin_stdout_and_exit_status() {
        let transport = WorkspaceStdio::spawn_local_process(
            "sh",
            &[
                "-lc".to_string(),
                "cat; printf problem >&2; exit 7".to_string(),
            ],
        )
        .unwrap();
        let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
        stdin.write_all(b"hello").await.unwrap();
        stdin.shutdown().await.unwrap();

        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        stdout.read_to_end(&mut stdout_bytes).await.unwrap();
        stderr.read_to_end(&mut stderr_bytes).await.unwrap();
        let exit = completion.wait().await;

        assert_eq!(stdout_bytes, b"hello");
        assert_eq!(stderr_bytes, b"problem");
        assert_eq!(exit.exit_code, Some(7));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn local_process_interrupt_completes_with_interrupt_status() {
        let transport = WorkspaceStdio::spawn_local_process(
            "sh",
            &["-lc".to_string(), "while :; do sleep 1; done".to_string()],
        )
        .unwrap();
        let (_stdin, _stdout, _stderr, control, completion) = transport.into_parts();

        control.interrupt().await.unwrap();
        let exit = tokio::time::timeout(std::time::Duration::from_secs(2), completion.wait())
            .await
            .expect("interrupt should terminate the supervised process");

        assert_eq!(exit.exit_code, Some(130));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn local_process_control_invokes_target_signal_hook_before_shutdown() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let hook_called = Arc::new(AtomicBool::new(false));
        let hook: WorkspaceSignalHook = {
            let hook_called = hook_called.clone();
            Arc::new(move |_| {
                let hook_called = hook_called.clone();
                Box::pin(async move {
                    hook_called.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        let transport = WorkspaceStdio::spawn_local_process_with_signal_hook(
            "sh",
            &["-lc".to_string(), "sleep 0.1; exit 7".to_string()],
            Some(hook),
        )
        .unwrap();
        let (_stdin, _stdout, _stderr, control, completion) = transport.into_parts();

        control.interrupt().await.unwrap();
        let exit = tokio::time::timeout(std::time::Duration::from_secs(2), completion.wait())
            .await
            .expect("interrupt should terminate the supervised process");

        assert!(hook_called.load(Ordering::SeqCst));
        assert_eq!(
            exit.exit_code,
            Some(7),
            "a hook-handled soft interrupt must not kill the owning transport"
        );
    }

    /// A target-aware hook delivers the signal itself, and the local supervisor
    /// ends as soon as the target does, so it can be gone before the redundant
    /// control message is queued. That is the WSL and Docker kill ordering: hook
    /// first, control message second.
    #[tokio::test]
    async fn delivered_hook_signal_succeeds_when_the_owner_already_finished() {
        let hook: WorkspaceSignalHook = Arc::new(|_| Box::pin(async { Ok(()) }));
        let pipes = WorkspacePipes::new(Some(hook));
        let control = pipes.control.clone();
        // Dropping the owner is what `run_local_process` does when the target
        // exits; only the receiving side of the control channel goes away.
        drop(pipes);

        control
            .kill()
            .await
            .expect("a delivered kill must not be reported as a missing process");
    }

    #[tokio::test]
    async fn closed_control_channel_still_reports_a_missing_process_without_a_hook() {
        let pipes = WorkspacePipes::new(None);
        let control = pipes.control.clone();
        drop(pipes);

        let error = control.kill().await.unwrap_err();
        assert!(
            error.to_string().contains("already exited"),
            "an unhandled signal to a finished process must stay an error, got: {error}"
        );
    }

    #[tokio::test]
    async fn hook_failure_is_reported_even_when_the_owner_already_finished() {
        let hook: WorkspaceSignalHook =
            Arc::new(|_| Box::pin(async { Err(anyhow!("target refused the signal")) }));
        let pipes = WorkspacePipes::new(Some(hook));
        let control = pipes.control.clone();
        drop(pipes);

        let error = control.kill().await.unwrap_err();
        assert!(
            error.to_string().contains("target refused the signal"),
            "the target's own failure must win, got: {error}"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn dropping_the_control_handle_does_not_end_the_local_process() {
        let transport = WorkspaceStdio::spawn_local_process(
            "sh",
            &["-lc".to_string(), "sleep 0.3; exit 5".to_string()],
        )
        .unwrap();
        let (_stdin, _stdout, _stderr, control, completion) = transport.into_parts();
        // The IO streams are the lease; this handle is not.
        drop(control);

        let exit = tokio::time::timeout(std::time::Duration::from_secs(5), completion.wait())
            .await
            .expect("the process should run to its own end");

        assert_eq!(
            exit.exit_code,
            Some(5),
            "a dropped control handle must not be read as a kill request"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn dropping_all_io_streams_cancels_local_process() {
        let transport = WorkspaceStdio::spawn_local_process(
            "sh",
            &["-lc".to_string(), "while :; do sleep 1; done".to_string()],
        )
        .unwrap();
        let (stdin, stdout, stderr, _control, completion) = transport.into_parts();
        drop(stdin);
        drop(stdout);
        drop(stderr);

        let exit = tokio::time::timeout(std::time::Duration::from_secs(2), completion.wait())
            .await
            .expect("dropping all IO should terminate the supervised process");

        assert_eq!(exit.exit_code, Some(137));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn dropping_all_io_streams_invokes_target_kill_hook() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let hook_called = Arc::new(AtomicBool::new(false));
        let hook: WorkspaceSignalHook = {
            let hook_called = hook_called.clone();
            Arc::new(move |signal| {
                let hook_called = hook_called.clone();
                Box::pin(async move {
                    assert_eq!(signal, WorkspaceProcessSignal::Kill);
                    hook_called.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        let transport = WorkspaceStdio::spawn_local_process_with_signal_hook(
            "sh",
            &["-lc".to_string(), "while :; do sleep 1; done".to_string()],
            Some(hook),
        )
        .unwrap();
        let (stdin, stdout, stderr, _control, completion) = transport.into_parts();
        drop(stdin);
        drop(stdout);
        drop(stderr);

        let exit = tokio::time::timeout(std::time::Duration::from_secs(2), completion.wait())
            .await
            .expect("dropping all IO should terminate the supervised process");

        assert!(hook_called.load(Ordering::SeqCst));
        assert_eq!(exit.exit_code, Some(137));
    }
}
