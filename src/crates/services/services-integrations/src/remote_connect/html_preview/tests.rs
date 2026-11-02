use super::*;
use openbitfun_runtime_ports::{WorkspaceDirEntry, WorkspaceReader};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};

#[derive(Clone)]
struct Node {
    metadata: WorkspaceMetadata,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct RemoteFs {
    nodes: Mutex<BTreeMap<String, Node>>,
    reads: Mutex<Vec<String>>,
    offline: AtomicBool,
    truncate: AtomicBool,
}

impl RemoteFs {
    fn file(&self, path: &str, bytes: &[u8]) {
        let mut nodes = self.nodes.lock().unwrap();
        let mut ancestor = String::new();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            ancestor.push('/');
            ancestor.push_str(part);
            nodes.insert(
                ancestor.clone(),
                Node {
                    metadata: WorkspaceMetadata {
                        kind: if ancestor == path {
                            WorkspacePathKind::File
                        } else {
                            WorkspacePathKind::Directory
                        },
                        size: Some(bytes.len() as u64),
                        modified: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(10)),
                        permissions: None,
                    },
                    bytes: if ancestor == path {
                        bytes.to_vec()
                    } else {
                        vec![]
                    },
                },
            );
        }
    }
}

#[async_trait::async_trait]
impl WorkspaceFileSystem for RemoteFs {
    fn join_path(&self, root: &str, components: &[&str]) -> String {
        format!("{}/{}", root.trim_end_matches('/'), components.join("/"))
    }
    async fn metadata(
        &self,
        path: &str,
        follow: bool,
    ) -> anyhow::Result<Option<WorkspaceMetadata>> {
        assert!(!follow, "Preview must use no-follow metadata");
        anyhow::ensure!(
            !self.offline.load(Ordering::SeqCst),
            "SSH connection is offline"
        );
        Ok(self
            .nodes
            .lock()
            .unwrap()
            .get(path)
            .map(|node| node.metadata.clone()))
    }
    async fn open_read(&self, path: &str) -> anyhow::Result<WorkspaceReader> {
        anyhow::ensure!(
            !self.offline.load(Ordering::SeqCst),
            "SSH connection is offline"
        );
        self.reads.lock().unwrap().push(path.into());
        let mut bytes = self.nodes.lock().unwrap().get(path).unwrap().bytes.clone();
        if self.truncate.load(Ordering::SeqCst) {
            bytes.pop();
        }
        Ok(Box::new(std::io::Cursor::new(bytes)))
    }
    async fn read_file(&self, _: &str) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("whole-file reads must not be used")
    }
    async fn read_file_text(&self, _: &str) -> anyhow::Result<String> {
        anyhow::bail!("unused")
    }
    async fn write_file(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
        anyhow::bail!("read-only")
    }
    async fn exists(&self, _: &str) -> anyhow::Result<bool> {
        anyhow::bail!("unused")
    }
    async fn is_file(&self, _: &str) -> anyhow::Result<bool> {
        anyhow::bail!("unused")
    }
    async fn is_dir(&self, _: &str) -> anyhow::Result<bool> {
        anyhow::bail!("unused")
    }
    async fn read_dir(&self, _: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        anyhow::bail!("unused")
    }
}

fn request(resource: Option<&str>) -> HtmlPreviewResourceRequest {
    HtmlPreviewResourceRequest {
        workspace_id: "workspace".into(),
        file_path: "/repo/site/dist/index.html".into(),
        resource_path: resource.map(str::to_string),
        metadata_only: false,
        offset: 0,
        expected_source: None,
        expected_revision: None,
    }
}

