//! Local (`ssh -L`) port forwarding over an established SSH session.
//!
//! A forward is a listener on this machine whose accepted connections are
//! spliced onto a `direct-tcpip` channel, so the remote sshd dials the service
//! and the two streams are copied in both directions.
//!
//! Two properties drive the design:
//!
//! - **The remote endpoint is the identity, the local port is an allocation.**
//!   Users care that "the dev server on the remote's port 3000 is reachable
//!   from here"; which local port carries it is a detail. Binding therefore
//!   falls back to an arbitrary free port instead of failing, and reports what
//!   was asked for so the UI can explain the move.
//! - **A forward must never resurrect a session the user closed.** Channels are
//!   opened through [`SSHConnectionManager`] on every connection rather than
//!   against a cached handle, which is what keeps a forward working across an
//!   automatic reconnect; the liveness check before each open is what stops
//!   that same path from silently dialing back out after an explicit
//!   disconnect.

use anyhow::{anyhow, Context};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::remote_ssh::manager::SSHConnectionManager;
use crate::remote_ssh::types::{
    PortForward, PortForwardDirection, PortForwardRequest, RemoteListeningPort, SSHCommandOptions,
};

/// Upper bound on connections a single forward carries at once.
///
/// A browser opens a handful of sockets per origin, so this sits far above
/// normal use. It exists so one runaway client cannot open SSH channels without
/// limit on a session that is also carrying the editor's own traffic.
const MAX_CONCURRENT_CONNECTIONS: usize = 256;

/// Originating address reported to the remote when opening a channel. The
/// remote only uses it for logging.
const ORIGINATOR_HOST: &str = "127.0.0.1";

/// Pause after a failed `accept` so a persistent error (descriptor exhaustion,
/// most likely) cannot spin the accept loop hot.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

/// How long the remote gets to report its listening sockets.
const LISTENING_PORT_PROBE_TIMEOUT_MS: u64 = 10_000;

/// Ports never worth offering as forwarding candidates. Port 22 is the
/// session's own transport: it is listening on every host reachable this way,
/// and forwarding it would only ever produce a second path to the SSH server
/// already carrying the forward.
const UNINTERESTING_LISTENING_PORTS: &[u16] = &[22];

/// Counters and health for one running forward.
///
/// Snapshots read these instead of the accept loop pushing updates, so the UI
/// can poll at whatever rate it likes without the data path paying for it.
struct ForwardRuntime {
    active_connections: AtomicU32,
    total_connections: AtomicU64,
    last_error: std::sync::Mutex<Option<String>>,
}

impl ForwardRuntime {
    fn new() -> Self {
        Self {
            active_connections: AtomicU32::new(0),
            total_connections: AtomicU64::new(0),
            last_error: std::sync::Mutex::new(None),
        }
    }

    fn connection_opened(&self) {
        self.active_connections.fetch_add(1, Ordering::SeqCst);
        self.total_connections.fetch_add(1, Ordering::SeqCst);
    }

    fn connection_closed(&self) {
        // Saturate rather than wrap. The counter should never reach zero with a
        // connection still open, but underflowing it would report four billion
        // active connections in the UI and there is no failure worth that.
        let _ = self
            .active_connections
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |active| {
                Some(active.saturating_sub(1))
            });
    }

    fn record_error(&self, message: String) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = Some(message);
        }
    }

    /// Clear the health signal after a connection completes normally, so a
    /// forward started before its remote service was up stops looking broken
    /// once the service arrives.
    fn clear_error(&self) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = None;
        }
    }

    fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }
}

/// A registered forward: its descriptor, live counters, and shutdown handle.
struct ForwardEntry {
    /// Descriptor fields that never change while the forward runs. Counters and
    /// `last_error` on this value are stale by construction and are refilled by
    /// [`ForwardEntry::snapshot`].
    descriptor: PortForward,
    runtime: Arc<ForwardRuntime>,
    cancel: CancellationToken,
}

impl ForwardEntry {
    fn snapshot(&self) -> PortForward {
        let mut forward = self.descriptor.clone();
        forward.active_connections = self.runtime.active_connections.load(Ordering::SeqCst);
        forward.total_connections = self.runtime.total_connections.load(Ordering::SeqCst);
        forward.last_error = self.runtime.last_error();
        forward
    }
}

