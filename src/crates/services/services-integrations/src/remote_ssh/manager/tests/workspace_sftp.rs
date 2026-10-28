//! Real SSH + SFTP protocol regressions with small advertised handle limits.
use super::*;
use russh_sftp::protocol::{
    Attrs, Data, ExtendedReply, FileAttributes, Handle as FileHandle, Name, OpenFlags, Packet,
    Status, Version,
};
use std::sync::atomic::AtomicUsize;
use tokio::io::AsyncReadExt;

const HANDLE_LIMIT: usize = 4;

#[derive(Default)]
struct State {
    opened: AtomicUsize,
    closed: AtomicUsize,
    live: AtomicUsize,
    channels: AtomicUsize,
    exec_calls: AtomicUsize,
    pause_open: AtomicBool,
    pause_read: AtomicBool,
    pause_dir: AtomicBool,
    pause_close: AtomicBool,
    fail_read: AtomicBool,
    fail_write: AtomicBool,
    fail_close: AtomicBool,
    requested: tokio::sync::Notify,
    release: tokio::sync::Notify,
    response_delay_ms: std::sync::atomic::AtomicU64,
}

struct SftpServer {
    state: Arc<State>,
    handles: HashMap<String, bool>,
    data: Vec<u8>,
}
impl Drop for SftpServer {
    fn drop(&mut self) {
        self.state
            .live
            .fetch_sub(self.handles.len(), Ordering::SeqCst);
    }
}
impl SftpServer {
    async fn open_handle(
        &mut self,
        id: u32,
        directory: bool,
    ) -> Result<FileHandle, SftpStatusCode> {
        if self.handles.len() >= HANDLE_LIMIT {
            return Err(SftpStatusCode::Failure);
        }
        let number = self.state.opened.fetch_add(1, Ordering::SeqCst);
        let handle = number.to_string();
        self.handles.insert(handle.clone(), directory);
        self.state.live.fetch_add(1, Ordering::SeqCst);
        if !directory && self.state.pause_open.swap(false, Ordering::SeqCst) {
            self.state.requested.notify_one();
            self.state.release.notified().await;
        }
        Ok(FileHandle { id, handle })
    }
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: SftpStatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn metadata() -> FileAttributes {
    FileAttributes {
        size: Some(4),
        permissions: Some(0o100644),
        ..Default::default()
    }
}
impl russh_sftp::server::Handler for SftpServer {
    type Error = SftpStatusCode;
    fn unimplemented(&self) -> Self::Error {
        SftpStatusCode::OpUnsupported
    }
    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let mut version = Version::new();
        version
            .extensions
            .insert("limits@openssh.com".into(), "1".into());
        Ok(version)
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        _data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        assert_eq!(request, "limits@openssh.com");
        let data = [262144_u64, 65536, 65536, HANDLE_LIMIT as u64]
            .into_iter()
            .flat_map(u64::to_be_bytes)
            .collect();
        Ok(Packet::ExtendedReply(ExtendedReply { id, data }))
    }
    async fn open(
        &mut self,
        id: u32,
        _filename: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<FileHandle, Self::Error> {
        if flags.contains(OpenFlags::TRUNCATE) {
            self.data.clear();
        }
        self.open_handle(id, false).await
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        if self.state.pause_close.swap(false, Ordering::SeqCst) {
            self.state.requested.notify_one();
            self.state.release.notified().await;
        }
        if self.state.fail_close.swap(false, Ordering::SeqCst) {
            return Err(SftpStatusCode::Failure);
        }
        self.handles
            .remove(&handle)
            .ok_or(SftpStatusCode::Failure)?;
        self.state.closed.fetch_add(1, Ordering::SeqCst);
        self.state.live.fetch_sub(1, Ordering::SeqCst);
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        assert!(self.handles.contains_key(&handle));
        if self.state.pause_read.swap(false, Ordering::SeqCst) {
            self.state.requested.notify_one();
            self.state.release.notified().await;
        }
        if self.state.fail_read.swap(false, Ordering::SeqCst) {
            return Err(SftpStatusCode::PermissionDenied);
        }
        let start = offset as usize;
        if start >= self.data.len() {
            return Err(SftpStatusCode::Eof);
        }
        Ok(Data {
            id,
            data: self.data[start..(start + len as usize).min(self.data.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        assert!(self.handles.contains_key(&handle));
        if self.state.fail_write.swap(false, Ordering::SeqCst) {
            return Err(SftpStatusCode::PermissionDenied);
        }
        let start = offset as usize;
        self.data.resize(self.data.len().max(start + data.len()), 0);
        self.data[start..start + data.len()].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn stat(&mut self, id: u32, _path: String) -> Result<Attrs, Self::Error> {
        Ok(Attrs {
            id,
            attrs: metadata(),
        })
    }
    async fn fstat(&mut self, id: u32, _handle: String) -> Result<Attrs, Self::Error> {
        Ok(Attrs {
            id,
            attrs: metadata(),
        })
    }
    async fn opendir(&mut self, id: u32, _path: String) -> Result<FileHandle, Self::Error> {
        self.open_handle(id, true).await
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        if self.state.pause_dir.swap(false, Ordering::SeqCst) {
            self.state.requested.notify_one();
            self.state.release.notified().await;
        }
        if self.state.fail_read.swap(false, Ordering::SeqCst) {
            return Err(SftpStatusCode::PermissionDenied);
        }
        let first = self.handles.get_mut(&handle).unwrap();
        if !*first {
            return Err(SftpStatusCode::Eof);
        }
        *first = false;
        Ok(Name {
            id,
            files: vec![SftpFile {
                filename: "file".into(),
                longname: String::new(),
                attrs: metadata(),
            }],
        })
    }
}

struct SshServer {
    openssh: Option<String>,
    state: Arc<State>,
    channels: HashMap<russh::ChannelId, russh::Channel<russh::server::Msg>>,
}
#[async_trait]
impl russh::server::Handler for SshServer {
    type Error = russh::Error;
    async fn auth_none(&mut self, _user: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        _session: &mut russh::server::Session,
    ) -> Result<bool, Self::Error> {
        self.channels.insert(channel.id(), channel);
        Ok(true)
    }
    #[cfg(unix)]
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        command: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        // This loopback fixture runs commands only against test-owned paths.
        // Keep the SSH execution path real while using the local POSIX shell.
        self.state.exec_calls.fetch_add(1, Ordering::SeqCst);
        session.channel_success(channel);
        let output = process_manager::create_tokio_command("sh")
            .arg("-c")
            .arg(std::str::from_utf8(command).unwrap())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        session.data(channel, russh::CryptoVec::from_slice(&output.stdout));
        session.extended_data(channel, 1, russh::CryptoVec::from_slice(&output.stderr));
        session.exit_status_request(channel, output.status.code().unwrap_or(1) as u32);
        session.eof(channel);
        session.close(channel);
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: russh::ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        session.channel_success(id);
        self.state.channels.fetch_add(1, Ordering::SeqCst);
        let channel = self.channels.remove(&id).unwrap();
        if let Some(executable) = &self.openssh {
            let mut command = process_manager::create_tokio_command(executable);
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let (mut reader, mut writer) = tokio::io::split(channel.into_stream());
            let state = self.state.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let input = async {
                    tokio::io::copy(&mut reader, &mut stdin).await?;
                    stdin.shutdown().await
                };
                let output = async {
                    // Delay complete SFTP response packets independently. A
                    // sleeping copy loop would serialize unrelated replies and
                    // misrepresent a network that supports pipelined requests.
                    let (send, mut receive) = tokio::sync::mpsc::channel(32);
                    let read = async move {
                        loop {
                            let size = match stdout.read_u32().await {
                                Ok(size) => size,
                                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                                    break
                                }
                                Err(error) => return Err(error),
                            };
                            let mut packet = vec![0; size as usize + 4];
                            packet[..4].copy_from_slice(&size.to_be_bytes());
                            stdout.read_exact(&mut packet[4..]).await?;
                            let ready = tokio::time::Instant::now()
                                + std::time::Duration::from_millis(
                                    state.response_delay_ms.load(Ordering::SeqCst),
                                );
                            if send.send((ready, packet)).await.is_err() {
                                break;
                            }
                        }
                        Ok::<_, std::io::Error>(())
                    };
                    let write = async {
                        while let Some((ready, packet)) = receive.recv().await {
                            tokio::time::sleep_until(ready).await;
                            writer.write_all(&packet).await?;
                        }
                        writer.shutdown().await
                    };
                    tokio::try_join!(read, write).map(|_| ())
                };
                tokio::select! {
                    _ = async { tokio::try_join!(input, output) } => {},
                    _ = child.wait() => {},
                }
                let _ = child.kill().await;
            });
            return Ok(());
        }
        let handler = SftpServer {
            state: self.state.clone(),
            handles: HashMap::new(),
            data: vec![0, 1, 254, 255],
        };
        tokio::spawn(russh_sftp::server::run(channel.into_stream(), handler));
        Ok(())
    }
}

struct Fixture {
    manager: Arc<SSHConnectionManager>,
    state: Arc<State>,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        Self::with_openssh(None).await
    }

    async fn with_openssh(openssh: Option<String>) -> Self {
        let state = Arc::new(State::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = SshServer {
            openssh,
            state: state.clone(),
            channels: HashMap::new(),
        };
        let config = Arc::new(russh::server::Config {
            keys: vec![KeyPair::generate_ed25519().unwrap()],
            ..Default::default()
        });
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let _ = russh::server::run_stream(config, socket, server)
                .await
                .unwrap()
                .await;
        });
        let mut handle = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            address,
            SSHHandler::with_verify_callback(|_, _, _| true),
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("sftp-test").await.unwrap());
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(SSHConnectionManager::new(dir.path().into()));
        let config = SSHConnectionConfig {
            id: "sftp-test".into(),
            name: "SFTP loopback fixture".into(),
            host: "127.0.0.1".into(),
            port: address.port(),
            username: "sftp-test".into(),
            auth: SSHAuthMethod::Agent {
                key_fingerprint: None,
                fallback_key_path: None,
            },
            default_workspace: None,
            proxy_jump: None,
            container: None,
            wsl: None,
            options: Default::default(),
        };
        manager.connections.write().await.insert(
            config.id.clone(),
            ActiveConnection {
                handle: Some(Arc::new(handle)),
                jump_handles: Vec::new(),
                effective_config: config.clone(),
                config,
                server_info: None,
                sftp_session: Arc::new(SftpCache::new()),
                bounded_sftp_session: Arc::new(BoundedSftpCache::new()),
                server_key: None,
                alive: Arc::new(AtomicBool::new(true)),
            },
        );
        Self {
            manager,
            state,
            task,
            _dir: dir,
        }
    }
    async fn drained(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.state.live.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
            // CLOSE packet receipt precedes the client's counter update. A
            // metadata round trip ensures that response was consumed as well.
            self.manager.sftp_stat("sftp-test", "/file").await.unwrap();
        })
        .await
        .expect("SFTP handles were not reclaimed");
    }
    async fn requested(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.state.requested.notified())
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "Diagnostic for the locked russh-sftp drop bug; not a contract for future dependency versions"]
async fn dependency_drop_reproduces_client_limit_with_zero_server_handles() {
    let f = Fixture::new().await;
    let session = f.manager.get_sftp("sftp-test").await.unwrap();
    let raw_high_level: &SftpSession = &session;
    for _ in 0..HANDLE_LIMIT {
        drop(raw_high_level.open("/file").await.unwrap());
        raw_high_level.metadata("/file").await.unwrap();
    }
    assert_eq!(f.state.live.load(Ordering::SeqCst), 0);
    assert!(matches!(
        raw_high_level.create("/file").await,
        Err(SftpError::Limited(_))
    ));
    assert!(matches!(
        raw_high_level.read_dir("/").await,
        Err(SftpError::Limited(_))
    ));
}

