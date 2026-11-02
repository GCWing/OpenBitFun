use super::*;
use futures::{FutureExt, TryStreamExt};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Reader {
    size: usize,
    version: AtomicUsize,
    current: AtomicBool,
    offline: AtomicBool,
    active: AtomicUsize,
    peak: AtomicUsize,
    requests: Mutex<Vec<HtmlPreviewResourceRequest>>,
    completed: Mutex<Vec<u64>>,
}

struct ActiveRead<'a>(&'a AtomicUsize);
impl Drop for ActiveRead<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl HtmlPreviewReader for Reader {
    fn is_current(&self) -> bool {
        self.current.load(Ordering::SeqCst)
    }
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        self.requests.lock().unwrap().push(request.clone());
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        let _guard = ActiveRead(&self.active);
        let index = request.offset as usize / PREVIEW_CHUNK_BYTES;
        tokio::time::sleep(Duration::from_millis((5 - index % 4) as u64 * 10)).await;
        if self.offline.load(Ordering::SeqCst) {
            return Err(HtmlPreviewError::unavailable("Owner is offline"));
        }
        let version = self.version.load(Ordering::SeqCst);
        let length = if request.metadata_only {
            0
        } else {
            (self.size - request.offset as usize).min(PREVIEW_CHUNK_BYTES)
        };
        self.completed.lock().unwrap().push(request.offset);
        Ok(HtmlPreviewResource {
            entry_path: "index.html".into(),
            resource_path: request
                .resource_path
                .clone()
                .unwrap_or_else(|| "index.html".into()),
            source: "workspace:provider".into(),
            revision: format!("version-{version}"),
            mime_type: "application/octet-stream".into(),
            size: self.size as u64,
            offset: request.offset,
            content_base64: BASE64.encode(vec![(index + version) as u8; length]),
        })
    }
}

fn request(path: &str) -> HtmlPreviewResourceRequest {
    HtmlPreviewResourceRequest {
        workspace_id: "workspace".into(),
        file_path: "/repo/index.html".into(),
        resource_path: Some(path.into()),
        metadata_only: false,
        offset: 0,
        expected_source: Some("workspace:provider".into()),
        expected_revision: None,
    }
}

fn fixture(size: usize) -> (Arc<HtmlPreviewTransfer>, Arc<Reader>, watch::Sender<bool>) {
    let reader = Arc::new(Reader {
        size,
        version: AtomicUsize::new(0),
        current: AtomicBool::new(true),
        offline: AtomicBool::new(false),
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        requests: Default::default(),
        completed: Default::default(),
    });
    let (close, closed) = watch::channel(false);
    (
        Arc::new(HtmlPreviewTransfer::new(reader.clone(), closed)),
        reader,
        close,
    )
}

async fn load(
    transfer: &Arc<HtmlPreviewTransfer>,
    path: &str,
    bypass: bool,
) -> Result<Vec<u8>, HtmlPreviewError> {
    transfer
        .open(request(path), bypass, None)
        .await?
        .body
        .try_fold(Vec::new(), |mut all, bytes| async move {
            all.extend_from_slice(&bytes);
            Ok(all)
        })
        .await
}

#[tokio::test(start_paused = true)]
async fn out_of_order_prefetch_preserves_bytes_and_stays_bounded() {
    let size = PREVIEW_CHUNK_BYTES * 10 + 7;
    let (transfer, reader, _close) = fixture(size);
    let bytes = load(&transfer, "app.js", false).await.unwrap();
    assert_eq!(bytes.len(), size);
    for (index, chunk) in bytes.chunks(PREVIEW_CHUNK_BYTES).enumerate() {
        assert!(chunk.iter().all(|byte| *byte == index as u8));
    }
    assert_eq!(reader.peak.load(Ordering::SeqCst), PREFETCH_CHUNKS);
    assert_eq!(reader.active.load(Ordering::SeqCst), 0);
    assert!(reader
        .completed
        .lock()
        .unwrap()
        .windows(2)
        .any(|pair| pair[0] > pair[1]));
    assert_eq!(reader.requests.lock().unwrap().len(), 11);
}

#[tokio::test(start_paused = true)]
async fn concurrent_resources_share_read_budget_and_duplicate_loads_coalesce() {
    let (transfer, reader, _close) = fixture(PREVIEW_CHUNK_BYTES * 6);
    let loads = (0..20).map(|index| {
        let transfer = transfer.clone();
        async move {
            load(&transfer, &format!("asset-{}.js", index % 5), false)
                .await
                .unwrap()
        }
    });
    for bytes in futures::future::join_all(loads).await {
        assert_eq!(bytes.len(), reader.size);
    }
    assert_eq!(reader.peak.load(Ordering::SeqCst), ACTIVE_READS);
    let requests = reader.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| !request.metadata_only)
            .count(),
        5 * 6
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.metadata_only)
            .count(),
        15
    );
    assert!(transfer.cache.lock().unwrap().bytes <= CACHE_BYTES);
}