/// Whether a failed bind should be retried on an arbitrary port.
///
/// `AddrInUse` is the everyday case. `PermissionDenied` covers privileged
/// ports, where telling the user to run the editor as root would be a far worse
/// answer than moving the mapping.
fn bind_error_can_fall_back(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
    )
}

/// Whether a copy error is just the peer hanging up.
///
/// Closing a browser tab mid-request produces these, and surfacing them would
/// leave a healthy forward permanently flagged as failing.
fn stream_error_is_benign(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// Bind the listener for a local forward, falling back to an arbitrary free
/// port when the requested one cannot be taken.
///
/// Returns the listener and, when the requested port was unavailable, the port
/// that was asked for. Callers need that to tell the user the mapping moved
/// rather than quietly handing back a different address.
async fn bind_forward_listener(
    host: &str,
    preferred: Option<u16>,
) -> anyhow::Result<(TcpListener, Option<u16>)> {
    let Some(port) = preferred else {
        let listener = TcpListener::bind((host, 0))
            .await
            .with_context(|| format!("Failed to bind {host} for port forwarding"))?;
        return Ok((listener, None));
    };

    match TcpListener::bind((host, port)).await {
        Ok(listener) => Ok((listener, None)),
        Err(error) if bind_error_can_fall_back(&error) => {
            let listener = TcpListener::bind((host, 0))
                .await
                .with_context(|| format!("Failed to bind a fallback local port on {host}"))?;
            Ok((listener, Some(port)))
        }
        Err(error) => Err(anyhow!("Failed to bind {host}:{port}: {error}")),
    }
}

/// Port forwarding manager.
///
/// Owns local (`-L`) forwards. Reverse and dynamic forwards keep their entry
/// point so callers get an explicit error rather than a silent no-op.
#[derive(Clone)]
pub struct PortForwardManager {
    forwards: Arc<tokio::sync::RwLock<HashMap<String, ForwardEntry>>>,
    ssh_manager: Arc<tokio::sync::RwLock<Option<SSHConnectionManager>>>,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self {
            forwards: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            ssh_manager: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    pub fn with_ssh_manager(ssh_manager: SSHConnectionManager) -> Self {
        Self {
            forwards: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            ssh_manager: Arc::new(tokio::sync::RwLock::new(Some(ssh_manager))),
        }
    }

    pub async fn set_ssh_manager(&self, manager: SSHConnectionManager) {
        let mut guard = self.ssh_manager.write().await;
        *guard = Some(manager);
    }

    async fn ssh_manager(&self) -> anyhow::Result<SSHConnectionManager> {
        self.ssh_manager
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("SSH manager is not initialized"))
    }

    /// Start a local (`-L`) forward and return the mapping that was actually
    /// established, which is not always the one that was requested.
    pub async fn start_local_forward(
        &self,
        request: &PortForwardRequest,
    ) -> anyhow::Result<PortForward> {
        let connection_id = request.connection_id.trim();
        if connection_id.is_empty() {
            anyhow::bail!("A port forward needs a connection id");
        }
        if request.remote_port == 0 {
            anyhow::bail!("A port forward needs a remote port");
        }

        let manager = self.ssh_manager().await?;
        // Starting a forward is an explicit request, so a saved connection the
        // user has not opened yet is connected rather than refused. The
        // liveness gate that matters is the per-connection one in
        // `carry_connection`, which is what stops a *stale* forward from
        // dialing back out on its own.
        manager
            .ensure_connected(connection_id)
            .await
            .with_context(|| format!("SSH connection '{connection_id}' is not usable"))?;
        // Reject the one target that can never work, here rather than on the
        // first request: a local Docker workspace is reached by `docker exec`
        // and has no SSH session to carry a channel. Discovering that after
        // opening a browser would be a worse way to learn it.
        if manager.is_local_process_connection(connection_id).await {
            anyhow::bail!(
                "Local Docker and WSL workspaces do not support SSH port forwarding. \
                 Use the target's published ports or Windows WSL networking instead."
            );
        }

        let remote_host = request.effective_remote_host().to_string();
        let local_host = request.effective_local_host();

        // Hold the registry across the duplicate check, the bind, and the
        // insert. Checking under a read lock and inserting later would let two
        // concurrent requests for the same endpoint both pass the check and
        // both bind, leaving the user with two local addresses that mean the
        // same thing. Binding is a syscall, so serializing starts costs
        // nothing worth measuring.
        let mut guard = self.forwards.write().await;

        if let Some(existing) = guard.values().find(|entry| {
            entry.descriptor.connection_id == connection_id
                && entry.descriptor.remote_host == remote_host
                && entry.descriptor.remote_port == request.remote_port
        }) {
            anyhow::bail!(
                "{}:{} is already forwarded to {}",
                remote_host,
                request.remote_port,
                existing.descriptor.local_address()
            );
        }

        let (listener, requested_local_port) =
            bind_forward_listener(local_host, request.preferred_local_port()).await?;
        let local_port = listener
            .local_addr()
            .context("Failed to read the bound local address")?
            .port();

        let descriptor = PortForward {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: connection_id.to_string(),
            direction: PortForwardDirection::Local,
            label: request.normalized_label(),
            local_host: local_host.to_string(),
            local_port,
            requested_local_port,
            remote_host,
            remote_port: request.remote_port,
            active_connections: 0,
            total_connections: 0,
            last_error: None,
        };

        let runtime = Arc::new(ForwardRuntime::new());
        let cancel = CancellationToken::new();

        log::info!(
            "Port forward started: {} -> {}:{} (connection {})",
            descriptor.local_address(),
            descriptor.remote_host,
            descriptor.remote_port,
            descriptor.connection_id
        );
        if let Some(requested) = requested_local_port {
            log::info!(
                "Local port {} was unavailable; forward {} bound {} instead",
                requested,
                descriptor.id,
                local_port
            );
        }

        Self::spawn_accept_loop(
            listener,
            manager,
            descriptor.clone(),
            runtime.clone(),
            cancel.clone(),
        );

        guard.insert(
            descriptor.id.clone(),
            ForwardEntry {
                descriptor: descriptor.clone(),
                runtime,
                cancel,
            },
        );

        Ok(descriptor)
    }

    /// Reverse (`-R`) forwarding entry point.
    ///
    /// Not implemented: it needs `tcpip-forward` global requests and a handler
    /// for server-initiated `forwarded-tcpip` channels, neither of which the
    /// session handler carries today. It fails loudly rather than registering a
    /// forward that moves no data.
    pub async fn start_remote_forward(
        &self,
        _connection_id: &str,
        _remote_port: u16,
        _local_host: &str,
        _local_port: u16,
    ) -> anyhow::Result<String> {
        Err(anyhow!("Reverse port forwarding is not supported yet"))
    }

    fn spawn_accept_loop(
        listener: TcpListener,
        manager: SSHConnectionManager,
        descriptor: PortForward,
        runtime: Arc<ForwardRuntime>,
        cancel: CancellationToken,
    ) {
        tokio::spawn(async move {
            let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
            loop {
                let accepted = tokio::select! {
                    _ = cancel.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };

                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        // One client failing its handshake must not take the
                        // whole forward down; report it and keep listening.
                        runtime
                            .record_error(format!("Failed to accept a local connection: {error}"));
                        tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                        continue;
                    }
                };

                // Wait for a slot under the same cancellation as the accept
                // above. Awaiting the permit bare would keep a stopped forward
                // alive until an in-flight connection released one, and then
                // open a channel for a client nobody is going to serve.
                let permit = tokio::select! {
                    _ = cancel.cancelled() => break,
                    permit = permits.clone().acquire_owned() => match permit {
                        Ok(permit) => permit,
                        Err(_) => break,
                    },
                };

                let manager = manager.clone();
                let descriptor = descriptor.clone();
                let runtime = runtime.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    Self::carry_connection(
                        manager,
                        descriptor,
                        runtime,
                        cancel,
                        stream,
                        peer.port(),
                    )
                    .await;
                    drop(permit);
                });
            }

            log::info!(
                "Port forward stopped: {} -> {}:{}",
                descriptor.local_address(),
                descriptor.remote_host,
                descriptor.remote_port
            );
        });
    }

    async fn carry_connection(
        manager: SSHConnectionManager,
        descriptor: PortForward,
        runtime: Arc<ForwardRuntime>,
        cancel: CancellationToken,
        mut local: TcpStream,
        peer_port: u16,
    ) {
        // Gate on liveness first. `open_direct_tcpip` reconnects on demand,
        // which is exactly what keeps a forward alive across a dropped session
        // — and exactly what would let a forward the caller forgot to stop dial
        // back out to a host the user explicitly disconnected from.
        if !manager.is_connected(&descriptor.connection_id).await {
            runtime.record_error("SSH connection is not active".to_string());
            return;
        }

        let channel = match manager
            .open_direct_tcpip(
                &descriptor.connection_id,
                &descriptor.remote_host,
                descriptor.remote_port,
                ORIGINATOR_HOST,
                peer_port,
            )
            .await
        {
            Ok(channel) => channel,
            Err(error) => {
                runtime.record_error(format!("{error:#}"));
                return;
            }
        };

        runtime.connection_opened();
        let mut remote = channel.into_stream();
        let outcome = tokio::select! {
            _ = cancel.cancelled() => None,
            copied = tokio::io::copy_bidirectional(&mut local, &mut remote) => Some(copied),
        };
        match outcome {
            Some(Err(error)) if !stream_error_is_benign(&error) => {
                runtime.record_error(format!("Forwarded connection failed: {error}"));
            }
            Some(_) => runtime.clear_error(),
            None => {}
        }
        runtime.connection_closed();
    }

    /// Stop one forward. Idempotent: stopping an unknown id succeeds so a UI
    /// that raced a teardown does not have to special-case the reply.
    pub async fn stop_forward(&self, forward_id: &str) -> anyhow::Result<()> {
        let removed = {
            let mut guard = self.forwards.write().await;
            guard.remove(forward_id)
        };
        if let Some(entry) = removed {
            entry.cancel.cancel();
            log::info!(
                "Stopped port forward {}: {} -> {}:{}",
                entry.descriptor.id,
                entry.descriptor.local_address(),
                entry.descriptor.remote_host,
                entry.descriptor.remote_port
            );
        }
        Ok(())
    }

    /// Stop every forward carried by one connection.
    ///
    /// Called when a connection is torn down, so the listeners go away with the
    /// session that gave them meaning.
    pub async fn stop_for_connection(&self, connection_id: &str) -> usize {
        let removed: Vec<ForwardEntry> = {
            let mut guard = self.forwards.write().await;
            let ids: Vec<String> = guard
                .values()
                .filter(|entry| entry.descriptor.connection_id == connection_id)
                .map(|entry| entry.descriptor.id.clone())
                .collect();
            ids.iter().filter_map(|id| guard.remove(id)).collect()
        };
        for entry in &removed {
            entry.cancel.cancel();
        }
        if !removed.is_empty() {
            log::info!(
                "Stopped {} port forward(s) for connection {}",
                removed.len(),
                connection_id
            );
        }
        removed.len()
    }

    /// Stop all port forwards.
    pub async fn stop_all(&self) {
        let removed: Vec<ForwardEntry> = {
            let mut guard = self.forwards.write().await;
            guard.drain().map(|(_, entry)| entry).collect()
        };
        for entry in &removed {
            entry.cancel.cancel();
        }
        if !removed.is_empty() {
            log::info!("Stopped all {} port forward(s)", removed.len());
        }
    }

    /// List every forward, ordered so the UI does not reshuffle between polls.
    pub async fn list_forwards(&self) -> Vec<PortForward> {
        let guard = self.forwards.read().await;
        let mut forwards: Vec<PortForward> = guard.values().map(ForwardEntry::snapshot).collect();
        forwards.sort_by(|left, right| {
            left.connection_id
                .cmp(&right.connection_id)
                .then(left.remote_port.cmp(&right.remote_port))
                .then(left.remote_host.cmp(&right.remote_host))
        });
        forwards
    }

    /// List the forwards carried by one connection.
    pub async fn list_forwards_for_connection(&self, connection_id: &str) -> Vec<PortForward> {
        self.list_forwards()
            .await
            .into_iter()
            .filter(|forward| forward.connection_id == connection_id)
            .collect()
    }

    /// Look up the forward that already covers a remote endpoint.
    pub async fn find_forward(
        &self,
        connection_id: &str,
        remote_host: &str,
        remote_port: u16,
    ) -> Option<PortForward> {
        let guard = self.forwards.read().await;
        guard
            .values()
            .find(|entry| {
                entry.descriptor.connection_id == connection_id
                    && entry.descriptor.remote_host == remote_host
                    && entry.descriptor.remote_port == remote_port
            })
            .map(ForwardEntry::snapshot)
    }

    /// Whether some forward is bound to a local port on this machine.
    pub async fn is_port_forwarded(&self, port: u16) -> bool {
        let guard = self.forwards.read().await;
        guard
            .values()
            .any(|entry| entry.descriptor.local_port == port)
    }
}

