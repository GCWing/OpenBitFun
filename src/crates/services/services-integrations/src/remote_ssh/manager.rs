//! SSH Connection Manager using russh
//!
//! This module manages SSH connections using the pure-Russ SSH implementation

use super::sftp_file::ManagedSftpSession;
use crate::remote_ssh::password_vault::SSHPasswordVault;
use crate::remote_ssh::types::{
    ConnectionTestReport, ConnectionTestStage, ContainerAccess, ContainerWorkspaceConfig,
    DockerContainerInfo, SSHAuthMethod, SSHCommandOptions, SSHCommandResult, SSHConfigEntry,
    SSHConfigLookupResult, SSHConnectionConfig, SSHConnectionResult, SavedConnection, ServerInfo,
};
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use openbitfun_services_core::{process_manager, product_identity::hidden_data_directory};
use russh::client::{DisconnectReason, Handle, Handler, Msg};
use russh::Sig;
use russh_keys::key::{KeyPair, PublicKey};
use russh_keys::PublicKeyBase64;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{File as SftpFile, StatusCode as SftpStatusCode};
#[cfg(feature = "ssh_config")]
use ssh_config::SSHConfig;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Once;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::{Duration, Instant};

const SSH_COMMAND_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SSH_COMMAND_INTERRUPT_DRAIN_GRACE: Duration = Duration::from_millis(500);
const SSH_COMMAND_OWNER_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// The caller owns cancellation, while the spawned transport task owns the
/// channel until interruption and draining have finished. The caller may stop
/// waiting before a late channel-open confirmation arrives, but must not drop
/// the owner or leave an uncancelled command detached.
struct CancelSshCommandOnDrop(tokio_util::sync::CancellationToken);

impl Drop for CancelSshCommandOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

enum SshOwnerOutcome<T> {
    Finished(T),
    Stopped(SshCommandStop, Option<T>),
}

/// Keep transport facts private rather than inferring them from status numbers:
/// a server may legitimately exit with 124 or 130.
struct SshCommandOutput {
    result: SSHCommandResult,
    exit_status_received: bool,
}

/// A completed owner task may be dropped before its caller receives the raw
/// channel. Unlike WorkspaceStdio, russh::Channel has no close-on-drop lease.
struct SshExecChannelHandoff {
    channel: Option<russh::Channel<Msg>>,
    runtime: tokio::runtime::Handle,
}

impl SshExecChannelHandoff {
    fn new(channel: russh::Channel<Msg>) -> Self {
        Self {
            channel: Some(channel),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    fn into_channel(mut self) -> russh::Channel<Msg> {
        self.channel
            .take()
            .expect("SSH channel handoff is consumed once")
    }
}

impl Drop for SshExecChannelHandoff {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            // Handoffs are created and consumed by Tokio owner tasks. Retain
            // the channel while asynchronously closing an abandoned result.
            self.runtime.spawn(async move {
                SSHConnectionManager::close_exec_channel(&channel, true).await;
            });
        }
    }
}

async fn supervise_ssh_owner<T, F, Fut>(
    mut options: SSHCommandOptions,
    execute: F,
) -> anyhow::Result<SshOwnerOutcome<T>>
where
    T: Send + 'static,
    F: FnOnce(SSHCommandOptions) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T> + Send + 'static,
{
    let deadline = options
        .timeout_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms));
    let cancellation = options
        .cancellation_token
        .as_ref()
        .map(tokio_util::sync::CancellationToken::child_token)
        .unwrap_or_default();
    options.cancellation_token = Some(cancellation.clone());
    let _cancel_on_drop = CancelSshCommandOnDrop(cancellation.clone());
    let mut owner = tokio::spawn(async move { execute(options).await });
    match await_ssh_command_phase(&mut owner, Some(&cancellation), deadline).await {
        Ok(result) => Ok(SshOwnerOutcome::Finished(
            result.context("SSH owner task failed")?,
        )),
        Err(stop) => {
            cancellation.cancel();
            // Most owners finish INT/drain/close promptly; preserve their
            // partial output and actual status when they do. A channel-open
            // reply can arrive arbitrarily later, so only the caller's wait
            // is bounded. Dropping this handle detaches the cancelled owner,
            // which retains the pending request and closes its eventual channel.
            match tokio::time::timeout(SSH_COMMAND_OWNER_DRAIN_GRACE, &mut owner).await {
                Ok(result) => Ok(SshOwnerOutcome::Stopped(
                    stop,
                    Some(result.context("SSH owner task failed")?),
                )),
                Err(_) => Ok(SshOwnerOutcome::Stopped(stop, None)),
            }
        }
    }
}

async fn supervise_ssh_command<F, Fut>(
    options: SSHCommandOptions,
    execute: F,
) -> anyhow::Result<SSHCommandResult>
where
    F: FnOnce(SSHCommandOptions) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = anyhow::Result<SshCommandOutput>> + Send + 'static,
{
    match supervise_ssh_owner(options, execute).await? {
        SshOwnerOutcome::Finished(result) => result.map(|output| output.result),
        SshOwnerOutcome::Stopped(stop, Some(Ok(output))) => {
            let mut result = output.result;
            // The supervisor owns the stop reason. Its timeout deliberately
            // cancels the owner's child token to interrupt setup immediately.
            result.interrupted = stop == SshCommandStop::Cancelled;
            result.timed_out = stop == SshCommandStop::TimedOut;
            if !output.exit_status_received {
                result.exit_code = stop.result().exit_code;
            }
            Ok(result)
        }
        SshOwnerOutcome::Stopped(stop, _) => Ok(stop.result()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshCommandStop {
    Cancelled,
    TimedOut,
}

impl SshCommandStop {
    fn error(self) -> anyhow::Error {
        anyhow!(match self {
            Self::Cancelled => "SSH operation was cancelled",
            Self::TimedOut => "SSH operation timed out",
        })
    }

    fn result(self) -> SSHCommandResult {
        SSHCommandResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: if self == Self::Cancelled { 130 } else { 124 },
            interrupted: self == Self::Cancelled,
            timed_out: self == Self::TimedOut,
        }
    }

    fn output(self) -> SshCommandOutput {
        SshCommandOutput {
            result: self.result(),
            exit_status_received: false,
        }
    }
}

/// Include channel-open and exec-request waits in the same command deadline.
/// The owner retains any in-progress open future so a late channel can be
/// closed without ever starting the cancelled command.
async fn await_ssh_command_phase<F: std::future::Future>(
    phase: F,
    cancellation: Option<&tokio_util::sync::CancellationToken>,
    deadline: Option<Instant>,
) -> Result<F::Output, SshCommandStop> {
    tokio::select! {
        biased;
        _ = async {
            match cancellation {
                Some(token) => token.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        } => Err(SshCommandStop::Cancelled),
        _ = async {
            match deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        } => Err(SshCommandStop::TimedOut),
        result = phase => Ok(result),
    }
}

/// Forward-only container file stream with bounded buffering and checked exit status.
struct ContainerFileReader {
    reader: tokio::io::DuplexStream,
    transfer: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    #[cfg(test)]
    completion: crate::remote_ssh::WorkspaceProcessCompletion,
}

impl ContainerFileReader {
    fn from_transport(transport: crate::remote_ssh::WorkspaceStdio) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (reader, mut writer) = tokio::io::duplex(256 * 1024);
        let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
        #[cfg(test)]
        let observed_completion = completion.clone();
        let transfer = tokio::spawn(async move {
            stdin.shutdown().await?;
            drop(stdin);
            let drain_stderr = async move {
                let mut retained = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let count = stderr.read(&mut chunk).await?;
                    if count == 0 {
                        break;
                    }
                    let keep = count.min(16_384usize.saturating_sub(retained.len()));
                    retained.extend_from_slice(&chunk[..keep]);
                }
                Ok::<_, std::io::Error>(retained)
            };
            let (_, stderr) =
                tokio::try_join!(tokio::io::copy(&mut stdout, &mut writer), drain_stderr)?;
            let exit = completion.wait().await;
            if exit.exit_code != Some(0) {
                return Err(std::io::Error::other(format!(
                    "Container file stream failed: exit_status={:?} {}",
                    exit.exit_code,
                    String::from_utf8_lossy(&stderr).trim()
                )));
            }
            Ok(())
        });
        Self {
            reader,
            transfer: Some(transfer),
            #[cfg(test)]
            completion: observed_completion,
        }
    }
}

/// Byte source for one streamed container upload.
///
/// Both arms feed the same staging command; only the local reader differs, so a
/// local file never has to be buffered in memory first.
enum ContainerUploadSource<'a> {
    Memory(&'a [u8]),
    LocalFile(std::path::PathBuf),
}

/// Stop a container upload process and wait for its target-aware cleanup while
/// preserving the caller's error as the operation result.
async fn abort_container_upload(
    control: &crate::remote_ssh::WorkspaceProcessControl,
    completion: crate::remote_ssh::WorkspaceProcessCompletion,
    error: anyhow::Error,
) -> anyhow::Error {
    let _ = control.kill().await;
    let _ = completion.wait().await;
    error
}

impl AsyncRead for ContainerFileReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::future::Future;
        use std::pin::Pin;
        use std::task::Poll;
        let this = self.get_mut();
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let before = buf.filled().len();
        match Pin::new(&mut this.reader).poll_read(cx, buf) {
            Poll::Ready(Ok(())) if buf.filled().len() == before => {
                let Some(transfer) = this.transfer.as_mut() else {
                    return Poll::Ready(Ok(()));
                };
                match Pin::new(transfer).poll(cx) {
                    Poll::Pending => Poll::Pending,
                    Poll::Ready(result) => {
                        this.transfer = None;
                        Poll::Ready(
                            result
                                .map_err(std::io::Error::other)
                                .and_then(|result| result),
                        )
                    }
                }
            }
            result => result,
        }
    }
}

impl tokio::io::AsyncSeek for ContainerFileReader {
    fn start_seek(
        self: std::pin::Pin<&mut Self>,
        _position: std::io::SeekFrom,
    ) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Container file streams support sequential reads only",
        ))
    }

    fn poll_complete(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<u64>> {
        std::task::Poll::Ready(Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Container file streams support sequential reads only",
        )))
    }
}

impl Drop for ContainerFileReader {
    fn drop(&mut self) {
        if let Some(transfer) = &self.transfer {
            transfer.abort();
        }
    }
}

const CONTAINER_ENTRY_METADATA_SCRIPT: &str = "\
name=${item##*/}; \
if [ -L \"$item\" ]; then kind=l; \
elif [ -d \"$item\" ]; then kind=d; \
elif [ -f \"$item\" ]; then kind=f; \
else kind=o; fi; \
if [ \"$kind\" = d ]; then size=; \
else size=$(stat -c %s \"$item\" 2>/dev/null || stat -f %z \"$item\" 2>/dev/null || true); fi; \
mtime=$(stat -c %Y \"$item\" 2>/dev/null || stat -f %m \"$item\" 2>/dev/null || true); \
mode=$(stat -c %a \"$item\" 2>/dev/null || stat -f %Lp \"$item\" 2>/dev/null || true); \
printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' \"$name\" \"$item\" \"$kind\" \"$size\" \"$mtime\" \"$mode\";";

fn sftp_error_may_be_stale_transport(error: &SftpError) -> bool {
    match error {
        SftpError::Status(status) => matches!(
            status.status_code,
            SftpStatusCode::NoConnection | SftpStatusCode::ConnectionLost
        ),
        SftpError::IO(_) | SftpError::Timeout | SftpError::UnexpectedBehavior(_) => true,
        SftpError::Limited(_) | SftpError::UnexpectedPacket => false,
    }
}

fn container_read_dir_script(path: &str, max_entries: Option<usize>) -> String {
    let quoted = crate::remote_ssh::shell::quote_arg(path);
    let entry_loop = crate::remote_ssh::shell::quote_arg(&format!(
        "for item do [ -e \"$item\" ] || [ -L \"$item\" ] || continue; {CONTAINER_ENTRY_METADATA_SCRIPT} done"
    ));
    let (head_probe, producer) = match max_entries {
        Some(max_entries) => (
            "command -v head >/dev/null 2>&1 && head -z -n 0 </dev/null >/dev/null 2>&1 || { echo 'NUL-delimited bounded directory reads require head -z' >&2; exit 78; }; ",
            format!(
                "find \"$dir\" -mindepth 1 -maxdepth 1 -print0 | head -z -n {max_entries}"
            ),
        ),
        None => (
            "",
            "find \"$dir\" -mindepth 1 -maxdepth 1 -print0".to_string(),
        ),
    };
    format!(
        "dir={quoted}; \
         [ -d \"$dir\" ] && [ ! -L \"$dir\" ] || {{ echo 'Container directory is missing or is a symbolic link' >&2; exit 44; }}; \
         command -v find >/dev/null 2>&1 && command -v xargs >/dev/null 2>&1 || {{ echo 'Container directory reads require find and xargs' >&2; exit 78; }}; \
         {head_probe}\
         {producer} | xargs -0 -n 64 sh -c {entry_loop} sh"
    )
}

fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }

    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// OpenSSH keyword matching is case-insensitive, but `ssh_config` stores keys as written in the file
/// (e.g. `HostName` vs `Hostname`). Resolve by ASCII case-insensitive compare.
#[cfg(feature = "ssh_config")]
fn ssh_cfg_get<'a>(
    settings: &std::collections::HashMap<&'a str, &'a str>,
    canonical_key: &str,
) -> Option<&'a str> {
    settings
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(canonical_key))
        .map(|(_, v)| *v)
}

#[cfg(feature = "ssh_config")]
fn ssh_cfg_has(settings: &std::collections::HashMap<&str, &str>, canonical_key: &str) -> bool {
    settings
        .keys()
        .any(|k| k.eq_ignore_ascii_case(canonical_key))
}

/// Extract the first value from an SSH config directive line, handling double-quoted strings.
///
/// SSH config values may be enclosed in double quotes when they contain whitespace
/// (e.g. `IdentityFile "~/.ssh/my key"`). This function correctly extracts the full
/// quoted value or the first whitespace-delimited token for unquoted values.
fn parse_ssh_config_value(value: &str) -> Option<&str> {
    let value = value.trim();
    if let Some(quoted) = value.strip_prefix('"') {
        if let Some(end) = quoted.find('"') {
            let inner = &quoted[..end];
            return if inner.is_empty() { None } else { Some(inner) };
        }
    }
    value.split_whitespace().next()
}

#[cfg(feature = "ssh_config")]
fn strip_utf8_bom(content: String) -> String {
    content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string()
}

/// Manually parse `~/.ssh/config` content into Host blocks with their direct settings.
///
/// This is a fallback for when `SSHConfig::parse_str` fails — which happens when the
/// config contains directives (e.g. `Include`, `Match`) before the first `Host` block,
/// because `ssh_config` 0.1's `EntryParser` returns `InvalidHostEntry` for any key-value
/// pair without a preceding `Host` directive, and `parse_str` fails the entire operation
/// on the first parser error.
///
/// Only direct settings within each `Host` block are captured; pattern-matched settings
/// from wildcard blocks (e.g. `Host *`) are not applied. Use `SSHConfig::query()` as a
/// supplementary source when `parse_str` succeeds.
#[cfg(feature = "ssh_config")]
fn parse_ssh_config_manually(content: &str) -> Vec<SSHConfigEntry> {
    let mut hosts = Vec::new();
    let mut current_host: Option<String> = None;
    let mut block_hostname: Option<String> = None;
    let mut block_port: Option<u16> = None;
    let mut block_user: Option<String> = None;
    let mut block_identity_file: Option<String> = None;
    let mut block_certificate_file: Option<String> = None;
    let mut block_proxy_jump: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (keyword, value) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k, v.trim()),
            None => continue,
        };

        if keyword.eq_ignore_ascii_case("Host") {
            // Save previous host block
            if let Some(host) = current_host.take() {
                hosts.push(SSHConfigEntry {
                    host,
                    hostname: block_hostname.take(),
                    port: block_port.take(),
                    user: block_user.take(),
                    identity_file: block_identity_file.take(),
                    agent: Some(true),
                    certificate_file: block_certificate_file.take(),
                    proxy_jump: block_proxy_jump.take(),
                });
            }

            // Start new host block — take the first alias
            current_host = value.split_whitespace().next().map(|s| s.to_string());
            block_hostname = None;
            block_port = None;
            block_user = None;
            block_identity_file = None;
            block_certificate_file = None;
            block_proxy_jump = None;
        } else if current_host.is_some() {
            // Track details within the current Host block
            if keyword.eq_ignore_ascii_case("HostName") {
                block_hostname = parse_ssh_config_value(value).map(|s| s.to_string());
            } else if keyword.eq_ignore_ascii_case("Port") {
                block_port = parse_ssh_config_value(value).and_then(|s| s.parse().ok());
            } else if keyword.eq_ignore_ascii_case("User") {
                block_user = parse_ssh_config_value(value).map(|s| s.to_string());
            } else if keyword.eq_ignore_ascii_case("IdentityFile") {
                block_identity_file =
                    parse_ssh_config_value(value).map(|s| shellexpand::tilde(s).to_string());
            } else if keyword.eq_ignore_ascii_case("CertificateFile") {
                block_certificate_file =
                    parse_ssh_config_value(value).map(|s| shellexpand::tilde(s).to_string());
            } else if keyword.eq_ignore_ascii_case("ProxyJump") {
                block_proxy_jump = parse_ssh_config_value(value).map(ToOwned::to_owned);
            }
        }
    }

    // Save last host block
    if let Some(host) = current_host {
        hosts.push(SSHConfigEntry {
            host,
            hostname: block_hostname,
            port: block_port,
            user: block_user,
            identity_file: block_identity_file,
            agent: Some(true),
            certificate_file: block_certificate_file,
            proxy_jump: block_proxy_jump,
        });
    }

    hosts
}

/// Known hosts entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

/// Active SSH connection
struct ActiveConnection {
    /// Absent for local process transports (Docker and WSL).
    handle: Option<Arc<Handle<SSHHandler>>>,
    /// Keep every preceding hop alive while the final transport is using its
    /// direct-tcpip channel as the underlying stream.
    jump_handles: Vec<Arc<Handle<SSHHandler>>>,
    /// User-authored/persisted configuration used for drift detection.
    config: SSHConnectionConfig,
    /// Runtime target after resolving `containerAccess: auto`.
    effective_config: SSHConnectionConfig,
    server_info: Option<ServerInfo>,
    sftp_session: Arc<SftpCache>,
    bounded_sftp_session: Arc<BoundedSftpCache>,
    #[allow(dead_code)]
    server_key: Option<PublicKey>,
    /// Liveness flag; flipped to false from `SSHHandler::disconnected`.
    /// Allows `is_connected` and SFTP/exec entry points to detect a dead session
    /// without waiting for the next failed I/O.
    alive: Arc<AtomicBool>,
}

struct SftpCache {
    session: tokio::sync::RwLock<Option<Arc<ManagedSftpSession>>>,
    init_lock: tokio::sync::Mutex<()>,
}

impl SftpCache {
    fn new() -> Self {
        Self {
            session: tokio::sync::RwLock::new(None),
            init_lock: tokio::sync::Mutex::new(()),
        }
    }
}

struct BoundedSftpChannel {
    retired: AtomicBool,
    session: Arc<RawSftpSession>,
    read_lock: tokio::sync::Mutex<()>,
}

struct BoundedSftpCache {
    channel: tokio::sync::RwLock<Option<Arc<BoundedSftpChannel>>>,
    init_lock: tokio::sync::Mutex<()>,
}

impl BoundedSftpCache {
    fn new() -> Self {
        Self {
            channel: tokio::sync::RwLock::new(None),
            init_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Clone)]
struct BoundedSftpSession {
    channel: Arc<BoundedSftpChannel>,
    cache: Arc<BoundedSftpCache>,
}

struct BoundedSftpReadGuard {
    channel: Arc<BoundedSftpChannel>,
    armed: bool,
}

impl BoundedSftpReadGuard {
    fn new(channel: Arc<BoundedSftpChannel>) -> Self {
        Self {
            channel,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BoundedSftpReadGuard {
    fn drop(&mut self) {
        if self.armed {
            self.channel.retired.store(true, Ordering::Release);
            let _ = self.channel.session.close_session();
        }
    }
}

struct EstablishedSession {
    handle: Option<Arc<Handle<SSHHandler>>>,
    jump_handles: Vec<Arc<Handle<SSHHandler>>>,
    alive: Arc<AtomicBool>,
    server_info: Option<ServerInfo>,
    effective_config: SSHConnectionConfig,
    unpublished: UnpublishedSshSession,
}

/// Owns authenticated transports until the complete chain is published. A
/// timed-out probe may still hold an Arc while awaiting channel confirmation,
/// so dropping the caller's handles alone cannot end a failed connection.
#[derive(Default)]
struct UnpublishedSshSession {
    // Creation order is first jump through final target. One guard owns the
    // whole chain so cancellation cannot race independent hop cleanups.
    handles: Vec<Arc<Handle<SSHHandler>>>,
}

impl UnpublishedSshSession {
    fn track(&mut self, handle: &Arc<Handle<SSHHandler>>) {
        self.handles.push(handle.clone());
    }

    fn disarm(&mut self) {
        self.handles.clear();
    }
}

impl Drop for UnpublishedSshSession {
    fn drop(&mut self) {
        if self.handles.is_empty() {
            return;
        }
        let handles = std::mem::take(&mut self.handles);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let chain = handles.iter().rev().map(Arc::as_ref).collect();
                    SSHConnectionManager::shutdown_handle_chain(chain).await;
                });
            }
            Err(error) => log::warn!(
                "Unpublished SSH session cleanup has no active runtime: {}",
                error
            ),
        }
    }
}

/// Which stage of the connection chain an error came from.
///
/// `test_connection` needs this to attribute a failure exactly; matching on
/// message text cannot, because two jump hosts may share a `user@host:port`
/// label and the first match then always wins.
///
/// Deliberately *not* an `anyhow` context: a context replaces the error's
/// `Display`, so tagging this way would turn every SSH error the user sees into
/// "connection stage 'target'". This wrapper is transparent instead — `Display`
/// and `source` both delegate, so `{}`, `{:#}` and `chain()` all read exactly as
/// they did before the tag existed.
#[derive(Debug)]
struct StagedError {
    stage: String,
    inner: anyhow::Error,
}

impl std::fmt::Display for StagedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.inner, formatter)
    }
}

impl std::error::Error for StagedError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.inner.source()
    }
}

/// Per-handle ceiling for the goodbye packet. Generous for a local channel
/// send, short enough that a chain of dead hops cannot stall shutdown.
const SSH_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Per-request SFTP response timeout.
///
/// russh-sftp defaults to 10 s, which the 256 KiB chunk this client sends turns
/// into a ~25 KiB/s throughput floor: on a healthy but slow link every request
/// would time out instead of transferring slowly. A single stalled request is
/// still bounded here, and the SSH transport independently drops a connection
/// that stops answering.
const SFTP_REQUEST_TIMEOUT_SECS: u64 = 60;

fn sftp_client_config() -> russh_sftp::client::Config {
    russh_sftp::client::Config {
        request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
        ..Default::default()
    }
}

fn tag_failed_stage(stage: &str, error: anyhow::Error) -> anyhow::Error {
    anyhow::Error::new(StagedError {
        stage: stage.to_string(),
        inner: error,
    })
}

/// Outermost stage tag in an error's chain, if any.
fn failed_stage_of(error: &anyhow::Error) -> Option<&str> {
    error
        .downcast_ref::<StagedError>()
        .map(|staged| staged.stage.as_str())
}

/// SSH client handler with host key verification
struct SSHHandler {
    /// Expected host key (if connecting to known host)
    expected_key: Option<(String, u16, PublicKey)>,
    /// Callback for new host key verification
    verify_callback: Option<Box<HostKeyVerifyCallback>>,
    /// Known hosts storage for verification
    known_hosts: Option<Arc<tokio::sync::RwLock<HashMap<String, KnownHostEntry>>>>,
    /// Host info for known hosts lookup
    host: Option<String>,
    port: Option<u16>,
    /// Stores the real disconnect reason so callers get a useful error message.
    /// russh's run() absorbs errors internally; we capture them here and
    /// surface them after connect_stream() returns.
    /// Uses std::sync::Mutex so it can be read from sync map_err closures.
    disconnect_reason: Arc<std::sync::Mutex<Option<String>>>,
    /// Shared liveness flag, flipped to false on disconnect so the manager
    /// can detect dead sessions and trigger transparent reconnect.
    alive: Arc<AtomicBool>,
}

type HostKeyVerifyCallback = dyn Fn(String, u16, &PublicKey) -> bool + Send + Sync;

impl SSHHandler {
    #[allow(dead_code)]
    fn new() -> Self {
        Self {
            expected_key: None,
            verify_callback: None,
            known_hosts: None,
            host: None,
            port: None,
            disconnect_reason: Arc::new(std::sync::Mutex::new(None)),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    #[allow(dead_code)]
    fn with_expected_key(host: String, port: u16, key: PublicKey) -> Self {
        Self {
            expected_key: Some((host, port, key)),
            verify_callback: None,
            known_hosts: None,
            host: None,
            port: None,
            disconnect_reason: Arc::new(std::sync::Mutex::new(None)),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    #[allow(dead_code)]
    fn with_verify_callback<F>(callback: F) -> Self
    where
        F: Fn(String, u16, &PublicKey) -> bool + Send + Sync + 'static,
    {
        Self {
            expected_key: None,
            verify_callback: Some(Box::new(callback)),
            known_hosts: None,
            host: None,
            port: None,
            disconnect_reason: Arc::new(std::sync::Mutex::new(None)),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    fn with_known_hosts(
        host: String,
        port: u16,
        known_hosts: Arc<tokio::sync::RwLock<HashMap<String, KnownHostEntry>>>,
    ) -> (Self, Arc<std::sync::Mutex<Option<String>>>, Arc<AtomicBool>) {
        let disconnect_reason = Arc::new(std::sync::Mutex::new(None));
        let alive = Arc::new(AtomicBool::new(true));
        let handler = Self {
            expected_key: None,
            verify_callback: None,
            known_hosts: Some(known_hosts),
            host: Some(host),
            port: Some(port),
            disconnect_reason: disconnect_reason.clone(),
            alive: alive.clone(),
        };
        (handler, disconnect_reason, alive)
    }
}

#[derive(Debug)]
struct HandlerError(String);

impl std::fmt::Display for HandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HandlerError {}

impl From<russh::Error> for HandlerError {
    fn from(e: russh::Error) -> Self {
        HandlerError(format!("{:?}", e))
    }
}

impl From<String> for HandlerError {
    fn from(s: String) -> Self {
        HandlerError(s)
    }
}

#[async_trait]
impl Handler for SSHHandler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let server_fingerprint = server_public_key.fingerprint();

        // 1. If we have an expected key, verify it matches
        if let Some((ref host, port, ref expected)) = self.expected_key {
            if expected.fingerprint() == server_fingerprint {
                log::debug!("Server key matches expected key for {}:{}", host, port);
                return Ok(true);
            }
            log::warn!(
                "Server key mismatch for {}:{}. Expected fingerprint: {}, got: {}",
                host,
                port,
                expected.fingerprint(),
                server_fingerprint
            );
            return Err(HandlerError(format!(
                "Host key mismatch for {}:{}: expected {}, got {}",
                host,
                port,
                expected.fingerprint(),
                server_fingerprint
            )));
        }

        // 2. Check known_hosts for this host
        if let (Some(host), Some(port)) = (self.host.as_ref(), self.port) {
            if let Some(known_hosts) = self.known_hosts.as_ref() {
                let key = format!("{}:{}", host, port);
                let known_guard = known_hosts.read().await;
                if let Some(known) = known_guard.get(&key) {
                    let stored_fingerprint = known.fingerprint.clone();
                    drop(known_guard);

                    if stored_fingerprint == server_fingerprint {
                        log::debug!("Server key verified from known_hosts for {}:{}", host, port);
                        return Ok(true);
                    } else {
                        log::warn!(
                            "Host key changed for {}:{}. Expected: {}, got: {}",
                            host,
                            port,
                            stored_fingerprint,
                            server_fingerprint
                        );
                        return Err(HandlerError(format!(
                            "Host key changed for {}:{} — stored fingerprint {} does not match server fingerprint {}. \
                             If the server key was legitimately updated, clear the known host entry and reconnect.",
                            host, port, stored_fingerprint, server_fingerprint
                        )));
                    }
                }
            }
        }

        // 3. If we have a verify callback, use it
        if let Some(ref callback) = self.verify_callback {
            let host = self.host.as_deref().unwrap_or("");
            let port = self.port.unwrap_or(22);
            if callback(host.to_string(), port, server_public_key) {
                log::debug!("Server key verified via callback for {}:{}", host, port);
                return Ok(true);
            }
            return Err(HandlerError(
                "Host key rejected by verify callback".to_string(),
            ));
        }

        // 4. First time connection - accept the key (like standard SSH client's StrictHostKeyChecking=accept-new)
        // This is safe for development and matches user expectations
        log::info!(
            "First time connection - accepting server key. Host: {}, Port: {}, Fingerprint: {}",
            self.host.as_deref().unwrap_or("unknown"),
            self.port.unwrap_or(22),
            server_fingerprint
        );
        Ok(true)
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let msg = match &reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                format!(
                    "Server sent disconnect: {:?} — {}",
                    info.reason_code, info.message
                )
            }
            DisconnectReason::Error(e) => {
                format!("Connection closed with error: {}", e)
            }
        };
        log::warn!(
            "SSH disconnected ({}:{}): {}",
            self.host.as_deref().unwrap_or("?"),
            self.port.unwrap_or(22),
            msg
        );
        if let Ok(mut guard) = self.disconnect_reason.lock() {
            *guard = Some(msg);
        }
        // Flip the shared liveness flag so the manager can detect the dead
        // session and trigger transparent reconnect on the next SFTP/exec call.
        self.alive.store(false, Ordering::SeqCst);
        // Propagate errors so russh surfaces them; swallow clean server disconnect.
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

fn connection_label(config: &SSHConnectionConfig) -> String {
    format!("{}@{}:{}", config.username, config.host, config.port)
}

fn local_username() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_proxy_jump_token(value: &str) -> anyhow::Result<(Option<String>, String, Option<u16>)> {
    let (user, address) = match value.rsplit_once('@') {
        Some((user, address)) if !user.trim().is_empty() => {
            (Some(user.trim().to_string()), address.trim())
        }
        _ => (None, value.trim()),
    };
    if address.is_empty() {
        anyhow::bail!("Invalid ProxyJump entry '{}': host is empty", value);
    }

    if let Some(rest) = address.strip_prefix('[') {
        let close = rest
            .find(']')
            .ok_or_else(|| anyhow!("Invalid ProxyJump entry '{}': missing closing ']'", value))?;
        let host = &rest[..close];
        let suffix = &rest[close + 1..];
        let port = if suffix.is_empty() {
            None
        } else {
            let port = suffix.strip_prefix(':').ok_or_else(|| {
                anyhow!(
                    "Invalid ProxyJump entry '{}': expected :port after ']'",
                    value
                )
            })?;
            Some(
                port.parse::<u16>()
                    .with_context(|| format!("Invalid ProxyJump port in '{}'", value))?,
            )
        };
        return Ok((user, host.to_string(), port));
    }

    let colon_count = address.bytes().filter(|byte| *byte == b':').count();
    let (host, port) = if colon_count == 1 {
        let (host, port) = address
            .rsplit_once(':')
            .expect("one colon must be splittable");
        match port.parse::<u16>() {
            Ok(port) => (host.to_string(), Some(port)),
            Err(_) => (address.to_string(), None),
        }
    } else {
        (address.to_string(), None)
    };
    if host.trim().is_empty() {
        anyhow::bail!("Invalid ProxyJump entry '{}': host is empty", value);
    }
    Ok((user, host, port))
}

fn load_key_pair(auth: &SSHAuthMethod) -> anyhow::Result<Option<KeyPair>> {
    let SSHAuthMethod::PrivateKey {
        key_path,
        passphrase,
        ..
    } = auth
    else {
        return Ok(None);
    };

    let expanded = shellexpand::tilde(key_path);
    let key_content = match std::fs::read_to_string(expanded.as_ref()) {
        Ok(content) => content,
        Err(primary_error) => {
            let default_key = dirs::home_dir()
                .map(|home| home.join(".ssh").join("id_rsa"))
                .ok_or_else(|| {
                    anyhow!(
                        "Failed to read private key '{}': {}, and could not determine the home directory",
                        key_path,
                        primary_error
                    )
                })?;
            std::fs::read_to_string(&default_key).map_err(|fallback_error| {
                anyhow!(
                    "Failed to read private key '{}' ({}) and fallback key '{}' ({})",
                    key_path,
                    primary_error,
                    default_key.display(),
                    fallback_error
                )
            })?
        }
    };
    russh_keys::decode_secret_key(&key_content, passphrase.as_deref())
        .map(Some)
        .map_err(|error| anyhow!("Failed to decode private key '{}': {}", key_path, error))
}

fn build_ssh_client_config() -> Arc<russh::client::Config> {
    Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(180)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 6,
        preferred: russh::Preferred {
            kex: std::borrow::Cow::Owned(vec![
                russh::kex::CURVE25519,
                russh::kex::CURVE25519_PRE_RFC_8731,
                russh::kex::DH_G16_SHA512,
                russh::kex::DH_G14_SHA256,
                russh::kex::DH_G14_SHA1,
                russh::kex::DH_G1_SHA1,
                russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
                russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            ]),
            key: std::borrow::Cow::Owned(vec![
                russh_keys::key::ED25519,
                russh_keys::key::ECDSA_SHA2_NISTP256,
                russh_keys::key::ECDSA_SHA2_NISTP521,
                russh_keys::key::RSA_SHA2_256,
                russh_keys::key::RSA_SHA2_512,
                russh_keys::key::SSH_RSA,
            ]),
            ..russh::Preferred::DEFAULT
        },
        ..Default::default()
    })
}

async fn authenticate_agent_client<R>(
    handle: &mut Handle<SSHHandler>,
    config: &SSHConnectionConfig,
    stage: &str,
    fingerprint: Option<&str>,
    mut agent: russh_keys::agent::client::AgentClient<R>,
) -> anyhow::Result<bool>
where
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let keys = agent
        .request_identities()
        .await
        .with_context(|| format!("{} could not list SSH agent identities", stage))?;
    let mut matched = 0usize;
    for key in keys {
        if fingerprint.is_some_and(|expected| expected != key.fingerprint()) {
            continue;
        }
        matched += 1;
        let (returned_agent, result) = handle
            .authenticate_future(&config.username, key, agent)
            .await;
        agent = returned_agent;
        if result.with_context(|| format!("{} SSH agent signing failed", stage))? {
            return Ok(true);
        }
    }
    if matched == 0 {
        if let Some(fingerprint) = fingerprint {
            anyhow::bail!(
                "{} SSH agent has no identity with fingerprint '{}'",
                stage,
                fingerprint
            );
        }
    }
    Ok(false)
}

#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut Handle<SSHHandler>,
    config: &SSHConnectionConfig,
    stage: &str,
    fingerprint: Option<&str>,
) -> anyhow::Result<bool> {
    let agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .with_context(|| format!("{} could not connect to SSH_AUTH_SOCK", stage))?;
    authenticate_agent_client(handle, config, stage, fingerprint, agent).await
}