async fn fixture() -> (HtmlPreviewSource, Arc<RemoteFs>) {
    let fs = Arc::new(RemoteFs::default());
    fs.file("/repo/site/dist/index.html", br#"<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>"#);
    fs.file(
        "/repo/site/dist/assets/app.css",
        b"@font-face{src:url('./font.woff2')}body{color:green}",
    );
    fs.file("/repo/site/dist/assets/app.js", b"import('./chunk.mjs')");
    fs.file(
        "/repo/site/dist/assets/chunk.mjs",
        b"document.body.dataset.loaded='yes'",
    );
    fs.file("/repo/site/dist/assets/font.woff2", &[0, 255, 1, 2]);
    fs.file("/repo/site/dist/assets/pic #1.png", &[137, 80, 78, 71]);
    fs.file("/repo/site/shared.css", b"shared");
    // A different project at workspace root must not shadow the selected site's assets.
    fs.file("/repo/assets/app.js", b"wrong-project");
    let source = HtmlPreviewSource::new(
        SessionFileTarget {
            fs: fs.clone(),
            path: request(None).file_path,
            root: "/repo".into(),
            remote: true,
        },
        "workspace:ssh-1",
    )
    .await
    .unwrap();
    (source, fs)
}

#[tokio::test]
async fn nested_site_serves_absolute_relative_css_imports_and_binary_assets() {
    let (source, _) = fixture().await;
    for (url, expected, mime) in [
        (
            "site/dist/assets/app.js",
            b"import('./chunk.mjs')".as_slice(),
            "text/javascript; charset=utf-8",
        ),
        (
            "assets/app.js",
            b"import('./chunk.mjs')".as_slice(),
            "text/javascript; charset=utf-8",
        ),
        (
            "assets/chunk.mjs",
            b"document.body.dataset.loaded='yes'".as_slice(),
            "text/javascript; charset=utf-8",
        ),
        ("assets/font.woff2", [0, 255, 1, 2].as_slice(), "font/woff2"),
        (
            "assets/pic #1.png",
            [137, 80, 78, 71].as_slice(),
            "image/png",
        ),
        (
            "site/shared.css",
            b"shared".as_slice(),
            "text/css; charset=utf-8",
        ),
    ] {
        let result = source.read(&request(Some(url))).await.unwrap();
        assert_eq!(
            BASE64.decode(result.content_base64).unwrap(),
            expected,
            "{url}"
        );
        assert_eq!(result.mime_type, mime);
        assert_eq!(result.entry_path, "site/dist/index.html");
    }
    let css = source.read(&request(Some("assets/app.css"))).await.unwrap();
    assert_eq!(css.mime_type, "text/css; charset=utf-8");
}

#[tokio::test]
async fn remote_preview_uses_its_provider_and_never_falls_back_offline() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("index.html"),
        b"private-controller-content",
    )
    .unwrap();
    // Unix can collide on the exact absolute path. Windows controller paths
    // are a different namespace; the remote fixture must still remain POSIX.
    let root = if cfg!(unix) {
        directory.path().to_string_lossy().into_owned()
    } else {
        "/remote/preview".to_string()
    };
    let path = format!("{root}/index.html");
    let fs = Arc::new(RemoteFs::default());
    fs.file(&path, b"remote-page");
    let source = HtmlPreviewSource::new(
        SessionFileTarget {
            fs: fs.clone(),
            root,
            path,
            remote: true,
        },
        "remote",
    )
    .await
    .unwrap();
    assert_eq!(
        BASE64
            .decode(source.read(&request(None)).await.unwrap().content_base64)
            .unwrap(),
        b"remote-page"
    );
    fs.offline.store(true, Ordering::SeqCst);
    assert_eq!(
        source.read(&request(None)).await.unwrap_err().code,
        Code::Unavailable
    );
    fs.offline.store(false, Ordering::SeqCst);
    assert!(
        source.read(&request(None)).await.is_ok(),
        "A reconnected provider can be read again"
    );
}

#[tokio::test]
async fn traversal_symlinks_and_provider_errors_do_not_trigger_fallback() {
    let (source, fs) = fixture().await;
    for path in [
        "../secret",
        "assets/../../secret",
        "assets\\secret",
        "assets/\0secret",
    ] {
        assert_eq!(
            source.read(&request(Some(path))).await.unwrap_err().code,
            Code::InvalidPath
        );
    }
    assert_eq!(
        source
            .read(&request(Some("missing.js")))
            .await
            .unwrap_err()
            .code,
        Code::NotFound
    );
    fs.nodes
        .lock()
        .unwrap()
        .get_mut("/repo/site/dist/assets")
        .unwrap()
        .metadata
        .kind = WorkspacePathKind::Symlink;
    assert_eq!(
        source
            .read(&request(Some("assets/app.js")))
            .await
            .unwrap_err()
            .code,
        Code::Forbidden
    );
    assert!(fs.reads.lock().unwrap().is_empty());
    let invalid = HtmlPreviewSource::new(
        SessionFileTarget {
            fs,
            root: "/repo".into(),
            path: "/repo-other/index.html".into(),
            remote: true,
        },
        "remote",
    )
    .await;
    assert!(matches!(
        invalid,
        Err(HtmlPreviewError {
            code: Code::Forbidden,
            ..
        })
    ));
}