static GLOBAL_PORT_FORWARD_MANAGER: OnceLock<PortForwardManager> = OnceLock::new();

/// The process-wide forward registry.
///
/// Both the desktop UI and the Agent tool operate on the same set of forwards:
/// a mapping the user created by hand and one an Agent created are the same
/// object, and either surface must be able to list and stop the other's work.
/// Handing each caller its own manager would split that in half and leak
/// listeners neither side could see.
pub fn global_port_forward_manager() -> PortForwardManager {
    GLOBAL_PORT_FORWARD_MANAGER
        .get_or_init(PortForwardManager::new)
        .clone()
}

impl Default for PortForwardManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Remote listening port discovery
// ============================================================================

/// Which tool produced a listening-socket listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListingFormat {
    /// `ss -H -l -t -n -p`, and `netstat -l -t -n -p`, which agree on the
    /// column that holds the local address.
    ColumnarSocketStat,
    /// `lsof -nP -iTCP -sTCP:LISTEN`.
    Lsof,
}

/// Probe script run on the remote.
///
/// `ss` first because it is the modern Linux tool, then `lsof` because macOS
/// remotes have it and their `netstat` spells `-p` as "protocol", then
/// `netstat` for older Linux hosts. The marker line tells the parser which
/// dialect came back instead of making it guess from the shape.
const LISTENING_PORT_PROBE_SCRIPT: &str = concat!(
    "if command -v ss >/dev/null 2>&1; then ",
    "echo __OPENBITFUN_SS__; ss -H -l -t -n -p 2>/dev/null; ",
    "elif command -v lsof >/dev/null 2>&1; then ",
    "echo __OPENBITFUN_LSOF__; lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null; ",
    "elif command -v netstat >/dev/null 2>&1; then ",
    "echo __OPENBITFUN_NETSTAT__; netstat -l -t -n -p 2>/dev/null; ",
    "else echo __OPENBITFUN_NONE__; fi"
);