#[cfg(windows)]
async fn authenticate_with_agent(
    handle: &mut Handle<SSHHandler>,
    config: &SSHConnectionConfig,
    stage: &str,
    fingerprint: Option<&str>,
) -> anyhow::Result<bool> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let pipe = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
    let stream = ClientOptions::new()
        .open(&pipe)
        .with_context(|| format!("{} could not connect to SSH agent pipe '{}'", stage, pipe))?;
    let agent = russh_keys::agent::client::AgentClient::connect(stream);
    authenticate_agent_client(handle, config, stage, fingerprint, agent).await
}

async fn authenticate_keyboard_interactive(
    handle: &mut Handle<SSHHandler>,
    config: &SSHConnectionConfig,
    stage: &str,
    responses: &[String],
) -> anyhow::Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse;

    let max_rounds = usize::from(config.options.auth_attempts.max(1));
    let future = async {
        let mut response = handle
            .authenticate_keyboard_interactive_start(&config.username, None)
            .await
            .with_context(|| {
                format!(
                    "{} could not start keyboard-interactive authentication",
                    stage
                )
            })?;
        let mut cursor = 0usize;
        for round in 0..max_rounds {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let count = prompts.len();
                    if cursor + count > responses.len() {
                        let labels = prompts
                            .iter()
                            .map(|prompt| prompt.prompt.trim())
                            .filter(|prompt| !prompt.is_empty())
                            .collect::<Vec<_>>()
                            .join(", ");
                        anyhow::bail!(
                            "{} keyboard-interactive challenge requires {} more response(s){}",
                            stage,
                            count,
                            if labels.is_empty() {
                                String::new()
                            } else {
                                format!(" for: {}", labels)
                            }
                        );
                    }
                    let answers = responses[cursor..cursor + count].to_vec();
                    cursor += count;
                    response = handle
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .with_context(|| {
                            format!("{} keyboard-interactive round {} failed", stage, round + 1)
                        })?;
                }
            }
        }
        anyhow::bail!(
            "{} keyboard-interactive authentication exceeded {} challenge round(s)",
            stage,
            max_rounds
        )
    };
    tokio::time::timeout(
        Duration::from_secs(config.options.auth_timeout_secs.max(1)),
        future,
    )
    .await
    .map_err(|_| {
        anyhow!(
            "{} authentication timed out after {} seconds",
            stage,
            config.options.auth_timeout_secs.max(1)
        )
    })?
}

async fn authenticate_handle(
    handle: &mut Handle<SSHHandler>,
    config: &SSHConnectionConfig,
    stage: &str,
) -> anyhow::Result<()> {
    let authenticate = async {
        Ok::<bool, anyhow::Error>(match &config.auth {
            SSHAuthMethod::Password { password } => handle
                .authenticate_password(&config.username, password.clone())
                .await
                .map_err(|error| {
                    anyhow!("{} password authentication failed: {:?}", stage, error)
                })?,
            SSHAuthMethod::PrivateKey {
                certificate_path, ..
            } => {
                let key_pair = load_key_pair(&config.auth)?
                    .ok_or_else(|| anyhow!("{} private key was not loaded", stage))?;
                if let Some(certificate_path) = certificate_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let expanded = shellexpand::tilde(certificate_path);
                    let certificate = russh_keys::load_openssh_certificate(expanded.as_ref())
                        .with_context(|| {
                            format!(
                                "{} failed to load OpenSSH certificate '{}'",
                                stage, certificate_path
                            )
                        })?;
                    handle
                        .authenticate_openssh_cert(
                            &config.username,
                            Arc::new(key_pair),
                            certificate,
                        )
                        .await
                        .map_err(|error| {
                            anyhow!("{} certificate authentication failed: {:?}", stage, error)
                        })?
                } else {
                    handle
                        .authenticate_publickey(&config.username, Arc::new(key_pair))
                        .await
                        .map_err(|error| {
                            anyhow!("{} public key authentication failed: {:?}", stage, error)
                        })?
                }
            }
            SSHAuthMethod::Agent {
                key_fingerprint,
                fallback_key_path,
            } => match authenticate_with_agent(handle, config, stage, key_fingerprint.as_deref())
                .await
            {
                Ok(true) => true,
                Ok(false) | Err(_) if fallback_key_path.is_some() => {
                    let fallback = SSHAuthMethod::PrivateKey {
                        key_path: fallback_key_path
                            .clone()
                            .expect("guarded by fallback_key_path.is_some"),
                        passphrase: None,
                        certificate_path: None,
                    };
                    let key_pair = load_key_pair(&fallback)?
                        .ok_or_else(|| anyhow!("{} fallback private key was not loaded", stage))?;
                    handle
                        .authenticate_publickey(&config.username, Arc::new(key_pair))
                        .await
                        .map_err(|error| {
                            anyhow!(
                                "{} SSH agent and fallback key authentication failed: {:?}",
                                stage,
                                error
                            )
                        })?
                }
                Ok(false) => false,
                Err(error) => return Err(error),
            },
            SSHAuthMethod::KeyboardInteractive { responses } => {
                authenticate_keyboard_interactive(handle, config, stage, responses).await?
            }
        })
    };
    let authenticated = tokio::time::timeout(
        Duration::from_secs(config.options.auth_timeout_secs.max(1)),
        authenticate,
    )
    .await
    .map_err(|_| {
        anyhow!(
            "{} authentication timed out after {} seconds",
            stage,
            config.options.auth_timeout_secs.max(1)
        )
    })??;
    if !authenticated {
        anyhow::bail!(
            "{} authentication was rejected for user '{}'",
            stage,
            config.username
        );
    }
    Ok(())
}

fn validate_container_config(container: &ContainerWorkspaceConfig) -> anyhow::Result<()> {
    if container.name.trim().is_empty() {
        anyhow::bail!("Container name or ID is required");
    }
    if container.docker_path.trim().is_empty() {
        anyhow::bail!("Docker executable path is required");
    }
    if container.shell.trim().is_empty() {
        anyhow::bail!("Container shell is required");
    }
    if container.local && matches!(container.access, ContainerAccess::Sshd) {
        anyhow::bail!(
            "A local Docker container cannot use sshd access; choose docker-exec or auto instead. \
             To reach a container over SSH, configure it as a remote SSH host."
        );
    }
    Ok(())
}

fn docker_exec_args(container: &ContainerWorkspaceConfig, command: &str, tty: bool) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    if container.interactive || tty {
        args.push("-i".to_string());
    }
    if tty {
        args.push("-t".to_string());
    }
    if let Some(user) = container
        .user
        .as_deref()
        .map(str::trim)
        .filter(|user| !user.is_empty())
    {
        args.push("--user".to_string());
        args.push(user.to_string());
    }
    args.push(container.name.clone());
    args.push(container.shell.clone());
    args.push("-lc".to_string());
    args.push(command.to_string());
    args
}

fn docker_exec_host_command(
    container: &ContainerWorkspaceConfig,
    command: &str,
    tty: bool,
) -> String {
    let mut parts = vec![container.docker_path.clone()];
    parts.extend(docker_exec_args(container, command, tty));
    parts
        .iter()
        .map(String::as_str)
        .map(crate::remote_ssh::shell::quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn server_info_from_container_probe(
    container: &ContainerWorkspaceConfig,
    result: SSHCommandResult,
) -> anyhow::Result<ServerInfo> {
    if result.exit_code != 0 {
        anyhow::bail!(
            "Docker container '{}' is unavailable or could not start shell '{}': {}",
            container.name,
            container.shell,
            result.stderr.trim()
        );
    }
    let mut lines = result.stdout.lines();
    let os_type = lines.next().unwrap_or("unknown").trim().to_string();
    let hostname = lines.next().unwrap_or(&container.name).trim().to_string();
    let home_dir = lines.next().unwrap_or("/").trim().to_string();
    Ok(ServerInfo {
        os_type,
        hostname: if hostname.is_empty() {
            container.name.clone()
        } else {
            hostname
        },
        home_dir: if home_dir.is_empty() {
            "/".to_string()
        } else {
            home_dir
        },
    })
}

fn parse_docker_published_endpoint(output: &str) -> Option<(String, u16)> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let (host, port) = if let Some(rest) = line.strip_prefix('[') {
            let close = rest.find(']')?;
            let host = &rest[..close];
            let port = rest[close + 1..].strip_prefix(':')?;
            (host, port)
        } else {
            line.rsplit_once(':')?
        };
        let port = port.trim().parse::<u16>().ok()?;
        let host = match host.trim() {
            "" | "0.0.0.0" | "::" => "127.0.0.1",
            host => host,
        };
        Some((host.to_string(), port))
    })
}

fn parse_docker_container_list(output: &str) -> anyhow::Result<Vec<DockerContainerInfo>> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut fields = line.split('\t');
            let id = fields.next().unwrap_or_default().to_string();
            let name = fields.next().unwrap_or_default().to_string();
            let image = fields.next().unwrap_or_default().to_string();
            let status = fields.next().unwrap_or_default().to_string();
            let state = fields.next().unwrap_or_default().to_string();
            if id.is_empty() || name.is_empty() || fields.next().is_some() {
                anyhow::bail!("Docker returned a malformed container list entry");
            }
            Ok(DockerContainerInfo {
                id,
                name,
                image,
                status,
                state,
            })
        })
        .collect()
}

fn resolved_container_config(
    config: &SSHConnectionConfig,
    access: ContainerAccess,
) -> SSHConnectionConfig {
    let mut resolved = config.clone();
    if let Some(container) = resolved.container.as_mut() {
        container.access = access;
        if matches!(container.access, ContainerAccess::Sshd) {
            container.local = false;
        }
    }
    resolved
}

fn workspace_command(config: &SSHConnectionConfig, command: &str, tty: bool) -> String {
    match config.container.as_ref() {
        Some(container)
            if matches!(
                container.access,
                ContainerAccess::DockerExec | ContainerAccess::Auto
            ) =>
        {
            docker_exec_host_command(container, command, tty)
        }
        _ => command.to_string(),
    }
}

/// Shell prelude that removes orphaned upload temporaries.
///
/// The `trap cleanup EXIT` in the command below covers an orderly exit, but a
/// dropped SSH channel (network failure, laptop lid) kills the remote shell
/// without ever running it, so a long-lived host slowly accumulates orphans.
///
/// A day is the bound because the only thing distinguishing an orphan from a
/// live upload is age, and the cost of guessing wrong is a corrupted transfer
/// in another session. No real upload runs for 24 hours; plenty run for one.
fn stale_upload_sweep(quoted_dir: &str) -> String {
    let quoted_pattern =
        crate::remote_ssh::shell::quote_arg(&format!("{}-upload-*.tmp", hidden_data_directory()));
    format!(
        "if command -v find >/dev/null 2>&1; then \
           find {quoted_dir} -maxdepth 1 -name {quoted_pattern} -mmin +1440 \
             -exec rm -f -- {{}} \\; 2>/dev/null || true; \
         fi; "
    )
}

fn container_workspace_write_command(path: &str, temporary: &str, expected_size: usize) -> String {
    let quoted_path = crate::remote_ssh::shell::quote_arg(path);
    let quoted_temporary = crate::remote_ssh::shell::quote_arg(temporary);
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or(".");
    let sweep = stale_upload_sweep(&crate::remote_ssh::shell::quote_arg(parent));
    format!(
        "{sweep}tmp={quoted_temporary}; target={quoted_path}; expected={expected_size}; \
         saved_umask=$(umask) || exit 1; \
         cleanup() {{ rm -f -- \"$tmp\"; }}; trap cleanup EXIT; \
         trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \
         umask 077; status=0; cat > \"$tmp\" || status=$?; \
         if [ \"$status\" -eq 0 ]; then \
           actual=$(wc -c < \"$tmp\") || status=$?; \
           if [ \"$status\" -eq 0 ]; then \
             if [ \"$actual\" -ne \"$expected\" ]; then \
               echo 'Workspace file transfer was incomplete; target was not changed' >&2; status=65; \
             elif [ -e \"$target\" ] && [ ! -f \"$target\" ]; then \
               echo 'Workspace target is not a regular file' >&2; status=1; \
             else \
               umask \"$saved_umask\" || status=$?; \
               if [ \"$status\" -eq 0 ]; then cat -- \"$tmp\" >| \"$target\" || status=$?; fi; \
             fi; \
           fi; \
         fi; cleanup; trap - EXIT; exit \"$status\""
    )
}

async fn drain_workspace_diagnostics<R: AsyncRead + Unpin>(
    mut reader: R,
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut retained = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(retained);
        }
        let keep = count.min(16_384usize.saturating_sub(retained.len()));
        retained.extend_from_slice(&chunk[..keep]);
    }
}

/// Shell prelude that removes pid files whose process is gone.
///
/// Liveness rather than age: a supervised command may legitimately run for
/// hours, and deleting its pid file would silently break cancellation for that
/// session — the pid file is how interrupt/kill finds the process. `kill -0`
/// answers the question exactly, so nothing live is ever touched.
///
/// The empty-file case is the one exception. `supervised_container_command`
/// creates the file before writing the pid into it, so an empty file may belong
/// to a command that is starting right now; those are only removed once they
/// are far too old for that to be true.
fn stale_pid_file_sweep() -> String {
    format!(
        "for stale_pid_file in /tmp/{}-exec-*.pid; do \
       [ -e \"$stale_pid_file\" ] || continue; \
       if [ ! -s \"$stale_pid_file\" ]; then \
         if command -v find >/dev/null 2>&1; then \
           find \"$stale_pid_file\" -mmin +60 -exec rm -f -- {{}} \\; 2>/dev/null || true; \
         fi; \
         continue; \
       fi; \
       stale_pid=$(cat \"$stale_pid_file\" 2>/dev/null || true); \
       case \"$stale_pid\" in \
         ''|*[!0-9]*) rm -f -- \"$stale_pid_file\" 2>/dev/null || true; continue;; \
       esac; \
       kill -0 \"$stale_pid\" 2>/dev/null || rm -f -- \"$stale_pid_file\" 2>/dev/null || true; \
     done; \
     unset stale_pid_file stale_pid 2>/dev/null || true; ",
        hidden_data_directory()
    )
}

fn supervised_container_command(
    container: &ContainerWorkspaceConfig,
    command: &str,
) -> (String, String) {
    supervised_workspace_command(&container.shell, command)
}

fn supervised_workspace_command(shell: &str, command: &str) -> (String, String) {
    let pid_file = format!(
        "/tmp/{}-exec-{}.pid",
        hidden_data_directory(),
        uuid::Uuid::new_v4()
    );
    let wrapped = supervised_workspace_command_with_pid_file(shell, command, &pid_file);
    (wrapped, pid_file)
}

/// Wrap `command` so it can be tracked and signalled from a separate channel.
///
/// `setsid` gives the command its own process group, which is what makes the
/// `kill -- -$pid` group signal reach the whole tree. Where it is missing the
/// child stays in this shell's group, so a group signal would either fail or
/// hit the supervisor itself; both `terminate_child` here and
/// [`container_signal_command`] therefore fall back to `pkill -P` plus a direct
/// `kill`, which reaches one generation instead of all of them.
///
/// The supervisor must also duplicate stdin before starting the asynchronous
/// child. POSIX non-interactive shells attach `/dev/null` to an asynchronous
/// list's fd 0, so `<&0` inside that list cannot preserve streamed input.
#[cfg(test)]
fn supervised_container_command_with_pid_file(
    container: &ContainerWorkspaceConfig,
    command: &str,
    pid_file: &str,
) -> String {
    supervised_workspace_command_with_pid_file(&container.shell, command, pid_file)
}

fn supervised_workspace_command_with_pid_file(
    shell: &str,
    command: &str,
    pid_file: &str,
) -> String {
    let quoted_pid_file = crate::remote_ssh::shell::quote_arg(pid_file);
    let quoted_command = crate::remote_ssh::shell::quote_arg(command);
    let quoted_shell = crate::remote_ssh::shell::quote_arg(shell);
    let sweep = stale_pid_file_sweep();
    format!(
        "{sweep}\
         pid_file={quoted_pid_file}; \
         child=; \
         tracking=1; \
         (umask 077; : > \"$pid_file\") 2>/dev/null || tracking=0; \
         remove_pid_file() {{ rm -f -- \"$pid_file\" 2>/dev/null || true; }}; \
         terminate_child() {{ \
           [ -n \"$child\" ] || return 0; \
           if kill -TERM -- \"-$child\" 2>/dev/null; then return 0; fi; \
           if command -v pkill >/dev/null 2>&1; then \
             pkill -TERM -P \"$child\" 2>/dev/null || true; \
           fi; \
           kill -TERM \"$child\" 2>/dev/null || true; \
         }}; \
         trap remove_pid_file EXIT; \
         trap 'terminate_child; exit 143' HUP TERM; \
         exec 9<&0 || exit 1; \
         if command -v setsid >/dev/null 2>&1; then \
           setsid {quoted_shell} -lc {quoted_command} <&9 & \
         else \
           {quoted_shell} -lc {quoted_command} <&9 & \
         fi; \
         child=$!; \
         exec 9<&-; \
         if [ \"$tracking\" -eq 1 ]; then \
           printf '%s' \"$child\" > \"$pid_file\" || tracking=0; \
         fi; \
         wait \"$child\"; status=$?; \
         child=; trap - EXIT HUP TERM; remove_pid_file; exit \"$status\""
    )
}

fn container_signal_command(
    pid_file: &str,
    signal: crate::remote_ssh::WorkspaceProcessSignal,
) -> String {
    let signal_name = match signal {
        crate::remote_ssh::WorkspaceProcessSignal::Interrupt => "INT",
        crate::remote_ssh::WorkspaceProcessSignal::Kill => "KILL",
    };
    let quoted_pid_file = crate::remote_ssh::shell::quote_arg(pid_file);
    format!(
        "pid_file={quoted_pid_file}; \
         attempt=0; \
         while [ ! -s \"$pid_file\" ] && [ \"$attempt\" -lt 20 ]; do \
           attempt=$((attempt + 1)); sleep 0.05; \
         done; \
         [ -s \"$pid_file\" ] || exit 75; \
         pid=$(cat \"$pid_file\" 2>/dev/null) || exit 75; \
         case \"$pid\" in ''|*[!0-9]*) exit 75;; esac; \
         if kill -{signal_name} -- \"-$pid\" 2>/dev/null; then :; else \
           if command -v pkill >/dev/null 2>&1; then \
             pkill -{signal_name} -P \"$pid\" 2>/dev/null || true; \
           fi; \
           kill -{signal_name} \"$pid\" 2>/dev/null || true; \
         fi"
    )
}

fn local_container_signal_hook(
    container: ContainerWorkspaceConfig,
    pid_file: String,
) -> crate::remote_ssh::transport::WorkspaceSignalHook {
    Arc::new(move |signal| {
        let container = container.clone();
        let pid_file = pid_file.clone();
        Box::pin(async move {
            let command = container_signal_command(&pid_file, signal);
            let output = tokio::time::timeout(
                Duration::from_secs(3),
                process_manager::create_tokio_command(&container.docker_path)
                    .args(docker_exec_args(&container, &command, false))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output(),
            )
            .await
            .map_err(|_| anyhow!("Timed out signalling the Docker container process"))?
            .with_context(|| {
                format!(
                    "Failed to start Docker executable '{}' for process control",
                    container.docker_path
                )
            })?;
            if !output.status.success() {
                anyhow::bail!(
                    "Docker container process control failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            Ok(())
        })
    })
}

fn remote_container_signal_hook(
    handle: Arc<Handle<SSHHandler>>,
    container: ContainerWorkspaceConfig,
    pid_file: String,
) -> crate::remote_ssh::transport::WorkspaceSignalHook {
    Arc::new(move |signal| {
        let handle = handle.clone();
        let container = container.clone();
        let pid_file = pid_file.clone();
        Box::pin(async move {
            let signal_command = container_signal_command(&pid_file, signal);
            let host_command = docker_exec_host_command(&container, &signal_command, false);
            let result = SSHConnectionManager::execute_command_internal(
                &handle,
                &host_command,
                SSHCommandOptions {
                    timeout_ms: Some(3_000),
                    cancellation_token: None,
                },
            )
            .await?;
            if result.exit_code != 0 {
                anyhow::bail!(
                    "Remote Docker container process control failed: {}",
                    result.stderr.trim()
                );
            }
            Ok(())
        })
    })
}

async fn collect_workspace_command_result(
    transport: crate::remote_ssh::WorkspaceStdio,
    options: SSHCommandOptions,
) -> anyhow::Result<SshCommandOutput> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut stdin, mut stdout, mut stderr, control, completion) = transport.into_parts();
    let _ = stdin.shutdown().await;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut completion_task = tokio::spawn(completion.wait());

    let cancellation = options.cancellation_token.clone();
    let cancelled = async move {
        match cancellation {
            Some(token) => token.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(cancelled);
    let timeout = async move {
        match options.timeout_ms {
            Some(timeout_ms) => tokio::time::sleep(Duration::from_millis(timeout_ms)).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(timeout);

    let mut interrupted = false;
    let mut timed_out = false;
    let mut fallback_exit_code = -1;
    let exit = tokio::select! {
        result = &mut completion_task => result.ok(),
        _ = &mut cancelled => {
            interrupted = true;
            fallback_exit_code = 130;
            let _ = control.interrupt().await;
            match tokio::time::timeout(SSH_COMMAND_INTERRUPT_DRAIN_GRACE, &mut completion_task).await {
                Ok(result) => result.ok(),
                Err(_) => {
                    let _ = control.kill().await;
                    match tokio::time::timeout(Duration::from_secs(3), &mut completion_task).await {
                        Ok(result) => result.ok(),
                        Err(_) => {
                            completion_task.abort();
                            None
                        }
                    }
                }
            }
        }
        _ = &mut timeout => {
            timed_out = true;
            fallback_exit_code = 124;
            let _ = control.interrupt().await;
            match tokio::time::timeout(SSH_COMMAND_INTERRUPT_DRAIN_GRACE, &mut completion_task).await {
                Ok(result) => result.ok(),
                Err(_) => {
                    let _ = control.kill().await;
                    match tokio::time::timeout(Duration::from_secs(3), &mut completion_task).await {
                        Ok(result) => result.ok(),
                        Err(_) => {
                            completion_task.abort();
                            None
                        }
                    }
                }
            }
        }
    };
    let stdout = collect_workspace_reader(
        stdout_task,
        "Workspace command stdout reader task failed",
        interrupted || timed_out,
    )
    .await?;
    let stderr = collect_workspace_reader(
        stderr_task,
        "Workspace command stderr reader task failed",
        interrupted || timed_out,
    )
    .await?;
    let exit_status = exit.and_then(|exit| exit.exit_code);
    Ok(SshCommandOutput {
        result: SSHCommandResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_status.unwrap_or(fallback_exit_code),
            interrupted,
            timed_out,
        },
        exit_status_received: exit_status.is_some(),
    })
}

async fn collect_workspace_reader(
    mut task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    task_error: &'static str,
    allow_incomplete: bool,
) -> anyhow::Result<Vec<u8>> {
    match tokio::time::timeout(Duration::from_secs(3), &mut task).await {
        Ok(result) => Ok(result.context(task_error)??),
        Err(_) if allow_incomplete => {
            task.abort();
            Ok(Vec::new())
        }
        Err(_) => {
            task.abort();
            anyhow::bail!("Workspace command output stream did not close")
        }
    }
}

type ContainerEntryFields = (
    String,
    String,
    String,
    Option<u64>,
    Option<u64>,
    Option<String>,
);

fn split_container_entry_fields<'a>(
    mut fields: impl Iterator<Item = &'a str>,
) -> anyhow::Result<ContainerEntryFields> {
    let name = fields.next().unwrap_or_default().to_string();
    let path = fields.next().unwrap_or_default().to_string();
    let kind = fields.next().unwrap_or_default().to_string();
    let size = fields
        .next()
        .filter(|value| !value.is_empty())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let modified = fields
        .next()
        .filter(|value| !value.is_empty())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1000));
    let permissions = fields
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| value.trim().to_string());
    if name.is_empty() || path.is_empty() || !matches!(kind.as_str(), "d" | "f" | "l" | "o") {
        anyhow::bail!("Container directory listing returned a malformed entry");
    }
    Ok((name, path, kind, size, modified, permissions))
}

fn parse_container_exists_output(path: &str, stderr: &str, status: i32) -> anyhow::Result<bool> {
    match status {
        0 => Ok(true),
        1 if stderr.trim().is_empty() => Ok(false),
        _ => anyhow::bail!(
            "Failed to check whether container path '{}' exists: command exited with status {}{}",
            path,
            status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        ),
    }
}

fn parse_container_dir_output(
    output: &str,
) -> anyhow::Result<Vec<crate::remote_ssh::types::RemoteDirEntry>> {
    let mut fields = output.split('\0').collect::<Vec<_>>();
    while fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.len() % 6 != 0 {
        anyhow::bail!("Container directory listing returned a malformed record");
    }
    fields
        .chunks(6)
        .map(|record| {
            let fields = split_container_entry_fields(record.iter().copied())?;
            Ok(crate::remote_ssh::types::RemoteDirEntry {
                name: fields.0,
                path: fields.1,
                is_dir: fields.2 == "d",
                is_file: fields.2 == "f",
                is_symlink: fields.2 == "l",
                size: fields.3,
                modified: fields.4,
                permissions: fields.5,
            })
        })
        .collect()
}

fn parse_container_file_output(
    output: &str,
) -> anyhow::Result<Option<crate::remote_ssh::types::RemoteFileEntry>> {
    let mut fields = output.split('\0').collect::<Vec<_>>();
    while fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.is_empty() {
        return Ok(None);
    }
    if fields.len() != 6 {
        anyhow::bail!("Container stat returned a malformed record");
    }
    let fields = split_container_entry_fields(fields.into_iter())?;
    Ok(Some(crate::remote_ssh::types::RemoteFileEntry {
        name: fields.0,
        path: fields.1,
        is_dir: fields.2 == "d",
        is_file: fields.2 == "f",
        is_symlink: fields.2 == "l",
        size: fields.3,
        modified: fields.4,
        permissions: fields.5,
    }))
}

fn parse_workspace_stat_output(
    output: &str,
) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceMetadata> {
    use openbitfun_runtime_ports::{WorkspaceMetadata, WorkspacePathKind};
    let fields = output.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 || !matches!(fields[0], "hex" | "oct") {
        anyhow::bail!("Container stat returned malformed workspace metadata");
    }
    let mode = u32::from_str_radix(fields[1], if fields[0] == "hex" { 16 } else { 8 })?;
    let size = fields[2].parse::<u64>()?;
    let seconds = fields[3].parse::<i64>()?;
    let permissions = u32::from_str_radix(fields[4], 8)?;
    let elapsed = std::time::Duration::from_secs(seconds.unsigned_abs());
    let modified = if seconds < 0 {
        std::time::UNIX_EPOCH.checked_sub(elapsed)
    } else {
        std::time::UNIX_EPOCH.checked_add(elapsed)
    }
    .ok_or_else(|| anyhow!("Container modification time is out of range"))?;
    let kind = match mode & 0o170000 {
        0o100000 => WorkspacePathKind::File,
        0o040000 => WorkspacePathKind::Directory,
        0o120000 => WorkspacePathKind::Symlink,
        _ => WorkspacePathKind::Other,
    };
    Ok(WorkspaceMetadata {
        kind,
        size: Some(size),
        modified: Some(modified),
        permissions: Some(permissions),
    })
}

/// SSH Connection Manager
#[derive(Clone)]
pub struct SSHConnectionManager {
    connections: Arc<tokio::sync::RwLock<HashMap<String, ActiveConnection>>>,
    /// Reconnect serialization, keyed by connection id and deliberately held
    /// *outside* `ActiveConnection`. Reconnect replaces the map entry wholesale,
    /// so a lock stored inside it would be orphaned mid-flight: waiters would
    /// hold a mutex nobody else takes and re-run the reconnect they were queued
    /// behind.
    reconnect_locks: Arc<tokio::sync::RwLock<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    saved_connections: Arc<tokio::sync::RwLock<Vec<SavedConnection>>>,
    config_path: std::path::PathBuf,
    /// Known hosts storage
    known_hosts: Arc<tokio::sync::RwLock<HashMap<String, KnownHostEntry>>>,
    known_hosts_path: std::path::PathBuf,
    /// Remote workspace persistence (multiple workspaces)
    remote_workspaces: Arc<tokio::sync::RwLock<Vec<crate::remote_ssh::types::RemoteWorkspace>>>,
    remote_workspace_path: std::path::PathBuf,
    password_vault: std::sync::Arc<SSHPasswordVault>,
}

