//! Private, versioned, bounded local management for the daemon's Remote Connect owner.
//! A failed reply has unknown outcome: clients never replay a submitted mutation.

use crate::{remote_control::CliRemoteControlHost, runtime::CliRuntimeContext};
use anyhow::{anyhow, Context, Result};
use fs2::FileExt;
use openbitfun_product_domains::remote_control::{RemoteControlRequest, REMOTE_CONTROL_CAPABILITY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const VERSION: u32 = 1;
const MAX_FRAME: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(100);
static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Deserialize)]
struct Discovery {
    version: u32,
    port: u16,
    token: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct Request {
    version: u32,
    token: String,
    command: RemoteControlRequest,
    account_user_id: String,
    #[serde(default)]
    shutdown: bool,
}
#[derive(Serialize, Deserialize)]
struct Response {
    result: Option<Value>,
    error: Option<String>,
}

fn directory() -> Result<PathBuf> {
    let path = openbitfun_core::infrastructure::PathManager::new()?
        .product_home_dir()
        .join("cli-daemon-control");
    std::fs::create_dir_all(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
}

#[derive(Clone)]
pub(crate) struct OwnerLease {
    _file: Arc<File>,
}

pub(crate) struct Server {
    lease: OwnerLease,
    path: PathBuf,
    listener: TcpListener,
    discovery: Discovery,
}

impl Server {
    pub(crate) async fn reserve() -> Result<Self> {
        Self::reserve_in(directory()?).await
    }

    async fn reserve_in(directory: PathBuf) -> Result<Self> {
        let lease = private_options()
            .create(true)
            .truncate(false)
            .open(directory.join("owner.lock"))?;
        FileExt::try_lock_exclusive(&lease).context("another CLI daemon owns Remote Connect")?;
        let path = directory.join("endpoint.json");
        // A crashed owner can leave discovery behind. Only the new exclusive
        // owner may remove it; Windows rename cannot replace an existing file.
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("retire stale CLI daemon discovery"),
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let discovery = Discovery {
            version: VERSION,
            port: listener.local_addr()?.port(),
            token: format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
        };
        Ok(Self {
            lease: OwnerLease {
                _file: Arc::new(lease),
            },
            path,
            listener,
            discovery,
        })
    }

    /// The listener can stop before bot and account cleanup completes. Retain
    /// this guard in the daemon runner until the entire shutdown has finished.
    pub(crate) fn owner_lease(&self) -> OwnerLease {
        self.lease.clone()
    }

    fn publish(&self) -> Result<()> {
        let temp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = private_options().create_new(true).open(&temp)?;
        file.write_all(&serde_json::to_vec(&self.discovery)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, &self.path)?;
        Ok(())
    }

    pub(crate) async fn run(self, host: Arc<CliRemoteControlHost>) -> Result<()> {
        // Publish only after the account, bot owner and command router are ready.
        self.publish()?;
        let mut clients = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                stream = self.listener.accept() => {
                    let (stream, _) = stream?;
                    let token = self.discovery.token.clone();
                    let host = host.clone();
                    clients.spawn(async move {
                        let _ = serve(stream, &token, host).await;
                    });
                }
                Some(_) = clients.join_next(), if !clients.is_empty() => {}
            }
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut TcpStream) -> Result<T> {
    let length = stream.read_u32().await? as usize;
    anyhow::ensure!(
        length > 0 && length <= MAX_FRAME,
        "Invalid daemon management frame length"
    );
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    anyhow::ensure!(
        bytes.len() <= MAX_FRAME,
        "Daemon management result exceeds frame limit"
    );
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}
async fn serve(stream: TcpStream, token: &str, host: Arc<CliRemoteControlHost>) -> Result<()> {
    serve_with(stream, token, move |request| async move {
        if request.shutdown {
            anyhow::ensure!(
                matches!(request.command, RemoteControlRequest::Status),
                "Invalid shutdown envelope"
            );
            host.request_shutdown();
            Ok(json!({"shutdownRequested":true}))
        } else {
            host.execute_for_account(request.command, &request.account_user_id)
                .await
        }
    })
    .await
}

async fn serve_with<F, Fut>(mut stream: TcpStream, token: &str, execute: F) -> Result<()>
where
    F: FnOnce(Request) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let request: Request =
        tokio::time::timeout(Duration::from_secs(5), read_frame(&mut stream)).await??;
    anyhow::ensure!(
        request.version == VERSION && request.token == token,
        "Unauthorized daemon management request"
    );
    let response = match execute(request).await {
        Ok(result) => Response {
            result: Some(result),
            error: None,
        },
        Err(error) => Response {
            result: None,
            error: Some(error.to_string()),
        },
    };
    tokio::time::timeout(Duration::from_secs(5), write_frame(&mut stream, &response)).await??;
    Ok(())
}

async fn connect() -> Result<(TcpStream, Discovery)> {
    let discovery: Discovery =
        serde_json::from_slice(&std::fs::read(directory()?.join("endpoint.json"))?)?;
    anyhow::ensure!(
        discovery.version == VERSION,
        "unsupported: Upgrade and restart the CLI daemon for Remote Connect management"
    );
    let stream = tokio::time::timeout(
        Duration::from_secs(1),
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, discovery.port)),
    )
    .await??;
    Ok((stream, discovery))
}