#[tokio::test]
async fn chunks_are_bounded_and_pinned_to_file_and_workspace_revision() {
    let (source, fs) = fixture().await;
    let bytes = vec![42; PREVIEW_CHUNK_BYTES + 33];
    fs.file("/repo/site/dist/assets/large.js", &bytes);
    let mut input = request(Some("assets/large.js"));
    let first = source.read(&input).await.unwrap();
    assert_eq!(
        BASE64.decode(&first.content_base64).unwrap().len(),
        PREVIEW_CHUNK_BYTES
    );
    input.offset = PREVIEW_CHUNK_BYTES as u64;
    input.expected_source = Some(first.source.clone());
    input.expected_revision = Some(first.revision);
    assert_eq!(
        BASE64
            .decode(source.read(&input).await.unwrap().content_base64)
            .unwrap()
            .len(),
        33
    );
    input.expected_source = Some("other-device-or-provider".into());
    assert_eq!(source.read(&input).await.unwrap_err().code, Code::Changed);
    input.expected_source = Some(first.source);
    fs.nodes
        .lock()
        .unwrap()
        .get_mut("/repo/site/dist/assets/large.js")
        .unwrap()
        .metadata
        .modified = Some(SystemTime::now());
    assert_eq!(source.read(&input).await.unwrap_err().code, Code::Changed);
}

#[tokio::test]
async fn head_skips_content_and_oversized_or_truncated_files_fail() {
    let (source, fs) = fixture().await;
    let mut input = request(None);
    input.metadata_only = true;
    assert!(source.read(&input).await.unwrap().content_base64.is_empty());
    assert!(fs.reads.lock().unwrap().is_empty());
    input.metadata_only = false;
    fs.truncate.store(true, Ordering::SeqCst);
    assert_eq!(source.read(&input).await.unwrap_err().code, Code::Changed);
    fs.nodes
        .lock()
        .unwrap()
        .get_mut("/repo/site/dist/index.html")
        .unwrap()
        .metadata
        .size = Some(MAX_PREVIEW_BYTES + 1);
    assert_eq!(source.read(&input).await.unwrap_err().code, Code::TooLarge);
}

#[tokio::test]
async fn cached_remote_assets_recheck_path_policy_and_owner_availability() {
    use super::transfer::HtmlPreviewTransfer;
    use futures::TryStreamExt;
    let (source, fs) = fixture().await;
    let (_close, closed) = tokio::sync::watch::channel(false);
    let transfer = Arc::new(HtmlPreviewTransfer::new(Arc::new(source), closed));
    let input = request(Some("assets/app.js"));
    transfer
        .open(input.clone(), false, None)
        .await
        .unwrap()
        .body
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    let reads = fs.reads.lock().unwrap().len();
    fs.nodes
        .lock()
        .unwrap()
        .get_mut("/repo/site/dist/assets")
        .unwrap()
        .metadata
        .kind = WorkspacePathKind::Symlink;
    assert!(matches!(
        transfer.open(input.clone(), false, None).await,
        Err(HtmlPreviewError {
            code: Code::Forbidden,
            ..
        })
    ));
    assert_eq!(
        fs.reads.lock().unwrap().len(),
        reads,
        "A cached body cannot bypass no-follow checks"
    );
    fs.nodes
        .lock()
        .unwrap()
        .get_mut("/repo/site/dist/assets")
        .unwrap()
        .metadata
        .kind = WorkspacePathKind::Directory;
    transfer
        .open(input.clone(), false, None)
        .await
        .unwrap()
        .body
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    fs.nodes
        .lock()
        .unwrap()
        .remove("/repo/site/dist/assets/app.js");
    // The root has another app.js. It is a different resolved path/revision,
    // so the former site's cached bytes cannot be reused for that fallback.
    let response = transfer.open(input.clone(), false, None).await.unwrap();
    let body = response
        .body
        .try_fold(Vec::new(), |mut all, bytes| async move {
            all.extend_from_slice(&bytes);
            Ok(all)
        })
        .await
        .unwrap();
    assert_eq!(body, b"wrong-project");
    fs.offline.store(true, Ordering::SeqCst);
    assert!(matches!(
        transfer.open(input, false, None).await,
        Err(HtmlPreviewError {
            code: Code::Unavailable,
            ..
        })
    ));
}