impl SSHConnectionManager {
    /// Create a new SSH connection manager
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        let config_path = data_dir.join("ssh_connections.json");
        let known_hosts_path = data_dir.join("known_hosts");
        let remote_workspace_path = data_dir.join("remote_workspace.json");
        let password_vault = std::sync::Arc::new(SSHPasswordVault::new(data_dir));
        Self {
            connections: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            reconnect_locks: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            saved_connections: Arc::new(tokio::sync::RwLock::new(Vec::new())),
            config_path,
            known_hosts: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            known_hosts_path,
            remote_workspaces: Arc::new(tokio::sync::RwLock::new(Vec::new())),
            remote_workspace_path,
            password_vault,
        }
    }

    /// Load known hosts from disk
    pub async fn load_known_hosts(&self) -> anyhow::Result<()> {
        if !self.known_hosts_path.exists() {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&self.known_hosts_path).await?;
        let entries: Vec<KnownHostEntry> =
            serde_json::from_str(&content).context("Failed to parse known hosts")?;

        let mut guard = self.known_hosts.write().await;
        for entry in entries {
            let key = format!("{}:{}", entry.host, entry.port);
            guard.insert(key, entry);
        }

        Ok(())
    }

    /// Save known hosts to disk
    async fn save_known_hosts(&self) -> anyhow::Result<()> {
        let guard = self.known_hosts.read().await;
        let entries: Vec<_> = guard.values().cloned().collect();

        if let Some(parent) = self.known_hosts_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let content = serde_json::to_string_pretty(&entries)?;
        tokio::fs::write(&self.known_hosts_path, content).await?;
        Ok(())
    }

    /// Add a known host
    pub async fn add_known_host(
        &self,
        host: String,
        port: u16,
        key: &PublicKey,
    ) -> anyhow::Result<()> {
        let entry = KnownHostEntry {
            host: host.clone(),
            port,
            key_type: format!("{:?}", key.name()),
            fingerprint: key.fingerprint(),
            public_key: key
                .public_key_bytes()
                .to_vec()
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect(),
        };

        let key = format!("{}:{}", host, port);
        {
            let mut guard = self.known_hosts.write().await;
            guard.insert(key, entry);
        }

        self.save_known_hosts().await
    }

    /// Check if host is in known hosts
    pub async fn is_known_host(&self, host: &str, port: u16) -> bool {
        let key = format!("{}:{}", host, port);
        let guard = self.known_hosts.read().await;
        guard.contains_key(&key)
    }

    /// Get known host entry
    pub async fn get_known_host(&self, host: &str, port: u16) -> Option<KnownHostEntry> {
        let key = format!("{}:{}", host, port);
        let guard = self.known_hosts.read().await;
        guard.get(&key).cloned()
    }

    /// Remove a known host
    pub async fn remove_known_host(&self, host: &str, port: u16) -> anyhow::Result<()> {
        let key = format!("{}:{}", host, port);
        {
            let mut guard = self.known_hosts.write().await;
            guard.remove(&key);
        }
        self.save_known_hosts().await
    }

    /// List all known hosts
    pub async fn list_known_hosts(&self) -> Vec<KnownHostEntry> {
        let guard = self.known_hosts.read().await;
        guard.values().cloned().collect()
    }

    // ── Remote Workspace Persistence ─────────────────────────────────────────────

    /// Load remote workspaces from disk
    pub async fn load_remote_workspace(&self) -> anyhow::Result<()> {
        if !self.remote_workspace_path.exists() {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&self.remote_workspace_path).await?;
        let mut workspaces: Vec<crate::remote_ssh::types::RemoteWorkspace> =
            serde_json::from_str(&content).context("Failed to parse remote workspaces")?;

        let before = workspaces.len();
        workspaces.retain(|w| !w.connection_id.is_empty() && !w.remote_path.is_empty());
        if workspaces.len() < before {
            log::warn!(
                "Dropped {} persisted remote workspace(s) with empty connectionId or remotePath",
                before - workspaces.len()
            );
        }

        let mut guard = self.remote_workspaces.write().await;
        *guard = workspaces;

        Ok(())
    }

    /// Save remote workspaces to disk
    async fn save_remote_workspaces(&self) -> anyhow::Result<()> {
        let guard = self.remote_workspaces.read().await;

        if let Some(parent) = self.remote_workspace_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let content = serde_json::to_string_pretty(&*guard)?;
        tokio::fs::write(&self.remote_workspace_path, content).await?;
        Ok(())
    }

    /// Add/update a persisted remote workspace (key = `connection_id` + `remote_path`).
    pub async fn set_remote_workspace(
        &self,
        mut workspace: crate::remote_ssh::types::RemoteWorkspace,
    ) -> anyhow::Result<()> {
        workspace.remote_path =
            crate::remote_ssh::normalize_remote_workspace_path(&workspace.remote_path);
        {
            let mut guard = self.remote_workspaces.write().await;
            let rp = workspace.remote_path.clone();
            let cid = workspace.connection_id.clone();
            guard.retain(|w| {
                !(w.connection_id == cid
                    && crate::remote_ssh::normalize_remote_workspace_path(&w.remote_path) == rp)
            });
            guard.push(workspace);
        }
        self.save_remote_workspaces().await
    }

    /// Get all persisted remote workspaces
    pub async fn get_remote_workspaces(&self) -> Vec<crate::remote_ssh::types::RemoteWorkspace> {
        self.remote_workspaces.read().await.clone()
    }

    /// Drop persisted remote workspace restore entries whose saved SSH profile is gone.
    pub async fn prune_remote_workspaces_without_saved_connections(
        &self,
    ) -> anyhow::Result<Vec<crate::remote_ssh::types::RemoteWorkspace>> {
        let saved_ids: Vec<String> = self
            .saved_connections
            .read()
            .await
            .iter()
            .map(|c| c.id.clone())
            .collect();

        let removed = {
            let mut guard = self.remote_workspaces.write().await;
            let mut removed = Vec::new();
            guard.retain(|w| {
                let keep = saved_ids.iter().any(|id| id == &w.connection_id);
                if !keep {
                    removed.push(w.clone());
                }
                keep
            });
            removed
        };

        if !removed.is_empty() {
            log::warn!(
                "Removed {} persisted remote workspace(s) without saved SSH connection",
                removed.len()
            );
            self.save_remote_workspaces().await?;
        }

        Ok(removed)
    }

    /// Get first persisted remote workspace (legacy compat)
    pub async fn get_remote_workspace(&self) -> Option<crate::remote_ssh::types::RemoteWorkspace> {
        self.remote_workspaces.read().await.first().cloned()
    }

    /// Remove a specific remote workspace by **connection** + **remote path** (not path alone).
    pub async fn remove_remote_workspace(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> anyhow::Result<()> {
        let rp = crate::remote_ssh::normalize_remote_workspace_path(remote_path);
        {
            let mut guard = self.remote_workspaces.write().await;
            guard.retain(|w| {
                !(w.connection_id == connection_id
                    && crate::remote_ssh::normalize_remote_workspace_path(&w.remote_path) == rp)
            });
        }
        self.save_remote_workspaces().await
    }

    /// Clear all remote workspaces
    pub async fn clear_remote_workspace(&self) -> anyhow::Result<()> {
        {
            let mut guard = self.remote_workspaces.write().await;
            guard.clear();
        }
        if self.remote_workspace_path.exists() {
            tokio::fs::remove_file(&self.remote_workspace_path).await?;
        }
        Ok(())
    }

    /// Look up SSH config for a given host alias or hostname
    ///
    /// This parses ~/.ssh/config to find connection parameters for the given host.
    /// The host parameter can be either an alias defined in SSH config or an actual hostname.
    #[cfg(feature = "ssh_config")]
    pub async fn get_ssh_config(&self, host: &str) -> SSHConfigLookupResult {
        let ssh_config_path = dirs::home_dir()
            .map(|p| p.join(".ssh").join("config"))
            .unwrap_or_default();

        if !ssh_config_path.exists() {
            log::debug!("SSH config not found at {:?}", ssh_config_path);
            return SSHConfigLookupResult {
                found: false,
                config: None,
            };
        }

        let config_content = match tokio::fs::read_to_string(&ssh_config_path).await {
            Ok(c) => strip_utf8_bom(c),
            Err(e) => {
                log::warn!("Failed to read SSH config: {:?}", e);
                return SSHConfigLookupResult {
                    found: false,
                    config: None,
                };
            }
        };

        // Try to parse with the ssh_config crate for pattern-matching query support.
        // If parsing fails, fall back to manual parsing.
        let parsed_config = SSHConfig::parse_str(&config_content).ok();
        if parsed_config.is_none() {
            log::debug!("SSHConfig::parse_str failed, using manual fallback");
        }

        // Try pattern-matched query first (handles Host wildcards like `Host *.example.com`)
        if let Some(ref config) = parsed_config {
            let host_settings = config.query(host);
            if !host_settings.is_empty() {
                log::debug!(
                    "Found SSH config for host: {} with {} settings",
                    host,
                    host_settings.len()
                );

                let hostname = ssh_cfg_get(&host_settings, "HostName").map(|s| s.to_string());
                let user = ssh_cfg_get(&host_settings, "User").map(|s| s.to_string());
                let port = ssh_cfg_get(&host_settings, "Port").and_then(|s| s.parse::<u16>().ok());
                let identity_file = ssh_cfg_get(&host_settings, "IdentityFile")
                    .map(|f| shellexpand::tilde(f).to_string());
                let certificate_file = ssh_cfg_get(&host_settings, "CertificateFile")
                    .map(|f| shellexpand::tilde(f).to_string());
                let has_proxy_command = ssh_cfg_has(&host_settings, "ProxyCommand");
                let proxy_jump = ssh_cfg_get(&host_settings, "ProxyJump").map(ToOwned::to_owned);

                return SSHConfigLookupResult {
                    found: true,
                    config: Some(SSHConfigEntry {
                        host: host.to_string(),
                        hostname,
                        port,
                        user,
                        identity_file,
                        agent: if has_proxy_command { None } else { Some(true) },
                        certificate_file,
                        proxy_jump,
                    }),
                };
            }
        }

        // Fallback: manual lookup for exact host name match
        let hosts = parse_ssh_config_manually(&config_content);
        if let Some(entry) = hosts.into_iter().find(|e| e.host == host) {
            log::debug!("Found SSH config for host: {} (manual fallback)", host);
            return SSHConfigLookupResult {
                found: true,
                config: Some(entry),
            };
        }

        log::debug!("No SSH config found for host: {}", host);
        SSHConfigLookupResult {
            found: false,
            config: None,
        }
    }

    #[cfg(not(feature = "ssh_config"))]
    pub async fn get_ssh_config(&self, _host: &str) -> SSHConfigLookupResult {
        SSHConfigLookupResult {
            found: false,
            config: None,
        }
    }

    /// List all hosts defined in ~/.ssh/config
    #[cfg(feature = "ssh_config")]
    pub async fn list_ssh_config_hosts(&self) -> Vec<SSHConfigEntry> {
        let ssh_config_path = dirs::home_dir()
            .map(|p| p.join(".ssh").join("config"))
            .unwrap_or_default();

        if !ssh_config_path.exists() {
            log::debug!("SSH config not found at {:?}", ssh_config_path);
            return Vec::new();
        }

        let config_content = match tokio::fs::read_to_string(&ssh_config_path).await {
            Ok(c) => strip_utf8_bom(c),
            Err(e) => {
                log::warn!("Failed to read SSH config: {:?}", e);
                return Vec::new();
            }
        };

        // Try to parse with the ssh_config crate for pattern-matching query support.
        // If parsing fails (e.g. `Include`/`Match` directives before the first `Host`
        // block cause ssh_config 0.1 to return InvalidHostEntry), fall back to manual
        // line-by-line parsing.
        let parsed_config = SSHConfig::parse_str(&config_content).ok();
        if parsed_config.is_none() {
            log::debug!("SSHConfig::parse_str failed, using manual fallback");
        }

        // Always do manual parsing to get the host list (SSHConfig doesn't expose all hosts).
        let mut hosts = parse_ssh_config_manually(&config_content);

        // When the ssh_config crate parsed successfully, override with pattern-matched
        // details (e.g. settings from `Host *` blocks that apply to all hosts).
        if let Some(ref config) = parsed_config {
            for entry in &mut hosts {
                let settings = config.query(&entry.host);
                if !settings.is_empty() {
                    if let Some(h) = ssh_cfg_get(&settings, "HostName") {
                        entry.hostname = Some(h.to_string());
                    }
                    if let Some(p) =
                        ssh_cfg_get(&settings, "Port").and_then(|s| s.parse::<u16>().ok())
                    {
                        entry.port = Some(p);
                    }
                    if let Some(u) = ssh_cfg_get(&settings, "User") {
                        entry.user = Some(u.to_string());
                    }
                    if let Some(f) = ssh_cfg_get(&settings, "IdentityFile") {
                        entry.identity_file = Some(shellexpand::tilde(f).to_string());
                    }
                    if let Some(f) = ssh_cfg_get(&settings, "CertificateFile") {
                        entry.certificate_file = Some(shellexpand::tilde(f).to_string());
                    }
                    if let Some(proxy_jump) = ssh_cfg_get(&settings, "ProxyJump") {
                        entry.proxy_jump = Some(proxy_jump.to_string());
                    }
                }
            }
        }

        log::debug!("Found {} hosts in SSH config", hosts.len());
        hosts
    }

    #[cfg(not(feature = "ssh_config"))]
    pub async fn list_ssh_config_hosts(&self) -> Vec<SSHConfigEntry> {
        Vec::new()
    }

    /// List containers on the Docker host described by a connection form.
    ///
    /// Remote targets establish a temporary SSH/jump-chain session without
    /// saving or activating it. Local targets invoke the configured Docker CLI
    /// directly.
    pub async fn list_docker_containers_for_config(
        &self,
        config: &SSHConnectionConfig,
    ) -> anyhow::Result<Vec<DockerContainerInfo>> {
        let container = config
            .container
            .as_ref()
            .ok_or_else(|| anyhow!("Container configuration is required"))?;
        let format = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}";
        let output = if container.local {
            tokio::time::timeout(
                Duration::from_secs(config.options.connect_timeout_secs.max(1)),
                process_manager::create_tokio_command(&container.docker_path)
                    .args(["ps", "-a", "--format", format])
                    .output(),
            )
            .await
            .map_err(|_| anyhow!("Local Docker container listing timed out"))?
            .with_context(|| {
                format!(
                    "Failed to start local Docker executable '{}'",
                    container.docker_path
                )
            })?
        } else {
            let mut host_config = config.clone();
            host_config.container = None;
            let established = self
                .establish_session_with_retries(
                    &host_config,
                    host_config.options.connect_timeout_secs.max(1),
                )
                .await
                .context("Could not connect to the Docker host")?;
            // This session is never published to the connections map, so nothing
            // else will ever close it: every exit below has to run through the
            // shutdown, or listing containers leaks one server-side session per
            // hop each time the connection dialog refreshes.
            let outcome = match established.handle.as_ref() {
                Some(handle) => {
                    let command = format!(
                        "{} ps -a --format {}",
                        crate::remote_ssh::shell::quote_arg(&container.docker_path),
                        crate::remote_ssh::shell::quote_arg(format)
                    );
                    Self::execute_command_internal(
                        handle,
                        &command,
                        SSHCommandOptions {
                            timeout_ms: Some(config.options.connect_timeout_secs.max(1) * 1000),
                            cancellation_token: None,
                        },
                    )
                    .await
                }
                None => Err(anyhow!("Docker host SSH handle is unavailable")),
            };
            Self::shutdown_established_session(established).await;

            let result = outcome?;
            if result.exit_code != 0 {
                anyhow::bail!(
                    "Docker container listing failed on SSH host: {}",
                    result.stderr.trim()
                );
            }
            return parse_docker_container_list(&result.stdout);
        };
        if !output.status.success() {
            anyhow::bail!(
                "Docker container listing failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        parse_docker_container_list(&String::from_utf8_lossy(&output.stdout))
    }

    /// Test a connection without saving it and return a stable staged report
    /// suitable for the connection dialog.
    pub async fn test_connection(&self, config: &SSHConnectionConfig) -> ConnectionTestReport {
        let mut stages = Vec::new();
        if let Some(wsl) = &config.wsl {
            stages.push(ConnectionTestStage {
                id: "wsl".into(),
                label: wsl.distribution.clone(),
                success: false,
                error: None,
            });
        } else if config.uses_local_docker() {
            stages.push(ConnectionTestStage {
                id: "docker-host".to_string(),
                label: "local".to_string(),
                success: false,
                error: None,
            });
        } else {
            match self.resolve_proxy_jump_chain(config).await {
                Ok(jumps) => {
                    for (index, jump) in jumps.iter().enumerate() {
                        stages.push(ConnectionTestStage {
                            id: format!("jump-{}", index + 1),
                            label: connection_label(jump),
                            success: false,
                            error: None,
                        });
                    }
                }
                Err(error) => {
                    return ConnectionTestReport {
                        success: false,
                        stages: vec![ConnectionTestStage {
                            id: "configuration".to_string(),
                            label: "ProxyJump".to_string(),
                            success: false,
                            error: Some(error.to_string()),
                        }],
                        server_info: None,
                        resolved_container_access: None,
                    };
                }
            }
            stages.push(ConnectionTestStage {
                id: "target".to_string(),
                label: connection_label(config),
                success: false,
                error: None,
            });
        }
        if let Some(container) = config.container.as_ref() {
            if !matches!(container.access, ContainerAccess::Sshd) || container.local {
                stages.push(ConnectionTestStage {
                    id: "container".to_string(),
                    label: container.name.clone(),
                    success: false,
                    error: None,
                });
            }
        }

        match self
            .establish_session_with_retries(config, config.options.connect_timeout_secs.max(1))
            .await
        {
            Ok(established) => {
                for stage in &mut stages {
                    stage.success = true;
                }
                let server_info = established.server_info.clone();
                let resolved_container_access = established
                    .effective_config
                    .container
                    .as_ref()
                    .map(|container| container.access.clone());
                // A test connection is never registered, so this is the only
                // place that can close it. Without this the dialog's "Test"
                // button leaks one server-side session per hop, per click.
                Self::shutdown_established_session(established).await;
                ConnectionTestReport {
                    success: true,
                    stages,
                    server_info,
                    resolved_container_access,
                }
            }
            Err(error) => {
                let error_text = error.to_string();
                let reported_stage = failed_stage_of(&error);
                let failing_index = stages
                    .iter()
                    .position(|stage| match reported_stage {
                        // The chain marker is authoritative: it survives two hops
                        // sharing a label, which text matching does not.
                        Some(reported) => stage.id == reported,
                        None => {
                            (stage.id.starts_with("jump-") && error_text.contains(&stage.label))
                                || (stage.id == "container"
                                    && (error_text
                                        .to_ascii_lowercase()
                                        .contains("docker container")
                                        || error_text
                                            .to_ascii_lowercase()
                                            .contains("container sshd")))
                                || (stage.id == "docker-host"
                                    && error_text.to_ascii_lowercase().contains("docker")
                                    && !error_text.to_ascii_lowercase().contains("container"))
                        }
                    })
                    .unwrap_or_else(|| stages.len().saturating_sub(1));
                for stage in stages.iter_mut().take(failing_index) {
                    stage.success = true;
                }
                if let Some(stage) = stages.get_mut(failing_index) {
                    stage.error = Some(error_text);
                }
                ConnectionTestReport {
                    success: false,
                    stages,
                    server_info: None,
                    resolved_container_access: None,
                }
            }
        }
    }

    /// Load saved connections from disk
    pub async fn load_saved_connections(&self) -> anyhow::Result<()> {
        log::info!(
            "load_saved_connections: config_path={:?}, exists={}",
            self.config_path,
            self.config_path.exists()
        );

        if !self.config_path.exists() {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&self.config_path).await?;
        log::info!("load_saved_connections: content={}", content);
        let saved: Vec<SavedConnection> =
            serde_json::from_str(&content).context("Failed to parse saved SSH connections")?;

        let mut guard = self.saved_connections.write().await;
        *guard = saved;
        drop(guard);

        let unavailable = self.saved_connections_without_credentials().await;
        if !unavailable.is_empty() {
            log::warn!(
                "Retained {} saved SSH connection(s) that require credential re-entry",
                unavailable.len()
            );
        }

        let guard = self.saved_connections.read().await;
        log::info!("load_saved_connections: loaded {} connections", guard.len());
        Ok(())
    }

    /// Save connections to disk
    async fn save_connections(&self) -> anyhow::Result<()> {
        log::info!("save_connections: saving to {:?}", self.config_path);
        let guard = self.saved_connections.read().await;
        let content = serde_json::to_string_pretty(&*guard)?;
        log::info!("save_connections: content={}", content);

        // Ensure parent directory exists
        if let Some(parent) = self.config_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(&self.config_path, content).await?;
        log::info!(
            "save_connections: saved {} connections to {:?}",
            guard.len(),
            self.config_path
        );
        Ok(())
    }

    /// Get list of saved connections
    pub async fn get_saved_connections(&self) -> Vec<SavedConnection> {
        self.saved_connections.read().await.clone()
    }

    /// Return password profiles that need the user to re-enter credentials.
    ///
    /// Profile and workspace metadata are deliberately retained: an unavailable
    /// vault entry can be caused by an upgrade, keychain reset, or temporary
    /// decryption failure and must never turn startup recovery into data loss.
    async fn saved_connections_without_credentials(&self) -> Vec<String> {
        let saved_snapshot = self.saved_connections.read().await.clone();
        let mut unavailable_ids = Vec::new();
        for conn in saved_snapshot {
            if !matches!(
                conn.auth_type,
                crate::remote_ssh::types::SavedAuthType::Password
            ) || conn.wsl.is_some()
                || conn
                    .container
                    .as_ref()
                    .is_some_and(|container| container.local)
            {
                continue;
            }
            match self.password_vault.load(&conn.id).await {
                Ok(Some(_)) => {}
                Ok(None) => unavailable_ids.push(conn.id),
                Err(e) => {
                    log::warn!(
                        "Saved SSH password is unavailable; retaining profile for credential re-entry: id={}, error={}",
                        conn.id,
                        e
                    );
                    unavailable_ids.push(conn.id);
                }
            }
        }
        unavailable_ids
    }

    /// SSH `host` field from the saved profile with this `connection_id` (works when not connected).
    /// Used to resolve session mirror paths when workspace metadata omitted `sshHost`.
    pub async fn get_saved_host_for_connection_id(&self, connection_id: &str) -> Option<String> {
        let cid = connection_id.trim();
        if cid.is_empty() {
            return None;
        }
        let guard = self.saved_connections.read().await;
        guard
            .iter()
            .find(|c| c.id == cid)
            .map(|c| c.host.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Save a connection configuration
    pub async fn save_connection(&self, config: &SSHConnectionConfig) -> anyhow::Result<()> {
        match (&config.auth, config.uses_local_process()) {
            (_, true) => {
                self.password_vault.remove(&config.id).await?;
            }
            (SSHAuthMethod::Password { password }, false) => {
                if password.is_empty() && self.password_vault.load(&config.id).await?.is_none() {
                    anyhow::bail!(
                        "Cannot save password SSH connection without a password or stored vault entry"
                    );
                }
                if !password.is_empty() {
                    self.password_vault
                        .store(&config.id, password)
                        .await
                        .with_context(|| format!("store ssh password vault for {}", config.id))?;
                }
            }
            (SSHAuthMethod::PrivateKey { .. }, false) => {
                self.password_vault.remove(&config.id).await?;
            }
            (SSHAuthMethod::Agent { .. } | SSHAuthMethod::KeyboardInteractive { .. }, false) => {
                self.password_vault.remove(&config.id).await?;
            }
        }

        let mut guard = self.saved_connections.write().await;

        // Remove existing entry with same id OR same host+username (dedup).
        // Using host+username (without port) so that changing the port replaces
        // the old entry instead of creating a duplicate.
        guard.retain(|c| {
            c.id != config.id
                && !(c.host == config.host
                    && c.username == config.username
                    && c.container == config.container
                    && c.wsl == config.wsl)
        });

        // Add new entry
        guard.push(SavedConnection {
            id: config.id.clone(),
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            auth_type: match &config.auth {
                SSHAuthMethod::Password { .. } => crate::remote_ssh::types::SavedAuthType::Password,
                SSHAuthMethod::PrivateKey {
                    key_path,
                    certificate_path,
                    ..
                } => crate::remote_ssh::types::SavedAuthType::PrivateKey {
                    key_path: key_path.clone(),
                    certificate_path: certificate_path.clone(),
                },
                SSHAuthMethod::Agent {
                    key_fingerprint,
                    fallback_key_path,
                } => crate::remote_ssh::types::SavedAuthType::Agent {
                    key_fingerprint: key_fingerprint.clone(),
                    fallback_key_path: fallback_key_path.clone(),
                },
                SSHAuthMethod::KeyboardInteractive { .. } => {
                    crate::remote_ssh::types::SavedAuthType::KeyboardInteractive
                }
            },
            default_workspace: config.default_workspace.clone(),
            last_connected: Some(chrono::Utc::now().timestamp() as u64),
            proxy_jump: config.proxy_jump.clone(),
            container: config.container.clone(),
            wsl: config.wsl.clone(),
            options: config.options.clone(),
        });

        drop(guard);

        self.save_connections().await
    }

    /// Decrypt stored password for password-based saved connections (auto-reconnect).
    pub async fn load_stored_password(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Option<String>> {
        self.password_vault.load(connection_id).await
    }

    /// Whether the vault has a stored password for this connection (skip auto-reconnect when false).
    pub async fn has_stored_password(&self, connection_id: &str) -> bool {
        match self.load_stored_password(connection_id).await {
            Ok(opt) => opt.is_some(),
            Err(e) => {
                log::warn!("has_stored_password failed for {}: {}", connection_id, e);
                false
            }
        }
    }

    /// Delete a saved connection
    pub async fn delete_saved_connection(&self, connection_id: &str) -> anyhow::Result<()> {
        let mut guard = self.saved_connections.write().await;
        guard.retain(|c| c.id != connection_id);
        drop(guard);
        self.password_vault.remove(connection_id).await?;
        self.remove_remote_workspaces_for_connections(&[connection_id.to_string()])
            .await?;
        self.save_connections().await
    }

    async fn remove_remote_workspaces_for_connections(
        &self,
        connection_ids: &[String],
    ) -> anyhow::Result<()> {
        if connection_ids.is_empty() {
            return Ok(());
        }
        let removed = {
            let mut guard = self.remote_workspaces.write().await;
            let before = guard.len();
            guard.retain(|w| !connection_ids.iter().any(|id| id == &w.connection_id));
            before - guard.len()
        };
        if removed > 0 {
            log::warn!(
                "Removed {} persisted remote workspace(s) for unavailable SSH connection(s)",
                removed
            );
            self.save_remote_workspaces().await?;
        }
        Ok(())
    }

    /// Connect to a remote SSH server
    ///
    /// # Arguments
    /// * `config` - SSH connection configuration
    /// * `timeout_secs` - Connection timeout in seconds (default: 30)
    pub async fn connect(
        &self,
        config: SSHConnectionConfig,
    ) -> anyhow::Result<SSHConnectionResult> {
        let timeout_secs = config.options.connect_timeout_secs.max(1);
        self.connect_with_timeout(config, timeout_secs).await
    }

    /// Connect with custom timeout
    pub async fn connect_with_timeout(
        &self,
        config: SSHConnectionConfig,
        timeout_secs: u64,
    ) -> anyhow::Result<SSHConnectionResult> {
        // Explicit connects and transparent reconnects share the same
        // connection id. Serialize them so concurrent workspace restoration
        // cannot publish several sessions under one id and disconnect each
        // previous winner as the next attempt completes.
        let connection_lock = self.reconnect_lock_for(&config.id).await;
        let _connection_guard = connection_lock.lock().await;

        // Startup may restore several workspaces that share one saved SSH
        // profile. Once the first caller has restored a matching live
        // connection, later callers only need to open their workspace paths.
        if let Some(existing_result) = {
            let guard = self.connections.read().await;
            guard.get(&config.id).and_then(|connection| {
                (connection.alive.load(Ordering::SeqCst)
                    && config.connection_params_equal(&connection.config))
                .then(|| SSHConnectionResult {
                    success: true,
                    connection_id: Some(config.id.clone()),
                    error: None,
                    server_info: connection.server_info.clone(),
                })
            })
        } {
            return Ok(existing_result);
        }

        let mut established = self
            .establish_session_with_retries(&config, timeout_secs)
            .await?;

        let connection_id = config.id.clone();
        let server_info = established.server_info.clone();

        let replaced = {
            let mut guard = self.connections.write().await;
            // No await separates disarming from publishing the shared owner.
            established.unpublished.disarm();
            guard.insert(
                connection_id.clone(),
                ActiveConnection {
                    handle: established.handle,
                    jump_handles: established.jump_handles,
                    config,
                    effective_config: established.effective_config,
                    server_info: server_info.clone(),
                    sftp_session: Arc::new(SftpCache::new()),
                    bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                    server_key: None,
                    alive: established.alive,
                },
            )
        };
        // Reconnecting under an id that is still live would otherwise strand the
        // previous session (plus one per jump host) on the server.
        if let Some(previous) = replaced {
            Self::shutdown_active_connection(previous).await;
        }

        Ok(SSHConnectionResult {
            success: true,
            connection_id: Some(connection_id),
            error: None,
            server_info,
        })
    }

    /// Build the effective connection: local Docker, direct SSH, or an SSH
    /// session carried over one or more direct-tcpip jump channels.
    async fn establish_session(
        &self,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
    ) -> anyhow::Result<EstablishedSession> {
        if let Some(wsl) = &config.wsl {
            if config.container.is_some()
                || config
                    .proxy_jump
                    .as_deref()
                    .is_some_and(|jump| !jump.trim().is_empty())
            {
                anyhow::bail!("WSL cannot be combined with Docker or SSH jump hosts");
            }
            let server_info = super::wsl::probe(wsl, Duration::from_secs(timeout_secs)).await?;
            return Ok(EstablishedSession {
                handle: None,
                jump_handles: Vec::new(),
                alive: Arc::new(AtomicBool::new(true)),
                server_info: Some(server_info),
                effective_config: config.clone(),
                unpublished: UnpublishedSshSession::default(),
            });
        }
        if config.uses_local_docker() {
            if config
                .container
                .as_ref()
                .is_some_and(|container| matches!(container.access, ContainerAccess::Auto))
            {
                if let Some(session) = self
                    .try_establish_local_container_sshd(config, timeout_secs)
                    .await
                {
                    return Ok(session);
                }
            }
            // Left untagged on purpose: this one call can fail as either stage
            // (missing `docker` binary vs. a container that will not start), and
            // the message-based fallback in `test_connection` already tells them
            // apart. A blanket marker would make it always report "container".
            let server_info = self.probe_local_container(config, timeout_secs).await?;
            return Ok(EstablishedSession {
                handle: None,
                jump_handles: Vec::new(),
                alive: Arc::new(AtomicBool::new(true)),
                server_info: Some(server_info),
                effective_config: resolved_container_config(config, ContainerAccess::DockerExec),
                unpublished: UnpublishedSshSession::default(),
            });
        }

        let mut unpublished = UnpublishedSshSession::default();
        let jumps = self
            .resolve_proxy_jump_chain(config)
            .await
            .map_err(|error| tag_failed_stage("configuration", error))?;
        if jumps.is_empty() {
            let (handle, alive, mut server_info) = self
                .establish_direct_session(config, timeout_secs, &mut unpublished)
                .await
                .map_err(|error| tag_failed_stage("target", error))?;
            if config
                .container
                .as_ref()
                .is_some_and(|container| matches!(container.access, ContainerAccess::Auto))
            {
                if let Some((container_handle, container_alive, container_info, effective_config)) =
                    self.try_establish_remote_container_sshd(
                        &handle,
                        config,
                        timeout_secs,
                        &mut unpublished,
                    )
                    .await
                {
                    return Ok(EstablishedSession {
                        handle: Some(container_handle),
                        jump_handles: vec![handle],
                        alive: container_alive,
                        server_info: container_info,
                        effective_config,
                        unpublished,
                    });
                }
            }
            if config.uses_docker_exec() {
                server_info = self
                    .probe_remote_container(&handle, config, timeout_secs)
                    .await
                    .map(Some)
                    .map_err(|error| tag_failed_stage("container", error))?;
            }
            return Ok(EstablishedSession {
                handle: Some(handle),
                jump_handles: Vec::new(),
                alive,
                server_info,
                effective_config: if config
                    .container
                    .as_ref()
                    .is_some_and(|container| matches!(container.access, ContainerAccess::Auto))
                {
                    resolved_container_config(config, ContainerAccess::DockerExec)
                } else {
                    config.clone()
                },
                unpublished,
            });
        }

        let first = jumps
            .first()
            .expect("non-empty jump chain must have a first hop");
        let (first_handle, _, _) = self
            .establish_direct_session(first, timeout_secs, &mut unpublished)
            .await
            .with_context(|| {
                format!(
                    "Jump 1 ({}) connection or authentication failed",
                    connection_label(first)
                )
            })
            .map_err(|error| tag_failed_stage("jump-1", error))?;
        let mut jump_handles = vec![first_handle];

        for (index, hop) in jumps.iter().enumerate().skip(1) {
            let previous = jump_handles
                .last()
                .expect("jump handle must exist for the preceding hop");
            let channel = previous
                .channel_open_direct_tcpip(&hop.host, hop.port as u32, "127.0.0.1", 0)
                .await
                .with_context(|| {
                    format!(
                        "Jump {} ({}) could not be reached through jump {}",
                        index + 1,
                        connection_label(hop),
                        index
                    )
                })
                .map_err(|error| tag_failed_stage(&format!("jump-{}", index + 1), error))?;
            let (handle, _, _) = self
                .establish_stream_session(
                    hop,
                    channel.into_stream(),
                    timeout_secs,
                    &format!("jump {} ({})", index + 1, connection_label(hop)),
                    &mut unpublished,
                )
                .await
                .with_context(|| {
                    format!(
                        "Jump {} ({}) SSH handshake or authentication failed",
                        index + 1,
                        connection_label(hop)
                    )
                })
                .map_err(|error| tag_failed_stage(&format!("jump-{}", index + 1), error))?;
            jump_handles.push(handle);
        }

        let last_jump = jump_handles
            .last()
            .expect("jump handle must exist for final target");
        let channel = last_jump
            .channel_open_direct_tcpip(&config.host, config.port as u32, "127.0.0.1", 0)
            .await
            .with_context(|| {
                format!(
                    "Final target {} could not be reached through jump {}",
                    connection_label(config),
                    jump_handles.len()
                )
            })
            .map_err(|error| tag_failed_stage("target", error))?;
        let (handle, alive, mut server_info) = self
            .establish_stream_session(
                config,
                channel.into_stream(),
                timeout_secs,
                &format!("final target {}", connection_label(config)),
                &mut unpublished,
            )
            .await
            .with_context(|| {
                format!(
                    "Final target {} SSH handshake or authentication failed",
                    connection_label(config)
                )
            })
            .map_err(|error| tag_failed_stage("target", error))?;
        if config
            .container
            .as_ref()
            .is_some_and(|container| matches!(container.access, ContainerAccess::Auto))
        {
            if let Some((container_handle, container_alive, container_info, effective_config)) =
                self.try_establish_remote_container_sshd(
                    &handle,
                    config,
                    timeout_secs,
                    &mut unpublished,
                )
                .await
            {
                jump_handles.push(handle);
                return Ok(EstablishedSession {
                    handle: Some(container_handle),
                    jump_handles,
                    alive: container_alive,
                    server_info: container_info,
                    effective_config,
                    unpublished,
                });
            }
        }
        if config.uses_docker_exec() {
            server_info = self
                .probe_remote_container(&handle, config, timeout_secs)
                .await
                .map(Some)?;
        }

        Ok(EstablishedSession {
            handle: Some(handle),
            jump_handles,
            alive,
            server_info,
            effective_config: if config
                .container
                .as_ref()
                .is_some_and(|container| matches!(container.access, ContainerAccess::Auto))
            {
                resolved_container_config(config, ContainerAccess::DockerExec)
            } else {
                config.clone()
            },
            unpublished,
        })
    }

    async fn establish_session_with_retries(
        &self,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
    ) -> anyhow::Result<EstablishedSession> {
        let attempts = config.options.connect_attempts.max(1);
        let mut last_error = None;
        for attempt in 1..=attempts {
            match self.establish_session(config, timeout_secs).await {
                Ok(session) => return Ok(session),
                Err(error) if attempt < attempts => {
                    log::warn!(
                        "Workspace connection attempt {}/{} failed for {}: {}",
                        attempt,
                        attempts,
                        connection_label(config),
                        error
                    );
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(
                        250u64.saturating_mul(u64::from(attempt)),
                    ))
                    .await;
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("Workspace connection failed")))
    }

    async fn try_establish_local_container_sshd(
        &self,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
    ) -> Option<EstablishedSession> {
        let container = config.container.as_ref()?;
        let output = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            process_manager::create_tokio_command(&container.docker_path)
                .args(["port", &container.name, "22/tcp"])
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        if !output.status.success() {
            return None;
        }
        let (host, port) =
            parse_docker_published_endpoint(&String::from_utf8_lossy(&output.stdout))?;
        let mut effective_config = resolved_container_config(config, ContainerAccess::Sshd);
        effective_config.host = host.clone();
        effective_config.port = port;
        let mut unpublished = UnpublishedSshSession::default();
        match self
            .establish_direct_session(&effective_config, timeout_secs, &mut unpublished)
            .await
        {
            Ok((handle, alive, server_info)) => {
                log::info!(
                    "Container auto access selected sshd: container={}, endpoint={}:{}",
                    container.name,
                    host,
                    port
                );
                Some(EstablishedSession {
                    handle: Some(handle),
                    jump_handles: Vec::new(),
                    alive,
                    server_info,
                    effective_config,
                    unpublished,
                })
            }
            Err(error) => {
                log::info!(
                    "Container sshd probe failed; falling back to docker exec: container={}, error={}",
                    container.name,
                    error
                );
                None
            }
        }
    }

    async fn try_establish_remote_container_sshd(
        &self,
        docker_host: &Arc<Handle<SSHHandler>>,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
        unpublished: &mut UnpublishedSshSession,
    ) -> Option<(
        Arc<Handle<SSHHandler>>,
        Arc<AtomicBool>,
        Option<ServerInfo>,
        SSHConnectionConfig,
    )> {
        let container = config.container.as_ref()?;
        let command = format!(
            "{} port {} 22/tcp",
            crate::remote_ssh::shell::quote_arg(&container.docker_path),
            crate::remote_ssh::shell::quote_arg(&container.name)
        );
        let result = Self::execute_command_internal(
            docker_host,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(timeout_secs.saturating_mul(1000)),
                cancellation_token: None,
            },
        )
        .await
        .ok()?;
        if result.exit_code != 0 {
            return None;
        }
        let (published_host, port) = parse_docker_published_endpoint(&result.stdout)?;
        let channel = docker_host
            .channel_open_direct_tcpip(&published_host, port as u32, "127.0.0.1", 0)
            .await
            .ok()?;
        let mut effective_config = resolved_container_config(config, ContainerAccess::Sshd);
        effective_config.host = format!("{}#{}", config.host, container.name);
        effective_config.port = port;
        match self
            .establish_stream_session(
                &effective_config,
                channel.into_stream(),
                timeout_secs,
                &format!("container sshd {}:{}", container.name, port),
                unpublished,
            )
            .await
        {
            Ok((handle, alive, server_info)) => {
                log::info!(
                    "Container auto access selected sshd: container={}, endpoint={}:{}",
                    container.name,
                    published_host,
                    port
                );
                Some((handle, alive, server_info, effective_config))
            }
            Err(error) => {
                log::info!(
                    "Container sshd probe failed; falling back to docker exec: container={}, error={}",
                    container.name,
                    error
                );
                None
            }
        }
    }

    async fn resolve_proxy_jump_chain(
        &self,
        config: &SSHConnectionConfig,
    ) -> anyhow::Result<Vec<SSHConnectionConfig>> {
        let Some(proxy_jump) = config
            .proxy_jump
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        else {
            return Ok(Vec::new());
        };

        let mut result = Vec::new();
        for (index, value) in proxy_jump.split(',').map(str::trim).enumerate() {
            if value.is_empty() {
                anyhow::bail!("ProxyJump entry {} is empty", index + 1);
            }
            let (user_override, host_token, port_override) = parse_proxy_jump_token(value)?;
            let lookup = self.get_ssh_config(&host_token).await;
            let entry = lookup.config;
            let host = entry
                .as_ref()
                .and_then(|entry| entry.hostname.clone())
                .unwrap_or_else(|| host_token.clone());
            let username = user_override
                .or_else(|| entry.as_ref().and_then(|entry| entry.user.clone()))
                .or_else(local_username)
                .ok_or_else(|| {
                    anyhow!(
                        "ProxyJump entry '{}' has no user; add user@host or User in ~/.ssh/config",
                        value
                    )
                })?;
            let port = port_override
                .or_else(|| entry.as_ref().and_then(|entry| entry.port))
                .unwrap_or(22);
            let identity_file = entry.as_ref().and_then(|entry| entry.identity_file.clone());
            let auth = if identity_file.is_some() {
                SSHAuthMethod::PrivateKey {
                    key_path: identity_file.expect("identity_file.is_some was checked"),
                    passphrase: None,
                    certificate_path: entry
                        .as_ref()
                        .and_then(|entry| entry.certificate_file.clone()),
                }
            } else if matches!(&config.auth, SSHAuthMethod::KeyboardInteractive { .. }) {
                // Keyboard-interactive answers are one host's challenge/response
                // exchange — an OTP accepted by the bastion is not an OTP for the
                // next hop. Replaying the same vector would fail at hop 2 with an
                // opaque auth error, so say what is actually missing instead.
                anyhow::bail!(
                    "ProxyJump entry '{}' has no IdentityFile in ~/.ssh/config, and \
                     keyboard-interactive responses cannot be reused across hops. \
                     Add an IdentityFile for this jump host (or load its key into the \
                     SSH agent) and try again.",
                    value
                );
            } else if matches!(&config.auth, SSHAuthMethod::Password { .. }) {
                // Falling back to the target's password is the only thing left
                // when a bastion has no key configured, but it does hand that
                // password to every hop — the UI warns about this.
                log::warn!(
                    "ProxyJump entry '{}' has no IdentityFile; reusing the target's password \
                     for this hop. Configure a per-host IdentityFile to avoid sending the \
                     password to the bastion.",
                    value
                );
                config.auth.clone()
            } else {
                SSHAuthMethod::Agent {
                    key_fingerprint: None,
                    fallback_key_path: Some("~/.ssh/id_rsa".to_string()),
                }
            };
            result.push(SSHConnectionConfig {
                id: format!("{}-jump-{}", config.id, index + 1),
                name: value.to_string(),
                host,
                port,
                username,
                auth,
                default_workspace: None,
                proxy_jump: None,
                container: None,
                wsl: None,
                options: config.options.clone(),
            });
        }
        Ok(result)
    }

    async fn establish_stream_session<R>(
        &self,
        config: &SSHConnectionConfig,
        stream: R,
        timeout_secs: u64,
        stage: &str,
        unpublished: &mut UnpublishedSshSession,
    ) -> anyhow::Result<(Arc<Handle<SSHHandler>>, Arc<AtomicBool>, Option<ServerInfo>)>
    where
        R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let ssh_config = build_ssh_client_config();
        let (handler, disconnect_reason, alive) = SSHHandler::with_known_hosts(
            config.host.clone(),
            config.port,
            self.known_hosts.clone(),
        );
        let connect_result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            russh::client::connect_stream(ssh_config, stream, handler),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "{} SSH handshake timed out after {} seconds",
                stage,
                timeout_secs
            )
        })?;
        let mut handle = connect_result.map_err(|error| {
            let real_reason = disconnect_reason
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            match real_reason {
                Some(reason) => anyhow!("{} SSH handshake failed: {}", stage, reason),
                None => anyhow!("{} SSH handshake failed: {:?}", stage, error),
            }
        })?;
        authenticate_handle(&mut handle, config, stage).await?;
        let handle = Arc::new(handle);
        unpublished.track(&handle);
        let mut server_info = Self::get_server_info_internal(&handle, timeout_secs).await;
        if server_info
            .as_ref()
            .map(|info| info.home_dir.trim().is_empty())
            .unwrap_or(true)
        {
            if let Some(home_dir) = Self::probe_remote_home_dir(&handle, timeout_secs).await {
                match server_info.as_mut() {
                    Some(info) => info.home_dir = home_dir,
                    None => {
                        server_info = Some(ServerInfo {
                            os_type: "unknown".to_string(),
                            hostname: "unknown".to_string(),
                            home_dir,
                        });
                    }
                }
            }
        }
        Ok((handle, alive, server_info))
    }

    /// Build a fresh direct SSH session (handshake + auth + server info probe)
    /// without touching the connection map.
    async fn establish_direct_session(
        &self,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
        unpublished: &mut UnpublishedSshSession,
    ) -> anyhow::Result<(Arc<Handle<SSHHandler>>, Arc<AtomicBool>, Option<ServerInfo>)> {
        let addr = format!("{}:{}", config.host, config.port);
        let stream =
            tokio::time::timeout(Duration::from_secs(timeout_secs), TcpStream::connect(&addr))
                .await
                .map_err(|_| anyhow!("Connection timeout after {} seconds", timeout_secs))?
                .map_err(|e| anyhow!("Failed to connect to {}: {}", addr, e))?;
        self.establish_stream_session(
            config,
            stream,
            timeout_secs,
            &format!("target {}", connection_label(config)),
            unpublished,
        )
        .await
    }

    async fn probe_remote_container(
        &self,
        handle: &Arc<Handle<SSHHandler>>,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
    ) -> anyhow::Result<ServerInfo> {
        let container = config
            .container
            .as_ref()
            .ok_or_else(|| anyhow!("Container configuration is missing"))?;
        validate_container_config(container)?;
        let probe = docker_exec_host_command(
            container,
            "printf '%s\\n' \"$(uname -s 2>/dev/null || printf unknown)\" \"$(hostname 2>/dev/null || printf unknown)\" \"$HOME\"",
            false,
        );
        let result = Self::execute_command_internal(
            handle,
            &probe,
            SSHCommandOptions {
                timeout_ms: Some(timeout_secs.saturating_mul(1000)),
                cancellation_token: None,
            },
        )
        .await
        .with_context(|| {
            format!(
                "Docker container '{}' could not be entered on SSH host {}",
                container.name,
                connection_label(config)
            )
        })?;
        server_info_from_container_probe(container, result)
    }

    async fn probe_local_container(
        &self,
        config: &SSHConnectionConfig,
        timeout_secs: u64,
    ) -> anyhow::Result<ServerInfo> {
        let container = config
            .container
            .as_ref()
            .ok_or_else(|| anyhow!("Local Docker configuration is missing"))?;
        validate_container_config(container)?;
        let args = docker_exec_args(
            container,
            "printf '%s\\n' \"$(uname -s 2>/dev/null || printf unknown)\" \"$(hostname 2>/dev/null || printf unknown)\" \"$HOME\"",
            false,
        );
        let output = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            process_manager::create_tokio_command(&container.docker_path)
                .args(args)
                .output(),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Local Docker container '{}' probe timed out after {} seconds",
                container.name,
                timeout_secs
            )
        })?
        .with_context(|| {
            format!(
                "Failed to start local Docker executable '{}'",
                container.docker_path
            )
        })?;
        server_info_from_container_probe(
            container,
            SSHCommandResult {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                interrupted: false,
                timed_out: false,
            },
        )
    }

    /// Get server information (partial lines allowed so we can still fill `home_dir` via [`Self::probe_remote_home_dir`]).
    async fn get_server_info_internal(
        handle: &Arc<Handle<SSHHandler>>,
        timeout_secs: u64,
    ) -> Option<ServerInfo> {
        let result = Self::execute_command_internal(
            handle,
            "uname -s && hostname && echo $HOME",
            SSHCommandOptions {
                timeout_ms: Some(timeout_secs.saturating_mul(1000)),
                cancellation_token: None,
            },
        )
        .await
        .ok()?;

        if result.exit_code != 0 {
            return None;
        }

        let lines: Vec<&str> = result.stdout.trim().lines().collect();
        if lines.is_empty() {
            return None;
        }

        Some(ServerInfo {
            os_type: lines[0].to_string(),
            hostname: lines.get(1).unwrap_or(&"").to_string(),
            home_dir: lines.get(2).unwrap_or(&"").to_string(),
        })
    }

    /// Resolve remote home directory via SSH `exec` (tilde and `$HOME` are expanded by the remote shell).
    async fn probe_remote_home_dir(
        handle: &Arc<Handle<SSHHandler>>,
        timeout_secs: u64,
    ) -> Option<String> {
        const PROBES: &[&str] = &[
            "sh -c 'echo ~'",
            "echo $HOME",
            "bash -lc 'echo ~'",
            "bash -c 'echo ~'",
            "sh -c 'getent passwd \"$(id -un)\" 2>/dev/null | cut -d: -f6'",
        ];
        for cmd in PROBES {
            let Ok(result) = Self::execute_command_internal(
                handle,
                cmd,
                SSHCommandOptions {
                    timeout_ms: Some(timeout_secs.saturating_mul(1000)),
                    cancellation_token: None,
                },
            )
            .await
            else {
                continue;
            };
            if result.exit_code != 0 {
                continue;
            }
            let first = result.stdout.trim().lines().next().unwrap_or("").trim();
            if first.is_empty() || first == "~" {
                continue;
            }
            return Some(first.to_string());
        }
        None
    }

    /// Execute a command on the remote server
    async fn interrupt_exec_channel(
        session: &russh::Channel<Msg>,
        signal: Sig,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(SSH_COMMAND_INTERRUPT_DRAIN_GRACE, async {
            session.signal(signal).await?;
            let _ = session.eof().await;
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("Timed out sending an SSH command interrupt")?
    }

    async fn close_exec_channel(session: &russh::Channel<Msg>, kill: bool) {
        if kill {
            let _ =
                tokio::time::timeout(SSH_COMMAND_INTERRUPT_DRAIN_GRACE, session.signal(Sig::KILL))
                    .await;
        }
        if !matches!(
            tokio::time::timeout(SSH_COMMAND_INTERRUPT_DRAIN_GRACE, session.close()).await,
            Ok(Ok(()))
        ) {
            log::warn!("Failed to close SSH command channel within the cleanup deadline");
        }
    }

    async fn execute_command_internal(
        handle: &Arc<Handle<SSHHandler>>,
        command: &str,
        options: SSHCommandOptions,
    ) -> anyhow::Result<SSHCommandResult> {
        let handle = handle.clone();
        let command = command.to_string();
        supervise_ssh_command(options, move |options| async move {
            Self::execute_command_owned(&handle, &command, options).await
        })
        .await
    }

    /// Called only by an owned, supervised operation. A pending open request
    /// must stay alive after its caller returns, until it can be closed safely.
    async fn open_ssh_session_owned(
        handle: &Handle<SSHHandler>,
        options: &SSHCommandOptions,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Result<russh::Channel<Msg>, SshCommandStop>> {
        let open = handle.channel_open_session();
        tokio::pin!(open);
        let mut open_requested = false;
        match await_ssh_command_phase(
            std::future::poll_fn(|cx| {
                open_requested = true;
                std::future::Future::poll(open.as_mut(), cx)
            }),
            options.cancellation_token.as_ref(),
            deadline,
        )
        .await
        {
            Ok(result) => Ok(Ok(result?)),
            Err(stop) => {
                if open_requested {
                    // russh does not close an open request when its receiver
                    // is dropped. The supervisor bounds the caller's wait.
                    if let Ok(session) = open.await {
                        Self::close_exec_channel(&session, false).await;
                    }
                }
                Ok(Err(stop))
            }
        }
    }

    async fn open_ssh_exec_channel_owned(
        handle: &Handle<SSHHandler>,
        command: &str,
        options: SSHCommandOptions,
        signal_hook: Option<crate::remote_ssh::transport::WorkspaceSignalHook>,
    ) -> anyhow::Result<russh::Channel<Msg>> {
        let deadline = options
            .timeout_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms));
        let channel = Self::open_ssh_session_owned(handle, &options, deadline)
            .await?
            .map_err(SshCommandStop::error)?;
        match await_ssh_command_phase(
            channel.exec(true, command),
            options.cancellation_token.as_ref(),
            deadline,
        )
        .await
        {
            Ok(Ok(())) => Ok(channel),
            Ok(Err(error)) => {
                Self::close_exec_channel(&channel, false).await;
                Err(error.into())
            }
            Err(stop) => {
                // Exec may already have been enqueued. Docker needs its target
                // process-group hook as well as closing the outer SSH channel.
                if signal_hook.is_some() {
                    drop(
                        crate::remote_ssh::WorkspaceStdio::from_ssh_channel_with_signal_hook(
                            channel,
                            signal_hook,
                        ),
                    );
                } else {
                    Self::close_exec_channel(&channel, true).await;
                }
                Err(stop.error())
            }
        }
    }

    async fn execute_command_owned(
        handle: &Handle<SSHHandler>,
        command: &str,
        options: SSHCommandOptions,
    ) -> std::result::Result<SshCommandOutput, anyhow::Error> {
        let execution_started_at = Instant::now();
        let timeout_deadline = options
            .timeout_ms
            .map(|ms| execution_started_at + Duration::from_millis(ms));
        let command_preview = if command.len() > 160 {
            format!("{}...", truncate_at_char_boundary(command, 160))
        } else {
            command.to_string()
        };
        log::debug!(
            "Remote exec started: timeout_ms={:?}, has_cancellation={}, command_preview={}",
            options.timeout_ms,
            options.cancellation_token.is_some(),
            command_preview
        );
        let mut session =
            match Self::open_ssh_session_owned(handle, &options, timeout_deadline).await? {
                Ok(session) => session,
                Err(stop) => return Ok(stop.output()),
            };
        match await_ssh_command_phase(
            session.exec(true, command),
            options.cancellation_token.as_ref(),
            timeout_deadline,
        )
        .await
        {
            Ok(Ok(())) | Err(_) => {
                // If exec was interrupted while enqueuing its request, the
                // command may already have started. Let the owner loop below
                // send INT and drain before closing the channel.
            }
            Ok(Err(error)) => {
                Self::close_exec_channel(&session, false).await;
                return Err(error.into());
            }
        }

        // Keep bytes intact until the channel closes. SSH packets may split a
        // valid UTF-8 code point at any byte boundary; decoding each packet
        // independently would corrupt otherwise valid non-ASCII output.
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status: Option<i32> = None;
        let mut interrupted = false;
        let mut timed_out = false;
        let stdout_first_chunk_once = Once::new();
        let stderr_first_chunk_once = Once::new();
        let mut eof_logged = false;
        let mut interrupt_drain_deadline: Option<Instant> = None;

        loop {
            let now = Instant::now();

            if !interrupted
                && options
                    .cancellation_token
                    .as_ref()
                    .is_some_and(|token| token.is_cancelled())
            {
                interrupted = true;
                interrupt_drain_deadline.get_or_insert(now + SSH_COMMAND_INTERRUPT_DRAIN_GRACE);
                log::warn!(
                    "Remote exec cancellation requested: timeout_ms={:?}, stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                    options.timeout_ms,
                    stdout.len(),
                    stderr.len(),
                    execution_started_at.elapsed().as_millis(),
                    command_preview
                );
                if let Err(e) = Self::interrupt_exec_channel(&session, Sig::INT).await {
                    log::debug!("Failed to interrupt remote exec channel via SIGINT: {}", e);
                }
            }

            if !timed_out && timeout_deadline.is_some_and(|deadline| now >= deadline) {
                timed_out = true;
                interrupt_drain_deadline.get_or_insert(now + SSH_COMMAND_INTERRUPT_DRAIN_GRACE);
                log::warn!(
                    "Remote exec timeout reached: timeout_ms={:?}, stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                    options.timeout_ms,
                    stdout.len(),
                    stderr.len(),
                    execution_started_at.elapsed().as_millis(),
                    command_preview
                );
                if let Err(e) = Self::interrupt_exec_channel(&session, Sig::INT).await {
                    log::debug!("Failed to interrupt timed out remote exec channel: {}", e);
                }
            }

            let wait_budget = if let Some(deadline) = interrupt_drain_deadline {
                if now >= deadline {
                    Self::close_exec_channel(&session, true).await;
                    break;
                }
                (deadline - now).min(SSH_COMMAND_WAIT_POLL_INTERVAL)
            } else if let Some(deadline) = timeout_deadline {
                if now >= deadline {
                    SSH_COMMAND_WAIT_POLL_INTERVAL
                } else {
                    (deadline - now).min(SSH_COMMAND_WAIT_POLL_INTERVAL)
                }
            } else {
                SSH_COMMAND_WAIT_POLL_INTERVAL
            };

            let next_msg = match tokio::time::timeout(wait_budget, session.wait()).await {
                Ok(msg) => msg,
                Err(_) => continue,
            };

            match next_msg {
                Some(russh::ChannelMsg::Data { ref data }) => {
                    stdout_first_chunk_once.call_once(|| {
                        log::debug!(
                            "Remote exec first stdout chunk received: timeout_ms={:?}, chunk_len={}, duration_ms={}, command_preview={}",
                            options.timeout_ms,
                            data.len(),
                            execution_started_at.elapsed().as_millis(),
                            command_preview
                        );
                    });
                    stdout.extend_from_slice(data);
                }
                Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    stderr_first_chunk_once.call_once(|| {
                        log::debug!(
                            "Remote exec first stderr chunk received: timeout_ms={:?}, chunk_len={}, duration_ms={}, command_preview={}",
                            options.timeout_ms,
                            data.len(),
                            execution_started_at.elapsed().as_millis(),
                            command_preview
                        );
                    });
                    stderr.extend_from_slice(data);
                }
                Some(russh::ChannelMsg::ExitStatus {
                    exit_status: status,
                }) => {
                    exit_status = Some(status as i32);
                    log::debug!(
                        "Remote exec exit status received: exit_code={}, stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                        status,
                        stdout.len(),
                        stderr.len(),
                        execution_started_at.elapsed().as_millis(),
                        command_preview
                    );
                }
                Some(russh::ChannelMsg::ExitSignal { signal_name, .. }) => {
                    interrupted = interrupted || matches!(signal_name, Sig::INT | Sig::TERM);
                    // A signal death is still a resolved status. Without this the
                    // result fell through to the unknown `-1` below.
                    if exit_status.is_none() {
                        exit_status =
                            crate::remote_ssh::transport::ssh_exit_code_for_signal(&signal_name);
                    }
                    log::debug!(
                        "Remote exec exit signal received: signal={:?}, stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                        signal_name,
                        stdout.len(),
                        stderr.len(),
                        execution_started_at.elapsed().as_millis(),
                        command_preview
                    );
                }
                Some(russh::ChannelMsg::Eof) => {
                    if !eof_logged {
                        eof_logged = true;
                        log::debug!(
                            "Remote exec EOF received: stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                            stdout.len(),
                            stderr.len(),
                            execution_started_at.elapsed().as_millis(),
                            command_preview
                        );
                    }
                }
                Some(russh::ChannelMsg::Close) => {
                    log::debug!(
                        "Remote exec channel close received: stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                        stdout.len(),
                        stderr.len(),
                        execution_started_at.elapsed().as_millis(),
                        command_preview
                    );
                    break;
                }
                None => {
                    log::debug!(
                        "Remote exec stream ended: stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
                        stdout.len(),
                        stderr.len(),
                        execution_started_at.elapsed().as_millis(),
                        command_preview
                    );
                    break;
                }
                Some(_) => {}
            }
        }

        let result = SSHCommandResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: match exit_status {
                Some(exit_code) => exit_code,
                None if timed_out => 124,
                None if interrupted => 130,
                None => -1,
            },
            interrupted,
            timed_out,
        };
        log::debug!(
            "Remote exec completed: exit_code={}, interrupted={}, timed_out={}, stdout_len={}, stderr_len={}, duration_ms={}, command_preview={}",
            result.exit_code,
            result.interrupted,
            result.timed_out,
            result.stdout.len(),
            result.stderr.len(),
            execution_started_at.elapsed().as_millis(),
            command_preview
        );

        Ok(SshCommandOutput {
            result,
            exit_status_received: exit_status.is_some(),
        })
    }

    /// Per-connection reconnect mutex, created on first use.
    async fn reconnect_lock_for(&self, connection_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        if let Some(lock) = self.reconnect_locks.read().await.get(connection_id) {
            return lock.clone();
        }
        self.reconnect_locks
            .write()
            .await
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Send SSH_MSG_DISCONNECT before letting a handle drop.
    ///
    /// Dropping a russh `Handle` only closes the socket. The server has no way
    /// to tell that from a network partition, so it keeps the session — and its
    /// PTYs, forwardings and `MaxSessions` slot — until its own timeout fires.
    async fn shutdown_handle(handle: &Handle<SSHHandler>) {
        // Bounded: `disconnect` queues onto the session loop's channel, and a
        // loop wedged on an unwritable socket would never drain it. This runs on
        // app shutdown and on every reconnect, neither of which may block on a
        // peer that has stopped reading. A missed goodbye packet costs one
        // server-side session until its timeout — the status quo — while a hang
        // here costs the whole shutdown.
        match tokio::time::timeout(
            SSH_DISCONNECT_TIMEOUT,
            handle.disconnect(russh::Disconnect::ByApplication, "client closing", "en"),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                log::debug!("SSH disconnect message could not be sent: {}", error)
            }
            Err(_) => log::debug!(
                "SSH disconnect message timed out after {:?}; dropping the transport",
                SSH_DISCONNECT_TIMEOUT
            ),
        }
    }

    /// Tear down a whole hop chain, target first.
    ///
    /// Order matters with ProxyJump: every hop carries the next one's stream, so
    /// closing hop 1 first would cut the channel the later disconnects still
    /// have to travel over and turn an orderly shutdown back into N abandoned
    /// sessions.
    async fn shutdown_handle_chain(handles: Vec<&Handle<SSHHandler>>) {
        for handle in handles {
            Self::shutdown_handle(handle).await;
        }
    }

    /// Ordered handle chain of an `ActiveConnection`: target, then jump hosts
    /// from the last hop backwards.
    fn active_handle_chain(connection: &ActiveConnection) -> Vec<&Handle<SSHHandler>> {
        let mut chain: Vec<&Handle<SSHHandler>> = Vec::with_capacity(
            connection.jump_handles.len() + usize::from(connection.handle.is_some()),
        );
        chain.extend(connection.handle.as_deref());
        chain.extend(connection.jump_handles.iter().rev().map(Arc::as_ref));
        chain
    }

    /// Same ordering for a session that was never published to the map.
    fn established_handle_chain(session: &EstablishedSession) -> Vec<&Handle<SSHHandler>> {
        let mut chain: Vec<&Handle<SSHHandler>> =
            Vec::with_capacity(session.jump_handles.len() + usize::from(session.handle.is_some()));
        chain.extend(session.handle.as_deref());
        chain.extend(session.jump_handles.iter().rev().map(Arc::as_ref));
        chain
    }

    async fn shutdown_active_connection(connection: ActiveConnection) {
        Self::shutdown_handle_chain(Self::active_handle_chain(&connection)).await;
    }

    async fn shutdown_established_session(mut session: EstablishedSession) {
        Self::shutdown_handle_chain(Self::established_handle_chain(&session)).await;
        // Keep the guard armed across the await so cancelling this explicit
        // shutdown still leaves an owner to finish the temporary chain.
        session.unpublished.disarm();
    }

    /// Disconnect from a server
    pub async fn disconnect(&self, connection_id: &str) -> anyhow::Result<()> {
        // Drop the map lock before the network round-trip: the disconnect below
        // awaits, and holding the write lock across it would block every other
        // connection's exec/SFTP entry point.
        let removed = {
            let mut guard = self.connections.write().await;
            guard.remove(connection_id)
        };
        self.reconnect_locks.write().await.remove(connection_id);
        if let Some(connection) = removed {
            Self::shutdown_active_connection(connection).await;
        }
        Ok(())
    }

    /// Disconnect all connections
    pub async fn disconnect_all(&self) {
        let removed: Vec<ActiveConnection> = {
            let mut guard = self.connections.write().await;
            guard.drain().map(|(_, connection)| connection).collect()
        };
        self.reconnect_locks.write().await.clear();
        for connection in removed {
            Self::shutdown_active_connection(connection).await;
        }
    }

    /// Check if connected.
    ///
    /// Returns true only when there is an entry in the connections map AND its
    /// liveness flag is still set. A previously-connected session that the
    /// server (or network) tore down is considered NOT connected even though
    /// the entry has not yet been pruned, so the UI cannot mistakenly believe
    /// the session is healthy.
    pub async fn is_connected(&self, connection_id: &str) -> bool {
        let (alive, config) = {
            let guard = self.connections.read().await;
            let Some(connection) = guard.get(connection_id) else {
                return false;
            };
            (
                connection.alive.load(Ordering::SeqCst),
                connection.effective_config.clone(),
            )
        };
        if !alive {
            return false;
        }
        if let Some(wsl) = &config.wsl {
            return super::wsl::is_running(wsl).await;
        }
        if !config.uses_local_docker() {
            return true;
        }
        let Some(container) = config.container.as_ref() else {
            return false;
        };
        matches!(
            tokio::time::timeout(
                Duration::from_secs(3),
                process_manager::create_tokio_command(&container.docker_path)
                    .args(["inspect", "--format", "{{.State.Running}}", &container.name])
                    .output(),
            )
            .await,
            Ok(Ok(output)) if output.status.success()
                && String::from_utf8_lossy(&output.stdout).trim() == "true"
        )
    }

    async fn load_connection_config_from_saved(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Option<SSHConnectionConfig>> {
        let saved = {
            let guard = self.saved_connections.read().await;
            guard.iter().find(|conn| conn.id == connection_id).cloned()
        };

        let Some(saved) = saved else {
            return Ok(None);
        };

        let local_process = saved.wsl.is_some()
            || saved
                .container
                .as_ref()
                .is_some_and(|container| container.local);
        let auth = match saved.auth_type {
            crate::remote_ssh::types::SavedAuthType::Password => {
                let password = if local_process {
                    String::new()
                } else {
                    self.password_vault.load(connection_id).await?.ok_or_else(|| {
                        anyhow!(
                            "Saved SSH connection {} requires a password, but no stored vault entry is available",
                            connection_id
                        )
                    })?
                };
                SSHAuthMethod::Password { password }
            }
            crate::remote_ssh::types::SavedAuthType::PrivateKey {
                key_path,
                certificate_path,
            } => SSHAuthMethod::PrivateKey {
                key_path,
                passphrase: None,
                certificate_path,
            },
            crate::remote_ssh::types::SavedAuthType::Agent {
                key_fingerprint,
                fallback_key_path,
            } => SSHAuthMethod::Agent {
                key_fingerprint,
                fallback_key_path,
            },
            crate::remote_ssh::types::SavedAuthType::KeyboardInteractive => {
                SSHAuthMethod::KeyboardInteractive {
                    responses: Vec::new(),
                }
            }
        };

        Ok(Some(SSHConnectionConfig {
            id: saved.id,
            name: saved.name,
            host: saved.host,
            port: saved.port,
            username: saved.username,
            auth,
            default_workspace: saved.default_workspace,
            proxy_jump: saved.proxy_jump,
            container: saved.container,
            wsl: saved.wsl,
            options: saved.options,
        }))
    }

    /// Ensure the connection is alive; if it was torn down (network blip,
    /// server-side timeout), transparently reconnect using the saved config
    /// and (for password auth) the encrypted password vault.
    ///
    /// Also detects config drift (e.g. the user changed the port after the
    /// connection was established) and forces a reconnect with the updated
    /// parameters so that historical sessions never use a stale port.
    ///
    /// Uses a per-connection mutex to prevent reconnect stampedes when many
    /// concurrent SFTP/exec calls hit a dead session at the same time.
    /// Idempotent: returns Ok(()) immediately when the session is already alive
    /// **and** its config matches the latest saved profile.
    async fn ensure_alive_or_reconnect(&self, connection_id: &str) -> anyhow::Result<()> {
        // Always read the latest saved config — this is the source of truth
        // after the user edits a connection (e.g. changes the port).
        let saved_config = self
            .load_connection_config_from_saved(connection_id)
            .await?;

        let reconnect_lock = self.reconnect_lock_for(connection_id).await;
        let (alive_flag, active_config) = {
            let guard = self.connections.read().await;
            if let Some(conn) = guard.get(connection_id) {
                (conn.alive.clone(), Some(conn.config.clone()))
            } else {
                (Arc::new(AtomicBool::new(false)), None)
            }
        };

        // If the connection is alive, check for config drift before returning.
        if alive_flag.load(Ordering::SeqCst) {
            if let Some(ref saved) = saved_config {
                if let Some(ref active) = active_config {
                    if !saved.connection_params_equal(active) {
                        log::warn!(
                            "SSH config for {} has drifted (e.g. port {} -> {}), forcing reconnect",
                            connection_id,
                            active.port,
                            saved.port
                        );
                        // Mark as dead so the reconnect path below is taken.
                        alive_flag.store(false, Ordering::SeqCst);
                    } else {
                        return Ok(());
                    }
                } else {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }

        // Serialize concurrent reconnect attempts for the same connection.
        let _guard = reconnect_lock.lock().await;
        // Re-check under lock; another task may have already restored the
        // session. The flag has to be re-read from the map, not from the Arc
        // captured above: a successful reconnect installs a *new* `alive` Arc,
        // leaving the captured one false forever. Trusting it would make every
        // waiter queued behind the lock reconnect all over again — the exact
        // stampede this lock exists to prevent.
        {
            let guard = self.connections.read().await;
            if let Some(conn) = guard.get(connection_id) {
                if conn.alive.load(Ordering::SeqCst) {
                    match saved_config {
                        Some(ref saved) if saved.connection_params_equal(&conn.config) => {
                            return Ok(())
                        }
                        None => return Ok(()),
                        // Still drifted: fall through and reconnect.
                        Some(_) => {}
                    }
                }
            }
        }

        // Prefer the latest saved config for reconnection; fall back to the
        // active config only when no saved profile exists (should be rare).
        let mut config = match saved_config {
            Some(c) => c,
            None => active_config.ok_or_else(|| {
                anyhow!(
                    "Connection {} not found and no saved SSH profile is available",
                    connection_id
                )
            })?,
        };

        let is_existing_connection = {
            let guard = self.connections.read().await;
            guard.contains_key(connection_id)
        };
        if is_existing_connection {
            log::warn!(
                "SSH session {} is dead; attempting transparent reconnect",
                connection_id
            );
        } else {
            log::info!(
                "SSH session {} is not active; attempting to connect using saved SSH profile",
                connection_id
            );
        }

        // Refresh the password from the encrypted vault if password auth was
        // configured but the in-memory copy is empty (defensive — covers cases
        // where callers cleared it intentionally).
        if !config.uses_local_process() {
            if let SSHAuthMethod::Password { ref password } = config.auth {
                if password.is_empty() {
                    match self.password_vault.load(connection_id).await {
                        Ok(Some(pwd)) => {
                            config.auth = SSHAuthMethod::Password { password: pwd };
                        }
                        Ok(None) => {
                            return Err(anyhow!(
                            "SSH session {} is dead and no stored password is available for reconnect",
                            connection_id
                        ));
                        }
                        Err(e) => {
                            return Err(anyhow!("Failed to load stored SSH password: {}", e));
                        }
                    }
                }
            }
        }

        let mut established = self
            .establish_session_with_retries(&config, config.options.connect_timeout_secs.max(1))
            .await?;
        let server_info = established.server_info.clone();

        // Replace the handle, update the config to the latest saved version,
        // and clear the cached SFTP session so subsequent operations open a
        // fresh channel on the new transport.
        // Handles the reconnect displaces still have to be told goodbye: the
        // session is usually dead, but "usually" covers neither config drift
        // (where the old session is perfectly healthy) nor a half-open link the
        // server still counts against its session limit.
        let (stale_handle, stale_jump_handles) = {
            let mut guard = self.connections.write().await;
            established.unpublished.disarm();
            if let Some(conn) = guard.get_mut(connection_id) {
                let stale_handle = conn.handle.take();
                let stale_jump_handles = std::mem::take(&mut conn.jump_handles);
                conn.handle = established.handle;
                conn.jump_handles = established.jump_handles;
                conn.config = config;
                conn.effective_config = established.effective_config;
                conn.alive = established.alive;
                if let Some(si) = server_info.as_ref() {
                    conn.server_info = Some(si.clone());
                }
                conn.sftp_session = Arc::new(SftpCache::new());
                conn.bounded_sftp_session = Arc::new(BoundedSftpCache::new());
                (stale_handle, stale_jump_handles)
            } else {
                let replaced = guard.insert(
                    connection_id.to_string(),
                    ActiveConnection {
                        handle: established.handle,
                        jump_handles: established.jump_handles,
                        config,
                        effective_config: established.effective_config,
                        server_info,
                        sftp_session: Arc::new(SftpCache::new()),
                        bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                        server_key: None,
                        alive: established.alive,
                    },
                );
                match replaced {
                    Some(previous) => (previous.handle, previous.jump_handles),
                    None => (None, Vec::new()),
                }
            }
        };
        // Skip any handle another task still holds. Reconnect is automatic and
        // can fire on config drift while the *old* session is perfectly healthy
        // and carrying an in-flight exec or PTY; sending a goodbye there would
        // kill that command. Those handles simply drop when their user finishes,
        // which is the pre-existing behaviour. An explicit `disconnect()` has no
        // such guard — ending in-flight work is what the user asked for.
        let unused = |handle: &&Arc<Handle<SSHHandler>>| Arc::strong_count(handle) == 1;
        let mut stale_chain: Vec<&Handle<SSHHandler>> = Vec::new();
        stale_chain.extend(stale_handle.iter().filter(unused).map(Arc::as_ref));
        stale_chain.extend(
            stale_jump_handles
                .iter()
                .rev()
                .filter(|handle| Arc::strong_count(handle) == 1)
                .map(Arc::as_ref),
        );
        Self::shutdown_handle_chain(stale_chain).await;

        log::info!("SSH session {} reconnected successfully", connection_id);
        Ok(())
    }

    /// Execute a command on the remote server
    pub async fn execute_command(
        &self,
        connection_id: &str,
        command: &str,
    ) -> anyhow::Result<(String, String, i32)> {
        let result = self
            .execute_command_with_options(connection_id, command, SSHCommandOptions::default())
            .await?;

        if result.timed_out {
            return Err(anyhow!("Command timed out"));
        }
        if result.interrupted {
            return Err(anyhow!("Command was cancelled"));
        }

        Ok((result.stdout, result.stderr, result.exit_code))
    }

    /// Execute a command on the remote server with structured timeout/cancellation handling.
    pub async fn execute_command_with_options(
        &self,
        connection_id: &str,
        command: &str,
        options: SSHCommandOptions,
    ) -> anyhow::Result<SSHCommandResult> {
        let manager = self.clone();
        let connection_id = connection_id.to_string();
        let command = command.to_string();
        supervise_ssh_command(options, move |options| async move {
            manager
                .execute_workspace_command_owned(&connection_id, &command, options)
                .await
        })
        .await
    }

    async fn execute_workspace_command_owned(
        &self,
        connection_id: &str,
        command: &str,
        options: SSHCommandOptions,
    ) -> anyhow::Result<SshCommandOutput> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        if options
            .cancellation_token
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Ok(SshCommandStop::Cancelled.output());
        }
        let (handle, config) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            (
                connection.handle.clone(),
                connection.effective_config.clone(),
            )
        };

        if config.uses_shell_filesystem() {
            let mut setup_options = self.workspace_setup_options(connection_id).await;
            setup_options.timeout_ms = match (setup_options.timeout_ms, options.timeout_ms) {
                (Some(setup), Some(command)) => Some(setup.min(command)),
                (setup, command) => setup.or(command),
            };
            setup_options.cancellation_token = options.cancellation_token.clone();
            let transport = self
                .open_workspace_stdio_with_options(connection_id, command, setup_options)
                .await?;
            return collect_workspace_command_result(transport, options).await;
        }
        let handle =
            handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
        let command = workspace_command(&config, command, false);
        Self::execute_command_owned(&handle, &command, options)
            .await
            .map_err(|error| anyhow!("Command execution failed: {}", error))
    }

    /// Open a long-lived non-PTY exec channel for streaming stdin/stdout protocols.
    pub async fn open_exec_channel(
        &self,
        connection_id: &str,
        command: &str,
    ) -> anyhow::Result<russh::Channel<Msg>> {
        let options = self.workspace_setup_options(connection_id).await;
        let manager = self.clone();
        let connection_id = connection_id.to_string();
        let command = command.to_string();
        match supervise_ssh_owner(options, move |options| async move {
            manager.ensure_alive_or_reconnect(&connection_id).await?;
            let (handle, config) = {
                let guard = manager.connections.read().await;
                let connection = guard
                    .get(&connection_id)
                    .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
                (
                    connection.handle.clone(),
                    connection.effective_config.clone(),
                )
            };
            if config.uses_local_process() {
                anyhow::bail!("Local Docker and WSL execution do not use an SSH channel");
            }
            let handle =
                handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
            Self::open_ssh_exec_channel_owned(
                &handle,
                &workspace_command(&config, &command, false),
                options,
                None,
            )
            .await
            .map(SshExecChannelHandoff::new)
        })
        .await?
        {
            SshOwnerOutcome::Finished(result) => result.map(SshExecChannelHandoff::into_channel),
            SshOwnerOutcome::Stopped(stop, result) => {
                drop(result);
                Err(stop.error())
            }
        }
    }

    /// Connect a saved connection if it is not already live, and return once
    /// the session is usable.
    ///
    /// This is the entry point for callers that hold a connection id but do not
    /// know whether the user ever opened it in this run. It reuses the same
    /// saved-profile load, reconnect serialization, and config-drift handling
    /// as every other operation.
    pub async fn ensure_connected(&self, connection_id: &str) -> anyhow::Result<()> {
        self.ensure_alive_or_reconnect(connection_id).await
    }

    /// Open a `direct-tcpip` channel to `host:port` as reached from the remote
    /// end, which is the transport local port forwarding runs on.
    ///
    /// The handle is re-read from the connection map on every call rather than
    /// cached by the caller: reconnect installs a *new* handle, and a forward
    /// holding the old one would keep splicing traffic into a dead session.
    pub async fn open_direct_tcpip(
        &self,
        connection_id: &str,
        host: &str,
        port: u16,
        originator_host: &str,
        originator_port: u16,
    ) -> anyhow::Result<russh::Channel<Msg>> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        let (handle, config) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            (
                connection.handle.clone(),
                connection.effective_config.clone(),
            )
        };
        if config.uses_local_process() {
            anyhow::bail!("Local Docker and WSL workspaces have no SSH transport to forward over");
        }
        let handle =
            handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;

        handle
            .channel_open_direct_tcpip(host, port as u32, originator_host, originator_port as u32)
            .await
            .map_err(|e| {
                anyhow!(
                    "Failed to reach {}:{} from the remote host: {}",
                    host,
                    port,
                    e
                )
            })
    }

    /// Open a transport-neutral, long-lived stdio process in the effective
    /// workspace target.
    ///
    /// SSH hosts and remote Docker containers are backed by an SSH channel.
    /// Local Docker containers are backed by a supervised local `docker exec`
    /// child. Callers receive the same stdin/stdout/stderr/control/completion
    /// contract for either target.
    pub async fn open_workspace_stdio(
        &self,
        connection_id: &str,
        command: &str,
    ) -> anyhow::Result<crate::remote_ssh::WorkspaceStdio> {
        let options = self.workspace_setup_options(connection_id).await;
        self.open_workspace_stdio_with_options(connection_id, command, options)
            .await
    }

    async fn workspace_setup_options(&self, connection_id: &str) -> SSHCommandOptions {
        let timeout_secs = self
            .get_effective_connection_config(connection_id)
            .await
            .map(|config| config.options.connect_timeout_secs)
            .unwrap_or_else(|| {
                crate::remote_ssh::types::SSHConnectionOptions::default().connect_timeout_secs
            });
        SSHCommandOptions {
            timeout_ms: Some(timeout_secs.max(1).saturating_mul(1000)),
            cancellation_token: None,
        }
    }

    async fn open_workspace_stdio_with_options(
        &self,
        connection_id: &str,
        command: &str,
        options: SSHCommandOptions,
    ) -> anyhow::Result<crate::remote_ssh::WorkspaceStdio> {
        let manager = self.clone();
        let connection_id = connection_id.to_string();
        let command = command.to_string();
        match supervise_ssh_owner(options, move |options| async move {
            manager
                .open_workspace_stdio_owned(&connection_id, &command, options)
                .await
        })
        .await?
        {
            SshOwnerOutcome::Finished(result) => result,
            SshOwnerOutcome::Stopped(stop, result) => {
                // A completed stdio value owns its target-aware cleanup hook.
                // Dropping it here also handles cancellation just after exec.
                drop(result);
                Err(stop.error())
            }
        }
    }

    async fn open_workspace_stdio_owned(
        &self,
        connection_id: &str,
        command: &str,
        options: SSHCommandOptions,
    ) -> anyhow::Result<crate::remote_ssh::WorkspaceStdio> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        if options
            .cancellation_token
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Err(SshCommandStop::Cancelled.error());
        }
        let (handle, config) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            (
                connection.handle.clone(),
                connection.effective_config.clone(),
            )
        };
        if let Some(wsl) = config.wsl {
            super::wsl::ensure_supported()?;
            super::wsl::validate(&wsl)?;
            let (supervised_command, pid_file) = supervised_workspace_command("/bin/sh", command);
            let signal_config = wsl.clone();
            let signal_hook: crate::remote_ssh::transport::WorkspaceSignalHook =
                Arc::new(move |signal| {
                    let config = signal_config.clone();
                    let command = container_signal_command(&pid_file, signal);
                    Box::pin(async move { super::wsl::signal(&config, &command).await })
                });
            return crate::remote_ssh::WorkspaceStdio::spawn_local_process_with_signal_hook(
                super::wsl::EXECUTABLE,
                &super::wsl::exec_args(&wsl, &supervised_command),
                Some(signal_hook),
            );
        }
        if config.uses_docker_exec() {
            let container = config
                .container
                .as_ref()
                .ok_or_else(|| anyhow!("Docker container configuration is missing"))?;
            validate_container_config(container)?;
            let (supervised_command, pid_file) = supervised_container_command(container, command);
            if config.uses_local_docker() {
                let signal_hook = local_container_signal_hook(container.clone(), pid_file);
                return crate::remote_ssh::WorkspaceStdio::spawn_local_process_with_signal_hook(
                    &container.docker_path,
                    &docker_exec_args(container, &supervised_command, false),
                    Some(signal_hook),
                );
            }

            let handle =
                handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
            let host_command = docker_exec_host_command(container, &supervised_command, false);
            let signal_hook =
                remote_container_signal_hook(handle.clone(), container.clone(), pid_file);
            let channel = Self::open_ssh_exec_channel_owned(
                &handle,
                &host_command,
                options,
                Some(signal_hook.clone()),
            )
            .await?;
            return Ok(
                crate::remote_ssh::WorkspaceStdio::from_ssh_channel_with_signal_hook(
                    channel,
                    Some(signal_hook),
                ),
            );
        }

        let handle =
            handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
        let channel = Self::open_ssh_exec_channel_owned(&handle, command, options, None).await?;
        Ok(crate::remote_ssh::WorkspaceStdio::from_ssh_channel(channel))
    }

    /// Open a long-lived exec channel with a PTY attached.
    ///
    /// This gives the command TTY semantics without starting an interactive shell
    /// and typing the command into it, so command wrappers are not echoed into
    /// model-visible output.
    pub async fn open_pty_exec_channel(
        &self,
        connection_id: &str,
        command: &str,
        cols: u32,
        rows: u32,
    ) -> anyhow::Result<russh::Channel<Msg>> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        let (handle, config) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            (
                connection.handle.clone(),
                connection.effective_config.clone(),
            )
        };
        if config.uses_local_process() {
            anyhow::bail!("Local Docker and WSL execution do not use an SSH channel");
        }
        let handle =
            handle.ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
        let command = workspace_command(&config, command, true);

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("Failed to open SSH PTY exec channel: {}", e))?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| anyhow!("Failed to request PTY for remote command: {}", e))?;
        channel
            .exec(true, command.as_str())
            .await
            .map_err(|e| anyhow!("Failed to start remote PTY command: {}", e))?;
        Ok(channel)
    }

    /// Get server info for a connection
    pub async fn get_server_info(&self, connection_id: &str) -> Option<ServerInfo> {
        let guard = self.connections.read().await;
        guard.get(connection_id).and_then(|c| c.server_info.clone())
    }

    /// If `home_dir` is missing, run [`Self::probe_remote_home_dir`] and persist it on the connection.
    pub async fn resolve_remote_home_if_missing(&self, connection_id: &str) -> Option<ServerInfo> {
        let need_probe = {
            let guard = self.connections.read().await;
            match guard.get(connection_id) {
                None => return None,
                Some(conn) => conn
                    .server_info
                    .as_ref()
                    .map(|s| s.home_dir.trim().is_empty())
                    .unwrap_or(true),
            }
        };
        if !need_probe {
            return self.get_server_info(connection_id).await;
        }
        let Ok((output, _, status)) = self
            .execute_command(connection_id, "printf '%s' \"$HOME\"")
            .await
        else {
            return self.get_server_info(connection_id).await;
        };
        let home = output.trim().to_string();
        if status != 0 || home.is_empty() || home == "~" {
            return self.get_server_info(connection_id).await;
        }
        {
            let mut guard = self.connections.write().await;
            if let Some(conn) = guard.get_mut(connection_id) {
                match conn.server_info.as_mut() {
                    Some(si) => si.home_dir = home.clone(),
                    None => {
                        conn.server_info = Some(ServerInfo {
                            os_type: "unknown".to_string(),
                            hostname: "unknown".to_string(),
                            home_dir: home,
                        });
                    }
                }
            }
        }
        self.get_server_info(connection_id).await
    }

    /// Get connection configuration
    pub async fn get_connection_config(&self, connection_id: &str) -> Option<SSHConnectionConfig> {
        let guard = self.connections.read().await;
        guard.get(connection_id).map(|c| c.config.clone())
    }

    pub async fn get_effective_connection_config(
        &self,
        connection_id: &str,
    ) -> Option<SSHConnectionConfig> {
        let guard = self.connections.read().await;
        guard
            .get(connection_id)
            .map(|connection| connection.effective_config.clone())
    }

    pub async fn is_local_process_connection(&self, connection_id: &str) -> bool {
        self.get_effective_connection_config(connection_id)
            .await
            .is_some_and(|config| config.uses_local_process())
    }

    pub async fn is_shell_workspace(&self, connection_id: &str) -> bool {
        self.get_effective_connection_config(connection_id)
            .await
            .is_some_and(|config| config.uses_shell_filesystem())
    }

    pub async fn local_process_exec_spec(
        &self,
        connection_id: &str,
        command: &str,
        tty: bool,
    ) -> anyhow::Result<Option<(String, Vec<String>)>> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        let Some(config) = self.get_effective_connection_config(connection_id).await else {
            anyhow::bail!("Connection {} not found", connection_id);
        };
        if let Some(wsl) = &config.wsl {
            super::wsl::ensure_supported()?;
            super::wsl::validate(wsl)?;
            return Ok(Some((
                super::wsl::EXECUTABLE.into(),
                super::wsl::exec_args(wsl, command),
            )));
        }
        if !config.uses_local_docker() {
            return Ok(None);
        }
        let container = config
            .container
            .as_ref()
            .ok_or_else(|| anyhow!("Local Docker configuration is missing"))?;
        validate_container_config(container)?;
        Ok(Some((
            container.docker_path.clone(),
            docker_exec_args(container, command, tty),
        )))
    }

    pub async fn local_process_shell_spec(
        &self,
        connection_id: &str,
        cwd: Option<&str>,
    ) -> anyhow::Result<Option<(String, Vec<String>)>> {
        self.ensure_alive_or_reconnect(connection_id).await?;
        let Some(config) = self.get_effective_connection_config(connection_id).await else {
            anyhow::bail!("Connection {} not found", connection_id);
        };
        if let Some(wsl) = &config.wsl {
            super::wsl::ensure_supported()?;
            super::wsl::validate(wsl)?;
            super::wsl::validate_cwd(cwd)?;
            return Ok(Some((
                super::wsl::EXECUTABLE.into(),
                super::wsl::shell_args(wsl, cwd),
            )));
        }
        if !config.uses_local_docker() {
            return Ok(None);
        }
        let container = config
            .container
            .as_ref()
            .ok_or_else(|| anyhow!("Local Docker configuration is missing"))?;
        validate_container_config(container)?;
        let mut args = vec!["exec".to_string(), "-i".to_string(), "-t".to_string()];
        if let Some(user) = container
            .user
            .as_deref()
            .map(str::trim)
            .filter(|user| !user.is_empty())
        {
            args.push("--user".to_string());
            args.push(user.to_string());
        }
        if let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
            args.push("--workdir".to_string());
            args.push(cwd.to_string());
        }
        args.push(container.name.clone());
        args.push(container.shell.clone());
        Ok(Some((container.docker_path.clone(), args)))
    }

    async fn execute_workspace_bytes(
        &self,
        connection_id: &str,
        command: &str,
    ) -> anyhow::Result<(Vec<u8>, Vec<u8>, i32)> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let transport = self.open_workspace_stdio(connection_id, command).await?;
        let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
        let _ = stdin.shutdown().await;
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await.map(|_| bytes)
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await.map(|_| bytes)
        });
        let exit = completion.wait().await;
        let stdout = stdout_task
            .await
            .context("Workspace stdout reader task failed")??;
        let stderr = stderr_task
            .await
            .context("Workspace stderr reader task failed")??;
        Ok((stdout, stderr, exit.exit_code.unwrap_or(-1)))
    }

    pub async fn container_read_file(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Vec<u8>> {
        self.container_read_file_with_progress(connection_id, path, &mut |_, _| true)
            .await
    }

    pub async fn open_workspace_file_write_new(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceWriter> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        if self.is_shell_workspace(connection_id).await {
            anyhow::bail!("Streaming upload requires an SFTP workspace provider");
        }
        let sftp = self.get_sftp(connection_id).await?;
        Ok(Box::new(sftp.create_new(&path).await?))
    }

    pub async fn atomic_replace_workspace_file(
        &self,
        connection_id: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<()> {
        let from = self.resolve_sftp_path(connection_id, from).await?;
        let to = self.resolve_sftp_path(connection_id, to).await?;
        if from.rsplit_once('/').map(|p| p.0) != to.rsplit_once('/').map(|p| p.0) {
            anyhow::bail!("Atomic replacement requires a same-directory staged file");
        }
        let command = format!(
            "test ! -d {1} && mv -f -- {0} {1}",
            crate::remote_ssh::shell::quote_arg(&from),
            crate::remote_ssh::shell::quote_arg(&to)
        );
        let (_, stderr, code) = self.execute_command(connection_id, &command).await?;
        if code != 0 {
            anyhow::bail!("Remote atomic replacement failed: {stderr}");
        }
        Ok(())
    }

    pub async fn open_workspace_file_read(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        if self.is_shell_workspace(connection_id).await {
            let command = format!(
                "[ -f {0} ] || {{ echo 'Workspace path is not a readable regular file' >&2; exit 1; }}; cat -- {0}",
                crate::remote_ssh::shell::quote_arg(&path)
            );
            let transport = self.open_workspace_stdio(connection_id, &command).await?;
            return Ok(Box::new(ContainerFileReader::from_transport(transport)));
        }
        let sftp = self.get_sftp(connection_id).await?;
        let file = sftp
            .open(&path)
            .await
            .map_err(anyhow::Error::new)
            .with_context(|| format!("Failed to open remote file '{path}'"))?;
        if !file.metadata().await?.file_type().is_file() {
            anyhow::bail!("Workspace path is not a regular file: {path}");
        }
        Ok(Box::new(file))
    }

    pub async fn set_workspace_file_permissions(
        &self,
        connection_id: &str,
        path: &str,
        permissions: u32,
    ) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        if self.is_shell_workspace(connection_id).await {
            let command = format!(
                "chmod {:o} -- {}",
                permissions & 0o7777,
                crate::remote_ssh::shell::quote_arg(&path)
            );
            return self
                .run_container_fs_command(connection_id, &command, "set permissions", &path)
                .await;
        }
        let sftp = self.get_sftp(connection_id).await?;
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(permissions),
            ..Default::default()
        };
        sftp.set_metadata(&path, attrs)
            .await
            .map_err(anyhow::Error::new)
            .with_context(|| format!("Failed to set remote file permissions: {path}"))
    }

    pub async fn set_workspace_file_modified(
        &self,
        connection_id: &str,
        path: &str,
        modified: std::time::SystemTime,
    ) -> anyhow::Result<()> {
        let seconds = modified
            .duration_since(std::time::UNIX_EPOCH)
            .context("Remote file modification time is before the Unix epoch")?
            .as_secs();
        let path = self.resolve_sftp_path(connection_id, path).await?;
        if self.is_shell_workspace(connection_id).await {
            let command = format!(
                "touch -m -d @{} -- {}",
                seconds,
                crate::remote_ssh::shell::quote_arg(&path)
            );
            return self
                .run_container_fs_command(connection_id, &command, "set modification time", &path)
                .await;
        }
        let seconds = u32::try_from(seconds)
            .context("Remote file modification time is outside the SFTP timestamp range")?;
        let sftp = self.get_sftp(connection_id).await?;
        let atime = sftp.metadata(&path).await?.atime
            .context("The SFTP server omitted access time; modification time cannot be changed without overwriting it")?;
        // SFTP v3 sends access and modification time together. Preserve access
        // time while avoiding unrelated size, owner or permission updates.
        let attrs = russh_sftp::protocol::FileAttributes {
            atime: Some(atime),
            mtime: Some(seconds),
            ..Default::default()
        };
        sftp.set_metadata(&path, attrs)
            .await
            .map_err(anyhow::Error::new)
            .with_context(|| format!("Failed to set remote file modification time: {path}"))
    }

    pub async fn container_read_file_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<Vec<u8>> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let path = self.resolve_sftp_path(connection_id, path).await?;
        let total = self
            .container_stat(connection_id, &path)
            .await?
            .and_then(|entry| entry.size)
            .unwrap_or(0);
        if !on_progress(0, total) {
            anyhow::bail!("Transfer cancelled");
        }

        let command = format!("cat -- {}", crate::remote_ssh::shell::quote_arg(&path));
        let transport = self.open_workspace_stdio(connection_id, &command).await?;
        let (mut stdin, mut stdout, mut stderr, control, completion) = transport.into_parts();
        let _ = stdin.shutdown().await;
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            bytes
        });
        let mut content = Vec::new();
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let read = stdout
                .read(&mut chunk)
                .await
                .with_context(|| format!("Failed to read container file '{}'", path))?;
            if read == 0 {
                break;
            }
            content.extend_from_slice(&chunk[..read]);
            if !on_progress(content.len() as u64, total) {
                let _ = control.kill().await;
                let _ = completion.wait().await;
                anyhow::bail!("Transfer cancelled");
            }
        }
        let stderr = stderr_task.await.unwrap_or_default();
        let exit = completion.wait().await;
        if exit.exit_code.unwrap_or(-1) != 0 {
            anyhow::bail!(
                "Failed to read container file '{}': {}",
                path,
                String::from_utf8_lossy(&stderr).trim()
            );
        }
        let _ = on_progress(content.len() as u64, total);
        Ok(content)
    }

    pub async fn container_write_file(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> anyhow::Result<()> {
        self.container_write_file_with_progress(connection_id, path, content, &mut |_, _| true)
            .await
    }

    /// Workspace writes preserve the destination inode, mode and link target,
    /// like local fs::write and SFTP CREATE|TRUNCATE. Generic uploads keep their
    /// existing atomic replacement contract below.
    pub async fn write_workspace_file(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        if !self.is_shell_workspace(connection_id).await {
            return self.sftp_write(connection_id, path, content).await;
        }
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let parent = path
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or(".");
        let temporary = format!(
            "{}/{}-upload-{}.tmp",
            parent.trim_end_matches('/'),
            hidden_data_directory(),
            uuid::Uuid::new_v4()
        );
        let command = container_workspace_write_command(&path, &temporary, content.len());
        let transport = self.open_workspace_stdio(connection_id, &command).await?;
        let (mut stdin, mut stdout, stderr, _control, completion) = transport.into_parts();
        // Keep all streams in this future: cancellation drops every lease and
        // triggers target-aware cleanup instead of detaching reader tasks.
        let (_, _, stderr) = tokio::try_join!(
            async {
                stdin.write_all(content).await?;
                stdin.shutdown().await
            },
            async { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await },
            drain_workspace_diagnostics(stderr),
        )
        .with_context(|| {
            format!(
                "Failed to stream container workspace file '{path}'; write outcome may be partial"
            )
        })?;
        let exit = completion.wait().await;
        if exit.exit_code != Some(0) {
            anyhow::bail!(
                "Failed to write container workspace file '{}': exit_status={:?} {}",
                path,
                exit.exit_code,
                String::from_utf8_lossy(&stderr).trim()
            );
        }
        Ok(())
    }

    pub async fn container_write_file_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<()> {
        self.container_stream_write(
            connection_id,
            path,
            content.len() as u64,
            ContainerUploadSource::Memory(content),
            on_progress,
        )
        .await
    }

    /// Stream one local regular file into the container upload command without
    /// buffering it in memory.
    ///
    /// The destination is replaced only after the staged bytes passed the
    /// command's size check, so a cancelled or failed upload leaves the previous
    /// destination untouched.
    pub async fn container_write_file_from_path_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        local_path: &std::path::Path,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<u64> {
        let local_metadata = tokio::fs::symlink_metadata(local_path)
            .await
            .map_err(|error| {
                anyhow!(
                    "Failed to inspect local upload file '{}': {}",
                    local_path.display(),
                    error
                )
            })?;
        if local_metadata.file_type().is_symlink() || !local_metadata.is_file() {
            return Err(anyhow!(
                "Local upload source is not a regular file: {}",
                local_path.display()
            ));
        }
        let expected_size = local_metadata.len();
        self.container_stream_write(
            connection_id,
            path,
            expected_size,
            ContainerUploadSource::LocalFile(local_path.to_path_buf()),
            on_progress,
        )
        .await?;
        Ok(expected_size)
    }

    async fn container_stream_write(
        &self,
        connection_id: &str,
        path: &str,
        expected_size: u64,
        source: ContainerUploadSource<'_>,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let path = self.resolve_sftp_path(connection_id, path).await?;
        let parent = path
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or(".");
        let temporary = format!(
            "{}/{}-upload-{}.tmp",
            parent.trim_end_matches('/'),
            hidden_data_directory(),
            uuid::Uuid::new_v4()
        );
        let quoted_temporary = crate::remote_ssh::shell::quote_arg(&temporary);
        let quoted_path = crate::remote_ssh::shell::quote_arg(&path);
        let quoted_parent = crate::remote_ssh::shell::quote_arg(parent);
        let sweep = stale_upload_sweep(&quoted_parent);
        let command = format!(
            "{sweep} \
             tmp={quoted_temporary}; target={quoted_path}; expected={expected_size}; \
             cleanup() {{ rm -f -- \"$tmp\"; }}; trap cleanup EXIT HUP INT TERM; \
             umask 077; status=0; cat > \"$tmp\" || status=$?; \
             if [ \"$status\" -eq 0 ]; then \
               actual=$(wc -c < \"$tmp\" 2>/dev/null) || status=$?; \
               if [ \"$status\" -eq 0 ]; then \
                 if [ \"$actual\" -eq \"$expected\" ]; then \
                   mv -f -- \"$tmp\" \"$target\" || status=$?; \
                 else status=65; fi; \
               fi; \
             fi; \
             trap - EXIT; cleanup; exit \"$status\""
        );
        let transport = self.open_workspace_stdio(connection_id, &command).await?;
        let (mut stdin, mut stdout, mut stderr, control, completion) = transport.into_parts();
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes).await;
            bytes
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            bytes
        });
        let total = expected_size;
        if !on_progress(0, total) {
            return Err(abort_container_upload(
                &control,
                completion,
                anyhow!("Transfer cancelled"),
            )
            .await);
        }

        let mut written = 0u64;
        match source {
            ContainerUploadSource::Memory(content) => {
                for chunk in content.chunks(256 * 1024) {
                    if let Err(error) = stdin.write_all(chunk).await {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!("Failed to stream container file '{}': {}", path, error),
                        )
                        .await);
                    }
                    written += chunk.len() as u64;
                    if !on_progress(written, total) {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!("Transfer cancelled"),
                        )
                        .await);
                    }
                }
            }
            ContainerUploadSource::LocalFile(local_path) => {
                let mut local = match tokio::fs::File::open(&local_path).await {
                    Ok(local) => local,
                    Err(error) => {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!(
                                "Failed to open local upload file '{}': {}",
                                local_path.display(),
                                error
                            ),
                        )
                        .await);
                    }
                };
                let mut buffer = vec![0u8; 256 * 1024];
                loop {
                    let read = match local.read(&mut buffer).await {
                        Ok(read) => read,
                        Err(error) => {
                            return Err(abort_container_upload(
                                &control,
                                completion,
                                anyhow!(
                                    "Failed to read local upload file '{}': {}",
                                    local_path.display(),
                                    error
                                ),
                            )
                            .await);
                        }
                    };
                    if read == 0 {
                        break;
                    }
                    if let Err(error) = stdin.write_all(&buffer[..read]).await {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!("Failed to stream container file '{}': {}", path, error),
                        )
                        .await);
                    }
                    written = written.saturating_add(read as u64);
                    if written > expected_size {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!("Local upload file changed while it was being sent"),
                        )
                        .await);
                    }
                    if !on_progress(written, total) {
                        return Err(abort_container_upload(
                            &control,
                            completion,
                            anyhow!("Transfer cancelled"),
                        )
                        .await);
                    }
                }
                if written != expected_size {
                    return Err(abort_container_upload(
                        &control,
                        completion,
                        anyhow!("Local upload file changed while it was being sent"),
                    )
                    .await);
                }
            }
        }
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to finish container file upload '{}'", path))?;
        let exit = completion.wait().await;
        let _stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();
        if exit.exit_code.unwrap_or(-1) != 0 {
            anyhow::bail!(
                "Failed to atomically write container file '{}': {}",
                path,
                String::from_utf8_lossy(&stderr).trim()
            );
        }
        Ok(())
    }

    pub async fn container_read_dir(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Vec<crate::remote_ssh::types::RemoteDirEntry>> {
        self.container_read_dir_with_limit(connection_id, path, None)
            .await
    }

    pub async fn container_read_dir_bounded(
        &self,
        connection_id: &str,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<crate::remote_ssh::types::RemoteDirEntry>> {
        self.container_read_dir_with_limit(connection_id, path, Some(max_entries))
            .await
    }

    async fn container_read_dir_with_limit(
        &self,
        connection_id: &str,
        path: &str,
        max_entries: Option<usize>,
    ) -> anyhow::Result<Vec<crate::remote_ssh::types::RemoteDirEntry>> {
        if max_entries == Some(0) {
            return Ok(Vec::new());
        }
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let script = container_read_dir_script(&path, max_entries);
        let (stdout, stderr, status) = self.execute_workspace_bytes(connection_id, &script).await?;
        if status != 0 || !stderr.is_empty() {
            anyhow::bail!(
                "Failed to list container directory '{}': {}",
                path,
                String::from_utf8_lossy(&stderr).trim()
            );
        }
        let stdout = String::from_utf8(stdout).with_context(|| {
            format!(
                "Container directory '{}' contains a filename that is not valid UTF-8",
                path
            )
        })?;
        parse_container_dir_output(&stdout)
    }

    pub async fn container_exists(&self, connection_id: &str, path: &str) -> anyhow::Result<bool> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let command = format!(
            "test -e {0} || test -L {0}",
            crate::remote_ssh::shell::quote_arg(&path)
        );
        let (_, stderr, status) = self.execute_command(connection_id, &command).await?;
        parse_container_exists_output(&path, &stderr, status)
    }

    pub async fn container_mkdir(
        &self,
        connection_id: &str,
        path: &str,
        recursive: bool,
    ) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let flag = if recursive { "-p " } else { "" };
        self.run_container_fs_command(
            connection_id,
            &format!("mkdir {flag}{}", crate::remote_ssh::shell::quote_arg(&path)),
            "create directory",
            &path,
        )
        .await
    }

    pub async fn container_remove(
        &self,
        connection_id: &str,
        path: &str,
        directory: bool,
    ) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let command = if directory {
            format!("rmdir {}", crate::remote_ssh::shell::quote_arg(&path))
        } else {
            format!("rm -- {}", crate::remote_ssh::shell::quote_arg(&path))
        };
        self.run_container_fs_command(connection_id, &command, "remove", &path)
            .await
    }

    pub async fn container_rename(
        &self,
        connection_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> anyhow::Result<()> {
        let old_path = self.resolve_sftp_path(connection_id, old_path).await?;
        let new_path = self.resolve_sftp_path(connection_id, new_path).await?;
        let command = format!(
            "mv -- {} {}",
            crate::remote_ssh::shell::quote_arg(&old_path),
            crate::remote_ssh::shell::quote_arg(&new_path)
        );
        self.run_container_fs_command(connection_id, &command, "rename", &old_path)
            .await
    }

    pub async fn container_stat(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<crate::remote_ssh::types::RemoteFileEntry>> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let quoted = crate::remote_ssh::shell::quote_arg(&path);
        let script = format!(
            "item={quoted}; [ -e \"$item\" ] || [ -L \"$item\" ] || exit 44; \
             {metadata_script}",
            metadata_script = CONTAINER_ENTRY_METADATA_SCRIPT,
        );
        let (stdout, stderr, status) = self.execute_workspace_bytes(connection_id, &script).await?;
        if status == 44 {
            return Ok(None);
        }
        if status != 0 {
            anyhow::bail!(
                "Failed to stat container path '{}': {}",
                path,
                String::from_utf8_lossy(&stderr).trim()
            );
        }
        let stdout = String::from_utf8(stdout).with_context(|| {
            format!(
                "Container path '{}' is not representable as a UTF-8 workspace path",
                path
            )
        })?;
        parse_container_file_output(&stdout)
    }

    pub async fn container_workspace_metadata(
        &self,
        connection_id: &str,
        path: &str,
        follow_symlinks: bool,
    ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
        let mut path = self.resolve_sftp_path(connection_id, path).await?;
        let follow = if follow_symlinks { "-L " } else { "" };
        // Query stat itself: `test -e` also returns false for inaccessible
        // parents. Keep those failures distinct from an actual missing path.
        for followed in 0..=40 {
            let quoted = crate::remote_ssh::shell::quote_arg(&path);
            let script = format!(
            "export LC_ALL=C; if first=$(stat {follow}-c '%f %s %Y %a' -- {quoted} 2>&1); then printf 'hex %s\\n' \"$first\"; \
             elif second=$(stat {follow}-f '%p %z %m %Lp' {quoted} 2>&1); then printf 'oct %s\\n' \"$second\"; \
             else case \"$first\" in *': No such file or directory') exit 44;; esac; \
             case \"$second\" in *': No such file or directory') exit 44;; esac; \
             printf '%s\\n%s\\n' \"$first\" \"$second\" >&2; exit 1; fi"
        );
            let (stdout, stderr, status) =
                self.execute_workspace_bytes(connection_id, &script).await?;
            if status == 44 {
                return Ok(None);
            }
            if status != 0 {
                anyhow::bail!(
                    "Failed to inspect container path '{}': exit_status={} {}",
                    path,
                    status,
                    String::from_utf8_lossy(&stderr).trim()
                );
            }
            let metadata = parse_workspace_stat_output(std::str::from_utf8(&stdout)?)?;
            if !follow_symlinks
                || metadata.kind != openbitfun_runtime_ports::WorkspacePathKind::Symlink
            {
                return Ok(Some(metadata));
            }
            // BSD stat -L silently falls back to lstat when the referent
            // cannot be inspected. Inspect the link's target explicitly so
            // ENOENT stays distinct from permissions, ENOTDIR and link loops.
            if followed == 40 {
                anyhow::bail!(
                    "Too many symbolic links while inspecting container path '{}'",
                    path
                );
            }
            let (target, stderr, status) = self
                .execute_workspace_bytes(connection_id, &format!("readlink -- {quoted}"))
                .await?;
            if status != 0 {
                anyhow::bail!(
                    "Failed to read container symbolic link '{}': exit_status={} {}",
                    path,
                    status,
                    String::from_utf8_lossy(&stderr).trim()
                );
            }
            let target = std::str::from_utf8(&target)?
                .strip_suffix('\n')
                .ok_or_else(|| anyhow!("Invalid readlink output for container path '{}'", path))?;
            if target.is_empty() {
                anyhow::bail!("Empty symbolic link target for container path '{}'", path);
            }
            path = if target.starts_with('/') {
                target.to_string()
            } else {
                let parent = path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or(".");
                format!("{parent}/{target}")
            };
        }
        unreachable!("symbolic link traversal returns at its bound")
    }

    async fn run_container_fs_command(
        &self,
        connection_id: &str,
        command: &str,
        operation: &str,
        path: &str,
    ) -> anyhow::Result<()> {
        let (_, stderr, status) = self.execute_command(connection_id, command).await?;
        if status != 0 {
            anyhow::bail!(
                "Failed to {} container path '{}': {}",
                operation,
                path,
                stderr.trim()
            );
        }
        Ok(())
    }

    // ============================================================================
    // SFTP Operations
    // ============================================================================

    /// Expand leading `~` using the remote user's home from [`ServerInfo`] (SFTP paths are not shell-expanded).
    pub async fn resolve_sftp_path(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<String> {
        let path = path.trim();
        if path.is_empty() {
            return Err(anyhow!("Empty remote path"));
        }
        if path == "~" || path.starts_with("~/") {
            let guard = self.connections.read().await;
            let home = guard
                .get(connection_id)
                .and_then(|c| c.server_info.as_ref())
                .map(|s| s.home_dir.trim())
                .filter(|h| !h.is_empty());
            let home = match home {
                Some(h) => h.to_string(),
                None => {
                    return Err(anyhow!(
                        "Cannot use '~' in remote path: home directory is not available for this connection"
                    ));
                }
            };
            if path == "~" || path == "~/" {
                return Ok(home);
            }
            let rest = path[2..].trim_start_matches('/');
            if rest.is_empty() {
                return Ok(home);
            }
            Ok(format!("{}/{}", home.trim_end_matches('/'), rest))
        } else {
            Ok(path.to_string())
        }
    }

    /// Get or create SFTP session for a connection.
    ///
    /// Detects dead transports up-front via [`Self::ensure_alive_or_reconnect`]
    /// so a transient SSH disconnect (e.g. NAT timeout while the user is idly
    /// browsing the remote folder picker) is recovered transparently instead
    /// of cascading into a stale cached SFTP handle that fails forever.
    async fn get_sftp(&self, connection_id: &str) -> anyhow::Result<Arc<ManagedSftpSession>> {
        self.ensure_alive_or_reconnect(connection_id).await?;

        // Capture the transport and cache from the same connection generation.
        // A reconnect may replace both while channel setup awaits; publishing
        // only into this captured cache prevents an old host's session from
        // becoming visible through the new generation.
        let (handle, cache): (Arc<Handle<SSHHandler>>, Arc<SftpCache>) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            if connection.effective_config.uses_docker_exec() {
                anyhow::bail!(
                    "SFTP is unavailable for Docker container workspaces; use workspace file operations"
                );
            }
            let handle = connection
                .handle
                .clone()
                .ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
            (handle, connection.sftp_session.clone())
        };

        if let Some(session) = cache
            .session
            .read()
            .await
            .as_ref()
            .filter(|session| !session.is_retired())
            .cloned()
        {
            return Ok(session);
        }

        // Serialize initialization within one generation so concurrent callers
        // cannot exhaust the server's channel/session limit.
        let _init_guard = cache.init_lock.lock().await;
        if let Some(session) = cache
            .session
            .read()
            .await
            .as_ref()
            .filter(|session| !session.is_retired())
            .cloned()
        {
            return Ok(session);
        }

        // Open a channel and request SFTP subsystem
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("Failed to open channel for SFTP: {}", e))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| anyhow!("Failed to request SFTP subsystem: {}", e))?;

        let sftp = SftpSession::new_with_config(channel.into_stream(), sftp_client_config())
            .await
            .map_err(|e| anyhow!("Failed to create SFTP session: {}", e))?;

        let sftp = Arc::new(ManagedSftpSession::new(sftp));
        *cache.session.write().await = Some(sftp.clone());

        Ok(sftp)
    }

    /// Reuse a dedicated SFTP channel for serialized directory enumeration.
    /// The high-level API leaks directory handles on errors/cancellation. The
    /// raw path closes on all exits and can also stop at an entry budget.
    async fn get_bounded_sftp(&self, connection_id: &str) -> anyhow::Result<BoundedSftpSession> {
        self.ensure_alive_or_reconnect(connection_id).await?;

        let (handle, cache): (Arc<Handle<SSHHandler>>, Arc<BoundedSftpCache>) = {
            let guard = self.connections.read().await;
            let connection = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            if connection.effective_config.uses_docker_exec() {
                anyhow::bail!(
                    "SFTP is unavailable for Docker container workspaces; use workspace file operations"
                );
            }
            let handle = connection
                .handle
                .clone()
                .ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?;
            (handle, connection.bounded_sftp_session.clone())
        };

        let cached_channel = cache
            .channel
            .read()
            .await
            .as_ref()
            .filter(|channel| !channel.retired.load(Ordering::Acquire))
            .cloned();
        if let Some(channel) = cached_channel {
            return Ok(BoundedSftpSession {
                channel,
                cache: cache.clone(),
            });
        }

        let _init_guard = cache.init_lock.lock().await;
        let cached_channel = cache
            .channel
            .read()
            .await
            .as_ref()
            .filter(|channel| !channel.retired.load(Ordering::Acquire))
            .cloned();
        if let Some(channel) = cached_channel {
            return Ok(BoundedSftpSession {
                channel,
                cache: cache.clone(),
            });
        }

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| anyhow!("Failed to open channel for SFTP: {}", error))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| anyhow!("Failed to request SFTP subsystem: {}", error))?;
        let session = RawSftpSession::new_with_config(channel.into_stream(), sftp_client_config());
        session
            .init()
            .await
            .map_err(|error| anyhow!("Failed to create bounded SFTP session: {}", error))?;
        let channel = Arc::new(BoundedSftpChannel {
            retired: AtomicBool::new(false),
            session: Arc::new(session),
            read_lock: tokio::sync::Mutex::new(()),
        });

        let mut cached = cache.channel.write().await;
        *cached = Some(channel.clone());
        drop(cached);
        Ok(BoundedSftpSession {
            channel,
            cache: cache.clone(),
        })
    }

    /// Read a file via SFTP
    pub async fn sftp_read(&self, connection_id: &str, path: &str) -> anyhow::Result<Vec<u8>> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        let mut file = sftp
            .open(&path)
            .await
            .map_err(|e| anyhow!("Failed to open remote file '{}': {}", path, e))?;

        let mut buffer = Vec::new();
        use tokio::io::AsyncReadExt;
        file.read_to_end(&mut buffer)
            .await
            .map_err(|e| anyhow!("Failed to read remote file '{}': {}", path, e))?;

        file.close()
            .await
            .context("Failed to close remote file after reading")?;
        Ok(buffer)
    }

    /// Read a file via SFTP with chunked progress reporting.
    ///
    /// Reads the file in `chunk_size`-byte chunks, invoking `on_progress`
    /// after each chunk with `(bytes_read, total_size)`. If the callback
    /// returns `false`, the read is aborted. Returns the full file contents.
    pub async fn sftp_read_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        chunk_size: usize,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<Vec<u8>> {
        let resolved = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;

        // Determine file size from metadata for progress calculation.
        let metadata = sftp
            .as_ref()
            .metadata(&resolved)
            .await
            .map_err(|e| anyhow!("Failed to stat '{}': {}", resolved, e))?;
        let total = metadata.size.unwrap_or(0);

        let mut file = sftp
            .open(&resolved)
            .await
            .map_err(|e| anyhow!("Failed to open remote file '{}': {}", resolved, e))?;

        let mut buffer = Vec::new();
        let mut chunk = vec![0u8; chunk_size];
        let mut bytes_read: u64 = 0;

        use tokio::io::AsyncReadExt;
        loop {
            let n = file
                .read(&mut chunk)
                .await
                .map_err(|e| anyhow!("Failed to read remote file '{}': {}", resolved, e))?;
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..n]);
            bytes_read += n as u64;
            if !on_progress(bytes_read, total) {
                return Err(anyhow!("Transfer cancelled"));
            }
        }

        // Ensure final 100% progress is reported even if metadata returned 0.
        on_progress(bytes_read, total);

        file.close()
            .await
            .context("Failed to close remote file after reading")?;
        Ok(buffer)
    }

    /// Write a file via SFTP
    pub async fn sftp_write(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        let mut file = sftp
            .create(&path)
            .await
            .map_err(|e| anyhow!("Failed to create remote file '{}': {}", path, e))?;

        use tokio::io::AsyncWriteExt;
        file.write_all(content)
            .await
            .map_err(|e| anyhow!("Failed to write remote file '{}': {}", path, e))?;

        file.flush()
            .await
            .map_err(|e| anyhow!("Failed to flush remote file '{}': {}", path, e))?;

        file.close()
            .await
            .context("Failed to close remote file after writing")?;
        Ok(())
    }

    /// Stream one local regular file to a remote SFTP path without buffering
    /// the complete file in memory.
    pub async fn sftp_write_from_file(
        &self,
        connection_id: &str,
        path: &str,
        local_path: &std::path::Path,
        max_bytes: u64,
    ) -> anyhow::Result<u64> {
        self.sftp_write_from_file_with_progress(
            connection_id,
            path,
            local_path,
            max_bytes,
            &mut |_, _| true,
        )
        .await
    }

    /// Stream one local regular file to a remote SFTP path without buffering
    /// the complete file in memory, reporting `(bytes_written, total_bytes)`
    /// after every chunk. Returning `false` from `on_progress` stops the
    /// transfer at the next chunk boundary.
    ///
    /// The destination is created before the first chunk, so a cancelled or
    /// failed transfer can leave partial bytes behind. Callers that must keep
    /// the previous destination intact stage the upload and publish it only
    /// after this returns successfully; see
    /// `RemoteFileService::write_file_from_local_path_with_progress`.
    pub async fn sftp_write_from_file_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        local_path: &std::path::Path,
        max_bytes: u64,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<u64> {
        let local_metadata = tokio::fs::symlink_metadata(local_path)
            .await
            .map_err(|error| {
                anyhow!(
                    "Failed to inspect local upload file '{}': {}",
                    local_path.display(),
                    error
                )
            })?;
        if local_metadata.file_type().is_symlink() || !local_metadata.is_file() {
            return Err(anyhow!(
                "Local SFTP upload source is not a regular file: {}",
                local_path.display()
            ));
        }
        if local_metadata.len() > max_bytes {
            return Err(anyhow!(
                "Local SFTP upload source exceeds the {} byte limit",
                max_bytes
            ));
        }

        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        let mut remote = sftp
            .create(&path)
            .await
            .map_err(|error| anyhow!("Failed to create remote file '{}': {}", path, error))?;
        let mut local = tokio::fs::File::open(local_path).await.map_err(|error| {
            anyhow!(
                "Failed to open local upload file '{}': {}",
                local_path.display(),
                error
            )
        })?;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buffer = vec![0_u8; 256 * 1024];
        let mut written = 0_u64;
        let total = local_metadata.len();
        loop {
            let read = local.read(&mut buffer).await.map_err(|error| {
                anyhow!(
                    "Failed to read local upload file '{}': {}",
                    local_path.display(),
                    error
                )
            })?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read as u64);
            if written > max_bytes || written > local_metadata.len() {
                return Err(anyhow!("Local upload file changed while it was being sent"));
            }
            remote
                .write_all(&buffer[..read])
                .await
                .map_err(|error| anyhow!("Failed to write remote file '{}': {}", path, error))?;
            if !on_progress(written, total) {
                return Err(anyhow!("Transfer cancelled"));
            }
        }
        if written != local_metadata.len() {
            return Err(anyhow!("Local upload file changed while it was being sent"));
        }
        remote
            .flush()
            .await
            .map_err(|error| anyhow!("Failed to flush remote file '{}': {}", path, error))?;
        remote
            .close()
            .await
            .context("Failed to close remote upload file")?;
        Ok(written)
    }

    /// Write a file via SFTP with chunked progress reporting.
    ///
    /// Writes `content` in `chunk_size`-byte chunks, invoking `on_progress`
    /// after each chunk with `(bytes_written, total_size)`. If the callback
    /// returns `false`, the write is aborted.
    pub async fn sftp_write_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
        chunk_size: usize,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        let mut file = sftp
            .create(&path)
            .await
            .map_err(|e| anyhow!("Failed to create remote file '{}': {}", path, e))?;

        use tokio::io::AsyncWriteExt;
        let total = content.len() as u64;
        let mut written: u64 = 0;

        for chunk in content.chunks(chunk_size) {
            file.write_all(chunk)
                .await
                .map_err(|e| anyhow!("Failed to write remote file '{}': {}", path, e))?;
            written += chunk.len() as u64;
            if !on_progress(written, total) {
                return Err(anyhow!("Transfer cancelled"));
            }
        }

        file.flush()
            .await
            .map_err(|e| anyhow!("Failed to flush remote file '{}': {}", path, e))?;

        file.close()
            .await
            .context("Failed to close remote file after writing")?;
        Ok(())
    }

    /// Read a directory with the same handle cleanup as bounded enumeration.
    pub async fn sftp_read_dir(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Vec<SftpFile>> {
        self.sftp_read_dir_bounded(connection_id, path, usize::MAX)
            .await
    }

    /// Read at most `max_entries` directory entries without asking the SFTP
    /// server for the remainder of the directory.
    pub async fn sftp_read_dir_bounded(
        &self,
        connection_id: &str,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<SftpFile>> {
        if max_entries == 0 {
            return Ok(Vec::new());
        }
        let resolved = self.resolve_sftp_path(connection_id, path).await?;
        let session = self.get_bounded_sftp(connection_id).await?;
        match Self::read_bounded_sftp_entries(&session, &resolved, max_entries).await {
            Ok(entries) => Ok(entries),
            Err(first_error) => {
                let generation_is_current = self
                    .bounded_sftp_generation_is_current(connection_id, &session)
                    .await;
                if generation_is_current && !sftp_error_may_be_stale_transport(&first_error) {
                    return Err(anyhow!(
                        "Failed to read directory '{}': {}",
                        resolved,
                        first_error
                    ));
                }
                // A cancelled enumeration may have retired this channel while
                // another caller waited on its read lock. Replace that SFTP
                // subsystem without marking the shared SSH transport dead.
                if generation_is_current && !session.channel.retired.load(Ordering::Acquire) {
                    log::warn!(
                        "Bounded SFTP read_dir '{}' failed (will retry once after refreshing session): {}",
                        resolved,
                        first_error
                    );
                    self.invalidate_bounded_sftp_generation(connection_id, &session)
                        .await;
                }
                let session = self.get_bounded_sftp(connection_id).await?;
                Self::read_bounded_sftp_entries(&session, &resolved, max_entries)
                    .await
                    .map_err(|error| anyhow!("Failed to read directory '{}': {}", resolved, error))
            }
        }
    }

    async fn read_bounded_sftp_entries(
        bounded: &BoundedSftpSession,
        path: &str,
        max_entries: usize,
    ) -> Result<Vec<SftpFile>, SftpError> {
        let _read_lock = bounded.channel.read_lock.lock().await;
        if bounded.channel.retired.load(Ordering::Acquire) {
            return Err(SftpError::IO("SFTP directory channel was retired".into()));
        }
        let session = bounded.channel.session.as_ref();
        let mut read_guard = BoundedSftpReadGuard::new(bounded.channel.clone());
        let handle = match session.opendir(path.to_string()).await {
            Ok(handle) => handle.handle,
            Err(error) => {
                if !sftp_error_may_be_stale_transport(&error) {
                    read_guard.disarm();
                }
                return Err(error);
            }
        };
        let result = async {
            let mut entries = Vec::new();
            while entries.len() < max_entries {
                match session.readdir(handle.as_str()).await {
                    Ok(batch) => {
                        if batch.files.is_empty() {
                            break;
                        }
                        for entry in batch.files {
                            if entry.filename == "." || entry.filename == ".." {
                                continue;
                            }
                            entries.push(entry);
                            if entries.len() == max_entries {
                                break;
                            }
                        }
                    }
                    Err(SftpError::Status(status)) if status.status_code == SftpStatusCode::Eof => {
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(entries)
        }
        .await;
        let close = session.close(handle).await;
        match result {
            Err(error) if close.is_ok() => {
                read_guard.disarm();
                Err(error)
            }
            Err(error) => Err(error),
            Ok(entries) => {
                close?;
                read_guard.disarm();
                Ok(entries)
            }
        }
    }

    async fn bounded_sftp_generation_is_current(
        &self,
        connection_id: &str,
        session: &BoundedSftpSession,
    ) -> bool {
        self.connections
            .read()
            .await
            .get(connection_id)
            .is_some_and(|connection| Arc::ptr_eq(&connection.bounded_sftp_session, &session.cache))
    }

    async fn invalidate_bounded_sftp_generation(
        &self,
        connection_id: &str,
        failed: &BoundedSftpSession,
    ) {
        let guard = self.connections.read().await;
        let Some(connection) = guard.get(connection_id) else {
            return;
        };
        if !Arc::ptr_eq(&connection.bounded_sftp_session, &failed.cache) {
            return;
        }

        let mut cached = failed.cache.channel.write().await;
        if !cached
            .as_ref()
            .is_some_and(|channel| Arc::ptr_eq(channel, &failed.channel))
        {
            return;
        }
        *cached = None;
        connection.alive.store(false, Ordering::SeqCst);
    }

    /// Create directory via SFTP
    pub async fn sftp_mkdir(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.create_dir(&path)
            .await
            .map_err(|e| anyhow!("Failed to create directory '{}': {}", path, e))?;
        Ok(())
    }

    /// Create directory and all parents via SFTP
    pub async fn sftp_mkdir_all(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;

        // Check if path exists
        match sftp.as_ref().try_exists(&path).await {
            Ok(true) => return Ok(()), // Already exists
            Ok(false) => {}
            Err(_) => {}
        }

        for dir in sftp_mkdir_all_prefixes(&path) {
            if let Ok(true) = sftp.as_ref().try_exists(&dir).await {
                continue;
            }

            if let Err(error) = sftp.as_ref().create_dir(&dir).await {
                match sftp.as_ref().try_exists(&dir).await {
                    Ok(true) => continue,
                    Ok(false) | Err(_) => {
                        return Err(anyhow!("Failed to create directory '{}': {}", dir, error));
                    }
                }
            }
        }

        Ok(())
    }

    /// Remove file via SFTP
    pub async fn sftp_remove(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.remove_file(&path)
            .await
            .map_err(|e| anyhow!("Failed to remove file '{}': {}", path, e))?;
        Ok(())
    }

    /// Remove directory via SFTP
    pub async fn sftp_rmdir(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.remove_dir(&path)
            .await
            .map_err(|e| anyhow!("Failed to remove directory '{}': {}", path, e))?;
        Ok(())
    }

    /// Rename/move via SFTP
    pub async fn sftp_rename(
        &self,
        connection_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> anyhow::Result<()> {
        let old_path = self.resolve_sftp_path(connection_id, old_path).await?;
        let new_path = self.resolve_sftp_path(connection_id, new_path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.rename(&old_path, &new_path)
            .await
            .map_err(|e| anyhow!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))?;
        Ok(())
    }

    /// Check if path exists via SFTP
    pub async fn sftp_exists(&self, connection_id: &str, path: &str) -> anyhow::Result<bool> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.as_ref()
            .try_exists(&path)
            .await
            .map_err(|e| anyhow!("Failed to check if '{}' exists: {}", path, e))
    }

    /// Get file metadata via SFTP
    pub async fn sftp_stat(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<russh_sftp::client::fs::Metadata> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.as_ref().metadata(&path).await.map_err(|error| {
            let message = format!("Failed to stat '{}': {}", path, error);
            anyhow::Error::new(error).context(message)
        })
    }

    /// Get metadata for the exact SFTP path without following its final symlink.
    pub async fn sftp_lstat(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<russh_sftp::client::fs::Metadata> {
        let path = self.resolve_sftp_path(connection_id, path).await?;
        let sftp = self.get_sftp(connection_id).await?;
        sftp.as_ref()
            .symlink_metadata(&path)
            .await
            .map_err(anyhow::Error::new)
            .with_context(|| format!("Failed to inspect '{}'", path))
    }

    // ============================================================================
    // PTY (Interactive Terminal) Operations
    // ============================================================================

    /// Open a PTY session and start a shell
    pub async fn open_pty(
        &self,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> anyhow::Result<PTYSession> {
        let (handle, config) = {
            let guard = self.connections.read().await;
            let conn = guard
                .get(connection_id)
                .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;
            if !conn.alive.load(Ordering::SeqCst) {
                return Err(anyhow!("Connection {} is not alive", connection_id));
            }
            (
                conn.handle
                    .clone()
                    .ok_or_else(|| anyhow!("SSH handle is unavailable for {}", connection_id))?,
                conn.effective_config.clone(),
            )
        };

        // Open a session channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("Failed to open channel: {}", e))?;

        // Request PTY — `false` = don't wait for reply (reply handled in reader loop)
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| anyhow!("Failed to request PTY: {}", e))?;

        if config.uses_docker_exec() {
            let container = config
                .container
                .as_ref()
                .expect("docker exec connection must have container config");
            // `<shell> -lc <shell>` looks like a shell inside a shell, but the
            // outer one execs the inner as the final simple command of `-c`, so
            // one process ends up on the PTY — with the login profile already
            // sourced, which a bare `docker exec -it … sh` would skip.
            let command = docker_exec_host_command(container, &container.shell, true);
            channel
                .exec(false, command)
                .await
                .map_err(|e| anyhow!("Failed to start Docker container shell: {}", e))?;
        } else {
            // Start shell — `false` = don't wait for reply
            channel
                .request_shell(false)
                .await
                .map_err(|e| anyhow!("Failed to start shell: {}", e))?;
        }

        let still_connected = {
            let guard = self.connections.read().await;
            guard.get(connection_id).is_some_and(|conn| {
                conn.alive.load(Ordering::SeqCst)
                    && conn
                        .handle
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(active, &handle))
            })
        };
        if !still_connected {
            let _ = channel.eof().await;
            let _ = channel.close().await;
            return Err(anyhow!(
                "Connection {} disconnected while opening PTY",
                connection_id
            ));
        }

        Ok(PTYSession {
            channel: Arc::new(tokio::sync::Mutex::new(channel)),
            connection_id: connection_id.to_string(),
        })
    }

    /// Get server key fingerprint for verification
    pub async fn get_server_key_fingerprint(&self, connection_id: &str) -> anyhow::Result<String> {
        let guard = self.connections.read().await;
        let conn = guard
            .get(connection_id)
            .ok_or_else(|| anyhow!("Connection {} not found", connection_id))?;

        // Return a fingerprint based on connection info
        // Note: Actual server key fingerprint requires access to the SSH transport layer
        // For security verification, the server key is verified during connection via SSHHandler
        let fingerprint = format!(
            "{}:{}:{}",
            conn.config.host, conn.config.port, conn.config.username
        );
        Ok(fingerprint)
    }
}

/// PTY session for interactive terminal
#[derive(Clone)]
pub struct PTYSession {
    channel: Arc<tokio::sync::Mutex<russh::Channel<Msg>>>,
    connection_id: String,
}

impl PTYSession {
    /// Extract the inner Channel, consuming the Mutex wrapper.
    /// Only works if this is the sole Arc reference.
    /// Intended for use by RemoteTerminalManager to hand ownership to the owner task.
    pub async fn into_channel(self) -> Option<russh::Channel<Msg>> {
        match Arc::try_unwrap(self.channel) {
            Ok(mutex) => Some(mutex.into_inner()),
            Err(_) => None,
        }
    }
}

impl PTYSession {
    /// Write data to PTY
    pub async fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        let channel = self.channel.lock().await;
        channel
            .data(data)
            .await
            .map_err(|e| anyhow!("Failed to write to PTY: {}", e))?;
        Ok(())
    }

    /// Resize PTY
    pub async fn resize(&self, cols: u32, rows: u32) -> anyhow::Result<()> {
        let channel = self.channel.lock().await;
        // Use default pixel dimensions (80x24 characters)
        channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| anyhow!("Failed to resize PTY: {}", e))?;
        Ok(())
    }

    /// Read data from PTY.
    /// Blocks until data is available, PTY closes, or an error occurs.
    /// Returns Ok(Some(bytes)) for data, Ok(None) for clean close, Err for errors.
    pub async fn read(&self) -> anyhow::Result<Option<Vec<u8>>> {
        let mut channel = self.channel.lock().await;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => return Ok(Some(data.to_vec())),
                Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                    return Ok(Some(data.to_vec()));
                }
                Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => return Ok(None),
                Some(russh::ChannelMsg::ExitStatus { .. }) => return Ok(None),
                Some(_) => {
                    // WindowAdjust, Success, RequestSuccess, etc. — skip and keep reading
                    continue;
                }
                None => return Ok(None),
            }
        }
    }

    /// Close PTY session
    pub async fn close(self) -> anyhow::Result<()> {
        let channel = self.channel.lock().await;
        channel
            .eof()
            .await
            .map_err(|e| anyhow!("Failed to close PTY: {}", e))?;
        channel
            .close()
            .await
            .map_err(|e| anyhow!("Failed to close channel: {}", e))?;
        Ok(())
    }

    /// Get connection ID
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }
}