pub(crate) async fn invoke(
    runtime: &Arc<CliRuntimeContext>,
    command: RemoteControlRequest,
) -> Result<Value> {
    if matches!(
        &command,
        RemoteControlRequest::Start {
            method: openbitfun_product_domains::remote_control::RemoteControlMethod::Lan,
            ..
        } | RemoteControlRequest::Stop {
            method: openbitfun_product_domains::remote_control::RemoteControlMethod::Lan
        }
    ) {
        anyhow::bail!("unsupported: This CLI host has no embedded LAN Relay; use Mobile Web with the configured account Relay");
    }
    if let Some(host) = crate::remote_control::daemon_host() {
        return host.execute(command).await;
    }
    let account_user_id = match runtime.account_runtime().account_info().await {
        Ok(info) => info.user_id,
        Err(_) if command.is_readonly() => {
            return Ok(json!({"daemonRunning":false,"state":"account_required"}))
        }
        Err(error) => return Err(error),
    };
    let connection = match connect().await {
        Ok(connection) => connection,
        Err(_) if command.is_readonly() => {
            return Ok(
                json!({"daemonRunning":false,"state":"unavailable", "nextStep":"Start a channel to launch the CLI daemon; if an older daemon is running, upgrade and restart it"}),
            )
        }
        Err(_) => {
            let _startup = START_LOCK.lock().await;
            if let Ok(connection) = connect().await {
                connection
            } else {
                anyhow::ensure!(!super::is_daemon_running(), "unsupported: The running daemon has no Remote Connect management endpoint; upgrade and restart it");
                runtime.account_runtime().read_account_context().await?;
                runtime.account_routing().stop_device_routing().await;
                let executable = std::env::current_exe()?;
                let mut process =
                    openbitfun_services_core::process_manager::create_command(executable);
                process
                    .arg("daemon")
                    .arg("run")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    unsafe {
                        process.pre_exec(|| {
                            if libc::setsid() == -1 {
                                Err(std::io::Error::last_os_error())
                            } else {
                                Ok(())
                            }
                        });
                    }
                }
                let mut child = match process.spawn().context("start CLI Remote Connect daemon") {
                    Ok(child) => child,
                    Err(error) => {
                        restore_caller_routing(runtime).await;
                        return Err(error);
                    }
                };
                let started = std::time::Instant::now();
                loop {
                    if let Ok(connection) = connect().await {
                        // Reap when the detached process eventually exits.
                        std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                        break connection;
                    }
                    if let Some(status) = child.try_wait()? {
                        restore_caller_routing(runtime).await;
                        return Err(anyhow!("CLI daemon exited before becoming ready: {status}. Run openbitfun daemon run to inspect the startup failure"));
                    }
                    if started.elapsed() > Duration::from_secs(60) {
                        std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                        return Err(anyhow!("CLI daemon startup is still pending; inspect daemon status before retrying"));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    };
    let (mut stream, discovery) = connection;
    let request = Request {
        version: VERSION,
        token: discovery.token,
        command,
        account_user_id,
        shutdown: false,
    };
    let result = tokio::time::timeout(TIMEOUT, async {
        write_frame(&mut stream, &request).await?;
        read_frame::<Response>(&mut stream).await
    })
    .await;
    let response = result
        .map_err(|_| {
            anyhow!(
                "outcome_unknown: Daemon request timed out; inspect status before another mutation"
            )
        })?
        .map_err(|_| {
            anyhow!(
                "outcome_unknown: Daemon connection closed; inspect status before another mutation"
            )
        })?;
    match (response.result, response.error) {
        (Some(mut result), None) => {
            result["managementCapability"] = json!(REMOTE_CONTROL_CAPABILITY);
            Ok(result)
        }
        (_, Some(error)) => Err(anyhow!(error)),
        _ => Err(anyhow!("Invalid daemon management response")),
    }
}

/// OS-independent liveness proof, including Windows where a Unix PID probe
/// cannot observe the supervised daemon.
pub(crate) fn owner_is_running() -> bool {
    let Ok(directory) = directory() else {
        return false;
    };
    let Ok(file) = private_options().open(directory.join("owner.lock")) else {
        return false;
    };
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            let _ = FileExt::unlock(&file);
            false
        }
        Err(error) => error.kind() == std::io::ErrorKind::WouldBlock,
    }
}

/// Used by account retirement and `daemon stop`; no provider token is involved.
/// A successfully submitted request is followed by the caller's existing
/// bounded wait for owner release. Never infer shutdown from the send alone.
pub(crate) fn request_shutdown() -> bool {
    let result = (|| -> Result<()> {
        let discovery: Discovery =
            serde_json::from_slice(&std::fs::read(directory()?.join("endpoint.json"))?)?;
        anyhow::ensure!(
            discovery.version == VERSION,
            "Unsupported daemon management protocol"
        );
        let address = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, discovery.port));
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1))?;
        stream.set_write_timeout(Some(Duration::from_secs(1)))?;
        let bytes = serde_json::to_vec(&Request {
            version: VERSION,
            token: discovery.token,
            command: RemoteControlRequest::Status,
            account_user_id: String::new(),
            shutdown: true,
        })?;
        stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
        stream.write_all(&bytes)?;
        Ok(())
    })();
    result.is_ok()
}