#[tokio::test]
async fn streamed_upload_reports_progress_and_stops_at_a_chunk_boundary() {
    let f = Fixture::new().await;
    let local = f._dir.path().join("upload");
    let bytes: Vec<u8> = (0..600_000).map(|index| (index % 251) as u8).collect();
    tokio::fs::write(&local, &bytes).await.unwrap();

    let mut progress = Vec::new();
    let written = f
        .manager
        .sftp_write_from_file_with_progress(
            "sftp-test",
            "/file",
            &local,
            u64::MAX,
            &mut |written, total| {
                progress.push((written, total));
                true
            },
        )
        .await
        .unwrap();
    assert_eq!(written, bytes.len() as u64);
    assert_eq!(
        f.manager.sftp_read("sftp-test", "/file").await.unwrap(),
        bytes
    );
    assert_eq!(
        progress.last(),
        Some(&(bytes.len() as u64, bytes.len() as u64))
    );
    assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));

    let cancelled = f
        .manager
        .sftp_write_from_file_with_progress(
            "sftp-test",
            "/file",
            &local,
            u64::MAX,
            &mut |written, _| written < 262_144,
        )
        .await;
    assert!(cancelled.is_err());
    assert!(
        f.manager
            .sftp_read("sftp-test", "/file")
            .await
            .unwrap()
            .len()
            < bytes.len(),
        "a cancelled stream must stop before the whole file reaches the remote"
    );
    assert_eq!(f.state.live.load(Ordering::SeqCst), 0);

    // The cancelled stream must not poison the next upload on the same channel.
    assert_eq!(
        f.manager
            .sftp_write_from_file("sftp-test", "/file", &local, u64::MAX)
            .await
            .unwrap(),
        bytes.len() as u64
    );
    assert_eq!(
        f.manager.sftp_read("sftp-test", "/file").await.unwrap(),
        bytes
    );
}

