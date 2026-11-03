//! Own SFTP files through CLOSE acknowledgement, including cancelled callers.
//!
//! russh-sftp 2.3 File::drop sends CLOSE without decrementing the client's
//! handle counter. Explicit shutdown is required even for read-only files.
use super::manager::sftp_error_may_be_stale_transport;
use russh_sftp::client::{
    error::Error,
    fs::{File, Metadata},
    SftpSession,
};
use russh_sftp::protocol::FileAttributes;
use std::{
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, AsyncWriteExt, ReadBuf};

pub(super) struct ManagedSftpSession {
    session: Arc<SftpSession>,
    retired: AtomicBool,
}

impl std::ops::Deref for ManagedSftpSession {
    type Target = SftpSession;
    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl ManagedSftpSession {
    pub(super) fn new(session: SftpSession) -> Self {
        Self {
            session: Arc::new(session),
            retired: AtomicBool::new(false),
        }
    }

    pub(super) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    async fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        let _ = self.session.close().await;
    }

    pub(super) async fn open(self: &Arc<Self>, path: &str) -> Result<ManagedSftpFile, Error> {
        self.open_owned(path, 0).await
    }

    pub(super) async fn create(self: &Arc<Self>, path: &str) -> Result<ManagedSftpFile, Error> {
        self.open_owned(path, 1).await
    }

    pub(super) async fn create_new(self: &Arc<Self>, path: &str) -> Result<ManagedSftpFile, Error> {
        self.open_owned(path, 2).await
    }

    /// Record that a request found this subsystem's channel unusable.
    ///
    /// russh-sftp never revives a session whose writer task stopped: it answers
    /// every later request with `UnexpectedBehavior("session closed")`. Without
    /// this flag the manager would keep serving the dead cached session, so one
    /// closed channel would fail every file operation until the app restarts.
    /// Marking it retired makes the next request open a new subsystem channel.
    fn record<T>(&self, result: Result<T, Error>) -> Result<T, Error> {
        if let Err(error) = &result {
            if sftp_error_may_be_stale_transport(error) {
                self.retired.store(true, Ordering::Release);
            }
        }
        result
    }

    pub(super) async fn metadata(&self, path: &str) -> Result<Metadata, Error> {
        self.record(self.session.metadata(path).await)
    }

    pub(super) async fn symlink_metadata(&self, path: &str) -> Result<Metadata, Error> {
        self.record(self.session.symlink_metadata(path).await)
    }

    pub(super) async fn try_exists(&self, path: &str) -> Result<bool, Error> {
        self.record(self.session.try_exists(path).await)
    }

    pub(super) async fn create_dir(&self, path: &str) -> Result<(), Error> {
        self.record(self.session.create_dir(path).await)
    }

    pub(super) async fn remove_file(&self, path: &str) -> Result<(), Error> {
        self.record(self.session.remove_file(path).await)
    }

    pub(super) async fn remove_dir(&self, path: &str) -> Result<(), Error> {
        self.record(self.session.remove_dir(path).await)
    }

    pub(super) async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), Error> {
        self.record(self.session.rename(old_path, new_path).await)
    }

    pub(super) async fn set_metadata(
        &self,
        path: &str,
        attributes: FileAttributes,
    ) -> Result<(), Error> {
        self.record(self.session.set_metadata(path, attributes).await)
    }

    async fn open_owned(self: &Arc<Self>, path: &str, mode: u8) -> Result<ManagedSftpFile, Error> {
        let session = self.clone();
        let path = path.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        // Keep OPEN alive until its reply. If the caller disappears, the
        // undelivered guard still closes a late handle. Never replay CREATE.
        tokio::spawn(async move {
            if send.is_closed() {
                return;
            }
            let result = if mode == 2 {
                use russh_sftp::protocol::OpenFlags;
                session
                    .session
                    .open_with_flags(
                        path,
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    )
                    .await
            } else if mode == 1 {
                session.session.create(path).await
            } else {
                session.session.open(path).await
            };
            if matches!(
                &result,
                Err(Error::Timeout
                    | Error::IO(_)
                    | Error::UnexpectedBehavior(_)
                    | Error::UnexpectedPacket)
            ) {
                // A timed-out OPEN may have succeeded remotely without a known
                // handle; retire only this SFTP channel to reclaim that handle.
                session.retire().await;
            }
            let result = result.map(|file| ManagedSftpFile {
                file: Some(file),
                session,
                runtime: tokio::runtime::Handle::current(),
            });
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| Error::UnexpectedBehavior("SFTP open owner stopped".into()))?
    }
}

pub(super) struct ManagedSftpFile {
    file: Option<File>,
    session: Arc<ManagedSftpSession>,
    runtime: tokio::runtime::Handle,
}

impl ManagedSftpFile {
    pub(super) async fn metadata(&self) -> Result<Metadata, Error> {
        self.file.as_ref().expect("open SFTP file").metadata().await
    }

    pub(super) async fn close(&mut self) -> io::Result<()> {
        self.shutdown().await
    }

    fn file_mut(&mut self) -> io::Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "SFTP file is closed"))
    }
}

impl Drop for ManagedSftpFile {
    fn drop(&mut self) {
        if let Some(mut file) = self.file.take() {
            let session = self.session.clone();
            self.runtime.spawn(async move {
                if let Err(error) = file.shutdown().await {
                    log::warn!("SFTP file cleanup failed; retiring subsystem: {}", error);
                    session.retire().await;
                }
            });
        }
    }
}

impl AsyncRead for ManagedSftpFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(self.file_mut()?).poll_read(cx, buf)
    }
}
impl AsyncWrite for ManagedSftpFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(self.file_mut()?).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(self.file_mut()?).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(file) = self.file.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        let result = std::task::ready!(Pin::new(file).poll_shutdown(cx));
        if result.is_err() {
            // Do not publish a poisoned counter/channel to another operation.
            self.session.retired.store(true, Ordering::Release);
            let session = self.session.clone();
            self.runtime.spawn(async move {
                session.retire().await;
            });
        }
        self.file.take();
        Poll::Ready(result)
    }
}
impl AsyncSeek for ManagedSftpFile {
    fn start_seek(mut self: Pin<&mut Self>, pos: io::SeekFrom) -> io::Result<()> {
        Pin::new(self.file_mut()?).start_seek(pos)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(self.file_mut()?).poll_complete(cx)
    }
}