fn sftp_mkdir_all_prefixes(path: &str) -> Vec<String> {
    let is_absolute = path.starts_with('/');
    let mut current = String::new();
    let mut prefixes = Vec::new();

    for component in path.split('/').filter(|component| !component.is_empty()) {
        if current.is_empty() {
            if is_absolute {
                current.push('/');
            }
            current.push_str(component);
        } else {
            current.push('/');
            current.push_str(component);
        }
        prefixes.push(current.clone());
    }

    prefixes
}

#[cfg(test)]
mod tests {
    use super::*;

    mod workspace_sftp;

    #[test]
    fn sftp_requests_tolerate_a_slow_but_healthy_link() {
        let crate_default = russh_sftp::client::Config::default().request_timeout_secs;
        let configured = sftp_client_config().request_timeout_secs;
        assert_eq!(configured, SFTP_REQUEST_TIMEOUT_SECS);
        assert!(
            configured > crate_default,
            "the {crate_default}s dependency default is a throughput floor for one 256 KiB chunk"
        );
    }

    struct UnpublishedSessionTestServer {
        opens: usize,
        delayed_open: Option<usize>,
        requested: Option<tokio::sync::oneshot::Sender<()>>,
        release: Option<tokio::sync::oneshot::Receiver<()>>,
    }