#[tokio::test(start_paused = true)]
async fn cached_bytes_require_live_metadata_and_changed_revisions_reload() {
    let (transfer, reader, _close) = fixture(PREVIEW_CHUNK_BYTES * 2 + 3);
    let first = load(&transfer, "app.js", false).await.unwrap();
    let count = reader.requests.lock().unwrap().len();
    assert_eq!(load(&transfer, "app.js", false).await.unwrap(), first);
    assert_eq!(reader.requests.lock().unwrap().len(), count + 1);
    assert!(
        reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    reader.version.store(1, Ordering::SeqCst);
    assert_ne!(load(&transfer, "app.js", false).await.unwrap(), first);
    reader.offline.store(true, Ordering::SeqCst);
    assert!(load(&transfer, "app.js", false)
        .await
        .unwrap_err()
        .message
        .contains("offline"));
    assert!(transfer.cache.lock().unwrap().entries.is_empty());
    reader.offline.store(false, Ordering::SeqCst);
    assert!(load(&transfer, "app.js", false).await.is_ok());
    reader.current.store(false, Ordering::SeqCst);
    assert!(load(&transfer, "app.js", false).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn refresh_and_fixed_expiry_force_content_reads_and_head_never_reads_content() {
    let (transfer, reader, _close) = fixture(17);
    load(&transfer, "app.js", false).await.unwrap();
    load(&transfer, "app.js", true).await.unwrap();
    assert!(
        !reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    tokio::time::advance(CACHE_LIFETIME / 2).await;
    load(&transfer, "app.js", false).await.unwrap();
    assert!(
        reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    tokio::time::advance(CACHE_LIFETIME / 2).await;
    load(&transfer, "app.js", false).await.unwrap();
    assert!(
        !reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    let mut head = request("app.js");
    head.metadata_only = true;
    let response = transfer.open(head, false, None).await.unwrap();
    assert_eq!(response.metadata.size, 17);
    assert_eq!(response.body.count().await, 0);
    assert!(
        reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
}

#[tokio::test(start_paused = true)]
async fn cache_expiry_during_slow_revalidation_forces_a_fresh_body() {
    let (transfer, reader, _close) = fixture(17);
    load(&transfer, "app.js", false).await.unwrap();
    tokio::time::advance(CACHE_LIFETIME - Duration::from_millis(25)).await;
    load(&transfer, "app.js", false).await.unwrap();
    let requests = reader.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "Initial body, delayed metadata, then a fresh body"
    );
    assert!(requests[1].metadata_only);
    assert!(!requests[2].metadata_only);
}

#[tokio::test(start_paused = true)]
async fn slow_consumers_and_dropped_bodies_do_not_leave_prefetch_running() {
    let (transfer, reader, _close) = fixture(PREVIEW_CHUNK_BYTES * 20);
    let mut response = transfer
        .open(request("large.js"), false, None)
        .await
        .unwrap();
    response.body.next().await.unwrap().unwrap();
    // Poll once to launch exactly one window, then stop consuming.
    assert!(response.body.next().now_or_never().is_none());
    assert_eq!(reader.active.load(Ordering::SeqCst), PREFETCH_CHUNKS);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(reader.requests.lock().unwrap().len(), 1 + PREFETCH_CHUNKS);
    drop(response);
    assert_eq!(reader.active.load(Ordering::SeqCst), 0);
    assert!(transfer.cache.lock().unwrap().entries.is_empty());
    assert_eq!(transfer.resources.available_permits(), ACTIVE_RESOURCES);
    assert_eq!(transfer.reads.available_permits(), ACTIVE_READS);
}

#[tokio::test(start_paused = true)]
async fn closing_preview_cancels_waiters_and_active_reads() {
    let (transfer, reader, close) = fixture(PREVIEW_CHUNK_BYTES * 20);
    let mut response = transfer
        .open(request("large.js"), false, None)
        .await
        .unwrap();
    response.body.next().await.unwrap().unwrap();
    assert!(response.body.next().now_or_never().is_none());
    close.send(true).unwrap();
    assert!(response.body.next().await.unwrap().is_err());
    drop(response);
    assert_eq!(reader.active.load(Ordering::SeqCst), 0);
    assert!(load(&transfer, "another.js", false).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn closing_preview_releases_queued_resource_admission() {
    let (transfer, reader, close) = fixture(17);
    let mut responses = Vec::new();
    for index in 0..ACTIVE_RESOURCES {
        responses.push(
            transfer
                .open(request(&index.to_string()), false, None)
                .await
                .unwrap(),
        );
    }
    assert_eq!(transfer.resources.available_permits(), 0);
    let mut waiting = Box::pin(transfer.open(request("queued.js"), false, None));
    assert!(waiting.as_mut().now_or_never().is_none());
    assert_eq!(reader.requests.lock().unwrap().len(), ACTIVE_RESOURCES);
    close.send(true).unwrap();
    assert!(waiting.await.is_err());
    for mut response in responses {
        assert!(response.body.next().await.unwrap().is_err());
    }
    assert_eq!(transfer.resources.available_permits(), ACTIVE_RESOURCES);
}

#[tokio::test(start_paused = true)]
async fn account_change_during_cache_revalidation_rejects_late_bytes() {
    let (transfer, reader, _close) = fixture(17);
    load(&transfer, "app.js", false).await.unwrap();
    let mut loading = Box::pin(load(&transfer, "app.js", false));
    assert!(loading.as_mut().now_or_never().is_none());
    reader.current.store(false, Ordering::SeqCst);
    assert!(loading.await.is_err());
    assert!(transfer.cache.lock().unwrap().entries.is_empty());
}

#[tokio::test(start_paused = true)]
async fn partial_or_changed_transfers_never_enter_cache() {
    let (transfer, reader, _close) = fixture(PREVIEW_CHUNK_BYTES * 3);
    let mut response = transfer.open(request("app.js"), false, None).await.unwrap();
    response.body.next().await.unwrap().unwrap();
    reader.version.store(1, Ordering::SeqCst);
    assert!(response.body.next().await.unwrap().is_err());
    assert!(transfer.cache.lock().unwrap().entries.is_empty());
}

#[tokio::test(start_paused = true)]
async fn cache_evicts_by_bytes_and_entry_count_and_skips_large_resources() {
    let (transfer, _, _close) = fixture(CACHE_RESOURCE_BYTES as usize);
    for index in 0..5 {
        load(&transfer, &index.to_string(), false).await.unwrap();
    }
    {
        let cache = transfer.cache.lock().unwrap();
        assert_eq!(cache.bytes, CACHE_BYTES);
        assert_eq!(cache.entries.len(), 4);
        assert!(!cache.entries.contains_key("0"));
    }
    let (transfer, _, _close) = fixture(0);
    for index in 0..65 {
        load(&transfer, &index.to_string(), false).await.unwrap();
    }
    assert_eq!(transfer.cache.lock().unwrap().entries.len(), CACHE_ENTRIES);
    let (transfer, _, _close) = fixture(CACHE_RESOURCE_BYTES as usize + 1);
    load(&transfer, "large.js", false).await.unwrap();
    assert!(transfer.cache.lock().unwrap().entries.is_empty());
}

#[tokio::test(start_paused = true)]
async fn previews_with_identical_paths_do_not_share_cache() {
    let (a, reader_a, _close_a) = fixture(4);
    let (b, reader_b, _close_b) = fixture(4);
    reader_b.version.store(2, Ordering::SeqCst);
    assert_ne!(
        load(&a, "app.js", false).await.unwrap(),
        load(&b, "app.js", false).await.unwrap()
    );
    assert_eq!(reader_a.requests.lock().unwrap().len(), 1);
    assert_eq!(reader_b.requests.lock().unwrap().len(), 1);
}

/// Same resource order and browser-style concurrency for the previous serial
/// chunk loop and the production transfer service. Timing assertions belong in
/// reports, not CI; byte equality and the production IO boundary are mandatory.
#[cfg(feature = "remote-ssh-concrete")]
pub(crate) async fn benchmark_loading(
    reader: Arc<dyn HtmlPreviewReader>,
    mut input: HtmlPreviewResourceRequest,
    files: Vec<(String, Vec<u8>)>,
    label: &str,
) {
    input.metadata_only = true;
    input.expected_source = Some(reader.read(&input).await.unwrap().source);
    input.metadata_only = false;
    let mut serial = Vec::new();
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        for group in [&files[..1], &files[1..]] {
            stream::iter(group.iter())
                .map(|(path, expected)| {
                    let reader = reader.clone();
                    let mut request = input.clone();
                    request.resource_path = Some(path.clone());
                    async move {
                        let mut bytes = Vec::new();
                        loop {
                            let file = reader.read(&request).await.unwrap();
                            bytes.extend(BASE64.decode(&file.content_base64).unwrap());
                            request.expected_revision = Some(file.revision);
                            request.offset = bytes.len() as u64;
                            if request.offset == file.size {
                                break;
                            }
                        }
                        assert_eq!(&bytes, expected);
                    }
                })
                .buffer_unordered(6)
                .collect::<Vec<_>>()
                .await;
        }
        serial.push(start.elapsed().as_millis());
        let (_close, closed) = watch::channel(false);
        let transfer = Arc::new(HtmlPreviewTransfer::new(reader.clone(), closed));
        for times in [&mut cold, &mut warm] {
            let start = Instant::now();
            for group in [&files[..1], &files[1..]] {
                stream::iter(group.iter())
                    .map(|(path, expected)| {
                        let transfer = transfer.clone();
                        let mut request = input.clone();
                        request.resource_path = Some(path.clone());
                        async move {
                            let bytes = transfer
                                .open(request, false, None)
                                .await
                                .unwrap()
                                .body
                                .try_fold(Vec::new(), |mut all, bytes| async move {
                                    all.extend_from_slice(&bytes);
                                    Ok(all)
                                })
                                .await
                                .unwrap();
                            assert_eq!(&bytes, expected);
                        }
                    })
                    .buffer_unordered(6)
                    .collect::<Vec<_>>()
                    .await;
            }
            times.push(start.elapsed().as_millis());
        }
    }
    println!("HTML_PREVIEW_BENCH transport={label} bytes={} serial_ms={serial:?} cold_ms={cold:?} warm_ms={warm:?}", files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>());
}