#[tokio::test]
async fn repeated_manager_transfers_release_handles_and_preserve_bytes() {
    let f = Fixture::new().await;
    let local = f._dir.path().join("upload");
    let bytes = vec![0, 128, 255, 10];
    tokio::fs::write(&local, &bytes).await.unwrap();
    for _ in 0..HANDLE_LIMIT * 3 {
        f.manager
            .sftp_write("sftp-test", "/file", &bytes)
            .await
            .unwrap();
        assert_eq!(
            f.manager.sftp_read("sftp-test", "/file").await.unwrap(),
            bytes
        );
        f.manager
            .sftp_write_with_progress("sftp-test", "/file", &bytes, 2, &mut |_, _| true)
            .await
            .unwrap();
        assert_eq!(
            f.manager
                .sftp_read_with_progress("sftp-test", "/file", 2, &mut |_, _| true)
                .await
                .unwrap(),
            bytes
        );
        assert_eq!(
            f.manager
                .sftp_write_from_file("sftp-test", "/file", &local, 4)
                .await
                .unwrap(),
            4
        );
        assert_eq!(
            f.manager
                .sftp_read_dir("sftp-test", "/")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(f.state.live.load(Ordering::SeqCst), 0);
    }
    assert_eq!(
        f.state.channels.load(Ordering::SeqCst),
        2,
        "reuse file and directory subsystems"
    );
}

#[tokio::test]
async fn cancelled_progress_and_dropped_streams_reclaim_handles() {
    let f = Fixture::new().await;
    for _ in 0..HANDLE_LIMIT * 2 {
        assert!(f
            .manager
            .sftp_read_with_progress("sftp-test", "/file", 1, &mut |_, _| false)
            .await
            .is_err());
        f.drained().await;
        assert!(f
            .manager
            .sftp_write_with_progress("sftp-test", "/file", &[1, 2, 3, 4], 1, &mut |_, _| false)
            .await
            .is_err());
        f.drained().await;
        let mut reader = f
            .manager
            .open_workspace_file_read("sftp-test", "/file")
            .await
            .unwrap();
        let mut byte = [0];
        reader.read_exact(&mut byte).await.unwrap();
        drop(reader);
        f.drained().await;
    }
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_during_open_and_read_closes_late_handles() {
    let f = Fixture::new().await;
    for opening in [true, false] {
        if opening {
            f.state.pause_open.store(true, Ordering::SeqCst);
        } else {
            f.state.pause_read.store(true, Ordering::SeqCst);
        }
        let manager = f.manager.clone();
        let caller = tokio::spawn(async move { manager.sftp_read("sftp-test", "/file").await });
        f.requested().await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        f.state.release.notify_one();
        f.drained().await;
        f.manager.sftp_read("sftp-test", "/file").await.unwrap();
    }
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn io_errors_and_close_failure_do_not_poison_following_transfers() {
    let f = Fixture::new().await;
    for _ in 0..HANDLE_LIMIT * 2 {
        f.state.fail_read.store(true, Ordering::SeqCst);
        assert!(f.manager.sftp_read("sftp-test", "/file").await.is_err());
        f.drained().await;
    }
    f.state.fail_write.store(true, Ordering::SeqCst);
    assert!(f
        .manager
        .sftp_write("sftp-test", "/file", &[1])
        .await
        .is_err());
    f.drained().await;
    f.state.fail_close.store(true, Ordering::SeqCst);
    assert!(f
        .manager
        .sftp_write("sftp-test", "/file", &[2])
        .await
        .unwrap_err()
        .to_string()
        .contains("close"));
    f.manager
        .sftp_write("sftp-test", "/file", &[3])
        .await
        .unwrap();
    assert_eq!(
        f.manager.sftp_read("sftp-test", "/file").await.unwrap(),
        vec![3]
    );
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn directory_errors_and_cancellation_preserve_ssh_and_sibling_file() {
    let f = Fixture::new().await;
    let mut sibling = f
        .manager
        .open_workspace_file_read("sftp-test", "/file")
        .await
        .unwrap();
    for _ in 0..HANDLE_LIMIT * 2 {
        f.state.fail_read.store(true, Ordering::SeqCst);
        assert!(f.manager.sftp_read_dir("sftp-test", "/").await.is_err());
        assert_eq!(f.state.live.load(Ordering::SeqCst), 1);
    }
    f.state.pause_dir.store(true, Ordering::SeqCst);
    let manager = f.manager.clone();
    let caller = tokio::spawn(async move { manager.sftp_read_dir("sftp-test", "/").await });
    f.requested().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    f.state.release.notify_one();
    assert_eq!(
        f.manager
            .sftp_read_dir_bounded("sftp-test", "/", 1)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut bytes = Vec::new();
    sibling.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, vec![0, 1, 254, 255]);
    drop(sibling);
    f.drained().await;
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 3);
    assert!(f
        .manager
        .connections
        .read()
        .await
        .get("sftp-test")
        .unwrap()
        .alive
        .load(Ordering::SeqCst));
}

#[tokio::test]
async fn concurrent_transfers_reuse_the_negotiated_handle_capacity() {
    let f = Fixture::new().await;
    for _ in 0..8 {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..HANDLE_LIMIT {
            let manager = f.manager.clone();
            tasks.spawn(async move { manager.sftp_read("sftp-test", "/file").await.unwrap() });
        }
        while let Some(result) = tasks.join_next().await {
            assert_eq!(result.unwrap(), vec![0, 1, 254, 255]);
        }
        assert_eq!(f.state.live.load(Ordering::SeqCst), 0);
    }
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn timed_out_create_retires_only_sftp_without_replaying_mutation() {
    let f = Fixture::new().await;
    f.manager
        .get_sftp("sftp-test")
        .await
        .unwrap()
        .set_timeout(1);
    f.state.pause_open.store(true, Ordering::SeqCst);
    assert!(f
        .manager
        .sftp_write("sftp-test", "/file", &[7])
        .await
        .is_err());
    assert_eq!(
        f.state.opened.load(Ordering::SeqCst),
        1,
        "CREATE must not be replayed"
    );
    f.state.release.notify_one();
    f.manager
        .sftp_write("sftp-test", "/file", &[8])
        .await
        .unwrap();
    assert_eq!(
        f.manager.sftp_read("sftp-test", "/file").await.unwrap(),
        vec![8]
    );
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 2);
}

#[tokio::test]
#[ignore = "Set OPENBITFUN_TEST_SFTP_SERVER to the OpenSSH sftp-server executable"]
async fn openssh_real_files_over_loopback_ssh() {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER")
        .expect("OpenSSH sftp-server executable required");
    let f = Fixture::with_openssh(Some(executable)).await;
    let path = f
        ._dir
        .path()
        .join("remote.bin")
        .to_str()
        .unwrap()
        .to_owned();
    let directory = f._dir.path().to_str().unwrap().to_owned();
    let bytes: Vec<u8> = (0..65536).map(|n| n as u8).collect();
    for _ in 0..128 {
        f.manager
            .sftp_write("sftp-test", &path, &bytes)
            .await
            .unwrap();
        assert_eq!(
            f.manager.sftp_read("sftp-test", &path).await.unwrap(),
            bytes
        );
        assert_eq!(
            f.manager
                .sftp_read_dir("sftp-test", &directory)
                .await
                .unwrap()
                .len(),
            1
        );
    }
    let mut stream = f
        .manager
        .open_workspace_file_read("sftp-test", &path)
        .await
        .unwrap();
    stream.seek(std::io::SeekFrom::Start(100)).await.unwrap();
    let mut tail = Vec::new();
    stream.read_to_end(&mut tail).await.unwrap();
    assert_eq!(tail, bytes[100..]);
    drop(stream);
    assert!(f
        .manager
        .sftp_read_with_progress("sftp-test", &path, 1024, &mut |_, _| false)
        .await
        .is_err());
    // A rejected directory-as-file open must close its FSTAT-checked handle.
    assert!(f
        .manager
        .open_workspace_file_read("sftp-test", &directory)
        .await
        .is_err());
    let session = f.manager.get_sftp("sftp-test").await.unwrap();
    let mut file = session.create(&path).await.unwrap();
    file.write_all(&bytes).await.unwrap();
    file.shutdown().await.unwrap();
    file.shutdown().await.unwrap(); // idempotent; must not double-CLOSE a reused id
    drop(file);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    assert_eq!(
        f.manager.sftp_read("sftp-test", &path).await.unwrap(),
        bytes
    );
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 2);
}

#[cfg(feature = "remote-connect")]
#[tokio::test]
#[ignore = "Set OPENBITFUN_TEST_SFTP_SERVER to the OpenSSH sftp-server executable"]
async fn openssh_html_preview_reads_nested_site_resources() {
    use crate::remote_connect::{
        file_projection::SessionFileTarget, html_preview::HtmlPreviewSource,
    };
    use crate::remote_ssh::workspace_services::RemoteWorkspaceFs;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use openbitfun_product_domains::html_preview::{
        HtmlPreviewErrorCode, HtmlPreviewResourceRequest, PREVIEW_CHUNK_BYTES,
    };
    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER").unwrap();
    let f = Fixture::with_openssh(Some(executable)).await;
    let root = f._dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("website/dist/assets")).unwrap();
    std::fs::write(
        root.join("website/dist/index.html"),
        b"<script src='/assets/app.js'></script>",
    )
    .unwrap();
    std::fs::write(
        root.join("website/dist/assets/app.js"),
        b"window.sshLoaded=true",
    )
    .unwrap();
    std::fs::write(
        root.join("website/dist/assets/app.css"),
        b"body{color:green}",
    )
    .unwrap();
    std::fs::write(
        root.join("website/dist/assets/image.png"),
        [137, 80, 78, 71, 0, 255],
    )
    .unwrap();
    std::fs::write(root.join("website/shared.css"), b"parent-style").unwrap();
    let large = vec![53; PREVIEW_CHUNK_BYTES + 17];
    std::fs::write(root.join("website/dist/assets/large.js"), &large).unwrap();
    let service = crate::remote_ssh::RemoteFileService::new(Arc::new(tokio::sync::RwLock::new(
        Some(f.manager.as_ref().clone()),
    )));
    let entry = root
        .join("website/dist/index.html")
        .to_string_lossy()
        .into_owned();
    let source = HtmlPreviewSource::new(
        SessionFileTarget {
            fs: Arc::new(RemoteWorkspaceFs::new("sftp-test".into(), service)),
            root: root.to_string_lossy().into_owned(),
            path: entry.clone(),
            remote: true,
        },
        "ssh-workspace",
    )
    .await
    .unwrap();
    for (path, expected) in [
        ("assets/app.js", b"window.sshLoaded=true".as_slice()),
        (
            "website/dist/assets/app.css",
            b"body{color:green}".as_slice(),
        ),
        ("assets/image.png", [137, 80, 78, 71, 0, 255].as_slice()),
        ("website/shared.css", b"parent-style".as_slice()),
    ] {
        let file = source
            .read(&HtmlPreviewResourceRequest {
                workspace_id: "ssh-workspace".into(),
                file_path: entry.clone(),
                resource_path: Some(path.into()),
                metadata_only: false,
                offset: 0,
                expected_source: None,
                expected_revision: None,
            })
            .await
            .unwrap();
        assert_eq!(BASE64.decode(file.content_base64).unwrap(), expected);
    }
    let mut chunk_request = HtmlPreviewResourceRequest {
        workspace_id: "ssh-workspace".into(),
        file_path: entry,
        resource_path: Some("assets/large.js".into()),
        metadata_only: false,
        offset: 0,
        expected_source: None,
        expected_revision: None,
    };
    let first = source.read(&chunk_request).await.unwrap();
    let mut content = BASE64.decode(first.content_base64).unwrap();
    assert_eq!(content.len(), PREVIEW_CHUNK_BYTES);
    chunk_request.offset = content.len() as u64;
    chunk_request.expected_source = Some(first.source);
    chunk_request.expected_revision = Some(first.revision);
    content.extend(
        BASE64
            .decode(source.read(&chunk_request).await.unwrap().content_base64)
            .unwrap(),
    );
    assert_eq!(content, large);
    chunk_request.resource_path = Some("../private-file".into());
    assert_eq!(
        source.read(&chunk_request).await.unwrap_err().code,
        HtmlPreviewErrorCode::InvalidPath
    );
    assert!(
        f.state.channels.load(Ordering::SeqCst) > 0,
        "Reads must traverse a real SSH/SFTP channel"
    );
}

#[cfg(feature = "remote-connect")]
#[tokio::test]
#[ignore = "Performance experiment: set OPENBITFUN_TEST_SFTP_SERVER; adds 40 ms to each SFTP reply"]
async fn openssh_html_preview_loading_benchmark() {
    use crate::remote_connect::{
        file_projection::SessionFileTarget,
        html_preview::{transfer::tests::benchmark_loading, HtmlPreviewSource},
    };
    use crate::remote_ssh::workspace_services::RemoteWorkspaceFs;
    use openbitfun_product_domains::html_preview::HtmlPreviewResourceRequest;
    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER").unwrap();
    let f = Fixture::with_openssh(Some(executable)).await;
    f.state.response_delay_ms.store(40, Ordering::SeqCst);
    let root = f._dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("site/assets")).unwrap();
    let files = vec![
        ("site/index.html".to_string(), b"<link rel='stylesheet' href='assets/app.css'><script src='assets/app.js'></script><img src='assets/image.png'>".to_vec()),
        ("site/assets/app.css".to_string(), vec![b'c'; 96 * 1024]),
        ("site/assets/app.js".to_string(), vec![b'j'; 2 * 1024 * 1024]),
        ("site/assets/image.png".to_string(), vec![53; 512 * 1024]),
        ("site/assets/font.woff2".to_string(), vec![19; 128 * 1024]),
    ];
    for (path, bytes) in &files {
        std::fs::write(root.join(path), bytes).unwrap();
    }
    let service = crate::remote_ssh::RemoteFileService::new(Arc::new(tokio::sync::RwLock::new(
        Some(f.manager.as_ref().clone()),
    )));
    let entry = root.join("site/index.html").to_string_lossy().into_owned();
    let source = HtmlPreviewSource::new(
        SessionFileTarget {
            fs: Arc::new(RemoteWorkspaceFs::new("sftp-test".into(), service)),
            root: root.to_string_lossy().into_owned(),
            path: entry.clone(),
            remote: true,
        },
        "ssh-workspace",
    )
    .await
    .unwrap();
    benchmark_loading(
        Arc::new(source),
        HtmlPreviewResourceRequest {
            workspace_id: "ssh-workspace".into(),
            file_path: entry,
            resource_path: None,
            metadata_only: false,
            offset: 0,
            expected_source: None,
            expected_revision: None,
        },
        files,
        "ssh-sftp-40ms",
    )
    .await;
    assert!(f.state.channels.load(Ordering::SeqCst) > 0);
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Set OPENBITFUN_TEST_SFTP_SERVER to the OpenSSH sftp-server executable"]
async fn openssh_directory_symlink_browsing() {
    use std::os::unix::fs::symlink;
    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER")
        .expect("OpenSSH sftp-server executable required");
    let f = Fixture::with_openssh(Some(executable)).await;
    let service = crate::remote_ssh::RemoteFileService::new(Arc::new(tokio::sync::RwLock::new(
        Some(f.manager.as_ref().clone()),
    )));
    let directory = f._dir.path().join("target directory");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("sentinel.txt"), b"keep").unwrap();
    symlink("..", directory.join("parent-link")).unwrap();
    symlink(&directory, f._dir.path().join("absolute-link")).unwrap();
    symlink("target directory", f._dir.path().join("relative-link")).unwrap();
    symlink("relative-link", f._dir.path().join("chained-link")).unwrap();
    symlink("missing", f._dir.path().join("broken-link")).unwrap();
    symlink(
        "target directory/sentinel.txt",
        f._dir.path().join("file-link"),
    )
    .unwrap();
    symlink("loop-link", f._dir.path().join("loop-link")).unwrap();

    let entries = service
        .read_dir("sftp-test", f._dir.path().to_str().unwrap())
        .await
        .unwrap();
    for name in ["absolute-link", "relative-link", "chained-link"] {
        let entry = entries.iter().find(|entry| entry.name == name).unwrap();
        assert!(entry.is_symlink);
        assert!(!entry.is_dir, "listing must retain no-follow metadata");
        assert!(service.is_dir("sftp-test", &entry.path).await.unwrap());
        let children = service.read_dir("sftp-test", &entry.path).await.unwrap();
        assert_eq!(children.len(), 2);
        let file = children
            .iter()
            .find(|child| child.name == "sentinel.txt")
            .unwrap();
        assert_eq!(file.path, format!("{}/sentinel.txt", entry.path));
        let link = children
            .iter()
            .find(|child| child.name == "parent-link")
            .unwrap();
        assert!(link.is_symlink && !link.is_dir);
    }
    for name in ["file-link", "broken-link", "loop-link"] {
        let path = f._dir.path().join(name);
        assert!(service
            .read_dir("sftp-test", path.to_str().unwrap())
            .await
            .is_err());
    }
    service
        .remove_dir_all(
            "sftp-test",
            f._dir.path().join("relative-link").to_str().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(directory.join("sentinel.txt")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn cancellation_during_close_finishes_the_existing_close_once() {
    let f = Fixture::new().await;
    for _ in 0..HANDLE_LIMIT * 2 {
        f.state.pause_close.store(true, Ordering::SeqCst);
        let manager = f.manager.clone();
        let caller =
            tokio::spawn(async move { manager.sftp_write("sftp-test", "/file", &[42]).await });
        f.requested().await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        f.state.release.notify_one();
        f.drained().await;
    }
    assert_eq!(
        f.state.opened.load(Ordering::SeqCst),
        f.state.closed.load(Ordering::SeqCst)
    );
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_directory_waiter_detects_retirement_after_acquiring_the_lock() {
    let f = Fixture::new().await;
    let session = f.manager.get_bounded_sftp("sftp-test").await.unwrap();
    let lock = session.channel.read_lock.lock().await;
    let stale = session.clone();
    let waiter = tokio::spawn(async move {
        SSHConnectionManager::read_bounded_sftp_entries(&stale, "/", 1).await
    });
    drop(BoundedSftpReadGuard::new(session.channel.clone()));
    drop(lock);
    assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert_eq!(
        f.manager
            .sftp_read_dir("sftp-test", "/")
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.state.channels.load(Ordering::SeqCst), 2);
    assert_eq!(f.state.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "Set OPENBITFUN_TEST_SFTP_SERVER to the OpenSSH sftp-server executable"]
async fn openssh_streaming_upload_create_is_exclusive_and_closes_handle() {
    use tokio::io::AsyncWriteExt;
    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER")
        .expect("OpenSSH sftp-server executable required");
    let f = Fixture::with_openssh(Some(executable)).await;
    let path = f
        ._dir
        .path()
        .join("upload.tmp")
        .to_string_lossy()
        .into_owned();
    let mut writer = f
        .manager
        .open_workspace_file_write_new("sftp-test", &path)
        .await
        .unwrap();
    let chunk = vec![29u8; 65536];
    for _ in 0..32 {
        writer.write_all(&chunk).await.unwrap();
    }
    writer.flush().await.unwrap();
    writer.shutdown().await.unwrap();
    drop(writer);
    assert!(f
        .manager
        .open_workspace_file_write_new("sftp-test", &path)
        .await
        .is_err());
    let data = f.manager.sftp_read("sftp-test", &path).await.unwrap();
    assert_eq!(data.len(), chunk.len() * 32);
    assert!(data.iter().all(|byte| *byte == 29));
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Set OPENBITFUN_TEST_SFTP_SERVER to the OpenSSH sftp-server executable"]
async fn openssh_skill_package_sync_reads_executes_and_repairs_remote_resources() {
    use crate::remote_ssh::workspace_services::{RemoteWorkspaceFs, RemoteWorkspaceShell};
    use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspaceShell};
    use openbitfun_services_core::skill_package_sync::sync_local_skill_package;
    use std::os::unix::fs::PermissionsExt;

    let executable = std::env::var("OPENBITFUN_TEST_SFTP_SERVER")
        .expect("OpenSSH sftp-server executable required");
    let fixture = Fixture::with_openssh(Some(executable)).await;
    let local_root = fixture._dir.path().join("local user skill");
    let remote_root = fixture._dir.path().join("remote workspace");
    let cache_root = remote_root.join(".skill-cache");
    for directory in ["scripts", "references", "templates"] {
        std::fs::create_dir_all(local_root.join(directory)).unwrap();
    }
    std::fs::create_dir(&remote_root).unwrap();
    std::fs::write(
        local_root.join("SKILL.md"),
        "Read references/guide.md and run scripts/hello.sh.",
    )
    .unwrap();
    std::fs::write(local_root.join("references/guide.md"), "remote reference").unwrap();
    std::fs::write(local_root.join("templates/binary.dat"), [0, 255, 1, 13, 10]).unwrap();
    std::fs::write(
        local_root.join("references/quoted ' Unicode 你好.txt"),
        "quoted path",
    )
    .unwrap();
    let script = local_root.join("scripts/hello.sh");
    std::fs::write(&script, "#!/bin/sh\nscript_dir=${0%/*}\ncat \"$script_dir/../references/guide.md\"\nprintf '\\n'\npwd -P\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let file_service = crate::remote_ssh::RemoteFileService::new(Arc::new(
        tokio::sync::RwLock::new(Some(fixture.manager.as_ref().clone())),
    ));
    let fs = RemoteWorkspaceFs::new("sftp-test".into(), file_service);
    let exclusive_directory = remote_root.join("exclusive-directory");
    fs.create_dir_new(exclusive_directory.to_str().unwrap())
        .await
        .unwrap();
    assert!(fs
        .create_dir_new(exclusive_directory.to_str().unwrap())
        .await
        .is_err());
    fs.remove_dir(exclusive_directory.to_str().unwrap(), false)
        .await
        .unwrap();
    let shell = RemoteWorkspaceShell::new(
        "sftp-test".into(),
        fixture.manager.as_ref().clone(),
        remote_root.to_str().unwrap().into(),
    );
    let cache = cache_root.to_str().unwrap();
    let first = sync_local_skill_package(
        &local_root,
        cache,
        remote_root.to_str().unwrap(),
        "user::test::hello",
        &fs,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.state.exec_calls.load(Ordering::SeqCst),
        0,
        "Synchronization must use SSH/SFTP file IO without Python or shell execution"
    );
    assert!(!first.reused);
    assert!(first.path.starts_with(cache));
    assert!(!first.path.contains("local user skill"));
    let remote_reference = format!("{}/references/guide.md", first.path);
    let remote_template = format!("{}/templates/binary.dat", first.path);
    assert_eq!(
        fs.read_file_text(&remote_reference).await.unwrap(),
        "remote reference"
    );
    assert_eq!(
        fs.read_file(&remote_template).await.unwrap(),
        [0, 255, 1, 13, 10]
    );
    let reference_before = fs
        .metadata(&remote_reference, false)
        .await
        .unwrap()
        .unwrap();
    let attributes_before = fixture
        .manager
        .sftp_stat("sftp-test", &remote_reference)
        .await
        .unwrap();
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    fs.set_modified(&remote_reference, modified).await.unwrap();
    let reference_after = fs
        .metadata(&remote_reference, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reference_after.modified, Some(modified));
    let attributes_after = fixture
        .manager
        .sftp_stat("sftp-test", &remote_reference)
        .await
        .unwrap();
    assert_eq!(
        attributes_after.atime, attributes_before.atime,
        "SFTP v3's paired access time must be preserved when changing modification time"
    );
    assert_eq!(
        (attributes_after.uid, attributes_after.gid),
        (attributes_before.uid, attributes_before.gid),
        "Metadata updates must not change ownership"
    );
    assert_eq!(
        reference_after.size, reference_before.size,
        "SFTP mtime updates must not truncate the synchronized file"
    );
    assert_eq!(
        reference_after.permissions, reference_before.permissions,
        "SFTP mtime updates must not change executable or data permissions"
    );
    assert_eq!(
        fs.read_file_text(&remote_reference).await.unwrap(),
        "remote reference"
    );
    assert_eq!(
        fs.read_file_text(&format!(
            "{}/references/quoted ' Unicode 你好.txt",
            first.path
        ))
        .await
        .unwrap(),
        "quoted path"
    );
    let script_command =
        crate::remote_ssh::shell::quote_arg(&format!("{}/scripts/hello.sh", first.path));
    let (stdout, stderr, status) = shell.exec(&script_command, Some(30_000)).await.unwrap();
    assert_eq!(status, 0, "{stderr}");
    assert_eq!(
        fixture.state.exec_calls.load(Ordering::SeqCst),
        1,
        "The selected Skill script is the only remote command"
    );
    assert_eq!(
        stdout,
        format!(
            "remote reference\n{}\n",
            remote_root.canonicalize().unwrap().display()
        )
    );

    let unchanged = sync_local_skill_package(
        &local_root,
        cache,
        remote_root.to_str().unwrap(),
        "user::test::hello",
        &fs,
        None,
    )
    .await
    .unwrap();
    assert!(unchanged.reused);
    assert_eq!(unchanged.path, first.path);
    fs.write_file(&remote_reference, b"remote corruption")
        .await
        .unwrap();
    let repaired = sync_local_skill_package(
        &local_root,
        cache,
        remote_root.to_str().unwrap(),
        "user::test::hello",
        &fs,
        None,
    )
    .await
    .unwrap();
    assert!(!repaired.reused);
    assert_ne!(
        repaired.path, first.path,
        "Repair must publish a new immutable generation instead of moving an active path"
    );
    assert_eq!(
        fs.read_file_text(&remote_reference).await.unwrap(),
        "remote corruption",
        "Previously published generations must remain in place during repair"
    );
    assert_eq!(
        fs.read_file_text(&format!("{}/references/guide.md", repaired.path))
            .await
            .unwrap(),
        "remote reference"
    );

    let repaired_reuse = sync_local_skill_package(
        &local_root,
        cache,
        remote_root.to_str().unwrap(),
        "user::test::hello",
        &fs,
        None,
    )
    .await
    .unwrap();
    assert!(repaired_reuse.reused);
    assert_eq!(repaired_reuse.path, repaired.path);

    std::fs::write(
        local_root.join("references/guide.md"),
        "updated local reference",
    )
    .unwrap();
    std::fs::remove_file(local_root.join("templates/binary.dat")).unwrap();
    let updated = sync_local_skill_package(
        &local_root,
        cache,
        remote_root.to_str().unwrap(),
        "user::test::hello",
        &fs,
        None,
    )
    .await
    .unwrap();
    assert!(!updated.reused);
    assert_ne!(updated.content_hash, first.content_hash);
    assert_eq!(
        fs.read_file_text(&format!("{}/references/guide.md", updated.path))
            .await
            .unwrap(),
        "updated local reference"
    );
    assert!(!fs
        .exists(&format!("{}/templates/binary.dat", updated.path))
        .await
        .unwrap());
    assert_eq!(
        fixture.state.exec_calls.load(Ordering::SeqCst),
        1,
        "Cache checking, corruption repair and updates must not execute target commands"
    );
}