async fn restore_caller_routing(runtime: &Arc<CliRuntimeContext>) {
    if super::is_daemon_running() || connect().await.is_ok() {
        return;
    }
    if let Ok(info) = runtime.account_runtime().account_info().await {
        if let Err(error) = runtime
            .account_runtime()
            .restore_device_routing(&info.device_name)
            .await
        {
            tracing::warn!("Could not restore caller routing after daemon startup failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn daemon_owner_outlives_endpoint_until_cleanup_finishes() {
        let root = tempfile::tempdir().unwrap();
        let server = Server::reserve_in(root.path().to_path_buf()).await.unwrap();
        let cleanup_owner = server.owner_lease();
        server.publish().unwrap();
        assert!(Server::reserve_in(root.path().to_path_buf()).await.is_err());
        assert!(
            root.path().join("endpoint.json").exists(),
            "A competing start must not remove the current owner's discovery"
        );
        drop(server);
        assert!(!root.path().join("endpoint.json").exists());
        assert!(
            Server::reserve_in(root.path().to_path_buf()).await.is_err(),
            "A replacement daemon must wait for bot and account cleanup, even after discovery is withdrawn"
        );
        drop(cleanup_owner);
        assert!(Server::reserve_in(root.path().to_path_buf()).await.is_ok());
    }

    #[tokio::test]
    async fn stale_discovery_is_replaced_after_exclusive_owner_recovery() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("endpoint.json");
        std::fs::write(&path, b"old crashed owner").unwrap();
        let server = Server::reserve_in(root.path().to_path_buf()).await.unwrap();
        assert!(
            !path.exists(),
            "Stale discovery must not be advertised during startup"
        );
        server.publish().unwrap();
        let discovery: Discovery = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(discovery.version, VERSION);
        assert_eq!(discovery.port, server.listener.local_addr().unwrap().port());
        drop(server);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn management_authentication_precedes_all_effects_and_returns_state() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (version, token, accepted) in [
            (VERSION, "wrong", false),
            (VERSION + 1, "secret", false),
            (VERSION, "secret", true),
        ] {
            let effects = Arc::new(AtomicUsize::new(0));
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let count = effects.clone();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                serve_with(stream, "secret", move |request| async move {
                    assert_eq!(request.account_user_id, "account");
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"listenerRunning":true}))
                })
                .await
            });
            let mut stream = TcpStream::connect(address).await.unwrap();
            write_frame(
                &mut stream,
                &Request {
                    version,
                    token: token.into(),
                    command: RemoteControlRequest::Status,
                    account_user_id: "account".into(),
                    shutdown: false,
                },
            )
            .await
            .unwrap();
            let response = read_frame::<Response>(&mut stream).await;
            assert_eq!(response.is_ok(), accepted);
            assert_eq!(server.await.unwrap().is_ok(), accepted);
            assert_eq!(effects.load(Ordering::SeqCst), usize::from(accepted));
            if accepted {
                assert_eq!(response.unwrap().result.unwrap()["listenerRunning"], true);
            }
        }
    }

    #[tokio::test]
    async fn frame_bounds_and_closed_protocol() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_u32(MAX_FRAME as u32 + 1).await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(read_frame::<Request>(&mut stream)
            .await
            .unwrap_err()
            .to_string()
            .contains("length"));
        client.await.unwrap();
    }
}