/// Split a `host:port` token, tolerating the IPv6 and wildcard spellings the
/// various tools emit (`[::]:80`, `*:3000`, `:::80`).
fn split_host_port(token: &str) -> Option<(String, u16)> {
    let (host, port) = token.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    let host = host.trim();
    let host = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    let host = match host {
        "" | "*" => "0.0.0.0",
        other => other,
    };
    Some((host.to_string(), port))
}

/// Pull the process name and pid out of the trailing column.
///
/// `ss` writes `users:(("node",pid=999,fd=20))`; `netstat` writes `999/node`.
fn parse_socket_stat_process(line: &str) -> (Option<String>, Option<u32>) {
    if let Some(users) = line.split("users:((").nth(1) {
        let name = users
            .split('"')
            .nth(1)
            .map(str::to_string)
            .filter(|name| !name.is_empty());
        let pid = users
            .split("pid=")
            .nth(1)
            .and_then(|rest| {
                rest.split(|c: char| !c.is_ascii_digit())
                    .find(|part| !part.is_empty())
            })
            .and_then(|digits| digits.parse().ok());
        return (name, pid);
    }

    for field in line.split_whitespace() {
        if let Some((pid, name)) = field.split_once('/') {
            if let Ok(pid) = pid.parse::<u32>() {
                let name = name.trim();
                return (
                    (!name.is_empty() && name != "-").then(|| name.to_string()),
                    Some(pid),
                );
            }
        }
    }
    (None, None)
}