    #[async_trait]
    impl russh::server::Handler for UnpublishedSessionTestServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            _session: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            self.opens += 1;
            if self.delayed_open == Some(self.opens) {
                let _ = self.requested.take().unwrap().send(());
                let _ = self.release.take().unwrap().await;
            }
            Ok(true)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            host: &str,
            port: u32,
            _originator_host: &str,
            _originator_port: u32,
            _session: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            let mut socket = tokio::net::TcpStream::connect((host, port as u16)).await?;
            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
            });
            Ok(true)
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            _command: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel);
            session.data(
                channel,
                russh::CryptoVec::from_slice(b"Linux\nfixture\n/workspace\n"),
            );
            session.exit_status_request(channel, 0);
            session.eof(channel);
            session.close(channel);
            Ok(())
        }
    }

    struct UnpublishedSessionFixture {
        config: SSHConnectionConfig,
        requested: tokio::sync::oneshot::Receiver<()>,
        release: tokio::sync::oneshot::Sender<()>,
        closed: tokio::sync::oneshot::Receiver<()>,
        server: tokio::task::JoinHandle<()>,
        proxy: tokio::task::JoinHandle<()>,
    }

    async fn unpublished_session_fixture(
        manager: &SSHConnectionManager,
        delayed_open: Option<usize>,
    ) -> UnpublishedSessionFixture {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = KeyPair::generate_ed25519().unwrap();
        manager
            .add_known_host(
                "127.0.0.1".into(),
                address.port(),
                &key.clone_public_key().unwrap(),
            )
            .await
            .unwrap();
        let (requested_tx, requested) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let (closed_tx, closed) = tokio::sync::oneshot::channel();
        let (server_stream, proxy_stream) = tokio::io::duplex(65_536);
        let server = tokio::spawn(async move {
            let handler = UnpublishedSessionTestServer {
                opens: 0,
                delayed_open,
                requested: Some(requested_tx),
                release: Some(release_rx),
            };
            let config = Arc::new(russh::server::Config {
                keys: vec![key],
                ..Default::default()
            });
            let session = russh::server::run_stream(config, server_stream, handler)
                .await
                .unwrap();
            let _ = session.await;
        });
        // Observe transport EOF independently of the server's deliberately
        // blocked channel-open handler. Merely releasing that handler would
        // let an orphaned owner finish and hide the lifetime regression.
        let proxy = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (mut socket_read, mut socket_write) = socket.into_split();
            let (mut server_read, mut server_write) = tokio::io::split(proxy_stream);
            let inbound = async move {
                let _ = tokio::io::copy(&mut socket_read, &mut server_write).await;
                let _ = closed_tx.send(());
                let _ = server_write.shutdown().await;
            };
            let outbound = async move {
                let _ = tokio::io::copy(&mut server_read, &mut socket_write).await;
                let _ = socket_write.shutdown().await;
            };
            tokio::join!(inbound, outbound);
        });
        UnpublishedSessionFixture {
            config: SSHConnectionConfig {
                id: format!("unpublished-{}", address.port()),
                name: "Unpublished SSH fixture".into(),
                host: "127.0.0.1".into(),
                port: address.port(),
                username: "workspace-test".into(),
                auth: SSHAuthMethod::Password {
                    password: "test-fixture".into(),
                },
                default_workspace: None,
                proxy_jump: None,
                container: None,
                wsl: None,
                options: Default::default(),
            },
            requested,
            release,
            closed,
            server,
            proxy,
        }
    }

    async fn finish_unpublished_fixture(fixture: UnpublishedSessionFixture) {
        let _ = fixture.release.send(());
        tokio::time::timeout(Duration::from_secs(5), fixture.server)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), fixture.proxy)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn workspace_unpublished_probe_error_closes_transport_before_late_confirmation() {
        let temp = tempfile::tempdir().unwrap();
        let manager = SSHConnectionManager::new(temp.path().into());
        // Metadata succeeds; the container probe's channel-open never replies.
        let mut fixture = unpublished_session_fixture(&manager, Some(2)).await;
        let mut config = fixture.config.clone();
        config.container = Some(ContainerWorkspaceConfig {
            name: "fixture".into(),
            access: ContainerAccess::DockerExec,
            local: false,
            docker_path: "docker".into(),
            shell: "/bin/sh".into(),
            user: None,
            interactive: true,
        });
        let caller = tokio::spawn(async move { manager.establish_session(&config, 1).await });
        tokio::time::timeout(Duration::from_secs(5), &mut fixture.requested)
            .await
            .unwrap()
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(6), caller)
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.is_err(),
            "the failed container probe must not publish a connection"
        );
        tokio::time::timeout(Duration::from_secs(3), &mut fixture.closed)
            .await
            .expect("failed temporary transport must close before the late open is released")
            .unwrap();
        finish_unpublished_fixture(fixture).await;
    }

    #[tokio::test]
    async fn workspace_unpublished_caller_drop_closes_target_and_jump_chain() {
        let temp = tempfile::tempdir().unwrap();
        let manager = SSHConnectionManager::new(temp.path().into());
        let mut first = unpublished_session_fixture(&manager, None).await;
        let mut second = unpublished_session_fixture(&manager, None).await;
        let mut target = unpublished_session_fixture(&manager, Some(1)).await;
        let mut config = target.config.clone();
        config.proxy_jump = Some(format!(
            "workspace-test@127.0.0.1:{},workspace-test@127.0.0.1:{}",
            first.config.port, second.config.port,
        ));
        let caller = tokio::spawn(async move { manager.establish_session(&config, 30).await });
        tokio::time::timeout(Duration::from_secs(10), &mut target.requested)
            .await
            .unwrap()
            .unwrap();
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
        for closed in [&mut target.closed, &mut second.closed, &mut first.closed] {
            tokio::time::timeout(Duration::from_secs(5), closed)
                .await
                .expect("cancelling an unpublished chain must close target and every jump")
                .unwrap();
        }
        finish_unpublished_fixture(target).await;
        finish_unpublished_fixture(second).await;
        finish_unpublished_fixture(first).await;
    }

    #[tokio::test]
    async fn workspace_unpublished_guard_is_disarmed_after_publication() {
        let temp = tempfile::tempdir().unwrap();
        let manager = SSHConnectionManager::new(temp.path().into());
        let mut fixture = unpublished_session_fixture(&manager, None).await;
        let id = fixture.config.id.clone();
        assert!(
            manager
                .connect_with_timeout(fixture.config.clone(), 2)
                .await
                .unwrap()
                .success
        );
        let result = manager
            .execute_command_with_options(
                &id,
                "published command",
                SSHCommandOptions {
                    timeout_ms: Some(2_000),
                    cancellation_token: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("/workspace"));
        assert!(matches!(
            fixture.closed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        manager.disconnect(&id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), &mut fixture.closed)
            .await
            .unwrap()
            .unwrap();
        finish_unpublished_fixture(fixture).await;
    }

    #[tokio::test]
    async fn workspace_command_owner_survives_caller_drop_until_cleanup_finishes() {
        let parent = tokio_util::sync::CancellationToken::new();
        let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let resource_dropped = Arc::new(AtomicBool::new(false));
        struct CommandResource(Arc<AtomicBool>);
        impl Drop for CommandResource {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let (finish_cleanup_tx, finish_cleanup_rx) = tokio::sync::oneshot::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let observed_executions = executions.clone();
        let observed_resource = resource_dropped.clone();
        let options = SSHCommandOptions {
            timeout_ms: None,
            cancellation_token: Some(parent.clone()),
        };
        let caller = tokio::spawn(supervise_ssh_command(options, move |options| async move {
            let resource = CommandResource(observed_resource);
            observed_executions.fetch_add(1, Ordering::SeqCst);
            started_tx.send(()).unwrap();
            options.cancellation_token.unwrap().cancelled().await;
            cancelled_tx.send(()).unwrap();
            // Model asynchronous INT/drain/close work that must remain owned
            // after the caller's timeout drops its future.
            finish_cleanup_rx.await.unwrap();
            drop(resource);
            finished_tx.send(()).unwrap();
            Ok(SshCommandStop::Cancelled.output())
        }));
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), cancelled_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(!resource_dropped.load(Ordering::SeqCst));
        assert!(
            !parent.is_cancelled(),
            "a cancelled command must not cancel sibling commands or its turn"
        );
        finish_cleanup_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), finished_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(resource_dropped.load(Ordering::SeqCst));
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn workspace_command_owner_observes_parent_cancellation_and_preserves_results() {
        let parent = tokio_util::sync::CancellationToken::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let options = SSHCommandOptions {
            timeout_ms: Some(1234),
            cancellation_token: Some(parent.clone()),
        };
        let caller = tokio::spawn(supervise_ssh_command(options, move |options| async move {
            assert_eq!(options.timeout_ms, Some(1234));
            started_tx.send(()).unwrap();
            options.cancellation_token.unwrap().cancelled().await;
            let mut result = SshCommandStop::Cancelled.result();
            result.stdout = "partial output".into();
            result.stderr = "interrupted by caller".into();
            Ok(SshCommandOutput {
                result,
                exit_status_received: false,
            })
        }));
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        parent.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), caller)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.interrupted);
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, 130);
        assert_eq!(result.stdout, "partial output");
        assert_eq!(result.stderr, "interrupted by caller");
    }

    #[tokio::test]
    async fn workspace_command_owner_keeps_normal_and_unlimited_call_behavior() {
        let result = supervise_ssh_command(SSHCommandOptions::default(), |options| async move {
            assert!(options.timeout_ms.is_none());
            assert!(!options.cancellation_token.unwrap().is_cancelled());
            Ok(SshCommandOutput {
                result: SSHCommandResult {
                    stdout: "done".into(),
                    stderr: "diagnostic".into(),
                    exit_code: 7,
                    interrupted: false,
                    timed_out: false,
                },
                exit_status_received: true,
            })
        })
        .await
        .unwrap();
        assert_eq!(result.exit_code, 7);
        assert_eq!(result.stdout, "done");
        assert_eq!(result.stderr, "diagnostic");
        assert!(!result.interrupted && !result.timed_out);
        let error = supervise_ssh_command(SSHCommandOptions::default(), |_| async {
            Err(anyhow!("transport disconnected"))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("transport disconnected"));
    }

    #[tokio::test]
    async fn workspace_command_deadline_cancels_owner_immediately_and_keeps_timeout_reason() {
        let started_at = Instant::now();
        let result = supervise_ssh_command(
            SSHCommandOptions {
                timeout_ms: Some(30),
                cancellation_token: None,
            },
            |options| async move {
                tokio::time::timeout(
                    Duration::from_millis(500),
                    options.cancellation_token.unwrap().cancelled(),
                )
                .await
                .expect("deadline must cancel before the owner-drain grace expires");
                let mut result = SshCommandStop::Cancelled.result();
                result.stdout = "partial output".into();
                Ok(SshCommandOutput {
                    result,
                    exit_status_received: false,
                })
            },
        )
        .await
        .unwrap();
        assert!(started_at.elapsed() < SSH_COMMAND_OWNER_DRAIN_GRACE);
        assert_eq!(result.stdout, "partial output");
        assert_eq!(result.exit_code, 124);
        assert!(result.timed_out);
        assert!(!result.interrupted);
    }

    #[tokio::test]
    async fn workspace_command_supervisor_preserves_real_exit_codes_when_stopped() {
        for stop in [SshCommandStop::Cancelled, SshCommandStop::TimedOut] {
            for exit_code in [-1, 124, 130] {
                let cancellation = tokio_util::sync::CancellationToken::new();
                let (started_tx, started_rx) = tokio::sync::oneshot::channel();
                let caller = tokio::spawn(supervise_ssh_command(
                    SSHCommandOptions {
                        timeout_ms: (stop == SshCommandStop::TimedOut).then_some(30),
                        cancellation_token: Some(cancellation.clone()),
                    },
                    move |options| async move {
                        let _ = started_tx.send(());
                        options.cancellation_token.unwrap().cancelled().await;
                        Ok(SshCommandOutput {
                            result: SSHCommandResult {
                                stdout: "partial output".into(),
                                stderr: String::new(),
                                exit_code,
                                interrupted: true,
                                timed_out: false,
                            },
                            exit_status_received: true,
                        })
                    },
                ));
                started_rx.await.unwrap();
                if stop == SshCommandStop::Cancelled {
                    cancellation.cancel();
                }
                let result = tokio::time::timeout(Duration::from_secs(2), caller)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert_eq!(result.exit_code, exit_code);
                assert_eq!(result.stdout, "partial output");
                assert_eq!(result.interrupted, stop == SshCommandStop::Cancelled);
                assert_eq!(result.timed_out, stop == SshCommandStop::TimedOut);
            }
        }
    }

    #[tokio::test]
    async fn workspace_command_phase_honors_stop_before_polling_or_while_pending() {
        let cancelled = tokio_util::sync::CancellationToken::new();
        cancelled.cancel();
        let mut polled = false;
        let outcome = await_ssh_command_phase(
            std::future::poll_fn(|_| {
                polled = true;
                std::task::Poll::Ready(())
            }),
            Some(&cancelled),
            None,
        )
        .await;
        assert_eq!(outcome, Err(SshCommandStop::Cancelled));
        assert!(
            !polled,
            "a pre-cancelled command must not open a channel or submit exec"
        );
        let outcome = await_ssh_command_phase(
            std::future::pending::<()>(),
            None,
            Some(Instant::now() + Duration::from_millis(1)),
        )
        .await;
        assert_eq!(outcome, Err(SshCommandStop::TimedOut));
        let outcome = await_ssh_command_phase(std::future::ready(17), None, None).await;
        assert_eq!(outcome, Ok(17));

        let token = tokio_util::sync::CancellationToken::new();
        let worker_token = token.clone();
        let (pending_tx, pending_rx) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            await_ssh_command_phase(
                async {
                    pending_tx.send(()).unwrap();
                    std::future::pending::<()>().await
                },
                Some(&worker_token),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), pending_rx)
            .await
            .unwrap()
            .unwrap();
        token.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), worker)
                .await
                .unwrap()
                .unwrap(),
            Err(SshCommandStop::Cancelled)
        );
    }

    struct DelayedWorkspaceOpenServer {
        first_open: Option<(
            tokio::sync::oneshot::Sender<russh::ChannelId>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
        closed: tokio::sync::mpsc::UnboundedSender<russh::ChannelId>,
        executions: Arc<std::sync::atomic::AtomicUsize>,
        keep_exec_open: bool,
    }

    #[async_trait]
    impl russh::server::Handler for DelayedWorkspaceOpenServer {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            _session: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            if let Some((requested, release)) = self.first_open.take() {
                requested.send(channel.id()).unwrap();
                release.await.unwrap();
            }
            Ok(true)
        }

        async fn channel_close(
            &mut self,
            channel: russh::ChannelId,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let _ = self.closed.send(channel);
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            _data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.executions.fetch_add(1, Ordering::SeqCst);
            session.channel_success(channel);
            if self.keep_exec_open {
                return Ok(());
            }
            session.data(
                channel,
                russh::CryptoVec::from_slice(b"sibling command output"),
            );
            session.exit_status_request(channel, 0);
            session.eof(channel);
            session.close(channel);
            Ok(())
        }
    }

    async fn assert_workspace_late_open_is_closed(stop: SshCommandStop, docker_setup: bool) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requested_tx, requested_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (closed_tx, mut closed_rx) = tokio::sync::mpsc::unbounded_channel();
        let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = DelayedWorkspaceOpenServer {
            first_open: Some((requested_tx, release_rx)),
            closed: closed_tx,
            executions: executions.clone(),
            keep_exec_open: false,
        };
        let server_config = Arc::new(russh::server::Config {
            keys: vec![KeyPair::generate_ed25519().unwrap()],
            ..Default::default()
        });
        let server_task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            russh::server::run_stream(server_config, socket, server)
                .await
                .unwrap()
                .await
        });
        let mut handle = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            address,
            SSHHandler::with_verify_callback(|_, _, _| true),
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("workspace-test").await.unwrap());
        let handle = Arc::new(handle);
        let cancellation = tokio_util::sync::CancellationToken::new();
        let options = SSHCommandOptions {
            timeout_ms: (stop == SshCommandStop::TimedOut).then_some(1_000),
            cancellation_token: Some(cancellation.clone()),
        };
        let owner_handle = handle.clone();
        let fixture = tempfile::tempdir().unwrap();
        let caller = if docker_setup {
            let manager = SSHConnectionManager::new(fixture.path().into());
            let config = SSHConnectionConfig {
                id: "workspace-late-open".into(),
                name: "loopback SSH fixture".into(),
                host: "127.0.0.1".into(),
                port: address.port(),
                username: "workspace-test".into(),
                auth: SSHAuthMethod::Agent {
                    key_fingerprint: None,
                    fallback_key_path: None,
                },
                default_workspace: None,
                proxy_jump: None,
                container: Some(ContainerWorkspaceConfig {
                    name: "fixture".into(),
                    access: ContainerAccess::DockerExec,
                    local: false,
                    docker_path: "docker".into(),
                    shell: "/bin/sh".into(),
                    user: None,
                    interactive: true,
                }),
                wsl: None,
                options: Default::default(),
            };
            manager.connections.write().await.insert(
                config.id.clone(),
                ActiveConnection {
                    handle: Some(owner_handle),
                    jump_handles: Vec::new(),
                    config: config.clone(),
                    effective_config: config,
                    server_info: None,
                    sftp_session: Arc::new(SftpCache::new()),
                    bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                    server_key: None,
                    alive: Arc::new(AtomicBool::new(true)),
                },
            );
            tokio::spawn(async move {
                manager
                    .execute_command_with_options(
                        "workspace-late-open",
                        "must never execute",
                        options,
                    )
                    .await
            })
        } else {
            // Exercise the formerly unsupervised internal entry directly.
            tokio::spawn(async move {
                SSHConnectionManager::execute_command_internal(
                    &owner_handle,
                    "must never execute",
                    options,
                )
                .await
            })
        };
        let late_channel = tokio::time::timeout(Duration::from_secs(5), requested_rx)
            .await
            .unwrap()
            .unwrap();
        let confirmation_delayed_at = Instant::now();
        if stop == SshCommandStop::Cancelled {
            cancellation.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(8), caller)
            .await
            .expect("caller must finish without waiting for channel-open confirmation")
            .unwrap()
            .unwrap();
        assert_eq!(result.exit_code, stop.result().exit_code);
        assert_eq!(result.interrupted, stop == SshCommandStop::Cancelled);
        assert_eq!(result.timed_out, stop == SshCommandStop::TimedOut);
        assert!(confirmation_delayed_at.elapsed() >= SSH_COMMAND_INTERRUPT_DRAIN_GRACE);
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        // Confirmation arrives only after the caller has returned, beyond the
        // old 500ms cleanup window. The detached owner must still send CLOSE.
        release_tx.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), closed_rx.recv())
                .await
                .expect("late confirmation must be closed rather than orphaned"),
            Some(late_channel)
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);
        assert!(
            !handle.is_closed(),
            "cleanup must preserve the shared connection"
        );

        let sibling_handle = handle.clone();
        let sibling = SSHConnectionManager::execute_command_internal(
            &sibling_handle,
            "sibling command",
            SSHCommandOptions {
                timeout_ms: Some(2_000),
                cancellation_token: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(sibling.exit_code, 0);
        assert_eq!(sibling.stdout, "sibling command output");
        assert!(!sibling.interrupted && !sibling.timed_out);
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        handle
            .disconnect(russh::Disconnect::ByApplication, "test finished", "")
            .await
            .unwrap();
        let server_result = tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .expect("test transport must close")
            .unwrap();
        assert_fixture_server_disconnected(server_result);
    }

    #[tokio::test]
    async fn workspace_command_cancel_closes_late_confirmation_without_executing() {
        assert_workspace_late_open_is_closed(SshCommandStop::Cancelled, false).await;
    }

    #[tokio::test]
    async fn workspace_command_timeout_closes_late_confirmation_without_executing() {
        assert_workspace_late_open_is_closed(SshCommandStop::TimedOut, false).await;
    }

    #[tokio::test]
    async fn workspace_docker_setup_cancel_closes_late_confirmation_without_executing() {
        assert_workspace_late_open_is_closed(SshCommandStop::Cancelled, true).await;
    }

    #[tokio::test]
    async fn workspace_docker_setup_timeout_closes_late_confirmation_without_executing() {
        assert_workspace_late_open_is_closed(SshCommandStop::TimedOut, true).await;
    }

    #[tokio::test]
    async fn workspace_exec_channel_closes_when_completed_handoff_is_not_consumed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed_tx, mut closed_rx) = tokio::sync::mpsc::unbounded_channel();
        let server = DelayedWorkspaceOpenServer {
            first_open: None,
            closed: closed_tx,
            executions: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            keep_exec_open: true,
        };
        let server_config = Arc::new(russh::server::Config {
            keys: vec![KeyPair::generate_ed25519().unwrap()],
            ..Default::default()
        });
        let server_task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            russh::server::run_stream(server_config, socket, server)
                .await
                .unwrap()
                .await
        });
        let mut handle = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            address,
            SSHHandler::with_verify_callback(|_, _, _| true),
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("workspace-test").await.unwrap());
        let handle = Arc::new(handle);
        let owner_handle = handle.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut caller = Box::pin(supervise_ssh_owner(
            SSHCommandOptions::default(),
            move |options| async move {
                let channel = SSHConnectionManager::open_ssh_exec_channel_owned(
                    &owner_handle,
                    "hold open",
                    options,
                    None,
                )
                .await
                .unwrap();
                let handoff = SshExecChannelHandoff::new(channel);
                ready_tx
                    .send(handoff.channel.as_ref().unwrap().id())
                    .unwrap();
                handoff
            },
        ));
        // Start the owner, but never poll the supervisor again to consume its
        // result. On this current-thread runtime, the owner completes in the
        // same poll that sends ready_tx, before this test resumes.
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(caller.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let channel_id = tokio::time::timeout(Duration::from_secs(5), ready_rx)
            .await
            .unwrap()
            .unwrap();
        drop(caller);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), closed_rx.recv())
                .await
                .unwrap(),
            Some(channel_id)
        );
        assert!(
            !handle.is_closed(),
            "abandoning one handoff must not disconnect siblings"
        );
        handle
            .disconnect(russh::Disconnect::ByApplication, "fixture complete", "en")
            .await
            .unwrap();
        let server_result = tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();
        assert_fixture_server_disconnected(server_result);
    }

    fn assert_fixture_server_disconnected(result: Result<(), russh::Error>) {
        // Only used after the assertions and an explicit client disconnect.
        // russh may observe the closing transport before the disconnect frame;
        // Darwin reports that race as ConnectionReset instead of UnexpectedEof.
        match result {
            Ok(()) => {}
            Err(russh::Error::IO(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
                ) => {}
            Err(error) => panic!("SSH fixture failed during disconnect: {error:?}"),
        }
    }

    #[cfg(unix)]
    async fn shell_workspace_provider_fixture(
        root: &std::path::Path,
    ) -> (SSHConnectionManager, crate::remote_ssh::RemoteWorkspaceFs) {
        use std::os::unix::fs::PermissionsExt;
        // Execute the actual Docker command adapter against a local POSIX shell.
        // This covers the shell/stream protocol, not an installed Docker daemon.
        let executable = root.join("docker shell fixture");
        std::fs::write(&executable, "#!/bin/sh\ncase \"$1\" in\ninspect) printf true;;\nexec) shift; [ \"$1\" != -i ] || shift; [ \"$1\" = fixture ] || exit 90; shift; exec \"$@\";;\n*) exit 91;;\nesac\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = SSHConnectionConfig {
            id: "workspace-shell-fixture".into(),
            name: "Workspace shell fixture".into(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: SSHAuthMethod::Agent {
                key_fingerprint: None,
                fallback_key_path: None,
            },
            default_workspace: None,
            proxy_jump: None,
            container: Some(ContainerWorkspaceConfig {
                name: "fixture".into(),
                access: ContainerAccess::DockerExec,
                local: true,
                docker_path: executable.to_string_lossy().into_owned(),
                shell: "/bin/sh".into(),
                user: None,
                interactive: true,
            }),
            wsl: None,
            options: Default::default(),
        };
        let manager = SSHConnectionManager::new(root.join("manager-data"));
        manager.connections.write().await.insert(
            config.id.clone(),
            ActiveConnection {
                handle: None,
                jump_handles: Vec::new(),
                config: config.clone(),
                effective_config: config,
                server_info: None,
                sftp_session: Arc::new(SftpCache::new()),
                bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                server_key: None,
                alive: Arc::new(AtomicBool::new(true)),
            },
        );
        let file_service = crate::remote_ssh::RemoteFileService::new(Arc::new(
            tokio::sync::RwLock::new(Some(manager.clone())),
        ));
        let provider = crate::remote_ssh::RemoteWorkspaceFs::new(
            "workspace-shell-fixture".into(),
            file_service,
        );
        (manager, provider)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_metadata_preserves_errors_and_follows_links() {
        use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspacePathKind};
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let (_manager, provider) = shell_workspace_provider_fixture(temp.path()).await;
        let target = temp.path().join("target");
        let file_link = temp.path().join("file-link");
        let directory = temp.path().join("directory");
        let directory_link = temp.path().join("directory-link");
        let dangling = temp.path().join("dangling");
        std::fs::write(&target, b"target").unwrap();
        std::fs::create_dir(&directory).unwrap();
        symlink(&target, &file_link).unwrap();
        symlink(&directory, &directory_link).unwrap();
        symlink(temp.path().join("missing"), &dangling).unwrap();
        assert!(provider.is_file(file_link.to_str().unwrap()).await.unwrap());
        assert!(provider
            .is_dir(directory_link.to_str().unwrap())
            .await
            .unwrap());
        assert_eq!(
            provider
                .path_kind_no_follow(file_link.to_str().unwrap())
                .await
                .unwrap(),
            Some(WorkspacePathKind::Symlink)
        );
        assert_eq!(
            provider
                .path_kind_no_follow(dangling.to_str().unwrap())
                .await
                .unwrap(),
            Some(WorkspacePathKind::Symlink)
        );
        assert!(!provider.exists(dangling.to_str().unwrap()).await.unwrap());
        // readlink emits its own final newline. Removing it must preserve all
        // whitespace that belongs to the link target, including trailing LF.
        let unusual_name = "missing ' target\\name \n\n";
        std::fs::write(temp.path().join(unusual_name.trim_end()), b"wrong target").unwrap();
        std::fs::write(
            temp.path().join(unusual_name.trim_end_matches('\n')),
            b"wrong newline target",
        )
        .unwrap();
        let unusual_link = temp.path().join("unusual-target-link");
        symlink(unusual_name, &unusual_link).unwrap();
        let chained_link = temp.path().join("chained-link");
        symlink("unusual-target-link", &chained_link).unwrap();
        assert!(!provider
            .exists(unusual_link.to_str().unwrap())
            .await
            .unwrap());
        assert!(!provider
            .exists(chained_link.to_str().unwrap())
            .await
            .unwrap());
        let loop_link = temp.path().join("loop-link");
        symlink(&loop_link, &loop_link).unwrap();
        assert!(provider.exists(loop_link.to_str().unwrap()).await.is_err());
        assert_eq!(
            provider
                .path_kind_no_follow(loop_link.to_str().unwrap())
                .await
                .unwrap(),
            Some(WorkspacePathKind::Symlink)
        );
        assert!(!provider
            .exists(temp.path().join("missing").to_str().unwrap())
            .await
            .unwrap());
        let invalid_parent = target.join("child").to_string_lossy().into_owned();
        assert!(provider.exists(&invalid_parent).await.is_err());
        assert!(provider.is_file(&invalid_parent).await.is_err());
        assert!(provider.is_dir(&invalid_parent).await.is_err());
        assert!(provider.path_kind_no_follow(&invalid_parent).await.is_err());

        let denied = directory.join("hidden");
        let denied_link = temp.path().join("denied-link");
        std::fs::write(&denied, b"hidden").unwrap();
        symlink(&denied, &denied_link).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root CI runners can bypass POSIX mode checks; the invalid-parent
        // assertions above still require error preservation on every runner.
        let access_denied = std::fs::metadata(&denied).is_err();
        let exists = provider.exists(denied.to_str().unwrap()).await;
        let kind = provider.path_kind_no_follow(denied.to_str().unwrap()).await;
        let linked_exists = provider.exists(denied_link.to_str().unwrap()).await;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        if access_denied {
            assert!(
                exists.is_err(),
                "permission failures must not become absent files"
            );
            assert!(
                kind.is_err(),
                "no-follow metadata must preserve permission failures"
            );
            assert!(
                linked_exists.is_err(),
                "a link to an inaccessible target must not look absent"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_write_preserves_inode_links_and_modes_without_changing_uploads() {
        use openbitfun_runtime_ports::WorkspaceFileSystem;
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let (manager, provider) = shell_workspace_provider_fixture(temp.path()).await;
        let target = temp.path().join("target");
        let link = temp.path().join("link ' with\\name\nline");
        let hardlink = temp.path().join("hardlink");
        std::fs::write(&target, b"original").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751)).unwrap();
        symlink(&target, &link).unwrap();
        std::fs::hard_link(&target, &hardlink).unwrap();
        let before = std::fs::metadata(&target).unwrap();
        provider
            .write_file(link.to_str().unwrap(), b"replacement\0bytes")
            .await
            .unwrap();
        let after = std::fs::metadata(&target).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(after.permissions().mode() & 0o7777, 0o751);
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"replacement\0bytes");
        assert_eq!(std::fs::read(&hardlink).unwrap(), b"replacement\0bytes");
        provider
            .write_file(target.to_str().unwrap(), b"")
            .await
            .unwrap();
        assert_eq!(std::fs::metadata(&target).unwrap().ino(), before.ino());
        assert!(std::fs::read(&target).unwrap().is_empty());
        let created = temp.path().join("nested/new file");
        provider
            .write_file(created.to_str().unwrap(), b"new file")
            .await
            .unwrap();
        assert_eq!(std::fs::read(&created).unwrap(), b"new file");

        // The independent upload contract continues replacing its destination.
        manager
            .container_write_file(
                "workspace-shell-fixture",
                link.to_str().unwrap(),
                b"uploaded",
            )
            .await
            .unwrap();
        assert!(!std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&link).unwrap(), b"uploaded");
        assert!(std::fs::read(&target).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_write_rejects_incomplete_transfer_before_touching_target() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let staged = temp.path().join(".openbitfun-upload-test.tmp");
        std::fs::write(&target, b"preserved").unwrap();
        let command = container_workspace_write_command(
            target.to_str().unwrap(),
            staged.to_str().unwrap(),
            100,
        );
        let transport =
            crate::remote_ssh::WorkspaceStdio::spawn_local_process("sh", &["-c".into(), command])
                .unwrap();
        let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
        stdin.write_all(b"incomplete").await.unwrap();
        stdin.shutdown().await.unwrap();
        let mut output = Vec::new();
        let mut diagnostics = String::new();
        stdout.read_to_end(&mut output).await.unwrap();
        stderr.read_to_string(&mut diagnostics).await.unwrap();
        assert_eq!(completion.wait().await.exit_code, Some(65));
        assert!(diagnostics.contains("incomplete"));
        assert_eq!(std::fs::read(&target).unwrap(), b"preserved");
        assert!(!staged.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_streams_a_local_file_and_keeps_the_destination_on_cancel() {
        let temp = tempfile::tempdir().unwrap();
        let (manager, _provider) = shell_workspace_provider_fixture(temp.path()).await;
        let source = temp.path().join("source file.bin");
        let target = temp.path().join("target.bin");
        let payload = vec![7_u8; 700_000];
        std::fs::write(&source, &payload).unwrap();
        std::fs::write(&target, b"preserved").unwrap();

        let mut progress = Vec::new();
        let written = manager
            .container_write_file_from_path_with_progress(
                "workspace-shell-fixture",
                target.to_str().unwrap(),
                &source,
                &mut |written, total| {
                    progress.push((written, total));
                    true
                },
            )
            .await
            .unwrap();
        assert_eq!(written, payload.len() as u64);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            payload,
            "a completed stream must replace the destination with the local file"
        );
        assert_eq!(progress.first(), Some(&(0, payload.len() as u64)));
        assert_eq!(
            progress.last(),
            Some(&(payload.len() as u64, payload.len() as u64))
        );
        assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));

        // The staging command publishes through a rename, so a cancelled
        // stream must leave the previously committed destination untouched.
        let cancelled = manager
            .container_write_file_from_path_with_progress(
                "workspace-shell-fixture",
                target.to_str().unwrap(),
                &source,
                &mut |written, _| written < 262_144,
            )
            .await;
        assert!(cancelled.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), payload);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_write_stops_after_signal_between_staging_and_commit() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let staged = temp.path().join(".openbitfun-upload-test.tmp");
        let wc = temp.path().join("wc");
        std::fs::write(&target, b"preserved").unwrap();
        // wc is called only after staging is complete. Signal the writing
        // shell while it waits for this successful size-check subprocess;
        // the trap must exit instead of proceeding into target redirection.
        std::fs::write(
            &wc,
            "#!/bin/sh\ncat >/dev/null\nkill -TERM \"$OPENBITFUN_TEST_WRITE_PID\"\nprintf '8\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&wc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            temp.path().display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let command = format!(
            "OPENBITFUN_TEST_WRITE_PID=$$; export OPENBITFUN_TEST_WRITE_PID; PATH={}; export PATH; {}",
            crate::remote_ssh::shell::quote_arg(&path),
            container_workspace_write_command(
                target.to_str().unwrap(),
                staged.to_str().unwrap(),
                8
            )
        );
        let transport =
            crate::remote_ssh::WorkspaceStdio::spawn_local_process("sh", &["-c".into(), command])
                .unwrap();
        let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
        stdin.write_all(b"modified").await.unwrap();
        stdin.shutdown().await.unwrap();
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        stdout.read_to_end(&mut output).await.unwrap();
        stderr.read_to_end(&mut diagnostics).await.unwrap();
        assert_eq!(completion.wait().await.exit_code, Some(143));
        assert_eq!(std::fs::read(&target).unwrap(), b"preserved");
        assert!(!staged.exists());
    }

    #[test]
    fn workspace_metadata_parses_permissions_and_rejects_malformed_stat() {
        use openbitfun_runtime_ports::WorkspacePathKind;
        let gnu = parse_workspace_stat_output("hex 81a4 7 1700000000 644\n").unwrap();
        let bsd = parse_workspace_stat_output("oct 100644 7 1700000000 644\n").unwrap();
        assert_eq!(gnu, bsd);
        assert_eq!(gnu.kind, WorkspacePathKind::File);
        assert_eq!(gnu.size, Some(7));
        assert_eq!(gnu.permissions, Some(0o644));
        assert!(gnu.modified.is_some());
        assert_eq!(
            parse_workspace_stat_output("oct 120777 7 -1 777")
                .unwrap()
                .kind,
            WorkspacePathKind::Symlink
        );
        assert!(parse_workspace_stat_output("hex 81a4 7 unknown 644").is_err());
        assert!(parse_workspace_stat_output("").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_reader_streams_bytes_and_checks_exit_status() {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let transport = crate::remote_ssh::WorkspaceStdio::spawn_local_process(
            "sh",
            &["-c".to_string(), "printf 'a\\000b'".to_string()],
        )
        .unwrap();
        let mut reader = ContainerFileReader::from_transport(transport);
        let seek_error = reader.seek(std::io::SeekFrom::Start(0)).await.unwrap_err();
        assert_eq!(seek_error.kind(), std::io::ErrorKind::Unsupported);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"a\0b");

        let transport = crate::remote_ssh::WorkspaceStdio::spawn_local_process(
            "sh",
            &[
                "-c".to_string(),
                "printf partial; printf denied >&2; exit 13".to_string(),
            ],
        )
        .unwrap();
        let mut reader = ContainerFileReader::from_transport(transport);
        let mut bytes = Vec::new();
        let error = reader.read_to_end(&mut bytes).await.unwrap_err();
        assert_eq!(bytes, b"partial");
        assert!(error.to_string().contains("Some(13)"), "{error}");
        assert!(error.to_string().contains("denied"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_container_reader_drop_cancels_backpressured_child() {
        let transport = crate::remote_ssh::WorkspaceStdio::spawn_local_process(
            "sh",
            &[
                "-c".to_string(),
                "while :; do printf 'stream content\\n'; done".to_string(),
            ],
        )
        .unwrap();
        let reader = ContainerFileReader::from_transport(transport);
        let completion = reader.completion.clone();
        drop(reader);
        tokio::time::timeout(Duration::from_secs(5), completion.wait())
            .await
            .expect("dropping reader must release all streams and stop the child");
    }
    use crate::remote_ssh::types::RemoteWorkspace;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    #[cfg(feature = "ssh_config")]
    fn ssh_config_fallback_accepts_utf8_bom_and_defaults_to_agent() {
        let content = strip_utf8_bom(
            "\u{feff}Host 跳板\n  HostName jump.example.com\n  User 构建\n".to_string(),
        );
        let entries = parse_ssh_config_manually(&content);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "跳板");
        assert_eq!(entries[0].user.as_deref(), Some("构建"));
        assert_eq!(entries[0].agent, Some(true));
    }

    fn test_data_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openbitfun-remote-ssh-manager-{}-{}-{}",
            name,
            std::process::id(),
            nanos
        ))
    }

    #[tokio::test]
    async fn explicit_connect_reuses_a_matching_live_connection() {
        let manager = SSHConnectionManager::new(test_data_dir("connect-idempotent"));
        let config = SSHConnectionConfig {
            id: "ssh-root@example.com".to_string(),
            name: "example".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "root".to_string(),
            auth: SSHAuthMethod::PrivateKey {
                key_path: "/tmp/id_rsa".to_string(),
                passphrase: None,
                certificate_path: None,
            },
            default_workspace: Some("/srv/project".to_string()),
            proxy_jump: None,
            container: None,
            wsl: None,
            options: Default::default(),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let server_info = ServerInfo {
            os_type: "Linux".to_string(),
            hostname: "example".to_string(),
            home_dir: "/root".to_string(),
        };
        manager.connections.write().await.insert(
            config.id.clone(),
            ActiveConnection {
                handle: None,
                jump_handles: Vec::new(),
                config: config.clone(),
                effective_config: config.clone(),
                server_info: Some(server_info.clone()),
                sftp_session: Arc::new(SftpCache::new()),
                bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                server_key: None,
                alive: alive.clone(),
            },
        );

        let result = manager
            .connect_with_timeout(config.clone(), 1)
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(result.connection_id.as_deref(), Some(config.id.as_str()));
        assert_eq!(
            result
                .server_info
                .as_ref()
                .map(|info| info.hostname.as_str()),
            Some(server_info.hostname.as_str())
        );
        let guard = manager.connections.read().await;
        let active = guard.get(&config.id).unwrap();
        assert!(Arc::ptr_eq(&active.alive, &alive));
    }

    #[test]
    fn parses_proxy_jump_alias_user_port_and_ipv6() {
        assert_eq!(
            parse_proxy_jump_token("jump-a").unwrap(),
            (None, "jump-a".to_string(), None)
        );
        assert_eq!(
            parse_proxy_jump_token("ops@jump.example:2222").unwrap(),
            (
                Some("ops".to_string()),
                "jump.example".to_string(),
                Some(2222)
            )
        );
        assert_eq!(
            parse_proxy_jump_token("root@[2001:db8::10]:2200").unwrap(),
            (
                Some("root".to_string()),
                "2001:db8::10".to_string(),
                Some(2200)
            )
        );
    }

    #[test]
    fn parses_docker_published_ipv4_and_ipv6_endpoints() {
        assert_eq!(
            parse_docker_published_endpoint("0.0.0.0:22022\n[::]:22022\n"),
            Some(("127.0.0.1".to_string(), 22022))
        );
        assert_eq!(
            parse_docker_published_endpoint("192.168.50.2:22023\n"),
            Some(("192.168.50.2".to_string(), 22023))
        );
        assert_eq!(
            parse_docker_published_endpoint("[fd00::10]:22024\n"),
            Some(("fd00::10".to_string(), 22024))
        );
    }

    #[test]
    fn docker_exec_command_quotes_all_user_controlled_values() {
        let container = ContainerWorkspaceConfig {
            name: "dev container".to_string(),
            access: ContainerAccess::DockerExec,
            local: false,
            docker_path: "/opt/docker cli".to_string(),
            shell: "/bin/bash".to_string(),
            user: Some("build user".to_string()),
            interactive: true,
        };

        assert_eq!(
            docker_exec_host_command(&container, "printf '%s' \"$HOME\"", false),
            "'/opt/docker cli' 'exec' '-i' '--user' 'build user' 'dev container' '/bin/bash' '-lc' 'printf '\\''%s'\\'' \"$HOME\"'"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pid_file_sweep_spares_processes_that_are_still_running() {
        // The whole point of the pid file is cancellation, so removing one that
        // is still in use silently breaks interrupt/kill for a command that may
        // legitimately run for hours. Liveness, never age.
        let live = format!("/tmp/.openbitfun-exec-live-{}.pid", uuid::Uuid::new_v4());
        let dead = format!("/tmp/.openbitfun-exec-dead-{}.pid", uuid::Uuid::new_v4());
        std::fs::write(&live, std::process::id().to_string()).expect("write live pid file");
        // Reaped immediately, so its pid is guaranteed not to be running.
        let mut corpse = std::process::Command::new("true")
            .spawn()
            .expect("spawn short-lived process");
        let dead_pid = corpse.id();
        corpse.wait().expect("reap");
        std::fs::write(&dead, dead_pid.to_string()).expect("write dead pid file");

        let output = std::process::Command::new("sh")
            .args(["-lc", &stale_pid_file_sweep()])
            .output()
            .expect("run sweep");

        assert!(output.status.success());
        let live_exists = std::path::Path::new(&live).exists();
        let dead_exists = std::path::Path::new(&dead).exists();
        let _ = std::fs::remove_file(&live);
        let _ = std::fs::remove_file(&dead);
        assert!(live_exists, "a running command's pid file must survive");
        assert!(!dead_exists, "an orphaned pid file must be removed");
    }

    #[test]
    fn stage_tagging_is_readable_without_changing_the_error_text() {
        let original = anyhow!("Jump 1 (deploy@bastion:22) connection or authentication failed")
            .context("Could not connect to the Docker host");
        let expected_display = format!("{original}");
        let expected_alternate = format!("{original:#}");

        let tagged = tag_failed_stage("jump-1", original);

        // The tag exists only for attribution. An anyhow *context* would have
        // replaced the message the user sees with "connection stage 'jump-1'".
        assert_eq!(failed_stage_of(&tagged), Some("jump-1"));
        assert_eq!(format!("{tagged}"), expected_display);
        assert_eq!(format!("{tagged:#}"), expected_alternate);

        // Still findable once a caller layers its own context on top.
        let wrapped = tagged.context("Workspace connection failed");
        assert_eq!(failed_stage_of(&wrapped), Some("jump-1"));
        assert_eq!(format!("{wrapped}"), "Workspace connection failed");
    }

    #[test]
    fn supervised_container_command_tracks_and_signals_the_container_process_group() {
        let container = ContainerWorkspaceConfig {
            name: "dev".to_string(),
            access: ContainerAccess::DockerExec,
            local: true,
            docker_path: "docker".to_string(),
            shell: "/bin/bash".to_string(),
            user: None,
            interactive: true,
        };
        let (wrapped, pid_file) =
            supervised_container_command(&container, "printf '路径'; sleep 30");
        let signal =
            container_signal_command(&pid_file, crate::remote_ssh::WorkspaceProcessSignal::Kill);

        assert!(pid_file.starts_with("/tmp/.openbitfun-exec-"));
        assert!(wrapped.contains("setsid '/bin/bash' -lc"));
        assert!(wrapped.contains("exec 9<&0 || exit 1"));
        assert!(wrapped.contains("<&9 &"));
        assert!(wrapped.contains("exec 9<&-"));
        assert!(wrapped.contains("|| tracking=0"));
        assert!(wrapped.contains("printf '%s' \"$child\" > \"$pid_file\""));
        assert!(signal.contains("[ -s \"$pid_file\" ] || exit 75"));
        assert!(signal.contains("kill -KILL -- \"-$pid\""));
        assert!(signal.contains("kill -KILL \"$pid\""));
    }

    #[test]
    #[cfg(unix)]
    fn supervised_container_command_preserves_streamed_stdin() {
        use std::io::Write;

        let container = ContainerWorkspaceConfig {
            name: "dev".to_string(),
            access: ContainerAccess::DockerExec,
            local: true,
            docker_path: "docker".to_string(),
            shell: "/bin/sh".to_string(),
            user: None,
            interactive: true,
        };
        let wrapped = supervised_container_command_with_pid_file(
            &container,
            "read value; printf 'stdin:%s' \"$value\"",
            "/tmp/.openbitfun-exec-stdin-contract.pid",
        );
        let mut child = std::process::Command::new("sh")
            .args(["-lc", &wrapped])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn supervised command");
        child
            .stdin
            .take()
            .expect("supervisor stdin")
            .write_all(b"transport-contract\n")
            .expect("write supervisor stdin");
        let output = child
            .wait_with_output()
            .expect("wait for supervised command");

        assert!(output.status.success());
        assert_eq!(output.stdout, b"stdin:transport-contract");
        assert!(
            String::from_utf8_lossy(&output.stderr).trim().is_empty(),
            "stdin forwarding must not add command stderr"
        );
    }

    #[test]
    #[cfg(unix)]
    fn supervised_container_command_keeps_working_without_a_writable_pid_location() {
        let container = ContainerWorkspaceConfig {
            name: "dev".to_string(),
            access: ContainerAccess::DockerExec,
            local: true,
            docker_path: "docker".to_string(),
            shell: "/bin/sh".to_string(),
            user: None,
            interactive: true,
        };
        let wrapped = supervised_container_command_with_pid_file(
            &container,
            "printf 'compatible'",
            "/dev/null/openbitfun-exec.pid",
        );
        let output = std::process::Command::new("sh")
            .args(["-lc", &wrapped])
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout, b"compatible");
        assert!(
            String::from_utf8_lossy(&output.stderr).trim().is_empty(),
            "process-control fallback must not add command stderr"
        );
    }

    #[test]
    fn parses_container_directory_entry_with_newline_and_unit_separator() {
        let entries = parse_container_dir_output(
            "src\n\u{1f}name\x00/workspace/src\n\u{1f}name\x00d\x00\x001720000000\x00755\x00",
        )
        .unwrap();
        let entry = &entries[0];

        assert_eq!(entry.name, "src\n\u{1f}name");
        assert_eq!(entry.path, "/workspace/src\n\u{1f}name");
        assert!(entry.is_dir);
        assert_eq!(entry.modified, Some(1_720_000_000_000));
        assert_eq!(entry.permissions.as_deref(), Some("755"));
    }

    #[test]
    fn container_metadata_does_not_follow_symlinks_or_read_file_bodies() {
        let symlink_check = CONTAINER_ENTRY_METADATA_SCRIPT.find("[ -L").unwrap();
        let directory_check = CONTAINER_ENTRY_METADATA_SCRIPT.find("[ -d").unwrap();

        assert!(symlink_check < directory_check);
        assert!(CONTAINER_ENTRY_METADATA_SCRIPT.contains("[ -f"));
        assert!(CONTAINER_ENTRY_METADATA_SCRIPT.contains("else kind=o"));
        assert!(!CONTAINER_ENTRY_METADATA_SCRIPT.contains("wc -c"));
        assert!(CONTAINER_ENTRY_METADATA_SCRIPT.contains("stat -c %s"));
        assert!(CONTAINER_ENTRY_METADATA_SCRIPT.contains("stat -f %z"));
    }

    #[test]
    fn bounded_container_directory_script_stops_the_nul_producer() {
        let bounded = container_read_dir_script("/workspace", Some(4096));
        let unbounded = container_read_dir_script("/workspace", None);

        assert!(bounded.contains("find \"$dir\" -mindepth 1 -maxdepth 1 -print0"));
        assert!(bounded.contains("head -z -n 4096"));
        assert!(bounded.contains("xargs -0 -n 64"));
        assert!(!bounded.contains("\"$dir\"/*"));
        assert!(!unbounded.contains("head -z -n 4096"));
    }

    #[test]
    fn container_special_files_are_not_reported_as_regular_files() {
        let entry = parse_container_file_output(
            "pipe\x00/workspace/pipe\x00o\x000\x001720000000\x00644\x00",
        )
        .unwrap()
        .unwrap();

        assert!(!entry.is_file);
        assert!(!entry.is_dir);
        assert!(!entry.is_symlink);
    }

    #[test]
    fn container_exists_retains_transport_and_command_errors() {
        assert!(parse_container_exists_output("/workspace/file", "", 0).unwrap());
        assert!(!parse_container_exists_output("/workspace/missing", "", 1).unwrap());
        for (status, stderr) in [
            (1, "Error response from daemon: No such container"),
            (2, "Permission denied"),
            (125, "Cannot connect to the Docker daemon"),
            (126, "Shell is not executable"),
            (127, ""),
        ] {
            let error = parse_container_exists_output("/workspace/file", stderr, status)
                .expect_err("container failures must not be treated as missing files")
                .to_string();
            assert!(error.contains(&format!("status {status}")));
            assert!(error.contains(stderr));
        }
    }

    #[test]
    fn only_transport_sftp_errors_trigger_a_reconnect() {
        let status = |status_code| {
            SftpError::Status(russh_sftp::protocol::Status {
                id: 1,
                status_code,
                error_message: String::new(),
                language_tag: String::new(),
            })
        };

        assert!(sftp_error_may_be_stale_transport(&status(
            SftpStatusCode::ConnectionLost
        )));
        assert!(sftp_error_may_be_stale_transport(&SftpError::Timeout));
        assert!(!sftp_error_may_be_stale_transport(&status(
            SftpStatusCode::NoSuchFile
        )));
        assert!(!sftp_error_may_be_stale_transport(&status(
            SftpStatusCode::PermissionDenied
        )));
    }

    #[tokio::test]
    #[ignore = "requires OPENBITFUN_TEST_DOCKER_CONTAINER to name a running container"]
    async fn local_docker_workspace_round_trip() {
        let Ok(container_name) = std::env::var("OPENBITFUN_TEST_DOCKER_CONTAINER") else {
            return;
        };
        let dir = test_data_dir("local-docker-round-trip");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());
        let connection_id = "docker-local-contract";

        manager
            .connect(SSHConnectionConfig {
                id: connection_id.to_string(),
                name: container_name.clone(),
                host: String::new(),
                port: 22,
                username: String::new(),
                auth: SSHAuthMethod::PrivateKey {
                    key_path: String::new(),
                    passphrase: None,
                    certificate_path: None,
                },
                default_workspace: Some("/tmp/openbitfun-remote-workspace".to_string()),
                proxy_jump: None,
                container: Some(ContainerWorkspaceConfig {
                    name: container_name,
                    access: ContainerAccess::DockerExec,
                    local: true,
                    docker_path: "docker".to_string(),
                    shell: "/bin/sh".to_string(),
                    user: None,
                    interactive: true,
                }),
                wsl: None,
                options: Default::default(),
            })
            .await
            .unwrap();

        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let transport = manager
                .open_workspace_stdio(
                    connection_id,
                    "read value; printf 'stdout:%s' \"$value\"; printf 'stderr:%s' \"$value\" >&2; exit 7",
                )
                .await
                .unwrap();
            let (mut stdin, mut stdout, mut stderr, _control, completion) = transport.into_parts();
            stdin.write_all(b"transport-contract\n").await.unwrap();
            stdin.shutdown().await.unwrap();
            let mut stdout_bytes = Vec::new();
            let mut stderr_bytes = Vec::new();
            stdout.read_to_end(&mut stdout_bytes).await.unwrap();
            stderr.read_to_end(&mut stderr_bytes).await.unwrap();
            let exit = completion.wait().await;
            assert_eq!(stdout_bytes, b"stdout:transport-contract");
            assert_eq!(stderr_bytes, b"stderr:transport-contract");
            assert_eq!(exit.exit_code, Some(7));
        }

        manager
            .container_mkdir(connection_id, "/tmp/openbitfun-remote-workspace", true)
            .await
            .unwrap();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let cancel_after_start = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_after_start.cancel();
        });
        let cancelled_command = manager
            .execute_command_with_options(
                connection_id,
                "trap '' INT; sleep 30; touch /tmp/openbitfun-remote-workspace/cancel-leaked",
                SSHCommandOptions {
                    timeout_ms: Some(5_000),
                    cancellation_token: Some(cancellation),
                },
            )
            .await
            .unwrap();
        assert!(cancelled_command.interrupted);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !manager
                .container_exists(
                    connection_id,
                    "/tmp/openbitfun-remote-workspace/cancel-leaked"
                )
                .await
                .unwrap(),
            "cancelled Docker command must not continue inside the container"
        );
        let original = b"OpenBitFun container workspace\0binary";
        manager
            .container_write_file(
                connection_id,
                "/tmp/openbitfun-remote-workspace/source.bin",
                original,
            )
            .await
            .unwrap();
        assert_eq!(
            manager
                .container_read_file(connection_id, "/tmp/openbitfun-remote-workspace/source.bin")
                .await
                .unwrap(),
            original
        );
        manager
            .container_write_file(
                connection_id,
                "/tmp/openbitfun-remote-workspace/atomic.bin",
                original,
            )
            .await
            .unwrap();
        let replacement = vec![b'x'; 600_000];
        let cancelled = manager
            .container_write_file_with_progress(
                connection_id,
                "/tmp/openbitfun-remote-workspace/atomic.bin",
                &replacement,
                &mut |written, _| written < 262_144,
            )
            .await;
        assert!(cancelled.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            manager
                .container_read_file(connection_id, "/tmp/openbitfun-remote-workspace/atomic.bin")
                .await
                .unwrap(),
            original,
            "cancelled upload must not replace the existing destination"
        );
        manager
            .container_rename(
                connection_id,
                "/tmp/openbitfun-remote-workspace/source.bin",
                "/tmp/openbitfun-remote-workspace/renamed.bin",
            )
            .await
            .unwrap();
        let entries = manager
            .container_read_dir(connection_id, "/tmp/openbitfun-remote-workspace")
            .await
            .unwrap();
        assert!(entries.iter().any(|entry| entry.name == "renamed.bin"));
        assert_eq!(
            manager
                .container_stat(
                    connection_id,
                    "/tmp/openbitfun-remote-workspace/renamed.bin"
                )
                .await
                .unwrap()
                .and_then(|entry| entry.size),
            Some(original.len() as u64)
        );
        manager
            .container_remove(
                connection_id,
                "/tmp/openbitfun-remote-workspace/renamed.bin",
                false,
            )
            .await
            .unwrap();
        assert!(!manager
            .container_exists(
                connection_id,
                "/tmp/openbitfun-remote-workspace/renamed.bin"
            )
            .await
            .unwrap());

        manager.disconnect(connection_id).await.unwrap();
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn retains_password_connection_and_workspace_without_vault_entry() {
        let dir = test_data_dir("missing-vault-entry");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        tokio::fs::write(
            dir.join("ssh_connections.json"),
            serde_json::to_string_pretty(&serde_json::json!([{
                "id": "ssh-root@example.com",
                "name": "root@example.com",
                "host": "example.com",
                "port": 22,
                "username": "root",
                "authType": { "type": "Password" },
                "defaultWorkspace": "/root/project",
                "lastConnected": 1
            }]))
            .unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("remote_workspace.json"),
            serde_json::to_string_pretty(&serde_json::json!([{
                "connectionId": "ssh-root@example.com",
                "remotePath": "/root/project",
                "connectionName": "root@example.com",
                "sshHost": "example.com"
            }]))
            .unwrap(),
        )
        .await
        .unwrap();

        manager.load_saved_connections().await.unwrap();
        manager.load_remote_workspace().await.unwrap();
        let removed = manager
            .prune_remote_workspaces_without_saved_connections()
            .await
            .unwrap();

        let saved = manager.get_saved_connections().await;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "ssh-root@example.com");
        assert_eq!(saved[0].default_workspace.as_deref(), Some("/root/project"));
        assert!(removed.is_empty());
        let workspaces = manager.get_remote_workspaces().await;
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].connection_id, "ssh-root@example.com");
        assert_eq!(workspaces[0].remote_path, "/root/project");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn rejects_single_remote_workspace_object() {
        let dir = test_data_dir("single-remote-workspace-object");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        tokio::fs::write(
            dir.join("remote_workspace.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "connectionId": "ssh-root@example.com",
                "remotePath": "/root/project",
                "connectionName": "root@example.com",
                "sshHost": "example.com"
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let error = manager.load_remote_workspace().await.unwrap_err();
        assert!(error
            .to_string()
            .contains("Failed to parse remote workspaces"));
        assert!(manager.get_remote_workspaces().await.is_empty());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn rejects_saving_password_connection_without_password() {
        let dir = test_data_dir("empty-password-save");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        let result = manager
            .save_connection(&SSHConnectionConfig {
                id: "ssh-root@example.com:22".to_string(),
                name: "root@example.com".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "root".to_string(),
                auth: SSHAuthMethod::Password {
                    password: String::new(),
                },
                default_workspace: None,
                proxy_jump: None,
                container: None,
                wsl: None,
                options: Default::default(),
            })
            .await;

        assert!(result.is_err());
        assert!(manager.get_saved_connections().await.is_empty());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn restores_connection_config_from_saved_password_profile() {
        let dir = test_data_dir("restore-password-config");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        manager
            .save_connection(&SSHConnectionConfig {
                id: "ssh-root@example.com:22".to_string(),
                name: "root@example.com".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "root".to_string(),
                auth: SSHAuthMethod::Password {
                    password: "secret".to_string(),
                },
                default_workspace: Some("/root/project".to_string()),
                proxy_jump: Some("jump-a,jump-b".to_string()),
                container: None,
                wsl: None,
                options: Default::default(),
            })
            .await
            .unwrap();

        let restored = manager
            .load_connection_config_from_saved("ssh-root@example.com:22")
            .await
            .unwrap()
            .expect("expected saved config");

        assert_eq!(restored.host, "example.com");
        assert_eq!(restored.username, "root");
        assert_eq!(restored.default_workspace.as_deref(), Some("/root/project"));
        assert_eq!(restored.proxy_jump.as_deref(), Some("jump-a,jump-b"));
        match restored.auth {
            SSHAuthMethod::Password { password } => assert_eq!(password, "secret"),
            other => panic!("expected password auth, got {:?}", other),
        }

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn restores_legacy_local_docker_profile_without_password_vault_entry() {
        let dir = test_data_dir("legacy-local-docker-password-placeholder");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        tokio::fs::write(
            dir.join("ssh_connections.json"),
            serde_json::to_string_pretty(&serde_json::json!([{
                "id": "docker-local-legacy",
                "name": "local container",
                "host": "",
                "port": 22,
                "username": "",
                "authType": { "type": "Password" },
                "defaultWorkspace": "/workspace",
                "lastConnected": 1,
                "container": {
                    "name": "dev",
                    "access": "docker-exec",
                    "local": true
                }
            }]))
            .unwrap(),
        )
        .await
        .unwrap();

        manager.load_saved_connections().await.unwrap();
        let restored = manager
            .load_connection_config_from_saved("docker-local-legacy")
            .await
            .unwrap()
            .expect("legacy local Docker profile must remain restorable");

        assert!(restored.uses_local_docker());
        assert!(matches!(
            restored.auth,
            SSHAuthMethod::Password { ref password } if password.is_empty()
        ));
        assert_eq!(
            restored.options,
            crate::remote_ssh::types::SSHConnectionOptions::default()
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn saved_interactive_profile_never_persists_challenge_responses() {
        let dir = test_data_dir("interactive-secrets");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        manager
            .save_connection(&SSHConnectionConfig {
                id: "ssh-alice@example.com".to_string(),
                name: "interactive".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "alice".to_string(),
                auth: SSHAuthMethod::KeyboardInteractive {
                    responses: vec!["password-secret".to_string(), "123456".to_string()],
                },
                default_workspace: Some("/workspace".to_string()),
                proxy_jump: Some("jump.example.com".to_string()),
                container: None,
                wsl: None,
                options: Default::default(),
            })
            .await
            .unwrap();

        let persisted = tokio::fs::read_to_string(dir.join("ssh_connections.json"))
            .await
            .unwrap();
        assert!(persisted.contains("KeyboardInteractive"));
        assert!(!persisted.contains("password-secret"));
        assert!(!persisted.contains("123456"));

        let restored = manager
            .load_connection_config_from_saved("ssh-alice@example.com")
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            restored.auth,
            SSHAuthMethod::KeyboardInteractive { ref responses } if responses.is_empty()
        ));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn saved_agent_profile_preserves_identity_selection() {
        let dir = test_data_dir("agent-profile");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        manager
            .save_connection(&SSHConnectionConfig {
                id: "ssh-agent@example.com".to_string(),
                name: "agent".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "agent".to_string(),
                auth: SSHAuthMethod::Agent {
                    key_fingerprint: Some("SHA256:test-fingerprint".to_string()),
                    fallback_key_path: Some("~/.ssh/custom-fallback".to_string()),
                },
                default_workspace: None,
                proxy_jump: None,
                container: None,
                wsl: None,
                options: Default::default(),
            })
            .await
            .unwrap();

        let restored = manager
            .load_connection_config_from_saved("ssh-agent@example.com")
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            restored.auth,
            SSHAuthMethod::Agent {
                ref key_fingerprint,
                ref fallback_key_path,
            } if key_fingerprint.as_deref() == Some("SHA256:test-fingerprint")
                && fallback_key_path.as_deref() == Some("~/.ssh/custom-fallback")
        ));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn prunes_remote_workspaces_without_saved_connection() {
        let dir = test_data_dir("missing-saved");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let manager = SSHConnectionManager::new(dir.clone());

        let workspaces = vec![RemoteWorkspace {
            connection_id: "ssh-root@example.com:22".to_string(),
            remote_path: "/root/project".to_string(),
            connection_name: "root@example.com".to_string(),
            ssh_host: "example.com".to_string(),
        }];
        tokio::fs::write(
            dir.join("remote_workspace.json"),
            serde_json::to_string_pretty(&workspaces).unwrap(),
        )
        .await
        .unwrap();

        manager.load_remote_workspace().await.unwrap();
        let removed = manager
            .prune_remote_workspaces_without_saved_connections()
            .await
            .unwrap();

        assert_eq!(removed.len(), 1);
        assert!(manager.get_remote_workspaces().await.is_empty());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn mkdir_all_prefixes_expand_absolute_posix_path() {
        assert_eq!(
            sftp_mkdir_all_prefixes("/home/wgq/workspace/bot_detection/.openbitfun/bin"),
            vec![
                "/home".to_string(),
                "/home/wgq".to_string(),
                "/home/wgq/workspace".to_string(),
                "/home/wgq/workspace/bot_detection".to_string(),
                "/home/wgq/workspace/bot_detection/.openbitfun".to_string(),
                "/home/wgq/workspace/bot_detection/.openbitfun/bin".to_string(),
            ]
        );
    }

    #[test]
    fn mkdir_all_prefixes_collapse_redundant_separators() {
        assert_eq!(
            sftp_mkdir_all_prefixes("/home//wgq///project/"),
            vec![
                "/home".to_string(),
                "/home/wgq".to_string(),
                "/home/wgq/project".to_string(),
            ]
        );
    }
}