fn parse_columnar_socket_stat(output: &str) -> Vec<RemoteListeningPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // `ss -H` emits `LISTEN Recv-Q Send-Q Local Peer [users]`; `netstat`
        // emits `Proto Recv-Q Send-Q Local Foreign State [pid/name]`. Both put
        // the local address in the fourth column, and neither header row
        // survives the state/protocol check below.
        if fields.len() < 4 {
            continue;
        }
        let is_listening_row = fields[0].eq_ignore_ascii_case("LISTEN")
            || (fields[0].starts_with("tcp")
                && fields
                    .iter()
                    .any(|field| field.eq_ignore_ascii_case("LISTEN")));
        if !is_listening_row {
            continue;
        }
        let Some((bind_address, port)) = split_host_port(fields[3]) else {
            continue;
        };
        let (process, pid) = parse_socket_stat_process(line);
        ports.push(RemoteListeningPort {
            port,
            bind_address,
            process,
            pid,
        });
    }
    ports
}

fn parse_lsof(output: &str) -> Vec<RemoteListeningPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)`.
        if fields.len() < 9 {
            continue;
        }
        // The name column is the field immediately before `(LISTEN)`, which is
        // more robust than indexing from the left: command names can contain
        // spaces on some platforms.
        let Some(name_index) = fields.iter().position(|field| *field == "(LISTEN)") else {
            continue;
        };
        let Some(address) = name_index
            .checked_sub(1)
            .and_then(|index| fields.get(index))
        else {
            continue;
        };
        // lsof writes `host:port` but also `*:port` and `[::1]:port`.
        let Some((bind_address, port)) = split_host_port(address) else {
            continue;
        };
        ports.push(RemoteListeningPort {
            port,
            bind_address,
            process: Some(fields[0].to_string()).filter(|name| !name.is_empty()),
            pid: fields[1].parse().ok(),
        });
    }
    ports
}

/// Collapse a listing into one row per port.
///
/// A service bound to both address families shows up twice, and the port is the
/// only part the user acts on. Rows that name a process win, so the merged
/// entry keeps the most useful label.
fn dedupe_listening_ports(ports: Vec<RemoteListeningPort>) -> Vec<RemoteListeningPort> {
    let mut merged: Vec<RemoteListeningPort> = Vec::new();
    for port in ports {
        if UNINTERESTING_LISTENING_PORTS.contains(&port.port) {
            continue;
        }
        match merged.iter_mut().find(|kept| kept.port == port.port) {
            Some(kept) => {
                if kept.process.is_none() && port.process.is_some() {
                    kept.process = port.process;
                    kept.pid = port.pid;
                    kept.bind_address = port.bind_address;
                }
            }
            None => merged.push(port),
        }
    }
    merged.sort_by_key(|port| port.port);
    merged
}

fn parse_listening_ports(output: &str) -> anyhow::Result<Vec<RemoteListeningPort>> {
    let mut lines = output.lines();
    let format = loop {
        let Some(line) = lines.next() else {
            anyhow::bail!("The remote produced no listening-socket listing");
        };
        match line.trim() {
            "__OPENBITFUN_SS__" | "__OPENBITFUN_NETSTAT__" => {
                break ListingFormat::ColumnarSocketStat
            }
            "__OPENBITFUN_LSOF__" => break ListingFormat::Lsof,
            "__OPENBITFUN_NONE__" => anyhow::bail!(
                "The remote host has none of ss, lsof, or netstat, so its listening ports \
                 cannot be detected. Enter the port manually."
            ),
            // Shell profiles love to print banners; skip until the marker.
            _ => continue,
        }
    };

    let body: String = lines.collect::<Vec<&str>>().join("\n");
    let ports = match format {
        ListingFormat::ColumnarSocketStat => parse_columnar_socket_stat(&body),
        ListingFormat::Lsof => parse_lsof(&body),
    };
    Ok(dedupe_listening_ports(ports))
}

/// List the TCP ports currently accepting connections on the remote host.
///
/// This is the opt-in alternative to guessing a port number; nothing is
/// forwarded as a result of calling it.
pub async fn list_remote_listening_ports(
    manager: &SSHConnectionManager,
    connection_id: &str,
) -> anyhow::Result<Vec<RemoteListeningPort>> {
    let result = manager
        .execute_command_with_options(
            connection_id,
            LISTENING_PORT_PROBE_SCRIPT,
            SSHCommandOptions {
                timeout_ms: Some(LISTENING_PORT_PROBE_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await
        .context("Failed to probe the remote host for listening ports")?;

    // A non-zero status is expected: the probe tolerates a tool that partially
    // fails, and only a listing with no marker at all is unusable.
    parse_listening_ports(&result.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_ipv4_ipv6_and_wildcard_addresses() {
        assert_eq!(
            split_host_port("127.0.0.1:3000"),
            Some(("127.0.0.1".to_string(), 3000))
        );
        // The IPv6 wildcard keeps its own spelling: it is reported to the user
        // as the address the remote service is actually bound to, and claiming
        // it is an IPv4 wildcard would be a lie.
        assert_eq!(split_host_port("[::]:8080"), Some(("::".to_string(), 8080)));
        assert_eq!(split_host_port(":::80"), Some(("::".to_string(), 80)));
        // `*` has no address family attached, so loopback-or-anything is the
        // only honest reading and `0.0.0.0` is how the other tools spell it.
        assert_eq!(
            split_host_port("*:5173"),
            Some(("0.0.0.0".to_string(), 5173))
        );
        assert_eq!(split_host_port("no-port"), None);
    }

    #[test]
    fn parses_ss_listing() {
        let output = "__OPENBITFUN_SS__\n\
LISTEN 0      4096       127.0.0.1:3000       0.0.0.0:*    users:((\"node\",pid=999,fd=20))\n\
LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*    users:((\"nginx\",pid=1234,fd=6))\n\
LISTEN 0      128            0.0.0.0:22       0.0.0.0:*    users:((\"sshd\",pid=700,fd=3))\n";
        let ports = parse_listening_ports(output).expect("listing should parse");
        assert_eq!(ports.len(), 2, "port 22 is filtered out: {ports:?}");
        assert_eq!(ports[0].port, 3000);
        assert_eq!(ports[0].process.as_deref(), Some("node"));
        assert_eq!(ports[0].pid, Some(999));
        assert_eq!(ports[1].port, 8080);
        assert_eq!(ports[1].process.as_deref(), Some("nginx"));
    }

    #[test]
    fn parses_netstat_listing() {
        let output = "__OPENBITFUN_NETSTAT__\n\
Active Internet connections (only servers)\n\
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n\
tcp        0      0 127.0.0.1:5173          0.0.0.0:*               LISTEN      4242/vite\n\
tcp6       0      0 :::9229                 :::*                    LISTEN      -\n";
        let ports = parse_listening_ports(output).expect("listing should parse");
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].port, 5173);
        assert_eq!(ports[0].process.as_deref(), Some("vite"));
        assert_eq!(ports[0].pid, Some(4242));
        assert_eq!(ports[1].port, 9229);
        assert_eq!(ports[1].process, None);
    }

    #[test]
    fn parses_lsof_listing() {
        let output = "__OPENBITFUN_LSOF__\n\
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n\
node    99999  bob   20u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:3000 (LISTEN)\n\
Python  55555  bob    3u  IPv6 0xfedcba0987654321      0t0  TCP *:8000 (LISTEN)\n";
        let ports = parse_listening_ports(output).expect("listing should parse");
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].port, 3000);
        assert_eq!(ports[0].process.as_deref(), Some("node"));
        assert_eq!(ports[0].pid, Some(99999));
        assert_eq!(ports[1].port, 8000);
        assert_eq!(ports[1].bind_address, "0.0.0.0");
    }

    #[test]
    fn skips_shell_banner_before_the_marker() {
        let output = "Welcome to Ubuntu 24.04 LTS\n\
Last login: Tue Aug 19 09:00:00 2026\n\
__OPENBITFUN_SS__\n\
LISTEN 0 4096 127.0.0.1:4000 0.0.0.0:* users:((\"api\",pid=12,fd=7))\n";
        let ports = parse_listening_ports(output).expect("listing should parse");
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port, 4000);
    }

    #[test]
    fn reports_a_remote_without_any_probe_tool() {
        let error = parse_listening_ports("__OPENBITFUN_NONE__\n")
            .expect_err("a remote with no tooling should be an error");
        assert!(
            error.to_string().contains("manually"),
            "the message should tell the user what to do instead: {error}"
        );
    }

    #[test]
    fn merges_dual_stack_rows_and_prefers_the_named_process() {
        let ports = dedupe_listening_ports(vec![
            RemoteListeningPort {
                port: 3000,
                bind_address: "0.0.0.0".to_string(),
                process: None,
                pid: None,
            },
            RemoteListeningPort {
                port: 3000,
                bind_address: "::".to_string(),
                process: Some("node".to_string()),
                pid: Some(7),
            },
        ]);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].process.as_deref(), Some("node"));
        assert_eq!(ports[0].pid, Some(7));
    }

    #[tokio::test]
    async fn falls_back_to_a_free_port_when_the_requested_one_is_taken() {
        let occupied = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("the test needs a port to occupy");
        let taken = occupied.local_addr().expect("bound address").port();

        let (listener, requested) = bind_forward_listener("127.0.0.1", Some(taken))
            .await
            .expect("binding should fall back rather than fail");
        let bound = listener.local_addr().expect("bound address").port();

        assert_eq!(
            requested,
            Some(taken),
            "the requested port must be reported so the UI can explain the move"
        );
        assert_ne!(bound, taken);
    }

    #[tokio::test]
    async fn keeps_the_requested_port_when_it_is_free() {
        // Freeing a port and asking for it back is inherently racy: anything
        // else on the machine — including the rest of this suite, which binds
        // ephemeral ports in parallel — may claim the number in between. Retry
        // so a stolen port cannot fail a test about the *un*-stolen path.
        const ATTEMPTS: usize = 16;
        for _ in 0..ATTEMPTS {
            let probe = TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("the test needs a free port number");
            let free = probe.local_addr().expect("bound address").port();
            drop(probe);

            let (listener, requested) = bind_forward_listener("127.0.0.1", Some(free))
                .await
                .expect("binding must succeed whether or not the port was taken");

            if requested.is_none() {
                assert_eq!(
                    listener.local_addr().expect("bound address").port(),
                    free,
                    "reporting no move means the requested port is the bound one"
                );
                return;
            }
            // The port was taken between the probe and the bind, so this
            // attempt exercised the fallback path instead. That path has its
            // own test; try again for a genuinely free port.
            assert_eq!(requested, Some(free));
        }
        panic!("the requested port was taken on all {ATTEMPTS} attempts");
    }

    #[tokio::test]
    async fn refuses_to_forward_without_an_ssh_manager() {
        let manager = PortForwardManager::new();
        let error = manager
            .start_local_forward(&PortForwardRequest {
                connection_id: "conn".to_string(),
                remote_port: 3000,
                remote_host: None,
                local_port: None,
                expose_on_lan: false,
                label: None,
            })
            .await
            .expect_err("an uninitialized manager cannot forward");
        assert!(error.to_string().contains("not initialized"), "{error}");
    }

    #[tokio::test]
    async fn rejects_a_request_with_no_remote_port() {
        let manager = PortForwardManager::new();
        let error = manager
            .start_local_forward(&PortForwardRequest {
                connection_id: "conn".to_string(),
                remote_port: 0,
                remote_host: None,
                local_port: None,
                expose_on_lan: false,
                label: None,
            })
            .await
            .expect_err("port 0 is not a service");
        assert!(error.to_string().contains("remote port"), "{error}");
    }

    #[tokio::test]
    async fn the_global_registry_is_one_shared_instance() {
        // The UI and the Agent tool each take their own handle. If these were
        // separate registries, a forward made on one surface would be invisible
        // and unstoppable from the other, and the listener would outlive any
        // way to find it.
        let first = global_port_forward_manager();
        let second = global_port_forward_manager();
        assert!(
            Arc::ptr_eq(&first.forwards, &second.forwards),
            "every caller must share one forward registry"
        );
    }

    #[tokio::test]
    async fn stopping_an_unknown_forward_succeeds() {
        let manager = PortForwardManager::new();
        manager
            .stop_forward("does-not-exist")
            .await
            .expect("stop should be idempotent");
        assert!(manager.list_forwards().await.is_empty());
    }

    #[test]
    fn request_defaults_target_loopback_on_both_ends() {
        let request = PortForwardRequest {
            connection_id: "conn".to_string(),
            remote_port: 3000,
            remote_host: Some("   ".to_string()),
            local_port: Some(0),
            expose_on_lan: false,
            label: Some("  ".to_string()),
        };
        assert_eq!(request.effective_remote_host(), "127.0.0.1");
        assert_eq!(request.effective_local_host(), "127.0.0.1");
        assert_eq!(request.preferred_local_port(), None);
        assert_eq!(request.normalized_label(), None);
    }

    #[test]
    fn exposing_on_lan_is_the_only_way_to_leave_loopback() {
        let request = PortForwardRequest {
            connection_id: "conn".to_string(),
            remote_port: 3000,
            remote_host: None,
            local_port: None,
            expose_on_lan: true,
            label: None,
        };
        assert_eq!(request.effective_local_host(), "0.0.0.0");
    }

    #[test]
    fn wildcard_binds_are_displayed_as_a_reachable_address() {
        let forward = PortForward {
            id: "id".to_string(),
            connection_id: "conn".to_string(),
            direction: PortForwardDirection::Local,
            label: None,
            local_host: "0.0.0.0".to_string(),
            local_port: 3001,
            requested_local_port: Some(3000),
            remote_host: "127.0.0.1".to_string(),
            remote_port: 3000,
            active_connections: 0,
            total_connections: 0,
            last_error: None,
        };
        assert_eq!(forward.local_address(), "127.0.0.1:3001");
    }
}
